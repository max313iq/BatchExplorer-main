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

export interface NodeListInput {
    accountIds: string[];
}

export interface NodeActionInput {
    action:
        | "reboot"
        | "delete"
        | "reimage"
        | "disableScheduling"
        | "enableScheduling";
    nodeIds: string[]; // internal ManagedNode ids
}

interface BatchPoolResponse {
    id: string;
    vmSize?: string;
    "odata.nextLink"?: string;
}

interface BatchNodeResponse {
    id: string;
    state?: string;
    ipAddress?: string;
    isDedicated?: boolean;
    lastBootUpTime?: string;
    totalTasksRun?: number;
    runningTasksCount?: number;
    schedulingState?: string;
    errors?: Array<{ code?: string; message?: string }>;
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
     * Fetch all pages from a paginated Batch API endpoint.
     */
    private async _fetchAllPages<T>(
        initialUrl: string,
        token: string
    ): Promise<T[]> {
        const results: T[] = [];
        let url: string | undefined = initialUrl;

        while (url) {
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

            url = data["odata.nextLink"] ?? undefined;
        }

        return results;
    }

    private async _listNodes(input: NodeListInput): Promise<AgentResult> {
        const { store, scheduler, getBatchAccessToken } = this._ctx;
        this._cancelled = false;

        // Auto-discover: if no accountIds provided, use ALL created accounts from store
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
            message: `Listing nodes across ${accountIds.length} accounts`,
        });

        const allNodes: ManagedNode[] = [];
        let errors = 0;

        for (const accountId of accountIds) {
            if (this._cancelled) break;

            const state = store.getState();
            const account = state.accounts.find((a) => a.id === accountId);
            if (!account) continue;

            try {
                await scheduler.run(accountId, async () => {
                    const token = await getBatchAccessToken();
                    const baseUrl = `https://${account.accountName}.${account.region}.batch.azure.com`;

                    // Step 1: List all pools for this account
                    const poolsUrl = `${baseUrl}/pools?api-version=${BATCH_API_VERSION}`;
                    const pools = await this._fetchAllPages<BatchPoolResponse>(
                        poolsUrl,
                        token
                    );

                    // Step 2: For each pool, list all nodes
                    for (const pool of pools) {
                        if (this._cancelled) break;

                        const nodesUrl = `${baseUrl}/pools/${pool.id}/nodes?api-version=${BATCH_API_VERSION}`;
                        let nodes: BatchNodeResponse[];

                        try {
                            nodes =
                                await this._fetchAllPages<BatchNodeResponse>(
                                    nodesUrl,
                                    token
                                );
                        } catch (poolErr: any) {
                            store.addLog({
                                agent: "node",
                                level: "warn",
                                message: `Failed to list nodes for pool ${pool.id} in ${account.accountName}: ${poolErr?.message ?? String(poolErr)}`,
                            });
                            continue;
                        }

                        for (const n of nodes) {
                            const nodeState = (
                                n.state ?? "unknown"
                            ).toLowerCase() as NodeState;

                            const nodeErrors = n.errors;
                            let errorMsg: string | null = null;
                            if (nodeErrors && nodeErrors.length > 0) {
                                errorMsg = nodeErrors
                                    .map(
                                        (e) =>
                                            `${e.code ?? "Error"}: ${e.message ?? "Unknown error"}`
                                    )
                                    .join("; ");
                            }

                            allNodes.push({
                                id: uuidV4(),
                                accountId,
                                accountName: account.accountName,
                                region: account.region,
                                poolId: pool.id,
                                nodeId: n.id,
                                state: nodeState,
                                vmSize: pool.vmSize,
                                ipAddress: n.ipAddress,
                                isDedicated: n.isDedicated ?? true,
                                lastBootTime: n.lastBootUpTime,
                                totalTasksRun: n.totalTasksRun,
                                runningTasksCount: n.runningTasksCount,
                                schedulingState: n.schedulingState,
                                subscriptionId: account.subscriptionId,
                                error: errorMsg,
                            });
                        }
                    }
                });
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.addLog({
                    agent: "node",
                    level: "error",
                    message: `Failed to list nodes for account ${account.accountName}: ${errorMsg}`,
                });
                errors++;
            }
        }

        store.setNodes(allNodes);
        store.setAgentStatus("node", errors > 0 ? "error" : "completed");
        store.addLog({
            agent: "node",
            level: "info",
            message: `Found ${allNodes.length} nodes across accounts (${errors} account-level errors)`,
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
                    const token = await getBatchAccessToken();
                    const baseUrl = `https://${account.accountName}.${account.region}.batch.azure.com`;

                    let url: string;
                    let body: string | undefined;

                    switch (action) {
                        case "reboot":
                            url = `${baseUrl}/pools/${node.poolId}/nodes/${node.nodeId}/reboot?api-version=${BATCH_API_VERSION}`;
                            body = JSON.stringify({
                                nodeRebootOption: "requeue",
                            });
                            break;
                        case "delete":
                            url = `${baseUrl}/pools/${node.poolId}/removenodes?api-version=${BATCH_API_VERSION}`;
                            body = JSON.stringify({
                                nodeList: [node.nodeId],
                                nodeDeallocationOption: "requeue",
                            });
                            break;
                        case "reimage":
                            url = `${baseUrl}/pools/${node.poolId}/nodes/${node.nodeId}/reimage?api-version=${BATCH_API_VERSION}`;
                            body = JSON.stringify({
                                nodeReimageOption: "requeue",
                            });
                            break;
                        case "disableScheduling":
                            url = `${baseUrl}/pools/${node.poolId}/nodes/${node.nodeId}/disablescheduling?api-version=${BATCH_API_VERSION}`;
                            body = undefined;
                            break;
                        case "enableScheduling":
                            url = `${baseUrl}/pools/${node.poolId}/nodes/${node.nodeId}/enablescheduling?api-version=${BATCH_API_VERSION}`;
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
}
