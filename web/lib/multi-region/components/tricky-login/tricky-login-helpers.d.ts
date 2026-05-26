/**
 * Pure helpers for the Tricky Login page.
 *
 * Why a separate module: the page-component file is wide enough that the
 * read-only logic (method detection, claim labelling, mint-result shape,
 * history serialisation, scope/audience inference) deserves its own home
 * so the page itself stays focused on layout + side-effects.
 *
 * Nothing here touches MSAL, the store, or the audit log. All inputs are
 * value types; every function returns a fresh value. This keeps the
 * helpers trivially unit-testable and side-effect-free.
 *
 * The legitimate use case for this page (per the spec):
 *   Tenant admins who are already signed in with account X want to mint a
 *   token for tenant Y (where X is a guest) WITHOUT re-entering
 *   credentials, then optionally use the result as a "duplicate" account
 *   context they can switch between.
 *
 * We re-frame three red-team tricks from ROADtools / AADInternals /
 * Stormspotter as defensive admin operations:
 *
 *   1. MSAL silent multi-tenant   — `getArmTokenForAccount(home, targetTid)`
 *   2. FOCI refresh-token exchange — `exchangeRefreshTokenForClient(...)`
 *   3. Auto                        — try MSAL first, fall back to FOCI
 *
 * Each method here corresponds to one canonical `TrickyLoginMethod` value
 * that the page UI renders and the audit log records.
 */
import type { AudienceBucket } from "../../auth/imported-tokens";
import type { TenantInfo } from "../../services/types";
/** The three method strategies the page exposes. */
export type TrickyLoginMethod = "msal-silent" | "foci-exchange" | "auto";
/** Result shape stored in history and rendered in the result panel. */
export interface TrickyLoginMintResult {
    /** Whether the mint attempt succeeded. */
    status: "success" | "failure";
    /** Concrete method that actually produced (or failed to produce) the token. */
    methodUsed: TrickyLoginMethod;
    /** Source account MSAL homeAccountId (UPN / oid join). */
    sourceAccountId: string;
    /** Source account UPN/display, captured for the history table. */
    sourceAccountLabel: string;
    /** Target tenant id (lowercased GUID). */
    targetTenantId: string;
    /** Best-effort display name for the target tenant. */
    targetTenantLabel: string;
    /**
     * Audience bucket the operator chose — narrowed to the vault-friendly
     * `AudienceBucket` so existing import / vault helpers can short-circuit.
     * For audiences outside arm/graph/batch, this is `"unknown"` and the
     * richer id lives in `extendedAudience`.
     */
    audience: AudienceBucket;
    /**
     * Extended audience id for the 12-audience picker. Always present.
     * Mirrors `audience` for arm/graph/batch and carries the rich id
     * (vault/storage/intune/devops/etc.) for the rest.
     */
    extendedAudience?: TrickyAudienceId;
    /** Scope string the operator submitted (verbatim). */
    scope: string;
    /** Wall-clock ms between submit click and resolution. */
    durationMs: number;
    /** Successful mint only — the new access token. */
    accessToken?: string;
    /** Successful mint only — refresh token if AAD returned one. */
    refreshToken?: string;
    /** Successful mint only — decoded JWT claim payload (signature NOT verified). */
    claims?: Record<string, unknown>;
    /** Successful mint only — unix epoch seconds the token expires at. */
    expiresAt?: number;
    /** Failed mint only — best-effort AAD error code (e.g. "AADSTS50158"). */
    errorCode?: string;
    /** Failed mint only — the human-readable error message. */
    errorMessage?: string;
    /** ISO timestamp when the attempt resolved. */
    finishedAt: string;
}
/** Compact history row persisted to sessionStorage (subset of MintResult). */
export interface TrickyLoginHistoryRow {
    id: string;
    sourceAccountId: string;
    sourceAccountLabel: string;
    targetTenantId: string;
    targetTenantLabel: string;
    methodUsed: TrickyLoginMethod;
    audience: AudienceBucket;
    /** Extended audience id when the row is for one of the extra 9 audiences. */
    extendedAudience?: TrickyAudienceId;
    scope: string;
    status: "success" | "failure";
    durationMs: number;
    errorCode?: string;
    finishedAt: string;
}
/** Per-method discovery flag rendered in the "Tricks discovery" panel. */
export interface MethodAvailability {
    /** True when the method should succeed at submit-time. */
    available: boolean;
    /** Short one-line operator-facing reason ("✓ ..." / "✗ ..."). */
    reason: string;
}
/** Aggregated discovery state for the currently-selected (account, tenant). */
export interface MethodAvailabilityMap {
    msalSilent: MethodAvailability;
    fociExchange: MethodAvailability;
    /** Always unavailable in the browser (no PRT / device cert). Listed for completeness. */
    directTenantRt: MethodAvailability;
}
/**
 * Detect which mint methods are likely to succeed for a given source
 * account + target tenant pair WITHOUT making any network calls.
 *
 * - MSAL silent: needs the target tenant to appear in `account.tenants`
 *   (either pre-loaded via Azure Accounts or fetched lazily by the page).
 *   The presence of the tenant in that list means ARM accepted a /tenants
 *   call from this account, which is a very strong signal that
 *   acquireTokenSilent against the target tenant authority will work.
 *
 * - FOCI exchange: needs ANY imported refresh token for this account.
 *   The page also checks `detectFociEligibility` on the imported RT's
 *   originating client id, but the pre-flight here is the cheaper
 *   "do we even have an RT?" check.
 *
 * - Direct tenant RT: deliberately marked unavailable — a true
 *   "refresh-token issued by tenant Y directly" mint requires either a
 *   PRT (device-certificate-backed, OS-level only) or a stolen RT
 *   already minted against tenant Y. Both are out of scope for an
 *   admin defensive tool.
 */
