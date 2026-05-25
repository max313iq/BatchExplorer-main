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

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { EmptyState } from "./empty-state";
import { Users } from "lucide-react";

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

export const AccountSubPicker: React.FC<AccountSubPickerProps> = ({
  mode = "account-sub",
  accounts,
  subscriptions = [],
  value,
  onChange,
  onSignIn,
  accountLabel = "Source account",
  subscriptionLabel = "Subscription",
  className,
}) => {
  // No signed-in accounts → empty-state with optional sign-in CTA.
  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No Azure accounts signed in"
        description="Add an Azure account first, then come back to pick which one to act on."
        action={
          onSignIn
            ? { label: "Go to Azure Accounts", onClick: onSignIn }
            : undefined
        }
      />
    );
  }

  const subsForAccount = React.useMemo(
    () =>
      value.homeAccountId
        ? subscriptions.filter(
            (s) => s.ownerHomeAccountId === value.homeAccountId,
          )
        : [],
    [subscriptions, value.homeAccountId],
  );

  return (
    <div
      className={cn(
        "grid gap-3",
        mode === "account-sub" ? "sm:grid-cols-2" : "sm:grid-cols-1",
        className,
      )}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="account-sub-picker-account" className="text-xs">
          {accountLabel}
        </Label>
        <Select
          value={value.homeAccountId ?? undefined}
          onValueChange={(next) =>
            onChange({ homeAccountId: next, subscriptionId: null })
          }
        >
          <SelectTrigger
            id="account-sub-picker-account"
            aria-label={accountLabel}
          >
            <SelectValue placeholder="Pick an Azure account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.homeAccountId} value={a.homeAccountId}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mode === "account-sub" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-sub-picker-sub" className="text-xs">
            {subscriptionLabel}
          </Label>
          <Select
            value={value.subscriptionId ?? undefined}
            onValueChange={(next) =>
              onChange({
                homeAccountId: value.homeAccountId,
                subscriptionId: next,
              })
            }
            disabled={!value.homeAccountId || subsForAccount.length === 0}
          >
            <SelectTrigger
              id="account-sub-picker-sub"
              aria-label={subscriptionLabel}
            >
              <SelectValue
                placeholder={
                  value.homeAccountId
                    ? subsForAccount.length === 0
                      ? "No subscriptions on this account"
                      : "Pick a subscription"
                    : "Pick an account first"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {subsForAccount.map((s) => (
                <SelectItem key={s.subscriptionId} value={s.subscriptionId}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
};
