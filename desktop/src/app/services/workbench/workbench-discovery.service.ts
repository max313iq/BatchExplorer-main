import { HttpParams } from "@angular/common/http";
import { Injectable, Optional } from "@angular/core";
import { HttpCode } from "@batch-flask/core";
import { log } from "@batch-flask/utils";
import { ArmBatchAccount, BatchAccount, PoolAllocationState } from "app/models";
import { AzureBatchHttpService, BatchListResponse } from "app/services/azure-batch/core";
import { ArmBatchAccountService, BatchAccountService, LocalBatchAccountService } from "app/services/batch-account";
import { SubscriptionService } from "app/services/subscription";
import { EMPTY, from, Observable, of } from "rxjs";
import { catchError, concatMap, expand, map, reduce, switchMap, take, timeout } from "rxjs/operators";
import { RequestScheduler } from "./request-scheduler";
import { WorkbenchAccountRef, WorkbenchPoolRow, WorkbenchQuotaStatus } from "./workbench-types";

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

@Injectable({ providedIn: "root" })
export class WorkbenchDiscoveryService {
    private scheduler: RequestScheduler;

    constructor(
        private subscriptionService: SubscriptionService,
        private batchAccountService: BatchAccountService,
        private armBatchAccountService: ArmBatchAccountService,
        private localBatchAccountService: LocalBatchAccountService,
        private batchHttp: AzureBatchHttpService,
        @Optional() scheduler?: RequestScheduler,
    ) {
        this.scheduler = scheduler || new RequestScheduler();
    }

    public listAccounts(): Observable<WorkbenchAccountRef[]> {
        return this._loadAccounts().pipe(
            take(1),
            timeout(60_000),
            map((accounts) => {
                return accounts.map((account) => this._toAccountRef(account))
                    .sort((left, right) => left.accountName.localeCompare(right.accountName));
            }),
            catchError((error) => {
                const classified = this.classifyError(error);
                log.error(
                    `[WorkbenchDiscovery] listAccounts failed: ${classified.category} - ${classified.message}`,
                    error,
                );
                return of([]);
            }),
        );
    }

    public listPools(accountRef: WorkbenchAccountRef): Observable<WorkbenchPoolRow[]> {
        return this._resolveAccount(accountRef).pipe(
            switchMap((account) => this._listPoolsForAccount(account)),
            take(1),
            timeout(30_000),
            catchError((error) => {
                const classified = this.classifyError(error);
                log.warn(
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
                    map((countsByPool) => {
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
                                quotaStatus: this._unknownQuotaStatus(),
                                alerts: this._buildAlerts(pool, nodeCounts),
                            };
                        });
                    }),
                );
            }),
        );
    }

    private _listPoolSummaries(account: BatchAccount): Observable<BatchPoolSummary[]> {
        const params = new HttpParams()
            .set("$select", "id,allocationState")
            .set("maxresults", "200");

        return this._requestForAccountScheduled<BatchListResponse<BatchPoolSummary>>(
            account,
            "GET",
            "/pools",
            { params },
        ).pipe(
            expand((response: BatchListResponse<BatchPoolSummary>) => {
                return response && response["odata.nextLink"]
                    ? this._requestForAccountScheduled(account, "GET", response["odata.nextLink"])
                    : EMPTY;
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
        return this._requestForAccountScheduled<BatchListResponse<BatchPoolNodeCounts>>(
            account,
            "GET",
            "/nodecounts",
            { params: new HttpParams().set("maxresults", "200") },
        ).pipe(
            expand((response) => {
                return response && response["odata.nextLink"]
                    ? this._requestForAccountScheduled(account, "GET", response["odata.nextLink"])
                    : EMPTY;
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
        return this._loadSubscriptionsScheduled().pipe(
            switchMap((subscriptions: any[]) => {
                return from(subscriptions).pipe(
                    concatMap((subscription) => {
                        return this._listArmAccountsScheduled(subscription.subscriptionId).pipe(
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
                return this._loadLocalAccountsScheduled().pipe(
                    map((localAccounts) => {
                        return this._dedupeAccounts([...armAccounts, ...localAccounts]);
                    }),
                    catchError((error) => {
                        const classified = this.classifyError(error);
                        log.error(
                            `[WorkbenchDiscovery] loading local accounts failed: ${classified.category} - ${classified.message}`,
                            error,
                        );
                        return of(this._dedupeAccounts(armAccounts));
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
        return this._schedule(
            `resolve-account:${accountRef.accountId}`,
            () => this.batchAccountService.get(accountRef.accountId).pipe(take(1)).toPromise(),
        ).pipe(
            map((account) => {
                if (!account) {
                    throw new Error(`Batch account ${accountRef.accountId} not found`);
                }
                return account;
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

    private _buildAlerts(pool: BatchPoolSummary, nodeCounts: WorkbenchNodeCountsByState): string[] {
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
        return alerts;
    }

    private _loadSubscriptionsScheduled(): Observable<any[]> {
        return this._schedule("load-subscriptions", async () => {
            await this.subscriptionService.load().pipe(take(1)).toPromise();
            const subscriptions = await this.subscriptionService.subscriptions.pipe(take(1)).toPromise();
            return subscriptions ? subscriptions.toArray() : [];
        });
    }

    private _loadLocalAccountsScheduled(): Observable<BatchAccount[]> {
        return this._schedule("load-local-accounts", async () => {
            await this.localBatchAccountService.load().pipe(take(1)).toPromise();
            const localAccounts = await this.localBatchAccountService.accounts.pipe(take(1)).toPromise();
            return localAccounts ? localAccounts.toArray() : [];
        });
    }

    private _listArmAccountsScheduled(subscriptionId: string): Observable<ArmBatchAccount[]> {
        return this._schedule(
            `list-arm-accounts:${subscriptionId}`,
            async () => {
                const accounts = await this.armBatchAccountService.list(subscriptionId)
                    .pipe(take(1))
                    .toPromise();
                return accounts ? accounts.toArray() : [];
            },
        );
    }

    private _requestForAccountScheduled<T>(account: BatchAccount, method: any, uri?: any, options?: any): Observable<T> {
        return this._schedule(
            this._accountScheduleKey(account),
            () => this.batchHttp.requestForAccount(account, method, uri, options).pipe(take(1)).toPromise(),
        );
    }

    private _dedupeAccounts(accounts: BatchAccount[]): BatchAccount[] {
        const byId = new Map<string, BatchAccount>();
        for (const account of accounts) {
            const id = (account && account.id ? account.id : "").toLowerCase();
            if (!id) {
                continue;
            }
            if (!byId.has(id)) {
                byId.set(id, account);
            }
        }
        return [...byId.values()];
    }

    private _unknownQuotaStatus(): WorkbenchQuotaStatus {
        return { state: "unknown" };
    }

    private _accountScheduleKey(account: BatchAccount): string {
        return `account:${account && account.id ? account.id : (account && account.url ? account.url : "unknown-account")}`;
    }

    private _schedule<T>(key: string, fn: () => Promise<T>): Observable<T> {
        return from(this.scheduler.run(key, fn));
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
