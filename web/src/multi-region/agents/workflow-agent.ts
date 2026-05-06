import { AgentContext, AgentResult } from "./agent-types";
import { OrchestratorAgent } from "./orchestrator-agent";
import { QuotaType, WorkflowStep } from "../store/store-types";

export interface WorkflowConfig {
    subscriptionId: string;
    quotaType: QuotaType;
    quotaLimit: number;
    contactEmail: string;
    poolConfig: Record<string, unknown>;
    monitorIntervalSeconds?: number;
    monitorMaxMinutes?: number;
}

export class WorkflowAgent {
    private _cancelled = false;
    private readonly _orchestrator: OrchestratorAgent;
    private readonly _ctx: AgentContext;

    constructor(ctx: AgentContext) {
        this._ctx = ctx;
        this._orchestrator = new OrchestratorAgent(ctx);
    }

    cancel(): void {
        this._cancelled = true;
        this._orchestrator.cancel();
    }

    /**
     * Provisioning workflow (quota gating removed):
     *   discover -> pool
     */
    async execute(config: WorkflowConfig): Promise<AgentResult> {
        const { store } = this._ctx;
        this._cancelled = false;

        store.setWorkflowState({
            isRunning: true,
            currentStep: "discover",
            completedSteps: [],
            failedStep: null,
            error: null,
        });

        const completedSteps: WorkflowStep[] = [];

        try {
            // Step 1: Discover accounts
            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: "Workflow: starting discover step",
            });

            const discoverResult = await this._orchestrator.execute({
                action: "discover_accounts",
                payload: { subscriptionId: config.subscriptionId },
            });

            if (this._cancelled) {
                return this._cancelledResult(store, completedSteps);
            }

            if (discoverResult.status === "failed") {
                return this._failStep(
                    "discover",
                    discoverResult,
                    store,
                    completedSteps
                );
            }

            completedSteps.push("discover");
            store.setWorkflowState({
                currentStep: "pool",
                completedSteps: [...completedSteps],
            });

            // Step 2: Create pools across all created accounts (no quota gating)
            if (this._cancelled) {
                return this._cancelledResult(store, completedSteps);
            }

