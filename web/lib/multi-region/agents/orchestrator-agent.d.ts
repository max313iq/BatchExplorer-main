import { Agent, AgentContext, AgentResult } from "./agent-types";
import { ProvisionerAgent } from "./provisioner-agent";
import { FilterAgent } from "./filter-agent";
import { PoolAgent } from "./pool-agent";
import { NodeAgent } from "./node-agent";
/** Optional token provider interface for overriding default token resolution */
export interface TokenProvider {
    getAccessToken(tenantId?: string): Promise<string>;
    getBatchAccessToken?(tenantId?: string): Promise<string>;
    getGraphAccessToken?(tenantId?: string): Promise<string>;
}
export type OrchestratorAction = "create_accounts" | "discover_accounts" | "filter_accounts" | "create_pools" | "list_nodes" | "node_action" | "run_workflow" | "run_refresh_chain" | "retry_failed" | "refresh_pool_info" | "refresh_account_info" | "delete_nodes" | "recreate_nodes" | "recover_preempted" | "detect_unused_quota" | "auto_create_pools_from_quota" | "resize_pool" | "update_start_task" | "create_pools_smart" | "delete_pool" | "reboot_pool_nodes" | "bulk_node_action" | "list_tenants" | "switch_tenant" | "list_tenant_users" | "check_password_reset_capability" | "reset_user_password";
export declare class OrchestratorAgent implements Agent {
    private readonly _ctx;
    readonly name: "orchestrator";
    private readonly _provisioner;
    private readonly _filter;
    private readonly _pool;
    private readonly _node;
    private readonly _deduplicator;
    private _workflowAgent;
    private readonly _tokenProvider;
    /**
     * Per-execute() activity → AbortController map. Lets `cancel(activityId)`
     * abort the in-flight call instead of merely flipping the activity's
     * store status (the old behaviour, which only checked `_cancelled` at
     * iteration boundaries and ignored AbortSignal-based callers entirely).
     */
    private readonly _activityControllers;
    /**
     * Top-level cancellation tracker for the agent. Lets the legacy
     * `cancel()` (no args) and the per-activity `cancel(id)` paths share
     * one mechanism, and lets the agent self-abort all in-flight calls
     * on shutdown without resetting a single shared `_cancelled` flag
     * — which would otherwise race with concurrent execute() callers.
     */
    private readonly _cancellation;
    constructor(_ctx: AgentContext, tokenProvider?: TokenProvider);
    /** Shorthand for `(ctx.auditLogger ?? noopAuditLogger)`. */
    private get _audit();
    private _wireRateLimitTelemetry;
    /** Unsubscribe handle for the rate-limit telemetry sink, if available. */
    private _telemetryUnsubscribe?;
    /**
     * Release subscriptions and references this orchestrator holds. Safe
     * to call multiple times; subsequent dispatches throw. Today the only
     * registered teardown is the rate-limit telemetry sink — when more
     * accumulate (broadcast channel, background timers), add them here.
     */
    dispose(): void;
    /**
     * Fire-and-forget auto-discovery at construction time.
     *
     * Gated on `state.subscriptions.length > 0` so a fresh page load doesn't
     * burn a discovery cycle against the empty subs list — the dashboard-
     * shell waits for `loadSubscriptions` to populate per-account subs and
     * then triggers its own multi-account-aware discovery via the
     * post-auth effect. Running it here before subs are populated forces
     * the orchestrator into its `listSubscriptions(primaryToken)` fallback
     * which only ever returns the primary identity's subs, producing the
     * "Account Info: 14 of 60" symptom on multi-account browsers.
     */
    private _autoDiscoverOnInit;
    /**
     * Resolve ARM access token. When the caller knows which subscription
     * the token is for, _getArmTokenForSub routes through MSAL's
     * per-account API so multi-signed-in browsers don't accidentally
     * use the wrong account's token for a sub it can't see.
     */
    private _getAccessToken;
    /** Resolve Batch access token, preferring injected TokenProvider */
    private _getBatchAccessToken;
    /**
     * Per-subscription ARM token resolver. Looks up the owning MSAL
     * homeAccountId from `state.subscriptions` (populated by the
     * multi-account loadSubscriptions in dashboard-shell) and routes
     * through `getArmTokenForAccount` so the right identity is used.
     *
     * Falls back to the generic `_getAccessToken(tenantId)` path when
     * the sub isn't tracked or the owner is unknown — keeps the
     * single-account flow working.
     */
    private _getArmTokenForSub;
    /**
     * Look up the tenantId that owns a given subscription, using the
     * store's `subscriptions` slice. Falls back to undefined when the
     * subscription isn't tracked there (the caller will then use the
     * home-tenant token, which is fine for single-tenant scenarios).
     */
    private _resolveSubTenant;
    /** Look up the tenantId for an account by id, via its subscription. */
    private _resolveAccountTenant;
    /** Acquire a Batch token in the tenant that owns the account. */
    private _getBatchTokenForAccount;
    /**
     * Build a tenantId -> Promise<token> cache for the duration of a
     * single execute() call. Cross-tenant subscriptions need
     * tenant-scoped tokens (an ARM token for tenant A is rejected when
     * listing resources in tenant B's subscriptions). Acquiring the
     * token once per tenant per call avoids the N+1 silent-auth burst.
     */
    private _makeTenantTokenCache;
    /**
     * Per-subscription ARM-token cache for the duration of one execute()
     * call. Keyed by `subscriptionId` so each sub gets a token from its
     * owning MSAL homeAccountId via `_getArmTokenForSub` — critical for
     * browsers with several signed-in AAD identities, where a single
     * tenant-keyed cache would hand the primary's token to every sub
     * (including those the primary can't see → empty ARG results +
     * "No eligible accounts" on Pool Creation).
     *
     * Falls back to the generic provider when the sub isn't in the store
     * or has no `homeAccountId` (legacy / CLI auth paths).
     */
    private _makeSubArmTokenCache;
    /**
     * Per-subscription Batch-token cache. Prefers the context-provided
     * `getBatchAccessTokenForSubscription` (which knows about MSAL
     * homeAccountId) and falls back to the generic Batch provider with
     * the sub's tenantId. Required for `_refreshAccountInfo` and similar
     * data-plane calls when the user is signed into multiple AAD
     * identities — without it the listPools / getAccount calls against
     * non-primary accounts 401 silently and the page shows accounts with
     * `lowPriorityCoresFree = 0` (which then blocks Pool Creation).
     */
    private _makeSubBatchTokenCache;
    /**
     * Resolve a Microsoft Graph access token. Resolution order:
     *   1. Injected TokenProvider.getGraphAccessToken
     *   2. AgentContext.getGraphAccessToken
     *   3. Per-account msalAuth helper (if homeAccountId is supplied)
     *   4. Primary-account msalAuth helper
     */
    private _getGraphAccessToken;
    /** Best-effort actor identifier for audit log entries. */
    private _resolveActor;
    cancel(activityId?: string): void;
    /**
     * Block while the activity is paused. Exits when one of these
     * conditions is met:
     *   - activity becomes unpaused
     *   - activity transitions to `cancelling`
     *   - activity disappears from the store (e.g. operator dismissed it)
     *   - `signal` aborts
     *
     * Previously the loop only checked `cancelling` — if the operator
     * dismissed the activity (so it no longer existed) the predicate
     * `isActivityPaused` returned true forever and the agent spun.
     */
    private _waitWhilePaused;
    execute(params: Record<string, unknown>): Promise<AgentResult>;
    private _executeCreatePoolsWithChildren;
    private _executeCreatePoolsSmartWithChildren;
    private _resolveActivityTarget;
    private _discoverAccountsForSubscription;
    /**
     * Cross-subscription Batch-account discovery via Azure Resource Graph.
     * One POST replaces N paginated GETs. ARG queries within a single
     * tenant scope, so callers must group subs by tenant first.
     *
     * Returns null on any failure — callers fall back to the per-sub
     * pagination path. Common failure modes: user lacks ResourceGraph
     * Reader role on the tenant, ARG endpoint returns 403, or the result
     * shape doesn't match what downstream code expects.
     */
    private _discoverAccountsViaArg;
    private _discoverAccounts;
    private _refreshPoolInfo;
    private _refreshAccountInfo;
    private _detectUnusedQuota;
    private _autoCreatePoolsFromQuota;
    private _deleteNodes;
    private _recreateNodes;
    /**
     * Build an operator-readable summary of per-group failures. Groups
     * identical reasons so a 401 affecting 8 pools shows once with the
     * pool count, then enumerates distinct reasons in descending order
     * of impact. Capped at 280 chars so it fits in a small UI surface
     * without truncation noise.
     *
     * Example outputs:
     *   "401 Unauthorized (8 pools, 200 nodes; AAD token expired)"
     *   "2 distinct failures: 401 Unauthorized (5 pools, 120 nodes); 429 Too Many Requests (3 pools, 80 nodes)"
     */
    private _condenseFailureReasons;
    private _recoverPreempted;
    get provisioner(): ProvisionerAgent;
    get filter(): FilterAgent;
    get pool(): PoolAgent;
    get node(): NodeAgent;
    private _resizePool;
    private _updateStartTask;
    private _updateStartTaskForAccount;
    /**
     * Delete a pool by account ID and pool ID.
     * Used by the "Remove Empty Pools" feature.
     */
    private _deletePool;
    /**
     * Reboot ALL nodes in a pool. Called after updating the start task
     * so nodes pick up the new configuration.
     *
     * Lists nodes via the Batch API (not from store — store may be stale),
     * then reboots each one. Nodes in non-rebootable states are skipped.
     */
    private _rebootPoolNodes;
    /**
     * Bulk node action — applies reboot/reimage/disableScheduling/enableScheduling
     * to ALL nodes across ALL pools, grouped by account+pool.
     *
     * Unlike the per-node node_action (which processes store ManagedNode IDs
     * one by one through the scheduler), this calls the Batch API directly
     * per pool using listNodes + performNodeAction. Much faster for hundreds
     * of nodes.
     */
    private _bulkNodeAction;
    private _listTenants;
    private _switchTenant;
    private _listTenantUsers;
    private _checkPasswordResetCapability;
    private _resetUserPassword;
}
//# sourceMappingURL=orchestrator-agent.d.ts.map