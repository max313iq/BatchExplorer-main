import { __awaiter } from "tslib";
/**
 * Quota & VM-SKU availability service for Batch.
 *
 * Why this exists:
 *   Two of the easiest ways to attract Azure abuse-flag attention are
 *   (a) trying to create resources beyond the per-(sub, region) quota,
 *   and (b) trying to create resources with VM SKUs not supported in
 *   the chosen region. Both produce loud, deterministic failures —
 *   exactly the pattern Azure's anti-abuse heuristics treat as bot
 *   activity. This service makes the orchestrator KNOW the answers
 *   before issuing the requests.
 *
 * What it provides:
 *   1. `getBatchAccountQuota(subId, region, token)` — per-region Batch
 *      account quota and how much of it is in use right now.
 *   2. `listBatchSupportedVmSkus(subId, region, token)` — every VM SKU
 *      the Batch service will accept in that region (Microsoft.Batch
 *      maintains a different supported-list than Microsoft.Compute).
 *   3. `listAllVmSkus(subId, token)` — every Azure VM SKU the
 *      subscription has access to, with per-region restrictions
 *      surfaced. Drives the "pick any VM" picker.
 *
 * TTL cache: every result is cached in-memory for 15 minutes. These
 * endpoints publish near-static data (quota changes via support ticket,
 * VM availability changes weekly). Re-querying every operation is pure
 * waste — and waste is what gets us throttled.
 */
import { guardedFetch } from "../scheduling/request-governance";
import { abortError } from "./abort-helpers";
import { fetchAllPages as sharedFetchAllPages } from "./_shared/paginate";
import { classifyHttpError } from "./types";
const ARM_BASE = "https://management.azure.com";
// Microsoft.Batch quotas: 2024-07-01 returns location-scoped accountQuota.
const BATCH_QUOTA_API = "2024-07-01";
// Microsoft.Batch/locations/{loc}/virtualMachineSkus: same API.
const BATCH_VM_SKUS_API = "2024-07-01";
// Microsoft.Compute/skus — broad subscription-level listing.
const COMPUTE_SKUS_API = "2024-07-01";
/**
 * Default TTL for "live-ish" data: quotas and Batch SKUs. They DO change
 * (quota bumps, region rollouts) so 15 minutes keeps the cache from
 * masking real shifts.
 */
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
/**
 * VM-catalog TTL: the Microsoft.Compute/skus endpoint changes on a
 * weekly cadence. A 7-day TTL means the catalog populates once on first
 * sign-in, persists across browser reloads, and only re-fetches once
 * a week — exactly the behavior the operator asked for. Per-subscription
 * cache entries are typed as `computeskus::*` so this constant only
 * applies to that prefix; everything else uses CACHE_TTL_MS.
 */
const COMPUTE_SKUS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STORAGE_KEY = "mr.quota-service-cache.v1";
const STORAGE_SCHEMA_VERSION = 1;
const _cache = new Map();
const _listeners = new Set();
let _hydrated = false;
let _persistTimer = null;
/**
 * Maximum number of cache entries. Above this we evict in LRU order on
 * every set. Tuned at 500 — generous enough to hold every (sub, region,
 * tenant) the operator routinely touches, well below the JS-engine heap
 * footprint at which the Map starts to slow down (~50k entries).
 *
 * Background: the previous unbounded cache could swell to tens of MB
 * when a long session walked every region of every subscription
 * (operator sweeping for VM availability). The localStorage layer
 * tolerated the bloat because of QUOTA_EXCEEDED back-off, but the
 * in-memory Map kept growing — the LRU cap bounds working-set memory
 * while preserving the hit rate for hot keys.
 */
const CACHE_MAX_ENTRIES = 500;
/**
 * Subscribe to cache changes. Listeners receive the cache key that
 * changed so they can selectively re-render. The pub/sub keeps the
 * VM Catalog page reactive without polling: when a background refresh
 * lands, the page sees the new data immediately.
 */
