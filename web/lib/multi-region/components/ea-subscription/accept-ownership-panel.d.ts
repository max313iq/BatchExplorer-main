/**
 * AcceptOwnershipPanel — destination-tenant companion to the cross-tenant
 * EA / MCA creation flow.
 *
 * Microsoft's documented contract: when an alias is created with
 * `subscriptionTenantId` pointing to a different tenant, the new owner has
 * 7 days to accept ownership. The accept-ownership API requires a token
 * from the DESTINATION tenant — i.e. the operator running this WebUI must
 * be signed in as the invited owner (or a delegate in that tenant).
 *
 * Flow:
 *   1. Operator pastes / types the subscriptionId.
 *   2. We call GET /acceptOwnershipStatus to verify the request exists and
 *      is still in `Pending` state.
 *   3. If pending, render an "Accept ownership" form (optional rename +
 *      management group) and call POST /acceptOwnership on submit.
 *   4. Audit each step; never throw — surface failures via toast.
 *
 * Extracted from the monolithic ea-subscription-page.tsx so that typing in
 * the parent form (alias name, recipients, etc.) does not re-mount the
 * memoised handlers inside this panel. Each open of the panel still
 * contains its own self-contained subId / checking / accepting state.
 */
import * as React from "react";
import { useMultiRegionStore } from "../../store/store-context";
export interface AcceptOwnershipAccount {
    homeAccountId: string;
    tenantId: string;
    username: string;
    name: string;
}
interface AcceptOwnershipPanelProps {
    account: AcceptOwnershipAccount;
    store: ReturnType<typeof useMultiRegionStore>;
}
export declare const AcceptOwnershipPanel: React.FC<AcceptOwnershipPanelProps>;
export {};
//# sourceMappingURL=accept-ownership-panel.d.ts.map