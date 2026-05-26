import { __awaiter } from "tslib";
/**
 * Nodes page — multi-region compute-node browser with bulk reboot/reimage/
 * delete/recreate, faceted filters synced to the URL, and DataTable rendering.
 *
 * Security / pivot-risk context (operator awareness, not enforcement here):
 *   Every running compute node holds a managed-identity (MSI) token reachable
 *   via the local IMDS endpoint (`http://169.254.169.254/metadata/identity/
 *   oauth2/token?api-version=2018-02-01&resource=…` for VM-backed pools).
 *   Anything that achieves arbitrary code execution INSIDE a node — a
 *   poisoned start-task script, a job that runs untrusted user code, an
 *   image pulled from a compromised registry — can mint an ARM/Graph token
 *   for whatever scope the pool's identity holds and pivot from there. See
 *   `C:\Users\baimgprodsesa1\Desktop\New folder\_analysis_netspi.md` §I
 *   (per-service IMDS variant matrix) and §II (post-token enumeration)
 *   plus `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #7 (IMDS theft). The two
 *   defender hooks surfaced here:
 *     1. Forensic-export button — captures stuck + error-state node state
 *        BEFORE the operator reimages/deletes and erases service-side
 *        evidence. starttaskfailed nodes in particular are the common
 *        "init script crashed mid-payload" footprint.
 *     2. Connect dialog — uses a STABLE temp-user name + 24h auto-
 *        expiring credential rather than per-click usernames that
 *        accumulate up to the ~20-user cap. The audit-log entry on
 *        every Connect captures who minted credentials for which node.
 */
