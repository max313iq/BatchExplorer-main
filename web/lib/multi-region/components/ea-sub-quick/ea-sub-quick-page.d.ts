/**
 * EA Sub Quick Creator — minimal one-shot mirror of the PowerShell
 * snippet at
 *   https://learn.microsoft.com/azure/cost-management-billing/manage/
 *     programmatically-create-subscription-enterprise-agreement
 *
 * Steps (all via the existing arm-service helpers):
 *   1. Pick source account.
 *   2. List billing accounts            (GET /billingAccounts).
 *   3. List enrollment accounts under   (GET /billingAccounts/{ba}/enrollmentAccounts).
 *   4. Build billingScope =
 *        /providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea}
 *   5. PUT /providers/Microsoft.Subscription/aliases/{aliasName}
 *      with { displayName, billingScope, workload } + optional
 *      cross-tenant owner / tags.
 *   6. Poll the alias URL until provisioningState reaches a terminal
 *      state (Succeeded / Failed) and surface the resulting
 *      subscriptionId.
 *
 * Different from the existing EA Subscription page: NO multi-recipient
 * batching, NO complex recipient picker, NO MCA path — just one
 * subscription, the modern alias API, and the polling loop. Matches the
 * PowerShell script you pasted line-for-line.
 */
import * as React from "react";
export interface EaSubQuickPageProps {
    /**
     * Cross-page navigation. Wired by the page-router so the
     * passthrough-token Alert can pivot to Azure Accounts / Token
     * Importer without the page needing to know the routing layer.
     * Optional so the page still renders if mounted in a sandbox /
     * Storybook / preview without a router.
     */
    onNavigate?: (k: string) => void;
}
export declare const EaSubQuickPage: React.FC<EaSubQuickPageProps>;
//# sourceMappingURL=ea-sub-quick-page.d.ts.map