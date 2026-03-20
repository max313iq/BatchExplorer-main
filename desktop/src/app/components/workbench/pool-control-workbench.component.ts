import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from "@angular/core";
import { UserConfigurationService } from "@batch-flask/core";
import { ListSelection } from "@batch-flask/core/list";
import { TableConfig } from "@batch-flask/ui";
import { BatchAccount } from "app/models";
import { BatchAccountService } from "app/services/batch-account";
import {
    BatchPoolActionsService,
    StartTaskApplyProgress,
    StartTaskApplyRequest,
    StartTaskApplyService,
    StartTaskApplyTarget,
    WorkbenchDiscoveryService,
    WorkbenchPoolRow,
} from "app/services/workbench";
import { BEUserConfiguration } from "common";
import { Subject, Subscription, timer } from "rxjs";
import { takeUntil } from "rxjs/operators";
import { PoolDetailSummary } from "./pool-detail-panel.component";
import "./pool-control-workbench.scss";

interface WorkbenchPoolTableRow extends WorkbenchPoolRow {
    id: string;
}

@Component({
    selector: "bl-pool-control-workbench",
    templateUrl: "pool-control-workbench.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolControlWorkbenchComponent implements OnInit, OnDestroy {
    public static breadcrumb() {
        return { name: "Pool Control Workbench" };
    }

    public tableConfig: TableConfig = {
        id: "pool-control-workbench-table",
        showCheckbox: true,
        sorting: {
            subscriptionId: true,
            accountName: true,
            location: true,
            poolId: true,
            allocationState: true,
        },
    };

    public isFeatureEnabled = false;
    public isRefreshing = false;
    public refreshError: string | null = null;
    public statusMessage = "No data loaded.";
    public actionMessage: string | null = null;
    public actionError: string | null = null;
    public bulkSummary: string | null = null;
    public exportedJson: string | null = null;

    public selection = new ListSelection();
    public allRows: WorkbenchPoolTableRow[] = [];
    public displayedRows: WorkbenchPoolTableRow[] = [];
    public selectedAccount: BatchAccount | null = null;

    public subscriptionFilter = "";
    public accountFilter = "";
    public regionFilter = "";
    public searchFilter = "";
    public onlyAlerts = false;

    public subscriptionOptions: string[] = [];
    public accountOptions: string[] = [];
    public regionOptions: string[] = [];

    public autoRefreshEnabled = false;
    public autoRefreshIntervalSeconds = 30;

    public startTaskPreviewText: string | null = null;
    public startTaskProgress: StartTaskApplyProgress | null = null;
    public startTaskError: string | null = null;
    public startTaskRunning = false;

    private _autoRefreshSub: Subscription | null = null;
    private _startTaskSub: Subscription | null = null;
    private _destroy = new Subject<void>();
    private _busyRowIds = new Set<string>();
    private _accountCache = new Map<string, BatchAccount>();
    private _activeItem: WorkbenchPoolTableRow | null = null;

    constructor(
        private settingsService: UserConfigurationService<BEUserConfiguration>,
        private discoveryService: WorkbenchDiscoveryService,
        private batchAccountService: BatchAccountService,
        private poolActionsService: BatchPoolActionsService,
        private startTaskApplyService: StartTaskApplyService,
        private changeDetector: ChangeDetectorRef,
    ) {
    }

    public get activeItem(): WorkbenchPoolTableRow | null {
        return this._activeItem;
    }

    public set activeItem(value: WorkbenchPoolTableRow | null) {
        this._activeItem = value;
        void this._loadSelectedAccount();
    }

    public ngOnInit() {
        this.settingsService.watch("features").pipe(takeUntil(this._destroy)).subscribe((features: any) => {
            this.isFeatureEnabled = Boolean(features && features.poolControlWorkbench);
            this._configureAutoRefresh();
            if (this.isFeatureEnabled && this.displayedRows.length === 0) {
                this.refresh();
            }
            this.changeDetector.markForCheck();
        });

        this.settingsService.watch("poolControlWorkbench").pipe(takeUntil(this._destroy)).subscribe((settings: any) => {
            const refreshSettings = settings && settings.refresh ? settings.refresh : {};
            this.autoRefreshEnabled = Boolean(refreshSettings.autoRefreshEnabled);
            this.autoRefreshIntervalSeconds = this._safeIntervalSeconds(refreshSettings.autoRefreshIntervalSeconds);
            this._configureAutoRefresh();
            this.changeDetector.markForCheck();
        });
    }

    public ngOnDestroy() {
        if (this._autoRefreshSub) {
            this._autoRefreshSub.unsubscribe();
            this._autoRefreshSub = null;
        }
        if (this._startTaskSub) {
            this._startTaskSub.unsubscribe();
            this._startTaskSub = null;
        }
        this._destroy.next();
        this._destroy.complete();
    }

    public get selectedCount(): number {
        return this.selectedRows.length;
    }

    public get selectedRows(): WorkbenchPoolTableRow[] {
        if (this.selection.all) {
            return this.displayedRows;
        }
        return this.displayedRows.filter((row) => this.selection.keys.has(row.id));
    }

    public get currentTarget(): StartTaskApplyTarget | null {
        return this.activeItem ? this._toApplyTarget(this.activeItem) : null;
    }

    public get selectedTargets(): StartTaskApplyTarget[] {
        return this.selectedRows.map((row) => this._toApplyTarget(row));
    }

    public get allTargets(): StartTaskApplyTarget[] {
        return this.displayedRows.map((row) => this._toApplyTarget(row));
    }

    public get selectedSummary(): PoolDetailSummary | null {
        const row = this.activeItem;
        if (!row) {
            return null;
        }
        return {
            accountName: row.accountName,
            location: row.location,
            allocationState: row.allocationState,
            nodeCountsByState: row.nodeCountsByState,
            alerts: row.alerts,
        };
    }

    public onAutoRefreshChanged() {
        this._configureAutoRefresh();
    }

    public clearSelection() {
        this.selection.clear();
    }

    public isRowBusy(row: WorkbenchPoolTableRow): boolean {
        return this._busyRowIds.has(row.id);
    }

    public applyFilters() {
        const search = this.searchFilter.trim().toLowerCase();
        this.displayedRows = this.allRows.filter((row) => {
            if (this.subscriptionFilter && row.subscriptionId !== this.subscriptionFilter) {
                return false;
            }
            if (this.accountFilter && row.accountName !== this.accountFilter) {
                return false;
            }
            if (this.regionFilter && row.location !== this.regionFilter) {
                return false;
            }
            if (this.onlyAlerts && row.alerts.length === 0) {
                return false;
            }
            if (!search) {
                return true;
            }
            const haystack = `${row.poolId} ${row.accountName} ${row.location} ${row.subscriptionId}`.toLowerCase();
            return haystack.includes(search);
        });
        this.statusMessage = this.displayedRows.length === 0 ? "No pools match current filters." : "";
    }

    public async refresh() {
        if (this.isRefreshing || !this.isFeatureEnabled) {
            return;
        }

        this.isRefreshing = true;
        this.refreshError = null;
        this.statusMessage = "Refreshing pool inventory...";
        this.changeDetector.markForCheck();

        try {
            const accounts = await this.discoveryService.listAccounts().toPromise();
            const rows: WorkbenchPoolTableRow[] = [];
            for (const account of accounts || []) {
                const pools = await this.discoveryService.listPools(account).toPromise();
                for (const pool of pools || []) {
                    rows.push(this._normalizeRow(pool));
                }
            }

            this.allRows = rows;
            this._rebuildFilterOptions();
            this.applyFilters();
            this.statusMessage = rows.length === 0 ? "No pools were discovered." : "";
            this.selection.clear();
            this.bulkSummary = null;
            this.exportedJson = null;
        } catch (error) {
            this.refreshError = this._describeError(error);
            this.statusMessage = "Refresh failed.";
        } finally {
            this.isRefreshing = false;
            this.changeDetector.markForCheck();
        }
    }

    public async resizeRow(row: WorkbenchPoolTableRow) {
        const targetInput = window.prompt(`Target dedicated nodes for ${row.poolId}`, "0");
        if (targetInput == null) {
            return;
        }
        const target = Number(targetInput);
        if (!Number.isFinite(target) || target < 0) {
            this.actionError = "Invalid target node count.";
            return;
        }
        try {
            await this._runRowAction(row, `Resizing ${row.poolId}`, async (account) => {
                await this.poolActionsService.resizePool(account, row.poolId, Math.floor(target)).toPromise();
            });
        } catch {
            return;
        }
    }

    public async stopResizeRow(row: WorkbenchPoolTableRow) {
        try {
            await this._runRowAction(row, `Stopping resize for ${row.poolId}`, async (account) => {
                await this.poolActionsService.stopResize(account, row.poolId).toPromise();
            });
        } catch {
            return;
        }
    }

    public async deleteRow(row: WorkbenchPoolTableRow) {
        if (!window.confirm(`Delete pool ${row.poolId}? This action is destructive.`)) {
            return;
        }
        try {
            await this._runRowAction(row, `Deleting ${row.poolId}`, async (account) => {
                await this.poolActionsService.deletePool(account, row.poolId).toPromise();
            });
        } catch {
            return;
        }
        await this.refresh();
    }

    public async exportRow(row: WorkbenchPoolTableRow) {
        try {
            await this._runRowAction(row, `Exporting ${row.poolId}`, async (account) => {
                const result = await this.poolActionsService.exportPoolJson(account, row.poolId).toPromise();
                this.exportedJson = JSON.stringify(result, null, 2);
            });
        } catch {
            return;
        }
    }

    public async bulkResizeSelected() {
        if (this.selectedRows.length === 0) {
            return;
        }
        const targetInput = window.prompt("Target dedicated nodes for selected pools", "0");
        if (targetInput == null) {
            return;
        }
        const target = Number(targetInput);
        if (!Number.isFinite(target) || target < 0) {
            this.actionError = "Invalid target node count.";
            return;
        }

        let succeeded = 0;
        let failed = 0;
        for (const row of this.selectedRows) {
            try {
                await this._runRowAction(row, `Resizing ${row.poolId}`, async (account) => {
                    await this.poolActionsService.resizePool(account, row.poolId, Math.floor(target)).toPromise();
                });
                succeeded++;
            } catch {
                failed++;
            }
        }
        this.bulkSummary = `Bulk resize complete: ${succeeded} succeeded, ${failed} failed.`;
        this.changeDetector.markForCheck();
    }

    public async cleanupBootstrapPools() {
        const prefix = window.prompt("Delete pools with ID prefix", "bootstrap");
        if (!prefix) {
            return;
        }
        const targets = this.displayedRows.filter((row) => row.poolId.startsWith(prefix));
        if (targets.length === 0) {
            this.bulkSummary = `No pools found with prefix '${prefix}'.`;
            return;
        }
        if (!window.confirm(`Delete ${targets.length} pool(s) with prefix '${prefix}'?`)) {
            return;
        }

        let succeeded = 0;
        let failed = 0;
        for (const row of targets) {
            try {
                await this._runRowAction(row, `Deleting ${row.poolId}`, async (account) => {
                    await this.poolActionsService.deletePool(account, row.poolId).toPromise();
                });
                succeeded++;
            } catch {
                failed++;
            }
        }

        this.bulkSummary = `Cleanup complete: ${succeeded} deleted, ${failed} failed.`;
        await this.refresh();
    }

    public async exportSelectedAsJson() {
        if (this.selectedRows.length === 0) {
            return;
        }

        const bundle: any[] = [];
        for (const row of this.selectedRows) {
            try {
                const account = await this._resolveAccount(row.accountId);
                const payload = await this.poolActionsService.exportPoolJson(account, row.poolId).toPromise();
                bundle.push({
                    subscriptionId: row.subscriptionId,
                    accountName: row.accountName,
                    poolId: row.poolId,
                    payload,
                });
            } catch (error) {
                bundle.push({
                    subscriptionId: row.subscriptionId,
                    accountName: row.accountName,
                    poolId: row.poolId,
                    error: this._describeError(error),
                });
            }
        }
        this.exportedJson = JSON.stringify(bundle, null, 2);
    }

    public handleStartTaskPreview(request: StartTaskApplyRequest) {
        const preview = this.startTaskApplyService.preview(request);
        if (preview.validationErrors.length > 0) {
            this.startTaskPreviewText = `Invalid request:\n${preview.validationErrors.join("\n")}`;
            return;
        }
        this.startTaskPreviewText = `Scope: ${preview.scope}\nPools: ${preview.totalTargets}`;
    }

    public handleStartTaskApply(request: StartTaskApplyRequest) {
        if (this._startTaskSub) {
            this._startTaskSub.unsubscribe();
            this._startTaskSub = null;
        }

        this.startTaskError = null;
        this.startTaskRunning = true;
        this.startTaskProgress = null;
        this._startTaskSub = this.startTaskApplyService.applyStartTask(request).subscribe({
            next: (progress) => {
                this.startTaskProgress = progress;
                this.changeDetector.markForCheck();
            },
            error: (error) => {
                this.startTaskRunning = false;
                this.startTaskError = this._describeError(error);
                this.changeDetector.markForCheck();
            },
            complete: () => {
                this.startTaskRunning = false;
                this.changeDetector.markForCheck();
            },
        });
    }

    private _configureAutoRefresh() {
        if (this._autoRefreshSub) {
            this._autoRefreshSub.unsubscribe();
            this._autoRefreshSub = null;
        }

        if (!this.isFeatureEnabled || !this.autoRefreshEnabled) {
            return;
        }

        this._autoRefreshSub = timer(this.autoRefreshIntervalSeconds * 1000, this.autoRefreshIntervalSeconds * 1000)
            .pipe(takeUntil(this._destroy))
            .subscribe(() => {
                this.refresh();
            });
    }

    private _safeIntervalSeconds(value: any): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
    }

    private _rebuildFilterOptions() {
        this.subscriptionOptions = this._sortedUnique(this.allRows.map((x) => x.subscriptionId));
        this.accountOptions = this._sortedUnique(this.allRows.map((x) => x.accountName));
        this.regionOptions = this._sortedUnique(this.allRows.map((x) => x.location));
    }

    private _sortedUnique(values: string[]): string[] {
        return [...new Set(values.filter((x) => Boolean(x)))].sort((a, b) => a.localeCompare(b));
    }

    private _normalizeRow(row: WorkbenchPoolRow): WorkbenchPoolTableRow {
        const subscriptionId = row.subscriptionId || "unknown-subscription";
        const accountName = row.accountName || "unknown-account";
        const location = row.location || "unknown-region";
        const poolId = row.poolId || "unknown-pool";
        const accountId = row.accountId || "unknown-account-id";
        return {
            ...row,
            id: `${accountId}|${poolId}`,
            subscriptionId,
            accountId,
            accountName,
            location,
            poolId,
            allocationState: row.allocationState || "unknown",
            nodeCountsByState: {
                ...row.nodeCountsByState,
                idle: this._asNumber(row.nodeCountsByState && row.nodeCountsByState.idle),
                running: this._asNumber(row.nodeCountsByState && row.nodeCountsByState.running),
                starting: this._asNumber(row.nodeCountsByState && row.nodeCountsByState.starting),
                startTaskFailed: this._asNumber(row.nodeCountsByState && row.nodeCountsByState.startTaskFailed),
                unusable: this._asNumber(row.nodeCountsByState && row.nodeCountsByState.unusable),
            },
            alerts: Array.isArray(row.alerts) ? row.alerts : [],
        };
    }

    private _asNumber(value: any): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }

    private _toApplyTarget(row: WorkbenchPoolTableRow): StartTaskApplyTarget {
        return {
            subscriptionId: row.subscriptionId,
            accountId: row.accountId,
            accountName: row.accountName,
            location: row.location,
            poolId: row.poolId,
        };
    }

    private async _loadSelectedAccount() {
        if (!this.activeItem) {
            this.selectedAccount = null;
            this.changeDetector.markForCheck();
            return;
        }

        try {
            this.selectedAccount = await this._resolveAccount(this.activeItem.accountId);
            this.actionError = null;
        } catch (error) {
            this.selectedAccount = null;
            this.actionError = this._describeError(error);
        }
        this.changeDetector.markForCheck();
    }

    private async _runRowAction(
        row: WorkbenchPoolTableRow,
        message: string,
        callback: (account: BatchAccount) => Promise<void>,
    ): Promise<void> {
        this._busyRowIds.add(row.id);
        this.actionMessage = message;
        this.actionError = null;
        this.changeDetector.markForCheck();

        try {
            const account = await this._resolveAccount(row.accountId);
            await callback(account);
        } catch (error) {
            this.actionError = this._describeError(error);
            throw error;
        } finally {
            this._busyRowIds.delete(row.id);
            this.actionMessage = null;
            this.changeDetector.markForCheck();
        }
    }

    private async _resolveAccount(accountId: string): Promise<BatchAccount> {
        if (this._accountCache.has(accountId)) {
            return this._accountCache.get(accountId);
        }

        const account = await this.batchAccountService.get(accountId).toPromise();
        if (!account) {
            throw new Error(`Batch account '${accountId}' not found.`);
        }
        this._accountCache.set(accountId, account);
        return account;
    }

    private _describeError(error: any): string {
        if (!error) {
            return "Unknown error.";
        }
        if (typeof error === "string") {
            return error;
        }
        return error.message || error.statusText || error.code || "Unknown error.";
    }
}
