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
import { __awaiter } from "tslib";
import { decodeJwtClaimsUnsafe } from "./msal-auth";
import { parseRetryAfterHeader } from "./imported-tokens";
// Same constant as auth/msal-auth.ts's AZURE_CLI_CLIENT_ID. Duplicated here
// to keep this module's exports independent — msal-auth doesn't currently
// export it.
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
/** Same-origin path that the webpack dev-server forwards to login.microsoftonline.com. */
const TOKEN_PROXY_PATH = "/api/auth/proxy-token";
/** Default sleep used by pollDeviceCodeFlow. */
function defaultSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
            reject(makeAbortError());
            return;
        }
        const t = setTimeout(() => {
            if (signal)
                signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(makeAbortError());
        };
        signal === null || signal === void 0 ? void 0 : signal.addEventListener("abort", onAbort, { once: true });
    });
}
function makeAbortError() {
    // DOMException isn't reliably constructible in all runtimes; fall back to
    // a tagged Error so callers can detect via `.name === "AbortError"`.
    if (typeof DOMException !== "undefined") {
        try {
            return new DOMException("Device code flow cancelled", "AbortError");
        }
        catch (_a) {
            /* fall through */
        }
    }
    const e = new Error("Device code flow cancelled");
    e.name = "AbortError";
    return e;
}
/** True for AbortController.abort()-originated errors (any runtime). */
export function isAbortError(err) {
    return !!err && typeof err === "object" && err.name === "AbortError";
}
/**
 * Typed error thrown when AAD reports a terminal condition during polling.
 * `code` matches the AAD `error` field (`expired_token`, `access_denied`,
 * `authorization_declined`, `bad_verification_code`, …).
 */
export class DeviceCodeError extends Error {
    constructor(code, message) {
        super(message);
        Object.defineProperty(this, "code", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.name = "DeviceCodeError";
        this.code = code;
    }
}
/**
 * Build the proxied fetch for an AAD token-endpoint POST. AAD's actual URL
 * is sent via `x-proxy-target`; the dev-server forwards server-side.
 */
function proxiedPost(targetUrl, body, signal) {
    return __awaiter(this, void 0, void 0, function* () {
        return fetch(TOKEN_PROXY_PATH, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "x-proxy-target": targetUrl,
            },
            body: body.toString(),
            signal,
        });
    });
}
/**
 * Redact sensitive fields from a token-endpoint response before logging.
 * Keeps `error` / `error_description` / `error_codes` / `correlation_id`
 * visible — those are essential for troubleshooting and contain no secret.
 */
