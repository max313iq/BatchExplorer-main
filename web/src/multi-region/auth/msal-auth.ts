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
import {
  ArmSubscription,
  AzureRequestError,
  TenantInfo,
  classifyHttpError,
} from "../services/types";
import { guardedFetch } from "../scheduling/request-governance";
import { credentialVault } from "./credential-vault";
import * as importedTokens from "./imported-tokens";
import { recordAuditEvent } from "./audit-binding";

// Local re-export of the import module's storage keys list so the
// logout() targeted-clear has ONE source of truth for "which keys
// does the imported-tokens vault own". Keeps msal-auth from having
// to know the exact key strings.
const IMPORTED_TOKEN_KEYS = importedTokens.IMPORTED_TOKEN_STORAGE_KEYS;

// ---------------------------------------------------------------------------
// TokenProvider interface — usable by both web and desktop
// ---------------------------------------------------------------------------
export interface TokenProvider {
  getAccessToken: () => Promise<string>;
  getBatchAccessToken: () => Promise<string>;
  checkHealth: () => Promise<{ healthy: boolean; error: string | null }>;
  loadSubscriptions?: (store: unknown) => Promise<void>;
}

// Well-known first-party public client IDs that can do PKCE from a JS
// SPA. They target the same ARM / Graph audiences; tokens look identical
// to resource servers — only the `appid` claim on the token differs.
//
//   - Azure CLI:        04b07795-…  → matches what `az login` mints.
//   - Azure PowerShell: 1950a258-…  → matches Connect-AzAccount tokens.
//   - Visual Studio:    872cd9fa-…  → matches VS / VS Code Azure tokens.
//   - Azure Portal:     c44b4083-…  → the portal SPA itself. AAD restricts
//                                     this client to portal.azure.com
//                                     redirect URIs, so it will likely
//                                     reject our localhost PKCE flow with
//                                     unauthorized_client. Wired up
//                                     anyway in case the tenant grants
//                                     the redirect; user is on the hook
//                                     for that.
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const AZURE_POWERSHELL_CLIENT_ID = "1950a258-227b-4e31-a9cf-717495945fc2";
const AZURE_VS_CLIENT_ID = "872cd9fa-d31f-45e0-9eab-6e460a02d1f1";
const AZURE_PORTAL_CLIENT_ID = "c44b4083-3bb0-49c1-b47d-974e53cbdf3c";

/** localStorage key for the user's chosen login mode. Survives reloads. */
export const LOGIN_MODE_KEY = "azbm.login-mode.v1";
/** localStorage key for the user's custom client id (when mode = "custom"). */
export const LOGIN_CUSTOM_CLIENT_KEY = "azbm.login-mode-custom-client.v1";

/**
 * Login modes — each maps to a different first-party (or operator-
 * supplied) public client id. They all share the MSAL PKCE pipeline;
 * only the clientId in the Configuration differs.
 */
export type LoginMode = "cli" | "powershell" | "vs" | "portal" | "custom";

const VALID_MODES: ReadonlySet<LoginMode> = new Set([
  "cli",
  "powershell",
  "vs",
  "portal",
  "custom",
]);

export function getStoredLoginMode(): LoginMode {
  if (typeof window === "undefined") return "cli";
  try {
    const raw = window.localStorage.getItem(LOGIN_MODE_KEY);
    if (raw && VALID_MODES.has(raw as LoginMode)) return raw as LoginMode;
    // Migrate the pre-existing legacy value "portal" — that one used to
    // mean Azure PowerShell. Map it forward so existing operators don't
    // get bumped to a different client mid-session.
    if (raw === "portal-legacy") return "powershell";
  } catch {
    /* fall through */
  }
  return "cli";
}

export function setStoredLoginMode(mode: LoginMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOGIN_MODE_KEY, mode);
  } catch {
    /* localStorage may be disabled — fail soft */
  }
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getStoredCustomClientId(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LOGIN_CUSTOM_CLIENT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setStoredCustomClientId(clientId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOGIN_CUSTOM_CLIENT_KEY, clientId.trim());
  } catch {
    /* ignore */
  }
}

/** Static catalogue of preset client ids — surfaced in the picker UI. */
export const LOGIN_MODE_PRESETS: ReadonlyArray<{
  mode: LoginMode;
  label: string;
  clientId: string;
  description: string;
}> = [
  {
    mode: "cli",
    label: "App client (Azure CLI)",
    clientId: AZURE_CLI_CLIENT_ID,
    description:
      "Uses Azure CLI's well-known public client id; tokens look like what `az login` mints. Default.",
  },
  {
    mode: "powershell",
    label: "Azure PowerShell",
    clientId: AZURE_POWERSHELL_CLIENT_ID,
    description:
      "First-party public client used by Connect-AzAccount. PKCE-friendly from any origin.",
  },
  {
    mode: "vs",
    label: "Visual Studio",
    clientId: AZURE_VS_CLIENT_ID,
    description:
      "First-party client used by VS / VS Code Azure integrations.",
  },
  {
    mode: "portal",
    label: "Azure Portal (may reject)",
    clientId: AZURE_PORTAL_CLIENT_ID,
    description:
      "Real Azure Portal SPA client id. AAD restricts its redirect URIs to portal.azure.com, so login will usually fail with unauthorized_client from this origin. Wired anyway in case your tenant relaxed it.",
  },
];

/** Resolved client id for the currently configured login mode. */
function getActiveClientId(): string {
  const mode = getStoredLoginMode();
  if (mode === "custom") {
    const custom = getStoredCustomClientId();
    if (UUID_LIKE.test(custom)) return custom;
    // Custom mode picked but no/invalid GUID stored — fall back to CLI
    // so MSAL still initialises cleanly.
    return AZURE_CLI_CLIENT_ID;
  }
  const preset = LOGIN_MODE_PRESETS.find((p) => p.mode === mode);
  return preset?.clientId ?? AZURE_CLI_CLIENT_ID;
}

// Scopes for different Azure resources
const ARM_SCOPE = "https://management.azure.com/.default";
const BATCH_SCOPE = "https://batch.core.windows.net/.default";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
// Partner Center API — used by the Partner Center page to probe CSP /
// MPN capability for a signed-in account. The resource URI is the
// docs-blessed value for the public cloud's Partner Center API.
const PARTNER_CENTER_SCOPE =
  "https://api.partnercenter.microsoft.com/user_impersonation";

// Pinned ARM api-versions for the bootstrap list calls below. Centralizing
// these keeps the version number out of the call sites and makes it
// easy to bump alongside the rest of the ARM stack.
const ARM_SUBSCRIPTIONS_API_VERSION = "2022-12-01";
const ARM_TENANTS_API_VERSION = "2022-12-01";

/**
 * Parse a non-2xx ARM response (from one of the bootstrap list calls
 * below) into the same `AzureRequestError` envelope the rest of the
 * service layer uses. Previously these three functions threw a bare
 * `new Error("Failed to ...: <status>")` which meant callers couldn't
 * `instanceof AuthError` / `RateLimitError` and audit-log entries
 * lacked structured fields (code, urlPath, status).
 */
async function _toArmErrorMsal(
  response: Response,
  fallbackMessage: string,
): Promise<AzureRequestError> {
  let body: Record<string, unknown> = {};
  let raw = "";
  try {
    raw = await response.text();
    if (raw && raw.trim()) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Not JSON — keep raw for fallback below.
      }
    }
  } catch {
    /* network read failure — body stays empty */
  }
  const inner = (body as { error?: Record<string, unknown> }).error ?? {};
  const code = (inner.code as string | undefined) ?? "AzureRequestError";
  const innerMessage = (inner.message as string | undefined) ?? "";
  let message = innerMessage.trim() ||
    (raw && raw.trim() ? raw.trim().slice(0, 500) : "") ||
    `${fallbackMessage}: ${response.status}`;
  const urlPath = (() => {
    try {
      return new URL(response.url).pathname;
    } catch {
      return response.url || undefined;
    }
  })();
  if (urlPath) message = `${response.status} ${urlPath}: ${message}`;
  const DISPLAY_MAX = 1000;
  if (message.length > DISPLAY_MAX) {
    message = `${message.slice(0, DISPLAY_MAX)}…[truncated]`;
  }
  const retryAfter = response.headers.get("Retry-After");
  const err = classifyHttpError(
    message,
    response.status,
    code,
    body,
    retryAfter,
  );
  if (urlPath) err.urlPath = urlPath;
  return err;
}

