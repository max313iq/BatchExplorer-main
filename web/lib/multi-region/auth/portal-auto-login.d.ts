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
     * Set by the dev-server when AAD's change-password form was successfully
     * submitted, regardless of whether the rest of the flow (MSAL session
     * add, popup close, etc.) completed. Callers MUST update the credential
     * vault with `args.newPassword` when this is true and `args.newPassword`
     * was provided — even if `ok` is false. AAD-side rotation is irreversible
     * once submitted; if the vault still holds the old temp password, the
     * next sign-in for that account will fail with "wrong password".
     */
    passwordRotated?: boolean;
    /**
     * Three-state outcome describing what we know about AAD-side password
     * rotation:
     *   - "confirmed" — dev-server replied with `passwordRotated: true`
     *     and the response itself reached us cleanly. Caller MUST update
     *     its vault with `args.newPassword`.
     *   - "unknown"   — the fetch failed mid-flight (network drop,
     *     dev-server crash) AFTER the dev-server may have already
     *     submitted the change-password form. The vault could be stale
     *     OR up-to-date — we cannot tell. Caller MUST prompt the
     *     operator to verify (e.g. attempt a sign-in with the new
     *     password and a "use old password instead" escape hatch).
     *   - "none"      — the flow did NOT include a password rotation
     *     (either `mustChangePassword: false` or no `newPassword`
     *     supplied), so there is nothing to verify.
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
 * `passwordRotationStatus: "none"`, regardless of HTTP outcome. When
 * a rotation COULD have happened, the status maps to the actual
 * `passwordRotated` body field on HTTP success, or to "unknown" on
 * mid-flight transport failure.
 */
export declare function launchPortalAutoLogin(args: PortalAutoLoginArgs): Promise<PortalAutoLoginResult>;
export interface InteractiveLoginArgs {
    upn: string;
    tenantId: string;
}
export interface InteractiveLoginResult {
    ok: boolean;
    account?: {
        username: string;
        tenantId: string;
        homeAccountId: string;
    };
    error?: string;
}
export declare function attemptInteractiveLogin(args: InteractiveLoginArgs): Promise<InteractiveLoginResult>;
//# sourceMappingURL=portal-auto-login.d.ts.map