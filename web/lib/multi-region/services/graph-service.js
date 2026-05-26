/**
 * Microsoft Graph service layer.
 *
 * Pure-fetch wrappers around the Graph v1.0 endpoints used by the
 * multi-region admin features. All wrappers route through the shared
 * RequestGuard via guardedFetch, with `family: "graph"` and the tenantId
 * as the rate-limit key (Graph applies per-tenant limits).
 *
 * The caller is responsible for token acquisition; pass an access token
 * with the Microsoft Graph audience (https://graph.microsoft.com/.default).
 */
import { __awaiter } from "tslib";
import { classifyHttpError, } from "./types";
import { guardedFetch } from "../scheduling/request-governance";
import { fetchAllPages as sharedFetchAllPages } from "./_shared/paginate";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_USER_SELECT = [
    "id",
    "displayName",
    "userPrincipalName",
    "mail",
    "accountEnabled",
    "jobTitle",
    "department",
];
// Well-known directory role template IDs that grant the ability to
// reset other users' passwords. Source:
// https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference
export const ROLE_GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
export const ROLE_USER_ADMIN = "fe930be7-5e62-47db-91af-98c3a49a38b1";
export const ROLE_HELPDESK_ADMIN = "729827e3-9c14-49f7-bb1b-9608f156bbb8";
export const ROLE_AUTHENTICATION_ADMIN = "c4e39bd9-1100-46d3-8c65-fb160da0071f";
export const ROLE_PRIVILEGED_AUTH_ADMIN = "7be44c8a-adaf-4e2a-84d6-ab2649e08a13";
export const ROLE_GLOBAL_READER = "f2ef992c-3afb-46b9-b7cf-a126ee74c451";
export const ROLE_DIRECTORY_READER = "88d8e3e3-8f55-4a1e-953a-9b9898b8876b";
const PASSWORD_RESET_ROLE_TEMPLATES = new Set([
    ROLE_GLOBAL_ADMIN,
    ROLE_USER_ADMIN,
    ROLE_HELPDESK_ADMIN,
    ROLE_AUTHENTICATION_ADMIN,
    ROLE_PRIVILEGED_AUTH_ADMIN,
]);
function validateTenantId(tenantId) {
    if (!TENANT_ID_RE.test(tenantId)) {
        throw new Error("Invalid tenantId: must be a valid GUID.");
    }
}
function validateUserId(userId) {
    if (!USER_ID_RE.test(userId)) {
        throw new Error("Invalid userId: must be a valid GUID.");
    }
}
function graphHeaders(token, extra) {
    return Object.assign({ Authorization: `Bearer ${token}`, Accept: "application/json" }, extra);
}
function graphFetch(url, init, tenantId) {
    return guardedFetch(url, init, {
        subscriptionId: tenantId,
        family: "graph",
    });
}
function toGraphError(response) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        const body = yield response.json().catch(() => ({}));
        const inner = body === null || body === void 0 ? void 0 : body.error;
        const rawMessage = (_a = inner === null || inner === void 0 ? void 0 : inner.message) !== null && _a !== void 0 ? _a : `Graph request failed: ${response.status}`;
        // Strip any password-like values that Graph might echo back.
        const safeMessage = rawMessage.replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"***"');
        // Graph nests structured details under `error.details` and inner errors
        // under `error.innerError`. Surface both for audit-log consumers.
        const detailsArr = Array.isArray(inner === null || inner === void 0 ? void 0 : inner.details)
            ? inner.details.slice(0, 20).map((d) => {
                var _a;
                return ({
                    code: d.code,
                    message: (_a = d.message) === null || _a === void 0 ? void 0 : _a.replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"***"'),
                });
            })
            : undefined;
        const urlPath = (() => {
            try {
                return new URL(response.url).pathname;
            }
            catch (_a) {
                return response.url || undefined;
            }
        })();
        // Enrich the message for the canonical Graph 403 patterns so the
        // operator sees what they ACTUALLY need to fix instead of just
        // "Insufficient privileges to complete the operation." Graph's
        // default message is famously unactionable — operators routinely
        // think their app registration is misconfigured when the real
        // problem is a missing directory role on the SIGNED-IN USER for
        // the destination tenant (or vice-versa).
        let enrichedMessage = safeMessage;
        if (response.status === 403) {
            const code = (_b = inner === null || inner === void 0 ? void 0 : inner.code) !== null && _b !== void 0 ? _b : "";
            const isPrivilegeDenied = /Authorization_RequestDenied|Insufficient privileges/i.test(`${code} ${safeMessage}`);
            if (isPrivilegeDenied) {
                const isUsersEndpoint = /\/users(\/|\?|$)/.test(urlPath !== null && urlPath !== void 0 ? urlPath : "");
                const guidance = isUsersEndpoint
                    ? "Two things must both be true for /users operations in the destination tenant:\n" +
                        "  1) The signed-in user holds an Entra directory role with the right scope — " +
                        "typically User Administrator or Global Administrator (writes), or Directory Readers " +
                        "(reads). Verify in the DESTINATION tenant's Entra ID → Users → [you] → Assigned roles. " +
                        "Role assignments in your home tenant do NOT carry over.\n" +
                        "  2) The MSAL app (this WebUI's client id) has admin-consented Graph permissions " +
                        "for User.ReadWrite.All / Directory.ReadWrite.All (or .Read.All for reads). " +
                        "Ask a tenant admin to grant admin consent for the app in the destination tenant."
                    : "Either the signed-in user lacks a directory role granting this action in the " +
                        "destination tenant, OR the MSAL app hasn't been admin-consented for the required " +
                        "Graph permissions in that tenant. Check Entra ID → Users → [you] → Assigned roles " +
                        "in the DESTINATION tenant (not your home tenant), then ask a tenant admin to grant " +
                        "admin consent for the app if the role looks correct.";
                enrichedMessage =
                    `${safeMessage}\n\n` +
                        `Graph rejected the call as 403 / ${code || "Authorization_RequestDenied"}.\n` +
                        guidance +
                        `\nIf you just received the role, wait ~5 min for propagation, then click "Sign in ` +
                        `again" to mint a fresh token whose claims see the new assignment.`;
            }
        }
        const display = urlPath
            ? `${response.status} ${urlPath}: ${enrichedMessage}`
            : enrichedMessage;
        const DISPLAY_MAX = 1000;
        const truncated = display.length > DISPLAY_MAX
            ? `${display.slice(0, DISPLAY_MAX)}…[truncated]`
            : display;
        // Classify into RateLimitError / NotFoundError / etc so Graph 429s
        // (which carry the same Retry-After hint as ARM) surface to typed
        // catch sites without a magic-number check.
        const retryAfterHeader = response.headers.get("Retry-After");
        const err = classifyHttpError(truncated, response.status, (_c = inner === null || inner === void 0 ? void 0 : inner.code) !== null && _c !== void 0 ? _c : "GraphError", body, retryAfterHeader);
        if (urlPath)
            err.urlPath = urlPath;
        if (detailsArr && detailsArr.length > 0)
            err.details = detailsArr;
        return err;
    });
}
function fetchAllPages(initialUrl, token, tenantId, extraHeaders, signal) {
    return __awaiter(this, void 0, void 0, function* () {
        return sharedFetchAllPages({
            initialUrl,
            nextLinkPath: (page) => page["@odata.nextLink"],
            signal,
            fetcher: (url, sig) => __awaiter(this, void 0, void 0, function* () {
                const response = yield graphFetch(url, Object.assign({ headers: graphHeaders(token, extraHeaders) }, (sig ? { signal: sig } : {})), tenantId);
                if (!response.ok) {
                    throw yield toGraphError(response);
                }
                return response.json();
            }),
        });
    });
}
/**
 * List users in the calling tenant via Microsoft Graph.
 *
 * Returns the projection requested via `$select` (defaults to id,
 * displayName, userPrincipalName, mail, accountEnabled, jobTitle,
 * department). When `search` is provided the server-side $search filter
 * is used together with the `ConsistencyLevel: eventual` header, which
 * Graph requires for advanced query parameters.
 */
