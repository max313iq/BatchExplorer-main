import { Agent, AgentContext, AgentResult } from "./agent-types";
import { ProvisionerAgent } from "./provisioner-agent";
import { QuotaAgent } from "./quota-agent";
import { MonitorAgent } from "./monitor-agent";
import { FilterAgent } from "./filter-agent";
import { PoolAgent } from "./pool-agent";
import { NodeAgent } from "./node-agent";
import { WorkflowAgent, WorkflowConfig } from "./workflow-agent";
import { RequestDeduplicator } from "../scheduling/request-deduplicator";
import { PoolInfo, AccountInfo, QuotaSuggestion } from "../store/store-types";

function generateCorrelationId(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function getVCpus(vmSize: string): number {
    const map: Record<string, number> = {
        standard_nc6: 6,
        standard_nc12: 12,
        standard_nc24: 24,
        standard_nc24r: 24,
        standard_nc6s_v3: 6,
        standard_nc12s_v3: 12,
        standard_nc24s_v3: 24,
        standard_nc24rs_v3: 24,
        standard_nc4as_t4_v3: 4,
        standard_nc8as_t4_v3: 8,
        standard_nc16as_t4_v3: 16,
        standard_nc64as_t4_v3: 64,
        standard_nd96amsr_a100_v4: 96,
        standard_nd96asr_a100_v4: 96,
        standard_nd96isr_h100_v5: 96,
        standard_nd40rs_v2: 40,
        standard_nv6: 6,
        standard_nv12: 12,
        standard_nv24: 24,
        standard_nv6ads_a10_v5: 6,
        standard_nv12ads_a10_v5: 12,
        standard_nv18ads_a10_v5: 18,
        standard_nv36ads_a10_v5: 36,
        standard_nv36adms_a10_v5: 36,
        standard_nv72ads_a10_v5: 72,
        standard_d2s_v3: 2,
        standard_d4s_v3: 4,
        standard_d8s_v3: 8,
        standard_d16s_v3: 16,
        standard_d32s_v3: 32,
        standard_d48s_v3: 48,
        standard_d64s_v3: 64,
        standard_f2s_v2: 2,
        standard_f4s_v2: 4,
        standard_f8s_v2: 8,
        standard_f16s_v2: 16,
        standard_f32s_v2: 32,
        standard_f48s_v2: 48,
        standard_f72s_v2: 72,
    };
    return map[vmSize.toLowerCase().replace(/\s/g, "")] || 1;
}

export type OrchestratorAction =
    | "create_accounts"
    | "discover_accounts"
    | "submit_quota_requests"
    | "check_quota_status"
    | "filter_accounts"
    | "create_pools"
    | "list_nodes"
    | "node_action"
    | "run_workflow"
    | "retry_failed"
    | "refresh_pool_info"
    | "refresh_account_info"
    | "delete_nodes"
    | "recreate_nodes"
    | "recover_preempted"
    | "detect_unused_quota"
    | "auto_create_pools_from_quota"
    | "resize_pool"
    | "update_start_task"
    | "create_pools_smart";

export class OrchestratorAgent implements Agent {
    readonly name = "orchestrator" as const;

    private readonly _provisioner: ProvisionerAgent;
    private readonly _quota: QuotaAgent;
    private readonly _monitor: MonitorAgent;
    private readonly _filter: FilterAgent;
    private readonly _pool: PoolAgent;
    private readonly _node: NodeAgent;
    private readonly _deduplicator: RequestDeduplicator;
    private _workflowAgent: WorkflowAgent | null = null;

    constructor(private readonly _ctx: AgentContext) {
        this._deduplicator = new RequestDeduplicator();
        this._provisioner = new ProvisionerAgent(_ctx);
        this._quota = new QuotaAgent(_ctx);
        this._monitor = new MonitorAgent(_ctx);
        this._filter = new FilterAgent(_ctx.store);
        this._pool = new PoolAgent(_ctx);
        this._node = new NodeAgent(_ctx);
    }

    cancel(): void {
        this._provisioner.cancel();
        this._quota.cancel();
        this._monitor.cancel();
        this._pool.cancel();
        this._node.cancel();
        if (this._workflowAgent) {
            this._workflowAgent.cancel();
        }
    }

    async execute(params: Record<string, unknown>): Promise<AgentResult> {
        const action = params.action as OrchestratorAction;
        const { store } = this._ctx;
        const correlationId = generateCorrelationId();
        const startTime = Date.now();

        // Determine a human-readable target for the activity
        const actPayload = params.payload as
            | Record<string, unknown>
            | undefined;
        const actTarget = this._resolveActivityTarget(action, actPayload);

        // Track this action as an activity
        const actId = store.addActivity({
            action,
            target: actTarget,
            status: "running",
        });

        store.setAgentStatus("orchestrator", "running");
        store.addLog({
            agent: "orchestrator",
            level: "info",
            message: `[${correlationId}] Dispatching action: ${action}`,
        });

        try {
            let result: AgentResult;

            switch (action) {
                case "create_accounts":
                    result = await this._provisioner.execute(
                        params.payload as Record<string, unknown>
                    );
                    store.addNotification({
                        type:
                            result.status === "completed"
                                ? "success"
                                : "warning",
                        message:
                            result.status === "completed"
                                ? "Account creation completed successfully"
                                : `Account creation finished with status: ${result.status}`,
                    });
                    break;

                case "discover_accounts":
                    result = await this._deduplicator.deduplicate(
                        "discover-accounts",
                        () =>
                            this._discoverAccounts(
                                params.payload as Record<string, unknown>
                            )
                    );
                    break;

                case "submit_quota_requests":
                    this._validatePrecondition("submit_quota_requests", () => {
                        const state = store.getState();
                        const createdAccounts = state.accounts.filter(
                            (a) => a.provisioningState === "created"
                        );
                        if (createdAccounts.length === 0) {
                            throw new Error(
                                "No created accounts found. Create accounts first."
                            );
                        }
                    });
                    result = await this._quota.execute(
                        params.payload as Record<string, unknown>
                    );
                    store.addNotification({
                        type:
                            result.status === "completed"
                                ? "success"
                                : "warning",
                        message:
                            result.status === "completed"
                                ? "Quota requests submitted successfully"
                                : `Quota submission finished with status: ${result.status}`,
                    });
                    break;

                case "check_quota_status":
                    result = await this._monitor.execute(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "filter_accounts":
                    result = await this._filter.execute(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "create_pools": {
                    const cpPayload = params.payload as Record<string, unknown>;

                    // If no accountIds provided, run filter first
                    if (
                        !cpPayload.accountIds ||
                        (cpPayload.accountIds as string[]).length === 0
                    ) {
                        store.updateActivity(actId, { progress: 10 });
                        const filterResult = await this._filter.execute({
                            filters: cpPayload.filters ?? {},
                            selectAll: true,
                        } as Record<string, unknown>);

                        const filtered = filterResult.summary as unknown as {
                            accounts: Array<{
                                accountId: string;
                            }>;
                        };
                        cpPayload.accountIds = filtered.accounts.map(
                            (a) => a.accountId
                        );
                    }

                    store.updateActivity(actId, { progress: 30 });
                    result = await this._pool.execute(cpPayload);
                    store.addNotification({
                        type:
                            result.status === "completed"
                                ? "success"
                                : "warning",
                        message:
                            result.status === "completed"
                                ? "Pool creation completed successfully"
                                : `Pool creation finished with status: ${result.status}`,
                    });
                    break;
                }

                case "create_pools_smart": {
                    const smartPayload = params.payload as Record<
                        string,
                        unknown
                    >;
                    store.updateActivity(actId, { progress: 20 });
                    result = await this._pool.executeWithFallback({
                        accountIds: (smartPayload.accountIds as string[]) ?? [],
                        vmSizes: (smartPayload.vmSizes as string[]) ?? [],
                        poolConfig:
                            (smartPayload.poolConfig as Record<
                                string,
                                unknown
                            >) ?? {},
                        quotaType:
                            (smartPayload.quotaType as
                                | "lowPriority"
                                | "dedicated") ?? "lowPriority",
                    });
                    store.addNotification({
                        type:
                            result.status === "completed"
                                ? "success"
                                : "warning",
                        message:
                            result.status === "completed"
                                ? "Smart pool creation completed successfully"
                                : `Smart pool creation finished with status: ${result.status}`,
                    });
                    break;
                }

                case "list_nodes":
                    result = await this._node.execute(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "node_action":
                    result = await this._node.execute(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "delete_nodes":
                    result = await this._deleteNodes(
                        params.payload as Record<string, unknown>
                    );
                    break;
                case "recreate_nodes":
                    result = await this._recreateNodes(
                        params.payload as Record<string, unknown>
                    );
                    break;
                case "recover_preempted":
                    result = await this._recoverPreempted(
                        params.payload as Record<string, unknown>
                    );
                    break;
                case "run_workflow": {
                    const workflowConfig =
                        params.payload as unknown as WorkflowConfig;
                    this._workflowAgent = new WorkflowAgent(this._ctx);
                    store.updateActivity(actId, { progress: 10 });
                    result = await this._workflowAgent.execute(workflowConfig);
                    this._workflowAgent = null;
                    break;
                }

                case "refresh_pool_info":
                    result = await this._deduplicator.deduplicate(
                        "refresh-pool-info",
                        () => this._refreshPoolInfo()
                    );
                    break;

                case "refresh_account_info":
                    result = await this._deduplicator.deduplicate(
                        "refresh-account-info",
                        () => this._refreshAccountInfo()
                    );
                    break;

                case "retry_failed": {
                    const retryAccountIds = store.retryFailedAccounts();
                    const retryQuotaIds = store.retryFailedQuotas();
                    const retryPoolIds = store.retryFailedPools();

                    result = {
                        status: "completed",
                        summary: {
                            retriedAccounts: retryAccountIds.length,
                            retriedQuotas: retryQuotaIds.length,
                            retriedPools: retryPoolIds.length,
                            accountIds: retryAccountIds,
                            quotaIds: retryQuotaIds,
                            poolIds: retryPoolIds,
                        },
                    };

                    store.addNotification({
                        type: "info",
                        message: `Retry queued: ${retryAccountIds.length} accounts, ${retryQuotaIds.length} quotas, ${retryPoolIds.length} pools`,
                    });
                    break;
                }

                case "detect_unused_quota":
                    result = await this._detectUnusedQuota();
                    break;

                case "auto_create_pools_from_quota":
                    result = await this._autoCreatePoolsFromQuota(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "resize_pool":
                    result = await this._resizePool(
                        params.payload as Record<string, unknown>
                    );
                    break;

                case "update_start_task":
                    result = await this._updateStartTask(
                        params.payload as Record<string, unknown>
                    );
                    break;

                default:
                    throw new Error(`Unknown action: ${action}`);
            }

            const durationMs = Date.now() - startTime;
            store.setAgentStatus("orchestrator", "completed");
            store.addLog({
                agent: "orchestrator",
                level: "info",
                message: `[${correlationId}] Action "${action}" completed in ${durationMs}ms with status: ${result.status}`,
            });

            // Mark activity as completed
            store.updateActivity(actId, {
                status: result.status === "failed" ? "failed" : "completed",
                completedAt: new Date().toISOString(),
                progress: 100,
                error:
                    result.status === "failed"
                        ? ((result.summary as Record<string, unknown>)
                              ?.error as string) ?? "Unknown error"
                        : undefined,
            });

            return result;
        } catch (error: any) {
            const durationMs = Date.now() - startTime;
            const errorMsg = error?.message ?? String(error);
            store.setAgentStatus("orchestrator", "error");
            store.addLog({
                agent: "orchestrator",
                level: "error",
                message: `[${correlationId}] Action "${action}" failed in ${durationMs}ms: ${errorMsg}`,
            });

            // Mark activity as failed
            store.updateActivity(actId, {
                status: "failed",
                completedAt: new Date().toISOString(),
                error: errorMsg,
            });

            return {
                status: "failed",
                summary: { error: errorMsg },
            };
        }
    }

    private _resolveActivityTarget(
        action: OrchestratorAction,
        payload?: Record<string, unknown>
    ): string {
        if (!payload) return action;
        switch (action) {
            case "discover_accounts":
                return `subscription ${(payload.subscriptionId as string)?.substring(0, 8) ?? ""}...`;
            case "create_accounts":
                return `${(payload.regions as string[])?.length ?? 0} regions`;
            case "submit_quota_requests":
                return `${(payload.quotaType as string) ?? "quota"} requests`;
            case "check_quota_status":
                return "quota status check";
            case "filter_accounts":
                return "account filter";
            case "create_pools":
                return `${(payload.accountIds as string[])?.length ?? "all"} accounts`;
            case "list_nodes":
                return `pool ${(payload.poolId as string) ?? ""}`;
            case "node_action":
                return `${(payload.action as string) ?? "action"} on nodes`;
            case "delete_nodes":
                return `${(payload.nodeIds as string[])?.length ?? 0} nodes`;
            case "recreate_nodes":
                return `${(payload.nodeIds as string[])?.length ?? 0} nodes`;
            case "recover_preempted":
                return "preempted nodes";
            case "run_workflow":
                return "full workflow";
            case "refresh_pool_info":
                return "all accounts";
            case "refresh_account_info":
                return "all accounts";
            case "retry_failed":
                return "failed items";
            case "detect_unused_quota":
                return "unused quota detection";
            case "auto_create_pools_from_quota":
                return "auto pool creation";
            case "resize_pool":
                return `pool ${(payload.poolId as string) ?? ""}`;
            case "update_start_task":
                return `pool ${(payload.poolId as string) ?? ""}`;
            default:
                return action;
        }
    }

    private async _discoverAccounts(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        const subscriptionId = payload.subscriptionId as string;
        const { store, getAccessToken, armUrl } = this._ctx;

        store.setAgentStatus("provisioner", "running");
        store.addLog({
            agent: "provisioner",
            level: "info",
            message: `Discovering existing Batch accounts in subscription ${subscriptionId.substring(0, 8)}...`,
        });

        try {
            const token = await getAccessToken();
            let url: string | null =
                `${armUrl}/subscriptions/${subscriptionId}/providers/Microsoft.Batch/batchAccounts?api-version=2024-02-01`;
            const allAccounts: any[] = [];

            // Handle pagination
            while (url) {
                const response = await fetch(url, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(
                        err?.error?.message ??
                            `Discovery failed: ${response.status}`
                    );
                }
                const data = await response.json();
                allAccounts.push(...(data.value ?? []));
                url = data.nextLink ?? null;
            }

            // Deduplicate against existing accounts in state
            const existingIds = new Set(
                store.getState().accounts.map((a) => a.id.toLowerCase())
            );
            let imported = 0;

            for (const acct of allAccounts) {
                const id = (acct.id as string) ?? "";
                if (existingIds.has(id.toLowerCase())) continue;

                // Parse resource group from the ARM id
                const rgMatch = id.match(/resourceGroups\/([^/]+)/i);
                const resourceGroup = rgMatch ? rgMatch[1] : "unknown";

                store.addAccount({
                    id,
                    accountName: acct.name,
                    resourceGroup,
                    subscriptionId,
                    region: acct.location,
                    provisioningState: "created",
                    createdAt:
                        acct.properties?.creationTime ??
                        new Date().toISOString(),
                    error: null,
                });
                imported++;
            }

            store.setAgentStatus("provisioner", "completed");
            store.addLog({
                agent: "provisioner",
                level: "info",
                message: `Discovered ${allAccounts.length} Batch accounts, imported ${imported} new (${allAccounts.length - imported} already tracked)`,
            });

            return {
                status: "completed",
                summary: {
                    total: allAccounts.length,
                    imported,
                    skipped: allAccounts.length - imported,
                },
            };
        } catch (error: any) {
            const errorMsg = error?.message ?? String(error);
            store.setAgentStatus("provisioner", "error");
            store.addLog({
                agent: "provisioner",
                level: "error",
                message: `Discovery failed: ${errorMsg}`,
            });
            throw error;
        }
    }

    private async _refreshPoolInfo(): Promise<AgentResult> {
        const { store, getBatchAccessToken } = this._ctx;
        const state = store.getState();
        const accounts = state.accounts.filter(
            (a) => a.provisioningState === "created"
        );

        store.addLog({
            agent: "orchestrator",
            level: "info",
            message: `Refreshing pool info for ${accounts.length} accounts`,
        });

        const allPools: PoolInfo[] = [];
        let failedCount = 0;

        for (const account of accounts) {
            try {
                const token = await getBatchAccessToken();
                let url: string | null =
                    `https://${account.accountName}.${account.region}.batch.azure.com/pools?api-version=2024-07-01.20.0`;

                while (url) {
                    const response = await fetch(url, {
                        headers: {
                            Authorization: `Bearer ${token}`,
                        },
                    });

                    if (!response.ok) {
                        const err = await response.json().catch(() => ({}));
                        throw new Error(
                            err?.error?.message ??
                                `Failed to list pools: ${response.status}`
                        );
                    }

                    const data = await response.json();
                    const pools = (data.value ?? []) as Array<
                        Record<string, any>
                    >;

                    for (const p of pools) {
                        const resizeErrors: string[] = [];
                        if (p.resizeErrors && Array.isArray(p.resizeErrors)) {
                            for (const re of p.resizeErrors) {
                                resizeErrors.push(
                                    re.message ?? re.code ?? String(re)
                                );
                            }
                        }

                        allPools.push({
                            id: `${account.id}/pools/${p.id}`,
                            accountId: account.id,
                            accountName: account.accountName,
                            region: account.region,
                            poolId: p.id ?? "",
                            vmSize: p.vmSize ?? "",
                            state: p.state ?? "unknown",
                            allocationState: p.allocationState ?? "unknown",
                            targetDedicatedNodes: p.targetDedicatedNodes ?? 0,
                            currentDedicatedNodes: p.currentDedicatedNodes ?? 0,
                            targetLowPriorityNodes:
                                p.targetLowPriorityNodes ?? 0,
                            currentLowPriorityNodes:
                                p.currentLowPriorityNodes ?? 0,
                            taskSlotsPerNode: p.taskSlotsPerNode ?? 1,
                            enableAutoScale: p.enableAutoScale ?? false,
                            autoScaleFormula: p.autoScaleFormula,
                            resizeErrors:
                                resizeErrors.length > 0
                                    ? resizeErrors
                                    : undefined,
                            lastModified: p.lastModified,
                            creationTime: p.creationTime,
                            startTask: p.startTask ?? undefined,
                        });
                    }

                    url = data["odata.nextLink"] ?? null;
                }
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.addLog({
                    agent: "orchestrator",
                    level: "error",
                    message: `Failed to refresh pools for ${account.accountName}: ${errorMsg}`,
                });
                failedCount++;
            }
        }

        store.setPoolInfos(allPools);

        store.addLog({
            agent: "orchestrator",
            level: "info",
            message: `Pool info refreshed: ${allPools.length} pools across ${accounts.length - failedCount} accounts (${failedCount} failed)`,
        });

        return {
            status:
                failedCount === 0
                    ? "completed"
                    : failedCount === accounts.length
                      ? "failed"
                      : "partial",
            summary: {
                totalPools: allPools.length,
                accountsQueried: accounts.length,
                accountsFailed: failedCount,
            },
        };
    }

    private async _refreshAccountInfo(): Promise<AgentResult> {
        const { store, getAccessToken, armUrl } = this._ctx;
        const state = store.getState();
        const accounts = state.accounts.filter(
            (a) => a.provisioningState === "created"
        );

        store.addLog({
            agent: "orchestrator",
            level: "info",
            message: `Refreshing account info for ${accounts.length} accounts`,
        });

        const allAccountInfos: AccountInfo[] = [];
        let failedCount = 0;

        // Use the current poolInfos from the store to compute usage
        const poolInfos = store.getState().poolInfos;

        for (const account of accounts) {
            try {
                const token = await getAccessToken();
                const rgMatch = account.id.match(/resourceGroups\/([^/]+)/i);
                const resourceGroup = rgMatch
                    ? rgMatch[1]
                    : account.resourceGroup;

                const url = `${armUrl}/subscriptions/${account.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Batch/batchAccounts/${account.accountName}?api-version=2024-02-01`;

                const response = await fetch(url, {
                    headers: { Authorization: `Bearer ${token}` },
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(
                        err?.error?.message ??
                            `Failed to get account info: ${response.status}`
                    );
                }

                const data = await response.json();
                const props = data.properties ?? {};

                const lowPriorityCoreQuota = props.lowPriorityCoreQuota ?? 0;
                const poolQuota = props.poolQuota ?? 0;
                const activeJobAndJobScheduleQuota =
                    props.activeJobAndJobScheduleQuota ?? 0;

                // Check if per-VM-family enforcement is enabled
                const dedicatedCoreQuotaPerVMFamilyEnforced: boolean =
                    props.dedicatedCoreQuotaPerVMFamilyEnforced ?? false;

                // Compute usage from poolInfos
                const accountPools = poolInfos.filter(
                    (p) => p.accountId === account.id
                );
                const dedicatedCoresUsed = accountPools.reduce(
                    (sum, p) =>
                        sum +
                        p.currentDedicatedNodes * getVCpus(p.vmSize || ""),
                    0
                );
                const lowPriorityCoresUsed = accountPools.reduce(
                    (sum, p) =>
                        sum +
                        p.currentLowPriorityNodes * getVCpus(p.vmSize || ""),
                    0
                );
                const poolCount = accountPools.length;

                // Determine dedicated core quota
                let dedicatedCoreQuota: number;
                let dedicatedCoreQuotaPerVMFamily:
                    | Array<{
                          name: string;
                          coreQuota: number;
                          coresUsed: number;
                          coresFree: number;
                      }>
                    | undefined;

                if (
                    dedicatedCoreQuotaPerVMFamilyEnforced &&
                    Array.isArray(props.dedicatedCoreQuotaPerVMFamily)
                ) {
                    const familyQuotas =
                        props.dedicatedCoreQuotaPerVMFamily as Array<{
                            name: string;
                            coreQuota: number;
                        }>;

                    dedicatedCoreQuotaPerVMFamily = familyQuotas.map((fq) => {
                        const familyLower = fq.name.toLowerCase();
                        let coresUsed = 0;
                        for (const pool of accountPools) {
                            const vmLower = (pool.vmSize || "")
                                .toLowerCase()
                                .replace(/s/g, "");
                            const prefix = vmLower
                                .replace(/standard_/, "")
                                .replace(/[0-9_]/g, "")
                                .replace(/svd+/g, "")
                                .substring(0, 2);
                            if (familyLower.includes(prefix)) {
                                coresUsed +=
                                    pool.currentDedicatedNodes *
                                    getVCpus(pool.vmSize || "");
                            }
                        }
                        return {
                            name: fq.name,
                            coreQuota: fq.coreQuota,
                            coresUsed,
                            coresFree: fq.coreQuota - coresUsed,
                        };
                    });

                    // Total dedicated quota is sum of all family quotas
                    dedicatedCoreQuota = familyQuotas.reduce(
                        (sum, fq) => sum + fq.coreQuota,
                        0
                    );
                } else {
                    dedicatedCoreQuota = props.dedicatedCoreQuota ?? 0;
                }

                allAccountInfos.push({
                    id: account.id,
                    accountName: account.accountName,
                    subscriptionId: account.subscriptionId,
                    region: account.region,
                    resourceGroup,
                    dedicatedCoreQuota,
                    lowPriorityCoreQuota,
                    poolQuota,
                    activeJobAndJobScheduleQuota,
                    dedicatedCoresUsed,
                    lowPriorityCoresUsed,
                    poolCount,
                    dedicatedCoresFree: dedicatedCoreQuota - dedicatedCoresUsed,
                    lowPriorityCoresFree:
                        lowPriorityCoreQuota - lowPriorityCoresUsed,
                    poolsFree: poolQuota - poolCount,
                    dedicatedCoreQuotaPerVMFamilyEnforced,
                    dedicatedCoreQuotaPerVMFamily,
                });
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.addLog({
                    agent: "orchestrator",
                    level: "error",
                    message: `Failed to refresh account info for ${account.accountName}: ${errorMsg}`,
                });
                failedCount++;
            }
        }

        store.setAccountInfos(allAccountInfos);

        store.addLog({
            agent: "orchestrator",
            level: "info",
            message: `Account info refreshed: ${allAccountInfos.length} accounts (${failedCount} failed)`,
        });

        return {
            status:
                failedCount === 0
                    ? "completed"
                    : failedCount === accounts.length
                      ? "failed"
                      : "partial",
            summary: {
                accountsQueried: accounts.length,
                accountsRefreshed: allAccountInfos.length,
                accountsFailed: failedCount,
            },
        };
    }

    private async _detectUnusedQuota(): Promise<AgentResult> {
        const { store } = this._ctx;
        const accountInfos = store.getState().accountInfos;

        const GPU_VMS = [
            { name: "Standard_NC6s_v3", vCPUs: 6 },
            { name: "Standard_NC24s_v3", vCPUs: 24 },
            { name: "Standard_NC4as_T4_v3", vCPUs: 4 },
            { name: "Standard_NC16as_T4_v3", vCPUs: 16 },
            { name: "Standard_ND96amsr_A100_v4", vCPUs: 96 },
            { name: "Standard_NV36ads_A10_v5", vCPUs: 36 },
            { name: "Standard_ND40rs_v2", vCPUs: 40 },
        ];

        const accountsWithFreeQuota = accountInfos.filter(
            (a) => a.lowPriorityCoresFree > 0 || a.dedicatedCoresFree > 0
        );

        const suggestions: QuotaSuggestion[] = [];

        for (const account of accountsWithFreeQuota) {
            for (const vm of GPU_VMS) {
                const maxLpNodes =
                    account.lowPriorityCoresFree > 0
                        ? Math.floor(account.lowPriorityCoresFree / vm.vCPUs)
                        : 0;
                const maxDedicatedNodes =
                    account.dedicatedCoresFree > 0
                        ? Math.floor(account.dedicatedCoresFree / vm.vCPUs)
                        : 0;

                if (maxLpNodes >= 1 || maxDedicatedNodes >= 1) {
                    suggestions.push({
                        accountId: account.id,
                        accountName: account.accountName,
                        region: account.region,
                        freeLpCores: account.lowPriorityCoresFree,
                        freeDedicatedCores: account.dedicatedCoresFree,
                        vmSize: vm.name,
                        vmSizeVCpus: vm.vCPUs,
                        maxLpNodes,
                        maxDedicatedNodes,
                    });
                }
            }
        }

        store.addLog({
            agent: "orchestrator",
            level: "info",
            message: `Detected ${suggestions.length} quota suggestions across ${accountsWithFreeQuota.length} accounts with free quota`,
        });

        return {
            status: "completed",
            summary: {
                accountsWithFreeQuota: accountsWithFreeQuota.length,
                totalSuggestions: suggestions.length,
                totalFreeLpCores: accountsWithFreeQuota.reduce(
                    (s, a) => s + a.lowPriorityCoresFree,
                    0
                ),
                totalFreeDedicatedCores: accountsWithFreeQuota.reduce(
                    (s, a) => s + a.dedicatedCoresFree,
                    0
                ),
                suggestions,
            },
        };
    }

    private async _autoCreatePoolsFromQuota(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        const { store, getBatchAccessToken } = this._ctx;
        const suggestions = payload.suggestions as QuotaSuggestion[];

        if (!suggestions || suggestions.length === 0) {
            return {
                status: "completed",
                summary: {
                    created: 0,
                    failed: 0,
                    message: "No suggestions provided",
                },
            };
        }

        store.addLog({
            agent: "orchestrator",
            level: "info",
            message: `Auto-creating pools from ${suggestions.length} quota suggestions`,
        });

        let created = 0;
        let failed = 0;

        for (const suggestion of suggestions) {
            try {
                const token = await getBatchAccessToken();
                const vmSizeShort = suggestion.vmSize
                    .replace(/^Standard_/i, "")
                    .replace(/_/g, "")
                    .toLowerCase();
                const random4 = Math.random().toString(36).substring(2, 6);
                const poolId = `auto-${vmSizeShort}-${random4}`;

                const account = store
                    .getState()
                    .accounts.find((a) => a.id === suggestion.accountId);
                if (!account) {
                    throw new Error(
                        `Account ${suggestion.accountId} not found`
                    );
                }

                const useLp = suggestion.maxLpNodes >= 1;
                const poolBody: Record<string, unknown> = {
                    id: poolId,
                    vmSize: suggestion.vmSize,
                    targetDedicatedNodes: useLp
                        ? 0
                        : suggestion.maxDedicatedNodes,
                    targetLowPriorityNodes: useLp ? suggestion.maxLpNodes : 0,
                    virtualMachineConfiguration: {
                        imageReference: {
                            publisher: "microsoft-azure-batch",
                            offer: "ubuntu-server-container",
                            sku: "20-04-lts",
                            version: "latest",
                        },
                        nodeAgentSKUId: "batch.node.ubuntu 20.04",
                    },
                    taskSlotsPerNode: suggestion.vmSizeVCpus,
                };

                const url = `https://${account.accountName}.${account.region}.batch.azure.com/pools?api-version=2024-07-01.20.0`;
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type":
                            "application/json; odata=minimalmetadata",
                    },
                    body: JSON.stringify(poolBody),
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(
                        err?.error?.message ??
                            `Pool creation failed: ${response.status}`
                    );
                }

                store.addLog({
                    agent: "orchestrator",
                    level: "info",
                    message: `Created pool ${poolId} in ${account.accountName} (${suggestion.vmSize}, ${useLp ? suggestion.maxLpNodes + " LP" : suggestion.maxDedicatedNodes + " dedicated"} nodes)`,
                });
                created++;
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.addLog({
                    agent: "orchestrator",
                    level: "error",
                    message: `Failed to create pool for ${suggestion.accountName}: ${errorMsg}`,
                });
                failed++;
            }
        }

        store.addNotification({
            type: failed === 0 ? "success" : "warning",
            message: `Auto-created ${created} pools (${failed} failed)`,
        });

        return {
            status:
                failed === 0
                    ? "completed"
                    : created === 0
                      ? "failed"
                      : "partial",
            summary: { created, failed, total: suggestions.length },
        };
    }

    private async _deleteNodes(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        const { store, getBatchAccessToken } = this._ctx;
        const nodeIds = payload.nodeIds as string[];

        store.setAgentStatus("node", "running");
        store.addLog({
            agent: "node",
            level: "info",
            message: `Deleting ${nodeIds.length} nodes (grouped by pool)`,
        });

        const state = store.getState();
        const groups = new Map<
            string,
            {
                accountName: string;
                region: string;
                poolId: string;
                nodeIds: string[];
                internalIds: string[];
            }
        >();
        for (const internalId of nodeIds) {
            const node = state.nodes.find((n) => n.id === internalId);
            if (!node) continue;
            const key = `${node.accountId}||${node.poolId}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    accountName: node.accountName,
                    region: node.region,
                    poolId: node.poolId,
                    nodeIds: [],
                    internalIds: [],
                });
            }
            groups.get(key)!.nodeIds.push(node.nodeId);
            groups.get(key)!.internalIds.push(internalId);
        }

        let succeeded = 0;
        let failed = 0;

        for (const [, group] of groups) {
            try {
                const token = await getBatchAccessToken();
                const url = `https://${group.accountName}.${group.region}.batch.azure.com/pools/${group.poolId}/removenodes?api-version=2024-07-01.20.0`;
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type":
                            "application/json; odata=minimalmetadata",
                    },
                    body: JSON.stringify({
                        nodeList: group.nodeIds,
                        nodeDeallocationOption: "requeue",
                    }),
                });

                if (!response.ok && response.status !== 202) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(
                        err?.error?.message ??
                            `Remove nodes failed: ${response.status}`
                    );
                }

                for (const internalId of group.internalIds) {
                    store.removeNode(internalId);
                }
                succeeded += group.nodeIds.length;

                store.addLog({
                    agent: "node",
                    level: "info",
                    message: `Removed ${group.nodeIds.length} nodes from pool ${group.poolId} in ${group.accountName}`,
                });
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.addLog({
                    agent: "node",
                    level: "error",
                    message: `Failed to remove nodes from pool ${group.poolId} in ${group.accountName}: ${errorMsg}`,
                });
                failed += group.nodeIds.length;
            }
        }

        store.setAgentStatus("node", failed > 0 ? "error" : "completed");
        store.addNotification({
            type: failed === 0 ? "success" : "warning",
            message: `Deleted ${succeeded} node(s), ${failed} failed`,
        });

        return {
            status:
                failed === 0
                    ? "completed"
                    : succeeded === 0
                      ? "failed"
                      : "partial",
            summary: { total: nodeIds.length, succeeded, failed },
        };
    }

    private async _recreateNodes(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        const { store, getBatchAccessToken } = this._ctx;
        const nodeIds = payload.nodeIds as string[];

        store.setAgentStatus("node", "running");
        store.addLog({
            agent: "node",
            level: "info",
            message: `Recreating ${nodeIds.length} nodes (remove then restore pool targets)`,
        });

        const state = store.getState();
        const groups = new Map<
            string,
            {
                accountId: string;
                accountName: string;
                region: string;
                poolId: string;
                nodeIds: string[];
                internalIds: string[];
            }
        >();
        for (const internalId of nodeIds) {
            const node = state.nodes.find((n) => n.id === internalId);
            if (!node) continue;
            const key = `${node.accountId}||${node.poolId}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    accountId: node.accountId,
                    accountName: node.accountName,
                    region: node.region,
                    poolId: node.poolId,
                    nodeIds: [],
                    internalIds: [],
                });
            }
            groups.get(key)!.nodeIds.push(node.nodeId);
            groups.get(key)!.internalIds.push(internalId);
        }

        let succeeded = 0;
        let failed = 0;

        for (const [, group] of groups) {
            try {
                const token = await getBatchAccessToken();
                const baseUrl = `https://${group.accountName}.${group.region}.batch.azure.com`;

                const poolInfoUrl = `${baseUrl}/pools/${group.poolId}?api-version=2024-07-01.20.0`;
                const poolRes = await fetch(poolInfoUrl, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!poolRes.ok) {
                    throw new Error(
                        `Failed to get pool info: ${poolRes.status}`
                    );
                }
                const poolData = await poolRes.json();
                const originalTargetDedicated =
                    poolData.targetDedicatedNodes ?? 0;
                const originalTargetLowPriority =
                    poolData.targetLowPriorityNodes ?? 0;

                const removeUrl = `${baseUrl}/pools/${group.poolId}/removenodes?api-version=2024-07-01.20.0`;
                const removeRes = await fetch(removeUrl, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type":
                            "application/json; odata=minimalmetadata",
                    },
                    body: JSON.stringify({
                        nodeList: group.nodeIds,
                        nodeDeallocationOption: "requeue",
                    }),
                });

                if (!removeRes.ok && removeRes.status !== 202) {
                    const err = await removeRes.json().catch(() => ({}));
                    throw new Error(
                        err?.error?.message ??
                            `Remove nodes failed: ${removeRes.status}`
                    );
                }

                const patchUrl = `${baseUrl}/pools/${group.poolId}?api-version=2024-07-01.20.0`;
                const patchRes = await fetch(patchUrl, {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type":
                            "application/json; odata=minimalmetadata",
                    },
                    body: JSON.stringify({
                        targetDedicatedNodes: originalTargetDedicated,
                        targetLowPriorityNodes: originalTargetLowPriority,
                    }),
                });

                if (!patchRes.ok && patchRes.status !== 200) {
                    store.addLog({
                        agent: "node",
                        level: "warn",
                        message: `Nodes removed but failed to restore pool targets for ${group.poolId}: ${patchRes.status}`,
                    });
                }

                for (const internalId of group.internalIds) {
                    store.removeNode(internalId);
                }
                succeeded += group.nodeIds.length;

                store.addLog({
                    agent: "node",
                    level: "info",
                    message: `Recreating ${group.nodeIds.length} nodes in pool ${group.poolId} (targets restored: dedicated=${originalTargetDedicated}, lowPriority=${originalTargetLowPriority})`,
                });
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.addLog({
                    agent: "node",
                    level: "error",
                    message: `Failed to recreate nodes in pool ${group.poolId}: ${errorMsg}`,
                });
                failed += group.nodeIds.length;
            }
        }

        store.setAgentStatus("node", failed > 0 ? "error" : "completed");
        store.addNotification({
            type: failed === 0 ? "success" : "warning",
            message: `Recreating ${succeeded} node(s), ${failed} failed`,
        });

        return {
            status:
                failed === 0
                    ? "completed"
                    : succeeded === 0
                      ? "failed"
                      : "partial",
            summary: { total: nodeIds.length, succeeded, failed },
        };
    }

    private async _recoverPreempted(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        const { store, getBatchAccessToken } = this._ctx;
        const nodeIds = (payload.nodeIds as string[] | undefined) ?? [];

        store.setAgentStatus("node", "running");

        const state = store.getState();

        const preemptedNodes =
            nodeIds.length > 0
                ? state.nodes.filter(
                      (n) => nodeIds.includes(n.id) && n.state === "preempted"
                  )
                : state.nodes.filter((n) => n.state === "preempted");

        if (preemptedNodes.length === 0) {
            store.setAgentStatus("node", "completed");
            store.addLog({
                agent: "node",
                level: "info",
                message: "No preempted nodes found to recover",
            });
            return { status: "completed", summary: { total: 0, recovered: 0 } };
        }

        store.addLog({
            agent: "node",
            level: "info",
            message: `Recovering ${preemptedNodes.length} preempted nodes across pools`,
        });

        const poolGroups = new Map<
            string,
            {
                accountName: string;
                region: string;
                poolId: string;
                count: number;
            }
        >();
        for (const node of preemptedNodes) {
            const key = `${node.accountId}||${node.poolId}`;
            if (!poolGroups.has(key)) {
                poolGroups.set(key, {
                    accountName: node.accountName,
                    region: node.region,
                    poolId: node.poolId,
                    count: 0,
                });
            }
            poolGroups.get(key)!.count++;
        }

        let succeeded = 0;
        let failed = 0;

        for (const [, group] of poolGroups) {
            try {
                const token = await getBatchAccessToken();
                const baseUrl = `https://${group.accountName}.${group.region}.batch.azure.com`;

                const poolUrl = `${baseUrl}/pools/${group.poolId}?api-version=2024-07-01.20.0`;
                const poolRes = await fetch(poolUrl, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!poolRes.ok) {
                    throw new Error(
                        `Failed to get pool info: ${poolRes.status}`
                    );
                }
                const poolData = await poolRes.json();
                const targetLowPriority = poolData.targetLowPriorityNodes ?? 0;

                const patchUrl = `${baseUrl}/pools/${group.poolId}?api-version=2024-07-01.20.0`;
                const patchRes = await fetch(patchUrl, {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type":
                            "application/json; odata=minimalmetadata",
                    },
                    body: JSON.stringify({
                        targetLowPriorityNodes: targetLowPriority,
                    }),
                });

                if (!patchRes.ok && patchRes.status !== 200) {
                    const err = await patchRes.json().catch(() => ({}));
                    throw new Error(
                        err?.error?.message ??
                            `Pool resize failed: ${patchRes.status}`
                    );
                }

                succeeded += group.count;
                store.addLog({
                    agent: "node",
                    level: "info",
                    message: `Recovery triggered for pool ${group.poolId} in ${group.accountName} (targetLowPriority=${targetLowPriority}, ${group.count} preempted nodes)`,
                });
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.addLog({
                    agent: "node",
                    level: "error",
                    message: `Failed to recover preempted nodes in pool ${group.poolId}: ${errorMsg}`,
                });
                failed += group.count;
            }
        }

        store.setAgentStatus("node", failed > 0 ? "error" : "completed");
        store.addNotification({
            type: failed === 0 ? "success" : "warning",
            message: `Preempted recovery: ${succeeded} nodes in ${poolGroups.size} pools, ${failed} failed`,
        });

        return {
            status:
                failed === 0
                    ? "completed"
                    : succeeded === 0
                      ? "failed"
                      : "partial",
            summary: {
                total: preemptedNodes.length,
                succeeded,
                failed,
                poolsAffected: poolGroups.size,
            },
        };
    }

    private _validatePrecondition(action: string, check: () => void): void {
        try {
            check();
        } catch (error: any) {
            this._ctx.store.addLog({
                agent: "orchestrator",
                level: "error",
                message: `Precondition failed for ${action}: ${error.message}`,
            });
            throw error;
        }
    }

    // Expose child agents for direct access from UI
    get provisioner(): ProvisionerAgent {
        return this._provisioner;
    }
    get quota(): QuotaAgent {
        return this._quota;
    }
    get monitor(): MonitorAgent {
        return this._monitor;
    }
    get filter(): FilterAgent {
        return this._filter;
    }
    get pool(): PoolAgent {
        return this._pool;
    }
    get node(): NodeAgent {
        return this._node;
    }

    private async _resizePool(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        const { store, getBatchAccessToken } = this._ctx;
        const account = store
            .getState()
            .accounts.find((a) => a.id === payload.accountId);
        if (!account) {
            throw new Error(`Account not found: ${payload.accountId}`);
        }

        const token = await getBatchAccessToken();
        const url = `https://${account.accountName}.${account.region}.batch.azure.com/pools/${payload.poolId}?api-version=2024-07-01.20.0`;

        const body: Record<string, unknown> = {};
        if (payload.targetDedicatedNodes !== undefined) {
            body.targetDedicatedNodes = payload.targetDedicatedNodes;
        }
        if (payload.targetLowPriorityNodes !== undefined) {
            body.targetLowPriorityNodes = payload.targetLowPriorityNodes;
        }

        const response = await fetch(url, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json; odata=minimalmetadata",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(
                err?.error?.message ?? `Resize pool failed: ${response.status}`
            );
        }

        store.addNotification({
            type: "success",
            message: `Pool ${payload.poolId} resize requested successfully`,
        });

        return {
            status: "completed",
            summary: {
                poolId: payload.poolId,
                accountId: payload.accountId,
                targetDedicatedNodes: payload.targetDedicatedNodes,
                targetLowPriorityNodes: payload.targetLowPriorityNodes,
            },
        };
    }

    private async _updateStartTask(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        const { store, getBatchAccessToken } = this._ctx;
        const account = store
            .getState()
            .accounts.find((a) => a.id === payload.accountId);
        if (!account) {
            throw new Error(`Account not found: ${payload.accountId}`);
        }

        const token = await getBatchAccessToken();
        const url = `https://${account.accountName}.${account.region}.batch.azure.com/pools/${payload.poolId}?api-version=2024-07-01.20.0`;

        const response = await fetch(url, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json; odata=minimalmetadata",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                startTask: payload.startTask,
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(
                err?.error?.message ??
                    `Update start task failed: ${response.status}`
            );
        }

        store.addNotification({
            type: "success",
            message: `Pool ${payload.poolId} start task updated successfully`,
        });

        return {
            status: "completed",
            summary: {
                poolId: payload.poolId,
                accountId: payload.accountId,
            },
        };
    }
}
