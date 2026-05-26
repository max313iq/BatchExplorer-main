/**
 * Multi-hop path-finder visualizer for the Role Assignment Visualizer.
 *
 * Renders the BFS results from `findShortestPath` and the
 * transitive-ownership-chain findings from `detectOwnershipChains` as
 * hop-by-hop chips so the operator can see EVERY edge they have to revoke
 * to break the chain — not just the leaf principal.
 *
 * Corpus citations (mirrored from `role-graph-helpers.ts`):
 *   - `_bypass_role_grant.md` §5.3 group ownership = membership management
 *   - `_bypass_role_grant.md` §5.4 nested groups
 *   - `_bypass_role_grant.md` §10  role-graph privesc chain reference
 *   - `_analysis_specterops.md`    AzureHound shortestPath queries
 *
 * No I/O — every input is precomputed in the page or in the helper module.
 */
import * as React from "react";
import { type FoundPath, type OwnershipChainFinding } from "./role-graph-helpers";
export interface PathFinderPanelProps {
    /** Whether the path finder is "armed" (the operator typed at least one hint). */
    armed: boolean;
    /** BFS-derived shortest paths. */
    paths: FoundPath[];
    /** Transitive-ownership chains (one-off detector, always-on). */
    ownershipChains: OwnershipChainFinding[];
    /** Optional notice for when the result set was capped. */
    totalMatched: number;
    /** Click handler for "focus this principal in the tree". */
    onFocusPrincipal?: (principalId: string) => void;
    /** Click handler for "filter to this group's members". */
    onFocusGroup?: (groupId: string) => void;
    /** Toggle expansion of the panel itself. */
    defaultOpen?: boolean;
}
/**
 * Root component — renders the BFS path list AND the transitive-ownership
 * detector findings as two sub-sections inside one collapsible card.
 *
 * Renders aria-live so screen readers announce when the path count updates.
 */
export declare const PathFinderPanel: React.FC<PathFinderPanelProps>;
//# sourceMappingURL=path-finder-panel.d.ts.map