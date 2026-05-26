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
import { AccountInfo } from "@azure/msal-browser";
import { ArmSubscription, TenantInfo } from "../services/types";
export interface TokenProvider {
    getAccessToken: () => Promise<string>;
    getBatchAccessToken: () => Promise<string>;
    checkHealth: () => Promise<{
        healthy: boolean;
        error: string | null;
    }>;
    loadSubscriptions?: (store: unknown) => Promise<void>;
}
/** localStorage key for the user's chosen login mode. Survives reloads. */
export declare const LOGIN_MODE_KEY = "azbm.login-mode.v1";
/** localStorage key for the user's custom client id (when mode = "custom"). */
export declare const LOGIN_CUSTOM_CLIENT_KEY = "azbm.login-mode-custom-client.v1";
/**
 * Login modes — each maps to a different first-party (or operator-
 * supplied) public client id. They all share the MSAL PKCE pipeline;
 * only the clientId in the Configuration differs.
 */
export type LoginMode = "cli" | "powershell" | "vs" | "portal" | "custom";
export declare function getStoredLoginMode(): LoginMode;
export declare function setStoredLoginMode(mode: LoginMode): void;
export declare function getStoredCustomClientId(): string;
export declare function setStoredCustomClientId(clientId: string): void;
/** Static catalogue of preset client ids — surfaced in the picker UI. */
export declare const LOGIN_MODE_PRESETS: ReadonlyArray<{
    mode: LoginMode;
    label: string;
    clientId: string;
    description: string;
}>;
/**
 * Exported utility — call from UI if the user wants to manually clear auth cache.
 */
export declare function purgeMsalCache(): void;
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
export declare function handlePopupIfNeeded(): boolean;
export interface LoginAccountOptions {
    /** Authority tenant — defaults to "common". */
    tenantId?: string;
    /**
     * Pre-fills the email field of the MSAL popup so the user can land on the
     * password screen with one keystroke. Used by the auto-login button after
     * a fresh user-create / password-reset operation.
     */
    loginHint?: string;
    /**
     * Override the default `select_account` prompt. Pass `"login"` to force a
     * fresh credential entry (no SSO short-circuit) — that's what auto-login
     * uses so the just-created credential actually gets typed.
     */
    prompt?: "select_account" | "login" | "consent" | "none";
}
export declare function loginAccount(tenantIdOrOpts?: string | LoginAccountOptions): Promise<AccountInfo | null>;
/**
 * Logout a specific account by homeAccountId. Removes it from MSAL's
 * cache without opening a popup — popup-based AAD signout is unreliable
 * (popups blocked, user cancels, etc.) and leaving cache entries behind
 * is what caused removed accounts to reappear on reload.
 *
 * Three layers of removal, run in order:
 *   1. msalApp.clearCache({ account }) — MSAL's official cache-only
 *      logout. Removes account, ID-token, refresh-token, access-token
 *      records for this homeAccountId.
 *   2. Direct localStorage sweep — fallback that removes ANY key
 *      containing the homeAccountId. Catches stragglers MSAL's
 *      internal cleanup might miss (different schema versions,
 *      partial-write states).
 *   3. Server-side shared-cache push — flush the snapshot now, no
 *      debounce, so other browsers see the removal on their next
 *      load instead of pulling a stale snapshot that re-adds it.
 *
 * Does NOT sign the user out at AAD. Their refresh token at AAD is
 * still valid until it expires naturally; if the operator wants a full
 * AAD sign-out they can use a separate API (not currently exposed).
 */
export declare function logoutAccount(homeAccountId: string): Promise<void>;
/**
 * Get all currently logged-in MSAL accounts.
 */
export declare function getAllLoggedInAccounts(): Promise<AccountInfo[]>;
/**
 * Options accepted by every per-account `get*TokenForAccount` helper.
 * Keeps the shape one place so adding a new field (CAE claims here)
 * doesn't require updating four call sites.
 */
