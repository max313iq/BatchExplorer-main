import { __awaiter } from "tslib";
/**
 * Session-lifetime cache + in-flight deduplication for EA billing-capability
 * probes. Without this, every sidebar render and every navigation to the EA
 * Subscription page re-probes every signed-in account — which is O(N) ARM
 * round-trips (plus MSAL token acquisitions) on each mount and dominates the
 * "Probing EA billing capability" wait time when many accounts are signed in.
 *
 * The cache is keyed by `homeAccountId|tenantId`. Successful probes are
 * memoised for {@link TTL_MS}; token-acquisition failures are NOT cached so a
 * transient MSAL error doesn't lock a user out of the EA picker.
 */
import { getArmTokenForAccount } from "../auth/msal-auth";
import { probeEaCapability } from "./arm-service";
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const inflight = new Map();
const EMPTY_CAP = { hasEa: false, billingAccountCount: 0 };
function makeKey(homeAccountId, tenantId) {
    return `${homeAccountId}|${tenantId}`;
}
/**
 * Non-async lookup into the cache. Returns undefined if missing or expired.
 * Lets the UI render whatever the sidebar (or a previous visit) already
 * resolved before kicking off a fresh background probe.
 */
export function peekEaCapability(homeAccountId, tenantId) {
    const key = makeKey(homeAccountId, tenantId);
    const entry = cache.get(key);
    if (!entry)
        return undefined;
    if (entry.expiresAt < Date.now()) {
        cache.delete(key);
        return undefined;
    }
    return entry.cap;
}
/**
 * Resolve EA capability for an account, deduping concurrent callers and
 * memoising the result for {@link TTL_MS}. Token-acquisition errors fall
 * back to an empty capability but are NOT cached.
 */
export function getEaCapabilityCached(homeAccountId, tenantId) {
    return __awaiter(this, void 0, void 0, function* () {
        const key = makeKey(homeAccountId, tenantId);
        const cached = peekEaCapability(homeAccountId, tenantId);
        if (cached)
            return cached;
        const existing = inflight.get(key);
        if (existing)
            return existing;
        const promise = (() => __awaiter(this, void 0, void 0, function* () {
            try {
                const token = yield getArmTokenForAccount(homeAccountId, tenantId);
                const cap = yield probeEaCapability(token);
                cache.set(key, { cap, expiresAt: Date.now() + TTL_MS });
                return cap;
            }
            catch (_a) {
                return EMPTY_CAP;
            }
            finally {
                inflight.delete(key);
            }
        }))();
        inflight.set(key, promise);
        return promise;
    });
}
/**
 * Drop cached entries for an account (any tenant) or for the whole session.
 * Call after an action that could plausibly change EA membership (e.g. role
 * assignment) — none today, but exported for future callers.
 */
export function invalidateEaCapability(homeAccountId) {
    if (homeAccountId === undefined) {
        cache.clear();
        return;
    }
    const prefix = `${homeAccountId}|`;
    for (const key of Array.from(cache.keys())) {
        if (key.startsWith(prefix))
            cache.delete(key);
    }
}
//# sourceMappingURL=ea-capability-cache.js.map