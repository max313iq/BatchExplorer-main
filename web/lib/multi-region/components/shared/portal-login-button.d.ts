/**
 * "Copy email" — after a user-create / password-reset, the post-action
 * button just copies the new account's email (UPN) to the clipboard.
 * No MSAL popup, no password copy, nothing fancy. The user pastes the
 * email wherever they want to sign in (Azure portal in a private window,
 * the Web UI's normal Sign-in button, etc.) and types the password
 * themselves.
 *
 * Earlier versions of this component pre-filled the MSAL popup with
 * `loginHint: upn` and copied the password to the clipboard, which the
 * operator explicitly did not want — the only thing that should leave
 * this app is the email string.
 */
import * as React from "react";
export interface PortalLoginButtonProps {
    upn: string;
    /** Retained for backward-compat with existing call sites — ignored. */
    tenantId?: string;
    /** Retained for backward-compat with existing call sites — ignored. */
    homeAccountId?: string;
    /** Retained for backward-compat — never used or copied. */
    password?: string;
    /** Retained for backward-compat — purely informational, never acted upon. */
    mustChangePassword?: boolean;
    size?: "xs" | "sm" | "default";
    variant?: "default" | "outline" | "ghost";
    label?: string;
    className?: string;
}
export declare const PortalLoginButton: React.FC<PortalLoginButtonProps>;
//# sourceMappingURL=portal-login-button.d.ts.map