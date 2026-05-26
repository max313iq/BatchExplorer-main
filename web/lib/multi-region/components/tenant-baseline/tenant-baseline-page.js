import { __awaiter } from "tslib";
/**
 * Tenant Security Baseline + Service Principal Credentials — defensive
 * tenant auditor inspired by AADInternals' read-only cmdlets.
 *
 * What this page is for:
 *
 *   - Tenant admins audit common Entra ID misconfigs in THEIR OWN tenant
 *     (Tab 1 = Baseline configuration)
 *   - Operations teams track SP password / certificate expiries before
 *     they cause an outage (Tab 2 = Service Principal credentials)
 *
 * What this page is NOT:
 *
 *   - This page never POSTs / PATCHes / DELETEs. It cannot change tenant
 *     configuration or rotate any credential. Every action is a Graph GET.
 *   - It does not access the undocumented MS-DRS / provisioning APIs that
 *     AADInternals reaches for in its offensive code paths. Anything we
 *     surface comes from the public Graph v1.0 surface area.
 *
 * Authentication / scope:
 *
 *   - The page auto-uses the primary signed-in account's *active* tenant
 *     (the same one the operator picked in the global tenant switcher).
 *     Switching account is handled at the global level — no per-page
 *     selector to keep the surface simple.
 *
 * Permissions:
 *
 *   - Required: `Directory.Read.All` (default for any admin role)
 *   - Recommended: `Policy.Read.All` so we can read the security defaults
 *     + authorization policies. Without it, those checks degrade to
 *     "Unknown" with an inline banner.
 *   - Recommended: `RoleManagement.Read.Directory` so the SP admin-role
 *     cross-check works. Without it, all SPs render with hasAdminRole=false.
 *
 * Audit log:
 *
 *   - `action: "tenant_baseline_audit"` once Tab 1 finishes loading.
 *   - `action: "sp_credentials_audit"` once Tab 2 finishes loading.
 *   - `action: "tenant_baseline_snapshot_save"` when the operator saves a
 *     compliance baseline snapshot (Enhancement #1).
 *   - `action: "tenant_baseline_snapshot_clear"` when the snapshot is cleared.
 *   - `action: "tenant_baseline_filter_change"` on Tab 2 filter mutations
 *     (severity / type). Filter changes are inexpensive but recorded so a
 *     reviewer can reconstruct the operator's viewport at the time of audit.
 *
 * Enhancements added (per page-improvement spec):
 *
 *   - Persisted "compliance baseline" snapshot per tenant via usePersistedState
 *     (save + diff current vs saved + clear).
 *   - Drift badges (regressed / improved / changed) per finding card +
 *     aggregated counters in the tab summary row.
 *   - CSV / JSON export via shared ExportMenu (replaces ad-hoc CSV button).
 *   - URL-persisted filter (search / severity / type) on the SP tab via
 *     useUrlState — deep links preserve the operator's view.
 *   - Click-to-copy on tenant id, finding check id, SP appId + display name
 *     via shared CopyButton (replaces inline clipboard helpers).
 *   - "Open in Entra portal" deep link per finding + per SP row.
 *
 * Wiring tightening:
 *
 *   - Initial baseline probe uses useAbortableEffect (abort-on-unmount).
 *   - All ad-hoc clipboard / download utilities replaced with shared
 *     components.
 *   - No edits outside this folder (helpers extension is in
 *     tenant-baseline-helpers.ts).
 */
import * as React from "react";
import { AlertCircle, AlertTriangle, ArrowDownRight, ArrowUpRight, BellRing, Bookmark, CheckCircle2, ChevronDown, ChevronRight, Cloud, ExternalLink, FileCheck, GitCompare, Globe, History, Info, KeyRound, Loader2, RefreshCw, Save, Search, Shield, ShieldAlert, ShieldCheck, Sparkles, Trash2, Users, XCircle, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn, formatRelativeTime } from "@/lib/utils";
import { getActiveTenant, getGraphTokenForAccount } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState } from "../../store/store-context";
import { CopyButton } from "../shared/copy-button";
import { ExportMenu } from "../shared/export-menu";
import { TIER_ZERO_ROLE_TEMPLATE_IDS, buildComplianceEvidence, buildHistoryEntry, buildSnapshot, compareHistoryEntries, compareIsoDates, compareSeverityDesc, detectCloudEnvironmentFromToken, diffAgainstSnapshot, portalLinkForFinding, portalLinkForServicePrincipal, pushHistoryEntry, scoreCaPolicyDrift, scoreDefaultUserPermissions, scoreDomainsFederation, scoreFederationBackdoorDrift, scoreGuestInvitePolicy, scoreOnPremSync, scorePasswordProtection, scoreSecurityDefaults, scoreServicePrincipal, severityLabel, severityToBadgeVariant, summarizeDrift, tallySeverities, } from "./tenant-baseline-helpers";
// ===========================================================================
// Constants
// ===========================================================================
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SP_PAGE_SIZE = 999; // Graph max for $top on /servicePrincipals
const SEARCH_DEBOUNCE_MS = 150;
/** localStorage key prefix for the saved baseline snapshot (per-tenant). */
const SNAPSHOT_STORAGE_PREFIX = "tenant-baseline:snapshot:";
/** Schema version — bump if BaselineSnapshot shape changes. */
const SNAPSHOT_SCHEMA_VERSION = 1;
/** localStorage key prefix for the drift-history ring buffer (per-tenant). */
const HISTORY_STORAGE_PREFIX = "tenant-baseline:history:";
/** Schema version for the history ring — bump if BaselineHistoryEntry shape changes. */
const HISTORY_SCHEMA_VERSION = 1;
/** localStorage key for the global "alert me on drift" preference. Cross-tenant. */
const ALERT_ON_DRIFT_PREF_KEY = "tenant-baseline:alert-on-drift";
// Severity filter chips for Tab 2 — kept module-scoped so the chip strip
// component can render them without re-creating the array each render.
const SEVERITY_FILTER_OPTIONS = [
    "critical",
    "high",
    "medium",
    "ok",
    "info",
];
const SP_TYPE_OPTIONS = [
    "ManagedIdentity",
    "Application",
    "Legacy",
    "Unknown",
];
// ===========================================================================
// Small primitives
// ===========================================================================
/**
 * Visual icon for a severity tier. Used inside the finding cards on Tab 1
 * and as a leading element on each SP row in Tab 2.
 */
const SeverityIcon = ({ severity, className }) => {
    const cls = cn("h-4 w-4", className);
    switch (severity) {
        case "ok":
            return React.createElement(CheckCircle2, { className: cn(cls, "text-success"), "aria-hidden": true });
        case "critical":
        case "high":
            return React.createElement(XCircle, { className: cn(cls, "text-destructive"), "aria-hidden": true });
        case "medium":
            return (React.createElement(AlertTriangle, { className: cn(cls, "text-warning"), "aria-hidden": true }));
        case "low":
        case "info":
            return React.createElement(Info, { className: cn(cls, "text-info"), "aria-hidden": true });
        case "unknown":
        default:
            return (React.createElement(AlertCircle, { className: cn(cls, "text-muted-foreground"), "aria-hidden": true }));
    }
};
/** Severity badge — small, colour-coded. */
const SeverityBadge = ({ severity, }) => {
    return (React.createElement(Badge, { variant: severityToBadgeVariant(severity), className: "gap-1" },
        React.createElement(SeverityIcon, { severity: severity, className: "h-3 w-3" }),
        severityLabel(severity)));
};
/**
 * Tiny details/summary disclosure used inside a finding card. We use a
 * native <details> rather than a Radix accordion because (a) the page has
 * up to 18 of these on screen at once, and (b) we want them independently
 * collapsible without any focus-trap behaviour.
 */
const Expander = ({ label, children, defaultOpen }) => {
    return (React.createElement("details", { className: "group rounded-md border border-border bg-muted/30", open: defaultOpen },
        React.createElement("summary", { className: "flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-2xs font-medium text-muted-foreground hover:text-foreground" },
            React.createElement(ChevronRight, { className: "h-3 w-3 transition-transform group-open:rotate-90" }),
            label),
        React.createElement("div", { className: "border-t border-border px-2.5 py-2 text-xs leading-relaxed text-foreground" }, children)));
};
/** Pre-formatted JSON viewer used inside Expander. */
const JsonViewer = ({ value }) => {
    const text = React.useMemo(() => {
        try {
            return JSON.stringify(value, null, 2);
        }
        catch (_a) {
            return String(value);
        }
    }, [value]);
    return (React.createElement("div", { className: "relative" },
        React.createElement("div", { className: "absolute right-1 top-1" },
            React.createElement(CopyButton, { value: text, alwaysVisible: true, ariaLabel: "Copy raw Graph response to clipboard" })),
        React.createElement("pre", { className: "max-h-72 overflow-auto rounded bg-card p-2 font-mono text-2xs leading-snug text-foreground" }, text)));
};
// ===========================================================================
// Drift indicator (Enhancement: drift vs saved baseline)
// ===========================================================================
/**
 * Compact pill rendered on each finding card when a saved baseline exists.
 * - regressed: this run is WORSE than the saved baseline
 * - improved:  this run is BETTER than the saved baseline
 * - summary-changed: same severity but the human summary changed
 *   (e.g. extra detail in the finding text — worth a glance)
 * - new-check-introduced: this check id was added AFTER the saved baseline
 *   was captured. Rendered as an info pill so the operator knows the
 *   diff against an old baseline includes auditor schema additions.
 * - match: identical — no pill (we skip render)
 * - no-baseline: skipped (handled by caller)
 */
const DriftPill = ({ drift }) => {
    if (drift.status === "match" || drift.status === "no-baseline")
        return null;
    if (drift.status === "new-check-introduced") {
        return (React.createElement(TooltipProvider, { delayDuration: 300 },
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Badge, { variant: "info", className: "gap-1" },
                        React.createElement(Sparkles, { className: "h-3 w-3", "aria-hidden": true }),
                        "New check")),
                React.createElement(TooltipContent, { side: "top", className: "max-w-md text-2xs" }, "This check id wasn\u2019t present when the approved baseline snapshot was captured. Review it, then re-save the baseline so future drift comparisons include this signal."))));
    }
    if (drift.status === "regressed") {
        return (React.createElement(TooltipProvider, { delayDuration: 300 },
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                        React.createElement(ArrowUpRight, { className: "h-3 w-3", "aria-hidden": true }),
                        "Regressed")),
                React.createElement(TooltipContent, { side: "top", className: "max-w-md text-2xs" },
                    "Was ",
                    drift.baselineSeverity,
                    " in saved baseline \u2014 now worse."))));
    }
    if (drift.status === "improved") {
        return (React.createElement(TooltipProvider, { delayDuration: 300 },
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Badge, { variant: "success", className: "gap-1" },
                        React.createElement(ArrowDownRight, { className: "h-3 w-3", "aria-hidden": true }),
                        "Improved")),
                React.createElement(TooltipContent, { side: "top", className: "max-w-md text-2xs" },
                    "Was ",
                    drift.baselineSeverity,
                    " in saved baseline \u2014 now better."))));
    }
    // summary-changed
    return (React.createElement(TooltipProvider, { delayDuration: 300 },
        React.createElement(Tooltip, null,
            React.createElement(TooltipTrigger, { asChild: true },
                React.createElement(Badge, { variant: "warning", className: "gap-1" },
                    React.createElement(GitCompare, { className: "h-3 w-3", "aria-hidden": true }),
                    "Changed")),
            React.createElement(TooltipContent, { side: "top", className: "max-w-md text-2xs" },
                "Severity unchanged (",
                drift.baselineSeverity,
                ") but the underlying status text changed. Previous summary: \u201C",
                drift.baselineSummary,
                "\u201D."))));
};
/**
 * Sovereign-cloud sentinel banner (Signal C).
 *
 * Pure presentational. Reads the cloud env we already inferred from the
 * Graph token's `iss` claim and renders a one-line read-only banner. We
 * never probe other clouds.
 *
 * Detection inspired by:
 *   New folder/_AZURE_BYPASS_PLAYBOOK.md Phase 4 ("Cross-cloud: probe
 *     login.microsoftonline.us and login.partner.microsoftonline.cn").
 *   New folder/_bypass_tenant_switch.md §8.2 — defenders rarely correlate
 *     sign-in logs across clouds; cross-cloud guests are a documented
 *     pivot path.
 */
