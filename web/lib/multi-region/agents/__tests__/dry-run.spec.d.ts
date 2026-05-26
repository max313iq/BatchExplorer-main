/**
 * Audit fix #20: dry-run mode. When `config.dryRun === true`, write-side
 * agents (PoolAgent + ProvisionerAgent) must compute the body, log a
 * `[dry-run]` line, and NOT call the real createPool / createBatchAccount.
 */
export {};
//# sourceMappingURL=dry-run.spec.d.ts.map