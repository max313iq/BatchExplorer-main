/**
 * Batch data plane service layer for multi-region operations.
 *
 * Wraps Batch REST API calls behind simple async functions.
 * Every function takes an explicit `token` parameter — the caller is
 * responsible for acquiring and refreshing tokens.
 *
 * Retry logic is intentionally omitted; that responsibility belongs to
 * the governance / scheduler layer.
 */
import { __awaiter } from "tslib";
import { AzureRequestError, classifyHttpError, } from "./types";
import { guardedFetch } from "../scheduling/request-governance";
import { fetchAllPages as sharedFetchAllPages } from "./_shared/paginate";
import { isBlacklisted } from "../store/failure-blacklist";
const BATCH_API_VERSION = "2024-07-01.20.0";
const BATCH_CONTENT_TYPE = "application/json; odata=minimalmetadata";
function batchFamilyForAccount(accountName) {
    return `batch-${accountName}`;
}
function extractAccountNameFromUrl(url) {
    try {
        const host = new URL(url).hostname;
        const dot = host.indexOf(".");
        return dot > 0 ? host.substring(0, dot) : host;
    }
    catch (_a) {
        return "default";
    }
}
function batchFetch(url, init, accountName) {
    const account = accountName !== null && accountName !== void 0 ? accountName : extractAccountNameFromUrl(url);
    return guardedFetch(url, init, {
        subscriptionId: "default",
        family: batchFamilyForAccount(account),
    });
}
// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
/**
 * Validate that an account endpoint looks like a legitimate Batch endpoint.
 * Prevents SSRF by ensuring the endpoint points to a *.batch.azure.com host.
 */
function validateAccountEndpoint(endpoint) {
    const normalized = endpoint.startsWith("https://")
        ? endpoint
        : `https://${endpoint}`;
    let hostname;
    try {
        hostname = new URL(normalized).hostname;
    }
    catch (_a) {
        throw new Error("Invalid accountEndpoint: must be a valid hostname.");
    }
    if (!hostname.endsWith(".batch.azure.com")) {
        throw new Error("Invalid accountEndpoint: must be a *.batch.azure.com hostname.");
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Build common headers for Batch data plane requests.
 */
function batchHeaders(token, withBody = false) {
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: BATCH_CONTENT_TYPE,
    };
    if (withBody) {
        headers["Content-Type"] = BATCH_CONTENT_TYPE;
    }
    return headers;
}
/**
 * Build a Batch data plane URL.
 *
 * @param accountEndpoint - The account endpoint (e.g. "myaccount.eastus.batch.azure.com").
 * @param path - Relative path (e.g. "/pools").
 * @param extraParams - Additional query parameters beyond api-version.
 */
function batchUrl(accountEndpoint, path, extraParams) {
    const base = accountEndpoint.startsWith("https://")
        ? accountEndpoint
        : `https://${accountEndpoint}`;
    const params = new URLSearchParams(Object.assign({ "api-version": BATCH_API_VERSION }, extraParams));
    return `${base}${path}?${params.toString()}`;
}
/**
 * Parse a non-2xx Batch response into an `AzureRequestError`.
 *
 * The Batch data plane uses THREE different error envelopes across
 * endpoints / api-versions and we need to handle all of them:
 *   1. Standard OData:      `{ error: { code, message: { value } } }`
 *   2. Legacy OData:        `{ "odata.error": { code, message: { value } } }`
 *   3. Flat (no wrapper):   `{ code, message: { value }, "odata.metadata": … }`
 *
 * The flat shape is what `/pools/{id}/removenodes` returns on
 * `InvalidPropertyValue` — without the third branch the parser falls
 * through to `text.slice(0, 400)` and surfaces a truncated raw JSON
 * envelope in the UI instead of the actual reason.
 */
function toBatchError(response) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        // Read once as text so we can fall back to the raw body when JSON
        // parsing fails — empty 409 bodies, plain-text proxy errors, etc.
        const text = yield response.text().catch(() => "");
        let body = {};
        try {
            body = text ? JSON.parse(text) : {};
        }
        catch (_d) {
            body = { raw: text };
        }
        // Walk the three known shapes, preferring the most-specific first.
        // The flat shape is identified by a top-level `code` OR `message`
        // string-or-{value:string}-object on the body itself.
        const isFlatShape = (b) => {
            if (typeof b !== "object" || b === null)
                return false;
            const o = b;
            return typeof o.code === "string" || o.message !== undefined;
        };
        const innerError = (_b = (_a = body === null || body === void 0 ? void 0 : body.error) !== null && _a !== void 0 ? _a : body === null || body === void 0 ? void 0 : body["odata.error"]) !== null && _b !== void 0 ? _b : (isFlatShape(body) ? body : {});
        const rawMessage = (_c = innerError.message) !== null && _c !== void 0 ? _c : undefined;
        const message = (typeof rawMessage === "object" &&
            rawMessage !== null &&
            "value" in rawMessage &&
            typeof rawMessage.value === "string" &&
            rawMessage.value) ||
            (typeof rawMessage === "string" && rawMessage) ||
            (text ? text.slice(0, 400) : `Batch request failed: ${response.status}`);
        const code = (typeof innerError.code === "string" &&
            innerError.code) ||
            "Unknown";
        // Compose the user-facing message: `[<code>] <message> (HTTP <status>)`.
        // Without the code, NodeStateInvalid vs UserAccountExists look
        // identical and the operator has no idea which retry strategy to
        // try.
        const composed = code !== "Unknown" && !message.includes(code)
            ? `[${code}] ${message} (HTTP ${response.status})`
            : `${message} (HTTP ${response.status})`;
        // Pull the URL path (no query) for audit-log context. Batch sometimes
        // returns structured details under `values: [{key, value}]` — surface
        // those on the error instance so the operator can see them in the
        // audit trail without us having to format them into the message.
        const urlPath = (() => {
            try {
                return new URL(response.url).pathname;
            }
            catch (_a) {
                return response.url || undefined;
            }
        })();
        const valuesArr = innerError.values;
        const detailValues = Array.isArray(valuesArr)
            ? valuesArr
                .filter((v) => v && v.key)
                .map((v) => ({ code: v.key, message: v.value }))
            : undefined;
        // Truncate display message at 1000 chars (raw body remains in .body).
        const DISPLAY_MAX = 1000;
        const truncated = composed.length > DISPLAY_MAX
            ? `${composed.slice(0, DISPLAY_MAX)}…[truncated]`
            : composed;
        // Classify so RateLimit/NotFound/Auth branches can `instanceof` rather
        // than read `.status` arithmetic. Keep `Retry-After` for 429 chaining.
        const retryAfterHeader = response.headers.get("Retry-After");
        const err = classifyHttpError(truncated, response.status, code, body, retryAfterHeader);
        if (urlPath)
            err.urlPath = urlPath;
        if (detailValues && detailValues.length > 0)
            err.details = detailValues;
        return err;
    });
}
/**
 * Generic paginated fetch that follows Batch `odata.nextLink` values.
 * Delegates to the shared `_shared/paginate` helper. The Batch-specific
 * bits (`odata.nextLink` field name, `toBatchError` parsing) are
 * captured by the `nextLinkPath` + `fetcher` callbacks.
 */
