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

interface ArgRequestBody {
  subscriptions?: string[];
  query: string;
  options?: {
    $top?: number;
    $skipToken?: string;
    resultFormat?: "objectArray" | "table";
  };
}

interface ArgResponse {
  totalRecords?: number;
  count?: number;
  data?: unknown[];
  facets?: unknown[];
  $skipToken?: string;
}

export interface ArgQueryResult<T> {
  rows: T[];
  totalRecords: number;
  /** True if results were paginated and at least one ARM POST per page happened. */
  paginated: boolean;
  /** Number of ARM POSTs issued. Useful for telemetry / debug. */
  requestCount: number;
}

export interface ArgQueryOptions {
  /** ARM bearer token. The same token works across subs the user has access to. */
  token: string;
  /** KQL query — must NOT include a `where subscriptionId in (...)` filter; we set it via subscriptions. */
  query: string;
  /** Subscription scope; ARG will filter by these. Empty array = all subs the token can see. */
  subscriptionIds?: string[];
  /**
   * Cancel the pagination walk + chunk fan-out. When fired, in-flight
   * fetches abort and the cumulative result is discarded. Matches the
   * `signal` pattern used in arm-service / batch-service / graph-service.
   */
  signal?: AbortSignal;
}

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
export async function runArgQuery<T = Record<string, unknown>>(
  opts: ArgQueryOptions,
): Promise<ArgQueryResult<T>> {
  const { token, query, subscriptionIds, signal } = opts;
  if (!query || !query.trim()) {
    throw new Error("runArgQuery: empty query");
  }
  if (signal?.aborted) throw abortError();

  const subs = subscriptionIds ?? [];
  let chunks: Array<string[] | undefined>;
  if (subs.length === 0) {
    // No filter — ARG returns everything the token can see.
    chunks = [undefined];
  } else if (subs.length <= MAX_SUBS_PER_QUERY) {
    chunks = [subs];
  } else {
    chunks = [];
    for (let i = 0; i < subs.length; i += MAX_SUBS_PER_QUERY) {
      chunks.push(subs.slice(i, i + MAX_SUBS_PER_QUERY));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const allRows: T[] = [];
  let totalRecords = 0;
  let requestCount = 0;
  let paginated = false;

  // Run chunks in parallel — each chunk is its own pagination loop.
  const chunkResults = await Promise.all(
    chunks.map(async (chunkSubs) => {
      const localRows: T[] = [];
      let localTotal = 0;
      let localCount = 0;
      let localPaginated = false;
      let skipToken: string | undefined;

      do {
        if (signal?.aborted) throw abortError();
        const body: ArgRequestBody = {
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
          body.options!.$skipToken = skipToken;
        }

        // ARG is global (not per-sub), so we route under a virtual
        // subscriptionId of "_arg" so the guard's per-sub concurrency
        // limiter doesn't accidentally serialize all ARG traffic onto
        // whatever sub the user looked at last.
        const response = await guardedFetch(
          ARG_URL,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
          },
          { subscriptionId: "_arg", family: "arm" },
        );
        localCount++;

        // ARG publishes its own throttle headers separate from ARM's
        // x-ms-ratelimit-remaining-* family. The default 15-queries-per-
        // 5-second budget is shared across pagination, so a multi-page
        // catalog refresh can drain it fast. When we see the budget
        // dropping low, sleep proactively for the published reset
        // window — the request-governance guard reads the standard ARM
        // headers but doesn't know about ARG's quota namespace, so this
        // is the right place to honor it.
        await maybeBackoffForArgQuota(response.headers);

        if (!response.ok) {
          let errBody: Record<string, unknown> = {};
          try {
            errBody = (await response.json()) as Record<string, unknown>;
          } catch {
            /**/
          }
          const inner = (errBody as { error?: Record<string, unknown> })?.error ??
            {};
          const rawMessage =
            (inner.message as string) ??
            `ARG query failed: ${response.status} ${response.statusText}`;
          const urlPath = (() => {
            try {
              return new URL(response.url).pathname;
            } catch {
              return undefined;
            }
          })();
          const display = urlPath
            ? `${response.status} ${urlPath}: ${rawMessage}`
            : rawMessage;
          const retryAfterHeader = response.headers.get("Retry-After");
          const err = classifyHttpError(
            display,
            response.status,
            (inner.code as string) ?? "ResourceGraphFailed",
            errBody,
            retryAfterHeader,
          );
          if (urlPath) err.urlPath = urlPath;
          const innerDetails = inner.details as
            | Array<Record<string, unknown>>
            | undefined;
          if (Array.isArray(innerDetails) && innerDetails.length > 0) {
            err.details = innerDetails.slice(0, 20).map((d) => ({
              code: d.code as string | undefined,
              message: d.message as string | undefined,
            }));
          }
          throw err;
        }

        const data = (await response.json()) as ArgResponse;
        if (Array.isArray(data.data)) {
          localRows.push(...(data.data as T[]));
        }
        if (typeof data.totalRecords === "number") {
          localTotal = data.totalRecords;
        }
        skipToken = data.$skipToken;
        if (skipToken) localPaginated = true;
      } while (skipToken);

      return {
        rows: localRows,
        total: localTotal,
        count: localCount,
        paginated: localPaginated,
      };
    }),
  );

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
async function maybeBackoffForArgQuota(headers: Headers): Promise<void> {
  const remaining = headers.get("x-ms-user-quota-remaining");
  if (remaining === null) return;
  const remainingN = Number(remaining);
  if (!Number.isFinite(remainingN) || remainingN > ARG_QUOTA_FLOOR) return;

  const reset = headers.get("x-ms-user-quota-resets-after");
  // Default to 5s — ARG's standard window.
  let waitMs = 5_000;
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
  waitMs = Math.min(30_000, Math.max(0, waitMs));
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * Convenience: list every Batch account the token can see across the
 * given subscriptions in one (or a few) requests.
 *
 * Replaces the per-subscription `listBatchAccounts(subId, token)` loop —
 * one ARG POST instead of N paginated GETs.
 */
export interface ArgBatchAccountRow {
  id: string;
  name: string;
  type: string;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  tenantId?: string;
  /** Properties.poolAllocationMode — "BatchService" or "UserSubscription". */
  poolAllocationMode?: string;
  /** Properties.provisioningState — "Succeeded" / "Failed" / etc. */
  provisioningState?: string;
  tags?: Record<string, string>;
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

export async function listBatchAccountsViaArg(
  token: string,
  subscriptionIds: string[],
  opts?: { signal?: AbortSignal },
): Promise<ArgQueryResult<ArgBatchAccountRow>> {
  return runArgQuery<ArgBatchAccountRow>({
    token,
    query: BATCH_ACCOUNT_KQL,
    subscriptionIds,
    signal: opts?.signal,
  });
}

/**
 * One ARG row per Batch pool across the supplied subscriptions.
 *
 * Mirrors the shape of {@link ArgBatchAccountRow} but for pools — used
 * by the orchestrator to refresh pool inventory across many accounts
 * in a single ARM POST. Without ARG, refreshing pool state is
 * O(accounts × pools-per-account × pagination), and a sweep across
 * dozens of accounts can take minutes; ARG returns the lot in one
 * request (capped at 1000 rows per page).
 */
export interface ArgBatchPoolRow {
  id: string;
  name: string;
  type: string;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  tenantId?: string;
  /** Parent account name — derived from the parent id segment. */
  accountName?: string;
  /** properties.vmSize — VM SKU the pool was created with. */
  vmSize?: string;
  /** properties.allocationState — "steady" | "resizing" | "stopping". */
  allocationState?: string;
  /** properties.currentDedicatedNodes — node-count snapshot. */
  currentDedicatedNodes?: number;
  /** properties.currentLowPriorityNodes — spot-node-count snapshot. */
  currentLowPriorityNodes?: number;
  /** properties.targetDedicatedNodes — desired-state dedicated count. */
  targetDedicatedNodes?: number;
  /** properties.targetLowPriorityNodes — desired-state spot count. */
  targetLowPriorityNodes?: number;
  /** properties.provisioningState — "Succeeded" / "Failed" / etc. */
  provisioningState?: string;
  tags?: Record<string, string>;
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

export async function listPoolsViaArg(
  token: string,
  subscriptionIds: string[],
  opts?: { signal?: AbortSignal },
): Promise<ArgQueryResult<ArgBatchPoolRow>> {
  return runArgQuery<ArgBatchPoolRow>({
    token,
    query: BATCH_POOL_KQL,
    subscriptionIds,
    signal: opts?.signal,
  });
}
