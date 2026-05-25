/**
 * Canonical tenant-switch flow, callable from any UI entry point
 * (Azure Accounts page, header tenant switcher, command palette).
 *
 * Why this exists: a tenant switch isn't just "write the tenantId to
 * sessionStorage". It needs to:
 *
 *   1. Update MSAL's per-account active tenant pointer so subsequent
 *      token acquires default to the new tenant.
 *   2. Update the store's `activeTenants` map + the account's
 *      `activeTenantId` field so re-rendering pages see the change.
 *   3. Pre-warm an ARM token for the new tenant (best-effort) so the
 *      next page's `useArmToken` finds it in the MSAL silent cache.
 *   4. Re-list the account's subscriptions because the visible set is
 *      tenant-scoped (cross-tenant subs disappear when you switch out
 *      of their owning tenant).
 *   5. Broadcast TENANT_CHANGED_EVENT so every page using
 *      `useTenantChange` / `useArmToken` re-mints + re-fetches.
 *   6. Add a notification toast + audit-log entry.
 *
 * The Azure Accounts page used to own this flow inline (and still has
 * its own copy for drawer/row paths). Extracting it here lets the
 * header switcher run the EXACT same flow without duplicating audit
 * shape, notification copy, or sub-refresh semantics — i.e. the
 * operator's experience is identical whether they switched from the
 * header pill, the row dropdown, or the drawer.
 */
import {
  getArmTokenForAccount,
  listSubscriptionsForAccount,
  loginAccount,
  setActiveTenant as msalSetActiveTenant,
} from "./msal-auth";
import { REAUTH_REQUIRED_PATTERN } from "./reauth-patterns";
import {
  TENANT_CHANGED_EVENT,
  type TenantChangedDetail,
} from "../hooks/tenant-changed-event";
import { auditLog } from "../services/audit-log";
import type { MultiRegionStore } from "../store/multi-region-store";
import type { AzureLoginAccount } from "../store/store-types";
import type { TenantInfo } from "../services/types";

export interface PerformTenantSwitchOptions {
  /**
   * Which UI entry point triggered the switch — written to the audit
   * log under `details.from`. Operators reading the log can correlate
   * a switch with the click that caused it.
   */
  source: "drawer" | "row" | "header-switcher" | "command-palette" | "external";
  /** Optional AbortSignal to cancel a slow `listSubscriptionsForAccount`. */
  signal?: AbortSignal;
  /**
   * Returns true when a newer concurrent switch has won and this one
   * should bail without writing to the store. Called after every
   * await point. Default: never stale.
   */
  isStale?: () => boolean;
  /** Optional callback when the switch succeeds. */
  onSuccess?: () => void;
}

export interface PerformTenantSwitchResult {
  /** True when a newer concurrent switch superseded this one. */
  stale: boolean;
  /** Subscriptions returned by the post-switch list (empty on failure). */
  subscriptionsLoaded: number;
}

/**
 * Resolve the active tenant id for an account across the three
 * sources of truth (override → msal-cached → home).
 */
export function resolveActiveTenantId(
  account: AzureLoginAccount,
): string | undefined {
  return account.activeTenantId ?? account.tenantId ?? undefined;
}

/**
 * Find a human label for a tenantId in the account's tenant list,
 * falling back to a string fallback.
 */
export function findTenantLabel(
  tenants: TenantInfo[] | undefined,
  tenantId: string | undefined,
  fallback: string,
): string {
  if (!tenantId) return fallback;
  const match = tenants?.find((t) => t.tenantId === tenantId);
  return match?.displayName ?? match?.defaultDomain ?? tenantId ?? fallback;
}

function emitTenantChanged(detail: TenantChangedDetail): void {
  try {
    window.dispatchEvent(
      new CustomEvent<TenantChangedDetail>(TENANT_CHANGED_EVENT, { detail }),
    );
  } catch {
    /* SSR / non-DOM env — ignore */
  }
}

/**
 * Single-retry on transient ARM failures (429 / 5xx / network).
 * Honors `Retry-After` if the error carries it; falls back to 1.5s.
 */
async function withTransientRetry<T>(
  fn: () => Promise<T>,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number } | null)?.status;
    const isTransient =
      status === 429 ||
      (typeof status === "number" && status >= 500 && status < 600) ||
      /\b(429|5\d\d)\b/.test(msg) ||
      /timeout|temporarily unavailable|service unavailable|network error/i.test(
        msg,
      );
    if (!isTransient) throw err;
    const retryAfter = (err as { retryAfterSeconds?: number } | null)
      ?.retryAfterSeconds;
    const delayMs = retryAfter ? Math.min(retryAfter, 10) * 1000 : 1500;
    // eslint-disable-next-line no-console
    console.warn(
      `[tenant-switch] transient failure on ${label}; retrying in ${delayMs}ms:`,
      msg,
    );
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delayMs);
      if (signal) {
        const onAbort = () => {
          clearTimeout(t);
          resolve();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    if (signal?.aborted) throw err;
    return fn();
  }
}

