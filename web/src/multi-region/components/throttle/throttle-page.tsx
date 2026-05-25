/**
 * Throttle / Rate-Limit observability page.
 *
 * Renders the live state of the per-(subscription, endpoint-family)
 * token-bucket + circuit-breaker that fronts every Azure API call. The
 * data flow is:
 *
 *   guardedFetch → RequestGuard.observe → setEntry/pushTransition →
 *   MultiRegionStore.throttleStats → this page (subscribed via
 *   useMultiRegionState).
 *
 * Use this page to:
 *   - watch refill-rate degrade as a subscription approaches its quota
 *   - see exactly when a circuit opens, why, and when it'll close
 *   - audit the historical transition log for cascading throttle events
 *   - export the snapshot or history as CSV / JSON for incident reports
 *   - filter by state, endpoint family, or sub id substring
 *
 * The page does not issue any Azure calls of its own — purely a
 * read-only view over the store.
 */
import * as React from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Filter,
  Gauge,
  History,
  PauseCircle,
  Play,
  RotateCw,
  Search,
  ShieldAlert,
  Trash2,
  X,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import type {
  CircuitState,
  EndpointFamily,
  ThrottleStatusEntry,
  ThrottleTransition,
} from "../../services/types";

import {
  BorderBeam,
  DotPattern,
  HoverList,
  Meteors,
  NumberTicker,
} from "@/components/ui/effects";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Match the baseline used by RequestGuard so the UI can show
 * "current/baseline" rate as a percentage. Kept in sync manually with
 * `DEFAULT_REFILL_PER_SEC` in request-governance.ts; not imported to
 * avoid a cycle.
 */
const ASSUMED_BASELINE_REFILL_PER_SEC = 10;

const STATE_LABEL: Record<CircuitState, string> = {
  closed: "Healthy",
  half_open: "Probing",
  open: "Open",
};

/** Human-readable definition for each circuit state — used in tooltips. */
const STATE_DEFINITION: Record<CircuitState, string> = {
  closed:
    "Healthy. Requests flow normally. The circuit is closed — every call reaches Azure.",
  half_open:
    "Probing. The breaker is letting one trial request through. Success closes the circuit; another 429 reopens it with doubled cooldown.",
  open:
    "Open. The breaker is short-circuiting all calls for this (subscription, family) pair until the cooldown elapses. No requests are being dispatched.",
};

const STATE_TONE: Record<
  CircuitState,
  { fg: string; bg: string; border: string; ring: string }
> = {
  closed: {
    fg: "text-success",
    bg: "bg-success/10",
    border: "border-success/40",
    ring: "ring-success/30",
  },
  half_open: {
    fg: "text-warning",
    bg: "bg-warning/10",
    border: "border-warning/40",
    ring: "ring-warning/30",
  },
  open: {
    fg: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/40",
    ring: "ring-destructive/30",
  },
};

function stateGlyph(state: CircuitState): React.ReactElement {
  switch (state) {
    case "closed":
      return <CheckCircle2 className="h-4 w-4 text-success" />;
    case "half_open":
      return <PauseCircle className="h-4 w-4 text-warning" />;
    case "open":
      return <ShieldAlert className="h-4 w-4 text-destructive" />;
  }
}

function familyLabel(family: EndpointFamily): string {
  if (family === "arm") return "Azure Resource Manager";
  if (family === "graph") return "Microsoft Graph";
  if (family.startsWith("batch-")) return `Batch · ${family.slice(6)}`;
  return family;
}

/** Coarse category used for the family quick-filter chips. */
type FamilyCategory = "arm" | "graph" | "batch" | "other";

function familyCategory(family: EndpointFamily): FamilyCategory {
  if (family === "arm") return "arm";
  if (family === "graph") return "graph";
  if (family.startsWith("batch-")) return "batch";
  return "other";
}

function shortSub(id: string): string {
  if (id === "_arg") return "Resource Graph";
  if (id === "default") return "default";
  return id.length > 8 ? `${id.substring(0, 8)}…` : id;
}

function formatTimeUntil(isoTarget: string | undefined): string | null {
  if (!isoTarget) return null;
  const ms = new Date(isoTarget).getTime() - Date.now();
  if (ms <= 0) return "expired";
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

interface ParsedKey {
  subscriptionId: string;
  family: EndpointFamily;
}

function parseKey(key: string): ParsedKey {
  const idx = key.indexOf("::");
  if (idx < 0) return { subscriptionId: key, family: "arm" as EndpointFamily };
  return {
    subscriptionId: key.substring(0, idx),
    family: key.substring(idx + 2) as EndpointFamily,
  };
}

// ---------------------------------------------------------------------------
// Filter & sort model
// ---------------------------------------------------------------------------

type StateFilter = "all" | CircuitState;
type FamilyFilter = "all" | FamilyCategory;
type SortKey =
  | "smart" // open → probing → healthy, then recentThrottles desc, then sub
  | "refill-asc"
  | "refill-desc"
  | "recent-desc"
  | "sub-asc";

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "smart", label: "Priority (open first)" },
  { value: "recent-desc", label: "Recent throttles" },
  { value: "refill-asc", label: "Refill rate (slowest first)" },
  { value: "refill-desc", label: "Refill rate (fastest first)" },
  { value: "sub-asc", label: "Subscription (A → Z)" },
];