const SovereignCloudBanner = ({ cloudInfo, }) => {
    // Sovereign clouds use a warning-tinted banner; commercial uses a
    // neutral / muted shade. Unknown also gets the warning shade because
    // an unidentifiable issuer is itself a signal.
    const isSovereign = cloudInfo.environment === "AzureUSGovernment" ||
        cloudInfo.environment === "AzureChina" ||
        cloudInfo.environment === "AzureGermany";
    const isUnknown = cloudInfo.environment === "Unknown";
    return (React.createElement("div", { role: "status", "aria-label": `Active Microsoft cloud environment: ${cloudInfo.label}`, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs", isSovereign
            ? "border-warning/50 bg-warning/10 text-foreground"
            : isUnknown
                ? "border-warning/40 bg-muted/40 text-foreground"
                : "border-border bg-muted/30 text-muted-foreground") },
        React.createElement(Cloud, { className: "h-3.5 w-3.5", "aria-hidden": true }),
        React.createElement("span", { className: "font-semibold" }, cloudInfo.label),
        React.createElement("span", { className: "text-2xs text-muted-foreground" }, "\u2014 posture in this view reflects ONLY this cloud. Identities also present in other Microsoft clouds (Commercial / US Gov / China) must be audited separately."),
        cloudInfo.issuer && (React.createElement("span", { className: "ml-auto font-mono text-3xs text-muted-foreground" },
            "iss: ",
            cloudInfo.issuer))));
};
/**
 * Single baseline-check card — the visual unit on Tab 1. Renders the
 * severity icon + name + status, with three lazy expanders for the
 * three deeper sections (why it matters, remediation, raw response).
 *
 * Optional `drift` props in a drift pill ("Regressed" / "Improved" / "Changed")
 * vs the saved baseline, and `portalHref` adds an "Open in Entra portal"
 * deep-link button to the card header.
 */
const FindingCard = ({ finding, drift, portalLink }) => {
    const isDrift = drift.status === "regressed" ||
        drift.status === "improved" ||
        drift.status === "summary-changed" ||
        drift.status === "new-check-introduced";
    return (React.createElement(Card, { className: cn("overflow-hidden", drift.status === "regressed" && "border-destructive/60", drift.status === "improved" && "border-success/60", drift.status === "new-check-introduced" && "border-info/60") },
        React.createElement(CardHeader, { className: "space-y-1 pb-2" },
            React.createElement(CardTitle, { className: "flex flex-wrap items-center gap-2 text-sm" },
                React.createElement(SeverityIcon, { severity: finding.severity }),
                React.createElement("span", null, finding.name),
                React.createElement(SeverityBadge, { severity: finding.severity }),
                isDrift && React.createElement(DriftPill, { drift: drift }),
                React.createElement("span", { className: "group/copy ml-auto inline-flex items-center gap-1" },
                    React.createElement(CopyButton, { value: finding.id, ariaLabel: `Copy check id ${finding.id}` }),
                    React.createElement("a", { href: portalLink.href, target: "_blank", rel: "noreferrer noopener", "aria-label": portalLink.label, title: portalLink.label, className: "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" },
                        React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true })))),
            React.createElement(CardDescription, { className: "text-xs leading-relaxed" }, finding.summary)),
        React.createElement(CardContent, { className: "flex flex-col gap-1.5 pt-0" },
            React.createElement(Expander, { label: "Why it matters" },
                React.createElement("p", null, finding.whyItMatters)),
            React.createElement(Expander, { label: "Remediation" },
                React.createElement("pre", { className: "whitespace-pre-wrap font-sans text-xs leading-relaxed" }, finding.remediation)),
            React.createElement(Expander, { label: "Raw Graph response" }, finding.raw === undefined ? (React.createElement("p", { className: "text-muted-foreground" }, "No response captured. The probe likely failed before it could send a request \u2014 see the error banner above the tab.")) : (React.createElement(JsonViewer, { value: finding.raw }))),
            finding.error && (React.createElement(Alert, { variant: "warning", className: "py-2" },
                React.createElement(AlertTriangle, { className: "h-4 w-4" }),
                React.createElement(AlertDescription, { className: "text-2xs" }, finding.error))))));
};
function graphGet(path, token, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
        const resp = yield fetch(url, Object.assign({ method: "GET", headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
            } }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})));
        if (!resp.ok) {
            const body = yield resp.text().catch(() => "");
            throw new Error(`Graph GET ${path} failed: ${resp.status} ${body.slice(0, 200)}`);
        }
        return (yield resp.json());
    });
}
/**
 * Walk @odata.nextLink until exhausted. Returns the concatenated `value`
 * arrays. We don't go through the service-layer guardedFetch helper here
 * because this auditor page is one-shot per tab; using vanilla fetch
 * keeps the dependency surface small and avoids touching the shared
 * RequestGuard's rate-limit counters.
 */
function graphList(initialPath, token, opts) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const out = [];
        let url = initialPath;
        let safety = 0;
        while (url) {
            if (safety++ > 100) {
                throw new Error("Graph list pagination exceeded safety cap (100 pages)");
            }
            const page = yield graphGet(url, token, opts);
            if (Array.isArray(page.value)) {
                out.push(...page.value);
            }
            url = (_a = page["@odata.nextLink"]) !== null && _a !== void 0 ? _a : null;
        }
        return out;
    });
}
/**
 * Token expiry derived from the JWT exp claim. We never decode the
 * signature — this is only used for the in-app "token expires in Xm"
 * pill. If the token can't be parsed (e.g. opaque token from an
 * imported source), returns null.
 */
function tokenSecondsUntilExpiry(token) {
    const parts = token.split(".");
    if (parts.length < 2)
        return null;
    try {
        const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = payload.length % 4;
        const padded = pad ? payload + "=".repeat(4 - pad) : payload;
        const decoded = typeof atob === "function"
            ? atob(padded)
            : Buffer.from(padded, "base64").toString("utf8");
        const json = JSON.parse(decoded);
        if (typeof json.exp !== "number")
            return null;
        return Math.max(0, json.exp - Math.floor(Date.now() / 1000));
    }
    catch (_a) {
        return null;
    }
}
/**
 * Hidden ARIA-live region that announces drift outcomes to assistive
 * tech. We render whenever the operator has the "Alert on drift"
 * preference enabled AND a baseline snapshot exists. The region is
 * visually hidden (no on-screen overlap) but kept in the DOM so
 * `aria-live` semantics fire on text mutation.
 *
 * The visible drift counters in the toolbar above are sufficient for
 * sighted operators; this region is a secondary channel that announces
 * the SAME information politely (no focus theft, no role="alert" panic
 * tone) to anyone running NVDA / JAWS / VoiceOver.
 */
const DriftLiveRegion = ({ enabled, summary, hasBaseline }) => {
    // Compose the human announcement.
    const announcement = React.useMemo(() => {
        if (!enabled || !hasBaseline)
            return "";
        const parts = [];
        if (summary.regressed > 0) {
            parts.push(`${summary.regressed} check${summary.regressed === 1 ? "" : "s"} regressed`);
        }
        if (summary.improved > 0) {
            parts.push(`${summary.improved} check${summary.improved === 1 ? "" : "s"} improved`);
        }
        if (summary.changed > 0) {
            parts.push(`${summary.changed} check${summary.changed === 1 ? "" : "s"} changed summary`);
        }
        if (summary.newlyIntroduced > 0) {
            parts.push(`${summary.newlyIntroduced} new check${summary.newlyIntroduced === 1 ? "" : "s"} since baseline`);
        }
        if (parts.length === 0) {
            return "Tenant baseline matches saved snapshot — no drift detected.";
        }
        return `Tenant baseline drift: ${parts.join(", ")}.`;
    }, [enabled, hasBaseline, summary]);
    return (React.createElement(React.Fragment, null,
        enabled && hasBaseline && summary.hasRegressions && (React.createElement(Alert, { variant: "warning", role: "status" },
            React.createElement(BellRing, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, { className: "text-2xs leading-relaxed" },
                React.createElement("strong", null, "Drift detected:"),
                " ",
                summary.regressed,
                " check",
                summary.regressed === 1 ? "" : "s",
                " regressed since the saved baseline. Review the cards marked \u201CRegressed\u201D below and re-save the baseline only after confirming the changes are intentional."))),
        React.createElement("div", { "aria-live": "polite", "aria-atomic": "true", className: "sr-only", "data-testid": "tenant-baseline-drift-live-region" }, announcement)));
};
/**
 * Drift-history timeline — small horizontal strip of severity heat-cells,
 * one per persisted history entry. The most recent entry is on the right;
 * the leftmost cell is the oldest. Cells colour-code by the worst
 * severity in that run's tally (critical → high → medium → ok), and a
 * bookmark icon marks the entry that was the approved baseline.
 *
 * Pure presentational — the parent owns the ring buffer.
 *
 * Why this exists (corpus framing):
 *   Drift on the federation backdoor / CA policy axes is often slow-moving
 *   (`_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface" — an
 *   attacker who has Global Admin for 5 minutes can flip CA off, then
 *   wait days to use the bypass). Without a longitudinal record, a one-
 *   shot audit only catches the live state. The timeline gives the
 *   defender the "what did it look like 2 weeks ago" view without any
 *   backend.
 */
