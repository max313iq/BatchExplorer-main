import { __awaiter } from "tslib";
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
import { AlertTriangle, Braces, Check, CheckCircle2, ChevronDown, ChevronRight, ClipboardPaste, Clock, Copy, ExternalLink, Eye, EyeOff, Fingerprint, GitBranch, Key, KeyRound, Loader2, Lock, Network, Plus, RotateCw, Search, Server, Shield, ShieldCheck, Sparkles, Trash2, User, Users, X, Zap, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addAdoPat, classifyAudience, clearImportedTokens, decodeJwtPayload, getAdoPatAsBasicHeader, importRefreshToken, importToken, isLikelyAdoPat, listAdoPats, listImportedAccounts, listImportedTokens, listRefreshTokenEntries, previewToken, redeemRefreshToken, removeAdoPat, removeImportedAccount, removeImportedAudience, removeRefreshToken, SCOPE_FOR_AUDIENCE, } from "../../auth/imported-tokens";
import { detectFociEligibility, exchangeRefreshTokenForClient, FociExchangeError, FOCI_CLIENT_DEFAULT_SCOPES, FOCI_CLIENTS, } from "../../auth/foci-exchange";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useDashboardOutletContext } from "../page-router";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText, CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
const PORTAL_SNIPPET = String.raw `(() => {
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
const AUDIENCE_LABELS = {
    arm: "ARM (management.azure.com)",
    graph: "Microsoft Graph",
    batch: "Azure Batch",
    devops: "Azure DevOps",
    unknown: "Unknown audience",
};
const AUDIENCE_SHORT = {
    arm: "ARM",
    graph: "Graph",
    batch: "Batch",
    devops: "DevOps",
    unknown: "?",
};
const AUDIENCE_HINT = {
    arm: "Azure Resource Manager — subscriptions, resource groups, deployments, role assignments, billing.",
    graph: "Microsoft Graph — users, groups, directory roles, sign-in events, M365 metadata.",
    batch: "Azure Batch data plane — pools, jobs, tasks, nodes inside a Batch account. Distinct from ARM's Batch resource-manager surface.",
    devops: "Azure DevOps Services — Repos, Pipelines, Boards, Artifacts. aud = 499b84ac-1321-427f-aa17-267ca6975798 (or *.dev.azure.com / *.visualstudio.com on legacy v1 tokens).",
    unknown: "The token's audience does not match any of the buckets this WebUI routes on (ARM, Graph, Batch, DevOps). It will not be picked up automatically by any page.",
};
const AUDIENCE_ORDER = [
    "arm",
    "graph",
    "batch",
    "devops",
    "unknown",
];
const AMR_METHOD_META = Object.freeze({
    ngcmfa: {
        label: "Passwordless",
        tooltip: "amr=ngcmfa — Next Generation Credential / passwordless MFA (Windows Hello for Business or Microsoft Authenticator phone sign-in). Token carries strong-auth claims; equivalent to MFA + device-bound.",
        Icon: Fingerprint,
        variant: "success",
    },
    fido: {
        label: "Passwordless",
        tooltip: "amr=fido — FIDO2 / WebAuthn security key (YubiKey / platform authenticator). Strongest user-presence assertion AAD supports.",
        Icon: Fingerprint,
        variant: "success",
    },
    mfa: {
        label: "MFA",
        tooltip: "amr=mfa — Multi-factor authentication was completed during this sign-in. Combined with another factor (phone app, SMS, voice, OATH OTP).",
        Icon: ShieldCheck,
        variant: "info",
    },
    wia: {
        label: "Windows Hello",
        tooltip: "amr=wia — Windows Integrated Authentication / Windows Hello biometric or PIN unlock on a hybrid-joined / AAD-joined machine.",
        Icon: ShieldCheck,
        variant: "info",
    },
    hwk: {
        label: "Hardware key",
        tooltip: "amr=hwk — Hardware-bound key (TPM / Secure Enclave). Common with managed devices using a certificate or PRT-bound credential.",
        Icon: Lock,
        variant: "secondary",
    },
    pwd: {
        label: "Password",
        tooltip: "amr=pwd — Username + password sign-in. Weakest factor; should be combined with MFA for elevated audiences.",
        Icon: Lock,
        variant: "warning",
    },
    rsa: {
        label: "RSA",
        tooltip: "amr=rsa — RSA-encrypted assertion (smart card / certificate / federation).",
        Icon: Lock,
        variant: "secondary",
    },
    otp: {
        label: "OTP",
        tooltip: "amr=otp — One-time password (TOTP / HOTP via authenticator app or hardware token).",
        Icon: Lock,
        variant: "secondary",
    },
    sms: {
        label: "SMS",
        tooltip: "amr=sms — SMS one-time code. Weakest MFA factor; NIST recommends against in high-security contexts.",
        Icon: Lock,
        variant: "warning",
    },
    pop: {
        label: "Proof of Possession",
        tooltip: "amr=pop — Proof-of-possession token binding. Resource server cryptographically validates the caller holds the private key.",
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
function extractAmrBadges(claims) {
    if (!claims)
        return [];
    const raw = claims.amr;
    if (!Array.isArray(raw))
        return [];
    const seen = new Set();
    const out = [];
    for (const v of raw) {
        if (typeof v !== "string")
            continue;
        const key = v.toLowerCase();
        if (seen.has(key))
            continue;
        const meta = AMR_METHOD_META[key];
        if (!meta)
            continue;
        seen.add(key);
        out.push(meta);
    }
    return out;
}
/** Mask a PAT for screen-share-safe display. Shows the first 2 + last 2
 *  chars of the value with `…` between, regardless of length. */
function maskAdoPat(pat) {
    if (!pat)
        return "";
    if (pat.length <= 6)
        return "•".repeat(pat.length);
    return `${pat.slice(0, 2)}${"•".repeat(8)}${pat.slice(-2)}`;
}
/**
 * Human-readable explanation for each JWT claim the operator might see in
 * a decoded token. Surfaced as `InfoTooltip` content in the upgraded claim
 * grid. Sourced from RFC 7519, RFC 9068 (OAuth JWT profile), and Microsoft
 * identity-platform documentation. ROADtools surfaces the same set in its
 * `roadtx describe` output.
 */
const CLAIM_EXPLAIN = Object.freeze({
    oid: "AAD object id of the principal (user, SP, or managed identity). Combined with tid uniquely identifies the principal across all of Azure.",
    tid: "AAD tenant id where the principal lives. Cross-tenant calls work but the token's tenant determines which directory's RBAC applies.",
    aud: "Audience — the resource server the token is valid for. Pages route on canonical buckets (ARM / Graph / Batch) derived from this.",
    scp: "OAuth scope(s) consented to. Each space-separated value is one permission the token can exercise (delegated permissions).",
    scope: "Same as scp — granted scope as a single string (used on some OIDC tokens and on the v2 token endpoint response).",
    appid: "Client app id that requested the token (v1 token format). Must match the client_id used at any subsequent refresh-token redemption.",
    azp: "Authorised party (RFC 7519) — same role as appid but on v2 tokens. Cross-check against FOCI list to determine refresh-token family eligibility.",
    app_displayname: "Friendly name of the client app, as registered in AAD. Diagnostic only — display name can be changed by app owners.",
    roles: "Application roles assigned to the principal in the resource app's manifest. Distinct from directory roles (wids).",
    wids: "Well-known directory role ids assigned to the principal — e.g. 62e90394-69f5-4237-9190-012177145e10 is Global Administrator. Presence of any wid grants tenant-wide admin powers.",
    family_name: "Family name / surname from the user's AAD profile. Personally identifying — handle carefully.",
    given_name: "Given name / first name from the user's AAD profile. Personally identifying.",
    ipaddr: "Source IP address the token was issued from. Useful for tracking suspicious sessions; absent on most app-only tokens.",
    xms_cc: "Microsoft-internal client capability list — e.g. CP1 means the client supports CAE (Continuous Access Evaluation) and can handle 401 + token-binding challenges mid-session.",
    xms_pl: "Microsoft-internal preferred language hint for the principal. Used by AAD for localised error messages.",
    name: "Human-readable display name of the principal.",
    unique_name: "Legacy v1-token UPN-equivalent. Roughly equivalent to preferred_username on v2 tokens.",
    upn: "User Principal Name — the user's sign-in identifier (usually email-shaped). Stable across the user's lifetime.",
    preferred_username: "v2-token equivalent of upn — what the user prefers to be addressed as in UIs.",
    ver: "Token version — 1.0 (legacy / v1 endpoint) or 2.0 (v2 endpoint). Some claims differ between the two (e.g. appid vs azp).",
    iat: "Issued-at time (epoch seconds). When AAD minted the token.",
    nbf: "Not-before time (epoch seconds). Token MUST be rejected before this instant — usually equal to iat.",
    exp: "Expiration time (epoch seconds). Token MUST be rejected after this instant.",
    iss: "Issuer — the AAD endpoint that minted the token (e.g. https://sts.windows.net/{tid}/ for v1, https://login.microsoftonline.com/{tid}/v2.0 for v2).",
    sub: "Subject — pairwise identifier for the principal. Stable per (audience, principal) pair; do not use as a global user id (use oid instead).",
    acr: "Authentication Context Class Reference — 0 = single-factor, 1 = MFA. Useful for step-up checks.",
    amr: "Authentication Methods References — array of how the user authenticated (pwd / mfa / pop / wia / fido). Diagnostic for audit trails.",
    groups: "Group membership claim — array of AAD group object ids the principal belongs to. May be a hash overage if too many groups (then call /me/getMemberObjects).",
    hasgroups: "True when the groups claim was omitted due to overage. Call /me/getMemberObjects to enumerate.",
    idtyp: "Identity type — 'app' for app-only tokens (client credentials), 'user' for delegated.",
    rh: "Refresh token hash — Microsoft-internal; not useful externally.",
    uti: "Unique token identifier — Microsoft-internal correlation id for support tickets.",
    onprem_sid: "On-prem Active Directory SID for hybrid-joined principals (sync'd from on-prem AD).",
});
/**
 * Well-known AAD directory role ids that grant broad administrative power.
 * If `wids` contains ANY of these, the UI badges the token as elevated so
 * operators can spot impersonation risk at a glance.
 *
 * Source: docs.microsoft.com/azure/active-directory/roles/permissions-reference
 */
const ADMIN_ROLE_WIDS = new Map([
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
function detectAdminRoles(claims) {
    if (!claims)
        return { isAdmin: false, roles: [] };
    const wids = Array.isArray(claims.wids) ? claims.wids : [];
    const matched = [];
    for (const w of wids) {
        if (typeof w !== "string")
            continue;
        const role = ADMIN_ROLE_WIDS.get(w.toLowerCase());
        if (role)
            matched.push(role);
    }
    return { isAdmin: matched.length > 0, roles: matched };
}
/**
 * Render-formatter for a claim value. Arrays / objects are JSON-stringified;
 * epoch-second numbers for known time claims become human-friendly ISO + age.
 */
function formatClaimValue(name, value) {
    if (value == null)
        return "(null)";
    if (typeof value === "string")
        return value;
    if (typeof value === "number") {
        if (name === "iat" || name === "nbf" || name === "exp") {
            try {
                const iso = new Date(value * 1000).toISOString();
                const now = Math.floor(Date.now() / 1000);
                const delta = value - now;
                const rel = delta > 0
                    ? `in ${fmtDuration(delta)}`
                    : `${fmtDuration(-delta)} ago`;
                return `${value} (${iso} — ${rel})`;
            }
            catch (_a) {
                return String(value);
            }
        }
        return String(value);
    }
    if (typeof value === "boolean")
        return value ? "true" : "false";
    try {
        return JSON.stringify(value);
    }
    catch (_b) {
        return String(value);
    }
}
/** Pretty-print a `<seconds-until-expiry>` for the UI. */
function fmtExpiresIn(epoch) {
    if (!epoch)
        return "unknown";
    const sec = epoch - Math.floor(Date.now() / 1000);
    if (sec < 0)
        return `expired ${fmtDuration(-sec)} ago`;
    if (sec < 60)
        return `${sec}s left`;
    if (sec < 3600)
        return `${Math.floor(sec / 60)}m left`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m left`;
}
/** Pretty-print a duration in seconds — used for "expired Xm ago" too. */
function fmtDuration(sec) {
    if (sec < 60)
        return `${sec}s`;
    if (sec < 3600)
        return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}
/** Visually mask a token value for screen-share-safe display. */
function maskToken(value, visible = 6) {
    if (!value)
        return "";
    if (value.length <= visible * 2 + 3)
        return "•".repeat(value.length);
    return `${value.slice(0, visible)}${"•".repeat(8)}${value.slice(-visible)}`;
}
/**
 * Best-effort clipboard read — wraps both the modern async API and
 * tolerates the "not allowed" failure cleanly so the caller can fall
 * back to the manual paste textarea.
 */
