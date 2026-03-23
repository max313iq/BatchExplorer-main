import { Agent, AgentContext, AgentResult } from "./agent-types";
import { ProvisionerAgent } from "./provisioner-agent";
import { QuotaAgent } from "./quota-agent";
import { MonitorAgent } from "./monitor-agent";
import { FilterAgent } from "./filter-agent";
import { PoolAgent } from "./pool-agent";
import { NodeAgent } from "./node-agent";
import { WorkflowAgent, WorkflowConfig } from "./workflow-agent";

export type OrchestratorAction =
    | "create_accounts"
    | "discover_accounts"
    | "submit_quota_requests"
    | "check_quota_status"
    | "filter_accounts"
    | "create_pools"
    | "list_nodes"
    | "node_action"
    | "run_workflow"
    | "retry_failed";

export class OrchestratorAgent implements Agent {
    readonly name = "orchestrator" as const;

    private readonly _provisioner: ProvisionerAgent;
    private readonly _quota: QuotaAgent;
    private readonly _monitor: MonitorAgent;
    private readonly _filter: FilterAgent;
    private readonly _pool: PoolAgent;
    private readonly _node: NodeAgent;
    private _workflowAgent: WorkflowAgent | null = null;

    constructor(private readonly _ctx: AgentContext) {
        this._provisioner = new ProvisionerAgent(_ctx);
        this._quota = new QuotaAgent(_ctx);
        this._monitor = new MonitorAgent(_ctx);
        this._filter = new FilterAgent(_ctx.store);
        this._pool = new PoolAgent(_ctx);
        this._node = new NodeAgent(_ctx);
    }

    cancel(): void {
        this._provisioner.cancel();
        this._quota.cancel();
        this._monitor.cancel();
        this._pool.cancel();
        this._node.cancel();
        if (this._workflowAgent) {
            this._workflowAgent.cancel();
        }
    }