export function subscribeQuotaCache(listener) {
    _listeners.add(listener);
    return () => {
        _listeners.delete(listener);
    };
}
function notify(key) {
    for (const l of Array.from(_listeners)) {
        try {
            l(key);
        }
        catch (_a) {
            /**/
        }
    }
}
function hydrateFromStorage() {
    var _a;
    if (_hydrated)
        return;
    _hydrated = true;
    if (typeof window === "undefined")
        return;
    try {
        const raw = (_a = window.localStorage) === null || _a === void 0 ? void 0 : _a.getItem(STORAGE_KEY);
        if (!raw)
            return;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.schemaVersion !== STORAGE_SCHEMA_VERSION)
            return;
        if (!parsed.entries || typeof parsed.entries !== "object")
            return;
        const now = Date.now();
        for (const [k, entry] of Object.entries(parsed.entries)) {
            if (entry &&
                typeof entry === "object" &&
                typeof entry.expiresAt === "number" &&
                entry.expiresAt > now) {
                _cache.set(k, entry);
            }
        }
    }
    catch (_b) {
        /* corrupt entry — start with an empty cache */
    }
}
// Disk-cache key. The dev-server writes this to
// `web/dev-server/.disk-cache/quota-service-cache.json`. Project-file
// scoped — survives every browser restart and is shared across all
// browsers hitting this dev-server. Used as a fallback layer beneath
// localStorage so large VM-catalog snapshots (~10 MB) don't get
// silently evicted by browser quota limits and don't need to be
// re-fetched from ARM on every cold start.
const DISK_CACHE_KEY = "quota-service-cache";
let _diskPullPromise = null;
/**
 * Pull the disk-cache snapshot into the in-memory cache. Idempotent —
 * subsequent calls return the in-flight Promise. The localStorage layer
 * is preferred when present (it's hot); disk only fills the gap when
 * localStorage was wiped or never populated (cross-browser, post-quota
 * eviction, dev-server restart with empty browser, etc.).
 */
export function ensureDiskHydrated() {
    if (typeof window === "undefined")
        return Promise.resolve();
    if (_diskPullPromise)
        return _diskPullPromise;
    _diskPullPromise = (() => __awaiter(this, void 0, void 0, function* () {
        hydrateFromStorage();
        try {
            const resp = yield fetch(`/api/cache/disk/${DISK_CACHE_KEY}`, {
                method: "GET",
                headers: { Accept: "application/json" },
            });
            if (!resp.ok)
                return;
            const parsed = (yield resp.json());
            if (!parsed || parsed.schemaVersion !== STORAGE_SCHEMA_VERSION)
                return;
            if (!parsed.entries || typeof parsed.entries !== "object")
                return;
            const now = Date.now();
            let added = 0;
            for (const [k, entry] of Object.entries(parsed.entries)) {
                if (!entry ||
                    typeof entry !== "object" ||
                    typeof entry.expiresAt !== "number" ||
                    entry.expiresAt <= now) {
                    continue;
                }
                if (!_cache.has(k)) {
                    _cache.set(k, entry);
                    added += 1;
                }
            }
            if (added > 0) {
                notify("*");
            }
        }
        catch (_a) {
            /* dev-server offline or disk cache missing — silent degrade */
        }
    }))();
    return _diskPullPromise;
}
/**
 * Debounced disk write. Multiple sets within 800ms coalesce into one
 * JSON.stringify + localStorage.setItem so a flurry of pagination updates
 * doesn't thrash the storage subsystem. Also mirrors the same payload
 * to the dev-server's disk cache so the next cold start can hydrate
 * from disk even if localStorage was evicted.
 */
