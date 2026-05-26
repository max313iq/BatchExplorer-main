"use strict";
/**
 * Tests for msal-auth.ts.
 *
 * The module under test owns module-level singletons (the cached MSAL
 * instance, the in-memory account map, the active-account pointer). Each
 * test below resets `jest.modules`, reapplies the `@azure/msal-browser`
 * mock, then `require()`s a fresh copy — this gives every test a clean
 * authentication world without leaking state between cases.
 *
 * KNOWN PRE-EXISTING ISSUE — jest 27's resolver does NOT honor
 * package.json `exports` maps, so the subpath import
 * `@azure/msal-browser/redirect-bridge` cannot be resolved at all. The
 * production code uses a webpack alias to bridge this gap (which
 * doesn't apply to jest). Until the project upgrades jest (>= 28) or
 * adds a `moduleNameMapper` entry pointing at the package's actual
 * CJS file, this test suite will fail to load. The per-test
 * `jest.doMock("@azure/msal-browser/redirect-bridge", …)` below is
 * still useful for any path that DOES manage to resolve the module
 * (e.g. a future jest upgrade).
 *
 * TODO(auth-pod-2026-05-25): once the project lifts jest to 28+, this
 * suite should re-run cleanly without further changes.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
function makeMockMethods() {
    return {
        initialize: jest.fn().mockResolvedValue(undefined),
        acquireTokenSilent: jest.fn(),
        acquireTokenPopup: jest.fn(),
        loginPopup: jest.fn(),
        logoutPopup: jest.fn().mockResolvedValue(undefined),
        getAllAccounts: jest.fn(() => []),
        setActiveAccount: jest.fn(),
        handleRedirectPromise: jest.fn().mockResolvedValue(null),
    };
}
// One InteractionRequiredAuthError class is shared across all suites.
class FakeInteractionRequiredAuthError extends Error {
    constructor(message = "interaction_required") {
        super(message);
        this.name = "InteractionRequiredAuthError";
    }
}
/**
 * Register the @azure/msal-browser mock for the next `require()` cycle and
 * return the mock-methods object that the just-built PublicClientApplication
 * will use. Pair with `jest.resetModules()` so the next import of msal-auth
 * picks the fresh mock up.
 */
function registerMsalMock() {
    const methods = makeMockMethods();
    jest.doMock("@azure/msal-browser", () => ({
        PublicClientApplication: jest.fn().mockImplementation(() => methods),
        InteractionRequiredAuthError: FakeInteractionRequiredAuthError,
    }));
    jest.doMock("@azure/msal-browser/redirect-bridge", () => ({
        broadcastResponseToMainFrame: jest.fn().mockResolvedValue(undefined),
    }));
    return methods;
}
/**
 * AccountInfo factory — only the fields msal-auth.ts actually reads.
 */
