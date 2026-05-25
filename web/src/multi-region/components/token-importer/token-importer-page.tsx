/**
 * Token Importer — paste a bearer token from any Azure login (e.g.
 * portal.azure.com via DevTools) and use it as the credential for ARM
 * / Graph / Batch calls in this app, bypassing MSAL entirely.
 *
 * Workflow:
 *   1. Operator runs the snippet below in DevTools on portal.azure.com.
 *   2. Copies the JWT it logs to the console.
 *   3. Pastes into the textarea here. We decode + preview the claims.
 *   4. Click "Import" → token cached in localStorage, pseudo-account
 *      pushed into the store so other pages can see it in their pickers.
 *   5. The rest of the app uses the imported token instead of MSAL until
 *      the JWT's own `exp` claim expires.
 *
 * No silent refresh path for raw access-token imports — when an access
 * token expires the operator re-imports. Refresh-token imports DO refresh
 * silently via the auth module's `redeemRefreshToken` round-trip.
 *
 * Hardened for:
 *   - setState-after-unmount via a `mountedRef` guarding every async
 *     completion path (both the redemption flow AND clipboard reads).
 *   - Race conditions on concurrent submits via the `redeemAbortRef`
 *     abort controller plus a `submitGenerationRef` token check on
 *     completion (latest-wins).
 *   - Silent parse failures in the curl/JSON paste auto-extractor — any
 *     swallowed exception is surfaced via an `rtExtractWarning` banner so
 *     the operator knows we tried something and it didn't fit.
 */
import * as React from "react";
import {
  AlertTriangle,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Fingerprint,
  GitBranch,
  Key,
  KeyRound,
  Loader2,
  Lock,
  Network,
  Plus,
  RotateCw,
  Search,
  Server,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
  Zap,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type {
  AudienceBucket,
  ImportedAccountSummary,
  ImportedAdoPat,
  ImportedRefreshTokenEntry,
  ImportedTokenEntry,
} from "../../auth/imported-tokens";
import {
  addAdoPat,
  classifyAudience,
  clearImportedTokens,
  decodeJwtPayload,
  getAdoPatAsBasicHeader,
  importRefreshToken,
  importToken,
  isLikelyAdoPat,
  listAdoPats,
  listImportedAccounts,
  listImportedTokens,
  listRefreshTokenEntries,
  previewToken,
  redeemRefreshToken,
  removeAdoPat,
  removeImportedAccount,
  removeImportedAudience,
  removeRefreshToken,
  SCOPE_FOR_AUDIENCE,
} from "../../auth/imported-tokens";
import {
  detectFociEligibility,
  exchangeRefreshTokenForClient,
  FociExchangeError,
  FOCI_CLIENT_DEFAULT_SCOPES,
  FOCI_CLIENTS,
  type FociClient,
  type FociExchangeResult,
} from "../../auth/foci-exchange";
import { auditLog } from "../../services/audit-log";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import type { AzureLoginAccount } from "../../store/store-types";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useDashboardOutletContext } from "../page-router";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText, CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";

const PORTAL_SNIPPET = String.raw`(() => {
  // Run on portal.azure.com (DevTools → Console) to extract pasted
  // tokens from the portal's MSAL cache. Copies the result to the
  // clipboard and logs it to the console.
  const out = [];
  for (const [k, raw] of Object.entries(localStorage)) {
    if (!k.toLowerCase().includes("accesstoken")) continue;
    try {
      const v = JSON.parse(raw);
      if (v && typeof v.secret === "string" && v.secret.split(".").length === 3) {
        out.push(v.secret);
      }
    } catch {}
  }
  const dedup = [...new Set(out)];
  // SECURITY: never console.log full tokens. Only log a short preview
  // (first 16 chars) so operators can identify which token they grabbed
  // without leaking the full bearer secret into the portal DevTools log.
  console.log("Found " + dedup.length + " bearer tokens.");
  dedup.forEach((t, i) => console.log("#" + (i + 1) + " " + t.slice(0, 16) + "…"));
  // Copy ALL tokens (newline-separated) to the clipboard for the operator
  // to paste back into Batch Explorer's Token Importer page.
  if (dedup.length && navigator.clipboard) {
    navigator.clipboard.writeText(dedup.join("\n")).then(
      () => console.log("All tokens copied to clipboard. Paste into Token Importer."),
      () => console.warn("Clipboard write blocked — re-run after focusing the page."),
    );
  }
  return dedup.length;
})();`;

const AUDIENCE_LABELS: Record<AudienceBucket, string> = {
  arm: "ARM (management.azure.com)",
  graph: "Microsoft Graph",
  batch: "Azure Batch",
  devops: "Azure DevOps",
  unknown: "Unknown audience",
};

const AUDIENCE_SHORT: Record<AudienceBucket, string> = {
  arm: "ARM",
  graph: "Graph",
  batch: "Batch",
  devops: "DevOps",
  unknown: "?",
};

const AUDIENCE_HINT: Record<AudienceBucket, string> = {
  arm: "Azure Resource Manager — subscriptions, resource groups, deployments, role assignments, billing.",
  graph:
    "Microsoft Graph — users, groups, directory roles, sign-in events, M365 metadata.",
  batch:
    "Azure Batch data plane — pools, jobs, tasks, nodes inside a Batch account. Distinct from ARM's Batch resource-manager surface.",
  devops:
    "Azure DevOps Services — Repos, Pipelines, Boards, Artifacts. aud = 499b84ac-1321-427f-aa17-267ca6975798 (or *.dev.azure.com / *.visualstudio.com on legacy v1 tokens).",
  unknown:
    "The token's audience does not match any of the buckets this WebUI routes on (ARM, Graph, Batch, DevOps). It will not be picked up automatically by any page.",
};

const AUDIENCE_ORDER: AudienceBucket[] = [
  "arm",
  "graph",
  "batch",
  "devops",
  "unknown",
];

/**
 * AAD `amr` (Authentication Methods References) value → human label +
 * one-line tooltip. Surfaced as small badges on each imported token row
 * so operators can see at a glance what auth strength the token carries.
 *
 * Source: Microsoft identity-platform docs (id_token claim reference)
 * plus the NIST passwordless / Windows Hello / FIDO2 docs that describe
 * what AAD actually emits in `amr` for each platform credential.
 */
interface AmrMethodMeta {
  /** Short label shown in the badge. */
  label: string;
  /** Tooltip explaining what this auth method means. */
  tooltip: string;
  /** Lucide icon to put inside the badge. */
  Icon: typeof Fingerprint;
  /** Badge variant — drives colour. */
  variant: "default" | "secondary" | "success" | "warning" | "info";
}

const AMR_METHOD_META: Readonly<Record<string, AmrMethodMeta>> = Object.freeze({
  ngcmfa: {
    label: "Passwordless",
    tooltip:
      "amr=ngcmfa — Next Generation Credential / passwordless MFA (Windows Hello for Business or Microsoft Authenticator phone sign-in). Token carries strong-auth claims; equivalent to MFA + device-bound.",
    Icon: Fingerprint,
    variant: "success",
  },
  fido: {
    label: "Passwordless",
    tooltip:
      "amr=fido — FIDO2 / WebAuthn security key (YubiKey / platform authenticator). Strongest user-presence assertion AAD supports.",
    Icon: Fingerprint,
    variant: "success",
  },
  mfa: {
    label: "MFA",
    tooltip:
      "amr=mfa — Multi-factor authentication was completed during this sign-in. Combined with another factor (phone app, SMS, voice, OATH OTP).",
    Icon: ShieldCheck,
    variant: "info",
  },
  wia: {
    label: "Windows Hello",
    tooltip:
      "amr=wia — Windows Integrated Authentication / Windows Hello biometric or PIN unlock on a hybrid-joined / AAD-joined machine.",
    Icon: ShieldCheck,
    variant: "info",
  },
  hwk: {
    label: "Hardware key",
    tooltip:
      "amr=hwk — Hardware-bound key (TPM / Secure Enclave). Common with managed devices using a certificate or PRT-bound credential.",
    Icon: Lock,
    variant: "secondary",
  },
  pwd: {
    label: "Password",
    tooltip:
      "amr=pwd — Username + password sign-in. Weakest factor; should be combined with MFA for elevated audiences.",
    Icon: Lock,
    variant: "warning",
  },
  rsa: {
    label: "RSA",
    tooltip:
      "amr=rsa — RSA-encrypted assertion (smart card / certificate / federation).",
    Icon: Lock,
    variant: "secondary",
  },
  otp: {
    label: "OTP",
    tooltip:
      "amr=otp — One-time password (TOTP / HOTP via authenticator app or hardware token).",
    Icon: Lock,
    variant: "secondary",
  },
  sms: {
    label: "SMS",
    tooltip:
      "amr=sms — SMS one-time code. Weakest MFA factor; NIST recommends against in high-security contexts.",
    Icon: Lock,
    variant: "warning",
  },
  pop: {
    label: "Proof of Possession",
    tooltip:
      "amr=pop — Proof-of-possession token binding. Resource server cryptographically validates the caller holds the private key.",
    Icon: Lock,
    variant: "default",
  },
});

/**
 * Extract recognised auth-method markers from a JWT's `amr` claim.
 * Returns the meta records (in deduplicated insertion order) so the UI
 * can render one badge per method. Unrecognised amr values are
 * silently dropped — surfacing them as "Unknown amr value" would
 * clutter every row with vendor-specific markers AAD occasionally
 * emits.
 */
function extractAmrBadges(
  claims: Record<string, unknown> | null | undefined,
): AmrMethodMeta[] {
  if (!claims) return [];
  const raw = claims.amr;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AmrMethodMeta[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    const meta = AMR_METHOD_META[key];
    if (!meta) continue;
    seen.add(key);
    out.push(meta);
  }
  return out;
}

/** Mask a PAT for screen-share-safe display. Shows the first 2 + last 2
 *  chars of the value with `…` between, regardless of length. */
function maskAdoPat(pat: string): string {
  if (!pat) return "";
  if (pat.length <= 6) return "•".repeat(pat.length);
  return `${pat.slice(0, 2)}${"•".repeat(8)}${pat.slice(-2)}`;
}

/**
 * Human-readable explanation for each JWT claim the operator might see in
 * a decoded token. Surfaced as `InfoTooltip` content in the upgraded claim
 * grid. Sourced from RFC 7519, RFC 9068 (OAuth JWT profile), and Microsoft
 * identity-platform documentation. ROADtools surfaces the same set in its
 * `roadtx describe` output.
 */
const CLAIM_EXPLAIN: Readonly<Record<string, string>> = Object.freeze({
  oid: "AAD object id of the principal (user, SP, or managed identity). Combined with tid uniquely identifies the principal across all of Azure.",
  tid: "AAD tenant id where the principal lives. Cross-tenant calls work but the token's tenant determines which directory's RBAC applies.",
  aud: "Audience — the resource server the token is valid for. Pages route on canonical buckets (ARM / Graph / Batch) derived from this.",
  scp: "OAuth scope(s) consented to. Each space-separated value is one permission the token can exercise (delegated permissions).",
  scope:
    "Same as scp — granted scope as a single string (used on some OIDC tokens and on the v2 token endpoint response).",
  appid:
    "Client app id that requested the token (v1 token format). Must match the client_id used at any subsequent refresh-token redemption.",
  azp: "Authorised party (RFC 7519) — same role as appid but on v2 tokens. Cross-check against FOCI list to determine refresh-token family eligibility.",
  app_displayname:
    "Friendly name of the client app, as registered in AAD. Diagnostic only — display name can be changed by app owners.",
  roles:
    "Application roles assigned to the principal in the resource app's manifest. Distinct from directory roles (wids).",
  wids: "Well-known directory role ids assigned to the principal — e.g. 62e90394-69f5-4237-9190-012177145e10 is Global Administrator. Presence of any wid grants tenant-wide admin powers.",
  family_name:
    "Family name / surname from the user's AAD profile. Personally identifying — handle carefully.",
  given_name:
    "Given name / first name from the user's AAD profile. Personally identifying.",
  ipaddr:
    "Source IP address the token was issued from. Useful for tracking suspicious sessions; absent on most app-only tokens.",
  xms_cc:
    "Microsoft-internal client capability list — e.g. CP1 means the client supports CAE (Continuous Access Evaluation) and can handle 401 + token-binding challenges mid-session.",
  xms_pl:
    "Microsoft-internal preferred language hint for the principal. Used by AAD for localised error messages.",
  name: "Human-readable display name of the principal.",
  unique_name:
    "Legacy v1-token UPN-equivalent. Roughly equivalent to preferred_username on v2 tokens.",
  upn: "User Principal Name — the user's sign-in identifier (usually email-shaped). Stable across the user's lifetime.",
  preferred_username:
    "v2-token equivalent of upn — what the user prefers to be addressed as in UIs.",
  ver: "Token version — 1.0 (legacy / v1 endpoint) or 2.0 (v2 endpoint). Some claims differ between the two (e.g. appid vs azp).",
  iat: "Issued-at time (epoch seconds). When AAD minted the token.",
  nbf: "Not-before time (epoch seconds). Token MUST be rejected before this instant — usually equal to iat.",
  exp: "Expiration time (epoch seconds). Token MUST be rejected after this instant.",
  iss: "Issuer — the AAD endpoint that minted the token (e.g. https://sts.windows.net/{tid}/ for v1, https://login.microsoftonline.com/{tid}/v2.0 for v2).",
  sub: "Subject — pairwise identifier for the principal. Stable per (audience, principal) pair; do not use as a global user id (use oid instead).",
  acr: "Authentication Context Class Reference — 0 = single-factor, 1 = MFA. Useful for step-up checks.",
  amr: "Authentication Methods References — array of how the user authenticated (pwd / mfa / pop / wia / fido). Diagnostic for audit trails.",
  groups:
    "Group membership claim — array of AAD group object ids the principal belongs to. May be a hash overage if too many groups (then call /me/getMemberObjects).",
  hasgroups:
    "True when the groups claim was omitted due to overage. Call /me/getMemberObjects to enumerate.",
  idtyp:
    "Identity type — 'app' for app-only tokens (client credentials), 'user' for delegated.",
  rh: "Refresh token hash — Microsoft-internal; not useful externally.",
  uti: "Unique token identifier — Microsoft-internal correlation id for support tickets.",
  onprem_sid:
    "On-prem Active Directory SID for hybrid-joined principals (sync'd from on-prem AD).",
});

/**
 * Well-known AAD directory role ids that grant broad administrative power.
 * If `wids` contains ANY of these, the UI badges the token as elevated so
 * operators can spot impersonation risk at a glance.
 *
 * Source: docs.microsoft.com/azure/active-directory/roles/permissions-reference
 */
const ADMIN_ROLE_WIDS: ReadonlyMap<string, string> = new Map([
  ["62e90394-69f5-4237-9190-012177145e10", "Global Administrator"],
  ["e8611ab8-c189-46e8-94e1-60213ab1f814", "Privileged Role Administrator"],
  ["e3973bdf-4987-49ae-837a-ba8e231c7286", "Azure DevOps Administrator"],
  ["158c047a-c907-4556-b7ef-446551a6b5f7", "Cloud Application Administrator"],
  ["729827e3-9c14-49f7-bb1b-9608f156bbb8", "Helpdesk Administrator"],
  ["fe930be7-5e62-47db-91af-98c3a49a38b1", "User Administrator"],
  ["194ae4cb-b126-40b2-bd5b-6091b380977d", "Security Administrator"],
  ["7be44c8a-adaf-4e2a-84d6-ab2649e08a13", "Privileged Authentication Administrator"],
  ["fdd7a751-b60b-444a-984c-02652fe8fa1c", "Groups Administrator"],
  ["9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3", "Application Administrator"],
  ["c4e39bd9-1100-46d3-8c65-fb160da0071f", "Authentication Administrator"],
  ["8424c6f0-a189-499e-bbd0-26c1753c96d4", "Attribute Provisioning Administrator"],
]);

/** True when the wids array carries any admin role guid. */
function detectAdminRoles(
  claims: Record<string, unknown> | null | undefined,
): { isAdmin: boolean; roles: string[] } {
  if (!claims) return { isAdmin: false, roles: [] };
  const wids = Array.isArray(claims.wids) ? (claims.wids as unknown[]) : [];
  const matched: string[] = [];
  for (const w of wids) {
    if (typeof w !== "string") continue;
    const role = ADMIN_ROLE_WIDS.get(w.toLowerCase());
    if (role) matched.push(role);
  }
  return { isAdmin: matched.length > 0, roles: matched };
}

/**
 * Render-formatter for a claim value. Arrays / objects are JSON-stringified;
 * epoch-second numbers for known time claims become human-friendly ISO + age.
 */
