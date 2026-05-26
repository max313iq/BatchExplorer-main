/**
 * Compact summary bar shown above the Account Info table — surfaces total
 * accounts, quota, LP usage, pools, and average utilization at a glance.
 * Does NOT compute the summary; consumes the pre-aggregated `AccountInfoSummary`.
 */
import * as React from "react";
import { AccountInfoSummary } from "./account-info-helpers";
interface AccountInfoSummaryBarProps {
    summary: AccountInfoSummary;
}
export declare const AccountInfoSummaryBar: React.FC<AccountInfoSummaryBarProps>;
export {};
//# sourceMappingURL=account-info-summary.d.ts.map