export function listOrgUsers(tenantId, accessToken, opts) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        const select = ((_a = opts === null || opts === void 0 ? void 0 : opts.select) === null || _a === void 0 ? void 0 : _a.length)
            ? opts.select.join(",")
            : DEFAULT_USER_SELECT.join(",");
        const top = Math.max(1, Math.min(999, (_b = opts === null || opts === void 0 ? void 0 : opts.top) !== null && _b !== void 0 ? _b : 999));
        const params = new URLSearchParams();
        params.set("$select", select);
        params.set("$top", String(top));
        const extraHeaders = {};
        if ((opts === null || opts === void 0 ? void 0 : opts.search) && opts.search.trim().length > 0) {
            const escaped = opts.search.replace(/"/g, '\\"');
            params.set("$search", `"displayName:${escaped}" OR "mail:${escaped}"`);
            params.set("$count", "true");
            extraHeaders["ConsistencyLevel"] = "eventual";
        }
        const url = `${GRAPH_BASE}/users?${params.toString()}`;
        const raw = yield fetchAllPages(url, accessToken, tenantId, extraHeaders, opts === null || opts === void 0 ? void 0 : opts.signal);
        return raw.map((u) => {
            var _a, _b, _c, _d, _e, _f;
            return ({
                id: (_a = u.id) !== null && _a !== void 0 ? _a : "",
                displayName: (_b = u.displayName) !== null && _b !== void 0 ? _b : "",
                userPrincipalName: (_c = u.userPrincipalName) !== null && _c !== void 0 ? _c : "",
                mail: (_d = u.mail) !== null && _d !== void 0 ? _d : null,
                accountEnabled: Boolean(u.accountEnabled),
                jobTitle: (_e = u.jobTitle) !== null && _e !== void 0 ? _e : null,
                department: (_f = u.department) !== null && _f !== void 0 ? _f : null,
            });
        });
    });
}
function mapDirectoryRoleResponse(raw) {
    return raw
        .filter((r) => r["@odata.type"] === "#microsoft.graph.directoryRole")
        .map((r) => {
        var _a, _b, _c, _d;
        return ({
            id: (_a = r.id) !== null && _a !== void 0 ? _a : "",
            displayName: (_b = r.displayName) !== null && _b !== void 0 ? _b : "",
            description: (_c = r.description) !== null && _c !== void 0 ? _c : undefined,
            roleTemplateId: (_d = r.roleTemplateId) !== null && _d !== void 0 ? _d : "",
        });
    });
}
/**
 * Get directory role memberships for the calling user (`/me/memberOf`).
 * Filters to entries whose @odata.type is "#microsoft.graph.directoryRole".
 */
