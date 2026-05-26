import type { PageEnhancerTrio, WorkflowAgent, BaseEnhancer } from "./types";
import type { PageKey } from "../../components/shared/sidebar-nav";
export declare function isEnhancerEnabled(agentId: string): boolean;
export declare function setEnhancerEnabled(agentId: string, enabled: boolean): void;
declare class WorkflowRegistry {
    private agents;
    set(pageKey: PageKey, agent: WorkflowAgent): void;
    unset(pageKey: PageKey, agentId: string): void;
    get(pageKey: PageKey): WorkflowAgent | null;
}
export declare const workflowRegistry: WorkflowRegistry;
export declare function getTrioForPage(pageKey: PageKey): PageEnhancerTrio | null;
export declare function listAllTrios(): readonly PageEnhancerTrio[];
export declare function listAllAgents(): readonly BaseEnhancer[];
export {};
//# sourceMappingURL=registry.d.ts.map