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
  Activity,
  Bell,
  BellOff,
  CheckCircle2,
  CircleAlert,
  Clock,
  Filter,
  Gauge,
  History,
  Keyboard,
  PauseCircle,
  Play,
  RotateCw,
  Save,
  Search,
  ShieldAlert,
  Siren,
  Trash2,
  X,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
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

import { auditLog } from "../../services/audit-log";
import { useUrlState } from "../../hooks/use-url-state";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";

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
// Defender-lens: 429 storm correlation
// ---------------------------------------------------------------------------
//
// A *sudden* burst of throttle-opens across many subscriptions is one of the
// signals red-team tooling (ScoutSuite, Prowler, AzureHound, ROADrecon)
// reliably emits when it enumerates a tenant: the credential chain in
// `_analysis_defender_view.md` §1 (DefaultAzureCredential — Environment →
// MI → SharedTokenCache → VSCredential → AzureCli → InteractiveBrowser)
// walks `tenants` (defender-view §4), `subscriptions`, `roleAssignments`,
// `keyVault.secrets`, etc. in fast loops — the ARM and Graph token-buckets
// drain almost instantly and the breaker pops on many (sub, family) pairs
// inside a short window. The user-facing UI thus exposes a "storm" banner
// when:
//   - >= STORM_MIN_OPENS transitions to `open` land within the rolling
//     STORM_WINDOW_MS, OR
//   - those opens span >= STORM_MIN_DISTINCT_SUBS distinct subscriptionIds.
//
// Reference (read-only): C:\Users\baimgprodsesa1\Desktop\New folder\
//   _analysis_defender_view.md:6-19   (DefaultAzureCredential chain)
//   _analysis_defender_view.md:72-79  (tenants enumeration, single-token
//                                      multi-tenant pivots)
//   _analysis_dafthack.md             (GraphRunner / MFASweep — the same
//                                      enumeration signature on Graph)
const STORM_WINDOW_MS = 5 * 60_000;
const STORM_MIN_OPENS = 5;
const STORM_MIN_DISTINCT_SUBS = 3;

interface StormSignal {
  active: boolean;
  opens: number;
  distinctSubs: number;
  distinctFamilies: number;
  windowStart: string | null;
}

