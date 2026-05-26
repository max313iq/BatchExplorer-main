/**
 * Role Assignment Visualizer — defensive RBAC audit page.
 *
 * Stormspotter-inspired (Microsoft's Azure Red Team graph tool) but
 * purpose-built for tenant ADMINS auditing THEIR OWN environment:
 *
 *   1. Operator picks an account + one-or-more accessible subscriptions.
 *   2. For each picked sub, we hit
 *      `Microsoft.Authorization/roleAssignments` at the sub scope and
 *      `Microsoft.Authorization/roleDefinitions` (with permissions
 *      included — see `fetchRoleDefinitionsWithPermissions` below).
 *   3. Principal display names are resolved via Graph
 *      `directoryObjects/getByIds` per the sub's tenant.
 *   4. For every GROUP principal that holds a critical-tier role, we
 *      best-effort enumerate transitive members via
 *      `groups/{id}/transitiveMembers` so group-mediated inheritance
 *      lights up in the escalation column. Permission failures degrade
 *      gracefully (the group simply doesn't expand) — never block the
 *      page render.
 *   5. Helpers classify everything into tiers + detect escalation
 *      patterns; the page is just rendering.
 *
 * Audit: every probe writes a single `role_graph_probe` audit-log entry
 * with the per-sub assignment + principal + escalation counts. Failures
 * land in the same entry under `status: "failure"`.
 *
 * NO graph library — we render the principal → role → scope hierarchy
 * as a collapsible Tailwind tree. The visual cues are tier badges +
 * escalation alerts inline so the operator can spot risk at a glance.
 */
import * as React from "react";
import type { PageKey } from "../shared/sidebar-nav";
import { type EscalationCategory } from "./role-graph-helpers";
export interface RoleGraphPageProps {
    onNavigate?: (k: PageKey) => void;
}
export declare const RoleGraphPage: React.FC<RoleGraphPageProps>;
export type { EscalationCategory };
//# sourceMappingURL=role-graph-page.d.ts.map