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
import { __awaiter } from "tslib";
// AUDIT-LOG BINDING. The auth pod records sensitive operations (token
// redemption, vault add/remove, etc.) through `recordAuditEvent`. The
// REAL logger is wired in via `setAuditLogger` from
// `auth/audit-binding.ts` — until that happens at boot, calls go to a
// silent no-op. See `auth/audit-binding.ts` for the binding contract.
import { recordAuditEvent } from "./audit-binding";
const STORAGE_KEY = "azbm.imported-tokens.v1";
const RT_STORAGE_KEY = "azbm.imported-refresh-tokens.v1";
/**
 * Public list of every localStorage / sessionStorage key this module
 * owns. Consumed by `msal-auth.ts:logout()` so a sign-out targets only
 * keys we know belong to us, instead of doing a blanket
 * `localStorage.clear()` that would wipe unrelated app state.
 */
export const IMPORTED_TOKEN_STORAGE_KEYS = Object.freeze([
    STORAGE_KEY,
    RT_STORAGE_KEY,
    // ADO PAT key is declared below — listed here so callers have ONE
    // source of truth for "what does this module write to storage?".
    "azbm.imported-tokens.ado-pats.v1",
]);
/**
 * sessionStorage key for the Azure DevOps PAT lane. Deliberately a
 * **separate** key from the Bearer-token vault so the two storage
 * buckets cannot collide on read/write and so the PAT bucket can be
 * wiped without touching imported access/refresh tokens.
 *
 * Why sessionStorage instead of localStorage: PATs are full DevOps
 * credentials with the same blast-radius as the user's password. We
 * deliberately scope them to the current browser session so closing the
 * tab drops them — the operator re-pastes when they come back.
 */
const ADO_PAT_STORAGE_KEY = "azbm.imported-tokens.ado-pats.v1";
// In-memory fallback when localStorage is unavailable.
let memoryStore = [];
function readAll() {
    if (typeof window === "undefined")
        return memoryStore.slice();
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed;
    }
    catch (_a) {
        return memoryStore.slice();
    }
}
function writeAll(entries) {
    memoryStore = entries.slice();
    if (typeof window === "undefined")
        return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
    catch (_a) {
        /* localStorage may be unavailable — already cached in memory. */
    }
}
/**
 * Decode a JWT payload WITHOUT signature verification. Identical
 * algorithm to msal-auth's `decodeJwtClaimsUnsafe` — duplicated here to
 * keep this module dependency-free of the MSAL surface.
 */
export function decodeJwtPayload(jwt) {
    try {
        const parts = jwt.split(".");
        if (parts.length < 2)
            return null;
        const payload = parts[1];
        const padded = payload.replace(/-/g, "+").replace(/_/g, "/") +
            "===".slice((payload.length + 3) % 4);
        const json = typeof atob === "function"
            ? atob(padded)
            : Buffer.from(padded, "base64").toString("utf-8");
        return JSON.parse(json);
    }
    catch (_a) {
        return null;
    }
}
/**
 * The well-known AAD app id of the Azure DevOps resource server. Tokens
 * minted for AzDO carry this guid as their `aud` claim (or the guid
 * followed by a scope path, e.g. `<guid>/user_impersonation`).
 *
 * Source: docs.microsoft.com/azure/devops/integrate/get-started/authentication/oauth
 * — Microsoft has published this as `499b84ac-1321-427f-aa17-267ca6975798`
 * for both Azure DevOps Services and Visual Studio Codespaces.
 */