export function getMyDirectoryRoles(tenantId, accessToken) {
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        const url = `${GRAPH_BASE}/me/memberOf` +
            `?$select=id,displayName,description,roleTemplateId`;
        const raw = yield fetchAllPages(url, accessToken, tenantId);
        return mapDirectoryRoleResponse(raw);
    });
}
/**
 * Get directory role memberships for a specific user
 * (`/users/{id}/memberOf`).
 *
 * Note: prefer `getUserDirectoryRolesBatched` when looking up roles for
 * many users — it collapses N separate Graph calls into ceil(N/20) via
 * the JSON `$batch` endpoint. This single-user variant is kept for
 * call sites that only ever need one user.
 */
export function getUserDirectoryRoles(tenantId, userId, accessToken) {
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        validateUserId(userId);
        const url = `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/memberOf` +
            `?$select=id,displayName,description,roleTemplateId`;
        const raw = yield fetchAllPages(url, accessToken, tenantId);
        return mapDirectoryRoleResponse(raw);
    });
}
/**
 * Bulk variant of `getUserDirectoryRoles` — one Graph `$batch` POST
 * per 20 users instead of one round-trip per user.
 *
 * Returns a Map<userId, DirectoryRole[]>. Users absent from the map
 * either had no role memberships OR their individual sub-request
 * failed (fail-soft: per-user errors are swallowed and logged via
 * console.warn so a single bad userId can't poison the batch).
 *
 * Background: Microsoft Graph `$batch` accepts up to 20 sub-requests
 * per call. Sub-requests are evaluated independently against
 * throttling, so $batch saves round-trips but not throttle budget.
 * For the tenant-users page this still flips the worst case from
 * 500 GETs to 25 POSTs — a 20× reduction in latency and connection
 * pressure (browsers cap per-origin concurrency at 6).
 *
 * Reference: https://learn.microsoft.com/graph/json-batching
 */
