import { __awaiter } from "tslib";
/**
 * Account Info page — multi-region Azure Batch account browser with URL-synced
 * filters + search, DataTable rendering, fleet-wide quota gauges, and a
 * deep-link `<Sheet>` drawer for per-account details (per-VM-family quota
 * breakdown + raw quota numbers + cross-page links).
 *
 * Operator-facing features:
 *   - Free-text search (account name / region / RG / subscription id) with
 *     `/` to focus, debounced via the shared `useSearch` hook.
 *   - Auto-refresh every 30 s with a live countdown chip + last-refreshed
 *     relative timestamp + stale-data warning if data is older than 5 min.
 *   - Critical / warning summary chips that filter the table by utilization.
 *   - Keyboard shortcuts: `r` refresh, `a` toggle auto-refresh, `/` focus
 *     search, `Escape` clears the sheet (handled by Radix).
 *   - Per-row Copy-account-id button + per-cell info tooltips.
 *   - Sheet split into Overview / Per-VM-family / Related tabs so a long
 *     account doesn't require a scrollbar marathon.
 *   - Top-utilization items in QuotaGlance are clickable → open the sheet.
 *   - Export dropdown (CSV + JSON via the shared ExportMenu) alongside the
 *     DataTable's built-in CSV button.
 *
 * Auth surface is preserved: still uses `useArmToken` + `<TokenExpiryBadge>`
 * sourced from the first signed-in Azure account so the operator gets a
 * heads-up before any sheet "Pools / Nodes / Create pool" navigation that
 * would actually need a fresh ARM token.
 */
import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Activity, AlertCircle, AlertTriangle, CheckCircle2, Cpu, ExternalLink, Filter, Gauge as GaugeIcon, Loader2, RotateCw, Search, Square, Users, X, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger, } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { Gauge } from "@/components/ui/charts/gauge";
import { cn, compareNumbers, compareStrings, formatNumber, formatRelativeTime, } from "@/lib/utils";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useSearch } from "../../hooks/use-search";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState } from "../../store/store-context";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { DataTable, } from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { RegionBadge } from "../shared/region-badge";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { BorderBeam, DotPattern, Meteors, } from "@/components/ui/effects";
import { safeNum, summarizeAccountInfos, usagePct, } from "./account-info-helpers";
import { AccountInfoSummaryBar } from "./account-info-summary";
const AUTO_REFRESH_INTERVAL_MS = 30000;
const LOW_FREE_THRESHOLDS = ["10", "50", "100"];
const ALL_REGIONS = "__all";
const STALE_DATA_THRESHOLD_MS = 5 * 60 * 1000; // 5 min
const CRITICAL_UTILIZATION_PCT = 80;
const WARNING_UTILIZATION_PCT = 50;
// Persisted threshold-alert (Wave-2 add). When per-account peak utilization
// crosses this configurable percent, the row banner highlights the account
// as "watch". Operators get a deep-link from the banner to the row's sheet.
// Stored under a v1 key so future schema bumps can migrate cleanly.
const THRESHOLD_ALERT_KEY = "azbm.account-info.threshold-alert-pct.v1";
const THRESHOLD_ALERT_DEFAULT_PCT = 75;
const THRESHOLD_ALERT_OPTIONS = [50, 60, 70, 75, 80, 90, 95];
// Hotkey chord sequences. `g a` / `g p` follows the Gmail-style "g + nav"
// convention also used by GitHub. The chord buffer resets after 1.2s so a
// stray `g` doesn't get bound to whatever the next keypress is.
const CHORD_BUFFER_TIMEOUT_MS = 1200;
const UTILIZATION_BANDS = new Set([
    "all",
    "critical",
    "warning",
    "healthy",
]);
const INITIAL_FILTERS = {
    region: "",
    lowFree: "",
    q: "",
    band: "",
};
/**
 * Narrow a URL-state value (`string | string[] | undefined`) to a single
 * string. Filters on this page only ever carry scalar values, but the URL
 * state generic allows arrays for forward compatibility — pick the first
 * element when it ever arrives as an array.
 */
