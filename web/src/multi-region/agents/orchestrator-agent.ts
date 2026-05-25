import {
  Agent,
  AgentContext,
  AgentResult,
  noopAuditLogger,
} from "./agent-types";
import { ProvisionerAgent } from "./provisioner-agent";
import { FilterAgent } from "./filter-agent";
import { PoolAgent } from "./pool-agent";
import { NodeAgent } from "./node-agent";
import { WorkflowAgent, WorkflowConfig } from "./workflow-agent";
import { RequestDeduplicator } from "../scheduling/request-deduplicator";
import { classifyAzureError } from "./error-classifier";
import { pMapSettled } from "./_shared/parallel";
import { correlationId as makeCorrelationId } from "./_shared/ids";
import { accountEndpointHost } from "./_shared/endpoints";
import { abortableSleep, isAbortError } from "./_shared/abortable-sleep";
import { CancellationTracker } from "./_shared/cancellation";
import {
  groupNodesByPool,
  type NodeForGrouping,
  type AccountForGrouping,
} from "./_shared/group-nodes";
import {
  getSharedRequestGuard,
  RateLimitTelemetry,
} from "../scheduling/request-governance";
import { PoolInfo, AccountInfo, QuotaSuggestion } from "../store/store-types";
import {
  listSubscriptions,
  listBatchAccounts,
  getBatchAccount,
  listPools,
  createPool,
  patchPool,
  removeNodes,
  deletePool,
  listNodes,
  performNodeAction,
  listOrgUsers,
  getMyDirectoryRoles,
  resetUserPassword,
  canResetPasswords,
} from "../services";
import type { BatchPool as SdkBatchPool, GraphUser } from "../services";
import { listBatchAccountsViaArg } from "../services/arg-service";
import { isVmSupportedByBatchInRegion } from "../services/quota-service";
import { addToBlacklist } from "../store/failure-blacklist";
import { getVCpus } from "../components/shared/vm-sizes";
import {
  getActiveTenant,
  getGraphToken,
  getGraphTokenForAccount,
  listAccessibleTenants,
  setActiveTenant as msalSetActiveTenant,
} from "../auth/msal-auth";
import { TENANT_CHANGED_EVENT } from "../hooks/tenant-changed-event";
import { credentialVault } from "../auth/credential-vault";
import { auditLog } from "../services/audit-log";
import { taskRuntime, TaskKind } from "../store/task-runtime";

/**
 * Map orchestrator actions to sticky-task kinds. Only the actions that
 * spawn long-running multi-step work get a persistent TaskRecord — quick
 * lookups and refreshes don't.
 *
 * Note: `"monitor"` was removed when MonitorAgent was deleted; we keep
 * the TaskKind enum entry alive in `store/task-runtime.ts` (out of our
 * edit boundary), but no orchestrator action maps to it any more.
 */
function stickyTaskKind(action: string): TaskKind | null {
  switch (action) {
    case "create_accounts":
      return "provision-accounts";
    case "create_pools":
    case "auto_create_pools_from_quota":
      return "create-pools";
    case "create_pools_smart":
      return "create-pools-smart";
    case "run_full_workflow":
      return "create-pools-smart";
    case "run_refresh_chain":
      return "refresh-chain";
    default:
      return null;
  }
}

// Concurrency limit for read-only GET operations
const READ_CONCURRENCY = 3;

// Local alias so the existing call sites that already say `pMap(items, fn, n)`
// keep their shape — the underlying helper is the shared one from
// `_shared/parallel.ts` and behaves identically to the deleted in-file copy.
const pMap = pMapSettled;

/** Build the Batch account endpoint host (no scheme) from account fields. */
function accountEndpoint(accountName: string, region: string): string {
  return accountEndpointHost(accountName, region);
}

/** Optional token provider interface for overriding default token resolution */
export interface TokenProvider {
  getAccessToken(tenantId?: string): Promise<string>;
  getBatchAccessToken?(tenantId?: string): Promise<string>;
  getGraphAccessToken?(tenantId?: string): Promise<string>;
}

export type OrchestratorAction =
  | "create_accounts"
  | "discover_accounts"
  | "filter_accounts"
  | "create_pools"
  | "list_nodes"
  | "node_action"
  | "run_workflow"
  | "run_refresh_chain"
  | "retry_failed"
  | "refresh_pool_info"
  | "refresh_account_info"
  | "delete_nodes"
  | "recreate_nodes"
  | "recover_preempted"
  | "detect_unused_quota"
  | "auto_create_pools_from_quota"
  | "resize_pool"
  | "update_start_task"
  | "create_pools_smart"
  | "delete_pool"
  | "reboot_pool_nodes"
  | "bulk_node_action"
  | "list_tenants"
  | "switch_tenant"
  | "list_tenant_users"
  | "check_password_reset_capability"
  | "reset_user_password";

export class OrchestratorAgent implements Agent {
  readonly name = "orchestrator" as const;

  private readonly _provisioner: ProvisionerAgent;
  private readonly _filter: FilterAgent;
  private readonly _pool: PoolAgent;
  private readonly _node: NodeAgent;
  private readonly _deduplicator: RequestDeduplicator;
  private _workflowAgent: WorkflowAgent | null = null;
  private readonly _tokenProvider: TokenProvider | undefined;
  /**
   * Per-execute() activity → AbortController map. Lets `cancel(activityId)`
   * abort the in-flight call instead of merely flipping the activity's
   * store status (the old behaviour, which only checked `_cancelled` at
   * iteration boundaries and ignored AbortSignal-based callers entirely).
   */
  private readonly _activityControllers = new Map<string, AbortController>();
  /**
   * Top-level cancellation tracker for the agent. Lets the legacy
   * `cancel()` (no args) and the per-activity `cancel(id)` paths share
   * one mechanism, and lets the agent self-abort all in-flight calls
   * on shutdown without resetting a single shared `_cancelled` flag
   * — which would otherwise race with concurrent execute() callers.
   */
  private readonly _cancellation = new CancellationTracker();

  constructor(
    private readonly _ctx: AgentContext,
    tokenProvider?: TokenProvider,
  ) {
    this._tokenProvider = tokenProvider;
    this._deduplicator = new RequestDeduplicator();
    this._provisioner = new ProvisionerAgent(_ctx);
    this._filter = new FilterAgent(_ctx.store);
    this._pool = new PoolAgent(_ctx);
    this._node = new NodeAgent(_ctx);

    this._wireRateLimitTelemetry();

    // AUTO-DISCOVER on init: trigger discover_accounts for all subscriptions
    this._autoDiscoverOnInit();
  }

  /** Shorthand for `(ctx.auditLogger ?? noopAuditLogger)`. */
  private get _audit() {
    return this._ctx.auditLogger ?? noopAuditLogger;
  }

  private _wireRateLimitTelemetry(): void {
    const store = this._ctx.store;
    const guard = this._ctx.requestGuard ?? getSharedRequestGuard();
    const sink: RateLimitTelemetry = {
      setEntry: (sub, family, entry) => {
        store.setThrottleStatusEntry(sub, family, entry);
      },
      pushTransition: (t) => {
        store.pushThrottleTransition(t);
      },
      critical: (msg) => {
        store.addLog({
          agent: "orchestrator",
          level: "error",
          message: msg,
        });
      },
    };
    // `addTelemetrySink` (not the legacy `setTelemetry`) so the
    // dashboard-shell's sink coexists with ours — orchestrator
    // reconstruction on tenant-change must not clobber the shell's
    // throttle-page wiring. Test-mock guards that only expose
    // setTelemetry continue working via the back-compat branch.
    if (typeof guard.addTelemetrySink === "function") {
      this._telemetryUnsubscribe = guard.addTelemetrySink(sink);
    } else if (typeof guard.setTelemetry === "function") {
      guard.setTelemetry(sink);
    }
  }

  /** Unsubscribe handle for the rate-limit telemetry sink, if available. */
  private _telemetryUnsubscribe?: () => void;

  /**
   * Release subscriptions and references this orchestrator holds. Safe
   * to call multiple times; subsequent dispatches throw. Today the only
   * registered teardown is the rate-limit telemetry sink — when more
   * accumulate (broadcast channel, background timers), add them here.
   */
  dispose(): void {
    this._telemetryUnsubscribe?.();
    this._telemetryUnsubscribe = undefined;
  }

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
  private _autoDiscoverOnInit(): void {
    const subs = this._ctx.store.getState().subscriptions;
    if (subs.length === 0) {
      // Skip — the dashboard-shell's post-auth effect will run discovery
      // once subs are populated with homeAccountId per sub.
      return;
    }
    this.execute({
      action: "discover_accounts",
      payload: {},
    }).catch((err) => {
      this._ctx.store.addLog({
        agent: "orchestrator",
        level: "warn",
        message: `Auto-discovery on init failed: ${err?.message ?? String(err)}`,
      });
    });
  }

  /**
   * Resolve ARM access token. When the caller knows which subscription
   * the token is for, _getArmTokenForSub routes through MSAL's
   * per-account API so multi-signed-in browsers don't accidentally
   * use the wrong account's token for a sub it can't see.
   */
  private async _getAccessToken(tenantId?: string): Promise<string> {
    if (this._tokenProvider) {
      return this._tokenProvider.getAccessToken(tenantId);
    }
    return this._ctx.getAccessToken(tenantId);
  }

  /** Resolve Batch access token, preferring injected TokenProvider */
  private async _getBatchAccessToken(tenantId?: string): Promise<string> {
    if (this._tokenProvider?.getBatchAccessToken) {
      return this._tokenProvider.getBatchAccessToken(tenantId);
    }
    return this._ctx.getBatchAccessToken(tenantId);
  }

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
  private async _getArmTokenForSub(
    subscriptionId: string,
  ): Promise<string> {
    const sub = this._ctx.store
      .getState()
      .subscriptions.find((s) => s.subscriptionId === subscriptionId);
    if (sub?.homeAccountId) {
      try {
        const mod = await import("../auth/msal-auth");
        return await mod.getArmTokenForAccount(sub.homeAccountId);
      } catch (err) {
        // Per-account token couldn't be acquired (MSAL account missing
        // from the local cache, silent-auth interaction_required, etc.)
        // Log so the operator can see WHY the sub silently fell back to
        // the primary's token — without this, multi-account discovery
        // failures were invisible.
        this._ctx.store.addLog({
          agent: "orchestrator",
          level: "warn",
          message: `Per-account ARM token failed for sub ${subscriptionId.slice(0, 8)}… (homeAccountId ${sub.homeAccountId.slice(0, 12)}…): ${(err as Error)?.message ?? String(err)}. Falling back to primary identity token — sub may show empty results if primary lacks access.`,
        });
      }
    }
    return this._getAccessToken(sub?.tenantId);
  }

  /**
   * Look up the tenantId that owns a given subscription, using the
   * store's `subscriptions` slice. Falls back to undefined when the
   * subscription isn't tracked there (the caller will then use the
   * home-tenant token, which is fine for single-tenant scenarios).
   */
  private _resolveSubTenant(subscriptionId: string): string | undefined {
    const subs = this._ctx.store.getState().subscriptions;
    return subs.find((s) => s.subscriptionId === subscriptionId)?.tenantId;
  }

  /** Look up the tenantId for an account by id, via its subscription. */
  private _resolveAccountTenant(accountId: string): string | undefined {
    const account = this._ctx.store
      .getState()
      .accounts.find((a) => a.id === accountId);
    if (!account) return undefined;
    return this._resolveSubTenant(account.subscriptionId);
  }

  /** Acquire a Batch token in the tenant that owns the account. */
  private async _getBatchTokenForAccount(accountId: string): Promise<string> {
    const tenantId = this._resolveAccountTenant(accountId);
    return this._getBatchAccessToken(tenantId);
  }

  /**
   * Build a tenantId -> Promise<token> cache for the duration of a
   * single execute() call. Cross-tenant subscriptions need
   * tenant-scoped tokens (an ARM token for tenant A is rejected when
   * listing resources in tenant B's subscriptions). Acquiring the
   * token once per tenant per call avoids the N+1 silent-auth burst.
   */
  private _makeTenantTokenCache(
    fetcher: (tenantId?: string) => Promise<string>,
  ): (tenantId?: string) => Promise<string> {
    const cache = new Map<string, Promise<string>>();
    return (tenantId?: string) => {
      const key = tenantId ?? "__home__";
      const existing = cache.get(key);
      if (existing) return existing;
      const promise = fetcher(tenantId).catch((err) => {
        // Drop the failed promise from cache so a retry triggers a fresh
        // silent-auth attempt rather than re-throwing the cached error.
        cache.delete(key);
        throw err;
      });
      cache.set(key, promise);
      return promise;
    };
  }

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
  private _makeSubArmTokenCache(): (
    subscriptionId: string,
  ) => Promise<string> {
    const cache = new Map<string, Promise<string>>();
    return (subscriptionId: string) => {
      const existing = cache.get(subscriptionId);
      if (existing) return existing;
      const promise = this._getArmTokenForSub(subscriptionId).catch((err) => {
        cache.delete(subscriptionId);
        throw err;
      });
      cache.set(subscriptionId, promise);
      return promise;
    };
  }

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
  private _makeSubBatchTokenCache(): (
    subscriptionId: string,
  ) => Promise<string> {
    const cache = new Map<string, Promise<string>>();
    return (subscriptionId: string) => {
      const existing = cache.get(subscriptionId);
      if (existing) return existing;
      const fetch = async () => {
        const perSub = this._ctx.getBatchAccessTokenForSubscription;
        if (perSub) {
          try {
            return await perSub(subscriptionId);
          } catch {
            // fall through to tenant-keyed fallback
          }
        }
        const tenantId = this._resolveSubTenant(subscriptionId);
        return this._getBatchAccessToken(tenantId);
      };
      const promise = fetch().catch((err) => {
        cache.delete(subscriptionId);
        throw err;
      });
      cache.set(subscriptionId, promise);
      return promise;
    };
  }