/**
 * Run a tenant switch end-to-end. See module docblock for the full
 * sequence. Returns `{ stale }` so the caller can decide whether to
 * clear its UI spinner — when `stale: true` a newer concurrent
 * switch has won and the caller should leave its busy state alone
 * (the newer call will clear it).
 */
export async function performTenantSwitch(
  account: AzureLoginAccount,
  tenantId: string,
  store: MultiRegionStore,
  options: PerformTenantSwitchOptions,
): Promise<PerformTenantSwitchResult> {
  const homeAccountId = account.homeAccountId;
  const isStale = options.isStale ?? (() => false);
  const tenants = account.tenants ?? [];
  const tenantLabel = findTenantLabel(tenants, tenantId, tenantId);
  const currentActive = resolveActiveTenantId(account);
  const fromLabel = findTenantLabel(
    tenants,
    currentActive,
    currentActive ?? "(unknown)",
  );

  // ROLLBACK SNAPSHOT — capture the subscription set BEFORE we make
  // any store mutations so a popup-cancel mid-switch can restore it.
  // Without this, the rollback path restored `status: "active"` but
  // left `subscriptions` in whatever state the (now-cancelled) switch
  // had pushed — the UI would render empty rows for the original
  // tenant until the next refresh. Deep clone via structuredClone
  // when available so a follow-on listSubscriptions mutating the
  // returned array can't poison the snapshot.
  const subscriptionsSnapshot = (() => {
    const subs = account.subscriptions ?? [];
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(subs);
      } catch {
        /* structuredClone can fail on functions / DOM nodes — fall back below */
      }
    }
    // JSON round-trip is fine here: subscription rows are plain data.
    try {
      return JSON.parse(JSON.stringify(subs));
    } catch {
      return subs.slice();
    }
  })();
  const subscriptionCountSnapshot = account.subscriptionCount;

  try {
    msalSetActiveTenant(homeAccountId, tenantId);
    store.setActiveTenant(homeAccountId, tenantId);
    store.updateAzureAccount(homeAccountId, { status: "loading" });

    // ATOMIC TOKEN ACQUISITION — the critical step.
    //
    // Why this is synchronous and not fire-and-forget anymore:
    // a tenant switch is only useful if the app can actually mint
    // tokens for the new tenant. MSAL refresh tokens are authority-
    // scoped — an RT obtained against T1's authority cannot silently
    // mint a T2 token (B2B-guest flow excepted, and that only works
    // when the account is provisioned as a guest in T2 and the token
    // endpoint accepts the cross-tenant exchange — often it doesn't).
    //
    // Old behavior: pre-warm was `void getArmTokenForAccount(...).catch(...)`
    // — fire-and-forget with the failure swallowed. Then we emitted
    // TENANT_CHANGED_EVENT and every page's `useArmToken` ran its own
    // silent acquire — and EACH page hit the same interaction_required
    // simultaneously, painting the "Cached session is no longer valid"
    // error across the whole app.
    //
    // New behavior: ONE pre-emptive silent acquire here. If it fails
    // with a re-auth-required pattern, pop the interactive popup
    // exactly ONCE — MSAL will SSO silently if the user has a browser
    // session for the new tenant, or show the login UI if not. Either
    // way, the popup mints a fresh authority-scoped RT for the new
    // tenant. After it returns, every subsequent silent acquire from
    // any page succeeds without prompting.
    //
    // If the user cancels the popup, we ROLL BACK the tenant switch
    // (otherwise the app is in a half-state: the picker shows T2 but
    // no T2 token exists, so every page would 401).
    try {
      await getArmTokenForAccount(homeAccountId, tenantId);
    } catch (acquireErr) {
      if (isStale() || options.signal?.aborted) {
        return { stale: true, subscriptionsLoaded: 0 };
      }
      const acquireMsg =
        acquireErr instanceof Error ? acquireErr.message : String(acquireErr);
      if (REAUTH_REQUIRED_PATTERN.test(acquireMsg)) {
        // Re-auth needed for the new tenant. Pop interactive login.
        // No `prompt: "login"` — let MSAL SSO if it can (browser
        // session for T2 already valid), or escalate to credentials
        // UI if not. The user sees AT MOST one popup; subsequent
        // silent acquires for T2 succeed.
        try {
          await loginAccount({
            tenantId,
            loginHint: account.username || undefined,
          });
        } catch (popupErr) {
          // User cancelled, popup blocked, or interactive failed.
          // Roll back so the app doesn't sit on a tenant it has no
          // token for. Restoring `currentActive` covers both the
          // "switched from T1" case (rolls back to T1) and the
          // "first switch from null" case (clears the active tenant).
          if (currentActive && currentActive !== tenantId) {
            msalSetActiveTenant(homeAccountId, currentActive);
            store.setActiveTenant(homeAccountId, currentActive);
          }
          // Restore the subscription snapshot taken at function entry
          // so the UI isn't left rendering the in-flight tenant's
          // (now-aborted) subscriptions for the rolled-back tenant.
          store.updateAzureAccount(homeAccountId, {
            status: "active",
            error: null,
            subscriptions: subscriptionsSnapshot,
            subscriptionCount: subscriptionCountSnapshot,
          });
          const popupMsg =
            popupErr instanceof Error ? popupErr.message : String(popupErr);
          store.addNotification({
            type: "error",
            message:
              `Tenant switch to ${tenantLabel} aborted — interactive ` +
              `re-authentication did not complete. ${popupMsg}`,
          });
          auditLog.record({
            actor: account.username || homeAccountId,
            action: "switch_active_tenant",
            target: tenantLabel,
            status: "failure",
            error: `Re-auth popup cancelled or failed: ${popupMsg}`,
            details: {
              homeAccountId,
              tenantId,
              fromTenantId: currentActive,
              from: options.source,
              reason: "interactive_reauth_cancelled",
            },
          });
          return { stale: false, subscriptionsLoaded: 0 };
        }
        // Verify silent acquire now works with the freshly-popped RT.
        // If this STILL fails, something is structurally broken
        // (account not in destination tenant at all, CA policy blocks,
        // etc.) — let the catch on the outer try handle it.
        await getArmTokenForAccount(homeAccountId, tenantId);
      } else {
        // Some other acquire failure (network, AAD outage). Let the
        // outer catch report it.
        throw acquireErr;
      }
    }

    // Token is valid for the new tenant. NOW emit the event so pages
    // re-fetch — every silent acquire they do will succeed immediately
    // because MSAL's cache has the fresh authority-scoped token.
    emitTenantChanged({
      homeAccountId,
      tenantId,
      fromTenantId: currentActive ?? null,
    });

    const subs = await withTransientRetry(
      () => listSubscriptionsForAccount(homeAccountId),
      "listSubscriptionsForAccount",
      options.signal,
    );

    if (isStale()) {
      return { stale: true, subscriptionsLoaded: subs.length };
    }

    const enabledCount = subs.filter(
      (s) => (s.state ?? "Enabled") === "Enabled",
    ).length;
    store.updateAzureAccount(homeAccountId, {
      subscriptions: subs,
      subscriptionCount: enabledCount,
      status: "active",
      error: null,
    });

    options.onSuccess?.();

    store.addNotification({
      type: "success",
      message: `Switched ${fromLabel} → ${tenantLabel} (${subs.length} sub${subs.length === 1 ? "" : "s"})`,
    });
    auditLog.record({
      actor: account.username || homeAccountId,
      action: "switch_active_tenant",
      target: tenantLabel,
      status: "success",
      details: {
        homeAccountId,
        tenantId,
        fromTenantId: currentActive,
        subscriptionsLoaded: subs.length,
        from: options.source,
      },
    });
    return { stale: false, subscriptionsLoaded: subs.length };
  } catch (e: unknown) {
    if (isStale() || options.signal?.aborted) {
      return { stale: true, subscriptionsLoaded: 0 };
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Outer catch — restore snapshot here too. The switch failed
    // (network, AAD outage, etc.) and the operator is going to see
    // an error toast; we shouldn't ALSO wipe their existing
    // subscription list in the process.
    store.updateAzureAccount(homeAccountId, {
      status: "error",
      error: msg,
      subscriptions: subscriptionsSnapshot,
      subscriptionCount: subscriptionCountSnapshot,
    });
    store.addNotification({
      type: "error",
      message: `Failed to switch to ${tenantLabel}: ${msg}`,
    });
    auditLog.record({
      actor: account.username || homeAccountId,
      action: "switch_active_tenant",
      target: tenantLabel,
      status: "failure",
      error: msg,
      details: {
        homeAccountId,
        tenantId,
        fromTenantId: currentActive,
        from: options.source,
      },
    });
    return { stale: false, subscriptionsLoaded: 0 };
  }
}
