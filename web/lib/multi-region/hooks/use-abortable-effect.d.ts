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
type EffectCallback = (signal: AbortSignal) => EffectCleanup | Promise<EffectCleanup>;
export declare function useAbortableEffect(effect: EffectCallback, deps: React.DependencyList): void;
export {};
//# sourceMappingURL=use-abortable-effect.d.ts.map