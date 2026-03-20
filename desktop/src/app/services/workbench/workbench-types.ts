export interface WorkbenchAccountRef {
    subscriptionId: string;
    accountId: string;
    accountName: string;
    location: string;
    endpoint: string;
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
