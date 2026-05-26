/**
 * Resource-Manager security signals — heuristic warnings surfaced before
 * the operator commits a destructive ARM `moveResources` pipeline.
 *
 * These detections are grounded in the offensive-tooling corpus:
 *   - `_bypass_modify_delete.md` §4.10 "Bulk delete via batch" — bulk
 *     ops touching >20 resources from multiple RGs are an attacker
 *     anti-pattern. Same rubric applies to bulk moves: an attacker
 *     scooping up many resources across RGs is suspicious vs. an
 *     operator doing focused per-team migration.
 *   - `_bypass_modify_delete.md` §3 + §4 "Modify operations" — rename
 *     immediately followed by move is a known exfiltration pattern
 *     (attacker renames a resource to an obscure name to delay
 *     detection, then moves it to an attacker-controlled subscription
 *     where their telemetry can't be observed by the source tenant).
 *   - `_ea_subscription_cross_tenant.md` — cross-subscription transfers
 *     even within the same tenant change billing/RBAC inheritance and
 *     are worth flagging to the operator.
 *
 * NOTE: this is OPERATOR-VISIBLE defensive UX. It does NOT block the
 * action — the operator can still proceed. It exists so a defender
 * using this WebUI to drive a legitimate bulk move sees the same
 * red-flag heuristics that the SOC would see in Activity Log.
 */
import * as React from "react";
/** Computed input bundle for the security-signals card. */
export interface SecuritySignalsInput {
    /** How many planned rows in the current plan. */
    planRowCount: number;
    /** Distinct source resource-groups touched by the plan. */
    distinctSourceRgs: number;
    /** Distinct destination locations the plan would create. */
    distinctDestLocations: number;
    /** Source subscription id (full). */
    sourceSubscriptionId: string | null;
    /** Destination subscription id (full). */
    destinationSubscriptionId: string | null;
    /** Source tenant id (full). */
    sourceTenantId: string | null;
    /** Destination tenant id (full). */
    destinationTenantId: string | null;
    /**
     * How many rows have an operator-supplied destination RG name override
     * (the rename signal — combined with a move it triggers the
     * exfiltration heuristic).
     */
    rowsWithRenameOverride: number;
}
/**
 * Compute the active warning set for the current plan. Pure function
 * so it's trivially memoisable on the consumer side.
 */
export declare function computeSecuritySignals(input: SecuritySignalsInput): {
    bulkCrossRg: boolean;
    crossSubscription: boolean;
    crossTenant: boolean;
    renameAndMove: boolean;
    fanOutRgs: boolean;
    multiRegionLanding: boolean;
    anyActive: boolean;
};
interface SecuritySignalsBannerProps extends SecuritySignalsInput {
    /** Optional className passthrough. */
    className?: string;
}
/**
 * Compact banner that lists each active security signal as a line with
 * a corpus reference. Rendered above the action buttons so the operator
 * sees the warnings before clicking "Validate" / "Move".
 *
 * Renders nothing when no signal is active.
 */
export declare const SecuritySignalsBanner: React.FC<SecuritySignalsBannerProps>;
/**
 * Pre-move attack-surface preview — a static reference card that
 * surfaces "what transfers, what doesn't" so an operator running their
 * first move doesn't get caught out by RBAC/policy/lock gaps at the
 * destination. Independent from the per-row plan; values are the
 * documented behaviour of ARM `moveResources`.
 *
 * Source-of-truth: Microsoft docs on resource-move limitations +
 * `_bypass_role_grant.md` for the role-assignment scoping rubric. We
 * surface this in the UI so the operator never has to context-switch
 * to the docs mid-pipeline.
 */
export declare const PreMoveAttackSurfacePreview: React.FC<{
    className?: string;
}>;
export {};
//# sourceMappingURL=security-signals.d.ts.map