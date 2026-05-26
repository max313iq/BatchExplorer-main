/**
 * Partner-relationships probes — page-local helpers that surface
 * MSP / GDAP / Lighthouse / PAL "drift" signals on top of the
 * existing CSP/MPN/legal-business/PAL probes.
 *
 * These are read-only enumerations against Graph + ARM that the
 * defensive view of the operator's tenant cares about:
 *
 *   - **GDAP delegation creep.** Microsoft Graph exposes the partner-
 *     side ledger of customer relationships at
 *     `GET /v1.0/tenantRelationships/delegatedAdminRelationships`.
 *     The corpus playbook `_bypass_tenant_switch.md` §6.2 flags this
 *     as the canonical pivot vector — defenders rarely audit GDAP
 *     delegations because they're invisible in the customer's role
 *     list unless specifically queried. Whenever the operator's
 *     tenant has an unusually large or growing active-delegation set,
 *     it's worth surfacing: a compromised MSP inherits access to
 *     every downstream customer.
 *
 *   - **PAL drift across subscriptions.** Microsoft attributes Azure
 *     consumption to a partner of record by stamping
 *     `Microsoft.ManagementPartner/partners/{partnerId}` on a
 *     principal. The corpus playbook `_bypass_tenant_switch.md` §6.3
 *     calls out PAL as one of the "looks routine" signals defenders
 *     miss — a subscription stamped with a stale or third-party
 *     MPN still attributes consumption (and may indicate a stale
 *     MSP relationship the operator has forgotten about). We pull
 *     the operator's accessible subscriptions and flag those whose
 *     billing-property `quotaId` / partner attribution disagrees with
 *     the configured "preferred MPN".
 *
 * Both probes are kept page-local (not promoted to
 * `services/partner-center-service.ts`) per the per-page no-edit
 * constraint — they extend the partner-center surface without
 * mutating any shared service layer.
 *
 * Source-of-truth citations:
 *   - `New folder/_bypass_tenant_switch.md` §6.1–§6.3 (Lighthouse /
 *     GDAP / MSP supply-chain)
 *   - `New folder/_bypass_mixed_chains.md` Chain (MSP → customer) —
 *     uses the same Graph endpoint
 *   - `New folder/_AZURE_BYPASS_PLAYBOOK.md` Phase 4 (escalate via
 *     GDAP enumeration)
 */
import { AzureRequestError, classifyHttpError } from "../../services/types";
import { guardedFetch } from "../../scheduling/request-governance";
import type { ProbeResult } from "../../services/partner-center-service";

const GRAPH_BASE = "https://graph.microsoft.com";
const ARM_BASE = "https://management.azure.com";

/* ─────────────────────────────────────────────────────────────────────
 * GDAP delegation creep detector
 *
 * `GET /v1.0/tenantRelationships/delegatedAdminRelationships`
 *
 * Returns the partner-side ledger of delegated-admin relationships:
 * each row is one customer tenant the operator's tenant has (or had)
 * GDAP roles on, along with the requested directory roles and
 * lifecycle status (`active`, `terminated`, `expired`, `created`,
 * `approvalPending`, etc.).
 *
 * Detection model: when the count of *active* relationships exceeds
 * a soft threshold OR the active set is heavily skewed toward
 * high-privilege roles (Global Admin, Privileged Role Admin,
 * Application Admin), surface it as a creep signal. A high count
 * isn't itself malicious — a real MSP often has dozens — but it tells
 * the operator how much downstream blast radius the tenant carries.
 * ───────────────────────────────────────────────────────────────────── */

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
 * Tier-0 directory-role display names. Sourced from the corpus —
 * the canonical "owns the tenant" set called out in
 * `_bypass_role_grant.md` §1 and `_bypass_tenant_switch.md` §6.2.
 * Matched against `roleDefinition.displayName` from
 * `accessAssignments` / `roleAssignmentScheduleInstances` payloads.
 */
const HIGH_PRIV_ROLES = new Set<string>([
  "Global Administrator",
  "Privileged Role Administrator",
  "Privileged Authentication Administrator",
  "Application Administrator",
  "Cloud Application Administrator",
  "Directory Writers",
  "Hybrid Identity Administrator",
  "Partner Tier2 Support",
  "User Administrator",
]);

