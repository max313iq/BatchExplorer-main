/**
 * Resume prompt — shown once per browser session when the app boots and
 * finds tasks in `interrupted` state. The user can:
 *   - Resume all (re-dispatch each interrupted task in sequence)
 *   - Discard all (mark every interrupted task as cancelled)
 *   - Open Task Manager (full-page review and per-task control)
 *   - Dismiss (X) — leaves them as interrupted; the sticky panel keeps
 *     reminding the user
 *
 * "Once per session" is enforced via sessionStorage so a deliberate page
 * reload mid-session doesn't re-prompt for tasks the user already chose
 * to leave alone. New tabs get their own decision.
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ExternalLink, Play, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { TaskRecord, taskRuntime } from "../../store/task-runtime";

import { TaskRow } from "./task-row";

const SESSION_DISMISSED_KEY = "mr.task-runtime.resume-prompt.dismissed";

/**
 * Re-dispatch helper. Mirrors the logic in TaskManagerPage; kept inline
 * here to avoid coupling the page module into the boot path.
 */
async function dispatchResume(
  orchestrator: OrchestratorAgent,
  task: TaskRecord,
): Promise<void> {
  const input = task.input as { action?: string; payload?: unknown } | undefined;
  const action = input?.action;
  if (!action) {
    const inferred =
      task.kind === "create-pools"
        ? "create_pools"
        : task.kind === "create-pools-smart"
          ? "create_pools_smart"
          : task.kind === "provision-accounts"
            ? "create_accounts"
            : null;
    if (!inferred) return;
    await orchestrator.execute({ action: inferred, payload: task.input });
    return;
  }
  await orchestrator.execute({ action, payload: input?.payload ?? {} });
}

interface Props {
  orchestrator: OrchestratorAgent;
}

export const ResumePromptDialog: React.FC<Props> = ({ orchestrator }) => {
  const [open, setOpen] = React.useState(false);
  const [interrupted, setInterrupted] = React.useState<TaskRecord[]>([]);
  const [resuming, setResuming] = React.useState(false);
  const navigate = useNavigate();

  // Decide on mount whether to show. We don't subscribe to taskRuntime
  // here — this prompt is a one-shot boot affordance, not a live monitor.
  React.useEffect(() => {
    let cancelled = false;
    // Defer one tick so taskRuntime.bootstrap() (called from index.tsx)
    // has reclassified everything before we look.
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      let dismissed = false;
      try {
        dismissed =
          window.sessionStorage.getItem(SESSION_DISMISSED_KEY) === "1";
      } catch {
        /* sessionStorage disabled — proceed */
      }
      if (dismissed) return;
      const list = taskRuntime
        .list()
        .filter((t) => t.status === "interrupted");
      if (list.length === 0) return;
      setInterrupted(list);
      setOpen(true);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const dismiss = React.useCallback(() => {
    try {
      window.sessionStorage.setItem(SESSION_DISMISSED_KEY, "1");
    } catch {
      /**/
    }
    setOpen(false);
  }, []);

  const onResumeAll = React.useCallback(async () => {
    setResuming(true);
    const list = taskRuntime.list().filter((t) => t.status === "interrupted");
    // Mark everything as running first so the UI flips immediately, even
    // though the dispatch loop runs serially.
    for (const t of list) {
      taskRuntime.update(t.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        completed: 0,
        failed: 0,
        cancelRequested: false,
        error: undefined,
        currentStep: "Resuming…",
      });
    }
    dismiss();
    // Don't await each one — keep the dialog snappy. Errors land on the
    // task record itself.
    void (async () => {
      for (const t of list) {
        try {
          await dispatchResume(orchestrator, t);
        } catch (e) {
          taskRuntime.update(t.id, {
            status: "failed",
            error: (e as Error)?.message ?? String(e),
          });
        }
      }
    })();
  }, [orchestrator, dismiss]);

  const onDiscardAll = React.useCallback(() => {
    taskRuntime.setStatusForInterrupted("cancelled");
    dismiss();
  }, [dismiss]);

  const onOpenManager = React.useCallback(() => {
    dismiss();
    navigate("/tasks");
  }, [dismiss, navigate]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) dismiss();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            {interrupted.length} interrupted task
            {interrupted.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            These were running when the page last closed. Resume to re-run
            with the original parameters (idempotent ops skip work that
            already succeeded), or discard to drop them.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-auto rounded-md border border-border bg-surface-base/40 p-2">
          <div className="flex flex-col gap-2">
            {interrupted.slice(0, 8).map((t) => (
              <TaskRow key={t.id} task={t} variant="compact" />
            ))}
            {interrupted.length > 8 && (
              <div className="px-2 py-1 text-2xs text-muted-foreground">
                +{interrupted.length - 8} more — open Task Manager to review
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={dismiss}
            className="gap-1.5"
            disabled={resuming}
          >
            <X className="h-3.5 w-3.5" />
            Decide later
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onOpenManager}
            className="gap-1.5"
            disabled={resuming}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open Task Manager
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onDiscardAll}
            disabled={resuming}
          >
            Discard all
          </Button>
          <Button
            type="button"
            onClick={onResumeAll}
            className="gap-1.5"
            disabled={resuming}
          >
            <Play className="h-3.5 w-3.5" />
            {resuming ? "Resuming…" : "Resume all"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
