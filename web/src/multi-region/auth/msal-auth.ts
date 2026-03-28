/**
 * MSAL Browser Authentication for Azure Batch Manager
 *
 * Key design decisions:
 * - Popup flow only (no redirect flow)
 * - broadcastResponseToMainFrame() in popup: relays auth code to parent via
 *   BroadcastChannel so the parent completes token exchange with its PKCE verifier
 * - cacheLocation: "sessionStorage" — avoids localStorage quota exhaustion
 * - msalNetworkClient: proxies token POSTs through /api/auth/proxy-token to
 *   bypass CORS (Azure CLI client ID is a public app — Azure AD blocks direct
 *   browser token POSTs)
 *
 * Multi-account support:
 * - Multiple Azure AD accounts can be logged in simultaneously
 * - Each account is keyed by homeAccountId in an internal Map
 * - The "primary" account is the first one added (backward compat)
 * - New per-account APIs: loginAccount, logoutAccount, getAllLoggedInAccounts,
 *   getArmTokenForAccount, getBatchTokenForAccount, listSubscriptionsForAccount
 */
import {
    PublicClientApplication,
    InteractionRequiredAuthError,
    AccountInfo,
    AuthenticationResult,
    Configuration,
    SilentRequest,
    INetworkModule,
    NetworkRequestOptions,
    NetworkResponse,
} from "@azure/msal-browser";
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
import { ArmSubscription } from "../services/types";

// ---------------------------------------------------------------------------
// TokenProvider interface — usable by both web and desktop
// ---------------------------------------------------------------------------
export interface TokenProvider {
    getAccessToken: () => Promise<string>;
    getBatchAccessToken: () => Promise<string>;
    checkHealth: () => Promise<{ healthy: boolean; error: string | null }>;
    loadSubscriptions?: (store: unknown) => Promise<void>;
}

// Azure CLI's well-known client ID (same as Batch Explorer desktop uses)
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

// Scopes for different Azure resources
const ARM_SCOPE = "https://management.azure.com/.default";
const BATCH_SCOPE = "https://batch.core.windows.net/.default";

// ---------------------------------------------------------------------------
// Custom MSAL network client — proxies token POST requests through the local
// dev server to bypass CORS.  Azure CLI's client ID is a native/public app:
// Azure AD does NOT return Access-Control-Allow-Origin for direct browser
// POSTs to its token endpoint.  The proxy forwards server-side where CORS
// is not enforced by the browser.
// ---------------------------------------------------------------------------
const msalNetworkClient: INetworkModule = {
    async sendGetRequestAsync<T>(
        url: string,
        options?: NetworkRequestOptions
    ): Promise<NetworkResponse<T>> {
        const response = await fetch(url, {
            method: "GET",
            headers: options?.headers as Record<string, string> | undefined,
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
            headers[k] = v;
        });
        return {
            headers,
            body: (await response.json()) as T,
            status: response.status,
        };
    },

    async sendPostRequestAsync<T>(
        url: string,
        options?: NetworkRequestOptions
    ): Promise<NetworkResponse<T>> {
        const isTokenEndpoint =
            url.includes("login.microsoftonline.com") && url.includes("/token");
        const fetchUrl = isTokenEndpoint ? "/api/auth/proxy-token" : url;
        const extraHeaders: Record<string, string> = isTokenEndpoint
            ? { "x-proxy-target": url }
            : {};
        const response = await fetch(fetchUrl, {
            method: "POST",
            headers: {
                ...(options?.headers as Record<string, string> | undefined),
                ...extraHeaders,
            },
            body: options?.body,
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
            headers[k] = v;
        });
        return {
            headers,
            body: (await response.json()) as T,
            status: response.status,
        };
    },
};

const msalConfig: Configuration = {
    auth: {
        clientId: AZURE_CLI_CLIENT_ID,
        authority: "https://login.microsoftonline.com/common",
        redirectUri: window.location.origin + "/",
    },
    cache: {
        // sessionStorage avoids localStorage quota exhaustion (cache_quota_exceeded).
        // broadcastResponseToMainFrame() relays the auth code to the parent via
        // BroadcastChannel — the popup never needs to read the parent's PKCE
        // verifier, so separate sessionStorages per window are fine.
        cacheLocation: "sessionStorage",
    },
    system: {
        networkClient: msalNetworkClient,
        loggerOptions: {
            logLevel: 1, // Warn only
            loggerCallback: (level: number, message: string) => {
                if (level === 0) console.error("[MSAL]", message);
                else if (level === 1) console.warn("[MSAL]", message);
            },
            piiLoggingEnabled: false,
        },
    },
};

