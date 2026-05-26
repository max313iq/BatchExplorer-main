/**
 * ARM (Azure Resource Manager) service layer for multi-region operations.
 *
 * Wraps management-plane REST calls behind simple async functions.
 * Every function takes an explicit `token` parameter — the caller is
 * responsible for acquiring and refreshing tokens.
 *
 * Retry logic is intentionally omitted; that responsibility belongs to
 * the governance / scheduler layer.
 */
import { __awaiter } from "tslib";
import { AzureRequestError, ValidationError, classifyHttpError, } from "./types";
import { guardedFetch } from "../scheduling/request-governance";
import { fetchAllPages as sharedFetchAllPages } from "./_shared/paginate";
import { getBatchAccountQuota, invalidateQuotaCache, } from "./quota-service";
const ARM_BASE = "https://management.azure.com";
const ARM_SUBSCRIPTION_API = "2022-12-01";
const ARM_RESOURCE_GROUP_API = "2021-04-01";
const ARM_BATCH_API = "2024-02-01";
const ARM_PROVIDER_API = "2022-12-01";
// Bumped from 2020-05-01 → 2024-04-01 for parity with
// ARM_BILLING_ENROLLMENT_API. The 2020 version is 4+ years old and
// missing fields the UI now reads (per Microsoft Learn changelog for
// Microsoft.Billing/billingProfiles + invoiceSections endpoints).
// Backward-compatible — older fields still serialize.
const ARM_BILLING_API = "2024-04-01";
// Microsoft.Billing/billingAccounts/enrollmentAccounts is only available
// on these api-versions per Azure: 2018-06-30, 2019-10-01-preview,
// 2020-12-15-privatepreview, 2024-04-01, 2024-08-01-preview. The
// 2020-05-01 version used elsewhere returns 404 for this resource type.
const ARM_BILLING_ENROLLMENT_API = "2024-04-01";
const ARM_SUBSCRIPTION_ALIAS_API = "2021-10-01";
const EA_BILLING_ACCOUNT_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EA_ALIAS_NAME_REGEX = /^[a-z0-9-]{3,63}$/;
// Accepts both billing scopes the alias API supports:
//   MCA: .../billingAccounts/{ba}/billingProfiles/{bp}/invoiceSections/{is}
//   EA:  .../billingAccounts/{ba}/enrollmentAccounts/{ea}
const EA_BILLING_SCOPE_REGEX = /^\/providers\/Microsoft\.Billing\/billingAccounts\/[^/]+\/(?:billingProfiles\/[^/]+\/invoiceSections\/[^/]+|enrollmentAccounts\/[^/]+)$/;
const ARM_SUB_RE = /\/subscriptions\/([0-9a-f-]{36})/i;
function extractSubscriptionId(url) {
    const m = ARM_SUB_RE.exec(url);
    return m ? m[1] : "default";
}
function armFetch(url, init, subscriptionId) {
    return guardedFetch(url, init, {
        subscriptionId: subscriptionId !== null && subscriptionId !== void 0 ? subscriptionId : extractSubscriptionId(url),
        family: "arm",
    });
}
/**
 * Compute the next polling interval for an async operation by reading
 * Retry-After from the response. Falls back to the caller's `floorMs`
 * if the header is missing or unparseable, and clamps to `ceilMs` so a
 * 600s server hint can't stall the UI indefinitely.
 *
 * Accepts both the `delta-seconds` and `HTTP-date` Retry-After formats
 * (per RFC 7231 §7.1.3).
 */
function nextPollIntervalMs(headers, floorMs, ceilMs) {
    var _a;
    const raw = (_a = headers.get("Retry-After")) !== null && _a !== void 0 ? _a : headers.get("retry-after");
    if (raw === null || raw === "")
        return floorMs;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) {
        return Math.max(floorMs, Math.min(ceilMs, Math.floor(asNumber * 1000)));
    }
    const asDate = Date.parse(raw);
    if (!Number.isNaN(asDate)) {
        const delta = Math.max(0, asDate - Date.now());
        return Math.max(floorMs, Math.min(ceilMs, delta));
    }
    return floorMs;
}
// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_NAME_REGEX = /^[a-z0-9]{3,24}$/;
/**
 * Validate that a subscription ID matches the expected UUID format.
 * Prevents injection of path-traversal or unexpected segments into ARM URLs.
 */
function validateSubscriptionId(subscriptionId) {
    if (!UUID_REGEX.test(subscriptionId)) {
        throw new Error("Invalid subscriptionId format: must be a valid UUID.");
    }
}
/**
 * Validate that a Batch account name is alphanumeric, 3-24 characters.
 * Azure Batch account names only allow lowercase letters and digits.
 */
function validateAccountName(accountName) {
    if (!ACCOUNT_NAME_REGEX.test(accountName)) {
        throw new Error("Invalid accountName: must be 3-24 lowercase alphanumeric characters.");
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Build common headers for ARM requests.
 */
function armHeaders(token, contentType) {
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
    };
    if (contentType) {
        headers["Content-Type"] = contentType;
    }
    return headers;
}
/**
 * Parse a non-2xx response into an `AzureRequestError`.
 *
 * Azure responses carry their detail in body.error.{code,message,details}.
 * This helper extracts as much context as possible — when the JSON body
 * is empty / malformed (some 400s come back as plain text or html), we
 * fall back to the raw response text so the operator can see WHY the
 * call failed instead of a bare "ARM request failed: 400". The original
 * URL is included so cascading callers can identify the failing step.
 */
function toAzureError(response) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        // Try JSON first; if that fails, capture the raw text so 400 errors
        // that come back as text/html or empty bodies still surface something.
        let body = {};
        let rawText;
        try {
            const text = yield response.text();
            rawText = text;
            if (text && text.trim()) {
                try {
                    body = JSON.parse(text);
                }
                catch (_b) {
                    // Not JSON — keep the raw text for the message fallback.
                }
            }
        }
        catch (_c) {
            // Network read failure; leave body empty.
        }
        const innerError = (_a = body === null || body === void 0 ? void 0 : body.error) !== null && _a !== void 0 ? _a : {};
        const innerMessage = innerError.message;
        const innerCode = innerError.code;
        const innerDetails = innerError.details;
        // Best message available, in order of preference.
        let message;
        if (innerMessage && innerMessage.trim()) {
            message = innerMessage.trim();
        }
        else if (typeof body === "object" && Object.keys(body).length > 0) {
            message = JSON.stringify(body);
        }
        else if (rawText && rawText.trim()) {
            message = rawText.trim().slice(0, 500);
        }
        else {
            message =
                `ARM request failed: ${response.status} ${response.statusText || ""}`.trim();
        }
        // Fold any nested details into the message so a single error toast
        // still shows the policy / quota / validation problem inline.
        if (Array.isArray(innerDetails) && innerDetails.length > 0) {
            const detailLines = innerDetails
                .map((d) => {
                var _a, _b;
                const c = (_a = d.code) !== null && _a !== void 0 ? _a : "";
                const m = (_b = d.message) !== null && _b !== void 0 ? _b : "";
                return c && m ? `  • [${c}] ${m}` : c || m;
            })
                .filter(Boolean)
                .slice(0, 5);
            if (detailLines.length > 0) {
                message = `${message}\n${detailLines.join("\n")}`;
            }
        }
        // Prepend the URL so cascading "list X / list Y" failures can be
        // identified at a glance in the toast / agent log.
        const urlPath = (() => {
            try {
                return new URL(response.url).pathname;
            }
            catch (_a) {
                return response.url;
            }
        })();
        if (urlPath) {
            message = `${response.status} ${urlPath}: ${message}`;
        }
        // Truncate the display message at 1000 chars — the full body remains
        // available on `.body` for callers that need it (and the structured
        // details get attached separately below for programmatic consumers).
        const DISPLAY_MAX = 1000;
        if (message.length > DISPLAY_MAX) {
            message = `${message.slice(0, DISPLAY_MAX)}…[truncated]`;
        }
        // Classify so callers can `instanceof RateLimitError` / `AuthError` /
        // `NotFoundError` rather than read `.status` arithmetic everywhere.
        // The narrower subclasses fall back to `AzureRequestError` when the
        // status code doesn't match a known bucket.
        const retryAfterHeader = response.headers.get("Retry-After");
        const err = classifyHttpError(message, response.status, innerCode !== null && innerCode !== void 0 ? innerCode : "AzureRequestError", body, retryAfterHeader);
        // Attach urlPath + structured details to the error instance so the
        // caller's `auditLog.record({ error: err })` sees them as discrete
        // fields rather than having to parse the message string.
        if (urlPath)
            err.urlPath = urlPath;
        if (Array.isArray(innerDetails) && innerDetails.length > 0) {
            err.details = innerDetails
                .map((d) => ({
                code: d.code,
                message: d.message,
            }))
                .filter((d) => d.code || d.message);
        }
        return err;
    });
}
/**
 * Poll an Azure async operation until it completes or times out.
 *
 * Azure long-running operations return 202 with a Location or
 * Azure-AsyncOperation header. They also publish a `Retry-After` header
 * (seconds) hinting at the next-poll interval. We honor that hint —
 * polling earlier wastes ARM budget AND can trip 429.
 *
 * The poll wait is `max(intervalMs, Retry-After * 1000)` capped at 60s
 * so a misbehaving server can't stall us indefinitely.
 */
function pollAsyncOperation(pollUrl, token, timeoutMs = 300000, // 5 minutes
intervalMs = 5000) {
    var _a, _b, _c, _d, _e, _f, _g;
    return __awaiter(this, void 0, void 0, function* () {
        const startTime = Date.now();
        const MAX_INTERVAL_MS = 60000;
        let nextWaitMs = intervalMs;
        while (Date.now() - startTime < timeoutMs) {
            yield new Promise((resolve) => setTimeout(resolve, nextWaitMs));
            const response = yield armFetch(pollUrl, {
                headers: armHeaders(token),
            });
            // Refresh wait from Retry-After on every response. Honored regardless
            // of status — Azure may signal "back off" on 200s too if budget is tight.
            nextWaitMs = nextPollIntervalMs(response.headers, intervalMs, MAX_INTERVAL_MS);
            if (response.status === 200 || response.status === 201) {
                // Operation complete — return the final resource
                const body = (yield response.json());
                return { status: "Succeeded", body };
            }
            if (response.status === 202) {
                // Still in progress — check for updated Location header
                const newUrl = (_a = response.headers.get("Location")) !== null && _a !== void 0 ? _a : response.headers.get("Azure-AsyncOperation");
                if (newUrl) {
                    pollUrl = newUrl;
                }
                // Continue polling — wait already updated from Retry-After above
                continue;
            }
            if (!response.ok) {
                // Operation failed
                const errorBody = (yield response.json().catch(() => ({})));
                const innerErr = errorBody === null || errorBody === void 0 ? void 0 : errorBody.error;
                throw new AzureRequestError((_b = innerErr === null || innerErr === void 0 ? void 0 : innerErr.message) !== null && _b !== void 0 ? _b : `Async operation failed: ${response.status}`, response.status, (_c = innerErr === null || innerErr === void 0 ? void 0 : innerErr.code) !== null && _c !== void 0 ? _c : "AsyncOperationFailed", errorBody);
            }
            // Check if response body has a terminal status
            const body = (yield response.json().catch(() => ({})));
            const props = body === null || body === void 0 ? void 0 : body.properties;
            const opStatus = ((_e = (_d = body === null || body === void 0 ? void 0 : body.status) !== null && _d !== void 0 ? _d : props === null || props === void 0 ? void 0 : props.provisioningState) !== null && _e !== void 0 ? _e : "").toLowerCase();
            if (opStatus === "succeeded" || opStatus === "completed") {
                return { status: "Succeeded", body };
            }
            if (opStatus === "failed" ||
                opStatus === "canceled" ||
                opStatus === "cancelled") {
                const errInner = body === null || body === void 0 ? void 0 : body.error;
                throw new AzureRequestError((_f = errInner === null || errInner === void 0 ? void 0 : errInner.message) !== null && _f !== void 0 ? _f : `Operation ${opStatus}`, response.status, (_g = errInner === null || errInner === void 0 ? void 0 : errInner.code) !== null && _g !== void 0 ? _g : "OperationFailed", body);
            }
            // Still in progress (InProgress, Creating, etc.) — continue polling
        }
        // Timeout
        throw new AzureRequestError(`Async operation timed out after ${timeoutMs / 1000}s`, 408, "OperationTimeout", {});
    });
}
/**
 * Generic paginated fetch that follows ARM `nextLink` values.
 * Delegates to the shared `_shared/paginate` helper so the loop, abort
 * handling, and progressive-render hook stay in one place across
 * arm / graph / batch / quota services.
 */
function fetchAllPages(initialUrl, token, signal) {
    return __awaiter(this, void 0, void 0, function* () {
        return sharedFetchAllPages({
            initialUrl,
            nextLinkPath: (page) => page.nextLink,
            signal,
            fetcher: (url, sig) => __awaiter(this, void 0, void 0, function* () {
                const response = yield armFetch(url, Object.assign({ headers: armHeaders(token) }, (sig ? { signal: sig } : {})));
                if (!response.ok) {
                    throw yield toAzureError(response);
                }
                return response.json();
            }),
        });
    });
}
const PROVIDER_NAMESPACE_REGEX = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;
function validateProviderNamespace(namespace) {
    if (!PROVIDER_NAMESPACE_REGEX.test(namespace)) {
        throw new Error(`Invalid provider namespace: must match ${PROVIDER_NAMESPACE_REGEX}`);
    }
}
/**
 * Get the registration state of a single resource provider on a subscription.
 */
