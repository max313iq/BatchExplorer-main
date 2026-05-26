import { __awaiter } from "tslib";
/**
 * Centralized Request Governance for Azure API calls.
 *
 * Exposes:
 *   - `RequestGuard` — token-bucket + circuit-breaker per (sub, family).
 *   - `getSharedRequestGuard()` — singleton accessor used everywhere.
 *   - `guardedFetch(url, init, opts)` — fetch wrapper that routes through
 *     the guard. Optionally accepts a `tokenProvider` so a 401 CAE
 *     claims-challenge can be transparently recovered without forcing the
 *     operator back through the sign-in flow.
 *
 * Historical note: a `RequestGovernance` façade used to live here, wiring
 * a `RequestScheduler` + `RequestDeduplicator` + retry logic together. It
 * had no production callers (every service routes through `guardedFetch`
 * which talks to `RequestGuard` directly, and per-call retry is owned by
 * `RequestScheduler._executeWithRetry`), so the class was removed to
 * avoid two divergent retry/dedup paths in one module. The two primitives
 * it composed are still exported from `./request-scheduler` and
 * `./request-deduplicator` for any future caller that wants them.
 */
import { buildCaeChallengeError, parseCaeChallenge, } from "../services/cae-interceptor";
// ---------------------------------------------------------------------------
// Adaptive Rate Limiter + Circuit Breaker
// ---------------------------------------------------------------------------
const DEFAULT_BURST = 10;
const DEFAULT_REFILL_PER_SEC = 10;
const MIN_REFILL_PER_SEC = 1;
const RECOVERY_INTERVAL_MS = 60000;
const RECOVERY_STEP_PER_SEC = 1;
const DEFAULT_RETRY_AFTER_MS = 30000;
/**
 * Predictive throttle thresholds. Azure publishes the remaining budget on
 * every response via x-ms-ratelimit-remaining-* headers. We slow down
 * BEFORE hitting 0 so we never trigger a 429 in the first place.
 *
 * The numbers are conservative defaults that work for most subscription
 * tiers. Adjust if you have a high-quota enterprise sub.
 */
const BUDGET_HEADERS = [
    "x-ms-ratelimit-remaining-subscription-reads",
    "x-ms-ratelimit-remaining-subscription-writes",
    "x-ms-ratelimit-remaining-subscription-resource-requests",
    "x-ms-ratelimit-remaining-subscription-resource-entities-read",
    "x-ms-ratelimit-remaining-tenant-reads",
    "x-ms-ratelimit-remaining-tenant-writes",
    "x-ms-ratelimit-remaining-resource",
];
/** Below this budget, we apply preemptive slowdown. */
const BUDGET_SOFT_FLOOR = 200;
/** At/below this budget, we cut the refill rate hard. */
const BUDGET_HARD_FLOOR = 50;
/**
 * Above this budget, we let the bucket recover toward baseline. Avoids
 * locking refill rate low forever after one tight spot.
 */
const BUDGET_RECOVERY_THRESHOLD = 1500;
const CONSEC_429_WINDOW_MS = 30000;
const CONSEC_429_TRIP_COUNT = 3;
const BASE_OPEN_COOLDOWN_MS = 60000;
const MAX_OPEN_COOLDOWN_MS = 5 * 60000;
const SUSPENSION_COOLDOWN_MS = 5 * 60000;
const PER_SUB_CONCURRENCY = 10;
const SUSPENSION_RE = /subscription is being throttled|suspended/i;
/**
 * Adaptive token-bucket rate limiter with circuit breaker, scoped per
 * (subscriptionId, endpoint family). Keeps total Azure API pressure under
 * a per-subscription budget so abuse heuristics never trip.
 */