let _initComplete: Promise<PublicClientApplication> | null = null;
let _activeAccount: AccountInfo | null = null;

// Multi-account state: Map from homeAccountId → AccountInfo
const _accounts = new Map<string, AccountInfo>();

// ---------------------------------------------------------------------------
// Cache management — localStorage quota guard
// ---------------------------------------------------------------------------

/**
 * Clear all MSAL-related entries from localStorage to free quota.
 * Called automatically on cache_quota_exceeded errors.
 * Resets all in-memory state so getMsalInstance() reinitialises cleanly.
 */
function _clearMsalCache(): void {
    const keysToRemove = Object.keys(localStorage).filter(
        (k) =>
            k.startsWith(AZURE_CLI_CLIENT_ID) ||
            k.startsWith("msal.") ||
            k.includes("login.microsoftonline.com") ||
            k.includes("msal")
    );
    for (const key of keysToRemove) {
        try {
            localStorage.removeItem(key);
        } catch {
            /* ignore */
        }
    }
    _accounts.clear();
    _activeAccount = null;
    _initComplete = null;
    console.warn(
        "[MSAL] localStorage quota exceeded — cache cleared. Sign in again."
    );
}

function _isQuotaError(error: unknown): boolean {
    const code = (error as any)?.errorCode ?? "";
    const msg = (error as any)?.message ?? "";
    return (
        code === "cache_quota_exceeded" ||
        msg.includes("cache_quota_exceeded") ||
        msg.includes("QuotaExceededError")
    );
}

/**
 * Exported utility — call from UI if the user wants to manually clear auth cache.
 */
export function purgeMsalCache(): void {
    _clearMsalCache();
}

// ---------------------------------------------------------------------------
// Popup relay — if the current page is a loginPopup() redirect callback,
// broadcast the auth code back to the parent and close without rendering.
// ---------------------------------------------------------------------------
/**
 * Detect whether this page load is an MSAL popup callback and, if so,
 * relay the auth code to the parent window via BroadcastChannel.
 *
 * WHY broadcastResponseToMainFrame instead of handleRedirectPromise:
 *   The PKCE code verifier is stored in the PARENT window's sessionStorage.
 *   A fresh MSAL instance in the popup cannot exchange the auth code without it.
 *   broadcastResponseToMainFrame() relays the raw code to the parent, which
 *   completes the token exchange using its own verifier. No token exchange
 *   happens in the popup.
 */
export function handlePopupIfNeeded(): boolean {
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
        // MSAL state = base64url(JSON) | userState
        const [libraryStateEncoded] = stateParam.split("|");
        const padding = "=".repeat((4 - (libraryStateEncoded.length % 4)) % 4);
        const base64 = (libraryStateEncoded + padding)
            .replace(/-/g, "+")
            .replace(/_/g, "/");
        const libraryState = JSON.parse(atob(base64));

        if (libraryState?.meta?.interactionType === "popup") {
            console.log("[MSAL Popup] Callback detected — relaying to parent");
            broadcastResponseToMainFrame().catch((e) => {
                console.error(
                    "[MSAL Popup] broadcastResponseToMainFrame error:",
                    e
                );
                try {
                    window.close();
                } catch {
                    /* ignore */
                }
            });
            return true; // suppress full app render
        }
    } catch {
        // Not a valid MSAL popup state — render normally
    }
    return false;
}

/**
 * Helper: add an account to the internal _accounts Map.
 * The first account added also becomes the _activeAccount (primary).
 */
function _addAccountToMap(account: AccountInfo): void {
    const key = account.homeAccountId;
    if (!key) return;
    _accounts.set(key, account);
    // The primary account is the first one added
    if (!_activeAccount) {
        _activeAccount = account;
    }
}

