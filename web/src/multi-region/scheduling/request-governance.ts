/**
 * Centralized Request Governance for Azure API calls.
 * Combines scheduling, deduplication, retry, and telemetry into a
 * single facade so callers don't need to wire primitives together.
 */
import { RequestScheduler } from "./request-scheduler";
import { RequestDeduplicator } from "./request-deduplicator";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GovernanceOptions {
    /** Max concurrent read requests (default: 10) */
    readConcurrency: number;
    /** Max concurrent write requests (default: 1) */
    writeConcurrency: number;
    /** Minimum delay between write requests in ms (default: 500) */
    writeDelayMs: number;
    /** Maximum retry attempts for transient failures (default: 4) */
    maxRetries: number;
    /** Base backoff duration in ms before first retry (default: 1000) */
    baseBackoffMs: number;
    /** Jitter percentage applied to backoff (0–0.5, default: 0.2) */
    jitterPct: number;
    /** Optional callback invoked on every 429 / throttle event */
    onThrottle?: (info: ThrottleInfo) => void;
}

export interface ThrottleInfo {
    /** HTTP status that triggered the throttle (usually 429) */
    status: number;
    /** The delay (ms) the governance layer will wait before retrying */
    retryAfterMs: number;
    /** Which retry attempt this is (1-based) */
    attempt: number;
}

export interface RetryOptions {
    /** Override max retries for this call */
    maxRetries?: number;
    /** Override base backoff for this call */
    baseBackoffMs?: number;
}

export interface GovernanceStats {
    totalReads: number;
    totalWrites: number;
    deduplicatedReads: number;
    retryCount: number;
    throttleCount: number;
    lastThrottleAt: number | null;
}

// ---------------------------------------------------------------------------
// Non-retryable HTTP status codes — throw immediately on these
// ---------------------------------------------------------------------------

const NON_RETRYABLE_STATUSES = new Set([400, 403, 404]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRetryableError(error: unknown): boolean {
    if (error instanceof TypeError) return true; // network failure
    const status = extractStatus(error);
    if (status === null) return true; // unknown / network
    if (NON_RETRYABLE_STATUSES.has(status)) return false;
    if (status === 429 || status === 500 || status === 502 || status === 503) {
        return true;
    }
    return false;
}

function extractStatus(error: unknown): number | null {
    if (typeof error === "object" && error !== null && "status" in error) {
        const s = (error as Record<string, unknown>).status;
        return typeof s === "number" ? s : null;
    }
    return null;
}

function extractRetryAfterMs(error: unknown, now: number): number | null {
    const value = readRetryAfterHeader(error);
    if (value === null) return null;

    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) {
        return Math.max(0, Math.floor(asNumber * 1000));
    }
    const asDate = Date.parse(value);
    if (Number.isNaN(asDate)) return null;
    return Math.max(0, asDate - now);
}

function readRetryAfterHeader(error: unknown): string | null {
    if (typeof error !== "object" || error === null) return null;
    const candidates = [
        (error as any)?.headers,
        (error as any)?.error?.headers,
        (error as any)?.response?.headers,
    ];
    for (const headers of candidates) {
        const val = readFromHeaders(headers, "retry-after");
        if (val !== null) return val;
    }
    return null;
}

