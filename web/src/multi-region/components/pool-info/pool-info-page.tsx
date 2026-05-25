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
];

// Token-fresh threshold — below this, resize is blocked because mid-call
// expiry can leave the orchestrator unable to mint a fresh per-account
// token before the request lands.
const TOKEN_RESIZE_BLOCK_SECONDS = 60;

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
        description="Inspect, resize, and manage Batch pools across regions. Press R to refresh, Esc to clear selection, Delete to delete selected pools."
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
          onClick={refresh}
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
          <span className="text-xs font-medium text-foreground">
            {selectedPools.length} pool{selectedPools.length === 1 ? "" : "s"}{" "}
            selected
          </span>
          <span className="text-2xs text-muted-foreground">
            ({selectedRunningTasks} running task
            {selectedRunningTasks === 1 ? "" : "s"})
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
              title={`Reboot all nodes in ${selectedPools.length} pool${selectedPools.length === 1 ? "" : "s"}`}
              aria-label="Reboot all nodes in selected pools"
            >
              <Power className="h-3.5 w-3.5" />
              Reboot Nodes
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
        onClose={closeFocusedSheet}
        onNavigateToNodes={(poolId) =>
          navigate(`/nodes?pool=${encodeURIComponent(poolId)}`)
        }
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
  onClose: () => void;
  onNavigateToNodes: (poolId: string) => void;
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
  onClose,
  onNavigateToNodes,
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
