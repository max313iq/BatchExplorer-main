/**
 * ReconciliationTile — post-batch steady-state check.
 *
 * After a batch completes, this panel reconciles the per-recipient status
 * map against expected steady-state and surfaces rows that need operator
 * attention. Grounded in `_bypass_modify_delete.md` (state-changing
 * operations need explicit follow-up — Azure does not guarantee the
 * caller's view of the new resource matches the destination tenant's
 * view immediately).
 *
 * Definitions of "steady state":
 *   - Same-tenant subscription, state="success" + subscriptionId    → STEADY
 *   - Same-tenant subscription, state="success", no subscriptionId  → ALIAS-ONLY (poll)
 *   - Cross-tenant subscription, state="success" + subscriptionId   → PENDING ACCEPTANCE
 *   - state="failure"                                               → FAILED
 *   - state="pending" / "running" past the end of the submit window → STALE
 */
import * as React from "react";
type StatusState = {
    state: "pending";
} | {
    state: "running";
    startedAt: number;
} | {
    state: "success";
    subscriptionId?: string;
    aliasName: string;
    startedAt: number;
    completedAt: number;
} | {
    state: "failure";
    error: string;
    startedAt: number;
    completedAt: number;
};
interface ReconciliationTileProps {
    callerTenantId: string;
    recipients: ReadonlyArray<{
        key: string;
        displayLabel: string;
        tenantId: string;
    }>;
    statusMap: Record<string, StatusState>;
    submitting: boolean;
}
export declare const ReconciliationTile: React.FC<ReconciliationTileProps>;
export {};
//# sourceMappingURL=reconciliation-tile.d.ts.map