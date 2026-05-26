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
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Copy,
  Filter,
  Gauge,
  HelpCircle,
  Inbox,
  Info,
  Keyboard,
  Loader2,
  Maximize2,
  PauseCircle,
  RotateCw,
  Sparkles,
  Timer,
  Trash2,
  X,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  BorderBeam,
  DotPattern,
  HoverList,
  Meteors,
  NumberTicker,
} from "@/components/ui/effects";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useDashboardOutletContext } from "../page-router";
import { PageHeader } from "../shared/page-header";
import { useMultiRegionStore } from "../../store/store-context";
import { useShortcut } from "../../hooks/use-shortcut";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { auditLog } from "../../services/audit-log";
import {
  TaskRecord,
  TaskStatus,
  taskRuntime,
} from "../../store/task-runtime";

import { BulkActionsBar } from "./bulk-actions-bar";
import { ConfirmationDialog } from "./confirmation-dialog";
import { DestructiveHeatmap } from "./destructive-heatmap";
import { FilterPresets, type FilterPreset } from "./filter-presets";
import { formatDuration } from "./task-formatting";
import { TaskRow } from "./task-row";

const RUNNING_STATES: TaskStatus[] = ["running", "paused"];
const ATTENTION_STATES: TaskStatus[] = ["interrupted", "failed", "partial"];
const TERMINAL_STATES: TaskStatus[] = ["completed", "cancelled"];

/**
 * If a "running" task's lastHeartbeatAt is older than this, the page treats
 * it as "possibly stuck" — visibly badged so the user notices a stall
 * instead of staring at a spinner that's gone dead. Set conservatively
 * higher than the runtime's HEARTBEAT_STALE_MS (30s) so that the runtime's
 * own reclassifier wins normally and we only flag genuine zombies.
 */
const STUCK_THRESHOLD_MS = 60_000;

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
const subscribeTaskRuntime = (callback: () => void): (() => void) => {
  return taskRuntime.subscribe(() => callback());
};

/**
 * Snapshot is the sorted list. Cache it so two snapshot reads in a row
 * return the same reference (otherwise React throws "getSnapshot should be
 * cached"). The cache is invalidated whenever a notify fires.
 */
let _snapshotCache: TaskRecord[] | null = null;
const getTaskRuntimeSnapshot = (): TaskRecord[] => {
  if (_snapshotCache) return _snapshotCache;
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
function ensureSnapshotInvalidator(): void {
  if (_snapshotInvalidatorAttached) return;
  _snapshotInvalidatorAttached = true;
  taskRuntime.subscribe(() => {
    _snapshotCache = null;
  });
}

function useTasks(): [TaskRecord[], () => void] {
  ensureSnapshotInvalidator();
  const tasks = React.useSyncExternalStore(
    subscribeTaskRuntime,
    getTaskRuntimeSnapshot,
    getTaskRuntimeSnapshot,
  );
  // Imperative refresh — invalidates the cache and forces a re-render via
  // a state nudge. Useful when the runtime mutated without firing a
  // notification (hot-reload edges).
  const [, force] = React.useReducer((n: number) => n + 1, 0);
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
function useNowTick(intervalMs = 1_000): number {
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
async function dispatchResume(
  orchestrator: {
    execute: (req: {
      action: string;
      payload: unknown;
      resumeTaskId?: string;
    }) => Promise<unknown>;
  },
  task: TaskRecord,
): Promise<void> {
  // The orchestrator's input shape is { action, payload, ... }; for tasks
  // created via the dispatch path the original input IS that whole shape.
  // We pass `resumeTaskId` so the orchestrator REUSES this task record
  // instead of creating a duplicate (the auto-resume bug).
  const input = task.input as { action?: string; payload?: unknown } | undefined;
  const action = input?.action;
  if (!action) {
    // Fallback: infer from kind.
    const inferred =
      task.kind === "create-pools"
        ? "create_pools"
        : task.kind === "create-pools-smart"
          ? "create_pools_smart"
          : task.kind === "provision-accounts"
            ? "create_accounts"
            : null;
    if (!inferred) return;
    await orchestrator.execute({
      action: inferred,
      payload: task.input,
      resumeTaskId: task.id,
    });
    return;
  }
  await orchestrator.execute({
    action,
    payload: input?.payload ?? {},
    resumeTaskId: task.id,
  });
}

/**
 * Compute whether a "running" task has gone silent — heartbeat older than
 * the STUCK_THRESHOLD. Returns null if status isn't running OR the task
 * hasn't been around long enough to evaluate.
 */
function isStuckRunning(t: TaskRecord, nowMs: number): boolean {
  if (t.status !== "running") return false;
  const hb = t.lastHeartbeatAt
    ? new Date(t.lastHeartbeatAt).getTime()
    : t.updatedAt
      ? new Date(t.updatedAt).getTime()
      : 0;
  if (hb === 0) return false;
  return nowMs - hb > STUCK_THRESHOLD_MS;
}

/**
 * Trigger a browser download of a Blob via an ephemeral anchor. Pure
 * client-side; never persists to the server.
 */
function downloadBlob(filename: string, blob: Blob): void {
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
function tasksToCsv(tasks: TaskRecord[]): Blob {
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
  const escape = (v: unknown): string => {
    if (v === undefined || v === null) return "";
    const s = String(v);
    // Quote when contains a comma, quote, or newline; double internal quotes.
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = [headers.join(",")];
  for (const t of tasks) {
    rows.push(
      [
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
      ].join(","),
    );
  }
  return new Blob([rows.join("\r\n")], {
    type: "text/csv;charset=utf-8;",
  });
}

function tasksToJson(tasks: TaskRecord[]): Blob {
  return new Blob([JSON.stringify(tasks, null, 2)], {
    type: "application/json;charset=utf-8;",
  });
}

/* --------------------------------------------------------------------- */
/* Status chip set (multi-select filter)                                 */
/* --------------------------------------------------------------------- */

interface ChipDef {
  status: TaskStatus | "all-active";
  label: string;
  tone: "primary" | "success" | "warning" | "destructive" | "muted";
}

const STATUS_CHIPS: ChipDef[] = [
  { status: "all-active", label: "Active only", tone: "primary" },
  { status: "running", label: "Running", tone: "primary" },
  { status: "paused", label: "Paused", tone: "warning" },
  { status: "interrupted", label: "Interrupted", tone: "warning" },
  { status: "failed", label: "Failed", tone: "destructive" },
  { status: "partial", label: "Partial", tone: "warning" },
  { status: "completed", label: "Completed", tone: "success" },
  { status: "cancelled", label: "Cancelled", tone: "muted" },
];

const StatusChip: React.FC<{
  def: ChipDef;
  active: boolean;
  count: number;
  onClick: () => void;
}> = ({ def, active, count, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-semibold tabular-nums transition-all duration-fast",
        "hover:shadow-elev-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        !active && "border-border bg-card text-muted-foreground hover:bg-muted/40",
        active &&
          def.tone === "primary" &&
          "border-primary/40 bg-primary/10 text-primary",
        active &&
          def.tone === "success" &&
          "border-success/40 bg-success/10 text-success",
        active &&
          def.tone === "warning" &&
          "border-warning/40 bg-warning/10 text-warning",
        active &&
          def.tone === "destructive" &&
          "border-destructive/40 bg-destructive/10 text-destructive",
        active && def.tone === "muted" && "border-border bg-muted/40 text-foreground",
      )}
    >
      <span>{def.label}</span>
      <span
        className={cn(
          "rounded-full px-1 text-2xs leading-tight",
          active ? "bg-background/60" : "bg-muted/40",
        )}
      >
        {count}
      </span>
    </button>
  );
};

/* --------------------------------------------------------------------- */
/* Section                                                                */
/* --------------------------------------------------------------------- */

interface SectionProps {
  title: string;
  tasks: TaskRecord[];
  /** Pre-built empty-state element (icon + headline + optional CTA). */
  emptyState?: React.ReactNode;
  /** Optional accent ring for the section header (matches its semantic role). */
  accent?: "primary" | "warning" | "muted";
  actions: React.ComponentProps<typeof TaskRow>["actions"];
  nowTick: number;
  defaultOpen?: boolean;
  /** Tooltip help text explaining what belongs in this section. */
  helpText?: string;
  /** Bulk actions surfaced in the section header for non-empty sections. */
  headerActions?: React.ReactNode;
  /** Currently-selected task ids (multi-select). */
  selectedIds?: Set<string>;
  /** Anchor id used to drive shift-click range selection highlighting. */
  anchorId?: string | null;
  /** Selection handler — invoked on bare/cmd/ctrl/shift click. */
  onSelect?: (
    id: string,
    modifiers?: { shift: boolean; meta: boolean; ctrl: boolean },
  ) => void;
  /** Show the inline raw-JSON expander on each row. */
  enableJsonExpander?: boolean;
}

const Section: React.FC<SectionProps> = ({
  title,
  tasks,
  emptyState,
  accent = "muted",
  actions,
  nowTick,
  defaultOpen = true,
  helpText,
  headerActions,
  selectedIds,
  anchorId,
  onSelect,
  enableJsonExpander,
}) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section
      className={cn(
        "rounded-xl border bg-surface-base/40 p-3 transition-colors duration-base",
        accent === "primary" && "border-primary/20",
        accent === "warning" && "border-warning/25",
        accent === "muted" && "border-border",
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center justify-start gap-2 rounded-md px-1 py-1 text-left text-sm font-semibold text-foreground transition-colors duration-fast hover:bg-muted/40"
          aria-expanded={open}
        >
          <span className="inline-flex items-center gap-2">
            <span>{title}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums",
                accent === "primary" && "bg-primary/10 text-primary",
                accent === "warning" && "bg-warning/10 text-warning",
                accent === "muted" && "bg-muted/40 text-muted-foreground",
              )}
            >
              {tasks.length}
            </span>
            {helpText && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    aria-label={`${title} help`}
                    className="inline-flex h-4 w-4 cursor-help items-center justify-center text-muted-foreground/70 hover:text-foreground"
                  >
                    <HelpCircle className="h-3 w-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">{helpText}</TooltipContent>
              </Tooltip>
            )}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {headerActions}
          <span className="text-2xs text-muted-foreground">
            {open ? "Hide" : "Show"}
          </span>
        </div>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {tasks.length === 0 ? (
            emptyState ?? (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                No tasks here.
              </div>
            )
          ) : (
            <HoverList
              items={tasks}
              getKey={(t) => t.id}
              tone={accent === "warning" ? "warning" : "primary"}
              className="gap-2"
              renderItem={(t) => (
                <TaskRow
                  task={t}
                  actions={actions}
                  nowTick={nowTick}
                  // Highlight every row that's in the multi-select set; the
                  // anchor is the "focus" row that keyboard shortcuts target.
                  selected={
                    selectedIds ? selectedIds.has(t.id) : anchorId === t.id
                  }
                  onSelect={onSelect}
                  enableJsonExpander={enableJsonExpander}
                />
              )}
            />
          )}
        </div>
      )}
    </section>
  );
};

