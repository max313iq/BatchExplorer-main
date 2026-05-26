import { Agent, AgentContext, AgentResult } from "./agent-types";
import { OrchestratorAgent } from "./orchestrator-agent";
import { QuotaType } from "../store/store-types";
export interface WorkflowConfig {
    subscriptionId: string;
    quotaType: QuotaType;
    quotaLimit: number;
    contactEmail: string;
    poolConfig: Record<string, unknown>;
    monitorIntervalSeconds?: number;
    monitorMaxMinutes?: number;
}
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
export declare class WorkflowAgent implements Agent {
    readonly name: "orchestrator";
    private _cancelled;
    private readonly _orchestrator;
    private readonly _ctx;
    constructor(ctx: AgentContext, parent?: OrchestratorAgent);
    cancel(): void;
    /**
     * Provisioning workflow (quota gating removed):
     *   discover -> pool
     *
     * Accepts either a `WorkflowConfig` directly or a generic record
     * with `{ kind: "refresh-chain", subscriptionId }` to route to the
     * refresh chain — keeps Agent-interface uniformity AND the legacy
     * direct-call shapes both working.
     */
    execute(config: WorkflowConfig | Record<string, unknown>): Promise<AgentResult>;
    private _runProvisioning;
    /**
     * Refresh workflow: discover -> refresh pools -> refresh accounts -> detect unused quota.
     * Used to update state without provisioning new resources.
     *
     * Per audit fix #2 the dispatched action names match the orchestrator's
     * real action union — the previous "refresh_pools" / "refresh_accounts"
     * names did not exist on the orchestrator and silently fell through to
     * "Unknown action".
     */
    executeRefreshChain(subscriptionId: string): Promise<AgentResult>;
    /**
     * Detect accounts with free LP/dedicated cores but no pools using that capacity.
     */
    private _detectUnusedQuota;
    private _partialChainResult;
    private _cancelledResult;
    private _failStep;
}
//# sourceMappingURL=workflow-agent.d.ts.map