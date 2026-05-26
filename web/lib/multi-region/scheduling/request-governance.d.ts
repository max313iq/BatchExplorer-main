import type { EndpointFamily, ThrottleStatusEntry, ThrottleTransition } from "../services/types";
/** Telemetry sink so the layer above can mirror state to the store. */
export interface RateLimitTelemetry {
    /** Replace the per-subscription/family entry. */
    setEntry(subscriptionId: string, family: EndpointFamily, entry: ThrottleStatusEntry): void;
    /** Append a transition (capped to last 50). */
    pushTransition(t: ThrottleTransition): void;
    /** Surface a CRITICAL log event (suspension signal). */
    critical?(message: string): void;
}
export interface RateLimitDecisionContext {
    status: number;
    retryAfterMs: number | null;
    headers?: Headers | null;
    bodyText?: string | null;
}
/**
 * Adaptive token-bucket rate limiter with circuit breaker, scoped per
 * (subscriptionId, endpoint family). Keeps total Azure API pressure under
 * a per-subscription budget so abuse heuristics never trip.
 */
export declare class RequestGuard {
    private _buckets;
    private _breakers;
    private _subInflight;
    private _subQueue;
    /**
     * Multiple sinks because more than one subsystem wants to mirror
     * throttle state (the dashboard shell mirrors into the store for the
     * Throttle Health page; the orchestrator agent also wants live state
     * for cross-region scheduling decisions). Pre-existing
     * `setTelemetry(sink)` was destructive — the second install silently
     * unhooked the first. We now keep a Set and fan out to all of them.
     */
    private _sinks;
    /**
     * Add a telemetry sink. Returns an unsubscribe callback the caller
     * MUST hold onto so the sink can be detached on unmount / teardown.
     * Idempotent — the same sink instance added twice still counts once.
     *
     * On first attach, current snapshots for every known (sub, family)
     * are replayed so the sink immediately reflects the current state.
     */
    addTelemetrySink(sink: RateLimitTelemetry): () => void;
    /**
     * Back-compat shim. Existing `guard.setTelemetry(sink)` call sites
     * (dashboard-shell, orchestrator-agent) keep working — the call wipes
     * any previously installed sink and registers the new one. New code
     * SHOULD use `addTelemetrySink` so multiple subsystems can coexist.
     *
     * Passing `null` clears every sink.
     */
    setTelemetry(sink: RateLimitTelemetry | null): void;
    /**
     * Reserve a token + breaker permission for an outbound request.
     * Returns a release callback that the caller MUST invoke after the
     * request settles (success, failure, or throw). Throws if the circuit
     * is OPEN — caller should NOT hit Azure in that case.
     */
    acquire(subscriptionId: string, family: EndpointFamily): Promise<() => void>;
    /**
     * Feed a response back to the limiter + breaker so it can adapt.
     * Call this after every dispatched request, regardless of outcome.
     */
    observe(subscriptionId: string, family: EndpointFamily, ctx: RateLimitDecisionContext): void;
    private _acquireSubConcurrency;
    private _releaseSubConcurrency;
    private _getBucket;
    private _getBreaker;
    private _refill;
    private _consumeToken;
    private _transition;
    private _publishStatus;
    private _emitCritical;
    /**
     * Read x-ms-ratelimit-remaining-* headers from the response and adapt
     * the token bucket's refill rate preemptively. The smallest visible
     * budget wins (Azure publishes multiple, scoped at sub/tenant/resource).
     *
     * Effect:
     *   - budget > recovery threshold (1500): walk refill back toward baseline
     *   - budget in [soft_floor, recovery): leave refill alone
     *   - budget in [hard_floor, soft_floor): scale refill linearly to a
     *     floor of ~25% of baseline
     *   - budget < hard_floor: clamp refill to MIN_REFILL_PER_SEC and pause
     *     the bucket for 5s so the next request has to wait
     *
     * Special-case: Azure Resource Graph publishes its quota under a
     * different header (`x-ms-user-quota-remaining`, range 0..15-ish). We
     * normalize it onto the same scale as ARM's budget by treating the
     * ARG-specific floor of 3 as the equivalent of the ARM HARD_FLOOR (50),
     * scaling linearly. That way an ARG 429 surfaces in the same circuit
     * pathway as ARM throttles without ARG calls leaking through unchecked.
     *
     * This only TIGHTENS the bucket — the existing 429 path can still cut
     * harder if Azure sends a lower budget in a Retry-After response.
     */
    private _applyBudgetSignal;
    private _snapshot;
}
/** Singleton accessor used by the service-layer fetch wrapper. */
export declare function getSharedRequestGuard(): RequestGuard;
export interface GuardedFetchOptions {
    subscriptionId: string;
    family: EndpointFamily;
    /**
     * Optional CAE / claims-challenge recovery hook.
     *
     * Azure AD long-lived CAE tokens may be invalidated mid-session in
     * response to risk signals (sign-in policy changes, location shift,
     * tenant-admin revoke-all, etc.). The resource server signals this
     * via `HTTP 401` + `WWW-Authenticate: Bearer claims="..."`. When this
     * happens we'd normally surface a forced re-login to the operator
     * even though the SSO session is fine — a silent re-acquire with the
     * `claims=` parameter would have succeeded.
     *
     * If the caller supplies `tokenProvider`, `guardedFetch` will:
     *   1. Detect a 401 + WWW-Authenticate claims challenge.
     *   2. Decode the claims JSON.
     *   3. Call `tokenProvider(claims)` to mint a fresh token.
     *   4. Replace the `Authorization: Bearer ...` header on the
     *      request and retry exactly once.
     *
     * If `tokenProvider` is omitted (the default — every existing call
     * site), the 401 bubbles through unchanged. Callers that DO supply
     * it can keep their existing 401-handling fallback for non-CAE 401s
     * (token actually expired, etc.).
     *
     * The provider is invoked at most once per `guardedFetch` call — if
     * the retry still 401s with another claims challenge, the second 401
     * surfaces so the operator can intervene (defends against an infinite
     * loop where AAD and the resource server disagree on what challenge
     * is satisfied).
     */
    tokenProvider?: (claims?: string) => Promise<string>;
}
/**
 * Fetch wrapper that enforces the rate-limit + circuit-breaker decision
 * for outbound Azure API calls. A failure to acquire a token throws
 * `Error("Circuit open: ...")` BEFORE any network call is dispatched.
 *
 * Optional CAE recovery: when `opts.tokenProvider` is supplied AND the
 * response is a 401 with a `WWW-Authenticate: Bearer claims=...` header,
 * `guardedFetch` calls the provider with the decoded claims JSON, swaps
 * the bearer header on the request, and retries exactly once. See
 * `GuardedFetchOptions.tokenProvider` for the full contract.
 */
export declare function guardedFetch(url: string, init: RequestInit | undefined, opts: GuardedFetchOptions): Promise<Response>;
//# sourceMappingURL=request-governance.d.ts.map