  /**
   * Resolve a Microsoft Graph access token. Resolution order:
   *   1. Injected TokenProvider.getGraphAccessToken
   *   2. AgentContext.getGraphAccessToken
   *   3. Per-account msalAuth helper (if homeAccountId is supplied)
   *   4. Primary-account msalAuth helper
   */
  private async _getGraphAccessToken(
    tenantId?: string,
    homeAccountId?: string,
  ): Promise<string> {
    if (this._tokenProvider?.getGraphAccessToken) {
      return this._tokenProvider.getGraphAccessToken(tenantId);
    }
    if (this._ctx.getGraphAccessToken) {
      return this._ctx.getGraphAccessToken(tenantId);
    }
    if (homeAccountId) {
      return getGraphTokenForAccount(homeAccountId, tenantId);
    }
    return getGraphToken(tenantId);
  }

  /** Best-effort actor identifier for audit log entries. */
  private _resolveActor(homeAccountId?: string): string {
    const accounts = this._ctx.store.getState().azureAccounts;
    if (homeAccountId) {
      const match = accounts.find((a) => a.homeAccountId === homeAccountId);
      if (match) return match.username || match.name || homeAccountId;
    }
    if (accounts.length > 0) {
      return (
        accounts[0].username || accounts[0].name || accounts[0].homeAccountId
      );
    }
    return "unknown";
  }

  cancel(activityId?: string): void {
    if (activityId) {
      const { store } = this._ctx;
      const activity = store
        .getState()
        .activities.find((a) => a.id === activityId);
      if (activity) {
        store.markActivityCancelling(activityId);
        if (activity.children) {
          for (const childId of activity.children) {
            const child = store
              .getState()
              .activities.find((c) => c.id === childId);
            if (
              child &&
              (child.status === "running" ||
                child.status === "paused" ||
                child.status === "pending")
            ) {
              store.markActivityCancelling(childId);
            }
          }
        }
      }
      // Abort the per-activity controller so any awaiter sees AbortError
      // immediately instead of relying on iteration-boundary polling.
      const ctrl = this._activityControllers.get(activityId);
      if (ctrl) {
        try {
          ctrl.abort();
        } catch {
          /* abort() never throws; defensive only */
        }
      }
    } else {
      // No-args cancel — agent-wide shutdown. Abort every in-flight call.
      this._cancellation.abortAll();
      for (const c of this._activityControllers.values()) {
        try {
          c.abort();
        } catch {
          /* defensive */
        }
      }
    }
    this._provisioner.cancel();
    this._pool.cancel();
    this._node.cancel();
    if (this._workflowAgent) {
      this._workflowAgent.cancel();
    }
  }

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
  private async _waitWhilePaused(
    activityId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { store } = this._ctx;
    while (store.isActivityPaused(activityId)) {
      if (signal?.aborted) return;
      const a = store.getState().activities.find((x) => x.id === activityId);
      if (!a) return; // removed — bail out, don't spin forever
      if (a.status === "cancelling") return;
      if (a.status === "cancelled") return;
      try {
        await abortableSleep(200, signal);
      } catch {
        return;
      }
    }
  }