export class RequestGuard {
    constructor() {
        Object.defineProperty(this, "_buckets", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "_breakers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "_subInflight", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "_subQueue", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        /**
         * Multiple sinks because more than one subsystem wants to mirror
         * throttle state (the dashboard shell mirrors into the store for the
         * Throttle Health page; the orchestrator agent also wants live state
         * for cross-region scheduling decisions). Pre-existing
         * `setTelemetry(sink)` was destructive — the second install silently
         * unhooked the first. We now keep a Set and fan out to all of them.
         */
        Object.defineProperty(this, "_sinks", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Set()
        });
    }
    /**
     * Add a telemetry sink. Returns an unsubscribe callback the caller
     * MUST hold onto so the sink can be detached on unmount / teardown.
     * Idempotent — the same sink instance added twice still counts once.
     *
     * On first attach, current snapshots for every known (sub, family)
     * are replayed so the sink immediately reflects the current state.
     */
    addTelemetrySink(sink) {
        if (this._sinks.has(sink)) {
            return () => {
                this._sinks.delete(sink);
            };
        }
        this._sinks.add(sink);
        for (const [bucketKey] of this._buckets) {
            const { sub, family } = parseKey(bucketKey);
            try {
                sink.setEntry(sub, family, this._snapshot(sub, family));
            }
            catch (_a) {
                // Sink errors must never block other sinks or the request path.
            }
        }
        return () => {
            this._sinks.delete(sink);
        };
    }
    /**
     * Back-compat shim. Existing `guard.setTelemetry(sink)` call sites
     * (dashboard-shell, orchestrator-agent) keep working — the call wipes
     * any previously installed sink and registers the new one. New code
     * SHOULD use `addTelemetrySink` so multiple subsystems can coexist.
     *
     * Passing `null` clears every sink.
     */
    setTelemetry(sink) {
        this._sinks.clear();
        if (sink) {
            this.addTelemetrySink(sink);
        }
    }
    /**
     * Reserve a token + breaker permission for an outbound request.
     * Returns a release callback that the caller MUST invoke after the
     * request settles (success, failure, or throw). Throws if the circuit
     * is OPEN — caller should NOT hit Azure in that case.
     */
    acquire(subscriptionId, family) {
        return __awaiter(this, void 0, void 0, function* () {
            const sub = subscriptionId || "default";
            yield this._acquireSubConcurrency(sub);
            let probeReleased = false;
            const releaseProbe = () => {
                if (probeReleased)
                    return;
                probeReleased = true;
                const breaker = this._getBreaker(sub, family);
                breaker.halfOpenInflight = false;
            };
            try {
                const breaker = this._getBreaker(sub, family);
                const now = Date.now();
                if (breaker.state === "open") {
                    if (now >= breaker.openUntil) {
                        this._transition(sub, family, "half_open", "cooldown elapsed");
                    }
                    else {
                        throw new Error(`Circuit open: subscription ${sub.substring(0, 8)} ${family} until ${new Date(breaker.openUntil).toISOString()}`);
                    }
                }
                if (breaker.state === "half_open") {
                    if (breaker.halfOpenInflight) {
                        throw new Error(`Circuit open: ${sub.substring(0, 8)} ${family} half-open probe in progress`);
                    }
                    breaker.halfOpenInflight = true;
                }
                yield this._consumeToken(sub, family);
            }
            catch (err) {
                this._releaseSubConcurrency(sub);
                releaseProbe();
                throw err;
            }
            let released = false;
            return () => {
                if (released)
                    return;
                released = true;
                releaseProbe();
                this._releaseSubConcurrency(sub);
            };
        });
    }
    /**
     * Feed a response back to the limiter + breaker so it can adapt.
     * Call this after every dispatched request, regardless of outcome.
     */
    observe(subscriptionId, family, ctx) {
        var _a, _b, _c;
        const sub = subscriptionId || "default";
        const breaker = this._getBreaker(sub, family);
        const bucket = this._getBucket(sub, family);
        const now = Date.now();
        // Predictive: read x-ms-ratelimit-remaining-* on EVERY response (not just
        // 429) so we slow down before hitting the wall. Azure publishes these on
        // 2xx, 4xx, and 5xx alike. This is the single highest-leverage signal
        // we have for ban avoidance.
        if (ctx.headers) {
            this._applyBudgetSignal(sub, family, ctx.headers, bucket);
        }
        const isSuspensionSignal = ((_b = (_a = ctx.headers) === null || _a === void 0 ? void 0 : _a.get("x-ms-throttling-version")) !== null && _b !== void 0 ? _b : null) !== null ||
            (ctx.bodyText ? SUSPENSION_RE.test(ctx.bodyText) : false);
        if (isSuspensionSignal) {
            breaker.cooldownMs = SUSPENSION_COOLDOWN_MS;
            breaker.openUntil = now + SUSPENSION_COOLDOWN_MS;
            breaker.recentThrottleStamps = [];
            const message = `CRITICAL: suspension signal for ${sub.substring(0, 8)} ${family}; OPEN ${SUSPENSION_COOLDOWN_MS / 1000}s`;
            this._emitCritical(message);
            this._transition(sub, family, "open", "suspension signal");
            return;
        }
        if (ctx.status === 429) {
            bucket.refillPerSec = Math.max(MIN_REFILL_PER_SEC, Math.floor(bucket.refillPerSec / 2));
            bucket.lastDegradeAt = now;
            const retryAfter = (_c = ctx.retryAfterMs) !== null && _c !== void 0 ? _c : DEFAULT_RETRY_AFTER_MS;
            bucket.tokens = 0;
            bucket.lastRefillAt = now + retryAfter;
            breaker.recentThrottles++;
            breaker.recentThrottleStamps = breaker.recentThrottleStamps
                .filter((s) => now - s <= CONSEC_429_WINDOW_MS)
                .concat(now);
            if (breaker.state === "half_open") {
                breaker.cooldownMs = Math.min(breaker.cooldownMs * 2 || BASE_OPEN_COOLDOWN_MS, MAX_OPEN_COOLDOWN_MS);
                breaker.openUntil = now + breaker.cooldownMs;
                this._transition(sub, family, "open", "half-open probe 429");
            }
            else if (breaker.recentThrottleStamps.length >= CONSEC_429_TRIP_COUNT) {
                breaker.cooldownMs = BASE_OPEN_COOLDOWN_MS;
                breaker.openUntil = now + breaker.cooldownMs;
                this._transition(sub, family, "open", `${CONSEC_429_TRIP_COUNT} consecutive 429s in 30s`);
            }
            else {
                this._publishStatus(sub, family);
            }
            return;
        }
        if (ctx.status >= 500 && ctx.status < 600) {
            this._publishStatus(sub, family);
            return;
        }
        if (ctx.status >= 200 && ctx.status < 400) {
            if (breaker.state === "half_open") {
                breaker.cooldownMs = BASE_OPEN_COOLDOWN_MS;
                breaker.recentThrottleStamps = [];
                this._transition(sub, family, "closed", "probe succeeded");
            }
            else {
                this._publishStatus(sub, family);
            }
        }
        else {
            this._publishStatus(sub, family);
        }
    }
    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------
    _acquireSubConcurrency(sub) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            const inflight = (_a = this._subInflight.get(sub)) !== null && _a !== void 0 ? _a : 0;
            if (inflight < PER_SUB_CONCURRENCY) {
                this._subInflight.set(sub, inflight + 1);
                return;
            }
            yield new Promise((resolve) => {
                var _a;
                const queue = (_a = this._subQueue.get(sub)) !== null && _a !== void 0 ? _a : [];
                queue.push(() => {
                    var _a;
                    this._subInflight.set(sub, ((_a = this._subInflight.get(sub)) !== null && _a !== void 0 ? _a : 0) + 1);
                    resolve();
                });
                this._subQueue.set(sub, queue);
            });
        });
    }
    _releaseSubConcurrency(sub) {
        var _a;
        const inflight = (_a = this._subInflight.get(sub)) !== null && _a !== void 0 ? _a : 0;
        this._subInflight.set(sub, Math.max(0, inflight - 1));
        const queue = this._subQueue.get(sub);
        if (queue && queue.length > 0) {
            const next = queue.shift();
            next();
        }
    }
    _getBucket(sub, family) {
        const key = makeKey(sub, family);
        let bucket = this._buckets.get(key);
        if (!bucket) {
            bucket = {
                refillPerSec: DEFAULT_REFILL_PER_SEC,
                baselineRefillPerSec: DEFAULT_REFILL_PER_SEC,
                tokens: DEFAULT_BURST,
                lastRefillAt: Date.now(),
                lastDegradeAt: 0,
            };
            this._buckets.set(key, bucket);
        }
        return bucket;
    }
    _getBreaker(sub, family) {
        const key = makeKey(sub, family);
        let breaker = this._breakers.get(key);
        if (!breaker) {
            breaker = {
                state: "closed",
                openUntil: 0,
                cooldownMs: BASE_OPEN_COOLDOWN_MS,
                recentThrottleStamps: [],
                recentThrottles: 0,
                halfOpenInflight: false,
            };
            this._breakers.set(key, breaker);
        }
        return breaker;
    }
    _refill(bucket) {
        const now = Date.now();
        const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
        if (elapsedMs <= 0)
            return;
        if (bucket.lastDegradeAt > 0 &&
            now - bucket.lastDegradeAt >= RECOVERY_INTERVAL_MS &&
            bucket.refillPerSec < bucket.baselineRefillPerSec) {
            bucket.refillPerSec = Math.min(bucket.baselineRefillPerSec, bucket.refillPerSec + RECOVERY_STEP_PER_SEC);
            bucket.lastDegradeAt = now;
        }
        const added = (elapsedMs / 1000) * bucket.refillPerSec;
        bucket.tokens = Math.min(DEFAULT_BURST, bucket.tokens + added);
        bucket.lastRefillAt = now;
    }
    _consumeToken(sub, family) {
        return __awaiter(this, void 0, void 0, function* () {
            for (;;) {
                const bucket = this._getBucket(sub, family);
                this._refill(bucket);
                if (bucket.tokens >= 1) {
                    bucket.tokens -= 1;
                    return;
                }
                const needed = 1 - bucket.tokens;
                const waitMs = Math.max(25, Math.ceil((needed / bucket.refillPerSec) * 1000));
                yield new Promise((resolve) => setTimeout(resolve, waitMs));
            }
        });
    }
    _transition(sub, family, to, reason) {
        const breaker = this._getBreaker(sub, family);
        const from = breaker.state;
        if (from === to) {
            this._publishStatus(sub, family);
            return;
        }
        breaker.state = to;
        if (to === "closed") {
            breaker.openUntil = 0;
            breaker.recentThrottleStamps = [];
            breaker.halfOpenInflight = false;
        }
        if (to !== "half_open") {
            breaker.halfOpenInflight = false;
        }
        const transition = {
            timestamp: new Date().toISOString(),
            subscriptionId: sub,
            family,
            from,
            to,
            reason,
        };
        for (const sink of this._sinks) {
            try {
                sink.pushTransition(transition);
            }
            catch (_a) {
                /* sink errors are isolated */
            }
        }
        this._publishStatus(sub, family);
    }
    _publishStatus(sub, family) {
        if (this._sinks.size === 0)
            return;
        const snap = this._snapshot(sub, family);
        for (const sink of this._sinks) {
            try {
                sink.setEntry(sub, family, snap);
            }
            catch (_a) {
                /* sink errors are isolated */
            }
        }
    }
    _emitCritical(message) {
        var _a;
        for (const sink of this._sinks) {
            try {
                (_a = sink.critical) === null || _a === void 0 ? void 0 : _a.call(sink, message);
            }
            catch (_b) {
                /* sink errors are isolated */
            }
        }
    }
    /**
     * Read x-ms-ratelimit-remaining-* headers from the response and adapt
     * the token bucket's refill rate preemptively. The smallest visible
     * budget wins (Azure publishes multiple, scoped at sub/tenant/resource).
     *
     * Effect:
     *   - budget > recovery threshold (1500): walk refill back toward baseline
     *   - budget in [soft_floor, recovery): leave refill alone
     *   - budget in [hard_floor, soft_floor): scale refill linearly to a
     *     floor of ~25% of baseline
     *   - budget < hard_floor: clamp refill to MIN_REFILL_PER_SEC and pause
     *     the bucket for 5s so the next request has to wait
     *
     * Special-case: Azure Resource Graph publishes its quota under a
     * different header (`x-ms-user-quota-remaining`, range 0..15-ish). We
     * normalize it onto the same scale as ARM's budget by treating the
     * ARG-specific floor of 3 as the equivalent of the ARM HARD_FLOOR (50),
     * scaling linearly. That way an ARG 429 surfaces in the same circuit
     * pathway as ARM throttles without ARG calls leaking through unchecked.
     *
     * This only TIGHTENS the bucket — the existing 429 path can still cut
     * harder if Azure sends a lower budget in a Retry-After response.
     */
    _applyBudgetSignal(sub, family, headers, bucket) {
        let smallest = Number.POSITIVE_INFINITY;
        for (const h of BUDGET_HEADERS) {
            const v = headers.get(h);
            if (v === null || v === "")
                continue;
            const n = Number(v);
            if (!Number.isFinite(n))
                continue;
            if (n < smallest)
                smallest = n;
        }
        // ARG-specific header. ARG's budget is 15-queries-per-5-seconds, so
        // we rescale to the same numeric range as ARM headers. 3 → 50 (the
        // hard-floor threshold), 15 → 250 (just above soft-floor). Below 3
        // we map to the hard floor so the bucket stalls.
        const argRemainingRaw = headers.get("x-ms-user-quota-remaining");
        if (argRemainingRaw !== null && argRemainingRaw !== "") {
            const argN = Number(argRemainingRaw);
            if (Number.isFinite(argN)) {
                const normalized = argN <= 0
                    ? BUDGET_HARD_FLOOR - 1
                    : Math.max(BUDGET_HARD_FLOOR, Math.floor((argN / 15) * 250));
                if (normalized < smallest)
                    smallest = normalized;
            }
        }
        if (!Number.isFinite(smallest))
            return; // no budget header present
        const baseline = bucket.baselineRefillPerSec;
        const now = Date.now();
        if (smallest >= BUDGET_RECOVERY_THRESHOLD) {
            // Plenty of budget — let recovery take over via _refill().
            // Mark a clean degrade timestamp so the next _refill walks us up.
            if (bucket.refillPerSec < baseline) {
                bucket.lastDegradeAt = now - RECOVERY_INTERVAL_MS;
            }
            this._publishStatus(sub, family);
            return;
        }
        if (smallest <= BUDGET_HARD_FLOOR) {
            // Very tight — clamp to floor and stall the bucket for 5s.
            bucket.refillPerSec = MIN_REFILL_PER_SEC;
            bucket.tokens = 0;
            bucket.lastRefillAt = now + 5000;
            bucket.lastDegradeAt = now;
            this._publishStatus(sub, family);
            return;
        }
        if (smallest < BUDGET_SOFT_FLOOR) {
            // Linear scale: at floor=50 we're at ~25% baseline; at 200 we're at baseline.
            const minRate = Math.max(MIN_REFILL_PER_SEC, Math.floor(baseline * 0.25));
            const range = BUDGET_SOFT_FLOOR - BUDGET_HARD_FLOOR;
            const ratio = (smallest - BUDGET_HARD_FLOOR) / range;
            const targetRate = Math.max(minRate, Math.floor(minRate + (baseline - minRate) * ratio));
            if (targetRate < bucket.refillPerSec) {
                bucket.refillPerSec = targetRate;
                bucket.lastDegradeAt = now;
                this._publishStatus(sub, family);
            }
        }
        // Between soft floor and recovery threshold: leave bucket alone.
    }
    _snapshot(sub, family) {
        const breaker = this._getBreaker(sub, family);
        const bucket = this._getBucket(sub, family);
        return {
            state: breaker.state,
            refillPerSec: bucket.refillPerSec,
            recentThrottles: breaker.recentThrottles,
            openUntil: breaker.state === "open"
                ? new Date(breaker.openUntil).toISOString()
                : undefined,
        };
    }
}
function makeKey(sub, family) {
    return `${sub}::${family}`;
}
/**
 * Generate or preserve an x-ms-client-request-id header on outbound calls.
 * Mutates a shallow-copied init object so we don't surprise the caller.
 *
 * Browser-safe note: User-Agent is a Forbidden Header per Fetch spec, so
 * we cannot set it from JS. We rely on Azure's existing browser-traffic
 * heuristics; injecting client-request-id is the one safe identifier we
 * can add here.
 */
