/**
 * Ported from desktop/src/app/services/workbench/request-scheduler.ts
 * Pure TypeScript — no Angular or Electron dependencies.
 */

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
}

export interface RetryDecision {
    shouldRetry: boolean;
    reason: "none" | "network" | "throttle" | "transient" | "conflict";
    delayMs: number;
}

const DEFAULT_RETRY_BACKOFF_SECONDS = [2, 4, 8, 16, 32];
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_JITTER_PCT = 0.2;

export class RequestSchedulerQueueOverflowError extends Error {
    constructor(maxQueueSize: number) {
        super(`Request scheduler queue capacity reached (${maxQueueSize}).`);
        this.name = "RequestSchedulerQueueOverflowError";
    }
}

export class RequestScheduler {
    private readonly _concurrency: number;
    private readonly _delayMs: number;
    private readonly _retryAttempts: number;
    private readonly _backoffSeconds: number[];
    private readonly _jitterPct: number;
    private readonly _maxQueueSize: number;
    private readonly _now: () => number;
    private readonly _random: () => number;
    private readonly _sleep: (ms: number) => Promise<void>;

    private _activeCount = 0;
    private _inflightCount = 0;
    private _nextStartAt = 0;
    private _paceChain: Promise<void> = Promise.resolve();
    private _keyChains = new Map<string, Promise<unknown>>();
    private _slotQueue: Array<() => void> = [];

    constructor(options: RequestSchedulerOptions = {}) {
        this._concurrency = Math.max(1, options.concurrency ?? 1);
        const delayMs =
            typeof options.delayMs === "number"
                ? options.delayMs
                : options.delayMsBetweenRequests;
        this._delayMs = Math.max(0, delayMs ?? DEFAULT_DELAY_MS);
        this._retryAttempts = Math.max(0, options.retryAttempts ?? 5);
        const backoff =
            options.retryBackoffSeconds &&
            options.retryBackoffSeconds.length > 0
                ? options.retryBackoffSeconds
                : options.backoffSeconds;
        this._backoffSeconds =
            backoff && backoff.length > 0
                ? backoff.map((value) => Math.max(0, value))
                : DEFAULT_RETRY_BACKOFF_SECONDS;
        this._jitterPct = Math.min(
            Math.max(options.jitterPct ?? DEFAULT_JITTER_PCT, 0),
            0.5
        );
        this._maxQueueSize = Math.max(
            1,
            options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
        );
        this._now = options.now || (() => Date.now());
        this._random = options.random || (() => Math.random());
        this._sleep =
            options.sleep ||
            ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    public run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        if (this._inflightCount >= this._maxQueueSize) {
            return Promise.reject(
                new RequestSchedulerQueueOverflowError(this._maxQueueSize)
            );
        }

        const serializedKey = key || "default";
        this._inflightCount++;
        const previous =
            this._keyChains.get(serializedKey) ?? Promise.resolve();
        const scheduled = previous
            .catch(() => undefined)
            .then(() => this._executeScheduled(fn));

        this._keyChains.set(serializedKey, scheduled);
        scheduled.finally(() => {
            this._inflightCount = Math.max(0, this._inflightCount - 1);
            if (this._keyChains.get(serializedKey) === scheduled) {
                this._keyChains.delete(serializedKey);
            }
        });

        return scheduled;
    }

    /** Number of requests currently queued or executing */
    public get inflightCount(): number {
        return this._inflightCount;
    }

    /** Number of concurrency slots currently in use */
    public get activeCount(): number {
        return this._activeCount;
    }

    private async _executeScheduled<T>(fn: () => Promise<T>): Promise<T> {
        await this._acquireSlot();
        try {
            await this._applyPacing();
            return await this._executeWithRetry(fn);
        } finally {
            this._releaseSlot();
        }
    }