  async execute(params: Record<string, unknown>): Promise<AgentResult> {
    const action = params.action as OrchestratorAction;
    const { store } = this._ctx;
    const correlationId = makeCorrelationId();
    const startTime = Date.now();

    // Determine a human-readable target for the activity
    const actPayload = params.payload as Record<string, unknown> | undefined;
    const actTarget = this._resolveActivityTarget(action, actPayload);

    // Track this action as an activity
    const actId = store.addActivity({
      action,
      target: actTarget,
      status: "running",
    });

    // AbortSignal wiring (audit fix #1 + #8). We register a per-call
    // controller in the agent-wide cancellation tracker AND in the
    // per-activity map. `agentSignal` fires when either the caller's
    // signal aborts or the agent self-cancels.
    const callerSignal = (params as { signal?: AbortSignal }).signal;
    const { controller, signal: agentSignal } =
      this._cancellation.begin(callerSignal);
    this._activityControllers.set(actId, controller);

    // Sticky-task tracking: persist long-running actions in
    // localStorage so they survive a reload. Created here, finalized in
    // the try/catch below.
    //
    // Resume path: when this execute() is called by task-auto-resumer or
    // by the manual Resume button, the caller passes `resumeTaskId` —
    // the id of the existing interrupted/paused record. We REUSE that
    // record (flip status back to running, reset progress counters) so
    // the Task Manager UI shows ONE task that just keeps progressing,
    // not two — the original stuck on "Auto-resuming…" + a duplicate
    // doing the real work, which was the previous bug.
    const stickyKind = stickyTaskKind(action);
    let stickyTaskId: string | undefined;
    const resumeTaskId =
      typeof params.resumeTaskId === "string" ? params.resumeTaskId : undefined;
    if (stickyKind) {
      const subId =
        (actPayload?.subscriptionId as string | undefined) ?? undefined;
      const existing = resumeTaskId ? taskRuntime.get(resumeTaskId) : undefined;
      if (existing) {
        // Adopt the existing record. Status flips back to running so the
        // row's progress bar reverts to indeterminate while the agent
        // re-runs; counters reset so we don't show the stale pre-reload
        // progress percentage. Heartbeat is updated by `update()`.
        taskRuntime.update(existing.id, {
          status: "running",
          startedAt: new Date().toISOString(),
          completed: 0,
          failed: 0,
          cancelRequested: false,
          error: undefined,
          currentStep: "Resuming…",
        });
        stickyTaskId = existing.id;
      } else {
        const stickyRec = taskRuntime.create({
          kind: stickyKind,
          label: `${action}: ${actTarget}`,
          input: params,
          subscriptionId: subId,
        });
        stickyTaskId = stickyRec.id;
      }
    }

    store.setAgentStatus("orchestrator", "running");
    store.addLog({
      agent: "orchestrator",
      level: "info",
      message: `[${correlationId}] Dispatching action: ${action}`,
    });

    try {
      let result: AgentResult;

      switch (action) {
        case "create_accounts":
          // Forward the sticky-task id so the provisioner can tick the
          // Task Manager's progress bar AND honor a per-task cancel
          // request from the Task Manager UI. Also forward the
          // AbortSignal so the agent can short-circuit on cancel.
          result = await this._provisioner.execute({
            ...(params.payload as Record<string, unknown>),
            ...(stickyTaskId ? { stickyTaskId } : {}),
            signal: agentSignal,
          });
          store.addNotification({
            type: result.status === "completed" ? "success" : "warning",
            message:
              result.status === "completed"
                ? "Account creation completed successfully"
                : `Account creation finished with status: ${result.status} [${correlationId}]`,
          });
          break;

        case "discover_accounts":
          result = await this._deduplicator.deduplicate(
            "discover-accounts",
            () =>
              this._discoverAccounts(params.payload as Record<string, unknown>),
          );
          break;

        case "filter_accounts":
          result = await this._filter.execute(
            params.payload as Record<string, unknown>,
          );
          break;

        case "create_pools": {
          const cpPayload = params.payload as Record<string, unknown>;

          // If no accountIds provided, run filter first
          if (
            !cpPayload.accountIds ||
            (cpPayload.accountIds as string[]).length === 0
          ) {
            store.updateActivity(actId, { progress: 10 });
            const filterResult = await this._filter.execute({
              filters: cpPayload.filters ?? {},
              selectAll: true,
            } as Record<string, unknown>);

            const filtered = filterResult.summary as unknown as {
              accounts: Array<{
                accountId: string;
              }>;
            };
            cpPayload.accountIds = filtered.accounts.map((a) => a.accountId);
          }

          store.updateActivity(actId, { progress: 30 });
          result = await this._executeCreatePoolsWithChildren(
            actId,
            cpPayload,
            stickyTaskId,
          );
          store.addNotification({
            type: result.status === "completed" ? "success" : "warning",
            message:
              result.status === "completed"
                ? "Pool creation completed successfully"
                : `Pool creation finished with status: ${result.status} [${correlationId}]`,
          });
          break;
        }

        case "create_pools_smart": {
          const smartPayload = params.payload as Record<string, unknown>;
          store.updateActivity(actId, { progress: 20 });

          // Pre-filter accounts: check for resizing pools and
          // adjust available LP quota accordingly
          const requestedAccountIds =
            (smartPayload.accountIds as string[]) ?? [];
          const currentPoolInfos = store.getState().poolInfos;
          const currentAccountInfos = store.getState().accountInfos;
          const filteredAccountIds: string[] = [];

          for (const accountId of requestedAccountIds) {
            const accountInfo = currentAccountInfos.find(
              (a) => a.id === accountId,
            );
            if (!accountInfo) {
              filteredAccountIds.push(accountId);
              continue;
            }

            // Check if any pool in this account is currently resizing
            const accountPools = currentPoolInfos.filter(
              (p) => p.accountId === accountId,
            );
            const resizingPools = accountPools.filter(
              (p) => p.allocationState === "resizing",
            );

            if (resizingPools.length > 0) {
              // Calculate LP cores consumed by resizing pools
              let resizingCoresConsumed = 0;
              for (const rp of resizingPools) {
                resizingCoresConsumed +=
                  rp.targetLowPriorityNodes * getVCpus(rp.vmSize || "");
              }

              const remainingFreeLp =
                accountInfo.lowPriorityCoresFree - resizingCoresConsumed;

              if (remainingFreeLp <= 0) {
                store.addLog({
                  agent: "orchestrator",
                  level: "info",
                  message: `Skipping ${accountInfo.accountName} — all LP quota consumed by resizing pool`,
                });
                continue;
              }

              // There IS remaining quota; adjust the accountInfo
              // in the store so pool agent sees the correct
              // remaining value.
              store.updateAccountInfo(accountId, {
                lowPriorityCoresFree: remainingFreeLp,
              });
              store.addLog({
                agent: "orchestrator",
                level: "info",
                message: `${accountInfo.accountName}: resizing pool consuming ${resizingCoresConsumed} LP cores, ${remainingFreeLp} LP cores remaining for new pool`,
              });
            }

            filteredAccountIds.push(accountId);
          }

          // SAFETY: Ensure targetDedicatedNodes = 0 in pool config
          const smartPoolConfig =
            (smartPayload.poolConfig as Record<string, unknown>) ?? {};
          smartPoolConfig.targetDedicatedNodes = 0;

          result = await this._executeCreatePoolsSmartWithChildren(actId, {
            accountIds: filteredAccountIds,
            vmSizes: (smartPayload.vmSizes as string[]) ?? [],
            poolConfig: smartPoolConfig,
          });
          store.addNotification({
            type: result.status === "completed" ? "success" : "warning",
            message:
              result.status === "completed"
                ? "Smart pool creation completed successfully"
                : `Smart pool creation finished with status: ${result.status} [${correlationId}]`,
          });
          break;
        }

        case "list_nodes":
          result = await this._node.execute({
            ...(params.payload as Record<string, unknown>),
            signal: agentSignal,
          });
          break;

        case "node_action":
          result = await this._node.execute({
            ...(params.payload as Record<string, unknown>),
            signal: agentSignal,
          });
          break;

        case "delete_nodes":
          result = await this._deleteNodes(
            params.payload as Record<string, unknown>,
          );
          break;
        case "recreate_nodes":
          result = await this._recreateNodes(
            params.payload as Record<string, unknown>,
          );
          break;
        case "recover_preempted":
          result = await this._recoverPreempted(
            params.payload as Record<string, unknown>,
          );
          break;
        case "run_workflow": {
          const workflowConfig = params.payload as unknown as WorkflowConfig;
          // Audit fix #3: pass `this` so WorkflowAgent re-uses the
          // parent orchestrator instance instead of constructing its
          // own (which fires another auto-discover + leaks).
          this._workflowAgent = new WorkflowAgent(this._ctx, this);
          store.updateActivity(actId, { progress: 10 });
          result = await this._workflowAgent.execute(workflowConfig);
          this._workflowAgent = null;
          break;
        }

        case "run_refresh_chain": {
          // Audit fix #2: surface executeRefreshChain so the UI can
          // trigger it via the standard dispatch. Subscription id is
          // required; if missing we surface a failed result with
          // a descriptive error rather than throwing through the
          // orchestrator's generic handler.
          const rcPayload = params.payload as Record<string, unknown>;
          const subId = (rcPayload?.subscriptionId as string | undefined) ?? "";
          if (!subId) {
            result = {
              status: "failed",
              summary: { error: "run_refresh_chain requires subscriptionId" },
            };
            break;
          }
          this._workflowAgent = new WorkflowAgent(this._ctx, this);
          store.updateActivity(actId, { progress: 10 });
          result = await this._workflowAgent.executeRefreshChain(subId);
          this._workflowAgent = null;
          break;
        }

        case "refresh_pool_info":
          result = await this._deduplicator.deduplicate(
            "refresh-pool-info",
            () => this._refreshPoolInfo(),
          );
          break;

        case "refresh_account_info":
          result = await this._deduplicator.deduplicate(
            "refresh-account-info",
            () => this._refreshAccountInfo(),
          );
          break;

        case "retry_failed": {
          const retryAccountIds = store.retryFailedAccounts();
          const retryPoolIds = store.retryFailedPools();

          result = {
            status: "completed",
            summary: {
              retriedAccounts: retryAccountIds.length,
              retriedPools: retryPoolIds.length,
              accountIds: retryAccountIds,
              poolIds: retryPoolIds,
            },
          };

          store.addNotification({
            type: "info",
            message: `Retry queued: ${retryAccountIds.length} accounts, ${retryPoolIds.length} pools`,
          });
          break;
        }

        case "detect_unused_quota":
          result = await this._detectUnusedQuota();
          break;

        case "auto_create_pools_from_quota":
          result = await this._autoCreatePoolsFromQuota(
            params.payload as Record<string, unknown>,
            actId,
          );
          break;

        case "resize_pool":
          result = await this._resizePool(
            params.payload as Record<string, unknown>,
          );
          break;

        case "update_start_task":
          result = await this._updateStartTask(
            params.payload as Record<string, unknown>,
          );
          break;

        case "delete_pool":
          result = await this._deletePool(
            params.payload as Record<string, unknown>,
          );
          break;

        case "reboot_pool_nodes":
          result = await this._rebootPoolNodes(
            params.payload as Record<string, unknown>,
          );
          break;

        case "bulk_node_action":
          result = await this._bulkNodeAction(
            params.payload as Record<string, unknown>,
            actId,
          );
          break;

        case "list_tenants":
          result = await this._listTenants(
            params.payload as Record<string, unknown>,
          );
          break;

        case "switch_tenant":
          result = await this._switchTenant(
            params.payload as Record<string, unknown>,
          );
          break;

        case "list_tenant_users":
          result = await this._listTenantUsers(
            params.payload as Record<string, unknown>,
          );
          break;

        case "check_password_reset_capability":
          result = await this._checkPasswordResetCapability(
            params.payload as Record<string, unknown>,
          );
          break;

        case "reset_user_password":
          result = await this._resetUserPassword(
            params.payload as Record<string, unknown>,
          );
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      const durationMs = Date.now() - startTime;
      store.setAgentStatus("orchestrator", "completed");
      store.addLog({
        agent: "orchestrator",
        level: "info",
        message: `[${correlationId}] Action "${action}" completed in ${durationMs}ms with status: ${result.status}`,
      });

      const finalActivity = store
        .getState()
        .activities.find((a) => a.id === actId);
      const wasCancelling = finalActivity?.status === "cancelling";
      store.updateActivity(actId, {
        status: wasCancelling
          ? "cancelled"
          : result.status === "failed"
            ? "failed"
            : "completed",
        completedAt: new Date().toISOString(),
        progress: 100,
        error:
          result.status === "failed"
            ? ((result.summary as Record<string, unknown>)?.error as string) ??
              "Unknown error"
            : undefined,
      });

      if (stickyTaskId) {
        const summarySnippet = (() => {
          try {
            return JSON.stringify(result.summary).slice(0, 160);
          } catch (err) {
            // Circular references or unserializable values shouldn't
            // crash the orchestrator — but DO log so the lost summary
            // is visible (audit fix #11).
            store.addLog({
              agent: "orchestrator",
              level: "warn",
              message: `[${correlationId}] Could not serialize result.summary for task ${stickyTaskId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
            return undefined;
          }
        })();
        // If the operator hit Pause mid-run, the inner loops set the task
        // to "paused" and bailed out cleanly. We must NOT overwrite that
        // status here with the result-derived status — preserve the pause
        // so the task stays resumable. The summary is still useful (shows
        // partial progress), so write it through.
        const currentStatus = taskRuntime.get(stickyTaskId)?.status;
        if (currentStatus === "paused") {
          taskRuntime.update(stickyTaskId, {
            summary: result.summary,
            progress: summarySnippet,
          });
        } else {
          taskRuntime.update(stickyTaskId, {
            status: wasCancelling
              ? "cancelled"
              : result.status === "completed"
                ? "completed"
                : result.status === "partial"
                  ? "partial"
                  : "failed",
            summary: result.summary,
            progress: summarySnippet,
          });
        }
      }

      return result;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const errorMsg = error?.message ?? String(error);
      store.setAgentStatus("orchestrator", "error");
      store.addLog({
        agent: "orchestrator",
        level: "error",
        message: `[${correlationId}] Action "${action}" failed in ${durationMs}ms: ${errorMsg}`,
      });

      // Mark activity as failed
      store.updateActivity(actId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: errorMsg,
      });

      if (stickyTaskId) {
        taskRuntime.update(stickyTaskId, {
          status: "failed",
          error: errorMsg,
        });
      }

      return {
        status: "failed",
        summary: { error: errorMsg },
      };
    } finally {
      // Release the per-call AbortController so subsequent cancel(actId)
      // calls don't see a stale entry, and so the agent-wide tracker
      // doesn't accumulate references across executions.
      this._activityControllers.delete(actId);
      this._cancellation.end(controller);
      // Suppress "unused variable" warning when the signal isn't read
      // by every branch — sub-agents pick it up via `params.signal`
      // when they support it.
      void agentSignal;
    }
  }

  private async _executeCreatePoolsWithChildren(
    parentId: string,
    payload: Record<string, unknown>,
    stickyTaskId?: string,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const accountIds = (payload.accountIds as string[]) ?? [];
    const poolConfig = (payload.poolConfig as Record<string, unknown>) ?? {};

    if (accountIds.length === 0) {
      return await this._pool.execute(payload);
    }

    // Initialize sticky-task progress counters so the Task Manager can
    // render an ETA/progress bar from tick #1.
    if (stickyTaskId) {
      taskRuntime.tick(stickyTaskId, {
        total: accountIds.length,
        completed: 0,
        failed: 0,
        currentStep: "Preparing…",
      });
    }

    const childIds: string[] = [];
    for (const accountId of accountIds) {
      const account = store.getState().accounts.find((a) => a.id === accountId);
      const target = account
        ? `${account.accountName} (${account.region})`
        : accountId;
      childIds.push(
        store.addChildActivity(parentId, {
          action: "create_pool",
          target,
          status: "pending",
        }),
      );
    }

    let created = 0;
    let failed = 0;
    const failures: Array<{
      accountName: string;
      region: string;
      error: string;
    }> = [];

    for (let i = 0; i < accountIds.length; i++) {
      const childId = childIds[i];
      const accountId = accountIds[i];
      const parent = store.getState().activities.find((a) => a.id === parentId);
      // Cooperative cancellation from the Task Manager UI. Honored at
      // iteration boundaries — already-running per-account work runs to
      // completion before we exit the loop.
      const userCancelled = stickyTaskId
        ? taskRuntime.isCancelRequested(stickyTaskId)
        : false;
      if ((parent && parent.status === "cancelling") || userCancelled) {
        store.updateActivity(childId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
        if (userCancelled) {
          for (let j = i + 1; j < childIds.length; j++) {
            store.updateActivity(childIds[j], {
              status: "cancelled",
              completedAt: new Date().toISOString(),
            });
          }
          break;
        }
        continue;
      }
      // Cooperative pause from the Task Manager UI. Unlike cancel, pause
      // exits the loop without marking children failed/cancelled — they
      // stay queued. The task record's status is already "paused" (set by
      // the operator's Pause click); the post-loop writeback in execute()
      // checks this and skips its own status overwrite so "paused" sticks.
      const userPaused = stickyTaskId
        ? taskRuntime.isPauseRequested(stickyTaskId)
        : false;
      if (userPaused) {
        if (stickyTaskId) {
          taskRuntime.update(stickyTaskId, {
            currentStep: `Paused at ${i + 1}/${accountIds.length}. Click Start to resume.`,
            // Re-assert status in case a tick() in the same animation
            // frame raced ahead and tried to flip back to running.
            status: "paused",
          });
        }
        break;
      }

      await this._waitWhilePaused(parentId);

      const accountForTick = store
        .getState()
        .accounts.find((a) => a.id === accountId);
      const tickLabel = accountForTick
        ? `${accountForTick.accountName} (${accountForTick.region})`
        : accountId;
      if (stickyTaskId) {
        taskRuntime.tick(stickyTaskId, {
          currentStep: `Pool ${i + 1}/${accountIds.length}: ${tickLabel}`,
        });
      }

      store.updateActivity(childId, { status: "running" });
      try {
        const subResult = await this._pool.execute({
          accountIds: [accountId],
          poolConfig,
        });
        const subSummary =
          (subResult.summary as Record<string, unknown> | undefined) ?? {};
        const subFailed = (subSummary.failed as number) ?? 0;
        const subCreated = (subSummary.created as number) ?? 0;
        if (subFailed > 0 || subResult.status === "failed") {
          failed++;
          const subFailures = (subSummary.failures as typeof failures) ?? [];
          if (subFailures[0]) failures.push(subFailures[0]);
          store.updateActivity(childId, {
            status: "failed",
            completedAt: new Date().toISOString(),
            progress: 100,
            error: subFailures[0]?.error ?? "Pool creation failed",
          });
        } else {
          created += subCreated || 1;
          store.updateActivity(childId, {
            status: "completed",
            completedAt: new Date().toISOString(),
            progress: 100,
          });
        }
      } catch (err: any) {
        failed++;
        const msg = err?.message ?? String(err);
        store.updateActivity(childId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: msg,
        });
      }

      store.updateActivity(parentId, {
        progress: 30 + Math.round(((i + 1) / accountIds.length) * 70),
      });
      if (stickyTaskId) {
        taskRuntime.tick(stickyTaskId, {
          completed: created,
          failed,
        });
      }
    }

    return {
      status: failed === 0 ? "completed" : created === 0 ? "failed" : "partial",
      summary: {
        total: accountIds.length,
        created,
        failed,
        failures,
      },
    };
  }

  private async _executeCreatePoolsSmartWithChildren(
    parentId: string,
    args: {
      accountIds: string[];
      vmSizes: string[];
      poolConfig: Record<string, unknown>;
    },
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const { accountIds, vmSizes, poolConfig } = args;

    if (accountIds.length === 0) {
      return await this._pool.executeWithFallback({
        accountIds,
        vmSizes,
        poolConfig,
        quotaType: "lowPriority",
      });
    }

    const childIds: string[] = [];
    for (const accountId of accountIds) {
      const account = store.getState().accounts.find((a) => a.id === accountId);
      const target = account
        ? `${account.accountName} (${account.region})`
        : accountId;
      childIds.push(
        store.addChildActivity(parentId, {
          action: "create_pool_smart",
          target,
          status: "pending",
        }),
      );
    }

    let totalCreated = 0;
    let totalFailed = 0;
    const failures: Array<{
      accountName: string;
      region: string;
      error: string;
    }> = [];

    for (let i = 0; i < accountIds.length; i++) {
      const childId = childIds[i];
      const accountId = accountIds[i];
      const parent = store.getState().activities.find((a) => a.id === parentId);
      if (parent && parent.status === "cancelling") {
        store.updateActivity(childId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      await this._waitWhilePaused(parentId);

      store.updateActivity(childId, { status: "running" });
      try {
        const subResult = await this._pool.executeWithFallback({
          accountIds: [accountId],
          vmSizes,
          poolConfig,
          quotaType: "lowPriority",
        });
        const subSummary =
          (subResult.summary as Record<string, unknown> | undefined) ?? {};
        const subFailed = (subSummary.failed as number) ?? 0;
        const subCreated = (subSummary.created as number) ?? 0;
        if (subFailed > 0 || subResult.status === "failed") {
          totalFailed++;
          const subFailures = (subSummary.failures as typeof failures) ?? [];
          if (subFailures[0]) failures.push(subFailures[0]);
          store.updateActivity(childId, {
            status: "failed",
            completedAt: new Date().toISOString(),
            progress: 100,
            error: subFailures[0]?.error ?? "Pool creation failed",
          });
        } else {
          totalCreated += subCreated || 1;
          store.updateActivity(childId, {
            status: "completed",
            completedAt: new Date().toISOString(),
            progress: 100,
          });
        }
      } catch (err: any) {
        totalFailed++;
        const msg = err?.message ?? String(err);
        store.updateActivity(childId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: msg,
        });
      }

      store.updateActivity(parentId, {
        progress: 20 + Math.round(((i + 1) / accountIds.length) * 80),
      });
    }

    return {
      status:
        totalFailed === 0
          ? "completed"
          : totalCreated === 0
            ? "failed"
            : "partial",
      summary: {
        total: accountIds.length,
        created: totalCreated,
        failed: totalFailed,
        failures,
      },
    };
  }

  private _resolveActivityTarget(
    action: OrchestratorAction,
    payload?: Record<string, unknown>,
  ): string {
    if (!payload) return action;
    switch (action) {
      case "discover_accounts":
        return payload.subscriptionId
          ? `subscription ${(payload.subscriptionId as string).substring(0, 8)}...`
          : "all subscriptions";
      case "create_accounts":
        return `${(payload.regions as string[])?.length ?? 0} regions`;
      case "filter_accounts":
        return "account filter";
      case "create_pools":
        return `${(payload.accountIds as string[])?.length ?? "all"} accounts`;
      case "list_nodes":
        return `pool ${(payload.poolId as string) ?? ""}`;
      case "node_action":
        return `${(payload.action as string) ?? "action"} on nodes`;
      case "delete_nodes":
        return `${(payload.nodeIds as string[])?.length ?? 0} nodes`;
      case "recreate_nodes":
        return `${(payload.nodeIds as string[])?.length ?? 0} nodes`;
      case "recover_preempted":
        return "preempted nodes";
      case "run_workflow":
        return "full workflow";
      case "refresh_pool_info":
        return "all accounts";
      case "refresh_account_info":
        return "all accounts";
      case "retry_failed":
        return "failed items";
      case "detect_unused_quota":
        return "unused quota detection";
      case "auto_create_pools_from_quota":
        return "auto pool creation";
      case "resize_pool":
        return `pool ${(payload.poolId as string) ?? ""}`;
      case "update_start_task":
        return `pool ${(payload.poolId as string) ?? ""}`;
      case "delete_pool":
        return `pool ${(payload.poolId as string) ?? ""}`;
      case "reboot_pool_nodes":
        return `pool ${(payload.poolId as string) ?? ""} nodes`;
      case "bulk_node_action":
        return `${(payload.actionType as string) ?? "action"} all nodes`;
      case "list_tenants":
        return payload.homeAccountId
          ? `account ${(payload.homeAccountId as string).substring(0, 8)}...`
          : "primary account";
      case "switch_tenant":
        return `tenant ${((payload.tenantId as string) ?? "").substring(0, 8)}...`;
      case "list_tenant_users":
        return `tenant ${((payload.tenantId as string) ?? "").substring(0, 8)}...`;
      case "check_password_reset_capability":
        return `tenant ${((payload.tenantId as string) ?? "").substring(0, 8)}...`;
      case "reset_user_password":
        return `user ${((payload.userId as string) ?? "").substring(0, 8)}...`;
      default:
        return action;
    }
  }

  private async _discoverAccountsForSubscription(
    subscriptionId: string,
    token: string,
  ): Promise<any[]> {
    const accounts = await listBatchAccounts(subscriptionId, token);
    return accounts;
  }

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
  private async _discoverAccountsViaArg(
    subscriptionIds: string[],
    token: string,
  ): Promise<Array<{ acct: any; subId: string }> | null> {
    try {
      const result = await listBatchAccountsViaArg(token, subscriptionIds);
      // Map ARG row shape to the same shape `listBatchAccounts` returns
      // so the downstream merge loop doesn't care which path produced
      // the rows. ARG omits the verbose `properties.*` envelope; we
      // reconstruct just the fields downstream code reads.
      return result.rows.map((row) => ({
        subId: row.subscriptionId,
        acct: {
          id: row.id,
          name: row.name,
          type: row.type,
          location: row.location,
          tags: row.tags ?? {},
          properties: {
            poolAllocationMode: row.poolAllocationMode,
            provisioningState: row.provisioningState,
          },
        },
      }));
    } catch (err) {
      const { store } = this._ctx;
      store.addLog({
        agent: "provisioner",
        level: "warn",
        message: `Resource Graph discovery failed (${(err as Error)?.message ?? "unknown"}); falling back to per-subscription enumeration.`,
      });
      return null;
    }
  }

  private async _discoverAccounts(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const subscriptionId = payload.subscriptionId as string | undefined;

    store.setAgentStatus("provisioner", "running");

    try {
      // Per-call ARM-token cache keyed by tenantId. Subs in different
      // tenants need different tokens; this avoids re-acquiring the
      // home-tenant token N times AND the cross-tenant 401 storm that
      // results from reusing one token.
      const armTokenForTenant = this._makeTenantTokenCache((t) =>
        this._getAccessToken(t),
      );
      // Per-sub cache that routes via owning homeAccountId. Used for
      // every cross-sub discovery call — without it, subs owned by
      // non-primary signed-in identities silently return no accounts
      // because the primary's token has no access to them.
      const armTokenForSub = this._makeSubArmTokenCache();
      const token = await armTokenForTenant();

      // Determine which subscriptions to discover
      let subscriptions: Array<{
        subscriptionId: string;
        tenantId?: string;
      }>;

      if (subscriptionId) {
        subscriptions = [{ subscriptionId }];
        store.addLog({
          agent: "provisioner",
          level: "info",
          message: `Discovering Batch accounts in subscription ${subscriptionId.substring(0, 8)}...`,
        });
      } else {
        // Cross-subscription mode: use store subscriptions (populated from MSAL)
        store.addLog({
          agent: "provisioner",
          level: "info",
          message:
            "Fetching all subscriptions for cross-subscription discovery...",
        });

        const stateSubs = store.getState().subscriptions;
        if (stateSubs.length > 0) {
          subscriptions = stateSubs.map((s) => ({
            subscriptionId: s.subscriptionId,
            tenantId: s.tenantId,
          }));
        } else {
          // Fallback: list via ARM SDK (uses the home tenant token).
          // Skip disabled subs (AzureEA, ExpiredEA, Warned, PastDue,
          // Disabled) — we cannot create Batch resources in them.
          const armSubs = await listSubscriptions(token);
          subscriptions = armSubs
            .filter((s) => (s.state ?? "Enabled") === "Enabled")
            .map((s) => ({
              subscriptionId: s.subscriptionId,
              tenantId: s.tenantId,
            }));
        }

        store.addLog({
          agent: "provisioner",
          level: "info",
          message: `Found ${subscriptions.length} subscriptions to discover`,
        });
      }

      const allAccounts: Array<{ acct: any; subId: string }> = [];
      let failedSubs = 0;

      // ARG fast path: ALWAYS use Azure Resource Graph for cross-sub
      // Batch account enumeration. ARG is one POST per tenant — slashes
      // ARM request volume 10×–100× compared to looping
      // `Microsoft.Batch/batchAccounts` per sub. We group subs by tenant
      // (ARG is tenant-scoped), call ARG with each tenant's token, and
      // merge results.
      //
      // The previous version gated this at ≥3 subs; we lifted the gate
      // because ARG with 1 sub is still cheaper than the equivalent
      // paginated GET (single POST, no pagination loop on small result
      // sets) AND keeps the request path uniform — fewer code paths to
      // throttle-tune.
      //
      // Falls back to the per-sub pagination loop if ARG fails for any
      // tenant (RBAC gap, transient 5xx, etc.). The fall-through retains
      // the original behavior; ARG is purely additive.
      let argSucceeded = false;
      if (subscriptions.length >= 1) {
        // Group subs by the (homeAccountId, tenantId) pair that should
        // sign each ARG query. We pull homeAccountId from the store so
        // a browser with multiple signed-in AAD identities fans the
        // discovery out per identity — previously every group got the
        // primary's token, which silently masks subs the primary can't
        // see.
        type ArgGroupKey = {
          homeAccountId?: string;
          tenantId?: string;
        };
        const groupKey = (g: ArgGroupKey) =>
          `${g.homeAccountId ?? "_primary"}::${g.tenantId ?? "_default"}`;
        const stateSubsForOwner = store.getState().subscriptions;
        const byOwner = new Map<
          string,
          {
            key: ArgGroupKey;
            subs: Array<{ subscriptionId: string; tenantId?: string }>;
          }
        >();
        for (const s of subscriptions) {
          const ownerSub = stateSubsForOwner.find(
            (x) => x.subscriptionId === s.subscriptionId,
          );
          const key: ArgGroupKey = {
            homeAccountId: ownerSub?.homeAccountId,
            tenantId: s.tenantId,
          };
          const k = groupKey(key);
          const bucket = byOwner.get(k) ?? { key, subs: [] };
          bucket.subs.push(s);
          byOwner.set(k, bucket);
        }

        // Bounded-concurrency fan-out across owner-groups. Previously a
        // raw Promise.all — fine for the typical 1–2 tenant case, but a
        // user signed into 10+ tenants would fire 10+ parallel ARG
        // POSTs at boot, each of which still chunks subscriptions
        // internally. ARG's per-user budget is 15 queries / 5s — so an
        // unbounded fan-out can self-throttle. Cap to READ_CONCURRENCY
        // (3) which matches the pattern used by `_discoverAccounts`
        // per-sub loop.
        const ownerEntries = Array.from(byOwner.values());
        const argSettled = await pMap(
          ownerEntries,
          async (group) => {
            // Resolve a token for this owner-group. If the group has a
            // homeAccountId, route through MSAL's per-account API via
            // any sub in the group (they all share owner+tenant, so
            // their token is identical). Otherwise fall back to the
            // tenant-only resolver — single-account flows + legacy.
            const tokenForGroup = group.key.homeAccountId
              ? await armTokenForSub(group.subs[0].subscriptionId)
              : await armTokenForTenant(group.key.tenantId);
            return this._discoverAccountsViaArg(
              group.subs.map((s) => s.subscriptionId),
              tokenForGroup,
            );
          },
          READ_CONCURRENCY,
        );
        // Treat any rejection or null result as "ARG path didn't cover
        // every tenant" → fall back to per-sub. The fallback path is
        // already idempotent (it merges into the same `allAccounts`).
        const argResults = argSettled.map((r) =>
          r.status === "fulfilled" ? r.value : null,
        );

        if (argResults.every((r) => r !== null)) {
          for (const r of argResults) {
            if (r) allAccounts.push(...r);
          }
          argSucceeded = true;
          store.addLog({
            agent: "provisioner",
            level: "info",
            message: `Resource Graph discovered ${allAccounts.length} accounts across ${subscriptions.length} subscriptions in ${argResults.length} request(s).`,
          });
        }
      }

      // Per-sub pagination fallback (also runs as the primary path for ≤2 subs).
      // Use the per-sub token cache so each subscription's request is
      // signed with the owning identity's token — same multi-account
      // safety net as the ARG path above.
      const subResults = argSucceeded
        ? null
        : await pMap(
            subscriptions,
            async (sub) => {
              const subToken = await armTokenForSub(sub.subscriptionId);
              const accounts = await this._discoverAccountsForSubscription(
                sub.subscriptionId,
                subToken,
              );
              await new Promise((r) => setTimeout(r, 300)); // throttle between subscriptions
              return {
                subId: sub.subscriptionId,
                accounts,
              };
            },
            READ_CONCURRENCY,
          );

      const disabledSubs: string[] = [];

      // Only iterate the per-sub path when ARG didn't already populate allAccounts.
      for (let i = 0; subResults && i < subResults.length; i++) {
        const settled = subResults[i];
        if (settled.status === "rejected") {
          const errMsg = settled.reason?.message ?? String(settled.reason);
          const subShort = subscriptions[i].subscriptionId.substring(0, 8);

          // Detect disabled/suspended subscriptions
          const isDisabled =
            errMsg.includes("SubscriptionNotFound") ||
            errMsg.includes("subscription is disabled") ||
            errMsg.includes("suspended") ||
            errMsg.includes("suspicious activity") ||
            errMsg.includes("Acceptable Use Policy") ||
            (settled.reason?.status === 403 &&
              errMsg.includes("does not have authorization"));

          if (isDisabled) {
            disabledSubs.push(subscriptions[i].subscriptionId);
            store.addLog({
              agent: "provisioner",
              level: "warn",
              message: `⚠ Subscription ${subShort}... is DISABLED or SUSPENDED — skipping. To reactivate: Azure Portal → Help + Support → New Support Request → Billing → Reactivate Subscription`,
            });
          } else {
            store.addLog({
              agent: "provisioner",
              level: "error",
              message: `Discovery failed for subscription ${subShort}...: ${errMsg}`,
            });
          }
          failedSubs++;
        } else {
          for (const acct of settled.value.accounts) {
            allAccounts.push({
              acct,
              subId: settled.value.subId,
            });
          }
        }
      }

      // Deduplicate against existing accounts in state
      const existingIds = new Set(
        store.getState().accounts.map((a) => a.id.toLowerCase()),
      );
      let imported = 0;

      for (const { acct, subId } of allAccounts) {
        const id = (acct.id as string) ?? "";
        if (existingIds.has(id.toLowerCase())) continue;

        // Parse resource group from the ARM id
        const rgMatch = id.match(/resourceGroups\/([^/]+)/i);
        const resourceGroup = rgMatch ? rgMatch[1] : "unknown";

        store.addAccount({
          id,
          accountName: acct.name,
          resourceGroup,
          subscriptionId: subId,
          region: acct.location,
          provisioningState: "created",
          createdAt: acct.properties?.creationTime ?? new Date().toISOString(),
          error: null,
        });
        imported++;
      }

      store.setAgentStatus("provisioner", "completed");
      store.addLog({
        agent: "provisioner",
        level: "info",
        message: `Discovered ${allAccounts.length} accounts across ${subscriptions.length} subscriptions, imported ${imported} new (${allAccounts.length - imported} already tracked, ${failedSubs} subscriptions failed)`,
      });

      return {
        status:
          failedSubs === 0
            ? "completed"
            : failedSubs === subscriptions.length
              ? "failed"
              : "partial",
        summary: {
          total: allAccounts.length,
          imported,
          skipped: allAccounts.length - imported,
          subscriptionsQueried: subscriptions.length,
          subscriptionsFailed: failedSubs,
        },
      };
    } catch (error: any) {
      const errorMsg = error?.message ?? String(error);
      store.setAgentStatus("provisioner", "error");
      store.addLog({
        agent: "provisioner",
        level: "error",
        message: `Discovery failed: ${errorMsg}`,
      });
      throw error;
    }
  }

  private async _refreshPoolInfo(): Promise<AgentResult> {
    const { store } = this._ctx;
    const state = store.getState();
    const accounts = state.accounts.filter(
      (a) => a.provisioningState === "created",
    );

    store.addLog({
      agent: "orchestrator",
      level: "info",
      message: `Refreshing pool info for ${accounts.length} accounts`,
    });

    let failedCount = 0;
    // Per-subscription Batch token cache. Same multi-account routing
    // logic as the rest of the orchestrator's data-plane calls — the
    // previous tenant-only cache silently served the primary's token
    // to every account, breaking Pool / Account info refresh for any
    // accounts owned by non-primary signed-in identities.
    const batchTokenForSub = this._makeSubBatchTokenCache();

    // Parallel pool fetch with Promise.allSettled via pMap (concurrency=10)
    const poolResults = await pMap(
      accounts,
      async (account) => {
        const token = await batchTokenForSub(account.subscriptionId);
        const endpoint = accountEndpoint(account.accountName, account.region);
        const sdkPools = await listPools(endpoint, token);

        const pools: PoolInfo[] = sdkPools.map((p: SdkBatchPool) => {
          const re: string[] = [];
          if (Array.isArray(p.resizeErrors))
            for (const r of p.resizeErrors)
              re.push(r.message ?? r.code ?? String(r));
          return {
            id: `${account.id}/pools/${p.id}`,
            accountId: account.id,
            accountName: account.accountName,
            region: account.region,
            poolId: p.id ?? "",
            vmSize: p.vmSize ?? "",
            state: p.state ?? "unknown",
            allocationState: p.allocationState ?? "unknown",
            targetDedicatedNodes: p.targetDedicatedNodes ?? 0,
            currentDedicatedNodes: p.currentDedicatedNodes ?? 0,
            targetLowPriorityNodes: p.targetLowPriorityNodes ?? 0,
            currentLowPriorityNodes: p.currentLowPriorityNodes ?? 0,
            taskSlotsPerNode: p.taskSlotsPerNode ?? 1,
            enableAutoScale: p.enableAutoScale ?? false,
            autoScaleFormula: p.autoScaleFormula,
            resizeErrors: re.length > 0 ? re : undefined,
            lastModified: p.lastModified,
            creationTime: p.creationTime,
            startTask: p.startTask ?? undefined,
          };
        });

        await new Promise((r) => setTimeout(r, 100)); // throttle between accounts
        return { account, pools };
      },
      6,
    );

    const allPools: PoolInfo[] = [];
    for (let i = 0; i < poolResults.length; i++) {
      const r = poolResults[i];
      if (r.status === "rejected") {
        const errMsg = r.reason?.message ?? String(r.reason);
        store.addLog({
          agent: "orchestrator",
          level: "error",
          message: `Failed pools for ${accounts[i].accountName}: ${errMsg}`,
        });
        failedCount++;
      } else {
        allPools.push(...r.value.pools);
      }
    }

    store.setPoolInfos(allPools);

    store.addLog({
      agent: "orchestrator",
      level: "info",
      message: `Pool info refreshed: ${allPools.length} pools across ${accounts.length - failedCount} accounts (${failedCount} failed)`,
    });

    return {
      status:
        failedCount === 0
          ? "completed"
          : failedCount === accounts.length
            ? "failed"
            : "partial",
      summary: {
        totalPools: allPools.length,
        accountsQueried: accounts.length,
        accountsFailed: failedCount,
      },
    };
  }

  private async _refreshAccountInfo(): Promise<AgentResult> {
    const { store } = this._ctx;
    const state = store.getState();
    const accounts = state.accounts.filter(
      (a) => a.provisioningState === "created",
    );

    store.addLog({
      agent: "orchestrator",
      level: "info",
      message: `Refreshing account info for ${accounts.length} accounts across all subscriptions`,
    });

    let failedCount = 0;
    // Per-subscription token caches keyed by `subscriptionId`. Routes
    // through MSAL's per-account API for the sub's owning identity —
    // critical for multi-signed-in browsers where two subs in the same
    // tenant can belong to different AAD accounts. The previous
    // tenant-only cache returned the primary's token for everyone,
    // which 401s silently on guest accounts and causes the Pool
    // Creation page to see `lowPriorityCoresFree = 0` for every freshly
    // discovered account.
    const armTokenForSub = this._makeSubArmTokenCache();
    const batchTokenForSub = this._makeSubBatchTokenCache();

    // Sequential account info refresh with low concurrency to avoid 429s
    const acctResults = await pMap(
      accounts,
      async (account) => {
        const rgMatch = account.id.match(/resourceGroups\/([^/]+)/i);
        const resourceGroup = rgMatch ? rgMatch[1] : account.resourceGroup;

        const endpoint = accountEndpoint(account.accountName, account.region);
        const [armToken, batchToken] = await Promise.all([
          armTokenForSub(account.subscriptionId),
          batchTokenForSub(account.subscriptionId),
        ]);

        // Fetch pools then quota sequentially to avoid burst
        const sdkPools = await listPools(endpoint, batchToken);
        const armData = await getBatchAccount(
          account.subscriptionId,
          resourceGroup,
          account.accountName,
          armToken,
        );

        const poolsData = sdkPools.map((p: SdkBatchPool) => ({
          vmSize: p.vmSize ?? "",
          lpNodes: p.currentLowPriorityNodes ?? 0,
          dedNodes: p.currentDedicatedNodes ?? 0,
        }));

        const props = armData.properties ?? {};
        const toNum = (v: unknown) =>
          typeof v === "number" ? v : Number(v) || 0;
        const lowPriorityCoreQuota = toNum(props.lowPriorityCoreQuota);
        const poolQuota = toNum(props.poolQuota);
        const activeJobAndJobScheduleQuota = toNum(
          props.activeJobAndJobScheduleQuota,
        );
        const dedicatedCoreQuotaPerVMFamilyEnforced: boolean =
          props.dedicatedCoreQuotaPerVMFamilyEnforced ?? false;
        const poolCount = poolsData.length;

        // QUOTA ACCURACY: LP cores used = sum(currentLowPriorityNodes * getVCpus(vmSize))
        const lowPriorityCoresUsed = poolsData.reduce(
          (s, p) => s + p.lpNodes * getVCpus(p.vmSize),
          0,
        );

        // Dedicated always 0 (we never create dedicated nodes)
        const dedicatedCoresUsed = 0;

        let dedicatedCoreQuota: number;
        let dedicatedCoreQuotaPerVMFamily:
          | Array<{
              name: string;
              coreQuota: number;
              coresUsed: number;
              coresFree: number;
            }>
          | undefined;
        if (
          dedicatedCoreQuotaPerVMFamilyEnforced &&
          Array.isArray(props.dedicatedCoreQuotaPerVMFamily)
        ) {
          const fqs = props.dedicatedCoreQuotaPerVMFamily as Array<{
            name: string;
            coreQuota: number;
          }>;
          dedicatedCoreQuotaPerVMFamily = fqs.map((fq) => {
            const q = toNum(fq.coreQuota);
            return {
              name: fq.name,
              coreQuota: q,
              coresUsed: 0,
              coresFree: q,
            };
          });
          dedicatedCoreQuota = fqs.reduce(
            (s, fq) => s + toNum(fq.coreQuota),
            0,
          );
        } else {
          dedicatedCoreQuota = toNum(props.dedicatedCoreQuota);
        }

        const info: AccountInfo = {
          id: account.id,
          accountName: account.accountName,
          subscriptionId: account.subscriptionId,
          region: account.region,
          resourceGroup,
          dedicatedCoreQuota,
          lowPriorityCoreQuota,
          poolQuota,
          activeJobAndJobScheduleQuota,
          dedicatedCoresUsed,
          lowPriorityCoresUsed,
          poolCount,
          dedicatedCoresFree: dedicatedCoreQuota - dedicatedCoresUsed,
          lowPriorityCoresFree: lowPriorityCoreQuota - lowPriorityCoresUsed,
          poolsFree: poolQuota - poolCount,
          dedicatedCoreQuotaPerVMFamilyEnforced,
          dedicatedCoreQuotaPerVMFamily,
        };
        return info;
      },
      2,
    );

    // Audit fix #12: when a single account's refresh fails, keep the
    // last-known-good `AccountInfo` so the UI doesn't lose
    // `lowPriorityCoresFree` / quota numbers when ARM hiccups.
    // Only overwrite the `lastError` / `lastRefreshAt` metadata; the
    // happy-path entries replace previous state in full.
    const prevByAccountId = new Map<string, AccountInfo>(
      store.getState().accountInfos.map((a) => [a.id, a]),
    );
    const allAccountInfos: AccountInfo[] = [];
    for (let i = 0; i < acctResults.length; i++) {
      const r = acctResults[i];
      if (r.status === "rejected") {
        const errMsg = r.reason?.message ?? String(r.reason);
        store.addLog({
          agent: "orchestrator",
          level: "error",
          message: `Failed account info for ${accounts[i].accountName}: ${errMsg}`,
        });
        failedCount++;
        const prev = prevByAccountId.get(accounts[i].id);
        if (prev) {
          // Preserve last-known-good quota numbers; only flag the error.
          allAccountInfos.push({
            ...prev,
            lastError: errMsg,
            lastRefreshAt: new Date().toISOString(),
          } as AccountInfo & { lastError?: string; lastRefreshAt?: string });
        }
      } else {
        allAccountInfos.push({
          ...(r.value as AccountInfo),
          lastError: undefined,
          lastRefreshAt: new Date().toISOString(),
        } as AccountInfo & { lastError?: string; lastRefreshAt?: string });
      }
    }

    store.setAccountInfos(allAccountInfos);

    store.addLog({
      agent: "orchestrator",
      level: "info",
      message: `Account info refreshed: ${allAccountInfos.length} accounts (${failedCount} failed)`,
    });

    return {
      status:
        failedCount === 0
          ? "completed"
          : failedCount === accounts.length
            ? "failed"
            : "partial",
      summary: {
        accountsQueried: accounts.length,
        accountsRefreshed: allAccountInfos.length,
        accountsFailed: failedCount,
      },
    };
  }

  private async _detectUnusedQuota(): Promise<AgentResult> {
    const { store } = this._ctx;
    const accountInfos = store.getState().accountInfos;

    const GPU_VMS = [
      { name: "Standard_ND40rs_v2", vCPUs: 40 },
      { name: "Standard_ND96isr_H100_v5", vCPUs: 96 },
      { name: "Standard_NC24s_v3", vCPUs: 24 },
      { name: "Standard_NC12s_v3", vCPUs: 12 },
      { name: "Standard_NC6s_v3", vCPUs: 6 },
    ];

    const accountsWithFreeQuota = accountInfos.filter(
      (a) => a.lowPriorityCoresFree > 0 || a.dedicatedCoresFree > 0,
    );

    const suggestions: QuotaSuggestion[] = [];

    for (const account of accountsWithFreeQuota) {
      for (const vm of GPU_VMS) {
        const maxLpNodes =
          account.lowPriorityCoresFree > 0
            ? Math.floor(account.lowPriorityCoresFree / vm.vCPUs)
            : 0;
        const maxDedicatedNodes =
          account.dedicatedCoresFree > 0
            ? Math.floor(account.dedicatedCoresFree / vm.vCPUs)
            : 0;

        if (maxLpNodes >= 1 || maxDedicatedNodes >= 1) {
          suggestions.push({
            accountId: account.id,
            accountName: account.accountName,
            region: account.region,
            freeLpCores: account.lowPriorityCoresFree,
            freeDedicatedCores: account.dedicatedCoresFree,
            vmSize: vm.name,
            vmSizeVCpus: vm.vCPUs,
            maxLpNodes,
            maxDedicatedNodes,
          });
        }
      }
    }

    store.addLog({
      agent: "orchestrator",
      level: "info",
      message: `Detected ${suggestions.length} quota suggestions across ${accountsWithFreeQuota.length} accounts with free quota`,
    });

    return {
      status: "completed",
      summary: {
        accountsWithFreeQuota: accountsWithFreeQuota.length,
        totalSuggestions: suggestions.length,
        totalFreeLpCores: accountsWithFreeQuota.reduce(
          (s, a) => s + a.lowPriorityCoresFree,
          0,
        ),
        totalFreeDedicatedCores: accountsWithFreeQuota.reduce(
          (s, a) => s + a.dedicatedCoresFree,
          0,
        ),
        suggestions,
      },
    };
  }

  private async _autoCreatePoolsFromQuota(
    payload: Record<string, unknown>,
    parentId?: string,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const suggestions = payload.suggestions as QuotaSuggestion[];

    if (!suggestions || suggestions.length === 0) {
      return {
        status: "completed",
        summary: {
          created: 0,
          failed: 0,
          message: "No suggestions provided",
        },
      };
    }

    store.addLog({
      agent: "orchestrator",
      level: "info",
      message: `Auto-creating pools from ${suggestions.length} quota suggestions`,
    });

    let created = 0;
    let failed = 0;

    const childIds: string[] = [];
    if (parentId) {
      for (const suggestion of suggestions) {
        childIds.push(
          store.addChildActivity(parentId, {
            action: "auto_create_pool",
            target: `${suggestion.accountName} (${suggestion.vmSize})`,
            status: "pending",
          }),
        );
      }
    }

    // Sequential write operations with rate limiting
    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i];
      const childId = childIds[i];

      if (parentId) {
        const parent = store
          .getState()
          .activities.find((a) => a.id === parentId);
        if (parent && parent.status === "cancelling") {
          if (childId)
            store.updateActivity(childId, {
              status: "cancelled",
              completedAt: new Date().toISOString(),
            });
          continue;
        }
        await this._waitWhilePaused(parentId);
      }

      if (childId) store.updateActivity(childId, { status: "running" });

      try {
        const token = await this._getBatchTokenForAccount(suggestion.accountId);
        const vmSizeShort = suggestion.vmSize
          .replace(/^Standard_/i, "")
          .replace(/_/g, "")
          .toLowerCase();
        const random4 = Math.random().toString(36).substring(2, 6);
        const poolId = `auto-${vmSizeShort}-${random4}`;

        const account = store
          .getState()
          .accounts.find((a) => a.id === suggestion.accountId);
        if (!account) {
          throw new Error(`Account ${suggestion.accountId} not found`);
        }

        // SAFETY: Never create dedicated nodes — always LP only
        const poolBody: Record<string, unknown> = {
          id: poolId,
          vmSize: suggestion.vmSize,
          targetDedicatedNodes: 0,
          targetLowPriorityNodes: suggestion.maxLpNodes,
          virtualMachineConfiguration: {
            imageReference: {
              publisher: "microsoft-azure-batch",
              offer: "ubuntu-server-container",
              sku: "20-04-lts",
              version: "latest",
            },
            nodeAgentSKUId: "batch.node.ubuntu 20.04",
          },
          taskSlotsPerNode: suggestion.vmSizeVCpus,
        };

        // Pre-flight: verify Batch supports this VM SKU in this region.
        // Batch maintains a narrower supported list than Microsoft.Compute,
        // so users picking from the global VM picker still need this gate.
        // Failure populates the blacklist so we don't re-probe next time.
        try {
          const tenantId = this._resolveSubTenant(account.subscriptionId);
          const armToken = await this._getAccessToken(tenantId);
          const supported = await isVmSupportedByBatchInRegion(
            account.subscriptionId,
            account.region,
            suggestion.vmSize,
            armToken,
          );
          if (!supported) {
            const reason = `Batch does not support ${suggestion.vmSize} in ${account.region} (per Microsoft.Batch/locations/{loc}/virtualMachineSkus).`;
            addToBlacklist(suggestion.vmSize, account.region, reason);
            throw new Error(reason);
          }
        } catch (err) {
          // SKU probe failure with our own thrown reason → propagate.
          // ARM 4xx/5xx on the probe → fall through (fail-open), but
          // emit a structured log so the lost error is visible (audit
          // fix #11 — previous bare `catch {}` swallowed it silently).
          if ((err as Error)?.message?.startsWith("Batch does not support")) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          store.addLog({
            agent: "orchestrator",
            level: "warn",
            message: `VM SKU pre-flight probe failed (fail-open) for ${suggestion.vmSize} in ${account.region}: ${msg}`,
          });
        }

        const endpoint = accountEndpoint(account.accountName, account.region);
        await createPool(endpoint, poolBody, token);
        await new Promise((r) => setTimeout(r, 1000)); // throttle between pool creates

        store.addLog({
          agent: "orchestrator",
          level: "info",
          message: `Created pool ${poolId} in ${account.accountName} (${suggestion.vmSize}, ${suggestion.maxLpNodes} LP nodes)`,
        });
        created++;
        if (childId)
          store.updateActivity(childId, {
            status: "completed",
            completedAt: new Date().toISOString(),
            progress: 100,
          });
      } catch (error: any) {
        const errorMsg = error?.message ?? String(error);
        store.addLog({
          agent: "orchestrator",
          level: "error",
          message: `Failed to create pool for ${suggestion.accountName}: ${errorMsg}`,
        });
        failed++;
        if (childId)
          store.updateActivity(childId, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: errorMsg,
          });
      }

      if (parentId) {
        store.updateActivity(parentId, {
          progress: Math.round(((i + 1) / suggestions.length) * 100),
        });
      }
    }

    store.addNotification({
      type: failed === 0 ? "success" : "warning",
      message: `Auto-created ${created} pools (${failed} failed)`,
    });

    return {
      status: failed === 0 ? "completed" : created === 0 ? "failed" : "partial",
      summary: { created, failed, total: suggestions.length },
    };
  }

  private async _deleteNodes(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const nodeIds = payload.nodeIds as string[];

    store.setAgentStatus("node", "running");
    store.addLog({
      agent: "node",
      level: "info",
      message: `Deleting ${nodeIds.length} nodes (grouped by pool)`,
    });

    const state = store.getState();
    // Audit fix #23 + #4: use the shared `groupNodesByPool` primitive
    // AND a per-sub Batch token cache (the previous tenant-keyed cache
    // handed the primary's token to every group, 401-ing on accounts
    // owned by non-primary signed-in AAD identities).
    const targetNodes = nodeIds
      .map((id) => state.nodes.find((n) => n.id === id))
      .filter((n): n is NodeForGrouping => !!n);
    const accountIndex: AccountForGrouping[] = state.accounts;
    const groups = groupNodesByPool(targetNodes, accountIndex);

    // Diagnostic: input nodeIds didn't match any cached node OR matched
    // nodes weren't groupable (account missing from accountIndex). Either
    // way, returning `status:"completed"` would be a lie — surface as a
    // typed failure so the activity card shows the real reason.
    if (groups.size === 0) {
      const reason =
        targetNodes.length === 0
          ? `0 of ${nodeIds.length} input node ids matched any cached node — refresh nodes and retry`
          : `${targetNodes.length} nodes matched but none could be grouped (their owning accounts aren't in the cached account list) — refresh accounts and retry`;
      store.addLog({ agent: "node", level: "error", message: reason });
      store.setAgentStatus("node", "error");
      store.addNotification({ type: "error", message: reason });
      return {
        status: "failed",
        summary: {
          total: nodeIds.length,
          succeeded: 0,
          failed: nodeIds.length,
          error: reason,
          failures: [],
        },
      };
    }

    const batchTokenForSub = this._makeSubBatchTokenCache();

    let succeeded = 0;
    let failed = 0;
    // Collect every per-group failure with its classification so the
    // orchestrator's activity card can render the actual reason instead
    // of the literal "Unknown error" fallback.
    const failures: Array<{
      account: string;
      poolId: string;
      count: number;
      reason: string;
      classification: string;
    }> = [];

    // Sequential write operations
    for (const [, group] of groups) {
      const account = state.accounts.find((a) => a.id === group.accountId);
      const subId = account?.subscriptionId ?? "";
      try {
        const token = subId
          ? await batchTokenForSub(subId)
          : await this._getBatchTokenForAccount(group.accountId);
        const endpoint = accountEndpoint(group.accountName, group.region);
        await removeNodes(endpoint, group.poolId, group.nodeIds, token);

        for (const internalId of group.internalIds) {
          store.removeNode(internalId);
        }
        succeeded += group.nodeIds.length;

        store.addLog({
          agent: "node",
          level: "info",
          message: `Removed ${group.nodeIds.length} nodes from pool ${group.poolId} in ${group.accountName}`,
        });

        this._audit.record({
          action: "node_delete",
          target: `${group.accountName}/${group.poolId}`,
          status: "success",
          details: {
            accountId: group.accountId,
            poolId: group.poolId,
            count: group.nodeIds.length,
          },
        });
      } catch (error: any) {
        const errorMsg = error?.message ?? String(error);
        const classification = classifyAzureError(error).kind;
        store.addLog({
          agent: "node",
          level: "error",
          message: `Failed to remove nodes from pool ${group.poolId} in ${group.accountName}: ${errorMsg}`,
        });
        failed += group.nodeIds.length;
        failures.push({
          account: group.accountName,
          poolId: group.poolId,
          count: group.nodeIds.length,
          reason: errorMsg,
          classification,
        });
        this._audit.record({
          action: "node_delete",
          target: `${group.accountName}/${group.poolId}`,
          status: "failure",
          error: errorMsg,
          details: {
            accountId: group.accountId,
            poolId: group.poolId,
            count: group.nodeIds.length,
            classification,
          },
        });
      }
    }

    store.setAgentStatus("node", failed > 0 ? "error" : "completed");
    store.addNotification({
      type: failed === 0 ? "success" : "warning",
      message: `Deleted ${succeeded} node(s), ${failed} failed`,
    });

    // Build a condensed, operator-readable error string for the activity
    // card. Group identical reasons so 200 identical 401s show once.
    const error = failed > 0 ? this._condenseFailureReasons(failures) : undefined;

    return {
      status:
        failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial",
      summary: { total: nodeIds.length, succeeded, failed, failures, error },
    };
  }

  private async _recreateNodes(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const nodeIds = payload.nodeIds as string[];

    store.setAgentStatus("node", "running");
    store.addLog({
      agent: "node",
      level: "info",
      message: `Recreating ${nodeIds.length} nodes (remove then restore pool targets)`,
    });

    const state = store.getState();
    // Audit fix #23 + #4 (same as _deleteNodes).
    const targetNodes = nodeIds
      .map((id) => state.nodes.find((n) => n.id === id))
      .filter((n): n is NodeForGrouping => !!n);
    const accountIndex: AccountForGrouping[] = state.accounts;
    const groups = groupNodesByPool(targetNodes, accountIndex);

    // Same defensive diagnostic as `_deleteNodes`: 0 groups from a non-
    // empty input means the cache is stale — say so explicitly rather
    // than silently no-op.
    if (groups.size === 0) {
      const reason =
        targetNodes.length === 0
          ? `0 of ${nodeIds.length} input node ids matched any cached node — refresh nodes and retry`
          : `${targetNodes.length} nodes matched but none could be grouped (their owning accounts aren't in the cached account list) — refresh accounts and retry`;
      store.addLog({ agent: "node", level: "error", message: reason });
      store.setAgentStatus("node", "error");
      store.addNotification({ type: "error", message: reason });
      return {
        status: "failed",
        summary: {
          total: nodeIds.length,
          succeeded: 0,
          failed: nodeIds.length,
          error: reason,
          failures: [],
        },
      };
    }

    const batchTokenForSub = this._makeSubBatchTokenCache();

    let succeeded = 0;
    let failed = 0;
    const failures: Array<{
      account: string;
      poolId: string;
      count: number;
      reason: string;
      classification: string;
    }> = [];

    // Sequential write operations
    for (const [, group] of groups) {
      const account = state.accounts.find((a) => a.id === group.accountId);
      const subId = account?.subscriptionId ?? "";
      try {
        const token = subId
          ? await batchTokenForSub(subId)
          : await this._getBatchTokenForAccount(group.accountId);
        const endpoint = accountEndpoint(group.accountName, group.region);

        // Get current pool targets before removing nodes
        const sdkPools = await listPools(endpoint, token);
        const poolData = sdkPools.find((p) => p.id === group.poolId);
        const originalTargetLowPriority = poolData?.targetLowPriorityNodes ?? 0;

        // Remove the nodes
        await removeNodes(endpoint, group.poolId, group.nodeIds, token);

        // SAFETY: Always force targetDedicatedNodes=0 when restoring pool targets
        try {
          await patchPool(
            endpoint,
            group.poolId,
            {
              targetDedicatedNodes: 0,
              targetLowPriorityNodes: originalTargetLowPriority,
            },
            token,
          );
        } catch (patchErr: any) {
          store.addLog({
            agent: "node",
            level: "warn",
            message: `Nodes removed but failed to restore pool targets for ${group.poolId}: ${patchErr?.message ?? patchErr}`,
          });
        }

        for (const internalId of group.internalIds) {
          store.removeNode(internalId);
        }
        succeeded += group.nodeIds.length;

        store.addLog({
          agent: "node",
          level: "info",
          message: `Recreating ${group.nodeIds.length} nodes in pool ${group.poolId} (targets restored: dedicated=0, lowPriority=${originalTargetLowPriority})`,
        });

        // Audit success — _deleteNodes had this; _recreateNodes was
        // missing it, so successful recreations didn't show in the
        // audit log table even after the broader audit wiring landed.
        this._audit.record({
          action: "node_recreate",
          target: `${group.accountName}/${group.poolId}`,
          status: "success",
          details: {
            accountId: group.accountId,
            poolId: group.poolId,
            count: group.nodeIds.length,
            restoredTargetLowPriority: originalTargetLowPriority,
          },
        });
      } catch (error: any) {
        const errorMsg = error?.message ?? String(error);
        const classification = classifyAzureError(error).kind;
        store.addLog({
          agent: "node",
          level: "error",
          message: `Failed to recreate nodes in pool ${group.poolId}: ${errorMsg}`,
        });
        failed += group.nodeIds.length;
        failures.push({
          account: group.accountName,
          poolId: group.poolId,
          count: group.nodeIds.length,
          reason: errorMsg,
          classification,
        });
        this._audit.record({
          action: "node_recreate",
          target: `${group.accountName}/${group.poolId}`,
          status: "failure",
          error: errorMsg,
          details: {
            accountId: group.accountId,
            poolId: group.poolId,
            count: group.nodeIds.length,
            classification,
          },
        });
      }
    }

    store.setAgentStatus("node", failed > 0 ? "error" : "completed");
    store.addNotification({
      type: failed === 0 ? "success" : "warning",
      message: `Recreating ${succeeded} node(s), ${failed} failed`,
    });

    const error = failed > 0 ? this._condenseFailureReasons(failures) : undefined;

    return {
      status:
        failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial",
      summary: { total: nodeIds.length, succeeded, failed, failures, error },
    };
  }

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
  private _condenseFailureReasons(
    failures: Array<{
      account: string;
      poolId: string;
      count: number;
      reason: string;
      classification: string;
    }>,
  ): string {
    if (failures.length === 0) return "Failed (no detail captured)";
    // Group by (classification, normalized reason) so repeated identical
    // errors collapse. Normalize reason by trimming long token / GUID
    // strings that would otherwise look distinct across pools.
    const buckets = new Map<
      string,
      { reason: string; classification: string; pools: number; nodes: number }
    >();
    for (const f of failures) {
      const normalized = f.reason
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      const key = `${f.classification}|${normalized}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.pools += 1;
        existing.nodes += f.count;
      } else {
        buckets.set(key, {
          reason: normalized,
          classification: f.classification,
          pools: 1,
          nodes: f.count,
        });
      }
    }
    const sorted = [...buckets.values()].sort((a, b) => b.nodes - a.nodes);
    const parts = sorted.map(
      (b) =>
        `${b.reason} (${b.pools} pool${b.pools === 1 ? "" : "s"}, ${b.nodes} node${b.nodes === 1 ? "" : "s"}; ${b.classification})`,
    );
    const prefix = sorted.length === 1 ? "" : `${sorted.length} distinct failures: `;
    const full = prefix + parts.join("; ");
    return full.length > 280 ? full.slice(0, 277) + "…" : full;
  }

  private async _recoverPreempted(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const nodeIds = (payload.nodeIds as string[] | undefined) ?? [];

    store.setAgentStatus("node", "running");

    const state = store.getState();

    const preemptedNodes =
      nodeIds.length > 0
        ? state.nodes.filter(
            (n) => nodeIds.includes(n.id) && n.state === "preempted",
          )
        : state.nodes.filter((n) => n.state === "preempted");

    if (preemptedNodes.length === 0) {
      store.setAgentStatus("node", "completed");
      store.addLog({
        agent: "node",
        level: "info",
        message: "No preempted nodes found to recover",
      });
      return { status: "completed", summary: { total: 0, recovered: 0 } };
    }

    store.addLog({
      agent: "node",
      level: "info",
      message: `Recovering ${preemptedNodes.length} preempted nodes across pools`,
    });

    const poolGroups = new Map<
      string,
      {
        accountId: string;
        accountName: string;
        region: string;
        poolId: string;
        count: number;
      }
    >();
    for (const node of preemptedNodes) {
      const key = `${node.accountId}||${node.poolId}`;
      if (!poolGroups.has(key)) {
        poolGroups.set(key, {
          accountId: node.accountId,
          accountName: node.accountName,
          region: node.region,
          poolId: node.poolId,
          count: 0,
        });
      }
      poolGroups.get(key)!.count++;
    }

    let succeeded = 0;
    let failed = 0;

    // Per-sub Batch token cache — audit fix #4 (same rationale as
    // _deleteNodes / _recreateNodes).
    const batchTokenForSub = this._makeSubBatchTokenCache();

    // Sequential write operations
    for (const [, group] of poolGroups) {
      const account = this._ctx.store
        .getState()
        .accounts.find((a) => a.id === group.accountId);
      const subId = account?.subscriptionId ?? "";
      try {
        const token = subId
          ? await batchTokenForSub(subId)
          : await this._getBatchTokenForAccount(group.accountId);
        const endpoint = accountEndpoint(group.accountName, group.region);

        // Get current pool targets
        const sdkPools = await listPools(endpoint, token);
        const poolData = sdkPools.find((p) => p.id === group.poolId);
        const targetLowPriority = poolData?.targetLowPriorityNodes ?? 0;

        // Re-apply the same target to trigger re-allocation of preempted nodes
        await patchPool(
          endpoint,
          group.poolId,
          {
            targetLowPriorityNodes: targetLowPriority,
          },
          token,
        );

        succeeded += group.count;
        store.addLog({
          agent: "node",
          level: "info",
          message: `Recovery triggered for pool ${group.poolId} in ${group.accountName} (targetLowPriority=${targetLowPriority}, ${group.count} preempted nodes)`,
        });
      } catch (error: any) {
        const errorMsg = error?.message ?? String(error);
        store.addLog({
          agent: "node",
          level: "error",
          message: `Failed to recover preempted nodes in pool ${group.poolId}: ${errorMsg}`,
        });
        failed += group.count;
      }
    }

    store.setAgentStatus("node", failed > 0 ? "error" : "completed");
    store.addNotification({
      type: failed === 0 ? "success" : "warning",
      message: `Preempted recovery: ${succeeded} nodes in ${poolGroups.size} pools, ${failed} failed`,
    });

    return {
      status:
        failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial",
      summary: {
        total: preemptedNodes.length,
        succeeded,
        failed,
        poolsAffected: poolGroups.size,
      },
    };
  }

  // Expose child agents for direct access from UI
  get provisioner(): ProvisionerAgent {
    return this._provisioner;
  }
  get filter(): FilterAgent {
    return this._filter;
  }
  get pool(): PoolAgent {
    return this._pool;
  }
  get node(): NodeAgent {
    return this._node;
  }

  private async _resizePool(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const account = store
      .getState()
      .accounts.find((a) => a.id === payload.accountId);
    if (!account) {
      throw new Error(`Account not found: ${payload.accountId}`);
    }

    const token = await this._getBatchTokenForAccount(account.id);
    const endpoint = accountEndpoint(account.accountName, account.region);

    // SAFETY: Always force targetDedicatedNodes=0
    const body: Record<string, unknown> = {
      targetDedicatedNodes: 0,
    };
    if (payload.targetLowPriorityNodes !== undefined) {
      body.targetLowPriorityNodes = payload.targetLowPriorityNodes;
    }

    await patchPool(endpoint, payload.poolId as string, body, token);

    store.addNotification({
      type: "success",
      message: `Pool ${payload.poolId} resize requested successfully`,
    });

    return {
      status: "completed",
      summary: {
        poolId: payload.poolId,
        accountId: payload.accountId,
        targetDedicatedNodes: 0,
        targetLowPriorityNodes: payload.targetLowPriorityNodes,
      },
    };
  }

  private async _updateStartTask(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const poolId = payload.poolId as string;
    const accountId = payload.accountId as string;

    const account = store.getState().accounts.find((a) => a.id === accountId);
    if (!account) {
      // Fallback: try matching by poolInfos accountId
      const poolInfo = store
        .getState()
        .poolInfos.find((p) => p.poolId === poolId);
      if (poolInfo) {
        const fallbackAccount = store
          .getState()
          .accounts.find((a) => a.id === poolInfo.accountId);
        if (fallbackAccount) {
          return this._updateStartTaskForAccount(
            fallbackAccount,
            poolId,
            payload.startTask,
          );
        }
      }
      throw new Error(`Account not found: ${accountId} (pool: ${poolId})`);
    }

    return this._updateStartTaskForAccount(account, poolId, payload.startTask);
  }

  private async _updateStartTaskForAccount(
    account: { id?: string; accountName: string; region: string },
    poolId: string,
    startTask: unknown,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const token = account.id
      ? await this._getBatchTokenForAccount(account.id)
      : await this._getBatchAccessToken();
    const endpoint = accountEndpoint(account.accountName, account.region);

    store.addLog({
      agent: "orchestrator",
      level: "info",
      message: `Updating start task on ${account.accountName}/${poolId}`,
    });

    await patchPool(endpoint, poolId, { startTask }, token);

    // Also update the pool info in the store so UI reflects change immediately
    const poolInfos = store.getState().poolInfos;
    const poolInfoIdx = poolInfos.findIndex((p) => p.poolId === poolId);
    if (poolInfoIdx >= 0) {
      const updated = [...poolInfos];
      updated[poolInfoIdx] = {
        ...updated[poolInfoIdx],
        startTask: startTask as Record<string, unknown>,
      };
      store.setPoolInfos(updated);
    }

    store.addNotification({
      type: "success",
      message: `Pool ${poolId} start task updated on ${account.accountName}`,
    });

    return {
      status: "completed",
      summary: {
        poolId,
        accountName: account.accountName,
      },
    };
  }

  /**
   * Delete a pool by account ID and pool ID.
   * Used by the "Remove Empty Pools" feature.
   */
  private async _deletePool(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const account = store
      .getState()
      .accounts.find((a) => a.id === payload.accountId);
    if (!account) {
      throw new Error(`Account not found: ${payload.accountId}`);
    }

    const token = await this._getBatchTokenForAccount(account.id);
    const endpoint = accountEndpoint(account.accountName, account.region);

    try {
      await deletePool(endpoint, payload.poolId as string, token);
    } catch (err) {
      this._audit.record({
        action: "pool_delete",
        target: `${account.accountName}/${payload.poolId}`,
        status: "failure",
        error: err instanceof Error ? err.message : String(err),
        details: {
          accountId: account.id,
          poolId: payload.poolId,
          classification: classifyAzureError(err).kind,
        },
      });
      throw err;
    }

    this._audit.record({
      action: "pool_delete",
      target: `${account.accountName}/${payload.poolId}`,
      status: "success",
      details: { accountId: account.id, poolId: payload.poolId },
    });

    store.addNotification({
      type: "success",
      message: `Pool ${payload.poolId} deleted from ${account.accountName}`,
    });

    // Remove from poolInfos in store
    const currentInfos = store.getState().poolInfos;
    const filtered = currentInfos.filter(
      (p) =>
        !(p.poolId === payload.poolId && p.accountId === payload.accountId),
    );
    if (filtered.length !== currentInfos.length) {
      store.setPoolInfos(filtered);
    }

    return {
      status: "completed",
      summary: {
        poolId: payload.poolId,
        accountId: payload.accountId,
        deleted: true,
      },
    };
  }

  /**
   * Reboot ALL nodes in a pool. Called after updating the start task
   * so nodes pick up the new configuration.
   *
   * Lists nodes via the Batch API (not from store — store may be stale),
   * then reboots each one. Nodes in non-rebootable states are skipped.
   */
  private async _rebootPoolNodes(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const account = store
      .getState()
      .accounts.find((a) => a.id === payload.accountId);
    if (!account) {
      throw new Error(`Account not found: ${payload.accountId}`);
    }

    const token = await this._getBatchTokenForAccount(account.id);
    const endpoint = accountEndpoint(account.accountName, account.region);
    const poolId = payload.poolId as string;

    // List actual nodes from the Batch API (not store)
    const nodes = await listNodes(endpoint, poolId, token);

    if (!nodes || nodes.length === 0) {
      store.addNotification({
        type: "warning",
        message: `Pool ${poolId}: no nodes to reboot`,
      });
      return {
        status: "completed",
        summary: { poolId, rebooted: 0, total: 0 },
      };
    }

    let rebooted = 0;
    let skipped = 0;
    let failed = 0;

    for (const node of nodes) {
      const nodeId = node.id;
      if (!nodeId) continue;

      // Skip nodes in states that can't be rebooted
      const nodeState = node.state?.toLowerCase();
      if (
        nodeState === "creating" ||
        nodeState === "starting" ||
        nodeState === "leavingpool" ||
        nodeState === "offline" ||
        nodeState === "unusable"
      ) {
        skipped++;
        continue;
      }

      try {
        await performNodeAction(endpoint, poolId, nodeId, "reboot", token);
        rebooted++;
      } catch (err) {
        failed++;
        store.addLog({
          agent: "orchestrator",
          level: "warn",
          message: `Failed to reboot node ${nodeId}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    store.addNotification({
      type: "success",
      message: `Pool ${poolId}: rebooted ${rebooted}/${nodes.length} nodes${skipped > 0 ? ` (${skipped} skipped)` : ""}${failed > 0 ? ` (${failed} failed)` : ""}`,
    });

    return {
      status: "completed",
      summary: {
        poolId,
        rebooted,
        skipped,
        failed,
        total: nodes.length,
      },
    };
  }

  /**
   * Bulk node action — applies reboot/reimage/disableScheduling/enableScheduling
   * to ALL nodes across ALL pools, grouped by account+pool.
   *
   * Unlike the per-node node_action (which processes store ManagedNode IDs
   * one by one through the scheduler), this calls the Batch API directly
   * per pool using listNodes + performNodeAction. Much faster for hundreds
   * of nodes.
   */
  private async _bulkNodeAction(
    payload: Record<string, unknown>,
    parentId?: string,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const actionType = payload.actionType as string;

    if (
      actionType !== "reboot" &&
      actionType !== "reimage" &&
      actionType !== "disableScheduling" &&
      actionType !== "enableScheduling"
    ) {
      throw new Error(`Invalid bulk action type: ${actionType}`);
    }

    // Group nodes from store by accountId + poolId
    const nodeIds = payload.nodeIds as string[] | undefined;
    const storeNodes = store.getState().nodes;
    const targetNodes = nodeIds
      ? storeNodes.filter((n) => nodeIds.includes(n.id))
      : storeNodes;

    // Group by account → pool → nodeIds (Batch API node IDs, not store IDs)
    const groups = new Map<
      string,
      {
        accountId: string;
        account: { accountName: string; region: string };
        pools: Map<string, string[]>;
      }
    >();

    for (const node of targetNodes) {
      const account = store
        .getState()
        .accounts.find((a) => a.id === node.accountId);
      if (!account) continue;

      if (!groups.has(node.accountId)) {
        groups.set(node.accountId, {
          accountId: node.accountId,
          account: {
            accountName: account.accountName,
            region: account.region,
          },
          pools: new Map(),
        });
      }
      const group = groups.get(node.accountId)!;
      if (!group.pools.has(node.poolId)) {
        group.pools.set(node.poolId, []);
      }
      group.pools.get(node.poolId)!.push(node.nodeId);
    }

    let totalActioned = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let totalNodes = 0;

    // Audit fix #4: per-SUBSCRIPTION Batch token cache. The previous
    // tenant-keyed cache handed the primary's token to every group,
    // 401-ing silently on bulk actions targeting accounts owned by a
    // non-primary signed-in identity.
    const batchTokenForSub = this._makeSubBatchTokenCache();

    const totalGroups = Array.from(groups.values()).reduce(
      (sum, g) => sum + g.pools.size,
      0,
    );
    let groupsProcessed = 0;

    for (const [, group] of groups) {
      const ownerSub = store
        .getState()
        .accounts.find((a) => a.id === group.accountId)?.subscriptionId;
      const token = ownerSub
        ? await batchTokenForSub(ownerSub)
        : await this._getBatchTokenForAccount(group.accountId);
      const endpoint = accountEndpoint(
        group.account.accountName,
        group.account.region,
      );

      for (const [poolId, batchNodeIds] of group.pools) {
        if (parentId) {
          const parent = store
            .getState()
            .activities.find((a) => a.id === parentId);
          if (parent && parent.status === "cancelling") {
            groupsProcessed++;
            continue;
          }
          await this._waitWhilePaused(parentId);
        }

        const childId = parentId
          ? store.addChildActivity(parentId, {
              action: actionType,
              target: `${group.account.accountName}/${poolId}`,
              status: "running",
            })
          : null;

        store.addLog({
          agent: "orchestrator",
          level: "info",
          message: `${actionType} ${batchNodeIds.length} nodes in ${group.account.accountName}/${poolId}`,
        });

        // Use Batch API listNodes to get current state (store may be stale)
        let liveNodes: Array<{ id: string; state?: string }>;
        try {
          liveNodes = await listNodes(endpoint, poolId, token);
        } catch {
          // Fallback: use the store node IDs
          liveNodes = batchNodeIds.map((id) => ({
            id,
            state: "idle",
          }));
        }

        // Filter to only nodes in our selection
        const batchNodeIdSet = new Set(batchNodeIds);
        const targetLiveNodes = liveNodes.filter((n) =>
          batchNodeIdSet.has(n.id),
        );

        let groupActioned = 0;
        let groupFailed = 0;

        for (const node of targetLiveNodes) {
          totalNodes++;
          const nodeState = node.state?.toLowerCase() ?? "";

          // Skip non-actionable states
          if (
            nodeState === "creating" ||
            nodeState === "starting" ||
            nodeState === "leavingpool" ||
            nodeState === "unusable"
          ) {
            totalSkipped++;
            continue;
          }

          if (parentId) {
            const parent = store
              .getState()
              .activities.find((a) => a.id === parentId);
            if (parent && parent.status === "cancelling") {
              break;
            }
            await this._waitWhilePaused(parentId);
          }

          try {
            await performNodeAction(
              endpoint,
              poolId,
              node.id,
              actionType as
                | "reboot"
                | "reimage"
                | "disableScheduling"
                | "enableScheduling",
              token,
            );
            await new Promise((r) => setTimeout(r, 50)); // throttle between nodes
            totalActioned++;
            groupActioned++;
          } catch (err) {
            totalFailed++;
            groupFailed++;
            // Audit fix #18: pre-classify the error so callers and the
            // audit log get a structured `kind` field instead of just
            // the raw message. Helps the dashboard surface
            // "permission-denied" vs "quota" vs "transient" rather than
            // a wall of identical "Failed reboot on …" lines.
            const classified = classifyAzureError(err);
            store.addLog({
              agent: "orchestrator",
              level: "warn",
              message: `Failed ${actionType} on ${node.id} [${classified.kind}]: ${err instanceof Error ? err.message : String(err)}`,
            });
            this._audit.record({
              action: `node_${actionType}`,
              target: `${group.account.accountName}/${poolId}/${node.id}`,
              status: "failure",
              error: classified.reason,
              details: {
                accountId: group.accountId,
                poolId,
                nodeId: node.id,
                classification: classified.kind,
              },
            });
          }
        }

        if (childId) {
          store.updateActivity(childId, {
            status:
              groupFailed > 0 && groupActioned === 0 ? "failed" : "completed",
            completedAt: new Date().toISOString(),
            progress: 100,
            error:
              groupFailed > 0 ? `${groupFailed} node(s) failed` : undefined,
          });
        }

        groupsProcessed++;
        if (parentId && totalGroups > 0) {
          store.updateActivity(parentId, {
            progress: Math.round((groupsProcessed / totalGroups) * 100),
          });
        }
      }
    }

    const label =
      actionType === "reboot"
        ? "Rebooted"
        : actionType === "reimage"
          ? "Reimaged"
          : actionType === "disableScheduling"
            ? "Disabled scheduling on"
            : "Enabled scheduling on";

    store.addNotification({
      type: totalFailed === 0 ? "success" : "warning",
      message: `${label} ${totalActioned}/${totalNodes} nodes${totalSkipped > 0 ? ` (${totalSkipped} skipped)` : ""}${totalFailed > 0 ? ` (${totalFailed} failed)` : ""}`,
    });

    return {
      status: "completed",
      summary: {
        actionType,
        actioned: totalActioned,
        skipped: totalSkipped,
        failed: totalFailed,
        total: totalNodes,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Multi-tenant + Microsoft Graph actions
  // -----------------------------------------------------------------------

  private async _listTenants(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const homeAccountId = payload.homeAccountId as string | undefined;
    try {
      const tenants = await listAccessibleTenants(homeAccountId);
      if (homeAccountId) {
        store.updateAzureAccount(homeAccountId, { tenants });
      } else {
        const accounts = store.getState().azureAccounts;
        if (accounts.length > 0) {
          store.updateAzureAccount(accounts[0].homeAccountId, { tenants });
        }
      }
      return {
        status: "completed",
        summary: {
          tenantCount: tenants.length,
          tenants,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addLog({
        agent: "orchestrator",
        level: "error",
        message: `list_tenants failed: ${msg}`,
      });
      return { status: "failed", summary: { error: msg } };
    }
  }

  private async _switchTenant(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const homeAccountId = payload.homeAccountId as string | undefined;
    const tenantId = payload.tenantId as string | undefined;
    if (!homeAccountId || !tenantId) {
      return {
        status: "failed",
        summary: { error: "homeAccountId and tenantId are required" },
      };
    }
    try {
      const fromTenantId = getActiveTenant(homeAccountId);
      msalSetActiveTenant(homeAccountId, tenantId);
      store.setActiveTenant(homeAccountId, tenantId);
      // Broadcast so every page using `useTenantChange` / `useArmToken`
      // re-fetches with the new tenant. Without this, pages that were
      // already mounted before the orchestrator triggered the switch
      // continue to render against the OLD tenant's cached data.
      if (typeof window !== "undefined" && fromTenantId !== tenantId) {
        try {
          window.dispatchEvent(
            new CustomEvent(TENANT_CHANGED_EVENT, {
              detail: {
                homeAccountId,
                tenantId,
                fromTenantId: fromTenantId ?? null,
              },
            }),
          );
        } catch {
          /* SSR / non-DOM env — ignore */
        }
      }
      store.addLog({
        agent: "orchestrator",
        level: "info",
        message: `Switched account ${homeAccountId.substring(0, 8)}... to tenant ${tenantId.substring(0, 8)}...`,
      });
      // Audit fix #22: emit a structured audit event for tenant switch.
      this._audit.record({
        actor: this._resolveActor(homeAccountId),
        action: "tenant_switch",
        target: `tenant:${tenantId}`,
        status: "success",
        details: { homeAccountId, fromTenantId, tenantId },
      });

      let subscriptionCount = 0;
      try {
        const token = await this._getAccessToken(tenantId);
        const subs = await listSubscriptions(token);
        // Global state.subscriptions is Enabled-only — that's what
        // pool-creation, account-provisioning, and discovery iterate
        // over. The per-account `subscriptions[]` keeps the full set so
        // the Azure Accounts page can still show disabled subs greyed
        // out (purely informational).
        const enabled = subs.filter(
          (s) => (s.state ?? "Enabled") === "Enabled",
        );
        store.setSubscriptions(
          enabled.map((s) => ({
            subscriptionId: s.subscriptionId,
            displayName: s.displayName,
            tenantId: s.tenantId,
          })),
        );
        store.updateAzureAccount(homeAccountId, {
          subscriptions: subs.map((s) => ({
            subscriptionId: s.subscriptionId,
            displayName: s.displayName,
            state: s.state,
            tenantId: s.tenantId,
          })),
          subscriptionCount: enabled.length,
        });
        subscriptionCount = enabled.length;
      } catch (subErr) {
        const subMsg =
          subErr instanceof Error ? subErr.message : String(subErr);
        store.addLog({
          agent: "orchestrator",
          level: "warn",
          message: `Subscription refresh after tenant switch failed: ${subMsg}`,
        });
      }

      return {
        status: "completed",
        summary: { homeAccountId, tenantId, subscriptionCount },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "failed", summary: { error: msg } };
    }
  }

  private async _listTenantUsers(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const tenantId = payload.tenantId as string | undefined;
    const homeAccountId = payload.homeAccountId as string | undefined;
    const search = payload.search as string | undefined;
    if (!tenantId) {
      return {
        status: "failed",
        summary: { error: "tenantId is required" },
      };
    }
    try {
      const token = await this._getGraphAccessToken(tenantId, homeAccountId);
      const users: GraphUser[] = await listOrgUsers(tenantId, token, {
        search: search && search.trim().length > 0 ? search.trim() : undefined,
      });
      store.setTenantUsers(tenantId, users);
      return {
        status: "completed",
        summary: {
          tenantId,
          userCount: users.length,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addLog({
        agent: "orchestrator",
        level: "error",
        message: `list_tenant_users failed: ${msg}`,
      });
      return { status: "failed", summary: { error: msg } };
    }
  }

  private async _checkPasswordResetCapability(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const tenantId = payload.tenantId as string | undefined;
    const homeAccountId = payload.homeAccountId as string | undefined;
    if (!tenantId || !homeAccountId) {
      return {
        status: "failed",
        summary: { error: "tenantId and homeAccountId are required" },
      };
    }
    try {
      const token = await this._getGraphAccessToken(tenantId, homeAccountId);
      const roles = await getMyDirectoryRoles(tenantId, token);
      const canReset = canResetPasswords(roles);
      store.setPasswordResetCapability(homeAccountId, canReset);
      return {
        status: "completed",
        summary: {
          tenantId,
          homeAccountId,
          canReset,
          roleCount: roles.length,
          roles: roles.map((r) => ({
            id: r.id,
            displayName: r.displayName,
            roleTemplateId: r.roleTemplateId,
          })),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.setPasswordResetCapability(homeAccountId, false);
      store.addLog({
        agent: "orchestrator",
        level: "warn",
        message: `check_password_reset_capability failed: ${msg}`,
      });
      return { status: "failed", summary: { error: msg } };
    }
  }

  private async _resetUserPassword(
    payload: Record<string, unknown>,
  ): Promise<AgentResult> {
    const { store } = this._ctx;
    const tenantId = payload.tenantId as string | undefined;
    const userId = payload.userId as string | undefined;
    const newPassword = payload.newPassword as string | undefined;
    const forceChangeNextSignIn = Boolean(payload.forceChangeNextSignIn);
    const homeAccountId = payload.homeAccountId as string | undefined;

    if (!tenantId || !userId || !newPassword) {
      const msg = "tenantId, userId, and newPassword are required";
      auditLog.record({
        actor: this._resolveActor(homeAccountId),
        action: "reset_user_password",
        target: `user:${userId ?? "?"} @ tenant:${tenantId ?? "?"}`,
        status: "failure",
        error: msg,
        details: { tenantId, userId, forceChangeNextSignIn },
      });
      return {
        status: "failed",
        summary: { ok: false, error: msg },
      };
    }

    try {
      const token = await this._getGraphAccessToken(tenantId, homeAccountId);
      await resetUserPassword(
        tenantId,
        userId,
        newPassword,
        forceChangeNextSignIn,
        token,
      );
      auditLog.record({
        actor: this._resolveActor(homeAccountId),
        action: "reset_user_password",
        target: `user:${userId} @ tenant:${tenantId}`,
        status: "success",
        details: { tenantId, userId, forceChangeNextSignIn },
      });
      // Capture in the encrypted credential vault so the freshly-reset user
      // can launch an Azure portal sign-in via PortalLoginButton. We use the
      // userId as a fallback when no UPN is supplied; the auto-login endpoint
      // requires an email-shaped UPN, so any caller that needs portal-login
      // should pass `payload.userPrincipalName`.
      const upn =
        (payload.userPrincipalName as string | undefined) ||
        (payload.upn as string | undefined) ||
        userId;
      if (homeAccountId && upn && upn.includes("@")) {
        try {
          await credentialVault.put({
            upn,
            password: newPassword,
            tenantId,
            homeAccountId,
            createdAt: new Date().toISOString(),
            source: "reset",
            mustChangePassword: forceChangeNextSignIn,
          });
        } catch (vaultErr) {
          // Vault failures are non-fatal — the reset itself already succeeded.
          store.addLog({
            agent: "orchestrator",
            level: "warn",
            message: `credential-vault.put failed after reset: ${
              vaultErr instanceof Error ? vaultErr.message : String(vaultErr)
            }`,
          });
        }
      }
      store.addNotification({
        type: "success",
        message: "Password reset succeeded.",
      });
      return {
        status: "completed",
        summary: { ok: true, tenantId, userId },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.record({
        actor: this._resolveActor(homeAccountId),
        action: "reset_user_password",
        target: `user:${userId} @ tenant:${tenantId}`,
        status: "failure",
        error: msg,
        details: { tenantId, userId, forceChangeNextSignIn },
      });
      store.addLog({
        agent: "orchestrator",
        level: "error",
        message: `reset_user_password failed: ${msg}`,
      });
      store.addNotification({
        type: "error",
        message: `Password reset failed: ${msg}`,
      });
      return {
        status: "failed",
        summary: { ok: false, error: msg },
      };
    }
  }
}
