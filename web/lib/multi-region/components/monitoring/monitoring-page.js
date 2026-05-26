import { __awaiter } from "tslib";
/**
 * Monitoring page — agent status, recent activity, and agent logs with URL-
 * bound filters (range / search / level / agent / status / live-tail), summary
 * stats, dual-format export (CSV + JSON) via the shared ExportMenu, and a
 * correlation-ID extractor that surfaces UUIDs embedded in messages so the
 * operator can one-click copy them for cross-referencing audit / agent traces.
 *
 * Design notes:
 *   - All filter state survives reload / sharing via URL params (Contract §4.3).
 *   - Active filters render as removable chips above the tables.
 *   - The two tables (Activity + Logs) read from a single computed view layer
 *     so summary counters, sparklines, and visible rows stay in lockstep.
 *   - `parseTimestamp` returns `NaN` for unparseable inputs (instead of 0,
 *     which silently bucketed bad rows into the Unix epoch and dropped them
 *     from every time window) — rows with invalid timestamps now surface in
 *     a discrete "Unknown time" row at the top so they're never invisible.
 *   - Log message correlation IDs are parsed via a centralized regex; the
 *     extracted ID flows into both the rendered cell and the export accessor
 *     so CSV/JSON downloads preserve the dimension you can actually grep on.
 *   - Live-tail mode flags entries that arrived since the previous refresh
 *     tick so the operator can see at-a-glance what is new without re-reading
 *     the whole list.
 */
import * as React from "react";
import { Activity as ActivityIcon, AlertTriangle, BarChart3, BellRing, Bookmark, Bug, CheckCircle2, ChevronRight, Clock, EyeOff, Filter as FilterIcon, Flame, Globe, HeartPulse, Info as InfoIcon, Pause, Play, RefreshCcw, Save, Search, Shield, Trash2, X, XCircle, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorState } from "@/components/ui/error-state";
import { Sparkline } from "@/components/ui/charts/sparkline";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn, downloadCsv, downloadJson, formatNumber, formatRelativeTime, } from "@/lib/utils";
import { useMultiRegionState } from "../../store/store-context";
import { useUrlState } from "../../hooks/use-url-state";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { auditLog } from "../../services/audit-log";
import { useDashboardOutletContext } from "../page-router";
import { DataTable } from "../shared/enhanced-table";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { RegionHealthChart, } from "../shared/region-health-chart";
import { BorderBeam, DotPattern, Meteors, NumberTicker, } from "@/components/ui/effects";
import { detectBlindSpots, detectRegionSpikes, evaluateRegion, extractRegion, updateRegionBaseline, } from "./detectors";
import { RegionAgentHeatmap } from "./region-agent-heatmap";
const TIME_RANGES = [
    { value: "1h", label: "1h" },
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
];
const TIME_RANGE_MS = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
};
const DEFAULT_RANGE = "24h";
const AGENT_NAMES = [
    "orchestrator",
    "provisioner",
    "quota",
    "monitor",
    "filter",
    "pool",
    "node",
];
const LOG_LEVELS = ["info", "warn", "error"];
const ACTIVITY_STATUSES = [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
    "paused",
    "cancelling",
];
const AGENT_STATUS_CLASSES = {
    idle: {
        container: "bg-muted",
        dot: "bg-muted-foreground",
        text: "text-muted-foreground",
        glow: "",
    },
    running: {
        container: "bg-primary/15",
        dot: "bg-primary",
        text: "text-primary",
        glow: "shadow-[0_0_6px_hsl(var(--primary))]",
    },
    completed: {
        container: "bg-success/15",
        dot: "bg-success",
        text: "text-success",
        glow: "",
    },
    error: {
        container: "bg-destructive/15",
        dot: "bg-destructive",
        text: "text-destructive",
        glow: "",
    },
};
const ACTIVITY_STATUS_CLASSES = {
    pending: "text-muted-foreground",
    running: "text-primary",
    completed: "text-success",
    failed: "text-destructive",
    cancelled: "text-muted-foreground",
    paused: "text-warning",
    cancelling: "text-warning",
};
const LOG_LEVEL_CLASSES = {
    error: {
        badge: "bg-destructive/15 text-destructive",
        message: "text-destructive/90",
    },
    warn: {
        badge: "bg-warning/15 text-warning",
        message: "text-foreground/80",
    },
    info: {
        badge: "bg-primary/15 text-primary",
        message: "text-foreground/80",
    },
};
const sectionClass = "rounded-lg border border-border bg-card p-4 shadow-sm";
const sectionHeadingClass = "mb-3 block text-base font-semibold text-foreground";
/**
 * UUID-style correlation IDs embedded in log/activity messages as `[<uuid>]`.
 * Matches the format produced by `generateCorrelationId` in orchestrator-agent.
 * Anchored to the bracket form so we don't accidentally pick up any raw UUID
 * that happens to appear in a payload — only IDs the agents explicitly tagged.
 */
