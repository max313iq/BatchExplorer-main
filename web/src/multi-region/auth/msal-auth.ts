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
 */
export async function login(): Promise<AccountInfo | null> {
    const msalApp = await getMsalInstance();

    const loginRequest: PopupRequest = {
        scopes: [ARM_SCOPE],
        prompt: "select_account",
    };

    try {
        const result = await msalApp.loginPopup(loginRequest);
        if (result.account) {
            _activeAccount = result.account;
            msalApp.setActiveAccount(result.account);
        }
        return result.account;
    } catch (error: any) {
        console.error("MSAL login failed:", error);
        throw error;
    }
}

/**
 * Logout and clear all cached tokens.
 */
export async function logout(): Promise<void> {
    const msalApp = await getMsalInstance();
    _activeAccount = null;
    await msalApp.logoutPopup();
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

/**
 * Acquire a token silently, falling back to popup if needed.
 */
async function acquireToken(scopes: string[]): Promise<AuthenticationResult> {
    const msalApp = await getMsalInstance();

    if (!_activeAccount) {
        const accounts = msalApp.getAllAccounts();
        if (accounts.length === 0) {
            // No account — force login
            const account = await login();
            if (!account) throw new Error("Login required");
        } else {
            _activeAccount = accounts[0];
            msalApp.setActiveAccount(accounts[0]);
        }
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
            // Token expired or consent needed — popup
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
