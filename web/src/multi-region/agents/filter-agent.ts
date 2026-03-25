import { MultiRegionStore } from "../store/multi-region-store";
import { Agent, AgentResult, FilterInput, FilterOutput } from "./agent-types";

export class FilterAgent implements Agent {
    readonly name = "filter" as const;

    constructor(private readonly _store: MultiRegionStore) {}

    execute(params: Record<string, unknown>): Promise<AgentResult> {
        const input = params as unknown as FilterInput;
        const output = this.filter(input);
        return Promise.resolve({
            status: "completed",
            summary: output as unknown as Record<string, unknown>,
        });
    }

    cancel(): void {
        // No-op — filter is synchronous
    }

    filter(input: FilterInput): FilterOutput {
        const state = this._store.getState();
        const f = input.filters;

        let accounts = state.accounts;

        // Filter by regions
        if (f.regions && f.regions.length > 0) {
            const regionSet = new Set(f.regions.map((r) => r.toLowerCase()));
            accounts = accounts.filter((a) =>
                regionSet.has(a.region.toLowerCase())
            );
        }

        // Filter by subscriptions
        if (f.subscriptionIds && f.subscriptionIds.length > 0) {
            const subSet = new Set(f.subscriptionIds);
            accounts = accounts.filter((a) => subSet.has(a.subscriptionId));
        }

        // Filter by provisioning state
        if (f.provisioningState && f.provisioningState !== "all") {
            accounts = accounts.filter(
                (a) => a.provisioningState === f.provisioningState
            );
        }

        // Filter by explicit account IDs
        if (f.accountIds && f.accountIds.length > 0) {
            const idSet = new Set(f.accountIds);
            accounts = accounts.filter((a) => idSet.has(a.id));
        }

        // Enrich with quota and pool status
        const quotaByAccount = new Map<
            string,
            { status: string; limit?: number }
        >();
        for (const qr of state.quotaRequests) {
            const existing = quotaByAccount.get(qr.accountId);
            if (
                !existing ||
                qr.status === "approved" ||
                (qr.status === "submitted" && existing.status === "pending")
            ) {
                quotaByAccount.set(qr.accountId, {
                    status: qr.status,
                    limit: qr.requestedLimit,
                });
            }
        }

        const poolsByAccount = new Set<string>();
        for (const pool of state.pools) {
            if (pool.provisioningState === "created") {
                poolsByAccount.add(pool.accountId);
            }
        }

        // Filter by quota status
        if (f.quotaStatus && f.quotaStatus !== "all") {
            accounts = accounts.filter((a) => {
                const quota = quotaByAccount.get(a.id);
                if (f.quotaStatus === "none") {
                    return !quota;
                }
                return quota?.status === f.quotaStatus;
            });
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
            accounts: accounts.map((a) => {
                const quota = quotaByAccount.get(a.id);
                return {
                    accountId: a.id,
                    accountName: a.accountName,
                    region: a.region,
                    subscriptionId: a.subscriptionId,
                    quotaStatus: quota?.status ?? "none",
                    quotaLimit: quota?.limit,
                    hasPool: poolsByAccount.has(a.id),
                };
            }),
        };
    }
}