export function getProviderRegistration(subscriptionId, namespace, token) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        validateProviderNamespace(namespace);
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/providers/${encodeURIComponent(namespace)}` +
            `?api-version=${ARM_PROVIDER_API}`;
        const response = yield armFetch(url, { headers: armHeaders(token) });
        if (!response.ok) {
            throw yield toAzureError(response);
        }
        const body = (yield response.json());
        return {
            namespace: (_a = body.namespace) !== null && _a !== void 0 ? _a : namespace,
            registrationState: (_b = body.registrationState) !== null && _b !== void 0 ? _b : "Unknown",
        };
    });
}
/**
 * Trigger registration of a resource provider on a subscription.
 * Idempotent — registering an already-registered provider is a no-op
 * server-side.
 */
export function registerProvider(subscriptionId, namespace, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        validateProviderNamespace(namespace);
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/providers/${encodeURIComponent(namespace)}/register` +
            `?api-version=${ARM_PROVIDER_API}`;
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token),
        });
        if (!response.ok) {
            throw yield toAzureError(response);
        }
    });
}
// In-memory cache of namespaces confirmed Registered for a given
// subscription within this session. Avoids redundant GETs across multiple
// provisioning runs.
const _registeredCache = new Map();
/**
 * Ensure each listed namespace is in `Registered` state on the
 * subscription. For any that aren't, POST register and poll until they
 * reach `Registered` or the timeout elapses.
 *
 * Returns lists of namespaces that were already registered vs. newly
 * registered, so callers can log what changed.
 *
 * Throws `AzureRequestError` if a namespace fails to register (permission
 * denied, timeout, etc.) — the caller should surface this to the user
 * because Batch account creation will otherwise fail with the cryptic
 * `MissingSubscriptionRegistration` 409.
 */
export function ensureProvidersRegistered(subscriptionId, namespaces, token, opts = {}) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        const timeoutMs = (_a = opts.timeoutMs) !== null && _a !== void 0 ? _a : 120000;
        const intervalMs = (_b = opts.intervalMs) !== null && _b !== void 0 ? _b : 5000;
        const cached = (_c = _registeredCache.get(subscriptionId)) !== null && _c !== void 0 ? _c : new Set();
        const alreadyRegistered = [];
        const newlyRegistered = [];
        // Parallel fan-out: each namespace registration is independent, so we
        // run them concurrently (4 namespaces × ~10 polls each). Previously
        // the loop was serial, multiplying total wall time by N. Promise.all
        // here is bounded — REQUIRED_PROVIDERS in provisioner-agent has ≤ 4
        // entries, well within ARM's per-sub concurrency cap. Each underlying
        // ARM call still flows through guardedFetch's circuit breaker so a
        // throttle in one namespace doesn't cascade.
        yield Promise.all(namespaces.map((namespace) => __awaiter(this, void 0, void 0, function* () {
            if (cached.has(namespace)) {
                alreadyRegistered.push(namespace);
                return;
            }
            const initial = yield getProviderRegistration(subscriptionId, namespace, token);
            if (initial.registrationState === "Registered") {
                alreadyRegistered.push(namespace);
                cached.add(namespace);
                return;
            }
            if (initial.registrationState !== "Registering") {
                yield registerProvider(subscriptionId, namespace, token);
            }
            const start = Date.now();
            let lastState = initial.registrationState;
            while (Date.now() - start < timeoutMs) {
                yield new Promise((r) => setTimeout(r, intervalMs));
                const cur = yield getProviderRegistration(subscriptionId, namespace, token);
                lastState = cur.registrationState;
                if (lastState === "Registered")
                    break;
            }
            if (lastState !== "Registered") {
                throw new AzureRequestError(`Provider ${namespace} did not reach Registered state within ${timeoutMs / 1000}s on subscription ${subscriptionId} (last state: ${lastState}).`, 408, "ProviderRegistrationTimeout", {});
            }
            cached.add(namespace);
            newlyRegistered.push(namespace);
        })));
        _registeredCache.set(subscriptionId, cached);
        return { alreadyRegistered, newlyRegistered };
    });
}
/**
 * Test-only: clear the in-memory provider-registration cache.
 */
export function _resetProviderRegistrationCacheForTest() {
    _registeredCache.clear();
}
/**
 * List all Azure subscriptions accessible with the provided token.
 *
 * **Security**: The token is sent as a Bearer header only to the hardcoded
 * ARM endpoint. No user input is interpolated into the URL.
 *
 * @param token - Bearer token with `https://management.azure.com/.default` scope.
 * @returns Array of subscriptions with id, displayName, state, and tenantId.
 */
export function listSubscriptions(token, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${ARM_BASE}/subscriptions?api-version=${ARM_SUBSCRIPTION_API}`;
        return fetchAllPages(url, token, opts === null || opts === void 0 ? void 0 : opts.signal);
    });
}
// ---------------------------------------------------------------------------
// Resource Manager — resource groups + cross-subscription move
// ---------------------------------------------------------------------------
/** List resource groups in a subscription (used as move destinations). */
export function listResourceGroups(subscriptionId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/resourcegroups?api-version=${ARM_RESOURCE_GROUP_API}`;
        return fetchAllPages(url, token);
    });
}
function postMoveRequest(url, body, token) {
    var _a, _b, _c, _d;
    return __awaiter(this, void 0, void 0, function* () {
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify(body),
        });
        // Immediate non-async response (rare).
        if (response.status === 200 || response.status === 204) {
            return { status: response.status, ok: true };
        }
        if (response.status === 202) {
            const pollUrl = (_a = response.headers.get("Azure-AsyncOperation")) !== null && _a !== void 0 ? _a : response.headers.get("Location");
            if (!pollUrl) {
                return {
                    status: 202,
                    ok: true,
                    error: "ARM accepted the operation but returned no Location header.",
                };
            }
            try {
                const result = yield pollAsyncOperation(pollUrl, token);
                // pollAsyncOperation throws on failure; reaching here means the op
                // succeeded ("Succeeded"/"completed"). Map to HTTP 200 for the
                // numeric ResourceMoveOutcome.status contract.
                const ok = result.status.toLowerCase() === "succeeded" ||
                    result.status.toLowerCase() === "completed";
                return {
                    status: ok ? 200 : 500,
                    ok,
                    body: result.body,
                    error: ok
                        ? undefined
                        : ((_d = (_c = (_b = result.body) === null || _b === void 0 ? void 0 : _b.error) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Move operation failed."),
                };
            }
            catch (pollErr) {
                return {
                    status: 0,
                    ok: false,
                    error: pollErr instanceof Error ? pollErr.message : String(pollErr),
                };
            }
        }
        // Sync error path.
        const err = yield toAzureError(response);
        return { status: response.status, ok: false, error: err.message };
    });
}
/**
 * Pre-flight move validation — same body as moveResources but the ARM
 * endpoint only runs the dependency/lock checks. Surfaces granular
 * per-resource errors so the UI can show what would fail before the
 * operator commits to the actual move.
 */
export function validateMoveResources(sourceSubscriptionId, sourceResourceGroupName, resourceIds, targetResourceGroupArmId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(sourceSubscriptionId);
        if (!sourceResourceGroupName) {
            throw new ValidationError("sourceResourceGroupName is required.", "InvalidInput", { field: "sourceResourceGroupName" });
        }
        if (resourceIds.length === 0) {
            throw new ValidationError("At least one resourceId is required.", "InvalidInput", { field: "resourceIds" });
        }
        if (!targetResourceGroupArmId.startsWith("/subscriptions/")) {
            throw new ValidationError("targetResourceGroupArmId must be a full /subscriptions/{id}/resourceGroups/{name} ARM path.", "InvalidInput", { field: "targetResourceGroupArmId" });
        }
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(sourceSubscriptionId)}` +
            `/resourceGroups/${encodeURIComponent(sourceResourceGroupName)}` +
            `/validateMoveResources?api-version=${ARM_RESOURCE_GROUP_API}`;
        return postMoveRequest(url, { resources: resourceIds, targetResourceGroup: targetResourceGroupArmId }, token);
    });
}
/**
 * Move resources from one resource group to another (potentially in a
 * different subscription). ARM accepts up to 800 resources per call;
 * the caller is responsible for chunking if more than that.
 *
 * For Batch accounts specifically: source + destination subscriptions
 * must be in the same tenant, the destination must allow
 * `Microsoft.Batch/batchAccounts`, and no resource lock on the source
 * RG or any of the resources.
 */
export function moveResources(sourceSubscriptionId, sourceResourceGroupName, resourceIds, targetResourceGroupArmId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(sourceSubscriptionId);
        if (!sourceResourceGroupName) {
            throw new ValidationError("sourceResourceGroupName is required.", "InvalidInput", { field: "sourceResourceGroupName" });
        }
        if (resourceIds.length === 0) {
            throw new ValidationError("At least one resourceId is required.", "InvalidInput", { field: "resourceIds" });
        }
        if (resourceIds.length > 800) {
            throw new ValidationError("moveResources accepts at most 800 resources per call. Chunk and call repeatedly.", "InvalidInput", { field: "resourceIds" });
        }
        if (!targetResourceGroupArmId.startsWith("/subscriptions/")) {
            throw new ValidationError("targetResourceGroupArmId must be a full /subscriptions/{id}/resourceGroups/{name} ARM path.", "InvalidInput", { field: "targetResourceGroupArmId" });
        }
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(sourceSubscriptionId)}` +
            `/resourceGroups/${encodeURIComponent(sourceResourceGroupName)}` +
            `/moveResources?api-version=${ARM_RESOURCE_GROUP_API}`;
        return postMoveRequest(url, { resources: resourceIds, targetResourceGroup: targetResourceGroupArmId }, token);
    });
}
// ---------------------------------------------------------------------------
// Subscription mover — change-tenant + EA billing-subscription transfer
// ---------------------------------------------------------------------------
/**
 * Initiate a "Change tenant" operation on a subscription. Moves the
 * subscription's AAD home tenant to `destinationTenantId`. The call
 * returns 202 + Azure-AsyncOperation; the operation can take several
 * minutes and may require an admin in the destination tenant to accept
 * the offer (depending on the source tenant's "default subscription
 * directory transfer" policy).
 *
 * Source: https://learn.microsoft.com/rest/api/subscription/subscriptions/change-tenant
 */
export function changeSubscriptionTenant(subscriptionId, destinationTenantId, token) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        if (!UUID_REGEX.test(destinationTenantId)) {
            throw new Error("destinationTenantId must be a UUID.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Subscription/subscriptions/` +
            `${encodeURIComponent(subscriptionId)}/changeTenant` +
            `?api-version=2021-10-01`;
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ properties: { tenantId: destinationTenantId } }),
        });
        if (!response.ok && response.status !== 202)
            throw yield toAzureError(response);
        return {
            status: response.status,
            location: (_b = (_a = response.headers.get("Azure-AsyncOperation")) !== null && _a !== void 0 ? _a : response.headers.get("Location")) !== null && _b !== void 0 ? _b : undefined,
        };
    });
}
/**
 * Move an EA billing subscription to a different enrollment account
 * inside the same billing account. The destination ARM id is the full
 * `/providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea}`
 * path. Returns 202 + Location; the operation is async (1–5 min).
 */
export function moveBillingSubscriptionToEnrollmentAccount(billingAccountName, billingSubscriptionName, destinationEnrollmentAccountArmId, token) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        validateBillingAccountName(billingSubscriptionName);
        if (!destinationEnrollmentAccountArmId.includes("/enrollmentAccounts/")) {
            throw new Error("destinationEnrollmentAccountArmId must be a full enrollmentAccounts ARM path.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingSubscriptions/${encodeURIComponent(billingSubscriptionName)}` +
            `/move?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({
                destinationEnrollmentAccountId: destinationEnrollmentAccountArmId,
            }),
        });
        if (!response.ok && response.status !== 202)
            throw yield toAzureError(response);
        return {
            status: response.status,
            location: (_a = response.headers.get("Location")) !== null && _a !== void 0 ? _a : undefined,
        };
    });
}
// ---------------------------------------------------------------------------
// Subscription-scope RBAC role assignment
// ---------------------------------------------------------------------------
/**
 * Well-known Azure RBAC role definition GUID for "Owner" — full
 * resource-management privilege at the assigned scope plus the right to
 * delegate access to others.
 *
 * Source: https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
 */
export const AZURE_ROLE_OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
/** API version that supports `principalType` (avoids 400 on guest users). */
const ARM_ROLE_ASSIGNMENT_API = "2022-04-01";
/**
 * Assign an Azure RBAC role to a principal at subscription scope.
 *
 * Uses a fresh GUID as the assignment resource name and PUTs to
 * `/subscriptions/{id}/providers/Microsoft.Authorization/roleAssignments/{guid}`.
 * The caller's token must hold `Microsoft.Authorization/roleAssignments/write`
 * at this scope (Owner or User Access Administrator).
 *
 * Idempotency: ARM returns 409 with code `RoleAssignmentExists` when the
 * principal already holds the requested role at the requested scope. We
 * surface that as a successful no-op so the call is safe to retry.
 */
export function assignSubscriptionRole(subscriptionId, principalObjectId, roleDefinitionGuid, token, opts) {
    var _a, _b, _c, _d, _e, _f;
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        if (!UUID_REGEX.test(principalObjectId)) {
            throw new Error("Invalid principalObjectId: must be a valid UUID.");
        }
        if (!UUID_REGEX.test(roleDefinitionGuid)) {
            throw new Error("Invalid roleDefinitionGuid: must be a valid UUID.");
        }
        const assignmentName = crypto.randomUUID();
        const scope = `/subscriptions/${subscriptionId}`;
        const url = `${ARM_BASE}${scope}` +
            `/providers/Microsoft.Authorization/roleAssignments/${assignmentName}` +
            `?api-version=${ARM_ROLE_ASSIGNMENT_API}`;
        const body = {
            properties: {
                roleDefinitionId: `${scope}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionGuid}`,
                principalId: principalObjectId,
                principalType: (_a = opts === null || opts === void 0 ? void 0 : opts.principalType) !== null && _a !== void 0 ? _a : "User",
            },
        };
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify(body),
        }, subscriptionId);
        if (response.ok) {
            const data = (yield response.json());
            return { roleAssignmentId: (_b = data.id) !== null && _b !== void 0 ? _b : assignmentName, alreadyExisted: false };
        }
        // ARM returns 409 + code RoleAssignmentExists when the principal already
        // holds the role at this scope. Treat as idempotent success.
        if (response.status === 409) {
            const body409 = yield response.json().catch(() => ({}));
            const code = String((_d = (_c = body409 === null || body409 === void 0 ? void 0 : body409.error) === null || _c === void 0 ? void 0 : _c.code) !== null && _d !== void 0 ? _d : "");
            if (code === "RoleAssignmentExists") {
                return { roleAssignmentId: assignmentName, alreadyExisted: true };
            }
            throw new AzureRequestError((_f = (_e = body409 === null || body409 === void 0 ? void 0 : body409.error) === null || _e === void 0 ? void 0 : _e.message) !== null && _f !== void 0 ? _f : "Role assignment conflict.", 409, code || "Conflict", body409);
        }
        throw yield toAzureError(response);
    });
}
/**
 * List every role assignment visible at a subscription's scope, including
 * those inherited from management group / tenant scopes. The `atScope`
 * field on each row tells the UI whether deletion at the sub scope is
 * meaningful (deleting an inherited assignment at sub scope is a no-op /
 * 404 — Azure only allows deleting at the scope the assignment was
 * created at).
 */
export function listSubscriptionRoleAssignments(subscriptionId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        const scope = `/subscriptions/${subscriptionId}`;
        const url = `${ARM_BASE}${scope}` +
            `/providers/Microsoft.Authorization/roleAssignments` +
            `?api-version=${ARM_ROLE_ASSIGNMENT_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => { var _a; return r.id && r.name && ((_a = r.properties) === null || _a === void 0 ? void 0 : _a.roleDefinitionId); })
            .map((r) => {
            var _a, _b, _c, _d;
            const props = r.properties;
            const rdId = props.roleDefinitionId;
            const rdGuid = (_a = rdId.split("/").pop()) !== null && _a !== void 0 ? _a : rdId;
            const rowScope = (_b = props.scope) !== null && _b !== void 0 ? _b : scope;
            return {
                id: r.id,
                name: r.name,
                roleDefinitionId: rdGuid,
                roleDefinitionIdFull: rdId,
                principalId: (_c = props.principalId) !== null && _c !== void 0 ? _c : "",
                principalType: (_d = props.principalType) !== null && _d !== void 0 ? _d : "Unknown",
                scope: rowScope,
                atScope: rowScope.toLowerCase() === scope.toLowerCase() ||
                    rowScope.toLowerCase().startsWith(`${scope.toLowerCase()}/`),
                createdOn: props.createdOn,
                description: props.description,
            };
        });
    });
}
/**
 * Delete a role assignment by its full ARM resource id. The ARM API
 * returns 204 No Content on success and 204 / 404 on "already gone" —
 * both are treated as success here so a retry after a partial failure
 * is safe.
 */
