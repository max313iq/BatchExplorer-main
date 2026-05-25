/**
 * Centralized ARM-token hook for any page that needs an Azure
 * Resource Manager bearer token for an account.
 *
 * Why this exists: pages used to call `getArmTokenForAccount(...)`
 * once on mount, stash the result in `useState`, and then NEVER
 * refresh. That caused three problems:
 *
 *   1. Tenant switch → stale token. The operator switches the
 *      account's active tenant on Azure Accounts, but the page they
 *      were on still uses the OLD-tenant token until they reload —
 *      causing the passthrough-401 we tail-chased for hours.
 *
 *   2. Expiry → mid-operation 401. Long-lived pages (Pool Info,
 *      Nodes auto-refresh, Pool Creation polling) hold a token for
 *      > 1 hour. ARM tokens expire in 60-75 min. Mid-operation
 *      requests return a generic 401 the page can't recover from.
 *
 *   3. Login-mode change → wrong client id. Switching login mode
 *      (CLI → Portal → PowerShell) invalidates MSAL's silent cache
 *      against a different client id but a page holding the old
 *      token doesn't know.
 *
 * `useArmToken(homeAccountId, tenantId)` returns a token that
 * follows the account's *currently active* tenant and auto-refreshes
 * before expiry. Pages get correct tokens for free.
 */
import * as React from "react";

import {
  decodeJwtClaimsUnsafe,
  getActiveTenant,
  getArmTokenForAccount,
  loginAccount,
} from "./msal-auth";
import { REAUTH_REQUIRED_PATTERN } from "./reauth-patterns";
import { useTenantChange } from "../hooks/use-tenant-change";

export interface ArmTokenState {
  /** The current valid ARM access token, or null while loading / on error. */
  token: string | null;
  /** True while a token acquire (initial or refresh) is in flight. */
  loading: boolean;
  /** Last acquire error message, or null. */
  error: string | null;
  /** Force a fresh acquire (bypasses MSAL silent cache). Returns the new token. */
  refresh: () => Promise<string | null>;
  /** UNIX seconds timestamp from the token's `exp` claim, or null. */
  expiresAt: number | null;
  /** Seconds until the current token expires (recomputed on every render via tick). */
  secondsUntilExpiry: number | null;
  /** True when expiry is < 10 min away (UI hint to show a warning badge). */
  expiringSoon: boolean;
  /** Tenant the current token was minted against (from `tid` claim). */
  tokenTenantId: string | null;
  /**
   * True when the last acquire failed with an error class that ONLY
   * an interactive popup can resolve (interaction_required,
   * invalid_grant, "Cached session is no longer valid", etc.).
   * Pages should surface a "Re-authenticate" CTA when this is true —
   * silent retries (refresh()) won't help.
   */
  needsReauth: boolean;
  /**
   * Interactive re-authenticate this account against the (optional)
   * target tenant. Pops the MSAL login dialog with `prompt: "login"`
   * which forces AAD to mint a fresh refresh token regardless of
   * cache state, then auto-retries the silent acquire. Returns the
   * new token (or null on failure / cancellation).
   *
   * Defaults: tenantId = the hook's current effective tenant;
   * loginHint = passed in by the caller, or omitted.
   */
  reauth: (opts?: {
    tenantId?: string;
    loginHint?: string;
  }) => Promise<string | null>;
}

/**
 * Acquire-and-track an ARM token for the given account. Handles:
 *   - Initial acquire on mount
 *   - Re-mint whenever the resolved tenant changes (TENANT_CHANGED_EVENT)
 *   - Background refresh 60 s before expiry
 *   - Per-second `secondsUntilExpiry` tick so badge UI stays current
 *   - Imported-token short-circuit via `getArmTokenForAccount` (unchanged)
 *
 * Pass `undefined`/`""` for the account when no account is selected;
 * the hook will return null token without erroring.
 */