const ACTIVE_TENANT_KEY_PREFIX = "msal:active-tenant:";

function buildAuthority(tenantId?: string): string | undefined {
  if (!tenantId) return undefined;
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}`;
}

function _resolveTenantForAccount(
  homeAccountId: string,
  explicit?: string,
): string | undefined {
  if (explicit) return explicit;
  return getActiveTenant(homeAccountId) ?? undefined;
}

// ---------------------------------------------------------------------------
// Custom MSAL network client — proxies token POST requests through the local
// dev server to bypass CORS.  Azure CLI's client ID is a native/public app:
// Azure AD does NOT return Access-Control-Allow-Origin for direct browser
// POSTs to its token endpoint.  The proxy forwards server-side where CORS
// is not enforced by the browser.
// ---------------------------------------------------------------------------
//
// IMPORTANT — these `fetch()` calls do NOT route through guardedFetch by design.
// MSAL's NetworkModule talks to login.microsoftonline.com (Entra ID STS),
// which has its own throttling rules independent of ARM. Routing STS
// traffic through guardedFetch's circuit breaker would cause expected
// STS responses (interaction_required, invalid_grant) to incorrectly
// trip the ARM-family breaker. Leave these direct.
const msalNetworkClient: INetworkModule = {
  async sendGetRequestAsync<T>(
    url: string,
    options?: NetworkRequestOptions,
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
    options?: NetworkRequestOptions,
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
    // Resolved from the persisted login-mode preference. Switching modes
    // requires a reload (we ask the AppHeader to call purgeMsalCache()
    // before reloading so the new clientId starts clean).
    clientId: getActiveClientId(),
    authority: "https://login.microsoftonline.com/common",
    redirectUri: window.location.origin + "/",
  },
  cache: {
    // localStorage so signed-in accounts persist across page reloads + dev
    // server restarts. The popup callback uses broadcastResponseToMainFrame()
    // (BroadcastChannel) to deliver the auth code to the parent, so the
    // popup never needs to share storage with the parent — localStorage is
    // safe even though MSAL writes are tab-scoped at runtime.
    //
    // Quota safety net: _isQuotaError() in this file detects
    // QuotaExceededError on token writes and triggers _clearMsalCache(),
    // re-prompting the user to sign in cleanly rather than silently failing.
    //
    // DEV-ONLY CAVEAT: this setting is paired with the dev-server's
    // /api/auth/proxy-token middleware (web/webpack.config.js) which
    // bypasses AAD's CORS protection for direct browser POSTs. In a
    // PRODUCTION deployment you MUST EITHER (a) deploy WITHOUT that
    // proxy and use a confidential-client backend for token exchange,
    // OR (b) flip this to "sessionStorage" / "memory" so tokens
    // don't outlive the tab. Either way, do NOT ship the current
    // dev-shaped config to production. A one-time `console.warn` at
    // module init surfaces this (see below).
    cacheLocation: "localStorage",
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

// One-time production-mode warning. The shared-cache `localStorage`
// strategy is dev-only — see the `cacheLocation` comment block above
// for the production guidance. We DO NOT change behaviour here
// (that's the responsibility of a real production build pipeline);
// we just surface a visible warning in the console so a misconfigured
// deploy is obvious.
//
// `process.env.NODE_ENV` is replaced at build time by webpack's
// DefinePlugin (or rspack equivalent), so this guard is dead-coded
// out in dev. We check `typeof` first so it doesn't crash a non-webpack
// runtime (jest, ts-node).
let _prodWarningEmitted = false;
function _maybeWarnProductionConfig(): void {
  if (_prodWarningEmitted) return;
  _prodWarningEmitted = true;
  try {
    const env =
      typeof process !== "undefined"
        ? process.env?.NODE_ENV
        : undefined;
    if (env === "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[azbm] shared-cache (cacheLocation:localStorage + /api/auth/proxy-token) is dev-only; " +
          "do not deploy with the proxy enabled. See msal-auth.ts cacheLocation comment block.",
      );
    }
  } catch {
    /* never crash production over a logging guard */
  }
}

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
  // Wipe state for every known client id so switching login modes
  // doesn't leave token cache entries from a previous client id —
  // those would silently 401 against the new client's audience checks.
  const knownIds = [
    AZURE_CLI_CLIENT_ID,
    AZURE_POWERSHELL_CLIENT_ID,
    AZURE_VS_CLIENT_ID,
    AZURE_PORTAL_CLIENT_ID,
    getStoredCustomClientId(),
  ].filter((id) => !!id);
  const keysToRemove = Object.keys(localStorage).filter(
    (k) =>
      knownIds.some((id) => k.startsWith(id)) ||
      k.startsWith("msal.") ||
      k.includes("login.microsoftonline.com") ||
      k.includes("msal"),
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
    "[MSAL] localStorage quota exceeded — cache cleared. Sign in again.",
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
  recordAuditEvent({
    actor: "system",
    action: "purgeMsalCache",
    status: "success",
  });
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
        console.error("[MSAL Popup] broadcastResponseToMainFrame error:", e);
        // GUARD: do NOT close the window unless we are TRULY a popup
        // opened by a parent (`window.opener`) AND that parent is
        // still alive. Calling window.close() on a top-level user-
        // navigated tab is a no-op in modern browsers BUT historically
        // it logged a "Scripts may close only the windows that were
        // opened by them" warning that made the console noisy when
        // operators stumbled into a stale URL containing `code=…`.
        //
        // Second guard: also bail when `window.opener.closed === true`
        // — the parent died before the popup finished, so calling
        // close() can no longer be observed by anything, and the
        // operator may prefer to keep the popup tab open to copy
        // whatever error AAD surfaced.
        try {
          const opener = window.opener;
          const hasOpener =
            opener && typeof opener === "object" && opener !== window;
          // `opener.closed` access can throw a SecurityError across
          // origins — wrap defensively.
          let openerStillAlive = false;
          if (hasOpener) {
            try {
              openerStillAlive = !(opener as Window).closed;
            } catch {
              openerStillAlive = false;
            }
          }
          if (hasOpener && openerStillAlive) {
            window.close();
          } else {
            console.warn(
              "[MSAL Popup] suppressing window.close() — no live opener (likely a stale callback URL pasted into a top-level tab).",
            );
          }
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
  _maybeWarnProductionConfig();

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
        console.log("[MSAL] Account from redirect:", response.account.username);
      }
    } catch {
      // Ignore redirect errors — we use popup flow
    }

    // Load ALL cached accounts from MSAL into the _accounts Map
    const cachedAccounts = msalApp.getAllAccounts();
    console.log(
      "[MSAL] Cached accounts:",
      cachedAccounts.length,
      cachedAccounts.map((a) => a.username),
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
 *
 * If tenantId is provided, login is scoped to that tenant authority
 * (e.g. for cross-tenant guest access). When omitted, "common" is used.
 *
 * Watchdog: if a previous popup wedged the in-flight lock (e.g. user closed
 * the OS popup window before MSAL resolved, leaving us with a Promise that
 * never settles), a 90 s timer force-clears it on the next call so the
 * caller isn't permanently blocked. The previous attempt's promise is
 * abandoned — its `await` callers will eventually time out on their own.
 */
const LOGIN_WATCHDOG_MS = 90_000;
let _loginStartedAt: number | null = null;

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

export async function loginAccount(
  tenantIdOrOpts?: string | LoginAccountOptions,
): Promise<AccountInfo | null> {
  // Normalize legacy `loginAccount(tenantId)` callers.
  const opts: LoginAccountOptions =
    typeof tenantIdOrOpts === "string"
      ? { tenantId: tenantIdOrOpts }
      : (tenantIdOrOpts ?? {});
  const { tenantId, loginHint, prompt } = opts;
  // Watchdog: if a prior login has been "in progress" longer than 90 s,
  // assume it wedged (user closed popup, browser killed it, etc.) and
  // reset the lock so this click can open a new popup.
  if (
    _loginInProgress &&
    _loginStartedAt !== null &&
    Date.now() - _loginStartedAt > LOGIN_WATCHDOG_MS
  ) {
    console.warn(
      "[MSAL] loginAccount watchdog: previous popup never settled after",
      LOGIN_WATCHDOG_MS,
      "ms — clearing lock so a new popup can open.",
    );
    _loginInProgress = null;
    _loginStartedAt = null;
  }

  if (_loginInProgress) {
    return _loginInProgress;
  }

  const authority = buildAuthority(tenantId);
  _loginStartedAt = Date.now();

  _loginInProgress = (async () => {
    const msalApp = await getMsalInstance();
    // Capture the popup window handle via the MSAL event bus so we can
    // detect manual close. MSAL.js v5.x's loginPopup waits up to 60s on a
    // BroadcastChannel for the popup's redirect-bridge response — if the
    // operator closes the popup themselves, MSAL doesn't notice and the
    // promise hangs for the full 60s. We poll popup.closed and reject the
    // race early so the WebUI returns control to the operator immediately.
    let popupRef: Window | null = null;
    let popupCloseInterval: ReturnType<typeof setInterval> | null = null;
    let cancelClosePromise: ((reason: Error) => void) | null = null;
    const eventCallbackId = msalApp.addEventCallback(
      ((msg: { eventType?: string; payload?: { popupWindow?: Window } }) => {
        if (msg.eventType === "msal:popupOpened" && msg.payload?.popupWindow) {
          popupRef = msg.payload.popupWindow;
        }
      }) as unknown as Parameters<typeof msalApp.addEventCallback>[0],
    );
    // Race detail: when MSAL.loginPopup succeeds, broadcastResponseToMainFrame
    // in the popup calls window.close() AS PART of the success path. So the
    // popup IS closed momentarily before MSAL's parent finishes the token
    // exchange and resolves. A naive popup.closed poll would fire
    // "cancelled" before MSAL resolves and lose the race.
    //
    // Mitigation: when popup.closed is first observed, start a grace timer.
    // If loginPopup hasn't resolved within ~15 s of close, then it's a real
    // cancellation. If MSAL resolves first, the finally block tears
    // everything down before the grace timer fires.
    //
    // 15 s was chosen because BroadcastChannel delivery in some browsers
    // (or with privacy extensions) has been observed to take noticeably
    // longer than the natural close-to-resolve gap (~few hundred ms),
    // especially after the popup runs window.close() — the message event
    // can be delayed until the post-close cleanup completes. If MSAL's own
    // 60 s bridge timeout fires we'll surface that error directly.
    const POPUP_CLOSE_GRACE_MS = 15000;
    const closeWatchPromise = new Promise<never>((_, reject) => {
      cancelClosePromise = reject;
      let closeDetectedAt: number | null = null;
      popupCloseInterval = setInterval(() => {
        if (!popupRef) return;
        if (popupRef.closed) {
          if (closeDetectedAt === null) {
            closeDetectedAt = Date.now();
            return;
          }
          if (Date.now() - closeDetectedAt < POPUP_CLOSE_GRACE_MS) {
            return;
          }
          // Popup stayed closed past the grace window. MSAL never resolved
          // → declare it a cancellation.
          if (popupCloseInterval) {
            clearInterval(popupCloseInterval);
            popupCloseInterval = null;
          }
          // Clear MSAL's interaction-in-progress lock so the next
          // loginPopup attempt isn't blocked by "interaction_in_progress".
          // MSAL would normally clear this when loginPopup resolves, but
          // we're rejecting BEFORE loginPopup completes (it's still
          // waiting on its 60s bridge timeout in the background). Without
          // this manual cleanup the next click on Sign in / Manual (MSAL)
          // would throw immediately.
          try {
            for (const k of Object.keys(localStorage)) {
              if (k.includes("interaction.status")) {
                localStorage.removeItem(k);
              }
            }
            for (const k of Object.keys(sessionStorage)) {
              if (k.includes("interaction.status")) {
                sessionStorage.removeItem(k);
              }
            }
          } catch {
            /* ignore — cleanup is best-effort */
          }
          const err = new Error(
            "Sign-in cancelled — popup was closed before authentication completed.",
          ) as Error & { errorCode?: string };
          err.errorCode = "user_cancelled";
          reject(err);
        } else {
          // Popup re-opened (or never closed). Reset the grace timer so a
          // brief flicker doesn't accumulate towards cancellation.
          closeDetectedAt = null;
        }
      }, 400);
    });
    // Suppress unhandled-rejection warnings: when the loginPopup branch
    // wins the race, this promise still rejects from the finally cleanup
    // and Promise.race never observes it.
    closeWatchPromise.catch(() => undefined);
    const loginPopupPromise = msalApp.loginPopup({
      scopes: [ARM_SCOPE],
      prompt: prompt ?? "select_account",
      ...(loginHint ? { loginHint } : {}),
      ...(authority ? { authority } : {}),
    });
    // Diagnostic: log loginPopup's eventual settlement so we can tell from
    // the browser console whether MSAL completed normally, hit the
    // redirect_bridge_timeout, or threw something else. Critically — this
    // fires AFTER the close-watcher rejects the outer race, so it's the
    // only signal that tells us MSAL's view of the flow.
    loginPopupPromise.then(
      (r) =>
        console.log(
          "[MSAL] loginPopup settled (resolved):",
          r?.account?.username ?? "(no account)",
        ),
      (err) =>
        console.log(
          "[MSAL] loginPopup settled (rejected):",
          (err as { errorCode?: string })?.errorCode ?? "?",
          (err as Error)?.message ?? String(err),
        ),
    );
    try {
      const result = await Promise.race([
        loginPopupPromise,
        closeWatchPromise,
      ]);
      if (result?.account) {
        _addAccountToMap(result.account);
        // Also set as MSAL active account
        msalApp.setActiveAccount(result.account);
        if (tenantId) {
          setActiveTenant(result.account.homeAccountId, tenantId);
        }
        console.log(
          "[MSAL] Popup login successful (multi-account):",
          result.account.username,
        );
        console.log("[MSAL] Total accounts after login:", _accounts.size);
        recordAuditEvent({
          actor: result.account.username,
          action: "loginAccount",
          target: tenantId ?? result.account.tenantId ?? "(default)",
          status: "success",
          details: {
            homeAccountId: result.account.homeAccountId,
            tenantId: result.account.tenantId,
            requestedTenant: tenantId ?? null,
          },
        });
        return result.account;
      }
      return null;
    } catch (e: unknown) {
      const msalError = e as { errorCode?: string; errorMessage?: string };
      if (
        msalError?.errorCode === "popup_window_error" ||
        msalError?.errorCode === "empty_window_error"
      ) {
        throw new Error(
          "Popup blocked! Allow popups for this site in your browser, then try again.",
        );
      }
      // Self-heal: AAD rejected the client we asked for (most commonly
      // the Azure Portal client id `c44b…` which locks redirect URIs to
      // portal.azure.com). Revert the stored login mode to Azure CLI so
      // the next reload starts clean, and surface a clear hint pointing
      // the user at the Token Importer for portal-minted tokens.
      const msg = String(msalError?.errorMessage ?? "") +
        " " + String((e as Error)?.message ?? "");
      const isRedirectMismatch =
        msg.includes("AADSTS50011") ||
        msg.toLowerCase().includes("redirect_uri") ||
        msalError?.errorCode === "unauthorized_client";
      if (isRedirectMismatch) {
        const currentMode = getStoredLoginMode();
        if (currentMode !== "cli") {
          console.warn(
            "[MSAL] redirect_uri_mismatch on mode",
            currentMode,
            "→ auto-reverting to 'cli' so the next sign-in works.",
          );
          setStoredLoginMode("cli");
          throw new Error(
            "AAD rejected this app's redirect URI for the chosen Login mode " +
              "(usually because the client id is locked to portal.azure.com). " +
              "Reverted to App client (Azure CLI) — reload and try again, OR " +
              "use the Token Importer page to paste a token from your existing " +
              "Azure Portal session.",
          );
        }
      }
      throw e;
    } finally {
      // Tear down the close watcher and the event subscription so we don't
      // leak intervals or hold a popup reference past the function lifetime.
      if (popupCloseInterval) clearInterval(popupCloseInterval);
      if (cancelClosePromise) {
        // Reject the still-pending close-watch promise harmlessly so its
        // rejection is observed (avoids unhandled-rejection warnings).
        try {
          (cancelClosePromise as (reason: Error) => void)(
            new Error("loginAccount finished — close watcher cancelled"),
          );
        } catch {
          /* */
        }
      }
      if (eventCallbackId) {
        try {
          msalApp.removeEventCallback(eventCallbackId);
        } catch {
          /* */
        }
      }
      _loginInProgress = null;
      _loginStartedAt = null;
    }
  })();

  return _loginInProgress;
}

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
export async function logoutAccount(homeAccountId: string): Promise<void> {
  const msalApp = await getMsalInstance();
  const account = _accounts.get(homeAccountId);

  _accounts.delete(homeAccountId);
  if (_activeAccount?.homeAccountId === homeAccountId) {
    const remaining = Array.from(_accounts.values());
    _activeAccount = remaining.length > 0 ? remaining[0] : null;
    if (_activeAccount) {
      msalApp.setActiveAccount(_activeAccount);
    }
  }

  // Layer 1: MSAL's official per-account cache clear.
  if (account) {
    try {
      await msalApp.clearCache({ account });
    } catch (err) {
      console.warn(
        "[MSAL] clearCache failed; falling back to direct sweep",
        err,
      );
    }
  }

  // Layer 2: direct sweep of any localStorage key referencing this
  // homeAccountId. MSAL's v5.10 key shapes vary (`msal|3|<homeId>|...`,
  // `msal.<clientId>.<homeId>...`, etc.); a substring match catches all
  // of them. Without this, a flaky clearCache leaves stray records that
  // bring the account back on next page load.
  try {
    const toDrop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.includes(homeAccountId)) {
        toDrop.push(k);
      }
    }
    for (const k of toDrop) {
      localStorage.removeItem(k);
    }
  } catch {
    /* best-effort */
  }

  // Layer 3: tell the shared-cache server to drop the keys we just
  // removed, immediately. The debounced push would eventually do this
  // too, but a reload within ~600 ms after Remove would otherwise pull
  // a stale snapshot and re-hydrate the account.
  try {
    const flush = (
      window as Window & { __azbmFlushSharedCache?: () => Promise<void> }
    ).__azbmFlushSharedCache;
    if (flush) await flush();
  } catch {
    /* best-effort */
  }

  recordAuditEvent({
    actor: account?.username || homeAccountId,
    action: "logoutAccount",
    target: homeAccountId,
    status: "success",
    details: {
      homeAccountId,
      remainingAccounts: _accounts.size,
    },
  });
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
 *
 * `opts.forceRefresh: true` bypasses the MSAL silent cache and forces a
 * round-trip to Entra ID. This is critical for billing-scope APIs (e.g.
 * Subscription Alias / EA Subscription Creator) where a role assignment
 * granted AFTER the previous token was minted will not be visible until a
 * fresh token is issued. The default remains `false` so steady-state reads
 * (subscription list, account quota refresh, etc.) keep using the cache.
 */
/**
 * In-flight token-acquisition coalescer keyed by
 * `<homeAccountId>::<tenantId>::<scope-fingerprint>::<forceRefresh>`.
 * Without this, N parallel ARM/Batch reads on app boot fire N parallel
 * MSAL silent flows; each contends for the same cache entry, and Entra
 * ID's STS rate-limits aggressive token-refresh bursts which can
 * cascade into 429s OR temporary token suspension.
 *
 * MSAL itself handles cache reads in-process, but `acquireTokenSilent`
 * still does work (cache-key normalization, expiry checks, refresh-
 * token redemption) and during a refresh-token redemption it makes a
 * network call. Coalescing that here saves both CPU and STS round-trips.
 */
const _tokenInflight = new Map<string, Promise<AuthenticationResult>>();

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
export function parseCaeClaimsChallenge(
  headerValue: string | null | undefined,
): string | null {
  if (!headerValue) return null;
  const v = headerValue.trim();
  // Quick early-out — must be a Bearer challenge.
  if (!/^Bearer\b/i.test(v)) return null;
  // Match `claims="..."` allowing escaped quotes inside. AAD never
  // emits literal embedded quotes, but the regex tolerates them for
  // robustness. RFC 7235 §2.2 quoted-string handling — close enough
  // for AAD's well-formed responses.
  const match = v.match(/claims\s*=\s*"((?:[^"\\]|\\.)*)"/i);
  if (!match) return null;
  const raw = match[1].replace(/\\(.)/g, "$1"); // unescape \"
  if (!raw) return null;
  // AAD base64-encodes the claims JSON. Try to decode; if the result
  // already looks like JSON (starts with `{`), it wasn't encoded and
  // we hand it back as-is.
  if (raw.startsWith("{")) return raw;
  try {
    // base64url → base64.
    const padded =
      raw.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((raw.length + 3) % 4);
    const decoded =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf-8");
    return decoded;
  } catch {
    // Not base64 after all — surface the raw value so AAD can decide.
    return raw;
  }
}

function tokenCoalesceKey(
  homeAccountId: string,
  tenantId: string | undefined,
  scopes: string[],
  forceRefresh: boolean,
  claims?: string,
): string {
  const scopeKey = scopes.slice().sort().join("|");
  // Claims challenges must NEVER coalesce with non-challenge acquires:
  // the claims payload changes the AAD response, so a previously-
  // cached promise for `claims: undefined` would return the wrong
  // token to a caller that just received a 401 with claims="…". Hash
  // the claims string into the key so distinct challenges bucket
  // separately.
  const claimsBucket = claims ? `c:${claims.length}:${claims.slice(0, 24)}` : "";
  return `${homeAccountId}::${tenantId ?? ""}::${scopeKey}::${forceRefresh ? "1" : "0"}::${claimsBucket}`;
}

async function acquireTokenForAccount(
  scopes: string[],
  homeAccountId: string,
  tenantId?: string,
  opts?: AcquireTokenOptions,
): Promise<AuthenticationResult> {
  const msalApp = await getMsalInstance();

  const account = _accounts.get(homeAccountId);
  if (!account) {
    throw new Error(
      `Account not found: ${homeAccountId}. Please sign in first.`,
    );
  }

  const forceRefresh = opts?.forceRefresh === true;

  const silentRequest: SilentRequest = {
    scopes,
    account,
    forceRefresh,
    ...(tenantId
      ? { authority: `https://login.microsoftonline.com/${tenantId}` }
      : {}),
    // CAE (Continuous Access Evaluation) — when an ARM (or any
    // downstream) call returns 401 with a `WWW-Authenticate` header
    // carrying `claims="…"`, MSAL must re-issue with that exact
    // claims payload so AAD mints a token whose claims satisfy the
    // critical revocation event. Callers pass the parsed challenge
    // through `opts.claims`; MSAL forwards it to the STS verbatim.
    ...(opts?.claims ? { claims: opts.claims } : {}),
  };

  // Coalesce identical concurrent acquisitions. forceRefresh:true
  // intentionally gets its own bucket so a "must-refresh" caller never
  // gets handed a cached promise from a "may-be-cached" caller.
  const coalesceKey = tokenCoalesceKey(
    homeAccountId,
    tenantId,
    scopes,
    forceRefresh,
    opts?.claims,
  );
  const existing = _tokenInflight.get(coalesceKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await msalApp.acquireTokenSilent(silentRequest);
    } catch (error) {
      // Cache quota exceeded — clear and surface a clear message
      if (_isQuotaError(error)) {
        _clearMsalCache();
        throw new Error(
          "Browser storage quota exceeded and MSAL cache was cleared. " +
            "Please sign in again.",
        );
      }
      if (error instanceof InteractionRequiredAuthError) {
        // Don't auto-escalate to popup. We used to call
        // `acquireTokenPopup` here, but page-load silent flows aren't a
        // user gesture, so the browser blocks the popup AND we end up with
        // cascading silent errors (the symptom: 3× 400s on /token from the
        // proxy when the cached refresh token is stale). Instead, throw a
        // clear error — the AuthBanner / "Sign in" button is the
        // user-initiated recovery path.
        //
        // If a popup IS already in flight (user clicked sign-in), wait for
        // it to settle and retry once silently.
        if (_loginInProgress) {
          await _loginInProgress;
          return await msalApp.acquireTokenSilent(silentRequest);
        }
        throw new InteractionRequiredAuthError(
          "interaction_required",
          "Cached session is no longer valid for this account. Please sign in again.",
        );
      }
      throw error;
    }
  })();

  _tokenInflight.set(coalesceKey, promise);
  // Always clean the in-flight map once the promise settles, regardless
  // of outcome — failures shouldn't be cached.
  promise.finally(() => {
    if (_tokenInflight.get(coalesceKey) === promise) {
      _tokenInflight.delete(coalesceKey);
    }
  });
  return promise;
}

