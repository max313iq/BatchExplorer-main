export interface ArgQueryResult<T> {
    rows: T[];
    totalRecords: number;
    /** True if results were paginated and at least one ARM POST per page happened. */
    paginated: boolean;
    /** Number of ARM POSTs issued. Useful for telemetry / debug. */
    requestCount: number;
}
export interface ArgQueryOptions {
    /** ARM bearer token. The same token works across subs the user has access to. */
    token: string;
    /** KQL query — must NOT include a `where subscriptionId in (...)` filter; we set it via subscriptions. */
    query: string;
    /** Subscription scope; ARG will filter by these. Empty array = all subs the token can see. */
    subscriptionIds?: string[];
    /**
     * Cancel the pagination walk + chunk fan-out. When fired, in-flight
     * fetches abort and the cumulative result is discarded. Matches the
     * `signal` pattern used in arm-service / batch-service / graph-service.
     */
    signal?: AbortSignal;
}
/**
 * Run a KQL query through Azure Resource Graph, paginating through every
 * page automatically. Returns a flat `rows` array of typed records.
 *
 * Subscription chunking: if the caller passes >MAX_SUBS_PER_QUERY ids,
 * we issue parallel requests per chunk and merge. Each chunk still
 * follows pagination internally.
 *
 * Errors propagate as AzureRequestError with the ARM error envelope.
 */
export declare function runArgQuery<T = Record<string, unknown>>(opts: ArgQueryOptions): Promise<ArgQueryResult<T>>;
/**
 * Convenience: list every Batch account the token can see across the
 * given subscriptions in one (or a few) requests.
 *
 * Replaces the per-subscription `listBatchAccounts(subId, token)` loop —
 * one ARG POST instead of N paginated GETs.
 */
export interface ArgBatchAccountRow {
    id: string;
    name: string;
    type: string;
    location: string;
    resourceGroup: string;
    subscriptionId: string;
    tenantId?: string;
    /** Properties.poolAllocationMode — "BatchService" or "UserSubscription". */
    poolAllocationMode?: string;
    /** Properties.provisioningState — "Succeeded" / "Failed" / etc. */
    provisioningState?: string;
    tags?: Record<string, string>;
}
export declare function listBatchAccountsViaArg(token: string, subscriptionIds: string[], opts?: {
    signal?: AbortSignal;
}): Promise<ArgQueryResult<ArgBatchAccountRow>>;
/**
 * One ARG row per Batch pool across the supplied subscriptions.
 *
 * Mirrors the shape of {@link ArgBatchAccountRow} but for pools — used
 * by the orchestrator to refresh pool inventory across many accounts
 * in a single ARM POST. Without ARG, refreshing pool state is
 * O(accounts × pools-per-account × pagination), and a sweep across
 * dozens of accounts can take minutes; ARG returns the lot in one
 * request (capped at 1000 rows per page).
 */
export interface ArgBatchPoolRow {
    id: string;
    name: string;
    type: string;
    location: string;
    resourceGroup: string;
    subscriptionId: string;
    tenantId?: string;
    /** Parent account name — derived from the parent id segment. */
    accountName?: string;
    /** properties.vmSize — VM SKU the pool was created with. */
    vmSize?: string;
    /** properties.allocationState — "steady" | "resizing" | "stopping". */
    allocationState?: string;
    /** properties.currentDedicatedNodes — node-count snapshot. */
    currentDedicatedNodes?: number;
    /** properties.currentLowPriorityNodes — spot-node-count snapshot. */
    currentLowPriorityNodes?: number;
    /** properties.targetDedicatedNodes — desired-state dedicated count. */
    targetDedicatedNodes?: number;
    /** properties.targetLowPriorityNodes — desired-state spot count. */
    targetLowPriorityNodes?: number;
    /** properties.provisioningState — "Succeeded" / "Failed" / etc. */
    provisioningState?: string;
    tags?: Record<string, string>;
}
export declare function listPoolsViaArg(token: string, subscriptionIds: string[], opts?: {
    signal?: AbortSignal;
}): Promise<ArgQueryResult<ArgBatchPoolRow>>;
//# sourceMappingURL=arg-service.d.ts.map