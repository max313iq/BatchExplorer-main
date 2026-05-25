/**
 * Detailed task row used by both the full Task Manager page and the
 * sticky-tasks-panel summary. Renders progress bar, ETA, counters, and
 * inline action buttons. Pure presentational — actions are delegated.
 */
import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  ExternalLink,
  Loader2,
  Minus,
  Pause,
  Play,
  RotateCcw,
  Trash2,
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
  computeEtaMs,
  progressPct,
  TaskRecord,
  TaskStatus,
} from "../../store/task-runtime";
import {
  STATUS_LABEL,
  STATUS_TONE,
  elapsedMs,
  formatDuration,
  formatRelative,
  isTerminal,
} from "./task-formatting";

function statusGlyph(status: TaskStatus, sizeClass = "h-4 w-4"): React.ReactElement {
  switch (status) {
    case "running":
      return <Loader2 className={cn(sizeClass, "animate-spin text-primary")} />;
    case "paused":
      return <Pause className={cn(sizeClass, "text-warning")} />;
    case "interrupted":
      return <AlertTriangle className={cn(sizeClass, "text-warning")} />;
    case "cancelled":
      return <XCircle className={cn(sizeClass, "text-muted-foreground")} />;
    case "completed":
      return <CheckCircle2 className={cn(sizeClass, "text-success")} />;
    case "failed":
      return <XCircle className={cn(sizeClass, "text-destructive")} />;
    case "partial":
      return <AlertTriangle className={cn(sizeClass, "text-warning")} />;
    default:
      return <Clock className={cn(sizeClass, "text-muted-foreground")} />;
  }
}

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
}