    private async _executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
        let retryCount = 0;
        for (;;) {
            try {
                return await fn();
            } catch (error) {
                const decision = this._classifyRetry(error, retryCount);
                if (
                    !decision.shouldRetry ||
                    retryCount >= this._retryAttempts
                ) {
                    throw error;
                }
                retryCount++;
                await this._delay(decision.delayMs);
            }
        }
    }

    private _classifyRetry(error: any, retryCount: number): RetryDecision {
        const status = this._extractStatus(error);
        const retryAfterMs = this._extractRetryAfterMs(error);
        const baseDelayMs = this._getBackoffDelayMs(retryCount);

        // Honor Retry-After header: use the maximum of backoff and Retry-After
        const delayMs = Math.max(baseDelayMs, retryAfterMs ?? 0);

        if (status === 0 || status == null) {
            return { shouldRetry: true, reason: "network", delayMs };
        }
        if (status === 429) {
            // For 429, always respect Retry-After if present, with a minimum floor
            const throttleDelay = Math.max(delayMs, 1000);
            return {
                shouldRetry: true,
                reason: "throttle",
                delayMs: throttleDelay,
            };
        }
        if (
            status === 503 ||
            status === 502 ||
            status === 500 ||
            status === 408
        ) {
            return { shouldRetry: true, reason: "transient", delayMs };
        }
        if (status === 409 && this._isRetryableConflict(error)) {
            return { shouldRetry: true, reason: "conflict", delayMs };
        }
        return { shouldRetry: false, reason: "none", delayMs: 0 };
    }

    private _isRetryableConflict(error: any): boolean {
        const code = String(
            error?.code ?? error?.error?.code ?? ""
        ).toLowerCase();
        const message = String(
            error?.message ?? error?.error?.message ?? ""
        ).toLowerCase();
        const retriableHints = [
            "poolisresizing",
            "operationinvalidforcurrentstate",
            "anotheroperation",
            "conflict",
            "allocation state",
            "busy",
            "resizing",
            "stopping",
            "steady",
        ];
        return retriableHints.some(
            (x) => code.includes(x) || message.includes(x)
        );
    }

    private _extractStatus(error: any): number | null {
        const status = error?.status;
        return typeof status === "number" ? status : null;
    }

    /**
     * Extract Retry-After header from error objects.
     * Supports both seconds (numeric) and HTTP-date formats.
     */
    private _extractRetryAfterMs(error: any): number | null {
        const value = this._readHeaderValue(error, "retry-after");
        if (!value) return null;
        const asNumber = Number(value);
        if (!Number.isNaN(asNumber)) {
            return Math.max(0, Math.floor(asNumber * 1000));
        }
        const asDate = Date.parse(value);
        if (Number.isNaN(asDate)) return null;
        return Math.max(0, asDate - this._now());
    }

    private _readHeaderValue(error: any, headerName: string): string | null {
        const headers = [
            error?.headers,
            error?.error?.headers,
            error?.response?.headers,
        ];
        for (const item of headers) {
            const value = this._readHeaderFromSource(item, headerName);
            if (value) return value;
        }
        return null;
    }

    private _readHeaderFromSource(
        headers: any,
        headerName: string
    ): string | null {
        if (!headers) return null;
        if (typeof headers.get === "function") {
            const direct =
                headers.get(headerName) ||
                headers.get(headerName.toLowerCase()) ||
                headers.get(headerName.toUpperCase());
            return this._normalizeHeaderValue(direct);
        }
        const targetKey = headerName.toLowerCase();
        const key = Object.keys(headers).find(
            (candidate) => candidate.toLowerCase() === targetKey
        );
        if (!key) return null;
        return this._normalizeHeaderValue(headers[key]);
    }

    private _normalizeHeaderValue(value: any): string | null {
        if (value == null) return null;
        if (Array.isArray(value)) return this._normalizeHeaderValue(value[0]);
        return String(value);
    }

    private _getBackoffDelayMs(retryCount: number): number {
        const index = Math.min(retryCount, this._backoffSeconds.length - 1);
        const baseMs = this._backoffSeconds[index] * 1000;
        if (this._jitterPct <= 0) return baseMs;
        const spread = baseMs * this._jitterPct;
        const jitter = this._random() * spread * 2 - spread;
        return Math.max(0, Math.floor(baseMs + jitter));
    }

    private async _acquireSlot(): Promise<void> {
        if (this._activeCount < this._concurrency) {
            this._activeCount++;
            return;
        }
        await new Promise<void>((resolve) => {
            this._slotQueue.push(() => {
                this._activeCount++;
                resolve();
            });
        });
    }

    private _releaseSlot(): void {
        this._activeCount = Math.max(0, this._activeCount - 1);
        const next = this._slotQueue.shift();
        if (next) next();
    }

    private async _applyPacing(): Promise<void> {
        const nextPace = this._paceChain.then(async () => {
            const now = this._now();
            const waitMs = Math.max(0, this._nextStartAt - now);
            if (waitMs > 0) {
                await this._delay(waitMs);
            }
            this._nextStartAt = this._now() + this._delayMs;
        });
        this._paceChain = nextPace.catch(() => undefined);
        await nextPace;
    }

    private _delay(ms: number): Promise<void> {
        if (ms <= 0) return Promise.resolve();
        return this._sleep(ms);
    }
}
