/**
 * Pure helpers for the Tricky Login page.
 *
 * Why a separate module: the page-component file is wide enough that the
 * read-only logic (method detection, claim labelling, mint-result shape,
 * history serialisation, scope/audience inference) deserves its own home
 * so the page itself stays focused on layout + side-effects.
 *
 * Nothing here touches MSAL, the store, or the audit log. All inputs are
 * value types; every function returns a fresh value. This keeps the
 * helpers trivially unit-testable and side-effect-free.
 *
 * The legitimate use case for this page (per the spec):
 *   Tenant admins who are already signed in with account X want to mint a
 *   token for tenant Y (where X is a guest) WITHOUT re-entering
 *   credentials, then optionally use the result as a "duplicate" account
 *   context they can switch between.
 *
 * We re-frame three red-team tricks from ROADtools / AADInternals /
 * Stormspotter as defensive admin operations:
 *
 *   1. MSAL silent multi-tenant   — `getArmTokenForAccount(home, targetTid)`
 *   2. FOCI refresh-token exchange — `exchangeRefreshTokenForClient(...)`
 *   3. Auto                        — try MSAL first, fall back to FOCI
 *
 * Each method here corresponds to one canonical `TrickyLoginMethod` value
 * that the page UI renders and the audit log records.
 */
import type { AudienceBucket } from "../../auth/imported-tokens";
import type { TenantInfo } from "../../services/types";

/** The three method strategies the page exposes. */
export type TrickyLoginMethod = "msal-silent" | "foci-exchange" | "auto";

/** Result shape stored in history and rendered in the result panel. */
export interface TrickyLoginMintResult {
  /** Whether the mint attempt succeeded. */
  status: "success" | "failure";
  /** Concrete method that actually produced (or failed to produce) the token. */
  methodUsed: TrickyLoginMethod;
  /** Source account MSAL homeAccountId (UPN / oid join). */
  sourceAccountId: string;
  /** Source account UPN/display, captured for the history table. */
  sourceAccountLabel: string;
  /** Target tenant id (lowercased GUID). */
  targetTenantId: string;
  /** Best-effort display name for the target tenant. */
  targetTenantLabel: string;
  /**
   * Audience bucket the operator chose — narrowed to the vault-friendly
   * `AudienceBucket` so existing import / vault helpers can short-circuit.
   * For audiences outside arm/graph/batch, this is `"unknown"` and the
   * richer id lives in `extendedAudience`.
   */
  audience: AudienceBucket;
  /**
   * Extended audience id for the 12-audience picker. Always present.
   * Mirrors `audience` for arm/graph/batch and carries the rich id
   * (vault/storage/intune/devops/etc.) for the rest.
   */
  extendedAudience?: TrickyAudienceId;
  /** Scope string the operator submitted (verbatim). */
  scope: string;
  /** Wall-clock ms between submit click and resolution. */
  durationMs: number;
  /** Successful mint only — the new access token. */
  accessToken?: string;
  /** Successful mint only — refresh token if AAD returned one. */
  refreshToken?: string;
  /** Successful mint only — decoded JWT claim payload (signature NOT verified). */
  claims?: Record<string, unknown>;
  /** Successful mint only — unix epoch seconds the token expires at. */
  expiresAt?: number;
  /** Failed mint only — best-effort AAD error code (e.g. "AADSTS50158"). */
  errorCode?: string;
  /** Failed mint only — the human-readable error message. */
  errorMessage?: string;
  /** ISO timestamp when the attempt resolved. */
  finishedAt: string;
}

/** Compact history row persisted to sessionStorage (subset of MintResult). */
export interface TrickyLoginHistoryRow {
  id: string;
  sourceAccountId: string;
  sourceAccountLabel: string;
  targetTenantId: string;
  targetTenantLabel: string;
  methodUsed: TrickyLoginMethod;
  audience: AudienceBucket;
  /** Extended audience id when the row is for one of the extra 9 audiences. */
  extendedAudience?: TrickyAudienceId;
  scope: string;
  status: "success" | "failure";
  durationMs: number;
  errorCode?: string;
  finishedAt: string;
}

/** Per-method discovery flag rendered in the "Tricks discovery" panel. */
export interface MethodAvailability {
  /** True when the method should succeed at submit-time. */
  available: boolean;
  /** Short one-line operator-facing reason ("✓ ..." / "✗ ..."). */
  reason: string;
}

