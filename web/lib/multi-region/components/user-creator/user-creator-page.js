import { __awaiter } from "tslib";
/**
 * User Creator page — provisions Microsoft Entra ID (Azure AD) users in a
 * tenant where the signed-in account holds a User Administrator role.
 * Includes real-time UPN availability probing, AD attribute presets, and
 * zod-backed inline validation. Does NOT manage subscription role
 * assignments — that lives in the Account Provisioning page.
 */
import * as React from "react";
import { AlertCircle, ArrowLeftRight, AtSign, BadgeCheck, Building2, Check, Clock, Copy, Download, ExternalLink, Eye, EyeOff, Filter, FileJson, HardDrive, IdCard, KeyRound, LogIn, Loader2, PartyPopper, RefreshCw, Search, ShieldAlert, ShieldCheck, Sparkles, Trash2, UserPlus, Users, Wand2, X, Zap, } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn, sleep } from "@/lib/utils";
import { getActiveTenant, getGraphTokenForAccount } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { credentialVault, } from "../../auth/credential-vault";
import { attemptInteractiveLogin, launchPortalAutoLogin, } from "../../auth/portal-auto-login";
import { auditLog } from "../../services/audit-log";
import { canCreateUsers, createUser, getMyDirectoryRoles, listVerifiedDomains, } from "../../services/graph-service";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { EmptyState } from "../shared/empty-state";
import { SignInRequired } from "../shared/sign-in-required";
import { EnhancedTable } from "../shared/enhanced-table";
import { ErrorBoundary } from "../shared/error-boundary";
import { PageHeader } from "../shared/page-header";
import { PortalLoginButton } from "../shared/portal-login-button";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
const ACTIVE_ACCOUNT_KEY = "user-creator:active-account";
const TAB_KEY = "user-creator:tab";
const ACCOUNT_MODE_KEY = "user-creator:account-mode";
const AUTO_LOGIN_PREF_KEY = "user-creator:auto-launch-portal";
const SHOW_ALL_PW_KEY = "user-creator:show-all-pw";
const SAVED_TEMPLATES_KEY = "user-creator:saved-templates";
/**
 * Operator-defined regex that every UPN prefix must match before the
 * create call is allowed. Persisted per-browser; empty string disables
 * the gate (default). Useful when an org standardizes on a UPN shape
 * like `^[a-z]+\.[a-z]+\.[a-z0-9]{4}$` and wants accidental free-typed
 * prefixes blocked at the form layer (the server still enforces its
 * own rules; this is a soft pre-flight gate).
 */
const NAMING_CONVENTION_KEY = "user-creator:naming-convention";
/**
 * Persisted toggle for the debug JSON-preview panel. Operator hits `d`
 * (or clicks the chip) to flip this; survives reloads so a power user
 * who lives in the preview doesn't have to re-enable it each session.
 */
const DEBUG_PREVIEW_KEY = "user-creator:debug-preview";
/**
 * Persisted column-visibility map for the Created-by-me list. Each key
 * is a column id, value is `true` for visible. Defaults are inlined at
 * the read site to keep the storage payload small.
 */
const CREATED_COLUMNS_KEY = "user-creator:created-columns";
const CREATED_COLUMN_KEYS = [
    "tenant",
    "displayName",
    "lastUsed",
    "sourceBadge",
    "password",
    "createdAt",
];
const DEFAULT_CREATED_COLUMNS = {
    tenant: true,
    displayName: true,
    lastUsed: true,
    sourceBadge: true,
    password: true,
    createdAt: true,
};
/**
 * Count threshold above which a bulk quick-mode create requires an explicit
 * confirmation step. Single-user creates skip the dialog (low-risk happy
 * path). Anything bigger triggers a "you are about to provision N users in
 * tenant X" confirmation so an accidental finger-slip on the up-arrow can't
 * spawn 50 Entra accounts.
 */
