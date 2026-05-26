/**
 * Microsoft Partner Center service layer.
 *
 * Lightweight probes that the Partner Center page uses to determine
 * whether a signed-in account holds Cloud Solution Provider (CSP) or
 * Microsoft Partner Network / Microsoft AI Cloud Partner Program
 * (MPN / MAICPP) capability, plus the Partner Admin Link (PAL) helpers
 * that live on the ARM control plane under
 * `Microsoft.ManagementPartner/partners/{partnerId}`.
 *
 * Each probe returns a discriminated `ProbeResult` so the UI can show
 * a clean pass / fail / unknown badge without having to parse error
 * shapes per call site.
 */
export type ProbeOutcome = "pass" | "fail" | "unauthorized" | "unknown";
export interface ProbeResult<T = unknown> {
    outcome: ProbeOutcome;
    /** Human-readable summary (short) — usable as a badge / one-liner. */
    summary: string;
    /** HTTP status of the underlying call, if any. */
    status?: number;
    /** AAD / ARM error code, if any. */
    code?: string;
    /** Parsed body on success, or `null` if the call failed. */
    data?: T | null;
    /** Failure detail (preserved for the audit log + raw-error toggle). */
    detail?: string;
}
export interface CspCustomerSummary {
    totalCount: number;
    /** First page of customer ids — diagnostics only. */
    sample: string[];
}
/**
 * Probe Cloud Solution Provider (CSP) capability.
 *
 * Hits `GET /v1/customers?size=1` on Partner Center. A 200 with a
 * `totalCount`/`items` payload means the account holds at least the
 * CSP "view customers" permission — i.e. is enrolled as a CSP
 * partner. 401/403 means the account is signed in but lacks CSP
 * access. Token-acquisition failure (consent_required etc.) typically
 * means the tenant isn't a partner tenant at all.
 */
export declare function probeCspAccess(partnerCenterToken: string): Promise<ProbeResult<CspCustomerSummary>>;
export interface MpnProfileSummary {
    mpnId?: string;
    profileType?: string;
    /** Raw profile body for the diagnostics panel. */
    raw: Record<string, unknown>;
}
/**
 * Probe Microsoft Partner Network / MAICPP capability.
 *
 * Hits `GET /v1/profiles/mpn` on Partner Center. A 200 means the
 * account's tenant has an MPN profile registered — the response
 * carries the `mpnId` (Partner ID) and the membership profile type.
 */
export declare function probeMpnProfile(partnerCenterToken: string): Promise<ProbeResult<MpnProfileSummary>>;
export interface LegalBusinessProfileSummary {
    companyName?: string;
    /** Raw profile body. */
    raw: Record<string, unknown>;
}
/**
 * Probe the partner's legal-business profile — proves the partner is
 * past the onboarding "business verification" gate. Often the first
 * call that fails if a partner is mid-onboarding or has had their
 * partnership suspended.
 */
export declare function probeLegalBusinessProfile(partnerCenterToken: string): Promise<ProbeResult<LegalBusinessProfileSummary>>;
export interface PartnerAdminLinkSummary {
    partnerId: string;
    /** ISO timestamp when the link was created, when ARM returns it. */
    createdTime?: string;
    /** Raw ARM resource body. */
    raw: Record<string, unknown>;
}
/**
 * Read the Partner Admin Link for the signed-in principal. ARM
 * accepts any 6+ digit partner id in the path — the call only
 * succeeds if THAT partner id is linked. If you just want to check
 * "is anything linked", you have to know the partner id up front;
 * this helper takes one and confirms.
 */
export declare function getPartnerAdminLink(partnerId: string, armToken: string): Promise<ProbeResult<PartnerAdminLinkSummary>>;
/**
 * Link a Partner Admin Link Partner ID to the signed-in principal.
 * Idempotent — PUT against the same partner id succeeds even when the
 * link already exists.
 */
export declare function linkPartnerAdmin(partnerId: string, armToken: string): Promise<PartnerAdminLinkSummary>;
/**
 * Unlink the Partner Admin Link. Treats 404 (already unlinked) as
 * silent success — the caller's intent is satisfied either way.
 */
export declare function unlinkPartnerAdmin(partnerId: string, armToken: string): Promise<void>;
//# sourceMappingURL=partner-center-service.d.ts.map