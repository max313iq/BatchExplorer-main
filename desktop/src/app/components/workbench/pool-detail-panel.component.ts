import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges,
} from "@angular/core";
import { Node } from "app/models";
import {
    BatchNodeActionsService,
    BulkNodeActionResult,
    DisableSchedulingOption,
    NodeActionResult,
    PoolConfigurationSummary,
} from "app/services/workbench/batch-node-actions.service";
import "./pool-detail-panel.scss";

export interface PoolDetailSummary {
    accountName?: string;
    location?: string;
    allocationState?: string;
    nodeCountsByState?: { [state: string]: number };
    alerts?: string[];
}

@Component({
    selector: "bl-pool-detail-panel",
    templateUrl: "pool-detail-panel.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolDetailPanelComponent implements OnChanges {
    @Input() public account: unknown;
    @Input() public poolId: string;
    @Input() public summary: PoolDetailSummary | null = null;

    @Output() public bulkActionCompleted = new EventEmitter<BulkNodeActionResult>();
    @Output() public nodeActionCompleted = new EventEmitter<NodeActionResult>();

    public activeTabIndex = 0;
    public loadingPoolConfig = false;
    public loadingNodes = false;
    public nodesLoaded = false;
    public actionInProgress = false;
    public nodes: Node[] = [];
    public poolConfiguration: PoolConfigurationSummary | null = null;
    public actionMessage: string | null = null;
    public actionError: string | null = null;
    public configError: string | null = null;
    public lastBulkResult: BulkNodeActionResult | null = null;
    public lastNodeAction: NodeActionResult | null = null;

    private _selectedNodeIds = new Set<string>();
    private _selectionPoolId: string | null = null;

    constructor(
        private nodeActions: BatchNodeActionsService,
        private changeDetector: ChangeDetectorRef,
    ) { }

    public get selectedNodeCount(): number {
        return this._selectedNodeIds.size;
    }

    public get allNodesSelected(): boolean {
        return this.nodes.length > 0 && this._selectedNodeIds.size === this.nodes.length;
    }

    public get partialNodesSelected(): boolean {
        return this._selectedNodeIds.size > 0 && this._selectedNodeIds.size < this.nodes.length;
    }

    public get hasNodeCounts(): boolean {
        const counts = this.summary?.nodeCountsByState;
        return Boolean(counts && Object.keys(counts).length > 0);
    }

    public ngOnChanges(changes: SimpleChanges) {
        if (changes.poolId || changes.account) {
            this._resetSelectionContext();
            void this._loadPoolConfiguration();

            if (this.activeTabIndex === 1 && this.poolId && this.account) {
                void this.loadNodes(false);
            } else if (!this.poolId || !this.account) {
                this.nodes = [];
                this.nodesLoaded = false;
            }
            this.changeDetector.markForCheck();
        }
    }

    public onTabIndexChange(index: number) {
        this.activeTabIndex = index;
        if (index === 1) {
            void this.loadNodes(false);
        }
    }

    public async refreshNodes() {
        await this.loadNodes(true);
    }

    public toggleNodeSelection(nodeId: string, selected: boolean) {
        if (selected) {
            this._selectedNodeIds.add(nodeId);
        } else {
            this._selectedNodeIds.delete(nodeId);
        }
        this.changeDetector.markForCheck();
    }

    public toggleAllNodes(selected: boolean) {
        if (selected) {
            for (const node of this.nodes) {
                this._selectedNodeIds.add(node.id);
            }
        } else {
            this._selectedNodeIds.clear();
        }
        this.changeDetector.markForCheck();
    }

    public isNodeSelected(nodeId: string): boolean {
        return this._selectedNodeIds.has(nodeId);
    }

    public async bulkRemoveSelected() {
        await this._executeBulk("Removing selected nodes", () => {
            return this.nodeActions.removeNodes(this.account, this.poolId, this._selectedIds()).toPromise();
        });
    }

    public async removeNode(node: Node) {
        await this._executeBulk("Removing node", () => {
            return this.nodeActions.removeNodes(this.account, this.poolId, [node.id]).toPromise();
        }, false);
    }

    public async bulkRebootSelected() {
        await this._executeBulk("Rebooting selected nodes", () => {
            return this.nodeActions.rebootNodes(this.account, this.poolId, this._selectedIds()).toPromise();
        });
    }

    public async bulkReimageSelected() {
        await this._executeBulk("Reimaging selected nodes", () => {
            return this.nodeActions.reimageNodes(this.account, this.poolId, this._selectedIds()).toPromise();
        });
    }

    public async bulkEnableSchedulingSelected() {
        await this._executeBulk("Enabling scheduling on selected nodes", () => {
            return this.nodeActions.enableSchedulingNodes(this.account, this.poolId, this._selectedIds()).toPromise();
        });
    }

    public async bulkDisableSchedulingSelected(option: DisableSchedulingOption = "taskCompletion") {
        await this._executeBulk("Disabling scheduling on selected nodes", () => {
            return this.nodeActions.disableSchedulingNodes(this.account, this.poolId, this._selectedIds(), option).toPromise();
        });
    }

    public async rebootNode(node: Node) {
        await this._executeSingleAction("Rebooting node", () => {
            return this.nodeActions.rebootNode(this.account, this.poolId, node.id).toPromise();
        });
    }

    public async reimageNode(node: Node) {
        await this._executeSingleAction("Reimaging node", () => {
            return this.nodeActions.reimageNode(this.account, this.poolId, node.id).toPromise();
        });
    }

    public async enableScheduling(node: Node) {
        await this._executeSingleAction("Enabling scheduling", () => {
            return this.nodeActions.enableScheduling(this.account, this.poolId, node.id).toPromise();
        });
    }

    public async disableScheduling(node: Node, option: DisableSchedulingOption = "taskCompletion") {
        await this._executeSingleAction("Disabling scheduling", () => {
            return this.nodeActions.disableScheduling(this.account, this.poolId, node.id, option).toPromise();
        });
    }

    public nodeErrorsCount(node: Node): number {
        return node.errors ? node.errors.size : 0;
    }

    public async loadNodes(force: boolean) {
        if (!this.account || !this.poolId || this.loadingNodes) {
            return;
        }
        if (this._selectionPoolId !== this.poolId) {
            this._selectionPoolId = this.poolId;
            this._selectedNodeIds.clear();
            this.nodes = [];
            this.nodesLoaded = false;
        }
        if (this.nodesLoaded && !force) {
            return;
        }

        this.loadingNodes = true;
        this.actionError = null;
        this.changeDetector.markForCheck();

        try {
            this.nodes = await this.nodeActions.listNodes(this.account, this.poolId).toPromise();
            this.nodesLoaded = true;
            this._selectedNodeIds.clear();
        } catch (error) {
            this.actionError = error?.message || "Failed to load pool nodes.";
        } finally {
            this.loadingNodes = false;
            this.changeDetector.markForCheck();
        }
    }

    private async _loadPoolConfiguration() {
        if (!this.account || !this.poolId) {
            this.poolConfiguration = null;
            this.configError = null;
            this.loadingPoolConfig = false;
            return;
        }

        this.loadingPoolConfig = true;
        this.configError = null;
        this.changeDetector.markForCheck();

        try {
            this.poolConfiguration = await this.nodeActions.getPoolConfiguration(this.account, this.poolId).toPromise();
        } catch (error) {
            this.poolConfiguration = null;
            this.configError = error?.message || "Failed to load pool configuration.";
        } finally {
            this.loadingPoolConfig = false;
            this.changeDetector.markForCheck();
        }
    }

    private _resetSelectionContext() {
        if (this._selectionPoolId === this.poolId) {
            return;
        }

        this._selectionPoolId = this.poolId || null;
        this._selectedNodeIds.clear();
        this.nodes = [];
        this.nodesLoaded = false;
        this.lastBulkResult = null;
        this.lastNodeAction = null;
    }

    private _selectedIds(): string[] {
        return Array.from(this._selectedNodeIds.values());
    }

    private async _executeBulk(
        actionMessage: string,
        callback: () => Promise<BulkNodeActionResult>,
        requireSelection = true,
    ) {
        if (!this.account || !this.poolId || this.actionInProgress) {
            return;
        }
        if (requireSelection && this._selectedNodeIds.size === 0) {
            return;
        }

        this.actionInProgress = true;
        this.actionMessage = actionMessage;
        this.actionError = null;
        this.changeDetector.markForCheck();

        try {
            this.lastBulkResult = await callback();
            this.bulkActionCompleted.emit(this.lastBulkResult);
            await this.loadNodes(true);
            this._selectedNodeIds.clear();
        } catch (error) {
            this.actionError = error?.message || "Bulk action failed.";
        } finally {
            this.actionInProgress = false;
            this.actionMessage = null;
            this.changeDetector.markForCheck();
        }
    }

    private async _executeSingleAction(
        actionMessage: string,
        callback: () => Promise<NodeActionResult>,
    ) {
        if (!this.account || !this.poolId || this.actionInProgress) {
            return;
        }

        this.actionInProgress = true;
        this.actionMessage = actionMessage;
        this.actionError = null;
        this.changeDetector.markForCheck();

        try {
            this.lastNodeAction = await callback();
            this.nodeActionCompleted.emit(this.lastNodeAction);
            await this.loadNodes(true);
        } catch (error) {
            this.actionError = error?.message || "Node action failed.";
        } finally {
            this.actionInProgress = false;
            this.actionMessage = null;
            this.changeDetector.markForCheck();
        }
    }
}
