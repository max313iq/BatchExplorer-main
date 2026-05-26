import { __awaiter } from "tslib";
/**
 * Standalone Task Manager page.
 *
 * Shows every persisted task with full progress detail, ETA, and inline
 * controls. Designed to be opened in the main shell at /tasks OR popped
 * out into a dedicated browser window via `window.open(...)` so the
 * operator can keep it visible while working in another tab.
 *
 * Responsibilities:
 *   - subscribe to taskRuntime, render grouped by status
 *   - request cancellation, discard interrupted, resume interrupted, remove
 *   - re-dispatch resumed tasks via the orchestrator (from outlet context)
 *   - keep the ETA display fresh with a 1s tick
 *
 * Out of scope (left to the shell): authentication, route protection.
 *
 * v3 additions (2026-05-24):
 *   - ConfirmationDialog on Clear-finished + bulk Discard interrupted +
 *     bulk Remove history (no more silent destructive clicks).
 *   - Subscribe-race fix: useSyncExternalStore replaces the
 *     useState + useEffect pair, so any taskRuntime emit during initial
 *     render is captured (the previous pattern could drop the first
 *     emit if it fired in the gap between useState init and effect run).
 *   - Stuck-running detection: tasks in `running` whose lastHeartbeatAt
 *     is older than STUCK_THRESHOLD_MS get a dedicated "Possibly stuck"
 *     badge AND are surfaced under the attention section so the user
 *     notices stalls without staring at the timer.
 *   - Export buttons: CSV + JSON download of the current filtered set
 *     (or all tasks via "Export all"). No backend, runs entirely client
 *     side via a Blob URL.
 *   - Search by id: filter input matches against task.id (full + short).
 *   - Quick-filter chips by status: multi-select status chips replace
 *     the active-only checkbox (active-only is now one of the chips).
 *   - Copy task IDs: a copy-all button next to the count chip in each
 *     section header, plus per-row context menu hint.
 *   - Info tooltips: header pip explains "what is a task?" and each
 *     section header has a tooltip describing semantics.
 *   - Summary stats: success rate + average completed-task duration in
 *     addition to the per-state counts.
 */
import * as React from "react";
import { AlertTriangle, ArrowDown, ArrowDownToLine, CheckCircle2, ClipboardCheck, ClipboardList, Copy, Filter, Gauge, HelpCircle, Inbox, Info, Keyboard, Loader2, Maximize2, PauseCircle, RotateCw, Sparkles, Timer, Trash2, X, XCircle, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BorderBeam, DotPattern, HoverList, Meteors, NumberTicker, } from "@/components/ui/effects";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDashboardOutletContext } from "../page-router";
import { PageHeader } from "../shared/page-header";
import { useMultiRegionStore } from "../../store/store-context";
import { useShortcut } from "../../hooks/use-shortcut";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { auditLog } from "../../services/audit-log";
import { taskRuntime, } from "../../store/task-runtime";
import { BulkActionsBar } from "./bulk-actions-bar";
import { ConfirmationDialog } from "./confirmation-dialog";
import { DestructiveHeatmap } from "./destructive-heatmap";
import { FilterPresets } from "./filter-presets";
import { formatDuration } from "./task-formatting";
import { TaskRow } from "./task-row";
const RUNNING_STATES = ["running", "paused"];
const ATTENTION_STATES = ["interrupted", "failed", "partial"];
const TERMINAL_STATES = ["completed", "cancelled"];
/**
 * If a "running" task's lastHeartbeatAt is older than this, the page treats
 * it as "possibly stuck" — visibly badged so the user notices a stall
 * instead of staring at a spinner that's gone dead. Set conservatively
 * higher than the runtime's HEARTBEAT_STALE_MS (30s) so that the runtime's
 * own reclassifier wins normally and we only flag genuine zombies.
 */
const STUCK_THRESHOLD_MS = 60000;
/**
 * Session-storage flag set by `task-auto-resumer.tsx` when it auto-resumes
 * one or more interrupted tasks after a reload. The Task Manager page picks
 * this up on mount and renders a distinct, animated info banner so the user
 * gets in-page confirmation in addition to the (shared) toast.
 *
 * Format: stringified integer count, or absent when nothing was auto-resumed
 * in this session yet.
 */
const SESSION_AUTO_RESUMED_COUNT_KEY = "mr.task-runtime.auto-resumed.count";
/** Marker so we only show the banner once per page mount per resume event. */
const SESSION_AUTO_RESUMED_SHOWN_KEY = "mr.task-runtime.auto-resumed.shown";
/* --------------------------------------------------------------------- */
/* Hooks                                                                  */
/* --------------------------------------------------------------------- */
/**
 * Subscribe to taskRuntime via React's official external-store API. The
 * previous useState + useEffect pattern had a narrow race window where an
 * emit fired between initial render and the effect attaching its listener
 * — that emit would be dropped. `useSyncExternalStore` is purpose-built
 * for exactly this scenario and is also concurrent-mode safe.
 *
 * `subscribe` MUST be stable (referentially equal across renders) for the
 * external store contract — wrap once at module scope.
 */
const subscribeTaskRuntime = (callback) => {
    return taskRuntime.subscribe(() => callback());
};
/**
 * Snapshot is the sorted list. Cache it so two snapshot reads in a row
 * return the same reference (otherwise React throws "getSnapshot should be
 * cached"). The cache is invalidated whenever a notify fires.
 */
let _snapshotCache = null;
const getTaskRuntimeSnapshot = () => {
    if (_snapshotCache)
        return _snapshotCache;
    _snapshotCache = taskRuntime.list();
    return _snapshotCache;
};
/**
 * One-time module-scope listener that invalidates the snapshot cache on
 * every emit. Without this, useSyncExternalStore would only call
 * getSnapshot once on mount and never see updates because we'd keep
 * returning the same cached reference.
 *
 * Guarded so it only attaches once even with HMR.
 *
 * Intentional non-unsubscribe: this listener lives for the lifetime of
 * the module (which equals the app lifetime). taskRuntime is a singleton
 * pinned to the same lifetime. Storing the unsub handle would only let
 * us "leak" it later — the listener cannot be safely removed without
 * also tearing down every TaskManagerPage and resume-prompt subscriber.
 * If hot-module-reload re-imports this file, the `_snapshotInvalidatorAttached`
 * latch guards against double-attach (the previous module instance is
 * GC'd and its closure leaks one listener — acceptable HMR cost).
 */
let _snapshotInvalidatorAttached = false;
function ensureSnapshotInvalidator() {
    if (_snapshotInvalidatorAttached)
        return;
    _snapshotInvalidatorAttached = true;
    taskRuntime.subscribe(() => {
        _snapshotCache = null;
    });
}
function useTasks() {
    ensureSnapshotInvalidator();
    const tasks = React.useSyncExternalStore(subscribeTaskRuntime, getTaskRuntimeSnapshot, getTaskRuntimeSnapshot);
    // Imperative refresh — invalidates the cache and forces a re-render via
    // a state nudge. Useful when the runtime mutated without firing a
    // notification (hot-reload edges).
    const [, force] = React.useReducer((n) => n + 1, 0);
    const refresh = React.useCallback(() => {
        _snapshotCache = null;
        force();
    }, []);
    return [tasks, refresh];
}
/**
 * 1-second tick used to keep the ETA / elapsed-time displays current
 * even when the task itself isn't being patched. Returns a monotonic
 * counter so consumers can pass it as a render-key dependency.
 */
function useNowTick(intervalMs = 1000) {
    const [tick, setTick] = React.useState(0);
    React.useEffect(() => {
        const t = window.setInterval(() => setTick((n) => n + 1), intervalMs);
        return () => window.clearInterval(t);
    }, [intervalMs]);
    return tick;
}
/* --------------------------------------------------------------------- */
/* Helpers                                                                */
/* --------------------------------------------------------------------- */
// COORDINATOR: This `dispatchResume` body is duplicated verbatim in
// `task-auto-resumer.tsx` and `resume-prompt-dialog.tsx` (all three live
// in this folder). If a future refactor wants to consolidate, extract it
// to `task-manager/dispatch-resume.ts` (still inside this folder) and
// have the auto-resumer + prompt dialog import from there. We are NOT
// touching the orchestrator-agent or store layer to make this change.
/**
 * Re-dispatch a task back to the orchestrator with its original input.
 * Idempotent provisioning ops will skip already-created resources, so a
 * naive replay is the right default for the v1 Resume button.
 *
 * The mapping from `TaskKind` → `OrchestratorAgent.execute` action keeps
 * this knowledge in one place; future kinds slot in here.
 */
function dispatchResume(orchestrator, task) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        // The orchestrator's input shape is { action, payload, ... }; for tasks
        // created via the dispatch path the original input IS that whole shape.
        // We pass `resumeTaskId` so the orchestrator REUSES this task record
        // instead of creating a duplicate (the auto-resume bug).
        const input = task.input;
        const action = input === null || input === void 0 ? void 0 : input.action;
        if (!action) {
            // Fallback: infer from kind.
            const inferred = task.kind === "create-pools"
                ? "create_pools"
                : task.kind === "create-pools-smart"
                    ? "create_pools_smart"
                    : task.kind === "provision-accounts"
                        ? "create_accounts"
                        : null;
            if (!inferred)
                return;
            yield orchestrator.execute({
                action: inferred,
                payload: task.input,
                resumeTaskId: task.id,
            });
            return;
        }
        yield orchestrator.execute({
            action,
            payload: (_a = input === null || input === void 0 ? void 0 : input.payload) !== null && _a !== void 0 ? _a : {},
            resumeTaskId: task.id,
        });
    });
}
/**
 * Compute whether a "running" task has gone silent — heartbeat older than
 * the STUCK_THRESHOLD. Returns null if status isn't running OR the task
 * hasn't been around long enough to evaluate.
 */
function isStuckRunning(t, nowMs) {
    if (t.status !== "running")
        return false;
    const hb = t.lastHeartbeatAt
        ? new Date(t.lastHeartbeatAt).getTime()
        : t.updatedAt
            ? new Date(t.updatedAt).getTime()
            : 0;
    if (hb === 0)
        return false;
    return nowMs - hb > STUCK_THRESHOLD_MS;
}
/**
 * Trigger a browser download of a Blob via an ephemeral anchor. Pure
 * client-side; never persists to the server.
 */
