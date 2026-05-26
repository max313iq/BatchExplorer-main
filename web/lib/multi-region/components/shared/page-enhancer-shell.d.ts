/**
 * Wrapper that mounts a page's enhancement-agent trio:
 *   - UIAgent       → side-panel
 *   - ToolsAgent    → toolbar slot above the page
 *   - WorkflowAgent → registered globally; pages can call
 *                     workflowRegistry.intercept(pageKey, req, next)
 *
 * The original page UI is rendered unchanged via {children}. Each trio is
 * opt-in per page; missing entries are skipped gracefully.
 *
 * Per-agent enable toggles are persisted in localStorage under
 *   `azbm:agent-enabled:<agentId>` (default true). The /agents dashboard
 * lets the user disable individual agents; this hook honors that flag on
 * every render.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import type { PageEnhancerTrio } from "../../agents/page-enhancers/types";
import { type PageKey } from "./sidebar-nav";
export interface PageEnhancerShellProps {
    pageKey: PageKey;
    trio?: PageEnhancerTrio | null;
    orchestrator?: OrchestratorAgent;
    /** When true, hide the right-side panel (mobile / narrow). Default false. */
    hidePanel?: boolean;
    children: React.ReactNode;
}
export declare const PageEnhancerShell: React.FC<PageEnhancerShellProps>;
//# sourceMappingURL=page-enhancer-shell.d.ts.map