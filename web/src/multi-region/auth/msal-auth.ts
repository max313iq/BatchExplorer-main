/**
 * MSAL Browser Authentication for Azure Batch Manager
 *
 * Uses the same Azure CLI client ID as Batch Explorer desktop,
 * forcing an interactive Entra ID login to get ARM and Batch tokens.
 * No Azure CLI or proxy server needed.
 *
 * Key design decisions:
 * - Popup flow only (no redirect flow) to avoid CORS issues with token exchange
 * - redirectUri is just the origin (e.g. "http://localhost:9000/") so the popup
 *   can close itself without needing a registered auth-redirect.html
 * - cacheLocation: "localStorage" so accounts persist across page reloads
 * - At startup, if we detect we're inside a popup (window.opener exists),
 *   we handle the redirect promise and close immediately — don't render the app
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
} from "@azure/msal-browser";
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

const msalConfig: Configuration = {
    auth: {
        clientId: AZURE_CLI_CLIENT_ID,
        authority: "https://login.microsoftonline.com/common",
        // redirectUri MUST be just the origin so the popup can close itself.
        // Using a path like /auth-redirect.html would require it to be
        // registered on the Azure CLI app registration, which we don't control.
        redirectUri: window.location.origin + "/",
    },
    cache: {
        cacheLocation: "localStorage",
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
// Popup detection — if we are inside an MSAL popup, handle the redirect
// promise and close immediately so the full app never renders in the popup.
// ---------------------------------------------------------------------------
/**
 * Detect if we're inside an MSAL popup window that received an auth response.
 * If so, DON'T render the app — just initialize MSAL so it can relay the
 * auth code back to the parent window, then close.
 *
 * MSAL popup flow works like this:
 * 1. Parent calls loginPopup() which opens a popup to login.microsoftonline.com
 * 2. After auth, Microsoft redirects back to redirectUri (localhost:9000/)
 * 3. The popup loads our app — but we DON'T want the full app to render
 * 4. MSAL needs to initialize in the popup to process the code and
 *    relay the result back to the parent via window.opener
 * 5. Once MSAL processes it, we close the popup
 *
 * Detection: we check if the URL contains auth response parameters
 * (code= or error=) AND we have a window.opener (we're in a popup).
 */
export function handlePopupIfNeeded(): boolean {
    const hash = window.location.hash;
    const search = window.location.search;
    const hasAuthCode =
        hash.includes("code=") ||
        hash.includes("error=") ||
        search.includes("code=") ||
        search.includes("error=");
    const isPopup = !!window.opener && window.opener !== window;

    if (isPopup || hasAuthCode) {
        // We are inside a popup OR have an auth code in the URL.
        // Initialize MSAL to let it process the response and relay to parent.
        const msalApp = new PublicClientApplication(msalConfig);
        msalApp
            .initialize()
            .then(() => msalApp.handleRedirectPromise())
            .then((result) => {
                if (result?.account) {
                    // Store in localStorage so parent can find it
                    _activeAccount = result.account;
                    msalApp.setActiveAccount(result.account);
                    console.log(
                        "[MSAL Popup] Auth success:",
                        result.account.username
                    );
                }
            })
            .catch((e) => console.error("[MSAL Popup] Error:", e))
            .finally(() => {
                // If we're in a popup, close it after a short delay
                // to ensure the parent has time to receive the message
                if (isPopup) {
                    setTimeout(() => window.close(), 500);
                }
            });
        // Only block rendering if we're actually in a popup
        return isPopup;
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
