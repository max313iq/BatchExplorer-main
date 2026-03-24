import { ChangeDetectionStrategy, Component } from "@angular/core";
import { MultiRegionService } from "app/services/multi-region";

@Component({
    selector: "bl-multi-region-quota-requests",
    templateUrl: "quota-requests.html",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuotaRequestsComponent {
    constructor(public multiRegionService: MultiRegionService) {}
}
