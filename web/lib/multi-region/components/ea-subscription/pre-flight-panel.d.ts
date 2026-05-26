/**
 * PreFlightPanel — surfaces corpus-grounded signatures and a pre-create
 * simulation BEFORE the operator clicks submit. Read-only, never mutates
 * the form; it exists so the audit trail / SIEM picture the operator
 * expects matches what will actually fire.
 *
 * Grounded in `_ea_subscription_cross_tenant.md` (cross-tenant attack
 * shape) and `_bypass_role_grant.md` (billing-role chain effects).
 *
 * Renders nothing when there are no recipients yet — keeps the page
 * quiet during the early scope-pick phase.
 */
import * as React from "react";
interface PreFlightPanelProps {
    callerTenantId: string;
    callerTenantLabel: string;
    callerUpn: string | undefined;
    recipients: ReadonlyArray<{
        source: "web-account" | "tenant-user" | "manual";
        tenantId: string;
        ownerObjectId: string;
        displayLabel: string;
        upn?: string;
    }>;
}
export declare const PreFlightPanel: React.FC<PreFlightPanelProps>;
export {};
//# sourceMappingURL=pre-flight-panel.d.ts.map