const DEVOPS_AAD_APP_ID = "499b84ac-1321-427f-aa17-267ca6975798";
/** Map a raw `aud` claim onto one of our canonical buckets. */
export function classifyAudience(rawAud) {
    const a = (rawAud !== null && rawAud !== void 0 ? rawAud : "").toLowerCase();
    if (a.includes("management.azure.com") ||
        a.includes("management.core.windows.net") ||
        // ARM AAD app id.
        a === "797f4846-ba00-4fd7-ba43-dac1f8f63013") {
        return "arm";
    }
    if (a.includes("graph.microsoft.com") ||
        // MS Graph AAD app id.
        a === "00000003-0000-0000-c000-000000000000") {
        return "graph";
    }
    if (a.includes("batch.core.windows.net") ||
        a === "ddbf3205-c6bd-46ae-8127-60eb93363864") {
        return "batch";
    }
    // Azure DevOps. The aud claim shows up in three shapes:
    //   1. Bare guid:  "499b84ac-1321-427f-aa17-267ca6975798"
    //   2. Guid + scope: "499b84ac-1321-427f-aa17-267ca6975798/user_impersonation"
    //   3. Resource URL form: "https://app.vssps.visualstudio.com" or
    //      "https://dev.azure.com" (legacy v1-endpoint tokens).
    if (a === DEVOPS_AAD_APP_ID ||
        a.startsWith(`${DEVOPS_AAD_APP_ID}/`) ||
        a.includes("dev.azure.com") ||
        a.includes("app.vssps.visualstudio.com") ||
        a.includes("vsspsext.visualstudio.com")) {
        return "devops";
    }
    return "unknown";
}
/** Map a scope URI (as msal-auth passes around) to our audience bucket. */
export function scopeToAudience(scope) {
    const s = scope.toLowerCase();
    if (s.includes("management.azure.com"))
        return "arm";
    if (s.includes("graph.microsoft.com"))
        return "graph";
    if (s.includes("batch.core.windows.net"))
        return "batch";
    if (s.includes(DEVOPS_AAD_APP_ID) ||
        s.includes("dev.azure.com") ||
        s.includes("app.vssps.visualstudio.com")) {
        return "devops";
    }
    return "unknown";
}
/**
 * Validate + decode a pasted JWT. Returns null on malformed input. Does
 * NOT store anything — caller decides whether to commit.
 */
export function previewToken(jwt) {
    var _a, _b, _c, _d, _e, _f, _g;
    const trimmed = jwt.trim();
    if (!trimmed)
        return null;
    // Tolerate "Bearer <jwt>" pastes.
    const t = trimmed.replace(/^Bearer\s+/i, "");
    const claims = decodeJwtPayload(t);
    if (!claims)
        return null;
    const oid = String((_b = (_a = claims.oid) !== null && _a !== void 0 ? _a : claims.sub) !== null && _b !== void 0 ? _b : "");
    const tid = String((_c = claims.tid) !== null && _c !== void 0 ? _c : "");
    if (!oid || !tid)
        return null;
    const rawAud = String((_d = claims.aud) !== null && _d !== void 0 ? _d : "");
    const exp = Number((_e = claims.exp) !== null && _e !== void 0 ? _e : 0);
    const upn = (_g = (_f = claims.preferred_username) !== null && _f !== void 0 ? _f : claims.upn) !== null && _g !== void 0 ? _g : claims.unique_name;
    const name = claims.name;
    return {
        jwt: t,
        homeAccountId: `${oid}.${tid}`,
        tenantId: tid,
        oid,
        upn,
        name,
        audience: classifyAudience(rawAud),
        rawAudience: rawAud,
        expiresAt: exp,
        claims,
    };
}
/**
 * Commit a previewed token into the local store. If a token with the
 * same (homeAccountId, audience) already exists, it's replaced.
 */
export function importToken(preview) {
    const entry = {
        homeAccountId: preview.homeAccountId,
        tenantId: preview.tenantId,
        oid: preview.oid,
        upn: preview.upn,
        name: preview.name,
        audience: preview.audience,
        rawAudience: preview.rawAudience,
        accessToken: preview.jwt,
        expiresAt: preview.expiresAt,
        importedAt: new Date().toISOString(),
    };
    const all = readAll();
    const filtered = all.filter((e) => !(e.homeAccountId === entry.homeAccountId &&
        e.audience === entry.audience));
    filtered.push(entry);
    writeAll(filtered);
    return entry;
}
/**
 * Look up an imported token by (homeAccountId, audience). Returns the
 * raw JWT string if present and unexpired. Expired entries are
 * automatically purged so the caller never gets a stale token by
 * accident.
 */
