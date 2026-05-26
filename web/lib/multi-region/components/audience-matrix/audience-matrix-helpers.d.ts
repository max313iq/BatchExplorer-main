/**
 * Universal Audience Matrix — pure helpers.
 *
 * What this module owns
 * ---------------------
 * 1. The CANONICAL list of audience columns the matrix renders (`AUDIENCE_COLUMNS`).
 * 2. The `MintRow` shape — a row is either an imported refresh-token entry
 *    (driven by FOCI exchange) or a signed-in MSAL account.
 * 3. Cell-state helpers and a small token-stat decoder so the page file stays
 *    focused on layout / interaction.
 * 4. A worker-pool runner used to cap parallel AAD round-trips at 5
 *    concurrent mints. Keeps AAD throttling friendly + the UI responsive.
 *
 * What this module deliberately does NOT do
 * -----------------------------------------
 * - No token material is logged here. Token strings flow through unchanged
 *   into the page's React state; this file's helpers only ever read claim
 *   fields (`aud`, `tid`, `exp`, etc.) and never persist or print the raw JWT.
 * - No localStorage / sessionStorage writes. The imported-tokens module
 *   already owns persistence; this page only READS to seed its row list,
 *   and INVOKES `importToken` from the page when the operator clicks
 *   "Import to vault" inside a result popover. Persisting RTs/ATs is the
 *   imported-tokens module's job — duplicating it here would be a foot-gun.
 *
 * Hardening notes
 * ---------------
 * - The 5-mint worker pool isolates AbortController errors so a single
 *   cancelled cell never tears down the pool. A cell that re-clicks itself
 *   while in flight gets its old controller aborted (handled in the page),
 *   but the worker stays alive for sibling cells.
 * - `cellKey(rowId, audience)` and `parseCellKey` are stable serialisations
 *   so the page can keep mint state in a single `Record<string, CellState>`
 *   map without nested objects — cheaper to update immutably.
 */
/**
 * The set of well-known Azure resource audiences the matrix can mint against.
 * `key` is the column header; `scope` is the v2 `.default` string AAD wants.
 *
 * Ordering matters — the matrix renders these in the order below, and
 * operator muscle memory expects ARM / Graph / Batch at the leftmost cells.
 * Keep "Custom" last; the page renders that column with an inline input.
 */
export interface AudienceColumn {
    /** Header text. */
    readonly key: string;
    /** Short label for compact cell tooltips. */
    readonly short: string;
    /** v2 `.default` scope string. Empty for the "Custom" pseudo-column. */
    readonly scope: string;
    /** Human-readable description for the column-header tooltip. */
    readonly description: string;
}
export declare const AUDIENCE_COLUMNS: ReadonlyArray<AudienceColumn>;
/** Convenience lookup by column key. */
export declare const AUDIENCE_BY_KEY: ReadonlyMap<string, AudienceColumn>;
/**
 * Source identifier for a matrix row.
 *
 * `"rt"`  — driven by an imported refresh-token entry. The mint uses
 *           FOCI exchange (`exchangeRefreshTokenForClient`) so we can
 *           target ANY audience the source RT's family covers, without
 *           re-prompting the user.
 * `"account"` — driven by a signed-in MSAL account. The mint uses MSAL's
 *           silent acquire (`acquireTokenSilent` via the existing
 *           getArmTokenForAccount / acquireTokenForAccount surface), so
 *           interactive prompts MIGHT be triggered if scopes haven't
 *           been consented. The page surfaces those as cell-failures so
 *           the operator can act.
 */
export type RowKind = "rt" | "account";
/** Snapshot row shape consumed by the matrix grid. */
export interface MintRow {
    /** Stable id used as the row key + on every audit-log entry. */
    readonly id: string;
    readonly kind: RowKind;
    /** Display name (falls back to UPN, then oid). */
    readonly displayName: string;
    /** UPN / email if known. */
    readonly upn?: string;
    /** Tenant id (short form rendered in the row). */
    readonly tenantId: string;
    /** AAD object id of the principal (for audit entries). */
    readonly oid: string;
    /** For RT rows: the AAD client_id that issued the RT. */
    readonly clientId?: string;
    /** For RT rows: a 6-char prefix for display (RT material is NEVER logged). */
    readonly rtPrefix?: string;
}
/** Result of a successful mint. Token MUST be treated as sensitive. */
export interface MintSuccess {
    readonly accessToken: string;
    /** Unix epoch (seconds). */
    readonly expiresAt: number;
    /** Raw `aud` claim of the minted token. */
    readonly audience: string;
    /** Decoded payload — used by the result popover. Never logged. */
    readonly claims: Record<string, unknown>;
    /** Scope string actually requested (the operator-typed one for Custom). */
    readonly scope: string;
    /** ms taken to mint. Logged for the "time saved" stat. */
    readonly durationMs: number;
}
/**
 * Cell state machine. Each (row, column) starts as `idle`; a click drives it
 * through `pending` → (`success` | `error`). Successes carry the minted
 * token for the result popover; errors carry the AAD error description.
 */
export type CellState = {
    kind: "idle";
} | {
    kind: "pending";
    startedAt: number;
    controller: AbortController;
} | {
    kind: "success";
    result: MintSuccess;
    mintedAt: number;
} | {
    kind: "error";
    message: string;
    aadError?: string;
    failedAt: number;
};
/** Composite cell key — `${rowId}|${audienceKey}`. */
export declare function cellKey(rowId: string, audience: string): string;
/** Inverse of `cellKey`. Returns null on malformed input. */
export declare function parseCellKey(key: string): {
    rowId: string;
    audience: string;
} | null;
/** True when a token cache row is still inside its expiry window. */
export declare function isCellFresh(state: CellState, ttlSec?: number): boolean;
/** Seconds until a successful cell's token expires (0 floor). */
export declare function secondsUntilExpiry(result: MintSuccess): number;
/** Compact "Xm" / "Xh" formatter for expiry badges inside cells. */
export declare function fmtRemaining(sec: number): string;
/**
 * Short tenant id rendered next to each row (first 8 chars). AAD tenant
 * GUIDs are non-secret + commonly truncated this way in screen-shareable
 * UIs.
 */