function fetchAllPages(initialUrl, token, signal) {
    return __awaiter(this, void 0, void 0, function* () {
        return sharedFetchAllPages({
            initialUrl,
            nextLinkPath: (page) => page["odata.nextLink"],
            signal,
            fetcher: (url, sig) => __awaiter(this, void 0, void 0, function* () {
                const response = yield batchFetch(url, Object.assign({ headers: batchHeaders(token) }, (sig ? { signal: sig } : {})));
                if (!response.ok) {
                    throw yield toBatchError(response);
                }
                return response.json();
            }),
        });
    });
}
// ---------------------------------------------------------------------------
// Pool operations
// ---------------------------------------------------------------------------
/**
 * List all pools in a Batch account.
 *
 * Handles pagination via `odata.nextLink` automatically.
 *
 * **Security**: `accountEndpoint` is validated to be a `*.batch.azure.com`
 * hostname to prevent SSRF. The token is sent only to the validated endpoint.
 *
 * @param accountEndpoint - The Batch account endpoint (must be *.batch.azure.com).
 * @param token - Bearer token with `https://batch.core.windows.net/.default` scope.
 * @returns Array of pool objects.
 */
export function listPools(accountEndpoint, token, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        validateAccountEndpoint(accountEndpoint);
        const url = batchUrl(accountEndpoint, "/pools");
        return fetchAllPages(url, token, opts === null || opts === void 0 ? void 0 : opts.signal);
    });
}
/**
 * Create a pool in a Batch account.
 *
 * **Security**: `accountEndpoint` is validated against `*.batch.azure.com`.
 * `poolConfig` is serialized via `JSON.stringify` (no raw interpolation).
 *
 * @param accountEndpoint - The Batch account endpoint (must be *.batch.azure.com).
 * @param poolConfig - Full pool creation body (id, vmSize, etc.).
 * @param token - Bearer token with Batch scope.
 */
