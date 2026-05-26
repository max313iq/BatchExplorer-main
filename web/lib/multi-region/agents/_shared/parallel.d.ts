/**
 * Bounded-concurrency parallel helpers.
 *
 * Previously each agent file (orchestrator, node) carried its own copy:
 * orchestrator-agent's `pMap` returns `PromiseSettledResult<R>[]`,
 * node-agent's `_parallelMap` returns `R[]` and lets rejections bubble.
 *
 * This module exposes both shapes:
 *
 *   - `pMapSettled` — equivalent to `Promise.allSettled` with a
 *     concurrency cap. Use this when you need to inspect both successes
 *     and failures.
 *   - `pMap` — equivalent to `Promise.all` with a concurrency cap.
 *     Errors propagate as a single rejection. Use when ANY failure
 *     should short-circuit the batch.
 */
/** Bounded-concurrency `Promise.allSettled` variant. */
export declare function pMapSettled<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<PromiseSettledResult<R>[]>;
/**
 * Bounded-concurrency `Promise.all` variant. Errors propagate as a
 * single rejection — the first failure wins. In-flight workers continue
 * to completion (no AbortSignal here — caller should pass one through
 * to `fn` if it wants short-circuit cancellation).
 */
export declare function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]>;
//# sourceMappingURL=parallel.d.ts.map