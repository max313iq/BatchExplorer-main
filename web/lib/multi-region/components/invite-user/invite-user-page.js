import { __awaiter } from "tslib";
/**
 * Invite User page — bulk B2B guest invitations via Microsoft Graph's
 * `/invitations` endpoint, with an optional follow-up Owner role grant on an
 * Azure subscription.
 *
 * What this page does (in order):
 *   1. Resolves a privileged inviter account (auto-detect via directory
 *      role probe, or manual pick — for tenants whose authorizationPolicy
 *      lets all members invite).
 *   2. Accepts a free-form email list (newline / comma / semicolon
 *      separated), parses it into a deduplicated, validated chip list, and
 *      lets the operator remove individual chips before submit.
 *   3. Submits invites with bounded concurrency (no fan-out storms even
 *      for 50+ recipients) and live per-row progress.
 *   4. Surfaces the redemption URL for every successful invite + one-click
 *      copy / open / TSV-of-all.
 *   5. Optionally assigns the Owner role at the chosen subscription
 *      scope to each newly-invited principal. Failed grants can be
 *      retried individually or in bulk afterwards.
 *
 * Things the page protects against (the inheriting requirements):
 *   - Race conditions: per-row updates are keyed by stable index (not by
 *     `email`, which used to mis-merge when the same address appeared
 *     more than once after a paste-reuse).
 *   - Stale ARM tokens during a long batch: `useArmToken` auto-refreshes
 *     ~60s before expiry. The badge in the header surfaces remaining time.
 *   - Mid-flight cancellation: the operator can stop a running batch
 *     without unmounting the page. Pending rows are marked "cancelled".
 *   - Idempotent re-runs: `assignSubscriptionRole` already handles
 *     `RoleAssignmentExists` — surfaced as "already had it".
 *   - Tenant pollution: invitation goes to the *inviter's* tenant, not
 *     the operator's active tenant. The selector caption spells out the
 *     destination tenantId so it's never ambiguous.
 *
 * Things explicitly NOT changed:
 *   - `useArmToken` + `TokenExpiryBadge` (preserved per spec).
 *   - Existing audit-log shape (`invite_guest`, `assign_subscription_role`).
 *   - No edits to services / store / shared components / page-router.
 */