/* --------------------------------------------------------------------- */
/* Empty state                                                            */
/* --------------------------------------------------------------------- */

interface EmptyStateProps {
  icon: React.ReactNode;
  headline: string;
  subtext?: string;
  cta?: React.ReactNode;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  headline,
  subtext,
  cta,
}) => (
  <div className="flex animate-fade-in flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-base/30 px-4 py-8 text-center">
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/40 text-muted-foreground">
      {icon}
    </div>
    <div className="text-sm font-medium text-foreground">{headline}</div>
    {subtext && (
      <div className="max-w-md text-xs text-muted-foreground">{subtext}</div>
    )}
    {cta && <div className="mt-1">{cta}</div>}
  </div>
);

/* --------------------------------------------------------------------- */
/* Main page                                                              */
/* --------------------------------------------------------------------- */

export const TaskManagerPage: React.FC = () => {
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
  const [activeChips, setActiveChips] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [copiedIdsSection, setCopiedIdsSection] = React.useState<string | null>(
    null,
  );
  /**
   * Confirmation dialog state.
   *
   * The original 3 kinds (clear-finished, discard-interrupted, remove-history)
   * are header-driven; the new bulk-* kinds are selection-driven and carry
   * an explicit id list so the dialog can show the affected count and the
   * onConfirm handler doesn't need to re-derive eligibility (the selection
   * may have changed between opening the dialog and the user confirming).
   */
  const [confirmState, setConfirmState] = React.useState<{
    kind:
      | "clear-finished"
      | "discard-interrupted"
      | "remove-history"
      | "bulk-cancel"
      | "bulk-remove"
      | "bulk-resume"
      | "bulk-pause"
      | null;
    /** Frozen target ids for bulk-* kinds (snapshotted when the dialog opens). */
    ids?: string[];
  }>({ kind: null });

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
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [anchorId, setAnchorId] = React.useState<string | null>(null);
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
  const [tailMode, setTailMode, _resetTail] = usePersistedState<boolean>(
    "mr.task-manager.tail-mode",
    false,
    { version: 1 },
  );
  void _resetTail; // reserved for a future "reset preferences" hook

  /**
   * "Show only failed in last 24h" — a persisted shortcut chip distinct
   * from the regular status chip set because it has a time-window
   * predicate. When on, OR'd onto the existing chip selection so the user
   * can combine it with the search box and other chips.
   */
  const [failed24h, setFailed24h] = usePersistedState<boolean>(
    "mr.task-manager.filter.failed-24h",
    false,
    { version: 1 },
  );

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
  const prevTasksRef = React.useRef<Map<string, TaskStatus>>(new Map());
  const [ariaAnnounce, setAriaAnnounce] = React.useState<string>("");
  React.useEffect(() => {
    const prev = prevTasksRef.current;
    const next = new Map<string, TaskStatus>();
    const transitions: { label: string; from: TaskStatus; to: TaskStatus }[] = [];
    for (const t of tasks) {
      next.set(t.id, t.status);
      const before = prev.get(t.id);
      if (before !== undefined && before !== t.status) {
        transitions.push({ label: t.label, from: before, to: t.status });
      }
    }
    prevTasksRef.current = next;
    if (transitions.length === 0) return;
    // Most-recent transition wins. For 2+ transitions, summarize.
    if (transitions.length === 1) {
      const x = transitions[0];
      setAriaAnnounce(`Task ${x.label} moved from ${x.from} to ${x.to}.`);
    } else {
      const last = transitions[transitions.length - 1];
      setAriaAnnounce(
        `${transitions.length} tasks changed status. Most recent: ${last.label} is now ${last.to}.`,
      );
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
  const [hotkeyHint, setHotkeyHint] = React.useState<string | null>(null);
  const showHotkeyHint = React.useCallback((msg: string) => {
    setHotkeyHint(msg);
    window.setTimeout(() => {
      setHotkeyHint((cur) => (cur === msg ? null : cur));
    }, 1800);
  }, []);

  const toggleChip = React.useCallback((status: string) => {
    setActiveChips((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
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
    const counts: Record<string, number> = {
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
      counts[t.status] = (counts[t.status] ?? 0) + 1;
      if (
        t.status === "running" ||
        t.status === "paused" ||
        t.status === "interrupted"
      ) {
        activeCount++;
      }
    }
    return { ...counts, "all-active": activeCount } as Record<string, number>;
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
      // "Failed in last 24h" gate is intersected with the other filters —
      // explicitly the most restrictive predicate so users can pair it
      // with search.
      if (failed24h) {
        if (t.status !== "failed") return false;
        const updated = new Date(t.updatedAt).getTime();
        if (!isFinite(updated) || updated < cutoff) return false;
      }
      // Status-chip predicate: if any chip is active, the task must match
      // at least one selected predicate (OR semantics within the chip set).
      if (activeChips.size > 0) {
        let chipMatch = false;
        if (activeChips.has("all-active")) {
          if (
            t.status === "running" ||
            t.status === "paused" ||
            t.status === "interrupted"
          ) {
            chipMatch = true;
          }
        }
        if (!chipMatch && activeChips.has(t.status)) {
          chipMatch = true;
        }
        if (!chipMatch) return false;
      }
      if (!q) return true;
      // Search by id supports full id, short prefix (first 8 chars), and
      // also matches against the legacy fields.
      const shortId = t.id.slice(0, 8).toLowerCase();
      return (
        t.label.toLowerCase().includes(q) ||
        t.kind.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        shortId.includes(q) ||
        (t.subscriptionId ?? "").toLowerCase().includes(q) ||
        (t.currentStep ?? "").toLowerCase().includes(q)
      );
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
  const handleRowSelect = React.useCallback(
    (
      id: string,
      modifiers?: { shift: boolean; meta: boolean; ctrl: boolean },
    ) => {
      const mod = modifiers ?? { shift: false, meta: false, ctrl: false };
      if (mod.shift && anchorId) {
        // Range-select within the current filtered list.
        const ids = filtered.map((t) => t.id);
        const aIdx = ids.indexOf(anchorId);
        const bIdx = ids.indexOf(id);
        if (aIdx >= 0 && bIdx >= 0) {
          const [lo, hi] = aIdx <= bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (let i = lo; i <= hi; i++) next.add(ids[i]);
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
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setAnchorId(id);
        return;
      }
      // Bare click → single-select replace.
      setSelectedIds(new Set([id]));
      setAnchorId(id);
    },
    [anchorId, filtered],
  );

  /**
   * Stuck-running tasks are surfaced under attention so the user sees
   * stalls without staring at the spinner. We still keep them in the
   * running section as well (they are "running" semantically) — the
   * visible badge is rendered by TaskRow via its own status, so here we
   * just teach the section grouping to ALSO show them under attention.
   */
  const stuckIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const t of filtered) {
      if (isStuckRunning(t, nowMs)) ids.add(t.id);
    }
    return ids;
  }, [filtered, nowMs]);

  const grouped = React.useMemo(() => {
    const running: TaskRecord[] = [];
    const attention: TaskRecord[] = [];
    const terminal: TaskRecord[] = [];
    for (const t of filtered) {
      if (RUNNING_STATES.includes(t.status)) running.push(t);
      else if (ATTENTION_STATES.includes(t.status)) attention.push(t);
      else if (TERMINAL_STATES.includes(t.status)) terminal.push(t);
      // Mirror stuck-running into the attention section too (still also in
      // running). The Set guards against double-add when a future status
      // happens to be both running and attention.
      if (stuckIds.has(t.id) && !attention.includes(t)) {
        attention.push(t);
      }
    }
    return { running, attention, terminal };
  }, [filtered, stuckIds]);

  const actions = React.useMemo(
    () => ({
      onCancel: (id: string) => {
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
        } catch {
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
            kind: rec?.kind,
            label: rec?.label,
            priorStatus: rec?.status,
          },
        });
      },
      onResume: async (id: string) => {
        const rec = taskRuntime.get(id);
        if (!rec) return;
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
          await dispatchResume(orchestrator, rec);
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
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
      },
      onPause: (id: string) => {
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
          details: { kind: rec?.kind, label: rec?.label },
        });
      },
      onStart: async (id: string) => {
        // "Start" from a paused task is the same code path as Resume —
        // re-dispatch with `resumeTaskId` so the orchestrator adopts the
        // existing record. Idempotent provisioning skips already-done
        // work on the Azure side.
        const rec = taskRuntime.get(id);
        if (!rec) return;
        auditLog.record({
          actor: "ui",
          action: "task_start",
          target: `task:${id}`,
          status: "success",
          details: { kind: rec.kind, label: rec.label },
        });
        try {
          await dispatchResume(orchestrator, rec);
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
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
      },
      onDiscard: (id: string) => {
        const rec = taskRuntime.get(id);
        taskRuntime.update(id, { status: "cancelled" });
        auditLog.record({
          actor: "ui",
          action: "task_discard",
          target: `task:${id}`,
          status: "success",
          details: { kind: rec?.kind, label: rec?.label, priorStatus: rec?.status },
        });
      },
      onRemove: (id: string) => {
        const rec = taskRuntime.get(id);
        taskRuntime.remove(id);
        auditLog.record({
          actor: "ui",
          action: "task_remove",
          target: `task:${id}`,
          status: "success",
          details: { kind: rec?.kind, label: rec?.label, priorStatus: rec?.status },
        });
      },
    }),
    [orchestrator],
  );

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
      avgCompletedMs: undefined as number | undefined,
    };
    let completedDurationSum = 0;
    let completedDurationN = 0;
    let terminalCount = 0;
    for (const t of tasks) {
      switch (t.status) {
        case "running":
          out.running++;
          if (isStuckRunning(t, nowMs)) out.stuck++;
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
            const dur =
              new Date(t.updatedAt).getTime() -
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
    if (!rec) return;
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
    if (!rec) return;
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
    if (!rec) return;
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
    if (selectedIds.size === 0 && anchorId === null) return;
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
  const tailAnchorRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!tailMode) return;
    if (!tailAnchorRef.current) return;
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
    if (selectedIds.size === 0 && anchorId === null) return;
    const liveIds = new Set(tasks.map((t) => t.id));
    let mutated = false;
    const nextSet = new Set<string>();
    for (const id of selectedIds) {
      if (liveIds.has(id)) nextSet.add(id);
      else mutated = true;
    }
    if (mutated) setSelectedIds(nextSet);
    if (anchorId !== null && !liveIds.has(anchorId)) {
      const replacement = nextSet.values().next().value ?? null;
      setAnchorId(replacement);
    }
  }, [tasks, selectedIds, anchorId]);

  const popOut = React.useCallback(() => {
    // Open the same route in a borderless window. The shell still mounts
    // (auth, store, etc) — this is just a window-shaped iframe of /tasks.
    const url = `${window.location.origin}${window.location.pathname}#/tasks`;
    window.open(
      url,
      "task-manager",
      "popup=yes,width=960,height=720,resizable=yes",
    );
  }, []);

  /**
   * Copy a list of task ids to the clipboard, newline-separated. Sets a
   * short-lived "copied" flag for the originating button. Falls back to
   * a notification if the clipboard API is unavailable (rare; older
   * iframes / non-secure contexts).
   */
  const copyIds = React.useCallback(
    async (sectionKey: string, taskList: TaskRecord[]) => {
      if (taskList.length === 0) return;
      const text = taskList.map((t) => t.id).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        setCopiedIdsSection(sectionKey);
        store.addNotification({
          type: "success",
          message: `Copied ${taskList.length} task id${taskList.length === 1 ? "" : "s"} to clipboard.`,
          autoDismissMs: 2500,
        });
        window.setTimeout(() => {
          setCopiedIdsSection((s) => (s === sectionKey ? null : s));
        }, 1500);
      } catch {
        store.addNotification({
          type: "error",
          message:
            "Clipboard write failed — your browser may be blocking it on http:// origins.",
          autoDismissMs: 4000,
        });
      }
    },
    [store],
  );

  /**
   * Export helpers. `exportScope === "filtered"` uses the live filtered
   * list (status chips + search), "all" exports every task.
   */
  const doExport = React.useCallback(
    (format: "csv" | "json", scope: "filtered" | "all") => {
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
      } else {
        downloadBlob(`${base}.json`, tasksToJson(list));
      }
      store.addNotification({
        type: "success",
        message: `Exported ${list.length} task${list.length === 1 ? "" : "s"} (${format.toUpperCase()}).`,
        autoDismissMs: 2500,
      });
    },
    [filtered, tasks, store],
  );

  /**
   * BulkActionsBar wiring. Confirmation flows through the existing
   * ConfirmationDialog state machine — bulk-* kinds carry their target id
   * list so confirm is decoupled from the live selection (which the user
   * might mutate between opening the dialog and clicking confirm).
   *
   * Export-selected is fire-and-forget — no confirmation needed, it's a
   * read-only download. It piggybacks on the existing `tasksToJson` helper.
   */
  const onBulkCancel = React.useCallback(
    (ids: string[]) => openBulkConfirm("bulk-cancel", ids),
    [openBulkConfirm],
  );
  const onBulkRemove = React.useCallback(
    (ids: string[]) => openBulkConfirm("bulk-remove", ids),
    [openBulkConfirm],
  );
  const onBulkResume = React.useCallback(
    (ids: string[]) => openBulkConfirm("bulk-resume", ids),
    [openBulkConfirm],
  );
  const onBulkPause = React.useCallback(
    (ids: string[]) => openBulkConfirm("bulk-pause", ids),
    [openBulkConfirm],
  );
  const onBulkExport = React.useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
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
    },
    [tasks, store],
  );
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
  const onApplyPreset = React.useCallback(
    (p: FilterPreset) => {
      setFilter(p.search);
      setActiveChips(new Set(p.chips));
      setFailed24h(p.failed24h);
      // The preset application itself doesn't change selection, but a
      // re-filter may shrink/expand the visible list. The dangling-
      // selection effect will reconcile if needed.
    },
    [setFailed24h],
  );

  // Auto-resume banner — read once on mount. The auto-resumer (mounted in
  // dashboard-shell) writes the count just before dispatching; we surface it
  // here as an animated info banner that auto-dismisses or can be closed.
  const [autoResumedCount, setAutoResumedCount] = React.useState<number | null>(
    () => {
      try {
        const raw = window.sessionStorage.getItem(SESSION_AUTO_RESUMED_COUNT_KEY);
        const shown = window.sessionStorage.getItem(SESSION_AUTO_RESUMED_SHOWN_KEY) === "1";
        if (!raw || shown) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },
  );

  React.useEffect(() => {
    if (autoResumedCount === null) return;
    // Mark as shown so a navigation back to the page doesn't re-display.
    try {
      window.sessionStorage.setItem(SESSION_AUTO_RESUMED_SHOWN_KEY, "1");
    } catch {
      /**/
    }
  }, [autoResumedCount]);

  const dismissAutoResumed = React.useCallback(() => {
    setAutoResumedCount(null);
  }, []);

  /**
   * Confirmation dialog handlers — wired to a single state machine so we
   * never end up with two dialogs simultaneously.
   *
   * Two openers: one for the header-driven kinds (no ids), one for the
   * bulk-* kinds (with a frozen id snapshot so dialog confirmation
   * operates on the selection at open-time, not at confirm-time).
   */
  const openConfirm = React.useCallback(
    (kind: "clear-finished" | "discard-interrupted" | "remove-history") => {
      setConfirmState({ kind });
    },
    [],
  );
  const openBulkConfirm = React.useCallback(
    (
      kind: "bulk-cancel" | "bulk-remove" | "bulk-resume" | "bulk-pause",
      ids: string[],
    ) => {
      if (ids.length === 0) return;
      setConfirmState({ kind, ids: ids.slice() });
    },
    [],
  );
  const closeConfirm = React.useCallback(() => {
    setConfirmState({ kind: null });
  }, []);

  const finishedTasks = React.useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.status === "completed" ||
          t.status === "cancelled" ||
          t.status === "failed" ||
          t.status === "partial",
      ),
    [tasks],
  );
  const interruptedTasks = React.useMemo(
    () => tasks.filter((t) => t.status === "interrupted"),
    [tasks],
  );
  const historyTasks = React.useMemo(
    () => tasks.filter((t) => TERMINAL_STATES.includes(t.status)),
    [tasks],
  );

  const onConfirm = React.useCallback(() => {
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
    } else if (confirmState.kind === "discard-interrupted") {
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
    } else if (confirmState.kind === "remove-history") {
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
    } else if (confirmState.kind === "bulk-cancel") {
      const ids = confirmState.ids ?? [];
      let applied = 0;
      for (const id of ids) {
        const rec = taskRuntime.get(id);
        if (!rec || (rec.status !== "running" && rec.status !== "paused")) continue;
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
    } else if (confirmState.kind === "bulk-remove") {
      const ids = confirmState.ids ?? [];
      let applied = 0;
      for (const id of ids) {
        const rec = taskRuntime.get(id);
        if (!rec) continue;
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
    } else if (confirmState.kind === "bulk-resume") {
      const ids = confirmState.ids ?? [];
      let applied = 0;
      // Serial dispatch — orchestrator concurrency / rate-limit guards
      // see them in order. Errors land on each task record.
      void (async () => {
        for (const id of ids) {
          const rec = taskRuntime.get(id);
          if (!rec) continue;
          if (
            rec.status !== "interrupted" &&
            rec.status !== "paused" &&
            rec.status !== "failed"
          )
            continue;
          try {
            if (rec.status === "paused") {
              await actions.onStart(id);
            } else {
              await actions.onResume(id);
            }
            applied++;
          } catch {
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
      })();
    } else if (confirmState.kind === "bulk-pause") {
      const ids = confirmState.ids ?? [];
      let applied = 0;
      for (const id of ids) {
        const rec = taskRuntime.get(id);
        if (!rec || rec.status !== "running") continue;
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
  const showInitialSkeleton =
    tasks.length === 0 &&
    filter === "" &&
    activeChips.size === 0 &&
    !failed24h;

  /* --- Confirm dialog content per kind ---------------------------------- */
  const confirmPayload = React.useMemo<{
    title: string;
    description: React.ReactNode;
    details: React.ReactNode;
    confirmLabel: string;
    tone: "destructive" | "warning";
  } | null>(() => {
    if (confirmState.kind === "clear-finished") {
      return {
        title: `Clear ${finishedTasks.length} finished task${finishedTasks.length === 1 ? "" : "s"}?`,
        description:
          "Removes completed, cancelled, failed, and partial tasks from the list. Running and interrupted tasks are kept. This cannot be undone.",
        confirmLabel: "Clear finished",
        tone: "destructive" as const,
        details: <ConfirmDetailsList tasks={finishedTasks.slice(0, 8)} more={Math.max(0, finishedTasks.length - 8)} />,
      };
    }
    if (confirmState.kind === "discard-interrupted") {
      return {
        title: `Discard ${interruptedTasks.length} interrupted task${interruptedTasks.length === 1 ? "" : "s"}?`,
        description:
          "Marks every interrupted task as cancelled. They will no longer auto-resume on reload. Already-provisioned Azure resources are NOT removed.",
        confirmLabel: "Discard all",
        tone: "warning" as const,
        details: <ConfirmDetailsList tasks={interruptedTasks.slice(0, 8)} more={Math.max(0, interruptedTasks.length - 8)} />,
      };
    }
    if (confirmState.kind === "remove-history") {
      return {
        title: `Remove ${historyTasks.length} historical task${historyTasks.length === 1 ? "" : "s"}?`,
        description:
          "Permanently deletes completed and cancelled tasks from the list. This frees localStorage space. Cannot be undone.",
        confirmLabel: "Remove history",
        tone: "destructive" as const,
        details: <ConfirmDetailsList tasks={historyTasks.slice(0, 8)} more={Math.max(0, historyTasks.length - 8)} />,
      };
    }
    // Bulk-* kinds: resolve the frozen id snapshot back to TaskRecord objects
    // for the details list. Stale ids (task removed between dialog open and
    // confirm) silently drop out of the displayed list — the action handler
    // also re-validates on confirm so we never operate on stale ids.
    if (
      confirmState.kind === "bulk-cancel" ||
      confirmState.kind === "bulk-remove" ||
      confirmState.kind === "bulk-resume" ||
      confirmState.kind === "bulk-pause"
    ) {
      const ids = confirmState.ids ?? [];
      const targets: TaskRecord[] = [];
      for (const id of ids) {
        const t = taskRuntime.get(id);
        if (t) targets.push(t);
      }
      const n = targets.length;
      const noun = n === 1 ? "task" : "tasks";
      if (confirmState.kind === "bulk-cancel") {
        return {
          title: `Cancel ${n} ${noun}?`,
          description:
            "Stops running/paused tasks after the current step. Already-provisioned Azure resources are NOT removed.",
          confirmLabel: `Cancel ${n} ${noun}`,
          tone: "warning" as const,
          details: <ConfirmDetailsList tasks={targets.slice(0, 8)} more={Math.max(0, n - 8)} />,
        };
      }
      if (confirmState.kind === "bulk-remove") {
        return {
          title: `Remove ${n} ${noun} from the list?`,
          description:
            "Permanently deletes the selected tasks. Cannot be undone. Does not touch Azure resources.",
          confirmLabel: `Remove ${n} ${noun}`,
          tone: "destructive" as const,
          details: <ConfirmDetailsList tasks={targets.slice(0, 8)} more={Math.max(0, n - 8)} />,
        };
      }
      if (confirmState.kind === "bulk-resume") {
        return {
          title: `Resume ${n} ${noun}?`,
          description:
            "Re-dispatches each task with its original input. Idempotent operations skip already-done work on the Azure side.",
          confirmLabel: `Resume ${n} ${noun}`,
          tone: "warning" as const,
          details: <ConfirmDetailsList tasks={targets.slice(0, 8)} more={Math.max(0, n - 8)} />,
        };
      }
      if (confirmState.kind === "bulk-pause") {
        return {
          title: `Pause ${n} ${noun}?`,
          description:
            "Cooperative pause — each task stops after its current iteration. Resume any time from this page.",
          confirmLabel: `Pause ${n} ${noun}`,
          tone: "warning" as const,
          details: <ConfirmDetailsList tasks={targets.slice(0, 8)} more={Math.max(0, n - 8)} />,
        };
      }
    }
    return null;
  }, [confirmState.kind, confirmState.ids, finishedTasks, interruptedTasks, historyTasks]);

  return (
    <div className="flex flex-col gap-5 py-2">
      <div className="relative overflow-hidden rounded-xl border bg-card/50 p-6">
        <DotPattern fade="top-left" className="absolute inset-0" />
        <Meteors count={12} tone="primary" className="absolute inset-0" />
        <div className="relative z-10 flex flex-col gap-2">
          <div className="inline-flex items-center gap-2 self-start rounded-full bg-primary/10 px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-primary">
            <ClipboardList className="h-3 w-3" />
            Task Manager
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label="What is a task?"
                  className="ml-0.5 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full text-primary/70 hover:text-primary"
                >
                  <Info className="h-3 w-3" />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                A task is a long-running workflow (e.g. provisioning,
                pool creation). Tasks persist across reloads and can be
                paused, resumed, or auto-resumed silently.
              </TooltipContent>
            </Tooltip>
          </div>
          <PageHeader
            title="Long-running workflows"
            description="Tasks persist across reloads. Resume after interruption, watch progress live, or pop out to a dedicated window."
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={refreshTasks}
                  className="gap-1.5 transition-all duration-fast hover:shadow-elev-1"
                  aria-label="Refresh task list"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  Refresh
                </Button>
              </TooltipTrigger>
              <TooltipContent>Re-read from localStorage (already live-subscribed)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={popOut}
                  className="gap-1.5 transition-all duration-fast hover:shadow-elev-1"
                  aria-label="Open Task Manager in a new window"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  Pop out
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in a dedicated browser window</TooltipContent>
            </Tooltip>
            <ExportMenu onExport={doExport} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openConfirm("clear-finished")}
                  className="gap-1.5 transition-all duration-fast hover:shadow-elev-1"
                  disabled={finishedTasks.length === 0}
                  aria-label="Clear completed, cancelled, and failed tasks"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear finished
                </Button>
              </TooltipTrigger>
              <TooltipContent>Asks for confirmation first</TooltipContent>
            </Tooltip>
          </PageHeader>
        </div>
      </div>

      {/* Auto-resume banner — info tone, animated entrance. Renders when the
          page mounts after task-auto-resumer wrote a fresh count to
          sessionStorage. */}
      {autoResumedCount !== null && (
        <div
          role="status"
          className="flex animate-slide-in-bottom items-start gap-3 rounded-xl border border-info/30 bg-info/5 p-3 shadow-elev-1"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-info/15 ring-1 ring-info/40">
            <Sparkles className="h-4 w-4 text-info" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-info">
              <Info className="h-3.5 w-3.5" />
              Auto-resumed {autoResumedCount} task
              {autoResumedCount === 1 ? "" : "s"} after reload
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Idempotent operations re-run safely — Azure skips work that
              already succeeded. Watch progress below.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={dismissAutoResumed}
            aria-label="Dismiss auto-resume banner"
            className="shrink-0"
          >
            <XCircle className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Stuck-running heads-up — only shows when ≥1 task's heartbeat went
          silent past STUCK_THRESHOLD. The runtime's own reclassifier
          eventually flips them to interrupted, but in the gap the user
          sees a visible warning so they don't keep waiting on a zombie. */}
      {summary.stuck > 0 && (
        <div
          role="status"
          className="flex animate-fade-in items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-3 shadow-elev-1"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/15 ring-1 ring-warning/40">
            <AlertTriangle className="h-4 w-4 text-warning" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-warning">
              {summary.stuck} task{summary.stuck === 1 ? "" : "s"} possibly stuck
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              No heartbeat in over {Math.round(STUCK_THRESHOLD_MS / 1000)}s.
              These rows are also surfaced under <strong>Needs attention</strong>{" "}
              so you can decide whether to cancel and resume.
            </p>
          </div>
        </div>
      )}

      {/* Stat summary card row — color-coded by tone. Bigger numbers, label
          on top so the row reads top-down at a glance. */}
      <div className="relative overflow-hidden rounded-xl p-2">
        <BorderBeam size={200} duration={8} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard
            icon={<Loader2 className="h-4 w-4 animate-spin" />}
            label="Running"
            value={summary.running}
            accent="primary"
            hint="Tasks executing right now."
          />
          <StatCard
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Interrupted"
            value={summary.interrupted}
            accent="warning"
            hint="Tasks that lost their tab. Click Resume to re-dispatch."
          />
          <StatCard
            icon={<CheckCircle2 className="h-4 w-4" />}
            label="Completed"
            value={summary.completed}
            accent="success"
            hint="Tasks that finished cleanly."
          />
          <StatCard
            icon={<XCircle className="h-4 w-4" />}
            label="Failed"
            value={summary.failed}
            accent="destructive"
            hint="Tasks that ended with unrecoverable errors."
          />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatCard
            icon={<ClipboardList className="h-4 w-4" />}
            label="Total tasks"
            value={summary.total}
            accent="muted"
            hint="All tasks across every status, persisted to localStorage."
          />
          <StatCard
            icon={<Gauge className="h-4 w-4" />}
            label="Success rate"
            value={summary.successRate}
            suffix="%"
            accent={summary.successRate >= 80 ? "success" : summary.successRate >= 50 ? "warning" : "destructive"}
            hint="Completed ÷ all terminal tasks (failed + cancelled + partial + completed)."
          />
          <AvgDurationCard ms={summary.avgCompletedMs} />
        </div>
      </div>

      {summary.paused > 0 && (
        <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-warning/30 bg-warning/5 px-2.5 py-0.5 text-2xs font-medium text-warning">
          <PauseCircle className="h-3 w-3" />
          {summary.paused} paused
        </div>
      )}

      {/* Destructive-op heatmap — corpus-grounded operator self-check.
          See destructive-heatmap.tsx for the rationale (Azure bypass
          playbook items 8-10: subscription cancel, hard-delete user,
          delete diagnostic setting). Self-hides when there's nothing
          to show AND no anomalous burst was detected. */}
      <DestructiveHeatmap hideWhenEmpty />

      {/* ARIA-live region: announces task status transitions for screen
          readers. Off-screen but polite — narrates "Task <label> moved
          from <from> to <to>" so non-visual users get the same realtime
          feedback as the live-glow row treatment. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {ariaAnnounce}
      </div>

      {/* Toolbar — search + status chips. The chip row replaces the
          old single-purpose "Active only" toggle with multi-select
          predicates: combinations like "Failed + Interrupted" let the
          operator answer questions like "what needs my attention?" in
          one click. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <Filter className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter by label, kind, subscription, or id…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 pl-7 pr-7 text-xs transition-shadow duration-fast focus-visible:shadow-elev-1"
              aria-label="Filter tasks"
            />
            {filter && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setFilter("")}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Clear search</TooltipContent>
              </Tooltip>
            )}
          </div>
          {activeChips.size > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={clearChips}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-2xs font-medium text-muted-foreground hover:bg-muted/40"
                  aria-label="Clear status filters"
                >
                  <X className="h-3 w-3" />
                  Clear filters
                </button>
              </TooltipTrigger>
              <TooltipContent>Remove all status filters</TooltipContent>
            </Tooltip>
          )}
          <span className="text-2xs tabular-nums text-muted-foreground">
            {filtered.length} / {tasks.length}
          </span>
          {/* Tail-mode toggle: auto-scrolls to the running section every time
              the underlying tasks list changes. Preference persists across
              reloads via use-persisted-state. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setTailMode((v) => !v)}
                aria-pressed={tailMode}
                aria-label="Toggle tail mode"
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-2xs font-medium tabular-nums transition-colors duration-fast",
                  tailMode
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:bg-muted/40",
                )}
              >
                <ArrowDown className="h-3 w-3" />
                Tail {tailMode ? "on" : "off"}
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              Auto-scrolls to the newest task on every update so live
              progress is always visible.
            </TooltipContent>
          </Tooltip>
          {/* Persisted "Failed in last 24h" filter — surfaced as a separate
              chip because it pairs with a time window, not just a status. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setFailed24h((v) => !v)}
                aria-pressed={failed24h}
                aria-label="Toggle failed-in-last-24h filter"
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-2xs font-medium tabular-nums transition-colors duration-fast",
                  failed24h
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-border bg-card text-muted-foreground hover:bg-muted/40",
                )}
              >
                <XCircle className="h-3 w-3" />
                Failed (24h)
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              Limits the list to tasks whose status is `failed` and whose
              last update was within the past 24 hours. Persisted.
            </TooltipContent>
          </Tooltip>
          {/* Hotkey legend — tiny pill explaining the keyboard shortcuts. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex cursor-help items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-2xs text-muted-foreground"
                aria-label="Keyboard shortcuts help"
              >
                <Keyboard className="h-3 w-3" />
                <kbd className="rounded bg-muted/40 px-1 font-mono">c</kbd>
                /
                <kbd className="rounded bg-muted/40 px-1 font-mono">r</kbd>
                /
                <kbd className="rounded bg-muted/40 px-1 font-mono">p</kbd>
                /
                <kbd className="rounded bg-muted/40 px-1 font-mono">Esc</kbd>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              Click a row to select it, then press <strong>c</strong> to
              cancel,&nbsp;<strong>r</strong> to resume/retry,&nbsp;
              <strong>p</strong> to pause, or <strong>Esc</strong> to clear
              the selection. Shift-click extends the selection; Cmd/Ctrl-click
              toggles a row.
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_CHIPS.map((c) => (
            <StatusChip
              key={c.status}
              def={c}
              active={activeChips.has(c.status)}
              count={countsByStatus[c.status] ?? 0}
              onClick={() => toggleChip(c.status)}
            />
          ))}
        </div>
        {/* Saved filter presets — persisted across reloads. Empty on first
            session; the "Save preset" button appears as a dashed pill the
            operator can use to snapshot the current filter combo. */}
        <FilterPresets
          current={{ search: filter, chips: activeChips, failed24h }}
          onApply={onApplyPreset}
        />
      </div>

      {/* Hotkey hint banner — momentary feedback for `c` / `r` actions. */}
      {hotkeyHint && (
        <div
          role="status"
          className="flex animate-fade-in items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1 text-2xs font-medium text-primary"
        >
          <Keyboard className="h-3 w-3" />
          {hotkeyHint}
        </div>
      )}

      {/* Bulk-actions bar — sticky floating chip-row, only visible when
          ≥2 tasks are selected. Single-select keeps the existing
          c/r/p hotkey ergonomics; multi-select unlocks Pause/Resume/
          Cancel/Remove/Export across the whole selection in one click,
          all gated by ConfirmationDialog. */}
      <BulkActionsBar
        selectedIds={selectedIds}
        getTask={(id) => taskRuntime.get(id)}
        onClear={onClearSelection}
        onBulkCancel={onBulkCancel}
        onBulkResume={onBulkResume}
        onBulkPause={onBulkPause}
        onBulkRemove={onBulkRemove}
        onBulkExport={onBulkExport}
      />

      {/* Tail-mode anchor — scrollIntoView target when tail-mode is on. */}
      <div ref={tailAnchorRef} aria-hidden="true" />

      {showInitialSkeleton ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <TaskRowSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Section
            title="Running & paused"
            tasks={grouped.running}
            accent="primary"
            actions={actions}
            nowTick={nowTick}
            selectedIds={selectedIds}
            anchorId={anchorId}
            onSelect={handleRowSelect}
            enableJsonExpander
            helpText="Tasks executing now or paused mid-flight. Pause is cooperative — the orchestrator finishes the current iteration before stopping."
            headerActions={
              grouped.running.length > 0 ? (
                <CopyIdsButton
                  sectionKey="running"
                  copiedSection={copiedIdsSection}
                  taskList={grouped.running}
                  onCopy={copyIds}
                />
              ) : null
            }
            emptyState={
              <EmptyState
                icon={<Loader2 className="h-5 w-5" />}
                headline="Nothing running right now"
                subtext="Kick off a workflow from another page and the live progress will show up here."
              />
            }
          />
          <Section
            title="Needs attention"
            tasks={grouped.attention}
            accent="warning"
            actions={actions}
            nowTick={nowTick}
            selectedIds={selectedIds}
            anchorId={anchorId}
            onSelect={handleRowSelect}
            enableJsonExpander
            helpText="Interrupted, failed, partial, or stuck tasks. Stuck tasks have no heartbeat for over a minute — consider cancelling and resuming."
            headerActions={
              <div className="flex items-center gap-1">
                {grouped.attention.length > 0 && (
                  <CopyIdsButton
                    sectionKey="attention"
                    copiedSection={copiedIdsSection}
                    taskList={grouped.attention}
                    onCopy={copyIds}
                  />
                )}
                {interruptedTasks.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => openConfirm("discard-interrupted")}
                        aria-label="Discard all interrupted tasks"
                        className="gap-1 text-warning hover:bg-warning/10"
                      >
                        <X className="h-3 w-3" />
                        Discard {interruptedTasks.length} interrupted
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Cancels each interrupted task. Does not touch Azure resources.</TooltipContent>
                  </Tooltip>
                )}
              </div>
            }
            emptyState={
              <EmptyState
                icon={<CheckCircle2 className="h-5 w-5 text-success" />}
                headline="All clear"
                subtext="No interrupted, failed, partial, or stuck tasks. New issues will surface here."
              />
            }
          />
          <Section
            title="History"
            tasks={grouped.terminal}
            actions={actions}
            nowTick={nowTick}
            selectedIds={selectedIds}
            anchorId={anchorId}
            onSelect={handleRowSelect}
            enableJsonExpander
            defaultOpen={false}
            helpText="Completed and cancelled tasks. Use 'Clear finished' or 'Remove history' to clean up."
            headerActions={
              <div className="flex items-center gap-1">
                {grouped.terminal.length > 0 && (
                  <CopyIdsButton
                    sectionKey="terminal"
                    copiedSection={copiedIdsSection}
                    taskList={grouped.terminal}
                    onCopy={copyIds}
                  />
                )}
                {historyTasks.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => openConfirm("remove-history")}
                        aria-label="Remove all historical tasks"
                        className="gap-1 hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                        Remove all
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Permanently removes completed and cancelled tasks.</TooltipContent>
                  </Tooltip>
                )}
              </div>
            }
            emptyState={
              <EmptyState
                icon={<Inbox className="h-5 w-5" />}
                headline="No history yet"
                subtext="Completed and cancelled tasks accumulate here. Use Clear finished to wipe the list."
              />
            }
          />
        </div>
      )}

      {confirmPayload && (
        <ConfirmationDialog
          open={confirmState.kind !== null}
          onOpenChange={(o) => {
            if (!o) closeConfirm();
          }}
          title={confirmPayload.title}
          description={confirmPayload.description}
          details={confirmPayload.details}
          confirmLabel={confirmPayload.confirmLabel}
          tone={confirmPayload.tone}
          onConfirm={onConfirm}
        />
      )}
    </div>
  );
};

/* --------------------------------------------------------------------- */
/* Sub-components                                                         */
/* --------------------------------------------------------------------- */

/**
 * Inline list rendered inside ConfirmationDialog.details — shows the
 * labels of the affected tasks so the user can scan what's about to be
 * destroyed before committing.
 */
const ConfirmDetailsList: React.FC<{ tasks: TaskRecord[]; more: number }> = ({
  tasks,
  more,
}) => {
  if (tasks.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {tasks.map((t) => (
        <li key={t.id} className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 rounded bg-background/40 px-1 py-0.5 text-2xs uppercase tracking-wider">
            {t.status}
          </span>
          <span className="truncate font-medium">{t.label}</span>
          <span className="ml-auto shrink-0 text-2xs font-mono opacity-60">
            {t.id.slice(0, 8)}
          </span>
        </li>
      ))}
      {more > 0 && (
        <li className="text-2xs opacity-70">+ {more} more…</li>
      )}
    </ul>
  );
};

/**
 * Click-to-copy button placed next to section headers. Copies every task
 * id in the section to the clipboard. Brief check-mark feedback.
 */
const CopyIdsButton: React.FC<{
  sectionKey: string;
  copiedSection: string | null;
  taskList: TaskRecord[];
  onCopy: (sectionKey: string, list: TaskRecord[]) => void;
}> = ({ sectionKey, copiedSection, taskList, onCopy }) => {
  const copied = copiedSection === sectionKey;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            onCopy(sectionKey, taskList);
          }}
          className={cn(
            "gap-1 text-2xs",
            copied && "text-success hover:text-success",
          )}
          aria-label={`Copy ${taskList.length} task ids to clipboard`}
        >
          {copied ? (
            <ClipboardCheck className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? "Copied" : `Copy ${taskList.length} id${taskList.length === 1 ? "" : "s"}`}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Copy newline-separated task ids — useful for grepping logs or
        cross-referencing with Azure activity logs.
      </TooltipContent>
    </Tooltip>
  );
};