/**
 * Get ARM token for a specific account by homeAccountId.
 *
 * Pass `{ forceRefresh: true }` to bypass the MSAL silent cache. Use this
 * for billing-scope writes (EA subscription creation, role-assignment
 * sensitive ops) where role grants applied moments ago must be visible.
 */
export async function getArmTokenForAccount(
  homeAccountId: string,
  tenantId?: string,
  opts?: AcquireTokenOptions,
): Promise<string> {
  // Imported-token short-circuit. The store can answer in two ways:
  //   1. A previously-imported access token for this audience is still
  //      inside its exp window.
  //   2. The operator pasted a refresh token: ensureImportedToken will
  //      hit AAD's /token endpoint, mint a new access token for the
  //      requested scope, cache it, and return.
  // Either way MSAL is skipped. `forceRefresh: true` falls through to
  // MSAL to honour the existing semantic. `claims` (CAE challenge)
  // ALSO falls through — imported tokens have no AAD-side claims-
  // challenge round-trip, so a CAE challenge can only be satisfied
  // by going through MSAL.
  if (!opts?.forceRefresh && !opts?.claims) {
    try {
      const imported = await importedTokens.ensureImportedToken(
        homeAccountId,
        "arm",
      );
      if (imported) return imported;
    } catch (err) {
      console.warn(
        "[imported-tokens] ARM redemption failed; falling back to MSAL:",
        err,
      );
    }
  }
  const effectiveTenant = _resolveTenantForAccount(homeAccountId, tenantId);
  const result = await acquireTokenForAccount(
    [ARM_SCOPE],
    homeAccountId,
    effectiveTenant,
    opts,
  );
  return result.accessToken;
}