export function deleteRoleAssignment(roleAssignmentArmId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        // Defensive sanity check — the id must look like an ARM resource path.
        if (!roleAssignmentArmId.startsWith("/") ||
            !roleAssignmentArmId.includes("/Microsoft.Authorization/roleAssignments/")) {
            throw new Error("Invalid roleAssignmentArmId: must be a full ARM resource path.");
        }
        const url = `${ARM_BASE}${roleAssignmentArmId}` +
            `?api-version=${ARM_ROLE_ASSIGNMENT_API}`;
        const response = yield armFetch(url, {
            method: "DELETE",
            headers: armHeaders(token),
        }, extractSubscriptionId(roleAssignmentArmId));
        if (response.ok || response.status === 204 || response.status === 404) {
            return;
        }
        throw yield toAzureError(response);
    });
}
/**
 * List role definitions visible at a subscription scope. Includes both
 * built-in roles (Owner, Contributor, Reader, …) and any custom roles
 * defined at or above the subscription.
 */
export function listSubscriptionRoleDefinitions(subscriptionId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        const scope = `/subscriptions/${subscriptionId}`;
        const url = `${ARM_BASE}${scope}` +
            `/providers/Microsoft.Authorization/roleDefinitions` +
            `?api-version=${ARM_ROLE_ASSIGNMENT_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f;
            return ({
                id: r.name,
                armId: r.id,
                name: (_b = (_a = r.properties) === null || _a === void 0 ? void 0 : _a.roleName) !== null && _b !== void 0 ? _b : r.name,
                description: (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.description) !== null && _d !== void 0 ? _d : "",
                type: (_f = (_e = r.properties) === null || _e === void 0 ? void 0 : _e.type) !== null && _f !== void 0 ? _f : "BuiltInRole",
            });
        });
    });
}
/**
 * List all Batch accounts in a subscription.
 *
 * Handles pagination via `nextLink` automatically.
 *
 * **Security**: `subscriptionId` is validated as a UUID and URI-encoded
 * before interpolation. No secrets are stored or logged.
 *
 * @param subscriptionId - Azure subscription ID (must be a valid UUID).
 * @param token - Bearer token with ARM scope.
 * @returns Array of Batch account resources.
 */
export function listBatchAccounts(subscriptionId, token, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/providers/Microsoft.Batch/batchAccounts` +
            `?api-version=${ARM_BATCH_API}`;
        return fetchAllPages(url, token, opts === null || opts === void 0 ? void 0 : opts.signal);
    });
}
/**
 * Get a single Batch account with full details including quota information.
 *
 * **Security**: All path segments (`subscriptionId`, `resourceGroup`,
 * `accountName`) are validated and URI-encoded before interpolation.
 * Error responses are wrapped in `AzureRequestError` — internal
 * details from the body are preserved only for programmatic handling,
 * not for display to end-users.
 *
 * @param subscriptionId - Azure subscription ID (must be a valid UUID).
 * @param resourceGroup - Resource group containing the account.
 * @param accountName - Batch account name (3-24 lowercase alphanumeric chars).
 * @param token - Bearer token with ARM scope.
 * @returns The Batch account resource.
 */
export function getBatchAccount(subscriptionId, resourceGroup, accountName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        validateAccountName(accountName);
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
            `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
            `?api-version=${ARM_BATCH_API}`;
        const response = yield armFetch(url, {
            headers: armHeaders(token),
        });
        if (!response.ok) {
            throw yield toAzureError(response);
        }
        return response.json();
    });
}
/**
 * Create (or update) a resource group.
 *
 * Uses PUT semantics -- the call is idempotent. If the resource group
 * already exists in the same location, this is a no-op.
 *
 * **Security**: `subscriptionId` is validated as a UUID. `rgName` and
 * `location` are URI-encoded. Only the `location` field is sent in the
 * request body.
 *
 * @param subscriptionId - Azure subscription ID (must be a valid UUID).
 * @param rgName - Name for the resource group.
 * @param location - Azure region (e.g. "eastus").
 * @param token - Bearer token with ARM scope.
 * @returns The created or updated resource group.
 */
export function createResourceGroup(subscriptionId, rgName, location, token) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/resourcegroups/${encodeURIComponent(rgName)}` +
            `?api-version=${ARM_RESOURCE_GROUP_API}`;
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ location }),
        });
        // Handle async creation (unlikely for RGs but be safe). When a 202
        // doesn't carry a Location/Azure-AsyncOperation header (rare but ARM
        // historically allows it on idempotent PUTs), fall back to polling
        // the resource URL directly until it reports a terminal
        // provisioningState rather than blindly parsing an empty body.
        if (response.status === 202) {
            const pollUrl = (_a = response.headers.get("Location")) !== null && _a !== void 0 ? _a : response.headers.get("Azure-AsyncOperation");
            if (pollUrl) {
                const result = yield pollAsyncOperation(pollUrl, token);
                return result.body;
            }
            // No header — poll the resource URL itself.
            const result = yield pollAsyncOperation(url, token);
            return result.body;
        }
        if (!response.ok) {
            throw yield toAzureError(response);
        }
        return response.json();
    });
}
/**
 * Create a Batch account via ARM PUT.
 *
 * This is a long-running operation -- the response may return 202 Accepted
 * with a Location header for polling. The returned object reflects the
 * initial response body, which may have `provisioningState: "Creating"`.
 *
 * **Security**: `subscriptionId` is validated as a UUID, `accountName` is
 * validated as 3-24 lowercase alphanumeric characters. All path segments
 * are URI-encoded. The request body contains only `location` and
 * `properties.autoStorage: null`.
 *
 * @param subscriptionId - Azure subscription ID (must be a valid UUID).
 * @param resourceGroup - Resource group for the account.
 * @param accountName - Batch account name (3-24 chars, lowercase alphanumeric).
 * @param location - Azure region.
 * @param token - Bearer token with ARM scope.
 * @returns The Batch account resource (may still be provisioning).
 */
export function createBatchAccount(subscriptionId, resourceGroup, accountName, location, token, opts) {
    var _a, _b, _c, _d, _e;
    return __awaiter(this, void 0, void 0, function* () {
        validateSubscriptionId(subscriptionId);
        validateAccountName(accountName);
        // Pre-flight quota check. Azure caps Batch accounts per (sub, region),
        // typically at 1 by default and 3 after a support-ticket bump. Hitting
        // the cap returns 4xx and is one of the loudest abuse-flag signals
        // we can emit, because the same caller keeps retrying the same impossible
        // create. The quota service caches for 15 min so consecutive provision
        // attempts don't re-query.
        //
        // Failure here is FAIL-OPEN: if the quota probe itself errors (RBAC,
        // transient 5xx), we proceed to the create — better to attempt the
        // operation than to block on a stale cache miss.
        try {
            const quota = yield getBatchAccountQuota(subscriptionId, location, token);
            if (quota.available <= 0) {
                throw new AzureRequestError(`Skipped: Batch account quota for region "${location}" is exhausted ` +
                    `(${quota.currentCount}/${quota.accountQuota} used). ` +
                    `Open a support ticket to raise the quota or pick another region.`, 409, "BatchAccountQuotaExhausted", {
                    subscriptionId,
                    location,
                    accountQuota: quota.accountQuota,
                    currentCount: quota.currentCount,
                });
            }
        }
        catch (err) {
            if (err instanceof AzureRequestError && err.code === "BatchAccountQuotaExhausted") {
                throw err;
            }
            // Probe failed for some other reason — fall through to the create.
        }
        const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
            `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
            `?api-version=${ARM_BATCH_API}`;
        const response = yield armFetch(url, Object.assign({ method: "PUT", headers: armHeaders(token, "application/json"), body: JSON.stringify({
                location,
                properties: {
                    autoStorage: null,
                },
            }) }, ((opts === null || opts === void 0 ? void 0 : opts.signal) ? { signal: opts.signal } : {})));
        // Successful create changes the count — invalidate the cached quota
        // entry so the next probe reflects the new state immediately.
        if (response.ok || response.status === 202) {
            invalidateQuotaCache(subscriptionId, location);
        }
        // Handle async creation (202 Accepted)
        if (response.status === 202) {
            const pollUrl = (_a = response.headers.get("Location")) !== null && _a !== void 0 ? _a : response.headers.get("Azure-AsyncOperation");
            if (pollUrl) {
                const result = yield pollAsyncOperation(pollUrl, token);
                return result.body;
            }
            // No async-operation header — poll the resource URL directly until
            // provisioningState reaches a terminal value. Falling through to
            // `response.json()` on a 202 body is unsafe (the body is empty),
            // and returning the body shape mid-flight would mislead callers
            // into thinking creation already completed.
            const resourceUrl = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
                `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
                `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
                `?api-version=${ARM_BATCH_API}`;
            const result = yield pollAsyncOperation(resourceUrl, token);
            return result.body;
        }
        if (!response.ok) {
            throw yield toAzureError(response);
        }
        // 200 or 201 — synchronous success
        const account = (yield response.json());
        // Verify provisioningState if present
        const provState = (_b = account === null || account === void 0 ? void 0 : account.properties) === null || _b === void 0 ? void 0 : _b.provisioningState;
        if (provState && provState !== "Succeeded" && provState !== "succeeded") {
            // Account is still provisioning — poll the resource URL directly
            const resourceUrl = `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
                `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
                `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
                `?api-version=${ARM_BATCH_API}`;
            const maxWaitMs = 120000; // 2 minutes
            const MIN_POLL_MS = 5000;
            const MAX_POLL_MS = 60000;
            let pollMs = MIN_POLL_MS;
            const start = Date.now();
            while (Date.now() - start < maxWaitMs) {
                yield new Promise((r) => setTimeout(r, pollMs));
                const pollResp = yield armFetch(resourceUrl, {
                    headers: armHeaders(token),
                });
                // Honor Retry-After if Azure published a hint on the resource probe.
                pollMs = nextPollIntervalMs(pollResp.headers, MIN_POLL_MS, MAX_POLL_MS);
                if (pollResp.ok) {
                    const polled = (yield pollResp.json());
                    const state = (_c = polled === null || polled === void 0 ? void 0 : polled.properties) === null || _c === void 0 ? void 0 : _c.provisioningState;
                    if (state === "Succeeded" || state === "succeeded") {
                        return polled;
                    }
                    if (state === "Failed" || state === "Canceled") {
                        throw new AzureRequestError(`Batch account creation ${state}: ${(_e = (_d = polled === null || polled === void 0 ? void 0 : polled.properties) === null || _d === void 0 ? void 0 : _d.statusText) !== null && _e !== void 0 ? _e : ""}`, 400, `ProvisioningState${state}`, polled);
                    }
                }
            }
        }
        return account;
    });
}
// ---------------------------------------------------------------------------
// Enterprise Agreement (EA) — billing accounts, profiles, invoice sections,
// and subscription-alias creation.
// ---------------------------------------------------------------------------
function validateBillingAccountName(name) {
    if (!EA_BILLING_ACCOUNT_NAME_REGEX.test(name)) {
        throw new Error("Invalid billingAccountName: contains illegal characters.");
    }
}
function validateAliasName(name) {
    if (!EA_ALIAS_NAME_REGEX.test(name)) {
        throw new Error("Invalid aliasName: must be 3-63 chars of lowercase a-z, 0-9, or '-'.");
    }
}
function validateBillingScope(scope) {
    if (!EA_BILLING_SCOPE_REGEX.test(scope)) {
        throw new Error("Invalid billingScope: expected /providers/Microsoft.Billing/billingAccounts/{ba}/billingProfiles/{bp}/invoiceSections/{is} (MCA) or /providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea} (EA enrollment).");
    }
}
/**
 * List all EA (Enterprise Agreement) billing accounts visible to the caller.
 *
 * Tries server-side `agreementType eq 'EnterpriseAgreement'` first; some
 * tenants / token scopes get 400 BadRequest on the $filter. When that
 * happens we fall back to listing every billing account and filtering
 * client-side, so MCA / MOSP / partner billing accounts are still
 * excluded from the EA badge.
 */
