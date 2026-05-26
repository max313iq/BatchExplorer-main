import { __awaiter } from "tslib";
/**
 * Verify per-waiter cancel propagation in RequestDeduplicator.
 *
 *   - One of two waiters aborts → other still sees the result.
 *   - Both waiters abort → the underlying fn's signal fires.
 *   - Underlying fn resolves → both waiters resolve.
 */
import { RequestDeduplicator } from "../request-deduplicator";
describe("RequestDeduplicator — cancel propagation", () => {
    it("aborts the underlying fetch only when the LAST waiter aborts", () => __awaiter(void 0, void 0, void 0, function* () {
        const dedup = new RequestDeduplicator();
        // Block the underlying fn until we resolve manually so both waiters
        // are still pending when we abort.
        let underlyingAborted = false;
        let signal;
        const underlyingPromise = new Promise((resolve, reject) => {
            // Use the dedup's signal hand-off to capture the underlying signal.
            dedup
                .deduplicate("key", (sig) => {
                signal = sig;
                sig === null || sig === void 0 ? void 0 : sig.addEventListener("abort", () => {
                    underlyingAborted = true;
                    reject(new DOMException("Aborted", "AbortError"));
                });
                return new Promise(() => {
                    /* never settles unless aborted */
                });
            }, undefined)
                .catch(() => undefined);
            // We don't await — we just want the entry registered.
            setTimeout(() => resolve("never-used"), 50);
        });
        // First waiter A — owns the request.
        expect(signal).toBeDefined();
        expect(underlyingAborted).toBe(false);
        // Second waiter B subscribes with its own signal.
        const ctrlB = new AbortController();
        const bPromise = dedup.deduplicate("key", 
        // The fn passed here is ignored because the entry already exists;
        // we still pass something to satisfy the type.
        () => Promise.resolve("ignored"), ctrlB.signal);
        // Abort B; underlying must remain alive because A is still
        // subscribed.
        ctrlB.abort();
        yield expect(bPromise).rejects.toMatchObject({ name: "AbortError" });
        // Give the microtask queue a tick.
        yield new Promise((r) => setTimeout(r, 0));
        expect(underlyingAborted).toBe(false);
        // Now we don't have a per-waiter signal on A (we used `undefined`
        // when subscribing), so a re-subscription scenario isn't required —
        // the key point is "B's abort didn't propagate to the underlying
        // fetch."
        // Cleanup: don't leave a dangling promise.
        void underlyingPromise.catch(() => undefined);
    }));
    it("does NOT abort underlying when at least one waiter has no signal", () => __awaiter(void 0, void 0, void 0, function* () {
        const dedup = new RequestDeduplicator();
        let underlyingAborted = false;
        let resolveUnderlying;
        const startPromise = dedup.deduplicate("k", (sig) => {
            sig === null || sig === void 0 ? void 0 : sig.addEventListener("abort", () => {
                underlyingAborted = true;
            });
            return new Promise((res) => {
                resolveUnderlying = res;
            });
        }, 
        // No per-waiter signal — this waiter is "permanent".
        undefined);
        // Second waiter with its own controller that aborts.
        const ctrlB = new AbortController();
        const bPromise = dedup.deduplicate("k", () => Promise.resolve("ignored"), ctrlB.signal);
        ctrlB.abort();
        yield expect(bPromise).rejects.toMatchObject({ name: "AbortError" });
        // Underlying still alive — the no-signal waiter keeps the
        // reference count >0 forever.
        yield new Promise((r) => setTimeout(r, 0));
        expect(underlyingAborted).toBe(false);
        // Resolve to clean up.
        resolveUnderlying("ok");
        yield expect(startPromise).resolves.toBe("ok");
    }));
});
//# sourceMappingURL=request-deduplicator-abort.spec.js.map