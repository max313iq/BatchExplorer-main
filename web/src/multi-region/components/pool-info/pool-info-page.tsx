/**
 * Pool Info page — list and inspect Batch pools across regions, drive
 * resize and start-task updates, and surface deep-link details (autoscale
 * formula, resize errors, node-state breakdown) via a side Sheet.
 *
 * Redesigned 2026-05-24:
 *   - Split conflated "State + Allocation" filter into two distinct selects.
 *   - Quick-filter chips for the most common triage views (errors, empty,
 *     non-steady, auto-scale).
 *   - VM-size filter dropdown + idempotency checks on resize / delete-empty.
 *   - Bulk-selection toolbar (Resize / Update Start Task / Reboot nodes /
 *     Delete) appears as soon as any row is selected.
 *   - Per-row hover-revealed actions (Inspect / Reboot all nodes / Delete).
 *   - Sheet has CopyButton on Pool ID + ARM resource id, deep links to the
 *     Azure Portal pool blade AND the in-app Nodes page filtered to this
 *     pool, and lists running-task counts plus a top-10 node list.
 *   - Resize dialog: quick-pick percentage buttons, idempotency guard so a
 *     no-op resize is just toasted instead of fired against the API, and a
 *     "running tasks will be terminated" warning when relevant.
 *   - Auto-refresh has a re-entrancy guard; the Refresh button is disabled
 *     while a tick is in flight.
 *   - Each successful pool action emits an `addAuditEntry` record so the
 *     Audit Log page reflects pool-info origin operations consistently.
 *   - Selection self-prunes after refresh / delete so stale ids don't ghost
 *     bulk actions.
 *   - `useArmToken` + `TokenExpiryBadge` preserved unchanged.
 */
import * as React from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  Boxes,
  ExternalLink,
  Filter as FilterIcon,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Play,
  Plus,
  Power,
  RotateCw,
  Server,
  Settings2,
  ShieldAlert,
  Square,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Donut, DonutLegend, type DonutSegment } from "@/components/ui/charts/donut";
import { Gauge } from "@/components/ui/charts/gauge";
import { Sparkline } from "@/components/ui/charts/sparkline";
import {
  cn,
  compareNumbers,
  compareStrings,
  formatNumber,
  formatRelativeTime,
} from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import { ManagedNode, NodeState, PoolInfo } from "../../store/store-types";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import {
  DataTable,
  type DataTableColumn,
} from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { RegionBadge } from "../shared/region-badge";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { StatusBadge } from "../shared/status-badge";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { showToast } from "../shared/toast-container";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { getVCpus } from "../shared/vm-sizes";

export interface PoolInfoPageProps {
  orchestrator: OrchestratorAgent;
}

export const PoolInfoPage: React.FC<PoolInfoPageProps> = (props) => (
  <ErrorBoundary>
    <PoolInfoPageInner {...props} />
  </ErrorBoundary>
);

interface EnvVar {
  name: string;
  value: string;
}

interface PoolFilters {
  q: string;
  region: string;
  state: string; // active | deleting
  allocation: string; // steady | resizing | stopping
  account: string;
  vmSize: string;
  /**
   * Quick-filter pill chip — overlays the rest of the filters:
   *   issues       — pools with resizeErrors or non-steady allocation
   *   empty        — pools with 0 current dedicated + 0 LP
   *   resizing     — pools currently in `resizing` allocation state
   *   autoscale    — pools with autoscale enabled
   *   ""           — no quick filter
   */
  quick: string;
  // Index signature so this satisfies the `UrlStateRecord` constraint.
  [key: string]: string | string[] | undefined;
}

interface NodeBreakdownBucket {
  key: string;
  label: string;
  count: number;
  className: string;
}

// ---------------------------------------------------------------------------
// LocalStorage cache for pool info — see azure-accounts-page.tsx for the
// same pattern applied to subscription lists. Pools change more frequently
// than account membership, so the staleness window is tighter (30 min):
// stale-but-recent is fine as a first-paint placeholder; older than that
// would mislead the operator about pool state badly enough that a black
// list-loading spinner is preferable.
// ---------------------------------------------------------------------------
const POOL_INFOS_CACHE_KEY = "azbm.pool-infos.cache.v1";
const POOL_INFOS_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

function readPoolInfosCache(): PoolInfo[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(POOL_INFOS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts?: number; pools?: PoolInfo[] };
    if (!parsed?.pools || !Array.isArray(parsed.pools)) return null;
    if (
      typeof parsed.ts !== "number" ||
      Date.now() - parsed.ts > POOL_INFOS_CACHE_MAX_AGE_MS
    ) {
      return null;
    }
    return parsed.pools;
  } catch {
    return null;
  }
}

function writePoolInfosCache(pools: PoolInfo[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      POOL_INFOS_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), pools }),
    );
  } catch {
    /* quota or disabled */
  }
}

const STATE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "__all", label: "All states" },
  { value: "active", label: "Active" },
  { value: "deleting", label: "Deleting" },
];

const ALLOCATION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "__all", label: "All allocations" },
  { value: "steady", label: "Steady" },
  { value: "resizing", label: "Resizing" },
  { value: "stopping", label: "Stopping" },
];

// Quick-filter chip definitions — rendered as a horizontal row above the
// main filter bar. The 'q' field uses the same `filters.quick` slot so a
// click toggles the chip on/off.
const QUICK_CHIPS: ReadonlyArray<{
  key: string;
  label: string;
  className: string;
  predicate: (p: PoolInfo) => boolean;
  tip: string;
}> = [
  {
    key: "issues",
    label: "Issues",
    className: "border-destructive/40 text-destructive",
    predicate: (p) =>
      (p.resizeErrors?.length ?? 0) > 0 || p.allocationState !== "steady",
    tip: "Pools with resize errors or non-steady allocation",
  },
  {
    key: "empty",
    label: "Empty",
    className: "border-muted-foreground/40 text-muted-foreground",
    predicate: (p) =>
      p.currentDedicatedNodes === 0 && p.currentLowPriorityNodes === 0,
    tip: "Pools with 0 current dedicated and 0 low-priority nodes",
  },
  {
    key: "resizing",
    label: "Resizing",
    className: "border-warning/40 text-warning",
    predicate: (p) => p.allocationState === "resizing",
    tip: "Pools whose allocation state is currently resizing",
  },
  {
    key: "autoscale",
    label: "Auto scale",
    className: "border-info/40 text-info",
    predicate: (p) => p.enableAutoScale,
    tip: "Pools with autoscale enabled",
  },
  // Defender-aware chip: pools whose StartTask appears to touch the
  // instance metadata service. Cite: `_analysis_netspi.md` § I.
  {
    key: "imds",
    label: "IMDS access",
    className: "border-destructive/40 text-destructive",
    predicate: (p) => detectImdsAccess(p).length > 0,
    tip: "Pools whose StartTask command line touches IMDS (169.254.169.254 / metadata/identity/oauth2/token). Surfaces identity-exfil-shaped workloads for defender review — see `_analysis_netspi.md`.",
  },
];

// Token-fresh threshold — below this, resize is blocked because mid-call
// expiry can leave the orchestrator unable to mint a fresh per-account
// token before the request lands.
const TOKEN_RESIZE_BLOCK_SECONDS = 60;

// ---------------------------------------------------------------------------
// Defender-aware heuristics (Wave 8 / Pass 2)
// ---------------------------------------------------------------------------
// Corpus reference: `_analysis_netspi.md` § I (IMDS Variants). Azure Batch
// nodes are classic VMs from an identity-attack POV — if a pool has a managed
// identity AND a start task that hits `169.254.169.254/metadata/identity/...`
// or `metadata/identity/oauth2/token`, a low-privilege task author can mint
// ARM tokens with whatever role is attached to the pool. This is *legitimate*
// in some workloads but is a strong signal worth surfacing for the operator.
// The heuristic is conservative — it only flags command lines that explicitly
// contain the IMDS host or path, never workloads that simply *could* hit IMDS.
// ---------------------------------------------------------------------------

/**
 * Patterns that suggest the StartTask is reaching the instance metadata
 * service to mint identity tokens. Each pattern is matched case-insensitively
 * against the start-task command line.
 *
 * Source: `_analysis_netspi.md` § I — classic VM IMDS is `169.254.169.254`
 * with header `Metadata: true`; the OAuth2 path is
 * `/metadata/identity/oauth2/token`. Batch nodes use the VM endpoint, not
 * the App-Service `IDENTITY_ENDPOINT` localhost variant.
 */
const IMDS_PATTERNS: ReadonlyArray<{ rx: RegExp; reason: string }> = [
  {
    rx: /169\.254\.169\.254/i,
    reason: "Hits classic IMDS IP 169.254.169.254",
  },
  {
    rx: /metadata\/identity\/oauth2\/token/i,
    reason: "Calls the IMDS OAuth2 token endpoint",
  },
  {
    rx: /Metadata:\s*true/i,
    reason: "Sets the `Metadata: true` header (IMDS access requirement)",
  },
];

interface ImdsHit {
  reason: string;
  /** Truncated snippet of the command line for the operator to inspect. */
  snippet: string;
}

/**
 * Inspect a pool's StartTask command line for IMDS-token-minting patterns.
 * Returns the list of matched reasons; an empty list means "looks clean".
 * Cite: `_analysis_netspi.md` § I.
 */
function detectImdsAccess(pool: PoolInfo): ImdsHit[] {
  const cmd = pool.startTask?.commandLine;
  if (typeof cmd !== "string" || cmd.length === 0) return [];
  const hits: ImdsHit[] = [];
  for (const { rx, reason } of IMDS_PATTERNS) {
    const m = cmd.match(rx);
    if (m && m.index !== undefined) {
      const start = Math.max(0, m.index - 24);
      const end = Math.min(cmd.length, m.index + m[0].length + 24);
      const snippet =
        (start > 0 ? "..." : "") + cmd.slice(start, end) + (end < cmd.length ? "..." : "");
      hits.push({ reason, snippet });
    }
  }
  return hits;
}

/**
 * Detect pools whose StartTask is failing across many of their nodes — these
 * are typically "stuck" pools the operator wants to triage. Returns the count
 * of nodes in the `starttaskfailed` state plus the ratio against the total
 * known nodes for the pool.
 */
function detectStuckStartTask(
  pool: PoolInfo,
  poolNodes: ReadonlyArray<ManagedNode>,
): { failed: number; total: number; ratio: number } {
  let failed = 0;
  let total = 0;
  for (const n of poolNodes) {
    total += 1;
    if (n.state === "starttaskfailed") failed += 1;
  }
  return { failed, total, ratio: total > 0 ? failed / total : 0 };
}

/**
 * Composite risk score 0–100 for a pool.
 *
 * Inputs (each clamped, then weighted):
 *   - size               : ln(current+target nodes), heavier pools = higher blast radius
 *   - elevation          : StartTask runs as admin / elevated auto-user (+15)
 *   - imdsAccess         : StartTask touches IMDS (+25) — see `_analysis_netspi.md`
 *   - stuckStartTask     : > 25% of nodes in starttaskfailed (+15)
 *   - resizeErrors       : pool has unresolved resize errors (+10)
 *   - nonSteady          : pool not in steady allocation state (+5)
 *
 * The score is intentionally a SIGNAL, not a verdict — a high score means
 * "look here first" during incident triage, not "this pool is compromised".
 */
function computePoolRiskScore(
  pool: PoolInfo,
  poolNodes: ReadonlyArray<ManagedNode>,
): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  const totalNodes =
    pool.currentDedicatedNodes +
    pool.currentLowPriorityNodes +
    pool.targetDedicatedNodes +
    pool.targetLowPriorityNodes;
  const sizeWeight = Math.min(30, Math.round(Math.log10(1 + totalNodes) * 12));
  if (sizeWeight > 0) {
    score += sizeWeight;
    if (sizeWeight >= 20) {
      reasons.push(`Large blast radius (~${totalNodes} target+current nodes)`);
    }
  }

  const startTask = pool.startTask as
    | {
        userIdentity?: {
          autoUser?: { elevationLevel?: string };
        };
      }
    | undefined;
  const elevation = startTask?.userIdentity?.autoUser?.elevationLevel;
  if (elevation === "admin") {
    score += 15;
    reasons.push("StartTask runs as admin auto-user");
  }

  const imdsHits = detectImdsAccess(pool);
  if (imdsHits.length > 0) {
    score += 25;
    reasons.push(
      `StartTask touches IMDS (${imdsHits.length} match${imdsHits.length === 1 ? "" : "es"})`,
    );
  }

  const stuck = detectStuckStartTask(pool, poolNodes);
  if (stuck.ratio > 0.25 && stuck.failed >= 2) {
    score += 15;
    reasons.push(
      `${stuck.failed}/${stuck.total} nodes in starttaskfailed (${Math.round(stuck.ratio * 100)}%)`,
    );
  }

  if ((pool.resizeErrors?.length ?? 0) > 0) {
    score += 10;
    reasons.push(`${pool.resizeErrors!.length} unresolved resize error(s)`);
  }

  if (pool.allocationState !== "steady") {
    score += 5;
    reasons.push(`Allocation is ${pool.allocationState}`);
  }

  return { score: Math.min(100, score), reasons };
}

/** Map a 0–100 score to a tone class for badge / sparkline rendering. */
function riskTone(score: number): "success" | "info" | "warning" | "destructive" {
  if (score >= 60) return "destructive";
  if (score >= 35) return "warning";
  if (score >= 15) return "info";
  return "success";
}