/**
 * Export dropdown — split out so the toolbar stays readable. Implemented
 * as a small popover-less menu (button row inside a relative wrapper)
 * to avoid pulling in DropdownMenu primitives — keeps the change
 * surface inside this folder.
 */
const ExportMenu: React.FC<{
  onExport: (format: "csv" | "json", scope: "filtered" | "all") => void;
}> = ({ onExport }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen((o) => !o)}
            className="gap-1.5"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Export tasks"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            Export
          </Button>
        </TooltipTrigger>
        <TooltipContent>Download tasks as CSV or JSON</TooltipContent>
      </Tooltip>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 flex w-56 animate-fade-in flex-col gap-0.5 rounded-md border border-border bg-popover p-1 shadow-elev-2"
        >
          <div className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Current view (filtered)
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onExport("csv", "filtered");
              setOpen(false);
            }}
            className="flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-muted/40"
          >
            <span>CSV</span>
            <span className="text-2xs text-muted-foreground">.csv</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onExport("json", "filtered");
              setOpen(false);
            }}
            className="flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-muted/40"
          >
            <span>JSON</span>
            <span className="text-2xs text-muted-foreground">.json</span>
          </button>
          <div className="my-1 border-t border-border" />
          <div className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            All tasks
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onExport("csv", "all");
              setOpen(false);
            }}
            className="flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-muted/40"
          >
            <span>CSV (all)</span>
            <span className="text-2xs text-muted-foreground">.csv</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onExport("json", "all");
              setOpen(false);
            }}
            className="flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-muted/40"
          >
            <span>JSON (all)</span>
            <span className="text-2xs text-muted-foreground">.json</span>
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Lightweight loading skeleton matching the shape of a TaskRow. Used during
 * the very first render before the runtime subscriber has hydrated. Pure CSS
 * shimmer — no extra deps.
 */
