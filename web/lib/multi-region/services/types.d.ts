/**
 * Common types used by the multi-region SDK service layer.
 *
 * These types represent the shapes returned by the ARM management plane
 * and the Batch data plane REST APIs. They are intentionally kept lean —
 * only the fields the multi-region feature actually consumes are included.
 */
/** Standard Azure error envelope returned by ARM and Batch APIs. */
export interface AzureError {
    status: number;
    code: string;
    message: string;
}
/** Thrown when an Azure REST call returns a non-2xx status. */
export declare class AzureRequestError extends Error {
    readonly status: number;
    readonly code: string;
    readonly body: unknown;
    readonly locationHeader?: string | undefined;
    readonly isRetryable: boolean;
    readonly isAsync: boolean;
    /**
     * Optional URL pathname (no host, no query) of the failing request.
     * Set by service-layer error mappers so audit-log callers can include
     * the failing endpoint without re-parsing the message string. Not part
     * of the constructor signature — callers attach it post-construction.
     */
    urlPath?: string;
    /**
     * Optional list of nested `error.details[]` entries from the Azure
     * error envelope, preserved separately from the human-readable message
     * so audit logs can capture the full detail set even when the toast
     * truncates the display message.
     */
    details?: Array<{
        code?: string;
        message?: string;
    }>;
    constructor(message: string, status: number, code: string, body: unknown, isRetryable?: boolean, isAsync?: boolean, locationHeader?: string | undefined);
}
/**
 * Typed error taxonomy per Design Contract §1.6. Every typed error extends
 * `AzureRequestError` so existing handlers that branch on `instanceof
 * AzureRequestError` keep working; new code can branch on the specific
 * subclass for finer-grained handling.
 */
/** 401 / 403 from auth providers — token rejected. */
export declare class AuthError extends AzureRequestError {
    constructor(message: string, status: number, code: string, body: unknown);
}
/** 429 — rate limited. Includes the Retry-After hint when present. */
export declare class RateLimitError extends AzureRequestError {
    readonly retryAfterSeconds?: number | undefined;
    constructor(message: string, code: string, body: unknown, retryAfterSeconds?: number | undefined);
}
/** 404 — resource not found. */
export declare class NotFoundError extends AzureRequestError {
    constructor(message: string, code: string, body: unknown);
}
/** 5xx and intermittent network errors. Retryable. */
export declare class TransientError extends AzureRequestError {
    constructor(message: string, status: number, code: string, body: unknown);
}
/** 403 with explicit authorization-failed code (vs token-rejected). */
export declare class PermissionError extends AzureRequestError {
    constructor(message: string, code: string, body: unknown);
}
/** 400 with client-supplied invalid input. */
export declare class ValidationError extends AzureRequestError {
    readonly fieldErrors?: Record<string, string[]> | undefined;
    constructor(message: string, code: string, body: unknown, fieldErrors?: Record<string, string[]> | undefined);
}
/**
 * Map an HTTP status + Azure error envelope to the most specific
 * AzureRequestError subclass. Returns the base `AzureRequestError` when no
 * narrower match applies.
 */
export declare function classifyHttpError(message: string, status: number, code: string, body: unknown, retryAfter?: string | null): AzureRequestError;
/**
 * Wrap an unknown thrown value into an AzureRequestError so consumers can
 * always work in a single error type. Pass-through for AzureRequestError.
 */