export function getUserDirectoryRolesBatched(tenantId, userIds, accessToken) {
    var _a, _b, _c, _d, _e;
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        const result = new Map();
        if (userIds.length === 0)
            return result;
        // Validate ids client-side so a bad caller doesn't waste a batch slot.
        const validIds = userIds.filter((id) => {
            try {
                validateUserId(id);
                return true;
            }
            catch (_a) {
                return false;
            }
        });
        const BATCH_LIMIT = 20;
        for (let i = 0; i < validIds.length; i += BATCH_LIMIT) {
            const chunk = validIds.slice(i, i + BATCH_LIMIT);
            const requests = chunk.map((id, idx) => ({
                id: `${i + idx}`,
                method: "GET",
                url: `/users/${encodeURIComponent(id)}/memberOf` +
                    `?$select=id,displayName,description,roleTemplateId`,
            }));
            const response = yield graphFetch(`${GRAPH_BASE}/$batch`, {
                method: "POST",
                headers: graphHeaders(accessToken, {
                    "Content-Type": "application/json",
                }),
                body: JSON.stringify({ requests }),
            }, tenantId);
            if (!response.ok) {
                throw yield toGraphError(response);
            }
            const body = (yield response.json());
            if (!Array.isArray(body.responses))
                continue;
            for (const r of body.responses) {
                const reqIdx = Number(r.id);
                if (!Number.isFinite(reqIdx))
                    continue;
                const userId = chunk[reqIdx - i];
                if (!userId)
                    continue;
                if (r.status >= 200 && r.status < 300) {
                    const value = ((_b = (_a = r.body) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : []);
                    result.set(userId, mapDirectoryRoleResponse(value));
                }
                else {
                    const msg = (_e = (_d = (_c = r.body) === null || _c === void 0 ? void 0 : _c.error) === null || _d === void 0 ? void 0 : _d.message) !== null && _e !== void 0 ? _e : `status ${r.status}`;
                    console.warn(`[graph $batch] memberOf for user ${userId.substring(0, 8)} failed: ${msg}`);
                }
            }
        }
        return result;
    });
}
/**
 * Reset a user's password via Microsoft Graph (PATCH /users/{id}).
 *
 * The caller must have one of the password-reset directory roles
 * (see canResetPasswords). Sensitive payload is never logged.
 */
export function resetUserPassword(tenantId, userId, newPassword, forceChangeNextSignIn, accessToken, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        validateUserId(userId);
        if (typeof newPassword !== "string" || newPassword.length === 0) {
            throw new Error("Invalid newPassword: must be a non-empty string.");
        }
        const url = `${GRAPH_BASE}/users/${encodeURIComponent(userId)}`;
        const body = JSON.stringify({
            passwordProfile: {
                password: newPassword,
                forceChangePasswordNextSignIn: !!forceChangeNextSignIn,
            },
        });
        const response = yield graphFetch(url, Object.assign({ method: "PATCH", headers: graphHeaders(accessToken, {
                "Content-Type": "application/json",
            }), body }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})), tenantId);
        if (!response.ok) {
            throw yield toGraphError(response);
        }
    });
}
/**
 * Pure-function helper: returns true if the supplied roles include any
 * directory role that grants the ability to reset another user's
 * password.
 */
export function canResetPasswords(roles) {
    if (!Array.isArray(roles) || roles.length === 0)
        return false;
    return roles.some((r) => PASSWORD_RESET_ROLE_TEMPLATES.has(r.roleTemplateId));
}
const USER_CREATE_ROLE_TEMPLATES = new Set([
    ROLE_GLOBAL_ADMIN,
    ROLE_USER_ADMIN,
]);
/**
 * Pure-function helper: returns true when the supplied directory roles
 * include one that can CREATE new users (NOT just reset passwords).
 * Helpdesk + Authentication Administrators are explicitly excluded —
 * they can only reset passwords, not create users.
 */
export function canCreateUsers(roles) {
    if (!Array.isArray(roles) || roles.length === 0)
        return false;
    return roles.some((r) => USER_CREATE_ROLE_TEMPLATES.has(r.roleTemplateId));
}
/**
 * Create a new Microsoft Entra ID user via Microsoft Graph
 * (POST /users). The caller must hold a directory role that allows
 * user creation (User Administrator or Global Administrator).
 *
 * Sensitive payload (password) is never logged. On 4xx, throws an
 * AzureRequestError carrying the Graph error message.
 */
