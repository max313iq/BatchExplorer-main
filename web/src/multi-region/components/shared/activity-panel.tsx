import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  PauseCircle,
  X,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import { Activity, ActivityStatus } from "../../store/store-types";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";

export type FilterTab = "all" | "running" | "paused" | "failed" | "completed";

const COMPACT_HEIGHT = 200;
const FULL_HEIGHT = 420;
const SCROLL_STICKY_THRESHOLD = 80;

export interface ActivityPanelProps {
  expanded?: boolean;
  onToggle?: () => void;
  orchestrator?: OrchestratorAgent;
}

function formatDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - start;
  if (diffMs < 1000) return `${diffMs}ms`;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSecs = seconds % 60;
  return `${minutes}m ${remainingSecs}s`;
}

function StatusGlyph({
  status,
}: {
  status: ActivityStatus;
}): React.ReactElement {
  switch (status) {
    case "running":
      return (
        <Loader2
          className="h-3.5 w-3.5 animate-spin text-primary"
          aria-label="Running"
        />
      );
    case "paused":
      return (
        <PauseCircle className="h-3.5 w-3.5 text-warning" aria-label="Paused" />
      );
    case "cancelling":
      return (
        <Loader2
          className="h-3.5 w-3.5 animate-spin text-muted-foreground"
          aria-label="Cancelling"
        />
      );
    case "completed":
      return (
        <CheckCircle2
          className="h-3.5 w-3.5 text-success"
          aria-label="Completed"
        />
      );
    case "failed":
      return (
        <AlertCircle
          className="h-3.5 w-3.5 text-destructive"
          aria-label="Failed"
        />
      );
    case "cancelled":
      return (
        <XCircle
          className="h-3.5 w-3.5 text-muted-foreground"
          aria-label="Cancelled"
        />
      );
    case "pending":
    default:
      return (
        <Clock className="h-3.5 w-3.5 text-warning" aria-label="Pending" />
      );
  }
}

function isTerminal(status: ActivityStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function isActive(status: ActivityStatus): boolean {
  return status === "running" || status === "paused" || status === "pending";
}

function filterActivities(activities: Activity[], tab: FilterTab): Activity[] {
  switch (tab) {
    case "running":
      return activities.filter(
        (a) =>
          a.status === "running" ||
          a.status === "pending" ||
          a.status === "cancelling",
      );
    case "paused":
      return activities.filter((a) => a.status === "paused");
    case "completed":
      return activities.filter((a) => a.status === "completed");
    case "failed":
      return activities.filter(
        (a) => a.status === "failed" || a.status === "cancelled",
      );
    case "all":
    default:
      return activities;
  }
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "paused", label: "Paused" },
  { key: "failed", label: "Failed" },
  { key: "completed", label: "Completed" },
];

interface ActivityRowProps {
  activity: Activity;
  depth: number;
  expanded?: boolean;
  hasChildren: boolean;
  onToggleExpand?: () => void;
  childProgress?: { completed: number; total: number };
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
}

