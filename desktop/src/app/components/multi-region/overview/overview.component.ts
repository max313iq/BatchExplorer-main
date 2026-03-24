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
import type {
    ManagedAccount,
    PoolInfo,
    AccountInfo,
    ManagedNode,
} from "multi-region";

@Component({
    selector: "bl-multi-region-overview",
    templateUrl: "overview.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewComponent implements OnInit, OnDestroy {
    public accountCount = 0;
    public poolCount = 0;
    public nodeCount = 0;
    public totalDedicatedQuota = 0;
    public totalLpQuota = 0;
    public totalDedicatedUsed = 0;
    public totalLpUsed = 0;
    public accounts: ManagedAccount[] = [];
    public pools: PoolInfo[] = [];
    public nodes: ManagedNode[] = [];

    private _destroy = new Subject<void>();

    constructor(
        public multiRegionService: MultiRegionService,
        private changeDetector: ChangeDetectorRef
    ) {}

    public ngOnInit(): void {
        this.multiRegionService.accounts$
            .pipe(takeUntil(this._destroy))
            .subscribe((accounts) => {
                this.accounts = accounts;
                this.accountCount = accounts.length;
                this.changeDetector.markForCheck();
            });

        this.multiRegionService.poolInfos$
            .pipe(takeUntil(this._destroy))
            .subscribe((pools) => {
                this.pools = pools;
                this.poolCount = pools.length;
                this.changeDetector.markForCheck();
            });

        this.multiRegionService.nodes$
            .pipe(takeUntil(this._destroy))
            .subscribe((nodes) => {
                this.nodes = nodes;
                this.nodeCount = nodes.length;
                this.changeDetector.markForCheck();
            });

        this.multiRegionService.accountInfos$
            .pipe(takeUntil(this._destroy))
            .subscribe((infos: AccountInfo[]) => {
                this.totalDedicatedQuota = infos.reduce(
                    (s, a) => s + a.dedicatedCoreQuota,
                    0
                );
                this.totalLpQuota = infos.reduce(
                    (s, a) => s + a.lowPriorityCoreQuota,
                    0
                );
                this.totalDedicatedUsed = infos.reduce(
                    (s, a) => s + a.dedicatedCoresUsed,
                    0
                );
                this.totalLpUsed = infos.reduce(
                    (s, a) => s + a.lowPriorityCoresUsed,
                    0
                );
                this.changeDetector.markForCheck();
            });
    }

    public ngOnDestroy(): void {
        this._destroy.next();
        this._destroy.complete();
    }

    public refreshAll(): void {
        this.multiRegionService.discoverAccounts();
        this.multiRegionService.refreshAccountInfo();
        this.multiRegionService.refreshPoolInfo();
    }

    public discoverAccounts(): void {
        this.multiRegionService.discoverAccounts();
    }
}
