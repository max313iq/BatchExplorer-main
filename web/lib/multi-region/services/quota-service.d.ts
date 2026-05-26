export interface BatchAccountQuotaInfo {
    /** The hard quota for Batch accounts in this (sub, region). Default: 1–3. */
    accountQuota: number;
    /** Number of Batch accounts currently provisioned in this (sub, region). */
    currentCount: number;
    /** accountQuota - currentCount. Negative means we're already over (rare, transient). */
    available: number;
    /** When this snapshot was taken. */
    fetchedAt: string;
}
export interface BatchVmSku {
    /** Canonical name, e.g. "Standard_NC24s_v3". */
    name: string;
    /** Family group, e.g. "standardNCv3Family". */
    familyName: string;
    /** Capabilities as published — vCPUs, GPUs, memoryGB, premiumIO, etc. */
    capabilities: Record<string, string>;
}
export interface ComputeSkuRestriction {
    type?: string;
    values?: string[];
    reasonCode?: string;
}
export interface ComputeVmSku {
    /** Canonical name, e.g. "Standard_NC24s_v3". */
    name: string;
    /** Resource type — we filter to "virtualMachines". */
    resourceType: string;
    /** Regions where the SKU is available at all. */
    locations: string[];
    /** Per-region availability zones; empty if not zonal. */
    locationInfo?: Array<{
        location: string;
        zones?: string[];
    }>;
    /** Why a SKU is unavailable in some regions (NotAvailableForSubscription, etc.). */
    restrictions?: ComputeSkuRestriction[];
    /** Capabilities snapshot — vCPUs, GPUs, etc. */
    capabilities: Record<string, string>;
    /** Family / size / tier for grouping in the picker. */
    family?: string;
    size?: string;
    tier?: string;
}
/**
 * Subscribe to cache changes. Listeners receive the cache key that
 * changed so they can selectively re-render. The pub/sub keeps the
 * VM Catalog page reactive without polling: when a background refresh
 * lands, the page sees the new data immediately.
 */
export declare function subscribeQuotaCache(listener: (key: string) => void): () => void;
/**
 * Pull the disk-cache snapshot into the in-memory cache. Idempotent —
 * subsequent calls return the in-flight Promise. The localStorage layer
 * is preferred when present (it's hot); disk only fills the gap when
 * localStorage was wiped or never populated (cross-browser, post-quota
 * eviction, dev-server restart with empty browser, etc.).
 */
export declare function ensureDiskHydrated(): Promise<void>;
/**
 * Inspect the cache without consuming the value. Returns the entry's
 * fetch timestamp + freshness even when the entry is stale (callers can
 * use stale data while a background refresh runs — the UI shows
 * "refreshed N days ago, refreshing…").
 */
export declare function cachePeek<T>(key: string): {
    value: T;
    fetchedAt: number;
    expiresAt: number;
} | null;
/** Force-clear cached entries. Useful after a known mutation (e.g. account created). */
export declare function invalidateQuotaCache(subId?: string, region?: string): void;
/**
 * Quota for Batch *accounts* in a single (sub, region) pair, plus the
 * count of accounts currently provisioned there.
 *
 * Endpoint:
 *   GET /subscriptions/{sub}/providers/Microsoft.Batch/locations/{loc}
 *       /quotas?api-version=2024-07-01
 *   GET /subscriptions/{sub}/providers/Microsoft.Batch/batchAccounts
 *       ?api-version=2024-07-01
 *
 * The current-count number is computed locally by listing accounts and
 * filtering on the location field. Cached together so a series of
 * "can I create here?" probes don't re-list the universe each time.
 */
export declare function getBatchAccountQuota(subscriptionId: string, region: string, token: string, opts?: {
    tenantId?: string;
    signal?: AbortSignal;
}): Promise<BatchAccountQuotaInfo>;
/**
 * Every VM SKU the Batch service will accept for a pool in this region.
 * Distinct from Microsoft.Compute SKUs — Batch maintains its own
 * supported list which lags behind general VM availability.
 *
 * Endpoint:
 *   GET /subscriptions/{sub}/providers/Microsoft.Batch/locations/{loc}
 *       /virtualMachineSkus?api-version=2024-07-01
 */
export declare function listBatchSupportedVmSkus(subscriptionId: string, region: string, token: string, opts?: {
    tenantId?: string;
    signal?: AbortSignal;
}): Promise<BatchVmSku[]>;
/**
 * Cheap predicate: is `vmSize` accepted by Batch in `region`?
 * Wraps `listBatchSupportedVmSkus` so callers don't have to reason about
 * case-sensitivity themselves (Azure mixes Standard_NC24s_v3 with
 * standard_nc24s_v3 across endpoints).
 */