const PoolInfoPageInner: React.FC<PoolInfoPageProps> = ({ orchestrator }) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const navigate = useNavigate();
  const params = useParams<{ poolId?: string }>();
  const focusedPoolId = params.poolId ?? null;

  // Centralized ARM-token tracker for the inline TokenExpiryBadge.
  // Pool Info has no per-page account picker — all ARM/Batch calls are
  // fanned out through the orchestrator, which mints its own tokens
  // per-account. The badge here exists purely as a freshness cue for
  // the operator: it tracks the FIRST signed-in AAD account (the
  // implicit "primary" identity) so they get a visible warning before
  // a token they're about to use mid-resize expires. There is no local
  // armToken state on this page, so the sync-bridge effect used by
  // ea-sub-quick / sub-mover is intentionally omitted.
  const primaryAccount = state.azureAccounts?.[0];
  const armTokenTracker = useArmToken(
    primaryAccount?.homeAccountId,
    primaryAccount?.tenantId,
  );
  const tokenStale =
    armTokenTracker.secondsUntilExpiry !== null &&
    armTokenTracker.secondsUntilExpiry < TOKEN_RESIZE_BLOCK_SECONDS;

  const [loading, setLoading] = React.useState(false);
  // Persisted across reload — turn auto-refresh off here once and it
  // stays off until the operator flips it back on. Default off because
  // 30 s polling against many accounts is bandwidth-heavy and most
  // operators only enable it for active investigation.
  const [autoRefresh, setAutoRefresh] = usePersistedState<boolean>(
    "azbm.pool-info.auto-refresh.v1",
    false,
  );
  const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // Re-entrancy guard for auto-refresh: setInterval keeps firing every 30s
  // even if the previous refresh is still in flight, which on slow networks
  // could pile up redundant orchestrator calls and skew token refresh
  // timing. This ref short-circuits a tick when a previous tick is still
  // running.
  const refreshInFlightRef = React.useRef(false);

  // URL-synced filters per Contract §4.3. Note: `state` and `allocation`
  // were previously conflated in a single URL key; existing bookmarks with
  // the legacy combined `?state=resizing` keep working because we read
  // both keys on init and the predicate only matches present values.
  const [filters, setFilters] = useUrlState<PoolFilters>({
    q: "",
    region: "",
    state: "",
    allocation: "",
    account: "",
    vmSize: "",
    quick: "",
  });

  // Selection (multi-row) keyed by `pool.id`.
  const [selection, setSelection] = React.useState<Set<string>>(new Set());

  // Resize dialog state.
  const [showResizeDialog, setShowResizeDialog] = React.useState(false);
  const [showResizeConfirm, setShowResizeConfirm] = React.useState(false);
  const [resizeDedicated, setResizeDedicated] = React.useState(0);
  const [resizeLowPriority, setResizeLowPriority] = React.useState(0);
  const [resizeSubmitting, setResizeSubmitting] = React.useState(false);

  // Start-task dialog state.
  const [showStartTaskDialog, setShowStartTaskDialog] = React.useState(false);
  const [startTaskCommandLine, setStartTaskCommandLine] = React.useState("");
  const [startTaskEnvVars, setStartTaskEnvVars] = React.useState<EnvVar[]>([]);
  const [startTaskMaxRetryCount, setStartTaskMaxRetryCount] = React.useState(3);
  const [startTaskWaitForSuccess, setStartTaskWaitForSuccess] =
    React.useState(true);
  const [startTaskUserScope, setStartTaskUserScope] = React.useState<
    "pool" | "task"
  >("pool");
  const [startTaskElevation, setStartTaskElevation] = React.useState<
    "admin" | "nonadmin"
  >("admin");
  const [startTaskResourceFiles, setStartTaskResourceFiles] = React.useState<
    Array<{ httpUrl: string; filePath: string }>
  >([]);
  const [startTaskRebootAfter, setStartTaskRebootAfter] = React.useState(false);
  const [startTaskError, setStartTaskError] = React.useState<string | null>(
    null,
  );
  const [startTaskSubmitting, setStartTaskSubmitting] = React.useState(false);

  // Remove empty pools dialog state.
  const [showDeleteEmptyDialog, setShowDeleteEmptyDialog] =
    React.useState(false);
  const [deleteEmptySubmitting, setDeleteEmptySubmitting] =
    React.useState(false);

  // Bulk-delete dialog state (selected non-empty pools).
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] =
    React.useState(false);
  const [bulkDeleteSubmitting, setBulkDeleteSubmitting] = React.useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState("");

  // Bulk-reboot dialog state.
  const [showRebootDialog, setShowRebootDialog] = React.useState(false);
  const [rebootSubmitting, setRebootSubmitting] = React.useState(false);

  // Page-level fetch error.
  const [error, setError] = React.useState<Error | null>(null);

  const recordAudit = React.useCallback(
    (entry: {
      action: string;
      target: string;
      status: "success" | "failure";
      details?: Record<string, unknown>;
      error?: string;
    }) => {
      try {
        store.addAuditEntry({
          id: `pool-info-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          actor: primaryAccount?.username ?? primaryAccount?.name ?? "unknown",
          action: entry.action,
          target: entry.target,
          status: entry.status,
          details: entry.details,
          error: entry.error,
        });
      } catch {
        /* audit is best-effort — never fail the user's action */
      }
    },
    [store, primaryAccount?.username, primaryAccount?.name],
  );

  // COORDINATOR: extract RefreshWithAbort hook — duplicated with
  // account-info, overview. Each page repeats the same trio: an
  // in-flight ref, a loading flag, and a try/catch/finally that has to
  // remember to clear both. Centralizing would let the badge + Stop
  // button be hook-driven instead of per-page useState.
  const refresh = React.useCallback(
    async (signal?: AbortSignal) => {
      // Re-entrancy guard — bail if a refresh is already running. Without
      // this, the 30s autorefresh stacks redundant calls on slow links.
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        await orchestrator.execute({
          action: "refresh_pool_info",
          payload: {},
          signal,
        });
      } catch (err) {
        if (signal?.aborted) return;
        setError(
          err instanceof Error ? err : new Error("Unknown error occurred"),
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
        refreshInFlightRef.current = false;
      }
    },
    [orchestrator],
  );

  const stop = React.useCallback(() => {
    // Cooperatively cancel any in-flight orchestrator work (refresh
    // fan-out across accounts). Without this, flipping the UI off while
    // a long-running refresh is mid-flight left the toast in a stale
    // "succeeded" state when it eventually resolved.
    try {
      orchestrator.cancel();
    } catch {
      /* orchestrator might not support cancel in some builds — fall through */
    }
    setLoading(false);
    setAutoRefresh(false);
    refreshInFlightRef.current = false;
  }, [orchestrator, setAutoRefresh]);

  // Auto-refresh (30s) — cleanup mirrors §1.7.
  React.useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      void refresh();
    }, 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, refresh]);

  // Hydrate from localStorage on first mount so the operator sees the
  // previous pool list immediately on page reload, then refresh in the
  // background. Without this, the page wipes state.poolInfos every reload
  // and waits N×token-fetch+listPools round-trips before showing anything,
  // which scales linearly with the number of Batch accounts.
  useAbortableEffect((signal) => {
    if (state.poolInfos.length === 0) {
      const cached = readPoolInfosCache();
      if (cached && cached.length > 0) {
        store.setPoolInfos(cached);
      }
    }
    if (state.accounts.length > 0) {
      // Always trigger a refresh — cached data is just a fast first paint;
      // the orchestrator's response overrides with fresh data when it lands.
      // The signal is propagated into the orchestrator so a fast unmount
      // (operator hits Back during the first refresh) aborts in-flight ARM
      // round-trips instead of letting them complete after the page is gone.
      void refresh(signal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the latest pool list whenever it changes so the next reload
  // can hydrate from it. Skip writes when the list is empty AND we're
  // still loading (avoids clobbering a real cache with a transient empty
  // state during the first refresh). Debounced 1s so a refresh that
  // updates poolInfos in multiple ticks doesn't fire a localStorage
  // write per tick — synchronous storage writes lag the main thread when
  // the JSON payload is large (hundreds of pools across many accounts).
  React.useEffect(() => {
    if (state.poolInfos.length === 0 && loading) return;
    const handle = setTimeout(() => {
      writePoolInfosCache(state.poolInfos);
    }, 1000);
    return () => clearTimeout(handle);
  }, [state.poolInfos, loading]);

  const pools = state.poolInfos;

  // Memoized live-id set — used both by the prune effect below and by
  // any downstream consumer that needs a stable Set identity for
  // membership tests. Without the memo, the prune effect rebuilt the Set
  // on every render even when `pools` was reference-equal, and any
  // child reading the set would see a fresh identity each pass.
  const livePoolIds = React.useMemo(
    () => new Set(pools.map((p) => p.id)),
    [pools],
  );

  // Prune selection when underlying pools change (after refresh / delete).
  // Without this, selecting a pool that then gets deleted/renamed by
  // discovery leaves a phantom id in `selection` that subtly drives the
  // bulk-action enabled state without showing the user what's selected.
  React.useEffect(() => {
    setSelection((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (livePoolIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [livePoolIds]);

  // Unique values for filter dropdowns.
  const uniqueRegions = React.useMemo(
    () => [...new Set(pools.map((p) => p.region))].sort(),
    [pools],
  );
  const uniqueAccounts = React.useMemo(
    () => [...new Set(pools.map((p) => p.accountName))].sort(),
    [pools],
  );
  const uniqueVmSizes = React.useMemo(
    () => [...new Set(pools.map((p) => p.vmSize))].sort(),
    [pools],
  );

  // Apply URL-synced filters + quick chip.
  const filteredPools = React.useMemo(() => {
    let result = pools;
    const q = filters.q.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (p) =>
          (p.poolId ?? "").toLowerCase().includes(q) ||
          (p.accountName ?? "").toLowerCase().includes(q) ||
          (p.region ?? "").toLowerCase().includes(q) ||
          (p.vmSize ?? "").toLowerCase().includes(q) ||
          (p.state ?? "").toLowerCase().includes(q) ||
          (p.allocationState ?? "").toLowerCase().includes(q),
      );
    }
    if (filters.region) {
      result = result.filter((p) => p.region === filters.region);
    }
    if (filters.state) {
      result = result.filter((p) => p.state === filters.state);
    }
    if (filters.allocation) {
      result = result.filter((p) => p.allocationState === filters.allocation);
    }
    if (filters.account) {
      result = result.filter((p) => p.accountName === filters.account);
    }
    if (filters.vmSize) {
      result = result.filter((p) => p.vmSize === filters.vmSize);
    }
    if (filters.quick) {
      const chip = QUICK_CHIPS.find((c) => c.key === filters.quick);
      if (chip) result = result.filter(chip.predicate);
    }
    return result;
  }, [pools, filters]);

  const selectedPools = React.useMemo(
    () => pools.filter((p) => selection.has(p.id)),
    [pools, selection],
  );

  const emptyPools = React.useMemo(
    () =>
      pools.filter(
        (p) =>
          p.currentDedicatedNodes === 0 && p.currentLowPriorityNodes === 0,
      ),
    [pools],
  );

  // Per-pool running task aggregate (used for the "running tasks will be
  // terminated" warning in the Resize dialog, and the node-count column).
  const runningTasksByPoolKey = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const n of state.nodes) {
      const k = `${n.accountId}:${n.poolId}`;
      m.set(k, (m.get(k) ?? 0) + (n.runningTasksCount ?? 0));
    }
    return m;
  }, [state.nodes]);

  const nodesByPoolKey = React.useMemo(() => {
    const m = new Map<string, ManagedNode[]>();
    for (const n of state.nodes) {
      const k = `${n.accountId}:${n.poolId}`;
      const arr = m.get(k);
      if (arr) arr.push(n);
      else m.set(k, [n]);
    }
    return m;
  }, [state.nodes]);

  // ---------------------------------------------------------------------
  // Per-pool node-count rolling history (session-scoped sparkline data).
  //
  // The store's `history` array is fleet-wide, not per-pool. To power the
  // sparkline in the details Sheet without coordinator changes to the
  // store, we accumulate samples in a ref keyed by `pool.id`. The ref
  // stays alive across renders but is discarded on page unmount — exactly
  // the right scope for "what has this pool been doing this session".
  //
  // We cap each pool's series at 60 samples (~30 min at the 30s auto-
  // refresh interval). Sampling is driven by *any* re-render where the
  // pool list changes — that includes manual refresh, autorefresh ticks,
  // and store mutations from other pages — so the sparkline tracks
  // genuine value changes, not wall-clock ticks.
  // ---------------------------------------------------------------------
  const poolHistoryRef = React.useRef<Map<string, number[]>>(new Map());
  React.useEffect(() => {
    const SERIES_CAP = 60;
    const history = poolHistoryRef.current;
    const seen = new Set<string>();
    for (const p of pools) {
      seen.add(p.id);
      const total = p.currentDedicatedNodes + p.currentLowPriorityNodes;
      const series = history.get(p.id) ?? [];
      const last = series[series.length - 1];
      // Only push a sample when the value changes — keeps the series
      // information-dense even when refreshes are no-ops.
      if (last !== total) {
        series.push(total);
        if (series.length > SERIES_CAP) series.shift();
        history.set(p.id, series);
      }
    }
    // GC pools that disappeared so the ref doesn't grow without bound
    // across hours of "delete pool → discover new pool" churn.
    for (const id of history.keys()) {
      if (!seen.has(id)) history.delete(id);
    }
  }, [pools]);

  // Quick-chip counts (computed once, used in the chip labels for context).
  const chipCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of QUICK_CHIPS) {
      let n = 0;
      for (const p of pools) if (c.predicate(p)) n += 1;
      counts.set(c.key, n);
    }
    return counts;
  }, [pools]);

  // Per-pool risk index — keyed by pool.id, computed once per (pools, nodes)
  // change so the table cell and Defender notes section don't each redo the
  // walk over the start-task command line + node list.
  // Corpus ref: `_analysis_netspi.md` § I.
  const poolRiskById = React.useMemo(() => {
    const m = new Map<string, { score: number; reasons: string[] }>();
    for (const p of pools) {
      const nodes = nodesByPoolKey.get(`${p.accountId}:${p.poolId}`) ?? [];
      m.set(p.id, computePoolRiskScore(p, nodes));
    }
    return m;
  }, [pools, nodesByPoolKey]);

  // Per-pool IMDS-hit index (start-task command-line patterns).
  const imdsHitsById = React.useMemo(() => {
    const m = new Map<string, ImdsHit[]>();
    for (const p of pools) {
      const hits = detectImdsAccess(p);
      if (hits.length > 0) m.set(p.id, hits);
    }
    return m;
  }, [pools]);

  // Per-pool stuck-StartTask index — count + ratio. Skipped when a pool's
  // node list is empty (no signal vs no data).
  const stuckStartTaskById = React.useMemo(() => {
    const m = new Map<string, { failed: number; total: number; ratio: number }>();
    for (const p of pools) {
      const nodes = nodesByPoolKey.get(`${p.accountId}:${p.poolId}`) ?? [];
      const s = detectStuckStartTask(p, nodes);
      if (s.total > 0) m.set(p.id, s);
    }
    return m;
  }, [pools, nodesByPoolKey]);

  // Summary stats.
  const totalPools = pools.length;
  const activePools = pools.filter((p) => p.state === "active").length;
  const totalDedicated = pools.reduce(
    (s, p) => s + p.currentDedicatedNodes,
    0,
  );
  const totalLowPri = pools.reduce(
    (s, p) => s + p.currentLowPriorityNodes,
    0,
  );
  const resizingPools = pools.filter(
    (p) => p.allocationState === "resizing",
  ).length;
  const errorPools = pools.filter(
    (p) => (p.resizeErrors?.length ?? 0) > 0,
  ).length;

  // Tenant fan-out — how many distinct tenants the loaded pools span
  // (via their owning accounts). Useful as a multi-tenant signal next to
  // the ARM token badge.
  const tenantCount = React.useMemo(() => {
    const t = new Set<string>();
    for (const p of pools) {
      const acct = state.accounts.find((a) => a.id === p.accountId);
      const tid =
        acct && "tenantId" in acct
          ? (acct as { tenantId?: string }).tenantId
          : undefined;
      if (tid) t.add(tid);
    }
    return t.size;
  }, [pools, state.accounts]);

  // Fleet health derivations — feed the new "Pool Fleet Health" card. Walks
  // the relevant nodes once for the donut, and the pool list once for the
  // allocation-efficiency gauge.
  const fleetHealth = React.useMemo(() => {
    const poolKeys = new Set(
      pools.map((p) => `${p.accountId}:${p.poolId}`),
    );
    let running = 0;
    let idle = 0;
    let transitioning = 0;
    let preempted = 0;
    let errors = 0;
    for (const n of state.nodes) {
      if (!poolKeys.has(`${n.accountId}:${n.poolId}`)) continue;
      switch (n.state) {
        case "running":
          running += 1;
          break;
        case "idle":
          idle += 1;
          break;
        case "creating":
        case "starting":
        case "rebooting":
        case "reimaging":
        case "leavingpool":
        case "waitingforstarttask":
          transitioning += 1;
          break;
        case "preempted":
          preempted += 1;
          break;
        case "unusable":
        case "starttaskfailed":
        case "offline":
        case "unknown":
          errors += 1;
          break;
      }
    }
    const stateSegments: DonutSegment[] = [
      { label: "Running", value: running, tone: "success" },
      { label: "Idle", value: idle, tone: "info" },
      { label: "Transitioning", value: transitioning, tone: "warning" },
      { label: "Preempted", value: preempted, tone: "muted" },
      { label: "Errors", value: errors, tone: "destructive" },
    ];
    const totalNodesInFleet = running + idle + transitioning + preempted + errors;

    // Allocation efficiency = sum(current) / sum(target). Capped at 100% so
    // briefly-overshooting resizes don't push the gauge red.
    let currentTotal = 0;
    let targetTotal = 0;
    for (const p of pools) {
      currentTotal += p.currentDedicatedNodes + p.currentLowPriorityNodes;
      targetTotal += p.targetDedicatedNodes + p.targetLowPriorityNodes;
    }
    const overshoot = currentTotal > targetTotal && targetTotal > 0;
    return {
      stateSegments,
      totalNodesInFleet,
      currentTotal,
      targetTotal,
      overshoot,
    };
  }, [pools, state.nodes]);

  // Selected pool (first selected for single-pool actions).
  const selectedPool = selectedPools.length > 0 ? selectedPools[0] : null;

  // Deep-link target — looked up by `poolId` route param.
  const focusedPool = React.useMemo<PoolInfo | null>(() => {
    if (!focusedPoolId) return null;
    return (
      pools.find((p) => p.poolId === focusedPoolId || p.id === focusedPoolId) ??
      null
    );
  }, [pools, focusedPoolId]);

  // Quota helpers — derive max LP nodes from the owning account's free LP
  // cores divided by the VM family's vCPU count.
  const getAccountInfoForPool = React.useCallback(
    (pool: PoolInfo | null) => {
      if (!pool) return null;
      return state.accountInfos.find((a) => a.id === pool.accountId) ?? null;
    },
    [state.accountInfos],
  );

  const getAccountForPool = React.useCallback(
    (pool: PoolInfo | null) => {
      if (!pool) return null;
      return state.accounts.find((a) => a.id === pool.accountId) ?? null;
    },
    [state.accounts],
  );

  const selectedAccountInfo = getAccountInfoForPool(selectedPool);

  // Resize is blocked unless ALL selected pools are in "steady" allocation.
  const nonSteadySelected = React.useMemo(
    () => selectedPools.filter((p) => p.allocationState !== "steady"),
    [selectedPools],
  );
  const resizeBlocked = nonSteadySelected.length > 0 || tokenStale;

  const getMaxLpNodes = React.useCallback((): number => {
    if (!selectedPool) return 0;
    const acctInfo = getAccountInfoForPool(selectedPool);
    const freeLpCores = acctInfo?.lowPriorityCoresFree ?? 0;
    const vmVCpus = getVCpus(selectedPool.vmSize);
    return Math.floor(freeLpCores / vmVCpus);
  }, [selectedPool, getAccountInfoForPool]);

  // Running tasks across the selected pools (used to warn about resize
  // destroying in-flight work).
  const selectedRunningTasks = React.useMemo(() => {
    let n = 0;
    for (const p of selectedPools) {
      n += runningTasksByPoolKey.get(`${p.accountId}:${p.poolId}`) ?? 0;
    }
    return n;
  }, [selectedPools, runningTasksByPoolKey]);

  // -----------------------------------------------------------------------
  // Resize dialog handlers
  // -----------------------------------------------------------------------
  const openResizeDialog = React.useCallback(() => {
    if (!selectedPool) return;
    const acctInfo = getAccountInfoForPool(selectedPool);
    const freeLpCores = acctInfo?.lowPriorityCoresFree ?? 0;
    const vmVCpus = getVCpus(selectedPool.vmSize);
    const maxLpNodes = Math.floor(freeLpCores / vmVCpus);
    setResizeDedicated(0);
    setResizeLowPriority(maxLpNodes);
    setShowResizeDialog(true);
  }, [selectedPool, getAccountInfoForPool]);

  // Idempotency check — true when EVERY selected pool already has the
  // requested LP target (we always force dedicated to 0). Used to skip the
  // API call entirely instead of submitting a no-op PATCH.
  const resizeIsNoOp = React.useMemo(() => {
    if (selectedPools.length === 0) return false;
    return selectedPools.every(
      (p) =>
        p.targetDedicatedNodes === 0 &&
        p.targetLowPriorityNodes === resizeLowPriority,
    );
  }, [selectedPools, resizeLowPriority]);

  const submitResize = React.useCallback(async () => {
    if (selectedPools.length === 0) return;
    if (selectedPools.some((p) => p.allocationState !== "steady")) {
      showToast(store, "Resize requires steady allocation state", "warning");
      return;
    }
    // Idempotency guard — skip a noop call rather than spawn N PATCHes
    // that would just round-trip the same values. Audited as "noop".
    if (resizeIsNoOp) {
      showToast(
        store,
        `No change: ${selectedPools.length} pool${selectedPools.length === 1 ? "" : "s"} already at target ${resizeLowPriority} LP`,
        "info",
      );
      recordAudit({
        action: "pool.resize.noop",
        target: selectedPools.map((p) => p.poolId).join(", "),
        status: "success",
        details: {
          targetLowPriorityNodes: resizeLowPriority,
          poolCount: selectedPools.length,
        },
      });
      setShowResizeConfirm(false);
      setShowResizeDialog(false);
      return;
    }
    setResizeSubmitting(true);
    try {
      const results = await Promise.allSettled(
        selectedPools.map((pool) =>
          orchestrator.execute({
            action: "resize_pool",
            payload: {
              accountId: pool.accountId,
              poolId: pool.poolId,
              targetDedicatedNodes: resizeDedicated,
              targetLowPriorityNodes: resizeLowPriority,
            },
          }),
        ),
      );
      // The orchestrator can either reject the promise OR resolve with a
      // failed AgentResult (status: "failed"). Counting only `rejected`
      // missed the second case and surfaced a misleading "all succeeded"
      // toast for half-failed resize batches.
      const failed = results.filter(
        (r) =>
          r.status === "rejected" ||
          (r.status === "fulfilled" && r.value?.status === "failed"),
      ).length;
      const ok = results.length - failed;
      results.forEach((r, i) => {
        const pool = selectedPools[i];
        const success =
          r.status === "fulfilled" && r.value?.status !== "failed";
        recordAudit({
          action: "pool.resize",
          target: `${pool.accountName}/${pool.poolId}`,
          status: success ? "success" : "failure",
          details: {
            region: pool.region,
            vmSize: pool.vmSize,
            previousTarget: {
              dedicated: pool.targetDedicatedNodes,
              lowPriority: pool.targetLowPriorityNodes,
            },
            newTarget: {
              dedicated: resizeDedicated,
              lowPriority: resizeLowPriority,
            },
          },
          error:
            r.status === "rejected"
              ? r.reason instanceof Error
                ? r.reason.message
                : String(r.reason)
              : undefined,
        });
      });
      if (failed === 0) {
        showToast(
          store,
          `Resize submitted for ${ok} pool${ok === 1 ? "" : "s"}`,
          "success",
        );
      } else {
        showToast(
          store,
          `Resize submitted ${ok}/${results.length} (${failed} failed)`,
          "warning",
        );
      }
      setShowResizeConfirm(false);
      setShowResizeDialog(false);
    } catch (err) {
      showToast(
        store,
        `Resize failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setResizeSubmitting(false);
    }
  }, [
    selectedPools,
    orchestrator,
    resizeDedicated,
    resizeLowPriority,
    resizeIsNoOp,
    store,
    recordAudit,
  ]);

  // -----------------------------------------------------------------------
  // Start task dialog handlers
  // -----------------------------------------------------------------------
  const openStartTaskDialog = React.useCallback(() => {
    if (!selectedPool) return;
    const existing = selectedPool.startTask || {};
    setStartTaskCommandLine((existing.commandLine as string) ?? "");
    const envSettings =
      (existing.environmentSettings as Array<{
        name: string;
        value: string;
      }>) ?? [];
    setStartTaskEnvVars(
      envSettings.length > 0
        ? envSettings.map((e) => ({ name: e.name, value: e.value }))
        : [{ name: "", value: "" }],
    );
    setStartTaskMaxRetryCount((existing.maxTaskRetryCount as number) ?? 3);
    setStartTaskWaitForSuccess((existing.waitForSuccess as boolean) ?? true);
    const userIdentity = existing.userIdentity as
      | { autoUser?: { scope?: string; elevationLevel?: string } }
      | undefined;
    setStartTaskUserScope(
      (userIdentity?.autoUser?.scope as "pool" | "task") ?? "pool",
    );
    setStartTaskElevation(
      (userIdentity?.autoUser?.elevationLevel as "admin" | "nonadmin") ??
        "admin",
    );
    const resFiles =
      (existing.resourceFiles as Array<{
        httpUrl?: string;
        filePath?: string;
      }>) ?? [];
    setStartTaskResourceFiles(
      resFiles.length > 0
        ? resFiles.map((rf) => ({
            httpUrl: rf.httpUrl ?? "",
            filePath: rf.filePath ?? "",
          }))
        : [],
    );
    setStartTaskRebootAfter(false);
    setStartTaskError(null);
    setShowStartTaskDialog(true);
  }, [selectedPool]);

  const addEnvVar = () => {
    setStartTaskEnvVars((prev) => [...prev, { name: "", value: "" }]);
  };
  const removeEnvVar = (index: number) => {
    setStartTaskEnvVars((prev) => prev.filter((_, i) => i !== index));
  };
  const updateEnvVar = (
    index: number,
    field: "name" | "value",
    val: string,
  ) => {
    setStartTaskEnvVars((prev) =>
      prev.map((ev, i) => (i === index ? { ...ev, [field]: val } : ev)),
    );
  };

  const addResourceFile = () => {
    setStartTaskResourceFiles((prev) => [
      ...prev,
      { httpUrl: "", filePath: "" },
    ]);
  };
  const removeResourceFile = (index: number) => {
    setStartTaskResourceFiles((prev) => prev.filter((_, i) => i !== index));
  };
  const updateResourceFile = (
    index: number,
    field: "httpUrl" | "filePath",
    val: string,
  ) => {
    setStartTaskResourceFiles((prev) =>
      prev.map((rf, i) => (i === index ? { ...rf, [field]: val } : rf)),
    );
  };

  const submitStartTask = React.useCallback(async () => {
    if (selectedPools.length === 0) return;
    if (!startTaskCommandLine.trim()) {
      setStartTaskError("Command line is required");
      return;
    }
    const envSettings = startTaskEnvVars
      .filter((ev) => ev.name.trim() !== "")
      .map((ev) => ({ name: ev.name, value: ev.value }));
    const resFiles = startTaskResourceFiles
      .filter((rf) => rf.httpUrl.trim() !== "")
      .map((rf) => ({
        httpUrl: rf.httpUrl,
        filePath: rf.filePath || undefined,
      }));
    const startTaskPayload: Record<string, unknown> = {
      commandLine: startTaskCommandLine,
      maxTaskRetryCount: startTaskMaxRetryCount,
      waitForSuccess: startTaskWaitForSuccess,
      userIdentity: {
        autoUser: {
          scope: startTaskUserScope,
          elevationLevel: startTaskElevation,
        },
      },
    };
    if (envSettings.length > 0)
      startTaskPayload.environmentSettings = envSettings;
    if (resFiles.length > 0) startTaskPayload.resourceFiles = resFiles;

    setStartTaskError(null);
    setStartTaskSubmitting(true);
    try {
      const updateResults = await Promise.allSettled(
        selectedPools.map((pool) =>
          orchestrator
            .execute({
              action: "update_start_task",
              payload: {
                accountId: pool.accountId,
                poolId: pool.poolId,
                startTask: startTaskPayload,
              },
            })
            .then(() => ({ poolId: pool.poolId, ok: true as const }))
            .catch((err) => ({
              poolId: pool.poolId,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
            })),
        ),
      );
      const updated = updateResults.filter(
        (r) => r.status === "fulfilled" && r.value.ok,
      );
      const failedUpdates = updateResults
        .filter(
          (
            r,
          ): r is PromiseFulfilledResult<{
            poolId: string;
            ok: false;
            error: string;
          }> => r.status === "fulfilled" && !r.value.ok,
        )
        .map((r) => r.value);

      // Audit every per-pool start-task update outcome.
      updateResults.forEach((r, i) => {
        const pool = selectedPools[i];
        const success = r.status === "fulfilled" && r.value.ok;
        recordAudit({
          action: "pool.startTask.update",
          target: `${pool.accountName}/${pool.poolId}`,
          status: success ? "success" : "failure",
          details: {
            region: pool.region,
            vmSize: pool.vmSize,
            commandLine: startTaskCommandLine,
            envVarCount: envSettings.length,
            resourceFileCount: resFiles.length,
            scope: startTaskUserScope,
            elevation: startTaskElevation,
            rebootAfter: startTaskRebootAfter,
          },
          error:
            r.status === "fulfilled" && !r.value.ok
              ? r.value.error
              : r.status === "rejected"
                ? r.reason instanceof Error
                  ? r.reason.message
                  : String(r.reason)
                : undefined,
        });
      });

      let rebootSummary = "";
      if (startTaskRebootAfter && updated.length > 0) {
        const poolsToReboot = updated
          .filter(
            (
              r,
            ): r is PromiseFulfilledResult<{
              poolId: string;
              ok: true;
            }> => r.status === "fulfilled" && r.value.ok,
          )
          .map((r) => r.value.poolId);
        const rebootResults = await Promise.allSettled(
          selectedPools
            .filter((p) => poolsToReboot.includes(p.poolId))
            .map((pool) =>
              orchestrator
                .execute({
                  action: "reboot_pool_nodes",
                  payload: {
                    accountId: pool.accountId,
                    poolId: pool.poolId,
                  },
                })
                .then(() => ({ poolId: pool.poolId, ok: true as const }))
                .catch((err) => ({
                  poolId: pool.poolId,
                  ok: false as const,
                  error: err instanceof Error ? err.message : String(err),
                })),
            ),
        );
        const rebooted = rebootResults.filter(
          (r) => r.status === "fulfilled" && r.value.ok,
        ).length;
        const rebootFailed = rebootResults.length - rebooted;
        rebootSummary = ` | Rebooted: ${rebooted}/${rebootResults.length}`;
        if (rebootFailed > 0) {
          rebootSummary += ` (${rebootFailed} failed)`;
        }
      }

      if (failedUpdates.length === 0) {
        showToast(
          store,
          `Start task updated on ${updated.length} pool${updated.length === 1 ? "" : "s"}${rebootSummary}`,
          "success",
        );
        setShowStartTaskDialog(false);
      } else {
        const failedList = failedUpdates
          .slice(0, 5)
          .map((f) => `${f.poolId}: ${f.error}`)
          .join("\n");
        const extra =
          failedUpdates.length > 5
            ? `\n...and ${failedUpdates.length - 5} more`
            : "";
        setStartTaskError(
          `Updated ${updated.length}/${selectedPools.length} pools${rebootSummary}.\n\nFailed:\n${failedList}${extra}`,
        );
      }
    } catch (err) {
      setStartTaskError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartTaskSubmitting(false);
    }
  }, [
    selectedPools,
    orchestrator,
    startTaskCommandLine,
    startTaskEnvVars,
    startTaskMaxRetryCount,
    startTaskWaitForSuccess,
    startTaskUserScope,
    startTaskElevation,
    startTaskResourceFiles,
    startTaskRebootAfter,
    store,
    recordAudit,
  ]);

  // Idempotent delete-empty: re-evaluate the empty list at submit time so
  // a pool that picked up nodes between dialog-open and confirm isn't
  // wiped out by accident, AND so a pool already in `deleting` state isn't
  // re-queued (would 409 on the API).
  const submitDeleteEmptyPools = React.useCallback(async () => {
    setDeleteEmptySubmitting(true);
    try {
      const currentEmpty = pools.filter(
        (p) =>
          p.currentDedicatedNodes === 0 &&
          p.currentLowPriorityNodes === 0 &&
          p.state !== "deleting",
      );
      if (currentEmpty.length === 0) {
        showToast(
          store,
          "No empty pools remaining — list refreshed mid-delete",
          "info",
        );
        setShowDeleteEmptyDialog(false);
        return;
      }
      const results = await Promise.allSettled(
        currentEmpty.map((pool) =>
          orchestrator.execute({
            action: "delete_pool",
            payload: { accountId: pool.accountId, poolId: pool.poolId },
          }),
        ),
      );
      // Treat a fulfilled-but-failed AgentResult as a failure too, otherwise
      // the toast would lie about how many pools actually got removed.
      const failed = results.filter(
        (r) =>
          r.status === "rejected" ||
          (r.status === "fulfilled" && r.value?.status === "failed"),
      ).length;
      const ok = results.length - failed;
      results.forEach((r, i) => {
        const pool = currentEmpty[i];
        const success =
          r.status === "fulfilled" && r.value?.status !== "failed";
        recordAudit({
          action: "pool.delete.empty",
          target: `${pool.accountName}/${pool.poolId}`,
          status: success ? "success" : "failure",
          details: { region: pool.region, vmSize: pool.vmSize },
          error:
            r.status === "rejected"
              ? r.reason instanceof Error
                ? r.reason.message
                : String(r.reason)
              : undefined,
        });
      });
      if (failed === 0) {
        showToast(store, `Removed ${ok} empty pools`, "success");
      } else {
        showToast(
          store,
          `Removed ${ok}/${results.length} empty pools (${failed} failed)`,
          "warning",
        );
      }
      setShowDeleteEmptyDialog(false);
    } catch (err) {
      showToast(
        store,
        `Failed to remove empty pools: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setDeleteEmptySubmitting(false);
    }
  }, [pools, orchestrator, store, recordAudit]);

  // Bulk delete arbitrary selected pools (idempotent: skip `deleting`).
  const submitBulkDelete = React.useCallback(async () => {
    if (selectedPools.length === 0) return;
    setBulkDeleteSubmitting(true);
    try {
      const eligible = selectedPools.filter((p) => p.state !== "deleting");
      const results = await Promise.allSettled(
        eligible.map((pool) =>
          orchestrator.execute({
            action: "delete_pool",
            payload: { accountId: pool.accountId, poolId: pool.poolId },
          }),
        ),
      );
      const failed = results.filter(
        (r) =>
          r.status === "rejected" ||
          (r.status === "fulfilled" && r.value?.status === "failed"),
      ).length;
      const ok = results.length - failed;
      results.forEach((r, i) => {
        const pool = eligible[i];
        const success =
          r.status === "fulfilled" && r.value?.status !== "failed";
        recordAudit({
          action: "pool.delete.bulk",
          target: `${pool.accountName}/${pool.poolId}`,
          status: success ? "success" : "failure",
          details: {
            region: pool.region,
            vmSize: pool.vmSize,
            currentDedicated: pool.currentDedicatedNodes,
            currentLowPriority: pool.currentLowPriorityNodes,
          },
          error:
            r.status === "rejected"
              ? r.reason instanceof Error
                ? r.reason.message
                : String(r.reason)
              : undefined,
        });
      });
      if (failed === 0) {
        showToast(
          store,
          `Deleted ${ok} pool${ok === 1 ? "" : "s"}`,
          "success",
        );
      } else {
        showToast(
          store,
          `Deleted ${ok}/${results.length} pools (${failed} failed)`,
          "warning",
        );
      }
      setShowBulkDeleteDialog(false);
      setBulkDeleteConfirm("");
      setSelection(new Set());
    } catch (err) {
      showToast(
        store,
        `Bulk delete failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBulkDeleteSubmitting(false);
    }
  }, [selectedPools, orchestrator, store, recordAudit]);

  // Standalone bulk reboot — applies to selected pools.
  const submitBulkReboot = React.useCallback(async () => {
    if (selectedPools.length === 0) return;
    setRebootSubmitting(true);
    try {
      const results = await Promise.allSettled(
        selectedPools.map((pool) =>
          orchestrator.execute({
            action: "reboot_pool_nodes",
            payload: { accountId: pool.accountId, poolId: pool.poolId },
          }),
        ),
      );
      const failed = results.filter(
        (r) =>
          r.status === "rejected" ||
          (r.status === "fulfilled" && r.value?.status === "failed"),
      ).length;
      const ok = results.length - failed;
      results.forEach((r, i) => {
        const pool = selectedPools[i];
        const success =
          r.status === "fulfilled" && r.value?.status !== "failed";
        recordAudit({
          action: "pool.reboot",
          target: `${pool.accountName}/${pool.poolId}`,
          status: success ? "success" : "failure",
          details: {
            region: pool.region,
            currentDedicated: pool.currentDedicatedNodes,
            currentLowPriority: pool.currentLowPriorityNodes,
          },
          error:
            r.status === "rejected"
              ? r.reason instanceof Error
                ? r.reason.message
                : String(r.reason)
              : undefined,
        });
      });
      if (failed === 0) {
        showToast(
          store,
          `Reboot requested on ${ok} pool${ok === 1 ? "" : "s"}`,
          "success",
        );
      } else {
        showToast(
          store,
          `Reboot requested ${ok}/${results.length} (${failed} failed)`,
          "warning",
        );
      }
      setShowRebootDialog(false);
    } catch (err) {
      showToast(
        store,
        `Reboot failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setRebootSubmitting(false);
    }
  }, [selectedPools, orchestrator, store, recordAudit]);

  // Bulk reimage — reimage every node in the selected pools via the
  // orchestrator's bulk_node_action. Unlike reboot (which only restarts the
  // OS), reimage rebuilds the node from the pool's image — useful when the
  // StartTask environment has been corrupted but the pool config is fine.
  // We feed in the explicit node-id list rather than letting bulk_node_action
  // default to "all store nodes", which would clobber unselected pools.
  const submitBulkReimage = React.useCallback(async () => {
    if (selectedPools.length === 0) return;
    const selectedKeys = new Set(
      selectedPools.map((p) => `${p.accountId}:${p.poolId}`),
    );
    const targetNodes = state.nodes.filter((n) =>
      selectedKeys.has(`${n.accountId}:${n.poolId}`),
    );
    if (targetNodes.length === 0) {
      showToast(store, "No reachable nodes in selected pools to reimage", "info");
      return;
    }
    try {
      const result = await orchestrator.execute({
        action: "bulk_node_action",
        payload: {
          actionType: "reimage",
          nodeIds: targetNodes.map((n) => n.id),
        },
      });
      const ok = result?.status !== "failed";
      recordAudit({
        action: "pool.reimage.bulk",
        target: selectedPools.map((p) => `${p.accountName}/${p.poolId}`).join(", "),
        status: ok ? "success" : "failure",
        details: {
          poolCount: selectedPools.length,
          nodeCount: targetNodes.length,
        },
      });
      showToast(
        store,
        ok
          ? `Reimage requested on ${targetNodes.length} node${targetNodes.length === 1 ? "" : "s"}`
          : `Reimage failed`,
        ok ? "success" : "error",
      );
    } catch (err) {
      showToast(
        store,
        `Reimage failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }, [selectedPools, state.nodes, orchestrator, store, recordAudit]);

  // Bulk drain — disable scheduling on every node in the selected pools.
  // This is the "evict" semantic the Batch API offers — new tasks won't be
  // assigned, but running tasks continue until they complete. Useful for a
  // graceful cordon before resize-down or delete.
  const submitBulkDrain = React.useCallback(async () => {
    if (selectedPools.length === 0) return;
    const selectedKeys = new Set(
      selectedPools.map((p) => `${p.accountId}:${p.poolId}`),
    );
    const targetNodes = state.nodes.filter((n) =>
      selectedKeys.has(`${n.accountId}:${n.poolId}`),
    );
    if (targetNodes.length === 0) {
      showToast(store, "No reachable nodes in selected pools to drain", "info");
      return;
    }
    try {
      const result = await orchestrator.execute({
        action: "bulk_node_action",
        payload: {
          actionType: "disableScheduling",
          nodeIds: targetNodes.map((n) => n.id),
        },
      });
      const ok = result?.status !== "failed";
      recordAudit({
        action: "pool.drain.bulk",
        target: selectedPools.map((p) => `${p.accountName}/${p.poolId}`).join(", "),
        status: ok ? "success" : "failure",
        details: {
          poolCount: selectedPools.length,
          nodeCount: targetNodes.length,
        },
      });
      showToast(
        store,
        ok
          ? `Drain requested on ${targetNodes.length} node${targetNodes.length === 1 ? "" : "s"} (no new tasks)`
          : `Drain failed`,
        ok ? "success" : "error",
      );
    } catch (err) {
      showToast(
        store,
        `Drain failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }, [selectedPools, state.nodes, orchestrator, store, recordAudit]);

  // Navigate to the pool-defaults page with the focused pool's
  // configuration pre-filled in router state.
  //
  // COORDINATOR: pool-defaults-page.tsx does NOT yet consume
  // `location.state.presetFrom`. The state survives the navigation because
  // react-router preserves the state object on `useLocation()`, but the
  // destination page currently just lands on its default form. Wiring
  // pool-defaults to read this state and seed the form fields (vmSize,
  // taskSlotsPerNode, autoScaleFormula, startTask) would close the loop
  // and turn "Edit defaults from this pool" into a true single-click
  // template-from-existing flow. Out of scope for this page.
  const openPoolDefaultsForPool = React.useCallback(
    (pool: PoolInfo | null) => {
      if (!pool) {
        navigate("/pool-defaults");
        return;
      }
      navigate("/pool-defaults", {
        state: {
          presetFrom: {
            poolId: pool.poolId,
            accountName: pool.accountName,
            region: pool.region,
            vmSize: pool.vmSize,
            taskSlotsPerNode: pool.taskSlotsPerNode,
            enableAutoScale: pool.enableAutoScale,
            autoScaleFormula: pool.autoScaleFormula,
            startTask: pool.startTask,
          },
        },
      });
    },
    [navigate],
  );

  // -----------------------------------------------------------------------
  // Per-row action handlers (used by the kebab menu in each row)
  // -----------------------------------------------------------------------
  const handleRowReboot = React.useCallback(
    async (pool: PoolInfo) => {
      try {
        await orchestrator.execute({
          action: "reboot_pool_nodes",
          payload: { accountId: pool.accountId, poolId: pool.poolId },
        });
        recordAudit({
          action: "pool.reboot",
          target: `${pool.accountName}/${pool.poolId}`,
          status: "success",
          details: { region: pool.region },
        });
        showToast(store, `Reboot requested on ${pool.poolId}`, "success");
      } catch (err) {
        recordAudit({
          action: "pool.reboot",
          target: `${pool.accountName}/${pool.poolId}`,
          status: "failure",
          details: { region: pool.region },
          error: err instanceof Error ? err.message : String(err),
        });
        showToast(
          store,
          `Reboot failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
    [orchestrator, store, recordAudit],
  );

  const handleRowDelete = React.useCallback(
    async (pool: PoolInfo) => {
      try {
        await orchestrator.execute({
          action: "delete_pool",
          payload: { accountId: pool.accountId, poolId: pool.poolId },
        });
        recordAudit({
          action: "pool.delete",
          target: `${pool.accountName}/${pool.poolId}`,
          status: "success",
          details: {
            region: pool.region,
            vmSize: pool.vmSize,
            currentDedicated: pool.currentDedicatedNodes,
            currentLowPriority: pool.currentLowPriorityNodes,
          },
        });
        showToast(store, `Deleted ${pool.poolId}`, "success");
      } catch (err) {
        recordAudit({
          action: "pool.delete",
          target: `${pool.accountName}/${pool.poolId}`,
          status: "failure",
          details: { region: pool.region },
          error: err instanceof Error ? err.message : String(err),
        });
        showToast(
          store,
          `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
    [orchestrator, store, recordAudit],
  );

  // -----------------------------------------------------------------------
  // DataTable columns (Contract §5)
  // -----------------------------------------------------------------------
  const columns = React.useMemo<DataTableColumn<PoolInfo>[]>(
    () => [
      {
        id: "poolId",
        header: "Pool ID",
        cell: (row) => (
          <span className="group/copy inline-flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/pool-info/${encodeURIComponent(row.poolId)}`);
              }}
              className="-ml-1 truncate rounded px-1 text-left text-xs font-medium text-foreground transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              title={`Open ${row.poolId}`}
              aria-label={`Open details for pool ${row.poolId}`}
            >
              {row.poolId}
            </button>
            <CopyButton
              value={row.poolId}
              ariaLabel={`Copy pool id ${row.poolId}`}
            />
          </span>
        ),
        sort: (a, b) => compareStrings(a.poolId, b.poolId),
        csv: (row) => row.poolId,
      },
      {
        id: "account",
        header: "Account",
        cell: (row) => (
          <span className="truncate text-xs" title={row.accountName}>
            {row.accountName}
          </span>
        ),
        sort: (a, b) => compareStrings(a.accountName, b.accountName),
        csv: (row) => row.accountName,
      },
      {
        id: "region",
        header: "Region",
        cell: (row) => <RegionBadge region={row.region} />,
        sort: (a, b) => compareStrings(a.region, b.region),
        csv: (row) => row.region,
      },
      {
        id: "vmSize",
        header: "VM size",
        cell: (row) => (
          <span className="truncate text-xs" title={row.vmSize}>
            {row.vmSize}
          </span>
        ),
        sort: (a, b) => compareStrings(a.vmSize, b.vmSize),
        csv: (row) => row.vmSize,
      },
      {
        id: "state",
        header: "State",
        cell: (row) => <StatusBadge status={row.state} />,
        sort: (a, b) => compareStrings(a.state, b.state),
        csv: (row) => row.state,
      },
      {
        id: "allocationState",
        header: "Allocation",
        cell: (row) => <StatusBadge status={row.allocationState} />,
        sort: (a, b) =>
          compareStrings(a.allocationState, b.allocationState),
        csv: (row) => row.allocationState,
      },
      {
        id: "currentDedicated",
        header: "Dedicated",
        cell: (row) => (
          <span className="tabular-nums text-xs">
            <span className="text-info">{row.currentDedicatedNodes}</span>
            <span className="text-muted-foreground">
              {" / "}
              {row.targetDedicatedNodes}
            </span>
          </span>
        ),
        sort: (a, b) =>
          compareNumbers(a.currentDedicatedNodes, b.currentDedicatedNodes),
        csv: (row) =>
          `${row.currentDedicatedNodes}/${row.targetDedicatedNodes}`,
      },
      {
        id: "currentLowPriority",
        header: "Low priority",
        cell: (row) => (
          <span className="tabular-nums text-xs">
            <span className="text-primary">
              {row.currentLowPriorityNodes}
            </span>
            <span className="text-muted-foreground">
              {" / "}
              {row.targetLowPriorityNodes}
            </span>
          </span>
        ),
        sort: (a, b) =>
          compareNumbers(
            a.currentLowPriorityNodes,
            b.currentLowPriorityNodes,
          ),
        csv: (row) =>
          `${row.currentLowPriorityNodes}/${row.targetLowPriorityNodes}`,
      },
      {
        id: "runningTasks",
        header: "Running",
        cell: (row) => {
          const n =
            runningTasksByPoolKey.get(`${row.accountId}:${row.poolId}`) ?? 0;
          return (
            <span
              className={cn(
                "tabular-nums text-xs",
                n > 0 ? "font-medium text-success" : "text-muted-foreground",
              )}
              title={`${n} running task${n === 1 ? "" : "s"}`}
            >
              {n}
            </span>
          );
        },
        sort: (a, b) =>
          compareNumbers(
            runningTasksByPoolKey.get(`${a.accountId}:${a.poolId}`) ?? 0,
            runningTasksByPoolKey.get(`${b.accountId}:${b.poolId}`) ?? 0,
          ),
        csv: (row) =>
          runningTasksByPoolKey.get(`${row.accountId}:${row.poolId}`) ?? 0,
      },
      {
        id: "taskSlots",
        header: "Slots/node",
        cell: (row) => (
          <span className="tabular-nums text-xs">
            {row.taskSlotsPerNode}
          </span>
        ),
        sort: (a, b) => compareNumbers(a.taskSlotsPerNode, b.taskSlotsPerNode),
        csv: (row) => row.taskSlotsPerNode,
        defaultHidden: true,
      },
      {
        id: "autoScale",
        header: "Auto scale",
        cell: (row) => (
          <span className="text-xs">{row.enableAutoScale ? "Yes" : "No"}</span>
        ),
        sort: (a, b) =>
          compareNumbers(
            a.enableAutoScale ? 1 : 0,
            b.enableAutoScale ? 1 : 0,
          ),
        csv: (row) => (row.enableAutoScale ? "Yes" : "No"),
        defaultHidden: true,
      },
      {
        id: "resizeErrors",
        header: "Errors",
        cell: (row) => {
          const count = row.resizeErrors?.length ?? 0;
          return (
            <span
              className={cn(
                "tabular-nums text-xs",
                count > 0
                  ? "font-semibold text-destructive"
                  : "text-muted-foreground",
              )}
              title={
                row.resizeErrors?.length
                  ? row.resizeErrors.join("\n")
                  : undefined
              }
            >
              {count}
            </span>
          );
        },
        sort: (a, b) =>
          compareNumbers(
            a.resizeErrors?.length ?? 0,
            b.resizeErrors?.length ?? 0,
          ),
        csv: (row) => row.resizeErrors?.length ?? 0,
      },
      {
        id: "created",
        header: "Created",
        cell: (row) => (
          <span
            className="text-xs text-muted-foreground"
            title={row.creationTime ?? ""}
          >
            {row.creationTime ? formatRelativeTime(row.creationTime) : "—"}
          </span>
        ),
        sort: (a, b) => {
          const aT = a.creationTime ? new Date(a.creationTime).getTime() : 0;
          const bT = b.creationTime ? new Date(b.creationTime).getTime() : 0;
          return compareNumbers(aT, bT);
        },
        csv: (row) => row.creationTime ?? "",
        defaultHidden: true,
      },
      {
        id: "risk",
        header: "Risk",
        cell: (row) => {
          const r = poolRiskById.get(row.id);
          const score = r?.score ?? 0;
          const tone = riskTone(score);
          // Compose the tooltip in one place so screen-reader + hover users
          // see the same explanation.
          const tip =
            r && r.reasons.length > 0
              ? `Risk ${score}/100\n${r.reasons.map((x) => `• ${x}`).join("\n")}`
              : `Risk ${score}/100 — no flags`;
          return (
            <span
              className={cn(
                "inline-flex h-5 min-w-[34px] items-center justify-center rounded px-1.5 text-2xs font-semibold tabular-nums",
                tone === "destructive" && "bg-destructive/15 text-destructive",
                tone === "warning" && "bg-warning/15 text-warning",
                tone === "info" && "bg-info/15 text-info",
                tone === "success" && "bg-muted text-muted-foreground",
              )}
              title={tip}
              aria-label={`Pool risk score ${score} of 100${r && r.reasons.length > 0 ? ", " + r.reasons.join(", ") : ""}`}
            >
              {score}
            </span>
          );
        },
        sort: (a, b) =>
          compareNumbers(
            poolRiskById.get(a.id)?.score ?? 0,
            poolRiskById.get(b.id)?.score ?? 0,
          ),
        csv: (row) => poolRiskById.get(row.id)?.score ?? 0,
      },
      {
        id: "rowActions",
        header: "",
        className: "w-[44px]",
        cell: (row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Actions for ${row.poolId}`}
                title="Pool actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {row.poolId}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  navigate(`/pool-info/${encodeURIComponent(row.poolId)}`);
                }}
              >
                <ExternalLink aria-hidden />
                <span>Inspect details</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  navigate(`/nodes?pool=${encodeURIComponent(row.poolId)}`);
                }}
              >
                <Server aria-hidden />
                <span>View nodes</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  openPoolDefaultsForPool(row);
                }}
                title="Open Pool Defaults with this pool's configuration pre-filled (g d)"
              >
                <Settings2 aria-hidden />
                <span>Edit defaults from this pool</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={row.allocationState !== "steady" || tokenStale}
                onSelect={(e) => {
                  e.preventDefault();
                  if (row.allocationState !== "steady" || tokenStale) return;
                  // Single-row quick-resize: replace selection with just
                  // this row, then open the standard resize dialog so the
                  // operator can pick a target. Replacing (instead of
                  // adding) keeps the dialog scoped to the row they
                  // actually clicked.
                  setSelection(new Set([row.id]));
                  const acctInfo =
                    state.accountInfos.find((a) => a.id === row.accountId) ??
                    null;
                  const freeLpCores = acctInfo?.lowPriorityCoresFree ?? 0;
                  const vmVCpus = getVCpus(row.vmSize);
                  const maxLpNodes = Math.floor(freeLpCores / vmVCpus);
                  setResizeDedicated(0);
                  setResizeLowPriority(maxLpNodes);
                  setShowResizeDialog(true);
                }}
                title={
                  tokenStale
                    ? "Refresh your ARM token first"
                    : row.allocationState !== "steady"
                      ? "Pool must be in steady state to resize"
                      : "Open the resize dialog for this pool"
                }
              >
                <Maximize2 aria-hidden />
                <span>Resize now</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  void handleRowReboot(row);
                }}
              >
                <Power aria-hidden />
                <span>Reboot all nodes</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  void handleRowDelete(row);
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 aria-hidden />
                <span>Delete pool</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
        // Exclude from CSV — row-action UI not a data column.
        csv: undefined,
        json: false,
      },
    ],
    [
      navigate,
      runningTasksByPoolKey,
      handleRowReboot,
      handleRowDelete,
      tokenStale,
      state.accountInfos,
      poolRiskById,
      openPoolDefaultsForPool,
    ],
  );

  const handleSelectionChange = React.useCallback((next: Set<string>) => {
    setSelection(next);
  }, []);

  const handleRowActivate = React.useCallback(
    (row: PoolInfo) => {
      navigate(`/pool-info/${encodeURIComponent(row.poolId)}`);
    },
    [navigate],
  );

  const filtersActive = Boolean(
    filters.q ||
      filters.region ||
      filters.state ||
      filters.allocation ||
      filters.account ||
      filters.vmSize ||
      filters.quick,
  );

  const clearFilters = React.useCallback(() => {
    setFilters({
      q: "",
      region: "",
      state: "",
      allocation: "",
      account: "",
      vmSize: "",
      quick: "",
    });
  }, [setFilters]);

  const closeFocusedSheet = React.useCallback(() => {
    navigate("/pool-info");
  }, [navigate]);

  // -----------------------------------------------------------------------
  // Keyboard shortcuts (migrated to `useShortcut` — typed, auto-skips
  // input fields, and respects the shared chord parser used elsewhere
  // in the dashboard).
  //   r       — refresh
  //   Escape  — clear selection
  //   Delete  — open bulk-delete confirm for the selected pools
  //   i       — reimage selected pools' nodes (no confirm — toast only)
  //   e       — drain (disable scheduling) selected pools' nodes
  //   g d     — go to Pool Defaults (two-key chord, see effect below)
  // -----------------------------------------------------------------------
  useShortcut(
    "r",
    () => {
      if (!loading) void refresh();
    },
    { enabled: !loading },
  );
  useShortcut(
    "Escape",
    () => {
      if (selection.size > 0) setSelection(new Set());
    },
    { enabled: selection.size > 0 },
  );
  useShortcut(
    "Delete",
    () => {
      // Mirror the bulk-delete toolbar button: open the confirm dialog
      // with a freshly reset typed-confirm string so the prior value
      // can't accidentally arm a destructive action.
      if (selection.size > 0 && !showBulkDeleteDialog) {
        setBulkDeleteConfirm("");
        setShowBulkDeleteDialog(true);
      }
    },
    { enabled: selection.size > 0 && !showBulkDeleteDialog },
  );
  // `i` / `e` are unconfirmed destructive-ish actions, so they're gated on
  // there being a non-empty selection AND no open dialog (otherwise the
  // operator typing in a still-open Start Task or Resize dialog could fire
  // a reimage by accident the moment focus leaves the input).
  const anyDialogOpen =
    showResizeDialog ||
    showResizeConfirm ||
    showStartTaskDialog ||
    showDeleteEmptyDialog ||
    showBulkDeleteDialog ||
    showRebootDialog;
  useShortcut(
    "i",
    () => {
      if (selection.size > 0 && !anyDialogOpen) void submitBulkReimage();
    },
    { enabled: selection.size > 0 && !anyDialogOpen },
  );
  useShortcut(
    "e",
    () => {
      if (selection.size > 0 && !anyDialogOpen) void submitBulkDrain();
    },
    { enabled: selection.size > 0 && !anyDialogOpen },
  );

  // Two-key chord support for `g d` (go-to-defaults). `useShortcut` doesn't
  // model multi-key chords, so we own this listener: pressing `g` arms the
  // chord for 1.2s, and a subsequent `d` navigates. Any other key, focus
  // change to an input, or the timeout cancels the chord. This mirrors the
  // gmail/vim convention and keeps the keyboard hint discoverable without
  // ballooning the shared hook.
  React.useEffect(() => {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearChord = () => {
      armed = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
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
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Don't arm or trigger the chord while a modal dialog is open — the
      // dialog's own keyboard layer (Esc to dismiss, Enter to confirm)
      // takes precedence.
      if (anyDialogOpen) return;
      const key = e.key.toLowerCase();
      if (armed) {
        // Chord is armed: only `d` completes it; anything else cancels.
        if (key === "d") {
          e.preventDefault();
          clearChord();
          openPoolDefaultsForPool(focusedPool ?? null);
          return;
        }
        clearChord();
        return;
      }
      if (key === "g") {
        armed = true;
        timer = setTimeout(clearChord, 1200);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearChord();
    };
  }, [openPoolDefaultsForPool, focusedPool, anyDialogOpen]);

  // Empty / loading guards.
  const initialLoading = loading && pools.length === 0 && !error;
  const showEmpty = !loading && !error && pools.length === 0;

  // CSV/JSON export columns for the filtered view. Doesn't mirror DataTable's
  // built-in CSV because the toolbar export button operates on the filtered
  // set even when the user has toggled columns off in the table.
  const exportColumns = React.useMemo<ExportColumn<PoolInfo>[]>(
    () => [
      { header: "Pool ID", accessor: (p) => p.poolId },
      { header: "Account", accessor: (p) => p.accountName },
      { header: "Region", accessor: (p) => p.region },
      { header: "VM Size", accessor: (p) => p.vmSize },
      { header: "State", accessor: (p) => p.state },
      { header: "Allocation", accessor: (p) => p.allocationState },
      {
        header: "Dedicated Current/Target",
        accessor: (p) =>
          `${p.currentDedicatedNodes}/${p.targetDedicatedNodes}`,
      },
      {
        header: "LowPri Current/Target",
        accessor: (p) =>
          `${p.currentLowPriorityNodes}/${p.targetLowPriorityNodes}`,
      },
      { header: "Slots/Node", accessor: (p) => p.taskSlotsPerNode },
      { header: "Auto Scale", accessor: (p) => p.enableAutoScale },
      {
        header: "Resize Errors",
        accessor: (p) => p.resizeErrors?.length ?? 0,
      },
      { header: "Created", accessor: (p) => p.creationTime ?? "" },
      { header: "Last Modified", accessor: (p) => p.lastModified ?? "" },
      {
        header: "Running Tasks",
        accessor: (p) =>
          runningTasksByPoolKey.get(`${p.accountId}:${p.poolId}`) ?? 0,
      },
    ],
    [runningTasksByPoolKey],
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div
      className="flex flex-col gap-4 py-4"
      aria-labelledby="pool-info-heading"
    >
      <PageHeader
        title="Pool Info"
        description="Inspect, resize, and manage Batch pools across regions. Shortcuts: R refresh · Esc clear selection · Delete delete selected · I reimage selected · E drain (disable scheduling) selected · G then D open Pool Defaults."
        titleId="pool-info-heading"
      >
        {/* Inline ARM-token freshness cue. Quiet until < 10 min from
            expiry, then flips warning/destructive. Click to force-
            refresh BEFORE starting a multi-minute resize / start-task
            update so the orchestrator's per-account token mints don't
            cluster around a flipping silent-cache state. */}
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
        {tenantCount > 1 && (
          <InfoTooltip
            content={`Pools span ${tenantCount} tenants. The ARM token badge tracks only your primary signed-in identity; the orchestrator mints per-account tokens for the rest.`}
            variant="info"
            className="text-info"
          />
        )}
        <Button
          variant="default"
          onClick={() => {
            void refresh();
          }}
          disabled={loading}
          aria-label="Refresh pools"
          title="Refresh pool data (R)"
        >
          <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
        {loading && (
          <span
            role="status"
            aria-live="polite"
            className="flex items-center gap-2"
          >
            <Loader2
              className="h-3.5 w-3.5 animate-spin text-muted-foreground"
              aria-label="Loading"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={stop}
              aria-label="Stop refreshing"
              title="Cancel in-flight refresh"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </Button>
          </span>
        )}
        <Button
          variant="outline"
          onClick={() => setShowDeleteEmptyDialog(true)}
          disabled={emptyPools.length === 0 || loading}
          title={
            emptyPools.length === 0
              ? "No empty pools to remove"
              : loading
                ? "Refreshing — try again in a moment"
                : `Remove ${emptyPools.length} empty pool${emptyPools.length === 1 ? "" : "s"}`
          }
          aria-label={`Remove ${emptyPools.length} empty pools`}
          className="border-destructive/40 text-destructive transition-colors duration-150 ease-out hover:bg-destructive/10 hover:text-destructive motion-reduce:transition-none"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove Empty
        </Button>
        <ExportMenu<PoolInfo>
          rows={filteredPools}
          columns={exportColumns}
          filename="pool-info"
          jsonMetadata={{
            filtersApplied: {
              q: filters.q || undefined,
              region: filters.region || undefined,
              state: filters.state || undefined,
              allocation: filters.allocation || undefined,
              account: filters.account || undefined,
              vmSize: filters.vmSize || undefined,
              quick: filters.quick || undefined,
            },
          }}
        />
        <div className="ml-2 flex items-center gap-2">
          <Switch
            id="pool-info-auto-refresh"
            checked={autoRefresh}
            onCheckedChange={(checked) => setAutoRefresh(checked === true)}
            aria-label="Toggle auto-refresh every 30 seconds"
          />
          <Label
            htmlFor="pool-info-auto-refresh"
            className="cursor-pointer text-xs text-muted-foreground"
          >
            Auto-refresh (30s)
          </Label>
        </div>
      </PageHeader>

      {tokenStale && (
        <Alert variant="warning" aria-label="Token freshness warning">
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription>
            Your primary ARM token expires in under {TOKEN_RESIZE_BLOCK_SECONDS}{" "}
            seconds. Resize is paused — click the token badge above to refresh
            before submitting changes.
          </AlertDescription>
        </Alert>
      )}

      {resizeBlocked && !tokenStale && nonSteadySelected.length > 0 && (
        <Alert variant="warning" aria-label="Resize blocked notice">
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription>
            Resize requires steady state. {nonSteadySelected.length} selected
            pool{nonSteadySelected.length === 1 ? "" : "s"} not steady.
          </AlertDescription>
        </Alert>
      )}

      {/* Bulk-selection toolbar — appears whenever rows are selected. */}
      {selectedPools.length > 0 && (
        <div
          role="region"
          aria-label="Bulk actions for selected pools"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2"
        >
          {/* aria-live so the screen reader announces selection changes
              without forcing focus into the toolbar — count and running-task
              total update together as the operator selects/deselects rows. */}
          <span
            className="text-xs font-medium text-foreground"
            aria-live="polite"
            aria-atomic="true"
          >
            {selectedPools.length} pool{selectedPools.length === 1 ? "" : "s"}{" "}
            selected
            <span className="ml-2 text-2xs font-normal text-muted-foreground">
              ({selectedRunningTasks} running task
              {selectedRunningTasks === 1 ? "" : "s"})
            </span>
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={openResizeDialog}
              disabled={resizeBlocked}
              title={
                tokenStale
                  ? "Refresh your ARM token first"
                  : nonSteadySelected.length > 0
                    ? "All selected pools must be in steady allocation"
                    : `Resize ${selectedPools.length} pool${selectedPools.length === 1 ? "" : "s"}`
              }
              aria-label="Resize selected pools"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Resize
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={openStartTaskDialog}
              title={`Update start task for ${selectedPools.length} pool${selectedPools.length === 1 ? "" : "s"}`}
              aria-label="Update start task on selected pools"
            >
              <Play className="h-3.5 w-3.5" />
              Start Task
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRebootDialog(true)}
              title={`Reboot all nodes in ${selectedPools.length} pool${selectedPools.length === 1 ? "" : "s"} (R restarts the OS)`}
              aria-label={`Reboot all nodes in ${selectedPools.length} selected pools`}
            >
              <Power className="h-3.5 w-3.5" />
              Reboot Nodes
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void submitBulkReimage()}
              title="Reimage every node — rebuild from the pool image (shortcut: I)"
              aria-label={`Reimage all nodes in ${selectedPools.length} selected pools`}
            >
              <RotateCw className="h-3.5 w-3.5" />
              Reimage
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void submitBulkDrain()}
              title="Disable scheduling on every node — running tasks continue, no new tasks assigned (shortcut: E)"
              aria-label={`Drain (disable scheduling) all nodes in ${selectedPools.length} selected pools`}
            >
              <Square className="h-3.5 w-3.5" />
              Drain
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setBulkDeleteConfirm("");
                setShowBulkDeleteDialog(true);
              }}
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              title={`Delete ${selectedPools.length} pool${selectedPools.length === 1 ? "" : "s"}`}
              aria-label="Delete selected pools"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelection(new Set())}
              aria-label="Clear selection"
              title="Clear selection (Esc)"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Quick-filter chips */}
      <div
        role="toolbar"
        aria-label="Quick filters"
        className="flex flex-wrap items-center gap-2"
      >
        <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          Quick filter
        </span>
        <QuickChip
          active={!filters.quick}
          onClick={() => setFilters({ quick: "" })}
          label="All"
          count={pools.length}
        />
        {QUICK_CHIPS.map((chip) => (
          <QuickChip
            key={chip.key}
            active={filters.quick === chip.key}
            onClick={() =>
              setFilters({ quick: filters.quick === chip.key ? "" : chip.key })
            }
            label={chip.label}
            count={chipCounts.get(chip.key) ?? 0}
            tip={chip.tip}
            toneClassName={chip.className}
          />
        ))}
      </div>

      {/* Filter bar — values mirrored to the URL via useUrlState */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <Label
            htmlFor="pool-info-search"
            className="text-2xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Search
          </Label>
          <Input
            id="pool-info-search"
            type="search"
            placeholder="Pool, account, region, VM size..."
            value={filters.q}
            onChange={(e) => setFilters({ q: e.target.value })}
            className="text-xs"
            aria-label="Search pools"
          />
        </div>
        <FilterSelect
          id="pool-info-region"
          label="Region"
          value={filters.region}
          onChange={(v) => setFilters({ region: v })}
          options={uniqueRegions}
          placeholder="All regions"
        />
        <FilterSelect
          id="pool-info-account"
          label="Account"
          value={filters.account}
          onChange={(v) => setFilters({ account: v })}
          options={uniqueAccounts}
          placeholder="All accounts"
        />
        <FilterSelect
          id="pool-info-vmsize"
          label="VM size"
          value={filters.vmSize}
          onChange={(v) => setFilters({ vmSize: v })}
          options={uniqueVmSizes}
          placeholder="All VM sizes"
        />
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="pool-info-state"
            className="text-2xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            <span className="inline-flex items-center gap-1">
              State
              <InfoTooltip
                content="Lifecycle state of the pool resource: active or deleting."
                size={11}
              />
            </span>
          </Label>
          <Select
            value={filters.state || "__all"}
            onValueChange={(v) =>
              setFilters({ state: v === "__all" ? "" : v })
            }
          >
            <SelectTrigger
              id="pool-info-state"
              className="h-8 w-[150px] text-xs"
              aria-label="Filter by lifecycle state"
            >
              <SelectValue placeholder="All states" />
            </SelectTrigger>
            <SelectContent>
              {STATE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="pool-info-allocation"
            className="text-2xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            <span className="inline-flex items-center gap-1">
              Allocation
              <InfoTooltip
                content="Whether the pool is at its target size (steady), changing (resizing), or stopping a resize (stopping)."
                size={11}
              />
            </span>
          </Label>
          <Select
            value={filters.allocation || "__all"}
            onValueChange={(v) =>
              setFilters({ allocation: v === "__all" ? "" : v })
            }
          >
            <SelectTrigger
              id="pool-info-allocation"
              className="h-8 w-[160px] text-xs"
              aria-label="Filter by allocation state"
            >
              <SelectValue placeholder="All allocations" />
            </SelectTrigger>
            <SelectContent>
              {ALLOCATION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filtersActive && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={clearFilters}
            aria-label="Clear all filters"
          >
            <FilterIcon className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {/* Pool fleet health — node-state donut + allocation efficiency */}
      {pools.length > 0 && (
        <section
          role="region"
          aria-label="Pool fleet health"
          className="grid grid-cols-1 gap-3 lg:grid-cols-3"
        >
          <div className="flex items-center gap-4 rounded-md border border-border bg-card p-4">
            <Donut
              segments={fleetHealth.stateSegments}
              size={96}
              thickness={14}
              centerLabel={formatNumber(fleetHealth.totalNodesInFleet)}
              centerSubLabel="nodes"
            />
            <div className="min-w-0 flex-1">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Node-state distribution
              </h3>
              <DonutLegend
                segments={fleetHealth.stateSegments}
                className="mt-2"
              />
            </div>
          </div>

          <div className="flex flex-col justify-center gap-3 rounded-md border border-border bg-card p-4 lg:col-span-2">
            <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Allocation efficiency (current vs target)
            </h3>
            <Gauge
              label="Across all pools"
              unit="nodes"
              used={fleetHealth.currentTotal}
              total={Math.max(
                fleetHealth.targetTotal,
                fleetHealth.currentTotal,
              )}
              tone={
                fleetHealth.targetTotal === 0
                  ? "info"
                  : fleetHealth.currentTotal === fleetHealth.targetTotal
                    ? "success"
                    : fleetHealth.currentTotal < fleetHealth.targetTotal * 0.5
                      ? "warning"
                      : fleetHealth.overshoot
                        ? "info"
                        : "info"
              }
              size="lg"
            />
            <p className="text-2xs text-muted-foreground">
              {fleetHealth.targetTotal === 0
                ? "No pools have a target node count yet."
                : fleetHealth.currentTotal === fleetHealth.targetTotal
                  ? `All ${formatNumber(fleetHealth.currentTotal)} nodes are at their target — fleet is in steady state.`
                  : fleetHealth.currentTotal < fleetHealth.targetTotal
                    ? `${formatNumber(
                        fleetHealth.targetTotal - fleetHealth.currentTotal,
                      )} nodes pending allocation${
                        resizingPools > 0
                          ? ` (${resizingPools} pool${resizingPools === 1 ? "" : "s"} resizing)`
                          : ""
                      }.`
                    : `Fleet is ${formatNumber(
                        fleetHealth.currentTotal - fleetHealth.targetTotal,
                      )} nodes over its target — a resize-down is in progress.`}
            </p>
          </div>
        </section>
      )}

      {/* Summary stats — clickable to drill in via quick-filter */}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Pool summary"
      >
        <SummaryStatItem
          label="Total"
          value={totalPools}
          hint="pools"
          onClick={() => setFilters({ quick: "" })}
        />
        <SummaryStatItem
          label="Active"
          value={activePools}
          hint="active"
          tone="success"
          onClick={() => setFilters({ state: "active", quick: "" })}
        />
        <SummaryStatItem
          label="Dedicated"
          value={totalDedicated}
          hint="nodes"
          tone="info"
        />
        <SummaryStatItem
          label="Low Priority"
          value={totalLowPri}
          hint="nodes"
          tone="info"
        />
        <SummaryStatItem
          label="Resizing"
          value={resizingPools}
          hint="in flight"
          tone="warning"
          onClick={() => setFilters({ quick: "resizing" })}
        />
        <SummaryStatItem
          label="With Errors"
          value={errorPools}
          hint="resize errors"
          tone={errorPools > 0 ? "destructive" : "muted"}
          onClick={() => setFilters({ quick: "issues" })}
        />
        <SummaryStatItem
          label="Empty"
          value={emptyPools.length}
          hint="0 nodes"
          tone="muted"
          onClick={() => setFilters({ quick: "empty" })}
        />
        {filteredPools.length !== pools.length && (
          <SummaryStatItem
            label="Showing"
            value={filteredPools.length}
            hint={`of ${pools.length}`}
            tone="muted"
            compact
          />
        )}
      </div>

      {/* Page-level error state */}
      {error && (
        <ErrorState
          message="Failed to load pool information."
          detail={error.message}
          onRetry={refresh}
        />
      )}

      {/* Initial-load skeleton */}
      {initialLoading && (
        <div
          className="rounded-lg border border-border bg-card p-4"
          aria-label="Loading pools"
        >
          <SkeletonLoader variant="table" rows={6} columns={8} />
        </div>
      )}

      {/* Empty state */}
      {showEmpty && (
        <EmptyState
          icon={Boxes}
          title="No pools found"
          description="Pools will appear here after discovery completes."
          action={{
            label: "Refresh",
            onClick: refresh,
            icon: RotateCw,
            loading,
          }}
        />
      )}

      {/* DataTable — only render once we have rows or loading state */}
      {(pools.length > 0 || loading) && !error && !initialLoading && (
        <DataTable<PoolInfo>
          tableId="pool-info"
          rows={filteredPools}
          columns={columns}
          rowKey={(row) => row.id}
          loading={loading && pools.length === 0}
          empty={
            <EmptyState
              icon={Boxes}
              title="No pools match your filters"
              description={
                filtersActive
                  ? "Adjust or clear the filters above."
                  : "Pools will appear here after discovery."
              }
              action={
                filtersActive
                  ? {
                      label: "Clear filters",
                      onClick: clearFilters,
                      icon: FilterIcon,
                    }
                  : undefined
              }
            />
          }
          selection={selection}
          onSelectionChange={handleSelectionChange}
          onRowActivate={handleRowActivate}
          csvFileName="pool-info-export.csv"
        />
      )}

      {/* Deep-link details Sheet */}
      <PoolDetailsSheet
        pool={focusedPool}
        focusedPoolId={focusedPoolId}
        loading={loading && pools.length === 0}
        nodesByPoolKey={nodesByPoolKey}
        accountResourceId={
          focusedPool ? getAccountForPool(focusedPool) : null
        }
        risk={focusedPool ? (poolRiskById.get(focusedPool.id) ?? null) : null}
        imdsHits={focusedPool ? (imdsHitsById.get(focusedPool.id) ?? null) : null}
        stuckStartTask={
          focusedPool ? (stuckStartTaskById.get(focusedPool.id) ?? null) : null
        }
        nodeCountHistory={
          focusedPool ? (poolHistoryRef.current.get(focusedPool.id) ?? null) : null
        }
        onClose={closeFocusedSheet}
        onNavigateToNodes={(poolId) =>
          navigate(`/nodes?pool=${encodeURIComponent(poolId)}`)
        }
        onEditDefaults={() => openPoolDefaultsForPool(focusedPool)}
        onResize={() => {
          if (focusedPool) {
            setSelection(new Set([focusedPool.id]));
            openResizeDialog();
          }
        }}
        onReboot={() => {
          if (focusedPool) void handleRowReboot(focusedPool);
        }}
        onDelete={() => {
          if (focusedPool) void handleRowDelete(focusedPool);
        }}
      />

      {/* Remove Empty Pools confirmation */}
      <ConfirmationDialog
        hidden={!showDeleteEmptyDialog}
        title={`Remove ${emptyPools.length} empty pool${emptyPools.length === 1 ? "" : "s"}?`}
        danger
        loading={deleteEmptySubmitting}
        confirmText={deleteEmptySubmitting ? "Deleting..." : "Remove"}
        onConfirm={submitDeleteEmptyPools}
        onCancel={() => setShowDeleteEmptyDialog(false)}
        message={
          <div className="flex flex-col gap-2">
            <Alert variant="warning">
              <TriangleAlert className="h-4 w-4" />
              <AlertDescription>
                This action cannot be undone. {emptyPools.length} empty pool
                {emptyPools.length === 1 ? "" : "s"} (0 nodes) will be
                permanently deleted.
              </AlertDescription>
            </Alert>
            <div className="flex max-h-[200px] flex-col gap-1 overflow-y-auto">
              {emptyPools.slice(0, 10).map((pool) => (
                <span key={pool.id} className="text-xs text-foreground">
                  {pool.poolId} ({pool.accountName} / {pool.region}) — 0 nodes
                </span>
              ))}
              {emptyPools.length > 10 && (
                <span className="text-xs italic text-muted-foreground">
                  and {emptyPools.length - 10} more...
                </span>
              )}
            </div>
          </div>
        }
      />

      {/* Bulk reboot confirmation */}
      <ConfirmationDialog
        hidden={!showRebootDialog}
        title={`Reboot all nodes in ${selectedPools.length} pool${selectedPools.length === 1 ? "" : "s"}?`}
        danger
        loading={rebootSubmitting}
        confirmText={rebootSubmitting ? "Rebooting..." : "Reboot All"}
        onConfirm={submitBulkReboot}
        onCancel={() => setShowRebootDialog(false)}
        message={
          <div className="flex flex-col gap-2">
            <Alert variant="warning">
              <TriangleAlert className="h-4 w-4" />
              <AlertDescription>
                Rebooting will temporarily take nodes offline. Any{" "}
                {selectedRunningTasks} running task
                {selectedRunningTasks === 1 ? "" : "s"} may be terminated and
                requeued.
              </AlertDescription>
            </Alert>
            <div className="flex max-h-[200px] flex-col gap-1 overflow-y-auto">
              {selectedPools.slice(0, 10).map((pool) => (
                <span key={pool.id} className="text-xs text-foreground">
                  {pool.poolId} ({pool.accountName}) —{" "}
                  {pool.currentDedicatedNodes + pool.currentLowPriorityNodes}{" "}
                  nodes
                </span>
              ))}
              {selectedPools.length > 10 && (
                <span className="text-xs italic text-muted-foreground">
                  and {selectedPools.length - 10} more...
                </span>
              )}
            </div>
          </div>
        }
      />

      {/* Bulk delete confirmation — guarded by typed phrase. */}
      <Dialog
        open={showBulkDeleteDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowBulkDeleteDialog(false);
            setBulkDeleteConfirm("");
          }
        }}
      >
        <DialogContent className="min-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-destructive">
              Delete {selectedPools.length} pool
              {selectedPools.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the pool resource and terminates all
              running tasks. Type{" "}
              <code className="rounded bg-destructive/10 px-1 font-mono text-destructive">
                delete
              </code>{" "}
              to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Alert variant="destructive">
              <TriangleAlert className="h-4 w-4" />
              <AlertDescription>
                {selectedRunningTasks > 0
                  ? `${selectedRunningTasks} running task${selectedRunningTasks === 1 ? " is" : "s are"} on the selected pool${selectedPools.length === 1 ? "" : "s"} and will be terminated.`
                  : "No running tasks detected on the selected pools."}
              </AlertDescription>
            </Alert>
            <div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto rounded border border-border bg-card p-2">
              {selectedPools.slice(0, 12).map((pool) => (
                <span key={pool.id} className="text-xs text-foreground">
                  {pool.poolId} ({pool.accountName} / {pool.region}) —{" "}
                  {pool.currentDedicatedNodes} dedicated /{" "}
                  {pool.currentLowPriorityNodes} LP
                  {pool.state === "deleting" ? " (already deleting)" : ""}
                </span>
              ))}
              {selectedPools.length > 12 && (
                <span className="text-xs italic text-muted-foreground">
                  and {selectedPools.length - 12} more...
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bulk-delete-confirm">Type "delete"</Label>
              <Input
                id="bulk-delete-confirm"
                value={bulkDeleteConfirm}
                onChange={(e) => setBulkDeleteConfirm(e.target.value)}
                autoComplete="off"
                aria-label="Type the word delete to confirm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowBulkDeleteDialog(false);
                setBulkDeleteConfirm("");
              }}
              aria-label="Cancel bulk delete"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={submitBulkDelete}
              disabled={
                bulkDeleteSubmitting ||
                bulkDeleteConfirm.trim().toLowerCase() !== "delete"
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              aria-label={`Delete ${selectedPools.length} pools`}
            >
              {bulkDeleteSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete {selectedPools.length}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resize Pool dialog */}
      <Dialog
        open={showResizeDialog}
        onOpenChange={(open) => {
          if (!open) setShowResizeDialog(false);
        }}
      >
        <DialogContent className="min-w-[520px]">
          <DialogHeader>
            <DialogTitle>
              {selectedPools.length > 1
                ? `Resize ${selectedPools.length} Pools`
                : "Resize Pool"}
            </DialogTitle>
            <DialogDescription>
              {selectedPools.length > 1
                ? `Apply the same resize to all ${selectedPools.length} selected pools.`
                : "Adjust the target node counts for this pool."}
            </DialogDescription>
          </DialogHeader>
          {selectedPool && (
            <div className="flex flex-col gap-3">
              {resizeBlocked && (
                <Alert
                  variant="destructive"
                  aria-label="Allocation state blocked"
                >
                  <TriangleAlert className="h-4 w-4" />
                  <AlertDescription>
                    {tokenStale
                      ? "Token expires too soon — refresh the ARM token before resizing."
                      : "Resize requires steady state. Some selected pools are currently in a transitional state."}
                  </AlertDescription>
                </Alert>
              )}
              {selectedRunningTasks > 0 && (
                <Alert variant="warning" aria-label="Running tasks warning">
                  <TriangleAlert className="h-4 w-4" />
                  <AlertDescription>
                    {selectedRunningTasks} running task
                    {selectedRunningTasks === 1 ? "" : "s"} on the selected
                    pool{selectedPools.length === 1 ? "" : "s"} may be
                    terminated if nodes are removed.
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-2 rounded bg-surface-overlay p-3">
                <div className="text-sm">
                  <span className="text-muted-foreground">Pool ID: </span>
                  <span className="text-foreground">{selectedPool.poolId}</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Current nodes: </span>
                  <span className="text-foreground">
                    {selectedPool.currentDedicatedNodes} dedicated /{" "}
                    {selectedPool.currentLowPriorityNodes} LP
                  </span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Account: </span>
                  <span className="text-foreground">
                    {selectedPool.accountName}
                  </span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Region: </span>
                  <span className="text-foreground">{selectedPool.region}</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">VM Size: </span>
                  <span className="text-foreground">{selectedPool.vmSize}</span>
                </div>
              </div>
              <Alert variant="info">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <div className="flex flex-col gap-1">
                    <span>
                      <b>LP Quota:</b>{" "}
                      {selectedAccountInfo?.lowPriorityCoreQuota ?? "N/A"} cores
                      | <b>LP Free:</b>{" "}
                      {selectedAccountInfo?.lowPriorityCoresFree ?? "N/A"} cores
                    </span>
                    <span>
                      <b>VM vCPUs:</b> {getVCpus(selectedPool.vmSize)} |{" "}
                      <b>Max LP Nodes:</b> {getMaxLpNodes()}
                    </span>
                  </div>
                </AlertDescription>
              </Alert>

              <div className="flex flex-col gap-1">
                <Label htmlFor="resize-dedicated">Target Dedicated Nodes</Label>
                <Input
                  id="resize-dedicated"
                  type="number"
                  min={0}
                  step={1}
                  value={resizeDedicated}
                  disabled
                  className="opacity-60"
                  aria-label="Target dedicated nodes (read-only)"
                />
                <span className="-mt-1 text-2xs italic text-muted-foreground">
                  Dedicated nodes always set to 0 (read-only)
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="resize-lp">Target Low-Priority Nodes</Label>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() =>
                      setResizeLowPriority((n) => Math.max(0, n - 1))
                    }
                    aria-label="Decrease low-priority nodes"
                  >
                    −
                  </Button>
                  <Input
                    id="resize-lp"
                    type="number"
                    min={0}
                    step={1}
                    value={resizeLowPriority}
                    onChange={(e) =>
                      setResizeLowPriority(
                        parseInt(e.target.value || "0", 10) || 0,
                      )
                    }
                    aria-label="Target low-priority nodes"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setResizeLowPriority((n) => n + 1)}
                    aria-label="Increase low-priority nodes"
                  >
                    +
                  </Button>
                </div>
                {/* Percentage-of-max quick picks — biggest UX win in the
                    resize dialog: most operators want "all of it" or one of
                    the round-number portions, not a fiddly counter. */}
                <div
                  role="group"
                  aria-label="Quick-pick targets"
                  className="mt-1 flex flex-wrap gap-1"
                >
                  {[0, 25, 50, 75, 100].map((pct) => {
                    const max = getMaxLpNodes();
                    const target = Math.floor((max * pct) / 100);
                    return (
                      <Button
                        key={pct}
                        type="button"
                        variant={
                          resizeLowPriority === target ? "default" : "outline"
                        }
                        size="sm"
                        onClick={() => setResizeLowPriority(target)}
                        className="h-6 text-2xs"
                        aria-label={`Set target to ${pct}% of max (${target} nodes)`}
                      >
                        {pct}% ({target})
                      </Button>
                    );
                  })}
                  <Button
                    type="button"
                    variant={
                      resizeLowPriority === selectedPool.currentLowPriorityNodes
                        ? "default"
                        : "outline"
                    }
                    size="sm"
                    onClick={() =>
                      setResizeLowPriority(selectedPool.currentLowPriorityNodes)
                    }
                    className="h-6 text-2xs"
                    aria-label="Match current node count"
                    title="Match the pool's current node count"
                  >
                    Match current
                  </Button>
                </div>
              </div>

              {resizeIsNoOp && (
                <Alert variant="info">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    All selected pools are already at this target. Submitting
                    will skip the API call (no-op).
                  </AlertDescription>
                </Alert>
              )}

              {resizeLowPriority > getMaxLpNodes() && (
                <Alert variant="warning">
                  <TriangleAlert className="h-4 w-4" />
                  <AlertDescription>
                    Requested {resizeLowPriority} nodes exceeds the max
                    available ({getMaxLpNodes()}) based on free LP quota. The
                    resize may partially fail.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowResizeDialog(false)}
              aria-label="Cancel resize"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={() => setShowResizeConfirm(true)}
              disabled={resizeSubmitting || resizeBlocked}
              aria-label={
                selectedPool
                  ? `Submit resize for pool ${selectedPool.poolId}`
                  : "Submit resize"
              }
            >
              {resizeSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Submitting...
                </>
              ) : resizeIsNoOp ? (
                "Skip (No Change)"
              ) : (
                "Resize"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resize confirmation */}
      <ConfirmationDialog
        hidden={!showResizeConfirm}
        title={
          selectedPools.length > 1
            ? `Resize ${selectedPools.length} pools?`
            : "Resize pool?"
        }
        danger
        loading={resizeSubmitting}
        confirmText={resizeSubmitting ? "Submitting..." : "Confirm Resize"}
        onConfirm={submitResize}
        onCancel={() => setShowResizeConfirm(false)}
        message={
          <div className="flex flex-col gap-2">
            {selectedPool && selectedPools.length === 1 && (
              <div className="text-sm text-foreground">
                <b>Pool:</b> {selectedPool.poolId}
                <br />
                <b>Current nodes:</b> {selectedPool.currentDedicatedNodes}{" "}
                dedicated / {selectedPool.currentLowPriorityNodes} LP
                <br />
                <b>Target:</b> {resizeDedicated} dedicated /{" "}
                {resizeLowPriority} LP
              </div>
            )}
            {selectedPools.length > 1 && (
              <div className="text-sm text-foreground">
                Apply target {resizeDedicated} dedicated /{" "}
                {resizeLowPriority} LP to {selectedPools.length} pools.
              </div>
            )}
            <Alert variant="warning">
              <TriangleAlert className="h-4 w-4" />
              <AlertDescription>
                Resize is a long-running operation. Existing tasks on removed
                nodes may be terminated.
              </AlertDescription>
            </Alert>
          </div>
        }
      />

      {/* Update Start Task dialog */}
      <Dialog
        open={showStartTaskDialog}
        onOpenChange={(open) => {
          if (!open) setShowStartTaskDialog(false);
        }}
      >
        <DialogContent className="min-w-[600px] max-w-[700px]">
          <DialogHeader>
            <DialogTitle>
              {selectedPools.length > 1
                ? `Update Start Task (${selectedPools.length} Pools)`
                : "Update Start Task"}
            </DialogTitle>
            <DialogDescription>
              {selectedPools.length > 1
                ? `Apply the same start task to all ${selectedPools.length} selected pools.`
                : selectedPool
                  ? `Pool: ${selectedPool.poolId} (${selectedPool.accountName})`
                  : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="start-task-command-line">Command Line</Label>
              <Input
                id="start-task-command-line"
                value={startTaskCommandLine}
                onChange={(e) => {
                  setStartTaskCommandLine(e.target.value);
                  setStartTaskError(null);
                }}
                placeholder="/bin/bash -c 'echo hello'"
                aria-label="Start task command line"
                className="font-mono text-xs"
              />
            </div>

            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="start-task-scope">User Identity Scope</Label>
                <Select
                  value={startTaskUserScope}
                  onValueChange={(v) =>
                    setStartTaskUserScope((v as "pool" | "task") ?? "pool")
                  }
                >
                  <SelectTrigger
                    id="start-task-scope"
                    className="w-[180px]"
                    aria-label="User identity scope"
                  >
                    <SelectValue placeholder="Select user scope" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pool">Pool user</SelectItem>
                    <SelectItem value="task">Task user</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="start-task-elevation">Elevation Level</Label>
                <Select
                  value={startTaskElevation}
                  onValueChange={(v) =>
                    setStartTaskElevation(
                      (v as "admin" | "nonadmin") ?? "admin",
                    )
                  }
                >
                  <SelectTrigger
                    id="start-task-elevation"
                    className="w-[180px]"
                    aria-label="Elevation level"
                  >
                    <SelectValue placeholder="Select elevation" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="nonadmin">Non-admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Label>Resource Files</Label>
            <div className="flex flex-col gap-1.5">
              {startTaskResourceFiles.map((rf, idx) => (
                <div key={idx} className="flex items-end gap-2">
                  <Input
                    placeholder="HTTP URL"
                    value={rf.httpUrl}
                    onChange={(e) =>
                      updateResourceFile(idx, "httpUrl", e.target.value)
                    }
                    className="flex-[2]"
                    aria-label={`Resource file ${idx + 1} URL`}
                  />
                  <Input
                    placeholder="File path (optional)"
                    value={rf.filePath}
                    onChange={(e) =>
                      updateResourceFile(idx, "filePath", e.target.value)
                    }
                    className="flex-1"
                    aria-label={`Resource file ${idx + 1} path`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Remove resource file"
                    aria-label="Remove resource file"
                    onClick={() => removeResourceFile(idx)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addResourceFile}
                className="self-start text-xs"
                aria-label="Add resource file"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Resource File
              </Button>
            </div>

            <Label>Environment Variables</Label>
            <div className="flex flex-col gap-1.5">
              {startTaskEnvVars.map((ev, idx) => (
                <div key={idx} className="flex items-end gap-2">
                  <Input
                    placeholder="Name"
                    value={ev.name}
                    onChange={(e) => updateEnvVar(idx, "name", e.target.value)}
                    className="w-[180px]"
                    aria-label={`Env var ${idx + 1} name`}
                  />
                  <Input
                    placeholder="Value"
                    value={ev.value}
                    onChange={(e) => updateEnvVar(idx, "value", e.target.value)}
                    className="flex-1"
                    aria-label={`Env var ${idx + 1} value`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Remove variable"
                    aria-label="Remove environment variable"
                    onClick={() => removeEnvVar(idx)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addEnvVar}
                className="self-start text-xs"
                aria-label="Add environment variable"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Variable
              </Button>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="start-task-retry">Max Retry Count</Label>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={() =>
                    setStartTaskMaxRetryCount((n) => Math.max(0, n - 1))
                  }
                  aria-label="Decrease max retry count"
                >
                  −
                </Button>
                <Input
                  id="start-task-retry"
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  value={startTaskMaxRetryCount}
                  onChange={(e) =>
                    setStartTaskMaxRetryCount(
                      parseInt(e.target.value || "3", 10) || 3,
                    )
                  }
                  aria-label="Max retry count"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={() =>
                    setStartTaskMaxRetryCount((n) => Math.min(10, n + 1))
                  }
                  aria-label="Increase max retry count"
                >
                  +
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="start-task-wait-success"
                checked={startTaskWaitForSuccess}
                onCheckedChange={(checked) =>
                  setStartTaskWaitForSuccess(checked === true)
                }
                aria-label="Wait for success"
              />
              <Label
                htmlFor="start-task-wait-success"
                className="cursor-pointer"
              >
                Wait for Success
              </Label>
            </div>

            <div className="mt-1 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="start-task-reboot-after"
                  checked={startTaskRebootAfter}
                  onCheckedChange={(checked) =>
                    setStartTaskRebootAfter(checked === true)
                  }
                  aria-label="Reboot all nodes after update"
                />
                <Label
                  htmlFor="start-task-reboot-after"
                  className={cn(
                    "cursor-pointer",
                    startTaskRebootAfter && "text-warning",
                  )}
                >
                  Reboot all nodes after update
                </Label>
              </div>
              {startTaskRebootAfter && (
                <Alert variant="warning" className="mt-1">
                  <TriangleAlert className="h-4 w-4" />
                  <AlertDescription>
                    All nodes in the selected pool(s) will be rebooted after
                    the start task is updated.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            {startTaskError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="whitespace-pre-line">
                  {startTaskError}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowStartTaskDialog(false)}
              aria-label="Cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={submitStartTask}
              disabled={startTaskSubmitting}
              aria-label={
                startTaskRebootAfter
                  ? "Update start task and reboot all nodes"
                  : "Update start task"
              }
            >
              {startTaskSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Submitting...
                </>
              ) : startTaskRebootAfter ? (
                "Update & Reboot Nodes"
              ) : (
                "Update Start Task"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Local sub-components
// ---------------------------------------------------------------------------

interface QuickChipProps {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tip?: string;
  toneClassName?: string;
}

/**
 * A small click-to-toggle chip — used for the row of quick filters above the
 * main filter bar. Looks like a pill with a numeric badge baked in.
 */
const QuickChip: React.FC<QuickChipProps> = ({
  active,
  onClick,
  label,
  count,
  tip,
  toneClassName,
}) => (
  <button
    type="button"
    onClick={onClick}
    title={tip}
    aria-label={`${label}: ${count} pool${count === 1 ? "" : "s"}`}
    aria-pressed={active}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
      active
        ? "border-primary bg-primary/15 text-primary"
        : cn(
            "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
            toneClassName,
          ),
    )}
  >
    <span>{label}</span>
    <span
      className={cn(
        "inline-flex h-4 min-w-[18px] items-center justify-center rounded-full px-1 text-3xs tabular-nums",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-foreground",
      )}
    >
      {count}
    </span>
  </button>
);

interface FilterSelectProps {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: string[];
  placeholder: string;
}

const FilterSelect: React.FC<FilterSelectProps> = ({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
}) => (
  <div className="flex flex-col gap-1">
    <Label
      htmlFor={id}
      className="text-2xs font-medium uppercase tracking-wider text-muted-foreground"
    >
      {label}
    </Label>
    <Select
      value={value || "__all"}
      onValueChange={(v) => onChange(v === "__all" ? "" : v)}
    >
      <SelectTrigger
        id={id}
        className="h-8 w-[180px] text-xs"
        aria-label={`Filter by ${label.toLowerCase()}`}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all">{placeholder}</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt}>
            {opt}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
);

// Minimal duck-typed shape for an Azure account record. The store-types
// AzureAccount also has subscriptionId/resourceGroup so we can build a
// portal deep-link from it. We accept `unknown` here because the Sheet
// shouldn't fail if the page is rendered before accounts have loaded.
interface PortalAccountLike {
  subscriptionId?: string;
  resourceGroup?: string;
  accountName?: string;
}

interface PoolDetailsSheetProps {
  pool: PoolInfo | null;
  focusedPoolId: string | null;
  /**
   * True while the orchestrator's initial refresh has not yet returned. Used
   * by the sheet to distinguish "data still loading" (show skeleton) from
   * "pool truly not in cache" (show EmptyState). Without this distinction,
   * a deep-linked `/pool-info/<id>` always painted "Pool not found" during
   * the few seconds between mount and the first orchestrator response.
   */
  loading?: boolean;
  nodesByPoolKey: Map<string, ManagedNode[]>;
  accountResourceId: PortalAccountLike | null;
  /** Pre-computed risk score + reasons for the focused pool (Wave 8). */
  risk: { score: number; reasons: string[] } | null;
  /** IMDS-pattern hits in the StartTask command line, if any. */
  imdsHits: ImdsHit[] | null;
  /** StartTask-failure ratio for the focused pool. */
  stuckStartTask: { failed: number; total: number; ratio: number } | null;
  /** Session-local node-count series for the sparkline (oldest first). */
  nodeCountHistory: number[] | null;
  onClose: () => void;
  onNavigateToNodes: (poolId: string) => void;
  onEditDefaults: () => void;
  onResize: () => void;
  onReboot: () => void;
  onDelete: () => void;
}

const NODE_STATE_BUCKETS: ReadonlyArray<{
  key: "running" | "idle" | "starting" | "unusable";
  label: string;
  states: NodeState[];
  className: string;
}> = [
  {
    key: "running",
    label: "Running",
    states: ["running"],
    className: "bg-success",
  },
  {
    key: "idle",
    label: "Idle",
    states: ["idle"],
    className: "bg-info",
  },
  {
    key: "starting",
    label: "Starting",
    states: [
      "creating",
      "starting",
      "waitingforstarttask",
      "rebooting",
      "reimaging",
      "leavingpool",
      "preempted",
    ],
    className: "bg-warning",
  },
  {
    key: "unusable",
    label: "Unusable",
    states: ["unusable", "starttaskfailed", "offline", "unknown"],
    className: "bg-destructive",
  },
];

/**
 * Build the Azure Portal blade URL for a Batch pool. Portal accepts a
 * resource id in the URL form #@/resource/subscriptions/.../pools/<poolId>.
 * Returns null if we lack enough info to build it.
 */
function buildPortalUrl(
  account: PortalAccountLike | null,
  poolId: string,
): string | null {
  if (
    !account ||
    !account.subscriptionId ||
    !account.resourceGroup ||
    !account.accountName
  ) {
    return null;
  }
  const armId = `/subscriptions/${account.subscriptionId}/resourceGroups/${account.resourceGroup}/providers/Microsoft.Batch/batchAccounts/${account.accountName}/pools/${poolId}`;
  return `https://portal.azure.com/#@/resource${armId}/overview`;
}

/** ARM resource id for copy/clipboard. */
function buildArmId(
  account: PortalAccountLike | null,
  poolId: string,
): string | null {
  if (
    !account ||
    !account.subscriptionId ||
    !account.resourceGroup ||
    !account.accountName
  ) {
    return null;
  }
  return `/subscriptions/${account.subscriptionId}/resourceGroups/${account.resourceGroup}/providers/Microsoft.Batch/batchAccounts/${account.accountName}/pools/${poolId}`;
}

const PoolDetailsSheet: React.FC<PoolDetailsSheetProps> = ({
  pool,
  focusedPoolId,
  loading = false,
  nodesByPoolKey,
  accountResourceId,
  risk,
  imdsHits,
  stuckStartTask,
  nodeCountHistory,
  onClose,
  onNavigateToNodes,
  onEditDefaults,
  onResize,
  onReboot,
  onDelete,
}) => {
  // Sheet is open whenever a poolId param is in the URL — even if the pool
  // hasn't been resolved yet (e.g. data still loading).
  const open = Boolean(focusedPoolId);

  const poolNodes = React.useMemo(
    () =>
      pool ? (nodesByPoolKey.get(`${pool.accountId}:${pool.poolId}`) ?? []) : [],
    [pool, nodesByPoolKey],
  );

  const breakdown = React.useMemo<NodeBreakdownBucket[]>(() => {
    if (!pool) return [];
    const counts = new Map<NodeState, number>();
    for (const node of poolNodes) {
      counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
    }
    return NODE_STATE_BUCKETS.map((bucket) => {
      let count = 0;
      for (const s of bucket.states) count += counts.get(s) ?? 0;
      return {
        key: bucket.key,
        label: bucket.label,
        count,
        className: bucket.className,
      };
    });
  }, [pool, poolNodes]);

  const totalKnownNodes = breakdown.reduce((s, b) => s + b.count, 0);
  const totalCurrentNodes = pool
    ? pool.currentDedicatedNodes + pool.currentLowPriorityNodes
    : 0;

  const runningTasks = React.useMemo(
    () => poolNodes.reduce((s, n) => s + (n.runningTasksCount ?? 0), 0),
    [poolNodes],
  );

  const portalUrl = pool ? buildPortalUrl(accountResourceId, pool.poolId) : null;
  const armId = pool ? buildArmId(accountResourceId, pool.poolId) : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent
        side="right"
        size="lg"
        className="flex flex-col"
        aria-label="Pool details"
      >
        <SheetHeader>
          <SheetTitle>
            <span className="group/copy inline-flex items-center gap-2">
              {pool ? pool.poolId : focusedPoolId}
              {pool && (
                <CopyButton
                  value={pool.poolId}
                  ariaLabel={`Copy pool id ${pool.poolId}`}
                  alwaysVisible
                />
              )}
            </span>
          </SheetTitle>
          <SheetDescription>
            {pool
              ? `${pool.accountName} · ${pool.region} · ${pool.vmSize}`
              : "Loading pool details..."}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4">
          {!pool ? (
            loading ? (
              // Orchestrator's first refresh hasn't returned yet — show a
              // skeleton so the deep-linked sheet doesn't flash "Pool not
              // found" before the cache populates.
              <SkeletonLoader variant="card" cards={3} />
            ) : (
              <EmptyState
                icon={Boxes}
                title="Pool not found"
                description={
                  focusedPoolId
                    ? `No pool with id "${focusedPoolId}" is in the current cache. Refresh to retry.`
                    : "Select a pool to inspect."
                }
              />
            )
          ) : (
            <>
              {/* Quick action toolbar in the Sheet — operator can act
                  without closing the sheet to use the bulk toolbar. */}
              <div
                className="flex flex-wrap gap-2"
                role="toolbar"
                aria-label="Pool actions"
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigateToNodes(pool.poolId)}
                  aria-label="View nodes for this pool"
                >
                  <Server className="h-3.5 w-3.5" />
                  View nodes
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onResize}
                  disabled={pool.allocationState !== "steady"}
                  title={
                    pool.allocationState !== "steady"
                      ? "Pool must be in steady state"
                      : "Resize this pool"
                  }
                  aria-label="Resize this pool"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  Resize
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onReboot}
                  aria-label="Reboot all nodes in this pool"
                >
                  <Power className="h-3.5 w-3.5" />
                  Reboot nodes
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onEditDefaults}
                  title="Open Pool Defaults with this pool's settings pre-filled"
                  aria-label="Edit Pool Defaults pre-filled from this pool"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  Edit defaults
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onDelete}
                  className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Delete this pool"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
                {portalUrl && (
                  <a
                    href={portalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent/40"
                    aria-label="Open this pool in the Azure Portal"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Azure Portal
                  </a>
                )}
              </div>

              {/* ARM resource id (copyable). Hidden when we can't form one. */}
              {armId && (
                <div className="rounded border border-border bg-surface-overlay p-2">
                  <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                    ARM resource id
                  </span>
                  <div className="mt-1">
                    <CopyableText value={armId} mono alwaysVisibleButton />
                  </div>
                </div>
              )}

              {/* Headline metadata */}
              <div className="grid grid-cols-2 gap-3">
                <DetailItem label="State" value={<StatusBadge status={pool.state} />} />
                <DetailItem
                  label="Allocation"
                  value={<StatusBadge status={pool.allocationState} />}
                />
                <DetailItem
                  label="Dedicated"
                  value={
                    <span className="tabular-nums text-sm">
                      <span className="text-info">
                        {pool.currentDedicatedNodes}
                      </span>
                      <span className="text-muted-foreground">
                        {" / "}
                        {pool.targetDedicatedNodes}
                      </span>
                    </span>
                  }
                />
                <DetailItem
                  label="Low priority"
                  value={
                    <span className="tabular-nums text-sm">
                      <span className="text-primary">
                        {pool.currentLowPriorityNodes}
                      </span>
                      <span className="text-muted-foreground">
                        {" / "}
                        {pool.targetLowPriorityNodes}
                      </span>
                    </span>
                  }
                />
                <DetailItem
                  label="Running tasks"
                  value={
                    <span
                      className={cn(
                        "tabular-nums text-sm",
                        runningTasks > 0
                          ? "font-medium text-success"
                          : "text-muted-foreground",
                      )}
                    >
                      {runningTasks}
                    </span>
                  }
                />
                <DetailItem
                  label="Slots/node"
                  value={
                    <span className="tabular-nums text-sm">
                      {pool.taskSlotsPerNode}
                    </span>
                  }
                />
                <DetailItem
                  label="Auto scale"
                  value={
                    <span className="inline-flex items-center gap-1 text-sm">
                      {pool.enableAutoScale ? (
                        <>
                          <Zap className="h-3.5 w-3.5 text-info" aria-hidden />
                          Enabled
                        </>
                      ) : (
                        "Disabled"
                      )}
                    </span>
                  }
                />
                <DetailItem
                  label="Created"
                  value={
                    <span className="text-xs text-muted-foreground">
                      {pool.creationTime
                        ? formatRelativeTime(pool.creationTime)
                        : "—"}
                    </span>
                  }
                />
                <DetailItem
                  label="Last modified"
                  value={
                    <span className="text-xs text-muted-foreground">
                      {pool.lastModified
                        ? formatRelativeTime(pool.lastModified)
                        : "—"}
                    </span>
                  }
                />
              </div>

              {/* Per-pool risk score + sparkline + defender notes.
                  The risk score is a composite signal (size × identity-tier ×
                  IMDS-shaped StartTask × stuck-StartTask × resize errors —
                  see `computePoolRiskScore` and `_analysis_netspi.md` § I).
                  The sparkline is *session-local* because the store's
                  `history` array is fleet-wide; we accumulate per-pool
                  samples in a ref during this page's lifetime. */}
              {(risk || (nodeCountHistory && nodeCountHistory.length > 1)) && (
                <section
                  className="flex items-center gap-4 rounded-md border border-border bg-card p-4"
                  aria-label="Pool risk and recent node-count trend"
                >
                  {risk && (
                    <div className="flex shrink-0 flex-col items-center">
                      <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                        Risk
                      </span>
                      <span
                        className={cn(
                          "mt-1 inline-flex h-9 min-w-[52px] items-center justify-center rounded px-2 text-base font-bold tabular-nums",
                          riskTone(risk.score) === "destructive" &&
                            "bg-destructive/15 text-destructive",
                          riskTone(risk.score) === "warning" &&
                            "bg-warning/15 text-warning",
                          riskTone(risk.score) === "info" &&
                            "bg-info/15 text-info",
                          riskTone(risk.score) === "success" &&
                            "bg-muted text-muted-foreground",
                        )}
                        aria-label={`Risk score ${risk.score} of 100`}
                      >
                        {risk.score}
                      </span>
                      <span className="mt-1 text-3xs text-muted-foreground">
                        / 100
                      </span>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    {nodeCountHistory && nodeCountHistory.length > 1 ? (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                            Node count (session)
                          </span>
                          <span className="text-2xs tabular-nums text-muted-foreground">
                            {nodeCountHistory[nodeCountHistory.length - 1]}{" "}
                            now · min{" "}
                            {Math.min(...nodeCountHistory)} · max{" "}
                            {Math.max(...nodeCountHistory)}
                          </span>
                        </div>
                        <Sparkline
                          data={nodeCountHistory}
                          width={240}
                          height={36}
                          tone={
                            riskTone(risk?.score ?? 0) === "destructive"
                              ? "destructive"
                              : "info"
                          }
                          ariaLabel={`Node-count trend over ${nodeCountHistory.length} samples this session`}
                          className="mt-1"
                        />
                      </>
                    ) : (
                      <span className="text-2xs italic text-muted-foreground">
                        Sparkline appears after the next node-count change this
                        session.
                      </span>
                    )}
                    {risk && risk.reasons.length > 0 && (
                      <ul className="m-0 mt-2 flex list-disc flex-col gap-0.5 pl-4">
                        {risk.reasons.map((reason, i) => (
                          <li
                            key={i}
                            className="text-2xs text-foreground/80"
                          >
                            {reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              )}

              {/* Defender notes — corpus-grounded heuristic findings the
                  operator should triage. Currently surfaces:
                    1) IMDS-shaped StartTask command lines (per
                       `_analysis_netspi.md` § I — Batch nodes use the
                       classic VM IMDS endpoint `169.254.169.254` to mint
                       identity tokens, so a StartTask hitting that path
                       can be either legitimate auth bootstrap or
                       identity-exfil shaped).
                    2) Stuck StartTask (high failure ratio across nodes —
                       not a security issue per se, but a pool whose
                       StartTask continues to fail on many nodes is a
                       likely indicator of misconfigured credentials,
                       network egress restriction, or a malformed
                       command line). */}
              {(imdsHits && imdsHits.length > 0) ||
              (stuckStartTask && stuckStartTask.ratio > 0.25 && stuckStartTask.failed >= 2) ? (
                <section
                  className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-4"
                  aria-label="Defender notes"
                >
                  <h2 className="m-0 flex items-center gap-2 text-base font-semibold text-warning">
                    <ShieldAlert className="h-4 w-4" aria-hidden />
                    Defender notes
                  </h2>
                  {imdsHits && imdsHits.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-foreground">
                        StartTask touches the instance metadata service
                      </span>
                      <span className="text-2xs text-muted-foreground">
                        Batch nodes expose the classic VM IMDS at{" "}
                        <code className="rounded bg-muted px-1">
                          169.254.169.254
                        </code>
                        . If the pool has a managed identity, this command
                        line can mint ARM tokens. Verify the workload is
                        intentional. Source: <code>_analysis_netspi.md</code> §
                        I.
                      </span>
                      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
                        {imdsHits.map((hit, i) => (
                          <li key={i} className="text-2xs">
                            <span className="font-medium text-foreground">
                              {hit.reason}
                            </span>
                            <span className="ml-1 break-all font-mono text-muted-foreground">
                              {hit.snippet}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {stuckStartTask &&
                    stuckStartTask.ratio > 0.25 &&
                    stuckStartTask.failed >= 2 && (
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-foreground">
                          StartTask is failing across most nodes
                        </span>
                        <span className="text-2xs text-muted-foreground">
                          {stuckStartTask.failed} of {stuckStartTask.total}{" "}
                          known nodes are in{" "}
                          <code className="rounded bg-muted px-1">
                            starttaskfailed
                          </code>{" "}
                          ({Math.round(stuckStartTask.ratio * 100)}%). The pool
                          will keep churning nodes until the start task either
                          succeeds or is updated. Use{" "}
                          <b>Update Start Task</b> from the bulk toolbar to fix
                          the command and tick{" "}
                          <i>Reboot all nodes after update</i>.
                        </span>
                      </div>
                    )}
                </section>
              ) : null}

              {/* Node-state breakdown chart */}
              <section
                className="flex flex-col gap-2 rounded-md border border-border bg-card p-4"
                aria-label="Node state breakdown"
              >
                <div className="flex items-center justify-between">
                  <h2 className="m-0 text-base font-semibold text-foreground">
                    Node states
                  </h2>
                  <span className="text-2xs tabular-nums text-muted-foreground/70">
                    {totalKnownNodes} of {totalCurrentNodes} nodes known
                  </span>
                </div>
                <NodeStateBreakdown
                  buckets={breakdown}
                  totalCurrentNodes={totalCurrentNodes}
                />
              </section>

              {/* Top nodes (first 10) — quick at-a-glance view of which
                  nodes are in which state, with copyable node id. */}
              {poolNodes.length > 0 && (
                <section
                  className="flex flex-col gap-2 rounded-md border border-border bg-card p-4"
                  aria-label="Pool nodes"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="m-0 text-base font-semibold text-foreground">
                      Nodes ({poolNodes.length})
                    </h2>
                    <button
                      type="button"
                      className="text-2xs text-primary hover:underline"
                      onClick={() => onNavigateToNodes(pool.poolId)}
                    >
                      View all in Nodes page →
                    </button>
                  </div>
                  <ul className="m-0 flex flex-col gap-1 p-0">
                    {poolNodes.slice(0, 10).map((n) => (
                      <li
                        key={n.id}
                        className="group/copy flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent/30"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <StatusBadge status={n.state} />
                          <span
                            className="truncate font-mono text-xs text-foreground"
                            title={n.nodeId}
                          >
                            {n.nodeId}
                          </span>
                          <CopyButton
                            value={n.nodeId}
                            ariaLabel={`Copy node id ${n.nodeId}`}
                          />
                        </span>
                        <span className="text-2xs tabular-nums text-muted-foreground">
                          {n.runningTasksCount ?? 0} running
                        </span>
                      </li>
                    ))}
                  </ul>
                  {poolNodes.length > 10 && (
                    <span className="text-2xs italic text-muted-foreground">
                      and {poolNodes.length - 10} more...
                    </span>
                  )}
                </section>
              )}

              {/* Autoscale formula */}
              {pool.enableAutoScale && pool.autoScaleFormula && (
                <section
                  className="flex flex-col gap-2 rounded-md border border-border bg-card p-4"
                  aria-label="Autoscale formula"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="m-0 text-base font-semibold text-foreground">
                      Autoscale formula
                    </h2>
                    <CopyButton
                      value={pool.autoScaleFormula}
                      ariaLabel="Copy autoscale formula"
                      alwaysVisible
                    />
                  </div>
                  <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-overlay p-3 font-mono text-xs text-foreground">
                    {pool.autoScaleFormula}
                  </pre>
                </section>
              )}

              {/* Start task summary */}
              {pool.startTask &&
                typeof pool.startTask.commandLine === "string" && (
                  <section
                    className="flex flex-col gap-2 rounded-md border border-border bg-card p-4"
                    aria-label="Start task"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="m-0 text-base font-semibold text-foreground">
                        Start task
                      </h2>
                      <CopyButton
                        value={pool.startTask.commandLine as string}
                        ariaLabel="Copy start task command line"
                        alwaysVisible
                      />
                    </div>
                    <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface-overlay p-3 font-mono text-xs text-foreground">
                      {pool.startTask.commandLine as string}
                    </pre>
                  </section>
                )}

              {/* Resize errors */}
              {pool.resizeErrors && pool.resizeErrors.length > 0 && (
                <section
                  className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-4"
                  aria-label="Resize errors"
                >
                  <h2 className="m-0 flex items-center gap-2 text-base font-semibold text-destructive">
                    <TriangleAlert className="h-4 w-4" aria-hidden />
                    Resize errors ({pool.resizeErrors.length})
                  </h2>
                  <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                    {pool.resizeErrors.map((msg, i) => (
                      <li key={i} className="text-xs text-destructive">
                        {msg}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </SheetBody>
        <SheetFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            aria-label="Close pool details"
          >
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

interface NodeStateBreakdownProps {
  buckets: NodeBreakdownBucket[];
  totalCurrentNodes: number;
}

const NodeStateBreakdown: React.FC<NodeStateBreakdownProps> = ({
  buckets,
  totalCurrentNodes,
}) => {
  const denominator = Math.max(
    1,
    totalCurrentNodes,
    buckets.reduce((s, b) => s + b.count, 0),
  );

  return (
    <div
      className="flex flex-col gap-2"
      role="img"
      aria-label="Node state breakdown chart"
    >
      {buckets.map((b) => {
        const pct = (b.count / denominator) * 100;
        return (
          <div
            key={b.key}
            className="flex items-center gap-3"
            aria-label={`${b.label}: ${b.count}`}
          >
            <span className="w-20 shrink-0 text-xs font-medium text-foreground">
              {b.label}
            </span>
            <div className="relative h-2.5 flex-1 overflow-hidden rounded-sm bg-muted">
              <div
                className={cn(
                  "h-full transition-all duration-200 ease-out motion-reduce:transition-none",
                  b.className,
                )}
                style={{ width: `${pct}%` }}
                aria-hidden
              />
            </div>
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-foreground">
              {formatNumber(b.count)}
            </span>
          </div>
        );
      })}
    </div>
  );
};

interface DetailItemProps {
  label: string;
  value: React.ReactNode;
}

const DetailItem: React.FC<DetailItemProps> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
      {label}
    </span>
    <span className="text-sm text-foreground">{value}</span>
  </div>
);
