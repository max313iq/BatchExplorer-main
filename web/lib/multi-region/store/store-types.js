export const DEFAULT_WORKFLOW_STATE = {
    isRunning: false,
    currentStep: null,
    completedSteps: [],
    failedStep: null,
    error: null,
};
export const DEFAULT_USER_PREFERENCES = {
    lastSubscriptionId: null,
    lastRegions: [],
    lastQuotaType: "LowPriority",
    lastQuotaLimit: 680,
    lastEmail: "",
    lastSupportPlanId: "",
    lastPoolConfig: "",
    sidebarCollapsed: false,
    density: "comfortable",
    theme: "dark",
    lastActivePath: "/azure-accounts",
    autoRefreshEnabled: false,
    autoRecoveryEnabled: false,
    pageAutoRefresh: {},
    liveVmCatalogEnabled: true,
    tableSorts: {},
    tableColumnVisibility: {},
    tablePageSize: {},
};
// --- Pool Defaults (re-export type for state) ---
import { INITIAL_POOL_DEFAULTS } from "./pool-defaults";
export { INITIAL_POOL_DEFAULTS };
export const DEFAULT_THROTTLE_STATS = {
    perSubscription: {},
    history: [],
};
/** Cap the rolling buffer at 120 snapshots (~2h at 60s interval). */
export const MAX_HISTORY_SNAPSHOTS = 120;
export const DEFAULT_GLOBAL_FILTER = {
    regions: [],
    subscriptionIds: [],
    provisioningState: "all",
    accountIds: [],
    searchText: "",
};
export const DEFAULT_AGENT_STATUSES = {
    orchestrator: "idle",
    provisioner: "idle",
    quota: "idle",
    monitor: "idle",
    filter: "idle",
    pool: "idle",
    node: "idle",
};
export function generateSessionId() {
    const ts = new Date().toISOString().replace(/[-:T]/g, "").substring(0, 14);
    const rand = Math.random().toString(36).substring(2, 8);
    return `session-${ts}-${rand}`;
}
export function createInitialState() {
    return {
        sessionId: generateSessionId(),
        subscriptions: [],
        accounts: [],
        pools: [],
        nodes: [],
        poolInfos: [],
        accountInfos: [],
        agentLogs: [],
        agentStatuses: Object.assign({}, DEFAULT_AGENT_STATUSES),
        globalFilter: Object.assign({}, DEFAULT_GLOBAL_FILTER),
        notifications: [],
        workflow: Object.assign({}, DEFAULT_WORKFLOW_STATE),
        activities: [],
        azureAccounts: [],
        auditEntries: [],
        poolDefaults: Object.assign({}, INITIAL_POOL_DEFAULTS),
        throttleStats: {
            perSubscription: {},
            history: [],
        },
        activeTenants: {},
        tenantUsers: {},
        passwordResetCapability: {},
        history: [],
    };
}
//# sourceMappingURL=store-types.js.map