export declare function shortTenant(tenantId: string): string;
/** Mask a refresh-token to a short prefix for display. NEVER log full RTs. */
export declare function maskRefreshToken(rt: string, prefixLen?: number): string;
/**
 * Decode a minted access token into a compact claim summary suitable for
 * the result popover. NEVER logs the token; only reads claim fields.
 */
export interface ClaimSummary {
    tid?: string;
    aud?: string;
    azp?: string;
    appid?: string;
    scp?: string;
    oid?: string;
    upn?: string;
    exp?: number;
}
export declare function summariseClaims(claims: Record<string, unknown>): ClaimSummary;
/**
 * Decode a JWT and return a fresh claim summary without forcing the page
 * file to import msal-auth directly for every cell click.
 */
export declare function summariseFromJwt(jwt: string): ClaimSummary;
/**
 * Tiny p-limit-style worker pool. Runs `tasks` with at most `concurrency`
 * in-flight at any moment. Returns an array of settled results in the
 * SAME order as the input — so the caller can re-associate results with
 * the row/column they came from.
 *
 * We can't import `p-limit` (no new npm deps). The implementation is
 * intentionally tiny — there's no priority queue, no cancellation, no
 * backpressure shaping. Each task gets its own AbortController already
 * managed by the page; the pool just gates how many `await` happen at once.
 *
 * Tasks that throw are returned as PromiseRejectedResult — the caller
 * decides per-cell what to display.
 */
export declare function runWithConcurrency<T>(tasks: ReadonlyArray<() => Promise<T>>, concurrency: number): Promise<PromiseSettledResult<T>[]>;
/**
 * Compute the elapsed-time saving claim shown in the summary stat row:
 *   `(serialDurationMs - parallelDurationMs)` where the serial baseline
 *   sums every successful mint's `durationMs`. This is honest — it
 *   reports wall-clock the operator WOULD have spent if they had to
 *   click each cell sequentially and wait for each round-trip.
 *
 * Returns 0 when there are no successful mints (no save to claim).
 */
export declare function computeTimeSavedMs(successCells: ReadonlyArray<{
    durationMs: number;
}>, 
/** Wall-clock of the latest parallel batch (max single mint). */
parallelDurationMs: number): number;
/** Pretty-print a duration in ms — used for the "time saved" stat hint. */
export declare function fmtDurationMs(ms: number): string;
/** Row-sort key options. */
export type RowSortKey = "name" | "kind" | "tenant" | "client" | "minted";
/** Sort direction. */
export type SortDirection = "asc" | "desc";
/**
 * Build a row comparator. `mintedCount` is a closure over the cells map and
 * is read only when the sort key is "minted" — for other keys it can be a
 * no-op (`() => 0`).
 */
export declare function buildRowComparator(key: RowSortKey, direction: SortDirection, mintedCount: (rowId: string) => number): (a: MintRow, b: MintRow) => number;
/**
 * Index `cells` by row id, mapping each row to:
 *   - the count of successful cells (for the "minted" sort and the row-level
 *     "any successful cell" predicate);
 *   - the most recent successful `mintedAt` (seconds-epoch) for the recency
 *     filter.
 *
 * Both fields are O(N_cells) to compute (single walk); each query is O(1).
 * The page memoises this so each cells-map change does the walk exactly once.
 */
export interface RowCellIndexEntry {
    /** Count of cells in `success` state for this row. */
    readonly successCount: number;
    /** Most recent `mintedAt` (seconds-epoch) of any successful cell. */
    readonly latestMintedAt: number;
}
export declare function indexCellsByRow(cells: Record<string, CellState>): Map<string, RowCellIndexEntry>;
/**
 * Matrix density. "compact" reduces vertical padding and hides UPN/RT-prefix
 * sub-rows in the identifier cell; "comfy" is the default verbose layout.
 */
export type MatrixDensity = "compact" | "comfy";
/** localStorage key for the density preference (page-scoped). */
export declare const MATRIX_DENSITY_KEY = "audience-matrix.density";
/**
 * Cell coordinate inside the matrix. Indexed against the CURRENT
 * `visibleRows × AUDIENCE_COLUMNS` projection — the page is responsible
 * for keeping this in sync when filters / sort change.
 */
export interface CellCoord {
    readonly rowIndex: number;
    readonly colIndex: number;
}
/**
 * Compute the next focus coordinate given a keyboard arrow event. Returns
 * the unchanged coord when the key isn't a navigation key, so the page can
 * skip the setState. Wraps at the edges — wrap is a deliberate choice: with
 * 12+ audience columns + N rows, "edge bump" frustrates the operator more
 * than wrap surprises them.
 */
export declare function nextCoord(current: CellCoord, key: string, rowCount: number, colCount: number): CellCoord;
/**
 * Returns the current Unix-seconds epoch updated once per second while the
 * tab is visible. Components consuming this value re-render with the new
 * `nowSec` only — cell text uses `expiresAt - nowSec` so the math is local
 * and pure.
 */
export declare function useSecondsTicker(): number;
//# sourceMappingURL=audience-matrix-helpers.d.ts.map