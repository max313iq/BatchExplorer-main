/**
 * Nodes page — multi-region compute-node browser with bulk reboot/reimage/
 * delete/recreate, faceted filters synced to the URL, and DataTable rendering.
 */
import * as React from "react";
import {
  AlertTriangle,
  Check,
  CircleSlash,
  ClipboardList,
  Copy,
  Download,
  FileJson,
  Heart,
  Loader2,
  Pause,
  Play,
  Plug,
  RefreshCcw,
  RotateCw,
  Server,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ErrorState } from "@/components/ui/error-state";
import { Donut, DonutLegend, type DonutSegment } from "@/components/ui/charts/donut";
import { MiniBar, type MiniBarItem } from "@/components/ui/charts/gauge";
import {
  cn,
  compareNumbers,
  compareStrings,
  downloadCsv,
  downloadJson,
  formatNumber,
  formatRelativeTime,
} from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { getBatchTokenForAccount } from "../../auth/msal-auth";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { useSearch } from "../../hooks/use-search";
import { useUrlState } from "../../hooks/use-url-state";
import {
  type BatchNodeRemoteLoginSettings,
  createNodeUser,
  getNodeRemoteLoginSettings,
} from "../../services";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState } from "../../store/store-context";
import { ManagedNode, NodeState } from "../../store/store-types";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import {
  DataTable,
  type DataTableColumn,
} from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { PageHeader } from "../shared/page-header";
import { StatusBadge } from "../shared/status-badge";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import {
  BorderBeam,
  DotPattern,
  Meteors,
  NumberTicker,
} from "@/components/ui/effects";
// LiveVmSizeSelect import removed — picker was architecturally
// redundant on this page (see comment in the toolbar JSX).

export interface NodesPageProps {
  orchestrator: OrchestratorAgent;
}

const ALL_NODE_STATES: NodeState[] = [
  "idle",
  "running",
  "creating",
  "leavingpool",
  "rebooting",
  "reimaging",
  "starting",
  "starttaskfailed",
  "unknown",
  "unusable",
  "offline",
  "waitingforstarttask",
  "preempted",
];

const ERROR_STATES: Set<NodeState> = new Set([
  "starttaskfailed",
  "unusable",
  "unknown",
]);

/**
 * Transitional NodeStates. A node legitimately sits in one of these
 * states for a short window during pool ramp-up, reboot, reimage, or
 * scale-down. If a node lingers in a transitional state for longer than
 * STUCK_TRANSITIONAL_THRESHOLD_MS we flag it as "stuck" — typically a
 * symptom of a hung start-task, networking issue, or back-end deadlock,
 * and almost always resolvable by reimage or recreate.
 */
const TRANSITIONAL_STATES: Set<NodeState> = new Set([
  "creating",
  "starting",
  "rebooting",
  "reimaging",
  "leavingpool",
  "waitingforstarttask",
]);

/**
 * Actionable states for bulk reboot/reimage/disable/enable. Anything
 * outside this set will be skipped by the orchestrator anyway (see
 * `_bulkNodeAction`), so we pre-filter selection so the operator sees
 * an accurate count, an explanatory tooltip, and no surprise "0 of N
 * skipped" toasts.
 */
const ACTIONABLE_STATES: Set<NodeState> = new Set([
  "idle",
  "running",
  "starttaskfailed",
  "rebooting",
  "reimaging",
  "offline",
]);

type NodeActionType =
  | "reboot"
  | "delete"
  | "reimage"
  | "disableScheduling"
  | "enableScheduling";

type PriorityFilter = "" | "dedicated" | "lowpriority";

type QuickFilterKey =
  | "all"
  | "running"
  | "idle"
  | "transitioning"
  | "preempted"
  | "errors"
  | "stuck";

const AUTO_REFRESH_INTERVAL_MS = 30_000;
const AUTO_RECOVERY_INTERVAL_MS = 60_000;

/** Threshold past which a "transitioning" node is considered stuck. */
const STUCK_TRANSITIONAL_THRESHOLD_MS = 15 * 60 * 1000;

interface BulkActionResult {
  label: string;
  succeeded: number;
  failed: number;
  failedIds: string[];
}

interface ConfirmDialogState {
  hidden: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
  onConfirm: () => void | Promise<void>;
}

const INITIAL_FILTERS: {
  region: string;
  state: string;
  pool: string;
  priority: PriorityFilter;
  vmSize: string;
} = {
  region: "",
  state: "",
  pool: "",
  priority: "",
  vmSize: "",
};

const DESTRUCTIVE_ACTIONS: Set<NodeActionType> = new Set([
  "reboot",
  "reimage",
  "delete",
  "disableScheduling",
]);

const ACTION_LABELS: Record<NodeActionType, string> = {
  reboot: "reboot",
  reimage: "reimage",
  delete: "delete",
  disableScheduling: "disable scheduling on",
  enableScheduling: "enable scheduling on",
};

const HIDDEN_DIALOG: ConfirmDialogState = {
  hidden: true,
  title: "",
  description: "",
  confirmLabel: "Confirm",
  destructive: false,
  onConfirm: () => {},
};

