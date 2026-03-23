export type AgentName =
    | "orchestrator"
    | "provisioner"
    | "quota"
    | "monitor"
    | "filter"
    | "pool"
    | "node";

export type AgentStatus = "idle" | "running" | "completed" | "error";

export type AccountProvisioningState =
    | "pending"
    | "creating"
    | "created"
    | "failed";

export type QuotaRequestStatus =
    | "pending"
    | "submitted"
    | "approved"
    | "denied"
    | "failed";

export type PoolCreationState = "pending" | "creating" | "created" | "failed";

export type NodeState =
    | "idle"
    | "rebooting"
    | "reimaging"
    | "running"
    | "unusable"
    | "creating"
    | "starting"
    | "waitingforstarttask"
    | "starttaskfailed"
    | "leavingpool"
    | "offline"
    | "preempted"
    | "unknown";

export type QuotaType = "LowPriority" | "Dedicated" | "Spot";

export interface Subscription {
    subscriptionId: string;
    displayName: string;
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

export interface QuotaRequest {
    id: string;
    accountId: string;
    ticketId: string;
    subscriptionId: string;
    region: string;
    quotaType: QuotaType;
    requestedLimit: number;
    status: QuotaRequestStatus;
    submittedAt?: string;
    lastCheckedAt?: string;
    resolvedAt?: string | null;
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
    lastBootTime?: string;
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
    quotaStatus: QuotaRequestStatus | "all";
    provisioningState: AccountProvisioningState | "all";
    accountIds: string[];
    hasPool?: boolean;
    searchText: string;
}

// --- Toast Notifications ---

export interface ToastNotification {
    id: string;
    type: "success" | "error" | "warning" | "info";
    message: string;
    timestamp: string;
    autoDismissMs?: number;
}

// --- Workflow ---

export type WorkflowStep = "discover" | "quota" | "monitor" | "pool";

export interface WorkflowState {
    isRunning: boolean;
    currentStep: WorkflowStep | null;
    completedSteps: WorkflowStep[];
    failedStep: WorkflowStep | null;
    error: string | null;
}

export const DEFAULT_WORKFLOW_STATE: WorkflowState = {
    isRunning: false,
    currentStep: null,
    completedSteps: [],
    failedStep: null,
    error: null,
};

// --- User Preferences ---

export interface UserPreferences {
    lastSubscriptionId: string | null;
    lastRegions: string[];
    lastQuotaType: QuotaType;
    lastQuotaLimit: number;
    lastEmail: string;
    lastSupportPlanId: string;
    lastPoolConfig: string;
    sidebarCollapsed: boolean;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
    lastSubscriptionId: null,
    lastRegions: [],
    lastQuotaType: "LowPriority",
    lastQuotaLimit: 680,
    lastEmail: "",
    lastSupportPlanId: "",
    lastPoolConfig: "",
    sidebarCollapsed: false,
};

// --- Main State ---

export interface MultiRegionState {
    sessionId: string;
    subscriptions: Subscription[];
    accounts: ManagedAccount[];
    quotaRequests: QuotaRequest[];
    pools: ManagedPool[];
    nodes: ManagedNode[];
    agentLogs: AgentLogEntry[];
    agentStatuses: Record<AgentName, AgentStatus>;
    globalFilter: GlobalFilter;
    notifications: ToastNotification[];
    workflow: WorkflowState;
}

export const DEFAULT_GLOBAL_FILTER: GlobalFilter = {
    regions: [],
    subscriptionIds: [],
    quotaStatus: "all",
    provisioningState: "all",
    accountIds: [],
    searchText: "",
};

export const DEFAULT_AGENT_STATUSES: Record<AgentName, AgentStatus> = {
    orchestrator: "idle",
    provisioner: "idle",
    quota: "idle",
    monitor: "idle",
    filter: "idle",
    pool: "idle",
    node: "idle",
};

export function generateSessionId(): string {
    const ts = new Date().toISOString().replace(/[-:T]/g, "").substring(0, 14);
    const rand = Math.random().toString(36).substring(2, 8);
    return `session-${ts}-${rand}`;
}

export function createInitialState(): MultiRegionState {
    return {
        sessionId: generateSessionId(),
        subscriptions: [],
        accounts: [],
        quotaRequests: [],
        pools: [],
        nodes: [],
        agentLogs: [],
        agentStatuses: { ...DEFAULT_AGENT_STATUSES },
        globalFilter: { ...DEFAULT_GLOBAL_FILTER },
        notifications: [],
        workflow: { ...DEFAULT_WORKFLOW_STATE },
    };
}
