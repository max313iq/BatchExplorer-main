export interface RequestSchedulerOptions {
    concurrency?: number;
    delayMs?: number;
    retryAttempts?: number;
    backoffSeconds?: number[];
    jitterPct?: number;
}

export interface RetryDecision {
    shouldRetry: boolean;
    reason: "none" | "network" | "throttle" | "transient" | "conflict";
    delayMs: number;
}

const DEFAULT_RETRY_BACKOFF_SECONDS = [2, 4, 8, 16, 32];

/**
 * Schedules requests with per-key serialization and bounded global concurrency.
 * Default behavior is conservative to reduce throttling risk.
 */
export class RequestScheduler {
    private readonly _concurrency: number;
    private readonly _delayMs: number;
    private readonly _retryAttempts: number;
    private readonly _backoffSeconds: number[];
    private readonly _jitterPct: number;

    private _activeCount = 0;
    private _nextStartAt = 0;
    private _paceChain: Promise<void> = Promise.resolve();
    private _keyChains = new Map<string, Promise<unknown>>();
    private _slotQueue: Array<() => void> = [];

    constructor(options: RequestSchedulerOptions = {}) {
        this._concurrency = Math.max(1, options.concurrency ?? 1);
        this._delayMs = Math.max(0, options.delayMs ?? 250);
        this._retryAttempts = Math.max(0, options.retryAttempts ?? 5);
        this._backoffSeconds = options.backoffSeconds && options.backoffSeconds.length > 0
            ? options.backoffSeconds
            : DEFAULT_RETRY_BACKOFF_SECONDS;
        this._jitterPct = Math.min(Math.max(options.jitterPct ?? 0.1, 0), 0.5);
    }

    public run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const serializedKey = key || "default";
        const previous = this._keyChains.get(serializedKey) ?? Promise.resolve();
        const scheduled = previous
            .catch(() => undefined)
            .then(() => this._executeScheduled(fn));

        this._keyChains.set(serializedKey, scheduled);
        scheduled.finally(() => {
            if (this._keyChains.get(serializedKey) === scheduled) {
                this._keyChains.delete(serializedKey);
            }
        });

        return scheduled;
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
                if (!decision.shouldRetry || retryCount >= this._retryAttempts) {
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
        const delayMs = Math.max(baseDelayMs, retryAfterMs ?? 0);

        if (status === 0 || status == null) {
            return { shouldRetry: true, reason: "network", delayMs };
        }

        if (status === 429) {
            return { shouldRetry: true, reason: "throttle", delayMs };
        }

        if (status === 503 || status === 502 || status === 500 || status === 408) {
            return { shouldRetry: true, reason: "transient", delayMs };
        }

        if (status === 409 && this._isRetryableConflict(error)) {
            return { shouldRetry: true, reason: "conflict", delayMs };
        }

        return { shouldRetry: false, reason: "none", delayMs: 0 };
    }

    private _isRetryableConflict(error: any): boolean {
        const code = String(error?.code ?? error?.error?.code ?? "").toLowerCase();
        const message = String(error?.message ?? error?.error?.message ?? "").toLowerCase();
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

        return retriableHints.some(x => code.includes(x) || message.includes(x));
    }

    private _extractStatus(error: any): number | null {
        const status = error?.status;
        return typeof status === "number" ? status : null;
    }

    private _extractRetryAfterMs(error: any): number | null {
        const headers = error?.headers;
        if (!headers) {
            return null;
        }

        let value: string | null = null;
        if (typeof headers.get === "function") {
            value = headers.get("Retry-After") ?? headers.get("retry-after");
        } else {
            value = headers["Retry-After"] ?? headers["retry-after"] ?? null;
        }

        if (!value) {
            return null;
        }

        const asNumber = Number(value);
        if (!Number.isNaN(asNumber)) {
            return Math.max(0, Math.floor(asNumber * 1000));
        }

        const asDate = Date.parse(value);
        if (Number.isNaN(asDate)) {
            return null;
        }

        return Math.max(0, asDate - Date.now());
    }

    private _getBackoffDelayMs(retryCount: number): number {
        const index = Math.min(retryCount, this._backoffSeconds.length - 1);
        const baseMs = this._backoffSeconds[index] * 1000;
        if (this._jitterPct <= 0) {
            return baseMs;
        }

        const spread = baseMs * this._jitterPct;
        const jitter = (Math.random() * spread * 2) - spread;
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
        if (next) {
            next();
        }
    }

    private async _applyPacing(): Promise<void> {
        const nextPace = this._paceChain.then(async () => {
            const now = Date.now();
            const waitMs = Math.max(0, this._nextStartAt - now);
            if (waitMs > 0) {
                await this._delay(waitMs);
            }
            this._nextStartAt = Date.now() + this._delayMs;
        });

        this._paceChain = nextPace.catch(() => undefined);
        await nextPace;
    }

    private _delay(ms: number): Promise<void> {
        if (ms <= 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