/** Aggregated discovery state for the currently-selected (account, tenant). */
export interface MethodAvailabilityMap {
  msalSilent: MethodAvailability;
  fociExchange: MethodAvailability;
  /** Always unavailable in the browser (no PRT / device cert). Listed for completeness. */
  directTenantRt: MethodAvailability;
}

/**
 * Detect which mint methods are likely to succeed for a given source
 * account + target tenant pair WITHOUT making any network calls.
 *
 * - MSAL silent: needs the target tenant to appear in `account.tenants`
 *   (either pre-loaded via Azure Accounts or fetched lazily by the page).
 *   The presence of the tenant in that list means ARM accepted a /tenants
 *   call from this account, which is a very strong signal that
 *   acquireTokenSilent against the target tenant authority will work.
 *
 * - FOCI exchange: needs ANY imported refresh token for this account.
 *   The page also checks `detectFociEligibility` on the imported RT's
 *   originating client id, but the pre-flight here is the cheaper
 *   "do we even have an RT?" check.
 *
 * - Direct tenant RT: deliberately marked unavailable — a true
 *   "refresh-token issued by tenant Y directly" mint requires either a
 *   PRT (device-certificate-backed, OS-level only) or a stolen RT
 *   already minted against tenant Y. Both are out of scope for an
 *   admin defensive tool.
 */
export function detectMethodAvailability(args: {
  accountTenants: TenantInfo[] | undefined;
  activeTenantId: string | undefined;
  targetTenantId: string;
  hasImportedRefreshToken: boolean;
  importedRefreshTokenClientLabel?: string;
}): MethodAvailabilityMap {
  const {
    accountTenants,
    activeTenantId,
    targetTenantId,
    hasImportedRefreshToken,
    importedRefreshTokenClientLabel,
  } = args;

  // MSAL silent — discoverable means the target tenant has surfaced in
  // ARM's /tenants list for this account. If we don't have a tenant list
  // at all we surface a softer "unknown" hint instead of a hard ✗.
  const hasTenantList = Array.isArray(accountTenants) && accountTenants.length > 0;
  const tenantInList = hasTenantList
    ? accountTenants!.some(
        (t) => (t.tenantId ?? "").toLowerCase() === targetTenantId.toLowerCase(),
      )
    : false;
  const sameAsActive =
    !!activeTenantId &&
    activeTenantId.toLowerCase() === targetTenantId.toLowerCase();

  const msalSilent: MethodAvailability = sameAsActive
    ? {
        available: false,
        reason: "✗ MSAL silent: target tenant is already the account's active tenant (no-op).",
      }
    : tenantInList
      ? {
          available: true,
          reason:
            "✓ MSAL silent: account has discovered access to this tenant via /tenants.",
        }
      : hasTenantList
        ? {
            available: false,
            reason:
              "✗ MSAL silent: tenant not in the account's /tenants list — ARM will likely return interaction_required.",
          }
        : {
            // No tenant list yet — let the page nudge the operator to load it.
            available: true,
            reason:
              "? MSAL silent: tenant list not loaded — open Azure Accounts → Tenants for this account to discover.",
          };

  const fociExchange: MethodAvailability = hasImportedRefreshToken
    ? {
        available: true,
        reason: `✓ FOCI exchange: refresh token available${
          importedRefreshTokenClientLabel
            ? ` for ${importedRefreshTokenClientLabel}`
            : ""
        }.`,
      }
    : {
        available: false,
        reason:
          "✗ FOCI exchange: no imported refresh token for this account (paste one on the Import Token page).",
      };

  const directTenantRt: MethodAvailability = {
    available: false,
    reason:
      "✗ Direct refresh token for target tenant: would need a PRT / device cert (out of scope for an in-browser admin tool).",
  };

  return { msalSilent, fociExchange, directTenantRt };
}

/**
 * Extended audience id surfaced by the Tricky Login picker.
 *
 * The canonical `AudienceBucket` type in `auth/imported-tokens.ts` is
 * deliberately narrow (`arm | graph | batch | unknown`) — that's all the
 * vault / classifier / silent-acquire layer needs to know. The Tricky Login
 * page, however, supports minting tokens for a much wider set of resource
 * servers via the FOCI exchange path (POST grant_type=refresh_token against
 * `/{tid}/oauth2/v2.0/token` with any `scope=…/.default`), so we surface
 * a richer enum HERE without touching auth/.
 *
 * Any extended id outside `AudienceBucket` collapses to `"unknown"` when
 * imported into the vault — that's by design. The vault only short-
 * circuits `getArmTokenForAccount` / `getGraphTokenForAccount` /
 * `getBatchTokenForAccount`; other audiences are routed through the
 * tricky-login page (or copy-pasted into curl) on demand.
 */