export function getImportedToken(homeAccountId, audience) {
    const all = readAll();
    const now = Math.floor(Date.now() / 1000);
    let mutated = false;
    const filtered = [];
    let hit = null;
    for (const e of all) {
        if (e.expiresAt > 0 && e.expiresAt < now) {
            mutated = true; // drop expired
            continue;
        }
        filtered.push(e);
        if (e.homeAccountId === homeAccountId && e.audience === audience) {
            hit = e.accessToken;
        }
    }
    if (mutated)
        writeAll(filtered);
    return hit;
}
/** Return every currently-stored token (expired entries auto-purged). */
export function listImportedTokens() {
    const now = Math.floor(Date.now() / 1000);
    const all = readAll();
    const live = all.filter((e) => e.expiresAt === 0 || e.expiresAt >= now);
    if (live.length !== all.length)
        writeAll(live);
    return live.slice();
}
export function listImportedAccounts() {
    const tokens = listImportedTokens();
    const byAccount = new Map();
    for (const t of tokens) {
        const existing = byAccount.get(t.homeAccountId);
        if (existing) {
            if (!existing.audiences.includes(t.audience)) {
                existing.audiences.push(t.audience);
            }
            if (t.expiresAt > 0 &&
                (existing.earliestExpiresAt === 0 ||
                    t.expiresAt < existing.earliestExpiresAt)) {
                existing.earliestExpiresAt = t.expiresAt;
            }
        }
        else {
            byAccount.set(t.homeAccountId, {
                homeAccountId: t.homeAccountId,
                tenantId: t.tenantId,
                oid: t.oid,
                upn: t.upn,
                name: t.name,
                audiences: [t.audience],
                earliestExpiresAt: t.expiresAt,
            });
        }
    }
    return Array.from(byAccount.values());
}
/** Drop every token (access + refresh) for a single homeAccountId. */
export function removeImportedAccount(homeAccountId) {
    const all = readAll();
    writeAll(all.filter((e) => e.homeAccountId !== homeAccountId));
    removeRefreshToken(homeAccountId);
}
/** Drop a single audience entry for a homeAccountId. */
export function removeImportedAudience(homeAccountId, audience) {
    const all = readAll();
    writeAll(all.filter((e) => !(e.homeAccountId === homeAccountId && e.audience === audience)));
}
/** Wipe every imported token from storage. */
export function clearImportedTokens() {
    writeAll([]);
    writeAllRefreshTokens([]);
}
let rtMemoryStore = [];
function readAllRefreshTokens() {
    if (typeof window === "undefined")
        return rtMemoryStore.slice();
    try {
        const raw = window.localStorage.getItem(RT_STORAGE_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (_a) {
        return rtMemoryStore.slice();
    }
}
function writeAllRefreshTokens(entries) {
    rtMemoryStore = entries.slice();
    if (typeof window === "undefined")
        return;
    try {
        window.localStorage.setItem(RT_STORAGE_KEY, JSON.stringify(entries));
    }
    catch (_a) {
        /* ignore */
    }
}
/** Store (or replace) a refresh token + the client id that issued it. */
export function importRefreshToken(entry) {
    var _a;
    const finalEntry = Object.assign(Object.assign({}, entry), { importedAt: (_a = entry.importedAt) !== null && _a !== void 0 ? _a : new Date().toISOString() });
    const all = readAllRefreshTokens();
    const filtered = all.filter((r) => r.homeAccountId !== finalEntry.homeAccountId);
    filtered.push(finalEntry);
    writeAllRefreshTokens(filtered);
    return finalEntry;
}
/** Look up the refresh-token row for a principal, if any. */
export function getRefreshTokenEntry(homeAccountId) {
    var _a;
    return ((_a = readAllRefreshTokens().find((r) => r.homeAccountId === homeAccountId)) !== null && _a !== void 0 ? _a : null);
}
/** Public read for the UI listing. */
export function listRefreshTokenEntries() {
    return readAllRefreshTokens().slice();
}
/** Drop a refresh token by principal. */
export function removeRefreshToken(homeAccountId) {
    writeAllRefreshTokens(readAllRefreshTokens().filter((r) => r.homeAccountId !== homeAccountId));
}
/** Canonical scope strings used by the rest of the app. */
export const SCOPE_FOR_AUDIENCE = {
    arm: "https://management.azure.com/.default",
    graph: "https://graph.microsoft.com/.default",
    batch: "https://batch.core.windows.net/.default",
    // AzDO accepts the bare AAD app id with /.default at the v2 token
    // endpoint. AAD then mints a token whose aud is the same guid.
    devops: `${DEVOPS_AAD_APP_ID}/.default`,
    unknown: "",
};
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
export class ImportedTokenError extends Error {
    constructor(code, message, body, httpStatus, retryAfterMs) {
        super(message);
        /** Short machine-readable category (e.g. "invalid_grant", "retry_after_exceeded"). */
        Object.defineProperty(this, "code", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        /** Parsed AAD error body, if any. */
        Object.defineProperty(this, "body", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        /** HTTP status from the last attempted endpoint (0 for network failure). */
        Object.defineProperty(this, "httpStatus", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        /** When AAD returned 429 + Retry-After, the parsed retry delay in ms. */
        Object.defineProperty(this, "retryAfterMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.name = "ImportedTokenError";
        this.code = code;
        this.body = body;
        this.httpStatus = httpStatus;
        if (typeof retryAfterMs === "number")
            this.retryAfterMs = retryAfterMs;
    }
}
/**
 * Cap the parsed Retry-After delay at 60 s so a hostile / mis-clocked
 * AAD response can't push us into multi-minute sleeps. Callers that
 * see `RETRY_AFTER_CAP_MS` exceeded surface as a typed
 * `retry_after_exceeded` error rather than blocking the operator.
 */
const RETRY_AFTER_CAP_MS = 60000;
/**
 * Parse the `Retry-After` HTTP response header per RFC 7231 §7.1.3.
 * Accepts either a non-negative integer number of seconds OR an
 * HTTP-date (RFC 7231 §7.1.1.1). Returns milliseconds, or `null` if
 * the header is missing or unparseable.
 */
export function parseRetryAfterHeader(value) {
    if (!value)
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    // delta-seconds form.
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const seconds = Number(trimmed);
        if (Number.isFinite(seconds) && seconds >= 0)
            return Math.round(seconds * 1000);
        return null;
    }
    // HTTP-date form.
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed))
        return null;
    const delta = parsed - Date.now();
    return delta > 0 ? delta : 0;
}
/**
 * Convert a v2 `.default`-style scope to the v1 `resource` form by
 * stripping the trailing `/.default`. v1 endpoint accepts the URI as
 * `resource=...`. For non-`.default` scopes we return the input
 * unchanged — the v1 endpoint will reject and we surface the error.
 */
function scopeToResource(scope) {
    return scope.replace(/\/\.default$/, "");
}
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
export function redeemRefreshToken(refreshToken, clientId, tenantId, scope) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    return __awaiter(this, void 0, void 0, function* () {
        // Sanitise the RT — AAD rejects with AADSTS70000 ("provided grant is
        // invalid or malformed") when ANY whitespace or control character
        // appears inside the token string. Copy-paste from a DevTools
        // console often introduces \n / spaces around the value or inside it
        // (line wraps in the console output).
        const cleanRt = refreshToken.replace(/[\s​-‍﻿]/g, "");
        const v2Url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
        const v1Url = `https://login.microsoftonline.com/${tenantId}/oauth2/token`;
        const v2Body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: cleanRt,
            client_id: clientId,
            scope,
        }).toString();
        const v1Body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: cleanRt,
            client_id: clientId,
            resource: scopeToResource(scope),
        }).toString();
        /**
         * Single attempt: try AAD direct, then proxy on CORS / network
         * failure. Returns either a successful TokenEndpointResponse or a
         * rejected one (so the caller can decide whether to retry with the
         * other endpoint).
         *
         * Proxy fallback MUST forward via the `x-proxy-target` header so the
         * dev-server's `/api/auth/proxy-token` (webpack.config.js ~line 255)
         * knows which AAD endpoint to relay to. Previously this header was
         * missing and the dev-server returned 400 ("Invalid proxy target").
         */
        function attemptOnce(url, body) {
            return __awaiter(this, void 0, void 0, function* () {
                const tryDirect = () => __awaiter(this, void 0, void 0, function* () {
                    try {
                        const resp = yield fetch(url, {
                            method: "POST",
                            headers: { "Content-Type": "application/x-www-form-urlencoded" },
                            body,
                        });
                        const data = (yield resp.json());
                        // Any JSON response (success OR documented AAD error) counts —
                        // we hand it back to the caller. Only network/CORS failures
                        // trigger the proxy fallback.
                        return {
                            data,
                            httpStatus: resp.status,
                            retryAfterMs: parseRetryAfterHeader(resp.headers.get("Retry-After")),
                        };
                    }
                    catch (_a) {
                        return null;
                    }
                });
                const direct = yield tryDirect();
                if (direct)
                    return direct;
                const proxyResp = yield fetch("/api/auth/proxy-token", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        // x-proxy-target is REQUIRED by the dev-server; see
                        // web/webpack.config.js for the proxy handler. Without it the
                        // server returns 400 and no JSON body.
                        "x-proxy-target": url,
                    },
                    body,
                });
                const data = (yield proxyResp.json().catch(() => ({})));
                if (!proxyResp.ok && !data.access_token && !data.error) {
                    throw new ImportedTokenError("proxy_error", `Proxy /api/auth/proxy-token returned ${proxyResp.status} with no JSON body.`, data, proxyResp.status);
                }
                return {
                    data,
                    httpStatus: proxyResp.status,
                    retryAfterMs: parseRetryAfterHeader(proxyResp.headers.get("Retry-After")),
                };
            });
        }
        /**
         * Throw a typed `ImportedTokenError` for a 429 outcome whose
         * `Retry-After` exceeds our cap, so the caller doesn't sleep for
         * minutes on a hostile or mis-clocked AAD response.
         */
        function check429(outcome, endpoint) {
            var _a;
            if (outcome.httpStatus !== 429)
                return;
            const retryMs = (_a = outcome.retryAfterMs) !== null && _a !== void 0 ? _a : 0;
            if (retryMs > RETRY_AFTER_CAP_MS) {
                throw new ImportedTokenError("retry_after_exceeded", `AAD ${endpoint} token endpoint asked for Retry-After=${Math.round(retryMs / 1000)}s which exceeds the ${Math.round(RETRY_AFTER_CAP_MS / 1000)}s cap — refusing to block the operator.`, outcome.data, outcome.httpStatus, retryMs);
            }
            // Surface the 429 itself as a typed error so callers can
            // distinguish "rate limited, retry later" from "grant is dead".
            throw new ImportedTokenError("rate_limited", `AAD ${endpoint} token endpoint returned 429 (rate limited)${retryMs ? ` — retry after ${Math.round(retryMs / 1000)}s` : ""}.`, outcome.data, outcome.httpStatus, retryMs);
        }
        const v2Outcome = yield attemptOnce(v2Url, v2Body);
        check429(v2Outcome, "v2");
        if (v2Outcome.data.access_token)
            return v2Outcome.data;
        // v2 said no. Retry against v1 if the failure looks like the RT was
        // minted by a v1 endpoint (or AAD's grant validator didn't recognise
        // the shape).
        const v2Code = ((_a = v2Outcome.data.error) !== null && _a !== void 0 ? _a : "").toLowerCase();
        const v2Detail = ((_b = v2Outcome.data.error_description) !== null && _b !== void 0 ? _b : "").toLowerCase();
        const looksV1 = v2Code === "invalid_grant" ||
            v2Detail.includes("aadsts70000") ||
            v2Detail.includes("provided grant is invalid");
        if (!looksV1) {
            // Hard failure unrelated to grant version — surface and stop.
            // Preserve the legacy message text on `.message` for backward
            // compatibility with old call sites that pattern-match it.
            throw new ImportedTokenError((_c = v2Outcome.data.error) !== null && _c !== void 0 ? _c : "aad_error", `AAD ${(_d = v2Outcome.data.error) !== null && _d !== void 0 ? _d : "error"}: ${(_e = v2Outcome.data.error_description) !== null && _e !== void 0 ? _e : "(no detail)"}`, v2Outcome.data, v2Outcome.httpStatus);
        }
        const v1Outcome = yield attemptOnce(v1Url, v1Body);
        check429(v1Outcome, "v1");
        if (v1Outcome.data.access_token)
            return v1Outcome.data;
        // Final failure — bubble whichever endpoint had more diagnostic
        // detail (v1 is usually the more informative one when the RT shape
        // was the issue). Legacy callers reading `.message` keep their
        // exact wording; new callers can switch on `.code`.
        throw new ImportedTokenError((_g = (_f = v1Outcome.data.error) !== null && _f !== void 0 ? _f : v2Outcome.data.error) !== null && _g !== void 0 ? _g : "aad_error", `AAD ${(_j = (_h = v1Outcome.data.error) !== null && _h !== void 0 ? _h : v2Outcome.data.error) !== null && _j !== void 0 ? _j : "error"}: ${(_l = (_k = v1Outcome.data.error_description) !== null && _k !== void 0 ? _k : v2Outcome.data.error_description) !== null && _l !== void 0 ? _l : "(no detail)"} — tried both /oauth2/v2.0/token (scope=…) and /oauth2/token (resource=…)`, v1Outcome.data, v1Outcome.httpStatus);
    });
}
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
export function ensureImportedToken(homeAccountId, audience) {
    var _a, _b, _c, _d, _e, _f;
    return __awaiter(this, void 0, void 0, function* () {
        const cached = getImportedToken(homeAccountId, audience);
        if (cached)
            return cached;
        if (audience === "unknown")
            return null;
        const rt = getRefreshTokenEntry(homeAccountId);
        if (!rt)
            return null;
        const scope = SCOPE_FOR_AUDIENCE[audience];
        if (!scope)
            return null;
        let data;
        try {
            data = yield redeemRefreshToken(rt.refreshToken, rt.clientId, rt.tenantId, scope);
        }
        catch (err) {
            // Audit the failure so operators can see "this RT broke" in the
            // log alongside its successful redemptions.
            recordAuditEvent({
                actor: rt.upn || rt.oid || homeAccountId,
                action: "redeemRefreshToken",
                target: audience,
                status: "failure",
                error: err instanceof Error ? err.message : String(err),
                details: {
                    homeAccountId,
                    tenantId: rt.tenantId,
                    clientId: rt.clientId,
                    audience,
                    code: err instanceof ImportedTokenError ? err.code : "redeem_failed",
                },
            });
            throw err;
        }
        if (!data.access_token) {
            const msg = (_b = (_a = data.error_description) !== null && _a !== void 0 ? _a : data.error) !== null && _b !== void 0 ? _b : "AAD refresh-token redemption returned no access_token.";
            recordAuditEvent({
                actor: rt.upn || rt.oid || homeAccountId,
                action: "redeemRefreshToken",
                target: audience,
                status: "failure",
                error: msg,
                details: {
                    homeAccountId,
                    tenantId: rt.tenantId,
                    clientId: rt.clientId,
                    audience,
                },
            });
            throw new ImportedTokenError((_c = data.error) !== null && _c !== void 0 ? _c : "no_access_token", msg, data, 0);
        }
        recordAuditEvent({
            actor: rt.upn || rt.oid || homeAccountId,
            action: "redeemRefreshToken",
            target: audience,
            status: "success",
            details: {
                homeAccountId,
                tenantId: rt.tenantId,
                clientId: rt.clientId,
                audience,
                rotatedRt: !!data.refresh_token,
            },
        });
        // Cache the new access token. Decode for accurate metadata so the
        // import-list UI shows the right expiry / aud / etc.
        const claims = (_d = decodeJwtPayload(data.access_token)) !== null && _d !== void 0 ? _d : {};
        const expFromJwt = Number((_e = claims.exp) !== null && _e !== void 0 ? _e : 0);
        const expFromRsp = data.expires_in
            ? Math.floor(Date.now() / 1000) + data.expires_in
            : 0;
        const expiresAt = expFromJwt || expFromRsp || 0;
        const rawAud = String((_f = claims.aud) !== null && _f !== void 0 ? _f : "");
        const all = readAll();
        const filtered = all.filter((e) => !(e.homeAccountId === homeAccountId && e.audience === audience));
        filtered.push({
            homeAccountId,
            tenantId: rt.tenantId,
            oid: rt.oid,
            upn: rt.upn,
            name: rt.name,
            audience,
            rawAudience: rawAud,
            accessToken: data.access_token,
            expiresAt,
            importedAt: new Date().toISOString(),
        });
        writeAll(filtered);
        // Rotate the refresh token if AAD returned a new one.
        if (data.refresh_token && data.refresh_token !== rt.refreshToken) {
            importRefreshToken({
                homeAccountId: rt.homeAccountId,
                tenantId: rt.tenantId,
                oid: rt.oid,
                upn: rt.upn,
                name: rt.name,
                clientId: rt.clientId,
                refreshToken: data.refresh_token,
            });
        }
        return data.access_token;
    });
}
/**
 * Return one pseudo-account row per imported principal, suitable for
 * merging into the displayed `azureAccounts` list. Tracks `addedAt`
 * across reloads via the earliest `importedAt` we have for that
 * principal so the row's first-seen timestamp stays stable.
 */