export interface AcquireTokenOptions {
    /**
     * Bypass MSAL's silent-acquire cache and force a fresh token mint
     * at the AAD STS. Use for billing-scope reads where a freshly-
     * granted role assignment must be reflected in the token's claims.
     */
    forceRefresh?: boolean;
    /**
     * CAE claims-challenge payload, base64-encoded JSON per
     * `https://learn.microsoft.com/entra/identity-platform/claims-challenge`.
     * Pass through verbatim from a 401's `WWW-Authenticate: Bearer …
     * claims="…"` header — the `parseCaeClaimsChallenge` helper below
     * extracts the value. MSAL forwards this to AAD on the silent
     * acquire so the new token satisfies the critical revocation event
     * (token revocation, password change, MFA elevation, etc.).
     */
    claims?: string;
}
/**
 * Parse a `WWW-Authenticate: Bearer …` response header value and
 * return the inner `claims="…"` payload, base64-decoded back to its
 * raw JSON form (MSAL accepts the JSON form directly).
 *
 * Returns `null` when the header is missing, not a Bearer challenge,
 * or carries no `claims` parameter. Real-world AAD claims challenges
 * look like:
 *
 *   WWW-Authenticate: Bearer realm="", authorization_uri="https://...",
 *     error="insufficient_claims",
 *     claims="eyJhY2Nlc3NfdG9rZW4iOnsiYWNycyI6eyJlc3NlbnRpYWwiOnRydWUsInZhbHVlIjoiYzI1In19fQ=="
 *
 * We extract the `claims="…"` value, strip the surrounding quotes,
 * then base64-decode it to the original JSON. AAD accepts either
 * the base64 form or the decoded JSON; we return the JSON because
 * MSAL.js's SilentRequest.claims field documents the decoded form.
 */
export declare function parseCaeClaimsChallenge(headerValue: string | null | undefined): string | null;
/**
 * Get ARM token for a specific account by homeAccountId.
 *
 * Pass `{ forceRefresh: true }` to bypass the MSAL silent cache. Use this
 * for billing-scope writes (EA subscription creation, role-assignment
 * sensitive ops) where role grants applied moments ago must be visible.
 */
export declare function getArmTokenForAccount(homeAccountId: string, tenantId?: string, opts?: AcquireTokenOptions): Promise<string>;
/**
 * Decode the claims of a JWT WITHOUT verifying its signature.
 *
 * Diagnostic-only — used to surface tenant/oid/audience info when a
 * billing-scope call returns 401 with "User is not authorized." Never use
 * this for authorization decisions.
 */
export declare function decodeJwtClaimsUnsafe(jwt: string): Record<string, unknown> | null;
/**
 * Get Batch token for a specific account by homeAccountId.
 */
export declare function getBatchTokenForAccount(homeAccountId: string, tenantId?: string, opts?: AcquireTokenOptions): Promise<string>;
/**
 * Get Microsoft Graph token for a specific account by homeAccountId.
 *
 * `forceRefresh: true` bypasses both the imported-tokens cache AND
 * MSAL's silent-acquire cache — see the Batch helper for why this
 * matters for cross-tenant flows.
 */
export declare function getGraphTokenForAccount(homeAccountId: string, tenantId?: string, opts?: AcquireTokenOptions): Promise<string>;
/**
 * Get a Partner Center API token for a specific account.
 *
 * The Partner Center API at `api.partnercenter.microsoft.com` only
 * issues tokens to principals that belong to a CSP partner tenant —
 * for tenants without partner enrolment, the consent / token request
 * itself fails. That failure mode is exactly the signal the Partner
 * Center page uses to report "this account is NOT a CSP partner", so
 * callers should be ready for this to throw rather than silently
 * returning an empty/invalid token.
 */
export declare function getPartnerCenterTokenForAccount(homeAccountId: string, tenantId?: string): Promise<string>;
/**
 * List subscriptions for a specific account (by homeAccountId).
 */
export declare function listSubscriptionsForAccount(homeAccountId: string): Promise<ArmSubscription[]>;
/** Like `getArmTokenForAccount` but proactively renews when exp < now + 90 s. */
export declare function acquireArmTokenFresh(account: AccountInfo, opts?: AcquireTokenOptions & {
    tenantId?: string;
}): Promise<string>;
/** Proactive-renewal variant of `getBatchTokenForAccount`. */
export declare function acquireBatchTokenFresh(account: AccountInfo, opts?: AcquireTokenOptions & {
    tenantId?: string;
}): Promise<string>;
/** Proactive-renewal variant of `getGraphTokenForAccount`. */
export declare function acquireGraphTokenFresh(account: AccountInfo, opts?: AcquireTokenOptions & {
    tenantId?: string;
}): Promise<string>;
/** Proactive-renewal variant of `getPartnerCenterTokenForAccount`. */
export declare function acquirePartnerCenterTokenFresh(account: AccountInfo, opts?: AcquireTokenOptions & {
    tenantId?: string;
}): Promise<string>;
/**
 * Force interactive login via popup. Returns the authenticated account.
 * Calls loginAccount() under the hood and sets first account as "primary".
 * Serialized — only one login popup can be open at a time.
 *
 * If tenantId is provided, login is scoped to that tenant authority.
 */
export declare function login(tenantId?: string): Promise<AccountInfo | null>;
/**
 * Logout and clear all cached tokens (logs out ALL accounts).
 *
 * Also wipes the encrypted credential vault used by the auto-portal-login
 * feature so a follow-on user on the same browser does not inherit
 * provisioned credentials.
 *
 * When `everywhere: true`, ALSO opens an AAD `endSessionRequest` against
 * the operator's home tenant so the user is signed OUT at AAD itself.
 * Defaults to false (local-only sign-out) to preserve existing behaviour.
 * See `signOutEverywhere()` for a convenience wrapper.
 */