function schedulePersist() {
    if (typeof window === "undefined")
        return;
    if (_persistTimer)
        return;
    _persistTimer = setTimeout(() => {
        var _a;
        _persistTimer = null;
        let payloadJson = null;
        try {
            const now = Date.now();
            const entries = {};
            for (const [k, v] of _cache.entries()) {
                if (v.expiresAt > now)
                    entries[k] = v;
            }
            const payload = {
                schemaVersion: STORAGE_SCHEMA_VERSION,
                entries,
            };
            payloadJson = JSON.stringify(payload);
            (_a = window.localStorage) === null || _a === void 0 ? void 0 : _a.setItem(STORAGE_KEY, payloadJson);
        }
        catch (_b) {
            /* QuotaExceededError or storage disabled — silent degrade.
             * Still try the dev-server mirror below: the disk cache has no
             * quota limit and may be the only viable persistence path. */
        }
        // Mirror to dev-server disk. Fire-and-forget — the page already
        // got its localStorage write (if available), so this is purely
        // backup for the next cold start. Offline-tolerant.
        if (payloadJson != null) {
            void fetch(`/api/cache/disk/${DISK_CACHE_KEY}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: payloadJson,
            }).catch(() => {
                /* dev-server unreachable — local cache still works */
            });
        }
    }, 800);
}
function cacheGet(key) {
    hydrateFromStorage();
    const hit = _cache.get(key);
    if (!hit)
        return null;
    if (Date.now() > hit.expiresAt) {
        _cache.delete(key);
        schedulePersist();
        return null;
    }
    // LRU touch: delete + re-insert moves the entry to the Map's tail
    // (Map preserves insertion order), so when we evict, we drop the
    // genuine least-recently-used entries from the head.
    _cache.delete(key);
    _cache.set(key, hit);
    return hit.value;
}
/**
 * Inspect the cache without consuming the value. Returns the entry's
 * fetch timestamp + freshness even when the entry is stale (callers can
 * use stale data while a background refresh runs — the UI shows
 * "refreshed N days ago, refreshing…").
 */
export function cachePeek(key) {
    hydrateFromStorage();
    const hit = _cache.get(key);
    if (!hit)
        return null;
    return {
        value: hit.value,
        expiresAt: hit.expiresAt,
        // We didn't store fetchedAt explicitly. Reconstruct: the only TTLs we
        // use are CACHE_TTL_MS and COMPUTE_SKUS_TTL_MS — pick the shorter
        // distance from now and treat that as the fetch time. Approximate
        // but only ever wrong by less than the TTL, which is fine for "X
        // hours ago" display.
        fetchedAt: Math.min(hit.expiresAt - CACHE_TTL_MS, hit.expiresAt - COMPUTE_SKUS_TTL_MS),
    };
}
function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
    // Re-insert at the tail (newest) — same trick as cacheGet's LRU touch.
    _cache.delete(key);
    _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    // Evict from the head until we're back under the cap. Map iteration
    // is insertion-order, so the first keys are the oldest.
    while (_cache.size > CACHE_MAX_ENTRIES) {
        const oldestKey = _cache.keys().next().value;
        if (oldestKey === undefined)
            break;
        _cache.delete(oldestKey);
    }
    schedulePersist();
    notify(key);
}
/** Force-clear cached entries. Useful after a known mutation (e.g. account created). */
export function invalidateQuotaCache(subId, region) {
    hydrateFromStorage();
    let touched = false;
    if (!subId && !region) {
        if (_cache.size > 0) {
            _cache.clear();
            touched = true;
        }
    }
    else {
        for (const key of Array.from(_cache.keys())) {
            if (subId && !key.includes(subId))
                continue;
            if (region && !key.toLowerCase().includes(region.toLowerCase()))
                continue;
            _cache.delete(key);
            touched = true;
        }
    }
    if (touched) {
        schedulePersist();
        notify("*");
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateSubscriptionId(subscriptionId) {
    if (!UUID_REGEX.test(subscriptionId)) {
        throw new Error("Invalid subscriptionId format: must be a valid UUID.");
    }
}
function armHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
    };
}
function armGet(url, token, subscriptionId, signal) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
            throw abortError();
        }
        const resp = yield guardedFetch(url, { headers: armHeaders(token), signal }, { subscriptionId, family: "arm" });
        if (!resp.ok) {
            let errBody = {};
            try {
                errBody = (yield resp.json());
            }
            catch (_d) {
                /**/
            }
            const inner = (_a = errBody === null || errBody === void 0 ? void 0 : errBody.error) !== null && _a !== void 0 ? _a : {};
            const rawMessage = (_b = inner.message) !== null && _b !== void 0 ? _b : `ARM request failed: ${resp.status} ${resp.statusText}`;
            // Compose with URL path so audit log lines distinguish quota probes
            // from VM-SKU catalog probes at a glance.
            const urlPath = (() => {
                try {
                    return new URL(resp.url).pathname;
                }
                catch (_a) {
                    return undefined;
                }
            })();
            const displayMessage = urlPath
                ? `${resp.status} ${urlPath}: ${rawMessage}`
                : rawMessage;
            const retryAfterHeader = resp.headers.get("Retry-After");
            const err = classifyHttpError(displayMessage, resp.status, (_c = inner.code) !== null && _c !== void 0 ? _c : "ArmRequestFailed", errBody, retryAfterHeader);
            if (urlPath)
                err.urlPath = urlPath;
            const innerDetails = inner.details;
            if (Array.isArray(innerDetails) && innerDetails.length > 0) {
                err.details = innerDetails.slice(0, 20).map((d) => ({
                    code: d.code,
                    message: d.message,
                }));
            }
            throw err;
        }
        return (yield resp.json());
    });
}
function armGetPaginated(initialUrl, token, subscriptionId, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        return sharedFetchAllPages({
            initialUrl,
            nextLinkPath: (page) => page.nextLink,
            signal: opts === null || opts === void 0 ? void 0 : opts.signal,
            onPage: opts === null || opts === void 0 ? void 0 : opts.onPage,
            fetcher: (url, sig) => armGet(url, token, subscriptionId, sig),
        });
    });
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Quota for Batch *accounts* in a single (sub, region) pair, plus the
 * count of accounts currently provisioned there.
 *
 * Endpoint:
 *   GET /subscriptions/{sub}/providers/Microsoft.Batch/locations/{loc}
 *       /quotas?api-version=2024-07-01
 *   GET /subscriptions/{sub}/providers/Microsoft.Batch/batchAccounts
 *       ?api-version=2024-07-01
 *
 * The current-count number is computed locally by listing accounts and
 * filtering on the location field. Cached together so a series of
 * "can I create here?" probes don't re-list the universe each time.
 */
export function getBatchAccountQuota(subscriptionId, region, token, opts) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        // Tenant scope: two operators on different tenants can (rarely) share
        // the same subscription id in their visible scope (cross-tenant lens,
        // sub-mover in flight, etc.). Without `tenantId` in the key the
        // second operator clobbers the first one's cache and reads stale data.
        // Callers that don't supply tenantId get a synthetic placeholder so
        // existing call sites keep working unchanged.
        const tenantSegment = (_a = opts === null || opts === void 0 ? void 0 : opts.tenantId) !== null && _a !== void 0 ? _a : "_notenant_";
        const cacheKey = `batchquota::${tenantSegment}::${subscriptionId}::${region.toLowerCase()}`;
        const cached = cacheGet(cacheKey);
        if (cached)
            return cached;
        const quotaUrl = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/providers/Microsoft.Batch/locations/${encodeURIComponent(region)}` +
            `/quotas?api-version=${BATCH_QUOTA_API}`;
        const listUrl = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/providers/Microsoft.Batch/batchAccounts?api-version=${BATCH_QUOTA_API}`;
        // Fire both in parallel — independent reads, both cached for 15min.
        const [quota, accounts] = yield Promise.all([
            armGet(quotaUrl, token, subscriptionId),
            armGetPaginated(listUrl, token, subscriptionId),
        ]);
        const accountQuota = typeof quota.accountQuota === "number"
            ? quota.accountQuota
            // Default Batch quota in most subs is 1 per region; bump only via
            // support ticket. If Azure ever drops the field we fail safe at 1.
            : 1;
        const currentCount = accounts.filter((a) => { var _a; return ((_a = a.location) !== null && _a !== void 0 ? _a : "").toLowerCase() === region.toLowerCase(); }).length;
        const info = {
            accountQuota,
            currentCount,
            available: accountQuota - currentCount,
            fetchedAt: new Date().toISOString(),
        };
        cacheSet(cacheKey, info);
        return info;
    });
}
/**
 * Every VM SKU the Batch service will accept for a pool in this region.
 * Distinct from Microsoft.Compute SKUs — Batch maintains its own
 * supported list which lags behind general VM availability.
 *
 * Endpoint:
 *   GET /subscriptions/{sub}/providers/Microsoft.Batch/locations/{loc}
 *       /virtualMachineSkus?api-version=2024-07-01
 */
export function listBatchSupportedVmSkus(subscriptionId, region, token, opts) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        const tenantSegment = (_a = opts === null || opts === void 0 ? void 0 : opts.tenantId) !== null && _a !== void 0 ? _a : "_notenant_";
        const cacheKey = `batchskus::${tenantSegment}::${subscriptionId}::${region.toLowerCase()}`;
        const cached = cacheGet(cacheKey);
        if (cached)
            return cached;
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/providers/Microsoft.Batch/locations/${encodeURIComponent(region)}` +
            `/virtualMachineSkus?api-version=${BATCH_VM_SKUS_API}`;
        const items = yield armGetPaginated(url, token, subscriptionId);
        const skus = items
            .filter((s) => Boolean(s.name))
            .map((s) => {
            var _a, _b;
            return ({
                name: s.name,
                familyName: (_a = s.familyName) !== null && _a !== void 0 ? _a : "",
                capabilities: Object.fromEntries(((_b = s.capabilities) !== null && _b !== void 0 ? _b : [])
                    .filter((c) => typeof c.name === "string" && typeof c.value === "string")
                    .map((c) => [c.name, c.value])),
            });
        });
        cacheSet(cacheKey, skus);
        return skus;
    });
}
/**
 * Cheap predicate: is `vmSize` accepted by Batch in `region`?
 * Wraps `listBatchSupportedVmSkus` so callers don't have to reason about
 * case-sensitivity themselves (Azure mixes Standard_NC24s_v3 with
 * standard_nc24s_v3 across endpoints).
 */
export function isVmSupportedByBatchInRegion(subscriptionId, region, vmSize, token) {
    return __awaiter(this, void 0, void 0, function* () {
        const skus = yield listBatchSupportedVmSkus(subscriptionId, region, token);
        const target = vmSize.toLowerCase();
        return skus.some((s) => s.name.toLowerCase() === target);
    });
}
function normalizeSku(s) {
    var _a, _b, _c, _d;
    if (!s.name || s.resourceType !== "virtualMachines")
        return null;
    return {
        name: s.name,
        resourceType: s.resourceType,
        locations: (_a = s.locations) !== null && _a !== void 0 ? _a : [],
        locationInfo: ((_b = s.locationInfo) !== null && _b !== void 0 ? _b : [])
            .filter((li) => typeof li.location === "string")
            .map((li) => ({ location: li.location, zones: li.zones })),
        restrictions: ((_c = s.restrictions) !== null && _c !== void 0 ? _c : []).map((r) => ({
            type: r.type,
            values: r.values,
            reasonCode: r.reasonCode,
        })),
        capabilities: Object.fromEntries(((_d = s.capabilities) !== null && _d !== void 0 ? _d : [])
            .filter((c) => typeof c.name === "string" && typeof c.value === "string")
            .map((c) => [c.name, c.value])),
        family: s.family,
        size: s.size,
        tier: s.tier,
    };
}
/**
 * GPU-family pattern. ND/NC/NV/NG are the four Azure VM families that
 * ship with accelerators (NVIDIA H100/A100/V100/T4/M60/K80, AMD V620,
 * AMD MI300X). Catches every Standard_(ND|NC|NV|NG)* SKU regardless of
 * generation.
 */
export const GPU_VM_NAME_RE = /^Standard_(ND|NC|NV|NG)/i;
/** Convenience: predicate version of the GPU family pattern. */
export function isGpuSkuName(skuName) {
    return GPU_VM_NAME_RE.test(skuName);
}
export function listAllVmSkus(subscriptionId, token, options) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        // Cache key includes a filter hash so a "GPU-only" cached entry doesn't
        // mask a later "all SKUs" caller. The hash is the function source so
        // identical predicates share one entry.
        const filterTag = (options === null || options === void 0 ? void 0 : options.filter)
            ? `f:${hashFn(options.filter)}`
            : "all";
        const tenantSegment = (_a = options === null || options === void 0 ? void 0 : options.tenantId) !== null && _a !== void 0 ? _a : "_notenant_";
        const cacheKey = `computeskus::${tenantSegment}::${subscriptionId}::${filterTag}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
            // Fire onPartial once with the cached set so consumers don't sit on an
            // empty list when they could be rendering immediately.
            (_b = options === null || options === void 0 ? void 0 : options.onPartial) === null || _b === void 0 ? void 0 : _b.call(options, cached, false);
            return cached;
        }
        // Per Microsoft.Compute REST spec, `$filter` only officially supports
        // `location eq '<region>'` — `resourceType eq 'virtualMachines'` works
        // in practice today but isn't contractually guaranteed
        // (https://learn.microsoft.com/rest/api/compute/resource-skus/list).
        // We drop the server-side filter and check `resourceType` client-side
        // inside `normalizeSku`. Slightly larger response bodies, but spec-correct
        // and removes a future-breakage risk if Azure tightens the contract.
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/providers/Microsoft.Compute/skus?api-version=${COMPUTE_SKUS_API}`;
        // Maintain a normalized + filtered accumulator so onPartial subscribers
        // never see CPU rows the caller asked us to drop.
        const normalized = [];
        yield armGetPaginated(url, token, subscriptionId, {
            signal: options === null || options === void 0 ? void 0 : options.signal,
            onPage: (chunk, _cumulative, hasMore) => {
                var _a;
                for (const r of chunk) {
                    const n = normalizeSku(r);
                    if (!n)
                        continue;
                    if ((options === null || options === void 0 ? void 0 : options.filter) && !options.filter(n))
                        continue;
                    normalized.push(n);
                }
                (_a = options === null || options === void 0 ? void 0 : options.onPartial) === null || _a === void 0 ? void 0 : _a.call(options, normalized.slice(), hasMore);
            },
        });
        // 7-day TTL — Compute/skus changes weekly at most, and persisting to
        // localStorage means the next reload starts from cached rather than
        // refetching everything.
        cacheSet(cacheKey, normalized, COMPUTE_SKUS_TTL_MS);
        return normalized;
    });
}
/** Public stable cache key for the VM-catalog entry, so other modules
 * (e.g. the UI's cachePeek inspection) can read the same key the
 * loader writes. The arguments mirror `listAllVmSkus`'s scoping:
 * the subscription, whether the GPU-only filter is in play, and the
 * tenant scope (defaults to `"_notenant_"` for back-compat with
 * callers that don't carry tenant ids). */