export function getImportedPseudoAccounts() {
    var _a, _b, _c;
    const tokens = listImportedTokens();
    const byAccount = new Map();
    for (const t of tokens) {
        const existing = byAccount.get(t.homeAccountId);
        if (existing) {
            // Keep the earliest importedAt as the row's addedAt — newer
            // re-imports don't bump the user-visible "added" stamp.
            if (t.importedAt < existing.addedAt) {
                existing.addedAt = t.importedAt;
            }
            continue;
        }
        byAccount.set(t.homeAccountId, {
            homeAccountId: t.homeAccountId,
            localAccountId: t.oid,
            username: (_a = t.upn) !== null && _a !== void 0 ? _a : t.oid,
            name: (_c = (_b = t.name) !== null && _b !== void 0 ? _b : t.upn) !== null && _c !== void 0 ? _c : t.oid,
            tenantId: t.tenantId,
            environment: "imported",
            subscriptions: [],
            subscriptionCount: 0,
            status: "active",
            error: null,
            signedOut: false,
            addedAt: t.importedAt,
        });
    }
    return Array.from(byAccount.values());
}
// In-memory fallback when sessionStorage is unavailable (Safari private
// mode etc.). Plain array — preserves insertion order so the UI list
// renders in import-order without an explicit sort.
let adoPatMemoryStore = [];
/**
 * Defensive cap — runaway paste loops in dev tools should not be able
 * to push sessionStorage past its (typically) 5 MB quota. 64 entries at
 * ~100 bytes each is well under any browser's quota.
 */
