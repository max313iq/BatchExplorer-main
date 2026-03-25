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
 */
import {
    PublicClientApplication,
    InteractionRequiredAuthError,
    AccountInfo,
    AuthenticationResult,
    Configuration,
    SilentRequest,
    PopupRequest,
} from "@azure/msal-browser";

// ---------------------------------------------------------------------------
// TokenProvider interface — usable by both web and desktop
// ---------------------------------------------------------------------------
export interface TokenProvider {
    getAccessToken: () => Promise<string>;
    getBatchAccessToken: () => Promise<string>;
    checkHealth: () => Promise<{ healthy: boolean; error: string | null }>;
    loadSubscriptions?: (store: any) => Promise<void>;
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
    system: {
        windowHashTimeout: 60000,
        iframeHashTimeout: 10000,
        loadFrameTimeout: 10000,
    },
};

let _msalInstance: PublicClientApplication | null = null;
let _initComplete: Promise<PublicClientApplication> | null = null;
let _activeAccount: AccountInfo | null = null;

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

async function getMsalInstance(): Promise<PublicClientApplication> {
    if (_initComplete) return _initComplete;

    _initComplete = (async () => {
        const msalApp = new PublicClientApplication(msalConfig);
        await msalApp.initialize();
        _msalInstance = msalApp;

        // Check for any pending redirect (in case redirect was used previously)
        try {
            const response = await msalApp.handleRedirectPromise();
            if (response?.account) {
                _activeAccount = response.account;
                msalApp.setActiveAccount(response.account);
                console.log(
                    "[MSAL] Account from redirect:",
                    response.account.username
                );
            }
        } catch {
            // Ignore redirect errors — we use popup flow
        }

        // Check for cached accounts (from previous sessions via localStorage)
        if (!_activeAccount) {
            const accounts = msalApp.getAllAccounts();
            console.log(
                "[MSAL] Cached accounts:",
                accounts.length,
                accounts.map((a) => a.username)
            );
            if (accounts.length > 0) {
                _activeAccount = accounts[0];
                msalApp.setActiveAccount(accounts[0]);
            }
        }

        return msalApp;
    })();

    return _initComplete;
}

/**
 * Force interactive login via popup. Returns the authenticated account.
 * Serialized — only one login popup can be open at a time.
 */
export async function login(): Promise<AccountInfo | null> {
    const msalApp = await getMsalInstance();
    try {
        const result = await msalApp.loginPopup({
            scopes: [ARM_SCOPE],
            prompt: "select_account",
        });
        if (result?.account) {
            // IMMEDIATELY persist the account so getAllAccounts() returns it
            _activeAccount = result.account;
            msalApp.setActiveAccount(result.account);
            console.log(
                "[MSAL] Popup login successful:",
                result.account.username
            );
            console.log(
                "[MSAL] Accounts after login:",
                msalApp.getAllAccounts().length
            );
            return result.account;
        }
        return null;
    } catch (e: any) {
        if (
            e?.errorCode === "popup_window_error" ||
            e?.errorCode === "empty_window_error"
        ) {
            throw new Error(
                "Popup blocked! Allow popups for this site in your browser, then try again."
            );
        }
        throw e;
    }
}

/**
 * Logout and clear all cached tokens.
 */
export async function logout(): Promise<void> {
    const msalApp = await getMsalInstance();
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
 * Returns true if getCurrentUser() finds an account (checks _activeAccount
 * first, then falls back to getAllAccounts()).
 */
export async function isAuthenticated(): Promise<boolean> {
    const user = await getCurrentUser();
    return user != null;
}

/**
 * Get the current user info.
 * Checks the in-memory _activeAccount first, then falls back to
 * getAllAccounts() from the MSAL cache (localStorage).
 */
export async function getCurrentUser(): Promise<AccountInfo | null> {
    if (_activeAccount) return _activeAccount;
    const msalApp = await getMsalInstance();
    const accounts = msalApp.getAllAccounts();
    if (accounts.length > 0) {
        _activeAccount = accounts[0];
        msalApp.setActiveAccount(accounts[0]);
        return accounts[0];
    }
    return null;
}

// Serialize all interactive auth to prevent "interaction_in_progress" errors
let _loginInProgress: Promise<AccountInfo | null> | null = null;

/**
 * Acquire a token silently. Optionally target a specific tenant.
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
        msalApp.setActiveAccount(accounts[0]);
    }

    const silentRequest: SilentRequest = {
        scopes,
        account: _activeAccount!,
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
 * Get ARM access token (for management.azure.com).
 * Pass tenantId to get a token for a specific tenant (cross-tenant access).
 */
export async function getArmToken(tenantId?: string): Promise<string> {
    const result = await acquireToken([ARM_SCOPE], tenantId);
    return result.accessToken;
}

/**
 * Get Batch data-plane access token (for {account}.{region}.batch.azure.com).
 * Pass tenantId to get a token for a specific tenant.
 */
export async function getBatchToken(tenantId?: string): Promise<string> {
    const result = await acquireToken([BATCH_SCOPE], tenantId);
    return result.accessToken;
}

/**
 * List all Azure subscriptions using the ARM token.
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
    return (data.value ?? []).map((s: any) => ({
        subscriptionId: s.subscriptionId,
        displayName: s.displayName,
        tenantId: s.tenantId,
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
        } catch (e: any) {
            return { healthy: false, error: e?.message ?? String(e) };
        }
    },
    async loadSubscriptions(store: any): Promise<void> {
        if (_externalProvider?.loadSubscriptions) {
            return _externalProvider.loadSubscriptions(store);
        }
        const subs = await listSubscriptions();
        if (store && typeof store.setSubscriptions === "function") {
            store.setSubscriptions(subs);
        }
    },
};
