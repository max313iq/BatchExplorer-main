import { CommonModule } from "@angular/common";
import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
import { MultiRegionWrapperComponent } from "./multi-region-wrapper.component";

const routes: Routes = [
    { path: "", component: MultiRegionWrapperComponent },
];

@NgModule({
    declarations: [MultiRegionWrapperComponent],
    imports: [CommonModule, RouterModule.forChild(routes)],
    exports: [RouterModule],
})
export class MultiRegionModule {}