async function getMsalInstance(): Promise<PublicClientApplication> {
    if (_initComplete) return _initComplete;

    _initComplete = (async () => {
        const initMsal = async (): Promise<PublicClientApplication> => {
            const msalApp = new PublicClientApplication(msalConfig);
            await msalApp.initialize();
            return msalApp;
        };

        let msalApp: PublicClientApplication;
        try {
            msalApp = await initMsal();
        } catch (initErr) {
            if (_isQuotaError(initErr)) {
                _clearMsalCache();
                msalApp = await initMsal(); // one retry after clearing
            } else {
                throw initErr;
            }
        }

        // Check for any pending redirect (in case redirect was used previously)
        try {
            const response = await msalApp.handleRedirectPromise();
            if (response?.account) {
                _activeAccount = response.account;
                _addAccountToMap(response.account);
                msalApp.setActiveAccount(response.account);
                console.log(
                    "[MSAL] Account from redirect:",
                    response.account.username
                );
            }
        } catch {
            // Ignore redirect errors — we use popup flow
        }

        // Load ALL cached accounts from MSAL into the _accounts Map
        const cachedAccounts = msalApp.getAllAccounts();
        console.log(
            "[MSAL] Cached accounts:",
            cachedAccounts.length,
            cachedAccounts.map((a) => a.username)
        );
        for (const acct of cachedAccounts) {
            _addAccountToMap(acct);
        }

        // If we still have no active account but have cached ones, pick the first
        if (!_activeAccount && cachedAccounts.length > 0) {
            _activeAccount = cachedAccounts[0];
            msalApp.setActiveAccount(cachedAccounts[0]);
        }

        return msalApp;
    })();

    return _initComplete;
}

// Serialize all interactive auth to prevent "interaction_in_progress" errors
let _loginInProgress: Promise<AccountInfo | null> | null = null;

// ---------------------------------------------------------------------------
// Multi-account public API
// ---------------------------------------------------------------------------

/**
 * Login a NEW Azure account (additive — doesn't log out existing ones).
 * Uses prompt: "select_account" so user can pick a DIFFERENT account each time.
 * Returns the newly logged-in AccountInfo, or null if cancelled.
 */
export async function loginAccount(): Promise<AccountInfo | null> {
    if (_loginInProgress) {
        return _loginInProgress;
    }

    _loginInProgress = (async () => {
        const msalApp = await getMsalInstance();
        try {
            const result = await msalApp.loginPopup({
                scopes: [ARM_SCOPE],
                prompt: "select_account",
            });
            if (result?.account) {
                _addAccountToMap(result.account);
                // Also set as MSAL active account
                msalApp.setActiveAccount(result.account);
                console.log(
                    "[MSAL] Popup login successful (multi-account):",
                    result.account.username
                );
                console.log(
                    "[MSAL] Total accounts after login:",
                    _accounts.size
                );
                return result.account;
            }
            return null;
        } catch (e: unknown) {
            const msalError = e as { errorCode?: string };
            if (
                msalError?.errorCode === "popup_window_error" ||
                msalError?.errorCode === "empty_window_error"
            ) {
                throw new Error(
                    "Popup blocked! Allow popups for this site in your browser, then try again."
                );
            }
            throw e;
        } finally {
            _loginInProgress = null;
        }
    })();

    return _loginInProgress;
}

/**
 * Logout a specific account by homeAccountId.
 * Removes it from the internal Map and from MSAL's cache.
 * If the removed account was the primary, the next account becomes primary.
 */
export async function logoutAccount(homeAccountId: string): Promise<void> {
    const msalApp = await getMsalInstance();
    const account = _accounts.get(homeAccountId);

    // Remove from internal map
    _accounts.delete(homeAccountId);

    // If the removed account was the primary, pick a new primary
    if (_activeAccount?.homeAccountId === homeAccountId) {
        const remaining = Array.from(_accounts.values());
        _activeAccount = remaining.length > 0 ? remaining[0] : null;
        if (_activeAccount) {
            msalApp.setActiveAccount(_activeAccount);
        }
    }

    // Remove from MSAL cache
    if (account) {
        try {
            await msalApp.logoutPopup({ account });
        } catch {
            // If popup logout fails, try to clear the account from cache directly
            try {
                const allAccounts = msalApp.getAllAccounts();
                const cached = allAccounts.find(
                    (a) => a.homeAccountId === homeAccountId
                );
                if (cached) {
                    // removeAccount is not standard; clear via logout redirect or ignore
                }
            } catch {
                // best-effort
            }
        }
    }
}

/**
 * Get all currently logged-in MSAL accounts.
 */
export async function getAllLoggedInAccounts(): Promise<AccountInfo[]> {
    await getMsalInstance();
    return Array.from(_accounts.values());
}

/**
 * Acquire a token for a SPECIFIC account (by homeAccountId).
 */
