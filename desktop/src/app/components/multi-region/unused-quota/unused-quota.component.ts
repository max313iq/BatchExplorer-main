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
import type { AccountInfo } from "multi-region";

@Component({
    selector: "bl-multi-region-unused-quota",
    templateUrl: "unused-quota.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnusedQuotaComponent implements OnInit, OnDestroy {
    public unusedAccounts: AccountInfo[] = [];

    private _destroy = new Subject<void>();

    constructor(
        public multiRegionService: MultiRegionService,
        private changeDetector: ChangeDetectorRef
    ) {}

    public ngOnInit(): void {
        this.multiRegionService.accountInfos$
            .pipe(takeUntil(this._destroy))
            .subscribe((infos) => {
                this.unusedAccounts = infos.filter(
                    (a) =>
                        a.lowPriorityCoresFree > 0 || a.dedicatedCoresFree > 0
                );
                this.changeDetector.markForCheck();
            });
    }

    public ngOnDestroy(): void {
        this._destroy.next();
        this._destroy.complete();
    }

    public detect(): void {
        this.multiRegionService.detectUnusedQuota();
    }
}
