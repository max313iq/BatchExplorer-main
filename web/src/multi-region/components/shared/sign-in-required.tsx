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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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

export const SignInRequired: React.FC<SignInRequiredProps> = ({
  whatYouCantDo,
  why = "an Azure account with the right roles",
  allowTokenImport = true,
  onNavigate,
}) => {
  return (
    <Card className="mx-auto max-w-2xl border-dashed">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <User className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <CardTitle className="text-base">
          Sign in to {whatYouCantDo.toLowerCase()}
        </CardTitle>
        <CardDescription>
          This page needs {why}. Add one on Azure Accounts, then come back
          here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap justify-center gap-2 pt-0">
        <Button
          type="button"
          variant="default"
          onClick={() => onNavigate?.("azure-accounts")}
          disabled={!onNavigate}
          aria-label="Open Azure Accounts to sign in"
        >
          <LogIn className="h-3.5 w-3.5" />
          Sign in on Azure Accounts
        </Button>
        {allowTokenImport && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onNavigate?.("token-importer")}
            disabled={!onNavigate}
            aria-label="Open Token Importer to paste a bearer token"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Paste a token instead
          </Button>
        )}
      </CardContent>
    </Card>
  );
};
