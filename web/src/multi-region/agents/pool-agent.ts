import { Agent, AgentContext, AgentResult, PoolInput } from "./agent-types";
import { ManagedPool } from "../store/store-types";

function uuidV4(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export class PoolAgent implements Agent {
    readonly name = "pool" as const;
    private _cancelled = false;

    constructor(private readonly _ctx: AgentContext) {}

    cancel(): void {
        this._cancelled = true;
    }

    async execute(params: Record<string, unknown>): Promise<AgentResult> {
        const input = params as unknown as PoolInput;
        const { store, scheduler, getBatchAccessToken } = this._ctx;
        this._cancelled = false;

        store.setAgentStatus("pool", "running");
        store.addLog({
            agent: "pool",
            level: "info",
            message: `Starting pool creation on ${input.accountIds.length} accounts`,
        });

        let created = 0;
        let failed = 0;
        const failures: Array<{
            accountName: string;
            region: string;
            error: string;
        }> = [];

        const poolId = (input.poolConfig.id as string) ?? "pool";

        for (const accountId of input.accountIds) {
            if (this._cancelled) break;

            const state = store.getState();
            const account = state.accounts.find((a) => a.id === accountId);
            if (!account) {
                store.addLog({
                    agent: "pool",
                    level: "warn",
                    message: `Account ${accountId} not found, skipping`,
                });
                continue;
            }

            const internalId = uuidV4();

            const pool: ManagedPool = {
                id: internalId,
                accountId,
                poolId,
                provisioningState: "pending",
                config: input.poolConfig,
                createdAt: new Date().toISOString(),
                error: null,
            };
            store.addPool(pool);

            try {
                store.updatePool(internalId, {
                    provisioningState: "creating",
                });

                await scheduler.run(accountId, async () => {
                    const token = await getBatchAccessToken();
                    const batchUrl = `https://${account.accountName}.${account.region}.batch.azure.com/pools?api-version=2024-07-01.20.0`;

                    const response = await fetch(batchUrl, {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json; odata=minimalmetadata",
                            Authorization: `Bearer ${token}`,
                        },
                        body: JSON.stringify(input.poolConfig),
                    });

                    if (!response.ok) {
                        const err = await response.json().catch(() => ({}));
                        throw {
                            status: response.status,
                            message:
                                err?.error?.message ??
                                err?.message?.value ??
                                `Pool creation failed: ${response.status}`,
                            headers: response.headers,
                        };
                    }
                });

                store.updatePool(internalId, {
                    provisioningState: "created",
                });
                store.addLog({
                    agent: "pool",
                    level: "info",
                    message: `Created pool "${poolId}" on ${account.accountName} (${account.region})`,
                });
                created++;
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.updatePool(internalId, {
                    provisioningState: "failed",
                    error: errorMsg,
                });
                store.addLog({
                    agent: "pool",
                    level: "error",
                    message: `Failed pool creation on ${account.accountName}: ${errorMsg}`,
                });
                failures.push({
                    accountName: account.accountName,
                    region: account.region,
                    error: errorMsg,
                });
                failed++;
            }
        }

        const status =
            failed === 0 ? "completed" : created === 0 ? "failed" : "partial";
        store.setAgentStatus(
            "pool",
            status === "failed" ? "error" : "completed"
        );

        return {
            status,
            summary: {
                total: input.accountIds.length,
                created,
                failed,
                failures,
            },
        };
    }
}