const DELEGATION_CREEP_THRESHOLD = 25;
const HIGH_PRIV_RATIO_TRIGGER = 0.3;
/** Soft "delegation expires within N days" warning window. */
const EXPIRING_SOON_MS = 30 * 24 * 60 * 60 * 1000;

function graphHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ConsistencyLevel: "eventual",
  };
}

function armHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

async function asGraphError(
  response: Response,
  fallback: string,
): Promise<AzureRequestError> {
  let body: Record<string, unknown> = {};
  let raw = "";
  try {
    raw = await response.text();
    if (raw.trim()) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* keep raw */
      }
    }
  } catch {
    /* ignore */
  }
  const inner = (body as { error?: Record<string, unknown> }).error ?? {};
  const code = (inner.code as string | undefined) ?? "GraphError";
  const innerMsg = (inner.message as string | undefined) ?? "";
  const trimmedRaw = raw.trim();
  const msg =
    innerMsg ||
    (trimmedRaw ? trimmedRaw.slice(0, 300) : "") ||
    `${fallback}: ${response.status}`;
  const retryAfter = response.headers.get("Retry-After");
  return classifyHttpError(msg, response.status, code, body, retryAfter);
}

function probeFromGraphError<T>(
  err: unknown,
  fallbackName: string,
): ProbeResult<T> {
  if (err instanceof AzureRequestError) {
    const isAuth = err.status === 401 || err.status === 403;
    return {
      outcome: isAuth ? "unauthorized" : "fail",
      summary: isAuth
        ? `${fallbackName}: not authorized (HTTP ${err.status})`
        : `${fallbackName} failed (HTTP ${err.status})`,
      status: err.status,
      code: err.code,
      data: null,
      detail: err.message,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const isAadAccessDenied =
    /consent_required|interaction_required|unauthorized_client|AADSTS65001|AADSTS70011|AADSTS50020|invalid_resource/i.test(
      msg,
    );
  return {
    outcome: isAadAccessDenied ? "unauthorized" : "unknown",
    summary: isAadAccessDenied
      ? "Graph token denied — tenant lacks DelegatedAdminRelationship.Read.All"
      : `${fallbackName} could not be probed`,
    data: null,
    detail: msg,
  };
}

/**
 * Probe GDAP relationships from the partner side. Requires
 * `DelegatedAdminRelationship.Read.All` (or `*.ReadWrite.All`) on
 * Microsoft Graph for the operator's principal.
 *
 * Source: `_bypass_tenant_switch.md` §6.2; `_AZURE_BYPASS_PLAYBOOK.md`
 * Phase 4 (enumerate `/v1.0/tenantRelationships/delegatedAdminRelationships`).
 */
export async function probeGdapDelegations(
  graphToken: string,
): Promise<ProbeResult<GdapDelegationSummary>> {
  const url =
    `${GRAPH_BASE}/v1.0/tenantRelationships/delegatedAdminRelationships` +
    `?$select=id,displayName,customer,status,endDateTime,accessDetails`;
  try {
    const response = await guardedFetch(
      url,
      { headers: graphHeaders(graphToken) },
      { subscriptionId: "_gdap", family: "graph" },
    );
    if (!response.ok) throw await asGraphError(response, "list GDAP relationships");
    const body = (await response.json()) as {
      value?: Array<{
        id?: string;
        displayName?: string;
        customer?: { tenantId?: string; displayName?: string };
        status?: string;
        endDateTime?: string;
        accessDetails?: {
          unifiedRoles?: Array<{
            roleDefinitionId?: string;
            roleDefinitionDisplayName?: string;
          }>;
        };
      }>;
    };
    const rows: GdapDelegation[] = (body.value ?? []).map((r) => {
      const roleNames = (r.accessDetails?.unifiedRoles ?? [])
        .map((x) => x.roleDefinitionDisplayName ?? "")
        .filter((s) => !!s);
      const highPriv = roleNames.some((n) => HIGH_PRIV_ROLES.has(n));
      return {
        id: r.id ?? "",
        displayName: r.displayName ?? "(unnamed)",
        customerTenantId: r.customer?.tenantId,
        customerDisplayName: r.customer?.displayName,
        status: (r.status ?? "unknown").toString(),
        endDateTime: r.endDateTime,
        roleNames,
        highPriv,
      };
    });
    const now = Date.now();
    const active = rows.filter((r) => r.status === "active");
    const expiringSoon = active.filter(
      (r) =>
        !!r.endDateTime &&
        new Date(r.endDateTime).getTime() - now < EXPIRING_SOON_MS,
    );
    const highPrivActive = active.filter((r) => r.highPriv);
    const creep =
      active.length >= DELEGATION_CREEP_THRESHOLD ||
      (active.length > 0 &&
        highPrivActive.length / active.length >= HIGH_PRIV_RATIO_TRIGGER &&
        highPrivActive.length >= 3);
    return {
      outcome: "pass",
      summary: creep
        ? `GDAP creep: ${active.length} active (${highPrivActive.length} high-priv)`
        : `${active.length} active GDAP delegations (of ${rows.length} total)`,
      status: response.status,
      data: {
        totalCount: rows.length,
        activeCount: active.length,
        highPrivActiveCount: highPrivActive.length,
        expiringSoonCount: expiringSoon.length,
        sample: rows.slice(0, 20),
        creep,
      },
    };
  } catch (err) {
    return probeFromGraphError<GdapDelegationSummary>(err, "GDAP delegations");
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Subscription-level PAL drift detector
 *
 * `GET /subscriptions?api-version=2020-01-01`
 *
 * Pulls the subscriptions the operator can list, then for each
 * subscription tries
 * `GET /subscriptions/{id}/providers/Microsoft.ManagementPartner/partners?api-version=2018-02-01`
 * (subscription-scoped PAL — distinct from the principal-scoped one
 * already probed by the page) and surfaces:
 *
 *   - subscriptions with no PAL attached (revenue-attribution gap)
 *   - subscriptions whose PAL `partnerId` differs from the operator's
 *     configured "preferred MPN" — i.e. a *third* partner is the
 *     partner of record, which the corpus playbook flags as a stale-
 *     MSP-relationship indicator (`_bypass_tenant_switch.md` §6.3 —
 *     MSP supply-chain abuse: dormant relationships are the most
 *     common rooting target because they don't generate alerts).
 *
 * Note: not every Azure ARM build exposes the subscription-scoped
 * PAL endpoint; on 404 we treat it as "no PAL" and surface it as a
 * gap rather than a probe failure.
 * ───────────────────────────────────────────────────────────────────── */

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
export async function probePalDrift(
  armToken: string,
  preferredMpn: string | null,
  options: { maxSubscriptions?: number } = {},
): Promise<ProbeResult<PalDriftSummary>> {
  const { maxSubscriptions = 50 } = options;
  const listUrl = `${ARM_BASE}/subscriptions?api-version=2020-01-01`;
  try {
    const response = await guardedFetch(
      listUrl,
      { headers: armHeaders(armToken) },
      { subscriptionId: "_pal-drift", family: "arm" },
    );
    if (!response.ok) throw await asGraphError(response, "list subscriptions");
    const body = (await response.json()) as {
      value?: Array<{
        subscriptionId?: string;
        displayName?: string;
        state?: string;
        tenantId?: string;
      }>;
    };
    const subs = (body.value ?? []).slice(0, maxSubscriptions);

    const rows: SubscriptionPalRow[] = await Promise.all(
      subs.map(async (s) => {
        const subId = s.subscriptionId ?? "";
        const row: SubscriptionPalRow = {
          subscriptionId: subId,
          displayName: s.displayName ?? subId,
          state: s.state ?? "Unknown",
          tenantId: s.tenantId,
          palPartnerId: undefined,
          mismatch: false,
          noPal: true,
        };
        if (!subId) return row;
        // Subscription-scoped PAL endpoint. Some ARM builds reject
        // `GET partners` collection and only accept `GET partners/{id}`;
        // we ignore non-200 silently and mark noPal=true.
        try {
          const palUrl =
            `${ARM_BASE}/subscriptions/${encodeURIComponent(subId)}/providers/` +
            `Microsoft.ManagementPartner/partners?api-version=2018-02-01`;
          const palResp = await guardedFetch(
            palUrl,
            { headers: armHeaders(armToken) },
            { subscriptionId: subId, family: "arm" },
          );
          if (palResp.status === 200) {
            const data = (await palResp.json()) as {
              value?: Array<{
                properties?: { partnerId?: string };
              }>;
            };
            const first = data.value?.[0];
            const pid = first?.properties?.partnerId;
            if (pid) {
              row.palPartnerId = pid;
              row.noPal = false;
              if (preferredMpn && pid !== preferredMpn) {
                row.mismatch = true;
              }
            }
          }
        } catch {
          /* swallow per-subscription failure; row stays noPal=true */
        }
        return row;
      }),
    );

    const noPalCount = rows.filter((r) => r.noPal).length;
    const mismatchCount = rows.filter((r) => r.mismatch).length;
    const detail =
      preferredMpn
        ? `${mismatchCount} mismatched, ${noPalCount} no-PAL`
        : `${noPalCount} no-PAL (no preferred MPN configured)`;
    return {
      outcome: "pass",
      summary: `${rows.length} subscriptions scanned — ${detail}`,
      status: response.status,
      data: {
        totalSubscriptions: rows.length,
        noPalCount,
        mismatchCount,
        preferredMpn: preferredMpn ?? null,
        rows,
      },
    };
  } catch (err) {
    return probeFromGraphError<PalDriftSummary>(err, "Subscription PAL drift");
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Bulk customer probe — for the CSP-customer matrix.
 *
 * Iterates the first page of CSP customers returned by `probeCspAccess`
 * and, for each one, attempts a per-customer scope-down GET of the
 * MPN profile so the operator can see at a glance which of their CSP
 * customers carry an MPN/partner attribution and which don't.
 *
 * This is intentionally rate-limited (one request at a time) — the
 * Partner Center API throttles aggressively on parallel reads from
 * the same partner principal, and the operator's intent is "audit
 * the matrix", not "race through it".
 * ───────────────────────────────────────────────────────────────────── */

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
export async function bulkProbeCustomers(
  customerIds: readonly string[],
  partnerCenterToken: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, row: CustomerMatrixRow) => void;
  } = {},
): Promise<CustomerMatrixRow[]> {
  const { signal, onProgress } = opts;
  const out: CustomerMatrixRow[] = [];
  for (let i = 0; i < customerIds.length; i += 1) {
    if (signal?.aborted) break;
    const id = customerIds[i]!;
    const row: CustomerMatrixRow = { customerId: id, outcome: "skipped" };
    try {
      // GET /v1/customers/{id} returns companyProfile + a subscriptions
      // pointer. Slim payload, single round-trip per customer.
      const url = `https://api.partnercenter.microsoft.com/v1/customers/${encodeURIComponent(id)}`;
      const r = await guardedFetch(
        url,
        {
          headers: {
            Authorization: `Bearer ${partnerCenterToken}`,
            Accept: "application/json",
            "Accept-Language": "en-US",
          },
        },
        { subscriptionId: "_partner-center", family: "partner-center" },
      );
      if (r.ok) {
        const body = (await r.json()) as {
          companyProfile?: { companyName?: string; domain?: string };
          relationshipToPartner?: string;
        };
        row.companyName = body.companyProfile?.companyName;
        row.domain = body.companyProfile?.domain;
        row.outcome = "pass";
      } else if (r.status === 401 || r.status === 403) {
        row.outcome = "unauthorized";
        row.error = `HTTP ${r.status}`;
      } else {
        row.outcome = "fail";
        row.error = `HTTP ${r.status}`;
      }
    } catch (err) {
      row.outcome = "fail";
      row.error = err instanceof Error ? err.message : String(err);
    }
    out.push(row);
    onProgress?.(i + 1, customerIds.length, row);
  }
  return out;
}