async function acquireTokenForAccount(
    scopes: string[],
    homeAccountId: string,
    tenantId?: string
): Promise<AuthenticationResult> {
    const msalApp = await getMsalInstance();

    const account = _accounts.get(homeAccountId);
    if (!account) {
        throw new Error(
            `Account not found: ${homeAccountId}. Please sign in first.`
        );
    }

    const silentRequest: SilentRequest = {
        scopes,
        account,
        forceRefresh: false,
        ...(tenantId
            ? { authority: `https://login.microsoftonline.com/${tenantId}` }
            : {}),
    };

    try {
        return await msalApp.acquireTokenSilent(silentRequest);
    } catch (error) {
        // Cache quota exceeded — clear and surface a clear message
        if (_isQuotaError(error)) {
            _clearMsalCache();
            throw new Error(
                "Browser storage quota exceeded and MSAL cache was cleared. " +
                    "Please sign in again."
            );
        }
        if (error instanceof InteractionRequiredAuthError) {
            if (_loginInProgress) {
                await _loginInProgress;
                return await msalApp.acquireTokenSilent(silentRequest);
            }
            return await msalApp.acquireTokenPopup({
                scopes,
                account,
                ...(tenantId
                    ? {
                          authority: `https://login.microsoftonline.com/${tenantId}`,
                      }
                    : {}),
            });
        }
        throw error;
    }
}

/**
 * Get ARM token for a specific account by homeAccountId.
 */
export async function getArmTokenForAccount(
    homeAccountId: string,
    tenantId?: string
): Promise<string> {
    const result = await acquireTokenForAccount(
        [ARM_SCOPE],
        homeAccountId,
        tenantId
    );
    return result.accessToken;
}

/**
 * Get Batch token for a specific account by homeAccountId.
 */
export async function getBatchTokenForAccount(
    homeAccountId: string,
    tenantId?: string
): Promise<string> {
    const result = await acquireTokenForAccount(
        [BATCH_SCOPE],
        homeAccountId,
        tenantId
    );
    return result.accessToken;
}

/**
 * List subscriptions for a specific account (by homeAccountId).
 */
export async function listSubscriptionsForAccount(
    homeAccountId: string
): Promise<ArmSubscription[]> {
    const token = await getArmTokenForAccount(homeAccountId);
    const url =
        "https://management.azure.com/subscriptions?api-version=2022-12-01";
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new Error(
            `Failed to list subscriptions for account ${homeAccountId}: ${response.status}`
        );
    }
    const data = await response.json();
    return ((data.value as Array<Record<string, unknown>>) ?? []).map((s) => ({
        subscriptionId: s.subscriptionId as string,
        displayName: s.displayName as string,
        state: s.state as string,
        tenantId: s.tenantId as string,
    }));
}

// ---------------------------------------------------------------------------
// Backward-compatible single-account API
// ---------------------------------------------------------------------------

/**
 * Force interactive login via popup. Returns the authenticated account.
 * Calls loginAccount() under the hood and sets first account as "primary".
 * Serialized — only one login popup can be open at a time.
 */
export async function login(): Promise<AccountInfo | null> {
    return loginAccount();
}

/**
 * Logout and clear all cached tokens (logs out ALL accounts).
 */
export async function logout(): Promise<void> {
    const msalApp = await getMsalInstance();

    // Clear internal state
    _accounts.clear();
    _activeAccount = null;

    try {
        await msalApp.logoutPopup();
    } catch {
        // Clear local state even if popup fails
        // Clear cached accounts from localStorage
        localStorage.clear();
    }
}

/**
 * Check if user is currently authenticated.
 * Returns true if any account is logged in.
 */
export async function isAuthenticated(): Promise<boolean> {
    const user = await getCurrentUser();
    return user != null;
}

/**
 * Get the current user info (primary account).
 * Checks the in-memory _activeAccount first, then falls back to
 * getAllAccounts() from the MSAL cache (localStorage).
 */
export async function getCurrentUser(): Promise<AccountInfo | null> {
    if (_activeAccount) return _activeAccount;
    const msalApp = await getMsalInstance();
    const accounts = msalApp.getAllAccounts();
    if (accounts.length > 0) {
        _activeAccount = accounts[0];
        _addAccountToMap(accounts[0]);
        msalApp.setActiveAccount(accounts[0]);
        return accounts[0];
    }
    return null;
}

/**
 * Acquire a token silently using the primary account. Optionally target a specific tenant.
 * Does NOT auto-trigger popup — user must click "Sign in with Azure" first.
 */
