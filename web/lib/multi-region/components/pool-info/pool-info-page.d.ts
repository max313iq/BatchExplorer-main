/**
 * Pool Info page — list and inspect Batch pools across regions, drive
 * resize and start-task updates, and surface deep-link details (autoscale
 * formula, resize errors, node-state breakdown) via a side Sheet.
 *
 * Redesigned 2026-05-24:
 *   - Split conflated "State + Allocation" filter into two distinct selects.
 *   - Quick-filter chips for the most common triage views (errors, empty,
 *     non-steady, auto-scale).
 *   - VM-size filter dropdown + idempotency checks on resize / delete-empty.
 *   - Bulk-selection toolbar (Resize / Update Start Task / Reboot nodes /
 *     Delete) appears as soon as any row is selected.
 *   - Per-row hover-revealed actions (Inspect / Reboot all nodes / Delete).
 *   - Sheet has CopyButton on Pool ID + ARM resource id, deep links to the
 *     Azure Portal pool blade AND the in-app Nodes page filtered to this
 *     pool, and lists running-task counts plus a top-10 node list.
 *   - Resize dialog: quick-pick percentage buttons, idempotency guard so a
 *     no-op resize is just toasted instead of fired against the API, and a
 *     "running tasks will be terminated" warning when relevant.
 *   - Auto-refresh has a re-entrancy guard; the Refresh button is disabled
 *     while a tick is in flight.
 *   - Each successful pool action emits an `addAuditEntry` record so the
 *     Audit Log page reflects pool-info origin operations consistently.
 *   - Selection self-prunes after refresh / delete so stale ids don't ghost
 *     bulk actions.
 *   - `useArmToken` + `TokenExpiryBadge` preserved unchanged.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
export interface PoolInfoPageProps {
    orchestrator: OrchestratorAgent;
}
export declare const PoolInfoPage: React.FC<PoolInfoPageProps>;
//# sourceMappingURL=pool-info-page.d.ts.map