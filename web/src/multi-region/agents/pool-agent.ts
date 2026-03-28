import { Agent, AgentContext, AgentResult, PoolInput } from "./agent-types";
import { ManagedPool, AccountInfo, PoolInfo } from "../store/store-types";
import { createPool, listPools } from "../services/batch-service";
import { AzureRequestError } from "../services/types";

/**
 * A TokenProvider resolves an access token, optionally scoped to a tenant.
 * This decouples the agent from a specific auth implementation.
 */
export type TokenProvider = (tenantId?: string) => Promise<string>;

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

/** Returns true for HTTP status codes that should never be retried. */
function isNonRetryableStatus(status: number): boolean {
    return status === 400 || status === 403 || status === 404;
}

export class PoolAgent implements Agent {
    readonly name = "pool" as const;
    private _cancelled = false;
    private readonly _tokenProvider: TokenProvider;

    constructor(
        private readonly _ctx: AgentContext,
        tokenProvider?: TokenProvider
    ) {
        // Accept an explicit TokenProvider; fall back to context method.
        this._tokenProvider =
            tokenProvider ?? _ctx.getBatchAccessToken.bind(_ctx);
    }

    cancel(): void {
        this._cancelled = true;
    }

    async execute(params: Record<string, unknown>): Promise<AgentResult> {
        const input = params as unknown as PoolInput;
        const { store, scheduler } = this._ctx;
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

            // SAFETY: Always force targetDedicatedNodes = 0.
            // Never allow dedicated nodes regardless of what the caller passes.
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
                    const token = await this._tokenProvider();
                    const accountEndpoint = `https://${account.accountName}.${account.region}.batch.azure.com`;
                    await createPool(accountEndpoint, poolConfig, token);
                });

                store.updatePool(internalId, {
                    provisioningState: "created",
                });

                // Update store.poolInfos with newly created pool
                this._addPoolInfoToStore(account, poolId, poolConfig);

                store.addLog({
                    agent: "pool",
                    level: "info",
                    message: `Created pool "${poolId}" on ${account.accountName} (${account.region})`,
                });
                created++;
            } catch (error: any) {
                const errorMsg =
                    error instanceof AzureRequestError
                        ? error.message
                        : error?.message ?? String(error);
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
     * Per account, tries VM sizes in priority order. If a VM size fails with
     * a capacity/quota error, falls back to the next. Calculates maxNodes
     * from LP quota (floor(freeLpCores / vCPUs per VM)).
     *
     * If a pool is created but doesn't consume all available quota, a second
     * pool may be created with the next VM size for the remaining quota.
     *
     * SAFETY: ALWAYS sets targetDedicatedNodes = 0 and only uses LP quota.
     */
    async executeWithFallback(params: {
        accountIds: string[];
        vmSizes: string[];
        poolConfig: Record<string, unknown>;
        quotaType: "lowPriority" | "dedicated";
    }): Promise<AgentResult> {
        const { accountIds, vmSizes, poolConfig } = params;
        const { store, scheduler } = this._ctx;
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

                // Pool ID format: gpu-{vmSizeShort}-{random4}
                const shortName = vmShortName(vmSize);
                const currentPoolId = `gpu-${shortName}-${random4()}`;

                // SAFETY: ALWAYS set targetDedicatedNodes = 0, only use LP nodes
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
                        const token = await this._tokenProvider();
                        const accountEndpoint = `https://${account.accountName}.${account.region}.batch.azure.com`;
                        await createPool(accountEndpoint, currentConfig, token);
                    });

                    store.updatePool(internalId, {
                        provisioningState: "created",
                    });

                    // Update store.poolInfos with newly created pool
                    this._addPoolInfoToStore(
                        account,
                        currentPoolId,
                        currentConfig
                    );

                    store.addLog({
                        agent: "pool",
                        level: "info",
                        message: `Created pool "${currentPoolId}" (${vmSize}, ${maxNodes} LP nodes) on ${account.accountName}`,
                    });
                    totalCreated++;
                    accountCreated = true;

                    // Wait for pool to finish resizing to get ACTUAL node count
                    store.addLog({
                        agent: "pool",
                        level: "info",
                        message: `${account.accountName}: Waiting for pool "${currentPoolId}" to finish resizing...`,
                    });

                    const accountEndpointStr = `https://${account.accountName}.${account.region}.batch.azure.com`;
                    const resizeResult = await this._waitForPoolSteady(
                        accountEndpointStr,
                        currentPoolId,
                        await this._tokenProvider()
                    );

                    const actualNodes = resizeResult.actualLpNodes;
                    const actualCoresUsed = actualNodes * vCPUs;
                    remainingQuota -= actualCoresUsed;

                    store.addLog({
                        agent: "pool",
                        level: "info",
                        message: `${account.accountName}: Pool "${currentPoolId}" (${vmSize}): ${actualNodes}/${maxNodes} nodes allocated (${actualCoresUsed} cores used, ${remainingQuota} cores remaining)`,
                    });

                    if (resizeResult.resizeErrors > 0) {
                        store.addLog({
                            agent: "pool",
                            level: "warn",
                            message: `${account.accountName}: Pool "${currentPoolId}" had ${resizeResult.resizeErrors} resize error(s)`,
                        });
                    }

                    // ALWAYS continue to next VM if quota remains (waterfall fill)
                    if (remainingQuota > 0) {
                        store.addLog({
                            agent: "pool",
                            level: "info",
                            message: `${account.accountName}: ${remainingQuota} LP cores remaining — trying next VM size`,
                        });
                        continue; // next VM in the loop
                    }

                    // No quota left — done with this account
                    break;
                } catch (error: any) {
                    const errorMsg =
                        error instanceof AzureRequestError
                            ? error.message
                            : error?.message ?? String(error);
                    const errorStatus =
                        error instanceof AzureRequestError
                            ? error.status
                            : (error?.status as number | undefined);

                    store.updatePool(internalId, {
                        provisioningState: "failed",
                        error: errorMsg,
                    });

                    // Non-retryable errors (400, 403, 404): fail immediately,
                    // do not try fallback VM sizes
                    if (
                        errorStatus !== undefined &&
                        isNonRetryableStatus(errorStatus)
                    ) {
                        store.addLog({
                            agent: "pool",
                            level: "error",
                            message: `${account.accountName}: non-retryable error ${errorStatus} — ${errorMsg}`,
                        });
                        failures.push({
                            accountName: account.accountName,
                            region: account.region,
                            error: errorMsg,
                        });
                        totalFailed++;
                        break;
                    }

                    if (isCapacityOrQuotaError(errorMsg)) {
                        store.addLog({
                            agent: "pool",
                            level: "warn",
                            message: `${account.accountName}: ${vmSize} failed (${errorMsg}), trying next VM size`,
                        });
                        // Continue to next VM size
                        continue;
                    }

                    // Other errors — don't fallback
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

    /**
     * Poll until a pool's allocationState becomes "steady" or timeout.
     * Returns the actual node counts so we can calculate real quota usage.
     */
    private async _waitForPoolSteady(
        endpoint: string,
        poolId: string,
        _token: string,
        timeoutMs: number = 600000 // 10 minutes
    ): Promise<{
        actualLpNodes: number;
        targetLpNodes: number;
        actualDedicatedNodes: number;
        allocationState: string;
        resizeErrors: number;
    }> {
        const { store } = this._ctx;
        const pollIntervalMs = 15000; // 15 seconds
        const maxPolls = Math.ceil(timeoutMs / pollIntervalMs);

        for (let i = 0; i < maxPolls; i++) {
            if (this._cancelled) break;

            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

            try {
                // Need a fresh token for each poll since tokens can expire
                const freshToken = await this._tokenProvider();
                const pools = await listPools(endpoint, freshToken);
                const pool = pools.find(
                    (p) => p.id?.toLowerCase() === poolId.toLowerCase()
                );

                if (!pool) {
                    store.addLog({
                        agent: "pool",
                        level: "warn",
                        message: `Pool ${poolId} not found during resize poll (poll ${i + 1}/${maxPolls})`,
                    });
                    continue;
                }

                const state = (pool as any).allocationState ?? "unknown";
                const currentLp = (pool as any).currentLowPriorityNodes ?? 0;
                const targetLp = (pool as any).targetLowPriorityNodes ?? 0;
                const currentDedicated =
                    (pool as any).currentDedicatedNodes ?? 0;
                const errors = Array.isArray((pool as any).resizeErrors)
                    ? (pool as any).resizeErrors.length
                    : 0;

                store.addLog({
                    agent: "pool",
                    level: "info",
                    message: `Pool ${poolId}: ${state} — ${currentLp}/${targetLp} LP nodes (poll ${i + 1})`,
                });

                if (state === "steady" || state === "stopping") {
                    return {
                        actualLpNodes: currentLp,
                        targetLpNodes: targetLp,
                        actualDedicatedNodes: currentDedicated,
                        allocationState: state,
                        resizeErrors: errors,
                    };
                }
            } catch (err) {
                store.addLog({
                    agent: "pool",
                    level: "warn",
                    message: `Poll error for ${poolId}: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        }

        // Timeout — return last known state
        store.addLog({
            agent: "pool",
            level: "warn",
            message: `Pool ${poolId}: resize timeout after ${timeoutMs / 1000}s, proceeding with partial data`,
        });

        return {
            actualLpNodes: 0,
            targetLpNodes: 0,
            actualDedicatedNodes: 0,
            allocationState: "timeout",
            resizeErrors: 0,
        };
    }

    /**
     * Append a PoolInfo entry to store.poolInfos after successful creation.
     */
    private _addPoolInfoToStore(
        account: { id: string; accountName: string; region: string },
        poolId: string,
        config: Record<string, unknown>
    ): void {
        const { store } = this._ctx;
        const state = store.getState();

        const newPoolInfo: PoolInfo = {
            id: uuidV4(),
            accountId: account.id,
            accountName: account.accountName,
            region: account.region,
            poolId,
            vmSize: (config.vmSize as string) ?? "",
            state: "active",
            allocationState: "resizing",
            targetDedicatedNodes: 0, // SAFETY: always 0
            currentDedicatedNodes: 0,
            targetLowPriorityNodes:
                (config.targetLowPriorityNodes as number) ?? 0,
            currentLowPriorityNodes: 0,
            taskSlotsPerNode: (config.taskSlotsPerNode as number) ?? 1,
            enableAutoScale: (config.enableAutoScale as boolean) ?? false,
            autoScaleFormula: config.autoScaleFormula as string | undefined,
            creationTime: new Date().toISOString(),
            startTask: config.startTask as Record<string, unknown> | undefined,
        };

        store.setPoolInfos([...state.poolInfos, newPoolInfo]);
    }
}
