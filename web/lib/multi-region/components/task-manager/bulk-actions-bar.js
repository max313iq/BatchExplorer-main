/**
 * Bulk-actions bar — surfaces when ≥2 tasks are selected. The current
 * single-select model (one row at a time via `c`/`r` hotkey) is great
 * for surgical work but slow when an operator needs to cancel a dozen
 * tasks at once (e.g. after spotting a misconfig that affected a batch).
 *
 * This component is purely visual: parent owns the selection Set and the
 * action handlers, we just render the floating chip with counts + buttons
 * and emit click events. Confirmation is delegated to the existing
 * ConfirmationDialog in this folder.
 *
 * Source-only constraint: no new deps, no shared-component edits.
 */
import * as React from "react";
import { ArrowDownToLine, CheckSquare, Pause, Play, Trash2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
/**
 * Compute action eligibility per-status across the selection. We surface
 * a Pause/Cancel button only if there's at least one task it would do
 * something to; similarly for Resume / Remove. Counts let the operator
 * see "Cancel (3)" so they know which slice of the selection is affected.
 */
function eligibility(selectedIds, getTask) {
    const cancelable = [];
    const pauseable = [];
    const resumeable = [];
    const removable = [];
    let missing = 0;
    selectedIds.forEach((id) => {
        const t = getTask(id);
        if (!t) {
            missing++;
            return;
        }
        const s = t.status;
        if (s === "running" || s === "paused")
            cancelable.push(id);
        if (s === "running")
            pauseable.push(id);
        if (s === "interrupted" || s === "paused" || s === "failed")
            resumeable.push(id);
        if (s === "completed" ||
            s === "cancelled" ||
            s === "failed" ||
            s === "partial" ||
            s === "interrupted") {
            removable.push(id);
        }
    });
    return {
        cancelable,
        pauseable,
        resumeable,
        removable,
        total: selectedIds.size,
        missing,
    };
}
export const BulkActionsBar = ({ selectedIds, getTask, onClear, onBulkCancel, onBulkResume, onBulkPause, onBulkRemove, onBulkExport, }) => {
    // Single-select (or empty) is handled by the existing `c`/`r` hotkeys —
    // we don't need a bar for one row.
    if (selectedIds.size < 2)
        return null;
    const e = eligibility(selectedIds, getTask);
    return (React.createElement("div", { role: "region", "aria-label": `Bulk actions for ${e.total} selected tasks`, className: cn("sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-card/95 px-3 py-2 shadow-elev-2 backdrop-blur", "animate-fade-in") },
        React.createElement("div", { className: "flex items-center gap-1.5" },
            React.createElement(CheckSquare, { className: "h-4 w-4 text-primary", "aria-hidden": "true" }),
            React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-primary" },
                e.total,
                " selected"),
            e.missing > 0 && (React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement("span", { className: "cursor-help rounded-full bg-warning/10 px-1.5 py-0.5 text-2xs font-semibold text-warning" },
                        e.missing,
                        " stale")),
                React.createElement(TooltipContent, { className: "max-w-xs" },
                    e.missing,
                    " selected task",
                    e.missing === 1 ? " has" : "s have",
                    " ",
                    "been removed from the runtime. They will be skipped by bulk actions and cleared on the next selection change.")))),
        React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "outline", size: "xs", onClick: () => onBulkPause(e.pauseable), disabled: e.pauseable.length === 0, className: "gap-1", "aria-label": `Pause ${e.pauseable.length} running task${e.pauseable.length === 1 ? "" : "s"}` },
                        React.createElement(Pause, { className: "h-3 w-3" }),
                        "Pause (",
                        e.pauseable.length,
                        ")")),
                React.createElement(TooltipContent, null, "Cooperative pause; resume any time")),
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "outline", size: "xs", onClick: () => onBulkResume(e.resumeable), disabled: e.resumeable.length === 0, className: "gap-1", "aria-label": `Resume ${e.resumeable.length} interrupted/paused/failed task${e.resumeable.length === 1 ? "" : "s"}` },
                        React.createElement(Play, { className: "h-3 w-3" }),
                        "Resume (",
                        e.resumeable.length,
                        ")")),
                React.createElement(TooltipContent, null, "Re-dispatch interrupted/paused/failed tasks. Idempotent \u2014 already-done work is skipped.")),
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "outline", size: "xs", onClick: () => onBulkCancel(e.cancelable), disabled: e.cancelable.length === 0, className: "gap-1 text-warning hover:bg-warning/10", "aria-label": `Cancel ${e.cancelable.length} running/paused task${e.cancelable.length === 1 ? "" : "s"}` },
                        React.createElement(XCircle, { className: "h-3 w-3" }),
                        "Cancel (",
                        e.cancelable.length,
                        ")")),
                React.createElement(TooltipContent, null, "Stop running/paused tasks after the current step. Asks for confirmation.")),
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => onBulkRemove(e.removable), disabled: e.removable.length === 0, className: "gap-1 hover:bg-destructive/10 hover:text-destructive", "aria-label": `Remove ${e.removable.length} terminal/interrupted task${e.removable.length === 1 ? "" : "s"}` },
                        React.createElement(Trash2, { className: "h-3 w-3" }),
                        "Remove (",
                        e.removable.length,
                        ")")),
                React.createElement(TooltipContent, null, "Permanently remove selected terminal/interrupted tasks. Asks for confirmation.")),
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => onBulkExport(Array.from(selectedIds)), className: "gap-1", "aria-label": `Export ${e.total} selected task${e.total === 1 ? "" : "s"} as JSON` },
                        React.createElement(ArrowDownToLine, { className: "h-3 w-3" }),
                        "Export")),
                React.createElement(TooltipContent, null, "Download the selected tasks as JSON"))),
        React.createElement(Tooltip, null,
            React.createElement(TooltipTrigger, { asChild: true },
                React.createElement("button", { type: "button", onClick: onClear, className: "ml-auto inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-2xs text-muted-foreground hover:bg-muted/40", "aria-label": "Clear selection" },
                    React.createElement(X, { className: "h-3 w-3" }),
                    "Clear",
                    React.createElement("kbd", { className: "ml-0.5 rounded bg-muted/40 px-1 font-mono text-2xs" }, "Esc"))),
            React.createElement(TooltipContent, null, "Press Escape or click to clear the selection"))));
};
//# sourceMappingURL=bulk-actions-bar.js.map