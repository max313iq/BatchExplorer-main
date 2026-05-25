/**
 * Sticky-tasks panel — bottom-strip summary of persisted tasks. Mirrors
 * the live state from `taskRuntime` and offers quick actions.
 *
 * Each task row now shows:
 *   - status icon + label
 *   - progress bar with completed/total + failed count
 *   - elapsed time + ETA (running) or last-updated (terminal)
 *   - inline cancel/resume/discard/remove buttons
 *
 * For deeper inspection or pop-out, the "Open Task Manager" link routes
 * to `/tasks`.
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { ListChecks, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  taskRuntime,
  TaskRecord,
} from "../../store/task-runtime";
import {
  listBlacklist,
  removeFromBlacklist,
  clearBlacklist,
  BlacklistEntry,
} from "../../store/failure-blacklist";

import { TaskRow } from "../task-manager/task-row";

function useTasks(): TaskRecord[] {
  const [tasks, setTasks] = React.useState<TaskRecord[]>(() =>
    taskRuntime.list(),
  );
  React.useEffect(() => taskRuntime.subscribe(setTasks), []);
  return tasks;
}

function useNowTick(intervalMs = 1_000): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return tick;
}

function useBlacklist(): BlacklistEntry[] {
  const [list, setList] = React.useState<BlacklistEntry[]>(() =>
    listBlacklist(),
  );
  // Polling approach — blacklist mutates from agent runs in the same tab.
  // 5s interval is plenty for an admin panel.
  React.useEffect(() => {
    const t = window.setInterval(() => setList(listBlacklist()), 5_000);
    return () => window.clearInterval(t);
  }, []);
  return list;
}

export function StickyTasksPanel(): React.ReactElement | null {
  const tasks = useTasks();
  const nowTick = useNowTick();
  const blacklist = useBlacklist();
  const [blacklistOpen, setBlacklistOpen] = React.useState(false);
  const [, setBlacklistTick] = React.useState(0);
  const navigate = useNavigate();

  const persisted = tasks.length;
  const interrupted = tasks.filter((t) => t.status === "interrupted").length;
  const running = tasks.filter((t) => t.status === "running").length;

  // RULES OF HOOKS: these two useMemo calls MUST run before the early-return
  // below. Previously they sat after `if (persisted === 0 && blacklist.length
  // === 0) return null;` — which meant the very first render with zero
  // tasks recorded 6 hooks, and the next render after a tenant switch (which
  // triggers refresh agents that enqueue tasks) walked past the early-return
  // and added 2 more hooks → React "Rendered more hooks than during the
  // previous render" crash. Order must stay: every hook, THEN the conditional
  // return, THEN JSX.
  // Show the most actionable rows first: running, then interrupted, then
  // the rest (most recently updated). Cap to 5 to keep the strip compact —
  // the full Task Manager has the rest.
  const visible = React.useMemo(() => {
    const byStatusWeight = (r: TaskRecord) => {
      if (r.status === "running") return 0;
      if (r.status === "interrupted") return 1;
      if (r.status === "paused") return 2;
      if (r.status === "failed") return 3;
      if (r.status === "partial") return 4;
      return 5;
    };
    return (tasks ?? [])
      .slice()
      .sort((a, b) => {
        const w = byStatusWeight(a) - byStatusWeight(b);
        if (w !== 0) return w;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      })
      .slice(0, 5);
  }, [tasks]);

  const actions = React.useMemo(
    () => ({
      onCancel: (id: string) => {
        // Cooperative cancel — orchestrator polls this between iterations.
        // For the "halt right now" path use the Task Manager page (which
        // has the orchestrator in its outlet context and can call
        // orchestrator.cancel() directly). The sticky panel mirrors the
        // long-press route to /tasks below.
        taskRuntime.requestCancel(id);
        taskRuntime.update(id, {
          status: "cancelled",
          currentStep: "Cancelled by user (will halt at next iteration)",
        });
      },
      onDiscard: (id: string) =>
        taskRuntime.update(id, { status: "cancelled" }),
      onRemove: (id: string) => taskRuntime.remove(id),
      onOpen: () => navigate("/tasks"),
    }),
    [navigate],
  );

  if (persisted === 0 && blacklist.length === 0) return null;

  return (
    <div className="border-t border-border bg-surface-base px-4 py-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Sticky tasks
        </span>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {running} running · {interrupted} interrupted · {persisted} total
        </span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => navigate("/tasks")}
          className="gap-1"
        >
          <ListChecks className="h-3.5 w-3.5" />
          Open Task Manager
        </Button>
        {blacklist.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setBlacklistOpen((o) => !o)}
          >
            Blacklist ({blacklist.length})
          </Button>
        )}
        {tasks.some(
          (t) =>
            t.status === "completed" ||
            t.status === "failed" ||
            t.status === "cancelled" ||
            t.status === "partial",
        ) && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => taskRuntime.clearTerminal()}
          >
            Clear completed
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {visible.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            actions={actions}
            nowTick={nowTick}
          />
        ))}
        {tasks.length > visible.length && (
          <div className="px-2 py-1 text-2xs text-muted-foreground">
            +{tasks.length - visible.length} more — open Task Manager to see all.
          </div>
        )}
      </div>
      {blacklistOpen && (
        <div className="mt-3 rounded-md border border-border bg-card p-2 text-2xs">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-semibold">
              Permanent (vmSize, region) blacklist
            </span>
            <div className="flex-1" />
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                clearBlacklist();
                setBlacklistTick((n) => n + 1);
              }}
            >
              Clear all
            </Button>
          </div>
          <ul className="flex flex-col gap-0.5">
            {blacklist.map((b) => (
              <li
                key={`${b.vmSize}::${b.region}`}
                className="flex items-center gap-2"
              >
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {b.vmSize} @ {b.region}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {b.reason}
                </span>
                {typeof b.hits === "number" && b.hits > 0 && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {b.hits}×
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove blacklist entry"
                  onClick={() => {
                    removeFromBlacklist(b.vmSize, b.region);
                    setBlacklistTick((n) => n + 1);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