export type TrickyAudienceId =
  | "arm"
  | "graph"
  | "batch"
  | "vault"
  | "storage"
  | "keyvault"
  | "intune"
  | "substrate"
  | "monitor"
  | "powerbi"
  | "yammer"
  | "devops"
  | "custom";

/** Canonical audience entries surfaced by the audience picker. */
export interface AudienceChoice {
  id: TrickyAudienceId;
  /** Short label rendered on the radio chip. */
  label: string;
  /** Default scope string when this audience is picked. */
  scope: string;
  /** Short description for tooltips. */
  description: string;
  /**
   * True when this audience is serviceable via MSAL silent (i.e. one of
   * the three audiences our `getArmTokenForAccount` / `getGraphTokenForAccount`
   * / `getBatchTokenForAccount` helpers cover). All other audiences MUST
   * use the FOCI exchange path — MSAL silent has no generic acquire for
   * arbitrary scopes (would require a service-layer edit, out of scope
   * here).
   */
  msalSilentSupported: boolean;
}

export const AUDIENCE_CHOICES: ReadonlyArray<AudienceChoice> = Object.freeze([
  {
    id: "arm",
    label: "ARM",
    scope: "https://management.azure.com/.default",
    description:
      "Azure Resource Manager — subscriptions, resource groups, deployments, RBAC.",
    msalSilentSupported: true,
  },
  {
    id: "graph",
    label: "Microsoft Graph",
    scope: "https://graph.microsoft.com/.default",
    description:
      "Microsoft Graph — directory users, groups, roles, sign-in events.",
    msalSilentSupported: true,
  },
  {
    id: "batch",
    label: "Azure Batch",
    scope: "https://batch.core.windows.net/.default",
    description:
      "Azure Batch data plane — pools, jobs, tasks inside a Batch account.",
    msalSilentSupported: true,
  },
  {
    id: "vault",
    label: "Azure Vault",
    scope: "https://vault.azure.net/.default",
    description:
      "Azure Key Vault data plane (HSM/secret get/set) — different host from the resource-id `keyvault` audience.",
    msalSilentSupported: false,
  },
  {
    id: "storage",
    label: "Azure Storage",
    scope: "https://storage.azure.com/.default",
    description:
      "Azure Storage data plane — blob/file/queue/table operations with AAD bearer.",
    msalSilentSupported: false,
  },
  {
    id: "keyvault",
    label: "Key Vault",
    scope: "https://vault.azure.net/.default",
    description:
      "Key Vault data plane — same audience as Vault, exposed separately for operator clarity.",
    msalSilentSupported: false,
  },
  {
    id: "intune",
    label: "Intune",
    scope: "https://manage.microsoft.com/.default",
    description:
      "Microsoft Endpoint Manager (Intune) — device + policy management.",
    msalSilentSupported: false,
  },
  {
    id: "substrate",
    label: "Substrate",
    scope: "https://substrate.office.com/.default",
    description:
      "Office 365 Substrate — internal M365 service mesh for mail/files/people.",
    msalSilentSupported: false,
  },
  {
    id: "monitor",
    label: "Azure Monitor",
    scope: "https://monitor.azure.com/.default",
    description:
      "Azure Monitor data plane — metrics, logs, alerts (data-plane reads).",
    msalSilentSupported: false,
  },
  {
    id: "powerbi",
    label: "Power BI",
    scope: "https://analysis.windows.net/powerbi/api/.default",
    description:
      "Power BI REST API — workspaces, datasets, reports, capacities.",
    msalSilentSupported: false,
  },
  {
    id: "yammer",
    label: "Yammer",
    scope: "https://api.yammer.com/.default",
    description: "Yammer (Viva Engage) REST API.",
    msalSilentSupported: false,
  },
  {
    id: "devops",
    label: "Azure DevOps",
    scope: "499b84ac-1321-427f-aa17-267ca6975798/.default",
    description:
      "Azure DevOps — resource id 499b84ac (well-known SPN). Issues PAT-equivalent bearer tokens for REST API + Git over HTTPS.",
    msalSilentSupported: false,
  },
  {
    id: "custom",
    label: "Custom scope",
    scope: "https://management.azure.com/.default",
    description: "Type any v2 resource scope (must end in /.default for app permissions).",
    msalSilentSupported: false,
  },
]);

/**
 * Subset of audience ids that the "Batch mint all" button iterates. Excludes
 * `custom` (no fixed scope) and dedupes `vault`/`keyvault` order so the
 * 12-row batch panel matches the spec's "Batch mint 12 audiences" label.
 */
