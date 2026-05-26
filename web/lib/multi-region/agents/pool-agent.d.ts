import { Agent, AgentContext, AgentResult } from "./agent-types";
/**
 * A TokenProvider resolves an access token, optionally scoped to a tenant.
 * This decouples the agent from a specific auth implementation.
 */
export type TokenProvider = (tenantId?: string) => Promise<string>;
export declare class PoolAgent implements Agent {
    private readonly _ctx;
    readonly name: "pool";
    /**
     * Legacy `_cancelled` flag preserved so legacy `cancel()` callers
     * keep working — but the source of truth for cooperative
     * cancellation is now the `_cancellation` tracker. When the legacy
     * flag flips, every in-flight call's controller is aborted as well.
     */
    private _cancelled;
    private readonly _cancellation;
    private readonly _tokenProvider;
    constructor(_ctx: AgentContext, tokenProvider?: TokenProvider);
    cancel(): void;
    /** Shorthand for `(ctx.auditLogger ?? noopAuditLogger)`. */
    private get _audit();
    /**
     * Per-call cancel check. Returns true if EITHER the per-call signal
     * has aborted OR the legacy `_cancelled` flag has been flipped.
     * Use at iteration boundaries instead of `if (this._cancelled)`.
     */
    private _isCancelled;
    /**
     * Resolve a Batch data-plane token for the account being targeted.
     *
     * Why per-account: when a single pool-create dispatch spans accounts
     * across multiple subscriptions (potentially owned by different
     * signed-in AAD identities), the global `_tokenProvider()` only ever
     * returns the primary account's token — which fails authentication
     * against any Batch endpoint owned by a non-primary tenant.
     *
     * The lookup chain prefers the context-provided per-sub resolver
     * (multi-account browsers) and falls back to the global provider so
     * single-account setups and unit tests with a fixed token continue
     * to work unchanged.
     *
     * `subscriptionId` may be missing on legacy / synthetic accounts —
     * the fallback covers that case too.
     */
    private _resolveToken;
    execute(params: Record<string, unknown>): Promise<AgentResult>;
    /**
     * Smart pool creation with VM size fallback.
     *
     * Per account, tries VM sizes in priority order. If a VM size fails with
     * a capacity/quota error, falls back to the next. Calculates maxNodes
     * from LP quota (floor(freeLpCores / vCPUs per VM)).
     *
     * If a pool is created but doesn't consume all available quota, a second
     * pool may be created with the next VM size for the remaining quota.
     *
     * SAFETY: ALWAYS sets targetDedicatedNodes = 0 and only uses LP quota.
     */
    executeWithFallback(params: {
        accountIds: string[];
        vmSizes: string[];
        poolConfig: Record<string, unknown>;
        quotaType: "lowPriority" | "dedicated";
        signal?: AbortSignal;
        dryRun?: boolean;
    }): Promise<AgentResult>;
    /**
     * Poll until a pool's allocationState becomes "steady" or timeout.
     * Returns the actual node counts so we can calculate real quota usage.
     *
     * Honors `signal` for cooperative cancellation — the 15-second wait
     * between polls is abortable, so a mid-poll cancel exits in an
     * event-loop tick instead of waiting up to a full interval.
     *
     * `pollIntervalMs` defaults to 15s (production). Tests inject a much
     * smaller value to keep the smart-mode end-to-end pool-creation
     * tests under their 30s jest timeout.
     */
    static POLL_INTERVAL_MS: number;
    private _waitForPoolSteady;
    /**
     * Append a PoolInfo entry to store.poolInfos after successful creation.
     */
    private _addPoolInfoToStore;
}
//# sourceMappingURL=pool-agent.d.ts.map