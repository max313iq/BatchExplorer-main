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
import { type PageKey } from "./sidebar-nav";
export interface SignInRequiredProps {
    /** Page-specific verb. Example: "Create a user" / "Manage EA billing". */
    whatYouCantDo: string;
    /**
     * Page-specific reason — what *kind* of account the page expects.
     * Defaults to "an Azure account with the right roles".
     */
    why?: string;
    /**
     * If true (default), show the secondary "Paste a token" CTA. Pages
     * where pasted tokens are not useful (e.g. user-facing flows that
     * call Graph and would need Graph consent) can set this to false.
     */
    allowTokenImport?: boolean;
    /**
     * Navigation callback — wired by the page-router so the buttons
     * route via React Router rather than hard `window.location.hash`.
     */
    onNavigate?: (k: PageKey) => void;
}
export declare const SignInRequired: React.FC<SignInRequiredProps>;
//# sourceMappingURL=sign-in-required.d.ts.map