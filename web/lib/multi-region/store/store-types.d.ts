export type AgentName = "orchestrator" | "provisioner" | "quota" | "monitor" | "filter" | "pool" | "node";
export type AgentStatus = "idle" | "running" | "completed" | "error";
export type AccountProvisioningState = "pending" | "creating" | "created" | "failed";
export type PoolCreationState = "pending" | "creating" | "created" | "failed";
export type NodeState = "idle" | "rebooting" | "reimaging" | "running" | "unusable" | "creating" | "starting" | "waitingforstarttask" | "starttaskfailed" | "leavingpool" | "offline" | "preempted" | "unknown";
export type QuotaType = "LowPriority" | "Dedicated" | "Spot";
export interface Subscription {
    subscriptionId: string;
    displayName: string;
    tenantId?: string;
    /**
     * MSAL homeAccountId of the AAD account that holds this subscription.
     * Set when the subscription is discovered via
     * `listSubscriptionsForAccount`. Used by the orchestrator (and the
     * provisioning UI) to request the correct token when the same browser
     * has multiple signed-in accounts that each own different subs.
     * Optional for backward compatibility with subs sourced from the
     * legacy single-account flow.
     */
    homeAccountId?: string;
    /**
     * Display name of the AAD account that owns this subscription —
     * used in subscription pickers so the operator can disambiguate
     * subs that share a tenant but belong to different signed-in
     * accounts. Optional, falls back to `tenantId.slice(0,8)` if absent.
     */
    ownerAccountLabel?: string;
}
export interface ManagedAccount {
    id: string;
    accountName: string;
    resourceGroup: string;
    subscriptionId: string;
    region: string;
    provisioningState: AccountProvisioningState;
    createdAt?: string;
    error?: string | null;
}
export interface ManagedNode {
    id: string;
    accountId: string;
    accountName: string;
    region: string;
    poolId: string;
    nodeId: string;
    state: NodeState;
    vmSize?: string;
    ipAddress?: string;
    isDedicated: boolean;
    lastBootTime?: string;
    totalTasksRun?: number;
    runningTasksCount?: number;
    schedulingState?: string;
    startTaskExitCode?: number;
    subscriptionId?: string;
    errors?: string[];
    error?: string | null;
}
export interface ManagedPool {
    id: string;
    accountId: string;
    poolId: string;
    provisioningState: PoolCreationState;
    config: Record<string, unknown>;
    createdAt?: string;
    error?: string | null;
}
export interface AgentLogEntry {
    agent: AgentName;
    level: "info" | "warn" | "error";
    message: string;
    timestamp: string;
    details?: unknown;
}
export interface GlobalFilter {
    regions: string[];
    subscriptionIds: string[];
    provisioningState: AccountProvisioningState | "all";
    accountIds: string[];
    hasPool?: boolean;
    searchText: string;
}
export type ActivityStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "paused" | "cancelling";
export interface Activity {
    id: string;
    action: string;
    target: string;
    status: ActivityStatus;
    progress?: number;
    startedAt: string;
    completedAt?: string;
    error?: string;
    parentId?: string;
    children?: string[];
}
export interface ToastNotification {
    id: string;
    type: "success" | "error" | "warning" | "info";
    message: string;
    timestamp: string;
    autoDismissMs?: number;
}
export type WorkflowStep = "discover" | "quota" | "monitor" | "pool";
export interface WorkflowState {
    isRunning: boolean;
    currentStep: WorkflowStep | null;
    completedSteps: WorkflowStep[];
    failedStep: WorkflowStep | null;
    error: string | null;
}
export declare const DEFAULT_WORKFLOW_STATE: WorkflowState;
export type DensityMode = "compact" | "comfortable";
export type ThemeMode = "dark" | "light";
export type SortDirection = "asc" | "desc";
/** Persisted sort state for a DataTable (Contract §5). */
export interface TableSortState {
    column: string;
    direction: SortDirection;
}
/**
 * User-level preferences — absorbs everything previously scattered across
 * direct localStorage calls (density, dark mode, sidebar collapsed, table
 * sorts, column visibility) into a single store slice. Per Contract §10
 * direct localStorage access is banned outside this slice + the
 * `usePersistedState` adapter.
 */
