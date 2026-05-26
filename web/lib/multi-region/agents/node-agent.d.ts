import { Agent, AgentContext, AgentResult } from "./agent-types";
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
    action: "reboot" | "delete" | "reimage" | "disableScheduling" | "enableScheduling";
    nodeIds: string[];
    tokenProvider?: TokenProvider;
}
export declare class NodeAgent implements Agent {
    private readonly _ctx;
    readonly name: "node";
    /** Legacy flag for `cancel()` callers — mirrored to controllers. */
    private _cancelled;
    private readonly _cancellation;
    constructor(_ctx: AgentContext);
    cancel(): void;
    private get _audit();
    private _isCancelled;
    execute(params: Record<string, unknown>): Promise<AgentResult>;
    /**
     * Resolve a bearer token. If a TokenProvider was supplied in the input
     * it takes precedence over the context's default accessor.
     */
    private _resolveToken;
    private _listNodes;
    private _executeNodeAction;
    /**
     * Convert a raw Batch data-plane node response into a ManagedNode.
     *
     * isDedicated mapping: the Batch API may return `isDedicated` on the
     * node itself. When it is not present, we infer dedication from the
     * pool counters -- if the node's ordinal index is less than the pool's
     * `currentDedicatedNodes`, it is dedicated; otherwise low-priority.
     */
    private _toBatchNode;
}
//# sourceMappingURL=node-agent.d.ts.map