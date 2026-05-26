/**
 * Focused test for audit fix #2 — `WorkflowAgent.executeRefreshChain`
 * previously dispatched "refresh_pools" and "refresh_accounts" which
 * the orchestrator never knew about. They now hit the real actions
 * `refresh_pool_info` and `refresh_account_info`.
 */
export {};
//# sourceMappingURL=workflow-refresh-chain.spec.d.ts.map