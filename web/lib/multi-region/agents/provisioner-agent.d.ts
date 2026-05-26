import { Agent, AgentContext, AgentResult } from "./agent-types";
export declare class ProvisionerAgent implements Agent {
    private readonly _ctx;
    readonly name: "provisioner";
    private _cancelled;
    private readonly _cancellation;
    constructor(_ctx: AgentContext);
    cancel(): void;
    private get _audit();
    execute(params: Record<string, unknown>): Promise<AgentResult>;
    /**
     * SAFETY: Validate that the subscription is in an active/enabled state.
     * Never create accounts under disabled/warned/deleted subscriptions
     * as they will be immediately disabled.
     */
    private _validateSubscription;
}
//# sourceMappingURL=provisioner-agent.d.ts.map