function computeStormSignal(
  history: readonly ThrottleTransition[],
  now: number,
): StormSignal {
  const cutoff = now - STORM_WINDOW_MS;
  const subs = new Set<string>();
  const families = new Set<string>();
  let opens = 0;
  let earliest = Infinity;
  for (const t of history) {
    if (t.to !== "open") continue;
    const ts = new Date(t.timestamp).getTime();
    if (Number.isNaN(ts) || ts < cutoff) continue;
    opens++;
    subs.add(t.subscriptionId);
    families.add(t.family);
    if (ts < earliest) earliest = ts;
  }
  const active =
    opens >= STORM_MIN_OPENS || subs.size >= STORM_MIN_DISTINCT_SUBS;
  return {
    active,
    opens,
    distinctSubs: subs.size,
    distinctFamilies: families.size,
    windowStart: earliest === Infinity ? null : new Date(earliest).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Family-roll-up — for the alert-subscription gate and the stacked bar.
// ---------------------------------------------------------------------------

const FAMILY_CATEGORIES: readonly FamilyCategory[] = [
  "arm",
  "graph",
  "batch",
  "other",
] as const;

const FAMILY_CATEGORY_LABEL: Record<FamilyCategory, string> = {
  arm: "ARM",
  graph: "Graph",
  batch: "Batch",
  other: "Other",
};

/**
 * Per-family aggregate stats used by the stacked bar and the alert gate.
 * `transitionsToOpen` is the count of *→open transitions in the last hour
 * for that family — the right scale for visualising 429 storm shape.
 */
interface FamilyStats {
  category: FamilyCategory;
  recentThrottles: number;
  opensLastHour: number;
}

function computeFamilyStats(
  entries: ReadonlyArray<{ family: EndpointFamily; entry: ThrottleStatusEntry }>,
  history: readonly ThrottleTransition[],
  now: number,
): Record<FamilyCategory, FamilyStats> {
  const acc: Record<FamilyCategory, FamilyStats> = {
    arm: { category: "arm", recentThrottles: 0, opensLastHour: 0 },
    graph: { category: "graph", recentThrottles: 0, opensLastHour: 0 },
    batch: { category: "batch", recentThrottles: 0, opensLastHour: 0 },
    other: { category: "other", recentThrottles: 0, opensLastHour: 0 },
  };
  for (const e of entries) {
    acc[familyCategory(e.family)].recentThrottles += e.entry.recentThrottles;
  }
  const cutoff = now - 60 * 60 * 1000;
  for (const t of history) {
    if (t.to !== "open") continue;
    const ts = new Date(t.timestamp).getTime();
    if (Number.isNaN(ts) || ts < cutoff) continue;
    acc[familyCategory(t.family)].opensLastHour++;
  }
  return acc;
}

// Family-category palette for the stacked-bar — uses CSS vars from theme
// so dark/light modes stay legible without explicit hex codes.
const FAMILY_BAR_TONE: Record<FamilyCategory, { bg: string; fg: string }> = {
  arm: { bg: "bg-primary/70", fg: "text-primary" },
  graph: { bg: "bg-info/70", fg: "text-info" },
  batch: { bg: "bg-warning/70", fg: "text-warning" },
  other: { bg: "bg-muted-foreground/50", fg: "text-muted-foreground" },
};

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

const VALID_STATE_FILTERS: ReadonlySet<StateFilter> = new Set<StateFilter>([
  "all",
  "closed",
  "half_open",
  "open",
]);
const VALID_FAMILY_FILTERS: ReadonlySet<FamilyFilter> = new Set<FamilyFilter>([
  "all",
  "arm",
  "graph",
  "batch",
  "other",
]);
const VALID_SORT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>([
  "smart",
  "refill-asc",
  "refill-desc",
  "recent-desc",
  "sub-asc",
]);

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
// Stacked bar — 429s by service family
// ---------------------------------------------------------------------------

interface FamilyStackedBarProps {
  /** Source data — per-family aggregates. */
  stats: Record<FamilyCategory, FamilyStats>;
  /**
   * Which metric to display. `recentThrottles` is "current pressure",
   * `opensLastHour` is "storm shape over the last hour". The default is
   * `recentThrottles` because that's the live signal an operator wants.
   */
  metric: "recentThrottles" | "opensLastHour";
}

/**
 * Compact horizontal stacked bar that visualises 429 pressure broken down
 * by service-family category. Pure CSS — no chart-library dependency. The
 * bar is hidden when total is zero so the page doesn't carry empty chrome.
 */
const FamilyStackedBar: React.FC<FamilyStackedBarProps> = ({ stats, metric }) => {
  const segments = FAMILY_CATEGORIES.map((cat) => ({
    cat,
    value: stats[cat][metric],
  }));
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="relative flex h-3 w-full overflow-hidden rounded-full border border-border bg-card"
        role="img"
        aria-label={`429 distribution by service family. ${segments
          .filter((s) => s.value > 0)
          .map(
            (s) =>
              `${FAMILY_CATEGORY_LABEL[s.cat]}: ${s.value} (${Math.round(
                (s.value / total) * 100,
              )}%)`,
          )
          .join(", ")}`}
      >
        {segments.map(({ cat, value }) => {
          if (value === 0) return null;
          const pct = (value / total) * 100;
          return (
            <Tooltip key={cat}>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "h-full transition-all duration-200 ease-out motion-reduce:transition-none cursor-help",
                    FAMILY_BAR_TONE[cat].bg,
                  )}
                  style={{ width: `${pct}%` }}
                />
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="text-xs">
                  <strong>{FAMILY_CATEGORY_LABEL[cat]}</strong>: {value} (
                  {Math.round(pct)}%)
                </span>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        {segments
          .filter((s) => s.value > 0)
          .map(({ cat, value }) => (
            <span
              key={cat}
              className="inline-flex items-center gap-1 tabular-nums"
            >
              <span
                aria-hidden
                className={cn("h-2 w-2 rounded-sm", FAMILY_BAR_TONE[cat].bg)}
              />
              <span className={FAMILY_BAR_TONE[cat].fg}>
                {FAMILY_CATEGORY_LABEL[cat]}
              </span>
              <span>{value}</span>
            </span>
          ))}
      </div>
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
  // reading mid-incident isn't fighting flashing numbers. The "polling"
  // loop is wired through useAbortableEffect so unmounting (or pausing)
  // tears the timer down deterministically.
  const [paused, setPaused] = React.useState(false);
  const [nowTick, setNowTick] = React.useState(0);
  useAbortableEffect(
    (signal) => {
      if (paused) return;
      const t = window.setInterval(() => {
        if (signal.aborted) return;
        setNowTick((n) => n + 1);
      }, 1_000);
      return () => window.clearInterval(t);
    },
    [paused],
  );

  // --- Filter / sort UI state — URL-synced so deep-links survive reload ----
  // Default schema is render-stable per useUrlState contract.
  const [urlFilters, setUrlFilters] = useUrlState<{
    q: string;
    state: string;
    family: string;
    sort: string;
  }>(
    {
      q: "",
      state: "all",
      family: "all",
      sort: "smart",
    },
    { replace: true },
  );
  // Validate URL-derived values against the closed enum sets — a hand-edited
  // URL with `?state=garbage` would otherwise leak through and break the
  // filter comparator. Falls back to the default on any mismatch.
  const searchText = urlFilters.q;
  const stateFilter: StateFilter = VALID_STATE_FILTERS.has(
    urlFilters.state as StateFilter,
  )
    ? (urlFilters.state as StateFilter)
    : "all";
  const familyFilter: FamilyFilter = VALID_FAMILY_FILTERS.has(
    urlFilters.family as FamilyFilter,
  )
    ? (urlFilters.family as FamilyFilter)
    : "all";
  const sortKey: SortKey = VALID_SORT_KEYS.has(urlFilters.sort as SortKey)
    ? (urlFilters.sort as SortKey)
    : "smart";

  const setSearchText = React.useCallback(
    (next: string) => setUrlFilters({ q: next }),
    [setUrlFilters],
  );
  const setStateFilter = React.useCallback(
    (next: StateFilter) => setUrlFilters({ state: next }),
    [setUrlFilters],
  );
  const setFamilyFilter = React.useCallback(
    (next: FamilyFilter) => setUrlFilters({ family: next }),
    [setUrlFilters],
  );
  const setSortKey = React.useCallback(
    (next: SortKey) => setUrlFilters({ sort: next }),
    [setUrlFilters],
  );

  // Persisted threshold for the capacity-warning banner. Operator chooses
  // a percentage of baseline refill — when the average drops below it, the
  // page surfaces a warning chip. Stored cross-tab so paired operators see
  // the same alert thresholds.
  const [warnAtPct, setWarnAtPct] = usePersistedState<number>(
    "throttle.warnAtPct",
    80,
    { version: 1, syncAcrossTabs: true },
  );

  // Operator-calibrated "expected baseline" of avg refill %. Captured at a
  // known-good moment (a button below grabs the current avg). The page then
  // alerts when the live avg drifts NEGATIVE by more than DRIFT_BAND_PCT
  // points from that baseline — catches gradual capacity loss that the
  // absolute-floor warnAtPct misses (e.g. baseline 95 → drift to 86 is fine
  // by warnAtPct=80 but is still a 9-point degradation).
  const [baselinePct, setBaselinePct] = usePersistedState<number | null>(
    "throttle.baselinePct",
    null,
    { version: 1, syncAcrossTabs: true },
  );

  // Per-family alert subscription set — operators silence "expected" 429
  // sources (e.g. a noisy Graph polling loop) and keep alerts focused on
  // the families they care about. The default subscribes to all families
  // so first-run UX matches today's all-or-nothing behavior.
  const [alertedFamilies, setAlertedFamilies] = usePersistedState<
    Record<FamilyCategory, boolean>
  >(
    "throttle.alertedFamilies",
    { arm: true, graph: true, batch: true, other: true },
    { version: 1, syncAcrossTabs: true },
  );

  // Which metric the family stacked-bar shows. Persisted so paired ops see
  // the same panel between reloads.
  const [familyBarMetric, setFamilyBarMetric] = usePersistedState<
    "recentThrottles" | "opensLastHour"
  >("throttle.familyBarMetric", "recentThrottles", {
    version: 1,
    syncAcrossTabs: true,
  });

  const [keyboardHelpOpen, setKeyboardHelpOpen] = React.useState(false);
  const [resetAllOpen, setResetAllOpen] = React.useState(false);
  const [clearHistoryOpen, setClearHistoryOpen] = React.useState(false);

  // Per-row Reset handler — drops the entry from the throttle store so the
  // card disappears. The next observe() from the live guard will repopulate
  // it. Stable callback so the per-card React.memo doesn't churn.
  //
  // Throttle policy mutations affect ARM call rate *globally* (every page
  // shares the same RequestGuard), so they are audited per Project rule
  // "auditLog.record on throttle policy mutations".
  const handleResetCircuit = React.useCallback(
    (subscriptionId: string, family: EndpointFamily) => {
      store.resetThrottleCircuit(subscriptionId, family);
      auditLog.record({
        actor: "operator",
        action: "throttle.reset_circuit",
        target: `circuit:${subscriptionId}::${family}`,
        details: { subscriptionId, family },
        status: "success",
      });
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

  // KPI tiles — derived stats surfaced via SummaryStatItem. All memoized so
  // they only recompute when the underlying entries (or the once-per-minute
  // wall-clock bucket) change.
  const kpiStats = React.useMemo(() => {
    const baseline = ASSUMED_BASELINE_REFILL_PER_SEC;
    let sumPct = 0;
    let slowestPct = 100;
    let slowestKey: string | undefined;
    for (const e of allEntries) {
      const pct = Math.min(
        100,
        Math.round((e.entry.refillPerSec / baseline) * 100),
      );
      sumPct += pct;
      if (pct < slowestPct) {
        slowestPct = pct;
        slowestKey = `${e.subscriptionId}::${e.family}`;
      }
    }
    const avgPct =
      allEntries.length > 0 ? Math.round(sumPct / allEntries.length) : 100;
    return {
      avgPct,
      slowestPct: allEntries.length > 0 ? slowestPct : 100,
      slowestKey,
    };
  }, [allEntries]);

  // Transitions in the last minute — proxy for current 429 churn rate.
  const transitionsLastMin = React.useMemo(() => {
    const cutoff = Date.now() - 60_000;
    let count = 0;
    for (const t of stats.history) {
      const ts = new Date(t.timestamp).getTime();
      if (!Number.isNaN(ts) && ts >= cutoff) count++;
    }
    return count;
    // re-eval every 5s as the 60-second window slides. nowTick fires every
    // second, so divide by 5 to throttle the recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.history, Math.floor(nowTick / 5)]);

  // Live-tail of the last 50 transitions, newest first — feeds the live-tail
  // section. Kept separate from `filteredHistory` so it ignores filters and
  // always shows the operator the very latest events. The store already
  // caps history at 50, so this is just a reversed copy.
  const liveTail = React.useMemo(() => {
    const arr = stats.history;
    const out: ThrottleTransition[] = [];
    // copy in reverse — manual loop is cheaper than .slice().reverse() for
    // hot updates.
    for (let i = arr.length - 1; i >= 0; i--) out.push(arr[i]!);
    return out;
  }, [stats.history]);

  // Threshold-breach check — surfaces a banner when average refill drops
  // below the operator-set `warnAtPct` (capacity-loss alert).
  const thresholdBreach = React.useMemo(() => {
    if (allEntries.length === 0) return false;
    return kpiStats.avgPct < warnAtPct;
  }, [allEntries.length, kpiStats.avgPct, warnAtPct]);

  // Per-family aggregates — feeds the stacked-bar viz and the alert gate.
  // Re-derives when history (which seeds opens-last-hour) changes or once
  // a minute as the rolling window slides.
  const familyStats = React.useMemo(
    () =>
      computeFamilyStats(allEntries, stats.history, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allEntries, stats.history, Math.floor(nowTick / 60)],
  );

  // Filter the alerting decision by the operator's per-family subscription
  // mask. A breach on a silenced family doesn't trigger the banner, so the
  // page stays quiet for "expected" 429 sources. We compute this on top of
  // the absolute threshold so the existing UX (avgPct vs warnAtPct) is
  // preserved when all families are subscribed (default state).
  const alertedFamilyHasBreach = React.useMemo(() => {
    if (!thresholdBreach) return false;
    let anySubscribedHasThrottles = false;
    for (const cat of FAMILY_CATEGORIES) {
      if (!alertedFamilies[cat]) continue;
      if (familyStats[cat].recentThrottles > 0 || familyStats[cat].opensLastHour > 0) {
        anySubscribedHasThrottles = true;
        break;
      }
    }
    // If the avg dropped but no subscribed family is contributing 429s,
    // the breach is being driven by a silenced source — suppress it.
    return anySubscribedHasThrottles;
  }, [thresholdBreach, alertedFamilies, familyStats]);

  // Defender-lens 429-storm detector — see `_analysis_defender_view.md` §1
  // (DefaultAzureCredential chain) and §4 (single-token tenant enumeration).
  // A burst of `*→open` transitions across multiple subscriptions inside
  // STORM_WINDOW_MS is a strong tell for credential-enumeration / spray
  // tooling actively recon'ing the tenant. Recompute every 5s as the window
  // slides; nowTick fires every second so divide by 5.
  const stormSignal = React.useMemo(
    () => computeStormSignal(stats.history, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stats.history, Math.floor(nowTick / 5)],
  );

  // Filter storm-alert by the per-family subscription mask too — the same
  // silencing logic applies. The detector spans all families internally, so
  // we mute the banner if none of the contributing families are subscribed.
  const stormAlertActive = React.useMemo(() => {
    if (!stormSignal.active) return false;
    const cutoff = Date.now() - STORM_WINDOW_MS;
    for (const t of stats.history) {
      if (t.to !== "open") continue;
      const ts = new Date(t.timestamp).getTime();
      if (Number.isNaN(ts) || ts < cutoff) continue;
      if (alertedFamilies[familyCategory(t.family)]) return true;
    }
    return false;
  }, [stormSignal.active, stats.history, alertedFamilies]);

  // Baseline-drift check — independent of the absolute floor. Triggers when
  // the live avg has fallen more than DRIFT_BAND_PCT points below the
  // operator-saved baseline. Only meaningful when a baseline is set.
  const DRIFT_BAND_PCT = 10;
  const baselineDrift = React.useMemo(() => {
    if (baselinePct == null || allEntries.length === 0) return null;
    const delta = baselinePct - kpiStats.avgPct;
    if (delta <= DRIFT_BAND_PCT) return null;
    return { baseline: baselinePct, current: kpiStats.avgPct, delta };
  }, [baselinePct, kpiStats.avgPct, allEntries.length]);

  // Ref + edge-trigger so the ARIA-live announcement only fires when the
  // breach STATE changes (clear → warn or storm-off → storm-on), instead of
  // re-announcing on every tick. Screen readers otherwise re-read on every
  // re-render with `aria-live="assertive"`.
  const [liveAnnouncement, setLiveAnnouncement] = React.useState("");
  const prevAlertSnapshot = React.useRef<{
    breach: boolean;
    storm: boolean;
    drift: boolean;
  }>({ breach: false, storm: false, drift: false });
  React.useEffect(() => {
    const next = {
      breach: alertedFamilyHasBreach,
      storm: stormAlertActive,
      drift: baselineDrift != null,
    };
    const prev = prevAlertSnapshot.current;
    const msgs: string[] = [];
    if (next.breach && !prev.breach) {
      msgs.push(
        `Throttle alert: average refill ${kpiStats.avgPct} percent, below ${warnAtPct} percent threshold.`,
      );
    }
    if (next.storm && !prev.storm) {
      msgs.push(
        `Throttle storm detected: ${stormSignal.opens} circuit opens across ${stormSignal.distinctSubs} subscriptions in the last ${Math.round(
          STORM_WINDOW_MS / 60_000,
        )} minutes. Review for credential enumeration.`,
      );
    }
    if (next.drift && !prev.drift && baselineDrift) {
      msgs.push(
        `Throttle baseline drift: average refill ${baselineDrift.current} percent is ${baselineDrift.delta} points below saved baseline of ${baselineDrift.baseline} percent.`,
      );
    }
    if (msgs.length > 0) setLiveAnnouncement(msgs.join(" "));
    prevAlertSnapshot.current = next;
  }, [
    alertedFamilyHasBreach,
    stormAlertActive,
    baselineDrift,
    kpiStats.avgPct,
    warnAtPct,
    stormSignal.opens,
    stormSignal.distinctSubs,
  ]);

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
    auditLog.record({
      actor: "operator",
      action: "throttle.reset_visible",
      target: `circuits:${entries.length}`,
      details: {
        count: entries.length,
        filters: { searchText, stateFilter, familyFilter, sortKey },
      },
      status: "success",
    });
    setResetAllOpen(false);
  }, [entries, store, searchText, stateFilter, familyFilter, sortKey]);
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
    //
    // COORDINATOR: a future `clearThrottleHistory()` on the store would
    // also drop `throttleStats.history` (currently it only ages out at 50);
    // adding it would make this handler a one-call wipe instead of a sweep
    // across every entry.
    for (const e of allEntries) {
      store.resetThrottleCircuit(e.subscriptionId, e.family);
    }
    auditLog.record({
      actor: "operator",
      action: "throttle.clear_all",
      target: `circuits:${allEntries.length}`,
      details: { count: allEntries.length },
      status: "success",
    });
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
    setUrlFilters({ q: "", state: "all", family: "all" });
  }, [setUrlFilters]);

  const handleTogglePaused = React.useCallback(
    () => setPaused((p) => !p),
    [],
  );

  // Threshold input — clamps to 0…100 so the persisted value can never break
  // the comparator. Empty string falls back to the default of 80.
  const handleChangeThreshold = React.useCallback(
    (raw: string) => {
      if (raw === "") {
        setWarnAtPct(80);
        return;
      }
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) return;
      const clamped = Math.max(0, Math.min(100, parsed));
      setWarnAtPct(clamped);
    },
    [setWarnAtPct],
  );

  // Snapshot the current avg refill % as the "expected baseline" — the
  // drift detector compares live avg against this. Auditable because the
  // saved value participates in subsequent alerting decisions.
  const handleCalibrateBaseline = React.useCallback(() => {
    setBaselinePct(kpiStats.avgPct);
    auditLog.record({
      actor: "operator",
      action: "throttle.calibrate_baseline",
      target: "throttle.baselinePct",
      details: { savedAvgPct: kpiStats.avgPct, sampleSize: allEntries.length },
      status: "success",
    });
  }, [kpiStats.avgPct, allEntries.length, setBaselinePct]);

  const handleClearBaseline = React.useCallback(() => {
    setBaselinePct(null);
    auditLog.record({
      actor: "operator",
      action: "throttle.clear_baseline",
      target: "throttle.baselinePct",
      details: {},
      status: "success",
    });
  }, [setBaselinePct]);

  const handleToggleAlertedFamily = React.useCallback(
    (cat: FamilyCategory) => {
      setAlertedFamilies({ ...alertedFamilies, [cat]: !alertedFamilies[cat] });
    },
    [alertedFamilies, setAlertedFamilies],
  );

  const handleToggleFamilyBarMetric = React.useCallback(() => {
    setFamilyBarMetric(
      familyBarMetric === "recentThrottles" ? "opensLastHour" : "recentThrottles",
    );
  }, [familyBarMetric, setFamilyBarMetric]);

  // Page-scoped hotkeys. Ignored when focus is in an input/textarea/select
  // or any contenteditable so typing in the search box doesn't fire them.
  //  - `r` Reset visible circuits (confirm dialog)
  //  - `t` Toggle pause (tail / live-tick freeze)
  //  - `Esc` Clear filters (only when filters are active)
  //  - `?` Open keyboard help
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ignore modifier-laden combos so OS / browser shortcuts pass through.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // While any modal is open, Radix owns the keyboard. Let the dialog's
      // own onEscapeKeyDown / focus-trap handle the keys.
      if (keyboardHelpOpen || resetAllOpen || clearHistoryOpen) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          // Allow Esc to bubble out of search-clear etc., but only for Esc.
          if (e.key !== "Escape") return;
        }
      }
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setKeyboardHelpOpen((v) => !v);
        return;
      }
      if (e.key === "r" || e.key === "R") {
        if (entries.length === 0) return;
        e.preventDefault();
        setResetAllOpen(true);
        return;
      }
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        setPaused((p) => !p);
        return;
      }
      if (e.key === "Escape") {
        // Only intercept Esc when there's something to clear — otherwise
        // let it propagate to dialogs / global handlers.
        if (
          searchText.length > 0 ||
          stateFilter !== "all" ||
          familyFilter !== "all"
        ) {
          e.preventDefault();
          setUrlFilters({ q: "", state: "all", family: "all" });
        }
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    entries.length,
    searchText,
    stateFilter,
    familyFilter,
    setUrlFilters,
    keyboardHelpOpen,
    resetAllOpen,
    clearHistoryOpen,
  ]);

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
                  <Kbd>T</Kbd>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Pauses the 1-second tick that drives countdowns and "X seconds
                ago" labels. The store still receives live updates — only the
                wall-clock-driven UI freezes. Hotkey: <Kbd>T</Kbd>.
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setKeyboardHelpOpen(true)}
                  aria-label="Show keyboard shortcuts"
                  className="gap-1.5"
                >
                  <Keyboard className="h-3.5 w-3.5" aria-hidden />
                  <Kbd>?</Kbd>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Show keyboard shortcuts.
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
                    <Kbd>R</Kbd>
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Clears displayed state for every visible (filtered) circuit.
                Next request will re-populate from the live guard. Hotkey:{" "}
                <Kbd>R</Kbd>.
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

      {/* KPI tile row — fine-grained metrics via SummaryStatItem. */}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Throttle KPIs"
      >
        <SummaryStatItem
          label="Avg refill %"
          value={`${kpiStats.avgPct}%`}
          hint="of baseline"
          tone={
            kpiStats.avgPct >= 90
              ? "success"
              : kpiStats.avgPct >= warnAtPct
                ? "info"
                : "warning"
          }
          ariaLabel={`Average refill ${kpiStats.avgPct} percent of baseline`}
        />
        <SummaryStatItem
          label="Slowest %"
          value={`${kpiStats.slowestPct}%`}
          hint={kpiStats.slowestKey ? shortSub(kpiStats.slowestKey.split("::")[0] ?? "") : undefined}
          tone={
            kpiStats.slowestPct >= 80
              ? "success"
              : kpiStats.slowestPct >= 50
                ? "info"
                : "destructive"
          }
          ariaLabel={`Slowest circuit at ${kpiStats.slowestPct} percent of baseline`}
        />
        <SummaryStatItem
          label="Transitions / min"
          value={transitionsLastMin}
          hint="churn rate"
          tone={
            transitionsLastMin === 0
              ? "success"
              : transitionsLastMin < 5
                ? "info"
                : "warning"
          }
          ariaLabel={`${transitionsLastMin} circuit transitions in the last minute`}
        />
        <SummaryStatItem
          label="History buffer"
          value={`${stats.history.length} / 50`}
          tone="muted"
          ariaLabel={`History buffer holding ${stats.history.length} of 50 transitions`}
        />

        {/* Persisted threshold control — operator picks the alert floor. */}
        <label className="ml-auto flex items-center gap-2 rounded-lg border bg-card/70 px-3 py-2 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          Warn below
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={warnAtPct}
            onChange={(e) => handleChangeThreshold(e.target.value)}
            className="h-7 w-16 text-xs tabular-nums"
            aria-label="Warn when average refill falls below percent"
          />
          <span className="text-foreground">%</span>
          <InfoTooltip
            ariaLabel="Threshold help"
            content={
              <span>
                When the average refill rate (across all tracked
                subscriptions) drops below this percentage of baseline, a
                warning banner appears below. Persisted across reloads and
                synced across tabs.
              </span>
            }
          />
        </label>

        {/* Operator-calibrated baseline. Drift alert fires when the live avg
            falls more than 10 points below this saved value. */}
        <div className="flex items-center gap-2 rounded-lg border bg-card/70 px-3 py-2 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          Baseline
          <span className="tabular-nums text-foreground">
            {baselinePct == null ? "—" : `${baselinePct}%`}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={handleCalibrateBaseline}
                disabled={allEntries.length === 0}
                aria-label="Save current average as baseline"
                className="h-6 w-6"
              >
                <Save className="h-3 w-3" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              Snapshot the current avg refill % ({kpiStats.avgPct}%) as the
              expected baseline. The drift alert fires when the live avg
              falls more than 10 points below this value.
            </TooltipContent>
          </Tooltip>
          {baselinePct != null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleClearBaseline}
                  aria-label="Clear baseline"
                  className="h-6 w-6"
                >
                  <X className="h-3 w-3" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Clear the saved baseline.
              </TooltipContent>
            </Tooltip>
          )}
          <InfoTooltip
            ariaLabel="Baseline help"
            content={
              <span>
                The baseline is your "known-good" avg refill %. Calibrate it
                during normal load so the drift detector catches gradual
                capacity loss that the absolute warn-below floor misses.
              </span>
            }
          />
        </div>
      </div>

      {/* Family-comparison + alert-subscription panel.
          Renders only when there is *any* throttle pressure (recent 429s or
          opens in the last hour). When the page is quiet, the section is
          omitted so the chrome stays calm. */}
      {(familyStats.arm.recentThrottles +
        familyStats.graph.recentThrottles +
        familyStats.batch.recentThrottles +
        familyStats.other.recentThrottles +
        familyStats.arm.opensLastHour +
        familyStats.graph.opensLastHour +
        familyStats.batch.opensLastHour +
        familyStats.other.opensLastHour >
        0 ||
        FAMILY_CATEGORIES.some((c) => !alertedFamilies[c])) && (
        <section
          className="flex flex-col gap-3 rounded-xl border border-border bg-surface-base/40 p-3"
          aria-label="Throttle pressure by service family"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Activity
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden
            />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              429s by service family
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleToggleFamilyBarMetric}
                  className="ml-2 h-7 gap-1.5"
                  aria-label="Toggle stacked-bar metric"
                >
                  <span className="text-2xs">
                    {familyBarMetric === "recentThrottles"
                      ? "Recent 429s"
                      : "Opens · 1h"}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Toggles the stacked-bar metric.{" "}
                <strong>Recent 429s</strong> = live pressure from the entry
                snapshot. <strong>Opens · 1h</strong> = circuit opens in the
                last hour (storm shape).
              </TooltipContent>
            </Tooltip>
            <InfoTooltip
              ariaLabel="Family panel help"
              content={
                <span>
                  Compares throttle pressure across endpoint-family
                  categories — useful when one Azure surface (e.g. Graph
                  enumeration) is the storm source. Per-family alert
                  checkboxes silence "expected" 429 sources without
                  disabling the global threshold/drift/storm alerts.
                </span>
              }
            />
          </div>
          <FamilyStackedBar stats={familyStats} metric={familyBarMetric} />

          {/* Alert-subscription chips — operator gates which families
              participate in banner-level alerts. */}
          <div
            className="flex flex-wrap items-center gap-3 border-t border-border pt-2"
            role="group"
            aria-label="Per-family alert subscriptions"
          >
            <span className="inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
              <Bell className="h-3 w-3" aria-hidden />
              Alert on
            </span>
            {FAMILY_CATEGORIES.map((cat) => {
              const subscribed = alertedFamilies[cat];
              const stat = familyStats[cat];
              return (
                <Tooltip key={cat}>
                  <TooltipTrigger asChild>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs">
                      <Checkbox
                        checked={subscribed}
                        onCheckedChange={() => handleToggleAlertedFamily(cat)}
                        aria-label={`Alert on ${FAMILY_CATEGORY_LABEL[cat]} family`}
                      />
                      <span
                        className={cn(
                          "font-medium",
                          subscribed
                            ? FAMILY_BAR_TONE[cat].fg
                            : "text-muted-foreground/60",
                        )}
                      >
                        {FAMILY_CATEGORY_LABEL[cat]}
                      </span>
                      <span className="text-2xs tabular-nums text-muted-foreground">
                        {stat.recentThrottles}/{stat.opensLastHour}
                      </span>
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    {subscribed ? (
                      <span>
                        Alerts <strong>enabled</strong> for{" "}
                        {FAMILY_CATEGORY_LABEL[cat]}. Recent 429s:{" "}
                        {stat.recentThrottles}; opens in the last hour:{" "}
                        {stat.opensLastHour}.
                      </span>
                    ) : (
                      <span>
                        Alerts <strong>silenced</strong> for{" "}
                        {FAMILY_CATEGORY_LABEL[cat]}. Storm / threshold
                        banners ignore this family until re-enabled.
                      </span>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
            })}
            {FAMILY_CATEGORIES.some((c) => !alertedFamilies[c]) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 gap-1.5 text-2xs"
                    onClick={() =>
                      setAlertedFamilies({
                        arm: true,
                        graph: true,
                        batch: true,
                        other: true,
                      })
                    }
                    aria-label="Re-enable alerts for all families"
                  >
                    <BellOff className="h-3 w-3" aria-hidden />
                    Re-enable all
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Subscribe to alerts on every family.
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </section>
      )}

      {/*
        Single ARIA-live region for all three alert classes (threshold,
        storm, drift). Edge-triggered by the effect above so screen readers
        are notified ONCE per state change, not on every re-render. Visually
        hidden via inline style so the announcement doesn't double up with
        the visible banners.
      */}
      <div
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
        // sr-only is in our shared stylesheet; the inline width:1px clip is
        // belt-and-braces in case the class isn't loaded yet during SSR/hot-
        // reload.
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        {liveAnnouncement}
      </div>

      {/* Defender-lens storm banner — burst of 429-opens across many subs.
          See `_analysis_defender_view.md` §1+§4: credential-chain
          enumeration walks tenants/subscriptions/roleAssignments rapidly
          and trips many breakers in a short window. */}
      {stormAlertActive && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
        >
          <Siren className="mt-0.5 h-4 w-4 shrink-0 animate-pulse motion-reduce:animate-none" aria-hidden />
          <div className="flex-1">
            <p className="font-semibold">
              429 storm detected — {stormSignal.opens} circuit open
              {stormSignal.opens === 1 ? "" : "s"} across{" "}
              {stormSignal.distinctSubs} subscription
              {stormSignal.distinctSubs === 1 ? "" : "s"} in the last{" "}
              {Math.round(STORM_WINDOW_MS / 60_000)} minutes.
            </p>
            <p className="mt-0.5 text-destructive/80">
              This pattern matches the signature of bulk credential / tenant
              enumeration (cf. defender-view: DefaultAzureCredential chain
              walks <code className="text-2xs">tenants</code>,{" "}
              <code className="text-2xs">subscriptions</code>,{" "}
              <code className="text-2xs">roleAssignments</code> in fast
              loops). Review the audit log for privileged-action attempts
              correlated with this window and, if unexpected, rotate any
              recently-issued service-principal secrets.
            </p>
          </div>
        </div>
      )}

      {/* Baseline-drift banner — gradual degradation below the saved good. */}
      {baselineDrift && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-info/40 bg-info/5 p-3 text-xs text-info"
        >
          <Activity className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="flex-1">
            <p className="font-semibold">
              Refill rate has drifted{" "}
              <span className="tabular-nums">{baselineDrift.delta}</span>{" "}
              points below the saved baseline (
              <span className="tabular-nums">{baselineDrift.baseline}%</span>{" "}
              → <span className="tabular-nums">{baselineDrift.current}%</span>
              ).
            </p>
            <p className="mt-0.5 text-info/80">
              Capacity is degrading even though the absolute floor hasn't
              been hit. Re-calibrate or clear the baseline once the current
              load is the new normal.
            </p>
          </div>
        </div>
      )}

      {/* Threshold breach banner — only when an operator-set floor is crossed. */}
      {alertedFamilyHasBreach && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-warning"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="flex-1">
            <p className="font-semibold">
              Average refill rate at <span className="tabular-nums">{kpiStats.avgPct}%</span>{" "}
              is below the {warnAtPct}% warning threshold.
            </p>
            <p className="mt-0.5 text-warning/80">
              Capacity has degraded across tracked subscriptions. Expect
              slower request fan-out until rates recover. Adjust the
              threshold in the KPI row, or reset visible circuits to clear
              displayed state.
            </p>
          </div>
        </div>
      )}

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
            <Tooltip>
              <TooltipTrigger asChild>
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
                  <Kbd>Esc</Kbd>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Clear search, state, and family filters. Hotkey: <Kbd>Esc</Kbd>.
              </TooltipContent>
            </Tooltip>
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

      {/* Live tail — the most recent 50 transitions in raw chronological
          order, unfiltered, capped to a scrollable strip. Designed for
          mid-incident "watch the storm" usage; the grouped section below
          is the slower analytical view. */}
      {liveTail.length > 0 && (
        <section
          className="rounded-xl border border-border bg-surface-base/40 p-3"
          aria-label="Live tail of throttle transitions"
        >
          <div className="mb-2 flex items-center gap-2">
            <span
              className="live-pulse-dot"
              style={{ ["--live-tone" as never]: "var(--primary)" }}
              aria-hidden
            />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Live tail
            </span>
            <span className="text-2xs text-muted-foreground tabular-nums">
              ({liveTail.length} latest)
            </span>
            <InfoTooltip
              ariaLabel="What the live tail shows"
              content="The newest transitions across every subscription / family, ignoring filters. Use the grouped Recent transitions section below for filtered analytics."
            />
          </div>
          <div
            className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-1"
            role="log"
            aria-live="polite"
            aria-atomic="false"
          >
            {liveTail.map((t, i) => (
              <TransitionRow
                key={`tail-${t.timestamp}-${i}`}
                t={t}
                nowTick={nowTick}
              />
            ))}
          </div>
        </section>
      )}

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

      <ConfirmationDialog
        hidden={!keyboardHelpOpen}
        title="Keyboard shortcuts"
        message={
          <ul className="m-0 grid list-none grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 p-0 text-xs">
            <li className="contents">
              <span>
                <Kbd>R</Kbd>
              </span>
              <span>Reset visible circuits (with confirmation)</span>
            </li>
            <li className="contents">
              <span>
                <Kbd>T</Kbd>
              </span>
              <span>Toggle pause / resume live updates</span>
            </li>
            <li className="contents">
              <span>
                <Kbd>Esc</Kbd>
              </span>
              <span>Clear search and filter chips</span>
            </li>
            <li className="contents">
              <span>
                <Kbd>?</Kbd>
              </span>
              <span>Show / hide this list</span>
            </li>
          </ul>
        }
        confirmText="Got it"
        cancelText="Close"
        onConfirm={() => setKeyboardHelpOpen(false)}
        onCancel={() => setKeyboardHelpOpen(false)}
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

