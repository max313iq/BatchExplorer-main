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
import { BatchPool, BatchNode, NodeAction } from "./types";
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
export declare function listPools(accountEndpoint: string, token: string, opts?: {
    signal?: AbortSignal;
}): Promise<BatchPool[]>;
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
export declare function createPool(accountEndpoint: string, poolConfig: Record<string, unknown>, token: string, opts?: {
    signal?: AbortSignal;
}): Promise<void>;
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
export declare function patchPool(accountEndpoint: string, poolId: string, patch: Record<string, unknown>, token: string, opts?: {
    signal?: AbortSignal;
}): Promise<void>;
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
export declare function deletePool(accountEndpoint: string, poolId: string, token: string, opts?: {
    signal?: AbortSignal;
}): Promise<void>;
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
export declare function listNodes(accountEndpoint: string, poolId: string, token: string, opts?: {
    signal?: AbortSignal;
}): Promise<BatchNode[]>;
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
export declare function performNodeAction(accountEndpoint: string, poolId: string, nodeId: string, action: NodeAction, token: string): Promise<void>;
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
export declare function getNodeRemoteLoginSettings(accountEndpoint: string, poolId: string, nodeId: string, token: string): Promise<BatchNodeRemoteLoginSettings>;
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
export declare function createNodeUser(accountEndpoint: string, poolId: string, nodeId: string, user: BatchNodeUserCreateOptions, token: string): Promise<void>;
export declare function removeNodes(accountEndpoint: string, poolId: string, nodeIds: string[], token: string): Promise<void>;
//# sourceMappingURL=batch-service.d.ts.map