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
// Input validation
// ---------------------------------------------------------------------------

const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCOUNT_NAME_REGEX = /^[a-z0-9]{3,24}$/;

/**
 * Validate that a subscription ID matches the expected UUID format.
 * Prevents injection of path-traversal or unexpected segments into ARM URLs.
 */
function validateSubscriptionId(subscriptionId: string): void {
    if (!UUID_REGEX.test(subscriptionId)) {
        throw new Error("Invalid subscriptionId format: must be a valid UUID.");
    }
}

/**
 * Validate that a Batch account name is alphanumeric, 3-24 characters.
 * Azure Batch account names only allow lowercase letters and digits.
 */
function validateAccountName(accountName: string): void {
    if (!ACCOUNT_NAME_REGEX.test(accountName)) {
        throw new Error(
            "Invalid accountName: must be 3-24 lowercase alphanumeric characters."
        );
    }
}

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
 * Poll an Azure async operation until it completes or times out.
 * Azure long-running operations return 202 with a Location or Azure-AsyncOperation header.
 * We poll that URL until the operation reaches a terminal state.
 */
async function pollAsyncOperation(
    pollUrl: string,
    token: string,
    timeoutMs: number = 300000, // 5 minutes
    intervalMs: number = 5000 // 5 seconds
): Promise<{ status: string; body: Record<string, unknown> }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));

        const response = await fetch(pollUrl, {
            headers: armHeaders(token),
        });

        if (response.status === 200 || response.status === 201) {
            // Operation complete — return the final resource
            const body = (await response.json()) as Record<string, unknown>;
            return { status: "Succeeded", body };
        }

        if (response.status === 202) {
            // Still in progress — check for updated Location header
            const newUrl =
                response.headers.get("Location") ??
                response.headers.get("Azure-AsyncOperation");
            if (newUrl) {
                pollUrl = newUrl;
            }
            // Continue polling
            continue;
        }

        if (!response.ok) {
            // Operation failed
            const errorBody = (await response
                .json()
                .catch(() => ({}))) as Record<string, unknown>;
            const innerErr = errorBody?.error as
                | Record<string, unknown>
                | undefined;
            throw new AzureRequestError(
                (innerErr?.message as string) ??
                    `Async operation failed: ${response.status}`,
                response.status,
                (innerErr?.code as string) ?? "AsyncOperationFailed",
                errorBody
            );
        }

        // Check if response body has a terminal status
        const body = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
        >;
        const props = body?.properties as Record<string, unknown> | undefined;
        const opStatus = (
            (body?.status as string) ??
            (props?.provisioningState as string) ??
            ""
        ).toLowerCase();

        if (opStatus === "succeeded" || opStatus === "completed") {
            return { status: "Succeeded", body };
        }
        if (
            opStatus === "failed" ||
            opStatus === "canceled" ||
            opStatus === "cancelled"
        ) {
            const errInner = body?.error as Record<string, unknown> | undefined;
            throw new AzureRequestError(
                (errInner?.message as string) ?? `Operation ${opStatus}`,
                response.status,
                (errInner?.code as string) ?? "OperationFailed",
                body
            );
        }
        // Still in progress (InProgress, Creating, etc.) — continue polling
    }

    // Timeout
    throw new AzureRequestError(
        `Async operation timed out after ${timeoutMs / 1000}s`,
        408,
        "OperationTimeout",
        {}
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
 * **Security**: The token is sent as a Bearer header only to the hardcoded
 * ARM endpoint. No user input is interpolated into the URL.
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
 * **Security**: `subscriptionId` is validated as a UUID and URI-encoded
 * before interpolation. No secrets are stored or logged.
 *
 * @param subscriptionId - Azure subscription ID (must be a valid UUID).
 * @param token - Bearer token with ARM scope.
 * @returns Array of Batch account resources.
 */
export async function listBatchAccounts(
    subscriptionId: string,
    token: string
): Promise<ArmBatchAccount[]> {
    validateSubscriptionId(subscriptionId);
    const url =
        `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
        `/providers/Microsoft.Batch/batchAccounts` +
        `?api-version=${ARM_BATCH_API}`;
    return fetchAllPages<ArmBatchAccount>(url, token);
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
export async function getBatchAccount(
    subscriptionId: string,
    resourceGroup: string,
    accountName: string,
    token: string
): Promise<ArmBatchAccount> {
    validateSubscriptionId(subscriptionId);
    validateAccountName(accountName);
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
export async function createResourceGroup(
    subscriptionId: string,
    rgName: string,
    location: string,
    token: string
): Promise<ArmResourceGroup> {
    validateSubscriptionId(subscriptionId);
    const url =
        `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
        `/resourcegroups/${encodeURIComponent(rgName)}` +
        `?api-version=${ARM_RESOURCE_GROUP_API}`;

    const response = await fetch(url, {
        method: "PUT",
        headers: armHeaders(token, "application/json"),
        body: JSON.stringify({ location }),
    });

    // Handle async creation (unlikely for RGs but be safe)
    if (response.status === 202) {
        const pollUrl =
            response.headers.get("Location") ??
            response.headers.get("Azure-AsyncOperation");
        if (pollUrl) {
            const result = await pollAsyncOperation(pollUrl, token);
            return result.body as unknown as ArmResourceGroup;
        }
    }

    if (!response.ok) {
        throw await toAzureError(response);
    }

    return response.json();
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
export async function createBatchAccount(
    subscriptionId: string,
    resourceGroup: string,
    accountName: string,
    location: string,
    token: string
): Promise<ArmBatchAccount> {
    validateSubscriptionId(subscriptionId);
    validateAccountName(accountName);
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

    // Handle async creation (202 Accepted)
    if (response.status === 202) {
        const pollUrl =
            response.headers.get("Location") ??
            response.headers.get("Azure-AsyncOperation");
        if (pollUrl) {
            const result = await pollAsyncOperation(pollUrl, token);
            return result.body as unknown as ArmBatchAccount;
        }
        // No poll URL — fall through to return what we have
    }

    if (!response.ok) {
        throw await toAzureError(response);
    }

    // 200 or 201 — synchronous success
    const account = (await response.json()) as ArmBatchAccount;

    // Verify provisioningState if present
    const provState = (
        account as unknown as Record<string, Record<string, unknown>>
    )?.properties?.provisioningState as string | undefined;
    if (provState && provState !== "Succeeded" && provState !== "succeeded") {
        // Account is still provisioning — poll the resource URL directly
        const resourceUrl =
            `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
            `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
            `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
            `?api-version=${ARM_BATCH_API}`;

        const maxWaitMs = 120000; // 2 minutes
        const pollMs = 5000;
        const start = Date.now();

        while (Date.now() - start < maxWaitMs) {
            await new Promise((r) => setTimeout(r, pollMs));
            const pollResp = await fetch(resourceUrl, {
                headers: armHeaders(token),
            });
            if (pollResp.ok) {
                const polled = (await pollResp.json()) as Record<
                    string,
                    Record<string, unknown>
                >;
                const state = polled?.properties?.provisioningState as
                    | string
                    | undefined;
                if (state === "Succeeded" || state === "succeeded") {
                    return polled as unknown as ArmBatchAccount;
                }
                if (state === "Failed" || state === "Canceled") {
                    throw new AzureRequestError(
                        `Batch account creation ${state}: ${(polled?.properties?.statusText as string) ?? ""}`,
                        400,
                        `ProvisioningState${state}`,
                        polled as unknown as Record<string, unknown>
                    );
                }
            }
        }
    }

    return account;
}
