/**
 * Shared abort-helpers used by every service-layer module.
 *
 * Why a dedicated module:
 *   Browser fetch + the React `AbortController` ecosystem expects
 *   `e.name === "AbortError"` for cancellation. Throwing
 *   `new Error("Aborted")` defeats every cancellation-aware caller
 *   (they fall through to `console.error` and surface a misleading
 *   "request failed" toast). Standardizing on `DOMException("Aborted",
 *   "AbortError")` lets callers do `if (e.name === "AbortError")` and
 *   silently drop cancelled work.
 *
 *   Wrapping the construction in a helper keeps the call sites short
 *   and prevents drift if the canonical shape ever changes.
 */
/**
 * Construct the canonical DOMException representing an aborted
 * operation. Always shape: `name === "AbortError"`, `message === "Aborted"`
 * (plus the optional reason if supplied).
 */
export declare function abortError(reason?: string): DOMException;
/**
 * Throw the canonical abort error. Convenience wrapper that lets
 * service-layer code write:
 *
 *   if (signal?.aborted) throwIfAborted(signal);
 *
 * without spelling out the DOMException at every call site. Falls
 * through to the abort `reason` when present (per AbortController
 * Stage-3 semantics).
 */
export declare function throwIfAborted(signal?: AbortSignal): void;
/**
 * Type-guard utility. True when the value is an `AbortError`-shaped
 * Error (any source — DOMException, custom). Useful in catch sites
 * that want to silently swallow cancellation without re-throwing.
 */
export declare function isAbortError(e: unknown): boolean;
//# sourceMappingURL=abort-helpers.d.ts.map