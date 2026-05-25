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

import { AzureRequestError, classifyHttpError } from "./types";
import { guardedFetch } from "../scheduling/request-governance";

const PARTNER_CENTER_BASE = "https://api.partnercenter.microsoft.com";
const ARM_BASE = "https://management.azure.com";
const PAL_API_VERSION = "2018-02-01";

/* ─────────────────────────────────────────────────────────────────────
 * Common probe shape
 * ───────────────────────────────────────────────────────────────────── */

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

/* ─────────────────────────────────────────────────────────────────────
 * Local helpers
 * ───────────────────────────────────────────────────────────────────── */

function pcHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    // Partner Center sometimes locale-gates fields; en-US is the safe
    // default. Operators can override via Accept-Language at the
    // browser-level if needed.
    "Accept-Language": "en-US",
  };
}

function armHeaders(token: string, contentType?: string): HeadersInit {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

async function toError(
  response: Response,
  fallbackMessage: string,
): Promise<AzureRequestError> {
  let body: Record<string, unknown> = {};
  let raw = "";
  try {
    raw = await response.text();
    if (raw && raw.trim()) {
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
  const code =
    (inner.code as string | undefined) ??
    ((body as { code?: string }).code as string | undefined) ??
    "PartnerCenterError";
  const innerMsg =
    (inner.message as string | undefined) ??
    ((body as { description?: string }).description as string | undefined) ??
    "";
  let msg =
    innerMsg.trim() ||
    (raw && raw.trim() ? raw.trim().slice(0, 500) : "") ||
    `${fallbackMessage}: ${response.status}`;
  const urlPath = (() => {
    try {
      return new URL(response.url).pathname;
    } catch {
      return response.url || undefined;
    }
  })();
  if (urlPath) msg = `${response.status} ${urlPath}: ${msg}`;
  const retryAfter = response.headers.get("Retry-After");
  const err = classifyHttpError(msg, response.status, code, body, retryAfter);
  if (urlPath) err.urlPath = urlPath;
  return err;
}

/** Convert any thrown value into a `ProbeResult.fail/unauthorized`. */
function probeFromError<T>(err: unknown, fallbackName: string): ProbeResult<T> {
  if (err instanceof AzureRequestError) {
    const isAuth = err.status === 401 || err.status === 403;
    return {
      outcome: isAuth ? "unauthorized" : "fail",
      summary: isAuth
        ? `Not authorized (HTTP ${err.status})`
        : `${fallbackName} failed: HTTP ${err.status}`,
      status: err.status,
      code: err.code,
      data: null,
      detail: err.message,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Token-acquisition or network failures land here. AAD's
  // `consent_required` / `interaction_required` / `unauthorized_client`
  // for a tenant without partner enrolment are good signals that the
  // account isn't a CSP partner — surface that as `unauthorized`.
  const isAadAccessDenied =
    /consent_required|interaction_required|unauthorized_client|AADSTS65001|AADSTS70011|AADSTS50020|invalid_resource/i.test(
      msg,
    );
  return {
    outcome: isAadAccessDenied ? "unauthorized" : "unknown",
    summary: isAadAccessDenied
      ? "Token denied — tenant is not enrolled as a CSP partner"
      : `${fallbackName} could not be probed`,
    data: null,
    detail: msg,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Partner Center API probes
 * ───────────────────────────────────────────────────────────────────── */

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
export async function probeCspAccess(
  partnerCenterToken: string,
): Promise<ProbeResult<CspCustomerSummary>> {
  const url = `${PARTNER_CENTER_BASE}/v1/customers?size=1`;
  try {
    const response = await guardedFetch(
      url,
      { headers: pcHeaders(partnerCenterToken) },
      { subscriptionId: "_partner-center", family: "partner-center" },
    );
    if (!response.ok) throw await toError(response, "list customers");
    const body = (await response.json()) as {
      totalCount?: number;
      items?: Array<{ id?: string }>;
    };
    const total = typeof body.totalCount === "number" ? body.totalCount : 0;
    const sample = (body.items ?? [])
      .map((c) => c.id ?? "")
      .filter((s) => !!s)
      .slice(0, 5);
    return {
      outcome: "pass",
      summary: `CSP access confirmed (${total} customer${total === 1 ? "" : "s"})`,
      status: response.status,
      data: { totalCount: total, sample },
    };
  } catch (err) {
    return probeFromError<CspCustomerSummary>(err, "CSP customers");
  }
}

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
export async function probeMpnProfile(
  partnerCenterToken: string,
): Promise<ProbeResult<MpnProfileSummary>> {
  const url = `${PARTNER_CENTER_BASE}/v1/profiles/mpn`;
  try {
    const response = await guardedFetch(
      url,
      { headers: pcHeaders(partnerCenterToken) },
      { subscriptionId: "_partner-center", family: "partner-center" },
    );
    if (!response.ok) throw await toError(response, "get MPN profile");
    const raw = (await response.json()) as Record<string, unknown>;
    const mpnId =
      (raw.mpnId as string | undefined) ??
      (raw.partnerId as string | undefined) ??
      undefined;
    const profileType =
      (raw.profileType as string | undefined) ??
      (raw.type as string | undefined) ??
      undefined;
    return {
      outcome: "pass",
      summary: mpnId
        ? `MPN profile present (Partner ID ${mpnId})`
        : "MPN profile present",
      status: response.status,
      data: { mpnId, profileType, raw },
    };
  } catch (err) {
    return probeFromError<MpnProfileSummary>(err, "MPN profile");
  }
}

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
export async function probeLegalBusinessProfile(
  partnerCenterToken: string,
): Promise<ProbeResult<LegalBusinessProfileSummary>> {
  const url = `${PARTNER_CENTER_BASE}/v1/profiles/legalbusiness`;
  try {
    const response = await guardedFetch(
      url,
      { headers: pcHeaders(partnerCenterToken) },
      { subscriptionId: "_partner-center", family: "partner-center" },
    );
    if (!response.ok)
      throw await toError(response, "get legal-business profile");
    const raw = (await response.json()) as Record<string, unknown>;
    const companyName =
      ((raw.companyName as string | undefined) ?? "").trim() || undefined;
    return {
      outcome: "pass",
      summary: companyName
        ? `Legal business: ${companyName}`
        : "Legal business profile present",
      status: response.status,
      data: { companyName, raw },
    };
  } catch (err) {
    return probeFromError<LegalBusinessProfileSummary>(
      err,
      "Legal business profile",
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Partner Admin Link (PAL) on ARM
 * Microsoft.ManagementPartner/partners/{partnerId}
 * ───────────────────────────────────────────────────────────────────── */

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
export async function getPartnerAdminLink(
  partnerId: string,
  armToken: string,
): Promise<ProbeResult<PartnerAdminLinkSummary>> {
  const url =
    `${ARM_BASE}/providers/Microsoft.ManagementPartner/partners/` +
    `${encodeURIComponent(partnerId)}?api-version=${PAL_API_VERSION}`;
  try {
    const response = await guardedFetch(
      url,
      { headers: armHeaders(armToken) },
      { subscriptionId: "_partner-admin-link", family: "arm" },
    );
    // 404 is a legitimate "no link present" answer — surface as a
    // distinct outcome rather than throw.
    if (response.status === 404) {
      return {
        outcome: "fail",
        summary: `Partner ID ${partnerId} is not linked to this account`,
        status: 404,
        data: null,
      };
    }
    if (!response.ok) throw await toError(response, "get Partner Admin Link");
    const raw = (await response.json()) as Record<string, unknown>;
    const props = (raw.properties ?? {}) as Record<string, unknown>;
    const createdTime = (props.createdTime as string | undefined) ?? undefined;
    return {
      outcome: "pass",
      summary: `Partner ID ${partnerId} is linked`,
      status: response.status,
      data: { partnerId, createdTime, raw },
    };
  } catch (err) {
    return probeFromError<PartnerAdminLinkSummary>(err, "Partner Admin Link");
  }
}

/**
 * Link a Partner Admin Link Partner ID to the signed-in principal.
 * Idempotent — PUT against the same partner id succeeds even when the
 * link already exists.
 */
export async function linkPartnerAdmin(
  partnerId: string,
  armToken: string,
): Promise<PartnerAdminLinkSummary> {
  const url =
    `${ARM_BASE}/providers/Microsoft.ManagementPartner/partners/` +
    `${encodeURIComponent(partnerId)}?api-version=${PAL_API_VERSION}`;
  const response = await guardedFetch(
    url,
    {
      method: "PUT",
      headers: armHeaders(armToken, "application/json"),
      body: JSON.stringify({}),
    },
    { subscriptionId: "_partner-admin-link", family: "arm" },
  );
  if (!response.ok) throw await toError(response, "link Partner Admin");
  const raw = (await response.json()) as Record<string, unknown>;
  const props = (raw.properties ?? {}) as Record<string, unknown>;
  return {
    partnerId,
    createdTime: (props.createdTime as string | undefined) ?? undefined,
    raw,
  };
}

/**
 * Unlink the Partner Admin Link. Treats 404 (already unlinked) as
 * silent success — the caller's intent is satisfied either way.
 */
export async function unlinkPartnerAdmin(
  partnerId: string,
  armToken: string,
): Promise<void> {
  const url =
    `${ARM_BASE}/providers/Microsoft.ManagementPartner/partners/` +
    `${encodeURIComponent(partnerId)}?api-version=${PAL_API_VERSION}`;
  const response = await guardedFetch(
    url,
    {
      method: "DELETE",
      headers: armHeaders(armToken),
    },
    { subscriptionId: "_partner-admin-link", family: "arm" },
  );
  if (response.status === 404) return;
  if (!response.ok) throw await toError(response, "unlink Partner Admin");
}