import * as React from "react";
import { AlertTriangle, Check, CircleSlash, ClipboardList, Copy, Download, FileJson, Heart, Loader2, Pause, Play, Plug, RefreshCcw, RotateCw, Server, Square, Trash2, Wrench, X, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { ErrorState } from "@/components/ui/error-state";
import { Donut, DonutLegend } from "@/components/ui/charts/donut";
import { MiniBar } from "@/components/ui/charts/gauge";
import { cn, compareNumbers, compareStrings, downloadCsv, downloadJson, formatNumber, formatRelativeTime, } from "@/lib/utils";
import { getBatchTokenForAccount } from "../../auth/msal-auth";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useSearch } from "../../hooks/use-search";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import { createNodeUser, getNodeRemoteLoginSettings, } from "../../services";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState } from "../../store/store-context";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { DataTable, } from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { PageHeader } from "../shared/page-header";
import { StatusBadge } from "../shared/status-badge";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { BorderBeam, DotPattern, Meteors, NumberTicker, } from "@/components/ui/effects";
const ALL_NODE_STATES = [
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
const ERROR_STATES = new Set([
    "starttaskfailed",
    "unusable",
    "unknown",
]);
/**
 * Transitional NodeStates. A node legitimately sits in one of these
 * states for a short window during pool ramp-up, reboot, reimage, or
 * scale-down. If a node lingers in a transitional state for longer than
 * the operator-configurable `stuckThresholdMs` (default 15 min, see
 * STUCK_THRESHOLD_DEFAULT_MIN), we flag it as "stuck" — typically a
 * symptom of a hung start-task, networking issue, or back-end deadlock,
 * and almost always resolvable by reimage or recreate.
 */
const TRANSITIONAL_STATES = new Set([
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
const ACTIONABLE_STATES = new Set([
    "idle",
    "running",
    "starttaskfailed",
    "rebooting",
    "reimaging",
    "offline",
]);
const AUTO_REFRESH_INTERVAL_MS = 30000;
const AUTO_RECOVERY_INTERVAL_MS = 60000;
/**
 * Default threshold past which a "transitioning" node is considered stuck.
 * Operator-overridable at runtime via the slider in the toolbar; persisted
 * via `usePersistedState`. Clamped to the [MIN, MAX] range below.
 */
const STUCK_THRESHOLD_DEFAULT_MIN = 15;
const STUCK_THRESHOLD_MIN_MIN = 5;
const STUCK_THRESHOLD_MAX_MIN = 60;
const STUCK_THRESHOLD_STORAGE_KEY = "nodes-page.stuck-threshold-minutes";
const clampStuckThreshold = (value) => {
    if (!Number.isFinite(value))
        return STUCK_THRESHOLD_DEFAULT_MIN;
    return Math.max(STUCK_THRESHOLD_MIN_MIN, Math.min(STUCK_THRESHOLD_MAX_MIN, Math.round(value)));
};
const INITIAL_FILTERS = {
    region: "",
    state: "",
    pool: "",
    priority: "",
    vmSize: "",
};
const DESTRUCTIVE_ACTIONS = new Set([
    "reboot",
    "reimage",
    "delete",
    "disableScheduling",
]);
const ACTION_LABELS = {
    reboot: "reboot",
    reimage: "reimage",
    delete: "delete",
    disableScheduling: "disable scheduling on",
    enableScheduling: "enable scheduling on",
};
const HIDDEN_DIALOG = {
    hidden: true,
    title: "",
    description: "",
    confirmLabel: "Confirm",
    destructive: false,
    onConfirm: () => { },
};
const NodesPageInner = ({ orchestrator }) => {
    var _a, _b;
    const state = useMultiRegionState();
    const [isLoading, setIsLoading] = React.useState(false);
    const [isActing, setIsActing] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [bulkResult, setBulkResult] = React.useState(null);
    const [bulkProgressMessage, setBulkProgressMessage] = React.useState(null);
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [autoRecovery, setAutoRecovery] = React.useState(false);
    const [selection, setSelection] = React.useState(new Set());
    /** Wall-clock timestamp of the most recent successful list_nodes. The
     * toolbar shows "Refreshed Xs ago" so the operator can tell at a glance
     * whether the table is stale — critical when the page is being used as
     * a live fleet HUD while an auto-recovery loop is running. */
    const [lastRefreshedAt, setLastRefreshedAt] = React.useState(null);
    /** Recompute "X ago" labels at 1 Hz without subscribing to state.nodes. */
    const [, setNowTick] = React.useState(0);
    React.useEffect(() => {
        const t = setInterval(() => setNowTick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, []);
    /** Quick filter chip — fast scope on top of the URL-synced facet filters.
     * Stored locally (not URL) because it's a one-tap UX shortcut, not a
     * shareable view. Reset on full filter clear. */
    const [quickFilter, setQuickFilter] = React.useState("all");
    /** User-configurable stuck-node threshold (minutes). Persisted so the
     * setting follows the operator across sessions. Clamped on read and
     * write to defend against corrupted localStorage payloads. */
    const [stuckThresholdMinRaw, setStuckThresholdMinRaw] = usePersistedState(STUCK_THRESHOLD_STORAGE_KEY, STUCK_THRESHOLD_DEFAULT_MIN);
    const stuckThresholdMin = React.useMemo(() => clampStuckThreshold(stuckThresholdMinRaw), [stuckThresholdMinRaw]);
    const stuckThresholdMs = stuckThresholdMin * 60000;
    const setStuckThresholdMin = React.useCallback((value) => setStuckThresholdMinRaw(clampStuckThreshold(value)), [setStuckThresholdMinRaw]);
    /** Caller-friendly "copied selected node IDs" pulse for the toolbar. */
    const [copiedSelected, setCopiedSelected] = React.useState(false);
    React.useEffect(() => {
        if (!copiedSelected)
            return;
        const t = setTimeout(() => setCopiedSelected(false), 1500);
        return () => clearTimeout(t);
    }, [copiedSelected]);
    // ---- URL-synced facets per Contract §4.3 ----------------------------------
    const [filters, setFilters] = useUrlState(INITIAL_FILTERS, { replace: true });
    const regionFilter = filters.region;
    const stateFilter = filters.state;
    const poolFilter = filters.pool;
    const priorityFilter = (_a = filters.priority) !== null && _a !== void 0 ? _a : "";
    const vmSizeFilter = (_b = filters.vmSize) !== null && _b !== void 0 ? _b : "";
    // ---- Confirmation dialog state -------------------------------------------
    const [confirmDialog, setConfirmDialog] = React.useState(HIDDEN_DIALOG);
    const dismissConfirmDialog = React.useCallback(() => {
        setConfirmDialog((prev) => (Object.assign(Object.assign({}, prev), { hidden: true })));
    }, []);
    const showConfirmation = React.useCallback((title, description, confirmLabel, destructive, onConfirm) => {
        setConfirmDialog({
            hidden: false,
            title,
            description,
            confirmLabel,
            destructive,
            onConfirm,
        });
    }, []);
    // ---- Created accounts and unique facet options ---------------------------
    const createdAccounts = React.useMemo(() => state.accounts.filter((a) => a.provisioningState === "created"), [state.accounts]);
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
        if (!first)
            return undefined;
        const sub = state.subscriptions.find((s) => s.subscriptionId === first.subscriptionId);
        if (!(sub === null || sub === void 0 ? void 0 : sub.homeAccountId))
            return undefined;
        return { homeAccountId: sub.homeAccountId, tenantId: sub.tenantId };
    }, [createdAccounts, state.subscriptions]);
    const armTokenTracker = useArmToken(primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.tenantId);
    const regionOptions = React.useMemo(() => {
        const set = new Set();
        for (const n of state.nodes)
            set.add(n.region);
        return Array.from(set).sort(compareStrings);
    }, [state.nodes]);
    const poolOptions = React.useMemo(() => {
        const set = new Set();
        for (const n of state.nodes)
            set.add(n.poolId);
        return Array.from(set).sort(compareStrings);
    }, [state.nodes]);
    // ---- Auto-load nodes on mount --------------------------------------------
    // Uses `useAbortableEffect` so the orchestrator's underlying ARM round-
    // trips get a real `AbortSignal` and the agent can short-circuit when
    // the operator navigates away mid-load.
    const autoLoadedRef = React.useRef(false);
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (autoLoadedRef.current)
            return;
        if (createdAccounts.length === 0 || state.nodes.length > 0)
            return;
        autoLoadedRef.current = true;
        setIsLoading(true);
        setError(null);
        try {
            yield orchestrator.execute({
                action: "list_nodes",
                payload: { accountIds: createdAccounts.map((a) => a.id) },
                signal,
            });
            if (!signal.aborted)
                setLastRefreshedAt(Date.now());
        }
        catch (err) {
            if (signal.aborted)
                return;
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
        }
        finally {
            if (!signal.aborted)
                setIsLoading(false);
        }
    }), [createdAccounts, state.nodes.length, orchestrator]);
    // ---- Refresh handler ------------------------------------------------------
    // Tracks the most recent in-flight refresh AbortController so unmount /
    // tenant-switch / a subsequent click can cancel an obsolete request.
    const refreshAbortRef = React.useRef(null);
    React.useEffect(() => () => {
        var _a;
        (_a = refreshAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
    }, []);
    const handleRefreshNodes = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _c;
        if (createdAccounts.length === 0)
            return;
        // Cancel any previous in-flight refresh so timer-driven refresh storms
        // (auto-refresh tick + manual click) don't queue up redundant ARM
        // round-trips.
        (_c = refreshAbortRef.current) === null || _c === void 0 ? void 0 : _c.abort();
        const ac = new AbortController();
        refreshAbortRef.current = ac;
        setIsLoading(true);
        setError(null);
        try {
            yield orchestrator.execute({
                action: "list_nodes",
                payload: { accountIds: createdAccounts.map((a) => a.id) },
                signal: ac.signal,
            });
            if (!ac.signal.aborted)
                setLastRefreshedAt(Date.now());
        }
        catch (err) {
            if (ac.signal.aborted)
                return;
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
        }
        finally {
            if (!ac.signal.aborted)
                setIsLoading(false);
            if (refreshAbortRef.current === ac)
                refreshAbortRef.current = null;
        }
    }), [orchestrator, createdAccounts]);
    // ---- Auto-refresh timer ---------------------------------------------------
    React.useEffect(() => {
        if (!autoRefresh)
            return;
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
        if (!autoRecovery)
            return;
        let cancelled = false;
        let recoveryInFlight = false;
        const interval = setInterval(() => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            if (cancelled || recoveryInFlight)
                return;
            const preempted = nodesRef.current.filter((n) => n.state === "preempted");
            if (preempted.length === 0)
                return;
            recoveryInFlight = true;
            const count = preempted.length;
            try {
                yield orchestrator.execute({
                    action: "recover_preempted",
                    payload: {},
                });
                if (cancelled)
                    return;
                auditLog.record({
                    actor: (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) !== null && _a !== void 0 ? _a : "auto-recovery",
                    action: "recover_preempted",
                    target: `${count} preempted node(s)`,
                    status: "success",
                    details: { triggeredBy: "auto-recovery", count },
                });
            }
            catch (err) {
                if (cancelled)
                    return;
                const message = err instanceof Error ? err.message : String(err);
                auditLog.record({
                    actor: (_b = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) !== null && _b !== void 0 ? _b : "auto-recovery",
                    action: "recover_preempted",
                    target: `${count} preempted node(s)`,
                    status: "failure",
                    error: message,
                    details: { triggeredBy: "auto-recovery", count },
                });
            }
            finally {
                recoveryInFlight = false;
            }
        }), AUTO_RECOVERY_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [autoRecovery, orchestrator, primaryAccount]);
    /**
     * Stuck-node detector — a node lingering in a transitional state past
     * the operator-configurable stuck threshold (default 15 min). We treat
     * `lastBootTime` as the most recent state-change anchor (it's the
     * closest we get without a per-transition timestamp). When absent OR
     * invalid (NaN after Date.parse), we EXCLUDE the node from the stuck
     * set rather than flag a false-positive. Same defensive parse used in
     * `idleWasteNodes`.
     *
     * COORDINATOR: extract stuck-node-detector — duplicated with
     * pool-creation page. Both pages walk `state.nodes`, filter on
     * TRANSITIONAL_STATES + lastBootTime age, and sort oldest-first. A
     * shared `useStuckNodes(nodes, thresholdMs)` hook (under
     * `multi-region/hooks/`) would centralize the threshold, NaN handling,
     * and the eslint-disable rationale on the deps array.
     */
    const stuckNodes = React.useMemo(() => {
        const now = Date.now();
        return state.nodes
            .filter((n) => {
            if (!TRANSITIONAL_STATES.has(n.state))
                return false;
            if (!n.lastBootTime)
                return false;
            const t = new Date(n.lastBootTime).getTime();
            if (!Number.isFinite(t))
                return false;
            return now - t >= stuckThresholdMs;
        })
            .sort((a, b) => {
            const ta = a.lastBootTime ? new Date(a.lastBootTime).getTime() : 0;
            const tb = b.lastBootTime ? new Date(b.lastBootTime).getTime() : 0;
            return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
        });
        // We intentionally depend ONLY on state.nodes + stuckThresholdMs so
        // this doesn't recompute every second. Recomputation cadence is
        // governed by the parent now-tick re-render — the function captures
        // `Date.now()` fresh each call.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.nodes, stuckThresholdMs]);
    const stuckIdSet = React.useMemo(() => new Set(stuckNodes.map((n) => n.id)), [stuckNodes]);
    // ---- Filtered nodes (URL filters first, then quick filter, then text) ---
    const filteredByFacets = React.useMemo(() => {
        let nodes = state.nodes;
        if (regionFilter)
            nodes = nodes.filter((n) => n.region === regionFilter);
        if (stateFilter)
            nodes = nodes.filter((n) => n.state === stateFilter);
        if (poolFilter)
            nodes = nodes.filter((n) => n.poolId === poolFilter);
        if (priorityFilter === "dedicated") {
            nodes = nodes.filter((n) => n.isDedicated);
        }
        else if (priorityFilter === "lowpriority") {
            nodes = nodes.filter((n) => !n.isDedicated);
        }
        if (vmSizeFilter) {
            // Compare case-insensitively — Azure mixes Standard_NC24s_v3 with
            // standard_nc24s_v3 across endpoints.
            const target = vmSizeFilter.toLowerCase();
            nodes = nodes.filter((n) => { var _a; return ((_a = n.vmSize) !== null && _a !== void 0 ? _a : "").toLowerCase() === target; });
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
            case "withActiveJobs":
                nodes = nodes.filter((n) => { var _a; return ((_a = n.runningTasksCount) !== null && _a !== void 0 ? _a : 0) > 0; });
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
    const SEARCH_FIELDS = React.useMemo(() => [
        "id",
        "nodeId",
        "poolId",
        "accountName",
        "region",
        "vmSize",
        "ipAddress",
        "state",
    ], []);
    const search = useSearch(filteredByFacets, SEARCH_FIELDS);
    const visibleNodes = search.filteredItems;
    // ---- Summary stats --------------------------------------------------------
    // Single-pass aggregation — the previous version re-iterated state.nodes
    // 6 separate times (one per .filter().length). At fleet scale (thousands
    // of nodes × 1 Hz re-render from the now-tick) this was a measurable
    // hotspot. One walk computes every bucket; downstream consumers are
    // unchanged.
    const summaryStats = React.useMemo(() => {
        var _a;
        const nodes = state.nodes;
        let running = 0;
        let idle = 0;
        let preempted = 0;
        let creating = 0;
        let transitioning = 0;
        let errors = 0;
        let totalRunningTasks = 0;
        let withActiveJobs = 0;
        for (const n of nodes) {
            if (n.state === "running")
                running++;
            if (n.state === "idle")
                idle++;
            if (n.state === "preempted")
                preempted++;
            if (n.state === "creating")
                creating++;
            if (TRANSITIONAL_STATES.has(n.state))
                transitioning++;
            if (ERROR_STATES.has(n.state))
                errors++;
            const tasks = (_a = n.runningTasksCount) !== null && _a !== void 0 ? _a : 0;
            totalRunningTasks += tasks;
            if (tasks > 0)
                withActiveJobs++;
        }
        return {
            total: nodes.length,
            running,
            idle,
            preempted,
            creating,
            transitioning,
            errors,
            stuck: stuckNodes.length,
            runningTasks: totalRunningTasks,
            withActiveJobs,
        };
    }, [state.nodes, stuckNodes.length]);
    // ---- Insights (donut + idle detector + VM-size mini-bar) ---------------
    /**
     * State-distribution donut data. Buckets fine-grained NodeStates into the
     * five canonical tones so the donut stays legible. Order is intentional:
     * Running first (most common), then transitional, then steady-state idle,
     * then warning conditions, then errors.
     */
    const nodeStateDonut = React.useMemo(() => {
        const nodes = state.nodes;
        const errors = nodes.filter((n) => ERROR_STATES.has(n.state)).length;
        const transitioning = nodes.filter((n) => n.state === "creating" ||
            n.state === "starting" ||
            n.state === "rebooting" ||
            n.state === "reimaging" ||
            n.state === "leavingpool" ||
            n.state === "waitingforstarttask").length;
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
            .filter((n) => {
            var _a;
            if (n.state !== "idle")
                return false;
            if (((_a = n.runningTasksCount) !== null && _a !== void 0 ? _a : 0) !== 0)
                return false;
            if (!n.lastBootTime)
                return false;
            const t = new Date(n.lastBootTime).getTime();
            if (!Number.isFinite(t))
                return false;
            return now - t >= idleWasteThresholdMs;
        })
            .sort((a, b) => {
            const ta = a.lastBootTime ? new Date(a.lastBootTime).getTime() : 0;
            const tb = b.lastBootTime ? new Date(b.lastBootTime).getTime() : 0;
            return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.nodes]);
    /**
     * VM-size frequency. Top 8 sizes by count. Ranks by descending count so
     * the most common sizes are visible first. NodeState is not factored in —
     * the user wants to know "what fleet do I have," not "what's running".
     */
    const vmSizeBars = React.useMemo(() => {
        var _a, _b;
        const counts = new Map();
        for (const n of state.nodes) {
            const key = (_a = n.vmSize) !== null && _a !== void 0 ? _a : "(unknown)";
            counts.set(key, ((_b = counts.get(key)) !== null && _b !== void 0 ? _b : 0) + 1);
        }
        return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([label, value]) => ({ label, value, tone: "primary" }));
    }, [state.nodes]);
    // ---- Reset selection when the underlying set shrinks beyond what's selected
    React.useEffect(() => {
        if (selection.size === 0)
            return;
        const visibleIds = new Set(visibleNodes.map((n) => n.id));
        let changed = false;
        const next = new Set();
        for (const id of selection) {
            if (visibleIds.has(id)) {
                next.add(id);
            }
            else {
                changed = true;
            }
        }
        if (changed)
            setSelection(next);
    }, [visibleNodes, selection]);
    // ---- Bulk action abort controller ----------------------------------------
    // Single in-flight bulk operation at a time (gated by `isActing`); when
    // the page unmounts mid-bulk-reboot we abort so the orchestrator can
    // short-circuit any pending per-node calls.
    const bulkAbortRef = React.useRef(null);
    React.useEffect(() => () => {
        var _a;
        (_a = bulkAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
    }, []);
    const beginBulkAction = React.useCallback(() => {
        var _a;
        (_a = bulkAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        const ac = new AbortController();
        bulkAbortRef.current = ac;
        return ac;
    }, []);
    const endBulkAction = React.useCallback((ac) => {
        if (bulkAbortRef.current === ac)
            bulkAbortRef.current = null;
    }, []);
    // ---- Bulk action result helper -------------------------------------------
    const computeBulkResult = React.useCallback((label, attemptedIds) => {
        const failedIds = [];
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
    }, [state.nodes]);
    const selectedIds = React.useMemo(() => Array.from(selection), [selection]);
    /**
     * Live snapshot of the selected nodes. Re-derives from the store on
     * every render so we never operate on a stale view. If a node has
     * disappeared from the store between selection and action, it's
     * silently dropped here — same semantics as the orchestrator side.
     */
    const selectedNodes = React.useMemo(() => {
        const map = new Map();
        for (const n of state.nodes)
            map.set(n.id, n);
        const out = [];
        for (const id of selectedIds) {
            const n = map.get(id);
            if (n)
                out.push(n);
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
    const filterActionable = React.useCallback((action, nodes) => {
        if (action === "delete") {
            // Delete is allowed in any state via removeNodes — orchestrator
            // calls the pool-level "remove nodes" op, not per-node DELETE.
            return nodes;
        }
        return nodes.filter((n) => ACTIONABLE_STATES.has(n.state));
    }, []);
    // ---- Generic bulk-action handler -----------------------------------------
    // Idempotency note: reboot / reimage / enable/disable scheduling all use
    // the Batch API's per-node endpoints which are idempotent at the Azure
    // level — re-firing reboot on a node already rebooting is a no-op (the
    // service returns 202 and continues the current reboot). Delete is
    // idempotent via the pool-level remove-nodes call: deleting a node that
    // already left the pool returns 404 which the orchestrator treats as
    // "succeeded". Safe to spam Retry without compounding side-effects.
    const handleNodeAction = React.useCallback((action) => __awaiter(void 0, void 0, void 0, function* () {
        var _d;
        if (selectedNodes.length === 0)
            return;
        const label = ACTION_LABELS[action];
        const verbCap = label.charAt(0).toUpperCase() + label.slice(1);
        const actionable = filterActionable(action, selectedNodes);
        const ids = actionable.map((n) => n.id);
        const skippedCount = selectedNodes.length - ids.length;
        if (ids.length === 0) {
            setError(`None of the ${formatNumber(selectedNodes.length)} selected node(s) can accept "${label}" right now — all are in non-actionable states.`);
            return;
        }
        const executeAction = () => __awaiter(void 0, void 0, void 0, function* () {
            var _e;
            const ac = beginBulkAction();
            setIsActing(true);
            setError(null);
            setBulkResult(null);
            setBulkProgressMessage(`${label} starting on ${formatNumber(ids.length)} node${ids.length === 1 ? "" : "s"}${skippedCount > 0 ? ` (${formatNumber(skippedCount)} skipped)` : ""}...`);
            const actor = (_e = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) !== null && _e !== void 0 ? _e : "ui";
            try {
                yield orchestrator.execute({
                    action: "bulk_node_action",
                    payload: { actionType: action, nodeIds: ids },
                    signal: ac.signal,
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
            }
            catch (err) {
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
            }
            finally {
                setIsActing(false);
                setBulkProgressMessage(null);
                endBulkAction(ac);
            }
        });
        if (DESTRUCTIVE_ACTIONS.has(action)) {
            const detail = action === "delete"
                ? "This action cannot be undone."
                : action === "reimage"
                    ? "Running tasks will be requeued and the OS disk will be restored from the source image."
                    : action === "reboot"
                        ? "Affected nodes will restart. Running tasks will be requeued."
                        : "Pending and running tasks finish; the node won't accept new work until scheduling is re-enabled.";
            const skipNote = skippedCount > 0
                ? ` ${formatNumber(skippedCount)} selected node(s) will be skipped because they are in a non-actionable state.`
                : "";
            // Per-state breakdown of the ACTIONABLE set, so operators see
            // exactly what mix of states they're about to act on (e.g.
            // "3 running, 2 idle, 1 starttaskfailed"). Sorted by count desc.
            const stateCounts = new Map();
            for (const n of actionable) {
                stateCounts.set(n.state, ((_d = stateCounts.get(n.state)) !== null && _d !== void 0 ? _d : 0) + 1);
            }
            const breakdown = stateCounts.size > 0
                ? " Breakdown: " +
                    Array.from(stateCounts.entries())
                        .sort((a, b) => b[1] - a[1])
                        .map(([s, n]) => `${formatNumber(n)} ${s}`)
                        .join(", ") +
                    "."
                : "";
            showConfirmation(`${verbCap} ${formatNumber(ids.length)} node${ids.length === 1 ? "" : "s"}?`, `${detail}${skipNote}${breakdown}`, verbCap, true, executeAction);
        }
        else {
            yield executeAction();
        }
    }), [
        orchestrator,
        selectedNodes,
        filterActionable,
        showConfirmation,
        computeBulkResult,
        primaryAccount,
        beginBulkAction,
        endBulkAction,
    ]);
    // ---- Connect to compute node (SSH / RDP) ---------------------------------
    // Two-step flow per https://learn.microsoft.com/azure/batch/pool-endpoint-configuration:
    //   1. POST /pools/{poolId}/nodes/{nodeId}/users — create a short-lived
    //      user with a generated password. Default expiry: now + 24 h.
    //   2. GET  /pools/{poolId}/nodes/{nodeId}/remoteloginsettings — IP+port
    //      for the connection.
    // Dialog surfaces the ready-to-paste connection command (ssh on Linux,
    // mstsc on Windows). The temp user auto-expires; the operator never
    // has to clean up manually unless they kept the dialog open past 24 h.
    const [connectDialog, setConnectDialog] = React.useState({
        open: false,
        node: null,
        state: "idle",
        error: null,
        username: "",
        password: "",
        isWindows: false,
        settings: null,
    });
    const handleConnectNode = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (selectedIds.length !== 1)
            return;
        const nodeId = selectedIds[0];
        const node = state.nodes.find((n) => n.id === nodeId);
        if (!node)
            return;
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
        const CONNECTABLE = new Set(["idle", "running"]);
        if (!CONNECTABLE.has(node.state)) {
            const hint = node.state === "starttaskfailed"
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
            var _a, _b;
            const refImage = node
                .imageReference;
            const publisher = ((_a = refImage === null || refImage === void 0 ? void 0 : refImage.publisher) !== null && _a !== void 0 ? _a : "").toLowerCase();
            return (publisher.includes("windows") ||
                ((_b = node.vmSize) !== null && _b !== void 0 ? _b : "").toLowerCase().includes("windows"));
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
        const pick = (s) => s[Math.floor(Math.random() * s.length)];
        const password = pick(lower) +
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
            const sub = state.subscriptions.find((s) => s.subscriptionId === account.subscriptionId);
            const homeAccountId = sub === null || sub === void 0 ? void 0 : sub.homeAccountId;
            const tenantId = sub === null || sub === void 0 ? void 0 : sub.tenantId;
            if (!homeAccountId) {
                throw new Error("Could not resolve the MSAL account that owns this Batch account's subscription. Sign in with the right Azure account on the Azure Accounts page.");
            }
            const token = yield getBatchTokenForAccount(homeAccountId, tenantId);
            const endpoint = `https://${account.accountName}.${account.region}.batch.azure.com`;
            yield createNodeUser(endpoint, node.poolId, node.nodeId, {
                name: username,
                password,
                isAdmin: true,
                expiryTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            }, token);
            const settings = yield getNodeRemoteLoginSettings(endpoint, node.poolId, node.nodeId, token);
            setConnectDialog((prev) => (Object.assign(Object.assign({}, prev), { state: "ready", settings })));
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
                yield navigator.clipboard.writeText(password);
            }
            catch (_f) {
                /* clipboard blocked */
            }
            try {
                yield fetch("/api/connect/launch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        command: isWindows ? "rdp" : "ssh",
                        user: username,
                        ip: settings.remoteLoginIPAddress,
                        port: settings.remoteLoginPort,
                    }),
                });
            }
            catch (_g) {
                /* launcher unavailable — dialog already shows the command */
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setConnectDialog((prev) => (Object.assign(Object.assign({}, prev), { state: "error", error: msg })));
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
    }), [selectedIds, state.nodes, state.accounts, state.subscriptions]);
    const closeConnectDialog = React.useCallback(() => {
        setConnectDialog((prev) => (Object.assign(Object.assign({}, prev), { open: false })));
    }, []);
    // ---- Bulk delete (grouped by pool) ---------------------------------------
    // Idempotency: pool-level remove-nodes API; a node that's already gone
    // returns 404 which the orchestrator treats as success. Safe to retry.
    const handleDeleteNodes = React.useCallback(() => {
        var _a;
        const ids = selectedIds;
        if (ids.length === 0)
            return;
        const poolSet = new Set();
        for (const id of ids) {
            const node = state.nodes.find((n) => n.id === id);
            if (node)
                poolSet.add(`${node.accountName}/${node.poolId}`);
        }
        const executeDelete = () => __awaiter(void 0, void 0, void 0, function* () {
            var _b;
            const ac = beginBulkAction();
            setIsActing(true);
            setError(null);
            setBulkResult(null);
            setBulkProgressMessage(`Deleting ${formatNumber(ids.length)} node${ids.length === 1 ? "" : "s"} across ${poolSet.size} pool(s)...`);
            const actor = (_b = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) !== null && _b !== void 0 ? _b : "ui";
            try {
                yield orchestrator.execute({
                    action: "delete_nodes",
                    payload: { nodeIds: ids },
                    signal: ac.signal,
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
            }
            catch (err) {
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
            }
            finally {
                setIsActing(false);
                setBulkProgressMessage(null);
                endBulkAction(ac);
            }
        });
        // Per-state breakdown shown in the dialog so the operator understands
        // exactly which states they're deleting (delete is allowed in every
        // state but the mix matters — deleting 5 running + 1 unusable is a
        // very different operation from deleting 6 idle).
        const stateCounts = new Map();
        for (const id of ids) {
            const node = state.nodes.find((n) => n.id === id);
            if (node) {
                stateCounts.set(node.state, ((_a = stateCounts.get(node.state)) !== null && _a !== void 0 ? _a : 0) + 1);
            }
        }
        const breakdown = stateCounts.size > 0
            ? " Breakdown: " +
                Array.from(stateCounts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([s, n]) => `${formatNumber(n)} ${s}`)
                    .join(", ") +
                "."
            : "";
        showConfirmation(`Delete ${formatNumber(ids.length)} node${ids.length === 1 ? "" : "s"}?`, `This will affect ${poolSet.size} pool(s). Running tasks on affected nodes will be requeued. This action cannot be undone.${breakdown}`, "Delete", true, executeDelete);
    }, [
        selectedIds,
        state.nodes,
        orchestrator,
        showConfirmation,
        primaryAccount,
        beginBulkAction,
        endBulkAction,
    ]);
    // ---- Bulk recreate --------------------------------------------------------
    // Recreate = remove + bump pool target so the scheduler re-allocates.
    // Idempotent: extra calls just keep the pool at the same target so the
    // scheduler treats them as no-ops.
    const handleRecreateNodes = React.useCallback(() => {
        const ids = selectedIds;
        if (ids.length === 0)
            return;
        const executeRecreate = () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            const ac = beginBulkAction();
            setIsActing(true);
            setError(null);
            const actor = (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) !== null && _a !== void 0 ? _a : "ui";
            try {
                yield orchestrator.execute({
                    action: "recreate_nodes",
                    payload: { nodeIds: ids },
                    signal: ac.signal,
                });
                auditLog.record({
                    actor,
                    action: "recreate_nodes",
                    target: `${ids.length} node(s)`,
                    status: "success",
                    details: { attempted: ids.length, sampleIds: ids.slice(0, 16) },
                });
            }
            catch (err) {
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
            }
            finally {
                setIsActing(false);
                endBulkAction(ac);
            }
        });
        showConfirmation(`Recreate ${formatNumber(ids.length)} node${ids.length === 1 ? "" : "s"}?`, "Nodes will be removed and pool targets restored to trigger fresh allocation.", "Recreate", false, executeRecreate);
    }, [
        selectedIds,
        orchestrator,
        showConfirmation,
        primaryAccount,
        beginBulkAction,
        endBulkAction,
    ]);
    // ---- Recover preempted ----------------------------------------------------
    const handleRecoverPreempted = React.useCallback(() => {
        const preemptedCount = state.nodes.filter((n) => n.state === "preempted").length;
        if (preemptedCount === 0) {
            setError("No preempted nodes to recover.");
            return;
        }
        const executeRecover = () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            const ac = beginBulkAction();
            setIsActing(true);
            setError(null);
            const actor = (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) !== null && _a !== void 0 ? _a : "ui";
            try {
                yield orchestrator.execute({
                    action: "recover_preempted",
                    payload: {},
                    signal: ac.signal,
                });
                auditLog.record({
                    actor,
                    action: "recover_preempted",
                    target: `${preemptedCount} preempted node(s)`,
                    status: "success",
                    details: { triggeredBy: "manual", count: preemptedCount },
                });
            }
            catch (err) {
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
            }
            finally {
                setIsActing(false);
                endBulkAction(ac);
            }
        });
        showConfirmation(`Recover ${formatNumber(preemptedCount)} preempted node${preemptedCount === 1 ? "" : "s"}?`, "This will re-request low-priority capacity for affected pools.", "Recover", false, executeRecover);
    }, [
        state.nodes,
        orchestrator,
        showConfirmation,
        primaryAccount,
        beginBulkAction,
        endBulkAction,
    ]);
    // ---- Bulk reimage of stuck nodes -----------------------------------------
    // One-click recovery for nodes flagged by the stuck-state detector. Uses
    // the same orchestrator path as the bulk Reimage button, but pre-selects
    // EVERY stuck node so the operator doesn't have to manually multi-select.
    const handleReimageStuck = React.useCallback(() => {
        if (stuckNodes.length === 0)
            return;
        const ids = stuckNodes.map((n) => n.id);
        const executeReimage = () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            const ac = beginBulkAction();
            setIsActing(true);
            setError(null);
            setBulkResult(null);
            setBulkProgressMessage(`Reimaging ${formatNumber(ids.length)} stuck node${ids.length === 1 ? "" : "s"}...`);
            const actor = (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) !== null && _a !== void 0 ? _a : "ui";
            try {
                yield orchestrator.execute({
                    action: "bulk_node_action",
                    payload: { actionType: "reimage", nodeIds: ids },
                    signal: ac.signal,
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
            }
            catch (err) {
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
            }
            finally {
                setIsActing(false);
                setBulkProgressMessage(null);
                endBulkAction(ac);
            }
        });
        showConfirmation(`Reimage ${formatNumber(stuckNodes.length)} stuck node${stuckNodes.length === 1 ? "" : "s"}?`, `These nodes have been transitioning for more than ${stuckThresholdMin} minute${stuckThresholdMin === 1 ? "" : "s"} — typically a hung start-task or a back-end deadlock. Reimage restores the OS disk from the source image; any in-progress work is requeued.`, "Reimage", true, executeReimage);
    }, [
        stuckNodes,
        orchestrator,
        showConfirmation,
        computeBulkResult,
        primaryAccount,
        stuckThresholdMin,
        beginBulkAction,
        endBulkAction,
    ]);
    // ---- DataTable columns ---------------------------------------------------
    const columns = React.useMemo(() => [
        {
            id: "id",
            header: "ID",
            cell: (row) => {
                var _a;
                return (React.createElement("span", { className: "font-mono text-xs" }, (_a = row.nodeId) !== null && _a !== void 0 ? _a : row.id));
            },
            sort: (a, b) => { var _a, _b; return compareStrings((_a = a.nodeId) !== null && _a !== void 0 ? _a : a.id, (_b = b.nodeId) !== null && _b !== void 0 ? _b : b.id); },
            csv: (row) => { var _a; return (_a = row.nodeId) !== null && _a !== void 0 ? _a : row.id; },
        },
        {
            id: "region",
            header: "Region",
            cell: (row) => React.createElement("span", { className: "text-xs" }, row.region),
            sort: (a, b) => compareStrings(a.region, b.region),
            csv: (row) => row.region,
        },
        {
            id: "account",
            header: "Account",
            cell: (row) => React.createElement("span", { className: "text-xs" }, row.accountName),
            sort: (a, b) => compareStrings(a.accountName, b.accountName),
            csv: (row) => row.accountName,
        },
        {
            id: "pool",
            header: "Pool",
            cell: (row) => React.createElement("span", { className: "text-xs" }, row.poolId),
            sort: (a, b) => compareStrings(a.poolId, b.poolId),
            csv: (row) => row.poolId,
        },
        {
            id: "state",
            header: "State",
            cell: (row) => (React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                row.state === "running" && (React.createElement("span", { className: "live-pulse-dot shrink-0", style: { ["--live-tone"]: "var(--success)" }, "aria-hidden": "true" })),
                React.createElement(StatusBadge, { status: row.state }))),
            sort: (a, b) => compareStrings(a.state, b.state),
            csv: (row) => row.state,
        },
        {
            id: "vmSize",
            header: "VM size",
            cell: (row) => row.vmSize ? (React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" }, row.vmSize)) : (React.createElement("span", { className: "text-xs text-muted-foreground/60" }, "\u2014")),
            sort: (a, b) => { var _a, _b; return compareStrings((_a = a.vmSize) !== null && _a !== void 0 ? _a : "", (_b = b.vmSize) !== null && _b !== void 0 ? _b : ""); },
            csv: (row) => { var _a; return (_a = row.vmSize) !== null && _a !== void 0 ? _a : ""; },
        },
        {
            id: "ipAddress",
            header: "IP address",
            cell: (row) => row.ipAddress ? (React.createElement(CopyableIp, { ip: row.ipAddress })) : (React.createElement("span", { className: "text-xs text-muted-foreground/60" }, "\u2014")),
            csv: (row) => { var _a; return (_a = row.ipAddress) !== null && _a !== void 0 ? _a : ""; },
        },
        {
            id: "totalTasks",
            header: "Total tasks",
            cell: (row) => {
                var _a;
                return (React.createElement("span", { className: "tabular-nums text-xs" }, formatNumber((_a = row.totalTasksRun) !== null && _a !== void 0 ? _a : 0)));
            },
            sort: (a, b) => { var _a, _b; return compareNumbers((_a = a.totalTasksRun) !== null && _a !== void 0 ? _a : 0, (_b = b.totalTasksRun) !== null && _b !== void 0 ? _b : 0); },
            csv: (row) => { var _a; return (_a = row.totalTasksRun) !== null && _a !== void 0 ? _a : 0; },
        },
        {
            id: "runningTasks",
            header: "Running tasks",
            cell: (row) => {
                var _a;
                return (React.createElement("span", { className: "tabular-nums text-xs" }, formatNumber((_a = row.runningTasksCount) !== null && _a !== void 0 ? _a : 0)));
            },
            sort: (a, b) => { var _a, _b; return compareNumbers((_a = a.runningTasksCount) !== null && _a !== void 0 ? _a : 0, (_b = b.runningTasksCount) !== null && _b !== void 0 ? _b : 0); },
            csv: (row) => { var _a; return (_a = row.runningTasksCount) !== null && _a !== void 0 ? _a : 0; },
        },
        {
            id: "lastBootTime",
            header: "Last boot",
            cell: (row) => {
                var _a;
                return (React.createElement("span", { className: "text-xs text-muted-foreground", title: (_a = row.lastBootTime) !== null && _a !== void 0 ? _a : "" }, row.lastBootTime ? formatRelativeTime(row.lastBootTime) : "—"));
            },
            sort: (a, b) => {
                const aT = a.lastBootTime ? new Date(a.lastBootTime).getTime() : 0;
                const bT = b.lastBootTime ? new Date(b.lastBootTime).getTime() : 0;
                return compareNumbers(aT, bT);
            },
            csv: (row) => { var _a; return (_a = row.lastBootTime) !== null && _a !== void 0 ? _a : ""; },
        },
        {
            // Stuck flag — surfaces an inline warning chip on the row for any
            // node currently flagged by the stuck-state detector. Hidden by
            // default; opt-in from the column-visibility menu when triaging.
            id: "stuckFlag",
            header: "Stuck?",
            defaultHidden: true,
            cell: (row) => stuckIdSet.has(row.id) ? (React.createElement("span", { className: "inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-warning" },
                React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": "true" }),
                "stuck")) : (React.createElement("span", { className: "text-xs text-muted-foreground/40" }, "\u2014")),
            csv: (row) => (stuckIdSet.has(row.id) ? "stuck" : ""),
        },
        {
            // Per-row copy buttons — small hover-revealed icons so the
            // operator can grab a node ID for a CLI command or paste it into
            // a support ticket without going through the bulk-action toolbar.
            id: "copy",
            header: "",
            width: "w-16",
            cell: (row) => {
                var _a;
                return (React.createElement(CopyButton, { label: "node ID", value: (_a = row.nodeId) !== null && _a !== void 0 ? _a : row.id, extraLabel: `pool: ${row.poolId}` }));
            },
        },
    ], [stuckIdSet]);
    // ---- Selection helper ----------------------------------------------------
    const handleSelectionChange = React.useCallback((next) => {
        setSelection(next);
    }, []);
    const selectionCount = selection.size;
    const hasSelection = selectionCount > 0;
    // ---- Filter setters (URL-synced) -----------------------------------------
    const handleRegionChange = React.useCallback((value) => setFilters({ region: value === "__all" ? "" : value }), [setFilters]);
    const handleStateChange = React.useCallback((value) => setFilters({ state: value === "__all" ? "" : value }), [setFilters]);
    const handlePoolChange = React.useCallback((value) => setFilters({ pool: value === "__all" ? "" : value }), [setFilters]);
    const handlePriorityChange = React.useCallback((value) => setFilters({
        priority: (value === "__all" ? "" : value),
    }), [setFilters]);
    // VM-size filter handlers removed along with the picker (see comment
    // in the toolbar JSX). `vmSize` URL state is preserved for backward
    // compatibility with old bookmarks but no UI sets it anymore.
    // Depend on the stable `search.setQuery` reference (provided by
    // useSearch) rather than the whole `search` object — the latter is a
    // fresh object on every render, which would re-create this callback
    // every render and cascade through every memoized child that takes
    // `clearFilters` as a prop. Same pattern used for handleExportJson.
    const searchSetQuery = search.setQuery;
    const clearFilters = React.useCallback(() => {
        setFilters({
            region: "",
            state: "",
            pool: "",
            priority: "",
            vmSize: "",
        });
        setQuickFilter("all");
        searchSetQuery("");
    }, [setFilters, searchSetQuery]);
    const filtersActive = Boolean(regionFilter ||
        stateFilter ||
        poolFilter ||
        priorityFilter ||
        vmSizeFilter ||
        quickFilter !== "all" ||
        search.query);
    // ---- Copy selected IDs ---------------------------------------------------
    // Copies newline-separated node IDs of the current selection to the
    // clipboard. Use case: paste into a CLI loop or a support ticket. Falls
    // back to the synchronous execCommand path if the async clipboard API is
    // blocked (Edge/iframe permissions).
    const handleCopySelectedIds = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _h;
        if (selectedNodes.length === 0)
            return;
        const text = selectedNodes
            .map((n) => { var _a; return (_a = n.nodeId) !== null && _a !== void 0 ? _a : n.id; })
            .join("\n");
        try {
            if ((_h = navigator.clipboard) === null || _h === void 0 ? void 0 : _h.writeText) {
                yield navigator.clipboard.writeText(text);
            }
            else {
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
        }
        catch (_j) {
            /* clipboard blocked */
        }
    }), [selectedNodes]);
    // ---- Export the current FILTERED view as JSON ----------------------------
    // DataTable already provides a CSV export. JSON preserves the field
    // shape (numbers stay numbers, optional fields stay optional) so the
    // operator can pipe the output through jq / Power-Query without
    // string-flattening losses. The CSV export honors visible columns; we
    // intentionally export the full record set here for parity with what
    // shows up in the store.
    const handleExportJson = React.useCallback(() => {
        const rows = visibleNodes.map((n) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            return ({
                id: n.id,
                nodeId: n.nodeId,
                accountId: n.accountId,
                accountName: n.accountName,
                region: n.region,
                poolId: n.poolId,
                state: n.state,
                vmSize: (_a = n.vmSize) !== null && _a !== void 0 ? _a : null,
                ipAddress: (_b = n.ipAddress) !== null && _b !== void 0 ? _b : null,
                isDedicated: n.isDedicated,
                lastBootTime: (_c = n.lastBootTime) !== null && _c !== void 0 ? _c : null,
                totalTasksRun: (_d = n.totalTasksRun) !== null && _d !== void 0 ? _d : 0,
                runningTasksCount: (_e = n.runningTasksCount) !== null && _e !== void 0 ? _e : 0,
                schedulingState: (_f = n.schedulingState) !== null && _f !== void 0 ? _f : null,
                startTaskExitCode: (_g = n.startTaskExitCode) !== null && _g !== void 0 ? _g : null,
                subscriptionId: (_h = n.subscriptionId) !== null && _h !== void 0 ? _h : null,
                stuck: stuckIdSet.has(n.id),
            });
        });
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
        const rows = visibleNodes.map((n) => {
            var _a, _b, _c, _d, _e, _f, _g;
            return [
                n.id,
                n.nodeId,
                n.accountName,
                n.region,
                n.poolId,
                n.state,
                (_a = n.vmSize) !== null && _a !== void 0 ? _a : "",
                (_b = n.ipAddress) !== null && _b !== void 0 ? _b : "",
                n.isDedicated ? "dedicated" : "lowpriority",
                (_c = n.lastBootTime) !== null && _c !== void 0 ? _c : "",
                (_d = n.totalTasksRun) !== null && _d !== void 0 ? _d : 0,
                (_e = n.runningTasksCount) !== null && _e !== void 0 ? _e : 0,
                (_f = n.schedulingState) !== null && _f !== void 0 ? _f : "",
                (_g = n.startTaskExitCode) !== null && _g !== void 0 ? _g : "",
                stuckIdSet.has(n.id) ? "stuck" : "",
            ];
        });
        const stamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, 19);
        downloadCsv(`nodes-${stamp}.csv`, [headers, ...rows]);
    }, [visibleNodes, stuckIdSet]);
    // ---- Forensic export (stuck + error nodes) -------------------------------
    //
    // Why a separate export for these:
    //
    // A compromised compute node is an extremely high-value pivot target in
    // any cloud-native breach — once a tenant attacker has shell on a node,
    // the local IMDS endpoint (`169.254.169.254/metadata/identity/oauth2/
    // token` for VM-backed pools; `localhost:50342/oauth2/token` on App
    // Service-style hosts) hands out short-lived MSI tokens for whatever
    // RBAC scope the pool's identity holds. See `_analysis_netspi.md` §I
    // (IMDS Variants) for the full per-host token endpoint matrix and §II
    // for the post-token enumeration paths. A `starttaskfailed` or
    // `unusable` node that lingers for hours often masks a real failure
    // (driver crash, NSG hairpin, custom-image init script that pulled an
    // attacker-controlled payload) that incident-response wants captured
    // BEFORE the operator reimages the disk and erases the evidence.
    //
    // The forensic export captures the still-observable state at the
    // moment of triage so the IR analyst can correlate this snapshot
    // against the audit log even after the node has been recycled. Fields
    // chosen:
    //   - state + lastBootTime — when did this node last transition?
    //   - schedulingState — was scheduling already disabled (a manual
    //     "quarantine" gesture upstream)?
    //   - startTaskExitCode — the canonical signal for "the install
    //     blew up" (non-zero on GPU-driver pools is the #1 cause of
    //     `starttaskfailed`).
    //   - runningTasksCount — tasks lost to the recycle if the node is
    //     about to be reimaged.
    //   - vmSize + region + poolId — pivot keys; the same poolId across
    //     many `starttaskfailed` nodes points at a broken start script.
    //   - errors[] / error — the raw service-side error tail.
    //
    // The output stamp matches the JSON export for easy IR collation.
    const handleForensicExport = React.useCallback(() => {
        var _a;
        const forensicNodes = state.nodes.filter((n) => stuckIdSet.has(n.id) || ERROR_STATES.has(n.state));
        if (forensicNodes.length === 0)
            return;
        const now = Date.now();
        const rows = forensicNodes.map((n) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            const bootMs = n.lastBootTime
                ? new Date(n.lastBootTime).getTime()
                : NaN;
            const ageMinutes = Number.isFinite(bootMs)
                ? Math.round((now - bootMs) / 60000)
                : null;
            return {
                id: n.id,
                nodeId: n.nodeId,
                accountName: n.accountName,
                subscriptionId: (_a = n.subscriptionId) !== null && _a !== void 0 ? _a : null,
                region: n.region,
                poolId: n.poolId,
                vmSize: (_b = n.vmSize) !== null && _b !== void 0 ? _b : null,
                ipAddress: (_c = n.ipAddress) !== null && _c !== void 0 ? _c : null,
                isDedicated: n.isDedicated,
                state: n.state,
                schedulingState: (_d = n.schedulingState) !== null && _d !== void 0 ? _d : null,
                lastBootTime: (_e = n.lastBootTime) !== null && _e !== void 0 ? _e : null,
                ageMinutesSinceBoot: ageMinutes,
                startTaskExitCode: (_f = n.startTaskExitCode) !== null && _f !== void 0 ? _f : null,
                runningTasksCount: (_g = n.runningTasksCount) !== null && _g !== void 0 ? _g : 0,
                totalTasksRun: (_h = n.totalTasksRun) !== null && _h !== void 0 ? _h : 0,
                stuck: stuckIdSet.has(n.id),
                errorState: ERROR_STATES.has(n.state),
                errors: (_j = n.errors) !== null && _j !== void 0 ? _j : [],
                errorTail: (_k = n.error) !== null && _k !== void 0 ? _k : null,
            };
        });
        const stamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, 19);
        downloadJson(`nodes-forensic-${stamp}.json`, {
            exportedAt: new Date().toISOString(),
            purpose: "Forensic snapshot of stuck + error-state nodes for incident review " +
                "before reimage/delete erases service-side state. See " +
                "_analysis_netspi.md §I for compute-node pivot risk context.",
            count: rows.length,
            stuckCount: rows.filter((r) => r.stuck).length,
            errorCount: rows.filter((r) => r.errorState).length,
            stuckThresholdMinutes: stuckThresholdMin,
            nodes: rows,
        });
        auditLog.record({
            actor: (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId) !== null && _a !== void 0 ? _a : "ui",
            action: "forensic_export",
            target: `${rows.length} stuck/error node(s)`,
            status: "success",
            details: {
                stuck: rows.filter((r) => r.stuck).length,
                error: rows.filter((r) => r.errorState).length,
                stuckThresholdMinutes: stuckThresholdMin,
            },
        });
    }, [state.nodes, stuckIdSet, stuckThresholdMin, primaryAccount]);
    // ---- Pre-computed bulk-toolbar action counts ----------------------------
    // The toolbar shows "Reboot (N)" / "Reimage (N)" labels where N is the
    // count of selected nodes that will ACTUALLY run the action (mirroring
    // the orchestrator's pre-filter). Computing these inline in the JSX via
    // an IIFE recomputed three times per render — and the parent re-renders
    // every second (1 Hz now-tick). At fleet scale this is wasted work.
    // Memoize on `selectedNodes` (already memoized) so the toolbar only
    // recomputes on actual selection / store changes.
    const toolbarCounts = React.useMemo(() => {
        let rebootable = 0;
        let reimageable = 0;
        let schedulable = 0;
        for (const n of selectedNodes) {
            if (ACTIONABLE_STATES.has(n.state)) {
                // ACTIONABLE_STATES is the same gate for reboot, reimage, and
                // enable/disable scheduling per `filterActionable`. Walking the
                // list once is N×, walking it three times is 3×N.
                rebootable++;
                reimageable++;
                schedulable++;
            }
        }
        return {
            rebootable,
            reimageable,
            schedulable,
            skippedReboot: selectedNodes.length - rebootable,
            skippedReimage: selectedNodes.length - reimageable,
            skippedSched: selectedNodes.length - schedulable,
        };
    }, [selectedNodes]);
    // ---- "Last refreshed Xs ago" string --------------------------------------
    // Not memoized — depends on Date.now() which we want to re-evaluate on
    // every render. The 1 Hz `setNowTick` interval keeps this fresh.
    const lastRefreshedLabel = lastRefreshedAt == null
        ? null
        : formatRelativeTime(new Date(lastRefreshedAt));
    // ---- Keyboard shortcuts -------------------------------------------------
    // Standard pattern from Gmail / GitHub. `useShortcut` already guards
    // against firing while focus is in an input/textarea/select/contentEditable
    // (via its built-in isEditableTarget filter), so we don't need a manual
    // tagName check anymore.
    //
    //   /        → focus + select the search input
    //   Escape   → clear the search when the search input is focused;
    //              otherwise clear the row selection (if any). Two-stage
    //              dismiss matches the Gmail/Linear/GitHub pattern.
    //   r        → reboot selected (if any actionable; confirmation dialog)
    //   i        → reimage selected (if any actionable; confirmation dialog)
    //   Delete   → delete selected (if any; confirmation dialog)
    const searchInputRef = React.useRef(null);
    useShortcut("/", () => {
        var _a, _b;
        (_a = searchInputRef.current) === null || _a === void 0 ? void 0 : _a.focus();
        (_b = searchInputRef.current) === null || _b === void 0 ? void 0 : _b.select();
    });
    // Escape: two-stage dismiss.
    //   stage 1 — focus is in the search input → clear the search query
    //             (leave focus where it is so the operator can keep typing).
    //   stage 2 — focus is anywhere else AND there's a row selection →
    //             clear the selection. Lets the operator hit Esc as a
    //             one-key "back out of this batch operation" without
    //             reaching for the mouse. We don't preventDefault so
    //             open dialogs / menus still get their native dismiss.
    useShortcut("Escape", () => {
        if (document.activeElement === searchInputRef.current) {
            searchSetQuery("");
            return;
        }
        // Don't fight the global confirmation dialog — if any modal/dialog
        // is open it handles its own Escape. Detect by checking for an
        // open aria-modal element in the document.
        const openModal = document.querySelector('[aria-modal="true"]');
        if (openModal)
            return;
        if (selection.size > 0)
            setSelection(new Set());
    }, { allowInInputs: true, preventDefault: false });
    // r → reboot selected. Disabled while no selection / a bulk op is in
    // flight to avoid accidental double-firing (the hotkey can repeat).
    useShortcut("r", () => {
        if (selection.size === 0 || isActing)
            return;
        void handleNodeAction("reboot");
    }, { enabled: selection.size > 0 && !isActing });
    // i → reimage selected. Uses the same confirmation dialog with the
    // per-state breakdown as the toolbar button — destructive enough to
    // warrant the dialog, common enough to deserve a single-key shortcut
    // (stuck-node recovery is the canonical use case).
    useShortcut("i", () => {
        if (selection.size === 0 || isActing)
            return;
        void handleNodeAction("reimage");
    }, { enabled: selection.size > 0 && !isActing });
    // Delete → delete selected (uses the same confirmation dialog as the
    // toolbar button so the operator gets the per-state breakdown).
    // Intentionally bound to "Delete" only — Backspace is too easy to
    // trigger accidentally while focus is on a non-input element.
    useShortcut("Delete", () => {
        if (selection.size === 0 || isActing)
            return;
        handleDeleteNodes();
    }, { enabled: selection.size > 0 && !isActing });
    // ---- Render branches ------------------------------------------------------
    const initialLoading = isLoading && state.nodes.length === 0;
    const fetchFailed = !isLoading && error !== null && state.nodes.length === 0;
    const noNodes = state.nodes.length === 0 && !isLoading && !fetchFailed;
    // ---- Empty state component (passed to DataTable) -------------------------
    const tableEmpty = (React.createElement(EmptyState, { icon: Server, title: "No nodes match the current filter", description: "Adjust filters or refresh pool info to populate nodes.", action: filtersActive
            ? { label: "Clear filters", onClick: clearFilters }
            : undefined }));
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4", "aria-labelledby": "nodes-heading" },
        React.createElement("div", { className: "relative overflow-hidden rounded-xl border bg-card/50 p-6" },
            React.createElement(DotPattern, { fade: "top-left" }),
            React.createElement(Meteors, { count: 10, tone: "primary" }),
            React.createElement("div", { className: "relative z-10" },
                React.createElement(PageHeader, { title: "Nodes", titleId: "nodes-heading" },
                    React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth() }),
                    React.createElement("div", { className: "relative" },
                        React.createElement(Input, { ref: searchInputRef, type: "search", value: search.query, onChange: (e) => search.setQuery(e.target.value), placeholder: "Search nodes... (press /)", "aria-label": "Search nodes (press forward slash to focus, Escape to clear)", className: "h-8 w-64 pr-7" }),
                        search.query && (React.createElement("button", { type: "button", onClick: () => search.setQuery(""), "aria-label": "Clear search", className: "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground" },
                            React.createElement(X, { className: "h-3 w-3" })))),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("div", { className: "flex items-center gap-2" },
                                React.createElement(Switch, { id: "nodes-auto-refresh", checked: autoRefresh, onCheckedChange: (checked) => setAutoRefresh(checked === true), "aria-label": "Toggle auto-refresh every 30 seconds" }),
                                React.createElement(Label, { htmlFor: "nodes-auto-refresh", className: "cursor-pointer text-xs text-muted-foreground" }, "Auto-refresh (30s)"))),
                        React.createElement(TooltipContent, null,
                            "Re-fetches all nodes across ",
                            createdAccounts.length,
                            " account(s) every 30 seconds.")),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("div", { className: "flex items-center gap-2" },
                                React.createElement(Switch, { id: "nodes-auto-recovery", checked: autoRecovery, onCheckedChange: (checked) => setAutoRecovery(checked === true), "aria-label": "Toggle auto-recovery every 60 seconds" }),
                                React.createElement(Label, { htmlFor: "nodes-auto-recovery", className: "cursor-pointer text-xs text-muted-foreground" }, "Auto-Recovery (60s)"))),
                        React.createElement(TooltipContent, { className: "max-w-xs" }, "Every 60 seconds, if any nodes are in \"preempted\" state, re-requests low-priority capacity for affected pools. Concurrent runs are guarded so a slow recovery won't stack.")),
                    React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: handleRefreshNodes, disabled: isLoading || createdAccounts.length === 0, "aria-label": "Refresh nodes" },
                        React.createElement(RotateCw, { className: cn(isLoading && "animate-spin") }),
                        isLoading
                            ? "Loading..."
                            : `Refresh (${createdAccounts.length} accounts)`),
                    isLoading && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => orchestrator.cancel(), "aria-label": "Stop refreshing", className: "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" },
                        React.createElement(Square, null),
                        "Stop")),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleExportCsv, disabled: visibleNodes.length === 0, "aria-label": "Export current view as CSV" },
                                React.createElement(Download, { className: "h-3.5 w-3.5" }),
                                "CSV")),
                        React.createElement(TooltipContent, null,
                            "Download ",
                            formatNumber(visibleNodes.length),
                            " filtered node(s) as CSV.")),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleExportJson, disabled: visibleNodes.length === 0, "aria-label": "Export current view as JSON" },
                                React.createElement(FileJson, { className: "h-3.5 w-3.5" }),
                                "JSON")),
                        React.createElement(TooltipContent, null,
                            "Download ",
                            formatNumber(visibleNodes.length),
                            " filtered node(s) as JSON (preserves field types)."))),
                lastRefreshedLabel && (React.createElement("div", { className: "mt-2 flex items-center gap-2 text-2xs text-muted-foreground", role: "status", "aria-live": "polite" },
                    React.createElement("span", { className: cn("inline-block h-1.5 w-1.5 rounded-full", isLoading
                            ? "animate-pulse bg-info"
                            : autoRefresh
                                ? "bg-success"
                                : "bg-muted-foreground/50"), "aria-hidden": "true" }),
                    "Refreshed ",
                    lastRefreshedLabel,
                    autoRefresh && " · auto every 30s",
                    autoRecovery && summaryStats.preempted > 0 && (React.createElement("span", { className: "text-warning" },
                        " ",
                        "\u00B7 auto-recovery armed (",
                        summaryStats.preempted,
                        " preempted)")))))),
        error && state.nodes.length > 0 && (React.createElement(Alert, { variant: "destructive", "aria-live": "polite", className: "flex items-start justify-between gap-3" },
            React.createElement(AlertDescription, { className: "flex-1" }, error),
            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => setError(null), "aria-label": "Dismiss error", className: "-mr-1 -mt-1 h-6 text-destructive hover:bg-destructive/10" }, "Dismiss"))),
        bulkProgressMessage && (React.createElement(Alert, { variant: "info", "aria-live": "polite", role: "status" },
            React.createElement(Loader2, { className: "animate-spin" }),
            React.createElement(AlertDescription, null, bulkProgressMessage))),
        bulkResult && !bulkProgressMessage && (React.createElement(Alert, { variant: bulkResult.failed === 0
                ? "success"
                : bulkResult.succeeded === 0
                    ? "destructive"
                    : "warning", "aria-live": "polite", className: "flex items-start justify-between gap-3" },
            React.createElement(AlertDescription, { className: "flex-1" },
                "Bulk ",
                bulkResult.label,
                ":",
                " ",
                React.createElement("strong", null, formatNumber(bulkResult.succeeded)),
                " succeeded,",
                " ",
                React.createElement("strong", null, formatNumber(bulkResult.failed)),
                " failed.",
                bulkResult.failedIds.length > 0 && (React.createElement(React.Fragment, null,
                    " ",
                    "Failed node IDs:",
                    " ",
                    React.createElement("code", { className: "font-mono text-2xs" },
                        bulkResult.failedIds.slice(0, 8).join(", "),
                        bulkResult.failedIds.length > 8
                            ? `, +${bulkResult.failedIds.length - 8} more`
                            : "")))),
            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => setBulkResult(null), "aria-label": "Dismiss result summary", className: "-mr-1 -mt-1 h-6" }, "Dismiss"))),
        summaryStats.total > 0 && (React.createElement("div", { role: "group", "aria-label": "Fleet insights", className: "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4" },
            React.createElement("div", { className: "flex items-center gap-4 rounded-md border border-border bg-card p-4" },
                React.createElement(Donut, { segments: nodeStateDonut, size: 96, thickness: 14, centerLabel: formatNumber(summaryStats.total), centerSubLabel: "nodes" }),
                React.createElement("div", { className: "min-w-0 flex-1" },
                    React.createElement("h3", { className: "m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground" }, "State distribution"),
                    React.createElement(DonutLegend, { segments: nodeStateDonut, className: "mt-2" }))),
            React.createElement("div", { className: "rounded-md border border-border bg-card p-4" },
                React.createElement("div", { className: "flex flex-wrap items-baseline justify-between gap-2" },
                    React.createElement("h3", { className: "m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Idle nodes (\u2265 30 min)"),
                    React.createElement("span", { className: cn("rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider", idleWasteNodes.length === 0
                            ? "bg-success/15 text-success"
                            : idleWasteNodes.length < 3
                                ? "bg-info/15 text-info"
                                : "bg-warning/15 text-warning") }, idleWasteNodes.length === 0
                        ? "no waste"
                        : `${idleWasteNodes.length} idle`)),
                idleWasteNodes.length === 0 ? (React.createElement("p", { className: "mt-2 text-2xs text-muted-foreground" }, "No nodes have been idle for more than 30 minutes \u2014 fleet utilization looks healthy.")) : (React.createElement("ul", { className: "mt-2 flex flex-col gap-1 text-2xs" },
                    idleWasteNodes.slice(0, 5).map((n) => (React.createElement("li", { key: n.id, className: "flex items-center gap-2 truncate" },
                        React.createElement("span", { className: "inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-info", "aria-hidden": "true" }),
                        React.createElement("button", { type: "button", onClick: () => {
                                // Pre-fill the search field with the node id so the
                                // table scrolls to / highlights it.
                                search.setQuery(n.nodeId);
                            }, className: "truncate font-mono text-foreground hover:underline", title: `${n.accountName} / ${n.poolId}` }, n.nodeId),
                        React.createElement("span", { className: "ml-auto shrink-0 text-muted-foreground tabular-nums" }, n.lastBootTime
                            ? formatRelativeTime(n.lastBootTime)
                            : "—")))),
                    idleWasteNodes.length > 5 && (React.createElement("li", { className: "text-muted-foreground" },
                        "+ ",
                        idleWasteNodes.length - 5,
                        " more"))))),
            React.createElement("div", { className: "rounded-md border border-border bg-card p-4" },
                React.createElement("div", { className: "flex flex-wrap items-baseline justify-between gap-2" },
                    React.createElement("h3", { className: "m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                        "Stuck nodes (> ",
                        stuckThresholdMin,
                        " min)"),
                    React.createElement("span", { className: cn("rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider", stuckNodes.length === 0
                            ? "bg-success/15 text-success"
                            : stuckNodes.length < 3
                                ? "bg-warning/15 text-warning"
                                : "bg-destructive/15 text-destructive") }, stuckNodes.length === 0
                        ? "all clear"
                        : `${stuckNodes.length} stuck`)),
                React.createElement("div", { className: "mt-2 flex items-center gap-2" },
                    React.createElement(Label, { htmlFor: "nodes-stuck-threshold", className: "text-2xs text-muted-foreground shrink-0" }, "Threshold"),
                    React.createElement("input", { id: "nodes-stuck-threshold", type: "range", min: STUCK_THRESHOLD_MIN_MIN, max: STUCK_THRESHOLD_MAX_MIN, step: 1, value: stuckThresholdMin, onChange: (e) => setStuckThresholdMin(Number(e.currentTarget.value)), "aria-label": `Stuck-node threshold in minutes; current value ${stuckThresholdMin}`, "aria-valuemin": STUCK_THRESHOLD_MIN_MIN, "aria-valuemax": STUCK_THRESHOLD_MAX_MIN, "aria-valuenow": stuckThresholdMin, "aria-valuetext": `${stuckThresholdMin} minute${stuckThresholdMin === 1 ? "" : "s"}`, className: "h-1 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-warning" }),
                    React.createElement("span", { className: "tabular-nums text-2xs text-muted-foreground w-12 text-right" },
                        stuckThresholdMin,
                        " min")),
                stuckNodes.length === 0 ? (React.createElement("p", { className: "mt-2 text-2xs text-muted-foreground" },
                    "No nodes have been transitioning for more than",
                    " ",
                    stuckThresholdMin,
                    " minute",
                    stuckThresholdMin === 1 ? "" : "s",
                    " \u2014 ramp-up and reimage cycles look healthy.")) : (React.createElement(React.Fragment, null,
                    React.createElement("ul", { className: "mt-2 flex flex-col gap-1 text-2xs" },
                        stuckNodes.slice(0, 4).map((n) => (React.createElement("li", { key: n.id, className: "flex items-center gap-2 truncate" },
                            React.createElement(AlertTriangle, { className: "h-3 w-3 shrink-0 text-warning", "aria-hidden": "true" }),
                            React.createElement("button", { type: "button", onClick: () => {
                                    search.setQuery(n.nodeId);
                                    setQuickFilter("stuck");
                                }, className: "truncate font-mono text-foreground hover:underline", title: `${n.accountName} / ${n.poolId} · state=${n.state}` }, n.nodeId),
                            React.createElement("span", { className: "shrink-0 rounded bg-warning/15 px-1 py-0 text-2xs font-medium uppercase text-warning" }, n.state),
                            React.createElement("span", { className: "ml-auto shrink-0 text-muted-foreground tabular-nums" }, n.lastBootTime
                                ? formatRelativeTime(n.lastBootTime)
                                : "—")))),
                        stuckNodes.length > 4 && (React.createElement("li", { className: "text-muted-foreground" },
                            "+ ",
                            stuckNodes.length - 4,
                            " more"))),
                    React.createElement("div", { className: "mt-3 flex flex-wrap items-center gap-2" },
                        React.createElement(Button, { type: "button", variant: "outline", size: "xs", onClick: () => setQuickFilter("stuck"), "aria-label": "Filter table to stuck nodes", className: "text-2xs" }, "Show in table"),
                        React.createElement(Button, { type: "button", variant: "outline", size: "xs", onClick: handleReimageStuck, disabled: isActing, "aria-label": "Reimage all stuck nodes", className: "border-warning/50 text-warning text-2xs hover:bg-warning/10 hover:text-warning" },
                            React.createElement(Wrench, { className: "h-3 w-3" }),
                            "Reimage stuck"))))),
            React.createElement("div", { className: "rounded-md border border-border bg-card p-4" },
                React.createElement("h3", { className: "m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground" }, "VM size frequency"),
                vmSizeBars.length === 0 ? (React.createElement("p", { className: "mt-2 text-2xs text-muted-foreground" }, "No nodes have a reported VM size.")) : (React.createElement(MiniBar, { items: vmSizeBars, maxItems: 8, ariaLabel: "VM size frequency", className: "mt-2" }))))),
        React.createElement("div", { className: "relative flex flex-wrap gap-2 overflow-hidden rounded-xl p-1", role: "group", "aria-label": "Node summary statistics" },
            React.createElement(BorderBeam, { size: 200, duration: 8 }),
            React.createElement(StatCard, { label: "Total", value: summaryStats.total, tooltip: "All nodes loaded across every connected Batch account." }),
            React.createElement(StatCard, { label: "Running", value: summaryStats.running, tone: "info", tooltip: "Nodes actively executing one or more tasks." }),
            React.createElement(StatCard, { label: "Idle", value: summaryStats.idle, tooltip: "Nodes ready to accept work. If many remain idle for long, consider lowering the pool's target count." }),
            React.createElement(StatCard, { label: "Preempted", value: summaryStats.preempted, tone: "destructive", tooltip: "Low-priority nodes that Azure reclaimed. Use Recover preempted to re-request capacity." }),
            React.createElement(StatCard, { label: "Transitioning", value: summaryStats.transitioning, tone: "warning", tooltip: `Nodes in creating, starting, rebooting, reimaging, leavingpool, or waiting-for-start-task. Brief is normal; > ${stuckThresholdMin} min is flagged as stuck.` }),
            React.createElement(StatCard, { label: "Stuck", value: summaryStats.stuck, tone: summaryStats.stuck > 0 ? "destructive" : undefined, tooltip: `Nodes transitioning for more than ${stuckThresholdMin} minute${stuckThresholdMin === 1 ? "" : "s"}. Almost always a hung start-task; reimage usually clears them.` }),
            React.createElement(StatCard, { label: "Errors", value: summaryStats.errors, tone: "destructive", tooltip: "starttaskfailed + unusable + unknown. Check start-task stderr or NSG configuration." }),
            React.createElement(StatCard, { label: "Running tasks", value: summaryStats.runningTasks, tone: "info", tooltip: "Sum of running tasks across all nodes \u2014 fleet workload right now." })),
        summaryStats.total > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-sm", role: "group", "aria-label": "Quick filter chips" }, [
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
            {
                key: "withActiveJobs",
                label: "With active jobs",
                count: summaryStats.withActiveJobs,
            },
        ].map((chip) => (React.createElement("button", { key: chip.key, type: "button", onClick: () => setQuickFilter(chip.key), "aria-pressed": quickFilter === chip.key, className: cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", quickFilter === chip.key
                ? ("warning" in chip ? chip.warning : false) && chip.count > 0
                    ? "bg-warning/20 text-warning"
                    : "bg-primary/15 text-primary"
                : ("warning" in chip ? chip.warning : false) && chip.count > 0
                    ? "text-warning hover:bg-warning/10"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground") },
            chip.label,
            React.createElement("span", { className: "ml-1.5 tabular-nums opacity-70" }, formatNumber(chip.count))))))),
        React.createElement("div", { className: "flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm" },
            React.createElement(FilterSelect, { id: "nodes-region-filter", label: "Region", value: regionFilter, options: regionOptions, onChange: handleRegionChange }),
            React.createElement(FilterSelect, { id: "nodes-state-filter", label: "State", value: stateFilter, options: ALL_NODE_STATES, onChange: handleStateChange }),
            React.createElement(FilterSelect, { id: "nodes-pool-filter", label: "Pool", value: poolFilter, options: poolOptions, onChange: handlePoolChange }),
            React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement(Label, { htmlFor: "nodes-priority-filter", className: "text-xs text-muted-foreground" }, "Priority"),
                React.createElement(Select, { value: priorityFilter || "__all", onValueChange: handlePriorityChange },
                    React.createElement(SelectTrigger, { id: "nodes-priority-filter", className: "h-8 w-[160px] text-xs", "aria-label": "Filter by priority" },
                        React.createElement(SelectValue, { placeholder: "All priorities" })),
                    React.createElement(SelectContent, null,
                        React.createElement(SelectItem, { value: "__all" }, "All priorities"),
                        React.createElement(SelectItem, { value: "dedicated" }, "Dedicated"),
                        React.createElement(SelectItem, { value: "lowpriority" }, "Low priority")))),
            filtersActive && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearFilters, "aria-label": "Clear all filters (facets, quick filter, and search)", className: "self-end" }, "Clear filters")),
            React.createElement("div", { className: "ml-auto self-end text-xs text-muted-foreground", role: "status", "aria-live": "polite" },
                React.createElement("span", { className: "tabular-nums" }, formatNumber(visibleNodes.length)),
                " ",
                "of",
                " ",
                React.createElement("span", { className: "tabular-nums" }, formatNumber(state.nodes.length)),
                " ",
                "shown \u00B7",
                " ",
                React.createElement("span", { className: "tabular-nums" }, formatNumber(selectionCount)),
                " ",
                "selected",
                quickFilter !== "all" && (React.createElement(React.Fragment, null,
                    " ",
                    "\u00B7",
                    " ",
                    React.createElement("span", { className: "rounded bg-primary/10 px-1 py-0.5 text-primary" },
                        "quick: ",
                        quickFilter))))),
        React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Fleet actions" },
            React.createElement(BulkActionButton, { icon: Heart, label: `Recover preempted (${summaryStats.preempted})`, ariaLabel: `Recover ${summaryStats.preempted} preempted nodes`, onClick: handleRecoverPreempted, disabled: isActing || summaryStats.preempted === 0, disabledReason: summaryStats.preempted === 0
                    ? "No preempted nodes to recover"
                    : undefined, tone: "warning" }),
            React.createElement(BulkActionButton, { icon: Wrench, label: `Reimage stuck (${summaryStats.stuck})`, ariaLabel: `Reimage ${summaryStats.stuck} stuck nodes`, onClick: handleReimageStuck, disabled: isActing || summaryStats.stuck === 0, disabledReason: summaryStats.stuck === 0
                    ? "No stuck nodes detected"
                    : undefined, tone: "warning" }),
            React.createElement(BulkActionButton, { icon: FileJson, label: `Forensic export (${summaryStats.stuck + summaryStats.errors})`, ariaLabel: `Forensic export of ${summaryStats.stuck + summaryStats.errors} stuck or error-state node(s)`, onClick: handleForensicExport, disabled: isActing || summaryStats.stuck + summaryStats.errors === 0, disabledReason: summaryStats.stuck + summaryStats.errors === 0
                    ? "No stuck or error-state nodes — nothing to capture"
                    : "Capture stuck + error-state nodes to JSON for incident review before reimage/delete erases the evidence" })),
        (isActing || (isLoading && state.nodes.length > 0)) && (React.createElement("div", { className: "flex flex-col gap-1", role: "status", "aria-live": "polite" },
            React.createElement("span", { className: "text-xs text-muted-foreground" }, isActing ? "Performing action..." : "Refreshing nodes..."),
            React.createElement(Progress, { indeterminate: true, "aria-label": "In progress" }))),
        fetchFailed && (React.createElement(ErrorState, { message: "Failed to load nodes", detail: error !== null && error !== void 0 ? error : undefined, onRetry: handleRefreshNodes })),
        noNodes && !fetchFailed && (React.createElement(EmptyState, { icon: Server, title: "No nodes", description: "Refresh pool info to populate nodes.", action: createdAccounts.length > 0
                ? {
                    label: "Refresh nodes",
                    onClick: () => {
                        void handleRefreshNodes();
                    },
                    icon: RotateCw,
                    loading: isLoading,
                }
                : undefined })),
        (state.nodes.length > 0 || initialLoading) && (React.createElement("div", { className: cn("transition-opacity duration-200 ease-out motion-reduce:transition-none", isLoading && state.nodes.length > 0
                ? "opacity-70"
                : "opacity-100", 
            // Reserve space at the bottom so the sticky toolbar doesn't
            // cover the last data row when selection is active.
            hasSelection && "pb-20") },
            React.createElement(DataTable, { tableId: "nodes", rows: visibleNodes, columns: columns, rowKey: (row) => row.id, loading: initialLoading, empty: tableEmpty, selection: selection, onSelectionChange: handleSelectionChange, csvFileName: "nodes-export.csv" }))),
        hasSelection && (React.createElement("div", { role: "toolbar", "aria-label": "Bulk actions for selected nodes", "aria-orientation": "horizontal", className: "sticky bottom-0 z-20 -mx-1 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-card/95 px-3 py-2 shadow-elev-2 backdrop-blur supports-[backdrop-filter]:bg-card/80 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200" },
            React.createElement("span", { className: "inline-flex items-center gap-2 rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-semibold text-primary" },
                React.createElement("span", { className: "tabular-nums" }, formatNumber(selectionCount)),
                "selected"),
            (() => {
                // Actionable counts pre-computed in `toolbarCounts` so each
                // button can show how many of the N selected nodes the action
                // will actually run on (rather than silently filtering on
                // click). Mirrors the orchestrator's per-node pre-filter.
                const { rebootable, reimageable, schedulable, skippedReboot, skippedReimage, skippedSched, } = toolbarCounts;
                return (React.createElement(React.Fragment, null,
                    (skippedReboot > 0 ||
                        skippedReimage > 0 ||
                        skippedSched > 0) && (React.createElement("span", { className: "hidden items-center gap-1 text-2xs text-muted-foreground sm:inline-flex" },
                        React.createElement(AlertTriangle, { className: "h-3 w-3 text-warning", "aria-hidden": "true" }),
                        "Some selected nodes are in non-actionable states")),
                    React.createElement("span", { className: "hidden h-5 w-px bg-border sm:inline-block" }),
                    React.createElement(BulkActionButton, { icon: CircleSlash, label: "Recreate", ariaLabel: `Recreate ${selectionCount} selected nodes`, onClick: handleRecreateNodes, disabled: isActing, tone: "primary-solid" }),
                    React.createElement(BulkActionButton, { icon: Plug, label: "Connect", ariaLabel: selectionCount === 1
                            ? "Connect to the selected node via SSH or RDP"
                            : "Select exactly one node to connect", onClick: () => void handleConnectNode(), disabled: isActing || selectionCount !== 1, disabledReason: selectionCount === 0
                            ? "Select a node first"
                            : selectionCount > 1
                                ? "Connect supports a single node — select exactly one"
                                : undefined, tone: "primary-solid" }),
                    React.createElement(BulkActionButton, { icon: RefreshCcw, label: rebootable === selectionCount
                            ? "Reboot"
                            : `Reboot (${rebootable})`, ariaLabel: `Reboot ${rebootable} actionable selected nodes (keyboard shortcut: r)`, ariaKeyshortcuts: "r", onClick: () => handleNodeAction("reboot"), disabled: isActing || rebootable === 0, disabledReason: rebootable === 0
                            ? "None of the selected nodes can be rebooted in their current state"
                            : skippedReboot > 0
                                ? `${skippedReboot} of ${selectionCount} selected node(s) will be skipped (non-actionable state)`
                                : undefined }),
                    React.createElement(BulkActionButton, { icon: Pause, label: schedulable === selectionCount
                            ? "Disable scheduling"
                            : `Disable scheduling (${schedulable})`, ariaLabel: `Disable scheduling on ${schedulable} selected nodes`, onClick: () => handleNodeAction("disableScheduling"), disabled: isActing || schedulable === 0, disabledReason: schedulable === 0
                            ? "None of the selected nodes can change scheduling state right now"
                            : undefined }),
                    React.createElement(BulkActionButton, { icon: Play, label: schedulable === selectionCount
                            ? "Enable scheduling"
                            : `Enable scheduling (${schedulable})`, ariaLabel: `Enable scheduling on ${schedulable} selected nodes`, onClick: () => handleNodeAction("enableScheduling"), disabled: isActing || schedulable === 0, disabledReason: schedulable === 0
                            ? "None of the selected nodes can change scheduling state right now"
                            : undefined }),
                    React.createElement("span", { className: "hidden h-5 w-px bg-border sm:inline-block" }),
                    React.createElement(BulkActionButton, { icon: RotateCw, label: reimageable === selectionCount
                            ? "Reimage"
                            : `Reimage (${reimageable})`, ariaLabel: `Reimage ${reimageable} actionable selected nodes (keyboard shortcut: i)`, ariaKeyshortcuts: "i", onClick: () => handleNodeAction("reimage"), disabled: isActing || reimageable === 0, disabledReason: reimageable === 0
                            ? "None of the selected nodes can be reimaged in their current state"
                            : undefined, tone: "destructive" }),
                    React.createElement(BulkActionButton, { icon: Trash2, label: "Delete", ariaLabel: `Delete ${selectionCount} selected nodes (keyboard shortcut: Delete)`, ariaKeyshortcuts: "Delete", onClick: handleDeleteNodes, disabled: isActing || selectionCount === 0, tone: "destructive" }),
                    React.createElement("span", { className: "hidden h-5 w-px bg-border sm:inline-block" }),
                    React.createElement(BulkActionButton, { icon: copiedSelected ? Check : ClipboardList, label: copiedSelected
                            ? "Copied"
                            : `Copy IDs (${selectionCount})`, ariaLabel: `Copy ${selectionCount} selected node IDs to clipboard, one per line`, onClick: () => void handleCopySelectedIds(), disabled: isActing || selectionCount === 0 })));
            })(),
            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setSelection(new Set()), "aria-label": "Clear selection (keyboard shortcut: Escape)", "aria-keyshortcuts": "Escape", className: "ml-auto text-muted-foreground", title: "Clear selection \u00B7 Esc" },
                React.createElement(X, null),
                "Clear"))),
        React.createElement(ConfirmationDialog, { hidden: confirmDialog.hidden, title: confirmDialog.title, message: confirmDialog.description, confirmText: confirmDialog.confirmLabel, cancelText: "Cancel", danger: confirmDialog.destructive, loading: isActing, onConfirm: () => __awaiter(void 0, void 0, void 0, function* () {
                dismissConfirmDialog();
                yield confirmDialog.onConfirm();
            }), onCancel: dismissConfirmDialog }),
        React.createElement(ConnectNodeDialog, { open: connectDialog.open, node: connectDialog.node, state: connectDialog.state, error: connectDialog.error, username: connectDialog.username, password: connectDialog.password, isWindows: connectDialog.isWindows, settings: connectDialog.settings, onClose: closeConnectDialog })));
};
const ConnectNodeDialog = ({ open, node, state, error, username, password, isWindows, settings, onClose, }) => {
    var _a, _b;
    const [copiedField, setCopiedField] = React.useState(null);
    const copy = React.useCallback((label, value) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield navigator.clipboard.writeText(value);
            setCopiedField(label);
            setTimeout(() => setCopiedField(null), 1500);
        }
        catch (_c) {
            /* clipboard blocked */
        }
    }), []);
    if (!open || !node)
        return null;
    const ip = (_a = settings === null || settings === void 0 ? void 0 : settings.remoteLoginIPAddress) !== null && _a !== void 0 ? _a : "";
    const port = (_b = settings === null || settings === void 0 ? void 0 : settings.remoteLoginPort) !== null && _b !== void 0 ? _b : 0;
    const sshCmd = ip && port ? `ssh ${username}@${ip} -p ${port}` : "";
    const rdpCmd = ip && port ? `mstsc /v:${ip}:${port}` : "";
    const command = isWindows ? rdpCmd : sshCmd;
    return (React.createElement("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm", onClick: onClose, role: "dialog", "aria-modal": "true", "aria-labelledby": "connect-node-title" },
        React.createElement("div", { className: "relative max-w-lg w-full mx-4 rounded-lg border border-border bg-card p-6 shadow-2xl", onClick: (e) => e.stopPropagation() },
            React.createElement("button", { type: "button", onClick: onClose, "aria-label": "Close", className: "absolute right-3 top-3 text-muted-foreground hover:text-foreground" },
                React.createElement(X, { className: "h-4 w-4" })),
            React.createElement("h2", { id: "connect-node-title", className: "text-base font-semibold tracking-tight flex items-center gap-2" },
                React.createElement(Plug, { className: "h-4 w-4 text-primary" }),
                "Connect to node ",
                node.nodeId),
            React.createElement("p", { className: "mt-1 text-xs text-muted-foreground" },
                "Pool ",
                React.createElement("code", { className: "font-mono" }, node.poolId),
                " \u00B7",
                " ",
                node.region,
                " \u00B7 ",
                isWindows ? "Windows (RDP)" : "Linux (SSH)"),
            state === "provisioning" && (React.createElement("div", { className: "mt-4 flex items-center gap-2 text-sm" },
                React.createElement(Loader2, { className: "h-4 w-4 animate-spin" }),
                "Creating temporary user account on the node\u2026")),
            state === "error" && (React.createElement(Alert, { variant: "destructive", className: "mt-4" },
                React.createElement(AlertDescription, { className: "text-xs leading-relaxed" }, error || "Could not provision the connection."))),
            state === "ready" && (React.createElement("div", { className: "mt-4 flex flex-col gap-3" },
                React.createElement(ConnectField, { label: "Connection command", value: command, onCopy: () => void copy("cmd", command), copied: copiedField === "cmd", mono: true }),
                React.createElement("div", { className: "grid grid-cols-2 gap-3" },
                    React.createElement(ConnectField, { label: "Address", value: `${ip}:${port}`, onCopy: () => void copy("addr", `${ip}:${port}`), copied: copiedField === "addr", mono: true }),
                    React.createElement(ConnectField, { label: "Username", value: username, onCopy: () => void copy("user", username), copied: copiedField === "user", mono: true })),
                React.createElement(ConnectField, { label: "Password", value: password, onCopy: () => void copy("pw", password), copied: copiedField === "pw", mono: true, masked: true }),
                React.createElement("p", { className: "text-2xs text-muted-foreground leading-relaxed" }, "Temporary account expires in 24 h. The Batch service rotates the SSH/RDP port behind a public IP; keep the connection command \u2014 it won't match the node's internal IP."))),
            React.createElement("div", { className: "mt-5 flex justify-end" },
                React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: onClose, disabled: state === "provisioning" }, "Done")))));
};
const ConnectField = ({ label, value, onCopy, copied, mono, masked, }) => {
    const [revealed, setRevealed] = React.useState(!masked);
    return (React.createElement("div", { className: "flex flex-col gap-1" },
        React.createElement(Label, { className: "text-2xs uppercase tracking-wide text-muted-foreground" }, label),
        React.createElement("div", { className: "flex items-stretch gap-1.5" },
            React.createElement(Input, { readOnly: true, value: masked && !revealed ? "•".repeat(value.length) : value, className: cn("text-xs", mono && "font-mono"), onFocus: (e) => e.currentTarget.select() }),
            masked && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setRevealed((v) => !v), "aria-label": revealed ? "Hide" : "Reveal" }, revealed ? "Hide" : "Show")),
            React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: onCopy, "aria-label": `Copy ${label}` }, copied ? React.createElement(Check, { className: "h-3.5 w-3.5" }) : React.createElement(Copy, { className: "h-3.5 w-3.5" })))));
};
const FilterSelect = ({ id, label, value, options, onChange, }) => (React.createElement("div", { className: "flex flex-col gap-1" },
    React.createElement(Label, { htmlFor: id, className: "text-xs text-muted-foreground" }, label),
    React.createElement(Select, { value: value || "__all", onValueChange: onChange },
        React.createElement(SelectTrigger, { id: id, className: "h-8 w-[160px] text-xs", "aria-label": `Filter by ${label.toLowerCase()}` },
            React.createElement(SelectValue, { placeholder: `All ${label.toLowerCase()}s` })),
        React.createElement(SelectContent, { className: "max-h-72 overflow-y-auto" },
            React.createElement(SelectItem, { value: "__all" },
                "All ",
                label.toLowerCase(),
                "s"),
            options.map((opt) => (React.createElement(SelectItem, { key: opt, value: opt }, opt)))))));
