import { __awaiter } from "tslib";
/**
 * Overview page — multi-region dashboard. Surfaces KPIs (accounts/pools/nodes
 * /cores), per-region health, and the unused-quota auto-create workflow.
 *
 * Trend metrics honour the URL-synced [24h | 7d | 30d] range toggle and are
 * derived from the rolling `state.history` buffer (the prior implementation
 * synthesized "trend %" by multiplying a current-state ratio by 1/3/7, which
 * was deterministic but not actually a trend — fixed in this revision).
 *
 * URL state synced here:
 *   - `?range=24h|7d|30d`   trend window
 *   - `?regionSearch=...`   cluster-health region search query
 *   - `?regionStatus=...`   cluster-health quick filter chip (all | healthy
 *                           | degraded | down)
 *   - `?quotaSearch=...`    unused-quota table search query
 *   - `?activity=on|off`    recent-activity panel collapsed state
 *
 * Keyboard shortcuts:
 *   - `r`  → Refresh all (when no input focused)
 *   - `/`  → Focus the unused-quota search box (when the table is visible)
 *   - `1`  → Navigate to Accounts (Batch account list)
 *   - `2`  → Navigate to Pool Info (per-pool details)
 *   - `3`  → Navigate to Nodes (compute-node grid)
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, Boxes, CheckCircle2, ChevronDown, ChevronRight, Cpu, Download, Eye, EyeOff, HardDrive, Layers, ListChecks, Loader2, LogIn, Maximize2, Minimize2, Minus, PiggyBank, Plus, RefreshCw, Search, Server, Settings2, ShieldAlert, TrendingDown, TrendingUp, X, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BorderBeam, DotPattern, HoverList, Meteors, NumberTicker, } from "@/components/ui/effects";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sparkline } from "@/components/ui/charts/sparkline";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { TONE_CLASSES } from "@/styles/tokens";
import { cn, formatNumber } from "@/lib/utils";
import { useArmToken } from "../../auth/use-arm-token";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { useDashboardStats, useMultiRegionState, } from "../../store/store-context";
import { useDashboardOutletContext } from "../page-router";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton } from "../shared/copy-button";
import { DataTable } from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { RegionHealthChart } from "../shared/region-health-chart";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { StatusBadge } from "../shared/status-badge";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
// ---------------------------------------------------------------------------
// Range toggle
// ---------------------------------------------------------------------------
const RANGE_OPTIONS = ["24h", "7d", "30d"];
const RANGE_LABEL = {
    "24h": "previous 24h",
    "7d": "previous 7d",
    "30d": "previous 30d",
};
function isRangeKey(value) {
    return RANGE_OPTIONS.includes(value);
}
// Approx number of history samples per range bucket. The rolling buffer caps
// at ~120 samples (~2h at 60s refresh), so longer windows fall back to "all
// available history" without erroring.
const RANGE_HISTORY_WINDOW = {
    "24h": 24,
    "7d": 90,
    "30d": 120,
};
const REGION_STATUS_FILTERS = [
    { key: "all", label: "All", tone: "muted" },
    { key: "healthy", label: "Healthy", tone: "success" },
    { key: "degraded", label: "Degraded", tone: "warning" },
    { key: "down", label: "Down", tone: "destructive" },
    { key: "nodata", label: "No data", tone: "info" },
];
function isRegionStatusFilter(value) {
    return REGION_STATUS_FILTERS.some((f) => f.key === value);
}
/**
 * Compute a "% change" trend for a sample series over the window. Compares
 * the most recent sample with the value at `window` samples ago (or the
 * oldest available sample if the buffer is shorter than `window`).
 *
 * `goodDirection` tells the caller which direction renders as positive
 * (success green) — e.g. fewer failed accounts going down is good, more
 * running nodes going up is good. The returned `direction` is the raw
 * delta direction, not the semantic one; callers map it to colour.
 */
function computeTrend(series, window, period) {
    if (series.length < 2)
        return { direction: "flat", pct: 0, period };
    const latest = series[series.length - 1];
    const lookbackIdx = Math.max(0, series.length - 1 - window);
    const baseline = series[lookbackIdx];
    if (!Number.isFinite(latest) || !Number.isFinite(baseline)) {
        return { direction: "flat", pct: 0, period };
    }
    const delta = latest - baseline;
    if (delta === 0 || baseline === 0) {
        return {
            direction: "flat",
            // When baseline is zero but latest is non-zero we still want to
            // show movement; cap to a large but finite percentage so the UI
            // doesn't print "Infinity%".
            pct: baseline === 0 && delta !== 0 ? 100 : 0,
            period,
        };
    }
    const pct = Math.min(999, Math.round(Math.abs(delta / baseline) * 100));
    return {
        direction: delta > 0 ? "up" : "down",
        pct,
        period,
    };
}
const StatCard = ({ id, icon: IconComp, title, info, tone, items, onClick, error, onRetry, trend, goodDirection = "up", sparkData, sparkTone, onFilterFailed, failedCount = 0, }) => {
    const headingId = `${id}-heading`;
    const total = items.length > 0 && items[0].label === "Total"
        ? items[0].value
        : items.reduce((s, i) => s + i.value, 0);
    const toneClasses = TONE_CLASSES[tone];
    const handleKeyDown = (e) => {
        if (!onClick)
            return;
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
        }
    };
    if (error) {
        const destructiveClasses = TONE_CLASSES.destructive;
        return (React.createElement(Card, { role: "region", "aria-labelledby": headingId, className: cn("flex min-w-[200px] flex-1 basis-[200px] flex-col gap-2 border-t-4 bg-card p-5", destructiveClasses.borderTop) },
            React.createElement("div", { className: "flex items-center gap-2.5" },
                React.createElement("span", { className: cn("flex h-8 w-8 items-center justify-center rounded-md", destructiveClasses.bgSubtle) },
                    React.createElement(AlertCircle, { className: cn("h-4 w-4", destructiveClasses.text), "aria-hidden": "true" })),
                React.createElement("span", { id: headingId, className: "text-base font-semibold text-foreground" }, title)),
            React.createElement("p", { className: cn("text-xs", destructiveClasses.text) }, error),
            onRetry && (React.createElement(Button, { variant: "outline", size: "sm", onClick: onRetry, className: "mt-1 self-start", "aria-label": `Retry loading ${title}` },
                React.createElement(RefreshCw, { className: "h-3.5 w-3.5" }),
                "Retry"))));
    }
    // Resolve the semantic colour: when an "up" trend is bad (e.g. failed
    // counts going up) we want destructive instead of success. Flat is always
    // muted-foreground regardless of direction.
    const trendDirectionIsPositive = trend &&
        trend.direction !== "flat" &&
        ((goodDirection === "up" && trend.direction === "up") ||
            (goodDirection === "down" && trend.direction === "down"));
    const TrendIcon = (trend === null || trend === void 0 ? void 0 : trend.direction) === "up"
        ? TrendingUp
        : (trend === null || trend === void 0 ? void 0 : trend.direction) === "down"
            ? TrendingDown
            : Minus;
    const trendToneClass = (trend === null || trend === void 0 ? void 0 : trend.direction) === "flat"
        ? "text-muted-foreground"
        : trendDirectionIsPositive
            ? "text-success"
            : "text-destructive";
    const trendSrText = trend
        ? `${trend.direction === "up"
            ? "up"
            : trend.direction === "down"
                ? "down"
                : "unchanged"} ${trend.pct}% from ${trend.period}`
        : "";
    const isClickable = !!onClick;
    return (React.createElement(Card, { role: isClickable ? "button" : "region", "aria-labelledby": headingId, "data-clickable": isClickable ? "true" : "false", onClick: onClick, onKeyDown: handleKeyDown, tabIndex: isClickable ? 0 : undefined, className: cn("relative min-w-[200px] flex-1 basis-[200px] border-t-4 bg-card p-5 transition-all duration-200 ease-out motion-reduce:transition-none", toneClasses.borderTop, isClickable &&
            "cursor-pointer hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:translate-y-0 active:bg-muted/30 focus-visible:-translate-y-0.5 focus-visible:border-primary/40 focus-visible:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transform-none") },
        React.createElement("div", { className: "flex items-center gap-2.5" },
            React.createElement("span", { className: cn("flex h-8 w-8 items-center justify-center rounded-md", toneClasses.bgSubtle) },
                React.createElement(IconComp, { className: cn("h-4 w-4", toneClasses.text) })),
            React.createElement("span", { id: headingId, className: "flex items-center gap-1 text-base font-semibold text-foreground" },
                title,
                info && (React.createElement(InfoTooltip, { content: info, ariaLabel: `What is ${title}?`, size: 12, 
                    // Stop click from bubbling to the clickable Card.
                    className: "hover:text-foreground" }))),
            React.createElement("span", { "aria-live": "polite", "aria-atomic": "true", className: cn("ml-auto text-2xl font-bold tabular-nums", toneClasses.text) },
                React.createElement(NumberTicker, { value: total }))),
        (trend || (sparkData && sparkData.length >= 2)) && (React.createElement("div", { className: "mt-1 flex items-center justify-between gap-3" },
            trend ? (React.createElement("div", { className: cn("flex items-center gap-1 text-2xs font-medium", trendToneClass), "aria-hidden": "true" },
                React.createElement(TrendIcon, { className: "h-3 w-3" }),
                React.createElement("span", { className: "tabular-nums" },
                    trend.pct,
                    "%"),
                React.createElement("span", { className: "text-muted-foreground" },
                    "vs ",
                    trend.period))) : (React.createElement("span", { "aria-hidden": "true" })),
            sparkData && sparkData.length >= 2 && (React.createElement(Sparkline, { data: sparkData, tone: sparkTone !== null && sparkTone !== void 0 ? sparkTone : tone, width: 72, height: 20, ariaLabel: `${title} trend` })))),
        trend && React.createElement("span", { className: "sr-only" }, trendSrText),
        React.createElement("div", { className: "mt-3 flex flex-wrap gap-4" }, items.map((item) => (React.createElement("div", { key: item.label, className: "flex flex-col" },
            React.createElement("span", { className: "text-2xs uppercase tracking-wide text-muted-foreground" }, item.label),
            React.createElement("span", { className: cn("text-lg font-semibold tabular-nums", item.tone ? TONE_CLASSES[item.tone].text : "text-foreground") },
                React.createElement(NumberTicker, { value: item.value })))))),
        onFilterFailed && failedCount > 0 && (React.createElement("button", { type: "button", 
            // Stop propagation so the outer Card's onClick (whole-card
            // navigate-to-detail) doesn't also fire — we want the filtered
            // deep-link, not the default landing page.
            onClick: (e) => {
                e.stopPropagation();
                onFilterFailed();
            }, onKeyDown: (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                }
            }, className: cn("mt-2 inline-flex items-center gap-1 self-start rounded px-1.5 py-0.5 text-2xs font-medium", TONE_CLASSES.destructive.text, "hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"), "aria-label": `Open ${title} filtered to ${failedCount} failed` },
            "View ",
            failedCount,
            " failed \u2192"))));
};
function classifyRegion(r) {
    if (r.total === 0)
        return { tone: "info", label: "no data", bucket: "nodata" };
    if (r.healthy === r.total)
        return { tone: "success", label: "healthy", bucket: "healthy" };
    if (r.healthy === 0)
        return { tone: "destructive", label: "down", bucket: "down" };
    return { tone: "warning", label: "degraded", bucket: "degraded" };
}
const ClusterHealthCard = ({ regions, historyHealthy, historyUnhealthy, onDrillDown, searchQuery, onSearchQueryChange, statusFilter, onStatusFilterChange, }) => {
    const counts = React.useMemo(() => {
        let healthy = 0;
        let degraded = 0;
        let down = 0;
        let nodata = 0;
        for (const r of regions) {
            const c = classifyRegion(r);
            if (c.bucket === "healthy")
                healthy += 1;
            else if (c.bucket === "degraded")
                degraded += 1;
            else if (c.bucket === "down")
                down += 1;
            else
                nodata += 1;
        }
        return {
            total: regions.length,
            healthy,
            degraded,
            down,
            nodata,
        };
    }, [regions]);
    const filteredRegions = React.useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return regions.filter((r) => {
            if (q && !r.name.toLowerCase().includes(q))
                return false;
            if (statusFilter === "all")
                return true;
            const c = classifyRegion(r);
            return c.bucket === statusFilter;
        });
    }, [regions, searchQuery, statusFilter]);
    const overallTone = counts.down > 0
        ? "destructive"
        : counts.degraded > 0
            ? "warning"
            : "success";
    const overallToneClasses = TONE_CLASSES[overallTone];
    const filterChipCount = {
        all: counts.total,
        healthy: counts.healthy,
        degraded: counts.degraded,
        down: counts.down,
        nodata: counts.nodata,
    };
    return (React.createElement(Card, { role: "region", "aria-labelledby": "cluster-health-heading", className: cn("border-l-4 bg-card p-4", overallToneClasses.borderTop.replace("border-t-", "border-l-")) },
        React.createElement("div", { className: "mb-3 flex flex-wrap items-baseline justify-between gap-3" },
            React.createElement("div", { className: "flex items-baseline gap-3" },
                React.createElement("h2", { id: "cluster-health-heading", className: "m-0 text-base font-semibold text-foreground" }, "Cluster Health"),
                React.createElement("span", { className: cn("rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider", overallToneClasses.bgSubtle, overallToneClasses.text), "aria-label": `Overall status: ${overallTone}` }, overallTone === "success"
                    ? "All regions healthy"
                    : overallTone === "warning"
                        ? "Degraded"
                        : "Outage")),
            React.createElement("div", { className: "flex flex-wrap gap-3 text-2xs text-muted-foreground tabular-nums" },
                React.createElement("span", null,
                    React.createElement("strong", { className: "text-foreground" }, counts.healthy),
                    React.createElement("span", { className: "ml-0.5" }, "healthy")),
                counts.degraded > 0 && (React.createElement("span", null,
                    React.createElement("strong", { className: "text-warning" }, counts.degraded),
                    React.createElement("span", { className: "ml-0.5" }, "degraded"))),
                counts.down > 0 && (React.createElement("span", null,
                    React.createElement("strong", { className: "text-destructive" }, counts.down),
                    React.createElement("span", { className: "ml-0.5" }, "down"))),
                React.createElement("span", null,
                    React.createElement("strong", { className: "text-foreground" }, counts.total),
                    React.createElement("span", { className: "ml-0.5" }, "total")),
                historyHealthy.length >= 2 && (React.createElement(Sparkline, { data: historyHealthy, tone: "success", width: 64, height: 16, ariaLabel: "Healthy regions trend" })))),
        regions.length > 0 && (React.createElement("div", { className: "mb-3 flex flex-wrap items-center gap-2" },
            React.createElement("div", { className: "relative flex-1 sm:max-w-[260px]" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { type: "search", placeholder: "Filter regions...", value: searchQuery, onChange: (e) => onSearchQueryChange(e.target.value), "aria-label": "Filter regions by name", className: "h-8 pl-7 pr-7" }),
                searchQuery && (React.createElement("button", { type: "button", onClick: () => onSearchQueryChange(""), "aria-label": "Clear region search", className: "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" },
                    React.createElement(X, { className: "h-3 w-3", "aria-hidden": true })))),
            React.createElement("div", { role: "group", "aria-label": "Filter regions by status", className: "flex flex-wrap items-center gap-1" }, REGION_STATUS_FILTERS.map((f) => {
                const count = filterChipCount[f.key];
                const disabled = f.key !== "all" && count === 0;
                const active = statusFilter === f.key;
                return (React.createElement("button", { key: f.key, type: "button", disabled: disabled, onClick: () => onStatusFilterChange(f.key), "aria-pressed": active, className: cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-wider transition-colors duration-fast", active
                        ? "border-primary/60 bg-primary/15 text-primary"
                        : "border-border bg-card/40 text-muted-foreground hover:bg-accent/40 hover:text-foreground", disabled && "cursor-not-allowed opacity-40 hover:bg-card/40", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background") },
                    React.createElement("span", null, f.label),
                    React.createElement("span", { className: "tabular-nums opacity-80" }, count)));
            })))),
        filteredRegions.length === 0 && regions.length > 0 ? (React.createElement("p", { className: "m-0 text-xs text-muted-foreground" }, "No regions match the current filter.")) : (React.createElement("ul", { className: "grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6", role: "list", "aria-label": "Region status grid" }, filteredRegions.map((r) => {
            const cls = classifyRegion(r);
            const t = TONE_CLASSES[cls.tone];
            return (React.createElement("li", { key: r.name },
                React.createElement("button", { type: "button", onClick: () => onDrillDown(r.name), className: cn("group flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors duration-fast", t.bgSubtle, t.border, "hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"), "aria-label": `${r.name}: ${cls.label}, ${r.healthy} of ${r.total} healthy` },
                    React.createElement("span", { className: "flex items-center gap-1.5" },
                        React.createElement("span", { className: cn("inline-block h-1.5 w-1.5 rounded-full", t.bg), "aria-hidden": "true" }),
                        React.createElement("span", { className: "truncate font-mono text-xs text-foreground" }, r.name)),
                    React.createElement("span", { className: "flex items-center justify-between text-2xs text-muted-foreground" },
                        React.createElement("span", { className: cn("uppercase tracking-wider", t.text) }, cls.label),
                        React.createElement("span", { className: "tabular-nums" },
                            r.healthy,
                            "/",
                            r.total)))));
        }))),
        historyUnhealthy.length >= 2 &&
            historyUnhealthy.some((v) => v > 0) && (React.createElement("p", { className: "mt-3 text-2xs text-muted-foreground" },
            "Unhealthy region trend over the last",
            " ",
            historyUnhealthy.length,
            " sample",
            historyUnhealthy.length === 1 ? "" : "s",
            ":",
            " ",
            React.createElement(Sparkline, { data: historyUnhealthy, tone: "destructive", width: 120, height: 14, ariaLabel: "Unhealthy regions trend", className: "ml-1 align-middle" })))));
};
// ---------------------------------------------------------------------------
// Agent Status Strip
// ---------------------------------------------------------------------------
const AGENT_STATUS_DOT = {
    idle: "bg-muted-foreground/40",
    running: "bg-info shadow-[0_0_6px_hsl(var(--info))]",
    completed: "bg-success",
    error: "bg-destructive",
};
const AgentStatusStrip = () => {
    const state = useMultiRegionState();
    const entries = Object.entries(state.agentStatuses);
    return (React.createElement(Card, { className: "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" },
        React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Agents"),
        entries.length === 0 ? (React.createElement("span", { className: "text-xs text-muted-foreground" }, "No agents registered.")) : (entries.map(([name, status]) => {
            var _a;
            return (React.createElement("div", { key: name, className: "flex items-center gap-1.5", title: `${name}: ${status}` },
                React.createElement("span", { className: cn("h-2 w-2 rounded-full transition-shadow duration-200 motion-reduce:transition-none", (_a = AGENT_STATUS_DOT[status]) !== null && _a !== void 0 ? _a : "bg-muted-foreground/40"), "aria-hidden": "true" }),
                React.createElement("span", { className: "text-xs text-muted-foreground" }, name),
                React.createElement("span", { className: "text-2xs text-muted-foreground/60" },
                    "(",
                    status,
                    ")")));
        }))));
};
// ---------------------------------------------------------------------------
// Recent Activity
// ---------------------------------------------------------------------------
/**
 * Format a log timestamp safely. Old session blobs sometimes have malformed
 * `timestamp` strings (the persistence layer was tolerant before
 * standardizing on ISO); falling back to an em-dash keeps the row legible
 * instead of printing "Invalid Date".
 */
