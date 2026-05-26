/**
 * Pre-login tenant selector — input field + sign-in button used in
 * both the page header (compact) and the empty-state card (stacked).
 *
 * Extracted from `azure-accounts-page.tsx` to keep the parent file
 * focused on accounts orchestration. Behavior is byte-identical to the
 * in-file version it replaced.
 */
import * as React from "react";
export interface PreLoginTenantSelectorProps {
    tenantInput: string;
    onTenantInputChange: (value: string) => void;
    onSignIn: () => void;
    signingIn: boolean;
    layout: "compact" | "stacked";
    signInLabel?: string;
}
export declare const PreLoginTenantSelector: React.FC<PreLoginTenantSelectorProps>;
//# sourceMappingURL=pre-login-tenant-selector.d.ts.map