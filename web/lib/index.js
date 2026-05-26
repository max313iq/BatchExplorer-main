var _a;
import { __awaiter } from "tslib";
import "./styles/tailwind.css";
import { EnvironmentMode, FakeLocationService, FakeResourceGroupService, FakeStorageAccountService, FakeSubscriptionService, initEnvironment, } from "@azure/bonito-core";
import { StandardClock } from "@azure/bonito-core/lib/datetime";
import { DependencyName } from "@azure/bonito-core/lib/environment";
import { MockHttpClient } from "@azure/bonito-core/lib/http";
import { HttpLocalizer } from "@azure/bonito-core/lib/localization";
import { createConsoleLogger } from "@azure/bonito-core/lib/logging";
import { AlertNotifier } from "@azure/bonito-core/lib/notification/alert-notifier";
import { DefaultBrowserEnvironment } from "@azure/bonito-ui";
import { DefaultFormLayoutProvider } from "@azure/bonito-ui/lib/components/form";
import { BrowserDependencyName, } from "@azure/bonito-ui/lib/environment";
import { BatchFormControlResolver, } from "@batch/ui-react";
import { FakeNodeService } from "@batch/ui-service";
import { BatchDependencyName } from "@batch/ui-service/lib/environment";
import { FakePoolService } from "@batch/ui-service/lib/pool";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Application } from "./components";
import { MemoryCacheManager } from "@azure/bonito-core/lib/cache";
import { taskRuntime } from "./multi-region/store/task-runtime";
// Side-effect import: registers window.__azbm.autoSignIn so the dev-server's
// Playwright auto-login flow can call MSAL.loginPopup from inside this page.
import "./multi-region/auth/msal-auth";
import { FakeAccountService } from "@batch/ui-service/lib/account";
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
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
function isMsalPopupCallback() {
    var _a;
    const urlParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const stateParam = urlParams.get("state") || hashParams.get("state");
    const hasCode = urlParams.has("code") ||
        urlParams.has("error") ||
        hashParams.has("code") ||
        hashParams.has("error");
    console.log("[MSAL Popup detect]", "stateParam=", stateParam ? `${stateParam.substring(0, 20)}...` : "(absent)", "hasCode=", hasCode, "windowOpener=", typeof window.opener);
    if (!hasCode)
        return false;
    // Strict-match path: MSAL-encoded state with interactionType=popup. This
    // is the canonical signal that we're inside a loginPopup callback.
    if (stateParam) {
        try {
            const [libraryStateEncoded] = stateParam.split("|");
            const padding = "=".repeat((4 - (libraryStateEncoded.length % 4)) % 4);
            const base64 = (libraryStateEncoded + padding)
                .replace(/-/g, "+")
                .replace(/_/g, "/");
            const libraryState = JSON.parse(atob(base64));
            console.log("[MSAL Popup detect] decoded state meta=", libraryState === null || libraryState === void 0 ? void 0 : libraryState.meta);
            if (((_a = libraryState === null || libraryState === void 0 ? void 0 : libraryState.meta) === null || _a === void 0 ? void 0 : _a.interactionType) === "popup")
                return true;
        }
        catch (e) {
            console.warn("[MSAL Popup detect] state decode failed; using fallback heuristic", e);
        }
    }
    // Fallback heuristic: if this load has an auth code AND a window.opener
    // (or the URL has session_state, an AAD-only signal), assume we're a
    // popup callback even though the state didn't decode to MSAL's expected
    // shape. Better to broadcast and let the parent ignore than to leave the
    // parent's loginPopup hanging forever.
    const hasOpener = !!window.opener;
    const hasSessionState = urlParams.has("session_state") || hashParams.has("session_state");
    if (hasOpener || hasSessionState) {
        console.log("[MSAL Popup detect] fallback heuristic matched (opener=", hasOpener, "session_state=", hasSessionState, ")");
        return true;
    }
    return false;
}
// ---------------------------------------------------------------------------
// Cross-browser shared MSAL cache hook.
//
// Every browser profile has its own localStorage, so the WebUI's MSAL
// cache is normally scoped per-browser — Chrome doesn't see Firefox's
// signed-in accounts and vice versa. The dev-server holds a single JSON
// snapshot of msal.* + azbm.* localStorage keys; this hook:
//   1. Wraps localStorage.setItem/removeItem so every cache mutation is
//      pushed to the server (debounced 600 ms so a burst of MSAL writes
//      collapses into one PUT).
//   2. Exposes window.__azbmSyncSharedCache() — the bootstrap path
//      (init() in this file) awaits this BEFORE rendering the app, so
//      MSAL's first read of localStorage already sees the merged state
//      from every other browser.
//
// Hooks have to be installed BEFORE MSAL or any other module touches
// localStorage; otherwise early writes (e.g. account-cache hydration in
// azure-accounts-page) wouldn't be propagated. They live at the top of
// index.tsx for that reason.
// ---------------------------------------------------------------------------
// MSAL.js v5.10 stores cache entries under TWO different prefix shapes:
//   - `msal.<...>` (dot-separated) — metadata + interaction state
//   - `msal|3|<...>` (pipe-separated) — the actual account, ID-token,
//     refresh-token, and access-token records (this is the schema we
//     MUST replicate across browsers; without it the new browser sees
//     metadata but no logged-in accounts).
// Catch both, plus our own `azbm.*` prefs.
function isSharedKey(k) {
    if (!k)
        return false;
    return (k.startsWith("msal.") ||
        k.startsWith("msal|") ||
        k.startsWith("azbm."));
}
// Production warning: this monkey-patch is intentional for dev (cross-browser
// MSAL sharing via the dev-server). It is NEVER meant to ship in production.
// If the build pod adds `DefinePlugin` for `process.env.NODE_ENV` and bundles
// a production build, surface a single console warning so the install is loud.
// If the symbol is not defined (current state), this block is a silent no-op.
try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (typeof process !== "undefined" ? process : undefined);
    if (((_a = proc === null || proc === void 0 ? void 0 : proc.env) === null || _a === void 0 ? void 0 : _a.NODE_ENV) === "production") {
        console.warn("[azbm] Shared-cache localStorage monkey-patch is active in a " +
            "production build. This wraps every localStorage.setItem / " +
            "removeItem / clear and is intended for the dev-server only. " +
            "Strip it from the production bundle or gate it on ENV.MODE.");
    }
}
catch (_b) {
    /* `process` not defined in browser bundle — that's fine, skip. */
}
// Module-level guard so jest's `jest.resetModules()` (which re-runs the
// top-level body of this file) doesn't pile up duplicate visibilitychange
// listeners on `document`. Production is a single top-level evaluation so
// the guard is a no-op in normal use.
const LISTENER_GUARD_KEY = "__azbmListenerInstalled";
const __listenerAlreadyInstalled = typeof window !== "undefined" &&
    window[LISTENER_GUARD_KEY] === true;