export function useArmToken(
  homeAccountId: string | undefined,
  tenantId: string | undefined,
): ArmTokenState {
  const [token, setToken] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expiresAt, setExpiresAt] = React.useState<number | null>(null);
  const [tokenTenantId, setTokenTenantId] = React.useState<string | null>(null);
  // Per-second tick used to recompute `secondsUntilExpiry` for the
  // expiry-badge UI without re-rendering callers' state.
  const [nowTick, setNowTick] = React.useState<number>(() =>
    Math.floor(Date.now() / 1000),
  );

  /**
   * The CURRENT EFFECTIVE tenant. Drives `doAcquire` and the acquire
   * effect's deps so re-renders trigger re-mints automatically.
   *
   * Why this exists separately from the `tenantId` parameter:
   * almost every caller passes `account.tenantId` — which is the
   * account's HOME tenant, NOT the current active tenant. After the
   * operator switches the active tenant on Azure Accounts, the
   * account's home tenantId DOES NOT CHANGE — so the parameter value
   * passed by the caller stays the same, the effect deps don't
   * change, and the hook never re-mints. The `useTenantChange`
   * listener used to call `doAcquire(true)` directly, but that read
   * `tenantId` from doAcquire's closure (still the home tenant), so
   * the re-mint was for the wrong tenant.
   *
   * By tracking the effective tenant in state and updating it from
   * BOTH the prop AND the tenant-changed event, every consumer page
   * automatically follows the live active tenant — without any
   * caller-side changes. (Callers that genuinely want to lock to a
   * specific tenant — e.g. cross-tenant operations — can still pass
   * an explicit tenantId; that becomes the initial value and any
   * subsequent prop change overrides the event-driven value.)
   */
  const [effectiveTenantId, setEffectiveTenantId] = React.useState<
    string | undefined
  >(() =>
    tenantId ??
    (homeAccountId ? getActiveTenant(homeAccountId) ?? undefined : undefined),
  );

  // Resync the effective tenant from the prop whenever the account
  // changes OR the caller passes a new explicit tenantId. The event-
  // driven update path (further down) overrides this between these
  // resync points.
  React.useEffect(() => {
    setEffectiveTenantId(
      tenantId ??
        (homeAccountId ? getActiveTenant(homeAccountId) ?? undefined : undefined),
    );
  }, [homeAccountId, tenantId]);

  // Capture the latest acquire request so a slower stale acquire can't
  // overwrite a faster newer one (e.g. when the operator quickly
  // switches tenants mid-acquire).
  const seqRef = React.useRef(0);

  const doAcquire = React.useCallback(
    async (forceRefresh: boolean): Promise<string | null> => {
      if (!homeAccountId) return null;
      const effectiveTenant =
        effectiveTenantId ?? getActiveTenant(homeAccountId) ?? undefined;
      const mySeq = ++seqRef.current;
      setLoading(true);
      setError(null);
      try {
        const t = await getArmTokenForAccount(homeAccountId, effectiveTenant, {
          forceRefresh,
        });
        if (mySeq !== seqRef.current) return null; // newer acquire raced ahead
        const claims = decodeJwtClaimsUnsafe(t);
        const exp =
          typeof claims?.exp === "number" ? (claims.exp as number) : null;
        const tid =
          typeof claims?.tid === "string"
            ? (claims.tid as string)
            : null;
        setToken(t);
        setExpiresAt(exp);
        setTokenTenantId(tid);
        return t;
      } catch (err) {
        if (mySeq !== seqRef.current) return null;
        setError(err instanceof Error ? err.message : String(err));
        setToken(null);
        setExpiresAt(null);
        setTokenTenantId(null);
        return null;
      } finally {
        if (mySeq === seqRef.current) setLoading(false);
      }
    },
    [homeAccountId, effectiveTenantId],
  );

  // Initial acquire + re-acquire on account / effective-tenant change.
  React.useEffect(() => {
    if (!homeAccountId) {
      setToken(null);
      setExpiresAt(null);
      setTokenTenantId(null);
      setError(null);
      return;
    }
    void doAcquire(false);
  }, [homeAccountId, effectiveTenantId, doAcquire]);

  // Cross-page tenant-change signal: when the operator switches the
  // active tenant for THIS account on Azure Accounts, override the
  // tracked effective tenant with the NEW active tenant from the
  // event. The acquire effect above re-fires because
  // effectiveTenantId is in its deps. This eliminates the "stale
  // token from before the switch" passthrough-401 class of bugs.
  useTenantChange(homeAccountId, (detail) => {
    setEffectiveTenantId(detail.tenantId);
  });

  // Background refresh 60 s before expiry. Reschedules every time
  // `expiresAt` changes (so the next refresh is always relative to
  // the freshly-acquired token).
  React.useEffect(() => {
    if (!expiresAt) return;
    const now = Math.floor(Date.now() / 1000);
    const refreshAt = expiresAt - 60;
    const delaySec = refreshAt - now;
    if (delaySec <= 0) {
      void doAcquire(true);
      return;
    }
    const id = window.setTimeout(() => {
      void doAcquire(true);
    }, delaySec * 1000);
    return () => window.clearTimeout(id);
  }, [expiresAt, doAcquire]);

  // 1 Hz tick to recompute secondsUntilExpiry. Cheap — just bumps a
  // number. Stops when no token exists (no badge to render anyway).
  React.useEffect(() => {
    if (!token || !expiresAt) return;
    const id = window.setInterval(() => {
      setNowTick(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [token, expiresAt]);

  const secondsUntilExpiry = React.useMemo(
    () => (expiresAt ? Math.max(0, expiresAt - nowTick) : null),
    [expiresAt, nowTick],
  );
  const expiringSoon =
    secondsUntilExpiry !== null && secondsUntilExpiry < 10 * 60;

  // Detect MSAL session-death errors that ONLY an interactive popup
  // can recover from. When this fires, the page's TokenExpiryBadge
  // (or any other UI bound to ArmTokenState) should swap its expiry
  // display for a "Re-authenticate" button. Pure derivation off
  // `error` — no extra state.
  const needsReauth = React.useMemo(
    () => !!error && REAUTH_REQUIRED_PATTERN.test(error),
    [error],
  );

  // Interactive re-auth helper. Calls MSAL's popup-based loginAccount
  // with `prompt: "login"` (forces AAD to re-issue an RT regardless
  // of cache state) then immediately retries the silent acquire so
  // the hook's `token` field populates without the caller needing a
  // second await. Errors propagate so the caller can surface them in
  // a toast.
  const reauth = React.useCallback(
    async (opts?: {
      tenantId?: string;
      loginHint?: string;
    }): Promise<string | null> => {
      if (!homeAccountId) return null;
      const targetTenantId =
        opts?.tenantId ??
        effectiveTenantId ??
        getActiveTenant(homeAccountId) ??
        undefined;
      try {
        await loginAccount({
          tenantId: targetTenantId,
          loginHint: opts?.loginHint,
          prompt: "login",
        });
        // Clear the error state immediately so needsReauth flips off
        // even if the silent retry that follows is slow.
        setError(null);
        return await doAcquire(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return null;
      }
    },
    [homeAccountId, effectiveTenantId, doAcquire],
  );

  return {
    token,
    loading,
    error,
    refresh: () => doAcquire(true),
    expiresAt,
    secondsUntilExpiry,
    expiringSoon,
    tokenTenantId,
    needsReauth,
    reauth,
  };
}
