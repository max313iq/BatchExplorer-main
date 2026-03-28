import {
    EnvironmentMode,
    FakeLocationService,
    FakeResourceGroupService,
    FakeStorageAccountService,
    FakeSubscriptionService,
    initEnvironment,
} from "@azure/bonito-core";
import { StandardClock } from "@azure/bonito-core/lib/datetime";
import { DependencyName } from "@azure/bonito-core/lib/environment";
import { MockHttpClient } from "@azure/bonito-core/lib/http";
import { HttpLocalizer } from "@azure/bonito-core/lib/localization";
import { createConsoleLogger } from "@azure/bonito-core/lib/logging";
import { AlertNotifier } from "@azure/bonito-core/lib/notification/alert-notifier";
import { DefaultBrowserEnvironment } from "@azure/bonito-ui";
import { DefaultFormLayoutProvider } from "@azure/bonito-ui/lib/components/form";
import {
    BrowserDependencyName,
    BrowserEnvironmentConfig,
} from "@azure/bonito-ui/lib/environment";
import {
    BatchBrowserDependencyFactories,
    BatchFormControlResolver,
} from "@batch/ui-react";
import { FakeNodeService } from "@batch/ui-service";
import { BatchDependencyName } from "@batch/ui-service/lib/environment";
import { FakePoolService } from "@batch/ui-service/lib/pool";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { Application } from "./components";
import { MemoryCacheManager } from "@azure/bonito-core/lib/cache";
import { FakeAccountService } from "@batch/ui-service/lib/account";
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

// Defined by webpack
declare const ENV: {
    MODE: EnvironmentMode;
};

/**
 * Detect if this page load is an MSAL popup callback.
 *
 * We do NOT rely on window.opener — browsers null it out after cross-origin
 * navigation through login.microsoftonline.com for security reasons.
 *
 * Instead we parse the MSAL `state` parameter (always present in popup
 * callbacks) which contains base64url-encoded JSON with:
 *   { meta: { interactionType: "popup" | "redirect" | "silent" }, ... }
 *
 * This is the same detection logic MSAL itself uses internally.
 */
function isMsalPopupCallback(): boolean {
    const urlParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const stateParam = urlParams.get("state") || hashParams.get("state");
    const hasCode =
        urlParams.has("code") ||
        urlParams.has("error") ||
        hashParams.has("code") ||
        hashParams.has("error");

    if (!stateParam || !hasCode) return false;

    try {
        // MSAL state format: base64url(JSON) | optional-user-state
        const [libraryStateEncoded] = stateParam.split("|");
        const padding = "=".repeat((4 - (libraryStateEncoded.length % 4)) % 4);
        const base64 = (libraryStateEncoded + padding)
            .replace(/-/g, "+")
            .replace(/_/g, "/");
        const libraryState = JSON.parse(atob(base64));
        return libraryState?.meta?.interactionType === "popup";
    } catch {
        return false;
    }
}

if (isMsalPopupCallback()) {
    // We are inside the MSAL login popup callback. Do NOT render the app.
    //
    // WHY broadcastResponseToMainFrame instead of handleRedirectPromise:
    //   The parent's loginPopup() stores the PKCE code verifier in its own
    //   sessionStorage. A fresh MSAL instance here cannot do the token exchange
    //   without it, and direct token POSTs would hit CORS anyway.
    //   broadcastResponseToMainFrame() reads the raw auth code from the URL
    //   and sends it to the parent via BroadcastChannel. The parent completes
    //   the exchange using its own verifier + proxy network client, then the
    //   popup is closed automatically.
    document.title = "Signing in...";
    document.body.innerText = "";

    broadcastResponseToMainFrame().catch((err) => {
        console.error("[MSAL Popup] broadcastResponseToMainFrame error:", err);
        // Safety-net: close the popup so the user isn't left stranded
        setTimeout(() => {
            try {
                window.close();
            } catch {
                /**/
            }
        }, 500);
    });
} else {
    // Bootstrap the app
    const rootEl = document.getElementById("batch-explorer-root");
    if (!rootEl) {
        throw new Error(
            "Failed to initialize: No element with an ID of 'batch-explorer-root' found."
        );
    }
    init(rootEl);
}

export async function init(rootEl: HTMLElement): Promise<void> {
    const localizer = new HttpLocalizer();
    await localizer.loadTranslations("/resources/i18n");
    initEnvironment(
        new DefaultBrowserEnvironment<
            BrowserEnvironmentConfig,
            BatchBrowserDependencyFactories
        >(
            {
                mode: ENV.MODE ?? EnvironmentMode.Development,
                armUrl: "https://management.azure.com",
            },
            {
                [DependencyName.Clock]: () => new StandardClock(),
                [DependencyName.LoggerFactory]: () => createConsoleLogger,
                [DependencyName.Localizer]: () => localizer,
                [DependencyName.HttpClient]: () => new MockHttpClient(),
                [DependencyName.LocationService]: () =>
                    new FakeLocationService(),
                [DependencyName.Notifier]: () => new AlertNotifier(), // TODO: update with real notification implementation
                [DependencyName.CacheManager]: () => new MemoryCacheManager(),
                [BatchDependencyName.PoolService]: () => new FakePoolService(),
                [BatchDependencyName.NodeService]: () => new FakeNodeService(),
                [BatchDependencyName.AccountService]: () =>
                    new FakeAccountService(),
                [DependencyName.ResourceGroupService]: () =>
                    new FakeResourceGroupService(),
                [DependencyName.StorageAccountService]: () =>
                    new FakeStorageAccountService(),
                [DependencyName.SubscriptionService]: () =>
                    new FakeSubscriptionService(),
                [BrowserDependencyName.FormControlResolver]: () =>
                    new BatchFormControlResolver(),
                [BrowserDependencyName.FormLayoutProvider]: () =>
                    new DefaultFormLayoutProvider(),
            }
        )
    );
    ReactDOM.render(<Application />, rootEl);
}