export function createUser(tenantId, req, accessToken, opts) {
    var _a, _b, _c, _d, _e;
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        if (!req || typeof req !== "object") {
            throw new Error("Invalid request: must provide a CreateUserRequest.");
        }
        if (!req.userPrincipalName || !req.userPrincipalName.includes("@")) {
            throw new Error("Invalid userPrincipalName: must be of the form <prefix>@<domain>.");
        }
        if (!req.displayName) {
            throw new Error("Invalid displayName: must be a non-empty string.");
        }
        if (!req.mailNickname) {
            throw new Error("Invalid mailNickname: must be a non-empty string.");
        }
        if (typeof req.password !== "string" || req.password.length === 0) {
            throw new Error("Invalid password: must be a non-empty string.");
        }
        const url = `${GRAPH_BASE}/users`;
        const body = {
            accountEnabled: !!req.accountEnabled,
            displayName: req.displayName,
            mailNickname: req.mailNickname,
            userPrincipalName: req.userPrincipalName,
            passwordProfile: {
                password: req.password,
                forceChangePasswordNextSignIn: !!req.forceChangePasswordNextSignIn,
            },
        };
        if (req.usageLocation)
            body.usageLocation = req.usageLocation;
        if (req.givenName)
            body.givenName = req.givenName;
        if (req.surname)
            body.surname = req.surname;
        if (req.jobTitle)
            body.jobTitle = req.jobTitle;
        if (req.department)
            body.department = req.department;
        const response = yield graphFetch(url, Object.assign({ method: "POST", headers: graphHeaders(accessToken, {
                "Content-Type": "application/json",
            }), body: JSON.stringify(body) }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})), tenantId);
        if (!response.ok) {
            throw yield toGraphError(response);
        }
        const data = (yield response.json());
        return {
            id: (_a = data.id) !== null && _a !== void 0 ? _a : "",
            userPrincipalName: (_b = data.userPrincipalName) !== null && _b !== void 0 ? _b : "",
            displayName: (_c = data.displayName) !== null && _c !== void 0 ? _c : "",
            accountEnabled: Boolean(data.accountEnabled),
            mailNickname: (_d = data.mailNickname) !== null && _d !== void 0 ? _d : "",
            createdDateTime: (_e = data.createdDateTime) !== null && _e !== void 0 ? _e : undefined,
        };
    });
}
/**
 * Add a user (or any directory principal) to a built-in directory role,
 * identified by its template GUID (the {@link ROLE_USER_ADMIN}-style
 * constants in this file).
 *
 * Two-step flow because Graph's classic `/directoryRoles` collection only
 * contains roles that have been *activated* in the tenant:
 *
 *   1. Look up the activated role by `roleTemplateId`. If not present,
 *      activate it by POSTing the template id to `/directoryRoles`.
 *   2. POST the user's directoryObjects ref to the role's
 *      `/members/$ref` collection.
 *
 * Required caller privilege (delegated): Global Administrator OR
 * Privileged Role Administrator, OR a same-or-lower role manager.
 * Specifically, a User Administrator can only add members to roles at or
 * below their own scope — so attempting to grant Global Admin from a
 * User-Admin token fails with 403. Errors propagate as
 * {@link AzureRequestError} so the UI can surface them inline.
 */
