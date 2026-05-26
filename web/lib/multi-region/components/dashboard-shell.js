import { __awaiter } from "tslib";
/**
 * Dashboard chrome — composes the sidebar, header bars, page router, and
 * global overlays (activity panel, command menu, keyboard help, toasts).
 * Replaces the legacy `DashboardContent` in `multi-region-dashboard.tsx`.
 */
import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Progress } from "@/components/ui/progress";
import { RequestScheduler, DEFAULT_SCHEDULER_OPTIONS, } from "../scheduling/request-scheduler";
import { getSharedRequestGuard } from "../scheduling/request-governance";
import { OrchestratorAgent } from "../agents/orchestrator-agent";
import * as msalAuth from "../auth/msal-auth";
import { setAuditLogger as setAuthAuditLogger } from "../auth/audit-binding";
import { invalidateAllCachesForTenantChange } from "../services/cache-invalidation";
import { auditLog } from "../services/audit-log";
import { wireAuditLoggers } from "../services/audit-wiring";
import { installDefaultAuditWiring } from "../services/audit-binding";
import { useTenantChange } from "../hooks/use-tenant-change";
import { useMultiRegionState, useMultiRegionStore, } from "../store/store-context";
import { useShortcut } from "../hooks/use-shortcut";
import { AuthBanner } from "./auth-banner";
import { AppHeader } from "./app-header";
import { PageRouter, PAGE_ORDER, pageKeyToPath, pathToPageKey, } from "./page-router";
import { purgeAccountsCache } from "./azure-accounts/azure-accounts-page";
import { SidebarNav } from "./shared/sidebar-nav";
import { ActivityPanel } from "./shared/activity-panel";
import { StickyTasksPanel } from "./shared/sticky-tasks-panel";
import { TaskAutoResumer } from "./task-manager/task-auto-resumer";
import { AgentLogPanel } from "./shared/agent-log-panel";
import { ToastContainer } from "./shared/toast-container";
import { CommandMenu } from "./shared/command-menu";
import { ConnectedKeyboardHelp } from "./shared/keyboard-help-dialog";
import { BreadcrumbBar } from "./shared/breadcrumb-bar";
// ---------------------------------------------------------------------------
// Module-private helpers (pure functions — no module-level mutable state)
// ---------------------------------------------------------------------------
function getAccessTokenFromCli(tenantId) {
    return __awaiter(this, void 0, void 0, function* () {
        return msalAuth.getArmToken(tenantId);
    });
}
function getBatchAccessTokenFromCli(tenantId) {
    return __awaiter(this, void 0, void 0, function* () {
        return msalAuth.getBatchToken(tenantId);
    });
}
function performHealthCheck(tokenProvider) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        if (tokenProvider) {
            return tokenProvider.checkHealth();
        }
        // Web mode: MSAL popup auth — check for active user first.
        // Authentication is healthy if MSAL has a valid signed-in account.
        // Token-acquisition failures for individual tenants are NOT treated
        // as "not signed in"; the per-tenant token cache handles those errors.
        try {
            const user = yield msalAuth.getCurrentUser();
            if (!user) {
                return {
                    healthy: false,
                    error: "Not signed in. Click 'Sign in with Azure' to authenticate via Entra ID.",
                };
            }
            let armOk = false;
            try {
                const armToken = yield msalAuth.getArmToken();
                armOk = !!armToken;
            }
            catch (_c) {
                armOk = false;
            }
            if (!armOk) {
                return {
                    healthy: false,
                    error: `Signed in as ${(_b = (_a = user.username) !== null && _a !== void 0 ? _a : user.name) !== null && _b !== void 0 ? _b : "Azure user"}, but ARM token acquisition failed. Try Refresh.`,
                };
            }
            try {
                yield msalAuth.getBatchToken();
            }
            catch (_d) {
                // Batch token failures aren't fatal here; per-account probes handle it.
            }
            try {
                yield msalAuth.listSubscriptions();
            }
            catch (_e) {
                // Subscription listing is best-effort; auth is still healthy.
            }
            return { healthy: true, error: null };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const noAccount = /no[_ ]account/i.test(msg) ||
                /No account object provided/i.test(msg) ||
                /Click 'Sign in with Azure'/i.test(msg);
            if (noAccount) {
                return {
                    healthy: false,
                    error: "Not signed in. Click 'Sign in with Azure' to authenticate via Entra ID.",
                };
            }
            return { healthy: false, error: msg };
        }
    });
}
function loadSubscriptions(store) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        // Union subscriptions across EVERY signed-in MSAL account, not just
        // the primary. Each sub is tagged with the homeAccountId of the
        // account that holds it so downstream consumers (account-creation
        // picker, orchestrator's token routing) can request a token for the
        // right account when the same browser has multiple operators or
        // multiple Azure logins.
        //
        // Falls back to `msalAuth.listSubscriptions()` (primary-account only)
        // when no signed-in accounts have surfaced yet — the per-account list
        // populates after the Azure Accounts page mounts and probes each
        // account's subs in parallel.
        try {
            const accounts = yield msalAuth.getAllLoggedInAccounts();
            if (!accounts || accounts.length === 0) {
                // No signed-in accounts at all — try the active-account path so
                // the picker isn't empty when MSAL initializes after this runs.
                const subs = yield msalAuth.listSubscriptions();
                const enabledSubs = subs
                    .filter((s) => { var _a; return ((_a = s.state) !== null && _a !== void 0 ? _a : "Enabled") === "Enabled"; })
                    .map((s) => ({
                    subscriptionId: s.subscriptionId,
                    displayName: s.displayName,
                    tenantId: s.tenantId,
                }));
                store.setSubscriptions(enabledSubs);
                return;
            }
            // Parallel fetch — one ARM round-trip per account. Errors per
            // account are tolerated; we surface whatever resolves.
            const perAccount = yield Promise.allSettled(accounts.map((a) => __awaiter(this, void 0, void 0, function* () {
                const subs = yield msalAuth.listSubscriptionsForAccount(a.homeAccountId);
                return { account: a, subs };
            })));
            // Dedupe by subscriptionId — if the same sub is visible to two
            // signed-in accounts (e.g. cross-tenant guest), the FIRST account
            // that returns it wins. The picker still shows owner labels so the
            // operator can tell which account a sub came from.
            const seen = new Set();
            const merged = [];
            for (const result of perAccount) {
                if (result.status !== "fulfilled")
                    continue;
                const { account, subs } = result.value;
                const label = account.name || account.username || account.homeAccountId;
                for (const s of subs) {
                    if (((_a = s.state) !== null && _a !== void 0 ? _a : "Enabled") !== "Enabled")
                        continue;
                    if (seen.has(s.subscriptionId))
                        continue;
                    seen.add(s.subscriptionId);
                    merged.push({
                        subscriptionId: s.subscriptionId,
                        displayName: s.displayName,
                        tenantId: s.tenantId,
                        homeAccountId: account.homeAccountId,
                        ownerAccountLabel: label,
                    });
                }
            }
            store.setSubscriptions(merged);
        }
        catch (_b) {
            // Subscriptions are optional — failure is non-fatal here.
        }
    });
}
// Adapter: the singleton `auditLog` (services) requires `actor`/`target`
// as strings; the agents pod's `AgentAuditLogger` treats them as
// optional. Bridge here so every audit-record from an agent lands in
// the same store-backed log without forcing agent callers to thread
// the actor/target through every call site.
const AGENT_AUDIT_LOGGER = {
    record(entry) {
        var _a, _b;
        auditLog.record({
            actor: (_a = entry.actor) !== null && _a !== void 0 ? _a : "system",
            action: entry.action,
            target: (_b = entry.target) !== null && _b !== void 0 ? _b : "",
            status: entry.status,
            error: entry.error,
            details: entry.details,
        });
    },
};
function createAgentContext(store, tokenProvider) {
    var _a, _b;
    return {
        store,
        scheduler: new RequestScheduler(DEFAULT_SCHEDULER_OPTIONS),
        armUrl: "https://management.azure.com",
        // Wire the singleton-backed agent audit logger so pool create/delete,
        // node action, account create, tenant switch etc. flow into the store
        // alongside the auth pod's audited events.
        auditLogger: AGENT_AUDIT_LOGGER,
        getAccessToken: (_a = tokenProvider === null || tokenProvider === void 0 ? void 0 : tokenProvider.getAccessToken) !== null && _a !== void 0 ? _a : getAccessTokenFromCli,
        getBatchAccessToken: (_b = tokenProvider === null || tokenProvider === void 0 ? void 0 : tokenProvider.getBatchAccessToken) !== null && _b !== void 0 ? _b : getBatchAccessTokenFromCli,
        // Per-subscription token resolver — looks up sub.homeAccountId from
        // the store (populated by the multi-account loadSubscriptions above)
        // and asks MSAL for that exact account's token. Falls back to the
        // generic getAccessToken path so legacy callers and single-account
        // setups keep working.
        getAccessTokenForSubscription: (subscriptionId) => __awaiter(this, void 0, void 0, function* () {
            var _c, _d;
            const sub = store
                .getState()
                .subscriptions.find((s) => s.subscriptionId === subscriptionId);
            if (sub === null || sub === void 0 ? void 0 : sub.homeAccountId) {
                try {
                    return yield msalAuth.getArmTokenForAccount(sub.homeAccountId);
                }
                catch (err) {
                    // Log so multi-account routing failures aren't invisible —
                    // the primary fallback below may still 401 on this sub.
                    store.addLog({
                        agent: "orchestrator",
                        level: "warn",
                        message: `Per-account ARM token failed for sub ${subscriptionId.slice(0, 8)}… (homeAccountId ${sub.homeAccountId.slice(0, 12)}…): ${(_c = err === null || err === void 0 ? void 0 : err.message) !== null && _c !== void 0 ? _c : String(err)}. Falling back to primary token.`,
                    });
                }
            }
            const fallback = (_d = tokenProvider === null || tokenProvider === void 0 ? void 0 : tokenProvider.getAccessToken) !== null && _d !== void 0 ? _d : getAccessTokenFromCli;
            return fallback(sub === null || sub === void 0 ? void 0 : sub.tenantId);
        }),
        // Per-subscription Batch data-plane token — the parallel of the ARM
        // resolver above but with the `batch.core.windows.net` scope. Pool /
        // node / task agents call this PER ACCOUNT in the dispatch loop so
        // a multi-sub create_pools_smart targeting accounts owned by two
        // different signed-in AAD identities can still hit each account's
        // Batch endpoint with a token that account's tenant accepts.
        getBatchAccessTokenForSubscription: (subscriptionId) => __awaiter(this, void 0, void 0, function* () {
            var _e, _f;
            const sub = store
                .getState()
                .subscriptions.find((s) => s.subscriptionId === subscriptionId);
            if (sub === null || sub === void 0 ? void 0 : sub.homeAccountId) {
                try {
                    return yield msalAuth.getBatchTokenForAccount(sub.homeAccountId, sub.tenantId);
                }
                catch (err) {
                    store.addLog({
                        agent: "orchestrator",
                        level: "warn",
                        message: `Per-account Batch token failed for sub ${subscriptionId.slice(0, 8)}… (homeAccountId ${sub.homeAccountId.slice(0, 12)}…): ${(_e = err === null || err === void 0 ? void 0 : err.message) !== null && _e !== void 0 ? _e : String(err)}. Falling back to primary Batch token.`,
                    });
                }
            }
            const fallback = (_f = tokenProvider === null || tokenProvider === void 0 ? void 0 : tokenProvider.getBatchAccessToken) !== null && _f !== void 0 ? _f : getBatchAccessTokenFromCli;
            return fallback(sub === null || sub === void 0 ? void 0 : sub.tenantId);
        }),
    };
}
function exportSession(store) {
    const json = store.exportSessionAsJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${store.sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
}
const NavShortcut = ({ index, onActivate }) => {
    useShortcut(`Alt+${index}`, () => onActivate(index));
    return null;
};
// ---------------------------------------------------------------------------
// Main shell component
// ---------------------------------------------------------------------------
export const DashboardShell = ({ tokenProvider, }) => {
    var _a;
    const store = useMultiRegionStore();
    // Reactive read of state.subscriptions so the boot-prefetch effect
    // re-runs when subscriptions populate after auth (otherwise the
    // prefetch fires once with subs=[] and never again — leaving the VM
    // Catalog cache empty and the filters with nothing to filter).
    const reactiveState = useMultiRegionState();
    const navigate = useNavigate();
    const location = useLocation();
    const [healthCheck, setHealthCheck] = React.useState(null);
    const [currentAuthMode, setCurrentAuthMode] = React.useState("msal");
    const [msalUserName, setMsalUserName] = React.useState("");
    const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => store.getUserPreferences().sidebarCollapsed);
    // Hydrated from saved user preferences so flipping the toggle off in
    // the header and reloading the browser keeps auto-refresh disabled.
    // The setter wrapper persists the new value to localStorage on every
    // change.
    const [autoRefreshEnabled, _setAutoRefreshEnabled] = React.useState(() => store.getUserPreferences().autoRefreshEnabled);
    const setAutoRefreshEnabled = React.useCallback((next) => {
        _setAutoRefreshEnabled((prev) => {
            const value = typeof next === "function" ? next(prev) : next;
            try {
                store.saveUserPreferences({ autoRefreshEnabled: value });
            }
            catch (_a) {
                /* prefs persistence is best-effort */
            }
            return value;
        });
    }, [store]);
    const [refreshInFlight, setRefreshInFlight] = React.useState(false);
    const [taskManagerOpen, setTaskManagerOpen] = React.useState(false);
    // Lifted command-palette state so the header search-bar button and the
    // Mod+K hotkey can both toggle it.
    const [commandMenuOpen, setCommandMenuOpen] = React.useState(false);
    const openCommandMenu = React.useCallback(() => setCommandMenuOpen(true), []);
    useShortcut("Mod+K", () => setCommandMenuOpen((p) => !p));
    const autoRefreshRunningRef = React.useRef(false);
    const orchestrator = React.useMemo(() => new OrchestratorAgent(createAgentContext(store, tokenProvider)), [store, tokenProvider]);
    // Release the previous orchestrator's resources (telemetry sink,
    // background timers added in future) when `store`/`tokenProvider`
    // change and `useMemo` produces a fresh instance. Without this the
    // old orchestrator's telemetry sink lingers in the shared guard and
    // every tenant-switch leaks one more sink.
    React.useEffect(() => {
        return () => {
            var _a;
            (_a = orchestrator.dispose) === null || _a === void 0 ? void 0 : _a.call(orchestrator);
        };
    }, [orchestrator]);
    // Wire the rate-limit guard's telemetry into the store so the Throttle
    // page can render live circuit state, refill rates, and transitions.
    // The guard is a process-singleton; we install once on mount and the
    // returned unsubscribe runs on unmount. `addTelemetrySink` (not the
    // legacy `setTelemetry`) so we coexist with the orchestrator's own
    // sink — both sinks now receive every event instead of clobbering.
    React.useEffect(() => {
        const guard = getSharedRequestGuard();
        const unsubscribe = guard.addTelemetrySink({
            setEntry: (subscriptionId, family, entry) => store.setThrottleStatusEntry(subscriptionId, family, entry),
            pushTransition: (t) => store.pushThrottleTransition(t),
            critical: (msg) => store.addLog({ agent: "orchestrator", level: "error", message: msg }),
        });
        return unsubscribe;
    }, [store]);
    // One-time audit-log wiring:
    //   1) `installDefaultAuditWiring` binds the singleton's events into
    //      the store so every recorded entry lands in `state.auditEntries`
    //      and the Audit Log page renders them.
    //   2) `wireAuditLoggers` hands the singleton to the auth pod via the
    //      global `setAuthAuditLogger` DI setter, so token-mints, FOCI
    //      exchanges, vault put/remove, tenant-switch and logout flow
    //      through the same singleton.
    //   3) The agents pod uses a *different* DI path — it receives the
    //      logger per-instance via `AgentContext.auditLogger` (see
    //      `createAgentContext` above). The `wireAuditLoggers` second
    //      argument is therefore a deliberate no-op (the constructor
    //      injection above already covers the agents path).
    React.useEffect(() => {
        const unbind = installDefaultAuditWiring(store);
        wireAuditLoggers(setAuthAuditLogger, () => {
            /* agents pod uses AgentContext.auditLogger; no global setter */
        });
        return () => {
            unbind();
        };
    }, [store]);
    // Global tenant-change listener — every page that holds tenant-scoped
    // state (per-tenant ARM token, per-tenant Graph cache) needs to drop
    // it the moment the operator flips the active tenant in the sidebar
    // or via the Azure Accounts page. The cache-invalidation singleton
    // does the heavy lifting; we just trigger it once + show a toast so
    // the operator sees the switch landed.
    useTenantChange(undefined, (detail) => {
        var _a;
        try {
            invalidateAllCachesForTenantChange("tenant-switch");
        }
        catch (_b) {
            /* cache invalidation is best-effort — never block the switch */
        }
        try {
            // Reset the orchestrator's account-discovery so the next render
            // re-runs the discover flow against the new tenant.
            store.setAzureAccounts(((_a = store.getState().azureAccounts) !== null && _a !== void 0 ? _a : []).map((a) => a.homeAccountId === detail.homeAccountId
                ? Object.assign(Object.assign({}, a), { status: "loading", error: null }) : a));
        }
        catch (_c) {
            /* store snapshots are immutable enough that this is a no-op */
        }
        store.addNotification({
            type: "info",
            message: `Switched to tenant ${detail.tenantId.slice(0, 8)}…`,
        });
    });
    // ---- Derived nav state -------------------------------------------------
    const activeKey = (_a = pathToPageKey(location.pathname)) !== null && _a !== void 0 ? _a : "azure-accounts";
    const handleNavigate = React.useCallback((key) => navigate(pageKeyToPath(key)), [navigate]);
    const handleNavByIndex = React.useCallback((index) => {
        const target = PAGE_ORDER[index - 1];
        if (target)
            navigate(pageKeyToPath(target));
    }, [navigate]);
    const toggleTaskManager = React.useCallback(() => setTaskManagerOpen((p) => !p), []);
    const handleToggleSidebar = React.useCallback(() => {
        setSidebarCollapsed((c) => {
            store.saveUserPreferences({ sidebarCollapsed: !c });
            return !c;
        });
    }, [store]);
    // ---- Auth handlers -----------------------------------------------------
    const checkLogin = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        setHealthCheck(null);
        const result = yield performHealthCheck(tokenProvider);
        setHealthCheck(result);
        if (result.healthy) {
            if (tokenProvider) {
                yield tokenProvider.loadSubscriptions(store);
            }
            else {
                yield loadSubscriptions(store);
            }
        }
        return result;
    }), [store, tokenProvider]);
    // After login: sync all MSAL accounts + their subscriptions into store
    // so the Azure Accounts page reflects the new account immediately.
    const syncAccountsToStore = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const msalAccounts = yield msalAuth.getAllLoggedInAccounts();
            if (msalAccounts.length === 0)
                return;
            store.setAzureAccounts(msalAccounts.map((acct) => {
                var _a, _b, _c, _d, _e;
                return ({
                    homeAccountId: acct.homeAccountId,
                    localAccountId: acct.localAccountId,
                    username: (_a = acct.username) !== null && _a !== void 0 ? _a : "",
                    name: (_c = (_b = acct.name) !== null && _b !== void 0 ? _b : acct.username) !== null && _c !== void 0 ? _c : "",
                    tenantId: (_d = acct.tenantId) !== null && _d !== void 0 ? _d : "",
                    environment: (_e = acct.environment) !== null && _e !== void 0 ? _e : "",
                    subscriptions: [],
                    subscriptionCount: 0,
                    status: "loading",
                    error: null,
                    addedAt: new Date().toISOString(),
                });
            }));
            // Sequential to avoid bursting downstream throttles.
            for (const acct of msalAccounts) {
                try {
                    const subs = yield msalAuth.listSubscriptionsForAccount(acct.homeAccountId);
                    // subscriptionCount tracks Enabled subs only — disclosure on the
                    // Azure Accounts page surfaces the disabled remainder via
                    // `subscriptions[]`.
                    const enabledCount = subs.filter((s) => { var _a; return ((_a = s.state) !== null && _a !== void 0 ? _a : "Enabled") === "Enabled"; }).length;
                    // ArmSubscription and AzureLoginSubscription are structurally
                    // identical ({ subscriptionId, displayName, state, tenantId }) —
                    // map explicitly so any future drift becomes a compile error
                    // instead of a silent `as any` cast.
                    store.updateAzureAccount(acct.homeAccountId, {
                        subscriptions: subs.map((s) => ({
                            subscriptionId: s.subscriptionId,
                            displayName: s.displayName,
                            state: s.state,
                            tenantId: s.tenantId,
                        })),
                        subscriptionCount: enabledCount,
                        status: "active",
                        error: null,
                    });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : "Failed to load subscriptions";
                    store.updateAzureAccount(acct.homeAccountId, {
                        status: "error",
                        error: msg,
                    });
                }
                yield new Promise((r) => setTimeout(r, 300));
            }
        }
        catch (_b) {
            // Best-effort — Azure Accounts page has its own Refresh button.
        }
    }), [store]);
    // Tracks whether a login popup is currently open so the AppHeader can
    // disable the menu item and the auth banner can show a "popup is open"
    // indicator. Distinct from MSAL's internal `_loginInProgress` lock so the
    // UI stays responsive even if the lock stalls.
    const [loginInProgress, setLoginInProgress] = React.useState(false);
    /**
     * Open the MSAL popup to add an Azure account.
     *
     * Always calls `loginAccount()` with `prompt: "select_account"` (via the
     * msal-auth module) so the picker opens for EVERY click — even after a
     * successful first login. Re-entry is guarded by the local
     * `loginInProgress` state so a double-click can't race the popup.
     *
     * If the underlying `_loginInProgress` lock in msal-auth somehow stalls,
     * the watchdog in `loginAccount` (added in this commit) clears it after
     * 90 s so subsequent clicks aren't permanently wedged.
     */
    const handleLogin = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _c, _d, _e, _f;
        if (loginInProgress)
            return;
        setLoginInProgress(true);
        try {
            const account = yield msalAuth.loginAccount();
            if (account) {
                setCurrentAuthMode("msal");
                setMsalUserName((_d = (_c = account.username) !== null && _c !== void 0 ? _c : account.name) !== null && _d !== void 0 ? _d : "Azure User");
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Popup may have closed/timed out; we still re-check below.
            console.warn("[MSAL] Popup closed/error, checking if auth succeeded anyway:", msg);
        }
        finally {
            setLoginInProgress(false);
        }
        yield new Promise((r) => setTimeout(r, 500));
        const result = yield checkLogin();
        if (!(result === null || result === void 0 ? void 0 : result.healthy)) {
            const user = yield msalAuth.getCurrentUser();
            if (user) {
                setCurrentAuthMode("msal");
                setMsalUserName((_f = (_e = user.username) !== null && _e !== void 0 ? _e : user.name) !== null && _f !== void 0 ? _f : "Azure User");
                yield checkLogin();
            }
        }
        yield syncAccountsToStore();
    }), [checkLogin, syncAccountsToStore, loginInProgress]);
    const handleLogout = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield msalAuth.logout();
            setCurrentAuthMode("cli");
            setMsalUserName("");
            setHealthCheck(null);
        }
        catch (_g) {
            // Logout errors are non-fatal — local state is already cleared.
        }
    }), []);
    /**
     * Hard recovery: wipe every MSAL key from localStorage and reload the
     * page. Use when the cached refresh token has gone stale and silent
     * flows keep returning 400 from the proxied /token endpoint. This is
     * the user-visible escape hatch for "everything looks signed in but
     * nothing works."
     */
    const handleClearSignInCache = React.useCallback(() => {
        try {
            msalAuth.purgeMsalCache();
        }
        catch (_a) {
            // Best-effort — even partial cache clear is better than nothing.
        }
        // Drop the app-level saved-accounts snapshot too. Without this the
        // localStorage entry survives the MSAL purge and the page repaints
        // every stale row as "Session expired" on the next load — the exact
        // stuck-banner the user hit ("20 accounts failed to load
        // subscriptions" persisting after Clear cache).
        try {
            purgeAccountsCache();
        }
        catch (_b) {
            /* best-effort */
        }
        // Reload so a fresh MSAL instance is constructed and the
        // performHealthCheck path runs from a clean slate.
        if (typeof window !== "undefined") {
            window.location.reload();
        }
    }, []);
    /**
     * Switch the persisted login mode (CLI client vs Portal-style client),
     * purge the MSAL + accounts caches so the new clientId starts from a
     * clean slate, and reload. Reload is required because the MSAL config
     * is read once at instance init time.
     */
    const handleSetLoginMode = React.useCallback((mode, customClientId) => {
        const prev = msalAuth.getStoredLoginMode();
        const prevCustom = msalAuth.getStoredCustomClientId();
        // Skip the reload only when the choice is truly a no-op. Custom
        // mode with the same GUID is also a no-op.
        if (mode === prev &&
            (mode !== "custom" || (customClientId !== null && customClientId !== void 0 ? customClientId : "") === prevCustom)) {
            return;
        }
        if (mode === "custom" && customClientId) {
            msalAuth.setStoredCustomClientId(customClientId);
        }
        msalAuth.setStoredLoginMode(mode);
        try {
            msalAuth.purgeMsalCache();
        }
        catch (_a) {
            /* best-effort */
        }
        try {
            purgeAccountsCache();
        }
        catch (_b) {
            /* best-effort */
        }
        if (typeof window !== "undefined") {
            window.location.reload();
        }
    }, []);
    // ---- Effects -----------------------------------------------------------
    // Initial mount: wait for MSAL to process redirect, then check auth +
    // populate the store's azureAccounts list. Without the sync, restored
    // MSAL sessions leave `state.azureAccounts` empty until the user
    // navigates to the Azure Accounts page (which has its own loader),
    // which makes other pages' RBAC pre-flights falsely report "No Azure
    // AD account connected" until the user navigates and back.
    React.useEffect(() => {
        let cancelled = false;
        (() => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            const user = yield msalAuth.getCurrentUser();
            if (cancelled)
                return;
            if (user) {
                setCurrentAuthMode("msal");
                setMsalUserName((_b = (_a = user.username) !== null && _a !== void 0 ? _a : user.name) !== null && _b !== void 0 ? _b : "Azure User");
            }
            const result = yield checkLogin();
            if (cancelled)
                return;
            // If auth landed cleanly (or even partially — getCurrentUser != null),
            // mirror MSAL's accounts into the store so every page sees them.
            if (user || (result === null || result === void 0 ? void 0 : result.healthy)) {
                yield syncAccountsToStore();
            }
        }))();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Auto-save session via store helper.
    React.useEffect(() => store.enableAutoSave(), [store]);
    // Keep state.subscriptions in sync with state.azureAccounts. Each
    // azureAccount carries its own .subscriptions list (populated when
    // azure-accounts-page or syncAccountsToStore probes ARM); the
    // shell-level state.subscriptions is the UNION used by every page's
    // subscription picker. Without this effect, signing into a second
    // account after the initial loadSubscriptions() left state.subscriptions
    // showing only the original account's subs, and the picker on
    // account-creation / pool-creation never updated. Now any change to
    // azureAccounts (add, remove, refresh) propagates through to the
    // multi-account union immediately.
    React.useEffect(() => {
        var _a, _b, _c, _d;
        const accounts = (_a = reactiveState.azureAccounts) !== null && _a !== void 0 ? _a : [];
        if (accounts.length === 0)
            return;
        const merged = [];
        const seen = new Set();
        for (const acct of accounts) {
            const label = acct.name || acct.username || acct.homeAccountId;
            for (const s of (_b = acct.subscriptions) !== null && _b !== void 0 ? _b : []) {
                if (((_c = s.state) !== null && _c !== void 0 ? _c : "Enabled") !== "Enabled")
                    continue;
                if (seen.has(s.subscriptionId))
                    continue;
                seen.add(s.subscriptionId);
                merged.push({
                    subscriptionId: s.subscriptionId,
                    displayName: s.displayName,
                    tenantId: s.tenantId,
                    homeAccountId: acct.homeAccountId,
                    ownerAccountLabel: label,
                });
            }
        }
        // Cheap diff: only call setSubscriptions when the IDs actually
        // changed, otherwise we'd churn a fresh array reference on every
        // azureAccounts update and re-render every picker.
        const prev = (_d = store.getState().subscriptions) !== null && _d !== void 0 ? _d : [];
        if (prev.length !== merged.length ||
            prev.some((p, i) => p.subscriptionId !== merged[i].subscriptionId ||
                p.homeAccountId !== merged[i].homeAccountId)) {
            store.setSubscriptions(merged);
        }
    }, [reactiveState.azureAccounts, store]);
    // Reload guard: warn the user before navigating away if any sticky
    // task is still running. Browsers ignore the message string and show
    // a generic "Leave site?" dialog, but the prompt itself is enough to
    // prevent an accidental Cmd+R / X-tab from killing a half-finished
    // 10-region account creation.
    //
    // We deliberately do NOT trigger this from JavaScript — only from
    // user navigation. The auto-resumer handles the case where the user
    // confirms (or hits reload anyway) and returns to a freshly mounted
    // tab with interrupted records.
    React.useEffect(() => {
        if (typeof window === "undefined")
            return;
        const handler = (e) => {
            // Lazy import to avoid a circular ref on shell hot-reload.
            // taskRuntime is the source of truth; the store's perSubscription
            // throttle entries are not relevant here.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { taskRuntime } = require("../store/task-runtime");
            const running = taskRuntime
                .list()
                .filter((t) => t.status === "running" || t.status === "paused").length;
            if (running === 0)
                return undefined;
            // Modern browsers ignore the returnValue/string but DO show a
            // generic confirm dialog if either is non-empty.
            const msg = `${running} task${running === 1 ? "" : "s"} still running. Reloading will interrupt them — they'll auto-resume on reopen, but in-flight work is restarted.`;
            e.preventDefault();
            e.returnValue = msg;
            return msg;
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, []);
    // Background prefetch of the GPU VM-SKU catalog for every visible
    // subscription. Runs once after auth lands; the listAllVmSkus call
    // checks the persisted 7-day cache first and is a no-op when fresh.
    // The whole point: by the time the user opens the VM Catalog page,
    // data is already in localStorage and renders instantly. Failures
    // are silent — the page itself surfaces errors when the user lands.
    React.useEffect(() => {
        var _a;
        if (!(healthCheck === null || healthCheck === void 0 ? void 0 : healthCheck.healthy))
            return;
        const subs = (_a = reactiveState.subscriptions) !== null && _a !== void 0 ? _a : [];
        if (subs.length === 0)
            return;
        let cancelled = false;
        (() => __awaiter(void 0, void 0, void 0, function* () {
            var _b;
            // Lazy-imported so the dashboard shell doesn't carry the catalog
            // service in its initial chunk.
            const { listAllVmSkus, isGpuSkuName } = yield import("../services/quota-service");
            for (const sub of subs) {
                if (cancelled)
                    break;
                try {
                    const tenant = sub.tenantId;
                    const account = (_b = (yield msalAuth.getAllLoggedInAccounts()).find((a) => a.tenantId === tenant)) !== null && _b !== void 0 ? _b : (yield msalAuth.getAllLoggedInAccounts())[0];
                    if (!account)
                        continue;
                    const token = yield msalAuth.getArmTokenForAccount(account.homeAccountId, tenant);
                    // GPU-only filter — matches the catalog page's default scope
                    // so they share a cache key. listAllVmSkus short-circuits on
                    // a fresh cache hit, so this is cheap on subsequent boots.
                    yield listAllVmSkus(sub.subscriptionId, token, {
                        filter: (s) => isGpuSkuName(s.name),
                    });
                }
                catch (_c) {
                    // Per-sub failures are non-fatal; the catalog page can retry
                    // on demand.
                }
            }
        }))();
        return () => {
            cancelled = true;
        };
        // Subscribed to reactiveState.subscriptions specifically — this
        // effect re-runs the moment subs populate after sign-in, NOT just
        // once at the moment healthCheck flips healthy. The previous dep
        // array missed the post-sign-in sub population, leaving the VM
        // catalog cache permanently empty unless the user manually
        // navigated to /vm-catalog.
    }, [healthCheck === null || healthCheck === void 0 ? void 0 : healthCheck.healthy, reactiveState.subscriptions]);
    // Auto-discover ALL resources after successful auth.
    //
    // CRITICAL: gate on `reactiveState.subscriptions.length > 0` so the
    // discovery only fires AFTER `loadSubscriptions` has populated the
    // store with subs from EVERY signed-in MSAL account (each tagged with
    // its owning homeAccountId). Without this gate the effect fires the
    // moment auth lands — but `loadSubscriptions` is still in flight, so
    // `state.subscriptions.length === 0` and the orchestrator falls back
    // to `listSubscriptions(primaryToken)` which only sees the primary
    // account's subs. Multi-account browsers ended up with Account Info
    // showing 14 (primary's) out of 60+ across all signed-in identities.
    React.useEffect(() => {
        if (!(healthCheck === null || healthCheck === void 0 ? void 0 : healthCheck.healthy))
            return;
        if (reactiveState.subscriptions.length === 0)
            return;
        let cancelled = false;
        (() => __awaiter(void 0, void 0, void 0, function* () {
            setRefreshInFlight(true);
            try {
                yield orchestrator.execute({
                    action: "discover_accounts",
                    payload: {},
                });
                if (cancelled)
                    return;
                yield orchestrator.execute({
                    action: "refresh_pool_info",
                    payload: {},
                });
                yield orchestrator.execute({
                    action: "refresh_account_info",
                    payload: {},
                });
                if (cancelled)
                    return;
                if (store.getState().poolInfos.length > 0) {
                    yield orchestrator.execute({
                        action: "list_nodes",
                        payload: {},
                    });
                }
            }
            catch (_a) {
                // Errors are surfaced through the agent log / activity panel.
            }
            finally {
                // Initial snapshot after first discovery — kick-starts the
                // sparkline / cluster-health buffers so the Overview page has
                // something to render before the first 60s refresh tick.
                if (!cancelled) {
                    try {
                        store.recordHistorySnapshot();
                    }
                    catch (_b) {
                        /* best-effort */
                    }
                    setRefreshInFlight(false);
                }
            }
        }))();
        return () => {
            cancelled = true;
        };
    }, [
        healthCheck === null || healthCheck === void 0 ? void 0 : healthCheck.healthy,
        reactiveState.subscriptions.length,
        orchestrator,
        store,
    ]);
    // Imperatively run a full data refresh. Used by both the periodic
    // auto-refresh interval below and the AppHeader's "Refresh all" button
    // (also surfaced as Mod+R via useShortcut in the header).
    const triggerRefreshAll = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (autoRefreshRunningRef.current)
            return;
        if (store.getState().accounts.length === 0)
            return;
        autoRefreshRunningRef.current = true;
        setRefreshInFlight(true);
        try {
            yield orchestrator.execute({
                action: "refresh_pool_info",
                payload: {},
            });
            yield orchestrator.execute({
                action: "refresh_account_info",
                payload: {},
            });
            if (store.getState().poolInfos.length > 0) {
                yield orchestrator.execute({
                    action: "list_nodes",
                    payload: {},
                });
            }
        }
        catch (_h) {
            // Silent — surfaced through agent log.
        }
        finally {
            // Snapshot the metric totals after every refresh so the Overview
            // sparklines and Cluster Health card always have fresh telemetry.
            try {
                store.recordHistorySnapshot();
            }
            catch (_j) {
                // History is best-effort telemetry — never fail the refresh.
            }
            autoRefreshRunningRef.current = false;
            setRefreshInFlight(false);
        }
    }), [orchestrator, store]);
    // Periodic auto-refresh (60s).
    React.useEffect(() => {
        if (!autoRefreshEnabled)
            return;
        const interval = setInterval(() => {
            void triggerRefreshAll();
        }, 60000);
        return () => clearInterval(interval);
    }, [autoRefreshEnabled, triggerRefreshAll]);
    // ---- Session command-menu handlers ------------------------------------
    const handleSaveSession = React.useCallback(() => {
        const ok = store.saveSession();
        if (ok) {
            store.addNotification({ type: "success", message: "Session saved" });
        }
        else {
            // saveSession() already auto-evicts old sessions + trims agentLogs
            // on quota errors. Reaching this branch means even after eviction
            // the write still didn't fit — usually because OTHER localStorage
            // keys (MSAL token cache, VM-SKU cache, credential vault) own the
            // bulk of the quota. Suggest Export Session as the recovery path.
            store.addNotification({
                type: "error",
                message: "Could not save session — browser storage is full even after auto-evicting old sessions. Use Export Session to download a JSON backup, then clear other site data via DevTools → Application → Storage.",
            });
        }
    }, [store]);
    const handleExportSession = React.useCallback(() => {
        exportSession(store);
    }, [store]);
    // ---- Render ------------------------------------------------------------
    return (React.createElement("div", { className: "flex h-full flex-col bg-background text-foreground" },
        React.createElement("a", { href: "#page-content", className: "sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[10000] focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background" }, "Skip to content"),
        React.createElement("div", { className: "h-0.5", role: "status", "aria-live": "polite", "aria-label": refreshInFlight ? "Loading data" : "Idle" }, refreshInFlight && (React.createElement(Progress, { indeterminate: true, className: "h-0.5 rounded-none bg-transparent" }))),
        Array.from({ length: 9 }, (_, i) => (React.createElement(NavShortcut, { key: i + 1, index: i + 1, onActivate: handleNavByIndex }))),
        React.createElement(AppHeader, { store: store, signedInUserName: msalUserName, authMode: currentAuthMode, autoRefreshEnabled: autoRefreshEnabled, onToggleAutoRefresh: setAutoRefreshEnabled, refreshInFlight: refreshInFlight, onRefreshAll: triggerRefreshAll, onOpenCommandPalette: openCommandMenu, onToggleTaskManager: toggleTaskManager, onLogout: currentAuthMode === "msal" ? handleLogout : undefined, onAddAccount: !tokenProvider ? handleLogin : undefined, loginInProgress: loginInProgress, onClearSignInCache: !tokenProvider ? handleClearSignInCache : undefined, onSetLoginMode: !tokenProvider ? handleSetLoginMode : undefined }),
        React.createElement(AuthBanner, { healthCheck: healthCheck, onRetry: checkLogin, onLogin: !tokenProvider ? handleLogin : undefined, onLogout: currentAuthMode === "msal" ? handleLogout : undefined, authMode: currentAuthMode, userName: msalUserName }),
        React.createElement("div", { className: "flex flex-1 overflow-hidden" },
            React.createElement(SidebarNav, { activeKey: activeKey, onNavigate: handleNavigate, collapsed: sidebarCollapsed, onToggleCollapse: handleToggleSidebar }),
            React.createElement("div", { className: "flex flex-1 flex-col overflow-hidden" },
                React.createElement("div", { className: "border-b border-border px-4 py-2" },
                    React.createElement(BreadcrumbBar, null)),
                React.createElement("main", { id: "page-content", tabIndex: -1, className: "flex-1 overflow-auto px-4 pb-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" },
                    React.createElement(PageRouter, { orchestrator: orchestrator, store: store })))),
        React.createElement(StickyTasksPanel, null),
        React.createElement(TaskAutoResumer, { orchestrator: orchestrator }),
        React.createElement(ActivityPanel, { expanded: taskManagerOpen, onToggle: toggleTaskManager, orchestrator: orchestrator }),
        React.createElement(AgentLogPanel, null),
        React.createElement(ToastContainer, null),
        React.createElement(CommandMenu, { open: commandMenuOpen, onOpenChange: setCommandMenuOpen, onSaveSession: handleSaveSession, onExportSession: handleExportSession, onRefreshAll: triggerRefreshAll, onToggleTheme: undefined /* DarkModeToggle owns theme now */, onSignOut: currentAuthMode === "msal" ? handleLogout : undefined, onClearSignInCache: !tokenProvider ? handleClearSignInCache : undefined }),
        React.createElement(ConnectedKeyboardHelp, null)));
};
//# sourceMappingURL=dashboard-shell.js.map