const HistoryTimeline = ({ history, approvedAt }) => {
    if (history.length === 0)
        return null;
    // Worst-severity helper — pure local function so the timeline can sort
    // colours consistently with the per-card SeverityBadge.
    const worstSeverity = (tally) => {
        if (tally.critical > 0)
            return "critical";
        if (tally.high > 0)
            return "high";
        if (tally.medium > 0)
            return "medium";
        if (tally.low > 0)
            return "low";
        if (tally.unknown > 0)
            return "unknown";
        if (tally.ok > 0)
            return "ok";
        return "info";
    };
    // Compute the delta vs the immediately-previous entry — used for the
    // tooltip "got worse / got better".
    const deltas = React.useMemo(() => {
        const out = [];
        for (let i = 0; i < history.length; i += 1) {
            if (i === 0) {
                out.push({ delta: 0, regressed: 0, improved: 0 });
                continue;
            }
            const prev = history[i - 1];
            const cur = history[i];
            const cmp = compareHistoryEntries(prev, cur);
            out.push({
                delta: cmp.delta,
                regressed: cmp.regressed.length,
                improved: cmp.improved.length,
            });
        }
        return out;
    }, [history]);
    return (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-2xs", role: "region", "aria-label": "Tenant baseline drift history timeline" },
        React.createElement(History, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
        React.createElement("span", { className: "font-semibold text-foreground" }, "History"),
        React.createElement("span", { className: "text-muted-foreground" },
            "(",
            history.length,
            " run",
            history.length === 1 ? "" : "s",
            " on device)"),
        React.createElement("div", { className: "ml-1 flex items-center gap-0.5" }, history.map((h, i) => {
            const worst = worstSeverity(h.tally);
            const variant = severityToBadgeVariant(worst);
            const delta = deltas[i];
            const isApproved = approvedAt !== null && h.capturedAt === approvedAt;
            const label = `${new Date(h.capturedAt).toLocaleString()} — worst: ${severityLabel(worst)}${delta.delta !== 0
                ? `, delta vs prior run: ${delta.delta > 0 ? "+" : ""}${delta.delta} (${delta.regressed} regressed, ${delta.improved} improved)`
                : ""}${isApproved ? " — approved baseline" : ""}`;
            return (React.createElement(TooltipProvider, { key: `${h.capturedAt}-${i}`, delayDuration: 200 },
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", { className: cn("inline-flex h-4 w-4 cursor-default items-center justify-center rounded-sm border", 
                            // Variant-driven background so the cell colour matches
                            // the same severity vocabulary the cards use.
                            variant === "destructive" && "border-destructive/40 bg-destructive/30", variant === "warning" && "border-warning/40 bg-warning/30", variant === "info" && "border-info/40 bg-info/30", variant === "success" && "border-success/40 bg-success/30", variant === "secondary" && "border-border bg-muted/60", variant === "outline" && "border-border bg-card", isApproved && "ring-1 ring-primary"), "aria-label": label }, isApproved && (React.createElement(Bookmark, { className: "h-2.5 w-2.5 text-primary", "aria-hidden": true })))),
                    React.createElement(TooltipContent, { side: "top", className: "max-w-md text-2xs" }, label))));
        })),
        React.createElement("span", { className: "ml-1 text-3xs text-muted-foreground" }, "oldest \u2192 newest")));
};
/** Export columns for the baseline matrix CSV (Enhancement: CSV via ExportMenu). */
const BASELINE_EXPORT_COLUMNS = [
    { header: "id", accessor: (f) => f.id },
    { header: "name", accessor: (f) => f.name },
    { header: "severity", accessor: (f) => f.severity },
    { header: "summary", accessor: (f) => f.summary },
    { header: "error", accessor: (f) => { var _a; return (_a = f.error) !== null && _a !== void 0 ? _a : ""; } },
];
const BaselineTab = ({ state, onRefresh, tenantId, tenantDisplayName, snapshot, onSaveSnapshot, onClearSnapshot, history, alertOnDrift, onToggleAlertOnDrift, onExportEvidence, isExportingEvidence, refreshButtonRef, exportMenuButtonRef, }) => {
    var _a;
    const tally = React.useMemo(() => tallySeverities(state.findings), [
        state.findings,
    ]);
    // Per-id drift map vs the saved baseline. useMemo so the per-card
    // re-render only happens when findings OR snapshot change.
    const driftMap = React.useMemo(() => diffAgainstSnapshot(state.findings, snapshot), [state.findings, snapshot]);
    // Single-pass drift summary (regressed / improved / changed / newly-
    // introduced). The helper is pure + module-scoped — same input always
    // yields the same counts which means the surrounding memo + the audit
    // log "this run drifted vs baseline" record line up byte-for-byte.
    const driftSummary = React.useMemo(() => summarizeDrift(driftMap), [driftMap]);
    // Cached portal-link map per check id. Stable references mean FindingCard
    // memos (if introduced later) won't tear on parent re-renders.
    const portalLinks = React.useMemo(() => {
        const out = {
            "security-defaults": portalLinkForFinding("security-defaults", tenantId),
            "guest-invite-policy": portalLinkForFinding("guest-invite-policy", tenantId),
            "default-user-permissions": portalLinkForFinding("default-user-permissions", tenantId),
            "domains-federation": portalLinkForFinding("domains-federation", tenantId),
            // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md
            // "Critical Defender Audit Surface" item 1; corresponds to the
            // federation-backdoor-drift baseline finding.
            "federation-backdoor-drift": portalLinkForFinding("federation-backdoor-drift", tenantId),
            // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md
            // "Critical Defender Audit Surface" item 2.
            "ca-policy-drift": portalLinkForFinding("ca-policy-drift", tenantId),
            "onprem-sync": portalLinkForFinding("onprem-sync", tenantId),
            "password-protection": portalLinkForFinding("password-protection", tenantId),
        };
        return out;
    }, [tenantId]);
    const jsonMetadata = React.useMemo(() => ({
        tenantId,
        tenantDisplayName,
        capturedAt: new Date().toISOString(),
        summary: tally,
        drift: driftSummary,
        hasSavedBaseline: snapshot !== null,
    }), [tenantId, tenantDisplayName, tally, driftSummary, snapshot]);
    return (React.createElement("div", { className: "flex flex-col gap-3" },
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement(Badge, { variant: "outline", className: "gap-1" },
                React.createElement(Shield, { className: "h-3 w-3", "aria-hidden": true }),
                state.findings.length,
                " check",
                state.findings.length === 1 ? "" : "s"),
            tally.critical > 0 && (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                tally.critical,
                " critical")),
            tally.high > 0 && (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                React.createElement(XCircle, { className: "h-3 w-3", "aria-hidden": true }),
                tally.high,
                " high")),
            tally.medium > 0 && (React.createElement(Badge, { variant: "warning", className: "gap-1" },
                React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true }),
                tally.medium,
                " medium")),
            tally.low > 0 && (React.createElement(Badge, { variant: "info", className: "gap-1" },
                React.createElement(Info, { className: "h-3 w-3", "aria-hidden": true }),
                tally.low,
                " low")),
            tally.ok > 0 && (React.createElement(Badge, { variant: "success", className: "gap-1" },
                React.createElement(CheckCircle2, { className: "h-3 w-3", "aria-hidden": true }),
                tally.ok,
                " ok")),
            tally.unknown > 0 && (React.createElement(Badge, { variant: "secondary", className: "gap-1" },
                React.createElement(AlertCircle, { className: "h-3 w-3", "aria-hidden": true }),
                tally.unknown,
                " unknown")),
            snapshot && driftSummary.regressed > 0 && (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                React.createElement(ArrowUpRight, { className: "h-3 w-3", "aria-hidden": true }),
                driftSummary.regressed,
                " regressed")),
            snapshot && driftSummary.improved > 0 && (React.createElement(Badge, { variant: "success", className: "gap-1" },
                React.createElement(ArrowDownRight, { className: "h-3 w-3", "aria-hidden": true }),
                driftSummary.improved,
                " improved")),
            snapshot && driftSummary.changed > 0 && (React.createElement(Badge, { variant: "warning", className: "gap-1" },
                React.createElement(GitCompare, { className: "h-3 w-3", "aria-hidden": true }),
                driftSummary.changed,
                " changed")),
            snapshot && driftSummary.newlyIntroduced > 0 && (React.createElement(Badge, { variant: "info", className: "gap-1" },
                React.createElement(Sparkles, { className: "h-3 w-3", "aria-hidden": true }),
                driftSummary.newlyIntroduced,
                " new check",
                driftSummary.newlyIntroduced === 1 ? "" : "s")),
            React.createElement("div", { className: "ml-auto flex items-center gap-2" },
                state.lastRefreshedAt && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    "Refreshed ",
                    formatRelativeTime(new Date(state.lastRefreshedAt)))),
                React.createElement("span", { ref: exportMenuButtonRef, className: "inline-flex" },
                    React.createElement(ExportMenu, { rows: state.findings, columns: BASELINE_EXPORT_COLUMNS, filename: `tenant-baseline-${tenantId.slice(0, 8)}`, jsonMetadata: jsonMetadata, disabled: state.findings.length === 0, label: "Export" })),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: onExportEvidence, disabled: state.findings.length === 0 || state.loading || isExportingEvidence, "aria-label": "Export compliance evidence with SHA-256 hash", title: "Export findings as a signed compliance-evidence envelope. Embeds a SHA-256 hash over the canonical findings JSON so an auditor can detect post-hoc tampering." },
                    isExportingEvidence ? (React.createElement(Loader2, { className: "animate-spin" })) : (React.createElement(FileCheck, null)),
                    "Evidence"),
                React.createElement(Button, { type: "button", variant: alertOnDrift ? "default" : "outline", size: "sm", onClick: () => onToggleAlertOnDrift(!alertOnDrift), "aria-pressed": alertOnDrift, "aria-label": alertOnDrift
                        ? "Disable drift alert banner"
                        : "Enable drift alert banner", title: "Toggle screen-reader-announced drift banner. When ON, any regression in this run triggers a polite ARIA live announcement." },
                    React.createElement(BellRing, null),
                    "Alert on drift"),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: onSaveSnapshot, disabled: state.findings.length === 0 || state.loading, "aria-label": "Save current findings as compliance baseline snapshot (hotkey s)", title: "Save current findings as the approved compliance baseline. Future refreshes show drift against this snapshot. Hotkey: s" },
                    React.createElement(Save, null),
                    "Save baseline"),
                snapshot && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: onClearSnapshot, "aria-label": "Clear the saved baseline snapshot (hotkey c)", title: `Clear saved baseline (captured ${formatRelativeTime(new Date(snapshot.capturedAt))}). Hotkey: c` },
                    React.createElement(Trash2, null),
                    "Clear baseline")),
                React.createElement(Button, { ref: refreshButtonRef, type: "button", variant: "outline", size: "sm", onClick: onRefresh, disabled: state.loading, "aria-label": "Re-run baseline probes" },
                    state.loading ? (React.createElement(Loader2, { className: "animate-spin" })) : (React.createElement(RefreshCw, null)),
                    "Refresh"))),
        React.createElement(DriftLiveRegion, { enabled: alertOnDrift, summary: driftSummary, hasBaseline: snapshot !== null }),
        history.length > 0 && (React.createElement(HistoryTimeline, { history: history, approvedAt: (_a = snapshot === null || snapshot === void 0 ? void 0 : snapshot.capturedAt) !== null && _a !== void 0 ? _a : null })),
        snapshot && (React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-2xs text-muted-foreground" },
            React.createElement(Bookmark, { className: "h-3 w-3", "aria-hidden": true }),
            React.createElement("span", null,
                "Comparing against baseline saved",
                " ",
                React.createElement("span", { className: "font-medium text-foreground" }, formatRelativeTime(new Date(snapshot.capturedAt))),
                " ",
                "(for tenant ",
                snapshot.tenantDisplayName,
                ")"))),
        state.globalError && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(XCircle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, null, state.globalError))),
        state.permissionWarnings.length > 0 && (React.createElement(Alert, { variant: "warning" },
            React.createElement(AlertTriangle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, null,
                "Some checks could not run because the signed-in account is missing Graph permissions. The corresponding cards below will render with severity = Unknown.",
                React.createElement("ul", { className: "ml-4 mt-1 list-disc text-2xs" }, state.permissionWarnings.map((w) => (React.createElement("li", { key: w }, w))))))),
        React.createElement("div", { className: "grid grid-cols-1 gap-3 md:grid-cols-2" }, state.loading && state.findings.length === 0 ? (React.createElement(Card, { className: "md:col-span-2" },
            React.createElement(CardContent, { className: "flex items-center gap-2 py-8 text-sm text-muted-foreground" },
                React.createElement(Loader2, { className: "h-4 w-4 animate-spin" }),
                "Probing tenant baseline configuration\u2026"))) : (state.findings.map((f) => {
            var _a;
            return (React.createElement(FindingCard, { key: f.id, finding: f, drift: (_a = driftMap.get(f.id)) !== null && _a !== void 0 ? _a : {
                    status: "no-baseline",
                    baselineSeverity: null,
                    baselineSummary: null,
                }, portalLink: portalLinks[f.id] }));
        })))));
};
/** CSV columns for SP credentials export (Enhancement: ExportMenu). */
const SP_EXPORT_COLUMNS = [
    { header: "displayName", accessor: (r) => r.displayName },
    { header: "appId", accessor: (r) => r.appId },
    { header: "id", accessor: (r) => r.id },
    { header: "type", accessor: (r) => r.type },
    { header: "accountEnabled", accessor: (r) => r.accountEnabled },
    { header: "totalCredentials", accessor: (r) => r.totalCredentials },
    { header: "earliestExpiry", accessor: (r) => { var _a; return (_a = r.earliestExpiry) !== null && _a !== void 0 ? _a : ""; } },
    {
        header: "daysUntilEarliest",
        accessor: (r) => { var _a; return (_a = r.daysUntilEarliestExpiry) !== null && _a !== void 0 ? _a : ""; },
    },
    { header: "hasExpired", accessor: (r) => r.hasExpired },
    { header: "hasAdminRole", accessor: (r) => r.hasAdminRole },
    { header: "severity", accessor: (r) => r.severity },
    { header: "summary", accessor: (r) => r.severitySummary },
];
const SpTab = ({ state, onRefresh, tenantId, tenantDisplayName, actor, }) => {
    var _a;
    // Filter state — URL-persisted via useUrlState so deep links preserve
    // the operator's view (Enhancement: URL-persisted filter).
    // `keysKey` parameters are render-stable: the literal arrays here pass
    // through useUrlState's fingerprint-by-content guard.
    const URL_STATE_INITIAL = React.useMemo(() => ({ q: "", sev: [], type: [] }), []);
    const [urlState, setUrlState] = useUrlState(URL_STATE_INITIAL, {
        replace: true,
    });
    // Local "typing" copy of the search input for debouncing — only the
    // debounced value is pushed to the URL.
    const [searchInput, setSearchInput] = React.useState(() => { var _a; return (_a = urlState.q) !== null && _a !== void 0 ? _a : ""; });
    // Keep the input in sync if URL changes (e.g. browser back/forward).
    React.useEffect(() => {
        var _a;
        const next = (_a = urlState.q) !== null && _a !== void 0 ? _a : "";
        setSearchInput((cur) => (cur === next ? cur : next));
    }, [urlState.q]);
    // Debounce typing → URL.
    React.useEffect(() => {
        const id = setTimeout(() => {
            var _a;
            const current = (_a = urlState.q) !== null && _a !== void 0 ? _a : "";
            if (current !== searchInput) {
                setUrlState({ q: searchInput });
            }
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(id);
        // urlState.q intentionally NOT in deps — we mirror local→url only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchInput, setUrlState]);
    // Derive Sets from the URL string arrays.
    const severityFilter = React.useMemo(() => {
        var _a;
        const raw = (_a = urlState.sev) !== null && _a !== void 0 ? _a : [];
        return new Set(raw.filter((v) => SEVERITY_FILTER_OPTIONS.includes(v)));
    }, [urlState.sev]);
    const typeFilter = React.useMemo(() => {
        var _a;
        const raw = (_a = urlState.type) !== null && _a !== void 0 ? _a : [];
        return new Set(raw.filter((v) => SP_TYPE_OPTIONS.includes(v)));
    }, [urlState.type]);
    const searchQuery = (_a = urlState.q) !== null && _a !== void 0 ? _a : "";
    // Stable setters that also audit-log the filter mutation. The audit
    // entry is intentionally lightweight — we don't enumerate SPs, only
    // record that the operator narrowed/widened the view.
    const setSeverityFilter = React.useCallback((updater) => {
        const next = updater(severityFilter);
        const arr = Array.from(next);
        setUrlState({ sev: arr });
        auditLog.record({
            actor,
            action: "tenant_baseline_filter_change",
            target: tenantId,
            status: "success",
            details: {
                tab: "sp",
                filter: "severity",
                value: arr,
            },
        });
    }, [severityFilter, setUrlState, actor, tenantId]);
    const setTypeFilter = React.useCallback((updater) => {
        const next = updater(typeFilter);
        const arr = Array.from(next);
        setUrlState({ type: arr });
        auditLog.record({
            actor,
            action: "tenant_baseline_filter_change",
            target: tenantId,
            status: "success",
            details: {
                tab: "sp",
                filter: "type",
                value: arr,
            },
        });
    }, [typeFilter, setUrlState, actor, tenantId]);
    // Sort + filter + summary.
    const filteredRows = React.useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        let rows = state.rows;
        if (severityFilter.size > 0) {
            rows = rows.filter((r) => severityFilter.has(r.severity));
        }
        if (typeFilter.size > 0) {
            rows = rows.filter((r) => typeFilter.has(r.type));
        }
        if (q) {
            rows = rows.filter((r) => {
                return (r.displayName.toLowerCase().includes(q) ||
                    r.appId.toLowerCase().includes(q) ||
                    r.id.toLowerCase().includes(q));
            });
        }
        // Sort: severity desc, then earliest expiry asc (null last).
        return rows.slice().sort((a, b) => {
            const sev = compareSeverityDesc(a.severity, b.severity);
            if (sev !== 0)
                return sev;
            return compareIsoDates(a.earliestExpiry, b.earliestExpiry);
        });
    }, [state.rows, severityFilter, typeFilter, searchQuery]);
    const stats = React.useMemo(() => {
        let total = 0;
        let expiring30 = 0;
        let expired = 0;
        let withAdmin = 0;
        let noCreds = 0;
        for (const r of state.rows) {
            total += 1;
            if (r.hasExpired)
                expired += 1;
            else if (r.daysUntilEarliestExpiry !== null &&
                r.daysUntilEarliestExpiry < 30)
                expiring30 += 1;
            if (r.hasAdminRole)
                withAdmin += 1;
            if (r.totalCredentials === 0)
                noCreds += 1;
        }
        return { total, expiring30, expired, withAdmin, noCreds };
    }, [state.rows]);
    const exportMetadata = React.useMemo(() => ({
        tenantId,
        tenantDisplayName,
        capturedAt: new Date().toISOString(),
        summary: stats,
        filtersApplied: {
            search: searchQuery,
            severity: Array.from(severityFilter),
            type: Array.from(typeFilter),
        },
    }), [tenantId, tenantDisplayName, stats, searchQuery, severityFilter, typeFilter]);
    return (React.createElement("div", { className: "flex flex-col gap-3" },
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement(Badge, { variant: "outline", className: "gap-1" },
                React.createElement(Users, { className: "h-3 w-3", "aria-hidden": true }),
                stats.total,
                " total"),
            stats.expired > 0 && (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                React.createElement(XCircle, { className: "h-3 w-3", "aria-hidden": true }),
                stats.expired,
                " already expired")),
            stats.expiring30 > 0 && (React.createElement(Badge, { variant: "warning", className: "gap-1" },
                React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true }),
                stats.expiring30,
                " expiring < 30d")),
            stats.withAdmin > 0 && (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                stats.withAdmin,
                " with admin role")),
            stats.noCreds > 0 && (React.createElement(Badge, { variant: "secondary", className: "gap-1" },
                React.createElement(Info, { className: "h-3 w-3", "aria-hidden": true }),
                stats.noCreds,
                " with no creds")),
            React.createElement("div", { className: "ml-auto flex items-center gap-2" },
                state.lastRefreshedAt && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    "Refreshed ",
                    formatRelativeTime(new Date(state.lastRefreshedAt)))),
                React.createElement(ExportMenu, { rows: filteredRows, columns: SP_EXPORT_COLUMNS, filename: `sp-credentials-${tenantId.slice(0, 8)}`, jsonMetadata: exportMetadata, disabled: filteredRows.length === 0, label: "Export" }),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: onRefresh, disabled: state.loading, "aria-label": "Re-run service principal probe" },
                    state.loading ? (React.createElement(Loader2, { className: "animate-spin" })) : (React.createElement(RefreshCw, null)),
                    "Refresh"))),
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement("div", { className: "relative max-w-md flex-1" },
                React.createElement(Search, { className: "absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" }),
                React.createElement(Input, { value: searchInput, onChange: (e) => setSearchInput(e.target.value), placeholder: "Search by name, app id, or object id\u2026", className: "pl-7 text-xs", "aria-label": "Search service principals" })),
            React.createElement(DropdownMenu, null,
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm" },
                        "Severity",
                        severityFilter.size > 0 && (React.createElement(Badge, { variant: "secondary", className: "ml-1.5" }, severityFilter.size)),
                        React.createElement(ChevronDown, { className: "ml-1" }))),
                React.createElement(DropdownMenuContent, { align: "end", className: "w-48" },
                    React.createElement(DropdownMenuLabel, null, "Filter by severity"),
                    React.createElement(DropdownMenuSeparator, null),
                    SEVERITY_FILTER_OPTIONS.map((s) => (React.createElement(DropdownMenuCheckboxItem, { key: s, checked: severityFilter.has(s), onCheckedChange: (checked) => {
                            setSeverityFilter((prev) => {
                                const next = new Set(prev);
                                if (checked)
                                    next.add(s);
                                else
                                    next.delete(s);
                                return next;
                            });
                        } },
                        React.createElement("span", { className: "flex items-center gap-1.5" },
                            React.createElement(SeverityIcon, { severity: s, className: "h-3 w-3" }),
                            severityLabel(s))))),
                    React.createElement(DropdownMenuSeparator, null),
                    React.createElement(DropdownMenuCheckboxItem, { checked: false, onCheckedChange: () => setSeverityFilter(() => new Set()) }, "Clear all"))),
            React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Filter by service principal type" }, SP_TYPE_OPTIONS.map((t) => {
                const active = typeFilter.has(t);
                return (React.createElement("button", { key: t, type: "button", onClick: () => {
                        setTypeFilter((prev) => {
                            const next = new Set(prev);
                            if (next.has(t))
                                next.delete(t);
                            else
                                next.add(t);
                            return next;
                        });
                    }, "aria-pressed": active, className: cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors", active
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground") }, t));
            }))),
        state.error && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(XCircle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, null, state.error))),
        state.roleEnumerationFailed && (React.createElement(Alert, { variant: "warning" },
            React.createElement(AlertTriangle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, null,
                "Could not enumerate directory-role memberships (needs",
                " ",
                React.createElement("code", { className: "font-mono" }, "RoleManagement.Read.Directory"),
                "). The \u201Cadmin role\u201D column will show false for every row."))),
        React.createElement("div", { className: "overflow-x-auto rounded-md border border-border" },
            React.createElement("table", { className: "w-full min-w-[900px] border-collapse text-xs" },
                React.createElement("thead", null,
                    React.createElement("tr", { className: "border-b border-border bg-muted/40 text-2xs uppercase tracking-wider text-muted-foreground" },
                        React.createElement("th", { className: "px-3 py-2 text-left" }, "Service Principal"),
                        React.createElement("th", { className: "px-3 py-2 text-left" }, "App ID"),
                        React.createElement("th", { className: "px-3 py-2 text-left" }, "Type"),
                        React.createElement("th", { className: "px-3 py-2 text-right" }, "# creds"),
                        React.createElement("th", { className: "px-3 py-2 text-left" }, "Earliest expiry"),
                        React.createElement("th", { className: "px-3 py-2 text-center" }, "Admin role"),
                        React.createElement("th", { className: "px-3 py-2 text-left" }, "Severity"))),
                React.createElement("tbody", null, state.loading && state.rows.length === 0 ? (React.createElement("tr", null,
                    React.createElement("td", { colSpan: 7, className: "px-3 py-8 text-center" },
                        React.createElement("span", { className: "inline-flex items-center gap-2 text-muted-foreground" },
                            React.createElement(Loader2, { className: "h-4 w-4 animate-spin" }),
                            "Loading service principals\u2026")))) : filteredRows.length === 0 ? (React.createElement("tr", null,
                    React.createElement("td", { colSpan: 7, className: "px-3 py-8 text-center text-muted-foreground" }, "No service principals match the current filters."))) : (filteredRows.map((r) => (React.createElement(SpRow, { key: r.id, row: r, tenantId: tenantId })))))))));
};
/**
 * One row in the SP credentials table. Splitting it out lets the
 * details/summary toggle hold its own state without re-rendering the
 * whole table when a single row is expanded.
 *
 * Memoised (deep-pass) so toggling one row's `expanded` state doesn't
 * cause every other row to re-render. Large tenants commonly have 800+
 * service principals; the previous unmemoised implementation produced a
 * visible scroll-jank on every chevron click. The custom `arePropsEqual`
 * comparator is intentionally shallow on `row` because the parent always
 * creates a fresh array from a `slice().sort()` — so a new array
 * reference is expected, but row IDENTITIES (and their internal severity
 * + credentials) are stable across filter-only changes.
 */
