import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    OnDestroy,
    ViewChild,
} from "@angular/core";
import * as React from "react";
import * as ReactDOM from "react-dom/client";
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

    private _root: ReactDOM.Root | null = null;

    ngAfterViewInit(): void {
        this._root = ReactDOM.createRoot(this.hostRef.nativeElement);
        this._root.render(React.createElement(MultiRegionDashboard));
    }

    ngOnDestroy(): void {
        // Defer unmount to avoid React warning about synchronous unmount
        if (this._root) {
            const root = this._root;
            this._root = null;
            setTimeout(() => root.unmount(), 0);
        }
    }
}
