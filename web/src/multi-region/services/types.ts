/**
 * Common types used by the multi-region SDK service layer.
 *
 * These types represent the shapes returned by the ARM management plane
 * and the Batch data plane REST APIs. They are intentionally kept lean —
 * only the fields the multi-region feature actually consumes are included.
 */

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

/** Standard Azure error envelope returned by ARM and Batch APIs. */
export interface AzureError {
    status: number;
    code: string;
    message: string;
}

/** Thrown when an Azure REST call returns a non-2xx status. */
export class AzureRequestError extends Error {
    public readonly isRetryable: boolean;
    public readonly isAsync: boolean;

    constructor(
        message: string,
        public readonly status: number,
        public readonly code: string,
        public readonly body: unknown,
        isRetryable = false,
        isAsync = false,
        public readonly locationHeader?: string
    ) {
        super(message);
        this.name = "AzureRequestError";

        // Auto-detect retryable if not explicitly set
        this.isRetryable = isRetryable || isRetryableStatus(status);
        // Auto-detect async if not explicitly set
        this.isAsync = isAsync || isAsyncAccepted(status);
    }
}

/** Check if an HTTP status indicates an async accepted operation */
export function isAsyncAccepted(status: number): boolean {
    return status === 202;
}

/** Check if an HTTP status is retryable (transient failure) */
export function isRetryableStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503;
}

/** Check if a provisioningState indicates completion */
export function isTerminalProvisioningState(state: string): boolean {
    const lower = state.toLowerCase();
    return (
        lower === "succeeded" ||
        lower === "failed" ||
        lower === "canceled" ||
        lower === "cancelled" ||
        lower === "deleted"
    );
}

/** Check if a provisioningState indicates success */
export function isSuccessProvisioningState(state: string): boolean {
    return state.toLowerCase() === "succeeded";
}

// ---------------------------------------------------------------------------
// ARM — Subscriptions
// ---------------------------------------------------------------------------

/** A single Azure subscription. */
export interface ArmSubscription {
    subscriptionId: string;
    displayName: string;
    state: string;
    tenantId: string;
}

// ---------------------------------------------------------------------------
// ARM — Batch Accounts
// ---------------------------------------------------------------------------

/** Per-VM-family dedicated core quota entry. */
export interface VmFamilyCoreQuota {
    name: string;
    coreQuota: number;
}

/** A Batch account as returned by the ARM management plane. */
export interface ArmBatchAccount {
    id: string;
    name: string;
    type: string;
    location: string;
    properties: {
        accountEndpoint?: string;
        provisioningState?: string;
        poolAllocationMode?: string;
        dedicatedCoreQuota?: number;
        lowPriorityCoreQuota?: number;
        poolQuota?: number;
        activeJobAndJobScheduleQuota?: number;
        dedicatedCoreQuotaPerVMFamily?: VmFamilyCoreQuota[];
        dedicatedCoreQuotaPerVMFamilyEnforced?: boolean;
        allowedAuthenticationModes?: string[];
        autoStorage?: Record<string, unknown> | null;
        publicNetworkAccess?: string;
    };
}

/** Simplified resource group shape returned by ARM. */
export interface ArmResourceGroup {
    id: string;
    name: string;
    location: string;
    properties: {
        provisioningState: string;
    };
}

// ---------------------------------------------------------------------------
// Batch data plane — Pools
// ---------------------------------------------------------------------------

/** A pool as returned by the Batch data plane API. */
export interface BatchPool {
    id: string;
    displayName?: string;
    url?: string;
    vmSize?: string;
    state?: string;
    allocationState?: string;
    targetDedicatedNodes?: number;
    currentDedicatedNodes?: number;
    targetLowPriorityNodes?: number;
    currentLowPriorityNodes?: number;
    taskSlotsPerNode?: number;
    enableAutoScale?: boolean;
    autoScaleFormula?: string;
    resizeErrors?: Array<{ code?: string; message?: string }>;
    lastModified?: string;
    creationTime?: string;
    startTask?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Batch data plane — Nodes
// ---------------------------------------------------------------------------

/** A compute node as returned by the Batch data plane API. */
export interface BatchNode {
    id: string;
    url?: string;
    state?: string;
    schedulingState?: string;
    vmSize?: string;
    isDedicated?: boolean;
    ipAddress?: string;
    affinityId?: string;
    runningTasksCount?: number;
    totalTasksRun?: number;
    lastBootTime?: string;
    startTaskInfo?: {
        exitCode?: number;
        result?: string;
        startTime?: string;
        endTime?: string;
        failureInfo?: {
            category?: string;
            code?: string;
            message?: string;
        };
    };
    errors?: Array<{
        code?: string;
        message?: string;
    }>;
}

/** Supported node actions for `performNodeAction`. */
export type NodeAction =
    | "reboot"
    | "reimage"
    | "disableScheduling"
    | "enableScheduling";
