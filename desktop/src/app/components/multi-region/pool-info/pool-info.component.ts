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
import type { PoolInfo } from "multi-region";

@Component({
    selector: "bl-multi-region-pool-info",
    templateUrl: "pool-info.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolInfoComponent implements OnInit, OnDestroy {
    public pools: PoolInfo[] = [];

    private _destroy = new Subject<void>();

    constructor(
        public multiRegionService: MultiRegionService,
        private changeDetector: ChangeDetectorRef
    ) {}

    public ngOnInit(): void {
        this.multiRegionService.poolInfos$
            .pipe(takeUntil(this._destroy))
            .subscribe((pools) => {
                this.pools = pools;
                this.changeDetector.markForCheck();
            });
    }

    public ngOnDestroy(): void {
        this._destroy.next();
        this._destroy.complete();
    }

    public refresh(): void {
        this.multiRegionService.refreshPoolInfo();
    }

    public resizePool(pool: PoolInfo): void {
        const target = prompt(
            `Resize pool '${pool.poolId}' — new target dedicated nodes:`,
            `${pool.targetDedicatedNodes}`
        );
        if (target != null) {
            const targetNumber = parseInt(target, 10);
            if (!isNaN(targetNumber) && targetNumber >= 0) {
                this.multiRegionService.resizePool({
                    accountId: pool.accountId,
                    poolId: pool.poolId,
                    targetDedicatedNodes: targetNumber,
                });
            }
        }
    }

    public updateStartTask(pool: PoolInfo): void {
        const command = prompt(
            `Update start task for pool '${pool.poolId}' — new command line:`
        );
        if (command != null && command.trim().length > 0) {
            this.multiRegionService.updateStartTask({
                accountId: pool.accountId,
                poolId: pool.poolId,
                commandLine: command.trim(),
            });
        }
    }
}
