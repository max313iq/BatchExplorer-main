import { Component, OnDestroy } from "@angular/core";
import { UserConfigurationService, autobind } from "@batch-flask/core";
import { SidebarManager } from "@batch-flask/ui/sidebar";
import { Router } from "@angular/router";
import { BEUserConfiguration } from "common";
import { Subject } from "rxjs";
import { takeUntil } from "rxjs/operators";
import { PoolCreateBasicDialogComponent } from "../action";

@Component({
    selector: "bl-pool-home",
    templateUrl: "pool-home.html",
})
export class PoolHomeComponent implements OnDestroy {
    public showWorkbench = false;
    private _destroy = new Subject<void>();

    public static breadcrumb() {
        return { name: "Pools" };
    }
    constructor(
        private sidebarManager: SidebarManager,
        private router: Router,
        private userConfigurationService: UserConfigurationService<BEUserConfiguration>) {
        this.userConfigurationService.watch("features").pipe(takeUntil(this._destroy)).subscribe((features: any) => {
            this.showWorkbench = Boolean(features && features.poolControlWorkbench);
        });
    }

    public ngOnDestroy() {
        this._destroy.next();
        this._destroy.complete();
    }

    @autobind()
    public addPool() {
        this.sidebarManager.open("add-pool", PoolCreateBasicDialogComponent);
    }

    @autobind()
    public openWorkbench() {
        return this.router.navigate(["/pools/workbench"]);
    }
}