const SpRowInner = ({ row, tenantId, }) => {
    const [expanded, setExpanded] = React.useState(false);
    const portal = React.useMemo(() => portalLinkForServicePrincipal(row.appId, tenantId), [row.appId, tenantId]);
    const handleToggle = React.useCallback(() => setExpanded((v) => !v), []);
    return (React.createElement(React.Fragment, null,
        React.createElement("tr", { className: cn("border-b border-border hover:bg-muted/40", row.severity === "critical" && "bg-destructive/5") },
            React.createElement("td", { className: "px-3 py-2" },
                React.createElement("button", { type: "button", onClick: handleToggle, className: "inline-flex items-center gap-1.5 text-left text-foreground hover:underline", "aria-expanded": expanded, title: expanded ? "Hide credential details" : "Show credential details" },
                    React.createElement(ChevronRight, { className: cn("h-3 w-3 transition-transform", expanded && "rotate-90") }),
                    React.createElement("span", { className: "truncate" }, row.displayName || "(unnamed)"),
                    !row.accountEnabled && (React.createElement(Badge, { variant: "secondary", className: "ml-1 text-2xs" }, "disabled")),
                    row.displayName && (React.createElement(CopyButton, { value: row.displayName, ariaLabel: `Copy display name ${row.displayName}` })))),
            React.createElement("td", { className: "px-3 py-2" },
                React.createElement("div", { className: "group/copy flex items-center gap-1" },
                    React.createElement("code", { className: "truncate font-mono text-2xs text-muted-foreground" }, row.appId),
                    React.createElement(CopyButton, { value: row.appId, ariaLabel: `Copy app id for ${row.displayName}` }),
                    React.createElement("a", { href: portal.href, target: "_blank", rel: "noreferrer noopener", "aria-label": portal.label, title: portal.label, className: "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent/30 hover:text-foreground group-hover/copy:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" },
                        React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true })))),
            React.createElement("td", { className: "px-3 py-2" },
                React.createElement(Badge, { variant: row.type === "ManagedIdentity" ? "info" : "outline", className: "text-2xs" }, row.type)),
            React.createElement("td", { className: "px-3 py-2 text-right tabular-nums" }, row.totalCredentials),
            React.createElement("td", { className: "px-3 py-2" }, row.earliestExpiry ? (React.createElement("span", { className: "flex flex-col" },
                React.createElement("span", { className: cn("text-xs", row.hasExpired && "text-destructive") }, formatRelativeTime(row.earliestExpiry)),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, new Date(row.earliestExpiry).toLocaleDateString()))) : (React.createElement("span", { className: "text-2xs text-muted-foreground" }, "\u2014"))),
            React.createElement("td", { className: "px-3 py-2 text-center" }, row.hasAdminRole ? (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                "Tier 0")) : (React.createElement("span", { className: "text-2xs text-muted-foreground" }, "\u2014"))),
            React.createElement("td", { className: "px-3 py-2" },
                React.createElement(TooltipProvider, { delayDuration: 300 },
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", null,
                                React.createElement(SeverityBadge, { severity: row.severity }))),
                        React.createElement(TooltipContent, { side: "left", className: "max-w-md" }, row.severitySummary))))),
        expanded && (React.createElement("tr", { className: "border-b border-border bg-muted/20" },
            React.createElement("td", { colSpan: 7, className: "px-6 py-3" }, row.credentials.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "No client secrets or certificates configured.")) : (React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement("p", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                    "Credentials (",
                    row.credentials.length,
                    ")"),
                React.createElement("table", { className: "w-full text-2xs" },
                    React.createElement("thead", null,
                        React.createElement("tr", { className: "text-muted-foreground" },
                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Kind"),
                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Name"),
                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Key ID"),
                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Type / usage"),
                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Starts"),
                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Expires"))),
                    React.createElement("tbody", null, row.credentials.map((c, idx) => {
                        const isExpired = c.endDateTime
                            ? Date.parse(c.endDateTime) < Date.now()
                            : false;
                        return (React.createElement("tr", { key: `${c.keyId}-${idx}`, className: "border-t border-border" },
                            React.createElement("td", { className: "px-2 py-1" },
                                React.createElement(Badge, { variant: c.kind === "password" ? "outline" : "info", className: "text-2xs" }, c.kind === "password" ? "Secret" : "Cert")),
                            React.createElement("td", { className: "px-2 py-1" }, c.displayName),
                            React.createElement("td", { className: "px-2 py-1 font-mono text-3xs text-muted-foreground" }, c.keyId.slice(0, 8) || "—"),
                            React.createElement("td", { className: "px-2 py-1 text-muted-foreground" }, [c.type, c.usage].filter((s) => s).join(" / ") || "—"),
                            React.createElement("td", { className: "px-2 py-1 text-muted-foreground" }, c.startDateTime
                                ? new Date(c.startDateTime).toLocaleDateString()
                                : "—"),
                            React.createElement("td", { className: cn("px-2 py-1", isExpired
                                    ? "text-destructive"
                                    : "text-foreground") }, c.endDateTime
                                ? `${new Date(c.endDateTime).toLocaleDateString()} (${formatRelativeTime(c.endDateTime)})`
                                : "never")));
                    }))))))))));
};
/**
 * Memoised SpRow — re-renders only when `row` identity or `tenantId`
 * changes. Filter-only mutations in `SpTab` reuse the underlying scored
 * row objects (the filter chain calls `.slice().sort()` which preserves
 * row references), so this memo prevents an N-row re-render storm when
 * one row's local `expanded` state toggles.
 */
