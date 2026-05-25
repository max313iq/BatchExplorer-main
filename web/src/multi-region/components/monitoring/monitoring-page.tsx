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
import {
  Activity as ActivityIcon,
  AlertTriangle,
  BarChart3,
  Bug,
  CheckCircle2,
  Clock,
  Filter as FilterIcon,
  HeartPulse,
  Info as InfoIcon,
  Pause,
  Play,
  RefreshCcw,
  Search,
  X,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorState } from "@/components/ui/error-state";
import { Sparkline, type SparklineTone } from "@/components/ui/charts/sparkline";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  cn,
  downloadCsv,
  downloadJson,
  formatNumber,
  formatRelativeTime,
} from "@/lib/utils";

import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import {
  Activity,
  ActivityStatus,
  AgentLogEntry,
  AgentName,
  AgentStatus,
} from "../../store/store-types";
import { useUrlState } from "../../hooks/use-url-state";
import { DataTable, type DataTableColumn } from "../shared/enhanced-table";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import {
  BorderBeam,
  DotPattern,
  Meteors,
  NumberTicker,
} from "@/components/ui/effects";

/* ------------------------------------------------------------------ */
/*  Types & constants                                                  */
/* ------------------------------------------------------------------ */

type TimeRange = "1h" | "24h" | "7d" | "30d";
type LogLevel = AgentLogEntry["level"];

const TIME_RANGES: ReadonlyArray<{ value: TimeRange; label: string }> = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const TIME_RANGE_MS: Record<TimeRange, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const DEFAULT_RANGE: TimeRange = "24h";

const AGENT_NAMES: ReadonlyArray<AgentName> = [
  "orchestrator",
  "provisioner",
  "quota",
  "monitor",
  "filter",
  "pool",
  "node",
];

const LOG_LEVELS: ReadonlyArray<LogLevel> = ["info", "warn", "error"];

const ACTIVITY_STATUSES: ReadonlyArray<ActivityStatus> = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "paused",
  "cancelling",
];

const AGENT_STATUS_CLASSES: Record<
  AgentStatus,
  { container: string; dot: string; text: string; glow: string }
> = {
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

const ACTIVITY_STATUS_CLASSES: Record<string, string> = {
  pending: "text-muted-foreground",
  running: "text-primary",
  completed: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
  paused: "text-warning",
  cancelling: "text-warning",
};

const LOG_LEVEL_CLASSES: Record<string, { badge: string; message: string }> = {
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
const sectionHeadingClass =
  "mb-3 block text-base font-semibold text-foreground";

/**
 * UUID-style correlation IDs embedded in log/activity messages as `[<uuid>]`.
 * Matches the format produced by `generateCorrelationId` in orchestrator-agent.
 * Anchored to the bracket form so we don't accidentally pick up any raw UUID
 * that happens to appear in a payload — only IDs the agents explicitly tagged.
 */
const CORRELATION_ID_RE =
  /\[([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/i;

/** Bucket-count for sparklines — 24 keeps trends readable without noise. */
const SPARK_BUCKETS = 24;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isValidRange(value: string): value is TimeRange {
  return (
    value === "1h" || value === "24h" || value === "7d" || value === "30d"
  );
}

function isValidLevel(value: string): value is LogLevel {
  return value === "info" || value === "warn" || value === "error";
}

function isValidAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as ReadonlyArray<string>).includes(value);
}

function isValidActivityStatus(value: string): value is ActivityStatus {
  return (ACTIVITY_STATUSES as ReadonlyArray<string>).includes(value);
}

/**
 * Robust timestamp parser. Returns `NaN` on invalid input (callers that need
 * a numeric default should fall back explicitly). The previous implementation
 * returned 0 on parse failure, which silently bucketed bad rows into the Unix
 * epoch and made them invisible to every time-window filter — a quiet data
 * loss that we now surface via the `Unknown time` UI state.
 */
function parseTimestamp(input: string | number | undefined | null): number {
  if (input == null) return NaN;
  if (typeof input === "number") return Number.isFinite(input) ? input : NaN;
  const t = Date.parse(input);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Bucket a list of timestamps (ms epoch) into `bucketCount` equal-width
 * windows over [cutoff, now]. Returns counts per bucket, oldest first —
 * directly consumable by <Sparkline data={...}>. Drops NaN inputs so an
 * unparseable timestamp can't poison the histogram.
 */
function bucketTimestamps(
  timestamps: ReadonlyArray<number>,
  cutoff: number,
  now: number,
  bucketCount: number,
): number[] {
  const buckets = new Array<number>(bucketCount).fill(0);
  const span = Math.max(1, now - cutoff);
  for (const t of timestamps) {
    if (!Number.isFinite(t) || t < cutoff || t > now) continue;
    const frac = (t - cutoff) / span;
    let idx = Math.floor(frac * bucketCount);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    buckets[idx]! += 1;
  }
  return buckets;
}

/** Extract a correlation ID embedded as `[<uuid>]` in a log message, if any. */
function extractCorrelationId(message: string): string | null {
  const m = CORRELATION_ID_RE.exec(message);
  return m ? m[1]! : null;
}

/** True when `tok` matches any of the fields, case-insensitive substring. */
function matchesQuery(tok: string, fields: ReadonlyArray<string>): boolean {
  if (!tok) return true;
  const q = tok.toLowerCase();
  for (const f of fields) {
    if (f && f.toLowerCase().includes(q)) return true;
  }
  return false;
}

/** Safe serializer for unknown `details` payloads — handles circular refs. */
function safeStringify(value: unknown, maxLen = 400): string {
  if (value == null) return "";
  if (typeof value === "string") {
    return value.length > maxLen ? value.slice(0, maxLen - 1) + "…" : value;
  }
  const seen = new WeakSet<object>();
  try {
    const s = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
      }
      return v;
    });
    return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
  } catch {
    return String(value).slice(0, maxLen);
  }
}

/** Build a comma-joined URL token from a typed set, normalizing & dedup'ing. */
function parseSetParam<T extends string>(
  raw: string | undefined,
  guard: (s: string) => s is T,
): T[] {
  if (!raw) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const p of raw.split(",")) {
    const v = p.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    if (guard(v)) out.push(v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Stale-data badge                                                   */
/* ------------------------------------------------------------------ */

interface StaleBadgeProps {
  lastRefreshedAt: number;
  paused: boolean;
}

const StaleBadge: React.FC<StaleBadgeProps> = ({
  lastRefreshedAt,
  paused,
}) => {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ageSec = Math.max(0, Math.floor((now - lastRefreshedAt) / 1000));
  const tone =
    ageSec >= 300
      ? "border-destructive/60 bg-destructive/15 text-destructive"
      : ageSec >= 60
        ? "border-warning/60 bg-warning/15 text-warning"
        : "border-success/60 bg-success/15 text-success";
  const label = paused
    ? `Paused (last refresh ${ageSec}s ago)`
    : `Last refreshed ${ageSec}s ago`;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-2xs font-semibold",
        tone,
      )}
    >
      {label}
    </span>
  );
};

