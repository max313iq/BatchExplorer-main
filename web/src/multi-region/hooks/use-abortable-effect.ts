/**
 * useAbortableEffect — `useEffect` with a per-render `AbortController`.
 *
 * The signal is aborted automatically on the next dependency-change and on
 * unmount, so consumers can pass it to `fetch`, `axios`, or any function
 * that respects an `AbortSignal` without worrying about lifetimes.
 *
 * The effect callback may return:
 *   - nothing: standard fire-and-forget;
 *   - a cleanup function: runs alongside the abort on tear-down;
 *   - a Promise (e.g. from an `async` callback): the resolved cleanup, if
 *     any, runs alongside the abort. NOTE: returning a Promise from a
 *     `useEffect` callback is otherwise a React anti-pattern; this hook
 *     swallows it for ergonomic `async` fetches.
 *
 * @example
 * ```ts
 * useAbortableEffect(async (signal) => {
 *   const res = await fetch(`/api/pools/${id}`, { signal });
 *   if (signal.aborted) return;
 *   setPool(await res.json());
 * }, [id]);
 * ```
 */
import * as React from "react";

type EffectCleanup = void | (() => void);
type EffectCallback = (
  signal: AbortSignal,
) => EffectCleanup | Promise<EffectCleanup>;

export function useAbortableEffect(
  effect: EffectCallback,
  deps: React.DependencyList,
): void {
  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let cleanup: EffectCleanup | undefined;

    const result = effect(controller.signal);

    if (result && typeof (result as Promise<EffectCleanup>).then === "function") {
      // Async effect — store the cleanup once the promise settles, unless
      // we've already torn down (in which case run it immediately).
      (result as Promise<EffectCleanup>).then((c) => {
        if (cancelled) {
          if (typeof c === "function") c();
        } else {
          cleanup = c;
        }
      });
    } else {
      cleanup = result as EffectCleanup;
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (typeof cleanup === "function") cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
