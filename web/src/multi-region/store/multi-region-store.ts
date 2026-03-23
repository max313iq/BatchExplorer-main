import {
    AccountInfo,
    Activity,
    AgentLogEntry,
    AgentName,
    AgentStatus,
    createInitialState,
    DEFAULT_AGENT_STATUSES,
    DEFAULT_USER_PREFERENCES,
    generateSessionId,
    GlobalFilter,
    ManagedAccount,
    ManagedNode,
    ManagedPool,
    MultiRegionState,
    PoolInfo,
    QuotaRequest,
    Subscription,
    ToastNotification,
    UserPreferences,
    WorkflowState,
} from "./store-types";

const STORAGE_KEY = "multi-region-sessions";
const SESSION_INDEX_KEY = "multi-region-session-index";

type Listener = () => void;

export class MultiRegionStore {
    private _state: MultiRegionState;
    private _listeners = new Set<Listener>();

    constructor(initialState?: Partial<MultiRegionState>) {
        this._state = { ...createInitialState(), ...initialState };
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
                // swallow listener errors
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
                a.id === id ? { ...a, ...patch } : a
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

    // --- Quota Requests ---

    addQuotaRequest(request: QuotaRequest): void {
        this._state = {
            ...this._state,
            quotaRequests: [...this._state.quotaRequests, request],
        };
        this._notify();
    }

    updateQuotaRequest(id: string, patch: Partial<QuotaRequest>): void {
        this._state = {
            ...this._state,
            quotaRequests: this._state.quotaRequests.map((r) =>
                r.id === id ? { ...r, ...patch } : r
            ),
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
                p.id === id ? { ...p, ...patch } : p
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
                n.id === id ? { ...n, ...patch } : n
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
                p.id === id ? { ...p, ...patch } : p
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
                a.id === id ? { ...a, ...patch } : a
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
        // Keep max 100 activities
        this._state = {
            ...this._state,
            activities: activities.slice(-100),
        };
        this._notify();
        return id;
    }

    updateActivity(id: string, patch: Partial<Activity>): void {
        this._state = {
            ...this._state,
            activities: this._state.activities.map((a) =>
                a.id === id ? { ...a, ...patch } : a
            ),
        };
        this._notify();
    }

    clearCompletedActivities(): void {
        this._state = {
            ...this._state,
            activities: this._state.activities.filter(
                (a) =>
                    a.status !== "completed" &&
                    a.status !== "failed" &&
                    a.status !== "cancelled"
            ),
        };
        this._notify();
    }

    // --- Workflow ---

    setWorkflowState(patch: Partial<WorkflowState>): void {
        this._state = {
            ...this._state,
            workflow: { ...this._state.workflow, ...patch },
        };
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
            JSON.stringify({ ...current, ...prefs })
        );
    }

    // --- Export ---

    exportSessionAsJson(): string {
        const { agentStatuses, ...rest } = this._state;
        return JSON.stringify(rest, null, 2);
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
                    : a
            ),
        };
        this._notify();
        return ids;
    }

    retryFailedQuotas(): string[] {
        const ids = this._state.quotaRequests
            .filter((r) => r.status === "failed")
            .map((r) => r.id);
        this._state = {
            ...this._state,
            quotaRequests: this._state.quotaRequests.map((r) =>
                r.status === "failed"
                    ? { ...r, status: "pending" as const, error: null }
                    : r
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
                    : p
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

    /** Save current state to localStorage */
    saveSession(): void {
        try {
            const key = `${STORAGE_KEY}:${this._state.sessionId}`;
            const serializable = {
                ...this._state,
                agentStatuses: { ...DEFAULT_AGENT_STATUSES },
            };
            localStorage.setItem(key, JSON.stringify(serializable));

            // Update session index
            const index = this._getSessionIndex();
            const existing = index.findIndex(
                (s) => s.id === this._state.sessionId
            );
            const entry = {
                id: this._state.sessionId,
                savedAt: new Date().toISOString(),
                accountCount: this._state.accounts.length,
                quotaCount: this._state.quotaRequests.length,
                poolCount: this._state.pools.length,
            };
            if (existing >= 0) {
                index[existing] = entry;
            } else {
                index.push(entry);
            }
            // Keep last 20 sessions
            while (index.length > 20) {
                const old = index.shift();
                if (old) localStorage.removeItem(`${STORAGE_KEY}:${old.id}`);
            }
            localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(index));
        } catch {
            // localStorage might be full
        }
    }

    /** Load a session from localStorage */
    loadSession(sessionId: string): boolean {
        try {
            const raw = localStorage.getItem(`${STORAGE_KEY}:${sessionId}`);
            if (!raw) return false;
            const saved = JSON.parse(raw) as MultiRegionState;
            this._state = {
                ...saved,
                agentStatuses: { ...DEFAULT_AGENT_STATUSES },
            };
            this._notify();
            this.addLog({
                agent: "orchestrator",
                level: "info",
                message: `Session loaded: ${sessionId} (${saved.accounts.length} accounts, ${saved.quotaRequests.length} quotas, ${saved.pools.length} pools)`,
            });
            return true;
        } catch {
            return false;
        }
    }

    /** List all saved sessions */
    listSessions(): Array<{
        id: string;
        savedAt: string;
        accountCount: number;
        quotaCount: number;
        poolCount: number;
    }> {
        return this._getSessionIndex();
    }

    /** Delete a saved session */
    deleteSession(sessionId: string): void {
        localStorage.removeItem(`${STORAGE_KEY}:${sessionId}`);
        const index = this._getSessionIndex().filter((s) => s.id !== sessionId);
        localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(index));
    }

    /** Start a fresh session */
    newSession(): void {
        this._state = {
            ...createInitialState(),
            sessionId: generateSessionId(),
        };
        this._notify();
    }

    /** Auto-save on meaningful state changes (debounced, ignores logs/notifications) */
    enableAutoSave(): () => void {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let lastFingerprint = "";
        return this.onChange(() => {
            const s = this._state;
            const fp = `${s.accounts.length}:${s.quotaRequests.length}:${s.pools.length}:${s.nodes.length}:${s.subscriptions.length}`;
            if (fp === lastFingerprint) return;
            lastFingerprint = fp;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => this.saveSession(), 3000);
        });
    }

    private _getSessionIndex(): Array<{
        id: string;
        savedAt: string;
        accountCount: number;
        quotaCount: number;
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
