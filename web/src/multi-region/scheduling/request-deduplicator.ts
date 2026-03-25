export class RequestDeduplicator {
    private _inflight = new Map<string, Promise<unknown>>();

    /**
     * Coalesce concurrent identical requests: if a request with the same key
     * is already in flight, return the existing promise instead of starting
     * a new one. The promise is removed from the cache once it settles.
     */
    async deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const existing = this._inflight.get(key);
        if (existing) return existing as Promise<T>;
        const promise = fn().finally(() => this._inflight.delete(key));
        this._inflight.set(key, promise);
        return promise;
    }

    /** Check if a request with the given key is currently in flight */
    isInflight(key: string): boolean {
        return this._inflight.has(key);
    }

    /** Number of currently in-flight deduplicated requests */
    get size(): number {
        return this._inflight.size;
    }

    /** Alias for size — number of pending deduplicated requests */
    get pendingCount(): number {
        return this._inflight.size;
    }

    /**
     * Discard all tracked in-flight entries.
     * Note: this does NOT cancel the underlying promises — it only
     * removes them from the deduplication map so subsequent calls
     * with the same key will start a fresh request.
     */
    clear(): void {
        this._inflight.clear();
    }
}
