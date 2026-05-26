/**
 * Imported-token store — lets the operator paste an access token grabbed
 * from a separate Azure login (e.g. portal.azure.com via DevTools) and
 * use it as the bearer for ARM / Graph / Batch calls in this app.
 *
 * Bypasses MSAL entirely. Tokens are stored in localStorage keyed by
 * (homeAccountId, audience). They live until the JWT's own `exp` claim
 * — no silent refresh, the operator re-imports when one expires.
 *
 * Design choices:
 *   - `homeAccountId` is derived from the JWT's `oid.tid` claim pair so
 *     the same operator pasting tokens from multiple browser sessions
 *     deduplicates naturally.
 *   - Audience normalisation: the JWT's `aud` claim may be a URI or a
 *     GUID — we normalise to one of three canonical bucket keys so
 *     callers can ask for "arm" / "graph" / "batch" without knowing
 *     the exact `aud` value AAD chose.
 *   - All localStorage I/O is best-effort; private-mode browsers fall
 *     back to an in-memory map so the page still works in the current
 *     tab.
 */
/**
 * Public list of every localStorage / sessionStorage key this module
 * owns. Consumed by `msal-auth.ts:logout()` so a sign-out targets only
 * keys we know belong to us, instead of doing a blanket
 * `localStorage.clear()` that would wipe unrelated app state.
 */
export declare const IMPORTED_TOKEN_STORAGE_KEYS: readonly string[];
/** Canonical audience bucket names used by the rest of the app. */
export type AudienceBucket = "arm" | "graph" | "batch" | "devops" | "unknown";
export interface ImportedTokenEntry {
    /** Synthetic homeAccountId: `${oid}.${tid}`. Matches MSAL's format. */
    homeAccountId: string;
    /** Tenant id from the JWT's `tid` claim. */
    tenantId: string;
    /** AAD object id from `oid`. */
    oid: string;
    /** UPN / preferred username if the JWT carries one. */
    upn?: string;
    /** Display name from `name` claim if present. */
    name?: string;
    /** Canonical audience bucket the token targets. */
    audience: AudienceBucket;
    /** Raw `aud` claim from the JWT (for diagnostics). */
    rawAudience: string;
    /** The bearer token itself. */
    accessToken: string;
    /** Unix epoch (seconds) when the token expires. */
    expiresAt: number;
    /** ISO timestamp when it was imported (for the UI list). */
    importedAt: string;
}
/**
 * Decode a JWT payload WITHOUT signature verification. Identical
 * algorithm to msal-auth's `decodeJwtClaimsUnsafe` — duplicated here to
 * keep this module dependency-free of the MSAL surface.
 */
export declare function decodeJwtPayload(jwt: string): Record<string, unknown> | null;
/** Map a raw `aud` claim onto one of our canonical buckets. */
export declare function classifyAudience(rawAud: string): AudienceBucket;
/** Map a scope URI (as msal-auth passes around) to our audience bucket. */
export declare function scopeToAudience(scope: string): AudienceBucket;
/**
 * Decoded preview surfaced by the UI before the operator commits. Same
 * shape as ImportedTokenEntry minus the `importedAt` timestamp.
 */
export interface ImportPreview {
    jwt: string;
    homeAccountId: string;
    tenantId: string;
    oid: string;
    upn?: string;
    name?: string;
    audience: AudienceBucket;
    rawAudience: string;
    expiresAt: number;
    /** Pre-decoded payload for full claim display. */
    claims: Record<string, unknown>;
}
/**
 * Validate + decode a pasted JWT. Returns null on malformed input. Does
 * NOT store anything — caller decides whether to commit.
 */
export declare function previewToken(jwt: string): ImportPreview | null;
/**
 * Commit a previewed token into the local store. If a token with the
 * same (homeAccountId, audience) already exists, it's replaced.
 */
export declare function importToken(preview: ImportPreview): ImportedTokenEntry;
/**
 * Look up an imported token by (homeAccountId, audience). Returns the
 * raw JWT string if present and unexpired. Expired entries are
 * automatically purged so the caller never gets a stale token by
 * accident.
 */