export declare function logout(opts?: {
    everywhere?: boolean;
}): Promise<void>;
/**
 * Full sign-out: clear local cache AND invalidate the AAD SSO cookie
 * for the given account so a subsequent sign-in must re-enter
 * credentials. Wraps `logout({ everywhere: true })` but accepts a
 * specific account so multi-account setups can target ONE without
 * affecting the others.
 *
 * Note: AAD's `logoutHint` parameter pre-fills the user identifier on
 * the AAD sign-out confirmation page so a re-sign-in from the same
 * browser doesn't need to retype the upn. It does NOT skip the
 * confirmation page — that's an AAD-side UX choice.
 */
export declare function signOutEverywhere(account: AccountInfo): Promise<void>;
/**
 * Check if user is currently authenticated.
 * Returns true if any account is logged in.
 */
export declare function isAuthenticated(): Promise<boolean>;
/**
 * Get the current user info (primary account).
 * Checks the in-memory _activeAccount first, then falls back to
 * getAllAccounts() from the MSAL cache (localStorage).
 */
export declare function getCurrentUser(): Promise<AccountInfo | null>;
/**
 * Get ARM access token (for management.azure.com) using primary account.
 * Pass tenantId to get a token for a specific tenant (cross-tenant access).
 *
 * When tenantId is omitted, falls back to the per-account active
 * tenant (set by setActiveTenant on login or tenant-switch). This
 * matches the resolution order getGraphToken uses, and fixes a class
 * of bugs where a user signs in via a guest tenant authority but
 * silent acquisition then targets the home tenant, throwing
 * InteractionRequired and surfacing as "Not signed in" in the health
 * check.
 */
export declare function getArmToken(tenantId?: string): Promise<string>;
/**
 * Get Batch data-plane access token (for {account}.{region}.batch.azure.com) using primary account.
 * Pass tenantId to get a token for a specific tenant. When omitted,
 * falls back to the per-account active tenant (same resolution as
 * getArmToken / getGraphToken).
 */
export declare function getBatchToken(tenantId?: string): Promise<string>;
/**
 * Get Microsoft Graph access token using the primary account.
 * Pass tenantId to target a specific tenant. When omitted, the active
 * tenant for the primary account (if any) is used.
 */
export declare function getGraphToken(tenantId?: string): Promise<string>;
/**
 * Persist the active tenant for an account in sessionStorage.
 * Subsequent token acquisitions for that account default to this tenant.
 */
export declare function setActiveTenant(homeAccountId: string, tenantId: string): void;
/**
 * Read the persisted active tenant for an account, or null if none.
 */
export declare function getActiveTenant(homeAccountId: string): string | null;
/**
 * Clear the persisted active tenant for an account.
 */
export declare function clearActiveTenant(homeAccountId: string): void;
/**
 * List all Azure AD tenants the caller can access via ARM.
 *
 * Calls `https://management.azure.com/tenants` with an ARM token.
 * If `homeAccountId` is provided, the token is scoped to that account
 * and (optionally) its persisted active tenant — this allows surfacing
 * the per-account tenant set in multi-account scenarios.
 */
export declare function listAccessibleTenants(homeAccountId?: string): Promise<TenantInfo[]>;
/**
 * List all Azure subscriptions using the ARM token (primary account).
 *
 * Includes `state` so callers can filter to "Enabled" — Azure accounts
 * routinely have AzureEA / ExpiredEA / Disabled / Warned / PastDue
 * subscriptions alongside active ones, and the rest of the app must
 * skip them silently rather than treat them as a load failure.
 */
export declare function listSubscriptions(): Promise<Array<{
    subscriptionId: string;
    displayName: string;
    tenantId?: string;
    state?: string;
}>>;
/**
 * Get auth mode: "msal" (Entra ID) or "cli" (Azure CLI proxy).
 * Returns "msal" if MSAL has accounts, "cli" if we need to fall back.
 */
export declare function getAuthMode(): Promise<"msal" | "cli">;
/**
 * Optionally set an external token provider (e.g. from the desktop app).
 * When set, getAccessToken / getBatchAccessToken delegate to it.
 */
export declare function setTokenProvider(provider: TokenProvider): void;
/**
 * The built-in MSAL-backed token provider, also exported so callers can
 * reference it as a concrete TokenProvider.
 */
export declare const msalAuth: TokenProvider;
declare global {
    interface Window {
        __azbm?: {
            autoSignIn: (upn: string, tenantId?: string) => Promise<{
                ok: boolean;
                username?: string;
                error?: string;
            }>;
        };
    }
}
//# sourceMappingURL=msal-auth.d.ts.map