const TaskRowSkeleton: React.FC = () => (
  <div className="rounded-lg border border-border bg-card p-3">
    <div className="flex items-start gap-3">
      <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted/40" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted/40" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted/30" />
        <div className="h-2 w-full animate-pulse rounded bg-muted/20" />
      </div>
    </div>
  </div>
);

interface StatCardProps {
  icon?: React.ReactNode;
  label: string;
  value: number;
  suffix?: string;
  accent?: "primary" | "success" | "warning" | "destructive" | "muted";
  /** Help tooltip — surfaces what the metric means. */
  hint?: string;
}

const StatCard: React.FC<StatCardProps> = ({
  icon,
  label,
  value,
  suffix,
  accent = "muted",
  hint,
}) => {
  // Color-coded tones: ring + soft tinted background highlight a non-zero
  // count so the operator's eye lands on the categories that matter.
  const hot = value > 0;
  const body = (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card px-4 py-3 transition-all duration-base",
        "hover:shadow-elev-1",
        accent === "primary" &&
          (hot
            ? "border-primary/40 bg-gradient-to-br from-primary/[0.08] to-transparent"
            : "border-border"),
        accent === "success" &&
          (hot
            ? "border-success/40 bg-gradient-to-br from-success/[0.08] to-transparent"
            : "border-border"),
        accent === "warning" &&
          (hot
            ? "border-warning/40 bg-gradient-to-br from-warning/[0.08] to-transparent"
            : "border-border"),
        accent === "destructive" &&
          (hot
            ? "border-destructive/40 bg-gradient-to-br from-destructive/[0.08] to-transparent"
            : "border-border"),
        accent === "muted" && "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
          {hint && (
            <HelpCircle
              className="h-3 w-3 cursor-help text-muted-foreground/50 transition-colors hover:text-foreground"
              aria-hidden="true"
            />
          )}
        </span>
        <span
          className={cn(
            "shrink-0 transition-colors duration-fast",
            hot && accent === "primary" && "text-primary",
            hot && accent === "success" && "text-success",
            hot && accent === "warning" && "text-warning",
            hot && accent === "destructive" && "text-destructive",
            (!hot || accent === "muted") && "text-muted-foreground/60",
          )}
        >
          {icon}
        </span>
      </div>
      <div
        className={cn(
          "mt-1 flex items-baseline gap-1 text-2xl font-semibold tabular-nums leading-tight",
          hot && accent === "primary" && "text-primary",
          hot && accent === "success" && "text-success",
          hot && accent === "warning" && "text-warning",
          hot && accent === "destructive" && "text-destructive",
          (!hot || accent === "muted") && "text-foreground",
        )}
      >
        <NumberTicker value={value} />
        {suffix && (
          <span className="text-base font-medium text-muted-foreground/80">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
  if (!hint) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{hint}</TooltipContent>
    </Tooltip>
  );
};

/**
 * Special-cased card for "avg completed duration" because it formats a
 * duration string, not a count. Treats undefined (no completed tasks yet)
 * as a clear "—" rather than 0 so users don't read it as zero seconds.
 */
const AvgDurationCard: React.FC<{ ms: number | undefined }> = ({ ms }) => {
  const body = (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-card px-4 py-3 transition-all duration-base hover:shadow-elev-1">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Avg run time
          <HelpCircle
            className="h-3 w-3 cursor-help text-muted-foreground/50 transition-colors hover:text-foreground"
            aria-hidden="true"
          />
        </span>
        <Timer className="h-4 w-4 text-muted-foreground/60" />
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums leading-tight text-foreground">
        {ms === undefined ? "—" : formatDuration(ms)}
      </div>
    </div>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Average wall-clock duration across COMPLETED tasks (start → end).
        Excludes failed, cancelled, and in-flight tasks.
      </TooltipContent>
    </Tooltip>
  );
};
