/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for Azure AD.
 *
 * Lets the operator complete sign-in on a different device — useful when:
 *   - The browser blocks popups for this origin.
 *   - We're embedded in a webview that won't open external windows.
 *   - The host is headless / has no browser at all.
 *
 * Flow:
 *   1. POST /oauth2/v2.0/devicecode  →  { device_code, user_code, verification_uri, expires_in, interval }
 *   2. Show the user_code + verification_uri to the operator on this device.
 *   3. POST /oauth2/v2.0/token (grant_type=urn:ietf:params:oauth:grant-type:device_code)
 *      every `interval` seconds. Repeat while AAD answers `authorization_pending`.
 *   4. On `slow_down`: bump the interval by 5 s per RFC 8628 §3.5.
 *   5. On success: return access_token (+ refresh_token + id_token if scopes asked for them).
 *
 * CORS NOTE — AAD's /devicecode and /token endpoints do NOT serve CORS headers
 * for direct browser POSTs. Every fetch in this module goes through the
 * dev-server's `/api/auth/proxy-token` middleware (see web/webpack.config.js
 * `devServer.setupMiddlewares`), which forwards server-side using the
 * `x-proxy-target` header. This mirrors how `auth/msal-auth.ts`'s
 * `msalNetworkClient.sendPostRequestAsync` routes its MSAL token POSTs.
 *
 * Sensitive data discipline:
 *   - `device_code`, `access_token`, `refresh_token`, `id_token` are NEVER
 *     written to console.log / console.error. Errors are logged with payload
 *     fields redacted to `<redacted>`.
 *   - The returned `claims` field is decoded from the access_token only for
 *     UPN / oid / tid display in the dialog — same `decodeJwtClaimsUnsafe`
 *     helper that msal-auth uses.
 *
 * Default client_id:
 *   Azure CLI (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`). This is a well-known
 *   first-party PUBLIC client that is FOCI-eligible — any refresh token it
 *   mints can be redeemed at AAD's token endpoint for any other FOCI client
 *   without prompting the user again. That matters for the wider
 *   refresh-token / FOCI work in this codebase: an operator who signs in via
 *   device code with the CLI client ends up with an RT that the imported-
 *   tokens vault can later exchange for ARM / Graph / Batch tokens.
 */
/**
 * Shape of the AAD /devicecode response (RFC 8628 + Microsoft extensions).
 * `expires_at` is computed by us (Unix-epoch ms) so the UI can drive a
 * countdown without re-parsing `expires_in` every tick.
 */
export interface DeviceCodeChallenge {
    /** Short code the operator types at verification_uri. e.g. "BHVN6QJVP". */
    user_code: string;
    /** URL the operator visits — typically https://microsoft.com/devicelogin. */
    verification_uri: string;
    /** Long opaque code we send back at /token while polling. SENSITIVE. */
    device_code: string;
    /** Unix-epoch milliseconds when the device_code stops working. */
    expires_at: number;
    /** Seconds between consecutive /token polls. May be bumped on slow_down. */
    interval: number;
    /** AAD-provided human-readable instructions (may include localisation). */
    message?: string;
    /** Tenant the challenge was issued for. Echoed in the polling URL. */
    tenant: string;
    /** Client id the challenge was issued for. Echoed in the polling body. */
    client_id: string;
}
/**
 * Decoded shape of a successful AAD token response. `claims` is decoded from
 * `access_token` for diagnostic display only — never trust these for
 * authorization, they're unsigned-parsed.
 */
export interface TokenResult {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
    scope: string;
    /** Decoded payload of `access_token`. Never used for authz. */
    claims: Record<string, unknown> | null;
}
export interface StartOptions {
    tenantId?: string;
    clientId?: string;
    scopes: string[];
    signal?: AbortSignal;
}
export interface PollOptions {
    tenantId?: string;
    clientId?: string;
    signal?: AbortSignal;
    /** Test-only override — bypasses setTimeout so jest fakes aren't needed. */
    sleepFn?: (ms: number) => Promise<void>;
}
/** True for AbortController.abort()-originated errors (any runtime). */
export declare function isAbortError(err: unknown): boolean;
/**
 * Typed error thrown when AAD reports a terminal condition during polling.
 * `code` matches the AAD `error` field (`expired_token`, `access_denied`,
 * `authorization_declined`, `bad_verification_code`, …).
 */
export declare class DeviceCodeError extends Error {
    code: string;
    constructor(code: string, message: string);
}
/**
 * Kick off the device code grant. Returns the challenge the UI needs to
 * display to the operator. Caller is then expected to invoke
 * `pollDeviceCodeFlow` with the returned challenge.
 *
 * Throws on transport errors and on AAD non-2xx responses to the
 * /devicecode endpoint (e.g. invalid_client when the client_id isn't a
 * public app, or unauthorized_client when device code grant isn't enabled
 * for that AAD tenant).
 */
export declare function startDeviceCodeFlow(opts: StartOptions): Promise<DeviceCodeChallenge>;
/**
 * Poll the AAD /token endpoint at `challenge.interval` seconds until the
 * operator completes sign-in. Returns the tokens on success.
 *
 * Behaviour per RFC 8628 §3.5:
 *   - `authorization_pending` → keep polling at the current interval.
 *   - `slow_down`             → increase the interval by 5 s, keep polling.
 *   - `expired_token` / `code_expired` → throw DeviceCodeError("expired_token").
 *   - `access_denied` / `authorization_declined` → throw DeviceCodeError("access_denied").
 *   - `bad_verification_code` → throw (server-side rejected our device_code).
 *   - any other error → throw with that error code.
 *
 * Respects AbortSignal: if cancelled during a sleep or in-flight fetch the
 * promise rejects with an AbortError synchronously.
 */
export declare function pollDeviceCodeFlow(challenge: DeviceCodeChallenge, opts?: PollOptions): Promise<TokenResult>;
//# sourceMappingURL=device-code-login.d.ts.map