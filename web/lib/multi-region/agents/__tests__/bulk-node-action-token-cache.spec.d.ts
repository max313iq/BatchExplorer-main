/**
 * Audit fix #4: bulk_node_action must use a per-subscription Batch
 * token cache (not the tenant-keyed one) so multi-account browsers
 * don't 401 on accounts owned by non-primary signed-in identities.
 *
 * The cache key surface isn't directly exposed, so this test exercises
 * the behavioral side: each unique subscription causes exactly one
 * call to `getBatchAccessTokenForSubscription`, and re-targeting the
 * same subscription a second time hits the cache (no extra call).
 */
export {};
//# sourceMappingURL=bulk-node-action-token-cache.spec.d.ts.map