/**
 * List every billing account visible to the caller, regardless of
 * agreementType. Unlike {@link listEaBillingAccounts} this includes
 * MicrosoftCustomerAgreement, MicrosoftPartnerAgreement, and the
 * legacy MicrosoftOnlineServicesProgram (MOSP) accounts. MOSP accounts
 * have no enrollmentAccounts collection — their subs hang directly off
 * the billing account — so any UI that uses this list must handle
 * the "no enrollment account" path (e.g. by setting billingScope to
 * the billing account ARM id directly).
 */
export function listAllBillingAccountsAnyAgreementType(token) {
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts` +
            `?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
            return ({
                id: (_a = r.id) !== null && _a !== void 0 ? _a : "",
                name: (_b = r.name) !== null && _b !== void 0 ? _b : "",
                displayName: (_e = (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.displayName) !== null && _d !== void 0 ? _d : r.name) !== null && _e !== void 0 ? _e : "",
                agreementType: (_g = (_f = r.properties) === null || _f === void 0 ? void 0 : _f.agreementType) !== null && _g !== void 0 ? _g : "",
                accountStatus: (_j = (_h = r.properties) === null || _h === void 0 ? void 0 : _h.accountStatus) !== null && _j !== void 0 ? _j : "",
                accountType: (_l = (_k = r.properties) === null || _k === void 0 ? void 0 : _k.accountType) !== null && _l !== void 0 ? _l : "",
            });
        });
    });
}
export function listEaBillingAccounts(token) {
    return __awaiter(this, void 0, void 0, function* () {
        const baseUrl = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts` +
            `?api-version=${ARM_BILLING_API}`;
        const filteredUrl = `${baseUrl}` +
            `&$filter=${encodeURIComponent("agreementType eq 'EnterpriseAgreement'")}`;
        let rows;
        try {
            rows = yield fetchAllPages(filteredUrl, token);
        }
        catch (err) {
            // Some tenants reject $filter on this resource provider. Retry
            // without the filter and apply the agreementType check client-side.
            const status = err instanceof AzureRequestError ? err.status : undefined;
            if (status === 400) {
                rows = yield fetchAllPages(baseUrl, token);
            }
            else {
                throw err;
            }
        }
        return rows
            .filter((r) => r.id && r.name)
            .filter((r) => {
            var _a, _b;
            // Client-side guard for the fallback path.
            return ((_b = (_a = r.properties) === null || _a === void 0 ? void 0 : _a.agreementType) !== null && _b !== void 0 ? _b : "EnterpriseAgreement") ===
                "EnterpriseAgreement";
        })
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
            return ({
                id: (_a = r.id) !== null && _a !== void 0 ? _a : "",
                name: (_b = r.name) !== null && _b !== void 0 ? _b : "",
                displayName: (_e = (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.displayName) !== null && _d !== void 0 ? _d : r.name) !== null && _e !== void 0 ? _e : "",
                agreementType: (_g = (_f = r.properties) === null || _f === void 0 ? void 0 : _f.agreementType) !== null && _g !== void 0 ? _g : "EnterpriseAgreement",
                accountStatus: (_j = (_h = r.properties) === null || _h === void 0 ? void 0 : _h.accountStatus) !== null && _j !== void 0 ? _j : "",
                accountType: (_l = (_k = r.properties) === null || _k === void 0 ? void 0 : _k.accountType) !== null && _l !== void 0 ? _l : "",
            });
        });
    });
}
/**
 * List billing profiles for a specific EA billing account.
 */
export function listBillingProfiles(billingAccountName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingProfiles?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g;
            return ({
                id: (_a = r.id) !== null && _a !== void 0 ? _a : "",
                name: (_b = r.name) !== null && _b !== void 0 ? _b : "",
                displayName: (_e = (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.displayName) !== null && _d !== void 0 ? _d : r.name) !== null && _e !== void 0 ? _e : "",
                status: (_g = (_f = r.properties) === null || _f === void 0 ? void 0 : _f.status) !== null && _g !== void 0 ? _g : "",
            });
        });
    });
}
/**
 * List invoice sections for an EA billing profile.
 */
export function listInvoiceSections(billingAccountName, billingProfileName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        validateBillingAccountName(billingProfileName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
            `/invoiceSections?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g;
            return ({
                id: (_a = r.id) !== null && _a !== void 0 ? _a : "",
                name: (_b = r.name) !== null && _b !== void 0 ? _b : "",
                displayName: (_e = (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.displayName) !== null && _d !== void 0 ? _d : r.name) !== null && _e !== void 0 ? _e : "",
                state: (_g = (_f = r.properties) === null || _f === void 0 ? void 0 : _f.state) !== null && _g !== void 0 ? _g : "",
            });
        });
    });
}
/**
 * List enrollment accounts for a legacy EA (Enterprise Agreement)
 * billing account. EA enrollment accounts are the equivalent of
 * MCA invoice sections — they are the leaf scope a new subscription
 * gets created against. Microsoft Customer Agreement accounts use
 * billingProfiles + invoiceSections instead and will reject this
 * endpoint.
 */
export function listEnrollmentAccounts(billingAccountName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        // NOTE: enrollmentAccounts is not on the 2020-05-01 namespace.
        // We use 2024-04-01 (latest stable) which supports both EA enrollment
        // and MCA endpoints uniformly.
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/enrollmentAccounts?api-version=${ARM_BILLING_ENROLLMENT_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
            return ({
                id: (_a = r.id) !== null && _a !== void 0 ? _a : "",
                name: (_b = r.name) !== null && _b !== void 0 ? _b : "",
                displayName: (_g = (_f = (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.displayName) !== null && _d !== void 0 ? _d : (_e = r.properties) === null || _e === void 0 ? void 0 : _e.principalName) !== null && _f !== void 0 ? _f : r.name) !== null && _g !== void 0 ? _g : "",
                status: (_j = (_h = r.properties) === null || _h === void 0 ? void 0 : _h.status) !== null && _j !== void 0 ? _j : "",
                accountOwner: (_k = r.properties) === null || _k === void 0 ? void 0 : _k.principalName,
                costCenter: (_l = r.properties) === null || _l === void 0 ? void 0 : _l.costCenter,
                startDate: (_m = r.properties) === null || _m === void 0 ? void 0 : _m.startDate,
                endDate: (_o = r.properties) === null || _o === void 0 ? void 0 : _o.endDate,
            });
        });
    });
}
/** List EA / MCA agreements attached to a billing account. */
export function listEaAgreements(billingAccountName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/agreements?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            return ({
                id: r.id,
                name: r.name,
                agreementType: (_b = (_a = r.properties) === null || _a === void 0 ? void 0 : _a.agreementType) !== null && _b !== void 0 ? _b : "",
                category: (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.category) !== null && _d !== void 0 ? _d : "",
                acceptanceMode: (_e = r.properties) === null || _e === void 0 ? void 0 : _e.acceptanceMode,
                effectiveDate: (_f = r.properties) === null || _f === void 0 ? void 0 : _f.effectiveDate,
                expirationDate: (_g = r.properties) === null || _g === void 0 ? void 0 : _g.expirationDate,
                status: (_h = r.properties) === null || _h === void 0 ? void 0 : _h.status,
            });
        });
    });
}
/**
 * List the data-action permissions the caller has at a billing-account
 * scope. Useful to short-circuit UI affordances (e.g. hide "create
 * department" when the caller can't write).
 */
export function listEaBillingPermissions(billingAccountName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingPermissions?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows.map((r) => {
            var _a, _b, _c, _d;
            return ({
                actions: (_b = (_a = r.properties) === null || _a === void 0 ? void 0 : _a.actions) !== null && _b !== void 0 ? _b : [],
                notActions: (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.notActions) !== null && _d !== void 0 ? _d : [],
            });
        });
    });
}
/** List departments under an EA billing account. */
export function listEaDepartments(billingAccountName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/departments?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f;
            return ({
                id: r.id,
                name: r.name,
                departmentName: (_b = (_a = r.properties) === null || _a === void 0 ? void 0 : _a.departmentName) !== null && _b !== void 0 ? _b : r.name,
                costCenter: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.costCenter,
                status: (_d = r.properties) === null || _d === void 0 ? void 0 : _d.status,
                enrollmentAccounts: (_f = (_e = r.properties) === null || _e === void 0 ? void 0 : _e.enrollmentAccounts) === null || _f === void 0 ? void 0 : _f.length,
            });
        });
    });
}
/**
 * List billing subscriptions scoped to a single EA department.
 *
 * `GET /billingAccounts/{ba}/departments/{name}/billingSubscriptions`
 *
 * Why this is necessary: a Department Admin's billingPermissions grant
 * is at the *department* scope only, so calling the
 * billing-account-scope variant ({@link listEaBillingSubscriptions})
 * returns 403 "User is not authorized to access subscriptions for
 * billing account". This narrower scope works for that role and
 * returns the subs across every enrollment account in the department.
 */
