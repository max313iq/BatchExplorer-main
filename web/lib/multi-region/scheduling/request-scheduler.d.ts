/**
 * Ported from desktop/src/app/services/workbench/request-scheduler.ts
 * Pure TypeScript — no Angular or Electron dependencies.
 */
import { type RetryBudget } from "./retry-budget";
export interface RequestSchedulerOptions {
    concurrency?: number;
    delayMs?: number;
    /** @deprecated Use delayMs. Kept for persisted compatibility. */
    delayMsBetweenRequests?: number;
    retryAttempts?: number;
    /** @deprecated Use retryBackoffSeconds. */
    backoffSeconds?: number[];
    retryBackoffSeconds?: number[];
    jitterPct?: number;
    maxQueueSize?: number;
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * Optional session-wide retry budget. When supplied, every retry
     * consumes one slot; once the budget is empty, retries short-circuit
     * (the underlying error is rethrown immediately) until the sliding
     * window refills. Defaults to the shared singleton from
     * `./retry-budget`. Pass `null` to disable the budget for a given
     * scheduler — useful in tests.
     */
    retryBudget?: RetryBudget | null;
}
export interface RetryDecision {
    shouldRetry: boolean;
    reason: "none" | "network" | "throttle" | "transient" | "conflict";
    delayMs: number;
}
/**
 * Production-default scheduler options used by the dashboard's agent context.
 * Tuned for Azure ARM/Batch rate limits (concurrency=1, 2s pacing, 5 retries
 * with [2,4,8,16,32]s backoff, 20% jitter).
 */
export declare const DEFAULT_SCHEDULER_OPTIONS: RequestSchedulerOptions;
export declare class RequestSchedulerQueueOverflowError extends Error {
    constructor(maxQueueSize: number);
}
export declare class RequestScheduler {
    private readonly _concurrency;
    private readonly _delayMs;
    private readonly _retryAttempts;
    private readonly _backoffSeconds;
    private readonly _jitterPct;
    private readonly _maxQueueSize;
    private readonly _now;
    private readonly _random;
    private readonly _sleep;
    private readonly _retryBudget;
    private _activeCount;
    private _inflightCount;
    private _nextStartAt;
    private _paceChain;
    private _keyChains;
    private _slotQueue;
    constructor(options?: RequestSchedulerOptions);
    run<T>(key: string, fn: () => Promise<T>): Promise<T>;
    /** Number of requests currently queued or executing */
    get inflightCount(): number;
    /** Number of concurrency slots currently in use */
    get activeCount(): number;
    private _executeScheduled;
    private _executeWithRetry;
    private _classifyRetry;
    private _isRetryableConflict;
    private _extractStatus;
    /**
     * Extract Retry-After header from error objects.
     * Supports both seconds (numeric) and HTTP-date formats.
     */
    private _extractRetryAfterMs;
    private _readHeaderValue;
    private _readHeaderFromSource;
    private _normalizeHeaderValue;
    private _getBackoffDelayMs;
    private _acquireSlot;
    private _releaseSlot;
    private _applyPacing;
    private _delay;
}
//# sourceMappingURL=request-scheduler.d.ts.map