export function assignDirectoryRole(tenantId, userObjectId, roleTemplateId, accessToken, opts) {
    var _a, _b, _c, _d, _e, _f, _g;
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        validateUserId(userObjectId);
        if (!/^[0-9a-f-]{36}$/i.test(roleTemplateId)) {
            throw new Error("Invalid roleTemplateId: must be a valid GUID.");
        }
        // Step 1a: find the activated role for this template.
        const listUrl = `${GRAPH_BASE}/directoryRoles?$filter=` +
            encodeURIComponent(`roleTemplateId eq '${roleTemplateId}'`);
        let roleObjectId = null;
        {
            const resp = yield graphFetch(listUrl, Object.assign({ headers: graphHeaders(accessToken) }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})), tenantId);
            if (!resp.ok)
                throw yield toGraphError(resp);
            const body = (yield resp.json());
            if (body.value && body.value.length > 0 && ((_a = body.value[0]) === null || _a === void 0 ? void 0 : _a.id)) {
                roleObjectId = body.value[0].id;
            }
        }
        // Step 1b: activate the template if it wasn't already active in this tenant.
        if (!roleObjectId) {
            const activateResp = yield graphFetch(`${GRAPH_BASE}/directoryRoles`, Object.assign({ method: "POST", headers: graphHeaders(accessToken, {
                    "Content-Type": "application/json",
                }), body: JSON.stringify({ roleTemplateId }) }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})), tenantId);
            if (!activateResp.ok)
                throw yield toGraphError(activateResp);
            const activated = (yield activateResp.json());
            if (!activated.id) {
                throw new Error("Directory role activation returned an empty object id.");
            }
            roleObjectId = activated.id;
        }
        // Step 2: add the user to the role. Graph returns 204 No Content on
        // success and a `409 Conflict / Request_BadRequest` echoing
        // "One or more added object references already exist" if the user is
        // already a member — that's idempotent success from our perspective.
        const addResp = yield graphFetch(`${GRAPH_BASE}/directoryRoles/${encodeURIComponent(roleObjectId)}/members/$ref`, Object.assign({ method: "POST", headers: graphHeaders(accessToken, {
                "Content-Type": "application/json",
            }), body: JSON.stringify({
                "@odata.id": `${GRAPH_BASE}/directoryObjects/${userObjectId}`,
            }) }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})), tenantId);
        if (addResp.ok) {
            return { roleObjectId, alreadyMember: false };
        }
        // Treat "already a member" as success.
        const errBody = yield addResp.json().catch(() => ({}));
        const msg = String((_c = (_b = errBody === null || errBody === void 0 ? void 0 : errBody.error) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "").toLowerCase();
        if (addResp.status === 400 &&
            (msg.includes("already exist") || msg.includes("already a member"))) {
            return { roleObjectId, alreadyMember: true };
        }
        // Route through classifyHttpError so 401 → AuthError / 403 →
        // PermissionError / 429 → RateLimitError reach `instanceof`-aware
        // call sites (auditing, retry policy). Previously a bare
        // AzureRequestError was thrown, which the typed catch sites would
        // miss.
        throw classifyHttpError((_e = (_d = errBody === null || errBody === void 0 ? void 0 : errBody.error) === null || _d === void 0 ? void 0 : _d.message) !== null && _e !== void 0 ? _e : `Graph request failed: ${addResp.status}`, addResp.status, (_g = (_f = errBody === null || errBody === void 0 ? void 0 : errBody.error) === null || _f === void 0 ? void 0 : _f.code) !== null && _g !== void 0 ? _g : "GraphError", errBody, addResp.headers.get("Retry-After"));
    });
}
/**
 * Bulk-resolve directory-object ids via Graph's `directoryObjects/getByIds`.
 * The endpoint accepts up to 1000 ids per call; we chunk in 100s to keep
 * each request fast and to play nice with the per-request payload size
 * limit. Missing ids are returned as `{id, type: "Unknown", displayName: id}`
 * so the UI always has a row to show.
 */
