/**
 * FOCI (Family of Client IDs) refresh-token exchange service.
 *
 * ============================================================================
 * What ROADtools does
 * ============================================================================
 * ROADtools (dirkjanm/ROADtools) is a red-team / blue-team toolkit for
 * exploring Microsoft Entra ID. One of its core primitives — implemented in
 * `roadlib/roadtools/roadlib/auth.py` and `constants.py` (look for
 * `WELLKNOWN_CLIENTS`) — is the ability to take a refresh token issued to
 * one Microsoft first-party public client (say, Azure CLI) and POST it back
 * to AAD's token endpoint with a DIFFERENT `client_id` (say, Microsoft Graph
 * PowerShell or the Azure Portal SPA). AAD honours the request without any
 * additional consent prompt because the source and target client are both
 * members of the "Family of Client IDs" (FOCI) — a group of first-party
 * Microsoft apps that explicitly share refresh-token material.
 *
 * The canonical list of FOCI clients is curated by Secureworks at
 *   https://github.com/secureworks/family-of-client-ids-research
 * (file: `known-foci-clients.csv`). ROADtools maintains its own
 * `WELLKNOWN_CLIENTS` alias map for convenience, but the FOCI-eligibility
 * fact comes from the Secureworks research repo.
 *
 * ============================================================================
 * What we adopt
 * ============================================================================
 * 1. **The list itself** — `FOCI_CLIENTS` below mirrors the Secureworks CSV
 *    plus the ROADtools alias map, deduplicated by client id.
 * 2. **The exchange primitive** — `exchangeRefreshTokenForClient` posts to
 *    `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with
 *    `grant_type=refresh_token`, the operator-chosen TARGET `client_id`, the
 *    source-client's refresh token, and a `scope` string. AAD mints an
 *    access token (and optionally a rotated refresh token) for the target.
 * 3. **Source-client detection** — `detectFociEligibility` inspects the
 *    `azp` / `appid` claim on an existing access token, looks it up in
 *    `FOCI_CLIENTS`, and tells the UI whether the refresh-token-twin sitting
 *    behind that access token can be exchanged at all.
 *
 * ============================================================================
 * What we deliberately do NOT do (and why)
 * ============================================================================
 * - **No directory dump / RoadRecon-style enumeration.** ROADtools' headline
 *   feature is bulk-pulling every user, group, app reg, conditional-access
 *   policy, role assignment, etc. via Graph and the AAD internal API. That's
 *   a recon-and-attack workflow; this WebUI's job is operator-friendly Azure
 *   Batch management, so we expose the token primitive (operators may have
 *   legitimate reasons — e.g. swapping from a CA-blocked Portal client to
 *   Azure CLI which their CA policy exempts) but stop short of the recon.
 * - **No primary-refresh-token (PRT) cookie minting.** ROADtools `roadtx`
 *   can mint PRT cookies from device certificates; that requires a registered
 *   device (`urn:ietf:params:oauth:grant-type:jwt-bearer` with a TPM-bound
 *   `cert`). Out of scope for a browser SPA, and the operator should use
 *   roadtx directly if they need it.
 * - **No device-code or device-registration flow.** Those need OS-level
 *   keystore access (Windows TPM / macOS keychain). Out of scope here.
 * - **No silent passthrough.** Every exchange surfaces in the audit log
 *   (action: `foci_exchange`) so operators can reconstruct what they minted.
 *
 * ============================================================================
 * Test surface
 * ============================================================================
 * All exports accept a `fetchImpl` argument that defaults to
 * `globalThis.fetch`, so unit tests can pass a stub. Non-2xx responses are
 * surfaced as `FociExchangeError` carrying the parsed `{ error,
 * error_description, error_codes }` body for diagnostic UIs.
 */