            const updatedState = store.getState();
            const poolAccountIds = updatedState.accounts
                .filter((a) => a.provisioningState === "created")
                .map((a) => a.id);

            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: `Workflow: creating pools for ${poolAccountIds.length} accounts`,
            });

            const poolResult = await this._orchestrator.execute({
                action: "create_pools",
                payload: {
                    accountIds: poolAccountIds,
                    poolConfig: config.poolConfig,
                },
            });

            if (this._cancelled) {
                return this._cancelledResult(store, completedSteps);
            }

            if (poolResult.status === "failed") {
                return this._failStep(
                    "pool",
                    poolResult,
                    store,
                    completedSteps
                );
            }

            completedSteps.push("pool");
            store.setWorkflowState({
                isRunning: false,
                currentStep: null,
                completedSteps: [...completedSteps],
            });

            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: "Workflow: all steps completed successfully",
            });

            return {
                status: "completed",
                summary: {
                    completedSteps: [...completedSteps],
                    discover: discoverResult.summary,
                    pool: poolResult.summary,
                },
            };
        } catch (error: any) {
            const errorMsg = error?.message ?? String(error);
            const currentStep = store.getState().workflow.currentStep;

            store.setWorkflowState({
                isRunning: false,
                failedStep: currentStep,
                error: errorMsg,
            });

            store.addLog({
                agent: "orchestrator",
                level: "error",
                message: `Workflow failed at step "${currentStep}": ${errorMsg}`,
            });

            return {
                status: "failed",
                summary: {
                    completedSteps: [...completedSteps],
                    failedStep: currentStep,
                    error: errorMsg,
                },
            };
        }
    }

    /**
     * Refresh workflow: discover -> refresh pools -> refresh accounts -> detect unused quota.
     * Used to update state without provisioning new resources.
     */
    async executeRefreshChain(subscriptionId: string): Promise<AgentResult> {
        const { store } = this._ctx;
        this._cancelled = false;

        const stepResults: Record<string, AgentResult["summary"]> = {};
        const completedSteps: string[] = [];

        store.addLog({
            agent: "orchestrator",
            level: "info",
            message:
                "Refresh chain: starting discover -> refresh pools -> refresh accounts -> detect unused quota",
        });

        try {
            // Step 1: Discover accounts
            if (this._cancelled) {
                return this._partialChainResult(completedSteps, stepResults);
            }

            const discoverResult = await this._orchestrator.execute({
                action: "discover_accounts",
                payload: { subscriptionId },
            });
            stepResults.discover = discoverResult.summary;

            if (discoverResult.status === "failed") {
                store.addLog({
                    agent: "orchestrator",
                    level: "error",
                    message: `Refresh chain failed at discover: ${discoverResult.summary.error ?? "unknown"}`,
                });
                return {
                    status: "failed",
                    summary: {
                        completedSteps,
                        failedStep: "discover",
                        stepResults,
                    },
                };
            }
            completedSteps.push("discover");

            // Step 2: Refresh pools for all discovered accounts
            if (this._cancelled) {
                return this._partialChainResult(completedSteps, stepResults);
            }

            const accounts = store
                .getState()
                .accounts.filter((a) => a.provisioningState === "created");
            const accountIds = accounts.map((a) => a.id);

            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: `Refresh chain: refreshing pools for ${accountIds.length} accounts`,
            });

            const poolRefreshResult = await this._orchestrator.execute({
                action: "refresh_pools",
                payload: { accountIds },
            });
            stepResults.refreshPools = poolRefreshResult.summary;
            completedSteps.push("refreshPools");

            // Step 3: Refresh account details (quotas, usage)
            if (this._cancelled) {
                return this._partialChainResult(completedSteps, stepResults);
            }

            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: `Refresh chain: refreshing account details for ${accountIds.length} accounts`,
            });

            const accountRefreshResult = await this._orchestrator.execute({
                action: "refresh_accounts",
                payload: { accountIds },
            });
            stepResults.refreshAccounts = accountRefreshResult.summary;
            completedSteps.push("refreshAccounts");

            // Step 4: Detect unused quota
            if (this._cancelled) {
                return this._partialChainResult(completedSteps, stepResults);
            }

            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: "Refresh chain: detecting unused quota",
            });

            const unusedQuota = this._detectUnusedQuota();
            stepResults.unusedQuota = unusedQuota;
            completedSteps.push("detectUnusedQuota");

            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: `Refresh chain complete: ${unusedQuota.accountsWithUnusedQuota} accounts have unused quota`,
            });

            return {
                status: "completed",
                summary: {
                    completedSteps,
                    stepResults,
                },
            };
        } catch (error: any) {
            const errorMsg = error?.message ?? String(error);
            store.addLog({
                agent: "orchestrator",
                level: "error",
                message: `Refresh chain error: ${errorMsg}`,
            });
            return {
                status: "failed",
                summary: {
                    completedSteps,
                    error: errorMsg,
                    stepResults,
                },
            };
        }
    }

    /**
     * Detect accounts with free LP/dedicated cores but no pools using that capacity.
     */
    private _detectUnusedQuota(): Record<string, unknown> {
        const state = this._ctx.store.getState();

        const accountsWithPools = new Set(
            state.pools
                .filter((p) => p.provisioningState === "created")
                .map((p) => p.accountId)
        );

        const accountsWithUsage = new Set(
            state.accountInfos
                .filter(
                    (a) =>
                        a.dedicatedCoresUsed > 0 || a.lowPriorityCoresUsed > 0
                )
                .map((a) => a.id)
        );

        const unused: Array<{
            accountId: string;
            accountName: string;
            region: string;
            freeLpCores: number;
            freeDedicatedCores: number;
        }> = [];

        for (const info of state.accountInfos) {
            if (
                accountsWithPools.has(info.id) ||
                accountsWithUsage.has(info.id)
            ) {
                continue;
            }
            if (
                info.lowPriorityCoresFree <= 0 &&
                info.dedicatedCoresFree <= 0
            ) {
                continue;
            }
            const account = state.accounts.find((a) => a.id === info.id);
            if (!account) continue;
            unused.push({
                accountId: info.id,
                accountName: account.accountName,
                region: account.region,
                freeLpCores: info.lowPriorityCoresFree,
                freeDedicatedCores: info.dedicatedCoresFree,
            });
        }

        return {
            accountsWithUnusedQuota: unused.length,
            accounts: unused,
        };
    }

    private _partialChainResult(
        completedSteps: string[],
        stepResults: Record<string, unknown>
    ): AgentResult {
        return {
            status: "partial",
            summary: {
                completedSteps,
                cancelled: true,
                stepResults,
            },
        };
    }

    private _cancelledResult(
        store: AgentContext["store"],
        completedSteps: WorkflowStep[]
    ): AgentResult {
        store.setWorkflowState({
            isRunning: false,
            error: "Workflow cancelled by user",
        });
        store.addLog({
            agent: "orchestrator",
            level: "warn",
            message: "Workflow cancelled by user",
        });
        return {
            status: "partial",
            summary: { completedSteps: [...completedSteps], cancelled: true },
        };
    }

    private _failStep(
        step: WorkflowStep,
        result: AgentResult,
        store: AgentContext["store"],
        completedSteps: WorkflowStep[]
    ): AgentResult {
        store.setWorkflowState({
            isRunning: false,
            failedStep: step,
            error: String(result.summary.error ?? `Step "${step}" failed`),
        });

        store.addLog({
            agent: "orchestrator",
            level: "error",
            message: `Workflow failed at step "${step}": ${result.summary.error ?? "unknown error"}`,
        });

        return {
            status: "failed",
            summary: {
                completedSteps: [...completedSteps],
                failedStep: step,
                error: result.summary.error,
            },
        };
    }
}
