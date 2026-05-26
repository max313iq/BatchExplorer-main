export declare class RequestDeduplicator {
    private _inflight;
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
    deduplicate<T>(key: string, fn: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
    /**
     * Subscribe to an existing entry with optional per-waiter signal. The
     * returned promise rejects with the waiter's abort reason when their
     * own signal fires, without affecting other waiters or the underlying
     * request (unless this was the last waiter).
     */
    private _waitWithSignal;
    private _unsubscribe;
    /** Check if a request with the given key is currently in flight */
    isInflight(key: string): boolean;
    /** Number of currently in-flight deduplicated requests */
    get size(): number;
    /** Alias for size — number of pending deduplicated requests */
    get pendingCount(): number;
    /**
     * Discard all tracked in-flight entries.
     * Note: this does NOT cancel the underlying promises — it only
     * removes them from the deduplication map so subsequent calls
     * with the same key will start a fresh request.
     */
    clear(): void;
}
//# sourceMappingURL=request-deduplicator.d.ts.map