const CORRELATION_ID_RE = /\[([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/i;
/** Bucket-count for sparklines — 24 keeps trends readable without noise. */
const SPARK_BUCKETS = 24;
/**
 * Once the last refresh is this old (or older), the page surfaces a "stale
 * data" warning banner above the summary so the operator knows the view is
 * no longer live. Five minutes matches the contract §6.4 freshness budget.
 */
const STALE_DATA_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_ALERT_THRESHOLDS = {
    errors: 1,
    warnings: 10,
    staleSec: 300,
};
const ALERT_THRESHOLDS_KEY = "monitoring.alertThresholds";
const DEFAULT_ALERT_SUBS = {
    regions: [],
    allRegions: true,
    minSeverity: "warning",
};
const ALERT_SUBS_KEY = "monitoring.alertSubscriptions";
const VIEW_PRESETS_KEY = "monitoring.viewPresets";
const VIEW_PRESETS_MAX = 12;
/**
 * Persisted EMA baseline for the per-region anomaly detector. The baseline
 * is updated on every refresh tick — see `detectors.updateRegionBaseline`.
 * Stored under `monitoring.regionBaselines`. Cleared if a stale entry hasn't
 * been touched in 24h (handled inside the updater).
 */
const REGION_BASELINE_KEY = "monitoring.regionBaselines";
/** Spike-detection window matches the corpus literature on resource-plane
 *  burst patterns (NetSPI MicroBurst-style chains complete in <5 min). */
const SPIKE_WINDOW_MS = 5 * 60 * 1000;
/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function isValidRange(value) {
    return (value === "1h" || value === "24h" || value === "7d" || value === "30d");
}
function isValidLevel(value) {
    return value === "info" || value === "warn" || value === "error";
}
function isValidAgentName(value) {
    return AGENT_NAMES.includes(value);
}
function isValidActivityStatus(value) {
    return ACTIVITY_STATUSES.includes(value);
}
/**
 * Robust timestamp parser. Returns `NaN` on invalid input (callers that need
 * a numeric default should fall back explicitly). The previous implementation
 * returned 0 on parse failure, which silently bucketed bad rows into the Unix
 * epoch and made them invisible to every time-window filter — a quiet data
 * loss that we now surface via the `Unknown time` UI state.
 */
function parseTimestamp(input) {
    if (input == null)
        return NaN;
    if (typeof input === "number")
        return Number.isFinite(input) ? input : NaN;
    const t = Date.parse(input);
    return Number.isNaN(t) ? NaN : t;
}
/**
 * Bucket a list of timestamps (ms epoch) into `bucketCount` equal-width
 * windows over [cutoff, now]. Returns counts per bucket, oldest first —
 * directly consumable by <Sparkline data={...}>. Drops NaN inputs so an
 * unparseable timestamp can't poison the histogram.
 */
function bucketTimestamps(timestamps, cutoff, now, bucketCount) {
    const buckets = new Array(bucketCount).fill(0);
    const span = Math.max(1, now - cutoff);
    for (const t of timestamps) {
        if (!Number.isFinite(t) || t < cutoff || t > now)
            continue;
        const frac = (t - cutoff) / span;
        let idx = Math.floor(frac * bucketCount);
        if (idx >= bucketCount)
            idx = bucketCount - 1;
        if (idx < 0)
            idx = 0;
        buckets[idx] += 1;
    }
    return buckets;
}
/** Extract a correlation ID embedded as `[<uuid>]` in a log message, if any. */
function extractCorrelationId(message) {
    const m = CORRELATION_ID_RE.exec(message);
    return m ? m[1] : null;
}
/** True when `tok` matches any of the fields, case-insensitive substring. */
function matchesQuery(tok, fields) {
    if (!tok)
        return true;
    const q = tok.toLowerCase();
    for (const f of fields) {
        if (f && f.toLowerCase().includes(q))
            return true;
    }
    return false;
}
/** Safe serializer for unknown `details` payloads — handles circular refs. */
function safeStringify(value, maxLen = 400) {
    if (value == null)
        return "";
    if (typeof value === "string") {
        return value.length > maxLen ? value.slice(0, maxLen - 1) + "…" : value;
    }
    const seen = new WeakSet();
    try {
        const s = JSON.stringify(value, (_k, v) => {
            if (typeof v === "object" && v !== null) {
                if (seen.has(v))
                    return "[Circular]";
                seen.add(v);
            }
            return v;
        });
        return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
    }
    catch (_a) {
        return String(value).slice(0, maxLen);
    }
}
/** Build a comma-joined URL token from a typed set, normalizing & dedup'ing. */
function parseSetParam(raw, guard) {
    if (!raw)
        return [];
    const out = [];
    const seen = new Set();
    for (const p of raw.split(",")) {
        const v = p.trim();
        if (!v || seen.has(v))
            continue;
        seen.add(v);
        if (guard(v))
            out.push(v);
    }
    return out;
}
const StaleBadge = ({ lastRefreshedAt, paused, }) => {
    const [now, setNow] = React.useState(() => Date.now());
    // Use useAbortableEffect so the wall-clock tick is torn down cleanly even
    // if the component unmounts mid-tick or a future caller wants to abort the
    // wall-clock subscription externally (signal-aware cleanup).
    useAbortableEffect((signal) => {
        const handle = window.setInterval(() => {
            if (signal.aborted)
                return;
            setNow(Date.now());
        }, 1000);
        return () => window.clearInterval(handle);
    }, []);
    const ageSec = Math.max(0, Math.floor((now - lastRefreshedAt) / 1000));
    const tone = ageSec >= 300
        ? "border-destructive/60 bg-destructive/15 text-destructive"
        : ageSec >= 60
            ? "border-warning/60 bg-warning/15 text-warning"
            : "border-success/60 bg-success/15 text-success";
    const label = paused
        ? `Paused (last refresh ${ageSec}s ago)`
        : `Last refreshed ${ageSec}s ago`;
    return (React.createElement("span", { role: "status", "aria-live": "polite", "aria-label": label, className: cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-2xs font-semibold", tone) }, label));
};
/** Pill-style multi-select chip used for level / agent / status filters. */
const FilterChip = ({ active, count, onToggle, label, ariaLabel, toneActive = "bg-primary/15 text-primary border-primary/40", toneIdle = "bg-card text-muted-foreground border-border hover:text-foreground hover:bg-muted/40", }) => {
    return (React.createElement("button", { type: "button", onClick: onToggle, "aria-pressed": active, "aria-label": ariaLabel !== null && ariaLabel !== void 0 ? ariaLabel : `${active ? "Hide" : "Show"} ${label}`, className: cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-medium tabular-nums", "transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", active ? toneActive : toneIdle) },
        React.createElement("span", { className: "uppercase tracking-wider" }, label),
        typeof count === "number" && (React.createElement("span", { className: cn("rounded-sm px-1 text-[10px]", active ? "bg-primary/20" : "bg-muted/50") }, count))));
};
const ActivePill = ({ label, onClear, ariaLabel }) => (React.createElement("span", { className: "inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary" },
    label,
    React.createElement("button", { type: "button", onClick: onClear, "aria-label": ariaLabel, className: "ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary" },
        React.createElement(X, { className: "h-3 w-3", "aria-hidden": true }))));
const MonitoringPageInner = ({ orchestrator, }) => {
    var _a, _b, _c;
    const state = useMultiRegionState();
    // COORDINATOR: we consume `navigateToPage` for the per-region drill-down
    // (Region Health row → /azure-accounts?region=<r>). The monitoring page is
    // otherwise a read-only view layer; we intentionally do NOT invoke
    // `orchestrator.execute(...)` on the refresh tick because (per the task
    // spec) raw poll events would flood the audit log and the underlying store
    // is already kept current by the agents that own real-side-effects.
    // The `orchestrator` prop is still received so the wiring contract stays
    // explicit at the call-site and we can read its agent id for the audit
    // trail when the operator mutates a filter or threshold.
    const { navigateToPage } = useDashboardOutletContext();
    // `Agent.name` is a required readonly AgentName — typed string, not null.
    const orchestratorName = orchestrator.name;
    // URL-bound state (range, search, levels, agents, statuses, live, region).
    // Per Contract §4.3 every filter survives reload / sharing.
    const [urlState, setUrlState] = useUrlState({
        range: DEFAULT_RANGE,
        metric: "",
        q: "",
        levels: "",
        agents: "",
        statuses: "",
        region: "",
        live: "",
    });
    const range = isValidRange(urlState.range)
        ? urlState.range
        : DEFAULT_RANGE;
    const searchQuery = (_a = urlState.q) !== null && _a !== void 0 ? _a : "";
    const selectedLevels = React.useMemo(() => parseSetParam(urlState.levels, isValidLevel), [urlState.levels]);
    const selectedAgents = React.useMemo(() => parseSetParam(urlState.agents, isValidAgentName), [urlState.agents]);
    const selectedStatuses = React.useMemo(() => parseSetParam(urlState.statuses, isValidActivityStatus), [urlState.statuses]);
    /**
     * Per-region multi-select filter (URL-persisted). Region strings are not
     * a closed enum (Azure mints new regions yearly), so we accept any non-
     * empty string and rely on the chip row sourced from the live data to
     * keep the UI tied to currently-present regions.
     */
    const selectedRegions = React.useMemo(() => {
        var _a;
        const raw = (_a = urlState.region) !== null && _a !== void 0 ? _a : "";
        if (!raw)
            return [];
        const out = [];
        const seen = new Set();
        for (const part of raw.split(",")) {
            const v = part.trim();
            if (!v || seen.has(v))
                continue;
            seen.add(v);
            out.push(v);
        }
        return out;
    }, [urlState.region]);
    const liveTail = urlState.live === "1";
    // Persisted alert thresholds — `usePersistedState` envelopes the value
    // and round-trips across reloads / tabs. We expose a typed setter so
    // mutations remain a single mutation (no partial-shape leaks).
    const [alertThresholds, setAlertThresholds] = usePersistedState(ALERT_THRESHOLDS_KEY, DEFAULT_ALERT_THRESHOLDS, { version: 1, syncAcrossTabs: true });
    // Persisted alert subscriptions — which regions/severities the operator
    // wants ARIA-announced when a threshold breach lands. See the type
    // definition for shape semantics.
    const [alertSubs, setAlertSubs] = usePersistedState(ALERT_SUBS_KEY, DEFAULT_ALERT_SUBS, { version: 1, syncAcrossTabs: true });
    // Persisted view presets — list keyed by name.
    const [viewPresets, setViewPresets] = usePersistedState(VIEW_PRESETS_KEY, [], { version: 1, syncAcrossTabs: true });
    // Persisted per-region EMA baseline. Updated on each refresh tick by an
    // effect below — `usePersistedState` round-trips the map across reloads
    // so the anomaly detector survives page reloads. Schema versioning lets
    // us evict stale shapes without crashing.
    const [regionBaselines, setRegionBaselines] = usePersistedState(REGION_BASELINE_KEY, {}, { version: 1, syncAcrossTabs: false });
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [, setTick] = React.useState(0);
    const [paused, setPaused] = React.useState(typeof document !== "undefined" && document.visibilityState === "hidden");
    const [lastRefreshedAt, setLastRefreshedAt] = React.useState(Date.now());
    const [refreshError, setRefreshError] = React.useState(null);
    // `refreshing` flips on for ~250ms whenever a manual refresh fires so chart
    // panels can show a skeleton — the auto-refresh tick re-renders silently
    // to avoid strobing the page every 30s.
    const [refreshing, setRefreshing] = React.useState(false);
    const refreshingTimerRef = React.useRef(null);
    React.useEffect(() => () => {
        if (refreshingTimerRef.current != null) {
            window.clearTimeout(refreshingTimerRef.current);
        }
    }, []);
    // "Since-last-refresh" pointer powers the live-tail "new since last tick"
    // markers. We snapshot the previous refresh wall-time so newly-arrived
    // rows can be visually flagged without re-fetching anything.
    //
    // PREVIOUS IMPLEMENTATION BUG (now fixed): the old version used an
    // effect-cleanup closure that captured the at-setup `lastRefreshedAt`,
    // which meant the ref was always one tick behind — every other refresh
    // mis-labeled the "new" rows. The two-ref shuffle below is React's
    // canonical "previous prop/state" pattern: during render, if the value
    // has changed since the last time we observed it, slide the old value
    // into `prevRefreshAtRef` and record the new one. Render-time ref
    // writes are safe here because the update is idempotent and depends
    // only on the new tick value — no side effects fire from this.
    const prevRefreshAtRef = React.useRef(lastRefreshedAt);
    const lastSeenRefreshRef = React.useRef(lastRefreshedAt);
    if (lastSeenRefreshRef.current !== lastRefreshedAt) {
        prevRefreshAtRef.current = lastSeenRefreshRef.current;
        lastSeenRefreshRef.current = lastRefreshedAt;
    }
    // Search input — debounced into URL so typing does not flood history.
    const [searchInput, setSearchInput] = React.useState(searchQuery);
    React.useEffect(() => {
        // Keep input in sync if the URL changes externally (back/forward).
        setSearchInput(searchQuery);
    }, [searchQuery]);
    React.useEffect(() => {
        if (searchInput === searchQuery)
            return;
        const handle = window.setTimeout(() => {
            setUrlState({ q: searchInput });
        }, 200);
        return () => window.clearTimeout(handle);
    }, [searchInput, searchQuery, setUrlState]);
    const searchInputRef = React.useRef(null);
    // Keyboard `/` focuses the search field (skipped when an editable element
    // already owns focus, so we don't hijack typing in dialogs / other inputs).
    React.useEffect(() => {
        const onKey = (e) => {
            if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey)
                return;
            const target = e.target;
            if (target) {
                const tag = target.tagName;
                if (tag === "INPUT" ||
                    tag === "TEXTAREA" ||
                    tag === "SELECT" ||
                    target.isContentEditable) {
                    return;
                }
            }
            const el = searchInputRef.current;
            if (el) {
                e.preventDefault();
                el.focus();
                el.select();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    // Refs carry the *latest* selected-regions / known-regions lists so the
    // 1-9 hotkey handler doesn't have to re-bind on every selection mutation.
    // The actual write-into-the-ref effects live further down (after the
    // memos that compute the values) — declaring the refs here keeps them
    // available to the hotkey handler below.
    const selectedRegionsRef = React.useRef([]);
    const knownRegionsRef = React.useRef([]);
    // Pause/resume auto-refresh on tab visibility change. We only bump the
    // refresh timestamp on resume IF auto-refresh is on — otherwise the badge
    // would lie about a refresh that never happened.
    React.useEffect(() => {
        const onVis = () => {
            const hidden = document.visibilityState === "hidden";
            setPaused(hidden);
            if (!hidden && autoRefresh) {
                setLastRefreshedAt(Date.now());
                setTick((t) => t + 1);
            }
        };
        document.addEventListener("visibilitychange", onVis);
        return () => document.removeEventListener("visibilitychange", onVis);
    }, [autoRefresh]);
    // Auto-refresh tick (30s); paused while tab hidden.
    React.useEffect(() => {
        if (!autoRefresh || paused)
            return;
        const interval = setInterval(() => {
            setLastRefreshedAt(Date.now());
            setTick((t) => t + 1);
        }, 30000);
        return () => clearInterval(interval);
    }, [autoRefresh, paused]);
    const handleManualRefresh = React.useCallback(() => {
        try {
            setLastRefreshedAt(Date.now());
            setTick((t) => t + 1);
            setRefreshError(null);
            setRefreshing(true);
            if (refreshingTimerRef.current != null) {
                window.clearTimeout(refreshingTimerRef.current);
            }
            refreshingTimerRef.current = window.setTimeout(() => {
                setRefreshing(false);
                refreshingTimerRef.current = null;
            }, 250);
        }
        catch (e) {
            setRefreshError(e instanceof Error ? e.message : "Unknown refresh error");
        }
    }, []);
    const handleRangeChange = React.useCallback((value) => {
        if (isValidRange(value)) {
            setUrlState({ range: value });
        }
    }, [setUrlState]);
    const toggleLevel = React.useCallback((lvl) => {
        const next = selectedLevels.includes(lvl)
            ? selectedLevels.filter((l) => l !== lvl)
            : [...selectedLevels, lvl];
        setUrlState({ levels: next.join(",") });
    }, [selectedLevels, setUrlState]);
    const toggleAgent = React.useCallback((a) => {
        const next = selectedAgents.includes(a)
            ? selectedAgents.filter((x) => x !== a)
            : [...selectedAgents, a];
        setUrlState({ agents: next.join(",") });
    }, [selectedAgents, setUrlState]);
    const toggleStatus = React.useCallback((s) => {
        const next = selectedStatuses.includes(s)
            ? selectedStatuses.filter((x) => x !== s)
            : [...selectedStatuses, s];
        setUrlState({ statuses: next.join(",") });
    }, [selectedStatuses, setUrlState]);
    const toggleRegion = React.useCallback((r) => {
        const next = selectedRegions.includes(r)
            ? selectedRegions.filter((x) => x !== r)
            : [...selectedRegions, r];
        setUrlState({ region: next.join(",") });
        // Audit only the mutation — region toggles are user intent (worth a
        // trail), but the per-second wall-clock tick is not.
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.region_filter_changed",
            target: `regions:${next.join("+") || "all"}`,
            status: "success",
            details: { previous: selectedRegions, next },
        });
    }, [selectedRegions, setUrlState, orchestratorName]);
    const handleClearFilters = React.useCallback(() => {
        setUrlState({ q: "", levels: "", agents: "", statuses: "", region: "" });
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.filters_cleared",
            target: "monitoring-page",
            status: "success",
        });
    }, [setUrlState, orchestratorName]);
    const toggleLiveTail = React.useCallback(() => {
        setUrlState({ live: liveTail ? "" : "1" });
    }, [liveTail, setUrlState]);
    /**
     * Drill-down: clicking a region row in the Region Health panel routes to
     * the Azure Accounts page with the region pre-selected. Path-based nav per
     * the wiring contract — never call `useNavigate` directly here.
     */
    const handleRegionDrillDown = React.useCallback((region) => {
        navigateToPage(`/azure-accounts?region=${encodeURIComponent(region)}`);
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.region_drilldown",
            target: `region:${region}`,
            status: "success",
        });
    }, [navigateToPage, orchestratorName]);
    /**
     * Persist a partial threshold change. Audit-logged because thresholds
     * directly control which `StatCard` flips to `alert` status — i.e. the
     * operator's calibration of what counts as "noisy enough to look at".
     */
    // Hold the latest committed threshold value in a ref so the audit-log
    // record (which lives outside the setState updater) doesn't have to
    // capture the stale render closure. Also lets us avoid double-emit if
    // the updater re-runs under StrictMode.
    const alertThresholdsRef = React.useRef(alertThresholds);
    React.useEffect(() => {
        alertThresholdsRef.current = alertThresholds;
    }, [alertThresholds]);
    const handleThresholdChange = React.useCallback((patch) => {
        const prev = alertThresholdsRef.current;
        const next = Object.assign(Object.assign({}, prev), patch);
        // Sanitize: clamp to non-negative integers so a typo can't poison
        // the persisted blob with NaN / negatives that would mute every
        // alert. Side-effect-free outside the closure.
        for (const k of Object.keys(next)) {
            const v = next[k];
            if (!Number.isFinite(v) || v < 0)
                next[k] = DEFAULT_ALERT_THRESHOLDS[k];
        }
        setAlertThresholds(next);
        // Audit fires exactly once per user action (the updater isn't doing
        // it, so StrictMode's double-invoke can't double-emit).
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.threshold_changed",
            target: "alert-thresholds",
            status: "success",
            details: { previous: prev, next, patch },
        });
    }, [setAlertThresholds, orchestratorName]);
    const handleResetThresholds = React.useCallback(() => {
        setAlertThresholds(DEFAULT_ALERT_THRESHOLDS);
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.thresholds_reset",
            target: "alert-thresholds",
            status: "success",
        });
    }, [setAlertThresholds, orchestratorName]);
    /* -------- Alert subscriptions ---------------------------------------- */
    const handleSubsToggleAllRegions = React.useCallback((allRegions) => {
        setAlertSubs((prev) => (Object.assign(Object.assign({}, prev), { allRegions })));
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.alert_subs_changed",
            target: "subscriptions",
            status: "success",
            details: { field: "allRegions", value: allRegions },
        });
    }, [setAlertSubs, orchestratorName]);
    const handleSubsToggleRegion = React.useCallback((region) => {
        setAlertSubs((prev) => {
            const has = prev.regions.includes(region);
            const next = has
                ? prev.regions.filter((r) => r !== region)
                : [...prev.regions, region];
            return Object.assign(Object.assign({}, prev), { regions: next });
        });
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.alert_subs_region_toggled",
            target: `region:${region}`,
            status: "success",
        });
    }, [setAlertSubs, orchestratorName]);
    const handleSubsSeverityChange = React.useCallback((minSeverity) => {
        setAlertSubs((prev) => (Object.assign(Object.assign({}, prev), { minSeverity })));
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.alert_subs_severity_changed",
            target: "subscriptions",
            status: "success",
            details: { minSeverity },
        });
    }, [setAlertSubs, orchestratorName]);
    /* -------- View presets ----------------------------------------------- */
    /**
     * Capture the current filter combo under a named preset. Trims + clamps
     * the name; rejects duplicates (overwrite is intentional — same name
     * replaces the prior entry); caps the list at VIEW_PRESETS_MAX so the
     * localStorage blob can't grow unbounded.
     */
    const handleSavePreset = React.useCallback((rawName) => {
        const name = (rawName || "").trim().slice(0, 32);
        if (!name)
            return;
        const entry = {
            name,
            range,
            q: searchQuery,
            levels: selectedLevels.join(","),
            agents: selectedAgents.join(","),
            statuses: selectedStatuses.join(","),
            region: selectedRegions.join(","),
            live: liveTail,
            createdAt: Date.now(),
        };
        setViewPresets((prev) => {
            const withoutDup = prev.filter((p) => p.name !== name);
            const next = [entry, ...withoutDup].slice(0, VIEW_PRESETS_MAX);
            return next;
        });
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.view_preset_saved",
            target: `preset:${name}`,
            status: "success",
            details: { entry },
        });
    }, [
        range,
        searchQuery,
        selectedLevels,
        selectedAgents,
        selectedStatuses,
        selectedRegions,
        liveTail,
        setViewPresets,
        orchestratorName,
    ]);
    const handleApplyPreset = React.useCallback((name) => {
        const p = viewPresets.find((x) => x.name === name);
        if (!p)
            return;
        setUrlState({
            range: p.range,
            q: p.q,
            levels: p.levels,
            agents: p.agents,
            statuses: p.statuses,
            region: p.region,
            live: p.live ? "1" : "",
        });
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.view_preset_applied",
            target: `preset:${name}`,
            status: "success",
        });
    }, [viewPresets, setUrlState, orchestratorName]);
    const handleDeletePreset = React.useCallback((name) => {
        setViewPresets((prev) => prev.filter((p) => p.name !== name));
        auditLog.record({
            actor: orchestratorName,
            action: "monitoring.view_preset_deleted",
            target: `preset:${name}`,
            status: "success",
        });
    }, [setViewPresets, orchestratorName]);
    // Time-range filter cutoff (ms epoch). `lastRefreshedAt` is a real dep so
    // the window slides forward on every refresh tick.
    const cutoff = React.useMemo(() => lastRefreshedAt - TIME_RANGE_MS[range], [range, lastRefreshedAt]);
    // "Last hour" pointer — used by the summary row and the "errors in the
    // last hour" lozenge regardless of which range tab is selected.
    const oneHourAgo = lastRefreshedAt - TIME_RANGE_MS["1h"];
    // ---- Region health (per-region account counts) --------------------------
    // Build a stable per-region snapshot of [healthy=created, total=all] for
    // the RegionHealthChart. `state.accounts` is the source of truth — the
    // chart re-derives from a memoized projection so we don't re-render on
    // every store mutation that doesn't touch accounts.
    const regionHealth = React.useMemo(() => {
        var _a, _b, _c;
        const all = (_a = state.accounts) !== null && _a !== void 0 ? _a : [];
        if (all.length === 0)
            return [];
        const byRegion = new Map();
        for (const acc of all) {
            const r = ((_b = acc.region) !== null && _b !== void 0 ? _b : "").trim() || "unknown";
            const cur = (_c = byRegion.get(r)) !== null && _c !== void 0 ? _c : { healthy: 0, total: 0 };
            cur.total += 1;
            if (acc.provisioningState === "created")
                cur.healthy += 1;
            byRegion.set(r, cur);
        }
        const rows = [];
        for (const [name, v] of byRegion.entries()) {
            rows.push({ name, healthy: v.healthy, total: v.total });
        }
        rows.sort((a, b) => a.name.localeCompare(b.name));
        return rows;
    }, [state.accounts]);
    /** Set of regions present in current accounts — used to gate region chips. */
    const knownRegions = React.useMemo(() => regionHealth.map((r) => r.name), [regionHealth]);
    // Mirror the latest known/selected region lists into their refs so the
    // 1-9 hotkey handler (bound once on mount) can read them without
    // re-binding. Two effects, two single-purpose dep arrays — keeps the
    // intent obvious to whoever reads the source next.
    React.useEffect(() => {
        knownRegionsRef.current = knownRegions;
    }, [knownRegions]);
    React.useEffect(() => {
        selectedRegionsRef.current = selectedRegions;
    }, [selectedRegions]);
    /**
     * Keyboard 1-9 hotkeys toggle the first nine known regions in/out of the
     * region-filter set. This makes single-keystroke region focus possible
     * without leaving the keyboard — Splunk-style. Skipped while focus is
     * inside an editable element, same rule as the `/` shortcut.
     *
     * The list of regions the digits map onto is the same alphabetically-
     * sorted snapshot that the Region Health panel renders, so the digit's
     * meaning is visible on-screen at all times. We read both lists via
     * refs so the handler is bound exactly once and never tears down during
     * rapid filter mutations.
     */
    React.useEffect(() => {
        const onKey = (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey)
                return;
            // ASCII '1'..'9'
            const code = e.key;
            if (code < "1" || code > "9")
                return;
            const target = e.target;
            if (target) {
                const tag = target.tagName;
                if (tag === "INPUT" ||
                    tag === "TEXTAREA" ||
                    tag === "SELECT" ||
                    target.isContentEditable) {
                    return;
                }
            }
            const idx = code.charCodeAt(0) - "1".charCodeAt(0); // 0..8
            const regions = knownRegionsRef.current;
            const target_region = regions[idx];
            if (!target_region)
                return;
            e.preventDefault();
            // Inline the toggle so we don't depend on `toggleRegion` capturing
            // stale `selectedRegions`. The setter takes a plain string list so
            // URL state stays canonical.
            const current = selectedRegionsRef.current;
            const next = current.includes(target_region)
                ? current.filter((r) => r !== target_region)
                : [...current, target_region];
            setUrlState({ region: next.join(",") });
            auditLog.record({
                actor: orchestratorName,
                action: "monitoring.region_hotkey_toggled",
                target: `region:${target_region}`,
                status: "success",
                details: { digit: idx + 1, next },
            });
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [setUrlState, orchestratorName]);
    // ---- Filtered activities (time + status + search + region) --------------
    // Region is matched against the activity `target` string as a case-insensitive
    // substring — activities embed `region:<name>` / `@ <name>` markers via the
    // orchestrator's _resolveActivityTarget. This is intentionally loose so the
    // filter still works for rows whose target format we haven't fully canonicalized.
    const filteredActivities = React.useMemo(() => {
        var _a, _b;
        const all = (_a = state.activities) !== null && _a !== void 0 ? _a : [];
        const result = [];
        const regionSet = new Set(selectedRegions.map((r) => r.toLowerCase()));
        const hasRegion = regionSet.size > 0;
        for (const a of all) {
            const ts = parseTimestamp(a.startedAt);
            // Allow rows with unparseable timestamps through the time gate so they
            // remain visible (they sort to the top under "Unknown time"). They get
            // re-filtered by status/search below like any other row.
            if (Number.isFinite(ts) && ts < cutoff)
                continue;
            if (selectedStatuses.length > 0 &&
                !selectedStatuses.includes(a.status)) {
                continue;
            }
            if (hasRegion) {
                const t = a.target.toLowerCase();
                let matched = false;
                for (const r of regionSet) {
                    if (t.includes(r)) {
                        matched = true;
                        break;
                    }
                }
                if (!matched)
                    continue;
            }
            if (!matchesQuery(searchQuery, [
                a.action,
                a.target,
                a.status,
                (_b = a.error) !== null && _b !== void 0 ? _b : "",
                a.id,
            ])) {
                continue;
            }
            result.push(a);
        }
        // Newest first; unknown-time rows go to the top so they aren't lost.
        return result.sort((a, b) => {
            const ta = parseTimestamp(a.startedAt);
            const tb = parseTimestamp(b.startedAt);
            const aBad = !Number.isFinite(ta);
            const bBad = !Number.isFinite(tb);
            if (aBad && !bBad)
                return -1;
            if (!aBad && bBad)
                return 1;
            if (aBad && bBad)
                return 0;
            return tb - ta;
        });
    }, [state.activities, cutoff, selectedStatuses, searchQuery, selectedRegions]);
    // ---- Filtered logs (time + level + agent + search + region) -------------
    const filteredLogs = React.useMemo(() => {
        var _a, _b;
        const all = (_a = state.agentLogs) !== null && _a !== void 0 ? _a : [];
        const result = [];
        const regionSet = new Set(selectedRegions.map((r) => r.toLowerCase()));
        const hasRegion = regionSet.size > 0;
        for (const l of all) {
            const ts = parseTimestamp(l.timestamp);
            if (Number.isFinite(ts) && ts < cutoff)
                continue;
            if (selectedLevels.length > 0 && !selectedLevels.includes(l.level)) {
                continue;
            }
            if (selectedAgents.length > 0 && !selectedAgents.includes(l.agent)) {
                continue;
            }
            if (hasRegion) {
                // Region appears either inside the message body (agents include
                // `region=<name>` or `[<name>]` markers) or in the structured
                // `details` payload. Probe both before dropping the row so the
                // filter doesn't accidentally swallow legitimate region matches.
                const blob = (l.message || "").toLowerCase() +
                    " " +
                    (l.details ? safeStringify(l.details, 200).toLowerCase() : "");
                let matched = false;
                for (const r of regionSet) {
                    if (blob.includes(r)) {
                        matched = true;
                        break;
                    }
                }
                if (!matched)
                    continue;
            }
            if (!matchesQuery(searchQuery, [
                l.message,
                l.agent,
                l.level,
                (_b = extractCorrelationId(l.message)) !== null && _b !== void 0 ? _b : "",
            ])) {
                continue;
            }
            result.push(l);
        }
        return result.sort((a, b) => {
            const ta = parseTimestamp(a.timestamp);
            const tb = parseTimestamp(b.timestamp);
            const aBad = !Number.isFinite(ta);
            const bBad = !Number.isFinite(tb);
            if (aBad && !bBad)
                return -1;
            if (!aBad && bBad)
                return 1;
            if (aBad && bBad)
                return 0;
            return tb - ta;
        });
    }, [
        state.agentLogs,
        cutoff,
        selectedLevels,
        selectedAgents,
        searchQuery,
        selectedRegions,
    ]);
    // Pre-counts (unfiltered, for chip badges so the operator sees totals even
    // when a chip is currently active).
    const rangeCounts = React.useMemo(() => {
        var _a, _b, _c, _d, _e;
        const all = (_a = state.activities) !== null && _a !== void 0 ? _a : [];
        const allLogs = (_b = state.agentLogs) !== null && _b !== void 0 ? _b : [];
        const inRange = (ts) => {
            const t = parseTimestamp(ts);
            return !Number.isFinite(t) || t >= cutoff;
        };
        const byLevel = { info: 0, warn: 0, error: 0 };
        const byAgent = {
            orchestrator: 0,
            provisioner: 0,
            quota: 0,
            monitor: 0,
            filter: 0,
            pool: 0,
            node: 0,
        };
        let logTotal = 0;
        for (const l of allLogs) {
            if (!inRange(l.timestamp))
                continue;
            logTotal++;
            byLevel[l.level] = ((_c = byLevel[l.level]) !== null && _c !== void 0 ? _c : 0) + 1;
            byAgent[l.agent] = ((_d = byAgent[l.agent]) !== null && _d !== void 0 ? _d : 0) + 1;
        }
        const byStatus = {};
        for (const s of ACTIVITY_STATUSES)
            byStatus[s] = 0;
        let actTotal = 0;
        for (const a of all) {
            if (!inRange(a.startedAt))
                continue;
            actTotal++;
            byStatus[a.status] = ((_e = byStatus[a.status]) !== null && _e !== void 0 ? _e : 0) + 1;
        }
        return { byLevel, byAgent, byStatus, logTotal, actTotal };
    }, [state.activities, state.agentLogs, cutoff]);
    // Summary metrics — uses the filtered slices so the operator sees what
    // the current filter set actually reveals.
    const summary = React.useMemo(() => {
        const activitiesCount = filteredActivities.length;
        const failed = filteredActivities.filter((a) => a.status === "failed").length;
        const running = filteredActivities.filter((a) => a.status === "running").length;
        const errorLogs = filteredLogs.filter((l) => l.level === "error").length;
        const warnLogs = filteredLogs.filter((l) => l.level === "warn").length;
        // Last-hour buckets (always 1h regardless of selected range) so the
        // "stale spike?" question never depends on choosing the right tab.
        let activitiesLastHr = 0;
        let errorsLastHr = 0;
        for (const a of filteredActivities) {
            const t = parseTimestamp(a.startedAt);
            if (Number.isFinite(t) && t >= oneHourAgo)
                activitiesLastHr++;
        }
        for (const l of filteredLogs) {
            const t = parseTimestamp(l.timestamp);
            if (Number.isFinite(t) && t >= oneHourAgo && l.level === "error") {
                errorsLastHr++;
            }
        }
        return {
            activitiesCount,
            failed,
            running,
            errorLogs,
            warnLogs,
            activitiesLastHr,
            errorsLastHr,
        };
    }, [filteredActivities, filteredLogs, oneHourAgo]);
    // Sparkline series — bucket events across the visible time range so each
    // stat card shows a trend, not just a number.
    const sparklines = React.useMemo(() => {
        const now = lastRefreshedAt;
        const allActivityTs = filteredActivities.map((a) => parseTimestamp(a.startedAt));
        const failedTs = filteredActivities
            .filter((a) => a.status === "failed")
            .map((a) => parseTimestamp(a.startedAt));
        const runningTs = filteredActivities
            .filter((a) => a.status === "running")
            .map((a) => parseTimestamp(a.startedAt));
        const errorTs = filteredLogs
            .filter((l) => l.level === "error")
            .map((l) => parseTimestamp(l.timestamp));
        const warnTs = filteredLogs
            .filter((l) => l.level === "warn")
            .map((l) => parseTimestamp(l.timestamp));
        return {
            activities: bucketTimestamps(allActivityTs, cutoff, now, SPARK_BUCKETS),
            running: bucketTimestamps(runningTs, cutoff, now, SPARK_BUCKETS),
            failed: bucketTimestamps(failedTs, cutoff, now, SPARK_BUCKETS),
            errorLogs: bucketTimestamps(errorTs, cutoff, now, SPARK_BUCKETS),
            warnLogs: bucketTimestamps(warnTs, cutoff, now, SPARK_BUCKETS),
        };
    }, [filteredActivities, filteredLogs, cutoff, lastRefreshedAt]);
    // Per-agent log activity sparkline (uses pre-filter logs so the picture
    // doesn't collapse when the user filters by agent — the goal is to see
    // which OTHER agents are busy, too).
    const agentSparklines = React.useMemo(() => {
        var _a;
        const now = lastRefreshedAt;
        const out = {};
        const allLogs = (_a = state.agentLogs) !== null && _a !== void 0 ? _a : [];
        for (const name of AGENT_NAMES) {
            const ts = [];
            let errors = 0;
            for (const l of allLogs) {
                if (l.agent !== name)
                    continue;
                const t = parseTimestamp(l.timestamp);
                if (!Number.isFinite(t) || t < cutoff)
                    continue;
                ts.push(t);
                if (l.level === "error")
                    errors++;
            }
            out[name] = {
                spark: bucketTimestamps(ts, cutoff, now, SPARK_BUCKETS),
                total: ts.length,
                errors,
            };
        }
        return out;
    }, [state.agentLogs, cutoff, lastRefreshedAt]);
    // ------------------------------------------------------------------
    //  Corpus-grounded detectors
    // ------------------------------------------------------------------
    //
    //  1. detectRegionSpikes (5-minute sliding window) — flags regions whose
    //     recent activity has burst above their baseline. The pattern is
    //     diagnostic of automated resource-plane abuse: see
    //     `New folder\_analysis_netspi.md` §I "IMDS Variants" + §II "RunAs
    //     Certificate Abuse" — both produce concentrated per-region bursts
    //     of provision / token / pool activity within a few minutes.
    //
    //  2. detectBlindSpots — flags regions with provisioned accounts but no
    //     log activity. See `New folder\_analysis_defender_view.md` —
    //     Azucar / ScoutSuite / Prowler all probe diagnostic-settings
    //     coverage because dark regions are the #1 visibility gap.
    /** All accounts treated as in-scope for blind-spot detection. We avoid
     *  filtering by region here because the WHOLE POINT of the detector is
     *  to flag regions the operator hasn't focused on. */
    const allAccounts = React.useMemo(() => { var _a; return (_a = state.accounts) !== null && _a !== void 0 ? _a : []; }, [state.accounts]);
    // Run the spike detector on the PRE-FILTER slice (state.activities /
    // state.agentLogs). Filtering before the detector would let an operator
    // accidentally hide the spike they were investigating. Time-bounded by
    // the page's existing `cutoff` for fairness with the rest of the panel.
    const allActivitiesInRange = React.useMemo(() => {
        var _a;
        const out = [];
        for (const a of (_a = state.activities) !== null && _a !== void 0 ? _a : []) {
            const t = parseTimestamp(a.startedAt);
            if (Number.isFinite(t) && t < cutoff)
                continue;
            out.push(a);
        }
        return out;
    }, [state.activities, cutoff]);
    const allLogsInRange = React.useMemo(() => {
        var _a;
        const out = [];
        for (const l of (_a = state.agentLogs) !== null && _a !== void 0 ? _a : []) {
            const t = parseTimestamp(l.timestamp);
            if (Number.isFinite(t) && t < cutoff)
                continue;
            out.push(l);
        }
        return out;
    }, [state.agentLogs, cutoff]);
    const regionSpikes = React.useMemo(() => detectRegionSpikes(allActivitiesInRange, allLogsInRange, {
        windowMs: SPIKE_WINDOW_MS,
        now: lastRefreshedAt,
    }), [allActivitiesInRange, allLogsInRange, lastRefreshedAt]);
    const blindSpots = React.useMemo(() => detectBlindSpots(allAccounts, allLogsInRange, { cutoff }), [allAccounts, allLogsInRange, cutoff]);
    // ---- Region × agent heatmap matrix --------------------------------------
    // Each cell carries (count, errors). Operator-visible label uses
    // alphabetical region order to match the Region Health panel + 1-9
    // hotkey mapping for muscle-memory consistency.
    const heatmapCells = React.useMemo(() => {
        var _a, _b;
        const map = new Map();
        for (const l of allLogsInRange) {
            const blob = `${l.message} ${JSON.stringify((_a = l.details) !== null && _a !== void 0 ? _a : {})}`;
            const region = extractRegion(blob);
            if (!region)
                continue;
            const key = `${region}|${l.agent}`;
            const cur = (_b = map.get(key)) !== null && _b !== void 0 ? _b : {
                region,
                agent: l.agent,
                count: 0,
                errors: 0,
            };
            cur.count += 1;
            if (l.level === "error")
                cur.errors += 1;
            map.set(key, cur);
        }
        return [...map.values()];
    }, [allLogsInRange]);
    /** Regions to render across heatmap rows — alphabetical, deduplicated
     *  across (known regions from accounts) ∪ (regions found in logs). */
    const heatmapRegions = React.useMemo(() => {
        const set = new Set(knownRegions);
        for (const c of heatmapCells)
            set.add(c.region);
        return [...set].sort((a, b) => a.localeCompare(b));
    }, [knownRegions, heatmapCells]);
    // ---- Persisted EMA baseline update --------------------------------------
    // Each refresh tick, fold the recent spike-window counts into the
    // persisted EMA. The detector is cheap; we run it inside an effect
    // (not a memo) to avoid wedging render time on the localStorage write.
    // Re-runs only when the refresh timestamp changes — i.e. on tick.
    const lastBaselineTickRef = React.useRef(0);
    React.useEffect(() => {
        var _a, _b, _c, _d, _e;
        if (lastBaselineTickRef.current === lastRefreshedAt)
            return;
        lastBaselineTickRef.current = lastRefreshedAt;
        const recentCutoff = lastRefreshedAt - SPIKE_WINDOW_MS;
        const counts = new Map();
        for (const a of (_a = state.activities) !== null && _a !== void 0 ? _a : []) {
            const t = parseTimestamp(a.startedAt);
            if (!Number.isFinite(t) || t < recentCutoff || t > lastRefreshedAt) {
                continue;
            }
            const r = extractRegion(a.target);
            if (!r)
                continue;
            counts.set(r, ((_b = counts.get(r)) !== null && _b !== void 0 ? _b : 0) + 1);
        }
        for (const l of (_c = state.agentLogs) !== null && _c !== void 0 ? _c : []) {
            const t = parseTimestamp(l.timestamp);
            if (!Number.isFinite(t) || t < recentCutoff || t > lastRefreshedAt) {
                continue;
            }
            const blob = `${l.message} ${JSON.stringify((_d = l.details) !== null && _d !== void 0 ? _d : {})}`;
            const r = extractRegion(blob);
            if (!r)
                continue;
            counts.set(r, ((_e = counts.get(r)) !== null && _e !== void 0 ? _e : 0) + 1);
        }
        if (counts.size === 0)
            return;
        setRegionBaselines((prev) => updateRegionBaseline(prev, counts, { now: lastRefreshedAt }));
    }, [lastRefreshedAt, state.activities, state.agentLogs, setRegionBaselines]);
    // ---- ARIA-live announcement on threshold breach -------------------------
    // We surface a polite live region whose text changes only when a NEW
    // spike crosses the operator's `minSeverity` filter AND lands in a
    // subscribed region. The previous-set ref kills repeat announcements so
    // a screen-reader doesn't strobe on every tick.
    const prevAnnouncedSpikesRef = React.useRef(new Set());
    const [liveAnnouncement, setLiveAnnouncement] = React.useState("");
    React.useEffect(() => {
        var _a;
        const severityRank = {
            info: 0,
            warning: 1,
            critical: 2,
        };
        const minRank = (_a = severityRank[alertSubs.minSeverity]) !== null && _a !== void 0 ? _a : 1;
        const subscribed = (region) => alertSubs.allRegions || alertSubs.regions.includes(region);
        const fresh = [];
        const seenThisTick = new Set();
        for (const s of regionSpikes) {
            if (severityRank[s.severity] < minRank)
                continue;
            if (!subscribed(s.region))
                continue;
            const key = `${s.region}|${s.severity}|${Math.round(s.ratio)}`;
            seenThisTick.add(key);
            if (!prevAnnouncedSpikesRef.current.has(key)) {
                fresh.push(s);
            }
        }
        prevAnnouncedSpikesRef.current = seenThisTick;
        if (fresh.length === 0)
            return;
        const top = fresh[0];
        const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : "";
        setLiveAnnouncement(`${top.severity === "critical" ? "Critical" : "Warning"}: ` +
            `region ${top.region} spike — ${top.recentCount} events, ` +
            `${top.ratio.toFixed(1)}× baseline${extra}.`);
    }, [regionSpikes, alertSubs]);
    // Export accessors — separate ones for the two ExportMenus, each emitting
    // the columns + metadata an operator actually wants in the file.
    const activityExportColumns = React.useMemo(() => [
        {
            header: "Timestamp (ISO)",
            accessor: (a) => {
                const t = parseTimestamp(a.startedAt);
                return Number.isFinite(t) ? new Date(t).toISOString() : "";
            },
        },
        { header: "Activity ID", accessor: (a) => a.id },
        { header: "Action", accessor: (a) => a.action },
        { header: "Target", accessor: (a) => a.target },
        { header: "Status", accessor: (a) => a.status },
        { header: "Progress", accessor: (a) => { var _a; return (_a = a.progress) !== null && _a !== void 0 ? _a : ""; } },
        {
            header: "Completed (ISO)",
            accessor: (a) => {
                if (!a.completedAt)
                    return "";
                const t = parseTimestamp(a.completedAt);
                return Number.isFinite(t) ? new Date(t).toISOString() : "";
            },
        },
        { header: "Error", accessor: (a) => { var _a; return (_a = a.error) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Parent ID", accessor: (a) => { var _a; return (_a = a.parentId) !== null && _a !== void 0 ? _a : ""; } },
    ], []);
    const logExportColumns = React.useMemo(() => [
        {
            header: "Timestamp (ISO)",
            accessor: (l) => {
                const t = parseTimestamp(l.timestamp);
                return Number.isFinite(t) ? new Date(t).toISOString() : "";
            },
        },
        { header: "Agent", accessor: (l) => l.agent },
        { header: "Level", accessor: (l) => l.level },
        { header: "Message", accessor: (l) => l.message },
        {
            header: "Correlation ID",
            accessor: (l) => { var _a; return (_a = extractCorrelationId(l.message)) !== null && _a !== void 0 ? _a : ""; },
        },
        { header: "Details", accessor: (l) => safeStringify(l.details) },
    ], []);
    const combinedExportRows = React.useMemo(() => ({
        range,
        cutoffIso: new Date(cutoff).toISOString(),
        generatedAt: new Date().toISOString(),
        filters: {
            searchQuery: searchQuery || undefined,
            levels: selectedLevels.length > 0 ? selectedLevels : undefined,
            agents: selectedAgents.length > 0 ? selectedAgents : undefined,
            statuses: selectedStatuses.length > 0 ? selectedStatuses : undefined,
        },
        counts: {
            activities: filteredActivities.length,
            logs: filteredLogs.length,
        },
        activities: filteredActivities,
        logs: filteredLogs,
    }), [
        range,
        cutoff,
        searchQuery,
        selectedLevels,
        selectedAgents,
        selectedStatuses,
        filteredActivities,
        filteredLogs,
    ]);
    /** Combined CSV — activities and logs merged into one sheet. */
    const handleExportCombinedCsv = React.useCallback(() => {
        var _a, _b;
        const headers = [
            "kind",
            "timestamp_iso",
            "agent_or_action",
            "target_or_message",
            "status_or_level",
            "correlation_id",
            "details",
        ];
        const rows = [];
        for (const a of filteredActivities) {
            const t = parseTimestamp(a.startedAt);
            rows.push([
                "activity",
                Number.isFinite(t) ? new Date(t).toISOString() : "",
                a.action,
                a.target,
                a.status,
                a.id,
                (_a = a.error) !== null && _a !== void 0 ? _a : "",
            ]);
        }
        for (const l of filteredLogs) {
            const t = parseTimestamp(l.timestamp);
            rows.push([
                "log",
                Number.isFinite(t) ? new Date(t).toISOString() : "",
                l.agent,
                l.message,
                l.level,
                (_b = extractCorrelationId(l.message)) !== null && _b !== void 0 ? _b : "",
                safeStringify(l.details),
            ]);
        }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        downloadCsv(`monitoring-combined-${range}-${ts}.csv`, [headers, ...rows]);
    }, [filteredActivities, filteredLogs, range]);
    /** Combined JSON — preserves structure + metadata for machine consumption. */
    const handleExportCombinedJson = React.useCallback(() => {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        downloadJson(`monitoring-combined-${range}-${ts}.json`, combinedExportRows);
    }, [combinedExportRows, range]);
    /** Copy the current filtered log view as a single text blob — handy for
     *  pasting into a chat / issue when an export file is overkill. */
    const handleCopyLogs = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _d;
        const lines = filteredLogs.map((l) => {
            const t = parseTimestamp(l.timestamp);
            const iso = Number.isFinite(t) ? new Date(t).toISOString() : "—";
            return `${iso} [${l.agent}] ${l.level.toUpperCase().padEnd(5)} ${l.message}`;
        });
        const text = lines.join("\n");
        try {
            if (typeof navigator !== "undefined" &&
                ((_d = navigator.clipboard) === null || _d === void 0 ? void 0 : _d.writeText)) {
                yield navigator.clipboard.writeText(text);
            }
            else if (typeof document !== "undefined") {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.position = "absolute";
                ta.style.left = "-9999px";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
            }
        }
        catch (_e) {
            // best-effort; failures land in browser console
        }
    }), [filteredLogs]);
    // ---- Activity table columns ---------------------------------------------
    const activityColumns = React.useMemo(() => [
        {
            id: "time",
            header: "Time",
            cell: (a) => {
                const t = parseTimestamp(a.startedAt);
                const isNew = Number.isFinite(t) && t >= prevRefreshAtRef.current;
                if (!Number.isFinite(t)) {
                    return (React.createElement("span", { className: "font-mono text-2xs italic text-warning" }, "Unknown time"));
                }
                return (React.createElement("span", { className: cn("font-mono text-2xs tabular-nums text-muted-foreground/80", isNew && liveTail && "font-semibold text-info") },
                    new Date(t).toLocaleTimeString(),
                    isNew && liveTail && (React.createElement("span", { className: "ml-1 inline-block h-1.5 w-1.5 rounded-full bg-info align-middle", "aria-label": "New since last refresh" }))));
            },
            sort: (x, y) => parseTimestamp(x.startedAt) - parseTimestamp(y.startedAt),
            csv: (a) => {
                const t = parseTimestamp(a.startedAt);
                return Number.isFinite(t) ? new Date(t).toISOString() : "";
            },
            width: "w-32",
        },
        {
            id: "action",
            header: "Action",
            cell: (a) => (React.createElement("span", { className: "text-xs text-foreground/85" }, a.action)),
            sort: (x, y) => x.action.localeCompare(y.action),
            csv: (a) => a.action,
            width: "w-40",
        },
        {
            id: "target",
            header: "Target",
            cell: (a) => (React.createElement("span", { className: "block truncate text-xs text-muted-foreground", title: a.target }, a.target)),
            sort: (x, y) => x.target.localeCompare(y.target),
            csv: (a) => a.target,
        },
        {
            id: "status",
            header: "Status",
            cell: (a) => {
                var _a;
                return (React.createElement("span", { className: cn("inline-flex rounded-full bg-surface-sunken px-2 py-0.5 text-2xs font-semibold capitalize tabular-nums", (_a = ACTIVITY_STATUS_CLASSES[a.status]) !== null && _a !== void 0 ? _a : "text-muted-foreground") }, a.status));
            },
            sort: (x, y) => x.status.localeCompare(y.status),
            csv: (a) => a.status,
            width: "w-32",
        },
        {
            id: "id",
            header: "ID",
            cell: (a) => (React.createElement("span", { className: "group/copy inline-flex items-center gap-1.5" },
                React.createElement("span", { className: "block max-w-[140px] truncate font-mono text-2xs text-muted-foreground/80", title: a.id }, a.id),
                React.createElement(CopyButton, { value: a.id, ariaLabel: `Copy activity id ${a.id}` }))),
            sort: (x, y) => x.id.localeCompare(y.id),
            csv: (a) => a.id,
            defaultHidden: true,
            width: "w-44",
        },
        {
            id: "error",
            header: "Error",
            cell: (a) => a.error ? (React.createElement("span", { className: "block truncate text-2xs text-destructive/90", title: a.error }, a.error)) : (React.createElement("span", { className: "text-2xs text-muted-foreground/60" }, "\u2014")),
            sort: (x, y) => { var _a, _b; return ((_a = x.error) !== null && _a !== void 0 ? _a : "").localeCompare((_b = y.error) !== null && _b !== void 0 ? _b : ""); },
            csv: (a) => { var _a; return (_a = a.error) !== null && _a !== void 0 ? _a : ""; },
            defaultHidden: true,
        },
    ], [liveTail]);
    // ---- Log table columns --------------------------------------------------
    const logColumns = React.useMemo(() => [
        {
            id: "time",
            header: "Time",
            cell: (l) => {
                const t = parseTimestamp(l.timestamp);
                const isNew = Number.isFinite(t) && t >= prevRefreshAtRef.current;
                if (!Number.isFinite(t)) {
                    return (React.createElement("span", { className: "font-mono text-2xs italic text-warning" }, "Unknown time"));
                }
                return (React.createElement("span", { className: cn("font-mono text-2xs tabular-nums text-muted-foreground/80", isNew && liveTail && "font-semibold text-info") },
                    new Date(t).toLocaleTimeString(),
                    isNew && liveTail && (React.createElement("span", { className: "ml-1 inline-block h-1.5 w-1.5 rounded-full bg-info align-middle", "aria-label": "New since last refresh" }))));
            },
            sort: (x, y) => parseTimestamp(x.timestamp) - parseTimestamp(y.timestamp),
            csv: (l) => {
                const t = parseTimestamp(l.timestamp);
                return Number.isFinite(t) ? new Date(t).toISOString() : "";
            },
            width: "w-32",
        },
        {
            id: "level",
            header: "Level",
            cell: (l) => {
                var _a;
                const tone = (_a = LOG_LEVEL_CLASSES[l.level]) !== null && _a !== void 0 ? _a : LOG_LEVEL_CLASSES.info;
                return (React.createElement("span", { className: cn("inline-flex rounded-sm px-1.5 text-2xs font-semibold uppercase", tone.badge) }, l.level));
            },
            sort: (x, y) => x.level.localeCompare(y.level),
            csv: (l) => l.level,
            width: "w-20",
        },
        {
            id: "agent",
            header: "Agent",
            cell: (l) => (React.createElement("span", { className: "text-xs text-muted-foreground" },
                "[",
                l.agent,
                "]")),
            sort: (x, y) => x.agent.localeCompare(y.agent),
            csv: (l) => l.agent,
            width: "w-32",
        },
        {
            id: "message",
            header: "Message",
            cell: (l) => {
                var _a;
                const tone = (_a = LOG_LEVEL_CLASSES[l.level]) !== null && _a !== void 0 ? _a : LOG_LEVEL_CLASSES.info;
                const corr = extractCorrelationId(l.message);
                // When the message contains an explicit `[uuid]` chunk, render the
                // text with that fragment elided so the cell stays scannable, and
                // attach a CopyButton next to the row's correlation column instead.
                const displayMsg = corr
                    ? l.message.replace(`[${corr}]`, "").replace(/\s+/g, " ").trim()
                    : l.message;
                return (React.createElement("span", { className: cn("block truncate text-xs", tone.message), title: l.message }, displayMsg));
            },
            sort: (x, y) => x.message.localeCompare(y.message),
            csv: (l) => l.message,
        },
        {
            id: "correlation",
            header: "Correlation",
            cell: (l) => {
                const corr = extractCorrelationId(l.message);
                if (!corr) {
                    return React.createElement("span", { className: "text-2xs text-muted-foreground/60" }, "\u2014");
                }
                // Show only the first 8 characters of the UUID for compactness — the
                // full ID lands on the clipboard via the inline copy button.
                const short = corr.slice(0, 8);
                return (React.createElement(CopyableText, { value: corr, display: short, mono: true, ariaLabel: `Copy correlation id ${corr}`, alwaysVisibleButton: true }));
            },
            sort: (x, y) => {
                var _a, _b;
                return ((_a = extractCorrelationId(x.message)) !== null && _a !== void 0 ? _a : "").localeCompare((_b = extractCorrelationId(y.message)) !== null && _b !== void 0 ? _b : "");
            },
            csv: (l) => { var _a; return (_a = extractCorrelationId(l.message)) !== null && _a !== void 0 ? _a : ""; },
            width: "w-32",
        },
        {
            id: "details",
            header: "Details",
            cell: (l) => {
                const s = safeStringify(l.details, 200);
                if (!s)
                    return React.createElement("span", { className: "text-2xs text-muted-foreground/60" }, "\u2014");
                return (React.createElement("span", { className: "block truncate font-mono text-2xs text-muted-foreground/80", title: s }, s));
            },
            sort: (x, y) => safeStringify(x.details).localeCompare(safeStringify(y.details)),
            csv: (l) => safeStringify(l.details, 1000),
            defaultHidden: true,
        },
    ], [liveTail]);
    const autoRefreshLabel = autoRefresh && paused ? "Auto-refresh (paused)" : "Auto-refresh (30s)";
    const autoRefreshAria = autoRefresh
        ? paused
            ? "Auto-refresh paused while tab is hidden"
            : "Disable auto-refresh"
        : "Enable auto-refresh every 30 seconds";
    const rangeLabel = (_c = (_b = TIME_RANGES.find((r) => r.value === range)) === null || _b === void 0 ? void 0 : _b.label) !== null && _c !== void 0 ? _c : DEFAULT_RANGE;
    const lastRefreshedRel = formatRelativeTime(new Date(lastRefreshedAt));
    const hasFilter = searchQuery !== "" ||
        selectedLevels.length > 0 ||
        selectedAgents.length > 0 ||
        selectedStatuses.length > 0 ||
        selectedRegions.length > 0;
    // Stale-data signal — true when the operator has been looking at a frozen
    // snapshot for too long. Tied to a wall-clock tick so it updates without
    // requiring a refresh / re-render of the whole tree. Uses the persisted
    // staleSec threshold so each operator can dial in their own freshness
    // budget. Re-derive on a 5s heartbeat (cheap, no network).
    const staleThresholdMs = Math.max(10000, (alertThresholds.staleSec || DEFAULT_ALERT_THRESHOLDS.staleSec) * 1000);
    const [staleNow, setStaleNow] = React.useState(() => Date.now());
    useAbortableEffect((signal) => {
        const handle = window.setInterval(() => {
            if (signal.aborted)
                return;
            setStaleNow(Date.now());
        }, 5000);
        return () => window.clearInterval(handle);
    }, []);
    const dataAgeMs = Math.max(0, staleNow - lastRefreshedAt);
    const isStale = dataAgeMs >= staleThresholdMs;
    const isVeryStale = dataAgeMs >= STALE_DATA_THRESHOLD_MS;
    const activityFilteredOut = rangeCounts.actTotal - filteredActivities.length;
    const logFilteredOut = rangeCounts.logTotal - filteredLogs.length;
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4", "aria-label": "Monitoring page" },
        React.createElement("div", { className: "relative overflow-hidden rounded-xl border bg-card/50 p-6" },
            React.createElement(DotPattern, { fade: "top-left" }),
            React.createElement(Meteors, { count: 10, tone: "primary" }),
            React.createElement("div", { className: "relative z-10" },
                React.createElement(PageHeader, { title: "Monitoring", description: `Agent activity over the last ${rangeLabel} (refreshed ${lastRefreshedRel}). Press / to search.` },
                    React.createElement(HeartPulse, { className: "h-5 w-5 text-primary", "aria-hidden": true }),
                    React.createElement(Tabs, { value: range, onValueChange: handleRangeChange, "aria-label": "Time range" },
                        React.createElement(TabsList, { "aria-label": "Select time range" }, TIME_RANGES.map((r) => (React.createElement(TabsTrigger, { key: r.value, value: r.value }, r.label))))),
                    React.createElement(InfoTooltip, { content: "Selects the time window applied to the entire page \u2014 summary stats, sparklines, status chips, activities, and agent logs all clip to this range. Defaults to 24h.", ariaLabel: "Time range help" }),
                    React.createElement(StaleBadge, { lastRefreshedAt: lastRefreshedAt, paused: autoRefresh && paused }),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleManualRefresh, "aria-label": "Manually refresh monitoring data" },
                        React.createElement(RefreshCcw, { "aria-hidden": true }),
                        "Refresh"),
                    React.createElement(Button, { type: "button", variant: liveTail ? "default" : "outline", size: "sm", onClick: toggleLiveTail, "aria-pressed": liveTail, "aria-label": liveTail
                            ? "Disable live-tail markers"
                            : "Enable live-tail markers" },
                        liveTail ? (React.createElement(Pause, { "aria-hidden": true })) : (React.createElement(Play, { "aria-hidden": true })),
                        liveTail ? "Live" : "Tail"),
                    React.createElement(InfoTooltip, { content: "Live-tail flags rows newer than the previous refresh with a small blue dot so you can spot fresh events without scanning the whole list. Pair with auto-refresh for a Splunk-style follow mode.", ariaLabel: "Live-tail help" }),
                    React.createElement("div", { className: "flex items-center gap-2" },
                        React.createElement(Switch, { id: "monitoring-auto-refresh", checked: autoRefresh, onCheckedChange: (checked) => setAutoRefresh(checked), "aria-label": autoRefreshAria }),
                        React.createElement(Label, { htmlFor: "monitoring-auto-refresh", className: "cursor-pointer text-xs text-muted-foreground" }, autoRefreshLabel))))),
        refreshError && (React.createElement(ErrorState, { message: "Failed to refresh monitoring data.", detail: refreshError, onRetry: handleManualRefresh, size: "compact" })),
        (isStale || isVeryStale) && (React.createElement("div", { role: "alert", "aria-live": "assertive", className: cn("flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-xs", isVeryStale
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-warning/40 bg-warning/10 text-warning") },
            React.createElement("span", { className: "inline-flex items-center gap-2" },
                React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                React.createElement("span", { className: "font-semibold" }, isVeryStale ? "Data is more than 5 minutes old" : "Data may be stale"),
                React.createElement("span", { className: "text-muted-foreground" },
                    "\u00B7 last refreshed ",
                    Math.floor(dataAgeMs / 1000),
                    "s ago")),
            React.createElement(Button, { type: "button", variant: isVeryStale ? "default" : "outline", size: "sm", onClick: handleManualRefresh, "aria-label": "Refresh now to clear stale-data warning" },
                React.createElement(RefreshCcw, { "aria-hidden": true }),
                "Refresh now"))),
        React.createElement("section", { className: sectionClass, "aria-label": "Monitoring summary" },
            React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
                React.createElement("div", { className: "flex items-center gap-1" },
                    React.createElement("h2", { className: cn(sectionHeadingClass, "mb-0") }, "Summary"),
                    React.createElement(InfoTooltip, { content: "Stats reflect the rows currently visible after time range and filter chips are applied. The 'Last hour' column is fixed to a 1h window regardless of the selected range so it stays a stable signal.", ariaLabel: "Summary stats help" })),
                React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    "Trend across the last ",
                    rangeLabel)),
            refreshing ? (React.createElement(SkeletonLoader, { variant: "stat-bar" })) : (React.createElement("dl", { className: "relative grid grid-cols-2 gap-3 overflow-hidden rounded-xl sm:grid-cols-3 lg:grid-cols-7" },
                React.createElement(BorderBeam, { size: 200, duration: 8 }),
                React.createElement(StatCard, { label: "Activities", value: summary.activitiesCount, spark: sparklines.activities, tone: "info", status: summary.activitiesCount > 0 ? "active" : "idle", rangeLabel: rangeLabel }),
                React.createElement(StatCard, { label: "Running", value: summary.running, spark: sparklines.running, tone: "warning", status: summary.running > 0 ? "active" : "idle", rangeLabel: rangeLabel }),
                React.createElement(StatCard, { label: "Failed", value: summary.failed, spark: sparklines.failed, tone: "destructive", status: summary.failed > 0 ? "alert" : "ok", rangeLabel: rangeLabel }),
                React.createElement(StatCard, { label: "Errors", value: summary.errorLogs, spark: sparklines.errorLogs, tone: "destructive", 
                    // Operator-tunable: a card only flips to `alert` once the
                    // count crosses the persisted threshold. Defaults are 1 for
                    // errors and 10 for warnings — pre-2026 they were hard-coded
                    // to >0, which gave the eye no slack for noisy environments.
                    status: summary.errorLogs >= alertThresholds.errors
                        ? "alert"
                        : summary.errorLogs > 0
                            ? "active"
                            : "ok", rangeLabel: rangeLabel }),
                React.createElement(StatCard, { label: "Warnings", value: summary.warnLogs, spark: sparklines.warnLogs, tone: "warning", status: summary.warnLogs >= alertThresholds.warnings
                        ? "alert"
                        : summary.warnLogs > 0
                            ? "active"
                            : "ok", rangeLabel: rangeLabel }),
                React.createElement(SummaryStatItem, { label: React.createElement("span", { className: "inline-flex items-center gap-1" },
                        React.createElement(Clock, { className: "h-3 w-3", "aria-hidden": true }),
                        "Last hour acts"), value: summary.activitiesLastHr, tone: summary.activitiesLastHr > 0 ? "info" : "muted", hint: "rolling 1h", compact: true }),
                React.createElement(SummaryStatItem, { label: React.createElement("span", { className: "inline-flex items-center gap-1" },
                        React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true }),
                        "Last hour errs"), value: summary.errorsLastHr, tone: summary.errorsLastHr > 0 ? "destructive" : "muted", hint: "rolling 1h", compact: true })))),
        React.createElement("section", { className: cn(sectionClass, "sticky top-0 z-20 backdrop-blur supports-[backdrop-filter]:bg-card/85"), "aria-label": "Filter toolbar" },
            React.createElement("div", { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement("div", { className: "relative flex w-full max-w-md items-center" },
                        React.createElement(Search, { className: "pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
                        React.createElement(Input, { ref: searchInputRef, type: "search", placeholder: "Search message, agent, action, target, correlation ID, error\u2026 (press /)", value: searchInput, onChange: (e) => setSearchInput(e.target.value), className: "h-9 pl-8 pr-8", "aria-label": "Search monitoring entries" }),
                        searchInput && (React.createElement("button", { type: "button", onClick: () => setSearchInput(""), "aria-label": "Clear search", className: "absolute right-2 inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" },
                            React.createElement(X, { className: "h-3 w-3", "aria-hidden": true })))),
                    React.createElement(InfoTooltip, { content: React.createElement("div", { className: "space-y-1 text-xs" },
                            React.createElement("p", { className: "m-0" }, "Search matches across:"),
                            React.createElement("ul", { className: "m-0 ml-3 list-disc space-y-0.5" },
                                React.createElement("li", null, "Log message + agent + level"),
                                React.createElement("li", null, "Activity action + target + status + error"),
                                React.createElement("li", null, "Correlation IDs and activity IDs")),
                            React.createElement("p", { className: "m-0 text-muted-foreground" },
                                "Case-insensitive substring match. Press ",
                                React.createElement("kbd", { className: "rounded border bg-muted/30 px-1 font-mono" }, "/"),
                                " to focus.")), ariaLabel: "Search help" }),
                    React.createElement("span", { className: "mx-1 hidden h-5 w-px bg-border sm:inline-block", "aria-hidden": true }),
                    React.createElement(ExportMenu, { rows: filteredActivities, columns: activityExportColumns, filename: `monitoring-activities-${range}`, jsonMetadata: {
                            source: "AzureBatchManager.Monitoring",
                            kind: "activities",
                            range,
                            filters: {
                                searchQuery: searchQuery || undefined,
                                statuses: selectedStatuses.length > 0
                                    ? selectedStatuses
                                    : undefined,
                            },
                        }, label: "Activities", disabled: filteredActivities.length === 0 }),
                    React.createElement(ExportMenu, { rows: filteredLogs, columns: logExportColumns, filename: `monitoring-logs-${range}`, jsonMetadata: {
                            source: "AzureBatchManager.Monitoring",
                            kind: "logs",
                            range,
                            filters: {
                                searchQuery: searchQuery || undefined,
                                levels: selectedLevels.length > 0 ? selectedLevels : undefined,
                                agents: selectedAgents.length > 0 ? selectedAgents : undefined,
                            },
                        }, label: "Logs", disabled: filteredLogs.length === 0 }),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleExportCombinedCsv, disabled: filteredActivities.length === 0 && filteredLogs.length === 0, "aria-label": "Export combined activities + logs as CSV" }, "Combined CSV"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleExportCombinedJson, disabled: filteredActivities.length === 0 && filteredLogs.length === 0, "aria-label": "Export combined activities + logs as JSON" }, "Combined JSON"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleCopyLogs, disabled: filteredLogs.length === 0, "aria-label": "Copy filtered logs to clipboard" }, "Copy logs")),
                React.createElement("div", { className: "flex flex-wrap items-start gap-x-4 gap-y-2" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                        React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                            React.createElement(FilterIcon, { className: "h-3 w-3", "aria-hidden": true }),
                            "Level",
                            React.createElement(InfoTooltip, { size: 11, content: "Filter agent logs by severity. Selecting nothing shows all levels.", ariaLabel: "Level filter help" })),
                        LOG_LEVELS.map((lvl) => {
                            var _a;
                            // Icon is encoded via the colored chip + InlineLegend below,
                            // so we don't render a per-chip icon here. Tone color suffices.
                            const toneActive = lvl === "error"
                                ? "bg-destructive/15 text-destructive border-destructive/40"
                                : lvl === "warn"
                                    ? "bg-warning/15 text-warning border-warning/40"
                                    : "bg-primary/15 text-primary border-primary/40";
                            return (React.createElement(FilterChip, { key: lvl, active: selectedLevels.includes(lvl), count: rangeCounts.byLevel[lvl], onToggle: () => toggleLevel(lvl), toneActive: toneActive, label: lvl, ariaLabel: `${selectedLevels.includes(lvl) ? "Hide" : "Show"} level ${lvl} (${(_a = rangeCounts.byLevel[lvl]) !== null && _a !== void 0 ? _a : 0})` }));
                        }),
                        React.createElement(InlineLegend, { icons: [XCircle, AlertTriangle, InfoIcon] })),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                        React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                            React.createElement(Bug, { className: "h-3 w-3", "aria-hidden": true }),
                            "Agent",
                            React.createElement(InfoTooltip, { size: 11, content: "Filter logs by emitter agent. Selecting nothing shows all agents.", ariaLabel: "Agent filter help" })),
                        AGENT_NAMES.map((a) => {
                            var _a;
                            return (React.createElement(FilterChip, { key: a, active: selectedAgents.includes(a), count: rangeCounts.byAgent[a], onToggle: () => toggleAgent(a), label: a, ariaLabel: `${selectedAgents.includes(a) ? "Hide" : "Show"} agent ${a} (${(_a = rangeCounts.byAgent[a]) !== null && _a !== void 0 ? _a : 0})` }));
                        })),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                        React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                            React.createElement(ActivityIcon, { className: "h-3 w-3", "aria-hidden": true }),
                            "Status",
                            React.createElement(InfoTooltip, { size: 11, content: "Filter activities by lifecycle status. Selecting nothing shows all statuses.", ariaLabel: "Status filter help" })),
                        ACTIVITY_STATUSES.map((s) => {
                            var _a, _b, _c;
                            const tone = (_a = ACTIVITY_STATUS_CLASSES[s]) !== null && _a !== void 0 ? _a : "text-muted-foreground";
                            const active = selectedStatuses.includes(s);
                            return (React.createElement(FilterChip, { key: s, active: active, count: (_b = rangeCounts.byStatus[s]) !== null && _b !== void 0 ? _b : 0, onToggle: () => toggleStatus(s), toneActive: cn("bg-card border-primary/40", tone), label: s, ariaLabel: `${active ? "Hide" : "Show"} status ${s} (${(_c = rangeCounts.byStatus[s]) !== null && _c !== void 0 ? _c : 0})` }));
                        }))),
                hasFilter && (React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 border-t border-border pt-2", role: "group", "aria-label": "Active filters" },
                    React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Active filters:"),
                    searchQuery && (React.createElement(ActivePill, { label: `search: "${searchQuery}"`, onClear: () => setUrlState({ q: "" }), ariaLabel: "Clear search filter" })),
                    selectedLevels.map((lvl) => (React.createElement(ActivePill, { key: `lvl-${lvl}`, label: `level: ${lvl}`, onClear: () => toggleLevel(lvl), ariaLabel: `Clear ${lvl} level filter` }))),
                    selectedAgents.map((a) => (React.createElement(ActivePill, { key: `agt-${a}`, label: `agent: ${a}`, onClear: () => toggleAgent(a), ariaLabel: `Clear ${a} agent filter` }))),
                    selectedStatuses.map((s) => (React.createElement(ActivePill, { key: `st-${s}`, label: `status: ${s}`, onClear: () => toggleStatus(s), ariaLabel: `Clear ${s} status filter` }))),
                    selectedRegions.map((r) => (React.createElement(ActivePill, { key: `rg-${r}`, label: `region: ${r}`, onClear: () => toggleRegion(r), ariaLabel: `Clear ${r} region filter` }))),
                    React.createElement("button", { type: "button", onClick: handleClearFilters, className: "ml-auto text-2xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" }, "Clear all"))),
                React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-2xs text-muted-foreground" },
                    React.createElement("div", { className: "inline-flex items-center gap-3" },
                        React.createElement("span", { className: "inline-flex items-center gap-1" },
                            React.createElement(CheckCircle2, { className: "h-3 w-3 text-success", "aria-hidden": true }),
                            "Activities:",
                            " ",
                            React.createElement("strong", { className: "font-semibold text-foreground tabular-nums" }, formatNumber(filteredActivities.length)),
                            " / ",
                            React.createElement("span", { className: "tabular-nums" }, formatNumber(rangeCounts.actTotal)),
                            activityFilteredOut > 0 && (React.createElement("span", { className: "text-warning" },
                                " ",
                                "(",
                                formatNumber(activityFilteredOut),
                                " hidden)"))),
                        React.createElement("span", { className: "inline-flex items-center gap-1" },
                            React.createElement(ActivityIcon, { className: "h-3 w-3 text-primary", "aria-hidden": true }),
                            "Logs:",
                            " ",
                            React.createElement("strong", { className: "font-semibold text-foreground tabular-nums" }, formatNumber(filteredLogs.length)),
                            " / ",
                            React.createElement("span", { className: "tabular-nums" }, formatNumber(rangeCounts.logTotal)),
                            logFilteredOut > 0 && (React.createElement("span", { className: "text-warning" },
                                " ",
                                "(",
                                formatNumber(logFilteredOut),
                                " hidden)")))),
                    liveTail && (React.createElement("span", { className: "inline-flex items-center gap-1 text-info" },
                        React.createElement("span", { className: "inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-info motion-reduce:animate-none", "aria-hidden": true }),
                        "Live-tail markers active"))))),
        React.createElement("section", { className: sectionClass, "aria-label": "Agent status" },
            React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
                React.createElement("div", { className: "flex items-center gap-1" },
                    React.createElement("h2", { className: cn(sectionHeadingClass, "mb-0") }, "Agent Status"),
                    React.createElement(InfoTooltip, { content: "Each chip shows the agent's current status with a 24-bucket log activity sparkline. Click a chip to filter the log table to that agent. Hover for a richer tooltip.", ariaLabel: "Agent status help" })),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Hover an agent to see its log trend \u00B7 click to filter")),
            refreshing ? (React.createElement(SkeletonLoader, { variant: "list", rows: 3 })) : (React.createElement("div", { className: "flex flex-wrap gap-2" }, AGENT_NAMES.map((name) => {
                var _a;
                const status = (_a = state.agentStatuses[name]) !== null && _a !== void 0 ? _a : "idle";
                const tone = AGENT_STATUS_CLASSES[status];
                const meta = agentSparklines[name];
                const sparkTone = meta.errors > 0
                    ? "destructive"
                    : status === "running"
                        ? "primary"
                        : status === "completed"
                            ? "success"
                            : "muted";
                const isFiltered = selectedAgents.includes(name);
                return (React.createElement(Tooltip, { key: name },
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("button", { type: "button", role: "status", "aria-label": `Agent ${name}: ${status}; ${meta.total} log entries, ${meta.errors} errors. ${isFiltered ? "Click to remove from agent filter" : "Click to add to agent filter"}`, "aria-pressed": isFiltered, onClick: () => toggleAgent(name), className: cn("group flex items-center gap-2 rounded-md border border-transparent px-3 py-1.5", "transition-all duration-200 ease-out motion-reduce:transition-none", "hover:border-border hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tone.container, isFiltered && "ring-2 ring-primary/60") },
                            React.createElement("span", { "aria-hidden": true, className: cn("h-2 w-2 rounded-full transition-transform duration-200 group-hover:scale-110", tone.dot, status === "running" && tone.glow, status === "running" &&
                                    "animate-pulse motion-reduce:animate-none") }),
                            React.createElement("span", { className: cn("text-xs font-semibold capitalize", tone.text) }, name),
                            React.createElement(Sparkline, { data: meta.spark, width: 48, height: 14, tone: sparkTone, strokeWidth: 1.25, ariaLabel: `Log activity trend for ${name}` }),
                            React.createElement("span", { className: cn("rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider", "bg-card/70", tone.text) }, status))),
                    React.createElement(TooltipContent, { side: "top" },
                        React.createElement("div", { className: "flex flex-col gap-0.5 text-2xs" },
                            React.createElement("span", { className: "font-semibold capitalize text-foreground" },
                                name,
                                " \u00B7 ",
                                status),
                            React.createElement("span", { className: "text-muted-foreground" },
                                formatNumber(meta.total),
                                " log",
                                meta.total === 1 ? "" : "s",
                                " in last ",
                                rangeLabel),
                            meta.errors > 0 && (React.createElement("span", { className: "text-destructive" },
                                formatNumber(meta.errors),
                                " error",
                                meta.errors === 1 ? "" : "s")),
                            React.createElement("span", { className: "text-muted-foreground/80" }, isFiltered ? "Click to clear filter" : "Click to filter logs by this agent")))));
            })))),
        React.createElement("section", { className: sectionClass, "aria-label": "Region health" },
            React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
                React.createElement("div", { className: "flex items-center gap-1" },
                    React.createElement("h2", { className: cn(sectionHeadingClass, "mb-0") },
                        React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                            React.createElement(Globe, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                            "Region Health")),
                    React.createElement(InfoTooltip, { content: "Per-region account health \u2014 healthy bar = `created` provisioning state, total bar = all accounts in that region. Click a region to drill into the Azure Accounts page filtered to that region.", ariaLabel: "Region health help" })),
                React.createElement("div", { className: "flex items-center gap-3 text-2xs text-muted-foreground" },
                    React.createElement("span", null,
                        regionHealth.length,
                        " regions"),
                    selectedRegions.length > 0 && (React.createElement("span", { className: "inline-flex items-center gap-1 text-primary" },
                        React.createElement(FilterIcon, { className: "h-3 w-3", "aria-hidden": true }),
                        selectedRegions.length,
                        " active")))),
            refreshing ? (React.createElement(SkeletonLoader, { variant: "list", rows: 4 })) : (React.createElement("div", { className: "flex flex-col gap-3" },
                React.createElement(RegionHealthChart, { regions: regionHealth }),
                knownRegions.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 border-t border-border pt-3", role: "group", "aria-label": "Region filter" },
                    React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                        React.createElement(FilterIcon, { className: "h-3 w-3", "aria-hidden": true }),
                        "Filter / drill-down",
                        React.createElement(InfoTooltip, { size: 11, content: "Click a chip to toggle the region filter (applied to activities + logs). Open the arrow to jump to Azure Accounts pre-filtered to that region.", ariaLabel: "Region filter help" })),
                    knownRegions.map((r) => {
                        const active = selectedRegions.includes(r);
                        return (React.createElement("span", { key: r, className: "inline-flex items-center" },
                            React.createElement(FilterChip, { active: active, onToggle: () => toggleRegion(r), label: r, ariaLabel: `${active ? "Hide" : "Show"} region ${r}` }),
                            React.createElement("button", { type: "button", onClick: () => handleRegionDrillDown(r), "aria-label": `Drill into Azure Accounts filtered to ${r}`, className: "ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" },
                                React.createElement(ChevronRight, { className: "h-3 w-3", "aria-hidden": true }))));
                    })))))),
        React.createElement("section", { className: sectionClass, "aria-label": "Anomaly detectors" },
            React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
                React.createElement("div", { className: "flex items-center gap-1" },
                    React.createElement("h2", { className: cn(sectionHeadingClass, "mb-0") },
                        React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                            React.createElement(Flame, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                            "Anomaly Detectors")),
                    React.createElement(InfoTooltip, { content: React.createElement("div", { className: "space-y-1 text-xs" },
                            React.createElement("p", { className: "m-0 font-semibold" }, "Two detectors, both client-side:"),
                            React.createElement("ul", { className: "m-0 ml-3 list-disc space-y-0.5" },
                                React.createElement("li", null,
                                    React.createElement("strong", null, "Region spikes"),
                                    " \u2014 5-min sliding window over activities + logs; flags regions whose recent volume is >3\u00D7 the prior baseline. Corpus: ",
                                    React.createElement("code", null, "_analysis_netspi.md"),
                                    " \u00A7I."),
                                React.createElement("li", null,
                                    React.createElement("strong", null, "Blind spots"),
                                    " \u2014 regions with provisioned accounts but no logs. Corpus: ",
                                    React.createElement("code", null, "_analysis_defender_view.md"),
                                    ".")),
                            React.createElement("p", { className: "m-0 text-muted-foreground" },
                                "All thresholds are constants in ",
                                React.createElement("code", null, "monitoring/detectors.ts"),
                                ".")), ariaLabel: "Anomaly detector help" })),
                React.createElement("div", { className: "flex items-center gap-3 text-2xs text-muted-foreground" },
                    React.createElement("span", { className: "inline-flex items-center gap-1" },
                        React.createElement(Flame, { className: "h-3 w-3 text-warning", "aria-hidden": true }),
                        regionSpikes.length,
                        " spike",
                        regionSpikes.length === 1 ? "" : "s"),
                    React.createElement("span", { className: "inline-flex items-center gap-1" },
                        React.createElement(EyeOff, { className: "h-3 w-3 text-destructive", "aria-hidden": true }),
                        blindSpots.length,
                        " blind spot",
                        blindSpots.length === 1 ? "" : "s"))),
            React.createElement("p", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only" }, liveAnnouncement),
            React.createElement("div", { className: "grid gap-3 lg:grid-cols-2" },
                React.createElement("div", { className: "rounded-md border border-border bg-card/40 p-3" },
                    React.createElement("h3", { className: "mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-foreground" },
                        React.createElement(Flame, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true }),
                        "Region spikes (",
                        Math.round(SPIKE_WINDOW_MS / 60000),
                        "m window)"),
                    regionSpikes.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "No regions exceeding baseline. Quiet across the fleet.")) : (React.createElement("ul", { className: "m-0 flex flex-col gap-1.5 p-0" }, regionSpikes.slice(0, 8).map((s) => {
                        const baseline = regionBaselines[s.region];
                        const verdict = evaluateRegion(s.region, s.recentCount, baseline);
                        const tone = s.severity === "critical"
                            ? "border-destructive/50 bg-destructive/10 text-destructive"
                            : s.severity === "warning"
                                ? "border-warning/50 bg-warning/10 text-warning"
                                : "border-border bg-card/60 text-foreground/80";
                        return (React.createElement("li", { key: s.region, className: "m-0 list-none" },
                            React.createElement("button", { type: "button", onClick: () => toggleRegion(s.region), "aria-pressed": selectedRegions.includes(s.region), className: cn("flex w-full items-center justify-between gap-2 rounded-sm border px-2 py-1 text-left text-2xs", "transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", tone) },
                                React.createElement("span", { className: "flex items-center gap-2" },
                                    React.createElement("span", { className: cn("inline-block h-1.5 w-1.5 rounded-full", s.severity === "critical"
                                            ? "bg-destructive animate-pulse motion-reduce:animate-none"
                                            : s.severity === "warning"
                                                ? "bg-warning"
                                                : "bg-muted-foreground"), "aria-hidden": true }),
                                    React.createElement("strong", { className: "font-semibold uppercase tracking-wide" }, s.region),
                                    React.createElement("span", { className: "text-foreground/70" },
                                        s.recentCount,
                                        " evt \u00B7 ",
                                        s.ratio.toFixed(1),
                                        "\u00D7")),
                                React.createElement("span", { className: "text-[10px] uppercase text-muted-foreground" }, verdict.status === "learning"
                                    ? "learning"
                                    : verdict.status)),
                            React.createElement("p", { className: "m-0 pl-4 pt-0.5 text-[10px] text-muted-foreground/80" }, s.reason)));
                    })))),
                React.createElement("div", { className: "rounded-md border border-border bg-card/40 p-3" },
                    React.createElement("h3", { className: "mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-foreground" },
                        React.createElement(EyeOff, { className: "h-3.5 w-3.5 text-destructive", "aria-hidden": true }),
                        "Monitoring blind spots"),
                    blindSpots.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Every region with accounts is emitting logs. Coverage looks complete.")) : (React.createElement("ul", { className: "m-0 flex flex-col gap-1.5 p-0" }, blindSpots.slice(0, 8).map((b) => {
                        const tone = b.dark
                            ? "border-destructive/50 bg-destructive/10 text-destructive"
                            : "border-warning/50 bg-warning/10 text-warning";
                        return (React.createElement("li", { key: b.region, className: "m-0 list-none" },
                            React.createElement("button", { type: "button", onClick: () => handleRegionDrillDown(b.region), "aria-label": `Drill into accounts for ${b.region}`, className: cn("flex w-full items-center justify-between gap-2 rounded-sm border px-2 py-1 text-left text-2xs", "transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", tone) },
                                React.createElement("span", { className: "flex items-center gap-2" },
                                    React.createElement(EyeOff, { className: cn("h-3 w-3", b.dark ? "text-destructive" : "text-warning"), "aria-hidden": true }),
                                    React.createElement("strong", { className: "font-semibold uppercase tracking-wide" }, b.region),
                                    React.createElement("span", { className: "text-foreground/70" },
                                        b.accountCount,
                                        " acct \u00B7 ",
                                        b.logCount,
                                        " log",
                                        b.logCount === 1 ? "" : "s")),
                                React.createElement("span", { className: "text-[10px] uppercase text-muted-foreground" }, b.dark ? "dark" : "thin")),
                            React.createElement("p", { className: "m-0 pl-4 pt-0.5 text-[10px] text-muted-foreground/80" }, b.reason)));
                    }))))),
            heatmapRegions.length > 0 && (React.createElement("div", { className: "mt-3 rounded-md border border-border bg-card/40 p-3" },
                React.createElement("h3", { className: "mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-foreground" },
                    React.createElement(BarChart3, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true }),
                    "Region \u00D7 agent heatmap",
                    React.createElement(InfoTooltip, { size: 11, content: "Cell intensity = log lines for that (region, agent) pair in the visible window. Red shading = errors present. Click a cell to filter both.", ariaLabel: "Heatmap help" })),
                React.createElement(RegionAgentHeatmap, { cells: heatmapCells, regions: heatmapRegions, agents: AGENT_NAMES, selectedRegion: selectedRegions.length === 1 ? selectedRegions[0] : null, onCellClick: (region, agent) => {
                        if (!selectedRegions.includes(region)) {
                            toggleRegion(region);
                        }
                        if (!selectedAgents.includes(agent)) {
                            toggleAgent(agent);
                        }
                    } })))),
        React.createElement("section", { className: sectionClass, "aria-label": "Alert thresholds" },
            React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
                React.createElement("div", { className: "flex items-center gap-1" },
                    React.createElement("h2", { className: cn(sectionHeadingClass, "mb-0") },
                        React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                            React.createElement(BellRing, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                            "Alert Thresholds")),
                    React.createElement(InfoTooltip, { content: "Tunes when summary cards flip to the destructive 'Attention' pill. Stored locally per browser (synced across tabs) \u2014 has no server-side effect.", ariaLabel: "Alert threshold help" })),
                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: handleResetThresholds, "aria-label": "Reset alert thresholds to defaults" }, "Reset to defaults")),
            React.createElement("div", { className: "grid gap-3 sm:grid-cols-3" },
                React.createElement(ThresholdField, { id: "thr-errors", label: "Errors", description: "Errors count to trigger alert", value: alertThresholds.errors, onChange: (v) => handleThresholdChange({ errors: v }) }),
                React.createElement(ThresholdField, { id: "thr-warnings", label: "Warnings", description: "Warnings count to trigger alert", value: alertThresholds.warnings, onChange: (v) => handleThresholdChange({ warnings: v }) }),
                React.createElement(ThresholdField, { id: "thr-stale", label: "Stale (seconds)", description: "Age before stale banner shows", value: alertThresholds.staleSec, onChange: (v) => handleThresholdChange({ staleSec: v }), min: 10 }))),
        React.createElement("section", { className: sectionClass, "aria-label": "Alert subscriptions" },
            React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
                React.createElement("div", { className: "flex items-center gap-1" },
                    React.createElement("h2", { className: cn(sectionHeadingClass, "mb-0") },
                        React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                            React.createElement(Shield, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                            "Alert Subscriptions")),
                    React.createElement(InfoTooltip, { content: "Region-spike events that match these subscriptions are announced via an aria-live region for screen readers. Severity filter sets the minimum band that fires.", ariaLabel: "Alert subscriptions help" })),
                React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    alertSubs.allRegions
                        ? "all regions"
                        : `${alertSubs.regions.length} subscribed`,
                    " · min ",
                    alertSubs.minSeverity)),
            React.createElement("div", { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-wrap items-center gap-3" },
                    React.createElement("label", { className: "inline-flex items-center gap-2 text-xs" },
                        React.createElement(Switch, { id: "alert-subs-all", checked: alertSubs.allRegions, onCheckedChange: handleSubsToggleAllRegions, "aria-label": "Subscribe to every region" }),
                        React.createElement("span", { className: "font-medium" }, "Alert on every region")),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Off = only the explicitly-subscribed regions below trigger announcements.")),
                React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                    React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                        React.createElement(FilterIcon, { className: "h-3 w-3", "aria-hidden": true }),
                        "Min severity"),
                    ["info", "warning", "critical"].map((sev) => {
                        const active = alertSubs.minSeverity === sev;
                        const tone = sev === "critical"
                            ? "bg-destructive/15 text-destructive border-destructive/40"
                            : sev === "warning"
                                ? "bg-warning/15 text-warning border-warning/40"
                                : "bg-primary/15 text-primary border-primary/40";
                        return (React.createElement(FilterChip, { key: sev, active: active, onToggle: () => handleSubsSeverityChange(sev), label: sev, toneActive: tone, ariaLabel: `Set min severity to ${sev}` }));
                    })),
                !alertSubs.allRegions && knownRegions.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 border-t border-border pt-2", role: "group", "aria-label": "Subscribed regions" },
                    React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                        React.createElement(BellRing, { className: "h-3 w-3", "aria-hidden": true }),
                        "Subscribed regions"),
                    knownRegions.map((r) => (React.createElement(FilterChip, { key: r, active: alertSubs.regions.includes(r), onToggle: () => handleSubsToggleRegion(r), label: r, ariaLabel: `${alertSubs.regions.includes(r) ? "Unsubscribe from" : "Subscribe to"} ${r}` }))))))),
        React.createElement(ViewPresetsSection, { presets: viewPresets, max: VIEW_PRESETS_MAX, onSave: handleSavePreset, onApply: handleApplyPreset, onDelete: handleDeletePreset }),
        React.createElement("section", { className: sectionClass, "aria-label": "Keyboard shortcuts" },
            React.createElement("details", { className: "text-xs" },
                React.createElement("summary", { className: "cursor-pointer font-semibold text-muted-foreground" }, "Keyboard shortcuts"),
                React.createElement("ul", { className: "m-0 mt-2 grid grid-cols-1 gap-1 pl-2 sm:grid-cols-2" },
                    React.createElement("li", { className: "text-2xs text-muted-foreground" },
                        React.createElement("kbd", { className: "rounded border bg-muted/30 px-1 font-mono" }, "/"),
                        " ",
                        "focus the search field"),
                    React.createElement("li", { className: "text-2xs text-muted-foreground" },
                        React.createElement("kbd", { className: "rounded border bg-muted/30 px-1 font-mono" }, "1"),
                        "\u2026",
                        React.createElement("kbd", { className: "rounded border bg-muted/30 px-1 font-mono" }, "9"),
                        " ",
                        "toggle the matching region filter"),
                    React.createElement("li", { className: "text-2xs text-muted-foreground" }, "Digits map to the first nine regions in the Region Health panel (alphabetical).")))),
        React.createElement("section", { className: sectionClass, "aria-label": "Recent activity" },
            React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
                React.createElement("h2", { className: cn(sectionHeadingClass, "mb-0") }, "Recent Activity"),
                React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    formatNumber(filteredActivities.length),
                    " shown")),
            refreshing ? (React.createElement(SkeletonLoader, { variant: "table", rows: 5, columns: 4 })) : (React.createElement(DataTable, { tableId: "monitoring-activities", rows: filteredActivities, columns: activityColumns, rowKey: (a) => a.id, csvFileName: `monitoring-activities-${range}.csv`, empty: React.createElement(EmptyState, { icon: BarChart3, title: hasFilter
                        ? "No activity matches the current filter"
                        : "No activity recorded", description: hasFilter
                        ? "Try clearing filters or widening the time range."
                        : `No activity in the last ${rangeLabel}. Activities will appear here as operations are performed.` }), initialSort: { column: "time", direction: "desc" } }))),
        React.createElement("section", { className: sectionClass, "aria-label": "Agent logs" },
            React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
                React.createElement("h2", { className: cn(sectionHeadingClass, "mb-0") }, "Agent Logs"),
                React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    formatNumber(filteredLogs.length),
                    " shown")),
            refreshing ? (React.createElement(SkeletonLoader, { variant: "table", rows: 6, columns: 4 })) : (React.createElement(DataTable, { tableId: "monitoring-logs", rows: filteredLogs, columns: logColumns, rowKey: (l) => {
                    var _a;
                    // Collisions are theoretically possible if two identical lines
                    // land in the same millisecond — fall back to the full message
                    // hash via slice so React's reconciliation stays stable.
                    return `${l.timestamp}|${l.agent}|${l.level}|${(_a = extractCorrelationId(l.message)) !== null && _a !== void 0 ? _a : `${l.message.length}:${l.message.slice(0, 48)}`}`;
                }, csvFileName: `monitoring-logs-${range}.csv`, empty: React.createElement(EmptyState, { icon: FilterIcon, title: hasFilter
                        ? "No logs match the current filter"
                        : "No logs yet", description: hasFilter
                        ? "Try clearing filters or widening the time range."
                        : `No agent log entries in the last ${rangeLabel}.` }), initialSort: { column: "time", direction: "desc" } })))));
};
const ThresholdField = ({ id, label, description, value, min = 0, max = 100000, onChange, }) => {
    // Local string state so partial typing ("12") doesn't immediately commit
    // (which would also persist the noise to localStorage on every keystroke).
    // We commit on blur or Enter; intermediate values stay in the input but
    // not in the persisted blob.
    const [local, setLocal] = React.useState(() => String(value));
    React.useEffect(() => {
        setLocal(String(value));
    }, [value]);
    const commit = React.useCallback(() => {
        const parsed = Number.parseInt(local, 10);
        if (Number.isFinite(parsed)) {
            const clamped = Math.max(min, Math.min(max, parsed));
            if (clamped !== value)
                onChange(clamped);
            setLocal(String(clamped));
        }
        else {
            // Reject garbage by snapping back to the committed value.
            setLocal(String(value));
        }
    }, [local, min, max, value, onChange]);
    return (React.createElement("div", { className: "flex flex-col gap-1" },
        React.createElement(Label, { htmlFor: id, className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, label),
        React.createElement(Input, { id: id, type: "number", inputMode: "numeric", min: min, max: max, value: local, onChange: (e) => setLocal(e.target.value), onBlur: commit, onKeyDown: (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    commit();
                    e.target.blur();
                }
                else if (e.key === "Escape") {
                    setLocal(String(value));
                    e.target.blur();
                }
            }, className: "h-8 font-mono text-xs tabular-nums", "aria-describedby": `${id}-desc` }),
        React.createElement("span", { id: `${id}-desc`, className: "text-2xs text-muted-foreground" }, description)));
};
const ViewPresetsSection = ({ presets, max, onSave, onApply, onDelete, }) => {
    const [name, setName] = React.useState("");
    const commit = React.useCallback(() => {
        const trimmed = name.trim();
        if (!trimmed)
            return;
        onSave(trimmed);
        setName("");
    }, [name, onSave]);
    const atCapacity = presets.length >= max;
    return (React.createElement("section", { className: sectionClass, "aria-label": "View presets" },
        React.createElement("div", { className: "mb-3 flex items-baseline justify-between gap-2" },
            React.createElement("div", { className: "flex items-center gap-1" },
                React.createElement("h2", { className: cn(sectionHeadingClass, "mb-0") },
                    React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                        React.createElement(Bookmark, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                        "View Presets")),
                React.createElement(InfoTooltip, { content: "Save the current filter combo (range + search + level/agent/status/region + live-tail) under a name. Capped at 12 entries per browser. Saving an existing name overwrites it.", ariaLabel: "View presets help" })),
            React.createElement("span", { className: "text-2xs text-muted-foreground" },
                presets.length,
                " / ",
                max)),
        React.createElement("div", { className: "flex flex-col gap-3" },
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                React.createElement(Input, { type: "text", placeholder: "Preset name (e.g. noisy-prod-eastus)", value: name, onChange: (e) => setName(e.target.value), onKeyDown: (e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            commit();
                        }
                        else if (e.key === "Escape") {
                            setName("");
                        }
                    }, maxLength: 32, "aria-label": "Preset name", className: "h-9 max-w-xs" }),
                React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: commit, disabled: !name.trim() || atCapacity, "aria-label": "Save current view as a preset" },
                    React.createElement(Save, { "aria-hidden": true }),
                    "Save preset"),
                atCapacity && (React.createElement("span", { className: "text-2xs text-warning" }, "At capacity \u2014 delete a preset to make room."))),
            presets.length === 0 ? (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "No presets saved yet. Set the filters you want to remember, give it a name, click Save.")) : (React.createElement("ul", { className: "m-0 flex flex-wrap gap-1.5 p-0" }, presets.map((p) => (React.createElement("li", { key: p.name, className: "m-0 inline-flex items-center gap-0.5 rounded-full border border-border bg-card/60 px-1.5 py-0.5 text-2xs" },
                React.createElement("button", { type: "button", onClick: () => onApply(p.name), "aria-label": `Apply preset ${p.name}`, title: `Apply preset · range=${p.range} q="${p.q}" levels=[${p.levels}] agents=[${p.agents}] statuses=[${p.statuses}] regions=[${p.region}] live=${p.live}`, className: "rounded-full px-1.5 py-0.5 font-semibold uppercase tracking-wider text-foreground hover:bg-primary/15 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" }, p.name),
                React.createElement("button", { type: "button", onClick: () => onDelete(p.name), "aria-label": `Delete preset ${p.name}`, className: "inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive" },
                    React.createElement(Trash2, { className: "h-2.5 w-2.5", "aria-hidden": true }))))))))));
};
const InlineLegend = ({ icons }) => (React.createElement("span", { className: "ml-1 inline-flex items-center gap-0.5 text-muted-foreground/40", "aria-hidden": true }, icons.map((Icon, i) => (React.createElement(Icon, { key: i, className: "h-2.5 w-2.5", "aria-hidden": true })))));
const STAT_TONE_CLASS = {
    info: {
        value: "text-info",
        pill: "bg-info/15 text-info",
        ring: "hover:ring-info/30",
    },
    warning: {
        value: "text-warning",
        pill: "bg-warning/15 text-warning",
        ring: "hover:ring-warning/30",
    },
    destructive: {
        value: "text-destructive",
        pill: "bg-destructive/15 text-destructive",
        ring: "hover:ring-destructive/30",
    },
    success: {
        value: "text-success",
        pill: "bg-success/15 text-success",
        ring: "hover:ring-success/30",
    },
    primary: {
        value: "text-primary",
        pill: "bg-primary/15 text-primary",
        ring: "hover:ring-primary/30",
    },
};
const STAT_STATUS_LABEL = {
    ok: "OK",
    active: "Active",
    alert: "Attention",
    idle: "Idle",
};
const STAT_STATUS_TONE = {
    ok: "success",
    active: "primary",
    alert: "destructive",
    idle: "info",
};
const StatCard = ({ label, value, spark, tone, status, rangeLabel, }) => {
    const toneCls = STAT_TONE_CLASS[tone];
    const statusToneCls = STAT_TONE_CLASS[STAT_STATUS_TONE[status]];
    const sparkTone = tone;
    // Active cards (non-zero counts) glow softly, communicating "data is
    // flowing here right now". Idle cards stay quiet so the active ones
    // visibly stand out. Tone routes the .live-glow-bar's color via the
    // --live-tone CSS var.
    const isActive = status === "active";
    const liveToneVar = tone === "info"
        ? "var(--info, var(--primary))"
        : tone === "warning"
            ? "var(--warning)"
            : tone === "success"
                ? "var(--success)"
                : tone === "destructive"
                    ? "var(--destructive)"
                    : "var(--primary)";
    return (React.createElement("div", { className: cn("group relative flex flex-col gap-1 rounded-md border border-border bg-card/60 p-2.5", "transition-all duration-200 ease-out motion-reduce:transition-none", "hover:bg-card hover:shadow-sm hover:ring-1", toneCls.ring, isActive && "live-glow-bar"), style: isActive
            ? { ["--live-tone"]: liveToneVar }
            : undefined },
        React.createElement("div", { className: "flex items-center justify-between gap-2" },
            React.createElement("dt", { className: "text-2xs uppercase tracking-wide text-muted-foreground" }, label),
            React.createElement("span", { className: cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", statusToneCls.pill), "aria-label": `${label} status: ${STAT_STATUS_LABEL[status]}` },
                isActive && (React.createElement("span", { className: "live-pulse-dot", style: { ["--live-tone"]: liveToneVar }, "aria-hidden": "true" })),
                STAT_STATUS_LABEL[status])),
        React.createElement("div", { className: "flex items-end justify-between gap-2" },
            React.createElement("dd", { "aria-live": "polite", className: cn("text-xl font-semibold leading-none tabular-nums", toneCls.value) },
                React.createElement(NumberTicker, { value: value })),
            React.createElement(Sparkline, { data: spark, width: 72, height: 20, tone: sparkTone, ariaLabel: `${label} trend over the last ${rangeLabel}` }))));
};
export const MonitoringPage = (props) => (React.createElement(ErrorBoundary, null,
    React.createElement(MonitoringPageInner, Object.assign({}, props))));
//# sourceMappingURL=monitoring-page.js.map