export declare function detectMethodAvailability(args: {
    accountTenants: TenantInfo[] | undefined;
    activeTenantId: string | undefined;
    targetTenantId: string;
    hasImportedRefreshToken: boolean;
    importedRefreshTokenClientLabel?: string;
}): MethodAvailabilityMap;
/**
 * Extended audience id surfaced by the Tricky Login picker.
 *
 * The canonical `AudienceBucket` type in `auth/imported-tokens.ts` is
 * deliberately narrow (`arm | graph | batch | unknown`) — that's all the
 * vault / classifier / silent-acquire layer needs to know. The Tricky Login
 * page, however, supports minting tokens for a much wider set of resource
 * servers via the FOCI exchange path (POST grant_type=refresh_token against
 * `/{tid}/oauth2/v2.0/token` with any `scope=…/.default`), so we surface
 * a richer enum HERE without touching auth/.
 *
 * Any extended id outside `AudienceBucket` collapses to `"unknown"` when
 * imported into the vault — that's by design. The vault only short-
 * circuits `getArmTokenForAccount` / `getGraphTokenForAccount` /
 * `getBatchTokenForAccount`; other audiences are routed through the
 * tricky-login page (or copy-pasted into curl) on demand.
 */
export type TrickyAudienceId = "arm" | "graph" | "batch" | "vault" | "storage" | "keyvault" | "intune" | "substrate" | "monitor" | "powerbi" | "yammer" | "devops" | "custom";
/** Canonical audience entries surfaced by the audience picker. */
export interface AudienceChoice {
    id: TrickyAudienceId;
    /** Short label rendered on the radio chip. */
    label: string;
    /** Default scope string when this audience is picked. */
    scope: string;
    /** Short description for tooltips. */
    description: string;
    /**
     * True when this audience is serviceable via MSAL silent (i.e. one of
     * the three audiences our `getArmTokenForAccount` / `getGraphTokenForAccount`
     * / `getBatchTokenForAccount` helpers cover). All other audiences MUST
     * use the FOCI exchange path — MSAL silent has no generic acquire for
     * arbitrary scopes (would require a service-layer edit, out of scope
     * here).
     */
    msalSilentSupported: boolean;
}
export declare const AUDIENCE_CHOICES: ReadonlyArray<AudienceChoice>;
/**
 * Subset of audience ids that the "Batch mint all" button iterates. Excludes
 * `custom` (no fixed scope) and dedupes `vault`/`keyvault` order so the
 * 12-row batch panel matches the spec's "Batch mint 12 audiences" label.
 */
