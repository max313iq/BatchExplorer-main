import { HttpParams } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { HttpCode } from "@batch-flask/core";
import { log } from "@batch-flask/utils";
import { ArmBatchAccount, BatchAccount, PoolAllocationState } from "app/models";
import { AzureBatchHttpService, BatchListResponse } from "app/services/azure-batch/core";
import { ArmBatchAccountService, BatchAccountService, LocalBatchAccountService } from "app/services/batch-account";
import { SubscriptionService } from "app/services/subscription";
import { from, Observable, of } from "rxjs";
import { catchError, concatMap, expand, map, reduce, switchMap, take } from "rxjs/operators";
import { WorkbenchAccountRef, WorkbenchPoolRow } from "./workbench-types";

export type WorkbenchErrorClass = "quota" | "transient" | "fatal";

export interface WorkbenchNodeCountsByState {
    [state: string]: number;
    creating: number;
    idle: number;
    leavingPool: number;
    offline: number;
    preempted: number;
    rebooting: number;
    reimaging: number;
    running: number;
    startTaskFailed: number;
    starting: number;
    total: number;
    unknown: number;
    unusable: number;
    waitingForStartTask: number;
}

export interface WorkbenchClassifiedError {
    category: WorkbenchErrorClass;
    message: string;
    status?: number;
}

interface BatchPoolSummary {
    id: string;
    allocationState?: string;
}

interface BatchPoolNodeCounts {
    poolId: string;
    dedicated: WorkbenchNodeCountsByState;
    lowPriority: WorkbenchNodeCountsByState;
}

interface QuotaStatus {
    used: number;
    quota: number;
}

@Injectable({ providedIn: "root" })
export class WorkbenchDiscoveryService {
    constructor(
        private subscriptionService: SubscriptionService,
        private batchAccountService: BatchAccountService,
        private armBatchAccountService: ArmBatchAccountService,
        private localBatchAccountService: LocalBatchAccountService,
        private batchHttp: AzureBatchHttpService,
    ) {
    }

    public listAccounts(): Observable<WorkbenchAccountRef[]> {
        return this._loadAccounts().pipe(
            map((accounts) => {
                return accounts.map((account) => this._toAccountRef(account))
                    .sort((left, right) => left.accountName.localeCompare(right.accountName));
            }),
        );
    }

    public listPools(accountRef: WorkbenchAccountRef): Observable<WorkbenchPoolRow[]> {
        return this._resolveAccount(accountRef).pipe(
            switchMap((account) => this._listPoolsForAccount(account)),
            catchError((error) => {
                const classified = this.classifyError(error);
                log.error(
                    `[WorkbenchDiscovery] listPools failed for ${accountRef.accountId}: ${classified.category} - ${classified.message}`,
                    error,
                );
                return of([]);
            }),
        );
    }

    public getPoolNodeCounts(accountRef: WorkbenchAccountRef, poolId: string): Observable<WorkbenchNodeCountsByState> {
        return this._resolveAccount(accountRef).pipe(
            switchMap((account) => this._getAllPoolNodeCounts(account)),
            map((countsByPool) => {
                return countsByPool.get(poolId) || this._emptyNodeCounts();
            }),
            catchError((error) => {
                const classified = this.classifyError(error);
                log.error(
                    `[WorkbenchDiscovery] getPoolNodeCounts failed for ${accountRef.accountId}/${poolId}: ${classified.category} - ${classified.message}`,
                    error,
                );
                return of(this._emptyNodeCounts());
            }),
        );
    }

    public classifyError(error: any): WorkbenchClassifiedError {
        const status = Number(error && error.status);
        const lowerCode = ((error && (error.code || (error.body && error.body.code))) || "").toString().toLowerCase();
        const lowerMessage = ((error && error.message) || "").toString().toLowerCase();

        if (lowerCode.includes("quota") || lowerMessage.includes("quota")) {
            return { category: "quota", message: error && error.message || "Quota error", status: status || undefined };
        }

        if (status === 409 || status === 429 || status === HttpCode.RequestTimeout || status >= 500) {
            return { category: "transient", message: error && error.message || "Transient error", status: status || undefined };
        }

        return { category: "fatal", message: error && error.message || "Fatal error", status: status || undefined };
    }

