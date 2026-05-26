/**
 * Tests for ProvisionerAgent — covers the happy path, per-region rate limiting,
 * subscription validation gate, duplicate-skip logic, ARM error propagation,
 * post-PUT provisioningState verification, cancellation, and the various log
 * paths exercised by `_validateSubscription`.
 *
 * Strategy:
 *   - Mock `arm-service` module so `createResourceGroup` / `createBatchAccount`
 *     return controllable values without hitting the network.
 *   - Use a real `MultiRegionStore` and a real `RequestScheduler` (with zero
 *     delay + no retries so tests run instantly).
 *   - Stub the global `fetch` symbol used by `_validateSubscription`.
 *   - Replace the WRITE_RATE_LIMIT_MS pacing by mocking `setTimeout` so the
 *     500ms inter-write delay does not block the test runner.
 */
export {};
//# sourceMappingURL=provisioner-agent.test.d.ts.map