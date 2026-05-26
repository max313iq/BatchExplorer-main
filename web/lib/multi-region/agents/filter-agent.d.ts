import { MultiRegionStore } from "../store/multi-region-store";
import { Agent, AgentResult, FilterInput, FilterOutput } from "./agent-types";
export declare class FilterAgent implements Agent {
    private readonly _store;
    readonly name: "filter";
    constructor(_store: MultiRegionStore);
    execute(params: Record<string, unknown>): Promise<AgentResult>;
    cancel(): void;
    filter(input: FilterInput): FilterOutput;
}
//# sourceMappingURL=filter-agent.d.ts.map