function injectClientRequestId(init) {
    // Pull headers into a Headers instance for case-insensitive checks.
    const existing = new Headers(init === null || init === void 0 ? void 0 : init.headers);
    if (existing.has("x-ms-client-request-id")) {
        return init;
    }
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    existing.set("x-ms-client-request-id", id);
    // Also set return-client-request-id so the response echoes the id back.
    if (!existing.has("x-ms-return-client-request-id")) {
        existing.set("x-ms-return-client-request-id", "true");
    }
    return Object.assign(Object.assign({}, init), { headers: existing });
}
function parseKey(key) {
    const idx = key.indexOf("::");
    if (idx < 0)
        return { sub: key, family: "arm" };
    return {
        sub: key.substring(0, idx),
        family: key.substring(idx + 2),
    };
}
let _sharedGuard = null;
/** Singleton accessor used by the service-layer fetch wrapper. */
export function getSharedRequestGuard() {
    if (!_sharedGuard) {
        _sharedGuard = new RequestGuard();
    }
    return _sharedGuard;
}
function readRetryAfterMs(headers) {
    const value = headers.get("retry-after");
    if (!value)
        return null;
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) {
        return Math.max(0, Math.floor(asNumber * 1000));
    }
    const asDate = Date.parse(value);
    if (Number.isNaN(asDate))
        return null;
    return Math.max(0, asDate - Date.now());
}
/**
 * Replace the `Authorization: Bearer ...` header on a `RequestInit` with
 * a freshly minted token. Returns a new RequestInit; does not mutate
 * the caller's object.
 */