export interface UserPreferences {
    lastSubscriptionId: string | null;
    lastRegions: string[];
    lastQuotaType: QuotaType;
    lastQuotaLimit: number;
    lastEmail: string;
    lastSupportPlanId: string;
    lastPoolConfig: string;
    sidebarCollapsed: boolean;
    density: DensityMode;
    theme: ThemeMode;
    /**
     * Last-visited route path (e.g. "/overview"). Restored on app load when
     * no explicit URL was provided. Replaces the old sessionStorage hack.
     */
    lastActivePath: string;
    autoRefreshEnabled: boolean;
    autoRecoveryEnabled: boolean;
    /**
     * Per-page auto-refresh toggles. Each page that exposes its own
     * "Auto refresh (30s)" switch persists state here, keyed by a stable
     * page id, so flipping the toggle off and reloading the browser keeps
     * it off. Missing keys default to true (matches the legacy in-memory
     * default the pages had before persistence).
     */
    pageAutoRefresh: Record<string, boolean>;
    /**
     * Master switch for the live VM-catalog wire. When true (default),
     * Pool Creation's Smart Mode picker and the Nodes page filter both
     * read from the cached Microsoft.Compute/skus catalog. When false,
     * Pool Creation falls back to the hardcoded 5-VM list and the Nodes
     * filter is hidden — useful when the catalog is empty / unavailable
     * and the user wants the static UX from before the wire-up.
     */
    liveVmCatalogEnabled: boolean;
    /** Persisted sort per DataTable (column + direction). */
    tableSorts: Record<string, TableSortState>;
    /** Persisted column visibility per DataTable (column id → visible). */
    tableColumnVisibility: Record<string, Record<string, boolean>>;
    /** Persisted page size per DataTable. */
    tablePageSize: Record<string, number>;
}
export declare const DEFAULT_USER_PREFERENCES: UserPreferences;
export interface PoolInfo {
    id: string;
    accountId: string;
    accountName: string;
    region: string;
    poolId: string;
    vmSize: string;
    state: string;
    allocationState: string;
    targetDedicatedNodes: number;
    currentDedicatedNodes: number;
    targetLowPriorityNodes: number;
    currentLowPriorityNodes: number;
    taskSlotsPerNode: number;
    enableAutoScale: boolean;
    autoScaleFormula?: string;
    resizeErrors?: string[];
    lastModified?: string;
    creationTime?: string;
    startTask?: Record<string, unknown>;
}
export interface AccountInfo {
    id: string;
    accountName: string;
    subscriptionId: string;
    region: string;
    resourceGroup: string;
    dedicatedCoreQuota: number;
    lowPriorityCoreQuota: number;
    poolQuota: number;
    activeJobAndJobScheduleQuota: number;
    dedicatedCoresUsed: number;
    lowPriorityCoresUsed: number;
    poolCount: number;
    dedicatedCoresFree: number;
    lowPriorityCoresFree: number;
    poolsFree: number;
    dedicatedCoreQuotaPerVMFamilyEnforced: boolean;
    dedicatedCoreQuotaPerVMFamily?: Array<{
        name: string;
        coreQuota: number;
        coresUsed: number;
        coresFree: number;
    }>;
}
export interface QuotaSuggestion {
    accountId: string;
    accountName: string;
    region: string;
    freeLpCores: number;
    freeDedicatedCores: number;
    vmSize: string;
    vmSizeVCpus: number;
    maxLpNodes: number;
    maxDedicatedNodes: number;
}
/** Represents a logged-in Azure AD account with its discovered subscriptions */
export interface AzureLoginAccount {
    homeAccountId: string;
    /**
     * AAD object ID of the user/SPN in their home tenant. From MSAL's
     * AccountInfo.localAccountId. Required when this account is used as
     * a subscription owner in a cross-tenant Subscription Alias request.
     */
    localAccountId?: string;
    username: string;
    name: string;
    tenantId: string;
    environment: string;
    subscriptions: AzureLoginSubscription[];
    subscriptionCount: number;
    status: "active" | "loading" | "error";
    error?: string | null;
    /**
     * Distinguishes "MSAL has no session for this cached account" (true)
     * from "MSAL session exists but the ARM/Graph call failed" (false /
     * undefined). Both surface as `status: "error"`, but the UI splits
     * them so the operator gets a "needs re-login" CTA for stale sessions
     * instead of one undifferentiated "20 accounts failed" banner.
     */
    signedOut?: boolean;
    addedAt: string;
    /** Optional list of tenants the account can access (populated lazily). */
    tenants?: TenantInfo[];
    /** Currently selected tenant for this account (for cross-tenant switching). */
    activeTenantId?: string;
}
export interface AzureLoginSubscription {
    subscriptionId: string;
    displayName: string;
    state: string;
    tenantId: string;
}
export interface AuditEntry {
    id: string;
    timestamp: string;
    actor: string;
    action: string;
    target: string;
    details?: Record<string, unknown>;
    status: "success" | "failure";
    error?: string;
}
import { PoolDefaults, INITIAL_POOL_DEFAULTS } from "./pool-defaults";
export { INITIAL_POOL_DEFAULTS };
export type { PoolDefaults };
import type { ThrottleStatusEntry, ThrottleTransition, GraphUser, TenantInfo, DirectoryRole } from "../services/types";
export type { ThrottleStatusEntry, ThrottleTransition, GraphUser, TenantInfo, DirectoryRole, };
export interface ThrottleStats {
    perSubscription: Record<string, ThrottleStatusEntry>;
    history: ThrottleTransition[];
}
export declare const DEFAULT_THROTTLE_STATS: ThrottleStats;
/**
 * Telemetry snapshot captured at each refresh tick. Powers sparkline /
 * trend-line UI on Overview and other dashboards. The store caps history
 * to MAX_HISTORY_SNAPSHOTS — oldest entries are dropped first.
 */