export const BATCH_MINT_AUDIENCES: ReadonlyArray<TrickyAudienceId> =
  Object.freeze([
    "arm",
    "graph",
    "batch",
    "vault",
    "storage",
    "keyvault",
    "intune",
    "substrate",
    "monitor",
    "powerbi",
    "yammer",
    "devops",
  ]);

/** Look up an audience choice by id. */
export function getAudienceChoice(
  id: TrickyAudienceId,
): AudienceChoice {
  return AUDIENCE_CHOICES.find((c) => c.id === id) ?? AUDIENCE_CHOICES[0]!;
}

/**
 * Classify a scope string into one of the canonical buckets used by the
 * imported-token vault (`AudienceBucket`).
 *
 * NOTE: this is intentionally narrower than `extendedAudienceForScope`
 * below — the vault only short-circuits arm/graph/batch, so anything else
 * has to be re-introduced via a fresh import on every audience change.
 */
export function audienceForScope(scope: string): AudienceBucket {
  const s = (scope ?? "").toLowerCase();
  if (s.includes("management.azure.com") || s.includes("management.core.windows.net")) {
    return "arm";
  }
  if (s.includes("graph.microsoft.com")) return "graph";
  if (s.includes("batch.core.windows.net")) return "batch";
  return "unknown";
}

/**
 * Classify a scope string into the *extended* set of tricky-login audiences
 * (12 + custom). Mirrors `audienceForScope` for arm/graph/batch but also
 * recognises vault, storage, intune, substrate, monitor, powerbi, yammer,
 * devops. Returns `"custom"` when no entry matches.
 */
export function extendedAudienceForScope(scope: string): TrickyAudienceId {
  const s = (scope ?? "").toLowerCase();
  if (
    s.includes("management.azure.com") ||
    s.includes("management.core.windows.net")
  ) {
    return "arm";
  }
  if (s.includes("graph.microsoft.com")) return "graph";
  if (s.includes("batch.core.windows.net")) return "batch";
  if (s.includes("vault.azure.net")) return "vault";
  if (s.includes("storage.azure.com")) return "storage";
  if (s.includes("manage.microsoft.com")) return "intune";
  if (s.includes("substrate.office.com")) return "substrate";
  if (s.includes("monitor.azure.com")) return "monitor";
  if (s.includes("analysis.windows.net/powerbi")) return "powerbi";
  if (s.includes("api.yammer.com")) return "yammer";
  if (s.includes("499b84ac-1321-427f-aa17-267ca6975798")) return "devops";
  return "custom";
}

/**
 * Compact per-claim explainers rendered as `InfoTooltip` hovers on the
 * decoded-claims table. Same provenance as the token-importer page's
 * `CLAIM_EXPLAIN` map but kept page-local so this module doesn't depend
 * on the importer.
 */
export const CLAIM_EXPLAIN: Readonly<Record<string, string>> = Object.freeze({
  tid: "Tenant id — directory the token was minted against. For a tricky-login mint, this is the TARGET tenant.",
  oid: "AAD object id of the principal (user / SP / managed identity). Stable across all of Azure.",
  aud: "Audience — resource server the token is valid for. Drives the canonical ARM / Graph / Batch routing.",
  scp: "OAuth scope claim — space-separated delegated permissions granted to the token.",
  iss: "Issuer — STS endpoint that minted the token (https://login.microsoftonline.com/{tid}/v2.0 for v2).",
  azp: "Authorised party — client app id that requested the token (v2 tokens). For MSAL-silent flows this is the configured WebUI client.",
  appid:
    "Client app id (v1 tokens) — same role as azp. For FOCI exchanges this is the TARGET FOCI client id.",
  exp: "Expiration time (epoch seconds). Token MUST be rejected after this instant.",
  iat: "Issued-at time (epoch seconds). Useful for spotting clock-skew issues.",
  nbf: "Not-before time (epoch seconds). Usually equal to iat.",
  upn: "User Principal Name — sign-in identifier of the operator. For guest mints this stays as the operator's HOME UPN, not the target tenant.",
  preferred_username:
    "v2-token equivalent of upn — what the operator prefers to be addressed as.",
  name: "Human-readable display name of the operator.",
  ver: "Token version — 1.0 (legacy v1 endpoint) or 2.0 (v2 endpoint).",
  acct:
    "Account status in the target tenant: 0 = member, 1 = guest. Useful to confirm the tricky-login produced a guest-context token.",
  idp:
    "Identity provider — for guest tokens, the home tenant the operator authenticated against (e.g. https://sts.windows.net/{home-tid}/).",
});