const SpRow = React.memo(SpRowInner, (prev, next) => prev.row === next.row && prev.tenantId === next.tenantId);
SpRow.displayName = "SpRow";
// ===========================================================================
// Probe orchestrators
// ===========================================================================
/**
 * Run all six baseline probes in parallel. Each probe captures its own
 * errors so a 403 on one probe never blocks the others.
 *
 * Returns the array of findings (in the canonical display order) plus a
 * list of human-readable "permission warning" strings for probes that
 * 403'd on a permission we'd recommend the operator request.
 */
function probeBaseline(token, signal) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        const permissionWarnings = [];
        // Run six probes in parallel; each captures its own failure.
        //
        // The CA probe is the per-policy "drift" enumeration used by Signal B
        // (`scoreCaPolicyDrift`). We request the fields the scorer cares about
        // up front so the snapshot envelope stays small.
        // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md
        // "Critical Defender Audit Surface" item 2 (`Update conditional access
        // policy` audit event).
        const CA_POLICY_SELECT = "id,displayName,state,createdDateTime,modifiedDateTime,conditions";
        const [secDefaultsRes, caPoliciesRes, authPolicyRes, orgRes, domainsRes, pwdPolicyRes,] = yield Promise.allSettled([
            graphGet("/policies/identitySecurityDefaultsEnforcementPolicy", token, { signal }),
            // Full CA enumeration — both for the "any CA exists?" boolean the
            // security-defaults scorer needs AND for the per-policy drift scorer.
            graphList(`/identity/conditionalAccess/policies?$select=${CA_POLICY_SELECT}&$top=100`, token, { signal }),
            graphGet("/policies/authorizationPolicy", token, {
                signal,
            }),
            graphGet("/organization", token, { signal }),
            graphList("/domains?$select=id,authenticationType,isDefault,isVerified,supportedServices", token, {
                signal,
            }),
            // Best-effort password policy on the initial domain. Most tenants 403
            // without Policy.Read.All — we surface that to the operator.
            (() => __awaiter(this, void 0, void 0, function* () {
                var _d, _e, _f;
                // Find the verified default domain first so the URL is correct.
                const orgResp = yield graphGet("/organization", token, { signal });
                const verified = (_e = (_d = orgResp.value) === null || _d === void 0 ? void 0 : _d[0]) !== null && _e !== void 0 ? _e : null;
                // Initial domain is the .onmicrosoft.com one; we'll prefer the
                // default verified domain if exposed.
                // The path `/domains/{id}/policies/passwordValidationPolicies` is
                // documented but commonly returns 403 outside Policy.Read.All.
                const domain = (_f = verified === null || verified === void 0 ? void 0 : verified.displayName) !== null && _f !== void 0 ? _f : null;
                void domain; // unused; kept for clarity that this is best-effort
                return graphGet("/domains/policies/passwordValidationPolicies", token, {
                    signal,
                });
            }))(),
        ]);
        // --- Security defaults -------------------------------------------------
        let secDefaultsFinding;
        let hasAnyCA;
        let caPolicies = null;
        let caPoliciesError = null;
        if (caPoliciesRes.status === "fulfilled") {
            caPolicies = caPoliciesRes.value;
            hasAnyCA = caPolicies.length > 0;
        }
        else {
            hasAnyCA = null;
            const msg = String(caPoliciesRes.reason instanceof Error
                ? caPoliciesRes.reason.message
                : caPoliciesRes.reason);
            caPoliciesError = msg;
            if (msg.includes("403")) {
                permissionWarnings.push("Could not enumerate Conditional Access policies — needs Policy.Read.All");
            }
        }
        if (secDefaultsRes.status === "fulfilled") {
            secDefaultsFinding = scoreSecurityDefaults({
                policy: secDefaultsRes.value,
                hasAnyConditionalAccess: hasAnyCA,
            });
        }
        else {
            const msg = String(secDefaultsRes.reason instanceof Error
                ? secDefaultsRes.reason.message
                : secDefaultsRes.reason);
            if (msg.includes("403")) {
                permissionWarnings.push("Could not read security defaults policy — needs Policy.Read.All");
            }
            secDefaultsFinding = Object.assign(Object.assign({}, scoreSecurityDefaults({
                policy: null,
                hasAnyConditionalAccess: hasAnyCA,
            })), { error: msg });
        }
        // --- Authorization policy (covers two findings) ------------------------
        const authPolicy = authPolicyRes.status === "fulfilled" ? authPolicyRes.value : null;
        if (authPolicyRes.status === "rejected") {
            const msg = String(authPolicyRes.reason instanceof Error
                ? authPolicyRes.reason.message
                : authPolicyRes.reason);
            if (msg.includes("403")) {
                permissionWarnings.push("Could not read /policies/authorizationPolicy — needs Policy.Read.All");
            }
        }
        const guestFinding = scoreGuestInvitePolicy(authPolicy);
        const defaultPermsFinding = scoreDefaultUserPermissions(authPolicy);
        if (authPolicyRes.status === "rejected") {
            const errMsg = String(authPolicyRes.reason instanceof Error
                ? authPolicyRes.reason.message
                : authPolicyRes.reason);
            guestFinding.error = errMsg;
            defaultPermsFinding.error = errMsg;
        }
        // --- Organization (on-prem sync) ---------------------------------------
        const org = orgRes.status === "fulfilled" ? ((_b = (_a = orgRes.value.value) === null || _a === void 0 ? void 0 : _a[0]) !== null && _b !== void 0 ? _b : null) : null;
        const onPremFinding = scoreOnPremSync(org);
        if (orgRes.status === "rejected") {
            const errMsg = String(orgRes.reason instanceof Error ? orgRes.reason.message : orgRes.reason);
            onPremFinding.error = errMsg;
        }
        // --- Domains -----------------------------------------------------------
        let domainsFinding;
        let federatedEntries = [];
        if (domainsRes.status === "fulfilled") {
            domainsFinding = scoreDomainsFederation(domainsRes.value);
            // Per-domain federation enrichment for Signal A (federation-backdoor).
            // Detection inspired by: New folder/_analysis_aadinternals.md §2.4
            // "The Federation Backdoor (`ConvertTo-Backdoor`)" — every federated
            // domain has a corresponding `internalDomainFederation` config object
            // that records `issuerUri`, `signingCertificate`, and modification
            // metadata. A *fresh* config on a *new* domain is the textbook signal.
            const fedDomains = domainsRes.value.filter((d) => { var _a; return ((_a = d.authenticationType) !== null && _a !== void 0 ? _a : "").toLowerCase() === "federated"; });
            federatedEntries = yield Promise.all(fedDomains.map((d) => __awaiter(this, void 0, void 0, function* () {
                var _g, _h, _j;
                const domain = ((_g = d.id) !== null && _g !== void 0 ? _g : "");
                try {
                    const cfg = yield graphGet(`/domains/${encodeURIComponent(domain)}/federationConfiguration`, token, { signal });
                    // The endpoint returns a collection; defenders typically have a
                    // single primary config per domain. Surface the first record but
                    // keep the rest in raw if anyone needs them.
                    const primary = (_j = (_h = cfg.value) === null || _h === void 0 ? void 0 : _h[0]) !== null && _j !== void 0 ? _j : null;
                    return {
                        domain,
                        isDefault: d.isDefault === true,
                        config: primary,
                        configError: null,
                    };
                }
                catch (err) {
                    const m = err instanceof Error ? err.message : String(err);
                    if (m.includes("403")) {
                        permissionWarnings.push("Could not read /domains/{id}/federationConfiguration — needs Domain.Read.All");
                    }
                    return {
                        domain,
                        isDefault: d.isDefault === true,
                        config: null,
                        configError: m,
                    };
                }
            })));
        }
        else {
            const errMsg = String(domainsRes.reason instanceof Error
                ? domainsRes.reason.message
                : domainsRes.reason);
            if (errMsg.includes("403")) {
                permissionWarnings.push("Could not enumerate domains — needs Domain.Read.All");
            }
            domainsFinding = Object.assign(Object.assign({}, scoreDomainsFederation(null)), { error: errMsg });
            federatedEntries = [];
        }
        // --- Signal A — Federation backdoor drift ------------------------------
        // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md "Critical
        // Defender Audit Surface" item 1 (`Set domain authentication`); New
        // folder/_analysis_aadinternals.md §2.4 (`ConvertTo-Backdoor`).
        const federationBackdoorFinding = scoreFederationBackdoorDrift({
            entries: federatedEntries,
        });
        // Inherit any blanket domain-enumeration error so the operator sees it
        // attached to *both* federation cards.
        if (domainsRes.status === "rejected") {
            federationBackdoorFinding.error =
                (_c = federationBackdoorFinding.error) !== null && _c !== void 0 ? _c : domainsFinding.error;
        }
        // --- Signal B — Conditional Access policy drift ------------------------
        // Detection inspired by: New folder/_AZURE_BYPASS_PLAYBOOK.md "Critical
        // Defender Audit Surface" item 2 (`Update conditional access policy`).
        const caDriftFinding = scoreCaPolicyDrift({
            policies: caPolicies,
            policiesError: caPoliciesError,
        });
        // --- Password protection ----------------------------------------------
        let pwdFinding;
        if (pwdPolicyRes.status === "fulfilled") {
            pwdFinding = scorePasswordProtection({
                policy: pwdPolicyRes.value,
                policyError: null,
            });
        }
        else {
            const errMsg = String(pwdPolicyRes.reason instanceof Error
                ? pwdPolicyRes.reason.message
                : pwdPolicyRes.reason);
            // This is the noisiest 403 by far — don't add to warnings unless we
            // can clearly attribute it to a permission gap.
            if (errMsg.includes("403")) {
                permissionWarnings.push("Could not read password protection policy — needs Policy.Read.All");
            }
            pwdFinding = scorePasswordProtection({
                policy: null,
                policyError: errMsg,
            });
        }
        return {
            findings: [
                secDefaultsFinding,
                // Signal B sits next to security-defaults because they answer
                // adjacent questions ("is anything enforcing MFA at all?" → "is
                // anything weakening the enforcement we have?").
                caDriftFinding,
                guestFinding,
                defaultPermsFinding,
                domainsFinding,
                // Signal A sits immediately after the legacy domain-federation
                // card so an operator scrolling through the matrix reads them as a
                // pair (count of federated domains → per-domain backdoor posture).
                federationBackdoorFinding,
                onPremFinding,
                pwdFinding,
            ],
            permissionWarnings: Array.from(new Set(permissionWarnings)),
        };
    });
}
/**
 * Enumerate every directory role + collect the set of principal ids
 * (users/groups/SPs) that are members. Returns a Set of SP-or-anything
 * object ids that hold ANY Tier 0 role. We don't differentiate further
 * — the SP scorer just needs a single "is this principal privileged" bit.
 */
