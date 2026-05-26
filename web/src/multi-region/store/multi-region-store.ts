/**
 * Multi-region store — central, subscribable state container for the
 * multi-region dashboard (accounts, pools, nodes, audit log, auth mode,
 * user preferences, throttle telemetry, session persistence).
 * Does NOT own UI rendering or service calls — it's a passive store.
 */
import {
  AccountInfo,
  Activity,
  AgentLogEntry,
  AgentName,
  AgentStatus,
  AuditEntry,
  AzureLoginAccount,
  createInitialState,
  DEFAULT_AGENT_STATUSES,
  DEFAULT_USER_PREFERENCES,
  generateSessionId,
  GlobalFilter,
  GraphUser,
  HistorySnapshot,
  ManagedAccount,
  ManagedNode,
  ManagedPool,
  MAX_HISTORY_SNAPSHOTS,
  MultiRegionState,
  PoolInfo,
  Subscription,
  ThrottleStatusEntry,
  ThrottleTransition,
  ToastNotification,
  UserPreferences,
  WorkflowState,
} from "./store-types";
import type { EndpointFamily } from "../services/types";
import { setActiveTenant as msalSetActiveTenant } from "../auth/msal-auth";
import {
  PoolDefaults,
  loadPoolDefaults,
  savePoolDefaults,
  resetPoolDefaults as resetPoolDefaultsStorage,
} from "./pool-defaults";

const STORAGE_KEY = "multi-region-sessions";
const SESSION_INDEX_KEY = "multi-region-session-index";
const ACTIVITIES_STORAGE_KEY = "multi-region:activities";
const ACTIVITY_PERSIST_DEBOUNCE_MS = 500;
const ACTIVITY_TERMINAL_TTL_MS = 30 * 60 * 1000;
const ACTIVITY_FAILED_TTL_MS = 2 * 60 * 1000;

type Listener = () => void;

export class MultiRegionStore {
  private _state: MultiRegionState;
  private _listeners = new Set<Listener>();
  private _auditListeners = new Set<Listener>();
  private _pausedActivities = new Set<string>();
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;
  private authMode: "msal" | "cli" = "msal";

  constructor(initialState?: Partial<MultiRegionState>) {
    this._state = { ...createInitialState(), ...initialState };
    // Hydrate pool defaults from localStorage on startup
    this._state.poolDefaults = loadPoolDefaults();
    // Hydrate activities from sessionStorage so cross-page nav doesn't lose state
    this.hydrateActivities();
  }

  getState(): Readonly<MultiRegionState> {
    return this._state;
  }

