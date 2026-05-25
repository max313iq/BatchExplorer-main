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
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  Boxes,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  HardDrive,
  Layers,
  Loader2,
  LogIn,
  Minus,
  PiggyBank,
  Plus,
  RefreshCw,
  Search,
  Server,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  BorderBeam,
  DotPattern,
  HoverList,
  Meteors,
  NumberTicker,
} from "@/components/ui/effects";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sparkline, type SparklineTone } from "@/components/ui/charts/sparkline";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TONE_CLASSES, type Tone } from "@/styles/tokens";
import { cn, formatNumber } from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { useArmToken } from "../../auth/use-arm-token";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import { MultiRegionStore } from "../../store/multi-region-store";
import {
  useDashboardStats,
  useMultiRegionState,
} from "../../store/store-context";
import { QuotaSuggestion } from "../../store/store-types";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton } from "../shared/copy-button";
import { DataTable, DataTableColumn } from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { PageKey } from "../shared/sidebar-nav";
import { RegionHealthChart } from "../shared/region-health-chart";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { StatusBadge } from "../shared/status-badge";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

// ---------------------------------------------------------------------------
// Range toggle
// ---------------------------------------------------------------------------

const RANGE_OPTIONS = ["24h", "7d", "30d"] as const;
type RangeKey = (typeof RANGE_OPTIONS)[number];

const RANGE_LABEL: Record<RangeKey, string> = {
  "24h": "previous 24h",
  "7d": "previous 7d",
  "30d": "previous 30d",
};

function isRangeKey(value: string): value is RangeKey {
  return (RANGE_OPTIONS as readonly string[]).includes(value);
}

// Approx number of history samples per range bucket. The rolling buffer caps
// at ~120 samples (~2h at 60s refresh), so longer windows fall back to "all
// available history" without erroring.
const RANGE_HISTORY_WINDOW: Record<RangeKey, number> = {
  "24h": 24,
  "7d": 90,
  "30d": 120,
};

// ---------------------------------------------------------------------------
// Region status quick-filter
// ---------------------------------------------------------------------------

type RegionStatusFilter = "all" | "healthy" | "degraded" | "down" | "nodata";

const REGION_STATUS_FILTERS: Array<{
  key: RegionStatusFilter;
  label: string;
  tone: Tone | "muted";
}> = [
  { key: "all", label: "All", tone: "muted" },
  { key: "healthy", label: "Healthy", tone: "success" },
  { key: "degraded", label: "Degraded", tone: "warning" },
  { key: "down", label: "Down", tone: "destructive" },
  { key: "nodata", label: "No data", tone: "info" },
];

function isRegionStatusFilter(value: string): value is RegionStatusFilter {
  return REGION_STATUS_FILTERS.some((f) => f.key === value);
}

// ---------------------------------------------------------------------------
// Trend helpers — derived from the rolling history buffer
// ---------------------------------------------------------------------------

