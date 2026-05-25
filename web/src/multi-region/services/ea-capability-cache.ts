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
import type { EaCapability } from "./types";

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  cap: EaCapability;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<EaCapability>>();

const EMPTY_CAP: EaCapability = { hasEa: false, billingAccountCount: 0 };

function makeKey(homeAccountId: string, tenantId: string): string {
  return `${homeAccountId}|${tenantId}`;
}

/**
 * Non-async lookup into the cache. Returns undefined if missing or expired.
 * Lets the UI render whatever the sidebar (or a previous visit) already
 * resolved before kicking off a fresh background probe.
 */
export function peekEaCapability(
  homeAccountId: string,
  tenantId: string,
): EaCapability | undefined {
  const key = makeKey(homeAccountId, tenantId);
  const entry = cache.get(key);
  if (!entry) return undefined;
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
export async function getEaCapabilityCached(
  homeAccountId: string,
  tenantId: string,
): Promise<EaCapability> {
  const key = makeKey(homeAccountId, tenantId);

  const cached = peekEaCapability(homeAccountId, tenantId);
  if (cached) return cached;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const token = await getArmTokenForAccount(homeAccountId, tenantId);
      const cap = await probeEaCapability(token);
      cache.set(key, { cap, expiresAt: Date.now() + TTL_MS });
      return cap;
    } catch {
      return EMPTY_CAP;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Drop cached entries for an account (any tenant) or for the whole session.
 * Call after an action that could plausibly change EA membership (e.g. role
 * assignment) — none today, but exported for future callers.
 */
export function invalidateEaCapability(homeAccountId?: string): void {
  if (homeAccountId === undefined) {
    cache.clear();
    return;
  }
  const prefix = `${homeAccountId}|`;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
