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
export function detectCrossTenantFanOut(
  input: SignatureInput,
): SignatureFinding | null {
  const caller = input.callerTenantId.toLowerCase();
  const byTenant = new Map<string, number>();
  for (const r of input.recipients) {
    const tid = r.tenantId.toLowerCase();
    if (tid === caller) continue;
    byTenant.set(tid, (byTenant.get(tid) ?? 0) + 1);
  }
  if (byTenant.size === 0) return null;
  let largest: { tid: string; count: number } | null = null;
  for (const [tid, count] of byTenant) {
    if (!largest || count > largest.count) largest = { tid, count };
  }
  if (!largest) return null;
  if (largest.count >= 5) {
    return {
      id: "cross-tenant-fan-out",
      severity: largest.count >= 20 ? "critical" : "warning",
      title: `${largest.count} subs fanning into a single non-home tenant`,
      detail:
        `This batch creates ${largest.count} subscriptions into tenant ` +
        `${largest.tid.slice(0, 8)}…, none in your home tenant. This is the ` +
        `shape of an MSP-GDAP / compromised-billing-owner bulk plant — ` +
        `please confirm the target tenant is yours/your customer's and ` +
        `that you intended to provision into it (not a hijacked or ` +
        `look-alike tenant ID).`,
      citation:
        "_ea_subscription_cross_tenant.md §1, §9; subscriptions land in `subscriptionTenantId`, not the caller's `tid`.",
    };
  }
  if (largest.count >= 3) {
    return {
      id: "cross-tenant-fan-out",
      severity: "notice",
      title: `${largest.count} cross-tenant subs to ${largest.tid.slice(0, 8)}…`,
      detail:
        `${largest.count} subscriptions in this batch target a tenant other ` +
        `than your home (caller) tenant. Verify the destination tenant ID ` +
        `matches the operator/customer you intend to provision for.`,
      citation:
        "_ea_subscription_cross_tenant.md §2 (subscriptionOwnerId must resolve in destination tenant).",
    };
  }
  return null;
}

/**
 * Mixed-recipient-class anomaly: a batch that mixes service principal
 * and human-user owners. This is operator-confusing in the audit log
 * (different downstream Owner-role grants apply) and matches the
 * "diverse owner pattern" surfaced by AzureHound when an SP-heavy
 * tenant suddenly receives user-owned subs (per `_analysis_specterops.md`
 * → AzureHound enumeration nodes). Not a hard block — a confirmation.
 */
export function detectMixedRecipientClass(
  input: SignatureInput,
): SignatureFinding | null {
  let userish = 0;
  let spish = 0;
  for (const r of input.recipients) {
    const upn = r.upn?.toLowerCase() ?? "";
    // SP heuristic: no UPN, or UPN looks like an app GUID, or label
    // mentions "service principal". UPN with @ is almost certainly a
    // user. Manual source with no UPN is treated as SP-ish (operator
    // pasted a raw object ID).
    if (!upn || /^[0-9a-f-]{30,}$/i.test(upn)) {
      spish += 1;
    } else if (upn.includes("@")) {
      userish += 1;
    } else {
      spish += 1;
    }
  }
  if (userish > 0 && spish > 0) {
    return {
      id: "mixed-recipient-class",
      severity: "notice",
      title: `Batch mixes ${userish} user(s) and ${spish} SP/raw-id recipient(s)`,
      detail:
        `Mixed owner classes in one batch is unusual — humans typically ` +
        `provision via one of the two, not both at once. Double-check that ` +
        `every SP-style row is truly a service principal in the destination ` +
        `tenant (otherwise the alias call fails with InvalidSubscriptionOwnerId).`,
      citation:
        "_ea_subscription_cross_tenant.md §2 (subscriptionOwnerId resolution); _analysis_specterops.md (AzureHound owner-class enumeration).",
    };
  }
  return null;
}

/**
 * Self-target anomaly: caller is in tenant X but every recipient is
 * also caller (selfAssign-equivalent multi-self), or every recipient
 * is the caller's own oid replicated across multiple tenants. Both are
 * misuse patterns (creator accidentally re-runs the form, or the
 * operator typoed a fan-out).
 */