function formatClaimValue(name: string, value: unknown): string {
  if (value == null) return "(null)";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (name === "iat" || name === "nbf" || name === "exp") {
      try {
        const iso = new Date(value * 1000).toISOString();
        const now = Math.floor(Date.now() / 1000);
        const delta = value - now;
        const rel =
          delta > 0
            ? `in ${fmtDuration(delta)}`
            : `${fmtDuration(-delta)} ago`;
        return `${value} (${iso} — ${rel})`;
      } catch {
        return String(value);
      }
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Pretty-print a `<seconds-until-expiry>` for the UI. */
function fmtExpiresIn(epoch: number): string {
  if (!epoch) return "unknown";
  const sec = epoch - Math.floor(Date.now() / 1000);
  if (sec < 0) return `expired ${fmtDuration(-sec)} ago`;
  if (sec < 60) return `${sec}s left`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m left`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m left`;
}

/** Pretty-print a duration in seconds — used for "expired Xm ago" too. */
function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** Visually mask a token value for screen-share-safe display. */
function maskToken(value: string, visible = 6): string {
  if (!value) return "";
  if (value.length <= visible * 2 + 3) return "•".repeat(value.length);
  return `${value.slice(0, visible)}${"•".repeat(8)}${value.slice(-visible)}`;
}

/**
 * Best-effort clipboard read — wraps both the modern async API and
 * tolerates the "not allowed" failure cleanly so the caller can fall
 * back to the manual paste textarea.
 */
async function readFromClipboard(): Promise<string | null> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
    return null;
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/* ============================================================================
 * Bulk-import types
 * ============================================================================
 * `JwtPreview` mirrors `ImportPreview` from the canonical imported-tokens
 * API but adds a stable client-side key so React lists can identify each
 * row without ever falling back to array index.
 *
 * `BulkImportRow` is a per-line entry in the bulk-paste table — each line
 * is independently validated and reported.
 *
 * SECURITY: `BulkImportRow.preview` may hold decoded JWT claims. We NEVER
 * write that into localStorage / sessionStorage / auditLog directly —
 * commit always goes through the canonical `importToken(...)` API which
 * encrypts/scopes properly, and audit log entries strip down to counts,
 * audience strings, expiry, and (on failure) sanitized error messages.
 * ============================================================================ */
interface BulkImportRow {
  /** Stable client-side key — line index + 4-char hash of the line. */
  readonly key: string;
  /** Line index inside the paste (1-based) — display only. */
  readonly lineNo: number;
  /** Mask-safe preview of the raw line (never the full token). */
  readonly maskedLine: string;
  /** Decoded preview, or null if the line did not parse as a JWT. */
  readonly preview: import("../../auth/imported-tokens").ImportPreview | null;
  /** Per-row import status. */
  status: "pending" | "imported" | "skipped" | "failed";
  /** Sanitized error/skip reason. NEVER contains token material. */
  reason?: string;
}

interface BulkImportPlan {
  /** All parseable + un-parseable rows in original order. */
  readonly rows: readonly BulkImportRow[];
  /** Count of rows that look like importable JWTs. */
  readonly importableCount: number;
  /** Count of rows that decoded but have audience === "unknown". */
  readonly unknownAudienceCount: number;
  /** Count of rows that already exist (same homeAccountId + audience). */
  readonly duplicateCount: number;
  /** Total non-empty lines parsed. */
  readonly totalLines: number;
}

/**
 * Cheap 32-bit non-cryptographic hash (Adler-style) for deriving stable
 * row keys from raw line content. We use only the first 4 hex chars in
 * the key — combined with the line number it's sufficient for React
 * list identity even when two lines happen to collide.
 *
 * SECURITY NOTE: the input string here may be a token; the OUTPUT is a
 * deterministic 8-hex digest and is safe to use as a React key. The
 * hash is NOT cryptographically secure — do not rely on it for anything
 * other than UI list identity.
 */
function hashLineForKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

/** JWT-shape screener used by bulk paste — same shape contract as the
 *  page's mandatory-rule regex. Returns true for plausible JWT shapes,
 *  used ONLY as a filter to skip blatantly-non-JWT lines early; the
 *  authoritative parse is still `previewToken(...)` from the canonical
 *  API which validates oid + tid claims. */
const JWT_SHAPE_RE =
  /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/;

/** Mask-safe display fragment of a (possibly token-shaped) line. Shows
 *  the first 12 chars + ellipsis + length. NEVER renders the full
 *  string — and the masked output is the only thing we'd ever surface
 *  to console / audit-log / DOM for non-imported lines. */
function maskLineForDisplay(line: string): string {
  const t = line.trim().replace(/^Bearer\s+/i, "");
  if (t.length <= 16) return "•".repeat(Math.min(t.length, 8));
  return `${t.slice(0, 12)}…(${t.length} chars)`;
}

export const TokenImporterPage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  // Path-based router nav, e.g. for the empty-state CTA that pivots
  // operators into audience-matrix to see what tokens unlock.
  const { navigateToPage } = useDashboardOutletContext();

  /* ---- Mount lifecycle: every async completion path checks this so
   * we never call setState on an unmounted component. */
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [input, setInput] = React.useState("");
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [accounts, setAccounts] = React.useState<ImportedAccountSummary[]>(
    () => listImportedAccounts(),
  );
  const [refreshTokens, setRefreshTokens] = React.useState<
    ImportedRefreshTokenEntry[]
  >(() => listRefreshTokenEntries());
  const [snippetCopied, setSnippetCopied] = React.useState(false);

  /* ---- Azure DevOps PAT vault state. Kept strictly separate from the
   *      Bearer-token store — PATs are Basic-auth credentials, never
   *      mixed into the access/refresh-token flow. */
  const [adoPats, setAdoPats] = React.useState<ImportedAdoPat[]>(
    () => listAdoPats(),
  );
  const [adoPatInput, setAdoPatInput] = React.useState("");
  const [adoPatOwner, setAdoPatOwner] = React.useState("");
  const [adoPatError, setAdoPatError] = React.useState<string | null>(null);

  /* ---- Reverse-lookup card ("Find FOCI clients that grant a scope")
   *      state. Pure client-side filter over FOCI_CLIENT_DEFAULT_SCOPES. */
  const [scopeQuery, setScopeQuery] = React.useState("");
  // Audit guard — we record `token_importer_scope_lookup` once per
  // distinct non-empty query, not on every keystroke (debounce 800ms).
  const lastAuditedScopeRef = React.useRef<string>("");

  /* ---- Filter / search / sort state for the imported-tokens list. */
  const [search, setSearch] = React.useState("");
  // Audience filter chips. `null` = all; otherwise only rows that have
  // at least one token in this bucket appear. Driven by the summary
  // SummaryStatItem onClicks for click-to-filter UX.
  const [audienceFilter, setAudienceFilter] =
    React.useState<AudienceBucket | "expiring" | "expired" | null>(null);

  /* ---- Privacy: master "Hide tokens" toggle + per-row reveal map. */
  const [maskTokens, setMaskTokens] = React.useState(true);
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({});
  const toggleRevealed = React.useCallback((key: string) => {
    setRevealed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  /* ---- Per-row expanded JWT-claims viewer. */
  const [expandedClaims, setExpandedClaims] = React.useState<
    Record<string, boolean>
  >({});
  const toggleClaims = React.useCallback((key: string) => {
    setExpandedClaims((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  /* ---- Pending-confirmation dialog state ---------------------- */
  // We replaced three native window.confirm() prompts with a single
  // dialog driven by this union — exactly one "kind" of pending action
  // can be open at a time, matching the original synchronous UX.
  type PendingConfirm =
    | { kind: "drop-refresh"; entry: ImportedRefreshTokenEntry }
    | { kind: "drop-account"; account: ImportedAccountSummary }
    | { kind: "drop-all" }
    | { kind: "drop-expired" }
    | null;
  const [pendingConfirm, setPendingConfirm] = React.useState<PendingConfirm>(
    null,
  );

  /* ---- AbortController for in-flight redemption -------------- */
  // We cannot pass an AbortSignal into `redeemRefreshToken` (its
  // signature is owned by the auth module and out of scope for this
  // page). We still wire one up to abort UI side-effects (state
  // updates, audit logging) when the component unmounts so we don't
  // setState-after-unmount, AND to ignore stale completion when the
  // operator submits twice rapidly.
  const redeemAbortRef = React.useRef<AbortController | null>(null);
  // A monotonically-increasing generation tag. Each submit captures
  // the current value; on completion we ignore the result if a newer
  // submit has started in the meantime. Belt-and-braces alongside the
  // abort controller.
  const submitGenerationRef = React.useRef(0);
  React.useEffect(
    () => () => {
      redeemAbortRef.current?.abort();
    },
    [],
  );

  /* ---- Bulk-paste state ---------------------------------------------
   * The bulk-paste textarea lets operators paste a newline-delimited
   * batch of JWTs harvested from one DevTools run on portal.azure.com
   * (the snippet at the top already deduplicates and joins with `\n`).
   *
   * SECURITY: tokens NEVER leak from this state into console, storage,
   * or the audit log. Commit goes through canonical `importToken(...)`.
   * Audit entries strip down to counts + audience + tenant. */
  const [bulkInput, setBulkInput] = React.useState("");
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkRows, setBulkRows] = React.useState<readonly BulkImportRow[]>([]);
  // AbortController scoped to the in-flight bulk run so the operator
  // can cancel mid-batch. Reset between batches.
  const bulkAbortRef = React.useRef<AbortController | null>(null);
  React.useEffect(
    () => () => {
      bulkAbortRef.current?.abort();
    },
    [],
  );

  /* ---- Trusted-audience allowlist (UUIDs only) ----------------------
   * Per-tenant: the operator marks a tenant id as "trusted" so future
   * bulk imports flag any JWT whose `tid` is OUTSIDE this set with a
   * warning chip. Persisted via the canonical `usePersistedState` hook
   * — NEVER any raw localStorage writes here.
   *
   * SECURITY: the only thing we persist is a list of tenant GUIDs.
   * Never tokens, never claims, never aud strings (which can contain
   * URIs that disclose internal app names). The `migrate` callback
   * filters non-GUID entries on load so a tampered store can't poison
   * the allowlist with arbitrary strings. */
  const trustedAudiencesGuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const [trustedTenants, setTrustedTenants] = usePersistedState<readonly string[]>(
    "azbm.token-importer.trusted-tenants.v1",
    [],
    {
      version: 1,
      migrate: (raw) => {
        if (!Array.isArray(raw)) return [];
        const out: string[] = [];
        for (const v of raw) {
          if (typeof v !== "string") continue;
          if (!trustedAudiencesGuidRe.test(v.trim())) continue;
          out.push(v.trim().toLowerCase());
        }
        return out;
      },
    },
  );
  const trustedTenantSet = React.useMemo(
    () => new Set(trustedTenants.map((t) => t.toLowerCase())),
    [trustedTenants],
  );

  /* ---- Refresh-token form state ------------------------------ */
  const [rtInput, setRtInput] = React.useState("");
  const [rtClientId, setRtClientId] = React.useState(
    "04b07795-8ddb-461a-bbee-02f9e1bf7b46", // Azure CLI default
  );
  // Operator-typed tenant id. We display `rtIdentity.tid || rtTenantId`
  // in the field but only write to `rtTenantId` from the input. This
  // avoids the bug where typing a tenant then pasting an id_token
  // "ghosts" the user's input behind the decoded value.
  const [rtTenantId, setRtTenantId] = React.useState("");
  const [rtIdToken, setRtIdToken] = React.useState("");
  const [rtSubmitting, setRtSubmitting] = React.useState(false);
  const [rtError, setRtError] = React.useState<string | null>(null);
  // Step-by-step status surfaced during the AAD round-trip so the
  // operator sees which endpoint we're hitting and why (helpful when
  // the network tab is full of noise).
  const [rtStatus, setRtStatus] = React.useState<string | null>(null);

  /* ---- FOCI exchange state ---------------------------------- */
  // Which imported RT row drives the exchange. Empty string = no RT
  // selected; the picker auto-selects the first eligible RT when one
  // becomes available.
  const [fociSourceAccountId, setFociSourceAccountId] = React.useState("");
  // Target FOCI client to mint AT for. Default = Azure CLI (most
  // forgiving scopes).
  const [fociTargetClientId, setFociTargetClientId] = React.useState(
    "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
  );
  // Scope to request. Default = ARM .default; operator can swap to
  // Graph / Batch via quick-fill below.
  const [fociScope, setFociScope] = React.useState<string>(
    SCOPE_FOR_AUDIENCE.arm,
  );
  // Single-exchange status / result / error surfaced inline.
  const [fociExchanging, setFociExchanging] = React.useState(false);
  const [fociResult, setFociResult] = React.useState<{
    sourceClient: string;
    targetClient: FociClient;
    scope: string;
    result: FociExchangeResult;
  } | null>(null);
  const [fociError, setFociError] = React.useState<string | null>(null);
  // Bulk-mint results: one row per FOCI client we attempted to mint for.
  type FociBulkRow = {
    target: FociClient;
    status: "pending" | "success" | "failure";
    error?: string;
    audience?: string;
    expiresIn?: number;
  };
  const [fociBulk, setFociBulk] = React.useState<FociBulkRow[] | null>(null);
  const [fociBulkRunning, setFociBulkRunning] = React.useState(false);
  // Reveal-token toggle for the single-exchange result panel.
  const [fociResultClaimsOpen, setFociResultClaimsOpen] =
    React.useState(false);

  const refreshList = React.useCallback(() => {
    if (!mountedRef.current) return;
    setAccounts(listImportedAccounts());
    setRefreshTokens(listRefreshTokenEntries());
    setAdoPats(listAdoPats());
  }, []);

  /* ---- PAT vault handlers --------------------------------------- */
  const handleAddAdoPat = React.useCallback(() => {
    setAdoPatError(null);
    const pat = adoPatInput.trim();
    const owner = adoPatOwner.trim();
    if (!pat) {
      setAdoPatError("Paste a PAT first.");
      return;
    }
    if (!owner) {
      setAdoPatError(
        "Owner label is required (free text, e.g. 'contoso-org/alice').",
      );
      return;
    }
    if (!isLikelyAdoPat(pat)) {
      setAdoPatError(
        "That doesn't look like an Azure DevOps PAT shape (expected 40-96 alphanumeric chars). Double-check you didn't paste a JWT by mistake.",
      );
      return;
    }
    try {
      const entry = addAdoPat({ pat, owner });
      auditLog.record({
        // Owner label is operator-supplied, NOT the PAT itself — safe to log.
        actor: owner,
        action: "import_ado_pat",
        target: owner,
        status: "success",
        // Deliberately do NOT include any portion of the PAT in
        // details. We only log how the operator labelled it.
        details: { id: entry.id, owner, addedAt: entry.addedAt },
      });
      store.addNotification({
        type: "success",
        message: `Imported Azure DevOps PAT for ${owner}.`,
      });
      setAdoPatInput("");
      setAdoPatOwner("");
      refreshList();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAdoPatError(msg);
      auditLog.record({
        actor: owner || "operator",
        action: "import_ado_pat",
        target: owner || "(no owner)",
        status: "failure",
        error: msg,
        details: { owner },
      });
    }
  }, [adoPatInput, adoPatOwner, refreshList, store]);

  const handleRemoveAdoPat = React.useCallback(
    (entry: ImportedAdoPat) => {
      removeAdoPat(entry.id);
      auditLog.record({
        actor: entry.owner,
        action: "delete_ado_pat",
        target: entry.owner,
        status: "success",
        details: { id: entry.id, owner: entry.owner },
      });
      store.addNotification({
        type: "info",
        message: `Removed DevOps PAT for ${entry.owner}.`,
      });
      refreshList();
    },
    [refreshList, store],
  );

  const handleCopyAdoPatBasicHeader = React.useCallback(
    async (entry: ImportedAdoPat) => {
      try {
        const header = getAdoPatAsBasicHeader(entry.id);
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          await navigator.clipboard.writeText(header);
        }
        if (!mountedRef.current) return;
        store.addNotification({
          type: "success",
          message: `Copied 'Authorization: Basic …' header for ${entry.owner}.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!mountedRef.current) return;
        store.addNotification({
          type: "error",
          message: `Could not copy header for ${entry.owner}: ${msg}`,
        });
      }
    },
    [store],
  );

  /* ---- Scope reverse-lookup ------------------------------------- */
  /**
   * Filter the FOCI catalogue down to clients that grant the queried
   * scope according to our hand-curated `FOCI_CLIENT_DEFAULT_SCOPES`
   * map. Match is case-insensitive and tolerates the full Graph URI
   * form ("https://graph.microsoft.com/User.Read" → "User.Read"). A
   * client absent from the map is rendered with a `(unknown)` marker
   * so operators can't mistake "no data" for "definitely doesn't grant
   * this".
   */
  const scopeLookupResults = React.useMemo(() => {
    const q = scopeQuery.trim();
    if (!q) return null;
    // Normalise both sides: strip Graph URI prefix, lowercase, trim.
    const normalisedQuery = q
      .replace(/^https?:\/\/[^/]+\//i, "")
      .toLowerCase();
    type ScopeResult = {
      client: FociClient;
      grants: boolean;
      knownScopes: boolean;
      matchedScope?: string;
    };
    return FOCI_CLIENTS.map((c): ScopeResult => {
      const scopes = FOCI_CLIENT_DEFAULT_SCOPES[c.clientId];
      if (!scopes) {
        return { client: c, grants: false, knownScopes: false };
      }
      const matched = scopes.find(
        (s) => s.toLowerCase() === normalisedQuery,
      );
      return {
        client: c,
        grants: !!matched,
        knownScopes: true,
        matchedScope: matched,
      };
    }).filter((r) => r.grants || !r.knownScopes);
  }, [scopeQuery]);

  /** Audit the lookup once per distinct query (debounced 800ms). */
  React.useEffect(() => {
    const q = scopeQuery.trim();
    if (!q || q === lastAuditedScopeRef.current) return;
    const t = window.setTimeout(() => {
      if (!mountedRef.current) return;
      if (q !== scopeQuery.trim()) return; // user kept typing
      lastAuditedScopeRef.current = q;
      const matchCount =
        scopeLookupResults?.filter((r) => r.grants).length ?? 0;
      const unknownCount =
        scopeLookupResults?.filter((r) => !r.knownScopes).length ?? 0;
      auditLog.record({
        actor: "operator",
        action: "token_importer_scope_lookup",
        target: q,
        status: "success",
        details: {
          query: q,
          matchedClients: matchCount,
          unknownClients: unknownCount,
          totalClientsConsidered: FOCI_CLIENTS.length,
        },
      });
    }, 800);
    return () => window.clearTimeout(t);
  }, [scopeQuery, scopeLookupResults]);

  /**
   * Identity for the refresh-token row. We try to read it from an
   * accompanying id_token (preferred — has name/upn) and fall back to
   * the operator-typed tenant + a synthetic oid derived from the RT
   * itself. Without a tenant id we can't redeem at all.
   */
  const rtIdentity = React.useMemo(() => {
    const claims = rtIdToken.trim()
      ? decodeJwtPayload(rtIdToken.trim())
      : null;
    const oid = String(claims?.oid ?? claims?.sub ?? "");
    const tid = String(claims?.tid ?? rtTenantId ?? "");
    const upn =
      (claims?.preferred_username as string | undefined) ??
      (claims?.upn as string | undefined) ??
      (claims?.unique_name as string | undefined);
    const name = claims?.name as string | undefined;
    return { oid, tid, upn, name, hasIdToken: !!claims };
  }, [rtIdToken, rtTenantId]);

  /** GUID regex used for client_id + tenant_id validation. */
  const guidRe = React.useMemo(
    () =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    [],
  );

  const rtPlanValid =
    rtInput.trim().length > 20 &&
    guidRe.test(rtClientId.trim()) &&
    guidRe.test(rtIdentity.tid);

  // Conditional Access-specific error captured so the UI can show a
  // tailored remediation card pointing at the access-token paste form.
  const [rtCaBlocked, setRtCaBlocked] = React.useState(false);
  /**
   * AADSTS70000 happens when the refresh token itself is unusable —
   * usually consumed-and-rotated. We surface a tailored hint instead
   * of the raw blob.
   */
  const [rtInvalidGrant, setRtInvalidGrant] = React.useState(false);
  // Surfaced when the operator pasted a whole HTTP request body / curl
  // template instead of a bare RT. We auto-extract on submit; this
  // structure tells the UI what we did so the operator isn't surprised.
  const [rtExtracted, setRtExtracted] = React.useState<{
    source: "json" | "form" | "curl" | "powershell" | null;
    fields: string[];
  }>({ source: null, fields: [] });
  // Soft warning when the parse attempt looked like a structured paste
  // but didn't yield a usable refresh_token — we don't fail outright
  // (the bare-trim fallback may still work) but we tell the operator
  // we tried.
  const [rtExtractWarning, setRtExtractWarning] = React.useState<
    string | null
  >(null);

  /**
   * Try to parse the operator's RT-textarea input as something more
   * structured than a bare token:
   *   - Form-encoded body  (`refresh_token=…&client_id=…&…`).
   *   - JSON token response (`{"refresh_token":"…","client_id":"…"}`).
   *   - Curl command       (`curl -d 'refresh_token=…' …`).
   *   - PowerShell command (`Invoke-RestMethod -Body @{ refresh_token = '…' }`).
   * Returns the extracted refresh token + any companion fields we
   * recognised. If the input doesn't look structured, returns the
   * trimmed input as the refresh token with no extras.
   *
   * `onWarn` is called with a human-readable string when we *attempted*
   * a structured parse and it threw — we still return the trimmed raw
   * value as a best-effort fallback, but the UI can surface the warning
   * so the operator isn't confused why their JSON didn't auto-fill.
   */
  function parseRtPaste(
    raw: string,
    onWarn: (msg: string) => void,
  ): {
    refreshToken: string;
    clientId?: string;
    tenantId?: string;
    scope?: string;
    resource?: string;
    looksLikeTemplate: boolean;
    source: "json" | "form" | "curl" | "powershell" | null;
    fields: string[];
  } {
    const trimmed = raw.trim();
    // Detect the "<refresh_token>" placeholder so we can refuse early.
    const looksLikeTemplate =
      /<\s*refresh[_-]?token\s*>/i.test(trimmed) ||
      /\{\s*your[_-]?refresh[_-]?token\s*\}/i.test(trimmed);

    // JSON token-endpoint response.
    if (trimmed.startsWith("{") && trimmed.includes("refresh_token")) {
      try {
        const j = JSON.parse(trimmed);
        if (typeof j.refresh_token === "string") {
          const fields: string[] = ["refresh_token"];
          if (typeof j.client_id === "string") fields.push("client_id");
          if (typeof j.scope === "string") fields.push("scope");
          if (typeof j.resource === "string") fields.push("resource");
          return {
            refreshToken: j.refresh_token,
            clientId:
              typeof j.client_id === "string" ? j.client_id : undefined,
            scope: typeof j.scope === "string" ? j.scope : undefined,
            resource:
              typeof j.resource === "string" ? j.resource : undefined,
            looksLikeTemplate,
            source: "json",
            fields,
          };
        }
        onWarn(
          "Pasted JSON has no `refresh_token` field — falling back to treating the whole paste as a token.",
        );
      } catch (err) {
        onWarn(
          `Pasted text starts with '{' but is not valid JSON (${
            err instanceof Error ? err.message : String(err)
          }) — falling back to treating the whole paste as a token.`,
        );
      }
    }

    // PowerShell Invoke-RestMethod / Invoke-WebRequest with a hashtable
    // body: `-Body @{ refresh_token = 'XXX'; client_id = 'YYY' }`.
    const psHash =
      /Invoke-(?:RestMethod|WebRequest)/i.test(trimmed) &&
      /refresh_token\s*=/i.test(trimmed);
    if (psHash) {
      try {
        const rtMatch = /refresh_token\s*=\s*['"]([^'"]+)['"]/i.exec(trimmed);
        const cidMatch = /client_id\s*=\s*['"]([^'"]+)['"]/i.exec(trimmed);
        const scopeMatch = /scope\s*=\s*['"]([^'"]+)['"]/i.exec(trimmed);
        const resourceMatch =
          /resource\s*=\s*['"]([^'"]+)['"]/i.exec(trimmed);
        const tenantMatch =
          /login\.microsoftonline\.com\/([0-9a-f-]{36})/i.exec(trimmed);
        if (rtMatch?.[1]) {
          const fields = ["refresh_token"];
          if (cidMatch?.[1]) fields.push("client_id");
          if (tenantMatch?.[1]) fields.push("tenant");
          if (scopeMatch?.[1]) fields.push("scope");
          if (resourceMatch?.[1]) fields.push("resource");
          return {
            refreshToken: rtMatch[1],
            clientId: cidMatch?.[1],
            tenantId: tenantMatch?.[1],
            scope: scopeMatch?.[1],
            resource: resourceMatch?.[1],
            looksLikeTemplate,
            source: "powershell",
            fields,
          };
        }
        onWarn(
          "Paste looks like a PowerShell Invoke-RestMethod command but no `refresh_token = '...'` pair was found — falling back to the bare value.",
        );
      } catch (err) {
        onWarn(
          `PowerShell parse failed: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
    }

    // Form-encoded body OR curl-style body inside quotes.
    const formish =
      trimmed.includes("refresh_token=") &&
      (trimmed.includes("&") || trimmed.includes("="));
    if (formish) {
      // Strip a leading "curl …" and quote pairs so URLSearchParams sees
      // a clean query string. We run the trailing-quote strip ONCE — the
      // duplicate was a copy/paste typo in the original.
      const isCurl = /^\s*curl\b/i.test(trimmed);
      const cleanForm = trimmed
        .replace(/^curl\s+/i, "")
        .replace(/--data(-raw|-urlencode|-binary)?\s+/gi, "")
        .replace(/-d\s+/g, "")
        .replace(/\\\n/g, " ") // strip line continuations
        .replace(/^['"]|['"]$/g, "");
      try {
        const params = new URLSearchParams(cleanForm);
        const rt = params.get("refresh_token");
        if (rt) {
          // The tenant might be embedded in a URL in the same paste.
          const tenantMatch =
            /login\.microsoftonline\.com\/([0-9a-f-]{36})/i.exec(trimmed);
          const fields = ["refresh_token"];
          if (params.get("client_id")) fields.push("client_id");
          if (tenantMatch?.[1]) fields.push("tenant");
          if (params.get("scope")) fields.push("scope");
          if (params.get("resource")) fields.push("resource");
          return {
            refreshToken: rt,
            clientId: params.get("client_id") ?? undefined,
            tenantId: tenantMatch?.[1],
            scope: params.get("scope") ?? undefined,
            resource: params.get("resource") ?? undefined,
            looksLikeTemplate,
            source: isCurl ? "curl" : "form",
            fields,
          };
        }
        onWarn(
          "Paste looks like a form-encoded body but `refresh_token=` was empty — falling back to the bare value.",
        );
      } catch (err) {
        onWarn(
          `Form-decode failed: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
    }

    return {
      refreshToken: trimmed,
      looksLikeTemplate,
      source: null,
      fields: [],
    };
  }

  const submitRefreshToken = React.useCallback(async () => {
    if (!rtPlanValid) return;
    // Re-arm the abort controller for this attempt — guards against
    // setState-after-unmount when redemption is in flight while the
    // user navigates away. Also bump the generation so any in-flight
    // older submit's completion is ignored if both happen to resolve.
    redeemAbortRef.current?.abort();
    const abortController = new AbortController();
    redeemAbortRef.current = abortController;
    const generation = ++submitGenerationRef.current;
    const isStale = () =>
      abortController.signal.aborted ||
      generation !== submitGenerationRef.current ||
      !mountedRef.current;

    setRtSubmitting(true);
    setRtError(null);
    setRtCaBlocked(false);
    setRtInvalidGrant(false);
    setRtExtracted({ source: null, fields: [] });
    setRtExtractWarning(null);
    setRtStatus("Parsing pasted input…");
    try {
      // Normalise the operator's paste: handle form-encoded body, JSON
      // token-endpoint response, curl command, PowerShell snippet, or
      // plain RT.
      const warns: string[] = [];
      const parsed = parseRtPaste(rtInput, (w) => warns.push(w));
      if (warns.length > 0) setRtExtractWarning(warns.join(" "));
      if (parsed.looksLikeTemplate) {
        throw new Error(
          "Your paste still contains the literal `<refresh_token>` placeholder. Replace it with the actual token value (a long opaque string starting with `0.` or `1.`) before submitting.",
        );
      }
      const refreshToken = parsed.refreshToken;
      const tenantId = (parsed.tenantId ?? rtIdentity.tid ?? "").trim();
      const clientId = (parsed.clientId ?? rtClientId).trim();
      // If we extracted companion fields, surface that to the operator
      // so they understand why the form-fields look different from
      // what they typed.
      if (parsed.source && parsed.fields.length > 0) {
        setRtExtracted({ source: parsed.source, fields: parsed.fields });
        if (parsed.clientId) setRtClientId(parsed.clientId);
        if (parsed.tenantId) setRtTenantId(parsed.tenantId);
      }
      setRtStatus(
        `Contacting AAD /oauth2/v2.0/token for tenant ${tenantId.slice(0, 8)}…`,
      );
      // Validate by minting an ARM token immediately. This proves the
      // RT + client_id + tenant combo works AND seeds the access-token
      // cache so the user can start using the WebUI without another
      // round-trip.
      const data = await redeemRefreshToken(
        refreshToken,
        clientId,
        tenantId,
        SCOPE_FOR_AUDIENCE.arm,
      );
      if (isStale()) return; // unmounted / superseded — drop the result.
      if (!data.access_token) {
        throw new Error(
          data.error_description ??
            data.error ??
            "AAD returned no access token. Wrong client id or expired refresh token.",
        );
      }
      // Record the successful redemption separately from the import
      // event — operators want a per-redemption audit trail for the
      // tenant + clientId + scope combo, and successful redemptions
      // happen lazily on later runs without `import_refresh_token`.
      auditLog.record({
        actor: rtIdentity.upn ?? rtIdentity.oid ?? "operator",
        action: "redeem_refresh_token",
        target: `${tenantId}|${clientId}|${SCOPE_FOR_AUDIENCE.arm}`,
        status: "success",
        details: {
          tenantId,
          clientId,
          scope: SCOPE_FOR_AUDIENCE.arm,
          rotatedRefreshToken: !!data.refresh_token,
          source: "token-importer-page",
        },
      });
      // Decode the minted access token to pull oid / upn / name (more
      // reliable than the optional id_token field).
      const acClaims = decodeJwtPayload(data.access_token) ?? {};
      const oid = String(acClaims.oid ?? rtIdentity.oid ?? "");
      const upn =
        (acClaims.preferred_username as string | undefined) ??
        (acClaims.upn as string | undefined) ??
        rtIdentity.upn;
      const name = (acClaims.name as string | undefined) ?? rtIdentity.name;
      const homeAccountId = `${oid}.${tenantId}`;
      // Persist the refresh token (rotated if AAD sent a new one).
      importRefreshToken({
        homeAccountId,
        tenantId,
        oid,
        upn,
        name,
        clientId,
        refreshToken: data.refresh_token ?? refreshToken,
      });
      // Cache the ARM access token we just minted.
      importToken({
        jwt: data.access_token,
        homeAccountId,
        tenantId,
        oid,
        upn,
        name,
        audience: "arm",
        rawAudience: String(acClaims.aud ?? "https://management.azure.com"),
        expiresAt:
          Number(acClaims.exp ?? 0) ||
          (data.expires_in
            ? Math.floor(Date.now() / 1000) + data.expires_in
            : 0),
        claims: acClaims,
      });
      auditLog.record({
        actor: upn ?? oid,
        action: "import_refresh_token",
        target: homeAccountId,
        status: "success",
        details: {
          tenantId,
          clientId,
          rotatedRefreshToken: !!data.refresh_token,
        },
      });
      store.addNotification({
        type: "success",
        message: `Imported refresh token for ${upn ?? oid}. ARM token cached; Graph & Batch will be minted on demand.`,
      });
      setRtInput("");
      setRtIdToken("");
      setRtStatus(null);
      refreshList();
    } catch (err) {
      if (isStale()) return; // unmounted / superseded.
      const msg = err instanceof Error ? err.message : String(err);
      // AADSTS53003 == Conditional Access blocked token issuance. The
      // refresh-token grant cannot satisfy CA from this origin — the
      // operator's only recourse is to paste the access_token that was
      // returned alongside the refresh_token (it already satisfied CA
      // at issuance time).
      if (
        msg.includes("AADSTS53003") ||
        msg.toLowerCase().includes("conditional access")
      ) {
        setRtCaBlocked(true);
      } else if (
        msg.includes("AADSTS70000") ||
        msg.toLowerCase().includes("provided grant is invalid")
      ) {
        setRtInvalidGrant(true);
      }
      setRtError(msg);
      setRtStatus(null);
      auditLog.record({
        actor: rtIdentity.upn ?? rtIdentity.oid ?? "operator",
        action: "import_refresh_token",
        target: rtIdentity.tid || "(unknown tenant)",
        status: "failure",
        error: msg,
        details: { tenantId: rtIdentity.tid, clientId: rtClientId },
      });
      // Mirror the failure on the redeem_refresh_token action so the
      // audit log shows the exact AAD error that blocked redemption
      // even when import_refresh_token would have hidden it behind a
      // generic message.
      auditLog.record({
        actor: rtIdentity.upn ?? rtIdentity.oid ?? "operator",
        action: "redeem_refresh_token",
        target: `${rtIdentity.tid || "(unknown tenant)"}|${rtClientId}|${SCOPE_FOR_AUDIENCE.arm}`,
        status: "failure",
        error: msg,
        details: {
          tenantId: rtIdentity.tid,
          clientId: rtClientId,
          scope: SCOPE_FOR_AUDIENCE.arm,
        },
      });
    } finally {
      // Only flip the spinner off if we're the latest submit and still
      // mounted — otherwise a superseded older submit could clobber the
      // newer one's spinner state.
      if (
        mountedRef.current &&
        generation === submitGenerationRef.current
      ) {
        setRtSubmitting(false);
      }
    }
  }, [
    rtPlanValid,
    rtIdentity,
    rtClientId,
    rtInput,
    refreshList,
    store,
  ]);

  /** Re-mint the ARM token for an existing refresh-token row. */
  const reMintFromRt = React.useCallback(
    async (entry: ImportedRefreshTokenEntry) => {
      const generation = ++submitGenerationRef.current;
      try {
        const data = await redeemRefreshToken(
          entry.refreshToken,
          entry.clientId,
          entry.tenantId,
          SCOPE_FOR_AUDIENCE.arm,
        );
        if (!mountedRef.current || generation !== submitGenerationRef.current) {
          return;
        }
        if (!data.access_token) {
          throw new Error(
            data.error_description ?? data.error ?? "No access_token returned.",
          );
        }
        const claims = decodeJwtPayload(data.access_token) ?? {};
        importToken({
          jwt: data.access_token,
          homeAccountId: entry.homeAccountId,
          tenantId: entry.tenantId,
          oid: entry.oid,
          upn: entry.upn,
          name: entry.name,
          audience: "arm",
          rawAudience: String(
            claims.aud ?? "https://management.azure.com",
          ),
          expiresAt:
            Number(claims.exp ?? 0) ||
            (data.expires_in
              ? Math.floor(Date.now() / 1000) + data.expires_in
              : 0),
          claims,
        });
        if (data.refresh_token && data.refresh_token !== entry.refreshToken) {
          importRefreshToken({
            ...entry,
            refreshToken: data.refresh_token,
          });
        }
        auditLog.record({
          actor: entry.upn ?? entry.oid,
          action: "redeem_refresh_token",
          target: `${entry.tenantId}|${entry.clientId}|${SCOPE_FOR_AUDIENCE.arm}`,
          status: "success",
          details: {
            tenantId: entry.tenantId,
            clientId: entry.clientId,
            scope: SCOPE_FOR_AUDIENCE.arm,
            rotatedRefreshToken: !!data.refresh_token,
            source: "remint-from-list",
          },
        });
        store.addNotification({
          type: "success",
          message: `Re-minted ARM token for ${entry.upn ?? entry.oid}.`,
        });
        refreshList();
      } catch (err) {
        if (!mountedRef.current || generation !== submitGenerationRef.current) {
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        auditLog.record({
          actor: entry.upn ?? entry.oid,
          action: "redeem_refresh_token",
          target: `${entry.tenantId}|${entry.clientId}|${SCOPE_FOR_AUDIENCE.arm}`,
          status: "failure",
          error: msg,
          details: { source: "remint-from-list" },
        });
        store.addNotification({
          type: "error",
          message: `Re-mint failed for ${entry.upn ?? entry.oid}: ${msg}`,
        });
      }
    },
    [refreshList, store],
  );

  /* ------------------------------------------------------------------
   * FOCI exchange handlers
   * ------------------------------------------------------------------
   * `runFociExchange` does a single source→target exchange and updates
   * the inline result panel. `runFociBulkMint` runs every FOCI target
   * in parallel and collects per-target results into a table.
   */
  const runFociExchange = React.useCallback(
    async (overrideTarget?: FociClient) => {
      const source = refreshTokens.find(
        (r) => r.homeAccountId === fociSourceAccountId,
      );
      if (!source) {
        setFociError(
          "Pick a source refresh token first (the dropdown above). Import an RT via the green card if you don't have one yet.",
        );
        return;
      }
      const target =
        overrideTarget ??
        FOCI_CLIENTS.find((c) => c.clientId === fociTargetClientId);
      if (!target) {
        setFociError(
          "Pick a target FOCI client from the list below the dropdown.",
        );
        return;
      }
      // Gate on isFoci client-side: refuse to spend an RT on a target
      // we already know is non-FOCI (AAD would return AADSTS54005 and
      // consume the RT in the process). The button is already disabled
      // for non-FOCI rows; this is the belt-and-braces server-side
      // analogue.
      if (!target.isFoci) {
        setFociError(
          `${target.name} is not in the FOCI family — AAD would reject this exchange with AADSTS54005. Use the device-code flow against this client instead.`,
        );
        return;
      }
      if (!fociScope.trim()) {
        setFociError("Scope is required (e.g. https://management.azure.com/.default).");
        return;
      }
      setFociExchanging(true);
      setFociError(null);
      setFociResult(null);
      setFociResultClaimsOpen(false);
      try {
        const result = await exchangeRefreshTokenForClient({
          refreshToken: source.refreshToken,
          targetClientId: target.clientId,
          tenantId: source.tenantId,
          scope: fociScope.trim(),
        });
        if (!mountedRef.current) return;
        setFociResult({
          sourceClient: source.clientId,
          targetClient: target,
          scope: fociScope.trim(),
          result,
        });
        auditLog.record({
          actor: source.upn ?? source.oid,
          action: "foci_exchange",
          target: `${source.clientId}->${target.clientId}`,
          status: "success",
          details: {
            sourceClient: source.clientId,
            targetClient: target.clientId,
            targetName: target.name,
            audience: result.audience,
            scope: fociScope.trim(),
            tenantId: source.tenantId,
            rotatedRefreshToken: !!result.refresh_token,
          },
        });
      } catch (err) {
        if (!mountedRef.current) return;
        const isFociErr = err instanceof FociExchangeError;
        const msg = err instanceof Error ? err.message : String(err);
        setFociError(msg);
        auditLog.record({
          actor: source.upn ?? source.oid,
          action: "foci_exchange",
          target: `${source.clientId}->${target.clientId}`,
          status: "failure",
          error: msg,
          details: {
            sourceClient: source.clientId,
            targetClient: target.clientId,
            targetName: target.name,
            scope: fociScope.trim(),
            tenantId: source.tenantId,
            aadError: isFociErr ? err.body.error : undefined,
            aadErrorCodes: isFociErr ? err.body.error_codes : undefined,
          },
        });
      } finally {
        if (mountedRef.current) setFociExchanging(false);
      }
    },
    [
      refreshTokens,
      fociSourceAccountId,
      fociTargetClientId,
      fociScope,
    ],
  );

  /**
   * Import the most-recent FOCI exchange result into the access-token
   * vault so the rest of the WebUI can use it.
   */
  const importFociResultToVault = React.useCallback(() => {
    if (!fociResult) return;
    const source = refreshTokens.find(
      (r) => r.homeAccountId === fociSourceAccountId,
    );
    if (!source) return;
    const { result } = fociResult;
    const claims = result.claims;
    const audience = classifyAudience(result.audience);
    const oid = String(claims.oid ?? source.oid);
    const tenantId = String(claims.tid ?? source.tenantId);
    const homeAccountId = `${oid}.${tenantId}`;
    const upn =
      (claims.preferred_username as string | undefined) ??
      (claims.upn as string | undefined) ??
      source.upn;
    const name = (claims.name as string | undefined) ?? source.name;
    importToken({
      jwt: result.access_token,
      homeAccountId,
      tenantId,
      oid,
      upn,
      name,
      audience,
      rawAudience: result.audience,
      expiresAt:
        Number(claims.exp ?? 0) ||
        (result.expires_in
          ? Math.floor(Date.now() / 1000) + result.expires_in
          : 0),
      claims,
    });
    // If AAD rotated the RT for the TARGET client, persist it too. The
    // rotated RT inherits FOCI eligibility — same family, different
    // app id.
    if (result.refresh_token) {
      importRefreshToken({
        homeAccountId,
        tenantId,
        oid,
        upn,
        name,
        clientId: fociResult.targetClient.clientId,
        refreshToken: result.refresh_token,
      });
    }
    auditLog.record({
      actor: upn ?? oid,
      action: "import_token",
      target: `${audience} @ ${tenantId}`,
      status: "success",
      details: {
        oid,
        tenantId,
        audience,
        rawAudience: result.audience,
        source: "foci-exchange-import",
        sourceClient: source.clientId,
        targetClient: fociResult.targetClient.clientId,
      },
    });
    store.addNotification({
      type: "success",
      message: `Imported FOCI-minted ${audience.toUpperCase()} token (${fociResult.targetClient.name}).`,
    });
    refreshList();
  }, [fociResult, fociSourceAccountId, refreshTokens, store, refreshList]);

  /**
   * Mint an access token for every FOCI client in parallel. Useful when
   * an operator wants a snapshot of which clients their RT is actually
   * accepted by — AAD's FOCI list is documented but enforcement is
   * server-side and can change without notice.
   */
  const runFociBulkMint = React.useCallback(async () => {
    const source = refreshTokens.find(
      (r) => r.homeAccountId === fociSourceAccountId,
    );
    if (!source) {
      setFociError(
        "Pick a source refresh token first to bulk-mint targets.",
      );
      return;
    }
    if (!fociScope.trim()) {
      setFociError("Scope is required for bulk-mint.");
      return;
    }
    setFociBulkRunning(true);
    setFociError(null);
    // Bulk-mint skips non-FOCI clients entirely — they're guaranteed
    // to return AADSTS54005 and we don't want to burn the operator's
    // RT (or pollute the audit log) on known-failures.
    const eligibleTargets = FOCI_CLIENTS.filter((c) => c.isFoci);
    const initial: FociBulkRow[] = eligibleTargets.map((c) => ({
      target: c,
      status: "pending",
    }));
    setFociBulk(initial);
    const results = await Promise.all(
      eligibleTargets.map(async (target): Promise<FociBulkRow> => {
        try {
          const r = await exchangeRefreshTokenForClient({
            refreshToken: source.refreshToken,
            targetClientId: target.clientId,
            tenantId: source.tenantId,
            scope: fociScope.trim(),
          });
          auditLog.record({
            actor: source.upn ?? source.oid,
            action: "foci_exchange",
            target: `${source.clientId}->${target.clientId}`,
            status: "success",
            details: {
              sourceClient: source.clientId,
              targetClient: target.clientId,
              targetName: target.name,
              audience: r.audience,
              scope: fociScope.trim(),
              tenantId: source.tenantId,
              source: "foci-bulk-mint",
            },
          });
          return {
            target,
            status: "success",
            audience: r.audience,
            expiresIn: r.expires_in,
          };
        } catch (err) {
          const isFociErr = err instanceof FociExchangeError;
          const msg = err instanceof Error ? err.message : String(err);
          auditLog.record({
            actor: source.upn ?? source.oid,
            action: "foci_exchange",
            target: `${source.clientId}->${target.clientId}`,
            status: "failure",
            error: msg,
            details: {
              sourceClient: source.clientId,
              targetClient: target.clientId,
              targetName: target.name,
              scope: fociScope.trim(),
              tenantId: source.tenantId,
              source: "foci-bulk-mint",
              aadError: isFociErr ? err.body.error : undefined,
            },
          });
          return { target, status: "failure", error: msg };
        }
      }),
    );
    if (mountedRef.current) {
      setFociBulk(results);
      setFociBulkRunning(false);
      const ok = results.filter((r) => r.status === "success").length;
      store.addNotification({
        type: ok > 0 ? "success" : "warning",
        message: `FOCI bulk-mint: ${ok} / ${results.length} clients accepted the RT.`,
      });
    }
  }, [refreshTokens, fociSourceAccountId, fociScope, store]);

  /**
   * Auto-pick a source RT when one becomes available and none is
   * currently selected. Operator can still manually override.
   */
  React.useEffect(() => {
    if (!fociSourceAccountId && refreshTokens.length > 0) {
      setFociSourceAccountId(refreshTokens[0]!.homeAccountId);
    } else if (
      fociSourceAccountId &&
      !refreshTokens.some((r) => r.homeAccountId === fociSourceAccountId)
    ) {
      // The selected RT was dropped — fall back to the first available
      // RT (or empty when there are none).
      setFociSourceAccountId(refreshTokens[0]?.homeAccountId ?? "");
    }
  }, [refreshTokens, fociSourceAccountId]);

  const handleRemoveRefresh = React.useCallback(
    (entry: ImportedRefreshTokenEntry) => {
      // Defer the destructive action behind the shared
      // ConfirmationDialog — operators can review the consequences and
      // hit Escape / click outside instead of being trapped by a native
      // window.confirm() box.
      setPendingConfirm({ kind: "drop-refresh", entry });
    },
    [],
  );

  const confirmRemoveRefresh = React.useCallback(
    (entry: ImportedRefreshTokenEntry) => {
      removeRefreshToken(entry.homeAccountId);
      auditLog.record({
        actor: entry.upn ?? entry.oid,
        action: "drop_refresh_token",
        target: entry.homeAccountId,
        status: "success",
        details: {
          tenantId: entry.tenantId,
          clientId: entry.clientId,
        },
      });
      refreshList();
    },
    [refreshList],
  );

  const preview = React.useMemo(() => previewToken(input), [input]);

  const handleImport = React.useCallback(() => {
    if (!preview) return;
    try {
      const entry = importToken(preview);
      // Push (or refresh) a pseudo-account into the global store so the
      // rest of the app's account-driven pickers see this principal.
      const tokens = listImportedTokens().filter(
        (t) => t.homeAccountId === entry.homeAccountId,
      );
      // Read accounts from the live state once — avoids the stale-closure
      // bug where `azureAccounts` and `state.azureAccounts` could
      // diverge if the store updated between renders.
      const all = state.azureAccounts ?? [];
      const existing = all.find(
        (a) => a.homeAccountId === entry.homeAccountId,
      );
      const pseudoAccount: AzureLoginAccount = {
        homeAccountId: entry.homeAccountId,
        localAccountId: entry.oid,
        username: entry.upn ?? entry.oid,
        name: entry.name ?? entry.upn ?? entry.oid,
        tenantId: entry.tenantId,
        environment: "imported",
        subscriptions: existing?.subscriptions ?? [],
        subscriptionCount: existing?.subscriptionCount ?? 0,
        status: "active",
        error: null,
        signedOut: false,
        addedAt: existing?.addedAt ?? new Date().toISOString(),
      };
      const idx = all.findIndex(
        (a) => a.homeAccountId === entry.homeAccountId,
      );
      const next =
        idx >= 0
          ? all.map((a, i) => (i === idx ? pseudoAccount : a))
          : [...all, pseudoAccount];
      store.setAzureAccounts(next);

      auditLog.record({
        actor: entry.upn ?? entry.oid,
        action: "import_token",
        target: `${entry.audience} @ ${entry.tenantId}`,
        status: "success",
        details: {
          oid: entry.oid,
          tenantId: entry.tenantId,
          audience: entry.audience,
          rawAudience: entry.rawAudience,
          expiresAt: entry.expiresAt,
          tokensForAccount: tokens.length,
        },
      });
      store.addNotification({
        type: "success",
        message: `Imported ${entry.audience.toUpperCase()} token for ${
          entry.upn ?? entry.oid
        } (${fmtExpiresIn(entry.expiresAt)}).`,
      });
      setInput("");
      setSubmitError(null);
      refreshList();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(msg);
      auditLog.record({
        actor: preview?.upn ?? preview?.oid ?? "operator",
        action: "import_token",
        target: preview
          ? `${preview.audience} @ ${preview.tenantId}`
          : "(unknown)",
        status: "failure",
        error: msg,
        details: preview
          ? {
              oid: preview.oid,
              tenantId: preview.tenantId,
              audience: preview.audience,
            }
          : undefined,
      });
    }
  }, [preview, state.azureAccounts, store, refreshList]);

  /* ---- Bulk-import: derive the plan from the textarea ---------------
   * Debounced 300ms upstream via deferred update of `bulkInput` (we
   * read on demand here — React's batching keeps the cost cheap; the
   * input field itself updates synchronously for responsiveness). */
  const bulkPlan = React.useMemo<BulkImportPlan>(() => {
    const raw = bulkInput;
    if (!raw.trim()) {
      return {
        rows: [],
        importableCount: 0,
        unknownAudienceCount: 0,
        duplicateCount: 0,
        totalLines: 0,
      };
    }
    // Split on newlines or whitespace runs that include a newline. The
    // portal-snippet copy joins with `\n` so the split is well-defined.
    const lines = raw
      .split(/\r?\n+/g)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const existingKey = new Set(
      allTokens.map((t) => `${t.homeAccountId}|${t.audience}`),
    );
    const out: BulkImportRow[] = [];
    let importable = 0;
    let unknown = 0;
    let duplicates = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const stripped = line.replace(/^Bearer\s+/i, "").trim();
      const looksLikeJwt = JWT_SHAPE_RE.test(stripped);
      const preview = looksLikeJwt ? previewToken(stripped) : null;
      const key = `${i}-${hashLineForKey(stripped)}`;
      const masked = maskLineForDisplay(line);
      if (preview) {
        importable += 1;
        if (preview.audience === "unknown") unknown += 1;
        if (existingKey.has(`${preview.homeAccountId}|${preview.audience}`)) {
          duplicates += 1;
        }
      }
      out.push({
        key,
        lineNo: i + 1,
        maskedLine: masked,
        preview,
        status: "pending",
        reason: preview
          ? undefined
          : looksLikeJwt
            ? "Looks like a JWT but is missing oid/tid claims."
            : "Does not match JWT shape (three base64url segments).",
      });
    }
    return {
      rows: out,
      importableCount: importable,
      unknownAudienceCount: unknown,
      duplicateCount: duplicates,
      totalLines: lines.length,
    };
  }, [bulkInput, allTokens]);

  /**
   * Commit every importable row from the bulk plan. Per-row exception
   * boundaries — one bad line never blocks the others. Cancellable via
   * `bulkAbortRef` (operator clicks "Cancel" or navigates away).
   *
   * SECURITY: audit log entries carry counts + per-row outcome only —
   * NEVER the token string, NEVER the decoded claims. The masked-line
   * preview (`maskedLine`) is the only line-identifying string that
   * ever reaches the audit log details field, and it's already
   * mask-safe (12 chars + length).
   */
  const runBulkImport = React.useCallback(async () => {
    if (bulkPlan.importableCount === 0) return;
    bulkAbortRef.current?.abort();
    const ac = new AbortController();
    bulkAbortRef.current = ac;
    setBulkBusy(true);
    const startedAt = bulkPlan.rows.map((r) => ({ ...r }));
    setBulkRows(startedAt);
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    // Snapshot the current allTokens before we mutate the store — we
    // re-derive `existingKey` once at the start so duplicate detection
    // matches what the operator saw in the preview table.
    const next = startedAt.map((row): BulkImportRow => {
      if (ac.signal.aborted || !mountedRef.current) {
        return { ...row, status: "skipped", reason: "Cancelled by operator." };
      }
      if (!row.preview) {
        failed += 1;
        return { ...row, status: "failed" };
      }
      try {
        const committed = importToken(row.preview);
        ok += 1;
        // Audit entry for the SUCCESSFUL commit — counts + audience only.
        // No token material, no claims dump.
        auditLog.record({
          actor: committed.upn ?? committed.oid ?? "operator",
          action: "import_token",
          target: `${committed.audience} @ ${committed.tenantId}`,
          status: "success",
          details: {
            oid: committed.oid,
            tenantId: committed.tenantId,
            audience: committed.audience,
            rawAudience: committed.rawAudience,
            expiresAt: committed.expiresAt,
            source: "bulk-import",
            lineNo: row.lineNo,
            trustedTenant: trustedTenantSet.has(
              committed.tenantId.toLowerCase(),
            ),
          },
        });
        return { ...row, status: "imported" };
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : "import failed";
        // Failure audit — sanitized error string only. `msg` originates
        // from importToken() which throws plain validation errors and
        // does NOT echo the token back.
        auditLog.record({
          actor: row.preview.upn ?? row.preview.oid ?? "operator",
          action: "import_token",
          target: `${row.preview.audience} @ ${row.preview.tenantId}`,
          status: "failure",
          error: msg,
          details: {
            tenantId: row.preview.tenantId,
            audience: row.preview.audience,
            source: "bulk-import",
            lineNo: row.lineNo,
          },
        });
        return { ...row, status: "failed", reason: msg };
      }
    });
    if (ac.signal.aborted || !mountedRef.current) {
      skipped = next.filter((r) => r.status === "pending").length;
    }
    setBulkRows(next);
    setBulkBusy(false);
    // Re-derive the account list so the lower table picks up imports.
    refreshList();
    // Summary audit row — operators want a single "bulk-import complete"
    // pin in the log per batch, with no per-token detail.
    auditLog.record({
      actor: "operator",
      action: "import_token_bulk",
      target: `${ok}+${failed}+${skipped}`,
      // audit-log status is strictly "success" | "failure" — represent
      // partial outcomes as success (at least one row imported) and
      // track the breakdown via the `details` field so dashboards can
      // surface them without losing the success/failure binary.
      status: ok > 0 ? "success" : "failure",
      details: {
        imported: ok,
        failed,
        skipped,
        totalLines: bulkPlan.totalLines,
        importable: bulkPlan.importableCount,
        duplicateCount: bulkPlan.duplicateCount,
        unknownAudienceCount: bulkPlan.unknownAudienceCount,
        outcome: failed === 0 && ok > 0 ? "full" : ok > 0 ? "partial" : "none",
      },
    });
    store.addNotification({
      type: ok > 0 && failed === 0 ? "success" : ok > 0 ? "warning" : "error",
      message: `Bulk import: ${ok} imported, ${failed} failed, ${skipped} skipped.`,
    });
  }, [bulkPlan, store, refreshList, trustedTenantSet]);

  const cancelBulkImport = React.useCallback(() => {
    bulkAbortRef.current?.abort();
    if (mountedRef.current) setBulkBusy(false);
  }, []);

  const clearBulkInput = React.useCallback(() => {
    setBulkInput("");
    setBulkRows([]);
  }, []);

  /**
   * Toggle a tenant id in the trusted-audiences allowlist. The
   * `usePersistedState` setter writes through the canonical hook —
   * never raw localStorage. Only valid GUID-shaped strings are added.
   */
  const toggleTrustedTenant = React.useCallback(
    (tenantId: string) => {
      const tid = tenantId.trim().toLowerCase();
      if (!trustedAudiencesGuidRe.test(tid)) return;
      setTrustedTenants((prev) => {
        const set = new Set(prev.map((t) => t.toLowerCase()));
        if (set.has(tid)) set.delete(tid);
        else set.add(tid);
        return Array.from(set);
      });
      // Audit the change — tenant id is a public GUID, safe to log.
      auditLog.record({
        actor: "operator",
        action: "trusted_tenant_toggle",
        target: tid,
        status: "success",
        details: { tenantId: tid },
      });
    },
    [setTrustedTenants],
  );

  const handleRemoveAccount = React.useCallback(
    (a: ImportedAccountSummary) => {
      setPendingConfirm({ kind: "drop-account", account: a });
    },
    [],
  );

  const confirmRemoveAccount = React.useCallback(
    (a: ImportedAccountSummary) => {
      removeImportedAccount(a.homeAccountId);
      // Emit BOTH the legacy `drop_imported_token` name (for backwards
      // compatibility with existing audit-log dashboards) AND the
      // canonical `remove_imported_account` name listed in the page
      // audit spec.
      auditLog.record({
        actor: a.upn ?? a.oid,
        action: "drop_imported_token",
        target: a.homeAccountId,
        status: "success",
        details: { audiences: a.audiences.join(",") },
      });
      auditLog.record({
        actor: a.upn ?? a.oid,
        action: "remove_imported_account",
        target: a.homeAccountId,
        status: "success",
        details: {
          tenantId: a.tenantId,
          oid: a.oid,
          audiences: a.audiences.join(","),
        },
      });
      // Remove the pseudo-account from the store too.
      const all = state.azureAccounts ?? [];
      store.setAzureAccounts(
        all.filter((row) => row.homeAccountId !== a.homeAccountId),
      );
      refreshList();
    },
    [refreshList, state.azureAccounts, store],
  );

  const handleRemoveAudience = React.useCallback(
    (homeAccountId: string, audience: AudienceBucket) => {
      removeImportedAudience(homeAccountId, audience);
      auditLog.record({
        actor: homeAccountId,
        action: "drop_imported_token_audience",
        target: `${homeAccountId}|${audience}`,
        status: "success",
        details: {},
      });
      auditLog.record({
        actor: homeAccountId,
        action: "remove_imported_audience",
        target: `${homeAccountId}|${audience}`,
        status: "success",
        details: { audience },
      });
      refreshList();
    },
    [refreshList],
  );

  const handleClearAll = React.useCallback(() => {
    setPendingConfirm({ kind: "drop-all" });
  }, []);

  const handleDropExpired = React.useCallback(() => {
    setPendingConfirm({ kind: "drop-expired" });
  }, []);

  const confirmClearAll = React.useCallback(() => {
    const before = listImportedAccounts();
    clearImportedTokens();
    auditLog.record({
      actor: "operator",
      action: "drop_all_imported_tokens",
      target: "*",
      status: "success",
      details: { accountsCleared: before.length },
    });
    // Remove every pseudo-account from the store too (they have
    // environment === "imported", same way we marked them on import).
    const all = state.azureAccounts ?? [];
    store.setAzureAccounts(
      all.filter((row) => row.environment !== "imported"),
    );
    refreshList();
  }, [refreshList, state.azureAccounts, store]);

  /** Drop only expired access tokens. Refresh tokens stay (they don't
   *  carry an `exp` claim — AAD revokes them server-side). */
  const confirmDropExpired = React.useCallback(() => {
    const now = Math.floor(Date.now() / 1000);
    const all = listImportedTokens();
    const expired = all.filter((t) => t.expiresAt > 0 && t.expiresAt < now);
    let dropped = 0;
    for (const t of expired) {
      removeImportedAudience(t.homeAccountId, t.audience);
      dropped += 1;
    }
    auditLog.record({
      actor: "operator",
      action: "drop_expired_imported_tokens",
      target: "*",
      status: "success",
      details: { dropped },
    });
    store.addNotification({
      type: dropped > 0 ? "success" : "info",
      message:
        dropped > 0
          ? `Dropped ${dropped} expired token${dropped === 1 ? "" : "s"}.`
          : "No expired tokens to drop.",
    });
    refreshList();
  }, [refreshList, store]);

  const copySnippet = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(PORTAL_SNIPPET);
      if (!mountedRef.current) return;
      setSnippetCopied(true);
      window.setTimeout(() => {
        if (mountedRef.current) setSnippetCopied(false);
      }, 1500);
    } catch {
      store.addNotification({
        type: "error",
        message: "Could not copy snippet — clipboard access blocked.",
      });
    }
  }, [store]);

  /** Pull whatever's on the clipboard into the access-token textarea. */
  const pasteAccessTokenFromClipboard = React.useCallback(async () => {
    const text = await readFromClipboard();
    if (!mountedRef.current) return;
    if (text == null) {
      store.addNotification({
        type: "error",
        message:
          "Clipboard read blocked. Paste manually with Ctrl/Cmd+V into the token field.",
      });
      return;
    }
    setInput(text);
  }, [store]);

  /** Pull whatever's on the clipboard into the refresh-token textarea. */
  const pasteRefreshTokenFromClipboard = React.useCallback(async () => {
    const text = await readFromClipboard();
    if (!mountedRef.current) return;
    if (text == null) {
      store.addNotification({
        type: "error",
        message:
          "Clipboard read blocked. Paste manually with Ctrl/Cmd+V into the refresh-token field.",
      });
      return;
    }
    setRtInput(text);
    setRtExtracted({ source: null, fields: [] });
    setRtExtractWarning(null);
  }, [store]);

  /* ---- Derived: list of every imported access token (for stats &
   * export). We compute it once per render — listImportedTokens()
   * reads localStorage but is cheap (n is small). */
  const allTokens = React.useMemo(
    () => listImportedTokens(),
    // Re-read whenever the accounts / refresh-token lists change
    // (which is what the in-storage list is keyed by).
    [accounts, refreshTokens],
  );

  /* ---- Derived: search + audience-filter applied to the account list.
   * We match against the displayable strings the operator can see in
   * the row (name, upn, oid, tenant id, audience bucket) —
   * case-insensitive. The audience chip filter is an additional AND
   * predicate driven by the clickable summary stat tiles. */
  const filteredAccounts = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const fiveMin = now + 5 * 60;
    return accounts.filter((a) => {
      // Text query
      if (q) {
        const hit =
          (a.name ?? "").toLowerCase().includes(q) ||
          (a.upn ?? "").toLowerCase().includes(q) ||
          a.oid.toLowerCase().includes(q) ||
          a.tenantId.toLowerCase().includes(q) ||
          a.homeAccountId.toLowerCase().includes(q) ||
          a.audiences.some((bucket) => bucket.toLowerCase().includes(q));
        if (!hit) return false;
      }
      // Audience / expiry chip filter
      if (audienceFilter) {
        const myTokens = allTokens.filter(
          (t) => t.homeAccountId === a.homeAccountId,
        );
        if (audienceFilter === "expiring") {
          if (
            !myTokens.some(
              (t) =>
                t.expiresAt > 0 &&
                t.expiresAt >= now &&
                t.expiresAt < fiveMin,
            )
          ) {
            return false;
          }
        } else if (audienceFilter === "expired") {
          if (
            !myTokens.some((t) => t.expiresAt > 0 && t.expiresAt < now)
          ) {
            return false;
          }
        } else if (!a.audiences.includes(audienceFilter)) {
          return false;
        }
      }
      return true;
    });
  }, [accounts, allTokens, search, audienceFilter]);

  /* ---- Derived: at-a-glance stats above the list. Audience tallies
   * support the click-to-filter chips. */
  const stats = React.useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const fiveMin = now + 5 * 60;
    let expiringSoon = 0;
    let expired = 0;
    const perAudience: Record<AudienceBucket, number> = {
      arm: 0,
      graph: 0,
      batch: 0,
      devops: 0,
      unknown: 0,
    };
    for (const t of allTokens) {
      perAudience[t.audience] += 1;
      if (t.expiresAt > 0 && t.expiresAt < now) expired += 1;
      else if (t.expiresAt > 0 && t.expiresAt < fiveMin) expiringSoon += 1;
    }
    return {
      accessTokens: allTokens.length,
      refreshTokens: refreshTokens.length,
      expiringSoon,
      expired,
      perAudience,
    };
  }, [allTokens, refreshTokens]);

  /* ---- Export descriptor: one row per (account × audience). Rich
   * enough that ops can reconcile by tenant or audience post-export
   * without re-running the page. */
  type ExportRow = {
    homeAccountId: string;
    tenantId: string;
    oid: string;
    upn: string;
    name: string;
    audience: AudienceBucket;
    rawAudience: string;
    expiresAt: number;
    expiresAtIso: string;
    expiresInSec: number;
    importedAt: string;
    hasRefreshToken: boolean;
    refreshTokenClientId: string;
  };
  const exportRows = React.useMemo<ExportRow[]>(() => {
    const visibleIds = new Set(filteredAccounts.map((a) => a.homeAccountId));
    const now = Math.floor(Date.now() / 1000);
    const rtByAccount = new Map(
      refreshTokens.map((r) => [r.homeAccountId, r] as const),
    );
    return allTokens
      .filter((t) => visibleIds.has(t.homeAccountId))
      .map((t) => {
        const rt = rtByAccount.get(t.homeAccountId);
        return {
          homeAccountId: t.homeAccountId,
          tenantId: t.tenantId,
          oid: t.oid,
          upn: t.upn ?? "",
          name: t.name ?? "",
          audience: t.audience,
          rawAudience: t.rawAudience,
          expiresAt: t.expiresAt,
          expiresAtIso:
            t.expiresAt > 0 ? new Date(t.expiresAt * 1000).toISOString() : "",
          expiresInSec: t.expiresAt > 0 ? t.expiresAt - now : 0,
          importedAt: t.importedAt,
          hasRefreshToken: !!rt,
          refreshTokenClientId: rt?.clientId ?? "",
        };
      });
  }, [allTokens, filteredAccounts, refreshTokens]);
  const exportColumns: ExportColumn<ExportRow>[] = React.useMemo(
    () => [
      { header: "homeAccountId", accessor: (r) => r.homeAccountId },
      { header: "tenantId", accessor: (r) => r.tenantId },
      { header: "oid", accessor: (r) => r.oid },
      { header: "upn", accessor: (r) => r.upn },
      { header: "name", accessor: (r) => r.name },
      { header: "audience", accessor: (r) => r.audience },
      { header: "rawAudience", accessor: (r) => r.rawAudience },
      { header: "expiresAtEpoch", accessor: (r) => r.expiresAt },
      { header: "expiresAtIso", accessor: (r) => r.expiresAtIso },
      { header: "expiresInSec", accessor: (r) => r.expiresInSec },
      { header: "importedAt", accessor: (r) => r.importedAt },
      { header: "hasRefreshToken", accessor: (r) => r.hasRefreshToken },
      {
        header: "refreshTokenClientId",
        accessor: (r) => r.refreshTokenClientId,
      },
    ],
    [],
  );

  /* ---- FOCI eligibility, by refresh-token homeAccountId. We don't
   * actually need the access-token for this — the RT's own clientId
   * tells us whether it was issued by a FOCI client. If the operator
   * also has an access token cached for the same account we
   * cross-check the `azp` / `appid` claim for confidence. */
  const fociByHomeAccount = React.useMemo(() => {
    const m = new Map<string, ReturnType<typeof detectFociEligibility>>();
    for (const r of refreshTokens) {
      // Synthesise a minimal claim object from the RT's known clientId
      // — detectFociEligibility doesn't care about the rest.
      const synthClaims = { azp: r.clientId };
      let result = detectFociEligibility(synthClaims);
      // Cross-check against any cached AT — if its azp/appid disagrees
      // with the RT's clientId (unusual but possible after multiple
      // FOCI exchanges), prefer the AT's claim.
      const at = allTokens.find(
        (t) => t.homeAccountId === r.homeAccountId,
      );
      if (at) {
        const atClaims = decodeJwtPayload(at.accessToken);
        if (atClaims) {
          const atResult = detectFociEligibility(atClaims);
          if (atResult.eligible) result = atResult;
        }
      }
      m.set(r.homeAccountId, result);
    }
    return m;
  }, [refreshTokens, allTokens]);

  /* ---- Currently-selected source RT for the FOCI exchange card.
   * Re-derived per render — guards against the selected RT being
   * dropped mid-session. */
  const fociSource = React.useMemo(
    () =>
      refreshTokens.find((r) => r.homeAccountId === fociSourceAccountId) ??
      null,
    [refreshTokens, fociSourceAccountId],
  );
  const fociSourceFoci = fociSource
    ? fociByHomeAccount.get(fociSource.homeAccountId)
    : undefined;

  /* ---- Render --------------------------------------------------- */

  // Build the confirmation-dialog props once per render so the JSX
  // below stays compact. The dialog is always mounted; visibility
  // is driven by the `pendingConfirm` discriminated union above.
  const confirmDialogProps = React.useMemo(() => {
    const close = () => setPendingConfirm(null);
    if (pendingConfirm == null) {
      return {
        hidden: true,
        title: "",
        message: "",
        onConfirm: close,
        onCancel: close,
      };
    }
    if (pendingConfirm.kind === "drop-refresh") {
      const e = pendingConfirm.entry;
      return {
        hidden: false,
        title: "Drop refresh token?",
        message: `Drop the refresh token for ${e.upn ?? e.oid}? Cached access tokens (if any) stay until they expire.`,
        confirmText: "Drop refresh token",
        onConfirm: () => {
          confirmRemoveRefresh(e);
          close();
        },
        onCancel: close,
      };
    }
    if (pendingConfirm.kind === "drop-account") {
      const a = pendingConfirm.account;
      return {
        hidden: false,
        title: "Drop imported tokens?",
        message: `Drop every imported token for ${a.upn ?? a.oid}? This won't affect any other Azure login.`,
        confirmText: "Drop account",
        onConfirm: () => {
          confirmRemoveAccount(a);
          close();
        },
        onCancel: close,
      };
    }
    if (pendingConfirm.kind === "drop-expired") {
      return {
        hidden: false,
        title: "Drop expired access tokens?",
        message: `Remove every imported access token whose 'exp' claim is in the past (${stats.expired} entr${stats.expired === 1 ? "y" : "ies"}). Refresh tokens are kept — they don't carry a client-side expiry.`,
        confirmText: "Drop expired",
        onConfirm: () => {
          confirmDropExpired();
          close();
        },
        onCancel: close,
      };
    }
    // drop-all
    return {
      hidden: false,
      title: "Drop every imported token?",
      message:
        "Drop EVERY imported token? MSAL-based signed-in accounts are not affected.",
      confirmText: "Drop all",
      onConfirm: () => {
        confirmClearAll();
        close();
      },
      onCancel: close,
    };
  }, [
    pendingConfirm,
    stats.expired,
    confirmRemoveRefresh,
    confirmRemoveAccount,
    confirmClearAll,
    confirmDropExpired,
  ]);

  // Ctrl/Cmd+Enter to submit the focused textarea.
  const handleAccessTokenKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && preview) {
        e.preventDefault();
        handleImport();
      }
    },
    [preview, handleImport],
  );
  const handleRefreshTokenKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "Enter" &&
        rtPlanValid &&
        !rtSubmitting
      ) {
        e.preventDefault();
        void submitRefreshToken();
      }
    },
    [rtPlanValid, rtSubmitting, submitRefreshToken],
  );

  /* ---- Per-row bulk-input Ctrl+Enter handler ----------------------- */
  const handleBulkKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "Enter" &&
        bulkPlan.importableCount > 0 &&
        !bulkBusy
      ) {
        e.preventDefault();
        void runBulkImport();
      }
    },
    [bulkPlan.importableCount, bulkBusy, runBulkImport],
  );

  return (
    <div className="flex flex-col gap-4 py-2">
      <PageHeader
        title="Token Importer"
        description="Paste a bearer token from any Azure login (e.g. portal.azure.com) and use it as this app's credential. Bypasses MSAL entirely — useful when AAD restrictions block PKCE from this origin."
      />

      {/* ----- Snippet helper ----------------------------------------- */}
      <Card className="border-primary/30">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ClipboardPaste className="h-4 w-4 text-primary" />
            Grab a token from portal.azure.com
          </CardTitle>
          <CardDescription>
            Open{" "}
            <a
              href="https://portal.azure.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              portal.azure.com
              <ExternalLink className="h-3 w-3" />
            </a>{" "}
            in another tab. Open DevTools (F12) → Console. Paste this
            snippet, hit enter. The first token is copied to your clipboard
            and every token is logged so you can pick a specific
            audience (ARM / Graph / Batch). Then come back here and paste
            the JWT into the form below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[10px] leading-tight">
            {PORTAL_SNIPPET}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => void copySnippet()}
            >
              {snippetCopied ? <Check /> : <Copy />}
              {snippetCopied ? "Copied" : "Copy snippet"}
            </Button>
            <span className="text-2xs text-muted-foreground">
              Then paste the resulting JWT into the access-token form below
              (or use Ctrl/Cmd+V into the field).
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ----- Bulk paste (multi-line) ------------------------------- */}
      {/*
        * The portal snippet at the top joins every cached bearer token
        * with `\n` and writes the whole batch to the clipboard. This
        * card accepts that newline-delimited paste directly: each line
        * is independently parsed, previewed, and imported.
        *
        * SECURITY: the textarea value never leaves React state — we
        * never log it, never persist the raw paste, never put the
        * decoded claims into audit-log `details`. Only sanitized
        * counts + audience strings reach the audit log.
        */}
      <Card className="border-primary/30">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Plus className="h-4 w-4 text-primary" />
            Bulk paste — multi-line JWT import
            <InfoTooltip
              ariaLabel="About bulk paste"
              content="Paste a newline-separated list of JWTs (e.g. the output of the portal-snippet at the top, which already joins every cached token with \\n). Each line is parsed independently; the table below shows per-line outcome. Cancellable mid-batch; nothing is committed until you click 'Import all'."
            />
            {trustedTenants.length > 0 && (
              <Badge variant="secondary" className="text-2xs">
                <ShieldCheck className="h-3 w-3" /> {trustedTenants.length} trusted tenant
                {trustedTenants.length === 1 ? "" : "s"}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            One JWT per line — empty lines and{" "}
            <code className="font-mono">Bearer </code> prefixes are tolerated.
            Press{" "}
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-2xs">
              Ctrl
            </kbd>
            +
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-2xs">
              Enter
            </kbd>{" "}
            to commit the staged batch.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <textarea
            id="bulk-paste-access-tokens"
            value={bulkInput}
            onChange={(e) => setBulkInput(e.target.value)}
            onKeyDown={handleBulkKeyDown}
            placeholder={
              "eyJ0eXAi…\neyJ0eXAi…\nBearer eyJ0eXAi…\n# (one JWT per line)"
            }
            rows={5}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Paste multiple JWT bearer tokens, one per line"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              onClick={() => void runBulkImport()}
              disabled={bulkPlan.importableCount === 0 || bulkBusy}
              loading={bulkBusy}
              aria-label={`Import ${bulkPlan.importableCount} staged token${bulkPlan.importableCount === 1 ? "" : "s"}`}
            >
              {!bulkBusy && <CheckCircle2 />}
              Import all ({bulkPlan.importableCount})
            </Button>
            {bulkBusy && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={cancelBulkImport}
                aria-label="Cancel in-flight bulk import"
              >
                <X />
                Cancel
              </Button>
            )}
            {bulkInput.length > 0 && !bulkBusy && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearBulkInput}
                aria-label="Clear bulk paste input and results"
              >
                <X />
                Clear
              </Button>
            )}
            {bulkPlan.totalLines > 0 && (
              <span className="text-2xs text-muted-foreground">
                {bulkPlan.totalLines} line{bulkPlan.totalLines === 1 ? "" : "s"}
                {" · "}
                {bulkPlan.importableCount} importable
                {bulkPlan.duplicateCount > 0
                  ? ` · ${bulkPlan.duplicateCount} duplicate${bulkPlan.duplicateCount === 1 ? "" : "s"}`
                  : ""}
                {bulkPlan.unknownAudienceCount > 0
                  ? ` · ${bulkPlan.unknownAudienceCount} unknown audience`
                  : ""}
              </span>
            )}
          </div>
          {bulkPlan.rows.length > 0 && (
            <div
              className="max-h-64 overflow-auto rounded-md border border-border bg-muted/20 p-2 text-2xs"
              role="region"
              aria-label="Per-line bulk import preview and results"
            >
              <table className="w-full">
                <thead className="sticky top-0 bg-muted/40 text-left">
                  <tr>
                    <th className="px-1 py-0.5 font-medium">#</th>
                    <th className="px-1 py-0.5 font-medium">Line</th>
                    <th className="px-1 py-0.5 font-medium">Audience</th>
                    <th className="px-1 py-0.5 font-medium">Identity</th>
                    <th className="px-1 py-0.5 font-medium">Tenant</th>
                    <th className="px-1 py-0.5 font-medium">Expires</th>
                    <th className="px-1 py-0.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(bulkBusy || bulkRows.length > 0
                    ? bulkRows
                    : bulkPlan.rows
                  ).map((row) => {
                    const p = row.preview;
                    const trustOk =
                      p && trustedTenantSet.size > 0
                        ? trustedTenantSet.has(p.tenantId.toLowerCase())
                        : null;
                    return (
                      <tr
                        key={row.key}
                        className="border-t border-border/40 align-top"
                      >
                        <td className="px-1 py-0.5 font-mono text-muted-foreground">
                          {row.lineNo}
                        </td>
                        <td className="px-1 py-0.5 font-mono">
                          {row.maskedLine}
                        </td>
                        <td className="px-1 py-0.5">
                          {p ? (
                            <Badge
                              variant={
                                p.audience === "unknown"
                                  ? "destructive"
                                  : "outline"
                              }
                              className="text-2xs"
                              title={AUDIENCE_HINT[p.audience]}
                            >
                              {AUDIENCE_SHORT[p.audience]}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-1 py-0.5">
                          {p ? p.upn ?? p.name ?? p.oid.slice(0, 12) : "—"}
                        </td>
                        <td className="px-1 py-0.5">
                          {p ? (
                            <span className="inline-flex items-center gap-1">
                              <code className="font-mono">
                                {p.tenantId.slice(0, 8)}…
                              </code>
                              {trustOk === true && (
                                <ShieldCheck
                                  className="h-3 w-3 text-success"
                                  aria-label="Trusted tenant"
                                />
                              )}
                              {trustOk === false && (
                                <AlertTriangle
                                  className="h-3 w-3 text-warning"
                                  aria-label="Tenant not in trusted allowlist"
                                />
                              )}
                              <button
                                type="button"
                                onClick={() => toggleTrustedTenant(p.tenantId)}
                                className="rounded border border-border/60 px-1 text-[9px] hover:bg-muted"
                                aria-label={
                                  trustedTenantSet.has(p.tenantId.toLowerCase())
                                    ? `Remove tenant ${p.tenantId} from trusted allowlist`
                                    : `Add tenant ${p.tenantId} to trusted allowlist`
                                }
                                title={
                                  trustedTenantSet.has(p.tenantId.toLowerCase())
                                    ? "In trusted allowlist — click to remove"
                                    : "Not in trusted allowlist — click to add"
                                }
                              >
                                {trustedTenantSet.has(p.tenantId.toLowerCase())
                                  ? "untrust"
                                  : "trust"}
                              </button>
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-1 py-0.5">
                          {p ? fmtExpiresIn(p.expiresAt) : "—"}
                        </td>
                        <td className="px-1 py-0.5">
                          {row.status === "imported" && (
                            <Badge variant="success" className="text-2xs">
                              <Check className="h-3 w-3" /> imported
                            </Badge>
                          )}
                          {row.status === "failed" && (
                            <Badge
                              variant="destructive"
                              className="text-2xs"
                              title={row.reason}
                            >
                              <X className="h-3 w-3" /> failed
                            </Badge>
                          )}
                          {row.status === "skipped" && (
                            <Badge
                              variant="warning"
                              className="text-2xs"
                              title={row.reason}
                            >
                              skipped
                            </Badge>
                          )}
                          {row.status === "pending" &&
                            (p ? (
                              <Badge
                                variant="secondary"
                                className="text-2xs"
                                title="Will import when you click 'Import all'"
                              >
                                ready
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-2xs"
                                title={row.reason}
                              >
                                no parse
                              </Badge>
                            ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {bulkPlan.unknownAudienceCount > 0 && (
            <Alert variant="warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              <AlertDescription className="text-2xs">
                {bulkPlan.unknownAudienceCount} token
                {bulkPlan.unknownAudienceCount === 1 ? "" : "s"} target an
                unrecognised audience. They will import but no page will
                auto-route on them.{" "}
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => navigateToPage("/audience-matrix")}
                >
                  Open audience-matrix
                </button>{" "}
                to see what coverage looks like after import.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* ----- Paste + preview --------------------------------------- */}
      <Card className="border-primary/30">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Key className="h-4 w-4 text-primary" />
            Paste access token
            <InfoTooltip
              content="An Azure-issued JWT (three base64url segments separated by dots). The audience claim determines which API surface the token can call: ARM, Graph, or Batch. We decode locally — the JWT signature is NOT verified (Azure verifies on every API call instead)."
              ariaLabel="About access tokens"
            />
          </CardTitle>
          <CardDescription>
            One JWT at a time. Pastes like <code className="font-mono">Bearer eyJ…</code> are
            tolerated. Press <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-2xs">Ctrl</kbd>+<kbd className="rounded border border-border bg-muted px-1 py-0.5 text-2xs">Enter</kbd> to import.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <textarea
            id="paste-access-token"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleAccessTokenKeyDown}
            placeholder="eyJ0eXAiOiJKV1QiLCJhbGciOi…"
            rows={5}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Paste access token JWT"
            aria-invalid={
              input.length > 0 && !preview ? true : undefined
            }
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void pasteAccessTokenFromClipboard()}
            >
              <ClipboardPaste />
              Paste from clipboard
            </Button>
            {input.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setInput("");
                  setSubmitError(null);
                }}
              >
                <X />
                Clear
              </Button>
            )}
            {input.length > 0 && (
              <span className="text-2xs text-muted-foreground">
                {input.length.toLocaleString()} chars
              </span>
            )}
          </div>
          {input.length > 0 && !preview && (
            <Alert variant="destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              <AlertDescription>
                Could not decode that input as a JWT. Expected the full
                token (three dot-separated base64url segments containing
                <code className="ml-1 font-mono">oid</code> +
                <code className="ml-1 font-mono">tid</code> claims).
              </AlertDescription>
            </Alert>
          )}
          {preview && (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">
                  {preview.name ?? preview.upn ?? preview.oid}
                </span>
                {preview.upn && preview.name && (
                  <span className="text-2xs text-muted-foreground">
                    {preview.upn}
                  </span>
                )}
                <Badge
                  variant={
                    preview.audience === "unknown" ? "destructive" : "outline"
                  }
                  className="text-2xs"
                  title={AUDIENCE_HINT[preview.audience]}
                >
                  {AUDIENCE_LABELS[preview.audience]}
                </Badge>
                <Badge
                  variant={
                    preview.expiresAt > 0 &&
                    preview.expiresAt < Math.floor(Date.now() / 1000)
                      ? "destructive"
                      : preview.expiresAt > 0 &&
                          preview.expiresAt <
                            Math.floor(Date.now() / 1000) + 5 * 60
                        ? "warning"
                        : "secondary"
                  }
                  className="text-2xs"
                >
                  <Clock className="h-3 w-3" /> {fmtExpiresIn(preview.expiresAt)}
                </Badge>
                {preview.audience === "unknown" && (
                  <span className="text-2xs text-destructive">
                    No automatic routing — pages will fall back to MSAL.
                  </span>
                )}
              </div>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[10px]">
                <dt className="inline-flex items-center gap-1 text-muted-foreground">
                  oid
                  <InfoTooltip
                    content="AAD object id of the principal that owns this token (user, service principal, or managed identity). Combined with `tid` it uniquely identifies the principal across all of Azure."
                    ariaLabel="About the oid claim"
                  />
                </dt>
                <dd className="break-all">
                  <CopyableText
                    value={preview.oid}
                    mono
                    ariaLabel="Copy oid claim"
                  />
                </dd>
                <dt className="inline-flex items-center gap-1 text-muted-foreground">
                  tid
                  <InfoTooltip
                    content="AAD tenant id (`tid` claim) where the principal lives. Cross-tenant calls work but the token's tenant determines which directory's RBAC applies."
                    ariaLabel="About the tid claim"
                  />
                </dt>
                <dd className="break-all">
                  <CopyableText
                    value={preview.tenantId}
                    mono
                    ariaLabel="Copy tenant id"
                  />
                </dd>
                <dt className="inline-flex items-center gap-1 text-muted-foreground">
                  aud
                  <InfoTooltip
                    content="Raw 'aud' claim from the JWT — the AAD-issued audience (resource the token is valid for). The WebUI maps this onto canonical buckets (ARM / Graph / Batch) for routing."
                    ariaLabel="About the audience claim"
                  />
                </dt>
                <dd className="break-all">
                  <CopyableText
                    value={preview.rawAudience}
                    mono
                    ariaLabel="Copy raw audience claim"
                  />
                </dd>
                {typeof preview.claims.scp === "string" && (
                  <>
                    <dt className="inline-flex items-center gap-1 text-muted-foreground">
                      scp
                      <InfoTooltip
                        content="OAuth scope(s) (`scp` claim) consented to when this token was issued. Each space-separated value is one permission the token can exercise against the audience."
                        ariaLabel="About the scope claim"
                      />
                    </dt>
                    <dd className="break-all">
                      <CopyableText
                        value={preview.claims.scp as string}
                        mono
                        ariaLabel="Copy scope claim"
                      />
                    </dd>
                  </>
                )}
                {typeof preview.claims.appid === "string" && (
                  <>
                    <dt className="inline-flex items-center gap-1 text-muted-foreground">
                      appid
                      <InfoTooltip
                        content="Client application id (`appid` / `azp`) — the AAD app registration that requested the token. Must match the `client_id` you use to redeem an accompanying refresh token."
                        ariaLabel="About the appid claim"
                      />
                    </dt>
                    <dd className="break-all">
                      <CopyableText
                        value={preview.claims.appid as string}
                        mono
                        ariaLabel="Copy appid claim"
                      />
                    </dd>
                  </>
                )}
              </dl>
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 text-2xs"
                  onClick={() => toggleClaims("preview")}
                  aria-expanded={!!expandedClaims.preview}
                >
                  {expandedClaims.preview ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  <Braces className="h-3 w-3" />
                  {expandedClaims.preview
                    ? "Hide decoded claims"
                    : "Show all decoded claims"}
                </Button>
              </div>
              {expandedClaims.preview && (
                <ClaimsGrid claims={preview.claims} maxHeight="18rem" />
              )}
            </div>
          )}
          {submitError && (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              onClick={handleImport}
              disabled={!preview}
              aria-label="Import pasted access token"
            >
              <CheckCircle2 />
              Import token
            </Button>
            {preview && preview.audience === "unknown" && (
              <span className="text-2xs text-warning">
                Importing anyway — token will sit in the store but no
                page will auto-pick it.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ----- Refresh-token form (recommended) ------------------- */}
      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4 text-success" />
            Refresh token (recommended — works in all scopes)
            <InfoTooltip
              content="AAD refresh tokens (RT) can be redeemed at the token endpoint for an access token in ANY scope you previously consented to — so a single RT covers ARM + Graph + Batch. Access tokens last ~60-90 minutes; RTs last 90 days (sliding window) by default."
              ariaLabel="About refresh tokens"
            />
          </CardTitle>
          <CardDescription>
            Paste an Azure-issued refresh token + the client id it was
            minted for. The WebUI will redeem it at AAD's{" "}
            <code className="font-mono">/oauth2/v2.0/token</code> endpoint
            to mint access tokens for any scope (ARM, Graph, Batch) on
            demand — no need to paste a separate access token per
            audience, and tokens auto-rotate when they expire. Press{" "}
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-2xs">
              Ctrl
            </kbd>
            +
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-2xs">
              Enter
            </kbd>{" "}
            to import.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="inline-flex items-center gap-1 text-xs">
              Refresh token *
              <InfoTooltip
                content="An AAD-issued refresh_token (opaque long string, NOT a JWT). The WebUI redeems it via AAD's token endpoint to mint access tokens for any scope you previously consented to. Rotated on every redemption — keep this tab open or re-paste when needed."
                ariaLabel="About refresh tokens"
              />
            </Label>
            <textarea
              value={rtInput}
              onChange={(e) => {
                setRtInput(e.target.value);
                setRtExtracted({ source: null, fields: [] });
                setRtExtractWarning(null);
              }}
              onKeyDown={handleRefreshTokenKeyDown}
              placeholder="0.AVoA…  (long opaque string, NOT a JWT). You can also paste an entire token-endpoint response body, curl --data-raw command, or PowerShell Invoke-RestMethod snippet — we'll pull refresh_token / client_id / tenant out automatically."
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Paste refresh token, request body, curl command, or PowerShell snippet"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void pasteRefreshTokenFromClipboard()}
              >
                <ClipboardPaste />
                Paste from clipboard
              </Button>
              {rtInput.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRtInput("");
                    setRtExtracted({ source: null, fields: [] });
                    setRtExtractWarning(null);
                  }}
                >
                  <X />
                  Clear
                </Button>
              )}
              {rtInput.length > 0 && (
                <span className="text-2xs text-muted-foreground">
                  {rtInput.length.toLocaleString()} chars
                </span>
              )}
            </div>
            <p className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
              <span>
                Accepts a bare RT, a form-encoded POST body
                (<code className="font-mono">refresh_token=…&amp;client_id=…</code>),
                a JSON token-endpoint response, a{" "}
                <code className="font-mono">curl --data-raw '…'</code>{" "}
                command, or a PowerShell{" "}
                <code className="font-mono">Invoke-RestMethod -Body @{`{`} … {`}`}</code>{" "}
                hash. Companion fields below auto-fill on submit when
                extracted from the paste.
              </span>
              <InfoTooltip
                content="Auto-extraction looks for refresh_token, client_id, tenant url, scope, and resource inside the paste. If it finds them, it fills in the fields below and surfaces an alert so you know what we changed."
                ariaLabel="About form body and curl auto-extract"
              />
            </p>
            {rtExtracted.source && (
              <Alert>
                <Zap className="h-3.5 w-3.5" />
                <AlertDescription className="text-2xs">
                  Auto-extracted from {rtExtracted.source.toUpperCase()}{" "}
                  paste: <code className="font-mono">{rtExtracted.fields.join(", ")}</code>.{" "}
                  Client id and tenant id below were updated to match.
                </AlertDescription>
              </Alert>
            )}
            {rtExtractWarning && (
              <Alert variant="warning">
                <AlertTriangle className="h-3.5 w-3.5" />
                <AlertDescription className="text-2xs">
                  {rtExtractWarning}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label className="inline-flex items-center gap-1 text-xs">
                Client id that issued it *
                <InfoTooltip
                  content="AAD app registration id that minted the refresh token. AAD rejects with invalid_grant if this doesn't match the original issuer. Common defaults: Azure CLI = 04b07795-8ddb-461a-bbee-02f9e1bf7b46; Azure portal = c44b4083-3bb0-49c1-b47d-974e53cbdf3c; az PowerShell = 1950a258-227b-4e31-a9cf-717495945fc2."
                  ariaLabel="About the issuer client id"
                />
              </Label>
              <Input
                value={rtClientId}
                onChange={(e) => setRtClientId(e.target.value)}
                placeholder="04b07795-… (Azure CLI default)"
                className="font-mono text-xs"
                aria-invalid={
                  rtClientId.length > 0 &&
                  !guidRe.test(rtClientId.trim())
                    ? true
                    : undefined
                }
                spellCheck={false}
                autoComplete="off"
              />
              <div className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
                <span>Quick-fill:</span>
                <button
                  type="button"
                  className="rounded border border-border bg-background px-1 py-0.5 font-mono hover:bg-muted"
                  onClick={() =>
                    setRtClientId("04b07795-8ddb-461a-bbee-02f9e1bf7b46")
                  }
                  title="Azure CLI default client id"
                >
                  Azure CLI
                </button>
                <button
                  type="button"
                  className="rounded border border-border bg-background px-1 py-0.5 font-mono hover:bg-muted"
                  onClick={() =>
                    setRtClientId("c44b4083-3bb0-49c1-b47d-974e53cbdf3c")
                  }
                  title="Azure portal client id"
                >
                  Portal
                </button>
                <button
                  type="button"
                  className="rounded border border-border bg-background px-1 py-0.5 font-mono hover:bg-muted"
                  onClick={() =>
                    setRtClientId("1950a258-227b-4e31-a9cf-717495945fc2")
                  }
                  title="Azure PowerShell client id"
                >
                  Az PowerShell
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="inline-flex items-center gap-1 text-xs">
                Tenant id *
                <InfoTooltip
                  content="GUID of the AAD tenant where the principal lives. Auto-filled from the optional id_token below, or from the tenant URL in a curl/JSON paste. Required — AAD rejects redemption attempts without it."
                  ariaLabel="About the tenant id field"
                />
              </Label>
              <Input
                value={rtTenantId}
                onChange={(e) => setRtTenantId(e.target.value)}
                placeholder={
                  rtIdentity.hasIdToken && rtIdentity.tid
                    ? `${rtIdentity.tid} (from id_token)`
                    : "tenant guid"
                }
                className="font-mono text-xs"
                aria-invalid={
                  rtTenantId.length > 0 && !guidRe.test(rtTenantId.trim())
                    ? true
                    : undefined
                }
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-2xs text-muted-foreground">
                {rtIdentity.hasIdToken && rtIdentity.tid && !rtTenantId.trim() ? (
                  <>
                    Using <code className="font-mono">{rtIdentity.tid}</code>{" "}
                    from the id_token below (type here to override).
                  </>
                ) : (
                  "Auto-filled from the optional id_token below, or from a tenant URL in your paste."
                )}
              </p>
            </div>
          </div>
          <details className="rounded-md border border-border/60 bg-muted/30 p-3">
            <summary className="cursor-pointer text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Optional: paste id_token to auto-fill tenant + identity
            </summary>
            <textarea
              value={rtIdToken}
              onChange={(e) => setRtIdToken(e.target.value)}
              placeholder="eyJ0eXAiOiJKV1QiLCJhbGciOi…"
              rows={3}
              className="mt-2 flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[10px]"
              spellCheck={false}
              autoComplete="off"
            />
            {rtIdentity.tid && (
              <p className="mt-2 text-2xs text-muted-foreground">
                Identity: {rtIdentity.name ?? rtIdentity.upn ?? rtIdentity.oid}
                {" · tenant "}
                <code className="font-mono">{rtIdentity.tid}</code>
              </p>
            )}
          </details>
          {rtStatus && (
            <Alert>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <AlertDescription className="text-2xs">
                {rtStatus}
              </AlertDescription>
            </Alert>
          )}
          {rtError && rtCaBlocked && (
            <Alert variant="destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  <strong>
                    AADSTS53003 — Conditional Access blocked this redemption.
                  </strong>{" "}
                  Your tenant requires something (compliant device, MFA,
                  trusted location, approved app, …) that this WebUI's
                  context can't satisfy — and CA is enforced{" "}
                  <em>inside</em> AAD, so there's no client-side
                  workaround for the refresh-token grant itself.
                </span>
                <span className="text-2xs">
                  <strong>What to do:</strong> the same token-endpoint
                  response that gave you the refresh_token also has an{" "}
                  <code className="font-mono">access_token</code>. That
                  one <em>already satisfied your CA policy at issuance time</em>{" "}
                  — paste it directly into the access-token form above.
                  It will work until its <code className="font-mono">exp</code>{" "}
                  claim (typically ~60–90 minutes). When it expires,
                  repeat the original interactive flow against your tenant
                  to mint a fresh access_token and paste that.
                </span>
                <ul className="ml-4 list-disc text-2xs">
                  <li>
                    Run <code className="font-mono">az account get-access-token</code>{" "}
                    on a machine that satisfies CA (e.g. your corp laptop)
                    and paste the result above.
                  </li>
                  <li>
                    Or sign into portal.azure.com on the CA-compliant
                    device and use the portal snippet at the top of this
                    page to extract the cached bearer.
                  </li>
                  <li>
                    Or ask an admin to scope CA so it doesn't apply to
                    the issuer client id (
                    <code className="font-mono">{rtClientId.slice(0, 8)}…</code>).
                  </li>
                </ul>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-2xs"
                    onClick={() => {
                      const el = document.getElementById(
                        "paste-access-token",
                      );
                      if (el) {
                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                        (el as HTMLTextAreaElement).focus();
                      }
                    }}
                  >
                    Jump to access-token form
                  </Button>
                </div>
                <span className="break-all text-[10px] opacity-80">
                  Raw error: {rtError}
                </span>
              </AlertDescription>
            </Alert>
          )}
          {rtError && rtInvalidGrant && (
            <Alert variant="destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  <strong>
                    AADSTS70000 — refresh token is invalid or malformed.
                  </strong>{" "}
                  Common causes, in order of likelihood:
                </span>
                <ul className="ml-4 list-disc text-2xs">
                  <li>
                    <strong>Consumed + rotated.</strong> Modern AAD
                    rotates refresh tokens — every successful redemption
                    returns a new RT and invalidates the previous one.
                    If anything (CLI, IDE, another tab) used this RT
                    after you copied it, AAD considers it dead. Capture
                    a fresh RT and try again.
                  </li>
                  <li>
                    <strong>Tenant or client id mismatch.</strong> AAD
                    only accepts a given RT for the exact{" "}
                    <code className="font-mono">client_id</code> +{" "}
                    <code className="font-mono">tid</code> that issued it.
                    Verify both fields above match the token's issuer
                    (check the <code className="font-mono">appid</code> /
                    <code className="font-mono">azp</code> claim in any
                    matching access token).
                  </li>
                  <li>
                    <strong>Revoked or expired.</strong> Signing out of
                    the source session, password change, or admin
                    revocation kills the RT. RTs also expire after 90
                    days of inactivity by default. Re-authenticate from
                    the source to mint a fresh pair.
                  </li>
                  <li>
                    <strong>Whitespace contamination.</strong> Copy-paste
                    from terminal scrollback can insert invisible
                    control characters mid-token. The WebUI strips
                    common ones, but try re-copying with the terminal in
                    "select-only" mode.
                  </li>
                </ul>
                <span className="text-2xs">
                  <strong>Workaround that always works:</strong> paste the
                  associated <code className="font-mono">access_token</code>{" "}
                  directly into the access-token form above. It's
                  already issued — no AAD redemption needed — and works
                  until its <code className="font-mono">exp</code> claim.
                </span>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-2xs"
                    onClick={() => {
                      const el = document.getElementById(
                        "paste-access-token",
                      );
                      if (el) {
                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                        (el as HTMLTextAreaElement).focus();
                      }
                    }}
                  >
                    Jump to access-token form
                  </Button>
                </div>
                <span className="break-all text-[10px] opacity-80">
                  Raw error: {rtError}
                </span>
              </AlertDescription>
            </Alert>
          )}
          {rtError && !rtCaBlocked && !rtInvalidGrant && (
            <Alert variant="destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              <AlertDescription className="flex flex-col gap-1">
                <span>{rtError}</span>
                <span className="text-2xs opacity-80">
                  If this looks like a network/CORS failure rather than
                  an AAD error code, the dev-server's{" "}
                  <code className="font-mono">/api/auth/proxy-token</code>{" "}
                  proxy may also be unreachable. Inspect the Network tab.
                </span>
              </AlertDescription>
            </Alert>
          )}
          <div>
            <Button
              type="button"
              variant="default"
              onClick={() => void submitRefreshToken()}
              disabled={!rtPlanValid || rtSubmitting}
              loading={rtSubmitting}
              aria-label="Import refresh token and mint ARM access token"
            >
              {!rtSubmitting && <KeyRound />}
              Import refresh token & mint ARM access token
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ----- FOCI exchange card ----------------------------------- */}
      <Card id="foci-exchange-card" className="border-info/30 bg-info/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-info" />
            FOCI Exchange — mint AT for ANY family client
            <Badge variant="secondary" className="text-2xs">
              {FOCI_CLIENTS.length} clients
            </Badge>
            <InfoTooltip
              ariaLabel="About FOCI exchange"
              content="Microsoft groups certain first-party public clients into a 'Family of Client IDs' (FOCI). A refresh token issued to ANY family member can be exchanged for an access token of ANY OTHER member without re-prompting consent. Useful when an operator's source client is restricted (e.g. Conditional Access blocks the Portal client) but a sibling FOCI client (e.g. Azure CLI) is allowed. Adopted from dirkjanm/ROADtools — we expose the primitive, not the recon workflow."
            />
          </CardTitle>
          <CardDescription>
            Pick an imported refresh token + a target FOCI client and AAD
            will mint an access token for the target without further
            consent. The full list is curated from{" "}
            <code className="font-mono">
              secureworks/family-of-client-ids-research
            </code>{" "}
            plus the ROADtools{" "}
            <code className="font-mono">WELLKNOWN_CLIENTS</code> alias map.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Source RT picker --------------------------------------- */}
          <div className="flex flex-col gap-2">
            <Label className="inline-flex items-center gap-1 text-xs">
              Source refresh token *
              <InfoTooltip
                ariaLabel="About the source refresh token"
                content="The RT that AAD will spend at the token endpoint. Must have been issued to a client in the FOCI family — non-FOCI source RTs return AADSTS54005 / invalid_grant at exchange time."
              />
            </Label>
            {refreshTokens.length === 0 ? (
              <Alert variant="warning">
                <AlertTriangle className="h-3.5 w-3.5" />
                <AlertDescription className="text-2xs">
                  No imported refresh tokens. Import one via the green card
                  above first — Azure CLI / Azure PowerShell / Visual Studio
                  RTs all work as FOCI sources.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={fociSourceAccountId}
                  onChange={(e) => setFociSourceAccountId(e.target.value)}
                  aria-label="Source refresh token for FOCI exchange"
                >
                  {refreshTokens.map((r) => {
                    const f = fociByHomeAccount.get(r.homeAccountId);
                    const tag = f?.eligible
                      ? `FOCI: ${f.sourceClient?.name ?? "yes"}`
                      : "non-FOCI";
                    return (
                      <option key={r.homeAccountId} value={r.homeAccountId}>
                        {(r.upn ?? r.oid).slice(0, 48)} ·{" "}
                        {r.clientId.slice(0, 8)}… · {tag}
                      </option>
                    );
                  })}
                </select>
                {fociSource && fociSourceFoci && !fociSourceFoci.eligible && (
                  <Alert variant="warning">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <AlertDescription className="text-2xs">
                      Selected RT was issued by{" "}
                      <code className="font-mono">
                        {fociSource.clientId.slice(0, 8)}…
                      </code>{" "}
                      which is NOT in our FOCI list. AAD will likely reject
                      the exchange with{" "}
                      <code className="font-mono">invalid_grant</code>. The
                      exchange button is enabled anyway — AAD's FOCI list is
                      authoritative, not ours.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </div>

          {/* Scope picker ------------------------------------------- */}
          <div className="flex flex-col gap-1.5">
            <Label className="inline-flex items-center gap-1 text-xs">
              Requested scope *
              <InfoTooltip
                ariaLabel="About the requested scope"
                content="OAuth scope to mint for. Use one of the well-known `.default` scopes for full app-permission tokens. AAD only grants what the original RT was consented for — asking for Graph from a Batch-only RT returns AADSTS65001."
              />
            </Label>
            <Input
              value={fociScope}
              onChange={(e) => setFociScope(e.target.value)}
              placeholder="https://management.azure.com/.default"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
              <span>Quick-fill:</span>
              {(["arm", "graph", "batch", "devops"] as const).map((bucket) => (
                <button
                  key={bucket}
                  type="button"
                  className="rounded border border-border bg-background px-1 py-0.5 font-mono hover:bg-muted"
                  onClick={() => setFociScope(SCOPE_FOR_AUDIENCE[bucket])}
                  title={`${SCOPE_FOR_AUDIENCE[bucket]} — mint a ${bucket.toUpperCase()} token`}
                >
                  {bucket.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Target client list ------------------------------------- */}
          <div className="flex flex-col gap-2">
            <Label className="inline-flex items-center gap-1 text-xs">
              Target FOCI client
              <InfoTooltip
                ariaLabel="About the target FOCI client"
                content="Which FOCI member's identity the new access token will be minted under. The `appid` / `azp` claim on the resulting token will match the chosen target. Resource servers (Graph / ARM / Batch) usually don't care about appid for delegated permissions, but some app-only authorisation policies do — pick a target whose app reg matches your downstream policy. Non-FOCI clients are shown but disabled — use device-code flow for those."
              />
            </Label>
            <div className="max-h-72 overflow-auto rounded-md border border-border bg-background">
              <ul role="radiogroup" className="divide-y divide-border/60">
                {FOCI_CLIENTS.map((c) => {
                  const selected = c.clientId === fociTargetClientId;
                  // Non-FOCI rows are visible but un-selectable — clicking
                  // them would only produce a guaranteed AADSTS54005, so
                  // we gate selection here AND on the action button.
                  const disabled = !c.isFoci;
                  return (
                    <li key={c.clientId}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={disabled || undefined}
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) return;
                          setFociTargetClientId(c.clientId);
                        }}
                        title={
                          disabled
                            ? "Not FOCI-eligible — use device code instead"
                            : undefined
                        }
                        className={
                          "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs transition-colors focus-visible:bg-muted focus-visible:outline-none " +
                          (disabled
                            ? "cursor-not-allowed opacity-60 "
                            : "hover:bg-muted/60 ") +
                          (selected
                            ? "bg-info/10 ring-1 ring-inset ring-info"
                            : "")
                        }
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{c.name}</span>
                          <code className="font-mono text-[10px] text-muted-foreground">
                            {c.clientId.slice(0, 8)}…
                          </code>
                          {selected && (
                            <Badge variant="secondary" className="text-2xs">
                              <Check className="h-3 w-3" /> selected
                            </Badge>
                          )}
                          {c.isFoci ? (
                            <Badge
                              variant="success"
                              className="text-2xs"
                              title="In the FOCI family — refresh-token exchange will be accepted by AAD"
                            >
                              FOCI
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-2xs"
                              title="Not FOCI-eligible — use device code instead"
                            >
                              non-FOCI
                            </Badge>
                          )}
                        </span>
                        {c.description && (
                          <span className="text-2xs text-muted-foreground">
                            {c.description}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          {/* Action row --------------------------------------------- */}
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <Button
              type="button"
              variant="default"
              onClick={() => void runFociExchange()}
              disabled={
                fociExchanging ||
                !fociSource ||
                !fociScope.trim() ||
                !fociTargetClientId
              }
              loading={fociExchanging}
              aria-label="Exchange refresh token for selected FOCI target"
            >
              {!fociExchanging && <Network className="h-4 w-4" />}
              Exchange RT for target
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void runFociBulkMint()}
              disabled={
                fociBulkRunning ||
                !fociSource ||
                !fociScope.trim() ||
                refreshTokens.length === 0
              }
              loading={fociBulkRunning}
              aria-label={`Mint AT for every FOCI-eligible client (${FOCI_CLIENTS.filter((c) => c.isFoci).length} targets)`}
              title="Run the exchange against every FOCI-eligible client in parallel and surface which ones accept the RT. Non-FOCI clients are skipped to avoid spending the RT on guaranteed-failure round-trips."
            >
              {!fociBulkRunning && <Sparkles className="h-4 w-4" />}
              Mint AT for every FOCI client (
              {FOCI_CLIENTS.filter((c) => c.isFoci).length} targets)
            </Button>
            {fociResult && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFociResult(null);
                  setFociBulk(null);
                  setFociError(null);
                }}
              >
                <X className="h-3 w-3" /> Clear results
              </Button>
            )}
          </div>

          {/* Single-exchange error ---------------------------------- */}
          {fociError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              <AlertDescription className="flex flex-col gap-1">
                <span className="text-2xs font-semibold">
                  FOCI exchange failed
                </span>
                <span className="break-all text-2xs">{fociError}</span>
                <span className="text-2xs opacity-80">
                  Common AAD codes: <code className="font-mono">AADSTS54005</code>{" "}
                  = source client isn't in the FOCI family; <code className="font-mono">AADSTS65001</code> =
                  scope was never consented for this RT; <code className="font-mono">AADSTS70000</code> =
                  RT consumed / rotated.
                </span>
              </AlertDescription>
            </Alert>
          )}

          {/* Single-exchange result panel --------------------------- */}
          {fociResult && (
            <div className="flex flex-col gap-2 rounded-md border border-success/30 bg-success/5 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-success" />
                <span className="font-medium text-success">
                  Exchanged successfully
                </span>
                <Badge variant="outline" className="text-2xs">
                  source{" "}
                  <code className="font-mono">
                    {fociResult.sourceClient.slice(0, 8)}…
                  </code>
                </Badge>
                <span className="text-2xs">→</span>
                <Badge variant="secondary" className="text-2xs">
                  target {fociResult.targetClient.name}
                </Badge>
                <Badge variant="outline" className="text-2xs">
                  aud{" "}
                  <code className="font-mono">
                    {fociResult.result.audience.slice(0, 30)}
                    {fociResult.result.audience.length > 30 ? "…" : ""}
                  </code>
                </Badge>
                <Badge variant="secondary" className="text-2xs">
                  <Clock className="h-3 w-3" />{" "}
                  {fociResult.result.expires_in
                    ? `${Math.floor(fociResult.result.expires_in / 60)}m`
                    : "?"}{" "}
                  TTL
                </Badge>
                {fociResult.result.refresh_token && (
                  <Badge variant="warning" className="text-2xs">
                    RT rotated
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton
                  value={fociResult.result.access_token}
                  ariaLabel="Copy minted FOCI access token"
                  alwaysVisible
                />
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  className="h-7 text-2xs"
                  onClick={importFociResultToVault}
                  aria-label="Import minted token into the vault"
                  title="Persist this token (and its rotated RT if any) into the imported-tokens store so other pages can use it."
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Import this token to vault
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-2xs"
                  onClick={() => setFociResultClaimsOpen((o) => !o)}
                  aria-expanded={fociResultClaimsOpen}
                >
                  {fociResultClaimsOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  <Braces className="h-3 w-3" />
                  {fociResultClaimsOpen
                    ? "Hide decoded claims"
                    : "Show decoded claims"}
                </Button>
              </div>
              {fociResultClaimsOpen && (
                <ClaimsGrid claims={fociResult.result.claims} />
              )}
            </div>
          )}

          {/* Bulk-mint results table -------------------------------- */}
          {fociBulk && (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-background/40 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="h-4 w-4 text-info" />
                <span className="font-medium">Bulk-mint results</span>
                <Badge variant="outline" className="text-2xs">
                  {fociBulk.filter((r) => r.status === "success").length} ok
                </Badge>
                <Badge variant="destructive" className="text-2xs">
                  {fociBulk.filter((r) => r.status === "failure").length} fail
                </Badge>
              </div>
              <ul className="flex max-h-80 flex-col gap-0.5 overflow-auto">
                {fociBulk.map((row) => (
                  <li
                    key={row.target.clientId}
                    className="flex flex-wrap items-center gap-2 rounded border border-border/40 bg-background px-2 py-1 text-2xs"
                  >
                    {row.status === "success" ? (
                      <CheckCircle2 className="h-3 w-3 text-success" />
                    ) : row.status === "failure" ? (
                      <X className="h-3 w-3 text-destructive" />
                    ) : (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    )}
                    <span className="font-medium">{row.target.name}</span>
                    <code className="font-mono text-[10px] text-muted-foreground">
                      {row.target.clientId.slice(0, 8)}…
                    </code>
                    {row.status === "success" && (
                      <>
                        <Badge variant="outline" className="text-2xs">
                          aud{" "}
                          <code className="font-mono">
                            {(row.audience ?? "").slice(0, 28)}
                            {(row.audience ?? "").length > 28 ? "…" : ""}
                          </code>
                        </Badge>
                        <Badge variant="secondary" className="text-2xs">
                          <Clock className="h-3 w-3" />{" "}
                          {row.expiresIn
                            ? `${Math.floor(row.expiresIn / 60)}m`
                            : "?"}
                        </Badge>
                      </>
                    )}
                    {row.status === "failure" && (
                      <span
                        className="break-all text-destructive"
                        title={row.error}
                      >
                        {(row.error ?? "").slice(0, 80)}
                        {(row.error ?? "").length > 80 ? "…" : ""}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ----- Scope reverse-lookup card -------------------------------
          "Which FOCI clients grant scope X?" — pure client-side filter
          over the hand-curated FOCI_CLIENT_DEFAULT_SCOPES map. Useful
          when an operator knows the permission they need (e.g.
          Mail.Read.All) but doesn't know which client's RT to harvest.
          Collapsible so it doesn't compete for vertical space when the
          operator's just doing a routine token import. */}
      <Card className="border-secondary/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Search className="h-4 w-4 text-secondary-foreground" />
            Find FOCI clients that grant a scope
            <InfoTooltip
              ariaLabel="About the scope reverse-lookup"
              content="Filter the FOCI catalogue down to clients whose hand-curated default scope set includes the permission you type here. Best-effort — coverage is incomplete; clients we don't have data for render as `(unknown)` rather than `false`."
            />
          </CardTitle>
          <CardDescription>
            Type a Graph permission (e.g.{" "}
            <code className="font-mono">User.Read</code>,{" "}
            <code className="font-mono">Mail.Read</code>,{" "}
            <code className="font-mono">Application.ReadWrite.All</code>) to
            see which FOCI clients grant it by default. Click "Mint AT for
            this client" to jump to the FOCI exchange card with that
            target pre-selected.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="inline-flex items-center gap-1 text-xs">
              Permission / scope name *
              <InfoTooltip
                ariaLabel="About the scope name"
                content="Short permission name as Microsoft documents them (e.g. User.Read). The full Graph URI form (https://graph.microsoft.com/User.Read) is also accepted — we strip the prefix before matching."
              />
            </Label>
            <Input
              value={scopeQuery}
              onChange={(e) => setScopeQuery(e.target.value)}
              placeholder="User.Read"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
              aria-label="Microsoft Graph permission to look up"
            />
            {scopeQuery && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-fit text-2xs"
                onClick={() => setScopeQuery("")}
                aria-label="Clear scope lookup query"
              >
                <X className="h-3 w-3" /> Clear
              </Button>
            )}
          </div>
          {!scopeQuery.trim() && (
            <p className="text-2xs italic text-muted-foreground">
              Type a permission name above to filter the {FOCI_CLIENTS.length}-client catalogue.
            </p>
          )}
          {scopeLookupResults && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-2xs">
                <Badge variant="success" className="text-2xs">
                  {scopeLookupResults.filter((r) => r.grants).length} grant
                </Badge>
                <Badge variant="outline" className="text-2xs">
                  {scopeLookupResults.filter((r) => !r.knownScopes).length} unknown
                </Badge>
                <span className="text-muted-foreground">
                  out of {FOCI_CLIENTS.length} catalogued clients
                </span>
              </div>
              {scopeLookupResults.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No matching clients"
                  description={`None of our catalogued FOCI clients are documented as granting "${scopeQuery.trim()}". Try a related scope (e.g. User.Read instead of User.ReadBasic.All), or check the AAD app registration directly.`}
                  size="compact"
                />
              ) : (
                <ul className="flex max-h-80 flex-col gap-1 overflow-auto">
                  {scopeLookupResults.map((r) => (
                    <li
                      key={r.client.clientId}
                      className="flex flex-wrap items-center gap-2 rounded border border-border/60 bg-background px-2 py-1.5 text-2xs"
                    >
                      <span className="font-medium">{r.client.name}</span>
                      <code className="font-mono text-[10px] text-muted-foreground">
                        {r.client.clientId.slice(0, 8)}…
                      </code>
                      {r.grants ? (
                        <Badge variant="success" className="text-2xs">
                          <Check className="h-3 w-3" /> grants {r.matchedScope}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-2xs"
                          title="We don't have curated default-scope data for this client. The actual app registration may still grant the scope."
                        >
                          (unknown)
                        </Badge>
                      )}
                      {r.client.isFoci ? (
                        <Badge variant="default" className="text-2xs">
                          FOCI
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-2xs">
                          non-FOCI
                        </Badge>
                      )}
                      <span className="ml-auto inline-flex items-center gap-1">
                        <CopyButton
                          value={r.client.clientId}
                          ariaLabel={`Copy client id ${r.client.clientId}`}
                          alwaysVisible
                        />
                        {r.client.isFoci && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1 text-2xs"
                            onClick={() => {
                              setFociTargetClientId(r.client.clientId);
                              const el = document.getElementById(
                                "foci-exchange-card",
                              );
                              if (el) {
                                el.scrollIntoView({
                                  behavior: "smooth",
                                  block: "start",
                                });
                              }
                            }}
                            disabled={refreshTokens.length === 0}
                            title={
                              refreshTokens.length === 0
                                ? "Import a refresh token first to enable minting."
                                : `Pre-select ${r.client.name} as the FOCI exchange target and scroll to the exchange card.`
                            }
                          >
                            <Network className="h-3 w-3" /> Mint AT for this client
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ----- Azure DevOps PAT vault ----------------------------------
          Strictly separate from the Bearer-token vault — these are
          Basic-auth credentials and MUST NOT be mixed into the
          access/refresh-token flow. Storage is sessionStorage (cleared
          on tab close) to bound the blast radius of an accidental
          paste-and-walk-away. */}
      <Card className="border-warning/40 bg-warning/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <GitBranch className="h-4 w-4 text-warning" />
            Azure DevOps PATs (Basic-auth lane)
            <Badge variant="secondary" className="text-2xs">
              {adoPats.length} PAT{adoPats.length === 1 ? "" : "s"}
            </Badge>
            <InfoTooltip
              ariaLabel="About the Azure DevOps PAT vault"
              content="Personal Access Tokens are AzDO-issued opaque credentials used as Basic-auth passwords. They are STRICTLY SEPARATE from the Bearer-token vault: PATs are never mixed into the OAuth flow, and the vault is sessionStorage-backed so closing the tab drops them. Use them only when the AzDO REST endpoint you're targeting doesn't accept AAD bearer tokens."
            />
          </CardTitle>
          <CardDescription>
            Mint a PAT at{" "}
            <a
              href="https://dev.azure.com/_usersSettings/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              dev.azure.com/_usersSettings/tokens
              <ExternalLink className="h-3 w-3" />
            </a>{" "}
            and paste it below. Use the "Copy Basic header" button to grab
            the ready-to-use{" "}
            <code className="font-mono">Authorization: Basic …</code> value
            for your REST call.{" "}
            <strong>
              These are NEVER mixed into the Bearer / refresh-token flow.
            </strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="ado-pat-input"
                className="inline-flex items-center gap-1 text-xs"
              >
                PAT *
                <InfoTooltip
                  ariaLabel="About the Azure DevOps PAT field"
                  content="Paste the raw PAT (40-96 alphanumeric chars). We validate the shape locally and refuse JWTs / random pastes."
                />
              </Label>
              <Input
                id="ado-pat-input"
                value={adoPatInput}
                onChange={(e) => {
                  setAdoPatInput(e.target.value);
                  setAdoPatError(null);
                }}
                placeholder="e.g. 52 alphanumeric chars"
                type="password"
                className="font-mono text-xs"
                aria-label="Paste Azure DevOps Personal Access Token"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="ado-pat-owner"
                className="inline-flex items-center gap-1 text-xs"
              >
                Owner label *
                <InfoTooltip
                  ariaLabel="About the owner label field"
                  content="Free-text label identifying who/what this PAT belongs to (e.g. 'contoso-org/alice'). Used only for the UI — never sent anywhere, never validated."
                />
              </Label>
              <Input
                id="ado-pat-owner"
                value={adoPatOwner}
                onChange={(e) => {
                  setAdoPatOwner(e.target.value);
                  setAdoPatError(null);
                }}
                placeholder="contoso-org/alice"
                className="text-xs"
                aria-label="Owner label for this PAT"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </div>
          {adoPatError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              <AlertDescription className="text-2xs">
                {adoPatError}
              </AlertDescription>
            </Alert>
          )}
          <div>
            <Button
              type="button"
              variant="default"
              onClick={handleAddAdoPat}
              disabled={!adoPatInput.trim() || !adoPatOwner.trim()}
              aria-label="Add Azure DevOps PAT to the vault"
            >
              <Plus className="h-4 w-4" /> Add PAT
            </Button>
          </div>
          {adoPats.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No PATs imported"
              description="Paste a PAT above to add it. PATs live in sessionStorage only — they're dropped when you close the tab."
              size="compact"
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {adoPats.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-border bg-background px-2 py-1.5 text-2xs"
                >
                  <GitBranch className="h-3 w-3 text-warning" />
                  <span className="font-medium">{p.owner}</span>
                  <code
                    className="font-mono text-[10px] text-muted-foreground"
                    title="PAT (masked — only first/last 2 chars shown)"
                  >
                    {maskAdoPat(p.pat)}
                  </code>
                  <span className="text-muted-foreground">
                    added {new Date(p.addedAt).toISOString().slice(0, 16)}
                  </span>
                  <span className="ml-auto inline-flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1 text-2xs"
                      onClick={() => void handleCopyAdoPatBasicHeader(p)}
                      aria-label={`Copy Authorization Basic header for ${p.owner}`}
                      title="Copy the full 'Authorization: Basic <base64>' header value to the clipboard."
                    >
                      <Copy className="h-3 w-3" /> Copy Basic header
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1 text-2xs text-destructive"
                      onClick={() => handleRemoveAdoPat(p)}
                      aria-label={`Remove PAT for ${p.owner}`}
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ----- Existing imports ------------------------------------- */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="h-4 w-4 text-primary" />
              Currently imported
              <Badge variant="secondary" className="text-2xs">
                {accounts.length} account{accounts.length === 1 ? "" : "s"}
              </Badge>
            </CardTitle>
            <CardDescription>
              Imported tokens override MSAL for ARM / Graph / Batch calls
              while they're still inside their <code className="font-mono">exp</code> window.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {allTokens.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setMaskTokens((m) => !m)}
                aria-label={maskTokens ? "Reveal token values" : "Hide token values"}
                title={
                  maskTokens
                    ? "Reveal token values (raw JWT / RT). Sensitive — only do this when nothing's being recorded."
                    : "Mask token values for screen-sharing safety."
                }
              >
                {maskTokens ? (
                  <>
                    <EyeOff className="h-3 w-3" /> Hidden
                  </>
                ) : (
                  <>
                    <Eye className="h-3 w-3" /> Visible
                  </>
                )}
              </Button>
            )}
            {stats.expired > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-warning"
                onClick={handleDropExpired}
                aria-label={`Drop ${stats.expired} expired tokens`}
              >
                <Trash2 className="h-3 w-3" /> Drop expired ({stats.expired})
              </Button>
            )}
            {accounts.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive"
                onClick={handleClearAll}
                aria-label="Drop all imported tokens"
              >
                <Trash2 className="h-3 w-3" /> Drop all
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* At-a-glance stats above the list — clickable to filter. */}
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Imported token summary"
          >
            <SummaryStatItem
              label="Access tokens"
              value={stats.accessTokens}
              hint={
                audienceFilter == null
                  ? "All audiences"
                  : `Filter: ${audienceFilter}`
              }
              compact
              onClick={
                audienceFilter == null
                  ? undefined
                  : () => setAudienceFilter(null)
              }
              ariaLabel={
                audienceFilter == null
                  ? `Access tokens ${stats.accessTokens}`
                  : `Clear filter (currently showing ${audienceFilter})`
              }
            />
            <SummaryStatItem
              label="Refresh tokens"
              value={stats.refreshTokens}
              tone="info"
              compact
            />
            <SummaryStatItem
              label="ARM"
              value={stats.perAudience.arm}
              tone="info"
              compact
              onClick={() =>
                setAudienceFilter((f) => (f === "arm" ? null : "arm"))
              }
              className={
                audienceFilter === "arm"
                  ? "ring-2 ring-info ring-offset-1 ring-offset-background"
                  : undefined
              }
              ariaLabel={`Filter by ARM (${stats.perAudience.arm} tokens)`}
            />
            <SummaryStatItem
              label="Graph"
              value={stats.perAudience.graph}
              tone="info"
              compact
              onClick={() =>
                setAudienceFilter((f) => (f === "graph" ? null : "graph"))
              }
              className={
                audienceFilter === "graph"
                  ? "ring-2 ring-info ring-offset-1 ring-offset-background"
                  : undefined
              }
              ariaLabel={`Filter by Graph (${stats.perAudience.graph} tokens)`}
            />
            <SummaryStatItem
              label="Batch"
              value={stats.perAudience.batch}
              tone="info"
              compact
              onClick={() =>
                setAudienceFilter((f) => (f === "batch" ? null : "batch"))
              }
              className={
                audienceFilter === "batch"
                  ? "ring-2 ring-info ring-offset-1 ring-offset-background"
                  : undefined
              }
              ariaLabel={`Filter by Batch (${stats.perAudience.batch} tokens)`}
            />
            <SummaryStatItem
              label="DevOps"
              value={stats.perAudience.devops}
              tone="info"
              compact
              onClick={() =>
                setAudienceFilter((f) => (f === "devops" ? null : "devops"))
              }
              className={
                audienceFilter === "devops"
                  ? "ring-2 ring-info ring-offset-1 ring-offset-background"
                  : undefined
              }
              ariaLabel={`Filter by DevOps (${stats.perAudience.devops} tokens)`}
            />
            <SummaryStatItem
              label="Expires < 5m"
              value={stats.expiringSoon}
              tone={stats.expiringSoon > 0 ? "warning" : "muted"}
              compact
              onClick={
                stats.expiringSoon > 0
                  ? () =>
                      setAudienceFilter((f) =>
                        f === "expiring" ? null : "expiring",
                      )
                  : undefined
              }
              className={
                audienceFilter === "expiring"
                  ? "ring-2 ring-warning ring-offset-1 ring-offset-background"
                  : undefined
              }
              ariaLabel={`Filter by expiring (${stats.expiringSoon} tokens)`}
            />
            <SummaryStatItem
              label="Expired"
              value={stats.expired}
              tone={stats.expired > 0 ? "destructive" : "muted"}
              compact
              onClick={
                stats.expired > 0
                  ? () =>
                      setAudienceFilter((f) =>
                        f === "expired" ? null : "expired",
                      )
                  : undefined
              }
              className={
                audienceFilter === "expired"
                  ? "ring-2 ring-destructive ring-offset-1 ring-offset-background"
                  : undefined
              }
              ariaLabel={`Filter by expired (${stats.expired} tokens)`}
            />
          </div>
          {audienceFilter && (
            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <span>
                Filtered by{" "}
                <Badge variant="outline" className="text-2xs">
                  {audienceFilter}
                </Badge>{" "}
                ({filteredAccounts.length} / {accounts.length} accounts)
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-2xs"
                onClick={() => setAudienceFilter(null)}
              >
                <X className="h-3 w-3" /> Clear chip filter
              </Button>
            </div>
          )}

          {/* Filter + export toolbar (hidden when there's nothing to
              filter — keeps the empty card uncluttered). */}
          {accounts.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, upn, oid, tenant, audience…"
                  className="h-8 pl-7 pr-7 text-xs"
                  aria-label="Filter imported tokens"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <span className="text-2xs text-muted-foreground">
                {filteredAccounts.length} / {accounts.length}
              </span>
              <ExportMenu
                rows={exportRows}
                columns={exportColumns}
                filename="imported-tokens"
                label="Export"
                jsonMetadata={{
                  source: "token-importer",
                  filtered:
                    search.trim().length > 0 || audienceFilter != null,
                  filterQuery: search.trim() || null,
                  audienceFilter,
                  totalAccounts: accounts.length,
                  totalAccessTokens: stats.accessTokens,
                  totalRefreshTokens: stats.refreshTokens,
                }}
              />
            </div>
          )}

          {accounts.length === 0 ? (
            <EmptyState
              icon={Key}
              title="No tokens imported yet"
              description="Paste a JWT into the access-token form above, paste multiple JWTs into the bulk-import card, or use the refresh-token form to mint tokens on demand. Imported tokens override MSAL for ARM / Graph / Batch calls."
              size="compact"
              action={{
                label: "Open audience-matrix to see what these tokens unlock",
                icon: Network,
                onClick: () => {
                  // Path-based navigation — the canonical wiring
                  // contract. Audit-log the navigation so operators have
                  // a breadcrumb back to where they pivoted.
                  auditLog.record({
                    actor: "operator",
                    action: "token_importer_pivot",
                    target: "/audience-matrix",
                    status: "success",
                    details: { reason: "empty-state-cta" },
                  });
                  navigateToPage("/audience-matrix");
                },
              }}
            />
          ) : filteredAccounts.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No imported tokens match this filter"
              description={
                audienceFilter
                  ? `No imported account has a ${audienceFilter} token matching your search.`
                  : "Clear the search box to see every imported account, or try a different query."
              }
              size="compact"
              action={{
                label: "Clear all filters",
                onClick: () => {
                  setSearch("");
                  setAudienceFilter(null);
                },
              }}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {filteredAccounts.map((a) => (
                <TokenAccountRow
                  key={a.homeAccountId}
                  account={a}
                  tokens={allTokens.filter(
                    (t) => t.homeAccountId === a.homeAccountId,
                  )}
                  refreshEntry={refreshTokens.find(
                    (r) => r.homeAccountId === a.homeAccountId,
                  )}
                  fociInfo={fociByHomeAccount.get(a.homeAccountId)}
                  maskTokens={maskTokens}
                  revealed={revealed}
                  expandedClaims={expandedClaims}
                  toggleRevealed={toggleRevealed}
                  toggleClaims={toggleClaims}
                  onRemoveAccount={handleRemoveAccount}
                  onRemoveRefresh={handleRemoveRefresh}
                  onRemoveAudience={handleRemoveAudience}
                  onReMint={reMintFromRt}
                  onUseInFociExchange={(e) => {
                    setFociSourceAccountId(e.homeAccountId);
                    const el = document.getElementById("foci-exchange-card");
                    if (el) {
                      el.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      });
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Single shared confirmation dialog used by drop-refresh,
          drop-account, drop-expired, and drop-all paths. */}
      <ConfirmationDialog danger {...confirmDialogProps} />

      {/* ----- Caveats ----------------------------------------------- */}
      <Alert>
        <AlertTriangle className="h-3.5 w-3.5" />
        <AlertDescription className="text-2xs">
          <strong>Trust caveat:</strong> imported tokens give this browser
          tab the same Azure rights as the original session. Treat them
          like a password — never paste into a machine you don't trust,
          use the &quot;Hidden&quot; toggle when screen-sharing, and use{" "}
          &quot;Drop account&quot; when you're done. Tokens persist in this
          browser's localStorage until you remove them or they expire.
          Refresh tokens do NOT carry a client-side expiry; AAD revokes
          them server-side after 90 days idle (sliding window).
        </AlertDescription>
      </Alert>
    </div>
  );
};

/* ---- Audience-ordered list of tokens for one account row. Extracted
 * into a component so the keyboard-toggle / reveal-mask state is
 * scoped per row and we don't re-render the world on every keystroke
 * inside another row. */
interface TokenAccountRowProps {
  account: ImportedAccountSummary;
  tokens: readonly ImportedTokenEntry[];
  refreshEntry: ImportedRefreshTokenEntry | undefined;
  /** FOCI eligibility for this row's RT (if any). */
  fociInfo?: ReturnType<typeof detectFociEligibility>;
  maskTokens: boolean;
  revealed: Record<string, boolean>;
  expandedClaims: Record<string, boolean>;
  toggleRevealed: (key: string) => void;
  toggleClaims: (key: string) => void;
  onRemoveAccount: (a: ImportedAccountSummary) => void;
  onRemoveRefresh: (e: ImportedRefreshTokenEntry) => void;
  onRemoveAudience: (
    homeAccountId: string,
    audience: AudienceBucket,
  ) => void;
  onReMint: (e: ImportedRefreshTokenEntry) => void | Promise<void>;
  /** Jump to the FOCI exchange card with this RT pre-selected. */
  onUseInFociExchange?: (e: ImportedRefreshTokenEntry) => void;
}

const TokenAccountRow: React.FC<TokenAccountRowProps> = ({
  account: a,
  tokens,
  refreshEntry: rtEntry,
  fociInfo,
  maskTokens,
  revealed,
  expandedClaims,
  toggleRevealed,
  toggleClaims,
  onRemoveAccount,
  onRemoveRefresh,
  onRemoveAudience,
  onReMint,
  onUseInFociExchange,
}) => {
  // Sort tokens by audience so ARM is always first, then Graph, Batch,
  // DevOps, unknown. Stable ordering helps the operator's eye.
  const orderedTokens = React.useMemo(() => {
    const idx: Record<AudienceBucket, number> = {
      arm: 0,
      graph: 1,
      batch: 2,
      devops: 3,
      unknown: 4,
    };
    return [...tokens].sort(
      (x, y) => (idx[x.audience] ?? 9) - (idx[y.audience] ?? 9),
    );
  }, [tokens]);

  const [reMinting, setReMinting] = React.useState(false);
  const handleReMint = React.useCallback(async () => {
    if (!rtEntry) return;
    setReMinting(true);
    try {
      await onReMint(rtEntry);
    } finally {
      setReMinting(false);
    }
  }, [rtEntry, onReMint]);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <User className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{a.name ?? a.upn ?? a.oid}</span>
        {a.upn && a.upn !== a.name && (
          <span className="text-2xs text-muted-foreground">{a.upn}</span>
        )}
        <Badge
          variant="outline"
          className="inline-flex items-center gap-1 text-2xs"
          title={`Tenant id ${a.tenantId}`}
        >
          tenant{" "}
          <CopyableText
            value={a.tenantId ?? ""}
            display={`${(a.tenantId ?? "").slice(0, 8)}…`}
            mono
            ariaLabel={`Copy tenant id ${a.tenantId ?? ""}`}
          />
        </Badge>
        <span
          className="text-2xs text-muted-foreground"
          title={`homeAccountId — synthetic ${"<oid>.<tid>"} pair MSAL uses to dedupe principals`}
        >
          <CopyableText
            value={a.homeAccountId ?? ""}
            display={`acct ${(a.homeAccountId ?? "").slice(0, 10)}…`}
            mono
            ariaLabel={`Copy home account id ${a.homeAccountId ?? ""}`}
          />
        </span>
        {rtEntry && (
          <Badge
            variant="secondary"
            className="inline-flex items-center gap-1 text-2xs"
            title={`Refresh token issued for client ${rtEntry.clientId}`}
          >
            <KeyRound className="h-3 w-3" /> RT
          </Badge>
        )}
        {rtEntry && fociInfo && (
          <Badge
            variant={fociInfo.eligible ? "default" : "outline"}
            className="inline-flex items-center gap-1 text-2xs"
            title={
              fociInfo.eligible
                ? `RT was issued by ${fociInfo.sourceClient?.name ?? "a FOCI client"} — can be exchanged for any other FOCI member.`
                : "RT's issuer is not in our FOCI list — exchange to a different client will likely fail."
            }
          >
            <Users className="h-3 w-3" />
            {fociInfo.eligible
              ? `FOCI: ${fociInfo.sourceClient?.name ?? "yes"}`
              : "Not FOCI"}
          </Badge>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {rtEntry && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-2xs"
                onClick={() => void handleReMint()}
                disabled={reMinting}
                loading={reMinting}
                aria-label={`Re-mint ARM access token for ${a.upn ?? a.oid}`}
                title="Re-mint ARM access token from the stored refresh token (also rotates the RT if AAD returns a new one)."
              >
                {!reMinting && <RotateCw className="h-3 w-3" />}
                Re-mint ARM
              </Button>
              {onUseInFociExchange && fociInfo?.eligible && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-2xs"
                  onClick={() => onUseInFociExchange(rtEntry)}
                  aria-label={`Use refresh token for ${a.upn ?? a.oid} in FOCI exchange`}
                  title="Pre-select this RT in the FOCI exchange card above and scroll there."
                >
                  <Users className="h-3 w-3" /> FOCI exchange
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-2xs text-destructive"
                onClick={() => onRemoveRefresh(rtEntry)}
                aria-label={`Drop refresh token for ${a.upn ?? a.oid}`}
              >
                <Trash2 className="h-3 w-3" /> Drop RT
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-2xs text-destructive"
            onClick={() => onRemoveAccount(a)}
            aria-label={`Drop imported tokens for ${a.upn ?? a.oid}`}
          >
            <Trash2 className="h-3 w-3" /> Drop account
          </Button>
        </span>
      </div>
      {rtEntry && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-success/20 bg-success/5 px-2 py-1 text-2xs">
          <KeyRound className="h-3 w-3 text-success" />
          <span className="font-medium text-success">Refresh token</span>
          <span className="text-muted-foreground">
            client <code className="font-mono">{rtEntry.clientId.slice(0, 8)}…</code>
          </span>
          <span className="text-muted-foreground">
            imported {rtEntry.importedAt.slice(0, 16)}
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <code className="font-mono text-[10px] text-muted-foreground">
              {revealed[`rt:${rtEntry.homeAccountId}`] && !maskTokens
                ? rtEntry.refreshToken.slice(0, 32) + "…"
                : maskToken(rtEntry.refreshToken)}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 px-1 text-2xs"
              onClick={() => toggleRevealed(`rt:${rtEntry.homeAccountId}`)}
              aria-label={
                revealed[`rt:${rtEntry.homeAccountId}`]
                  ? "Mask refresh token"
                  : "Reveal start of refresh token"
              }
              disabled={maskTokens}
              title={
                maskTokens
                  ? "Disabled while master 'Hidden' toggle is active"
                  : revealed[`rt:${rtEntry.homeAccountId}`]
                    ? "Mask"
                    : "Reveal start"
              }
            >
              {revealed[`rt:${rtEntry.homeAccountId}`] ? (
                <EyeOff className="h-3 w-3" />
              ) : (
                <Eye className="h-3 w-3" />
              )}
            </Button>
            <CopyButton
              value={rtEntry.refreshToken}
              ariaLabel={`Copy raw refresh token for ${a.upn ?? a.oid}`}
              alwaysVisible
            />
          </span>
        </div>
      )}
      <ul className="flex flex-col gap-1 pl-5">
        {orderedTokens.length === 0 && (
          <li className="text-2xs italic text-muted-foreground">
            No cached access tokens — they'll be minted on demand via the
            refresh token.
          </li>
        )}
        {orderedTokens.map((t) => {
          const Icon =
            t.audience === "graph"
              ? Shield
              : t.audience === "batch"
                ? Server
                : t.audience === "arm"
                  ? Eye
                  : t.audience === "devops"
                    ? GitBranch
                    : AlertTriangle;
          // Decode the JWT once per row so we can pull the amr claim
          // for the passwordless / MFA / Hello badges without re-doing
          // the work in the claims-grid render path below.
          const tokenClaims = decodeJwtPayload(t.accessToken);
          const amrBadges = extractAmrBadges(tokenClaims);
          const now = Math.floor(Date.now() / 1000);
          const isExpired = t.expiresAt > 0 && t.expiresAt < now;
          const isExpiringSoon =
            t.expiresAt > 0 &&
            !isExpired &&
            t.expiresAt < now + 5 * 60;
          const key = `${t.homeAccountId}|${t.audience}`;
          const isRevealed = !!revealed[key] && !maskTokens;
          const claimsOpen = !!expandedClaims[key];
          return (
            <li
              key={key}
              className="flex flex-col gap-1 rounded border border-transparent hover:border-border/60"
            >
              <div className="flex flex-wrap items-center gap-2 text-2xs">
                <Icon
                  className={
                    isExpired
                      ? "h-3 w-3 text-destructive"
                      : "h-3 w-3 text-muted-foreground"
                  }
                />
                <span
                  className="font-medium"
                  title={AUDIENCE_HINT[t.audience]}
                >
                  {AUDIENCE_SHORT[t.audience]}
                </span>
                <CopyableText
                  value={t.rawAudience ?? ""}
                  display={
                    <code className="font-mono text-[10px] text-muted-foreground">
                      aud {(t.rawAudience ?? "").slice(0, 22)}
                      {(t.rawAudience ?? "").length > 22 ? "…" : ""}
                    </code>
                  }
                  ariaLabel={`Copy raw audience ${t.rawAudience}`}
                />
                <Badge
                  variant={
                    isExpired
                      ? "destructive"
                      : isExpiringSoon
                        ? "warning"
                        : "secondary"
                  }
                  className="text-2xs"
                >
                  <Clock className="h-3 w-3" />{" "}
                  {fmtExpiresIn(t.expiresAt)}
                </Badge>
                {/* NGC / passwordless / Windows Hello / MFA badges
                    derived from the token's `amr` claim. Useful at a
                    glance for spotting whether a token carries
                    strong-auth assertions (some downstream policies
                    only accept passwordless / MFA tokens). */}
                {amrBadges.map((meta) => {
                  const MetaIcon = meta.Icon;
                  return (
                    <Badge
                      key={`${key}-amr-${meta.label}`}
                      variant={meta.variant}
                      className="inline-flex items-center gap-1 text-2xs"
                      title={meta.tooltip}
                    >
                      <MetaIcon className="h-3 w-3" />
                      {meta.label}
                    </Badge>
                  );
                })}
                <span
                  className="font-mono text-[10px] text-muted-foreground"
                  title={`Imported at ${t.importedAt}`}
                >
                  imported {t.importedAt.slice(0, 16)}
                </span>
                <span className="ml-auto inline-flex items-center gap-1">
                  <code className="font-mono text-[10px] text-muted-foreground">
                    {isRevealed
                      ? t.accessToken.slice(0, 32) + "…"
                      : maskToken(t.accessToken)}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1 text-2xs"
                    onClick={() => toggleRevealed(key)}
                    aria-label={
                      isRevealed ? "Mask access token" : "Reveal start of access token"
                    }
                    disabled={maskTokens}
                    title={
                      maskTokens
                        ? "Disabled while master 'Hidden' toggle is active"
                        : isRevealed
                          ? "Mask"
                          : "Reveal start"
                    }
                  >
                    {isRevealed ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                  </Button>
                  <CopyButton
                    value={t.accessToken}
                    ariaLabel={`Copy raw bearer token for ${AUDIENCE_LABELS[t.audience]}`}
                    alwaysVisible
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1 text-2xs"
                    onClick={() => toggleClaims(key)}
                    aria-expanded={claimsOpen}
                    aria-label={
                      claimsOpen ? "Hide claims" : "Show JWT claims"
                    }
                    title={
                      claimsOpen
                        ? "Hide decoded claims"
                        : "Show decoded JWT claims"
                    }
                  >
                    <Braces className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1 text-2xs text-destructive"
                    onClick={() =>
                      onRemoveAudience(t.homeAccountId, t.audience)
                    }
                    aria-label={`Drop ${AUDIENCE_LABELS[t.audience]} token for ${a.upn ?? a.oid}`}
                  >
                    Drop
                  </Button>
                </span>
              </div>
              {claimsOpen && (
                <div className="ml-5">
                  <ClaimsGrid
                    claims={tokenClaims ?? {}}
                    maxHeight="18rem"
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
};

/* ============================================================================
 * Decoded-JWT claim grid
 * ============================================================================
 * Two-column grid that renders a JWT's decoded claim payload with:
 *   - InfoTooltip explanation per known claim (from CLAIM_EXPLAIN).
 *   - Color-coded tone: admin role wids → warning, missing oid → destructive,
 *     freshly-issued (iat within last 60s) → success.
 *   - Copy-on-click for every claim value.
 *   - "Show raw JSON" fallback for unknown claims the operator pasted.
 * ============================================================================ */
interface ClaimsGridProps {
  claims: Record<string, unknown> | null | undefined;
  /** Optional max height for the grid container. Defaults to 24rem. */
  maxHeight?: string;
}

const ClaimsGrid: React.FC<ClaimsGridProps> = ({
  claims,
  maxHeight = "24rem",
}) => {
  const admin = React.useMemo(() => detectAdminRoles(claims), [claims]);
  const foci = React.useMemo(() => detectFociEligibility(claims), [claims]);
  const issuedAt = typeof claims?.iat === "number" ? (claims.iat as number) : 0;
  const isFresh =
    issuedAt > 0 && Math.floor(Date.now() / 1000) - issuedAt < 60;
  const hasOid =
    !!claims && (typeof claims.oid === "string" || typeof claims.sub === "string");
  if (!claims) {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-2 text-2xs italic text-muted-foreground">
        No claims to decode.
      </div>
    );
  }
  // Sort known claims first (in CLAIM_EXPLAIN insertion order), then the
  // rest alphabetically. Operator's eye expects oid / tid first.
  const knownOrder = Object.keys(CLAIM_EXPLAIN);
  const entries = Object.entries(claims).sort(([a], [b]) => {
    const ai = knownOrder.indexOf(a);
    const bi = knownOrder.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });
  return (
    <div className="flex flex-col gap-2">
      {/* At-a-glance flags row */}
      <div className="flex flex-wrap items-center gap-1">
        {admin.isAdmin && (
          <Badge
            variant="warning"
            className="text-2xs"
            title={`Privileged directory roles via wids: ${admin.roles.join(", ")}`}
          >
            <Shield className="h-3 w-3" /> admin: {admin.roles[0]}
            {admin.roles.length > 1 ? ` +${admin.roles.length - 1}` : ""}
          </Badge>
        )}
        {!hasOid && (
          <Badge
            variant="destructive"
            className="text-2xs"
            title="Token has no oid / sub claim — not a user-bound token. Likely a malformed paste or a non-AAD JWT."
          >
            no oid
          </Badge>
        )}
        {isFresh && (
          <Badge
            variant="default"
            className="text-2xs"
            title={`Issued ${Math.floor(Date.now() / 1000) - issuedAt}s ago — fresh from AAD.`}
          >
            <Sparkles className="h-3 w-3" /> just issued
          </Badge>
        )}
        {foci.eligible && foci.sourceClient && (
          <Badge
            variant="secondary"
            className="text-2xs"
            title={`appid / azp matches the FOCI client ${foci.sourceClient.name}. Its refresh token can be exchanged for any other FOCI member.`}
          >
            <Users className="h-3 w-3" /> FOCI: {foci.sourceClient.name}
          </Badge>
        )}
        {!foci.eligible &&
          (typeof claims.azp === "string" ||
            typeof claims.appid === "string") && (
            <Badge
              variant="outline"
              className="text-2xs"
              title="The appid / azp claim is not in our curated FOCI list — refresh-token exchange to another client will likely fail."
            >
              <Users className="h-3 w-3" /> Not FOCI
            </Badge>
          )}
      </div>

      <div
        className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 overflow-auto rounded-md border border-border bg-background/50 p-2 text-[10px]"
        style={{ maxHeight }}
      >
        {entries.map(([name, value]) => {
          const explain = CLAIM_EXPLAIN[name];
          const isAdminWid = name === "wids" && admin.isAdmin;
          const isExpClaim = name === "exp" || name === "nbf" || name === "iat";
          const formatted = formatClaimValue(name, value);
          return (
            <React.Fragment key={name}>
              <dt
                className={
                  "inline-flex items-center gap-1 font-mono " +
                  (isAdminWid
                    ? "text-warning"
                    : !hasOid && name === "oid"
                      ? "text-destructive"
                      : isFresh && isExpClaim
                        ? "text-success"
                        : "text-muted-foreground")
                }
              >
                {name}
                {explain && (
                  <InfoTooltip
                    ariaLabel={`About the ${name} claim`}
                    content={explain}
                    size={11}
                  />
                )}
              </dt>
              <dd className="break-all">
                <CopyableText
                  value={formatted}
                  mono
                  ariaLabel={`Copy ${name} claim value`}
                />
              </dd>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

// Re-export icons we imported but don't always reference inline, so the
// linter doesn't complain when the design later surfaces them.
export const _TokenImporterIcons = { Loader2, AUDIENCE_ORDER };