interface Trend {
  direction: "up" | "down" | "flat";
  /** Percent change in absolute value, capped to 999. */
  pct: number;
  /** Human-readable label (e.g. "previous 24h"). */
  period: string;
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
function computeTrend(
  series: number[],
  window: number,
  period: string,
): Trend {
  if (series.length < 2) return { direction: "flat", pct: 0, period };
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

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

interface StatItem {
  label: string;
  value: number;
  tone?: Tone;
}

interface StatCardProps {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  /** Optional info-tooltip text shown next to the title. */
  info?: string;
  tone: Tone;
  items: StatItem[];
  onClick?: () => void;
  error?: string | null;
  onRetry?: () => void;
  trend?: Trend;
  /**
   * When direction-up is "bad" (failed counts, used cores) callers pass
   * `goodDirection="down"` so up-trends render destructive instead of
   * success. Defaults to `"up"` (more is better).
   */
  goodDirection?: "up" | "down";
  /**
   * Optional time-series data for an inline sparkline rendered top-right.
   * Renders nothing for fewer than 2 samples.
   */
  sparkData?: number[];
  /** Optional tone override for the sparkline (defaults to the card tone). */
  sparkTone?: SparklineTone;
}

const StatCard: React.FC<StatCardProps> = ({
  id,
  icon: IconComp,
  title,
  info,
  tone,
  items,
  onClick,
  error,
  onRetry,
  trend,
  goodDirection = "up",
  sparkData,
  sparkTone,
}) => {
  const headingId = `${id}-heading`;
  const total =
    items.length > 0 && items[0].label === "Total"
      ? items[0].value
      : items.reduce((s, i) => s + i.value, 0);
  const toneClasses = TONE_CLASSES[tone];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!onClick) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  if (error) {
    const destructiveClasses = TONE_CLASSES.destructive;
    return (
      <Card
        role="region"
        aria-labelledby={headingId}
        className={cn(
          "flex min-w-[200px] flex-1 basis-[200px] flex-col gap-2 border-t-4 bg-card p-5",
          destructiveClasses.borderTop,
        )}
      >
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md",
              destructiveClasses.bgSubtle,
            )}
          >
            <AlertCircle
              className={cn("h-4 w-4", destructiveClasses.text)}
              aria-hidden="true"
            />
          </span>
          <span
            id={headingId}
            className="text-base font-semibold text-foreground"
          >
            {title}
          </span>
        </div>
        <p className={cn("text-xs", destructiveClasses.text)}>{error}</p>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="mt-1 self-start"
            aria-label={`Retry loading ${title}`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        )}
      </Card>
    );
  }

  // Resolve the semantic colour: when an "up" trend is bad (e.g. failed
  // counts going up) we want destructive instead of success. Flat is always
  // muted-foreground regardless of direction.
  const trendDirectionIsPositive =
    trend &&
    trend.direction !== "flat" &&
    ((goodDirection === "up" && trend.direction === "up") ||
      (goodDirection === "down" && trend.direction === "down"));

  const TrendIcon =
    trend?.direction === "up"
      ? TrendingUp
      : trend?.direction === "down"
        ? TrendingDown
        : Minus;
  const trendToneClass =
    trend?.direction === "flat"
      ? "text-muted-foreground"
      : trendDirectionIsPositive
        ? "text-success"
        : "text-destructive";
  const trendSrText = trend
    ? `${
        trend.direction === "up"
          ? "up"
          : trend.direction === "down"
            ? "down"
            : "unchanged"
      } ${trend.pct}% from ${trend.period}`
    : "";

  const isClickable = !!onClick;

  return (
    <Card
      role={isClickable ? "button" : "region"}
      aria-labelledby={headingId}
      data-clickable={isClickable ? "true" : "false"}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      tabIndex={isClickable ? 0 : undefined}
      className={cn(
        "relative min-w-[200px] flex-1 basis-[200px] border-t-4 bg-card p-5 transition-all duration-200 ease-out motion-reduce:transition-none",
        toneClasses.borderTop,
        isClickable &&
          "cursor-pointer hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:translate-y-0 active:bg-muted/30 focus-visible:-translate-y-0.5 focus-visible:border-primary/40 focus-visible:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transform-none",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md",
            toneClasses.bgSubtle,
          )}
        >
          <IconComp className={cn("h-4 w-4", toneClasses.text)} />
        </span>
        <span
          id={headingId}
          className="flex items-center gap-1 text-base font-semibold text-foreground"
        >
          {title}
          {info && (
            <InfoTooltip
              content={info}
              ariaLabel={`What is ${title}?`}
              size={12}
              // Stop click from bubbling to the clickable Card.
              className="hover:text-foreground"
            />
          )}
        </span>
        <span
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            "ml-auto text-2xl font-bold tabular-nums",
            toneClasses.text,
          )}
        >
          <NumberTicker value={total} />
        </span>
      </div>
      {(trend || (sparkData && sparkData.length >= 2)) && (
        <div className="mt-1 flex items-center justify-between gap-3">
          {trend ? (
            <div
              className={cn(
                "flex items-center gap-1 text-2xs font-medium",
                trendToneClass,
              )}
              aria-hidden="true"
            >
              <TrendIcon className="h-3 w-3" />
              <span className="tabular-nums">{trend.pct}%</span>
              <span className="text-muted-foreground">vs {trend.period}</span>
            </div>
          ) : (
            <span aria-hidden="true" />
          )}
          {sparkData && sparkData.length >= 2 && (
            <Sparkline
              data={sparkData}
              tone={sparkTone ?? (tone as SparklineTone)}
              width={72}
              height={20}
              ariaLabel={`${title} trend`}
            />
          )}
        </div>
      )}
      {trend && <span className="sr-only">{trendSrText}</span>}
      <div className="mt-3 flex flex-wrap gap-4">
        {items.map((item) => (
          <div key={item.label} className="flex flex-col">
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">
              {item.label}
            </span>
            <span
              className={cn(
                "text-lg font-semibold tabular-nums",
                item.tone ? TONE_CLASSES[item.tone].text : "text-foreground",
              )}
            >
              <NumberTicker value={item.value} />
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Cluster Health card — traffic-light grid of regions + healthy-region trend
// ---------------------------------------------------------------------------

interface ClusterHealthRow {
  name: string;
  healthy: number;
  total: number;
}

interface ClusterHealthCardProps {
  regions: ClusterHealthRow[];
  historyHealthy: number[];
  historyUnhealthy: number[];
  onDrillDown: (region: string) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  statusFilter: RegionStatusFilter;
  onStatusFilterChange: (f: RegionStatusFilter) => void;
}

function classifyRegion(
  r: ClusterHealthRow,
): { tone: Tone; label: string; bucket: RegionStatusFilter } {
  if (r.total === 0)
    return { tone: "info", label: "no data", bucket: "nodata" };
  if (r.healthy === r.total)
    return { tone: "success", label: "healthy", bucket: "healthy" };
  if (r.healthy === 0)
    return { tone: "destructive", label: "down", bucket: "down" };
  return { tone: "warning", label: "degraded", bucket: "degraded" };
}

const ClusterHealthCard: React.FC<ClusterHealthCardProps> = ({
  regions,
  historyHealthy,
  historyUnhealthy,
  onDrillDown,
  searchQuery,
  onSearchQueryChange,
  statusFilter,
  onStatusFilterChange,
}) => {
  const counts = React.useMemo(() => {
    let healthy = 0;
    let degraded = 0;
    let down = 0;
    let nodata = 0;
    for (const r of regions) {
      const c = classifyRegion(r);
      if (c.bucket === "healthy") healthy += 1;
      else if (c.bucket === "degraded") degraded += 1;
      else if (c.bucket === "down") down += 1;
      else nodata += 1;
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
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (statusFilter === "all") return true;
      const c = classifyRegion(r);
      return c.bucket === statusFilter;
    });
  }, [regions, searchQuery, statusFilter]);

  const overallTone: Tone =
    counts.down > 0
      ? "destructive"
      : counts.degraded > 0
        ? "warning"
        : "success";
  const overallToneClasses = TONE_CLASSES[overallTone];

  const filterChipCount: Record<RegionStatusFilter, number> = {
    all: counts.total,
    healthy: counts.healthy,
    degraded: counts.degraded,
    down: counts.down,
    nodata: counts.nodata,
  };

  return (
    <Card
      role="region"
      aria-labelledby="cluster-health-heading"
      className={cn(
        "border-l-4 bg-card p-4",
        overallToneClasses.borderTop.replace("border-t-", "border-l-"),
      )}
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2
            id="cluster-health-heading"
            className="m-0 text-base font-semibold text-foreground"
          >
            Cluster Health
          </h2>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider",
              overallToneClasses.bgSubtle,
              overallToneClasses.text,
            )}
            aria-label={`Overall status: ${overallTone}`}
          >
            {overallTone === "success"
              ? "All regions healthy"
              : overallTone === "warning"
                ? "Degraded"
                : "Outage"}
          </span>
        </div>
        <div className="flex flex-wrap gap-3 text-2xs text-muted-foreground tabular-nums">
          <span>
            <strong className="text-foreground">{counts.healthy}</strong>
            <span className="ml-0.5">healthy</span>
          </span>
          {counts.degraded > 0 && (
            <span>
              <strong className="text-warning">{counts.degraded}</strong>
              <span className="ml-0.5">degraded</span>
            </span>
          )}
          {counts.down > 0 && (
            <span>
              <strong className="text-destructive">{counts.down}</strong>
              <span className="ml-0.5">down</span>
            </span>
          )}
          <span>
            <strong className="text-foreground">{counts.total}</strong>
            <span className="ml-0.5">total</span>
          </span>
          {historyHealthy.length >= 2 && (
            <Sparkline
              data={historyHealthy}
              tone="success"
              width={64}
              height={16}
              ariaLabel="Healthy regions trend"
            />
          )}
        </div>
      </div>

      {/* Search + quick-filter chips. Both URL-synced via the parent so a
          deep link "?regionStatus=down&regionSearch=eastus" lands the
          operator inside the filtered view directly. */}
      {regions.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 sm:max-w-[260px]">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              placeholder="Filter regions..."
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              aria-label="Filter regions by name"
              className="h-8 pl-7 pr-7"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchQueryChange("")}
                aria-label="Clear region search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            )}
          </div>
          <div
            role="group"
            aria-label="Filter regions by status"
            className="flex flex-wrap items-center gap-1"
          >
            {REGION_STATUS_FILTERS.map((f) => {
              const count = filterChipCount[f.key];
              const disabled = f.key !== "all" && count === 0;
              const active = statusFilter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => onStatusFilterChange(f.key)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-wider transition-colors duration-fast",
                    active
                      ? "border-primary/60 bg-primary/15 text-primary"
                      : "border-border bg-card/40 text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                    disabled && "cursor-not-allowed opacity-40 hover:bg-card/40",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  )}
                >
                  <span>{f.label}</span>
                  <span className="tabular-nums opacity-80">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {filteredRegions.length === 0 && regions.length > 0 ? (
        <p className="m-0 text-xs text-muted-foreground">
          No regions match the current filter.
        </p>
      ) : (
        <ul
          className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
          role="list"
          aria-label="Region status grid"
        >
          {filteredRegions.map((r) => {
            const cls = classifyRegion(r);
            const t = TONE_CLASSES[cls.tone];
            return (
              <li key={r.name}>
                <button
                  type="button"
                  onClick={() => onDrillDown(r.name)}
                  className={cn(
                    "group flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors duration-fast",
                    t.bgSubtle,
                    t.border,
                    "hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  )}
                  aria-label={`${r.name}: ${cls.label}, ${r.healthy} of ${r.total} healthy`}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "inline-block h-1.5 w-1.5 rounded-full",
                        t.bg,
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate font-mono text-xs text-foreground">
                      {r.name}
                    </span>
                  </span>
                  <span className="flex items-center justify-between text-2xs text-muted-foreground">
                    <span className={cn("uppercase tracking-wider", t.text)}>
                      {cls.label}
                    </span>
                    <span className="tabular-nums">
                      {r.healthy}/{r.total}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {historyUnhealthy.length >= 2 &&
        historyUnhealthy.some((v) => v > 0) && (
          <p className="mt-3 text-2xs text-muted-foreground">
            Unhealthy region trend over the last{" "}
            {historyUnhealthy.length} sample
            {historyUnhealthy.length === 1 ? "" : "s"}:{" "}
            <Sparkline
              data={historyUnhealthy}
              tone="destructive"
              width={120}
              height={14}
              ariaLabel="Unhealthy regions trend"
              className="ml-1 align-middle"
            />
          </p>
        )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Agent Status Strip
// ---------------------------------------------------------------------------

const AGENT_STATUS_DOT: Record<string, string> = {
  idle: "bg-muted-foreground/40",
  running: "bg-info shadow-[0_0_6px_hsl(var(--info))]",
  completed: "bg-success",
  error: "bg-destructive",
};

const AgentStatusStrip: React.FC = () => {
  const state = useMultiRegionState();
  const entries = Object.entries(state.agentStatuses);

  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Agents
      </span>
      {entries.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          No agents registered.
        </span>
      ) : (
        entries.map(([name, status]) => (
          <div
            key={name}
            className="flex items-center gap-1.5"
            title={`${name}: ${status}`}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full transition-shadow duration-200 motion-reduce:transition-none",
                AGENT_STATUS_DOT[status] ?? "bg-muted-foreground/40",
              )}
              aria-hidden="true"
            />
            <span className="text-xs text-muted-foreground">{name}</span>
            <span className="text-2xs text-muted-foreground/60">
              ({status})
            </span>
          </div>
        ))
      )}
    </Card>
  );
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
function formatLogTime(ts: string | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString();
}

interface RecentActivityProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const RecentActivity: React.FC<RecentActivityProps> = ({
  collapsed,
  onToggleCollapsed,
}) => {
  const state = useMultiRegionState();
  const recentLogs = React.useMemo(
    () => state.agentLogs.slice(-8),
    [state.agentLogs],
  );

  const errorCount = React.useMemo(
    () => recentLogs.filter((l) => l.level === "error").length,
    [recentLogs],
  );

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="recent-activity-body"
          className="inline-flex items-baseline gap-1.5 rounded-sm text-base font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          {collapsed ? (
            <ChevronRight
              className="h-3.5 w-3.5 self-center text-muted-foreground"
              aria-hidden
            />
          ) : (
            <ChevronDown
              className="h-3.5 w-3.5 self-center text-muted-foreground"
              aria-hidden
            />
          )}
          <span>Recent Activity</span>
          {errorCount > 0 && (
            <span
              className={cn(
                "ml-1 rounded-full px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wider",
                TONE_CLASSES.destructive.bgSubtle,
                TONE_CLASSES.destructive.text,
              )}
              aria-label={`${errorCount} recent error${errorCount === 1 ? "" : "s"}`}
            >
              {errorCount} err
            </span>
          )}
        </button>
        {recentLogs.length > 0 && (
          <span className="text-2xs text-muted-foreground">
            Last {recentLogs.length} event{recentLogs.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {!collapsed && (
        <div id="recent-activity-body">
          {recentLogs.length === 0 ? (
            <p className="m-0 text-xs text-muted-foreground">
              No activity yet. Trigger a refresh to begin populating events.
            </p>
          ) : (
            <HoverList
              items={recentLogs}
              getKey={(log, i) => `${log.timestamp}-${i}`}
              tone="primary"
              className="gap-1.5"
              renderItem={(log) => (
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="min-w-[60px] font-mono text-2xs text-muted-foreground/70 tabular-nums">
                    {formatLogTime(log.timestamp)}
                  </span>
                  <StatusBadge status={log.level} />
                  <span className="text-xs text-muted-foreground">
                    [{log.agent}]
                  </span>
                  <span
                    className={cn(
                      "flex-1 overflow-hidden text-ellipsis whitespace-nowrap",
                      log.level === "error"
                        ? "text-destructive"
                        : "text-foreground/80",
                    )}
                  >
                    {log.message}
                  </span>
                </div>
              )}
            />
          )}
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Quick Actions
// ---------------------------------------------------------------------------

const QuickActions: React.FC<{
  store: MultiRegionStore;
  onNavigate: (key: PageKey) => void;
}> = ({ store, onNavigate }) => {
  const state = useMultiRegionState();
  const failedAccounts = state.accounts.filter(
    (a) => a.provisioningState === "failed",
  ).length;
  const failedPools = state.pools.filter(
    (p) => p.provisioningState === "failed",
  ).length;
  const totalFailed = failedAccounts + failedPools;

  const [retryConfirm, setRetryConfirm] = React.useState(false);

  const handleRetryFailed = React.useCallback(() => {
    if (failedAccounts > 0) store.retryFailedAccounts();
    if (failedPools > 0) store.retryFailedPools();
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
    } catch (e) {
      store.addNotification({
        type: "error",
        message: `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [store]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {totalFailed > 0 && (
          <Button
            variant="outline"
            onClick={() => setRetryConfirm(true)}
            className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Retry ${totalFailed} failed items`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry {totalFailed} Failed
          </Button>
        )}
        <Button
          variant="outline"
          onClick={handleExportSession}
          aria-label="Export session as JSON"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Export Session
        </Button>
        <Button
          variant="outline"
          onClick={() => onNavigate("gpu-calculator")}
          aria-label="Open the GPU Calculator"
        >
          <HardDrive className="h-3.5 w-3.5" aria-hidden />
          GPU Calculator
        </Button>
        <Button
          variant="outline"
          onClick={() => onNavigate("monitoring")}
          aria-label="Open the Monitoring page"
        >
          <Server className="h-3.5 w-3.5" aria-hidden />
          Open Monitoring
        </Button>
        <span className="flex items-center gap-1 text-2xs text-muted-foreground">
          Session
          <span className="font-mono text-2xs text-foreground/80">
            {store.sessionId}
          </span>
          <CopyButton
            value={store.sessionId}
            alwaysVisible
            iconSize={11}
            ariaLabel="Copy session id"
          />
        </span>
      </div>

      <ConfirmationDialog
        hidden={!retryConfirm}
        title={`Retry ${totalFailed} failed item${totalFailed === 1 ? "" : "s"}?`}
        message={
          <div className="flex flex-col gap-2 text-sm">
            <p className="m-0">
              This resets the provisioning state of failed items back to{" "}
              <span className="font-mono text-2xs">pending</span> so the next
              auto-recovery sweep (or a manual re-run) will pick them up.
            </p>
            <ul className="m-0 list-disc pl-5 text-xs">
              {failedAccounts > 0 && (
                <li>
                  {failedAccounts} failed account
                  {failedAccounts === 1 ? "" : "s"}
                </li>
              )}
              {failedPools > 0 && (
                <li>
                  {failedPools} failed pool{failedPools === 1 ? "" : "s"}
                </li>
              )}
            </ul>
          </div>
        }
        confirmText="Reset to pending"
        cancelText="Cancel"
        onConfirm={handleRetryFailed}
        onCancel={() => setRetryConfirm(false)}
      />
    </>
  );
};

// ---------------------------------------------------------------------------
// Unused Quota section — DataTable migration
// ---------------------------------------------------------------------------

interface QuotaSuggestionRow extends QuotaSuggestion {
  rowId: string;
  index: number;
}

interface UnusedQuotaSectionProps {
  orchestrator: OrchestratorAgent;
  store: MultiRegionStore;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
}

const UnusedQuotaSection: React.FC<UnusedQuotaSectionProps> = ({
  orchestrator,
  store,
  searchQuery,
  onSearchQueryChange,
  searchInputRef,
}) => {
  const state = useMultiRegionState();
  const [detecting, setDetecting] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<QuotaSuggestion[]>([]);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // Surface the most-recent error inline so the operator isn't left
  // wondering "did detect actually run?" when an exception is swallowed by
  // the orchestrator notification path. Cleared on the next successful run.
  const [detectError, setDetectError] = React.useState<string | null>(null);
  const [createError, setCreateError] = React.useState<string | null>(null);

  // Track unmount so we don't update state from a stale async path.
  const aliveRef = React.useRef(true);
  React.useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  const accountsWithFreeQuota = React.useMemo(
    () =>
      state.accountInfos.filter(
        (a) => a.lowPriorityCoresFree > 0 || a.dedicatedCoresFree > 0,
      ),
    [state.accountInfos],
  );

  const totalFreeLpCores = React.useMemo(
    () => accountsWithFreeQuota.reduce((s, a) => s + a.lowPriorityCoresFree, 0),
    [accountsWithFreeQuota],
  );

  const rows = React.useMemo<QuotaSuggestionRow[]>(
    () =>
      suggestions.map((s, index) => ({
        ...s,
        index,
        rowId: `${s.accountId}-${s.vmSize}-${index}`,
      })),
    [suggestions],
  );

  const filteredRows = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      return (
        r.accountName.toLowerCase().includes(q) ||
        r.region.toLowerCase().includes(q) ||
        r.vmSize.toLowerCase().includes(q)
      );
    });
  }, [rows, searchQuery]);

  // Whenever the filter narrows the visible set, prune selections to
  // visible rows only so "Auto-Create N" never silently provisions a row
  // the user can't see.
  const visibleIds = React.useMemo(
    () => new Set(filteredRows.map((r) => r.rowId)),
    [filteredRows],
  );
  const effectiveSelection = React.useMemo(() => {
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (visibleIds.has(id)) next.add(id);
    }
    return next;
  }, [selectedIds, visibleIds]);

  const handleDetect = React.useCallback(async () => {
    setDetecting(true);
    setSuggestions([]);
    setSelectedIds(new Set());
    setDetectError(null);
    try {
      const result = await orchestrator.execute({
        action: "detect_unused_quota",
        payload: {},
      });
      if (!aliveRef.current) return;
      const items = (result.summary as Record<string, unknown>)
        ?.suggestions as QuotaSuggestion[] | undefined;
      setSuggestions(items ?? []);
      store.addAuditEntry({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        actor: "overview-page",
        action: "detect_unused_quota",
        target: `${state.accountInfos.length} accounts`,
        status: "success",
        details: { suggestionCount: items?.length ?? 0 },
      });
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setDetectError(msg);
      store.addAuditEntry({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        actor: "overview-page",
        action: "detect_unused_quota",
        target: `${state.accountInfos.length} accounts`,
        status: "failure",
        error: msg,
      });
    } finally {
      if (aliveRef.current) setDetecting(false);
    }
  }, [orchestrator, store, state.accountInfos.length]);

  const performAutoCreate = React.useCallback(async () => {
    const selected = filteredRows.filter((r) => effectiveSelection.has(r.rowId));
    if (selected.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      // Strip row-only fields before handing the payload to the orchestrator.
      const payload: QuotaSuggestion[] = selected.map((r) => ({
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
      await orchestrator.execute({
        action: "auto_create_pools_from_quota",
        payload: { suggestions: payload },
      });
      if (!aliveRef.current) return;
      // Selection no longer makes sense once provisioning kicked off.
      setSelectedIds(new Set());
      store.addAuditEntry({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        actor: "overview-page",
        action: "auto_create_pools_from_quota",
        target: `${selected.length} pools across ${new Set(selected.map((s) => s.region)).size} regions`,
        status: "success",
        details: {
          poolCount: selected.length,
          regions: Array.from(new Set(selected.map((s) => s.region))),
        },
      });
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setCreateError(msg);
      store.addAuditEntry({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        actor: "overview-page",
        action: "auto_create_pools_from_quota",
        target: `${selected.length} pools`,
        status: "failure",
        error: msg,
      });
    } finally {
      if (aliveRef.current) setCreating(false);
    }
  }, [orchestrator, store, filteredRows, effectiveSelection]);

  const handleAutoCreateConfirmed = React.useCallback(async () => {
    setConfirmOpen(false);
    await performAutoCreate();
  }, [performAutoCreate]);

  // Bulk-selection helpers — useful when the filtered set is small or the
  // operator wants "every region with > 0 max LP nodes" in one click.
  const selectAllVisible = React.useCallback(() => {
    const next = new Set(selectedIds);
    for (const r of filteredRows) next.add(r.rowId);
    setSelectedIds(next);
  }, [filteredRows, selectedIds]);

  const selectViableOnly = React.useCallback(() => {
    // "Viable" = at least one max-node bucket has a positive value, i.e.
    // the suggested VM size would actually fit at least one node.
    const next = new Set(selectedIds);
    for (const r of filteredRows) {
      if (r.maxLpNodes > 0 || r.maxDedicatedNodes > 0) next.add(r.rowId);
    }
    setSelectedIds(next);
  }, [filteredRows, selectedIds]);

  const clearSelection = React.useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const columns = React.useMemo<DataTableColumn<QuotaSuggestionRow>[]>(
    () => [
      {
        id: "accountName",
        header: "Account",
        cell: (r) => <span className="text-foreground">{r.accountName}</span>,
        sort: (a, b) => a.accountName.localeCompare(b.accountName),
        csv: (r) => r.accountName,
      },
      {
        id: "region",
        header: "Region",
        cell: (r) => <span className="text-muted-foreground">{r.region}</span>,
        sort: (a, b) => a.region.localeCompare(b.region),
        csv: (r) => r.region,
      },
      {
        id: "freeLpCores",
        header: "Free LP",
        className: "text-right",
        cell: (r) => (
          <span
            className={cn(
              "font-medium tabular-nums",
              TONE_CLASSES.primary.text,
            )}
          >
            {formatNumber(r.freeLpCores)}
          </span>
        ),
        sort: (a, b) => a.freeLpCores - b.freeLpCores,
        csv: (r) => r.freeLpCores,
      },
      {
        id: "freeDedicatedCores",
        header: "Free Dedicated",
        className: "text-right",
        cell: (r) => (
          <span
            className={cn(
              "font-medium tabular-nums",
              TONE_CLASSES.info.text,
            )}
          >
            {formatNumber(r.freeDedicatedCores)}
          </span>
        ),
        sort: (a, b) => a.freeDedicatedCores - b.freeDedicatedCores,
        csv: (r) => r.freeDedicatedCores,
      },
      {
        id: "vmSize",
        header: "VM Size",
        cell: (r) => (
          <span className="font-mono text-xs text-foreground">{r.vmSize}</span>
        ),
        sort: (a, b) => a.vmSize.localeCompare(b.vmSize),
        csv: (r) => r.vmSize,
      },
      {
        id: "maxLpNodes",
        header: "Max LP Nodes",
        className: "text-right",
        cell: (r) => (
          <span
            className={cn(
              "tabular-nums",
              r.maxLpNodes > 0
                ? TONE_CLASSES.success.text
                : "text-muted-foreground/60",
            )}
          >
            {formatNumber(r.maxLpNodes)}
          </span>
        ),
        sort: (a, b) => a.maxLpNodes - b.maxLpNodes,
        csv: (r) => r.maxLpNodes,
      },
      {
        id: "maxDedicatedNodes",
        header: "Max Dedicated Nodes",
        className: "text-right",
        cell: (r) => (
          <span
            className={cn(
              "tabular-nums",
              r.maxDedicatedNodes > 0
                ? TONE_CLASSES.success.text
                : "text-muted-foreground/60",
            )}
          >
            {formatNumber(r.maxDedicatedNodes)}
          </span>
        ),
        sort: (a, b) => a.maxDedicatedNodes - b.maxDedicatedNodes,
        csv: (r) => r.maxDedicatedNodes,
      },
    ],
    [],
  );

  const piggyBankClasses = TONE_CLASSES.warning;

  const detectDisabled = detecting || state.accountInfos.length === 0;
  const detectButton = (
    <Button
      variant="outline"
      onClick={handleDetect}
      disabled={detectDisabled}
      className="ml-auto"
      aria-label="Detect unused quota"
    >
      <Search className="h-3.5 w-3.5" />
      {rows.length > 0 ? "Re-detect" : "Detect Unused Quota"}
    </Button>
  );

  const detectDisabledReason = detecting
    ? "Detection already in progress."
    : state.accountInfos.length === 0
      ? "Refresh account info first to detect unused quota."
      : null;

  const viableCount = React.useMemo(
    () =>
      filteredRows.filter(
        (r) => r.maxLpNodes > 0 || r.maxDedicatedNodes > 0,
      ).length,
    [filteredRows],
  );

  // The ExportMenu wants a column descriptor with explicit accessors —
  // mirror the DataTable's CSV columns so the file content matches what
  // the operator sees in the UI.
  const exportColumns = React.useMemo(
    () => [
      { header: "Account", accessor: (r: QuotaSuggestionRow) => r.accountName },
      { header: "Region", accessor: (r: QuotaSuggestionRow) => r.region },
      { header: "Free LP", accessor: (r: QuotaSuggestionRow) => r.freeLpCores },
      {
        header: "Free Dedicated",
        accessor: (r: QuotaSuggestionRow) => r.freeDedicatedCores,
      },
      { header: "VM Size", accessor: (r: QuotaSuggestionRow) => r.vmSize },
      {
        header: "vCPUs per VM",
        accessor: (r: QuotaSuggestionRow) => r.vmSizeVCpus,
      },
      {
        header: "Max LP Nodes",
        accessor: (r: QuotaSuggestionRow) => r.maxLpNodes,
      },
      {
        header: "Max Dedicated Nodes",
        accessor: (r: QuotaSuggestionRow) => r.maxDedicatedNodes,
      },
    ],
    [],
  );

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md",
            piggyBankClasses.bgSubtle,
          )}
        >
          <PiggyBank className={cn("h-4 w-4", piggyBankClasses.text)} />
        </span>
        <h2 className="m-0 text-base font-semibold text-foreground">
          Unused Quota
        </h2>
        <InfoTooltip
          content="Detects accounts with free LP / Dedicated cores and suggests VM sizes that would fit. Use Auto-Create to provision pools in bulk via the orchestrator."
          ariaLabel="What is unused quota detection?"
          size={13}
        />
        {state.accountInfos.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {accountsWithFreeQuota.length} account
            {accountsWithFreeQuota.length === 1 ? "" : "s"} with{" "}
            {formatNumber(totalFreeLpCores)} free LP cores
          </span>
        )}
        {detectDisabledReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto">{detectButton}</span>
            </TooltipTrigger>
            <TooltipContent side="top">{detectDisabledReason}</TooltipContent>
          </Tooltip>
        ) : (
          detectButton
        )}
        {detecting && (
          <Loader2
            className="h-4 w-4 animate-spin text-muted-foreground"
            aria-label="Detecting unused quota"
          />
        )}
      </div>

      {/* Surface the most recent detect/create error inline. The orchestrator
          also fires a toast, but toasts auto-dismiss; pinning the message
          here keeps it visible until the next successful action. */}
      {(detectError || createError) && (
        <div
          role="alert"
          className={cn(
            "mb-3 flex items-start gap-2 rounded-md border p-2 text-2xs",
            TONE_CLASSES.destructive.border,
            TONE_CLASSES.destructive.bgSubtle,
            TONE_CLASSES.destructive.text,
          )}
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{detectError ?? createError}</span>
          <button
            type="button"
            onClick={() => {
              setDetectError(null);
              setCreateError(null);
            }}
            className="rounded p-0.5 hover:bg-destructive/20"
            aria-label="Dismiss error"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-col gap-3">
          {/* Toolbar — search + bulk-select helpers + export. Pressing
              "/" anywhere on the page focuses this input. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 sm:max-w-[280px]">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                ref={searchInputRef}
                type="search"
                placeholder="Filter by account, region, VM size..."
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                aria-label="Filter unused-quota suggestions"
                className="h-8 pl-7 pr-7"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => onSearchQueryChange("")}
                  aria-label="Clear quota search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={selectAllVisible}
              disabled={filteredRows.length === 0}
              aria-label="Select all visible rows"
            >
              Select all ({filteredRows.length})
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={selectViableOnly}
              disabled={viableCount === 0}
              aria-label="Select only rows with viable node counts"
            >
              Select viable ({viableCount})
            </Button>
            {effectiveSelection.size > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearSelection}
                aria-label="Clear selection"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Clear
              </Button>
            )}
            <ExportMenu
              rows={filteredRows}
              columns={exportColumns}
              filename="overview-quota-suggestions"
              jsonMetadata={{
                source: "overview-page",
                searchQuery,
                totalSuggestions: rows.length,
              }}
            />
          </div>

          {searchQuery && (
            <p className="m-0 text-2xs text-muted-foreground">
              Showing {filteredRows.length} of {rows.length} suggestion
              {rows.length === 1 ? "" : "s"} matching{" "}
              <span className="font-mono">&quot;{searchQuery}&quot;</span>
            </p>
          )}

          <DataTable<QuotaSuggestionRow>
            tableId="overview-quota-suggestions"
            rows={filteredRows}
            columns={columns}
            rowKey={(r) => r.rowId}
            selection={selectedIds}
            onSelectionChange={setSelectedIds}
            initialSort={{ column: "freeLpCores", direction: "desc" }}
            csvFileName="overview-quota-suggestions.csv"
          />

          <div className="flex flex-wrap items-center gap-2">
            {(() => {
              const autoCreateButton = (
                <Button
                  variant="default"
                  onClick={() => setConfirmOpen(true)}
                  disabled={effectiveSelection.size === 0 || creating}
                  aria-label={`Auto-create ${effectiveSelection.size} pools`}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Auto-Create Pools ({effectiveSelection.size})
                </Button>
              );
              const reason = creating
                ? "Pool creation in progress."
                : effectiveSelection.size === 0
                  ? "Select one or more visible rows to auto-create pools."
                  : null;
              return reason ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>{autoCreateButton}</span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{reason}</TooltipContent>
                </Tooltip>
              ) : (
                autoCreateButton
              );
            })()}
            {creating && (
              <Loader2
                className="h-4 w-4 animate-spin text-muted-foreground"
                aria-label="Creating pools"
              />
            )}
            <span className="text-xs text-muted-foreground">
              {effectiveSelection.size} of {filteredRows.length} visible
              selected
              {selectedIds.size > effectiveSelection.size && (
                <>
                  {" "}
                  <span className="text-muted-foreground/70">
                    ({selectedIds.size - effectiveSelection.size} hidden by
                    filter)
                  </span>
                </>
              )}
            </span>
          </div>
        </div>
      )}

      {detecting && rows.length === 0 && (
        <SkeletonLoader variant="table" rows={4} columns={5} />
      )}

      {rows.length === 0 &&
        !detecting &&
        state.accountInfos.length > 0 && (
          <EmptyState
            icon={Search}
            title="No suggestions yet"
            description="Click Detect Unused Quota to find accounts with available cores for new GPU pools."
            action={{
              label: "Detect Unused Quota",
              icon: Search,
              onClick: handleDetect,
              loading: detecting,
            }}
          />
        )}

      {state.accountInfos.length === 0 && !detecting && (
        <EmptyState
          icon={PiggyBank}
          title="No account info loaded"
          description="Refresh account info first to detect unused quota for new pools."
        />
      )}

      <ConfirmationDialog
        hidden={!confirmOpen}
        title="Auto-create pools?"
        message={
          <div className="flex flex-col gap-2 text-sm">
            <p className="m-0">
              Create {effectiveSelection.size} pool
              {effectiveSelection.size === 1 ? "" : "s"} using the suggested VM
              sizes and free quota? Pools will be provisioned via the
              orchestrator.
            </p>
            <ul className="m-0 list-disc pl-5 text-xs text-muted-foreground">
              <li>
                {
                  new Set(
                    filteredRows
                      .filter((r) => effectiveSelection.has(r.rowId))
                      .map((r) => r.region),
                  ).size
                }{" "}
                distinct region
                {new Set(
                  filteredRows
                    .filter((r) => effectiveSelection.has(r.rowId))
                    .map((r) => r.region),
                ).size === 1
                  ? ""
                  : "s"}
              </li>
              <li>
                {formatNumber(
                  filteredRows
                    .filter((r) => effectiveSelection.has(r.rowId))
                    .reduce((s, r) => s + r.maxLpNodes, 0),
                )}{" "}
                low-priority nodes total
              </li>
              <li>
                {formatNumber(
                  filteredRows
                    .filter((r) => effectiveSelection.has(r.rowId))
                    .reduce((s, r) => s + r.maxDedicatedNodes, 0),
                )}{" "}
                dedicated nodes total
              </li>
            </ul>
          </div>
        }
        confirmText="Auto-create"
        cancelText="Cancel"
        loading={creating}
        onConfirm={handleAutoCreateConfirmed}
        onCancel={() => setConfirmOpen(false)}
      />
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Main Overview Page
// ---------------------------------------------------------------------------

export interface OverviewPageProps {
  orchestrator: OrchestratorAgent;
  store: MultiRegionStore;
  onNavigate: (key: PageKey) => void;
}

type CardErrorMap = {
  accounts?: string | null;
  pools?: string | null;
  nodes?: string | null;
  accountInfo?: string | null;
};

const OverviewPageInner: React.FC<OverviewPageProps> = ({
  orchestrator,
  store,
  onNavigate,
}) => {
  const stats = useDashboardStats();
  const state = useMultiRegionState();
  const navigate = useNavigate();
  const [refreshing, setRefreshing] = React.useState(false);
  const [cardErrors, setCardErrors] = React.useState<CardErrorMap>({});

  // Single URL-state bag — collapsing every flag into one record keeps the
  // url-state hook's effect dependency stable and the URL ordering tidy.
  const [urlState, setUrlState] = useUrlState({
    range: "24h" as string,
    regionSearch: "" as string,
    regionStatus: "all" as string,
    quotaSearch: "" as string,
    activity: "on" as string,
  });

  const rangeRaw = urlState.range ?? "24h";
  const range: RangeKey = isRangeKey(rangeRaw as string)
    ? (rangeRaw as RangeKey)
    : "24h";

  const regionSearch = (urlState.regionSearch as string) ?? "";
  const regionStatusRaw = (urlState.regionStatus as string) ?? "all";
  const regionStatus: RegionStatusFilter = isRegionStatusFilter(regionStatusRaw)
    ? regionStatusRaw
    : "all";
  const quotaSearch = (urlState.quotaSearch as string) ?? "";
  const activityCollapsed = urlState.activity === "off";

  // Track unmount so we don't update state from async refresh paths after
  // the component has gone away (fixes a "Can't perform a React state
  // update on an unmounted component" race during rapid nav).
  const aliveRef = React.useRef(true);
  React.useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  // ARM-token expiry tracker for the primary signed-in account. The
  // operator may park on this dashboard with auto-refresh on for an
  // entire shift, and every drill-down KPI click (accounts / pools /
  // nodes) lands on an ARM-heavy page. Surface a TokenExpiryBadge near
  // the page header so they get a heads-up — and a one-click force-
  // refresh — before they click through. No local `armToken` state
  // here, so we skip the sync-bridge pattern other pages use.
  const primaryAccount = (state.azureAccounts ?? [])[0];
  const armTokenTracker = useArmToken(
    primaryAccount?.homeAccountId,
    primaryAccount?.tenantId,
  );

  const dedicatedUsed = React.useMemo(
    () => state.accountInfos.reduce((s, a) => s + a.dedicatedCoresUsed, 0),
    [state.accountInfos],
  );
  const dedicatedQuota = React.useMemo(
    () => state.accountInfos.reduce((s, a) => s + a.dedicatedCoreQuota, 0),
    [state.accountInfos],
  );
  const lpUsed = React.useMemo(
    () => state.accountInfos.reduce((s, a) => s + a.lowPriorityCoresUsed, 0),
    [state.accountInfos],
  );
  const lpQuota = React.useMemo(
    () => state.accountInfos.reduce((s, a) => s + a.lowPriorityCoreQuota, 0),
    [state.accountInfos],
  );

  const regionHealthRows = React.useMemo(() => {
    const accountById = new Map(state.accounts.map((a) => [a.id, a]));
    const map = new Map<string, { healthy: number; total: number }>();
    for (const info of state.accountInfos) {
      const entry = map.get(info.region) ?? { healthy: 0, total: 0 };
      entry.total += 1;
      const acct = accountById.get(info.id);
      const isHealthy =
        !acct || (acct.provisioningState !== "failed" && !acct.error);
      if (isHealthy) entry.healthy += 1;
      map.set(info.region, entry);
    }
    return Array.from(map.entries()).map(([name, v]) => ({
      name,
      healthy: v.healthy,
      total: v.total,
    }));
  }, [state.accountInfos, state.accounts]);

  // Sparkline data derived from the rolling history buffer. One series per
  // KPI card — kept in this single useMemo so the buffer is walked once
  // per re-render instead of five times. Guard against legacy session
  // blobs that pre-date the history field (`state.history` would be
  // undefined and `.map` would throw).
  const sparkSeries = React.useMemo(() => {
    const h = state.history ?? [];
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

  const retryAction = React.useCallback(
    async (
      action: "refresh_account_info" | "refresh_pool_info",
      keys: Array<keyof CardErrorMap>,
    ) => {
      try {
        await orchestrator.execute({ action, payload: {} });
        if (!aliveRef.current) return;
        setCardErrors((prev) => {
          const next = { ...prev };
          keys.forEach((k) => {
            next[k] = null;
          });
          return next;
        });
      } catch (e) {
        if (!aliveRef.current) return;
        const msg = e instanceof Error ? e.message : "Refresh failed";
        setCardErrors((prev) => {
          const next = { ...prev };
          keys.forEach((k) => {
            next[k] = msg;
          });
          return next;
        });
      }
    },
    [orchestrator],
  );

  const handleRefreshAll = React.useCallback(async () => {
    setRefreshing(true);
    // Run both refresh actions concurrently and collect outcomes via
    // `Promise.allSettled` so a slow pool refresh doesn't block account-
    // info from starting. Previously they were awaited sequentially,
    // doubling the wall-clock for a typical refresh.
    const auditId = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const [poolRes, acctRes] = await Promise.allSettled([
        orchestrator.execute({ action: "refresh_pool_info", payload: {} }),
        orchestrator.execute({ action: "refresh_account_info", payload: {} }),
      ]);
      if (!aliveRef.current) return;
      const nextErrors: CardErrorMap = {};
      if (poolRes.status === "rejected") {
        const msg =
          poolRes.reason instanceof Error
            ? poolRes.reason.message
            : "Pool refresh failed";
        nextErrors.pools = msg;
        nextErrors.nodes = msg;
      }
      if (acctRes.status === "rejected") {
        const msg =
          acctRes.reason instanceof Error
            ? acctRes.reason.message
            : "Account refresh failed";
        nextErrors.accounts = msg;
        nextErrors.accountInfo = msg;
      }
      setCardErrors(nextErrors);
      const allOk =
        poolRes.status === "fulfilled" && acctRes.status === "fulfilled";
      store.addAuditEntry({
        id: auditId,
        timestamp: new Date().toISOString(),
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
    } finally {
      if (aliveRef.current) setRefreshing(false);
    }
  }, [orchestrator, store, state.accounts.length, state.pools.length]);

  const handleRangeChange = React.useCallback(
    (next: string) => {
      if (isRangeKey(next)) setUrlState({ range: next });
    },
    [setUrlState],
  );

  const handleRegionSearch = React.useCallback(
    (q: string) => setUrlState({ regionSearch: q }),
    [setUrlState],
  );
  const handleRegionStatus = React.useCallback(
    (f: RegionStatusFilter) => setUrlState({ regionStatus: f }),
    [setUrlState],
  );
  const handleQuotaSearch = React.useCallback(
    (q: string) => setUrlState({ quotaSearch: q }),
    [setUrlState],
  );
  const handleToggleActivity = React.useCallback(
    () =>
      setUrlState({
        activity: activityCollapsed ? "on" : "off",
      }),
    [setUrlState, activityCollapsed],
  );

  const handleRegionDrillDown = React.useCallback(
    (regionName: string) => {
      navigate(`/account-info?region=${encodeURIComponent(regionName)}`);
    },
    [navigate],
  );

  // Keyboard shortcut: `r` triggers Refresh All when not focused inside
  // an input. Mirrors the convention from the Nodes / Pools pages.
  useShortcut(
    "r",
    () => {
      if (refreshing) return;
      void handleRefreshAll();
    },
    { enabled: true, preventDefault: false },
  );

  // Keyboard shortcut: `/` focuses the quota search input (only when the
  // table has rendered — otherwise the ref is null and we no-op).
  const quotaSearchRef = React.useRef<HTMLInputElement>(null);
  useShortcut(
    "/",
    () => {
      const el = quotaSearchRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    },
    { enabled: true, preventDefault: true },
  );

  const isLoading = refreshing || state.accounts.length === 0;
  const isEmptyState =
    !refreshing &&
    state.accounts.length === 0 &&
    stats.totalAccounts === 0 &&
    stats.totalPools === 0 &&
    stats.totalNodes === 0;

  const refreshButton = (
    <Button
      variant="default"
      onClick={handleRefreshAll}
      disabled={refreshing}
      aria-label="Refresh all data"
      title="Refresh all (press R)"
    >
      <RefreshCw
        className={cn(
          "h-3.5 w-3.5 transition-transform duration-200",
          refreshing && "animate-spin",
        )}
      />
      Refresh All
    </Button>
  );

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="relative overflow-hidden rounded-xl border bg-card/50 p-6">
        <DotPattern fade="top-left" className="absolute inset-0" />
        <Meteors count={12} tone="primary" className="absolute inset-0" />
        <div className="relative z-10">
          <PageHeader
            title="Multi-Region Manager"
            description="Cross-region snapshot of accounts, pools, and node health. Use the range toggle to scope trends. Press R to refresh, / to filter unused quota."
          >
            {/* Quiet until < 10 min from expiry; click to force-refresh
                BEFORE drilling into an ARM-heavy KPI (Accounts / Pools /
                Nodes / Account Info) so the destination page doesn't 401
                mid-load. */}
            <TokenExpiryBadge
              secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
              loading={armTokenTracker.loading}
              onRefresh={() => void armTokenTracker.refresh()}
              needsReauth={armTokenTracker.needsReauth}
              onReauth={() =>
                void armTokenTracker.reauth({
                  loginHint: primaryAccount?.username,
                })
              }
            />
            <Tabs
              value={range}
              onValueChange={handleRangeChange}
              aria-label="Trend range"
            >
              <TabsList aria-label="Select trend range">
                {RANGE_OPTIONS.map((opt) => (
                  <TabsTrigger
                    key={opt}
                    value={opt}
                    aria-label={`Show ${opt} trend`}
                  >
                    {opt}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {refreshing ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>{refreshButton}</span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Refresh in progress — please wait.
                </TooltipContent>
              </Tooltip>
            ) : (
              refreshButton
            )}
            {refreshing && (
              <Loader2
                className="h-4 w-4 animate-spin text-muted-foreground"
                aria-label="Refreshing"
              />
            )}
          </PageHeader>
        </div>
      </div>

      {isEmptyState && (
        <EmptyState
          icon={LogIn}
          title="No data yet"
          description="Sign in on the Azure Accounts page to discover subscriptions, then refresh to populate this dashboard."
          action={{
            label: "Go to Azure Accounts",
            icon: LogIn,
            onClick: () => onNavigate("azure-accounts"),
          }}
        />
      )}

      {/* Stats Cards */}
      {isLoading && stats.totalAccounts === 0 && stats.totalPools === 0 ? (
        <div role="region" aria-label="Dashboard statistics">
          <SkeletonLoader variant="stat-bar" />
        </div>
      ) : (
        <div
          role="region"
          aria-label="Dashboard statistics"
          className="flex flex-wrap gap-4"
        >
          <StatCard
            id="kpi-accounts"
            icon={Layers}
            title="Accounts"
            info="Discovered Batch accounts across all signed-in Azure tenants. Click to drill into provisioning state."
            tone="primary"
            onClick={() => onNavigate("accounts")}
            error={cardErrors.accounts ?? null}
            onRetry={() =>
              retryAction("refresh_account_info", ["accounts", "accountInfo"])
            }
            trend={trendByCard.accounts}
            goodDirection="up"
            sparkData={sparkSeries.accounts}
            items={[
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
            ]}
          />
          <StatCard
            id="kpi-pools"
            icon={Boxes}
            title="Pools"
            info="Batch pools the manager is tracking. Failed pools can be reset via the Quick Actions panel below. Click to inspect per-pool details and resize state."
            tone="info"
            onClick={() => onNavigate("pool-info")}
            error={cardErrors.pools ?? null}
            onRetry={() => retryAction("refresh_pool_info", ["pools", "nodes"])}
            trend={trendByCard.pools}
            goodDirection="up"
            sparkData={sparkSeries.pools}
            items={[
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
            ]}
          />
          <StatCard
            id="kpi-nodes"
            icon={Server}
            title="Nodes"
            info="Compute nodes inside the tracked pools. Issues = nodes in unusable / starttask-failed / offline / unknown / preempted states."
            tone="warning"
            onClick={() => onNavigate("nodes")}
            error={cardErrors.nodes ?? null}
            onRetry={() => retryAction("refresh_pool_info", ["pools", "nodes"])}
            trend={trendByCard.runningNodes}
            goodDirection="up"
            sparkData={sparkSeries.runningNodes}
            sparkTone="success"
            items={[
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
            ]}
          />
          {state.accountInfos.length > 0 && (
            <>
              <StatCard
                id="kpi-dedicated-cores"
                icon={Cpu}
                title="Dedicated Cores"
                info="Sum of in-use dedicated cores vs. quota across all tracked accounts. Click to inspect per-account breakdown."
                tone="info"
                onClick={() => onNavigate("account-info")}
                error={cardErrors.accountInfo ?? null}
                onRetry={() =>
                  retryAction("refresh_account_info", [
                    "accounts",
                    "accountInfo",
                  ])
                }
                trend={trendByCard.dedicated}
                goodDirection="up"
                sparkData={sparkSeries.dedicatedUsed}
                sparkTone="info"
                items={[
                  { label: "Used", value: dedicatedUsed, tone: "warning" },
                  {
                    label: "Available",
                    value: dedicatedQuota,
                    tone: "success",
                  },
                ]}
              />
              <StatCard
                id="kpi-lp-cores"
                icon={HardDrive}
                title="Low Priority Cores"
                info="Sum of in-use low-priority cores vs. quota. Unused LP capacity is the primary input to the Unused Quota detector below."
                tone="primary"
                onClick={() => onNavigate("account-info")}
                error={cardErrors.accountInfo ?? null}
                onRetry={() =>
                  retryAction("refresh_account_info", [
                    "accounts",
                    "accountInfo",
                  ])
                }
                trend={trendByCard.lp}
                goodDirection="up"
                sparkData={sparkSeries.lpUsed}
                sparkTone="primary"
                items={[
                  { label: "Used", value: lpUsed, tone: "warning" },
                  { label: "Available", value: lpQuota, tone: "success" },
                ]}
              />
            </>
          )}
        </div>
      )}

      {/* Cluster Health — at-a-glance traffic light per region */}
      {regionHealthRows.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="text-2xs text-muted-foreground hover:text-foreground"
              onClick={() => onNavigate("monitoring")}
              aria-label="Open Monitoring page for deeper region telemetry"
            >
              Open Monitoring →
            </Button>
          </div>
          <ClusterHealthCard
            regions={regionHealthRows}
            historyHealthy={sparkSeries.healthyRegions}
            historyUnhealthy={sparkSeries.unhealthyRegions}
            onDrillDown={handleRegionDrillDown}
            searchQuery={regionSearch}
            onSearchQueryChange={handleRegionSearch}
            statusFilter={regionStatus}
            onStatusFilterChange={handleRegionStatus}
          />
        </div>
      )}

      {/* Region Health */}
      <div role="region" aria-label="Region health">
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-base font-semibold text-foreground">
              Region Health
            </h2>
            {regionHealthRows.length > 0 && (
              <span className="text-2xs text-muted-foreground">
                Click a region to drill down
              </span>
            )}
          </div>
          {regionHealthRows.length === 0 ? (
            isLoading ? (
              <SkeletonLoader variant="list" rows={3} />
            ) : (
              <EmptyState
                icon={Server}
                title="No regions discovered"
                description="Refresh account info to populate per-region health metrics."
              />
            )
          ) : (
            <HoverList
              items={regionHealthRows
                .slice()
                .sort((a, b) => b.total - a.total)}
              getKey={(r) => r.name}
              tone="primary"
              onItemClick={(r) => handleRegionDrillDown(r.name)}
              className="gap-1"
              renderItem={(r) => <RegionHealthChart regions={[r]} />}
            />
          )}
        </Card>
      </div>

      {/* Unused Quota */}
      <div role="region" aria-label="Unused quota">
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-2xs text-muted-foreground hover:text-foreground"
            onClick={() => onNavigate("unused-quota")}
            aria-label="Open the full Unused Quota page"
          >
            Open Unused Quota page →
          </Button>
        </div>
        <UnusedQuotaSection
          orchestrator={orchestrator}
          store={store}
          searchQuery={quotaSearch}
          onSearchQueryChange={handleQuotaSearch}
          searchInputRef={quotaSearchRef}
        />
      </div>

      {/* Agent Status */}
      <div role="region" aria-label="Agent status">
        <AgentStatusStrip />
      </div>

      {/* Quick Actions */}
      <Card
        role="region"
        aria-label="Quick actions"
        className="relative overflow-hidden p-4"
      >
        <BorderBeam size={200} duration={8} />
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="m-0 text-base font-semibold text-foreground">
            Quick Actions
          </h2>
          <span className="text-2xs text-muted-foreground">
            Bulk operations on the current session
          </span>
        </div>
        <QuickActions store={store} onNavigate={onNavigate} />
      </Card>

      {/* Recent Activity */}
      <div role="region" aria-label="Recent activity">
        <RecentActivity
          collapsed={activityCollapsed}
          onToggleCollapsed={handleToggleActivity}
        />
      </div>
    </div>
  );
};

export const OverviewPage: React.FC<OverviewPageProps> = (props) => (
  <ErrorBoundary>
    <OverviewPageInner {...props} />
  </ErrorBoundary>
);