/* ------------------------------------------------------------------ */
/*  Filter chip                                                        */
/* ------------------------------------------------------------------ */

interface FilterChipProps {
  active: boolean;
  count?: number;
  onToggle: () => void;
  label: string;
  ariaLabel?: string;
  toneActive?: string;
  toneIdle?: string;
}

/** Pill-style multi-select chip used for level / agent / status filters. */
const FilterChip: React.FC<FilterChipProps> = ({
  active,
  count,
  onToggle,
  label,
  ariaLabel,
  toneActive = "bg-primary/15 text-primary border-primary/40",
  toneIdle = "bg-card text-muted-foreground border-border hover:text-foreground hover:bg-muted/40",
}) => {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={ariaLabel ?? `${active ? "Hide" : "Show"} ${label}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-medium tabular-nums",
        "transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        active ? toneActive : toneIdle,
      )}
    >
      <span className="uppercase tracking-wider">{label}</span>
      {typeof count === "number" && (
        <span className={cn("rounded-sm px-1 text-[10px]", active ? "bg-primary/20" : "bg-muted/50")}>
          {count}
        </span>
      )}
    </button>
  );
};

/* ------------------------------------------------------------------ */
/*  Active-filter pill                                                 */
/* ------------------------------------------------------------------ */

interface ActivePillProps {
  label: React.ReactNode;
  onClear: () => void;
  ariaLabel: string;
}

const ActivePill: React.FC<ActivePillProps> = ({ label, onClear, ariaLabel }) => (
  <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">
    {label}
    <button
      type="button"
      onClick={onClear}
      aria-label={ariaLabel}
      className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
    >
      <X className="h-3 w-3" aria-hidden />
    </button>
  </span>
);

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export interface MonitoringPageProps {
  orchestrator: OrchestratorAgent;
}

const MonitoringPageInner: React.FC<MonitoringPageProps> = ({
  orchestrator: _orchestrator,
}) => {
  const state = useMultiRegionState();

  // URL-bound state (range, search, levels, agents, statuses, live).
  // Per Contract §4.3 every filter survives reload / sharing.
  const [urlState, setUrlState] = useUrlState({
    range: DEFAULT_RANGE as string,
    metric: "",
    q: "",
    levels: "",
    agents: "",
    statuses: "",
    live: "",
  });
  const range: TimeRange = isValidRange(urlState.range as string)
    ? (urlState.range as TimeRange)
    : DEFAULT_RANGE;
  const searchQuery = (urlState.q as string) ?? "";
  const selectedLevels = React.useMemo(
    () => parseSetParam<LogLevel>(urlState.levels as string, isValidLevel),
    [urlState.levels],
  );
  const selectedAgents = React.useMemo(
    () => parseSetParam<AgentName>(urlState.agents as string, isValidAgentName),
    [urlState.agents],
  );
  const selectedStatuses = React.useMemo(
    () =>
      parseSetParam<ActivityStatus>(
        urlState.statuses as string,
        isValidActivityStatus,
      ),
    [urlState.statuses],
  );
  const liveTail = (urlState.live as string) === "1";

  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [, setTick] = React.useState(0);
  const [paused, setPaused] = React.useState(
    typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState(Date.now());
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  // `refreshing` flips on for ~250ms whenever a manual refresh fires so chart
  // panels can show a skeleton — the auto-refresh tick re-renders silently
  // to avoid strobing the page every 30s.
  const [refreshing, setRefreshing] = React.useState(false);
  const refreshingTimerRef = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (refreshingTimerRef.current != null) {
        window.clearTimeout(refreshingTimerRef.current);
      }
    },
    [],
  );

  // "Since-last-refresh" pointer powers the live-tail "new since last tick"
  // markers. We snapshot the previous refresh wall-time so newly-arrived
  // rows can be visually flagged without re-fetching anything.
  const prevRefreshAtRef = React.useRef<number>(lastRefreshedAt);
  React.useEffect(() => {
    // Capture the old value AFTER the render has consumed it, so the
    // "new since" comparison uses the previous tick — not the current one.
    return () => {
      prevRefreshAtRef.current = lastRefreshedAt;
    };
  }, [lastRefreshedAt]);

  // Search input — debounced into URL so typing does not flood history.
  const [searchInput, setSearchInput] = React.useState(searchQuery);
  React.useEffect(() => {
    // Keep input in sync if the URL changes externally (back/forward).
    setSearchInput(searchQuery);
  }, [searchQuery]);
  React.useEffect(() => {
    if (searchInput === searchQuery) return;
    const handle = window.setTimeout(() => {
      setUrlState({ q: searchInput });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [searchInput, searchQuery, setUrlState]);

  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  // Keyboard `/` focuses the search field (skipped when an editable element
  // already owns focus, so we don't hijack typing in dialogs / other inputs).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
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
    if (!autoRefresh || paused) return;
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
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : "Unknown refresh error");
    }
  }, []);

  const handleRangeChange = React.useCallback(
    (value: string) => {
      if (isValidRange(value)) {
        setUrlState({ range: value });
      }
    },
    [setUrlState],
  );

  const toggleLevel = React.useCallback(
    (lvl: LogLevel) => {
      const next = selectedLevels.includes(lvl)
        ? selectedLevels.filter((l) => l !== lvl)
        : [...selectedLevels, lvl];
      setUrlState({ levels: next.join(",") });
    },
    [selectedLevels, setUrlState],
  );

  const toggleAgent = React.useCallback(
    (a: AgentName) => {
      const next = selectedAgents.includes(a)
        ? selectedAgents.filter((x) => x !== a)
        : [...selectedAgents, a];
      setUrlState({ agents: next.join(",") });
    },
    [selectedAgents, setUrlState],
  );

  const toggleStatus = React.useCallback(
    (s: ActivityStatus) => {
      const next = selectedStatuses.includes(s)
        ? selectedStatuses.filter((x) => x !== s)
        : [...selectedStatuses, s];
      setUrlState({ statuses: next.join(",") });
    },
    [selectedStatuses, setUrlState],
  );

  const handleClearFilters = React.useCallback(() => {
    setUrlState({ q: "", levels: "", agents: "", statuses: "" });
  }, [setUrlState]);

  const toggleLiveTail = React.useCallback(() => {
    setUrlState({ live: liveTail ? "" : "1" });
  }, [liveTail, setUrlState]);

  // Time-range filter cutoff (ms epoch). `lastRefreshedAt` is a real dep so
  // the window slides forward on every refresh tick.
  const cutoff = React.useMemo(
    () => lastRefreshedAt - TIME_RANGE_MS[range],
    [range, lastRefreshedAt],
  );

  // "Last hour" pointer — used by the summary row and the "errors in the
  // last hour" lozenge regardless of which range tab is selected.
  const oneHourAgo = lastRefreshedAt - TIME_RANGE_MS["1h"];

  // ---- Filtered activities (time + status + search) ------------------------
  const filteredActivities = React.useMemo<Activity[]>(() => {
    const all = state.activities ?? [];
    const result: Activity[] = [];
    for (const a of all) {
      const ts = parseTimestamp(a.startedAt);
      // Allow rows with unparseable timestamps through the time gate so they
      // remain visible (they sort to the top under "Unknown time"). They get
      // re-filtered by status/search below like any other row.
      if (Number.isFinite(ts) && ts < cutoff) continue;
      if (
        selectedStatuses.length > 0 &&
        !selectedStatuses.includes(a.status)
      ) {
        continue;
      }
      if (
        !matchesQuery(searchQuery, [
          a.action,
          a.target,
          a.status,
          a.error ?? "",
          a.id,
        ])
      ) {
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
      if (aBad && !bBad) return -1;
      if (!aBad && bBad) return 1;
      if (aBad && bBad) return 0;
      return tb - ta;
    });
  }, [state.activities, cutoff, selectedStatuses, searchQuery]);

  // ---- Filtered logs (time + level + agent + search) -----------------------
  const filteredLogs = React.useMemo<AgentLogEntry[]>(() => {
    const all = state.agentLogs ?? [];
    const result: AgentLogEntry[] = [];
    for (const l of all) {
      const ts = parseTimestamp(l.timestamp);
      if (Number.isFinite(ts) && ts < cutoff) continue;
      if (selectedLevels.length > 0 && !selectedLevels.includes(l.level)) {
        continue;
      }
      if (selectedAgents.length > 0 && !selectedAgents.includes(l.agent)) {
        continue;
      }
      if (
        !matchesQuery(searchQuery, [
          l.message,
          l.agent,
          l.level,
          extractCorrelationId(l.message) ?? "",
        ])
      ) {
        continue;
      }
      result.push(l);
    }
    return result.sort((a, b) => {
      const ta = parseTimestamp(a.timestamp);
      const tb = parseTimestamp(b.timestamp);
      const aBad = !Number.isFinite(ta);
      const bBad = !Number.isFinite(tb);
      if (aBad && !bBad) return -1;
      if (!aBad && bBad) return 1;
      if (aBad && bBad) return 0;
      return tb - ta;
    });
  }, [
    state.agentLogs,
    cutoff,
    selectedLevels,
    selectedAgents,
    searchQuery,
  ]);

  // Pre-counts (unfiltered, for chip badges so the operator sees totals even
  // when a chip is currently active).
  const rangeCounts = React.useMemo(() => {
    const all = state.activities ?? [];
    const allLogs = state.agentLogs ?? [];
    const inRange = (ts: string) => {
      const t = parseTimestamp(ts);
      return !Number.isFinite(t) || t >= cutoff;
    };
    const byLevel: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
    const byAgent: Record<AgentName, number> = {
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
      if (!inRange(l.timestamp)) continue;
      logTotal++;
      byLevel[l.level] = (byLevel[l.level] ?? 0) + 1;
      byAgent[l.agent] = (byAgent[l.agent] ?? 0) + 1;
    }
    const byStatus = {} as Record<ActivityStatus, number>;
    for (const s of ACTIVITY_STATUSES) byStatus[s] = 0;
    let actTotal = 0;
    for (const a of all) {
      if (!inRange(a.startedAt)) continue;
      actTotal++;
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    }
    return { byLevel, byAgent, byStatus, logTotal, actTotal };
  }, [state.activities, state.agentLogs, cutoff]);

  // Summary metrics — uses the filtered slices so the operator sees what
  // the current filter set actually reveals.
  const summary = React.useMemo(() => {
    const activitiesCount = filteredActivities.length;
    const failed = filteredActivities.filter(
      (a) => a.status === "failed",
    ).length;
    const running = filteredActivities.filter(
      (a) => a.status === "running",
    ).length;
    const errorLogs = filteredLogs.filter((l) => l.level === "error").length;
    const warnLogs = filteredLogs.filter((l) => l.level === "warn").length;
    // Last-hour buckets (always 1h regardless of selected range) so the
    // "stale spike?" question never depends on choosing the right tab.
    let activitiesLastHr = 0;
    let errorsLastHr = 0;
    for (const a of filteredActivities) {
      const t = parseTimestamp(a.startedAt);
      if (Number.isFinite(t) && t >= oneHourAgo) activitiesLastHr++;
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
    const allActivityTs = filteredActivities.map((a) =>
      parseTimestamp(a.startedAt),
    );
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
    const now = lastRefreshedAt;
    const out = {} as Record<
      AgentName,
      { spark: number[]; total: number; errors: number }
    >;
    const allLogs = state.agentLogs ?? [];
    for (const name of AGENT_NAMES) {
      const ts: number[] = [];
      let errors = 0;
      for (const l of allLogs) {
        if (l.agent !== name) continue;
        const t = parseTimestamp(l.timestamp);
        if (!Number.isFinite(t) || t < cutoff) continue;
        ts.push(t);
        if (l.level === "error") errors++;
      }
      out[name] = {
        spark: bucketTimestamps(ts, cutoff, now, SPARK_BUCKETS),
        total: ts.length,
        errors,
      };
    }
    return out;
  }, [state.agentLogs, cutoff, lastRefreshedAt]);

  // Export accessors — separate ones for the two ExportMenus, each emitting
  // the columns + metadata an operator actually wants in the file.
  const activityExportColumns = React.useMemo<ExportColumn<Activity>[]>(
    () => [
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
      { header: "Progress", accessor: (a) => a.progress ?? "" },
      {
        header: "Completed (ISO)",
        accessor: (a) => {
          if (!a.completedAt) return "";
          const t = parseTimestamp(a.completedAt);
          return Number.isFinite(t) ? new Date(t).toISOString() : "";
        },
      },
      { header: "Error", accessor: (a) => a.error ?? "" },
      { header: "Parent ID", accessor: (a) => a.parentId ?? "" },
    ],
    [],
  );

  const logExportColumns = React.useMemo<ExportColumn<AgentLogEntry>[]>(
    () => [
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
        accessor: (l) => extractCorrelationId(l.message) ?? "",
      },
      { header: "Details", accessor: (l) => safeStringify(l.details) },
    ],
    [],
  );

  const combinedExportRows = React.useMemo(
    () => ({
      range,
      cutoffIso: new Date(cutoff).toISOString(),
      generatedAt: new Date().toISOString(),
      filters: {
        searchQuery: searchQuery || undefined,
        levels: selectedLevels.length > 0 ? selectedLevels : undefined,
        agents: selectedAgents.length > 0 ? selectedAgents : undefined,
        statuses:
          selectedStatuses.length > 0 ? selectedStatuses : undefined,
      },
      counts: {
        activities: filteredActivities.length,
        logs: filteredLogs.length,
      },
      activities: filteredActivities,
      logs: filteredLogs,
    }),
    [
      range,
      cutoff,
      searchQuery,
      selectedLevels,
      selectedAgents,
      selectedStatuses,
      filteredActivities,
      filteredLogs,
    ],
  );

  /** Combined CSV — activities and logs merged into one sheet. */
  const handleExportCombinedCsv = React.useCallback(() => {
    const headers = [
      "kind",
      "timestamp_iso",
      "agent_or_action",
      "target_or_message",
      "status_or_level",
      "correlation_id",
      "details",
    ];
    const rows: (string | number)[][] = [];
    for (const a of filteredActivities) {
      const t = parseTimestamp(a.startedAt);
      rows.push([
        "activity",
        Number.isFinite(t) ? new Date(t).toISOString() : "",
        a.action,
        a.target,
        a.status,
        a.id,
        a.error ?? "",
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
        extractCorrelationId(l.message) ?? "",
        safeStringify(l.details),
      ]);
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    downloadCsv(`monitoring-combined-${range}-${ts}.csv`, headers, rows);
  }, [filteredActivities, filteredLogs, range]);

  /** Combined JSON — preserves structure + metadata for machine consumption. */
  const handleExportCombinedJson = React.useCallback(() => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    downloadJson(`monitoring-combined-${range}-${ts}.json`, combinedExportRows);
  }, [combinedExportRows, range]);

  /** Copy the current filtered log view as a single text blob — handy for
   *  pasting into a chat / issue when an export file is overkill. */
  const handleCopyLogs = React.useCallback(async () => {
    const lines = filteredLogs.map((l) => {
      const t = parseTimestamp(l.timestamp);
      const iso = Number.isFinite(t) ? new Date(t).toISOString() : "—";
      return `${iso} [${l.agent}] ${l.level.toUpperCase().padEnd(5)} ${l.message}`;
    });
    const text = lines.join("\n");
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch {
      // best-effort; failures land in browser console
    }
  }, [filteredLogs]);

  // ---- Activity table columns ---------------------------------------------
  const activityColumns = React.useMemo<DataTableColumn<Activity>[]>(
    () => [
      {
        id: "time",
        header: "Time",
        cell: (a) => {
          const t = parseTimestamp(a.startedAt);
          const isNew =
            Number.isFinite(t) && t >= prevRefreshAtRef.current;
          if (!Number.isFinite(t)) {
            return (
              <span className="font-mono text-2xs italic text-warning">
                Unknown time
              </span>
            );
          }
          return (
            <span
              className={cn(
                "font-mono text-2xs tabular-nums text-muted-foreground/80",
                isNew && liveTail && "font-semibold text-info",
              )}
            >
              {new Date(t).toLocaleTimeString()}
              {isNew && liveTail && (
                <span
                  className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-info align-middle"
                  aria-label="New since last refresh"
                />
              )}
            </span>
          );
        },
        sort: (x, y) =>
          parseTimestamp(x.startedAt) - parseTimestamp(y.startedAt),
        csv: (a) => {
          const t = parseTimestamp(a.startedAt);
          return Number.isFinite(t) ? new Date(t).toISOString() : "";
        },
        width: "w-32",
      },
      {
        id: "action",
        header: "Action",
        cell: (a) => (
          <span className="text-xs text-foreground/85">{a.action}</span>
        ),
        sort: (x, y) => x.action.localeCompare(y.action),
        csv: (a) => a.action,
        width: "w-40",
      },
      {
        id: "target",
        header: "Target",
        cell: (a) => (
          <span
            className="block truncate text-xs text-muted-foreground"
            title={a.target}
          >
            {a.target}
          </span>
        ),
        sort: (x, y) => x.target.localeCompare(y.target),
        csv: (a) => a.target,
      },
      {
        id: "status",
        header: "Status",
        cell: (a) => (
          <span
            className={cn(
              "inline-flex rounded-full bg-surface-sunken px-2 py-0.5 text-2xs font-semibold capitalize tabular-nums",
              ACTIVITY_STATUS_CLASSES[a.status] ?? "text-muted-foreground",
            )}
          >
            {a.status}
          </span>
        ),
        sort: (x, y) => x.status.localeCompare(y.status),
        csv: (a) => a.status,
        width: "w-32",
      },
      {
        id: "id",
        header: "ID",
        cell: (a) => (
          <span className="group/copy inline-flex items-center gap-1.5">
            <span
              className="block max-w-[140px] truncate font-mono text-2xs text-muted-foreground/80"
              title={a.id}
            >
              {a.id}
            </span>
            <CopyButton value={a.id} ariaLabel={`Copy activity id ${a.id}`} />
          </span>
        ),
        sort: (x, y) => x.id.localeCompare(y.id),
        csv: (a) => a.id,
        defaultHidden: true,
        width: "w-44",
      },
      {
        id: "error",
        header: "Error",
        cell: (a) =>
          a.error ? (
            <span
              className="block truncate text-2xs text-destructive/90"
              title={a.error}
            >
              {a.error}
            </span>
          ) : (
            <span className="text-2xs text-muted-foreground/60">—</span>
          ),
        sort: (x, y) => (x.error ?? "").localeCompare(y.error ?? ""),
        csv: (a) => a.error ?? "",
        defaultHidden: true,
      },
    ],
    [liveTail],
  );

  // ---- Log table columns --------------------------------------------------
  const logColumns = React.useMemo<DataTableColumn<AgentLogEntry>[]>(
    () => [
      {
        id: "time",
        header: "Time",
        cell: (l) => {
          const t = parseTimestamp(l.timestamp);
          const isNew =
            Number.isFinite(t) && t >= prevRefreshAtRef.current;
          if (!Number.isFinite(t)) {
            return (
              <span className="font-mono text-2xs italic text-warning">
                Unknown time
              </span>
            );
          }
          return (
            <span
              className={cn(
                "font-mono text-2xs tabular-nums text-muted-foreground/80",
                isNew && liveTail && "font-semibold text-info",
              )}
            >
              {new Date(t).toLocaleTimeString()}
              {isNew && liveTail && (
                <span
                  className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-info align-middle"
                  aria-label="New since last refresh"
                />
              )}
            </span>
          );
        },
        sort: (x, y) =>
          parseTimestamp(x.timestamp) - parseTimestamp(y.timestamp),
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
          const tone = LOG_LEVEL_CLASSES[l.level] ?? LOG_LEVEL_CLASSES.info;
          return (
            <span
              className={cn(
                "inline-flex rounded-sm px-1.5 text-2xs font-semibold uppercase",
                tone.badge,
              )}
            >
              {l.level}
            </span>
          );
        },
        sort: (x, y) => x.level.localeCompare(y.level),
        csv: (l) => l.level,
        width: "w-20",
      },
      {
        id: "agent",
        header: "Agent",
        cell: (l) => (
          <span className="text-xs text-muted-foreground">[{l.agent}]</span>
        ),
        sort: (x, y) => x.agent.localeCompare(y.agent),
        csv: (l) => l.agent,
        width: "w-32",
      },
      {
        id: "message",
        header: "Message",
        cell: (l) => {
          const tone = LOG_LEVEL_CLASSES[l.level] ?? LOG_LEVEL_CLASSES.info;
          const corr = extractCorrelationId(l.message);
          // When the message contains an explicit `[uuid]` chunk, render the
          // text with that fragment elided so the cell stays scannable, and
          // attach a CopyButton next to the row's correlation column instead.
          const displayMsg = corr
            ? l.message.replace(`[${corr}]`, "").replace(/\s+/g, " ").trim()
            : l.message;
          return (
            <span
              className={cn("block truncate text-xs", tone.message)}
              title={l.message}
            >
              {displayMsg}
            </span>
          );
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
            return <span className="text-2xs text-muted-foreground/60">—</span>;
          }
          // Show only the first 8 characters of the UUID for compactness — the
          // full ID lands on the clipboard via the inline copy button.
          const short = corr.slice(0, 8);
          return (
            <CopyableText
              value={corr}
              display={short}
              mono
              ariaLabel={`Copy correlation id ${corr}`}
              alwaysVisibleButton
            />
          );
        },
        sort: (x, y) =>
          (extractCorrelationId(x.message) ?? "").localeCompare(
            extractCorrelationId(y.message) ?? "",
          ),
        csv: (l) => extractCorrelationId(l.message) ?? "",
        width: "w-32",
      },
      {
        id: "details",
        header: "Details",
        cell: (l) => {
          const s = safeStringify(l.details, 200);
          if (!s) return <span className="text-2xs text-muted-foreground/60">—</span>;
          return (
            <span
              className="block truncate font-mono text-2xs text-muted-foreground/80"
              title={s}
            >
              {s}
            </span>
          );
        },
        sort: (x, y) =>
          safeStringify(x.details).localeCompare(safeStringify(y.details)),
        csv: (l) => safeStringify(l.details, 1000),
        defaultHidden: true,
      },
    ],
    [liveTail],
  );

  const autoRefreshLabel =
    autoRefresh && paused ? "Auto-refresh (paused)" : "Auto-refresh (30s)";
  const autoRefreshAria = autoRefresh
    ? paused
      ? "Auto-refresh paused while tab is hidden"
      : "Disable auto-refresh"
    : "Enable auto-refresh every 30 seconds";

  const rangeLabel =
    TIME_RANGES.find((r) => r.value === range)?.label ?? DEFAULT_RANGE;
  const lastRefreshedRel = formatRelativeTime(new Date(lastRefreshedAt));

  const hasFilter =
    searchQuery !== "" ||
    selectedLevels.length > 0 ||
    selectedAgents.length > 0 ||
    selectedStatuses.length > 0;

  const activityFilteredOut =
    rangeCounts.actTotal - filteredActivities.length;
  const logFilteredOut = rangeCounts.logTotal - filteredLogs.length;

  return (
    <div
      className="flex flex-col gap-4 py-4"
      aria-label="Monitoring page"
    >
      <div className="relative overflow-hidden rounded-xl border bg-card/50 p-6">
        <DotPattern fade="top-left" />
        <Meteors count={10} tone="primary" />
        <div className="relative z-10">
      <PageHeader
        title="Monitoring"
        description={`Agent activity over the last ${rangeLabel} (refreshed ${lastRefreshedRel}). Press / to search.`}
      >
        <HeartPulse
          className="h-5 w-5 text-primary"
          aria-hidden={true}
        />
        <Tabs
          value={range}
          onValueChange={handleRangeChange}
          aria-label="Time range"
        >
          <TabsList aria-label="Select time range">
            {TIME_RANGES.map((r) => (
              <TabsTrigger key={r.value} value={r.value}>
                {r.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <InfoTooltip
          content="Selects the time window applied to the entire page — summary stats, sparklines, status chips, activities, and agent logs all clip to this range. Defaults to 24h."
          ariaLabel="Time range help"
        />
        <StaleBadge
          lastRefreshedAt={lastRefreshedAt}
          paused={autoRefresh && paused}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleManualRefresh}
          aria-label="Manually refresh monitoring data"
        >
          <RefreshCcw aria-hidden={true} />
          Refresh
        </Button>
        <Button
          type="button"
          variant={liveTail ? "default" : "outline"}
          size="sm"
          onClick={toggleLiveTail}
          aria-pressed={liveTail}
          aria-label={
            liveTail
              ? "Disable live-tail markers"
              : "Enable live-tail markers"
          }
        >
          {liveTail ? (
            <Pause aria-hidden={true} />
          ) : (
            <Play aria-hidden={true} />
          )}
          {liveTail ? "Live" : "Tail"}
        </Button>
        <InfoTooltip
          content="Live-tail flags rows newer than the previous refresh with a small blue dot so you can spot fresh events without scanning the whole list. Pair with auto-refresh for a Splunk-style follow mode."
          ariaLabel="Live-tail help"
        />
        <div className="flex items-center gap-2">
          <Switch
            id="monitoring-auto-refresh"
            checked={autoRefresh}
            onCheckedChange={(checked) => setAutoRefresh(checked)}
            aria-label={autoRefreshAria}
          />
          <Label
            htmlFor="monitoring-auto-refresh"
            className="cursor-pointer text-xs text-muted-foreground"
          >
            {autoRefreshLabel}
          </Label>
        </div>
      </PageHeader>
        </div>
      </div>

      {refreshError && (
        <ErrorState
          message="Failed to refresh monitoring data."
          detail={refreshError}
          onRetry={handleManualRefresh}
          size="compact"
        />
      )}

      {/* Metric summary — aria-live on each number announces updates */}
      <section
        className={sectionClass}
        aria-label="Monitoring summary"
      >
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <div className="flex items-center gap-1">
            <h2 className={cn(sectionHeadingClass, "mb-0")}>Summary</h2>
            <InfoTooltip
              content="Stats reflect the rows currently visible after time range and filter chips are applied. The 'Last hour' column is fixed to a 1h window regardless of the selected range so it stays a stable signal."
              ariaLabel="Summary stats help"
            />
          </div>
          <span className="text-2xs text-muted-foreground">
            Trend across the last {rangeLabel}
          </span>
        </div>
        {refreshing ? (
          <SkeletonLoader variant="stat-bar" />
        ) : (
          <dl className="relative grid grid-cols-2 gap-3 overflow-hidden rounded-xl sm:grid-cols-3 lg:grid-cols-7">
            <BorderBeam size={200} duration={8} />
            <StatCard
              label="Activities"
              value={summary.activitiesCount}
              spark={sparklines.activities}
              tone="info"
              status={summary.activitiesCount > 0 ? "active" : "idle"}
              rangeLabel={rangeLabel}
            />
            <StatCard
              label="Running"
              value={summary.running}
              spark={sparklines.running}
              tone="warning"
              status={summary.running > 0 ? "active" : "idle"}
              rangeLabel={rangeLabel}
            />
            <StatCard
              label="Failed"
              value={summary.failed}
              spark={sparklines.failed}
              tone="destructive"
              status={summary.failed > 0 ? "alert" : "ok"}
              rangeLabel={rangeLabel}
            />
            <StatCard
              label="Errors"
              value={summary.errorLogs}
              spark={sparklines.errorLogs}
              tone="destructive"
              status={summary.errorLogs > 0 ? "alert" : "ok"}
              rangeLabel={rangeLabel}
            />
            <StatCard
              label="Warnings"
              value={summary.warnLogs}
              spark={sparklines.warnLogs}
              tone="warning"
              status={summary.warnLogs > 0 ? "active" : "ok"}
              rangeLabel={rangeLabel}
            />
            <SummaryStatItem
              label={
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" aria-hidden />
                  Last hour acts
                </span>
              }
              value={summary.activitiesLastHr}
              tone={summary.activitiesLastHr > 0 ? "info" : "muted"}
              hint="rolling 1h"
              compact
            />
            <SummaryStatItem
              label={
                <span className="inline-flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                  Last hour errs
                </span>
              }
              value={summary.errorsLastHr}
              tone={summary.errorsLastHr > 0 ? "destructive" : "muted"}
              hint="rolling 1h"
              compact
            />
          </dl>
        )}
      </section>

      {/* Filter toolbar — search + chips for level / agent / status. */}
      <section
        className={cn(sectionClass, "sticky top-0 z-20 backdrop-blur supports-[backdrop-filter]:bg-card/85")}
        aria-label="Filter toolbar"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex w-full max-w-md items-center">
              <Search
                className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground"
                aria-hidden
              />
              <Input
                ref={searchInputRef}
                type="search"
                placeholder="Search message, agent, action, target, correlation ID, error… (press /)"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="h-9 pl-8 pr-8"
                aria-label="Search monitoring entries"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput("")}
                  aria-label="Clear search"
                  className="absolute right-2 inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </div>
            <InfoTooltip
              content={
                <div className="space-y-1 text-xs">
                  <p className="m-0">Search matches across:</p>
                  <ul className="m-0 ml-3 list-disc space-y-0.5">
                    <li>Log message + agent + level</li>
                    <li>Activity action + target + status + error</li>
                    <li>Correlation IDs and activity IDs</li>
                  </ul>
                  <p className="m-0 text-muted-foreground">
                    Case-insensitive substring match. Press <kbd className="rounded border bg-muted/30 px-1 font-mono">/</kbd> to focus.
                  </p>
                </div>
              }
              ariaLabel="Search help"
            />

            <span className="mx-1 hidden h-5 w-px bg-border sm:inline-block" aria-hidden />

            <ExportMenu<Activity>
              rows={filteredActivities}
              columns={activityExportColumns}
              filename={`monitoring-activities-${range}`}
              jsonMetadata={{
                source: "AzureBatchManager.Monitoring",
                kind: "activities",
                range,
                filters: {
                  searchQuery: searchQuery || undefined,
                  statuses:
                    selectedStatuses.length > 0
                      ? selectedStatuses
                      : undefined,
                },
              }}
              label="Activities"
              disabled={filteredActivities.length === 0}
            />
            <ExportMenu<AgentLogEntry>
              rows={filteredLogs}
              columns={logExportColumns}
              filename={`monitoring-logs-${range}`}
              jsonMetadata={{
                source: "AzureBatchManager.Monitoring",
                kind: "logs",
                range,
                filters: {
                  searchQuery: searchQuery || undefined,
                  levels: selectedLevels.length > 0 ? selectedLevels : undefined,
                  agents: selectedAgents.length > 0 ? selectedAgents : undefined,
                },
              }}
              label="Logs"
              disabled={filteredLogs.length === 0}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportCombinedCsv}
              disabled={
                filteredActivities.length === 0 && filteredLogs.length === 0
              }
              aria-label="Export combined activities + logs as CSV"
            >
              Combined CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportCombinedJson}
              disabled={
                filteredActivities.length === 0 && filteredLogs.length === 0
              }
              aria-label="Export combined activities + logs as JSON"
            >
              Combined JSON
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyLogs}
              disabled={filteredLogs.length === 0}
              aria-label="Copy filtered logs to clipboard"
            >
              Copy logs
            </Button>
          </div>

          {/* Level + Agent + Status chips */}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                <FilterIcon className="h-3 w-3" aria-hidden />
                Level
                <InfoTooltip
                  size={11}
                  content="Filter agent logs by severity. Selecting nothing shows all levels."
                  ariaLabel="Level filter help"
                />
              </span>
              {LOG_LEVELS.map((lvl) => {
                const Icon =
                  lvl === "error"
                    ? XCircle
                    : lvl === "warn"
                      ? AlertTriangle
                      : InfoIcon;
                const toneActive =
                  lvl === "error"
                    ? "bg-destructive/15 text-destructive border-destructive/40"
                    : lvl === "warn"
                      ? "bg-warning/15 text-warning border-warning/40"
                      : "bg-primary/15 text-primary border-primary/40";
                return (
                  <FilterChip
                    key={lvl}
                    active={selectedLevels.includes(lvl)}
                    count={rangeCounts.byLevel[lvl]}
                    onToggle={() => toggleLevel(lvl)}
                    toneActive={toneActive}
                    label={lvl}
                    ariaLabel={`${
                      selectedLevels.includes(lvl) ? "Hide" : "Show"
                    } level ${lvl} (${rangeCounts.byLevel[lvl] ?? 0})`}
                  />
                );
              })}
              {/* compose icon prefix inside a separate wrapper would over-
                  complicate the chip API; the colored chip alone reads fine */}
              <InlineLegend icons={[XCircle, AlertTriangle, InfoIcon]} />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Bug className="h-3 w-3" aria-hidden />
                Agent
                <InfoTooltip
                  size={11}
                  content="Filter logs by emitter agent. Selecting nothing shows all agents."
                  ariaLabel="Agent filter help"
                />
              </span>
              {AGENT_NAMES.map((a) => (
                <FilterChip
                  key={a}
                  active={selectedAgents.includes(a)}
                  count={rangeCounts.byAgent[a]}
                  onToggle={() => toggleAgent(a)}
                  label={a}
                  ariaLabel={`${
                    selectedAgents.includes(a) ? "Hide" : "Show"
                  } agent ${a} (${rangeCounts.byAgent[a] ?? 0})`}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ActivityIcon className="h-3 w-3" aria-hidden />
                Status
                <InfoTooltip
                  size={11}
                  content="Filter activities by lifecycle status. Selecting nothing shows all statuses."
                  ariaLabel="Status filter help"
                />
              </span>
              {ACTIVITY_STATUSES.map((s) => {
                const tone = ACTIVITY_STATUS_CLASSES[s] ?? "text-muted-foreground";
                const active = selectedStatuses.includes(s);
                return (
                  <FilterChip
                    key={s}
                    active={active}
                    count={rangeCounts.byStatus[s] ?? 0}
                    onToggle={() => toggleStatus(s)}
                    toneActive={cn("bg-card border-primary/40", tone)}
                    label={s}
                    ariaLabel={`${
                      active ? "Hide" : "Show"
                    } status ${s} (${rangeCounts.byStatus[s] ?? 0})`}
                  />
                );
              })}
            </div>
          </div>

          {hasFilter && (
            <div
              className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2"
              role="group"
              aria-label="Active filters"
            >
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Active filters:
              </span>
              {searchQuery && (
                <ActivePill
                  label={`search: "${searchQuery}"`}
                  onClear={() => setUrlState({ q: "" })}
                  ariaLabel="Clear search filter"
                />
              )}
              {selectedLevels.map((lvl) => (
                <ActivePill
                  key={`lvl-${lvl}`}
                  label={`level: ${lvl}`}
                  onClear={() => toggleLevel(lvl)}
                  ariaLabel={`Clear ${lvl} level filter`}
                />
              ))}
              {selectedAgents.map((a) => (
                <ActivePill
                  key={`agt-${a}`}
                  label={`agent: ${a}`}
                  onClear={() => toggleAgent(a)}
                  ariaLabel={`Clear ${a} agent filter`}
                />
              ))}
              {selectedStatuses.map((s) => (
                <ActivePill
                  key={`st-${s}`}
                  label={`status: ${s}`}
                  onClear={() => toggleStatus(s)}
                  ariaLabel={`Clear ${s} status filter`}
                />
              ))}
              <button
                type="button"
                onClick={handleClearFilters}
                className="ml-auto text-2xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Clear all
              </button>
            </div>
          )}

          {/* Results meter — shows shown/total + filtered-out count */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-2xs text-muted-foreground">
            <div className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-success" aria-hidden />
                Activities:{" "}
                <strong className="font-semibold text-foreground tabular-nums">
                  {formatNumber(filteredActivities.length)}
                </strong>
                {" / "}
                <span className="tabular-nums">
                  {formatNumber(rangeCounts.actTotal)}
                </span>
                {activityFilteredOut > 0 && (
                  <span className="text-warning">
                    {" "}
                    ({formatNumber(activityFilteredOut)} hidden)
                  </span>
                )}
              </span>
              <span className="inline-flex items-center gap-1">
                <ActivityIcon className="h-3 w-3 text-primary" aria-hidden />
                Logs:{" "}
                <strong className="font-semibold text-foreground tabular-nums">
                  {formatNumber(filteredLogs.length)}
                </strong>
                {" / "}
                <span className="tabular-nums">
                  {formatNumber(rangeCounts.logTotal)}
                </span>
                {logFilteredOut > 0 && (
                  <span className="text-warning">
                    {" "}
                    ({formatNumber(logFilteredOut)} hidden)
                  </span>
                )}
              </span>
            </div>
            {liveTail && (
              <span className="inline-flex items-center gap-1 text-info">
                <span
                  className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-info motion-reduce:animate-none"
                  aria-hidden
                />
                Live-tail markers active
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Agent Status Panel — chips show live status; tooltip surfaces the
          per-agent log activity sparkline + counts so a glance is enough
          to spot which agent is currently noisy. */}
      <section className={sectionClass} aria-label="Agent status">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <div className="flex items-center gap-1">
            <h2 className={cn(sectionHeadingClass, "mb-0")}>Agent Status</h2>
            <InfoTooltip
              content="Each chip shows the agent's current status with a 24-bucket log activity sparkline. Click a chip to filter the log table to that agent. Hover for a richer tooltip."
              ariaLabel="Agent status help"
            />
          </div>
          <span className="text-2xs text-muted-foreground">
            Hover an agent to see its log trend · click to filter
          </span>
        </div>
        {refreshing ? (
          <SkeletonLoader variant="list" rows={3} />
        ) : (
          <div className="flex flex-wrap gap-2">
            {AGENT_NAMES.map((name) => {
              const status: AgentStatus = state.agentStatuses[name] ?? "idle";
              const tone = AGENT_STATUS_CLASSES[status];
              const meta = agentSparklines[name];
              const sparkTone: SparklineTone =
                meta.errors > 0
                  ? "destructive"
                  : status === "running"
                    ? "primary"
                    : status === "completed"
                      ? "success"
                      : "muted";
              const isFiltered = selectedAgents.includes(name);
              return (
                <Tooltip key={name}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="status"
                      aria-label={`Agent ${name}: ${status}; ${meta.total} log entries, ${meta.errors} errors. ${isFiltered ? "Click to remove from agent filter" : "Click to add to agent filter"}`}
                      aria-pressed={isFiltered}
                      onClick={() => toggleAgent(name)}
                      className={cn(
                        "group flex items-center gap-2 rounded-md border border-transparent px-3 py-1.5",
                        "transition-all duration-200 ease-out motion-reduce:transition-none",
                        "hover:border-border hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        tone.container,
                        isFiltered && "ring-2 ring-primary/60",
                      )}
                    >
                      <span
                        aria-hidden={true}
                        className={cn(
                          "h-2 w-2 rounded-full transition-transform duration-200 group-hover:scale-110",
                          tone.dot,
                          status === "running" && tone.glow,
                          status === "running" &&
                            "animate-pulse motion-reduce:animate-none",
                        )}
                      />
                      <span
                        className={cn(
                          "text-xs font-semibold capitalize",
                          tone.text,
                        )}
                      >
                        {name}
                      </span>
                      <Sparkline
                        data={meta.spark}
                        width={48}
                        height={14}
                        tone={sparkTone}
                        strokeWidth={1.25}
                        ariaLabel={`Log activity trend for ${name}`}
                      />
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                          "bg-card/70",
                          tone.text,
                        )}
                      >
                        {status}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <div className="flex flex-col gap-0.5 text-2xs">
                      <span className="font-semibold capitalize text-foreground">
                        {name} · {status}
                      </span>
                      <span className="text-muted-foreground">
                        {formatNumber(meta.total)} log
                        {meta.total === 1 ? "" : "s"} in last {rangeLabel}
                      </span>
                      {meta.errors > 0 && (
                        <span className="text-destructive">
                          {formatNumber(meta.errors)} error
                          {meta.errors === 1 ? "" : "s"}
                        </span>
                      )}
                      <span className="text-muted-foreground/80">
                        {isFiltered ? "Click to clear filter" : "Click to filter logs by this agent"}
                      </span>
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        )}
      </section>

      {/* Recent Activity */}
      <section
        className={sectionClass}
        aria-label="Recent activity"
      >
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className={cn(sectionHeadingClass, "mb-0")}>Recent Activity</h2>
          <span className="text-2xs text-muted-foreground">
            {formatNumber(filteredActivities.length)} shown
          </span>
        </div>
        {refreshing ? (
          <SkeletonLoader variant="table" rows={5} columns={4} />
        ) : (
          <DataTable<Activity>
            tableId="monitoring-activities"
            rows={filteredActivities}
            columns={activityColumns}
            rowKey={(a) => a.id}
            csvFileName={`monitoring-activities-${range}.csv`}
            empty={
              <EmptyState
                icon={BarChart3}
                title={
                  hasFilter
                    ? "No activity matches the current filter"
                    : "No activity recorded"
                }
                description={
                  hasFilter
                    ? "Try clearing filters or widening the time range."
                    : `No activity in the last ${rangeLabel}. Activities will appear here as operations are performed.`
                }
              />
            }
            initialSort={{ column: "time", direction: "desc" }}
          />
        )}
      </section>

      {/* Agent Logs */}
      <section
        className={sectionClass}
        aria-label="Agent logs"
      >
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className={cn(sectionHeadingClass, "mb-0")}>Agent Logs</h2>
          <span className="text-2xs text-muted-foreground">
            {formatNumber(filteredLogs.length)} shown
          </span>
        </div>
        {refreshing ? (
          <SkeletonLoader variant="table" rows={6} columns={4} />
        ) : (
          <DataTable<AgentLogEntry>
            tableId="monitoring-logs"
            rows={filteredLogs}
            columns={logColumns}
            rowKey={(l) =>
              // Collisions are theoretically possible if two identical lines
              // land in the same millisecond — fall back to the full message
              // hash via slice so React's reconciliation stays stable.
              `${l.timestamp}|${l.agent}|${l.level}|${
                extractCorrelationId(l.message) ??
                `${l.message.length}:${l.message.slice(0, 48)}`
              }`
            }
            csvFileName={`monitoring-logs-${range}.csv`}
            empty={
              <EmptyState
                icon={FilterIcon}
                title={
                  hasFilter
                    ? "No logs match the current filter"
                    : "No logs yet"
                }
                description={
                  hasFilter
                    ? "Try clearing filters or widening the time range."
                    : `No agent log entries in the last ${rangeLabel}.`
                }
              />
            }
            initialSort={{ column: "time", direction: "desc" }}
          />
        )}
      </section>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  InlineLegend — small decorative icon row next to the level chips   */
/* ------------------------------------------------------------------ */

interface InlineLegendProps {
  icons: ReadonlyArray<React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>>;
}

const InlineLegend: React.FC<InlineLegendProps> = ({ icons }) => (
  <span className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground/40" aria-hidden>
    {icons.map((Icon, i) => (
      <Icon key={i} className="h-2.5 w-2.5" aria-hidden />
    ))}
  </span>
);

/* ------------------------------------------------------------------ */
/*  StatCard — number + sparkline + status pill                        */
/* ------------------------------------------------------------------ */

type StatTone = "info" | "warning" | "destructive" | "success" | "primary";

const STAT_TONE_CLASS: Record<
  StatTone,
  { value: string; pill: string; ring: string }
> = {
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

const STAT_STATUS_LABEL: Record<"ok" | "active" | "alert" | "idle", string> = {
  ok: "OK",
  active: "Active",
  alert: "Attention",
  idle: "Idle",
};

const STAT_STATUS_TONE: Record<"ok" | "active" | "alert" | "idle", StatTone> = {
  ok: "success",
  active: "primary",
  alert: "destructive",
  idle: "info",
};

interface StatCardProps {
  label: string;
  value: number;
  spark: number[];
  tone: StatTone;
  status: "ok" | "active" | "alert" | "idle";
  rangeLabel: string;
}

const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  spark,
  tone,
  status,
  rangeLabel,
}) => {
  const toneCls = STAT_TONE_CLASS[tone];
  const statusToneCls = STAT_TONE_CLASS[STAT_STATUS_TONE[status]];
  const sparkTone: SparklineTone = tone;
  // Active cards (non-zero counts) glow softly, communicating "data is
  // flowing here right now". Idle cards stay quiet so the active ones
  // visibly stand out. Tone routes the .live-glow-bar's color via the
  // --live-tone CSS var.
  const isActive = status === "active";
  const liveToneVar =
    tone === "info"
      ? "var(--info, var(--primary))"
      : tone === "warning"
        ? "var(--warning)"
        : tone === "success"
          ? "var(--success)"
          : tone === "destructive"
            ? "var(--destructive)"
            : "var(--primary)";
  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1 rounded-md border border-border bg-card/60 p-2.5",
        "transition-all duration-200 ease-out motion-reduce:transition-none",
        "hover:bg-card hover:shadow-sm hover:ring-1",
        toneCls.ring,
        isActive && "live-glow-bar",
      )}
      style={
        isActive
          ? ({ ["--live-tone" as never]: liveToneVar } as React.CSSProperties)
          : undefined
      }
    >
      <div className="flex items-center justify-between gap-2">
        <dt className="text-2xs uppercase tracking-wide text-muted-foreground">
          {label}
        </dt>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
            statusToneCls.pill,
          )}
          aria-label={`${label} status: ${STAT_STATUS_LABEL[status]}`}
        >
          {/* Live pulse dot when this card is active. */}
          {isActive && (
            <span
              className="live-pulse-dot"
              style={{ ["--live-tone" as never]: liveToneVar }}
              aria-hidden="true"
            />
          )}
          {STAT_STATUS_LABEL[status]}
        </span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <dd
          aria-live="polite"
          className={cn(
            "text-xl font-semibold leading-none tabular-nums",
            toneCls.value,
          )}
        >
          <NumberTicker value={value} />
        </dd>
        <Sparkline
          data={spark}
          width={72}
          height={20}
          tone={sparkTone}
          ariaLabel={`${label} trend over the last ${rangeLabel}`}
        />
      </div>
    </div>
  );
};

export const MonitoringPage: React.FC<MonitoringPageProps> = (props) => (
  <ErrorBoundary>
    <MonitoringPageInner {...props} />
  </ErrorBoundary>
);