function fetchTier0PrincipalIds(token, signal) {
    return __awaiter(this, void 0, void 0, function* () {
        // /directoryRoles only returns ACTIVATED roles in the tenant. For the
        // ones we care about (Global Admin, Privileged Role Admin) this is fine
        // — if no one has ever activated the role, no SP holds it either.
        const roles = yield graphList("/directoryRoles?$select=id,roleTemplateId", token, { signal });
        const tier0 = roles.filter((r) => { var _a; return TIER_ZERO_ROLE_TEMPLATE_IDS.has(((_a = r.roleTemplateId) !== null && _a !== void 0 ? _a : "")); });
        const principalIds = new Set();
        for (const r of tier0) {
            if (!r.id)
                continue;
            try {
                const members = yield graphList(`/directoryRoles/${encodeURIComponent(r.id)}/members?$select=id`, token, { signal });
                for (const m of members) {
                    if (m.id)
                        principalIds.add(m.id);
                }
            }
            catch (err) {
                // Don't kill the whole probe if a single role lookup fails.
                console.warn(`[tenant-baseline] tier-0 members lookup failed for role ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return principalIds;
    });
}
function probeServicePrincipals(token, signal) {
    return __awaiter(this, void 0, void 0, function* () {
        // Kick off both calls in parallel — SP enumeration is the long one.
        const tier0Promise = fetchTier0PrincipalIds(token, signal).catch(() => null);
        const select = "id,displayName,appId,servicePrincipalType,accountEnabled,keyCredentials,passwordCredentials,createdDateTime";
        const sps = yield graphList(`/servicePrincipals?$select=${select}&$top=${SP_PAGE_SIZE}`, token, { signal });
        const tier0 = yield tier0Promise;
        const roleEnumerationFailed = tier0 === null;
        const now = new Date();
        const rows = sps.map((sp) => scoreServicePrincipal({
            sp,
            hasAdminRole: tier0 !== null && !!sp.id && tier0.has(sp.id),
            now,
        }));
        return { rows, roleEnumerationFailed };
    });
}
/**
 * Top-level page export. Combines tenant-scope discovery, both tabs, and
 * a refresh control. Auto-loads both tabs when an active tenant is
 * available.
 */
export const TenantBaselinePage = () => {
    var _a;
    const state = useMultiRegionState();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    // Pick the first signed-in account's active tenant as the scope. The
    // global tenant switcher already covers cross-account flipping, so we
    // don't replicate it here.
    const primaryAccount = React.useMemo(() => {
        var _a;
        for (const a of azureAccounts) {
            if (!a.homeAccountId)
                continue;
            const tenant = (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : resolveActiveTenantId(a);
            if (tenant) {
                return {
                    homeAccountId: a.homeAccountId,
                    tenantId: tenant,
                    username: a.username,
                    name: a.name || a.username,
                };
            }
        }
        return null;
    }, [azureAccounts]);
    // Sync token expiry for the header pill. We re-acquire on every refresh
    // so the badge tracks the latest token — not the very first one we got.
    const [tokenExpiresInSec, setTokenExpiresInSec] = React.useState(null);
    // Signal C — Sovereign-cloud sentinel.
    //
    // We derive the active cloud environment from the `iss` claim of the
    // most-recent Graph token. Pure presentational — we never probe other
    // clouds.
    //
    // Detection inspired by:
    //   New folder/_AZURE_BYPASS_PLAYBOOK.md Phase 4 (Cross-cloud pivots).
    //   New folder/_bypass_tenant_switch.md §8 "Sovereign / Cross-Cloud
    //     Pivots" — defenders rarely correlate sign-in logs across clouds.
    const [cloudInfo, setCloudInfo] = React.useState(null);
    // Tab state.
    const [baselineState, setBaselineState] = React.useState({
        loading: false,
        findings: [],
        globalError: null,
        permissionWarnings: [],
        lastRefreshedAt: null,
    });
    const [spState, setSpState] = React.useState({
        loading: false,
        rows: [],
        error: null,
        lastRefreshedAt: null,
        roleEnumerationFailed: false,
    });
    // Persisted compliance baseline snapshot (Enhancement #1).
    // The key embeds the tenant id so multi-tenant operators get a separate
    // snapshot per tenant. usePersistedState handles the key change correctly
    // — when the operator flips tenants in the global switcher, the hook
    // re-reads from localStorage with the new key.
    const snapshotKey = primaryAccount
        ? `${SNAPSHOT_STORAGE_PREFIX}${primaryAccount.tenantId}`
        : `${SNAPSHOT_STORAGE_PREFIX}__no_tenant__`;
    const [snapshot, setSnapshot, clearSnapshot] = usePersistedState(snapshotKey, null, {
        version: SNAPSHOT_SCHEMA_VERSION,
        // Bump to schema v2+ — coerce unknown shapes to null so we don't crash.
        migrate: (raw) => {
            if (raw == null || typeof raw !== "object")
                return null;
            const obj = raw;
            if (typeof obj.tenantId === "string" &&
                typeof obj.capturedAt === "string" &&
                obj.findings &&
                typeof obj.findings === "object") {
                return obj;
            }
            return null;
        },
    });
    // Per-tenant drift-history ring buffer (Deep-pass enhancement). Every
    // successful refresh appends a compact entry. The ring is capped in
    // helpers.ts so the localStorage envelope stays well under quota.
    const historyKey = primaryAccount
        ? `${HISTORY_STORAGE_PREFIX}${primaryAccount.tenantId}`
        : `${HISTORY_STORAGE_PREFIX}__no_tenant__`;
    const [history, setHistory] = usePersistedState(historyKey, [], {
        version: HISTORY_SCHEMA_VERSION,
        migrate: (raw) => {
            if (!Array.isArray(raw))
                return [];
            // Defensive shape coercion — drop entries that don't conform.
            return raw.filter((entry) => {
                if (!entry || typeof entry !== "object")
                    return false;
                const e = entry;
                return (typeof e.capturedAt === "string" &&
                    typeof e.tally === "object" &&
                    e.tally !== null &&
                    typeof e.perCheck === "object" &&
                    e.perCheck !== null);
            });
        },
    });
    // Global cross-tenant "alert me when posture regresses" preference.
    // Persisted as a plain boolean. Defaulting to ON because the cost is
    // negligible (one off-screen aria-live message) and the value is high
    // when a defender flips tenants between audits.
    const [alertOnDrift, setAlertOnDrift] = usePersistedState(ALERT_ON_DRIFT_PREF_KEY, true);
    // Per-tab last-fetch-wins guards. Without these, switching tabs +
    // refreshing while a slow probe is in-flight can clobber the new
    // results with the old.
    const baselineSeqRef = React.useRef(0);
    const spSeqRef = React.useRef(0);
    const refreshBaseline = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!primaryAccount)
            return;
        const seq = ++baselineSeqRef.current;
        const controller = new AbortController();
        setBaselineState((prev) => (Object.assign(Object.assign({}, prev), { loading: true, globalError: null })));
        try {
            const token = yield getGraphTokenForAccount(primaryAccount.homeAccountId, primaryAccount.tenantId);
            if (seq !== baselineSeqRef.current)
                return;
            setTokenExpiresInSec(tokenSecondsUntilExpiry(token));
            // Signal C — derive active cloud environment from the token's
            // `iss` claim. Read-only enumeration of OUR own token; we do not
            // probe sovereign endpoints.
            setCloudInfo(detectCloudEnvironmentFromToken(token));
            const { findings, permissionWarnings } = yield probeBaseline(token, controller.signal);
            if (seq !== baselineSeqRef.current)
                return;
            setBaselineState({
                loading: false,
                findings,
                globalError: null,
                permissionWarnings,
                lastRefreshedAt: Date.now(),
            });
            // Append a compact history entry on every successful refresh so the
            // timeline strip in the baseline tab tracks longitudinal drift
            // without a backend. `pushHistoryEntry` caps the ring at
            // BASELINE_HISTORY_LIMIT — older entries fall off the left.
            setHistory((prev) => pushHistoryEntry(prev, buildHistoryEntry(findings, false)));
            auditLog.record({
                actor: primaryAccount.username || primaryAccount.homeAccountId,
                action: "tenant_baseline_audit",
                target: primaryAccount.tenantId,
                status: "success",
                details: {
                    tenantId: primaryAccount.tenantId,
                    findingsCount: findings.length,
                    countsBySeverity: tallySeverities(findings),
                    permissionWarnings,
                },
            });
        }
        catch (err) {
            if (seq !== baselineSeqRef.current)
                return;
            const msg = err instanceof Error ? err.message : String(err);
            setBaselineState({
                loading: false,
                findings: [],
                globalError: msg,
                permissionWarnings: [],
                lastRefreshedAt: Date.now(),
            });
            auditLog.record({
                actor: primaryAccount.username || primaryAccount.homeAccountId,
                action: "tenant_baseline_audit",
                target: primaryAccount.tenantId,
                status: "failure",
                error: msg,
                details: { tenantId: primaryAccount.tenantId },
            });
        }
    }), [primaryAccount, setHistory]);
    const refreshSps = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!primaryAccount)
            return;
        const seq = ++spSeqRef.current;
        const controller = new AbortController();
        setSpState((prev) => (Object.assign(Object.assign({}, prev), { loading: true, error: null })));
        try {
            const token = yield getGraphTokenForAccount(primaryAccount.homeAccountId, primaryAccount.tenantId);
            if (seq !== spSeqRef.current)
                return;
            setTokenExpiresInSec(tokenSecondsUntilExpiry(token));
            // Signal C — derive active cloud environment from the token's
            // `iss` claim. Read-only enumeration of OUR own token; we do not
            // probe sovereign endpoints.
            setCloudInfo(detectCloudEnvironmentFromToken(token));
            const { rows, roleEnumerationFailed } = yield probeServicePrincipals(token, controller.signal);
            if (seq !== spSeqRef.current)
                return;
            setSpState({
                loading: false,
                rows,
                error: null,
                lastRefreshedAt: Date.now(),
                roleEnumerationFailed,
            });
            auditLog.record({
                actor: primaryAccount.username || primaryAccount.homeAccountId,
                action: "sp_credentials_audit",
                target: primaryAccount.tenantId,
                status: "success",
                details: {
                    tenantId: primaryAccount.tenantId,
                    spCount: rows.length,
                    countsBySeverity: tallySeverities(rows),
                    roleEnumerationFailed,
                },
            });
        }
        catch (err) {
            if (seq !== spSeqRef.current)
                return;
            const msg = err instanceof Error ? err.message : String(err);
            setSpState({
                loading: false,
                rows: [],
                error: msg,
                lastRefreshedAt: Date.now(),
                roleEnumerationFailed: false,
            });
            auditLog.record({
                actor: primaryAccount.username || primaryAccount.homeAccountId,
                action: "sp_credentials_audit",
                target: primaryAccount.tenantId,
                status: "failure",
                error: msg,
                details: { tenantId: primaryAccount.tenantId },
            });
        }
    }), [primaryAccount]);
    // Auto-load baseline on first render once we have a tenant. SP tab is
    // lazy-loaded only when the user opens it the first time to avoid the
    // 999-row Graph hit if they only care about the baseline.
    //
    // useAbortableEffect gives us correct cleanup if the operator unmounts
    // the page mid-probe (or if `primaryAccount` flips before the probe
    // finishes), without relying on the per-tab seq-ref guard alone.
    const baselineLoadedForTenantRef = React.useRef(null);
    useAbortableEffect(() => {
        if (!primaryAccount)
            return;
        if (baselineLoadedForTenantRef.current === primaryAccount.tenantId)
            return;
        baselineLoadedForTenantRef.current = primaryAccount.tenantId;
        // refreshBaseline owns its own AbortController via the sequence guard;
        // useAbortableEffect's signal is observed implicitly by re-rendering
        // (a new tenant produces a new effect run, abort fires on the prior).
        void refreshBaseline();
    }, [primaryAccount, refreshBaseline]);
    // Snapshot save/clear handlers. Both are audit-logged so a sweep across
    // the audit log can answer "who saved a baseline against tenant X".
    const handleSaveSnapshot = React.useCallback(() => {
        if (!primaryAccount)
            return;
        if (baselineState.findings.length === 0)
            return;
        const base = buildSnapshot(primaryAccount.tenantId, primaryAccount.name || primaryAccount.username, baselineState.findings);
        // Pin the snapshot's capturedAt to the latest history entry's
        // capturedAt so the timeline bookmark check (`h.capturedAt ===
        // snapshot.capturedAt`) lines up. Without this the two timestamps
        // would drift by a few milliseconds (refresh wrote one, save wrote
        // another) and no history entry would ever match.
        //
        // Read `history` from the closure (the rendered value at click-time)
        // rather than the functional setHistory updater — that keeps the
        // snapshot write deterministic and synchronous.
        const latestHistoryAt = history.length > 0 ? history[history.length - 1].capturedAt : null;
        const snap = latestHistoryAt
            ? Object.assign(Object.assign({}, base), { capturedAt: latestHistoryAt }) : base;
        setSnapshot(snap);
        // Mark the latest history entry as the approved baseline so the
        // timeline shows a bookmark on it.
        setHistory((prev) => {
            if (prev.length === 0)
                return prev;
            const next = prev.slice();
            // Clear any prior approved-flag — only one bookmark at a time.
            for (let i = 0; i < next.length - 1; i += 1) {
                const entry = next[i];
                if (entry && entry.wasApproved) {
                    next[i] = Object.assign(Object.assign({}, entry), { wasApproved: false });
                }
            }
            const last = next[next.length - 1];
            if (last) {
                next[next.length - 1] = Object.assign(Object.assign({}, last), { wasApproved: true });
            }
            return next;
        });
        auditLog.record({
            actor: primaryAccount.username || primaryAccount.homeAccountId,
            action: "tenant_baseline_snapshot_save",
            target: primaryAccount.tenantId,
            status: "success",
            details: {
                tenantId: primaryAccount.tenantId,
                findingsCount: baselineState.findings.length,
                countsBySeverity: tallySeverities(baselineState.findings),
            },
        });
    }, [primaryAccount, baselineState.findings, setSnapshot, setHistory, history]);
    const handleClearSnapshot = React.useCallback(() => {
        if (!primaryAccount) {
            clearSnapshot();
            return;
        }
        clearSnapshot();
        auditLog.record({
            actor: primaryAccount.username || primaryAccount.homeAccountId,
            action: "tenant_baseline_snapshot_clear",
            target: primaryAccount.tenantId,
            status: "success",
            details: { tenantId: primaryAccount.tenantId },
        });
    }, [primaryAccount, clearSnapshot]);
    // Compliance-evidence export — builds an envelope with a SHA-256 hash
    // over the canonical findings JSON (chain-of-custody anchor) and pushes
    // it to the user's downloads. The hash itself is computed inside the
    // helper via WebCrypto SubtleCrypto.
    const [isExportingEvidence, setIsExportingEvidence] = React.useState(false);
    const handleExportEvidence = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _b;
        if (!primaryAccount)
            return;
        if (baselineState.findings.length === 0)
            return;
        setIsExportingEvidence(true);
        try {
            // Re-derive drift summary here — we don't share the BaselineTab's
            // memoised summary across the page (BaselineTab is the consumer).
            // Recomputing is O(n) and only runs on the operator's click.
            const driftMap = diffAgainstSnapshot(baselineState.findings, snapshot);
            const drift = summarizeDrift(driftMap);
            const envelope = yield buildComplianceEvidence({
                tenantId: primaryAccount.tenantId,
                tenantDisplayName: primaryAccount.name || primaryAccount.username,
                actor: primaryAccount.username || primaryAccount.homeAccountId,
                cloudEnvironment: (_b = cloudInfo === null || cloudInfo === void 0 ? void 0 : cloudInfo.environment) !== null && _b !== void 0 ? _b : "Unknown",
                findings: baselineState.findings,
                drift,
            });
            // Lazy import shape — we reuse the same `downloadJson` the
            // ExportMenu uses to keep dependency surface small.
            // Inline a tiny helper rather than pulling another import.
            const json = JSON.stringify(envelope, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            const stamp = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = `tenant-baseline-evidence-${primaryAccount.tenantId.slice(0, 8)}-${stamp}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            auditLog.record({
                actor: primaryAccount.username || primaryAccount.homeAccountId,
                action: "tenant_baseline_evidence_export",
                target: primaryAccount.tenantId,
                status: "success",
                details: {
                    tenantId: primaryAccount.tenantId,
                    findingsCount: baselineState.findings.length,
                    evidenceHash: envelope.evidenceHash,
                    evidenceHashAlgorithm: envelope.evidenceHashAlgorithm,
                    drift,
                },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            auditLog.record({
                actor: primaryAccount.username || primaryAccount.homeAccountId,
                action: "tenant_baseline_evidence_export",
                target: primaryAccount.tenantId,
                status: "failure",
                error: msg,
                details: { tenantId: primaryAccount.tenantId },
            });
        }
        finally {
            setIsExportingEvidence(false);
        }
    }), [primaryAccount, baselineState.findings, snapshot, cloudInfo]);
    // Refs for hot-key focus + click — see useShortcut bindings below.
    const refreshButtonRef = React.useRef(null);
    const exportMenuButtonRef = React.useRef(null);
    // Hot-keys: only active when the operator is NOT typing in an input
    // (useShortcut already gates this by default). Bound to the window so
    // they work from any focus location on the page.
    //   s → save baseline
    //   c → clear baseline (if present)
    //   e → open the Export dropdown (focuses the trigger button)
    //   r → refresh
    //   v → export compliance evidence (v for "verify")
    useShortcut("s", () => {
        void handleSaveSnapshot();
    });
    useShortcut("c", () => {
        if (snapshot)
            void handleClearSnapshot();
    });
    useShortcut("e", () => {
        var _a;
        const trigger = (_a = exportMenuButtonRef.current) === null || _a === void 0 ? void 0 : _a.querySelector("button");
        if (trigger instanceof HTMLButtonElement) {
            trigger.focus();
            trigger.click();
        }
    });
    useShortcut("r", () => {
        if (refreshButtonRef.current && !refreshButtonRef.current.disabled) {
            refreshButtonRef.current.click();
        }
    });
    useShortcut("v", () => {
        void handleExportEvidence();
    });
    const spLoadedRef = React.useRef(false);
    const handleTabChange = React.useCallback((value) => {
        if (value === "sp" && !spLoadedRef.current && primaryAccount) {
            spLoadedRef.current = true;
            void refreshSps();
        }
    }, [primaryAccount, refreshSps]);
    // Re-render once a minute so "Refreshed Xs ago" pills stay fresh.
    const [, forceTick] = React.useState(0);
    React.useEffect(() => {
        const id = setInterval(() => forceTick((n) => n + 1), 30000);
        return () => clearInterval(id);
    }, []);
    // React to global tenant switches: when the operator flips the active
    // tenant for the primary account via the global tenant switcher, re-run
    // both probes against the new tenant scope. The page derives its tenant
    // from `getActiveTenant(homeAccountId)` inside the `primaryAccount` memo,
    // so we re-fetch directly rather than holding extra local state.
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!primaryAccount)
            return;
        if (candidate !== primaryAccount.homeAccountId)
            return;
        if (detail.tenantId === primaryAccount.tenantId)
            return;
        void refreshBaseline();
        if (spLoadedRef.current)
            void refreshSps();
    });
    // ----- Empty state — no signed-in account ---------------------------------
    if (!primaryAccount) {
        return (React.createElement(Card, { className: "mx-auto max-w-2xl border-dashed" },
            React.createElement(CardHeader, { className: "text-center" },
                React.createElement("div", { className: "mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted" },
                    React.createElement(Shield, { className: "h-6 w-6 text-muted-foreground", "aria-hidden": true })),
                React.createElement(CardTitle, { className: "text-base" }, "Sign in to audit the tenant baseline"),
                React.createElement(CardDescription, null, "This page reads tenant configuration + service principal credentials via Microsoft Graph. It needs at least Directory.Read.All on the active tenant."))));
    }
    // ----- Normal render -----------------------------------------------------
    const tokenBadgeVariant = tokenExpiresInSec === null
        ? "outline"
        : tokenExpiresInSec < 60
            ? "destructive"
            : tokenExpiresInSec < 5 * 60
                ? "warning"
                : "success";
    return (React.createElement("div", { className: "flex flex-col gap-4" },
        React.createElement("header", { className: "flex flex-wrap items-end justify-between gap-3" },
            React.createElement("div", { className: "flex min-w-0 flex-col gap-1" },
                React.createElement("h1", { className: "m-0 flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground" },
                    React.createElement(ShieldCheck, { className: "h-6 w-6 text-primary", "aria-hidden": true }),
                    "Tenant Security Baseline"),
                React.createElement("p", { className: "m-0 max-w-prose text-xs leading-relaxed text-muted-foreground" }, "Defensive auditor \u2014 checks the signed-in tenant for the misconfigs AADInternals-class tooling routinely exploits, and tracks service principal credential expiries before they cause outages. All probes are read-only Microsoft Graph GETs.")),
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                React.createElement(Badge, { variant: "outline", className: "gap-1" },
                    React.createElement(Globe, { className: "h-3 w-3", "aria-hidden": true }),
                    React.createElement("span", { className: "truncate" }, primaryAccount.name || primaryAccount.username)),
                React.createElement(Badge, { variant: "outline", className: "gap-1 font-mono group/copy" },
                    React.createElement("code", { className: "text-2xs" },
                        primaryAccount.tenantId.slice(0, 8),
                        "\u2026",
                        primaryAccount.tenantId.slice(-4)),
                    React.createElement(CopyButton, { value: primaryAccount.tenantId, ariaLabel: `Copy tenant id ${primaryAccount.tenantId}`, alwaysVisible: true })),
                tokenExpiresInSec !== null && (React.createElement(Badge, { variant: tokenBadgeVariant, className: "gap-1" },
                    React.createElement(KeyRound, { className: "h-3 w-3", "aria-hidden": true }),
                    "Token ",
                    tokenExpiresInSec < 60
                        ? `${tokenExpiresInSec}s`
                        : tokenExpiresInSec < 3600
                            ? `${Math.floor(tokenExpiresInSec / 60)}m`
                            : `${Math.floor(tokenExpiresInSec / 3600)}h ${Math.floor((tokenExpiresInSec % 3600) / 60)}m`)))),
        cloudInfo && (React.createElement(SovereignCloudBanner, { cloudInfo: cloudInfo })),
        React.createElement(Tabs, { defaultValue: "baseline", onValueChange: handleTabChange },
            React.createElement(TabsList, null,
                React.createElement(TabsTrigger, { value: "baseline" },
                    React.createElement(ShieldCheck, { className: "mr-1.5 h-3.5 w-3.5", "aria-hidden": true }),
                    "Baseline configuration"),
                React.createElement(TabsTrigger, { value: "sp" },
                    React.createElement(KeyRound, { className: "mr-1.5 h-3.5 w-3.5", "aria-hidden": true }),
                    "Service principal credentials")),
            React.createElement(TabsContent, { value: "baseline" },
                React.createElement(BaselineTab, { state: baselineState, onRefresh: refreshBaseline, tenantId: primaryAccount.tenantId, tenantDisplayName: primaryAccount.name || primaryAccount.username, snapshot: snapshot, onSaveSnapshot: handleSaveSnapshot, onClearSnapshot: handleClearSnapshot, history: history, alertOnDrift: alertOnDrift, onToggleAlertOnDrift: setAlertOnDrift, onExportEvidence: handleExportEvidence, isExportingEvidence: isExportingEvidence, refreshButtonRef: refreshButtonRef, exportMenuButtonRef: exportMenuButtonRef })),
            React.createElement(TabsContent, { value: "sp" },
                React.createElement(SpTab, { state: spState, onRefresh: refreshSps, tenantId: primaryAccount.tenantId, tenantDisplayName: primaryAccount.name || primaryAccount.username, actor: primaryAccount.username || primaryAccount.homeAccountId })))));
};
//# sourceMappingURL=tenant-baseline-page.js.map