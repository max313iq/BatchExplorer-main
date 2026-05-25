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

export interface BlacklistEntry {
  vmSize: string;
  region: string;
  reason: string;
  /** ISO timestamp of when the entry was added. */
  addedAt: string;
  /** Last time a smart-mode run hit a skip on this entry. */
  lastSeenAt?: string;
  /** How many times the skip has fired (for diagnostics). */
  hits?: number;
}

interface PersistedShape {
  schemaVersion: number;
  entries: BlacklistEntry[];
}

function key(vmSize: string, region: string): string {
  return `${vmSize.toLowerCase()}::${region.toLowerCase()}`;
}

function safeGetStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const w = window;
    if (w.localStorage) return w.localStorage;
  } catch {
    // SecurityError when storage is disabled
  }
  return null;
}

function loadFromStorage(): Map<string, BlacklistEntry> {
  const map = new Map<string, BlacklistEntry>();
  const storage = safeGetStorage();
  if (!storage) return map;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return map;
    if (!Array.isArray(parsed.entries)) return map;
    for (const e of parsed.entries) {
      if (
        e &&
        typeof e.vmSize === "string" &&
        typeof e.region === "string" &&
        typeof e.reason === "string"
      ) {
        map.set(key(e.vmSize, e.region), {
          vmSize: e.vmSize,
          region: e.region,
          reason: e.reason,
          addedAt:
            typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString(),
          lastSeenAt: typeof e.lastSeenAt === "string" ? e.lastSeenAt : undefined,
          hits: typeof e.hits === "number" ? e.hits : 0,
        });
      }
    }
  } catch {
    // Corrupt JSON — drop it. Caller will rewrite on next mutate.
  }
  return map;
}

function persist(map: Map<string, BlacklistEntry>): void {
  const storage = safeGetStorage();
  if (!storage) return;
  try {
    const payload: PersistedShape = {
      schemaVersion: SCHEMA_VERSION,
      entries: Array.from(map.values()),
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // QuotaExceeded — the blacklist is small enough that this should never
    // happen, but if it does we just drop the persist; in-memory state is
    // still authoritative for the current session.
  }
}

let _cache: Map<string, BlacklistEntry> | null = null;

function getCache(): Map<string, BlacklistEntry> {
  if (_cache === null) _cache = loadFromStorage();
  return _cache;
}

export function isBlacklisted(
  vmSize: string,
  region: string,
): { blocked: true; reason: string; entry: BlacklistEntry } | { blocked: false } {
  const map = getCache();
  const entry = map.get(key(vmSize, region));
  if (!entry) return { blocked: false };
  return { blocked: true, reason: entry.reason, entry };
}

export function addToBlacklist(
  vmSize: string,
  region: string,
  reason: string,
): BlacklistEntry {
  const map = getCache();
  const k = key(vmSize, region);
  const existing = map.get(k);
  const now = new Date().toISOString();
  const entry: BlacklistEntry = existing
    ? {
        ...existing,
        reason: existing.reason || reason,
        lastSeenAt: now,
        hits: (existing.hits ?? 0) + 1,
      }
    : {
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
export function recordBlacklistHit(vmSize: string, region: string): void {
  const map = getCache();
  const k = key(vmSize, region);
  const e = map.get(k);
  if (!e) return;
  e.lastSeenAt = new Date().toISOString();
  e.hits = (e.hits ?? 0) + 1;
  persist(map);
}

export function removeFromBlacklist(
  vmSize: string,
  region: string,
): boolean {
  const map = getCache();
  const removed = map.delete(key(vmSize, region));
  if (removed) persist(map);
  return removed;
}

export function listBlacklist(): BlacklistEntry[] {
  return Array.from(getCache().values()).sort((a, b) =>
    a.addedAt < b.addedAt ? 1 : -1,
  );
}

export function clearBlacklist(): void {
  const map = getCache();
  map.clear();
  persist(map);
}

/**
 * Test-only — drop the in-memory cache so the next read reloads from
 * storage (or starts empty if storage was cleared).
 */
export function _resetBlacklistCacheForTest(): void {
  _cache = null;
}