const NodesPageInner: React.FC<NodesPageProps> = ({ orchestrator }) => {
  const state = useMultiRegionState();
  const [isLoading, setIsLoading] = React.useState(false);
  const [isActing, setIsActing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [bulkResult, setBulkResult] = React.useState<BulkActionResult | null>(
    null,
  );
  const [bulkProgressMessage, setBulkProgressMessage] = React.useState<
    string | null
  >(null);
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [autoRecovery, setAutoRecovery] = React.useState(false);
  const [selection, setSelection] = React.useState<Set<string>>(new Set());

  /** Wall-clock timestamp of the most recent successful list_nodes. The
   * toolbar shows "Refreshed Xs ago" so the operator can tell at a glance
   * whether the table is stale — critical when the page is being used as
   * a live fleet HUD while an auto-recovery loop is running. */
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<number | null>(
    null,
  );

  /** Recompute "X ago" labels at 1 Hz without subscribing to state.nodes. */
  const [, setNowTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  /** Quick filter chip — fast scope on top of the URL-synced facet filters.
   * Stored locally (not URL) because it's a one-tap UX shortcut, not a
   * shareable view. Reset on full filter clear. */
  const [quickFilter, setQuickFilter] = React.useState<QuickFilterKey>("all");

  /** Caller-friendly "copied selected node IDs" pulse for the toolbar. */
  const [copiedSelected, setCopiedSelected] = React.useState(false);
  React.useEffect(() => {
    if (!copiedSelected) return;
    const t = setTimeout(() => setCopiedSelected(false), 1500);
    return () => clearTimeout(t);
  }, [copiedSelected]);

  // ---- URL-synced facets per Contract §4.3 ----------------------------------
  const [filters, setFilters] = useUrlState(INITIAL_FILTERS, { replace: true });
  const regionFilter = filters.region;
  const stateFilter = filters.state;
  const poolFilter = filters.pool;
  const priorityFilter = (filters.priority as PriorityFilter) ?? "";
  const vmSizeFilter = filters.vmSize ?? "";

  // ---- Confirmation dialog state -------------------------------------------
  const [confirmDialog, setConfirmDialog] =
    React.useState<ConfirmDialogState>(HIDDEN_DIALOG);

  const dismissConfirmDialog = React.useCallback(() => {
    setConfirmDialog((prev) => ({ ...prev, hidden: true }));
  }, []);

  const showConfirmation = React.useCallback(
    (
      title: string,
      description: string,
      confirmLabel: string,
      destructive: boolean,
      onConfirm: () => void | Promise<void>,
    ) => {
      setConfirmDialog({
        hidden: false,
        title,
        description,
        confirmLabel,
        destructive,
        onConfirm,
      });
    },
    [],
  );

  // ---- Created accounts and unique facet options ---------------------------
  const createdAccounts = React.useMemo(
    () => state.accounts.filter((a) => a.provisioningState === "created"),
    [state.accounts],
  );

  // ---- Primary MSAL identity for the token-expiry badge --------------------
  // This page mints BATCH tokens per Connect click (each via the MSAL
  // identity that owns that specific Batch sub — see handleConnectNode),
  // so there is no single page-level ARM-token state to keep in sync.
  // The badge here is purely a freshness HUD for the operator: pick the
  // MSAL account that owns the first created Batch account's sub as a
  // representative "primary" — auto-refresh logic in useArmToken is
  // identity-scoped, so a fresh ARM token for this identity is a good
  // proxy for "my MSAL session is still alive". On tenant-switch the
  // hook re-mints automatically, so the badge follows the active tenant.
  const primaryAccount = React.useMemo(() => {
    const first = createdAccounts[0];
    if (!first) return undefined;
    const sub = state.subscriptions.find(
      (s) => s.subscriptionId === first.subscriptionId,
    );
    if (!sub?.homeAccountId) return undefined;
    return { homeAccountId: sub.homeAccountId, tenantId: sub.tenantId };
  }, [createdAccounts, state.subscriptions]);
  const armTokenTracker = useArmToken(
    primaryAccount?.homeAccountId,
    primaryAccount?.tenantId,
  );

  const regionOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const n of state.nodes) set.add(n.region);
    return Array.from(set).sort(compareStrings);
  }, [state.nodes]);

  const poolOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const n of state.nodes) set.add(n.poolId);
    return Array.from(set).sort(compareStrings);
  }, [state.nodes]);

  // ---- Auto-load nodes on mount --------------------------------------------
  // Uses `useAbortableEffect` so the orchestrator's underlying ARM round-
  // trips get a real `AbortSignal` and the agent can short-circuit when
  // the operator navigates away mid-load.
  const autoLoadedRef = React.useRef(false);
  useAbortableEffect(
    async (signal) => {
      if (autoLoadedRef.current) return;
      if (createdAccounts.length === 0 || state.nodes.length > 0) return;
      autoLoadedRef.current = true;
      setIsLoading(true);
      setError(null);
      try {
        await orchestrator.execute({
          action: "list_nodes",
          payload: { accountIds: createdAccounts.map((a) => a.id) },
          signal,
        });
        if (!signal.aborted) setLastRefreshedAt(Date.now());
      } catch (err: unknown) {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        if (!signal.aborted) setIsLoading(false);
      }
    },
    [createdAccounts, state.nodes.length, orchestrator],
  );

  // ---- Refresh handler ------------------------------------------------------
  const handleRefreshNodes = React.useCallback(async () => {
    if (createdAccounts.length === 0) return;
    setIsLoading(true);
    setError(null);
    try {
      await orchestrator.execute({
        action: "list_nodes",
        payload: { accountIds: createdAccounts.map((a) => a.id) },
      });
      setLastRefreshedAt(Date.now());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [orchestrator, createdAccounts]);

  // ---- Auto-refresh timer ---------------------------------------------------
  React.useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      handleRefreshNodes();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [autoRefresh, handleRefreshNodes]);

  // ---- Auto-recovery timer --------------------------------------------------
  // Read `state.nodes` through a ref so the 60s interval is set up once per
  // toggle change — not torn down and re-created on every list_nodes refresh
  // (which would prevent the interval from ever actually firing, since
  // `state.nodes` updates more frequently than the recovery cadence).
  //
  // In-flight guard: if a recovery call is still pending when the next
  // 60s tick fires (e.g. recover_preempted is slow because it has to mint
  // ARM tokens for several subs), we skip the new tick rather than
  // stacking concurrent calls — overlapping recover_preempted runs can
  // race on pool-target updates and double-bill capacity.
  const nodesRef = React.useRef(state.nodes);
  nodesRef.current = state.nodes;
  React.useEffect(() => {
    if (!autoRecovery) return;
    let cancelled = false;
    let recoveryInFlight = false;
    const interval = setInterval(async () => {
      if (cancelled || recoveryInFlight) return;
      const preempted = nodesRef.current.filter((n) => n.state === "preempted");
      if (preempted.length === 0) return;
      recoveryInFlight = true;
      const count = preempted.length;
      try {
        await orchestrator.execute({
          action: "recover_preempted",
          payload: {},
        });
        if (cancelled) return;
        auditLog.record({
          actor: primaryAccount?.homeAccountId ?? "auto-recovery",
          action: "recover_preempted",
          target: `${count} preempted node(s)`,
          status: "success",
          details: { triggeredBy: "auto-recovery", count },
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        auditLog.record({
          actor: primaryAccount?.homeAccountId ?? "auto-recovery",
          action: "recover_preempted",
          target: `${count} preempted node(s)`,
          status: "failure",
          error: message,
          details: { triggeredBy: "auto-recovery", count },
        });
      } finally {
        recoveryInFlight = false;
      }
    }, AUTO_RECOVERY_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [autoRecovery, orchestrator, primaryAccount]);

  /**
   * Stuck-node detector — a node lingering in a transitional state past
   * STUCK_TRANSITIONAL_THRESHOLD_MS. We treat `lastBootTime` as the most
   * recent state-change anchor (it's the closest we get without a per-
   * transition timestamp). When absent, we fall back to "no info" and
   * EXCLUDE the node from the stuck set rather than flag a false-positive.
   */
  const stuckNodes = React.useMemo(() => {
    const now = Date.now();
    return state.nodes
      .filter((n) => {
        if (!TRANSITIONAL_STATES.has(n.state)) return false;
        if (!n.lastBootTime) return false;
        const age = now - new Date(n.lastBootTime).getTime();
        return age >= STUCK_TRANSITIONAL_THRESHOLD_MS;
      })
      .sort((a, b) => {
        const ta = new Date(a.lastBootTime ?? 0).getTime();
        const tb = new Date(b.lastBootTime ?? 0).getTime();
        return ta - tb;
      });
    // We intentionally depend ONLY on state.nodes so this doesn't recompute
    // every second. Recomputation cadence is governed by the parent now-tick
    // re-render — the function captures `Date.now()` fresh each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nodes]);

  const stuckIdSet = React.useMemo(
    () => new Set(stuckNodes.map((n) => n.id)),
    [stuckNodes],
  );

  // ---- Filtered nodes (URL filters first, then quick filter, then text) ---
  const filteredByFacets = React.useMemo(() => {
    let nodes = state.nodes;
    if (regionFilter) nodes = nodes.filter((n) => n.region === regionFilter);
    if (stateFilter) nodes = nodes.filter((n) => n.state === stateFilter);
    if (poolFilter) nodes = nodes.filter((n) => n.poolId === poolFilter);
    if (priorityFilter === "dedicated") {
      nodes = nodes.filter((n) => n.isDedicated);
    } else if (priorityFilter === "lowpriority") {
      nodes = nodes.filter((n) => !n.isDedicated);
    }
    if (vmSizeFilter) {
      // Compare case-insensitively — Azure mixes Standard_NC24s_v3 with
      // standard_nc24s_v3 across endpoints.
      const target = vmSizeFilter.toLowerCase();
      nodes = nodes.filter(
        (n) => (n.vmSize ?? "").toLowerCase() === target,
      );
    }
    // Quick filter — applied on top of all faceted filters. Each chip is
    // a single-tap shortcut, NOT a replacement for the state Select.
    switch (quickFilter) {
      case "running":
        nodes = nodes.filter((n) => n.state === "running");
        break;
      case "idle":
        nodes = nodes.filter((n) => n.state === "idle");
        break;
      case "transitioning":
        nodes = nodes.filter((n) => TRANSITIONAL_STATES.has(n.state));
        break;
      case "preempted":
        nodes = nodes.filter((n) => n.state === "preempted");
        break;
      case "errors":
        nodes = nodes.filter((n) => ERROR_STATES.has(n.state));
        break;
      case "stuck":
        nodes = nodes.filter((n) => stuckIdSet.has(n.id));
        break;
      case "all":
      default:
        break;
    }
    return nodes;
  }, [
    state.nodes,
    regionFilter,
    stateFilter,
    poolFilter,
    priorityFilter,
    vmSizeFilter,
    quickFilter,
    stuckIdSet,
  ]);

  // Memoize the field array so `useSearch`'s internal `useMemo` keyed on it
  // doesn't recompute the filter on every render — without this, every
  // unrelated state update (toggle flip, selection tick) re-runs the
  // search filter across every node. With thousands of nodes this is
  // measurable; with tens it's still wasted work.
  const SEARCH_FIELDS = React.useMemo<(keyof ManagedNode)[]>(
    () => [
      "id",
      "nodeId",
      "poolId",
      "accountName",
      "region",
      "vmSize",
      "ipAddress",
      "state",
    ],
    [],
  );
  const search = useSearch<ManagedNode>(filteredByFacets, SEARCH_FIELDS);
  const visibleNodes = search.filteredItems;

  // ---- Summary stats --------------------------------------------------------
  const summaryStats = React.useMemo(() => {
    const nodes = state.nodes;
    let transitioning = 0;
    let totalRunningTasks = 0;
    for (const n of nodes) {
      if (TRANSITIONAL_STATES.has(n.state)) transitioning++;
      totalRunningTasks += n.runningTasksCount ?? 0;
    }
    return {
      total: nodes.length,
      running: nodes.filter((n) => n.state === "running").length,
      idle: nodes.filter((n) => n.state === "idle").length,
      preempted: nodes.filter((n) => n.state === "preempted").length,
      creating: nodes.filter((n) => n.state === "creating").length,
      transitioning,
      errors: nodes.filter((n) => ERROR_STATES.has(n.state)).length,
      stuck: stuckNodes.length,
      runningTasks: totalRunningTasks,
    };
  }, [state.nodes, stuckNodes.length]);

  // ---- Insights (donut + idle detector + VM-size mini-bar) ---------------

  /**
   * State-distribution donut data. Buckets fine-grained NodeStates into the
   * five canonical tones so the donut stays legible. Order is intentional:
   * Running first (most common), then transitional, then steady-state idle,
   * then warning conditions, then errors.
   */
  const nodeStateDonut = React.useMemo<DonutSegment[]>(() => {
    const nodes = state.nodes;
    const errors = nodes.filter((n) => ERROR_STATES.has(n.state)).length;
    const transitioning = nodes.filter(
      (n) =>
        n.state === "creating" ||
        n.state === "starting" ||
        n.state === "rebooting" ||
        n.state === "reimaging" ||
        n.state === "leavingpool" ||
        n.state === "waitingforstarttask",
    ).length;
    return [
      {
        label: "Running",
        value: nodes.filter((n) => n.state === "running").length,
        tone: "success",
      },
      {
        label: "Idle",
        value: nodes.filter((n) => n.state === "idle").length,
        tone: "info",
      },
      {
        label: "Transitioning",
        value: transitioning,
        tone: "warning",
      },
      {
        label: "Preempted",
        value: nodes.filter((n) => n.state === "preempted").length,
        tone: "muted",
      },
      {
        label: "Errors",
        value: errors,
        tone: "destructive",
      },
    ];
  }, [state.nodes]);

  /**
   * Idle-node detector. A node is "idle waste" when:
   *   - state === "idle"
   *   - runningTasksCount is 0 (or undefined)
   *   - it has been booted for at least 30 minutes (lastBootTime old)
   * Sort by oldest boot first (most wasteful first).
   *
   * Output is capped at 8 entries; UI shows "+ N more" if exceeded.
   */
  const idleWasteThresholdMs = 30 * 60 * 1000;
  const idleWasteNodes = React.useMemo(() => {
    const now = Date.now();
    return state.nodes
      .filter(
        (n) =>
          n.state === "idle" &&
          (n.runningTasksCount ?? 0) === 0 &&
          n.lastBootTime &&
          now - new Date(n.lastBootTime).getTime() >= idleWasteThresholdMs,
      )
      .sort((a, b) => {
        const ta = new Date(a.lastBootTime ?? 0).getTime();
        const tb = new Date(b.lastBootTime ?? 0).getTime();
        return ta - tb;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nodes]);

  /**
   * VM-size frequency. Top 8 sizes by count. Ranks by descending count so
   * the most common sizes are visible first. NodeState is not factored in —
   * the user wants to know "what fleet do I have," not "what's running".
   */
  const vmSizeBars = React.useMemo<MiniBarItem[]>(() => {
    const counts = new Map<string, number>();
    for (const n of state.nodes) {
      const key = n.vmSize ?? "(unknown)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label, value, tone: "primary" as const }));
  }, [state.nodes]);

  // ---- Reset selection when the underlying set shrinks beyond what's selected
  React.useEffect(() => {
    if (selection.size === 0) return;
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of selection) {
      if (visibleIds.has(id)) {
        next.add(id);
      } else {
        changed = true;
      }
    }
    if (changed) setSelection(next);
  }, [visibleNodes, selection]);

  // ---- Bulk action result helper -------------------------------------------
  const computeBulkResult = React.useCallback(
    (label: string, attemptedIds: string[]): BulkActionResult => {
      const failedIds: string[] = [];
      for (const id of attemptedIds) {
        const node = state.nodes.find((n) => n.id === id);
        if (node && ERROR_STATES.has(node.state)) {
          failedIds.push(id);
        }
      }
      return {
        label,
        succeeded: attemptedIds.length - failedIds.length,
        failed: failedIds.length,
        failedIds,
      };
    },
    [state.nodes],
  );

  const selectedIds = React.useMemo(() => Array.from(selection), [selection]);

  /**
   * Live snapshot of the selected nodes. Re-derives from the store on
   * every render so we never operate on a stale view. If a node has
   * disappeared from the store between selection and action, it's
   * silently dropped here — same semantics as the orchestrator side.
   */
  const selectedNodes = React.useMemo(() => {
    const map = new Map<string, ManagedNode>();
    for (const n of state.nodes) map.set(n.id, n);
    const out: ManagedNode[] = [];
    for (const id of selectedIds) {
      const n = map.get(id);
      if (n) out.push(n);
    }
    return out;
  }, [selectedIds, state.nodes]);

  /**
   * Pre-flight: filter the selection to only nodes the orchestrator
   * will actually act on. Mirrors the orchestrator's own
   * `_bulkNodeAction` skip rules so the operator sees an accurate
   * actionable count up front and the confirmation prompt doesn't lie
   * ("N nodes" then "0 actioned" because they were all `creating`).
   */
  const filterActionable = React.useCallback(
    (action: NodeActionType, nodes: ManagedNode[]): ManagedNode[] => {
      if (action === "delete") {
        // Delete is allowed in any state via removeNodes — orchestrator
        // calls the pool-level "remove nodes" op, not per-node DELETE.
        return nodes;
      }
      return nodes.filter((n) => ACTIONABLE_STATES.has(n.state));
    },
    [],
  );

  // ---- Generic bulk-action handler -----------------------------------------
  // Idempotency note: reboot / reimage / enable/disable scheduling all use
  // the Batch API's per-node endpoints which are idempotent at the Azure
  // level — re-firing reboot on a node already rebooting is a no-op (the
  // service returns 202 and continues the current reboot). Delete is
  // idempotent via the pool-level remove-nodes call: deleting a node that
  // already left the pool returns 404 which the orchestrator treats as
  // "succeeded". Safe to spam Retry without compounding side-effects.
  const handleNodeAction = React.useCallback(
    async (action: NodeActionType) => {
      if (selectedNodes.length === 0) return;
      const label = ACTION_LABELS[action];
      const verbCap = label.charAt(0).toUpperCase() + label.slice(1);

      const actionable = filterActionable(action, selectedNodes);
      const ids = actionable.map((n) => n.id);
      const skippedCount = selectedNodes.length - ids.length;

      if (ids.length === 0) {
        setError(
          `None of the ${formatNumber(selectedNodes.length)} selected node(s) can accept "${label}" right now — all are in non-actionable states.`,
        );
        return;
      }

      const executeAction = async () => {
        setIsActing(true);
        setError(null);
        setBulkResult(null);
        setBulkProgressMessage(
          `${label} starting on ${formatNumber(ids.length)} node${
            ids.length === 1 ? "" : "s"
          }${
            skippedCount > 0 ? ` (${formatNumber(skippedCount)} skipped)` : ""
          }...`,
        );
        const actor = primaryAccount?.homeAccountId ?? "ui";
        try {
          await orchestrator.execute({
            action: "bulk_node_action",
            payload: { actionType: action, nodeIds: ids },
          });
          const result = computeBulkResult(label, ids);
          setBulkResult(result);
          auditLog.record({
            actor,
            action: `bulk_${action}`,
            target: `${ids.length} node(s)`,
            status: result.failed === 0 ? "success" : "failure",
            details: {
              attempted: ids.length,
              succeeded: result.succeeded,
              failed: result.failed,
              skippedPreflight: skippedCount,
              sampleIds: ids.slice(0, 16),
            },
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setBulkResult({
            label,
            succeeded: 0,
            failed: ids.length,
            failedIds: ids.slice(0, 10),
          });
          auditLog.record({
            actor,
            action: `bulk_${action}`,
            target: `${ids.length} node(s)`,
            status: "failure",
            error: message,
            details: { attempted: ids.length },
          });
        } finally {
          setIsActing(false);
          setBulkProgressMessage(null);
        }
      };

      if (DESTRUCTIVE_ACTIONS.has(action)) {
        const detail =
          action === "delete"
            ? "This action cannot be undone."
            : action === "reimage"
              ? "Running tasks will be requeued and the OS disk will be restored from the source image."
              : action === "reboot"
                ? "Affected nodes will restart. Running tasks will be requeued."
                : "Pending and running tasks finish; the node won't accept new work until scheduling is re-enabled.";
        const skipNote =
          skippedCount > 0
            ? ` ${formatNumber(skippedCount)} selected node(s) will be skipped because they are in a non-actionable state.`
            : "";
        showConfirmation(
          `${verbCap} ${formatNumber(ids.length)} node${ids.length === 1 ? "" : "s"}?`,
          `${detail}${skipNote}`,
          verbCap,
          true,
          executeAction,
        );
      } else {
        await executeAction();
      }
    },
    [
      orchestrator,
      selectedNodes,
      filterActionable,
      showConfirmation,
      computeBulkResult,
      primaryAccount,
    ],
  );

  // ---- Connect to compute node (SSH / RDP) ---------------------------------
  // Two-step flow per https://learn.microsoft.com/azure/batch/pool-endpoint-configuration:
  //   1. POST /pools/{poolId}/nodes/{nodeId}/users — create a short-lived
  //      user with a generated password. Default expiry: now + 24 h.
  //   2. GET  /pools/{poolId}/nodes/{nodeId}/remoteloginsettings — IP+port
  //      for the connection.
  // Dialog surfaces the ready-to-paste connection command (ssh on Linux,
  // mstsc on Windows). The temp user auto-expires; the operator never
  // has to clean up manually unless they kept the dialog open past 24 h.
  const [connectDialog, setConnectDialog] = React.useState<{
    open: boolean;
    node: ManagedNode | null;
    state:
      | "idle"
      | "provisioning"
      | "ready"
      | "error";
    error: string | null;
    username: string;
    password: string;
    isWindows: boolean;
    settings: BatchNodeRemoteLoginSettings | null;
  }>({
    open: false,
    node: null,
    state: "idle",
    error: null,
    username: "",
    password: "",
    isWindows: false,
    settings: null,
  });

  const handleConnectNode = React.useCallback(async () => {
    if (selectedIds.length !== 1) return;
    const nodeId = selectedIds[0];
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const account = state.accounts.find((a) => a.id === node.accountId);
    if (!account) {
      setConnectDialog({
        open: true,
        node,
        state: "error",
        error: "Could not resolve the Batch account for this node.",
        username: "",
        password: "",
        isWindows: false,
        settings: null,
      });
      return;
    }
    // Pre-check: per Azure docs, user accounts can only be added to a
    // node in `idle` or `running` state. Any other state — `starting`,
    // `starttaskfailed`, `unusable`, `rebooting`, etc. — returns
    // `OperationNotValidOnNode` (HTTP 409). For Nvidia GPU pools the
    // common failure is `starttaskfailed` (driver install crashed).
    // Surface the exact state and the recovery path BEFORE firing the
    // ARM call so the operator doesn't get a cryptic 409.
    const CONNECTABLE: Set<NodeState> = new Set(["idle", "running"]);
    if (!CONNECTABLE.has(node.state)) {
      const hint =
        node.state === "starttaskfailed"
          ? "Start-task failed — check the start-task stderr (GPU driver install often crashes here). Reimage the node, or fix the start task and recreate the pool, then retry Connect."
          : node.state === "unusable"
            ? "Node is in unusable state — usually a network / NSG issue. See troubleshooting at https://learn.microsoft.com/troubleshoot/azure/hpc/batch/azure-batch-node-unusable-state, then Reimage or recreate."
            : `Node is in state '${node.state}' — wait for it to reach idle/running, or use Reimage to recycle it.`;
      setConnectDialog({
        open: true,
        node,
        state: "error",
        error: `Cannot create remote-login user while the node is '${node.state}'. ${hint}`,
        username: "",
        password: "",
        isWindows: false,
        settings: null,
      });
      return;
    }
    // Heuristic for OS detection — node.imageReference isn't always
    // populated, but the publisher field is when set. Fall back to
    // looking for "windows" in vmSize description.
    const isWindows = (() => {
      const refImage = (node as { imageReference?: { publisher?: string } })
        .imageReference;
      const publisher = (refImage?.publisher ?? "").toLowerCase();
      return (
        publisher.includes("windows") ||
        (node.vmSize ?? "").toLowerCase().includes("windows")
      );
    })();

    // Username is STABLE ("azbm-connect") so the create-user service
    // (which does DELETE-then-POST under the hood) can safely replace a
    // prior temp account on every click — otherwise each Connect click
    // would add another user to the node, and the ~20-user cap would
    // start returning 409s after a few attempts. The password rotates
    // every click so the operator always gets a fresh credential pair.
    const username = "azbm-connect";
    const lower = "abcdefghijkmnopqrstuvwxyz";
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const digits = "23456789";
    const symbols = "!@#$%^&*";
    const allChars = lower + upper + digits + symbols;
    const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
    const password =
      pick(lower) +
      pick(upper) +
      pick(digits) +
      pick(symbols) +
      Array.from({ length: 12 }, () => pick(allChars)).join("");

    setConnectDialog({
      open: true,
      node,
      state: "provisioning",
      error: null,
      username,
      password,
      isWindows,
      settings: null,
    });

    try {
      // Resolve the AAD account that owns the Batch account's
      // subscription. With multi-account support there can be several
      // signed-in MSAL identities, and we must mint a Batch token from
      // the one that actually has access to this sub — picking the
      // primary blindly would 403 for any sub that belongs to a
      // non-primary account.
      const sub = state.subscriptions.find(
        (s) => s.subscriptionId === account.subscriptionId,
      );
      const homeAccountId = sub?.homeAccountId;
      const tenantId = sub?.tenantId;
      if (!homeAccountId) {
        throw new Error(
          "Could not resolve the MSAL account that owns this Batch account's subscription. Sign in with the right Azure account on the Azure Accounts page.",
        );
      }
      const token = await getBatchTokenForAccount(homeAccountId, tenantId);
      const endpoint = `https://${account.accountName}.${account.region}.batch.azure.com`;
      await createNodeUser(
        endpoint,
        node.poolId,
        node.nodeId,
        {
          name: username,
          password,
          isAdmin: true,
          expiryTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        token,
      );
      const settings = await getNodeRemoteLoginSettings(
        endpoint,
        node.poolId,
        node.nodeId,
        token,
      );
      setConnectDialog((prev) => ({
        ...prev,
        state: "ready",
        settings,
      }));
      auditLog.record({
        actor: homeAccountId,
        action: "create_node_user",
        target: `${account.accountName}/${node.poolId}/${node.nodeId}`,
        status: "success",
        details: {
          subscriptionId: account.subscriptionId,
          region: account.region,
          username,
          isWindows,
        },
      });

      // Auto-launch the local SSH/RDP client via the dev-server.
      // Best-effort — if the server isn't reachable or the local
      // client isn't installed, the dialog still shows the command +
      // password so the operator can run it themselves. We also copy
      // the password to clipboard so once the prompt appears, a single
      // Ctrl/Cmd-V completes the login.
      try {
        await navigator.clipboard.writeText(password);
      } catch {
        /* clipboard blocked */
      }
      try {
        await fetch("/api/connect/launch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: isWindows ? "rdp" : "ssh",
            user: username,
            ip: settings.remoteLoginIPAddress,
            port: settings.remoteLoginPort,
          }),
        });
      } catch {
        /* launcher unavailable — dialog already shows the command */
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConnectDialog((prev) => ({
        ...prev,
        state: "error",
        error: msg,
      }));
      auditLog.record({
        actor: account.subscriptionId,
        action: "create_node_user",
        target: `${account.accountName}/${node.poolId}/${node.nodeId}`,
        status: "failure",
        error: msg,
        details: {
          subscriptionId: account.subscriptionId,
          region: account.region,
          isWindows,
        },
      });
    }
  }, [selectedIds, state.nodes, state.accounts, state.subscriptions]);

  const closeConnectDialog = React.useCallback(() => {
    setConnectDialog((prev) => ({ ...prev, open: false }));
  }, []);

  // ---- Bulk delete (grouped by pool) ---------------------------------------
  // Idempotency: pool-level remove-nodes API; a node that's already gone
  // returns 404 which the orchestrator treats as success. Safe to retry.
  const handleDeleteNodes = React.useCallback(() => {
    const ids = selectedIds;
    if (ids.length === 0) return;

    const poolSet = new Set<string>();
    for (const id of ids) {
      const node = state.nodes.find((n) => n.id === id);
      if (node) poolSet.add(`${node.accountName}/${node.poolId}`);
    }

    const executeDelete = async () => {
      setIsActing(true);
      setError(null);
      setBulkResult(null);
      setBulkProgressMessage(
        `Deleting ${formatNumber(ids.length)} node${
          ids.length === 1 ? "" : "s"
        } across ${poolSet.size} pool(s)...`,
      );
      const actor = primaryAccount?.homeAccountId ?? "ui";
      try {
        await orchestrator.execute({
          action: "delete_nodes",
          payload: { nodeIds: ids },
        });
        setBulkResult({
          label: "delete",
          succeeded: ids.length,
          failed: 0,
          failedIds: [],
        });
        auditLog.record({
          actor,
          action: "delete_nodes",
          target: `${ids.length} node(s) across ${poolSet.size} pool(s)`,
          status: "success",
          details: {
            attempted: ids.length,
            pools: Array.from(poolSet).slice(0, 16),
            sampleIds: ids.slice(0, 16),
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setBulkResult({
          label: "delete",
          succeeded: 0,
          failed: ids.length,
          failedIds: ids.slice(0, 10),
        });
        auditLog.record({
          actor,
          action: "delete_nodes",
          target: `${ids.length} node(s) across ${poolSet.size} pool(s)`,
          status: "failure",
          error: message,
          details: { attempted: ids.length, pools: Array.from(poolSet) },
        });
      } finally {
        setIsActing(false);
        setBulkProgressMessage(null);
      }
    };

    showConfirmation(
      `Delete ${formatNumber(ids.length)} node${ids.length === 1 ? "" : "s"}?`,
      `This will affect ${poolSet.size} pool(s). Running tasks on affected nodes will be requeued. This action cannot be undone.`,
      "Delete",
      true,
      executeDelete,
    );
  }, [
    selectedIds,
    state.nodes,
    orchestrator,
    showConfirmation,
    primaryAccount,
  ]);

  // ---- Bulk recreate --------------------------------------------------------
  // Recreate = remove + bump pool target so the scheduler re-allocates.
  // Idempotent: extra calls just keep the pool at the same target so the
  // scheduler treats them as no-ops.
  const handleRecreateNodes = React.useCallback(() => {
    const ids = selectedIds;
    if (ids.length === 0) return;

    const executeRecreate = async () => {
      setIsActing(true);
      setError(null);
      const actor = primaryAccount?.homeAccountId ?? "ui";
      try {
        await orchestrator.execute({
          action: "recreate_nodes",
          payload: { nodeIds: ids },
        });
        auditLog.record({
          actor,
          action: "recreate_nodes",
          target: `${ids.length} node(s)`,
          status: "success",
          details: { attempted: ids.length, sampleIds: ids.slice(0, 16) },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        auditLog.record({
          actor,
          action: "recreate_nodes",
          target: `${ids.length} node(s)`,
          status: "failure",
          error: message,
          details: { attempted: ids.length },
        });
      } finally {
        setIsActing(false);
      }
    };

    showConfirmation(
      `Recreate ${formatNumber(ids.length)} node${ids.length === 1 ? "" : "s"}?`,
      "Nodes will be removed and pool targets restored to trigger fresh allocation.",
      "Recreate",
      false,
      executeRecreate,
    );
  }, [selectedIds, orchestrator, showConfirmation, primaryAccount]);

  // ---- Recover preempted ----------------------------------------------------
  const handleRecoverPreempted = React.useCallback(() => {
    const preemptedCount = state.nodes.filter(
      (n) => n.state === "preempted",
    ).length;
    if (preemptedCount === 0) {
      setError("No preempted nodes to recover.");
      return;
    }

    const executeRecover = async () => {
      setIsActing(true);
      setError(null);
      const actor = primaryAccount?.homeAccountId ?? "ui";
      try {
        await orchestrator.execute({
          action: "recover_preempted",
          payload: {},
        });
        auditLog.record({
          actor,
          action: "recover_preempted",
          target: `${preemptedCount} preempted node(s)`,
          status: "success",
          details: { triggeredBy: "manual", count: preemptedCount },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        auditLog.record({
          actor,
          action: "recover_preempted",
          target: `${preemptedCount} preempted node(s)`,
          status: "failure",
          error: message,
          details: { triggeredBy: "manual", count: preemptedCount },
        });
      } finally {
        setIsActing(false);
      }
    };

    showConfirmation(
      `Recover ${formatNumber(preemptedCount)} preempted node${
        preemptedCount === 1 ? "" : "s"
      }?`,
      "This will re-request low-priority capacity for affected pools.",
      "Recover",
      false,
      executeRecover,
    );
  }, [state.nodes, orchestrator, showConfirmation, primaryAccount]);

  // ---- Bulk reimage of stuck nodes -----------------------------------------
  // One-click recovery for nodes flagged by the stuck-state detector. Uses
  // the same orchestrator path as the bulk Reimage button, but pre-selects
  // EVERY stuck node so the operator doesn't have to manually multi-select.
  const handleReimageStuck = React.useCallback(() => {
    if (stuckNodes.length === 0) return;
    const ids = stuckNodes.map((n) => n.id);

    const executeReimage = async () => {
      setIsActing(true);
      setError(null);
      setBulkResult(null);
      setBulkProgressMessage(
        `Reimaging ${formatNumber(ids.length)} stuck node${
          ids.length === 1 ? "" : "s"
        }...`,
      );
      const actor = primaryAccount?.homeAccountId ?? "ui";
      try {
        await orchestrator.execute({
          action: "bulk_node_action",
          payload: { actionType: "reimage", nodeIds: ids },
        });
        const result = computeBulkResult("reimage stuck", ids);
        setBulkResult(result);
        auditLog.record({
          actor,
          action: "bulk_reimage_stuck",
          target: `${ids.length} stuck node(s)`,
          status: result.failed === 0 ? "success" : "failure",
          details: {
            attempted: ids.length,
            succeeded: result.succeeded,
            failed: result.failed,
            sampleIds: ids.slice(0, 16),
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setBulkResult({
          label: "reimage stuck",
          succeeded: 0,
          failed: ids.length,
          failedIds: ids.slice(0, 10),
        });
        auditLog.record({
          actor,
          action: "bulk_reimage_stuck",
          target: `${ids.length} stuck node(s)`,
          status: "failure",
          error: message,
          details: { attempted: ids.length },
        });
      } finally {
        setIsActing(false);
        setBulkProgressMessage(null);
      }
    };

    showConfirmation(
      `Reimage ${formatNumber(stuckNodes.length)} stuck node${
        stuckNodes.length === 1 ? "" : "s"
      }?`,
      "These nodes have been transitioning for more than 15 minutes — typically a hung start-task or a back-end deadlock. Reimage restores the OS disk from the source image; any in-progress work is requeued.",
      "Reimage",
      true,
      executeReimage,
    );
  }, [
    stuckNodes,
    orchestrator,
    showConfirmation,
    computeBulkResult,
    primaryAccount,
  ]);

  // ---- DataTable columns ---------------------------------------------------
  const columns = React.useMemo<DataTableColumn<ManagedNode>[]>(
    () => [
      {
        id: "id",
        header: "ID",
        cell: (row) => (
          <span className="font-mono text-xs">{row.nodeId ?? row.id}</span>
        ),
        sort: (a, b) =>
          compareStrings(a.nodeId ?? a.id, b.nodeId ?? b.id),
        csv: (row) => row.nodeId ?? row.id,
      },
      {
        id: "region",
        header: "Region",
        cell: (row) => <span className="text-xs">{row.region}</span>,
        sort: (a, b) => compareStrings(a.region, b.region),
        csv: (row) => row.region,
      },
      {
        id: "account",
        header: "Account",
        cell: (row) => <span className="text-xs">{row.accountName}</span>,
        sort: (a, b) => compareStrings(a.accountName, b.accountName),
        csv: (row) => row.accountName,
      },
      {
        id: "pool",
        header: "Pool",
        cell: (row) => <span className="text-xs">{row.poolId}</span>,
        sort: (a, b) => compareStrings(a.poolId, b.poolId),
        csv: (row) => row.poolId,
      },
      {
        id: "state",
        header: "State",
        cell: (row) => (
          <span className="inline-flex items-center gap-1.5">
            {/*
              Live pulse pip for running nodes — same pattern as the
              Task Manager and Throttle Status pages so "this node is
              alive right now" reads instantly without re-coding the
              badge color.
            */}
            {row.state === "running" && (
              <span
                className="live-pulse-dot shrink-0"
                style={{ ["--live-tone" as never]: "var(--success)" }}
                aria-hidden="true"
              />
            )}
            <StatusBadge status={row.state} />
          </span>
        ),
        sort: (a, b) => compareStrings(a.state, b.state),
        csv: (row) => row.state,
      },
      {
        id: "vmSize",
        header: "VM size",
        cell: (row) =>
          row.vmSize ? (
            <span className="font-mono text-2xs text-muted-foreground">
              {row.vmSize}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/60">—</span>
          ),
        sort: (a, b) => compareStrings(a.vmSize ?? "", b.vmSize ?? ""),
        csv: (row) => row.vmSize ?? "",
      },
      {
        id: "ipAddress",
        header: "IP address",
        cell: (row) =>
          row.ipAddress ? (
            <CopyableIp ip={row.ipAddress} />
          ) : (
            <span className="text-xs text-muted-foreground/60">—</span>
          ),
        csv: (row) => row.ipAddress ?? "",
      },
      {
        id: "totalTasks",
        header: "Total tasks",
        cell: (row) => (
          <span className="tabular-nums text-xs">
            {formatNumber(row.totalTasksRun ?? 0)}
          </span>
        ),
        sort: (a, b) =>
          compareNumbers(a.totalTasksRun ?? 0, b.totalTasksRun ?? 0),
        csv: (row) => row.totalTasksRun ?? 0,
      },
      {
        id: "runningTasks",
        header: "Running tasks",
        cell: (row) => (
          <span className="tabular-nums text-xs">
            {formatNumber(row.runningTasksCount ?? 0)}
          </span>
        ),
        sort: (a, b) =>
          compareNumbers(a.runningTasksCount ?? 0, b.runningTasksCount ?? 0),
        csv: (row) => row.runningTasksCount ?? 0,
      },
      {
        id: "lastBootTime",
        header: "Last boot",
        cell: (row) => (
          <span
            className="text-xs text-muted-foreground"
            title={row.lastBootTime ?? ""}
          >
            {row.lastBootTime ? formatRelativeTime(row.lastBootTime) : "—"}
          </span>
        ),
        sort: (a, b) => {
          const aT = a.lastBootTime ? new Date(a.lastBootTime).getTime() : 0;
          const bT = b.lastBootTime ? new Date(b.lastBootTime).getTime() : 0;
          return compareNumbers(aT, bT);
        },
        csv: (row) => row.lastBootTime ?? "",
      },
      {
        // Stuck flag — surfaces an inline warning chip on the row for any
        // node currently flagged by the stuck-state detector. Hidden by
        // default; opt-in from the column-visibility menu when triaging.
        id: "stuckFlag",
        header: "Stuck?",
        defaultHidden: true,
        cell: (row) =>
          stuckIdSet.has(row.id) ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-warning">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              stuck
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/40">—</span>
          ),
        csv: (row) => (stuckIdSet.has(row.id) ? "stuck" : ""),
      },
      {
        // Per-row copy buttons — small hover-revealed icons so the
        // operator can grab a node ID for a CLI command or paste it into
        // a support ticket without going through the bulk-action toolbar.
        id: "copy",
        header: "",
        width: "w-16",
        cell: (row) => (
          <CopyButton
            label="node ID"
            value={row.nodeId ?? row.id}
            extraLabel={`pool: ${row.poolId}`}
          />
        ),
      },
    ],
    [stuckIdSet],
  );

  // ---- Selection helper ----------------------------------------------------
  const handleSelectionChange = React.useCallback((next: Set<string>) => {
    setSelection(next);
  }, []);

  const selectionCount = selection.size;
  const hasSelection = selectionCount > 0;

  // ---- Filter setters (URL-synced) -----------------------------------------
  const handleRegionChange = React.useCallback(
    (value: string) => setFilters({ region: value === "__all" ? "" : value }),
    [setFilters],
  );
  const handleStateChange = React.useCallback(
    (value: string) => setFilters({ state: value === "__all" ? "" : value }),
    [setFilters],
  );
  const handlePoolChange = React.useCallback(
    (value: string) => setFilters({ pool: value === "__all" ? "" : value }),
    [setFilters],
  );
  const handlePriorityChange = React.useCallback(
    (value: string) =>
      setFilters({
        priority: (value === "__all" ? "" : value) as PriorityFilter,
      }),
    [setFilters],
  );
  // VM-size filter handlers removed along with the picker (see comment
  // in the toolbar JSX). `vmSize` URL state is preserved for backward
  // compatibility with old bookmarks but no UI sets it anymore.
  const clearFilters = React.useCallback(() => {
    setFilters({
      region: "",
      state: "",
      pool: "",
      priority: "",
      vmSize: "",
    });
    setQuickFilter("all");
    search.setQuery("");
  }, [setFilters, search]);

  const filtersActive = Boolean(
    regionFilter ||
      stateFilter ||
      poolFilter ||
      priorityFilter ||
      vmSizeFilter ||
      quickFilter !== "all" ||
      search.query,
  );

  // ---- Copy selected IDs ---------------------------------------------------
  // Copies newline-separated node IDs of the current selection to the
  // clipboard. Use case: paste into a CLI loop or a support ticket. Falls
  // back to the synchronous execCommand path if the async clipboard API is
  // blocked (Edge/iframe permissions).
  const handleCopySelectedIds = React.useCallback(async () => {
    if (selectedNodes.length === 0) return;
    const text = selectedNodes
      .map((n) => n.nodeId ?? n.id)
      .join("\n");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopiedSelected(true);
    } catch {
      /* clipboard blocked */
    }
  }, [selectedNodes]);

  // ---- Export the current FILTERED view as JSON ----------------------------
  // DataTable already provides a CSV export. JSON preserves the field
  // shape (numbers stay numbers, optional fields stay optional) so the
  // operator can pipe the output through jq / Power-Query without
  // string-flattening losses. The CSV export honors visible columns; we
  // intentionally export the full record set here for parity with what
  // shows up in the store.
  const handleExportJson = React.useCallback(() => {
    const rows = visibleNodes.map((n) => ({
      id: n.id,
      nodeId: n.nodeId,
      accountId: n.accountId,
      accountName: n.accountName,
      region: n.region,
      poolId: n.poolId,
      state: n.state,
      vmSize: n.vmSize ?? null,
      ipAddress: n.ipAddress ?? null,
      isDedicated: n.isDedicated,
      lastBootTime: n.lastBootTime ?? null,
      totalTasksRun: n.totalTasksRun ?? 0,
      runningTasksCount: n.runningTasksCount ?? 0,
      schedulingState: n.schedulingState ?? null,
      startTaskExitCode: n.startTaskExitCode ?? null,
      subscriptionId: n.subscriptionId ?? null,
      stuck: stuckIdSet.has(n.id),
    }));
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    downloadJson(`nodes-${stamp}.json`, {
      exportedAt: new Date().toISOString(),
      filters: {
        region: regionFilter || null,
        state: stateFilter || null,
        pool: poolFilter || null,
        priority: priorityFilter || null,
        quickFilter,
        searchQuery: search.query || null,
      },
      count: rows.length,
      nodes: rows,
    });
  }, [
    visibleNodes,
    stuckIdSet,
    regionFilter,
    stateFilter,
    poolFilter,
    priorityFilter,
    quickFilter,
    search.query,
  ]);

  // ---- Export the current FILTERED view as CSV (full schema) --------------
  // DataTable's built-in CSV export is column-driven; this one is
  // schema-driven for parity with the JSON export so operators get the
  // same row shape regardless of which columns happen to be visible.
  const handleExportCsv = React.useCallback(() => {
    const headers = [
      "id",
      "nodeId",
      "accountName",
      "region",
      "poolId",
      "state",
      "vmSize",
      "ipAddress",
      "isDedicated",
      "lastBootTime",
      "totalTasksRun",
      "runningTasksCount",
      "schedulingState",
      "startTaskExitCode",
      "stuck",
    ];
    const rows = visibleNodes.map((n) => [
      n.id,
      n.nodeId,
      n.accountName,
      n.region,
      n.poolId,
      n.state,
      n.vmSize ?? "",
      n.ipAddress ?? "",
      n.isDedicated ? "dedicated" : "lowpriority",
      n.lastBootTime ?? "",
      n.totalTasksRun ?? 0,
      n.runningTasksCount ?? 0,
      n.schedulingState ?? "",
      n.startTaskExitCode ?? "",
      stuckIdSet.has(n.id) ? "stuck" : "",
    ]);
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    downloadCsv(`nodes-${stamp}.csv`, headers, rows);
  }, [visibleNodes, stuckIdSet]);

  // ---- "Last refreshed Xs ago" string --------------------------------------
  // Not memoized — depends on Date.now() which we want to re-evaluate on
  // every render. The 1 Hz `setNowTick` interval keeps this fresh.
  const lastRefreshedLabel =
    lastRefreshedAt == null
      ? null
      : formatRelativeTime(new Date(lastRefreshedAt));

  // ---- Keyboard shortcuts: / to focus search, Esc to clear ----------------
  // Standard pattern from Gmail / GitHub. Guard against firing while the
  // user is typing into another input or has a modifier key held — `/`
  // is a real character somebody might want to type. We only intercept
  // when no other input has focus.
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        target?.isContentEditable;
      if (e.key === "/" && !isEditable && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === "Escape" && tagName === "input" && target === searchInputRef.current) {
        search.setQuery("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [search]);

  // ---- Render branches ------------------------------------------------------
  const initialLoading = isLoading && state.nodes.length === 0;
  const fetchFailed = !isLoading && error !== null && state.nodes.length === 0;
  const noNodes = state.nodes.length === 0 && !isLoading && !fetchFailed;

  // ---- Empty state component (passed to DataTable) -------------------------
  const tableEmpty = (
    <EmptyState
      icon={Server}
      title="No nodes match the current filter"
      description="Adjust filters or refresh pool info to populate nodes."
      action={
        filtersActive
          ? { label: "Clear filters", onClick: clearFilters }
          : undefined
      }
    />
  );

  return (
    <div className="flex flex-col gap-4 py-4" aria-labelledby="nodes-heading">
      <div className="relative overflow-hidden rounded-xl border bg-card/50 p-6">
        <DotPattern fade="top-left" />
        <Meteors count={10} tone="primary" />
        <div className="relative z-10">
      <PageHeader title="Nodes" titleId="nodes-heading">
        {/* ARM token freshness HUD — quiet by default, surfaces when
            < 10 min from expiry. Click to force-refresh so the MSAL
            session stays alive across long auto-refresh windows and
            multi-node bulk actions (reboot / reimage / delete loops
            can run for minutes and might otherwise hit a stale-token
            401 mid-batch). */}
        <TokenExpiryBadge
          secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
          loading={armTokenTracker.loading}
          onRefresh={() => void armTokenTracker.refresh()}
          needsReauth={armTokenTracker.needsReauth}
          onReauth={() => void armTokenTracker.reauth()}
        />
        <div className="relative">
          <Input
            ref={searchInputRef}
            type="search"
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            placeholder="Search nodes... (press /)"
            aria-label="Search nodes (press forward slash to focus, Escape to clear)"
            className="h-8 w-64 pr-7"
          />
          {search.query && (
            <button
              type="button"
              onClick={() => search.setQuery("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2">
              <Switch
                id="nodes-auto-refresh"
                checked={autoRefresh}
                onCheckedChange={(checked) =>
                  setAutoRefresh(checked === true)
                }
                aria-label="Toggle auto-refresh every 30 seconds"
              />
              <Label
                htmlFor="nodes-auto-refresh"
                className="cursor-pointer text-xs text-muted-foreground"
              >
                Auto-refresh (30s)
              </Label>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            Re-fetches all nodes across {createdAccounts.length} account(s)
            every 30 seconds.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2">
              <Switch
                id="nodes-auto-recovery"
                checked={autoRecovery}
                onCheckedChange={(checked) =>
                  setAutoRecovery(checked === true)
                }
                aria-label="Toggle auto-recovery every 60 seconds"
              />
              <Label
                htmlFor="nodes-auto-recovery"
                className="cursor-pointer text-xs text-muted-foreground"
              >
                Auto-Recovery (60s)
              </Label>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Every 60 seconds, if any nodes are in &quot;preempted&quot; state,
            re-requests low-priority capacity for affected pools. Concurrent
            runs are guarded so a slow recovery won&apos;t stack.
          </TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handleRefreshNodes}
          disabled={isLoading || createdAccounts.length === 0}
          aria-label="Refresh nodes"
        >
          <RotateCw className={cn(isLoading && "animate-spin")} />
          {isLoading
            ? "Loading..."
            : `Refresh (${createdAccounts.length} accounts)`}
        </Button>
        {isLoading && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => orchestrator.cancel()}
            aria-label="Stop refreshing"
            className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Square />
            Stop
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={visibleNodes.length === 0}
              aria-label="Export current view as CSV"
            >
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Download {formatNumber(visibleNodes.length)} filtered node(s) as
            CSV.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportJson}
              disabled={visibleNodes.length === 0}
              aria-label="Export current view as JSON"
            >
              <FileJson className="h-3.5 w-3.5" />
              JSON
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Download {formatNumber(visibleNodes.length)} filtered node(s) as
            JSON (preserves field types).
          </TooltipContent>
        </Tooltip>
      </PageHeader>
      {lastRefreshedLabel && (
        <div
          className="mt-2 flex items-center gap-2 text-2xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              isLoading
                ? "animate-pulse bg-info"
                : autoRefresh
                  ? "bg-success"
                  : "bg-muted-foreground/50",
            )}
            aria-hidden="true"
          />
          Refreshed {lastRefreshedLabel}
          {autoRefresh && " · auto every 30s"}
          {autoRecovery && summaryStats.preempted > 0 && (
            <span className="text-warning">
              {" "}
              · auto-recovery armed ({summaryStats.preempted} preempted)
            </span>
          )}
        </div>
      )}
        </div>
      </div>

      {error && state.nodes.length > 0 && (
        <Alert
          variant="destructive"
          aria-live="polite"
          className="flex items-start justify-between gap-3"
        >
          <AlertDescription className="flex-1">{error}</AlertDescription>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="-mr-1 -mt-1 h-6 text-destructive hover:bg-destructive/10"
          >
            Dismiss
          </Button>
        </Alert>
      )}

      {bulkProgressMessage && (
        <Alert variant="info" aria-live="polite" role="status">
          <Loader2 className="animate-spin" />
          <AlertDescription>{bulkProgressMessage}</AlertDescription>
        </Alert>
      )}

      {bulkResult && !bulkProgressMessage && (
        <Alert
          variant={
            bulkResult.failed === 0
              ? "success"
              : bulkResult.succeeded === 0
                ? "destructive"
                : "warning"
          }
          aria-live="polite"
          className="flex items-start justify-between gap-3"
        >
          <AlertDescription className="flex-1">
            Bulk {bulkResult.label}:{" "}
            <strong>{formatNumber(bulkResult.succeeded)}</strong> succeeded,{" "}
            <strong>{formatNumber(bulkResult.failed)}</strong> failed.
            {bulkResult.failedIds.length > 0 && (
              <>
                {" "}
                Failed node IDs:{" "}
                <code className="font-mono text-2xs">
                  {bulkResult.failedIds.slice(0, 8).join(", ")}
                  {bulkResult.failedIds.length > 8
                    ? `, +${bulkResult.failedIds.length - 8} more`
                    : ""}
                </code>
              </>
            )}
          </AlertDescription>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setBulkResult(null)}
            aria-label="Dismiss result summary"
            className="-mr-1 -mt-1 h-6"
          >
            Dismiss
          </Button>
        </Alert>
      )}

      {/* Insights — fleet-wide distribution + idle / stuck detectors +
          VM-size frequency. On wide screens lays out as 4 columns so the
          stuck panel sits next to the idle panel for direct comparison;
          on narrower screens it stacks. */}
      {summaryStats.total > 0 && (
        <div
          role="group"
          aria-label="Fleet insights"
          className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
        >
          {/* State distribution donut */}
          <div className="flex items-center gap-4 rounded-md border border-border bg-card p-4">
            <Donut
              segments={nodeStateDonut}
              size={96}
              thickness={14}
              centerLabel={formatNumber(summaryStats.total)}
              centerSubLabel="nodes"
            />
            <div className="min-w-0 flex-1">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                State distribution
              </h3>
              <DonutLegend segments={nodeStateDonut} className="mt-2" />
            </div>
          </div>

          {/* Idle-node detector — surfaces likely waste */}
          <div className="rounded-md border border-border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Idle nodes (≥ 30 min)
              </h3>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider",
                  idleWasteNodes.length === 0
                    ? "bg-success/15 text-success"
                    : idleWasteNodes.length < 3
                      ? "bg-info/15 text-info"
                      : "bg-warning/15 text-warning",
                )}
              >
                {idleWasteNodes.length === 0
                  ? "no waste"
                  : `${idleWasteNodes.length} idle`}
              </span>
            </div>
            {idleWasteNodes.length === 0 ? (
              <p className="mt-2 text-2xs text-muted-foreground">
                No nodes have been idle for more than 30 minutes — fleet
                utilization looks healthy.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1 text-2xs">
                {idleWasteNodes.slice(0, 5).map((n) => (
                  <li
                    key={n.id}
                    className="flex items-center gap-2 truncate"
                  >
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-info"
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        // Pre-fill the search field with the node id so the
                        // table scrolls to / highlights it.
                        search.setQuery(n.nodeId);
                      }}
                      className="truncate font-mono text-foreground hover:underline"
                      title={`${n.accountName} / ${n.poolId}`}
                    >
                      {n.nodeId}
                    </button>
                    <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                      {n.lastBootTime
                        ? formatRelativeTime(n.lastBootTime)
                        : "—"}
                    </span>
                  </li>
                ))}
                {idleWasteNodes.length > 5 && (
                  <li className="text-muted-foreground">
                    + {idleWasteNodes.length - 5} more
                  </li>
                )}
              </ul>
            )}
          </div>

          {/* Stuck-state detector — surfaces nodes lingering in a
              transitional state past STUCK_TRANSITIONAL_THRESHOLD_MS.
              Almost always a hung start-task or a back-end deadlock;
              reimage usually clears them. Single-click bulk recovery
              via the "Reimage stuck" button. */}
          <div className="rounded-md border border-border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Stuck nodes (&gt; 15 min)
              </h3>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider",
                  stuckNodes.length === 0
                    ? "bg-success/15 text-success"
                    : stuckNodes.length < 3
                      ? "bg-warning/15 text-warning"
                      : "bg-destructive/15 text-destructive",
                )}
              >
                {stuckNodes.length === 0
                  ? "all clear"
                  : `${stuckNodes.length} stuck`}
              </span>
            </div>
            {stuckNodes.length === 0 ? (
              <p className="mt-2 text-2xs text-muted-foreground">
                No nodes have been transitioning for more than 15 minutes —
                ramp-up and reimage cycles look healthy.
              </p>
            ) : (
              <>
                <ul className="mt-2 flex flex-col gap-1 text-2xs">
                  {stuckNodes.slice(0, 4).map((n) => (
                    <li
                      key={n.id}
                      className="flex items-center gap-2 truncate"
                    >
                      <AlertTriangle
                        className="h-3 w-3 shrink-0 text-warning"
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          search.setQuery(n.nodeId);
                          setQuickFilter("stuck");
                        }}
                        className="truncate font-mono text-foreground hover:underline"
                        title={`${n.accountName} / ${n.poolId} · state=${n.state}`}
                      >
                        {n.nodeId}
                      </button>
                      <span className="shrink-0 rounded bg-warning/15 px-1 py-0 text-2xs font-medium uppercase text-warning">
                        {n.state}
                      </span>
                      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                        {n.lastBootTime
                          ? formatRelativeTime(n.lastBootTime)
                          : "—"}
                      </span>
                    </li>
                  ))}
                  {stuckNodes.length > 4 && (
                    <li className="text-muted-foreground">
                      + {stuckNodes.length - 4} more
                    </li>
                  )}
                </ul>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setQuickFilter("stuck")}
                    aria-label="Filter table to stuck nodes"
                    className="text-2xs"
                  >
                    Show in table
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={handleReimageStuck}
                    disabled={isActing}
                    aria-label="Reimage all stuck nodes"
                    className="border-warning/50 text-warning text-2xs hover:bg-warning/10 hover:text-warning"
                  >
                    <Wrench className="h-3 w-3" />
                    Reimage stuck
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* VM-size frequency mini-bar */}
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              VM size frequency
            </h3>
            {vmSizeBars.length === 0 ? (
              <p className="mt-2 text-2xs text-muted-foreground">
                No nodes have a reported VM size.
              </p>
            ) : (
              <MiniBar
                items={vmSizeBars}
                maxItems={8}
                ariaLabel="VM size frequency"
                className="mt-2"
              />
            )}
          </div>
        </div>
      )}

      {/* Summary stats — each card carries a tooltip explaining what
          counts toward that bucket and what to do about it. */}
      <div
        className="relative flex flex-wrap gap-2 overflow-hidden rounded-xl p-1"
        role="group"
        aria-label="Node summary statistics"
      >
        <BorderBeam size={200} duration={8} />
        <StatCard
          label="Total"
          value={summaryStats.total}
          tooltip="All nodes loaded across every connected Batch account."
        />
        <StatCard
          label="Running"
          value={summaryStats.running}
          tone="info"
          tooltip="Nodes actively executing one or more tasks."
        />
        <StatCard
          label="Idle"
          value={summaryStats.idle}
          tooltip="Nodes ready to accept work. If many remain idle for long, consider lowering the pool's target count."
        />
        <StatCard
          label="Preempted"
          value={summaryStats.preempted}
          tone="destructive"
          tooltip="Low-priority nodes that Azure reclaimed. Use Recover preempted to re-request capacity."
        />
        <StatCard
          label="Transitioning"
          value={summaryStats.transitioning}
          tone="warning"
          tooltip="Nodes in creating, starting, rebooting, reimaging, leavingpool, or waiting-for-start-task. Brief is normal; > 15 min is flagged as stuck."
        />
        <StatCard
          label="Stuck"
          value={summaryStats.stuck}
          tone={summaryStats.stuck > 0 ? "destructive" : undefined}
          tooltip="Nodes transitioning for more than 15 minutes. Almost always a hung start-task; reimage usually clears them."
        />
        <StatCard
          label="Errors"
          value={summaryStats.errors}
          tone="destructive"
          tooltip="starttaskfailed + unusable + unknown. Check start-task stderr or NSG configuration."
        />
        <StatCard
          label="Running tasks"
          value={summaryStats.runningTasks}
          tone="info"
          tooltip="Sum of running tasks across all nodes — fleet workload right now."
        />
      </div>

      {/* Quick-filter chips — single-tap scope on top of the URL-synced
          facet filters. Each chip shows a live count so the operator can
          gauge fleet health without scanning the donut. Counts are
          fleet-wide (state.nodes); they don't react to the other facets
          on purpose — the chip is a fast "show me only X" shortcut, not
          a count of "X within current facet". Stuck chip carries a
          warning tone so it stands out at a glance. */}
      {summaryStats.total > 0 && (
        <div
          className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-sm"
          role="group"
          aria-label="Quick filter chips"
        >
          {(
            [
              { key: "all", label: "All", count: summaryStats.total },
              {
                key: "running",
                label: "Running",
                count: summaryStats.running,
              },
              { key: "idle", label: "Idle", count: summaryStats.idle },
              {
                key: "transitioning",
                label: "Transitioning",
                count: summaryStats.transitioning,
              },
              {
                key: "preempted",
                label: "Preempted",
                count: summaryStats.preempted,
              },
              {
                key: "errors",
                label: "Errors",
                count: summaryStats.errors,
              },
              {
                key: "stuck",
                label: "Stuck",
                count: summaryStats.stuck,
                warning: true,
              },
            ] as const
          ).map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setQuickFilter(chip.key)}
              aria-pressed={quickFilter === chip.key}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                quickFilter === chip.key
                  ? chip.warning && chip.count > 0
                    ? "bg-warning/20 text-warning"
                    : "bg-primary/15 text-primary"
                  : chip.warning && chip.count > 0
                    ? "text-warning hover:bg-warning/10"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
            >
              {chip.label}
              <span className="ml-1.5 tabular-nums opacity-70">
                {formatNumber(chip.count)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Faceted filters — URL-synced */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
        <FilterSelect
          id="nodes-region-filter"
          label="Region"
          value={regionFilter}
          options={regionOptions}
          onChange={handleRegionChange}
        />
        <FilterSelect
          id="nodes-state-filter"
          label="State"
          value={stateFilter}
          options={ALL_NODE_STATES}
          onChange={handleStateChange}
        />
        <FilterSelect
          id="nodes-pool-filter"
          label="Pool"
          value={poolFilter}
          options={poolOptions}
          onChange={handlePoolChange}
        />
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="nodes-priority-filter"
            className="text-xs text-muted-foreground"
          >
            Priority
          </Label>
          <Select
            value={priorityFilter || "__all"}
            onValueChange={handlePriorityChange}
          >
            <SelectTrigger
              id="nodes-priority-filter"
              className="h-8 w-[160px] text-xs"
              aria-label="Filter by priority"
            >
              <SelectValue placeholder="All priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All priorities</SelectItem>
              <SelectItem value="dedicated">Dedicated</SelectItem>
              <SelectItem value="lowpriority">Low priority</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/*
          VM-size filter REMOVED. Per Azure Batch architecture
          (https://learn.microsoft.com/azure/batch/nodes-and-pools#node-size):
          all nodes in a pool share one vmSize, and once a pool is
          created its vmSize can't change. So filtering nodes by vmSize
          is architecturally redundant — the existing Pool filter does
          this transitively. Keeping the picker would mislead users
          into thinking they can change a node's VM (they can't).
          Use the Pool filter to scope the table by VM size.
        */}
        {filtersActive && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            aria-label="Clear all filters (facets, quick filter, and search)"
            className="self-end"
          >
            Clear filters
          </Button>
        )}
        <div
          className="ml-auto self-end text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <span className="tabular-nums">
            {formatNumber(visibleNodes.length)}
          </span>{" "}
          of{" "}
          <span className="tabular-nums">
            {formatNumber(state.nodes.length)}
          </span>{" "}
          shown ·{" "}
          <span className="tabular-nums">{formatNumber(selectionCount)}</span>{" "}
          selected
          {quickFilter !== "all" && (
            <>
              {" "}
              ·{" "}
              <span className="rounded bg-primary/10 px-1 py-0.5 text-primary">
                quick: {quickFilter}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Standalone fleet actions — these don't depend on selection.
          Operates against the entire fleet (Recover preempted, Reimage
          stuck) regardless of what's checked in the table. */}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Fleet actions"
      >
        <BulkActionButton
          icon={Heart}
          label={`Recover preempted (${summaryStats.preempted})`}
          ariaLabel={`Recover ${summaryStats.preempted} preempted nodes`}
          onClick={handleRecoverPreempted}
          disabled={isActing || summaryStats.preempted === 0}
          disabledReason={
            summaryStats.preempted === 0
              ? "No preempted nodes to recover"
              : undefined
          }
          tone="warning"
        />
        <BulkActionButton
          icon={Wrench}
          label={`Reimage stuck (${summaryStats.stuck})`}
          ariaLabel={`Reimage ${summaryStats.stuck} stuck nodes`}
          onClick={handleReimageStuck}
          disabled={isActing || summaryStats.stuck === 0}
          disabledReason={
            summaryStats.stuck === 0
              ? "No stuck nodes detected"
              : undefined
          }
          tone="warning"
        />
      </div>

      {(isActing || (isLoading && state.nodes.length > 0)) && (
        <div className="flex flex-col gap-1" role="status" aria-live="polite">
          <span className="text-xs text-muted-foreground">
            {isActing ? "Performing action..." : "Refreshing nodes..."}
          </span>
          <Progress indeterminate aria-label="In progress" />
        </div>
      )}

      {/* Failed initial load */}
      {fetchFailed && (
        <ErrorState
          message="Failed to load nodes"
          detail={error ?? undefined}
          onRetry={handleRefreshNodes}
        />
      )}

      {/* Empty state — no nodes loaded yet */}
      {noNodes && !fetchFailed && (
        <EmptyState
          icon={Server}
          title="No nodes"
          description="Refresh pool info to populate nodes."
          action={
            createdAccounts.length > 0
              ? {
                  label: "Refresh nodes",
                  onClick: () => {
                    void handleRefreshNodes();
                  },
                  icon: RotateCw,
                  loading: isLoading,
                }
              : undefined
          }
        />
      )}

      {/* Main DataTable — shown when we have data, are loading the first
          fetch, or have nodes filtered down to zero */}
      {(state.nodes.length > 0 || initialLoading) && (
        <div
          className={cn(
            "transition-opacity duration-200 ease-out motion-reduce:transition-none",
            isLoading && state.nodes.length > 0
              ? "opacity-70"
              : "opacity-100",
            // Reserve space at the bottom so the sticky toolbar doesn't
            // cover the last data row when selection is active.
            hasSelection && "pb-20",
          )}
        >
          <DataTable<ManagedNode>
            tableId="nodes"
            rows={visibleNodes}
            columns={columns}
            rowKey={(row) => row.id}
            loading={initialLoading}
            empty={tableEmpty}
            selection={selection}
            onSelectionChange={handleSelectionChange}
            csvFileName="nodes-export.csv"
          />
        </div>
      )}

      {/* Sticky bulk-action toolbar — visible when one or more nodes are
          selected. Primary action (Recreate) is emphasized with a solid
          fill; destructive actions are kept visually distinct. */}
      {hasSelection && (
        <div
          role="region"
          aria-label="Bulk actions for selected nodes"
          className="sticky bottom-0 z-20 -mx-1 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-card/95 px-3 py-2 shadow-elev-2 backdrop-blur supports-[backdrop-filter]:bg-card/80 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"
        >
          <span className="inline-flex items-center gap-2 rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-semibold text-primary">
            <span className="tabular-nums">{formatNumber(selectionCount)}</span>
            selected
          </span>
          {(() => {
            // Pre-compute actionable counts so each button can show how
            // many of the N selected nodes the action will actually run
            // on (rather than silently filtering on click).
            const rebootable = filterActionable("reboot", selectedNodes).length;
            const reimageable = filterActionable("reimage", selectedNodes).length;
            const schedulable = filterActionable(
              "enableScheduling",
              selectedNodes,
            ).length;
            const skippedReboot = selectionCount - rebootable;
            const skippedReimage = selectionCount - reimageable;
            const skippedSched = selectionCount - schedulable;
            return (
              <>
                {(skippedReboot > 0 ||
                  skippedReimage > 0 ||
                  skippedSched > 0) && (
                  <span className="hidden items-center gap-1 text-2xs text-muted-foreground sm:inline-flex">
                    <AlertTriangle
                      className="h-3 w-3 text-warning"
                      aria-hidden="true"
                    />
                    Some selected nodes are in non-actionable states
                  </span>
                )}
                <span className="hidden h-5 w-px bg-border sm:inline-block" />
                <BulkActionButton
                  icon={CircleSlash}
                  label="Recreate"
                  ariaLabel={`Recreate ${selectionCount} selected nodes`}
                  onClick={handleRecreateNodes}
                  disabled={isActing}
                  tone="primary-solid"
                />
                <BulkActionButton
                  icon={Plug}
                  label="Connect"
                  ariaLabel={
                    selectionCount === 1
                      ? "Connect to the selected node via SSH or RDP"
                      : "Select exactly one node to connect"
                  }
                  onClick={() => void handleConnectNode()}
                  disabled={isActing || selectionCount !== 1}
                  disabledReason={
                    selectionCount === 0
                      ? "Select a node first"
                      : selectionCount > 1
                        ? "Connect supports a single node — select exactly one"
                        : undefined
                  }
                  tone="primary-solid"
                />
                <BulkActionButton
                  icon={RefreshCcw}
                  label={
                    rebootable === selectionCount
                      ? "Reboot"
                      : `Reboot (${rebootable})`
                  }
                  ariaLabel={`Reboot ${rebootable} actionable selected nodes`}
                  onClick={() => handleNodeAction("reboot")}
                  disabled={isActing || rebootable === 0}
                  disabledReason={
                    rebootable === 0
                      ? "None of the selected nodes can be rebooted in their current state"
                      : skippedReboot > 0
                        ? `${skippedReboot} of ${selectionCount} selected node(s) will be skipped (non-actionable state)`
                        : undefined
                  }
                />
                <BulkActionButton
                  icon={Pause}
                  label={
                    schedulable === selectionCount
                      ? "Disable scheduling"
                      : `Disable scheduling (${schedulable})`
                  }
                  ariaLabel={`Disable scheduling on ${schedulable} selected nodes`}
                  onClick={() => handleNodeAction("disableScheduling")}
                  disabled={isActing || schedulable === 0}
                  disabledReason={
                    schedulable === 0
                      ? "None of the selected nodes can change scheduling state right now"
                      : undefined
                  }
                />
                <BulkActionButton
                  icon={Play}
                  label={
                    schedulable === selectionCount
                      ? "Enable scheduling"
                      : `Enable scheduling (${schedulable})`
                  }
                  ariaLabel={`Enable scheduling on ${schedulable} selected nodes`}
                  onClick={() => handleNodeAction("enableScheduling")}
                  disabled={isActing || schedulable === 0}
                  disabledReason={
                    schedulable === 0
                      ? "None of the selected nodes can change scheduling state right now"
                      : undefined
                  }
                />
                <span className="hidden h-5 w-px bg-border sm:inline-block" />
                <BulkActionButton
                  icon={RotateCw}
                  label={
                    reimageable === selectionCount
                      ? "Reimage"
                      : `Reimage (${reimageable})`
                  }
                  ariaLabel={`Reimage ${reimageable} actionable selected nodes`}
                  onClick={() => handleNodeAction("reimage")}
                  disabled={isActing || reimageable === 0}
                  disabledReason={
                    reimageable === 0
                      ? "None of the selected nodes can be reimaged in their current state"
                      : undefined
                  }
                  tone="destructive"
                />
                <BulkActionButton
                  icon={Trash2}
                  label="Delete"
                  ariaLabel={`Delete ${selectionCount} selected nodes`}
                  onClick={handleDeleteNodes}
                  disabled={isActing || selectionCount === 0}
                  tone="destructive"
                />
                <span className="hidden h-5 w-px bg-border sm:inline-block" />
                <BulkActionButton
                  icon={copiedSelected ? Check : ClipboardList}
                  label={
                    copiedSelected
                      ? "Copied"
                      : `Copy IDs (${selectionCount})`
                  }
                  ariaLabel={`Copy ${selectionCount} selected node IDs to clipboard, one per line`}
                  onClick={() => void handleCopySelectedIds()}
                  disabled={isActing || selectionCount === 0}
                />
              </>
            );
          })()}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSelection(new Set())}
            aria-label="Clear selection"
            className="ml-auto text-muted-foreground"
          >
            <X />
            Clear
          </Button>
        </div>
      )}

      {/* Confirmation dialog */}
      <ConfirmationDialog
        hidden={confirmDialog.hidden}
        title={confirmDialog.title}
        message={confirmDialog.description}
        confirmText={confirmDialog.confirmLabel}
        cancelText="Cancel"
        danger={confirmDialog.destructive}
        loading={isActing}
        onConfirm={async () => {
          dismissConfirmDialog();
          await confirmDialog.onConfirm();
        }}
        onCancel={dismissConfirmDialog}
      />

      {/* Connect-to-node dialog */}
      <ConnectNodeDialog
        open={connectDialog.open}
        node={connectDialog.node}
        state={connectDialog.state}
        error={connectDialog.error}
        username={connectDialog.username}
        password={connectDialog.password}
        isWindows={connectDialog.isWindows}
        settings={connectDialog.settings}
        onClose={closeConnectDialog}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Connect-to-node dialog
// ---------------------------------------------------------------------------
//
// Two-step Azure Batch flow:
//   1. createNodeUser  → POST /pools/{poolId}/nodes/{nodeId}/users
//   2. getRemoteLoginSettings → GET .../remoteloginsettings (IP + port)
//
// Renders the connection command (ssh / mstsc) and a copy-to-clipboard
// for the password. Temp user auto-expires in 24 h so the operator does
// not need to clean up manually.
interface ConnectNodeDialogProps {
  open: boolean;
  node: ManagedNode | null;
  state: "idle" | "provisioning" | "ready" | "error";
  error: string | null;
  username: string;
  password: string;
  isWindows: boolean;
  settings: BatchNodeRemoteLoginSettings | null;
  onClose: () => void;
}

const ConnectNodeDialog: React.FC<ConnectNodeDialogProps> = ({
  open,
  node,
  state,
  error,
  username,
  password,
  isWindows,
  settings,
  onClose,
}) => {
  const [copiedField, setCopiedField] = React.useState<string | null>(null);
  const copy = React.useCallback(
    async (label: string, value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopiedField(label);
        setTimeout(() => setCopiedField(null), 1500);
      } catch {
        /* clipboard blocked */
      }
    },
    [],
  );

  if (!open || !node) return null;

  const ip = settings?.remoteLoginIPAddress ?? "";
  const port = settings?.remoteLoginPort ?? 0;
  const sshCmd = ip && port ? `ssh ${username}@${ip} -p ${port}` : "";
  const rdpCmd = ip && port ? `mstsc /v:${ip}:${port}` : "";
  const command = isWindows ? rdpCmd : sshCmd;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-node-title"
    >
      <div
        className="relative max-w-lg w-full mx-4 rounded-lg border border-border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
        <h2
          id="connect-node-title"
          className="text-base font-semibold tracking-tight flex items-center gap-2"
        >
          <Plug className="h-4 w-4 text-primary" />
          Connect to node {node.nodeId}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Pool <code className="font-mono">{node.poolId}</code> ·{" "}
          {node.region} · {isWindows ? "Windows (RDP)" : "Linux (SSH)"}
        </p>

        {state === "provisioning" && (
          <div className="mt-4 flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Creating temporary user account on the node…
          </div>
        )}

        {state === "error" && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription className="text-xs leading-relaxed">
              {error || "Could not provision the connection."}
            </AlertDescription>
          </Alert>
        )}

        {state === "ready" && (
          <div className="mt-4 flex flex-col gap-3">
            <ConnectField
              label="Connection command"
              value={command}
              onCopy={() => void copy("cmd", command)}
              copied={copiedField === "cmd"}
              mono
            />
            <div className="grid grid-cols-2 gap-3">
              <ConnectField
                label="Address"
                value={`${ip}:${port}`}
                onCopy={() => void copy("addr", `${ip}:${port}`)}
                copied={copiedField === "addr"}
                mono
              />
              <ConnectField
                label="Username"
                value={username}
                onCopy={() => void copy("user", username)}
                copied={copiedField === "user"}
                mono
              />
            </div>
            <ConnectField
              label="Password"
              value={password}
              onCopy={() => void copy("pw", password)}
              copied={copiedField === "pw"}
              mono
              masked
            />
            <p className="text-2xs text-muted-foreground leading-relaxed">
              Temporary account expires in 24 h. The Batch service rotates
              the SSH/RDP port behind a public IP; keep the connection
              command — it won&apos;t match the node&apos;s internal IP.
            </p>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onClose}
            disabled={state === "provisioning"}
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
};

interface ConnectFieldProps {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  mono?: boolean;
  masked?: boolean;
}

const ConnectField: React.FC<ConnectFieldProps> = ({
  label,
  value,
  onCopy,
  copied,
  mono,
  masked,
}) => {
  const [revealed, setRevealed] = React.useState(!masked);
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-2xs uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <div className="flex items-stretch gap-1.5">
        <Input
          readOnly
          value={masked && !revealed ? "•".repeat(value.length) : value}
          className={cn("text-xs", mono && "font-mono")}
          onFocus={(e) => e.currentTarget.select()}
        />
        {masked && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Hide" : "Reveal"}
          >
            {revealed ? "Hide" : "Show"}
          </Button>
        )}
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Local sub-components
// ---------------------------------------------------------------------------

interface FilterSelectProps {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

const FilterSelect: React.FC<FilterSelectProps> = ({
  id,
  label,
  value,
  options,
  onChange,
}) => (
  <div className="flex flex-col gap-1">
    <Label htmlFor={id} className="text-xs text-muted-foreground">
      {label}
    </Label>
    <Select value={value || "__all"} onValueChange={onChange}>
      <SelectTrigger
        id={id}
        className="h-8 w-[160px] text-xs"
        aria-label={`Filter by ${label.toLowerCase()}`}
      >
        <SelectValue placeholder={`All ${label.toLowerCase()}s`} />
      </SelectTrigger>
      <SelectContent className="max-h-72 overflow-y-auto">
        <SelectItem value="__all">All {label.toLowerCase()}s</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt}>
            {opt}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
);

interface StatCardProps {
  label: string;
  value: number;
  tone?: "info" | "destructive" | "success" | "warning";
  /** Optional explanatory tooltip shown on hover/focus. */
  tooltip?: string;
}

const STAT_TONE_CLASS: Record<
  NonNullable<StatCardProps["tone"]>,
  { value: string; label: string }
> = {
  info: { value: "text-info", label: "text-info" },
  destructive: { value: "text-destructive", label: "text-destructive" },
  success: { value: "text-success", label: "text-success" },
  warning: { value: "text-warning", label: "text-warning" },
};

const StatCard: React.FC<StatCardProps> = ({ label, value, tone, tooltip }) => {
  const toneClasses = tone ? STAT_TONE_CLASS[tone] : null;
  // Active card = non-zero count. Active gets the live-glow-bar (breathing
  // outer glow) so the user can see at a glance which states have nodes
  // right now. Idle (zero) cards stay quiet.
  const isActive = value > 0;
  const liveTone =
    tone === "destructive"
      ? "var(--destructive)"
      : tone === "success"
        ? "var(--success)"
        : tone === "warning"
          ? "var(--warning)"
          : tone === "info"
            ? "var(--info, var(--primary))"
            : "var(--primary)";
  const card = (
    <div
      className={cn(
        "group relative flex min-w-[110px] flex-col items-center gap-1 rounded-lg border bg-card/70 px-4 py-3 text-center backdrop-blur-sm transition-all duration-200 ease-out",
        "hover:-translate-y-px hover:border-primary/40 hover:shadow-elev-1",
        isActive ? "border-primary/30 live-glow-bar" : "border-border",
      )}
      style={
        isActive
          ? ({ ["--live-tone" as never]: liveTone } as React.CSSProperties)
          : undefined
      }
      tabIndex={tooltip ? 0 : undefined}
      role={tooltip ? "group" : undefined}
      aria-label={tooltip ? `${label}: ${value}. ${tooltip}` : undefined}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground",
          toneClasses?.label,
        )}
      >
        {/* Live status pip on active cards. */}
        {isActive && (
          <span
            className="live-pulse-dot"
            style={{ ["--live-tone" as never]: liveTone }}
            aria-hidden="true"
          />
        )}
        {label}
      </span>
      <span
        className={cn(
          "text-xl font-bold tabular-nums text-foreground",
          toneClasses?.value,
        )}
      >
        <NumberTicker value={value} />
      </span>
    </div>
  );

  if (!tooltip) return card;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
    </Tooltip>
  );
};

// ---------------------------------------------------------------------------
// CopyableIp — IP address with a copy button revealed on hover/focus.
// ---------------------------------------------------------------------------

interface CopyableIpProps {
  ip: string;
}

const CopyableIp: React.FC<CopyableIpProps> = ({ ip }) => {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const handleCopy = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(ip);
        } else {
          // Best-effort fallback for environments without the async API.
          const ta = document.createElement("textarea");
          ta.value = ip;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setCopied(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 1200);
      } catch {
        // Silent — clipboard may be blocked by permissions.
      }
    },
    [ip],
  );

  return (
    <span className="group/ip inline-flex items-center gap-1.5">
      <span className="font-mono text-xs">{ip}</span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? `Copied ${ip}` : `Copy ${ip} to clipboard`}
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 ease-out hover:bg-accent/30 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/ip:opacity-100 motion-reduce:transition-none",
          copied && "opacity-100 text-success",
        )}
      >
        {copied ? (
          <Check className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Copy className="h-3 w-3" aria-hidden="true" />
        )}
      </button>
    </span>
  );
};

// ---------------------------------------------------------------------------
// CopyButton — generic compact copy-to-clipboard button used in the table
// to copy a node ID. Surfaces a brief check-mark pulse on success and a
// hover-reveal pattern so the column doesn't shout.
// ---------------------------------------------------------------------------

interface CopyButtonProps {
  /** Human label used in aria-label and tooltip ("node ID", "pool ID", …). */
  label: string;
  /** Value placed on the clipboard. */
  value: string;
  /** Optional extra context string shown in the title attribute. */
  extraLabel?: string;
}

const CopyButton: React.FC<CopyButtonProps> = ({ label, value, extraLabel }) => {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );
  const onClick = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setCopied(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 1200);
      } catch {
        /* clipboard blocked */
      }
    },
    [value],
  );
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}: ${value}`}
      title={extraLabel ? `${value}\n${extraLabel}` : value}
      className={cn(
        // DataTable rows don't have a `group/row` class for us to hook
        // into, so we use opacity-40 by default and animate up to full
        // opacity on hover/focus. Visible without being shouty.
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 transition-all duration-150 ease-out hover:bg-accent/30 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        copied && "opacity-100 text-success",
      )}
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden="true" />
      ) : (
        <Copy className="h-3 w-3" aria-hidden="true" />
      )}
    </button>
  );
};

// ---------------------------------------------------------------------------
// BulkActionButton — outline button with optional tone styling and a
// disabled-reason tooltip. Wrapping the disabled <button> in a <span> with
// `pointer-events-auto` lets Radix Tooltip detect hover even when the
// underlying button has pointer-events: none.
// ---------------------------------------------------------------------------

interface BulkActionButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  tone?: "primary-solid" | "destructive" | "warning";
}

const TONE_TO_CLASS: Record<NonNullable<BulkActionButtonProps["tone"]>, string> = {
  "primary-solid": "",
  destructive:
    "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive",
  warning:
    "border-warning/50 text-warning hover:bg-warning/10 hover:text-warning",
};

const BulkActionButton: React.FC<BulkActionButtonProps> = ({
  icon: Icon,
  label,
  ariaLabel,
  onClick,
  disabled,
  disabledReason,
  tone,
}) => {
  const isPrimary = tone === "primary-solid";
  const button = (
    <Button
      type="button"
      variant={isPrimary ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "transition-colors duration-150 ease-out motion-reduce:transition-none",
        !isPrimary && tone ? TONE_TO_CLASS[tone] : undefined,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Button>
  );

  if (disabled && disabledReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper so tooltip still triggers on a disabled button */}
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    );
  }

  return button;
};

export const NodesPage: React.FC<NodesPageProps> = (props) => (
  <ErrorBoundary>
    <NodesPageInner {...props} />
  </ErrorBoundary>
);
