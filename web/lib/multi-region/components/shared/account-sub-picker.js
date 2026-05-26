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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";
import { Users } from "lucide-react";
export const AccountSubPicker = ({ mode = "account-sub", accounts, subscriptions = [], value, onChange, onSignIn, accountLabel = "Source account", subscriptionLabel = "Subscription", className, }) => {
    var _a, _b;
    // No signed-in accounts → empty-state with optional sign-in CTA.
    if (accounts.length === 0) {
        return (React.createElement(EmptyState, { icon: Users, title: "No Azure accounts signed in", description: "Add an Azure account first, then come back to pick which one to act on.", action: onSignIn
                ? { label: "Go to Azure Accounts", onClick: onSignIn }
                : undefined }));
    }
    const subsForAccount = React.useMemo(() => value.homeAccountId
        ? subscriptions.filter((s) => s.ownerHomeAccountId === value.homeAccountId)
        : [], [subscriptions, value.homeAccountId]);
    return (React.createElement("div", { className: cn("grid gap-3", mode === "account-sub" ? "sm:grid-cols-2" : "sm:grid-cols-1", className) },
        React.createElement("div", { className: "flex flex-col gap-1.5" },
            React.createElement(Label, { htmlFor: "account-sub-picker-account", className: "text-xs" }, accountLabel),
            React.createElement(Select, { value: (_a = value.homeAccountId) !== null && _a !== void 0 ? _a : undefined, onValueChange: (next) => onChange({ homeAccountId: next, subscriptionId: null }) },
                React.createElement(SelectTrigger, { id: "account-sub-picker-account", "aria-label": accountLabel },
                    React.createElement(SelectValue, { placeholder: "Pick an Azure account" })),
                React.createElement(SelectContent, null, accounts.map((a) => (React.createElement(SelectItem, { key: a.homeAccountId, value: a.homeAccountId }, a.label)))))),
        mode === "account-sub" && (React.createElement("div", { className: "flex flex-col gap-1.5" },
            React.createElement(Label, { htmlFor: "account-sub-picker-sub", className: "text-xs" }, subscriptionLabel),
            React.createElement(Select, { value: (_b = value.subscriptionId) !== null && _b !== void 0 ? _b : undefined, onValueChange: (next) => onChange({
                    homeAccountId: value.homeAccountId,
                    subscriptionId: next,
                }), disabled: !value.homeAccountId || subsForAccount.length === 0 },
                React.createElement(SelectTrigger, { id: "account-sub-picker-sub", "aria-label": subscriptionLabel },
                    React.createElement(SelectValue, { placeholder: value.homeAccountId
                            ? subsForAccount.length === 0
                                ? "No subscriptions on this account"
                                : "Pick a subscription"
                            : "Pick an account first" })),
                React.createElement(SelectContent, null, subsForAccount.map((s) => (React.createElement(SelectItem, { key: s.subscriptionId, value: s.subscriptionId }, s.label)))))))));
};
//# sourceMappingURL=account-sub-picker.js.map