function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revoke so Firefox finishes the download trigger.
    window.setTimeout(() => URL.revokeObjectURL(url), 250);
}
/**
 * Convert a list of tasks to a CSV blob. We pick the fields most useful
 * for offline triage and intentionally omit the giant `input` blob — JSON
 * export covers full fidelity.
 */
function tasksToCsv(tasks) {
    const headers = [
        "id",
        "kind",
        "label",
        "status",
        "subscriptionId",
        "createdAt",
        "updatedAt",
        "startedAt",
        "total",
        "completed",
        "failed",
        "currentStep",
        "error",
    ];
    const escape = (v) => {
        if (v === undefined || v === null)
            return "";
        const s = String(v);
        // Quote when contains a comma, quote, or newline; double internal quotes.
        if (/[",\n\r]/.test(s))
            return `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    const rows = [headers.join(",")];
    for (const t of tasks) {
        rows.push([
            escape(t.id),
            escape(t.kind),
            escape(t.label),
            escape(t.status),
            escape(t.subscriptionId),
            escape(t.createdAt),
            escape(t.updatedAt),
            escape(t.startedAt),
            escape(t.total),
            escape(t.completed),
            escape(t.failed),
            escape(t.currentStep),
            escape(t.error),
        ].join(","));
    }
    return new Blob([rows.join("\r\n")], {
        type: "text/csv;charset=utf-8;",
    });
}
function tasksToJson(tasks) {
    return new Blob([JSON.stringify(tasks, null, 2)], {
        type: "application/json;charset=utf-8;",
    });
}
const STATUS_CHIPS = [
    { status: "all-active", label: "Active only", tone: "primary" },
    { status: "running", label: "Running", tone: "primary" },
    { status: "paused", label: "Paused", tone: "warning" },
    { status: "interrupted", label: "Interrupted", tone: "warning" },
    { status: "failed", label: "Failed", tone: "destructive" },
    { status: "partial", label: "Partial", tone: "warning" },
    { status: "completed", label: "Completed", tone: "success" },
    { status: "cancelled", label: "Cancelled", tone: "muted" },
];
const StatusChip = ({ def, active, count, onClick }) => {
    return (React.createElement("button", { type: "button", onClick: onClick, "aria-pressed": active, className: cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-semibold tabular-nums transition-all duration-fast", "hover:shadow-elev-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1", !active && "border-border bg-card text-muted-foreground hover:bg-muted/40", active &&
            def.tone === "primary" &&
            "border-primary/40 bg-primary/10 text-primary", active &&
            def.tone === "success" &&
            "border-success/40 bg-success/10 text-success", active &&
            def.tone === "warning" &&
            "border-warning/40 bg-warning/10 text-warning", active &&
            def.tone === "destructive" &&
            "border-destructive/40 bg-destructive/10 text-destructive", active && def.tone === "muted" && "border-border bg-muted/40 text-foreground") },
        React.createElement("span", null, def.label),
        React.createElement("span", { className: cn("rounded-full px-1 text-2xs leading-tight", active ? "bg-background/60" : "bg-muted/40") }, count)));
};
const Section = ({ title, tasks, emptyState, accent = "muted", actions, nowTick, defaultOpen = true, helpText, headerActions, selectedIds, anchorId, onSelect, enableJsonExpander, }) => {
    const [open, setOpen] = React.useState(defaultOpen);
    return (React.createElement("section", { className: cn("rounded-xl border bg-surface-base/40 p-3 transition-colors duration-base", accent === "primary" && "border-primary/20", accent === "warning" && "border-warning/25", accent === "muted" && "border-border") },
        React.createElement("div", { className: "flex w-full items-center justify-between gap-2" },
            React.createElement("button", { type: "button", onClick: () => setOpen((o) => !o), className: "flex flex-1 items-center justify-start gap-2 rounded-md px-1 py-1 text-left text-sm font-semibold text-foreground transition-colors duration-fast hover:bg-muted/40", "aria-expanded": open },
                React.createElement("span", { className: "inline-flex items-center gap-2" },
                    React.createElement("span", null, title),
                    React.createElement("span", { className: cn("rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums", accent === "primary" && "bg-primary/10 text-primary", accent === "warning" && "bg-warning/10 text-warning", accent === "muted" && "bg-muted/40 text-muted-foreground") }, tasks.length),
                    helpText && (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", { "aria-label": `${title} help`, className: "inline-flex h-4 w-4 cursor-help items-center justify-center text-muted-foreground/70 hover:text-foreground" },
                                React.createElement(HelpCircle, { className: "h-3 w-3" }))),
                        React.createElement(TooltipContent, { className: "max-w-xs" }, helpText))))),
            React.createElement("div", { className: "flex shrink-0 items-center gap-1.5" },
                headerActions,
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, open ? "Hide" : "Show"))),
        open && (React.createElement("div", { className: "mt-2 flex flex-col gap-2" }, tasks.length === 0 ? (emptyState !== null && emptyState !== void 0 ? emptyState : (React.createElement("div", { className: "rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground" }, "No tasks here."))) : (React.createElement(HoverList, { items: tasks, getKey: (t) => t.id, tone: accent === "warning" ? "warning" : "primary", className: "gap-2", renderItem: (t) => (React.createElement(TaskRow, { task: t, actions: actions, nowTick: nowTick, 
                // Highlight every row that's in the multi-select set; the
                // anchor is the "focus" row that keyboard shortcuts target.
                selected: selectedIds ? selectedIds.has(t.id) : anchorId === t.id, onSelect: onSelect, enableJsonExpander: enableJsonExpander })) }))))));
};
const EmptyState = ({ icon, headline, subtext, cta, }) => (React.createElement("div", { className: "flex animate-fade-in flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-base/30 px-4 py-8 text-center" },
    React.createElement("div", { className: "flex h-10 w-10 items-center justify-center rounded-full bg-muted/40 text-muted-foreground" }, icon),
    React.createElement("div", { className: "text-sm font-medium text-foreground" }, headline),
    subtext && (React.createElement("div", { className: "max-w-md text-xs text-muted-foreground" }, subtext)),
    cta && React.createElement("div", { className: "mt-1" }, cta)));
/* --------------------------------------------------------------------- */
/* Main page                                                              */
/* --------------------------------------------------------------------- */
export const TaskManagerPage = () => {
    const { orchestrator } = useDashboardOutletContext();
    const store = useMultiRegionStore();
    const [tasks, refreshTasks] = useTasks();
    const nowTick = useNowTick();
    // Recompute "now" once per tick — keeps stuck-detection live without
    // touching the runtime. We reference `nowTick` in the dep array so the
    // memo refreshes once per second; the `void nowTick` line silences the
    // "unused dep" lint without giving up the dependency.
    const nowMs = React.useMemo(() => {
        void nowTick;
        return Date.now();
    }, [nowTick]);
    const [filter, setFilter] = React.useState("");
    /**
     * Multi-select status filter. Empty set = show everything. `all-active`
     * is the legacy "Active only" toggle preserved as a chip.
     */
    const [activeChips, setActiveChips] = React.useState(() => new Set());
    const [copiedIdsSection, setCopiedIdsSection] = React.useState(null);
    /**
     * Confirmation dialog state.
     *
     * The original 3 kinds (clear-finished, discard-interrupted, remove-history)
     * are header-driven; the new bulk-* kinds are selection-driven and carry
     * an explicit id list so the dialog can show the affected count and the
     * onConfirm handler doesn't need to re-derive eligibility (the selection
     * may have changed between opening the dialog and the user confirming).
     */
    const [confirmState, setConfirmState] = React.useState({ kind: null });
    /**
     * Multi-select id set used by keyboard shortcuts AND the bulk-actions bar.
     *   - `selectedIds.size === 1` keeps the original single-select behaviour
     *     (the lone id is the keyboard-shortcut target).
     *   - `selectedIds.size > 1` enables the bulk-actions bar; the keyboard
     *     shortcuts operate on the "anchor" id (the most-recently clicked
     *     row).
     *   - Clicking a row sets {anchor} (replace). Cmd/Ctrl+click toggles a
     *     single id. Shift+click selects the range from anchor → clicked
     *     within the current filtered list order.
     */
    const [selectedIds, setSelectedIds] = React.useState(() => new Set());
    const [anchorId, setAnchorId] = React.useState(null);
    /**
     * Backwards-compat alias for the keyboard-shortcut "focused" id.
     * The `c` / `r` / `p` hotkeys still operate on a single task — the anchor.
     * Multi-select extends this without changing the per-row hotkey semantics.
     */
    const selectedId = anchorId;
    /**
     * Tail-mode: auto-scroll to the newest task row whenever the underlying
     * list changes. Persisted across reloads so the operator's preference
     * sticks. Off by default — tail-mode steals scroll focus, which can be
     * annoying when manually scrolling history.
     */
    const [tailMode, setTailMode, _resetTail] = usePersistedState("mr.task-manager.tail-mode", false, { version: 1 });
    void _resetTail; // reserved for a future "reset preferences" hook
    /**
     * "Show only failed in last 24h" — a persisted shortcut chip distinct
     * from the regular status chip set because it has a time-window
     * predicate. When on, OR'd onto the existing chip selection so the user
     * can combine it with the search box and other chips.
     */
    const [failed24h, setFailed24h] = usePersistedState("mr.task-manager.filter.failed-24h", false, { version: 1 });
    /**
     * ARIA-live announcer for state transitions. Screen-readers cannot see
     * the visual status pill changing, so this off-screen polite-live
     * region narrates "Task <label> moved to <status>" whenever a task we
     * track flips its status. Coalesces to a single sentence per render
     * with the most-recent transition wins.
     *
     * Implementation: track previous tasks list in a ref and diff on every
     * render. Cap announcement string to keep TTS bursts short.
     */
    const prevTasksRef = React.useRef(new Map());
    const [ariaAnnounce, setAriaAnnounce] = React.useState("");
    React.useEffect(() => {
        const prev = prevTasksRef.current;
        const next = new Map();
        const transitions = [];
        for (const t of tasks) {
            next.set(t.id, t.status);
            const before = prev.get(t.id);
            if (before !== undefined && before !== t.status) {
                transitions.push({ label: t.label, from: before, to: t.status });
            }
        }
        prevTasksRef.current = next;
        if (transitions.length === 0)
            return;
        // Most-recent transition wins. For 2+ transitions, summarize.
        if (transitions.length === 1) {
            const x = transitions[0];
            setAriaAnnounce(`Task ${x.label} moved from ${x.from} to ${x.to}.`);
        }
        else {
            const last = transitions[transitions.length - 1];
            setAriaAnnounce(`${transitions.length} tasks changed status. Most recent: ${last.label} is now ${last.to}.`);
        }
        // Clear the announcer after a delay so the same transition can fire
        // again later (screen-readers ignore identical successive strings).
        const t = window.setTimeout(() => setAriaAnnounce(""), 2000);
        return () => window.clearTimeout(t);
    }, [tasks]);
    /**
     * Hotkey toast — a transient banner shown when a shortcut fires so the
     * operator gets visible feedback without watching the toast region.
     */
    const [hotkeyHint, setHotkeyHint] = React.useState(null);
    const showHotkeyHint = React.useCallback((msg) => {
        setHotkeyHint(msg);
        window.setTimeout(() => {
            setHotkeyHint((cur) => (cur === msg ? null : cur));
        }, 1800);
    }, []);
    const toggleChip = React.useCallback((status) => {
        setActiveChips((prev) => {
            const next = new Set(prev);
            if (next.has(status))
                next.delete(status);
            else
                next.add(status);
            return next;
        });
    }, []);
    const clearChips = React.useCallback(() => {
        setActiveChips(new Set());
    }, []);
    /**
     * Pre-compute counts per status so the chip set always shows the
     * underlying total (not the post-filter total) — gives the user
     * confidence that flipping a chip will surface something.
     */
    const countsByStatus = React.useMemo(() => {
        var _a;
        const counts = {
            running: 0,
            paused: 0,
            interrupted: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            partial: 0,
        };
        let activeCount = 0;
        for (const t of tasks) {
            counts[t.status] = ((_a = counts[t.status]) !== null && _a !== void 0 ? _a : 0) + 1;
            if (t.status === "running" ||
                t.status === "paused" ||
                t.status === "interrupted") {
                activeCount++;
            }
        }
        return Object.assign(Object.assign({}, counts), { "all-active": activeCount });
    }, [tasks]);
    // COORDINATOR: Duplicate task filtering logic also lives in
    // `sticky-tasks-panel.tsx` (active-only filter) and `resume-prompt-dialog.tsx`
    // (interrupted-only). If a future PR consolidates them into a shared
    // `filterTasks(predicates)` helper, this block should switch to that
    // helper. Keeping it inline for now per the per-page-only edit scope.
    const FAILED_24H_MS = 24 * 60 * 60 * 1000;
    const filtered = React.useMemo(() => {
        const q = filter.trim().toLowerCase();
        const cutoff = nowMs - FAILED_24H_MS;
        return tasks.filter((t) => {
            var _a, _b;
            // "Failed in last 24h" gate is intersected with the other filters —
            // explicitly the most restrictive predicate so users can pair it
            // with search.
            if (failed24h) {
                if (t.status !== "failed")
                    return false;
                const updated = new Date(t.updatedAt).getTime();
                if (!isFinite(updated) || updated < cutoff)
                    return false;
            }
            // Status-chip predicate: if any chip is active, the task must match
            // at least one selected predicate (OR semantics within the chip set).
            if (activeChips.size > 0) {
                let chipMatch = false;
                if (activeChips.has("all-active")) {
                    if (t.status === "running" ||
                        t.status === "paused" ||
                        t.status === "interrupted") {
                        chipMatch = true;
                    }
                }
                if (!chipMatch && activeChips.has(t.status)) {
                    chipMatch = true;
                }
                if (!chipMatch)
                    return false;
            }
            if (!q)
                return true;
            // Search by id supports full id, short prefix (first 8 chars), and
            // also matches against the legacy fields.
            const shortId = t.id.slice(0, 8).toLowerCase();
            return (t.label.toLowerCase().includes(q) ||
                t.kind.toLowerCase().includes(q) ||
                t.id.toLowerCase().includes(q) ||
                shortId.includes(q) ||
                ((_a = t.subscriptionId) !== null && _a !== void 0 ? _a : "").toLowerCase().includes(q) ||
                ((_b = t.currentStep) !== null && _b !== void 0 ? _b : "").toLowerCase().includes(q));
        });
    }, [tasks, filter, activeChips, failed24h, nowMs]);
    /**
     * Modifier-aware row-select handler.
     *
     *   - bare click     → single-select, replace.
     *   - cmd/ctrl+click → toggle the clicked id in the set, leaving anchor.
     *   - shift+click    → range-select from anchor → clicked within `filtered`
     *                      list order, additive (union with existing set).
     *
     * Range-select uses the FILTERED list order so the operator's mental
     * "this row to that row" matches what they see. The order across sections
     * isn't well defined (running vs attention vs terminal) but the filtered
     * array preserves the createdAt-desc order from task-runtime.list().
     */
    const handleRowSelect = React.useCallback((id, modifiers) => {
        const mod = modifiers !== null && modifiers !== void 0 ? modifiers : { shift: false, meta: false, ctrl: false };
        if (mod.shift && anchorId) {
            // Range-select within the current filtered list.
            const ids = filtered.map((t) => t.id);
            const aIdx = ids.indexOf(anchorId);
            const bIdx = ids.indexOf(id);
            if (aIdx >= 0 && bIdx >= 0) {
                const [lo, hi] = aIdx <= bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
                setSelectedIds((prev) => {
                    const next = new Set(prev);
                    for (let i = lo; i <= hi; i++)
                        next.add(ids[i]);
                    return next;
                });
                // Anchor doesn't move on shift-click — the operator can extend
                // the range further in either direction.
                return;
            }
            // Fallback: treat as bare click if either id is no longer visible.
        }
        if (mod.meta || mod.ctrl) {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(id))
                    next.delete(id);
                else
                    next.add(id);
                return next;
            });
            setAnchorId(id);
            return;
        }
        // Bare click → single-select replace.
        setSelectedIds(new Set([id]));
        setAnchorId(id);
    }, [anchorId, filtered]);
    /**
     * Stuck-running tasks are surfaced under attention so the user sees
     * stalls without staring at the spinner. We still keep them in the
     * running section as well (they are "running" semantically) — the
     * visible badge is rendered by TaskRow via its own status, so here we
     * just teach the section grouping to ALSO show them under attention.
     */
    const stuckIds = React.useMemo(() => {
        const ids = new Set();
        for (const t of filtered) {
            if (isStuckRunning(t, nowMs))
                ids.add(t.id);
        }
        return ids;
    }, [filtered, nowMs]);
    const grouped = React.useMemo(() => {
        const running = [];
        const attention = [];
        const terminal = [];
        for (const t of filtered) {
            if (RUNNING_STATES.includes(t.status))
                running.push(t);
            else if (ATTENTION_STATES.includes(t.status))
                attention.push(t);
            else if (TERMINAL_STATES.includes(t.status))
                terminal.push(t);
            // Mirror stuck-running into the attention section too (still also in
            // running). The Set guards against double-add when a future status
            // happens to be both running and attention.
            if (stuckIds.has(t.id) && !attention.includes(t)) {
                attention.push(t);
            }
        }
        return { running, attention, terminal };
    }, [filtered, stuckIds]);
    const actions = React.useMemo(() => ({
        onCancel: (id) => {
            const rec = taskRuntime.get(id);
            // Cooperative cancel: flips the per-task flag (the provisioner /
            // pool-creator polls this between iterations). ALSO call
            // `orchestrator.cancel()` to halt the whole agent immediately —
            // without this, a single-shot Cancel click does nothing visible
            // for the long ARM PUT in flight, and the user assumes the
            // button is broken.
            taskRuntime.requestCancel(id);
            try {
                orchestrator.cancel();
            }
            catch (_a) {
                /* orchestrator.cancel never throws today, but be defensive */
            }
            taskRuntime.update(id, {
                status: "cancelled",
                currentStep: "Cancelled by user",
            });
            auditLog.record({
                actor: "ui",
                action: "task_cancel",
                target: `task:${id}`,
                status: "success",
                details: {
                    kind: rec === null || rec === void 0 ? void 0 : rec.kind,
                    label: rec === null || rec === void 0 ? void 0 : rec.label,
                    priorStatus: rec === null || rec === void 0 ? void 0 : rec.status,
                },
            });
        },
        onResume: (id) => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            const rec = taskRuntime.get(id);
            if (!rec)
                return;
            // Status flip happens inside orchestrator.execute() now (it sees
            // resumeTaskId and adopts the existing record). We don't pre-flip
            // here — that previously caused the bug where the auto-resumer
            // and the orchestrator both raced to set status, leaving the
            // task stuck on "Auto-resuming…".
            auditLog.record({
                actor: "ui",
                action: "task_retry",
                target: `task:${id}`,
                status: "success",
                details: { kind: rec.kind, label: rec.label, priorStatus: rec.status },
            });
            try {
                yield dispatchResume(orchestrator, rec);
            }
            catch (e) {
                const msg = (_a = e === null || e === void 0 ? void 0 : e.message) !== null && _a !== void 0 ? _a : String(e);
                taskRuntime.update(id, {
                    status: "failed",
                    error: msg,
                });
                auditLog.record({
                    actor: "ui",
                    action: "task_retry",
                    target: `task:${id}`,
                    status: "failure",
                    error: msg,
                });
            }
        }),
        onPause: (id) => {
            const rec = taskRuntime.get(id);
            // Cooperative pause — the orchestrator polls isPauseRequested()
            // between iterations. Already-running per-iteration work runs to
            // completion before the loop exits.
            taskRuntime.requestPause(id);
            auditLog.record({
                actor: "ui",
                action: "task_pause",
                target: `task:${id}`,
                status: "success",
                details: { kind: rec === null || rec === void 0 ? void 0 : rec.kind, label: rec === null || rec === void 0 ? void 0 : rec.label },
            });
        },
        onStart: (id) => __awaiter(void 0, void 0, void 0, function* () {
            var _b;
            // "Start" from a paused task is the same code path as Resume —
            // re-dispatch with `resumeTaskId` so the orchestrator adopts the
            // existing record. Idempotent provisioning skips already-done
            // work on the Azure side.
            const rec = taskRuntime.get(id);
            if (!rec)
                return;
            auditLog.record({
                actor: "ui",
                action: "task_start",
                target: `task:${id}`,
                status: "success",
                details: { kind: rec.kind, label: rec.label },
            });
            try {
                yield dispatchResume(orchestrator, rec);
            }
            catch (e) {
                const msg = (_b = e === null || e === void 0 ? void 0 : e.message) !== null && _b !== void 0 ? _b : String(e);
                taskRuntime.update(id, {
                    status: "failed",
                    error: msg,
                });
                auditLog.record({
                    actor: "ui",
                    action: "task_start",
                    target: `task:${id}`,
                    status: "failure",
                    error: msg,
                });
            }
        }),
        onDiscard: (id) => {
            const rec = taskRuntime.get(id);
            taskRuntime.update(id, { status: "cancelled" });
            auditLog.record({
                actor: "ui",
                action: "task_discard",
                target: `task:${id}`,
                status: "success",
                details: { kind: rec === null || rec === void 0 ? void 0 : rec.kind, label: rec === null || rec === void 0 ? void 0 : rec.label, priorStatus: rec === null || rec === void 0 ? void 0 : rec.status },
            });
        },
        onRemove: (id) => {
            const rec = taskRuntime.get(id);
            taskRuntime.remove(id);
            auditLog.record({
                actor: "ui",
                action: "task_remove",
                target: `task:${id}`,
                status: "success",
                details: { kind: rec === null || rec === void 0 ? void 0 : rec.kind, label: rec === null || rec === void 0 ? void 0 : rec.label, priorStatus: rec === null || rec === void 0 ? void 0 : rec.status },
            });
        },
    }), [orchestrator]);
    /**
     * Summary stats: total counts + derived success rate + average
     * completed-task duration. Computed against ALL tasks (not the
     * filtered set) so the dashboard numbers don't change as the user
     * narrows their filter — that would be misleading.
     */
    const summary = React.useMemo(() => {
        const out = {
            total: tasks.length,
            running: 0,
            paused: 0,
            interrupted: 0,
            failed: 0,
            completed: 0,
            partial: 0,
            cancelled: 0,
            stuck: 0,
            successRate: 0,
            avgCompletedMs: undefined,
        };
        let completedDurationSum = 0;
        let completedDurationN = 0;
        let terminalCount = 0;
        for (const t of tasks) {
            switch (t.status) {
                case "running":
                    out.running++;
                    if (isStuckRunning(t, nowMs))
                        out.stuck++;
                    break;
                case "paused":
                    out.paused++;
                    break;
                case "interrupted":
                    out.interrupted++;
                    break;
                case "failed":
                    out.failed++;
                    terminalCount++;
                    break;
                case "completed":
                    out.completed++;
                    terminalCount++;
                    if (t.startedAt) {
                        const dur = new Date(t.updatedAt).getTime() -
                            new Date(t.startedAt).getTime();
                        if (isFinite(dur) && dur > 0) {
                            completedDurationSum += dur;
                            completedDurationN++;
                        }
                    }
                    break;
                case "partial":
                    out.partial++;
                    terminalCount++;
                    break;
                case "cancelled":
                    out.cancelled++;
                    terminalCount++;
                    break;
            }
        }
        out.successRate =
            terminalCount > 0
                ? Math.round((out.completed / terminalCount) * 100)
                : 0;
        out.avgCompletedMs =
            completedDurationN > 0
                ? Math.round(completedDurationSum / completedDurationN)
                : undefined;
        return out;
    }, [tasks, nowMs]);
    /**
     * Hotkey: `c` cancels the selected task (with confirmation toast hint).
     * Hotkey: `r` resumes/retries the selected task (interrupted → resume,
     * paused → start, failed → retry via the resume code path).
     *
     * Both shortcuts guard on:
     *   - a selectedId must be set,
     *   - the corresponding action must be valid for the task's status,
     *   - no chord may fire while focus is in an input (handled by the hook).
     */
    const onHotkeyCancel = React.useCallback(() => {
        if (!selectedId) {
            showHotkeyHint("No task selected — click a row first.");
            return;
        }
        const rec = taskRuntime.get(selectedId);
        if (!rec)
            return;
        if (rec.status !== "running" && rec.status !== "paused") {
            showHotkeyHint(`Cannot cancel a ${rec.status} task.`);
            return;
        }
        actions.onCancel(selectedId);
        showHotkeyHint(`Cancelled "${rec.label}"`);
    }, [actions, selectedId, showHotkeyHint]);
    const onHotkeyRetry = React.useCallback(() => {
        if (!selectedId) {
            showHotkeyHint("No task selected — click a row first.");
            return;
        }
        const rec = taskRuntime.get(selectedId);
        if (!rec)
            return;
        if (rec.status === "paused") {
            void actions.onStart(selectedId);
            showHotkeyHint(`Resumed "${rec.label}"`);
            return;
        }
        if (rec.status === "interrupted" || rec.status === "failed") {
            void actions.onResume(selectedId);
            showHotkeyHint(`Retrying "${rec.label}"`);
            return;
        }
        showHotkeyHint(`Cannot retry a ${rec.status} task.`);
    }, [actions, selectedId, showHotkeyHint]);
    /**
     * Hotkey: `p` pauses the selected (single-select) running task.
     * Defensive — does nothing on non-running statuses so the operator's
     * muscle memory can't accidentally do something destructive.
     */
    const onHotkeyPause = React.useCallback(() => {
        if (!selectedId) {
            showHotkeyHint("No task selected — click a row first.");
            return;
        }
        const rec = taskRuntime.get(selectedId);
        if (!rec)
            return;
        if (rec.status !== "running") {
            showHotkeyHint(`Cannot pause a ${rec.status} task.`);
            return;
        }
        actions.onPause(selectedId);
        showHotkeyHint(`Paused "${rec.label}"`);
    }, [actions, selectedId, showHotkeyHint]);
    /**
     * Hotkey: `Escape` clears multi-select (or single-select). If nothing is
     * selected, no-ops silently.
     */
    const onHotkeyEscape = React.useCallback(() => {
        if (selectedIds.size === 0 && anchorId === null)
            return;
        setSelectedIds(new Set());
        setAnchorId(null);
        showHotkeyHint("Selection cleared.");
    }, [selectedIds, anchorId, showHotkeyHint]);
    useShortcut("c", onHotkeyCancel, { allowInInputs: false });
    useShortcut("r", onHotkeyRetry, { allowInInputs: false });
    useShortcut("p", onHotkeyPause, { allowInInputs: false });
    // Escape doesn't preventDefault — we don't want to block native dialog
    // dismissals (the Radix dialog has its own Esc handler that fires first
    // since the dialog manages focus).
    useShortcut("Escape", onHotkeyEscape, {
        allowInInputs: false,
        preventDefault: false,
    });
    /**
     * Tail-mode: when on, scroll the page to the running section after every
     * task list update so newly-arrived tasks are visible without manual
     * scroll. Implementation: a ref attached to the running section + a
     * scrollIntoView on tasks length change.
     */
    const tailAnchorRef = React.useRef(null);
    React.useEffect(() => {
        if (!tailMode)
            return;
        if (!tailAnchorRef.current)
            return;
        tailAnchorRef.current.scrollIntoView({
            behavior: "smooth",
            block: "start",
        });
    }, [tailMode, tasks.length]);
    /**
     * Clear dangling selection when selected tasks disappear (e.g. user
     * pressed `c`, the task was cancelled & cleared, the id no longer exists).
     * Cheap O(n) check; the alternative is stale ids forever sticking around
     * in state, which would also stale-out the BulkActionsBar.
     *
     * Two-phase: prune missing ids from the Set, and re-anchor if the
     * anchor was the missing one (pick the first remaining selected id, or
     * null if the set is now empty).
     */
    React.useEffect(() => {
        var _a;
        if (selectedIds.size === 0 && anchorId === null)
            return;
        const liveIds = new Set(tasks.map((t) => t.id));
        let mutated = false;
        const nextSet = new Set();
        for (const id of selectedIds) {
            if (liveIds.has(id))
                nextSet.add(id);
            else
                mutated = true;
        }
        if (mutated)
            setSelectedIds(nextSet);
        if (anchorId !== null && !liveIds.has(anchorId)) {
            const replacement = (_a = nextSet.values().next().value) !== null && _a !== void 0 ? _a : null;
            setAnchorId(replacement);
        }
    }, [tasks, selectedIds, anchorId]);
    const popOut = React.useCallback(() => {
        // Open the same route in a borderless window. The shell still mounts
        // (auth, store, etc) — this is just a window-shaped iframe of /tasks.
        const url = `${window.location.origin}${window.location.pathname}#/tasks`;
        window.open(url, "task-manager", "popup=yes,width=960,height=720,resizable=yes");
    }, []);
    /**
     * Copy a list of task ids to the clipboard, newline-separated. Sets a
     * short-lived "copied" flag for the originating button. Falls back to
     * a notification if the clipboard API is unavailable (rare; older
     * iframes / non-secure contexts).
     */
    const copyIds = React.useCallback((sectionKey, taskList) => __awaiter(void 0, void 0, void 0, function* () {
        if (taskList.length === 0)
            return;
        const text = taskList.map((t) => t.id).join("\n");
        try {
            yield navigator.clipboard.writeText(text);
            setCopiedIdsSection(sectionKey);
            store.addNotification({
                type: "success",
                message: `Copied ${taskList.length} task id${taskList.length === 1 ? "" : "s"} to clipboard.`,
                autoDismissMs: 2500,
            });
            window.setTimeout(() => {
                setCopiedIdsSection((s) => (s === sectionKey ? null : s));
            }, 1500);
        }
        catch (_c) {
            store.addNotification({
                type: "error",
                message: "Clipboard write failed — your browser may be blocking it on http:// origins.",
                autoDismissMs: 4000,
            });
        }
    }), [store]);
    /**
     * Confirmation dialog handlers — wired to a single state machine so we
     * never end up with two dialogs simultaneously.
     *
     * Two openers: one for the header-driven kinds (no ids), one for the
     * bulk-* kinds (with a frozen id snapshot so dialog confirmation
     * operates on the selection at open-time, not at confirm-time).
     *
     * Declared here (above the bulk callbacks that depend on
     * `openBulkConfirm`) to avoid a temporal-dead-zone reference.
     */
    const openConfirm = React.useCallback((kind) => {
        setConfirmState({ kind });
    }, []);
    const openBulkConfirm = React.useCallback((kind, ids) => {
        if (ids.length === 0)
            return;
        setConfirmState({ kind, ids: ids.slice() });
    }, []);
    const closeConfirm = React.useCallback(() => {
        setConfirmState({ kind: null });
    }, []);
    /**
     * Export helpers. `exportScope === "filtered"` uses the live filtered
     * list (status chips + search), "all" exports every task.
     */
    const doExport = React.useCallback((format, scope) => {
        const list = scope === "filtered" ? filtered : tasks;
        if (list.length === 0) {
            store.addNotification({
                type: "warning",
                message: "Nothing to export — list is empty.",
                autoDismissMs: 2500,
            });
            return;
        }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const base = `task-manager-${scope}-${ts}`;
        if (format === "csv") {
            downloadBlob(`${base}.csv`, tasksToCsv(list));
        }
        else {
            downloadBlob(`${base}.json`, tasksToJson(list));
        }
        store.addNotification({
            type: "success",
            message: `Exported ${list.length} task${list.length === 1 ? "" : "s"} (${format.toUpperCase()}).`,
            autoDismissMs: 2500,
        });
    }, [filtered, tasks, store]);
    /**
     * BulkActionsBar wiring. Confirmation flows through the existing
     * ConfirmationDialog state machine — bulk-* kinds carry their target id
     * list so confirm is decoupled from the live selection (which the user
     * might mutate between opening the dialog and clicking confirm).
     *
     * Export-selected is fire-and-forget — no confirmation needed, it's a
     * read-only download. It piggybacks on the existing `tasksToJson` helper.
     */
    const onBulkCancel = React.useCallback((ids) => openBulkConfirm("bulk-cancel", ids), [openBulkConfirm]);
    const onBulkRemove = React.useCallback((ids) => openBulkConfirm("bulk-remove", ids), [openBulkConfirm]);
    const onBulkResume = React.useCallback((ids) => openBulkConfirm("bulk-resume", ids), [openBulkConfirm]);
    const onBulkPause = React.useCallback((ids) => openBulkConfirm("bulk-pause", ids), [openBulkConfirm]);
    const onBulkExport = React.useCallback((ids) => {
        if (ids.length === 0)
            return;
        const set = new Set(ids);
        const subset = tasks.filter((t) => set.has(t.id));
        if (subset.length === 0) {
            store.addNotification({
                type: "warning",
                message: "Selected tasks are no longer present — nothing to export.",
                autoDismissMs: 2500,
            });
            return;
        }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(`task-manager-selected-${ts}.json`, tasksToJson(subset));
        store.addNotification({
            type: "success",
            message: `Exported ${subset.length} selected task${subset.length === 1 ? "" : "s"} (JSON).`,
            autoDismissMs: 2500,
        });
    }, [tasks, store]);
    const onClearSelection = React.useCallback(() => {
        setSelectedIds(new Set());
        setAnchorId(null);
    }, []);
    /**
     * Filter-preset apply: takes a stored FilterPreset and replays it onto
     * the live filter state (search box, chip set, failed24h toggle). This
     * is the only place that mutates all three at once — everywhere else
     * the toolbar drives them individually.
     */
    const onApplyPreset = React.useCallback((p) => {
        setFilter(p.search);
        setActiveChips(new Set(p.chips));
        setFailed24h(p.failed24h);
        // The preset application itself doesn't change selection, but a
        // re-filter may shrink/expand the visible list. The dangling-
        // selection effect will reconcile if needed.
    }, [setFailed24h]);
    // Auto-resume banner — read once on mount. The auto-resumer (mounted in
    // dashboard-shell) writes the count just before dispatching; we surface it
    // here as an animated info banner that auto-dismisses or can be closed.
    const [autoResumedCount, setAutoResumedCount] = React.useState(() => {
        try {
            const raw = window.sessionStorage.getItem(SESSION_AUTO_RESUMED_COUNT_KEY);
            const shown = window.sessionStorage.getItem(SESSION_AUTO_RESUMED_SHOWN_KEY) === "1";
            if (!raw || shown)
                return null;
            const n = Number(raw);
            return Number.isFinite(n) && n > 0 ? n : null;
        }
        catch (_a) {
            return null;
        }
    });
    React.useEffect(() => {
        if (autoResumedCount === null)
            return;
        // Mark as shown so a navigation back to the page doesn't re-display.
        try {
            window.sessionStorage.setItem(SESSION_AUTO_RESUMED_SHOWN_KEY, "1");
        }
        catch (_a) {
            /**/
        }
    }, [autoResumedCount]);
    const dismissAutoResumed = React.useCallback(() => {
        setAutoResumedCount(null);
    }, []);
    const finishedTasks = React.useMemo(() => tasks.filter((t) => t.status === "completed" ||
        t.status === "cancelled" ||
        t.status === "failed" ||
        t.status === "partial"), [tasks]);
    const interruptedTasks = React.useMemo(() => tasks.filter((t) => t.status === "interrupted"), [tasks]);
    const historyTasks = React.useMemo(() => tasks.filter((t) => TERMINAL_STATES.includes(t.status)), [tasks]);
    const onConfirm = React.useCallback(() => {
        var _a, _b, _c, _d;
        if (confirmState.kind === "clear-finished") {
            const count = finishedTasks.length;
            taskRuntime.clearTerminal();
            auditLog.record({
                actor: "ui",
                action: "task_clear_finished",
                target: "task-manager",
                status: "success",
                details: { count },
            });
            store.addNotification({
                type: "info",
                message: `Cleared ${count} finished task${count === 1 ? "" : "s"}.`,
                autoDismissMs: 2500,
            });
        }
        else if (confirmState.kind === "discard-interrupted") {
            const n = taskRuntime.setStatusForInterrupted("cancelled");
            auditLog.record({
                actor: "ui",
                action: "task_discard_interrupted",
                target: "task-manager",
                status: "success",
                details: { count: n },
            });
            store.addNotification({
                type: "info",
                message: `Discarded ${n} interrupted task${n === 1 ? "" : "s"}.`,
                autoDismissMs: 2500,
            });
        }
        else if (confirmState.kind === "remove-history") {
            const count = historyTasks.length;
            for (const t of historyTasks) {
                taskRuntime.remove(t.id);
            }
            auditLog.record({
                actor: "ui",
                action: "task_remove_history",
                target: "task-manager",
                status: "success",
                details: { count },
            });
            store.addNotification({
                type: "info",
                message: `Removed ${count} historical task${count === 1 ? "" : "s"}.`,
                autoDismissMs: 2500,
            });
        }
        else if (confirmState.kind === "bulk-cancel") {
            const ids = (_a = confirmState.ids) !== null && _a !== void 0 ? _a : [];
            let applied = 0;
            for (const id of ids) {
                const rec = taskRuntime.get(id);
                if (!rec || (rec.status !== "running" && rec.status !== "paused"))
                    continue;
                actions.onCancel(id);
                applied++;
            }
            auditLog.record({
                actor: "ui",
                action: "task_bulk_cancel",
                target: "task-manager",
                status: "success",
                details: { requested: ids.length, applied },
            });
            store.addNotification({
                type: "info",
                message: `Cancelled ${applied} task${applied === 1 ? "" : "s"}.`,
                autoDismissMs: 2500,
            });
        }
        else if (confirmState.kind === "bulk-remove") {
            const ids = (_b = confirmState.ids) !== null && _b !== void 0 ? _b : [];
            let applied = 0;
            for (const id of ids) {
                const rec = taskRuntime.get(id);
                if (!rec)
                    continue;
                actions.onRemove(id);
                applied++;
            }
            auditLog.record({
                actor: "ui",
                action: "task_bulk_remove",
                target: "task-manager",
                status: "success",
                details: { requested: ids.length, applied },
            });
            store.addNotification({
                type: "info",
                message: `Removed ${applied} task${applied === 1 ? "" : "s"}.`,
                autoDismissMs: 2500,
            });
            // Clear selection after a bulk remove — the ids no longer exist.
            setSelectedIds(new Set());
            setAnchorId(null);
        }
        else if (confirmState.kind === "bulk-resume") {
            const ids = (_c = confirmState.ids) !== null && _c !== void 0 ? _c : [];
            let applied = 0;
            // Serial dispatch — orchestrator concurrency / rate-limit guards
            // see them in order. Errors land on each task record.
            void (() => __awaiter(void 0, void 0, void 0, function* () {
                for (const id of ids) {
                    const rec = taskRuntime.get(id);
                    if (!rec)
                        continue;
                    if (rec.status !== "interrupted" &&
                        rec.status !== "paused" &&
                        rec.status !== "failed")
                        continue;
                    try {
                        if (rec.status === "paused") {
                            yield actions.onStart(id);
                        }
                        else {
                            yield actions.onResume(id);
                        }
                        applied++;
                    }
                    catch (_e) {
                        /* per-task errors are recorded on the task record itself */
                    }
                }
                auditLog.record({
                    actor: "ui",
                    action: "task_bulk_resume",
                    target: "task-manager",
                    status: "success",
                    details: { requested: ids.length, applied },
                });
                store.addNotification({
                    type: "info",
                    message: `Resumed ${applied} task${applied === 1 ? "" : "s"}.`,
                    autoDismissMs: 2500,
                });
            }))();
        }
        else if (confirmState.kind === "bulk-pause") {
            const ids = (_d = confirmState.ids) !== null && _d !== void 0 ? _d : [];
            let applied = 0;
            for (const id of ids) {
                const rec = taskRuntime.get(id);
                if (!rec || rec.status !== "running")
                    continue;
                actions.onPause(id);
                applied++;
            }
            auditLog.record({
                actor: "ui",
                action: "task_bulk_pause",
                target: "task-manager",
                status: "success",
                details: { requested: ids.length, applied },
            });
            store.addNotification({
                type: "info",
                message: `Paused ${applied} task${applied === 1 ? "" : "s"}.`,
                autoDismissMs: 2500,
            });
        }
        closeConfirm();
    }, [confirmState, closeConfirm, finishedTasks.length, historyTasks, store, actions]);
    // Initial-loading skeleton: only render skeletons before the runtime has
    // bootstrapped. taskRuntime.list() returns synchronously after bootstrap,
    // so the only "loading" condition we care about is the very first render
    // after a navigation when the subscriber hasn't fired yet AND there are
    // no tasks — render a few rows to show the layout will fill in.
    const showInitialSkeleton = tasks.length === 0 &&
        filter === "" &&
        activeChips.size === 0 &&
        !failed24h;
    /* --- Confirm dialog content per kind ---------------------------------- */
    const confirmPayload = React.useMemo(() => {
        var _a;
        if (confirmState.kind === "clear-finished") {
            return {
                title: `Clear ${finishedTasks.length} finished task${finishedTasks.length === 1 ? "" : "s"}?`,
                description: "Removes completed, cancelled, failed, and partial tasks from the list. Running and interrupted tasks are kept. This cannot be undone.",
                confirmLabel: "Clear finished",
                tone: "destructive",
                details: React.createElement(ConfirmDetailsList, { tasks: finishedTasks.slice(0, 8), more: Math.max(0, finishedTasks.length - 8) }),
            };
        }
        if (confirmState.kind === "discard-interrupted") {
            return {
                title: `Discard ${interruptedTasks.length} interrupted task${interruptedTasks.length === 1 ? "" : "s"}?`,
                description: "Marks every interrupted task as cancelled. They will no longer auto-resume on reload. Already-provisioned Azure resources are NOT removed.",
                confirmLabel: "Discard all",
                tone: "warning",
                details: React.createElement(ConfirmDetailsList, { tasks: interruptedTasks.slice(0, 8), more: Math.max(0, interruptedTasks.length - 8) }),
            };
        }
        if (confirmState.kind === "remove-history") {
            return {
                title: `Remove ${historyTasks.length} historical task${historyTasks.length === 1 ? "" : "s"}?`,
                description: "Permanently deletes completed and cancelled tasks from the list. This frees localStorage space. Cannot be undone.",
                confirmLabel: "Remove history",
                tone: "destructive",
                details: React.createElement(ConfirmDetailsList, { tasks: historyTasks.slice(0, 8), more: Math.max(0, historyTasks.length - 8) }),
            };
        }
        // Bulk-* kinds: resolve the frozen id snapshot back to TaskRecord objects
        // for the details list. Stale ids (task removed between dialog open and
        // confirm) silently drop out of the displayed list — the action handler
        // also re-validates on confirm so we never operate on stale ids.
        if (confirmState.kind === "bulk-cancel" ||
            confirmState.kind === "bulk-remove" ||
            confirmState.kind === "bulk-resume" ||
            confirmState.kind === "bulk-pause") {
            const ids = (_a = confirmState.ids) !== null && _a !== void 0 ? _a : [];
            const targets = [];
            for (const id of ids) {
                const t = taskRuntime.get(id);
                if (t)
                    targets.push(t);
            }
            const n = targets.length;
            const noun = n === 1 ? "task" : "tasks";
            if (confirmState.kind === "bulk-cancel") {
                return {
                    title: `Cancel ${n} ${noun}?`,
                    description: "Stops running/paused tasks after the current step. Already-provisioned Azure resources are NOT removed.",
                    confirmLabel: `Cancel ${n} ${noun}`,
                    tone: "warning",
                    details: React.createElement(ConfirmDetailsList, { tasks: targets.slice(0, 8), more: Math.max(0, n - 8) }),
                };
            }
            if (confirmState.kind === "bulk-remove") {
                return {
                    title: `Remove ${n} ${noun} from the list?`,
                    description: "Permanently deletes the selected tasks. Cannot be undone. Does not touch Azure resources.",
                    confirmLabel: `Remove ${n} ${noun}`,
                    tone: "destructive",
                    details: React.createElement(ConfirmDetailsList, { tasks: targets.slice(0, 8), more: Math.max(0, n - 8) }),
                };
            }
            if (confirmState.kind === "bulk-resume") {
                return {
                    title: `Resume ${n} ${noun}?`,
                    description: "Re-dispatches each task with its original input. Idempotent operations skip already-done work on the Azure side.",
                    confirmLabel: `Resume ${n} ${noun}`,
                    tone: "warning",
                    details: React.createElement(ConfirmDetailsList, { tasks: targets.slice(0, 8), more: Math.max(0, n - 8) }),
                };
            }
            if (confirmState.kind === "bulk-pause") {
                return {
                    title: `Pause ${n} ${noun}?`,
                    description: "Cooperative pause — each task stops after its current iteration. Resume any time from this page.",
                    confirmLabel: `Pause ${n} ${noun}`,
                    tone: "warning",
                    details: React.createElement(ConfirmDetailsList, { tasks: targets.slice(0, 8), more: Math.max(0, n - 8) }),
                };
            }
        }
        return null;
    }, [confirmState.kind, confirmState.ids, finishedTasks, interruptedTasks, historyTasks]);
    return (React.createElement("div", { className: "flex flex-col gap-5 py-2" },
        React.createElement("div", { className: "relative overflow-hidden rounded-xl border bg-card/50 p-6" },
            React.createElement(DotPattern, { fade: "top-left", className: "absolute inset-0" }),
            React.createElement(Meteors, { count: 12, tone: "primary", className: "absolute inset-0" }),
            React.createElement("div", { className: "relative z-10 flex flex-col gap-2" },
                React.createElement("div", { className: "inline-flex items-center gap-2 self-start rounded-full bg-primary/10 px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-primary" },
                    React.createElement(ClipboardList, { className: "h-3 w-3" }),
                    "Task Manager",
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", { "aria-label": "What is a task?", className: "ml-0.5 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full text-primary/70 hover:text-primary" },
                                React.createElement(Info, { className: "h-3 w-3" }))),
                        React.createElement(TooltipContent, { className: "max-w-xs" }, "A task is a long-running workflow (e.g. provisioning, pool creation). Tasks persist across reloads and can be paused, resumed, or auto-resumed silently."))),
                React.createElement(PageHeader, { title: "Long-running workflows", description: "Tasks persist across reloads. Resume after interruption, watch progress live, or pop out to a dedicated window." },
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: refreshTasks, className: "gap-1.5 transition-all duration-fast hover:shadow-elev-1", "aria-label": "Refresh task list" },
                                React.createElement(RotateCw, { className: "h-3.5 w-3.5" }),
                                "Refresh")),
                        React.createElement(TooltipContent, null, "Re-read from localStorage (already live-subscribed)")),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: popOut, className: "gap-1.5 transition-all duration-fast hover:shadow-elev-1", "aria-label": "Open Task Manager in a new window" },
                                React.createElement(Maximize2, { className: "h-3.5 w-3.5" }),
                                "Pop out")),
                        React.createElement(TooltipContent, null, "Open in a dedicated browser window")),
                    React.createElement(ExportMenu, { onExport: doExport }),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => openConfirm("clear-finished"), className: "gap-1.5 transition-all duration-fast hover:shadow-elev-1", disabled: finishedTasks.length === 0, "aria-label": "Clear completed, cancelled, and failed tasks" },
                                React.createElement(Trash2, { className: "h-3.5 w-3.5" }),
                                "Clear finished")),
                        React.createElement(TooltipContent, null, "Asks for confirmation first"))))),
        autoResumedCount !== null && (React.createElement("div", { role: "status", className: "flex animate-slide-in-bottom items-start gap-3 rounded-xl border border-info/30 bg-info/5 p-3 shadow-elev-1" },
            React.createElement("div", { className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-info/15 ring-1 ring-info/40" },
                React.createElement(Sparkles, { className: "h-4 w-4 text-info" })),
            React.createElement("div", { className: "min-w-0 flex-1" },
                React.createElement("div", { className: "flex items-center gap-1.5 text-sm font-semibold text-info" },
                    React.createElement(Info, { className: "h-3.5 w-3.5" }),
                    "Auto-resumed ",
                    autoResumedCount,
                    " task",
                    autoResumedCount === 1 ? "" : "s",
                    " after reload"),
                React.createElement("p", { className: "mt-0.5 text-xs text-muted-foreground" }, "Idempotent operations re-run safely \u2014 Azure skips work that already succeeded. Watch progress below.")),
            React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: dismissAutoResumed, "aria-label": "Dismiss auto-resume banner", className: "shrink-0" },
                React.createElement(XCircle, { className: "h-3.5 w-3.5" })))),
        summary.stuck > 0 && (React.createElement("div", { role: "status", className: "flex animate-fade-in items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-3 shadow-elev-1" },
            React.createElement("div", { className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/15 ring-1 ring-warning/40" },
                React.createElement(AlertTriangle, { className: "h-4 w-4 text-warning" })),
            React.createElement("div", { className: "min-w-0 flex-1" },
                React.createElement("div", { className: "text-sm font-semibold text-warning" },
                    summary.stuck,
                    " task",
                    summary.stuck === 1 ? "" : "s",
                    " possibly stuck"),
                React.createElement("p", { className: "mt-0.5 text-xs text-muted-foreground" },
                    "No heartbeat in over ",
                    Math.round(STUCK_THRESHOLD_MS / 1000),
                    "s. These rows are also surfaced under ",
                    React.createElement("strong", null, "Needs attention"),
                    " ",
                    "so you can decide whether to cancel and resume.")))),
        React.createElement("div", { className: "relative overflow-hidden rounded-xl p-2" },
            React.createElement(BorderBeam, { size: 200, duration: 8 }),
            React.createElement("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-4" },
                React.createElement(StatCard, { icon: React.createElement(Loader2, { className: "h-4 w-4 animate-spin" }), label: "Running", value: summary.running, accent: "primary", hint: "Tasks executing right now." }),
                React.createElement(StatCard, { icon: React.createElement(AlertTriangle, { className: "h-4 w-4" }), label: "Interrupted", value: summary.interrupted, accent: "warning", hint: "Tasks that lost their tab. Click Resume to re-dispatch." }),
                React.createElement(StatCard, { icon: React.createElement(CheckCircle2, { className: "h-4 w-4" }), label: "Completed", value: summary.completed, accent: "success", hint: "Tasks that finished cleanly." }),
                React.createElement(StatCard, { icon: React.createElement(XCircle, { className: "h-4 w-4" }), label: "Failed", value: summary.failed, accent: "destructive", hint: "Tasks that ended with unrecoverable errors." })),
            React.createElement("div", { className: "mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3" },
                React.createElement(StatCard, { icon: React.createElement(ClipboardList, { className: "h-4 w-4" }), label: "Total tasks", value: summary.total, accent: "muted", hint: "All tasks across every status, persisted to localStorage." }),
                React.createElement(StatCard, { icon: React.createElement(Gauge, { className: "h-4 w-4" }), label: "Success rate", value: summary.successRate, suffix: "%", accent: summary.successRate >= 80 ? "success" : summary.successRate >= 50 ? "warning" : "destructive", hint: "Completed \u00F7 all terminal tasks (failed + cancelled + partial + completed)." }),
                React.createElement(AvgDurationCard, { ms: summary.avgCompletedMs }))),
        summary.paused > 0 && (React.createElement("div", { className: "inline-flex w-fit items-center gap-1.5 rounded-full border border-warning/30 bg-warning/5 px-2.5 py-0.5 text-2xs font-medium text-warning" },
            React.createElement(PauseCircle, { className: "h-3 w-3" }),
            summary.paused,
            " paused")),
        React.createElement(DestructiveHeatmap, { hideWhenEmpty: true }),
        React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only" }, ariaAnnounce),
        React.createElement("div", { className: "flex flex-col gap-2" },
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                React.createElement("div", { className: "relative max-w-xs flex-1" },
                    React.createElement(Filter, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" }),
                    React.createElement(Input, { placeholder: "Filter by label, kind, subscription, or id\u2026", value: filter, onChange: (e) => setFilter(e.target.value), className: "h-8 pl-7 pr-7 text-xs transition-shadow duration-fast focus-visible:shadow-elev-1", "aria-label": "Filter tasks" }),
                    filter && (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("button", { type: "button", onClick: () => setFilter(""), "aria-label": "Clear search", className: "absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground" },
                                React.createElement(X, { className: "h-3 w-3" }))),
                        React.createElement(TooltipContent, null, "Clear search")))),
                activeChips.size > 0 && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("button", { type: "button", onClick: clearChips, className: "inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-2xs font-medium text-muted-foreground hover:bg-muted/40", "aria-label": "Clear status filters" },
                            React.createElement(X, { className: "h-3 w-3" }),
                            "Clear filters")),
                    React.createElement(TooltipContent, null, "Remove all status filters"))),
                React.createElement("span", { className: "text-2xs tabular-nums text-muted-foreground" },
                    filtered.length,
                    " / ",
                    tasks.length),
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("button", { type: "button", onClick: () => setTailMode((v) => !v), "aria-pressed": tailMode, "aria-label": "Toggle tail mode", className: cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-2xs font-medium tabular-nums transition-colors duration-fast", tailMode
                                ? "border-primary/40 bg-primary/10 text-primary"
                                : "border-border bg-card text-muted-foreground hover:bg-muted/40") },
                            React.createElement(ArrowDown, { className: "h-3 w-3" }),
                            "Tail ",
                            tailMode ? "on" : "off")),
                    React.createElement(TooltipContent, { className: "max-w-xs" }, "Auto-scrolls to the newest task on every update so live progress is always visible.")),
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("button", { type: "button", onClick: () => setFailed24h((v) => !v), "aria-pressed": failed24h, "aria-label": "Toggle failed-in-last-24h filter", className: cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-2xs font-medium tabular-nums transition-colors duration-fast", failed24h
                                ? "border-destructive/40 bg-destructive/10 text-destructive"
                                : "border-border bg-card text-muted-foreground hover:bg-muted/40") },
                            React.createElement(XCircle, { className: "h-3 w-3" }),
                            "Failed (24h)")),
                    React.createElement(TooltipContent, { className: "max-w-xs" }, "Limits the list to tasks whose status is `failed` and whose last update was within the past 24 hours. Persisted.")),
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", { className: "inline-flex cursor-help items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-2xs text-muted-foreground", "aria-label": "Keyboard shortcuts help" },
                            React.createElement(Keyboard, { className: "h-3 w-3" }),
                            React.createElement("kbd", { className: "rounded bg-muted/40 px-1 font-mono" }, "c"),
                            "/",
                            React.createElement("kbd", { className: "rounded bg-muted/40 px-1 font-mono" }, "r"),
                            "/",
                            React.createElement("kbd", { className: "rounded bg-muted/40 px-1 font-mono" }, "p"),
                            "/",
                            React.createElement("kbd", { className: "rounded bg-muted/40 px-1 font-mono" }, "Esc"))),
                    React.createElement(TooltipContent, { className: "max-w-xs" },
                        "Click a row to select it, then press ",
                        React.createElement("strong", null, "c"),
                        " to cancel,\u00A0",
                        React.createElement("strong", null, "r"),
                        " to resume/retry,\u00A0",
                        React.createElement("strong", null, "p"),
                        " to pause, or ",
                        React.createElement("strong", null, "Esc"),
                        " to clear the selection. Shift-click extends the selection; Cmd/Ctrl-click toggles a row."))),
            React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" }, STATUS_CHIPS.map((c) => {
                var _a;
                return (React.createElement(StatusChip, { key: c.status, def: c, active: activeChips.has(c.status), count: (_a = countsByStatus[c.status]) !== null && _a !== void 0 ? _a : 0, onClick: () => toggleChip(c.status) }));
            })),
            React.createElement(FilterPresets, { current: { search: filter, chips: activeChips, failed24h }, onApply: onApplyPreset })),
        hotkeyHint && (React.createElement("div", { role: "status", className: "flex animate-fade-in items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1 text-2xs font-medium text-primary" },
            React.createElement(Keyboard, { className: "h-3 w-3" }),
            hotkeyHint)),
        React.createElement(BulkActionsBar, { selectedIds: selectedIds, getTask: (id) => taskRuntime.get(id), onClear: onClearSelection, onBulkCancel: onBulkCancel, onBulkResume: onBulkResume, onBulkPause: onBulkPause, onBulkRemove: onBulkRemove, onBulkExport: onBulkExport }),
        React.createElement("div", { ref: tailAnchorRef, "aria-hidden": "true" }),
        showInitialSkeleton ? (React.createElement("div", { className: "flex flex-col gap-2", "aria-hidden": "true" }, [0, 1, 2].map((i) => (React.createElement(TaskRowSkeleton, { key: i }))))) : (React.createElement("div", { className: "flex flex-col gap-3" },
            React.createElement(Section, { title: "Running & paused", tasks: grouped.running, accent: "primary", actions: actions, nowTick: nowTick, selectedIds: selectedIds, anchorId: anchorId, onSelect: handleRowSelect, enableJsonExpander: true, helpText: "Tasks executing now or paused mid-flight. Pause is cooperative \u2014 the orchestrator finishes the current iteration before stopping.", headerActions: grouped.running.length > 0 ? (React.createElement(CopyIdsButton, { sectionKey: "running", copiedSection: copiedIdsSection, taskList: grouped.running, onCopy: copyIds })) : null, emptyState: React.createElement(EmptyState, { icon: React.createElement(Loader2, { className: "h-5 w-5" }), headline: "Nothing running right now", subtext: "Kick off a workflow from another page and the live progress will show up here." }) }),
            React.createElement(Section, { title: "Needs attention", tasks: grouped.attention, accent: "warning", actions: actions, nowTick: nowTick, selectedIds: selectedIds, anchorId: anchorId, onSelect: handleRowSelect, enableJsonExpander: true, helpText: "Interrupted, failed, partial, or stuck tasks. Stuck tasks have no heartbeat for over a minute \u2014 consider cancelling and resuming.", headerActions: React.createElement("div", { className: "flex items-center gap-1" },
                    grouped.attention.length > 0 && (React.createElement(CopyIdsButton, { sectionKey: "attention", copiedSection: copiedIdsSection, taskList: grouped.attention, onCopy: copyIds })),
                    interruptedTasks.length > 0 && (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => openConfirm("discard-interrupted"), "aria-label": "Discard all interrupted tasks", className: "gap-1 text-warning hover:bg-warning/10" },
                                React.createElement(X, { className: "h-3 w-3" }),
                                "Discard ",
                                interruptedTasks.length,
                                " interrupted")),
                        React.createElement(TooltipContent, null, "Cancels each interrupted task. Does not touch Azure resources.")))), emptyState: React.createElement(EmptyState, { icon: React.createElement(CheckCircle2, { className: "h-5 w-5 text-success" }), headline: "All clear", subtext: "No interrupted, failed, partial, or stuck tasks. New issues will surface here." }) }),
            React.createElement(Section, { title: "History", tasks: grouped.terminal, actions: actions, nowTick: nowTick, selectedIds: selectedIds, anchorId: anchorId, onSelect: handleRowSelect, enableJsonExpander: true, defaultOpen: false, helpText: "Completed and cancelled tasks. Use 'Clear finished' or 'Remove history' to clean up.", headerActions: React.createElement("div", { className: "flex items-center gap-1" },
                    grouped.terminal.length > 0 && (React.createElement(CopyIdsButton, { sectionKey: "terminal", copiedSection: copiedIdsSection, taskList: grouped.terminal, onCopy: copyIds })),
                    historyTasks.length > 0 && (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => openConfirm("remove-history"), "aria-label": "Remove all historical tasks", className: "gap-1 hover:bg-destructive/10 hover:text-destructive" },
                                React.createElement(Trash2, { className: "h-3 w-3" }),
                                "Remove all")),
                        React.createElement(TooltipContent, null, "Permanently removes completed and cancelled tasks.")))), emptyState: React.createElement(EmptyState, { icon: React.createElement(Inbox, { className: "h-5 w-5" }), headline: "No history yet", subtext: "Completed and cancelled tasks accumulate here. Use Clear finished to wipe the list." }) }))),
        confirmPayload && (React.createElement(ConfirmationDialog, { open: confirmState.kind !== null, onOpenChange: (o) => {
                if (!o)
                    closeConfirm();
            }, title: confirmPayload.title, description: confirmPayload.description, details: confirmPayload.details, confirmLabel: confirmPayload.confirmLabel, tone: confirmPayload.tone, onConfirm: onConfirm }))));
};
/* --------------------------------------------------------------------- */
/* Sub-components                                                         */
/* --------------------------------------------------------------------- */
/**
 * Inline list rendered inside ConfirmationDialog.details — shows the
 * labels of the affected tasks so the user can scan what's about to be
 * destroyed before committing.
 */
