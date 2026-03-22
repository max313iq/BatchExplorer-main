export interface WorkbenchAccountRef {
    subscriptionId: string;
    accountId: string;
    accountName: string;
    location: string;
    endpoint: string;
}

export type WorkbenchQuotaState = "ok" | "warning" | "at-limit" | "unknown";

export interface WorkbenchQuotaStatus {
    state: WorkbenchQuotaState;
    used?: number;
    quota?: number;
}

export interface WorkbenchPoolRow {
    subscriptionId: string;
    accountId: string;
    accountName: string;
    location: string;
    poolId: string;
    allocationState: string;
    nodeCountsByState: {
        [state: string]: number;
    };
    quotaStatus?: WorkbenchQuotaStatus;
    alerts: string[];
}

export interface WorkbenchNodeRow {
    nodeId: string;
    state: string;
    stateTransitionTime?: Date | string;
    errors?: string[];
}

export type ActionStopReason = "none" | "quota" | "transient" | "fatal" | "conflict" | "throttled" | "timeout";
export type ActionStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface ActionResult {
    scope: string;
    status: ActionStatus;
    stopReason?: ActionStopReason;
    errors?: string[];
    startedAt: Date | string;
    finishedAt: Date | string;
    retries?: number;
}

export interface PerAccountSummary {
    subscriptionId: string;
    accountId: string;
    location: string;
    poolId?: string;
    lastSuccessfulTarget: number;
    stopReason?: string;
    retries: number;
    startedAt: string;
    finishedAt?: string;
    errors: any[];
}
