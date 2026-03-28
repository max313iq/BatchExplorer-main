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

import { BatchPool, BatchNode, NodeAction, AzureRequestError } from "./types";

const BATCH_API_VERSION = "2024-07-01.20.0";
const BATCH_CONTENT_TYPE = "application/json; odata=minimalmetadata";

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
            "Invalid accountEndpoint: must be a *.batch.azure.com hostname."
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
    extraParams?: Record<string, string>
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
 */
async function toBatchError(response: Response): Promise<AzureRequestError> {
    const body = await response.json().catch(() => ({}));
    const innerError =
        (body as any)?.error ?? (body as any)?.["odata.error"] ?? {};
    const message =
        innerError.message?.value ??
        innerError.message ??
        `Batch request failed: ${response.status}`;
    return new AzureRequestError(
        message,
        response.status,
        innerError.code ?? "Unknown",
        body
    );
}

/**
 * Generic paginated fetch that follows Batch `odata.nextLink` values.
 */
async function fetchAllPages<T>(
    initialUrl: string,
    token: string
): Promise<T[]> {
    const results: T[] = [];
    let url: string | undefined = initialUrl;

    while (url) {
        const response: Response = await fetch(url, {
            headers: batchHeaders(token),
        });

        if (!response.ok) {
            throw await toBatchError(response);
        }

        const data: any = await response.json();
        const items = data.value;
        if (Array.isArray(items)) {
            results.push(...items);
        }

        url = data["odata.nextLink"] ?? undefined;
    }

    return results;
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
    token: string
): Promise<BatchPool[]> {
    validateAccountEndpoint(accountEndpoint);
    const url = batchUrl(accountEndpoint, "/pools");
    return fetchAllPages<BatchPool>(url, token);
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
    token: string
): Promise<void> {
    validateAccountEndpoint(accountEndpoint);
    const url = batchUrl(accountEndpoint, "/pools");

    const response = await fetch(url, {
        method: "POST",
        headers: batchHeaders(token, true),
        body: JSON.stringify(poolConfig),
    });

    if (!response.ok) {
        throw await toBatchError(response);
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
    token: string
): Promise<void> {
    validateAccountEndpoint(accountEndpoint);
    const url = batchUrl(
        accountEndpoint,
        `/pools/${encodeURIComponent(poolId)}`
    );

    const response = await fetch(url, {
        method: "PATCH",
        headers: batchHeaders(token, true),
        body: JSON.stringify(patch),
    });

    if (!response.ok) {
        throw await toBatchError(response);
    }
}

/**
 * Delete a pool from a Batch account.
 *
 * **Security**: `accountEndpoint` is validated. `poolId` is URI-encoded.
 *
 * @param accountEndpoint - The Batch account endpoint (must be *.batch.azure.com).
 * @param poolId - ID of the pool to delete.
 * @param token - Bearer token with Batch scope.
 */
export async function deletePool(
    accountEndpoint: string,
    poolId: string,
    token: string
): Promise<void> {
    validateAccountEndpoint(accountEndpoint);
    const url = batchUrl(
        accountEndpoint,
        `/pools/${encodeURIComponent(poolId)}`
    );

    const response = await fetch(url, {
        method: "DELETE",
        headers: batchHeaders(token),
    });

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
    token: string
): Promise<BatchNode[]> {
    validateAccountEndpoint(accountEndpoint);
    const url = batchUrl(
        accountEndpoint,
        `/pools/${encodeURIComponent(poolId)}/nodes`
    );
    return fetchAllPages<BatchNode>(url, token);
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
    token: string
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
        `/pools/${encodeURIComponent(poolId)}/nodes/${encodeURIComponent(nodeId)}/${segment}`
    );

    const response = await fetch(url, {
        method: "POST",
        headers: batchHeaders(token, true),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw await toBatchError(response);
    }
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
export async function removeNodes(
    accountEndpoint: string,
    poolId: string,
    nodeIds: string[],
    token: string
): Promise<void> {
    validateAccountEndpoint(accountEndpoint);
    const url = batchUrl(
        accountEndpoint,
        `/pools/${encodeURIComponent(poolId)}/removenodes`
    );

    const response = await fetch(url, {
        method: "POST",
        headers: batchHeaders(token, true),
        body: JSON.stringify({ nodeList: nodeIds }),
    });

    if (!response.ok) {
        throw await toBatchError(response);
    }
}
