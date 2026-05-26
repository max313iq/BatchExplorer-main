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
import { __awaiter } from "tslib";
/** Bounded-concurrency `Promise.allSettled` variant. */
export function pMapSettled(items, fn, concurrency) {
    return __awaiter(this, void 0, void 0, function* () {
        const results = new Array(items.length);
        if (items.length === 0)
            return results;
        let idx = 0;
        const run = () => __awaiter(this, void 0, void 0, function* () {
            while (idx < items.length) {
                const i = idx++;
                try {
                    const value = yield fn(items[i]);
                    results[i] = { status: "fulfilled", value };
                }
                catch (reason) {
                    results[i] = { status: "rejected", reason };
                }
            }
        });
        yield Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run()));
        return results;
    });
}
/**
 * Bounded-concurrency `Promise.all` variant. Errors propagate as a
 * single rejection — the first failure wins. In-flight workers continue
 * to completion (no AbortSignal here — caller should pass one through
 * to `fn` if it wants short-circuit cancellation).
 */
export function pMap(items, fn, concurrency) {
    return __awaiter(this, void 0, void 0, function* () {
        const results = new Array(items.length);
        if (items.length === 0)
            return results;
        let idx = 0;
        let firstError = null;
        const run = () => __awaiter(this, void 0, void 0, function* () {
            while (idx < items.length) {
                if (firstError)
                    return;
                const i = idx++;
                try {
                    results[i] = yield fn(items[i]);
                }
                catch (err) {
                    if (!firstError)
                        firstError = err;
                }
            }
        });
        yield Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run()));
        if (firstError)
            throw firstError;
        return results;
    });
}
//# sourceMappingURL=parallel.js.map