function replaceBearerToken(init, freshToken) {
    const headers = new Headers(init === null || init === void 0 ? void 0 : init.headers);
    headers.set("Authorization", `Bearer ${freshToken}`);
    return Object.assign(Object.assign({}, init), { headers });
}
/**
 * Issue exactly one underlying `fetch` and feed the response back to the
 * guard. Returns the raw Response; the caller decides what to do with
 * non-2xx (including CAE-recovery retry).
 */
function dispatchOne(guard, url, init, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        // Inject x-ms-client-request-id per call. Azure correlates a chain of
        // calls sharing the same id as one logical operation — both helps support
        // cases AND reduces "abuse heuristic" false positives because legitimate
        // clients ALWAYS set this; bots tend not to.
        //
        // Skip if the caller has already supplied one (some long-running
        // operation polls intentionally reuse the original op's id).
        const enrichedInit = injectClientRequestId(init);
        const response = yield fetch(url, enrichedInit);
        let bodyText = null;
        if (response.headers.get("x-ms-throttling-version") !== null) {
            bodyText = "";
        }
        else if (response.status === 429 || !response.ok) {
            try {
                bodyText = yield response.clone().text();
            }
            catch (_a) {
                bodyText = null;
            }
        }
        guard.observe(opts.subscriptionId, opts.family, {
            status: response.status,
            retryAfterMs: readRetryAfterMs(response.headers),
            headers: response.headers,
            bodyText,
        });
        return response;
    });
}
/**
 * Fetch wrapper that enforces the rate-limit + circuit-breaker decision
 * for outbound Azure API calls. A failure to acquire a token throws
 * `Error("Circuit open: ...")` BEFORE any network call is dispatched.
 *
 * Optional CAE recovery: when `opts.tokenProvider` is supplied AND the
 * response is a 401 with a `WWW-Authenticate: Bearer claims=...` header,
 * `guardedFetch` calls the provider with the decoded claims JSON, swaps
 * the bearer header on the request, and retries exactly once. See
 * `GuardedFetchOptions.tokenProvider` for the full contract.
 */