export function createPool(accountEndpoint, poolConfig, token, opts) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        validateAccountEndpoint(accountEndpoint);
        // Pre-flight blacklist check: if a previous attempt failed for THIS
        // (vmSize, region) with a non-recoverable Azure error (no quota,
        // unsupported SKU, region-out-of-stock), skip the request entirely.
        // Hammering Azure with attempts we KNOW will 4xx is a fast track to
        // anti-abuse heuristics flagging us.
        const region = extractRegionFromBatchEndpoint(accountEndpoint);
        const vmSize = (_a = poolConfig === null || poolConfig === void 0 ? void 0 : poolConfig.vmSize) !== null && _a !== void 0 ? _a : "";
        if (region && vmSize) {
            const black = isBlacklisted(vmSize, region);
            if (black.blocked) {
                throw new AzureRequestError(`Skipped: (${vmSize}, ${region}) is on the failure blacklist — ${black.reason}`, 409, "BlacklistedVmSizeRegion", { vmSize, region, reason: black.reason });
            }
        }
        const url = batchUrl(accountEndpoint, "/pools");
        const response = yield batchFetch(url, Object.assign({ method: "POST", headers: batchHeaders(token, true), body: JSON.stringify(poolConfig) }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})));
        if (!response.ok) {
            throw yield toBatchError(response);
        }
    });
}
/**
 * Pull the region segment out of a Batch endpoint hostname.
 * Examples:
 *   accountname.eastus.batch.azure.com   → "eastus"
 *   accountname.westeurope.batch.azure.com → "westeurope"
 * Returns null if the host doesn't match the expected pattern.
 */
function extractRegionFromBatchEndpoint(endpoint) {
    var _a;
    try {
        const host = new URL(endpoint).hostname;
        const parts = host.split(".");
        // Pattern: <account>.<region>.batch.azure.com
        if (parts.length >= 4 &&
            parts[parts.length - 1] === "com" &&
            parts[parts.length - 2] === "azure" &&
            parts[parts.length - 3] === "batch") {
            return (_a = parts[parts.length - 4]) !== null && _a !== void 0 ? _a : null;
        }
        return null;
    }
    catch (_b) {
        return null;
    }
}
/**
 * Patch (update) an existing pool.
 *
 * Only the properties included in `patch` are updated. Common patches
 * include changing `targetDedicatedNodes`, `targetLowPriorityNodes`,
 * `startTask`, or `applicationPackageReferences`.
 *
 * **Security**: `accountEndpoint` is validated. `poolId` is URI-encoded.
 *
 * @param accountEndpoint - The Batch account endpoint (must be *.batch.azure.com).
 * @param poolId - ID of the pool to patch.
 * @param patch - Partial pool body with properties to update.
 * @param token - Bearer token with Batch scope.
 */
export function patchPool(accountEndpoint, poolId, patch, token, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        validateAccountEndpoint(accountEndpoint);
        const url = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}`);
        const response = yield batchFetch(url, Object.assign({ method: "PATCH", headers: batchHeaders(token, true), body: JSON.stringify(patch) }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})));
        // Idempotent: treat 404 as success — the pool is gone, the desired
        // patch is trivially satisfied. Caller re-fetches state if it needs
        // to distinguish "patched" from "already gone".
        if (response.status === 404)
            return;
        if (!response.ok) {
            throw yield toBatchError(response);
        }
    });
}
/**
 * Delete a pool from a Batch account.
 *
 * **Security**: `accountEndpoint` is validated. `poolId` is URI-encoded.
 *
 * **Idempotency**: Treats 404 (pool already gone) and 204 (no content)
 * as success — DELETE retried after a partial failure must not re-throw
 * when the resource is already absent. Azure returns 202 for the
 * acknowledgement of an async delete; we treat that as success too, as
 * Batch publishes no Azure-AsyncOperation header on this endpoint —
 * the pool transitions through `deleting` → gone in the background and
 * the caller polls via `listPools` if it needs to confirm.
 *
 * @param accountEndpoint - The Batch account endpoint (must be *.batch.azure.com).
 * @param poolId - ID of the pool to delete.
 * @param token - Bearer token with Batch scope.
 */
export function deletePool(accountEndpoint, poolId, token, opts) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        validateAccountEndpoint(accountEndpoint);
        const url = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}`);
        const response = yield batchFetch(url, Object.assign({ method: "DELETE", headers: batchHeaders(token) }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})));
        // Idempotent retry semantics: a follow-up DELETE on a pool that's
        // already gone (or in the process of being deleted) returns 404 or
        // 409 PoolBeingDeleted. Both indicate the caller's intent is already
        // satisfied — silently succeed rather than surface a confusing error.
        if (response.status === 404) {
            return;
        }
        if (response.status === 409) {
            // Drain the body so we can inspect the error code; PoolBeingDeleted
            // means a prior delete is already in flight — treat as success.
            const peek = yield response.clone().json().catch(() => null);
            const code = (_c = (peek && ((_a = peek.code) !== null && _a !== void 0 ? _a : (_b = peek["odata.error"]) === null || _b === void 0 ? void 0 : _b.code))) !== null && _c !== void 0 ? _c : "";
            if (code === "PoolBeingDeleted")
                return;
        }
        if (!response.ok) {
            throw yield toBatchError(response);
        }
    });
}
// ---------------------------------------------------------------------------
// Node operations
// ---------------------------------------------------------------------------
/**
 * List all compute nodes in a pool.
 *
 * Handles pagination via `odata.nextLink` automatically.
 *
 * **Security**: `accountEndpoint` is validated. `poolId` is URI-encoded.
 *
 * @param accountEndpoint - The Batch account endpoint (must be *.batch.azure.com).
 * @param poolId - ID of the pool to list nodes from.
 * @param token - Bearer token with Batch scope.
 * @returns Array of compute node objects.
 */