export function detectSelfReplication(
  input: SignatureInput,
): SignatureFinding | null {
  if (input.recipients.length < 2) return null;
  const owners = new Set(
    input.recipients.map((r) => r.ownerObjectId.toLowerCase()),
  );
  if (owners.size === 1) {
    return {
      id: "self-replication",
      severity: "warning",
      title: `All ${input.recipients.length} recipients share the same owner object id`,
      detail:
        `Every row in this batch points at the same subscriptionOwnerId. ` +
        `Unless you are intentionally placing multiple subscriptions under ` +
        `one user across different destination tenants, the rows are ` +
        `duplicates and only the first will succeed (others 409 on alias).`,
      citation:
        "_ea_subscription_cross_tenant.md §8 (ConflictingAlias / duplicate-owner trap).",
    };
  }
  return null;
}

/**
 * Manual-paste-heavy batch: more than half of the batch was pasted as
 * raw `(tenantId, owner)` GUIDs (source = "manual"). Surfaced as a
 * gentle reminder to verify the GUIDs because manual paste skips the
 * picker's enabled/disabled/tenant resolution checks.
 */
export function detectManualPasteHeavy(
  input: SignatureInput,
): SignatureFinding | null {
  if (input.recipients.length === 0) return null;
  const manual = input.recipients.filter((r) => r.source === "manual").length;
  const pct = manual / input.recipients.length;
  if (manual >= 10 && pct >= 0.5) {
    return {
      id: "manual-paste-heavy",
      severity: "notice",
      title: `${manual} of ${input.recipients.length} recipients were pasted manually`,
      detail:
        `Pasted recipients bypass picker-side checks (account-enabled, ` +
        `tenant resolution). Spot-check a few rows before submit — a ` +
        `typo in the owner GUID provisions a subscription nobody can ` +
        `claim, and an EA admin will need to cancel it.`,
      citation:
        "_ea_subscription_cross_tenant.md §2 Option C (operator-typed owner GUIDs).",
    };
  }
  return null;
}

export function computeSignatures(
  input: SignatureInput,
): SignatureFinding[] {
  const out: SignatureFinding[] = [];
  const fns = [
    detectCrossTenantFanOut,
    detectMixedRecipientClass,
    detectSelfReplication,
    detectManualPasteHeavy,
  ];
  for (const fn of fns) {
    const f = fn(input);
    if (f) out.push(f);
  }
  return out;
}

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

export function simulatePreCreate(input: {
  recipientCount: number;
  crossTenantCount: number;
  callerTenantLabel: string;
}): SimulatedEvent[] {
  const out: SimulatedEvent[] = [];
  let i = 1;
  out.push({
    order: i++,
    event: "create_ea_subscription_batch_start",
    tenant: "caller",
    detail: `One audit row with batchKey + recipientCount=${input.recipientCount} in ${input.callerTenantLabel}.`,
  });
  out.push({
    order: i++,
    event: "Microsoft.Subscription/aliases write (PUT)",
    tenant: "caller",
    detail: `${input.recipientCount} ARM Activity Log entries on the EA billing scope. caller_tid = your home tenant.`,
  });
  if (input.crossTenantCount > 0) {
    out.push({
      order: i++,
      event: "Microsoft.Subscription accept-ownership invite (implicit)",
      tenant: "destination",
      detail: `${input.crossTenantCount} pending-acceptance records appear in each destination tenant. New-owner gets an email + 7-day deadline.`,
    });
  }
  out.push({
    order: i++,
    event: "Microsoft.Subscription/subscriptions create",
    tenant: "azure-activity",
    detail: `${input.recipientCount} subscription-create rows under the new subscriptionId. Visible to anyone with billing reader on the EA.`,
  });
  out.push({
    order: i++,
    event: "create_ea_subscription (per recipient)",
    tenant: "caller",
    detail: `${input.recipientCount} per-recipient rows with success/failure + elapsedMs in this WebUI's audit log.`,
  });
  out.push({
    order: i++,
    event: "create_ea_subscription_batch_end",
    tenant: "caller",
    detail: `One audit row summarising success/failure counts in ${input.callerTenantLabel}.`,
  });
  return out;
}