export function listDepartmentBillingSubscriptions(billingAccountName, departmentName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        if (!departmentName) {
            throw new Error("departmentName is required.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/departments/${encodeURIComponent(departmentName)}` +
            `/billingSubscriptions?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            return ({
                id: r.id,
                name: r.name,
                displayName: (_b = (_a = r.properties) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : r.name,
                subscriptionId: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.subscriptionId,
                status: (_d = r.properties) === null || _d === void 0 ? void 0 : _d.subscriptionBillingStatus,
                billingProfileDisplayName: (_e = r.properties) === null || _e === void 0 ? void 0 : _e.billingProfileDisplayName,
                invoiceSectionDisplayName: (_f = r.properties) === null || _f === void 0 ? void 0 : _f.invoiceSectionDisplayName,
                costCenter: (_g = r.properties) === null || _g === void 0 ? void 0 : _g.costCenter,
                skuId: (_h = r.properties) === null || _h === void 0 ? void 0 : _h.skuId,
            });
        });
    });
}
/**
 * List billing subscriptions scoped to a single EA enrollment account.
 *
 * `GET /billingAccounts/{ba}/enrollmentAccounts/{ea}/billingSubscriptions`
 *
 * Same authz rationale as {@link listDepartmentBillingSubscriptions}:
 * a per-enrollment-account admin can read here but not at the
 * billing-account root.
 */
export function listEnrollmentAccountBillingSubscriptions(billingAccountName, enrollmentAccountName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        if (!enrollmentAccountName) {
            throw new Error("enrollmentAccountName is required.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/enrollmentAccounts/${encodeURIComponent(enrollmentAccountName)}` +
            `/billingSubscriptions?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            return ({
                id: r.id,
                name: r.name,
                displayName: (_b = (_a = r.properties) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : r.name,
                subscriptionId: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.subscriptionId,
                status: (_d = r.properties) === null || _d === void 0 ? void 0 : _d.subscriptionBillingStatus,
                billingProfileDisplayName: (_e = r.properties) === null || _e === void 0 ? void 0 : _e.billingProfileDisplayName,
                invoiceSectionDisplayName: (_f = r.properties) === null || _f === void 0 ? void 0 : _f.invoiceSectionDisplayName,
                costCenter: (_g = r.properties) === null || _g === void 0 ? void 0 : _g.costCenter,
                skuId: (_h = r.properties) === null || _h === void 0 ? void 0 : _h.skuId,
            });
        });
    });
}
/**
 * List enrollment accounts that live under a specific department.
 *
 * Department admins typically only see / can-act-on the enrollment
 * accounts inside their own department, so scoping through this
 * endpoint (rather than the parent billing-account list) keeps the
 * Department Admin workspace focused.
 *
 * `GET /billingAccounts/{ba}/departments/{name}/enrollmentAccounts`
 */
export function listDepartmentEnrollmentAccounts(billingAccountName, departmentName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        if (!departmentName) {
            throw new Error("departmentName is required.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/departments/${encodeURIComponent(departmentName)}` +
            `/enrollmentAccounts?api-version=${ARM_BILLING_ENROLLMENT_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
            return ({
                id: (_a = r.id) !== null && _a !== void 0 ? _a : "",
                name: (_b = r.name) !== null && _b !== void 0 ? _b : "",
                displayName: (_g = (_f = (_d = (_c = r.properties) === null || _c === void 0 ? void 0 : _c.displayName) !== null && _d !== void 0 ? _d : (_e = r.properties) === null || _e === void 0 ? void 0 : _e.principalName) !== null && _f !== void 0 ? _f : r.name) !== null && _g !== void 0 ? _g : "",
                status: (_j = (_h = r.properties) === null || _h === void 0 ? void 0 : _h.status) !== null && _j !== void 0 ? _j : "",
                accountOwner: (_k = r.properties) === null || _k === void 0 ? void 0 : _k.principalName,
                costCenter: (_l = r.properties) === null || _l === void 0 ? void 0 : _l.costCenter,
                startDate: (_m = r.properties) === null || _m === void 0 ? void 0 : _m.startDate,
                endDate: (_o = r.properties) === null || _o === void 0 ? void 0 : _o.endDate,
            });
        });
    });
}
/**
 * Create or update an EA department under a billing account.
 * `name` is the URL-segment identifier (Azure-defined alphanumeric +
 * dashes). Returns the resulting department row.
 */
export function createEaDepartment(billingAccountName, departmentName, body, token) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        if (!departmentName) {
            throw new Error("departmentName (URL segment) is required.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/departments/${encodeURIComponent(departmentName)}?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ properties: body }),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_a = data.id) !== null && _a !== void 0 ? _a : "",
            name: (_b = data.name) !== null && _b !== void 0 ? _b : departmentName,
            departmentName: (_e = (_d = (_c = data.properties) === null || _c === void 0 ? void 0 : _c.departmentName) !== null && _d !== void 0 ? _d : body.departmentName) !== null && _e !== void 0 ? _e : departmentName,
            costCenter: (_g = (_f = data.properties) === null || _f === void 0 ? void 0 : _f.costCenter) !== null && _g !== void 0 ? _g : body.costCenter,
            status: (_h = data.properties) === null || _h === void 0 ? void 0 : _h.status,
            enrollmentAccounts: (_k = (_j = data.properties) === null || _j === void 0 ? void 0 : _j.enrollmentAccounts) === null || _k === void 0 ? void 0 : _k.length,
        };
    });
}
/** Patch an existing EA department (e.g. rename, change cost center). */
export function updateEaDepartment(billingAccountName, departmentName, body, token) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        if (!departmentName) {
            throw new Error("departmentName is required.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/departments/${encodeURIComponent(departmentName)}?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "PATCH",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ properties: body }),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_a = data.id) !== null && _a !== void 0 ? _a : "",
            name: (_b = data.name) !== null && _b !== void 0 ? _b : departmentName,
            departmentName: (_d = (_c = data.properties) === null || _c === void 0 ? void 0 : _c.departmentName) !== null && _d !== void 0 ? _d : departmentName,
            costCenter: (_e = data.properties) === null || _e === void 0 ? void 0 : _e.costCenter,
            status: (_f = data.properties) === null || _f === void 0 ? void 0 : _f.status,
            enrollmentAccounts: (_h = (_g = data.properties) === null || _g === void 0 ? void 0 : _g.enrollmentAccounts) === null || _h === void 0 ? void 0 : _h.length,
        };
    });
}
/** Delete an EA department. */
export function deleteEaDepartment(billingAccountName, departmentName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/departments/${encodeURIComponent(departmentName)}?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "DELETE",
            headers: armHeaders(token),
        });
        if (response.ok || response.status === 204 || response.status === 404)
            return;
        throw yield toAzureError(response);
    });
}
/** Well-known billing-role-template GUID for "EA Subscription Creator". */
export const ROLE_EA_SUBSCRIPTION_CREATOR = "a0bcee42-bf30-4d1b-926a-48d21664ef71";
/**
 * Well-known built-in "Owner" role definition GUID (classic Azure RBAC).
 * At enrollment-account scope this confers EA Subscription Creator
 * capability — see Microsoft's "grant access to create EA subscription"
 * doc, which prescribes exactly this role at exactly this scope:
 *   https://learn.microsoft.com/azure/cost-management-billing/manage/grant-access-to-create-subscription
 */
const RBAC_OWNER_ROLE_DEFINITION_GUID = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
/** API version for the classic RBAC roleAssignments fallback path. */
const ARM_AUTHORIZATION_ROLEASSIGNMENT_API = "2022-04-01";
/**
 * Grant a billing role at an *enrollment-account* scope. Unlike the
 * billing-account-scope variant ({@link createBillingRoleAssignment}),
 * this is what you call to give a user EA Subscription Creator rights
 * on a specific enrollment account so they can create subscriptions
 * under it via the Subscription Alias API.
 *
 * `principalTenantId` is required for cross-tenant grants — Microsoft
 * Graph guests (users from a different tenant) live in a different
 * tenant than the EA enrollment, and the role-assignment endpoint
 * needs both sides.
 *
 * Failure modes & recovery (see {@link
 * CreateEnrollmentAccountRoleAssignmentOptions}):
 *   • On HTTP 500 from the modern endpoint the call automatically
 *     retries through the classic RBAC path at the legacy enrollment-
 *     account scope using the built-in "Owner" role — Microsoft's
 *     documented method to grant EA Subscription Creator. This is the
 *     `fallbackToClassicRbac` flag (default `true`).
 *   • Operators who pass `userEmailAddress` materially reduce the
 *     500 rate on EA-agreement tenants — the EA backend uses email +
 *     auth-type to identify the recipient when the principal hasn't
 *     been seen in the EA system yet.
 */
export function createEnrollmentAccountRoleAssignment(billingAccountName, enrollmentAccountName, principalId, principalTenantId, roleDefinitionGuid, token, opts = {}) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        validateBillingAccountName(enrollmentAccountName);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principalId)) {
            throw new Error("Invalid principalId: must be a UUID.");
        }
        if (!UUID_REGEX.test(principalTenantId)) {
            throw new Error("Invalid principalTenantId: must be a UUID.");
        }
        const assignmentName = crypto.randomUUID();
        const enrollmentScope = `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}` +
            `/enrollmentAccounts/${enrollmentAccountName}`;
        // EA enrollment-account billing roles live under the BILLING ACCOUNT's
        // role definitions, not the enrollment account itself.
        const roleDefinitionId = `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}` +
            `/billingRoleDefinitions/${roleDefinitionGuid}`;
        const url = `${ARM_BASE}${enrollmentScope}/billingRoleAssignments/${assignmentName}` +
            `?api-version=${ARM_BILLING_API}`;
        // Build a body that satisfies BOTH the 2019-10-01-preview and the
        // 2024-04-01 schemas — `scope` was added in 2024-04-01 and is harmless
        // (ignored) on older versions. `userAuthenticationType` /
        // `userEmailAddress` are EA-only hints that some tenants treat as
        // required despite the OpenAPI schema marking them optional.
        const body = {
            properties: Object.assign({ principalId,
                principalTenantId,
                roleDefinitionId, scope: enrollmentScope, userAuthenticationType: (_a = opts.userAuthenticationType) !== null && _a !== void 0 ? _a : "Organization" }, (opts.userEmailAddress
                ? { userEmailAddress: opts.userEmailAddress }
                : {})),
        };
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify(body),
        });
        // Modern endpoint sporadically returns 500 on hybrid EAs that haven't
        // migrated their enrollment-account role-assignment plane. Fall back
        // to the classic RBAC endpoint — that's the path Microsoft's official
        // "grant access to create EA subscription" doc recommends.
        if (response.status === 500 && opts.fallbackToClassicRbac !== false) {
            let errBody = "";
            try {
                errBody = (yield response.text()).slice(0, 500);
            }
            catch (_d) {
                /* body may already be consumed in some runtimes — ignore */
            }
            // eslint-disable-next-line no-console
            console.warn(`[arm-service] Modern EA billingRoleAssignment PUT returned 500 — ` +
                `falling back to classic RBAC at legacy enrollment-account scope. ` +
                `Body excerpt: ${errBody}`);
            return createEnrollmentAccountRoleAssignmentClassic(enrollmentAccountName, principalId, principalTenantId, token);
        }
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_b = data.id) !== null && _b !== void 0 ? _b : "",
            roleDefinitionId: roleDefinitionGuid,
            roleDefinitionName: (_c = EA_BILLING_ROLE_NAMES[roleDefinitionGuid.toLowerCase()]) !== null && _c !== void 0 ? _c : roleDefinitionGuid,
            principalId,
            principalTenantId,
            scope: enrollmentScope,
        };
    });
}
/**
 * Classic RBAC fallback for {@link createEnrollmentAccountRoleAssignment}.
 *
 * Assigns the built-in "Owner" role at the LEGACY enrollment-account
 * scope (`/providers/Microsoft.Billing/enrollmentAccounts/{id}` — no
 * billingAccounts/ prefix), using the `Microsoft.Authorization/
 * roleAssignments` endpoint. This is the path Microsoft's official
 * "Grant access to create Azure Enterprise subscriptions" guide
 * prescribes and it works on EA enrollments where the modern
 * Microsoft.Billing/billingRoleAssignments endpoint is not fully
 * migrated (the symptom is an opaque 500 from the modern path).
 *
 * The returned summary reuses the same shape as the primary path so
 * UI consumers don't branch on which endpoint succeeded — they only
 * care that the principal now has EA Subscription Creator capability
 * at the enrollment account.
 */
function createEnrollmentAccountRoleAssignmentClassic(enrollmentAccountName, principalId, principalTenantId, token) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const assignmentName = crypto.randomUUID();
        const legacyScope = `/providers/Microsoft.Billing/enrollmentAccounts/${enrollmentAccountName}`;
        const roleDefinitionId = `/providers/Microsoft.Authorization/roleDefinitions/` +
            RBAC_OWNER_ROLE_DEFINITION_GUID;
        const url = `${ARM_BASE}${legacyScope}/providers/Microsoft.Authorization` +
            `/roleAssignments/${assignmentName}` +
            `?api-version=${ARM_AUTHORIZATION_ROLEASSIGNMENT_API}`;
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({
                properties: {
                    roleDefinitionId,
                    principalId,
                    principalTenantId,
                },
            }),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_a = data.id) !== null && _a !== void 0 ? _a : "",
            // Surface BOTH the conceptual EA role (so UI display matches the
            // operator's intent) AND the actual RBAC role id assigned, so
            // callers diffing the result against expectations don't get
            // confused. Default to the EA constant — callers comparing role
            // ids in the response loop already key off `ROLE_EA_SUBSCRIPTION_CREATOR`.
            roleDefinitionId: ROLE_EA_SUBSCRIPTION_CREATOR,
            roleDefinitionName: "Owner (classic RBAC; equivalent to EA Subscription Creator)",
            principalId,
            principalTenantId,
            scope: legacyScope,
        };
    });
}
/** List every subscription billed under the EA billing account. */
export function listEaBillingSubscriptions(billingAccountName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingSubscriptions?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            return ({
                id: r.id,
                name: r.name,
                displayName: (_b = (_a = r.properties) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : r.name,
                subscriptionId: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.subscriptionId,
                status: (_d = r.properties) === null || _d === void 0 ? void 0 : _d.subscriptionBillingStatus,
                billingProfileDisplayName: (_e = r.properties) === null || _e === void 0 ? void 0 : _e.billingProfileDisplayName,
                invoiceSectionDisplayName: (_f = r.properties) === null || _f === void 0 ? void 0 : _f.invoiceSectionDisplayName,
                costCenter: (_g = r.properties) === null || _g === void 0 ? void 0 : _g.costCenter,
                skuId: (_h = r.properties) === null || _h === void 0 ? void 0 : _h.skuId,
            });
        });
    });
}
/**
 * List invoices on an EA billing account. The Billing API requires a
 * `periodStartDate` / `periodEndDate` range — we default to the last
 * 12 months, which is the usual "show my recent invoices" surface.
 */
export function listEaInvoices(billingAccountName, token, opts) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const now = new Date();
        const end = (_a = opts === null || opts === void 0 ? void 0 : opts.periodEndDate) !== null && _a !== void 0 ? _a : now.toISOString().slice(0, 10);
        const startDefault = new Date(now);
        startDefault.setMonth(startDefault.getMonth() - 12);
        const start = (_b = opts === null || opts === void 0 ? void 0 : opts.periodStartDate) !== null && _b !== void 0 ? _b : startDefault.toISOString().slice(0, 10);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/invoices?api-version=${ARM_BILLING_API}` +
            `&periodStartDate=${encodeURIComponent(start)}` +
            `&periodEndDate=${encodeURIComponent(end)}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
            return ({
                id: r.id,
                name: r.name,
                invoiceDate: (_a = r.properties) === null || _a === void 0 ? void 0 : _a.invoiceDate,
                dueDate: (_b = r.properties) === null || _b === void 0 ? void 0 : _b.dueDate,
                status: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.status,
                amountDue: ((_e = (_d = r.properties) === null || _d === void 0 ? void 0 : _d.amountDue) === null || _e === void 0 ? void 0 : _e.value) !== undefined
                    ? {
                        value: r.properties.amountDue.value,
                        currency: (_f = r.properties.amountDue.currency) !== null && _f !== void 0 ? _f : "",
                    }
                    : undefined,
                totalAmount: ((_h = (_g = r.properties) === null || _g === void 0 ? void 0 : _g.totalAmount) === null || _h === void 0 ? void 0 : _h.value) !== undefined
                    ? {
                        value: r.properties.totalAmount.value,
                        currency: (_j = r.properties.totalAmount.currency) !== null && _j !== void 0 ? _j : "",
                    }
                    : undefined,
                invoicePeriodStartDate: (_k = r.properties) === null || _k === void 0 ? void 0 : _k.invoicePeriodStartDate,
                invoicePeriodEndDate: (_l = r.properties) === null || _l === void 0 ? void 0 : _l.invoicePeriodEndDate,
                documentUrls: (_o = (_m = r.properties) === null || _m === void 0 ? void 0 : _m.documents) === null || _o === void 0 ? void 0 : _o.filter((d) => d.url).map((d) => { var _a; return ({ kind: (_a = d.kind) !== null && _a !== void 0 ? _a : "Invoice", url: d.url }); }),
            });
        });
    });
}
/** List Reservation orders visible to the caller (tenant-wide). */
export function listReservationOrders(token) {
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${ARM_BASE}/providers/Microsoft.Capacity/reservationOrders` +
            `?api-version=2022-11-01`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
            return ({
                id: r.id,
                name: r.name,
                displayName: (_a = r.properties) === null || _a === void 0 ? void 0 : _a.displayName,
                term: (_b = r.properties) === null || _b === void 0 ? void 0 : _b.term,
                billingPlan: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.billingPlan,
                enrollmentId: (_d = r.properties) === null || _d === void 0 ? void 0 : _d.enrollmentId,
                customerId: (_e = r.properties) === null || _e === void 0 ? void 0 : _e.customerId,
                provisioningState: (_f = r.properties) === null || _f === void 0 ? void 0 : _f.provisioningState,
                requestDateTime: (_g = r.properties) === null || _g === void 0 ? void 0 : _g.requestDateTime,
                createdDateTime: (_h = r.properties) === null || _h === void 0 ? void 0 : _h.createdDateTime,
                expiryDate: (_j = r.properties) === null || _j === void 0 ? void 0 : _j.expiryDate,
                benefitStartTime: (_k = r.properties) === null || _k === void 0 ? void 0 : _k.benefitStartTime,
                reservations: (_m = (_l = r.properties) === null || _l === void 0 ? void 0 : _l.reservations) === null || _m === void 0 ? void 0 : _m.length,
            });
        });
    });
}
/** Read the billing policies that govern purchase / dev-test eligibility. */
export function getEaBillingPolicy(billingAccountName, token) {
    var _a, _b, _c, _d, _e;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingPolicies/default?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, { headers: armHeaders(token) });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_a = data.id) !== null && _a !== void 0 ? _a : "",
            marketplacePurchases: (_b = data.properties) === null || _b === void 0 ? void 0 : _b.marketplacePurchases,
            reservationPurchases: (_c = data.properties) === null || _c === void 0 ? void 0 : _c.reservationPurchases,
            savingsPlanPurchases: (_d = data.properties) === null || _d === void 0 ? void 0 : _d.savingsPlanPurchases,
            enterpriseAgreementDevTestEnabled: (_e = data.properties) === null || _e === void 0 ? void 0 : _e.enterpriseAgreementDevTestEnabled,
        };
    });
}
/** Update billing policy flags. Empty object = no-op. */
export function updateEaBillingPolicy(billingAccountName, body, token) {
    var _a, _b, _c, _d, _e;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingPolicies/default?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ properties: body }),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_a = data.id) !== null && _a !== void 0 ? _a : "",
            marketplacePurchases: (_b = data.properties) === null || _b === void 0 ? void 0 : _b.marketplacePurchases,
            reservationPurchases: (_c = data.properties) === null || _c === void 0 ? void 0 : _c.reservationPurchases,
            savingsPlanPurchases: (_d = data.properties) === null || _d === void 0 ? void 0 : _d.savingsPlanPurchases,
            enterpriseAgreementDevTestEnabled: (_e = data.properties) === null || _e === void 0 ? void 0 : _e.enterpriseAgreementDevTestEnabled,
        };
    });
}
/** List role definitions available at a billing-account scope. */
export function listBillingRoleDefinitions(billingAccountName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingRoleDefinitions?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e;
            return ({
                id: r.id,
                name: r.name,
                roleName: (_b = (_a = r.properties) === null || _a === void 0 ? void 0 : _a.roleName) !== null && _b !== void 0 ? _b : r.name,
                description: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.description,
                permissions: (_e = (_d = r.properties) === null || _d === void 0 ? void 0 : _d.permissions) === null || _e === void 0 ? void 0 : _e.map((p) => {
                    var _a, _b;
                    return ({
                        actions: (_a = p.actions) !== null && _a !== void 0 ? _a : [],
                        notActions: (_b = p.notActions) !== null && _b !== void 0 ? _b : [],
                    });
                }),
            });
        });
    });
}
/**
 * Create a billing-role assignment at the billing-account scope.
 * `principalId` must be the AAD object id; `principalTenantId` is the
 * tenant the principal lives in (required for cross-tenant grants).
 * `roleDefinitionId` is just the GUID — we expand to the full ARM path.
 */
