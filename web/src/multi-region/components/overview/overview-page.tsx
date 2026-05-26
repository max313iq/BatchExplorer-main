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
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  Eye,
  EyeOff,
  HardDrive,
  Layers,
  ListChecks,
  Loader2,
  LogIn,
  Maximize2,
  Minimize2,
  Minus,
  PiggyBank,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldAlert,
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
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog, type AuditEntry } from "../../services/audit-log";
import { MultiRegionStore } from "../../store/multi-region-store";
import {
  useDashboardStats,
  useMultiRegionState,
} from "../../store/store-context";
import { QuotaSuggestion } from "../../store/store-types";

import { useDashboardOutletContext } from "../page-router";
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
import { SummaryStatItem } from "../shared/summary-stat-item";
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
  icon: React.ElementType;
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
  /**
   * Quick-filter shortcut: when `failedCount > 0`, render a secondary
   * "View N failed" link inside the card. Clicking it stops propagation
   * (so the whole-card `onClick` doesn't double-fire) and invokes
   * `onFilterFailed`, which the parent uses to deep-link into the
   * destination page with `?status=failed`.
   */
  onFilterFailed?: () => void;
  /** Count of failed items used for the "View N failed" link label. */
  failedCount?: number;
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
  onFilterFailed,
  failedCount = 0,
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
      {onFilterFailed && failedCount > 0 && (
        <button
          type="button"
          // Stop propagation so the outer Card's onClick (whole-card
          // navigate-to-detail) doesn't also fire — we want the filtered
          // deep-link, not the default landing page.
          onClick={(e) => {
            e.stopPropagation();
            onFilterFailed();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
            }
          }}
          className={cn(
            "mt-2 inline-flex items-center gap-1 self-start rounded px-1.5 py-0.5 text-2xs font-medium",
            TONE_CLASSES.destructive.text,
            "hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          aria-label={`Open ${title} filtered to ${failedCount} failed`}
        >
          View {failedCount} failed →
        </button>
      )}
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
  /** Click-through into the audit-log page; passed so the unified feed can
   *  deep-link each audit row instead of just dumping text. */
  onOpenAuditAction: (actionKey: string) => void;
}

