/**
 * `<AccountSubPicker>` — shared "pick a signed-in Azure account and (optionally)
 * one of its subscriptions" widget.
 *
 * Before: every audit-style page (role-graph, security-audit, sub-mover,
 * sub-manager, partner-center, …) hand-rolled its own pair of `<Select>`s
 * with subtle inconsistencies (label copy, sub-list dedupe, empty-state,
 * which account is the default). 6–8 files × ~80 lines each = a lot of
 * surface area for visual drift.
 *
 * Now: import `<AccountSubPicker mode="account-sub" ... />` and you get:
 *   - A consistent two-column header layout (Account select + Sub select)
 *   - Owner-label suffix on subs that come from a non-default account so
 *     the operator can disambiguate when the same sub-id shows under two
 *     signed-in identities.
 *   - Disabled "Subscription" select with helpful copy when no account is
 *     picked, instead of an enabled-but-empty dropdown.
 *   - Empty state when there are zero signed-in accounts (links out to
 *     /azure-accounts via the optional `onSignIn` callback).
 *   - Uniform `aria-label`s on both selects.
 *
 * The widget intentionally does NOT own the data — pages pass in the list
 * of accounts (and, for `account-sub` mode, the list of subscriptions per
 * account). This keeps the widget testable and free of any store / hook
 * dependency.
 */
import * as React from "react";
/**
 * Caller-supplied account shape. Subset of `state.azureAccounts[]` so the
 * widget compiles without importing store types.
 */
export interface PickerAccount {
    homeAccountId: string;
    /** Display name or UPN/email of the signed-in identity. */
    label: string;
    /** Optional tenant id — used only for the `aria-label` suffix today. */
    tenantId?: string;
}
export interface PickerSubscription {
    subscriptionId: string;
    /** "Display Name (xxxx-yyyy)" — the widget shows it as-is. */
    label: string;
    /**
     * homeAccountId of the account this subscription was discovered under.
     * Used by the widget to filter the subscription list when an account is
     * selected (the sub set is per-account, not global).
     */
    ownerHomeAccountId: string;
}
export interface AccountSubPickerProps {
    /**
     * Layout:
     *   - "account"     — only the account select. Use for pages that act
     *                     against an account (no sub) e.g. Tricky Login.
     *   - "account-sub" — account + sub. Default for most audit pages.
     */
    mode?: "account" | "account-sub";
    /** Signed-in Azure accounts surfaced by the dashboard shell. */
    accounts: PickerAccount[];
    /**
     * All subscriptions visible across the signed-in accounts. The widget
     * filters to the selected account's subs. Pass an empty array for
     * `mode="account"`.
     */
    subscriptions?: PickerSubscription[];
    /** Currently selected account's homeAccountId, or null. */
    value: {
        homeAccountId: string | null;
        subscriptionId?: string | null;
    };
    /** Fired on either select change. */
    onChange: (next: {
        homeAccountId: string | null;
        subscriptionId: string | null;
    }) => void;
    /**
     * Optional callback fired by the empty-state CTA when there are no
     * signed-in accounts. Typically navigates to `/azure-accounts`.
     */
    onSignIn?: () => void;
    /**
     * Optional copy override for the account select label.
     * Default: "Source account".
     */
    accountLabel?: string;
    /**
     * Optional copy override for the subscription select label.
     * Default: "Subscription".
     */
    subscriptionLabel?: string;
    className?: string;
}
export declare const AccountSubPicker: React.FC<AccountSubPickerProps>;
//# sourceMappingURL=account-sub-picker.d.ts.map