function redactForLog(body) {
    if (!body || typeof body !== "object")
        return {};
    const safe = {};
    const REDACT = new Set([
        "access_token",
        "refresh_token",
        "id_token",
        "device_code",
        "user_code",
    ]);
    for (const [k, v] of Object.entries(body)) {
        safe[k] = REDACT.has(k) ? "<redacted>" : v;
    }
    return safe;
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
export function startDeviceCodeFlow(opts) {
    var _a, _b, _c, _d, _e, _f, _g;
    return __awaiter(this, void 0, void 0, function* () {
        const tenant = ((_a = opts.tenantId) === null || _a === void 0 ? void 0 : _a.trim()) || "common";
        const clientId = ((_b = opts.clientId) === null || _b === void 0 ? void 0 : _b.trim()) || AZURE_CLI_CLIENT_ID;
        const scopes = opts.scopes && opts.scopes.length > 0
            ? opts.scopes
            : ["https://management.azure.com/.default", "offline_access", "openid", "profile"];
        const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`;
        const body = new URLSearchParams({
            client_id: clientId,
            scope: scopes.join(" "),
        });
        const resp = yield proxiedPost(url, body, opts.signal);
        let parsed = {};
        try {
            parsed = (yield resp.json());
        }
        catch (_h) {
            throw new Error(`Device code start: AAD returned non-JSON (HTTP ${resp.status}). Check the dev-server proxy is forwarding to login.microsoftonline.com.`);
        }
        if (!resp.ok || typeof parsed.device_code !== "string") {
            const errCode = String((_c = parsed.error) !== null && _c !== void 0 ? _c : "device_code_start_failed");
            const errDesc = String((_d = parsed.error_description) !== null && _d !== void 0 ? _d : `HTTP ${resp.status}`);
            // Sensitive fields scrubbed before logging.
            console.warn("[device-code] /devicecode failed", {
                status: resp.status,
                body: redactForLog(parsed),
            });
            throw new DeviceCodeError(errCode, errDesc);
        }
        const expiresIn = Number((_e = parsed.expires_in) !== null && _e !== void 0 ? _e : 900);
        const interval = Math.max(1, Number((_f = parsed.interval) !== null && _f !== void 0 ? _f : 5));
        return {
            user_code: String(parsed.user_code),
            verification_uri: String((_g = parsed.verification_uri) !== null && _g !== void 0 ? _g : "https://microsoft.com/devicelogin"),
            device_code: String(parsed.device_code),
            expires_at: Date.now() + expiresIn * 1000,
            interval,
            message: typeof parsed.message === "string" ? parsed.message : undefined,
            tenant,
            client_id: clientId,
        };
    });
}
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
export function pollDeviceCodeFlow(challenge, opts = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    return __awaiter(this, void 0, void 0, function* () {
        const tenant = ((_a = opts.tenantId) === null || _a === void 0 ? void 0 : _a.trim()) || challenge.tenant;
        const clientId = ((_b = opts.clientId) === null || _b === void 0 ? void 0 : _b.trim()) || challenge.client_id;
        const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
        const sleep = (_c = opts.sleepFn) !== null && _c !== void 0 ? _c : ((ms) => defaultSleep(ms, opts.signal));
        let interval = Math.max(1, challenge.interval);
        // Hard ceiling so a hostile AAD response can't push us into hour-long
        // sleeps. 60 s comfortably exceeds any sane slow_down ladder.
        const MAX_INTERVAL = 60;
        while (true) {
            if ((_d = opts.signal) === null || _d === void 0 ? void 0 : _d.aborted)
                throw makeAbortError();
            if (Date.now() >= challenge.expires_at) {
                throw new DeviceCodeError("expired_token", "Device code expired before sign-in completed. Click Try again to start over.");
            }
            yield sleep(interval * 1000);
            const body = new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                client_id: clientId,
                device_code: challenge.device_code,
            });
            let resp;
            try {
                resp = yield proxiedPost(url, body, opts.signal);
            }
            catch (err) {
                if (isAbortError(err))
                    throw err;
                // Transient network error — keep polling so a flaky connection
                // doesn't kill an in-progress sign-in. Log redacted.
                console.warn("[device-code] poll transport error — will retry", {
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }
            let parsed = {};
            try {
                parsed = (yield resp.json());
            }
            catch (_k) {
                console.warn("[device-code] /token non-JSON response", { status: resp.status });
                // Treat as a transient hiccup and keep polling.
                continue;
            }
            if (resp.ok && typeof parsed.access_token === "string") {
                const accessToken = parsed.access_token;
                // Tenant-binding check. AAD CAN return a token minted for a
                // DIFFERENT tenant than the operator selected — most commonly
                // when `tenant === "common"` and the user signs in with a
                // multi-tenant account, but ALSO when the operator typed an
                // explicit tenantId that resolved differently inside AAD. If
                // the requested tenant is a specific GUID and the token's
                // `tid` doesn't match, refuse — silently accepting a different
                // tenant's token leads to "I selected T1 but I'm seeing T2's
                // subscriptions" bugs that are very hard to debug.
                const claims = decodeJwtClaimsUnsafe(accessToken);
                const tokenTid = claims && typeof claims.tid === "string" ? claims.tid : null;
                const requestedTenant = (((_e = opts.tenantId) === null || _e === void 0 ? void 0 : _e.trim()) || challenge.tenant).toLowerCase();
                // "common" / "organizations" / "consumers" are AAD meta-tenants;
                // there's no concrete tid to compare against, so we accept
                // whatever AAD chose. Specific-tenant requests must match.
                const isMetaTenant = requestedTenant === "common" ||
                    requestedTenant === "organizations" ||
                    requestedTenant === "consumers";
                if (!isMetaTenant &&
                    tokenTid &&
                    tokenTid.toLowerCase() !== requestedTenant) {
                    console.warn("[device-code] tenant mismatch", {
                        requested: requestedTenant,
                        token: tokenTid,
                    });
                    throw new DeviceCodeError("tenant_mismatch", `Device-code flow returned a token for tenant ${tokenTid} but ` +
                        `the request asked for ${requestedTenant}. Refusing to accept ` +
                        `the cross-tenant token — sign in again from a session inside ` +
                        `the requested tenant.`);
                }
                return {
                    access_token: accessToken,
                    refresh_token: typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
                    id_token: typeof parsed.id_token === "string" ? parsed.id_token : undefined,
                    expires_in: Number((_f = parsed.expires_in) !== null && _f !== void 0 ? _f : 0),
                    scope: typeof parsed.scope === "string" ? parsed.scope : "",
                    claims,
                };
            }
            const errCode = String((_g = parsed.error) !== null && _g !== void 0 ? _g : "");
            const errDesc = String((_h = parsed.error_description) !== null && _h !== void 0 ? _h : `HTTP ${resp.status}`);
            // 429 / Retry-After honoring per RFC 8628 §3.5 and §3.4
            // (slow_down increments by 5 s; an explicit 429 + Retry-After
            // overrides that). Cap at 60 s so a hostile or mis-clocked AAD
            // response can't push us into multi-minute sleeps.
            if (resp.status === 429) {
                const retryMs = (_j = parseRetryAfterHeader(resp.headers.get("Retry-After"))) !== null && _j !== void 0 ? _j : 0;
                if (retryMs > 60000) {
                    throw new DeviceCodeError("retry_after_exceeded", `AAD asked for Retry-After=${Math.round(retryMs / 1000)}s which exceeds the 60s cap — refusing to block.`);
                }
                if (retryMs > 0) {
                    const retrySec = Math.ceil(retryMs / 1000);
                    interval = Math.min(MAX_INTERVAL, Math.max(interval, retrySec));
                }
                else {
                    interval = Math.min(MAX_INTERVAL, interval + 5);
                }
                continue;
            }
            if (errCode === "authorization_pending") {
                // Operator hasn't completed sign-in yet. Keep polling at the
                // current interval. RFC 8628 §3.5 — `authorization_pending` is
                // the canonical "keep polling" signal.
                continue;
            }
            if (errCode === "interaction_required") {
                // Per OAuth 2.0 / OIDC spec, `interaction_required` means AAD
                // CANNOT complete the flow without further user interaction
                // (e.g. MFA, conditional access, consent). That is NOT a
                // continue-polling condition — AAD will keep returning it until
                // the operator restarts the flow. Surface as a terminal error.
                throw new DeviceCodeError("interaction_required", "AAD requires further user interaction (MFA / conditional access / consent). Restart sign-in.");
            }
            if (errCode === "slow_down") {
                interval = Math.min(MAX_INTERVAL, interval + 5);
                continue;
            }
            if (errCode === "expired_token" || errCode === "code_expired") {
                throw new DeviceCodeError("expired_token", "Device code expired before sign-in completed. Click Try again to start over.");
            }
            if (errCode === "access_denied" || errCode === "authorization_declined") {
                throw new DeviceCodeError("access_denied", "Sign-in was declined at the verification page.");
            }
            if (errCode === "bad_verification_code") {
                throw new DeviceCodeError("bad_verification_code", "AAD rejected the device code. This shouldn't happen mid-flow — please try again.");
            }
            // Unknown error — log redacted then bubble up.
            console.warn("[device-code] /token unexpected error", {
                status: resp.status,
                body: redactForLog(parsed),
            });
            throw new DeviceCodeError(errCode || "unknown_error", errDesc);
        }
    });
}
//# sourceMappingURL=device-code-login.js.map