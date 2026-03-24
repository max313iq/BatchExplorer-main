import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
import { MultiRegionHomeComponent } from "./home/multi-region-home.component";
import { OverviewComponent } from "./overview/overview.component";
import { AccountListComponent } from "./account-list/account-list.component";
import { AccountInfoComponent } from "./account-info/account-info.component";
import { PoolCreationComponent } from "./pool-creation/pool-creation.component";
import { PoolInfoComponent } from "./pool-info/pool-info.component";
import { QuotaRequestsComponent } from "./quota-requests/quota-requests.component";
import { QuotaStatusComponent } from "./quota-status/quota-status.component";
import { UnusedQuotaComponent } from "./unused-quota/unused-quota.component";
import { NodesComponent } from "./nodes/nodes.component";

const routes: Routes = [
    {
        path: "",
        component: MultiRegionHomeComponent,
        children: [
            { path: "", component: OverviewComponent },
            { path: "accounts", component: AccountListComponent },
            { path: "account-info", component: AccountInfoComponent },
            { path: "pools", component: PoolCreationComponent },
            { path: "pool-info", component: PoolInfoComponent },
            { path: "quotas", component: QuotaRequestsComponent },
            { path: "quota-status", component: QuotaStatusComponent },
            { path: "unused-quota", component: UnusedQuotaComponent },
            { path: "nodes", component: NodesComponent },
        ],
    },
];

@NgModule({
    imports: [RouterModule.forChild(routes)],
    exports: [RouterModule],
})
export class MultiRegionRoutingModule {}
