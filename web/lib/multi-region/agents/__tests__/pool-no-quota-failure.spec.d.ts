/**
 * Audit fix #5: PoolAgent.executeWithFallback's no-quota early-return
 * used to produce `status:"failed"` with an empty `failures[]`,
 * which caused the orchestrator to surface a generic "Pool creation
 * failed" notification. The fix populates `failures[]` with a
 * descriptive `kind:"no_quota"` entry per account.
 */
export {};
//# sourceMappingURL=pool-no-quota-failure.spec.d.ts.map