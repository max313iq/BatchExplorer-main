import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    OnDestroy,
    OnInit,
} from "@angular/core";
import { Subject } from "rxjs";
import { takeUntil } from "rxjs/operators";
import { MultiRegionService } from "app/services/multi-region";
import type { ManagedNode, NodeState } from "multi-region";

const ALL_NODE_STATES: NodeState[] = [
    "idle",
    "running",
    "creating",
    "starting",
    "waitingforstarttask",
    "starttaskfailed",
    "rebooting",
    "reimaging",
    "leavingpool",
    "offline",
    "preempted",
    "unusable",
    "unknown",
];

@Component({
    selector: "bl-multi-region-nodes",
    templateUrl: "nodes.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodesComponent implements OnInit, OnDestroy {
    public allNodes: ManagedNode[] = [];
    public filteredNodes: ManagedNode[] = [];
    public selectedStates: Set<NodeState> = new Set(ALL_NODE_STATES);
    public availableStates = ALL_NODE_STATES;
    public selectedNodeIds: Set<string> = new Set();
    public autoRecoveryEnabled = false;

    private _destroy = new Subject<void>();

    constructor(
        public multiRegionService: MultiRegionService,
        private changeDetector: ChangeDetectorRef
    ) {}

    public ngOnInit(): void {
        this.multiRegionService.nodes$
            .pipe(takeUntil(this._destroy))
            .subscribe((nodes) => {
                this.allNodes = nodes;
                this._applyFilter();
                this.changeDetector.markForCheck();
            });
    }

    public ngOnDestroy(): void {
        this._destroy.next();
        this._destroy.complete();
    }

    public refresh(): void {
        this.multiRegionService.refreshNodes();
    }

    public toggleState(state: NodeState): void {
        if (this.selectedStates.has(state)) {
            this.selectedStates.delete(state);
        } else {
            this.selectedStates.add(state);
        }
        this._applyFilter();
        this.changeDetector.markForCheck();
    }

    public isStateSelected(state: NodeState): boolean {
        return this.selectedStates.has(state);
    }

    public toggleNodeSelection(nodeId: string): void {
        if (this.selectedNodeIds.has(nodeId)) {
            this.selectedNodeIds.delete(nodeId);
        } else {
            this.selectedNodeIds.add(nodeId);
        }
        this.changeDetector.markForCheck();
    }

    public isNodeSelected(nodeId: string): boolean {
        return this.selectedNodeIds.has(nodeId);
    }

    public selectAll(): void {
        this.selectedNodeIds = new Set(this.filteredNodes.map((n) => n.id));
        this.changeDetector.markForCheck();
    }

    public deselectAll(): void {
        this.selectedNodeIds.clear();
        this.changeDetector.markForCheck();
    }

    public deleteSelected(): void {
        const ids = Array.from(this.selectedNodeIds);
        if (ids.length === 0) {
            return;
        }
        // Group by pool for bulk deletion
        const byPool = new Map<string, string[]>();
        for (const node of this.allNodes) {
            if (this.selectedNodeIds.has(node.id)) {
                const key = `${node.accountId}|${node.poolId}`;
                if (!byPool.has(key)) {
                    byPool.set(key, []);
                }
                byPool.get(key).push(node.nodeId);
            }
        }
        for (const [key, nodeIds] of byPool) {
            const [accountId, poolId] = key.split("|");
            this.multiRegionService.deleteNodes({ accountId, poolId, nodeIds });
        }
        this.selectedNodeIds.clear();
        this.changeDetector.markForCheck();
    }

    public recreateSelected(): void {
        const ids = Array.from(this.selectedNodeIds);
        if (ids.length === 0) {
            return;
        }
        // Reboot is the closest equivalent to "recreate"
        const byPool = new Map<string, string[]>();
        for (const node of this.allNodes) {
            if (this.selectedNodeIds.has(node.id)) {
                const key = `${node.accountId}|${node.poolId}`;
                if (!byPool.has(key)) {
                    byPool.set(key, []);
                }
                byPool.get(key).push(node.nodeId);
            }
        }
        // Delegate to delete + let the pool re-provision
        for (const [key, nodeIds] of byPool) {
            const [accountId, poolId] = key.split("|");
            this.multiRegionService.deleteNodes({ accountId, poolId, nodeIds });
        }
        this.selectedNodeIds.clear();
        this.changeDetector.markForCheck();
    }

    public recoverPreempted(): void {
        this.multiRegionService.recoverPreempted({});
    }

    public toggleAutoRecovery(): void {
        this.autoRecoveryEnabled = !this.autoRecoveryEnabled;
        this.changeDetector.markForCheck();
    }

    private _applyFilter(): void {
        this.filteredNodes = this.allNodes.filter((n) =>
            this.selectedStates.has(n.state as NodeState)
        );
    }
}