export function vmSkusCacheKey(subscriptionId, gpuOnly, tenantId) {
    const filterTag = gpuOnly
        ? `f:${hashFn(GPU_ONLY_FILTER_FOR_HASH)}`
        : "all";
    const tenantSegment = tenantId !== null && tenantId !== void 0 ? tenantId : "_notenant_";
    return `computeskus::${tenantSegment}::${subscriptionId}::${filterTag}`;
}
// Module-level identical predicate used to compute the cache key. Kept
// here so vmSkusCacheKey() and listAllVmSkus() agree on the hash even
// when the loader is invoked from different call sites (page mount vs.
// background prefetch).
const GPU_ONLY_FILTER_FOR_HASH = (sku) => isGpuSkuName(sku.name);
/**
 * Cheap fingerprint for a predicate. We can't intern arbitrary functions,
 * but `Function#toString()` is stable per source so callers using the
 * same imported predicate (e.g. a top-level GPU-only filter) hit the
 * same cache entry across mounts.
 */
function hashFn(fn) {
    const src = fn.toString();
    let h = 0;
    for (let i = 0; i < src.length; i++) {
        h = (h * 31 + src.charCodeAt(i)) | 0;
    }
    return h.toString(36);
}
export function checkPoolCreatable(account, region, vmSize, slots, token, opts) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        if (!vmSize)
            return { ok: false, reason: "vmSize is required." };
        if (!region)
            return { ok: false, reason: "region is required." };
        // Check #1 — Batch supported list. Fail-open on probe error so a
        // 403 reading the quota endpoint doesn't block the create itself.
        try {
            const batchSkus = yield listBatchSupportedVmSkus(account.subscriptionId, region, token, { tenantId: account.tenantId, signal: opts === null || opts === void 0 ? void 0 : opts.signal });
            const target = vmSize.toLowerCase();
            const accepted = batchSkus.some((s) => s.name.toLowerCase() === target);
            if (!accepted) {
                return {
                    ok: false,
                    reason: `Batch does not support ${vmSize} in ${region}. Pick a different VM size or region.`,
                };
            }
        }
        catch (_b) {
            /* fall through: probe failed, attempt the create anyway */
        }
        // Check #2 — subscription-level VM availability + restrictions.
        try {
            const allSkus = yield listAllVmSkus(account.subscriptionId, token, {
                tenantId: account.tenantId,
                signal: opts === null || opts === void 0 ? void 0 : opts.signal,
            });
            const sku = allSkus.find((s) => s.name.toLowerCase() === vmSize.toLowerCase());
            if (sku) {
                const blockedHere = ((_a = sku.restrictions) !== null && _a !== void 0 ? _a : []).some((r) => {
                    if (r.type === "Location" && Array.isArray(r.values)) {
                        return r.values.some((v) => v.toLowerCase() === region.toLowerCase());
                    }
                    if (r.reasonCode === "NotAvailableForSubscription") {
                        return true;
                    }
                    return false;
                });
                if (blockedHere) {
                    return {
                        ok: false,
                        reason: `${vmSize} is blocked by a subscription restriction in ${region}. Request quota or pick a different region.`,
                    };
                }
            }
        }
        catch (_c) {
            /* fall through */
        }
        // Check #3 — slots sanity. Negative or zero slot counts mean the
        // caller didn't intend to actually allocate; let it through and
        // let Batch return its own (cheap) 4xx if anything is wrong.
        if (slots <= 0) {
            return { ok: true };
        }
        return { ok: true };
    });
}
/**
 * Resolve "where is this VM actually available?" — returns the regions
 * where the SKU appears in `locations` AND isn't blocked by a restriction.
 *
 * Useful for the picker's per-VM "supported regions" badge and for the
 * orchestrator's pre-flight when fanning out across regions.
 */
export function getRegionsSupportingVm(subscriptionId, vmSize, token) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const skus = yield listAllVmSkus(subscriptionId, token);
        const sku = skus.find((s) => s.name.toLowerCase() === vmSize.toLowerCase());
        if (!sku)
            return [];
        // Build the set of "blocked" locations from restrictions. Compute
        // restrictions of type=Location list affected regions in `values`.
        const blocked = new Set();
        for (const r of (_a = sku.restrictions) !== null && _a !== void 0 ? _a : []) {
            if (r.type === "Location" && Array.isArray(r.values)) {
                for (const v of r.values)
                    blocked.add(v.toLowerCase());
            }
        }
        return sku.locations
            .map((l) => l.toLowerCase())
            .filter((l) => !blocked.has(l));
    });
}
//# sourceMappingURL=quota-service.js.map