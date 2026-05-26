/**
 * Abortable timer helper. Awaiting `abortableSleep(ms, signal)`:
 *   - resolves after `ms` milliseconds, OR
 *   - rejects immediately with an `AbortError`-shaped Error if the
 *     supplied AbortSignal is already aborted or becomes aborted during
 *     the wait.
 *
 * Used by polling loops (e.g. PoolAgent waits 15s between resize polls)
 * so a cancel-mid-poll exits within an event loop tick instead of
 * hanging for up to the full poll interval.
 *
 * When `signal` is undefined, behaves like `setTimeout`-as-promise.
 */
export declare function abortableSleep(ms: number, signal?: AbortSignal): Promise<void>;
/**
 * Throw an `AbortError`-shaped Error. Mirrors the DOM AbortError so
 * `error.name === "AbortError"` works for callers that want to
 * distinguish abort from real failures.
 */
export declare function makeAbortError(message?: string): Error;
/** True iff `err` looks like an AbortSignal-driven abort. */
export declare function isAbortError(err: unknown): boolean;
/**
 * Combine multiple AbortSignals into one. The returned signal aborts
 * when ANY of the input signals aborts. The returned controller is
 * exposed so the caller can also abort programmatically (e.g. when an
 * activity's local cancel flag flips).
 *
 * Returns `null`-safe inputs: undefined / null signals are ignored.
 */
export declare function combineAbortSignals(...signals: Array<AbortSignal | undefined | null>): {
    signal: AbortSignal;
    controller: AbortController;
};
//# sourceMappingURL=abortable-sleep.d.ts.map