export declare function getImportedToken(homeAccountId: string, audience: AudienceBucket): string | null;
/** Return every currently-stored token (expired entries auto-purged). */
export declare function listImportedTokens(): ImportedTokenEntry[];
/** Distinct accounts represented in the import store. */
export interface ImportedAccountSummary {
    homeAccountId: string;
    tenantId: string;
    oid: string;
    upn?: string;
    name?: string;
    audiences: AudienceBucket[];
    earliestExpiresAt: number;
}
export declare function listImportedAccounts(): ImportedAccountSummary[];
/** Drop every token (access + refresh) for a single homeAccountId. */
export declare function removeImportedAccount(homeAccountId: string): void;
/** Drop a single audience entry for a homeAccountId. */
export declare function removeImportedAudience(homeAccountId: string, audience: AudienceBucket): void;
/** Wipe every imported token from storage. */
export declare function clearImportedTokens(): void;
/**
 * Per-principal refresh-token entry. ONE refresh token per principal is
 * enough: AAD's refresh-token grant lets us mint access tokens for any
 * scope the original consent included. The `clientId` field records
 * which AAD app the refresh token was issued to — we MUST send the same
 * value back at redemption time or AAD returns invalid_grant.
 */
export interface ImportedRefreshTokenEntry {
    homeAccountId: string;
    tenantId: string;
    oid: string;
    upn?: string;
    name?: string;
    clientId: string;
    refreshToken: string;
    importedAt: string;
}
/** Store (or replace) a refresh token + the client id that issued it. */
export declare function importRefreshToken(entry: Omit<ImportedRefreshTokenEntry, "importedAt"> & {
    importedAt?: string;
}): ImportedRefreshTokenEntry;
/** Look up the refresh-token row for a principal, if any. */
export declare function getRefreshTokenEntry(homeAccountId: string): ImportedRefreshTokenEntry | null;
/** Public read for the UI listing. */
export declare function listRefreshTokenEntries(): ImportedRefreshTokenEntry[];
/** Drop a refresh token by principal. */
export declare function removeRefreshToken(homeAccountId: string): void;
/** Canonical scope strings used by the rest of the app. */
export declare const SCOPE_FOR_AUDIENCE: Record<AudienceBucket, string>;
interface TokenEndpointResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
}
/**
 * Typed error thrown by `redeemRefreshToken` (and downstream callers
 * such as `ensureImportedToken`). Mirrors the shape of
 * `FociExchangeError` / `DeviceCodeError` so the rest of the auth pod
 * can switch on `.code` for retry decisions, audit-log enrichment, or
 * user-facing copy.
 *
 * Backward compatibility: previous callers caught a generic `Error`
 * and read `err.message`. We preserve the *exact same* message text on
 * `.message` to keep those call sites working without modification —
 * the new `.code` / `.body` / `.httpStatus` / `.retryAfterMs` fields
 * are purely additive.
 */
export declare class ImportedTokenError extends Error {
    /** Short machine-readable category (e.g. "invalid_grant", "retry_after_exceeded"). */
    readonly code: string;
    /** Parsed AAD error body, if any. */
    readonly body: TokenEndpointResponse;
    /** HTTP status from the last attempted endpoint (0 for network failure). */
    readonly httpStatus: number;
    /** When AAD returned 429 + Retry-After, the parsed retry delay in ms. */
    readonly retryAfterMs?: number;
    constructor(code: string, message: string, body: TokenEndpointResponse, httpStatus: number, retryAfterMs?: number);
}
/**
 * Parse the `Retry-After` HTTP response header per RFC 7231 §7.1.3.
 * Accepts either a non-negative integer number of seconds OR an
 * HTTP-date (RFC 7231 §7.1.1.1). Returns milliseconds, or `null` if
 * the header is missing or unparseable.
 */
export declare function parseRetryAfterHeader(value: string | null): number | null;
/**
 * Exchange a refresh token for a new access token at AAD's token
 * endpoint.
 *
 * Tries the **v2** endpoint first (`/oauth2/v2.0/token`, `scope=`),
 * then falls back to **v1** (`/oauth2/token`, `resource=`) on
 * `AADSTS70000 / invalid_grant`. RTs minted by v1 endpoints (the
 * format `1.ATgA…` with `expires_on` / `resource` in their issuing
 * response) cannot always be redeemed at v2; the reverse holds too,
 * so trying both covers both shapes.
 *
 * Each endpoint is also tried via the dev-server's
 * `/api/auth/proxy-token` proxy when AAD's CORS pre-flight blocks the
 * direct browser POST.
 */