const ActivityRow: React.FC<ActivityRowProps> = ({
  activity,
  depth,
  expanded,
  hasChildren,
  onToggleExpand,
  childProgress,
  onPause,
  onResume,
  onCancel,
}) => {
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    if (activity.status !== "running" && activity.status !== "cancelling")
      return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activity.status]);

  const showProgress =
    (activity.progress !== undefined &&
      (activity.status === "running" ||
        activity.status === "paused" ||
        activity.status === "cancelling")) ||
    (childProgress !== undefined && hasChildren);

  const computedProgress =
    childProgress && childProgress.total > 0
      ? Math.round((childProgress.completed / childProgress.total) * 100)
      : activity.progress;

  const indeterminate =
    hasChildren &&
    (!childProgress || childProgress.total === 0) &&
    (activity.status === "running" || activity.status === "pending");

  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 border-b border-border/40 py-1.5 transition-colors hover:bg-muted/30",
      )}
      style={{ paddingLeft: depth > 0 ? `${depth * 16 + 8}px` : undefined }}
    >
      {depth > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 top-0 border-l border-border/40"
          style={{ left: `${depth * 16 - 8}px` }}
        />
      )}
      <div className="flex w-4 shrink-0 justify-center">
        {hasChildren ? (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={expanded ? "Collapse children" : "Expand children"}
            aria-expanded={expanded}
            className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : null}
      </div>
      <div className="w-5 shrink-0 text-center">
        <StatusGlyph status={activity.status} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-foreground">
            {activity.action}
          </span>
          <span className="truncate text-2xs text-muted-foreground">
            {activity.target}
          </span>
          {childProgress && childProgress.total > 0 && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
              {childProgress.completed}/{childProgress.total}
            </span>
          )}
        </div>
        {showProgress && (
          <Progress
            value={indeterminate ? undefined : computedProgress ?? 0}
            indeterminate={indeterminate}
            className="h-[3px]"
          />
        )}
        {activity.error && (
          <span
            className="truncate text-2xs text-destructive"
            title={activity.error}
          >
            {activity.error}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {activity.status === "running" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Pause"
                onClick={() => onPause(activity.id)}
              >
                <Pause />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Pause</TooltipContent>
          </Tooltip>
        )}
        {activity.status === "paused" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Resume"
                onClick={() => onResume(activity.id)}
              >
                <Play />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Resume</TooltipContent>
          </Tooltip>
        )}
        {(activity.status === "running" || activity.status === "paused") && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Cancel"
                onClick={() => onCancel(activity.id)}
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Cancel</TooltipContent>
          </Tooltip>
        )}
        <span className="ml-1 shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {formatDuration(activity.startedAt, activity.completedAt)}
        </span>
      </div>
    </div>
  );
};

