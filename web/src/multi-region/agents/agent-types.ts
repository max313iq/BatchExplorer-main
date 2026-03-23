import { MultiRegionStore } from "../store/multi-region-store";
import { RequestScheduler } from "../scheduling/request-scheduler";
import { AgentName } from "../store/store-types";

export interface AgentContext {
    store: MultiRegionStore;
    scheduler: RequestScheduler;
    armUrl: string;
    getAccessToken: () => Promise<string>;
    getBatchAccessToken: () => Promise<string>;
}

export interface AgentResult {
    status: "completed" | "failed" | "partial";
    summary: Record<string, unknown>;
}

export interface AgentMessage {
    action: string;
    payload: Record<string, unknown>;
    requestId: string;
    timestamp: string;
}

export interface AgentResponse {
    requestId: string;
    status: "completed" | "failed" | "partial";
    summary: Record<string, unknown>;
    timestamp: string;
}

export interface Agent {
    readonly name: AgentName;
    execute(params: Record<string, unknown>): Promise<AgentResult>;
    cancel(): void;
}

export interface ProvisionerInput {
    subscriptionId: string;
    regions: string[];
    config?: {
        concurrency?: number;
        delayMs?: number;
        retryAttempts?: number;
        retryBackoffSeconds?: number[];
        jitterPct?: number;
    };
}

export interface QuotaInput {
    accountIds: string[];
    quotaType: "LowPriority" | "Dedicated" | "Spot";
    newLimit: number;
    contactConfig: {
        email: string;
        timezone: string;
        country: string;
        language: string;
    };
    supportPlanId: string;
    config?: {
        concurrency?: number;
        delayMs?: number;
        retryAttempts?: number;
        retryBackoffSeconds?: number[];
        jitterPct?: number;
    };
}

export interface MonitorInput {
    mode: "one-shot" | "continuous";
    intervalSeconds?: number;
    maxPollingMinutes?: number;
}

export interface FilterInput {
    filters: {
        regions?: string[];
        subscriptionIds?: string[];
        quotaStatus?: string;
        provisioningState?: string;
        accountIds?: string[];
        hasPool?: boolean;
    };
    selectAll?: boolean;
}

export interface FilterOutput {
    matchCount: number;
    accounts: Array<{
        accountId: string;
        accountName: string;
        region: string;
        subscriptionId: string;
        quotaStatus: string;
        quotaLimit?: number;
        hasPool: boolean;
    }>;
}

export interface PoolInput {
    accountIds: string[];
    poolConfig: Record<string, unknown>;
    config?: {
        concurrency?: number;
        delayMs?: number;
        retryAttempts?: number;
        retryBackoffSeconds?: number[];
        jitterPct?: number;
    };
}
