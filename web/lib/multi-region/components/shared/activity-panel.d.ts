import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
export type FilterTab = "all" | "running" | "paused" | "failed" | "completed";
export interface ActivityPanelProps {
    expanded?: boolean;
    onToggle?: () => void;
    orchestrator?: OrchestratorAgent;
}
export declare const ActivityPanel: React.FC<ActivityPanelProps>;
export declare function useActiveTaskCount(): {
    active: number;
    running: number;
};
//# sourceMappingURL=activity-panel.d.ts.map