/**
 * Decode the claims of a JWT WITHOUT verifying its signature.
 *
 * Diagnostic-only — used to surface tenant/oid/audience info when a
 * billing-scope call returns 401 with "User is not authorized." Never use
 * this for authorization decisions.
 */
export function decodeJwtClaimsUnsafe(
  jwt: string,
): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1]!;
    // base64url -> base64
    const padded =
      payload.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((payload.length + 3) % 4);
    const json =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Get Batch token for a specific account by homeAccountId.
 */
export async function getBatchTokenForAccount(
  homeAccountId: string,
  tenantId?: string,
  opts?: AcquireTokenOptions,
): Promise<string> {
  // `forceRefresh: true` deliberately bypasses both the imported-tokens
  // cache AND MSAL's silent-acquire cache. This matters for cross-
  // tenant flows like Tricky Login where the silent cache may hold a
  // home-tenant token whose scopes/audience match — MSAL would return
  // that cached token without honouring the `authority` arg, producing
  // the wrong-tenant-tid bug. Force-refresh forces a fresh authority-
  // scoped mint. `claims` also bypasses the imported-tokens cache
  // (see ARM getter above for the same rationale).
  if (!opts?.forceRefresh && !opts?.claims) {
    try {
      const imported = await importedTokens.ensureImportedToken(
        homeAccountId,
        "batch",
      );
      if (imported) return imported;
    } catch (err) {
      console.warn(
        "[imported-tokens] Batch redemption failed; falling back to MSAL:",
        err,
      );
    }
  }
  const effectiveTenant = _resolveTenantForAccount(homeAccountId, tenantId);
  const result = await acquireTokenForAccount(
    [BATCH_SCOPE],
    homeAccountId,
    effectiveTenant,
    opts,
  );
  return result.accessToken;
}

