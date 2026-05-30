/**
 * Shared sign-in helpers for credentials minted by the WebUI itself
 * (User Creator and Tenant Users password reset).
 *
 * Two paths, both safe to call without try/catch — they swallow errors and
 * return `{ok: false, error}`:
 *
 *   1. launchPortalAutoLogin — POSTs to /api/portal/auto-login. The dev-server
 *      endpoint launches a real Chromium window (Playwright), fills the
 *      email + password, and detaches. The operator finishes the sign-in
 *      interactively in that window, including any MFA / first-run prompts.
 *
 *   2. attemptInteractiveLogin — opens an MSAL popup against the **target
 *      user's tenant authority** with `loginHint: upn` + `prompt: 'login'`.
 *      On success the new account is added to the multi-account map and set
 *      as the active MSAL account; the rest of the WebUI immediately runs
 *      as that user inside their tenant.
 *
 * Use both as a chain: try (1), fall through to (2) on failure. The encrypted
 * credential vault keeps the password durably so any subsequent failure can
 * be retried later from the "Created by me" recovery tab.
 */

import { loginAccount } from "./msal-auth";

export interface PortalAutoLoginArgs {
  upn: string;
  /** Current / initial password (the one currently set on the account). */
  password: string;
  tenantId: string;
  mustChangePassword: boolean;
  /**
   * When `mustChangePassword` is true: the password to set in the AAD
   * change-password form. Playwright fills OldPassword + NewPassword +
   * ConfirmNewPassword and submits. If omitted, Playwright stops at the
   * change-password form and leaves the browser open for the user to
   * type a fresh password manually.
   *
   * Caller is responsible for satisfying the tenant's password complexity
   * rules. The default is 8+ chars, 3 of 4 character classes — the
   * project's `generateRandomPassword()` (16 chars, all 4 classes)
   * satisfies it.
   */
  newPassword?: string;
  /**
   * Target session for the Playwright-driven sign-in:
   *   - "portal" (default) — lands the browser at portal.azure.com.
   *     Useful for sanity-checking the credential against the portal.
   *     Note: portal access is often blocked for guest users at the
   *     tenant level (AADSTS50011).
   *   - "webui" — uses Azure CLI's public client_id and the WebUI's
   *     redirect URI so the resulting browser session is signed into
   *     this app as the new user. This is the right choice for
   *     "sign in to WebUI as the new user".
   */
  target?: "portal" | "webui";
  /**
   * When `target === "webui"`, the WebUI's redirect URI. Defaults to
   * `http://localhost:9000/` (the dev-server). Production deployments
   * should pass `window.location.origin + "/"`.
   */
  webuiUrl?: string;
}

export interface PortalAutoLoginResult {
  ok: boolean;
  status?: number;
  error?: string;
  /**
   * The dev-server's raw `passwordRotated` boolean, surfaced verbatim for
   * diagnostics. It is `true` only when AAD's change-password form was found,
   * filled, and submitted server-side. This field does NOT account for
   * transport failures or non-2xx responses, so it must NEVER be used on its
   * own to gate a credential-vault write — use {@link passwordRotationStatus}
   * for every decision. May be omitted entirely on a mid-flight transport
   * failure, where the dev-server's answer never reached us.
   */
  passwordRotated?: boolean;
  /**
   * Precise three-state outcome and the ONLY field a caller may consult to
   * decide whether to persist a rotated credential. The mapping is
   * deliberately conservative: a credential is overwritten only on an
   * affirmative, transport-clean confirmation.
   *
   *   - "confirmed" — a rotation was requested (`mustChangePassword` AND
   *     `newPassword`), the dev-server answered with a clean HTTP-ok (2xx)
   *     response, AND the body reported `passwordRotated === true`. Caller
   *     MUST persist `args.newPassword` into the vault.
   *   - "none"      — no rotation took effect. Either no rotation was
   *     requested, OR a definitive HTTP response was received (including any
   *     non-2xx response) but it did not affirmatively confirm a rotation
   *     (`passwordRotated !== true`), so AAD still holds the ORIGINAL
   *     password. Caller MUST keep the ORIGINAL password in the vault and
   *     MUST NOT write `args.newPassword`.
   *   - "unknown"   — a rotation was requested but the fetch threw
   *     mid-flight (network drop, dev-server crash, CORS, abort) BEFORE any
   *     HTTP response was observed. The dev-server MAY have already submitted
   *     the change-password form, so the vault could be stale OR up-to-date —
   *     we cannot tell. Caller MUST NOT silently overwrite; it MUST prompt
   *     the operator to verify (e.g. attempt a sign-in with the new password
   *     and a "use old password instead" escape hatch).
   *
   * Always set on every code path so callers can match exhaustively.
   */
  passwordRotationStatus: "confirmed" | "unknown" | "none";
}

