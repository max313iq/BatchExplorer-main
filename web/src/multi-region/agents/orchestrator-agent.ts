import { Agent, AgentContext, AgentResult } from "./agent-types";
import { ProvisionerAgent } from "./provisioner-agent";
import { QuotaAgent } from "./quota-agent";
import { MonitorAgent } from "./monitor-agent";
import { FilterAgent } from "./filter-agent";
import { PoolAgent } from "./pool-agent";

export type OrchestratorAction =
    | "create_accounts"
    | "submit_quota_requests"
    | "check_quota_status"
    | "filter_accounts"
    | "create_pools";

export class OrchestratorAgent implements Agent {
    readonly name = "orchestrator" as const;

    private readonly _provisioner: ProvisionerAgent;
    private readonly _quota: QuotaAgent;
    private readonly _monitor: MonitorAgent;
    private readonly _filter: FilterAgent;
    private readonly _pool: PoolAgent;
    constructor(private readonly _ctx: AgentContext) {
        this._provisioner = new ProvisionerAgent(_ctx);
        this._quota = new QuotaAgent(_ctx);
        this._monitor = new MonitorAgent(_ctx);
        this._filter = new FilterAgent(_ctx.store);
        this._pool = new PoolAgent(_ctx);
    }

    cancel(): void {
        this._provisioner.cancel();
        this._quota.cancel();
        this._monitor.cancel();
        this._pool.cancel();
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
}
