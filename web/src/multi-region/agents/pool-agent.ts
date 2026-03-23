import { Agent, AgentContext, AgentResult, PoolInput } from "./agent-types";
import { ManagedPool, AccountInfo } from "../store/store-types";

function uuidV4(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function random4(): string {
    return Math.random().toString(36).substring(2, 6);
}

function vmShortName(vmSize: string): string {
    // "Standard_NC6s_v3" → "nc6s-v3"
    return vmSize
        .replace(/^Standard_/i, "")
        .toLowerCase()
        .replace(/_/g, "-");
}

/** Map of VM size keys to vCPU counts used for quota math */
const VM_VCPUS: Record<string, number> = {
    Standard_ND40rs_v2: 40,
    Standard_ND96isr_H100_v5: 96,
    Standard_NC24s_v3: 24,
    Standard_NC12s_v3: 12,
    Standard_NC6s_v3: 6,
};

function isCapacityOrQuotaError(errorMsg: string): boolean {
    const lower = errorMsg.toLowerCase();
    return (
        lower.includes("quota") ||
        lower.includes("capacity") ||
        lower.includes("not enough") ||
        lower.includes("allocationfailed") ||
        lower.includes("operationnotallowed")
    );
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

            // Always force targetDedicatedNodes = 0
            const poolConfig = {
                ...input.poolConfig,
                targetDedicatedNodes: 0,
            };

            const pool: ManagedPool = {
                id: internalId,
                accountId,
                poolId,
                provisioningState: "pending",
                config: poolConfig,
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
                        body: JSON.stringify(poolConfig),
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

    /**
     * Smart pool creation with VM size fallback.
     *
     * Per account, tries VM sizes in order. If a VM size fails with a
     * capacity/quota error, falls back to the next. If a pool is created
     * but doesn't use all available quota, a second pool may be created
     * with the next VM size for the remaining quota.
     *
     * ALWAYS uses targetDedicatedNodes = 0 and only LP quota.
     */
    async executeWithFallback(params: {
        accountIds: string[];
        vmSizes: string[];
        poolConfig: Record<string, unknown>;
        quotaType: "lowPriority" | "dedicated";
    }): Promise<AgentResult> {
        const { accountIds, vmSizes, poolConfig } = params;
        const { store, scheduler, getBatchAccessToken } = this._ctx;
        this._cancelled = false;

        store.setAgentStatus("pool", "running");
        store.addLog({
            agent: "pool",
            level: "info",
            message: `Smart pool creation on ${accountIds.length} accounts with ${vmSizes.length} VM size(s)`,
        });

        let totalCreated = 0;
        let totalFailed = 0;
        const failures: Array<{
            accountName: string;
            region: string;
            error: string;
        }> = [];

        // Extract startTask from the payload pool config
        const startTask = poolConfig.startTask as
            | Record<string, unknown>
            | undefined;

        for (const accountId of accountIds) {
            if (this._cancelled) break;

            const currentState = store.getState();
            const account = currentState.accounts.find(
                (a) => a.id === accountId
            );
            if (!account) {
                store.addLog({
                    agent: "pool",
                    level: "warn",
                    message: `Account ${accountId} not found, skipping`,
                });
                continue;
            }

            // Get free LP quota from AccountInfo in the store
            // ALWAYS use LP quota only, never dedicated
            const accountInfo: AccountInfo | undefined =
                currentState.accountInfos.find((a) => a.id === accountId);
            let remainingQuota = 0;
            if (accountInfo) {
                remainingQuota = accountInfo.lowPriorityCoresFree;
            }

            if (remainingQuota <= 0) {
                store.addLog({
                    agent: "pool",
                    level: "warn",
                    message: `No free LP quota on ${account.accountName}, skipping`,
                });
                continue;
            }

            let accountCreated = false;

            for (let vmIdx = 0; vmIdx < vmSizes.length; vmIdx++) {
                if (this._cancelled) break;
                if (remainingQuota <= 0) break;

                const vmSize = vmSizes[vmIdx];
                const vCPUs = VM_VCPUS[vmSize] ?? 1;
                // Compute maxNodes using ONLY LP quota: floor(freeLpCores / vCPUs)
                const maxNodes = Math.floor(remainingQuota / vCPUs);

                if (maxNodes <= 0) {
                    store.addLog({
                        agent: "pool",
                        level: "info",
                        message: `${account.accountName}: not enough LP quota (${remainingQuota} cores) for ${vmSize} (${vCPUs} vCPUs), trying next`,
                    });
                    continue;
                }

                const shortName = vmShortName(vmSize);
                const currentPoolId = `gpu-${shortName}-${random4()}`;

                // ALWAYS set targetDedicatedNodes = 0, only use LP nodes
                const currentConfig: Record<string, unknown> = {
                    ...poolConfig,
                    id: currentPoolId,
                    vmSize: vmSize.toLowerCase(),
                    targetDedicatedNodes: 0,
                    targetLowPriorityNodes: maxNodes,
                };

                // Ensure startTask from payload is included in every pool config
                if (startTask) {
                    currentConfig.startTask = startTask;
                }

                const internalId = uuidV4();
                const pool: ManagedPool = {
                    id: internalId,
                    accountId,
                    poolId: currentPoolId,
                    provisioningState: "pending",
                    config: currentConfig,
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
                            body: JSON.stringify(currentConfig),
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
                        message: `Created pool "${currentPoolId}" (${vmSize}, ${maxNodes} LP nodes) on ${account.accountName}`,
                    });
                    totalCreated++;
                    accountCreated = true;

                    // Subtract used quota and potentially create a second
                    // pool with remaining quota using the next VM size
                    remainingQuota -= maxNodes * vCPUs;

                    if (remainingQuota > 0 && vmIdx + 1 < vmSizes.length) {
                        store.addLog({
                            agent: "pool",
                            level: "info",
                            message: `${account.accountName}: ${remainingQuota} LP cores remaining, trying next VM size for partial fill`,
                        });
                        // Continue the loop — next iteration picks next VM
                        continue;
                    }

                    // Done with this account
                    break;
                } catch (error: any) {
                    const errorMsg = error?.message ?? String(error);
                    store.updatePool(internalId, {
                        provisioningState: "failed",
                        error: errorMsg,
                    });

                    if (isCapacityOrQuotaError(errorMsg)) {
                        store.addLog({
                            agent: "pool",
                            level: "warn",
                            message: `${account.accountName}: ${vmSize} failed (${errorMsg}), trying next VM size`,
                        });
                        // Continue to next VM size
                        continue;
                    }

                    // Non-capacity error — don't fallback
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
                    totalFailed++;
                    break;
                }
            }

            if (!accountCreated && failures.length === 0) {
                // All VM sizes exhausted without success
                store.addLog({
                    agent: "pool",
                    level: "error",
                    message: `${account.accountName}: all VM sizes exhausted`,
                });
                failures.push({
                    accountName: account.accountName,
                    region: account.region,
                    error: "All VM sizes exhausted — capacity/quota insufficient",
                });
                totalFailed++;
            }
        }

        const status =
            totalFailed === 0
                ? "completed"
                : totalCreated === 0
                  ? "failed"
                  : "partial";
        store.setAgentStatus(
            "pool",
            status === "failed" ? "error" : "completed"
        );

        return {
            status,
            summary: {
                total: accountIds.length,
                created: totalCreated,
                failed: totalFailed,
                failures,
            },
        };
    }
}