/**
 * Get Microsoft Graph token for a specific account by homeAccountId.
 *
 * `forceRefresh: true` bypasses both the imported-tokens cache AND
 * MSAL's silent-acquire cache — see the Batch helper for why this
 * matters for cross-tenant flows.
 */
export async function getGraphTokenForAccount(
  homeAccountId: string,
  tenantId?: string,
  opts?: AcquireTokenOptions,
): Promise<string> {
  if (!opts?.forceRefresh && !opts?.claims) {
    try {
      const imported = await importedTokens.ensureImportedToken(
        homeAccountId,
        "graph",
      );
      if (imported) return imported;
    } catch (err) {
      console.warn(
        "[imported-tokens] Graph redemption failed; falling back to MSAL:",
        err,
      );
    }
  }
  const effectiveTenant = _resolveTenantForAccount(homeAccountId, tenantId);
  const result = await acquireTokenForAccount(
    [GRAPH_SCOPE],
    homeAccountId,
    effectiveTenant,
    opts,
  );
  return result.accessToken;
}

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
export async function getPartnerCenterTokenForAccount(
  homeAccountId: string,
  tenantId?: string,
): Promise<string> {
  const effectiveTenant = _resolveTenantForAccount(homeAccountId, tenantId);
  const result = await acquireTokenForAccount(
    [PARTNER_CENTER_SCOPE],
    homeAccountId,
    effectiveTenant,
  );
  return result.accessToken;
}

/**
 * List subscriptions for a specific account (by homeAccountId).
 */
