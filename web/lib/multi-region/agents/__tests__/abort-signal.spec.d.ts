/**
 * Audit fix #1: AbortSignal plumbing.
 *
 *   - OrchestratorAgent.execute forwards the caller's signal to
 *     sub-agents that accept one.
 *   - PoolAgent.executeWithFallback honors `signal` and exits the
 *     resize-poll loop on abort instead of waiting up to the full
 *     15-second interval.
 *
 * These tests stay fast by mocking out the service calls and using a
 * tiny pollInterval via signal-driven shortcut.
 */
export {};
//# sourceMappingURL=abort-signal.spec.d.ts.map