export function createBillingRoleAssignment(billingAccountName, principalId, principalTenantId, roleDefinitionGuid, token) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principalId)) {
            throw new Error("Invalid principalId: must be a UUID.");
        }
        const assignmentName = crypto.randomUUID();
        const roleDefinitionId = `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}` +
            `/billingRoleDefinitions/${roleDefinitionGuid}`;
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingRoleAssignments/${assignmentName}?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({
                properties: {
                    principalId,
                    principalTenantId,
                    roleDefinitionId,
                },
            }),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_a = data.id) !== null && _a !== void 0 ? _a : "",
            roleDefinitionId: roleDefinitionGuid,
            roleDefinitionName: (_b = EA_BILLING_ROLE_NAMES[roleDefinitionGuid.toLowerCase()]) !== null && _b !== void 0 ? _b : roleDefinitionGuid,
            principalId,
            principalTenantId,
            scope: `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}`,
        };
    });
}
/** Delete a billing-role assignment by its full ARM resource id. */
export function deleteBillingRoleAssignment(roleAssignmentArmId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!roleAssignmentArmId.startsWith("/") ||
            !roleAssignmentArmId.includes("/billingRoleAssignments/")) {
            throw new Error("Invalid roleAssignmentArmId: must be a billing-role ARM path.");
        }
        const url = `${ARM_BASE}${roleAssignmentArmId}?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "DELETE",
            headers: armHeaders(token),
        });
        if (response.ok || response.status === 204 || response.status === 404)
            return;
        throw yield toAzureError(response);
    });
}
/**
 * Read the caller's billing-property metadata. Cheap one-shot endpoint
 * that surfaces "which billing account, billing profile, enrollment
 * account am I currently associated with" — useful for the Overview tab.
 */
export function getBillingProperty(token) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingProperty/default` +
            `?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, { headers: armHeaders(token) });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        const p = ((_a = data.properties) !== null && _a !== void 0 ? _a : {});
        return {
            billingTenantId: p.billingTenantId,
            billingAccountId: p.billingAccountId,
            billingAccountDisplayName: p.billingAccountDisplayName,
            accountAdminNotificationEmailAddress: p.accountAdminNotificationEmailAddress,
            costCenter: p.costCenter,
            isAdmin: p.isAdmin,
            billingProfileId: p.billingProfileId,
            billingProfileDisplayName: p.billingProfileDisplayName,
            invoiceSectionId: p.invoiceSectionId,
            invoiceSectionDisplayName: p.invoiceSectionDisplayName,
            enrollmentAccountId: p.enrollmentAccountId,
            enrollmentAccountDisplayName: p.enrollmentAccountDisplayName,
        };
    });
}
/**
 * List transactions on a billing account. The API requires either a
 * `periodStartDate`/`periodEndDate` pair or a specific `invoiceId`
 * filter — we default to the last 60 days when no range is provided.
 */
export function listEaTransactions(billingAccountName, token, opts) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        const now = new Date();
        const end = (_a = opts === null || opts === void 0 ? void 0 : opts.periodEndDate) !== null && _a !== void 0 ? _a : now.toISOString().slice(0, 10);
        const startDefault = new Date(now);
        startDefault.setDate(startDefault.getDate() - 60);
        const start = (_b = opts === null || opts === void 0 ? void 0 : opts.periodStartDate) !== null && _b !== void 0 ? _b : startDefault.toISOString().slice(0, 10);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/transactions?api-version=${ARM_BILLING_API}` +
            `&periodStartDate=${encodeURIComponent(start)}` +
            `&periodEndDate=${encodeURIComponent(end)}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
            return ({
                id: r.id,
                name: r.name,
                kind: r.kind,
                transactionDate: (_a = r.properties) === null || _a === void 0 ? void 0 : _a.transactionDate,
                invoice: (_b = r.properties) === null || _b === void 0 ? void 0 : _b.invoice,
                invoiceId: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.invoiceId,
                orderId: (_d = r.properties) === null || _d === void 0 ? void 0 : _d.orderId,
                orderName: (_e = r.properties) === null || _e === void 0 ? void 0 : _e.orderName,
                productDescription: (_f = r.properties) === null || _f === void 0 ? void 0 : _f.productDescription,
                transactionType: (_g = r.properties) === null || _g === void 0 ? void 0 : _g.transactionType,
                transactionAmount: ((_j = (_h = r.properties) === null || _h === void 0 ? void 0 : _h.transactionAmount) === null || _j === void 0 ? void 0 : _j.value) !== undefined
                    ? {
                        value: r.properties.transactionAmount.value,
                        currency: (_k = r.properties.transactionAmount.currency) !== null && _k !== void 0 ? _k : "",
                    }
                    : undefined,
                quantity: (_l = r.properties) === null || _l === void 0 ? void 0 : _l.quantity,
                billingProfileDisplayName: (_m = r.properties) === null || _m === void 0 ? void 0 : _m.billingProfileDisplayName,
                invoiceSectionDisplayName: (_o = r.properties) === null || _o === void 0 ? void 0 : _o.invoiceSectionDisplayName,
                customerDisplayName: (_p = r.properties) === null || _p === void 0 ? void 0 : _p.customerDisplayName,
                subscriptionId: (_q = r.properties) === null || _q === void 0 ? void 0 : _q.subscriptionId,
                subscriptionName: (_r = r.properties) === null || _r === void 0 ? void 0 : _r.subscriptionName,
            });
        });
    });
}
/**
 * List outbound transfers initiated from a billing-profile +
 * invoice-section scope. Both segments are required by the API.
 */
export function listOutboundTransfers(billingAccountName, billingProfileName, invoiceSectionName, token) {
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        validateBillingAccountName(billingProfileName);
        validateBillingAccountName(invoiceSectionName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
            `/invoiceSections/${encodeURIComponent(invoiceSectionName)}` +
            `/transfers?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f;
            return ({
                id: r.id,
                name: r.name,
                recipientEmailId: (_a = r.properties) === null || _a === void 0 ? void 0 : _a.recipientEmailId,
                transferStatus: (_b = r.properties) === null || _b === void 0 ? void 0 : _b.transferStatus,
                initiatorEmailId: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.initiatorEmailId,
                expirationTime: (_d = r.properties) === null || _d === void 0 ? void 0 : _d.expirationTime,
                resellerId: (_e = r.properties) === null || _e === void 0 ? void 0 : _e.resellerId,
                resellerName: (_f = r.properties) === null || _f === void 0 ? void 0 : _f.resellerName,
            });
        });
    });
}
/**
 * Initiate a billing-subscription transfer to a recipient email. The
 * recipient must accept via the inbound recipientTransfers endpoint
 * within the expiration window (typically 7 days).
 */
export function createOutboundTransfer(billingAccountName, billingProfileName, invoiceSectionName, recipientEmail, resellerId, token) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        validateBillingAccountName(billingProfileName);
        validateBillingAccountName(invoiceSectionName);
        const transferName = crypto.randomUUID();
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
            `/invoiceSections/${encodeURIComponent(invoiceSectionName)}` +
            `/transfers/${transferName}?api-version=${ARM_BILLING_API}`;
        const body = {
            properties: { recipientEmailId: recipientEmail },
        };
        if (resellerId)
            body.properties.resellerId = resellerId;
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify(body),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_a = data.id) !== null && _a !== void 0 ? _a : "",
            name: (_b = data.name) !== null && _b !== void 0 ? _b : transferName,
            recipientEmailId: (_c = data.properties) === null || _c === void 0 ? void 0 : _c.recipientEmailId,
            transferStatus: (_d = data.properties) === null || _d === void 0 ? void 0 : _d.transferStatus,
            initiatorEmailId: (_e = data.properties) === null || _e === void 0 ? void 0 : _e.initiatorEmailId,
            expirationTime: (_f = data.properties) === null || _f === void 0 ? void 0 : _f.expirationTime,
            resellerId: (_g = data.properties) === null || _g === void 0 ? void 0 : _g.resellerId,
            resellerName: (_h = data.properties) === null || _h === void 0 ? void 0 : _h.resellerName,
        };
    });
}
/** List inbound (recipient) transfers visible to the caller. */
export function listInboundTransfers(token) {
    return __awaiter(this, void 0, void 0, function* () {
        // The recipientTransfers list endpoint isn't billing-account-scoped;
        // it's tenant-wide for the caller.
        const url = `${ARM_BASE}/providers/Microsoft.Billing/transfers` +
            `?api-version=${ARM_BILLING_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a, _b, _c, _d, _e, _f;
            return ({
                id: r.id,
                name: r.name,
                transferStatus: (_a = r.properties) === null || _a === void 0 ? void 0 : _a.transferStatus,
                initiatorEmailId: (_b = r.properties) === null || _b === void 0 ? void 0 : _b.initiatorEmailId,
                recipientEmailId: (_c = r.properties) === null || _c === void 0 ? void 0 : _c.recipientEmailId,
                expirationTime: (_d = r.properties) === null || _d === void 0 ? void 0 : _d.expirationTime,
                allowedProductType: (_f = (_e = r.properties) === null || _e === void 0 ? void 0 : _e.allowedProductType) === null || _f === void 0 ? void 0 : _f.map((p) => { var _a; return (_a = p.productType) !== null && _a !== void 0 ? _a : ""; }).filter(Boolean),
            });
        });
    });
}
/** Accept an inbound transfer by ARM id. */
export function acceptInboundTransfer(transferArmId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!transferArmId.startsWith("/")) {
            throw new Error("Invalid transferArmId: must be a full ARM path.");
        }
        const url = `${ARM_BASE}${transferArmId}/accept?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ properties: {} }),
        });
        if (!response.ok && response.status !== 204)
            throw yield toAzureError(response);
    });
}
/** Reject (decline) an inbound transfer by ARM id. */
export function declineInboundTransfer(transferArmId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!transferArmId.startsWith("/")) {
            throw new Error("Invalid transferArmId: must be a full ARM path.");
        }
        const url = `${ARM_BASE}${transferArmId}/decline?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token),
        });
        if (!response.ok && response.status !== 204)
            throw yield toAzureError(response);
    });
}
/* ---------- 4. Billing profile PATCH ------------------------------ */
/** Patch metadata on a billing profile (display name, PO number, etc). */
export function patchBillingProfile(billingAccountName, billingProfileName, body, token) {
    var _a, _b, _c, _d, _e, _f, _g;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        validateBillingAccountName(billingProfileName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
            `?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "PATCH",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ properties: body }),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_a = data.id) !== null && _a !== void 0 ? _a : "",
            name: (_b = data.name) !== null && _b !== void 0 ? _b : billingProfileName,
            displayName: (_e = (_d = (_c = data.properties) === null || _c === void 0 ? void 0 : _c.displayName) !== null && _d !== void 0 ? _d : data.name) !== null && _e !== void 0 ? _e : "",
            status: (_g = (_f = data.properties) === null || _f === void 0 ? void 0 : _f.status) !== null && _g !== void 0 ? _g : "",
        };
    });
}
/* ---------- 5. Invoice section CREATE ----------------------------- */
/** Create (or PUT-update) an invoice section under a billing profile. */
export function createInvoiceSection(billingAccountName, billingProfileName, invoiceSectionName, body, token) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        validateBillingAccountName(billingProfileName);
        validateBillingAccountName(invoiceSectionName);
        if (!((_a = body.displayName) === null || _a === void 0 ? void 0 : _a.trim())) {
            throw new Error("displayName is required.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
            `/invoiceSections/${encodeURIComponent(invoiceSectionName)}` +
            `?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ properties: body }),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_b = data.id) !== null && _b !== void 0 ? _b : "",
            name: (_c = data.name) !== null && _c !== void 0 ? _c : invoiceSectionName,
            displayName: (_f = (_e = (_d = data.properties) === null || _d === void 0 ? void 0 : _d.displayName) !== null && _e !== void 0 ? _e : data.name) !== null && _f !== void 0 ? _f : "",
            state: (_h = (_g = data.properties) === null || _g === void 0 ? void 0 : _g.state) !== null && _h !== void 0 ? _h : "",
        };
    });
}
/** Create (PUT) a custom billing-role definition under a billing account. */
export function createCustomBillingRoleDefinition(billingAccountName, roleDefinitionGuid, body, token) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roleDefinitionGuid)) {
            throw new Error("roleDefinitionGuid must be a UUID.");
        }
        if (!((_a = body.roleName) === null || _a === void 0 ? void 0 : _a.trim())) {
            throw new Error("roleName is required.");
        }
        if (!Array.isArray(body.permissions) || body.permissions.length === 0) {
            throw new Error("At least one permissions block is required.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingRoleDefinitions/${roleDefinitionGuid}?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ properties: body }),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        return {
            id: (_b = data.id) !== null && _b !== void 0 ? _b : "",
            name: (_c = data.name) !== null && _c !== void 0 ? _c : roleDefinitionGuid,
            roleName: (_e = (_d = data.properties) === null || _d === void 0 ? void 0 : _d.roleName) !== null && _e !== void 0 ? _e : body.roleName,
            description: (_f = data.properties) === null || _f === void 0 ? void 0 : _f.description,
            permissions: (_h = (_g = data.properties) === null || _g === void 0 ? void 0 : _g.permissions) === null || _h === void 0 ? void 0 : _h.map((p) => {
                var _a, _b;
                return ({
                    actions: (_a = p.actions) !== null && _a !== void 0 ? _a : [],
                    notActions: (_b = p.notActions) !== null && _b !== void 0 ? _b : [],
                });
            }),
        };
    });
}
/* ---------- 7. Subscription move / cancel ------------------------- */
/**
 * Move a billing subscription to a different invoice section. Both
 * `destinationInvoiceSectionId` and `destinationBillingProfileId` are
 * full ARM ids; the API rejects bare GUIDs.
 */
export function moveBillingSubscription(billingAccountName, billingSubscriptionName, destination, token) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        validateBillingAccountName(billingSubscriptionName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingSubscriptions/${encodeURIComponent(billingSubscriptionName)}` +
            `/move?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify(destination),
        });
        if (!response.ok && response.status !== 202)
            throw yield toAzureError(response);
        return {
            status: response.status,
            location: (_a = response.headers.get("Location")) !== null && _a !== void 0 ? _a : undefined,
        };
    });
}
/** Cancel a billing subscription. Returns 202 + Location for async tracking. */
export function cancelBillingSubscription(billingAccountName, billingSubscriptionName, reason, token) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        validateBillingAccountName(billingAccountName);
        validateBillingAccountName(billingSubscriptionName);
        const url = `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
            `/billingSubscriptions/${encodeURIComponent(billingSubscriptionName)}` +
            `/cancel?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ cancellationReason: reason }),
        });
        if (!response.ok && response.status !== 202)
            throw yield toAzureError(response);
        return {
            status: response.status,
            location: (_a = response.headers.get("Location")) !== null && _a !== void 0 ? _a : undefined,
        };
    });
}
/** Validate a billing address before using it on a billing-profile PATCH. */
export function validateBillingAddress(address, token) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!address.addressLine1) {
            throw new Error("addressLine1 is required.");
        }
        if (!address.country) {
            throw new Error("country is required.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/validateAddress` +
            `?api-version=${ARM_BILLING_API}`;
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify(address),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        const status = data.status === "Valid"
            ? "Valid"
            : data.status === "Invalid"
                ? "Invalid"
                : "Other";
        return {
            status,
            suggestedAddresses: data.suggestedAddresses,
            validationMessage: data.validationMessage,
        };
    });
}
/**
 * Run a Cost Management query at a given scope. Scope can be:
 *   /subscriptions/{id}
 *   /providers/Microsoft.Billing/billingAccounts/{name}
 *   /providers/Microsoft.Billing/billingAccounts/{name}/billingProfiles/{bp}
 *   ...
 *
 * The CostManagement provider uses its own api-version
 * (`2023-11-01` is GA at time of writing).
 */