  onChange(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        // listener errors must not abort notification fan-out
      }
    }
  }

  private _notifyAudit(): void {
    for (const listener of this._auditListeners) {
      try {
        listener();
      } catch {
        // listener errors must not abort notification fan-out
      }
    }
  }

  // --- Subscriptions ---

  setSubscriptions(subscriptions: Subscription[]): void {
    this._state = { ...this._state, subscriptions: [...subscriptions] };
    this._notify();
  }

  // --- Accounts ---

  addAccount(account: ManagedAccount): void {
    this._state = {
      ...this._state,
      accounts: [...this._state.accounts, account],
    };
    this._notify();
  }

  updateAccount(id: string, patch: Partial<ManagedAccount>): void {
    this._state = {
      ...this._state,
      accounts: this._state.accounts.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      ),
    };
    this._notify();
  }

  removeAccount(id: string): void {
    this._state = {
      ...this._state,
      accounts: this._state.accounts.filter((a) => a.id !== id),
    };
    this._notify();
  }

  // --- Pools ---

  addPool(pool: ManagedPool): void {
    this._state = {
      ...this._state,
      pools: [...this._state.pools, pool],
    };
    this._notify();
  }

  updatePool(id: string, patch: Partial<ManagedPool>): void {
    this._state = {
      ...this._state,
      pools: this._state.pools.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      ),
    };
    this._notify();
  }

  // --- Nodes ---

  setNodes(nodes: ManagedNode[]): void {
    this._state = { ...this._state, nodes: [...nodes] };
    this._notify();
  }

  updateNode(id: string, patch: Partial<ManagedNode>): void {
    this._state = {
      ...this._state,
      nodes: this._state.nodes.map((n) =>
        n.id === id ? { ...n, ...patch } : n,
      ),
    };
    this._notify();
  }

  removeNode(id: string): void {
    this._state = {
      ...this._state,
      nodes: this._state.nodes.filter((n) => n.id !== id),
    };
    this._notify();
  }

  // --- Pool Infos ---

  setPoolInfos(pools: PoolInfo[]): void {
    this._state = { ...this._state, poolInfos: [...pools] };
    this._notify();
  }

  updatePoolInfo(id: string, patch: Partial<PoolInfo>): void {
    this._state = {
      ...this._state,
      poolInfos: this._state.poolInfos.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      ),
    };
    this._notify();
  }

  // --- Account Infos ---

  setAccountInfos(accounts: AccountInfo[]): void {
    this._state = { ...this._state, accountInfos: [...accounts] };
    this._notify();
  }

  updateAccountInfo(id: string, patch: Partial<AccountInfo>): void {
    this._state = {
      ...this._state,
      accountInfos: this._state.accountInfos.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      ),
    };
    this._notify();
  }

  // --- Agent Statuses ---

  setAgentStatus(agent: AgentName, status: AgentStatus): void {
    this._state = {
      ...this._state,
      agentStatuses: {
        ...this._state.agentStatuses,
        [agent]: status,
      },
    };
    this._notify();
  }

  // --- Agent Logs ---

  addLog(entry: Omit<AgentLogEntry, "timestamp">): void {
    const log: AgentLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    this._state = {
      ...this._state,
      agentLogs: [...this._state.agentLogs, log],
    };
    this._notify();
  }

  clearLogs(): void {
    this._state = { ...this._state, agentLogs: [] };
    this._notify();
  }

  // --- Audit Entries ---

  /**
   * Prepend an audit entry (newest first), capped at 500 entries. The
   * entry is expected to already carry `id` and `timestamp` from the
   * audit-log facade, so we just append.
   */
  addAuditEntry(entry: AuditEntry): void {
    const auditEntries = [entry, ...this._state.auditEntries].slice(0, 500);
    this._state = { ...this._state, auditEntries };
    this._notify();
    this._notifyAudit();
  }

  /** Defensive copy of the current audit entries. */
  getAuditEntries(): AuditEntry[] {
    return [...this._state.auditEntries];
  }

  /** Clear all audit entries and notify both listener sets. */
  clearAuditEntries(): void {
    this._state = { ...this._state, auditEntries: [] };
    this._notify();
    this._notifyAudit();
  }

  /**
   * Subscribe to audit-log changes specifically (separate from the global
   * change listener). Fires on `addAuditEntry` / `clearAuditEntries`.
   * Returns an unsubscribe function.
   */
  subscribeAuditLog(listener: Listener): () => void {
    this._auditListeners.add(listener);
    return () => {
      this._auditListeners.delete(listener);
    };
  }

  // --- Auth Mode ---

  /** Current authentication mode ("msal" for MSAL, "cli" for Azure CLI). */
  getAuthMode(): "msal" | "cli" {
    return this.authMode;
  }

  /** Update the authentication mode and notify subscribers. */
  setAuthMode(mode: "msal" | "cli"): void {
    if (this.authMode === mode) return;
    this.authMode = mode;
    this._notify();
  }

  // --- Global Filter ---

  setGlobalFilter(filter: Partial<GlobalFilter>): void {
    this._state = {
      ...this._state,
      globalFilter: { ...this._state.globalFilter, ...filter },
    };
    this._notify();
  }

  // --- Notifications ---

  addNotification(entry: Omit<ToastNotification, "id" | "timestamp">): void {
    const notification: ToastNotification = {
      ...entry,
      id: Math.random().toString(36).substring(2, 10),
      timestamp: new Date().toISOString(),
    };
    const notifications = [...this._state.notifications, notification];
    // Keep last 50
    this._state = {
      ...this._state,
      notifications: notifications.slice(-50),
    };
    this._notify();
  }

  removeNotification(id: string): void {
    this._state = {
      ...this._state,
      notifications: this._state.notifications.filter((n) => n.id !== id),
    };
    this._notify();
  }

  // --- Activities ---

  addActivity(activity: Omit<Activity, "id" | "startedAt">): string {
    const id =
      Math.random().toString(36).substring(2, 10) +
      Math.random().toString(36).substring(2, 10);
    const newActivity: Activity = {
      ...activity,
      id,
      startedAt: new Date().toISOString(),
    };
    const activities = [...this._state.activities, newActivity];
    this._state = {
      ...this._state,
      activities: activities.slice(-200),
    };
    this._notify();
    this._schedulePersistActivities();
    return id;
  }

  addChildActivity(
    parentId: string,
    activity: Omit<Activity, "id" | "startedAt" | "parentId">,
  ): string {
    const id =
      Math.random().toString(36).substring(2, 10) +
      Math.random().toString(36).substring(2, 10);
    const child: Activity = {
      ...activity,
      id,
      parentId,
      startedAt: new Date().toISOString(),
    };
    const activities = this._state.activities.map((a) =>
      a.id === parentId ? { ...a, children: [...(a.children ?? []), id] } : a,
    );
    activities.push(child);
    this._state = {
      ...this._state,
      activities: activities.slice(-200),
    };
    this._notify();
    this._schedulePersistActivities();
    return id;
  }

  updateActivity(id: string, patch: Partial<Activity>): void {
    this._state = {
      ...this._state,
      activities: this._state.activities.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      ),
    };
    this._notify();
    this._schedulePersistActivities();
  }

  pauseActivity(id: string): void {
    this._pausedActivities.add(id);
    const target = this._state.activities.find((a) => a.id === id);
    if (target && target.status === "running") {
      this.updateActivity(id, { status: "paused" });
      return;
    }
    this._notify();
    this._schedulePersistActivities();
  }

  resumeActivity(id: string): void {
    this._pausedActivities.delete(id);
    const target = this._state.activities.find((a) => a.id === id);
    if (target && target.status === "paused") {
      this.updateActivity(id, { status: "running" });
      return;
    }
    this._notify();
    this._schedulePersistActivities();
  }

  isActivityPaused(id: string): boolean {
    return this._pausedActivities.has(id);
  }

  markActivityCancelling(id: string): void {
    this._pausedActivities.delete(id);
    this.updateActivity(id, { status: "cancelling" });
  }

  clearCompletedActivities(): void {
    const removed = this._state.activities
      .filter(
        (a) =>
          a.status === "completed" ||
          a.status === "failed" ||
          a.status === "cancelled",
      )
      .map((a) => a.id);
    const removedSet = new Set(removed);
    this._state = {
      ...this._state,
      activities: this._state.activities
        .filter((a) => !removedSet.has(a.id))
        .map((a) =>
          a.children && a.children.some((c) => removedSet.has(c))
            ? {
                ...a,
                children: a.children.filter((c) => !removedSet.has(c)),
              }
            : a,
        ),
    };
    for (const id of removed) this._pausedActivities.delete(id);
    this._notify();
    this._schedulePersistActivities();
  }

  private _schedulePersistActivities(): void {
    if (typeof localStorage === "undefined") return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.persistActivities();
    }, ACTIVITY_PERSIST_DEBOUNCE_MS);
  }

  /**
   * Persist activities to localStorage so the task manager state survives
   * full page reloads + browser-tab restarts. Hydrate on construct restores
   * non-terminal activities as "cancelled" so a reload-mid-run doesn't leave
   * a permanently-spinning row.
   */
  persistActivities(): void {
    try {
      if (typeof localStorage === "undefined") return;
      const data = JSON.stringify(this._state.activities);
      localStorage.setItem(ACTIVITIES_STORAGE_KEY, data);
    } catch {
      // localStorage may be full or disabled
    }
  }

  hydrateActivities(): void {
    try {
      if (typeof localStorage === "undefined") return;
      // Migrate any legacy sessionStorage entry on first hydrate.
      let raw = localStorage.getItem(ACTIVITIES_STORAGE_KEY);
      if (!raw && typeof sessionStorage !== "undefined") {
        const legacy = sessionStorage.getItem(ACTIVITIES_STORAGE_KEY);
        if (legacy) {
          raw = legacy;
          try {
            sessionStorage.removeItem(ACTIVITIES_STORAGE_KEY);
          } catch {
            /* ignore */
          }
        }
      }
      if (!raw) return;
      const parsed = JSON.parse(raw) as Activity[];
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      const surviving = parsed.filter((a) => {
        if (a.status === "running" || a.status === "pending") {
          // Stale runners from a prior reload — mark them cancelled on hydrate
          a.status = "cancelled";
          a.completedAt = a.completedAt ?? new Date().toISOString();
          a.error = a.error ?? "Interrupted by reload";
        }
        const completedTs = a.completedAt
          ? new Date(a.completedAt).getTime()
          : now;
        if (a.status === "failed" || a.status === "cancelled") {
          return now - completedTs <= ACTIVITY_FAILED_TTL_MS;
        }
        return now - completedTs <= ACTIVITY_TERMINAL_TTL_MS;
      });
      const validIds = new Set(surviving.map((a) => a.id));
      for (const a of surviving) {
        if (a.children) a.children = a.children.filter((c) => validIds.has(c));
        if (a.parentId && !validIds.has(a.parentId)) a.parentId = undefined;
      }
      this._state = { ...this._state, activities: surviving };
    } catch {
      // best-effort hydrate
    }
  }

  // --- Workflow ---

  setWorkflowState(patch: Partial<WorkflowState>): void {
    this._state = {
      ...this._state,
      workflow: { ...this._state.workflow, ...patch },
    };
    this._notify();
  }

  // --- History (rolling time-series for sparklines + trend UI) ---

  /**
   * Capture a metric snapshot from the current state and append to the
   * rolling history buffer. Cap at MAX_HISTORY_SNAPSHOTS (oldest dropped).
   * Pure derivation — never throws. Called by the dashboard auto-refresh
   * effect after each tick, and by `triggerRefreshAll` after manual refresh.
   */
  recordHistorySnapshot(): void {
    const s = this._state;
    const accountById = new Map(s.accounts.map((a) => [a.id, a]));
    const regionHealth = new Map<string, { healthy: number; total: number }>();
    for (const info of s.accountInfos) {
      const slot = regionHealth.get(info.region) ?? { healthy: 0, total: 0 };
      slot.total += 1;
      const acct = accountById.get(info.id);
      const isHealthy =
        !acct || (acct.provisioningState !== "failed" && !acct.error);
      if (isHealthy) slot.healthy += 1;
      regionHealth.set(info.region, slot);
    }
    let healthyRegions = 0;
    let unhealthyRegions = 0;
    for (const v of regionHealth.values()) {
      if (v.total === 0) continue;
      if (v.healthy === v.total) healthyRegions += 1;
      else unhealthyRegions += 1;
    }
    const snapshot: HistorySnapshot = {
      ts: Date.now(),
      totalAccounts: s.accounts.length,
      totalPools: s.pools.length,
      totalNodes: s.nodes.length,
      runningNodes: s.nodes.filter((n) => n.state === "running").length,
      failedNodes: s.nodes.filter(
        (n) => n.state === "unusable" || n.state === "starttaskfailed",
      ).length,
      dedicatedCoresUsed: s.accountInfos.reduce(
        (acc, a) => acc + a.dedicatedCoresUsed,
        0,
      ),
      dedicatedCoresQuota: s.accountInfos.reduce(
        (acc, a) => acc + a.dedicatedCoreQuota,
        0,
      ),
      lpCoresUsed: s.accountInfos.reduce(
        (acc, a) => acc + a.lowPriorityCoresUsed,
        0,
      ),
      lpCoresQuota: s.accountInfos.reduce(
        (acc, a) => acc + a.lowPriorityCoreQuota,
        0,
      ),
      healthyRegions,
      unhealthyRegions,
    };
    const next = [...s.history, snapshot];
    if (next.length > MAX_HISTORY_SNAPSHOTS) {
      next.splice(0, next.length - MAX_HISTORY_SNAPSHOTS);
    }
    this._state = { ...this._state, history: next };
    this._notify();
  }

  /** Read-only access to the rolling history buffer. */
  getHistory(): readonly HistorySnapshot[] {
    return this._state.history;
  }

  /** Discard accumulated history (e.g. on session reset). */
  clearHistory(): void {
    if (this._state.history.length === 0) return;
    this._state = { ...this._state, history: [] };
    this._notify();
  }

  // --- User Preferences ---

  getUserPreferences(): UserPreferences {
    try {
      const raw = localStorage.getItem("multi-region-prefs");
      return raw
        ? { ...DEFAULT_USER_PREFERENCES, ...JSON.parse(raw) }
        : { ...DEFAULT_USER_PREFERENCES };
    } catch {
      return { ...DEFAULT_USER_PREFERENCES };
    }
  }

  saveUserPreferences(prefs: Partial<UserPreferences>): void {
    const current = this.getUserPreferences();
    localStorage.setItem(
      "multi-region-prefs",
      JSON.stringify({ ...current, ...prefs }),
    );
  }

  // --- Azure Accounts (multi-account auth) ---

  /** Set / replace all AzureLoginAccounts */
  setAzureAccounts(accounts: AzureLoginAccount[]): void {
    this._state = {
      ...this._state,
      azureAccounts: [...accounts],
    };
    this._notify();
  }

  /** Upsert a single AzureLoginAccount (by homeAccountId) */
  upsertAzureAccount(account: AzureLoginAccount): void {
    const existing = this._state.azureAccounts.findIndex(
      (a) => a.homeAccountId === account.homeAccountId,
    );
    let azureAccounts: AzureLoginAccount[];
    if (existing >= 0) {
      azureAccounts = this._state.azureAccounts.map((a) =>
        a.homeAccountId === account.homeAccountId ? account : a,
      );
    } else {
      azureAccounts = [...this._state.azureAccounts, account];
    }
    this._state = { ...this._state, azureAccounts };
    this._notify();
  }

  /** Remove an AzureLoginAccount by homeAccountId */
  removeAzureAccount(homeAccountId: string): void {
    this._state = {
      ...this._state,
      azureAccounts: this._state.azureAccounts.filter(
        (a) => a.homeAccountId !== homeAccountId,
      ),
    };
    this._notify();
  }

  /** Patch a single AzureLoginAccount */
  updateAzureAccount(
    homeAccountId: string,
    patch: Partial<AzureLoginAccount>,
  ): void {
    this._state = {
      ...this._state,
      azureAccounts: this._state.azureAccounts.map((a) =>
        a.homeAccountId === homeAccountId ? { ...a, ...patch } : a,
      ),
    };
    this._notify();
  }

  // --- Tenants & Graph ---

  /**
   * Persist the active tenant for an account both in store state and in
   * MSAL's sessionStorage (so subsequent token acquisitions for the same
   * account default to that tenant).
   */
  setActiveTenant(homeAccountId: string, tenantId: string): void {
    if (!homeAccountId || !tenantId) return;
    const activeTenants = {
      ...this._state.activeTenants,
      [homeAccountId]: tenantId,
    };
    this._state = {
      ...this._state,
      activeTenants,
      azureAccounts: this._state.azureAccounts.map((a) =>
        a.homeAccountId === homeAccountId
          ? { ...a, activeTenantId: tenantId }
          : a,
      ),
    };
    try {
      msalSetActiveTenant(homeAccountId, tenantId);
    } catch {
      // best-effort persistence
    }
    this._notify();
  }

  setTenantUsers(tenantId: string, users: GraphUser[]): void {
    if (!tenantId) return;
    this._state = {
      ...this._state,
      tenantUsers: {
        ...this._state.tenantUsers,
        [tenantId]: [...users],
      },
    };
    this._notify();
  }

  addTenantUser(tenantId: string, user: GraphUser): void {
    if (!tenantId) return;
    const existing = this._state.tenantUsers[tenantId] ?? [];
    const idx = existing.findIndex((u) => u.id === user.id);
    const next =
      idx >= 0
        ? existing.map((u, i) => (i === idx ? user : u))
        : [...existing, user];
    this._state = {
      ...this._state,
      tenantUsers: {
        ...this._state.tenantUsers,
        [tenantId]: next,
      },
    };
    this._notify();
  }

  updateTenantUser(
    tenantId: string,
    userId: string,
    patch: Partial<GraphUser>,
  ): void {
    if (!tenantId || !userId) return;
    const existing = this._state.tenantUsers[tenantId];
    if (!existing) return;
    const next = existing.map((u) =>
      u.id === userId ? { ...u, ...patch } : u,
    );
    this._state = {
      ...this._state,
      tenantUsers: {
        ...this._state.tenantUsers,
        [tenantId]: next,
      },
    };
    this._notify();
  }

  setPasswordResetCapability(homeAccountId: string, canReset: boolean): void {
    if (!homeAccountId) return;
    this._state = {
      ...this._state,
      passwordResetCapability: {
        ...this._state.passwordResetCapability,
        [homeAccountId]: canReset,
      },
    };
    this._notify();
  }

  // --- Throttle Stats ---

  setThrottleStatusEntry(
    subscriptionId: string,
    family: EndpointFamily,
    entry: ThrottleStatusEntry,
  ): void {
    const key = `${subscriptionId}::${family}`;
    const current = this._state.throttleStats;
    const existing = current.perSubscription[key];
    if (
      existing &&
      existing.state === entry.state &&
      existing.refillPerSec === entry.refillPerSec &&
      existing.recentThrottles === entry.recentThrottles &&
      existing.openUntil === entry.openUntil
    ) {
      return;
    }
    this._state = {
      ...this._state,
      throttleStats: {
        ...current,
        perSubscription: {
          ...current.perSubscription,
          [key]: entry,
        },
      },
    };
    this._notify();
  }

  pushThrottleTransition(transition: ThrottleTransition): void {
    const current = this._state.throttleStats;
    const history = [...current.history, transition].slice(-50);
    this._state = {
      ...this._state,
      throttleStats: {
        ...current,
        history,
      },
    };
    this._notify();
  }

  getThrottleStats() {
    return this._state.throttleStats;
  }

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
  resetThrottleCircuit(subscriptionId: string, family: EndpointFamily): void {
    const key = `${subscriptionId}::${family}`;
    const current = this._state.throttleStats;
    if (!current.perSubscription[key]) return;
    const next = { ...current.perSubscription };
    delete next[key];
    this._state = {
      ...this._state,
      throttleStats: {
        ...current,
        perSubscription: next,
      },
    };
    this._notify();
  }

  // --- Pool Defaults ---

  setPoolDefaults(defaults: PoolDefaults): void {
    this._state = { ...this._state, poolDefaults: defaults };
    savePoolDefaults(defaults);
    this._notify();
  }

  updatePoolDefaults(patch: Partial<PoolDefaults>): void {
    const updated = { ...this._state.poolDefaults, ...patch };
    this._state = { ...this._state, poolDefaults: updated };
    savePoolDefaults(updated);
    this._notify();
  }

  resetPoolDefaults(): PoolDefaults {
    const fresh = resetPoolDefaultsStorage();
    this._state = { ...this._state, poolDefaults: fresh };
    this._notify();
    return fresh;
  }

  loadPoolDefaultsFromStorage(): void {
    const loaded = loadPoolDefaults();
    this._state = { ...this._state, poolDefaults: loaded };
    this._notify();
  }

  // --- Export ---

  exportSessionAsJson(): string {
    const { agentStatuses, ...rest } = this._state;
    return JSON.stringify(rest, null, 2);
  }

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
  importSessionFromJson(json: string): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    let parsed: Record<string, unknown>;
    try {
      const raw = JSON.parse(json);
      if (!raw || typeof raw !== "object") {
        return {
          ok: false,
          errors: ["Top-level JSON value must be an object."],
        };
      }
      parsed = raw as Record<string, unknown>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, errors: [`JSON parse failed: ${msg}`] };
    }

    // Build a safe merged state. We start from the current state so any
    // fields the blob omits stay intact (forward-compat).
    const next: MultiRegionState = { ...this._state };

    const setArray = <K extends keyof MultiRegionState>(
      key: K,
      label: string,
    ): void => {
      const v = parsed[key as string];
      if (v === undefined) return;
      if (!Array.isArray(v)) {
        errors.push(`${label} was not an array; skipped.`);
        return;
      }
      (next as MultiRegionState & Record<string, unknown>)[
        key as string
      ] = [...v];
    };

    const setObject = <K extends keyof MultiRegionState>(
      key: K,
      label: string,
    ): void => {
      const v = parsed[key as string];
      if (v === undefined) return;
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        errors.push(`${label} was not an object; skipped.`);
        return;
      }
      (next as MultiRegionState & Record<string, unknown>)[
        key as string
      ] = { ...(v as object) };
    };

    setArray("accounts", "accounts");
    setArray("pools", "pools");
    setArray("nodes", "nodes");
    setArray("subscriptions", "subscriptions");
    setArray("auditEntries", "auditEntries");
    setArray("agentLogs", "agentLogs");
    setArray("activities", "activities");
    setArray("history", "history");
    setArray("notifications", "notifications");
    setObject("workflow", "workflow");
    setObject("poolDefaults", "poolDefaults");
    // "preferences" is a forward-compat field not yet on MultiRegionState — keep
    // restoring it so older session blobs round-trip cleanly.
    setObject("preferences" as keyof MultiRegionState, "preferences");
    setObject("globalFilter", "globalFilter");

    if (typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) {
      next.sessionId = parsed.sessionId;
    }

    this._state = next;
    this._notify();
    this._notifyAudit();
    return { ok: errors.length === 0, errors };
  }

  // --- Retry Failed ---

  retryFailedAccounts(): string[] {
    const ids = this._state.accounts
      .filter((a) => a.provisioningState === "failed")
      .map((a) => a.id);
    this._state = {
      ...this._state,
      accounts: this._state.accounts.map((a) =>
        a.provisioningState === "failed"
          ? {
              ...a,
              provisioningState: "pending" as const,
              error: null,
            }
          : a,
      ),
    };
    this._notify();
    return ids;
  }

  retryFailedPools(): string[] {
    const ids = this._state.pools
      .filter((p) => p.provisioningState === "failed")
      .map((p) => p.id);
    this._state = {
      ...this._state,
      pools: this._state.pools.map((p) =>
        p.provisioningState === "failed"
          ? {
              ...p,
              provisioningState: "pending" as const,
              error: null,
            }
          : p,
      ),
    };
    this._notify();
    return ids;
  }

  // --- Bulk Reset ---

  reset(): void {
    this._state = createInitialState();
    this._notify();
  }

  // --- Session Persistence ---

  get sessionId(): string {
    return this._state.sessionId;
  }

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
  saveSession(): boolean {
    // Build the payload once, then attempt the write with progressively
    // smaller `agentLogs` tails on quota errors. This is the inner loop;
    // session-index pruning happens in the outer fallback below.
    const buildPayload = (logTailSize: number): string => {
      const {
        // Excluded (intentional):
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        notifications,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        history,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        activities,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        tenantUsers,
        agentLogs,
        ...rest
      } = this._state;
      return JSON.stringify({
        ...rest,
        agentLogs: agentLogs.slice(-logTailSize),
        agentStatuses: { ...DEFAULT_AGENT_STATUSES },
      });
    };
    const isQuotaErr = (e: unknown): boolean => {
      const msg = e instanceof Error ? e.message : String(e);
      return /quota|QuotaExceededError|exceeded the quota/i.test(msg);
    };
    const key = `${STORAGE_KEY}:${this._state.sessionId}`;
    // Two-phase write strategy:
    //   Phase 1 — try with the normal 100-line agentLogs tail.
    //   Phase 2 — on quota fail, auto-evict old saved sessions + drop
    //             the agentLogs tail to 25 lines + retry. Repeat with
    //             progressively more aggressive eviction (20→5→1
    //             retained sessions) before giving up.
    // This lets a user who accumulated 20 huge sessions (each with 100s
    // of accounts/pools/nodes) recover automatically without having to
    // crack open DevTools and clear localStorage manually.
    const evictionPlan: Array<{ keepSessions: number; logTail: number }> = [
      { keepSessions: 20, logTail: 100 }, // happy path
      { keepSessions: 10, logTail: 25 },
      { keepSessions: 5, logTail: 10 },
      { keepSessions: 1, logTail: 5 },
    ];
    let lastError: unknown = null;
    for (let phase = 0; phase < evictionPlan.length; phase++) {
      const { keepSessions, logTail } = evictionPlan[phase]!;
      try {
        // Apply session-index trimming for this phase. On the first phase
        // this is the existing 20-session cap; later phases are corrective.
        const index = this._getSessionIndex();
        const existing = index.findIndex(
          (s) => s.id === this._state.sessionId,
        );
        const entry = {
          id: this._state.sessionId,
          savedAt: new Date().toISOString(),
          accountCount: this._state.accounts.length,
          poolCount: this._state.pools.length,
        };
        if (existing >= 0) {
          index[existing] = entry;
        } else {
          index.push(entry);
        }
        // Sort by savedAt ascending then drop oldest until we hit the cap.
        // The current session is kept regardless of age — we never evict
        // the session we're trying to save.
        index.sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1));
        while (index.length > keepSessions) {
          // Find the oldest entry that ISN'T the current session.
          const evictIdx = index.findIndex(
            (s) => s.id !== this._state.sessionId,
          );
          if (evictIdx < 0) break;
          const old = index.splice(evictIdx, 1)[0];
          if (old) {
            try {
              localStorage.removeItem(`${STORAGE_KEY}:${old.id}`);
            } catch {
              /* best-effort eviction; even removeItem can throw on some browsers */
            }
          }
        }
        localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(index));
        // Now write the session blob.
        const json = buildPayload(logTail);
        localStorage.setItem(key, json);
        if (phase > 0) {
          console.info(
            `[MultiRegionStore] saveSession recovered from quota error after eviction phase ${phase} (keepSessions=${keepSessions}, logTail=${logTail}).`,
          );
        }
        return true;
      } catch (e) {
        lastError = e;
        if (!isQuotaErr(e)) {
          // Non-quota errors (circular ref, JSON serialization, etc.)
          // won't be fixed by eviction — fail fast.
          break;
        }
        // Quota error — try the next eviction phase.
      }
    }
    const msg =
      lastError instanceof Error ? lastError.message : String(lastError);
    const isQuota = isQuotaErr(lastError);
    console.warn(
      `[MultiRegionStore] saveSession failed${
        isQuota ? " (storage quota exceeded after eviction)" : ""
      }:`,
      msg,
    );
    return false;
  }

  /**
   * Rename the CURRENT session in place. Unlike newSession() this preserves
   * all loaded state — only the displayed name changes. Pass empty/undefined
   * to clear the name and fall back to the auto-generated session id.
   */
  renameSession(name?: string): void {
    const trimmed = name?.trim();
    this._state = {
      ...this._state,
      sessionName: trimmed && trimmed.length > 0 ? trimmed : undefined,
    };
    this._notify();
  }

  /**
   * Start a fresh session. Optional `name` is shown in the session bar
   * and persisted in the session blob so it survives reloads.
   */
  newSession(name?: string): void {
    const trimmed = name?.trim();
    this._state = {
      ...createInitialState(),
      sessionId: generateSessionId(),
      sessionName: trimmed && trimmed.length > 0 ? trimmed : undefined,
    };
    this._notify();
  }

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
  enableAutoSave(): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    const unsubscribe = this.onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const ok = this.saveSession();
        if (ok) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures += 1;
          // Rate-limit the console noise: warn on the first failure and
          // every 10th thereafter. The user can still see the current
          // state via the manual Save button (which surfaces a toast).
          if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
            console.warn(
              `[MultiRegionStore] auto-save failed (${consecutiveFailures} consecutive). ` +
                `If this persists, click "Clear sign-in cache & reload" or free up browser storage.`,
            );
          }
        }
      }, 400);
    });
    // Disposer also cancels any pending save so React 18 StrictMode's
    // double-invoke / unmount-remount doesn't leak a timer that fires
    // saveSession() after the listener is gone.
    return () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      unsubscribe();
    };
  }

  private _getSessionIndex(): Array<{
    id: string;
    savedAt: string;
    accountCount: number;
    poolCount: number;
  }> {
    try {
      const raw = localStorage.getItem(SESSION_INDEX_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
}
