import { __awaiter } from "tslib";
export class RequestDeduplicator {
    constructor() {
        Object.defineProperty(this, "_inflight", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
    }
    /**
     * Coalesce concurrent identical requests: if a request with the same key
     * is already in flight, return the existing promise instead of starting
     * a new one. The promise is removed from the cache once it settles.
     *
     * Cancellation: the optional `signal` represents the *waiter's* interest
     * in the result. Aborting it removes this caller from the wait set; the
     * underlying request is aborted ONLY when every concurrent waiter has
     * aborted (reference counting). This matches the desired semantic that
     * a cancel from one page doesn't cancel the same fetch another page is
     * also waiting on.
     *
     * The originating `fn(underlyingSignal)` receives an AbortSignal that
     * fires only when all waiters have aborted. Existing callers that don't
     * accept a signal still work — the parameter is optional and ignored.
     */
    deduplicate(key, fn, signal) {
        return __awaiter(this, void 0, void 0, function* () {
            const existing = this._inflight.get(key);
            if (existing) {
                existing.refCount++;
                return this._waitWithSignal(key, existing, signal);
            }
            const underlyingController = new AbortController();
            const entry = {
                promise: undefined,
                underlyingController,
                refCount: 1,
                anyAborted: false,
            };
            // Kick off the underlying call, scrubbing the entry from the map
            // once it settles (success or failure).
            entry.promise = fn(underlyingController.signal).finally(() => {
                this._inflight.delete(key);
            });
            this._inflight.set(key, entry);
            return this._waitWithSignal(key, entry, signal);
        });
    }
    /**
     * Subscribe to an existing entry with optional per-waiter signal. The
     * returned promise rejects with the waiter's abort reason when their
     * own signal fires, without affecting other waiters or the underlying
     * request (unless this was the last waiter).
     */
    _waitWithSignal(key, entry, signal) {
        var _a;
        if (!signal) {
            return entry.promise;
        }
        if (signal.aborted) {
            this._unsubscribe(key, entry, true);
            return Promise.reject((_a = signal.reason) !== null && _a !== void 0 ? _a : new DOMException("Aborted", "AbortError"));
        }
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                var _a;
                signal.removeEventListener("abort", onAbort);
                this._unsubscribe(key, entry, true);
                reject((_a = signal.reason) !== null && _a !== void 0 ? _a : new DOMException("Aborted", "AbortError"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            entry.promise.then((v) => {
                signal.removeEventListener("abort", onAbort);
                resolve(v);
            }, (e) => {
                signal.removeEventListener("abort", onAbort);
                reject(e);
            });
        });
    }
    _unsubscribe(key, entry, aborted) {
        if (aborted)
            entry.anyAborted = true;
        entry.refCount = Math.max(0, entry.refCount - 1);
        if (entry.refCount === 0 && entry.anyAborted) {
            try {
                entry.underlyingController.abort();
            }
            catch (_a) {
                /* AbortController.abort() is total */
            }
            // Don't delete the map entry here — the `finally` on the
            // underlying promise does that. Deleting twice is harmless but
            // avoids a race where a new caller registers under the same key
            // before the abort propagates.
        }
    }
    /** Check if a request with the given key is currently in flight */
    isInflight(key) {
        return this._inflight.has(key);
    }
    /** Number of currently in-flight deduplicated requests */
    get size() {
        return this._inflight.size;
    }
    /** Alias for size — number of pending deduplicated requests */
    get pendingCount() {
        return this._inflight.size;
    }
    /**
     * Discard all tracked in-flight entries.
     * Note: this does NOT cancel the underlying promises — it only
     * removes them from the deduplication map so subsequent calls
     * with the same key will start a fresh request.
     */
    clear() {
        this._inflight.clear();
    }
}
//# sourceMappingURL=request-deduplicator.js.map