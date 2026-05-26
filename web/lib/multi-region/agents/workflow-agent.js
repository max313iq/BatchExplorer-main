import { __awaiter } from "tslib";
import { OrchestratorAgent } from "./orchestrator-agent";
/**
 * Multi-step workflow runner.
 *
 * Per audit fix #3 the WorkflowAgent NO LONGER constructs its own
 * OrchestratorAgent. Instead it is constructed with a reference to the
 * parent orchestrator so:
 *   - the auto-discover side-effect fires once (in the parent), not twice
 *   - `cancel()` on the workflow propagates to the same in-flight calls
 *     the parent is also seeing
 *   - the parent's `_workflowAgent` field can release the reference
 *     when the workflow finishes (no more dangling instance leak)
 *
 * Per audit fix #14 the class now implements `Agent` so it shows up
 * uniformly in telemetry and can be tracked the same way as the other
 * sub-agents. The `execute` signature is widened to
 * `Record<string, unknown>` to match the interface; callers passing a
 * `WorkflowConfig` continue to work since `WorkflowConfig` keys are a
 * subset of `Record<string, unknown>`.
 */
export class WorkflowAgent {
    constructor(ctx, parent) {
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "orchestrator"
        });
        Object.defineProperty(this, "_cancelled", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "_orchestrator", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_ctx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this._ctx = ctx;
        // Legacy callers (and existing unit tests that pre-date audit fix
        // #3) construct WorkflowAgent without a parent — fall back to
        // building a new orchestrator in that case. New production
        // construction in `orchestrator-agent.ts:run_workflow` always
        // supplies the parent so the duplicate auto-discover + leak
        // described by audit fix #3 are gone.
        this._orchestrator = parent !== null && parent !== void 0 ? parent : new OrchestratorAgent(ctx);
    }
    cancel() {
        this._cancelled = true;
        // Propagate to the parent so any in-flight orchestrator-dispatched
        // sub-call (provisioner/pool/node) sees the cancel too. The parent
        // implementation knows how to abort safely (CancellationTracker).
        this._orchestrator.cancel();
    }
    /**
     * Provisioning workflow (quota gating removed):
     *   discover -> pool
     *
     * Accepts either a `WorkflowConfig` directly or a generic record
     * with `{ kind: "refresh-chain", subscriptionId }` to route to the
     * refresh chain — keeps Agent-interface uniformity AND the legacy
     * direct-call shapes both working.
     */
    execute(config) {
        return __awaiter(this, void 0, void 0, function* () {
            // Route to refresh chain if the caller used the Agent-style payload.
            const maybe = config;
            if (maybe.kind === "refresh-chain" && typeof maybe.subscriptionId === "string") {
                return this.executeRefreshChain(maybe.subscriptionId);
            }
            return this._runProvisioning(config);
        });
    }
    _runProvisioning(config) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            const { store } = this._ctx;
            this._cancelled = false;
            store.setWorkflowState({
                isRunning: true,
                currentStep: "discover",
                completedSteps: [],
                failedStep: null,
                error: null,
            });
            const completedSteps = [];
            try {
                // Step 1: Discover accounts
                store.addLog({
                    agent: "orchestrator",
                    level: "info",
                    message: "Workflow: starting discover step",
                });
                const discoverResult = yield this._orchestrator.execute({
                    action: "discover_accounts",
                    payload: { subscriptionId: config.subscriptionId },
                });
                if (this._cancelled) {
                    return this._cancelledResult(store, completedSteps);
                }
                if (discoverResult.status === "failed") {
                    return this._failStep("discover", discoverResult, store, completedSteps);
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
                const poolResult = yield this._orchestrator.execute({
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
                    return this._failStep("pool", poolResult, store, completedSteps);
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
            }
            catch (error) {
                const errorMsg = (_a = error === null || error === void 0 ? void 0 : error.message) !== null && _a !== void 0 ? _a : String(error);
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
        });
    }
    /**
     * Refresh workflow: discover -> refresh pools -> refresh accounts -> detect unused quota.
     * Used to update state without provisioning new resources.
     *
     * Per audit fix #2 the dispatched action names match the orchestrator's
     * real action union — the previous "refresh_pools" / "refresh_accounts"
     * names did not exist on the orchestrator and silently fell through to
     * "Unknown action".
     */
    executeRefreshChain(subscriptionId) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const { store } = this._ctx;
            this._cancelled = false;
            const stepResults = {};
            const completedSteps = [];
            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: "Refresh chain: starting discover -> refresh pools -> refresh accounts -> detect unused quota",
            });
            try {
                // Step 1: Discover accounts
                if (this._cancelled) {
                    return this._partialChainResult(completedSteps, stepResults);
                }
                const discoverResult = yield this._orchestrator.execute({
                    action: "discover_accounts",
                    payload: { subscriptionId },
                });
                stepResults.discover = discoverResult.summary;
                if (discoverResult.status === "failed") {
                    store.addLog({
                        agent: "orchestrator",
                        level: "error",
                        message: `Refresh chain failed at discover: ${(_a = discoverResult.summary.error) !== null && _a !== void 0 ? _a : "unknown"}`,
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
                const poolRefreshResult = yield this._orchestrator.execute({
                    action: "refresh_pool_info",
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
                const accountRefreshResult = yield this._orchestrator.execute({
                    action: "refresh_account_info",
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
            }
            catch (error) {
                const errorMsg = (_b = error === null || error === void 0 ? void 0 : error.message) !== null && _b !== void 0 ? _b : String(error);
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
        });
    }
    /**
     * Detect accounts with free LP/dedicated cores but no pools using that capacity.
     */
    _detectUnusedQuota() {
        const state = this._ctx.store.getState();
        const accountsWithPools = new Set(state.pools
            .filter((p) => p.provisioningState === "created")
            .map((p) => p.accountId));
        const accountsWithUsage = new Set(state.accountInfos
            .filter((a) => a.dedicatedCoresUsed > 0 || a.lowPriorityCoresUsed > 0)
            .map((a) => a.id));
        const unused = [];
        for (const info of state.accountInfos) {
            if (accountsWithPools.has(info.id) || accountsWithUsage.has(info.id)) {
                continue;
            }
            if (info.lowPriorityCoresFree <= 0 && info.dedicatedCoresFree <= 0) {
                continue;
            }
            const account = state.accounts.find((a) => a.id === info.id);
            if (!account)
                continue;
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
    _partialChainResult(completedSteps, stepResults) {
        return {
            status: "partial",
            summary: {
                completedSteps,
                cancelled: true,
                stepResults,
            },
        };
    }
    _cancelledResult(store, completedSteps) {
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
    _failStep(step, result, store, completedSteps) {
        var _a, _b;
        store.setWorkflowState({
            isRunning: false,
            failedStep: step,
            error: String((_a = result.summary.error) !== null && _a !== void 0 ? _a : `Step "${step}" failed`),
        });
        store.addLog({
            agent: "orchestrator",
            level: "error",
            message: `Workflow failed at step "${step}": ${(_b = result.summary.error) !== null && _b !== void 0 ? _b : "unknown error"}`,
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
//# sourceMappingURL=workflow-agent.js.map