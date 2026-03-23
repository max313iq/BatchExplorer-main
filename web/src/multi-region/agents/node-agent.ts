import { Agent, AgentContext, AgentResult } from "./agent-types";
import { ManagedNode, NodeState } from "../store/store-types";

function uuidV4(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export interface NodeListInput {
    accountIds: string[];
}

export interface NodeActionInput {
    action: "reboot" | "delete";
    nodeIds: string[]; // internal ManagedNode ids
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

        if (actionType === "reboot" || actionType === "delete") {
            return this._executeNodeAction(
                params as unknown as NodeActionInput & { actionType: string }
            );
        }

        return this._listNodes(params as unknown as NodeListInput);
    }

    private async _listNodes(input: NodeListInput): Promise<AgentResult> {
        const { store, scheduler, getBatchAccessToken } = this._ctx;
        this._cancelled = false;

        store.setAgentStatus("node", "running");
        store.addLog({
            agent: "node",
            level: "info",
            message: `Listing nodes across ${input.accountIds.length} accounts`,
        });

        const allNodes: ManagedNode[] = [];
        let errors = 0;

        for (const accountId of input.accountIds) {
            if (this._cancelled) break;

            const state = store.getState();
            const account = state.accounts.find((a) => a.id === accountId);
            if (!account) continue;

            // Get pools for this account
            const pools = state.pools.filter(
                (p) =>
                    p.accountId === accountId &&
                    p.provisioningState === "created"
            );

            for (const pool of pools) {
                if (this._cancelled) break;

                try {
                    await scheduler.run(accountId, async () => {
                        const token = await getBatchAccessToken();
                        const url = `https://${account.accountName}.${account.region}.batch.azure.com/pools/${pool.poolId}/nodes?api-version=2024-07-01.20.0`;

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
                                    `List nodes failed: ${response.status}`
                            );
                        }

                        const data = await response.json();
                        const nodes = data.value ?? [];

                        for (const n of nodes) {
                            allNodes.push({
                                id: uuidV4(),
                                accountId,
                                accountName: account.accountName,
                                region: account.region,
                                poolId: pool.poolId,
                                nodeId: n.id,
                                state: (
                                    n.state ?? "unknown"
                                ).toLowerCase() as NodeState,
                                vmSize: n.vmSize,
                                ipAddress: n.ipAddress,
                                lastBootTime: n.lastBootTime,
                                error: n.errors?.[0]?.message ?? null,
                            });
                        }
                    });
                } catch (error: any) {
                    const errorMsg = error?.message ?? String(error);
                    store.addLog({
                        agent: "node",
                        level: "error",
                        message: `Failed to list nodes for ${account.accountName}/${pool.poolId}: ${errorMsg}`,
                    });
                    errors++;
                }
            }
        }

        store.setNodes(allNodes);
        store.setAgentStatus("node", errors > 0 ? "error" : "completed");
        store.addLog({
            agent: "node",
            level: "info",
            message: `Found ${allNodes.length} nodes across accounts (${errors} errors)`,
        });

        return {
            status: errors === 0 ? "completed" : "partial",
            summary: { total: allNodes.length, errors },
        };
    }

    private async _executeNodeAction(
        input: NodeActionInput & { actionType: string }
    ): Promise<AgentResult> {
        const { store, scheduler, getBatchAccessToken } = this._ctx;
        this._cancelled = false;

        const action = input.actionType as "reboot" | "delete";
        store.setAgentStatus("node", "running");
        store.addLog({
            agent: "node",
            level: "info",
            message: `${action === "reboot" ? "Rebooting" : "Deleting"} ${input.nodeIds.length} nodes`,
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
                    const token = await getBatchAccessToken();
                    const baseUrl = `https://${account.accountName}.${account.region}.batch.azure.com`;

                    if (action === "reboot") {
                        const url = `${baseUrl}/pools/${node.poolId}/nodes/${node.nodeId}/reboot?api-version=2024-07-01.20.0`;
                        const response = await fetch(url, {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json; odata=minimalmetadata",
                                Authorization: `Bearer ${token}`,
                            },
                            body: JSON.stringify({
                                nodeRebootOption: "requeue",
                            }),
                        });
                        if (!response.ok && response.status !== 202) {
                            const err = await response.json().catch(() => ({}));
                            throw new Error(
                                err?.error?.message ??
                                    `Reboot failed: ${response.status}`
                            );
                        }
                    } else {
                        // Delete = remove node from pool
                        const url = `${baseUrl}/pools/${node.poolId}/removenodes?api-version=2024-07-01.20.0`;
                        const response = await fetch(url, {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json; odata=minimalmetadata",
                                Authorization: `Bearer ${token}`,
                            },
                            body: JSON.stringify({
                                nodeList: [node.nodeId],
                                nodeDeallocationOption: "requeue",
                            }),
                        });
                        if (!response.ok && response.status !== 202) {
                            const err = await response.json().catch(() => ({}));
                            throw new Error(
                                err?.error?.message ??
                                    `Remove node failed: ${response.status}`
                            );
                        }
                    }
                });

                store.addLog({
                    agent: "node",
                    level: "info",
                    message: `${action === "reboot" ? "Rebooted" : "Removed"} node ${node.nodeId} from ${account.accountName}/${node.poolId}`,
                });

                if (action === "delete") {
                    store.removeNode(internalId);
                } else {
                    store.updateNode(internalId, { state: "rebooting" });
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
}
