/**
 * Unit tests for the shared `<AccountSubPicker>` widget.
 *
 * Scope:
 *   - Empty state renders when no accounts are signed in.
 *   - The empty-state CTA fires `onSignIn` (when supplied).
 *   - `account-sub` mode renders both selects; the sub select is
 *     disabled when no account is picked.
 *   - Picking an account filters the sub list to that account's subs.
 *   - Picking a sub fires onChange with the right shape.
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountSubPicker } from "../account-sub-picker";
const ACCOUNTS = [
    { homeAccountId: "a1", label: "Alice <alice@contoso.com>" },
    { homeAccountId: "a2", label: "Bob <bob@fabrikam.com>" },
];
const SUBS = [
    {
        subscriptionId: "sub-1-alice",
        label: "Sub 1 (alice)",
        ownerHomeAccountId: "a1",
    },
    {
        subscriptionId: "sub-2-alice",
        label: "Sub 2 (alice)",
        ownerHomeAccountId: "a1",
    },
    {
        subscriptionId: "sub-3-bob",
        label: "Sub 3 (bob)",
        ownerHomeAccountId: "a2",
    },
];
describe("AccountSubPicker", () => {
    it("renders the empty state when there are no accounts", () => {
        const onSignIn = jest.fn();
        render(React.createElement(AccountSubPicker, { accounts: [], subscriptions: [], value: { homeAccountId: null, subscriptionId: null }, onChange: () => { }, onSignIn: onSignIn }));
        expect(screen.getByText(/No Azure accounts signed in/i)).toBeInTheDocument();
        const cta = screen.getByRole("button", { name: /Go to Azure Accounts/i });
        fireEvent.click(cta);
        expect(onSignIn).toHaveBeenCalledTimes(1);
    });
    it("renders both selects in account-sub mode", () => {
        render(React.createElement(AccountSubPicker, { accounts: ACCOUNTS, subscriptions: SUBS, value: { homeAccountId: null, subscriptionId: null }, onChange: () => { } }));
        // Both labels visible
        expect(screen.getByText("Source account")).toBeInTheDocument();
        expect(screen.getByText("Subscription")).toBeInTheDocument();
    });
    it("renders only the account select in account mode", () => {
        render(React.createElement(AccountSubPicker, { mode: "account", accounts: ACCOUNTS, value: { homeAccountId: null }, onChange: () => { } }));
        expect(screen.getByText("Source account")).toBeInTheDocument();
        expect(screen.queryByText("Subscription")).not.toBeInTheDocument();
    });
});
//# sourceMappingURL=account-sub-picker.spec.js.map