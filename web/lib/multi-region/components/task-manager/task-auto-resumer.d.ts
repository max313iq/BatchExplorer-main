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
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
interface Props {
    orchestrator: OrchestratorAgent;
}
export declare const TaskAutoResumer: React.FC<Props>;
export {};
//# sourceMappingURL=task-auto-resumer.d.ts.map