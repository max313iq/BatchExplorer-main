import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    OnDestroy,
    ViewChild,
} from "@angular/core";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { MultiRegionDashboard } from "multi-region";

/**
 * Angular wrapper that renders the React MultiRegionDashboard inside the
 * desktop Electron app. This bridges the Angular routing/navigation layer
 * with the full React-based multi-region management UI.
 *
 * All web features are automatically available because we render the same
 * root React component — any future additions to MultiRegionDashboard
 * will appear here without changes.
 */
@Component({
    selector: "bl-multi-region",
    template: `<div #reactHost class="multi-region-host"></div>`,
    styles: [
        `
            :host {
                display: block;
                height: 100%;
                width: 100%;
                overflow: hidden;
            }
            .multi-region-host {
                height: 100%;
                width: 100%;
            }
        `,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MultiRegionWrapperComponent implements AfterViewInit, OnDestroy {
    @ViewChild("reactHost", { static: true }) hostRef!: ElementRef<HTMLDivElement>;

    ngAfterViewInit(): void {
        ReactDOM.render(
            React.createElement(MultiRegionDashboard),
            this.hostRef.nativeElement
        );
    }

    ngOnDestroy(): void {
        if (this.hostRef?.nativeElement) {
            ReactDOM.unmountComponentAtNode(this.hostRef.nativeElement);
        }
    }
}
