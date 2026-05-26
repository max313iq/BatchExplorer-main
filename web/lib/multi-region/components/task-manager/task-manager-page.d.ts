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
export declare const TaskManagerPage: React.FC;
//# sourceMappingURL=task-manager-page.d.ts.map