const ConfirmDetailsList = ({ tasks, more, }) => {
    if (tasks.length === 0)
        return null;
    return (React.createElement("ul", { className: "flex flex-col gap-1" },
        tasks.map((t) => (React.createElement("li", { key: t.id, className: "flex min-w-0 items-baseline gap-2" },
            React.createElement("span", { className: "shrink-0 rounded bg-background/40 px-1 py-0.5 text-2xs uppercase tracking-wider" }, t.status),
            React.createElement("span", { className: "truncate font-medium" }, t.label),
            React.createElement("span", { className: "ml-auto shrink-0 text-2xs font-mono opacity-60" }, t.id.slice(0, 8))))),
        more > 0 && (React.createElement("li", { className: "text-2xs opacity-70" },
            "+ ",
            more,
            " more\u2026"))));
};
/**
 * Click-to-copy button placed next to section headers. Copies every task
 * id in the section to the clipboard. Brief check-mark feedback.
 */
const CopyIdsButton = ({ sectionKey, copiedSection, taskList, onCopy }) => {
    const copied = copiedSection === sectionKey;
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true },
            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: (e) => {
                    e.stopPropagation();
                    onCopy(sectionKey, taskList);
                }, className: cn("gap-1 text-2xs", copied && "text-success hover:text-success"), "aria-label": `Copy ${taskList.length} task ids to clipboard` },
                copied ? (React.createElement(ClipboardCheck, { className: "h-3 w-3" })) : (React.createElement(Copy, { className: "h-3 w-3" })),
                copied ? "Copied" : `Copy ${taskList.length} id${taskList.length === 1 ? "" : "s"}`)),
        React.createElement(TooltipContent, null, "Copy newline-separated task ids \u2014 useful for grepping logs or cross-referencing with Azure activity logs.")));
};
/**
 * Export dropdown — split out so the toolbar stays readable. Implemented
 * as a small popover-less menu (button row inside a relative wrapper)
 * to avoid pulling in DropdownMenu primitives — keeps the change
 * surface inside this folder.
 */
