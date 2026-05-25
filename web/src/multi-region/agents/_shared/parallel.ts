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
export async function pMapSettled<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  if (items.length === 0) return results;
  let idx = 0;
  const run = async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        const value = await fn(items[i]);
        results[i] = { status: "fulfilled", value };
      } catch (reason: unknown) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => run(),
    ),
  );
  return results;
}

/**
 * Bounded-concurrency `Promise.all` variant. Errors propagate as a
 * single rejection — the first failure wins. In-flight workers continue
 * to completion (no AbortSignal here — caller should pass one through
 * to `fn` if it wants short-circuit cancellation).
 */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  let idx = 0;
  let firstError: unknown = null;
  const run = async () => {
    while (idx < items.length) {
      if (firstError) return;
      const i = idx++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => run(),
    ),
  );
  if (firstError) throw firstError;
  return results;
}
