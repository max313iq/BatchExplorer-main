/**
 * Persistent blacklist of (vmSize, region) tuples that are permanently
 * non-viable on this tenant — typically SKU-not-available or
 * region-not-allowed errors. Smart-mode pool creation skips blacklisted
 * combos so we don't waste retry budget on combinations that will never
 * succeed.
 *
 * Storage: localStorage["mr.failure-blacklist.v1"]. Falls back to
 * in-memory only if storage is unavailable (e.g. Safari private mode).
 */
const STORAGE_KEY = "mr.failure-blacklist.v1";
const SCHEMA_VERSION = 1;
function key(vmSize, region) {
    return `${vmSize.toLowerCase()}::${region.toLowerCase()}`;
}
function safeGetStorage() {
    if (typeof window === "undefined")
        return null;
    try {
        const w = window;
        if (w.localStorage)
            return w.localStorage;
    }
    catch (_a) {
        // SecurityError when storage is disabled
    }
    return null;
}
function loadFromStorage() {
    const map = new Map();
    const storage = safeGetStorage();
    if (!storage)
        return map;
    try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw)
            return map;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION)
            return map;
        if (!Array.isArray(parsed.entries))
            return map;
        for (const e of parsed.entries) {
            if (e &&
                typeof e.vmSize === "string" &&
                typeof e.region === "string" &&
                typeof e.reason === "string") {
                map.set(key(e.vmSize, e.region), {
                    vmSize: e.vmSize,
                    region: e.region,
                    reason: e.reason,
                    addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString(),
                    lastSeenAt: typeof e.lastSeenAt === "string" ? e.lastSeenAt : undefined,
                    hits: typeof e.hits === "number" ? e.hits : 0,
                });
            }
        }
    }
    catch (_a) {
        // Corrupt JSON — drop it. Caller will rewrite on next mutate.
    }
    return map;
}
function persist(map) {
    const storage = safeGetStorage();
    if (!storage)
        return;
    try {
        const payload = {
            schemaVersion: SCHEMA_VERSION,
            entries: Array.from(map.values()),
        };
        storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
    catch (_a) {
        // QuotaExceeded — the blacklist is small enough that this should never
        // happen, but if it does we just drop the persist; in-memory state is
        // still authoritative for the current session.
    }
}
let _cache = null;
function getCache() {
    if (_cache === null)
        _cache = loadFromStorage();
    return _cache;
}
export function isBlacklisted(vmSize, region) {
    const map = getCache();
    const entry = map.get(key(vmSize, region));
    if (!entry)
        return { blocked: false };
    return { blocked: true, reason: entry.reason, entry };
}
export function addToBlacklist(vmSize, region, reason) {
    var _a;
    const map = getCache();
    const k = key(vmSize, region);
    const existing = map.get(k);
    const now = new Date().toISOString();
    const entry = existing
        ? Object.assign(Object.assign({}, existing), { reason: existing.reason || reason, lastSeenAt: now, hits: ((_a = existing.hits) !== null && _a !== void 0 ? _a : 0) + 1 }) : {
        vmSize,
        region,
        reason,
        addedAt: now,
        lastSeenAt: now,
        hits: 1,
    };
    map.set(k, entry);
    persist(map);
    return entry;
}
/**
 * Mark that a blacklisted combo was hit again during a run, for
 * diagnostic counters. Does not change the blacklist content otherwise.
 */
export function recordBlacklistHit(vmSize, region) {
    var _a;
    const map = getCache();
    const k = key(vmSize, region);
    const e = map.get(k);
    if (!e)
        return;
    e.lastSeenAt = new Date().toISOString();
    e.hits = ((_a = e.hits) !== null && _a !== void 0 ? _a : 0) + 1;
    persist(map);
}
export function removeFromBlacklist(vmSize, region) {
    const map = getCache();
    const removed = map.delete(key(vmSize, region));
    if (removed)
        persist(map);
    return removed;
}
export function listBlacklist() {
    return Array.from(getCache().values()).sort((a, b) => a.addedAt < b.addedAt ? 1 : -1);
}
export function clearBlacklist() {
    const map = getCache();
    map.clear();
    persist(map);
}
/**
 * Test-only — drop the in-memory cache so the next read reloads from
 * storage (or starts empty if storage was cleared).
 */
export function _resetBlacklistCacheForTest() {
    _cache = null;
}
//# sourceMappingURL=failure-blacklist.js.map