export declare function isVmSupportedByBatchInRegion(subscriptionId: string, region: string, vmSize: string, token: string): Promise<boolean>;
export interface ListAllVmSkusOptions {
    /** Fired after every page so the UI can render rows progressively. */
    onPartial?: (skus: ComputeVmSku[], hasMore: boolean) => void;
    /** Cancel the walk. */
    signal?: AbortSignal;
    /**
     * Optional row filter applied as pages stream in. Rejected rows are
     * dropped before reaching state, so onPartial only ever sees rows
     * that pass — drastically smaller payloads when the caller only
     * cares about a subset (e.g. GPU-only).
     */
    filter?: (sku: ComputeVmSku) => boolean;
    /**
     * Tenant scope for the cache key. Two operators on different tenants
     * with overlapping subscription visibility would otherwise share one
     * cache slot. Defaults to `"_notenant_"` for back-compat.
     */
    tenantId?: string;
}
/**
 * GPU-family pattern. ND/NC/NV/NG are the four Azure VM families that
 * ship with accelerators (NVIDIA H100/A100/V100/T4/M60/K80, AMD V620,
 * AMD MI300X). Catches every Standard_(ND|NC|NV|NG)* SKU regardless of
 * generation.
 */
export declare const GPU_VM_NAME_RE: RegExp;
/** Convenience: predicate version of the GPU family pattern. */
export declare function isGpuSkuName(skuName: string): boolean;
export declare function listAllVmSkus(subscriptionId: string, token: string, options?: ListAllVmSkusOptions): Promise<ComputeVmSku[]>;
/** Public stable cache key for the VM-catalog entry, so other modules
 * (e.g. the UI's cachePeek inspection) can read the same key the
 * loader writes. The arguments mirror `listAllVmSkus`'s scoping:
 * the subscription, whether the GPU-only filter is in play, and the
 * tenant scope (defaults to `"_notenant_"` for back-compat with
 * callers that don't carry tenant ids). */
export declare function vmSkusCacheKey(subscriptionId: string, gpuOnly: boolean, tenantId?: string): string;
/**
 * Pre-flight check for `createPool`. Same purpose as the
 * `createBatchAccount` pre-flight (block the call BEFORE Azure sees a
 * loud 4xx that would trip the abuse heuristics): verify the (region,
 * vmSize) pair would succeed BEFORE we issue the create.
 *
 * Three independent checks:
 *
 *   1. **VM SKU is accepted by Batch in this region.** Batch maintains
 *      its own narrower allow-list (lags general VM availability by
 *      weeks). We hit `listBatchSupportedVmSkus`. Cached 15 min.
 *
 *   2. **VM SKU is enabled on the subscription.** A SKU that's
 *      available in the region but blocked by sub-level restriction
 *      (NotAvailableForSubscription) would 4xx the create. We hit
 *      `listAllVmSkus` and inspect `restrictions`. Cached 7 days.
 *
 *   3. **(Heuristic) The Batch account has enough dedicated-core
 *      headroom.** This one is best-effort — Batch publishes the
 *      enforced quota per VM family on the parent account record, but
 *      the API we use here is the parent-level
 *      `getBatchAccountQuota`, which is account-count-quota not
 *      core-count quota. If `slots <= 0` we skip; otherwise we don't
 *      block, just surface a warning in `reason`.
 *
 * Returns `{ ok: true }` if the check passes. Returns `{ ok: false,
 * reason: ... }` with a human-readable diagnostic if one of the
 * deterministic checks (#1, #2) fails. Probe failures (RBAC, transient
 * 5xx during the probe itself) FAIL OPEN — better to attempt the
 * create than block on a flaky probe.
 *
 * The caller MUST extract the subscription id from the account's ARM
 * id; we don't infer it here (the account object shape varies by call
 * site).
 */
export interface PoolPreflightAccount {
    /** Full ARM id, or just the subscriptionId of the parent batch account. */
    subscriptionId: string;
    /** Optional tenant id — passed through to the cache key. */
    tenantId?: string;
}
export declare function checkPoolCreatable(account: PoolPreflightAccount, region: string, vmSize: string, slots: number, token: string, opts?: {
    signal?: AbortSignal;
}): Promise<{
    ok: boolean;
    reason?: string;
}>;
/**
 * Resolve "where is this VM actually available?" — returns the regions
 * where the SKU appears in `locations` AND isn't blocked by a restriction.
 *
 * Useful for the picker's per-VM "supported regions" badge and for the
 * orchestrator's pre-flight when fanning out across regions.
 */
export declare function getRegionsSupportingVm(subscriptionId: string, vmSize: string, token: string): Promise<string[]>;
//# sourceMappingURL=quota-service.d.ts.map