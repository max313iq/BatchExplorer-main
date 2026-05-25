/**
 * Per-key bookkeeping. Tracks the underlying in-flight promise, the
 * AbortController whose `.signal` we wired into the originating
 * `fn(signal)`, and a reference count of waiters that subscribed via
 * `deduplicate(key, fn, signal)` and still want the result. Only when
 * the LAST waiter aborts do we abort the underlying request.
 */
interface InflightEntry<T> {
  promise: Promise<T>;
  /**
   * Controller passed to the originating fn. Aborted only when the
   * reference count reaches zero AND at least one waiter aborted.
   */
  underlyingController: AbortController;
  /** Number of waiters still interested in the result. */
  refCount: number;
  /**
   * Tracks whether ANY waiter has aborted. If true and refCount falls
   * to zero, we abort the underlying request. If false (all waiters
   * resolved or never registered signals), the request continues even
   * if refCount reaches zero because some other future waiter could
   * still subscribe — but in practice once a waiter resolves the promise
   * settles and the entry is cleared.
   */
  anyAborted: boolean;
}

export class RequestDeduplicator {
  private _inflight = new Map<string, InflightEntry<unknown>>();

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
  async deduplicate<T>(
    key: string,
    fn: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const existing = this._inflight.get(key) as InflightEntry<T> | undefined;
    if (existing) {
      existing.refCount++;
      return this._waitWithSignal(key, existing, signal);
    }

    const underlyingController = new AbortController();
    const entry: InflightEntry<T> = {
      promise: undefined as unknown as Promise<T>,
      underlyingController,
      refCount: 1,
      anyAborted: false,
    };
    // Kick off the underlying call, scrubbing the entry from the map
    // once it settles (success or failure).
    entry.promise = fn(underlyingController.signal).finally(() => {
      this._inflight.delete(key);
    });
    this._inflight.set(key, entry as InflightEntry<unknown>);
    return this._waitWithSignal(key, entry, signal);
  }

  /**
   * Subscribe to an existing entry with optional per-waiter signal. The
   * returned promise rejects with the waiter's abort reason when their
   * own signal fires, without affecting other waiters or the underlying
   * request (unless this was the last waiter).
   */
  private _waitWithSignal<T>(
    key: string,
    entry: InflightEntry<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (!signal) {
      return entry.promise;
    }
    if (signal.aborted) {
      this._unsubscribe(key, entry, true);
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        this._unsubscribe(key, entry, true);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  private _unsubscribe<T>(
    key: string,
    entry: InflightEntry<T>,
    aborted: boolean,
  ): void {
    if (aborted) entry.anyAborted = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount === 0 && entry.anyAborted) {
      try {
        entry.underlyingController.abort();
      } catch {
        /* AbortController.abort() is total */
      }
      // Don't delete the map entry here — the `finally` on the
      // underlying promise does that. Deleting twice is harmless but
      // avoids a race where a new caller registers under the same key
      // before the abort propagates.
    }
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
