/**
 * Detailed task row used by both the full Task Manager page and the
 * sticky-tasks-panel summary. Renders progress bar, ETA, counters, and
 * inline action buttons. Pure presentational — actions are delegated.
 */
import * as React from "react";
import { TaskRecord } from "../../store/task-runtime";
export interface TaskRowActions {
    onCancel?: (id: string) => void;
    onResume?: (id: string) => void;
    onPause?: (id: string) => void;
    onStart?: (id: string) => void;
    onDiscard?: (id: string) => void;
    onRemove?: (id: string) => void;
    onOpen?: (id: string) => void;
}
export interface TaskRowProps {
    task: TaskRecord;
    /** "compact" hides the progress sub-line; "full" shows everything. */
    variant?: "compact" | "full";
    actions?: TaskRowActions;
    /** Re-render trigger: parent passes a tick from setInterval to keep ETA fresh. */
    nowTick?: number;
    /**
     * Optional single-select highlight. When `selected === true` the row gets a
     * ring + faint primary tint so the operator can see which task the
     * keyboard shortcuts (`c` / `r`) will act on. Additive — defaults to off
     * so external consumers (sticky-tasks-panel, resume-prompt-dialog) keep
     * their existing visuals.
     */
    selected?: boolean;
    /**
     * Click handler for selecting the row. Buttons inside the row stop the
     * propagation so they keep acting as discrete actions; the row itself
     * surfaces the selection via this callback. Additive and optional.
     *
     * The optional second arg carries modifier state (shift / cmd / ctrl)
     * so the parent can implement range-select (shift) and toggle-select
     * (cmd/ctrl) on top of the single-select default. Callers that don't
     * care about modifiers can simply ignore it — the existing signature is
     * unchanged for them.
     */
    onSelect?: (id: string, modifiers?: {
        shift: boolean;
        meta: boolean;
        ctrl: boolean;
    }) => void;
    /**
     * Optional inline JSON expander. Renders a fold-out `<pre>` showing the
     * raw `TaskRecord` for triage. No syntax highlight library — manual
     * `<pre>` per task-manager constraints. Defaults to off.
     */
    enableJsonExpander?: boolean;
}
export declare const TaskRow: React.FC<TaskRowProps>;
//# sourceMappingURL=task-row.d.ts.map