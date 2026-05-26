/**
 * Tenant-change cache invalidation.
 *
 * When the operator switches active tenant, every per-(sub, tenant)
 * cached value in the services layer needs to be dropped — the same
 * subscription id can resolve to different ARM responses depending on
 * which tenant's token signed the request, and stale quota / capability
 * data leaks across tenants if we don't flush.
 *
 * Pages / shell components observe the tenant change and call
 * `invalidateAllCachesForTenantChange(reason)`. This module is the one
 * place that knows about every service-layer cache, so adding a new
 * cache means appending one more invalidation call here — call sites
 * upstream don't have to learn the inventory.
 */
/**
 * Drop every service-layer cache. The `reason` is propagated to
 * console.info for forensics — when a stale cache is suspected, search
 * the dev-tools console for "tenant cache flush" to see who triggered
 * the most recent invalidation and why.
 *
 * Always synchronous — every backing cache uses an in-memory Map.
 */
export declare function invalidateAllCachesForTenantChange(reason: string): void;
//# sourceMappingURL=cache-invalidation.d.ts.map