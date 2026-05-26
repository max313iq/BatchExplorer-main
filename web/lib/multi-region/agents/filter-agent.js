export class FilterAgent {
    constructor(_store) {
        Object.defineProperty(this, "_store", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: _store
        });
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "filter"
        });
    }
    execute(params) {
        const input = params;
        const output = this.filter(input);
        return Promise.resolve({
            status: "completed",
            summary: output,
        });
    }
    cancel() {
        // No-op — filter is synchronous
    }
    filter(input) {
        const state = this._store.getState();
        const f = input.filters;
        let accounts = state.accounts;
        // Filter by regions
        if (f.regions && f.regions.length > 0) {
            const regionSet = new Set(f.regions.map((r) => r.toLowerCase()));
            accounts = accounts.filter((a) => regionSet.has(a.region.toLowerCase()));
        }
        // Filter by subscriptions
        if (f.subscriptionIds && f.subscriptionIds.length > 0) {
            const subSet = new Set(f.subscriptionIds);
            accounts = accounts.filter((a) => subSet.has(a.subscriptionId));
        }
        // Filter by provisioning state
        if (f.provisioningState && f.provisioningState !== "all") {
            accounts = accounts.filter((a) => a.provisioningState === f.provisioningState);
        }
        // Filter by explicit account IDs
        if (f.accountIds && f.accountIds.length > 0) {
            const idSet = new Set(f.accountIds);
            accounts = accounts.filter((a) => idSet.has(a.id));
        }
        const poolsByAccount = new Set();
        for (const pool of state.pools) {
            if (pool.provisioningState === "created") {
                poolsByAccount.add(pool.accountId);
            }
        }
        // Filter by hasPool
        if (f.hasPool !== undefined) {
            accounts = accounts.filter((a) => {
                const has = poolsByAccount.has(a.id);
                return f.hasPool ? has : !has;
            });
        }
        return {
            matchCount: accounts.length,
            accounts: accounts.map((a) => ({
                accountId: a.id,
                accountName: a.accountName,
                region: a.region,
                subscriptionId: a.subscriptionId,
                hasPool: poolsByAccount.has(a.id),
            })),
        };
    }
}
//# sourceMappingURL=filter-agent.js.map