export declare function redeemRefreshToken(refreshToken: string, clientId: string, tenantId: string, scope: string): Promise<TokenEndpointResponse>;
/**
 * Make sure we have a usable access token for (homeAccountId, audience).
 * Returns the bearer string. Order of resolution:
 *
 *   1. A cached access token in the import store that's still inside
 *      its `exp` window.
 *   2. A stored refresh token: redeem at AAD's token endpoint, cache
 *      the new access token (and the rotated refresh token), return.
 *   3. null — caller falls back to MSAL.
 */
export declare function ensureImportedToken(homeAccountId: string, audience: AudienceBucket): Promise<string | null>;
/**
 * Pseudo-account row shape used by the Azure Accounts page. Same fields
 * as the `AzureLoginAccount` interface from store-types — kept loose
 * here so this module doesn't pull a dependency on the store types.
 */
export interface ImportedPseudoAccount {
    homeAccountId: string;
    localAccountId?: string;
    username: string;
    name: string;
    tenantId: string;
    environment: string;
    subscriptions: unknown[];
    subscriptionCount: number;
    status: "active";
    error: null;
    signedOut: false;
    addedAt: string;
}
/**
 * Return one pseudo-account row per imported principal, suitable for
 * merging into the displayed `azureAccounts` list. Tracks `addedAt`
 * across reloads via the earliest `importedAt` we have for that
 * principal so the row's first-seen timestamp stays stable.
 */
export declare function getImportedPseudoAccounts(): ImportedPseudoAccount[];
/**
 * Single PAT entry in the AzDO vault. We deliberately do NOT store
 * created-at / expires-at server fields because the operator pastes the
 * raw token string and we have no way to round-trip it to the DevOps
 * REST API for metadata without leaking the credential to a server we
 * don't control. The `addedAt` is purely client-side bookkeeping for
 * the UI's "imported X minutes ago" rendering.
 */
export interface ImportedAdoPat {
    /** Synthetic stable id (random per import — content-derived would
     *  leak the PAT prefix into URLs/audit logs). */
    id: string;
    /** Discriminator — lets future TS unions safely route on `kind`. */
    kind: "adoPat";
    /** Raw PAT bytes (NEVER log this — see audit log scrubbing below). */
    pat: string;
    /** Free-text owner label — e.g. the operator's DevOps org/user
     *  ("contoso-org/alice"). Used only for the UI; no validation. */
    owner: string;
    /** ms-epoch when the entry was imported into the vault. */
    addedAt: number;
}
/**
 * Validate that a pasted string looks like a DevOps PAT shape. AzDO
 * PATs are 52 chars of base64-like alphabet (alphanumeric only — no
 * `+ / =`). We don't reject anything outside that exact shape (newer
 * PATs may relax the length), but we tighten the regex enough to
 * reject obvious mistakes like accidentally pasting a JWT.
 */
export declare function isLikelyAdoPat(raw: string): boolean;
/**
 * Add a PAT to the vault. Replaces any existing entry whose `owner`
 * label matches (case-insensitive) so re-pasting against the same
 * owner overwrites rather than piling up. Returns the persisted entry.
 */
export declare function addAdoPat(opts: {
    pat: string;
    owner: string;
}): ImportedAdoPat;
/** Snapshot of every imported PAT (in import order). */
export declare function listAdoPats(): ImportedAdoPat[];
/** Remove a single PAT entry by its synthetic id. No-op if absent. */
export declare function removeAdoPat(id: string): void;
/** Wipe every PAT from the vault. */
export declare function clearAdoPats(): void;
/**
 * Encode a PAT into the AzDO-compatible Basic-auth header value. AzDO
 * expects a username of empty string and the PAT as the password —
 * `base64(":" + pat)` — prefixed with `Basic `.
 *
 * Returns the FULL header value (`Basic <base64>`), ready to drop into
 * a `fetch(url, { headers: { Authorization: header } })` call.
 *
 * Throws if the id is unknown so callers don't accidentally send a
 * `Basic ` header with an empty password (which AzDO answers 401 on but
 * the bug is harder to spot in a Network tab).
 */
export declare function getAdoPatAsBasicHeader(id: string): string;
export {};
//# sourceMappingURL=imported-tokens.d.ts.map