const BULK_CONFIRM_THRESHOLD = 1;
const VALID_TABS = ["create", "browse", "created"];
const isValidTab = (v) => !!v && VALID_TABS.includes(v);
const MIN_PASSWORD_LENGTH = 12;
const GENERATED_PASSWORD_LENGTH = 16;
const USER_PREFIX_RE = /^[a-zA-Z0-9._-]{1,40}$/;
// 300ms hits the sweet spot — long enough to ignore mid-typing strokes
// (typical inter-keystroke gap is ~120-180ms for sustained typing), short
// enough that the spinner appears almost instantly when the user pauses.
// Previously 400ms which felt unresponsive on the success-card flow.
const AVAILABILITY_DEBOUNCE_MS = 300;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// Sign-in helpers (Playwright auto-login, MSAL interactive popup) live in
// ../../auth/portal-auto-login so the password-reset flow on the Tenant Users
// page can share the exact same chain.
const USAGE_LOCATIONS = [
    { code: "US", label: "United States (US)" },
    { code: "GB", label: "United Kingdom (GB)" },
    { code: "DE", label: "Germany (DE)" },
    { code: "FR", label: "France (FR)" },
    { code: "IN", label: "India (IN)" },
    { code: "JP", label: "Japan (JP)" },
    { code: "AU", label: "Australia (AU)" },
    { code: "CA", label: "Canada (CA)" },
    { code: "BR", label: "Brazil (BR)" },
    { code: "NL", label: "Netherlands (NL)" },
    { code: "SG", label: "Singapore (SG)" },
];
const PRESETS = [
    {
        key: "standard",
        label: "Standard User",
        description: "Default tenant member with no elevated attributes.",
        jobTitle: "Member",
        department: "General",
        usageLocation: "US",
        forceChangePassword: true,
        accountEnabled: true,
    },
    {
        key: "admin",
        label: "Admin",
        description: "Engineering admin with elevated metadata.",
        jobTitle: "Administrator",
        department: "IT",
        usageLocation: "US",
        forceChangePassword: true,
        accountEnabled: true,
    },
    {
        key: "readonly",
        label: "Read-only",
        description: "Read-only auditor with restricted profile.",
        jobTitle: "Auditor",
        department: "Compliance",
        usageLocation: "US",
        forceChangePassword: true,
        accountEnabled: true,
    },
    {
        key: "service",
        label: "Service Account",
        description: "Long-lived non-interactive account; no forced reset.",
        jobTitle: "Service Account",
        department: "Platform",
        usageLocation: "US",
        forceChangePassword: false,
        accountEnabled: true,
    },
    {
        key: "contractor",
        label: "Contractor",
        description: "External contributor; account starts disabled until vetted.",
        jobTitle: "Contractor",
        department: "External",
        usageLocation: "US",
        forceChangePassword: true,
        accountEnabled: false,
    },
];
const userFormSchema = z.object({
    prefix: z
        .string()
        .min(1, "User ID is required.")
        .regex(USER_PREFIX_RE, "Letters, numbers, dot, dash, or underscore. Max 40 characters."),
    domain: z.string().min(1, "Select a domain."),
    displayName: z.string().trim().min(1, "Display name is required."),
    givenName: z.string(),
    surname: z.string(),
    jobTitle: z.string(),
    department: z.string(),
    usageLocation: z.string().min(1, "Select a usage location."),
    password: z
        .string()
        .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`),
    forceChange: z.boolean(),
    accountEnabled: z.boolean(),
});
function pickRandom(arr, count, rng) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const idx = Math.floor(rng() * arr.length);
        out.push(arr[idx]);
    }
    return out;
}
function shuffle(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function generateRandomPassword() {
    const lower = "abcdefghijklmnopqrstuvwxyz".split("");
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const digits = "0123456789".split("");
    const symbols = "!@#$%^&*()-_=+[]{}".split("");
    const buf = new Uint32Array(GENERATED_PASSWORD_LENGTH * 4);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(buf);
    }
    else {
        for (let i = 0; i < buf.length; i++) {
            buf[i] = Math.floor(Math.random() * 0xffffffff);
        }
    }
    let cursor = 0;
    const rng = () => {
        const v = buf[cursor++ % buf.length];
        return v / 0xffffffff;
    };
    const chunkSize = GENERATED_PASSWORD_LENGTH / 4;
    const chars = [
        ...pickRandom(lower, chunkSize, rng),
        ...pickRandom(upper, chunkSize, rng),
        ...pickRandom(digits, chunkSize, rng),
        ...pickRandom(symbols, chunkSize, rng),
    ];
    return shuffle(chars, rng).join("");
}
function titleCase(value) {
    if (!value)
        return "";
    return value
        .replace(/[._-]+/g, " ")
        .split(" ")
        .filter(Boolean)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
        .join(" ");
}
function deriveGivenName(prefix) {
    const cased = titleCase(prefix);
    const space = cased.indexOf(" ");
    return space >= 0 ? cased.slice(0, space) : cased;
}
function deriveSurname(prefix) {
    const cased = titleCase(prefix);
    const space = cased.indexOf(" ");
    return space >= 0 ? cased.slice(space + 1) : "";
}
function truncateMiddle(value, head = 8, tail = 4) {
    if (!value || value.length <= head + tail + 1)
        return value;
    return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
// ---------------------------------------------------------------------------
// Quick-mode batch generator — when the operator picks "Role + Count" and
// nothing else, we synthesize plausible name + UPN + password tuples here.
// ---------------------------------------------------------------------------
const QUICK_MODE_KEY = "user-creator:quick-mode";
const QUICK_COUNT_MIN = 1;
const QUICK_COUNT_MAX = 50;
const FIRST_NAMES = [
    "alex", "jamie", "taylor", "jordan", "morgan", "casey", "riley",
    "drew", "quinn", "avery", "cameron", "blake", "skyler", "reese",
    "finley", "hayden", "kai", "rowan", "sage", "emerson", "harper",
    "logan", "parker", "phoenix", "remy", "shawn", "sloan",
];
const LAST_NAMES = [
    "smith", "johnson", "lee", "brown", "davis", "miller", "wilson",
    "garcia", "martinez", "anderson", "thomas", "moore", "white",
    "harris", "clark", "lewis", "young", "walker", "hall", "allen",
    "kim", "patel", "nguyen", "rivera", "torres", "ng", "okafor",
];
function randHex(n) {
    const buf = new Uint8Array(Math.ceil(n / 2));
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(buf);
    }
    else {
        for (let i = 0; i < buf.length; i++)
            buf[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, n);
}
function pickOne(arr) {
    if (arr.length === 0)
        throw new Error("pickOne: empty array");
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return arr[buf[0] % arr.length];
    }
    return arr[Math.floor(Math.random() * arr.length)];
}
function generateBatchPayload(count, preset, domain) {
    const used = new Set();
    const out = [];
    for (let i = 0; i < count; i++) {
        let prefix;
        let attempts = 0;
        do {
            const fn = pickOne(FIRST_NAMES);
            const ln = pickOne(LAST_NAMES);
            prefix = `${fn}.${ln}.${randHex(4)}`;
            attempts++;
        } while (used.has(prefix) && attempts < 10);
        used.add(prefix);
        const [first, last] = prefix.split(".");
        out.push({
            prefix,
            upn: `${prefix}@${domain}`,
            displayName: `${titleCase(first)} ${titleCase(last)}`,
            givenName: titleCase(first),
            surname: titleCase(last),
            password: generateRandomPassword(),
            jobTitle: preset.jobTitle,
            department: preset.department,
            usageLocation: preset.usageLocation,
            forceChange: preset.forceChangePassword,
            accountEnabled: preset.accountEnabled,
        });
    }
    return out;
}
function parseCsvPayload(text, preset, domain) {
    var _a, _b;
    const rows = [];
    const errors = [];
    const seen = new Set();
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const raw = (_a = lines[i]) !== null && _a !== void 0 ? _a : "";
        const trimmed = raw.trim();
        if (!trimmed)
            continue;
        if (trimmed.startsWith("#"))
            continue;
        // Header sniff — first non-blank line, contains "prefix" and a comma.
        if (rows.length === 0 &&
            errors.length === 0 &&
            /^prefix\b/i.test(trimmed) &&
            trimmed.includes(",")) {
            continue;
        }
        // Simple CSV split — we don't expect quoted fields in this minimal
        // contract; if someone needs commas in display names they can edit
        // post-create. Keeps the parser predictable.
        const parts = trimmed.split(",").map((p) => p.trim());
        const prefix = (_b = parts[0]) !== null && _b !== void 0 ? _b : "";
        if (!prefix) {
            errors.push({ line: i + 1, text: raw, reason: "empty prefix" });
            continue;
        }
        if (!USER_PREFIX_RE.test(prefix)) {
            errors.push({
                line: i + 1,
                text: raw,
                reason: "invalid prefix (use letters/numbers/._- max 40)",
            });
            continue;
        }
        if (seen.has(prefix.toLowerCase())) {
            errors.push({
                line: i + 1,
                text: raw,
                reason: "duplicate prefix in CSV",
            });
            continue;
        }
        seen.add(prefix.toLowerCase());
        const givenName = parts[1] ? deriveGivenName(parts[1]) : deriveGivenName(prefix);
        const surname = parts[1] ? deriveSurname(parts[1]) : deriveSurname(prefix);
        const displayName = parts[1] || titleCase(prefix);
        const jobTitle = parts[2] || preset.jobTitle;
        const department = parts[3] || preset.department;
        rows.push({
            prefix,
            upn: `${prefix}@${domain}`,
            displayName,
            givenName,
            surname,
            password: generateRandomPassword(),
            jobTitle,
            department,
            usageLocation: preset.usageLocation,
            forceChange: preset.forceChangePassword,
            accountEnabled: preset.accountEnabled,
        });
    }
    return { rows, errors };
}
/**
 * Suspicious-name detection — flags UPN prefixes that match common
 * "blends-into-normal-admin-activity" naming patterns used to hide
 * privileged or automation persistence cells.
 *
 * Corpus refs:
 *   - `_bypass_modify_delete.md` §6 (line 623): "Create user" is rated
 *     ★★★★★ stealth — the audit event itself blends into normal admin
 *     activity, so the only natural signal the SOC has is the *shape*
 *     of the name. Service-account / sync-service / helpdesk patterns
 *     are the canonical "I'm here to stay" persistence-cell signature.
 *   - `_bypass_role_grant.md` §10 (line 360): `User Admin (limited) →
 *     create user → backdoor user` is an explicit escalation chain;
 *     surfacing the deceptive-name shape at create-time is the best
 *     defender-side counter to that chain.
 *
 * Returns the matched category string when the prefix looks like an
 * automation/service/admin/sync/helpdesk persistence cell, `null`
 * otherwise. The list is operator-readable so the warning can name
 * the specific pattern that triggered.
 */
const SUSPICIOUS_NAME_PATTERNS = [
    {
        category: "service-account",
        re: /^(svc|service|sa)[._-]/i,
        hint: "svc_*/service_*/sa_* — classic long-lived non-interactive credential shape.",
    },
    {
        category: "admin-deception",
        re: /^(admin|root|sysadmin|superadmin)[._-]/i,
        hint: "admin_*/root_* — looks like a legitimate admin to a casual SOC review.",
    },
    {
        category: "sync-deception",
        re: /(^|[._-])(sync|connect|adsync|aadc|aadconnect)([._-]|$)/i,
        hint: "sync_*/aadsync_* — mimics AAD Connect sync accounts (Gerenios/AADInternals abuse vector).",
    },
    {
        category: "helpdesk-deception",
        re: /^(helpdesk|help_desk|support|it[._-]?support)[._-]/i,
        hint: "helpdesk_*/support_* — leverages operator trust in IT-support inboxes.",
    },
    {
        category: "automation",
        re: /^(bot|automation|robot|noreply|donotreply|do[._-]?not[._-]?reply)[._-]/i,
        hint: "bot_*/automation_* — automation-creep / persistence-cell shape.",
    },
    {
        category: "hidden-prefix",
        re: /^_/,
        hint: "_leading-underscore — common ploy to sort to the top/bottom of a sorted user list.",
    },
    {
        category: "test-deception",
        re: /^(test|temp|tmp|demo)[._-]/i,
        hint: "test_*/temp_* — easy to leave behind after a 'temporary' provision and forgotten.",
    },
];
function detectSuspiciousName(prefix) {
    if (!prefix)
        return null;
    for (const p of SUSPICIOUS_NAME_PATTERNS) {
        if (p.re.test(prefix)) {
            return { category: p.category, hint: p.hint };
        }
    }
    return null;
}
function summarizeAuditPreview(rows, autoLoginAfter) {
    let force = 0;
    let suspicious = 0;
    for (const r of rows) {
        if (r.forceChange)
            force += 1;
        if (detectSuspiciousName(r.prefix))
            suspicious += 1;
    }
    return {
        createUser: rows.length,
        vaultPut: rows.length,
        // Auto-login only fires for the single-create happy path right now.
        autoLogin: autoLoginAfter && rows.length === 1 ? 1 : 0,
        forceChangePassword: force,
        suspiciousNames: suspicious,
    };
}
function formatRelative(iso) {
    if (!iso)
        return "-";
    const ms = Date.parse(iso);
    if (Number.isNaN(ms))
        return "-";
    let diff = Date.now() - ms;
    // Negative diff = clock skew or future date. Show as "in Xs" rather than
    // "-5s ago" which is meaningless. The previous Math.round path turned
    // 59.6s into "60s ago" — switching to Math.floor avoids that edge.
    const future = diff < 0;
    if (future)
        diff = -diff;
    const sec = Math.floor(diff / 1000);
    if (sec < 1)
        return "just now";
    const fmt = (n, unit) => future ? `in ${n}${unit}` : `${n}${unit} ago`;
    if (sec < 60)
        return fmt(sec, "s");
    const min = Math.floor(sec / 60);
    if (min < 60)
        return fmt(min, "m");
    const hr = Math.floor(min / 60);
    if (hr < 48)
        return fmt(hr, "h");
    const day = Math.floor(hr / 24);
    if (day < 60)
        return fmt(day, "d");
    const mo = Math.floor(day / 30);
    if (mo < 24)
        return fmt(mo, "mo");
    const yr = Math.floor(mo / 12);
    return fmt(yr, "y");
}
// CSV-cell escape: wrap in quotes if it contains comma/quote/newline, and
// double up internal quotes. Used by the vault bulk-export flow.
function csvCell(value) {
    if (value === null || value === undefined)
        return "";
    const s = String(value);
    if (/[",\n\r]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}
// Trigger a browser download for the given text content. Uses
// URL.createObjectURL + <a download> + revokeObjectURL to avoid leaking
// memory. SSR-safe (returns silently if window is undefined).
function downloadTextFile(filename, content, mime) {
    if (typeof window === "undefined" || typeof document === "undefined")
        return;
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
// Safe clipboard write with a single notification helper. Returns true on
// success so callers can avoid showing a "copied" toast when the platform
// silently denies clipboard access.
function tryWriteClipboard(text) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield navigator.clipboard.writeText(text);
            return true;
        }
        catch (_a) {
            return false;
        }
    });
}
/**
 * Segmented toggle that lets the operator opt out of the role-discovery
 * filter. `auto` (default) only surfaces accounts where Graph reported a
 * user-creation role; `manual` exposes every signed-in account so the
 * operator can attempt the create call against any of them — useful
 * when role discovery misfires due to a cross-tenant Graph permission
 * quirk. The badge counts give the operator a quick read on what each
 * mode would unlock before they switch.
 */
const AccountModeToggle = ({ mode, onChange, autoCount, manualCount, discovering, onRefresh }) => {
    return (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs" },
        React.createElement("span", { className: "font-semibold uppercase tracking-wide text-muted-foreground" }, "Account mode"),
        React.createElement("div", { role: "radiogroup", "aria-label": "Account selection mode", className: "inline-flex overflow-hidden rounded-md border border-border" },
            React.createElement("button", { type: "button", role: "radio", "aria-checked": mode === "auto", onClick: () => onChange("auto"), className: cn("flex items-center gap-1.5 px-2.5 py-1 transition-colors", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", mode === "auto"
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-muted/50") },
                React.createElement(Wand2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                React.createElement("span", null, "Auto-detect"),
                React.createElement(Badge, { variant: mode === "auto" ? "secondary" : "outline", className: "ml-0.5 text-2xs" }, autoCount)),
            React.createElement("button", { type: "button", role: "radio", "aria-checked": mode === "manual", onClick: () => onChange("manual"), className: cn("flex items-center gap-1.5 border-l border-border px-2.5 py-1 transition-colors", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", mode === "manual"
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-muted/50") },
                React.createElement(IdCard, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                React.createElement("span", null, "Manual pick"),
                React.createElement(Badge, { variant: mode === "manual" ? "secondary" : "outline", className: "ml-0.5 text-2xs" }, manualCount))),
        React.createElement("span", { className: "text-2xs text-muted-foreground" }, mode === "auto"
            ? "Only accounts with detected user-creation roles."
            : "Every signed-in account — 403 if role is missing."),
        onRefresh && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: onRefresh, disabled: discovering, "aria-label": "Re-probe directory roles", title: "Re-run the User Admin / Global Admin probe against every signed-in account. Useful when role-discovery misfired or you just granted yourself the role.", className: "ml-auto h-7 px-2" },
            discovering ? (React.createElement(Loader2, { className: "h-3 w-3 animate-spin" })) : (React.createElement(RefreshCw, { className: "h-3 w-3" })),
            React.createElement("span", { className: "ml-1.5 text-2xs" }, "Re-probe")))));
};
const UserCreatorPageInner = ({ onNavigate, }) => {
    var _a;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    // Account-mode toggle — lifted above the discovery effect so its
    // sessionStorage hydration runs before any gate is evaluated. In
    // `manual` mode we bypass the privileged-role gate entirely.
    const [accountMode, setAccountMode] = React.useState(() => {
        try {
            const raw = sessionStorage.getItem(ACCOUNT_MODE_KEY);
            return raw === "manual" ? "manual" : "auto";
        }
        catch (_a) {
            return "auto";
        }
    });
    const handleAccountModeChange = React.useCallback((mode) => {
        setAccountMode(mode);
        try {
            sessionStorage.setItem(ACCOUNT_MODE_KEY, mode);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    const [privilegedMap, setPrivilegedMap] = React.useState({});
    const [discovering, setDiscovering] = React.useState(true);
    const accountKey = React.useMemo(() => azureAccounts
        .map((a) => `${a.homeAccountId}|${a.tenantId}`)
        .sort()
        .join(","), [azureAccounts]);
    // Track probe errors separately from the privileged map so the UI can
    // distinguish "Graph said no role" from "Graph call failed entirely"
    // (the latter is recoverable — usually a token-acquisition hiccup).
    const [probeErrors, setProbeErrors] = React.useState({});
    const [probeNonce, setProbeNonce] = React.useState(0);
    const refreshProbe = React.useCallback(() => {
        setProbeNonce((n) => n + 1);
    }, []);
    React.useEffect(() => {
        let cancelled = false;
        setDiscovering(true);
        // Drop stale errors immediately so the picker reflects "probing" not
        // "the last attempt failed" while the new one runs.
        setProbeErrors({});
        (() => __awaiter(void 0, void 0, void 0, function* () {
            const next = {};
            const errs = {};
            yield Promise.allSettled(azureAccounts.map((a) => __awaiter(void 0, void 0, void 0, function* () {
                var _a, _b;
                if (!a.homeAccountId)
                    return;
                const tenantId = (_b = (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : resolveActiveTenantId(a)) !== null && _b !== void 0 ? _b : a.tenantId;
                if (!tenantId) {
                    next[a.homeAccountId] = false;
                    errs[a.homeAccountId] = "Missing active tenant.";
                    return;
                }
                try {
                    const token = yield getGraphTokenForAccount(a.homeAccountId, tenantId);
                    if (cancelled)
                        return; // bail out early — prevent setState after unmount
                    const roles = yield getMyDirectoryRoles(tenantId, token);
                    if (cancelled)
                        return;
                    next[a.homeAccountId] = canCreateUsers(roles);
                }
                catch (err) {
                    next[a.homeAccountId] = false;
                    errs[a.homeAccountId] =
                        err instanceof Error ? err.message : String(err);
                }
            })));
            if (!cancelled) {
                setPrivilegedMap(next);
                setProbeErrors(errs);
                setDiscovering(false);
            }
        }))();
        return () => {
            cancelled = true;
        };
    }, [accountKey, azureAccounts, probeNonce]);
    const privilegedAccounts = React.useMemo(() => {
        return azureAccounts
            .filter((a) => privilegedMap[a.homeAccountId])
            .map((a) => {
            var _a, _b;
            return ({
                homeAccountId: a.homeAccountId,
                tenantId: (_b = (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : resolveActiveTenantId(a)) !== null && _b !== void 0 ? _b : a.tenantId,
                username: a.username,
                name: a.name || a.username,
            });
        })
            .filter((a) => a.tenantId);
    }, [azureAccounts, privilegedMap]);
    /**
     * Accounts the picker actually shows. In `auto` mode this is
     * `privilegedAccounts` (current behavior). In `manual` mode it's
     * every signed-in account projected to the same shape — the user
     * can pick any of them and try the create call, and if the role is
     * missing we surface the resulting Graph 403 in the form.
     */
    const effectiveAccounts = React.useMemo(() => {
        if (accountMode === "manual") {
            return azureAccounts
                .map((a) => {
                var _a, _b;
                return ({
                    homeAccountId: a.homeAccountId,
                    tenantId: (_b = (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : resolveActiveTenantId(a)) !== null && _b !== void 0 ? _b : a.tenantId,
                    username: a.username,
                    name: a.name || a.username,
                });
            })
                .filter((a) => a.tenantId && a.homeAccountId);
        }
        return privilegedAccounts;
    }, [accountMode, azureAccounts, privilegedAccounts]);
    const [activeAccountId, setActiveAccountId] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(ACTIVE_ACCOUNT_KEY)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    React.useEffect(() => {
        if (effectiveAccounts.length === 0)
            return;
        const exists = effectiveAccounts.some((a) => a.homeAccountId === activeAccountId);
        if (!exists) {
            const first = effectiveAccounts[0].homeAccountId;
            setActiveAccountId(first);
            try {
                sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, first);
            }
            catch (_a) {
                /* ignore */
            }
        }
    }, [effectiveAccounts, activeAccountId]);
    const handleSelectAccount = React.useCallback((id) => {
        setActiveAccountId(id);
        try {
            sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    const activeAccount = React.useMemo(() => {
        var _a;
        return ((_a = effectiveAccounts.find((a) => a.homeAccountId === activeAccountId)) !== null && _a !== void 0 ? _a : null);
    }, [effectiveAccounts, activeAccountId]);
    // ARM-token tracker — this page only uses Graph tokens for its own
    // calls, but we still subscribe to the centralized ARM-token hook so
    // the operator sees a single consistent expiry badge across pages and
    // benefits from auto-refresh + tenant-switch re-mint behavior. Future
    // ARM-touching features added to this page will get a fresh token
    // for free.
    const armTokenTracker = useArmToken(activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.homeAccountId, activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.tenantId);
    // In manual mode, flag accounts where role-discovery did NOT find a
    // user-creation role so the picker can show a subtle "may fail" hint
    // next to them. We use the raw probe map so the hint is accurate even
    // for accounts the auto-list would have filtered out.
    const isPrivileged = React.useCallback((homeAccountId) => !!privilegedMap[homeAccountId], [privilegedMap]);
    // Tab state — synced to both ?tab= search param and sessionStorage. URL
    // wins on initial load so a deep-link / refresh keeps the operator on the
    // tab they had open. Whitelist enforced via isValidTab/VALID_TABS (above
    // the component) so a garbage ?tab=foo doesn't silently break Radix Tabs.
    const [searchParams, setSearchParams] = useSearchParams();
    const urlTab = searchParams.get("tab");
    const [tab, setTabState] = React.useState(() => {
        if (isValidTab(urlTab))
            return urlTab;
        try {
            const stored = sessionStorage.getItem(TAB_KEY);
            if (isValidTab(stored))
                return stored;
        }
        catch (_a) {
            /* ignore */
        }
        return "create";
    });
    // Stay in sync if the URL changes underneath us (back/forward / external nav).
    React.useEffect(() => {
        if (isValidTab(urlTab) && urlTab !== tab) {
            setTabState(urlTab);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [urlTab]);
    const handleTabChange = React.useCallback((v) => {
        if (!isValidTab(v))
            return;
        setTabState(v);
        try {
            sessionStorage.setItem(TAB_KEY, v);
        }
        catch (_a) {
            /* ignore */
        }
        setSearchParams((prev) => {
            const params = new URLSearchParams(prev);
            params.set("tab", v);
            return params;
        }, { replace: true });
    }, [setSearchParams]);
    // React to global tenant-switch events — when another page (or any other
    // surface) flips the active account, mirror the change here so we don't
    // drift out of sync. Only acts when the broadcast candidate is in our
    // eligible list and isn't already the active one.
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!effectiveAccounts.some((a) => a.homeAccountId === candidate))
            return;
        if (activeAccountId === candidate)
            return;
        setActiveAccountId(candidate);
        try {
            sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, candidate);
        }
        catch (_a) {
            /* ignore */
        }
    });
    // Only block on the discovery probe in `auto` mode — manual mode is
    // an explicit opt-out of the gate, so the user shouldn't have to
    // wait for role discovery to finish before picking an account.
    if (accountMode === "auto" && discovering && privilegedAccounts.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
            React.createElement(PageHeader, { title: "Create AD User", description: "Provision an Azure AD user under a tenant where you have User Administrator privileges." }),
            React.createElement(AccountModeToggle, { mode: accountMode, onChange: handleAccountModeChange, autoCount: privilegedAccounts.length, manualCount: azureAccounts.length, discovering: discovering, onRefresh: refreshProbe }),
            React.createElement("div", { role: "status", className: "flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 py-10 text-sm text-muted-foreground" },
                React.createElement(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }),
                "Discovering directory roles\u2026")));
    }
    if (effectiveAccounts.length === 0) {
        // Two distinct empty states. In `auto` mode the user has signed-in
        // accounts but none cleared the role gate — offer the manual-pick
        // escape hatch. In `manual` mode the issue is "no signed-in
        // accounts at all" → send the user to Azure Accounts.
        const inAutoWithoutRole = accountMode === "auto" && azureAccounts.length > 0;
        return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
            React.createElement(PageHeader, { title: "Create AD User", description: "Provision an Azure AD user under a tenant where you have User Administrator privileges." }),
            React.createElement(AccountModeToggle, { mode: accountMode, onChange: handleAccountModeChange, autoCount: privilegedAccounts.length, manualCount: azureAccounts.length, discovering: discovering, onRefresh: refreshProbe }),
            inAutoWithoutRole ? (React.createElement(EmptyState, { icon: ShieldAlert, title: "No user-creation access detected", description: "Auto-detect didn't find any signed-in account with a User Administrator or Global Administrator role. Switch to manual pick above if you want to attempt the create with a specific account anyway \u2014 useful when role discovery misfires on a cross-tenant Graph call.", action: {
                    label: "Switch to manual pick",
                    onClick: () => handleAccountModeChange("manual"),
                } })) : (React.createElement(SignInRequired, { whatYouCantDo: "Create a directory user", why: "an Azure account with User Administrator or Global Administrator role in the target tenant", allowTokenImport: false, onNavigate: onNavigate }))));
    }
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
        React.createElement(PageHeader, { title: "Create AD User", description: "Provision an Azure AD user under a tenant where you have User Administrator privileges." },
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                    loginHint: activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username,
                }) }),
            React.createElement(Select, { value: activeAccountId, onValueChange: handleSelectAccount },
                React.createElement(SelectTrigger, { className: "h-8 w-72 text-xs", "aria-label": accountMode === "manual"
                        ? "Select account (manual mode)"
                        : "Select privileged account" },
                    React.createElement(SelectValue, { placeholder: accountMode === "manual"
                            ? "Select account"
                            : "Select privileged account" })),
                React.createElement(SelectContent, null, effectiveAccounts.map((a) => {
                    const flagged = accountMode === "manual" && !isPrivileged(a.homeAccountId);
                    return (React.createElement(SelectItem, { key: a.homeAccountId, value: a.homeAccountId },
                        React.createElement("span", { className: "flex items-center gap-1.5 truncate" },
                            React.createElement("span", { className: "truncate" },
                                a.name || a.username,
                                React.createElement("span", { className: "ml-1 text-muted-foreground" },
                                    "(",
                                    React.createElement("code", { className: "font-mono" }, truncateMiddle(a.tenantId)),
                                    ")")),
                            flagged && (React.createElement(Badge, { variant: "warning", className: "ml-auto shrink-0 text-2xs" }, "no role")))));
                })))),
        React.createElement(AccountModeToggle, { mode: accountMode, onChange: handleAccountModeChange, autoCount: privilegedAccounts.length, manualCount: azureAccounts.length, discovering: discovering, onRefresh: refreshProbe }),
        accountMode === "auto" &&
            activeAccount &&
            probeErrors[activeAccount.homeAccountId] && (React.createElement(Alert, { variant: "warning", className: "text-xs" },
            React.createElement(AlertCircle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, null,
                "Role probe failed for",
                " ",
                React.createElement("span", { className: "font-semibold" }, activeAccount.username),
                ":",
                " ",
                React.createElement("span", { className: "font-mono text-2xs" }, probeErrors[activeAccount.homeAccountId]),
                " ",
                "\u00B7",
                " ",
                React.createElement("button", { type: "button", onClick: refreshProbe, className: "underline underline-offset-2 hover:no-underline" }, "retry probe")))),
        accountMode === "manual" &&
            activeAccount &&
            !isPrivileged(activeAccount.homeAccountId) && (React.createElement(Alert, { variant: "warning", className: "text-xs" },
            React.createElement(AlertCircle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, null,
                React.createElement("span", { className: "font-semibold" }, activeAccount.username),
                " ",
                "isn't known to hold a user-creation role (User Admin / Global Admin). The create call may fail with a 403. Switch to",
                " ",
                React.createElement("button", { type: "button", className: "underline underline-offset-2 hover:no-underline", onClick: () => handleAccountModeChange("auto") }, "auto-detect"),
                " ",
                "to filter the picker to verified accounts only."))),
        React.createElement(Tabs, { value: tab, onValueChange: handleTabChange, className: "w-full" },
            React.createElement(TabsList, { "aria-label": "User creator tabs" },
                React.createElement(TabsTrigger, { value: "create", "aria-label": "Create user" },
                    React.createElement(UserPlus, { className: "mr-1.5 h-3.5 w-3.5" }),
                    "Create User"),
                React.createElement(TabsTrigger, { value: "browse", "aria-label": "Browse existing users" },
                    React.createElement(Building2, { className: "mr-1.5 h-3.5 w-3.5" }),
                    "Browse Existing Users"),
                React.createElement(TabsTrigger, { value: "created", "aria-label": "Users created in this browser" },
                    React.createElement(HardDrive, { className: "mr-1.5 h-3.5 w-3.5" }),
                    "Created by me")),
            React.createElement(TabsContent, { value: "create" },
                React.createElement(CreateUserForm, { account: activeAccount, onCreated: () => {
                        /* keep user on tab */
                    }, store: store })),
            React.createElement(TabsContent, { value: "browse" },
                React.createElement(BrowseUsers, { tenantUsers: state.tenantUsers, azureAccounts: azureAccounts, privilegedAccounts: privilegedAccounts, onSwitchToCreateTab: (targetAccountId) => {
                        handleSelectAccount(targetAccountId);
                        handleTabChange("create");
                        const target = privilegedAccounts.find((p) => p.homeAccountId === targetAccountId);
                        if (target) {
                            store.addNotification({
                                type: "info",
                                message: `Switched to tenant ${truncateMiddle(target.tenantId)}`,
                            });
                        }
                    }, onNavigate: onNavigate })),
            React.createElement(TabsContent, { value: "created" },
                React.createElement(CreatedByMeTab, { account: activeAccount, store: store })))));
};
const FormSection = ({ icon: Icon, title, description, children, }) => (React.createElement("section", { "aria-labelledby": `section-${title.replace(/\s+/g, "-").toLowerCase()}`, className: "flex flex-col gap-3 rounded-md border border-border/60 bg-surface-overlay/40 p-4 transition-colors duration-200 ease-out hover:border-primary/30 motion-reduce:transition-none" },
    React.createElement("div", { className: "flex items-start gap-2.5" },
        React.createElement("span", { className: "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary" },
            React.createElement(Icon, { className: "h-3.5 w-3.5" })),
        React.createElement("div", { className: "flex flex-col gap-0.5" },
            React.createElement("h3", { id: `section-${title.replace(/\s+/g, "-").toLowerCase()}`, className: "text-xs font-semibold uppercase tracking-wider text-foreground" }, title),
            description && (React.createElement("p", { className: "text-2xs text-muted-foreground" }, description)))),
    children));
const CreateUserForm = ({ account, onCreated, store, }) => {
    const [domains, setDomains] = React.useState([]);
    const [domainsLoading, setDomainsLoading] = React.useState(false);
    const [domainsError, setDomainsError] = React.useState(null);
    const [selectedDomain, setSelectedDomain] = React.useState("");
    const [prefix, setPrefix] = React.useState("");
    const [displayName, setDisplayName] = React.useState("");
    const [displayNameTouched, setDisplayNameTouched] = React.useState(false);
    const [givenName, setGivenName] = React.useState("");
    const [givenNameTouched, setGivenNameTouched] = React.useState(false);
    const [surname, setSurname] = React.useState("");
    const [surnameTouched, setSurnameTouched] = React.useState(false);
    const [jobTitle, setJobTitle] = React.useState("");
    const [department, setDepartment] = React.useState("");
    const [usageLocation, setUsageLocation] = React.useState("US");
    const [password, setPassword] = React.useState("");
    const [showPassword, setShowPassword] = React.useState(false);
    const [forceChange, setForceChange] = React.useState(true);
    const [accountEnabled, setAccountEnabled] = React.useState(true);
    const [presetKey, setPresetKey] = React.useState("");
    /**
     * Whether to fire the /api/portal/auto-login endpoint right after a
     * successful create. Persisted across reloads so the operator's
     * preference (typically "on, please") survives page refreshes.
     */
    const [autoLoginEnabled, setAutoLoginEnabled] = React.useState(() => {
        if (typeof window === "undefined")
            return true;
        try {
            const raw = window.localStorage.getItem(AUTO_LOGIN_PREF_KEY);
            if (raw === null)
                return true; // default ON
            return raw === "1";
        }
        catch (_a) {
            return true;
        }
    });
    React.useEffect(() => {
        if (typeof window === "undefined")
            return;
        try {
            window.localStorage.setItem(AUTO_LOGIN_PREF_KEY, autoLoginEnabled ? "1" : "0");
        }
        catch (_a) {
            /* localStorage may be disabled — non-fatal, default still applies. */
        }
    }, [autoLoginEnabled]);
    const [autoLoginInflight, setAutoLoginInflight] = React.useState(false);
    /**
     * Quick mode — operator picks ONLY a role + count; everything else (UPN,
     * display name, given/surname, password, domain, force-change, enabled)
     * is auto-generated from a built-in name pool + the active preset. Default
     * is ON; the existing detailed form is preserved as opt-out.
     */
    const [quickMode, setQuickMode] = React.useState(() => {
        if (typeof window === "undefined")
            return true;
        try {
            const raw = window.localStorage.getItem(QUICK_MODE_KEY);
            if (raw === null)
                return true;
            return raw === "1";
        }
        catch (_a) {
            return true;
        }
    });
    React.useEffect(() => {
        if (typeof window === "undefined")
            return;
        try {
            window.localStorage.setItem(QUICK_MODE_KEY, quickMode ? "1" : "0");
        }
        catch (_a) {
            /* localStorage may be unavailable. */
        }
    }, [quickMode]);
    const [count, setCount] = React.useState(1);
    /**
     * Bumping this seed regenerates the preview list — operator clicks
     * "Generate new names" if they don't like the current draft.
     */
    const [batchSeed, setBatchSeed] = React.useState(0);
    const [bulkSubmitting, setBulkSubmitting] = React.useState(false);
    const [bulkProgress, setBulkProgress] = React.useState(null);
    /**
     * Two-step confirm for any bulk create that would provision more than
     * BULK_CONFIRM_THRESHOLD users. Single-user creates skip the dialog
     * (low-risk happy path). The dialog renders a summary of what will be
     * created so the operator can sanity-check before committing to N
     * Graph writes.
     */
    const [bulkConfirmOpen, setBulkConfirmOpen] = React.useState(false);
    /**
     * Persisted operator templates — captures preset + display-name pattern
     * + optional redirect URL so the operator can re-apply a frequently-used
     * combo with one click. Lives in localStorage (per-browser); no tenant
     * scoping because templates are operator-personal, not tenant-state.
     *
     * COORDINATOR: if a sibling page wants to share these templates (e.g.
     * tenant-users password-reset flow re-applying the same role preset),
     * promote the storage key to a shared module — for now it's local.
     */
    const [savedTemplates, setSavedTemplates] = usePersistedState(SAVED_TEMPLATES_KEY, [], { version: 1 });
    /**
     * CSV-paste mode — operator pastes a multi-line CSV (`prefix,displayName,role?`)
     * to drive a batch create with explicit per-row UPNs instead of synthesized
     * names. Toggled off by default; lives inside quick-mode because it's a
     * quick-mode variant.
     *
     * COORDINATOR: user-creator has CSV paste, consider import-batch. The
     * import-batch page may want to delegate single-tenant CSV creates here
     * rather than re-implementing the row→Graph-write loop.
     */
    const [csvMode, setCsvMode] = React.useState(false);
    const [csvText, setCsvText] = React.useState("");
    const [csvError, setCsvError] = React.useState(null);
    /**
     * Operator-defined naming-convention regex. When non-empty, the create
     * button is blocked unless every UPN prefix matches. Lives in localStorage
     * because operators tend to keep the same convention across sessions.
     * Empty string = no gate (default).
     *
     * Corpus ref: `_bypass_modify_delete.md` §6 — surfacing UPN shape at
     * create-time is one of the few defender-side counters to the ★★★★★
     * stealth of the "Add user" audit event. An operator who locks down a
     * pattern (e.g. `^[a-z]+\.[a-z]+\.[a-z0-9]{4}$`) catches deceptive-name
     * persistence attempts before the Graph POST goes out.
     */
    const [namingConvention, setNamingConvention] = usePersistedState(NAMING_CONVENTION_KEY, "", { version: 1 });
    /**
     * Compiled regex from the operator's pattern, or `null` if the field is
     * empty or invalid. We swallow the SyntaxError so a half-typed regex
     * doesn't blow up the page; the UI surfaces the parse error inline.
     */
    const compiledNamingRegex = React.useMemo(() => {
        if (!namingConvention.trim())
            return { re: null, error: null };
        try {
            return { re: new RegExp(namingConvention), error: null };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { re: null, error: msg };
        }
    }, [namingConvention]);
    /**
     * Debug JSON-preview toggle — shows a sanitized rendition of what
     * would be POSTed to Graph (passwords redacted). Toggleable via the
     * `d` hotkey when the form is focused. Persisted so power-users
     * keep it on across reloads.
     */
    const [debugPreview, setDebugPreview] = usePersistedState(DEBUG_PREVIEW_KEY, false, { version: 1 });
    const [availability, setAvailability] = React.useState({
        status: "idle",
    });
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    const [submitError, setSubmitError] = React.useState(null);
    /**
     * The most recently created user during this form's lifetime — drives the
     * inline "Sign in to Portal" button below. Cleared whenever the form is
     * reset for a new user.
     */
    const [lastCreated, setLastCreated] = React.useState(null);
    React.useEffect(() => {
        if (!account) {
            setDomains([]);
            setSelectedDomain("");
            return;
        }
        let cancelled = false;
        setDomainsLoading(true);
        setDomainsError(null);
        (() => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            try {
                const token = yield getGraphTokenForAccount(account.homeAccountId, account.tenantId);
                const list = yield listVerifiedDomains(account.tenantId, token);
                if (cancelled)
                    return;
                setDomains(list);
                const def = (_a = list.find((d) => d.isDefault)) !== null && _a !== void 0 ? _a : list[0];
                setSelectedDomain((_b = def === null || def === void 0 ? void 0 : def.name) !== null && _b !== void 0 ? _b : "");
            }
            catch (err) {
                if (cancelled)
                    return;
                const msg = err instanceof Error ? err.message : String(err);
                setDomainsError(msg);
                setDomains([]);
                setSelectedDomain("");
            }
            finally {
                if (!cancelled)
                    setDomainsLoading(false);
            }
        }))();
        return () => {
            cancelled = true;
        };
    }, [account]);
    React.useEffect(() => {
        setPrefix("");
        setDisplayName("");
        setDisplayNameTouched(false);
        setGivenName("");
        setGivenNameTouched(false);
        setSurname("");
        setSurnameTouched(false);
        setJobTitle("");
        setDepartment("");
        setPassword("");
        setShowPassword(false);
        setForceChange(true);
        setAccountEnabled(true);
        setPresetKey("");
        setAvailability({ status: "idle" });
        setSubmitError(null);
    }, [account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId]);
    React.useEffect(() => {
        if (!displayNameTouched) {
            setDisplayName(titleCase(prefix));
        }
        if (!givenNameTouched) {
            setGivenName(deriveGivenName(prefix));
        }
        if (!surnameTouched) {
            setSurname(deriveSurname(prefix));
        }
    }, [prefix, displayNameTouched, givenNameTouched, surnameTouched]);
    const upn = prefix && selectedDomain ? `${prefix}@${selectedDomain}` : "";
    const prefixValid = USER_PREFIX_RE.test(prefix);
    // Real-time availability probe — debounced 400ms, cancellable on input change.
    React.useEffect(() => {
        if (!account || !upn || !prefixValid) {
            setAvailability({ status: "idle" });
            return;
        }
        const controller = new AbortController();
        let cancelled = false;
        setAvailability({ status: "checking" });
        (() => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            try {
                yield sleep(AVAILABILITY_DEBOUNCE_MS);
                if (controller.signal.aborted)
                    return;
                const token = yield getGraphTokenForAccount(account.homeAccountId, account.tenantId);
                if (cancelled)
                    return;
                const url = `${GRAPH_BASE}/users/${encodeURIComponent(upn)}?$select=id`;
                const response = yield fetch(url, {
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: "application/json",
                    },
                    signal: controller.signal,
                });
                if (cancelled)
                    return;
                if (response.status === 404) {
                    setAvailability({ status: "available" });
                }
                else if (response.ok) {
                    setAvailability({ status: "taken" });
                }
                else {
                    const body = yield response.json().catch(() => ({}));
                    const msg = (_b = (_a = body === null || body === void 0 ? void 0 : body.error) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : `Probe failed: HTTP ${response.status}`;
                    setAvailability({ status: "error", message: msg });
                }
            }
            catch (err) {
                if (cancelled)
                    return;
                if (err instanceof DOMException && err.name === "AbortError")
                    return;
                const msg = err instanceof Error ? err.message : String(err);
                setAvailability({ status: "error", message: msg });
            }
        }))();
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [account, upn, prefixValid]);
    const handlePresetChange = React.useCallback((key) => {
        setPresetKey(key);
        const preset = PRESETS.find((p) => p.key === key);
        if (!preset)
            return;
        setJobTitle(preset.jobTitle);
        setDepartment(preset.department);
        setUsageLocation(preset.usageLocation);
        setForceChange(preset.forceChangePassword);
        setAccountEnabled(preset.accountEnabled);
        setSubmitError(null);
    }, []);
    const formValues = React.useMemo(() => ({
        prefix,
        domain: selectedDomain,
        displayName,
        givenName,
        surname,
        jobTitle,
        department,
        usageLocation,
        password,
        forceChange,
        accountEnabled,
    }), [
        prefix,
        selectedDomain,
        displayName,
        givenName,
        surname,
        jobTitle,
        department,
        usageLocation,
        password,
        forceChange,
        accountEnabled,
    ]);
    const validation = React.useMemo(() => userFormSchema.safeParse(formValues), [formValues]);
    const fieldErrors = React.useMemo(() => {
        if (validation.success)
            return {};
        const out = {};
        for (const issue of validation.error.issues) {
            const k = issue.path[0];
            if (k && out[k] === undefined) {
                out[k] = issue.message;
            }
        }
        return out;
    }, [validation]);
    /**
     * Suspicious-name result for the *currently typed* prefix in detailed
     * mode. Surfaces a non-blocking warning chip near the prefix input. We
     * never block submission on this — operators occasionally legitimately
     * create svc_ accounts — but we make the deceptive shape *loud* so the
     * operator at least has to mouse past it.
     */
    const suspiciousPrefix = React.useMemo(() => detectSuspiciousName(prefix), [prefix]);
    /**
     * Naming-convention pass/fail for the detailed-mode prefix. Empty
     * regex = pass through. Compiled-with-error = pass through (we don't
     * want a typo in the regex to block all creates) but we surface the
     * regex error inline so the operator notices.
     */
    const namingConventionOk = React.useMemo(() => {
        if (!compiledNamingRegex.re)
            return true;
        return compiledNamingRegex.re.test(prefix);
    }, [compiledNamingRegex, prefix]);
    const formValid = !!account &&
        validation.success &&
        availability.status === "available" &&
        namingConventionOk;
    const handleGeneratePassword = React.useCallback(() => {
        setPassword(generateRandomPassword());
        setShowPassword(true);
        setSubmitError(null);
    }, []);
    const handleCopyTenant = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!account)
            return;
        try {
            yield navigator.clipboard.writeText(account.tenantId);
            store.addNotification({
                type: "info",
                message: "Tenant ID copied to clipboard.",
            });
        }
        catch (_a) {
            /* clipboard may be unavailable */
        }
    }), [account, store]);
    const handleSubmitClick = React.useCallback(() => {
        if (!formValid)
            return;
        setSubmitError(null);
        setConfirmOpen(true);
    }, [formValid]);
    // ---- Quick-mode preview + submit -------------------------------------
    const activePresetForQuick = React.useMemo(() => {
        var _a;
        return (_a = PRESETS.find((p) => p.key === presetKey)) !== null && _a !== void 0 ? _a : PRESETS[0];
    }, [presetKey]);
    /**
     * Synthesized batch — regenerates whenever the inputs change OR the
     * operator clicks "Generate new names" (which bumps `batchSeed`).
     *
     * `batchSeed` is intentionally referenced inside the memo even though it's
     * not used in the body — it's the cache-bust signal so the memo recomputes
     * on demand. ESLint will see it in the dep array; a void-cast in the body
     * tells humans it's load-bearing.
     */
    const batchPreview = React.useMemo(() => {
        void batchSeed;
        if (!quickMode)
            return [];
        if (!selectedDomain)
            return [];
        // CSV-paste branch — operator-driven UPNs override synthesized names.
        // Parser failures DON'T crash the preview; they surface via csvError
        // below the preview list.
        if (csvMode) {
            if (!csvText.trim())
                return [];
            const parsed = parseCsvPayload(csvText, activePresetForQuick, selectedDomain);
            // Cap CSV-parsed rows to QUICK_COUNT_MAX — protects the operator
            // from accidentally pasting a 10k-row export.
            return parsed.rows.slice(0, QUICK_COUNT_MAX);
        }
        const safeCount = Math.max(QUICK_COUNT_MIN, Math.min(QUICK_COUNT_MAX, Math.floor(count) || 1));
        return generateBatchPayload(safeCount, activePresetForQuick, selectedDomain);
    }, [
        quickMode,
        count,
        activePresetForQuick,
        selectedDomain,
        batchSeed,
        csvMode,
        csvText,
    ]);
    /**
     * CSV-parse errors — re-derived alongside batchPreview so we can surface
     * the offending rows to the operator without coupling preview rendering
     * to the error path.
     */
    const csvParseErrors = React.useMemo(() => {
        if (!csvMode || !selectedDomain || !csvText.trim())
            return [];
        return parseCsvPayload(csvText, activePresetForQuick, selectedDomain).errors;
    }, [csvMode, csvText, selectedDomain, activePresetForQuick]);
    // Surface CSV parser errors as a single-line submitError-style hint —
    // separate from submitError so a partial CSV doesn't block clearing.
    React.useEffect(() => {
        if (csvMode && csvParseErrors.length > 0) {
            setCsvError(`${csvParseErrors.length} CSV row${csvParseErrors.length === 1 ? "" : "s"} ignored: ${csvParseErrors
                .slice(0, 3)
                .map((e) => `line ${e.line} (${e.reason})`)
                .join("; ")}${csvParseErrors.length > 3 ? "; …" : ""}`);
        }
        else {
            setCsvError(null);
        }
    }, [csvMode, csvParseErrors]);
    /**
     * Per-row suspicious-name results for the batch preview. Map keyed by
     * UPN so the preview list can render a per-row chip without re-running
     * the regex sweep per render.
     *
     * Corpus ref: `_bypass_modify_delete.md` §6 — create_user is ★★★★★
     * stealth, so the *only* natural defender signal at provisioning time
     * is the shape of the name. Flagging at the preview stage gives the
     * operator one last bail-out before N audit events get burned.
     */
    const batchSuspicious = React.useMemo(() => {
        const out = {};
        for (const r of batchPreview) {
            const s = detectSuspiciousName(r.prefix);
            if (s)
                out[r.upn] = s;
        }
        return out;
    }, [batchPreview]);
    /**
     * Per-row naming-convention pass/fail for the batch preview. Empty
     * regex (the default) flags nothing. Drives the per-row red-line
     * visual in the preview list AND the gate on `quickValid` below.
     */
    const batchNamingFails = React.useMemo(() => {
        const out = new Set();
        if (!compiledNamingRegex.re)
            return out;
        for (const r of batchPreview) {
            if (!compiledNamingRegex.re.test(r.prefix))
                out.add(r.upn);
        }
        return out;
    }, [compiledNamingRegex, batchPreview]);
    /**
     * Audit-event surface for the upcoming submit — count of create_user,
     * vault_put, webui_auto_login records the run will emit. Surfaced in
     * the confirm dialog AND the debug JSON preview so the *invisible*
     * side-effects are as loud as the visible Graph POST.
     */
    const auditPreview = React.useMemo(() => summarizeAuditPreview(batchPreview, autoLoginEnabled), [batchPreview, autoLoginEnabled]);
    /**
     * Sanitized JSON preview — what a Graph POST body would look like for
     * each row, with passwords redacted. Operators in debug mode see this
     * panel and can sanity-check that the right attributes will flow. We
     * deliberately DON'T preview temp passwords here — they belong in the
     * encrypted vault, not in a screenshot-friendly preview pane.
     */
    const debugPreviewJson = React.useMemo(() => {
        var _a, _b;
        if (!debugPreview)
            return "";
        const sanitized = batchPreview.map((r) => ({
            userPrincipalName: r.upn,
            displayName: r.displayName,
            mailNickname: r.prefix,
            passwordProfile: {
                password: "***REDACTED***",
                forceChangePasswordNextSignIn: r.forceChange,
            },
            accountEnabled: r.accountEnabled,
            usageLocation: r.usageLocation,
            givenName: r.givenName,
            surname: r.surname,
            jobTitle: r.jobTitle,
            department: r.department,
        }));
        return JSON.stringify({
            targetTenant: (_a = account === null || account === void 0 ? void 0 : account.tenantId) !== null && _a !== void 0 ? _a : "(no account)",
            actor: (_b = account === null || account === void 0 ? void 0 : account.username) !== null && _b !== void 0 ? _b : "(no account)",
            userCount: sanitized.length,
            auditEvents: {
                create_user: auditPreview.createUser,
                vault_put: auditPreview.vaultPut,
                webui_auto_login: auditPreview.autoLogin,
            },
            suspiciousNames: auditPreview.suspiciousNames,
            users: sanitized,
        }, null, 2);
    }, [debugPreview, batchPreview, auditPreview, account]);
    const quickValid = !!account &&
        quickMode &&
        batchPreview.length > 0 &&
        !bulkSubmitting &&
        batchNamingFails.size === 0;
    /**
     * Bulk-create everything in `batchPreview`. We call `createUser`
     * sequentially (not parallel) so we don't fan out N concurrent Graph
     * writes — Azure AD's per-tenant write throttle is much tighter than
     * read throttle, and even 5 parallel POSTs can trip 429s on a busy
     * tenant. Sequential is slow (~1-2s per user) but predictable.
     *
     * For count==1 we still fire the auto-login chain. For count>1 we
     * surface a summary toast and switch the active tab to "Created by me"
     * so the operator can pick which users to actually sign in as.
     */
    const handleQuickSubmit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!account || batchPreview.length === 0)
            return;
        setBulkSubmitting(true);
        setSubmitError(null);
        setBulkProgress({ done: 0, total: batchPreview.length });
        const actor = account.username || account.name || account.homeAccountId;
        let token;
        try {
            token = yield getGraphTokenForAccount(account.homeAccountId, account.tenantId);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setSubmitError(`Token acquisition failed: ${msg}`);
            setBulkSubmitting(false);
            setBulkProgress(null);
            return;
        }
        let succeeded = 0;
        let failed = 0;
        let lastSuccess = null;
        for (let i = 0; i < batchPreview.length; i++) {
            const p = batchPreview[i];
            setBulkProgress({
                done: i,
                total: batchPreview.length,
                current: p.upn,
            });
            try {
                const result = yield createUser(account.tenantId, {
                    userPrincipalName: p.upn,
                    displayName: p.displayName,
                    mailNickname: p.prefix,
                    password: p.password,
                    forceChangePasswordNextSignIn: p.forceChange,
                    accountEnabled: p.accountEnabled,
                    usageLocation: p.usageLocation,
                    givenName: p.givenName,
                    surname: p.surname,
                    jobTitle: p.jobTitle,
                    department: p.department,
                }, token);
                const finalUpn = result.userPrincipalName || p.upn;
                auditLog.record({
                    actor,
                    action: "create_user",
                    target: finalUpn,
                    status: "success",
                    details: {
                        tenantId: account.tenantId,
                        accountEnabled: p.accountEnabled,
                        forceChangePassword: p.forceChange,
                        presetKey: activePresetForQuick.key,
                        quickMode: true,
                        batchIndex: i,
                        batchSize: batchPreview.length,
                    },
                });
                try {
                    yield credentialVault.put({
                        upn: finalUpn,
                        password: p.password,
                        tenantId: account.tenantId,
                        homeAccountId: account.homeAccountId,
                        displayName: p.displayName,
                        createdAt: new Date().toISOString(),
                        source: "create",
                        mustChangePassword: p.forceChange,
                    });
                    auditLog.record({
                        actor,
                        action: "vault_put",
                        target: finalUpn,
                        status: "success",
                        details: {
                            tenantId: account.tenantId,
                            reason: "quick-create",
                            batchIndex: i,
                            batchSize: batchPreview.length,
                        },
                    });
                }
                catch (vaultErr) {
                    const vmsg = vaultErr instanceof Error ? vaultErr.message : String(vaultErr);
                    console.warn("[user-creator] quick vault.put failed", vaultErr);
                    auditLog.record({
                        actor,
                        action: "vault_put",
                        target: finalUpn,
                        status: "failure",
                        error: vmsg,
                        details: {
                            tenantId: account.tenantId,
                            reason: "quick-create",
                            batchIndex: i,
                            batchSize: batchPreview.length,
                        },
                    });
                }
                succeeded += 1;
                lastSuccess = Object.assign(Object.assign({}, p), { upn: finalUpn });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                auditLog.record({
                    actor,
                    action: "create_user",
                    target: p.upn,
                    status: "failure",
                    error: msg,
                    details: {
                        tenantId: account.tenantId,
                        presetKey: activePresetForQuick.key,
                        quickMode: true,
                        batchIndex: i,
                        batchSize: batchPreview.length,
                    },
                });
                failed += 1;
            }
        }
        setBulkProgress({
            done: batchPreview.length,
            total: batchPreview.length,
        });
        // Single-user happy path — fire the auto-login chain + show the
        // success card with the 3 sign-in buttons.
        if (batchPreview.length === 1 &&
            succeeded === 1 &&
            lastSuccess !== null) {
            setLastCreated({
                upn: lastSuccess.upn,
                password: lastSuccess.password,
                mustChangePassword: lastSuccess.forceChange,
            });
            store.addNotification({
                type: "success",
                message: `Created user ${lastSuccess.upn}`,
            });
            if (autoLoginEnabled) {
                setAutoLoginInflight(true);
                store.addNotification({
                    type: "info",
                    message: lastSuccess.forceChange
                        ? `Auto sign-in for ${lastSuccess.upn} (will auto-set fresh password)…`
                        : `Auto sign-in for ${lastSuccess.upn}…`,
                });
                // Full-auto WebUI sign-in via Playwright. Same shape as the
                // detailed-mode chain: generate newPassword if mustChange,
                // patch vault on success.
                const successSnapshot = lastSuccess;
                const newPassword = successSnapshot.forceChange
                    ? generateRandomPassword()
                    : undefined;
                void (() => __awaiter(void 0, void 0, void 0, function* () {
                    var _b;
                    try {
                        const res = yield launchPortalAutoLogin({
                            upn: successSnapshot.upn,
                            password: successSnapshot.password,
                            tenantId: account.tenantId,
                            mustChangePassword: successSnapshot.forceChange,
                            newPassword,
                            target: "webui",
                            webuiUrl: typeof window !== "undefined"
                                ? window.location.origin + "/"
                                : undefined,
                        });
                        if (res.ok) {
                            if (newPassword) {
                                try {
                                    yield credentialVault.put({
                                        upn: successSnapshot.upn,
                                        password: newPassword,
                                        tenantId: account.tenantId,
                                        homeAccountId: account.homeAccountId,
                                        displayName: successSnapshot.displayName,
                                        createdAt: new Date().toISOString(),
                                        source: "create",
                                        mustChangePassword: false,
                                    });
                                    auditLog.record({
                                        actor,
                                        action: "vault_put",
                                        target: successSnapshot.upn,
                                        status: "success",
                                        details: {
                                            tenantId: account.tenantId,
                                            reason: "quick-mode-change-pw-patch",
                                        },
                                    });
                                    setLastCreated({
                                        upn: successSnapshot.upn,
                                        password: newPassword,
                                        mustChangePassword: false,
                                    });
                                }
                                catch (vaultErr) {
                                    const vmsg = vaultErr instanceof Error
                                        ? vaultErr.message
                                        : String(vaultErr);
                                    console.warn("[user-creator] quick-mode vault patch failed", vaultErr);
                                    auditLog.record({
                                        actor,
                                        action: "vault_put",
                                        target: successSnapshot.upn,
                                        status: "failure",
                                        error: vmsg,
                                        details: {
                                            tenantId: account.tenantId,
                                            reason: "quick-mode-change-pw-patch",
                                        },
                                    });
                                }
                            }
                            store.addNotification({
                                type: "success",
                                message: newPassword
                                    ? `Signed in as ${successSnapshot.upn} with a fresh password. Vault updated.`
                                    : `Signed in to WebUI as ${successSnapshot.upn} in a new browser window.`,
                            });
                            auditLog.record({
                                actor,
                                action: "webui_auto_login",
                                target: successSnapshot.upn,
                                status: "success",
                                details: {
                                    tenantId: account.tenantId,
                                    mustChangePassword: successSnapshot.forceChange,
                                    newPasswordSet: !!newPassword,
                                    quickMode: true,
                                },
                            });
                        }
                        else {
                            auditLog.record({
                                actor,
                                action: "webui_auto_login",
                                target: successSnapshot.upn,
                                status: "failure",
                                error: res.error,
                                details: {
                                    tenantId: account.tenantId,
                                    mustChangePassword: successSnapshot.forceChange,
                                    status: res.status,
                                    quickMode: true,
                                },
                            });
                            store.addNotification({
                                type: "error",
                                message: `Auto sign-in failed for ${successSnapshot.upn}: ${(_b = res.error) !== null && _b !== void 0 ? _b : "unknown"}. Credential is saved — retry from the "Created by me" tab.`,
                            });
                        }
                    }
                    finally {
                        setAutoLoginInflight(false);
                    }
                }))();
            }
        }
        else {
            // Multi-user batch — just summary toast + tab switch hint.
            store.addNotification({
                type: failed > 0 ? "warning" : "success",
                message: `Created ${succeeded} of ${batchPreview.length} users${failed > 0 ? ` · ${failed} failed` : ""}. Open the "Created by me" tab to sign in as any of them.`,
            });
            if (failed > 0) {
                setSubmitError(`Bulk create finished with ${failed} failure${failed === 1 ? "" : "s"}. Check the audit log for details.`);
            }
        }
        // Bump the seed so a fresh preview shows for the next run.
        setBatchSeed((s) => s + 1);
        setBulkSubmitting(false);
        setBulkProgress(null);
        onCreated();
    }), [
        account,
        batchPreview,
        activePresetForQuick,
        autoLoginEnabled,
        store,
        onCreated,
    ]);
    /**
     * Hotkey wiring — keeps the form keyboard-first.
     *   - `Ctrl+Enter` / `Cmd+Enter` → submit (quick-mode bulk or detailed)
     *   - `Esc`                       → clear in-form errors + close any
     *                                   open confirm dialog (defensive)
     *   - `d` (form-focused)          → toggle the debug JSON-preview panel
     *
     * Hotkeys are bound at the document level but suppressed when the user
     * is typing inside a `<textarea>` or a multi-line CSV input. We DON'T
     * suppress for `<input>` because Ctrl+Enter from an input is the
     * canonical "submit-from-anywhere" gesture in this form.
     */
    React.useEffect(() => {
        const handler = (ev) => {
            // Ignore when an interactive control on top of the form is
            // capturing the keystroke (textarea = CSV paste box).
            const target = ev.target;
            const inTextArea = (target === null || target === void 0 ? void 0 : target.tagName) === "TEXTAREA";
            if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
                ev.preventDefault();
                if (quickMode) {
                    if (!quickValid)
                        return;
                    if (batchPreview.length > BULK_CONFIRM_THRESHOLD) {
                        setBulkConfirmOpen(true);
                    }
                    else {
                        void handleQuickSubmit();
                    }
                }
                else {
                    if (!formValid || submitting)
                        return;
                    setSubmitError(null);
                    setConfirmOpen(true);
                }
                return;
            }
            if (ev.key === "Escape") {
                // Don't steal Esc from Radix dialogs — they manage their own
                // close. We only clear inline form errors when no dialog is
                // open. Radix sets `data-state="open"` on the dialog root and
                // adds an overlay; sniffing the overlay is the cheapest check.
                if (document.querySelector('[data-state="open"][role="dialog"]')) {
                    return;
                }
                if (submitError)
                    setSubmitError(null);
                if (csvError)
                    setCsvError(null);
                return;
            }
            if (ev.key === "d" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                if (inTextArea)
                    return;
                // Don't fire while typing in any text input — `d` is a legit
                // letter. Bind to "form focused" by checking the active element
                // is NOT a text input/textarea/select editing-mode.
                const tag = target === null || target === void 0 ? void 0 : target.tagName;
                const editable = tag === "INPUT" ||
                    tag === "TEXTAREA" ||
                    tag === "SELECT" ||
                    (target === null || target === void 0 ? void 0 : target.isContentEditable);
                if (editable)
                    return;
                ev.preventDefault();
                setDebugPreview((v) => !v);
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [
        quickMode,
        quickValid,
        formValid,
        submitting,
        batchPreview.length,
        submitError,
        csvError,
        handleQuickSubmit,
        setDebugPreview,
    ]);
    const handleConfirm = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!account)
            return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            const token = yield getGraphTokenForAccount(account.homeAccountId, account.tenantId);
            const result = yield createUser(account.tenantId, {
                userPrincipalName: upn,
                displayName: displayName.trim(),
                mailNickname: prefix,
                password,
                forceChangePasswordNextSignIn: forceChange,
                accountEnabled,
                usageLocation: usageLocation || undefined,
                givenName: givenName.trim() || undefined,
                surname: surname.trim() || undefined,
                jobTitle: jobTitle.trim() || undefined,
                department: department.trim() || undefined,
            }, token);
            auditLog.record({
                actor: account.username || account.name || account.homeAccountId,
                action: "create_user",
                target: result.userPrincipalName || upn,
                status: "success",
                details: {
                    tenantId: account.tenantId,
                    accountEnabled,
                    forceChangePassword: forceChange,
                    presetKey: presetKey || undefined,
                },
            });
            // Capture the credential in the encrypted vault so the user can later
            // launch an Azure portal sign-in for this UPN via PortalLoginButton.
            // Failures here are non-fatal — the user creation already succeeded.
            const finalUpn = result.userPrincipalName || upn;
            const auditActor = account.username || account.name || account.homeAccountId;
            try {
                yield credentialVault.put({
                    upn: finalUpn,
                    password,
                    tenantId: account.tenantId,
                    homeAccountId: account.homeAccountId,
                    displayName: displayName.trim() || undefined,
                    createdAt: new Date().toISOString(),
                    source: "create",
                    mustChangePassword: forceChange,
                });
                auditLog.record({
                    actor: auditActor,
                    action: "vault_put",
                    target: finalUpn,
                    status: "success",
                    details: {
                        tenantId: account.tenantId,
                        reason: "detailed-create",
                    },
                });
                setLastCreated({
                    upn: finalUpn,
                    password,
                    mustChangePassword: forceChange,
                });
            }
            catch (vaultErr) {
                const vmsg = vaultErr instanceof Error ? vaultErr.message : String(vaultErr);
                console.warn("[user-creator] vault.put failed", vaultErr);
                auditLog.record({
                    actor: auditActor,
                    action: "vault_put",
                    target: finalUpn,
                    status: "failure",
                    error: vmsg,
                    details: {
                        tenantId: account.tenantId,
                        reason: "detailed-create",
                    },
                });
            }
            store.addNotification({
                type: "success",
                message: `Created user ${result.userPrincipalName}`,
            });
            // Fire-and-forget the portal auto-login. We don't await on the success
            // path — the dev-server endpoint launches a real Chromium window and
            // returns 200 only after Playwright has filled the email + password,
            // which can take a few seconds. Blocking the success toast on that
            // would make the form feel stuck. We DO surface a separate toast when
            // the launch resolves (success or failure) so the operator knows the
            // window is on its way.
            if (autoLoginEnabled) {
                setAutoLoginInflight(true);
                store.addNotification({
                    type: "info",
                    message: forceChange
                        ? `Auto sign-in for ${finalUpn} (will auto-set fresh password)…`
                        : `Auto sign-in for ${finalUpn}…`,
                });
                const actor = account.username || account.name || account.homeAccountId;
                // Full-auto WebUI sign-in:
                //   1. Generate newPassword if mustChangePassword (so the
                //      Playwright change-password form auto-fills cleanly).
                //   2. Fire the Playwright endpoint with target: "webui" so the
                //      resulting browser session is signed into this app, not
                //      portal.azure.com.
                //   3. On success, patch the vault with the new password (if
                //      one was set) and clear mustChangePassword so subsequent
                //      sign-ins skip the reset prompt.
                //   4. On failure, the credential is still in the vault from
                //      the create flow — operator can retry from "Created by me"
                //      or fall back to MSAL popup on the success card.
                const newPassword = forceChange ? generateRandomPassword() : undefined;
                const upnSnapshot = finalUpn;
                const passwordSnapshot = password;
                const tenantSnapshot = account.tenantId;
                const homeAccountSnapshot = account.homeAccountId;
                const displaySnapshot = displayName.trim() || undefined;
                void (() => __awaiter(void 0, void 0, void 0, function* () {
                    var _c;
                    try {
                        const res = yield launchPortalAutoLogin({
                            upn: upnSnapshot,
                            password: passwordSnapshot,
                            tenantId: tenantSnapshot,
                            mustChangePassword: forceChange,
                            newPassword,
                            target: "webui",
                            webuiUrl: typeof window !== "undefined"
                                ? window.location.origin + "/"
                                : undefined,
                        });
                        if (res.ok) {
                            if (newPassword) {
                                try {
                                    yield credentialVault.put({
                                        upn: upnSnapshot,
                                        password: newPassword,
                                        tenantId: tenantSnapshot,
                                        homeAccountId: homeAccountSnapshot,
                                        displayName: displaySnapshot,
                                        createdAt: new Date().toISOString(),
                                        source: "create",
                                        mustChangePassword: false,
                                    });
                                    auditLog.record({
                                        actor,
                                        action: "vault_put",
                                        target: upnSnapshot,
                                        status: "success",
                                        details: {
                                            tenantId: tenantSnapshot,
                                            reason: "auto-change-password-patch",
                                        },
                                    });
                                    setLastCreated({
                                        upn: upnSnapshot,
                                        password: newPassword,
                                        mustChangePassword: false,
                                    });
                                }
                                catch (vaultErr) {
                                    const vmsg = vaultErr instanceof Error
                                        ? vaultErr.message
                                        : String(vaultErr);
                                    console.warn("[user-creator] vault patch after auto change-password failed", vaultErr);
                                    auditLog.record({
                                        actor,
                                        action: "vault_put",
                                        target: upnSnapshot,
                                        status: "failure",
                                        error: vmsg,
                                        details: {
                                            tenantId: tenantSnapshot,
                                            reason: "auto-change-password-patch",
                                        },
                                    });
                                }
                            }
                            store.addNotification({
                                type: "success",
                                message: newPassword
                                    ? `Signed in as ${upnSnapshot} with a fresh password. Vault updated.`
                                    : `Signed in to WebUI as ${upnSnapshot} in a new browser window.`,
                            });
                            auditLog.record({
                                actor,
                                action: "webui_auto_login",
                                target: upnSnapshot,
                                status: "success",
                                details: {
                                    tenantId: tenantSnapshot,
                                    mustChangePassword: forceChange,
                                    newPasswordSet: !!newPassword,
                                },
                            });
                            return;
                        }
                        auditLog.record({
                            actor,
                            action: "webui_auto_login",
                            target: upnSnapshot,
                            status: "failure",
                            error: res.error,
                            details: {
                                tenantId: tenantSnapshot,
                                mustChangePassword: forceChange,
                                status: res.status,
                            },
                        });
                        store.addNotification({
                            type: "error",
                            message: `Auto sign-in failed for ${upnSnapshot}: ${(_c = res.error) !== null && _c !== void 0 ? _c : "unknown"}. Use "MSAL popup (manual)" on the success card to sign in by typing the password yourself.`,
                        });
                    }
                    finally {
                        setAutoLoginInflight(false);
                    }
                }))();
            }
            setConfirmOpen(false);
            setPrefix("");
            setDisplayName("");
            setDisplayNameTouched(false);
            setGivenName("");
            setGivenNameTouched(false);
            setSurname("");
            setSurnameTouched(false);
            setJobTitle("");
            setDepartment("");
            setPassword("");
            setShowPassword(false);
            setForceChange(true);
            setAccountEnabled(true);
            setPresetKey("");
            setAvailability({ status: "idle" });
            onCreated();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            auditLog.record({
                actor: account.username || account.name || account.homeAccountId,
                action: "create_user",
                target: upn,
                status: "failure",
                error: msg,
                details: {
                    tenantId: account.tenantId,
                    accountEnabled,
                    forceChangePassword: forceChange,
                    presetKey: presetKey || undefined,
                },
            });
            setSubmitError(msg);
            setConfirmOpen(false);
        }
        finally {
            setSubmitting(false);
        }
    }), [
        account,
        upn,
        displayName,
        prefix,
        password,
        forceChange,
        accountEnabled,
        usageLocation,
        givenName,
        surname,
        jobTitle,
        department,
        presetKey,
        store,
        onCreated,
        autoLoginEnabled,
    ]);
    if (!account) {
        return (React.createElement(Card, null,
            React.createElement(CardContent, { className: "py-8 text-center text-sm text-muted-foreground" }, "Select a privileged account to begin creating a user.")));
    }
    const activePreset = PRESETS.find((p) => p.key === presetKey);
    return (React.createElement(React.Fragment, null,
        React.createElement(Card, null,
            React.createElement(CardHeader, null,
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                    React.createElement(UserPlus, { className: "h-4 w-4 text-primary" }),
                    "New user details"),
                React.createElement(CardDescription, null, "Tenant ID is auto-derived from the selected account. The UPN prefix is the only required user-entered identifier.")),
            React.createElement(CardContent, { className: "flex flex-col gap-5" },
                React.createElement("div", { className: "flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-3" },
                    React.createElement(Switch, { id: "user-creator-quick-mode", checked: quickMode, onCheckedChange: (v) => {
                            setQuickMode(Boolean(v));
                            setSubmitError(null);
                        }, "aria-label": "Quick mode \u2014 pick role and count, everything else auto-generated", className: "mt-0.5" }),
                    React.createElement("div", { className: "flex flex-1 flex-col gap-0.5" },
                        React.createElement(Label, { htmlFor: "user-creator-quick-mode", className: "flex cursor-pointer items-center gap-1.5 text-sm font-medium" },
                            React.createElement(Zap, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                            "Quick mode \u2014 Role + Count only"),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Operator picks a role and how many users to create; UPNs, display names, passwords, domain, and all other attributes auto-generated from the role preset and a built-in name pool. Turn off for full per-field control."))),
                quickMode && (React.createElement("div", { className: "flex flex-col gap-4" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-2 text-2xs text-muted-foreground" },
                        React.createElement(Building2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        React.createElement("span", null,
                            "Tenant",
                            " ",
                            React.createElement("code", { className: "font-mono text-foreground" }, truncateMiddle(account.tenantId))),
                        React.createElement("span", null, "\u00B7"),
                        React.createElement("span", null,
                            "Domain",
                            " ",
                            domainsLoading ? (React.createElement("span", { className: "inline-flex items-center gap-1" },
                                React.createElement(Loader2, { className: "h-3 w-3 animate-spin" }),
                                "loading\u2026")) : selectedDomain ? (React.createElement("code", { className: "font-mono text-foreground" }, selectedDomain)) : (React.createElement("span", { className: "text-warning" }, "no verified domain"))),
                        domains.length > 1 && (React.createElement(Select, { value: selectedDomain, onValueChange: setSelectedDomain },
                            React.createElement(SelectTrigger, { className: "ml-auto h-7 w-44 text-2xs", "aria-label": "Switch domain" },
                                React.createElement(SelectValue, { placeholder: "Switch domain" })),
                            React.createElement(SelectContent, null, domains.map((d) => (React.createElement(SelectItem, { key: d.name, value: d.name },
                                d.name,
                                d.isDefault ? " (default)" : ""))))))),
                    React.createElement("div", { className: "grid grid-cols-1 gap-4 sm:grid-cols-3" },
                        React.createElement("div", { className: "flex flex-col gap-1.5 sm:col-span-2" },
                            React.createElement(Label, { htmlFor: "user-creator-quick-role", className: "text-xs font-medium" }, "Role"),
                            React.createElement(Select, { value: presetKey || PRESETS[0].key, onValueChange: handlePresetChange },
                                React.createElement(SelectTrigger, { id: "user-creator-quick-role", "aria-label": "Select role" },
                                    React.createElement(SelectValue, { placeholder: "Choose a role" })),
                                React.createElement(SelectContent, null, PRESETS.map((p) => (React.createElement(SelectItem, { key: p.key, value: p.key },
                                    React.createElement("span", { className: "flex flex-col" },
                                        React.createElement("span", { className: "text-sm" }, p.label),
                                        React.createElement("span", { className: "text-2xs text-muted-foreground" }, p.description))))))),
                            React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Determines job title, department, usage location, force-change-password, and account-enabled defaults.")),
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { htmlFor: "user-creator-quick-count", className: cn("text-xs font-medium", csvMode && "text-muted-foreground") },
                                "How many users",
                                csvMode ? " (from CSV)" : ""),
                            React.createElement(Input, { id: "user-creator-quick-count", type: "number", min: QUICK_COUNT_MIN, max: QUICK_COUNT_MAX, step: 1, value: csvMode ? batchPreview.length : count, disabled: csvMode, onChange: (e) => {
                                    const v = Number(e.target.value);
                                    if (Number.isFinite(v)) {
                                        setCount(Math.max(QUICK_COUNT_MIN, Math.min(QUICK_COUNT_MAX, Math.floor(v))));
                                    }
                                }, "aria-label": "Number of users to create", "aria-describedby": "user-creator-quick-count-help", className: "font-mono" }),
                            React.createElement("p", { id: "user-creator-quick-count-help", className: "text-2xs text-muted-foreground" }, csvMode
                                ? `Derived from pasted CSV (${batchPreview.length} valid row${batchPreview.length === 1 ? "" : "s"}).`
                                : `${QUICK_COUNT_MIN}–${QUICK_COUNT_MAX}.`))),
                    React.createElement("div", { className: "flex items-start gap-3 rounded-md border border-border p-3" },
                        React.createElement(Switch, { id: "user-creator-quick-auto-login", checked: autoLoginEnabled, onCheckedChange: (v) => setAutoLoginEnabled(Boolean(v)), "aria-label": "Auto-launch sign-in window after single create", className: "mt-0.5", disabled: count > 1 }),
                        React.createElement("div", { className: "flex flex-1 flex-col gap-0.5" },
                            React.createElement(Label, { htmlFor: "user-creator-quick-auto-login", className: cn("flex cursor-pointer items-center gap-1.5 text-sm font-medium", count > 1 && "text-muted-foreground") },
                                React.createElement(Zap, { className: cn("h-3.5 w-3.5", count > 1 ? "text-muted-foreground" : "text-primary"), "aria-hidden": true }),
                                "Auto sign-in to WebUI as the new user"),
                            React.createElement("p", { className: "text-2xs text-muted-foreground" }, count > 1
                                ? "Disabled for batch creation — popping up N MSAL popups in a row is hostile. Sign in to each new user one at a time from the \"Created by me\" tab."
                                : "MSAL popup against the new user's tenant; on success the new account becomes the active WebUI session. Portal session is a separate manual button on the success card."))),
                    React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-card/60 p-3" },
                        React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-xs font-medium" },
                            React.createElement(BadgeCheck, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                            React.createElement("span", null, "Saved templates"),
                            React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                "(",
                                savedTemplates.length,
                                ")"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "ml-auto", disabled: bulkSubmitting || !activePresetForQuick, onClick: () => {
                                    const name = window.prompt(`Save current settings as a template?\n\nPreset: ${activePresetForQuick.label}\nCount: ${count}\n\nEnter a name:`, `${activePresetForQuick.label} ×${count}`);
                                    if (!name || !name.trim())
                                        return;
                                    const tpl = {
                                        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                                        name: name.trim().slice(0, 60),
                                        presetKey: activePresetForQuick.key,
                                        displayNamePattern: "",
                                        redirectUrl: "",
                                        count: Math.max(QUICK_COUNT_MIN, Math.min(QUICK_COUNT_MAX, Math.floor(count) || 1)),
                                        createdAt: new Date().toISOString(),
                                    };
                                    setSavedTemplates((prev) => [tpl, ...prev].slice(0, 20));
                                }, "aria-label": "Save current settings as a template", title: "Save the current preset + count combo for one-click re-apply" },
                                React.createElement(Sparkles, null),
                                "Save current")),
                        savedTemplates.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "No saved templates yet. Click \u201CSave current\u201D to capture the current preset + count for later.")) : (React.createElement("div", { className: "flex flex-wrap gap-1.5" }, savedTemplates.map((tpl) => (React.createElement("div", { key: tpl.id, className: "flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-2xs" },
                            React.createElement("button", { type: "button", onClick: () => {
                                    handlePresetChange(tpl.presetKey);
                                    setCount(tpl.count);
                                    setBatchSeed((s) => s + 1);
                                }, disabled: bulkSubmitting, className: "font-medium text-foreground hover:text-primary", "aria-label": `Apply template ${tpl.name}`, title: `Apply preset ${tpl.presetKey} × ${tpl.count}` }, tpl.name),
                            React.createElement("span", { className: "text-muted-foreground" },
                                "\u00D7",
                                tpl.count),
                            React.createElement("button", { type: "button", onClick: () => {
                                    setSavedTemplates((prev) => prev.filter((t) => t.id !== tpl.id));
                                }, disabled: bulkSubmitting, "aria-label": `Delete template ${tpl.name}`, title: "Delete template", className: "text-muted-foreground hover:text-destructive" },
                                React.createElement(X, { className: "h-3 w-3" })))))))),
                    React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-card/60 p-3" },
                        React.createElement("div", { className: "flex items-start gap-3" },
                            React.createElement(Switch, { id: "user-creator-csv-mode", checked: csvMode, onCheckedChange: (v) => {
                                    setCsvMode(Boolean(v));
                                    setSubmitError(null);
                                }, "aria-label": "CSV-paste mode", className: "mt-0.5", disabled: bulkSubmitting }),
                            React.createElement("div", { className: "flex flex-1 flex-col gap-0.5" },
                                React.createElement(Label, { htmlFor: "user-creator-csv-mode", className: "flex cursor-pointer items-center gap-1.5 text-sm font-medium" },
                                    React.createElement(FileJson, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                                    "CSV-paste mode (operator-supplied UPN list)"),
                                React.createElement("p", { className: "text-2xs text-muted-foreground" },
                                    "Override synthesized names with a pasted CSV. Format:",
                                    " ",
                                    React.createElement("code", { className: "font-mono" }, "prefix,displayName,jobTitle,department"),
                                    ". Header row optional. Passwords + force-change still come from the active preset."))),
                        csvMode && (React.createElement(React.Fragment, null,
                            React.createElement("textarea", { value: csvText, onChange: (ev) => {
                                    setCsvText(ev.target.value);
                                    setSubmitError(null);
                                }, placeholder: "# prefix,displayName,jobTitle,department\nalex.doe,Alex Doe,Engineer,Platform\njamie.lee,Jamie Lee,Auditor,Compliance", rows: 6, "aria-label": "CSV rows", className: "w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-2xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", disabled: bulkSubmitting }),
                            csvError && (React.createElement(Alert, { variant: "warning", className: "text-2xs" },
                                React.createElement(AlertCircle, { className: "h-3.5 w-3.5" }),
                                React.createElement(AlertDescription, null, csvError)))))),
                    React.createElement("div", { className: "flex flex-col gap-1.5 rounded-md border border-border bg-card/60 p-3" },
                        React.createElement(Label, { htmlFor: "user-creator-naming-convention", className: "flex items-center gap-1.5 text-xs font-medium" },
                            React.createElement(ShieldCheck, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                            "Naming-convention regex (optional)",
                            namingConvention && (React.createElement(Badge, { variant: compiledNamingRegex.error
                                    ? "destructive"
                                    : batchNamingFails.size > 0
                                        ? "warning"
                                        : "success", className: "ml-1 text-2xs" }, compiledNamingRegex.error
                                ? "invalid regex"
                                : batchNamingFails.size > 0
                                    ? `${batchNamingFails.size} fail`
                                    : "all pass"))),
                        React.createElement("div", { className: "flex gap-1.5" },
                            React.createElement(Input, { id: "user-creator-naming-convention", type: "text", value: namingConvention, onChange: (ev) => setNamingConvention(ev.target.value), placeholder: "e.g. ^[a-z]+\\.[a-z]+\\.[a-z0-9]{4}$", "aria-label": "Naming convention regex", "aria-describedby": "user-creator-naming-help", className: "h-8 font-mono text-2xs", disabled: bulkSubmitting }),
                            namingConvention && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setNamingConvention(""), disabled: bulkSubmitting, "aria-label": "Clear naming convention", title: "Disable the naming-convention gate", className: "h-8 px-2" },
                                React.createElement(X, null)))),
                        React.createElement("p", { id: "user-creator-naming-help", className: cn("text-2xs", compiledNamingRegex.error
                                ? "text-destructive"
                                : "text-muted-foreground") }, compiledNamingRegex.error
                            ? `Regex parse error: ${compiledNamingRegex.error} — gate disabled.`
                            : namingConvention
                                ? `Blocks any UPN prefix that doesn't match. Persisted per-browser.`
                                : `Empty = no gate. Set a regex like ^[a-z]+\\.[a-z]+\\.[a-z0-9]{4}$ to enforce a UPN shape.`)),
                    batchPreview.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-info/30 bg-info/5 px-3 py-2 text-2xs" },
                        React.createElement(ShieldAlert, { className: "h-3.5 w-3.5 text-info", "aria-hidden": true }),
                        React.createElement("span", { className: "font-medium text-foreground" }, "Audit-event preview"),
                        React.createElement("span", { className: "text-muted-foreground" }, "\u00B7"),
                        React.createElement("span", null,
                            React.createElement("strong", { className: "text-foreground tabular-nums" }, auditPreview.createUser),
                            " ",
                            React.createElement("code", { className: "font-mono" }, "create_user")),
                        React.createElement("span", null,
                            React.createElement("strong", { className: "text-foreground tabular-nums" }, auditPreview.vaultPut),
                            " ",
                            React.createElement("code", { className: "font-mono" }, "vault_put")),
                        auditPreview.autoLogin > 0 && (React.createElement("span", null,
                            React.createElement("strong", { className: "text-foreground tabular-nums" }, auditPreview.autoLogin),
                            " ",
                            React.createElement("code", { className: "font-mono" }, "webui_auto_login"))),
                        auditPreview.forceChangePassword > 0 && (React.createElement("span", { className: "text-muted-foreground" },
                            "\u00B7 ",
                            auditPreview.forceChangePassword,
                            " forced-reset")),
                        auditPreview.suspiciousNames > 0 && (React.createElement(Badge, { variant: "warning", className: "ml-auto text-2xs" },
                            auditPreview.suspiciousNames,
                            " deceptive-name")),
                        React.createElement("button", { type: "button", onClick: () => setDebugPreview((v) => !v), className: "ml-auto underline underline-offset-2 hover:no-underline", "aria-label": "Toggle debug JSON preview", title: "Hotkey: d" },
                            debugPreview ? "hide" : "show",
                            " JSON (press d)"))),
                    React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-card/60 p-3" },
                        React.createElement("div", { className: "flex items-center gap-2 text-xs font-medium" },
                            React.createElement(Sparkles, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                            "Preview (",
                            batchPreview.length,
                            " ",
                            batchPreview.length === 1 ? "user" : "users",
                            ")",
                            Object.keys(batchSuspicious).length > 0 && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                                Object.keys(batchSuspicious).length,
                                " deceptive")),
                            batchNamingFails.size > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                                batchNamingFails.size,
                                " convention fail")),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "ml-auto", onClick: () => setBatchSeed((s) => s + 1), "aria-label": "Generate new names", disabled: bulkSubmitting },
                                React.createElement(Wand2, null),
                                "Generate new names")),
                        batchPreview.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, !selectedDomain
                            ? "Waiting for a verified domain to be selected."
                            : "No preview yet.")) : (React.createElement("ul", { className: "flex flex-col gap-1 max-h-64 overflow-auto" }, batchPreview.map((p) => {
                            const suspicious = batchSuspicious[p.upn];
                            const fails = batchNamingFails.has(p.upn);
                            return (React.createElement("li", { key: p.upn, className: cn("flex flex-wrap items-center gap-2 rounded px-1 py-0.5 text-2xs", fails &&
                                    "border border-destructive/40 bg-destructive/10", !fails &&
                                    suspicious &&
                                    "border border-warning/40 bg-warning/5"), title: fails
                                    ? `Does not match naming convention /${namingConvention}/`
                                    : suspicious
                                        ? `Deceptive-name pattern (${suspicious.category}): ${suspicious.hint}`
                                        : undefined },
                                fails ? (React.createElement(X, { className: "h-3 w-3 text-destructive", "aria-label": "Convention fail" })) : suspicious ? (React.createElement(ShieldAlert, { className: "h-3 w-3 text-warning", "aria-label": "Deceptive name pattern" })) : (React.createElement(BadgeCheck, { className: "h-3 w-3 text-success", "aria-hidden": true })),
                                React.createElement("code", { className: "font-mono text-foreground" }, p.upn),
                                React.createElement("span", { className: "text-muted-foreground" },
                                    "\u00B7 ",
                                    p.displayName),
                                suspicious && !fails && (React.createElement(Badge, { variant: "warning", className: "text-2xs" }, suspicious.category)),
                                React.createElement("span", { className: "ml-auto text-muted-foreground" },
                                    p.jobTitle,
                                    " \u00B7 ",
                                    p.department)));
                        })))),
                    debugPreview && batchPreview.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1 rounded-md border border-primary/30 bg-primary/5 p-3" },
                        React.createElement("div", { className: "flex items-center gap-1.5 text-xs font-medium" },
                            React.createElement(FileJson, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                            "Debug JSON preview",
                            React.createElement("span", { className: "text-2xs text-muted-foreground" }, "(sanitized \u2014 passwords redacted)"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "ml-auto", onClick: () => __awaiter(void 0, void 0, void 0, function* () {
                                    const ok = yield tryWriteClipboard(debugPreviewJson);
                                    store.addNotification({
                                        type: ok ? "info" : "error",
                                        message: ok
                                            ? "Debug JSON copied to clipboard."
                                            : "Clipboard blocked by the browser.",
                                    });
                                }), "aria-label": "Copy debug JSON" },
                                React.createElement(Copy, null),
                                "Copy"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setDebugPreview(false), "aria-label": "Hide debug preview" },
                                React.createElement(X, null))),
                        React.createElement("pre", { className: "max-h-72 overflow-auto rounded bg-background px-2 py-1.5 font-mono text-2xs text-foreground" }, debugPreviewJson))),
                    bulkProgress && (React.createElement(Alert, { role: "status", "aria-live": "polite", "aria-atomic": "true" },
                        React.createElement(Loader2, { className: "h-4 w-4 animate-spin" }),
                        React.createElement(AlertDescription, null,
                            "Creating ",
                            bulkProgress.done + 1,
                            " of ",
                            bulkProgress.total,
                            bulkProgress.current ? ` — ${bulkProgress.current}` : "",
                            "\u2026"))),
                    React.createElement("div", { className: "flex items-center justify-end gap-2" },
                        React.createElement("span", { className: "text-2xs text-muted-foreground" },
                            "Hotkeys:",
                            " ",
                            React.createElement("kbd", { className: "rounded border border-border bg-card px-1 font-mono" }, "Ctrl+Enter"),
                            " ",
                            "submit \u00B7",
                            " ",
                            React.createElement("kbd", { className: "rounded border border-border bg-card px-1 font-mono" }, "Esc"),
                            " ",
                            "clear errors \u00B7",
                            " ",
                            React.createElement("kbd", { className: "rounded border border-border bg-card px-1 font-mono" }, "d"),
                            " ",
                            "toggle JSON"),
                        React.createElement(Button, { type: "button", variant: "default", onClick: () => {
                                // Bulk → require confirm dialog. Single → fire directly
                                // (low-risk happy path; the auto-login flow is the
                                // surfacing UX for the operator).
                                if (batchPreview.length > BULK_CONFIRM_THRESHOLD) {
                                    setBulkConfirmOpen(true);
                                }
                                else {
                                    void handleQuickSubmit();
                                }
                            }, disabled: !quickValid, "aria-label": `Create ${batchPreview.length || count} user${(batchPreview.length || count) === 1 ? "" : "s"} (Ctrl+Enter)`, title: batchNamingFails.size > 0
                                ? `${batchNamingFails.size} row${batchNamingFails.size === 1 ? "" : "s"} fail the naming-convention regex — fix or clear the regex.`
                                : "Ctrl+Enter to submit" },
                            bulkSubmitting ? (React.createElement(Loader2, { className: "animate-spin" })) : (React.createElement(UserPlus, null)),
                            "Create ",
                            batchPreview.length || count,
                            " ",
                            (batchPreview.length || count) === 1 ? "user" : "users")))),
                !quickMode && (React.createElement(React.Fragment, null,
                    React.createElement(FormSection, { icon: Building2, title: "Tenant & Domain", description: "Auto-derived from the selected privileged account." },
                        React.createElement("div", { className: "grid grid-cols-1 gap-4 sm:grid-cols-2" },
                            React.createElement("div", { className: "flex flex-col gap-1" },
                                React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Tenant ID"),
                                React.createElement("div", { className: "flex items-center gap-1.5" },
                                    React.createElement("code", { className: "flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs text-foreground" }, account.tenantId),
                                    React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: handleCopyTenant, "aria-label": "Copy tenant ID", title: "Copy tenant ID" },
                                        React.createElement(Copy, null)))),
                            React.createElement("div", { className: "flex flex-col gap-1" },
                                React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Source account"),
                                React.createElement("span", { className: "truncate rounded bg-background px-2 py-1 font-mono text-xs text-foreground" }, account.username || account.name)),
                            React.createElement("div", { className: "flex flex-col gap-1 sm:col-span-2" },
                                React.createElement(Label, { htmlFor: "user-creator-domain", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Domain"),
                                domainsLoading ? (React.createElement("div", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                                    React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin" }),
                                    "Loading domains...")) : domainsError ? (React.createElement(Alert, { variant: "destructive" },
                                    React.createElement(AlertCircle, { className: "h-4 w-4" }),
                                    React.createElement(AlertDescription, null, domainsError))) : domains.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No verified domains available for this tenant.")) : (React.createElement(Select, { value: selectedDomain, onValueChange: setSelectedDomain },
                                    React.createElement(SelectTrigger, { id: "user-creator-domain", "aria-label": "Select domain" },
                                        React.createElement(SelectValue, { placeholder: "Select a domain" })),
                                    React.createElement(SelectContent, null, domains.map((d) => (React.createElement(SelectItem, { key: d.name, value: d.name },
                                        React.createElement("span", { className: "flex items-center gap-1.5" },
                                            React.createElement("span", null, d.name),
                                            d.isDefault && (React.createElement(Badge, { variant: "info", className: "text-2xs" }, "default")),
                                            d.isInitial && !d.isDefault && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, "initial")))))))))))),
                    React.createElement(FormSection, { icon: IdCard, title: "Identity", description: "UPN, display name, and personal attributes." },
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { htmlFor: "user-creator-preset" }, "Preset"),
                            React.createElement(Select, { value: presetKey, onValueChange: handlePresetChange },
                                React.createElement(SelectTrigger, { id: "user-creator-preset", "aria-label": "Select attribute preset" },
                                    React.createElement(SelectValue, { placeholder: "Choose a preset to pre-fill attributes" })),
                                React.createElement(SelectContent, null, PRESETS.map((p) => (React.createElement(SelectItem, { key: p.key, value: p.key },
                                    React.createElement("span", { className: "flex flex-col" },
                                        React.createElement("span", { className: "text-sm" }, p.label),
                                        React.createElement("span", { className: "text-2xs text-muted-foreground" }, p.description))))))),
                            activePreset && (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Preset applied. You can still edit any field below."))),
                        React.createElement("div", { className: "grid grid-cols-1 gap-4 sm:grid-cols-2" },
                            React.createElement("div", { className: "flex flex-col gap-1.5 sm:col-span-2" },
                                React.createElement(Label, { htmlFor: "user-creator-prefix" }, "User ID (UPN prefix)"),
                                React.createElement("div", { className: "relative" },
                                    React.createElement(AtSign, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                                    React.createElement(Input, { id: "user-creator-prefix", type: "text", autoComplete: "off", value: prefix, onChange: (e) => {
                                            setPrefix(e.target.value);
                                            setSubmitError(null);
                                        }, className: "pl-8 pr-9 font-mono", "aria-invalid": prefix.length > 0 && !prefixValid ? true : undefined, "aria-describedby": "user-creator-prefix-help", placeholder: "alex.doe", required: true }),
                                    React.createElement("div", { className: "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2", "aria-live": "polite" },
                                        availability.status === "checking" && (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin text-muted-foreground", "aria-label": "Checking availability" })),
                                        availability.status === "available" && (React.createElement(Check, { className: "h-3.5 w-3.5 text-success", "aria-label": "Available" })),
                                        availability.status === "taken" && (React.createElement(X, { className: "h-3.5 w-3.5 text-destructive", "aria-label": "Already taken" })),
                                        availability.status === "error" && (React.createElement(AlertCircle, { className: "h-3.5 w-3.5 text-warning", "aria-label": "Probe failed" })))),
                                React.createElement("p", { id: "user-creator-prefix-help", className: cn("text-2xs", prefix.length > 0 && fieldErrors.prefix
                                        ? "text-destructive"
                                        : availability.status === "taken"
                                            ? "text-destructive"
                                            : availability.status === "available"
                                                ? "text-success"
                                                : availability.status === "error"
                                                    ? "text-warning"
                                                    : "text-muted-foreground") }, prefix.length > 0 && fieldErrors.prefix
                                    ? fieldErrors.prefix
                                    : availability.status === "checking"
                                        ? "Checking availability..."
                                        : availability.status === "available"
                                            ? `Available — ${upn}`
                                            : availability.status === "taken"
                                                ? `Already taken — ${upn} exists in this tenant.`
                                                : availability.status === "error"
                                                    ? `Could not verify availability: ${availability.message}`
                                                    : upn
                                                        ? `Full UPN: ${upn}`
                                                        : "Letters, numbers, dot, dash, or underscore. Max 40 characters."),
                                prefix.length > 0 && suspiciousPrefix && (React.createElement("p", { className: "flex items-start gap-1.5 text-2xs text-warning", role: "status" },
                                    React.createElement(ShieldAlert, { className: "mt-0.5 h-3 w-3 shrink-0", "aria-hidden": true }),
                                    React.createElement("span", null,
                                        "Deceptive-name pattern (",
                                        React.createElement("strong", null, suspiciousPrefix.category),
                                        "):",
                                        " ",
                                        suspiciousPrefix.hint,
                                        " Not blocked \u2014 but the SOC will see a generic ",
                                        React.createElement("code", { className: "font-mono" }, "Add user"),
                                        " ",
                                        "audit event with the shape you typed."))),
                                prefix.length > 0 && !namingConventionOk && (React.createElement("p", { className: "flex items-start gap-1.5 text-2xs text-destructive", role: "status" },
                                    React.createElement(X, { className: "mt-0.5 h-3 w-3 shrink-0", "aria-hidden": true }),
                                    React.createElement("span", null,
                                        "Does not match naming convention",
                                        " ",
                                        React.createElement("code", { className: "font-mono" },
                                            "/",
                                            namingConvention,
                                            "/"),
                                        " ",
                                        "(set in Quick mode > Naming-convention regex).")))),
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement(Label, { htmlFor: "user-creator-display" }, "Display Name"),
                                React.createElement(Input, { id: "user-creator-display", type: "text", value: displayName, onChange: (e) => {
                                        setDisplayName(e.target.value);
                                        setDisplayNameTouched(true);
                                        setSubmitError(null);
                                    }, "aria-required": true, "aria-invalid": displayNameTouched && fieldErrors.displayName
                                        ? true
                                        : undefined, placeholder: "Alex Doe", required: true }),
                                displayNameTouched && fieldErrors.displayName && (React.createElement("p", { className: "text-2xs text-destructive" }, fieldErrors.displayName))),
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement(Label, { htmlFor: "user-creator-given" }, "Given Name"),
                                React.createElement(Input, { id: "user-creator-given", type: "text", value: givenName, onChange: (e) => {
                                        setGivenName(e.target.value);
                                        setGivenNameTouched(true);
                                    }, placeholder: "Alex" })),
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement(Label, { htmlFor: "user-creator-surname" }, "Surname"),
                                React.createElement(Input, { id: "user-creator-surname", type: "text", value: surname, onChange: (e) => {
                                        setSurname(e.target.value);
                                        setSurnameTouched(true);
                                    }, placeholder: "Doe" })),
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement(Label, { htmlFor: "user-creator-jobtitle" }, "Job Title"),
                                React.createElement(Input, { id: "user-creator-jobtitle", type: "text", value: jobTitle, onChange: (e) => setJobTitle(e.target.value), placeholder: "Engineer" })),
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement(Label, { htmlFor: "user-creator-department" }, "Department"),
                                React.createElement(Input, { id: "user-creator-department", type: "text", value: department, onChange: (e) => setDepartment(e.target.value), placeholder: "Platform" })),
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement(Label, { htmlFor: "user-creator-usage" }, "Usage Location"),
                                React.createElement(Select, { value: usageLocation, onValueChange: setUsageLocation },
                                    React.createElement(SelectTrigger, { id: "user-creator-usage", "aria-label": "Select usage location" },
                                        React.createElement(SelectValue, { placeholder: "Select usage location" })),
                                    React.createElement(SelectContent, null, USAGE_LOCATIONS.map((u) => (React.createElement(SelectItem, { key: u.code, value: u.code }, u.label)))))))),
                    React.createElement(FormSection, { icon: KeyRound, title: "Credentials & Activation", description: "Initial password, forced reset, and account activation." },
                        React.createElement("div", { className: "grid grid-cols-1 gap-4 sm:grid-cols-2" },
                            React.createElement("div", { className: "flex flex-col gap-1.5 sm:col-span-2" },
                                React.createElement(Label, { htmlFor: "user-creator-password" }, "Initial Password"),
                                React.createElement("div", { className: "relative" },
                                    React.createElement(Input, { id: "user-creator-password", type: showPassword ? "text" : "password", autoComplete: "new-password", value: password, onChange: (e) => {
                                            setPassword(e.target.value);
                                            setSubmitError(null);
                                        }, className: "pr-20 font-mono", "aria-invalid": password.length > 0 && fieldErrors.password
                                            ? true
                                            : undefined, "aria-describedby": "user-creator-password-help" }),
                                    React.createElement("div", { className: "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1" },
                                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => setShowPassword((p) => !p), "aria-label": showPassword ? "Hide password" : "Show password", "aria-pressed": showPassword }, showPassword ? React.createElement(EyeOff, null) : React.createElement(Eye, null)),
                                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: handleGeneratePassword, "aria-label": "Generate random password", title: "Generate random password" },
                                            React.createElement(Wand2, null)))),
                                React.createElement("p", { id: "user-creator-password-help", className: cn("text-2xs", password.length > 0 && fieldErrors.password
                                        ? "text-destructive"
                                        : "text-muted-foreground") }, password.length > 0 && fieldErrors.password
                                    ? fieldErrors.password
                                    : `Minimum ${MIN_PASSWORD_LENGTH} characters. Use the wand to generate one.`)),
                            React.createElement("label", { className: "flex cursor-pointer items-center gap-2 text-sm text-foreground sm:col-span-2" },
                                React.createElement(Checkbox, { checked: forceChange, onCheckedChange: (v) => setForceChange(Boolean(v)), "aria-label": "Force user to change password at next sign-in" }),
                                React.createElement("span", null, "Force user to change password at next sign-in")),
                            React.createElement("div", { className: "flex items-center gap-3 sm:col-span-2" },
                                React.createElement(Switch, { id: "user-creator-enabled", checked: accountEnabled, onCheckedChange: (v) => setAccountEnabled(Boolean(v)), "aria-label": "Account enabled" }),
                                React.createElement(Label, { htmlFor: "user-creator-enabled", className: "cursor-pointer text-sm" }, "Account enabled")),
                            React.createElement("div", { className: "flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 sm:col-span-2" },
                                React.createElement(Switch, { id: "user-creator-auto-login", checked: autoLoginEnabled, onCheckedChange: (v) => setAutoLoginEnabled(Boolean(v)), "aria-label": "Auto-launch sign-in window after creation", className: "mt-0.5" }),
                                React.createElement("div", { className: "flex flex-1 flex-col gap-0.5" },
                                    React.createElement(Label, { htmlFor: "user-creator-auto-login", className: "flex cursor-pointer items-center gap-1.5 text-sm font-medium" },
                                        React.createElement(Zap, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                                        "Auto sign-in to WebUI as the new user"),
                                    React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Opens an MSAL popup against the new user's tenant; on success the new account becomes the active WebUI session. Use the \u201COpen portal session\u201D button on the success card if you also want a portal.azure.com browser window."))))))),
                submitError && (React.createElement(Alert, { variant: "destructive", role: "alert", "aria-live": "assertive", "aria-atomic": "true" },
                    React.createElement(AlertCircle, { className: "h-4 w-4" }),
                    React.createElement(AlertDescription, null, submitError))),
                !quickMode && submitting && (React.createElement(Alert, null,
                    React.createElement(Loader2, { className: "h-4 w-4 animate-spin" }),
                    React.createElement(AlertDescription, null,
                        "Creating user ",
                        upn,
                        "..."))),
                lastCreated && account && (React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", "aria-label": `User ${lastCreated.upn} created successfully in tenant ${account.tenantId}.${lastCreated.mustChangePassword ? " Must change password on first sign-in." : ""}`, className: "flex flex-col gap-2 rounded-md border border-success/40 bg-success/10 p-4 transition-colors duration-200 ease-out motion-reduce:transition-none" },
                    React.createElement("div", { className: "flex items-center gap-2 text-sm font-semibold text-success" },
                        React.createElement(PartyPopper, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement("span", null, "User created"),
                        React.createElement(Sparkles, { className: "h-3.5 w-3.5 opacity-70", "aria-hidden": true }),
                        autoLoginInflight && (React.createElement("span", { className: "ml-auto flex items-center gap-1 text-2xs font-normal text-muted-foreground" },
                            React.createElement(Loader2, { className: "h-3 w-3 animate-spin", "aria-hidden": true }),
                            "Launching sign-in window\u2026"))),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-xs text-foreground" },
                        React.createElement(BadgeCheck, { className: "h-4 w-4 text-success", "aria-hidden": true }),
                        React.createElement("span", null,
                            React.createElement("strong", { className: "font-mono" }, lastCreated.upn),
                            " is ready.",
                            " ",
                            autoLoginEnabled
                                ? "MSAL popup launched automatically — retry or open a portal session below:"
                                : "Auto sign-in is off; pick how you want to authenticate:"),
                        React.createElement(Button, { type: "button", variant: "default", size: "sm", disabled: autoLoginInflight, onClick: () => __awaiter(void 0, void 0, void 0, function* () {
                                var _d;
                                if (!lastCreated || !account)
                                    return;
                                setAutoLoginInflight(true);
                                store.addNotification({
                                    type: "info",
                                    message: lastCreated.mustChangePassword
                                        ? `Auto-filling sign-in for ${lastCreated.upn} (will set a fresh password during reset)…`
                                        : `Auto-filling sign-in for ${lastCreated.upn}…`,
                                });
                                const actor = account.username || account.name || account.homeAccountId;
                                const newPassword = lastCreated.mustChangePassword
                                    ? generateRandomPassword()
                                    : undefined;
                                const res = yield launchPortalAutoLogin({
                                    upn: lastCreated.upn,
                                    password: lastCreated.password,
                                    tenantId: account.tenantId,
                                    mustChangePassword: lastCreated.mustChangePassword,
                                    newPassword,
                                    target: "webui",
                                    webuiUrl: typeof window !== "undefined"
                                        ? window.location.origin + "/"
                                        : undefined,
                                });
                                setAutoLoginInflight(false);
                                if (res.ok) {
                                    // If we set a fresh password during the change-
                                    // password flow, persist it to the vault and clear
                                    // the must-change flag so future sign-ins skip the
                                    // reset prompt entirely. Note the original temp
                                    // password is now invalid on Azure's side; the
                                    // vault is the source of truth.
                                    if (newPassword) {
                                        try {
                                            yield credentialVault.put({
                                                upn: lastCreated.upn,
                                                password: newPassword,
                                                tenantId: account.tenantId,
                                                homeAccountId: account.homeAccountId,
                                                createdAt: new Date().toISOString(),
                                                source: "create",
                                                mustChangePassword: false,
                                            });
                                            auditLog.record({
                                                actor,
                                                action: "vault_put",
                                                target: lastCreated.upn,
                                                status: "success",
                                                details: {
                                                    tenantId: account.tenantId,
                                                    reason: "success-card-change-pw-patch",
                                                },
                                            });
                                            // Update local state so the success card
                                            // reflects the new password if the operator
                                            // hits the button again.
                                            setLastCreated({
                                                upn: lastCreated.upn,
                                                password: newPassword,
                                                mustChangePassword: false,
                                            });
                                        }
                                        catch (vaultErr) {
                                            const vmsg = vaultErr instanceof Error
                                                ? vaultErr.message
                                                : String(vaultErr);
                                            console.warn("[user-creator] vault patch failed after auto change-password", vaultErr);
                                            auditLog.record({
                                                actor,
                                                action: "vault_put",
                                                target: lastCreated.upn,
                                                status: "failure",
                                                error: vmsg,
                                                details: {
                                                    tenantId: account.tenantId,
                                                    reason: "success-card-change-pw-patch",
                                                },
                                            });
                                        }
                                    }
                                    store.addNotification({
                                        type: "success",
                                        message: newPassword
                                            ? `Signed in as ${lastCreated.upn} with a fresh password. Vault updated.`
                                            : `Signed in to WebUI as ${lastCreated.upn} in a new browser window.`,
                                    });
                                    auditLog.record({
                                        actor,
                                        action: "webui_auto_login",
                                        target: lastCreated.upn,
                                        status: "success",
                                        details: {
                                            tenantId: account.tenantId,
                                            mustChangePassword: !!lastCreated.mustChangePassword,
                                            newPasswordSet: !!newPassword,
                                        },
                                    });
                                }
                                else {
                                    store.addNotification({
                                        type: "error",
                                        message: `Auto sign-in failed for ${lastCreated.upn}: ${(_d = res.error) !== null && _d !== void 0 ? _d : "unknown error"}. Use "MSAL popup (manual)" below to sign in by typing the password yourself.`,
                                    });
                                    auditLog.record({
                                        actor,
                                        action: "webui_auto_login",
                                        target: lastCreated.upn,
                                        status: "failure",
                                        error: res.error,
                                        details: {
                                            tenantId: account.tenantId,
                                            mustChangePassword: !!lastCreated.mustChangePassword,
                                            status: res.status,
                                        },
                                    });
                                }
                            }), "aria-label": `Auto sign-in to WebUI as ${lastCreated.upn}`, title: "Opens a Chromium window via Playwright, fills email + password, and walks the must-change-password form if needed. Resulting browser is signed into this WebUI as the new user." },
                            autoLoginInflight ? (React.createElement(Loader2, { className: "animate-spin" })) : (React.createElement(LogIn, null)),
                            lastCreated.mustChangePassword
                                ? "Auto sign-in (fills + resets password)"
                                : "Auto sign-in to WebUI"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", disabled: autoLoginInflight, onClick: () => __awaiter(void 0, void 0, void 0, function* () {
                                var _e, _f, _g;
                                if (!lastCreated || !account)
                                    return;
                                setAutoLoginInflight(true);
                                store.addNotification({
                                    type: "info",
                                    message: `Opening MSAL popup for ${lastCreated.upn}…`,
                                });
                                const actor = account.username || account.name || account.homeAccountId;
                                const ires = yield attemptInteractiveLogin({
                                    upn: lastCreated.upn,
                                    tenantId: account.tenantId,
                                });
                                setAutoLoginInflight(false);
                                if (ires.ok) {
                                    store.addNotification({
                                        type: "success",
                                        message: `Signed in as ${(_f = (_e = ires.account) === null || _e === void 0 ? void 0 : _e.username) !== null && _f !== void 0 ? _f : lastCreated.upn}. WebUI now runs as this user.`,
                                    });
                                    auditLog.record({
                                        actor,
                                        action: "interactive_login",
                                        target: lastCreated.upn,
                                        status: "success",
                                        details: {
                                            tenantId: account.tenantId,
                                            manual: true,
                                            fallback: true,
                                        },
                                    });
                                }
                                else {
                                    store.addNotification({
                                        type: "error",
                                        message: `MSAL sign-in failed for ${lastCreated.upn}: ${(_g = ires.error) !== null && _g !== void 0 ? _g : "unknown error"}.`,
                                    });
                                    auditLog.record({
                                        actor,
                                        action: "interactive_login",
                                        target: lastCreated.upn,
                                        status: "failure",
                                        error: ires.error,
                                        details: {
                                            tenantId: account.tenantId,
                                            manual: true,
                                            fallback: true,
                                        },
                                    });
                                }
                            }), "aria-label": `MSAL popup sign-in as ${lastCreated.upn}`, title: "MSAL popup in this tab \u2014 manual password entry, but signs THIS WebUI tab in as the new user (no separate browser window)" },
                            React.createElement(LogIn, null),
                            "MSAL popup (manual)"),
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", disabled: autoLoginInflight, onClick: () => __awaiter(void 0, void 0, void 0, function* () {
                                var _h;
                                if (!lastCreated || !account)
                                    return;
                                setAutoLoginInflight(true);
                                store.addNotification({
                                    type: "info",
                                    message: `Opening portal session for ${lastCreated.upn}…`,
                                });
                                const actor = account.username || account.name || account.homeAccountId;
                                const res = yield launchPortalAutoLogin({
                                    upn: lastCreated.upn,
                                    password: lastCreated.password,
                                    tenantId: account.tenantId,
                                    mustChangePassword: lastCreated.mustChangePassword,
                                });
                                setAutoLoginInflight(false);
                                if (res.ok) {
                                    store.addNotification({
                                        type: "success",
                                        message: `Portal sign-in window opened for ${lastCreated.upn}.`,
                                    });
                                    auditLog.record({
                                        actor,
                                        action: "portal_auto_login",
                                        target: lastCreated.upn,
                                        status: "success",
                                        details: { tenantId: account.tenantId, manual: true },
                                    });
                                }
                                else {
                                    store.addNotification({
                                        type: "error",
                                        message: `Portal sign-in failed for ${lastCreated.upn}: ${(_h = res.error) !== null && _h !== void 0 ? _h : "unknown error"}. (Portal access can be restricted per-tenant; the WebUI sign-in above works independently.)`,
                                    });
                                    auditLog.record({
                                        actor,
                                        action: "portal_auto_login",
                                        target: lastCreated.upn,
                                        status: "failure",
                                        error: res.error,
                                        details: {
                                            tenantId: account.tenantId,
                                            manual: true,
                                            status: res.status,
                                        },
                                    });
                                }
                            }), "aria-label": `Open portal.azure.com session for ${lastCreated.upn}`, title: "POST /api/portal/auto-login \u2014 opens portal.azure.com in a separate Chromium window. Independent of WebUI session." },
                            React.createElement(ExternalLink, null),
                            "Open portal session"),
                        React.createElement(PortalLoginButton, { upn: lastCreated.upn, tenantId: account.tenantId, homeAccountId: account.homeAccountId, password: lastCreated.password, mustChangePassword: lastCreated.mustChangePassword, size: "sm", variant: "ghost" })))),
                !quickMode && (React.createElement("div", { className: "flex items-center justify-end gap-2" },
                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        "Hotkeys:",
                        " ",
                        React.createElement("kbd", { className: "rounded border border-border bg-card px-1 font-mono" }, "Ctrl+Enter"),
                        " ",
                        "submit \u00B7",
                        " ",
                        React.createElement("kbd", { className: "rounded border border-border bg-card px-1 font-mono" }, "Esc"),
                        " ",
                        "clear errors \u00B7",
                        " ",
                        React.createElement("kbd", { className: "rounded border border-border bg-card px-1 font-mono" }, "d"),
                        " ",
                        "toggle JSON"),
                    React.createElement(TooltipProvider, { delayDuration: 150 },
                        React.createElement(Tooltip, null,
                            React.createElement(TooltipTrigger, { asChild: true },
                                React.createElement("span", { tabIndex: !formValid && !submitting ? 0 : -1 },
                                    React.createElement(Button, { type: "button", variant: "default", onClick: handleSubmitClick, disabled: !formValid || submitting, "aria-label": "Create user (Ctrl+Enter)", title: "Ctrl+Enter to submit", className: "transition-all duration-200 ease-out motion-reduce:transition-none" },
                                        React.createElement(UserPlus, null),
                                        "Create User"))),
                            !formValid && !submitting && (React.createElement(TooltipContent, { side: "top" }, !account
                                ? "Select a privileged account first."
                                : availability.status === "checking"
                                    ? "Checking UPN availability..."
                                    : availability.status === "taken"
                                        ? "This UPN is already taken in the tenant."
                                        : availability.status === "error"
                                            ? "Could not verify UPN availability."
                                            : availability.status !== "available"
                                                ? "Pick a UPN prefix and wait for availability."
                                                : !namingConventionOk
                                                    ? `UPN prefix doesn't match /${namingConvention}/.`
                                                    : !validation.success
                                                        ? "Resolve form errors to continue."
                                                        : "Form not yet valid.")))))))),
        React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: "Create user", message: React.createElement("span", null,
                "Create user ",
                React.createElement("strong", null, upn),
                " in tenant",
                " ",
                React.createElement("code", { className: "font-mono text-xs" }, account.tenantId),
                "?"), confirmText: "Create user", loading: submitting, onConfirm: handleConfirm, onCancel: () => {
                if (!submitting)
                    setConfirmOpen(false);
            } }),
        React.createElement(ConfirmationDialog, { hidden: !bulkConfirmOpen, title: `Create ${batchPreview.length} users`, danger: batchPreview.length >= 10 || auditPreview.suspiciousNames > 0, message: React.createElement("span", { className: "flex flex-col gap-2" },
                React.createElement("span", null,
                    "About to provision ",
                    React.createElement("strong", null, batchPreview.length),
                    " users in tenant",
                    " ",
                    React.createElement("code", { className: "font-mono text-xs" }, account.tenantId),
                    " ",
                    "(preset ",
                    React.createElement("strong", null, activePresetForQuick.label),
                    csvMode ? ", from pasted CSV" : "",
                    "). Each user will receive a randomly-generated password",
                    " ",
                    activePresetForQuick.forceChangePassword
                        ? "and be forced to change it on first sign-in"
                        : "with no forced reset",
                    "."),
                React.createElement("span", { className: "rounded border border-info/30 bg-info/5 px-2 py-1 text-2xs" },
                    React.createElement("strong", null, "Audit trail:"),
                    " ",
                    auditPreview.createUser,
                    "\u00D7 ",
                    React.createElement("code", null, "create_user"),
                    ",",
                    " ",
                    auditPreview.vaultPut,
                    "\u00D7 ",
                    React.createElement("code", null, "vault_put"),
                    auditPreview.autoLogin > 0 && (React.createElement(React.Fragment, null,
                        ", ",
                        auditPreview.autoLogin,
                        "\u00D7",
                        " ",
                        React.createElement("code", null, "webui_auto_login"))),
                    ". Each ",
                    React.createElement("code", null, "create_user"),
                    " shows in the Entra audit log as",
                    " ",
                    React.createElement("code", null, "Add user"),
                    "."),
                auditPreview.suspiciousNames > 0 && (React.createElement("span", { className: "rounded border border-warning/40 bg-warning/10 px-2 py-1 text-2xs" },
                    React.createElement("strong", null,
                        auditPreview.suspiciousNames,
                        " deceptive-name pattern",
                        auditPreview.suspiciousNames === 1 ? "" : "s"),
                    " ",
                    "detected (svc_*/admin_*/sync_*/etc.). These names blend into normal admin activity and are classic persistence-cell shapes \u2014 confirm the operator-intent before continuing.")),
                React.createElement("span", null, "Continue?")), confirmText: `Create ${batchPreview.length} users`, loading: bulkSubmitting, onConfirm: () => __awaiter(void 0, void 0, void 0, function* () {
                setBulkConfirmOpen(false);
                yield handleQuickSubmit();
            }), onCancel: () => {
                if (!bulkSubmitting)
                    setBulkConfirmOpen(false);
            } })));
};
// ---------------------------------------------------------------------------
// CreatedByMeTab — persistent list of users created in this browser.
//
// Reads CredentialEntry rows from the encrypted localStorage vault
// (already populated by handleConfirm above), scoped to the active
// privileged account's homeAccountId. Each row exposes three sign-in
// paths so even if the dev-server's Playwright auto-login is broken
// AND the MSAL popup gets blocked, the operator can still recover the
// new account's credentials manually:
//
//   1. Launch sign-in window  — POST /api/portal/auto-login (Playwright)
//   2. Interactive sign-in    — MSAL popup against the user's tenant
//   3. Copy email             — clipboard fallback for any sign-in flow
//
// Plus a Delete (red) button per row to evict stale entries. The whole
// vault is encrypted at rest, but we still let the operator clean up.
// ---------------------------------------------------------------------------
// Small helper button that copies a string with a built-in copied-flash.
// Lives in this file because we don't want to grow shared/* for it.
const CopyChip = ({ value, label, onCopied, onCopyFailed }) => {
    const [copied, setCopied] = React.useState(false);
    const handleClick = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        const ok = yield tryWriteClipboard(value);
        if (ok) {
            setCopied(true);
            onCopied === null || onCopied === void 0 ? void 0 : onCopied(value);
            window.setTimeout(() => setCopied(false), 1500);
        }
        else {
            onCopyFailed === null || onCopyFailed === void 0 ? void 0 : onCopyFailed();
        }
    }), [value, onCopied, onCopyFailed]);
    return (React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => void handleClick(), "aria-label": `Copy ${label}`, title: `Copy ${label}`, className: cn(copied && "text-success") }, copied ? React.createElement(Check, null) : React.createElement(Copy, null)));
};
// Small stat-pill used by both Browse and Created-by-me tabs. Lives here
// rather than in shared/* because the tone variants are tailored to this
// page's iconography.
const StatChip = ({ icon: Icon, label, value, tone }) => {
    var _a;
    const toneClass = {
        primary: "border-primary/30 bg-primary/5 text-primary",
        success: "border-success/30 bg-success/10 text-success",
        info: "border-info/30 bg-info/10 text-info",
        warning: "border-warning/30 bg-warning/10 text-warning",
        muted: "border-border bg-card text-muted-foreground",
    };
    return (React.createElement("div", { className: cn("flex items-center gap-2 rounded-md border px-3 py-2", (_a = toneClass[tone]) !== null && _a !== void 0 ? _a : toneClass.muted) },
        React.createElement(Icon, { className: "h-3.5 w-3.5 shrink-0" }),
        React.createElement("div", { className: "flex flex-col leading-tight" },
            React.createElement("span", { className: "text-base font-semibold text-foreground tabular-nums" }, value),
            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, label))));
};
const CreatedByMeTab = ({ account, store }) => {
    const [entries, setEntries] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    /**
     * Parallel-safe busy tracking. Each key in the set is "this entry has a
     * sign-in in flight" — supports the bulk runner which fires N concurrent
     * sign-ins at once. Replaces the previous single-string busyKey which
     * couldn't represent more than one running operation.
     */
    const [busyKeys, setBusyKeys] = React.useState(() => new Set());
    const [revealedKeys, setRevealedKeys] = React.useState(() => new Set());
    /** Per-row checkbox state for bulk select. */
    const [selectedKeys, setSelectedKeys] = React.useState(() => new Set());
    /**
     * Concurrent sign-in workers. Higher values open more Chromium windows in
     * parallel; lower values are gentler on the dev-server and on AAD's
     * per-IP throttle (which kicks in around 10-20 simultaneous auth flows).
     */
    const [threads, setThreads] = React.useState(3);
    const [bulkRunning, setBulkRunning] = React.useState(false);
    const [bulkLaunched, setBulkLaunched] = React.useState(0);
    const [bulkTotal, setBulkTotal] = React.useState(0);
    // Pending vault-removal target — drives <ConfirmationDialog>. Replaces
    // the legacy window.confirm() so the destructive flow matches the rest
    // of the app's confirmation UX.
    const [pendingRemoval, setPendingRemoval] = React.useState(null);
    const [removalSubmitting, setRemovalSubmitting] = React.useState(false);
    // Search + filter — the list grows fast on busy days, so we let the
    // operator narrow it by free text (matches upn/displayName/tenantId)
    // and by status (must-change-pending / source = create vs reset).
    const [searchText, setSearchText] = React.useState("");
    const [statusFilter, setStatusFilter] = React.useState("all");
    // Show-passwords-by-default toggle. Off by default for shoulder-surfing
    // safety; persisted in sessionStorage so the operator's preference
    // survives tab switches.
    const [showAllPasswords, setShowAllPasswords] = React.useState(() => {
        try {
            return sessionStorage.getItem(SHOW_ALL_PW_KEY) === "1";
        }
        catch (_a) {
            return false;
        }
    });
    React.useEffect(() => {
        try {
            sessionStorage.setItem(SHOW_ALL_PW_KEY, showAllPasswords ? "1" : "0");
        }
        catch (_a) {
            /* ignore */
        }
    }, [showAllPasswords]);
    /**
     * Persisted column-visibility for the created-users list. Each "column"
     * here is really a card-section toggle (tenant ID, display name, last
     * used, source badge, etc.) — operators who churn through dozens of
     * created accounts in a session can hide the chrome they don't read.
     *
     * Defaults are module-level so the reference is stable across renders;
     * usePersistedState only reads the initial value on first mount but a
     * stable reference is friendlier to React DevTools diffing.
     */
    const [columnVisibility, setColumnVisibility] = usePersistedState(CREATED_COLUMNS_KEY, DEFAULT_CREATED_COLUMNS, { version: 1 });
    const setColumnVisible = React.useCallback((key, visible) => {
        setColumnVisibility((prev) => (Object.assign(Object.assign({}, prev), { [key]: visible })));
    }, [setColumnVisibility]);
    /**
     * Count of *hidden* columns — surfaced in the toolbar so a confused
     * operator who can't find their password column has an obvious hint
     * ("3 columns hidden — click to restore").
     */
    const hiddenColumnCount = React.useMemo(() => {
        let n = 0;
        for (const k of CREATED_COLUMN_KEYS) {
            if (columnVisibility[k] === false)
                n += 1;
        }
        return n;
    }, [columnVisibility]);
    const markBusy = React.useCallback((key) => {
        setBusyKeys((prev) => {
            if (prev.has(key))
                return prev;
            const next = new Set(prev);
            next.add(key);
            return next;
        });
    }, []);
    const clearBusy = React.useCallback((key) => {
        setBusyKeys((prev) => {
            if (!prev.has(key))
                return prev;
            const next = new Set(prev);
            next.delete(key);
            return next;
        });
    }, []);
    const reload = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!account) {
            setEntries([]);
            return;
        }
        setLoading(true);
        try {
            const list = yield credentialVault.list({
                homeAccountId: account.homeAccountId,
            });
            // Newest first.
            list.sort((a, b) => { var _a, _b; return ((_a = b.createdAt) !== null && _a !== void 0 ? _a : "").localeCompare((_b = a.createdAt) !== null && _b !== void 0 ? _b : ""); });
            setEntries(list);
        }
        catch (err) {
            console.warn("[user-creator] vault.list failed", err);
            setEntries([]);
        }
        finally {
            setLoading(false);
        }
    }), [account]);
    React.useEffect(() => {
        void reload();
    }, [reload]);
    const rowKey = (e) => `${e.tenantId}::${e.upn}::${e.homeAccountId}`;
    const togglePassword = React.useCallback((key) => {
        setRevealedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key))
                next.delete(key);
            else
                next.add(key);
            return next;
        });
    }, []);
    const runPlaywright = React.useCallback((e) => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b;
        const key = rowKey(e);
        markBusy(key);
        const actor = (account === null || account === void 0 ? void 0 : account.username) || (account === null || account === void 0 ? void 0 : account.name) || e.homeAccountId;
        store.addNotification({
            type: "info",
            message: `Launching sign-in window for ${e.upn}…`,
        });
        const res = yield launchPortalAutoLogin({
            upn: e.upn,
            password: e.password,
            tenantId: e.tenantId,
            mustChangePassword: (_a = e.mustChangePassword) !== null && _a !== void 0 ? _a : false,
        });
        clearBusy(key);
        if (res.ok) {
            yield credentialVault.touch(e.upn, e.tenantId, e.homeAccountId);
            store.addNotification({
                type: "success",
                message: `Sign-in window opened for ${e.upn}.`,
            });
            auditLog.record({
                actor,
                action: "portal_auto_login",
                target: e.upn,
                status: "success",
                details: { tenantId: e.tenantId, fromTab: "created-by-me" },
            });
            yield reload();
        }
        else {
            store.addNotification({
                type: "error",
                message: `Auto-login failed for ${e.upn}: ${(_b = res.error) !== null && _b !== void 0 ? _b : "unknown"}.`,
            });
            auditLog.record({
                actor,
                action: "portal_auto_login",
                target: e.upn,
                status: "failure",
                error: res.error,
                details: {
                    tenantId: e.tenantId,
                    fromTab: "created-by-me",
                    status: res.status,
                },
            });
        }
    }), [account, store, reload]);
    const runInteractive = React.useCallback((e) => __awaiter(void 0, void 0, void 0, function* () {
        var _c, _d, _e;
        const key = rowKey(e);
        markBusy(key);
        const actor = (account === null || account === void 0 ? void 0 : account.username) || (account === null || account === void 0 ? void 0 : account.name) || e.homeAccountId;
        store.addNotification({
            type: "info",
            message: `Opening interactive sign-in for ${e.upn}…`,
        });
        const ires = yield attemptInteractiveLogin({
            upn: e.upn,
            tenantId: e.tenantId,
        });
        clearBusy(key);
        if (ires.ok) {
            yield credentialVault.touch(e.upn, e.tenantId, e.homeAccountId);
            store.addNotification({
                type: "success",
                message: `Signed in as ${(_d = (_c = ires.account) === null || _c === void 0 ? void 0 : _c.username) !== null && _d !== void 0 ? _d : e.upn}.`,
            });
            auditLog.record({
                actor,
                action: "interactive_login",
                target: e.upn,
                status: "success",
                details: { tenantId: e.tenantId, fromTab: "created-by-me" },
            });
            yield reload();
        }
        else {
            store.addNotification({
                type: "error",
                message: `Interactive sign-in failed for ${e.upn}: ${(_e = ires.error) !== null && _e !== void 0 ? _e : "unknown"}.`,
            });
            auditLog.record({
                actor,
                action: "interactive_login",
                target: e.upn,
                status: "failure",
                error: ires.error,
                details: { tenantId: e.tenantId, fromTab: "created-by-me" },
            });
        }
    }), [account, store, reload]);
    /**
     * Full-auto WebUI sign-in via Playwright. Mirrors the success-card flow:
     * fills email + password, walks the change-password form when
     * mustChangePassword is set (using a freshly-generated newPassword that
     * gets patched back into this vault entry), and lands the resulting
     * Chromium window inside this WebUI as the new user.
     */
    /**
     * Inner worker — does the actual Playwright dispatch + vault patch + audit
     * record. Returns `{ ok }` so both the per-row caller (which fires its own
     * toast) and the bulk caller (which only toasts on totals) can wrap it
     * the way they need to. Marks `busyKeys` for the duration so the row
     * disables its action buttons.
     */
    const runAutoSignInImpl = React.useCallback((e, opts = {}) => __awaiter(void 0, void 0, void 0, function* () {
        const key = rowKey(e);
        markBusy(key);
        const actor = (account === null || account === void 0 ? void 0 : account.username) || (account === null || account === void 0 ? void 0 : account.name) || e.homeAccountId;
        const mustChange = e.mustChangePassword === true;
        const newPassword = mustChange ? generateRandomPassword() : undefined;
        try {
            const res = yield launchPortalAutoLogin({
                upn: e.upn,
                password: e.password,
                tenantId: e.tenantId,
                mustChangePassword: mustChange,
                newPassword,
                target: "webui",
                webuiUrl: typeof window !== "undefined"
                    ? window.location.origin + "/"
                    : undefined,
            });
            if (res.ok) {
                if (newPassword) {
                    try {
                        yield credentialVault.put({
                            upn: e.upn,
                            password: newPassword,
                            tenantId: e.tenantId,
                            homeAccountId: e.homeAccountId,
                            displayName: e.displayName,
                            createdAt: e.createdAt,
                            source: e.source,
                            mustChangePassword: false,
                        });
                        auditLog.record({
                            actor,
                            action: "vault_put",
                            target: e.upn,
                            status: "success",
                            details: Object.assign({ tenantId: e.tenantId, reason: "auto-change-password-patch", fromTab: "created-by-me" }, (opts.silent ? { bulk: true } : {})),
                        });
                    }
                    catch (vaultErr) {
                        const vmsg = vaultErr instanceof Error
                            ? vaultErr.message
                            : String(vaultErr);
                        console.warn("[user-creator] created-by-me vault patch failed", vaultErr);
                        auditLog.record({
                            actor,
                            action: "vault_put",
                            target: e.upn,
                            status: "failure",
                            error: vmsg,
                            details: Object.assign({ tenantId: e.tenantId, reason: "auto-change-password-patch", fromTab: "created-by-me" }, (opts.silent ? { bulk: true } : {})),
                        });
                    }
                }
                try {
                    yield credentialVault.touch(e.upn, e.tenantId, e.homeAccountId);
                }
                catch (_f) {
                    /* touch is best-effort */
                }
                auditLog.record({
                    actor,
                    action: "webui_auto_login",
                    target: e.upn,
                    status: "success",
                    details: Object.assign({ tenantId: e.tenantId, fromTab: "created-by-me", mustChangePassword: mustChange, newPasswordSet: !!newPassword }, (opts.silent ? { bulk: true } : {})),
                });
                return { ok: true };
            }
            auditLog.record({
                actor,
                action: "webui_auto_login",
                target: e.upn,
                status: "failure",
                error: res.error,
                details: Object.assign({ tenantId: e.tenantId, fromTab: "created-by-me", mustChangePassword: mustChange, status: res.status }, (opts.silent ? { bulk: true } : {})),
            });
            return { ok: false, error: res.error };
        }
        finally {
            clearBusy(key);
        }
    }), [account, markBusy, clearBusy]);
    /**
     * Per-row caller — fires its own toasts and reloads the vault list on
     * success (so the must-change badge clears immediately).
     */
    const runAutoSignIn = React.useCallback((e) => __awaiter(void 0, void 0, void 0, function* () {
        var _g;
        const mustChange = e.mustChangePassword === true;
        store.addNotification({
            type: "info",
            message: mustChange
                ? `Auto sign-in for ${e.upn} (will auto-set fresh password)…`
                : `Auto sign-in for ${e.upn}…`,
        });
        const res = yield runAutoSignInImpl(e);
        if (res.ok) {
            store.addNotification({
                type: "success",
                message: mustChange
                    ? `Signed in as ${e.upn} with a fresh password. Vault updated.`
                    : `Signed in to WebUI as ${e.upn} in a new browser window.`,
            });
            yield reload();
        }
        else {
            store.addNotification({
                type: "error",
                message: `Auto sign-in failed for ${e.upn}: ${(_g = res.error) !== null && _g !== void 0 ? _g : "unknown"}. Use Manual (MSAL) to type the password yourself.`,
            });
        }
    }), [runAutoSignInImpl, store, reload]);
    /**
     * Bulk runner — iterates over every selected entry with a concurrency-
     * bounded worker pool. Each worker pulls the next entry from a shared
     * cursor, fires runAutoSignInImpl({silent: true}), and continues until
     * the cursor is exhausted. Threads is capped to [1, 10] — going higher
     * tends to trip AAD's per-IP auth throttle (~20 concurrent flows).
     *
     * Progress is tracked via bulkLaunched + bulkTotal so the toolbar shows
     * "12 / 30 launched" while running. After every entry's worker resolves,
     * we reload the vault list once so freshly-rotated must-change badges
     * clear in batch.
     */
    const runBulkAutoSignIn = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        // Match against ALL entries (not filteredEntries) so a row selected
        // before the user typed a filter doesn't silently get dropped.
        const targets = entries.filter((e) => selectedKeys.has(rowKey(e)));
        if (targets.length === 0) {
            store.addNotification({
                type: "info",
                message: "Select at least one account first.",
            });
            return;
        }
        const concurrency = Math.max(1, Math.min(10, Math.floor(threads) || 3));
        setBulkRunning(true);
        setBulkLaunched(0);
        setBulkTotal(targets.length);
        let succeeded = 0;
        let failed = 0;
        let cursor = 0;
        const startedAt = Date.now();
        store.addNotification({
            type: "info",
            message: `Starting bulk auto sign-in: ${targets.length} accounts, ${concurrency} thread${concurrency === 1 ? "" : "s"}…`,
        });
        const worker = () => __awaiter(void 0, void 0, void 0, function* () {
            while (true) {
                const idx = cursor++;
                if (idx >= targets.length)
                    return;
                const entry = targets[idx];
                const res = yield runAutoSignInImpl(entry, { silent: true });
                if (res.ok)
                    succeeded += 1;
                else
                    failed += 1;
                setBulkLaunched(succeeded + failed);
            }
        });
        const workers = Array.from({
            length: Math.min(concurrency, targets.length),
        }).map(() => worker());
        yield Promise.all(workers);
        setBulkRunning(false);
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        store.addNotification({
            type: failed > 0 ? "warning" : "success",
            message: `Bulk auto sign-in done: ${succeeded} launched, ${failed} failed in ${elapsedSec}s.`,
        });
        auditLog.record({
            actor: (account === null || account === void 0 ? void 0 : account.username) || (account === null || account === void 0 ? void 0 : account.name) || "anonymous",
            action: "webui_auto_login",
            target: `bulk(${targets.length})`,
            status: failed === 0 ? "success" : "failure",
            details: {
                bulk: true,
                threads: concurrency,
                succeeded,
                failed,
                elapsedSec,
            },
        });
        // Reload once at the end so all the must-change badges clear in batch.
        yield reload();
        // Clear selection after a successful run so the operator doesn't
        // accidentally re-fire on the same set.
        if (failed === 0) {
            setSelectedKeys(new Set());
        }
    }), [
        entries,
        selectedKeys,
        threads,
        runAutoSignInImpl,
        store,
        reload,
        account,
    ]);
    // ---- Filtering, stats, and export ------------------------------------
    const filteredEntries = React.useMemo(() => {
        let out = entries;
        // Status filter
        if (statusFilter === "must-change") {
            out = out.filter((e) => e.mustChangePassword === true);
        }
        else if (statusFilter === "ready") {
            out = out.filter((e) => e.mustChangePassword !== true);
        }
        else if (statusFilter === "created") {
            out = out.filter((e) => e.source === "create");
        }
        else if (statusFilter === "reset") {
            out = out.filter((e) => e.source === "reset");
        }
        // Free-text search — case-insensitive substring match against upn,
        // displayName, and tenantId. Empty query returns the current set.
        const q = searchText.trim().toLowerCase();
        if (q) {
            out = out.filter((e) => {
                var _a;
                return (e.upn.toLowerCase().includes(q) ||
                    ((_a = e.displayName) !== null && _a !== void 0 ? _a : "").toLowerCase().includes(q) ||
                    e.tenantId.toLowerCase().includes(q));
            });
        }
        return out;
    }, [entries, statusFilter, searchText]);
    const stats = React.useMemo(() => {
        const total = entries.length;
        let mustChange = 0;
        let ready = 0;
        let created = 0;
        let reset = 0;
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - thirtyDaysMs;
        let recent = 0;
        for (const e of entries) {
            if (e.mustChangePassword === true)
                mustChange += 1;
            else
                ready += 1;
            if (e.source === "create")
                created += 1;
            else if (e.source === "reset")
                reset += 1;
            const ts = e.createdAt ? Date.parse(e.createdAt) : NaN;
            if (!Number.isNaN(ts) && ts >= cutoff)
                recent += 1;
        }
        return { total, mustChange, ready, created, reset, recent };
    }, [entries]);
    /**
     * Export the currently-visible (filteredEntries) vault rows as either a
     * CSV or JSON file. Sensitive: the operator confirmed an explicit
     * action; we still tone the toast so they remember the file contains
     * plaintext passwords. Records `vault_export` in the audit log with the
     * row count + format but never the actual credentials.
     */
    const exportVault = React.useCallback((format) => {
        var _a, _b, _c;
        const rows = filteredEntries;
        if (rows.length === 0) {
            store.addNotification({
                type: "info",
                message: "Nothing to export — no entries match the current filters.",
            });
            return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `azbm-vault-${stamp}.${format}`;
        if (format === "csv") {
            const header = [
                "upn",
                "password",
                "tenantId",
                "displayName",
                "source",
                "mustChangePassword",
                "createdAt",
                "lastUsedAt",
            ];
            const lines = [header.map(csvCell).join(",")];
            for (const e of rows) {
                lines.push([
                    csvCell(e.upn),
                    csvCell(e.password),
                    csvCell(e.tenantId),
                    csvCell((_a = e.displayName) !== null && _a !== void 0 ? _a : ""),
                    csvCell(e.source),
                    csvCell(e.mustChangePassword === true ? "true" : "false"),
                    csvCell((_b = e.createdAt) !== null && _b !== void 0 ? _b : ""),
                    csvCell((_c = e.lastUsedAt) !== null && _c !== void 0 ? _c : ""),
                ].join(","));
            }
            downloadTextFile(filename, lines.join("\n"), "text/csv");
        }
        else {
            const payload = rows.map((e) => {
                var _a, _b, _c;
                return ({
                    upn: e.upn,
                    password: e.password,
                    tenantId: e.tenantId,
                    displayName: (_a = e.displayName) !== null && _a !== void 0 ? _a : null,
                    source: e.source,
                    mustChangePassword: e.mustChangePassword === true,
                    createdAt: (_b = e.createdAt) !== null && _b !== void 0 ? _b : null,
                    lastUsedAt: (_c = e.lastUsedAt) !== null && _c !== void 0 ? _c : null,
                });
            });
            downloadTextFile(filename, JSON.stringify(payload, null, 2), "application/json");
        }
        store.addNotification({
            type: "warning",
            message: `Exported ${rows.length} credential${rows.length === 1 ? "" : "s"} to ${filename}. Contains plaintext passwords — handle with care.`,
        });
        auditLog.record({
            actor: (account === null || account === void 0 ? void 0 : account.username) || (account === null || account === void 0 ? void 0 : account.name) || "anonymous",
            action: "vault_export",
            target: filename,
            status: "success",
            details: {
                rowCount: rows.length,
                format,
                filterStatus: statusFilter,
                searchActive: searchText.trim().length > 0,
            },
        });
    }, [filteredEntries, store, account, statusFilter, searchText]);
    const toggleSelectAll = React.useCallback(() => {
        // Always work against the currently visible (filtered) entries so
        // "Select all" with an active filter only flips the visible rows.
        setSelectedKeys((prev) => {
            const visibleKeys = filteredEntries.map(rowKey);
            const allVisibleSelected = visibleKeys.length > 0 &&
                visibleKeys.every((k) => prev.has(k));
            if (allVisibleSelected) {
                const next = new Set(prev);
                for (const k of visibleKeys)
                    next.delete(k);
                return next;
            }
            const next = new Set(prev);
            for (const k of visibleKeys)
                next.add(k);
            return next;
        });
    }, [filteredEntries]);
    const toggleSelectRow = React.useCallback((key) => {
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key))
                next.delete(key);
            else
                next.add(key);
            return next;
        });
    }, []);
    const copyEmail = React.useCallback((e) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield navigator.clipboard.writeText(e.upn);
            store.addNotification({
                type: "success",
                message: `Email ${e.upn} copied.`,
            });
        }
        catch (_h) {
            store.addNotification({
                type: "error",
                message: `Could not copy ${e.upn} — clipboard blocked.`,
            });
        }
    }), [store]);
    const copyPassword = React.useCallback((e) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield navigator.clipboard.writeText(e.password);
            store.addNotification({
                type: "success",
                message: `Password for ${e.upn} copied.`,
            });
        }
        catch (_j) {
            store.addNotification({
                type: "error",
                message: `Could not copy password — clipboard blocked.`,
            });
        }
    }), [store]);
    // Open the confirmation dialog. The actual removal lives in
    // confirmRemoveEntry so the dialog's onConfirm can drive it.
    const removeEntry = React.useCallback((e) => {
        setPendingRemoval(e);
    }, []);
    const confirmRemoveEntry = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        const e = pendingRemoval;
        if (!e)
            return;
        setRemovalSubmitting(true);
        try {
            yield credentialVault.remove(e.upn, e.tenantId, e.homeAccountId);
            auditLog.record({
                actor: (account === null || account === void 0 ? void 0 : account.username) || (account === null || account === void 0 ? void 0 : account.name) || e.homeAccountId,
                action: "vault_remove",
                target: e.upn,
                status: "success",
                details: { tenantId: e.tenantId },
            });
            store.addNotification({
                type: "info",
                message: `Removed vault entry for ${e.upn}.`,
            });
            yield reload();
        }
        finally {
            setRemovalSubmitting(false);
            setPendingRemoval(null);
        }
    }), [pendingRemoval, account, store, reload]);
    if (!account) {
        return (React.createElement(EmptyState, { icon: Users, title: "No privileged account selected", description: "Select a privileged account to view its created users." }));
    }
    return (React.createElement(React.Fragment, null,
        React.createElement(Card, null,
            React.createElement(CardHeader, null,
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                    React.createElement(Users, { className: "h-4 w-4 text-primary" }),
                    "Users created in this browser"),
                React.createElement(CardDescription, null,
                    "Persisted encrypted in ",
                    React.createElement("code", { className: "font-mono" }, "localStorage"),
                    " ",
                    "under the active account's key. Survives page reloads. \u201CAuto sign-in\u201D opens a Chromium window with the password pre-filled (and walks the must-change-password form when needed). \u201CManual (MSAL)\u201D opens a popup in this tab so the new user becomes the active session here. \u201CPortal\u201D launches a separate portal.azure.com browser window.")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                entries.length > 0 && (React.createElement("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-5" },
                    React.createElement(StatChip, { icon: Users, label: "Total", value: stats.total, tone: "primary" }),
                    React.createElement(StatChip, { icon: ShieldCheck, label: "Ready", value: stats.ready, tone: "success" }),
                    React.createElement(StatChip, { icon: ShieldAlert, label: "Must change", value: stats.mustChange, tone: "warning" }),
                    React.createElement(StatChip, { icon: KeyRound, label: "Reset", value: stats.reset, tone: "info" }),
                    React.createElement(StatChip, { icon: Clock, label: "Last 30d", value: stats.recent, tone: "muted" }))),
                entries.length > 0 && (React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-card/40 p-2" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement("div", { className: "relative flex-1 min-w-[180px]" },
                            React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                            React.createElement(Input, { type: "text", value: searchText, onChange: (ev) => setSearchText(ev.target.value), placeholder: "Search UPN, display name, or tenant\u2026", "aria-label": "Search saved credentials", className: "h-8 pl-8 text-xs" }),
                            searchText && (React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", className: "absolute right-1 top-1/2 -translate-y-1/2", onClick: () => setSearchText(""), "aria-label": "Clear search", title: "Clear search" },
                                React.createElement(X, null)))),
                        React.createElement("label", { className: "flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-2xs", title: "When on, every password is shown in plaintext. Persisted in sessionStorage." },
                            React.createElement(Switch, { checked: showAllPasswords, onCheckedChange: (v) => setShowAllPasswords(Boolean(v)), "aria-label": "Reveal all passwords" }),
                            React.createElement("span", { className: "font-medium text-muted-foreground" }, "Reveal all")),
                        React.createElement("div", { className: "flex items-center gap-1" },
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => exportVault("csv"), disabled: loading || bulkRunning || filteredEntries.length === 0, "aria-label": "Export filtered vault entries as CSV", title: `Export ${filteredEntries.length} visible row${filteredEntries.length === 1 ? "" : "s"} to CSV — contains plaintext passwords` },
                                React.createElement(Download, null),
                                "CSV"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => exportVault("json"), disabled: loading || bulkRunning || filteredEntries.length === 0, "aria-label": "Export filtered vault entries as JSON", title: `Export ${filteredEntries.length} visible row${filteredEntries.length === 1 ? "" : "s"} to JSON — contains plaintext passwords` },
                                React.createElement(FileJson, null),
                                "JSON"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => void reload(), disabled: loading || bulkRunning, "aria-label": "Reload vault entries", title: "Reload vault from localStorage" },
                                loading ? React.createElement(Loader2, { className: "animate-spin" }) : React.createElement(RefreshCw, null),
                                "Refresh"))),
                    React.createElement("details", { className: "rounded-md border border-border bg-card/40 px-2 py-1.5 text-2xs" },
                        React.createElement("summary", { className: "flex cursor-pointer items-center gap-1.5 select-none" },
                            React.createElement(Filter, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": true }),
                            React.createElement("span", { className: "font-medium" }, "Columns"),
                            hiddenColumnCount > 0 ? (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                                hiddenColumnCount,
                                " hidden")) : (React.createElement("span", { className: "text-muted-foreground" }, "(all visible)")),
                            hiddenColumnCount > 0 && (React.createElement("button", { type: "button", onClick: (ev) => {
                                    ev.preventDefault();
                                    setColumnVisibility(DEFAULT_CREATED_COLUMNS);
                                }, className: "ml-auto underline underline-offset-2 hover:no-underline", "aria-label": "Restore all columns" }, "restore all"))),
                        React.createElement("div", { className: "mt-1.5 flex flex-wrap items-center gap-2" }, [
                            { k: "sourceBadge", label: "Source badge" },
                            { k: "createdAt", label: "Created date" },
                            { k: "tenant", label: "Tenant ID" },
                            { k: "displayName", label: "Display name" },
                            { k: "lastUsed", label: "Last used" },
                            { k: "password", label: "Password" },
                        ].map(({ k, label }) => (React.createElement("label", { key: k, className: "flex cursor-pointer items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5" },
                            React.createElement(Checkbox, { checked: columnVisibility[k] !== false, onCheckedChange: (v) => setColumnVisible(k, Boolean(v)), "aria-label": `Toggle ${label} column` }),
                            React.createElement("span", null, label)))))),
                    React.createElement("div", { role: "radiogroup", "aria-label": "Filter by status", className: "flex flex-wrap items-center gap-1" },
                        React.createElement(Filter, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": true }),
                        [
                            { k: "all", label: "All", count: entries.length },
                            {
                                k: "must-change",
                                label: "Must change",
                                count: stats.mustChange,
                            },
                            { k: "ready", label: "Ready", count: stats.ready },
                            { k: "created", label: "Created", count: stats.created },
                            { k: "reset", label: "Reset", count: stats.reset },
                        ].map((chip) => {
                            const active = statusFilter === chip.k;
                            return (React.createElement("button", { key: chip.k, type: "button", role: "radio", "aria-checked": active, onClick: () => setStatusFilter(chip.k), className: cn("rounded-full border px-2 py-0.5 text-2xs transition-colors", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active
                                    ? "border-primary/50 bg-primary/15 text-foreground"
                                    : "border-border bg-card text-muted-foreground hover:bg-muted/50") },
                                chip.label,
                                React.createElement("span", { className: "ml-1 opacity-70" },
                                    "(",
                                    chip.count,
                                    ")")));
                        })),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-2xs text-muted-foreground" },
                        React.createElement("span", null,
                            "Showing",
                            " ",
                            React.createElement("strong", { className: "text-foreground" }, filteredEntries.length),
                            " ",
                            "of",
                            " ",
                            React.createElement("strong", { className: "text-foreground" }, entries.length),
                            " ",
                            "saved credential",
                            entries.length === 1 ? "" : "s"),
                        (statusFilter !== "all" || searchText) && (React.createElement("button", { type: "button", onClick: () => {
                                setStatusFilter("all");
                                setSearchText("");
                            }, className: "underline underline-offset-2 hover:no-underline" }, "Clear filters")),
                        React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                            React.createElement(ShieldCheck, { className: "h-3 w-3", "aria-hidden": true }),
                            "AES-GCM encrypted at rest (per-account key)")))),
                entries.length === 0 && !loading && (React.createElement("div", { className: "flex items-center justify-end" },
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => void reload(), disabled: loading || bulkRunning, "aria-label": "Reload vault entries" },
                        loading ? React.createElement(Loader2, { className: "animate-spin" }) : React.createElement(RefreshCw, null),
                        "Refresh"))),
                entries.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5" },
                    React.createElement("label", { className: "flex cursor-pointer items-center gap-1.5 text-xs font-medium", title: filteredEntries.length === entries.length
                            ? "Toggle every row"
                            : `Toggle the ${filteredEntries.length} visible row${filteredEntries.length === 1 ? "" : "s"}` },
                        React.createElement(Checkbox, { checked: filteredEntries.length > 0 &&
                                filteredEntries.every((e) => selectedKeys.has(rowKey(e))), onCheckedChange: () => toggleSelectAll(), disabled: bulkRunning || filteredEntries.length === 0, "aria-label": filteredEntries.length === entries.length
                                ? "Select all credentials"
                                : "Select all visible credentials" }),
                        filteredEntries.length === entries.length
                            ? "Select all"
                            : `Select all visible (${filteredEntries.length})`),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        "(",
                        selectedKeys.size,
                        " selected)"),
                    selectedKeys.size > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setSelectedKeys(new Set()), disabled: bulkRunning, "aria-label": "Clear selection", title: "Clear selection", className: "h-6 px-2 text-2xs" },
                        React.createElement(X, null),
                        "Clear")),
                    React.createElement("div", { className: "ml-auto flex flex-wrap items-center gap-2" },
                        React.createElement("label", { className: "flex items-center gap-1.5 text-2xs text-muted-foreground" },
                            "Threads",
                            React.createElement(Input, { type: "number", min: 1, max: 10, step: 1, value: threads, onChange: (ev) => {
                                    const v = Number(ev.target.value);
                                    if (Number.isFinite(v)) {
                                        setThreads(Math.max(1, Math.min(10, Math.floor(v))));
                                    }
                                }, disabled: bulkRunning, className: "h-7 w-14 text-2xs font-mono", "aria-label": "Concurrent sign-in threads" })),
                        React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: () => void runBulkAutoSignIn(), disabled: bulkRunning ||
                                selectedKeys.size === 0 ||
                                busyKeys.size > 0, "aria-label": `Auto sign-in to ${selectedKeys.size} selected accounts`, title: selectedKeys.size === 0
                                ? "Pick rows first"
                                : `Open ${selectedKeys.size} Chromium windows, ${threads} at a time` },
                            bulkRunning ? (React.createElement(Loader2, { className: "animate-spin" })) : (React.createElement(LogIn, null)),
                            bulkRunning
                                ? `Signing in… ${bulkLaunched}/${bulkTotal}`
                                : `Auto sign-in selected (${selectedKeys.size})`)))),
                entries.length === 0 && !loading && (React.createElement(EmptyState, { icon: Users, title: "No users created yet", description: "Create a user from the Create User tab and it will appear here automatically." })),
                entries.length > 0 && filteredEntries.length === 0 && !loading && (React.createElement("div", { className: "flex flex-col items-center gap-2 rounded-md border border-dashed border-border bg-card/40 px-4 py-6 text-center" },
                    React.createElement(Search, { className: "h-5 w-5 text-muted-foreground", "aria-hidden": true }),
                    React.createElement("div", { className: "text-xs font-medium text-foreground" }, "No credentials match the current filters"),
                    React.createElement("div", { className: "text-2xs text-muted-foreground" },
                        "Adjust the search box or the status chips, or",
                        " ",
                        React.createElement("button", { type: "button", onClick: () => {
                                setStatusFilter("all");
                                setSearchText("");
                            }, className: "underline underline-offset-2 hover:no-underline" }, "clear all filters"),
                        "."))),
                filteredEntries.map((e) => {
                    const key = rowKey(e);
                    const busy = busyKeys.has(key);
                    const selected = selectedKeys.has(key);
                    const revealed = revealedKeys.has(key) || showAllPasswords;
                    return (React.createElement("div", { key: key, className: cn("flex flex-col gap-2 rounded-md border bg-card/60 p-3 transition-colors duration-150", selected
                            ? "border-primary/50 bg-primary/5"
                            : "border-border", busy && "ring-1 ring-primary/30") },
                        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                            React.createElement(Checkbox, { checked: selected, onCheckedChange: () => toggleSelectRow(key), disabled: bulkRunning, "aria-label": `Select ${e.upn} for bulk sign-in` }),
                            React.createElement(BadgeCheck, { className: "h-4 w-4 text-success", "aria-hidden": true }),
                            React.createElement("code", { className: "font-mono text-sm font-medium" }, e.upn),
                            React.createElement(CopyChip, { value: e.upn, label: "UPN", onCopied: () => store.addNotification({
                                    type: "info",
                                    message: `Copied ${e.upn}.`,
                                }), onCopyFailed: () => store.addNotification({
                                    type: "error",
                                    message: "Clipboard blocked by the browser.",
                                }) }),
                            columnVisibility.sourceBadge !== false &&
                                e.source === "create" && (React.createElement(Badge, { variant: "info", className: "text-2xs" }, "created")),
                            columnVisibility.sourceBadge !== false &&
                                e.source === "reset" && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, "reset")),
                            e.mustChangePassword && (React.createElement(Badge, { variant: "warning", className: "text-2xs" }, "must change")),
                            columnVisibility.createdAt !== false && (React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground tabular-nums", title: e.createdAt
                                    ? new Date(e.createdAt).toISOString()
                                    : undefined }, e.createdAt
                                ? formatRelative(e.createdAt)
                                : "unknown date"))),
                        (columnVisibility.tenant !== false ||
                            columnVisibility.displayName !== false ||
                            columnVisibility.lastUsed !== false) && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-2xs text-muted-foreground" },
                            columnVisibility.tenant !== false && (React.createElement(React.Fragment, null,
                                React.createElement("span", null,
                                    "tenant",
                                    " ",
                                    React.createElement("code", { className: "font-mono" }, truncateMiddle(e.tenantId))),
                                React.createElement(CopyChip, { value: e.tenantId, label: "tenant ID", onCopied: () => store.addNotification({
                                        type: "info",
                                        message: "Tenant ID copied.",
                                    }), onCopyFailed: () => store.addNotification({
                                        type: "error",
                                        message: "Clipboard blocked by the browser.",
                                    }) }))),
                            columnVisibility.displayName !== false && e.displayName && (React.createElement("span", null,
                                "\u00B7 ",
                                e.displayName)),
                            columnVisibility.lastUsed !== false && e.lastUsedAt && (React.createElement("span", { title: new Date(e.lastUsedAt).toISOString() },
                                "\u00B7 last used ",
                                formatRelative(e.lastUsedAt))))),
                        columnVisibility.password !== false && (React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                            React.createElement("code", { className: "rounded bg-background px-2 py-1 font-mono text-2xs" }, revealed ? e.password : "••••••••••••"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => togglePassword(key), "aria-label": revealed ? "Hide password" : "Show password", title: revealed ? "Hide password" : "Show password" }, revealed ? React.createElement(EyeOff, null) : React.createElement(Eye, null)),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => void copyPassword(e), "aria-label": "Copy password", title: "Copy password" },
                                React.createElement(Copy, null)))),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                            React.createElement(Button, { type: "button", variant: "default", size: "sm", disabled: busy || bulkRunning, onClick: () => void runAutoSignIn(e), "aria-label": `Auto sign-in to WebUI as ${e.upn}`, title: "Playwright fills email + password (and walks the must-change-password form when needed). New Chromium window is signed into this WebUI as the user." },
                                busy ? (React.createElement(Loader2, { className: "animate-spin" })) : (React.createElement(LogIn, null)),
                                e.mustChangePassword
                                    ? "Auto sign-in (resets password)"
                                    : "Auto sign-in"),
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", disabled: busy || bulkRunning, onClick: () => void runInteractive(e), "aria-label": `MSAL popup sign-in as ${e.upn}`, title: "MSAL popup in this tab \u2014 manual password entry" },
                                React.createElement(LogIn, null),
                                "Manual (MSAL)"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", disabled: busy || bulkRunning, onClick: () => void runPlaywright(e), "aria-label": `Open portal.azure.com session for ${e.upn}`, title: "POST /api/portal/auto-login (target=portal) \u2014 opens portal.azure.com in a separate Chromium window" },
                                React.createElement(ExternalLink, null),
                                "Portal"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => void copyEmail(e), "aria-label": "Copy email", title: "Copy email to clipboard" },
                                React.createElement(Copy, null),
                                "Copy email"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => removeEntry(e), className: "ml-auto text-destructive hover:text-destructive", "aria-label": `Remove vault entry for ${e.upn}`, title: "Remove from vault" },
                                React.createElement(Trash2, null),
                                "Remove"))));
                }))),
        React.createElement(ConfirmationDialog, { hidden: !pendingRemoval, danger: true, title: "Remove vault entry", message: pendingRemoval ? (React.createElement("span", null,
                "Remove vault entry for ",
                React.createElement("strong", null, pendingRemoval.upn),
                "? You will not be able to re-launch the sign-in window from this browser without recreating the credential.")) : (""), confirmText: "Remove", loading: removalSubmitting, onConfirm: confirmRemoveEntry, onCancel: () => {
                if (!removalSubmitting)
                    setPendingRemoval(null);
            } })));
};
const BrowseUsers = ({ tenantUsers, privilegedAccounts, onSwitchToCreateTab, onNavigate, }) => {
    const store = useMultiRegionStore();
    const rows = React.useMemo(() => {
        var _a;
        const out = [];
        for (const [tenantId, users] of Object.entries(tenantUsers !== null && tenantUsers !== void 0 ? tenantUsers : {})) {
            if (!Array.isArray(users))
                continue;
            for (const u of users) {
                out.push(Object.assign(Object.assign({}, u), { tenantId, createdDateTime: (_a = u.createdDateTime) !== null && _a !== void 0 ? _a : null }));
            }
        }
        return out;
    }, [tenantUsers]);
    const tenantIds = React.useMemo(() => {
        return Array.from(new Set(rows.map((r) => r.tenantId))).sort();
    }, [rows]);
    const [tenantFilter, setTenantFilter] = React.useState([]);
    const [statusFilter, setStatusFilter] = React.useState([]);
    const stats = React.useMemo(() => {
        const total = rows.length;
        const enabled = rows.filter((r) => r.accountEnabled).length;
        const disabled = total - enabled;
        const tenants = tenantIds.length;
        return { total, enabled, disabled, tenants };
    }, [rows, tenantIds]);
    const findAccountForTenant = React.useCallback((tenantId) => {
        var _a, _b;
        return ((_b = (_a = privilegedAccounts.find((p) => p.tenantId === tenantId)) !== null && _a !== void 0 ? _a : privilegedAccounts[0]) !== null && _b !== void 0 ? _b : null);
    }, [privilegedAccounts]);
    const notifyCopied = React.useCallback((value) => {
        store.addNotification({
            type: "info",
            message: `Copied ${truncateMiddle(value)}`,
        });
    }, [store]);
    const notifyCopyFailed = React.useCallback(() => {
        store.addNotification({
            type: "error",
            message: "Clipboard blocked by the browser.",
        });
    }, [store]);
    const columns = React.useMemo(() => [
        {
            key: "displayName",
            name: "Display Name",
            minWidth: 180,
            getValue: (u) => { var _a; return (_a = u.displayName) !== null && _a !== void 0 ? _a : ""; },
            onRender: (u) => (React.createElement("span", { className: "truncate text-xs text-foreground" }, u.displayName || "(unnamed)")),
        },
        {
            key: "userPrincipalName",
            name: "User Principal Name",
            minWidth: 260,
            getValue: (u) => { var _a; return (_a = u.userPrincipalName) !== null && _a !== void 0 ? _a : ""; },
            onRender: (u) => {
                var _a;
                const upn = (_a = u.userPrincipalName) !== null && _a !== void 0 ? _a : "";
                const at = upn.indexOf("@");
                const label = at < 0 ? upn : null;
                return (React.createElement("span", { className: "flex items-center gap-1 truncate text-xs" },
                    label !== null ? (React.createElement("span", { className: "text-muted-foreground" }, label)) : (React.createElement(React.Fragment, null,
                        React.createElement("span", { className: "text-foreground" }, upn.slice(0, at + 1)),
                        React.createElement("span", { className: "font-mono text-muted-foreground" }, upn.slice(at + 1)))),
                    upn && (React.createElement(CopyChip, { value: upn, label: "UPN", onCopied: notifyCopied, onCopyFailed: notifyCopyFailed }))));
            },
        },
        {
            key: "id",
            name: "Object ID",
            minWidth: 160,
            getValue: (u) => { var _a; return (_a = u.id) !== null && _a !== void 0 ? _a : ""; },
            onRender: (u) => {
                var _a;
                return (React.createElement("span", { className: "flex items-center gap-1 text-2xs" },
                    React.createElement("code", { className: "font-mono text-muted-foreground" }, truncateMiddle((_a = u.id) !== null && _a !== void 0 ? _a : "", 8, 4)),
                    u.id && (React.createElement(CopyChip, { value: u.id, label: "object ID", onCopied: notifyCopied, onCopyFailed: notifyCopyFailed }))));
            },
        },
        {
            key: "tenantId",
            name: "Tenant",
            minWidth: 160,
            getValue: (u) => u.tenantId,
            onRender: (u) => (React.createElement("span", { className: "flex items-center gap-1 text-2xs" },
                React.createElement(Badge, { variant: "secondary", className: "font-mono text-2xs" }, truncateMiddle(u.tenantId, 8, 4)),
                React.createElement(CopyChip, { value: u.tenantId, label: "tenant ID", onCopied: notifyCopied, onCopyFailed: notifyCopyFailed }))),
        },
        {
            key: "accountEnabled",
            name: "State",
            minWidth: 110,
            getValue: (u) => (u.accountEnabled ? "Enabled" : "Disabled"),
            onRender: (u) => u.accountEnabled ? (React.createElement(Badge, { variant: "success", className: "gap-1" },
                React.createElement(BadgeCheck, { className: "h-3 w-3" }),
                "Enabled")) : (React.createElement(Badge, { variant: "secondary" }, "Disabled")),
        },
        {
            key: "createdDateTime",
            name: "Created",
            minWidth: 110,
            getValue: (u) => { var _a; return (_a = u.createdDateTime) !== null && _a !== void 0 ? _a : ""; },
            onRender: (u) => {
                var _a;
                return (React.createElement("span", { className: "text-2xs text-muted-foreground tabular-nums", title: (_a = u.createdDateTime) !== null && _a !== void 0 ? _a : undefined }, formatRelative(u.createdDateTime)));
            },
        },
        {
            key: "actions",
            name: "Action",
            minWidth: 130,
            sortable: false,
            onRender: (u) => {
                const target = findAccountForTenant(u.tenantId);
                const disabled = !target;
                return (React.createElement(Button, { type: "button", variant: "outline", size: "xs", onClick: () => {
                        if (target)
                            onSwitchToCreateTab(target.homeAccountId);
                    }, disabled: disabled, "aria-label": `Use tenant ${u.tenantId}`, title: disabled
                        ? "No privileged account is logged in for this tenant."
                        : `Switch to tenant ${truncateMiddle(u.tenantId)}` },
                    React.createElement(ArrowLeftRight, null),
                    "Use Tenant"));
            },
        },
    ], [findAccountForTenant, onSwitchToCreateTab, notifyCopied, notifyCopyFailed]);
    // Apply the local "State" filter on top of the EnhancedTable's
    // tenant-column filter. EnhancedTable doesn't natively support a
    // boolean filter via FilterConfig, so we pre-filter the rows array.
    const visibleRows = React.useMemo(() => {
        if (statusFilter.length === 0)
            return rows;
        return rows.filter((r) => {
            const k = r.accountEnabled ? "enabled" : "disabled";
            return statusFilter.includes(k);
        });
    }, [rows, statusFilter]);
    if (rows.length === 0) {
        return (React.createElement(EmptyState, { icon: Building2, title: "No users fetched yet.", description: "Open the Tenant Users page and load users for one or more tenants to populate this browser.", action: onNavigate
                ? {
                    label: "Open Tenant Users",
                    onClick: () => onNavigate("tenant-users"),
                }
                : undefined }));
    }
    return (React.createElement("div", { className: "flex flex-col gap-3" },
        React.createElement("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-4" },
            React.createElement(StatChip, { icon: Users, label: "Total", value: stats.total, tone: "primary" }),
            React.createElement(StatChip, { icon: BadgeCheck, label: "Enabled", value: stats.enabled, tone: "success" }),
            React.createElement(StatChip, { icon: ShieldAlert, label: "Disabled", value: stats.disabled, tone: "muted" }),
            React.createElement(StatChip, { icon: Building2, label: "Tenants", value: stats.tenants, tone: "info" })),
        React.createElement(Card, null,
            React.createElement(CardContent, { className: "pt-4" },
                React.createElement(EnhancedTable, { items: visibleRows, columns: columns, getRowId: (u) => `${u.tenantId}::${u.id}`, searchPlaceholder: "Search users (UPN, display name, object ID, tenant)\u2026", filters: [
                        {
                            columnKey: "tenantId",
                            options: tenantIds.map((t) => ({
                                key: t,
                                text: truncateMiddle(t),
                            })),
                            selectedKeys: tenantFilter,
                            onChange: setTenantFilter,
                        },
                        {
                            columnKey: "accountEnabled",
                            options: [
                                { key: "enabled", text: "Enabled" },
                                { key: "disabled", text: "Disabled" },
                            ],
                            selectedKeys: statusFilter,
                            onChange: setStatusFilter,
                        },
                    ], pageSize: 50 })))));
};
export const UserCreatorPage = (props) => (React.createElement(ErrorBoundary, null,
    React.createElement(UserCreatorPageInner, Object.assign({}, props))));
//# sourceMappingURL=user-creator-page.js.map