function firstString(value) {
    var _a;
    if (value == null)
        return "";
    if (Array.isArray(value))
        return (_a = value[0]) !== null && _a !== void 0 ? _a : "";
    return value;
}
/** Narrow an arbitrary string from URL state to a known `UtilizationBand`. */
function coerceBand(value) {
    return UTILIZATION_BANDS.has(value)
        ? value
        : "all";
}
const UsageBar = ({ used, quota }) => {
    const pct = usagePct(used, quota);
    const toneText = quota <= 0
        ? "text-muted-foreground"
        : pct > 80
            ? "text-destructive"
            : pct >= 50
                ? "text-warning"
                : "text-success";
    const toneFill = quota <= 0
        ? "bg-muted-foreground"
        : pct > 80
            ? "bg-destructive"
            : pct >= 50
                ? "bg-warning"
                : "bg-success";
    const bar = (React.createElement("div", { className: "group flex flex-col gap-1" },
        React.createElement("span", { className: cn("text-xs font-semibold tabular-nums transition-colors duration-150 ease-out", toneText) },
            formatNumber(used),
            " / ",
            formatNumber(quota)),
        React.createElement("div", { className: "h-1 w-20 overflow-hidden rounded-full bg-surface-sunken transition-[height] duration-200 ease-out group-hover:h-1.5", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": `Usage: ${used} of ${quota} cores (${pct}%)`, "aria-valuetext": `${pct}%` },
            React.createElement("div", { className: cn("h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none", toneFill), style: { width: `${pct}%` } }))));
    // Tooltip exposes the exact percentage on hover/focus; useful when the
    // bar is short and the eye can't easily judge fill ratio.
    if (quota <= 0)
        return bar;
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true },
            React.createElement("span", { tabIndex: 0, className: "inline-flex outline-none" }, bar)),
        React.createElement(TooltipContent, { side: "top" },
            pct,
            "% used (",
            formatNumber(used),
            " / ",
            formatNumber(quota),
            ")")));
};
const AccountDetailSheet = ({ account, open, onOpenChange, onNavigate, loading = false, deepLinkUrl, }) => {
    var _a, _b, _c;
    const families = (_a = account === null || account === void 0 ? void 0 : account.dedicatedCoreQuotaPerVMFamily) !== null && _a !== void 0 ? _a : [];
    const familiesEnforced = (_b = account === null || account === void 0 ? void 0 : account.dedicatedCoreQuotaPerVMFamilyEnforced) !== null && _b !== void 0 ? _b : false;
    // Pre-compute the worst-of (dedicated, LP, pool) utilization for the badge
    // shown next to the title, so the operator sees risk at a glance.
    const headlinePct = React.useMemo(() => {
        if (!account)
            return 0;
        return Math.max(usagePct(safeNum(account.dedicatedCoresUsed), safeNum(account.dedicatedCoreQuota)), usagePct(safeNum(account.lowPriorityCoresUsed), safeNum(account.lowPriorityCoreQuota)), usagePct(safeNum(account.poolCount), safeNum(account.poolQuota)));
    }, [account]);
    const headlineTone = headlinePct > CRITICAL_UTILIZATION_PCT
        ? "destructive"
        : headlinePct >= WARNING_UTILIZATION_PCT
            ? "warning"
            : "success";
    // Sort families by utilisation descending so the hottest family is at the
    // top — the operator's most common question is "which family is full?".
    const sortedFamilies = React.useMemo(() => {
        return [...families].sort((a, b) => {
            const aPct = usagePct(safeNum(a.coresUsed), safeNum(a.coreQuota));
            const bPct = usagePct(safeNum(b.coresUsed), safeNum(b.coreQuota));
            return bPct - aPct;
        });
    }, [families]);
    return (React.createElement(Sheet, { open: open, onOpenChange: onOpenChange },
        React.createElement(SheetContent, { side: "right", size: "lg", className: "flex flex-col", "aria-label": "Account details" },
            React.createElement(SheetHeader, null,
                React.createElement("div", { className: "flex items-start gap-3" },
                    React.createElement("div", { className: "min-w-0 flex-1" },
                        React.createElement(SheetTitle, { className: "flex items-center gap-2 truncate" },
                            React.createElement("span", { className: "truncate" }, (_c = account === null || account === void 0 ? void 0 : account.accountName) !== null && _c !== void 0 ? _c : "Account details"),
                            account && (React.createElement(Badge, { variant: headlineTone, "aria-label": `Headline utilization ${headlinePct} percent` },
                                headlinePct,
                                "% peak"))),
                        React.createElement(SheetDescription, { className: "mt-1 flex flex-wrap items-center gap-2 text-xs" }, account ? (React.createElement(React.Fragment, null,
                            React.createElement(RegionBadge, { region: account.region || "—" }),
                            React.createElement("span", { className: "text-muted-foreground" }, account.resourceGroup || "—"),
                            deepLinkUrl && (React.createElement("span", { className: "inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-2xs text-muted-foreground", title: "Shareable URL \u2014 paste into chat to deep-link a teammate to this account view" },
                                "Deep-link",
                                React.createElement(CopyButton, { value: deepLinkUrl, ariaLabel: `Copy shareable deep-link URL for ${account.accountName}` }))))) : ("No account selected."))))),
            React.createElement(SheetBody, { className: "flex flex-col gap-4" }, !account ? (loading ? (
            // Orchestrator's first refresh hasn't returned yet — skeleton
            // until either the account resolves or the cache is confirmed
            // empty. Prevents the deep-linked sheet from flashing
            // "Account not found" before the data arrives.
            React.createElement(SkeletonLoader, { variant: "card", cards: 3 })) : (React.createElement("p", { className: "m-0 text-sm text-muted-foreground" }, "Account not found in the current dataset."))) : (React.createElement(Tabs, { defaultValue: "overview", className: "flex flex-col gap-3" },
                React.createElement(TabsList, { "aria-label": "Account detail sections" },
                    React.createElement(TabsTrigger, { value: "overview" }, "Overview"),
                    React.createElement(TabsTrigger, { value: "families" },
                        "VM-families",
                        sortedFamilies.length > 0 && (React.createElement("span", { className: "ml-1.5 inline-flex h-4 min-w-[1.25rem] items-center justify-center rounded-full bg-muted px-1 text-2xs tabular-nums text-muted-foreground" }, sortedFamilies.length))),
                    React.createElement(TabsTrigger, { value: "related" }, "Related")),
                React.createElement(TabsContent, { value: "overview", className: "flex flex-col gap-5" },
                    React.createElement("section", { className: "flex flex-col gap-2", "aria-labelledby": "account-detail-identity" },
                        React.createElement("h3", { id: "account-detail-identity", className: "m-0 text-base font-semibold text-foreground" }, "Identity"),
                        React.createElement("dl", { className: "grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 text-xs" },
                            React.createElement("dt", { className: "text-muted-foreground" }, "Subscription"),
                            React.createElement("dd", { className: "group/copy m-0 inline-flex items-center gap-1.5 break-all font-mono text-2xs text-foreground" },
                                React.createElement("span", { className: "break-all" }, account.subscriptionId || "—"),
                                account.subscriptionId && (React.createElement(CopyButton, { value: account.subscriptionId, ariaLabel: "Copy subscription id" }))),
                            React.createElement("dt", { className: "text-muted-foreground" }, "Resource Group"),
                            React.createElement("dd", { className: "m-0 text-foreground" }, account.resourceGroup || "—"),
                            React.createElement("dt", { className: "text-muted-foreground" }, "Region"),
                            React.createElement("dd", { className: "m-0 text-foreground" }, account.region || "—"),
                            React.createElement("dt", { className: "text-muted-foreground" }, "Account ID"),
                            React.createElement("dd", { className: "group/copy m-0 inline-flex items-center gap-1.5 break-all font-mono text-2xs text-foreground" },
                                React.createElement("span", { className: "break-all" }, account.id),
                                React.createElement(CopyButton, { value: account.id, ariaLabel: "Copy account ARM id" })))),
                    React.createElement("section", { className: "flex flex-col gap-2", "aria-labelledby": "account-detail-quotas" },
                        React.createElement("div", { className: "flex items-center gap-1.5" },
                            React.createElement("h3", { id: "account-detail-quotas", className: "m-0 text-base font-semibold text-foreground" }, "Raw quotas"),
                            React.createElement(InfoTooltip, { content: "Quota = the operator-configured Azure Batch limit. Used = currently allocated. Free = headroom available for new pools / nodes." })),
                        React.createElement("div", { className: "grid grid-cols-2 gap-3 sm:grid-cols-2" },
                            React.createElement(RawQuotaCard, { label: "Dedicated cores", used: safeNum(account.dedicatedCoresUsed), quota: safeNum(account.dedicatedCoreQuota), free: safeNum(account.dedicatedCoresFree), hint: "Reserved-capacity cores. Counts against the subscription's per-region dedicated-core ceiling \u2014 pool resize fails if the family or account quota is exhausted." }),
                            React.createElement(RawQuotaCard, { label: "Low-priority cores", used: safeNum(account.lowPriorityCoresUsed), quota: safeNum(account.lowPriorityCoreQuota), free: safeNum(account.lowPriorityCoresFree), hint: "Spot/preemptible cores. Cheaper but can be evicted by Azure at any time; quota is independent from the dedicated-core ceiling." }),
                            React.createElement(RawQuotaCard, { label: "Pools", used: safeNum(account.poolCount), quota: safeNum(account.poolQuota), free: safeNum(account.poolsFree), hint: "Maximum simultaneous pools (compute groups) this account may hold. Hitting this cap blocks Create-Pool even when core quota is still free." }),
                            React.createElement(RawQuotaCard, { label: "Active jobs", used: 0, quota: safeNum(account.activeJobAndJobScheduleQuota), free: safeNum(account.activeJobAndJobScheduleQuota), usedUnknown: true, hint: "Maximum simultaneously-active jobs + job-schedules. Azure Batch does not expose a live used-count via the quota API, so only the cap is shown." })))),
                React.createElement(TabsContent, { value: "families", className: "flex flex-col gap-3" },
                    React.createElement("p", { className: cn("m-0 inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-2xs", familiesEnforced
                            ? "border-warning/40 bg-warning/10 text-warning"
                            : "border-border bg-muted/30 text-muted-foreground"), role: "note" }, familiesEnforced ? (React.createElement(React.Fragment, null,
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Per-family quotas are ",
                        React.createElement("strong", null, "enforced"),
                        " \u2014 each VM family below has its own independent cap.")) : (React.createElement(React.Fragment, null,
                        React.createElement(CheckCircle2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Per-family quotas are ",
                        React.createElement("strong", null, "not enforced"),
                        ". Only the cumulative core quota applies; the rows below are informational."))),
                    sortedFamilies.length === 0 ? (React.createElement("div", { className: "rounded-md border border-dashed border-border bg-card px-4 py-6 text-center text-xs text-muted-foreground" }, "No per-family data available for this account.")) : (React.createElement("div", { className: "overflow-hidden rounded-md border border-border bg-card" },
                        React.createElement("table", { className: "w-full text-xs", "aria-label": "Per-VM-family quotas, sorted by utilization descending" },
                            React.createElement("thead", { className: "bg-muted/30" },
                                React.createElement("tr", null,
                                    React.createElement("th", { scope: "col", className: "px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Family"),
                                    React.createElement("th", { scope: "col", className: "px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Used"),
                                    React.createElement("th", { scope: "col", className: "px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Quota"),
                                    React.createElement("th", { scope: "col", className: "px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Free"),
                                    React.createElement("th", { scope: "col", className: "px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Use %"))),
                            React.createElement("tbody", null, sortedFamilies.map((fam) => {
                                const used = safeNum(fam.coresUsed);
                                const quota = safeNum(fam.coreQuota);
                                const free = safeNum(fam.coresFree);
                                const pct = usagePct(used, quota);
                                const freeTone = free > 0
                                    ? "text-success"
                                    : "text-muted-foreground";
                                const pctTone = pct > CRITICAL_UTILIZATION_PCT
                                    ? "text-destructive"
                                    : pct >= WARNING_UTILIZATION_PCT
                                        ? "text-warning"
                                        : "text-success";
                                return (React.createElement("tr", { key: fam.name, className: "border-t border-border transition-colors hover:bg-muted/20" },
                                    React.createElement("td", { className: "px-3 py-1.5 font-mono text-2xs text-foreground" }, fam.name),
                                    React.createElement("td", { className: "px-3 py-1.5 text-right tabular-nums text-foreground" }, formatNumber(used)),
                                    React.createElement("td", { className: "px-3 py-1.5 text-right tabular-nums text-foreground" }, formatNumber(quota)),
                                    React.createElement("td", { className: cn("px-3 py-1.5 text-right font-semibold tabular-nums", freeTone) }, formatNumber(free)),
                                    React.createElement("td", { className: cn("px-3 py-1.5 text-right font-semibold tabular-nums", pctTone) }, quota > 0 ? `${pct}%` : "—")));
                            })))))),
                React.createElement(TabsContent, { value: "related", className: "flex flex-col gap-3" },
                    React.createElement("p", { className: "m-0 text-xs text-muted-foreground" }, "Jump to other pages scoped to this account."),
                    React.createElement("div", { className: "flex flex-wrap gap-2" },
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => onNavigate(`/pool-info?accountId=${account.id}`), "aria-label": `View pools for ${account.accountName}` },
                            React.createElement(ExternalLink, null),
                            "Pools"),
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => onNavigate(`/nodes?accountId=${account.id}`), "aria-label": `View nodes for ${account.accountName}` },
                            React.createElement(ExternalLink, null),
                            "Nodes"),
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => onNavigate(`/pools?accountId=${account.id}`), "aria-label": `Open pool creation for ${account.accountName}` },
                            React.createElement(ExternalLink, null),
                            "Create pool")))))),
            React.createElement(SheetFooter, null,
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => onOpenChange(false), "aria-label": "Close account details" }, "Close")))));
};
const QUOTA_TRACK_TONE = {
    muted: "bg-muted",
    destructive: "bg-destructive/15",
    warning: "bg-warning/15",
    success: "bg-success/15",
};
const QUOTA_FILL_TONE = {
    muted: "[&>*]:bg-muted-foreground/60",
    destructive: "[&>*]:bg-destructive",
    warning: "[&>*]:bg-warning",
    success: "[&>*]:bg-success",
};
const QUOTA_LABEL_TONE = {
    muted: "text-muted-foreground",
    destructive: "text-destructive",
    warning: "text-warning",
    success: "text-success",
};
const RawQuotaCard = React.memo(({ label, used, quota, free, usedUnknown = false, hint }) => {
    const pct = usagePct(used, quota);
    // Color-coded threshold band — matches the row-level UsageBar tone scale
    // so the operator's color → severity mapping is consistent across the
    // page. We tint the Progress *track* with a faded tone so the unfilled
    // portion also carries a hint of the band, and pass a tone-specific
    // class to color the indicator fill.
    const tone = quota <= 0
        ? "muted"
        : pct > CRITICAL_UTILIZATION_PCT
            ? "destructive"
            : pct >= WARNING_UTILIZATION_PCT
                ? "warning"
                : "success";
    return (React.createElement("div", { className: "flex flex-col gap-1.5 rounded-md border border-border bg-card p-3 transition-shadow duration-200 ease-out hover:shadow-elev-1" },
        React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground" },
            label,
            hint && React.createElement(InfoTooltip, { content: hint, size: 11 })),
        React.createElement("div", { className: "flex items-baseline justify-between gap-2" },
            React.createElement("span", { className: cn("text-xs font-semibold tabular-nums", QUOTA_LABEL_TONE[tone]) },
                usedUnknown ? "—" : formatNumber(used),
                " / ",
                formatNumber(quota)),
            React.createElement("span", { className: cn("text-2xs tabular-nums", QUOTA_LABEL_TONE[tone]), "aria-hidden": true }, usedUnknown || quota <= 0 ? "—" : `${pct}%`)),
        React.createElement(Progress, { value: usedUnknown ? 0 : pct, className: cn("h-1.5", QUOTA_TRACK_TONE[tone], QUOTA_FILL_TONE[tone]), "aria-label": usedUnknown
                ? `${label}: ${quota} quota (used count unavailable)`
                : `${label}: ${used} of ${quota} (${pct} percent used)`, "aria-valuetext": usedUnknown
                ? "used count not available from Azure Batch quota API"
                : `${pct}% — ${tone === "destructive"
                    ? "critical"
                    : tone === "warning"
                        ? "warning"
                        : tone === "success"
                            ? "healthy"
                            : "no quota assigned"}` }),
        React.createElement("span", { className: "text-2xs text-muted-foreground tabular-nums" },
            "Free: ",
            formatNumber(free))));
});
RawQuotaCard.displayName = "RawQuotaCard";
const QuotaGlance = ({ accounts, onAccountClick, }) => {
    // Aggregate totals across the fleet.
    const totals = React.useMemo(() => {
        let dedicatedUsed = 0;
        let dedicatedQuota = 0;
        let lpUsed = 0;
        let lpQuota = 0;
        let poolsUsed = 0;
        let poolsQuota = 0;
        for (const a of accounts) {
            dedicatedUsed += safeNum(a.dedicatedCoresUsed);
            dedicatedQuota += safeNum(a.dedicatedCoreQuota);
            lpUsed += safeNum(a.lowPriorityCoresUsed);
            lpQuota += safeNum(a.lowPriorityCoreQuota);
            poolsUsed += safeNum(a.poolCount);
            poolsQuota += safeNum(a.poolQuota);
        }
        return {
            dedicatedUsed,
            dedicatedQuota,
            lpUsed,
            lpQuota,
            poolsUsed,
            poolsQuota,
        };
    }, [accounts]);
    // Top 5 accounts by combined core utilization (used/quota), filtered to
    // accounts that actually have quota assigned. Surfaces the accounts most
    // at risk of hitting their cap so the operator can resize / migrate.
    const topUtilization = React.useMemo(() => {
        return accounts
            .map((a) => {
            const dq = safeNum(a.dedicatedCoreQuota);
            const lq = safeNum(a.lowPriorityCoreQuota);
            const totalQuota = dq + lq;
            if (totalQuota === 0)
                return null;
            const totalUsed = safeNum(a.dedicatedCoresUsed) + safeNum(a.lowPriorityCoresUsed);
            return {
                id: a.id,
                accountName: a.accountName,
                region: a.region,
                totalUsed,
                totalQuota,
                ratio: totalUsed / totalQuota,
            };
        })
            .filter((x) => x !== null)
            .sort((a, b) => b.ratio - a.ratio)
            .slice(0, 5);
    }, [accounts]);
    return (React.createElement("section", { role: "region", "aria-labelledby": "quota-glance-heading", className: "grid grid-cols-1 gap-3 lg:grid-cols-3" },
        React.createElement("div", { className: "flex flex-col gap-3 rounded-md border border-border bg-card p-4 transition-shadow duration-200 ease-out hover:shadow-elev-1 lg:col-span-2" },
            React.createElement("h3", { id: "quota-glance-heading", className: "m-0 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                React.createElement(GaugeIcon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Quota at a glance (",
                accounts.length,
                " accounts)"),
            React.createElement("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-3" },
                React.createElement(Gauge, { label: "Dedicated cores", unit: "cores", used: totals.dedicatedUsed, total: totals.dedicatedQuota, size: "md" }),
                React.createElement(Gauge, { label: "Low-priority cores", unit: "cores", used: totals.lpUsed, total: totals.lpQuota, size: "md" }),
                React.createElement(Gauge, { label: "Pools", unit: "pools", used: totals.poolsUsed, total: totals.poolsQuota, size: "md" }))),
        React.createElement("div", { className: "rounded-md border border-border bg-card p-4 transition-shadow duration-200 ease-out hover:shadow-elev-1" },
            React.createElement("div", { className: "flex items-center justify-between" },
                React.createElement("h3", { className: "m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Most utilized accounts"),
                React.createElement(InfoTooltip, { content: "Top 5 by combined core utilization (dedicated + LP). Click a row to open the detail sheet." })),
            topUtilization.length === 0 ? (React.createElement("p", { className: "mt-2 text-2xs text-muted-foreground" }, "No accounts have a configured quota yet.")) : (React.createElement("ul", { className: "mt-2 flex flex-col gap-2.5" }, topUtilization.map((row) => (React.createElement("li", { key: row.id },
                React.createElement("button", { type: "button", onClick: () => onAccountClick(row.id), className: "block w-full rounded-md p-1 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Open details for ${row.accountName} in ${row.region}` },
                    React.createElement(Gauge, { label: React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                            React.createElement("span", { className: "truncate font-mono text-2xs text-foreground" }, row.accountName),
                            React.createElement("span", { className: "text-2xs text-muted-foreground/70" }, row.region)), used: row.totalUsed, total: row.totalQuota, size: "sm" }))))))))));
};
const AutoRefreshChip = ({ enabled, loading, lastRefreshedAt, }) => {
    // Tick every second so the countdown moves visibly.
    const [, force] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => {
        if (!enabled || lastRefreshedAt == null)
            return;
        const id = setInterval(force, 1000);
        return () => clearInterval(id);
    }, [enabled, lastRefreshedAt]);
    if (!enabled)
        return null;
    if (lastRefreshedAt == null) {
        return (React.createElement("span", { className: "inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground", "aria-live": "polite" },
            React.createElement(Activity, { className: "h-3 w-3 animate-pulse motion-reduce:animate-none" }),
            "Auto-refresh armed"));
    }
    const elapsed = Date.now() - lastRefreshedAt;
    const remaining = Math.max(0, AUTO_REFRESH_INTERVAL_MS - elapsed);
    const seconds = Math.ceil(remaining / 1000);
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true },
            React.createElement("span", { className: cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs tabular-nums", loading
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"), "aria-live": "polite" },
                React.createElement(Activity, { className: cn("h-3 w-3", loading
                        ? "animate-spin motion-reduce:animate-none"
                        : "animate-pulse motion-reduce:animate-none") }),
                loading ? "Refreshing…" : `Next refresh in ${seconds}s`)),
        React.createElement(TooltipContent, null,
            "Auto-refresh runs every 30 seconds. Press ",
            React.createElement(Kbd, null, "a"),
            " to toggle.")));
};
/* ------------------------------------------------------------------ */
/*  Chord-sequence hotkeys (g a / g p)                                 */
/* ------------------------------------------------------------------ */
/**
 * useChordSequence — listen for a two-key chord like `g a`. The buffer
 * resets after `CHORD_BUFFER_TIMEOUT_MS` so a stray `g` doesn't capture
 * the next unrelated keypress. Ignores edit-target events so typing in
 * a search box doesn't accidentally fire navigation.
 *
 * Why local: the shared `useShortcut` matches single chords only. We
 * don't want to extend the shared hook for an account-info-only feature.
 */