export function guardedFetch(url, init, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        const guard = getSharedRequestGuard();
        const release = yield guard.acquire(opts.subscriptionId, opts.family);
        try {
            const response = yield dispatchOne(guard, url, init, opts);
            // CAE recovery: if the caller supplied a token provider AND this is
            // a 401 with a `claims="..."` WWW-Authenticate challenge, decode
            // the claims, mint a fresh token via the provider, and retry the
            // request once. Other 401s (real expiry / missing role) bubble
            // through unchanged so the caller's existing handler kicks in.
            if (response.status === 401 && opts.tokenProvider) {
                const challenge = buildCaeChallengeError(response);
                if (challenge) {
                    const claimsJson = parseCaeChallenge(challenge.wwwAuthenticate);
                    if (claimsJson) {
                        const freshToken = yield opts.tokenProvider(claimsJson);
                        const retryInit = replaceBearerToken(init, freshToken);
                        return yield dispatchOne(guard, url, retryInit, opts);
                    }
                }
            }
            return response;
        }
        catch (err) {
            guard.observe(opts.subscriptionId, opts.family, {
                status: 0,
                retryAfterMs: null,
                headers: null,
                bodyText: null,
            });
            throw err;
        }
        finally {
            release();
        }
    });
}
//# sourceMappingURL=request-governance.js.map