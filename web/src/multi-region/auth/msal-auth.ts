/**
 * MSAL Browser Authentication for Azure Batch Manager
 *
 * Uses the same Azure CLI client ID as Batch Explorer desktop,
 * forcing an interactive Entra ID login to get ARM and Batch tokens.
 * No Azure CLI or proxy server needed.
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

// Azure CLI's well-known client ID (same as Batch Explorer desktop uses)
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

// Scopes for different Azure resources
const ARM_SCOPE = "https://management.azure.com/.default";
const BATCH_SCOPE = "https://batch.core.windows.net/.default";

const msalConfig: Configuration = {
    auth: {
        clientId: AZURE_CLI_CLIENT_ID,
        authority: "https://login.microsoftonline.com/organizations",
        redirectUri: window.location.origin,
        navigateToLoginRequestUrl: true,
    },
    cache: {
        cacheLocation: "sessionStorage",
        storeAuthStateInCookie: false,
    },
};

let _msalInstance: PublicClientApplication | null = null;
let _initPromise: Promise<void> | null = null;
let _activeAccount: AccountInfo | null = null;

async function getMsalInstance(): Promise<PublicClientApplication> {
    if (_msalInstance && _initPromise) {
        await _initPromise;
        return _msalInstance;
    }
    _msalInstance = new PublicClientApplication(msalConfig);
    _initPromise = _msalInstance.initialize();
    await _initPromise;

    // Handle redirect response (if coming back from auth redirect)
    try {
        const response = await _msalInstance.handleRedirectPromise();
        if (response?.account) {
            _activeAccount = response.account;
            _msalInstance.setActiveAccount(response.account);
        }
    } catch {
        // Ignore redirect errors
    }

    // Check for existing accounts
    const accounts = _msalInstance.getAllAccounts();
    if (accounts.length > 0) {
        _activeAccount = accounts[0];
        _msalInstance.setActiveAccount(accounts[0]);
    }

    return _msalInstance;
}

/**
 * Force interactive login via popup. Returns the authenticated account.
 * Serialized — only one login popup can be open at a time.
 */
export async function login(): Promise<AccountInfo | null> {
    // If a login is already in progress, wait for it
    if (_loginInProgress) return _loginInProgress;

    _loginInProgress = (async () => {
        const msalApp = await getMsalInstance();

        // Try popup first, fall back to redirect if blocked
        try {
            const result = await msalApp.loginPopup({
                scopes: [ARM_SCOPE],
                prompt: "select_account",
            });
            if (result.account) {
                _activeAccount = result.account;
                msalApp.setActiveAccount(result.account);
            }
            return result.account;
        } catch (popupError: any) {
            // If popup is blocked, use redirect flow instead
            if (
                popupError?.errorCode === "popup_window_error" ||
                popupError?.errorCode === "empty_window_error"
            ) {
                console.log("Popup blocked, using redirect flow...");
                await msalApp.loginRedirect({
                    scopes: [ARM_SCOPE],
                    prompt: "select_account",
                });
                // Page will redirect — this won't return
                return null;
            }
            throw popupError;
        } finally {
            _loginInProgress = null;
        }
    })();

    return _loginInProgress;
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
        // If popup blocked, use redirect
        await msalApp.logoutRedirect();
    }
}

/**
 * Check if user is currently authenticated.
 */
export async function isAuthenticated(): Promise<boolean> {
    const msalApp = await getMsalInstance();
    const accounts = msalApp.getAllAccounts();
    return accounts.length > 0;
}

/**
 * Get the current user info.
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
 * Acquire a token silently. Does NOT auto-trigger popup —
 * user must click "Sign in with Azure" first.
 */
async function acquireToken(scopes: string[]): Promise<AuthenticationResult> {
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
    };

    try {
        return await msalApp.acquireTokenSilent(silentRequest);
    } catch (error) {
        if (error instanceof InteractionRequiredAuthError) {
            // Token expired — try popup, but serialize to prevent concurrent popups
            if (_loginInProgress) {
                await _loginInProgress;
                // After login completes, retry silent
                return await msalApp.acquireTokenSilent(silentRequest);
            }
            return await msalApp.acquireTokenPopup({ scopes });
        }
        throw error;
    }
}

/**
 * Get ARM access token (for management.azure.com).
 */
export async function getArmToken(): Promise<string> {
    const result = await acquireToken([ARM_SCOPE]);
    return result.accessToken;
}

/**
 * Get Batch data-plane access token (for {account}.{region}.batch.azure.com).
 */
export async function getBatchToken(): Promise<string> {
    const result = await acquireToken([BATCH_SCOPE]);
    return result.accessToken;
}

/**
 * List all Azure subscriptions using the ARM token.
 */
export async function listSubscriptions(): Promise<
    Array<{ subscriptionId: string; displayName: string }>
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
    }));
}

/**
 * Get auth mode: "msal" (Entra ID) or "cli" (Azure CLI proxy).
 * Returns "msal" if MSAL has accounts, "cli" if we need to fall back.
 */
export async function getAuthMode(): Promise<"msal" | "cli"> {
    try {
        const msalApp = await getMsalInstance();
        const accounts = msalApp.getAllAccounts();
        return accounts.length > 0 ? "msal" : "cli";
    } catch {
        return "cli";
    }
}
