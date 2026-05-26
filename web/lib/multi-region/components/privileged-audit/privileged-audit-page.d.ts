/**
 * Privileged Users & Shadow Admin Auditor — defensive port of the
 * concepts from CyberArk's SkyArk into the tenant-admin WebUI.
 *
 * Goal: surface every principal in the operator's active tenant that
 * holds a directory role, including the assignments that the Azure-
 * portal "Roles & administrators" blade hides — group-mediated
 * memberships, service-principal-held roles, and cross-tenant guest
 * privileges. The page is read-only by design (defensive auditing,
 * not privilege management).
 *
 * Sections (matches the spec):
 *   A. Top stat row — totals per tier, shadow-admin / SP / guest counts.
 *   B. Privileged identity list — every holder, with tier badge, role
 *      list, assignment-path chips, deep-link to portal, expandable
 *      per-role detail.
 *   C. Shadow admin paths — every non-direct escalation route as a
 *      "Alice → via group GA-Owners → Global Admin (Tier 0)" row.
 *      Privileged Role Administrators destructive Alert at the top.
 *   D. Groups holding privileged roles — direct vs transitive member
 *      counts, "high blast radius" callout for Tier 0 groups > 10
 *      transitive members.
 *   E. Service principals with privileged roles — flag suspicious
 *      newcomers (recent createdDateTime + Tier 0 role).
 *
 * Hard constraints honoured:
 *   - New files only (under components/privileged-audit/).
 *   - No edits to services / auth / store / page-router / sidebar-nav.
 *   - No new npm deps.
 *   - All probes read-only — no POST/PATCH/DELETE.
 *   - Pagination handled via `@odata.nextLink`.
 *   - Graph permission failures degrade per-probe with inline warnings
 *     rather than blanking the whole page.
 */
import * as React from "react";
export declare const PrivilegedAuditPage: React.FC;
export default PrivilegedAuditPage;
//# sourceMappingURL=privileged-audit-page.d.ts.map