const ExportMenu = ({ onExport }) => {
    const [open, setOpen] = React.useState(false);
    const ref = React.useRef(null);
    React.useEffect(() => {
        if (!open)
            return;
        const onDocClick = (e) => {
            if (!ref.current)
                return;
            if (!ref.current.contains(e.target))
                setOpen(false);
        };
        const onEsc = (e) => {
            if (e.key === "Escape")
                setOpen(false);
        };
        document.addEventListener("mousedown", onDocClick);
        document.addEventListener("keydown", onEsc);
        return () => {
            document.removeEventListener("mousedown", onDocClick);
            document.removeEventListener("keydown", onEsc);
        };
    }, [open]);
    return (React.createElement("div", { ref: ref, className: "relative" },
        React.createElement(Tooltip, null,
            React.createElement(TooltipTrigger, { asChild: true },
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => setOpen((o) => !o), className: "gap-1.5", "aria-haspopup": "menu", "aria-expanded": open, "aria-label": "Export tasks" },
                    React.createElement(ArrowDownToLine, { className: "h-3.5 w-3.5" }),
                    "Export")),
            React.createElement(TooltipContent, null, "Download tasks as CSV or JSON")),
        open && (React.createElement("div", { role: "menu", className: "absolute right-0 top-full z-30 mt-1 flex w-56 animate-fade-in flex-col gap-0.5 rounded-md border border-border bg-popover p-1 shadow-elev-2" },
            React.createElement("div", { className: "px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Current view (filtered)"),
            React.createElement("button", { type: "button", role: "menuitem", onClick: () => {
                    onExport("csv", "filtered");
                    setOpen(false);
                }, className: "flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-muted/40" },
                React.createElement("span", null, "CSV"),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, ".csv")),
            React.createElement("button", { type: "button", role: "menuitem", onClick: () => {
                    onExport("json", "filtered");
                    setOpen(false);
                }, className: "flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-muted/40" },
                React.createElement("span", null, "JSON"),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, ".json")),
            React.createElement("div", { className: "my-1 border-t border-border" }),
            React.createElement("div", { className: "px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "All tasks"),
            React.createElement("button", { type: "button", role: "menuitem", onClick: () => {
                    onExport("csv", "all");
                    setOpen(false);
                }, className: "flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-muted/40" },
                React.createElement("span", null, "CSV (all)"),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, ".csv")),
            React.createElement("button", { type: "button", role: "menuitem", onClick: () => {
                    onExport("json", "all");
                    setOpen(false);
                }, className: "flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-muted/40" },
                React.createElement("span", null, "JSON (all)"),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, ".json"))))));
};
/**
 * Lightweight loading skeleton matching the shape of a TaskRow. Used during
 * the very first render before the runtime subscriber has hydrated. Pure CSS
 * shimmer — no extra deps.
 */