async function acquireToken(
    scopes: string[],
    tenantId?: string
): Promise<AuthenticationResult> {
    const msalApp = await getMsalInstance();

    if (!_activeAccount) {
        const accounts = msalApp.getAllAccounts();
        if (accounts.length === 0) {
            throw new Error(
                "Not signed in. Click 'Sign in with Azure' to authenticate."
            );
        }
        _activeAccount = accounts[0];
        _addAccountToMap(accounts[0]);
        msalApp.setActiveAccount(accounts[0]);
    }

    const silentRequest: SilentRequest = {
        scopes,
        account: _activeAccount,
        forceRefresh: false,
        // If a tenantId is provided, override the authority to target that tenant
        ...(tenantId
            ? { authority: `https://login.microsoftonline.com/${tenantId}` }
            : {}),
    };

    try {
        return await msalApp.acquireTokenSilent(silentRequest);
    } catch (error) {
        if (error instanceof InteractionRequiredAuthError) {
            if (_loginInProgress) {
                await _loginInProgress;
                return await msalApp.acquireTokenSilent(silentRequest);
            }
            return await msalApp.acquireTokenPopup({
                scopes,
                ...(tenantId
                    ? {
                          authority: `https://login.microsoftonline.com/${tenantId}`,
                      }
                    : {}),
            });
        }
        throw error;
    }
}

/**
 * Get ARM access token (for management.azure.com) using primary account.
 * Pass tenantId to get a token for a specific tenant (cross-tenant access).
 */
export async function getArmToken(tenantId?: string): Promise<string> {
    const result = await acquireToken([ARM_SCOPE], tenantId);
    return result.accessToken;
}

/**
 * Get Batch data-plane access token (for {account}.{region}.batch.azure.com) using primary account.
 * Pass tenantId to get a token for a specific tenant.
 */
export async function getBatchToken(tenantId?: string): Promise<string> {
    const result = await acquireToken([BATCH_SCOPE], tenantId);
    return result.accessToken;
}

/**
 * List all Azure subscriptions using the ARM token (primary account).
 */
export async function listSubscriptions(): Promise<
    Array<{ subscriptionId: string; displayName: string; tenantId?: string }>
> {
    const token = await getArmToken();
    const url =
        "https://management.azure.com/subscriptions?api-version=2022-12-01";
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new Error(`Failed to list subscriptions: ${response.status}`);
    }
    const data = await response.json();
    return ((data.value as Array<Record<string, unknown>>) ?? []).map((s) => ({
        subscriptionId: s.subscriptionId as string,
        displayName: s.displayName as string,
        tenantId: s.tenantId as string,
    }));
}

/**
 * Get auth mode: "msal" (Entra ID) or "cli" (Azure CLI proxy).
 * Returns "msal" if MSAL has accounts, "cli" if we need to fall back.
 */
export async function getAuthMode(): Promise<"msal" | "cli"> {
    try {
        const authed = await isAuthenticated();
        return authed ? "msal" : "cli";
    } catch {
        return "cli";
    }
}

// ---------------------------------------------------------------------------
// Default TokenProvider backed by MSAL — used when no external provider is
// injected (e.g. in the standalone web app, as opposed to the desktop app
// which may supply its own token provider).
// ---------------------------------------------------------------------------

let _externalProvider: TokenProvider | null = null;

/**
 * Optionally set an external token provider (e.g. from the desktop app).
 * When set, getAccessToken / getBatchAccessToken delegate to it.
 */
export function setTokenProvider(provider: TokenProvider): void {
    _externalProvider = provider;
}

/**
 * The built-in MSAL-backed token provider, also exported so callers can
 * reference it as a concrete TokenProvider.
 */
export const msalAuth: TokenProvider = {
    async getAccessToken(): Promise<string> {
        if (_externalProvider) return _externalProvider.getAccessToken();
        return getArmToken();
    },
    async getBatchAccessToken(): Promise<string> {
        if (_externalProvider) return _externalProvider.getBatchAccessToken();
        return getBatchToken();
    },
    async checkHealth(): Promise<{ healthy: boolean; error: string | null }> {
        if (_externalProvider) return _externalProvider.checkHealth();
        try {
            const user = await getCurrentUser();
            if (!user) {
                return { healthy: false, error: "Not signed in" };
            }
            // Try a silent ARM token to verify the session is still valid
            await getArmToken();
            return { healthy: true, error: null };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return { healthy: false, error: msg };
        }
    },
    async loadSubscriptions(store: unknown): Promise<void> {
        if (_externalProvider?.loadSubscriptions) {
            return _externalProvider.loadSubscriptions(store);
        }
        const subs = await listSubscriptions();
        const s = store as { setSubscriptions?: (subs: unknown) => void };
        if (s && typeof s.setSubscriptions === "function") {
            s.setSubscriptions(subs);
        }
    },
};
