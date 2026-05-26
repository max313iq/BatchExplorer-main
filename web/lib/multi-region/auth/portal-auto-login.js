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
import { __awaiter } from "tslib";
import { loginAccount } from "./msal-auth";
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
export function launchPortalAutoLogin(args) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        // Determines whether the caller asked the dev-server to do a
        // rotation in the first place. If it didn't, no transport failure
        // can produce a stale-vault scenario — `passwordRotationStatus`
        // safely stays "none".
        const rotationAttempted = !!(args.mustChangePassword && args.newPassword);
        try {
            const response = yield fetch("/api/portal/auto-login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign(Object.assign(Object.assign({ upn: args.upn, password: args.password, tenantId: args.tenantId, mustChangePassword: args.mustChangePassword }, (args.newPassword ? { newPassword: args.newPassword } : {})), (args.target ? { target: args.target } : {})), (args.webuiUrl ? { webuiUrl: args.webuiUrl } : {}))),
            });
            // Both success and partial responses include passwordRotated; parse
            // the body even on !response.ok so we don't lose that signal.
            let body = {};
            try {
                body = yield response.clone().json();
            }
            catch (_b) {
                /* fallback to text below */
            }
            const rotated = !!(body === null || body === void 0 ? void 0 : body.passwordRotated);
            const rotationStatus = !rotationAttempted ? "none" : rotated ? "confirmed" : "none";
            if (!response.ok) {
                const text = (_a = body === null || body === void 0 ? void 0 : body.message) !== null && _a !== void 0 ? _a : (yield response.text().catch(() => ""));
                return {
                    ok: false,
                    status: response.status,
                    error: text || `HTTP ${response.status}`,
                    passwordRotated: rotated,
                    passwordRotationStatus: rotationStatus,
                };
            }
            return {
                ok: true,
                status: response.status,
                passwordRotated: rotated,
                passwordRotationStatus: rotationStatus,
            };
        }
        catch (err) {
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
    });
}
export function attemptInteractiveLogin(args) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const account = yield loginAccount({
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
        }
        catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    });
}
//# sourceMappingURL=portal-auto-login.js.map