export function queryCostManagement(scope, body, token) {
    var _a, _b, _c, _d, _e;
    return __awaiter(this, void 0, void 0, function* () {
        if (!scope.startsWith("/")) {
            throw new Error("Scope must start with /, e.g. /subscriptions/...");
        }
        const cleanScope = scope.replace(/^\/+/, "/").replace(/\/+$/, "");
        const url = `${ARM_BASE}${cleanScope}/providers/Microsoft.CostManagement/query` +
            `?api-version=2023-11-01`;
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify(body),
        });
        if (!response.ok)
            throw yield toAzureError(response);
        const data = (yield response.json());
        const columns = ((_b = (_a = data.properties) === null || _a === void 0 ? void 0 : _a.columns) !== null && _b !== void 0 ? _b : []).map((c) => {
            var _a, _b;
            return ({
                name: (_a = c.name) !== null && _a !== void 0 ? _a : "",
                type: (_b = c.type) !== null && _b !== void 0 ? _b : "",
            });
        });
        const numericColumnIndexes = columns
            .map((c, i) => ({ i, t: c.type.toLowerCase() }))
            .filter(({ t }) => t === "number" || t === "currency")
            .map(({ i }) => i);
        return {
            columns,
            rows: (_d = (_c = data.properties) === null || _c === void 0 ? void 0 : _c.rows) !== null && _d !== void 0 ? _d : [],
            numericColumnIndexes,
            nextLink: (_e = data.properties) === null || _e === void 0 ? void 0 : _e.nextLink,
        };
    });
}
/**
 * Probe an account for EA billing-account access.
 *
 * Silently downgrades to `{ hasEa: false, billingAccountCount: 0 }` on any
 * error — the caller treats this as "not capable" rather than surfacing
 * permission failures (callers expect a soft probe).
 */
export function probeEaCapability(token) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const accounts = yield listEaBillingAccounts(token);
            return {
                hasEa: accounts.length > 0,
                billingAccountCount: accounts.length,
                primaryBillingAccountName: accounts.length > 0 ? accounts[0].name : undefined,
            };
        }
        catch (_a) {
            return { hasEa: false, billingAccountCount: 0 };
        }
    });
}
// ---------------------------------------------------------------------------
// Billing role-assignment diagnostics
// ---------------------------------------------------------------------------
/**
 * Map of EA billing-role definition GUIDs to display names. Used by the
 * EA-page diagnostic UI when surfacing what the signed-in principal is
 * actually granted at an enrollmentAccount scope after a 401.
 *
 * "EA Subscription Creator" (`a0bcee42-...`) is the role required by the
 * Subscription Alias API to create new subscriptions under an enrollment.
 * "Account Owner" (`c15c22c0-...`) does NOT grant subscription creation
 * by itself in modern enrollments — it's an EA-portal management role.
 *
 * Source: https://learn.microsoft.com/azure/cost-management-billing/manage/understand-ea-roles
 */
export const EA_BILLING_ROLE_NAMES = {
    "9f1983cb-2574-400c-87e9-34cf8e2280db": "Enterprise Administrator",
    "0b5ed2f2-bb18-4c38-b0c4-dd75e9bd4de2": "Enterprise Administrator (read only)",
    "c15c22c0-9faf-424c-9b7e-bd91c06a240b": "EA Account Owner",
    "a0bcee42-bf30-4d1b-926a-48d21664ef71": "EA Subscription Creator",
    "db609904-a47f-4794-9be8-9bd86fbffd8a": "Department Administrator",
    "4e3a1b3b-a2df-44b5-bdfa-9d1d4e4a3cba": "Department Administrator (read only)",
};
/**
 * List the billing-role assignments visible at a given billing scope. Used as
 * the primary diagnostic when the Subscription Alias API returns 401: it
 * answers "does my principal actually have a role at this scope, and which
 * one?"
 *
 * `scope` must be a fully-qualified billing scope, e.g.
 *   `/providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea}`
 *
 * If `principalId` is provided, results are pre-filtered client-side
 * (the billing role-assignments API does not consistently honor `$filter`
 * across api-versions).
 *
 * Returns an empty array on 403/404 (the diagnostic itself requires
 * read permission on billingRoleAssignments — if the caller lacks that,
 * we surface "no readable assignments" rather than re-throwing).
 */
export function listBillingRoleAssignments(scope, token, principalId) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        // Strip leading slash so we can re-build the URL without doubling it.
        const cleanScope = scope.startsWith("/") ? scope.slice(1) : scope;
        // Bumped 2019-10-01-preview → 2024-04-01 (current stable per Microsoft
        // Learn API change log). Older preview versions risk silent retirement;
        // 2024-04-01 adds `systemData` and `tags` fields and is supported across
        // all four scope variants (billingAccounts, enrollmentAccounts,
        // billingProfiles, billingProfiles/invoiceSections).
        const url = `${ARM_BASE}/${cleanScope}/billingRoleAssignments` +
            `?api-version=2024-04-01`;
        const response = yield armFetch(url, {
            method: "GET",
            headers: armHeaders(token),
        });
        if (response.status === 403 || response.status === 404) {
            return [];
        }
        if (!response.ok) {
            throw yield toAzureError(response);
        }
        const body = (yield response.json());
        const items = (_a = body.value) !== null && _a !== void 0 ? _a : [];
        const lowerPrincipal = principalId === null || principalId === void 0 ? void 0 : principalId.toLowerCase();
        const filtered = lowerPrincipal
            ? items.filter((i) => { var _a, _b; return ((_b = (_a = i.properties) === null || _a === void 0 ? void 0 : _a.principalId) !== null && _b !== void 0 ? _b : "").toLowerCase() === lowerPrincipal; })
            : items;
        return filtered.map((i) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j;
            const fullRoleDefId = (_b = (_a = i.properties) === null || _a === void 0 ? void 0 : _a.roleDefinitionId) !== null && _b !== void 0 ? _b : "";
            const guid = (_c = fullRoleDefId.split("/").pop()) !== null && _c !== void 0 ? _c : "";
            return {
                id: i.id,
                roleDefinitionId: guid,
                roleDefinitionName: (_d = EA_BILLING_ROLE_NAMES[guid]) !== null && _d !== void 0 ? _d : guid,
                principalId: (_f = (_e = i.properties) === null || _e === void 0 ? void 0 : _e.principalId) !== null && _f !== void 0 ? _f : "",
                principalTenantId: (_g = i.properties) === null || _g === void 0 ? void 0 : _g.principalTenantId,
                scope: (_h = i.properties) === null || _h === void 0 ? void 0 : _h.scope,
                createdOn: (_j = i.properties) === null || _j === void 0 ? void 0 : _j.createdOn,
            };
        });
    });
}
export function diagnoseCallerBillingRole(scope, principalId, token) {
    return __awaiter(this, void 0, void 0, function* () {
        const assignments = yield listBillingRoleAssignments(scope, token, principalId);
        const subscriptionCreator = "a0bcee42-bf30-4d1b-926a-48d21664ef71";
        const enterpriseAdmin = "9f1983cb-2574-400c-87e9-34cf8e2280db";
        const accountOwner = "c15c22c0-9faf-424c-9b7e-bd91c06a240b";
        const sufficient = new Set([
            subscriptionCreator,
            enterpriseAdmin,
            accountOwner,
        ]);
        const canCreateSubscriptions = assignments.some((a) => sufficient.has(a.roleDefinitionId.toLowerCase()));
        return {
            scope,
            canCreateSubscriptions,
            assignments,
            roleNames: assignments.map((a) => a.roleDefinitionName),
        };
    });
}
// ---------------------------------------------------------------------------
// Legacy (2018-03-01-preview) EA subscription creation
// ---------------------------------------------------------------------------
//
// The "newer" Subscription Alias API at /providers/Microsoft.Subscription/
// aliases/{name} is the recommended path and is wrapped by
// createEaSubscription below. The two helpers in this block hit the
// LEGACY preview endpoint instead, exposed under
//   /providers/Microsoft.Billing/enrollmentAccounts/{id}/providers/
//     Microsoft.Subscription/createSubscription?api-version=2018-03-01-preview
//
// Differences from the modern flow:
//   - Enrollment-account names come from the LEGACY top-level
//     `/providers/Microsoft.Billing/enrollmentAccounts` listing
//     (returns each enrollment's AAD object id directly as `name`).
//   - The request body uses `offerType` (MS-AZR-0017P / MS-AZR-0148P)
//     instead of the alias body's `billingScope` + properties.
//   - The response is async via the `Location` header only — no
//     subscription alias resource exists to poll, so the helper just
//     waits on the Location URL until it returns 200 with a final
//     subscription link / id.
const ARM_LEGACY_EA_API = "2018-03-01-preview";
/**
 * `GET /providers/Microsoft.Billing/enrollmentAccounts?api-version=2018-03-01-preview`
 *
 * Different shape AND scope than the modern listEnrollmentAccounts —
 * lists every enrollment account the caller is an Owner on, regardless
 * of which EA billing-account it belongs to. This is the LEGACY entry
 * point referenced in the docs at
 *   https://learn.microsoft.com/azure/cost-management-billing/manage/programmatically-create-subscription
 */