export declare const BATCH_MINT_AUDIENCES: ReadonlyArray<TrickyAudienceId>;
/** Look up an audience choice by id. */
export declare function getAudienceChoice(id: TrickyAudienceId): AudienceChoice;
/**
 * Classify a scope string into one of the canonical buckets used by the
 * imported-token vault (`AudienceBucket`).
 *
 * NOTE: this is intentionally narrower than `extendedAudienceForScope`
 * below — the vault only short-circuits arm/graph/batch, so anything else
 * has to be re-introduced via a fresh import on every audience change.
 */
export declare function audienceForScope(scope: string): AudienceBucket;
/**
 * Classify a scope string into the *extended* set of tricky-login audiences
 * (12 + custom). Mirrors `audienceForScope` for arm/graph/batch but also
 * recognises vault, storage, intune, substrate, monitor, powerbi, yammer,
 * devops. Returns `"custom"` when no entry matches.
 */
export declare function extendedAudienceForScope(scope: string): TrickyAudienceId;
/**
 * Compact per-claim explainers rendered as `InfoTooltip` hovers on the
 * decoded-claims table. Same provenance as the token-importer page's
 * `CLAIM_EXPLAIN` map but kept page-local so this module doesn't depend
 * on the importer.
 */
export declare const CLAIM_EXPLAIN: Readonly<Record<string, string>>;
/**
 * Format an epoch-seconds value as a friendly "expires in Xm Ys" string.
 * Returns "expired Xs ago" for past values, "—" for missing data.
 */
export declare function formatExpiresIn(epoch: number | undefined | null): string;
/** Compact duration formatter shared by the result + history rows. */
export declare function fmtDuration(seconds: number): string;
/** Mask a token for screen-share-safe display. */
export declare function maskToken(value: string, visible?: number): string;
/**
 * Pull a stable AAD error code (AADSTSnnnnn) out of a raw error message
 * when present. Used so the history table shows a short, actionable code
 * instead of the multi-line AAD error_description.
 */
export declare function extractAadErrorCode(message: string | undefined | null): string | undefined;
/**
 * Reduce a full mint result to its history-row shape. We do NOT persist
 * token material — only metadata — so the history blob is safe to land
 * in sessionStorage and to print in audit logs.
 */
export declare function toHistoryRow(result: TrickyLoginMintResult): TrickyLoginHistoryRow;
/** sessionStorage key for the persisted history. Versioned so we can bump. */
export declare const HISTORY_STORAGE_KEY = "tricky-login:history:v1";
/** Cap on history entries — same as the spec calls out. */
export declare const HISTORY_MAX_ENTRIES = 20;
/** sessionStorage handoff key the Token Importer page reads from. */
export declare const TOKEN_IMPORTER_SESSION_KEY = "token-importer:access-token";
/** Read the persisted history, tolerating quota / parse failures. */
export declare function loadHistory(): TrickyLoginHistoryRow[];
/** Persist the history, capped to HISTORY_MAX_ENTRIES (most-recent-first). */
export declare function saveHistory(rows: TrickyLoginHistoryRow[]): void;
/**
 * Human label for a method — used in the result panel + history.
 */
export declare function methodLabel(method: TrickyLoginMethod): string;
/** Short tag for the method badge column. */
export declare function methodShortLabel(method: TrickyLoginMethod): string;
/**
 * Friendly tenant label resolver — matches the search order used by
 * performTenantSwitch's `findTenantLabel`. Falls back to the tenantId
 * itself when the directory list hasn't been hydrated.
 */
export declare function findTenantLabel(tenants: TenantInfo[] | undefined, tenantId: string | undefined): string;
//# sourceMappingURL=tricky-login-helpers.d.ts.map