// ---------------------------------------------------------------------------
// Card: per-(sub, family) state
// ---------------------------------------------------------------------------

interface ThrottleCardProps {
  subscriptionId: string;
  family: EndpointFamily;
  entry: ThrottleStatusEntry;
  /** 1-second tick from parent so live timers re-render. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  nowTick: number;
  /** Force-clear this circuit's entry from the UI store. */
  onReset: (subscriptionId: string, family: EndpointFamily) => void;
}

const ThrottleCard: React.FC<ThrottleCardProps> = ({
  subscriptionId,
  family,
  entry,
  nowTick,
  onReset,
}) => {
  const tone = STATE_TONE[entry.state];
  const baseline = ASSUMED_BASELINE_REFILL_PER_SEC;
  const ratePct = Math.min(
    100,
    Math.round((entry.refillPerSec / baseline) * 100),
  );
  // `nowTick` is a no-op here apart from forcing this component to re-render
  // every second so the countdown advances without a fresh `entry` from the
  // store. The void below tells linters we're using it as a dependency.
  void nowTick;
  const openCountdown = formatTimeUntil(entry.openUntil);
  const isOpen = entry.state === "open";
  const subDisplayable = subscriptionId !== "_arg" && subscriptionId !== "default";

  return (
    <div
      className={cn(
        "group/copy relative rounded-lg border bg-card p-3",
        // 200ms ease for hover & state transitions per Goal §7.
        "transition-[box-shadow,border-color,transform] duration-200 ease-out motion-reduce:transition-none",
        "hover:-translate-y-0.5 hover:shadow-md",
        tone.border,
        isOpen && "shadow-sm",
      )}
      data-state={entry.state}
    >
      {/* Subtle outer pulse on open circuits — uses Tailwind's built-in
          `animate-pulse` on an absolutely-positioned ring so the card
          content stays fully readable while still drawing the eye. */}
      {isOpen && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -inset-px rounded-lg",
            "ring-2 ring-destructive/50 animate-pulse motion-reduce:animate-none",
          )}
        />
      )}
      <div className="flex items-start gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 cursor-help items-center justify-center rounded-full ring-1",
                "transition-colors duration-200",
                tone.bg,
                tone.ring,
              )}
              tabIndex={0}
              role="img"
              aria-label={`${STATE_LABEL[entry.state]} circuit`}
            >
              {stateGlyph(entry.state)}
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="m-0 text-xs leading-relaxed">
              <strong>{STATE_LABEL[entry.state]}</strong> —{" "}
              {STATE_DEFINITION[entry.state]}
            </p>
          </TooltipContent>
        </Tooltip>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {/*
              Live status pip on healthy circuits — visually communicates
              "this circuit is alive and healthy right now" instead of
              just being statically green. Falls back to a static dot
              for half_open / open since those have other strong cues
              (the open card already has a destructive pulse ring).
            */}
            {entry.state === "closed" && (
              <span
                className="live-pulse-dot mr-0.5"
                style={{ ["--live-tone" as never]: "var(--success)" }}
                aria-hidden="true"
              />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "cursor-help rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                    tone.bg,
                    tone.fg,
                  )}
                >
                  {STATE_LABEL[entry.state]}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="m-0 text-xs leading-relaxed">
                  {STATE_DEFINITION[entry.state]}
                </p>
              </TooltipContent>
            </Tooltip>
            {entry.recentThrottles > 0 && (
              <span className="text-2xs tabular-nums text-muted-foreground">
                {entry.recentThrottles} throttle
                {entry.recentThrottles === 1 ? "" : "s"} recent
              </span>
            )}
            {openCountdown && (
              <span className="inline-flex items-center gap-1 text-2xs font-medium tabular-nums text-destructive">
                <Clock className="h-3 w-3" aria-hidden />
                reopens in <span aria-live="polite">{openCountdown}</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {familyLabel(family)}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help font-mono text-2xs text-muted-foreground">
                  {shortSub(subscriptionId)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="font-mono text-2xs">{subscriptionId}</span>
              </TooltipContent>
            </Tooltip>
            {subDisplayable && (
              <CopyButton
                value={subscriptionId}
                ariaLabel={`Copy subscription id ${subscriptionId} to clipboard`}
                iconSize={11}
                className="h-4 w-4"
              />
            )}
          </div>

          <div className="mt-2 flex items-center gap-2">
            <Gauge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Progress
              value={ratePct}
              className="h-2 flex-1 transition-all duration-200"
            />
            <span className="shrink-0 text-2xs font-medium tabular-nums text-muted-foreground">
              {entry.refillPerSec}/s
            </span>
            <span className="w-10 shrink-0 text-right text-2xs font-semibold tabular-nums text-foreground">
              {ratePct}%
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-2xs text-muted-foreground">
              Refill rate · baseline {baseline}/s
              {entry.refillPerSec < baseline && " · throttled"}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onReset(subscriptionId, family)}
                  aria-label={`Reset circuit for ${familyLabel(family)} on subscription ${subscriptionId}`}
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                >
                  <RotateCw className="h-3 w-3" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Reset this circuit (clears the displayed state — next request
                will re-populate from the live guard)
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
};

// `React.memo` avoids re-rendering cards whose entry hasn't changed across
// the 1-second tick. Each card subscribes to its own tick prop, so when
// `nowTick` changes only cards that need it (the ones with countdowns) get
// repainted. Closed/healthy cards stay stable — no flash.
const ThrottleCardMemo = React.memo(
  ThrottleCard,
  (prev, next) =>
    prev.subscriptionId === next.subscriptionId &&
    prev.family === next.family &&
    prev.entry === next.entry &&
    prev.onReset === next.onReset &&
    // Only re-render on tick if there's a live countdown to advance.
    (prev.entry.openUntil ? prev.nowTick === next.nowTick : true),
);

// ---------------------------------------------------------------------------
// Transition grouping — buckets by recency for the history log.
// ---------------------------------------------------------------------------

type TransitionBucket =
  | "lastHour"
  | "earlierToday"
  | "yesterday"
  | "older";

const BUCKET_LABEL: Record<TransitionBucket, string> = {
  lastHour: "Last hour",
  earlierToday: "Earlier today",
  yesterday: "Yesterday",
  older: "Older",
};

const BUCKET_ORDER: TransitionBucket[] = [
  "lastHour",
  "earlierToday",
  "yesterday",
  "older",
];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Classify an ISO timestamp into one of four recency buckets, computed
 * relative to `now` so the result is stable across renders within the same
 * second. Bucket boundaries:
 *   - lastHour:     [now - 1h, now]
 *   - earlierToday: [00:00 today, now - 1h)
 *   - yesterday:    [00:00 yesterday, 00:00 today)
 *   - older:        before 00:00 yesterday
 */
function bucketTransition(iso: string, now: number): TransitionBucket {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "older";
  const oneHourAgo = now - 60 * 60 * 1000;
  if (t >= oneHourAgo) return "lastHour";
  const todayStart = startOfDay(now);
  if (t >= todayStart) return "earlierToday";
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  if (t >= yesterdayStart) return "yesterday";
  return "older";
}

// ---------------------------------------------------------------------------
// Transition log row
// ---------------------------------------------------------------------------

const TransitionRow: React.FC<{
  t: ThrottleTransition;
  /** 1-second tick from parent so the relative timestamp re-renders. */
  nowTick: number;
}> = ({ t, nowTick }) => {
  void nowTick;
  const fromTone = STATE_TONE[t.from];
  const toTone = STATE_TONE[t.to];
  const subDisplayable = t.subscriptionId !== "_arg" && t.subscriptionId !== "default";
  return (
    <div
      className={cn(
        "group/copy flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-xs",
        "transition-colors duration-200 ease-out motion-reduce:transition-none",
        "hover:border-border/80 hover:bg-card/80",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help font-mono text-2xs text-muted-foreground tabular-nums">
            {formatRelative(t.timestamp)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="font-mono text-2xs">{t.timestamp}</span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help font-mono text-2xs text-muted-foreground">
            {shortSub(t.subscriptionId)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="font-mono text-2xs">{t.subscriptionId}</span>
        </TooltipContent>
      </Tooltip>
      {subDisplayable && (
        <CopyButton
          value={t.subscriptionId}
          ariaLabel={`Copy subscription id ${t.subscriptionId} to clipboard`}
          iconSize={11}
          className="h-4 w-4"
        />
      )}
      <span className="text-2xs text-muted-foreground">
        · {familyLabel(t.family)}
      </span>
      <span className="flex items-center gap-1">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium uppercase tracking-wider",
            fromTone.bg,
            fromTone.fg,
          )}
        >
          {STATE_LABEL[t.from]}
        </span>
        <span className="text-muted-foreground">→</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium uppercase tracking-wider",
            toTone.bg,
            toTone.fg,
          )}
        >
          {STATE_LABEL[t.to]}
        </span>
      </span>
      <span className="min-w-0 flex-1 text-muted-foreground">— {t.reason}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const ThrottlePage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const stats = state.throttleStats;

  // Tick every second so countdowns and "X seconds ago" stay current
  // even when no observe() events are firing. Pausable so an operator
  // reading mid-incident isn't fighting flashing numbers.
  const [paused, setPaused] = React.useState(false);
  const [nowTick, setNowTick] = React.useState(0);
  React.useEffect(() => {
    if (paused) return;
    const t = window.setInterval(() => setNowTick((n) => n + 1), 1_000);
    return () => window.clearInterval(t);
  }, [paused]);

  // --- Filter / sort UI state -----------------------------------------------
  const [searchText, setSearchText] = React.useState("");
  const [stateFilter, setStateFilter] = React.useState<StateFilter>("all");
  const [familyFilter, setFamilyFilter] = React.useState<FamilyFilter>("all");
  const [sortKey, setSortKey] = React.useState<SortKey>("smart");
  const [resetAllOpen, setResetAllOpen] = React.useState(false);
  const [clearHistoryOpen, setClearHistoryOpen] = React.useState(false);

  // Per-row Reset handler — drops the entry from the throttle store so the
  // card disappears. The next observe() from the live guard will repopulate
  // it. Stable callback so the per-card React.memo doesn't churn.
  const handleResetCircuit = React.useCallback(
    (subscriptionId: string, family: EndpointFamily) => {
      store.resetThrottleCircuit(subscriptionId, family);
    },
    [store],
  );

  // All known entries (unfiltered, flat list).
  const allEntries = React.useMemo(() => {
    return Object.entries(stats.perSubscription).map(([key, entry]) => ({
      ...parseKey(key),
      entry,
    }));
  }, [stats.perSubscription]);

  // Pre-filter counts — drive the chip badges so the operator can see "how
  // many circuits would match if I picked this filter" without applying it.
  const totalCounts = React.useMemo(() => {
    let open = 0;
    let halfOpen = 0;
    let closed = 0;
    let armCount = 0;
    let graphCount = 0;
    let batchCount = 0;
    let otherFamilyCount = 0;
    for (const e of allEntries) {
      if (e.entry.state === "open") open++;
      else if (e.entry.state === "half_open") halfOpen++;
      else closed++;
      const cat = familyCategory(e.family);
      if (cat === "arm") armCount++;
      else if (cat === "graph") graphCount++;
      else if (cat === "batch") batchCount++;
      else otherFamilyCount++;
    }
    return {
      open,
      halfOpen,
      closed,
      total: allEntries.length,
      armCount,
      graphCount,
      batchCount,
      otherFamilyCount,
    };
  }, [allEntries]);

  // Filtered + sorted entries — this is what the cards & export use.
  const entries = React.useMemo(() => {
    const q = searchText.trim().toLowerCase();
    let items = allEntries;
    if (stateFilter !== "all") {
      items = items.filter((e) => e.entry.state === stateFilter);
    }
    if (familyFilter !== "all") {
      items = items.filter((e) => familyCategory(e.family) === familyFilter);
    }
    if (q) {
      items = items.filter(
        (e) =>
          e.subscriptionId.toLowerCase().includes(q) ||
          e.family.toLowerCase().includes(q) ||
          familyLabel(e.family).toLowerCase().includes(q),
      );
    }

    const order: Record<CircuitState, number> = {
      open: 0,
      half_open: 1,
      closed: 2,
    };
    const sorted = [...items];
    switch (sortKey) {
      case "smart":
        sorted.sort((a, b) => {
          const so = order[a.entry.state] - order[b.entry.state];
          if (so !== 0) return so;
          const rt = b.entry.recentThrottles - a.entry.recentThrottles;
          if (rt !== 0) return rt;
          return a.subscriptionId.localeCompare(b.subscriptionId);
        });
        break;
      case "refill-asc":
        sorted.sort((a, b) => a.entry.refillPerSec - b.entry.refillPerSec);
        break;
      case "refill-desc":
        sorted.sort((a, b) => b.entry.refillPerSec - a.entry.refillPerSec);
        break;
      case "recent-desc":
        sorted.sort(
          (a, b) => b.entry.recentThrottles - a.entry.recentThrottles,
        );
        break;
      case "sub-asc":
        sorted.sort((a, b) =>
          a.subscriptionId.localeCompare(b.subscriptionId),
        );
        break;
    }
    return sorted;
  }, [allEntries, searchText, stateFilter, familyFilter, sortKey]);

  // Visible (post-filter) counts for the summary stat row.
  const visibleCounts = React.useMemo(() => {
    let open = 0;
    let halfOpen = 0;
    let closed = 0;
    let recentThrottles = 0;
    for (const e of entries) {
      if (e.entry.state === "open") open++;
      else if (e.entry.state === "half_open") halfOpen++;
      else closed++;
      recentThrottles += e.entry.recentThrottles;
    }
    return { open, halfOpen, closed, total: entries.length, recentThrottles };
  }, [entries]);

  // "Recovered in last hour" — count of *→closed transitions in the last 60min.
  // Useful incident-report stat (alongside "still open right now").
  const recoveredLastHour = React.useMemo(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    let count = 0;
    for (const t of stats.history) {
      const ts = new Date(t.timestamp).getTime();
      if (!Number.isNaN(ts) && ts >= cutoff && t.to === "closed") count++;
    }
    return count;
    // recompute when history changes or once a minute as time advances.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.history, Math.floor(nowTick / 60)]);

  // Group transitions into recency buckets for the history log so the
  // reader's eye lands on "what happened in the last hour" first. The
  // bucketing key (`now`) re-evaluates when the wall-clock day rolls over,
  // not on every 1s tick — that would invalidate the memo every second.
  // We snap `now` to the nearest minute so cross-bucket boundaries (an
  // event aging out of "lastHour") are still picked up promptly.
  const bucketingNow = React.useMemo(
    () => Math.floor(Date.now() / 60_000) * 60_000,
    // re-derive when nowTick advances at most once a minute via integer
    // truncation — the dependency uses a coarse value so the memo is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Math.floor(nowTick / 60)],
  );

  // Apply the same search / family filter to the history log so an operator
  // chasing a specific subscription / family doesn't get distracted by
  // unrelated transitions. State filter applies to the "to" state (i.e. what
  // the circuit became) since that's what's actionable.
  const filteredHistory = React.useMemo(() => {
    const q = searchText.trim().toLowerCase();
    let items = stats.history;
    if (stateFilter !== "all") {
      items = items.filter((t) => t.to === stateFilter);
    }
    if (familyFilter !== "all") {
      items = items.filter((t) => familyCategory(t.family) === familyFilter);
    }
    if (q) {
      items = items.filter(
        (t) =>
          t.subscriptionId.toLowerCase().includes(q) ||
          t.family.toLowerCase().includes(q) ||
          familyLabel(t.family).toLowerCase().includes(q) ||
          t.reason.toLowerCase().includes(q),
      );
    }
    return items;
  }, [stats.history, searchText, stateFilter, familyFilter]);

  const groupedHistory = React.useMemo(() => {
    const groups: Record<TransitionBucket, ThrottleTransition[]> = {
      lastHour: [],
      earlierToday: [],
      yesterday: [],
      older: [],
    };
    // Newest first, matching prior reverse() behaviour.
    for (let i = filteredHistory.length - 1; i >= 0; i--) {
      const item = filteredHistory[i]!;
      groups[bucketTransition(item.timestamp, bucketingNow)].push(item);
    }
    return groups;
  }, [filteredHistory, bucketingNow]);

  // --- Export columns -------------------------------------------------------
  const circuitsExportColumns: ExportColumn<{
    subscriptionId: string;
    family: EndpointFamily;
    entry: ThrottleStatusEntry;
  }>[] = React.useMemo(
    () => [
      { header: "SubscriptionId", accessor: (r) => r.subscriptionId },
      { header: "EndpointFamily", accessor: (r) => r.family },
      { header: "FamilyLabel", accessor: (r) => familyLabel(r.family) },
      { header: "State", accessor: (r) => r.entry.state },
      { header: "RefillPerSec", accessor: (r) => r.entry.refillPerSec },
      {
        header: "RefillPct",
        accessor: (r) =>
          Math.min(
            100,
            Math.round(
              (r.entry.refillPerSec / ASSUMED_BASELINE_REFILL_PER_SEC) * 100,
            ),
          ),
      },
      {
        header: "RecentThrottles",
        accessor: (r) => r.entry.recentThrottles,
      },
      { header: "OpenUntil", accessor: (r) => r.entry.openUntil ?? "" },
    ],
    [],
  );

  const historyExportColumns: ExportColumn<ThrottleTransition>[] =
    React.useMemo(
      () => [
        { header: "Timestamp", accessor: (t) => t.timestamp },
        { header: "SubscriptionId", accessor: (t) => t.subscriptionId },
        { header: "EndpointFamily", accessor: (t) => t.family },
        { header: "FromState", accessor: (t) => t.from },
        { header: "ToState", accessor: (t) => t.to },
        { header: "Reason", accessor: (t) => t.reason },
      ],
      [],
    );

  // --- Bulk actions ---------------------------------------------------------
  const handleRequestResetAll = React.useCallback(
    () => setResetAllOpen(true),
    [],
  );
  const handleConfirmResetAll = React.useCallback(() => {
    for (const e of entries) {
      store.resetThrottleCircuit(e.subscriptionId, e.family);
    }
    setResetAllOpen(false);
  }, [entries, store]);
  const handleCancelResetAll = React.useCallback(
    () => setResetAllOpen(false),
    [],
  );

  const handleRequestClearHistory = React.useCallback(
    () => setClearHistoryOpen(true),
    [],
  );
  const handleConfirmClearHistory = React.useCallback(() => {
    // No dedicated store API — clear via the actions the store exposes.
    // Each open circuit's reset call clears its perSubscription entry; for
    // the transition history we just drop visible state by resetting every
    // entry currently tracked. (If the underlying breaker is still firing,
    // future transitions will repopulate.) This avoids reaching into store
    // internals from a page-scoped edit.
    for (const e of allEntries) {
      store.resetThrottleCircuit(e.subscriptionId, e.family);
    }
    setClearHistoryOpen(false);
  }, [allEntries, store]);
  const handleCancelClearHistory = React.useCallback(
    () => setClearHistoryOpen(false),
    [],
  );

  // --- Filter management ----------------------------------------------------
  const isFiltered =
    searchText.length > 0 ||
    stateFilter !== "all" ||
    familyFilter !== "all";

  const handleClearFilters = React.useCallback(() => {
    setSearchText("");
    setStateFilter("all");
    setFamilyFilter("all");
  }, []);

  const handleTogglePaused = React.useCallback(
    () => setPaused((p) => !p),
    [],
  );

  // Section visibility — distinguish "no traffic" vs "no matches".
  const hasAnyTraffic = totalCounts.total > 0;
  const hasMatches = entries.length > 0;
  const hasHistoryMatches = filteredHistory.length > 0;

  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="relative overflow-hidden rounded-xl border bg-card/50 p-6">
        <DotPattern fade="top-left" />
        <Meteors count={10} tone="primary" />
        <PageHeader
          className="relative z-10"
          title="Throttle Status"
          description="Live circuit state and refill rate for every Azure subscription this client has touched. Updates in real time as requests fire."
        >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleTogglePaused}
                  aria-pressed={paused}
                  aria-label={
                    paused
                      ? "Resume live time updates"
                      : "Pause live time updates"
                  }
                  className="gap-1.5"
                >
                  {paused ? (
                    <Play className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <PauseCircle className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {paused ? "Resume" : "Pause"}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Pauses the 1-second tick that drives countdowns and "X seconds
                ago" labels. The store still receives live updates — only the
                wall-clock-driven UI freezes.
              </TooltipContent>
            </Tooltip>
            <ExportMenu
              rows={entries}
              columns={circuitsExportColumns}
              filename="throttle-circuits"
              label="Export circuits"
              jsonMetadata={{
                source: "AzureBatchManager.ThrottleStatus",
                filters: {
                  searchText: searchText || undefined,
                  stateFilter,
                  familyFilter,
                  sortKey,
                },
              }}
              disabled={!hasMatches}
            />
            <ExportMenu
              rows={filteredHistory}
              columns={historyExportColumns}
              filename="throttle-history"
              label="Export history"
              jsonMetadata={{
                source: "AzureBatchManager.ThrottleHistory",
                filters: {
                  searchText: searchText || undefined,
                  stateFilter,
                  familyFilter,
                },
              }}
              disabled={!hasHistoryMatches}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!hasMatches}
                    onClick={handleRequestResetAll}
                    className="gap-1.5"
                    aria-label={`Reset ${entries.length} visible circuit${entries.length === 1 ? "" : "s"}`}
                  >
                    <RotateCw className="h-3.5 w-3.5" aria-hidden />
                    Reset visible
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Clears displayed state for every visible (filtered) circuit.
                Next request will re-populate from the live guard.
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!hasAnyTraffic}
                    onClick={handleRequestClearHistory}
                    className="gap-1.5 border-destructive/60 text-destructive hover:bg-destructive/10"
                    aria-label="Clear all tracked circuit state"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Clear all
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Clears every tracked circuit (all subscriptions, all families).
                Future requests repopulate as they fire.
              </TooltipContent>
            </Tooltip>
        </PageHeader>
      </div>

      {/* Summary cards — five at-a-glance counters. */}
      <div className="relative grid grid-cols-2 gap-2 overflow-hidden rounded-xl sm:grid-cols-3 lg:grid-cols-5">
        <BorderBeam size={200} duration={8} />
        <SummaryCard
          icon={<Zap className="h-3.5 w-3.5 text-muted-foreground" />}
          label="Tracked"
          value={totalCounts.total}
        />
        <SummaryCard
          icon={<ShieldAlert className="h-3.5 w-3.5 text-destructive" />}
          label="Open"
          value={totalCounts.open}
          accent="destructive"
        />
        <SummaryCard
          icon={<PauseCircle className="h-3.5 w-3.5 text-warning" />}
          label="Probing"
          value={totalCounts.halfOpen}
          accent="warning"
        />
        <SummaryCard
          icon={<CheckCircle2 className="h-3.5 w-3.5 text-success" />}
          label="Healthy"
          value={totalCounts.closed}
          accent="success"
        />
        <SummaryCard
          icon={<History className="h-3.5 w-3.5 text-info" />}
          label="Recovered 1h"
          value={recoveredLastHour}
          accent="info"
        />
      </div>

      {/* Toolbar: search + state chips + family chips + sort selector. */}
      <section
        className="flex flex-col gap-2 rounded-xl border border-border bg-surface-base/40 p-3"
        aria-label="Throttle filters"
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              placeholder="Search by subscription, family, or reason..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="h-8 pl-7"
              aria-label="Search circuits and history"
            />
            {searchText && (
              <button
                type="button"
                onClick={() => setSearchText("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            )}
          </div>
          <InfoTooltip
            content="Matches against subscription id, endpoint family, and (for the history log) the transition reason. Case-insensitive substring."
            ariaLabel="Search field help"
          />

          <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Filter className="h-3 w-3" aria-hidden />
            Sort
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              aria-label="Sort circuits"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          {isFiltered && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleClearFilters}
              className="gap-1.5"
              aria-label="Clear all filters"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Clear filters
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* State quick-filter chips */}
          <div
            className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5"
            role="group"
            aria-label="Filter by circuit state"
          >
            {(
              [
                { key: "all", label: "All", count: totalCounts.total },
                { key: "open", label: "Open", count: totalCounts.open },
                {
                  key: "half_open",
                  label: "Probing",
                  count: totalCounts.halfOpen,
                },
                {
                  key: "closed",
                  label: "Healthy",
                  count: totalCounts.closed,
                },
              ] as const
            ).map((chip) => (
              <Tooltip key={chip.key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setStateFilter(chip.key)}
                    aria-pressed={stateFilter === chip.key}
                    className={cn(
                      "rounded-sm px-2 py-1 text-2xs font-medium uppercase tracking-wider transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                      stateFilter === chip.key
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                    )}
                  >
                    {chip.label}
                    <span className="ml-1 tabular-nums opacity-70">
                      {chip.count}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  {chip.key === "all"
                    ? "Show every tracked circuit, regardless of state."
                    : STATE_DEFINITION[chip.key as CircuitState]}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>

          {/* Family quick-filter chips */}
          <div
            className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5"
            role="group"
            aria-label="Filter by endpoint family"
          >
            {(
              [
                { key: "all", label: "All families", count: totalCounts.total },
                { key: "arm", label: "ARM", count: totalCounts.armCount },
                {
                  key: "graph",
                  label: "Graph",
                  count: totalCounts.graphCount,
                },
                {
                  key: "batch",
                  label: "Batch",
                  count: totalCounts.batchCount,
                },
                ...(totalCounts.otherFamilyCount > 0
                  ? [
                      {
                        key: "other" as const,
                        label: "Other",
                        count: totalCounts.otherFamilyCount,
                      },
                    ]
                  : []),
              ] as const
            ).map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setFamilyFilter(chip.key)}
                aria-pressed={familyFilter === chip.key}
                className={cn(
                  "rounded-sm px-2 py-1 text-2xs font-medium uppercase tracking-wider transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  familyFilter === chip.key
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {chip.label}
                <span className="ml-1 tabular-nums opacity-70">
                  {chip.count}
                </span>
              </button>
            ))}
          </div>

          {/* Visible-result counters — gentle confirmation of the filter. */}
          <div
            className="ml-auto flex flex-wrap gap-2"
            role="group"
            aria-label="Visible result counts"
          >
            <SummaryStatItem
              label="Visible"
              value={visibleCounts.total}
              compact
              tone={isFiltered ? "info" : "muted"}
            />
            <SummaryStatItem
              label="Recent 429s"
              value={visibleCounts.recentThrottles}
              compact
              tone={visibleCounts.recentThrottles > 0 ? "warning" : "muted"}
            />
          </div>
        </div>
      </section>

      {/* Per-(sub, family) cards */}
      <section className="rounded-xl border border-border bg-surface-base/40 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Subscriptions × endpoint families
          </span>
          <span className="text-2xs text-muted-foreground tabular-nums">
            ({entries.length}
            {isFiltered ? ` of ${totalCounts.total}` : ""})
          </span>
          <InfoTooltip
            ariaLabel="What these cards mean"
            content={
              <div className="space-y-1.5 text-xs leading-relaxed">
                <p className="m-0">
                  Each card is one (subscription, endpoint family) pair the
                  RequestGuard has observed. The progress bar shows the
                  current refill rate as a percentage of the assumed baseline
                  ({ASSUMED_BASELINE_REFILL_PER_SEC}/s).
                </p>
                <p className="m-0">
                  <strong>Healthy</strong> — calls flow normally.{" "}
                  <strong>Probing</strong> — one trial request is in flight
                  after a cooldown. <strong>Open</strong> — the breaker is
                  short-circuiting; no calls reach Azure for this pair.
                </p>
                <p className="m-0">
                  Hover the per-row reset icon to clear a single circuit; use
                  "Reset visible" in the header to clear them in bulk.
                </p>
              </div>
            }
          />
        </div>
        {!hasAnyTraffic ? (
          <EmptyState
            icon={Zap}
            title="No traffic observed yet"
            description="Issue any Azure call (sign in, list accounts, refresh data) and entries appear here as the request guard observes them."
          />
        ) : !hasMatches ? (
          <EmptyState
            icon={Filter}
            title="No circuits match the current filter"
            description="Loosen the search text or pick a different state/family chip to widen the result set."
            action={{
              label: "Clear filters",
              onClick: handleClearFilters,
              icon: X,
            }}
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {entries.map(({ subscriptionId, family, entry }) => (
              <ThrottleCardMemo
                key={`${subscriptionId}::${family}`}
                subscriptionId={subscriptionId}
                family={family}
                entry={entry}
                nowTick={nowTick}
                onReset={handleResetCircuit}
              />
            ))}
          </div>
        )}
      </section>

      {/* Transition history — grouped by recency so the reader sees
          "what just happened" before "what happened yesterday". */}
      <section className="rounded-xl border border-border bg-surface-base/40 p-3">
        <div className="mb-2 flex items-center gap-2">
          <History
            className="h-3.5 w-3.5 text-muted-foreground"
            aria-hidden
          />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent transitions
          </span>
          <span className="text-2xs text-muted-foreground tabular-nums">
            ({filteredHistory.length}
            {isFiltered ? ` of ${stats.history.length}` : ` / 50`})
          </span>
          <InfoTooltip
            ariaLabel="What this history shows"
            content="Every time a circuit flips between closed / probing / open, an entry lands here. The buffer is capped at 50 — older entries are dropped. The current state/family/search filters apply here too (state filter targets the destination state)."
          />
        </div>
        {stats.history.length === 0 ? (
          <EmptyState
            icon={History}
            title="No circuit transitions yet"
            description="Entries land here when a breaker opens, probes, or closes — usually after a 429 from Azure or a successful retry."
          />
        ) : !hasHistoryMatches ? (
          <EmptyState
            icon={Filter}
            title="No transitions match the current filter"
            description="Try widening the search text or clearing the state/family chips."
            action={{
              label: "Clear filters",
              onClick: handleClearFilters,
              icon: X,
            }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {BUCKET_ORDER.map((bucket) => {
              const items = groupedHistory[bucket];
              if (items.length === 0) return null;
              return (
                <div key={bucket} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline gap-2">
                    <h3 className="m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {BUCKET_LABEL[bucket]}
                    </h3>
                    <span className="text-2xs tabular-nums text-muted-foreground/70">
                      {items.length}
                    </span>
                  </div>
                  <HoverList
                    items={items}
                    getKey={(t, i) => `${t.timestamp}-${i}`}
                    tone="primary"
                    className="gap-1"
                    renderItem={(t) => (
                      <TransitionRow t={t} nowTick={nowTick} />
                    )}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {totalCounts.open > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold">
              {totalCounts.open} circuit
              {totalCounts.open === 1 ? " is" : "s are"} open right now.
            </p>
            <p className="mt-0.5 text-destructive/80">
              No requests are being dispatched on those (subscription, family)
              pairs until the cooldown elapses. The breaker will probe with a
              single request when it transitions to <em>Probing</em>; success
              closes it, another 429 reopens it with doubled cooldown.
            </p>
          </div>
        </div>
      )}

      {totalCounts.open === 0 &&
        totalCounts.halfOpen === 0 &&
        totalCounts.total > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/5 p-3 text-xs text-success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              All tracked subscriptions are healthy. Predictive
              rate-limit-header reading is keeping us ahead of throttle
              thresholds.
            </span>
          </div>
        )}

      {/* Confirmation dialogs */}
      <ConfirmationDialog
        hidden={!resetAllOpen}
        title="Reset visible circuits?"
        message={
          <span>
            This clears displayed state for the{" "}
            <strong>{entries.length}</strong> circuit
            {entries.length === 1 ? "" : "s"} currently visible. The next
            request on each pair will repopulate the entry from the live
            guard — if the underlying breaker is still open, the state will
            return.
          </span>
        }
        confirmText="Reset visible"
        cancelText="Cancel"
        onConfirm={handleConfirmResetAll}
        onCancel={handleCancelResetAll}
      />

      <ConfirmationDialog
        hidden={!clearHistoryOpen}
        title="Clear all tracked circuits?"
        message={
          <span>
            This clears every tracked (subscription, family) pair — all{" "}
            <strong>{totalCounts.total}</strong>. Future requests will
            repopulate as they fire. The transition log is unaffected and
            ages out naturally at 50 entries.
          </span>
        }
        confirmText="Clear all"
        cancelText="Cancel"
        danger
        onConfirm={handleConfirmClearHistory}
        onCancel={handleCancelClearHistory}
      />
    </div>
  );
};

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  accent?: "primary" | "success" | "warning" | "destructive" | "info" | "muted";
}

const SummaryCard: React.FC<SummaryCardProps> = ({
  icon,
  label,
  value,
  accent = "muted",
}) => (
  <div
    className={cn(
      "flex items-center justify-between rounded-lg border bg-card px-3 py-2",
      "transition-[box-shadow,border-color,transform] duration-200 ease-out motion-reduce:transition-none",
      "hover:-translate-y-0.5 hover:shadow-sm",
      accent === "primary" && "border-primary/30 hover:border-primary/50",
      accent === "success" && "border-success/30 hover:border-success/50",
      accent === "warning" && "border-warning/30 hover:border-warning/50",
      accent === "destructive" &&
        "border-destructive/30 hover:border-destructive/50",
      accent === "info" && "border-info/30 hover:border-info/50",
      accent === "muted" && "border-border",
    )}
  >
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
    <span className="text-lg font-semibold tabular-nums text-foreground">
      <NumberTicker value={value} />
    </span>
  </div>
);