export async function listSubscriptionsForAccount(
  homeAccountId: string,
): Promise<ArmSubscription[]> {
  const token = await getArmTokenForAccount(homeAccountId);
  const url =
    `https://management.azure.com/subscriptions?api-version=${ARM_SUBSCRIPTIONS_API_VERSION}`;
  // Routed through guardedFetch so /subscriptions calls participate in
  // the same circuit-breaker, throttle-budget, and client-request-id
  // pipeline as the rest of the ARM stack. Previously a direct fetch().
  const response = await guardedFetch(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    { subscriptionId: "_arm-subscriptions", family: "arm" },
  );
  if (!response.ok) {
    throw await _toArmErrorMsal(
      response,
      `Failed to list subscriptions for account ${homeAccountId}`,
    );
  }
  // Auto-follow ARM `nextLink` so callers see the FULL subscription set.
  // Tenants with > 50 subscriptions previously had pages 2+ silently
  // dropped — every UI page that lists subscriptions inherited this.
  type Page = {
    value?: Array<Record<string, unknown>>;
    nextLink?: string;
  };
  const out: ArmSubscription[] = [];
  let pageData = (await response.json()) as Page;
  for (const s of pageData.value ?? []) {
    out.push({
      subscriptionId: s.subscriptionId as string,
      displayName: s.displayName as string,
      state: s.state as string,
      tenantId: s.tenantId as string,
    });
  }
  while (pageData.nextLink) {
    const nextResp = await guardedFetch(
      pageData.nextLink,
      { headers: { Authorization: `Bearer ${token}` } },
      { subscriptionId: "_arm-subscriptions", family: "arm" },
    );
    if (!nextResp.ok) {
      throw await _toArmErrorMsal(
        nextResp,
        `Failed to page subscriptions for account ${homeAccountId}`,
      );
    }
    pageData = (await nextResp.json()) as Page;
    for (const s of pageData.value ?? []) {
      out.push({
        subscriptionId: s.subscriptionId as string,
        displayName: s.displayName as string,
        state: s.state as string,
        tenantId: s.tenantId as string,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Proactive renewal helpers
//
// `useArmToken` already runs a 60-s-before-expiry background refresh, but
// callers OUTSIDE the React tree (services / agents / scheduled jobs) can't
// use a hook. These helpers give them the same protection: check the
// cached token's `exp` claim; if it's < 90 s from expiring, silently
// refresh BEFORE returning. 90 s matches what MSAL's own
// `acquireTokenSilent` considers "expired enough to refresh" while staying
// safely above the 60-s hook threshold so the two cannot race on the same
// account.
//
// `claims` is forwarded to `acquireTokenForAccount` so a CAE challenge
// received from a downstream service can drive the renewal.
// ---------------------------------------------------------------------------

/** Renewal threshold — refresh if exp < now + this. */
const PROACTIVE_RENEWAL_LEAD_SECONDS = 90;

/**
 * Return `true` when the JWT's `exp` claim is within
 * `PROACTIVE_RENEWAL_LEAD_SECONDS` of now (or unparseable, in which case
 * we err on the side of refreshing).
 */
function _isTokenAlmostExpired(jwt: string): boolean {
  const claims = decodeJwtClaimsUnsafe(jwt);
  if (!claims) return true;
  const exp = typeof claims.exp === "number" ? claims.exp : Number(claims.exp);
  if (!Number.isFinite(exp) || exp <= 0) return true;
  const now = Math.floor(Date.now() / 1000);
  return exp < now + PROACTIVE_RENEWAL_LEAD_SECONDS;
}

/**
 * Internal helper — try a non-forced acquire first; if the returned
 * token is almost expired, retry with forceRefresh. CAE claims are
 * propagated unchanged.
 */
async function _acquireFreshFor(
  audience: "arm" | "graph" | "batch" | "partnerCenter",
  homeAccountId: string,
  opts?: AcquireTokenOptions & { tenantId?: string },
): Promise<string> {
  const scope =
    audience === "arm"
      ? ARM_SCOPE
      : audience === "graph"
        ? GRAPH_SCOPE
        : audience === "batch"
          ? BATCH_SCOPE
          : PARTNER_CENTER_SCOPE;
  const effectiveTenant = _resolveTenantForAccount(homeAccountId, opts?.tenantId);

  // First attempt — silent, may return cached.
  const first = await acquireTokenForAccount(
    [scope],
    homeAccountId,
    effectiveTenant,
    opts,
  );
  if (!_isTokenAlmostExpired(first.accessToken)) return first.accessToken;

  // Cached value is too close to exp — force-refresh through STS.
  const fresh = await acquireTokenForAccount([scope], homeAccountId, effectiveTenant, {
    ...opts,
    forceRefresh: true,
  });
  return fresh.accessToken;
}

/** Like `getArmTokenForAccount` but proactively renews when exp < now + 90 s. */
export async function acquireArmTokenFresh(
  account: AccountInfo,
  opts?: AcquireTokenOptions & { tenantId?: string },
): Promise<string> {
  return _acquireFreshFor("arm", account.homeAccountId, opts);
}

/** Proactive-renewal variant of `getBatchTokenForAccount`. */
export async function acquireBatchTokenFresh(
  account: AccountInfo,
  opts?: AcquireTokenOptions & { tenantId?: string },
): Promise<string> {
  return _acquireFreshFor("batch", account.homeAccountId, opts);
}

/** Proactive-renewal variant of `getGraphTokenForAccount`. */
export async function acquireGraphTokenFresh(
  account: AccountInfo,
  opts?: AcquireTokenOptions & { tenantId?: string },
): Promise<string> {
  return _acquireFreshFor("graph", account.homeAccountId, opts);
}

/** Proactive-renewal variant of `getPartnerCenterTokenForAccount`. */
export async function acquirePartnerCenterTokenFresh(
  account: AccountInfo,
  opts?: AcquireTokenOptions & { tenantId?: string },
): Promise<string> {
  return _acquireFreshFor("partnerCenter", account.homeAccountId, opts);
}

// ---------------------------------------------------------------------------
// Backward-compatible single-account API
// ---------------------------------------------------------------------------

/**
 * Force interactive login via popup. Returns the authenticated account.
 * Calls loginAccount() under the hood and sets first account as "primary".
 * Serialized — only one login popup can be open at a time.
 *
 * If tenantId is provided, login is scoped to that tenant authority.
 */
export async function login(tenantId?: string): Promise<AccountInfo | null> {
  return loginAccount(tenantId);
}

/**
 * Per-prefix list of localStorage keys this app's auth subsystem owns.
 * Used by `logout()` (and `signOutEverywhere()`) to scrub auth state
 * WITHOUT blowing away unrelated app state (e.g. UI prefs, draft form
 * data, GPU calculator caches). Previously the catch-on-popup-failure
 * path called the unbounded `localStorage.clear()`, which wiped every
 * key on the origin — surprising the operator with a lost editor draft
 * any time a logout popup failed.
 *
 * Anything outside these prefixes is left alone. The companion
 * `imported-tokens.IMPORTED_TOKEN_STORAGE_KEYS` covers the exact
 * non-prefixed keys (`azbm.imported-tokens.v1`, etc.) that the
 * imported-tokens module writes.
 */
const AUTH_STORAGE_PREFIXES: readonly string[] = Object.freeze([
  "azbm.",            // every key written by this app
  "azbm:",            // colon-form (credential-vault uses this)
  "msal.",            // MSAL.js v3 schema
  "msal|",            // MSAL.js v5 schema (newer pipe-delimited keys)
  "azure.account.",   // legacy multi-account routing keys
]);

/**
 * Scrub every localStorage key whose name matches the auth-owned
 * prefix list OR the imported-tokens explicit key list. Anything not
 * matching is preserved.
 */
function _targetedClearAuthLocalStorage(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const matches =
        AUTH_STORAGE_PREFIXES.some((p) => k.startsWith(p)) ||
        IMPORTED_TOKEN_KEYS.includes(k) ||
        k.includes("login.microsoftonline.com");
      if (matches) toRemove.push(k);
    }
    for (const k of toRemove) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* localStorage unavailable — fail soft */
  }
}

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
export async function logout(opts?: { everywhere?: boolean }): Promise<void> {
  const msalApp = await getMsalInstance();

  // Snapshot accounts BEFORE we clear state so the audit log + the
  // "everywhere" branch below know who was signed out.
  const accountsBefore = Array.from(_accounts.values());

  // Clear internal state
  _accounts.clear();
  _activeAccount = null;

  // Wipe credential vault — safe to call before/after MSAL logout.
  try {
    credentialVault.clearAll();
  } catch {
    /* best-effort */
  }

  try {
    if (opts?.everywhere && accountsBefore.length > 0) {
      // Sign-out-at-AAD path. logoutPopup with logoutHint causes AAD
      // to invalidate the SSO cookie for the named user, not just our
      // local cache. We log out the FIRST account (primary) — if
      // multiple accounts existed, callers can pass `everywhere` to
      // `signOutEverywhere(account)` per-account to target each.
      const primary = accountsBefore[0];
      await msalApp.logoutPopup({
        account: primary,
        logoutHint: primary.username,
      });
    } else {
      await msalApp.logoutPopup();
    }
  } catch {
    // Popup failed (user closed it, browser blocked it, etc.) — still
    // clear local cache so the in-memory state matches what the
    // operator sees. TARGETED clear, not the previous blanket
    // localStorage.clear() — see `AUTH_STORAGE_PREFIXES` for the
    // rationale (preserves unrelated app state).
    _targetedClearAuthLocalStorage();
  }

  recordAuditEvent({
    actor: accountsBefore[0]?.username || "system",
    action: opts?.everywhere ? "signOutEverywhere" : "logoutAccount",
    target: accountsBefore.map((a) => a.username).join(",") || "(none)",
    status: "success",
    details: {
      accountsCleared: accountsBefore.length,
      everywhere: !!opts?.everywhere,
    },
  });
}

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
export async function signOutEverywhere(account: AccountInfo): Promise<void> {
  const msalApp = await getMsalInstance();
  try {
    await msalApp.logoutPopup({
      account,
      logoutHint: account.username,
    });
  } finally {
    // Always run the local scrub even if the popup failed. The
    // operator's intent was "sign out everywhere" — local cache must
    // be cleared regardless.
    _accounts.delete(account.homeAccountId);
    if (_activeAccount?.homeAccountId === account.homeAccountId) {
      const remaining = Array.from(_accounts.values());
      _activeAccount = remaining[0] ?? null;
      if (_activeAccount) msalApp.setActiveAccount(_activeAccount);
    }
    _targetedClearAuthLocalStorage();
    recordAuditEvent({
      actor: account.username,
      action: "signOutEverywhere",
      target: account.username,
      status: "success",
      details: {
        homeAccountId: account.homeAccountId,
        tenantId: account.tenantId,
      },
    });
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
  tenantId?: string,
): Promise<AuthenticationResult> {
  const msalApp = await getMsalInstance();

  if (!_activeAccount) {
    const accounts = msalApp.getAllAccounts();
    if (accounts.length === 0) {
      throw new Error(
        "Not signed in. Click 'Sign in with Azure' to authenticate.",
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
      // Same rationale as acquireTokenForAccount: don't auto-popup. Wait
      // for any in-flight login first; otherwise surface as
      // InteractionRequired so the AuthBanner can prompt re-auth.
      if (_loginInProgress) {
        await _loginInProgress;
        return await msalApp.acquireTokenSilent(silentRequest);
      }
      throw new InteractionRequiredAuthError(
        "interaction_required",
        "Cached session is no longer valid. Please sign in again.",
      );
    }
    throw error;
  }
}

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
export async function getArmToken(tenantId?: string): Promise<string> {
  let effectiveTenant = tenantId;
  if (!effectiveTenant && _activeAccount) {
    effectiveTenant =
      getActiveTenant(_activeAccount.homeAccountId) ?? undefined;
  }
  const result = await acquireToken([ARM_SCOPE], effectiveTenant);
  return result.accessToken;
}

/**
 * Get Batch data-plane access token (for {account}.{region}.batch.azure.com) using primary account.
 * Pass tenantId to get a token for a specific tenant. When omitted,
 * falls back to the per-account active tenant (same resolution as
 * getArmToken / getGraphToken).
 */
export async function getBatchToken(tenantId?: string): Promise<string> {
  let effectiveTenant = tenantId;
  if (!effectiveTenant && _activeAccount) {
    effectiveTenant =
      getActiveTenant(_activeAccount.homeAccountId) ?? undefined;
  }
  const result = await acquireToken([BATCH_SCOPE], effectiveTenant);
  return result.accessToken;
}

/**
 * Get Microsoft Graph access token using the primary account.
 * Pass tenantId to target a specific tenant. When omitted, the active
 * tenant for the primary account (if any) is used.
 */
export async function getGraphToken(tenantId?: string): Promise<string> {
  let effectiveTenant = tenantId;
  if (!effectiveTenant && _activeAccount) {
    effectiveTenant =
      getActiveTenant(_activeAccount.homeAccountId) ?? undefined;
  }
  const result = await acquireToken([GRAPH_SCOPE], effectiveTenant);
  return result.accessToken;
}

/**
 * Persist the active tenant for an account in sessionStorage.
 * Subsequent token acquisitions for that account default to this tenant.
 */
export function setActiveTenant(homeAccountId: string, tenantId: string): void {
  if (!homeAccountId || !tenantId) return;
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(
        `${ACTIVE_TENANT_KEY_PREFIX}${homeAccountId}`,
        tenantId,
      );
    }
  } catch {
    // sessionStorage may be disabled — fail soft
  }
}

/**
 * Read the persisted active tenant for an account, or null if none.
 */
export function getActiveTenant(homeAccountId: string): string | null {
  if (!homeAccountId) return null;
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(
      `${ACTIVE_TENANT_KEY_PREFIX}${homeAccountId}`,
    );
  } catch {
    return null;
  }
}

/**
 * Clear the persisted active tenant for an account.
 */
export function clearActiveTenant(homeAccountId: string): void {
  if (!homeAccountId) return;
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(`${ACTIVE_TENANT_KEY_PREFIX}${homeAccountId}`);
    }
  } catch {
    // ignore
  }
}

