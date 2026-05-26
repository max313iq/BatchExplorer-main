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
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
interface Props {
    orchestrator: OrchestratorAgent;
}
export declare const ResumePromptDialog: React.FC<Props>;
export {};
//# sourceMappingURL=resume-prompt-dialog.d.ts.map