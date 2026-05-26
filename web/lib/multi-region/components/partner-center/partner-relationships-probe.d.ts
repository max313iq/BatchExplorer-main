import type { ProbeResult } from "../../services/partner-center-service";
export interface GdapDelegation {
    id: string;
    displayName: string;
    customerTenantId?: string;
    customerDisplayName?: string;
    /** GDAP lifecycle status — see Graph schema. */
    status: string;
    /** ISO timestamp when this delegation transitions to expired. */
    endDateTime?: string;
    /** Directory roles delegated to the operator's tenant. */
    roleNames: string[];
    /**
     * True if the delegation's role set includes a Tier-0 directory
     * role. Mirrors the corpus' "Application Admin / Global Admin =
     * full customer-tenant takeover" finding (§6.2).
     */
    highPriv: boolean;
}
export interface GdapDelegationSummary {
    totalCount: number;
    activeCount: number;
    highPrivActiveCount: number;
    expiringSoonCount: number;
    /** First page of delegations (paged GET, no `$top` follow). */
    sample: GdapDelegation[];
    /**
     * True when the active set exceeds `creepThreshold` OR more than
     * `highPrivRatio` of active rows hold Tier-0 roles. Cheap heuristic;
     * the page surfaces the underlying counts so the operator can judge.
     */
    creep: boolean;
}
/**
 * Probe GDAP relationships from the partner side. Requires
 * `DelegatedAdminRelationship.Read.All` (or `*.ReadWrite.All`) on
 * Microsoft Graph for the operator's principal.
 *
 * Source: `_bypass_tenant_switch.md` §6.2; `_AZURE_BYPASS_PLAYBOOK.md`
 * Phase 4 (enumerate `/v1.0/tenantRelationships/delegatedAdminRelationships`).
 */
export declare function probeGdapDelegations(graphToken: string): Promise<ProbeResult<GdapDelegationSummary>>;
export interface SubscriptionPalRow {
    subscriptionId: string;
    displayName: string;
    state: string;
    /** Tenant the subscription is homed in (where ARM lists it). */
    tenantId?: string;
    /** Partner ID stamped on the subscription, when one is present. */
    palPartnerId?: string;
    /** True when palPartnerId is set and differs from the preferred MPN. */
    mismatch: boolean;
    /** True when no PAL is stamped on this subscription. */
    noPal: boolean;
}
export interface PalDriftSummary {
    totalSubscriptions: number;
    noPalCount: number;
    mismatchCount: number;
    preferredMpn: string | null;
    rows: SubscriptionPalRow[];
}
/**
 * Probe subscription-level PAL drift. Requires ARM listing
 * permission. Optional `preferredMpn` (the configured MPN id) drives
 * the mismatch flag — when omitted, only the no-PAL gap is surfaced.
 *
 * Source: `_bypass_tenant_switch.md` §6.3 (PAL/MSP stale relationships).
 */
export declare function probePalDrift(armToken: string, preferredMpn: string | null, options?: {
    maxSubscriptions?: number;
}): Promise<ProbeResult<PalDriftSummary>>;
export interface CustomerMatrixRow {
    customerId: string;
    companyName?: string;
    domain?: string;
    /** Outcome of the per-customer subscription probe. */
    outcome: "pass" | "fail" | "unauthorized" | "skipped";
    /** Number of cloud subscriptions visible under this CSP customer. */
    subscriptionCount?: number;
    /** Optional short error if the probe failed. */
    error?: string;
}
/**
 * Iterate customer IDs and probe each one. The progress callback
 * fires after each customer so the page can paint a progress bar.
 *
 * Cancellation: the supplied `AbortSignal` is checked before each
 * iteration so the operator can bail out of a long sweep without
 * leaking a setState into a stale render.
 */
export declare function bulkProbeCustomers(customerIds: readonly string[], partnerCenterToken: string, opts?: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, row: CustomerMatrixRow) => void;
}): Promise<CustomerMatrixRow[]>;
//# sourceMappingURL=partner-relationships-probe.d.ts.map