    async execute(params: Record<string, unknown>): Promise<AgentResult> {
        const action = params.action as OrchestratorAction;
        const { store } = this._ctx;

        store.setAgentStatus("orchestrator", "running");
        store.addLog({
            agent: "orchestrator",
            level: "info",
            message: `Dispatching action: ${action}`,
        });

        try {
            let result: AgentResult;

            switch (action) {
                case "create_accounts":
                    result = await this._provisioner.execute(
                        params.payload as Record<string, unknown>
                    );
                    store.addNotification({
                        type:
                            result.status === "completed"
                                ? "success"
                                : "warning",
                        message:
                            result.status === "completed"
                                ? "Account creation completed successfully"
                                : `Account creation finished with status: ${result.status}`,
                    });
                    break;

                case "discover_accounts":
                    result = await this._discoverAccounts(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "submit_quota_requests":
                    this._validatePrecondition("submit_quota_requests", () => {
                        const state = store.getState();
                        const createdAccounts = state.accounts.filter(
                            (a) => a.provisioningState === "created"
                        );
                        if (createdAccounts.length === 0) {
                            throw new Error(
                                "No created accounts found. Create accounts first."
                            );
                        }
                    });
                    result = await this._quota.execute(
                        params.payload as Record<string, unknown>
                    );
                    store.addNotification({
                        type:
                            result.status === "completed"
                                ? "success"
                                : "warning",
                        message:
                            result.status === "completed"
                                ? "Quota requests submitted successfully"
                                : `Quota submission finished with status: ${result.status}`,
                    });
                    break;

                case "check_quota_status":
                    result = await this._monitor.execute(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "filter_accounts":
                    result = await this._filter.execute(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "create_pools": {
                    const payload = params.payload as Record<string, unknown>;

                    // If no accountIds provided, run filter first
                    if (
                        !payload.accountIds ||
                        (payload.accountIds as string[]).length === 0
                    ) {
                        const filterResult = await this._filter.execute({
                            filters: payload.filters ?? {},
                            selectAll: true,
                        } as Record<string, unknown>);

                        const filtered = filterResult.summary as unknown as {
                            accounts: Array<{
                                accountId: string;
                            }>;
                        };
                        payload.accountIds = filtered.accounts.map(
                            (a) => a.accountId
                        );
                    }

                    result = await this._pool.execute(payload);
                    store.addNotification({
                        type:
                            result.status === "completed"
                                ? "success"
                                : "warning",
                        message:
                            result.status === "completed"
                                ? "Pool creation completed successfully"
                                : `Pool creation finished with status: ${result.status}`,
                    });
                    break;
                }

                case "list_nodes":
                    result = await this._node.execute(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "node_action":
                    result = await this._node.execute(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "run_workflow": {
                    const workflowConfig =
                        params.payload as unknown as WorkflowConfig;
                    this._workflowAgent = new WorkflowAgent(this._ctx);
                    result = await this._workflowAgent.execute(workflowConfig);
                    this._workflowAgent = null;
                    break;
                }

                case "retry_failed": {
                    const retryAccountIds = store.retryFailedAccounts();
                    const retryQuotaIds = store.retryFailedQuotas();
                    const retryPoolIds = store.retryFailedPools();

                    result = {
                        status: "completed",
                        summary: {
                            retriedAccounts: retryAccountIds.length,
                            retriedQuotas: retryQuotaIds.length,
                            retriedPools: retryPoolIds.length,
                            accountIds: retryAccountIds,
                            quotaIds: retryQuotaIds,
                            poolIds: retryPoolIds,
                        },
                    };

                    store.addNotification({
                        type: "info",
                        message: `Retry queued: ${retryAccountIds.length} accounts, ${retryQuotaIds.length} quotas, ${retryPoolIds.length} pools`,
                    });
                    break;
                }

                default:
                    throw new Error(`Unknown action: ${action}`);
            }

            store.setAgentStatus("orchestrator", "completed");
            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: `Action "${action}" completed with status: ${result.status}`,
            });

            return result;
        } catch (error: any) {
            const errorMsg = error?.message ?? String(error);
            store.setAgentStatus("orchestrator", "error");
            store.addLog({
                agent: "orchestrator",
                level: "error",
                message: `Action "${action}" failed: ${errorMsg}`,
            });
            return {
                status: "failed",
                summary: { error: errorMsg },
            };
        }
    }

    private async _discoverAccounts(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        const subscriptionId = payload.subscriptionId as string;
        const { store, getAccessToken, armUrl } = this._ctx;

        store.setAgentStatus("provisioner", "running");
        store.addLog({
            agent: "provisioner",
            level: "info",
            message: `Discovering existing Batch accounts in subscription ${subscriptionId.substring(0, 8)}...`,
        });

        try {
            const token = await getAccessToken();
            let url: string | null =
                `${armUrl}/subscriptions/${subscriptionId}/providers/Microsoft.Batch/batchAccounts?api-version=2024-02-01`;
            const allAccounts: any[] = [];

            // Handle pagination
            while (url) {
                const response = await fetch(url, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(
                        err?.error?.message ??
                            `Discovery failed: ${response.status}`
                    );
                }
                const data = await response.json();
                allAccounts.push(...(data.value ?? []));
                url = data.nextLink ?? null;
            }

            // Deduplicate against existing accounts in state
            const existingIds = new Set(
                store.getState().accounts.map((a) => a.id.toLowerCase())
            );
            let imported = 0;

            for (const acct of allAccounts) {
                const id = (acct.id as string) ?? "";
                if (existingIds.has(id.toLowerCase())) continue;

                // Parse resource group from the ARM id
                const rgMatch = id.match(/resourceGroups\/([^/]+)/i);
                const resourceGroup = rgMatch ? rgMatch[1] : "unknown";

                store.addAccount({
                    id,
                    accountName: acct.name,
                    resourceGroup,
                    subscriptionId,
                    region: acct.location,
                    provisioningState: "created",
                    createdAt:
                        acct.properties?.creationTime ??
                        new Date().toISOString(),
                    error: null,
                });
                imported++;
            }

            store.setAgentStatus("provisioner", "completed");
            store.addLog({
                agent: "provisioner",
                level: "info",
                message: `Discovered ${allAccounts.length} Batch accounts, imported ${imported} new (${allAccounts.length - imported} already tracked)`,
            });

            return {
                status: "completed",
                summary: {
                    total: allAccounts.length,
                    imported,
                    skipped: allAccounts.length - imported,
                },
            };
        } catch (error: any) {
            const errorMsg = error?.message ?? String(error);
            store.setAgentStatus("provisioner", "error");
            store.addLog({
                agent: "provisioner",
                level: "error",
                message: `Discovery failed: ${errorMsg}`,
            });
            throw error;
        }
    }

    private _validatePrecondition(action: string, check: () => void): void {
        try {
            check();
        } catch (error: any) {
            this._ctx.store.addLog({
                agent: "orchestrator",
                level: "error",
                message: `Precondition failed for ${action}: ${error.message}`,
            });
            throw error;
        }
    }

    // Expose child agents for direct access from UI
    get provisioner(): ProvisionerAgent {
        return this._provisioner;
    }
    get quota(): QuotaAgent {
        return this._quota;
    }
    get monitor(): MonitorAgent {
        return this._monitor;
    }
    get filter(): FilterAgent {
        return this._filter;
    }
    get pool(): PoolAgent {
        return this._pool;
    }
    get node(): NodeAgent {
        return this._node;
    }
}
