import {
  Agent,
  AgentContext,
  AgentResult,
  noopAuditLogger,
} from "./agent-types";
import { ManagedNode, NodeState } from "../store/store-types";
import {
  listPools,
  listNodes,
  performNodeAction,
  removeNodes,
} from "../services";
import type { BatchPool, BatchNode } from "../services";
import { uuidV4 } from "./_shared/ids";
import { accountEndpoint } from "./_shared/endpoints";
import { pMap } from "./_shared/parallel";
import { CancellationTracker } from "./_shared/cancellation";
import { classifyAzureError } from "./error-classifier";

/**
 * Optional token provider interface. When supplied, the agent calls
 * `getToken()` instead of the context's `getBatchAccessToken`.
 */
export interface TokenProvider {
  getToken(tenantId?: string): Promise<string>;
}

export interface NodeListInput {
  accountIds: string[];
  tokenProvider?: TokenProvider;
}

export interface NodeActionInput {
  action:
    | "reboot"
    | "delete"
    | "reimage"
    | "disableScheduling"
    | "enableScheduling";
  nodeIds: string[]; // internal ManagedNode ids
  tokenProvider?: TokenProvider;
}

export class NodeAgent implements Agent {
  readonly name = "node" as const;
  /** Legacy flag for `cancel()` callers — mirrored to controllers. */
  private _cancelled = false;
  private readonly _cancellation = new CancellationTracker();

  constructor(private readonly _ctx: AgentContext) {}

  cancel(): void {
    this._cancelled = true;
    this._cancellation.abortAll();
  }

  private get _audit() {
    return this._ctx.auditLogger ?? noopAuditLogger;
  }

  private _isCancelled(signal?: AbortSignal): boolean {
    if (this._cancelled) return true;
    if (signal?.aborted) return true;
    return false;
  }

  async execute(params: Record<string, unknown>): Promise<AgentResult> {
    const actionType = params.actionType as string;

    if (
      actionType === "reboot" ||
      actionType === "delete" ||
      actionType === "reimage" ||
      actionType === "disableScheduling" ||
      actionType === "enableScheduling"
    ) {
      return this._executeNodeAction(
        params as unknown as NodeActionInput & {
          actionType: string;
          signal?: AbortSignal;
        },
      );
    }

    return this._listNodes(
      params as unknown as NodeListInput & { signal?: AbortSignal },
    );
  }

  /**
   * Resolve a bearer token. If a TokenProvider was supplied in the input
   * it takes precedence over the context's default accessor.
   */
  private async _resolveToken(provider?: TokenProvider): Promise<string> {
    if (provider) {
      return provider.getToken();
    }
    return this._ctx.getBatchAccessToken();
  }

  // -----------------------------------------------------------------
  // List nodes
  // -----------------------------------------------------------------

