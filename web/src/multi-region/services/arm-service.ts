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

import {
    ArmSubscription,
    ArmBatchAccount,
    ArmResourceGroup,
    AzureRequestError,
} from "./types";

const ARM_BASE = "https://management.azure.com";
const ARM_SUBSCRIPTION_API = "2022-12-01";
const ARM_RESOURCE_GROUP_API = "2021-04-01";
const ARM_BATCH_API = "2024-02-01";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build common headers for ARM requests.
 */
function armHeaders(
    token: string,
    contentType?: string
): Record<string, string> {
    const headers: Record<string, string> = {
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
 */
async function toAzureError(response: Response): Promise<AzureRequestError> {
    const body = await response.json().catch(() => ({}));
    const innerError = (body as any)?.error ?? {};
    return new AzureRequestError(
        innerError.message ?? `ARM request failed: ${response.status}`,
        response.status,
        innerError.code ?? "Unknown",
        body
    );
}

/**
 * Generic paginated fetch that follows ARM `nextLink` values.
 */
async function fetchAllPages<T>(
    initialUrl: string,
    token: string
): Promise<T[]> {
    const results: T[] = [];
    let url: string | undefined = initialUrl;

    while (url) {
        const response: Response = await fetch(url, {
            headers: armHeaders(token),
        });

        if (!response.ok) {
            throw await toAzureError(response);
        }

        const data: any = await response.json();
        const items = data.value;
        if (Array.isArray(items)) {
            results.push(...items);
        }

        url = data.nextLink ?? undefined;
    }

    return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all Azure subscriptions accessible with the provided token.
 *
 * @param token - Bearer token with `https://management.azure.com/.default` scope.
 * @returns Array of subscriptions with id, displayName, state, and tenantId.
 */
export async function listSubscriptions(
    token: string
): Promise<ArmSubscription[]> {
    const url = `${ARM_BASE}/subscriptions?api-version=${ARM_SUBSCRIPTION_API}`;
    return fetchAllPages<ArmSubscription>(url, token);
}

/**
 * List all Batch accounts in a subscription.
 *
 * Handles pagination via `nextLink` automatically.
 *
 * @param subscriptionId - Azure subscription ID.
 * @param token - Bearer token with ARM scope.
 * @returns Array of Batch account resources.
 */
export async function listBatchAccounts(
    subscriptionId: string,
    token: string
): Promise<ArmBatchAccount[]> {
    const url =
        `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
        `/providers/Microsoft.Batch/batchAccounts` +
        `?api-version=${ARM_BATCH_API}`;
    return fetchAllPages<ArmBatchAccount>(url, token);
}

/**
 * Get a single Batch account with full details including quota information.
 *
 * @param subscriptionId - Azure subscription ID.
 * @param resourceGroup - Resource group containing the account.
 * @param accountName - Batch account name.
 * @param token - Bearer token with ARM scope.
 * @returns The Batch account resource.
 */
export async function getBatchAccount(
    subscriptionId: string,
    resourceGroup: string,
    accountName: string,
    token: string
): Promise<ArmBatchAccount> {
    const url =
        `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
        `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
        `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
        `?api-version=${ARM_BATCH_API}`;

    const response = await fetch(url, {
        headers: armHeaders(token),
    });

    if (!response.ok) {
        throw await toAzureError(response);
    }

    return response.json();
}

/**
 * Create (or update) a resource group.
 *
 * Uses PUT semantics — the call is idempotent. If the resource group
 * already exists in the same location, this is a no-op.
 *
 * @param subscriptionId - Azure subscription ID.
 * @param rgName - Name for the resource group.
 * @param location - Azure region (e.g. "eastus").
 * @param token - Bearer token with ARM scope.
 * @returns The created or updated resource group.
 */
export async function createResourceGroup(
    subscriptionId: string,
    rgName: string,
    location: string,
    token: string
): Promise<ArmResourceGroup> {
    const url =
        `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
        `/resourcegroups/${encodeURIComponent(rgName)}` +
        `?api-version=${ARM_RESOURCE_GROUP_API}`;

    const response = await fetch(url, {
        method: "PUT",
        headers: armHeaders(token, "application/json"),
        body: JSON.stringify({ location }),
    });

    if (!response.ok) {
        throw await toAzureError(response);
    }

    return response.json();
}

/**
 * Create a Batch account via ARM PUT.
 *
 * This is a long-running operation — the response may return 202 Accepted
 * with a Location header for polling. The returned object reflects the
 * initial response body, which may have `provisioningState: "Creating"`.
 *
 * @param subscriptionId - Azure subscription ID.
 * @param resourceGroup - Resource group for the account.
 * @param accountName - Batch account name (3-24 chars, lowercase alphanumeric).
 * @param location - Azure region.
 * @param token - Bearer token with ARM scope.
 * @returns The Batch account resource (may still be provisioning).
 */
export async function createBatchAccount(
    subscriptionId: string,
    resourceGroup: string,
    accountName: string,
    location: string,
    token: string
): Promise<ArmBatchAccount> {
    const url =
        `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
        `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
        `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
        `?api-version=${ARM_BATCH_API}`;

    const response = await fetch(url, {
        method: "PUT",
        headers: armHeaders(token, "application/json"),
        body: JSON.stringify({
            location,
            properties: {
                autoStorage: null,
            },
        }),
    });

    if (!response.ok) {
        throw await toAzureError(response);
    }

    return response.json();
}
