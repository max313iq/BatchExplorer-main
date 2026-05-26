import * as React from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, Maximize2, Minimize2, Pause, Play, PauseCircle, X, XCircle, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
const COMPACT_HEIGHT = 200;
const FULL_HEIGHT = 420;
const SCROLL_STICKY_THRESHOLD = 80;
function formatDuration(startedAt, completedAt) {
    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    const diffMs = end - start;
    if (diffMs < 1000)
        return `${diffMs}ms`;
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSecs = seconds % 60;
    return `${minutes}m ${remainingSecs}s`;
}
function StatusGlyph({ status, }) {
    switch (status) {
        case "running":
            return (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin text-primary", "aria-label": "Running" }));
        case "paused":
            return (React.createElement(PauseCircle, { className: "h-3.5 w-3.5 text-warning", "aria-label": "Paused" }));
        case "cancelling":
            return (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin text-muted-foreground", "aria-label": "Cancelling" }));
        case "completed":
            return (React.createElement(CheckCircle2, { className: "h-3.5 w-3.5 text-success", "aria-label": "Completed" }));
        case "failed":
            return (React.createElement(AlertCircle, { className: "h-3.5 w-3.5 text-destructive", "aria-label": "Failed" }));
        case "cancelled":
            return (React.createElement(XCircle, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-label": "Cancelled" }));
        case "pending":
        default:
            return (React.createElement(Clock, { className: "h-3.5 w-3.5 text-warning", "aria-label": "Pending" }));
    }
}
function isTerminal(status) {
    return (status === "completed" || status === "failed" || status === "cancelled");
}
function isActive(status) {
    return status === "running" || status === "paused" || status === "pending";
}
function filterActivities(activities, tab) {
    switch (tab) {
        case "running":
            return activities.filter((a) => a.status === "running" ||
                a.status === "pending" ||
                a.status === "cancelling");
        case "paused":
            return activities.filter((a) => a.status === "paused");
        case "completed":
            return activities.filter((a) => a.status === "completed");
        case "failed":
            return activities.filter((a) => a.status === "failed" || a.status === "cancelled");
        case "all":
        default:
            return activities;
    }
}
const FILTER_TABS = [
    { key: "all", label: "All" },
    { key: "running", label: "Running" },
    { key: "paused", label: "Paused" },
    { key: "failed", label: "Failed" },
    { key: "completed", label: "Completed" },
];
const ActivityRow = ({ activity, depth, expanded, hasChildren, onToggleExpand, childProgress, onPause, onResume, onCancel, }) => {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
        if (activity.status !== "running" && activity.status !== "cancelling")
            return;
        const interval = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(interval);
    }, [activity.status]);
    const showProgress = (activity.progress !== undefined &&
        (activity.status === "running" ||
            activity.status === "paused" ||
            activity.status === "cancelling")) ||
        (childProgress !== undefined && hasChildren);
    const computedProgress = childProgress && childProgress.total > 0
        ? Math.round((childProgress.completed / childProgress.total) * 100)
        : activity.progress;
    const indeterminate = hasChildren &&
        (!childProgress || childProgress.total === 0) &&
        (activity.status === "running" || activity.status === "pending");
    return (React.createElement("div", { className: cn("group relative flex items-center gap-2 border-b border-border/40 py-1.5 transition-colors hover:bg-muted/30"), style: { paddingLeft: depth > 0 ? `${depth * 16 + 8}px` : undefined } },
        depth > 0 && (React.createElement("span", { "aria-hidden": "true", className: "pointer-events-none absolute bottom-0 top-0 border-l border-border/40", style: { left: `${depth * 16 - 8}px` } })),
        React.createElement("div", { className: "flex w-4 shrink-0 justify-center" }, hasChildren ? (React.createElement("button", { type: "button", onClick: onToggleExpand, "aria-label": expanded ? "Collapse children" : "Expand children", "aria-expanded": expanded, className: "flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" }, expanded ? (React.createElement(ChevronDown, { className: "h-3 w-3" })) : (React.createElement(ChevronRight, { className: "h-3 w-3" })))) : null),
        React.createElement("div", { className: "w-5 shrink-0 text-center" },
            React.createElement(StatusGlyph, { status: activity.status })),
        React.createElement("div", { className: "flex min-w-0 flex-1 flex-col gap-0.5" },
            React.createElement("div", { className: "flex min-w-0 items-center gap-2" },
                React.createElement("span", { className: "truncate text-xs font-semibold text-foreground" }, activity.action),
                React.createElement("span", { className: "truncate text-2xs text-muted-foreground" }, activity.target),
                childProgress && childProgress.total > 0 && (React.createElement("span", { className: "shrink-0 font-mono text-2xs text-muted-foreground tabular-nums" },
                    childProgress.completed,
                    "/",
                    childProgress.total))),
            showProgress && (React.createElement(Progress, { value: indeterminate ? undefined : computedProgress !== null && computedProgress !== void 0 ? computedProgress : 0, indeterminate: indeterminate, className: "h-[3px]" })),
            activity.error && (React.createElement("span", { className: "truncate text-2xs text-destructive", title: activity.error }, activity.error))),
        React.createElement("div", { className: "flex shrink-0 items-center gap-1" },
            activity.status === "running" && (React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Pause", onClick: () => onPause(activity.id) },
                        React.createElement(Pause, null))),
                React.createElement(TooltipContent, null, "Pause"))),
            activity.status === "paused" && (React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Resume", onClick: () => onResume(activity.id) },
                        React.createElement(Play, null))),
                React.createElement(TooltipContent, null, "Resume"))),
            (activity.status === "running" || activity.status === "paused") && (React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Cancel", onClick: () => onCancel(activity.id) },
                        React.createElement(X, null))),
                React.createElement(TooltipContent, null, "Cancel"))),
            React.createElement("span", { className: "ml-1 shrink-0 font-mono text-2xs text-muted-foreground tabular-nums" }, formatDuration(activity.startedAt, activity.completedAt)))));
};
export const ActivityPanel = ({ expanded: controlledExpanded, onToggle, orchestrator, }) => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const [uncontrolledExpanded, setUncontrolledExpanded] = React.useState(false);
    const expanded = controlledExpanded !== undefined
        ? controlledExpanded
        : uncontrolledExpanded;
    const toggleExpanded = onToggle !== null && onToggle !== void 0 ? onToggle : (() => setUncontrolledExpanded((p) => !p));
    const [activeTab, setActiveTab] = React.useState("all");
    const [panelSize, setPanelSize] = React.useState("compact");
    const [collapsedParents, setCollapsedParents] = React.useState(new Set());
    const containerRef = React.useRef(null);
    const stickToBottomRef = React.useRef(true);
    const activities = state.activities;
    const childrenById = React.useMemo(() => {
        var _a;
        const map = new Map();
        for (const a of activities) {
            if (a.parentId) {
                const arr = (_a = map.get(a.parentId)) !== null && _a !== void 0 ? _a : [];
                arr.push(a);
                map.set(a.parentId, arr);
            }
        }
        return map;
    }, [activities]);
    const roots = React.useMemo(() => activities.filter((a) => !a.parentId), [activities]);
    const counts = React.useMemo(() => {
        let running = 0;
        let queued = 0;
        let completed = 0;
        let paused = 0;
        let failed = 0;
        for (const a of activities) {
            if (a.status === "running" || a.status === "cancelling")
                running++;
            else if (a.status === "pending")
                queued++;
            else if (a.status === "paused")
                paused++;
            else if (a.status === "completed")
                completed++;
            else if (a.status === "failed" || a.status === "cancelled")
                failed++;
        }
        return { running, queued, completed, paused, failed };
    }, [activities]);
    React.useEffect(() => {
        setCollapsedParents((prev) => {
            var _a;
            const next = new Set(prev);
            let changed = false;
            for (const root of roots) {
                const children = (_a = childrenById.get(root.id)) !== null && _a !== void 0 ? _a : [];
                if (children.length === 0)
                    continue;
                const anyRunning = children.some((c) => c.status === "running" || c.status === "pending");
                if (anyRunning && next.has(root.id)) {
                    next.delete(root.id);
                    changed = true;
                }
                else if (!anyRunning && !next.has(root.id) && !prev.has(root.id)) {
                    // default state for non-running parents is collapsed (handled below)
                }
            }
            return changed ? next : prev;
        });
    }, [roots, childrenById]);
    const isParentExpanded = React.useCallback((id) => {
        var _a;
        const children = (_a = childrenById.get(id)) !== null && _a !== void 0 ? _a : [];
        if (children.length === 0)
            return true;
        if (collapsedParents.has(id))
            return false;
        const anyRunning = children.some((c) => c.status === "running" ||
            c.status === "pending" ||
            c.status === "paused");
        return anyRunning;
    }, [childrenById, collapsedParents]);
    const toggleParent = React.useCallback((id) => {
        setCollapsedParents((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    const filteredRoots = React.useMemo(() => filterActivities(roots, activeTab), [roots, activeTab]);
    const flatRows = React.useMemo(() => {
        var _a;
        const out = [];
        for (const root of filteredRoots) {
            const children = (_a = childrenById.get(root.id)) !== null && _a !== void 0 ? _a : [];
            const hasChildren = children.length > 0;
            const childProgress = hasChildren
                ? {
                    completed: children.filter((c) => isTerminal(c.status)).length,
                    total: children.length,
                }
                : undefined;
            out.push({ activity: root, depth: 0, hasChildren, childProgress });
            if (hasChildren && isParentExpanded(root.id)) {
                for (const child of children) {
                    out.push({
                        activity: child,
                        depth: 1,
                        hasChildren: false,
                    });
                }
            }
        }
        return out;
    }, [filteredRoots, childrenById, isParentExpanded]);
    const handleScroll = React.useCallback(() => {
        const el = containerRef.current;
        if (!el)
            return;
        const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
        stickToBottomRef.current = distance < SCROLL_STICKY_THRESHOLD;
    }, []);
    React.useEffect(() => {
        const el = containerRef.current;
        if (!el || !expanded)
            return;
        if (stickToBottomRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [flatRows.length, expanded]);
    const handleClearCompleted = React.useCallback(() => {
        store.clearCompletedActivities();
    }, [store]);
    const toggleSize = React.useCallback(() => {
        setPanelSize((prev) => (prev === "compact" ? "full" : "compact"));
    }, []);
    const handlePause = React.useCallback((id) => store.pauseActivity(id), [store]);
    const handleResume = React.useCallback((id) => store.resumeActivity(id), [store]);
    const handleCancel = React.useCallback((id) => {
        if (orchestrator) {
            orchestrator.cancel(id);
        }
        else {
            store.markActivityCancelling(id);
        }
    }, [orchestrator, store]);
    const maxHeight = panelSize === "compact" ? COMPACT_HEIGHT : FULL_HEIGHT;
    const titleSummary = `Task Manager (${counts.running} running, ${counts.queued} queued, ${counts.completed} completed)`;
    return (React.createElement("div", { className: "border-t border-border bg-surface-base" },
        React.createElement("div", { role: "button", tabIndex: 0, "aria-expanded": expanded, "aria-label": "Toggle task manager", onClick: toggleExpanded, onKeyDown: (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleExpanded();
                }
            }, className: "flex cursor-pointer select-none items-center justify-between bg-surface-raised px-4 py-2 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" },
            React.createElement("div", { className: "flex min-w-0 items-center gap-2" },
                React.createElement("span", { className: "truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground" }, titleSummary),
                counts.running > 0 && (React.createElement("span", { className: "flex shrink-0 items-center gap-1 text-2xs font-medium text-primary tabular-nums" },
                    React.createElement(Loader2, { className: "h-3 w-3 animate-spin" }),
                    counts.running)),
                counts.paused > 0 && (React.createElement("span", { className: "shrink-0 text-2xs font-medium text-warning tabular-nums" },
                    counts.paused,
                    " paused")),
                counts.failed > 0 && (React.createElement("span", { className: "shrink-0 text-2xs font-medium text-destructive tabular-nums" },
                    counts.failed,
                    " failed"))),
            React.createElement("span", { className: "text-2xs text-muted-foreground" }, expanded ? "Collapse" : "Expand")),
        expanded && (React.createElement("div", { className: "bg-surface-base" },
            React.createElement("div", { className: "flex items-center gap-1 border-b border-border px-4 py-2" },
                FILTER_TABS.map((tab) => (React.createElement("button", { key: tab.key, type: "button", onClick: () => setActiveTab(tab.key), "aria-pressed": activeTab === tab.key, className: cn("h-6 rounded px-2.5 text-2xs transition-colors duration-150", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background", activeTab === tab.key
                        ? "bg-card font-semibold text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground") }, tab.label))),
                React.createElement("div", { className: "flex-1" }),
                counts.completed + counts.failed > 0 && (React.createElement(Button, { type: "button", variant: "outline", size: "xs", onClick: handleClearCompleted }, "Clear completed")),
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Toggle panel size", onClick: toggleSize }, panelSize === "compact" ? React.createElement(Maximize2, null) : React.createElement(Minimize2, null))),
                    React.createElement(TooltipContent, null, panelSize === "compact"
                        ? "Expand to full size"
                        : "Shrink to compact"))),
            React.createElement("div", { ref: containerRef, onScroll: handleScroll, className: "overflow-y-auto px-4 pb-2 pt-1", style: { maxHeight: `${maxHeight}px` } },
                flatRows.map((row) => (React.createElement(ActivityRow, { key: row.activity.id, activity: row.activity, depth: row.depth, expanded: row.hasChildren
                        ? isParentExpanded(row.activity.id)
                        : undefined, hasChildren: row.hasChildren, onToggleExpand: row.hasChildren
                        ? () => toggleParent(row.activity.id)
                        : undefined, childProgress: row.childProgress, onPause: handlePause, onResume: handleResume, onCancel: handleCancel }))),
                flatRows.length === 0 && (React.createElement("div", { className: "py-2 text-xs text-muted-foreground/60" }, "No activities")))))));
};
export function useActiveTaskCount() {
    const state = useMultiRegionState();
    return React.useMemo(() => {
        let active = 0;
        let running = 0;
        for (const a of state.activities) {
            if (isActive(a.status) || a.status === "cancelling") {
                if (!a.parentId)
                    active++;
                if (a.status === "running" || a.status === "cancelling")
                    running++;
            }
        }
        return { active, running };
    }, [state.activities]);
}
//# sourceMappingURL=activity-panel.js.map