/**
 * Audience Matrix — corpus-grounded reachability table.
 *
 * What this is
 * ------------
 * A small, READ-ONLY companion table that surfaces the static FOCI reachability
 * map from `audience-matrix-corpus.ts`:
 *
 *   For each AUDIENCE_COLUMNS key, which annotated FOCI clients are known
 *   to tokenize for that audience (per
 *   `dirkjanm/family-of-client-ids-research/scope-map.txt` and
 *   `dafthack/azure-ad-first-party-apps-permissions/README.md`)?
 *
 * The matrix already shows OBSERVED reachability ("did mint X succeed for
 * row Y"). This table shows the PREDICTED reachability ("which family members
 * are known to mint to this audience"). Together they answer:
 *
 *   - "Why does my Azure CLI RT mint Graph?"   → because Azure CLI is on the
 *      Graph-reaching list (annotation; visible here).
 *   - "Why didn't my Outlook Mobile RT mint ARM?" → because Outlook Mobile is
 *      NOT on the ARM-reaching list (annotation; visible here).
 *
 * Hardening notes
 * ---------------
 * - Pure render. No fetch, no token material. The corpus data is frozen
 *   at module load by `audience-matrix-corpus.ts`.
 * - Collapsed-by-default (operator dismisses noisy detail). Open state is
 *   persisted via `usePersistedState` so the choice survives reload.
 *
 * Corpus citations
 * ----------------
 * - `_AZURE_LOGIN_METHODS.md` §FOCI
 * - `_analysis_dirkjanm.md` §FOCI
 * - `dirkjanm/family-of-client-ids-research/scope-map.txt`
 * - `dafthack/azure-ad-first-party-apps-permissions/README.md`
 */
import * as React from "react";
interface AudienceReachabilityTableProps {
    /**
     * Optional client_id of the currently-hovered/focused row. When set, the
     * table highlights the row whose audience hits include this client and
     * dims everything else — gives the operator a one-glance answer to
     * "which audiences does THIS row reach?".
     */
    readonly highlightClientId?: string | null;
}
/**
 * Defender-facing static reachability table. Read-only. Highlights rows for
 * the currently focused FOCI client when provided.
 */
export declare const AudienceReachabilityTable: React.FC<AudienceReachabilityTableProps>;
export {};
//# sourceMappingURL=audience-matrix-reachability.d.ts.map