/** Single FOCI client entry. `description` is the short label the UI shows. */
export interface FociClient {
    /** Human-friendly name, e.g. "Microsoft Azure CLI". */
    readonly name: string;
    /** AAD app registration id (a GUID). */
    readonly clientId: string;
    /** One-line description of what the app actually is / where it runs. */
    readonly description?: string;
    /**
     * Optional default scope that operators usually want when minting for this
     * target — null if the choice depends on caller intent (most clients).
     */
    readonly defaultScope?: string;
    /**
     * **True** when the client is a verified member of the Microsoft FOCI
     * family (its refresh tokens can be exchanged for any other FOCI
     * member's audience). **False** when it's a 1P public client that AAD
     * recognises but does NOT include in the family — those can still be
     * used for device-code / interactive flows from this WebUI, but
     * `exchangeRefreshTokenForClient` against them returns
     * `AADSTS54005 / invalid_grant`.
     *
     * Source: secureworks/family-of-client-ids-research/known-foci-clients.csv
     * for the `true` rows. Anything we list here for completeness but is
     * NOT in that CSV gets `false` — the UI gates the Exchange button on
     * this flag so we don't surprise the operator with a guaranteed-to-fail
     * round-trip.
     */
    readonly isFoci: boolean;
}
/**
 * Default scope map for the "Find FOCI clients that grant a scope"
 * reverse-lookup card. The exhaustive truth is the AAD app
 * registration's published `requiredResourceAccess` block — but those
 * blocks are 1P-internal and not enumerable from a browser context.
 *
 * The mapping below is BEST-EFFORT, hand-curated from public Microsoft
 * documentation (docs.microsoft.com graph permissions reference + the
 * ROADtools `roadtx describe` enumerations + Microsoft 365 admin role
 * permission docs). Anything we don't have data for renders as
 * "(unknown)" in the UI — that's deliberate, the alternative is
 * fabricating coverage that doesn't exist.
 *
 * Scope names use the SHORT Graph permission name (e.g. "User.Read")
 * rather than the full URI ("https://graph.microsoft.com/User.Read")
 * because operators paste the short name. The lookup function
 * normalises both sides.
 */
export declare const FOCI_CLIENT_DEFAULT_SCOPES: Readonly<Record<string, ReadonlyArray<string>>>;
/**
 * Canonical FOCI client list — every entry where `isFoci: true` was
 * verified in `secureworks/family-of-client-ids-research/known-foci-clients.csv`
 * to be a Microsoft first-party public client whose refresh tokens are
 * family-shared. Entries with `isFoci: false` are 1P clients that AAD
 * recognises but that are NOT in the FOCI family — useful targets for
 * device-code flows from this WebUI, but `exchangeRefreshTokenForClient`
 * against them returns `AADSTS54005`.
 *
 * Order matters for the UI grid (Azure CLI, Azure PowerShell, Azure
 * Portal, Visual Studio appear first), so we keep the canonical
 * ordering rather than alphabetising.
 *
 * SOURCES (and the bar for inclusion):
 *   - Secureworks family-of-client-ids-research
 *     https://github.com/secureworks/family-of-client-ids-research
 *     `known-foci-clients.csv` is the ground truth for every
 *     `isFoci: true` row.
 *   - MSAL public docs / GitHub samples
 *     https://github.com/AzureAD/microsoft-authentication-library-for-dotnet/wiki
 *     publish well-known public-client GUIDs for the canonical FOCI
 *     families: Office (d3590ed6-…), Visual Studio (872cd9fa-… /
 *     aebc6443-…), Azure CLI (04b07795-…), Azure PowerShell
 *     (1950a258-…), Outlook (5d661950-… / 27922004-…), Teams
 *     (1fec8e78-…), OneDrive (ab9b8c07-…).
 *   - Microsoft Learn docs for AzDO / ARM / Graph / Batch resource
 *     server ids (the `*-aud-only*` rows, kept for diagnostic
 *     classification of incoming tokens).
 *
 * 2026-05-25 cleanup: stripped every row whose `clientId` was an
 * obvious placeholder GUID (sequences like `1b3c1234-5678-90ab-…`,
 * `11111111-…-555555555555`, repeated `3e3e3e3e3e3e` segments, or
 * `fbcf1c7f-…` / `fb6c0e3c-…` / `fc7c0e3c-…`-style filler that does
 * not appear in any of the sources above). The previous list had ~30
 * such rows that would have surfaced as "client id" entries in the
 * UI's reverse lookup; surfacing fabricated GUIDs is worse than
 * surfacing none. Keep ONLY verifiable client IDs.
 *
 * Frozen at module-load so callers can't accidentally mutate a shared list.
 */
export declare const FOCI_CLIENTS: ReadonlyArray<FociClient>;
/**
 * Find a FOCI client by its AAD app id. Returns `undefined` if the id is
 * not in our curated FOCI list — useful for "Is this token's `azp` claim
 * a FOCI member?" checks.
 */