import * as React from "react";
import { AlertCircle, AlertTriangle, Check, ChevronDown, Copy, ExternalLink, Filter, Globe, Info, Key, Loader2, Mail, MailCheck, Pencil, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, Sparkles, Trash2, UserPlus, Users, X, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { auditLog } from "../../services/audit-log";
import { getActiveTenant, getArmTokenForAccount, getGraphTokenForAccount, listAccessibleTenants, } from "../../auth/msal-auth";
import { useArmToken } from "../../auth/use-arm-token";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
// COORDINATOR: invite-user has CSV paste, consider import-batch — the bulk
// CSV-paste affordance added below (operator pastes
// "email[,displayName[,message]]" rows) is import-shaped. If a generic
// import-batch page appears later, share the parser via a shared util.
import { assignSubscriptionRole, AZURE_ROLE_OWNER, createUser, getMyDirectoryRoles, inviteGuest, listSubscriptions, listVerifiedDomains, ROLE_GLOBAL_ADMIN, ROLE_USER_ADMIN, } from "../../services";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText, CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/**
 * Guest Inviter directory role template id — least-privileged role with
 * User.Invite.All. Operators using this role specifically can drive the
 * invitation flow without holding broader user-management permissions.
 */
const ROLE_GUEST_INVITER = "95e79109-95c0-4d8e-aee3-d01accf2d47b";
/**
 * The full set of directory roles whose holders can issue invitations.
 * Anything outside this set will lack `User.Invite.All` and Graph will 403.
 */
const INVITE_ROLES = new Set([
    ROLE_GUEST_INVITER,
    ROLE_GLOBAL_ADMIN,
    ROLE_USER_ADMIN,
]);
const DEFAULT_REDIRECT_URL = "https://myapplications.microsoft.com";
/** Common "where Graph drops a user after they consent" presets. */
const REDIRECT_PRESETS = [
    { label: "My Apps (default)", url: "https://myapplications.microsoft.com" },
    { label: "Azure Portal", url: "https://portal.azure.com" },
    { label: "Microsoft 365", url: "https://www.office.com" },
    { label: "Teams", url: "https://teams.microsoft.com" },
];
/**
 * Maximum concurrent invite + Owner-grant operations.
 *
 * Sequential (1) was painfully slow for large batches (~1s per recipient
 * doing Graph POST + ARM PUT). Unbounded fan-out (Promise.all over 50
 * recipients) routinely got throttled by Graph's per-tenant ratelimits
 * and by ARM's role-assignment write-side throttling. A small bounded
 * pool of 4 keeps wall-clock low without tripping either limit in
 * practice; users can override via the UI slider.
 */
const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;
const STORAGE_INVITER_MODE = "invite-user:inviter-mode";
const STORAGE_MANUAL_ACCOUNT = "invite-user:manual-account";
const STORAGE_LAST_SUBSCRIPTION = "invite-user:last-subscription";
const STORAGE_REDIRECT_URL = "invite-user:redirect-url";
const STORAGE_CONCURRENCY = "invite-user:concurrency";
const STORAGE_SEND_EMAIL = "invite-user:send-email";
const STORAGE_GRANT_OWNER = "invite-user:grant-owner";
/**
 * localStorage key for saved invite-templates. Templates persist across
 * reloads (unlike the sessionStorage prefs above) so operators can keep
 * a catalogue of common (redirect, message, send-email, grant-owner)
 * combinations between sessions. Persisted via `usePersistedState` with
 * schema versioning so the shape can evolve.
 */
const STORAGE_TEMPLATES = "invite-user:templates";
const TEMPLATES_SCHEMA_VERSION = 1;
/**
 * localStorage key for the operator-curated "approved invitee domains"
 * allowlist. When non-empty, recipients whose email domain is NOT in the
 * list trigger an inline "out-of-allowlist" warning AND require the
 * `relaxAllowlist` override toggle to be flipped before Submit enables.
 *
 * Corpus grounding: `_bypass_tenant_switch.md §2.3` notes that the default
 * `authorizationPolicy.allowInvitesFrom = everyone` is a chain-of-invites
 * primitive — any member or guest can invite further guests. A page-local
 * allowlist gives the operator a stop-gap policy when the tenant-level
 * policy hasn't been tightened yet. Stored locally per-operator (no
 * server side enforcement — defenders should still tighten the tenant
 * policy).
 */
const STORAGE_APPROVED_DOMAINS = "invite-user:approved-domains";
const APPROVED_DOMAINS_SCHEMA_VERSION = 1;
/**
 * sessionStorage key for the explicit "relax allowlist" override. Lives
 * in sessionStorage (NOT localStorage) on purpose: the operator must
 * re-affirm the override per browser session so a long-lived tab doesn't
 * silently keep the allowlist disabled across days.
 */
const STORAGE_RELAX_ALLOWLIST = "invite-user:relax-allowlist";
/**
 * Composite key used to address a (account, destination-tenant) pair in
 * the inviter selector. Stable, dedupes correctly across the N×M shape
 * of the new multi-tenant selector.
 */
function inviterKey(i) {
    return `${i.homeAccountId}|${i.tenantId}`;
}
/** Column descriptors for the post-submit results export (CSV/JSON). */
const OUTCOME_EXPORT_COLUMNS = [
    { header: "Email", accessor: (o) => o.email },
    { header: "Invite status", accessor: (o) => o.invite.state },
    {
        header: "Invited user id",
        accessor: (o) => (o.invite.state === "success" ? o.invite.userId : ""),
    },
    {
        header: "Invited UPN",
        accessor: (o) => { var _a; return o.invite.state === "success" ? ((_a = o.invite.upn) !== null && _a !== void 0 ? _a : "") : ""; },
    },
    {
        header: "Display name",
        accessor: (o) => { var _a; return o.invite.state === "success" ? ((_a = o.invite.displayName) !== null && _a !== void 0 ? _a : "") : ""; },
    },
    {
        header: "Emailed by Microsoft",
        accessor: (o) => o.invite.state === "success" ? (o.invite.emailed ? "yes" : "no") : "",
    },
    {
        header: "Redeem URL",
        accessor: (o) => (o.invite.state === "success" ? o.invite.redeemUrl : ""),
    },
    {
        header: "Graph status",
        accessor: (o) => { var _a; return o.invite.state === "success" ? ((_a = o.invite.graphStatus) !== null && _a !== void 0 ? _a : "") : ""; },
    },
    {
        header: "Invite error",
        accessor: (o) => (o.invite.state === "failure" ? o.invite.error : ""),
    },
    { header: "Owner grant status", accessor: (o) => o.ownerGrant.state },
    {
        header: "Owner grant alreadyExisted",
        accessor: (o) => o.ownerGrant.state === "success" ? o.ownerGrant.alreadyExisted : "",
    },
    {
        header: "Owner grant error",
        accessor: (o) => o.ownerGrant.state === "failure" ? o.ownerGrant.error : "",
    },
];
// ---------------------------------------------------------------------------
// sessionStorage helpers (safe no-op when storage is disabled / quota'd)
// ---------------------------------------------------------------------------
function readSession(key, fallback = "") {
    var _a;
    try {
        return (_a = sessionStorage.getItem(key)) !== null && _a !== void 0 ? _a : fallback;
    }
    catch (_b) {
        return fallback;
    }
}
function writeSession(key, value) {
    try {
        sessionStorage.setItem(key, value);
    }
    catch (_a) {
        /* sessionStorage may be unavailable in private mode / disk-full */
    }
}
// ---------------------------------------------------------------------------
// Email parsing & classification
// ---------------------------------------------------------------------------
/**
 * RFC-5322-ish lite check: at least one `@`, no whitespace, has a dot in
 * the domain part, total length <= 254. Good enough for "did the operator
 * paste something that resembles an address" without false-rejecting
 * tagged addresses (`alice+work@example.com`) or unusual TLDs.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Consumer / free-mail / high-personal-risk domains. Recipients on these
 * domains are typically tied to a single human's personal identity — if
 * the operator grants them a directory role or subscription Owner, the
 * compromise blast-radius equals "whoever controls the personal account".
 *
 * Corpus grounding:
 *   - `_bypass_tenant_switch.md §2.1` — the canonical attacker example
 *     literally uses `attacker@gmail.com` as `invitedUserEmailAddress`
 *     because consumer-mail accounts are trivially registered by the
 *     attacker.
 *   - `_bypass_tenant_switch.md §2.4` — "Privileged stale guests":
 *     personal account 18 months later gets compromised and the original
 *     guest grant becomes a foothold. Consumer-mail guests are
 *     disproportionately represented in this finding.
 *   - `_bypass_role_grant.md §9` — "Stale guest with role" survives
 *     password reset / MFA reset of the inviter; the guest principal
 *     keeps its Azure RBAC assignment.
 *
 * The set is intentionally conservative — it covers the major free-mail
 * providers that show up in real findings. NOT a block-list: an
 * inline warning + (when Owner-grant is enabled) an elevated red banner
 * flag the risk so the operator can decide.
 */
const HIGH_RISK_DOMAINS = new Set([
    // Microsoft consumer
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "passport.com",
    // Google
    "gmail.com",
    "googlemail.com",
    // Yahoo
    "yahoo.com",
    "yahoo.co.uk",
    "yahoo.co.jp",
    "ymail.com",
    "rocketmail.com",
    // Apple
    "icloud.com",
    "me.com",
    "mac.com",
    // Other major free-mail
    "aol.com",
    "gmx.com",
    "gmx.de",
    "mail.com",
    "mail.ru",
    "yandex.ru",
    "yandex.com",
    "proton.me",
    "protonmail.com",
    "tutanota.com",
    "zoho.com",
    // Disposable / temp-mail
    "guerrillamail.com",
    "10minutemail.com",
    "mailinator.com",
    "yopmail.com",
    "temp-mail.org",
    "tempmail.com",
    "trashmail.com",
    "throwawaymail.com",
    "dispostable.com",
    "fakeinbox.com",
]);
/** Disposable-mail subset of HIGH_RISK_DOMAINS — flagged at a higher
 *  severity. A guest principal anchored to a disposable address is a
 *  textbook "register then walk away" persistence primitive: the
 *  attacker doesn't even need to keep the inbox. */
const DISPOSABLE_DOMAINS = new Set([
    "guerrillamail.com",
    "10minutemail.com",
    "mailinator.com",
    "yopmail.com",
    "temp-mail.org",
    "tempmail.com",
    "trashmail.com",
    "throwawaymail.com",
    "dispostable.com",
    "fakeinbox.com",
]);
/** Lowercase domain part of an email — `null` if the address is
 *  malformed and the split returns an empty string. */
function domainOf(email) {
    const at = email.lastIndexOf("@");
    if (at < 0 || at >= email.length - 1)
        return null;
    const d = email.slice(at + 1).trim().toLowerCase();
    return d.length > 0 ? d : null;
}
/** Categorise the risk of inviting an address as a guest. `disposable`
 *  > `consumer` > `normal`. */
function classifyInviteeDomain(email) {
    const d = domainOf(email);
    if (!d)
        return "normal";
    if (DISPOSABLE_DOMAINS.has(d))
        return "disposable";
    if (HIGH_RISK_DOMAINS.has(d))
        return "consumer";
    return "normal";
}
/**
 * Optional "did the operator paste a tenant-internal address that
 * Microsoft will reject" heuristic. Returns a hint string (or null
 * if the address looks externally invitable).
 *
 * Today this is a single rule (.onmicrosoft.com), but the signature
 * leaves room for tenant-specific checks (e.g. "this address already
 * belongs to a member of the inviter's tenant").
 */
function inferInviteWarning(email) {
    // .onmicrosoft.com addresses are tenant-internal — Graph rejects invites
    // targeting any onmicrosoft.com subdomain. Surface so the operator
    // doesn't waste a retry loop.
    const lower = email.toLowerCase();
    if (lower.endsWith(".onmicrosoft.com")) {
        return "Microsoft-managed (.onmicrosoft.com) — typically can't be invited as guest.";
    }
    return null;
}
/**
 * Parse a free-text block (newline / comma / semicolon / whitespace
 * separated) into deduplicated valid / invalid lists. Case is preserved
 * for display, but dedup is case-insensitive (most SMTP servers treat
 * the local part case-insensitively, and operators expect a paste
 * containing both `Alice@x` and `alice@X` to result in one chip).
 *
 * Returns the original index of each input token so duplicates can be
 * surfaced to the operator (e.g. "alice@example.com appears 3x — kept once").
 */
function parseEmailList(raw) {
    const seen = new Set();
    const duplicateSet = new Set();
    const valid = [];
    const invalid = [];
    // Token separator: regular whitespace + comma/semicolon + non-breaking
    // space (` `) which sneaks in when operators paste from Outlook /
    // Word / a corporate intranet rendering. Per-token: strip BOM
    // (`﻿`) and zero-width spaces (`​`) which Outlook adds
    // around mailto: links — the address looks identical but EMAIL_REGEX
    // would otherwise mis-flag it as invalid.
    const tokens = raw
        .split(/[\s,; ]+/)
        .map((t) => t
        .replace(/[ ​﻿⁠]/g, "")
        // strip angle-bracket wrappers from "Alice <alice@x>" style entries
        .replace(/^<|>$/g, "")
        .trim())
        .filter((t) => t.length > 0);
    for (const t of tokens) {
        const lower = t.toLowerCase();
        if (seen.has(lower)) {
            duplicateSet.add(t);
            continue;
        }
        seen.add(lower);
        if (EMAIL_REGEX.test(t) && t.length <= 254) {
            valid.push(t);
        }
        else {
            invalid.push(t);
        }
    }
    return { valid, invalid, duplicates: Array.from(duplicateSet) };
}
/**
 * Parse a CSV-ish block into `{ rows, invalid, duplicates }`.
 *
 * Accepted shapes (header is auto-detected — first row with the literal
 * "email" cell is treated as a header):
 *
 *   email
 *   email,displayName
 *   email,displayName,customMessage
 *
 * Separator is `,` OR `;` — chosen by whichever appears MORE in the first
 * non-empty line (so semicolon-locale Excel exports work without
 * conversion). Cells may be `"`-quoted to embed the separator or a
 * newline. Duplicates are dedup'd case-insensitively, keeping the first
 * non-empty override for each address (so a later row with a richer
 * displayName supersedes an earlier bare one).
 *
 * This is intentionally not a full RFC-4180 parser — embedded newlines
 * inside quoted cells aren't supported (rare for invite payloads and
 * complicates the streaming chip preview). The parser DOES handle
 * `""`-escaped quote characters inside a quoted cell.
 */
function parseCsvInvites(raw) {
    var _a, _b, _c;
    // Strip leading UTF-8 BOM (`﻿`) — Excel "Save As CSV (UTF-8)" emits
    // one, and without stripping the literal "email" header-cell match
    // below silently fails (first cell becomes "﻿email"). Also
    // accepts a bare `\r` line break (Classic-Mac line endings) for
    // robustness on the rare hand-edited file.
    const trimmed = raw.replace(/^﻿/, "").trim();
    if (!trimmed)
        return { rows: [], invalid: [], duplicates: [] };
    const lines = trimmed
        .split(/\r\n|\r|\n/)
        .filter((l) => l.trim().length > 0);
    if (lines.length === 0)
        return { rows: [], invalid: [], duplicates: [] };
    // Separator detection — count `,` vs `;` in the first non-empty row,
    // pick the more frequent one. Default to `,` on a tie.
    const first = lines[0];
    const commaCount = (first.match(/,/g) || []).length;
    const semiCount = (first.match(/;/g) || []).length;
    const sep = semiCount > commaCount ? ";" : ",";
    const splitRow = (line) => {
        const out = [];
        let cur = "";
        let inQuote = false;
        for (let i = 0; i < line.length; i += 1) {
            const ch = line[i];
            if (inQuote) {
                if (ch === '"' && line[i + 1] === '"') {
                    cur += '"';
                    i += 1;
                }
                else if (ch === '"') {
                    inQuote = false;
                }
                else {
                    cur += ch;
                }
            }
            else if (ch === '"') {
                inQuote = true;
            }
            else if (ch === sep) {
                out.push(cur);
                cur = "";
            }
            else {
                cur += ch;
            }
        }
        out.push(cur);
        return out.map((c) => c.trim());
    };
    // Header detection — first row whose first cell == "email" (case-insens.).
    const firstCells = splitRow(first);
    const hasHeader = firstCells.length > 0 &&
        firstCells[0].toLowerCase().replace(/[_\s]/g, "") === "email";
    const colIndex = { email: 0, displayName: 1, customMessage: 2 };
    if (hasHeader) {
        for (let i = 0; i < firstCells.length; i += 1) {
            const k = firstCells[i].toLowerCase().replace(/[_\s]/g, "");
            if (k === "email")
                colIndex.email = i;
            else if (k === "displayname" || k === "name")
                colIndex.displayName = i;
            else if (k === "message" ||
                k === "custommessage" ||
                k === "customizedmessagebody") {
                colIndex.customMessage = i;
            }
        }
    }
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const seen = new Map(); // lower-email → index in rows[]
    const duplicateSet = new Set();
    const rows = [];
    const invalid = [];
    for (const line of dataLines) {
        const cells = splitRow(line);
        const email = ((_a = cells[colIndex.email]) !== null && _a !== void 0 ? _a : "").trim();
        if (!email)
            continue;
        if (!EMAIL_REGEX.test(email) || email.length > 254) {
            invalid.push(email);
            continue;
        }
        const lower = email.toLowerCase();
        const dn = ((_b = cells[colIndex.displayName]) !== null && _b !== void 0 ? _b : "").trim();
        const cm = ((_c = cells[colIndex.customMessage]) !== null && _c !== void 0 ? _c : "").trim();
        const existing = seen.get(lower);
        if (existing !== undefined) {
            duplicateSet.add(email);
            // Upgrade earlier row with non-empty overrides from the later one
            // (operator's intent: more-specific entry wins).
            const prev = rows[existing];
            if (!prev.displayName && dn)
                prev.displayName = dn;
            if (!prev.customMessage && cm)
                prev.customMessage = cm;
            continue;
        }
        seen.set(lower, rows.length);
        rows.push({
            email,
            displayName: dn || undefined,
            customMessage: cm || undefined,
        });
    }
    return { rows, invalid, duplicates: Array.from(duplicateSet) };
}
// ---------------------------------------------------------------------------
// Bounded-concurrency runner
// ---------------------------------------------------------------------------
/**
 * Run `worker(item, index)` over `items` with at most `limit` in flight.
 * Resolves once every worker has settled. Errors per item are NOT
 * re-thrown — the worker is expected to record outcome itself; this
 * helper is just a scheduler.
 *
 * `shouldAbort` is checked between dispatches so a cancellation mid-batch
 * still leaves pending items "unstarted" rather than racing to completion.
 */
function runBoundedConcurrent(items, limit, shouldAbort, worker) {
    return __awaiter(this, void 0, void 0, function* () {
        const safeLimit = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(limit)));
        let cursor = 0;
        const inFlight = [];
        const next = () => {
            if (shouldAbort())
                return null;
            const idx = cursor++;
            if (idx >= items.length)
                return null;
            const p = (() => __awaiter(this, void 0, void 0, function* () {
                try {
                    yield worker(items[idx], idx);
                }
                catch (_a) {
                    /* worker swallows its own errors into per-row state */
                }
            }))();
            return p;
        };
        for (let i = 0; i < safeLimit; i++) {
            const p = next();
            if (p)
                inFlight.push(p);
        }
        while (inFlight.length > 0) {
            const settled = yield Promise.race(inFlight.map((p, i) => p.then(() => i)));
            inFlight.splice(settled, 1);
            const followup = next();
            if (followup)
                inFlight.push(followup);
        }
    });
}
// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const InviteUserPage = () => {
    var _a, _b, _c, _d, _e;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    // -------------------------------------------------------------------------
    // Inviter resolution: auto-detect (role probe) or manual pick.
    // -------------------------------------------------------------------------
    const [inviterMode, setInviterModeState] = React.useState(() => readSession(STORAGE_INVITER_MODE) === "manual" ? "manual" : "auto");
    const [manualInviterId, setManualInviterIdState] = React.useState(() => readSession(STORAGE_MANUAL_ACCOUNT));
    const handleSetInviterMode = React.useCallback((mode) => {
        setInviterModeState(mode);
        writeSession(STORAGE_INVITER_MODE, mode);
    }, []);
    const handleSetManualInviterId = React.useCallback((id) => {
        setManualInviterIdState(id);
        writeSession(STORAGE_MANUAL_ACCOUNT, id);
    }, []);
    // Per-account map of every tenant the account can access via ARM. An
    // account that's a guest in N tenants will surface up to N entries
    // here — each one is a valid invitation destination (subject to the
    // role probe below). Populated lazily by `listAccessibleTenants`.
    const [accessibleTenantsByAccount, setAccessibleTenantsByAccount] = React.useState({});
    // Per (account, tenant) probe — true when the account holds an Invite
    // role in that tenant. Auto-detect mode filters the inviter list down
    // to entries where this is true. Manual mode ignores it entirely.
    const [privilegedTenantsByAccount, setPrivilegedTenantsByAccount] = React.useState({});
    const [discovering, setDiscovering] = React.useState(true);
    const accountKey = React.useMemo(() => azureAccounts
        .map((a) => `${a.homeAccountId}|${a.tenantId}`)
        .sort()
        .join(","), [azureAccounts]);
    React.useEffect(() => {
        if (azureAccounts.length === 0) {
            setDiscovering(false);
            return;
        }
        let cancelled = false;
        setDiscovering(true);
        (() => __awaiter(void 0, void 0, void 0, function* () {
            const tenantsResults = {};
            const privilegedResults = {};
            yield Promise.allSettled(azureAccounts.map((a) => __awaiter(void 0, void 0, void 0, function* () {
                if (!a.homeAccountId)
                    return;
                // ---- Phase 1: enumerate accessible tenants for this account.
                // Best-effort — a Graph-only / token-imported account may have
                // no ARM consent and 401 here. Fall back to the account's
                // home tenant so the operator can still pick it manually.
                let tenants = [];
                try {
                    tenants = yield listAccessibleTenants(a.homeAccountId);
                }
                catch (_a) {
                    tenants = [];
                }
                // ARM's /tenants occasionally omits the home tenant for guest-
                // primary accounts — synthesise an entry so the home tenant is
                // always offered as a destination.
                if (a.tenantId &&
                    !tenants.some((t) => t.tenantId === a.tenantId)) {
                    tenants = [
                        { tenantId: a.tenantId, displayName: a.tenantId },
                        ...tenants,
                    ];
                }
                tenantsResults[a.homeAccountId] = tenants;
                // ---- Phase 2: probe directory roles per tenant (auto mode).
                // Manual mode skips the probe — operator opts into showing
                // every accessible tenant regardless of role.
                if (inviterMode !== "auto")
                    return;
                const tenantPrivileged = {};
                yield Promise.allSettled(tenants.map((t) => __awaiter(void 0, void 0, void 0, function* () {
                    if (!t.tenantId) {
                        return;
                    }
                    try {
                        // forceRefresh: MSAL's silent cache may hold a Graph
                        // token whose `tid` claim is the account's HOME tenant,
                        // not `t.tenantId`. Silent acquire returns the cached
                        // token ignoring authority — so getMyDirectoryRoles
                        // would probe roles in the wrong tenant.
                        const token = yield getGraphTokenForAccount(a.homeAccountId, t.tenantId, { forceRefresh: true });
                        const roles = yield getMyDirectoryRoles(t.tenantId, token);
                        tenantPrivileged[t.tenantId] = roles.some((r) => INVITE_ROLES.has(r.roleTemplateId));
                    }
                    catch (_b) {
                        tenantPrivileged[t.tenantId] = false;
                    }
                })));
                privilegedResults[a.homeAccountId] = tenantPrivileged;
            })));
            if (!cancelled) {
                setAccessibleTenantsByAccount(tenantsResults);
                setPrivilegedTenantsByAccount(privilegedResults);
                setDiscovering(false);
            }
        }))();
        return () => {
            cancelled = true;
        };
    }, [accountKey, azureAccounts, inviterMode]);
    /**
     * Flat list of every (account, destination-tenant) pair the operator
     * can invite from. Auto mode filters to pairs where the account holds
     * an Invite role; manual mode lists every accessible tenant.
     */
    const inviters = React.useMemo(() => {
        var _a, _b;
        const out = [];
        for (const a of azureAccounts) {
            if (!a.homeAccountId)
                continue;
            // Default tenant set when ARM enumeration hasn't completed: just
            // the account's home tenant. Keeps the page usable while discovery
            // is racing.
            const tenants = (_a = accessibleTenantsByAccount[a.homeAccountId]) !== null && _a !== void 0 ? _a : (a.tenantId
                ? [{ tenantId: a.tenantId, displayName: a.tenantId }]
                : []);
            for (const t of tenants) {
                if (!t.tenantId)
                    continue;
                if (inviterMode === "auto" &&
                    !((_b = privilegedTenantsByAccount[a.homeAccountId]) === null || _b === void 0 ? void 0 : _b[t.tenantId])) {
                    continue;
                }
                out.push({
                    homeAccountId: a.homeAccountId,
                    tenantId: t.tenantId,
                    username: a.username,
                    name: a.name || a.username,
                    tenantDisplayName: t.displayName && t.displayName !== t.tenantId
                        ? t.displayName
                        : t.defaultDomain,
                    isHomeTenant: t.tenantId === a.tenantId,
                });
            }
        }
        return out;
    }, [
        azureAccounts,
        accessibleTenantsByAccount,
        privilegedTenantsByAccount,
        inviterMode,
    ]);
    const [selectedInviterId, setSelectedInviterId] = React.useState("");
    React.useEffect(() => {
        // Back-compat: if storage holds a legacy bare homeAccountId (pre
        // multi-tenant), upgrade by matching the FIRST inviter row for that
        // account. The operator can then re-pick a different destination
        // tenant if they want.
        const upgradedManualKey = (() => {
            if (!manualInviterId)
                return "";
            if (manualInviterId.includes("|"))
                return manualInviterId;
            const first = inviters.find((i) => i.homeAccountId === manualInviterId);
            return first ? inviterKey(first) : "";
        })();
        if (inviterMode === "manual" &&
            upgradedManualKey &&
            inviters.some((i) => inviterKey(i) === upgradedManualKey) &&
            selectedInviterId !== upgradedManualKey) {
            setSelectedInviterId(upgradedManualKey);
            return;
        }
        if (!selectedInviterId && inviters.length > 0) {
            setSelectedInviterId(inviterKey(inviters[0]));
        }
        if (selectedInviterId &&
            !inviters.some((i) => inviterKey(i) === selectedInviterId)) {
            setSelectedInviterId(inviters.length > 0 ? inviterKey(inviters[0]) : "");
        }
    }, [inviters, selectedInviterId, inviterMode, manualInviterId]);
    /**
     * Auto-sync the selected inviter row to the operator's active-tenant
     * choices. Solves two bugs the operator was hitting:
     *
     *   Bug 1 — single-account: switching active tenant globally (header
     *   switcher / Azure Accounts) didn't update the inviter row, so the
     *   invite silently went to the account's HOME tenant. Graph rejects
     *   with "domain is a verified domain of this directory" when the
     *   invitee's email is on a domain verified in the home tenant.
     *
     *   Bug 2 — multi-account: when the operator has accounts A and B
     *   signed in, switching account B's tenant should update the
     *   inviter row to (B, newTenant). The previous implementation used
     *   `selectedInviterAccountId` to pick which account to read active
     *   tenant for — but that's the CURRENTLY-SELECTED row's account,
     *   not the account whose tenant just changed. The result: B's
     *   tenant switch was silently ignored because A was still selected.
     *
     * Behaviour:
     *
     *   - Initial mount picks the inviter row matching the PRIMARY
     *     account's active tenant (the same account the header switcher
     *     pill represents). If there's no matching row (operator lacks
     *     invite-capable role in the active tenant), falls back to
     *     whatever the existing back-compat effect resolved to.
     *
     *   - On TENANT_CHANGED_EVENT, reads `detail.homeAccountId` and
     *     `detail.tenantId` DIRECTLY from the event — so a switch on
     *     ANY account flips the inviter row to match, even if that
     *     account isn't currently selected. (Predictable behaviour:
     *     "the tenant I just switched to is the one I want to invite
     *     into".)
     *
     *   - Both paths bail when no matching inviter row exists rather
     *     than overwriting with a bogus value — the inline warning
     *     Alert elsewhere on the page surfaces the mismatch.
     */
    const initialSyncDoneRef = React.useRef(false);
    React.useEffect(() => {
        if (initialSyncDoneRef.current)
            return;
        if (inviters.length === 0)
            return;
        const primaryAccount = azureAccounts[0];
        if (!primaryAccount)
            return;
        const activeTenantId = getActiveTenant(primaryAccount.homeAccountId);
        if (!activeTenantId)
            return;
        const candidate = `${primaryAccount.homeAccountId}|${activeTenantId}`;
        if (!inviters.some((i) => inviterKey(i) === candidate))
            return;
        if (selectedInviterId === candidate) {
            initialSyncDoneRef.current = true;
            return;
        }
        setSelectedInviterId(candidate);
        if (inviterMode === "manual") {
            handleSetManualInviterId(candidate);
        }
        initialSyncDoneRef.current = true;
    }, [
        inviters,
        azureAccounts,
        selectedInviterId,
        inviterMode,
        handleSetManualInviterId,
    ]);
    // Live tenant-change propagation. Use detail.homeAccountId + detail
    // .tenantId DIRECTLY — that's the account whose tenant just changed,
    // which is the natural target for "switch the invite to use this".
    useTenantChange(undefined, (detail) => {
        const candidate = `${detail.homeAccountId}|${detail.tenantId}`;
        if (!inviters.some((i) => inviterKey(i) === candidate))
            return;
        if (selectedInviterId === candidate)
            return;
        setSelectedInviterId(candidate);
        if (inviterMode === "manual") {
            handleSetManualInviterId(candidate);
        }
    });
    // -------------------------------------------------------------------------
    // Form state
    // -------------------------------------------------------------------------
    const [inviteeEmails, setInviteeEmails] = React.useState("");
    // Per-chip suppression — operator can remove individual emails from the
    // parsed list without re-typing the whole textarea. Stored as a lowercase
    // set since the parser dedups case-insensitively.
    const [suppressedEmails, setSuppressedEmails] = React.useState(() => new Set());
    /**
     * Per-recipient overrides sourced from the CSV-paste panel — lowercase
     * email → { displayName?, customMessage? }. When set, these supersede
     * the page-level defaults for that specific recipient at submit time.
     * Cleared by the "Clear" action on the recipient textarea.
     */
    const [csvOverrides, setCsvOverrides] = React.useState({});
    const [showCsvPaste, setShowCsvPaste] = React.useState(false);
    const [csvPasteText, setCsvPasteText] = React.useState("");
    const [displayName, setDisplayName] = React.useState("");
    const [customMessage, setCustomMessage] = React.useState("");
    const [redirectUrl, setRedirectUrl] = React.useState(() => {
        const saved = readSession(STORAGE_REDIRECT_URL);
        return saved || DEFAULT_REDIRECT_URL;
    });
    const [sendEmail, setSendEmail] = React.useState(() => readSession(STORAGE_SEND_EMAIL) === "1");
    const [concurrency, setConcurrency] = React.useState(() => {
        const raw = parseInt(readSession(STORAGE_CONCURRENCY, ""), 10);
        return Number.isFinite(raw) && raw >= MIN_CONCURRENCY && raw <= MAX_CONCURRENCY
            ? raw
            : DEFAULT_CONCURRENCY;
    });
    // Persist the bits that survive a reload.
    React.useEffect(() => {
        writeSession(STORAGE_REDIRECT_URL, redirectUrl);
    }, [redirectUrl]);
    React.useEffect(() => {
        writeSession(STORAGE_SEND_EMAIL, sendEmail ? "1" : "0");
    }, [sendEmail]);
    React.useEffect(() => {
        writeSession(STORAGE_CONCURRENCY, String(concurrency));
    }, [concurrency]);
    // -------------------------------------------------------------------------
    // Owner-grant section
    // -------------------------------------------------------------------------
    const [grantOwner, setGrantOwner] = React.useState(() => readSession(STORAGE_GRANT_OWNER, "1") === "1");
    React.useEffect(() => {
        writeSession(STORAGE_GRANT_OWNER, grantOwner ? "1" : "0");
    }, [grantOwner]);
    const [subscriptions, setSubscriptions] = React.useState([]);
    const [subsLoading, setSubsLoading] = React.useState(false);
    const [subsError, setSubsError] = React.useState(null);
    const [selectedSubscriptionId, setSelectedSubscriptionId] = React.useState(() => readSession(STORAGE_LAST_SUBSCRIPTION));
    React.useEffect(() => {
        if (selectedSubscriptionId)
            writeSession(STORAGE_LAST_SUBSCRIPTION, selectedSubscriptionId);
    }, [selectedSubscriptionId]);
    // -------------------------------------------------------------------------
    // Saved templates (localStorage, cross-session)
    //
    // The state declarations live here (alongside other persisted form prefs).
    // The callbacks that capture `selectedInviter` are defined further below
    // — see the "Saved templates — callbacks" block — so they can reference
    // `selectedInviter` after it's declared.
    // -------------------------------------------------------------------------
    /**
     * Catalogue of saved (redirectUrl, customMessage, sendEmail, grantOwner,
     * displayName) tuples. Operators apply a template to fill the form in
     * one click — useful when the same invite blurb is reused weekly /
     * for the same product line. The recipient list is intentionally NOT
     * captured (different invitees every time).
     */
    const [savedTemplates, setSavedTemplates] = usePersistedState(STORAGE_TEMPLATES, [], {
        version: TEMPLATES_SCHEMA_VERSION,
        syncAcrossTabs: true,
    });
    const [showTemplateSaver, setShowTemplateSaver] = React.useState(false);
    const [templateNameDraft, setTemplateNameDraft] = React.useState("");
    const [templateToDelete, setTemplateToDelete] = React.useState(null);
    // -------------------------------------------------------------------------
    // Approved-domain allowlist (corpus-grounded — see HIGH_RISK_DOMAINS docs
    // and STORAGE_APPROVED_DOMAINS).
    //
    // The allowlist is a soft control: when populated, recipients on
    // un-listed domains are flagged with a warning AND require the explicit
    // `relaxAllowlist` toggle (session-scoped) before Submit enables. Empty
    // list = no enforcement (default behaviour, back-compat).
    // -------------------------------------------------------------------------
    const [approvedDomains, setApprovedDomains] = usePersistedState(STORAGE_APPROVED_DOMAINS, [], {
        version: APPROVED_DOMAINS_SCHEMA_VERSION,
        syncAcrossTabs: true,
    });
    const [relaxAllowlist, setRelaxAllowlistState] = React.useState(() => readSession(STORAGE_RELAX_ALLOWLIST) === "1");
    const setRelaxAllowlist = React.useCallback((v) => {
        setRelaxAllowlistState(v);
        writeSession(STORAGE_RELAX_ALLOWLIST, v ? "1" : "0");
    }, []);
    const [showAllowlistEditor, setShowAllowlistEditor] = React.useState(false);
    const [allowlistDraft, setAllowlistDraft] = React.useState("");
    /** Normalised lowercase set for O(1) membership checks. */
    const approvedDomainSet = React.useMemo(() => new Set(approvedDomains
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0)), [approvedDomains]);
    // -------------------------------------------------------------------------
    // Submit-side state
    // -------------------------------------------------------------------------
    const [submitting, setSubmitting] = React.useState(false);
    const [bulkGrantInFlight, setBulkGrantInFlight] = React.useState(false);
    const [retryRowId, setRetryRowId] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [outcomes, setOutcomes] = React.useState([]);
    const [copiedKey, setCopiedKey] = React.useState(null);
    const [outcomeFilter, setOutcomeFilter] = React.useState("");
    const [statusFilter, setStatusFilter] = React.useState("all");
    const [showConfirm, setShowConfirm] = React.useState(false);
    const [showBulkGrantConfirm, setShowBulkGrantConfirm] = React.useState(false);
    /**
     * Hard cancellation flag for the submit loop. We use a ref (not state)
     * because the inner async worker captures this object reference at
     * dispatch time — flipping `cancelledRef.current = true` from anywhere
     * (component unmount, "Cancel batch" button) stops further dispatches
     * AND lets in-flight ones see the flag and short-circuit cleanly.
     */
    const cancelledRef = React.useRef(false);
    React.useEffect(() => () => {
        cancelledRef.current = true;
    }, []);
    /**
     * Live counters for the progress aria-live region. Re-evaluated from
     * the outcomes array. Sliced out so the JSX stays readable.
     */
    const progressCounts = React.useMemo(() => {
        let succeeded = 0;
        let failed = 0;
        let cancelled = 0;
        let pending = 0;
        for (const o of outcomes) {
            if (o.invite.state === "success")
                succeeded += 1;
            else if (o.invite.state === "failure")
                failed += 1;
            else if (o.invite.state === "cancelled")
                cancelled += 1;
            else
                pending += 1;
        }
        return { succeeded, failed, cancelled, pending, total: outcomes.length };
    }, [outcomes]);
    // -------------------------------------------------------------------------
    // Derived values
    // -------------------------------------------------------------------------
    const selectedInviter = inviters.find((i) => inviterKey(i) === selectedInviterId);
    const armTokenTracker = useArmToken(selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.homeAccountId, selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.tenantId);
    // -------------------------------------------------------------------------
    // Saved templates — callbacks (placed after `selectedInviter` so they can
    // reference the inviter's username in the audit log).
    // -------------------------------------------------------------------------
    const applyTemplate = React.useCallback((tpl) => {
        var _a;
        setDisplayName(tpl.displayName);
        setRedirectUrl(tpl.redirectUrl);
        setCustomMessage(tpl.customMessage);
        setSendEmail(tpl.sendEmail);
        setGrantOwner(tpl.grantOwner);
        store.addNotification({
            type: "info",
            message: `Applied template "${tpl.name}".`,
        });
        auditLog.record({
            actor: (_a = selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username) !== null && _a !== void 0 ? _a : "(unknown)",
            action: "invite_template_applied",
            target: tpl.id,
            status: "success",
            details: { templateName: tpl.name },
        });
    }, [store, selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username]);
    const saveCurrentAsTemplate = React.useCallback(() => {
        var _a;
        const name = templateNameDraft.trim();
        if (!name)
            return;
        const tpl = {
            id: typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            displayName,
            redirectUrl,
            customMessage,
            sendEmail,
            grantOwner,
            savedAt: new Date().toISOString(),
        };
        setSavedTemplates((prev) => {
            // De-dup by name — overwriting a same-name template is the most
            // common operator intent (iterating on an existing draft).
            const filtered = prev.filter((t) => t.name !== name);
            return [tpl, ...filtered];
        });
        setShowTemplateSaver(false);
        setTemplateNameDraft("");
        store.addNotification({
            type: "success",
            message: `Saved template "${name}".`,
        });
        auditLog.record({
            actor: (_a = selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username) !== null && _a !== void 0 ? _a : "(unknown)",
            action: "invite_template_saved",
            target: tpl.id,
            status: "success",
            details: { templateName: name, sendEmail, grantOwner },
        });
    }, [
        templateNameDraft,
        displayName,
        redirectUrl,
        customMessage,
        sendEmail,
        grantOwner,
        setSavedTemplates,
        store,
        selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username,
    ]);
    const deleteTemplate = React.useCallback((id) => {
        var _a;
        setSavedTemplates((prev) => prev.filter((t) => t.id !== id));
        setTemplateToDelete(null);
        store.addNotification({
            type: "info",
            message: "Template deleted.",
        });
        auditLog.record({
            actor: (_a = selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username) !== null && _a !== void 0 ? _a : "(unknown)",
            action: "invite_template_deleted",
            target: id,
            status: "success",
        });
    }, [setSavedTemplates, store, selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username]);
    // Reload subscription list when inviter (or its destination tenant)
    // changes. Pass the destination tenant explicitly so the listing
    // matches the tenant the operator just picked — without this the
    // ARM token would default to the per-account active tenant which can
    // diverge from the inviter destination after a multi-tenant pick.
    React.useEffect(() => {
        if (!selectedInviter) {
            setSubscriptions([]);
            return;
        }
        let cancelled = false;
        setSubsLoading(true);
        setSubsError(null);
        (() => __awaiter(void 0, void 0, void 0, function* () {
            try {
                // forceRefresh: MSAL's silent cache may return an ARM token
                // whose `tid` claim is for the account's HOME tenant instead
                // of `selectedInviter.tenantId`, causing listSubscriptions to
                // return the wrong tenant's subs.
                const armToken = yield getArmTokenForAccount(selectedInviter.homeAccountId, selectedInviter.tenantId, { forceRefresh: true });
                const subs = yield listSubscriptions(armToken);
                if (cancelled)
                    return;
                setSubscriptions(subs);
                // Auto-pick when there's exactly one subscription so the operator
                // doesn't have to interact with the dropdown.
                if (subs.length === 1) {
                    setSelectedSubscriptionId(subs[0].subscriptionId);
                }
                else if (subs.length > 0 &&
                    !subs.some((s) => s.subscriptionId === selectedSubscriptionId)) {
                    // Persisted sub isn't visible to this inviter — clear so the
                    // dropdown shows the placeholder rather than a phantom id.
                    setSelectedSubscriptionId("");
                }
            }
            catch (err) {
                if (cancelled)
                    return;
                setSubsError(err instanceof Error ? err.message : String(err));
                setSubscriptions([]);
            }
            finally {
                if (!cancelled)
                    setSubsLoading(false);
            }
        }))();
        return () => {
            cancelled = true;
        };
        // selectedSubscriptionId intentionally excluded — re-running on its
        // own change would clobber the operator's pick.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.homeAccountId, selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.tenantId]);
    /**
     * Active recipient list = parser output minus chips the operator
     * removed. Kept as a memo so chip-removal & textarea changes share
     * the same derivation pipeline.
     */
    const parsedEmails = React.useMemo(() => {
        const raw = parseEmailList(inviteeEmails);
        const activeValid = raw.valid.filter((e) => !suppressedEmails.has(e.toLowerCase()));
        return Object.assign(Object.assign({}, raw), { activeValid });
    }, [inviteeEmails, suppressedEmails]);
    /**
     * Memoized preview of the CSV-paste textarea. Recomputed on every
     * keystroke (cheap for typical pastes; the panel only renders when
     * `showCsvPaste` is true) and reused by the Append/Replace handlers
     * so they don't pay the parsing cost a second time.
     */
    const csvPreview = React.useMemo(() => parseCsvInvites(csvPasteText), [csvPasteText]);
    /** Heuristic warnings for the active recipients (e.g. onmicrosoft.com). */
    const recipientWarnings = React.useMemo(() => {
        const warnings = [];
        for (const email of parsedEmails.activeValid) {
            const w = inferInviteWarning(email);
            if (w)
                warnings.push({ email, warning: w });
        }
        return warnings;
    }, [parsedEmails.activeValid]);
    /**
     * Per-recipient classification by domain risk. Computed once per
     * recipient-list change and reused by the chip-list rendering, the
     * high-risk summary banner, and the Owner-grant red-flag banner.
     *
     * Corpus: `_bypass_tenant_switch.md §2.1/§2.4` (consumer-mail B2B
     * abuse), `_bypass_role_grant.md §9` (stale-guest persistence
     * survives credential rotation).
     */
    const recipientRiskByEmail = React.useMemo(() => {
        const map = {};
        for (const email of parsedEmails.activeValid) {
            map[email.toLowerCase()] = classifyInviteeDomain(email);
        }
        return map;
    }, [parsedEmails.activeValid]);
    const highRiskRecipients = React.useMemo(() => {
        const consumer = [];
        const disposable = [];
        for (const email of parsedEmails.activeValid) {
            const k = recipientRiskByEmail[email.toLowerCase()];
            if (k === "consumer")
                consumer.push(email);
            else if (k === "disposable")
                disposable.push(email);
        }
        return { consumer, disposable, total: consumer.length + disposable.length };
    }, [parsedEmails.activeValid, recipientRiskByEmail]);
    /** Recipients whose domain is NOT in the operator's approved allowlist.
     *  Empty list = allowlist disabled = nothing flagged. */
    const unapprovedDomainRecipients = React.useMemo(() => {
        if (approvedDomainSet.size === 0)
            return [];
        const out = [];
        for (const email of parsedEmails.activeValid) {
            const d = domainOf(email);
            if (!d || !approvedDomainSet.has(d))
                out.push(email);
        }
        return out;
    }, [parsedEmails.activeValid, approvedDomainSet]);
    const unapprovedDomainSet = React.useMemo(() => {
        const out = new Set();
        for (const e of unapprovedDomainRecipients) {
            const d = domainOf(e);
            if (d)
                out.add(d);
        }
        return out;
    }, [unapprovedDomainRecipients]);
    /**
     * Last-14-day invites-per-day series, sourced from the audit log's
     * `invite_guest` success entries. Re-derives on every auditLog change
     * via the `onChange` subscription — cheap (~O(N) over ~hundreds of
     * entries). Used by the inline sparkline next to the form header so
     * the operator can see "did anyone in this org already invite people
     * in the last 2 weeks" before adding more.
     *
     * Bucketing is by local-day; the rightmost entry is "today".
     */
    const [auditHistoryVersion, setAuditHistoryVersion] = React.useState(0);
    React.useEffect(() => {
        // The unsubscribe returned by auditLog.onChange handles cleanup.
        return auditLog.onChange(() => setAuditHistoryVersion((v) => v + 1));
    }, []);
    const invitesPerDay = React.useMemo(() => {
        const DAYS = 14;
        const bins = new Array(DAYS).fill(0);
        const now = Date.now();
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);
        const todayStart = todayMidnight.getTime();
        const earliest = todayStart - (DAYS - 1) * 86400000;
        try {
            for (const entry of auditLog.getEntries()) {
                if (entry.action !== "invite_guest")
                    continue;
                if (entry.status !== "success")
                    continue;
                const t = Date.parse(entry.timestamp);
                if (!Number.isFinite(t))
                    continue;
                if (t < earliest || t > now + 86400000)
                    continue;
                const dayIdx = Math.floor((t - earliest) / 86400000);
                if (dayIdx >= 0 && dayIdx < DAYS)
                    bins[dayIdx] += 1;
            }
        }
        catch (_a) {
            /* defensive — audit log getEntries should never throw */
        }
        return bins;
        // auditHistoryVersion is the React-visible re-render trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [auditHistoryVersion]);
    const totalInvitesLast14 = React.useMemo(() => invitesPerDay.reduce((s, n) => s + n, 0), [invitesPerDay]);
    /**
     * Verified-domain pre-flight check for the destination tenant.
     *
     * Graph's `POST /invitations` REQUIRES the invitee's email domain to
     * NOT be a verified domain of the inviter's tenant — if the domain
     * IS verified, the invitee should already exist as a member (or be
     * added via `POST /users`). Pre-fetching the verified-domain list
     * lets us flag conflicting recipients BEFORE the operator clicks
     * Submit, instead of letting Graph reject one row at a time.
     *
     * - Cache keyed by tenantId (per inviter) — domains are stable, no
     *   need to refetch on every render.
     * - Lazy: only fetches when an inviter is selected.
     * - Best-effort: a 403 / 401 just sets the cache to null, the
     *   pre-flight badges hide, and the operator falls back to the
     *   post-submit error path (which already has the verified-domain
     *   classifier).
     * - Re-fetches when the destination tenant changes (different
     *   inviter row picked OR active tenant flipped + auto-sync moved
     *   the row).
     */
    const [verifiedDomainsByTenant, setVerifiedDomainsByTenant] = React.useState({});
    React.useEffect(() => {
        if (!selectedInviter)
            return;
        const tenantId = selectedInviter.tenantId;
        if (!tenantId)
            return;
        if (verifiedDomainsByTenant[tenantId] !== undefined)
            return; // cache hit
        let cancelled = false;
        void (() => __awaiter(void 0, void 0, void 0, function* () {
            try {
                // forceRefresh: domain-verification probe must hit the chosen
                // tenant — MSAL's silent cache could otherwise return the
                // home-tenant Graph token and we'd query the wrong tenant's
                // verifiedDomains, producing a misleading "domain conflict"
                // decision for the invite flow.
                const token = yield getGraphTokenForAccount(selectedInviter.homeAccountId, tenantId, { forceRefresh: true });
                const domains = yield listVerifiedDomains(tenantId, token);
                if (cancelled)
                    return;
                setVerifiedDomainsByTenant((prev) => (Object.assign(Object.assign({}, prev), { [tenantId]: domains.map((d) => d.name.toLowerCase()) })));
            }
            catch (_a) {
                if (cancelled)
                    return;
                // Mark as "fetched but unavailable" so we don't retry the
                // probe on every render. The submit path's verified-domain
                // error classifier still fires post-Graph for these.
                setVerifiedDomainsByTenant((prev) => (Object.assign(Object.assign({}, prev), { [tenantId]: null })));
            }
        }))();
        return () => {
            cancelled = true;
        };
    }, [
        selectedInviter,
        verifiedDomainsByTenant,
    ]);
    /**
     * Per-recipient verified-domain conflicts — emails whose domain
     * appears in the destination tenant's verified-domains list. These
     * WILL fail with `Request_BadRequest verified domain` if submitted
     * as an invitation; the operator should either remove them OR use
     * the "Add as members instead" path below.
     */
    const verifiedDomainConflicts = React.useMemo(() => {
        var _a;
        if (!selectedInviter)
            return [];
        const verified = verifiedDomainsByTenant[selectedInviter.tenantId];
        if (!verified || verified.length === 0)
            return [];
        const out = [];
        for (const email of parsedEmails.activeValid) {
            const domain = (_a = email.split("@")[1]) === null || _a === void 0 ? void 0 : _a.toLowerCase();
            if (domain && verified.includes(domain)) {
                out.push(email);
            }
        }
        return out;
    }, [
        parsedEmails.activeValid,
        selectedInviter,
        verifiedDomainsByTenant,
    ]);
    const [addMemberResults, setAddMemberResults] = React.useState([]);
    const [addingAsMembers, setAddingAsMembers] = React.useState(false);
    const handleAddAsMembers = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _f, _g;
        if (!selectedInviter || verifiedDomainConflicts.length === 0)
            return;
        setAddingAsMembers(true);
        setAddMemberResults([]);
        try {
            const tenantId = selectedInviter.tenantId;
            // forceRefresh: the create-user-in-destination-tenant flow only
            // succeeds when the Graph token's `tid` matches the destination
            // tenant. MSAL's silent cache may return a stale home-tenant
            // token whose audience/scopes match — would create the user in
            // the WRONG directory.
            const token = yield getGraphTokenForAccount(selectedInviter.homeAccountId, tenantId, { forceRefresh: true });
            // Strong-password generator — 20 chars, 4 character classes
            // guaranteed in the first 4 positions (which the AAD policy
            // engine usually scans).
            const genPw = () => {
                const lo = "abcdefghijkmnpqrstuvwxyz";
                const hi = "ABCDEFGHJKLMNPQRSTUVWXYZ";
                const dg = "23456789";
                const sy = "!@#$%^&*-_=+";
                const all = lo + hi + dg + sy;
                const buf = new Uint32Array(20);
                crypto.getRandomValues(buf);
                let pw = "";
                for (let i = 0; i < 20; i += 1) {
                    pw += all[buf[i] % all.length];
                }
                pw =
                    lo[buf[0] % lo.length] +
                        hi[buf[1] % hi.length] +
                        dg[buf[2] % dg.length] +
                        sy[buf[3] % sy.length] +
                        pw.slice(4);
                return pw;
            };
            const tenantSuffix = (_f = selectedInviter.tenantDisplayName) !== null && _f !== void 0 ? _f : tenantId;
            const results = [];
            for (const email of verifiedDomainConflicts) {
                try {
                    const local = (_g = email.split("@")[0]) !== null && _g !== void 0 ? _g : "user";
                    const password = genPw();
                    const result = yield createUser(tenantId, {
                        userPrincipalName: email,
                        displayName: email,
                        mailNickname: local,
                        password,
                        forceChangePasswordNextSignIn: true,
                        accountEnabled: true,
                    }, token);
                    results.push({
                        email,
                        ok: true,
                        upn: result.userPrincipalName,
                        userId: result.id,
                        password,
                    });
                    auditLog.record({
                        actor: selectedInviter.username,
                        action: "create_user_as_member_fallback",
                        target: email,
                        status: "success",
                        details: {
                            tenantId,
                            userId: result.id,
                            originalAction: "invite_guest",
                            reason: "verified_domain_conflict",
                        },
                    });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    results.push({ email, ok: false, error: msg });
                    auditLog.record({
                        actor: selectedInviter.username,
                        action: "create_user_as_member_fallback",
                        target: email,
                        status: "failure",
                        error: msg,
                        details: { tenantId },
                    });
                }
            }
            setAddMemberResults(results);
            const okCount = results.filter((r) => r.ok).length;
            const failCount = results.length - okCount;
            store.addNotification({
                type: okCount > 0 ? "success" : "error",
                message: `Add-as-member into ${tenantSuffix}: ${okCount} created, ${failCount} failed. ` +
                    `Generated passwords are visible in the panel below — copy them before navigating away.`,
            });
        }
        finally {
            setAddingAsMembers(false);
        }
    }), [
        selectedInviter,
        verifiedDomainConflicts,
        store,
    ]);
    const redirectIsHttps = React.useMemo(() => {
        try {
            const u = new URL(redirectUrl.trim());
            return u.protocol === "https:";
        }
        catch (_a) {
            return false;
        }
    }, [redirectUrl]);
    /**
     * Allowlist gate — when the operator has populated an approved-domain
     * allowlist, and at least one active recipient is OUTSIDE that list,
     * Submit is disabled until they flip the `relaxAllowlist` toggle. The
     * goal is to make "I am inviting an out-of-policy domain" a deliberate
     * acknowledgement instead of a silent default. Corpus: see
     * STORAGE_APPROVED_DOMAINS doc and `_bypass_tenant_switch.md §2.3`.
     */
    const allowlistBlocks = approvedDomainSet.size > 0 &&
        unapprovedDomainRecipients.length > 0 &&
        !relaxAllowlist;
    const canSubmit = !submitting &&
        !!selectedInviter &&
        parsedEmails.activeValid.length > 0 &&
        redirectUrl.trim().length > 0 &&
        redirectIsHttps &&
        (!grantOwner || selectedSubscriptionId.length > 0) &&
        !allowlistBlocks;
    // -------------------------------------------------------------------------
    // Submit pipeline
    // -------------------------------------------------------------------------
    /**
     * Mutate a single row in the outcomes array by stable rowId. Avoids
     * the "match-by-email" bug where duplicate emails would cross-write
     * each other's state.
     */
    const updateRow = React.useCallback((rowId, patch) => {
        setOutcomes((prev) => prev.map((o) => (o.rowId === rowId ? Object.assign(Object.assign({}, o), patch) : o)));
    }, []);
    /**
     * Process a single recipient row end-to-end: Graph invite, optional
     * Owner-grant. Cancellation-aware between the two phases.
     *
     * Tokens are pulled fresh at row-dispatch time so a long batch (5+
     * minutes) doesn't fail late rows with stale-token 401s. `useArmToken`
     * keeps MSAL warm in parallel.
     */
    const processOneRow = React.useCallback((row, inviter, opts) => __awaiter(void 0, void 0, void 0, function* () {
        var _h, _j, _k, _l, _m;
        if (cancelledRef.current) {
            updateRow(row.rowId, {
                invite: { state: "cancelled" },
                ownerGrant: row.ownerGrant.state === "skipped"
                    ? row.ownerGrant
                    : { state: "cancelled" },
            });
            return;
        }
        updateRow(row.rowId, { invite: { state: "running" } });
        // Per-recipient overrides win over page-level defaults. Empty / undefined
        // overrides fall through.
        const effDisplayName = ((_j = (_h = opts.rowOverrides) === null || _h === void 0 ? void 0 : _h.displayName) === null || _j === void 0 ? void 0 : _j.trim()) || opts.displayName;
        const effCustomMessage = ((_l = (_k = opts.rowOverrides) === null || _k === void 0 ? void 0 : _k.customMessage) === null || _l === void 0 ? void 0 : _l.trim()) || opts.customMessage;
        // --- Invite step ----------------------------------------------------
        // `inviter.tenantId` is the EXACT tenant the operator picked from
        // the (account × accessible-tenant) selector — already per-row, NOT
        // the account's home. The auto-sync effect below keeps this row in
        // step with the global active tenant on switch, so by the time we
        // get here `inviter.tenantId` is always the right destination.
        //
        // `forceRefresh: true` is REQUIRED here. The Graph /invitations
        // endpoint isn't tenant-scoped in the URL — the destination tenant
        // comes from the access token's `tid` claim. MSAL's silent-acquire
        // cache may hold a previously-minted Graph token whose scopes
        // match, and silent acquire returns the cached token IGNORING the
        // requested `authority` parameter. Result: the invite is sent to
        // the cached token's tenant and the redeem URL points at that
        // (wrong) tenant. Forcing a refresh skips the silent cache and
        // mints a fresh token authority-scoped to `inviter.tenantId`.
        let invitedUserId = null;
        let inviteOk = false;
        try {
            const graphToken = yield getGraphTokenForAccount(inviter.homeAccountId, inviter.tenantId, { forceRefresh: true });
            const res = yield inviteGuest(inviter.tenantId, {
                invitedUserEmailAddress: row.email,
                invitedUserDisplayName: effDisplayName.trim() || undefined,
                inviteRedirectUrl: opts.redirectUrl.trim(),
                sendInvitationMessage: opts.sendEmail,
                customizedMessageBody: opts.sendEmail && effCustomMessage.trim()
                    ? effCustomMessage.trim()
                    : undefined,
            }, graphToken);
            invitedUserId = res.invitedUser.id;
            inviteOk = true;
            updateRow(row.rowId, {
                invite: {
                    state: "success",
                    userId: res.invitedUser.id,
                    upn: res.invitedUser.userPrincipalName,
                    displayName: res.invitedUser.displayName,
                    redeemUrl: res.inviteRedeemUrl,
                    emailed: res.sendInvitationMessage,
                    graphStatus: res.status,
                },
            });
            auditLog.record({
                actor: inviter.username,
                action: "invite_guest",
                target: row.email,
                status: "success",
                details: {
                    tenantId: inviter.tenantId,
                    invitedUserId: res.invitedUser.id,
                    sendInvitationMessage: res.sendInvitationMessage,
                },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Extract Graph error code from the message — used for hint UI.
            const codeMatch = /\b([A-Z][A-Za-z]+(?:Error|Exists|Denied)?)\b/.exec(msg);
            // Classify the specific "domain is a verified domain of this
            // directory" 400 so the operator sees an actionable hint
            // instead of the raw Graph error. This fires when the
            // invitee's email belongs to a domain already verified in
            // the inviter's tenant — Graph requires an `addUser` instead
            // of an `invitation` in that case, OR the operator just
            // picked the wrong tenant (e.g. they meant to invite into a
            // sibling tenant where the email's domain isn't verified).
            const isVerifiedDomainError = /verified domain of this directory/i.test(msg) ||
                /Request_BadRequest.*verified domain/i.test(msg);
            const enrichedError = isVerifiedDomainError
                ? `${msg}\n\nHint: the invitee's email domain is verified in the destination tenant (${(_m = inviter.tenantDisplayName) !== null && _m !== void 0 ? _m : inviter.tenantId}). Either (a) the user already exists as a member in this directory — invite them directly instead, or (b) you picked the wrong tenant — switch to a tenant where the email's domain is NOT verified (header tenant switcher / Azure Accounts page) and try again.`
                : msg;
            updateRow(row.rowId, {
                invite: {
                    state: "failure",
                    error: enrichedError,
                    errorCode: isVerifiedDomainError
                        ? "VerifiedDomainConflict"
                        : codeMatch === null || codeMatch === void 0 ? void 0 : codeMatch[1],
                },
            });
            auditLog.record({
                actor: inviter.username,
                action: "invite_guest",
                target: row.email,
                status: "failure",
                error: msg,
                details: {
                    tenantId: inviter.tenantId,
                    tenantDisplayName: inviter.tenantDisplayName,
                    classification: isVerifiedDomainError
                        ? "verified_domain_conflict"
                        : undefined,
                },
            });
        }
        // --- Owner-grant step ----------------------------------------------
        if (!opts.grantOwner)
            return;
        if (!inviteOk || !invitedUserId) {
            updateRow(row.rowId, {
                ownerGrant: {
                    state: "failure",
                    error: "skipped — invite failed",
                },
            });
            return;
        }
        if (cancelledRef.current) {
            updateRow(row.rowId, { ownerGrant: { state: "cancelled" } });
            return;
        }
        updateRow(row.rowId, { ownerGrant: { state: "running" } });
        try {
            // Tenant pinned to the inviter's destination tenant so the role
            // assignment lands in the same tenant that issued the invite.
            // forceRefresh prevents MSAL's silent cache from handing back
            // a home-tenant ARM token — that would grant the role in the
            // WRONG tenant (or 401 if the sub belongs to a different one).
            const armToken = yield getArmTokenForAccount(inviter.homeAccountId, inviter.tenantId, { forceRefresh: true });
            const r = yield assignSubscriptionRole(opts.subscriptionId, invitedUserId, AZURE_ROLE_OWNER, armToken, { principalType: "User" });
            updateRow(row.rowId, {
                ownerGrant: {
                    state: "success",
                    alreadyExisted: r.alreadyExisted,
                },
            });
            auditLog.record({
                actor: inviter.username,
                action: "assign_subscription_role",
                target: row.email,
                status: "success",
                details: {
                    subscriptionId: opts.subscriptionId,
                    principalId: invitedUserId,
                    roleDefinitionId: AZURE_ROLE_OWNER,
                    roleLabel: "Owner",
                    alreadyExisted: r.alreadyExisted,
                },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateRow(row.rowId, {
                ownerGrant: { state: "failure", error: msg },
            });
            auditLog.record({
                actor: inviter.username,
                action: "assign_subscription_role",
                target: row.email,
                status: "failure",
                error: msg,
                details: {
                    subscriptionId: opts.subscriptionId,
                    principalId: invitedUserId,
                    roleDefinitionId: AZURE_ROLE_OWNER,
                    roleLabel: "Owner",
                },
            });
        }
    }), [updateRow]);
    const submitInvites = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!selectedInviter || parsedEmails.activeValid.length === 0)
            return;
        cancelledRef.current = false;
        setSubmitting(true);
        setError(null);
        setCopiedKey(null);
        // Seed outcome rows with stable row ids. We freeze the recipient list
        // by reading from `parsedEmails.activeValid` once at submit time so
        // the form being edited mid-batch can't mutate the active queue.
        const rows = parsedEmails.activeValid.map((email, i) => ({
            rowId: i,
            email,
            invite: { state: "queued" },
            ownerGrant: grantOwner
                ? { state: "queued" }
                : { state: "skipped" },
        }));
        setOutcomes(rows);
        const subId = selectedSubscriptionId;
        const opts = {
            sendEmail,
            displayName,
            customMessage,
            redirectUrl,
            grantOwner,
            subscriptionId: subId,
        };
        // Risk classification snapshot (for the batch-started audit entry).
        // Counted at submit-time so the audit log reflects what the
        // operator actually approved — not what's on screen later.
        // Cites HIGH_RISK_DOMAINS docs (`_bypass_tenant_switch.md §2.1/§2.4`).
        const consumerEmails = [];
        const disposableEmails = [];
        const outsideAllowlistEmails = [];
        for (const r of rows) {
            const k = classifyInviteeDomain(r.email);
            if (k === "consumer")
                consumerEmails.push(r.email);
            else if (k === "disposable")
                disposableEmails.push(r.email);
            if (approvedDomainSet.size > 0) {
                const d = domainOf(r.email);
                if (!d || !approvedDomainSet.has(d)) {
                    outsideAllowlistEmails.push(r.email);
                }
            }
        }
        const highRiskOwnerGrantFlag = grantOwner && (consumerEmails.length > 0 || disposableEmails.length > 0);
        auditLog.record({
            actor: selectedInviter.username,
            action: "invite_guest_batch_started",
            // Use a synthetic "@batch" target so the audit-log page's filter-by-target
            // can group all rows of a batch by the actor + this marker without
            // overflowing the column with a comma-joined list of 50 emails.
            target: `@batch:${rows.length}`,
            status: "success",
            details: {
                tenantId: selectedInviter.tenantId,
                recipientCount: rows.length,
                recipients: rows.map((r) => r.email),
                grantOwner,
                subscriptionId: grantOwner ? subId : undefined,
                sendInvitationMessage: sendEmail,
                concurrency,
                // Risk-flag snapshot — see HIGH_RISK_DOMAINS / DISPOSABLE_DOMAINS
                // and approvedDomainSet. These appear in the audit log so a
                // defender reviewing later can see "this batch had N consumer
                // addresses AND opted to grant Owner" without needing to
                // re-classify after the fact.
                consumerDomainCount: consumerEmails.length,
                consumerDomainEmails: consumerEmails.length > 0 ? consumerEmails : undefined,
                disposableDomainCount: disposableEmails.length,
                disposableDomainEmails: disposableEmails.length > 0 ? disposableEmails : undefined,
                outsideAllowlistCount: outsideAllowlistEmails.length,
                outsideAllowlistEmails: outsideAllowlistEmails.length > 0 ? outsideAllowlistEmails : undefined,
                allowlistOverridden: approvedDomainSet.size > 0 && outsideAllowlistEmails.length > 0
                    ? true
                    : undefined,
                highRiskGuestPlusOwnerGrant: highRiskOwnerGrantFlag || undefined,
            },
        });
        yield runBoundedConcurrent(rows, concurrency, () => cancelledRef.current, (row) => __awaiter(void 0, void 0, void 0, function* () {
            // Look up per-recipient overrides from the CSV-paste panel, if any.
            // Lowercase keying matches `parseCsvInvites`'s storage convention.
            const override = csvOverrides[row.email.toLowerCase()];
            yield processOneRow(row, selectedInviter, Object.assign(Object.assign({}, opts), { rowOverrides: override }));
        }));
        // Final cancelled fan-out: any row still queued at this point was
        // never dispatched (operator hit Cancel mid-batch). Flip them so
        // the UI doesn't sit on "queued" forever.
        setOutcomes((prev) => prev.map((o) => o.invite.state === "queued"
            ? Object.assign(Object.assign({}, o), { invite: { state: "cancelled" }, ownerGrant: o.ownerGrant.state === "queued"
                    ? { state: "cancelled" }
                    : o.ownerGrant }) : o));
        setSubmitting(false);
        // Headline toast — keep it short; the per-row UI carries the detail.
        setOutcomes((prev) => {
            const succeeded = prev.filter((o) => o.invite.state === "success").length;
            const failed = prev.filter((o) => o.invite.state === "failure").length;
            const cancelled = prev.filter((o) => o.invite.state === "cancelled")
                .length;
            const ownerOk = prev.filter((o) => o.ownerGrant.state === "success")
                .length;
            const ownerFail = prev.filter((o) => o.ownerGrant.state === "failure")
                .length;
            const bits = [];
            bits.push(`Invited ${succeeded} of ${prev.length}`);
            if (failed > 0)
                bits.push(`${failed} invite failed`);
            if (cancelled > 0)
                bits.push(`${cancelled} cancelled`);
            if (grantOwner) {
                bits.push(`Owner granted ${ownerOk}`);
                if (ownerFail > 0)
                    bits.push(`${ownerFail} grant failed`);
            }
            store.addNotification({
                type: cancelledRef.current
                    ? "warning"
                    : failed > 0 || ownerFail > 0
                        ? "warning"
                        : "success",
                message: bits.join(" · "),
            });
            return prev;
        });
    }), [
        selectedInviter,
        parsedEmails.activeValid,
        displayName,
        customMessage,
        redirectUrl,
        sendEmail,
        grantOwner,
        selectedSubscriptionId,
        concurrency,
        csvOverrides,
        processOneRow,
        store,
        approvedDomainSet,
    ]);
    /**
     * Retry a single failed invite row (or its owner-grant if the invite
     * succeeded but the grant failed). We re-use `processOneRow` and reset
     * the relevant state to "queued" first so the spinners reappear.
     */
    const retryRow = React.useCallback((rowId) => __awaiter(void 0, void 0, void 0, function* () {
        if (!selectedInviter)
            return;
        const target = outcomes.find((o) => o.rowId === rowId);
        if (!target)
            return;
        setRetryRowId(rowId);
        const inviteFailed = target.invite.state === "failure";
        const ownerFailed = target.ownerGrant.state === "failure";
        const inviteSucceeded = target.invite.state === "success";
        try {
            if (inviteFailed) {
                // Full re-run: invite + (optionally) owner.
                updateRow(rowId, {
                    invite: { state: "queued" },
                    ownerGrant: grantOwner
                        ? { state: "queued" }
                        : { state: "skipped" },
                });
                cancelledRef.current = false;
                yield processOneRow(target, selectedInviter, {
                    sendEmail,
                    displayName,
                    customMessage,
                    redirectUrl,
                    grantOwner,
                    subscriptionId: selectedSubscriptionId,
                    rowOverrides: csvOverrides[target.email.toLowerCase()],
                });
            }
            else if (ownerFailed && inviteSucceeded) {
                // Owner-grant-only retry — re-grant against the already-invited
                // principal id, no second invite POST.
                const invitedUserId = target.invite.state === "success" ? target.invite.userId : null;
                if (!invitedUserId || !selectedSubscriptionId) {
                    updateRow(rowId, {
                        ownerGrant: {
                            state: "failure",
                            error: "no subscription / principal id for retry",
                        },
                    });
                    return;
                }
                updateRow(rowId, { ownerGrant: { state: "running" } });
                try {
                    // Tenant pinned to the inviter's destination tenant (same
                    // reason as the primary submit path — keep the assignment
                    // and the invite in the same tenant). forceRefresh skips
                    // MSAL's silent cache so we don't accidentally grant in
                    // the home tenant.
                    const armToken = yield getArmTokenForAccount(selectedInviter.homeAccountId, selectedInviter.tenantId, { forceRefresh: true });
                    const r = yield assignSubscriptionRole(selectedSubscriptionId, invitedUserId, AZURE_ROLE_OWNER, armToken, { principalType: "User" });
                    updateRow(rowId, {
                        ownerGrant: {
                            state: "success",
                            alreadyExisted: r.alreadyExisted,
                        },
                    });
                    auditLog.record({
                        actor: selectedInviter.username,
                        action: "assign_subscription_role",
                        target: target.email,
                        status: "success",
                        details: {
                            subscriptionId: selectedSubscriptionId,
                            principalId: invitedUserId,
                            roleDefinitionId: AZURE_ROLE_OWNER,
                            roleLabel: "Owner",
                            alreadyExisted: r.alreadyExisted,
                            retry: true,
                        },
                    });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    updateRow(rowId, {
                        ownerGrant: { state: "failure", error: msg },
                    });
                    auditLog.record({
                        actor: selectedInviter.username,
                        action: "assign_subscription_role",
                        target: target.email,
                        status: "failure",
                        error: msg,
                        details: {
                            subscriptionId: selectedSubscriptionId,
                            principalId: invitedUserId,
                            roleDefinitionId: AZURE_ROLE_OWNER,
                            roleLabel: "Owner",
                            retry: true,
                        },
                    });
                }
            }
        }
        finally {
            setRetryRowId(null);
        }
    }), [
        outcomes,
        selectedInviter,
        grantOwner,
        sendEmail,
        displayName,
        customMessage,
        redirectUrl,
        selectedSubscriptionId,
        csvOverrides,
        processOneRow,
        updateRow,
    ]);
    /**
     * Bulk Owner-grant against ALL successfully-invited principals that
     * don't yet have a successful grant. Useful when the operator forgot
     * to pre-tick "Grant Owner" or wants to retry every failed grant in
     * one go.
     *
     * Requires `selectedSubscriptionId` — if blank, the operator is
     * prompted to pick one before the action enables.
     */
    const bulkGrantOwner = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!selectedInviter || !selectedSubscriptionId)
            return;
        const candidates = outcomes.filter((o) => o.invite.state === "success" &&
            o.ownerGrant.state !== "success" &&
            o.ownerGrant.state !== "running");
        if (candidates.length === 0)
            return;
        setBulkGrantInFlight(true);
        try {
            // Tenant pinned to the inviter's destination tenant so bulk
            // grants land in the same tenant the invitations were issued in.
            // forceRefresh: bulk-grant operates on already-invited principals
            // in the inviter's destination tenant; MSAL silent cache could
            // hand back a home-tenant ARM token and cause every grant in the
            // bulk to fire against the wrong tenant.
            const armToken = yield getArmTokenForAccount(selectedInviter.homeAccountId, selectedInviter.tenantId, { forceRefresh: true });
            yield runBoundedConcurrent(candidates, concurrency, () => false, (o) => __awaiter(void 0, void 0, void 0, function* () {
                if (o.invite.state !== "success")
                    return;
                updateRow(o.rowId, { ownerGrant: { state: "running" } });
                try {
                    const r = yield assignSubscriptionRole(selectedSubscriptionId, o.invite.userId, AZURE_ROLE_OWNER, armToken, { principalType: "User" });
                    updateRow(o.rowId, {
                        ownerGrant: {
                            state: "success",
                            alreadyExisted: r.alreadyExisted,
                        },
                    });
                    auditLog.record({
                        actor: selectedInviter.username,
                        action: "assign_subscription_role",
                        target: o.email,
                        status: "success",
                        details: {
                            subscriptionId: selectedSubscriptionId,
                            principalId: o.invite.userId,
                            roleDefinitionId: AZURE_ROLE_OWNER,
                            roleLabel: "Owner",
                            alreadyExisted: r.alreadyExisted,
                            bulkGrant: true,
                        },
                    });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    updateRow(o.rowId, {
                        ownerGrant: { state: "failure", error: msg },
                    });
                    auditLog.record({
                        actor: selectedInviter.username,
                        action: "assign_subscription_role",
                        target: o.email,
                        status: "failure",
                        error: msg,
                        details: {
                            subscriptionId: selectedSubscriptionId,
                            principalId: o.invite.userId,
                            roleDefinitionId: AZURE_ROLE_OWNER,
                            roleLabel: "Owner",
                            bulkGrant: true,
                        },
                    });
                }
            }));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            store.addNotification({
                type: "error",
                message: `Bulk Owner grant failed: ${msg}`,
            });
        }
        finally {
            setBulkGrantInFlight(false);
        }
    }), [
        outcomes,
        selectedInviter,
        selectedSubscriptionId,
        concurrency,
        updateRow,
        store,
    ]);
    /**
     * Page-scoped hotkeys.
     *
     *   Ctrl/Cmd + Enter — submit (skipping the confirmation dialog for the
     *     common low-risk case; opens the dialog when send-email / Owner
     *     grant / >=5 recipients are in play, mirroring the button's logic).
     *   Esc            — cancel an in-flight batch.
     *
     * Bound at the document level (not the textarea) so the operator can
     * trigger them while focused anywhere on the page. Skips when the
     * active element is in another text input / textarea so it doesn't
     * fight with normal text editing in other fields.
     */
    const submitInvitesRef = React.useRef(submitInvites);
    React.useEffect(() => {
        submitInvitesRef.current = submitInvites;
    }, [submitInvites]);
    React.useEffect(() => {
        const onKey = (e) => {
            // Ctrl/Cmd+Enter — submit. Allowed from inside our textareas so
            // power users can type emails and hit it without re-focusing.
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                if (!canSubmit)
                    return;
                e.preventDefault();
                const needsConfirm = sendEmail ||
                    grantOwner ||
                    parsedEmails.activeValid.length >= 5;
                if (needsConfirm) {
                    setShowConfirm(true);
                }
                else {
                    void submitInvitesRef.current();
                }
            }
            // Esc — cancel a running batch. Ignored if the operator has a
            // dialog open (the dialog handles Esc itself).
            if (e.key === "Escape" && submitting) {
                cancelledRef.current = true;
                store.addNotification({
                    type: "warning",
                    message: "Cancellation requested (Esc) — in-flight invites will finish.",
                });
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [
        canSubmit,
        sendEmail,
        grantOwner,
        parsedEmails.activeValid.length,
        submitting,
        store,
    ]);
    /** Clipboard helper with toast-on-fallback. */
    const copyText = React.useCallback((text, key) => __awaiter(void 0, void 0, void 0, function* () {
        if (!text)
            return;
        let ok = false;
        try {
            yield navigator.clipboard.writeText(text);
            ok = true;
        }
        catch (_o) {
            // Fallback: dummy textarea (works in non-secure contexts too).
            try {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.setAttribute("readonly", "");
                ta.style.position = "absolute";
                ta.style.left = "-9999px";
                document.body.appendChild(ta);
                ta.select();
                ok = document.execCommand("copy");
                document.body.removeChild(ta);
            }
            catch (_p) {
                ok = false;
            }
        }
        if (ok) {
            setCopiedKey(key);
            setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1800);
        }
        else {
            store.addNotification({
                type: "error",
                message: "Could not write to clipboard.",
            });
        }
    }), [store]);
    /** Build the TSV header + rows for the "copy all redeem URLs" shortcut. */
    const buildRedeemUrlTsv = React.useCallback(() => {
        var _a;
        const lines = ["Email\tUPN\tEmailed\tRedeem URL"];
        for (const o of outcomes) {
            if (o.invite.state !== "success")
                continue;
            lines.push([
                o.email,
                (_a = o.invite.upn) !== null && _a !== void 0 ? _a : "",
                o.invite.emailed ? "yes" : "no",
                o.invite.redeemUrl,
            ].join("\t"));
        }
        return lines.join("\n");
    }, [outcomes]);
    const resetForm = React.useCallback(() => {
        setInviteeEmails("");
        setSuppressedEmails(new Set());
        setCsvOverrides({});
        setDisplayName("");
        setCustomMessage("");
        setError(null);
        setOutcomes([]);
        setCopiedKey(null);
        setOutcomeFilter("");
        setStatusFilter("all");
    }, []);
    // -------------------------------------------------------------------------
    // Render helpers
    // -------------------------------------------------------------------------
    const inviterModeBar = (React.createElement(Card, { className: "border-border/60 bg-surface-sunken/30" },
        React.createElement(CardContent, { className: "flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between" },
            React.createElement("div", { className: "flex flex-col gap-0.5" },
                React.createElement("span", { className: "flex items-center gap-1.5 text-xs font-medium" },
                    "Inviter discovery",
                    React.createElement(InfoTooltip, { size: 12, content: React.createElement("div", { className: "space-y-1.5" },
                            React.createElement("p", { className: "m-0 text-xs" },
                                React.createElement("strong", null, "Auto-detect"),
                                " probes each signed-in account's directory roles and keeps the ones holding Guest Inviter, User Administrator, or Global Administrator."),
                            React.createElement("p", { className: "m-0 text-xs" },
                                React.createElement("strong", null, "Manual pick"),
                                " skips the probe \u2014 useful when the tenant's authorizationPolicy lets every member invite, where the probe would otherwise return no candidates.")), ariaLabel: "About inviter discovery modes" })),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, inviterMode === "auto"
                    ? "Filtering to (account, tenant) pairs where the account holds Guest Inviter / User Admin / Global Admin."
                    : "Showing every (account, tenant) pair the operator can reach. Graph will accept or reject the invite based on the chosen account's actual rights in the chosen tenant.")),
            React.createElement("div", { role: "radiogroup", "aria-label": "Inviter discovery mode", className: "inline-flex rounded-md border border-border bg-background p-0.5" },
                React.createElement(Button, { type: "button", role: "radio", "aria-checked": inviterMode === "auto", size: "sm", variant: inviterMode === "auto" ? "default" : "ghost", className: "h-7 px-3 text-xs", onClick: () => handleSetInviterMode("auto") }, "Auto-detect"),
                React.createElement(Button, { type: "button", role: "radio", "aria-checked": inviterMode === "manual", size: "sm", variant: inviterMode === "manual" ? "default" : "ghost", className: "h-7 px-3 text-xs", onClick: () => handleSetInviterMode("manual") }, "Manual pick")))));
    // -------------------------------------------------------------------------
    // Loading / empty states
    // -------------------------------------------------------------------------
    if (discovering && azureAccounts.length > 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "Invite User", description: "Send a B2B invitation so an external user can join one of your tenants." }),
            inviterModeBar,
            React.createElement(Card, null,
                React.createElement(CardContent, { className: "flex items-center gap-2 py-8 text-sm text-muted-foreground" },
                    React.createElement(Loader2, { className: "h-4 w-4 animate-spin motion-reduce:animate-none" }),
                    "Enumerating accessible tenants and checking which (account, tenant) pairs can issue invitations\u2026"))));
    }
    if (inviters.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "Invite User", description: "Send a B2B invitation so an external user can join one of your tenants. Requires Guest Inviter, User Administrator, or Global Administrator on the inviting account \u2014 OR a tenant policy that lets all members invite (toggle Manual pick to bypass the role probe)." }),
            inviterModeBar,
            React.createElement(EmptyState, { icon: ShieldCheck, title: inviterMode === "auto"
                    ? "No (account, tenant) pair can invite users"
                    : "No signed-in accounts", description: inviterMode === "auto"
                    ? "None of the signed-in accounts hold a directory role with User.Invite.All in any tenant they can reach. If a target tenant's authorizationPolicy lets all members invite, switch to Manual pick above to surface every accessible (account, tenant) pair."
                    : "Sign in with at least one account, then come back here.", action: inviterMode === "auto"
                    ? {
                        label: "Switch to manual pick",
                        onClick: () => handleSetInviterMode("manual"),
                        icon: UserPlus,
                    }
                    : undefined })));
    }
    // -------------------------------------------------------------------------
    // Main render
    // -------------------------------------------------------------------------
    return (React.createElement("div", { className: "flex flex-col gap-4" },
        React.createElement(PageHeader, { title: "Invite User", description: "Email a B2B invitation, or copy the redemption URL and hand it over via your own channel. Supports bulk paste, concurrent dispatch, and a follow-up Owner role grant." },
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                    tenantId: selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.tenantId,
                    loginHint: selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username,
                }) })),
        inviterModeBar,
        React.createElement(Card, null,
            React.createElement(CardHeader, null,
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                    React.createElement(Mail, { className: "h-4 w-4 text-primary" }),
                    "New invitation"),
                React.createElement(CardDescription, null,
                    "The invitation is created in the inviter's tenant. The invitee opens the redemption URL, signs in (or signs up), and consents \u2014 they then appear as a guest under",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "#EXT#"),
                    " in that tenant.")),
            React.createElement(CardContent, { className: "flex flex-col gap-4" },
                React.createElement("div", { className: "flex flex-col gap-2" },
                    React.createElement("div", { className: "flex items-center justify-between gap-2" },
                        React.createElement(Label, { htmlFor: "invite-emails", className: "flex items-center gap-1.5" },
                            "Emails to invite",
                            " ",
                            React.createElement("span", { className: "text-destructive" }, "*"),
                            React.createElement(InfoTooltip, { size: 12, content: React.createElement("div", { className: "space-y-1.5" },
                                    React.createElement("p", { className: "m-0 text-xs" }, "Paste one address per line, or comma / semicolon separated. Duplicates are merged. Invalid tokens are surfaced below but never submitted."),
                                    React.createElement("p", { className: "m-0 text-xs" }, "Each valid address becomes a removable chip \u2014 strike out a chip to exclude that recipient without re-typing the whole textarea.")), ariaLabel: "About bulk email input" })),
                        React.createElement("div", { className: "flex items-center gap-1" },
                            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => setShowCsvPaste((v) => !v), disabled: submitting, className: "text-2xs", "aria-pressed": showCsvPaste, "aria-expanded": showCsvPaste, "aria-controls": "invite-csv-paste-panel", "aria-label": showCsvPaste
                                    ? "Hide CSV paste panel"
                                    : "Paste recipients from CSV (email, displayName, message)", title: "Paste a CSV with per-recipient display names and messages" },
                                React.createElement(Filter, null),
                                "CSV paste"),
                            (parsedEmails.valid.length > 0 || inviteeEmails.length > 0) && (React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => {
                                    setInviteeEmails("");
                                    setSuppressedEmails(new Set());
                                    setCsvOverrides({});
                                }, disabled: submitting, className: "text-2xs", "aria-label": "Clear all recipients" },
                                React.createElement(Trash2, null),
                                "Clear")))),
                    showCsvPaste && (React.createElement("div", { id: "invite-csv-paste-panel", className: "flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-3", role: "region", "aria-label": "CSV paste" },
                        React.createElement("div", { className: "flex items-center justify-between gap-2" },
                            React.createElement("span", { className: "flex items-center gap-1.5 text-xs font-medium" },
                                React.createElement(Filter, { className: "h-3.5 w-3.5 text-primary" }),
                                "Bulk CSV paste",
                                React.createElement(InfoTooltip, { size: 12, content: React.createElement("div", { className: "space-y-1.5" },
                                        React.createElement("p", { className: "m-0 text-xs" },
                                            "Paste rows of",
                                            " ",
                                            React.createElement("code", { className: "font-mono" }, "email[,displayName[,message]]"),
                                            ". First row is treated as a header if its first cell is ",
                                            React.createElement("code", { className: "font-mono" }, "email"),
                                            ". Separator auto-detects between ",
                                            React.createElement("code", null, ","),
                                            " and",
                                            " ",
                                            React.createElement("code", null, ";"),
                                            " (Excel locale-aware)."),
                                        React.createElement("p", { className: "m-0 text-xs" }, "Per-recipient values supersede the form-level defaults for THAT row. Recipients without overrides fall back to Display name + Custom message below.")), ariaLabel: "About CSV paste" })),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => setShowCsvPaste(false), className: "h-6 text-2xs", "aria-label": "Close CSV paste panel" },
                                React.createElement(X, null))),
                        React.createElement("textarea", { id: "invite-csv-paste", value: csvPasteText, onChange: (e) => setCsvPasteText(e.target.value), placeholder: "email,displayName,message\nalice@example.com,Alice Smith,Welcome to the team\nbob@example.com,Bob Jones,", rows: 5, spellCheck: false, className: "min-h-[110px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50", disabled: submitting, "aria-label": "CSV rows to import as recipients", "aria-describedby": "invite-csv-paste-help" }),
                        React.createElement("p", { id: "invite-csv-paste-help", className: "text-2xs text-muted-foreground" }, (() => {
                            if (csvPasteText.trim().length === 0) {
                                return "Empty.";
                            }
                            const bits = [];
                            bits.push(`${csvPreview.rows.length} valid row${csvPreview.rows.length === 1 ? "" : "s"}`);
                            if (csvPreview.invalid.length > 0) {
                                bits.push(`${csvPreview.invalid.length} invalid skipped`);
                            }
                            if (csvPreview.duplicates.length > 0) {
                                bits.push(`${csvPreview.duplicates.length} duplicate${csvPreview.duplicates.length === 1 ? "" : "s"} merged`);
                            }
                            const withDn = csvPreview.rows.filter((r) => r.displayName).length;
                            const withCm = csvPreview.rows.filter((r) => r.customMessage).length;
                            if (withDn > 0)
                                bits.push(`${withDn} display names`);
                            if (withCm > 0)
                                bits.push(`${withCm} custom messages`);
                            return bits.join(" · ");
                        })()),
                        React.createElement("div", { className: "flex flex-wrap gap-2" },
                            React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", disabled: submitting || csvPasteText.trim().length === 0, onClick: () => {
                                    if (csvPreview.rows.length === 0) {
                                        store.addNotification({
                                            type: "warning",
                                            message: "CSV paste: no valid rows. Check the header row and email column.",
                                        });
                                        return;
                                    }
                                    // Merge CSV rows INTO the existing textarea (additive).
                                    // Replace mode is opt-in via "Replace" button below.
                                    const existing = parseEmailList(inviteeEmails).valid;
                                    const merged = new Map();
                                    for (const e of existing) {
                                        merged.set(e.toLowerCase(), e);
                                    }
                                    for (const r of csvPreview.rows) {
                                        merged.set(r.email.toLowerCase(), r.email);
                                    }
                                    setInviteeEmails(Array.from(merged.values()).join("\n"));
                                    // Build the override map — only entries that actually
                                    // have a displayName or customMessage are stored.
                                    setCsvOverrides((prev) => {
                                        const next = Object.assign({}, prev);
                                        for (const r of csvPreview.rows) {
                                            if (r.displayName || r.customMessage) {
                                                next[r.email.toLowerCase()] = {
                                                    displayName: r.displayName,
                                                    customMessage: r.customMessage,
                                                };
                                            }
                                        }
                                        return next;
                                    });
                                    store.addNotification({
                                        type: "success",
                                        message: `CSV: imported ${csvPreview.rows.length} row${csvPreview.rows.length === 1 ? "" : "s"}${csvPreview.invalid.length > 0
                                            ? ` (${csvPreview.invalid.length} invalid skipped)`
                                            : ""}.`,
                                    });
                                } },
                                React.createElement(Plus, null),
                                "Append to recipients"),
                            React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", disabled: submitting || csvPasteText.trim().length === 0, onClick: () => {
                                    if (csvPreview.rows.length === 0) {
                                        store.addNotification({
                                            type: "warning",
                                            message: "CSV paste: no valid rows to replace with.",
                                        });
                                        return;
                                    }
                                    setInviteeEmails(csvPreview.rows.map((r) => r.email).join("\n"));
                                    setSuppressedEmails(new Set());
                                    const overrides = {};
                                    for (const r of csvPreview.rows) {
                                        if (r.displayName || r.customMessage) {
                                            overrides[r.email.toLowerCase()] = {
                                                displayName: r.displayName,
                                                customMessage: r.customMessage,
                                            };
                                        }
                                    }
                                    setCsvOverrides(overrides);
                                    store.addNotification({
                                        type: "success",
                                        message: `CSV: replaced recipients with ${csvPreview.rows.length} row${csvPreview.rows.length === 1 ? "" : "s"}.`,
                                    });
                                } }, "Replace recipients"),
                            React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-7 text-2xs", onClick: () => setCsvPasteText(""), disabled: submitting || csvPasteText.length === 0 }, "Clear paste box"),
                            Object.keys(csvOverrides).length > 0 && (React.createElement("span", { className: "ml-auto inline-flex items-center gap-1 text-2xs text-muted-foreground" },
                                React.createElement(Pencil, { className: "h-3 w-3", "aria-hidden": true }),
                                Object.keys(csvOverrides).length,
                                " per-recipient override",
                                Object.keys(csvOverrides).length === 1
                                    ? ""
                                    : "s",
                                " ",
                                "active",
                                React.createElement("button", { type: "button", onClick: () => setCsvOverrides({}), disabled: submitting, className: "rounded px-1 underline hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": "Clear all per-recipient CSV overrides" }, "clear")))))),
                    React.createElement("textarea", { id: "invite-emails", autoComplete: "off", spellCheck: false, placeholder: "alice@example.com\nbob@example.com, carol@example.com", value: inviteeEmails, onChange: (e) => setInviteeEmails(e.target.value), disabled: submitting, rows: 4, className: "flex min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50", "aria-describedby": "invite-emails-summary" }),
                    React.createElement("p", { id: "invite-emails-summary", className: "flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground" },
                        React.createElement(Users, { className: "h-3 w-3", "aria-hidden": true }),
                        React.createElement("span", null, "One per line \u2014 or comma / semicolon-separated. Case-insensitive deduplication."),
                        parsedEmails.activeValid.length > 0 && (React.createElement(Badge, { variant: "success", className: "text-2xs" },
                            parsedEmails.activeValid.length,
                            " to send")),
                        suppressedEmails.size > 0 && (React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                            suppressedEmails.size,
                            " excluded")),
                        parsedEmails.duplicates.length > 0 && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            parsedEmails.duplicates.length,
                            " duplicate",
                            parsedEmails.duplicates.length === 1 ? "" : "s",
                            " merged")),
                        parsedEmails.invalid.length > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                            parsedEmails.invalid.length,
                            " invalid: skipped"))),
                    parsedEmails.valid.length > 0 && (React.createElement("div", { role: "list", "aria-label": "Parsed recipients", className: "flex flex-wrap gap-1.5 rounded-md border border-dashed border-border bg-muted/20 p-2" }, parsedEmails.valid.map((email) => {
                        var _a;
                        const lower = email.toLowerCase();
                        const isSuppressed = suppressedEmails.has(lower);
                        const override = csvOverrides[lower];
                        const hasOverride = !!override &&
                            (!!override.displayName || !!override.customMessage);
                        // Risk class — colours the chip border so high-risk
                        // recipients are visible at a glance even when the
                        // banner above is collapsed/scrolled out of view.
                        const risk = (_a = recipientRiskByEmail[lower]) !== null && _a !== void 0 ? _a : "normal";
                        const domain = domainOf(email);
                        const outsideAllowlist = approvedDomainSet.size > 0 &&
                            (!domain || !approvedDomainSet.has(domain));
                        const chipClass = isSuppressed
                            ? "border-border bg-muted/50 text-muted-foreground line-through"
                            : risk === "disposable"
                                ? "border-destructive/50 bg-destructive/10 text-destructive"
                                : risk === "consumer"
                                    ? "border-warning/40 bg-warning/10 text-warning"
                                    : outsideAllowlist
                                        ? "border-warning/40 bg-warning/5 text-warning"
                                        : "border-success/30 bg-success/10 text-success";
                        const chipTitleBits = [];
                        if (hasOverride) {
                            chipTitleBits.push(`override${override.displayName ? ` · displayName="${override.displayName}"` : ""}${override.customMessage ? ` · customMessage set` : ""}`);
                        }
                        if (risk === "disposable") {
                            chipTitleBits.push("Disposable / throwaway email domain");
                        }
                        else if (risk === "consumer") {
                            chipTitleBits.push("Consumer / free-mail domain");
                        }
                        if (outsideAllowlist) {
                            chipTitleBits.push("Outside approved-domain allowlist");
                        }
                        return (React.createElement("span", { key: email, role: "listitem", className: `inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors ${chipClass}`, title: chipTitleBits.length > 0
                                ? chipTitleBits.join(" · ")
                                : undefined },
                            React.createElement(Mail, { className: "h-3 w-3 shrink-0", "aria-hidden": true }),
                            React.createElement("code", { className: "truncate font-mono text-2xs" }, email),
                            risk !== "normal" && !isSuppressed && (React.createElement(ShieldAlert, { className: "h-2.5 w-2.5 shrink-0", "aria-label": risk === "disposable"
                                    ? "Disposable email domain"
                                    : "Consumer mail domain" })),
                            hasOverride && !isSuppressed && (React.createElement(Pencil, { className: "h-2.5 w-2.5 shrink-0 text-primary", "aria-label": "Has per-recipient CSV override" })),
                            React.createElement("button", { type: "button", onClick: () => {
                                    setSuppressedEmails((prev) => {
                                        const next = new Set(prev);
                                        if (isSuppressed) {
                                            next.delete(email.toLowerCase());
                                        }
                                        else {
                                            next.add(email.toLowerCase());
                                        }
                                        return next;
                                    });
                                }, disabled: submitting, className: "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": isSuppressed
                                    ? `Re-include ${email}`
                                    : `Exclude ${email} from this batch`, title: isSuppressed
                                    ? `Re-include ${email}`
                                    : `Exclude ${email}` }, isSuppressed ? (React.createElement(Plus, { className: "h-2.5 w-2.5", "aria-hidden": true })) : (React.createElement(X, { className: "h-2.5 w-2.5", "aria-hidden": true })))));
                    }))),
                    parsedEmails.invalid.length > 0 && (React.createElement("p", { className: "break-words text-2xs text-destructive" },
                        "Not invited: ",
                        parsedEmails.invalid.join(", "))),
                    recipientWarnings.length > 0 && (React.createElement(Alert, { variant: "default", className: "border-warning/40 bg-warning/5" },
                        React.createElement(AlertTriangle, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                        React.createElement(AlertDescription, null,
                            React.createElement("span", { className: "font-medium text-warning" },
                                "Heads up \u2014 ",
                                recipientWarnings.length,
                                " address",
                                recipientWarnings.length === 1 ? "" : "es",
                                " may not be invitable:"),
                            React.createElement("ul", { className: "mt-1 space-y-0.5 text-2xs" }, recipientWarnings.map((w) => (React.createElement("li", { key: w.email },
                                React.createElement("code", { className: "font-mono" }, w.email),
                                " \u2014",
                                " ",
                                w.warning))))))),
                    (highRiskRecipients.consumer.length > 0 ||
                        highRiskRecipients.disposable.length > 0) && (React.createElement(Alert, { variant: "warning" },
                        React.createElement(ShieldAlert, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs font-medium" },
                                highRiskRecipients.total,
                                " consumer / personal-mail address",
                                highRiskRecipients.total === 1 ? "" : "es",
                                " in this batch"),
                            React.createElement("span", { className: "text-2xs" }, "Consumer-mail guests are tied to an external personal identity \u2014 if that account is later compromised, the guest principal in your tenant becomes a foothold (the canonical \u201Cstale guest\u201D finding). Consider inviting via the user's organisational address where possible."),
                            highRiskRecipients.consumer.length > 0 && (React.createElement("details", { className: "text-2xs" },
                                React.createElement("summary", { className: "cursor-pointer" },
                                    highRiskRecipients.consumer.length,
                                    " consumer-mail address",
                                    highRiskRecipients.consumer.length === 1 ? "" : "es"),
                                React.createElement("ul", { className: "mt-1 ml-4 list-disc space-y-0.5 font-mono" },
                                    highRiskRecipients.consumer.slice(0, 12).map((e) => (React.createElement("li", { key: e }, e))),
                                    highRiskRecipients.consumer.length > 12 && (React.createElement("li", { className: "italic" },
                                        "\u2026and ",
                                        highRiskRecipients.consumer.length - 12,
                                        " ",
                                        "more"))))),
                            highRiskRecipients.disposable.length > 0 && (React.createElement("div", { className: "rounded border border-destructive/40 bg-destructive/5 p-1.5" },
                                React.createElement("span", { className: "block text-2xs font-semibold text-destructive" },
                                    highRiskRecipients.disposable.length,
                                    " disposable / throwaway address",
                                    highRiskRecipients.disposable.length === 1
                                        ? ""
                                        : "es",
                                    ":"),
                                React.createElement("ul", { className: "ml-3 list-disc text-2xs" }, highRiskRecipients.disposable.slice(0, 6).map((e) => (React.createElement("li", { key: e, className: "font-mono" }, e)))),
                                React.createElement("span", { className: "block text-3xs text-destructive/80" }, "A guest principal anchored to a disposable inbox is a textbook \u201Cregister then walk away\u201D persistence primitive. The attacker doesn't even need to keep the inbox.")))))),
                    grantOwner &&
                        (highRiskRecipients.consumer.length > 0 ||
                            highRiskRecipients.disposable.length > 0) && (React.createElement(Alert, { variant: "destructive", "aria-live": "polite" },
                        React.createElement(ShieldAlert, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement(AlertDescription, { className: "text-2xs" },
                            React.createElement("strong", null,
                                "You are about to grant Owner on an Azure subscription to ",
                                highRiskRecipients.total,
                                " consumer / disposable mail address",
                                highRiskRecipients.total === 1 ? "" : "es",
                                "."),
                            " ",
                            "This is the \u201Cstale guest with role\u201D persistence pattern: the grant survives password rotation of the inviter, and the personal account behind the address is outside your security perimeter. Either un-check \u201CGrant Owner role\u201D above, invite an organisational address instead, or proceed knowing this assignment is now part of your blast radius until explicitly revoked."))),
                    approvedDomainSet.size > 0 &&
                        unapprovedDomainRecipients.length > 0 && (React.createElement(Alert, { variant: relaxAllowlist ? "default" : "destructive", className: relaxAllowlist
                            ? "border-warning/40 bg-warning/5"
                            : undefined },
                        React.createElement(Globe, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-1.5 text-2xs" },
                            React.createElement("span", { className: "font-medium" },
                                unapprovedDomainRecipients.length,
                                " recipient",
                                unapprovedDomainRecipients.length === 1
                                    ? ""
                                    : "s",
                                " ",
                                "outside the approved-domain allowlist"),
                            React.createElement("span", null,
                                "Unlisted domain",
                                unapprovedDomainSet.size === 1 ? "" : "s",
                                ":",
                                " ",
                                Array.from(unapprovedDomainSet)
                                    .slice(0, 8)
                                    .map((d) => (React.createElement("code", { key: d, className: "ml-0.5 rounded bg-muted px-1 font-mono" }, d))),
                                unapprovedDomainSet.size > 8 && (React.createElement("span", { className: "ml-1 italic" },
                                    "\u2026and ",
                                    unapprovedDomainSet.size - 8,
                                    " more"))),
                            React.createElement("label", { className: "flex cursor-pointer items-center gap-2" },
                                React.createElement(Checkbox, { id: "invite-relax-allowlist", checked: relaxAllowlist, onCheckedChange: (v) => setRelaxAllowlist(v === true), disabled: submitting }),
                                React.createElement("span", null, "Override allowlist for this session \u2014 I've reviewed the unlisted domains and accept the invite anyway. (Logged in the audit batch entry.)"))))),
                    React.createElement("div", { className: "flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/20 p-2" },
                        React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                            React.createElement("span", { className: "flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground" },
                                React.createElement(Globe, { className: "h-3 w-3", "aria-hidden": true }),
                                "Approved invitee domains",
                                React.createElement(InfoTooltip, { size: 12, content: "When this list is non-empty, recipients whose email domain is NOT listed will trigger an inline warning AND require an explicit override toggle before Submit enables. Stored in localStorage per-operator \u2014 applies across browser tabs. Empty list = no allowlist enforcement (default).", ariaLabel: "About approved-domain allowlist" }),
                                approvedDomainSet.size > 0 && (React.createElement(Badge, { variant: "outline", className: "text-3xs" },
                                    approvedDomainSet.size,
                                    " domain",
                                    approvedDomainSet.size === 1 ? "" : "s"))),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", className: "h-6 text-2xs", onClick: () => {
                                    setAllowlistDraft(approvedDomains.join("\n"));
                                    setShowAllowlistEditor((v) => !v);
                                }, "aria-expanded": showAllowlistEditor, "aria-controls": "invite-allowlist-editor", "aria-label": showAllowlistEditor
                                    ? "Hide allowlist editor"
                                    : "Edit approved invitee domains" },
                                React.createElement(Pencil, null),
                                showAllowlistEditor ? "Close" : "Edit")),
                        approvedDomainSet.size === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "No allowlist configured. Add domains below to require a per-batch override for unlisted recipients.")) : (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            Array.from(approvedDomainSet)
                                .slice(0, 6)
                                .map((d) => (React.createElement("code", { key: d, className: "mr-1 rounded bg-background px-1 font-mono" }, d))),
                            approvedDomainSet.size > 6 && (React.createElement("span", { className: "italic" },
                                "\u2026+",
                                approvedDomainSet.size - 6)))),
                        showAllowlistEditor && (React.createElement("div", { id: "invite-allowlist-editor", className: "flex flex-col gap-2 rounded-md border border-border bg-background p-2" },
                            React.createElement(Label, { htmlFor: "invite-allowlist-input", className: "text-2xs" },
                                "One domain per line \u2014 bare host only (e.g.",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "contoso.com"),
                                ", not",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "@contoso.com"),
                                " or",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "https://contoso.com"),
                                ")."),
                            React.createElement("textarea", { id: "invite-allowlist-input", value: allowlistDraft, onChange: (e) => setAllowlistDraft(e.target.value), rows: 4, spellCheck: false, placeholder: "contoso.com\nfabrikam.com\npartner.example.com", className: "min-h-[88px] w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-2xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", "aria-label": "Approved invitee domains" }),
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", onClick: () => {
                                        var _a;
                                        // Normalise: lowercase, strip leading `@` /
                                        // protocol, dedupe.
                                        const parsed = Array.from(new Set(allowlistDraft
                                            .split(/[\s,;]+/)
                                            .map((d) => d
                                            .trim()
                                            .toLowerCase()
                                            .replace(/^https?:\/\//, "")
                                            .replace(/^@/, "")
                                            .replace(/\/.*$/, ""))
                                            .filter((d) => d.length > 0 && d.includes("."))));
                                        setApprovedDomains(parsed);
                                        setShowAllowlistEditor(false);
                                        store.addNotification({
                                            type: "success",
                                            message: parsed.length === 0
                                                ? "Allowlist cleared — enforcement off."
                                                : `Allowlist saved (${parsed.length} domain${parsed.length === 1 ? "" : "s"}).`,
                                        });
                                        auditLog.record({
                                            actor: (_a = selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username) !== null && _a !== void 0 ? _a : "(unknown)",
                                            action: "invite_allowlist_updated",
                                            target: "@allowlist",
                                            status: "success",
                                            details: {
                                                domainCount: parsed.length,
                                                domains: parsed,
                                            },
                                        });
                                    } },
                                    React.createElement(Check, null),
                                    "Save allowlist"),
                                React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-7 text-2xs", onClick: () => setShowAllowlistEditor(false) }, "Cancel"),
                                approvedDomainSet.size > 0 && (React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "ml-auto h-7 text-2xs text-destructive", onClick: () => {
                                        setApprovedDomains([]);
                                        setAllowlistDraft("");
                                        setRelaxAllowlist(false);
                                        store.addNotification({
                                            type: "info",
                                            message: "Allowlist cleared — enforcement off.",
                                        });
                                    } },
                                    React.createElement(Trash2, null),
                                    "Clear allowlist"))))))),
                React.createElement("div", { className: "flex flex-col gap-2" },
                    React.createElement(Label, { htmlFor: "invite-inviter", className: "flex items-center gap-1.5" },
                        "Inviting account & destination tenant",
                        " ",
                        React.createElement("span", { className: "text-destructive" }, "*"),
                        React.createElement(InfoTooltip, { size: 12, content: "Each row pairs a signed-in account with one of the tenants it can reach. The invitation is created in the tenant you pick here \u2014 accounts that are guests in multiple tenants surface one row per tenant so you can target each directory directly.", ariaLabel: "About inviting account" })),
                    React.createElement(Select, { value: selectedInviterId, onValueChange: (v) => {
                            setSelectedInviterId(v);
                            if (inviterMode === "manual")
                                handleSetManualInviterId(v);
                        }, disabled: submitting },
                        React.createElement(SelectTrigger, { id: "invite-inviter" },
                            React.createElement(SelectValue, { placeholder: "Select an account + tenant" })),
                        React.createElement(SelectContent, null, inviters.map((i) => {
                            var _a, _b, _c;
                            const k = inviterKey(i);
                            const tenantLabel = i.tenantDisplayName
                                ? `${i.tenantDisplayName} (${((_a = i.tenantId) !== null && _a !== void 0 ? _a : "").slice(0, 8)}…)`
                                : ((_b = i.tenantId) !== null && _b !== void 0 ? _b : "").length > 8
                                    ? `${((_c = i.tenantId) !== null && _c !== void 0 ? _c : "").slice(0, 8)}…`
                                    : i.tenantId || "—";
                            return (React.createElement(SelectItem, { key: k, value: k },
                                React.createElement("div", { className: "flex flex-col" },
                                    React.createElement("span", { className: "font-medium" },
                                        i.name,
                                        React.createElement("span", { className: "ml-1 text-2xs font-normal text-muted-foreground" },
                                            "\u2192 ",
                                            tenantLabel),
                                        i.isHomeTenant ? (React.createElement(Badge, { variant: "outline", className: "ml-1.5 px-1 py-0 text-3xs" }, "home")) : (React.createElement(Badge, { variant: "outline", className: "ml-1.5 px-1 py-0 text-3xs" }, "guest"))),
                                    React.createElement("span", { className: "text-2xs text-muted-foreground" }, i.username))));
                        }))),
                    selectedInviter && (React.createElement("p", { className: "flex flex-wrap items-center gap-1 text-2xs text-muted-foreground" },
                        React.createElement(Info, { className: "h-3 w-3", "aria-hidden": true }),
                        React.createElement("span", null, "Guests will join tenant"),
                        selectedInviter.tenantDisplayName && (React.createElement("span", { className: "font-medium text-foreground" }, selectedInviter.tenantDisplayName)),
                        React.createElement(CopyableText, { value: selectedInviter.tenantId, mono: true, alwaysVisibleButton: true, ariaLabel: "Copy tenant id" }),
                        !selectedInviter.isHomeTenant && (React.createElement(Badge, { variant: "secondary", className: "text-3xs" }, "cross-tenant \u2014 inviter is a guest in this directory")))),
                    selectedInviter &&
                        verifiedDomainConflicts.length > 0 && (React.createElement(Alert, { variant: "warning" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-2 text-2xs" },
                            React.createElement("span", null,
                                React.createElement("strong", null,
                                    verifiedDomainConflicts.length,
                                    " recipient",
                                    verifiedDomainConflicts.length === 1 ? "" : "s",
                                    " ",
                                    "cannot be B2B-invited"),
                                " ",
                                "\u2014 their email domain is already a verified domain of",
                                " ",
                                React.createElement("strong", null, (_b = selectedInviter.tenantDisplayName) !== null && _b !== void 0 ? _b : selectedInviter.tenantId),
                                ", so Graph will reject the invite with",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "Request_BadRequest"),
                                ". These users already belong to the directory and should be added as ",
                                React.createElement("strong", null, "members"),
                                " ",
                                "directly (POST /users) rather than invited (POST /invitations)."),
                            React.createElement("ul", { className: "ml-4 list-disc text-2xs opacity-90" },
                                verifiedDomainConflicts.slice(0, 8).map((e) => (React.createElement("li", { key: e, className: "font-mono" }, e))),
                                verifiedDomainConflicts.length > 8 && (React.createElement("li", { className: "italic opacity-70" },
                                    "\u2026and ",
                                    verifiedDomainConflicts.length - 8,
                                    " more"))),
                            React.createElement("div", { className: "flex flex-wrap gap-2" },
                                React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", onClick: handleAddAsMembers, loading: addingAsMembers, disabled: addingAsMembers },
                                    React.createElement(UserPlus, { className: "h-3.5 w-3.5" }),
                                    "Add ",
                                    verifiedDomainConflicts.length,
                                    " as member",
                                    verifiedDomainConflicts.length === 1 ? "" : "s",
                                    " ",
                                    "instead"),
                                React.createElement("span", { className: "self-center text-3xs opacity-70" }, "Generates a strong password per user \u00B7 force change at next sign-in \u00B7 audited"))))),
                    addMemberResults.length > 0 && (React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-success/30 bg-success/5 p-3" },
                        React.createElement("div", { className: "flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-success" },
                            React.createElement(UserPlus, { className: "h-3.5 w-3.5" }),
                            "Add-as-member results (",
                            addMemberResults.filter((r) => r.ok).length,
                            "/",
                            addMemberResults.length,
                            ")"),
                        React.createElement("p", { className: "text-3xs text-muted-foreground" }, "Copy the passwords NOW \u2014 they are not persisted. The user must change them at next sign-in."),
                        React.createElement("table", { className: "w-full border-collapse text-2xs" },
                            React.createElement("thead", null,
                                React.createElement("tr", { className: "border-b border-border text-left text-3xs uppercase tracking-wider text-muted-foreground" },
                                    React.createElement("th", { className: "py-1.5 pr-2" }, "Email"),
                                    React.createElement("th", { className: "py-1.5 pr-2" }, "UPN"),
                                    React.createElement("th", { className: "py-1.5 pr-2" }, "Password"),
                                    React.createElement("th", { className: "py-1.5 pr-2" }, "Status"))),
                            React.createElement("tbody", null, addMemberResults.map((r) => (React.createElement("tr", { key: r.email, className: "border-b border-border/50" },
                                React.createElement("td", { className: "py-1.5 pr-2 font-mono" }, r.email),
                                React.createElement("td", { className: "py-1.5 pr-2 font-mono" }, r.ok && r.upn ? (React.createElement("span", { className: "inline-flex items-center gap-1" },
                                    r.upn,
                                    React.createElement(CopyableText, { value: r.upn, mono: false, alwaysVisibleButton: true, ariaLabel: `Copy UPN ${r.upn}` }))) : ("—")),
                                React.createElement("td", { className: "py-1.5 pr-2 font-mono" }, r.ok && r.password ? (React.createElement("span", { className: "inline-flex items-center gap-1" },
                                    React.createElement("code", null, r.password),
                                    React.createElement(CopyableText, { value: r.password, mono: false, alwaysVisibleButton: true, ariaLabel: "Copy password" }))) : ("—")),
                                React.createElement("td", { className: "py-1.5 pr-2" }, r.ok ? (React.createElement(Badge, { variant: "outline", className: "text-3xs" }, "created")) : (React.createElement("span", { className: "text-destructive", title: r.error }, "failed")))))))),
                        React.createElement("div", { className: "flex gap-2" },
                            React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: () => {
                                    var _a;
                                    const tsv = addMemberResults
                                        .filter((r) => r.ok)
                                        .map((r) => { var _a, _b; return `${r.email}\t${(_a = r.upn) !== null && _a !== void 0 ? _a : ""}\t${(_b = r.password) !== null && _b !== void 0 ? _b : ""}`; })
                                        .join("\n");
                                    const header = "Email\tUPN\tPassword\n";
                                    void ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText(header + tsv).then(() => store.addNotification({
                                        type: "success",
                                        message: `Copied ${addMemberResults.filter((r) => r.ok).length} UPN+password rows as TSV`,
                                    })).catch(() => store.addNotification({
                                        type: "error",
                                        message: "Clipboard write failed — copy manually",
                                    })));
                                } }, "Copy all as TSV"),
                            React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-7 text-2xs", onClick: () => setAddMemberResults([]) }, "Dismiss"))))),
                React.createElement("div", { className: "flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3" },
                    React.createElement("label", { htmlFor: "invite-grant-owner", className: "flex cursor-pointer items-start gap-2 text-sm" },
                        React.createElement(Checkbox, { id: "invite-grant-owner", checked: grantOwner, onCheckedChange: (v) => setGrantOwner(v === true), disabled: submitting, className: "mt-0.5" }),
                        React.createElement("span", { className: "flex flex-1 flex-col gap-0.5" },
                            React.createElement("span", { className: "flex items-center gap-1.5 font-medium" },
                                React.createElement(Key, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                                "Grant Owner role on an Azure subscription",
                                React.createElement(InfoTooltip, { size: 12, content: "When on, each successful invite is immediately followed by a Microsoft.Authorization/roleAssignments PUT granting Owner at /subscriptions/{id}. You can also leave this off and use the bulk-grant button on the Results card after the invites land.", ariaLabel: "About Owner grant" })),
                            React.createElement("span", { className: "text-2xs text-muted-foreground" }, "After each invite succeeds, assign the Owner role at the subscription scope so the guest can manage every resource inside. The grant is best-effort per recipient \u2014 failures are reported but do not undo the invite."))),
                    grantOwner && (React.createElement("div", { className: "flex flex-col gap-1.5 pl-6" },
                        React.createElement(Label, { htmlFor: "invite-subscription", className: "flex items-center gap-1.5 text-xs" },
                            "Subscription",
                            " ",
                            React.createElement("span", { className: "text-destructive" }, "*"),
                            React.createElement(InfoTooltip, { size: 12, content: "Owner is granted at /subscriptions/{id} scope. Your ARM token must hold Microsoft.Authorization/roleAssignments/write at that scope (Owner or User Access Administrator).", ariaLabel: "About subscription scope" })),
                        subsLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                            React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                            "Loading subscriptions for ", selectedInviter === null || selectedInviter === void 0 ? void 0 :
                            selectedInviter.username,
                            "\u2026")) : subsError ? (React.createElement(Alert, { variant: "destructive" },
                            React.createElement(AlertDescription, null,
                                "Failed to load subscriptions: ",
                                subsError))) : subscriptions.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" },
                            "No subscriptions visible to",
                            " ",
                            React.createElement("code", { className: "font-mono" }, selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username),
                            ". Sign in with an account that owns at least one subscription in this tenant.")) : (React.createElement(Select, { value: selectedSubscriptionId, onValueChange: setSelectedSubscriptionId, disabled: submitting },
                            React.createElement(SelectTrigger, { id: "invite-subscription" },
                                React.createElement(SelectValue, { placeholder: "Pick a subscription" })),
                            React.createElement(SelectContent, null, subscriptions.map((s) => (React.createElement(SelectItem, { key: s.subscriptionId, value: s.subscriptionId },
                                React.createElement("div", { className: "flex flex-col" },
                                    React.createElement("span", { className: "font-medium" }, s.displayName),
                                    React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                                        s.subscriptionId,
                                        " \u00B7 ",
                                        s.state)))))))),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" }, "You must hold Owner or User Access Administrator on this subscription for the grant to succeed.")))),
                React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-3", role: "region", "aria-label": "Saved invite templates" },
                    React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                        React.createElement("span", { className: "flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground" },
                            React.createElement(Sparkles, { className: "h-3 w-3", "aria-hidden": true }),
                            "Saved templates",
                            React.createElement(InfoTooltip, { size: 12, content: "Save the current Display name, redirect URL, custom message, Send-email, and Owner-grant settings as a named template. Apply any saved template in one click. Templates are operator-local (localStorage) \u2014 recipients are NOT captured.", ariaLabel: "About saved templates" })),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                            savedTemplates.length > 0 && (React.createElement(DropdownMenu, null,
                                React.createElement(DropdownMenuTrigger, { asChild: true },
                                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-7 text-2xs", disabled: submitting, "aria-label": "Apply a saved invite template" },
                                        "Apply\u2026",
                                        React.createElement(ChevronDown, { className: "ml-1 h-3 w-3" }))),
                                React.createElement(DropdownMenuContent, { align: "end", className: "max-w-[320px]" },
                                    React.createElement(DropdownMenuLabel, { className: "text-2xs" },
                                        savedTemplates.length,
                                        " saved"),
                                    React.createElement(DropdownMenuSeparator, null),
                                    savedTemplates.map((tpl) => (React.createElement(DropdownMenuItem, { key: tpl.id, onSelect: () => applyTemplate(tpl), className: "flex flex-col items-start gap-0.5", "aria-label": `Apply template ${tpl.name}` },
                                        React.createElement("span", { className: "flex w-full items-center justify-between gap-2 text-xs font-medium" },
                                            React.createElement("span", { className: "truncate" }, tpl.name),
                                            React.createElement("button", { type: "button", onClick: (e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    setTemplateToDelete(tpl.id);
                                                }, className: "ml-2 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": `Delete template ${tpl.name}`, title: "Delete template" },
                                                React.createElement(Trash2, { className: "h-3 w-3", "aria-hidden": true }))),
                                        React.createElement("span", { className: "flex flex-wrap gap-1 text-3xs text-muted-foreground" },
                                            tpl.sendEmail && (React.createElement(Badge, { variant: "outline", className: "text-3xs" }, "emails")),
                                            tpl.grantOwner && (React.createElement(Badge, { variant: "outline", className: "text-3xs" }, "+Owner")),
                                            React.createElement("span", { className: "truncate" },
                                                "\u2192 ",
                                                tpl.redirectUrl.replace(/^https?:\/\//, ""))))))))),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-2xs", disabled: submitting, onClick: () => {
                                    setTemplateNameDraft("");
                                    setShowTemplateSaver(true);
                                }, "aria-label": "Save current form values as a template" },
                                React.createElement(Plus, null),
                                "Save current"))),
                    savedTemplates.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                        "No templates yet. Configure redirect URL, custom message, send-email and Owner-grant, then click ",
                        React.createElement("em", null, "Save current"),
                        " ",
                        "to capture the combination.")) : (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                        savedTemplates.length,
                        " template",
                        savedTemplates.length === 1 ? "" : "s",
                        " saved. Apply one to fill the form below.")),
                    showTemplateSaver && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2" },
                        React.createElement(Label, { htmlFor: "invite-template-name", className: "text-2xs font-medium" }, "Template name"),
                        React.createElement(Input, { id: "invite-template-name", value: templateNameDraft, onChange: (e) => setTemplateNameDraft(e.target.value), onKeyDown: (e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    saveCurrentAsTemplate();
                                }
                                else if (e.key === "Escape") {
                                    setShowTemplateSaver(false);
                                    setTemplateNameDraft("");
                                }
                            }, placeholder: 'e.g. "Q3 vendor onboarding"', autoFocus: true, className: "h-7 max-w-[260px] flex-1 text-xs", "aria-label": "Template name" }),
                        React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", onClick: saveCurrentAsTemplate, disabled: templateNameDraft.trim().length === 0 },
                            React.createElement(Check, null),
                            "Save"),
                        React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-7 text-2xs", onClick: () => {
                                setShowTemplateSaver(false);
                                setTemplateNameDraft("");
                            } }, "Cancel")))),
                React.createElement("details", { className: "rounded-md border border-border/60 bg-muted/30 p-3" },
                    React.createElement("summary", { className: "cursor-pointer text-2xs font-medium uppercase tracking-wide text-muted-foreground" }, "Optional settings"),
                    React.createElement("div", { className: "mt-3 flex flex-col gap-3" },
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { htmlFor: "invite-display-name", className: "text-xs" }, "Display name"),
                            React.createElement(Input, { id: "invite-display-name", placeholder: "Defaults to the email address", value: displayName, onChange: (e) => setDisplayName(e.target.value), disabled: submitting })),
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { htmlFor: "invite-redirect", className: "flex items-center gap-1.5 text-xs" },
                                "Redirect URL after redemption",
                                React.createElement(InfoTooltip, { size: 12, content: "Lands the invitee here after consent. Must be HTTPS and a URL Microsoft allows (any https:// origin you own, or a Microsoft surface like myapplications.microsoft.com).", ariaLabel: "About redirect URL" })),
                            React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                                React.createElement(Input, { id: "invite-redirect", type: "url", placeholder: DEFAULT_REDIRECT_URL, value: redirectUrl, onChange: (e) => setRedirectUrl(e.target.value), disabled: submitting, "aria-invalid": !redirectIsHttps }),
                                React.createElement(DropdownMenu, null,
                                    React.createElement(DropdownMenuTrigger, { asChild: true },
                                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-9 px-2 text-2xs", disabled: submitting },
                                            "Presets ",
                                            React.createElement(ChevronDown, { className: "ml-1 h-3 w-3" }))),
                                    React.createElement(DropdownMenuContent, { align: "end" },
                                        React.createElement(DropdownMenuLabel, { className: "text-2xs" }, "Common landing surfaces"),
                                        React.createElement(DropdownMenuSeparator, null),
                                        REDIRECT_PRESETS.map((p) => (React.createElement(DropdownMenuItem, { key: p.url, onSelect: () => setRedirectUrl(p.url), className: "text-xs" },
                                            p.label,
                                            React.createElement("span", { className: "ml-2 truncate font-mono text-3xs text-muted-foreground" }, p.url.replace(/^https?:\/\//, "")))))))),
                            !redirectIsHttps && (React.createElement("p", { className: "text-2xs text-destructive" }, "Redirect URL must be a valid HTTPS URL.")),
                            React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Where the invitee lands after consenting. Defaults to My Apps.")),
                        React.createElement("label", { htmlFor: "invite-send-email", className: "flex cursor-pointer items-start gap-2 text-xs" },
                            React.createElement(Checkbox, { id: "invite-send-email", checked: sendEmail, onCheckedChange: (v) => setSendEmail(v === true), disabled: submitting, className: "mt-0.5" }),
                            React.createElement("span", { className: "flex flex-1 flex-col gap-0.5" },
                                React.createElement("span", { className: "font-medium" }, "Send invitation email from Microsoft"),
                                React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Off by default \u2014 copy the redemption URL below and hand it over via your own channel (Teams DM, ticket, etc.). With this on Graph sends a templated email to every recipient."))),
                        sendEmail && (React.createElement("div", { className: "flex flex-col gap-1.5 pl-6" },
                            React.createElement(Label, { htmlFor: "invite-custom-message", className: "flex items-center gap-1.5 text-xs" },
                                "Custom message (optional)",
                                React.createElement(InfoTooltip, { size: 12, content: "Appended to the templated Microsoft invitation email. Plain text; URLs auto-linkify. Same body is used for every recipient in the batch.", ariaLabel: "About custom message" })),
                            React.createElement("textarea", { id: "invite-custom-message", placeholder: "Hi \u2014 joining you to our shared Azure resources. Click the link to accept.", value: customMessage, onChange: (e) => setCustomMessage(e.target.value), disabled: submitting, rows: 3, className: "flex min-h-[64px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" }))),
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { htmlFor: "invite-concurrency", className: "flex items-center gap-1.5 text-xs" },
                                "Concurrency",
                                React.createElement(InfoTooltip, { size: 12, content: "Maximum number of invite + Owner-grant operations in flight at once. Lower is gentler on Graph/ARM throttling; higher is faster for large batches. Default 4 is a sweet spot for ~50 recipients.", ariaLabel: "About concurrency" })),
                            React.createElement("div", { className: "flex items-center gap-3" },
                                React.createElement("input", { id: "invite-concurrency", type: "range", min: MIN_CONCURRENCY, max: MAX_CONCURRENCY, step: 1, value: concurrency, onChange: (e) => setConcurrency(parseInt(e.target.value, 10)), disabled: submitting, className: "flex-1 accent-primary" }),
                                React.createElement("span", { className: "inline-flex h-7 min-w-[2.5rem] items-center justify-center rounded-md border border-border bg-background px-2 font-mono text-xs tabular-nums" }, concurrency)),
                            React.createElement("p", { className: "text-2xs text-muted-foreground" },
                                "Up to ",
                                concurrency,
                                " invites + grants run in parallel.")))),
                error && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertDescription, null, error))),
                totalInvitesLast14 > 0 && (() => {
                    var _a;
                    const W = 140;
                    const H = 28;
                    const N = invitesPerDay.length;
                    const max = Math.max(1, ...invitesPerDay);
                    const step = W / Math.max(1, N - 1);
                    const pts = invitesPerDay
                        .map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`)
                        .join(" ");
                    const todayBin = (_a = invitesPerDay[N - 1]) !== null && _a !== void 0 ? _a : 0;
                    return (React.createElement("div", { className: "flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-2xs text-muted-foreground", role: "group", "aria-label": "Invite-guest audit-log activity (last 14 days)" },
                        React.createElement("span", { className: "font-medium" }, "Recent invites:"),
                        React.createElement("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Successful invite-guest audit entries per day for the last ${N} days, total ${totalInvitesLast14}`, className: "text-primary" },
                            React.createElement("polyline", { fill: "none", stroke: "currentColor", strokeWidth: "1.25", points: pts }),
                            React.createElement("circle", { cx: (N - 1) * step, cy: H - (todayBin / max) * (H - 2) - 1, r: "2", fill: "currentColor" })),
                        React.createElement("span", null,
                            totalInvitesLast14,
                            " invite",
                            totalInvitesLast14 === 1 ? "" : "s",
                            " in 14d \u00B7 today:",
                            " ",
                            React.createElement("span", { className: "font-semibold text-foreground" }, todayBin))));
                })(),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement("span", { className: "sr-only", "aria-live": "polite", "aria-atomic": "true" }, submitting
                        ? `Sending invites — ${progressCounts.succeeded} of ${progressCounts.total} succeeded, ${progressCounts.failed} failed, ${progressCounts.pending} pending.`
                        : ""),
                    React.createElement(Button, { type: "button", onClick: () => {
                            const needsConfirm = sendEmail ||
                                grantOwner ||
                                parsedEmails.activeValid.length >= 5;
                            if (needsConfirm) {
                                setShowConfirm(true);
                            }
                            else {
                                void submitInvites();
                            }
                        }, disabled: !canSubmit, loading: submitting, "aria-label": `Invite ${parsedEmails.activeValid.length || "users"}`, title: "Submit (Ctrl/Cmd+Enter)" },
                        !submitting && React.createElement(UserPlus, null),
                        submitting
                            ? "Inviting…"
                            : parsedEmails.activeValid.length > 1
                                ? `Invite ${parsedEmails.activeValid.length} users${grantOwner ? " + grant Owner" : ""}`
                                : `Send invitation${grantOwner ? " + grant Owner" : ""}`),
                    submitting && (React.createElement(Button, { type: "button", variant: "warning", size: "sm", onClick: () => {
                            cancelledRef.current = true;
                            store.addNotification({
                                type: "warning",
                                message: "Cancellation requested — in-flight invites will finish.",
                            });
                        }, "aria-label": "Cancel running batch", title: "Cancel (Esc)" },
                        React.createElement(X, null),
                        "Cancel batch")),
                    (outcomes.length > 0 || error) && !submitting && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: resetForm, "aria-label": "Start a new invitation batch" },
                        React.createElement(Sparkles, null),
                        "New batch")),
                    !canSubmit && !submitting && parsedEmails.activeValid.length > 0 && (React.createElement("span", { className: "text-2xs text-muted-foreground", role: "status" }, !selectedInviter
                        ? "Pick an inviting account."
                        : !redirectIsHttps
                            ? "Redirect URL must be HTTPS."
                            : grantOwner && !selectedSubscriptionId
                                ? "Pick a subscription for the Owner grant."
                                : allowlistBlocks
                                    ? `${unapprovedDomainRecipients.length} recipient${unapprovedDomainRecipients.length === 1 ? "" : "s"} outside the approved-domain allowlist — toggle "Override allowlist" to proceed.`
                                    : ""))))),
        outcomes.length > 0 && (React.createElement(Card, null,
            React.createElement(CardHeader, null,
                React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
                    React.createElement("div", null,
                        React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                            React.createElement(Check, { className: "h-4 w-4 text-primary" }),
                            "Results"),
                        React.createElement(CardDescription, null, "Per-recipient invite + Owner-grant status. Copy any redemption URL, retry a failure inline, or export the full batch as CSV / JSON.")))),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "sr-only", "aria-live": "polite", "aria-atomic": "true" }, submitting
                    ? `Invitation batch in progress — ${outcomes.filter((o) => o.invite.state === "success").length} of ${outcomes.length} succeeded so far.`
                    : `Invitation batch complete — ${outcomes.filter((o) => o.invite.state === "success").length} of ${outcomes.length} succeeded.`),
                React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Batch summary" },
                    React.createElement(SummaryStatItem, { label: "Total", value: outcomes.length, tone: "info", compact: true }),
                    React.createElement(SummaryStatItem, { label: "Sent", value: outcomes.filter((o) => o.invite.state === "success").length, tone: "success", compact: true }),
                    React.createElement(SummaryStatItem, { label: "Failed", value: outcomes.filter((o) => o.invite.state === "failure").length, tone: "destructive", compact: true }),
                    React.createElement(SummaryStatItem, { label: "Pending", value: outcomes.filter((o) => o.invite.state === "running" ||
                            o.invite.state === "queued").length, tone: "warning", compact: true }),
                    React.createElement(SummaryStatItem, { label: "Cancelled", value: outcomes.filter((o) => o.invite.state === "cancelled").length, tone: "muted", compact: true }),
                    grantOwner && (React.createElement(React.Fragment, null,
                        React.createElement(SummaryStatItem, { label: "Owner ok", value: outcomes.filter((o) => o.ownerGrant.state === "success").length, tone: "success", compact: true }),
                        React.createElement(SummaryStatItem, { label: "Owner failed", value: outcomes.filter((o) => o.ownerGrant.state === "failure").length, tone: "destructive", compact: true })))),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement("div", { className: "relative min-w-[200px] flex-1" },
                        React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                        React.createElement(Input, { type: "search", placeholder: "Filter by email, UPN, or error\u2026", value: outcomeFilter, onChange: (e) => setOutcomeFilter(e.target.value), className: "h-8 pl-7 text-xs", "aria-label": "Filter results" })),
                    React.createElement("div", { role: "radiogroup", "aria-label": "Filter by status", className: "inline-flex rounded-md border border-border bg-background p-0.5" }, [
                        { v: "all", label: "All", icon: Filter },
                        { v: "success", label: "Success", icon: Check },
                        { v: "failure", label: "Failed", icon: X },
                        { v: "pending", label: "Pending", icon: Loader2 },
                    ].map(({ v, label, icon: Icon }) => (React.createElement(Button, { key: v, type: "button", role: "radio", "aria-checked": statusFilter === v, size: "sm", variant: statusFilter === v ? "default" : "ghost", className: "h-7 gap-1 px-2 text-2xs", onClick: () => setStatusFilter(v) },
                        React.createElement(Icon, { className: "h-3 w-3", "aria-hidden": true }),
                        label)))),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => void copyText(buildRedeemUrlTsv(), "tsv-all"), disabled: outcomes.filter((o) => o.invite.state === "success")
                            .length === 0, className: "text-xs", "aria-label": "Copy all redemption URLs as TSV" },
                        copiedKey === "tsv-all" ? React.createElement(Check, null) : React.createElement(Copy, null),
                        copiedKey === "tsv-all" ? "Copied" : "Copy URLs (TSV)"),
                    React.createElement(ExportMenu, { rows: outcomes, columns: OUTCOME_EXPORT_COLUMNS, filename: "invite-user-results", jsonMetadata: {
                            inviter: selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username,
                            tenantId: selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.tenantId,
                            grantOwner,
                            subscriptionId: grantOwner
                                ? selectedSubscriptionId
                                : undefined,
                            concurrency,
                            sentEmailFromMicrosoft: sendEmail,
                        } })),
                (() => {
                    const grantCandidates = outcomes.filter((o) => o.invite.state === "success" &&
                        o.ownerGrant.state !== "success" &&
                        o.ownerGrant.state !== "running").length;
                    if (grantCandidates === 0)
                        return null;
                    return (React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 p-2" },
                        React.createElement("span", { className: "flex items-center gap-1.5 text-xs" },
                            React.createElement(Key, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                            React.createElement("span", null,
                                React.createElement("strong", null, grantCandidates),
                                " invited user",
                                grantCandidates === 1 ? "" : "s",
                                " without a successful Owner grant",
                                selectedSubscriptionId
                                    ? ` on ${selectedSubscriptionId.slice(0, 8)}…`
                                    : "",
                                ".")),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                            !selectedSubscriptionId && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Pick a subscription above to enable.")),
                            React.createElement(Button, { type: "button", variant: "default", size: "sm", loading: bulkGrantInFlight, disabled: bulkGrantInFlight ||
                                    submitting ||
                                    !selectedSubscriptionId, onClick: () => setShowBulkGrantConfirm(true), className: "text-xs", "aria-label": `Grant Owner to all ${grantCandidates} invited users` },
                                !bulkGrantInFlight && React.createElement(ShieldCheck, null),
                                "Grant Owner to ",
                                grantCandidates))));
                })(),
                (() => {
                    const filterText = outcomeFilter.trim().toLowerCase();
                    const visible = outcomes.filter((o) => {
                        var _a, _b, _c, _d, _e;
                        // Status filter first — cheaper short-circuit.
                        if (statusFilter === "success" && o.invite.state !== "success")
                            return false;
                        if (statusFilter === "failure" && o.invite.state !== "failure")
                            return false;
                        if (statusFilter === "pending" &&
                            o.invite.state !== "running" &&
                            o.invite.state !== "queued")
                            return false;
                        // Free-text filter against email / UPN / error texts.
                        if (filterText.length === 0)
                            return true;
                        if (((_a = o.email) !== null && _a !== void 0 ? _a : "").toLowerCase().includes(filterText))
                            return true;
                        if (o.invite.state === "success" &&
                            (((_b = o.invite.upn) !== null && _b !== void 0 ? _b : "").toLowerCase().includes(filterText) ||
                                ((_c = o.invite.displayName) !== null && _c !== void 0 ? _c : "")
                                    .toLowerCase()
                                    .includes(filterText)))
                            return true;
                        if (o.invite.state === "failure" &&
                            ((_d = o.invite.error) !== null && _d !== void 0 ? _d : "").toLowerCase().includes(filterText))
                            return true;
                        if (o.ownerGrant.state === "failure" &&
                            ((_e = o.ownerGrant.error) !== null && _e !== void 0 ? _e : "")
                                .toLowerCase()
                                .includes(filterText))
                            return true;
                        return false;
                    });
                    if (visible.length === 0) {
                        return (React.createElement(EmptyState, { icon: Search, title: "No matches", description: outcomeFilter.length > 0
                                ? `Nothing matches "${outcomeFilter}". Clear the filter to see every result.`
                                : `No results in the "${statusFilter}" filter — switch to All to see every result.`, size: "compact", action: {
                                label: outcomeFilter.length > 0
                                    ? "Clear filter"
                                    : "Show all",
                                onClick: () => {
                                    setOutcomeFilter("");
                                    setStatusFilter("all");
                                },
                            } }));
                    }
                    return (React.createElement("div", { className: "flex flex-col gap-2" }, visible.map((o) => (React.createElement(ResultRow, { key: o.rowId, outcome: o, copiedKey: copiedKey, retryInFlight: retryRowId === o.rowId, grantOwnerEnabled: grantOwner, hasSubscription: !!selectedSubscriptionId, onCopyUrl: (url) => void copyText(url, `url-${o.rowId}`), onRetry: () => void retryRow(o.rowId) })))));
                })()))),
        React.createElement(ConfirmationDialog, { hidden: !showConfirm, title: parsedEmails.activeValid.length > 1
                ? `Send ${parsedEmails.activeValid.length} invitations?`
                : "Send invitation?", message: React.createElement("div", { className: "flex flex-col gap-2 text-sm" },
                React.createElement("p", null,
                    parsedEmails.activeValid.length > 1
                        ? `Microsoft will create ${parsedEmails.activeValid.length} guest users in tenant `
                        : `Microsoft will create a guest user in tenant `,
                    React.createElement("code", { className: "font-mono text-xs" }, (_c = selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.tenantId) !== null && _c !== void 0 ? _c : ""),
                    "."),
                sendEmail && (React.createElement("p", null,
                    React.createElement("strong", null, "Mail will be sent"),
                    " from Microsoft to each recipient at the addresses you entered.")),
                grantOwner && (React.createElement("p", null,
                    "Each newly-invited user will receive the",
                    " ",
                    React.createElement("strong", null, "Owner"),
                    " role on subscription",
                    " ",
                    React.createElement("code", { className: "font-mono text-xs" }, selectedSubscriptionId),
                    ". They will gain full control of every resource in that subscription.")),
                (() => {
                    var _a, _b;
                    const N = parsedEmails.activeValid.length;
                    const events = [];
                    events.push({
                        name: "invite_guest_batch_started",
                        count: 1,
                    });
                    events.push({ name: "invite_guest", count: N });
                    if (grantOwner) {
                        events.push({
                            name: "assign_subscription_role",
                            count: N,
                        });
                    }
                    const total = events.reduce((s, e) => s + e.count, 0);
                    return (React.createElement("div", { className: "rounded border border-border/60 bg-muted/30 p-2" },
                        React.createElement("p", { className: "m-0 mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground" },
                            "Audit trail preview (",
                            total,
                            " event",
                            total === 1 ? "" : "s",
                            ")"),
                        React.createElement("ul", { className: "m-0 ml-3 list-disc text-2xs" }, events.map((e) => (React.createElement("li", { key: e.name },
                            React.createElement("code", { className: "font-mono" }, e.name),
                            " × ",
                            e.count)))),
                        React.createElement("p", { className: "m-0 mt-1 text-3xs text-muted-foreground" },
                            "All entries are recorded under",
                            " ",
                            React.createElement("code", { className: "font-mono" }, (_a = selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.username) !== null && _a !== void 0 ? _a : "(unknown)"),
                            " ",
                            "in tenant",
                            " ",
                            React.createElement("code", { className: "font-mono" }, (_b = selectedInviter === null || selectedInviter === void 0 ? void 0 : selectedInviter.tenantId) !== null && _b !== void 0 ? _b : ""),
                            ".")));
                })(),
                (highRiskRecipients.consumer.length > 0 ||
                    highRiskRecipients.disposable.length > 0) && (React.createElement("p", { className: "rounded border border-warning/40 bg-warning/5 p-2 text-xs" },
                    React.createElement(ShieldAlert, { className: "mr-1 inline h-3 w-3 -translate-y-px text-warning", "aria-hidden": true }),
                    React.createElement("strong", { className: "text-warning" },
                        highRiskRecipients.total,
                        " consumer / disposable address",
                        highRiskRecipients.total === 1 ? "" : "es"),
                    " ",
                    "in this batch.",
                    " ",
                    grantOwner &&
                        "Combined with the Owner grant, this is the canonical ‘stale guest with role’ persistence primitive — the assignment outlives password/MFA rotation of the inviter. ",
                    "Flagged in the audit log entry.")),
                approvedDomainSet.size > 0 &&
                    unapprovedDomainRecipients.length > 0 &&
                    relaxAllowlist && (React.createElement("p", { className: "rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning" },
                    React.createElement(Globe, { className: "mr-1 inline h-3 w-3 -translate-y-px", "aria-hidden": true }),
                    "Allowlist override active \u2014",
                    " ",
                    unapprovedDomainRecipients.length,
                    " recipient",
                    unapprovedDomainRecipients.length === 1 ? "" : "s",
                    " on unlisted domains. Logged on the batch audit entry.")),
                recipientWarnings.length > 0 && (React.createElement("p", { className: "rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning" },
                    React.createElement(AlertCircle, { className: "mr-1 inline h-3 w-3 -translate-y-px", "aria-hidden": true }),
                    recipientWarnings.length,
                    " address",
                    recipientWarnings.length === 1 ? "" : "es",
                    " may not be invitable (.onmicrosoft.com etc.). They'll surface as per-row failures."))), confirmText: parsedEmails.activeValid.length > 1
                ? `Send ${parsedEmails.activeValid.length} invitations`
                : "Send invitation", danger: grantOwner || sendEmail, onConfirm: () => {
                setShowConfirm(false);
                void submitInvites();
            }, onCancel: () => setShowConfirm(false) }),
        React.createElement(ConfirmationDialog, { hidden: !showBulkGrantConfirm, title: "Grant Owner to invited users?", message: React.createElement("div", { className: "flex flex-col gap-2 text-sm" },
                React.createElement("p", null,
                    "Every successfully-invited user without a current Owner role on",
                    " ",
                    React.createElement("code", { className: "font-mono text-xs" }, selectedSubscriptionId),
                    " ",
                    "will receive the ",
                    React.createElement("strong", null, "Owner"),
                    " role."),
                React.createElement("p", { className: "text-xs text-muted-foreground" }, "This grants full control over every resource in the subscription. The operation is idempotent \u2014 already-granted principals are surfaced as \"already had it\".")), confirmText: "Grant Owner", danger: true, onConfirm: () => {
                setShowBulkGrantConfirm(false);
                void bulkGrantOwner();
            }, onCancel: () => setShowBulkGrantConfirm(false) }),
        React.createElement(ConfirmationDialog, { hidden: templateToDelete === null, title: "Delete saved template?", message: React.createElement("p", { className: "text-sm" },
                "Removing",
                " ",
                React.createElement("strong", null, (_e = (_d = savedTemplates.find((t) => t.id === templateToDelete)) === null || _d === void 0 ? void 0 : _d.name) !== null && _e !== void 0 ? _e : ""),
                ". Other tabs viewing this page will update automatically. Form values currently on screen are not affected."), confirmText: "Delete template", danger: true, onConfirm: () => {
                if (templateToDelete)
                    deleteTemplate(templateToDelete);
            }, onCancel: () => setTemplateToDelete(null) })));
};
const ResultRow = ({ outcome: o, copiedKey, retryInFlight, grantOwnerEnabled, hasSubscription, onCopyUrl, onRetry, }) => {
    const inviteOk = o.invite.state === "success";
    const redeemUrl = o.invite.state === "success" ? o.invite.redeemUrl : "";
    const urlKey = `url-${o.rowId}`;
    const canRetry = !retryInFlight &&
        (o.invite.state === "failure" ||
            (o.ownerGrant.state === "failure" && inviteOk));
    const ownerRetryNeedsSub = o.invite.state === "success" &&
        o.ownerGrant.state === "failure" &&
        !hasSubscription;
    return (React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-background p-3" },
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement(Mail, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
            React.createElement("code", { className: "truncate font-mono text-xs" }, o.email),
            o.invite.state === "queued" && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Queued")),
            o.invite.state === "running" && (React.createElement(Badge, { variant: "secondary", className: "gap-1 text-2xs" },
                React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                " ",
                "Inviting\u2026")),
            o.invite.state === "success" && (React.createElement(Badge, { variant: "success", className: "gap-1 text-2xs" },
                o.invite.emailed ? (React.createElement(MailCheck, { className: "h-3 w-3" })) : (React.createElement(Check, { className: "h-3 w-3" })),
                o.invite.emailed ? "Invited + emailed" : "Invited")),
            o.invite.state === "failure" && (React.createElement(Badge, { variant: "destructive", className: "gap-1 text-2xs" },
                React.createElement(X, { className: "h-3 w-3" }),
                " Invite failed")),
            o.invite.state === "cancelled" && (React.createElement(Badge, { variant: "outline", className: "gap-1 text-2xs" }, "Cancelled")),
            o.ownerGrant.state === "skipped" && grantOwnerEnabled && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Owner: skipped")),
            o.ownerGrant.state === "queued" && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Owner: queued")),
            o.ownerGrant.state === "running" && (React.createElement(Badge, { variant: "secondary", className: "gap-1 text-2xs" },
                React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                " ",
                "Granting Owner\u2026")),
            o.ownerGrant.state === "success" && (React.createElement(Badge, { variant: "success", className: "gap-1 text-2xs" },
                React.createElement(Key, { className: "h-3 w-3" }),
                o.ownerGrant.alreadyExisted
                    ? "Owner: already had it"
                    : "Owner: granted")),
            o.ownerGrant.state === "failure" && (React.createElement(Badge, { variant: "destructive", className: "gap-1 text-2xs" },
                React.createElement(X, { className: "h-3 w-3" }),
                " Owner grant failed")),
            o.ownerGrant.state === "cancelled" && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Owner: cancelled")),
            canRetry && (React.createElement(Button, { type: "button", variant: "ghost", size: "xs", className: "ml-auto h-6 gap-1 text-2xs", onClick: onRetry, disabled: retryInFlight || ownerRetryNeedsSub, loading: retryInFlight, title: ownerRetryNeedsSub
                    ? "Pick a subscription above to retry the grant."
                    : "Retry this row", "aria-label": `Retry ${o.email}` },
                !retryInFlight && React.createElement(RefreshCw, null),
                "Retry"))),
        o.invite.state === "success" && o.invite.upn && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
            "Provisioned as",
            " ",
            React.createElement("code", { className: "font-mono" }, o.invite.upn),
            o.invite.displayName ? ` (${o.invite.displayName})` : "",
            o.invite.emailed
                ? " · Microsoft emailed the invitee."
                : " · email not sent — share the URL below.",
            o.invite.graphStatus
                ? ` · status: ${o.invite.graphStatus}`
                : "")),
        o.invite.state === "failure" && (React.createElement("div", { className: "break-words text-2xs text-destructive" },
            React.createElement("p", { className: "m-0 flex items-start gap-1" },
                React.createElement(AlertCircle, { className: "mt-0.5 h-3 w-3 shrink-0", "aria-hidden": true }),
                React.createElement("span", { className: "flex-1" }, o.invite.error)),
            o.invite.errorCode && (React.createElement("p", { className: "m-0 mt-0.5 pl-4 text-3xs text-muted-foreground" },
                "Code: ",
                React.createElement("code", { className: "font-mono" }, o.invite.errorCode))))),
        o.ownerGrant.state === "failure" && (React.createElement("p", { className: "break-words text-2xs text-destructive" },
            React.createElement(Key, { className: "mr-1 inline h-3 w-3 -translate-y-px", "aria-hidden": true }),
            "Owner grant: ",
            o.ownerGrant.error)),
        inviteOk && redeemUrl && (React.createElement("div", { className: "flex items-stretch gap-2" },
            React.createElement("div", { className: "group/copy relative flex flex-1 items-center" },
                React.createElement(Input, { readOnly: true, value: redeemUrl, className: "pr-8 font-mono text-2xs", onFocus: (e) => e.currentTarget.select(), "aria-label": `Redemption URL for ${o.email}` }),
                React.createElement("span", { className: "absolute right-1.5 top-1/2 -translate-y-1/2" },
                    React.createElement(CopyButton, { value: redeemUrl, iconSize: 12, ariaLabel: `Copy redemption URL for ${o.email} (hover)` }))),
            React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: () => onCopyUrl(redeemUrl), "aria-label": copiedKey === urlKey
                    ? `Copied redemption URL for ${o.email}`
                    : `Copy redemption URL for ${o.email}` },
                copiedKey === urlKey ? React.createElement(Check, null) : React.createElement(Copy, null),
                copiedKey === urlKey ? "Copied" : "Copy"),
            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", asChild: true },
                React.createElement("a", { href: redeemUrl, target: "_blank", rel: "noopener noreferrer", "aria-label": `Open redemption URL for ${o.email}` },
                    React.createElement(ExternalLink, null),
                    "Open")))),
        o.invite.state === "success" && (React.createElement("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground" },
            React.createElement("span", { className: "inline-flex items-center gap-1" },
                React.createElement(Pencil, { className: "h-3 w-3", "aria-hidden": true }),
                React.createElement("span", null, "User id:"),
                React.createElement(CopyableText, { value: o.invite.userId, mono: true, alwaysVisibleButton: true, ariaLabel: `Copy invited user id for ${o.email}` }))))));
};
//# sourceMappingURL=invite-user-page.js.map