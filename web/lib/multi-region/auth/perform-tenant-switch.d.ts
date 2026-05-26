import type { MultiRegionStore } from "../store/multi-region-store";
import type { AzureLoginAccount } from "../store/store-types";
import type { TenantInfo } from "../services/types";
export interface PerformTenantSwitchOptions {
    /**
     * Which UI entry point triggered the switch — written to the audit
     * log under `details.from`. Operators reading the log can correlate
     * a switch with the click that caused it.
     */
    source: "drawer" | "row" | "header-switcher" | "command-palette" | "external";
    /** Optional AbortSignal to cancel a slow `listSubscriptionsForAccount`. */
    signal?: AbortSignal;
    /**
     * Returns true when a newer concurrent switch has won and this one
     * should bail without writing to the store. Called after every
     * await point. Default: never stale.
     */
    isStale?: () => boolean;
    /** Optional callback when the switch succeeds. */
    onSuccess?: () => void;
}
export interface PerformTenantSwitchResult {
    /** True when a newer concurrent switch superseded this one. */
    stale: boolean;
    /** Subscriptions returned by the post-switch list (empty on failure). */
    subscriptionsLoaded: number;
}
/**
 * Resolve the active tenant id for an account across the three
 * sources of truth (override → msal-cached → home).
 */
export declare function resolveActiveTenantId(account: AzureLoginAccount): string | undefined;
/**
 * Find a human label for a tenantId in the account's tenant list,
 * falling back to a string fallback.
 */
export declare function findTenantLabel(tenants: TenantInfo[] | undefined, tenantId: string | undefined, fallback: string): string;
/**
 * Run a tenant switch end-to-end. See module docblock for the full
 * sequence. Returns `{ stale }` so the caller can decide whether to
 * clear its UI spinner — when `stale: true` a newer concurrent
 * switch has won and the caller should leave its busy state alone
 * (the newer call will clear it).
 */
export declare function performTenantSwitch(account: AzureLoginAccount, tenantId: string, store: MultiRegionStore, options: PerformTenantSwitchOptions): Promise<PerformTenantSwitchResult>;
//# sourceMappingURL=perform-tenant-switch.d.ts.map