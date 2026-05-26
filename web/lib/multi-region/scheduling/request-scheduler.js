import { __awaiter } from "tslib";
/**
 * Ported from desktop/src/app/services/workbench/request-scheduler.ts
 * Pure TypeScript — no Angular or Electron dependencies.
 */
import { globalRetryBudget } from "./retry-budget";
const DEFAULT_RETRY_BACKOFF_SECONDS = [2, 4, 8, 16, 32];
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_JITTER_PCT = 0.2;
/**
 * Production-default scheduler options used by the dashboard's agent context.
 * Tuned for Azure ARM/Batch rate limits (concurrency=1, 2s pacing, 5 retries
 * with [2,4,8,16,32]s backoff, 20% jitter).
 */
export const DEFAULT_SCHEDULER_OPTIONS = {
    concurrency: 1,
    delayMs: 2000,
    retryAttempts: 5,
    retryBackoffSeconds: [2, 4, 8, 16, 32],
    jitterPct: 0.2,
    maxQueueSize: 100,
};
export class RequestSchedulerQueueOverflowError extends Error {
    constructor(maxQueueSize) {
        super(`Request scheduler queue capacity reached (${maxQueueSize}).`);
        this.name = "RequestSchedulerQueueOverflowError";
    }
}
export class RequestScheduler {
    constructor(options = {}) {
        var _a, _b, _c, _d, _e;
        Object.defineProperty(this, "_concurrency", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_delayMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_retryAttempts", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_backoffSeconds", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_jitterPct", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_maxQueueSize", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_now", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_random", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_sleep", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_retryBudget", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_activeCount", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "_inflightCount", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "_nextStartAt", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "_paceChain", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: Promise.resolve()
        });
        Object.defineProperty(this, "_keyChains", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "_slotQueue", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        this._concurrency = Math.max(1, (_a = options.concurrency) !== null && _a !== void 0 ? _a : 1);
        const delayMs = typeof options.delayMs === "number"
            ? options.delayMs
            : options.delayMsBetweenRequests;
        this._delayMs = Math.max(0, delayMs !== null && delayMs !== void 0 ? delayMs : DEFAULT_DELAY_MS);
        this._retryAttempts = Math.max(0, (_b = options.retryAttempts) !== null && _b !== void 0 ? _b : 5);
        const backoff = options.retryBackoffSeconds && options.retryBackoffSeconds.length > 0
            ? options.retryBackoffSeconds
            : options.backoffSeconds;
        this._backoffSeconds =
            backoff && backoff.length > 0
                ? backoff.map((value) => Math.max(0, value))
                : DEFAULT_RETRY_BACKOFF_SECONDS;
        this._jitterPct = Math.min(Math.max((_c = options.jitterPct) !== null && _c !== void 0 ? _c : DEFAULT_JITTER_PCT, 0), 0.5);
        this._maxQueueSize = Math.max(1, (_d = options.maxQueueSize) !== null && _d !== void 0 ? _d : DEFAULT_MAX_QUEUE_SIZE);
        this._now = options.now || (() => Date.now());
        this._random = options.random || (() => Math.random());
        this._sleep =
            options.sleep ||
                ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        // null = explicit opt-out; undefined = use shared singleton.
        this._retryBudget =
            options.retryBudget === null
                ? null
                : ((_e = options.retryBudget) !== null && _e !== void 0 ? _e : globalRetryBudget());
    }
    run(key, fn) {
        var _a;
        if (this._inflightCount >= this._maxQueueSize) {
            return Promise.reject(new RequestSchedulerQueueOverflowError(this._maxQueueSize));
        }
        const serializedKey = key || "default";
        this._inflightCount++;
        const previous = (_a = this._keyChains.get(serializedKey)) !== null && _a !== void 0 ? _a : Promise.resolve();
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
    get inflightCount() {
        return this._inflightCount;
    }
    /** Number of concurrency slots currently in use */
    get activeCount() {
        return this._activeCount;
    }
    _executeScheduled(fn) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this._acquireSlot();
            try {
                yield this._applyPacing();
                return yield this._executeWithRetry(fn);
            }
            finally {
                this._releaseSlot();
            }
        });
    }
    _executeWithRetry(fn) {
        return __awaiter(this, void 0, void 0, function* () {
            let retryCount = 0;
            for (;;) {
                try {
                    return yield fn();
                }
                catch (error) {
                    const decision = this._classifyRetry(error, retryCount);
                    if (!decision.shouldRetry || retryCount >= this._retryAttempts) {
                        throw error;
                    }
                    // Session-wide retry budget. Once exhausted, surface the error
                    // immediately instead of waiting through another exponential
                    // backoff. Without this, a tenant-wide throttle event causes
                    // every in-flight call to spin through `retryAttempts` worth
                    // of backoff before the UI sees any failure, dragging the
                    // operator out of the loop for minutes.
                    if (this._retryBudget && !this._retryBudget.tryAcquire()) {
                        throw error;
                    }
                    retryCount++;
                    yield this._delay(decision.delayMs);
                }
            }
        });
    }
    _classifyRetry(error, retryCount) {
        const status = this._extractStatus(error);
        const retryAfterMs = this._extractRetryAfterMs(error);
        const baseDelayMs = this._getBackoffDelayMs(retryCount);
        // Honor Retry-After header: use the maximum of backoff and Retry-After
        const delayMs = Math.max(baseDelayMs, retryAfterMs !== null && retryAfterMs !== void 0 ? retryAfterMs : 0);
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
        if (status === 503 || status === 502 || status === 500 || status === 408) {
            return { shouldRetry: true, reason: "transient", delayMs };
        }
        if (status === 409 && this._isRetryableConflict(error)) {
            return { shouldRetry: true, reason: "conflict", delayMs };
        }
        return { shouldRetry: false, reason: "none", delayMs: 0 };
    }
    _isRetryableConflict(error) {
        var _a, _b, _c, _d, _e, _f;
        const code = String((_c = (_a = error === null || error === void 0 ? void 0 : error.code) !== null && _a !== void 0 ? _a : (_b = error === null || error === void 0 ? void 0 : error.error) === null || _b === void 0 ? void 0 : _b.code) !== null && _c !== void 0 ? _c : "").toLowerCase();
        const message = String((_f = (_d = error === null || error === void 0 ? void 0 : error.message) !== null && _d !== void 0 ? _d : (_e = error === null || error === void 0 ? void 0 : error.error) === null || _e === void 0 ? void 0 : _e.message) !== null && _f !== void 0 ? _f : "").toLowerCase();
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
        return retriableHints.some((x) => code.includes(x) || message.includes(x));
    }
    _extractStatus(error) {
        const status = error === null || error === void 0 ? void 0 : error.status;
        return typeof status === "number" ? status : null;
    }
    /**
     * Extract Retry-After header from error objects.
     * Supports both seconds (numeric) and HTTP-date formats.
     */
    _extractRetryAfterMs(error) {
        const value = this._readHeaderValue(error, "retry-after");
        if (!value)
            return null;
        const asNumber = Number(value);
        if (!Number.isNaN(asNumber)) {
            return Math.max(0, Math.floor(asNumber * 1000));
        }
        const asDate = Date.parse(value);
        if (Number.isNaN(asDate))
            return null;
        return Math.max(0, asDate - this._now());
    }
    _readHeaderValue(error, headerName) {
        var _a, _b;
        const headers = [
            error === null || error === void 0 ? void 0 : error.headers,
            (_a = error === null || error === void 0 ? void 0 : error.error) === null || _a === void 0 ? void 0 : _a.headers,
            (_b = error === null || error === void 0 ? void 0 : error.response) === null || _b === void 0 ? void 0 : _b.headers,
        ];
        for (const item of headers) {
            const value = this._readHeaderFromSource(item, headerName);
            if (value)
                return value;
        }
        return null;
    }
    _readHeaderFromSource(headers, headerName) {
        if (!headers)
            return null;
        if (typeof headers.get === "function") {
            const direct = headers.get(headerName) ||
                headers.get(headerName.toLowerCase()) ||
                headers.get(headerName.toUpperCase());
            return this._normalizeHeaderValue(direct);
        }
        const targetKey = headerName.toLowerCase();
        const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === targetKey);
        if (!key)
            return null;
        return this._normalizeHeaderValue(headers[key]);
    }
    _normalizeHeaderValue(value) {
        if (value == null)
            return null;
        if (Array.isArray(value))
            return this._normalizeHeaderValue(value[0]);
        return String(value);
    }
    _getBackoffDelayMs(retryCount) {
        const index = Math.min(retryCount, this._backoffSeconds.length - 1);
        const baseMs = this._backoffSeconds[index] * 1000;
        if (this._jitterPct <= 0)
            return baseMs;
        const spread = baseMs * this._jitterPct;
        const jitter = this._random() * spread * 2 - spread;
        return Math.max(0, Math.floor(baseMs + jitter));
    }
    _acquireSlot() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._activeCount < this._concurrency) {
                this._activeCount++;
                return;
            }
            yield new Promise((resolve) => {
                this._slotQueue.push(() => {
                    this._activeCount++;
                    resolve();
                });
            });
        });
    }
    _releaseSlot() {
        this._activeCount = Math.max(0, this._activeCount - 1);
        const next = this._slotQueue.shift();
        if (next)
            next();
    }
    _applyPacing() {
        return __awaiter(this, void 0, void 0, function* () {
            const nextPace = this._paceChain.then(() => __awaiter(this, void 0, void 0, function* () {
                const now = this._now();
                const waitMs = Math.max(0, this._nextStartAt - now);
                if (waitMs > 0) {
                    yield this._delay(waitMs);
                }
                this._nextStartAt = this._now() + this._delayMs;
            }));
            this._paceChain = nextPace.catch(() => undefined);
            yield nextPace;
        });
    }
    _delay(ms) {
        if (ms <= 0)
            return Promise.resolve();
        return this._sleep(ms);
    }
}
//# sourceMappingURL=request-scheduler.js.map