function readFromHeaders(headers: unknown, name: string): string | null {
    if (!headers || typeof headers !== "object") return null;
    if (typeof (headers as any).get === "function") {
        const v =
            (headers as any).get(name) ??
            (headers as any).get(name.toLowerCase());
        return v != null ? String(v) : null;
    }
    const target = name.toLowerCase();
    const key = Object.keys(headers as object).find(
        (k) => k.toLowerCase() === target
    );
    if (!key) return null;
    const raw = (headers as Record<string, unknown>)[key];
    if (raw == null) return null;
    if (Array.isArray(raw)) return raw.length > 0 ? String(raw[0]) : null;
    return String(raw);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// RequestGovernance
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: GovernanceOptions = {
    readConcurrency: 10,
    writeConcurrency: 1,
    writeDelayMs: 500,
    maxRetries: 4,
    baseBackoffMs: 1000,
    jitterPct: 0.2,
};

export class RequestGovernance {
    private readonly _readScheduler: RequestScheduler;
    private readonly _writeScheduler: RequestScheduler;
    private readonly _deduplicator: RequestDeduplicator;
    private readonly _options: GovernanceOptions;
    private _stats: GovernanceStats;

    constructor(options?: Partial<GovernanceOptions>) {
        this._options = { ...DEFAULT_OPTIONS, ...options };

        this._readScheduler = new RequestScheduler({
            concurrency: this._options.readConcurrency,
            delayMs: 0, // reads are only bounded by concurrency
            retryAttempts: 0, // retry is handled by the governance layer
        });

        this._writeScheduler = new RequestScheduler({
            concurrency: this._options.writeConcurrency,
            delayMs: this._options.writeDelayMs,
            retryAttempts: 0,
        });

        this._deduplicator = new RequestDeduplicator();

        this._stats = this._emptyStats();
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Execute a read operation with deduplication + bounded concurrency.
     * Concurrent reads with the same `key` are coalesced into a single
     * in-flight request.
     */
    async read<T>(key: string, fn: () => Promise<T>): Promise<T> {
        this._stats.totalReads++;
        const alreadyInflight = this._deduplicator.isInflight(key);
        const result = await this._deduplicator.deduplicate(key, () =>
            this._readScheduler.run(key, () => this.withRetry(fn))
        );
        if (alreadyInflight) {
            this._stats.deduplicatedReads++;
        }
        return result;
    }

    /**
     * Execute a write operation with bounded concurrency (no dedup).
     * Writes are paced according to `writeDelayMs`.
     */
    async write<T>(fn: () => Promise<T>): Promise<T> {
        this._stats.totalWrites++;
        return this._writeScheduler.run("__write__", () => this.withRetry(fn));
    }

    /**
     * Execute `fn` with built-in retry logic for Azure errors.
     *
     * - Non-retryable (400, 403, 404): throws immediately.
     * - Retryable (429, 500, 502, 503, TypeError/network): retries with
     *   exponential backoff + jitter, honouring Retry-After headers.
     */
    async withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
        const maxRetries = opts?.maxRetries ?? this._options.maxRetries;
        const baseBackoffMs =
            opts?.baseBackoffMs ?? this._options.baseBackoffMs;
        let attempt = 0;

        for (;;) {
            try {
                return await fn();
            } catch (error: unknown) {
                if (!isRetryableError(error) || attempt >= maxRetries) {
                    throw error;
                }
                attempt++;
                this._stats.retryCount++;

                const status = extractStatus(error);
                const retryAfterMs = extractRetryAfterMs(error, Date.now());

                // Compute exponential backoff with jitter
                const expMs = baseBackoffMs * Math.pow(2, attempt - 1);
                const jitter =
                    this._options.jitterPct > 0
                        ? expMs *
                          this._options.jitterPct *
                          (Math.random() * 2 - 1)
                        : 0;
                let delayMs = Math.max(0, Math.floor(expMs + jitter));

                // Honour Retry-After if present
                if (retryAfterMs !== null && retryAfterMs > delayMs) {
                    delayMs = retryAfterMs;
                }

                // Track throttle events
                if (status === 429) {
                    this._stats.throttleCount++;
                    this._stats.lastThrottleAt = Date.now();
                    this._options.onThrottle?.({
                        status: 429,
                        retryAfterMs: delayMs,
                        attempt,
                    });
                }

                await sleep(delayMs);
            }
        }
    }

    /** Current telemetry stats (snapshot). */
    get stats(): GovernanceStats {
        return { ...this._stats };
    }

    /** Reset all telemetry counters. */
    resetStats(): void {
        this._stats = this._emptyStats();
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private _emptyStats(): GovernanceStats {
        return {
            totalReads: 0,
            totalWrites: 0,
            deduplicatedReads: 0,
            retryCount: 0,
            throttleCount: 0,
            lastThrottleAt: null,
        };
    }
}