export const ActivityPanel: React.FC<ActivityPanelProps> = ({
  expanded: controlledExpanded,
  onToggle,
  orchestrator,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const [uncontrolledExpanded, setUncontrolledExpanded] = React.useState(false);
  const expanded =
    controlledExpanded !== undefined
      ? controlledExpanded
      : uncontrolledExpanded;
  const toggleExpanded = onToggle ?? (() => setUncontrolledExpanded((p) => !p));

  const [activeTab, setActiveTab] = React.useState<FilterTab>("all");
  const [panelSize, setPanelSize] = React.useState<"compact" | "full">(
    "compact",
  );
  const [collapsedParents, setCollapsedParents] = React.useState<Set<string>>(
    new Set(),
  );
  const containerRef = React.useRef<HTMLDivElement>(null);
  const stickToBottomRef = React.useRef(true);

  const activities = state.activities;

  const childrenById = React.useMemo(() => {
    const map = new Map<string, Activity[]>();
    for (const a of activities) {
      if (a.parentId) {
        const arr = map.get(a.parentId) ?? [];
        arr.push(a);
        map.set(a.parentId, arr);
      }
    }
    return map;
  }, [activities]);

  const roots = React.useMemo(
    () => activities.filter((a) => !a.parentId),
    [activities],
  );

  const counts = React.useMemo(() => {
    let running = 0;
    let queued = 0;
    let completed = 0;
    let paused = 0;
    let failed = 0;
    for (const a of activities) {
      if (a.status === "running" || a.status === "cancelling") running++;
      else if (a.status === "pending") queued++;
      else if (a.status === "paused") paused++;
      else if (a.status === "completed") completed++;
      else if (a.status === "failed" || a.status === "cancelled") failed++;
    }
    return { running, queued, completed, paused, failed };
  }, [activities]);

  React.useEffect(() => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const root of roots) {
        const children = childrenById.get(root.id) ?? [];
        if (children.length === 0) continue;
        const anyRunning = children.some(
          (c) => c.status === "running" || c.status === "pending",
        );
        if (anyRunning && next.has(root.id)) {
          next.delete(root.id);
          changed = true;
        } else if (!anyRunning && !next.has(root.id) && !prev.has(root.id)) {
          // default state for non-running parents is collapsed (handled below)
        }
      }
      return changed ? next : prev;
    });
  }, [roots, childrenById]);

  const isParentExpanded = React.useCallback(
    (id: string): boolean => {
      const children = childrenById.get(id) ?? [];
      if (children.length === 0) return true;
      if (collapsedParents.has(id)) return false;
      const anyRunning = children.some(
        (c) =>
          c.status === "running" ||
          c.status === "pending" ||
          c.status === "paused",
      );
      return anyRunning;
    },
    [childrenById, collapsedParents],
  );

  const toggleParent = React.useCallback((id: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filteredRoots = React.useMemo(
    () => filterActivities(roots, activeTab),
    [roots, activeTab],
  );

  const flatRows = React.useMemo(() => {
    const out: Array<{
      activity: Activity;
      depth: number;
      hasChildren: boolean;
      childProgress?: { completed: number; total: number };
    }> = [];
    for (const root of filteredRoots) {
      const children = childrenById.get(root.id) ?? [];
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
    if (!el) return;
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickToBottomRef.current = distance < SCROLL_STICKY_THRESHOLD;
  }, []);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || !expanded) return;
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

  const handlePause = React.useCallback(
    (id: string) => store.pauseActivity(id),
    [store],
  );
  const handleResume = React.useCallback(
    (id: string) => store.resumeActivity(id),
    [store],
  );
  const handleCancel = React.useCallback(
    (id: string) => {
      if (orchestrator) {
        orchestrator.cancel(id);
      } else {
        store.markActivityCancelling(id);
      }
    },
    [orchestrator, store],
  );

  const maxHeight = panelSize === "compact" ? COMPACT_HEIGHT : FULL_HEIGHT;

  const titleSummary = `Task Manager (${counts.running} running, ${counts.queued} queued, ${counts.completed} completed)`;

  return (
    <div className="border-t border-border bg-surface-base">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label="Toggle task manager"
        onClick={toggleExpanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded();
          }
        }}
        className="flex cursor-pointer select-none items-center justify-between bg-surface-raised px-4 py-2 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {titleSummary}
          </span>
          {counts.running > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-2xs font-medium text-primary tabular-nums">
              <Loader2 className="h-3 w-3 animate-spin" />
              {counts.running}
            </span>
          )}
          {counts.paused > 0 && (
            <span className="shrink-0 text-2xs font-medium text-warning tabular-nums">
              {counts.paused} paused
            </span>
          )}
          {counts.failed > 0 && (
            <span className="shrink-0 text-2xs font-medium text-destructive tabular-nums">
              {counts.failed} failed
            </span>
          )}
        </div>
        <span className="text-2xs text-muted-foreground">
          {expanded ? "Collapse" : "Expand"}
        </span>
      </div>
      {expanded && (
        <div className="bg-surface-base">
          <div className="flex items-center gap-1 border-b border-border px-4 py-2">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                aria-pressed={activeTab === tab.key}
                className={cn(
                  "h-6 rounded px-2.5 text-2xs transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  activeTab === tab.key
                    ? "bg-card font-semibold text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            ))}
            <div className="flex-1" />
            {counts.completed + counts.failed > 0 && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={handleClearCompleted}
              >
                Clear completed
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Toggle panel size"
                  onClick={toggleSize}
                >
                  {panelSize === "compact" ? <Maximize2 /> : <Minimize2 />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {panelSize === "compact"
                  ? "Expand to full size"
                  : "Shrink to compact"}
              </TooltipContent>
            </Tooltip>
          </div>
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="overflow-y-auto px-4 pb-2 pt-1"
            style={{ maxHeight: `${maxHeight}px` }}
          >
            {flatRows.map((row) => (
              <ActivityRow
                key={row.activity.id}
                activity={row.activity}
                depth={row.depth}
                expanded={
                  row.hasChildren
                    ? isParentExpanded(row.activity.id)
                    : undefined
                }
                hasChildren={row.hasChildren}
                onToggleExpand={
                  row.hasChildren
                    ? () => toggleParent(row.activity.id)
                    : undefined
                }
                childProgress={row.childProgress}
                onPause={handlePause}
                onResume={handleResume}
                onCancel={handleCancel}
              />
            ))}
            {flatRows.length === 0 && (
              <div className="py-2 text-xs text-muted-foreground/60">
                No activities
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export function useActiveTaskCount(): { active: number; running: number } {
  const state = useMultiRegionState();
  return React.useMemo(() => {
    let active = 0;
    let running = 0;
    for (const a of state.activities) {
      if (isActive(a.status) || a.status === "cancelling") {
        if (!a.parentId) active++;
        if (a.status === "running" || a.status === "cancelling") running++;
      }
    }
    return { active, running };
  }, [state.activities]);
}