function formatLogTime(ts) {
    if (!ts)
        return "—";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime()))
        return "—";
    return d.toLocaleTimeString();
}
const RecentActivity = ({ collapsed, onToggleCollapsed, onOpenAuditAction, }) => {
    const state = useMultiRegionState();
    const recentLogs = React.useMemo(() => state.agentLogs.slice(-8), [state.agentLogs]);
    // Last-10 audit entries — clickable rows deep-link into the audit-log
    // page filtered to that action. Reading directly from `state.auditEntries`
    // means any `auditLog.record(...)` from any page reactively shows here.
    const recentAudit = React.useMemo(() => { var _a; return ((_a = state.auditEntries) !== null && _a !== void 0 ? _a : []).slice(-10).reverse(); }, [state.auditEntries]);
    const errorCount = React.useMemo(() => recentLogs.filter((l) => l.level === "error").length, [recentLogs]);
    const auditFailureCount = React.useMemo(() => recentAudit.filter((e) => e.status === "failure").length, [recentAudit]);
    return (React.createElement(Card, { className: "p-4" },
        React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
            React.createElement("button", { type: "button", onClick: onToggleCollapsed, "aria-expanded": !collapsed, "aria-controls": "recent-activity-body", className: "inline-flex items-baseline gap-1.5 rounded-sm text-base font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background" },
                collapsed ? (React.createElement(ChevronRight, { className: "h-3.5 w-3.5 self-center text-muted-foreground", "aria-hidden": true })) : (React.createElement(ChevronDown, { className: "h-3.5 w-3.5 self-center text-muted-foreground", "aria-hidden": true })),
                React.createElement("span", null, "Recent Activity"),
                errorCount > 0 && (React.createElement("span", { className: cn("ml-1 rounded-full px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wider", TONE_CLASSES.destructive.bgSubtle, TONE_CLASSES.destructive.text), "aria-label": `${errorCount} recent error${errorCount === 1 ? "" : "s"}` },
                    errorCount,
                    " err")),
                auditFailureCount > 0 && (React.createElement("span", { className: cn("ml-1 rounded-full px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wider", TONE_CLASSES.warning.bgSubtle, TONE_CLASSES.warning.text), "aria-label": `${auditFailureCount} recent audit failure${auditFailureCount === 1 ? "" : "s"}` },
                    auditFailureCount,
                    " audit fail"))),
            (recentLogs.length > 0 || recentAudit.length > 0) && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, recentAudit.length > 0
                ? `Last ${recentAudit.length} audit · ${recentLogs.length} agent`
                : `Last ${recentLogs.length} event${recentLogs.length === 1 ? "" : "s"}`))),
        !collapsed && (React.createElement("div", { id: "recent-activity-body", className: "flex flex-col gap-3" },
            recentAudit.length > 0 && (React.createElement("div", null,
                React.createElement("p", { className: "m-0 mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Audit trail"),
                React.createElement("ul", { className: "m-0 flex list-none flex-col gap-0.5 p-0" }, recentAudit.map((e) => (React.createElement("li", { key: e.id },
                    React.createElement("button", { type: "button", onClick: () => onOpenAuditAction(e.action), className: cn("flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", e.status === "failure" && "text-destructive"), "aria-label": `Open audit log filtered to ${e.action}` },
                        React.createElement("span", { className: "min-w-[60px] font-mono text-2xs text-muted-foreground/70 tabular-nums" }, formatLogTime(e.timestamp)),
                        React.createElement(StatusBadge, { status: e.status === "failure" ? "error" : "success" }),
                        React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" }, e.action),
                        React.createElement("span", { className: cn("flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs", e.status === "failure"
                                ? "text-destructive"
                                : "text-foreground/80") }, e.target),
                        React.createElement(ChevronRight, { className: "h-3 w-3 shrink-0 text-muted-foreground/50", "aria-hidden": true })))))))),
            recentLogs.length === 0 && recentAudit.length === 0 ? (React.createElement("p", { className: "m-0 text-xs text-muted-foreground" }, "No activity yet. Trigger a refresh to begin populating events.")) : recentLogs.length > 0 ? (React.createElement("div", null,
                React.createElement("p", { className: "m-0 mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Agent log"),
                React.createElement(HoverList, { items: recentLogs, getKey: (log, i) => `${log.timestamp}-${i}`, tone: "primary", className: "gap-1.5", renderItem: (log) => (React.createElement("div", { className: "flex items-baseline gap-2 text-xs" },
                        React.createElement("span", { className: "min-w-[60px] font-mono text-2xs text-muted-foreground/70 tabular-nums" }, formatLogTime(log.timestamp)),
                        React.createElement(StatusBadge, { status: log.level }),
                        React.createElement("span", { className: "text-xs text-muted-foreground" },
                            "[",
                            log.agent,
                            "]"),
                        React.createElement("span", { className: cn("flex-1 overflow-hidden text-ellipsis whitespace-nowrap", log.level === "error"
                                ? "text-destructive"
                                : "text-foreground/80") }, log.message))) }))) : null))));
};
// ---------------------------------------------------------------------------
// Quick Actions
// ---------------------------------------------------------------------------
const QuickActions = ({ store, onNavigate }) => {
    const state = useMultiRegionState();
    const failedAccounts = state.accounts.filter((a) => a.provisioningState === "failed").length;
    const failedPools = state.pools.filter((p) => p.provisioningState === "failed").length;
    const totalFailed = failedAccounts + failedPools;
    const [retryConfirm, setRetryConfirm] = React.useState(false);
    const handleRetryFailed = React.useCallback(() => {
        if (failedAccounts > 0)
            store.retryFailedAccounts();
        if (failedPools > 0)
            store.retryFailedPools();
        store.addNotification({
            type: "info",
            message: `Reset ${totalFailed} failed item${totalFailed === 1 ? "" : "s"} to pending`,
        });
        setRetryConfirm(false);
    }, [failedAccounts, failedPools, totalFailed, store]);
    const handleExportSession = React.useCallback(() => {
        try {
            const json = store.exportSessionAsJson();
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            // Append today's date stamp so multiple exports stay distinguishable.
            const iso = new Date().toISOString().slice(0, 10);
            a.download = `${store.sessionId}-${iso}.json`;
            // Append to DOM before click — Firefox refuses to honour `.click()`
            // on a detached element. Strip immediately after so we don't leak
            // hidden anchors into the document tree.
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            store.addNotification({
                type: "success",
                message: "Session exported",
            });
        }
        catch (e) {
            store.addNotification({
                type: "error",
                message: `Export failed: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }, [store]);
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            totalFailed > 0 && (React.createElement(Button, { variant: "outline", onClick: () => setRetryConfirm(true), className: "border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive", "aria-label": `Retry ${totalFailed} failed items` },
                React.createElement(RefreshCw, { className: "h-3.5 w-3.5" }),
                "Retry ",
                totalFailed,
                " Failed")),
            React.createElement(Button, { variant: "outline", onClick: handleExportSession, "aria-label": "Export session as JSON" },
                React.createElement(Download, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Export Session"),
            React.createElement(Button, { variant: "outline", onClick: () => onNavigate("gpu-calculator"), "aria-label": "Open the GPU Calculator" },
                React.createElement(HardDrive, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "GPU Calculator"),
            React.createElement(Button, { variant: "outline", onClick: () => onNavigate("monitoring"), "aria-label": "Open the Monitoring page" },
                React.createElement(Server, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Open Monitoring"),
            React.createElement("span", { className: "flex items-center gap-1 text-2xs text-muted-foreground" },
                "Session",
                React.createElement("span", { className: "font-mono text-2xs text-foreground/80" }, store.sessionId),
                React.createElement(CopyButton, { value: store.sessionId, alwaysVisible: true, iconSize: 11, ariaLabel: "Copy session id" }))),
        React.createElement(ConfirmationDialog, { hidden: !retryConfirm, title: `Retry ${totalFailed} failed item${totalFailed === 1 ? "" : "s"}?`, message: React.createElement("div", { className: "flex flex-col gap-2 text-sm" },
                React.createElement("p", { className: "m-0" },
                    "This resets the provisioning state of failed items back to",
                    " ",
                    React.createElement("span", { className: "font-mono text-2xs" }, "pending"),
                    " so the next auto-recovery sweep (or a manual re-run) will pick them up."),
                React.createElement("ul", { className: "m-0 list-disc pl-5 text-xs" },
                    failedAccounts > 0 && (React.createElement("li", null,
                        failedAccounts,
                        " failed account",
                        failedAccounts === 1 ? "" : "s")),
                    failedPools > 0 && (React.createElement("li", null,
                        failedPools,
                        " failed pool",
                        failedPools === 1 ? "" : "s")))), confirmText: "Reset to pending", cancelText: "Cancel", onConfirm: handleRetryFailed, onCancel: () => setRetryConfirm(false) })));
};
const UnusedQuotaSection = ({ orchestrator, 
// `store` is retained on the props bag for backward compat with the
// caller's wiring; all write-through happens via the `auditLog` singleton
// (which is bound to the store at app boot), so the prop is unused here.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
store: _store, searchQuery, onSearchQueryChange, searchInputRef, }) => {
    const state = useMultiRegionState();
    const [detecting, setDetecting] = React.useState(false);
    const [creating, setCreating] = React.useState(false);
    const [suggestions, setSuggestions] = React.useState([]);
    const [selectedIds, setSelectedIds] = React.useState(new Set());
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    // Surface the most-recent error inline so the operator isn't left
    // wondering "did detect actually run?" when an exception is swallowed by
    // the orchestrator notification path. Cleared on the next successful run.
    const [detectError, setDetectError] = React.useState(null);
    const [createError, setCreateError] = React.useState(null);
    // Partial-success / rollback report — pinned above the table after every
    // auto-create attempt. The orchestrator returns
    // `status: "completed"|"partial"|"failed"` and a summary with per-row
    // counts; we render that as a colour-coded banner with explicit guidance
    // when failures occurred (manual review since the orchestrator does not
    // currently roll back successfully-created pools — see COORDINATOR note).
    const [outcome, setOutcome] = React.useState(null);
    // Track unmount so we don't update state from a stale async path.
    const aliveRef = React.useRef(true);
    // Per-action AbortControllers so a rapid re-click cancels the in-flight
    // request rather than racing it. The `creating` / `detecting` flags also
    // gate the UI, but a controller is the only way to actually stop work
    // mid-flight if the user navigates away.
    const detectAbortRef = React.useRef(null);
    const createAbortRef = React.useRef(null);
    React.useEffect(() => () => {
        var _a, _b;
        aliveRef.current = false;
        // Cancel any in-flight orchestrator calls on unmount — without this,
        // a user navigating away mid-detect would still trigger the
        // "setState on unmounted component" warning AND keep the agent
        // worker busy until the underlying ARM call finally returns.
        (_a = detectAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        (_b = createAbortRef.current) === null || _b === void 0 ? void 0 : _b.abort();
    }, []);
    const accountsWithFreeQuota = React.useMemo(() => state.accountInfos.filter((a) => a.lowPriorityCoresFree > 0 || a.dedicatedCoresFree > 0), [state.accountInfos]);
    const totalFreeLpCores = React.useMemo(() => accountsWithFreeQuota.reduce((s, a) => s + a.lowPriorityCoresFree, 0), [accountsWithFreeQuota]);
    const rows = React.useMemo(() => suggestions.map((s, index) => (Object.assign(Object.assign({}, s), { index, rowId: `${s.accountId}-${s.vmSize}-${index}` }))), [suggestions]);
    const filteredRows = React.useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q)
            return rows;
        return rows.filter((r) => {
            return (r.accountName.toLowerCase().includes(q) ||
                r.region.toLowerCase().includes(q) ||
                r.vmSize.toLowerCase().includes(q));
        });
    }, [rows, searchQuery]);
    // Whenever the filter narrows the visible set, prune selections to
    // visible rows only so "Auto-Create N" never silently provisions a row
    // the user can't see.
    const visibleIds = React.useMemo(() => new Set(filteredRows.map((r) => r.rowId)), [filteredRows]);
    const effectiveSelection = React.useMemo(() => {
        const next = new Set();
        for (const id of selectedIds) {
            if (visibleIds.has(id))
                next.add(id);
        }
        return next;
    }, [selectedIds, visibleIds]);
    const handleDetect = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b, _c;
        // Re-entry guard — the button is also `disabled` while detecting, but
        // a keyboard or programmatic invoker could still slip through.
        if (detecting)
            return;
        // Cancel any prior in-flight detect (rapid re-click). The agent honours
        // the signal threaded through `params.signal`.
        (_a = detectAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        const controller = new AbortController();
        detectAbortRef.current = controller;
        setDetecting(true);
        setSuggestions([]);
        setSelectedIds(new Set());
        setDetectError(null);
        // Clearing the prior outcome on a fresh detect — the suggestions about
        // to land may not match the previous run.
        setOutcome(null);
        // COORDINATOR: services/audit-log singleton bridges to store via
        // `bindAuditLogToStore`, so a single `auditLog.record` writes through
        // to `state.auditEntries`. We use the singleton here (canonical path)
        // and skip the direct `store.addAuditEntry` duplicate.
        const target = `${state.accountInfos.length} accounts`;
        try {
            const result = yield orchestrator.execute({
                action: "detect_unused_quota",
                payload: {},
                signal: controller.signal,
            });
            if (!aliveRef.current || controller.signal.aborted)
                return;
            const items = (_b = result.summary) === null || _b === void 0 ? void 0 : _b.suggestions;
            setSuggestions(items !== null && items !== void 0 ? items : []);
            auditLog.record({
                actor: "overview-page",
                action: "detect_unused_quota",
                target,
                status: "success",
                details: { suggestionCount: (_c = items === null || items === void 0 ? void 0 : items.length) !== null && _c !== void 0 ? _c : 0 },
            });
        }
        catch (e) {
            if (!aliveRef.current || controller.signal.aborted)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setDetectError(msg);
            auditLog.record({
                actor: "overview-page",
                action: "detect_unused_quota",
                target,
                status: "failure",
                error: msg,
            });
        }
        finally {
            if (aliveRef.current && detectAbortRef.current === controller) {
                setDetecting(false);
                detectAbortRef.current = null;
            }
        }
    }), [detecting, orchestrator, state.accountInfos.length]);
    const performAutoCreate = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _d, _e;
        // Hard re-entry guard — closing-and-reopening the confirm dialog while
        // a prior run is still in flight would otherwise double-submit. The
        // primary button has `disabled={... || creating}` but the dialog's
        // own confirm button passes through.
        if (creating)
            return;
        const selected = filteredRows.filter((r) => effectiveSelection.has(r.rowId));
        if (selected.length === 0)
            return;
        // Cancel any prior in-flight auto-create. In practice gated by `creating`
        // but defensive against accidental double-dispatch (e.g. via debugger).
        (_d = createAbortRef.current) === null || _d === void 0 ? void 0 : _d.abort();
        const controller = new AbortController();
        createAbortRef.current = controller;
        setCreating(true);
        setCreateError(null);
        const distinctRegions = Array.from(new Set(selected.map((s) => s.region)));
        const startTarget = `${selected.length} pools across ${distinctRegions.length} regions`;
        // COORDINATOR: write the destructive-action audit *before* the agent
        // dispatch so even a hung orchestrator leaves a paper-trail. The
        // singleton bridges to `state.auditEntries`.
        auditLog.record({
            actor: "overview-page",
            action: "auto_create_pools_from_quota:start",
            target: startTarget,
            status: "success",
            details: {
                poolCount: selected.length,
                regions: distinctRegions,
            },
        });
        try {
            // Strip row-only fields before handing the payload to the orchestrator.
            const payload = selected.map((r) => ({
                accountId: r.accountId,
                accountName: r.accountName,
                region: r.region,
                freeLpCores: r.freeLpCores,
                freeDedicatedCores: r.freeDedicatedCores,
                vmSize: r.vmSize,
                vmSizeVCpus: r.vmSizeVCpus,
                maxLpNodes: r.maxLpNodes,
                maxDedicatedNodes: r.maxDedicatedNodes,
            }));
            const result = yield orchestrator.execute({
                action: "auto_create_pools_from_quota",
                payload: { suggestions: payload },
                signal: controller.signal,
            });
            if (!aliveRef.current || controller.signal.aborted)
                return;
            // Surface the orchestrator's structured summary so partial-success
            // is unambiguous. The agent returns
            // `summary: { created, failed, total }` and `status` in
            // {"completed","partial","failed"} — fall back to derived counts if
            // the shape ever drifts.
            const summary = ((_e = result.summary) !== null && _e !== void 0 ? _e : {});
            const created = Number(summary.created) || 0;
            const failed = Number(summary.failed) || 0;
            const total = Number(summary.total) || selected.length;
            const status = result.status === "partial" ||
                result.status === "failed" ||
                result.status === "completed"
                ? result.status
                : failed === 0
                    ? "completed"
                    : created === 0
                        ? "failed"
                        : "partial";
            setOutcome({
                status,
                created,
                failed,
                total,
                regions: distinctRegions,
                finishedAt: new Date().toISOString(),
            });
            // Selection no longer makes sense once provisioning kicked off.
            setSelectedIds(new Set());
            auditLog.record({
                actor: "overview-page",
                action: "auto_create_pools_from_quota",
                target: `${created}/${total} pools created across ${distinctRegions.length} regions`,
                status: status === "failed" ? "failure" : "success",
                details: {
                    orchestratorStatus: status,
                    created,
                    failed,
                    total,
                    regions: distinctRegions,
                },
            });
        }
        catch (e) {
            if (!aliveRef.current || controller.signal.aborted)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setCreateError(msg);
            setOutcome({
                status: "failed",
                created: 0,
                failed: selected.length,
                total: selected.length,
                regions: distinctRegions,
                finishedAt: new Date().toISOString(),
            });
            auditLog.record({
                actor: "overview-page",
                action: "auto_create_pools_from_quota",
                target: `${selected.length} pools`,
                status: "failure",
                error: msg,
            });
        }
        finally {
            if (aliveRef.current && createAbortRef.current === controller) {
                setCreating(false);
                createAbortRef.current = null;
            }
        }
    }), [creating, orchestrator, filteredRows, effectiveSelection]);
    const handleAutoCreateConfirmed = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        setConfirmOpen(false);
        yield performAutoCreate();
    }), [performAutoCreate]);
    // Bulk-selection helpers — useful when the filtered set is small or the
    // operator wants "every region with > 0 max LP nodes" in one click.
    const selectAllVisible = React.useCallback(() => {
        const next = new Set(selectedIds);
        for (const r of filteredRows)
            next.add(r.rowId);
        setSelectedIds(next);
    }, [filteredRows, selectedIds]);
    const selectViableOnly = React.useCallback(() => {
        // "Viable" = at least one max-node bucket has a positive value, i.e.
        // the suggested VM size would actually fit at least one node.
        const next = new Set(selectedIds);
        for (const r of filteredRows) {
            if (r.maxLpNodes > 0 || r.maxDedicatedNodes > 0)
                next.add(r.rowId);
        }
        setSelectedIds(next);
    }, [filteredRows, selectedIds]);
    const clearSelection = React.useCallback(() => {
        setSelectedIds(new Set());
    }, []);
    const columns = React.useMemo(() => [
        {
            id: "accountName",
            header: "Account",
            cell: (r) => React.createElement("span", { className: "text-foreground" }, r.accountName),
            sort: (a, b) => a.accountName.localeCompare(b.accountName),
            csv: (r) => r.accountName,
        },
        {
            id: "region",
            header: "Region",
            cell: (r) => React.createElement("span", { className: "text-muted-foreground" }, r.region),
            sort: (a, b) => a.region.localeCompare(b.region),
            csv: (r) => r.region,
        },
        {
            id: "freeLpCores",
            header: "Free LP",
            className: "text-right",
            cell: (r) => (React.createElement("span", { className: cn("font-medium tabular-nums", TONE_CLASSES.primary.text) }, formatNumber(r.freeLpCores))),
            sort: (a, b) => a.freeLpCores - b.freeLpCores,
            csv: (r) => r.freeLpCores,
        },
        {
            id: "freeDedicatedCores",
            header: "Free Dedicated",
            className: "text-right",
            cell: (r) => (React.createElement("span", { className: cn("font-medium tabular-nums", TONE_CLASSES.info.text) }, formatNumber(r.freeDedicatedCores))),
            sort: (a, b) => a.freeDedicatedCores - b.freeDedicatedCores,
            csv: (r) => r.freeDedicatedCores,
        },
        {
            id: "vmSize",
            header: "VM Size",
            cell: (r) => (React.createElement("span", { className: "font-mono text-xs text-foreground" }, r.vmSize)),
            sort: (a, b) => a.vmSize.localeCompare(b.vmSize),
            csv: (r) => r.vmSize,
        },
        {
            id: "maxLpNodes",
            header: "Max LP Nodes",
            className: "text-right",
            cell: (r) => (React.createElement("span", { className: cn("tabular-nums", r.maxLpNodes > 0
                    ? TONE_CLASSES.success.text
                    : "text-muted-foreground/60") }, formatNumber(r.maxLpNodes))),
            sort: (a, b) => a.maxLpNodes - b.maxLpNodes,
            csv: (r) => r.maxLpNodes,
        },
        {
            id: "maxDedicatedNodes",
            header: "Max Dedicated Nodes",
            className: "text-right",
            cell: (r) => (React.createElement("span", { className: cn("tabular-nums", r.maxDedicatedNodes > 0
                    ? TONE_CLASSES.success.text
                    : "text-muted-foreground/60") }, formatNumber(r.maxDedicatedNodes))),
            sort: (a, b) => a.maxDedicatedNodes - b.maxDedicatedNodes,
            csv: (r) => r.maxDedicatedNodes,
        },
    ], []);
    const piggyBankClasses = TONE_CLASSES.warning;
    const detectDisabled = detecting || state.accountInfos.length === 0;
    const detectButton = (React.createElement(Button, { variant: "outline", onClick: handleDetect, disabled: detectDisabled, className: "ml-auto", "aria-label": "Detect unused quota" },
        React.createElement(Search, { className: "h-3.5 w-3.5" }),
        rows.length > 0 ? "Re-detect" : "Detect Unused Quota"));
    const detectDisabledReason = detecting
        ? "Detection already in progress."
        : state.accountInfos.length === 0
            ? "Refresh account info first to detect unused quota."
            : null;
    const viableCount = React.useMemo(() => filteredRows.filter((r) => r.maxLpNodes > 0 || r.maxDedicatedNodes > 0).length, [filteredRows]);
    // The ExportMenu wants a column descriptor with explicit accessors —
    // mirror the DataTable's CSV columns so the file content matches what
    // the operator sees in the UI.
    const exportColumns = React.useMemo(() => [
        { header: "Account", accessor: (r) => r.accountName },
        { header: "Region", accessor: (r) => r.region },
        { header: "Free LP", accessor: (r) => r.freeLpCores },
        {
            header: "Free Dedicated",
            accessor: (r) => r.freeDedicatedCores,
        },
        { header: "VM Size", accessor: (r) => r.vmSize },
        {
            header: "vCPUs per VM",
            accessor: (r) => r.vmSizeVCpus,
        },
        {
            header: "Max LP Nodes",
            accessor: (r) => r.maxLpNodes,
        },
        {
            header: "Max Dedicated Nodes",
            accessor: (r) => r.maxDedicatedNodes,
        },
    ], []);
    return (React.createElement(Card, { className: "p-4" },
        React.createElement("div", { className: "mb-3 flex flex-wrap items-center gap-3" },
            React.createElement("span", { className: cn("flex h-8 w-8 items-center justify-center rounded-md", piggyBankClasses.bgSubtle) },
                React.createElement(PiggyBank, { className: cn("h-4 w-4", piggyBankClasses.text) })),
            React.createElement("h2", { className: "m-0 text-base font-semibold text-foreground" }, "Unused Quota"),
            React.createElement(InfoTooltip, { content: "Detects accounts with free LP / Dedicated cores and suggests VM sizes that would fit. Use Auto-Create to provision pools in bulk via the orchestrator.", ariaLabel: "What is unused quota detection?", size: 13 }),
            state.accountInfos.length > 0 && (React.createElement("span", { className: "text-xs text-muted-foreground" },
                accountsWithFreeQuota.length,
                " account",
                accountsWithFreeQuota.length === 1 ? "" : "s",
                " with",
                " ",
                formatNumber(totalFreeLpCores),
                " free LP cores")),
            detectDisabledReason ? (React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement("span", { className: "ml-auto" }, detectButton)),
                React.createElement(TooltipContent, { side: "top" }, detectDisabledReason))) : (detectButton),
            detecting && (React.createElement(Loader2, { className: "h-4 w-4 animate-spin text-muted-foreground", "aria-label": "Detecting unused quota" }))),
        (detectError || createError) && (React.createElement("div", { role: "alert", className: cn("mb-3 flex items-start gap-2 rounded-md border p-2 text-2xs", TONE_CLASSES.destructive.border, TONE_CLASSES.destructive.bgSubtle, TONE_CLASSES.destructive.text) },
            React.createElement(AlertCircle, { className: "h-3.5 w-3.5 shrink-0", "aria-hidden": true }),
            React.createElement("span", { className: "flex-1" }, detectError !== null && detectError !== void 0 ? detectError : createError),
            React.createElement("button", { type: "button", onClick: () => {
                    setDetectError(null);
                    setCreateError(null);
                }, className: "rounded p-0.5 hover:bg-destructive/20", "aria-label": "Dismiss error" },
                React.createElement(X, { className: "h-3 w-3", "aria-hidden": true })))),
        outcome && (React.createElement("div", { role: "status", "aria-live": "polite", className: cn("mb-3 flex flex-col gap-1.5 rounded-md border p-2.5 text-xs", outcome.status === "completed"
                ? cn(TONE_CLASSES.success.border, TONE_CLASSES.success.bgSubtle)
                : outcome.status === "partial"
                    ? cn(TONE_CLASSES.warning.border, TONE_CLASSES.warning.bgSubtle)
                    : cn(TONE_CLASSES.destructive.border, TONE_CLASSES.destructive.bgSubtle)) },
            React.createElement("div", { className: "flex items-start gap-2" },
                outcome.status === "completed" ? (React.createElement(CheckCircle2, { className: cn("h-3.5 w-3.5 shrink-0", TONE_CLASSES.success.text), "aria-hidden": true })) : (React.createElement(AlertCircle, { className: cn("h-3.5 w-3.5 shrink-0", outcome.status === "partial"
                        ? TONE_CLASSES.warning.text
                        : TONE_CLASSES.destructive.text), "aria-hidden": true })),
                React.createElement("span", { className: "flex-1" },
                    React.createElement("span", { className: cn("font-semibold", outcome.status === "completed"
                            ? TONE_CLASSES.success.text
                            : outcome.status === "partial"
                                ? TONE_CLASSES.warning.text
                                : TONE_CLASSES.destructive.text) }, outcome.status === "completed"
                        ? "Auto-create complete"
                        : outcome.status === "partial"
                            ? "Auto-create partially succeeded"
                            : "Auto-create failed"),
                    " ",
                    React.createElement("span", { className: "text-muted-foreground" },
                        outcome.created,
                        "/",
                        outcome.total,
                        " pool",
                        outcome.total === 1 ? "" : "s",
                        " created",
                        outcome.failed > 0 && (React.createElement(React.Fragment, null,
                            " ",
                            "(",
                            React.createElement("span", { className: TONE_CLASSES.destructive.text },
                                outcome.failed,
                                " failed"),
                            ")")),
                        " ",
                        "across ",
                        outcome.regions.length,
                        " region",
                        outcome.regions.length === 1 ? "" : "s")),
                React.createElement("button", { type: "button", onClick: () => setOutcome(null), className: "rounded p-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Dismiss auto-create report" },
                    React.createElement(X, { className: "h-3 w-3", "aria-hidden": true }))),
            outcome.status === "partial" && (React.createElement("p", { className: "m-0 pl-5 text-2xs text-muted-foreground" },
                "The ",
                outcome.created,
                " pool",
                outcome.created === 1 ? "" : "s",
                " that succeeded are live and consuming quota. Review the agent log for the failure reasons before retrying \u2014 repeated runs will auto-skip regions whose VM SKU has been blacklisted.")),
            outcome.status === "failed" && outcome.created === 0 && (React.createElement("p", { className: "m-0 pl-5 text-2xs text-muted-foreground" }, "No pools were created \u2014 common causes: ARM permissions, VM SKU unavailable in region, or upstream quota race. Re-detect and try again, or open the activity log for per-row error detail.")))),
        rows.length > 0 && (React.createElement("div", { className: "flex flex-col gap-3" },
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                React.createElement("div", { className: "relative flex-1 sm:max-w-[280px]" },
                    React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                    React.createElement(Input, { ref: searchInputRef, type: "search", placeholder: "Filter by account, region, VM size...", value: searchQuery, onChange: (e) => onSearchQueryChange(e.target.value), "aria-label": "Filter unused-quota suggestions", className: "h-8 pl-7 pr-7" }),
                    searchQuery && (React.createElement("button", { type: "button", onClick: () => onSearchQueryChange(""), "aria-label": "Clear quota search", className: "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" },
                        React.createElement(X, { className: "h-3 w-3", "aria-hidden": true })))),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: selectAllVisible, disabled: filteredRows.length === 0, "aria-label": "Select all visible rows" },
                    "Select all (",
                    filteredRows.length,
                    ")"),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: selectViableOnly, disabled: viableCount === 0, "aria-label": "Select only rows with viable node counts" },
                    "Select viable (",
                    viableCount,
                    ")"),
                effectiveSelection.size > 0 && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: clearSelection, "aria-label": "Clear selection" },
                    React.createElement(X, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    "Clear")),
                React.createElement(ExportMenu, { rows: filteredRows, columns: exportColumns, filename: "overview-quota-suggestions", jsonMetadata: {
                        source: "overview-page",
                        searchQuery,
                        totalSuggestions: rows.length,
                    } })),
            searchQuery && (React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
                "Showing ",
                filteredRows.length,
                " of ",
                rows.length,
                " suggestion",
                rows.length === 1 ? "" : "s",
                " matching",
                " ",
                React.createElement("span", { className: "font-mono" },
                    "\"",
                    searchQuery,
                    "\""))),
            React.createElement(DataTable, { tableId: "overview-quota-suggestions", rows: filteredRows, columns: columns, rowKey: (r) => r.rowId, selection: selectedIds, onSelectionChange: setSelectedIds, initialSort: { column: "freeLpCores", direction: "desc" }, csvFileName: "overview-quota-suggestions.csv" }),
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                (() => {
                    const autoCreateButton = (React.createElement(Button, { variant: "default", onClick: () => setConfirmOpen(true), disabled: effectiveSelection.size === 0 || creating, "aria-label": `Auto-create ${effectiveSelection.size} pools` },
                        React.createElement(Plus, { className: "h-3.5 w-3.5" }),
                        "Auto-Create Pools (",
                        effectiveSelection.size,
                        ")"));
                    const reason = creating
                        ? "Pool creation in progress."
                        : effectiveSelection.size === 0
                            ? "Select one or more visible rows to auto-create pools."
                            : null;
                    return reason ? (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", null, autoCreateButton)),
                        React.createElement(TooltipContent, { side: "top" }, reason))) : (autoCreateButton);
                })(),
                creating && (React.createElement(Loader2, { className: "h-4 w-4 animate-spin text-muted-foreground", "aria-label": "Creating pools" })),
                React.createElement("span", { className: "text-xs text-muted-foreground" },
                    effectiveSelection.size,
                    " of ",
                    filteredRows.length,
                    " visible selected",
                    selectedIds.size > effectiveSelection.size && (React.createElement(React.Fragment, null,
                        " ",
                        React.createElement("span", { className: "text-muted-foreground/70" },
                            "(",
                            selectedIds.size - effectiveSelection.size,
                            " hidden by filter)"))))))),
        detecting && rows.length === 0 && (React.createElement(SkeletonLoader, { variant: "table", rows: 4, columns: 5 })),
        rows.length === 0 &&
            !detecting &&
            state.accountInfos.length > 0 && (React.createElement(EmptyState, { icon: Search, title: "No suggestions yet", description: "Click Detect Unused Quota to find accounts with available cores for new GPU pools.", action: {
                label: "Detect Unused Quota",
                icon: Search,
                onClick: handleDetect,
                loading: detecting,
            } })),
        state.accountInfos.length === 0 && !detecting && (React.createElement(EmptyState, { icon: PiggyBank, title: "No account info loaded", description: "Refresh account info first to detect unused quota for new pools." })),
        React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: "Auto-create pools?", message: React.createElement("div", { className: "flex flex-col gap-2 text-sm" },
                React.createElement("p", { className: "m-0" },
                    "Create ",
                    effectiveSelection.size,
                    " pool",
                    effectiveSelection.size === 1 ? "" : "s",
                    " using the suggested VM sizes and free quota? Pools will be provisioned via the orchestrator."),
                React.createElement("ul", { className: "m-0 list-disc pl-5 text-xs text-muted-foreground" },
                    React.createElement("li", null,
                        new Set(filteredRows
                            .filter((r) => effectiveSelection.has(r.rowId))
                            .map((r) => r.region)).size,
                        " ",
                        "distinct region",
                        new Set(filteredRows
                            .filter((r) => effectiveSelection.has(r.rowId))
                            .map((r) => r.region)).size === 1
                            ? ""
                            : "s"),
                    React.createElement("li", null,
                        formatNumber(filteredRows
                            .filter((r) => effectiveSelection.has(r.rowId))
                            .reduce((s, r) => s + r.maxLpNodes, 0)),
                        " ",
                        "low-priority nodes total"),
                    React.createElement("li", null,
                        formatNumber(filteredRows
                            .filter((r) => effectiveSelection.has(r.rowId))
                            .reduce((s, r) => s + r.maxDedicatedNodes, 0)),
                        " ",
                        "dedicated nodes total"))), confirmText: "Auto-create", cancelText: "Cancel", loading: creating, onConfirm: handleAutoCreateConfirmed, onCancel: () => setConfirmOpen(false) })));
};
const DEFENDER_SIGNALS = [
    {
        key: "set_domain_authentication",
        label: "Federated domain change",
        rank: 1,
        match: ["set_domain_authentication", "federated_domain", "set domain"],
    },
    {
        key: "update_ca_policy",
        label: "Conditional access policy change",
        rank: 2,
        match: [
            "update_conditional_access",
            "ca_policy",
            "conditional_access_policy",
            "update conditional access",
        ],
    },
    {
        key: "issue_tap",
        label: "Temporary access pass issued",
        rank: 3,
        match: ["issue_temporary_access", "temporary_access_pass", "issue tap"],
    },
    {
        key: "add_sp_app_role",
        label: "App role granted to service principal",
        rank: 4,
        match: [
            "add_app_role_assignment",
            "app_role_assignment_to_service_principal",
            "grant_app_role",
        ],
    },
    {
        key: "add_app_secret",
        label: "App credential added (secret / cert)",
        rank: 5,
        match: [
            "add_application_password",
            "add_application_key",
            "addpassword",
            "addkey",
            "application_credential_added",
        ],
    },
    {
        key: "add_federated_credential",
        label: "Federated identity credential added",
        rank: 6,
        match: ["federatedidentitycredential", "federated_identity_credential"],
    },
    {
        key: "pim_eligibility",
        label: "PIM eligibility created",
        rank: 7,
        match: ["roleeligibilityschedule", "pim_eligibility", "pim_create"],
    },
    {
        key: "delete_diagnostic_setting",
        label: "Diagnostic setting deleted",
        rank: 8,
        match: ["delete_diagnostic_setting", "diagnostic_setting_delete"],
    },
    {
        key: "hard_delete_user",
        label: "User hard-deleted",
        rank: 9,
        match: ["hard_delete_user", "hard delete user", "permanently_delete_user"],
    },
    {
        key: "cancel_subscription",
        label: "Subscription cancelled",
        rank: 10,
        match: ["cancel_subscription", "subscription_cancel"],
    },
];
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
function matchesDefenderSignal(action, signal) {
    const lower = action.toLowerCase();
    return signal.match.some((needle) => lower.includes(needle));
}
/**
 * Compact card summarising defender posture against the 10 corpus events.
 * Rows with zero matches in the last 24h render in muted tone; non-zero
 * rows highlight via severity colour and become clickable.
 */
const DefenderPostureSummary = ({ entries, onOpenAuditLog, }) => {
    const rows = React.useMemo(() => {
        const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS;
        const recent = entries.filter((e) => {
            const t = Date.parse(e.timestamp);
            return Number.isFinite(t) && t >= cutoff;
        });
        return DEFENDER_SIGNALS.map((sig) => {
            let count = 0;
            let failures = 0;
            for (const e of recent) {
                if (matchesDefenderSignal(e.action, sig)) {
                    count += 1;
                    if (e.status === "failure")
                        failures += 1;
                }
            }
            return Object.assign(Object.assign({}, sig), { count, failures });
        });
    }, [entries]);
    const totalHits = rows.reduce((s, r) => s + r.count, 0);
    const topHits = rows.filter((r) => r.count > 0);
    const overallTone = totalHits === 0
        ? "success"
        : topHits.some((r) => r.rank <= 3)
            ? "destructive"
            : "warning";
    const toneClasses = TONE_CLASSES[overallTone];
    return (React.createElement(Card, { role: "region", "aria-labelledby": "defender-posture-heading", className: cn("border-l-4 bg-card p-4", toneClasses.borderTop.replace("border-t-", "border-l-")) },
        React.createElement("div", { className: "mb-3 flex flex-wrap items-baseline justify-between gap-2" },
            React.createElement("div", { className: "flex items-baseline gap-2" },
                React.createElement("h2", { id: "defender-posture-heading", className: "m-0 flex items-baseline gap-1.5 text-base font-semibold text-foreground" },
                    React.createElement(ShieldAlert, { className: cn("h-3.5 w-3.5 self-center", toneClasses.text), "aria-hidden": true }),
                    "Today's Defender Signals"),
                React.createElement(InfoTooltip, { content: "Counts last-24h audit entries against the 10 highest-priority operator events from the offensive-tooling research corpus (New folder/_AZURE_BYPASS_PLAYBOOK.md \u00A7Critical Defender Audit Surface). Click a non-zero row to open the audit log filtered to that action.", ariaLabel: "What are defender signals?", size: 12 }),
                React.createElement("span", { className: cn("rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider", toneClasses.bgSubtle, toneClasses.text), "aria-label": `${totalHits} signals in the last 24 hours` }, totalHits === 0 ? "Quiet" : `${totalHits} hit${totalHits === 1 ? "" : "s"}`)),
            React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Last 24h \u00B7 ranked by corpus severity")),
        totalHits === 0 ? (React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" }, "No corpus-matched audit events in the last 24h. This is the truthful answer when no operator actions of interest have fired \u2014 source-of-truth lives in `state.auditEntries`.")) : (React.createElement("ul", { className: "m-0 grid list-none gap-1 p-0 sm:grid-cols-2", "aria-label": "Defender signal counts" }, rows
            .slice()
            .sort((a, b) => b.count - a.count || a.rank - b.rank)
            .map((row) => {
            const active = row.count > 0;
            const tone = row.failures > 0
                ? "destructive"
                : row.rank <= 3
                    ? "warning"
                    : "info";
            const rowToneClasses = TONE_CLASSES[tone];
            return (React.createElement("li", { key: row.key },
                React.createElement("button", { type: "button", onClick: () => active && onOpenAuditLog(row.key), disabled: !active, className: cn("flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors duration-fast", active
                        ? cn(rowToneClasses.border, rowToneClasses.bgSubtle, "hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")
                        : "border-border/40 bg-card/30 text-muted-foreground/70 cursor-default"), "aria-label": active
                        ? `${row.count} ${row.label} event${row.count === 1 ? "" : "s"} — click to open audit log`
                        : `No ${row.label} events in the last 24h` },
                    React.createElement("span", { className: "flex items-center gap-1.5" },
                        React.createElement("span", { className: cn("inline-flex h-4 w-4 items-center justify-center rounded-full text-3xs font-bold tabular-nums", active
                                ? cn(rowToneClasses.bg, "text-white")
                                : "bg-muted text-muted-foreground/60"), "aria-hidden": true }, row.rank),
                        React.createElement("span", { className: cn("text-xs", active ? "text-foreground" : "text-muted-foreground/70") }, row.label)),
                    React.createElement("span", { className: "flex items-center gap-2 text-2xs tabular-nums" },
                        row.failures > 0 && (React.createElement("span", { className: TONE_CLASSES.destructive.text },
                            row.failures,
                            " fail")),
                        React.createElement("span", { className: cn("font-semibold", active ? rowToneClasses.text : "text-muted-foreground/50") }, row.count)))));
        })))));
};
const SuggestedActions = ({ suggestions, onNavigate, }) => {
    if (suggestions.length === 0)
        return null;
    return (React.createElement(Card, { role: "region", "aria-labelledby": "suggested-actions-heading", className: "border-l-4 border-l-primary/60 bg-card p-4" },
        React.createElement("div", { className: "mb-2 flex items-baseline gap-2" },
            React.createElement(ListChecks, { className: "h-3.5 w-3.5 self-center text-primary", "aria-hidden": true }),
            React.createElement("h2", { id: "suggested-actions-heading", className: "m-0 text-base font-semibold text-foreground" }, "Suggested Next Actions"),
            React.createElement("span", { className: "text-2xs text-muted-foreground" },
                suggestions.length,
                " suggestion",
                suggestions.length === 1 ? "" : "s",
                " from current state")),
        React.createElement("ul", { className: "m-0 flex list-none flex-col gap-1.5 p-0" }, suggestions.map((s) => {
            const tone = s.urgency === "high"
                ? "destructive"
                : s.urgency === "medium"
                    ? "warning"
                    : "primary";
            const tc = TONE_CLASSES[tone];
            return (React.createElement("li", { key: s.id },
                React.createElement("button", { type: "button", onClick: () => onNavigate(s.target), className: cn("flex w-full items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors duration-fast", tc.border, tc.bgSubtle, "hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"), "aria-label": `${s.label} — ${s.rationale}` },
                    React.createElement("span", { className: "flex flex-col gap-0.5" },
                        React.createElement("span", { className: cn("text-xs font-semibold", tc.text) }, s.label),
                        React.createElement("span", { className: "text-2xs text-muted-foreground" }, s.rationale)),
                    React.createElement(ChevronRight, { className: "h-3.5 w-3.5 shrink-0 self-center text-muted-foreground", "aria-hidden": true }))));
        }))));
};
// ---------------------------------------------------------------------------
// Widget visibility — operator-customizable dashboard sections
// ---------------------------------------------------------------------------
//
// Backing store: `usePersistedState` envelope (versioned). Defaults to all
// sections on; the customize popover lets the operator hide noisy panels
// (e.g. defender posture in a dev tenant, or the agent strip when only
// one agent is registered).
const WIDGET_KEYS = [
    "defender",
    "suggestions",
    "kpis",
    "quotaSummary",
    "clusterHealth",
    "regionHealth",
    "unusedQuota",
    "agents",
    "quickActions",
    "recentActivity",
];
const WIDGET_LABEL = {
    defender: "Defender signals",
    suggestions: "Suggested actions",
    kpis: "KPI cards",
    quotaSummary: "Per-account quota summary",
    clusterHealth: "Cluster health",
    regionHealth: "Region health",
    unusedQuota: "Unused quota",
    agents: "Agent status",
    quickActions: "Quick actions",
    recentActivity: "Recent activity",
};
const DEFAULT_WIDGET_VISIBILITY = WIDGET_KEYS.reduce((acc, k) => {
    acc[k] = true;
    return acc;
}, {});
const WidgetCustomizer = ({ visibility, onToggle, onResetAll, density, onDensityChange, }) => {
    const [open, setOpen] = React.useState(false);
    const hiddenCount = WIDGET_KEYS.filter((k) => !visibility[k]).length;
    return (React.createElement("div", { className: "relative" },
        React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setOpen((v) => !v), "aria-expanded": open, "aria-haspopup": "true", "aria-label": "Customize visible dashboard sections", className: "text-2xs" },
            React.createElement(Settings2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
            "Customize",
            hiddenCount > 0 && (React.createElement("span", { className: "ml-1 rounded-full bg-muted px-1.5 py-0 text-3xs font-semibold text-muted-foreground tabular-nums" },
                hiddenCount,
                " hidden"))),
        open && (React.createElement(React.Fragment, null,
            React.createElement("button", { type: "button", "aria-label": "Close customize panel", className: "fixed inset-0 z-30 cursor-default bg-transparent", onClick: () => setOpen(false) }),
            React.createElement("div", { role: "dialog", "aria-label": "Customize dashboard", className: "absolute right-0 top-full z-40 mt-1 w-64 rounded-md border bg-popover p-2 shadow-md" },
                React.createElement("p", { className: "m-0 mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Visible sections"),
                React.createElement("ul", { className: "m-0 flex list-none flex-col gap-0.5 p-0" }, WIDGET_KEYS.map((k) => (React.createElement("li", { key: k },
                    React.createElement("label", { className: "flex cursor-pointer items-center gap-2 rounded p-1 text-xs hover:bg-accent/40" },
                        React.createElement("input", { type: "checkbox", checked: visibility[k], onChange: () => onToggle(k), "aria-label": `Toggle ${WIDGET_LABEL[k]}`, className: "h-3.5 w-3.5 cursor-pointer accent-primary" }),
                        React.createElement("span", null, WIDGET_LABEL[k])))))),
                React.createElement("hr", { className: "my-2 border-border" }),
                React.createElement("p", { className: "m-0 mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Density"),
                React.createElement("div", { className: "flex gap-1" },
                    React.createElement(Button, { type: "button", variant: density === "comfortable" ? "default" : "outline", size: "sm", onClick: () => onDensityChange("comfortable"), className: "flex-1 text-2xs", "aria-pressed": density === "comfortable" },
                        React.createElement(Maximize2, { className: "h-3 w-3", "aria-hidden": true }),
                        "Comfortable"),
                    React.createElement(Button, { type: "button", variant: density === "compact" ? "default" : "outline", size: "sm", onClick: () => onDensityChange("compact"), className: "flex-1 text-2xs", "aria-pressed": density === "compact" },
                        React.createElement(Minimize2, { className: "h-3 w-3", "aria-hidden": true }),
                        "Compact")),
                React.createElement("hr", { className: "my-2 border-border" }),
                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: onResetAll, className: "w-full text-2xs text-muted-foreground" }, "Reset all"))))));
};
const OverviewPageInner = ({ orchestrator, store, onNavigate, }) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const stats = useDashboardStats();
    const state = useMultiRegionState();
    const navigate = useNavigate();
    // Path-based nav from context — the migration target. We keep the legacy
    // `onNavigate(PageKey)` prop accepted (route adapter still threads it
    // through) and adopt a single `navTo` helper internally so we can swap
    // call sites incrementally without touching the router.
    //
    // The hook's signature is `DashboardOutletContext` (non-null), but
    // react-router returns `null` when rendered outside an `<Outlet>` (tests,
    // standalone storybook). Treat it as potentially-undefined and fall back
    // to the legacy prop in that case.
    const outletContext = useDashboardOutletContext();
    const navigateToPage = outletContext === null || outletContext === void 0 ? void 0 : outletContext.navigateToPage;
    const navTo = React.useCallback((key) => {
        // Prefer the context helper (canonical path-based nav). Fall back to
        // the legacy prop for tests / call sites that render this page
        // outside the router shell.
        if (navigateToPage) {
            navigateToPage(key);
        }
        else {
            onNavigate(key);
        }
    }, [navigateToPage, onNavigate]);
    const [refreshing, setRefreshing] = React.useState(false);
    const [cardErrors, setCardErrors] = React.useState({});
    // Persisted "hide healthy regions" filter — survives reload because an
    // operator triaging an outage wants the noisy 95% healthy regions out of
    // the way until the incident is resolved. Versioned envelope so we can
    // evolve the shape without rehydration crashes.
    const [hideHealthyRegions, setHideHealthyRegions] = usePersistedState("overview.hideHealthyRegions", false, { version: 1 });
    // Persisted widget-visibility map — operator picks which sections appear
    // on this dashboard. Versioned: the migrate adds new keys (with default =
    // visible) as the WIDGET_KEYS list grows so a stored blob with fewer keys
    // doesn't blank out a freshly-added widget.
    const [widgetVisibility, setWidgetVisibility] = usePersistedState("overview.widgetVisibility", DEFAULT_WIDGET_VISIBILITY, {
        version: 1,
        migrate: (raw) => {
            if (!raw || typeof raw !== "object")
                return DEFAULT_WIDGET_VISIBILITY;
            const next = Object.assign({}, DEFAULT_WIDGET_VISIBILITY);
            for (const k of WIDGET_KEYS) {
                const v = raw[k];
                if (typeof v === "boolean")
                    next[k] = v;
            }
            return next;
        },
    });
    // Persisted compact/comfortable density toggle. Applied via a wrapper
    // class on the outermost div — section spacing tightens but per-row
    // semantics are unchanged.
    const [density, setDensity] = usePersistedState("overview.density", "comfortable", {
        version: 1,
        migrate: (raw) => raw === "compact" || raw === "comfortable"
            ? raw
            : "comfortable",
    });
    // ARIA-live announcement buffer — flipped on every successful auto-refresh
    // so AT users hear "Dashboard refreshed" without having to inspect every
    // KPI cell. Cleared after a tick so a repeat refresh re-fires.
    const [liveAnnouncement, setLiveAnnouncement] = React.useState("");
    const toggleWidget = React.useCallback((key) => {
        setWidgetVisibility((prev) => (Object.assign(Object.assign({}, prev), { [key]: !prev[key] })));
    }, [setWidgetVisibility]);
    const resetWidgets = React.useCallback(() => {
        setWidgetVisibility(DEFAULT_WIDGET_VISIBILITY);
        setDensity("comfortable");
    }, [setWidgetVisibility, setDensity]);
    // Single URL-state bag — collapsing every flag into one record keeps the
    // url-state hook's effect dependency stable and the URL ordering tidy.
    const [urlState, setUrlState] = useUrlState({
        range: "24h",
        regionSearch: "",
        regionStatus: "all",
        quotaSearch: "",
        activity: "on",
    });
    const rangeRaw = (_a = urlState.range) !== null && _a !== void 0 ? _a : "24h";
    const range = isRangeKey(rangeRaw)
        ? rangeRaw
        : "24h";
    const regionSearch = (_b = urlState.regionSearch) !== null && _b !== void 0 ? _b : "";
    const regionStatusRaw = (_c = urlState.regionStatus) !== null && _c !== void 0 ? _c : "all";
    const regionStatus = isRegionStatusFilter(regionStatusRaw)
        ? regionStatusRaw
        : "all";
    const quotaSearch = (_d = urlState.quotaSearch) !== null && _d !== void 0 ? _d : "";
    const activityCollapsed = urlState.activity === "off";
    // Track unmount so we don't update state from async refresh paths after
    // the component has gone away (fixes a "Can't perform a React state
    // update on an unmounted component" race during rapid nav).
    const aliveRef = React.useRef(true);
    React.useEffect(() => () => {
        aliveRef.current = false;
    }, []);
    // ARM-token expiry tracker for the primary signed-in account. The
    // operator may park on this dashboard with auto-refresh on for an
    // entire shift, and every drill-down KPI click (accounts / pools /
    // nodes) lands on an ARM-heavy page. Surface a TokenExpiryBadge near
    // the page header so they get a heads-up — and a one-click force-
    // refresh — before they click through. No local `armToken` state
    // here, so we skip the sync-bridge pattern other pages use.
    const primaryAccount = ((_e = state.azureAccounts) !== null && _e !== void 0 ? _e : [])[0];
    const armTokenTracker = useArmToken(primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.tenantId);
    const dedicatedUsed = React.useMemo(() => state.accountInfos.reduce((s, a) => s + a.dedicatedCoresUsed, 0), [state.accountInfos]);
    const dedicatedQuota = React.useMemo(() => state.accountInfos.reduce((s, a) => s + a.dedicatedCoreQuota, 0), [state.accountInfos]);
    const lpUsed = React.useMemo(() => state.accountInfos.reduce((s, a) => s + a.lowPriorityCoresUsed, 0), [state.accountInfos]);
    const lpQuota = React.useMemo(() => state.accountInfos.reduce((s, a) => s + a.lowPriorityCoreQuota, 0), [state.accountInfos]);
    const regionHealthRows = React.useMemo(() => {
        var _a;
        const accountById = new Map(state.accounts.map((a) => [a.id, a]));
        const map = new Map();
        for (const info of state.accountInfos) {
            const entry = (_a = map.get(info.region)) !== null && _a !== void 0 ? _a : { healthy: 0, total: 0 };
            entry.total += 1;
            const acct = accountById.get(info.id);
            const isHealthy = !acct || (acct.provisioningState !== "failed" && !acct.error);
            if (isHealthy)
                entry.healthy += 1;
            map.set(info.region, entry);
        }
        return Array.from(map.entries()).map(([name, v]) => ({
            name,
            healthy: v.healthy,
            total: v.total,
        }));
    }, [state.accountInfos, state.accounts]);
    // Per-account quota summary — counts accounts that have any free quota
    // available, alongside the per-account averages. Surfaces above the
    // cluster-health grid via `SummaryStatItem` so an operator can see
    // "30 of 42 accounts have spare LP cores" without scrolling to the
    // Unused Quota table.
    const accountQuotaSummary = React.useMemo(() => {
        const totalAccounts = state.accountInfos.length;
        let withFreeLp = 0;
        let withFreeDedicated = 0;
        let totalFreeLp = 0;
        let totalFreeDedicated = 0;
        for (const a of state.accountInfos) {
            if (a.lowPriorityCoresFree > 0) {
                withFreeLp += 1;
                totalFreeLp += a.lowPriorityCoresFree;
            }
            if (a.dedicatedCoresFree > 0) {
                withFreeDedicated += 1;
                totalFreeDedicated += a.dedicatedCoresFree;
            }
        }
        return {
            totalAccounts,
            withFreeLp,
            withFreeDedicated,
            totalFreeLp,
            totalFreeDedicated,
            avgFreeLpPerAccount: withFreeLp > 0 ? Math.round(totalFreeLp / withFreeLp) : 0,
        };
    }, [state.accountInfos]);
    // Hide-healthy filter — apply to the cluster-health grid AND the region-
    // health hover list. Healthy = healthy === total (every account in the
    // region is up). Empty regions (`total === 0`) are also considered
    // "uninteresting" and hidden when the filter is on.
    const visibleRegionHealthRows = React.useMemo(() => {
        if (!hideHealthyRegions)
            return regionHealthRows;
        return regionHealthRows.filter((r) => r.total === 0 || r.healthy !== r.total);
    }, [regionHealthRows, hideHealthyRegions]);
    // Sparkline data derived from the rolling history buffer. One series per
    // KPI card — kept in this single useMemo so the buffer is walked once
    // per re-render instead of five times. Guard against legacy session
    // blobs that pre-date the history field (`state.history` would be
    // undefined and `.map` would throw).
    const sparkSeries = React.useMemo(() => {
        var _a;
        const h = (_a = state.history) !== null && _a !== void 0 ? _a : [];
        return {
            accounts: h.map((s) => s.totalAccounts),
            pools: h.map((s) => s.totalPools),
            nodes: h.map((s) => s.totalNodes),
            runningNodes: h.map((s) => s.runningNodes),
            dedicatedUsed: h.map((s) => s.dedicatedCoresUsed),
            lpUsed: h.map((s) => s.lpCoresUsed),
            healthyRegions: h.map((s) => s.healthyRegions),
            unhealthyRegions: h.map((s) => s.unhealthyRegions),
            failedNodes: h.map((s) => s.failedNodes),
        };
    }, [state.history]);
    // Trends per card — derived from the actual history buffer rather than
    // the prior placeholder that multiplied a current-state ratio by 1/3/7.
    // When history is too short (cold start) all trends collapse to "flat 0%",
    // which is the truthful answer.
    const trendByCard = React.useMemo(() => {
        const window = RANGE_HISTORY_WINDOW[range];
        const period = RANGE_LABEL[range];
        return {
            accounts: computeTrend(sparkSeries.accounts, window, period),
            pools: computeTrend(sparkSeries.pools, window, period),
            runningNodes: computeTrend(sparkSeries.runningNodes, window, period),
            dedicated: computeTrend(sparkSeries.dedicatedUsed, window, period),
            lp: computeTrend(sparkSeries.lpUsed, window, period),
        };
    }, [
        range,
        sparkSeries.accounts,
        sparkSeries.pools,
        sparkSeries.runningNodes,
        sparkSeries.dedicatedUsed,
        sparkSeries.lpUsed,
    ]);
    // Suggested next actions — purely derived from current store state. Each
    // suggestion's urgency is a function of the failing population size; the
    // list is capped at 4 rows to keep the panel scannable. Recomputes only
    // when the source slices change so the operator doesn't see flicker on
    // unrelated state churn (e.g. a notification toast).
    const suggestions = React.useMemo(() => {
        var _a;
        const rows = [];
        const failedAccounts = state.accounts.filter((a) => a.provisioningState === "failed").length;
        const failedPools = state.pools.filter((p) => p.provisioningState === "failed").length;
        // "Stale" here = MSAL session reported signed-out, OR status=error.
        // The store no longer tracks a per-account "last refreshed" timestamp;
        // `signedOut === true` is the canonical "needs re-login" signal (see
        // store-types.ts:355) so we lean on that plus the `error` bucket.
        const staleAccounts = ((_a = state.azureAccounts) !== null && _a !== void 0 ? _a : []).filter((a) => a.signedOut === true || a.status === "error").length;
        // Critical: any failed pools — block on a pool delivers no compute.
        if (failedPools > 0) {
            rows.push({
                id: "failed-pools",
                label: `Resolve ${failedPools} failed pool${failedPools === 1 ? "" : "s"}`,
                rationale: "Provisioning is stuck — open Pool Info to retry or read per-row error detail.",
                target: "pool-info",
                urgency: "high",
            });
        }
        if (failedAccounts > 0) {
            rows.push({
                id: "failed-accounts",
                label: `Recover ${failedAccounts} failed account${failedAccounts === 1 ? "" : "s"}`,
                rationale: "Batch account creation failed — see Accounts for ARM error.",
                target: "accounts",
                urgency: "high",
            });
        }
        // Medium: signed-out / errored azure-accounts. Operator should re-auth.
        if (staleAccounts > 0) {
            rows.push({
                id: "stale-azure-accounts",
                label: `${staleAccounts} Azure account${staleAccounts === 1 ? "" : "s"} need re-auth`,
                rationale: "MSAL session lost or ARM/Graph call failed — open Azure Accounts to re-sign-in.",
                target: "azure-accounts",
                urgency: "medium",
            });
        }
        // Low: idle capacity worth provisioning.
        if (accountQuotaSummary.totalFreeLp > 0 &&
            accountQuotaSummary.withFreeLp >= 1) {
            rows.push({
                id: "idle-lp",
                label: `${formatNumber(accountQuotaSummary.totalFreeLp)} LP cores idle`,
                rationale: "Spare low-priority quota across accounts — run Detect Unused Quota below or open the full Unused Quota page.",
                target: "unused-quota",
                urgency: "low",
            });
        }
        return rows.slice(0, 4);
    }, [
        state.accounts,
        state.pools,
        state.azureAccounts,
        accountQuotaSummary.totalFreeLp,
        accountQuotaSummary.withFreeLp,
    ]);
    // Deep-link into the audit-log page with the action filter prefilled.
    // The audit-log page already honours `?action=...` for its toolbar filter
    // (route adapter); we just stamp the path here.
    const handleOpenAuditLogForAction = React.useCallback((actionKey) => {
        navigate(`/audit-log?action=${encodeURIComponent(actionKey)}`);
    }, [navigate]);
    const retryAction = React.useCallback((action, keys) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield orchestrator.execute({ action, payload: {} });
            if (!aliveRef.current)
                return;
            setCardErrors((prev) => {
                const next = Object.assign({}, prev);
                keys.forEach((k) => {
                    next[k] = null;
                });
                return next;
            });
        }
        catch (e) {
            if (!aliveRef.current)
                return;
            const msg = e instanceof Error ? e.message : "Refresh failed";
            setCardErrors((prev) => {
                const next = Object.assign({}, prev);
                keys.forEach((k) => {
                    next[k] = msg;
                });
                return next;
            });
        }
    }), [orchestrator]);
    // AbortController for the parallel refresh. Re-clicking Refresh while a
    // run is in flight cancels the prior one (the button is disabled, but a
    // keyboard hotkey could still slip through).
    const refreshAbortRef = React.useRef(null);
    const handleRefreshAll = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _m;
        if (refreshing)
            return;
        (_m = refreshAbortRef.current) === null || _m === void 0 ? void 0 : _m.abort();
        const controller = new AbortController();
        refreshAbortRef.current = controller;
        setRefreshing(true);
        // Run both refresh actions concurrently and collect outcomes via
        // `Promise.allSettled` so a slow pool refresh doesn't block account-
        // info from starting. Previously they were awaited sequentially,
        // doubling the wall-clock for a typical refresh.
        try {
            const [poolRes, acctRes] = yield Promise.allSettled([
                orchestrator.execute({
                    action: "refresh_pool_info",
                    payload: {},
                    signal: controller.signal,
                }),
                orchestrator.execute({
                    action: "refresh_account_info",
                    payload: {},
                    signal: controller.signal,
                }),
            ]);
            if (!aliveRef.current || controller.signal.aborted)
                return;
            const nextErrors = {};
            if (poolRes.status === "rejected") {
                const msg = poolRes.reason instanceof Error
                    ? poolRes.reason.message
                    : "Pool refresh failed";
                nextErrors.pools = msg;
                nextErrors.nodes = msg;
            }
            if (acctRes.status === "rejected") {
                const msg = acctRes.reason instanceof Error
                    ? acctRes.reason.message
                    : "Account refresh failed";
                nextErrors.accounts = msg;
                nextErrors.accountInfo = msg;
            }
            setCardErrors(nextErrors);
            const allOk = poolRes.status === "fulfilled" && acctRes.status === "fulfilled";
            // ARIA-live announcement so screen-reader users hear the dashboard
            // refreshed instead of having to inspect every KPI silently. Cycle a
            // trailing space so consecutive identical announcements still fire
            // (AT typically de-dupes when the text is character-for-character
            // identical between updates).
            setLiveAnnouncement(allOk
                ? `Dashboard refreshed at ${new Date().toLocaleTimeString()}.`
                : `Dashboard refresh completed with errors at ${new Date().toLocaleTimeString()}.`);
            // COORDINATOR: services/audit-log singleton bridges to the store; one
            // call writes through to `state.auditEntries`. Previous code wrote
            // directly via `store.addAuditEntry` — equivalent but bypassed the
            // singleton's correlation tracking.
            auditLog.record({
                actor: "overview-page",
                action: "refresh_all",
                target: `${state.accounts.length} accounts, ${state.pools.length} pools`,
                status: allOk ? "success" : "failure",
                details: {
                    poolStatus: poolRes.status,
                    accountStatus: acctRes.status,
                },
                error: allOk
                    ? undefined
                    : `pool=${poolRes.status} account=${acctRes.status}`,
            });
        }
        finally {
            if (aliveRef.current && refreshAbortRef.current === controller) {
                setRefreshing(false);
                refreshAbortRef.current = null;
            }
        }
    }), [refreshing, orchestrator, state.accounts.length, state.pools.length]);
    // Cancel any in-flight refresh on unmount — the per-section refs in
    // `UnusedQuotaSection` already do this for detect/create.
    React.useEffect(() => () => {
        var _a;
        (_a = refreshAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
    }, []);
    const handleRangeChange = React.useCallback((next) => {
        if (isRangeKey(next))
            setUrlState({ range: next });
    }, [setUrlState]);
    const handleRegionSearch = React.useCallback((q) => setUrlState({ regionSearch: q }), [setUrlState]);
    const handleRegionStatus = React.useCallback((f) => setUrlState({ regionStatus: f }), [setUrlState]);
    const handleQuotaSearch = React.useCallback((q) => setUrlState({ quotaSearch: q }), [setUrlState]);
    const handleToggleActivity = React.useCallback(() => setUrlState({
        activity: activityCollapsed ? "on" : "off",
    }), [setUrlState, activityCollapsed]);
    const handleRegionDrillDown = React.useCallback((regionName) => {
        navigate(`/account-info?region=${encodeURIComponent(regionName)}`);
    }, [navigate]);
    // Keyboard shortcut: `r` triggers Refresh All when not focused inside
    // an input. Mirrors the convention from the Nodes / Pools pages.
    useShortcut("r", () => {
        if (refreshing)
            return;
        void handleRefreshAll();
    }, { enabled: true, preventDefault: false });
    // Keyboard shortcut: `/` focuses the quota search input (only when the
    // table has rendered — otherwise the ref is null and we no-op).
    const quotaSearchRef = React.useRef(null);
    useShortcut("/", () => {
        const el = quotaSearchRef.current;
        if (el) {
            el.focus();
            el.select();
        }
    }, { enabled: true, preventDefault: true });
    // Number-key hotkeys for fast triage navigation — overview is the landing
    // page right after `/azure-accounts`, so the most common next click is
    // one of three deeper pages. `1` → accounts, `2` → pools, `3` → nodes.
    // Bare digits (no modifiers) intentionally — the sidebar Alt+1..9 nav
    // covers the modifier-protected variant; these mirror "vim-style" quick
    // jumps and are blocked while focus is inside an input by the hook's
    // default `allowInInputs: false`.
    useShortcut("1", () => navTo("accounts"), {
        enabled: true,
        preventDefault: false,
    });
    useShortcut("2", () => navTo("pool-info"), {
        enabled: true,
        preventDefault: false,
    });
    useShortcut("3", () => navTo("nodes"), {
        enabled: true,
        preventDefault: false,
    });
    // Extended hotkeys — top-10 destinations. `4`-`0` extend the wave-1 1/2/3
    // trio so the same vim-style quick-jump pattern covers every page the
    // overview most-commonly drills into. The sidebar's modifier-protected
    // Alt+digit nav is unchanged; these mirror it for keyboard-first users
    // who don't want to chord. Blocked while focus is in an input by the
    // shortcut hook's default `allowInInputs: false`.
    useShortcut("4", () => navTo("account-info"), {
        enabled: true,
        preventDefault: false,
    });
    useShortcut("5", () => navTo("unused-quota"), {
        enabled: true,
        preventDefault: false,
    });
    useShortcut("6", () => navTo("monitoring"), {
        enabled: true,
        preventDefault: false,
    });
    useShortcut("7", () => navTo("pools"), {
        enabled: true,
        preventDefault: false,
    });
    useShortcut("8", () => navTo("audit-log"), {
        enabled: true,
        preventDefault: false,
    });
    useShortcut("9", () => navTo("gpu-calculator"), {
        enabled: true,
        preventDefault: false,
    });
    useShortcut("0", () => navTo("azure-accounts"), {
        enabled: true,
        preventDefault: false,
    });
    const isLoading = refreshing || state.accounts.length === 0;
    const isEmptyState = !refreshing &&
        state.accounts.length === 0 &&
        stats.totalAccounts === 0 &&
        stats.totalPools === 0 &&
        stats.totalNodes === 0;
    const refreshButton = (React.createElement(Button, { variant: "default", onClick: handleRefreshAll, disabled: refreshing, "aria-label": "Refresh all data", title: "Refresh all (press R)" },
        React.createElement(RefreshCw, { className: cn("h-3.5 w-3.5 transition-transform duration-200", refreshing && "animate-spin") }),
        "Refresh All"));
    return (React.createElement("div", { className: cn("flex flex-col py-4", density === "compact" ? "gap-2" : "gap-4"), "data-density": density },
        React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only" }, liveAnnouncement),
        React.createElement("div", { className: "relative overflow-hidden rounded-xl border bg-card/50 p-6" },
            React.createElement(DotPattern, { fade: "top-left", className: "absolute inset-0" }),
            React.createElement(Meteors, { count: 12, tone: "primary", className: "absolute inset-0" }),
            React.createElement("div", { className: "relative z-10" },
                React.createElement(PageHeader, { title: "Multi-Region Manager", description: "Cross-region snapshot of accounts, pools, and node health. Use the range toggle to scope trends. Hotkeys: R refresh \u00B7 / filter unused quota \u00B7 1 accounts \u00B7 2 pools \u00B7 3 nodes \u00B7 4 account info \u00B7 5 unused quota \u00B7 6 monitoring \u00B7 7 pools list \u00B7 8 audit log \u00B7 9 GPU calc \u00B7 0 Azure accounts." },
                    React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                            loginHint: primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username,
                        }) }),
                    React.createElement(Tabs, { value: range, onValueChange: handleRangeChange, "aria-label": "Trend range" },
                        React.createElement(TabsList, { "aria-label": "Select trend range" }, RANGE_OPTIONS.map((opt) => (React.createElement(TabsTrigger, { key: opt, value: opt, "aria-label": `Show ${opt} trend` }, opt))))),
                    refreshing ? (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", null, refreshButton)),
                        React.createElement(TooltipContent, { side: "bottom" }, "Refresh in progress \u2014 please wait."))) : (refreshButton),
                    refreshing && (React.createElement(Loader2, { className: "h-4 w-4 animate-spin text-muted-foreground", "aria-label": "Refreshing" })),
                    React.createElement(WidgetCustomizer, { visibility: widgetVisibility, onToggle: toggleWidget, onResetAll: resetWidgets, density: density, onDensityChange: setDensity })))),
        isEmptyState && (React.createElement(EmptyState, { icon: LogIn, title: "No data yet", description: "Sign in on the Azure Accounts page to discover subscriptions, then refresh to populate this dashboard.", action: {
                label: "Go to Azure Accounts",
                icon: LogIn,
                onClick: () => navTo("azure-accounts"),
            } })),
        widgetVisibility.defender && (React.createElement(DefenderPostureSummary, { entries: (_f = state.auditEntries) !== null && _f !== void 0 ? _f : [], onOpenAuditLog: handleOpenAuditLogForAction })),
        widgetVisibility.suggestions && (React.createElement(SuggestedActions, { suggestions: suggestions, onNavigate: navTo })),
        !widgetVisibility.kpis ? null : isLoading &&
            stats.totalAccounts === 0 &&
            stats.totalPools === 0 ? (React.createElement("div", { role: "region", "aria-label": "Dashboard statistics" },
            React.createElement(SkeletonLoader, { variant: "stat-bar" }))) : (React.createElement("div", { role: "region", "aria-label": "Dashboard statistics", className: "flex flex-wrap gap-4" },
            React.createElement(StatCard, { id: "kpi-accounts", icon: Layers, title: "Accounts", info: "Discovered Batch accounts across all signed-in Azure tenants. Click to drill into provisioning state.", tone: "primary", onClick: () => navTo("accounts"), error: (_g = cardErrors.accounts) !== null && _g !== void 0 ? _g : null, onRetry: () => retryAction("refresh_account_info", ["accounts", "accountInfo"]), trend: trendByCard.accounts, goodDirection: "up", sparkData: sparkSeries.accounts, 
                // Click-through filter — the Accounts page already honours
                // `?status=failed` on its provisioning-state filter via
                // useUrlState; deep-link straight to the filtered view.
                failedCount: stats.failedAccounts, onFilterFailed: () => navigate("/accounts?status=failed"), items: [
                    { label: "Total", value: stats.totalAccounts, tone: "primary" },
                    {
                        label: "Created",
                        value: stats.createdAccounts,
                        tone: "success",
                    },
                    {
                        label: "Failed",
                        value: stats.failedAccounts,
                        tone: "destructive",
                    },
                ] }),
            React.createElement(StatCard, { id: "kpi-pools", icon: Boxes, title: "Pools", info: "Batch pools the manager is tracking. Failed pools can be reset via the Quick Actions panel below. Click to inspect per-pool details and resize state.", tone: "info", onClick: () => navTo("pool-info"), error: (_h = cardErrors.pools) !== null && _h !== void 0 ? _h : null, onRetry: () => retryAction("refresh_pool_info", ["pools", "nodes"]), trend: trendByCard.pools, goodDirection: "up", sparkData: sparkSeries.pools, failedCount: stats.failedPools, onFilterFailed: () => navigate("/pool-info?status=failed"), items: [
                    { label: "Total", value: stats.totalPools, tone: "info" },
                    {
                        label: "Created",
                        value: stats.createdPools,
                        tone: "success",
                    },
                    {
                        label: "Failed",
                        value: stats.failedPools,
                        tone: "destructive",
                    },
                ] }),
            React.createElement(StatCard, { id: "kpi-nodes", icon: Server, title: "Nodes", info: "Compute nodes inside the tracked pools. Issues = nodes in unusable / starttask-failed / offline / unknown / preempted states.", tone: "warning", onClick: () => navTo("nodes"), error: (_j = cardErrors.nodes) !== null && _j !== void 0 ? _j : null, onRetry: () => retryAction("refresh_pool_info", ["pools", "nodes"]), trend: trendByCard.runningNodes, goodDirection: "up", sparkData: sparkSeries.runningNodes, sparkTone: "success", failedCount: stats.nonWorkingNodes, onFilterFailed: () => navigate("/nodes?status=issues"), items: [
                    { label: "Total", value: stats.totalNodes, tone: "warning" },
                    {
                        label: "Running",
                        value: stats.runningNodes,
                        tone: "success",
                    },
                    {
                        label: "Issues",
                        value: stats.nonWorkingNodes,
                        tone: "destructive",
                    },
                ] }),
            state.accountInfos.length > 0 && (React.createElement(React.Fragment, null,
                React.createElement(StatCard, { id: "kpi-dedicated-cores", icon: Cpu, title: "Dedicated Cores", info: "Sum of in-use dedicated cores vs. quota across all tracked accounts. Click to inspect per-account breakdown.", tone: "info", onClick: () => navTo("account-info"), error: (_k = cardErrors.accountInfo) !== null && _k !== void 0 ? _k : null, onRetry: () => retryAction("refresh_account_info", [
                        "accounts",
                        "accountInfo",
                    ]), trend: trendByCard.dedicated, goodDirection: "up", sparkData: sparkSeries.dedicatedUsed, sparkTone: "info", items: [
                        { label: "Used", value: dedicatedUsed, tone: "warning" },
                        {
                            label: "Available",
                            value: dedicatedQuota,
                            tone: "success",
                        },
                    ] }),
                React.createElement(StatCard, { id: "kpi-lp-cores", icon: HardDrive, title: "Low Priority Cores", info: "Sum of in-use low-priority cores vs. quota. Unused LP capacity is the primary input to the Unused Quota detector below.", tone: "primary", onClick: () => navTo("account-info"), error: (_l = cardErrors.accountInfo) !== null && _l !== void 0 ? _l : null, onRetry: () => retryAction("refresh_account_info", [
                        "accounts",
                        "accountInfo",
                    ]), trend: trendByCard.lp, goodDirection: "up", sparkData: sparkSeries.lpUsed, sparkTone: "primary", items: [
                        { label: "Used", value: lpUsed, tone: "warning" },
                        { label: "Available", value: lpQuota, tone: "success" },
                    ] }))))),
        widgetVisibility.quotaSummary && accountQuotaSummary.totalAccounts > 0 && (React.createElement("div", { role: "group", "aria-label": "Per-account quota summary", className: "flex flex-wrap gap-2" },
            React.createElement(SummaryStatItem, { label: "Accounts", value: accountQuotaSummary.totalAccounts, hint: "discovered" }),
            React.createElement(SummaryStatItem, { label: "LP free", value: accountQuotaSummary.withFreeLp, hint: `of ${accountQuotaSummary.totalAccounts} accounts`, tone: accountQuotaSummary.withFreeLp > 0 ? "success" : "muted" }),
            React.createElement(SummaryStatItem, { label: "LP cores idle", value: accountQuotaSummary.totalFreeLp, hint: accountQuotaSummary.withFreeLp > 0
                    ? `≈ ${accountQuotaSummary.avgFreeLpPerAccount} / account`
                    : "none", tone: accountQuotaSummary.totalFreeLp > 0 ? "info" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Dedicated free", value: accountQuotaSummary.withFreeDedicated, hint: `of ${accountQuotaSummary.totalAccounts} accounts`, tone: accountQuotaSummary.withFreeDedicated > 0 ? "success" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Dedicated cores idle", value: accountQuotaSummary.totalFreeDedicated, tone: accountQuotaSummary.totalFreeDedicated > 0 ? "info" : "muted" }))),
        widgetVisibility.clusterHealth && regionHealthRows.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1" },
            React.createElement("div", { className: "flex items-center justify-end gap-2" },
                React.createElement(Button, { variant: "ghost", size: "sm", className: "text-2xs text-muted-foreground hover:text-foreground", onClick: () => setHideHealthyRegions((v) => !v), "aria-pressed": hideHealthyRegions, "aria-label": hideHealthyRegions
                        ? "Show all regions including healthy"
                        : "Hide healthy regions", title: hideHealthyRegions
                        ? "Showing only degraded / down regions"
                        : "Click to hide regions where every account is healthy" },
                    hideHealthyRegions ? (React.createElement(Eye, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(EyeOff, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                    hideHealthyRegions ? "Show all regions" : "Hide healthy"),
                React.createElement(Button, { variant: "ghost", size: "sm", className: "text-2xs text-muted-foreground hover:text-foreground", onClick: () => navTo("monitoring"), "aria-label": "Open Monitoring page for deeper region telemetry" }, "Open Monitoring \u2192")),
            React.createElement(ClusterHealthCard, { regions: visibleRegionHealthRows, historyHealthy: sparkSeries.healthyRegions, historyUnhealthy: sparkSeries.unhealthyRegions, onDrillDown: handleRegionDrillDown, searchQuery: regionSearch, onSearchQueryChange: handleRegionSearch, statusFilter: regionStatus, onStatusFilterChange: handleRegionStatus }),
            hideHealthyRegions &&
                visibleRegionHealthRows.length < regionHealthRows.length && (React.createElement("p", { className: "m-0 pl-1 text-2xs text-muted-foreground" },
                "Hiding",
                " ",
                regionHealthRows.length - visibleRegionHealthRows.length,
                " ",
                "healthy region",
                regionHealthRows.length - visibleRegionHealthRows.length ===
                    1
                    ? ""
                    : "s",
                ". This preference is persisted across reloads.")))),
        widgetVisibility.regionHealth && (React.createElement("div", { role: "region", "aria-label": "Region health" },
            React.createElement(Card, { className: "p-4" },
                React.createElement("div", { className: "mb-3 flex flex-wrap items-center justify-between gap-2" },
                    React.createElement("h2", { className: "m-0 text-base font-semibold text-foreground" }, "Region Health"),
                    regionHealthRows.length > 0 && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Click a region to drill down"))),
                visibleRegionHealthRows.length === 0 ? (isLoading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 3 })) : hideHealthyRegions && regionHealthRows.length > 0 ? (React.createElement(EmptyState, { icon: Server, title: "All regions healthy", description: "Every region has all accounts healthy. Toggle \u2018Show all regions\u2019 above to see the full grid." })) : (React.createElement(EmptyState, { icon: Server, title: "No regions discovered", description: "Refresh account info to populate per-region health metrics." }))) : (React.createElement(HoverList, { items: visibleRegionHealthRows
                        .slice()
                        .sort((a, b) => b.total - a.total), getKey: (r) => r.name, tone: "primary", onItemClick: (r) => handleRegionDrillDown(r.name), className: "gap-1", renderItem: (r) => React.createElement(RegionHealthChart, { regions: [r] }) }))))),
        widgetVisibility.unusedQuota && (React.createElement("div", { role: "region", "aria-label": "Unused quota" },
            React.createElement("div", { className: "flex justify-end" },
                React.createElement(Button, { variant: "ghost", size: "sm", className: "text-2xs text-muted-foreground hover:text-foreground", onClick: () => navTo("unused-quota"), "aria-label": "Open the full Unused Quota page" }, "Open Unused Quota page \u2192")),
            React.createElement(UnusedQuotaSection, { orchestrator: orchestrator, store: store, searchQuery: quotaSearch, onSearchQueryChange: handleQuotaSearch, searchInputRef: quotaSearchRef }))),
        widgetVisibility.agents && (React.createElement("div", { role: "region", "aria-label": "Agent status" },
            React.createElement(AgentStatusStrip, null))),
        widgetVisibility.quickActions && (React.createElement(Card, { role: "region", "aria-label": "Quick actions", className: "relative overflow-hidden p-4" },
            React.createElement(BorderBeam, { size: 200, duration: 8 }),
            React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
                React.createElement("h2", { className: "m-0 text-base font-semibold text-foreground" }, "Quick Actions"),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Bulk operations on the current session")),
            React.createElement(QuickActions, { store: store, onNavigate: navTo }))),
        widgetVisibility.recentActivity && (React.createElement("div", { role: "region", "aria-label": "Recent activity" },
            React.createElement(RecentActivity, { collapsed: activityCollapsed, onToggleCollapsed: handleToggleActivity, onOpenAuditAction: handleOpenAuditLogForAction })))));
};
export const OverviewPage = (props) => (React.createElement(ErrorBoundary, null,
    React.createElement(OverviewPageInner, Object.assign({}, props))));
//# sourceMappingURL=overview-page.js.map