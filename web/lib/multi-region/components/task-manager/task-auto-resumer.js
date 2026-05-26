import { __awaiter } from "tslib";
/**
 * Silent auto-resumer for interrupted sticky tasks.
 *
 * Browser limitation: a page reload kills the JavaScript runtime, which
 * means any in-flight fetch() that the orchestrator was making for a
 * long-running task (e.g. create_accounts across 10 regions) dies with
 * the page. There is no way to keep that work running through the
 * reload without moving it into a Service Worker, which is a separate
 * architectural project.
 *
 * What this component does instead: as soon as the dashboard mounts
 * after a reload, it finds every task left in `interrupted` state by
 * `taskRuntime.bootstrap()` and re-dispatches them through the same
 * orchestrator action that originally created them. The user sees no
 * prompt — the resume is automatic. A non-modal toast confirms how
 * many tasks were resumed.
 *
 * Why this is safe:
 *   The orchestrator's resumeable actions (create_accounts,
 *   create_pools, create_pools_smart) are all idempotent against Azure
 *   ARM. Re-running them with the same input means Azure either returns
 *   the existing resource (PUT-by-name = upsert) or 409s with a
 *   conflict that the orchestrator already swallows. Already-completed
 *   per-region work is skipped at the Azure side.
 *
 * Why a toast instead of a dialog:
 *   The user explicitly does not want friction. They told the Task
 *   Manager "never interrupted" — the closest the browser sandbox
 *   allows is "interrupted for 0ms then auto-resumed". A toast keeps
 *   the user informed without blocking interaction.
 *
 * Escape hatch: a session-storage flag (`mr.task-runtime.auto-resume.disabled`)
 * disables auto-resume for the current tab. Set this from the Task
 * Manager toolbar if the user actually wants the old prompt behavior;
 * not exposed in the UI yet.
 */
import * as React from "react";
import { taskRuntime } from "../../store/task-runtime";
import { useMultiRegionStore } from "../../store/store-context";
const SESSION_DISABLE_KEY = "mr.task-runtime.auto-resume.disabled";
const SESSION_RESUMED_FLAG = "mr.task-runtime.auto-resumed";
/**
 * Auxiliary signal consumed by the Task Manager page to render an in-page
 * info banner with animated entrance. Distinct from the boolean `shown`
 * flag that the page sets after rendering — this one stores the COUNT,
 * which the page reads exactly once per mount.
 */
const SESSION_RESUMED_COUNT_KEY = "mr.task-runtime.auto-resumed.count";
function dispatchResume(orchestrator, task) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const input = task.input;
        const action = input === null || input === void 0 ? void 0 : input.action;
        // Pass the existing task's id so the orchestrator REUSES the sticky
        // record instead of creating a duplicate. Without this, the original
        // interrupted task stays at "Auto-resuming after reload…" forever
        // while a NEW task silently does all the actual work.
        if (!action) {
            const inferred = task.kind === "create-pools"
                ? "create_pools"
                : task.kind === "create-pools-smart"
                    ? "create_pools_smart"
                    : task.kind === "provision-accounts"
                        ? "create_accounts"
                        : null;
            if (!inferred)
                return;
            yield orchestrator.execute({
                action: inferred,
                payload: task.input,
                resumeTaskId: task.id,
            });
            return;
        }
        yield orchestrator.execute({
            action,
            payload: (_a = input === null || input === void 0 ? void 0 : input.payload) !== null && _a !== void 0 ? _a : {},
            resumeTaskId: task.id,
        });
    });
}
export const TaskAutoResumer = ({ orchestrator }) => {
    const store = useMultiRegionStore();
    React.useEffect(() => {
        // Run once per tab. The flag is in sessionStorage so a deliberate
        // mid-session reload re-checks for interrupted tasks again.
        let disabled = false;
        try {
            disabled =
                window.sessionStorage.getItem(SESSION_DISABLE_KEY) === "1" ||
                    window.sessionStorage.getItem(SESSION_RESUMED_FLAG) === "1";
        }
        catch (_a) {
            /* sessionStorage unavailable — proceed */
        }
        if (disabled)
            return;
        // Defer one tick so taskRuntime.bootstrap() (called from index.tsx)
        // has finished reclassifying everything.
        const timer = window.setTimeout(() => {
            // Two source buckets:
            //   1. status === "interrupted" — legacy path for kinds we can't
            //      seamlessly auto-resume; surfaced as a normal interrupted
            //      task and we re-dispatch via `resumeTaskId`.
            //   2. status === "running" with `currentStep === "Resuming…"` —
            //      bootstrap-flagged resumeable tasks. Without this branch
            //      the task stays "Resuming after reload…" forever because
            //      nobody re-dispatches it.
            const interrupted = taskRuntime.list().filter((t) => {
                if (t.status === "interrupted")
                    return true;
                if (t.status === "running" &&
                    (t.currentStep === "Resuming after reload…" ||
                        t.progress === "Resuming after reload…")) {
                    return true;
                }
                return false;
            });
            if (interrupted.length === 0)
                return;
            // Mark the flag immediately to prevent a duplicate auto-resume
            // if the effect re-runs (HMR, store rebind). Also stash the count
            // so the Task Manager page can render its own animated info banner
            // — the shared toast is fine, but the in-page banner makes the
            // event much more discoverable for users who weren't watching the
            // toast region when it fired.
            try {
                window.sessionStorage.setItem(SESSION_RESUMED_FLAG, "1");
                window.sessionStorage.setItem(SESSION_RESUMED_COUNT_KEY, String(interrupted.length));
            }
            catch (_a) {
                /**/
            }
            // Just nudge the currentStep so the Task Manager UI shows immediate
            // feedback ("Auto-resuming…") before the orchestrator's first tick
            // overwrites it. Status flip + counter reset is owned by
            // orchestrator.execute() now (it sees resumeTaskId and adopts the
            // record). Doing it here too caused a race where the orchestrator
            // would create a duplicate task instead of reusing this one — the
            // original auto-resume bug.
            for (const t of interrupted) {
                taskRuntime.update(t.id, {
                    currentStep: "Auto-resuming after reload…",
                });
            }
            // Toast: non-blocking, dismissable.
            store.addNotification({
                type: "info",
                message: `Auto-resumed ${interrupted.length} task${interrupted.length === 1 ? "" : "s"} interrupted by reload. Idempotent — already-completed work is skipped on Azure side.`,
                autoDismissMs: 8000,
            });
            // Dispatch each one in series so the orchestrator's per-sub
            // concurrency caps and rate-limit guard see them in order. Errors
            // land on the task record itself; we don't surface them here.
            void (() => __awaiter(void 0, void 0, void 0, function* () {
                var _b;
                for (const t of interrupted) {
                    try {
                        yield dispatchResume(orchestrator, t);
                    }
                    catch (e) {
                        taskRuntime.update(t.id, {
                            status: "failed",
                            error: (_b = e === null || e === void 0 ? void 0 : e.message) !== null && _b !== void 0 ? _b : String(e),
                        });
                    }
                }
            }))();
        }, 250);
        return () => window.clearTimeout(timer);
    }, [orchestrator, store]);
    // Pure side-effect component — no DOM.
    return null;
};
//# sourceMappingURL=task-auto-resumer.js.map