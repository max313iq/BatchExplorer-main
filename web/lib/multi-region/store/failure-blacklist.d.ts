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
export declare function isBlacklisted(vmSize: string, region: string): {
    blocked: true;
    reason: string;
    entry: BlacklistEntry;
} | {
    blocked: false;
};
export declare function addToBlacklist(vmSize: string, region: string, reason: string): BlacklistEntry;
/**
 * Mark that a blacklisted combo was hit again during a run, for
 * diagnostic counters. Does not change the blacklist content otherwise.
 */
export declare function recordBlacklistHit(vmSize: string, region: string): void;
export declare function removeFromBlacklist(vmSize: string, region: string): boolean;
export declare function listBlacklist(): BlacklistEntry[];
export declare function clearBlacklist(): void;
/**
 * Test-only — drop the in-memory cache so the next read reloads from
 * storage (or starts empty if storage was cleared).
 */
export declare function _resetBlacklistCacheForTest(): void;
//# sourceMappingURL=failure-blacklist.d.ts.map