export function listNodes(accountEndpoint, poolId, token, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        validateAccountEndpoint(accountEndpoint);
        const url = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}/nodes`);
        return fetchAllPages(url, token, opts === null || opts === void 0 ? void 0 : opts.signal);
    });
}
/**
 * Perform an action on a single compute node (reboot, reimage, etc.).
 *
 * Maps to POST on the node's action endpoint:
 * - reboot:            POST /pools/{poolId}/nodes/{nodeId}/reboot
 * - reimage:           POST /pools/{poolId}/nodes/{nodeId}/reimage
 * - disableScheduling: POST /pools/{poolId}/nodes/{nodeId}/disablescheduling
 * - enableScheduling:  POST /pools/{poolId}/nodes/{nodeId}/enablescheduling
 *
 * **Security**: `accountEndpoint` is validated. `poolId` and `nodeId` are
 * URI-encoded. The `action` parameter is constrained to the `NodeAction` union
 * type and mapped through a fixed lookup -- no arbitrary path injection is possible.
 *
 * @param accountEndpoint - The Batch account endpoint (must be *.batch.azure.com).
 * @param poolId - ID of the pool.
 * @param nodeId - ID of the compute node.
 * @param action - The action to perform.
 * @param token - Bearer token with Batch scope.
 */
export function performNodeAction(accountEndpoint, poolId, nodeId, action, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateAccountEndpoint(accountEndpoint);
        const actionPath = {
            reboot: "reboot",
            reimage: "reimage",
            disableScheduling: "disablescheduling",
            enableScheduling: "enablescheduling",
        };
        const segment = actionPath[action];
        const url = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}/nodes/${encodeURIComponent(nodeId)}/${segment}`);
        const response = yield batchFetch(url, {
            method: "POST",
            headers: batchHeaders(token, true),
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            throw yield toBatchError(response);
        }
    });
}
export function getNodeRemoteLoginSettings(accountEndpoint, poolId, nodeId, token) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        validateAccountEndpoint(accountEndpoint);
        const url = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}/nodes/${encodeURIComponent(nodeId)}/remoteloginsettings`);
        const response = yield batchFetch(url, {
            method: "GET",
            headers: batchHeaders(token, false),
        });
        if (!response.ok) {
            throw yield toBatchError(response);
        }
        const data = (yield response.json());
        return {
            remoteLoginIPAddress: String((_a = data.remoteLoginIPAddress) !== null && _a !== void 0 ? _a : ""),
            remoteLoginPort: Number((_b = data.remoteLoginPort) !== null && _b !== void 0 ? _b : 0),
        };
    });
}
export function createNodeUser(accountEndpoint, poolId, nodeId, user, token) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        validateAccountEndpoint(accountEndpoint);
        if (!(user === null || user === void 0 ? void 0 : user.name) || typeof user.name !== "string") {
            throw new Error("createNodeUser: 'name' is required");
        }
        if (!user.password && !user.sshPublicKey) {
            throw new Error("createNodeUser: must specify either 'password' or 'sshPublicKey'");
        }
        const body = {
            name: user.name,
            isAdmin: !!user.isAdmin,
            expiryTime: (_a = user.expiryTime) !== null && _a !== void 0 ? _a : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };
        if (user.password)
            body.password = user.password;
        if (user.sshPublicKey)
            body.sshPublicKey = user.sshPublicKey;
        const baseUsersUrl = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}/nodes/${encodeURIComponent(nodeId)}/users`);
        const specificUserUrl = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}/nodes/${encodeURIComponent(nodeId)}/users/${encodeURIComponent(user.name)}`);
        // First attempt: plain POST. The happy path for a fresh node.
        let response = yield batchFetch(baseUsersUrl, {
            method: "POST",
            headers: batchHeaders(token, true),
            body: JSON.stringify(body),
        });
        if (response.ok)
            return;
        // 409 here is almost always one of:
        //   - NodeUserExists: a previous Connect attempt left this user behind.
        //   - The node user-account cap (~20) is full from prior clicks.
        // In either case, DELETE the named user (idempotent — 404 means it was
        // never there to begin with) and retry the POST. This makes the
        // operator's "click Connect, retry" workflow self-healing.
        if (response.status === 409) {
            const delResp = yield batchFetch(specificUserUrl, {
                method: "DELETE",
                headers: batchHeaders(token, false),
            });
            // Ignore 404 (no such user). Surface other errors as the original
            // 409 — the operator sees the same error code with no fallback
            // confusion.
            if (!delResp.ok && delResp.status !== 404) {
                throw yield toBatchError(response);
            }
            response = yield batchFetch(baseUsersUrl, {
                method: "POST",
                headers: batchHeaders(token, true),
                body: JSON.stringify(body),
            });
            if (response.ok)
                return;
        }
        throw yield toBatchError(response);
    });
}
/**
 * Remove one or more nodes from a pool.
 *
 * Maps to POST /pools/{poolId}/removenodes.
 *
 * **Security**: `accountEndpoint` is validated. `poolId` is URI-encoded.
 * `nodeIds` are sent in the JSON body (not interpolated into the URL).
 *
 * @param accountEndpoint - The Batch account endpoint (must be *.batch.azure.com).
 * @param poolId - ID of the pool.
 * @param nodeIds - Array of node IDs to remove.
 * @param token - Bearer token with Batch scope.
 */
/**
 * Hard limit on the number of node IDs the Batch `removenodes` API
 * accepts per call. Exceeding this returns `InvalidPropertyValue`
 * (which manifests as a `code: "InvalidPropertyValue"` flat error —
 * see `toBatchError` above). The limit is documented per Microsoft
 * Batch REST API spec for `pool/removenodes`.
 */
const MAX_NODES_PER_REMOVE_CALL = 100;
export function removeNodes(accountEndpoint, poolId, nodeIds, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateAccountEndpoint(accountEndpoint);
        if (nodeIds.length === 0)
            return;
        const url = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}/removenodes`);
        // Batch's removenodes endpoint caps `nodeList` at 100 entries. Chunk
        // sequentially — parallel POSTs to the same pool can race against
        // each other (and against the pool's own resize lock), so we trade
        // a small amount of latency for a much higher success rate on
        // large evictions. A single chunk failure aborts the whole call so
        // the caller's audit trail records the first concrete reason; the
        // caller can re-issue with the remaining node IDs after fixing the
        // root cause.
        for (let i = 0; i < nodeIds.length; i += MAX_NODES_PER_REMOVE_CALL) {
            const chunk = nodeIds.slice(i, i + MAX_NODES_PER_REMOVE_CALL);
            const response = yield batchFetch(url, {
                method: "POST",
                headers: batchHeaders(token, true),
                body: JSON.stringify({ nodeList: chunk }),
            });
            // Idempotent teardown: 404 = pool or nodes already gone — caller's
            // intent ("these nodes shouldn't exist") is satisfied. 409 codes
            // NodeAlreadyRemoved / PoolBeingDeleted / NodeBeingRemoved mean an
            // in-flight removal — also satisfied.
            if (response.status === 404)
                continue;
            if (response.status === 409) {
                const err = yield toBatchError(response);
                if (/NodeAlreadyRemoved|PoolBeingDeleted|NodeBeingRemoved/i.test(err.code)) {
                    continue;
                }
                throw err;
            }
            if (!response.ok) {
                throw yield toBatchError(response);
            }
        }
    });
}
//# sourceMappingURL=batch-service.js.map