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
const DEFAULT_LIMIT = 100;
const DEFAULT_WINDOW_MS = 60000;
/**
 * Token-stamp sliding-window budget. Each `tryAcquire()` either consumes
 * one slot (returns true) or returns false (budget exhausted). Slots
 * automatically free as their stamps fall out of the window.
 */
export class RetryBudget {
    constructor(opts) {
        var _a, _b, _c;
        Object.defineProperty(this, "_limit", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_windowMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_now", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_stamps", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        this._limit = Math.max(1, (_a = opts === null || opts === void 0 ? void 0 : opts.limit) !== null && _a !== void 0 ? _a : DEFAULT_LIMIT);
        this._windowMs = Math.max(1, (_b = opts === null || opts === void 0 ? void 0 : opts.windowMs) !== null && _b !== void 0 ? _b : DEFAULT_WINDOW_MS);
        this._now = (_c = opts === null || opts === void 0 ? void 0 : opts.now) !== null && _c !== void 0 ? _c : (() => Date.now());
    }
    /**
     * Attempt to consume one retry slot.
     *
     * Returns true if the budget had room AND the stamp was recorded.
     * Returns false if the sliding window already contains `limit`
     * recent retries — caller should fail-fast.
     */
    tryAcquire() {
        this._evict();
        if (this._stamps.length >= this._limit) {
            return false;
        }
        this._stamps.push(this._now());
        return true;
    }
    /**
     * Snapshot of available slots. Does not consume.
     * Useful for telemetry / surface to the operator.
     */
    available() {
        this._evict();
        return Math.max(0, this._limit - this._stamps.length);
    }
    /**
     * Manually drop all stamps. Useful as part of a "user clicked
     * Restart" affordance or as cleanup after a known-recoverable
     * outage so subsequent calls don't inherit prior backpressure.
     */
    reset() {
        this._stamps = [];
    }
    _evict() {
        const cutoff = this._now() - this._windowMs;
        // Stamps are append-only and time-monotonic, so the oldest are at
        // the head. Walk forward until we find a stamp inside the window.
        let firstInWindow = 0;
        while (firstInWindow < this._stamps.length &&
            this._stamps[firstInWindow] <= cutoff) {
            firstInWindow++;
        }
        if (firstInWindow > 0) {
            this._stamps = this._stamps.slice(firstInWindow);
        }
    }
}
let _shared = null;
/**
 * Session-wide singleton. All `RequestScheduler` instances share this
 * budget so they can collectively fail-fast under a retry storm.
 */
export function globalRetryBudget() {
    if (!_shared) {
        _shared = new RetryBudget();
    }
    return _shared;
}
/**
 * Test-only escape hatch — replace the singleton so unit tests can
 * inject a deterministic clock without polluting module state.
 */
export function _setGlobalRetryBudgetForTest(b) {
    _shared = b;
}
//# sourceMappingURL=retry-budget.js.map