    private _listPoolsForAccount(account: BatchAccount): Observable<WorkbenchPoolRow[]> {
        return this._listPoolSummaries(account).pipe(
            switchMap((poolSummaries) => {
                return this._getAllPoolNodeCounts(account).pipe(
                    switchMap((countsByPool) => {
                        return this._getQuotaStatus(account).pipe(
                            map((quota) => {
                                return poolSummaries.map((pool) => {
                                    const nodeCounts = countsByPool.get(pool.id) || this._emptyNodeCounts();
                                    return {
                                        subscriptionId: account instanceof ArmBatchAccount
                                            ? account.subscriptionId || "unknown-subscription"
                                            : "local",
                                        accountId: account.id,
                                        accountName: account.displayName || account.name,
                                        location: account instanceof ArmBatchAccount
                                            ? account.location || "unknown-region"
                                            : "local",
                                        poolId: pool.id,
                                        allocationState: pool.allocationState || "unknown",
                                        nodeCountsByState: nodeCounts,
                                        alerts: this._buildAlerts(pool, nodeCounts, quota),
                                    };
                                });
                            }),
                        );
                    }),
                );
            }),
        );
    }

    private _listPoolSummaries(account: BatchAccount): Observable<BatchPoolSummary[]> {
        const params = new HttpParams()
            .set("$select", "id,allocationState")
            .set("maxresults", "200");

        return this.batchHttp.requestForAccount(
            account,
            "GET",
            "/pools",
            { params },
        ).pipe(
            expand((response: BatchListResponse<BatchPoolSummary>) => {
                return response && response["odata.nextLink"]
                    ? this.batchHttp.requestForAccount(account, "GET", response["odata.nextLink"])
                    : of(null);
            }),
            reduce((allPools: BatchPoolSummary[], response: BatchListResponse<BatchPoolSummary>) => {
                if (!response || !Array.isArray(response.value)) {
                    return allPools;
                }
                return [...allPools, ...response.value];
            }, []),
        );
    }

    private _getAllPoolNodeCounts(account: BatchAccount): Observable<Map<string, WorkbenchNodeCountsByState>> {
        return this.batchHttp.requestForAccount(
            account,
            "GET",
            "/nodecounts",
            { params: new HttpParams().set("maxresults", "200") },
        ).pipe(
            expand((response) => {
                return response && response["odata.nextLink"]
                    ? this.batchHttp.requestForAccount(account, "GET", response["odata.nextLink"])
                    : of(null);
            }),
            reduce((allItems: BatchPoolNodeCounts[], response: BatchListResponse<BatchPoolNodeCounts>) => {
                if (!response || !Array.isArray(response.value)) {
                    return allItems;
                }
                return [...allItems, ...response.value];
            }, []),
            map((items) => {
                const countsByPool = new Map<string, WorkbenchNodeCountsByState>();
                for (const item of items) {
                    countsByPool.set(item.poolId, this._mergeDedicatedAndLowPriorityCounts(item));
                }
                return countsByPool;
            }),
            catchError((error) => {
                const classified = this.classifyError(error);
                log.error(
                    `[WorkbenchDiscovery] getAllPoolNodeCounts failed for ${account.id}: ${classified.category} - ${classified.message}`,
                    error,
                );
                return of(new Map<string, WorkbenchNodeCountsByState>());
            }),
        );
    }

    private _loadAccounts(): Observable<BatchAccount[]> {
        return this.subscriptionService.load().pipe(
            switchMap(() => this.subscriptionService.subscriptions.pipe(take(1))),
            switchMap((subscriptions) => {
                return from(subscriptions.toArray()).pipe(
                    concatMap((subscription) => {
                        return this.armBatchAccountService.list(subscription.subscriptionId).pipe(
                            map((accounts) => accounts.toArray()),
                            catchError((error) => {
                                const classified = this.classifyError(error);
                                log.error(
                                    `[WorkbenchDiscovery] list ARM accounts failed for ${subscription.subscriptionId}: ${classified.category} - ${classified.message}`,
                                    error,
                                );
                                return of([]);
                            }),
                        );
                    }),
                    reduce((allAccounts, accounts) => {
                        return [...allAccounts, ...accounts];
                    }, [] as ArmBatchAccount[]),
                );
            }),
            switchMap((armAccounts) => {
                return this.localBatchAccountService.load().pipe(
                    switchMap(() => this.localBatchAccountService.accounts.pipe(take(1))),
                    map((localAccounts) => {
                        return [...armAccounts, ...localAccounts.toArray()];
                    }),
                    catchError((error) => {
                        const classified = this.classifyError(error);
                        log.error(
                            `[WorkbenchDiscovery] loading local accounts failed: ${classified.category} - ${classified.message}`,
                            error,
                        );
                        return of(armAccounts);
                    }),
                );
            }),
            catchError((error) => {
                const classified = this.classifyError(error);
                log.error(
                    `[WorkbenchDiscovery] loading accounts failed: ${classified.category} - ${classified.message}`,
                    error,
                );
                return of([]);
            }),
        );
    }

