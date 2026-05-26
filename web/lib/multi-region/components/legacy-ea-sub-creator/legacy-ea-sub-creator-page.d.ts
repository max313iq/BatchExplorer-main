/**
 * Legacy EA Sub Creator — uses the 2018-03-01-preview Subscription
 * creation API documented at
 *   https://learn.microsoft.com/azure/cost-management-billing/manage/
 *     programmatically-create-subscription
 *
 * Flow:
 *   1. List enrollment accounts the caller is an Owner on:
 *      GET /providers/Microsoft.Billing/enrollmentAccounts?api-version=2018-03-01-preview
 *   2. POST createSubscription with the enrollment-account object id +
 *      offerType (MS-AZR-0017P or MS-AZR-0148P) + optional owners.
 *   3. Poll the Location header until ARM returns the subscriptionLink.
 *
 * Different from the existing EA Subscription page (which uses the
 * modern Subscription Alias API): no alias name, no cross-tenant owner
 * required, fewer optional fields, but capped at 5000 subs per
 * enrollment account.
 *
 * IMPORTANT — this page wraps a **deprecated** API path. Newer EA
 * enrollments routinely return `Commerce Account Is Null` because the
 * legacy billing namespace was never populated for them. The UI keeps
 * this page available for the rare automation that specifically needs
 * the 2018-03-01-preview shape, but it shows persistent deprecation
 * banners and gates the submit behind an acknowledgement so nobody
 * accidentally builds a new workflow on top of the dying endpoint.
 */
import * as React from "react";
export declare const LegacyEaSubCreatorPage: React.FC;
//# sourceMappingURL=legacy-ea-sub-creator-page.d.ts.map