if (typeof window !== "undefined" && typeof localStorage !== "undefined" && !__listenerAlreadyInstalled) {
    window[LISTENER_GUARD_KEY] = true;
    // Pull-completed gate: we only allow a PUT after the initial sync
    // from the server has run at least once. Otherwise a fresh page load
    // (empty localStorage, MSAL not yet inited) would push `{}` to the
    // server before we'd even read what was there — wiping every other
    // browser's view. The flag flips to true at the END of a successful
    // __azbmSyncSharedCache, so any local writes the React app makes
    // afterwards are safely propagated.
    let pulledOnce = false;
    let pushTimer = null;
    // The core PUT-now routine. Used by both the debounced schedulePush
    // and the explicit __azbmFlushSharedCache hook. Returns the fetch
    // promise so callers awaiting the flush can be sure the server
    // received it before they navigate / reload.
    const pushNow = () => __awaiter(void 0, void 0, void 0, function* () {
        if (pushTimer) {
            clearTimeout(pushTimer);
            pushTimer = null;
        }
        if (!pulledOnce)
            return;
        const snapshot = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (isSharedKey(k)) {
                const v = localStorage.getItem(k);
                if (v != null)
                    snapshot[k] = v;
            }
        }
        // Empty snapshot here means local is mid-init — never PUT {}
        // because that would clobber the cross-browser source of truth.
        // Use DELETE for an explicit wipe instead (clear() wrapper below).
        if (Object.keys(snapshot).length === 0)
            return;
        try {
            yield fetch("/api/auth/shared-cache", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(snapshot),
            });
        }
        catch (_c) {
            /* offline-tolerant */
        }
    });
    const schedulePush = () => {
        if (pushTimer)
            clearTimeout(pushTimer);
        pushTimer = setTimeout(() => {
            void pushNow();
        }, 600);
    };
    // Expose a no-debounce flush so callers handling a destructive op
    // (Remove account, logout) can guarantee the server snapshot
    // catches up BEFORE a reload pulls a stale one back.
    window.__azbmFlushSharedCache = pushNow;
    // Cross-tab freshness: when this tab regains focus after being
    // hidden, re-pull the server snapshot so any changes another
    // browser made while we were inactive (new account signed in,
    // account removed) propagate without requiring a manual reload.
    // Debounced 200 ms so a focus-bounce doesn't trigger a flurry.
    let pullOnFocusTimer = null;
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible")
            return;
        if (pullOnFocusTimer)
            clearTimeout(pullOnFocusTimer);
        pullOnFocusTimer = setTimeout(() => {
            var _a, _b;
            void ((_b = (_a = window).__azbmSyncSharedCache) === null || _b === void 0 ? void 0 : _b.call(_a));
        }, 200);
    });
    const proto = Object.getPrototypeOf(localStorage);
    const origSet = proto.setItem.bind(localStorage);
    const origRemove = proto.removeItem.bind(localStorage);
    const origClear = proto.clear.bind(localStorage);
    // Override setItem / removeItem on the localStorage instance so the
    // wrappers fire regardless of how callers reach them.
    Object.defineProperty(localStorage, "setItem", {
        configurable: true,
        value: function setItem(k, v) {
            origSet(k, v);
            if (isSharedKey(k))
                schedulePush();
        },
    });
    Object.defineProperty(localStorage, "removeItem", {
        configurable: true,
        value: function removeItem(k) {
            origRemove(k);
            if (isSharedKey(k))
                schedulePush();
        },
    });
    Object.defineProperty(localStorage, "clear", {
        configurable: true,
        value: function clear() {
            origClear();
            // Clearing local mirrors a global wipe; tell the server too so
            // the next browser to load doesn't hydrate from stale state.
            fetch("/api/auth/shared-cache", { method: "DELETE" }).catch(() => { });
        },
    });
    // Expose the pull-side as a one-shot async function the bootstrap
    // can await before MSAL initializes.
    window.__azbmSyncSharedCache = () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const resp = yield fetch("/api/auth/shared-cache", {
                method: "GET",
                headers: { Accept: "application/json" },
            });
            if (!resp.ok) {
                // Server unreachable / errored — open the gate anyway so local
                // mutations still propagate when the server comes back.
                pulledOnce = true;
                return;
            }
            const remote = (yield resp.json());
            let applied = 0;
            for (const [k, v] of Object.entries(remote)) {
                if (typeof v !== "string" || !isSharedKey(k))
                    continue;
                origSet(k, v);
                applied += 1;
            }
            if (applied > 0) {
                console.log(`[shared-cache] hydrated ${applied} keys from server snapshot`);
            }
        }
        catch (_d) {
            /* offline-tolerant */
        }
        finally {
            // Flip the push gate only after the read attempt has settled.
            // From here on every local cache mutation propagates upward.
            pulledOnce = true;
        }
    });
}
// Diagnostic: log every BroadcastChannel creation, postMessage, and received
// message so we can see whether MSAL's popup → parent broadcast flow is
// actually delivering. Active in BOTH the main tab and the popup tab.
if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    const OrigBC = window.BroadcastChannel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.BroadcastChannel = class extends OrigBC {
        constructor(name) {
            super(name);
            console.log("[BC] open name=", name);
            this.addEventListener("message", (event) => {
                console.log("[BC] recv on", name, "data=", JSON.stringify(event.data).slice(0, 120));
            });
        }
        postMessage(msg) {
            console.log("[BC] post on", this.name, "data=", JSON.stringify(msg).slice(0, 120));
            return super.postMessage(msg);
        }
    };
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
    //
    // Fallback layer: in some browser configurations (privacy extensions,
    // restricted contexts, BroadcastChannel disabled) the BroadcastChannel
    // post never reaches the parent. We ALSO send a postMessage to
    // window.opener with the raw URL payload so the parent can drive a
    // re-broadcast through an iframe (which is a different browsing
    // context and will be received by MSAL's BroadcastChannel listener).
    document.title = "Signing in...";
    document.body.innerText = "";
    try {
        if (window.opener && !window.opener.closed) {
            const payload = window.location.hash.length > 1
                ? window.location.hash.substring(1)
                : window.location.search.length > 1
                    ? window.location.search.substring(1)
                    : "";
            // Forward the raw URL payload — opener decodes the state's
            // correlation id from it and replays the broadcast. Use "*" for the
            // target origin because we don't know if the opener is on the same
            // exact URL/path; same-origin is enforced by window.opener access.
            window.opener.postMessage({ type: "azbm-popup-response", payload }, "*");
            console.log("[MSAL Popup] postMessage fallback sent to opener");
        }
    }
    catch (err) {
        console.warn("[MSAL Popup] postMessage fallback failed:", err);
    }
    broadcastResponseToMainFrame().catch((err) => {
        console.error("[MSAL Popup] broadcastResponseToMainFrame error:", err);
        // Safety-net: close the popup so the user isn't left stranded
        setTimeout(() => {
            try {
                window.close();
            }
            catch (_a) {
                /**/
            }
        }, 500);
    });
}
else {
    // Bootstrap the app
    const rootEl = document.getElementById("batch-explorer-root");
    if (!rootEl) {
        throw new Error("Failed to initialize: No element with an ID of 'batch-explorer-root' found.");
    }
    init(rootEl);
}
/**
 * Render a minimal "Boot failed" message into the root element when init()
 * throws before React has a chance to mount. Today the most common failure
 * mode is `loadTranslations` returning 5xx, which previously left the page
 * blank with the error only visible in DevTools.
 */
