/**
 * Pool Creation page — guides the operator through a stepper workflow
 * (Target -> Image -> Scale -> Networking -> Tasks -> Review) and submits
 * a multi-account pool create through the orchestrator.
 *
 * Does NOT host the global pool-defaults editor — that lives on the
 * `/pool-defaults` page; this page only consumes them and offers an opt-in
 * "save as default" hook on submit.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
interface PoolCreationPageProps {
    orchestrator: OrchestratorAgent;
}
export declare const PoolCreationPage: React.FC<PoolCreationPageProps>;
export {};
//# sourceMappingURL=pool-creation-page.d.ts.map