export declare function getFociClientByAppId(appId: string): FociClient | undefined;
/**
 * Inspect a decoded JWT claim object for FOCI eligibility. Reads `azp` first
 * (RFC-correct authorised-party), falls back to `appid` (older AAD tokens).
 *
 * - `eligible: true`  → the source client IS in our FOCI list AND its
 *   `isFoci` flag is true, so its refresh token CAN be exchanged for
 *   any other FOCI target.
 * - `eligible: false` → either the source client is NOT in our list at
 *   all, OR it's a 1P client we recognise but that is NOT a FOCI
 *   family member (`isFoci: false`). Exchange to a different client id
 *   will fail with `AADSTS54005 / invalid_grant`. The operator should
 *   re-authenticate against a known FOCI client (Azure CLI is the
 *   easiest) or use the device-code flow for non-FOCI clients.
 *
 * When the source client is recognised but is non-FOCI, we still
 * return its `FociClient` row in `sourceClient` so the UI can render a
 * friendly "X is not in the FOCI family — use device-code instead"
 * message instead of an opaque "unknown client" warning.
 *
 * Note: AAD's FOCI eligibility is server-side and can change without notice.
 * This is a heuristic — a `true` result is best-effort; AAD always has the
 * last word at exchange time.
 */
export declare function detectFociEligibility(claims: Record<string, unknown> | null | undefined): {
    eligible: boolean;
    sourceClient?: FociClient;
};
/** Successful exchange result. */
export interface FociExchangeResult {
    /** Newly-minted access token (bearer). */
    access_token: string;
    /**
     * Rotated refresh token. AAD usually returns one — but not always. When
     * absent, the operator's existing RT remains valid.
     */
    refresh_token?: string;
    /** Seconds until the new access token expires. */
    expires_in: number;
    /** Granted scope (may differ from the requested scope). */
    scope: string;
    /** Raw `aud` claim from the new access token. */
    audience: string;
    /** Decoded claim payload of the new access token. */
    claims: Record<string, unknown>;
}
/** Error shape AAD returns for failed exchanges. */
export interface FociExchangeErrorBody {
    error?: string;
    error_description?: string;
    error_codes?: number[];
    timestamp?: string;
    trace_id?: string;
    correlation_id?: string;
}
/** Thrown when AAD rejects the exchange or the network blows up. */
export declare class FociExchangeError extends Error {
    readonly body: FociExchangeErrorBody;
    readonly httpStatus: number;
    constructor(message: string, body: FociExchangeErrorBody, httpStatus: number);
}
/** Argument shape for `exchangeRefreshTokenForClient`. */
export interface ExchangeOptions {
    /** Source-client refresh token to spend. */
    refreshToken: string;
    /** Target FOCI client id to mint for. */
    targetClientId: string;
    /** AAD tenant id where redemption happens. */
    tenantId: string;
    /**
     * Requested scope. Use one of the well-known `*.default` scopes for
     * full app-permission tokens (e.g. `https://management.azure.com/.default`).
     */
    scope: string;
    /** Optional fetch implementation. Defaults to `globalThis.fetch`. */
    fetchImpl?: typeof fetch;
}
/**
 * Exchange a refresh token issued to one FOCI client for an access token
 * minted for a DIFFERENT FOCI client. This is the FOCI primitive.
 *
 * Workflow:
 *   1. POST to AAD's v2 token endpoint with `grant_type=refresh_token`,
 *      `client_id={target}`, the operator's RT, and the requested scope.
 *   2. AAD validates the RT, checks family membership of the target client
 *      id, mints a fresh access token (and usually rotates the RT).
 *   3. We decode the resulting JWT and surface its `aud` claim alongside
 *      the parsed claim payload so the caller can verify the new token's
 *      audience matches what they asked for.
 *
 * On failure, throws `FociExchangeError` carrying the parsed body. The body
 * usually contains `error` ("invalid_grant" / "unauthorized_client" /
 * "invalid_request" / "interaction_required") plus a human-readable
 * `error_description` with the AAD `AADSTS####` code embedded.
 *
 * Network/CORS failures are converted to `FociExchangeError` with
 * `httpStatus: 0` so callers don't need a separate try/catch.
 */
export declare function exchangeRefreshTokenForClient(opts: ExchangeOptions): Promise<FociExchangeResult>;
//# sourceMappingURL=foci-exchange.d.ts.map