export const TaskRow: React.FC<TaskRowProps> = ({
  task,
  variant = "full",
  actions = {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  nowTick,
}) => {
  const tone = STATUS_TONE[task.status];
  const pct = progressPct(task);
  const eta = computeEtaMs(task);
  const elapsed = elapsedMs(task);
  const total = task.total ?? 0;
  const done = (task.completed ?? 0) + (task.failed ?? 0);
  const failedCount = task.failed ?? 0;
  const remaining = Math.max(0, total - done);
  const hasSteps = (task.steps?.length ?? 0) > 0;
  // Auto-expand the step trail when a task is actively running so the
  // operator sees what's happening without clicking; collapse on terminal.
  const [expanded, setExpanded] = React.useState<boolean>(
    () => task.status === "running" || task.status === "paused",
  );

  return (
    <div
      className={cn(
        "group rounded-lg border bg-card transition-all duration-base",
        "hover:shadow-elev-1",
        // Running tasks emit a soft primary-tone glow so the row visibly
        // breathes — the global `.live-glow-bar` keyframe handles the pulse.
        // Style var routes the keyframe to the primary token; falls back to
        // success/warning/destructive on terminal rows for at-a-glance tone.
        task.status === "running" &&
          "live-glow-bar border-primary/50 shadow-[0_0_0_1px_hsl(var(--primary)/0.3)]",
        task.status === "interrupted" && "border-warning/40",
        task.status === "failed" && "border-destructive/40",
        task.status === "completed" && "border-success/30",
        task.status !== "running" &&
          task.status !== "interrupted" &&
          task.status !== "failed" &&
          task.status !== "completed" &&
          "border-border",
      )}
    >
      <div className="flex items-start gap-3 p-3">
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 transition-transform duration-fast",
            "group-hover:scale-105",
            tone.bg,
            tone.ring,
          )}
          aria-hidden="true"
        >
          {statusGlyph(task.status, "h-4 w-4")}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* Status pill — pill-shaped, soft-tinted background, dot
                accent. Replaces the bare uppercase label so the row's
                state reads instantly without color decoding. */}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ring-1",
                tone.bg,
                tone.fg,
                tone.ring,
              )}
            >
              {/*
                Live status dot. Running rows use the global .live-pulse-dot
                utility which emits a radiating ring 1.5×/sec on top of the
                solid dot — communicates "this is live, not a snapshot".
                Other states use a static colored dot.
              */}
              {task.status === "running" ? (
                <span
                  className="live-pulse-dot"
                  style={{
                    ["--live-tone" as never]: "var(--primary)",
                  }}
                  aria-hidden="true"
                />
              ) : (
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    task.status === "paused" && "bg-warning",
                    task.status === "interrupted" && "bg-warning",
                    task.status === "completed" && "bg-success",
                    task.status === "failed" && "bg-destructive",
                    task.status === "partial" && "bg-warning",
                    task.status === "cancelled" && "bg-muted-foreground",
                  )}
                />
              )}
              {STATUS_LABEL[task.status]}
            </span>
            <span className="text-2xs text-muted-foreground tabular-nums">
              updated {formatRelative(task.updatedAt)}
            </span>
            {task.startedAt && (
              <span className="inline-flex items-center gap-1 text-2xs font-medium tabular-nums text-foreground/80">
                <Clock className="h-3 w-3 text-muted-foreground" />
                {formatDuration(elapsed)}
              </span>
            )}
            {task.status === "running" && eta !== undefined && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-primary">
                ETA {formatDuration(eta)}
              </span>
            )}
          </div>
          <div className="mt-1 truncate text-sm font-medium text-foreground">
            {task.label}
          </div>

          {variant === "full" && (
            <>
              {(task.currentStep || task.progress) && (
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {task.currentStep ?? task.progress}
                </div>
              )}

              {total > 0 && (
                <div className="mt-2 flex items-center gap-2">
                  <Progress
                    value={pct ?? 0}
                    indeterminate={task.status === "running" && pct === undefined}
                    className={cn(
                      // Slightly thicker bar with a smooth fill transition
                      // — the indicator's transform is animated by the
                      // `transition-transform` class targeting the inner
                      // div via `[&>div]` so width changes ease in.
                      "h-2 flex-1 overflow-hidden rounded-full",
                      "[&>div]:transition-transform [&>div]:duration-slow [&>div]:ease-standard",
                      // "Finish line" — when the task has reached terminal
                      // state, color the progress bar by outcome so the
                      // user gets a one-glance result without reading the
                      // counters.
                      task.status === "completed" &&
                        "[&>div]:bg-success",
                      task.status === "partial" &&
                        "[&>div]:bg-warning",
                      task.status === "failed" &&
                        "[&>div]:bg-destructive",
                      task.status === "cancelled" &&
                        "[&>div]:bg-muted-foreground",
                    )}
                  />
                  <span className="shrink-0 text-2xs font-medium tabular-nums text-muted-foreground">
                    <span className="text-foreground">{done}</span>
                    <span className="mx-0.5 text-muted-foreground/50">/</span>
                    <span>{total}</span>
                    {failedCount > 0 && (
                      <span className="ml-1 text-destructive">
                        ({failedCount} failed)
                      </span>
                    )}
                  </span>
                  {/* "How much left to create" — explicit remaining pill so
                      the operator doesn't have to do (total - done) math.
                      Hidden on completed/cancelled rows where remaining is
                      no longer actionable. */}
                  {remaining > 0 &&
                    task.status !== "completed" &&
                    task.status !== "cancelled" && (
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums ring-1",
                          task.status === "running"
                            ? "bg-primary/10 text-primary ring-primary/30"
                            : "bg-muted/40 text-muted-foreground ring-border",
                        )}
                        title={`${remaining} resource${remaining === 1 ? "" : "s"} left to create`}
                      >
                        <Minus className="h-3 w-3" aria-hidden />
                        {remaining} left
                      </span>
                    )}
                  <span
                    className={cn(
                      "w-12 shrink-0 text-right text-xs font-semibold tabular-nums",
                      task.status === "completed" && "text-success",
                      task.status === "failed" && "text-destructive",
                      task.status === "partial" && "text-warning",
                      task.status === "running" && "text-primary",
                      task.status !== "completed" &&
                        task.status !== "failed" &&
                        task.status !== "partial" &&
                        task.status !== "running" &&
                        "text-foreground",
                    )}
                  >
                    {/* Force 100% display on terminal completed tasks even
                        if total/completed counters drifted slightly from
                        the orchestrator's actual final tally. */}
                    {task.status === "completed"
                      ? "100%"
                      : pct !== undefined
                        ? `${pct}%`
                        : "—"}
                  </span>
                </div>
              )}

              {task.status === "running" && total === 0 && (
                <div className="mt-2">
                  <Progress indeterminate className="h-2 overflow-hidden rounded-full" />
                </div>
              )}

              {/* Progress tree — ordered trail of named sub-steps. Auto-
                  expands while running/paused so the operator sees what's
                  in flight; collapses to a tiny toggle on terminal rows. */}
              {hasSteps && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => !e)}
                    aria-expanded={expanded}
                    className="inline-flex items-center gap-1 rounded text-2xs text-muted-foreground transition-colors duration-fast hover:text-foreground"
                  >
                    {expanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    {task.steps!.length} step
                    {task.steps!.length === 1 ? "" : "s"}
                  </button>
                  {expanded && (
                    <ul
                      className="mt-1 flex flex-col gap-0.5 border-l border-border/50 pl-3"
                      role="list"
                    >
                      {task.steps!.map((step) => {
                        const stepIcon =
                          step.status === "running" ? (
                            <Loader2 className="h-3 w-3 animate-spin text-primary" />
                          ) : step.status === "completed" ? (
                            <CheckCircle2 className="h-3 w-3 text-success" />
                          ) : step.status === "failed" ? (
                            <XCircle className="h-3 w-3 text-destructive" />
                          ) : step.status === "skipped" ? (
                            <Minus className="h-3 w-3 text-muted-foreground" />
                          ) : (
                            <Circle className="h-3 w-3 text-muted-foreground/50" />
                          );
                        return (
                          <li
                            key={step.id}
                            className={cn(
                              "flex items-start gap-1.5 text-2xs",
                              step.status === "running" && "text-foreground",
                              step.status === "completed" &&
                                "text-muted-foreground",
                              step.status === "failed" && "text-destructive",
                              step.status === "skipped" &&
                                "text-muted-foreground/70",
                              step.status === "pending" &&
                                "text-muted-foreground/50",
                            )}
                          >
                            <span className="mt-0.5 shrink-0">{stepIcon}</span>
                            <span className="min-w-0 flex-1">
                              <span className="font-medium">{step.label}</span>
                              {step.detail && (
                                <span className="ml-1 truncate text-muted-foreground/70">
                                  · {step.detail}
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              {task.error && (
                <div className="mt-2 animate-fade-in rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
                  {task.error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {task.status === "running" && actions.onPause && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  aria-label="Pause task"
                  onClick={() => actions.onPause?.(task.id)}
                  className="gap-1"
                >
                  <Pause className="h-3.5 w-3.5" />
                  Pause
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Stop after the current iteration; resume any time
              </TooltipContent>
            </Tooltip>
          )}
          {task.status === "running" && actions.onCancel && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Request cancellation"
                  onClick={() => actions.onCancel?.(task.id)}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Stop after the current step finishes
              </TooltipContent>
            </Tooltip>
          )}
          {task.status === "paused" && actions.onStart && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  aria-label="Start (resume) paused task"
                  onClick={() => actions.onStart?.(task.id)}
                  className="gap-1"
                >
                  <Play className="h-3.5 w-3.5" />
                  Start
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Resume from the start (idempotent — completed work skipped)
              </TooltipContent>
            </Tooltip>
          )}
          {task.status === "paused" && actions.onCancel && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Cancel paused task"
                  onClick={() => actions.onCancel?.(task.id)}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Discard the paused task</TooltipContent>
            </Tooltip>
          )}
          {task.status === "interrupted" && actions.onResume && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  aria-label="Resume task"
                  onClick={() => actions.onResume?.(task.id)}
                  className="gap-1"
                >
                  <Play className="h-3.5 w-3.5" />
                  Resume
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Re-dispatch this task with the original input
              </TooltipContent>
            </Tooltip>
          )}
          {task.status === "interrupted" && actions.onDiscard && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Discard interrupted task"
                  onClick={() => actions.onDiscard?.(task.id)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Mark as cancelled, do not resume</TooltipContent>
            </Tooltip>
          )}
          {actions.onOpen && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open task in Task Manager"
                  onClick={() => actions.onOpen?.(task.id)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in Task Manager</TooltipContent>
            </Tooltip>
          )}
          {(isTerminal(task.status) || task.status === "interrupted") &&
            actions.onRemove && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove task from list"
                    onClick={() => actions.onRemove?.(task.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove from list</TooltipContent>
              </Tooltip>
            )}
        </div>
      </div>
    </div>
  );
};