  private async _listNodes(
    input: NodeListInput & { signal?: AbortSignal },
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const { controller, signal } = this._cancellation.begin(input.signal);

    try {

    // Auto-discover: if no accountIds provided, use ALL created accounts
    let accountIds = input.accountIds;
    if (!accountIds || accountIds.length === 0) {
      accountIds = store
        .getState()
        .accounts.filter((a) => a.provisioningState === "created")
        .map((a) => a.id);
    }

    store.setAgentStatus("node", "running");
    store.addLog({
      agent: "node",
      level: "info",
      message: `Listing nodes across ${accountIds.length} accounts (parallel)`,
    });

    const token = await this._resolveToken(input.tokenProvider);

    const MAX_CONCURRENT = 2;
    const accountResults = await pMap(
      accountIds,
      async (accountId) => {
        if (this._isCancelled(signal))
          return {
            nodes: [] as ManagedNode[],
            preempted: 0,
            error: null as string | null,
          };
        const state = store.getState();
        const account = state.accounts.find((a) => a.id === accountId);
        if (!account)
          return {
            nodes: [] as ManagedNode[],
            preempted: 0,
            error: null,
          };

        try {
          const endpoint = accountEndpoint(account.accountName, account.region);

          // 1) Fetch pools via SDK service
          const pools = await listPools(endpoint, token);

          // 2) Parallel-fetch nodes across ALL pools in this account
          const poolNodeResults = await pMap(
            pools,
            async (pool) => {
              if (this._isCancelled(signal))
                return {
                  nodes: [] as ManagedNode[],
                  preempted: 0,
                };

              try {
                const rawNodes = await listNodes(endpoint, pool.id, token);
                // Throttle after each listNodes call
                await new Promise((r) => setTimeout(r, 200));

                let preemptedCount = 0;
                const mapped = rawNodes.map((n, idx) => {
                  if (n.state?.toLowerCase() === "preempted") {
                    preemptedCount++;
                  }
                  return this._toBatchNode(n, account, pool, idx);
                });

                // Throttle between pool iterations
                await new Promise((r) => setTimeout(r, 100));

                return {
                  nodes: mapped,
                  preempted: preemptedCount,
                };
              } catch (err) {
                // Audit fix #11: surface the dropped error via the
                // agent log instead of silently swallowing it. The
                // returned shape is preserved (empty nodes array)
                // so the per-pool fan-out continues; the operator
                // gets visibility into why a pool produced no nodes.
                const msg = err instanceof Error ? err.message : String(err);
                store.addLog({
                  agent: "node",
                  level: "warn",
                  message: `listNodes failed for ${account.accountName}/${pool.id}: ${msg}`,
                });
                return {
                  nodes: [] as ManagedNode[],
                  preempted: 0,
                };
              }
            },
            5,
          );

          const nodes: ManagedNode[] = [];
          let preempted = 0;
          for (const pr of poolNodeResults) {
            nodes.push(...pr.nodes);
            preempted += pr.preempted;
          }

          return { nodes, preempted, error: null };
        } catch (error: any) {
          return {
            nodes: [] as ManagedNode[],
            preempted: 0,
            error: error?.message ?? String(error),
          };
        }
      },
      MAX_CONCURRENT,
    );

    const allNodes: ManagedNode[] = [];
    let errors = 0;
    let totalPreempted = 0;
    for (const r of accountResults) {
      if (r.error) errors++;
      else {
        allNodes.push(...r.nodes);
        totalPreempted += r.preempted;
      }
    }

    store.setNodes(allNodes);
    store.setAgentStatus("node", errors > 0 ? "error" : "completed");
    store.addLog({
      agent: "node",
      level: "info",
      message: `Found ${allNodes.length} nodes across accounts (${totalPreempted} preempted, ${errors} account-level errors)`,
    });

    return {
      status: errors === 0 ? "completed" : "partial",
      summary: {
        total: allNodes.length,
        preempted: totalPreempted,
        errors,
      },
    };
    } finally {
      this._cancellation.end(controller);
    }
  }

  // -----------------------------------------------------------------
  // Node actions
  // -----------------------------------------------------------------

  private async _executeNodeAction(
    input: NodeActionInput & { actionType: string; signal?: AbortSignal },
  ): Promise<AgentResult> {
    const { store, scheduler } = this._ctx;
    const { controller, signal } = this._cancellation.begin(input.signal);

    try {

    const action = input.actionType as
      | "reboot"
      | "delete"
      | "reimage"
      | "disableScheduling"
      | "enableScheduling";

    const actionLabels: Record<string, { present: string; past: string }> = {
      reboot: { present: "Rebooting", past: "Rebooted" },
      delete: { present: "Removing", past: "Removed" },
      reimage: { present: "Reimaging", past: "Reimaged" },
      disableScheduling: {
        present: "Disabling scheduling on",
        past: "Disabled scheduling on",
      },
      enableScheduling: {
        present: "Enabling scheduling on",
        past: "Enabled scheduling on",
      },
    };

    const label = actionLabels[action] ?? {
      present: action,
      past: action,
    };

    store.setAgentStatus("node", "running");
    store.addLog({
      agent: "node",
      level: "info",
      message: `${label.present} ${input.nodeIds.length} node(s)`,
    });

    let succeeded = 0;
    let failed = 0;

    for (const internalId of input.nodeIds) {
      if (this._isCancelled(signal)) break;

      const state = store.getState();
      const node = state.nodes.find((n) => n.id === internalId);
      if (!node) continue;

      const account = state.accounts.find((a) => a.id === node.accountId);
      if (!account) continue;

      try {
        await scheduler.run(node.accountId, async () => {
          if (this._isCancelled(signal)) {
            throw new Error("cancelled");
          }
          const token = await this._resolveToken(input.tokenProvider);
          const endpoint = accountEndpoint(account.accountName, account.region);

          if (action === "delete") {
            await removeNodes(endpoint, node.poolId, [node.nodeId], token);
          } else {
            await performNodeAction(
              endpoint,
              node.poolId,
              node.nodeId,
              action,
              token,
            );
          }
        });

        store.addLog({
          agent: "node",
          level: "info",
          message: `${label.past} node ${node.nodeId} in ${account.accountName}/${node.poolId}`,
        });

        // Update local store state after successful action
        switch (action) {
          case "delete":
            store.removeNode(internalId);
            break;
          case "reboot":
            store.updateNode(internalId, { state: "rebooting" });
            break;
          case "reimage":
            store.updateNode(internalId, { state: "reimaging" });
            break;
          case "disableScheduling":
            store.updateNode(internalId, {
              schedulingState: "disabled",
            });
            break;
          case "enableScheduling":
            store.updateNode(internalId, {
              schedulingState: "enabled",
            });
            break;
        }

        succeeded++;
        this._audit.record({
          action: `node_${action}`,
          target: `${account.accountName}/${node.poolId}/${node.nodeId}`,
          status: "success",
          details: {
            accountId: account.id,
            poolId: node.poolId,
            nodeId: node.nodeId,
          },
        });
      } catch (error: any) {
        const errorMsg = error?.message ?? String(error);
        const classified = classifyAzureError(error);
        store.addLog({
          agent: "node",
          level: "error",
          message: `Failed to ${action} node ${node.nodeId} [${classified.kind}]: ${errorMsg}`,
        });
        failed++;
        this._audit.record({
          action: `node_${action}`,
          target: `${account.accountName}/${node.poolId}/${node.nodeId}`,
          status: "failure",
          error: errorMsg,
          details: {
            accountId: account.id,
            poolId: node.poolId,
            nodeId: node.nodeId,
            classification: classified.kind,
          },
        });
      }
    }

    store.setAgentStatus("node", failed > 0 ? "error" : "completed");

    return {
      status:
        failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial",
      summary: { total: input.nodeIds.length, succeeded, failed },
    };
    } finally {
      this._cancellation.end(controller);
    }
  }

