/**
 * Audience Matrix — corpus-derived reference data.
 *
 * Defensive context, NOT offensive primitives. The matrix page only DISPLAYS
 * these constants — annotation, not actuation. Source-only refs are below;
 * see CLAUDE.md `Primary research resource` for the corpus rules.
 *
 * What's in this file
 * -------------------
 * 1. FOCI client-id set + a `clientIdIsFoci()` predicate (Signal A).
 *    Source of truth: secureworks/family-of-client-ids-research/known-foci-clients.csv
 *    cloned at
 *    `C:\Users\baimgprodsesa1\Desktop\New folder\dirkjanm\family-of-client-ids-research\known-foci-clients.csv`
 *    The CSV is regenerated as Microsoft adds / removes family members; this
 *    file is a frozen snapshot — re-sync from the corpus when the upstream
 *    CSV moves.
 *
 * 2. Audience risk score (Signal B). A small enum + map keyed by the
 *    matrix's audience-column `key`. Risk is the DEFENSIVE blast-radius
 *    classifier — "if this audience is reachable from a stolen FRT, how
 *    bad is it". Calibrated from:
 *      - dafthack/azure-ad-first-party-apps-permissions/README.md
 *        (defender catalog of first-party pre-consented scopes)
 *      - _analysis_dirkjanm.md §FOCI (ROADtools' canonical audience set)
 *      - _AZURE_LOGIN_METHODS.md §FOCI (master playbook)
 *
 * 3. Defender-awareness banner text (Signal C). One short paragraph the
 *    operator can dismiss; the dismissed state is persisted by the page
 *    via `usePersistedState`. Cites the corpus paths so the operator can
 *    follow up.
 *
 * Authoritative corpus paths cited from this module
 * ---
 * - `_AZURE_LOGIN_METHODS.md`               (master playbook, §FOCI)
 * - `_analysis_dirkjanm.md`                 (FOCI deep-dive)
 * - `_analysis_defender_view.md`            (defender perspective)
 * - `dirkjanm/family-of-client-ids-research/known-foci-clients.csv`
 * - `dirkjanm/family-of-client-ids-research/README.md`
 * - `dafthack/azure-ad-first-party-apps-permissions/README.md`
 *
 * Hardening
 * ---------
 * - The lookups here are pure, read-only constants. No network, no I/O.
 * - Client ids and resource ids are non-secret. Treat this file as
 *   reference material, not as code that touches tokens.
 */
interface FociClient {
    /** AAD client_id (GUID). Lowercase. */
    readonly id: string;
    /** Friendly application name from the upstream CSV. */
    readonly name: string;
}
export declare const KNOWN_FOCI_CLIENTS: ReadonlyArray<FociClient>;
/**
 * True when `clientId` is a member of the published FOCI family. Returns
 * false for empty / undefined / unknown ids — never throws.
 *
 * Per `dirkjanm/family-of-client-ids-research/README.md`, the family-member
 * set is published-but-incomplete; a FALSE here does NOT prove "not FOCI",
 * only "not on the published list as of the snapshot above".
 */
export declare function clientIdIsFoci(clientId: string | undefined | null): boolean;
/**
 * Friendly name for a known FOCI client id, or `undefined` when unknown.
 * The matrix uses this only for tooltips — never for routing decisions.
 */
export declare function fociClientName(clientId: string | undefined | null): string | undefined;
export type AudienceRiskTier = "critical" | "high" | "medium" | "low";
interface AudienceRiskRecord {
    readonly tier: AudienceRiskTier;
    /** One-line corpus-grounded justification shown in the tooltip. */
    readonly rationale: string;
}
/**
 * Risk score keyed by the matrix's `AudienceColumn.key`. Adding a new
 * audience column without an entry here results in the fallback "low" —
 * intentional so unknown columns can't accidentally claim a high score.
 */
export declare const AUDIENCE_RISK_SCORE: Readonly<Record<string, AudienceRiskRecord>>;
/** Compare two tiers — earlier (more critical) tier sorts first. */
export declare function compareAudienceRisk(a: AudienceRiskTier, b: AudienceRiskTier): number;
/**
 * Lookup the risk record for an audience column key. Falls back to the
 * "low" tier with an explicit "uncalibrated" rationale so the column
 * still renders cleanly when a new audience is added without updating
 * this map.
 */
export declare function getAudienceRisk(audienceKey: string): AudienceRiskRecord;
/**
 * Map a tier onto a Tailwind text-color class. Centralised so the page
 * and any future call-site stays visually consistent.
 */
export declare function tierTextClass(tier: AudienceRiskTier): string;
/** Compact one-letter label for the column-header risk pill. */
export declare function tierShort(tier: AudienceRiskTier): string;
/** localStorage key for the dismissed-banner flag. */
export declare const FOCI_BANNER_DISMISS_KEY = "audience-matrix.foci-banner.dismissed";
export interface FociClientProfile {
    /** Lowercase client_id. */
    readonly id: string;
    /** Friendly application name. */
    readonly name: string;
    /** AudienceColumn keys the client is known to tokenize. */
    readonly audiences: ReadonlyArray<string>;
    /** Curated high-value scopes a defender should care about. */
    readonly highValueScopes: ReadonlyArray<string>;
    /** One-line operator/defender summary. */
    readonly notes: string;
}
/**
 * Per-FOCI-client annotated profile. Keyed by lowercase client_id. The
 * matrix uses this for:
 *   - the row-identifier popover ("Azure CLI typically holds…")
 *   - the audience reachability table
 *   - the audience→FOCI reverse map below
 *
 * Coverage: the highest-leverage clients first. Clients NOT in this map
 * still appear in the FOCI badge — `clientIdIsFoci()` is a superset check;
 * this map is the annotated subset. Adding a profile here NEVER changes
 * the badge behaviour.
 */
export declare const FOCI_CLIENT_PROFILES: Readonly<Record<string, FociClientProfile>>;
/**
 * Look up a FOCI client's annotated profile. Returns `undefined` for unknown
 * or un-annotated clients. NEVER throws.
 *
 * `id === ""` is treated as "not a real profile" — defensive guard in case a
 * future maintainer adds a stub entry without a matching client_id.
 */
export declare function getFociClientProfile(clientId: string | undefined | null): FociClientProfile | undefined;
export interface AudienceReachability {
    readonly audienceKey: string;
    readonly clients: ReadonlyArray<{
        id: string;
        name: string;
    }>;
}
/**
 * For each audience column key, the list of annotated FOCI clients known to
 * tokenize for that audience. An empty list means "no annotated client in
 * `FOCI_CLIENT_PROFILES` reaches this audience" — which is NOT proof of
 * unreachability (the audience may still be reachable via clients we haven't
 * annotated). Treat absence as "uncalibrated".
 */
export declare const AUDIENCE_TO_FOCI_CLIENTS: Readonly<Record<string, ReadonlyArray<{
    id: string;
    name: string;
}>>>;
/**
 * Count annotated FOCI clients reaching an audience. Used by the reachability
 * table for the summary badge.
 */
export declare function fociClientsReachingAudience(audienceKey: string): number;
export interface DefenderBannerCopy {
    readonly title: string;
    readonly body: string;
    readonly citationLines: ReadonlyArray<string>;
}
export declare const DEFENDER_BANNER_COPY: DefenderBannerCopy;
export {};
//# sourceMappingURL=audience-matrix-corpus.d.ts.map