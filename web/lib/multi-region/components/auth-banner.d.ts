/**
 * Top-of-shell auth/health banner: surfaces health-check progress, login
 * prompts on failure, and the signed-in MSAL user identity with sign-out.
 */
import * as React from "react";
export interface AuthBannerProps {
    healthCheck: {
        healthy: boolean;
        error: string | null;
    } | null;
    onRetry: () => void;
    onLogin?: () => void;
    onLogout?: () => void;
    authMode?: "msal" | "cli";
    userName?: string;
}
export declare const AuthBanner: React.FC<AuthBannerProps>;
//# sourceMappingURL=auth-banner.d.ts.map