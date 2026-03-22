export type AgentName =
    | "orchestrator"
    | "provisioner"
    | "quota"
    | "monitor"
    | "filter"
    | "pool";

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

export interface MultiRegionState {
    subscriptions: Subscription[];
    accounts: ManagedAccount[];
    quotaRequests: QuotaRequest[];
    pools: ManagedPool[];
    agentLogs: AgentLogEntry[];
    agentStatuses: Record<AgentName, AgentStatus>;
    globalFilter: GlobalFilter;
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
};

export function createInitialState(): MultiRegionState {
    return {
        subscriptions: [],
        accounts: [],
        quotaRequests: [],
        pools: [],
        agentLogs: [],
        agentStatuses: { ...DEFAULT_AGENT_STATUSES },
        globalFilter: { ...DEFAULT_GLOBAL_FILTER },
    };
}
