import { Agent, AgentContext, AgentResult } from "./agent-types";
import { ManagedNode, NodeState } from "../store/store-types";

function uuidV4(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

const BATCH_API_VERSION = "2024-07-01.20.0";

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

/**
 * Batch data-plane response shape for a pool (used to correlate node
 * dedication and vmSize).
 */
interface BatchPoolResponse {
    id: string;
    vmSize?: string;
    targetDedicatedNodes?: number;
    currentDedicatedNodes?: number;
    targetLowPriorityNodes?: number;
    currentLowPriorityNodes?: number;
    "odata.nextLink"?: string;
}

/**
 * Full node response from the Batch data-plane API:
 *   GET /pools/{poolId}/nodes?api-version=2024-07-01.20.0
 */
interface BatchNodeResponse {
    id: string;
    state?: string;
    schedulingState?: string;
    vmSize?: string;
    isDedicated?: boolean;
    runningTasksCount?: number;
    totalTasksCount?: number;
    totalTasksRun?: number;
    lastBootTime?: string;
    startTaskInfo?: {
        exitCode?: number;
        result?: string;
        startTime?: string;
        endTime?: string;
        retryCount?: number;
        failureInfo?: {
            category?: string;
            code?: string;
            message?: string;
            details?: Array<{ name?: string; value?: string }>;
        };
    };
    errors?: Array<{
        code?: string;
        message?: string;
        errorDetails?: Array<{ name?: string; value?: string }>;
    }>;
    ipAddress?: string;
    affinityId?: string;
}

export class NodeAgent implements Agent {
    readonly name = "node" as const;
    private _cancelled = false;

    constructor(private readonly _ctx: AgentContext) {}

    cancel(): void {
        this._cancelled = true;
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
                params as unknown as NodeActionInput & { actionType: string }
            );
        }

        return this._listNodes(params as unknown as NodeListInput);
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

    /**
     * Fetch all pages from a paginated Batch data-plane endpoint.
     * Follows `odata.nextLink` until exhausted.
     */
    private async _fetchAllPages<T>(
        initialUrl: string,
        token: string
    ): Promise<T[]> {
        const results: T[] = [];
        let url: string | undefined = initialUrl;

        while (url) {
            if (this._cancelled) break;

            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json; odata=minimalmetadata",
                },
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(
                    err?.error?.message ??
                        err?.message?.value ??
                        `Batch API request failed: ${response.status}`
                );
            }

            const data = await response.json();
            const items: T[] = data.value ?? [];
            results.push(...items);

            // Follow pagination via odata.nextLink
            url = data["odata.nextLink"] ?? undefined;
        }

        return results;
    }

    // -----------------------------------------------------------------
    // List nodes
    // -----------------------------------------------------------------

    private async _listNodes(input: NodeListInput): Promise<AgentResult> {
        const { store } = this._ctx;
        this._cancelled = false;

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

        const MAX_CONCURRENT = 20;
        const accountResults = await this._parallelMap(
            accountIds,
            async (accountId) => {
                if (this._cancelled)
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
                    const baseUrl = `https://${account.accountName}.${account.region}.batch.azure.com`;

                    // 1) Fetch pools — GET /pools?api-version=...
                    const poolsUrl = `${baseUrl}/pools?api-version=${BATCH_API_VERSION}`;
                    const pools = await this._fetchAllPages<BatchPoolResponse>(
                        poolsUrl,
                        token
                    );

                    // 2) Parallel-fetch nodes across ALL pools in this account
                    //    GET /pools/{poolId}/nodes?api-version=...
                    const poolNodeResults = await this._parallelMap(
                        pools,
                        async (pool) => {
                            if (this._cancelled)
                                return {
                                    nodes: [] as ManagedNode[],
                                    preempted: 0,
                                };

                            const nodesUrl = `${baseUrl}/pools/${encodeURIComponent(pool.id)}/nodes?api-version=${BATCH_API_VERSION}`;
                            try {
                                const rawNodes =
                                    await this._fetchAllPages<BatchNodeResponse>(
                                        nodesUrl,
                                        token
                                    );

                                let preemptedCount = 0;
                                const mapped = rawNodes.map((n, idx) => {
                                    if (
                                        n.state?.toLowerCase() === "preempted"
                                    ) {
                                        preemptedCount++;
                                    }
                                    return this._toBatchNode(
                                        n,
                                        account,
                                        pool,
                                        idx
                                    );
                                });
                                return {
                                    nodes: mapped,
                                    preempted: preemptedCount,
                                };
                            } catch {
                                return {
                                    nodes: [] as ManagedNode[],
                                    preempted: 0,
                                };
                            }
                        },
                        MAX_CONCURRENT
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
            MAX_CONCURRENT
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
    }

    // -----------------------------------------------------------------
    // Node actions
    // -----------------------------------------------------------------

    private async _executeNodeAction(
        input: NodeActionInput & { actionType: string }
    ): Promise<AgentResult> {
        const { store, scheduler } = this._ctx;
        this._cancelled = false;

        const action = input.actionType as
            | "reboot"
            | "delete"
            | "reimage"
            | "disableScheduling"
            | "enableScheduling";

        const actionLabels: Record<string, { present: string; past: string }> =
            {
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
            if (this._cancelled) break;

            const state = store.getState();
            const node = state.nodes.find((n) => n.id === internalId);
            if (!node) continue;

            const account = state.accounts.find((a) => a.id === node.accountId);
            if (!account) continue;

            try {
                await scheduler.run(node.accountId, async () => {
                    const token = await this._resolveToken(input.tokenProvider);
                    const baseUrl = `https://${account.accountName}.${account.region}.batch.azure.com`;

                    let url: string;
                    let body: string | undefined;

                    // All node actions are POST to
                    //   /pools/{poolId}/nodes/{nodeId}/{action}
                    // except "delete" which uses /pools/{poolId}/removenodes
                    switch (action) {
                        case "reboot":
                            url = `${baseUrl}/pools/${encodeURIComponent(node.poolId)}/nodes/${encodeURIComponent(node.nodeId)}/reboot?api-version=${BATCH_API_VERSION}`;
                            body = JSON.stringify({
                                nodeRebootOption: "requeue",
                            });
                            break;
                        case "delete":
                            url = `${baseUrl}/pools/${encodeURIComponent(node.poolId)}/removenodes?api-version=${BATCH_API_VERSION}`;
                            body = JSON.stringify({
                                nodeList: [node.nodeId],
                                nodeDeallocationOption: "requeue",
                            });
                            break;
                        case "reimage":
                            url = `${baseUrl}/pools/${encodeURIComponent(node.poolId)}/nodes/${encodeURIComponent(node.nodeId)}/reimage?api-version=${BATCH_API_VERSION}`;
                            body = JSON.stringify({
                                nodeReimageOption: "requeue",
                            });
                            break;
                        case "disableScheduling":
                            url = `${baseUrl}/pools/${encodeURIComponent(node.poolId)}/nodes/${encodeURIComponent(node.nodeId)}/disablescheduling?api-version=${BATCH_API_VERSION}`;
                            body = undefined;
                            break;
                        case "enableScheduling":
                            url = `${baseUrl}/pools/${encodeURIComponent(node.poolId)}/nodes/${encodeURIComponent(node.nodeId)}/enablescheduling?api-version=${BATCH_API_VERSION}`;
                            body = undefined;
                            break;
                        default:
                            throw new Error(`Unknown action: ${action}`);
                    }

                    const headers: Record<string, string> = {
                        Authorization: `Bearer ${token}`,
                    };
                    if (body) {
                        headers["Content-Type"] =
                            "application/json; odata=minimalmetadata";
                    }

                    const response = await fetch(url, {
                        method: "POST",
                        headers,
                        body,
                    });

                    if (!response.ok && response.status !== 202) {
                        const err = await response.json().catch(() => ({}));
                        throw new Error(
                            err?.error?.message ??
                                `${action} failed: ${response.status}`
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
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.addLog({
                    agent: "node",
                    level: "error",
                    message: `Failed to ${action} node ${node.nodeId}: ${errorMsg}`,
                });
                failed++;
            }
        }

        store.setAgentStatus("node", failed > 0 ? "error" : "completed");

        return {
            status:
                failed === 0
                    ? "completed"
                    : succeeded === 0
                      ? "failed"
                      : "partial",
            summary: { total: input.nodeIds.length, succeeded, failed },
        };
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
        n: BatchNodeResponse,
        account: {
            id: string;
            accountName: string;
            region: string;
            subscriptionId: string;
        },
        pool: BatchPoolResponse,
        nodeIndex: number
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
                (pool.targetDedicatedNodes ?? 0) > 0 &&
                nodeIndex < currentDedicated;
        }

        // --- errors ---
        let errorMsg: string | null = null;
        if (n.errors && n.errors.length > 0) {
            errorMsg = n.errors
                .map((e) => {
                    let msg = `${e.code ?? "Error"}: ${e.message ?? "Unknown error"}`;
                    if (e.errorDetails && e.errorDetails.length > 0) {
                        const details = e.errorDetails
                            .map((d) => `${d.name}=${d.value}`)
                            .join(", ");
                        msg += ` (${details})`;
                    }
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
            totalTasksRun: n.totalTasksRun ?? n.totalTasksCount,
            runningTasksCount: n.runningTasksCount,
            schedulingState: n.schedulingState,
            subscriptionId: account.subscriptionId,
            error: errorMsg,
        };
    }

    // -----------------------------------------------------------------
    // Concurrency-limited parallel map
    // -----------------------------------------------------------------

    private async _parallelMap<T, R>(
        items: T[],
        fn: (item: T) => Promise<R>,
        concurrency: number
    ): Promise<R[]> {
        const results: R[] = new Array(items.length);
        let idx = 0;
        const run = async () => {
            while (idx < items.length) {
                const i = idx++;
                results[i] = await fn(items[i]);
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(concurrency, items.length) }, () =>
                run()
            )
        );
        return results;
    }
}
