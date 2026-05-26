/**
 * Top-of-shell auth/health banner: surfaces health-check progress, login
 * prompts on failure, and the signed-in MSAL user identity with sign-out.
 */
import * as React from "react";
import { CloudCog } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
export const AuthBanner = ({ healthCheck, onRetry, onLogin, onLogout, authMode, userName, }) => {
    if (healthCheck === null) {
        return (React.createElement(Alert, { variant: "info", className: "rounded-none border-x-0", "aria-live": "polite" },
            React.createElement(AlertDescription, null, "Running health check...")));
    }
    if (!healthCheck.healthy) {
        return (React.createElement(Alert, { variant: "warning", className: "rounded-none border-x-0", "aria-live": "polite" },
            React.createElement(AlertDescription, { className: "flex flex-wrap items-center gap-3" },
                React.createElement("span", { className: "min-w-0 flex-1" },
                    React.createElement("b", null, "Health check failed."),
                    " ",
                    healthCheck.error),
                React.createElement("span", { className: "flex shrink-0 items-center gap-2" },
                    onLogin && (React.createElement(Button, { size: "sm", onClick: onLogin, className: "gap-1.5", "aria-label": "Sign in with Azure" },
                        React.createElement(CloudCog, { "aria-hidden": "true" }),
                        "Sign in with Azure")),
                    React.createElement(Button, { size: "sm", variant: "outline", onClick: onRetry, "aria-label": "Retry health check" }, "Retry")))));
    }
    if (authMode === "msal" && userName) {
        return (React.createElement(Alert, { variant: "success", className: "rounded-none border-x-0", "aria-live": "polite" },
            React.createElement(AlertDescription, { className: "flex flex-wrap items-center gap-3" },
                React.createElement("span", { className: "min-w-0 flex-1" },
                    "Signed in as ",
                    React.createElement("b", null, userName),
                    " via Entra ID"),
                onLogout && (React.createElement(Button, { size: "xs", variant: "outline", onClick: onLogout, className: "shrink-0", "aria-label": "Sign out" }, "Sign out")))));
    }
    return null;
};
//# sourceMappingURL=auth-banner.js.map