  // -----------------------------------------------------------------
  // Map Batch API node response to ManagedNode
  // -----------------------------------------------------------------

  /**
   * Convert a raw Batch data-plane node response into a ManagedNode.
   *
   * isDedicated mapping: the Batch API may return `isDedicated` on the
   * node itself. When it is not present, we infer dedication from the
   * pool counters -- if the node's ordinal index is less than the pool's
   * `currentDedicatedNodes`, it is dedicated; otherwise low-priority.
   */
  private _toBatchNode(
    n: BatchNode,
    account: {
      id: string;
      accountName: string;
      region: string;
      subscriptionId: string;
    },
    pool: BatchPool,
    nodeIndex: number,
  ): ManagedNode {
    const nodeState = (n.state ?? "unknown").toLowerCase() as NodeState;

    // --- isDedicated ---
    let isDedicated: boolean;
    if (typeof n.isDedicated === "boolean") {
      isDedicated = n.isDedicated;
    } else {
      // Infer from pool counters: nodes indexed below
      // currentDedicatedNodes are dedicated.
      const currentDedicated = pool.currentDedicatedNodes ?? 0;
      isDedicated =
        (pool.targetDedicatedNodes ?? 0) > 0 && nodeIndex < currentDedicated;
    }

    // --- errors ---
    let errorMsg: string | null = null;
    if (n.errors && n.errors.length > 0) {
      errorMsg = n.errors
        .map((e) => {
          const msg = `${e.code ?? "Error"}: ${e.message ?? "Unknown error"}`;
          return msg;
        })
        .join("; ");
    }

    // --- startTaskInfo errors ---
    if (
      n.startTaskInfo?.result === "failure" ||
      (n.startTaskInfo?.exitCode !== undefined &&
        n.startTaskInfo.exitCode !== 0)
    ) {
      const stInfo = n.startTaskInfo;
      const stMsg = `StartTask exit=${stInfo.exitCode ?? "?"} result=${stInfo.result ?? "unknown"}`;
      errorMsg = errorMsg ? `${errorMsg}; ${stMsg}` : stMsg;
    }

    return {
      id: uuidV4(),
      accountId: account.id,
      accountName: account.accountName,
      region: account.region,
      poolId: pool.id,
      nodeId: n.id,
      state: nodeState,
      vmSize: n.vmSize ?? pool.vmSize,
      ipAddress: n.ipAddress,
      isDedicated,
      lastBootTime: n.lastBootTime,
      totalTasksRun: n.totalTasksRun,
      runningTasksCount: n.runningTasksCount,
      schedulingState: n.schedulingState,
      subscriptionId: account.subscriptionId,
      error: errorMsg,
    };
  }

  // Concurrency-limited parallel map is now in _shared/parallel.ts.
}
