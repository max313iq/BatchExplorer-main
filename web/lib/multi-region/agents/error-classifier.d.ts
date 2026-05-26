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
export type ErrorKind = 
/** A specific (vmSize, region) tuple is permanently non-viable on this tenant. */
"killer-vm-region"
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
export declare function classifyAzureError(error: unknown): ClassifiedError;
//# sourceMappingURL=error-classifier.d.ts.map