export declare function wrapUnknown(e: unknown): AzureRequestError;
/** Check if an HTTP status indicates an async accepted operation */
export declare function isAsyncAccepted(status: number): boolean;
/** Check if an HTTP status is retryable (transient failure) */
export declare function isRetryableStatus(status: number): boolean;
/** Check if a provisioningState indicates completion */
export declare function isTerminalProvisioningState(state: string): boolean;
/** Check if a provisioningState indicates success */
export declare function isSuccessProvisioningState(state: string): boolean;
/** A single Azure subscription. */
export interface ArmSubscription {
    subscriptionId: string;
    displayName: string;
    state: string;
    tenantId: string;
}
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
    resizeErrors?: Array<{
        code?: string;
        message?: string;
    }>;
    lastModified?: string;
    creationTime?: string;
    startTask?: Record<string, unknown>;
}
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
export type NodeAction = "reboot" | "reimage" | "disableScheduling" | "enableScheduling";
/** A user as returned by Microsoft Graph /users. */
export interface GraphUser {
    id: string;
    displayName: string;
    userPrincipalName: string;
    mail: string | null;
    accountEnabled: boolean;
    jobTitle?: string | null;
    department?: string | null;
    /** Number of subscriptions the user has visible role assignments on. */
    subscriptionCount?: number;
}
/** A Microsoft Entra ID tenant accessible to the caller. */
export interface TenantInfo {
    tenantId: string;
    displayName: string;
    defaultDomain?: string;
    tenantCategory?: string;
}
/** A directory role membership (e.g. Global Administrator). */
export interface DirectoryRole {
    id: string;
    displayName: string;
    description?: string;
    roleTemplateId: string;
}
/** An Azure Enterprise Agreement billing account. */
export interface EaBillingAccount {
    id: string;
    name: string;
    displayName: string;
    agreementType: string;
    accountStatus: string;
    accountType: string;
}
/** A billing profile under an EA billing account. */
export interface EaBillingProfile {
    id: string;
    name: string;
    displayName: string;
    status: string;
}
/** An invoice section under an EA billing profile. */
export interface EaInvoiceSection {
    id: string;
    name: string;
    displayName: string;
    state: string;
}
/**
 * An enrollment account under a legacy EA billing account.
 *
 * EA enrollment billing accounts (`agreementType: "EnterpriseAgreement"`)
 * do NOT have billing profiles or invoice sections — those exist only
 * on Microsoft Customer Agreement (MCA) accounts. EA subscriptions
 * are scoped to an enrollment account directly:
 *   /providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea}
 */
export interface EaEnrollmentAccount {
    id: string;
    name: string;
    displayName: string;
    status: string;
    accountOwner?: string;
    costCenter?: string;
    startDate?: string;
    endDate?: string;
}
/** Result of probing an account for EA billing-account access. */
export interface EaCapability {
    hasEa: boolean;
    billingAccountCount: number;
    primaryBillingAccountName?: string;
}
/** Request payload for creating a new subscription under an EA enrollment. */
export interface CreateSubscriptionRequest {
    aliasName: string;
    displayName: string;
    billingScope: string;
    workload?: "Production" | "DevTest";
    /**
     * Optional cross-tenant assignment. When omitted, the new
     * subscription lands in the calling principal's home tenant.
     */
    subscriptionTenantId?: string;
    /**
     * Optional AAD object ID of the user / SPN in
     * `subscriptionTenantId` who becomes the subscription Owner.
     * Required when `subscriptionTenantId` is set; ignored otherwise.
     */
    subscriptionOwnerId?: string;
    /** Optional management group to place the new subscription under. */
    managementGroupId?: string;
    /** Optional resource tags applied at subscription creation time. */
    tags?: Record<string, string>;
}
/** Endpoint family used to scope rate-limit + breaker state.
 *
 * Hierarchical: services may pass a more specific sub-family (e.g.
 * `graph:directoryRoles`, `graph:users`) so a single slow Graph endpoint
 * does not poison every Graph caller. `RequestGuard` keys breakers by the
 * full string so finer-grained families simply get their own circuit.
 *
 * `partner-center` is the dedicated family for Partner Center API calls
 * (they hit a different host with a different throttle namespace than ARM).
 */
export type EndpointFamily = "arm" | "graph" | `graph:${string}` | "partner-center" | `batch-${string}`;
/** Circuit breaker state. */
export type CircuitState = "closed" | "open" | "half_open";
/** Per-(subscription, endpoint family) snapshot of throttle health. */
export interface ThrottleStatusEntry {
    state: CircuitState;
    refillPerSec: number;
    recentThrottles: number;
    openUntil?: string;
}
/** A historical record of a circuit-state transition. */
export interface ThrottleTransition {
    timestamp: string;
    subscriptionId: string;
    family: EndpointFamily;
    from: CircuitState;
    to: CircuitState;
    reason: string;
}
//# sourceMappingURL=types.d.ts.map