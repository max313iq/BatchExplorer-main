/**
 * Unit tests for PoolAgent.
 *
 * The agent exposes two actions: `execute` (basic pool creation across
 * accounts) and `executeWithFallback` (smart pool creation with VM-size
 * waterfall fallback). Both call into batch-service.createPool / listPools
 * and emit state mutations onto MultiRegionStore — so we mock the service
 * layer and assert on store state + return summaries.
 */
export {};
//# sourceMappingURL=pool-agent.test.d.ts.map