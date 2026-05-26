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

import {
  BatchPool,
  BatchNode,
  NodeAction,
  AzureRequestError,
  classifyHttpError,
} from "./types";
import { guardedFetch } from "../scheduling/request-governance";
import { fetchAllPages as sharedFetchAllPages } from "./_shared/paginate";
import { isBlacklisted } from "../store/failure-blacklist";

const BATCH_API_VERSION = "2024-07-01.20.0";
const BATCH_CONTENT_TYPE = "application/json; odata=minimalmetadata";

function batchFamilyForAccount(accountName: string): `batch-${string}` {
  return `batch-${accountName}`;
}

function extractAccountNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    const dot = host.indexOf(".");
    return dot > 0 ? host.substring(0, dot) : host;
  } catch {
    return "default";
  }
}

function batchFetch(
  url: string,
  init?: RequestInit,
  accountName?: string,
): Promise<Response> {
  const account = accountName ?? extractAccountNameFromUrl(url);
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
function validateAccountEndpoint(endpoint: string): void {
  const normalized = endpoint.startsWith("https://")
    ? endpoint
    : `https://${endpoint}`;
  let hostname: string;
  try {
    hostname = new URL(normalized).hostname;
  } catch {
    throw new Error("Invalid accountEndpoint: must be a valid hostname.");
  }
  if (!hostname.endsWith(".batch.azure.com")) {
    throw new Error(
      "Invalid accountEndpoint: must be a *.batch.azure.com hostname.",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build common headers for Batch data plane requests.
 */
function batchHeaders(token: string, withBody = false): Record<string, string> {
  const headers: Record<string, string> = {
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
function batchUrl(
  accountEndpoint: string,
  path: string,
  extraParams?: Record<string, string>,
): string {
  const base = accountEndpoint.startsWith("https://")
    ? accountEndpoint
    : `https://${accountEndpoint}`;
  const params = new URLSearchParams({
    "api-version": BATCH_API_VERSION,
    ...extraParams,
  });
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
async function toBatchError(response: Response): Promise<AzureRequestError> {
  // Read once as text so we can fall back to the raw body when JSON
  // parsing fails — empty 409 bodies, plain-text proxy errors, etc.
  const text = await response.text().catch(() => "");
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  // Walk the three known shapes, preferring the most-specific first.
  // The flat shape is identified by a top-level `code` OR `message`
  // string-or-{value:string}-object on the body itself.
  const isFlatShape = (b: unknown): boolean => {
    if (typeof b !== "object" || b === null) return false;
    const o = b as Record<string, unknown>;
    return typeof o.code === "string" || o.message !== undefined;
  };
  const innerError: Record<string, unknown> =
    ((body as { error?: Record<string, unknown> })?.error as
      | Record<string, unknown>
      | undefined) ??
    ((body as { "odata.error"?: Record<string, unknown> })?.[
      "odata.error"
    ] as Record<string, unknown> | undefined) ??
    (isFlatShape(body) ? (body as Record<string, unknown>) : {});
  const rawMessage =
    (innerError as { message?: unknown }).message ?? undefined;
  const message =
    (typeof rawMessage === "object" &&
      rawMessage !== null &&
      "value" in rawMessage &&
      typeof (rawMessage as { value?: unknown }).value === "string" &&
      (rawMessage as { value: string }).value) ||
    (typeof rawMessage === "string" && rawMessage) ||
    (text ? text.slice(0, 400) : `Batch request failed: ${response.status}`);
  const code =
    (typeof (innerError as { code?: unknown }).code === "string" &&
      (innerError as { code: string }).code) ||
    "Unknown";
  // Compose the user-facing message: `[<code>] <message> (HTTP <status>)`.
  // Without the code, NodeStateInvalid vs UserAccountExists look
  // identical and the operator has no idea which retry strategy to
  // try.
  const composed =
    code !== "Unknown" && !message.includes(code)
      ? `[${code}] ${message} (HTTP ${response.status})`
      : `${message} (HTTP ${response.status})`;

  // Pull the URL path (no query) for audit-log context. Batch sometimes
  // returns structured details under `values: [{key, value}]` — surface
  // those on the error instance so the operator can see them in the
  // audit trail without us having to format them into the message.
  const urlPath = (() => {
    try {
      return new URL(response.url).pathname;
    } catch {
      return response.url || undefined;
    }
  })();
  const valuesArr = (innerError as { values?: unknown }).values;
  const detailValues = Array.isArray(valuesArr)
    ? (valuesArr as Array<{ key?: string; value?: string }>)
        .filter((v) => v && v.key)
        .map((v) => ({ code: v.key, message: v.value }))
    : undefined;

  // Truncate display message at 1000 chars (raw body remains in .body).
  const DISPLAY_MAX = 1000;
  const truncated =
    composed.length > DISPLAY_MAX
      ? `${composed.slice(0, DISPLAY_MAX)}…[truncated]`
      : composed;

  // Classify so RateLimit/NotFound/Auth branches can `instanceof` rather
  // than read `.status` arithmetic. Keep `Retry-After` for 429 chaining.
  const retryAfterHeader = response.headers.get("Retry-After");
  const err = classifyHttpError(
    truncated,
    response.status,
    code,
    body,
    retryAfterHeader,
  );
  if (urlPath) err.urlPath = urlPath;
  if (detailValues && detailValues.length > 0) err.details = detailValues;
  return err;
}

/**
 * Generic paginated fetch that follows Batch `odata.nextLink` values.
 * Delegates to the shared `_shared/paginate` helper. The Batch-specific
 * bits (`odata.nextLink` field name, `toBatchError` parsing) are
 * captured by the `nextLinkPath` + `fetcher` callbacks.
 */
async function fetchAllPages<T>(
  initialUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<T[]> {
  return sharedFetchAllPages<T>({
    initialUrl,
    nextLinkPath: (page: Record<string, unknown>) =>
      page["odata.nextLink"] as string | undefined,
    signal,
    fetcher: async (url, sig) => {
      const response = await batchFetch(url, {
        headers: batchHeaders(token),
        ...(sig ? { signal: sig } : {}),
      });
      if (!response.ok) {
        throw await toBatchError(response);
      }
      return response.json();
    },
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
export async function listPools(
  accountEndpoint: string,
  token: string,
  opts?: { signal?: AbortSignal },
): Promise<BatchPool[]> {
  validateAccountEndpoint(accountEndpoint);
  const url = batchUrl(accountEndpoint, "/pools");
  return fetchAllPages<BatchPool>(url, token, opts?.signal);
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
export async function createPool(
  accountEndpoint: string,
  poolConfig: Record<string, unknown>,
  token: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  validateAccountEndpoint(accountEndpoint);

  // Pre-flight blacklist check: if a previous attempt failed for THIS
  // (vmSize, region) with a non-recoverable Azure error (no quota,
  // unsupported SKU, region-out-of-stock), skip the request entirely.
  // Hammering Azure with attempts we KNOW will 4xx is a fast track to
  // anti-abuse heuristics flagging us.
  const region = extractRegionFromBatchEndpoint(accountEndpoint);
  const vmSize = (poolConfig?.vmSize as string | undefined) ?? "";
  if (region && vmSize) {
    const black = isBlacklisted(vmSize, region);
    if (black.blocked) {
      throw new AzureRequestError(
        `Skipped: (${vmSize}, ${region}) is on the failure blacklist — ${black.reason}`,
        409,
        "BlacklistedVmSizeRegion",
        { vmSize, region, reason: black.reason },
      );
    }
  }

  const url = batchUrl(accountEndpoint, "/pools");

  const response = await batchFetch(url, {
    method: "POST",
    headers: batchHeaders(token, true),
    body: JSON.stringify(poolConfig),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });

  if (!response.ok) {
    throw await toBatchError(response);
  }
}

/**
 * Pull the region segment out of a Batch endpoint hostname.
 * Examples:
 *   accountname.eastus.batch.azure.com   → "eastus"
 *   accountname.westeurope.batch.azure.com → "westeurope"
 * Returns null if the host doesn't match the expected pattern.
 */
function extractRegionFromBatchEndpoint(endpoint: string): string | null {
  try {
    const host = new URL(endpoint).hostname;
    const parts = host.split(".");
    // Pattern: <account>.<region>.batch.azure.com
    if (
      parts.length >= 4 &&
      parts[parts.length - 1] === "com" &&
      parts[parts.length - 2] === "azure" &&
      parts[parts.length - 3] === "batch"
    ) {
      return parts[parts.length - 4] ?? null;
    }
    return null;
  } catch {
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
export async function patchPool(
  accountEndpoint: string,
  poolId: string,
  patch: Record<string, unknown>,
  token: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  validateAccountEndpoint(accountEndpoint);
  const url = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}`);

  const response = await batchFetch(url, {
    method: "PATCH",
    headers: batchHeaders(token, true),
    body: JSON.stringify(patch),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });

  // Idempotent: treat 404 as success — the pool is gone, the desired
  // patch is trivially satisfied. Caller re-fetches state if it needs
  // to distinguish "patched" from "already gone".
  if (response.status === 404) return;

  if (!response.ok) {
    throw await toBatchError(response);
  }
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
export async function deletePool(
  accountEndpoint: string,
  poolId: string,
  token: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  validateAccountEndpoint(accountEndpoint);
  const url = batchUrl(accountEndpoint, `/pools/${encodeURIComponent(poolId)}`);

  const response = await batchFetch(url, {
    method: "DELETE",
    headers: batchHeaders(token),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });

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
    const peek = await response.clone().json().catch(() => null) as
      | { code?: string; "odata.error"?: { code?: string } }
      | null;
    const code =
      (peek && (peek.code ?? peek["odata.error"]?.code)) ?? "";
    if (code === "PoolBeingDeleted") return;
  }

  if (!response.ok) {
    throw await toBatchError(response);
  }
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
export async function listNodes(
  accountEndpoint: string,
  poolId: string,
  token: string,
  opts?: { signal?: AbortSignal },
): Promise<BatchNode[]> {
  validateAccountEndpoint(accountEndpoint);
  const url = batchUrl(
    accountEndpoint,
    `/pools/${encodeURIComponent(poolId)}/nodes`,
  );
  return fetchAllPages<BatchNode>(url, token, opts?.signal);
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
export async function performNodeAction(
  accountEndpoint: string,
  poolId: string,
  nodeId: string,
  action: NodeAction,
  token: string,
): Promise<void> {
  validateAccountEndpoint(accountEndpoint);
  const actionPath: Record<NodeAction, string> = {
    reboot: "reboot",
    reimage: "reimage",
    disableScheduling: "disablescheduling",
    enableScheduling: "enablescheduling",
  };

  const segment = actionPath[action];
  const url = batchUrl(
    accountEndpoint,
    `/pools/${encodeURIComponent(poolId)}/nodes/${encodeURIComponent(nodeId)}/${segment}`,
  );

  const response = await batchFetch(url, {
    method: "POST",
    headers: batchHeaders(token, true),
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw await toBatchError(response);
  }
}

/**
 * Get remote-login settings (IP + port) for a single compute node.
 *
 * Maps to GET /pools/{poolId}/nodes/{nodeId}/remoteloginsettings.
 *
 * Returns the IP/port the operator can use to SSH (Linux) or RDP
 * (Windows) into the node. Before connecting, the caller MUST also
 * create a node user via {@link createNodeUser} — Batch nodes have no
 * default credentials.
 *
 * As of API version 2024-07-01 (and all pools created after
 * 2025-11-30), Batch no longer maps SSH/RDP ports by default. For
 * those pools the operator must have set up port mapping via
 * NetworkConfiguration on the pool, otherwise this call returns 404.
 *
 * **Security**: `accountEndpoint` is validated. `poolId` and `nodeId`
 * are URI-encoded.
 */
export interface BatchNodeRemoteLoginSettings {
  remoteLoginIPAddress: string;
  remoteLoginPort: number;
}

export async function getNodeRemoteLoginSettings(
  accountEndpoint: string,
  poolId: string,
  nodeId: string,
  token: string,
): Promise<BatchNodeRemoteLoginSettings> {
  validateAccountEndpoint(accountEndpoint);
  const url = batchUrl(
    accountEndpoint,
    `/pools/${encodeURIComponent(poolId)}/nodes/${encodeURIComponent(nodeId)}/remoteloginsettings`,
  );
  const response = await batchFetch(url, {
    method: "GET",
    headers: batchHeaders(token, false),
  });
  if (!response.ok) {
    throw await toBatchError(response);
  }
  const data = (await response.json()) as Record<string, unknown>;
  return {
    remoteLoginIPAddress: String(data.remoteLoginIPAddress ?? ""),
    remoteLoginPort: Number(data.remoteLoginPort ?? 0),
  };
}

/**
 * Create (or replace) a user account on a compute node for SSH/RDP.
 *
 * Maps to POST /pools/{poolId}/nodes/{nodeId}/users.
 *
 * **Linux**: pass `password` OR `sshPublicKey` (or both). The public
 * key must be base-64 OpenSSH format.
 * **Windows**: pass `password`. `sshPublicKey` is rejected (HTTP 400).
 *
 * `expiryTime` defaults to 24 h from now when omitted — short-lived
 * accounts are a safety net so a forgotten temp user doesn't linger.
 * `isAdmin` defaults to false; flip to true if the operator needs
 * sudo / Admin permissions for diagnostics.
 *
 * **Security**: `accountEndpoint` is validated. `poolId` and `nodeId`
 * are URI-encoded. Password / SSH key are sent in the JSON body — the
 * caller is responsible for not logging them.
 */
export interface BatchNodeUserCreateOptions {
  name: string;
  isAdmin?: boolean;
  /** ISO timestamp. Default: now + 24 h. */
  expiryTime?: string;
  password?: string;
  /** Base-64 OpenSSH-encoded. Linux-only. */
  sshPublicKey?: string;
}

export async function createNodeUser(
  accountEndpoint: string,
  poolId: string,
  nodeId: string,
  user: BatchNodeUserCreateOptions,
  token: string,
): Promise<void> {
  validateAccountEndpoint(accountEndpoint);
  if (!user?.name || typeof user.name !== "string") {
    throw new Error("createNodeUser: 'name' is required");
  }
  if (!user.password && !user.sshPublicKey) {
    throw new Error(
      "createNodeUser: must specify either 'password' or 'sshPublicKey'",
    );
  }
  const body: Record<string, unknown> = {
    name: user.name,
    isAdmin: !!user.isAdmin,
    expiryTime:
      user.expiryTime ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  if (user.password) body.password = user.password;
  if (user.sshPublicKey) body.sshPublicKey = user.sshPublicKey;

  const baseUsersUrl = batchUrl(
    accountEndpoint,
    `/pools/${encodeURIComponent(poolId)}/nodes/${encodeURIComponent(nodeId)}/users`,
  );
  const specificUserUrl = batchUrl(
    accountEndpoint,
    `/pools/${encodeURIComponent(poolId)}/nodes/${encodeURIComponent(nodeId)}/users/${encodeURIComponent(user.name)}`,
  );

  // First attempt: plain POST. The happy path for a fresh node.
  let response = await batchFetch(baseUsersUrl, {
    method: "POST",
    headers: batchHeaders(token, true),
    body: JSON.stringify(body),
  });
  if (response.ok) return;

  // 409 here is almost always one of:
  //   - NodeUserExists: a previous Connect attempt left this user behind.
  //   - The node user-account cap (~20) is full from prior clicks.
  // In either case, DELETE the named user (idempotent — 404 means it was
  // never there to begin with) and retry the POST. This makes the
  // operator's "click Connect, retry" workflow self-healing.
  if (response.status === 409) {
    const delResp = await batchFetch(specificUserUrl, {
      method: "DELETE",
      headers: batchHeaders(token, false),
    });
    // Ignore 404 (no such user). Surface other errors as the original
    // 409 — the operator sees the same error code with no fallback
    // confusion.
    if (!delResp.ok && delResp.status !== 404) {
      throw await toBatchError(response);
    }
    response = await batchFetch(baseUsersUrl, {
      method: "POST",
      headers: batchHeaders(token, true),
      body: JSON.stringify(body),
    });
    if (response.ok) return;
  }

  throw await toBatchError(response);
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

export async function removeNodes(
  accountEndpoint: string,
  poolId: string,
  nodeIds: string[],
  token: string,
): Promise<void> {
  validateAccountEndpoint(accountEndpoint);
  if (nodeIds.length === 0) return;
  const url = batchUrl(
    accountEndpoint,
    `/pools/${encodeURIComponent(poolId)}/removenodes`,
  );

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
    const response = await batchFetch(url, {
      method: "POST",
      headers: batchHeaders(token, true),
      body: JSON.stringify({ nodeList: chunk }),
    });

    // Idempotent teardown: 404 = pool or nodes already gone — caller's
    // intent ("these nodes shouldn't exist") is satisfied. 409 codes
    // NodeAlreadyRemoved / PoolBeingDeleted / NodeBeingRemoved mean an
    // in-flight removal — also satisfied.
    if (response.status === 404) continue;
    if (response.status === 409) {
      const err = await toBatchError(response);
      if (
        /NodeAlreadyRemoved|PoolBeingDeleted|NodeBeingRemoved/i.test(err.code)
      ) {
        continue;
      }
      throw err;
    }

    if (!response.ok) {
      throw await toBatchError(response);
    }
  }
}
