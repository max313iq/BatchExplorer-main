/**
 * Per-agent cancellation tracker.
 *
 * Previously each agent (pool/node/provisioner) reset a single
 * `_cancelled = false` field at the top of every `execute()` call —
 * which meant a concurrent caller calling `agent.cancel()` could see
 * its abort signal silently swallowed by the next execute() starting up.
 *
 * `CancellationTracker` replaces that pattern. Each `execute()` invokes
 * `tracker.begin()` to register a new AbortController and returns the
 * resulting signal; the cancel-all path (`tracker.abortAll()`) fires
 * `abort()` on every registered controller. Completed calls clean
 * themselves up via `tracker.end(controller)`.
 *
 * The tracker also accepts an optional parent signal — when supplied,
 * `begin(parent)` returns a combined signal that fires when EITHER the
 * agent-level cancel OR the parent (e.g. orchestrator-level cancel)
 * fires.
 */
export declare class CancellationTracker {
    private readonly _controllers;
    /**
     * Register a new per-call controller. Returns the controller so the
     * caller can pass `controller.signal` to its async helpers AND so the
     * caller can later release it via `end(controller)`.
     *
     * If `parent` is supplied, the returned `signal` will abort when
     * EITHER the per-call controller fires or the parent does.
     */
    begin(parent?: AbortSignal): {
        controller: AbortController;
        signal: AbortSignal;
    };
    /** Release a controller registered via `begin()`. Idempotent. */
    end(controller: AbortController): void;
    /**
     * Abort every active controller. Equivalent to the old
     * `_cancelled = true` flip but safe under concurrent execute() calls.
     */
    abortAll(): void;
    /** True iff at least one controller is registered. */
    get hasActive(): boolean;
}
//# sourceMappingURL=cancellation.d.ts.map