const ADO_PAT_MAX_ENTRIES = 64;
function readAllAdoPats() {
    if (typeof window === "undefined")
        return adoPatMemoryStore.slice();
    try {
        const raw = window.sessionStorage.getItem(ADO_PAT_STORAGE_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        // Filter shape-broken entries so a partial-write earlier in the
        // page's life can't crash the UI on read.
        return parsed.filter((e) => !!e &&
            typeof e === "object" &&
            typeof e.id === "string" &&
            typeof e.pat === "string" &&
            typeof e.owner === "string" &&
            typeof e.addedAt === "number" &&
            e.kind === "adoPat");
    }
    catch (_a) {
        return adoPatMemoryStore.slice();
    }
}
function writeAllAdoPats(entries) {
    // Cap before mirroring + persisting.
    const capped = entries.slice(-ADO_PAT_MAX_ENTRIES);
    adoPatMemoryStore = capped.slice();
    if (typeof window === "undefined")
        return;
    try {
        window.sessionStorage.setItem(ADO_PAT_STORAGE_KEY, JSON.stringify(capped));
    }
    catch (_a) {
        /* sessionStorage unavailable / over quota — in-memory mirror is the
         * fallback. */
    }
}
/**
 * Generate a short, URL-safe random id (not a security primitive — only
 * needed to disambiguate PAT entries in the UI for delete-by-id ops).
 * Uses `crypto.getRandomValues` when available with `Math.random` as a
 * graceful fallback for non-DOM test environments.
 */
function generateAdoPatId() {
    var _a;
    // 64 bits of entropy is plenty for a within-vault discriminator (max
    // 64 entries → collision odds astronomically low).
    const bytes = new Uint8Array(8);
    try {
        if (typeof globalThis !== "undefined" &&
            typeof ((_a = globalThis.crypto) === null || _a === void 0 ? void 0 : _a.getRandomValues) === "function") {
            globalThis.crypto.getRandomValues(bytes);
        }
        else {
            for (let i = 0; i < bytes.length; i += 1) {
                bytes[i] = Math.floor(Math.random() * 256);
            }
        }
    }
    catch (_b) {
        for (let i = 0; i < bytes.length; i += 1) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
/**
 * Validate that a pasted string looks like a DevOps PAT shape. AzDO
 * PATs are 52 chars of base64-like alphabet (alphanumeric only — no
 * `+ / =`). We don't reject anything outside that exact shape (newer
 * PATs may relax the length), but we tighten the regex enough to
 * reject obvious mistakes like accidentally pasting a JWT.
 */
export function isLikelyAdoPat(raw) {
    if (typeof raw !== "string")
        return false;
    const s = raw.trim();
    // 52 is the historical exact length, but Microsoft has produced longer
    // tokens in newer issuance flows — accept 40..96 with the strict
    // alphanumeric alphabet to catch typos without rejecting valid new
    // formats.
    if (s.length < 40 || s.length > 96)
        return false;
    return /^[A-Za-z0-9]+$/.test(s);
}
/**
 * Add a PAT to the vault. Replaces any existing entry whose `owner`
 * label matches (case-insensitive) so re-pasting against the same
 * owner overwrites rather than piling up. Returns the persisted entry.
 */
export function addAdoPat(opts) {
    var _a, _b;
    const pat = ((_a = opts.pat) !== null && _a !== void 0 ? _a : "").trim();
    const owner = ((_b = opts.owner) !== null && _b !== void 0 ? _b : "").trim();
    if (!pat) {
        throw new Error("addAdoPat: pat is required (got empty string).");
    }
    if (!owner) {
        throw new Error("addAdoPat: owner label is required (got empty string).");
    }
    const entry = {
        id: generateAdoPatId(),
        kind: "adoPat",
        pat,
        owner,
        addedAt: Date.now(),
    };
    const all = readAllAdoPats();
    const ownerLower = owner.toLowerCase();
    const filtered = all.filter((e) => e.owner.toLowerCase() !== ownerLower);
    filtered.push(entry);
    writeAllAdoPats(filtered);
    // NEVER include `pat` in the audit details — only the synthetic id /
    // owner label, both of which are safe to read in audit exports.
    recordAuditEvent({
        actor: owner,
        action: "addAdoPat",
        target: owner,
        status: "success",
        details: { id: entry.id, owner, addedAt: entry.addedAt },
    });
    return entry;
}
/** Snapshot of every imported PAT (in import order). */
export function listAdoPats() {
    return readAllAdoPats().slice();
}
/** Remove a single PAT entry by its synthetic id. No-op if absent. */
export function removeAdoPat(id) {
    var _a, _b;
    const all = readAllAdoPats();
    const removed = all.find((e) => e.id === id);
    const next = all.filter((e) => e.id !== id);
    if (next.length !== all.length) {
        writeAllAdoPats(next);
        recordAuditEvent({
            actor: (_a = removed === null || removed === void 0 ? void 0 : removed.owner) !== null && _a !== void 0 ? _a : "system",
            action: "removeAdoPat",
            target: (_b = removed === null || removed === void 0 ? void 0 : removed.owner) !== null && _b !== void 0 ? _b : id,
            status: "success",
            details: { id, owner: removed === null || removed === void 0 ? void 0 : removed.owner },
        });
    }
}
/** Wipe every PAT from the vault. */
export function clearAdoPats() {
    writeAllAdoPats([]);
}
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
export function getAdoPatAsBasicHeader(id) {
    const entry = readAllAdoPats().find((e) => e.id === id);
    if (!entry) {
        throw new Error(`getAdoPatAsBasicHeader: no PAT entry found for id ${id}.`);
    }
    const raw = `:${entry.pat}`;
    let b64;
    try {
        if (typeof btoa === "function") {
            b64 = btoa(raw);
        }
        else {
            b64 = Buffer.from(raw, "utf-8").toString("base64");
        }
    }
    catch (err) {
        throw new Error(`getAdoPatAsBasicHeader: failed to base64-encode PAT (${err instanceof Error ? err.message : String(err)}).`);
    }
    return `Basic ${b64}`;
}
//# sourceMappingURL=imported-tokens.js.map