/**
 * Defender-signals panel for the Role Assignment Visualizer.
 *
 * Renders the four corpus-derived signals as expandable cards inside the
 * role-graph page. Strictly presentation — every detector lives in
 * `role-graph-helpers.ts` and the page itself owns the supplementary Graph
 * reads (this component never fetches).
 *
 * Corpus citations:
 *   - C:\Users\baimgprodsesa1\Desktop\New folder\_AZURE_BYPASS_PLAYBOOK.md
 *       "Critical Defender Audit Surface" items 4-5
 *       Top-30 escalation chains items 23, 24, 25, 26
 *   - C:\Users\baimgprodsesa1\Desktop\New folder\_bypass_role_grant.md
 *       §3.5 (App Admin → existing app)
 *       §4.1/§4.2 (addPassword / addKey)
 *       §5.1/§5.3 (role-assignable groups + group ownership)
 *       §8.1 (custom role with hidden privesc actions)
 *
 * Defensive analogs to cite in tooltips:
 *   - SpecterOps/AzureHound — role-graph collection
 *   - nccgroup/PMapper, Azucar — custom-role audits
 *   - dafthack/GraphRunner — application-credentials enumeration
 *
 * NOTE: this is a defender-only surface — it shows risk indicators read out
 * of operator-tenant data the user can already see. It never invokes any of
 * the offensive primitives the citations describe; the page never POSTs an
 * `addKey`, `addPassword`, role assignment, or owner add.
 */
import * as React from "react";
import { type AppAdminEscalationFinding, type CredentialSurfaceFinding, type CustomRolePrivescFinding, type DefenderSignalCounts, type RoleAssignableGroupFinding } from "./role-graph-helpers";
export interface DefenderSignalsPanelProps {
    /** Signal A — derived from the existing probe data (no extra fetch). */
    customRoleFindings: CustomRolePrivescFinding[];
    /** Signal B — present when the page has fetched role-assignable groups. */
    roleAssignableGroupFindings: RoleAssignableGroupFinding[] | null;
    /** True while Signal B Graph fetch is in flight. */
    roleAssignableGroupsLoading: boolean;
    /** Optional load-on-demand callback for Signal B. */
    onLoadRoleAssignableGroups?: () => void;
    /** Warning(s) collected while fetching Signal B. */
    roleAssignableGroupsWarning?: string | null;
    /** Signal C — present when the page has fetched App Admin + high-priv SPs. */
    appAdminFindings: AppAdminEscalationFinding[] | null;
    appAdminLoading: boolean;
    onLoadAppAdmin?: () => void;
    appAdminWarning?: string | null;
    /** Signal D — present when the page has fetched SP credential metadata. */
    credentialSurfaceFindings: CredentialSurfaceFinding[] | null;
    credentialSurfaceLoading: boolean;
    onLoadCredentialSurface?: () => void;
    credentialSurfaceWarning?: string | null;
    /** Pre-computed counts (drives the score badge). */
    counts: DefenderSignalCounts;
    /** Risk-score from `computeDefenderSignalScore`. */
    score: number;
    scoreLabel: string;
}
export declare const DefenderSignalsPanel: React.FC<DefenderSignalsPanelProps>;
//# sourceMappingURL=defender-signals-panel.d.ts.map