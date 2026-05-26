/**
 * Standardised "you're not signed in yet" empty state for any page
 * that requires an Azure account but has none.
 *
 * Before: every page rendered its own ad-hoc variant ("Sign in to
 * continue", "No accounts signed in", "Add an Azure account first")
 * with subtly different copy and inconsistent CTAs. Operators saw
 * the same situation render four different ways.
 *
 * Now: every gated page renders `<SignInRequired ... />` and gets a
 * single uniform card with:
 *   - Page-specific title ("Create a user" / "Browse EA accounts")
 *   - One-line explanation of what the page needs
 *   - Single primary CTA → Azure Accounts page
 *   - Secondary CTA (Token Importer) when the page can accept a
 *     pasted bearer token as an alternative to MSAL sign-in
 */
import * as React from "react";
import { KeyRound, LogIn, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
export const SignInRequired = ({ whatYouCantDo, why = "an Azure account with the right roles", allowTokenImport = true, onNavigate, }) => {
    return (React.createElement(Card, { className: "mx-auto max-w-2xl border-dashed" },
        React.createElement(CardHeader, { className: "text-center" },
            React.createElement("div", { className: "mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted" },
                React.createElement(User, { className: "h-6 w-6 text-muted-foreground", "aria-hidden": true })),
            React.createElement(CardTitle, { className: "text-base" },
                "Sign in to ",
                whatYouCantDo.toLowerCase()),
            React.createElement(CardDescription, null,
                "This page needs ",
                why,
                ". Add one on Azure Accounts, then come back here.")),
        React.createElement(CardContent, { className: "flex flex-wrap justify-center gap-2 pt-0" },
            React.createElement(Button, { type: "button", variant: "default", onClick: () => onNavigate === null || onNavigate === void 0 ? void 0 : onNavigate("azure-accounts"), disabled: !onNavigate, "aria-label": "Open Azure Accounts to sign in" },
                React.createElement(LogIn, { className: "h-3.5 w-3.5" }),
                "Sign in on Azure Accounts"),
            allowTokenImport && (React.createElement(Button, { type: "button", variant: "outline", onClick: () => onNavigate === null || onNavigate === void 0 ? void 0 : onNavigate("token-importer"), disabled: !onNavigate, "aria-label": "Open Token Importer to paste a bearer token" },
                React.createElement(KeyRound, { className: "h-3.5 w-3.5" }),
                "Paste a token instead")))));
};
//# sourceMappingURL=sign-in-required.js.map