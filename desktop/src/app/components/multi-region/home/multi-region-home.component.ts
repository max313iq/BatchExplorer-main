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
import "./multi-region-home.scss";

@Component({
    selector: "bl-multi-region-home",
    templateUrl: "multi-region-home.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MultiRegionHomeComponent implements OnInit, OnDestroy {
    public accountCount = 0;
    public poolCount = 0;
    public nodeCount = 0;
    public quotaCount = 0;
    public sessionId = "";
    public autoRefreshEnabled = false;

    private _destroy = new Subject<void>();

    constructor(
        public multiRegionService: MultiRegionService,
        private changeDetector: ChangeDetectorRef
    ) {}

    public ngOnInit(): void {
        this.sessionId = this.multiRegionService.store.getState().sessionId;

        this.multiRegionService.accounts$
            .pipe(takeUntil(this._destroy))
            .subscribe((accounts) => {
                this.accountCount = accounts.length;
                this.changeDetector.markForCheck();
            });

        this.multiRegionService.poolInfos$
            .pipe(takeUntil(this._destroy))
            .subscribe((pools) => {
                this.poolCount = pools.length;
                this.changeDetector.markForCheck();
            });

        this.multiRegionService.nodes$
            .pipe(takeUntil(this._destroy))
            .subscribe((nodes) => {
                this.nodeCount = nodes.length;
                this.changeDetector.markForCheck();
            });

        this.multiRegionService.accountInfos$
            .pipe(takeUntil(this._destroy))
            .subscribe((infos) => {
                this.quotaCount = infos.length;
                this.changeDetector.markForCheck();
            });
    }

    public ngOnDestroy(): void {
        this._destroy.next();
        this._destroy.complete();
    }

    public toggleAutoRefresh(): void {
        this.autoRefreshEnabled = !this.autoRefreshEnabled;
        this.changeDetector.markForCheck();
    }
}