const TaskRowSkeleton = () => (React.createElement("div", { className: "rounded-lg border border-border bg-card p-3" },
    React.createElement("div", { className: "flex items-start gap-3" },
        React.createElement("div", { className: "h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted/40" }),
        React.createElement("div", { className: "flex-1 space-y-2" },
            React.createElement("div", { className: "h-3 w-1/3 animate-pulse rounded bg-muted/40" }),
            React.createElement("div", { className: "h-3 w-2/3 animate-pulse rounded bg-muted/30" }),
            React.createElement("div", { className: "h-2 w-full animate-pulse rounded bg-muted/20" })))));
const StatCard = ({ icon, label, value, suffix, accent = "muted", hint, }) => {
    // Color-coded tones: ring + soft tinted background highlight a non-zero
    // count so the operator's eye lands on the categories that matter.
    const hot = value > 0;
    const body = (React.createElement("div", { className: cn("group relative overflow-hidden rounded-xl border bg-card px-4 py-3 transition-all duration-base", "hover:shadow-elev-1", accent === "primary" &&
            (hot
                ? "border-primary/40 bg-gradient-to-br from-primary/[0.08] to-transparent"
                : "border-border"), accent === "success" &&
            (hot
                ? "border-success/40 bg-gradient-to-br from-success/[0.08] to-transparent"
                : "border-border"), accent === "warning" &&
            (hot
                ? "border-warning/40 bg-gradient-to-br from-warning/[0.08] to-transparent"
                : "border-border"), accent === "destructive" &&
            (hot
                ? "border-destructive/40 bg-gradient-to-br from-destructive/[0.08] to-transparent"
                : "border-border"), accent === "muted" && "border-border") },
        React.createElement("div", { className: "flex items-center justify-between gap-2" },
            React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                label,
                hint && (React.createElement(HelpCircle, { className: "h-3 w-3 cursor-help text-muted-foreground/50 transition-colors hover:text-foreground", "aria-hidden": "true" }))),
            React.createElement("span", { className: cn("shrink-0 transition-colors duration-fast", hot && accent === "primary" && "text-primary", hot && accent === "success" && "text-success", hot && accent === "warning" && "text-warning", hot && accent === "destructive" && "text-destructive", (!hot || accent === "muted") && "text-muted-foreground/60") }, icon)),
        React.createElement("div", { className: cn("mt-1 flex items-baseline gap-1 text-2xl font-semibold tabular-nums leading-tight", hot && accent === "primary" && "text-primary", hot && accent === "success" && "text-success", hot && accent === "warning" && "text-warning", hot && accent === "destructive" && "text-destructive", (!hot || accent === "muted") && "text-foreground") },
            React.createElement(NumberTicker, { value: value }),
            suffix && (React.createElement("span", { className: "text-base font-medium text-muted-foreground/80" }, suffix)))));
    if (!hint)
        return body;
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true }, body),
        React.createElement(TooltipContent, { className: "max-w-xs" }, hint)));
};
/**
 * Special-cased card for "avg completed duration" because it formats a
 * duration string, not a count. Treats undefined (no completed tasks yet)
 * as a clear "—" rather than 0 so users don't read it as zero seconds.
 */
const AvgDurationCard = ({ ms }) => {
    const body = (React.createElement("div", { className: "group relative overflow-hidden rounded-xl border border-border bg-card px-4 py-3 transition-all duration-base hover:shadow-elev-1" },
        React.createElement("div", { className: "flex items-center justify-between gap-2" },
            React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                "Avg run time",
                React.createElement(HelpCircle, { className: "h-3 w-3 cursor-help text-muted-foreground/50 transition-colors hover:text-foreground", "aria-hidden": "true" })),
            React.createElement(Timer, { className: "h-4 w-4 text-muted-foreground/60" })),
        React.createElement("div", { className: "mt-1 text-2xl font-semibold tabular-nums leading-tight text-foreground" }, ms === undefined ? "—" : formatDuration(ms))));
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true }, body),
        React.createElement(TooltipContent, { className: "max-w-xs" }, "Average wall-clock duration across COMPLETED tasks (start \u2192 end). Excludes failed, cancelled, and in-flight tasks.")));
};
//# sourceMappingURL=task-manager-page.js.map