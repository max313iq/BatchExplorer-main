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
import type { ManagedAccount } from "multi-region";

@Component({
    selector: "bl-multi-region-account-list",
    templateUrl: "account-list.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountListComponent implements OnInit, OnDestroy {
    public accounts: ManagedAccount[] = [];

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
                this.changeDetector.markForCheck();
            });
    }

    public ngOnDestroy(): void {
        this._destroy.next();
        this._destroy.complete();
    }

    public discoverAccounts(): void {
        this.multiRegionService.discoverAccounts();
    }
}