/**
 * Format an epoch-seconds value as a friendly "expires in Xm Ys" string.
 * Returns "expired Xs ago" for past values, "—" for missing data.
 */
export function formatExpiresIn(epoch: number | undefined | null): string {
  if (!epoch || !Number.isFinite(epoch)) return "—";
  const now = Math.floor(Date.now() / 1000);
  const delta = epoch - now;
  if (delta <= 0) return `expired ${fmtDuration(-delta)} ago`;
  return `${fmtDuration(delta)} left`;
}

/** Compact duration formatter shared by the result + history rows. */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${Math.floor(s)}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** Mask a token for screen-share-safe display. */
export function maskToken(value: string, visible = 6): string {
  if (!value) return "";
  if (value.length <= visible * 2 + 3) return "•".repeat(value.length);
  return `${value.slice(0, visible)}${"•".repeat(8)}${value.slice(-visible)}`;
}

/**
 * Pull a stable AAD error code (AADSTSnnnnn) out of a raw error message
 * when present. Used so the history table shows a short, actionable code
 * instead of the multi-line AAD error_description.
 */
export function extractAadErrorCode(
  message: string | undefined | null,
): string | undefined {
  if (!message) return undefined;
  const m = /AADSTS(\d{4,7})/i.exec(message);
  return m ? `AADSTS${m[1]}` : undefined;
}

/**
 * Reduce a full mint result to its history-row shape. We do NOT persist
 * token material — only metadata — so the history blob is safe to land
 * in sessionStorage and to print in audit logs.
 */
export function toHistoryRow(
  result: TrickyLoginMintResult,
): TrickyLoginHistoryRow {
  return {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${result.finishedAt}-${Math.random().toString(36).slice(2, 10)}`,
    sourceAccountId: result.sourceAccountId,
    sourceAccountLabel: result.sourceAccountLabel,
    targetTenantId: result.targetTenantId,
    targetTenantLabel: result.targetTenantLabel,
    methodUsed: result.methodUsed,
    audience: result.audience,
    extendedAudience: result.extendedAudience,
    scope: result.scope,
    status: result.status,
    durationMs: result.durationMs,
    errorCode: result.errorCode,
    finishedAt: result.finishedAt,
  };
}

/** sessionStorage key for the persisted history. Versioned so we can bump. */
export const HISTORY_STORAGE_KEY = "tricky-login:history:v1";

/** Cap on history entries — same as the spec calls out. */
export const HISTORY_MAX_ENTRIES = 20;

/** sessionStorage handoff key the Token Importer page reads from. */
export const TOKEN_IMPORTER_SESSION_KEY = "token-importer:access-token";

/** Read the persisted history, tolerating quota / parse failures. */
export function loadHistory(): TrickyLoginHistoryRow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TrickyLoginHistoryRow[];
  } catch {
    return [];
  }
}

/** Persist the history, capped to HISTORY_MAX_ENTRIES (most-recent-first). */
export function saveHistory(rows: TrickyLoginHistoryRow[]): void {
  if (typeof window === "undefined") return;
  try {
    const capped = rows.slice(0, HISTORY_MAX_ENTRIES);
    window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(capped));
  } catch {
    /* sessionStorage may be full / disabled — fail soft */
  }
}

/**
 * Human label for a method — used in the result panel + history.
 */
export function methodLabel(method: TrickyLoginMethod): string {
  switch (method) {
    case "msal-silent":
      return "MSAL Silent (multi-tenant)";
    case "foci-exchange":
      return "FOCI refresh-token exchange";
    case "auto":
      return "Auto (MSAL → FOCI)";
  }
}

/** Short tag for the method badge column. */
export function methodShortLabel(method: TrickyLoginMethod): string {
  switch (method) {
    case "msal-silent":
      return "MSAL";
    case "foci-exchange":
      return "FOCI";
    case "auto":
      return "Auto";
  }
}

/**
 * Friendly tenant label resolver — matches the search order used by
 * performTenantSwitch's `findTenantLabel`. Falls back to the tenantId
 * itself when the directory list hasn't been hydrated.
 */
export function findTenantLabel(
  tenants: TenantInfo[] | undefined,
  tenantId: string | undefined,
): string {
  if (!tenantId) return "(unknown tenant)";
  const match = tenants?.find(
    (t) => (t.tenantId ?? "").toLowerCase() === tenantId.toLowerCase(),
  );
  return match?.displayName ?? match?.defaultDomain ?? tenantId;
}
