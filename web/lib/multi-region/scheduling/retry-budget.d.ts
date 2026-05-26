/**
 * Session-wide retry budget — a global circuit breaker that fail-fast
 * shorts the system out of retry storms.
 *
 * Why this exists:
 *   `RequestScheduler` retries transient failures with exponential
 *   backoff per-call. When dozens of in-flight calls all start
 *   retrying simultaneously (a regional Azure outage, a tenant-wide
 *   throttle, etc.), the per-call retry budget compounds into a
 *   thundering herd that drains the user's quota AND blocks the UI for
 *   minutes while every call slowly times out.
 *
 *   A session-wide budget caps the TOTAL number of retries in a sliding
 *   window. Once exhausted, additional retries refuse to acquire and
 *   `_executeWithRetry` surfaces the underlying error immediately —
 *   letting the operator see the failure mode in seconds rather than
 *   waiting for the per-call exponential backoff to give up.
 *
 * Defaults:
 *   - 100 retries per 60-second sliding window.
 *   - Refills naturally as old stamps fall out of the window.
 *   - `tryAcquire()` returns false (does NOT block) when the budget
 *     is empty — the caller is expected to fail-fast.
 *
 * Stateless from the perspective of the request layer: the budget is
 * a singleton, kept in module scope so every `RequestScheduler` shares
 * the same allowance.
 */
export interface RetryBudgetOptions {
    /** Max retries permitted within the sliding window. Default: 100. */
    limit?: number;
    /** Sliding-window length in milliseconds. Default: 60_000. */
    windowMs?: number;
    /** Clock override for tests. Default: `Date.now`. */
    now?: () => number;
}
/**
 * Token-stamp sliding-window budget. Each `tryAcquire()` either consumes
 * one slot (returns true) or returns false (budget exhausted). Slots
 * automatically free as their stamps fall out of the window.
 */
export declare class RetryBudget {
    private readonly _limit;
    private readonly _windowMs;
    private readonly _now;
    private _stamps;
    constructor(opts?: RetryBudgetOptions);
    /**
     * Attempt to consume one retry slot.
     *
     * Returns true if the budget had room AND the stamp was recorded.
     * Returns false if the sliding window already contains `limit`
     * recent retries — caller should fail-fast.
     */
    tryAcquire(): boolean;
    /**
     * Snapshot of available slots. Does not consume.
     * Useful for telemetry / surface to the operator.
     */
    available(): number;
    /**
     * Manually drop all stamps. Useful as part of a "user clicked
     * Restart" affordance or as cleanup after a known-recoverable
     * outage so subsequent calls don't inherit prior backpressure.
     */
    reset(): void;
    private _evict;
}
/**
 * Session-wide singleton. All `RequestScheduler` instances share this
 * budget so they can collectively fail-fast under a retry storm.
 */
export declare function globalRetryBudget(): RetryBudget;
/**
 * Test-only escape hatch — replace the singleton so unit tests can
 * inject a deterministic clock without polluting module state.
 */
export declare function _setGlobalRetryBudgetForTest(b: RetryBudget | null): void;
//# sourceMappingURL=retry-budget.d.ts.map