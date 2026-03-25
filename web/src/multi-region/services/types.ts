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
    constructor(
        message: string,
        public readonly status: number,
        public readonly code: string,
        public readonly body: Record<string, unknown>
    ) {
        super(message);
        this.name = "AzureRequestError";
    }
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
