/**
 * Multi-region store — central, subscribable state container for the
 * multi-region dashboard (accounts, pools, nodes, audit log, auth mode,
 * user preferences, throttle telemetry, session persistence).
 * Does NOT own UI rendering or service calls — it's a passive store.
 */
import { AccountInfo, Activity, AgentLogEntry, AgentName, AgentStatus, AuditEntry, AzureLoginAccount, GlobalFilter, GraphUser, HistorySnapshot, ManagedAccount, ManagedNode, ManagedPool, MultiRegionState, PoolInfo, Subscription, ThrottleStatusEntry, ThrottleTransition, ToastNotification, UserPreferences, WorkflowState } from "./store-types";
import type { EndpointFamily } from "../services/types";
import { PoolDefaults } from "./pool-defaults";
type Listener = () => void;
export declare class MultiRegionStore {
    private _state;
    private _listeners;
    private _auditListeners;
    private _pausedActivities;
    private _persistTimer;
    private authMode;
    constructor(initialState?: Partial<MultiRegionState>);
    getState(): Readonly<MultiRegionState>;
    onChange(listener: Listener): () => void;
    private _notify;
    private _notifyAudit;
    setSubscriptions(subscriptions: Subscription[]): void;
    addAccount(account: ManagedAccount): void;
    updateAccount(id: string, patch: Partial<ManagedAccount>): void;
    removeAccount(id: string): void;
    addPool(pool: ManagedPool): void;
    updatePool(id: string, patch: Partial<ManagedPool>): void;
    setNodes(nodes: ManagedNode[]): void;
    updateNode(id: string, patch: Partial<ManagedNode>): void;
    removeNode(id: string): void;
    setPoolInfos(pools: PoolInfo[]): void;
    updatePoolInfo(id: string, patch: Partial<PoolInfo>): void;
    setAccountInfos(accounts: AccountInfo[]): void;
    updateAccountInfo(id: string, patch: Partial<AccountInfo>): void;
    setAgentStatus(agent: AgentName, status: AgentStatus): void;
    addLog(entry: Omit<AgentLogEntry, "timestamp">): void;
    clearLogs(): void;
    /**
     * Prepend an audit entry (newest first), capped at 500 entries. The
     * entry is expected to already carry `id` and `timestamp` from the
     * audit-log facade, so we just append.
     */
    addAuditEntry(entry: AuditEntry): void;
    /** Defensive copy of the current audit entries. */
    getAuditEntries(): AuditEntry[];
    /** Clear all audit entries and notify both listener sets. */
    clearAuditEntries(): void;
    /**
     * Subscribe to audit-log changes specifically (separate from the global
     * change listener). Fires on `addAuditEntry` / `clearAuditEntries`.
     * Returns an unsubscribe function.
     */
    subscribeAuditLog(listener: Listener): () => void;
    /** Current authentication mode ("msal" for MSAL, "cli" for Azure CLI). */
    getAuthMode(): "msal" | "cli";
    /** Update the authentication mode and notify subscribers. */
    setAuthMode(mode: "msal" | "cli"): void;
    setGlobalFilter(filter: Partial<GlobalFilter>): void;
    addNotification(entry: Omit<ToastNotification, "id" | "timestamp">): void;
    removeNotification(id: string): void;
    addActivity(activity: Omit<Activity, "id" | "startedAt">): string;
    addChildActivity(parentId: string, activity: Omit<Activity, "id" | "startedAt" | "parentId">): string;
    updateActivity(id: string, patch: Partial<Activity>): void;
    pauseActivity(id: string): void;
    resumeActivity(id: string): void;
    isActivityPaused(id: string): boolean;
    markActivityCancelling(id: string): void;
    clearCompletedActivities(): void;
    private _schedulePersistActivities;
    /**
     * Persist activities to localStorage so the task manager state survives
     * full page reloads + browser-tab restarts. Hydrate on construct restores
     * non-terminal activities as "cancelled" so a reload-mid-run doesn't leave
     * a permanently-spinning row.
     */
    persistActivities(): void;
    hydrateActivities(): void;
    setWorkflowState(patch: Partial<WorkflowState>): void;
    /**
     * Capture a metric snapshot from the current state and append to the
     * rolling history buffer. Cap at MAX_HISTORY_SNAPSHOTS (oldest dropped).
     * Pure derivation — never throws. Called by the dashboard auto-refresh
     * effect after each tick, and by `triggerRefreshAll` after manual refresh.
     */
    recordHistorySnapshot(): void;
    /** Read-only access to the rolling history buffer. */
    getHistory(): readonly HistorySnapshot[];
    /** Discard accumulated history (e.g. on session reset). */
    clearHistory(): void;
    getUserPreferences(): UserPreferences;
    saveUserPreferences(prefs: Partial<UserPreferences>): void;
    /** Set / replace all AzureLoginAccounts */
    setAzureAccounts(accounts: AzureLoginAccount[]): void;
    /** Upsert a single AzureLoginAccount (by homeAccountId) */
    upsertAzureAccount(account: AzureLoginAccount): void;
    /** Remove an AzureLoginAccount by homeAccountId */
    removeAzureAccount(homeAccountId: string): void;
    /** Patch a single AzureLoginAccount */
    updateAzureAccount(homeAccountId: string, patch: Partial<AzureLoginAccount>): void;
    /**
     * Persist the active tenant for an account both in store state and in
     * MSAL's sessionStorage (so subsequent token acquisitions for the same
     * account default to that tenant).
     */
    setActiveTenant(homeAccountId: string, tenantId: string): void;
    setTenantUsers(tenantId: string, users: GraphUser[]): void;
    addTenantUser(tenantId: string, user: GraphUser): void;
    updateTenantUser(tenantId: string, userId: string, patch: Partial<GraphUser>): void;
    setPasswordResetCapability(homeAccountId: string, canReset: boolean): void;
    setThrottleStatusEntry(subscriptionId: string, family: EndpointFamily, entry: ThrottleStatusEntry): void;
    pushThrottleTransition(transition: ThrottleTransition): void;
    getThrottleStats(): import("./store-types").ThrottleStats;
    /**
     * Force-reset a single circuit's UI state back to "closed" / healthy.
     * Drops the per-(sub, family) entry from the throttleStats map so the
     * Throttle page no longer shows it as open / probing.
     *
     * Note: this clears the displayed state only. The next observed request
     * for that (subscription, family) pair will re-populate the entry from
     * the live RequestGuard via the telemetry sink installed in
     * dashboard-shell. If the underlying breaker is still open, that next
     * observe() will re-flip it — but the manual reset is still useful for
     * stale entries that lingered after a long idle period.
     */
    resetThrottleCircuit(subscriptionId: string, family: EndpointFamily): void;
    setPoolDefaults(defaults: PoolDefaults): void;
    updatePoolDefaults(patch: Partial<PoolDefaults>): void;
    resetPoolDefaults(): PoolDefaults;
    loadPoolDefaultsFromStorage(): void;
    exportSessionAsJson(): string;
    /**
     * Restore a session from a JSON blob produced by
     * `exportSessionAsJson`. Returns a structured result so the UI can
     * surface partial-success diagnostics ("imported, but 2 fields were
     * invalid and skipped") rather than collapsing to a bool.
     *
     * Defensive parsing: every top-level slice is validated for shape
     * before being merged. Unknown keys are dropped (so a future build
     * that exports a new slice can be imported by an older build).
     * Arrays default to `[]`, objects default to `{}` when malformed —
     * we never throw on a bad slice, we collect the error and keep
     * going so the operator can recover something useful.
     *
     * The current `sessionId` is preserved unless the blob carries one —
     * this prevents accidental clobbering when the operator imports an
     * export they made in the same session.
     */
    importSessionFromJson(json: string): {
        ok: boolean;
        errors: string[];
    };
    retryFailedAccounts(): string[];
    retryFailedPools(): string[];
    reset(): void;
    get sessionId(): string;
    /**
     * Save current state to localStorage.
     *
     * Strips transient / oversized fields before serializing so the blob
     * stays under typical 5 MB quotas:
     *   - `notifications` — toast messages, ephemeral
     *   - `agentLogs` — capped to last 100 entries
     *   - `agentStatuses` — reset to defaults (re-derived on hydrate)
     *   - `history` — rolling telemetry buffer; stays in memory only
     *   - `activities` — persisted independently by persistActivities()
     *   - `tenantUsers` — Graph cache, re-fetched on demand
     *
     * Returns `true` if the save reached localStorage successfully, `false`
     * otherwise. Failures are logged so the cause shows up in DevTools
     * instead of being silently swallowed by an empty `catch`.
     */
    saveSession(): boolean;
    /**
     * Rename the CURRENT session in place. Unlike newSession() this preserves
     * all loaded state — only the displayed name changes. Pass empty/undefined
     * to clear the name and fall back to the auto-generated session id.
     */
    renameSession(name?: string): void;
    /**
     * Start a fresh session. Optional `name` is shown in the session bar
     * and persisted in the session blob so it survives reloads.
     */
    newSession(name?: string): void;
    /**
     * Aggressive auto-save: persist to localStorage on EVERY store change,
     * coalesced to one write per ~400 ms. Catches every state mutation —
     * filters, refresh data, form drafts that route through `saveUserPreferences`,
     * audit log entries, anything. The previous fingerprint gate
     * (`accounts.length:pools.length:nodes.length:subscriptions.length`) was
     * removed because it skipped saves whenever only INSIDE-the-collection
     * data changed (e.g. filter selections, edited drafts, status flips).
     *
     * Failures are logged via `saveSession`; a string of consecutive failures
     * is rate-limited so the console doesn't get spammed when storage quota
     * is full.
     */
    enableAutoSave(): () => void;
    private _getSessionIndex;
}
export {};
//# sourceMappingURL=multi-region-store.d.ts.map