/**
 * List all Azure AD tenants the caller can access via ARM.
 *
 * Calls `https://management.azure.com/tenants` with an ARM token.
 * If `homeAccountId` is provided, the token is scoped to that account
 * and (optionally) its persisted active tenant — this allows surfacing
 * the per-account tenant set in multi-account scenarios.
 */
export async function listAccessibleTenants(
  homeAccountId?: string,
): Promise<TenantInfo[]> {
  const token = homeAccountId
    ? await getArmTokenForAccount(homeAccountId)
    : await getArmToken();

  // Bumped api-version 2020-01-01 → 2022-12-01 for parity with the rest
  // of the ARM stack. Routed through guardedFetch so the request goes
  // through the same circuit-breaker, throttle-budget, and
  // x-ms-client-request-id pipeline as every other ARM call. Direct
  // fetch() here was a governance leak — a 429 from /tenants would not
  // be observed by the budget tracker, and would not contribute to the
  // breaker's open/half-open decisions.
  const url = `https://management.azure.com/tenants?api-version=${ARM_TENANTS_API_VERSION}`;
  const response = await guardedFetch(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    { subscriptionId: "_arm-tenant", family: "arm" },
  );
  if (!response.ok) {
    throw await _toArmErrorMsal(response, "Failed to list tenants");
  }
  type Page = {
    value?: Array<Record<string, unknown>>;
    nextLink?: string;
  };
  const out: TenantInfo[] = [];
  const mapTenant = (t: Record<string, unknown>): TenantInfo => ({
    tenantId: (t.tenantId as string) ?? (t.id as string) ?? "",
    displayName:
      (t.displayName as string) ??
      (t.defaultDomain as string) ??
      (t.tenantId as string) ??
      "(unknown tenant)",
    defaultDomain: t.defaultDomain as string | undefined,
    tenantCategory: t.tenantCategory as string | undefined,
  });
  let pageData = (await response.json()) as Page;
  for (const t of pageData.value ?? []) out.push(mapTenant(t));
  // Auto-follow nextLink. /tenants almost always fits in one page, but
  // operators with cross-tenant invitations in many directories CAN
  // exceed it — better to follow than to silently truncate.
  while (pageData.nextLink) {
    const nextResp = await guardedFetch(
      pageData.nextLink,
      { headers: { Authorization: `Bearer ${token}` } },
      { subscriptionId: "_arm-tenant", family: "arm" },
    );
    if (!nextResp.ok) {
      throw await _toArmErrorMsal(nextResp, "Failed to list tenants");
    }
    pageData = (await nextResp.json()) as Page;
    for (const t of pageData.value ?? []) out.push(mapTenant(t));
  }
  return out;
}

