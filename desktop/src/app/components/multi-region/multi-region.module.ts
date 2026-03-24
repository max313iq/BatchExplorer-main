import { NgModule } from "@angular/core";
import { commonModules } from "app/common";
import { MultiRegionRoutingModule } from "./multi-region-routing.module";
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

const components = [
    MultiRegionHomeComponent,
    OverviewComponent,
    AccountListComponent,
    AccountInfoComponent,
    PoolCreationComponent,
    PoolInfoComponent,
    QuotaRequestsComponent,
    QuotaStatusComponent,
    UnusedQuotaComponent,
    NodesComponent,
];

@NgModule({
    declarations: components,
    imports: [...commonModules, MultiRegionRoutingModule],
    exports: [MultiRegionRoutingModule],
})
export class MultiRegionModule {}