export function listLegacyEnrollmentAccounts(token) {
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${ARM_BASE}/providers/Microsoft.Billing/enrollmentAccounts` +
            `?api-version=${ARM_LEGACY_EA_API}`;
        const rows = yield fetchAllPages(url, token);
        return rows
            .filter((r) => r.id && r.name)
            .map((r) => {
            var _a;
            return ({
                id: r.id,
                name: r.name,
                principalName: (_a = r.properties) === null || _a === void 0 ? void 0 : _a.principalName,
            });
        });
    });
}
/**
 * `POST /providers/Microsoft.Billing/enrollmentAccounts/{id}/providers/
 *       Microsoft.Subscription/createSubscription?api-version=2018-03-01-preview`
 *
 * The caller must hold Owner on the enrollment account (the AAD role,
 * NOT the modern EA Subscription Creator billing-role).
 *
 * Returns 202 + Location. We poll Location every few seconds until
 * 200/204 / a non-202 status arrives, then surface the subscription
 * link the legacy endpoint embeds in the body.
 */
export function createLegacyEaSubscription(enrollmentAccountObjectId, req, token) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        if (!UUID_REGEX.test(enrollmentAccountObjectId)) {
            throw new Error("enrollmentAccountObjectId must be a UUID.");
        }
        if (!req.offerType) {
            throw new Error("offerType is required (MS-AZR-0017P or MS-AZR-0148P).");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Billing/enrollmentAccounts/${encodeURIComponent(enrollmentAccountObjectId)}` +
            `/providers/Microsoft.Subscription/createSubscription` +
            `?api-version=${ARM_LEGACY_EA_API}`;
        const body = {
            offerType: req.offerType,
        };
        if ((_a = req.displayName) === null || _a === void 0 ? void 0 : _a.trim())
            body.displayName = req.displayName.trim();
        if (req.owners && req.owners.length > 0) {
            body.owners = req.owners
                .filter((o) => UUID_REGEX.test(o))
                .map((o) => ({ objectId: o }));
        }
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify(body),
        });
        if (!response.ok && response.status !== 202) {
            throw yield toAzureError(response);
        }
        // Async path — poll the Location URL until ARM returns a final
        // 200/204 with a subscriptionLink.
        const pollUrl = (_b = response.headers.get("Location")) !== null && _b !== void 0 ? _b : response.headers.get("Azure-AsyncOperation");
        if (!pollUrl) {
            // Synchronous success — unwrap the body.
            const data = (yield response.json().catch(() => ({})));
            return {
                subscriptionId: extractSubIdFromLink(data.subscriptionLink),
                subscriptionLink: data.subscriptionLink,
                status: response.status,
            };
        }
        const poll = yield pollAsyncOperation(pollUrl, token);
        const data = (_c = poll.body) !== null && _c !== void 0 ? _c : {};
        return {
            subscriptionId: extractSubIdFromLink(data.subscriptionLink),
            subscriptionLink: data.subscriptionLink,
            // pollAsyncOperation throws on failure; "Succeeded"/"completed" maps to HTTP 200.
            status: 200,
        };
    });
}
/** "/subscriptions/{guid}" → "{guid}", anything else → undefined. */
function extractSubIdFromLink(link) {
    if (!link)
        return undefined;
    const m = /\/subscriptions\/([0-9a-f-]{36})/i.exec(link);
    return m ? m[1] : undefined;
}
/**
 * Create a new Azure subscription under an EA billing scope via the
 * modern (2021-10-01) subscription-alias API.
 *
 * The alias API returns either 200 (synchronous success) or 202
 * (async). For 202 we poll the alias resource URL until the alias
 * lifecycle reaches a terminal `provisioningState`. Errors during the
 * poll surface as `AzureRequestError` with the alias body.
 */
export function createEaSubscription(req, token) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
    return __awaiter(this, void 0, void 0, function* () {
        validateAliasName(req.aliasName);
        validateBillingScope(req.billingScope);
        const trimmedDisplay = ((_a = req.displayName) !== null && _a !== void 0 ? _a : "").trim();
        if (trimmedDisplay.length < 3 || trimmedDisplay.length > 64) {
            throw new Error("Invalid displayName: must be 3-64 characters.");
        }
        const workload = (_b = req.workload) !== null && _b !== void 0 ? _b : "Production";
        // Cross-tenant assignment requires both subscriptionTenantId AND
        // subscriptionOwnerId per the alias API contract — Azure rejects
        // the call if only one is set.
        const cross = !!req.subscriptionTenantId;
        if (cross && !req.subscriptionOwnerId) {
            throw new Error("subscriptionOwnerId (AAD object ID) is required when subscriptionTenantId is set.");
        }
        if (req.subscriptionTenantId && !UUID_REGEX.test(req.subscriptionTenantId)) {
            throw new Error("Invalid subscriptionTenantId: must be a tenant GUID (UUID).");
        }
        if (req.subscriptionOwnerId && !UUID_REGEX.test(req.subscriptionOwnerId)) {
            throw new Error("Invalid subscriptionOwnerId: must be the Azure AD object ID GUID of the user or service principal.");
        }
        const aliasUrl = `${ARM_BASE}/providers/Microsoft.Subscription/aliases/${encodeURIComponent(req.aliasName)}` +
            `?api-version=${ARM_SUBSCRIPTION_ALIAS_API}`;
        const additionalProperties = {};
        if (req.subscriptionTenantId)
            additionalProperties.subscriptionTenantId = req.subscriptionTenantId;
        if (req.subscriptionOwnerId)
            additionalProperties.subscriptionOwnerId = req.subscriptionOwnerId;
        if (req.managementGroupId)
            additionalProperties.managementGroupId = req.managementGroupId;
        if (req.tags && Object.keys(req.tags).length > 0)
            additionalProperties.tags = req.tags;
        const body = {
            properties: Object.assign({ displayName: trimmedDisplay, billingScope: req.billingScope, workload }, (Object.keys(additionalProperties).length > 0
                ? { additionalProperties }
                : {})),
        };
        const response = yield armFetch(aliasUrl, {
            method: "PUT",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify(body),
        });
        if (response.status === 202) {
            const pollUrl = (_d = (_c = response.headers.get("Location")) !== null && _c !== void 0 ? _c : response.headers.get("Azure-AsyncOperation")) !== null && _d !== void 0 ? _d : aliasUrl;
            yield pollAsyncOperation(pollUrl, token);
            const finalResp = yield armFetch(aliasUrl, {
                headers: armHeaders(token),
            });
            if (!finalResp.ok) {
                throw yield toAzureError(finalResp);
            }
            const alias = (yield finalResp.json());
            return {
                aliasName: (_e = alias.name) !== null && _e !== void 0 ? _e : req.aliasName,
                subscriptionId: (_f = alias.properties) === null || _f === void 0 ? void 0 : _f.subscriptionId,
                provisioningState: (_h = (_g = alias.properties) === null || _g === void 0 ? void 0 : _g.provisioningState) !== null && _h !== void 0 ? _h : "Succeeded",
                displayName: (_k = (_j = alias.properties) === null || _j === void 0 ? void 0 : _j.displayName) !== null && _k !== void 0 ? _k : trimmedDisplay,
            };
        }
        if (!response.ok) {
            throw yield toAzureError(response);
        }
        const alias = (yield response.json());
        const provState = (_m = (_l = alias.properties) === null || _l === void 0 ? void 0 : _l.provisioningState) !== null && _m !== void 0 ? _m : "";
        const lower = provState.toLowerCase();
        if (lower && lower !== "succeeded" && lower !== "completed") {
            const pollResult = yield pollAsyncOperation(aliasUrl, token);
            const polled = pollResult.body;
            return {
                aliasName: (_o = polled.name) !== null && _o !== void 0 ? _o : req.aliasName,
                subscriptionId: (_p = polled.properties) === null || _p === void 0 ? void 0 : _p.subscriptionId,
                provisioningState: (_r = (_q = polled.properties) === null || _q === void 0 ? void 0 : _q.provisioningState) !== null && _r !== void 0 ? _r : "Succeeded",
                displayName: (_t = (_s = polled.properties) === null || _s === void 0 ? void 0 : _s.displayName) !== null && _t !== void 0 ? _t : trimmedDisplay,
            };
        }
        return {
            aliasName: (_u = alias.name) !== null && _u !== void 0 ? _u : req.aliasName,
            subscriptionId: (_v = alias.properties) === null || _v === void 0 ? void 0 : _v.subscriptionId,
            provisioningState: provState || "Succeeded",
            displayName: (_x = (_w = alias.properties) === null || _w === void 0 ? void 0 : _w.displayName) !== null && _x !== void 0 ? _x : trimmedDisplay,
        };
    });
}
// ---------------------------------------------------------------------------
// Subscription ownership acceptance — cross-tenant EA / MCA flow
//
// When an EA / MCA subscription is created with a `subscriptionTenantId` that
// differs from the API caller's home tenant, the new subscription enters a
// pending state. The invited owner has 7 days to accept ownership in the
// destination tenant. Documented at:
//   https://learn.microsoft.com/azure/cost-management-billing/manage/create-enterprise-subscription#create-subscription-in-other-tenant-and-view-transfer-requests
//
// This module exposes:
//   - getAcceptOwnershipStatus(subscriptionId, token)
//       GET /providers/Microsoft.Subscription/subscriptions/{id}/acceptOwnershipStatus
//       Token MUST come from the destination tenant.
//   - acceptSubscriptionOwnership(subscriptionId, body, token)
//       POST /providers/Microsoft.Subscription/subscriptions/{id}/acceptOwnership
//       Token MUST come from the destination tenant; the caller MUST be the
//       designated subscription owner (subscriptionOwnerId from the alias
//       request).
//   - buildAcceptOwnershipPortalUrl(destinationTenantId, subscriptionId?)
//       Synthesizes the portal deep-link the source-tenant operator can paste
//       to the destination-tenant approver. The approver opens this URL,
//       signs into the destination tenant, and finds the pending request on
//       the Subscriptions blade.
// ---------------------------------------------------------------------------
const ARM_SUBSCRIPTION_ACCEPT_API = "2021-10-01";
export function getAcceptOwnershipStatus(subscriptionId, token) {
    var _a, _b, _c, _d, _e, _f, _g;
    return __awaiter(this, void 0, void 0, function* () {
        if (!UUID_REGEX.test(subscriptionId)) {
            throw new Error("Invalid subscriptionId: must be a UUID.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Subscription/subscriptions/` +
            `${encodeURIComponent(subscriptionId)}/acceptOwnershipStatus` +
            `?api-version=${ARM_SUBSCRIPTION_ACCEPT_API}`;
        const response = yield armFetch(url, { headers: armHeaders(token) });
        if (!response.ok) {
            throw yield toAzureError(response);
        }
        const body = (yield response.json());
        // Some api-versions wrap fields under `properties`, others put them at the
        // top level. Read both.
        const props = (_a = body.properties) !== null && _a !== void 0 ? _a : {};
        return {
            subscriptionId,
            acceptOwnershipState: ((_c = (_b = props.acceptOwnershipState) !== null && _b !== void 0 ? _b : body.acceptOwnershipState) !== null && _c !== void 0 ? _c : "Unknown"),
            billingOwner: (_d = props.billingOwner) !== null && _d !== void 0 ? _d : body.billingOwner,
            subscriptionTenantId: (_e = props.subscriptionTenantId) !== null && _e !== void 0 ? _e : body.subscriptionTenantId,
            displayName: (_f = props.displayName) !== null && _f !== void 0 ? _f : body.displayName,
            provisioningState: (_g = props.provisioningState) !== null && _g !== void 0 ? _g : body.provisioningState,
        };
    });
}
/**
 * Accept the pending subscription ownership transfer. The token MUST be
 * obtained from the destination tenant (the tenant where `subscriptionTenantId`
 * pointed during creation). Returns once the API has accepted the request and
 * the lifecycle has settled (202 → poll Location to terminal).
 */
export function acceptSubscriptionOwnership(subscriptionId, req, token) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        if (!UUID_REGEX.test(subscriptionId)) {
            throw new Error("Invalid subscriptionId: must be a UUID.");
        }
        const url = `${ARM_BASE}/providers/Microsoft.Subscription/subscriptions/` +
            `${encodeURIComponent(subscriptionId)}/acceptOwnership` +
            `?api-version=${ARM_SUBSCRIPTION_ACCEPT_API}`;
        const properties = {};
        if (req.displayName && req.displayName.trim().length > 0) {
            properties.displayName = req.displayName.trim();
        }
        if (req.managementGroupId) {
            properties.managementGroupId = req.managementGroupId;
        }
        if (req.tags && Object.keys(req.tags).length > 0) {
            properties.tags = req.tags;
        }
        const response = yield armFetch(url, {
            method: "POST",
            headers: armHeaders(token, "application/json"),
            body: JSON.stringify({ properties }),
        });
        if (response.status === 202) {
            const pollUrl = (_a = response.headers.get("Location")) !== null && _a !== void 0 ? _a : response.headers.get("Azure-AsyncOperation");
            // No async-operation header — poll the resource URL itself rather
            // than blindly returning "Completed" mid-flight. ARM spec allows
            // 202 without Location on idempotent POSTs, and historically we
            // had a false-success bug here.
            const fallbackPollUrl = pollUrl !== null && pollUrl !== void 0 ? pollUrl : url;
            try {
                yield pollAsyncOperation(fallbackPollUrl, token);
            }
            catch (e) {
                // Even if the poll throws (e.g. transient 5xx), let the caller
                // verify with getAcceptOwnershipStatus rather than swallowing.
                throw e;
            }
            return { subscriptionId, acceptOwnershipState: "Completed" };
        }
        if (!response.ok) {
            throw yield toAzureError(response);
        }
        return { subscriptionId, acceptOwnershipState: "Completed" };
    });
}
/**
 * Synthesize the Azure portal deep-link to give the destination-tenant
 * approver. Opening this URL in their browser will:
 *   1. Drop them into portal.azure.com pinned to the destination tenant.
 *   2. Land on the Subscriptions blade, which shows pending requests.
 *
 * Optionally the subscriptionId is included as a query hint so power-users
 * can spot the right invitation. The "official" Microsoft email link is
 * generated server-side and may differ in path; this URL is the manual
 * fallback documented as "the operator can paste the URL" in the EA flow.
 */
export function buildAcceptOwnershipPortalUrl(destinationTenantId, subscriptionId) {
    const tenantSegment = destinationTenantId
        ? `#@${encodeURIComponent(destinationTenantId)}`
        : "#";
    const blade = "/blade/Microsoft_Azure_Billing/SubscriptionsBlade";
    const hint = subscriptionId
        ? `?invitedSubscriptionId=${encodeURIComponent(subscriptionId)}`
        : "";
    return `https://portal.azure.com/${tenantSegment}${blade}${hint}`;
}
//# sourceMappingURL=arm-service.js.map