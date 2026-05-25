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
export function abortError(reason?: string): DOMException {
  // `DOMException` exists in jsdom (the test environment) and in every
  // supported browser; we don't need a polyfill.
  return new DOMException(reason ?? "Aborted", "AbortError");
}

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
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) throw reason;
  throw abortError(typeof reason === "string" ? reason : undefined);
}

/**
 * Type-guard utility. True when the value is an `AbortError`-shaped
 * Error (any source — DOMException, custom). Useful in catch sites
 * that want to silently swallow cancellation without re-throwing.
 */
export function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "AbortError") return true;
  if (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name?: unknown }).name === "AbortError"
  ) {
    return true;
  }
  return false;
}