function readFromClipboard() {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        if (typeof navigator === "undefined" || !((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.readText)) {
            return null;
        }
        try {
            return yield navigator.clipboard.readText();
        }
        catch (_b) {
            return null;
        }
    });
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
function hashLineForKey(s) {
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
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/;
/** Mask-safe display fragment of a (possibly token-shaped) line. Shows
 *  the first 12 chars + ellipsis + length. NEVER renders the full
 *  string — and the masked output is the only thing we'd ever surface
 *  to console / audit-log / DOM for non-imported lines. */
function maskLineForDisplay(line) {
    const t = line.trim().replace(/^Bearer\s+/i, "");
    if (t.length <= 16)
        return "•".repeat(Math.min(t.length, 8));
    return `${t.slice(0, 12)}…(${t.length} chars)`;
}
/* ============================================================================
 * Corpus-grounded security detectors
 * ============================================================================
 *
 * (1) HIGH-VALUE-5 audience detection
 *     A token whose `aud` resolves to one of the five high-value resource
 *     servers (Graph, ARM, AAD Graph legacy, Key Vault, Azure Storage)
 *     unlocks tenant-wide read/write. We flag these specifically so an
 *     operator never misses what they just imported.
 *
 *     Refs:
 *       New folder/_analysis_dirkjanm.md — ROADtools `roadtx describe`
 *       enumerates these as the canonical "interesting" audiences.
 *       New folder/_AZURE_LOGIN_METHODS.md:274-294 — IMDS / Azure-Arc
 *       resource= URLs for ARM / Key Vault.
 *       New folder/_bypass_role_grant.md — AAD-Graph + ARM are the two
 *       resource-plane surfaces with the highest blast radius for
 *       directory-role chaining.
 *
 * (2) Golden-SAML `cm:bearer` detection
 *     AADInternals' `New-SAMLToken` forges SAML 1.1 assertions whose
 *     `authnmethodsreferences` claim is the literal SAML 2.0 bearer
 *     subject-confirmation method URI:
 *
 *       urn:oasis:names:tc:SAML:2.0:cm:bearer
 *
 *     AAD passes this through into the `amr` claim of the resulting
 *     JWT, so its mere presence is a strong signal the token was minted
 *     via a forged SAML assertion (Golden SAML).
 *
 *     Refs:
 *       New folder/_analysis_aadinternals.md:80 + :273 — the wire-level
 *       claim emitted by `New-SAMLToken` / `New-SAML2Token`.
 *       New folder/_bypass_login.md — Golden SAML in the kill-chain.
 *
 * (3) Bulk-paste harvest threshold
 *     Pasting more than ~10 tokens at once is unusual for a single
 *     operator workflow — it most often means the operator ran the
 *     portal snippet against a multi-tenant cache or harvested from a
 *     credential dump. We warn (not block) so the operator confirms
 *     intent before committing.
 *
 *     Ref: New folder/_AZURE_LOGIN_METHODS.md — MSAL cache shape
 *     section (one accessToken per (tenant, resource) tuple — a real
 *     single-user portal session caps at ~5-8 distinct tokens).
 * ============================================================================ */
/** Threshold above which we treat a bulk paste as a "harvest dump"
 *  and surface an explicit warning. Empirically a single portal
 *  session caches 5-8 access tokens; anything north of 10 most likely
 *  came from a multi-account aggregation. */
const BULK_HARVEST_THRESHOLD = 10;
/** High-value resource servers: a token here unlocks tenant-wide
 *  control-plane or data-plane abuse. Pattern matched against the raw
 *  `aud` claim string (case-insensitive). */
const HIGH_VALUE_AUDIENCE_PATTERNS = Object.freeze([
    {
        pattern: /^https:\/\/management\.(azure|core\.windows|usgovcloudapi)\./i,
        label: "ARM",
        rationale: "Azure Resource Manager — full control plane. Subscriptions, role assignments, deployments, all RBAC writes.",
    },
    {
        pattern: /^https:\/\/graph\.microsoft\./i,
        label: "Graph",
        rationale: "Microsoft Graph — tenant directory read/write. Users, groups, app roles, sign-in logs, mail/files when delegated.",
    },
    {
        pattern: /^https:\/\/graph\.windows\.net|^00000002-0000-0000-c000-000000000000$/i,
        label: "AAD Graph (legacy)",
        rationale: "AAD Graph — legacy directory API. Still honoured for back-compat; absence of CAE makes it a stealth surface.",
    },
    {
        pattern: /^https:\/\/(vault|managedhsm)\.azure\.(net|usgovcloudapi)/i,
        label: "Key Vault",
        rationale: "Key Vault data plane — read secrets, sign with HSM keys, decrypt protected payloads.",
    },
    {
        pattern: /\.blob\.core\.windows\.net|\.queue\.core\.windows\.net|\.table\.core\.windows\.net|\.file\.core\.windows\.net|^https:\/\/storage\.azure\.com\//i,
        label: "Storage",
        rationale: "Azure Storage data plane — read/write blobs, queues, tables, files. Cross-tenant attack surface via SAS escalation.",
    },
]);
/** Returns the matched high-value label/rationale for a raw aud, or
 *  null if it isn't one of the high-value five. */
function detectHighValueAudience(rawAud) {
    if (!rawAud)
        return null;
    for (const entry of HIGH_VALUE_AUDIENCE_PATTERNS) {
        if (entry.pattern.test(rawAud)) {
            return { label: entry.label, rationale: entry.rationale };
        }
    }
    return null;
}
/** SAML 2.0 subject-confirmation-method URI emitted by
 *  AADInternals' `New-SAMLToken` / `New-SAML2Token` as the
 *  `authnmethodsreferences` claim. Its presence in a token's `amr`
 *  array is a strong signal of a Golden-SAML-minted token.
 *
 *  Ref: New folder/_analysis_aadinternals.md:80 + :273 */
const GOLDEN_SAML_BEARER_URI = "urn:oasis:names:tc:saml:2.0:cm:bearer";
/** Returns true when the token's `amr` claim carries the SAML 2.0
 *  `cm:bearer` confirmation-method URI. */
function detectGoldenSamlBearer(claims) {
    if (!claims)
        return false;
    const raw = claims.amr;
    if (!Array.isArray(raw))
        return false;
    for (const v of raw) {
        if (typeof v !== "string")
            continue;
        if (v.toLowerCase() === GOLDEN_SAML_BEARER_URI)
            return true;
    }
    return false;
}
export const TokenImporterPage = () => {
    var _a, _b, _c, _d;
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
    const [submitError, setSubmitError] = React.useState(null);
    const [accounts, setAccounts] = React.useState(() => listImportedAccounts());
    const [refreshTokens, setRefreshTokens] = React.useState(() => listRefreshTokenEntries());
    const [snippetCopied, setSnippetCopied] = React.useState(false);
    /* ---- Azure DevOps PAT vault state. Kept strictly separate from the
     *      Bearer-token store — PATs are Basic-auth credentials, never
     *      mixed into the access/refresh-token flow. */
    const [adoPats, setAdoPats] = React.useState(() => listAdoPats());
    const [adoPatInput, setAdoPatInput] = React.useState("");
    const [adoPatOwner, setAdoPatOwner] = React.useState("");
    const [adoPatError, setAdoPatError] = React.useState(null);
    /* ---- Reverse-lookup card ("Find FOCI clients that grant a scope")
     *      state. Pure client-side filter over FOCI_CLIENT_DEFAULT_SCOPES. */
    const [scopeQuery, setScopeQuery] = React.useState("");
    // Audit guard — we record `token_importer_scope_lookup` once per
    // distinct non-empty query, not on every keystroke (debounce 800ms).
    const lastAuditedScopeRef = React.useRef("");
    /* ---- Filter / search / sort state for the imported-tokens list. */
    const [search, setSearch] = React.useState("");
    // Audience filter chips. `null` = all; otherwise only rows that have
    // at least one token in this bucket appear. Driven by the summary
    // SummaryStatItem onClicks for click-to-filter UX.
    const [audienceFilter, setAudienceFilter] = React.useState(null);
    /* ---- Privacy: master "Hide tokens" toggle + per-row reveal map. */
    const [maskTokens, setMaskTokens] = React.useState(true);
    const [revealed, setRevealed] = React.useState({});
    const toggleRevealed = React.useCallback((key) => {
        setRevealed((prev) => (Object.assign(Object.assign({}, prev), { [key]: !prev[key] })));
    }, []);
    /* ---- Per-row expanded JWT-claims viewer. */
    const [expandedClaims, setExpandedClaims] = React.useState({});
    const toggleClaims = React.useCallback((key) => {
        setExpandedClaims((prev) => (Object.assign(Object.assign({}, prev), { [key]: !prev[key] })));
    }, []);
    const [pendingConfirm, setPendingConfirm] = React.useState(null);
    // Type-to-confirm challenge for the drop-all path — extra step
    // because clearing every imported token is unrecoverable and can hide
    // an attacker's cleanup if it lands on a single mis-click. Reset on
    // every open of the dialog.
    const [dropAllConfirmText, setDropAllConfirmText] = React.useState("");
    React.useEffect(() => {
        if ((pendingConfirm === null || pendingConfirm === void 0 ? void 0 : pendingConfirm.kind) !== "drop-all") {
            setDropAllConfirmText("");
        }
    }, [pendingConfirm]);
    /* ---- AbortController for in-flight redemption -------------- */
    // We cannot pass an AbortSignal into `redeemRefreshToken` (its
    // signature is owned by the auth module and out of scope for this
    // page). We still wire one up to abort UI side-effects (state
    // updates, audit logging) when the component unmounts so we don't
    // setState-after-unmount, AND to ignore stale completion when the
    // operator submits twice rapidly.
    const redeemAbortRef = React.useRef(null);
    // A monotonically-increasing generation tag. Each submit captures
    // the current value; on completion we ignore the result if a newer
    // submit has started in the meantime. Belt-and-braces alongside the
    // abort controller.
    const submitGenerationRef = React.useRef(0);
    React.useEffect(() => () => {
        var _a;
        (_a = redeemAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
    }, []);
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
    const [bulkRows, setBulkRows] = React.useState([]);
    // AbortController scoped to the in-flight bulk run so the operator
    // can cancel mid-batch. Reset between batches.
    const bulkAbortRef = React.useRef(null);
    React.useEffect(() => () => {
        var _a;
        (_a = bulkAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
    }, []);
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
    const trustedAudiencesGuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const [trustedTenants, setTrustedTenants] = usePersistedState("azbm.token-importer.trusted-tenants.v1", [], {
        version: 1,
        migrate: (raw) => {
            if (!Array.isArray(raw))
                return [];
            const out = [];
            for (const v of raw) {
                if (typeof v !== "string")
                    continue;
                if (!trustedAudiencesGuidRe.test(v.trim()))
                    continue;
                out.push(v.trim().toLowerCase());
            }
            return out;
        },
    });
    const trustedTenantSet = React.useMemo(() => new Set(trustedTenants.map((t) => t.toLowerCase())), [trustedTenants]);
    /* ---- Untrusted-tenant blocklist (UUIDs only) ----------------------
     * Complements the allowlist above: the operator marks specific
     * tenants as KNOWN-HOSTILE so bulk imports flash a red chip and the
     * audit log explicitly records the override. Imports are NEVER
     * blocked client-side — AAD owns authorization — but every row whose
     * tid is in this set gets a visible "blocked tenant" badge so the
     * operator confirms intent.
     *
     * SECURITY: same shape as the allowlist — GUIDs only, persisted via
     * the canonical `usePersistedState` hook, sanitized on migrate. */
    const [blockedTenants, setBlockedTenants] = usePersistedState("azbm.token-importer.blocked-tenants.v1", [], {
        version: 1,
        migrate: (raw) => {
            if (!Array.isArray(raw))
                return [];
            const out = [];
            for (const v of raw) {
                if (typeof v !== "string")
                    continue;
                if (!trustedAudiencesGuidRe.test(v.trim()))
                    continue;
                out.push(v.trim().toLowerCase());
            }
            return out;
        },
    });
    const blockedTenantSet = React.useMemo(() => new Set(blockedTenants.map((t) => t.toLowerCase())), [blockedTenants]);
    /* ---- Refresh-token form state ------------------------------ */
    const [rtInput, setRtInput] = React.useState("");
    const [rtClientId, setRtClientId] = React.useState("04b07795-8ddb-461a-bbee-02f9e1bf7b46");
    // Operator-typed tenant id. We display `rtIdentity.tid || rtTenantId`
    // in the field but only write to `rtTenantId` from the input. This
    // avoids the bug where typing a tenant then pasting an id_token
    // "ghosts" the user's input behind the decoded value.
    const [rtTenantId, setRtTenantId] = React.useState("");
    const [rtIdToken, setRtIdToken] = React.useState("");
    const [rtSubmitting, setRtSubmitting] = React.useState(false);
    const [rtError, setRtError] = React.useState(null);
    // Step-by-step status surfaced during the AAD round-trip so the
    // operator sees which endpoint we're hitting and why (helpful when
    // the network tab is full of noise).
    const [rtStatus, setRtStatus] = React.useState(null);
    /* ---- FOCI exchange state ---------------------------------- */
    // Which imported RT row drives the exchange. Empty string = no RT
    // selected; the picker auto-selects the first eligible RT when one
    // becomes available.
    const [fociSourceAccountId, setFociSourceAccountId] = React.useState("");
    // Target FOCI client to mint AT for. Default = Azure CLI (most
    // forgiving scopes).
    const [fociTargetClientId, setFociTargetClientId] = React.useState("04b07795-8ddb-461a-bbee-02f9e1bf7b46");
    // Scope to request. Default = ARM .default; operator can swap to
    // Graph / Batch via quick-fill below.
    const [fociScope, setFociScope] = React.useState(SCOPE_FOR_AUDIENCE.arm);
    // Single-exchange status / result / error surfaced inline.
    const [fociExchanging, setFociExchanging] = React.useState(false);
    const [fociResult, setFociResult] = React.useState(null);
    const [fociError, setFociError] = React.useState(null);
    const [fociBulk, setFociBulk] = React.useState(null);
    const [fociBulkRunning, setFociBulkRunning] = React.useState(false);
    // Reveal-token toggle for the single-exchange result panel.
    const [fociResultClaimsOpen, setFociResultClaimsOpen] = React.useState(false);
    const refreshList = React.useCallback(() => {
        if (!mountedRef.current)
            return;
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
            setAdoPatError("Owner label is required (free text, e.g. 'contoso-org/alice').");
            return;
        }
        if (!isLikelyAdoPat(pat)) {
            setAdoPatError("That doesn't look like an Azure DevOps PAT shape (expected 40-96 alphanumeric chars). Double-check you didn't paste a JWT by mistake.");
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
        }
        catch (err) {
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
    const handleRemoveAdoPat = React.useCallback((entry) => {
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
    }, [refreshList, store]);
    const handleCopyAdoPatBasicHeader = React.useCallback((entry) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const header = getAdoPatAsBasicHeader(entry.id);
            if (typeof navigator !== "undefined" && navigator.clipboard) {
                yield navigator.clipboard.writeText(header);
            }
            if (!mountedRef.current)
                return;
            store.addNotification({
                type: "success",
                message: `Copied 'Authorization: Basic …' header for ${entry.owner}.`,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!mountedRef.current)
                return;
            store.addNotification({
                type: "error",
                message: `Could not copy header for ${entry.owner}: ${msg}`,
            });
        }
    }), [store]);
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
        if (!q)
            return null;
        // Normalise both sides: strip Graph URI prefix, lowercase, trim.
        const normalisedQuery = q
            .replace(/^https?:\/\/[^/]+\//i, "")
            .toLowerCase();
        return FOCI_CLIENTS.map((c) => {
            const scopes = FOCI_CLIENT_DEFAULT_SCOPES[c.clientId];
            if (!scopes) {
                return { client: c, grants: false, knownScopes: false };
            }
            const matched = scopes.find((s) => s.toLowerCase() === normalisedQuery);
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
        if (!q || q === lastAuditedScopeRef.current)
            return;
        const t = window.setTimeout(() => {
            var _a, _b;
            if (!mountedRef.current)
                return;
            if (q !== scopeQuery.trim())
                return; // user kept typing
            lastAuditedScopeRef.current = q;
            const matchCount = (_a = scopeLookupResults === null || scopeLookupResults === void 0 ? void 0 : scopeLookupResults.filter((r) => r.grants).length) !== null && _a !== void 0 ? _a : 0;
            const unknownCount = (_b = scopeLookupResults === null || scopeLookupResults === void 0 ? void 0 : scopeLookupResults.filter((r) => !r.knownScopes).length) !== null && _b !== void 0 ? _b : 0;
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
        var _a, _b, _c, _d, _e, _f;
        const claims = rtIdToken.trim()
            ? decodeJwtPayload(rtIdToken.trim())
            : null;
        const oid = String((_b = (_a = claims === null || claims === void 0 ? void 0 : claims.oid) !== null && _a !== void 0 ? _a : claims === null || claims === void 0 ? void 0 : claims.sub) !== null && _b !== void 0 ? _b : "");
        const tid = String((_d = (_c = claims === null || claims === void 0 ? void 0 : claims.tid) !== null && _c !== void 0 ? _c : rtTenantId) !== null && _d !== void 0 ? _d : "");
        const upn = (_f = (_e = claims === null || claims === void 0 ? void 0 : claims.preferred_username) !== null && _e !== void 0 ? _e : claims === null || claims === void 0 ? void 0 : claims.upn) !== null && _f !== void 0 ? _f : claims === null || claims === void 0 ? void 0 : claims.unique_name;
        const name = claims === null || claims === void 0 ? void 0 : claims.name;
        return { oid, tid, upn, name, hasIdToken: !!claims };
    }, [rtIdToken, rtTenantId]);
    /** GUID regex used for client_id + tenant_id validation. */
    const guidRe = React.useMemo(() => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, []);
    const rtPlanValid = rtInput.trim().length > 20 &&
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
    const [rtExtracted, setRtExtracted] = React.useState({ source: null, fields: [] });
    // Soft warning when the parse attempt looked like a structured paste
    // but didn't yield a usable refresh_token — we don't fail outright
    // (the bare-trim fallback may still work) but we tell the operator
    // we tried.
    const [rtExtractWarning, setRtExtractWarning] = React.useState(null);
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
    function parseRtPaste(raw, onWarn) {
        var _a, _b, _c;
        const trimmed = raw.trim();
        // Detect the "<refresh_token>" placeholder so we can refuse early.
        const looksLikeTemplate = /<\s*refresh[_-]?token\s*>/i.test(trimmed) ||
            /\{\s*your[_-]?refresh[_-]?token\s*\}/i.test(trimmed);
        // JSON token-endpoint response.
        if (trimmed.startsWith("{") && trimmed.includes("refresh_token")) {
            try {
                const j = JSON.parse(trimmed);
                if (typeof j.refresh_token === "string") {
                    const fields = ["refresh_token"];
                    if (typeof j.client_id === "string")
                        fields.push("client_id");
                    if (typeof j.scope === "string")
                        fields.push("scope");
                    if (typeof j.resource === "string")
                        fields.push("resource");
                    return {
                        refreshToken: j.refresh_token,
                        clientId: typeof j.client_id === "string" ? j.client_id : undefined,
                        scope: typeof j.scope === "string" ? j.scope : undefined,
                        resource: typeof j.resource === "string" ? j.resource : undefined,
                        looksLikeTemplate,
                        source: "json",
                        fields,
                    };
                }
                onWarn("Pasted JSON has no `refresh_token` field — falling back to treating the whole paste as a token.");
            }
            catch (err) {
                onWarn(`Pasted text starts with '{' but is not valid JSON (${err instanceof Error ? err.message : String(err)}) — falling back to treating the whole paste as a token.`);
            }
        }
        // PowerShell Invoke-RestMethod / Invoke-WebRequest with a hashtable
        // body: `-Body @{ refresh_token = 'XXX'; client_id = 'YYY' }`.
        const psHash = /Invoke-(?:RestMethod|WebRequest)/i.test(trimmed) &&
            /refresh_token\s*=/i.test(trimmed);
        if (psHash) {
            try {
                const rtMatch = /refresh_token\s*=\s*['"]([^'"]+)['"]/i.exec(trimmed);
                const cidMatch = /client_id\s*=\s*['"]([^'"]+)['"]/i.exec(trimmed);
                const scopeMatch = /scope\s*=\s*['"]([^'"]+)['"]/i.exec(trimmed);
                const resourceMatch = /resource\s*=\s*['"]([^'"]+)['"]/i.exec(trimmed);
                const tenantMatch = /login\.microsoftonline\.com\/([0-9a-f-]{36})/i.exec(trimmed);
                if (rtMatch === null || rtMatch === void 0 ? void 0 : rtMatch[1]) {
                    const fields = ["refresh_token"];
                    if (cidMatch === null || cidMatch === void 0 ? void 0 : cidMatch[1])
                        fields.push("client_id");
                    if (tenantMatch === null || tenantMatch === void 0 ? void 0 : tenantMatch[1])
                        fields.push("tenant");
                    if (scopeMatch === null || scopeMatch === void 0 ? void 0 : scopeMatch[1])
                        fields.push("scope");
                    if (resourceMatch === null || resourceMatch === void 0 ? void 0 : resourceMatch[1])
                        fields.push("resource");
                    return {
                        refreshToken: rtMatch[1],
                        clientId: cidMatch === null || cidMatch === void 0 ? void 0 : cidMatch[1],
                        tenantId: tenantMatch === null || tenantMatch === void 0 ? void 0 : tenantMatch[1],
                        scope: scopeMatch === null || scopeMatch === void 0 ? void 0 : scopeMatch[1],
                        resource: resourceMatch === null || resourceMatch === void 0 ? void 0 : resourceMatch[1],
                        looksLikeTemplate,
                        source: "powershell",
                        fields,
                    };
                }
                onWarn("Paste looks like a PowerShell Invoke-RestMethod command but no `refresh_token = '...'` pair was found — falling back to the bare value.");
            }
            catch (err) {
                onWarn(`PowerShell parse failed: ${err instanceof Error ? err.message : String(err)}.`);
            }
        }
        // Form-encoded body OR curl-style body inside quotes.
        const formish = trimmed.includes("refresh_token=") &&
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
                    const tenantMatch = /login\.microsoftonline\.com\/([0-9a-f-]{36})/i.exec(trimmed);
                    const fields = ["refresh_token"];
                    if (params.get("client_id"))
                        fields.push("client_id");
                    if (tenantMatch === null || tenantMatch === void 0 ? void 0 : tenantMatch[1])
                        fields.push("tenant");
                    if (params.get("scope"))
                        fields.push("scope");
                    if (params.get("resource"))
                        fields.push("resource");
                    return {
                        refreshToken: rt,
                        clientId: (_a = params.get("client_id")) !== null && _a !== void 0 ? _a : undefined,
                        tenantId: tenantMatch === null || tenantMatch === void 0 ? void 0 : tenantMatch[1],
                        scope: (_b = params.get("scope")) !== null && _b !== void 0 ? _b : undefined,
                        resource: (_c = params.get("resource")) !== null && _c !== void 0 ? _c : undefined,
                        looksLikeTemplate,
                        source: isCurl ? "curl" : "form",
                        fields,
                    };
                }
                onWarn("Paste looks like a form-encoded body but `refresh_token=` was empty — falling back to the bare value.");
            }
            catch (err) {
                onWarn(`Form-decode failed: ${err instanceof Error ? err.message : String(err)}.`);
            }
        }
        return {
            refreshToken: trimmed,
            looksLikeTemplate,
            source: null,
            fields: [],
        };
    }
    const submitRefreshToken = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
        if (!rtPlanValid)
            return;
        // Re-arm the abort controller for this attempt — guards against
        // setState-after-unmount when redemption is in flight while the
        // user navigates away. Also bump the generation so any in-flight
        // older submit's completion is ignored if both happen to resolve.
        (_e = redeemAbortRef.current) === null || _e === void 0 ? void 0 : _e.abort();
        const abortController = new AbortController();
        redeemAbortRef.current = abortController;
        const generation = ++submitGenerationRef.current;
        const isStale = () => abortController.signal.aborted ||
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
            const warns = [];
            const parsed = parseRtPaste(rtInput, (w) => warns.push(w));
            if (warns.length > 0)
                setRtExtractWarning(warns.join(" "));
            if (parsed.looksLikeTemplate) {
                throw new Error("Your paste still contains the literal `<refresh_token>` placeholder. Replace it with the actual token value (a long opaque string starting with `0.` or `1.`) before submitting.");
            }
            const refreshToken = parsed.refreshToken;
            const tenantId = ((_g = (_f = parsed.tenantId) !== null && _f !== void 0 ? _f : rtIdentity.tid) !== null && _g !== void 0 ? _g : "").trim();
            const clientId = ((_h = parsed.clientId) !== null && _h !== void 0 ? _h : rtClientId).trim();
            // If we extracted companion fields, surface that to the operator
            // so they understand why the form-fields look different from
            // what they typed.
            if (parsed.source && parsed.fields.length > 0) {
                setRtExtracted({ source: parsed.source, fields: parsed.fields });
                if (parsed.clientId)
                    setRtClientId(parsed.clientId);
                if (parsed.tenantId)
                    setRtTenantId(parsed.tenantId);
            }
            setRtStatus(`Contacting AAD /oauth2/v2.0/token for tenant ${tenantId.slice(0, 8)}…`);
            // Validate by minting an ARM token immediately. This proves the
            // RT + client_id + tenant combo works AND seeds the access-token
            // cache so the user can start using the WebUI without another
            // round-trip.
            const data = yield redeemRefreshToken(refreshToken, clientId, tenantId, SCOPE_FOR_AUDIENCE.arm);
            if (isStale())
                return; // unmounted / superseded — drop the result.
            if (!data.access_token) {
                throw new Error((_k = (_j = data.error_description) !== null && _j !== void 0 ? _j : data.error) !== null && _k !== void 0 ? _k : "AAD returned no access token. Wrong client id or expired refresh token.");
            }
            // Record the successful redemption separately from the import
            // event — operators want a per-redemption audit trail for the
            // tenant + clientId + scope combo, and successful redemptions
            // happen lazily on later runs without `import_refresh_token`.
            auditLog.record({
                actor: (_m = (_l = rtIdentity.upn) !== null && _l !== void 0 ? _l : rtIdentity.oid) !== null && _m !== void 0 ? _m : "operator",
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
            const acClaims = (_o = decodeJwtPayload(data.access_token)) !== null && _o !== void 0 ? _o : {};
            const oid = String((_q = (_p = acClaims.oid) !== null && _p !== void 0 ? _p : rtIdentity.oid) !== null && _q !== void 0 ? _q : "");
            const upn = (_s = (_r = acClaims.preferred_username) !== null && _r !== void 0 ? _r : acClaims.upn) !== null && _s !== void 0 ? _s : rtIdentity.upn;
            const name = (_t = acClaims.name) !== null && _t !== void 0 ? _t : rtIdentity.name;
            const homeAccountId = `${oid}.${tenantId}`;
            // Persist the refresh token (rotated if AAD sent a new one).
            importRefreshToken({
                homeAccountId,
                tenantId,
                oid,
                upn,
                name,
                clientId,
                refreshToken: (_u = data.refresh_token) !== null && _u !== void 0 ? _u : refreshToken,
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
                rawAudience: String((_v = acClaims.aud) !== null && _v !== void 0 ? _v : "https://management.azure.com"),
                expiresAt: Number((_w = acClaims.exp) !== null && _w !== void 0 ? _w : 0) ||
                    (data.expires_in
                        ? Math.floor(Date.now() / 1000) + data.expires_in
                        : 0),
                claims: acClaims,
            });
            auditLog.record({
                actor: upn !== null && upn !== void 0 ? upn : oid,
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
                message: `Imported refresh token for ${upn !== null && upn !== void 0 ? upn : oid}. ARM token cached; Graph & Batch will be minted on demand.`,
            });
            setRtInput("");
            setRtIdToken("");
            setRtStatus(null);
            refreshList();
        }
        catch (err) {
            if (isStale())
                return; // unmounted / superseded.
            const msg = err instanceof Error ? err.message : String(err);
            // AADSTS53003 == Conditional Access blocked token issuance. The
            // refresh-token grant cannot satisfy CA from this origin — the
            // operator's only recourse is to paste the access_token that was
            // returned alongside the refresh_token (it already satisfied CA
            // at issuance time).
            if (msg.includes("AADSTS53003") ||
                msg.toLowerCase().includes("conditional access")) {
                setRtCaBlocked(true);
            }
            else if (msg.includes("AADSTS70000") ||
                msg.toLowerCase().includes("provided grant is invalid")) {
                setRtInvalidGrant(true);
            }
            setRtError(msg);
            setRtStatus(null);
            auditLog.record({
                actor: (_y = (_x = rtIdentity.upn) !== null && _x !== void 0 ? _x : rtIdentity.oid) !== null && _y !== void 0 ? _y : "operator",
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
                actor: (_0 = (_z = rtIdentity.upn) !== null && _z !== void 0 ? _z : rtIdentity.oid) !== null && _0 !== void 0 ? _0 : "operator",
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
        }
        finally {
            // Only flip the spinner off if we're the latest submit and still
            // mounted — otherwise a superseded older submit could clobber the
            // newer one's spinner state.
            if (mountedRef.current &&
                generation === submitGenerationRef.current) {
                setRtSubmitting(false);
            }
        }
    }), [
        rtPlanValid,
        rtIdentity,
        rtClientId,
        rtInput,
        refreshList,
        store,
    ]);
    /** Re-mint the ARM token for an existing refresh-token row. */
    const reMintFromRt = React.useCallback((entry) => __awaiter(void 0, void 0, void 0, function* () {
        var _1, _2, _3, _4, _5, _6, _7, _8, _9;
        const generation = ++submitGenerationRef.current;
        try {
            const data = yield redeemRefreshToken(entry.refreshToken, entry.clientId, entry.tenantId, SCOPE_FOR_AUDIENCE.arm);
            if (!mountedRef.current || generation !== submitGenerationRef.current) {
                return;
            }
            if (!data.access_token) {
                throw new Error((_2 = (_1 = data.error_description) !== null && _1 !== void 0 ? _1 : data.error) !== null && _2 !== void 0 ? _2 : "No access_token returned.");
            }
            const claims = (_3 = decodeJwtPayload(data.access_token)) !== null && _3 !== void 0 ? _3 : {};
            importToken({
                jwt: data.access_token,
                homeAccountId: entry.homeAccountId,
                tenantId: entry.tenantId,
                oid: entry.oid,
                upn: entry.upn,
                name: entry.name,
                audience: "arm",
                rawAudience: String((_4 = claims.aud) !== null && _4 !== void 0 ? _4 : "https://management.azure.com"),
                expiresAt: Number((_5 = claims.exp) !== null && _5 !== void 0 ? _5 : 0) ||
                    (data.expires_in
                        ? Math.floor(Date.now() / 1000) + data.expires_in
                        : 0),
                claims,
            });
            if (data.refresh_token && data.refresh_token !== entry.refreshToken) {
                importRefreshToken(Object.assign(Object.assign({}, entry), { refreshToken: data.refresh_token }));
            }
            auditLog.record({
                actor: (_6 = entry.upn) !== null && _6 !== void 0 ? _6 : entry.oid,
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
                message: `Re-minted ARM token for ${(_7 = entry.upn) !== null && _7 !== void 0 ? _7 : entry.oid}.`,
            });
            refreshList();
        }
        catch (err) {
            if (!mountedRef.current || generation !== submitGenerationRef.current) {
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            auditLog.record({
                actor: (_8 = entry.upn) !== null && _8 !== void 0 ? _8 : entry.oid,
                action: "redeem_refresh_token",
                target: `${entry.tenantId}|${entry.clientId}|${SCOPE_FOR_AUDIENCE.arm}`,
                status: "failure",
                error: msg,
                details: { source: "remint-from-list" },
            });
            store.addNotification({
                type: "error",
                message: `Re-mint failed for ${(_9 = entry.upn) !== null && _9 !== void 0 ? _9 : entry.oid}: ${msg}`,
            });
        }
    }), [refreshList, store]);
    /* ------------------------------------------------------------------
     * FOCI exchange handlers
     * ------------------------------------------------------------------
     * `runFociExchange` does a single source→target exchange and updates
     * the inline result panel. `runFociBulkMint` runs every FOCI target
     * in parallel and collects per-target results into a table.
     */
    const runFociExchange = React.useCallback((overrideTarget) => __awaiter(void 0, void 0, void 0, function* () {
        var _10, _11;
        const source = refreshTokens.find((r) => r.homeAccountId === fociSourceAccountId);
        if (!source) {
            setFociError("Pick a source refresh token first (the dropdown above). Import an RT via the green card if you don't have one yet.");
            return;
        }
        const target = overrideTarget !== null && overrideTarget !== void 0 ? overrideTarget : FOCI_CLIENTS.find((c) => c.clientId === fociTargetClientId);
        if (!target) {
            setFociError("Pick a target FOCI client from the list below the dropdown.");
            return;
        }
        // Gate on isFoci client-side: refuse to spend an RT on a target
        // we already know is non-FOCI (AAD would return AADSTS54005 and
        // consume the RT in the process). The button is already disabled
        // for non-FOCI rows; this is the belt-and-braces server-side
        // analogue.
        if (!target.isFoci) {
            setFociError(`${target.name} is not in the FOCI family — AAD would reject this exchange with AADSTS54005. Use the device-code flow against this client instead.`);
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
            const result = yield exchangeRefreshTokenForClient({
                refreshToken: source.refreshToken,
                targetClientId: target.clientId,
                tenantId: source.tenantId,
                scope: fociScope.trim(),
            });
            if (!mountedRef.current)
                return;
            setFociResult({
                sourceClient: source.clientId,
                targetClient: target,
                scope: fociScope.trim(),
                result,
            });
            auditLog.record({
                actor: (_10 = source.upn) !== null && _10 !== void 0 ? _10 : source.oid,
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
        }
        catch (err) {
            if (!mountedRef.current)
                return;
            const isFociErr = err instanceof FociExchangeError;
            const msg = err instanceof Error ? err.message : String(err);
            setFociError(msg);
            auditLog.record({
                actor: (_11 = source.upn) !== null && _11 !== void 0 ? _11 : source.oid,
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
        }
        finally {
            if (mountedRef.current)
                setFociExchanging(false);
        }
    }), [
        refreshTokens,
        fociSourceAccountId,
        fociTargetClientId,
        fociScope,
    ]);
    /**
     * Import the most-recent FOCI exchange result into the access-token
     * vault so the rest of the WebUI can use it.
     */
    const importFociResultToVault = React.useCallback(() => {
        var _a, _b, _c, _d, _e, _f;
        if (!fociResult)
            return;
        const source = refreshTokens.find((r) => r.homeAccountId === fociSourceAccountId);
        if (!source)
            return;
        const { result } = fociResult;
        const claims = result.claims;
        const audience = classifyAudience(result.audience);
        const oid = String((_a = claims.oid) !== null && _a !== void 0 ? _a : source.oid);
        const tenantId = String((_b = claims.tid) !== null && _b !== void 0 ? _b : source.tenantId);
        const homeAccountId = `${oid}.${tenantId}`;
        const upn = (_d = (_c = claims.preferred_username) !== null && _c !== void 0 ? _c : claims.upn) !== null && _d !== void 0 ? _d : source.upn;
        const name = (_e = claims.name) !== null && _e !== void 0 ? _e : source.name;
        importToken({
            jwt: result.access_token,
            homeAccountId,
            tenantId,
            oid,
            upn,
            name,
            audience,
            rawAudience: result.audience,
            expiresAt: Number((_f = claims.exp) !== null && _f !== void 0 ? _f : 0) ||
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
            actor: upn !== null && upn !== void 0 ? upn : oid,
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
    const runFociBulkMint = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        const source = refreshTokens.find((r) => r.homeAccountId === fociSourceAccountId);
        if (!source) {
            setFociError("Pick a source refresh token first to bulk-mint targets.");
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
        const initial = eligibleTargets.map((c) => ({
            target: c,
            status: "pending",
        }));
        setFociBulk(initial);
        const results = yield Promise.all(eligibleTargets.map((target) => __awaiter(void 0, void 0, void 0, function* () {
            var _12, _13;
            try {
                const r = yield exchangeRefreshTokenForClient({
                    refreshToken: source.refreshToken,
                    targetClientId: target.clientId,
                    tenantId: source.tenantId,
                    scope: fociScope.trim(),
                });
                auditLog.record({
                    actor: (_12 = source.upn) !== null && _12 !== void 0 ? _12 : source.oid,
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
            }
            catch (err) {
                const isFociErr = err instanceof FociExchangeError;
                const msg = err instanceof Error ? err.message : String(err);
                auditLog.record({
                    actor: (_13 = source.upn) !== null && _13 !== void 0 ? _13 : source.oid,
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
        })));
        if (mountedRef.current) {
            setFociBulk(results);
            setFociBulkRunning(false);
            const ok = results.filter((r) => r.status === "success").length;
            store.addNotification({
                type: ok > 0 ? "success" : "warning",
                message: `FOCI bulk-mint: ${ok} / ${results.length} clients accepted the RT.`,
            });
        }
    }), [refreshTokens, fociSourceAccountId, fociScope, store]);
    /**
     * Auto-pick a source RT when one becomes available and none is
     * currently selected. Operator can still manually override.
     */
    React.useEffect(() => {
        var _a, _b;
        if (!fociSourceAccountId && refreshTokens.length > 0) {
            setFociSourceAccountId(refreshTokens[0].homeAccountId);
        }
        else if (fociSourceAccountId &&
            !refreshTokens.some((r) => r.homeAccountId === fociSourceAccountId)) {
            // The selected RT was dropped — fall back to the first available
            // RT (or empty when there are none).
            setFociSourceAccountId((_b = (_a = refreshTokens[0]) === null || _a === void 0 ? void 0 : _a.homeAccountId) !== null && _b !== void 0 ? _b : "");
        }
    }, [refreshTokens, fociSourceAccountId]);
    const handleRemoveRefresh = React.useCallback((entry) => {
        // Defer the destructive action behind the shared
        // ConfirmationDialog — operators can review the consequences and
        // hit Escape / click outside instead of being trapped by a native
        // window.confirm() box.
        setPendingConfirm({ kind: "drop-refresh", entry });
    }, []);
    const confirmRemoveRefresh = React.useCallback((entry) => {
        var _a;
        removeRefreshToken(entry.homeAccountId);
        auditLog.record({
            actor: (_a = entry.upn) !== null && _a !== void 0 ? _a : entry.oid,
            action: "drop_refresh_token",
            target: entry.homeAccountId,
            status: "success",
            details: {
                tenantId: entry.tenantId,
                clientId: entry.clientId,
            },
        });
        refreshList();
    }, [refreshList]);
    const preview = React.useMemo(() => previewToken(input), [input]);
    const handleImport = React.useCallback(() => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        if (!preview)
            return;
        try {
            const entry = importToken(preview);
            // Push (or refresh) a pseudo-account into the global store so the
            // rest of the app's account-driven pickers see this principal.
            const tokens = listImportedTokens().filter((t) => t.homeAccountId === entry.homeAccountId);
            // Read accounts from the live state once — avoids the stale-closure
            // bug where `azureAccounts` and `state.azureAccounts` could
            // diverge if the store updated between renders.
            const all = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
            const existing = all.find((a) => a.homeAccountId === entry.homeAccountId);
            const pseudoAccount = {
                homeAccountId: entry.homeAccountId,
                localAccountId: entry.oid,
                username: (_b = entry.upn) !== null && _b !== void 0 ? _b : entry.oid,
                name: (_d = (_c = entry.name) !== null && _c !== void 0 ? _c : entry.upn) !== null && _d !== void 0 ? _d : entry.oid,
                tenantId: entry.tenantId,
                environment: "imported",
                subscriptions: (_e = existing === null || existing === void 0 ? void 0 : existing.subscriptions) !== null && _e !== void 0 ? _e : [],
                subscriptionCount: (_f = existing === null || existing === void 0 ? void 0 : existing.subscriptionCount) !== null && _f !== void 0 ? _f : 0,
                status: "active",
                error: null,
                signedOut: false,
                addedAt: (_g = existing === null || existing === void 0 ? void 0 : existing.addedAt) !== null && _g !== void 0 ? _g : new Date().toISOString(),
            };
            const idx = all.findIndex((a) => a.homeAccountId === entry.homeAccountId);
            const next = idx >= 0
                ? all.map((a, i) => (i === idx ? pseudoAccount : a))
                : [...all, pseudoAccount];
            store.setAzureAccounts(next);
            auditLog.record({
                actor: (_h = entry.upn) !== null && _h !== void 0 ? _h : entry.oid,
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
                message: `Imported ${entry.audience.toUpperCase()} token for ${(_j = entry.upn) !== null && _j !== void 0 ? _j : entry.oid} (${fmtExpiresIn(entry.expiresAt)}).`,
            });
            setInput("");
            setSubmitError(null);
            refreshList();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setSubmitError(msg);
            auditLog.record({
                actor: (_l = (_k = preview === null || preview === void 0 ? void 0 : preview.upn) !== null && _k !== void 0 ? _k : preview === null || preview === void 0 ? void 0 : preview.oid) !== null && _l !== void 0 ? _l : "operator",
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
    /* ---- Derived: list of every imported access token (for stats &
     * export). We compute it once per render — listImportedTokens()
     * reads localStorage but is cheap (n is small).
     *
     * NOTE: this declaration must live BEFORE `bulkPlan` below — its
     * dependency array references `allTokens` and a forward `const`
     * reference is a TDZ trap (ReferenceError on first render). */
    const allTokens = React.useMemo(() => listImportedTokens(), 
    // Re-read whenever the accounts / refresh-token lists change
    // (which is what the in-storage list is keyed by).
    [accounts, refreshTokens]);
    /* ---- Bulk-import: derive the plan from the textarea ---------------
     * Debounced 300ms upstream via deferred update of `bulkInput` (we
     * read on demand here — React's batching keeps the cost cheap; the
     * input field itself updates synchronously for responsiveness). */
    const bulkPlan = React.useMemo(() => {
        const raw = bulkInput;
        if (!raw.trim()) {
            return {
                rows: [],
                importableCount: 0,
                unknownAudienceCount: 0,
                duplicateCount: 0,
                totalLines: 0,
                highValueCount: 0,
                goldenSamlCount: 0,
                blockedTenantCount: 0,
            };
        }
        // Split on newlines or whitespace runs that include a newline. The
        // portal-snippet copy joins with `\n` so the split is well-defined.
        const lines = raw
            .split(/\r?\n+/g)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const existingKey = new Set(allTokens.map((t) => `${t.homeAccountId}|${t.audience}`));
        const out = [];
        let importable = 0;
        let unknown = 0;
        let duplicates = 0;
        let highValue = 0;
        let goldenSaml = 0;
        let blockedTenantHits = 0;
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            const stripped = line.replace(/^Bearer\s+/i, "").trim();
            const looksLikeJwt = JWT_SHAPE_RE.test(stripped);
            const preview = looksLikeJwt ? previewToken(stripped) : null;
            const key = `${i}-${hashLineForKey(stripped)}`;
            const masked = maskLineForDisplay(line);
            // SECURITY: high-value / Golden-SAML detection runs on the
            // DECODED CLAIMS, not the raw token. The token string never
            // leaves the preview object — and the preview is held only in
            // memory while the bulk panel is open. We attach a small flag
            // (audience LABEL + boolean) to the row; that's the only thing
            // that gets rendered or audit-logged.
            const hv = preview ? detectHighValueAudience(preview.rawAudience) : null;
            const gs = preview ? detectGoldenSamlBearer(preview.claims) : false;
            if (preview) {
                importable += 1;
                if (preview.audience === "unknown")
                    unknown += 1;
                if (existingKey.has(`${preview.homeAccountId}|${preview.audience}`)) {
                    duplicates += 1;
                }
                if (hv)
                    highValue += 1;
                if (gs)
                    goldenSaml += 1;
                if (blockedTenantSet.has(preview.tenantId.toLowerCase())) {
                    blockedTenantHits += 1;
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
                highValue: hv !== null && hv !== void 0 ? hv : undefined,
                goldenSaml: gs || undefined,
            });
        }
        return {
            rows: out,
            importableCount: importable,
            unknownAudienceCount: unknown,
            duplicateCount: duplicates,
            totalLines: lines.length,
            highValueCount: highValue,
            goldenSamlCount: goldenSaml,
            blockedTenantCount: blockedTenantHits,
        };
    }, [bulkInput, allTokens, blockedTenantSet]);
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
    const runBulkImport = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _14;
        if (bulkPlan.importableCount === 0)
            return;
        (_14 = bulkAbortRef.current) === null || _14 === void 0 ? void 0 : _14.abort();
        const ac = new AbortController();
        bulkAbortRef.current = ac;
        setBulkBusy(true);
        const startedAt = bulkPlan.rows.map((r) => (Object.assign({}, r)));
        setBulkRows(startedAt);
        let ok = 0;
        let skipped = 0;
        let failed = 0;
        // Snapshot the current allTokens before we mutate the store — we
        // re-derive `existingKey` once at the start so duplicate detection
        // matches what the operator saw in the preview table.
        const next = startedAt.map((row) => {
            var _a, _b, _c, _d, _e, _f;
            if (ac.signal.aborted || !mountedRef.current) {
                return Object.assign(Object.assign({}, row), { status: "skipped", reason: "Cancelled by operator." });
            }
            if (!row.preview) {
                failed += 1;
                return Object.assign(Object.assign({}, row), { status: "failed" });
            }
            try {
                const committed = importToken(row.preview);
                ok += 1;
                // Audit entry for the SUCCESSFUL commit — counts + audience only.
                // No token material, no claims dump.
                auditLog.record({
                    actor: (_b = (_a = committed.upn) !== null && _a !== void 0 ? _a : committed.oid) !== null && _b !== void 0 ? _b : "operator",
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
                        trustedTenant: trustedTenantSet.has(committed.tenantId.toLowerCase()),
                        // Sanitized risk-flag echo — labels only, no token material.
                        blockedTenant: blockedTenantSet.has(committed.tenantId.toLowerCase()),
                        highValueAudience: (_d = (_c = row.highValue) === null || _c === void 0 ? void 0 : _c.label) !== null && _d !== void 0 ? _d : null,
                        goldenSamlSuspected: !!row.goldenSaml,
                    },
                });
                return Object.assign(Object.assign({}, row), { status: "imported" });
            }
            catch (err) {
                failed += 1;
                const msg = err instanceof Error ? err.message : "import failed";
                // Failure audit — sanitized error string only. `msg` originates
                // from importToken() which throws plain validation errors and
                // does NOT echo the token back.
                auditLog.record({
                    actor: (_f = (_e = row.preview.upn) !== null && _e !== void 0 ? _e : row.preview.oid) !== null && _f !== void 0 ? _f : "operator",
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
                return Object.assign(Object.assign({}, row), { status: "failed", reason: msg });
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
                // Aggregate-only risk telemetry — counts only, no token / claim
                // material reaches the audit log.
                highValueCount: bulkPlan.highValueCount,
                goldenSamlCount: bulkPlan.goldenSamlCount,
                blockedTenantCount: bulkPlan.blockedTenantCount,
                harvestWarning: bulkPlan.totalLines > BULK_HARVEST_THRESHOLD,
                outcome: failed === 0 && ok > 0 ? "full" : ok > 0 ? "partial" : "none",
            },
        });
        store.addNotification({
            type: ok > 0 && failed === 0 ? "success" : ok > 0 ? "warning" : "error",
            message: `Bulk import: ${ok} imported, ${failed} failed, ${skipped} skipped.`,
        });
    }), [bulkPlan, store, refreshList, trustedTenantSet, blockedTenantSet]);
    const cancelBulkImport = React.useCallback(() => {
        var _a;
        (_a = bulkAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        if (mountedRef.current)
            setBulkBusy(false);
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
    const toggleTrustedTenant = React.useCallback((tenantId) => {
        const tid = tenantId.trim().toLowerCase();
        if (!trustedAudiencesGuidRe.test(tid))
            return;
        setTrustedTenants((prev) => {
            const set = new Set(prev.map((t) => t.toLowerCase()));
            if (set.has(tid))
                set.delete(tid);
            else
                set.add(tid);
            return Array.from(set);
        });
        // If a tenant is added to the trust set, take it off the
        // blocklist (the two sets must be disjoint — anything else is a
        // user-confusing UI state).
        setBlockedTenants((prev) => prev.filter((t) => t.toLowerCase() !== tid));
        // Audit the change — tenant id is a public GUID, safe to log.
        auditLog.record({
            actor: "operator",
            action: "trusted_tenant_toggle",
            target: tid,
            status: "success",
            details: { tenantId: tid },
        });
    }, [setTrustedTenants, setBlockedTenants]);
    /**
     * Toggle a tenant id in the BLOCKED-tenants set. Mirrors
     * `toggleTrustedTenant` — same shape, same persistence guarantees,
     * same disjointness invariant. */
    const toggleBlockedTenant = React.useCallback((tenantId) => {
        const tid = tenantId.trim().toLowerCase();
        if (!trustedAudiencesGuidRe.test(tid))
            return;
        setBlockedTenants((prev) => {
            const set = new Set(prev.map((t) => t.toLowerCase()));
            if (set.has(tid))
                set.delete(tid);
            else
                set.add(tid);
            return Array.from(set);
        });
        // Anything added to the blocklist drops off the trust list.
        setTrustedTenants((prev) => prev.filter((t) => t.toLowerCase() !== tid));
        auditLog.record({
            actor: "operator",
            action: "blocked_tenant_toggle",
            target: tid,
            status: "success",
            details: { tenantId: tid },
        });
    }, [setBlockedTenants, setTrustedTenants]);
    const handleRemoveAccount = React.useCallback((a) => {
        setPendingConfirm({ kind: "drop-account", account: a });
    }, []);
    const confirmRemoveAccount = React.useCallback((a) => {
        var _a, _b, _c;
        removeImportedAccount(a.homeAccountId);
        // Emit BOTH the legacy `drop_imported_token` name (for backwards
        // compatibility with existing audit-log dashboards) AND the
        // canonical `remove_imported_account` name listed in the page
        // audit spec.
        auditLog.record({
            actor: (_a = a.upn) !== null && _a !== void 0 ? _a : a.oid,
            action: "drop_imported_token",
            target: a.homeAccountId,
            status: "success",
            details: { audiences: a.audiences.join(",") },
        });
        auditLog.record({
            actor: (_b = a.upn) !== null && _b !== void 0 ? _b : a.oid,
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
        const all = (_c = state.azureAccounts) !== null && _c !== void 0 ? _c : [];
        store.setAzureAccounts(all.filter((row) => row.homeAccountId !== a.homeAccountId));
        refreshList();
    }, [refreshList, state.azureAccounts, store]);
    const handleRemoveAudience = React.useCallback((homeAccountId, audience) => {
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
    }, [refreshList]);
    const handleClearAll = React.useCallback(() => {
        setPendingConfirm({ kind: "drop-all" });
    }, []);
    const handleDropExpired = React.useCallback(() => {
        setPendingConfirm({ kind: "drop-expired" });
    }, []);
    const confirmClearAll = React.useCallback(() => {
        var _a;
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
        const all = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
        store.setAzureAccounts(all.filter((row) => row.environment !== "imported"));
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
            message: dropped > 0
                ? `Dropped ${dropped} expired token${dropped === 1 ? "" : "s"}.`
                : "No expired tokens to drop.",
        });
        refreshList();
    }, [refreshList, store]);
    const copySnippet = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield navigator.clipboard.writeText(PORTAL_SNIPPET);
            if (!mountedRef.current)
                return;
            setSnippetCopied(true);
            window.setTimeout(() => {
                if (mountedRef.current)
                    setSnippetCopied(false);
            }, 1500);
        }
        catch (_15) {
            store.addNotification({
                type: "error",
                message: "Could not copy snippet — clipboard access blocked.",
            });
        }
    }), [store]);
    /** Pull whatever's on the clipboard into the access-token textarea. */
    const pasteAccessTokenFromClipboard = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        const text = yield readFromClipboard();
        if (!mountedRef.current)
            return;
        if (text == null) {
            store.addNotification({
                type: "error",
                message: "Clipboard read blocked. Paste manually with Ctrl/Cmd+V into the token field.",
            });
            return;
        }
        setInput(text);
    }), [store]);
    /** Pull whatever's on the clipboard into the refresh-token textarea. */
    const pasteRefreshTokenFromClipboard = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        const text = yield readFromClipboard();
        if (!mountedRef.current)
            return;
        if (text == null) {
            store.addNotification({
                type: "error",
                message: "Clipboard read blocked. Paste manually with Ctrl/Cmd+V into the refresh-token field.",
            });
            return;
        }
        setRtInput(text);
        setRtExtracted({ source: null, fields: [] });
        setRtExtractWarning(null);
    }), [store]);
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
            var _a, _b;
            // Text query
            if (q) {
                const hit = ((_a = a.name) !== null && _a !== void 0 ? _a : "").toLowerCase().includes(q) ||
                    ((_b = a.upn) !== null && _b !== void 0 ? _b : "").toLowerCase().includes(q) ||
                    a.oid.toLowerCase().includes(q) ||
                    a.tenantId.toLowerCase().includes(q) ||
                    a.homeAccountId.toLowerCase().includes(q) ||
                    a.audiences.some((bucket) => bucket.toLowerCase().includes(q));
                if (!hit)
                    return false;
            }
            // Audience / expiry chip filter
            if (audienceFilter) {
                const myTokens = allTokens.filter((t) => t.homeAccountId === a.homeAccountId);
                if (audienceFilter === "expiring") {
                    if (!myTokens.some((t) => t.expiresAt > 0 &&
                        t.expiresAt >= now &&
                        t.expiresAt < fiveMin)) {
                        return false;
                    }
                }
                else if (audienceFilter === "expired") {
                    if (!myTokens.some((t) => t.expiresAt > 0 && t.expiresAt < now)) {
                        return false;
                    }
                }
                else if (!a.audiences.includes(audienceFilter)) {
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
        const perAudience = {
            arm: 0,
            graph: 0,
            batch: 0,
            devops: 0,
            unknown: 0,
        };
        for (const t of allTokens) {
            perAudience[t.audience] += 1;
            if (t.expiresAt > 0 && t.expiresAt < now)
                expired += 1;
            else if (t.expiresAt > 0 && t.expiresAt < fiveMin)
                expiringSoon += 1;
        }
        return {
            accessTokens: allTokens.length,
            refreshTokens: refreshTokens.length,
            expiringSoon,
            expired,
            perAudience,
        };
    }, [allTokens, refreshTokens]);
    const exportRows = React.useMemo(() => {
        const visibleIds = new Set(filteredAccounts.map((a) => a.homeAccountId));
        const now = Math.floor(Date.now() / 1000);
        const rtByAccount = new Map(refreshTokens.map((r) => [r.homeAccountId, r]));
        return allTokens
            .filter((t) => visibleIds.has(t.homeAccountId))
            .map((t) => {
            var _a, _b, _c;
            const rt = rtByAccount.get(t.homeAccountId);
            return {
                homeAccountId: t.homeAccountId,
                tenantId: t.tenantId,
                oid: t.oid,
                upn: (_a = t.upn) !== null && _a !== void 0 ? _a : "",
                name: (_b = t.name) !== null && _b !== void 0 ? _b : "",
                audience: t.audience,
                rawAudience: t.rawAudience,
                expiresAt: t.expiresAt,
                expiresAtIso: t.expiresAt > 0 ? new Date(t.expiresAt * 1000).toISOString() : "",
                expiresInSec: t.expiresAt > 0 ? t.expiresAt - now : 0,
                importedAt: t.importedAt,
                hasRefreshToken: !!rt,
                refreshTokenClientId: (_c = rt === null || rt === void 0 ? void 0 : rt.clientId) !== null && _c !== void 0 ? _c : "",
            };
        });
    }, [allTokens, filteredAccounts, refreshTokens]);
    const exportColumns = React.useMemo(() => [
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
    ], []);
    /* ---- FOCI eligibility, by refresh-token homeAccountId. We don't
     * actually need the access-token for this — the RT's own clientId
     * tells us whether it was issued by a FOCI client. If the operator
     * also has an access token cached for the same account we
     * cross-check the `azp` / `appid` claim for confidence. */
    const fociByHomeAccount = React.useMemo(() => {
        const m = new Map();
        for (const r of refreshTokens) {
            // Synthesise a minimal claim object from the RT's known clientId
            // — detectFociEligibility doesn't care about the rest.
            const synthClaims = { azp: r.clientId };
            let result = detectFociEligibility(synthClaims);
            // Cross-check against any cached AT — if its azp/appid disagrees
            // with the RT's clientId (unusual but possible after multiple
            // FOCI exchanges), prefer the AT's claim.
            const at = allTokens.find((t) => t.homeAccountId === r.homeAccountId);
            if (at) {
                const atClaims = decodeJwtPayload(at.accessToken);
                if (atClaims) {
                    const atResult = detectFociEligibility(atClaims);
                    if (atResult.eligible)
                        result = atResult;
                }
            }
            m.set(r.homeAccountId, result);
        }
        return m;
    }, [refreshTokens, allTokens]);
    /* ---- Currently-selected source RT for the FOCI exchange card.
     * Re-derived per render — guards against the selected RT being
     * dropped mid-session. */
    const fociSource = React.useMemo(() => {
        var _a;
        return (_a = refreshTokens.find((r) => r.homeAccountId === fociSourceAccountId)) !== null && _a !== void 0 ? _a : null;
    }, [refreshTokens, fociSourceAccountId]);
    const fociSourceFoci = fociSource
        ? fociByHomeAccount.get(fociSource.homeAccountId)
        : undefined;
    /* ---- Render --------------------------------------------------- */
    // Build the confirmation-dialog props once per render so the JSX
    // below stays compact. The dialog is always mounted; visibility
    // is driven by the `pendingConfirm` discriminated union above.
    const confirmDialogProps = React.useMemo(() => {
        var _a, _b;
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
                message: `Drop the refresh token for ${(_a = e.upn) !== null && _a !== void 0 ? _a : e.oid}? Cached access tokens (if any) stay until they expire.`,
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
                message: `Drop every imported token for ${(_b = a.upn) !== null && _b !== void 0 ? _b : a.oid}? This won't affect any other Azure login.`,
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
        // drop-all — type-to-confirm to guard against single mis-click /
        // adversary cleanup.
        const challengeOk = dropAllConfirmText.trim().toUpperCase() === "DROP";
        return {
            hidden: false,
            title: "Drop every imported token?",
            message: (React.createElement("div", { className: "flex flex-col gap-2 text-sm" },
                React.createElement("span", null,
                    "Drop EVERY imported token? MSAL-based signed-in accounts are not affected. ",
                    React.createElement("strong", null, "This action is unrecoverable.")),
                React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    "Affected: ",
                    accounts.length,
                    " account",
                    accounts.length === 1 ? "" : "s",
                    " \u00B7 ",
                    stats.accessTokens,
                    " access token",
                    stats.accessTokens === 1 ? "" : "s",
                    " \u00B7",
                    " ",
                    stats.refreshTokens,
                    " refresh token",
                    stats.refreshTokens === 1 ? "" : "s",
                    "."),
                React.createElement("label", { className: "flex flex-col gap-1 text-2xs" },
                    "Type ",
                    React.createElement("code", { className: "font-mono" }, "DROP"),
                    " to confirm:",
                    React.createElement(Input, { value: dropAllConfirmText, onChange: (e) => setDropAllConfirmText(e.target.value), placeholder: "DROP", className: "font-mono text-xs", spellCheck: false, autoComplete: "off", autoFocus: true, "aria-label": "Type DROP to confirm dropping every imported token" })))),
            confirmText: challengeOk ? "Drop all" : "Type DROP to confirm",
            onConfirm: () => {
                if (!challengeOk)
                    return;
                confirmClearAll();
                close();
            },
            onCancel: close,
        };
    }, [
        pendingConfirm,
        stats.expired,
        stats.accessTokens,
        stats.refreshTokens,
        accounts.length,
        dropAllConfirmText,
        confirmRemoveRefresh,
        confirmRemoveAccount,
        confirmClearAll,
        confirmDropExpired,
    ]);
    // Ctrl/Cmd+Enter to submit the focused textarea.
    const handleAccessTokenKeyDown = React.useCallback((e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && preview) {
            e.preventDefault();
            handleImport();
        }
    }, [preview, handleImport]);
    const handleRefreshTokenKeyDown = React.useCallback((e) => {
        if ((e.ctrlKey || e.metaKey) &&
            e.key === "Enter" &&
            rtPlanValid &&
            !rtSubmitting) {
            e.preventDefault();
            void submitRefreshToken();
        }
    }, [rtPlanValid, rtSubmitting, submitRefreshToken]);
    /* ---- Per-row bulk-input Ctrl+Enter handler -----------------------
     * Ctrl/Cmd+Enter   → commit the staged batch.
     * Esc              → clear the paste buffer + result rows (operator
     *                    nuke-button for a wrong paste; nothing leaks).
     * Shift+Esc        → reserved as no-op so the operator can dismiss
     *                    OS-level autocomplete without losing context. */
    const handleBulkKeyDown = React.useCallback((e) => {
        if ((e.ctrlKey || e.metaKey) &&
            e.key === "Enter" &&
            bulkPlan.importableCount > 0 &&
            !bulkBusy) {
            e.preventDefault();
            void runBulkImport();
            return;
        }
        if (e.key === "Escape" && !e.shiftKey && bulkInput.length > 0 && !bulkBusy) {
            e.preventDefault();
            setBulkInput("");
            setBulkRows([]);
        }
    }, [bulkPlan.importableCount, bulkBusy, runBulkImport, bulkInput.length]);
    return (React.createElement("div", { className: "flex flex-col gap-4 py-2" },
        React.createElement(PageHeader, { title: "Token Importer", description: "Paste a bearer token from any Azure login (e.g. portal.azure.com) and use it as this app's credential. Bypasses MSAL entirely \u2014 useful when AAD restrictions block PKCE from this origin." }),
        React.createElement(Card, { className: "border-primary/30" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(ClipboardPaste, { className: "h-4 w-4 text-primary" }),
                    "Grab a token from portal.azure.com"),
                React.createElement(CardDescription, null,
                    "Open",
                    " ",
                    React.createElement("a", { href: "https://portal.azure.com", target: "_blank", rel: "noopener noreferrer", className: "inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" },
                        "portal.azure.com",
                        React.createElement(ExternalLink, { className: "h-3 w-3" })),
                    " ",
                    "in another tab. Open DevTools (F12) \u2192 Console. Paste this snippet, hit enter. The first token is copied to your clipboard and every token is logged so you can pick a specific audience (ARM / Graph / Batch). Then come back here and paste the JWT into the form below.")),
            React.createElement(CardContent, { className: "flex flex-col gap-2" },
                React.createElement("pre", { className: "max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[10px] leading-tight" }, PORTAL_SNIPPET),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: () => void copySnippet() },
                        snippetCopied ? React.createElement(Check, null) : React.createElement(Copy, null),
                        snippetCopied ? "Copied" : "Copy snippet"),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Then paste the resulting JWT into the access-token form below (or use Ctrl/Cmd+V into the field).")))),
        React.createElement(Card, { className: "border-primary/30" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Plus, { className: "h-4 w-4 text-primary" }),
                    "Bulk paste \u2014 multi-line JWT import",
                    React.createElement(InfoTooltip, { ariaLabel: "About bulk paste", content: "Paste a newline-separated list of JWTs (e.g. the output of the portal-snippet at the top, which already joins every cached token with \\\\n). Each line is parsed independently; the table below shows per-line outcome. Cancellable mid-batch; nothing is committed until you click 'Import all'." }),
                    trustedTenants.length > 0 && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                        React.createElement(ShieldCheck, { className: "h-3 w-3" }),
                        " ",
                        trustedTenants.length,
                        " trusted tenant",
                        trustedTenants.length === 1 ? "" : "s")),
                    blockedTenants.length > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs", title: "Tenants you have explicitly marked as untrusted. Imports targeting these are tagged as overrides in the audit log." },
                        React.createElement(AlertTriangle, { className: "h-3 w-3" }),
                        " ",
                        blockedTenants.length,
                        " blocked"))),
                React.createElement(CardDescription, null,
                    "One JWT per line \u2014 empty lines and",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "Bearer "),
                    " prefixes are tolerated. Press",
                    " ",
                    React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 py-0.5 text-2xs" }, "Ctrl"),
                    "+",
                    React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 py-0.5 text-2xs" }, "Enter"),
                    " ",
                    "to commit the staged batch.")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("textarea", { id: "bulk-paste-access-tokens", value: bulkInput, onChange: (e) => setBulkInput(e.target.value), onKeyDown: handleBulkKeyDown, placeholder: "eyJ0eXAi…\neyJ0eXAi…\nBearer eyJ0eXAi…\n# (one JWT per line)", rows: 5, className: "flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Paste multiple JWT bearer tokens, one per line", spellCheck: false, autoComplete: "off" }),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "default", onClick: () => void runBulkImport(), disabled: bulkPlan.importableCount === 0 || bulkBusy, loading: bulkBusy, "aria-label": `Import ${bulkPlan.importableCount} staged token${bulkPlan.importableCount === 1 ? "" : "s"}` },
                        !bulkBusy && React.createElement(CheckCircle2, null),
                        "Import all (",
                        bulkPlan.importableCount,
                        ")"),
                    bulkBusy && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: cancelBulkImport, "aria-label": "Cancel in-flight bulk import" },
                        React.createElement(X, null),
                        "Cancel")),
                    bulkInput.length > 0 && !bulkBusy && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearBulkInput, "aria-label": "Clear bulk paste input and results" },
                        React.createElement(X, null),
                        "Clear")),
                    bulkPlan.totalLines > 0 && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        bulkPlan.totalLines,
                        " line",
                        bulkPlan.totalLines === 1 ? "" : "s",
                        " · ",
                        bulkPlan.importableCount,
                        " importable",
                        bulkPlan.duplicateCount > 0
                            ? ` · ${bulkPlan.duplicateCount} duplicate${bulkPlan.duplicateCount === 1 ? "" : "s"}`
                            : "",
                        bulkPlan.unknownAudienceCount > 0
                            ? ` · ${bulkPlan.unknownAudienceCount} unknown audience`
                            : ""))),
                bulkPlan.rows.length > 0 && (React.createElement("div", { className: "max-h-64 overflow-auto rounded-md border border-border bg-muted/20 p-2 text-2xs", role: "region", "aria-label": "Per-line bulk import preview and results" },
                    React.createElement("table", { className: "w-full" },
                        React.createElement("thead", { className: "sticky top-0 bg-muted/40 text-left" },
                            React.createElement("tr", null,
                                React.createElement("th", { className: "px-1 py-0.5 font-medium" }, "#"),
                                React.createElement("th", { className: "px-1 py-0.5 font-medium" }, "Line"),
                                React.createElement("th", { className: "px-1 py-0.5 font-medium" }, "Audience"),
                                React.createElement("th", { className: "px-1 py-0.5 font-medium" }, "Identity"),
                                React.createElement("th", { className: "px-1 py-0.5 font-medium" }, "Tenant"),
                                React.createElement("th", { className: "px-1 py-0.5 font-medium" }, "Expires"),
                                React.createElement("th", { className: "px-1 py-0.5 font-medium" }, "Status"))),
                        React.createElement("tbody", null, (bulkBusy || bulkRows.length > 0
                            ? bulkRows
                            : bulkPlan.rows).map((row) => {
                            var _a, _b;
                            const p = row.preview;
                            const trustOk = p && trustedTenantSet.size > 0
                                ? trustedTenantSet.has(p.tenantId.toLowerCase())
                                : null;
                            const blocked = p && blockedTenantSet.has(p.tenantId.toLowerCase());
                            return (React.createElement("tr", { key: row.key, className: "border-t border-border/40 align-top " +
                                    (blocked
                                        ? "bg-destructive/5"
                                        : row.goldenSaml
                                            ? "bg-destructive/5"
                                            : row.highValue
                                                ? "bg-warning/5"
                                                : "") },
                                React.createElement("td", { className: "px-1 py-0.5 font-mono text-muted-foreground" }, row.lineNo),
                                React.createElement("td", { className: "px-1 py-0.5 font-mono" }, row.maskedLine),
                                React.createElement("td", { className: "px-1 py-0.5" }, p ? (React.createElement("span", { className: "inline-flex flex-wrap items-center gap-1" },
                                    React.createElement(Badge, { variant: p.audience === "unknown"
                                            ? "destructive"
                                            : "outline", className: "text-2xs", title: AUDIENCE_HINT[p.audience] }, AUDIENCE_SHORT[p.audience]),
                                    row.highValue && (React.createElement(Badge, { variant: "warning", className: "text-2xs", title: `High-value resource: ${row.highValue.rationale}` },
                                        React.createElement(Shield, { className: "h-3 w-3" }),
                                        "high-value")),
                                    row.goldenSaml && (React.createElement(Badge, { variant: "destructive", className: "text-2xs", title: "amr contains urn:oasis:names:tc:SAML:2.0:cm:bearer \u2014 Golden SAML provenance signal. Verify origin before vaulting. Ref: New folder/_analysis_aadinternals.md" },
                                        React.createElement(AlertTriangle, { className: "h-3 w-3" }),
                                        "Golden SAML?")))) : (React.createElement("span", { className: "text-muted-foreground" }, "\u2014"))),
                                React.createElement("td", { className: "px-1 py-0.5" }, p ? (_b = (_a = p.upn) !== null && _a !== void 0 ? _a : p.name) !== null && _b !== void 0 ? _b : p.oid.slice(0, 12) : "—"),
                                React.createElement("td", { className: "px-1 py-0.5" }, p ? (React.createElement("span", { className: "inline-flex items-center gap-1" },
                                    React.createElement("code", { className: "font-mono" },
                                        p.tenantId.slice(0, 8),
                                        "\u2026"),
                                    trustOk === true && (React.createElement(ShieldCheck, { className: "h-3 w-3 text-success", "aria-label": "Trusted tenant" })),
                                    trustOk === false && (React.createElement(AlertTriangle, { className: "h-3 w-3 text-warning", "aria-label": "Tenant not in trusted allowlist" })),
                                    blocked && (React.createElement(Badge, { variant: "destructive", className: "text-2xs", title: "Tenant is in your blocklist \u2014 import will be tagged as override in the audit log." }, "blocked")),
                                    React.createElement("button", { type: "button", onClick: () => toggleTrustedTenant(p.tenantId), className: "rounded border border-border/60 px-1 text-[9px] hover:bg-muted", "aria-label": trustedTenantSet.has(p.tenantId.toLowerCase())
                                            ? `Remove tenant ${p.tenantId} from trusted allowlist`
                                            : `Add tenant ${p.tenantId} to trusted allowlist`, title: trustedTenantSet.has(p.tenantId.toLowerCase())
                                            ? "In trusted allowlist — click to remove"
                                            : "Not in trusted allowlist — click to add" }, trustedTenantSet.has(p.tenantId.toLowerCase())
                                        ? "untrust"
                                        : "trust"),
                                    React.createElement("button", { type: "button", onClick: () => toggleBlockedTenant(p.tenantId), className: "rounded border border-border/60 px-1 text-[9px] hover:bg-muted " +
                                            (blocked
                                                ? "text-destructive"
                                                : "text-muted-foreground"), "aria-label": blocked
                                            ? `Remove tenant ${p.tenantId} from blocklist`
                                            : `Add tenant ${p.tenantId} to blocklist`, title: blocked
                                            ? "In blocklist — click to remove"
                                            : "Not in blocklist — click to add (does NOT block import; tags audit log)" }, blocked ? "unblock" : "block"))) : ("—")),
                                React.createElement("td", { className: "px-1 py-0.5" }, p ? fmtExpiresIn(p.expiresAt) : "—"),
                                React.createElement("td", { className: "px-1 py-0.5" },
                                    row.status === "imported" && (React.createElement(Badge, { variant: "success", className: "text-2xs" },
                                        React.createElement(Check, { className: "h-3 w-3" }),
                                        " imported")),
                                    row.status === "failed" && (React.createElement(Badge, { variant: "destructive", className: "text-2xs", title: row.reason },
                                        React.createElement(X, { className: "h-3 w-3" }),
                                        " failed")),
                                    row.status === "skipped" && (React.createElement(Badge, { variant: "warning", className: "text-2xs", title: row.reason }, "skipped")),
                                    row.status === "pending" &&
                                        (p ? (React.createElement(Badge, { variant: "secondary", className: "text-2xs", title: "Will import when you click 'Import all'" }, "ready")) : (React.createElement(Badge, { variant: "outline", className: "text-2xs", title: row.reason }, "no parse"))))));
                        }))))),
                bulkPlan.unknownAudienceCount > 0 && (React.createElement(Alert, { variant: "warning" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "text-2xs" },
                        bulkPlan.unknownAudienceCount,
                        " token",
                        bulkPlan.unknownAudienceCount === 1 ? "" : "s",
                        " target an unrecognised audience. They will import but no page will auto-route on them.",
                        " ",
                        React.createElement("button", { type: "button", className: "underline-offset-2 hover:underline", onClick: () => navigateToPage("/audience-matrix") }, "Open audience-matrix"),
                        " ",
                        "to see what coverage looks like after import."))),
                bulkPlan.totalLines > BULK_HARVEST_THRESHOLD && (React.createElement(Alert, { variant: "warning" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "text-2xs" },
                        React.createElement("strong", null,
                            "Harvest-shaped paste detected (",
                            bulkPlan.totalLines,
                            " tokens)."),
                        " ",
                        "A real single-user portal session caches at most ~8 distinct access tokens (one per (tenant, resource) tuple). Pasting",
                        " ",
                        bulkPlan.totalLines,
                        " suggests this came from a multi-account cache, a credential-harvest dump, or another aggregation \u2014 confirm you intend to vault every entry before clicking Import. Reference:",
                        " ",
                        React.createElement("code", { className: "font-mono" }, "New folder/_AZURE_LOGIN_METHODS.md"),
                        " ",
                        "(MSAL cache shape)."))),
                bulkPlan.highValueCount > 0 && (React.createElement(Alert, { variant: "warning" },
                    React.createElement(Shield, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "text-2xs" },
                        React.createElement("strong", null,
                            bulkPlan.highValueCount,
                            " high-value token",
                            bulkPlan.highValueCount === 1 ? "" : "s",
                            " in this batch."),
                        " ",
                        "The decoded ",
                        React.createElement("code", { className: "font-mono" }, "aud"),
                        " claim resolves to one of the five tenant-wide resource servers (ARM, Graph, AAD Graph, Key Vault, Azure Storage). These unlock control-plane or data-plane abuse if the source principal is privileged. Per-row badges below mark which. Reference:",
                        " ",
                        React.createElement("code", { className: "font-mono" }, "New folder/_analysis_dirkjanm.md"),
                        " ",
                        "(roadtx describe \u2014 high-value audiences)."))),
                bulkPlan.goldenSamlCount > 0 && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "text-2xs" },
                        React.createElement("strong", null,
                            bulkPlan.goldenSamlCount,
                            " token",
                            bulkPlan.goldenSamlCount === 1 ? "" : "s",
                            " carry the SAML 2.0 ",
                            React.createElement("code", { className: "font-mono" }, "cm:bearer"),
                            " claim."),
                        " ",
                        "That URI is the subject-confirmation method emitted by AADInternals'",
                        " ",
                        React.createElement("code", { className: "font-mono" }, "New-SAMLToken"),
                        " /",
                        " ",
                        React.createElement("code", { className: "font-mono" }, "New-SAML2Token"),
                        " when the attacker forges a SAML assertion (Golden SAML). Its presence is a strong signal the token was minted via a stolen ADFS Token-Signing certificate \u2014 verify provenance before vaulting. Reference:",
                        " ",
                        React.createElement("code", { className: "font-mono" }, "New folder/_analysis_aadinternals.md"),
                        " ",
                        "(lines 80, 273)."))),
                bulkPlan.blockedTenantCount > 0 && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "text-2xs" },
                        React.createElement("strong", null,
                            bulkPlan.blockedTenantCount,
                            " token",
                            bulkPlan.blockedTenantCount === 1 ? "" : "s",
                            " target a tenant in your blocklist."),
                        " ",
                        "Imports are NOT auto-rejected (AAD owns authorization) but every row tagged \"blocked tenant\" below records an override in the audit log. Either remove the tenant from the blocklist or skip those rows."))),
                React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only" }, bulkRows.length > 0 && !bulkBusy
                    ? `Bulk import complete. ${bulkRows.filter((r) => r.status === "imported").length} imported, ${bulkRows.filter((r) => r.status === "failed").length} failed, ${bulkRows.filter((r) => r.status === "skipped").length} skipped.`
                    : bulkBusy
                        ? "Bulk import in progress."
                        : ""))),
        React.createElement(Card, { className: "border-primary/30" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Key, { className: "h-4 w-4 text-primary" }),
                    "Paste access token",
                    React.createElement(InfoTooltip, { content: "An Azure-issued JWT (three base64url segments separated by dots). The audience claim determines which API surface the token can call: ARM, Graph, or Batch. We decode locally \u2014 the JWT signature is NOT verified (Azure verifies on every API call instead).", ariaLabel: "About access tokens" })),
                React.createElement(CardDescription, null,
                    "One JWT at a time. Pastes like ",
                    React.createElement("code", { className: "font-mono" }, "Bearer eyJ\u2026"),
                    " are tolerated. Press ",
                    React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 py-0.5 text-2xs" }, "Ctrl"),
                    "+",
                    React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 py-0.5 text-2xs" }, "Enter"),
                    " to import.")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("textarea", { id: "paste-access-token", value: input, onChange: (e) => setInput(e.target.value), onKeyDown: handleAccessTokenKeyDown, placeholder: "eyJ0eXAiOiJKV1QiLCJhbGciOi\u2026", rows: 5, className: "flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Paste access token JWT", "aria-invalid": input.length > 0 && !preview ? true : undefined, spellCheck: false, autoComplete: "off" }),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => void pasteAccessTokenFromClipboard() },
                        React.createElement(ClipboardPaste, null),
                        "Paste from clipboard"),
                    input.length > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => {
                            setInput("");
                            setSubmitError(null);
                        } },
                        React.createElement(X, null),
                        "Clear")),
                    input.length > 0 && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        input.length.toLocaleString(),
                        " chars"))),
                input.length > 0 && !preview && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, null,
                        "Could not decode that input as a JWT. Expected the full token (three dot-separated base64url segments containing",
                        React.createElement("code", { className: "ml-1 font-mono" }, "oid"),
                        " +",
                        React.createElement("code", { className: "ml-1 font-mono" }, "tid"),
                        " claims)."))),
                preview && (React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(User, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                        React.createElement("span", { className: "font-medium" }, (_b = (_a = preview.name) !== null && _a !== void 0 ? _a : preview.upn) !== null && _b !== void 0 ? _b : preview.oid),
                        preview.upn && preview.name && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, preview.upn)),
                        React.createElement(Badge, { variant: preview.audience === "unknown" ? "destructive" : "outline", className: "text-2xs", title: AUDIENCE_HINT[preview.audience] }, AUDIENCE_LABELS[preview.audience]),
                        React.createElement(Badge, { variant: preview.expiresAt > 0 &&
                                preview.expiresAt < Math.floor(Date.now() / 1000)
                                ? "destructive"
                                : preview.expiresAt > 0 &&
                                    preview.expiresAt <
                                        Math.floor(Date.now() / 1000) + 5 * 60
                                    ? "warning"
                                    : "secondary", className: "text-2xs" },
                            React.createElement(Clock, { className: "h-3 w-3" }),
                            " ",
                            fmtExpiresIn(preview.expiresAt)),
                        preview.audience === "unknown" && (React.createElement("span", { className: "text-2xs text-destructive" }, "No automatic routing \u2014 pages will fall back to MSAL."))),
                    React.createElement("dl", { className: "grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[10px]" },
                        React.createElement("dt", { className: "inline-flex items-center gap-1 text-muted-foreground" },
                            "oid",
                            React.createElement(InfoTooltip, { content: "AAD object id of the principal that owns this token (user, service principal, or managed identity). Combined with `tid` it uniquely identifies the principal across all of Azure.", ariaLabel: "About the oid claim" })),
                        React.createElement("dd", { className: "break-all" },
                            React.createElement(CopyableText, { value: preview.oid, mono: true, ariaLabel: "Copy oid claim" })),
                        React.createElement("dt", { className: "inline-flex items-center gap-1 text-muted-foreground" },
                            "tid",
                            React.createElement(InfoTooltip, { content: "AAD tenant id (`tid` claim) where the principal lives. Cross-tenant calls work but the token's tenant determines which directory's RBAC applies.", ariaLabel: "About the tid claim" })),
                        React.createElement("dd", { className: "break-all" },
                            React.createElement(CopyableText, { value: preview.tenantId, mono: true, ariaLabel: "Copy tenant id" })),
                        React.createElement("dt", { className: "inline-flex items-center gap-1 text-muted-foreground" },
                            "aud",
                            React.createElement(InfoTooltip, { content: "Raw 'aud' claim from the JWT \u2014 the AAD-issued audience (resource the token is valid for). The WebUI maps this onto canonical buckets (ARM / Graph / Batch) for routing.", ariaLabel: "About the audience claim" })),
                        React.createElement("dd", { className: "break-all" },
                            React.createElement(CopyableText, { value: preview.rawAudience, mono: true, ariaLabel: "Copy raw audience claim" })),
                        typeof preview.claims.scp === "string" && (React.createElement(React.Fragment, null,
                            React.createElement("dt", { className: "inline-flex items-center gap-1 text-muted-foreground" },
                                "scp",
                                React.createElement(InfoTooltip, { content: "OAuth scope(s) (`scp` claim) consented to when this token was issued. Each space-separated value is one permission the token can exercise against the audience.", ariaLabel: "About the scope claim" })),
                            React.createElement("dd", { className: "break-all" },
                                React.createElement(CopyableText, { value: preview.claims.scp, mono: true, ariaLabel: "Copy scope claim" })))),
                        typeof preview.claims.appid === "string" && (React.createElement(React.Fragment, null,
                            React.createElement("dt", { className: "inline-flex items-center gap-1 text-muted-foreground" },
                                "appid",
                                React.createElement(InfoTooltip, { content: "Client application id (`appid` / `azp`) \u2014 the AAD app registration that requested the token. Must match the `client_id` you use to redeem an accompanying refresh token.", ariaLabel: "About the appid claim" })),
                            React.createElement("dd", { className: "break-all" },
                                React.createElement(CopyableText, { value: preview.claims.appid, mono: true, ariaLabel: "Copy appid claim" }))))),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2 border-t border-border/60 pt-2" },
                        React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-6 text-2xs", onClick: () => toggleClaims("preview"), "aria-expanded": !!expandedClaims.preview },
                            expandedClaims.preview ? (React.createElement(ChevronDown, { className: "h-3 w-3" })) : (React.createElement(ChevronRight, { className: "h-3 w-3" })),
                            React.createElement(Braces, { className: "h-3 w-3" }),
                            expandedClaims.preview
                                ? "Hide decoded claims"
                                : "Show all decoded claims")),
                    expandedClaims.preview && (React.createElement(ClaimsGrid, { claims: preview.claims, maxHeight: "18rem" })))),
                submitError && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertDescription, null, submitError))),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "default", onClick: handleImport, disabled: !preview, "aria-label": "Import pasted access token" },
                        React.createElement(CheckCircle2, null),
                        "Import token"),
                    preview && preview.audience === "unknown" && (React.createElement("span", { className: "text-2xs text-warning" }, "Importing anyway \u2014 token will sit in the store but no page will auto-pick it."))))),
        React.createElement(Card, { className: "border-success/30 bg-success/5" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(KeyRound, { className: "h-4 w-4 text-success" }),
                    "Refresh token (recommended \u2014 works in all scopes)",
                    React.createElement(InfoTooltip, { content: "AAD refresh tokens (RT) can be redeemed at the token endpoint for an access token in ANY scope you previously consented to \u2014 so a single RT covers ARM + Graph + Batch. Access tokens last ~60-90 minutes; RTs last 90 days (sliding window) by default.", ariaLabel: "About refresh tokens" })),
                React.createElement(CardDescription, null,
                    "Paste an Azure-issued refresh token + the client id it was minted for. The WebUI will redeem it at AAD's",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "/oauth2/v2.0/token"),
                    " endpoint to mint access tokens for any scope (ARM, Graph, Batch) on demand \u2014 no need to paste a separate access token per audience, and tokens auto-rotate when they expire. Press",
                    " ",
                    React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 py-0.5 text-2xs" }, "Ctrl"),
                    "+",
                    React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 py-0.5 text-2xs" }, "Enter"),
                    " ",
                    "to import.")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "inline-flex items-center gap-1 text-xs" },
                        "Refresh token *",
                        React.createElement(InfoTooltip, { content: "An AAD-issued refresh_token (opaque long string, NOT a JWT). The WebUI redeems it via AAD's token endpoint to mint access tokens for any scope you previously consented to. Rotated on every redemption \u2014 keep this tab open or re-paste when needed.", ariaLabel: "About refresh tokens" })),
                    React.createElement("textarea", { value: rtInput, onChange: (e) => {
                            setRtInput(e.target.value);
                            setRtExtracted({ source: null, fields: [] });
                            setRtExtractWarning(null);
                        }, onKeyDown: handleRefreshTokenKeyDown, placeholder: "0.AVoA\u2026  (long opaque string, NOT a JWT). You can also paste an entire token-endpoint response body, curl --data-raw command, or PowerShell Invoke-RestMethod snippet \u2014 we'll pull refresh_token / client_id / tenant out automatically.", rows: 3, className: "flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Paste refresh token, request body, curl command, or PowerShell snippet", spellCheck: false, autoComplete: "off" }),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => void pasteRefreshTokenFromClipboard() },
                            React.createElement(ClipboardPaste, null),
                            "Paste from clipboard"),
                        rtInput.length > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => {
                                setRtInput("");
                                setRtExtracted({ source: null, fields: [] });
                                setRtExtractWarning(null);
                            } },
                            React.createElement(X, null),
                            "Clear")),
                        rtInput.length > 0 && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                            rtInput.length.toLocaleString(),
                            " chars"))),
                    React.createElement("p", { className: "inline-flex items-center gap-1 text-2xs text-muted-foreground" },
                        React.createElement("span", null,
                            "Accepts a bare RT, a form-encoded POST body (",
                            React.createElement("code", { className: "font-mono" }, "refresh_token=\u2026&client_id=\u2026"),
                            "), a JSON token-endpoint response, a",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "curl --data-raw '\u2026'"),
                            " ",
                            "command, or a PowerShell",
                            " ",
                            React.createElement("code", { className: "font-mono" },
                                "Invoke-RestMethod -Body @",
                                `{`,
                                " \u2026 ",
                                `}`),
                            " ",
                            "hash. Companion fields below auto-fill on submit when extracted from the paste."),
                        React.createElement(InfoTooltip, { content: "Auto-extraction looks for refresh_token, client_id, tenant url, scope, and resource inside the paste. If it finds them, it fills in the fields below and surfaces an alert so you know what we changed.", ariaLabel: "About form body and curl auto-extract" })),
                    rtExtracted.source && (React.createElement(Alert, null,
                        React.createElement(Zap, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "text-2xs" },
                            "Auto-extracted from ",
                            rtExtracted.source.toUpperCase(),
                            " ",
                            "paste: ",
                            React.createElement("code", { className: "font-mono" }, rtExtracted.fields.join(", ")),
                            ".",
                            " ",
                            "Client id and tenant id below were updated to match."))),
                    rtExtractWarning && (React.createElement(Alert, { variant: "warning" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "text-2xs" }, rtExtractWarning)))),
                React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { className: "inline-flex items-center gap-1 text-xs" },
                            "Client id that issued it *",
                            React.createElement(InfoTooltip, { content: "AAD app registration id that minted the refresh token. AAD rejects with invalid_grant if this doesn't match the original issuer. Common defaults: Azure CLI = 04b07795-8ddb-461a-bbee-02f9e1bf7b46; Azure portal = c44b4083-3bb0-49c1-b47d-974e53cbdf3c; az PowerShell = 1950a258-227b-4e31-a9cf-717495945fc2.", ariaLabel: "About the issuer client id" })),
                        React.createElement(Input, { value: rtClientId, onChange: (e) => setRtClientId(e.target.value), placeholder: "04b07795-\u2026 (Azure CLI default)", className: "font-mono text-xs", "aria-invalid": rtClientId.length > 0 &&
                                !guidRe.test(rtClientId.trim())
                                ? true
                                : undefined, spellCheck: false, autoComplete: "off" }),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-1 text-2xs text-muted-foreground" },
                            React.createElement("span", null, "Quick-fill:"),
                            React.createElement("button", { type: "button", className: "rounded border border-border bg-background px-1 py-0.5 font-mono hover:bg-muted", onClick: () => setRtClientId("04b07795-8ddb-461a-bbee-02f9e1bf7b46"), title: "Azure CLI default client id" }, "Azure CLI"),
                            React.createElement("button", { type: "button", className: "rounded border border-border bg-background px-1 py-0.5 font-mono hover:bg-muted", onClick: () => setRtClientId("c44b4083-3bb0-49c1-b47d-974e53cbdf3c"), title: "Azure portal client id" }, "Portal"),
                            React.createElement("button", { type: "button", className: "rounded border border-border bg-background px-1 py-0.5 font-mono hover:bg-muted", onClick: () => setRtClientId("1950a258-227b-4e31-a9cf-717495945fc2"), title: "Azure PowerShell client id" }, "Az PowerShell"))),
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { className: "inline-flex items-center gap-1 text-xs" },
                            "Tenant id *",
                            React.createElement(InfoTooltip, { content: "GUID of the AAD tenant where the principal lives. Auto-filled from the optional id_token below, or from the tenant URL in a curl/JSON paste. Required \u2014 AAD rejects redemption attempts without it.", ariaLabel: "About the tenant id field" })),
                        React.createElement(Input, { value: rtTenantId, onChange: (e) => setRtTenantId(e.target.value), placeholder: rtIdentity.hasIdToken && rtIdentity.tid
                                ? `${rtIdentity.tid} (from id_token)`
                                : "tenant guid", className: "font-mono text-xs", "aria-invalid": rtTenantId.length > 0 && !guidRe.test(rtTenantId.trim())
                                ? true
                                : undefined, spellCheck: false, autoComplete: "off" }),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" }, rtIdentity.hasIdToken && rtIdentity.tid && !rtTenantId.trim() ? (React.createElement(React.Fragment, null,
                            "Using ",
                            React.createElement("code", { className: "font-mono" }, rtIdentity.tid),
                            " ",
                            "from the id_token below (type here to override).")) : ("Auto-filled from the optional id_token below, or from a tenant URL in your paste.")))),
                React.createElement("details", { className: "rounded-md border border-border/60 bg-muted/30 p-3" },
                    React.createElement("summary", { className: "cursor-pointer text-2xs font-medium uppercase tracking-wide text-muted-foreground" }, "Optional: paste id_token to auto-fill tenant + identity"),
                    React.createElement("textarea", { value: rtIdToken, onChange: (e) => setRtIdToken(e.target.value), placeholder: "eyJ0eXAiOiJKV1QiLCJhbGciOi\u2026", rows: 3, className: "mt-2 flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[10px]", spellCheck: false, autoComplete: "off" }),
                    rtIdentity.tid && (React.createElement("p", { className: "mt-2 text-2xs text-muted-foreground" },
                        "Identity: ", (_d = (_c = rtIdentity.name) !== null && _c !== void 0 ? _c : rtIdentity.upn) !== null && _d !== void 0 ? _d : rtIdentity.oid,
                        " · tenant ",
                        React.createElement("code", { className: "font-mono" }, rtIdentity.tid)))),
                rtStatus && (React.createElement(Alert, null,
                    React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin" }),
                    React.createElement(AlertDescription, { className: "text-2xs" }, rtStatus))),
                rtError && rtCaBlocked && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "flex flex-col gap-2" },
                        React.createElement("span", null,
                            React.createElement("strong", null, "AADSTS53003 \u2014 Conditional Access blocked this redemption."),
                            " ",
                            "Your tenant requires something (compliant device, MFA, trusted location, approved app, \u2026) that this WebUI's context can't satisfy \u2014 and CA is enforced",
                            " ",
                            React.createElement("em", null, "inside"),
                            " AAD, so there's no client-side workaround for the refresh-token grant itself."),
                        React.createElement("span", { className: "text-2xs" },
                            React.createElement("strong", null, "What to do:"),
                            " the same token-endpoint response that gave you the refresh_token also has an",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "access_token"),
                            ". That one ",
                            React.createElement("em", null, "already satisfied your CA policy at issuance time"),
                            " ",
                            "\u2014 paste it directly into the access-token form above. It will work until its ",
                            React.createElement("code", { className: "font-mono" }, "exp"),
                            " ",
                            "claim (typically ~60\u201390 minutes). When it expires, repeat the original interactive flow against your tenant to mint a fresh access_token and paste that."),
                        React.createElement("ul", { className: "ml-4 list-disc text-2xs" },
                            React.createElement("li", null,
                                "Run ",
                                React.createElement("code", { className: "font-mono" }, "az account get-access-token"),
                                " ",
                                "on a machine that satisfies CA (e.g. your corp laptop) and paste the result above."),
                            React.createElement("li", null, "Or sign into portal.azure.com on the CA-compliant device and use the portal snippet at the top of this page to extract the cached bearer."),
                            React.createElement("li", null,
                                "Or ask an admin to scope CA so it doesn't apply to the issuer client id (",
                                React.createElement("code", { className: "font-mono" },
                                    rtClientId.slice(0, 8),
                                    "\u2026"),
                                ").")),
                        React.createElement("div", null,
                            React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: () => {
                                    const el = document.getElementById("paste-access-token");
                                    if (el) {
                                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                                        el.focus();
                                    }
                                } }, "Jump to access-token form")),
                        React.createElement("span", { className: "break-all text-[10px] opacity-80" },
                            "Raw error: ",
                            rtError)))),
                rtError && rtInvalidGrant && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "flex flex-col gap-2" },
                        React.createElement("span", null,
                            React.createElement("strong", null, "AADSTS70000 \u2014 refresh token is invalid or malformed."),
                            " ",
                            "Common causes, in order of likelihood:"),
                        React.createElement("ul", { className: "ml-4 list-disc text-2xs" },
                            React.createElement("li", null,
                                React.createElement("strong", null, "Consumed + rotated."),
                                " Modern AAD rotates refresh tokens \u2014 every successful redemption returns a new RT and invalidates the previous one. If anything (CLI, IDE, another tab) used this RT after you copied it, AAD considers it dead. Capture a fresh RT and try again."),
                            React.createElement("li", null,
                                React.createElement("strong", null, "Tenant or client id mismatch."),
                                " AAD only accepts a given RT for the exact",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "client_id"),
                                " +",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "tid"),
                                " that issued it. Verify both fields above match the token's issuer (check the ",
                                React.createElement("code", { className: "font-mono" }, "appid"),
                                " /",
                                React.createElement("code", { className: "font-mono" }, "azp"),
                                " claim in any matching access token)."),
                            React.createElement("li", null,
                                React.createElement("strong", null, "Revoked or expired."),
                                " Signing out of the source session, password change, or admin revocation kills the RT. RTs also expire after 90 days of inactivity by default. Re-authenticate from the source to mint a fresh pair."),
                            React.createElement("li", null,
                                React.createElement("strong", null, "Whitespace contamination."),
                                " Copy-paste from terminal scrollback can insert invisible control characters mid-token. The WebUI strips common ones, but try re-copying with the terminal in \"select-only\" mode.")),
                        React.createElement("span", { className: "text-2xs" },
                            React.createElement("strong", null, "Workaround that always works:"),
                            " paste the associated ",
                            React.createElement("code", { className: "font-mono" }, "access_token"),
                            " ",
                            "directly into the access-token form above. It's already issued \u2014 no AAD redemption needed \u2014 and works until its ",
                            React.createElement("code", { className: "font-mono" }, "exp"),
                            " claim."),
                        React.createElement("div", null,
                            React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: () => {
                                    const el = document.getElementById("paste-access-token");
                                    if (el) {
                                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                                        el.focus();
                                    }
                                } }, "Jump to access-token form")),
                        React.createElement("span", { className: "break-all text-[10px] opacity-80" },
                            "Raw error: ",
                            rtError)))),
                rtError && !rtCaBlocked && !rtInvalidGrant && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "flex flex-col gap-1" },
                        React.createElement("span", null, rtError),
                        React.createElement("span", { className: "text-2xs opacity-80" },
                            "If this looks like a network/CORS failure rather than an AAD error code, the dev-server's",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "/api/auth/proxy-token"),
                            " ",
                            "proxy may also be unreachable. Inspect the Network tab.")))),
                React.createElement("div", null,
                    React.createElement(Button, { type: "button", variant: "default", onClick: () => void submitRefreshToken(), disabled: !rtPlanValid || rtSubmitting, loading: rtSubmitting, "aria-label": "Import refresh token and mint ARM access token" },
                        !rtSubmitting && React.createElement(KeyRound, null),
                        "Import refresh token & mint ARM access token")))),
        React.createElement(Card, { id: "foci-exchange-card", className: "border-info/30 bg-info/5" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Users, { className: "h-4 w-4 text-info" }),
                    "FOCI Exchange \u2014 mint AT for ANY family client",
                    React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                        FOCI_CLIENTS.length,
                        " clients"),
                    React.createElement(InfoTooltip, { ariaLabel: "About FOCI exchange", content: "Microsoft groups certain first-party public clients into a 'Family of Client IDs' (FOCI). A refresh token issued to ANY family member can be exchanged for an access token of ANY OTHER member without re-prompting consent. Useful when an operator's source client is restricted (e.g. Conditional Access blocks the Portal client) but a sibling FOCI client (e.g. Azure CLI) is allowed. Adopted from dirkjanm/ROADtools \u2014 we expose the primitive, not the recon workflow." })),
                React.createElement(CardDescription, null,
                    "Pick an imported refresh token + a target FOCI client and AAD will mint an access token for the target without further consent. The full list is curated from",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "secureworks/family-of-client-ids-research"),
                    " ",
                    "plus the ROADtools",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "WELLKNOWN_CLIENTS"),
                    " alias map.")),
            React.createElement(CardContent, { className: "flex flex-col gap-4" },
                React.createElement("div", { className: "flex flex-col gap-2" },
                    React.createElement(Label, { className: "inline-flex items-center gap-1 text-xs" },
                        "Source refresh token *",
                        React.createElement(InfoTooltip, { ariaLabel: "About the source refresh token", content: "The RT that AAD will spend at the token endpoint. Must have been issued to a client in the FOCI family \u2014 non-FOCI source RTs return AADSTS54005 / invalid_grant at exchange time." })),
                    refreshTokens.length === 0 ? (React.createElement(Alert, { variant: "warning" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "text-2xs" }, "No imported refresh tokens. Import one via the green card above first \u2014 Azure CLI / Azure PowerShell / Visual Studio RTs all work as FOCI sources."))) : (React.createElement(React.Fragment, null,
                        React.createElement("select", { className: "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", value: fociSourceAccountId, onChange: (e) => setFociSourceAccountId(e.target.value), "aria-label": "Source refresh token for FOCI exchange" }, refreshTokens.map((r) => {
                            var _a, _b, _c;
                            const f = fociByHomeAccount.get(r.homeAccountId);
                            const tag = (f === null || f === void 0 ? void 0 : f.eligible)
                                ? `FOCI: ${(_b = (_a = f.sourceClient) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "yes"}`
                                : "non-FOCI";
                            return (React.createElement("option", { key: r.homeAccountId, value: r.homeAccountId },
                                ((_c = r.upn) !== null && _c !== void 0 ? _c : r.oid).slice(0, 48),
                                " \u00B7",
                                " ",
                                r.clientId.slice(0, 8),
                                "\u2026 \u00B7 ",
                                tag));
                        })),
                        fociSource && fociSourceFoci && !fociSourceFoci.eligible && (React.createElement(Alert, { variant: "warning" },
                            React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                            React.createElement(AlertDescription, { className: "text-2xs" },
                                "Selected RT was issued by",
                                " ",
                                React.createElement("code", { className: "font-mono" },
                                    fociSource.clientId.slice(0, 8),
                                    "\u2026"),
                                " ",
                                "which is NOT in our FOCI list. AAD will likely reject the exchange with",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "invalid_grant"),
                                ". The exchange button is enabled anyway \u2014 AAD's FOCI list is authoritative, not ours.")))))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "inline-flex items-center gap-1 text-xs" },
                        "Requested scope *",
                        React.createElement(InfoTooltip, { ariaLabel: "About the requested scope", content: "OAuth scope to mint for. Use one of the well-known `.default` scopes for full app-permission tokens. AAD only grants what the original RT was consented for \u2014 asking for Graph from a Batch-only RT returns AADSTS65001." })),
                    React.createElement(Input, { value: fociScope, onChange: (e) => setFociScope(e.target.value), placeholder: "https://management.azure.com/.default", className: "font-mono text-xs", spellCheck: false, autoComplete: "off" }),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-1 text-2xs text-muted-foreground" },
                        React.createElement("span", null, "Quick-fill:"),
                        ["arm", "graph", "batch", "devops"].map((bucket) => (React.createElement("button", { key: bucket, type: "button", className: "rounded border border-border bg-background px-1 py-0.5 font-mono hover:bg-muted", onClick: () => setFociScope(SCOPE_FOR_AUDIENCE[bucket]), title: `${SCOPE_FOR_AUDIENCE[bucket]} — mint a ${bucket.toUpperCase()} token` }, bucket.toUpperCase()))))),
                React.createElement("div", { className: "flex flex-col gap-2" },
                    React.createElement(Label, { className: "inline-flex items-center gap-1 text-xs" },
                        "Target FOCI client",
                        React.createElement(InfoTooltip, { ariaLabel: "About the target FOCI client", content: "Which FOCI member's identity the new access token will be minted under. The `appid` / `azp` claim on the resulting token will match the chosen target. Resource servers (Graph / ARM / Batch) usually don't care about appid for delegated permissions, but some app-only authorisation policies do \u2014 pick a target whose app reg matches your downstream policy. Non-FOCI clients are shown but disabled \u2014 use device-code flow for those." })),
                    React.createElement("div", { className: "max-h-72 overflow-auto rounded-md border border-border bg-background" },
                        React.createElement("ul", { role: "radiogroup", className: "divide-y divide-border/60" }, FOCI_CLIENTS.map((c) => {
                            const selected = c.clientId === fociTargetClientId;
                            // Non-FOCI rows are visible but un-selectable — clicking
                            // them would only produce a guaranteed AADSTS54005, so
                            // we gate selection here AND on the action button.
                            const disabled = !c.isFoci;
                            return (React.createElement("li", { key: c.clientId },
                                React.createElement("button", { type: "button", role: "radio", "aria-checked": selected, "aria-disabled": disabled || undefined, disabled: disabled, onClick: () => {
                                        if (disabled)
                                            return;
                                        setFociTargetClientId(c.clientId);
                                    }, title: disabled
                                        ? "Not FOCI-eligible — use device code instead"
                                        : undefined, className: "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs transition-colors focus-visible:bg-muted focus-visible:outline-none " +
                                        (disabled
                                            ? "cursor-not-allowed opacity-60 "
                                            : "hover:bg-muted/60 ") +
                                        (selected
                                            ? "bg-info/10 ring-1 ring-inset ring-info"
                                            : "") },
                                    React.createElement("span", { className: "flex items-center gap-2" },
                                        React.createElement("span", { className: "font-medium" }, c.name),
                                        React.createElement("code", { className: "font-mono text-[10px] text-muted-foreground" },
                                            c.clientId.slice(0, 8),
                                            "\u2026"),
                                        selected && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                                            React.createElement(Check, { className: "h-3 w-3" }),
                                            " selected")),
                                        c.isFoci ? (React.createElement(Badge, { variant: "success", className: "text-2xs", title: "In the FOCI family \u2014 refresh-token exchange will be accepted by AAD" }, "FOCI")) : (React.createElement(Badge, { variant: "outline", className: "text-2xs", title: "Not FOCI-eligible \u2014 use device code instead" }, "non-FOCI"))),
                                    c.description && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, c.description)))));
                        })))),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2 border-t border-border/60 pt-3" },
                    React.createElement(Button, { type: "button", variant: "default", onClick: () => void runFociExchange(), disabled: fociExchanging ||
                            !fociSource ||
                            !fociScope.trim() ||
                            !fociTargetClientId, loading: fociExchanging, "aria-label": "Exchange refresh token for selected FOCI target" },
                        !fociExchanging && React.createElement(Network, { className: "h-4 w-4" }),
                        "Exchange RT for target"),
                    React.createElement(Button, { type: "button", variant: "outline", onClick: () => void runFociBulkMint(), disabled: fociBulkRunning ||
                            !fociSource ||
                            !fociScope.trim() ||
                            refreshTokens.length === 0, loading: fociBulkRunning, "aria-label": `Mint AT for every FOCI-eligible client (${FOCI_CLIENTS.filter((c) => c.isFoci).length} targets)`, title: "Run the exchange against every FOCI-eligible client in parallel and surface which ones accept the RT. Non-FOCI clients are skipped to avoid spending the RT on guaranteed-failure round-trips." },
                        !fociBulkRunning && React.createElement(Sparkles, { className: "h-4 w-4" }),
                        "Mint AT for every FOCI client (",
                        FOCI_CLIENTS.filter((c) => c.isFoci).length,
                        " targets)"),
                    fociResult && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => {
                            setFociResult(null);
                            setFociBulk(null);
                            setFociError(null);
                        } },
                        React.createElement(X, { className: "h-3 w-3" }),
                        " Clear results"))),
                fociError && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "flex flex-col gap-1" },
                        React.createElement("span", { className: "text-2xs font-semibold" }, "FOCI exchange failed"),
                        React.createElement("span", { className: "break-all text-2xs" }, fociError),
                        React.createElement("span", { className: "text-2xs opacity-80" },
                            "Common AAD codes: ",
                            React.createElement("code", { className: "font-mono" }, "AADSTS54005"),
                            " ",
                            "= source client isn't in the FOCI family; ",
                            React.createElement("code", { className: "font-mono" }, "AADSTS65001"),
                            " = scope was never consented for this RT; ",
                            React.createElement("code", { className: "font-mono" }, "AADSTS70000"),
                            " = RT consumed / rotated.")))),
                fociResult && (React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-success/30 bg-success/5 p-3 text-xs" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(CheckCircle2, { className: "h-4 w-4 text-success" }),
                        React.createElement("span", { className: "font-medium text-success" }, "Exchanged successfully"),
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                            "source",
                            " ",
                            React.createElement("code", { className: "font-mono" },
                                fociResult.sourceClient.slice(0, 8),
                                "\u2026")),
                        React.createElement("span", { className: "text-2xs" }, "\u2192"),
                        React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            "target ",
                            fociResult.targetClient.name),
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                            "aud",
                            " ",
                            React.createElement("code", { className: "font-mono" },
                                fociResult.result.audience.slice(0, 30),
                                fociResult.result.audience.length > 30 ? "…" : "")),
                        React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            React.createElement(Clock, { className: "h-3 w-3" }),
                            " ",
                            fociResult.result.expires_in
                                ? `${Math.floor(fociResult.result.expires_in / 60)}m`
                                : "?",
                            " ",
                            "TTL"),
                        fociResult.result.refresh_token && (React.createElement(Badge, { variant: "warning", className: "text-2xs" }, "RT rotated"))),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(CopyButton, { value: fociResult.result.access_token, ariaLabel: "Copy minted FOCI access token", alwaysVisible: true }),
                        React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", onClick: importFociResultToVault, "aria-label": "Import minted token into the vault", title: "Persist this token (and its rotated RT if any) into the imported-tokens store so other pages can use it." },
                            React.createElement(CheckCircle2, { className: "h-3 w-3" }),
                            "Import this token to vault"),
                        React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-7 text-2xs", onClick: () => setFociResultClaimsOpen((o) => !o), "aria-expanded": fociResultClaimsOpen },
                            fociResultClaimsOpen ? (React.createElement(ChevronDown, { className: "h-3 w-3" })) : (React.createElement(ChevronRight, { className: "h-3 w-3" })),
                            React.createElement(Braces, { className: "h-3 w-3" }),
                            fociResultClaimsOpen
                                ? "Hide decoded claims"
                                : "Show decoded claims")),
                    fociResultClaimsOpen && (React.createElement(ClaimsGrid, { claims: fociResult.result.claims })))),
                fociBulk && (React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-background/40 p-3 text-xs" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Sparkles, { className: "h-4 w-4 text-info" }),
                        React.createElement("span", { className: "font-medium" }, "Bulk-mint results"),
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                            fociBulk.filter((r) => r.status === "success").length,
                            " ok"),
                        React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                            fociBulk.filter((r) => r.status === "failure").length,
                            " fail")),
                    React.createElement("ul", { className: "flex max-h-80 flex-col gap-0.5 overflow-auto" }, fociBulk.map((row) => {
                        var _a, _b, _c, _d;
                        return (React.createElement("li", { key: row.target.clientId, className: "flex flex-wrap items-center gap-2 rounded border border-border/40 bg-background px-2 py-1 text-2xs" },
                            row.status === "success" ? (React.createElement(CheckCircle2, { className: "h-3 w-3 text-success" })) : row.status === "failure" ? (React.createElement(X, { className: "h-3 w-3 text-destructive" })) : (React.createElement(Loader2, { className: "h-3 w-3 animate-spin" })),
                            React.createElement("span", { className: "font-medium" }, row.target.name),
                            React.createElement("code", { className: "font-mono text-[10px] text-muted-foreground" },
                                row.target.clientId.slice(0, 8),
                                "\u2026"),
                            row.status === "success" && (React.createElement(React.Fragment, null,
                                React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                                    "aud",
                                    " ",
                                    React.createElement("code", { className: "font-mono" },
                                        ((_a = row.audience) !== null && _a !== void 0 ? _a : "").slice(0, 28),
                                        ((_b = row.audience) !== null && _b !== void 0 ? _b : "").length > 28 ? "…" : "")),
                                React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                                    React.createElement(Clock, { className: "h-3 w-3" }),
                                    " ",
                                    row.expiresIn
                                        ? `${Math.floor(row.expiresIn / 60)}m`
                                        : "?"))),
                            row.status === "failure" && (React.createElement("span", { className: "break-all text-destructive", title: row.error },
                                ((_c = row.error) !== null && _c !== void 0 ? _c : "").slice(0, 80),
                                ((_d = row.error) !== null && _d !== void 0 ? _d : "").length > 80 ? "…" : ""))));
                    })))))),
        React.createElement(Card, { className: "border-secondary/50" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Search, { className: "h-4 w-4 text-secondary-foreground" }),
                    "Find FOCI clients that grant a scope",
                    React.createElement(InfoTooltip, { ariaLabel: "About the scope reverse-lookup", content: "Filter the FOCI catalogue down to clients whose hand-curated default scope set includes the permission you type here. Best-effort \u2014 coverage is incomplete; clients we don't have data for render as `(unknown)` rather than `false`." })),
                React.createElement(CardDescription, null,
                    "Type a Graph permission (e.g.",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "User.Read"),
                    ",",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "Mail.Read"),
                    ",",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "Application.ReadWrite.All"),
                    ") to see which FOCI clients grant it by default. Click \"Mint AT for this client\" to jump to the FOCI exchange card with that target pre-selected.")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "inline-flex items-center gap-1 text-xs" },
                        "Permission / scope name *",
                        React.createElement(InfoTooltip, { ariaLabel: "About the scope name", content: "Short permission name as Microsoft documents them (e.g. User.Read). The full Graph URI form (https://graph.microsoft.com/User.Read) is also accepted \u2014 we strip the prefix before matching." })),
                    React.createElement(Input, { value: scopeQuery, onChange: (e) => setScopeQuery(e.target.value), placeholder: "User.Read", className: "font-mono text-xs", spellCheck: false, autoComplete: "off", "aria-label": "Microsoft Graph permission to look up" }),
                    scopeQuery && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 w-fit text-2xs", onClick: () => setScopeQuery(""), "aria-label": "Clear scope lookup query" },
                        React.createElement(X, { className: "h-3 w-3" }),
                        " Clear"))),
                !scopeQuery.trim() && (React.createElement("p", { className: "text-2xs italic text-muted-foreground" },
                    "Type a permission name above to filter the ",
                    FOCI_CLIENTS.length,
                    "-client catalogue.")),
                scopeLookupResults && (React.createElement("div", { className: "flex flex-col gap-2" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-2xs" },
                        React.createElement(Badge, { variant: "success", className: "text-2xs" },
                            scopeLookupResults.filter((r) => r.grants).length,
                            " grant"),
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                            scopeLookupResults.filter((r) => !r.knownScopes).length,
                            " unknown"),
                        React.createElement("span", { className: "text-muted-foreground" },
                            "out of ",
                            FOCI_CLIENTS.length,
                            " catalogued clients")),
                    scopeLookupResults.length === 0 ? (React.createElement(EmptyState, { icon: Search, title: "No matching clients", description: `None of our catalogued FOCI clients are documented as granting "${scopeQuery.trim()}". Try a related scope (e.g. User.Read instead of User.ReadBasic.All), or check the AAD app registration directly.`, size: "compact" })) : (React.createElement("ul", { className: "flex max-h-80 flex-col gap-1 overflow-auto" }, scopeLookupResults.map((r) => (React.createElement("li", { key: r.client.clientId, className: "flex flex-wrap items-center gap-2 rounded border border-border/60 bg-background px-2 py-1.5 text-2xs" },
                        React.createElement("span", { className: "font-medium" }, r.client.name),
                        React.createElement("code", { className: "font-mono text-[10px] text-muted-foreground" },
                            r.client.clientId.slice(0, 8),
                            "\u2026"),
                        r.grants ? (React.createElement(Badge, { variant: "success", className: "text-2xs" },
                            React.createElement(Check, { className: "h-3 w-3" }),
                            " grants ",
                            r.matchedScope)) : (React.createElement(Badge, { variant: "outline", className: "text-2xs", title: "We don't have curated default-scope data for this client. The actual app registration may still grant the scope." }, "(unknown)")),
                        r.client.isFoci ? (React.createElement(Badge, { variant: "default", className: "text-2xs" }, "FOCI")) : (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "non-FOCI")),
                        React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                            React.createElement(CopyButton, { value: r.client.clientId, ariaLabel: `Copy client id ${r.client.clientId}`, alwaysVisible: true }),
                            r.client.isFoci && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-5 px-1 text-2xs", onClick: () => {
                                    setFociTargetClientId(r.client.clientId);
                                    const el = document.getElementById("foci-exchange-card");
                                    if (el) {
                                        el.scrollIntoView({
                                            behavior: "smooth",
                                            block: "start",
                                        });
                                    }
                                }, disabled: refreshTokens.length === 0, title: refreshTokens.length === 0
                                    ? "Import a refresh token first to enable minting."
                                    : `Pre-select ${r.client.name} as the FOCI exchange target and scroll to the exchange card.` },
                                React.createElement(Network, { className: "h-3 w-3" }),
                                " Mint AT for this client")))))))))))),
        React.createElement(Card, { className: "border-warning/40 bg-warning/5" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(GitBranch, { className: "h-4 w-4 text-warning" }),
                    "Azure DevOps PATs (Basic-auth lane)",
                    React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                        adoPats.length,
                        " PAT",
                        adoPats.length === 1 ? "" : "s"),
                    React.createElement(InfoTooltip, { ariaLabel: "About the Azure DevOps PAT vault", content: "Personal Access Tokens are AzDO-issued opaque credentials used as Basic-auth passwords. They are STRICTLY SEPARATE from the Bearer-token vault: PATs are never mixed into the OAuth flow, and the vault is sessionStorage-backed so closing the tab drops them. Use them only when the AzDO REST endpoint you're targeting doesn't accept AAD bearer tokens." })),
                React.createElement(CardDescription, null,
                    "Mint a PAT at",
                    " ",
                    React.createElement("a", { href: "https://dev.azure.com/_usersSettings/tokens", target: "_blank", rel: "noopener noreferrer", className: "inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" },
                        "dev.azure.com/_usersSettings/tokens",
                        React.createElement(ExternalLink, { className: "h-3 w-3" })),
                    " ",
                    "and paste it below. Use the \"Copy Basic header\" button to grab the ready-to-use",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "Authorization: Basic \u2026"),
                    " value for your REST call.",
                    " ",
                    React.createElement("strong", null, "These are NEVER mixed into the Bearer / refresh-token flow."))),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { htmlFor: "ado-pat-input", className: "inline-flex items-center gap-1 text-xs" },
                            "PAT *",
                            React.createElement(InfoTooltip, { ariaLabel: "About the Azure DevOps PAT field", content: "Paste the raw PAT (40-96 alphanumeric chars). We validate the shape locally and refuse JWTs / random pastes." })),
                        React.createElement(Input, { id: "ado-pat-input", value: adoPatInput, onChange: (e) => {
                                setAdoPatInput(e.target.value);
                                setAdoPatError(null);
                            }, placeholder: "e.g. 52 alphanumeric chars", type: "password", className: "font-mono text-xs", "aria-label": "Paste Azure DevOps Personal Access Token", spellCheck: false, autoComplete: "off" })),
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { htmlFor: "ado-pat-owner", className: "inline-flex items-center gap-1 text-xs" },
                            "Owner label *",
                            React.createElement(InfoTooltip, { ariaLabel: "About the owner label field", content: "Free-text label identifying who/what this PAT belongs to (e.g. 'contoso-org/alice'). Used only for the UI \u2014 never sent anywhere, never validated." })),
                        React.createElement(Input, { id: "ado-pat-owner", value: adoPatOwner, onChange: (e) => {
                                setAdoPatOwner(e.target.value);
                                setAdoPatError(null);
                            }, placeholder: "contoso-org/alice", className: "text-xs", "aria-label": "Owner label for this PAT", spellCheck: false, autoComplete: "off" }))),
                adoPatError && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "text-2xs" }, adoPatError))),
                React.createElement("div", null,
                    React.createElement(Button, { type: "button", variant: "default", onClick: handleAddAdoPat, disabled: !adoPatInput.trim() || !adoPatOwner.trim(), "aria-label": "Add Azure DevOps PAT to the vault" },
                        React.createElement(Plus, { className: "h-4 w-4" }),
                        " Add PAT")),
                adoPats.length === 0 ? (React.createElement(EmptyState, { icon: GitBranch, title: "No PATs imported", description: "Paste a PAT above to add it. PATs live in sessionStorage only \u2014 they're dropped when you close the tab.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, adoPats.map((p) => (React.createElement("li", { key: p.id, className: "flex flex-wrap items-center gap-2 rounded border border-border bg-background px-2 py-1.5 text-2xs" },
                    React.createElement(GitBranch, { className: "h-3 w-3 text-warning" }),
                    React.createElement("span", { className: "font-medium" }, p.owner),
                    React.createElement("code", { className: "font-mono text-[10px] text-muted-foreground", title: "PAT (masked \u2014 only first/last 2 chars shown)" }, maskAdoPat(p.pat)),
                    React.createElement("span", { className: "text-muted-foreground" },
                        "added ",
                        new Date(p.addedAt).toISOString().slice(0, 16)),
                    React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-5 px-1 text-2xs", onClick: () => void handleCopyAdoPatBasicHeader(p), "aria-label": `Copy Authorization Basic header for ${p.owner}`, title: "Copy the full 'Authorization: Basic <base64>' header value to the clipboard." },
                            React.createElement(Copy, { className: "h-3 w-3" }),
                            " Copy Basic header"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-5 px-1 text-2xs text-destructive", onClick: () => handleRemoveAdoPat(p), "aria-label": `Remove PAT for ${p.owner}` },
                            React.createElement(Trash2, { className: "h-3 w-3" }),
                            " Remove"))))))))),
        React.createElement(Card, null,
            React.createElement(CardHeader, { className: "flex flex-row items-start justify-between gap-2 pb-3" },
                React.createElement("div", null,
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(KeyRound, { className: "h-4 w-4 text-primary" }),
                        "Currently imported",
                        React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            accounts.length,
                            " account",
                            accounts.length === 1 ? "" : "s")),
                    React.createElement(CardDescription, null,
                        "Imported tokens override MSAL for ARM / Graph / Batch calls while they're still inside their ",
                        React.createElement("code", { className: "font-mono" }, "exp"),
                        " window.")),
                React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
                    allTokens.length > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setMaskTokens((m) => !m), "aria-label": maskTokens ? "Reveal token values" : "Hide token values", title: maskTokens
                            ? "Reveal token values (raw JWT / RT). Sensitive — only do this when nothing's being recorded."
                            : "Mask token values for screen-sharing safety." }, maskTokens ? (React.createElement(React.Fragment, null,
                        React.createElement(EyeOff, { className: "h-3 w-3" }),
                        " Hidden")) : (React.createElement(React.Fragment, null,
                        React.createElement(Eye, { className: "h-3 w-3" }),
                        " Visible")))),
                    stats.expired > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs text-warning", onClick: handleDropExpired, "aria-label": `Drop ${stats.expired} expired tokens` },
                        React.createElement(Trash2, { className: "h-3 w-3" }),
                        " Drop expired (",
                        stats.expired,
                        ")")),
                    accounts.length > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs text-destructive", onClick: handleClearAll, "aria-label": "Drop all imported tokens" },
                        React.createElement(Trash2, { className: "h-3 w-3" }),
                        " Drop all")))),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Imported token summary" },
                    React.createElement(SummaryStatItem, { label: "Access tokens", value: stats.accessTokens, hint: audienceFilter == null
                            ? "All audiences"
                            : `Filter: ${audienceFilter}`, compact: true, onClick: audienceFilter == null
                            ? undefined
                            : () => setAudienceFilter(null), ariaLabel: audienceFilter == null
                            ? `Access tokens ${stats.accessTokens}`
                            : `Clear filter (currently showing ${audienceFilter})` }),
                    React.createElement(SummaryStatItem, { label: "Refresh tokens", value: stats.refreshTokens, tone: "info", compact: true }),
                    React.createElement(SummaryStatItem, { label: "ARM", value: stats.perAudience.arm, tone: "info", compact: true, onClick: () => setAudienceFilter((f) => (f === "arm" ? null : "arm")), className: audienceFilter === "arm"
                            ? "ring-2 ring-info ring-offset-1 ring-offset-background"
                            : undefined, ariaLabel: `Filter by ARM (${stats.perAudience.arm} tokens)` }),
                    React.createElement(SummaryStatItem, { label: "Graph", value: stats.perAudience.graph, tone: "info", compact: true, onClick: () => setAudienceFilter((f) => (f === "graph" ? null : "graph")), className: audienceFilter === "graph"
                            ? "ring-2 ring-info ring-offset-1 ring-offset-background"
                            : undefined, ariaLabel: `Filter by Graph (${stats.perAudience.graph} tokens)` }),
                    React.createElement(SummaryStatItem, { label: "Batch", value: stats.perAudience.batch, tone: "info", compact: true, onClick: () => setAudienceFilter((f) => (f === "batch" ? null : "batch")), className: audienceFilter === "batch"
                            ? "ring-2 ring-info ring-offset-1 ring-offset-background"
                            : undefined, ariaLabel: `Filter by Batch (${stats.perAudience.batch} tokens)` }),
                    React.createElement(SummaryStatItem, { label: "DevOps", value: stats.perAudience.devops, tone: "info", compact: true, onClick: () => setAudienceFilter((f) => (f === "devops" ? null : "devops")), className: audienceFilter === "devops"
                            ? "ring-2 ring-info ring-offset-1 ring-offset-background"
                            : undefined, ariaLabel: `Filter by DevOps (${stats.perAudience.devops} tokens)` }),
                    React.createElement(SummaryStatItem, { label: "Expires < 5m", value: stats.expiringSoon, tone: stats.expiringSoon > 0 ? "warning" : "muted", compact: true, onClick: stats.expiringSoon > 0
                            ? () => setAudienceFilter((f) => f === "expiring" ? null : "expiring")
                            : undefined, className: audienceFilter === "expiring"
                            ? "ring-2 ring-warning ring-offset-1 ring-offset-background"
                            : undefined, ariaLabel: `Filter by expiring (${stats.expiringSoon} tokens)` }),
                    React.createElement(SummaryStatItem, { label: "Expired", value: stats.expired, tone: stats.expired > 0 ? "destructive" : "muted", compact: true, onClick: stats.expired > 0
                            ? () => setAudienceFilter((f) => f === "expired" ? null : "expired")
                            : undefined, className: audienceFilter === "expired"
                            ? "ring-2 ring-destructive ring-offset-1 ring-offset-background"
                            : undefined, ariaLabel: `Filter by expired (${stats.expired} tokens)` })),
                audienceFilter && (React.createElement("div", { className: "flex items-center gap-2 text-2xs text-muted-foreground" },
                    React.createElement("span", null,
                        "Filtered by",
                        " ",
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" }, audienceFilter),
                        " ",
                        "(",
                        filteredAccounts.length,
                        " / ",
                        accounts.length,
                        " accounts)"),
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-5 px-2 text-2xs", onClick: () => setAudienceFilter(null) },
                        React.createElement(X, { className: "h-3 w-3" }),
                        " Clear chip filter"))),
                accounts.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement("div", { className: "relative min-w-[200px] flex-1" },
                        React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                        React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search by name, upn, oid, tenant, audience\u2026", className: "h-8 pl-7 pr-7 text-xs", "aria-label": "Filter imported tokens" }),
                        search && (React.createElement("button", { type: "button", onClick: () => setSearch(""), className: "absolute right-1.5 top-1/2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground", "aria-label": "Clear search" },
                            React.createElement(X, { className: "h-3 w-3" })))),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        filteredAccounts.length,
                        " / ",
                        accounts.length),
                    React.createElement(ExportMenu, { rows: exportRows, columns: exportColumns, filename: "imported-tokens", label: "Export", jsonMetadata: {
                            source: "token-importer",
                            filtered: search.trim().length > 0 || audienceFilter != null,
                            filterQuery: search.trim() || null,
                            audienceFilter,
                            totalAccounts: accounts.length,
                            totalAccessTokens: stats.accessTokens,
                            totalRefreshTokens: stats.refreshTokens,
                        } }))),
                accounts.length === 0 ? (React.createElement(EmptyState, { icon: Key, title: "No tokens imported yet", description: "Paste a JWT into the access-token form above, paste multiple JWTs into the bulk-import card, or use the refresh-token form to mint tokens on demand. Imported tokens override MSAL for ARM / Graph / Batch calls.", size: "compact", action: {
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
                    } })) : filteredAccounts.length === 0 ? (React.createElement(EmptyState, { icon: Search, title: "No imported tokens match this filter", description: audienceFilter
                        ? `No imported account has a ${audienceFilter} token matching your search.`
                        : "Clear the search box to see every imported account, or try a different query.", size: "compact", action: {
                        label: "Clear all filters",
                        onClick: () => {
                            setSearch("");
                            setAudienceFilter(null);
                        },
                    } })) : (React.createElement("ul", { className: "flex flex-col gap-2" }, filteredAccounts.map((a) => (React.createElement(TokenAccountRow, { key: a.homeAccountId, account: a, tokens: allTokens.filter((t) => t.homeAccountId === a.homeAccountId), refreshEntry: refreshTokens.find((r) => r.homeAccountId === a.homeAccountId), fociInfo: fociByHomeAccount.get(a.homeAccountId), maskTokens: maskTokens, revealed: revealed, expandedClaims: expandedClaims, toggleRevealed: toggleRevealed, toggleClaims: toggleClaims, onRemoveAccount: handleRemoveAccount, onRemoveRefresh: handleRemoveRefresh, onRemoveAudience: handleRemoveAudience, onReMint: reMintFromRt, onUseInFociExchange: (e) => {
                        setFociSourceAccountId(e.homeAccountId);
                        const el = document.getElementById("foci-exchange-card");
                        if (el) {
                            el.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                            });
                        }
                    } }))))))),
        React.createElement(ConfirmationDialog, Object.assign({ danger: true }, confirmDialogProps)),
        React.createElement(Alert, null,
            React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
            React.createElement(AlertDescription, { className: "text-2xs" },
                React.createElement("strong", null, "Trust caveat:"),
                " imported tokens give this browser tab the same Azure rights as the original session. Treat them like a password \u2014 never paste into a machine you don't trust, use the \"Hidden\" toggle when screen-sharing, and use",
                " ",
                "\"Drop account\" when you're done. Tokens persist in this browser's localStorage until you remove them or they expire. Refresh tokens do NOT carry a client-side expiry; AAD revokes them server-side after 90 days idle (sliding window)."))));
};
const TokenAccountRow = ({ account: a, tokens, refreshEntry: rtEntry, fociInfo, maskTokens, revealed, expandedClaims, toggleRevealed, toggleClaims, onRemoveAccount, onRemoveRefresh, onRemoveAudience, onReMint, onUseInFociExchange, }) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
    // Sort tokens by audience so ARM is always first, then Graph, Batch,
    // DevOps, unknown. Stable ordering helps the operator's eye.
    const orderedTokens = React.useMemo(() => {
        const idx = {
            arm: 0,
            graph: 1,
            batch: 2,
            devops: 3,
            unknown: 4,
        };
        return [...tokens].sort((x, y) => { var _a, _b; return ((_a = idx[x.audience]) !== null && _a !== void 0 ? _a : 9) - ((_b = idx[y.audience]) !== null && _b !== void 0 ? _b : 9); });
    }, [tokens]);
    /* ---- Per-account expiry sparkline data ---------------------------
     * Compact horizontal visual that maps each token's remaining lifetime
     * onto a 0..100% bar so the operator can spot urgency at a glance
     * without scanning every individual row. Tokens are bucketed:
     *   - expired   (red)
     *   - <5min    (warning)
     *   - <30min   (info)
     *   - otherwise (success)
     * No token material is rendered — only the bucket colour + count. */
    const expirySparkline = React.useMemo(() => {
        const now = Math.floor(Date.now() / 1000);
        let expired = 0;
        let critical = 0;
        let warn = 0;
        let ok = 0;
        for (const t of tokens) {
            if (t.expiresAt <= 0)
                continue;
            const sec = t.expiresAt - now;
            if (sec < 0)
                expired += 1;
            else if (sec < 5 * 60)
                critical += 1;
            else if (sec < 30 * 60)
                warn += 1;
            else
                ok += 1;
        }
        const total = expired + critical + warn + ok;
        return { expired, critical, warn, ok, total };
    }, [tokens]);
    const [reMinting, setReMinting] = React.useState(false);
    const handleReMint = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!rtEntry)
            return;
        setReMinting(true);
        try {
            yield onReMint(rtEntry);
        }
        finally {
            setReMinting(false);
        }
    }), [rtEntry, onReMint]);
    return (React.createElement("li", { className: "flex flex-col gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs" },
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement(User, { className: "h-3.5 w-3.5 text-muted-foreground" }),
            React.createElement("span", { className: "font-medium" }, (_b = (_a = a.name) !== null && _a !== void 0 ? _a : a.upn) !== null && _b !== void 0 ? _b : a.oid),
            a.upn && a.upn !== a.name && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, a.upn)),
            React.createElement(Badge, { variant: "outline", className: "inline-flex items-center gap-1 text-2xs", title: `Tenant id ${a.tenantId}` },
                "tenant",
                " ",
                React.createElement(CopyableText, { value: (_c = a.tenantId) !== null && _c !== void 0 ? _c : "", display: `${((_d = a.tenantId) !== null && _d !== void 0 ? _d : "").slice(0, 8)}…`, mono: true, ariaLabel: `Copy tenant id ${(_e = a.tenantId) !== null && _e !== void 0 ? _e : ""}` })),
            React.createElement("span", { className: "text-2xs text-muted-foreground", title: `homeAccountId — synthetic ${"<oid>.<tid>"} pair MSAL uses to dedupe principals` },
                React.createElement(CopyableText, { value: (_f = a.homeAccountId) !== null && _f !== void 0 ? _f : "", display: `acct ${((_g = a.homeAccountId) !== null && _g !== void 0 ? _g : "").slice(0, 10)}…`, mono: true, ariaLabel: `Copy home account id ${(_h = a.homeAccountId) !== null && _h !== void 0 ? _h : ""}` })),
            rtEntry && (React.createElement(Badge, { variant: "secondary", className: "inline-flex items-center gap-1 text-2xs", title: `Refresh token issued for client ${rtEntry.clientId}` },
                React.createElement(KeyRound, { className: "h-3 w-3" }),
                " RT")),
            rtEntry && fociInfo && (React.createElement(Badge, { variant: fociInfo.eligible ? "default" : "outline", className: "inline-flex items-center gap-1 text-2xs", title: fociInfo.eligible
                    ? `RT was issued by ${(_k = (_j = fociInfo.sourceClient) === null || _j === void 0 ? void 0 : _j.name) !== null && _k !== void 0 ? _k : "a FOCI client"} — can be exchanged for any other FOCI member.`
                    : "RT's issuer is not in our FOCI list — exchange to a different client will likely fail." },
                React.createElement(Users, { className: "h-3 w-3" }),
                fociInfo.eligible
                    ? `FOCI: ${(_m = (_l = fociInfo.sourceClient) === null || _l === void 0 ? void 0 : _l.name) !== null && _m !== void 0 ? _m : "yes"}`
                    : "Not FOCI")),
            expirySparkline.total > 0 && (React.createElement("span", { className: "inline-flex h-3 w-24 overflow-hidden rounded border border-border/40", role: "img", "aria-label": `Expiry urgency: ${expirySparkline.expired} expired, ${expirySparkline.critical} under 5 minutes, ${expirySparkline.warn} under 30 minutes, ${expirySparkline.ok} healthy.`, title: `Token expiry urgency: ${expirySparkline.expired} expired · ${expirySparkline.critical} <5m · ${expirySparkline.warn} <30m · ${expirySparkline.ok} healthy` },
                expirySparkline.expired > 0 && (React.createElement("span", { className: "bg-destructive", style: {
                        width: `${(expirySparkline.expired / expirySparkline.total) * 100}%`,
                    } })),
                expirySparkline.critical > 0 && (React.createElement("span", { className: "bg-warning", style: {
                        width: `${(expirySparkline.critical / expirySparkline.total) * 100}%`,
                    } })),
                expirySparkline.warn > 0 && (React.createElement("span", { className: "bg-info", style: {
                        width: `${(expirySparkline.warn / expirySparkline.total) * 100}%`,
                    } })),
                expirySparkline.ok > 0 && (React.createElement("span", { className: "bg-success", style: {
                        width: `${(expirySparkline.ok / expirySparkline.total) * 100}%`,
                    } })))),
            React.createElement("span", { className: "ml-auto flex flex-wrap items-center gap-1" },
                rtEntry && (React.createElement(React.Fragment, null,
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs", onClick: () => void handleReMint(), disabled: reMinting, loading: reMinting, "aria-label": `Re-mint ARM access token for ${(_o = a.upn) !== null && _o !== void 0 ? _o : a.oid}`, title: "Re-mint ARM access token from the stored refresh token (also rotates the RT if AAD returns a new one)." },
                        !reMinting && React.createElement(RotateCw, { className: "h-3 w-3" }),
                        "Re-mint ARM"),
                    onUseInFociExchange && (fociInfo === null || fociInfo === void 0 ? void 0 : fociInfo.eligible) && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs", onClick: () => onUseInFociExchange(rtEntry), "aria-label": `Use refresh token for ${(_p = a.upn) !== null && _p !== void 0 ? _p : a.oid} in FOCI exchange`, title: "Pre-select this RT in the FOCI exchange card above and scroll there." },
                        React.createElement(Users, { className: "h-3 w-3" }),
                        " FOCI exchange")),
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs text-destructive", onClick: () => onRemoveRefresh(rtEntry), "aria-label": `Drop refresh token for ${(_q = a.upn) !== null && _q !== void 0 ? _q : a.oid}` },
                        React.createElement(Trash2, { className: "h-3 w-3" }),
                        " Drop RT"))),
                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs text-destructive", onClick: () => onRemoveAccount(a), "aria-label": `Drop imported tokens for ${(_r = a.upn) !== null && _r !== void 0 ? _r : a.oid}` },
                    React.createElement(Trash2, { className: "h-3 w-3" }),
                    " Drop account"))),
        rtEntry && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded border border-success/20 bg-success/5 px-2 py-1 text-2xs" },
            React.createElement(KeyRound, { className: "h-3 w-3 text-success" }),
            React.createElement("span", { className: "font-medium text-success" }, "Refresh token"),
            React.createElement("span", { className: "text-muted-foreground" },
                "client ",
                React.createElement("code", { className: "font-mono" },
                    rtEntry.clientId.slice(0, 8),
                    "\u2026")),
            React.createElement("span", { className: "text-muted-foreground" },
                "imported ",
                rtEntry.importedAt.slice(0, 16)),
            React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                React.createElement("code", { className: "font-mono text-[10px] text-muted-foreground" }, revealed[`rt:${rtEntry.homeAccountId}`] && !maskTokens
                    ? rtEntry.refreshToken.slice(0, 32) + "…"
                    : maskToken(rtEntry.refreshToken)),
                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-5 px-1 text-2xs", onClick: () => toggleRevealed(`rt:${rtEntry.homeAccountId}`), "aria-label": revealed[`rt:${rtEntry.homeAccountId}`]
                        ? "Mask refresh token"
                        : "Reveal start of refresh token", disabled: maskTokens, title: maskTokens
                        ? "Disabled while master 'Hidden' toggle is active"
                        : revealed[`rt:${rtEntry.homeAccountId}`]
                            ? "Mask"
                            : "Reveal start" }, revealed[`rt:${rtEntry.homeAccountId}`] ? (React.createElement(EyeOff, { className: "h-3 w-3" })) : (React.createElement(Eye, { className: "h-3 w-3" }))),
                React.createElement(CopyButton, { value: rtEntry.refreshToken, ariaLabel: `Copy raw refresh token for ${(_s = a.upn) !== null && _s !== void 0 ? _s : a.oid}`, alwaysVisible: true })))),
        React.createElement("ul", { className: "flex flex-col gap-1 pl-5" },
            orderedTokens.length === 0 && (React.createElement("li", { className: "text-2xs italic text-muted-foreground" }, "No cached access tokens \u2014 they'll be minted on demand via the refresh token.")),
            orderedTokens.map((t) => {
                var _a, _b, _c, _d;
                const Icon = t.audience === "graph"
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
                // Corpus-grounded risk flags for the per-token row.
                const highValue = detectHighValueAudience(t.rawAudience);
                const goldenSamlFlag = detectGoldenSamlBearer(tokenClaims);
                const now = Math.floor(Date.now() / 1000);
                const isExpired = t.expiresAt > 0 && t.expiresAt < now;
                const isExpiringSoon = t.expiresAt > 0 &&
                    !isExpired &&
                    t.expiresAt < now + 5 * 60;
                const key = `${t.homeAccountId}|${t.audience}`;
                const isRevealed = !!revealed[key] && !maskTokens;
                const claimsOpen = !!expandedClaims[key];
                return (React.createElement("li", { key: key, className: "flex flex-col gap-1 rounded border border-transparent hover:border-border/60" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-2xs" },
                        React.createElement(Icon, { className: isExpired
                                ? "h-3 w-3 text-destructive"
                                : "h-3 w-3 text-muted-foreground" }),
                        React.createElement("span", { className: "font-medium", title: AUDIENCE_HINT[t.audience] }, AUDIENCE_SHORT[t.audience]),
                        React.createElement(CopyableText, { value: (_a = t.rawAudience) !== null && _a !== void 0 ? _a : "", display: React.createElement("code", { className: "font-mono text-[10px] text-muted-foreground" },
                                "aud ",
                                ((_b = t.rawAudience) !== null && _b !== void 0 ? _b : "").slice(0, 22),
                                ((_c = t.rawAudience) !== null && _c !== void 0 ? _c : "").length > 22 ? "…" : ""), ariaLabel: `Copy raw audience ${t.rawAudience}` }),
                        React.createElement(Badge, { variant: isExpired
                                ? "destructive"
                                : isExpiringSoon
                                    ? "warning"
                                    : "secondary", className: "text-2xs" },
                            React.createElement(Clock, { className: "h-3 w-3" }),
                            " ",
                            fmtExpiresIn(t.expiresAt)),
                        amrBadges.map((meta) => {
                            const MetaIcon = meta.Icon;
                            return (React.createElement(Badge, { key: `${key}-amr-${meta.label}`, variant: meta.variant, className: "inline-flex items-center gap-1 text-2xs", title: meta.tooltip },
                                React.createElement(MetaIcon, { className: "h-3 w-3" }),
                                meta.label));
                        }),
                        highValue && (React.createElement(Badge, { variant: "warning", className: "inline-flex items-center gap-1 text-2xs", title: `High-value resource: ${highValue.rationale}` },
                            React.createElement(Shield, { className: "h-3 w-3" }),
                            "high-value (",
                            highValue.label,
                            ")")),
                        goldenSamlFlag && (React.createElement(Badge, { variant: "destructive", className: "inline-flex items-center gap-1 text-2xs", title: "amr contains urn:oasis:names:tc:SAML:2.0:cm:bearer \u2014 Golden SAML provenance signal. Verify origin. Ref: New folder/_analysis_aadinternals.md" },
                            React.createElement(AlertTriangle, { className: "h-3 w-3" }),
                            "Golden SAML?")),
                        React.createElement("span", { className: "font-mono text-[10px] text-muted-foreground", title: `Imported at ${t.importedAt}` },
                            "imported ",
                            t.importedAt.slice(0, 16)),
                        React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                            React.createElement("code", { className: "font-mono text-[10px] text-muted-foreground" }, isRevealed
                                ? t.accessToken.slice(0, 32) + "…"
                                : maskToken(t.accessToken)),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-5 px-1 text-2xs", onClick: () => toggleRevealed(key), "aria-label": isRevealed ? "Mask access token" : "Reveal start of access token", disabled: maskTokens, title: maskTokens
                                    ? "Disabled while master 'Hidden' toggle is active"
                                    : isRevealed
                                        ? "Mask"
                                        : "Reveal start" }, isRevealed ? (React.createElement(EyeOff, { className: "h-3 w-3" })) : (React.createElement(Eye, { className: "h-3 w-3" }))),
                            React.createElement(CopyButton, { value: t.accessToken, ariaLabel: `Copy raw bearer token for ${AUDIENCE_LABELS[t.audience]}`, alwaysVisible: true }),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-5 px-1 text-2xs", onClick: () => toggleClaims(key), "aria-expanded": claimsOpen, "aria-label": claimsOpen ? "Hide claims" : "Show JWT claims", title: claimsOpen
                                    ? "Hide decoded claims"
                                    : "Show decoded JWT claims" },
                                React.createElement(Braces, { className: "h-3 w-3" })),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-5 px-1 text-2xs text-destructive", onClick: () => onRemoveAudience(t.homeAccountId, t.audience), "aria-label": `Drop ${AUDIENCE_LABELS[t.audience]} token for ${(_d = a.upn) !== null && _d !== void 0 ? _d : a.oid}` }, "Drop"))),
                    claimsOpen && (React.createElement("div", { className: "ml-5" },
                        React.createElement(ClaimsGrid, { claims: tokenClaims !== null && tokenClaims !== void 0 ? tokenClaims : {}, maxHeight: "18rem" })))));
            }))));
};
const ClaimsGrid = ({ claims, maxHeight = "24rem", }) => {
    const admin = React.useMemo(() => detectAdminRoles(claims), [claims]);
    const foci = React.useMemo(() => detectFociEligibility(claims), [claims]);
    const issuedAt = typeof (claims === null || claims === void 0 ? void 0 : claims.iat) === "number" ? claims.iat : 0;
    const isFresh = issuedAt > 0 && Math.floor(Date.now() / 1000) - issuedAt < 60;
    const hasOid = !!claims && (typeof claims.oid === "string" || typeof claims.sub === "string");
    if (!claims) {
        return (React.createElement("div", { className: "rounded-md border border-border bg-muted/40 p-2 text-2xs italic text-muted-foreground" }, "No claims to decode."));
    }
    // Sort known claims first (in CLAIM_EXPLAIN insertion order), then the
    // rest alphabetically. Operator's eye expects oid / tid first.
    const knownOrder = Object.keys(CLAIM_EXPLAIN);
    const entries = Object.entries(claims).sort(([a], [b]) => {
        const ai = knownOrder.indexOf(a);
        const bi = knownOrder.indexOf(b);
        if (ai >= 0 && bi >= 0)
            return ai - bi;
        if (ai >= 0)
            return -1;
        if (bi >= 0)
            return 1;
        return a.localeCompare(b);
    });
    return (React.createElement("div", { className: "flex flex-col gap-2" },
        React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
            admin.isAdmin && (React.createElement(Badge, { variant: "warning", className: "text-2xs", title: `Privileged directory roles via wids: ${admin.roles.join(", ")}` },
                React.createElement(Shield, { className: "h-3 w-3" }),
                " admin: ",
                admin.roles[0],
                admin.roles.length > 1 ? ` +${admin.roles.length - 1}` : "")),
            !hasOid && (React.createElement(Badge, { variant: "destructive", className: "text-2xs", title: "Token has no oid / sub claim \u2014 not a user-bound token. Likely a malformed paste or a non-AAD JWT." }, "no oid")),
            isFresh && (React.createElement(Badge, { variant: "default", className: "text-2xs", title: `Issued ${Math.floor(Date.now() / 1000) - issuedAt}s ago — fresh from AAD.` },
                React.createElement(Sparkles, { className: "h-3 w-3" }),
                " just issued")),
            foci.eligible && foci.sourceClient && (React.createElement(Badge, { variant: "secondary", className: "text-2xs", title: `appid / azp matches the FOCI client ${foci.sourceClient.name}. Its refresh token can be exchanged for any other FOCI member.` },
                React.createElement(Users, { className: "h-3 w-3" }),
                " FOCI: ",
                foci.sourceClient.name)),
            !foci.eligible &&
                (typeof claims.azp === "string" ||
                    typeof claims.appid === "string") && (React.createElement(Badge, { variant: "outline", className: "text-2xs", title: "The appid / azp claim is not in our curated FOCI list \u2014 refresh-token exchange to another client will likely fail." },
                React.createElement(Users, { className: "h-3 w-3" }),
                " Not FOCI"))),
        React.createElement("div", { className: "grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 overflow-auto rounded-md border border-border bg-background/50 p-2 text-[10px]", style: { maxHeight } }, entries.map(([name, value]) => {
            const explain = CLAIM_EXPLAIN[name];
            const isAdminWid = name === "wids" && admin.isAdmin;
            const isExpClaim = name === "exp" || name === "nbf" || name === "iat";
            const formatted = formatClaimValue(name, value);
            return (React.createElement(React.Fragment, { key: name },
                React.createElement("dt", { className: "inline-flex items-center gap-1 font-mono " +
                        (isAdminWid
                            ? "text-warning"
                            : !hasOid && name === "oid"
                                ? "text-destructive"
                                : isFresh && isExpClaim
                                    ? "text-success"
                                    : "text-muted-foreground") },
                    name,
                    explain && (React.createElement(InfoTooltip, { ariaLabel: `About the ${name} claim`, content: explain, size: 11 }))),
                React.createElement("dd", { className: "break-all" },
                    React.createElement(CopyableText, { value: formatted, mono: true, ariaLabel: `Copy ${name} claim value` }))));
        }))));
};
// Re-export icons we imported but don't always reference inline, so the
// linter doesn't complain when the design later surfaces them.
export const _TokenImporterIcons = { Loader2, AUDIENCE_ORDER };
//# sourceMappingURL=token-importer-page.js.map