function makeAccount(homeAccountId, username = `${homeAccountId}@example.com`) {
    return {
        homeAccountId,
        username,
        environment: "login.microsoftonline.com",
        tenantId: "tenant-default",
        localAccountId: homeAccountId,
    };
}
beforeEach(() => {
    jest.resetModules();
    // Clear our jsdom-backed storages so per-tenant entries don't leak.
    try {
        sessionStorage.clear();
        localStorage.clear();
    }
    catch (_a) {
        // ignore — should always be available under jsdom
    }
    jest.clearAllMocks();
});
// ---------------------------------------------------------------------------
// getCurrentUser / getAllLoggedInAccounts
// ---------------------------------------------------------------------------
describe("getCurrentUser & getAllLoggedInAccounts", () => {
    it("returns null when no accounts are cached and the active pointer is empty", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        const user = yield auth.getCurrentUser();
        expect(user).toBeNull();
    }));
    it("falls back to the first cached MSAL account and promotes it to active", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const cached = makeAccount("home-1");
        methods.getAllAccounts.mockReturnValue([cached]);
        const auth = require("../msal-auth");
        const user = yield auth.getCurrentUser();
        expect(user).toEqual(cached);
        expect(methods.setActiveAccount).toHaveBeenCalledWith(cached);
        // A second call should hit the in-memory cache (no further setActiveAccount).
        methods.setActiveAccount.mockClear();
        const again = yield auth.getCurrentUser();
        expect(again).toEqual(cached);
        expect(methods.setActiveAccount).not.toHaveBeenCalled();
    }));
    it("getAllLoggedInAccounts surfaces every account added to the internal map", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const a = makeAccount("home-a");
        const b = makeAccount("home-b");
        methods.getAllAccounts.mockReturnValue([a, b]);
        const auth = require("../msal-auth");
        const accounts = yield auth.getAllLoggedInAccounts();
        const ids = accounts.map((acc) => acc.homeAccountId);
        expect(ids).toEqual(expect.arrayContaining(["home-a", "home-b"]));
        expect(accounts).toHaveLength(2);
    }));
});
// ---------------------------------------------------------------------------
// login & logout
// ---------------------------------------------------------------------------
describe("login & logout", () => {
    it("login() places the new account into the map and sets it as the primary", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const newAccount = makeAccount("home-login");
        methods.loginPopup.mockResolvedValue({ account: newAccount });
        const auth = require("../msal-auth");
        const result = yield auth.login();
        expect(result).toEqual(newAccount);
        // Subsequent getCurrentUser must return the just-added account.
        const current = yield auth.getCurrentUser();
        expect(current).toEqual(newAccount);
        expect(methods.setActiveAccount).toHaveBeenCalledWith(newAccount);
    }));
    it("login(tenantId) builds a tenant-scoped authority and persists the active tenant", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const newAccount = makeAccount("home-tenant");
        methods.loginPopup.mockResolvedValue({ account: newAccount });
        const auth = require("../msal-auth");
        const result = yield auth.login("tenant-xyz");
        expect(result).toEqual(newAccount);
        const popupArgs = methods.loginPopup.mock.calls[0][0];
        expect(popupArgs.authority).toBe("https://login.microsoftonline.com/tenant-xyz");
        expect(popupArgs.prompt).toBe("select_account");
        // setActiveTenant should have written sessionStorage on success.
        expect(auth.getActiveTenant("home-tenant")).toBe("tenant-xyz");
    }));
    it("login() translates popup_window_error into a friendly 'Popup blocked' error", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        methods.loginPopup.mockRejectedValue({ errorCode: "popup_window_error" });
        const auth = require("../msal-auth");
        yield expect(auth.login()).rejects.toThrow(/Popup blocked/i);
    }));
    it("login() also flags empty_window_error as a popup-blocked error", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        methods.loginPopup.mockRejectedValue({ errorCode: "empty_window_error" });
        const auth = require("../msal-auth");
        yield expect(auth.login()).rejects.toThrow(/Popup blocked/i);
    }));
    it("login() returns null when the popup resolves without an account", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        methods.loginPopup.mockResolvedValue({ account: null });
        const auth = require("../msal-auth");
        const result = yield auth.login();
        expect(result).toBeNull();
    }));
    it("logout() clears every account and forwards to msal.logoutPopup", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-bye");
        methods.loginPopup.mockResolvedValue({ account: acct });
        const auth = require("../msal-auth");
        yield auth.login();
        expect((yield auth.getAllLoggedInAccounts()).length).toBe(1);
        yield auth.logout();
        expect(methods.logoutPopup).toHaveBeenCalled();
        expect(yield auth.getCurrentUser()).toBeNull();
        expect((yield auth.getAllLoggedInAccounts()).length).toBe(0);
    }));
    it("logout() targeted-clears only auth-owned keys when the popup throws (preserves unrelated app state)", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        methods.logoutPopup.mockRejectedValue(new Error("popup closed"));
        // Keys the auth subsystem owns — must be wiped.
        localStorage.setItem("azbm.login-mode.v1", "cli");
        localStorage.setItem("msal.something", "x");
        localStorage.setItem("msal|3|home-id|access-token|abc", "y");
        // Unrelated app state — MUST be preserved (regression guard for
        // the previous blanket `localStorage.clear()` that wiped it).
        localStorage.setItem("unrelated-draft", "user-typed-this");
        const auth = require("../msal-auth");
        yield auth.logout();
        expect(localStorage.getItem("azbm.login-mode.v1")).toBeNull();
        expect(localStorage.getItem("msal.something")).toBeNull();
        expect(localStorage.getItem("msal|3|home-id|access-token|abc")).toBeNull();
        expect(localStorage.getItem("unrelated-draft")).toBe("user-typed-this");
    }));
    it("logout({ everywhere: true }) calls logoutPopup with logoutHint = account.username", () => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        const methods = registerMsalMock();
        const acct = makeAccount("home-everywhere", "alice@contoso.com");
        methods.loginPopup.mockResolvedValue({ account: acct });
        const auth = require("../msal-auth");
        yield auth.login();
        methods.logoutPopup.mockClear();
        yield auth.logout({ everywhere: true });
        expect(methods.logoutPopup).toHaveBeenCalledTimes(1);
        const callArgs = methods.logoutPopup.mock.calls[0][0];
        expect(callArgs === null || callArgs === void 0 ? void 0 : callArgs.logoutHint).toBe("alice@contoso.com");
        expect((_a = callArgs === null || callArgs === void 0 ? void 0 : callArgs.account) === null || _a === void 0 ? void 0 : _a.homeAccountId).toBe("home-everywhere");
    }));
    it("signOutEverywhere(account) calls logoutPopup with logoutHint", () => __awaiter(void 0, void 0, void 0, function* () {
        var _b;
        const methods = registerMsalMock();
        const acct = makeAccount("home-soe", "bob@contoso.com");
        methods.loginPopup.mockResolvedValue({ account: acct });
        const auth = require("../msal-auth");
        yield auth.login();
        methods.logoutPopup.mockClear();
        yield auth.signOutEverywhere(acct);
        expect(methods.logoutPopup).toHaveBeenCalledTimes(1);
        const callArgs = methods.logoutPopup.mock.calls[0][0];
        expect(callArgs === null || callArgs === void 0 ? void 0 : callArgs.logoutHint).toBe("bob@contoso.com");
        expect((_b = callArgs === null || callArgs === void 0 ? void 0 : callArgs.account) === null || _b === void 0 ? void 0 : _b.homeAccountId).toBe("home-soe");
    }));
});
// ---------------------------------------------------------------------------
// Token acquisition: getArmToken / getBatchToken / getGraphToken
// ---------------------------------------------------------------------------
describe("getArmToken / getBatchToken / getGraphToken", () => {
    it("throws a 'Not signed in' error when no account is present", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        yield expect(auth.getArmToken()).rejects.toThrow(/Not signed in/);
        yield expect(auth.getBatchToken()).rejects.toThrow(/Not signed in/);
        yield expect(auth.getGraphToken()).rejects.toThrow(/Not signed in/);
    }));
    it("getArmToken returns the silent token using the ARM scope", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-arm");
        methods.loginPopup.mockResolvedValue({ account: acct });
        methods.acquireTokenSilent.mockResolvedValue({
            accessToken: "arm-access-token",
        });
        const auth = require("../msal-auth");
        yield auth.login();
        const token = yield auth.getArmToken();
        expect(token).toBe("arm-access-token");
        const silentArgs = methods.acquireTokenSilent.mock.calls[0][0];
        expect(silentArgs.scopes).toEqual([
            "https://management.azure.com/.default",
        ]);
        expect(silentArgs.account).toEqual(acct);
    }));
    it("getBatchToken targets the Batch data-plane scope", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-batch");
        methods.loginPopup.mockResolvedValue({ account: acct });
        methods.acquireTokenSilent.mockResolvedValue({
            accessToken: "batch-token",
        });
        const auth = require("../msal-auth");
        yield auth.login();
        const token = yield auth.getBatchToken();
        expect(token).toBe("batch-token");
        expect(methods.acquireTokenSilent.mock.calls[0][0].scopes).toEqual([
            "https://batch.core.windows.net/.default",
        ]);
    }));
    it("getGraphToken targets the Microsoft Graph scope", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-graph");
        methods.loginPopup.mockResolvedValue({ account: acct });
        methods.acquireTokenSilent.mockResolvedValue({
            accessToken: "graph-token",
        });
        const auth = require("../msal-auth");
        yield auth.login();
        const token = yield auth.getGraphToken();
        expect(token).toBe("graph-token");
        expect(methods.acquireTokenSilent.mock.calls[0][0].scopes).toEqual([
            "https://graph.microsoft.com/.default",
        ]);
    }));
    it("getArmToken(tenantId) overrides the authority with the given tenant", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-arm-tenant");
        methods.loginPopup.mockResolvedValue({ account: acct });
        methods.acquireTokenSilent.mockResolvedValue({ accessToken: "tk" });
        const auth = require("../msal-auth");
        yield auth.login();
        yield auth.getArmToken("contoso-tenant");
        const silentArgs = methods.acquireTokenSilent.mock.calls[0][0];
        expect(silentArgs.authority).toBe("https://login.microsoftonline.com/contoso-tenant");
    }));
    it("falls back to the per-account active tenant when no tenantId is passed", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-active-tenant");
        methods.loginPopup.mockResolvedValue({ account: acct });
        methods.acquireTokenSilent.mockResolvedValue({ accessToken: "tk" });
        const auth = require("../msal-auth");
        yield auth.login();
        auth.setActiveTenant(acct.homeAccountId, "guest-tenant");
        yield auth.getArmToken();
        expect(methods.acquireTokenSilent.mock.calls[0][0].authority).toBe("https://login.microsoftonline.com/guest-tenant");
    }));
    it("throws InteractionRequiredAuthError (does NOT auto-popup) when silent acquire signals InteractionRequired", () => __awaiter(void 0, void 0, void 0, function* () {
        // Behaviour change from earlier `acquireTokenPopup` auto-escalation:
        // page-load silent flows are not a user gesture, so the browser
        // would block the popup AND we'd cascade silent errors. The new
        // contract is to surface `InteractionRequiredAuthError` and let
        // the AuthBanner / "Sign in" CTA drive interactive recovery.
        const methods = registerMsalMock();
        const acct = makeAccount("home-interaction");
        methods.loginPopup.mockResolvedValue({ account: acct });
        methods.acquireTokenSilent.mockRejectedValue(new FakeInteractionRequiredAuthError());
        const auth = require("../msal-auth");
        yield auth.login();
        yield expect(auth.getArmToken()).rejects.toThrow(/Cached session is no longer valid/);
        expect(methods.acquireTokenPopup).not.toHaveBeenCalled();
    }));
    it("re-throws non-interaction errors verbatim from acquireTokenSilent", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-other");
        methods.loginPopup.mockResolvedValue({ account: acct });
        const boom = new Error("network down");
        methods.acquireTokenSilent.mockRejectedValue(boom);
        const auth = require("../msal-auth");
        yield auth.login();
        yield expect(auth.getArmToken()).rejects.toThrow("network down");
        expect(methods.acquireTokenPopup).not.toHaveBeenCalled();
    }));
});
// ---------------------------------------------------------------------------
// Per-account token cache (different tenants get different tokens)
// ---------------------------------------------------------------------------
describe("per-tenant / per-account token routing", () => {
    it("getArmTokenForAccount routes by homeAccountId and tenantId", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acctA = makeAccount("home-cache-A");
        const acctB = makeAccount("home-cache-B");
        methods.getAllAccounts.mockReturnValue([acctA, acctB]);
        methods.acquireTokenSilent.mockImplementation((req) => {
            var _a;
            if (req.account.homeAccountId === "home-cache-A") {
                return Promise.resolve({ accessToken: "token-A" });
            }
            return Promise.resolve({
                accessToken: `token-B@${(_a = req.authority) !== null && _a !== void 0 ? _a : "default"}`,
            });
        });
        const auth = require("../msal-auth");
        // Force the internal map to populate from the cached accounts.
        yield auth.getAllLoggedInAccounts();
        const tokenA = yield auth.getArmTokenForAccount("home-cache-A");
        const tokenB = yield auth.getArmTokenForAccount("home-cache-B", "tenant-bbb");
        expect(tokenA).toBe("token-A");
        expect(tokenB).toBe("token-B@https://login.microsoftonline.com/tenant-bbb");
    }));
    it("uses the persisted active tenant when no explicit tenantId is given to getArmTokenForAccount", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-active-tenant-acct");
        methods.getAllAccounts.mockReturnValue([acct]);
        methods.acquireTokenSilent.mockImplementation((req) => { var _a; return Promise.resolve({ accessToken: (_a = req.authority) !== null && _a !== void 0 ? _a : "no-authority" }); });
        const auth = require("../msal-auth");
        yield auth.getAllLoggedInAccounts();
        auth.setActiveTenant(acct.homeAccountId, "stored-tenant");
        const token = yield auth.getArmTokenForAccount(acct.homeAccountId);
        expect(token).toBe("https://login.microsoftonline.com/stored-tenant");
    }));
    it("getBatchTokenForAccount and getGraphTokenForAccount target their own scopes", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-mixed");
        methods.getAllAccounts.mockReturnValue([acct]);
        methods.acquireTokenSilent.mockImplementation((req) => Promise.resolve({ accessToken: req.scopes[0] }));
        const auth = require("../msal-auth");
        yield auth.getAllLoggedInAccounts();
        const batch = yield auth.getBatchTokenForAccount(acct.homeAccountId);
        const graph = yield auth.getGraphTokenForAccount(acct.homeAccountId);
        expect(batch).toBe("https://batch.core.windows.net/.default");
        expect(graph).toBe("https://graph.microsoft.com/.default");
    }));
    it("throws a clear 'Account not found' error for an unknown homeAccountId", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        yield expect(auth.getArmTokenForAccount("ghost-id")).rejects.toThrow(/Account not found: ghost-id/);
    }));
    it("InteractionRequired on a per-account silent call surfaces as InteractionRequiredAuthError (no auto-popup)", () => __awaiter(void 0, void 0, void 0, function* () {
        // Mirrors the single-account branch above — per-account silent
        // acquire rejects InteractionRequired upward so callers can drive
        // a user-initiated recovery instead of relying on a browser-
        // blocked silent popup.
        const methods = registerMsalMock();
        const acct = makeAccount("home-per-acct-popup");
        methods.getAllAccounts.mockReturnValue([acct]);
        methods.acquireTokenSilent.mockRejectedValue(new FakeInteractionRequiredAuthError());
        const auth = require("../msal-auth");
        yield auth.getAllLoggedInAccounts();
        yield expect(auth.getArmTokenForAccount(acct.homeAccountId, "specific-tenant")).rejects.toThrow(/Cached session is no longer valid/);
        expect(methods.acquireTokenPopup).not.toHaveBeenCalled();
    }));
});
// ---------------------------------------------------------------------------
// getActiveTenant / setActiveTenant / clearActiveTenant
// ---------------------------------------------------------------------------
describe("active-tenant persistence", () => {
    it("setActiveTenant + getActiveTenant round-trip through sessionStorage", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        auth.setActiveTenant("acct-1", "tenant-1");
        expect(auth.getActiveTenant("acct-1")).toBe("tenant-1");
    }));
    it("getActiveTenant returns null for unknown accounts and empty inputs", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        expect(auth.getActiveTenant("never-set")).toBeNull();
        expect(auth.getActiveTenant("")).toBeNull();
    }));
    it("setActiveTenant ignores empty homeAccountId or tenantId", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        auth.setActiveTenant("", "tenant-x");
        auth.setActiveTenant("acct-x", "");
        expect(auth.getActiveTenant("acct-x")).toBeNull();
    }));
    it("each account has its own active tenant slot", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        auth.setActiveTenant("acct-A", "tenant-A");
        auth.setActiveTenant("acct-B", "tenant-B");
        expect(auth.getActiveTenant("acct-A")).toBe("tenant-A");
        expect(auth.getActiveTenant("acct-B")).toBe("tenant-B");
    }));
    it("clearActiveTenant removes only the requested account's entry", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        auth.setActiveTenant("acct-A", "tenant-A");
        auth.setActiveTenant("acct-B", "tenant-B");
        auth.clearActiveTenant("acct-A");
        expect(auth.getActiveTenant("acct-A")).toBeNull();
        expect(auth.getActiveTenant("acct-B")).toBe("tenant-B");
    }));
    it("clearActiveTenant on an empty id is a no-op", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        expect(() => auth.clearActiveTenant("")).not.toThrow();
    }));
});
// ---------------------------------------------------------------------------
// isAuthenticated / getAuthMode / setTokenProvider / msalAuth.checkHealth
// ---------------------------------------------------------------------------
describe("isAuthenticated, getAuthMode, msalAuth provider", () => {
    it("isAuthenticated returns false with no accounts and true after login", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-auth");
        methods.loginPopup.mockResolvedValue({ account: acct });
        const auth = require("../msal-auth");
        expect(yield auth.isAuthenticated()).toBe(false);
        yield auth.login();
        expect(yield auth.isAuthenticated()).toBe(true);
    }));
    it("getAuthMode returns 'cli' when unauthenticated and 'msal' when authenticated", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const auth = require("../msal-auth");
        expect(yield auth.getAuthMode()).toBe("cli");
        const acct = makeAccount("home-mode");
        methods.loginPopup.mockResolvedValue({ account: acct });
        yield auth.login();
        expect(yield auth.getAuthMode()).toBe("msal");
    }));
    it("msalAuth.checkHealth reports unhealthy when not signed in", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        const health = yield auth.msalAuth.checkHealth();
        expect(health.healthy).toBe(false);
        expect(health.error).toMatch(/Not signed in/);
    }));
    it("msalAuth.checkHealth reports healthy when an ARM token can be acquired", () => __awaiter(void 0, void 0, void 0, function* () {
        const methods = registerMsalMock();
        const acct = makeAccount("home-health");
        methods.loginPopup.mockResolvedValue({ account: acct });
        methods.acquireTokenSilent.mockResolvedValue({ accessToken: "ok" });
        const auth = require("../msal-auth");
        yield auth.login();
        const health = yield auth.msalAuth.checkHealth();
        expect(health).toEqual({ healthy: true, error: null });
    }));
    it("msalAuth.getAccessToken delegates to an external provider when set", () => __awaiter(void 0, void 0, void 0, function* () {
        registerMsalMock();
        const auth = require("../msal-auth");
        const externalProvider = {
            getAccessToken: jest.fn().mockResolvedValue("ext-arm"),
            getBatchAccessToken: jest.fn().mockResolvedValue("ext-batch"),
            checkHealth: jest
                .fn()
                .mockResolvedValue({ healthy: true, error: null }),
        };
        auth.setTokenProvider(externalProvider);
        expect(yield auth.msalAuth.getAccessToken()).toBe("ext-arm");
        expect(yield auth.msalAuth.getBatchAccessToken()).toBe("ext-batch");
        const health = yield auth.msalAuth.checkHealth();
        expect(health.healthy).toBe(true);
        expect(externalProvider.getAccessToken).toHaveBeenCalled();
    }));
});
// ---------------------------------------------------------------------------
// purgeMsalCache
// ---------------------------------------------------------------------------
describe("purgeMsalCache", () => {
    it("removes msal-related keys from localStorage", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        localStorage.setItem("04b07795-8ddb-461a-bbee-02f9e1bf7b46.something", "x");
        localStorage.setItem("msal.foo", "y");
        localStorage.setItem("login.microsoftonline.com.bar", "z");
        localStorage.setItem("unrelated", "keep-me");
        auth.purgeMsalCache();
        expect(localStorage.getItem("04b07795-8ddb-461a-bbee-02f9e1bf7b46.something")).toBeNull();
        expect(localStorage.getItem("msal.foo")).toBeNull();
        expect(localStorage.getItem("login.microsoftonline.com.bar")).toBeNull();
        expect(localStorage.getItem("unrelated")).toBe("keep-me");
    });
});
// ---------------------------------------------------------------------------
// handlePopupIfNeeded
// ---------------------------------------------------------------------------
describe("handlePopupIfNeeded", () => {
    // Helpers to mutate window.location.{search,hash} under jsdom safely.
    const origSearch = window.location.search;
    const origHash = window.location.hash;
    afterEach(() => {
        // Restore — jsdom allows direct mutation of these.
        window.history.replaceState({}, "", `${window.location.pathname}`);
        if (origSearch) {
            window.history.replaceState({}, "", `${window.location.pathname}${origSearch}`);
        }
        if (origHash) {
            window.location.hash = origHash;
        }
    });
    it("returns false when neither code nor error is present in the URL", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        window.history.replaceState({}, "", "/");
        expect(auth.handlePopupIfNeeded()).toBe(false);
    });
    it("returns false when state is malformed JSON", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        window.history.replaceState({}, "", "/?code=abc&state=not-base64-or-json");
        expect(auth.handlePopupIfNeeded()).toBe(false);
    });
    it("returns false when state has no popup interaction marker", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        // base64url-encoded JSON of {meta:{interactionType:"redirect"}}
        const payload = btoa(JSON.stringify({ meta: { interactionType: "redirect" } }))
            .replace(/=+$/, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_");
        window.history.replaceState({}, "", `/?code=abc&state=${payload}|userstate`);
        expect(auth.handlePopupIfNeeded()).toBe(false);
    });
    it("returns true (and triggers the relay) when state.meta.interactionType is 'popup'", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        const payload = btoa(JSON.stringify({ meta: { interactionType: "popup" } }))
            .replace(/=+$/, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_");
        window.history.replaceState({}, "", `/?code=abc&state=${payload}`);
        expect(auth.handlePopupIfNeeded()).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// parseCaeClaimsChallenge — Continuous Access Evaluation header parser
// ---------------------------------------------------------------------------
describe("parseCaeClaimsChallenge", () => {
    it("returns null for missing / empty / non-Bearer headers", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        expect(auth.parseCaeClaimsChallenge(null)).toBeNull();
        expect(auth.parseCaeClaimsChallenge(undefined)).toBeNull();
        expect(auth.parseCaeClaimsChallenge("")).toBeNull();
        expect(auth.parseCaeClaimsChallenge("Basic realm=foo")).toBeNull();
    });
    it("returns null when the Bearer challenge has no claims= parameter", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        expect(auth.parseCaeClaimsChallenge('Bearer realm="", error="invalid_token"')).toBeNull();
    });
    it("decodes a base64-encoded claims challenge to JSON", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        // {"access_token":{"acrs":{"essential":true,"value":"c25"}}}
        const json = '{"access_token":{"acrs":{"essential":true,"value":"c25"}}}';
        const b64 = btoa(json);
        const header = `Bearer realm="", authorization_uri="https://login.windows.net/common/oauth2/authorize", error="insufficient_claims", claims="${b64}"`;
        expect(auth.parseCaeClaimsChallenge(header)).toBe(json);
    });
    it("returns raw JSON when AAD already provided unencoded JSON", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        const json = '{"access_token":{"nbf":{"essential":true,"value":"123"}}}';
        const header = `Bearer error="insufficient_claims", claims="${json.replace(/"/g, '\\"')}"`;
        expect(auth.parseCaeClaimsChallenge(header)).toBe(json);
    });
    it("is case-insensitive on the Bearer scheme", () => {
        registerMsalMock();
        const auth = require("../msal-auth");
        const b64 = btoa("{}");
        expect(auth.parseCaeClaimsChallenge(`bearer claims="${b64}"`)).toBe("{}");
    });
});
//# sourceMappingURL=msal-auth.test.js.map