/**
 * Launch the dev-server's Playwright-driven Azure portal sign-in for
 * one credential. Returns a `PortalAutoLoginResult` describing the
 * outcome. NEVER throws — every failure (network, dev-server, HTTP
 * 5xx, JSON parse) is converted to `{ ok: false, error, … }`.
 *
 * Password-rotation contract — callers MUST read `passwordRotationStatus`
 * (NOT just `passwordRotated`) when `args.mustChangePassword && args.newPassword`:
 *   - "confirmed" → dev-server confirmed the AAD change-password form
 *     was submitted; persist `args.newPassword` into the vault.
 *   - "unknown"   → fetch failed AFTER the dev-server may have already
 *     rotated. Caller MUST prompt the operator to verify before
 *     overwriting / discarding the vault entry. This is the dangerous
 *     case — if the vault still holds the OLD password and AAD now
 *     accepts only the NEW, every silent re-sign-in for that account
 *     will fail with "wrong password" until the operator manually
 *     re-imports.
 *   - "none"      → no rotation was attempted on this call; nothing
 *     to verify.
 *
 * Implementation note: when the rotation could not have happened
 * (`mustChangePassword: false` or no `newPassword`), we always set
 * `passwordRotationStatus: "none"`, regardless of HTTP outcome. When a
 * rotation COULD have happened, the status is "confirmed" ONLY on a clean
 * HTTP-ok (2xx) response whose body reports `passwordRotated === true`; a
 * non-2xx response — even one carrying `passwordRotated: true` — collapses to
 * "none" (the vault keeps the ORIGINAL password); and a mid-flight transport
 * failure (the fetch throwing before any response) maps to "unknown".
 */
export async function launchPortalAutoLogin(
  args: PortalAutoLoginArgs,
): Promise<PortalAutoLoginResult> {
  // Determines whether the caller asked the dev-server to do a
  // rotation in the first place. If it didn't, no transport failure
  // can produce a stale-vault scenario — `passwordRotationStatus`
  // safely stays "none".
  const rotationAttempted = !!(args.mustChangePassword && args.newPassword);
  try {
    const response = await fetch("/api/portal/auto-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upn: args.upn,
        password: args.password,
        tenantId: args.tenantId,
        mustChangePassword: args.mustChangePassword,
        ...(args.newPassword ? { newPassword: args.newPassword } : {}),
        ...(args.target ? { target: args.target } : {}),
        ...(args.webuiUrl ? { webuiUrl: args.webuiUrl } : {}),
      }),
    });
    // Both success and partial responses include passwordRotated; parse
    // the body even on !response.ok so we don't lose that signal.
    let body: { passwordRotated?: boolean; message?: string } = {};
    try {
      body = await response.clone().json();
    } catch {
      /* fallback to text below */
    }
    const rotated = !!body?.passwordRotated;
    if (!response.ok) {
      // A definitive HTTP response was received (the request reached the
      // dev-server and came back), so the outcome is knowable — never
      // "unknown". The contract reserves "confirmed" strictly for a clean
      // HTTP-ok response, so a non-2xx can never be "confirmed": it always
      // collapses to "none" and consumers keep the ORIGINAL password. The
      // server's raw `passwordRotated` flag is still surfaced verbatim for
      // diagnostics.
      const text = body?.message ?? (await response.text().catch(() => ""));
      return {
        ok: false,
        status: response.status,
        error: text || `HTTP ${response.status}`,
        passwordRotated: rotated,
        passwordRotationStatus: "none",
      };
    }
    // "confirmed" requires ALL of: rotation was requested, the response was
    // HTTP-ok (guaranteed here), and the body affirmatively reported
    // `passwordRotated === true`. Any other combination — including a server
    // that returns `passwordRotated:true` without a rotation having been
    // requested — collapses to "none", so the vault keeps the ORIGINAL
    // password.
    const rotationStatus: PortalAutoLoginResult["passwordRotationStatus"] =
      rotationAttempted && rotated ? "confirmed" : "none";
    return {
      ok: true,
      status: response.status,
      passwordRotated: rotated,
      passwordRotationStatus: rotationStatus,
    };
  } catch (err) {
    // Transport-level failure — `fetch` threw or the connection was
    // dropped before the dev-server's response reached us. The
    // dev-server MAY have already submitted the change-password form
    // server-side; we have no way to tell from here. Surface as
    // "unknown" when a rotation was attempted so the caller prompts
    // the operator to verify rather than silently overwriting the
    // vault with potentially-stale state.
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      passwordRotationStatus: rotationAttempted ? "unknown" : "none",
    };
  }
}

export interface InteractiveLoginArgs {
  upn: string;
  tenantId: string;
}

export interface InteractiveLoginResult {
  ok: boolean;
  account?: { username: string; tenantId: string; homeAccountId: string };
  error?: string;
}

export async function attemptInteractiveLogin(
  args: InteractiveLoginArgs,
): Promise<InteractiveLoginResult> {
  try {
    const account = await loginAccount({
      tenantId: args.tenantId,
      loginHint: args.upn,
      prompt: "login",
    });
    if (!account) {
      return { ok: false, error: "Interactive sign-in cancelled." };
    }
    return {
      ok: true,
      account: {
        username: account.username,
        tenantId: account.tenantId,
        homeAccountId: account.homeAccountId,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
