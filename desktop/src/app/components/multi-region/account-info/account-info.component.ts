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
    selector: "bl-multi-region-account-info",
    templateUrl: "account-info.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountInfoComponent implements OnInit, OnDestroy {
    public accountInfos: AccountInfo[] = [];

    private _destroy = new Subject<void>();

    constructor(
        public multiRegionService: MultiRegionService,
        private changeDetector: ChangeDetectorRef
    ) {}

    public ngOnInit(): void {
        this.multiRegionService.accountInfos$
            .pipe(takeUntil(this._destroy))
            .subscribe((infos) => {
                this.accountInfos = infos;
                this.changeDetector.markForCheck();
            });
    }

    public ngOnDestroy(): void {
        this._destroy.next();
        this._destroy.complete();
    }

    public refresh(): void {
        this.multiRegionService.refreshAccountInfo();
    }
}