export interface HistorySnapshot {
    /** UTC milliseconds when the snapshot was taken. */
    ts: number;
    totalAccounts: number;
    totalPools: number;
    totalNodes: number;
    runningNodes: number;
    failedNodes: number;
    /** Sum of dedicated cores in use across accountInfos. */
    dedicatedCoresUsed: number;
    dedicatedCoresQuota: number;
    /** Sum of low-priority cores in use across accountInfos. */
    lpCoresUsed: number;
    lpCoresQuota: number;
    /** Number of regions that are 100% healthy at this tick. */
    healthyRegions: number;
    /** Number of regions with at least one unhealthy account. */
    unhealthyRegions: number;
}
/** Cap the rolling buffer at 120 snapshots (~2h at 60s interval). */
export declare const MAX_HISTORY_SNAPSHOTS = 120;
export interface MultiRegionState {
    sessionId: string;
    /**
     * Optional human-readable label the operator gave the session when
     * they started it. Empty / undefined → the UI falls back to showing
     * the auto-generated sessionId. Persisted alongside the rest of the
     * session blob so it survives reloads.
     */
    sessionName?: string;
    subscriptions: Subscription[];
    accounts: ManagedAccount[];
    pools: ManagedPool[];
    nodes: ManagedNode[];
    poolInfos: PoolInfo[];
    accountInfos: AccountInfo[];
    agentLogs: AgentLogEntry[];
    agentStatuses: Record<AgentName, AgentStatus>;
    globalFilter: GlobalFilter;
    notifications: ToastNotification[];
    workflow: WorkflowState;
    activities: Activity[];
    azureAccounts: AzureLoginAccount[];
    auditEntries: AuditEntry[];
    poolDefaults: PoolDefaults;
    throttleStats: ThrottleStats;
    /** homeAccountId → currently selected tenantId */
    activeTenants: Record<string, string>;
    /** tenantId → users discovered via Microsoft Graph */
    tenantUsers: Record<string, GraphUser[]>;
    /** homeAccountId → whether the account can reset other users' passwords */
    passwordResetCapability: Record<string, boolean>;
    /** Rolling history of metric snapshots (powers Overview sparklines). */
    history: HistorySnapshot[];
}
export declare const DEFAULT_GLOBAL_FILTER: GlobalFilter;
export declare const DEFAULT_AGENT_STATUSES: Record<AgentName, AgentStatus>;
export declare function generateSessionId(): string;
export declare function createInitialState(): MultiRegionState;
//# sourceMappingURL=store-types.d.ts.map