function useChordSequence(prefix, bindings, enabled = true) {
    // Stable ref so re-renders don't rebind the listener.
    const bindingsRef = React.useRef(bindings);
    bindingsRef.current = bindings;
    React.useEffect(() => {
        if (!enabled || typeof window === "undefined")
            return;
        let armed = false;
        let timer = null;
        const disarm = () => {
            armed = false;
            if (timer != null) {
                window.clearTimeout(timer);
                timer = null;
            }
        };
        const onKey = (e) => {
            // Skip when focus is in an editable target.
            const target = e.target;
            if (target) {
                const tag = target.tagName;
                if (tag === "INPUT" ||
                    tag === "TEXTAREA" ||
                    tag === "SELECT" ||
                    target.isContentEditable)
                    return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey)
                return;
            const key = e.key.toLowerCase();
            if (!armed) {
                if (key === prefix) {
                    armed = true;
                    timer = window.setTimeout(disarm, CHORD_BUFFER_TIMEOUT_MS);
                }
                return;
            }
            // armed → second key
            const handler = bindingsRef.current[key];
            disarm();
            if (handler) {
                e.preventDefault();
                handler();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => {
            disarm();
            window.removeEventListener("keydown", onKey);
        };
    }, [prefix, enabled]);
}
/**
 * Compute which accounts cross the operator-configured threshold. Peak
 * utilization is the max of (dedicated, LP, pool) — matches the
 * `headlinePct` used in the detail sheet so the operator's mental model
 * is consistent.
 */
function computeThresholdAlerts(accounts, thresholdPct) {
    var _a;
    const out = [];
    for (const a of accounts) {
        const dPct = usagePct(safeNum(a.dedicatedCoresUsed), safeNum(a.dedicatedCoreQuota));
        const lPct = usagePct(safeNum(a.lowPriorityCoresUsed), safeNum(a.lowPriorityCoreQuota));
        const pPct = usagePct(safeNum(a.poolCount), safeNum(a.poolQuota));
        const peak = Math.max(dPct, lPct, pPct);
        if (peak < thresholdPct)
            continue;
        // Identify which axis is hottest so the banner is actionable.
        let reason = "core capacity";
        if (pPct === peak)
            reason = "pool count";
        else if (lPct === peak)
            reason = "low-priority cores";
        else if (dPct === peak)
            reason = "dedicated cores";
        out.push({
            id: a.id,
            accountName: a.accountName,
            region: (_a = a.region) !== null && _a !== void 0 ? _a : "",
            peakPct: peak,
            reason,
        });
    }
    // Hottest first — operator's eye lands on highest-risk account.
    out.sort((a, b) => b.peakPct - a.peakPct);
    return out;
}
const ThresholdAlertsCard = React.memo(({ alerts, thresholdPct, onChangeThreshold, onOpenAccount }) => {
    return (React.createElement("section", { className: "rounded-md border border-warning/40 bg-warning/5 p-3", role: "region", "aria-labelledby": "threshold-alerts-heading" },
        React.createElement("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1.5" },
            React.createElement("h3", { id: "threshold-alerts-heading", className: "m-0 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-warning" },
                React.createElement(AlertTriangle, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Threshold alerts (",
                alerts.length,
                ")"),
            React.createElement(InfoTooltip, { size: 12, content: "Surfaces accounts whose peak utilization (worst of dedicated, LP, pool) crosses the configured threshold. Setting is persisted across reloads." }),
            React.createElement("div", { className: "ml-auto flex items-center gap-1.5" },
                React.createElement(Label, { htmlFor: "account-info-threshold", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Warn at"),
                React.createElement(Select, { value: String(thresholdPct), onValueChange: (v) => {
                        const n = Number(v);
                        if (Number.isFinite(n))
                            onChangeThreshold(n);
                    } },
                    React.createElement(SelectTrigger, { id: "account-info-threshold", className: "h-7 w-20", "aria-label": "Threshold-alert percent" },
                        React.createElement(SelectValue, null)),
                    React.createElement(SelectContent, null, THRESHOLD_ALERT_OPTIONS.map((n) => (React.createElement(SelectItem, { key: n, value: String(n) },
                        n,
                        "%"))))))),
        React.createElement("ul", { className: "mt-2 flex flex-col gap-1" },
            alerts.slice(0, 6).map((a) => (React.createElement("li", { key: a.id },
                React.createElement("button", { type: "button", onClick: () => onOpenAccount(a.id), className: "flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-2xs transition-colors hover:bg-warning/10 focus-visible:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Open ${a.accountName} — ${a.peakPct}% on ${a.reason}` },
                    React.createElement("span", { className: "inline-flex min-w-0 items-center gap-1.5" },
                        React.createElement("span", { className: "truncate font-mono text-foreground" }, a.accountName),
                        a.region && (React.createElement("span", { className: "text-muted-foreground/70" }, a.region)),
                        React.createElement("span", { className: "text-muted-foreground" },
                            "\u2014 ",
                            a.reason)),
                    React.createElement("span", { className: "tabular-nums font-semibold text-warning" },
                        a.peakPct,
                        "%"))))),
            alerts.length > 6 && (React.createElement("li", { className: "px-1.5 text-2xs text-muted-foreground" },
                "\u2026 ",
                alerts.length - 6,
                " more not shown \u2014 narrow the table or use the critical chip above to see them all.")))));
});
ThresholdAlertsCard.displayName = "ThresholdAlertsCard";
function computeSurfaceRiskRows(accounts) {
    var _a, _b, _c, _d;
    const rows = [];
    for (const a of accounts) {
        const families = (_a = a.dedicatedCoreQuotaPerVMFamily) !== null && _a !== void 0 ? _a : [];
        let familiesWithQuota = 0;
        let hottestPct = 0;
        let hottestName = null;
        for (const fam of families) {
            const q = safeNum(fam.coreQuota);
            if (q <= 0)
                continue;
            familiesWithQuota++;
            const pct = usagePct(safeNum(fam.coresUsed), q);
            if (pct > hottestPct) {
                hottestPct = pct;
                hottestName = (_b = fam.name) !== null && _b !== void 0 ? _b : null;
            }
        }
        const enforced = (_c = a.dedicatedCoreQuotaPerVMFamilyEnforced) !== null && _c !== void 0 ? _c : false;
        const unenforcedAndHot = !enforced && hottestPct > CRITICAL_UTILIZATION_PCT;
        // Skip accounts with no families and no risk flag — nothing to report.
        if (familiesWithQuota === 0 && !unenforcedAndHot)
            continue;
        rows.push({
            id: a.id,
            accountName: a.accountName,
            region: (_d = a.region) !== null && _d !== void 0 ? _d : "",
            familiesWithQuota,
            unenforcedAndHot,
            hottestFamilyName: hottestName,
            hottestFamilyPct: hottestPct,
        });
    }
    // Sort by (unenforcedAndHot desc, familiesWithQuota desc) so the
    // riskiest pivot-surface accounts float to the top.
    rows.sort((a, b) => {
        if (a.unenforcedAndHot !== b.unenforcedAndHot)
            return a.unenforcedAndHot ? -1 : 1;
        return b.familiesWithQuota - a.familiesWithQuota;
    });
    return rows;
}
const SurfaceRiskCard = React.memo(({ rows, onOpenAccount }) => {
    const flagged = rows.filter((r) => r.unenforcedAndHot);
    if (rows.length === 0)
        return null;
    return (React.createElement("section", { className: "rounded-md border border-border bg-card p-3", role: "region", "aria-labelledby": "surface-risk-heading" },
        React.createElement("div", { className: "flex flex-wrap items-center gap-x-2" },
            React.createElement("h3", { id: "surface-risk-heading", className: "m-0 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                React.createElement(Cpu, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Lateral surface"),
            React.createElement(InfoTooltip, { size: 12, content: "Count of distinct VM-families with assigned quota per account. More families = more places an attacker who lands a pool can pivot. Flagged when per-family quotas are NOT enforced AND a single family is already critical \u2014 risk of one family starving all others. Inspired by NetSPI MicroBurst Batch enumeration + Azucar/ScoutSuite policy lens." })),
        flagged.length > 0 && (React.createElement("div", { className: "mt-2 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-2xs text-destructive", role: "note" },
            React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true }),
            flagged.length,
            " account",
            flagged.length === 1 ? "" : "s",
            " with",
            " ",
            React.createElement("strong", null, "unenforced"),
            " per-family quotas AND a hot family.")),
        React.createElement("ul", { className: "mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2" }, rows.slice(0, 6).map((r) => (React.createElement("li", { key: r.id },
            React.createElement("button", { type: "button", onClick: () => onOpenAccount(r.id), className: cn("flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", r.unenforcedAndHot
                    ? "border-destructive/40 bg-destructive/5 hover:bg-destructive/10"
                    : "border-border bg-muted/20 hover:bg-muted/40"), "aria-label": `Open ${r.accountName} — ${r.familiesWithQuota} VM-families with quota` },
                React.createElement("span", { className: "inline-flex min-w-0 items-center gap-1.5" },
                    React.createElement("span", { className: "truncate font-mono text-foreground" }, r.accountName),
                    r.region && (React.createElement("span", { className: "text-muted-foreground/70" }, r.region))),
                React.createElement("span", { className: "inline-flex shrink-0 items-center gap-1.5" },
                    React.createElement("span", { className: "text-muted-foreground" }, "families"),
                    React.createElement("span", { className: "tabular-nums font-semibold text-foreground" }, r.familiesWithQuota),
                    r.hottestFamilyName && r.hottestFamilyPct > 0 && (React.createElement("span", { className: cn("rounded bg-muted px-1 tabular-nums", r.hottestFamilyPct > CRITICAL_UTILIZATION_PCT
                            ? "text-destructive"
                            : r.hottestFamilyPct >= WARNING_UTILIZATION_PCT
                                ? "text-warning"
                                : "text-success"), title: `Hottest family: ${r.hottestFamilyName}` },
                        r.hottestFamilyPct,
                        "%"))))))))));
});
SurfaceRiskCard.displayName = "SurfaceRiskCard";
function computeSubscriptionCollisions(accounts) {
    var _a;
    const bySub = new Map();
    for (const a of accounts) {
        const sub = (_a = a.subscriptionId) !== null && _a !== void 0 ? _a : "";
        if (!sub)
            continue;
        const used = safeNum(a.dedicatedCoresUsed) + safeNum(a.lowPriorityCoresUsed);
        const quota = safeNum(a.dedicatedCoreQuota) + safeNum(a.lowPriorityCoreQuota);
        const existing = bySub.get(sub);
        if (existing) {
            existing.accountCount++;
            existing.combinedUsed += used;
            existing.combinedQuota += quota;
            existing.accountIds.push(a.id);
        }
        else {
            bySub.set(sub, {
                accountCount: 1,
                combinedUsed: used,
                combinedQuota: quota,
                accountIds: [a.id],
            });
        }
    }
    const out = [];
    for (const [sub, v] of bySub) {
        if (v.accountCount < 2)
            continue;
        const pct = usagePct(v.combinedUsed, v.combinedQuota);
        if (pct < WARNING_UTILIZATION_PCT)
            continue;
        out.push({
            subscriptionId: sub,
            accountCount: v.accountCount,
            combinedUsed: v.combinedUsed,
            combinedQuota: v.combinedQuota,
            combinedPct: pct,
            accountIds: v.accountIds,
        });
    }
    out.sort((a, b) => b.combinedPct - a.combinedPct);
    return out;
}
const SubscriptionCollisionsCard = React.memo(({ collisions, onOpenAccount }) => {
    if (collisions.length === 0)
        return null;
    return (React.createElement("section", { className: "rounded-md border border-border bg-card p-3", role: "region", "aria-labelledby": "sub-collisions-heading" },
        React.createElement("div", { className: "flex flex-wrap items-center gap-x-2" },
            React.createElement("h3", { id: "sub-collisions-heading", className: "m-0 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                React.createElement(Users, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Subscription collisions"),
            React.createElement(InfoTooltip, { size: 12, content: "Subscriptions that host 2+ Batch accounts whose combined core utilization is already \u226550%. The subscription-level core ceiling will hit before any single account does. Inspired by NetSPI MicroBurst subscription-plane recon." })),
        React.createElement("ul", { className: "mt-2 flex flex-col gap-1" }, collisions.slice(0, 4).map((c) => {
            const subShort = c.subscriptionId.length > 8
                ? `${c.subscriptionId.slice(0, 8)}…`
                : c.subscriptionId;
            return (React.createElement("li", { key: c.subscriptionId },
                React.createElement("div", { className: cn("flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5 text-2xs", c.combinedPct > CRITICAL_UTILIZATION_PCT
                        ? "border-destructive/40 bg-destructive/5"
                        : "border-warning/40 bg-warning/5") },
                    React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                        React.createElement("span", { className: "font-mono text-foreground", title: c.subscriptionId }, subShort),
                        React.createElement("span", { className: "text-muted-foreground" },
                            c.accountCount,
                            " accounts")),
                    React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                        React.createElement("span", { className: cn("tabular-nums font-semibold", c.combinedPct > CRITICAL_UTILIZATION_PCT
                                ? "text-destructive"
                                : "text-warning") },
                            c.combinedPct,
                            "%"),
                        React.createElement("span", { className: "text-muted-foreground tabular-nums" },
                            "(",
                            formatNumber(c.combinedUsed),
                            "/",
                            formatNumber(c.combinedQuota),
                            ")"),
                        React.createElement("button", { type: "button", onClick: () => onOpenAccount(c.accountIds[0]), className: "rounded bg-muted px-1.5 py-0.5 text-foreground transition-colors hover:bg-muted-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Open first account in subscription ${subShort}` }, "Open")))));
        }))));
});
SubscriptionCollisionsCard.displayName = "SubscriptionCollisionsCard";
/* ------------------------------------------------------------------ */
/*  Inner page                                                         */
/* ------------------------------------------------------------------ */
const AccountInfoPageInner = ({ orchestrator, }) => {
    var _a;
    const state = useMultiRegionState();
    const navigate = useNavigate();
    const { accountId: routeAccountId } = useParams();
    const [loading, setLoading] = React.useState(false);
    // Persisted across reload — flipping the toggle off here once keeps it
    // off on subsequent loads. Default off because a 30 s polling cycle
    // costs one ARM round-trip per account/region grid cell.
    const [autoRefresh, setAutoRefresh] = usePersistedState("azbm.account-info.auto-refresh.v1", false);
    const [error, setError] = React.useState(null);
    const [selection, setSelection] = React.useState(new Set());
    // Tracks when the most recent successful refresh finished — drives both the
    // "Last refreshed XX ago" pill and the auto-refresh countdown chip.
    const [lastRefreshedAt, setLastRefreshedAt] = React.useState(null);
    // Tracks the most recent refresh trigger reason (manual / auto / mount /
    // initial) so a screen-reader user knows what happened when the page
    // re-paints. Surfaced only to the polite live region.
    const [refreshReason, setRefreshReason] = React.useState(null);
    // URL-synced filters per Contract §4.3. The utilization band now rides on
    // the URL too so a deep link captures the operator's full view (region +
    // low-free threshold + free-text query + risk band).
    const [filters, setFilters] = useUrlState(INITIAL_FILTERS, { replace: true });
    // URL state values are `string | string[] | undefined` per the hook's
    // generic constraint. Narrow to plain `string` here so downstream consumers
    // (Select value props, search.setQuery, ExportMenu metadata) keep their
    // scalar-string types.
    const regionFilter = firstString(filters.region);
    const lowFreeFilter = firstString(filters.lowFree);
    const urlQuery = firstString(filters.q);
    const utilizationBand = React.useMemo(() => coerceBand(firstString(filters.band)), [filters.band]);
    const setUtilizationBand = React.useCallback((band) => setFilters({ band: band === "all" ? "" : band }), [setFilters]);
    // Memoize: `state.accountInfos ?? []` allocates a fresh empty array on every
    // render when the slice is nullish, which would invalidate every downstream
    // memo (regionOptions, accountById, utilizationCounts, alerts). Guard with
    // useMemo so the empty-array identity is stable until the store updates.
    const accountInfos = React.useMemo(() => { var _a; return (_a = state.accountInfos) !== null && _a !== void 0 ? _a : []; }, [state.accountInfos]);
    // Operator-configurable threshold for the alert banner. Persisted across
    // reloads — once an operator picks "warn at 90%" for a noisy fleet, that
    // sticks. v1 schema; if the shape evolves bump the key.
    const [thresholdAlertPct, setThresholdAlertPct] = usePersistedState(THRESHOLD_ALERT_KEY, THRESHOLD_ALERT_DEFAULT_PCT);
    // ---- Page-level ARM token tracker ---------------------------------------
    // This page reads pre-fetched account info from the global store + the
    // orchestrator; it does NOT acquire/hold its own ARM token. But the
    // operator may sit on this view for a long time (auto-refresh on, glancing
    // at quota usage), and any of the deep-link sheet navigations (Pools,
    // Nodes, Create Pool) require a valid ARM token on the destination page.
    // Surface expiry awareness using the first signed-in account so the
    // operator gets a heads-up before they click through to an ARM-heavy view.
    const primaryAccount = ((_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [])[0];
    const armTokenTracker = useArmToken(primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.tenantId);
    // ---- Refresh handler -----------------------------------------------------
    // `inFlightRef` short-circuits overlapping refreshes when the auto-refresh
    // tick fires while a manual refresh is still pending — important because
    // the orchestrator action issues one ARM round-trip per account.
    // `manualAbortRef` lets the Stop button actually cancel the in-flight
    // orchestrator round-trip (the action accepts `signal`).
    // COORDINATOR: extract <RefreshWithAbort> hook — duplicated with overview,
    // pools, nodes, pool-info pages (auto-refresh + inFlightRef + AbortController
    // + lastRefreshedAt + stale-banner is the same recipe everywhere).
    const inFlightRef = React.useRef(false);
    const manualAbortRef = React.useRef(null);
    const refresh = React.useCallback((reason = "manual", signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (inFlightRef.current)
            return;
        inFlightRef.current = true;
        // For manual / mount / retry triggers we own the controller so Stop can
        // cancel. For auto-refresh ticks the caller may pass its own signal.
        let ownedController = null;
        let effectiveSignal = signal;
        if (!signal) {
            ownedController = new AbortController();
            manualAbortRef.current = ownedController;
            effectiveSignal = ownedController.signal;
        }
        setLoading(true);
        setError(null);
        setRefreshReason(reason);
        try {
            yield orchestrator.execute({
                action: "refresh_account_info",
                payload: {},
                signal: effectiveSignal,
            });
            if (!(effectiveSignal === null || effectiveSignal === void 0 ? void 0 : effectiveSignal.aborted))
                setLastRefreshedAt(Date.now());
        }
        catch (e) {
            if (effectiveSignal === null || effectiveSignal === void 0 ? void 0 : effectiveSignal.aborted)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            // Record refresh failures so the audit-log page reflects what the
            // operator saw. Successful refreshes are intentionally NOT audited:
            // they are pure read-side ARM calls and would drown the log.
            auditLog.record({
                actor: "ui:account-info",
                action: "refresh_account_info",
                target: "fleet",
                status: "failure",
                error: msg,
                details: { reason },
            });
        }
        finally {
            if (!(effectiveSignal === null || effectiveSignal === void 0 ? void 0 : effectiveSignal.aborted))
                setLoading(false);
            inFlightRef.current = false;
            if (ownedController && manualAbortRef.current === ownedController) {
                manualAbortRef.current = null;
            }
        }
    }), [orchestrator]);
    // Stop button: cancel the in-flight ARM round-trip (if any), drop the
    // spinner, and disable auto-refresh so the next tick doesn't fire. Records
    // an audit entry — operator-initiated cancellation of fleet activity is
    // worth keeping a trail of even though it isn't strictly "destructive".
    const stop = React.useCallback(() => {
        if (manualAbortRef.current) {
            manualAbortRef.current.abort();
            manualAbortRef.current = null;
        }
        setLoading(false);
        setAutoRefresh(false);
        auditLog.record({
            actor: "ui:account-info",
            action: "refresh_account_info.stop",
            target: "fleet",
            status: "success",
        });
    }, [setAutoRefresh]);
    // Auto-load on mount when accountInfos is empty. Uses a ref so React 18
    // double-invoked StrictMode mounts don't fire two parallel refreshes.
    // The `useAbortableEffect` signal propagates into the orchestrator so an
    // immediate unmount cancels in-flight ARM round-trips.
    const autoLoadedRef = React.useRef(false);
    useAbortableEffect((signal) => {
        if (autoLoadedRef.current)
            return;
        if (accountInfos.length > 0) {
            // Data already in the store from a prior visit — record a synthetic
            // "last refreshed" so the chip + stale warning have a reference.
            if (lastRefreshedAt == null)
                setLastRefreshedAt(Date.now());
            return;
        }
        autoLoadedRef.current = true;
        void refresh("mount", signal);
    }, 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountInfos.length, refresh]);
    // Auto-refresh interval. Skips ticks while a refresh is in flight.
    React.useEffect(() => {
        if (!autoRefresh)
            return;
        const id = setInterval(() => {
            if (inFlightRef.current)
                return;
            void refresh("auto");
        }, AUTO_REFRESH_INTERVAL_MS);
        return () => clearInterval(id);
    }, [autoRefresh, refresh]);
    // ---- Region facet options ------------------------------------------------
    const regionOptions = React.useMemo(() => {
        const set = new Set();
        for (const a of accountInfos) {
            if (a.region)
                set.add(a.region);
        }
        return Array.from(set).sort(compareStrings);
    }, [accountInfos]);
    // ---- Search (free-text) --------------------------------------------------
    // Local input state (instant typing UX); we mirror the *debounced* query
    // into the URL so a deep link still reflects the search.
    const [searchInput, setSearchInput] = React.useState(urlQuery);
    // `accountInfos` is typed `ReadonlyArray<AccountInfo>` (the memo above
    // freezes the empty-array identity), but `useSearch` expects a mutable
    // `AccountInfo[]`. The hook treats its input as read-only, so a structural
    // cast is safe; spread would re-allocate every render and defeat the memo.
    const search = useSearch(accountInfos, ["accountName", "region", "resourceGroup", "subscriptionId"], 200);
    // Mirror URL → input on back/forward navigation. Only fires when the URL
    // value differs from what we typed.
    React.useEffect(() => {
        setSearchInput(urlQuery);
        search.setQuery(urlQuery);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [urlQuery]);
    // Mirror input → URL (debounced inside useUrlState already so this is fine).
    React.useEffect(() => {
        if (searchInput === urlQuery)
            return;
        setFilters({ q: searchInput });
        search.setQuery(searchInput);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchInput]);
    // Apply search *before* facets so the count badges reflect post-search
    // numbers (matches how Nodes / EA pages compose their pipelines).
    const searchedAccounts = search.filteredItems;
    // ---- Filter pipeline -----------------------------------------------------
    const filteredAccounts = React.useMemo(() => {
        let rows = searchedAccounts;
        if (regionFilter)
            rows = rows.filter((a) => a.region === regionFilter);
        if (lowFreeFilter) {
            const threshold = Number(lowFreeFilter);
            if (Number.isFinite(threshold)) {
                rows = rows.filter((a) => safeNum(a.lowPriorityCoresFree) < threshold);
            }
        }
        if (utilizationBand !== "all") {
            rows = rows.filter((a) => {
                const dq = safeNum(a.dedicatedCoreQuota);
                const lq = safeNum(a.lowPriorityCoreQuota);
                const totalQuota = dq + lq;
                if (totalQuota === 0)
                    return utilizationBand === "healthy";
                const totalUsed = safeNum(a.dedicatedCoresUsed) + safeNum(a.lowPriorityCoresUsed);
                const pct = Math.round((totalUsed / totalQuota) * 100);
                if (utilizationBand === "critical")
                    return pct > CRITICAL_UTILIZATION_PCT;
                if (utilizationBand === "warning")
                    return (pct >= WARNING_UTILIZATION_PCT && pct <= CRITICAL_UTILIZATION_PCT);
                return pct < WARNING_UTILIZATION_PCT;
            });
        }
        return rows;
    }, [
        searchedAccounts,
        regionFilter,
        lowFreeFilter,
        utilizationBand,
    ]);
    // Utilization counts across the *un-filtered* pool — chips always show the
    // full-fleet picture so the operator can see "5 critical" even after
    // narrowing the table.
    const utilizationCounts = React.useMemo(() => {
        let critical = 0;
        let warning = 0;
        let healthy = 0;
        for (const a of accountInfos) {
            const dq = safeNum(a.dedicatedCoreQuota);
            const lq = safeNum(a.lowPriorityCoreQuota);
            const totalQuota = dq + lq;
            const totalUsed = safeNum(a.dedicatedCoresUsed) + safeNum(a.lowPriorityCoresUsed);
            if (totalQuota === 0) {
                healthy++;
                continue;
            }
            const pct = Math.round((totalUsed / totalQuota) * 100);
            if (pct > CRITICAL_UTILIZATION_PCT)
                critical++;
            else if (pct >= WARNING_UTILIZATION_PCT)
                warning++;
            else
                healthy++;
        }
        return { critical, warning, healthy };
    }, [accountInfos]);
    // Reset selection when underlying set shrinks.
    React.useEffect(() => {
        if (selection.size === 0)
            return;
        const visibleIds = new Set(filteredAccounts.map((a) => a.id));
        let changed = false;
        const next = new Set();
        for (const id of selection) {
            if (visibleIds.has(id)) {
                next.add(id);
            }
            else {
                changed = true;
            }
        }
        if (changed)
            setSelection(next);
    }, [filteredAccounts, selection]);
    // Aggregated summary via shared helper.
    const summary = React.useMemo(() => summarizeAccountInfos(filteredAccounts), [filteredAccounts]);
    // ---- Filter setters ------------------------------------------------------
    const handleRegionChange = React.useCallback((value) => setFilters({ region: value === ALL_REGIONS ? "" : value }), [setFilters]);
    const handleLowFreeChange = React.useCallback((value) => setFilters({ lowFree: value === ALL_REGIONS ? "" : value }), [setFilters]);
    const clearFilters = React.useCallback(() => {
        setFilters({ region: "", lowFree: "", q: "", band: "" });
        setSearchInput("");
    }, [setFilters]);
    const filtersActive = Boolean(regionFilter || lowFreeFilter || urlQuery || utilizationBand !== "all");
    // ---- Deep-link sheet -----------------------------------------------------
    // Build an id → account index once per account-set change so the deep-link
    // lookup is O(1) instead of O(N) per render. With ~hundreds of accounts the
    // difference is small but the index also feeds the deep-link clipboard
    // affordance below without re-scanning the list.
    const accountById = React.useMemo(() => {
        const map = new Map();
        for (const a of accountInfos)
            map.set(a.id, a);
        return map;
    }, [accountInfos]);
    const focusedAccount = React.useMemo(() => {
        var _a;
        if (!routeAccountId)
            return null;
        return (_a = accountById.get(routeAccountId)) !== null && _a !== void 0 ? _a : null;
    }, [routeAccountId, accountById]);
    const sheetOpen = Boolean(routeAccountId);
    const handleSheetOpenChange = React.useCallback((open) => {
        if (!open)
            navigate("/account-info");
    }, [navigate]);
    const handleRowActivate = React.useCallback((row) => {
        navigate(`/account-info/${encodeURIComponent(row.id)}`);
    }, [navigate]);
    const handleAccountIdActivate = React.useCallback((id) => {
        navigate(`/account-info/${encodeURIComponent(id)}`);
    }, [navigate]);
    const handleSheetNavigate = React.useCallback((path) => navigate(path), [navigate]);
    // Absolute deep-link URL for the currently focused account — null when no
    // sheet is open, or when no DOM `location` is available (SSR/jest). The
    // anchor is the canonical `/account-info/<id>` route so the recipient lands
    // back on this exact sheet view. Guarded against ssr by `typeof window`.
    const deepLinkUrl = React.useMemo(() => {
        if (!focusedAccount)
            return undefined;
        if (typeof window === "undefined" || !window.location)
            return undefined;
        const origin = window.location.origin;
        const pathname = window.location.pathname.replace(/\/account-info(?:\/[^/]*)?$/, "");
        return `${origin}${pathname}/account-info/${encodeURIComponent(focusedAccount.id)}`;
    }, [focusedAccount]);
    // ---- Keyboard shortcuts --------------------------------------------------
    const searchInputRef = React.useRef(null);
    // Debounce the `r` hotkey so key-repeat (holding the key) coalesces into a
    // single refresh — `inFlightRef` would short-circuit duplicates but we'd
    // still allocate AbortControllers + emit `setRefreshReason` churn on every
    // re-trigger. 250 ms covers the OS autorepeat interval comfortably.
    const refreshHotkeyDebounceRef = React.useRef(null);
    const debouncedManualRefresh = React.useCallback(() => {
        if (refreshHotkeyDebounceRef.current != null)
            return;
        refreshHotkeyDebounceRef.current = window.setTimeout(() => {
            refreshHotkeyDebounceRef.current = null;
        }, 250);
        void refresh("manual-hotkey");
    }, [refresh]);
    // Clean up the debounce timer on unmount so we don't leak a setTimeout
    // handle into a re-mounted page (StrictMode double-mount safe).
    React.useEffect(() => {
        return () => {
            if (refreshHotkeyDebounceRef.current != null) {
                window.clearTimeout(refreshHotkeyDebounceRef.current);
                refreshHotkeyDebounceRef.current = null;
            }
        };
    }, []);
    const focusSearch = React.useCallback((e) => {
        var _a, _b;
        e.preventDefault();
        (_a = searchInputRef.current) === null || _a === void 0 ? void 0 : _a.focus();
        (_b = searchInputRef.current) === null || _b === void 0 ? void 0 : _b.select();
    }, []);
    const toggleAutoRefresh = React.useCallback(() => {
        setAutoRefresh(!autoRefresh);
    }, [autoRefresh, setAutoRefresh]);
    useShortcut("/", focusSearch);
    useShortcut("r", debouncedManualRefresh);
    useShortcut("a", toggleAutoRefresh);
    // `g a` → go to accounts list root, `g p` → go to pools page scoped to the
    // currently-focused account (or unscoped if no sheet is open). The chord
    // approach mirrors GitHub/Gmail-style navigation and avoids stealing bare
    // letter keys.
    const chordBindings = React.useMemo(() => ({
        a: () => navigate("/account-info"),
        p: () => {
            const id = focusedAccount === null || focusedAccount === void 0 ? void 0 : focusedAccount.id;
            navigate(id ? `/pool-info?accountId=${encodeURIComponent(id)}` : "/pool-info");
        },
    }), [navigate, focusedAccount]);
    useChordSequence("g", chordBindings);
    // Memoized advanced-detection slices. Recomputed only when accountInfos or
    // the persisted threshold change — cheap O(N) scans, but worth caching so
    // typing in the search box doesn't re-walk the dataset.
    const thresholdAlerts = React.useMemo(() => computeThresholdAlerts(accountInfos, thresholdAlertPct), [accountInfos, thresholdAlertPct]);
    const surfaceRiskRows = React.useMemo(() => computeSurfaceRiskRows(accountInfos), [accountInfos]);
    const subscriptionCollisions = React.useMemo(() => computeSubscriptionCollisions(accountInfos), [accountInfos]);
    // ---- DataTable columns ---------------------------------------------------
    const columns = React.useMemo(() => [
        {
            id: "accountName",
            header: "Account Name",
            cell: (row) => {
                var _a, _b;
                return (React.createElement("span", { className: "group/copy inline-flex items-center gap-1.5 font-medium text-foreground" },
                    React.createElement("span", { className: "truncate" }, (_a = row.accountName) !== null && _a !== void 0 ? _a : ""),
                    React.createElement(CopyButton, { value: (_b = row.accountName) !== null && _b !== void 0 ? _b : "", ariaLabel: `Copy account name ${row.accountName}` })));
            },
            sort: (a, b) => { var _a, _b; return compareStrings((_a = a.accountName) !== null && _a !== void 0 ? _a : "", (_b = b.accountName) !== null && _b !== void 0 ? _b : ""); },
            csv: (row) => { var _a; return (_a = row.accountName) !== null && _a !== void 0 ? _a : ""; },
        },
        {
            id: "region",
            header: "Region",
            cell: (row) => row.region ? (React.createElement(RegionBadge, { region: row.region })) : (React.createElement("span", { className: "text-muted-foreground" }, "\u2014")),
            sort: (a, b) => { var _a, _b; return compareStrings((_a = a.region) !== null && _a !== void 0 ? _a : "", (_b = b.region) !== null && _b !== void 0 ? _b : ""); },
            csv: (row) => { var _a; return (_a = row.region) !== null && _a !== void 0 ? _a : ""; },
        },
        {
            id: "subscription",
            header: "Subscription",
            cell: (row) => {
                var _a;
                const subId = (_a = row.subscriptionId) !== null && _a !== void 0 ? _a : "";
                if (!subId)
                    return React.createElement("span", { className: "text-muted-foreground" }, "\u2014");
                return (React.createElement(CopyableText, { value: subId, display: React.createElement("span", { title: subId }, subId.length > 8 ? `${subId.substring(0, 8)}…` : subId), mono: true, ariaLabel: "Copy subscription id" }));
            },
            csv: (row) => { var _a; return (_a = row.subscriptionId) !== null && _a !== void 0 ? _a : ""; },
            defaultHidden: true,
        },
        {
            id: "lpQuota",
            header: "LP Quota",
            cell: (row) => (React.createElement("span", { className: "tabular-nums text-foreground" }, formatNumber(safeNum(row.lowPriorityCoreQuota)))),
            sort: (a, b) => compareNumbers(safeNum(a.lowPriorityCoreQuota), safeNum(b.lowPriorityCoreQuota)),
            csv: (row) => safeNum(row.lowPriorityCoreQuota),
        },
        {
            id: "lpUsed",
            header: "LP Used",
            cell: (row) => (React.createElement(UsageBar, { used: safeNum(row.lowPriorityCoresUsed), quota: safeNum(row.lowPriorityCoreQuota) })),
            sort: (a, b) => compareNumbers(safeNum(a.lowPriorityCoresUsed), safeNum(b.lowPriorityCoresUsed)),
            csv: (row) => safeNum(row.lowPriorityCoresUsed),
        },
        {
            id: "lpFree",
            header: "LP Free",
            cell: (row) => {
                const free = safeNum(row.lowPriorityCoresFree);
                return (React.createElement("span", { className: cn("tabular-nums", free > 0
                        ? "font-semibold text-success"
                        : "text-muted-foreground") }, formatNumber(free)));
            },
            sort: (a, b) => compareNumbers(safeNum(a.lowPriorityCoresFree), safeNum(b.lowPriorityCoresFree)),
            csv: (row) => safeNum(row.lowPriorityCoresFree),
        },
        {
            id: "dedicatedFree",
            header: "Dedicated Free",
            cell: (row) => {
                const free = safeNum(row.dedicatedCoresFree);
                return (React.createElement("span", { className: cn("tabular-nums", free > 0 ? "text-foreground" : "text-muted-foreground") }, formatNumber(free)));
            },
            sort: (a, b) => compareNumbers(safeNum(a.dedicatedCoresFree), safeNum(b.dedicatedCoresFree)),
            csv: (row) => safeNum(row.dedicatedCoresFree),
        },
        {
            id: "dedicatedQuota",
            header: "Dedicated Quota",
            cell: (row) => (React.createElement("span", { className: "tabular-nums text-muted-foreground" }, formatNumber(safeNum(row.dedicatedCoreQuota)))),
            sort: (a, b) => compareNumbers(safeNum(a.dedicatedCoreQuota), safeNum(b.dedicatedCoreQuota)),
            csv: (row) => safeNum(row.dedicatedCoreQuota),
        },
        {
            id: "poolCount",
            header: "Pool Count",
            cell: (row) => (React.createElement("span", { className: "tabular-nums text-foreground" }, formatNumber(safeNum(row.poolCount)))),
            sort: (a, b) => compareNumbers(safeNum(a.poolCount), safeNum(b.poolCount)),
            csv: (row) => safeNum(row.poolCount),
        },
        {
            id: "poolQuota",
            header: "Pool Quota",
            cell: (row) => (React.createElement("span", { className: "tabular-nums text-foreground" }, formatNumber(safeNum(row.poolQuota)))),
            sort: (a, b) => compareNumbers(safeNum(a.poolQuota), safeNum(b.poolQuota)),
            csv: (row) => safeNum(row.poolQuota),
        },
        {
            id: "poolsFree",
            header: "Pools Free",
            cell: (row) => {
                const free = safeNum(row.poolsFree);
                return (React.createElement("span", { className: cn("tabular-nums", free > 0
                        ? "font-semibold text-success"
                        : "text-muted-foreground") }, formatNumber(free)));
            },
            sort: (a, b) => compareNumbers(safeNum(a.poolsFree), safeNum(b.poolsFree)),
            csv: (row) => safeNum(row.poolsFree),
        },
    ], []);
    // ---- Export columns (mirror the DataTable schema) ------------------------
    const exportColumns = React.useMemo(() => [
        { header: "Account Name", accessor: (r) => { var _a; return (_a = r.accountName) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Region", accessor: (r) => { var _a; return (_a = r.region) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Subscription Id", accessor: (r) => { var _a; return (_a = r.subscriptionId) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Resource Group", accessor: (r) => { var _a; return (_a = r.resourceGroup) !== null && _a !== void 0 ? _a : ""; } },
        { header: "LP Quota", accessor: (r) => safeNum(r.lowPriorityCoreQuota) },
        { header: "LP Used", accessor: (r) => safeNum(r.lowPriorityCoresUsed) },
        { header: "LP Free", accessor: (r) => safeNum(r.lowPriorityCoresFree) },
        {
            header: "Dedicated Quota",
            accessor: (r) => safeNum(r.dedicatedCoreQuota),
        },
        {
            header: "Dedicated Used",
            accessor: (r) => safeNum(r.dedicatedCoresUsed),
        },
        {
            header: "Dedicated Free",
            accessor: (r) => safeNum(r.dedicatedCoresFree),
        },
        { header: "Pool Count", accessor: (r) => safeNum(r.poolCount) },
        { header: "Pool Quota", accessor: (r) => safeNum(r.poolQuota) },
        { header: "Pools Free", accessor: (r) => safeNum(r.poolsFree) },
        {
            header: "Per-Family Enforced",
            accessor: (r) => r.dedicatedCoreQuotaPerVMFamilyEnforced ? "true" : "false",
        },
    ], []);
    // ---- Render branches -----------------------------------------------------
    const initialLoading = loading && accountInfos.length === 0;
    const fetchFailed = !loading && error !== null && accountInfos.length === 0;
    const emptyOverall = accountInfos.length === 0 && !loading && !fetchFailed;
    const tableEmpty = (React.createElement(EmptyState, { icon: filtersActive ? Filter : Users, title: filtersActive
            ? "No accounts match the current filter"
            : "No accounts in this view", description: filtersActive
            ? "Try clearing or relaxing the filters above to see more accounts."
            : "Refresh account info from Azure to populate this view.", action: filtersActive
            ? { label: "Clear filters", onClick: clearFilters, icon: Filter }
            : {
                label: "Refresh",
                onClick: () => void refresh("empty-state"),
                icon: RotateCw,
                loading,
            } }));
    // Stale-data check — used to surface a soft warning when data is older
    // than 5 minutes and auto-refresh is off.
    const isStale = !autoRefresh &&
        lastRefreshedAt != null &&
        Date.now() - lastRefreshedAt > STALE_DATA_THRESHOLD_MS;
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4", "aria-labelledby": "account-info-heading" },
        React.createElement("div", { className: "relative overflow-hidden rounded-xl border bg-card/50 p-6" },
            React.createElement(DotPattern, { fade: "top-left" }),
            React.createElement(Meteors, { count: 10, tone: "primary" }),
            React.createElement("div", { className: "relative z-10" },
                React.createElement(PageHeader, { title: "Account Info", description: "Quota, usage, and pool capacity across every Azure Batch account.", titleId: "account-info-heading" },
                    React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                            loginHint: primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username,
                        }) }),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { variant: "default", size: "sm", onClick: () => void refresh("manual"), loading: loading, "aria-label": "Refresh account info (press R)" },
                                React.createElement(RotateCw, null),
                                "Refresh")),
                        React.createElement(TooltipContent, null,
                            "Refresh now \u2014 keyboard ",
                            React.createElement(Kbd, null, "r"))),
                    loading && (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", role: "status", "aria-live": "polite" },
                            React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin motion-reduce:animate-none", "aria-label": "Loading" }),
                            React.createElement("span", null, refreshReason === "auto"
                                ? "Auto-refreshing…"
                                : "Loading…")),
                        React.createElement(Tooltip, null,
                            React.createElement(TooltipTrigger, { asChild: true },
                                React.createElement(Button, { variant: "outline", size: "sm", onClick: stop, "aria-label": "Stop refresh", className: "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" },
                                    React.createElement(Square, null),
                                    "Stop")),
                            React.createElement(TooltipContent, null, "Stops auto-refresh and dismisses the spinner. In-flight ARM calls will still resolve.")))),
                    React.createElement("div", { className: "ml-2 flex items-center gap-2" },
                        React.createElement(Switch, { id: "account-info-auto-refresh", checked: autoRefresh, onCheckedChange: (checked) => setAutoRefresh(checked === true), "aria-label": "Toggle auto-refresh every 30 seconds (press A)" }),
                        React.createElement(Tooltip, null,
                            React.createElement(TooltipTrigger, { asChild: true },
                                React.createElement(Label, { htmlFor: "account-info-auto-refresh", className: "cursor-pointer text-xs text-muted-foreground" }, "Auto-refresh (30s)")),
                            React.createElement(TooltipContent, null,
                                "Toggle every 30 seconds \u2014 keyboard ",
                                React.createElement(Kbd, null, "a"))),
                        React.createElement(AutoRefreshChip, { enabled: autoRefresh, loading: loading, lastRefreshedAt: lastRefreshedAt })),
                    lastRefreshedAt != null && (React.createElement("span", { className: cn("ml-1 inline-flex items-center gap-1 text-2xs tabular-nums", isStale ? "text-warning" : "text-muted-foreground"), "aria-live": "polite", title: `Last refreshed ${new Date(lastRefreshedAt).toLocaleString()}` },
                        isStale && (React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true })),
                        "Updated ",
                        formatRelativeTime(new Date(lastRefreshedAt))))))),
        error && accountInfos.length > 0 && (React.createElement(Alert, { variant: "destructive", role: "alert", "aria-live": "assertive", className: "flex items-start gap-3" },
            React.createElement(AlertCircle, { className: "h-4 w-4" }),
            React.createElement(AlertDescription, { className: "flex-1" }, error),
            React.createElement("div", { className: "flex shrink-0 items-center gap-2" },
                React.createElement(Button, { variant: "outline", size: "sm", onClick: () => void refresh("retry"), "aria-label": "Retry loading account info" }, "Retry"),
                React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setError(null), "aria-label": "Dismiss error" }, "Dismiss")))),
        isStale && !error && (React.createElement(Alert, { variant: "default", role: "status", className: "flex items-start gap-3 border-warning/40 bg-warning/10" },
            React.createElement(AlertTriangle, { className: "h-4 w-4 text-warning" }),
            React.createElement(AlertDescription, { className: "flex-1 text-warning" },
                "Showing data refreshed ",
                formatRelativeTime(new Date(lastRefreshedAt)),
                ". Quota numbers may be out of date."),
            React.createElement(Button, { variant: "outline", size: "sm", onClick: () => void refresh("stale-banner"), "aria-label": "Refresh stale data" },
                React.createElement(RotateCw, null),
                "Refresh now"))),
        React.createElement("div", { className: "relative overflow-hidden rounded-xl" },
            React.createElement(BorderBeam, { size: 200, duration: 8 }),
            React.createElement(AccountInfoSummaryBar, { summary: summary })),
        accountInfos.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-2", role: "group", "aria-label": "Filter accounts by utilization band" },
            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Utilization"),
            React.createElement(UtilizationChip, { label: "All", count: accountInfos.length, active: utilizationBand === "all", tone: "neutral", onClick: () => setUtilizationBand("all") }),
            React.createElement(UtilizationChip, { label: `Critical (>${CRITICAL_UTILIZATION_PCT}%)`, count: utilizationCounts.critical, active: utilizationBand === "critical", tone: "destructive", onClick: () => setUtilizationBand("critical") }),
            React.createElement(UtilizationChip, { label: `Warning (${WARNING_UTILIZATION_PCT}–${CRITICAL_UTILIZATION_PCT}%)`, count: utilizationCounts.warning, active: utilizationBand === "warning", tone: "warning", onClick: () => setUtilizationBand("warning") }),
            React.createElement(UtilizationChip, { label: `Healthy (<${WARNING_UTILIZATION_PCT}%)`, count: utilizationCounts.healthy, active: utilizationBand === "healthy", tone: "success", onClick: () => setUtilizationBand("healthy") }))),
        accountInfos.length > 0 && (React.createElement(QuotaGlance
        // `accountInfos` is `ReadonlyArray<AccountInfo>` from the memo
        // above; the consumer's prop type wants a mutable array but does
        // not mutate. Structural cast keeps the memoized identity stable.
        , { 
            // `accountInfos` is `ReadonlyArray<AccountInfo>` from the memo
            // above; the consumer's prop type wants a mutable array but does
            // not mutate. Structural cast keeps the memoized identity stable.
            accounts: accountInfos, onAccountClick: handleAccountIdActivate })),
        accountInfos.length > 0 && thresholdAlerts.length > 0 && (React.createElement(ThresholdAlertsCard, { alerts: thresholdAlerts, thresholdPct: thresholdAlertPct, onChangeThreshold: setThresholdAlertPct, onOpenAccount: handleAccountIdActivate })),
        accountInfos.length > 0 &&
            (surfaceRiskRows.length > 0 || subscriptionCollisions.length > 0) && (React.createElement("div", { className: "grid grid-cols-1 gap-3 lg:grid-cols-2" },
            surfaceRiskRows.length > 0 && (React.createElement(SurfaceRiskCard, { rows: surfaceRiskRows, onOpenAccount: handleAccountIdActivate })),
            subscriptionCollisions.length > 0 && (React.createElement(SubscriptionCollisionsCard, { collisions: subscriptionCollisions, onOpenAccount: handleAccountIdActivate })))),
        React.createElement("div", { className: "flex flex-wrap items-end gap-3", role: "region", "aria-label": "Filters" },
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { htmlFor: "account-info-search", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Search"),
                React.createElement("div", { className: "relative" },
                    React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                    React.createElement(Input, { ref: searchInputRef, id: "account-info-search", type: "search", value: searchInput, onChange: (e) => setSearchInput(e.target.value), placeholder: "Name, region, RG, subscription\u2026", "aria-label": "Search accounts by name, region, resource group, or subscription", className: "h-8 w-64 pl-7 pr-8" }),
                    searchInput && (React.createElement("button", { type: "button", onClick: () => setSearchInput(""), className: "absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Clear search" },
                        React.createElement(X, { className: "h-3 w-3" }))),
                    React.createElement(Kbd, { className: "pointer-events-none absolute right-9 top-1/2 hidden -translate-y-1/2 sm:inline-flex", size: "xs" }, "/"))),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { htmlFor: "account-info-region", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Region"),
                React.createElement(Select, { value: regionFilter || ALL_REGIONS, onValueChange: handleRegionChange },
                    React.createElement(SelectTrigger, { id: "account-info-region", className: "h-8 w-44", "aria-label": "Filter by region" },
                        React.createElement(SelectValue, { placeholder: "All regions" })),
                    React.createElement(SelectContent, null,
                        React.createElement(SelectItem, { value: ALL_REGIONS }, "All regions"),
                        regionOptions.map((r) => (React.createElement(SelectItem, { key: r, value: r }, r)))))),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { htmlFor: "account-info-low-free", className: "inline-flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground" },
                    "Free LP cores below",
                    React.createElement(InfoTooltip, { content: "Surface only accounts whose remaining low-priority core headroom is below the chosen threshold \u2014 useful when you need to find where to land a new pool.", size: 12 })),
                React.createElement(Select, { value: lowFreeFilter || ALL_REGIONS, onValueChange: handleLowFreeChange },
                    React.createElement(SelectTrigger, { id: "account-info-low-free", className: "h-8 w-44", "aria-label": "Filter to accounts with low free LP cores" },
                        React.createElement(SelectValue, { placeholder: "No threshold" })),
                    React.createElement(SelectContent, null,
                        React.createElement(SelectItem, { value: ALL_REGIONS }, "No threshold"),
                        LOW_FREE_THRESHOLDS.map((n) => (React.createElement(SelectItem, { key: n, value: n },
                            "< ",
                            n,
                            " cores")))))),
            filtersActive && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearFilters, "aria-label": "Clear all filters" },
                React.createElement(X, null),
                "Clear filters")),
            React.createElement("div", { className: "ml-auto flex items-center gap-2" },
                React.createElement(ExportMenu, { rows: filteredAccounts, columns: exportColumns, filename: "account-info", jsonMetadata: {
                        filters: {
                            region: regionFilter || null,
                            lowFree: lowFreeFilter || null,
                            query: urlQuery || null,
                            utilizationBand,
                        },
                    } }),
                React.createElement("div", { className: "text-xs text-muted-foreground tabular-nums", "aria-live": "polite" },
                    "Showing ",
                    formatNumber(filteredAccounts.length),
                    " of",
                    " ",
                    formatNumber(accountInfos.length),
                    " accounts",
                    selection.size > 0 && (React.createElement("span", { className: "ml-2 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-primary" },
                        React.createElement(Cpu, { className: "h-3 w-3", "aria-hidden": true }),
                        selection.size,
                        " selected"))))),
        initialLoading ? (React.createElement("div", { className: "rounded-md border border-border bg-card p-4" },
            React.createElement(SkeletonLoader, { variant: "table", rows: 6, columns: 10 }))) : fetchFailed ? (React.createElement(ErrorState, { message: "Failed to load account info.", detail: error, onRetry: () => void refresh("retry") })) : emptyOverall ? (React.createElement(EmptyState, { icon: Search, title: "No account info loaded yet", description: "Pull the latest quota and capacity numbers from Azure to populate this page.", action: {
                label: "Load account info",
                onClick: () => void refresh("manual"),
                icon: RotateCw,
                loading,
            } })) : (React.createElement(DataTable, { tableId: "account-info", rows: filteredAccounts, columns: columns, rowKey: (r) => r.id, empty: tableEmpty, loading: loading && accountInfos.length === 0, selection: selection, onSelectionChange: setSelection, onRowActivate: handleRowActivate, csvFileName: "account-info.csv", initialSort: { column: "lpFree", direction: "desc" } })),
        React.createElement("div", { className: "flex flex-wrap items-center gap-3 text-2xs text-muted-foreground" },
            React.createElement("span", { className: "inline-flex items-center gap-1" },
                React.createElement(Kbd, null, "/"),
                " search"),
            React.createElement("span", { className: "inline-flex items-center gap-1" },
                React.createElement(Kbd, null, "r"),
                " refresh"),
            React.createElement("span", { className: "inline-flex items-center gap-1" },
                React.createElement(Kbd, null, "a"),
                " auto-refresh"),
            React.createElement("span", { className: "inline-flex items-center gap-1" },
                React.createElement(Kbd, null, "g"),
                React.createElement(Kbd, null, "a"),
                " accounts list"),
            React.createElement("span", { className: "inline-flex items-center gap-1" },
                React.createElement(Kbd, null, "g"),
                React.createElement(Kbd, null, "p"),
                " pools",
                focusedAccount ? " (this account)" : ""),
            React.createElement("span", { className: "inline-flex items-center gap-1" },
                React.createElement(Kbd, null, "Esc"),
                " close detail sheet")),
        React.createElement(AccountDetailSheet, { account: focusedAccount, open: sheetOpen, onOpenChange: handleSheetOpenChange, onNavigate: handleSheetNavigate, loading: loading && accountInfos.length === 0, deepLinkUrl: deepLinkUrl })));
};
const UtilizationChip = ({ label, count, active, tone, onClick, }) => {
    const activeClasses = {
        neutral: "bg-primary text-primary-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        warning: "bg-warning text-warning-foreground",
        success: "bg-success text-success-foreground",
    };
    const idleClasses = {
        neutral: "bg-muted text-muted-foreground hover:bg-muted/80",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
        warning: "bg-warning/10 text-warning hover:bg-warning/20",
        success: "bg-success/10 text-success hover:bg-success/20",
    };
    return (React.createElement("button", { type: "button", onClick: onClick, "aria-pressed": active, className: cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background", active ? activeClasses[tone] : idleClasses[tone]) },
        React.createElement("span", null, label),
        React.createElement("span", { className: cn("inline-flex h-4 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-2xs tabular-nums", active ? "bg-black/15 text-current" : "bg-background/60 text-current"), "aria-label": `${count} accounts` }, formatNumber(count))));
};
/* ------------------------------------------------------------------ */
/*  Exported wrapper                                                   */
/* ------------------------------------------------------------------ */
export const AccountInfoPage = (props) => (React.createElement(ErrorBoundary, null,
    React.createElement(AccountInfoPageInner, Object.assign({}, props))));
//# sourceMappingURL=account-info-page.js.map