/**
 * Pre-login tenant selector — input field + sign-in button used in
 * both the page header (compact) and the empty-state card (stacked).
 *
 * Extracted from `azure-accounts-page.tsx` to keep the parent file
 * focused on accounts orchestration. Behavior is byte-identical to the
 * in-file version it replaced.
 */
import * as React from "react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "../shared/info-tooltip";
export const PreLoginTenantSelector = ({ tenantInput, onTenantInputChange, onSignIn, signingIn, layout, signInLabel, }) => {
    const inputId = React.useId();
    return (React.createElement("div", { className: cn("flex flex-col gap-2", layout === "compact" && "min-w-[260px]") },
        React.createElement("div", { className: "flex flex-col gap-1.5" },
            React.createElement("div", { className: "flex items-center gap-1.5" },
                React.createElement(Label, { htmlFor: inputId, className: "text-2xs uppercase tracking-wider" }, "Tenant ID or domain (optional)"),
                React.createElement(InfoTooltip, { content: "Set this to sign in directly against a specific tenant. Leave blank to sign into your home tenant and discover others later via the per-account tenant switcher.", ariaLabel: "Tenant input help", size: 12 })),
            React.createElement("div", { className: cn("flex gap-2", layout === "stacked" ? "flex-col sm:flex-row" : "flex-row") },
                React.createElement(Input, { id: inputId, type: "text", placeholder: "contoso.onmicrosoft.com or GUID", value: tenantInput, onChange: (e) => onTenantInputChange(e.target.value), onKeyDown: (e) => {
                        if (e.key === "Enter" && !signingIn) {
                            e.preventDefault();
                            onSignIn();
                        }
                    }, disabled: signingIn, "aria-label": "Tenant ID or domain", className: "h-8 text-xs transition-colors duration-150", autoComplete: "off", spellCheck: false }),
                signingIn ? (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", null,
                            React.createElement(Button, { variant: "default", onClick: onSignIn, loading: signingIn, "aria-label": signInLabel !== null && signInLabel !== void 0 ? signInLabel : "Sign in with Azure" }, signInLabel !== null && signInLabel !== void 0 ? signInLabel : "Sign in with Azure"))),
                    React.createElement(TooltipContent, { side: "top" }, "Sign-in already in progress."))) : (React.createElement(Button, { variant: "default", onClick: onSignIn, loading: signingIn, "aria-label": signInLabel !== null && signInLabel !== void 0 ? signInLabel : "Sign in with Azure" },
                    React.createElement(LogIn, { className: "h-3.5 w-3.5" }), signInLabel !== null && signInLabel !== void 0 ? signInLabel : "Sign in with Azure")))),
        React.createElement("p", { className: "flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground" },
            React.createElement("span", null, "Leave empty to use your home tenant."),
            React.createElement("span", { className: "text-muted-foreground/70" },
                "Press ",
                React.createElement(Kbd, null, "Enter"),
                " in the field to sign in."))));
};
//# sourceMappingURL=pre-login-tenant-selector.js.map