const STAT_TONE_CLASS = {
    info: { value: "text-info", label: "text-info" },
    destructive: { value: "text-destructive", label: "text-destructive" },
    success: { value: "text-success", label: "text-success" },
    warning: { value: "text-warning", label: "text-warning" },
};
const StatCard = ({ label, value, tone, tooltip }) => {
    const toneClasses = tone ? STAT_TONE_CLASS[tone] : null;
    // Active card = non-zero count. Active gets the live-glow-bar (breathing
    // outer glow) so the user can see at a glance which states have nodes
    // right now. Idle (zero) cards stay quiet.
    const isActive = value > 0;
    const liveTone = tone === "destructive"
        ? "var(--destructive)"
        : tone === "success"
            ? "var(--success)"
            : tone === "warning"
                ? "var(--warning)"
                : tone === "info"
                    ? "var(--info, var(--primary))"
                    : "var(--primary)";
    const card = (React.createElement("div", { className: cn("group relative flex min-w-[110px] flex-col items-center gap-1 rounded-lg border bg-card/70 px-4 py-3 text-center backdrop-blur-sm transition-all duration-200 ease-out", "hover:-translate-y-px hover:border-primary/40 hover:shadow-elev-1", isActive ? "border-primary/30 live-glow-bar" : "border-border"), style: isActive
            ? { ["--live-tone"]: liveTone }
            : undefined, tabIndex: tooltip ? 0 : undefined, role: tooltip ? "group" : undefined, "aria-label": tooltip ? `${label}: ${value}. ${tooltip}` : undefined },
        React.createElement("span", { className: cn("inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground", toneClasses === null || toneClasses === void 0 ? void 0 : toneClasses.label) },
            isActive && (React.createElement("span", { className: "live-pulse-dot", style: { ["--live-tone"]: liveTone }, "aria-hidden": "true" })),
            label),
        React.createElement("span", { className: cn("text-xl font-bold tabular-nums text-foreground", toneClasses === null || toneClasses === void 0 ? void 0 : toneClasses.value) },
            React.createElement(NumberTicker, { value: value }))));
    if (!tooltip)
        return card;
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true }, card),
        React.createElement(TooltipContent, { className: "max-w-xs" }, tooltip)));
};
const CopyableIp = ({ ip }) => {
    const [copied, setCopied] = React.useState(false);
    const timeoutRef = React.useRef(null);
    React.useEffect(() => () => {
        if (timeoutRef.current)
            clearTimeout(timeoutRef.current);
    }, []);
    const handleCopy = React.useCallback((event) => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        event.stopPropagation();
        try {
            if ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText) {
                yield navigator.clipboard.writeText(ip);
            }
            else {
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
            if (timeoutRef.current)
                clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(() => setCopied(false), 1200);
        }
        catch (_b) {
            // Silent — clipboard may be blocked by permissions.
        }
    }), [ip]);
    return (React.createElement("span", { className: "group/ip inline-flex items-center gap-1.5" },
        React.createElement("span", { className: "font-mono text-xs" }, ip),
        React.createElement("button", { type: "button", onClick: handleCopy, "aria-label": copied ? `Copied ${ip}` : `Copy ${ip} to clipboard`, className: cn("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 ease-out hover:bg-accent/30 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/ip:opacity-100 motion-reduce:transition-none", copied && "opacity-100 text-success") }, copied ? (React.createElement(Check, { className: "h-3 w-3", "aria-hidden": "true" })) : (React.createElement(Copy, { className: "h-3 w-3", "aria-hidden": "true" })))));
};
const CopyButton = ({ label, value, extraLabel }) => {
    const [copied, setCopied] = React.useState(false);
    const timeoutRef = React.useRef(null);
    React.useEffect(() => () => {
        if (timeoutRef.current)
            clearTimeout(timeoutRef.current);
    }, []);
    const onClick = React.useCallback((event) => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        event.stopPropagation();
        try {
            if ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText) {
                yield navigator.clipboard.writeText(value);
            }
            else {
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
            if (timeoutRef.current)
                clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(() => setCopied(false), 1200);
        }
        catch (_b) {
            /* clipboard blocked */
        }
    }), [value]);
    return (React.createElement("button", { type: "button", onClick: onClick, "aria-label": copied ? `Copied ${label}` : `Copy ${label}: ${value}`, title: extraLabel ? `${value}\n${extraLabel}` : value, className: cn(
        // DataTable rows don't have a `group/row` class for us to hook
        // into, so we use opacity-40 by default and animate up to full
        // opacity on hover/focus. Visible without being shouty.
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 transition-all duration-150 ease-out hover:bg-accent/30 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", copied && "opacity-100 text-success") }, copied ? (React.createElement(Check, { className: "h-3 w-3", "aria-hidden": "true" })) : (React.createElement(Copy, { className: "h-3 w-3", "aria-hidden": "true" }))));
};
const TONE_TO_CLASS = {
    "primary-solid": "",
    destructive: "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive",
    warning: "border-warning/50 text-warning hover:bg-warning/10 hover:text-warning",
};
const BulkActionButton = ({ icon: Icon, label, ariaLabel, onClick, disabled, disabledReason, tone, ariaKeyshortcuts, }) => {
    const isPrimary = tone === "primary-solid";
    const button = (React.createElement(Button, { type: "button", variant: isPrimary ? "default" : "outline", size: "sm", onClick: onClick, disabled: disabled, "aria-label": ariaLabel, "aria-keyshortcuts": ariaKeyshortcuts, className: cn("transition-colors duration-150 ease-out motion-reduce:transition-none", !isPrimary && tone ? TONE_TO_CLASS[tone] : undefined) },
        React.createElement(Icon, { className: "h-3.5 w-3.5" }),
        label));
    if (disabled && disabledReason) {
        return (React.createElement(Tooltip, null,
            React.createElement(TooltipTrigger, { asChild: true },
                React.createElement("span", { className: "inline-flex" }, button)),
            React.createElement(TooltipContent, null, disabledReason)));
    }
    return button;
};
export const NodesPage = (props) => (React.createElement(ErrorBoundary, null,
    React.createElement(NodesPageInner, Object.assign({}, props))));
//# sourceMappingURL=nodes-page.js.map