export function getPrincipalsByIds(tenantId, objectIds, accessToken) {
    var _a, _b, _c, _d, _e, _f, _g;
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        const unique = Array.from(new Set(objectIds.filter((id) => !!id)));
        if (unique.length === 0)
            return [];
        const out = new Map();
        for (let i = 0; i < unique.length; i += 100) {
            const chunk = unique.slice(i, i + 100);
            const resp = yield graphFetch(`${GRAPH_BASE}/directoryObjects/getByIds`, {
                method: "POST",
                headers: graphHeaders(accessToken, {
                    "Content-Type": "application/json",
                }),
                body: JSON.stringify({
                    ids: chunk,
                    types: ["user", "group", "servicePrincipal"],
                }),
            }, tenantId);
            if (!resp.ok)
                throw yield toGraphError(resp);
            const body = (yield resp.json());
            for (const obj of (_a = body.value) !== null && _a !== void 0 ? _a : []) {
                const id = String((_b = obj.id) !== null && _b !== void 0 ? _b : "");
                if (!id)
                    continue;
                const odata = String((_c = obj["@odata.type"]) !== null && _c !== void 0 ? _c : "").toLowerCase();
                const type = odata.includes("user")
                    ? "User"
                    : odata.includes("group")
                        ? "Group"
                        : odata.includes("serviceprincipal")
                            ? "ServicePrincipal"
                            : odata.includes("application")
                                ? "Application"
                                : "Unknown";
                const displayName = (_e = (_d = obj.displayName) !== null && _d !== void 0 ? _d : obj.userPrincipalName) !== null && _e !== void 0 ? _e : id;
                const signInName = (_g = (_f = obj.userPrincipalName) !== null && _f !== void 0 ? _f : obj.mail) !== null && _g !== void 0 ? _g : obj.appId;
                out.set(id, { id, type, displayName, signInName });
            }
        }
        // Backfill any ids Graph didn't return (deleted principal, lacking
        // permission to see them, etc.) so the caller can render a row for
        // each request id.
        for (const id of unique) {
            if (!out.has(id)) {
                out.set(id, { id, type: "Unknown", displayName: id });
            }
        }
        return Array.from(out.values());
    });
}
/**
 * Resolve a UPN or email to a User object id via Graph. Returns
 * undefined when no exact match. Used by Sub Manager's "add by email"
 * flow so the operator doesn't have to look up GUIDs manually.
 */
export function findUserByUpnOrMail(tenantId, upnOrMail, accessToken) {
    var _a, _b, _c, _d, _e, _f, _g;
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        const value = upnOrMail.trim();
        if (!value)
            return undefined;
        // Try direct GET first — works for canonical UPNs.
        const direct = yield graphFetch(`${GRAPH_BASE}/users/${encodeURIComponent(value)}?$select=id,displayName,userPrincipalName,mail`, { headers: graphHeaders(accessToken) }, tenantId);
        if (direct.ok) {
            const data = (yield direct.json());
            return {
                id: String((_a = data.id) !== null && _a !== void 0 ? _a : ""),
                displayName: String((_b = data.displayName) !== null && _b !== void 0 ? _b : value),
                upn: String((_c = data.userPrincipalName) !== null && _c !== void 0 ? _c : value),
            };
        }
        // Fallback: $filter on userPrincipalName or mail. Catches guests
        // whose UPN is mangled (#EXT#) when the operator pasted the raw mail.
        const escaped = value.replace(/'/g, "''");
        const filterUrl = `${GRAPH_BASE}/users` +
            `?$filter=userPrincipalName eq '${encodeURIComponent(escaped)}'` +
            ` or mail eq '${encodeURIComponent(escaped)}'` +
            `&$select=id,displayName,userPrincipalName,mail&$top=1`;
        const filtered = yield graphFetch(filterUrl, { headers: graphHeaders(accessToken) }, tenantId);
        if (!filtered.ok)
            throw yield toGraphError(filtered);
        const body = (yield filtered.json());
        const first = (_d = body.value) === null || _d === void 0 ? void 0 : _d[0];
        if (!first)
            return undefined;
        return {
            id: String((_e = first.id) !== null && _e !== void 0 ? _e : ""),
            displayName: String((_f = first.displayName) !== null && _f !== void 0 ? _f : value),
            upn: String((_g = first.userPrincipalName) !== null && _g !== void 0 ? _g : value),
        };
    });
}
/**
 * Invite an external (B2B) user to the calling tenant via the Graph
 * `/invitations` endpoint. The caller's access token must hold the
 * `User.Invite.All` permission — granted by the Guest Inviter, User
 * Administrator, or Global Administrator directory roles.
 *
 * The returned `inviteRedeemUrl` is what the operator copies and sends
 * to the invited user. If `sendInvitationMessage` is true, Graph also
 * sends an email with the same URL embedded — but the WebUI surfaces
 * the URL regardless so it never gets lost in the operator's inbox.
 */