const RecentActivity: React.FC<RecentActivityProps> = ({
  collapsed,
  onToggleCollapsed,
  onOpenAuditAction,
}) => {
  const state = useMultiRegionState();
  const recentLogs = React.useMemo(
    () => state.agentLogs.slice(-8),
    [state.agentLogs],
  );
  // Last-10 audit entries — clickable rows deep-link into the audit-log
  // page filtered to that action. Reading directly from `state.auditEntries`
  // means any `auditLog.record(...)` from any page reactively shows here.
  const recentAudit = React.useMemo(
    () => (state.auditEntries ?? []).slice(-10).reverse(),
    [state.auditEntries],
  );

  const errorCount = React.useMemo(
    () => recentLogs.filter((l) => l.level === "error").length,
    [recentLogs],
  );
  const auditFailureCount = React.useMemo(
    () => recentAudit.filter((e) => e.status === "failure").length,
    [recentAudit],
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
          {auditFailureCount > 0 && (
            <span
              className={cn(
                "ml-1 rounded-full px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wider",
                TONE_CLASSES.warning.bgSubtle,
                TONE_CLASSES.warning.text,
              )}
              aria-label={`${auditFailureCount} recent audit failure${auditFailureCount === 1 ? "" : "s"}`}
            >
              {auditFailureCount} audit fail
            </span>
          )}
        </button>
        {(recentLogs.length > 0 || recentAudit.length > 0) && (
          <span className="text-2xs text-muted-foreground">
            {recentAudit.length > 0
              ? `Last ${recentAudit.length} audit · ${recentLogs.length} agent`
              : `Last ${recentLogs.length} event${recentLogs.length === 1 ? "" : "s"}`}
          </span>
        )}
      </div>
      {!collapsed && (
        <div id="recent-activity-body" className="flex flex-col gap-3">
          {/* Audit feed — click-to-page deep links. Newest first. Empty
              when no operator action has been audited; the agent log below
              still surfaces non-audit telemetry. */}
          {recentAudit.length > 0 && (
            <div>
              <p className="m-0 mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Audit trail
              </p>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {recentAudit.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => onOpenAuditAction(e.action)}
                      className={cn(
                        "flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        e.status === "failure" && "text-destructive",
                      )}
                      aria-label={`Open audit log filtered to ${e.action}`}
                    >
                      <span className="min-w-[60px] font-mono text-2xs text-muted-foreground/70 tabular-nums">
                        {formatLogTime(e.timestamp)}
                      </span>
                      <StatusBadge
                        status={e.status === "failure" ? "error" : "success"}
                      />
                      <span className="font-mono text-2xs text-muted-foreground">
                        {e.action}
                      </span>
                      <span
                        className={cn(
                          "flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs",
                          e.status === "failure"
                            ? "text-destructive"
                            : "text-foreground/80",
                        )}
                      >
                        {e.target}
                      </span>
                      <ChevronRight
                        className="h-3 w-3 shrink-0 text-muted-foreground/50"
                        aria-hidden
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Agent log — unchanged from wave 1, kept below the audit feed
              so the high-signal audit entries get visual priority. */}
          {recentLogs.length === 0 && recentAudit.length === 0 ? (
            <p className="m-0 text-xs text-muted-foreground">
              No activity yet. Trigger a refresh to begin populating events.
            </p>
          ) : recentLogs.length > 0 ? (
            <div>
              <p className="m-0 mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Agent log
              </p>
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
            </div>
          ) : null}
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

/**
 * Structured outcome of the most-recent `auto_create_pools_from_quota` run.
 * Surfaced inline (above the table) so operators see exactly how many pools
 * succeeded vs failed without combing the activity log — important for the
 * partial-success case where the orchestrator returns `status: "partial"`
 * with `summary: { created, failed, total }`.
 */
interface AutoCreateOutcome {
  status: "completed" | "partial" | "failed";
  created: number;
  failed: number;
  total: number;
  /** Distinct regions touched — useful for the rollback-suggestion text. */
  regions: string[];
  /** Timestamp the orchestrator finished. */
  finishedAt: string;
}

const UnusedQuotaSection: React.FC<UnusedQuotaSectionProps> = ({
  orchestrator,
  // `store` is retained on the props bag for backward compat with the
  // caller's wiring; all write-through happens via the `auditLog` singleton
  // (which is bound to the store at app boot), so the prop is unused here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  store: _store,
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
  // Partial-success / rollback report — pinned above the table after every
  // auto-create attempt. The orchestrator returns
  // `status: "completed"|"partial"|"failed"` and a summary with per-row
  // counts; we render that as a colour-coded banner with explicit guidance
  // when failures occurred (manual review since the orchestrator does not
  // currently roll back successfully-created pools — see COORDINATOR note).
  const [outcome, setOutcome] = React.useState<AutoCreateOutcome | null>(null);

  // Track unmount so we don't update state from a stale async path.
  const aliveRef = React.useRef(true);
  // Per-action AbortControllers so a rapid re-click cancels the in-flight
  // request rather than racing it. The `creating` / `detecting` flags also
  // gate the UI, but a controller is the only way to actually stop work
  // mid-flight if the user navigates away.
  const detectAbortRef = React.useRef<AbortController | null>(null);
  const createAbortRef = React.useRef<AbortController | null>(null);
  React.useEffect(
    () => () => {
      aliveRef.current = false;
      // Cancel any in-flight orchestrator calls on unmount — without this,
      // a user navigating away mid-detect would still trigger the
      // "setState on unmounted component" warning AND keep the agent
      // worker busy until the underlying ARM call finally returns.
      detectAbortRef.current?.abort();
      createAbortRef.current?.abort();
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
    // Re-entry guard — the button is also `disabled` while detecting, but
    // a keyboard or programmatic invoker could still slip through.
    if (detecting) return;
    // Cancel any prior in-flight detect (rapid re-click). The agent honours
    // the signal threaded through `params.signal`.
    detectAbortRef.current?.abort();
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
      const result = await orchestrator.execute({
        action: "detect_unused_quota",
        payload: {},
        signal: controller.signal,
      });
      if (!aliveRef.current || controller.signal.aborted) return;
      const items = (result.summary as Record<string, unknown>)
        ?.suggestions as QuotaSuggestion[] | undefined;
      setSuggestions(items ?? []);
      auditLog.record({
        actor: "overview-page",
        action: "detect_unused_quota",
        target,
        status: "success",
        details: { suggestionCount: items?.length ?? 0 },
      });
    } catch (e) {
      if (!aliveRef.current || controller.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setDetectError(msg);
      auditLog.record({
        actor: "overview-page",
        action: "detect_unused_quota",
        target,
        status: "failure",
        error: msg,
      });
    } finally {
      if (aliveRef.current && detectAbortRef.current === controller) {
        setDetecting(false);
        detectAbortRef.current = null;
      }
    }
  }, [detecting, orchestrator, state.accountInfos.length]);

  const performAutoCreate = React.useCallback(async () => {
    // Hard re-entry guard — closing-and-reopening the confirm dialog while
    // a prior run is still in flight would otherwise double-submit. The
    // primary button has `disabled={... || creating}` but the dialog's
    // own confirm button passes through.
    if (creating) return;
    const selected = filteredRows.filter((r) => effectiveSelection.has(r.rowId));
    if (selected.length === 0) return;
    // Cancel any prior in-flight auto-create. In practice gated by `creating`
    // but defensive against accidental double-dispatch (e.g. via debugger).
    createAbortRef.current?.abort();
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
      const result = await orchestrator.execute({
        action: "auto_create_pools_from_quota",
        payload: { suggestions: payload },
        signal: controller.signal,
      });
      if (!aliveRef.current || controller.signal.aborted) return;

      // Surface the orchestrator's structured summary so partial-success
      // is unambiguous. The agent returns
      // `summary: { created, failed, total }` and `status` in
      // {"completed","partial","failed"} — fall back to derived counts if
      // the shape ever drifts.
      const summary = (result.summary ?? {}) as Record<string, unknown>;
      const created = Number(summary.created) || 0;
      const failed = Number(summary.failed) || 0;
      const total = Number(summary.total) || selected.length;
      const status: AutoCreateOutcome["status"] =
        result.status === "partial" ||
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
    } catch (e) {
      if (!aliveRef.current || controller.signal.aborted) return;
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
    } finally {
      if (aliveRef.current && createAbortRef.current === controller) {
        setCreating(false);
        createAbortRef.current = null;
      }
    }
  }, [creating, orchestrator, filteredRows, effectiveSelection]);

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

      {/*
       * Partial-success / rollback report — surfaces after every auto-create
       * run. We do NOT auto-rollback successful pools (the agent does not
       * currently support compensating deletes — see COORDINATOR note) but
       * the report explicitly lists the failed regions so the operator can
       * decide whether to manually delete the succeeded pools too. This is
       * the missing UI for the agent's `status: "partial"` return value.
       *
       * COORDINATOR: a true rollback (delete-on-partial-fail) belongs in
       * the orchestrator so it can run with the same auth/abort context as
       * the create. Until that lands, this banner is the trail.
       */}
      {outcome && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "mb-3 flex flex-col gap-1.5 rounded-md border p-2.5 text-xs",
            outcome.status === "completed"
              ? cn(
                  TONE_CLASSES.success.border,
                  TONE_CLASSES.success.bgSubtle,
                )
              : outcome.status === "partial"
                ? cn(
                    TONE_CLASSES.warning.border,
                    TONE_CLASSES.warning.bgSubtle,
                  )
                : cn(
                    TONE_CLASSES.destructive.border,
                    TONE_CLASSES.destructive.bgSubtle,
                  ),
          )}
        >
          <div className="flex items-start gap-2">
            {outcome.status === "completed" ? (
              <CheckCircle2
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  TONE_CLASSES.success.text,
                )}
                aria-hidden
              />
            ) : (
              <AlertCircle
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  outcome.status === "partial"
                    ? TONE_CLASSES.warning.text
                    : TONE_CLASSES.destructive.text,
                )}
                aria-hidden
              />
            )}
            <span className="flex-1">
              <span
                className={cn(
                  "font-semibold",
                  outcome.status === "completed"
                    ? TONE_CLASSES.success.text
                    : outcome.status === "partial"
                      ? TONE_CLASSES.warning.text
                      : TONE_CLASSES.destructive.text,
                )}
              >
                {outcome.status === "completed"
                  ? "Auto-create complete"
                  : outcome.status === "partial"
                    ? "Auto-create partially succeeded"
                    : "Auto-create failed"}
              </span>{" "}
              <span className="text-muted-foreground">
                {outcome.created}/{outcome.total} pool
                {outcome.total === 1 ? "" : "s"} created
                {outcome.failed > 0 && (
                  <>
                    {" "}
                    (<span className={TONE_CLASSES.destructive.text}>
                      {outcome.failed} failed
                    </span>)
                  </>
                )}
                {" "}across {outcome.regions.length} region
                {outcome.regions.length === 1 ? "" : "s"}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setOutcome(null)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Dismiss auto-create report"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
          {outcome.status === "partial" && (
            <p className="m-0 pl-5 text-2xs text-muted-foreground">
              The {outcome.created} pool{outcome.created === 1 ? "" : "s"} that
              succeeded are live and consuming quota. Review the agent log for
              the failure reasons before retrying — repeated runs will
              auto-skip regions whose VM SKU has been blacklisted.
            </p>
          )}
          {outcome.status === "failed" && outcome.created === 0 && (
            <p className="m-0 pl-5 text-2xs text-muted-foreground">
              No pools were created — common causes: ARM permissions, VM SKU
              unavailable in region, or upstream quota race. Re-detect and try
              again, or open the activity log for per-row error detail.
            </p>
          )}
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
// Defender Posture Summary — corpus-grounded "Today's signals"
// ---------------------------------------------------------------------------
//
// Surfaces counts of audit entries (last 24h) whose `action` matches one of
// the ten high-risk operator events catalogued in the corpus playbook:
//
//   New folder\_AZURE_BYPASS_PLAYBOOK.md  §"Critical Defender Audit Surface"
//
// Each row reads from `state.auditEntries` (single source — bound to the
// audit-log singleton at app boot, so any `auditLog.record(...)` from any
// page is reactive here). Clicking a row deep-links into the audit-log page
// with `?action=<key>` so the operator can immediately inspect the matched
// rows — this is the missing "today's defender posture summary" gap. The
// match is **prefix / substring** on `action`, NOT an exact equal, so the
// existing varied action strings (e.g.
// `auto_create_pools_from_quota:start`, `update_ca_policy_disable`,
// `delete_diagnostic_setting`, `cancel_subscription`) line up with the
// corpus ordering without forcing rename of every audit call site.

interface DefenderSignal {
  /** Stable id used in the deep-link `?action=` query. */
  key: string;
  /** Operator-readable label. */
  label: string;
  /** Severity ordinal from the playbook (1 = highest priority). */
  rank: number;
  /** Substrings to match against `AuditEntry.action`, case-insensitive. */
  match: string[];
}

const DEFENDER_SIGNALS: DefenderSignal[] = [
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

function matchesDefenderSignal(action: string, signal: DefenderSignal): boolean {
  const lower = action.toLowerCase();
  return signal.match.some((needle) => lower.includes(needle));
}

interface DefenderPostureRow extends DefenderSignal {
  count: number;
  failures: number;
}

interface DefenderPostureSummaryProps {
  entries: AuditEntry[];
  /** Deep-link into the audit-log page with the action filter applied. */
  onOpenAuditLog: (actionKey: string) => void;
}

/**
 * Compact card summarising defender posture against the 10 corpus events.
 * Rows with zero matches in the last 24h render in muted tone; non-zero
 * rows highlight via severity colour and become clickable.
 */
const DefenderPostureSummary: React.FC<DefenderPostureSummaryProps> = ({
  entries,
  onOpenAuditLog,
}) => {
  const rows = React.useMemo<DefenderPostureRow[]>(() => {
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
          if (e.status === "failure") failures += 1;
        }
      }
      return { ...sig, count, failures };
    });
  }, [entries]);

  const totalHits = rows.reduce((s, r) => s + r.count, 0);
  const topHits = rows.filter((r) => r.count > 0);
  const overallTone: Tone =
    totalHits === 0
      ? "success"
      : topHits.some((r) => r.rank <= 3)
        ? "destructive"
        : "warning";
  const toneClasses = TONE_CLASSES[overallTone];

  return (
    <Card
      role="region"
      aria-labelledby="defender-posture-heading"
      className={cn(
        "border-l-4 bg-card p-4",
        toneClasses.borderTop.replace("border-t-", "border-l-"),
      )}
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2
            id="defender-posture-heading"
            className="m-0 flex items-baseline gap-1.5 text-base font-semibold text-foreground"
          >
            <ShieldAlert
              className={cn("h-3.5 w-3.5 self-center", toneClasses.text)}
              aria-hidden
            />
            Today&apos;s Defender Signals
          </h2>
          <InfoTooltip
            content="Counts last-24h audit entries against the 10 highest-priority operator events from the offensive-tooling research corpus (New folder/_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface). Click a non-zero row to open the audit log filtered to that action."
            ariaLabel="What are defender signals?"
            size={12}
          />
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider",
              toneClasses.bgSubtle,
              toneClasses.text,
            )}
            aria-label={`${totalHits} signals in the last 24 hours`}
          >
            {totalHits === 0 ? "Quiet" : `${totalHits} hit${totalHits === 1 ? "" : "s"}`}
          </span>
        </div>
        <span className="text-2xs text-muted-foreground">
          Last 24h · ranked by corpus severity
        </span>
      </div>
      {totalHits === 0 ? (
        <p className="m-0 text-2xs text-muted-foreground">
          No corpus-matched audit events in the last 24h. This is the
          truthful answer when no operator actions of interest have fired —
          source-of-truth lives in `state.auditEntries`.
        </p>
      ) : (
        <ul
          className="m-0 grid list-none gap-1 p-0 sm:grid-cols-2"
          aria-label="Defender signal counts"
        >
          {rows
            .slice()
            .sort((a, b) => b.count - a.count || a.rank - b.rank)
            .map((row) => {
              const active = row.count > 0;
              const tone: Tone =
                row.failures > 0
                  ? "destructive"
                  : row.rank <= 3
                    ? "warning"
                    : "info";
              const rowToneClasses = TONE_CLASSES[tone];
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    onClick={() => active && onOpenAuditLog(row.key)}
                    disabled={!active}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors duration-fast",
                      active
                        ? cn(
                            rowToneClasses.border,
                            rowToneClasses.bgSubtle,
                            "hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          )
                        : "border-border/40 bg-card/30 text-muted-foreground/70 cursor-default",
                    )}
                    aria-label={
                      active
                        ? `${row.count} ${row.label} event${row.count === 1 ? "" : "s"} — click to open audit log`
                        : `No ${row.label} events in the last 24h`
                    }
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "inline-flex h-4 w-4 items-center justify-center rounded-full text-3xs font-bold tabular-nums",
                          active
                            ? cn(rowToneClasses.bg, "text-white")
                            : "bg-muted text-muted-foreground/60",
                        )}
                        aria-hidden
                      >
                        {row.rank}
                      </span>
                      <span
                        className={cn(
                          "text-xs",
                          active ? "text-foreground" : "text-muted-foreground/70",
                        )}
                      >
                        {row.label}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-2xs tabular-nums">
                      {row.failures > 0 && (
                        <span className={TONE_CLASSES.destructive.text}>
                          {row.failures} fail
                        </span>
                      )}
                      <span
                        className={cn(
                          "font-semibold",
                          active ? rowToneClasses.text : "text-muted-foreground/50",
                        )}
                      >
                        {row.count}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
        </ul>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Suggested Next Actions — heuristics derived from store state
// ---------------------------------------------------------------------------
//
// Static heuristics — no remote calls — that surface the most actionable
// page based on the *current* store snapshot. Re-evaluates whenever the
// inputs (failed counts, stale account ages, defender hits) change. Each
// suggestion is a (label, rationale, target PageKey) triple — clicking
// navigates via the same `navTo` helper the rest of the page uses, so the
// suggestion always lands on a page wired into the router.

interface SuggestionRow {
  id: string;
  label: string;
  rationale: string;
  target: PageKey;
  /** When set, button tone shifts and the icon is the alert variant. */
  urgency: "low" | "medium" | "high";
}

interface SuggestedActionsProps {
  suggestions: SuggestionRow[];
  onNavigate: (key: PageKey) => void;
}

const SuggestedActions: React.FC<SuggestedActionsProps> = ({
  suggestions,
  onNavigate,
}) => {
  if (suggestions.length === 0) return null;
  return (
    <Card
      role="region"
      aria-labelledby="suggested-actions-heading"
      className="border-l-4 border-l-primary/60 bg-card p-4"
    >
      <div className="mb-2 flex items-baseline gap-2">
        <ListChecks
          className="h-3.5 w-3.5 self-center text-primary"
          aria-hidden
        />
        <h2
          id="suggested-actions-heading"
          className="m-0 text-base font-semibold text-foreground"
        >
          Suggested Next Actions
        </h2>
        <span className="text-2xs text-muted-foreground">
          {suggestions.length} suggestion
          {suggestions.length === 1 ? "" : "s"} from current state
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {suggestions.map((s) => {
          const tone: Tone =
            s.urgency === "high"
              ? "destructive"
              : s.urgency === "medium"
                ? "warning"
                : "primary";
          const tc = TONE_CLASSES[tone];
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onNavigate(s.target)}
                className={cn(
                  "flex w-full items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors duration-fast",
                  tc.border,
                  tc.bgSubtle,
                  "hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                aria-label={`${s.label} — ${s.rationale}`}
              >
                <span className="flex flex-col gap-0.5">
                  <span className={cn("text-xs font-semibold", tc.text)}>
                    {s.label}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {s.rationale}
                  </span>
                </span>
                <ChevronRight
                  className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground"
                  aria-hidden
                />
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
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
] as const;
type WidgetKey = (typeof WIDGET_KEYS)[number];

const WIDGET_LABEL: Record<WidgetKey, string> = {
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

type WidgetVisibility = Record<WidgetKey, boolean>;

const DEFAULT_WIDGET_VISIBILITY: WidgetVisibility = WIDGET_KEYS.reduce(
  (acc, k) => {
    acc[k] = true;
    return acc;
  },
  {} as WidgetVisibility,
);

interface WidgetCustomizerProps {
  visibility: WidgetVisibility;
  onToggle: (key: WidgetKey) => void;
  onResetAll: () => void;
  density: DashboardDensity;
  onDensityChange: (d: DashboardDensity) => void;
}

type DashboardDensity = "comfortable" | "compact";

const WidgetCustomizer: React.FC<WidgetCustomizerProps> = ({
  visibility,
  onToggle,
  onResetAll,
  density,
  onDensityChange,
}) => {
  const [open, setOpen] = React.useState(false);
  const hiddenCount = WIDGET_KEYS.filter((k) => !visibility[k]).length;
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Customize visible dashboard sections"
        className="text-2xs"
      >
        <Settings2 className="h-3.5 w-3.5" aria-hidden />
        Customize
        {hiddenCount > 0 && (
          <span className="ml-1 rounded-full bg-muted px-1.5 py-0 text-3xs font-semibold text-muted-foreground tabular-nums">
            {hiddenCount} hidden
          </span>
        )}
      </Button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close customize panel"
            className="fixed inset-0 z-30 cursor-default bg-transparent"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Customize dashboard"
            className="absolute right-0 top-full z-40 mt-1 w-64 rounded-md border bg-popover p-2 shadow-md"
          >
            <p className="m-0 mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Visible sections
            </p>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {WIDGET_KEYS.map((k) => (
                <li key={k}>
                  <label className="flex cursor-pointer items-center gap-2 rounded p-1 text-xs hover:bg-accent/40">
                    <input
                      type="checkbox"
                      checked={visibility[k]}
                      onChange={() => onToggle(k)}
                      aria-label={`Toggle ${WIDGET_LABEL[k]}`}
                      className="h-3.5 w-3.5 cursor-pointer accent-primary"
                    />
                    <span>{WIDGET_LABEL[k]}</span>
                  </label>
                </li>
              ))}
            </ul>
            <hr className="my-2 border-border" />
            <p className="m-0 mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Density
            </p>
            <div className="flex gap-1">
              <Button
                type="button"
                variant={density === "comfortable" ? "default" : "outline"}
                size="sm"
                onClick={() => onDensityChange("comfortable")}
                className="flex-1 text-2xs"
                aria-pressed={density === "comfortable"}
              >
                <Maximize2 className="h-3 w-3" aria-hidden />
                Comfortable
              </Button>
              <Button
                type="button"
                variant={density === "compact" ? "default" : "outline"}
                size="sm"
                onClick={() => onDensityChange("compact")}
                className="flex-1 text-2xs"
                aria-pressed={density === "compact"}
              >
                <Minimize2 className="h-3 w-3" aria-hidden />
                Compact
              </Button>
            </div>
            <hr className="my-2 border-border" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onResetAll}
              className="w-full text-2xs text-muted-foreground"
            >
              Reset all
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Overview Page
// ---------------------------------------------------------------------------

export interface OverviewPageProps {
  orchestrator: OrchestratorAgent;
  store: MultiRegionStore;
  /**
   * Legacy navigation prop kept for backward-compat with the route adapter
   * in `page-router.tsx`. New call sites should rely on the
   * `navigateToPage(path)` helper pulled from `useDashboardOutletContext()`
   * (used internally below). The adapter still threads this prop through,
   * so existing callers keep working unchanged.
   */
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
  // Path-based nav from context — the migration target. We keep the legacy
  // `onNavigate(PageKey)` prop accepted (route adapter still threads it
  // through) and adopt a single `navTo` helper internally so we can swap
  // call sites incrementally without touching the router.
  //
  // The hook's signature is `DashboardOutletContext` (non-null), but
  // react-router returns `null` when rendered outside an `<Outlet>` (tests,
  // standalone storybook). Treat it as potentially-undefined and fall back
  // to the legacy prop in that case.
  const outletContext = useDashboardOutletContext() as
    | ReturnType<typeof useDashboardOutletContext>
    | null
    | undefined;
  const navigateToPage = outletContext?.navigateToPage;
  const navTo = React.useCallback(
    (key: PageKey) => {
      // Prefer the context helper (canonical path-based nav). Fall back to
      // the legacy prop for tests / call sites that render this page
      // outside the router shell.
      if (navigateToPage) {
        navigateToPage(key);
      } else {
        onNavigate(key);
      }
    },
    [navigateToPage, onNavigate],
  );

  const [refreshing, setRefreshing] = React.useState(false);
  const [cardErrors, setCardErrors] = React.useState<CardErrorMap>({});

  // Persisted "hide healthy regions" filter — survives reload because an
  // operator triaging an outage wants the noisy 95% healthy regions out of
  // the way until the incident is resolved. Versioned envelope so we can
  // evolve the shape without rehydration crashes.
  const [hideHealthyRegions, setHideHealthyRegions] = usePersistedState<boolean>(
    "overview.hideHealthyRegions",
    false,
    { version: 1 },
  );

  // Persisted widget-visibility map — operator picks which sections appear
  // on this dashboard. Versioned: the migrate adds new keys (with default =
  // visible) as the WIDGET_KEYS list grows so a stored blob with fewer keys
  // doesn't blank out a freshly-added widget.
  const [widgetVisibility, setWidgetVisibility] = usePersistedState<WidgetVisibility>(
    "overview.widgetVisibility",
    DEFAULT_WIDGET_VISIBILITY,
    {
      version: 1,
      migrate: (raw: unknown): WidgetVisibility => {
        if (!raw || typeof raw !== "object") return DEFAULT_WIDGET_VISIBILITY;
        const next: WidgetVisibility = { ...DEFAULT_WIDGET_VISIBILITY };
        for (const k of WIDGET_KEYS) {
          const v = (raw as Record<string, unknown>)[k];
          if (typeof v === "boolean") next[k] = v;
        }
        return next;
      },
    },
  );

  // Persisted compact/comfortable density toggle. Applied via a wrapper
  // class on the outermost div — section spacing tightens but per-row
  // semantics are unchanged.
  const [density, setDensity] = usePersistedState<DashboardDensity>(
    "overview.density",
    "comfortable",
    {
      version: 1,
      migrate: (raw: unknown): DashboardDensity =>
        raw === "compact" || raw === "comfortable"
          ? (raw as DashboardDensity)
          : "comfortable",
    },
  );

  // ARIA-live announcement buffer — flipped on every successful auto-refresh
  // so AT users hear "Dashboard refreshed" without having to inspect every
  // KPI cell. Cleared after a tick so a repeat refresh re-fires.
  const [liveAnnouncement, setLiveAnnouncement] = React.useState("");

  const toggleWidget = React.useCallback(
    (key: WidgetKey) => {
      setWidgetVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
    },
    [setWidgetVisibility],
  );
  const resetWidgets = React.useCallback(() => {
    setWidgetVisibility(DEFAULT_WIDGET_VISIBILITY);
    setDensity("comfortable");
  }, [setWidgetVisibility, setDensity]);

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
      avgFreeLpPerAccount:
        withFreeLp > 0 ? Math.round(totalFreeLp / withFreeLp) : 0,
    };
  }, [state.accountInfos]);

  // Hide-healthy filter — apply to the cluster-health grid AND the region-
  // health hover list. Healthy = healthy === total (every account in the
  // region is up). Empty regions (`total === 0`) are also considered
  // "uninteresting" and hidden when the filter is on.
  const visibleRegionHealthRows = React.useMemo(() => {
    if (!hideHealthyRegions) return regionHealthRows;
    return regionHealthRows.filter(
      (r) => r.total === 0 || r.healthy !== r.total,
    );
  }, [regionHealthRows, hideHealthyRegions]);

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

  // Suggested next actions — purely derived from current store state. Each
  // suggestion's urgency is a function of the failing population size; the
  // list is capped at 4 rows to keep the panel scannable. Recomputes only
  // when the source slices change so the operator doesn't see flicker on
  // unrelated state churn (e.g. a notification toast).
  const suggestions = React.useMemo<SuggestionRow[]>(() => {
    const rows: SuggestionRow[] = [];
    const failedAccounts = state.accounts.filter(
      (a) => a.provisioningState === "failed",
    ).length;
    const failedPools = state.pools.filter(
      (p) => p.provisioningState === "failed",
    ).length;
    // "Stale" here = MSAL session reported signed-out, OR status=error.
    // The store no longer tracks a per-account "last refreshed" timestamp;
    // `signedOut === true` is the canonical "needs re-login" signal (see
    // store-types.ts:355) so we lean on that plus the `error` bucket.
    const staleAccounts = (state.azureAccounts ?? []).filter(
      (a) => a.signedOut === true || a.status === "error",
    ).length;
    // Critical: any failed pools — block on a pool delivers no compute.
    if (failedPools > 0) {
      rows.push({
        id: "failed-pools",
        label: `Resolve ${failedPools} failed pool${failedPools === 1 ? "" : "s"}`,
        rationale:
          "Provisioning is stuck — open Pool Info to retry or read per-row error detail.",
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
        rationale:
          "MSAL session lost or ARM/Graph call failed — open Azure Accounts to re-sign-in.",
        target: "azure-accounts",
        urgency: "medium",
      });
    }
    // Low: idle capacity worth provisioning.
    if (
      accountQuotaSummary.totalFreeLp > 0 &&
      accountQuotaSummary.withFreeLp >= 1
    ) {
      rows.push({
        id: "idle-lp",
        label: `${formatNumber(accountQuotaSummary.totalFreeLp)} LP cores idle`,
        rationale:
          "Spare low-priority quota across accounts — run Detect Unused Quota below or open the full Unused Quota page.",
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
  const handleOpenAuditLogForAction = React.useCallback(
    (actionKey: string) => {
      navigate(`/audit-log?action=${encodeURIComponent(actionKey)}`);
    },
    [navigate],
  );

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

  // AbortController for the parallel refresh. Re-clicking Refresh while a
  // run is in flight cancels the prior one (the button is disabled, but a
  // keyboard hotkey could still slip through).
  const refreshAbortRef = React.useRef<AbortController | null>(null);

  const handleRefreshAll = React.useCallback(async () => {
    if (refreshing) return;
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;

    setRefreshing(true);
    // Run both refresh actions concurrently and collect outcomes via
    // `Promise.allSettled` so a slow pool refresh doesn't block account-
    // info from starting. Previously they were awaited sequentially,
    // doubling the wall-clock for a typical refresh.
    try {
      const [poolRes, acctRes] = await Promise.allSettled([
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
      if (!aliveRef.current || controller.signal.aborted) return;
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
      // ARIA-live announcement so screen-reader users hear the dashboard
      // refreshed instead of having to inspect every KPI silently. Cycle a
      // trailing space so consecutive identical announcements still fire
      // (AT typically de-dupes when the text is character-for-character
      // identical between updates).
      setLiveAnnouncement(
        allOk
          ? `Dashboard refreshed at ${new Date().toLocaleTimeString()}.`
          : `Dashboard refresh completed with errors at ${new Date().toLocaleTimeString()}.`,
      );
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
    } finally {
      if (aliveRef.current && refreshAbortRef.current === controller) {
        setRefreshing(false);
        refreshAbortRef.current = null;
      }
    }
  }, [refreshing, orchestrator, state.accounts.length, state.pools.length]);

  // Cancel any in-flight refresh on unmount — the per-section refs in
  // `UnusedQuotaSection` already do this for detect/create.
  React.useEffect(
    () => () => {
      refreshAbortRef.current?.abort();
    },
    [],
  );

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
    <div
      className={cn(
        "flex flex-col py-4",
        density === "compact" ? "gap-2" : "gap-4",
      )}
      data-density={density}
    >
      {/* Visually-hidden ARIA-live region. Mounted once at the top of the
          page so screen readers consistently latch onto it for refresh
          announcements regardless of which sections are currently visible
          (the widget customizer can hide any of the lower sections). */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>
      <div className="relative overflow-hidden rounded-xl border bg-card/50 p-6">
        <DotPattern fade="top-left" className="absolute inset-0" />
        <Meteors count={12} tone="primary" className="absolute inset-0" />
        <div className="relative z-10">
          <PageHeader
            title="Multi-Region Manager"
            description="Cross-region snapshot of accounts, pools, and node health. Use the range toggle to scope trends. Hotkeys: R refresh · / filter unused quota · 1 accounts · 2 pools · 3 nodes · 4 account info · 5 unused quota · 6 monitoring · 7 pools list · 8 audit log · 9 GPU calc · 0 Azure accounts."
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
            <WidgetCustomizer
              visibility={widgetVisibility}
              onToggle={toggleWidget}
              onResetAll={resetWidgets}
              density={density}
              onDensityChange={setDensity}
            />
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
            onClick: () => navTo("azure-accounts"),
          }}
        />
      )}

      {/*
       * Defender posture summary — corpus-grounded "today's signals" panel.
       * Reads `state.auditEntries` (bound to the auditLog singleton at app
       * boot) so every audit call site flows through this view without any
       * additional plumbing. Click a non-zero row to deep-link into the
       * audit-log page filtered to that action.
       *
       * Corpus citation:
       *   New folder/_AZURE_BYPASS_PLAYBOOK.md §"Critical Defender Audit
       *   Surface" (lines 139-152) — the 10 events listed there map 1:1 to
       *   the `DEFENDER_SIGNALS` table at the top of this file.
       */}
      {widgetVisibility.defender && (
        <DefenderPostureSummary
          entries={state.auditEntries ?? []}
          onOpenAuditLog={handleOpenAuditLogForAction}
        />
      )}

      {/* Suggested next actions — derived from current store state. Empty
          when nothing is actionable so the dashboard doesn't grow a
          permanent "no suggestions" block. */}
      {widgetVisibility.suggestions && (
        <SuggestedActions suggestions={suggestions} onNavigate={navTo} />
      )}

      {/* Stats Cards */}
      {!widgetVisibility.kpis ? null : isLoading &&
        stats.totalAccounts === 0 &&
        stats.totalPools === 0 ? (
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
            onClick={() => navTo("accounts")}
            error={cardErrors.accounts ?? null}
            onRetry={() =>
              retryAction("refresh_account_info", ["accounts", "accountInfo"])
            }
            trend={trendByCard.accounts}
            goodDirection="up"
            sparkData={sparkSeries.accounts}
            // Click-through filter — the Accounts page already honours
            // `?status=failed` on its provisioning-state filter via
            // useUrlState; deep-link straight to the filtered view.
            failedCount={stats.failedAccounts}
            onFilterFailed={() => navigate("/accounts?status=failed")}
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
            onClick={() => navTo("pool-info")}
            error={cardErrors.pools ?? null}
            onRetry={() => retryAction("refresh_pool_info", ["pools", "nodes"])}
            trend={trendByCard.pools}
            goodDirection="up"
            sparkData={sparkSeries.pools}
            failedCount={stats.failedPools}
            onFilterFailed={() => navigate("/pool-info?status=failed")}
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
            onClick={() => navTo("nodes")}
            error={cardErrors.nodes ?? null}
            onRetry={() => retryAction("refresh_pool_info", ["pools", "nodes"])}
            trend={trendByCard.runningNodes}
            goodDirection="up"
            sparkData={sparkSeries.runningNodes}
            sparkTone="success"
            failedCount={stats.nonWorkingNodes}
            onFilterFailed={() => navigate("/nodes?status=issues")}
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
                onClick={() => navTo("account-info")}
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
                onClick={() => navTo("account-info")}
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

      {/*
       * Per-account quota summary — at-a-glance counts of accounts with
       * free LP / Dedicated cores PLUS the totals. Sits above the
       * cluster-health grid because the operator triage flow is:
       *   1. Spot accounts with idle cores (this row)
       *   2. Drill into the Unused Quota detector below to act on them
       *   3. Use Cluster Health to confirm the chosen region is up
       * Hidden when account info hasn't been refreshed yet — empty row
       * would be misleading noise.
       */}
      {widgetVisibility.quotaSummary && accountQuotaSummary.totalAccounts > 0 && (
        <div
          role="group"
          aria-label="Per-account quota summary"
          className="flex flex-wrap gap-2"
        >
          <SummaryStatItem
            label="Accounts"
            value={accountQuotaSummary.totalAccounts}
            hint="discovered"
          />
          <SummaryStatItem
            label="LP free"
            value={accountQuotaSummary.withFreeLp}
            hint={`of ${accountQuotaSummary.totalAccounts} accounts`}
            tone={accountQuotaSummary.withFreeLp > 0 ? "success" : "muted"}
          />
          <SummaryStatItem
            label="LP cores idle"
            value={accountQuotaSummary.totalFreeLp}
            hint={
              accountQuotaSummary.withFreeLp > 0
                ? `≈ ${accountQuotaSummary.avgFreeLpPerAccount} / account`
                : "none"
            }
            tone={accountQuotaSummary.totalFreeLp > 0 ? "info" : "muted"}
          />
          <SummaryStatItem
            label="Dedicated free"
            value={accountQuotaSummary.withFreeDedicated}
            hint={`of ${accountQuotaSummary.totalAccounts} accounts`}
            tone={
              accountQuotaSummary.withFreeDedicated > 0 ? "success" : "muted"
            }
          />
          <SummaryStatItem
            label="Dedicated cores idle"
            value={accountQuotaSummary.totalFreeDedicated}
            tone={
              accountQuotaSummary.totalFreeDedicated > 0 ? "info" : "muted"
            }
          />
        </div>
      )}

      {/* Cluster Health — at-a-glance traffic light per region */}
      {widgetVisibility.clusterHealth && regionHealthRows.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-2xs text-muted-foreground hover:text-foreground"
              onClick={() => setHideHealthyRegions((v) => !v)}
              aria-pressed={hideHealthyRegions}
              aria-label={
                hideHealthyRegions
                  ? "Show all regions including healthy"
                  : "Hide healthy regions"
              }
              title={
                hideHealthyRegions
                  ? "Showing only degraded / down regions"
                  : "Click to hide regions where every account is healthy"
              }
            >
              {hideHealthyRegions ? (
                <Eye className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <EyeOff className="h-3.5 w-3.5" aria-hidden />
              )}
              {hideHealthyRegions ? "Show all regions" : "Hide healthy"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-2xs text-muted-foreground hover:text-foreground"
              onClick={() => navTo("monitoring")}
              aria-label="Open Monitoring page for deeper region telemetry"
            >
              Open Monitoring →
            </Button>
          </div>
          <ClusterHealthCard
            regions={visibleRegionHealthRows}
            historyHealthy={sparkSeries.healthyRegions}
            historyUnhealthy={sparkSeries.unhealthyRegions}
            onDrillDown={handleRegionDrillDown}
            searchQuery={regionSearch}
            onSearchQueryChange={handleRegionSearch}
            statusFilter={regionStatus}
            onStatusFilterChange={handleRegionStatus}
          />
          {hideHealthyRegions &&
            visibleRegionHealthRows.length < regionHealthRows.length && (
              <p className="m-0 pl-1 text-2xs text-muted-foreground">
                Hiding{" "}
                {regionHealthRows.length - visibleRegionHealthRows.length}{" "}
                healthy region
                {regionHealthRows.length - visibleRegionHealthRows.length ===
                1
                  ? ""
                  : "s"}
                . This preference is persisted across reloads.
              </p>
            )}
        </div>
      )}

      {/* Region Health */}
      {widgetVisibility.regionHealth && (
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
          {visibleRegionHealthRows.length === 0 ? (
            isLoading ? (
              <SkeletonLoader variant="list" rows={3} />
            ) : hideHealthyRegions && regionHealthRows.length > 0 ? (
              <EmptyState
                icon={Server}
                title="All regions healthy"
                description="Every region has all accounts healthy. Toggle ‘Show all regions’ above to see the full grid."
              />
            ) : (
              <EmptyState
                icon={Server}
                title="No regions discovered"
                description="Refresh account info to populate per-region health metrics."
              />
            )
          ) : (
            <HoverList
              items={visibleRegionHealthRows
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
      )}

      {/* Unused Quota */}
      {widgetVisibility.unusedQuota && (
      <div role="region" aria-label="Unused quota">
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-2xs text-muted-foreground hover:text-foreground"
            onClick={() => navTo("unused-quota")}
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
      )}

      {/* Agent Status */}
      {widgetVisibility.agents && (
      <div role="region" aria-label="Agent status">
        <AgentStatusStrip />
      </div>
      )}

      {/* Quick Actions */}
      {widgetVisibility.quickActions && (
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
        <QuickActions store={store} onNavigate={navTo} />
      </Card>
      )}

      {/* Recent Activity */}
      {widgetVisibility.recentActivity && (
      <div role="region" aria-label="Recent activity">
        <RecentActivity
          collapsed={activityCollapsed}
          onToggleCollapsed={handleToggleActivity}
          onOpenAuditAction={handleOpenAuditLogForAction}
        />
      </div>
      )}
    </div>
  );
};

export const OverviewPage: React.FC<OverviewPageProps> = (props) => (
  <ErrorBoundary>
    <OverviewPageInner {...props} />
  </ErrorBoundary>
);
