export class RequestDeduplicator {
    private _inflight = new Map<string, Promise<unknown>>();

    async deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const existing = this._inflight.get(key);
        if (existing) return existing as Promise<T>;
        const promise = fn().finally(() => this._inflight.delete(key));
        this._inflight.set(key, promise);
        return promise;
    }

    isInflight(key: string): boolean {
        return this._inflight.has(key);
    }
}