export function inviteGuest(tenantId, req, accessToken, opts) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        if (!(req === null || req === void 0 ? void 0 : req.invitedUserEmailAddress) ||
            !req.invitedUserEmailAddress.includes("@")) {
            throw new Error("Invalid invitedUserEmailAddress: must be of the form <user>@<domain>.");
        }
        const url = `${GRAPH_BASE}/invitations`;
        const body = {
            invitedUserEmailAddress: req.invitedUserEmailAddress,
            inviteRedirectUrl: ((_a = req.inviteRedirectUrl) === null || _a === void 0 ? void 0 : _a.trim()) || "https://myapplications.microsoft.com",
            sendInvitationMessage: !!req.sendInvitationMessage,
        };
        if (req.invitedUserDisplayName) {
            body.invitedUserDisplayName = req.invitedUserDisplayName;
        }
        if (req.sendInvitationMessage && req.customizedMessageBody) {
            body.invitedUserMessageInfo = {
                customizedMessageBody: req.customizedMessageBody,
            };
        }
        const response = yield graphFetch(url, Object.assign({ method: "POST", headers: graphHeaders(accessToken, {
                "Content-Type": "application/json",
            }), body: JSON.stringify(body) }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})), tenantId);
        if (!response.ok) {
            throw yield toGraphError(response);
        }
        const data = (yield response.json());
        const invitedUser = (_b = data.invitedUser) !== null && _b !== void 0 ? _b : {};
        return {
            id: (_c = data.id) !== null && _c !== void 0 ? _c : "",
            inviteRedeemUrl: (_d = data.inviteRedeemUrl) !== null && _d !== void 0 ? _d : "",
            invitedUser: {
                id: (_e = invitedUser.id) !== null && _e !== void 0 ? _e : "",
                userPrincipalName: (_f = invitedUser.userPrincipalName) !== null && _f !== void 0 ? _f : undefined,
                displayName: (_g = invitedUser.displayName) !== null && _g !== void 0 ? _g : undefined,
            },
            inviteRedirectUrl: (_h = data.inviteRedirectUrl) !== null && _h !== void 0 ? _h : "",
            sendInvitationMessage: Boolean(data.sendInvitationMessage),
            status: (_j = data.status) !== null && _j !== void 0 ? _j : undefined,
        };
    });
}
/**
 * List the verified domains for the calling tenant via the
 * /organization endpoint. Filters to domains that can host user
 * accounts: those whose capabilities include "Email" or whose name
 * ends in ".onmicrosoft.com" (the initial tenant domain).
 */
export function listVerifiedDomains(tenantId, accessToken) {
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        const url = `${GRAPH_BASE}/organization`;
        const response = yield graphFetch(url, { headers: graphHeaders(accessToken) }, tenantId);
        if (!response.ok) {
            throw yield toGraphError(response);
        }
        const data = (yield response.json());
        const orgs = Array.isArray(data.value) ? data.value : [];
        const first = orgs[0];
        if (!first)
            return [];
        const domains = Array.isArray(first.verifiedDomains)
            ? first.verifiedDomains
            : [];
        return domains
            .map((d) => {
            var _a, _b, _c;
            return ({
                name: (_a = d.name) !== null && _a !== void 0 ? _a : "",
                isDefault: Boolean(d.isDefault),
                isInitial: Boolean(d.isInitial),
                type: (_b = d.type) !== null && _b !== void 0 ? _b : "",
                capabilities: (_c = d.capabilities) !== null && _c !== void 0 ? _c : "",
            });
        })
            .filter((d) => {
            if (!d.name)
                return false;
            const caps = d.capabilities.toLowerCase();
            if (caps.includes("email"))
                return true;
            if (d.name.toLowerCase().endsWith(".onmicrosoft.com"))
                return true;
            return false;
        });
    });
}
/**
 * Best-effort mapping of org users to subscription count by inspecting
 * ARM role assignments. Computing this is expensive (one ARM call per
 * subscription, with N pages each), and Graph does not surface the data
 * directly. The signature is stable so the UI can render counts when
 * available; this initial implementation returns an empty array as a
 * conservative fallback that the UI can degrade gracefully against.
 *
 * Note: a full implementation would iterate the caller's accessible
 * subscriptions, list `Microsoft.Authorization/roleAssignments` per
 * subscription, group by `principalId`, and join with the user list
 * returned by `listOrgUsers`. That work is intentionally deferred to a
 * follow-up pass — keep callers using this signature so the upgrade is
 * non-breaking.
 */
export function listOrgSubscriptions(tenantId, _accessToken) {
    return __awaiter(this, void 0, void 0, function* () {
        validateTenantId(tenantId);
        void _accessToken;
        return [];
    });
}
//# sourceMappingURL=graph-service.js.map