/**
 * List all Azure subscriptions using the ARM token (primary account).
 *
 * Includes `state` so callers can filter to "Enabled" — Azure accounts
 * routinely have AzureEA / ExpiredEA / Disabled / Warned / PastDue
 * subscriptions alongside active ones, and the rest of the app must
 * skip them silently rather than treat them as a load failure.
 */
export async function listSubscriptions(): Promise<
  Array<{
    subscriptionId: string;
    displayName: string;
    tenantId?: string;
    state?: string;
  }>
> {
  const token = await getArmToken();
  const url =
    `https://management.azure.com/subscriptions?api-version=${ARM_SUBSCRIPTIONS_API_VERSION}`;
  // Same governance routing as listSubscriptionsForAccount above.
  const response = await guardedFetch(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    { subscriptionId: "_arm-subscriptions", family: "arm" },
  );
  if (!response.ok) {
    throw await _toArmErrorMsal(response, "Failed to list subscriptions");
  }
  // Auto-follow nextLink — same pagination bug as listSubscriptionsForAccount.
  type Page = {
    value?: Array<Record<string, unknown>>;
    nextLink?: string;
  };
  const out: Array<{
    subscriptionId: string;
    displayName: string;
    tenantId?: string;
    state?: string;
  }> = [];
  const mapSub = (s: Record<string, unknown>) => ({
    subscriptionId: s.subscriptionId as string,
    displayName: s.displayName as string,
    tenantId: s.tenantId as string,
    state: s.state as string | undefined,
  });
  let pageData = (await response.json()) as Page;
  for (const s of pageData.value ?? []) out.push(mapSub(s));
  while (pageData.nextLink) {
    const nextResp = await guardedFetch(
      pageData.nextLink,
      { headers: { Authorization: `Bearer ${token}` } },
      { subscriptionId: "_arm-subscriptions", family: "arm" },
    );
    if (!nextResp.ok) {
      throw await _toArmErrorMsal(nextResp, "Failed to list subscriptions");
    }
    pageData = (await nextResp.json()) as Page;
    for (const s of pageData.value ?? []) out.push(mapSub(s));
  }
  return out;
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

// ---------------------------------------------------------------------------
// Dev-server hook for the Playwright auto-sign-in flow.
//
// The dev-server's /api/portal/auto-login launches a persistent Chromium,
// navigates it to this WebUI, and then needs MSAL itself to initiate the
// loginPopup so the resulting account ends up in MSAL's cache (and thus on
// the Azure Accounts page). The dev-server can't open a popup on MSAL's
// behalf — only MSAL has the PKCE verifier — so it calls this global hook
// via page.evaluate(). The hook returns a Promise that the dev-server
// awaits while it auto-fills the popup that MSAL just opened.
//
// Lives on window.__azbm so it's discoverable from Playwright but
// namespaced enough that it won't collide with anything else.
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __azbm?: {
      autoSignIn: (
        upn: string,
        tenantId?: string,
      ) => Promise<{ ok: boolean; username?: string; error?: string }>;
    };
  }
}

// ---------------------------------------------------------------------------
// Postmessage → iframe re-broadcast bridge.
//
// MSAL's loginPopup waits for a BroadcastChannel(<correlationId>) message
// posted by the popup's broadcastResponseToMainFrame(). In some browser
// configs (privacy extensions, restricted contexts, BroadcastChannel
// disabled) that delivery silently fails. As a fallback the popup ALSO
// postMessages the URL payload to window.opener — we catch it here and
// re-broadcast via a transient iframe. An iframe is a separate browsing
// context, so its BroadcastChannel post DOES get delivered to the parent
// frame's listener (BroadcastChannel never delivers to the posting tab).
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  // Hot-module-reload / repeated-import guard. Without this, every
  // webpack HMR cycle (and every test that re-`require()`s this
  // module) would attach an additional `message` listener — by the
  // 4th-5th HMR the same popup-response payload would be processed
  // N times, each time appending a transient iframe to document.body.
  //
  // Symbol-keyed sentinel on `window` is HMR-safe AND survives the
  // module-cache reset that `jest.resetModules()` triggers in tests.
  const INSTALLED_KEY = Symbol.for("azbm.popupListenerInstalled");
  type WindowWithSentinel = Window &
    Partial<Record<typeof INSTALLED_KEY, boolean>>;
  const w = window as WindowWithSentinel;
  if (!w[INSTALLED_KEY]) {
    w[INSTALLED_KEY] = true;
    _installPopupBridgeListener();
  }

  /**
   * Install the postmessage → BroadcastChannel re-broadcast listener
   * exactly once per browsing context. Extracted so the install path
   * is guarded by the symbol sentinel above; the body is unchanged.
   */
  function _installPopupBridgeListener(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event?.data;
    if (
      !data ||
      typeof data !== "object" ||
      data.type !== "azbm-popup-response" ||
      typeof data.payload !== "string"
    ) {
      return;
    }
    try {
      const params = new URLSearchParams(data.payload);
      const stateParam = params.get("state");
      if (!stateParam) return;
      const [encoded] = stateParam.split("|");
      const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
      const json = atob(
        (encoded + padding).replace(/-/g, "+").replace(/_/g, "/"),
      );
      const libraryState = JSON.parse(json);
      const id = libraryState?.id;
      if (typeof id !== "string" || !id) return;
      console.log(
        "[MSAL bridge] postMessage fallback received; re-broadcasting on channel",
        id,
      );
      // Build a self-contained iframe that creates a BroadcastChannel
      // with the captured id and posts the payload, then removes itself.
      // The iframe document is same-origin (about:srcdoc) so its
      // BroadcastChannel sends are received by this tab's listener.
      const iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.display = "none";
      const idJson = JSON.stringify(id);
      const payloadJson = JSON.stringify(data.payload);
      iframe.srcdoc = `<!DOCTYPE html><html><body><script>
        try {
          const ch = new BroadcastChannel(${idJson});
          ch.postMessage({ v: 1, payload: ${payloadJson} });
          ch.close();
        } catch (e) { /* swallow */ }
      </script></body></html>`;
      document.body.appendChild(iframe);
      // Remove the iframe after a moment — the message has already been
      // dispatched synchronously from inside its onload.
      setTimeout(() => {
        try {
          iframe.parentNode?.removeChild(iframe);
        } catch {
          /* */
        }
      }, 1500);
    } catch (err) {
      console.warn("[MSAL bridge] postMessage fallback decode failed:", err);
    }
  });
  }

  window.__azbm = window.__azbm || {
    autoSignIn: async (upn, tenantId) => {
      try {
        const account = await loginAccount({
          tenantId,
          loginHint: upn,
          prompt: "login",
        });
        if (!account) return { ok: false, error: "popup cancelled" };
        // MSAL has cached the new account in sessionStorage and added it to
        // our internal _accounts Map. But the Azure Accounts page only
        // calls loadAllAccounts() once on mount — if the operator was
        // already viewing it, the React store still holds the pre-login
        // list. Schedule a route+reload AFTER returning the result so the
        // dev-server's page.evaluate sees the resolved value first; the
        // reload then re-mounts the page and loadAllAccounts picks up the
        // freshly-cached account from sessionStorage.
        setTimeout(() => {
          try {
            window.location.hash = "#/azure-accounts";
            window.location.reload();
          } catch {
            /* navigation is best-effort */
          }
        }, 150);
        return { ok: true, username: account.username };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
