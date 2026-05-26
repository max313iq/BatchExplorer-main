import type { EaCapability } from "./types";
/**
 * Non-async lookup into the cache. Returns undefined if missing or expired.
 * Lets the UI render whatever the sidebar (or a previous visit) already
 * resolved before kicking off a fresh background probe.
 */
export declare function peekEaCapability(homeAccountId: string, tenantId: string): EaCapability | undefined;
/**
 * Resolve EA capability for an account, deduping concurrent callers and
 * memoising the result for {@link TTL_MS}. Token-acquisition errors fall
 * back to an empty capability but are NOT cached.
 */
export declare function getEaCapabilityCached(homeAccountId: string, tenantId: string): Promise<EaCapability>;
/**
 * Drop cached entries for an account (any tenant) or for the whole session.
 * Call after an action that could plausibly change EA membership (e.g. role
 * assignment) — none today, but exported for future callers.
 */
export declare function invalidateEaCapability(homeAccountId?: string): void;
//# sourceMappingURL=ea-capability-cache.d.ts.map