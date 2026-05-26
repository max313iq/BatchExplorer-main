/**
 * Audit fix #19: idempotency-key handling in `PoolAgent.execute`.
 * Same key → same derived pool name across retries; missing key →
 * legacy random behavior (poolId === caller's config.id ?? "pool").
 */
export {};
//# sourceMappingURL=idempotency-key.spec.d.ts.map