    private _resolveAccount(accountRef: WorkbenchAccountRef): Observable<BatchAccount> {
        return this.batchAccountService.get(accountRef.accountId).pipe(
            map((account) => {
                if (!account) {
                    throw new Error(`Batch account ${accountRef.accountId} not found`);
                }
                return account;
            }),
        );
    }

    private _getQuotaStatus(account: BatchAccount): Observable<QuotaStatus | null> {
        if (!(account instanceof ArmBatchAccount) || !account.subscription || !account.location) {
            return of(null);
        }
        return this.armBatchAccountService.accountQuota(account.subscription, account.location).pipe(
            map((quota) => {
                if (!quota) {
                    return null;
                }
                return {
                    used: quota.used,
                    quota: quota.quota,
                };
            }),
            catchError((error) => {
                const classified = this.classifyError(error);
                log.warn(`[WorkbenchDiscovery] quota lookup failed for ${account.id}`, classified);
                return of(null);
            }),
        );
    }

    private _toAccountRef(account: BatchAccount): WorkbenchAccountRef {
        return {
            subscriptionId: account instanceof ArmBatchAccount
                ? account.subscriptionId || "unknown-subscription"
                : "local",
            accountId: account.id,
            accountName: account.displayName || account.name,
            location: account instanceof ArmBatchAccount
                ? account.location || "unknown-region"
                : "local",
            endpoint: account.url,
        };
    }

    private _mergeDedicatedAndLowPriorityCounts(item: BatchPoolNodeCounts): WorkbenchNodeCountsByState {
        const dedicated = item && item.dedicated || this._emptyNodeCounts();
        const lowPriority = item && item.lowPriority || this._emptyNodeCounts();
        return {
            creating: dedicated.creating + lowPriority.creating,
            idle: dedicated.idle + lowPriority.idle,
            leavingPool: dedicated.leavingPool + lowPriority.leavingPool,
            offline: dedicated.offline + lowPriority.offline,
            preempted: dedicated.preempted + lowPriority.preempted,
            rebooting: dedicated.rebooting + lowPriority.rebooting,
            reimaging: dedicated.reimaging + lowPriority.reimaging,
            running: dedicated.running + lowPriority.running,
            startTaskFailed: dedicated.startTaskFailed + lowPriority.startTaskFailed,
            starting: dedicated.starting + lowPriority.starting,
            total: dedicated.total + lowPriority.total,
            unknown: dedicated.unknown + lowPriority.unknown,
            unusable: dedicated.unusable + lowPriority.unusable,
            waitingForStartTask: dedicated.waitingForStartTask + lowPriority.waitingForStartTask,
        };
    }

    private _buildAlerts(
        pool: BatchPoolSummary,
        nodeCounts: WorkbenchNodeCountsByState,
        quota: QuotaStatus | null): string[] {
        const alerts: string[] = [];

        if (pool.allocationState === PoolAllocationState.resizing || pool.allocationState === PoolAllocationState.stopping) {
            alerts.push("Pool allocation is not steady");
        }
        if (nodeCounts.startTaskFailed > 0) {
            alerts.push("Nodes with startTaskFailed state");
        }
        if (nodeCounts.unusable > 0 || nodeCounts.unknown > 0) {
            alerts.push("Nodes with unusable or unknown state");
        }
        if (quota && quota.quota >= 0 && quota.used >= quota.quota) {
            alerts.push("Batch account quota reached");
        }
        return alerts;
    }

    private _emptyNodeCounts(): WorkbenchNodeCountsByState {
        return {
            creating: 0,
            idle: 0,
            leavingPool: 0,
            offline: 0,
            preempted: 0,
            rebooting: 0,
            reimaging: 0,
            running: 0,
            startTaskFailed: 0,
            starting: 0,
            total: 0,
            unknown: 0,
            unusable: 0,
            waitingForStartTask: 0,
        };
    }
}
