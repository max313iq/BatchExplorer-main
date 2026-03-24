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
import {
    MultiRegionDashboard,
    TokenProvider,
    MultiRegionStore,
} from "multi-region";
import { AuthService } from "app/services/aad";
import { SubscriptionService } from "app/services/subscription/subscription.service";
import { Subscription } from "rxjs";
import { first } from "rxjs/operators";

/**
 * Angular wrapper that renders the React MultiRegionDashboard inside the
 * desktop Electron app using the desktop's MSAL-based auth.
 *
 * The TokenProvider bridges desktop auth (MSAL via IPC) into the React
 * component tree, so multi-region works identically in both web and desktop.
 *
 * All web features are automatically available because we render the same
 * root React component — any future additions appear here without changes.
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
    @ViewChild("reactHost", { static: true })
    hostRef!: ElementRef<HTMLDivElement>;

    private _sub: Subscription;

    constructor(
        private authService: AuthService,
        private subscriptionService: SubscriptionService
    ) {}

    ngAfterViewInit(): void {
        // Wait for the current user to resolve their home tenant
        this._sub = this.authService.currentUser
            .pipe(first())
            .subscribe((user) => {
                const tenantId = user?.tid ?? "organizations";
                const tokenProvider = this._createTokenProvider(tenantId);
                ReactDOM.render(
                    React.createElement(MultiRegionDashboard, {
                        tokenProvider,
                    }),
                    this.hostRef.nativeElement
                );
            });
    }

    ngOnDestroy(): void {
        this._sub?.unsubscribe();
        if (this.hostRef?.nativeElement) {
            ReactDOM.unmountComponentAtNode(this.hostRef.nativeElement);
        }
    }

    private _createTokenProvider(tenantId: string): TokenProvider {
        return {
            getAccessToken: async () => {
                const token = await this.authService.getAccessToken(
                    tenantId,
                    null
                );
                return token.accessToken;
            },
            getBatchAccessToken: async () => {
                const token = await this.authService.getAccessToken(
                    tenantId,
                    "batch" as any
                );
                return token.accessToken;
            },
            checkHealth: async () => {
                try {
                    const armToken = await this.authService.getAccessToken(
                        tenantId,
                        null
                    );
                    if (!armToken?.accessToken) {
                        return {
                            healthy: false,
                            error: "Failed to acquire ARM token. Please sign in.",
                        };
                    }
                    const batchToken = await this.authService.getAccessToken(
                        tenantId,
                        "batch" as any
                    );
                    if (!batchToken?.accessToken) {
                        return {
                            healthy: false,
                            error: "Failed to acquire Batch token. Check your account access.",
                        };
                    }
                    const subs = await this.subscriptionService.subscriptions
                        .pipe(first())
                        .toPromise();
                    if (!subs || subs.size === 0) {
                        return {
                            healthy: false,
                            error: "No Azure subscriptions found.",
                        };
                    }
                    return { healthy: true, error: null };
                } catch (e) {
                    return {
                        healthy: false,
                        error: e?.message ?? "Auth check failed.",
                    };
                }
            },
            loadSubscriptions: async (store: MultiRegionStore) => {
                try {
                    const subs = await this.subscriptionService.subscriptions
                        .pipe(first())
                        .toPromise();
                    store.setSubscriptions(
                        subs.toArray().map((s) => ({
                            subscriptionId: s.subscriptionId,
                            displayName: s.displayName,
                        }))
                    );
                } catch {
                    /* subscriptions are optional */
                }
            },
        };
    }
}