function renderBootFailure(rootEl, err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown boot error";
    try {
        rootEl.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.setAttribute("role", "alert");
        wrap.style.cssText =
            "min-height:100vh;display:flex;align-items:center;justify-content:center;" +
                "flex-direction:column;gap:1rem;padding:2rem;font-family:Segoe UI,system-ui," +
                "-apple-system,BlinkMacSystemFont,sans-serif;color:#1f2937;background:#f9fafb;";
        const h = document.createElement("h1");
        h.textContent = "Boot failed.";
        h.style.cssText = "margin:0;font-size:1.25rem;font-weight:600;";
        const p = document.createElement("p");
        p.textContent = message;
        p.style.cssText = "margin:0;color:#6b7280;max-width:560px;text-align:center;";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "Reload";
        btn.style.cssText =
            "padding:0.5rem 1rem;border:1px solid #2563eb;background:#2563eb;" +
                "color:white;border-radius:6px;cursor:pointer;font-weight:500;";
        btn.addEventListener("click", () => window.location.reload());
        wrap.appendChild(h);
        wrap.appendChild(p);
        wrap.appendChild(btn);
        rootEl.appendChild(wrap);
    }
    catch (fatalErr) {
        // The DOM API itself failed — last-ditch fallback so the user sees something.
        console.error("[init] renderBootFailure itself threw", fatalErr);
        try {
            rootEl.textContent = `Boot failed: ${message}`;
        }
        catch (_a) {
            /* nothing more we can do */
        }
    }
}
export function init(rootEl) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Pull the cross-browser shared MSAL cache from the dev-server BEFORE
            // anything else touches localStorage. This way MSAL's first read sees
            // accounts that were signed in from any other browser. Failure is
            // tolerated — the WebUI degrades to per-browser cache like before.
            try {
                yield ((_b = (_a = window).__azbmSyncSharedCache) === null || _b === void 0 ? void 0 : _b.call(_a));
            }
            catch (_d) {
                /* offline-tolerant */
            }
            const localizer = new HttpLocalizer();
            yield localizer.loadTranslations("/resources/i18n");
            initEnvironment(new DefaultBrowserEnvironment({
                mode: (_c = ENV.MODE) !== null && _c !== void 0 ? _c : EnvironmentMode.Development,
                armUrl: "https://management.azure.com",
            }, {
                [DependencyName.Clock]: () => new StandardClock(),
                [DependencyName.LoggerFactory]: () => createConsoleLogger,
                [DependencyName.Localizer]: () => localizer,
                [DependencyName.HttpClient]: () => new MockHttpClient(),
                [DependencyName.LocationService]: () => new FakeLocationService(),
                [DependencyName.Notifier]: () => new AlertNotifier(),
                [DependencyName.CacheManager]: () => new MemoryCacheManager(),
                [BatchDependencyName.PoolService]: () => new FakePoolService(),
                [BatchDependencyName.NodeService]: () => new FakeNodeService(),
                [BatchDependencyName.AccountService]: () => new FakeAccountService(),
                [DependencyName.ResourceGroupService]: () => new FakeResourceGroupService(),
                [DependencyName.StorageAccountService]: () => new FakeStorageAccountService(),
                [DependencyName.SubscriptionService]: () => new FakeSubscriptionService(),
                [BrowserDependencyName.FormControlResolver]: () => new BatchFormControlResolver(),
                [BrowserDependencyName.FormLayoutProvider]: () => new DefaultFormLayoutProvider(),
            }));
            // Sticky tasks: load any persisted task records and reclassify
            // anything left `running` as `interrupted`. Must run before <Application>
            // mounts so the Task Manager UI sees the correct boot state.
            taskRuntime.bootstrap();
            // React 18: createRoot replaces ReactDOM.render. The MSAL popup branch
            // above never reaches this path — popups must NOT mount React.
            createRoot(rootEl).render(React.createElement(Application, null));
        }
        catch (err) {
            // Boot-time failure. Surface a minimal DOM message so the user isn't
            // staring at a blank page — most often this fires when /resources/i18n
            // 5xx's during a partial dev-server restart.
            console.error("[init] boot failed:", err);
            renderBootFailure(rootEl, err);
        }
    });
}
//# sourceMappingURL=index.js.map