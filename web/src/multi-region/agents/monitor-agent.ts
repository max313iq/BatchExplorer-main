import { Agent, AgentContext, AgentResult } from "./agent-types";

export class MonitorAgent implements Agent {
    readonly name = "monitor" as const;
    private _cancelled = false;

    constructor(private readonly _ctx: AgentContext) {}

    cancel(): void {
        this._cancelled = true;
    }

    async execute(_params: Record<string, unknown>): Promise<AgentResult> {
        const { store } = this._ctx;
        // Quota-request monitoring has been removed — monitor is now a no-op.
        // Reading the cancel flag preserves prior public surface and silences
        // unused-variable warnings.
        void this._cancelled;
        store.setAgentStatus("monitor", "completed");
        return {
            status: "completed",
            summary: {
                checked: 0,
                approved: 0,
                denied: 0,
                stillPending: 0,
                errors: 0,
            },
        };
    }
}
