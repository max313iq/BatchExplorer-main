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
export function abortableSleep(ms, signal) {
    if (ms <= 0) {
        if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
            return Promise.reject(makeAbortError());
        }
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
            reject(makeAbortError());
            return;
        }
        const timer = setTimeout(() => {
            if (signal)
                signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            if (signal)
                signal.removeEventListener("abort", onAbort);
            reject(makeAbortError());
        };
        if (signal)
            signal.addEventListener("abort", onAbort, { once: true });
    });
}
/**
 * Throw an `AbortError`-shaped Error. Mirrors the DOM AbortError so
 * `error.name === "AbortError"` works for callers that want to
 * distinguish abort from real failures.
 */
export function makeAbortError(message = "Operation aborted") {
    const err = new Error(message);
    err.name = "AbortError";
    return err;
}
/** True iff `err` looks like an AbortSignal-driven abort. */
export function isAbortError(err) {
    return (!!err &&
        typeof err === "object" &&
        err.name === "AbortError");
}
/**
 * Combine multiple AbortSignals into one. The returned signal aborts
 * when ANY of the input signals aborts. The returned controller is
 * exposed so the caller can also abort programmatically (e.g. when an
 * activity's local cancel flag flips).
 *
 * Returns `null`-safe inputs: undefined / null signals are ignored.
 */
export function combineAbortSignals(...signals) {
    const controller = new AbortController();
    const active = signals.filter((s) => s !== undefined && s !== null);
    for (const s of active) {
        if (s.aborted) {
            controller.abort();
            return { signal: controller.signal, controller };
        }
    }
    const onAbort = () => controller.abort();
    for (const s of active) {
        s.addEventListener("abort", onAbort, { once: true });
    }
    return { signal: controller.signal, controller };
}
//# sourceMappingURL=abortable-sleep.js.map