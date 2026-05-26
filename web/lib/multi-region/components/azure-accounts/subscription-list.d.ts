/**
 * Subscription list — displays an account's subscriptions inside the
 * Azure Accounts drawer's "Subscriptions" tab.
 *
 * Extracted from `azure-accounts-page.tsx` (which was ~3,150 lines and
 * had several disjoint sub-features mixed together) to keep the parent
 * file focused on accounts-level orchestration. Behavior is
 * byte-identical to the in-file version it replaced — only the import
 * site changed.
 */
import * as React from "react";
import type { AzureLoginAccount } from "../../store/store-types";
export interface SubscriptionListProps {
    account: AzureLoginAccount;
}
export declare const SubscriptionList: React.FC<SubscriptionListProps>;
//# sourceMappingURL=subscription-list.d.ts.map