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
/// <reference types="jest" />
type MockMethods = {
    initialize: jest.Mock;
    acquireTokenSilent: jest.Mock;
    acquireTokenPopup: jest.Mock;
    loginPopup: jest.Mock;
    logoutPopup: jest.Mock;
    getAllAccounts: jest.Mock;
    setActiveAccount: jest.Mock;
    handleRedirectPromise: jest.Mock;
};
declare function makeMockMethods(): MockMethods;
declare class FakeInteractionRequiredAuthError extends Error {
    constructor(message?: string);
}
/**
 * Register the @azure/msal-browser mock for the next `require()` cycle and
 * return the mock-methods object that the just-built PublicClientApplication
 * will use. Pair with `jest.resetModules()` so the next import of msal-auth
 * picks the fresh mock up.
 */
declare function registerMsalMock(): MockMethods;
/**
 * AccountInfo factory — only the fields msal-auth.ts actually reads.
 */
declare function makeAccount(homeAccountId: string, username?: string): {
    homeAccountId: string;
    username: string;
    environment: string;
    tenantId: string;
    localAccountId: string;
};
//# sourceMappingURL=msal-auth.test.d.ts.map