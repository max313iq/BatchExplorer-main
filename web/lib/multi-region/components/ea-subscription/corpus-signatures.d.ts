/**
 * corpus-signatures — pre-submit defensive detections grounded in the
 * offensive-tooling research corpus.
 *
 * These checks classify the SHAPE of a proposed batch — they never block
 * or rewrite the submit. The output drives a "Pre-flight Cross-Tenant
 * Signature" tile that surfaces patterns matching documented EA-billing
 * abuse primitives so the operator can re-confirm before clicking submit.
 *
 * References (read directly from corpus, not paraphrased):
 *   - `_ea_subscription_cross_tenant.md` §1, §4, §9
 *     - Resource: fa3d9a0c-3fb0-42cc-9193-47c7ecd2edbd (MS Partner Center)
 *     - SubscriptionMigrator app role on Microsoft Billing SPN
 *       (80dbdb39-4f33-4799-8b6f-711b5e3e61b6)
 *     - Cross-tenant alias creation: `subscriptionTenantId` differs from
 *       caller's home tenant claim (`tid`).
 *     - "compromised MSP using its GDAP / DAP delegations to silently
 *       create subscriptions in customer tenants" — the abuse signature
 *       this module is designed to surface.
 *   - `_bypass_role_grant.md` (billing role chains): Account Owner ->
 *     Subscription Creator -> implicit Owner on each new sub.
 *
 * The detections are HEURISTICS — they err toward warning the operator
 * rather than silently letting an unusual batch fly. This file is pure;
 * no React, no side effects, easily unit-testable.
 */
export type RecipientSource = "web-account" | "tenant-user" | "manual";
export interface SignatureInput {
    /** The active EA caller's home tenant (lowercased OK). */
    callerTenantId: string;
    /** The active EA caller's username/upn — used to derive SP-vs-user. */
    callerUpn: string | undefined;
    /** Each recipient in the proposed batch. */
    recipients: ReadonlyArray<{
        source: RecipientSource;
        tenantId: string;
        ownerObjectId: string;
        displayLabel: string;
        upn?: string;
    }>;
}
export type SignatureSeverity = "info" | "notice" | "warning" | "critical";
export interface SignatureFinding {
    id: string;
    severity: SignatureSeverity;
    title: string;
    detail: string;
    /** Corpus citation. */
    citation: string;
}
/**
 * Cross-tenant bulk fan-out: many subscriptions provisioned into a single
 * non-home target tenant in one batch. This is the documented MSP-GDAP
 * abuse pattern (`_ea_subscription_cross_tenant.md` §9) — the legitimate
 * case is rare (an MSP onboarding ten customers in one click), the
 * abusive case looks identical, so we surface it for the operator to
 * confirm intent.
 */
export declare function detectCrossTenantFanOut(input: SignatureInput): SignatureFinding | null;
/**
 * Mixed-recipient-class anomaly: a batch that mixes service principal
 * and human-user owners. This is operator-confusing in the audit log
 * (different downstream Owner-role grants apply) and matches the
 * "diverse owner pattern" surfaced by AzureHound when an SP-heavy
 * tenant suddenly receives user-owned subs (per `_analysis_specterops.md`
 * → AzureHound enumeration nodes). Not a hard block — a confirmation.
 */
export declare function detectMixedRecipientClass(input: SignatureInput): SignatureFinding | null;
/**
 * Self-target anomaly: caller is in tenant X but every recipient is
 * also caller (selfAssign-equivalent multi-self), or every recipient
 * is the caller's own oid replicated across multiple tenants. Both are
 * misuse patterns (creator accidentally re-runs the form, or the
 * operator typoed a fan-out).
 */
export declare function detectSelfReplication(input: SignatureInput): SignatureFinding | null;
/**
 * Manual-paste-heavy batch: more than half of the batch was pasted as
 * raw `(tenantId, owner)` GUIDs (source = "manual"). Surfaced as a
 * gentle reminder to verify the GUIDs because manual paste skips the
 * picker's enabled/disabled/tenant resolution checks.
 */
export declare function detectManualPasteHeavy(input: SignatureInput): SignatureFinding | null;
export declare function computeSignatures(input: SignatureInput): SignatureFinding[];
/**
 * Pre-create simulation: enumerate the audit events that will fire when
 * the submit lands, in tenant of origin, in order. Helps the operator
 * predict what their SIEM / Activity Log will show before any
 * irreversible call.
 *
 * The actual event names match the strings emitted from the submit
 * pipeline (see performSubmit / runOne in ea-subscription-page.tsx) so
 * the SIEM-side filter the operator builds will match real events.
 */
export interface SimulatedEvent {
    order: number;
    event: string;
    tenant: "caller" | "destination" | "azure-activity";
    detail: string;
}
export declare function simulatePreCreate(input: {
    recipientCount: number;
    crossTenantCount: number;
    callerTenantLabel: string;
}): SimulatedEvent[];
//# sourceMappingURL=corpus-signatures.d.ts.map