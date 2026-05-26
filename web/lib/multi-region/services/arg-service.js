import { __awaiter } from "tslib";
/**
 * Azure Resource Graph (ARG) service — KQL-style queries that span MANY
 * subscriptions in a single ARM call.
 *
 * Why this exists:
 *   The single biggest throughput win for multi-subscription operations
 *   is replacing per-subscription paginated list calls with one ARG
 *   query. A dashboard listing Batch accounts across 50 subs goes from
 *   ~50 paginated GETs (often ≥100 round-trips after pagination) to ONE
 *   ARG POST that returns all rows. That's a 50–100× reduction in ARM
 *   request volume — and Azure's per-sub read budget is the #1 source
 *   of throttling for read-heavy admin UIs.
 *
 * Endpoint: POST /providers/Microsoft.ResourceGraph/resources
 * API:      2022-10-01
 * Body:     { subscriptions: [...], query: "<KQL>", options: {...} }
 *
 * Reference: https://learn.microsoft.com/azure/governance/resource-graph/overview
 */
import { guardedFetch } from "../scheduling/request-governance";
import { abortError } from "./abort-helpers";
import { classifyHttpError } from "./types";
// Pinned api-version for Microsoft.ResourceGraph. Centralized here (and
// not inlined into ARG_URL alone) so the constant is greppable when we
// bump it — matches the convention in arm-service.ts.
const ARG_API_VERSION = "2022-10-01";
const ARG_URL = `https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API_VERSION}`;
/**
 * Cap per-page rows. ARG defaults to 100; max is 1000. We use 1000 to
 * minimize round-trips. Sub-1000 result sets come back in one page.
 */
const ARG_PAGE_SIZE = 1000;
/**
 * ARG enforces a hard cap of subscriptions per request. Above ~1000 you
 * get a 400. We chunk preemptively to stay safe.
 */
const MAX_SUBS_PER_QUERY = 500;
/**
 * Threshold below which ARG's own per-user query budget triggers a
 * pre-emptive sleep. The default ARG budget is 15 queries per 5 seconds
 * (per the official guidance at
 * https://learn.microsoft.com/azure/governance/resource-graph/concepts/guidance-for-throttled-requests),
 * so dropping to 3 leaves headroom for at least one more burst before
 * we hit a hard 429.
 */
const ARG_QUOTA_FLOOR = 3;
/**
 * Run a KQL query through Azure Resource Graph, paginating through every
 * page automatically. Returns a flat `rows` array of typed records.
 *
 * Subscription chunking: if the caller passes >MAX_SUBS_PER_QUERY ids,
 * we issue parallel requests per chunk and merge. Each chunk still
 * follows pagination internally.
 *
 * Errors propagate as AzureRequestError with the ARM error envelope.
 */
export function runArgQuery(opts) {
    return __awaiter(this, void 0, void 0, function* () {
        const { token, query, subscriptionIds, signal } = opts;
        if (!query || !query.trim()) {
            throw new Error("runArgQuery: empty query");
        }
        if (signal === null || signal === void 0 ? void 0 : signal.aborted)
            throw abortError();
        const subs = subscriptionIds !== null && subscriptionIds !== void 0 ? subscriptionIds : [];
        let chunks;
        if (subs.length === 0) {
            // No filter — ARG returns everything the token can see.
            chunks = [undefined];
        }
        else if (subs.length <= MAX_SUBS_PER_QUERY) {
            chunks = [subs];
        }
        else {
            chunks = [];
            for (let i = 0; i < subs.length; i += MAX_SUBS_PER_QUERY) {
                chunks.push(subs.slice(i, i + MAX_SUBS_PER_QUERY));
            }
        }
        const headers = {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
        };
        const allRows = [];
        let totalRecords = 0;
        let requestCount = 0;
        let paginated = false;
        // Run chunks in parallel — each chunk is its own pagination loop.
        const chunkResults = yield Promise.all(chunks.map((chunkSubs) => __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const localRows = [];
            let localTotal = 0;
            let localCount = 0;
            let localPaginated = false;
            let skipToken;
            do {
                if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                    throw abortError();
                const body = {
                    query,
                    options: {
                        $top: ARG_PAGE_SIZE,
                        resultFormat: "objectArray",
                    },
                };
                if (chunkSubs && chunkSubs.length > 0) {
                    body.subscriptions = chunkSubs;
                }
                if (skipToken) {
                    body.options.$skipToken = skipToken;
                }
                // ARG is global (not per-sub), so we route under a virtual
                // subscriptionId of "_arg" so the guard's per-sub concurrency
                // limiter doesn't accidentally serialize all ARG traffic onto
                // whatever sub the user looked at last.
                const response = yield guardedFetch(ARG_URL, Object.assign({ method: "POST", headers, body: JSON.stringify(body) }, (signal ? { signal } : {})), { subscriptionId: "_arg", family: "arm" });
                localCount++;
                // ARG publishes its own throttle headers separate from ARM's
                // x-ms-ratelimit-remaining-* family. The default 15-queries-per-
                // 5-second budget is shared across pagination, so a multi-page
                // catalog refresh can drain it fast. When we see the budget
                // dropping low, sleep proactively for the published reset
                // window — the request-governance guard reads the standard ARM
                // headers but doesn't know about ARG's quota namespace, so this
                // is the right place to honor it.
                yield maybeBackoffForArgQuota(response.headers);
                if (!response.ok) {
                    let errBody = {};
                    try {
                        errBody = (yield response.json());
                    }
                    catch (_d) {
                        /**/
                    }
                    const inner = (_a = errBody === null || errBody === void 0 ? void 0 : errBody.error) !== null && _a !== void 0 ? _a : {};
                    const rawMessage = (_b = inner.message) !== null && _b !== void 0 ? _b : `ARG query failed: ${response.status} ${response.statusText}`;
                    const urlPath = (() => {
                        try {
                            return new URL(response.url).pathname;
                        }
                        catch (_a) {
                            return undefined;
                        }
                    })();
                    const display = urlPath
                        ? `${response.status} ${urlPath}: ${rawMessage}`
                        : rawMessage;
                    const retryAfterHeader = response.headers.get("Retry-After");
                    const err = classifyHttpError(display, response.status, (_c = inner.code) !== null && _c !== void 0 ? _c : "ResourceGraphFailed", errBody, retryAfterHeader);
                    if (urlPath)
                        err.urlPath = urlPath;
                    const innerDetails = inner.details;
                    if (Array.isArray(innerDetails) && innerDetails.length > 0) {
                        err.details = innerDetails.slice(0, 20).map((d) => ({
                            code: d.code,
                            message: d.message,
                        }));
                    }
                    throw err;
                }
                const data = (yield response.json());
                if (Array.isArray(data.data)) {
                    localRows.push(...data.data);
                }
                if (typeof data.totalRecords === "number") {
                    localTotal = data.totalRecords;
                }
                skipToken = data.$skipToken;
                if (skipToken)
                    localPaginated = true;
            } while (skipToken);
            return {
                rows: localRows,
                total: localTotal,
                count: localCount,
                paginated: localPaginated,
            };
        })));
        for (const r of chunkResults) {
            allRows.push(...r.rows);
            totalRecords += r.total;
            requestCount += r.count;
            paginated = paginated || r.paginated;
        }
        return {
            rows: allRows,
            totalRecords,
            paginated,
            requestCount,
        };
    });
}
/**
 * If ARG signals our quota is running low, pause the next page until
 * the published reset elapses. Reading both headers per the docs:
 *
 *   x-ms-user-quota-remaining: int (queries left in the current window)
 *   x-ms-user-quota-resets-after: hh:mm:ss
 *
 * Pure function over the response headers; no mutable global state, no
 * dependency on the caller. Caller awaits the returned promise so the
 * pagination loop pauses naturally.
 */
