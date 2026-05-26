/**
 * Detailed task row used by both the full Task Manager page and the
 * sticky-tasks-panel summary. Renders progress bar, ETA, counters, and
 * inline action buttons. Pure presentational — actions are delegated.
 */
import * as React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock, ExternalLink, Loader2, Minus, Pause, Play, RotateCcw, Trash2, XCircle, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { computeEtaMs, progressPct, } from "../../store/task-runtime";
import { STATUS_LABEL, STATUS_TONE, elapsedMs, formatDuration, formatRelative, isTerminal, } from "./task-formatting";
function statusGlyph(status, sizeClass = "h-4 w-4") {
    switch (status) {
        case "running":
            return React.createElement(Loader2, { className: cn(sizeClass, "animate-spin text-primary") });
        case "paused":
            return React.createElement(Pause, { className: cn(sizeClass, "text-warning") });
        case "interrupted":
            return React.createElement(AlertTriangle, { className: cn(sizeClass, "text-warning") });
        case "cancelled":
            return React.createElement(XCircle, { className: cn(sizeClass, "text-muted-foreground") });
        case "completed":
            return React.createElement(CheckCircle2, { className: cn(sizeClass, "text-success") });
        case "failed":
            return React.createElement(XCircle, { className: cn(sizeClass, "text-destructive") });
        case "partial":
            return React.createElement(AlertTriangle, { className: cn(sizeClass, "text-warning") });
        default:
            return React.createElement(Clock, { className: cn(sizeClass, "text-muted-foreground") });
    }
}
export const TaskRow = ({ task, variant = "full", actions = {}, 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
nowTick, selected = false, onSelect, enableJsonExpander = false, }) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const tone = STATUS_TONE[task.status];
    const pct = progressPct(task);
    const eta = computeEtaMs(task);
    const elapsed = elapsedMs(task);
    const total = (_a = task.total) !== null && _a !== void 0 ? _a : 0;
    const done = ((_b = task.completed) !== null && _b !== void 0 ? _b : 0) + ((_c = task.failed) !== null && _c !== void 0 ? _c : 0);
    const failedCount = (_d = task.failed) !== null && _d !== void 0 ? _d : 0;
    const remaining = Math.max(0, total - done);
    const hasSteps = ((_f = (_e = task.steps) === null || _e === void 0 ? void 0 : _e.length) !== null && _f !== void 0 ? _f : 0) > 0;
    // Auto-expand the step trail when a task is actively running so the
    // operator sees what's happening without clicking; collapse on terminal.
    const [expanded, setExpanded] = React.useState(() => task.status === "running" || task.status === "paused");
    // Inline JSON expander — gated by `enableJsonExpander` so external
    // consumers (sticky-tasks-panel) keep their compact layout.
    const [jsonOpen, setJsonOpen] = React.useState(false);
    const onRowClick = React.useCallback((e) => {
        if (!onSelect)
            return;
        // Skip clicks that originated inside an interactive control so the
        // action buttons keep their semantics. Buttons inside the row don't
        // stopPropagation; the guard runs on the captured target tag.
        const target = e.target;
        if (target.closest("button, a, [role=menu], [role=menuitem]"))
            return;
        onSelect(task.id, {
            shift: e.shiftKey,
            meta: e.metaKey,
            ctrl: e.ctrlKey,
        });
    }, [onSelect, task.id]);
    return (React.createElement("div", { role: onSelect ? "button" : undefined, tabIndex: onSelect ? 0 : undefined, "aria-selected": onSelect ? selected : undefined, onClick: onRowClick, onKeyDown: onSelect
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(task.id, {
                        shift: e.shiftKey,
                        meta: e.metaKey,
                        ctrl: e.ctrlKey,
                    });
                }
            }
            : undefined, className: cn("group rounded-lg border bg-card transition-all duration-base", "hover:shadow-elev-1", 
        // Running tasks emit a soft primary-tone glow so the row visibly
        // breathes — the global `.live-glow-bar` keyframe handles the pulse.
        // Style var routes the keyframe to the primary token; falls back to
        // success/warning/destructive on terminal rows for at-a-glance tone.
        task.status === "running" &&
            "live-glow-bar border-primary/50 shadow-[0_0_0_1px_hsl(var(--primary)/0.3)]", task.status === "interrupted" && "border-warning/40", task.status === "failed" && "border-destructive/40", task.status === "completed" && "border-success/30", task.status !== "running" &&
            task.status !== "interrupted" &&
            task.status !== "failed" &&
            task.status !== "completed" &&
            "border-border", selected && "ring-2 ring-primary/60 ring-offset-1 ring-offset-background") },
        React.createElement("div", { className: "flex items-start gap-3 p-3" },
            React.createElement("div", { className: cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 transition-transform duration-fast", "group-hover:scale-105", tone.bg, tone.ring), "aria-hidden": "true" }, statusGlyph(task.status, "h-4 w-4")),
            React.createElement("div", { className: "min-w-0 flex-1" },
                React.createElement("div", { className: "flex flex-wrap items-center gap-x-2 gap-y-1" },
                    React.createElement("span", { className: cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ring-1", tone.bg, tone.fg, tone.ring) },
                        task.status === "running" ? (React.createElement("span", { className: "live-pulse-dot", style: {
                                ["--live-tone"]: "var(--primary)",
                            }, "aria-hidden": "true" })) : (React.createElement("span", { className: cn("h-1.5 w-1.5 rounded-full", task.status === "paused" && "bg-warning", task.status === "interrupted" && "bg-warning", task.status === "completed" && "bg-success", task.status === "failed" && "bg-destructive", task.status === "partial" && "bg-warning", task.status === "cancelled" && "bg-muted-foreground") })),
                        STATUS_LABEL[task.status]),
                    React.createElement("span", { className: "text-2xs text-muted-foreground tabular-nums" },
                        "updated ",
                        formatRelative(task.updatedAt)),
                    task.startedAt && (React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-medium tabular-nums text-foreground/80" },
                        React.createElement(Clock, { className: "h-3 w-3 text-muted-foreground" }),
                        formatDuration(elapsed))),
                    task.status === "running" && eta !== undefined && (React.createElement("span", { className: "inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-primary" },
                        "ETA ",
                        formatDuration(eta)))),
                React.createElement("div", { className: "mt-1 truncate text-sm font-medium text-foreground" }, task.label),
                variant === "full" && (React.createElement(React.Fragment, null,
                    (task.currentStep || task.progress) && (React.createElement("div", { className: "mt-1 truncate text-xs text-muted-foreground" }, (_g = task.currentStep) !== null && _g !== void 0 ? _g : task.progress)),
                    total > 0 && (React.createElement("div", { className: "mt-2 flex items-center gap-2" },
                        React.createElement(Progress, { value: pct !== null && pct !== void 0 ? pct : 0, indeterminate: task.status === "running" && pct === undefined, className: cn(
                            // Slightly thicker bar with a smooth fill transition
                            // — the indicator's transform is animated by the
                            // `transition-transform` class targeting the inner
                            // div via `[&>div]` so width changes ease in.
                            "h-2 flex-1 overflow-hidden rounded-full", "[&>div]:transition-transform [&>div]:duration-slow [&>div]:ease-standard", 
                            // "Finish line" — when the task has reached terminal
                            // state, color the progress bar by outcome so the
                            // user gets a one-glance result without reading the
                            // counters.
                            task.status === "completed" &&
                                "[&>div]:bg-success", task.status === "partial" &&
                                "[&>div]:bg-warning", task.status === "failed" &&
                                "[&>div]:bg-destructive", task.status === "cancelled" &&
                                "[&>div]:bg-muted-foreground") }),
                        React.createElement("span", { className: "shrink-0 text-2xs font-medium tabular-nums text-muted-foreground" },
                            React.createElement("span", { className: "text-foreground" }, done),
                            React.createElement("span", { className: "mx-0.5 text-muted-foreground/50" }, "/"),
                            React.createElement("span", null, total),
                            failedCount > 0 && (React.createElement("span", { className: "ml-1 text-destructive" },
                                "(",
                                failedCount,
                                " failed)"))),
                        remaining > 0 &&
                            task.status !== "completed" &&
                            task.status !== "cancelled" && (React.createElement("span", { className: cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums ring-1", task.status === "running"
                                ? "bg-primary/10 text-primary ring-primary/30"
                                : "bg-muted/40 text-muted-foreground ring-border"), title: `${remaining} resource${remaining === 1 ? "" : "s"} left to create` },
                            React.createElement(Minus, { className: "h-3 w-3", "aria-hidden": true }),
                            remaining,
                            " left")),
                        React.createElement("span", { className: cn("w-12 shrink-0 text-right text-xs font-semibold tabular-nums", task.status === "completed" && "text-success", task.status === "failed" && "text-destructive", task.status === "partial" && "text-warning", task.status === "running" && "text-primary", task.status !== "completed" &&
                                task.status !== "failed" &&
                                task.status !== "partial" &&
                                task.status !== "running" &&
                                "text-foreground") }, task.status === "completed"
                            ? "100%"
                            : pct !== undefined
                                ? `${pct}%`
                                : "—"))),
                    task.status === "running" && total === 0 && (React.createElement("div", { className: "mt-2" },
                        React.createElement(Progress, { indeterminate: true, className: "h-2 overflow-hidden rounded-full" }))),
                    hasSteps && (React.createElement("div", { className: "mt-2" },
                        React.createElement("button", { type: "button", onClick: (e) => {
                                e.stopPropagation();
                                setExpanded((x) => !x);
                            }, "aria-expanded": expanded, className: "inline-flex items-center gap-1 rounded text-2xs text-muted-foreground transition-colors duration-fast hover:text-foreground" },
                            expanded ? (React.createElement(ChevronDown, { className: "h-3 w-3" })) : (React.createElement(ChevronRight, { className: "h-3 w-3" })),
                            task.steps.length,
                            " step",
                            task.steps.length === 1 ? "" : "s"),
                        expanded && (React.createElement("ul", { className: "mt-1 flex flex-col gap-0.5 border-l border-border/50 pl-3", role: "list" }, task.steps.map((step) => {
                            const stepIcon = step.status === "running" ? (React.createElement(Loader2, { className: "h-3 w-3 animate-spin text-primary" })) : step.status === "completed" ? (React.createElement(CheckCircle2, { className: "h-3 w-3 text-success" })) : step.status === "failed" ? (React.createElement(XCircle, { className: "h-3 w-3 text-destructive" })) : step.status === "skipped" ? (React.createElement(Minus, { className: "h-3 w-3 text-muted-foreground" })) : (React.createElement(Circle, { className: "h-3 w-3 text-muted-foreground/50" }));
                            return (React.createElement("li", { key: step.id, className: cn("flex items-start gap-1.5 text-2xs", step.status === "running" && "text-foreground", step.status === "completed" &&
                                    "text-muted-foreground", step.status === "failed" && "text-destructive", step.status === "skipped" &&
                                    "text-muted-foreground/70", step.status === "pending" &&
                                    "text-muted-foreground/50") },
                                React.createElement("span", { className: "mt-0.5 shrink-0" }, stepIcon),
                                React.createElement("span", { className: "min-w-0 flex-1" },
                                    React.createElement("span", { className: "font-medium" }, step.label),
                                    step.detail && (React.createElement("span", { className: "ml-1 truncate text-muted-foreground/70" },
                                        "\u00B7 ",
                                        step.detail)))));
                        }))))),
                    task.error && (React.createElement("div", { className: "mt-2 animate-fade-in rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive" }, task.error)),
                    enableJsonExpander && (React.createElement("div", { className: "mt-2" },
                        React.createElement("button", { type: "button", onClick: (e) => {
                                e.stopPropagation();
                                setJsonOpen((o) => !o);
                            }, "aria-expanded": jsonOpen, className: "inline-flex items-center gap-1 rounded text-2xs text-muted-foreground transition-colors duration-fast hover:text-foreground" },
                            jsonOpen ? (React.createElement(ChevronDown, { className: "h-3 w-3" })) : (React.createElement(ChevronRight, { className: "h-3 w-3" })),
                            jsonOpen ? "Hide raw JSON" : "Show raw JSON"),
                        jsonOpen && (React.createElement("pre", { className: "mt-1 max-h-64 overflow-auto rounded-md border border-border bg-surface-base/40 p-2 text-2xs leading-snug text-muted-foreground", onClick: (e) => e.stopPropagation() }, JSON.stringify(task, null, 2)))))))),
            React.createElement("div", { className: "flex shrink-0 items-center gap-1", onClick: (e) => e.stopPropagation() },
                task.status === "running" && actions.onPause && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "outline", size: "xs", "aria-label": "Pause task", onClick: () => { var _a; return (_a = actions.onPause) === null || _a === void 0 ? void 0 : _a.call(actions, task.id); }, className: "gap-1" },
                            React.createElement(Pause, { className: "h-3.5 w-3.5" }),
                            "Pause")),
                    React.createElement(TooltipContent, null, "Stop after the current iteration; resume any time"))),
                task.status === "running" && actions.onCancel && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Request cancellation", onClick: () => { var _a; return (_a = actions.onCancel) === null || _a === void 0 ? void 0 : _a.call(actions, task.id); } },
                            React.createElement(XCircle, { className: "h-4 w-4" }))),
                    React.createElement(TooltipContent, null, "Stop after the current step finishes"))),
                task.status === "paused" && actions.onStart && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "default", size: "xs", "aria-label": "Start (resume) paused task", onClick: () => { var _a; return (_a = actions.onStart) === null || _a === void 0 ? void 0 : _a.call(actions, task.id); }, className: "gap-1" },
                            React.createElement(Play, { className: "h-3.5 w-3.5" }),
                            "Start")),
                    React.createElement(TooltipContent, null, "Resume from the start (idempotent \u2014 completed work skipped)"))),
                task.status === "paused" && actions.onCancel && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Cancel paused task", onClick: () => { var _a; return (_a = actions.onCancel) === null || _a === void 0 ? void 0 : _a.call(actions, task.id); } },
                            React.createElement(XCircle, { className: "h-4 w-4" }))),
                    React.createElement(TooltipContent, null, "Discard the paused task"))),
                task.status === "interrupted" && actions.onResume && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "outline", size: "xs", "aria-label": "Resume task", onClick: () => { var _a; return (_a = actions.onResume) === null || _a === void 0 ? void 0 : _a.call(actions, task.id); }, className: "gap-1" },
                            React.createElement(Play, { className: "h-3.5 w-3.5" }),
                            "Resume")),
                    React.createElement(TooltipContent, null, "Re-dispatch this task with the original input"))),
                task.status === "interrupted" && actions.onDiscard && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Discard interrupted task", onClick: () => { var _a; return (_a = actions.onDiscard) === null || _a === void 0 ? void 0 : _a.call(actions, task.id); } },
                            React.createElement(RotateCcw, { className: "h-3.5 w-3.5" }))),
                    React.createElement(TooltipContent, null, "Mark as cancelled, do not resume"))),
                actions.onOpen && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Open task in Task Manager", onClick: () => { var _a; return (_a = actions.onOpen) === null || _a === void 0 ? void 0 : _a.call(actions, task.id); } },
                            React.createElement(ExternalLink, { className: "h-3.5 w-3.5" }))),
                    React.createElement(TooltipContent, null, "Open in Task Manager"))),
                (isTerminal(task.status) || task.status === "interrupted") &&
                    actions.onRemove && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Remove task from list", onClick: () => { var _a; return (_a = actions.onRemove) === null || _a === void 0 ? void 0 : _a.call(actions, task.id); } },
                            React.createElement(Trash2, { className: "h-3.5 w-3.5" }))),
                    React.createElement(TooltipContent, null, "Remove from list")))))));
};
//# sourceMappingURL=task-row.js.map