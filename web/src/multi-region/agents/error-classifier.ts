/**
 * Classify Azure ARM / Batch errors so smart-mode can decide:
 *   - permanent skip (vmSize+region blacklist)
 *   - retry on different VM in same region (transient capacity / quota)
 *   - hard-stop (permission, subscription disabled)
 *
 * The classifier reads the Azure error code (preferred) and falls back to
 * substring matching on the human-readable message — Azure's error
 * surface isn't perfectly consistent between Batch data plane and ARM.
 */

import { AzureRequestError } from "../services/types";

export type ErrorKind =
  /** A specific (vmSize, region) tuple is permanently non-viable on this tenant. */
  | "killer-vm-region"
  /** The whole region is non-viable (e.g. RegionDoesNotAllowProvisioning). */
  | "killer-region"
  /** vCPU / core / pool quota exhausted — retry with a different VM size. */
  | "quota"
  /** Azure capacity transient — retry with backoff or different VM size. */
  | "capacity"
  /** Caller lacks permission — propagate, don't retry. */
  | "permission"
  /** Provider not registered — handled separately, surface as fatal. */
  | "provider-unregistered"
  /** Subscription is disabled / suspended / past-due. */
  | "subscription-blocked"
  /** Conflict / state error — retry may help. */
  | "transient"
  /** Something we don't know — be conservative, don't blacklist. */
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  /** Short human-readable reason, suitable for storing in the blacklist. */
  reason: string;
  /** Whether to keep iterating to the next VM size in the same region. */
  shouldFallbackVm: boolean;
  /** Whether to abort the entire workflow. */
  shouldAbortRun: boolean;
}

const KILLER_VM_REGION_CODES = new Set<string>([
  "SkuNotAvailable",
  "NotAvailableForSubscription",
  "VMSizeNotAvailable",
  "AllocationFailedForOfferNotSupported",
  "ImageNotFound",
  "InvalidParameterValue",
  "InvalidVMSizeName",
  "VMSizeIsNotAvailable",
]);

const KILLER_REGION_CODES = new Set<string>([
  "RegionDoesNotAllowProvisioning",
  "RegionNotAllowed",
  "LocationNotAvailable",
  "AccountAlreadyExistsInAnotherRegion",
]);

const QUOTA_CODES = new Set<string>([
  "QuotaExceeded",
  "CoreQuotaExceeded",
  "DedicatedCoreQuotaExceeded",
  "LowPriorityCoreQuotaExceeded",
  "AccountQuotaExceeded",
  "OperationNotAllowed", // commonly wraps "operation has been blocked due to quota"
]);

const CAPACITY_CODES = new Set<string>([
  "AllocationFailed",
  "ZonalAllocationFailed",
  "OverconstrainedAllocationRequest",
  "AllocationFailureForRequestedSize",
  "InsufficientCapacityForVMSize",
]);

const PERMISSION_CODES = new Set<string>([
  "AuthorizationFailed",
  "Forbidden",
  "InsufficientPermissions",
]);

const SUBSCRIPTION_BLOCKED_CODES = new Set<string>([
  "DisabledSubscription",
  "ReadOnlyDisabledSubscription",
  "SubscriptionNotRegistered",
  "SubscriptionPolicyDisabled",
]);

function lowerMessage(msg: string | undefined): string {
  return (msg ?? "").toLowerCase();
}

/**
 * Substring fingerprints — used when the error code is generic
 * (`OperationNotAllowed`, `BadRequest`, etc.) and we still need to
 * disambiguate the underlying cause.
 */
function fingerprint(msg: string): ErrorKind | null {
  const m = lowerMessage(msg);
  if (!m) return null;

  if (
    m.includes("not available in the requested location") ||
    m.includes("is not available in") ||
    m.includes("not supported in this region") ||
    m.includes("requested vm size is not available")
  ) {
    return "killer-vm-region";
  }
  if (
    m.includes("region does not allow") ||
    m.includes("location is not available") ||
    m.includes("offer is not available in")
  ) {
    return "killer-region";
  }
  if (
    m.includes("not registered to use namespace") ||
    m.includes("missingsubscriptionregistration")
  ) {
    return "provider-unregistered";
  }
  if (
    m.includes("subscription is disabled") ||
    m.includes("subscription is suspended") ||
    m.includes("disabled subscription")
  ) {
    return "subscription-blocked";
  }
  if (
    m.includes("quota") ||
    m.includes("core limit") ||
    m.includes("exceeded the limit")
  ) {
    return "quota";
  }
  if (
    m.includes("allocation failed") ||
    m.includes("not enough capacity") ||
    m.includes("currently is unavailable")
  ) {
    return "capacity";
  }
  if (
    m.includes("authorization") ||
    m.includes("not authorized") ||
    m.includes("does not have permission") ||
    m.includes("forbidden")
  ) {
    return "permission";
  }
  return null;
}

export function classifyAzureError(error: unknown): ClassifiedError {
  const azErr = error instanceof AzureRequestError ? error : null;
  const code = azErr?.code ?? "";
  const status = azErr?.status ?? 0;
  const message =
    (error as { message?: string })?.message ??
    (typeof error === "string" ? error : "");

  // Code-driven classification
  if (KILLER_VM_REGION_CODES.has(code)) {
    return {
      kind: "killer-vm-region",
      reason: `${code}: ${message}`,
      shouldFallbackVm: true,
      shouldAbortRun: false,
    };
  }
  if (KILLER_REGION_CODES.has(code)) {
    return {
      kind: "killer-region",
      reason: `${code}: ${message}`,
      shouldFallbackVm: false,
      shouldAbortRun: false,
    };
  }
  if (QUOTA_CODES.has(code)) {
    return {
      kind: "quota",
      reason: `${code}: ${message}`,
      shouldFallbackVm: true,
      shouldAbortRun: false,
    };
  }
  if (CAPACITY_CODES.has(code)) {
    return {
      kind: "capacity",
      reason: `${code}: ${message}`,
      shouldFallbackVm: true,
      shouldAbortRun: false,
    };
  }
  if (PERMISSION_CODES.has(code) || status === 403) {
    return {
      kind: "permission",
      reason: code ? `${code}: ${message}` : message,
      shouldFallbackVm: false,
      shouldAbortRun: true,
    };
  }
  if (SUBSCRIPTION_BLOCKED_CODES.has(code)) {
    return {
      kind: "subscription-blocked",
      reason: `${code}: ${message}`,
      shouldFallbackVm: false,
      shouldAbortRun: true,
    };
  }

  // Substring-driven fallback — handy when Azure returns a generic code
  // ("OperationNotAllowed", "BadRequest") wrapping a specific cause.
  const fp = fingerprint(message);
  if (fp) {
    return {
      kind: fp,
      reason: code ? `${code}: ${message}` : message,
      shouldFallbackVm:
        fp === "killer-vm-region" ||
        fp === "quota" ||
        fp === "capacity",
      shouldAbortRun:
        fp === "permission" || fp === "subscription-blocked",
    };
  }

  return {
    kind: "unknown",
    reason: code ? `${code}: ${message}` : message || "Unknown error",
    shouldFallbackVm: false,
    shouldAbortRun: false,
  };
}
