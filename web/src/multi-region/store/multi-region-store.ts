import {
    AgentLogEntry,
    AgentName,
    AgentStatus,
    createInitialState,
    GlobalFilter,
    ManagedAccount,
    ManagedPool,
    MultiRegionState,
    QuotaRequest,
    Subscription,
} from "./store-types";

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

    // --- Bulk Reset ---

    reset(): void {
        this._state = createInitialState();
        this._notify();
    }
}
