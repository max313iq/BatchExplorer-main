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

const GPU_VM_SIZES = [
    "Standard_NC6s_v3",
    "Standard_NC12s_v3",
    "Standard_NC24s_v3",
    "Standard_ND40rs_v2",
    "Standard_NC24ads_A100_v4",
];

@Component({
    selector: "bl-multi-region-pool-creation",
    templateUrl: "pool-creation.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolCreationComponent implements OnInit, OnDestroy {
    public availableVmSizes = GPU_VM_SIZES;
    public selectedVmSizes: Set<string> = new Set();
    public startTaskCommand = "";
    public envVars: Array<{ name: string; value: string }> = [];
    public accounts: ManagedAccount[] = [];
    public selectedAccountIds: Set<string> = new Set();
    public creating = false;

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

    public toggleVmSize(vmSize: string): void {
        if (this.selectedVmSizes.has(vmSize)) {
            this.selectedVmSizes.delete(vmSize);
        } else {
            this.selectedVmSizes.add(vmSize);
        }
        this.changeDetector.markForCheck();
    }

    public isVmSizeSelected(vmSize: string): boolean {
        return this.selectedVmSizes.has(vmSize);
    }

    public toggleAccountSelection(accountId: string): void {
        if (this.selectedAccountIds.has(accountId)) {
            this.selectedAccountIds.delete(accountId);
        } else {
            this.selectedAccountIds.add(accountId);
        }
        this.changeDetector.markForCheck();
    }

    public isAccountSelected(accountId: string): boolean {
        return this.selectedAccountIds.has(accountId);
    }

    public selectAllAccounts(): void {
        this.selectedAccountIds = new Set(this.accounts.map((a) => a.id));
        this.changeDetector.markForCheck();
    }

    public deselectAllAccounts(): void {
        this.selectedAccountIds.clear();
        this.changeDetector.markForCheck();
    }

    public addEnvVar(): void {
        this.envVars = [...this.envVars, { name: "", value: "" }];
        this.changeDetector.markForCheck();
    }

    public removeEnvVar(index: number): void {
        this.envVars = this.envVars.filter((_, i) => i !== index);
        this.changeDetector.markForCheck();
    }

    public async createPools(): Promise<void> {
        if (
            this.selectedVmSizes.size === 0 ||
            this.selectedAccountIds.size === 0
        ) {
            return;
        }

        this.creating = true;
        this.changeDetector.markForCheck();

        try {
            await this.multiRegionService.createPoolsSmart({
                vmSizes: Array.from(this.selectedVmSizes),
                startTaskCommand: this.startTaskCommand,
                environmentSettings: this.envVars.filter(
                    (v) => v.name.trim().length > 0
                ),
                accountIds: Array.from(this.selectedAccountIds),
            });
        } finally {
            this.creating = false;
            this.changeDetector.markForCheck();
        }
    }
}