function maybeBackoffForArgQuota(headers) {
    return __awaiter(this, void 0, void 0, function* () {
        const remaining = headers.get("x-ms-user-quota-remaining");
        if (remaining === null)
            return;
        const remainingN = Number(remaining);
        if (!Number.isFinite(remainingN) || remainingN > ARG_QUOTA_FLOOR)
            return;
        const reset = headers.get("x-ms-user-quota-resets-after");
        // Default to 5s — ARG's standard window.
        let waitMs = 5000;
        if (reset) {
            const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(reset.trim());
            if (m) {
                const h = Number(m[1]);
                const min = Number(m[2]);
                const s = Number(m[3]);
                waitMs = (h * 3600 + min * 60 + s) * 1000;
            }
        }
        // Cap to 30s — anything beyond that is almost certainly a misread
        // header and we'd rather risk a 429 than freeze the UI.
        waitMs = Math.min(30000, Math.max(0, waitMs));
        if (waitMs > 0) {
            yield new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    });
}
const BATCH_ACCOUNT_KQL = `
Resources
| where type =~ 'microsoft.batch/batchaccounts'
| project id, name, type, location,
          resourceGroup,
          subscriptionId, tenantId,
          poolAllocationMode = tostring(properties.poolAllocationMode),
          provisioningState = tostring(properties.provisioningState),
          tags
`.trim();
export function listBatchAccountsViaArg(token, subscriptionIds, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        return runArgQuery({
            token,
            query: BATCH_ACCOUNT_KQL,
            subscriptionIds,
            signal: opts === null || opts === void 0 ? void 0 : opts.signal,
        });
    });
}
const BATCH_POOL_KQL = `
Resources
| where type =~ 'microsoft.batch/batchaccounts/pools'
| extend accountName = tostring(split(id, '/')[8])
| project id, name, type, location,
          resourceGroup,
          subscriptionId, tenantId,
          accountName,
          vmSize = tostring(properties.vmSize),
          allocationState = tostring(properties.allocationState),
          currentDedicatedNodes = toint(properties.currentDedicatedNodes),
          currentLowPriorityNodes = toint(properties.currentLowPriorityNodes),
          targetDedicatedNodes = toint(properties.scaleSettings.fixedScale.targetDedicatedNodes),
          targetLowPriorityNodes = toint(properties.scaleSettings.fixedScale.targetLowPriorityNodes),
          provisioningState = tostring(properties.provisioningState),
          tags
`.trim();
export function listPoolsViaArg(token, subscriptionIds, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        return runArgQuery({
            token,
            query: BATCH_POOL_KQL,
            subscriptionIds,
            signal: opts === null || opts === void 0 ? void 0 : opts.signal,
        });
    });
}
//# sourceMappingURL=arg-service.js.map