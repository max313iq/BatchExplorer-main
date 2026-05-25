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
  ValidationError,
  classifyHttpError,
  EaBillingAccount,
  EaBillingProfile,
  EaInvoiceSection,
  EaEnrollmentAccount,
  EaCapability,
  CreateSubscriptionRequest,
} from "./types";
import { guardedFetch } from "../scheduling/request-governance";
import { abortError } from "./abort-helpers";
import { fetchAllPages as sharedFetchAllPages } from "./_shared/paginate";
import {
  getBatchAccountQuota,
  invalidateQuotaCache,
} from "./quota-service";

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
const EA_BILLING_SCOPE_REGEX =
  /^\/providers\/Microsoft\.Billing\/billingAccounts\/[^/]+\/(?:billingProfiles\/[^/]+\/invoiceSections\/[^/]+|enrollmentAccounts\/[^/]+)$/;

const ARM_SUB_RE = /\/subscriptions\/([0-9a-f-]{36})/i;

function extractSubscriptionId(url: string): string {
  const m = ARM_SUB_RE.exec(url);
  return m ? m[1] : "default";
}

function armFetch(
  url: string,
  init?: RequestInit,
  subscriptionId?: string,
): Promise<Response> {
  return guardedFetch(url, init, {
    subscriptionId: subscriptionId ?? extractSubscriptionId(url),
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
function nextPollIntervalMs(
  headers: Headers,
  floorMs: number,
  ceilMs: number,
): number {
  const raw = headers.get("Retry-After") ?? headers.get("retry-after");
  if (raw === null || raw === "") return floorMs;
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
      "Invalid accountName: must be 3-24 lowercase alphanumeric characters.",
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
  contentType?: string,
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
 *
 * Azure responses carry their detail in body.error.{code,message,details}.
 * This helper extracts as much context as possible — when the JSON body
 * is empty / malformed (some 400s come back as plain text or html), we
 * fall back to the raw response text so the operator can see WHY the
 * call failed instead of a bare "ARM request failed: 400". The original
 * URL is included so cascading callers can identify the failing step.
 */
async function toAzureError(response: Response): Promise<AzureRequestError> {
  // Try JSON first; if that fails, capture the raw text so 400 errors
  // that come back as text/html or empty bodies still surface something.
  let body: Record<string, unknown> = {};
  let rawText: string | undefined;
  try {
    const text = await response.text();
    rawText = text;
    if (text && text.trim()) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Not JSON — keep the raw text for the message fallback.
      }
    }
  } catch {
    // Network read failure; leave body empty.
  }

  const innerError = (body as { error?: Record<string, unknown> })?.error ?? {};
  const innerMessage = innerError.message as string | undefined;
  const innerCode = innerError.code as string | undefined;
  const innerDetails = innerError.details as
    | Array<Record<string, unknown>>
    | undefined;

  // Best message available, in order of preference.
  let message: string;
  if (innerMessage && innerMessage.trim()) {
    message = innerMessage.trim();
  } else if (typeof body === "object" && Object.keys(body).length > 0) {
    message = JSON.stringify(body);
  } else if (rawText && rawText.trim()) {
    message = rawText.trim().slice(0, 500);
  } else {
    message =
      `ARM request failed: ${response.status} ${response.statusText || ""}`.trim();
  }

  // Fold any nested details into the message so a single error toast
  // still shows the policy / quota / validation problem inline.
  if (Array.isArray(innerDetails) && innerDetails.length > 0) {
    const detailLines = innerDetails
      .map((d) => {
        const c = (d.code as string | undefined) ?? "";
        const m = (d.message as string | undefined) ?? "";
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
    } catch {
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
  const err = classifyHttpError(
    message,
    response.status,
    innerCode ?? "AzureRequestError",
    body,
    retryAfterHeader,
  );

  // Attach urlPath + structured details to the error instance so the
  // caller's `auditLog.record({ error: err })` sees them as discrete
  // fields rather than having to parse the message string.
  if (urlPath) err.urlPath = urlPath;
  if (Array.isArray(innerDetails) && innerDetails.length > 0) {
    err.details = innerDetails
      .map((d) => ({
        code: d.code as string | undefined,
        message: d.message as string | undefined,
      }))
      .filter((d) => d.code || d.message);
  }
  return err;
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
async function pollAsyncOperation(
  pollUrl: string,
  token: string,
  timeoutMs: number = 300000, // 5 minutes
  intervalMs: number = 5000, // 5 seconds (minimum)
): Promise<{ status: string; body: Record<string, unknown> }> {
  const startTime = Date.now();
  const MAX_INTERVAL_MS = 60_000;
  let nextWaitMs = intervalMs;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, nextWaitMs));

    const response = await armFetch(pollUrl, {
      headers: armHeaders(token),
    });

    // Refresh wait from Retry-After on every response. Honored regardless
    // of status — Azure may signal "back off" on 200s too if budget is tight.
    nextWaitMs = nextPollIntervalMs(response.headers, intervalMs, MAX_INTERVAL_MS);

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
      // Continue polling — wait already updated from Retry-After above
      continue;
    }

    if (!response.ok) {
      // Operation failed
      const errorBody = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const innerErr = errorBody?.error as Record<string, unknown> | undefined;
      throw new AzureRequestError(
        (innerErr?.message as string) ??
          `Async operation failed: ${response.status}`,
        response.status,
        (innerErr?.code as string) ?? "AsyncOperationFailed",
        errorBody,
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
        body,
      );
    }
    // Still in progress (InProgress, Creating, etc.) — continue polling
  }

  // Timeout
  throw new AzureRequestError(
    `Async operation timed out after ${timeoutMs / 1000}s`,
    408,
    "OperationTimeout",
    {},
  );
}

/**
 * Generic paginated fetch that follows ARM `nextLink` values.
 * Delegates to the shared `_shared/paginate` helper so the loop, abort
 * handling, and progressive-render hook stay in one place across
 * arm / graph / batch / quota services.
 */
async function fetchAllPages<T>(
  initialUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<T[]> {
  return sharedFetchAllPages<T>({
    initialUrl,
    nextLinkPath: (page: { nextLink?: string }) => page.nextLink,
    signal,
    fetcher: async (url, sig) => {
      const response = await armFetch(url, {
        headers: armHeaders(token),
        ...(sig ? { signal: sig } : {}),
      });
      if (!response.ok) {
        throw await toAzureError(response);
      }
      return response.json();
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resource provider registration
// ---------------------------------------------------------------------------

export interface ProviderRegistration {
  namespace: string;
  registrationState: string;
}

const PROVIDER_NAMESPACE_REGEX = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;

function validateProviderNamespace(namespace: string): void {
  if (!PROVIDER_NAMESPACE_REGEX.test(namespace)) {
    throw new Error(
      `Invalid provider namespace: must match ${PROVIDER_NAMESPACE_REGEX}`,
    );
  }
}

/**
 * Get the registration state of a single resource provider on a subscription.
 */
export async function getProviderRegistration(
  subscriptionId: string,
  namespace: string,
  token: string,
): Promise<ProviderRegistration> {
  validateSubscriptionId(subscriptionId);
  validateProviderNamespace(namespace);
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/providers/${encodeURIComponent(namespace)}` +
    `?api-version=${ARM_PROVIDER_API}`;
  const response = await armFetch(url, { headers: armHeaders(token) });
  if (!response.ok) {
    throw await toAzureError(response);
  }
  const body = (await response.json()) as Record<string, unknown>;
  return {
    namespace: (body.namespace as string) ?? namespace,
    registrationState: (body.registrationState as string) ?? "Unknown",
  };
}

/**
 * Trigger registration of a resource provider on a subscription.
 * Idempotent — registering an already-registered provider is a no-op
 * server-side.
 */
export async function registerProvider(
  subscriptionId: string,
  namespace: string,
  token: string,
): Promise<void> {
  validateSubscriptionId(subscriptionId);
  validateProviderNamespace(namespace);
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/providers/${encodeURIComponent(namespace)}/register` +
    `?api-version=${ARM_PROVIDER_API}`;
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token),
  });
  if (!response.ok) {
    throw await toAzureError(response);
  }
}

// In-memory cache of namespaces confirmed Registered for a given
// subscription within this session. Avoids redundant GETs across multiple
// provisioning runs.
const _registeredCache = new Map<string, Set<string>>();

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
export async function ensureProvidersRegistered(
  subscriptionId: string,
  namespaces: string[],
  token: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ alreadyRegistered: string[]; newlyRegistered: string[] }> {
  validateSubscriptionId(subscriptionId);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 5_000;

  const cached = _registeredCache.get(subscriptionId) ?? new Set<string>();
  const alreadyRegistered: string[] = [];
  const newlyRegistered: string[] = [];

  // Parallel fan-out: each namespace registration is independent, so we
  // run them concurrently (4 namespaces × ~10 polls each). Previously
  // the loop was serial, multiplying total wall time by N. Promise.all
  // here is bounded — REQUIRED_PROVIDERS in provisioner-agent has ≤ 4
  // entries, well within ARM's per-sub concurrency cap. Each underlying
  // ARM call still flows through guardedFetch's circuit breaker so a
  // throttle in one namespace doesn't cascade.
  await Promise.all(
    namespaces.map(async (namespace) => {
      if (cached.has(namespace)) {
        alreadyRegistered.push(namespace);
        return;
      }

      const initial = await getProviderRegistration(
        subscriptionId,
        namespace,
        token,
      );

      if (initial.registrationState === "Registered") {
        alreadyRegistered.push(namespace);
        cached.add(namespace);
        return;
      }

      if (initial.registrationState !== "Registering") {
        await registerProvider(subscriptionId, namespace, token);
      }

      const start = Date.now();
      let lastState = initial.registrationState;
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const cur = await getProviderRegistration(
          subscriptionId,
          namespace,
          token,
        );
        lastState = cur.registrationState;
        if (lastState === "Registered") break;
      }

      if (lastState !== "Registered") {
        throw new AzureRequestError(
          `Provider ${namespace} did not reach Registered state within ${
            timeoutMs / 1000
          }s on subscription ${subscriptionId} (last state: ${lastState}).`,
          408,
          "ProviderRegistrationTimeout",
          {},
        );
      }
      cached.add(namespace);
      newlyRegistered.push(namespace);
    }),
  );

  _registeredCache.set(subscriptionId, cached);
  return { alreadyRegistered, newlyRegistered };
}

/**
 * Test-only: clear the in-memory provider-registration cache.
 */
export function _resetProviderRegistrationCacheForTest(): void {
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
export async function listSubscriptions(
  token: string,
  opts?: { signal?: AbortSignal },
): Promise<ArmSubscription[]> {
  const url = `${ARM_BASE}/subscriptions?api-version=${ARM_SUBSCRIPTION_API}`;
  return fetchAllPages<ArmSubscription>(url, token, opts?.signal);
}

// ---------------------------------------------------------------------------
// Resource Manager — resource groups + cross-subscription move
// ---------------------------------------------------------------------------

/** List resource groups in a subscription (used as move destinations). */
export async function listResourceGroups(
  subscriptionId: string,
  token: string,
): Promise<ArmResourceGroup[]> {
  validateSubscriptionId(subscriptionId);
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourcegroups?api-version=${ARM_RESOURCE_GROUP_API}`;
  return fetchAllPages<ArmResourceGroup>(url, token);
}

/**
 * Outcome of validateMoveResources / moveResources. ARM returns 202 +
 * Location/Azure-AsyncOperation for the long-running operation; the
 * helper resolves only after the operation completes (or surfaces the
 * polling URL so the UI can keep watching).
 */
export interface ResourceMoveOutcome {
  /** Final HTTP status from the long-running operation (200/204 = OK). */
  status: number;
  /** True if the operation completed successfully. */
  ok: boolean;
  /** Error message if the operation failed (validation or move). */
  error?: string;
  /** Raw operation response body (may include validation details). */
  body?: Record<string, unknown>;
}

interface MoveBody {
  resources: string[];
  targetResourceGroup: string;
}

async function postMoveRequest(
  url: string,
  body: MoveBody,
  token: string,
): Promise<ResourceMoveOutcome> {
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify(body),
  });
  // Immediate non-async response (rare).
  if (response.status === 200 || response.status === 204) {
    return { status: response.status, ok: true };
  }
  if (response.status === 202) {
    const pollUrl =
      response.headers.get("Azure-AsyncOperation") ??
      response.headers.get("Location");
    if (!pollUrl) {
      return {
        status: 202,
        ok: true,
        error: "ARM accepted the operation but returned no Location header.",
      };
    }
    try {
      const result = await pollAsyncOperation(pollUrl, token);
      const ok = result.status >= 200 && result.status < 300;
      return {
        status: result.status,
        ok,
        body: result.body as Record<string, unknown>,
        error: ok
          ? undefined
          : ((result.body as { error?: { message?: string } })?.error
              ?.message ?? "Move operation failed."),
      };
    } catch (pollErr) {
      return {
        status: 0,
        ok: false,
        error: pollErr instanceof Error ? pollErr.message : String(pollErr),
      };
    }
  }
  // Sync error path.
  const err = await toAzureError(response);
  return { status: response.status, ok: false, error: err.message };
}

/**
 * Pre-flight move validation — same body as moveResources but the ARM
 * endpoint only runs the dependency/lock checks. Surfaces granular
 * per-resource errors so the UI can show what would fail before the
 * operator commits to the actual move.
 */
export async function validateMoveResources(
  sourceSubscriptionId: string,
  sourceResourceGroupName: string,
  resourceIds: string[],
  targetResourceGroupArmId: string,
  token: string,
): Promise<ResourceMoveOutcome> {
  validateSubscriptionId(sourceSubscriptionId);
  if (!sourceResourceGroupName) {
    throw new ValidationError(
      "sourceResourceGroupName is required.",
      "InvalidInput",
      { field: "sourceResourceGroupName" },
    );
  }
  if (resourceIds.length === 0) {
    throw new ValidationError(
      "At least one resourceId is required.",
      "InvalidInput",
      { field: "resourceIds" },
    );
  }
  if (!targetResourceGroupArmId.startsWith("/subscriptions/")) {
    throw new ValidationError(
      "targetResourceGroupArmId must be a full /subscriptions/{id}/resourceGroups/{name} ARM path.",
      "InvalidInput",
      { field: "targetResourceGroupArmId" },
    );
  }
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(sourceSubscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(sourceResourceGroupName)}` +
    `/validateMoveResources?api-version=${ARM_RESOURCE_GROUP_API}`;
  return postMoveRequest(
    url,
    { resources: resourceIds, targetResourceGroup: targetResourceGroupArmId },
    token,
  );
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
export async function moveResources(
  sourceSubscriptionId: string,
  sourceResourceGroupName: string,
  resourceIds: string[],
  targetResourceGroupArmId: string,
  token: string,
): Promise<ResourceMoveOutcome> {
  validateSubscriptionId(sourceSubscriptionId);
  if (!sourceResourceGroupName) {
    throw new ValidationError(
      "sourceResourceGroupName is required.",
      "InvalidInput",
      { field: "sourceResourceGroupName" },
    );
  }
  if (resourceIds.length === 0) {
    throw new ValidationError(
      "At least one resourceId is required.",
      "InvalidInput",
      { field: "resourceIds" },
    );
  }
  if (resourceIds.length > 800) {
    throw new ValidationError(
      "moveResources accepts at most 800 resources per call. Chunk and call repeatedly.",
      "InvalidInput",
      { field: "resourceIds" },
    );
  }
  if (!targetResourceGroupArmId.startsWith("/subscriptions/")) {
    throw new ValidationError(
      "targetResourceGroupArmId must be a full /subscriptions/{id}/resourceGroups/{name} ARM path.",
      "InvalidInput",
      { field: "targetResourceGroupArmId" },
    );
  }
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(sourceSubscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(sourceResourceGroupName)}` +
    `/moveResources?api-version=${ARM_RESOURCE_GROUP_API}`;
  return postMoveRequest(
    url,
    { resources: resourceIds, targetResourceGroup: targetResourceGroupArmId },
    token,
  );
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
export async function changeSubscriptionTenant(
  subscriptionId: string,
  destinationTenantId: string,
  token: string,
): Promise<{ status: number; location?: string }> {
  validateSubscriptionId(subscriptionId);
  if (!UUID_REGEX.test(destinationTenantId)) {
    throw new Error("destinationTenantId must be a UUID.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Subscription/subscriptions/` +
    `${encodeURIComponent(subscriptionId)}/changeTenant` +
    `?api-version=2021-10-01`;
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ properties: { tenantId: destinationTenantId } }),
  });
  if (!response.ok && response.status !== 202) throw await toAzureError(response);
  return {
    status: response.status,
    location:
      response.headers.get("Azure-AsyncOperation") ??
      response.headers.get("Location") ??
      undefined,
  };
}

/**
 * Move an EA billing subscription to a different enrollment account
 * inside the same billing account. The destination ARM id is the full
 * `/providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea}`
 * path. Returns 202 + Location; the operation is async (1–5 min).
 */
export async function moveBillingSubscriptionToEnrollmentAccount(
  billingAccountName: string,
  billingSubscriptionName: string,
  destinationEnrollmentAccountArmId: string,
  token: string,
): Promise<{ status: number; location?: string }> {
  validateBillingAccountName(billingAccountName);
  validateBillingAccountName(billingSubscriptionName);
  if (!destinationEnrollmentAccountArmId.includes("/enrollmentAccounts/")) {
    throw new Error(
      "destinationEnrollmentAccountArmId must be a full enrollmentAccounts ARM path.",
    );
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingSubscriptions/${encodeURIComponent(billingSubscriptionName)}` +
    `/move?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({
      destinationEnrollmentAccountId: destinationEnrollmentAccountArmId,
    }),
  });
  if (!response.ok && response.status !== 202) throw await toAzureError(response);
  return {
    status: response.status,
    location: response.headers.get("Location") ?? undefined,
  };
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
export async function assignSubscriptionRole(
  subscriptionId: string,
  principalObjectId: string,
  roleDefinitionGuid: string,
  token: string,
  opts?: { principalType?: "User" | "ServicePrincipal" | "Group" },
): Promise<{ roleAssignmentId: string; alreadyExisted: boolean }> {
  validateSubscriptionId(subscriptionId);
  if (!UUID_REGEX.test(principalObjectId)) {
    throw new Error("Invalid principalObjectId: must be a valid UUID.");
  }
  if (!UUID_REGEX.test(roleDefinitionGuid)) {
    throw new Error("Invalid roleDefinitionGuid: must be a valid UUID.");
  }

  const assignmentName = crypto.randomUUID();
  const scope = `/subscriptions/${subscriptionId}`;
  const url =
    `${ARM_BASE}${scope}` +
    `/providers/Microsoft.Authorization/roleAssignments/${assignmentName}` +
    `?api-version=${ARM_ROLE_ASSIGNMENT_API}`;
  const body = {
    properties: {
      roleDefinitionId: `${scope}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionGuid}`,
      principalId: principalObjectId,
      principalType: opts?.principalType ?? "User",
    },
  };

  const response = await armFetch(
    url,
    {
      method: "PUT",
      headers: armHeaders(token, "application/json"),
      body: JSON.stringify(body),
    },
    subscriptionId,
  );

  if (response.ok) {
    const data = (await response.json()) as { id?: string };
    return { roleAssignmentId: data.id ?? assignmentName, alreadyExisted: false };
  }

  // ARM returns 409 + code RoleAssignmentExists when the principal already
  // holds the role at this scope. Treat as idempotent success.
  if (response.status === 409) {
    const body409 = await response.json().catch(() => ({}));
    const code = String(
      (body409 as { error?: { code?: string } })?.error?.code ?? "",
    );
    if (code === "RoleAssignmentExists") {
      return { roleAssignmentId: assignmentName, alreadyExisted: true };
    }
    throw new AzureRequestError(
      (body409 as { error?: { message?: string } })?.error?.message ??
        "Role assignment conflict.",
      409,
      code || "Conflict",
      body409 as Record<string, unknown>,
    );
  }
  throw await toAzureError(response);
}

// ---------------------------------------------------------------------------
// Subscription-scope role-assignment management (Sub Manager page)
// ---------------------------------------------------------------------------

/**
 * Role assignment row as surfaced to the UI. Subset of the ARM response
 * with friendly fields and the full ARM id retained for the DELETE call.
 */
export interface RoleAssignmentRow {
  /** Full ARM resource id, e.g. `/subscriptions/.../roleAssignments/{guid}`. */
  id: string;
  /** Just the GUID portion. */
  name: string;
  /** Role definition GUID (last segment of `roleDefinitionId`). */
  roleDefinitionId: string;
  /** Full ARM roleDefinitionId path — used to look up the friendly name. */
  roleDefinitionIdFull: string;
  /** Principal object id (User, Group, or ServicePrincipal). */
  principalId: string;
  /** "User" | "Group" | "ServicePrincipal" | "ForeignGroup" | "Unknown". */
  principalType: string;
  /** Scope this assignment lives at (e.g. `/subscriptions/{id}`). */
  scope: string;
  /** True when scope == requested subscription scope (i.e. not inherited). */
  atScope: boolean;
  /** ISO timestamp from `createdOn` if returned. */
  createdOn?: string;
  /** Description if the assignment was created with one. */
  description?: string;
}

interface ArmRoleAssignment {
  id?: string;
  name?: string;
  properties?: {
    roleDefinitionId?: string;
    principalId?: string;
    principalType?: string;
    scope?: string;
    createdOn?: string;
    description?: string;
  };
}

/**
 * List every role assignment visible at a subscription's scope, including
 * those inherited from management group / tenant scopes. The `atScope`
 * field on each row tells the UI whether deletion at the sub scope is
 * meaningful (deleting an inherited assignment at sub scope is a no-op /
 * 404 — Azure only allows deleting at the scope the assignment was
 * created at).
 */
export async function listSubscriptionRoleAssignments(
  subscriptionId: string,
  token: string,
): Promise<RoleAssignmentRow[]> {
  validateSubscriptionId(subscriptionId);
  const scope = `/subscriptions/${subscriptionId}`;
  const url =
    `${ARM_BASE}${scope}` +
    `/providers/Microsoft.Authorization/roleAssignments` +
    `?api-version=${ARM_ROLE_ASSIGNMENT_API}`;
  const rows = await fetchAllPages<ArmRoleAssignment>(url, token);
  return rows
    .filter((r) => r.id && r.name && r.properties?.roleDefinitionId)
    .map((r) => {
      const props = r.properties!;
      const rdId = props.roleDefinitionId!;
      const rdGuid = rdId.split("/").pop() ?? rdId;
      const rowScope = props.scope ?? scope;
      return {
        id: r.id!,
        name: r.name!,
        roleDefinitionId: rdGuid,
        roleDefinitionIdFull: rdId,
        principalId: props.principalId ?? "",
        principalType: props.principalType ?? "Unknown",
        scope: rowScope,
        atScope:
          rowScope.toLowerCase() === scope.toLowerCase() ||
          rowScope.toLowerCase().startsWith(`${scope.toLowerCase()}/`),
        createdOn: props.createdOn,
        description: props.description,
      } satisfies RoleAssignmentRow;
    });
}

/**
 * Delete a role assignment by its full ARM resource id. The ARM API
 * returns 204 No Content on success and 204 / 404 on "already gone" —
 * both are treated as success here so a retry after a partial failure
 * is safe.
 */
export async function deleteRoleAssignment(
  roleAssignmentArmId: string,
  token: string,
): Promise<void> {
  // Defensive sanity check — the id must look like an ARM resource path.
  if (
    !roleAssignmentArmId.startsWith("/") ||
    !roleAssignmentArmId.includes("/Microsoft.Authorization/roleAssignments/")
  ) {
    throw new Error(
      "Invalid roleAssignmentArmId: must be a full ARM resource path.",
    );
  }
  const url =
    `${ARM_BASE}${roleAssignmentArmId}` +
    `?api-version=${ARM_ROLE_ASSIGNMENT_API}`;
  const response = await armFetch(
    url,
    {
      method: "DELETE",
      headers: armHeaders(token),
    },
    extractSubscriptionId(roleAssignmentArmId),
  );
  if (response.ok || response.status === 204 || response.status === 404) {
    return;
  }
  throw await toAzureError(response);
}

/** Friendly view of a role definition for the picker dropdown. */
export interface RoleDefinitionRow {
  /** Role definition GUID (last segment of the ARM id). */
  id: string;
  /** Full ARM id including scope (used as roleDefinitionId in PUT body). */
  armId: string;
  name: string;
  description: string;
  /** "BuiltInRole" | "CustomRole". */
  type: string;
}

interface ArmRoleDefinition {
  id?: string;
  name?: string;
  properties?: {
    roleName?: string;
    description?: string;
    type?: string;
  };
}

/**
 * List role definitions visible at a subscription scope. Includes both
 * built-in roles (Owner, Contributor, Reader, …) and any custom roles
 * defined at or above the subscription.
 */
export async function listSubscriptionRoleDefinitions(
  subscriptionId: string,
  token: string,
): Promise<RoleDefinitionRow[]> {
  validateSubscriptionId(subscriptionId);
  const scope = `/subscriptions/${subscriptionId}`;
  const url =
    `${ARM_BASE}${scope}` +
    `/providers/Microsoft.Authorization/roleDefinitions` +
    `?api-version=${ARM_ROLE_ASSIGNMENT_API}`;
  const rows = await fetchAllPages<ArmRoleDefinition>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.name!,
      armId: r.id!,
      name: r.properties?.roleName ?? r.name!,
      description: r.properties?.description ?? "",
      type: r.properties?.type ?? "BuiltInRole",
    }));
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
  token: string,
  opts?: { signal?: AbortSignal },
): Promise<ArmBatchAccount[]> {
  validateSubscriptionId(subscriptionId);
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/providers/Microsoft.Batch/batchAccounts` +
    `?api-version=${ARM_BATCH_API}`;
  return fetchAllPages<ArmBatchAccount>(url, token, opts?.signal);
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
  token: string,
): Promise<ArmBatchAccount> {
  validateSubscriptionId(subscriptionId);
  validateAccountName(accountName);
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
    `?api-version=${ARM_BATCH_API}`;

  const response = await armFetch(url, {
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
  token: string,
): Promise<ArmResourceGroup> {
  validateSubscriptionId(subscriptionId);
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourcegroups/${encodeURIComponent(rgName)}` +
    `?api-version=${ARM_RESOURCE_GROUP_API}`;

  const response = await armFetch(url, {
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
    const pollUrl =
      response.headers.get("Location") ??
      response.headers.get("Azure-AsyncOperation");
    if (pollUrl) {
      const result = await pollAsyncOperation(pollUrl, token);
      return result.body as unknown as ArmResourceGroup;
    }
    // No header — poll the resource URL itself.
    const result = await pollAsyncOperation(url, token);
    return result.body as unknown as ArmResourceGroup;
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
  token: string,
  opts?: { signal?: AbortSignal },
): Promise<ArmBatchAccount> {
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
    const quota = await getBatchAccountQuota(subscriptionId, location, token);
    if (quota.available <= 0) {
      throw new AzureRequestError(
        `Skipped: Batch account quota for region "${location}" is exhausted ` +
          `(${quota.currentCount}/${quota.accountQuota} used). ` +
          `Open a support ticket to raise the quota or pick another region.`,
        409,
        "BatchAccountQuotaExhausted",
        {
          subscriptionId,
          location,
          accountQuota: quota.accountQuota,
          currentCount: quota.currentCount,
        },
      );
    }
  } catch (err) {
    if (err instanceof AzureRequestError && err.code === "BatchAccountQuotaExhausted") {
      throw err;
    }
    // Probe failed for some other reason — fall through to the create.
  }

  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
    `?api-version=${ARM_BATCH_API}`;

  const response = await armFetch(url, {
    method: "PUT",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({
      location,
      properties: {
        autoStorage: null,
      },
    }),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });

  // Successful create changes the count — invalidate the cached quota
  // entry so the next probe reflects the new state immediately.
  if (response.ok || response.status === 202) {
    invalidateQuotaCache(subscriptionId, location);
  }

  // Handle async creation (202 Accepted)
  if (response.status === 202) {
    const pollUrl =
      response.headers.get("Location") ??
      response.headers.get("Azure-AsyncOperation");
    if (pollUrl) {
      const result = await pollAsyncOperation(pollUrl, token);
      return result.body as unknown as ArmBatchAccount;
    }
    // No async-operation header — poll the resource URL directly until
    // provisioningState reaches a terminal value. Falling through to
    // `response.json()` on a 202 body is unsafe (the body is empty),
    // and returning the body shape mid-flight would mislead callers
    // into thinking creation already completed.
    const resourceUrl =
      `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
      `/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(accountName)}` +
      `?api-version=${ARM_BATCH_API}`;
    const result = await pollAsyncOperation(resourceUrl, token);
    return result.body as unknown as ArmBatchAccount;
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
    const MIN_POLL_MS = 5000;
    const MAX_POLL_MS = 60000;
    let pollMs = MIN_POLL_MS;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const pollResp = await armFetch(resourceUrl, {
        headers: armHeaders(token),
      });
      // Honor Retry-After if Azure published a hint on the resource probe.
      pollMs = nextPollIntervalMs(pollResp.headers, MIN_POLL_MS, MAX_POLL_MS);
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
            polled as unknown as Record<string, unknown>,
          );
        }
      }
    }
  }

  return account;
}

// ---------------------------------------------------------------------------
// Enterprise Agreement (EA) — billing accounts, profiles, invoice sections,
// and subscription-alias creation.
// ---------------------------------------------------------------------------

function validateBillingAccountName(name: string): void {
  if (!EA_BILLING_ACCOUNT_NAME_REGEX.test(name)) {
    throw new Error("Invalid billingAccountName: contains illegal characters.");
  }
}

function validateAliasName(name: string): void {
  if (!EA_ALIAS_NAME_REGEX.test(name)) {
    throw new Error(
      "Invalid aliasName: must be 3-63 chars of lowercase a-z, 0-9, or '-'.",
    );
  }
}

function validateBillingScope(scope: string): void {
  if (!EA_BILLING_SCOPE_REGEX.test(scope)) {
    throw new Error(
      "Invalid billingScope: expected /providers/Microsoft.Billing/billingAccounts/{ba}/billingProfiles/{bp}/invoiceSections/{is} (MCA) or /providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea} (EA enrollment).",
    );
  }
}

interface EaApiBillingAccountRow {
  id?: string;
  name?: string;
  properties?: {
    displayName?: string;
    agreementType?: string;
    accountStatus?: string;
    accountType?: string;
  };
}

interface EaApiBillingProfileRow {
  id?: string;
  name?: string;
  properties?: {
    displayName?: string;
    status?: string;
  };
}

interface EaApiInvoiceSectionRow {
  id?: string;
  name?: string;
  properties?: {
    displayName?: string;
    state?: string;
  };
}

interface EaApiEnrollmentAccountRow {
  id?: string;
  name?: string;
  properties?: {
    displayName?: string;
    principalName?: string;
    costCenter?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
  };
}

interface EaApiAlias {
  id?: string;
  name?: string;
  type?: string;
  properties?: {
    subscriptionId?: string;
    provisioningState?: string;
    displayName?: string;
    billingScope?: string;
    workload?: string;
  };
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
export async function listAllBillingAccountsAnyAgreementType(
  token: string,
): Promise<EaBillingAccount[]> {
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts` +
    `?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<EaApiBillingAccountRow>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id ?? "",
      name: r.name ?? "",
      displayName: r.properties?.displayName ?? r.name ?? "",
      agreementType: r.properties?.agreementType ?? "",
      accountStatus: r.properties?.accountStatus ?? "",
      accountType: r.properties?.accountType ?? "",
    }));
}

export async function listEaBillingAccounts(
  token: string,
): Promise<EaBillingAccount[]> {
  const baseUrl =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts` +
    `?api-version=${ARM_BILLING_API}`;
  const filteredUrl =
    `${baseUrl}` +
    `&$filter=${encodeURIComponent("agreementType eq 'EnterpriseAgreement'")}`;

  let rows: EaApiBillingAccountRow[];
  try {
    rows = await fetchAllPages<EaApiBillingAccountRow>(filteredUrl, token);
  } catch (err: unknown) {
    // Some tenants reject $filter on this resource provider. Retry
    // without the filter and apply the agreementType check client-side.
    const status = err instanceof AzureRequestError ? err.status : undefined;
    if (status === 400) {
      rows = await fetchAllPages<EaApiBillingAccountRow>(baseUrl, token);
    } else {
      throw err;
    }
  }

  return rows
    .filter((r) => r.id && r.name)
    .filter(
      (r) =>
        // Client-side guard for the fallback path.
        (r.properties?.agreementType ?? "EnterpriseAgreement") ===
        "EnterpriseAgreement",
    )
    .map((r) => ({
      id: r.id ?? "",
      name: r.name ?? "",
      displayName: r.properties?.displayName ?? r.name ?? "",
      agreementType: r.properties?.agreementType ?? "EnterpriseAgreement",
      accountStatus: r.properties?.accountStatus ?? "",
      accountType: r.properties?.accountType ?? "",
    }));
}

/**
 * List billing profiles for a specific EA billing account.
 */
export async function listBillingProfiles(
  billingAccountName: string,
  token: string,
): Promise<EaBillingProfile[]> {
  validateBillingAccountName(billingAccountName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingProfiles?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<EaApiBillingProfileRow>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id ?? "",
      name: r.name ?? "",
      displayName: r.properties?.displayName ?? r.name ?? "",
      status: r.properties?.status ?? "",
    }));
}

/**
 * List invoice sections for an EA billing profile.
 */
export async function listInvoiceSections(
  billingAccountName: string,
  billingProfileName: string,
  token: string,
): Promise<EaInvoiceSection[]> {
  validateBillingAccountName(billingAccountName);
  validateBillingAccountName(billingProfileName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
    `/invoiceSections?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<EaApiInvoiceSectionRow>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id ?? "",
      name: r.name ?? "",
      displayName: r.properties?.displayName ?? r.name ?? "",
      state: r.properties?.state ?? "",
    }));
}

/**
 * List enrollment accounts for a legacy EA (Enterprise Agreement)
 * billing account. EA enrollment accounts are the equivalent of
 * MCA invoice sections — they are the leaf scope a new subscription
 * gets created against. Microsoft Customer Agreement accounts use
 * billingProfiles + invoiceSections instead and will reject this
 * endpoint.
 */
export async function listEnrollmentAccounts(
  billingAccountName: string,
  token: string,
): Promise<EaEnrollmentAccount[]> {
  validateBillingAccountName(billingAccountName);
  // NOTE: enrollmentAccounts is not on the 2020-05-01 namespace.
  // We use 2024-04-01 (latest stable) which supports both EA enrollment
  // and MCA endpoints uniformly.
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/enrollmentAccounts?api-version=${ARM_BILLING_ENROLLMENT_API}`;
  const rows = await fetchAllPages<EaApiEnrollmentAccountRow>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id ?? "",
      name: r.name ?? "",
      displayName:
        r.properties?.displayName ??
        r.properties?.principalName ??
        r.name ??
        "",
      status: r.properties?.status ?? "",
      accountOwner: r.properties?.principalName,
      costCenter: r.properties?.costCenter,
      startDate: r.properties?.startDate,
      endDate: r.properties?.endDate,
    }));
}

// ---------------------------------------------------------------------------
// EA Billing Manager — extended billing-account operations
// ---------------------------------------------------------------------------
//
// All endpoints below live under
//   /providers/Microsoft.Billing/billingAccounts/{ba}/...
// with api-version 2024-04-01 (the latest GA at the time of writing —
// supports EA + MCA + MPA uniformly). Source:
//   https://learn.microsoft.com/rest/api/billing/

/** EA-billing-account-scope agreement (legal terms / amendments). */
export interface EaAgreement {
  id: string;
  name: string;
  agreementType: string;
  category: string;
  acceptanceMode?: string;
  effectiveDate?: string;
  expirationDate?: string;
  status?: string;
}

interface ArmAgreement {
  id?: string;
  name?: string;
  properties?: {
    agreementLink?: string;
    category?: string;
    acceptanceMode?: string;
    effectiveDate?: string;
    expirationDate?: string;
    leadBillingAccountName?: string;
    status?: string;
    agreementType?: string;
  };
}

/** List EA / MCA agreements attached to a billing account. */
export async function listEaAgreements(
  billingAccountName: string,
  token: string,
): Promise<EaAgreement[]> {
  validateBillingAccountName(billingAccountName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/agreements?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<ArmAgreement>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      agreementType: r.properties?.agreementType ?? "",
      category: r.properties?.category ?? "",
      acceptanceMode: r.properties?.acceptanceMode,
      effectiveDate: r.properties?.effectiveDate,
      expirationDate: r.properties?.expirationDate,
      status: r.properties?.status,
    }));
}

/** Per-action billing permission the caller holds at a billing scope. */
export interface EaBillingPermission {
  actions: string[];
  notActions: string[];
}

/**
 * List the data-action permissions the caller has at a billing-account
 * scope. Useful to short-circuit UI affordances (e.g. hide "create
 * department" when the caller can't write).
 */
export async function listEaBillingPermissions(
  billingAccountName: string,
  token: string,
): Promise<EaBillingPermission[]> {
  validateBillingAccountName(billingAccountName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingPermissions?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<{
    properties?: { actions?: string[]; notActions?: string[] };
  }>(url, token);
  return rows.map((r) => ({
    actions: r.properties?.actions ?? [],
    notActions: r.properties?.notActions ?? [],
  }));
}

/** Department under an EA enrollment. */
export interface EaDepartment {
  id: string;
  name: string;
  departmentName: string;
  costCenter?: string;
  status?: string;
  enrollmentAccounts?: number;
}

interface ArmDepartment {
  id?: string;
  name?: string;
  properties?: {
    departmentName?: string;
    costCenter?: string;
    status?: string;
    enrollmentAccounts?: Array<unknown>;
  };
}

/** List departments under an EA billing account. */
export async function listEaDepartments(
  billingAccountName: string,
  token: string,
): Promise<EaDepartment[]> {
  validateBillingAccountName(billingAccountName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/departments?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<ArmDepartment>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      departmentName: r.properties?.departmentName ?? r.name!,
      costCenter: r.properties?.costCenter,
      status: r.properties?.status,
      enrollmentAccounts: r.properties?.enrollmentAccounts?.length,
    }));
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
export async function listDepartmentBillingSubscriptions(
  billingAccountName: string,
  departmentName: string,
  token: string,
): Promise<EaBillingSubscription[]> {
  validateBillingAccountName(billingAccountName);
  if (!departmentName) {
    throw new Error("departmentName is required.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/departments/${encodeURIComponent(departmentName)}` +
    `/billingSubscriptions?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<ArmBillingSubscription>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      displayName: r.properties?.displayName ?? r.name!,
      subscriptionId: r.properties?.subscriptionId,
      status: r.properties?.subscriptionBillingStatus,
      billingProfileDisplayName: r.properties?.billingProfileDisplayName,
      invoiceSectionDisplayName: r.properties?.invoiceSectionDisplayName,
      costCenter: r.properties?.costCenter,
      skuId: r.properties?.skuId,
    }));
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
export async function listEnrollmentAccountBillingSubscriptions(
  billingAccountName: string,
  enrollmentAccountName: string,
  token: string,
): Promise<EaBillingSubscription[]> {
  validateBillingAccountName(billingAccountName);
  if (!enrollmentAccountName) {
    throw new Error("enrollmentAccountName is required.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/enrollmentAccounts/${encodeURIComponent(enrollmentAccountName)}` +
    `/billingSubscriptions?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<ArmBillingSubscription>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      displayName: r.properties?.displayName ?? r.name!,
      subscriptionId: r.properties?.subscriptionId,
      status: r.properties?.subscriptionBillingStatus,
      billingProfileDisplayName: r.properties?.billingProfileDisplayName,
      invoiceSectionDisplayName: r.properties?.invoiceSectionDisplayName,
      costCenter: r.properties?.costCenter,
      skuId: r.properties?.skuId,
    }));
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
export async function listDepartmentEnrollmentAccounts(
  billingAccountName: string,
  departmentName: string,
  token: string,
): Promise<EaEnrollmentAccount[]> {
  validateBillingAccountName(billingAccountName);
  if (!departmentName) {
    throw new Error("departmentName is required.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/departments/${encodeURIComponent(departmentName)}` +
    `/enrollmentAccounts?api-version=${ARM_BILLING_ENROLLMENT_API}`;
  const rows = await fetchAllPages<EaApiEnrollmentAccountRow>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id ?? "",
      name: r.name ?? "",
      displayName:
        r.properties?.displayName ??
        r.properties?.principalName ??
        r.name ??
        "",
      status: r.properties?.status ?? "",
      accountOwner: r.properties?.principalName,
      costCenter: r.properties?.costCenter,
      startDate: r.properties?.startDate,
      endDate: r.properties?.endDate,
    }));
}

/**
 * Create or update an EA department under a billing account.
 * `name` is the URL-segment identifier (Azure-defined alphanumeric +
 * dashes). Returns the resulting department row.
 */
export async function createEaDepartment(
  billingAccountName: string,
  departmentName: string,
  body: { departmentName?: string; costCenter?: string },
  token: string,
): Promise<EaDepartment> {
  validateBillingAccountName(billingAccountName);
  if (!departmentName) {
    throw new Error("departmentName (URL segment) is required.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/departments/${encodeURIComponent(departmentName)}?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "PUT",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ properties: body }),
  });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as ArmDepartment;
  return {
    id: data.id ?? "",
    name: data.name ?? departmentName,
    departmentName: data.properties?.departmentName ?? body.departmentName ?? departmentName,
    costCenter: data.properties?.costCenter ?? body.costCenter,
    status: data.properties?.status,
    enrollmentAccounts: data.properties?.enrollmentAccounts?.length,
  };
}

/** Patch an existing EA department (e.g. rename, change cost center). */
export async function updateEaDepartment(
  billingAccountName: string,
  departmentName: string,
  body: { departmentName?: string; costCenter?: string },
  token: string,
): Promise<EaDepartment> {
  validateBillingAccountName(billingAccountName);
  if (!departmentName) {
    throw new Error("departmentName is required.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/departments/${encodeURIComponent(departmentName)}?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "PATCH",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ properties: body }),
  });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as ArmDepartment;
  return {
    id: data.id ?? "",
    name: data.name ?? departmentName,
    departmentName: data.properties?.departmentName ?? departmentName,
    costCenter: data.properties?.costCenter,
    status: data.properties?.status,
    enrollmentAccounts: data.properties?.enrollmentAccounts?.length,
  };
}

/** Delete an EA department. */
export async function deleteEaDepartment(
  billingAccountName: string,
  departmentName: string,
  token: string,
): Promise<void> {
  validateBillingAccountName(billingAccountName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/departments/${encodeURIComponent(departmentName)}?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "DELETE",
    headers: armHeaders(token),
  });
  if (response.ok || response.status === 204 || response.status === 404) return;
  throw await toAzureError(response);
}

/** Well-known billing-role-template GUID for "EA Subscription Creator". */
export const ROLE_EA_SUBSCRIPTION_CREATOR =
  "a0bcee42-bf30-4d1b-926a-48d21664ef71";

/**
 * Well-known built-in "Owner" role definition GUID (classic Azure RBAC).
 * At enrollment-account scope this confers EA Subscription Creator
 * capability — see Microsoft's "grant access to create EA subscription"
 * doc, which prescribes exactly this role at exactly this scope:
 *   https://learn.microsoft.com/azure/cost-management-billing/manage/grant-access-to-create-subscription
 */
const RBAC_OWNER_ROLE_DEFINITION_GUID =
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";

/** API version for the classic RBAC roleAssignments fallback path. */
const ARM_AUTHORIZATION_ROLEASSIGNMENT_API = "2022-04-01";

export interface CreateEnrollmentAccountRoleAssignmentOptions {
  /**
   * Optional email of the user receiving the role. EA backends often
   * require this when the modern Microsoft.Billing role-assignment
   * endpoint is invoked against an EA-agreement billing account —
   * omitting it can manifest as an opaque 500 from the API.
   */
  userEmailAddress?: string;
  /**
   * Auth type of the principal. "Organization" for tenant users
   * (including B2B guests), "MSA" for personal Microsoft accounts.
   * Defaults to "Organization" when omitted.
   */
  userAuthenticationType?: "Organization" | "MSA";
  /**
   * On a 500 from the modern Microsoft.Billing/billingRoleAssignments
   * endpoint, automatically retry via the classic
   * Microsoft.Authorization/roleAssignments endpoint at the legacy
   * enrollment-account scope (`/providers/Microsoft.Billing/
   * enrollmentAccounts/{id}` — no billingAccounts/ prefix). This is
   * Microsoft's documented stable path for granting EA Subscription
   * Creator and works on hybrid EAs where the modern endpoint is not
   * fully migrated. Defaults to `true`. Set `false` to surface the
   * raw 500 instead.
   */
  fallbackToClassicRbac?: boolean;
}

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
export async function createEnrollmentAccountRoleAssignment(
  billingAccountName: string,
  enrollmentAccountName: string,
  principalId: string,
  principalTenantId: string,
  roleDefinitionGuid: string,
  token: string,
  opts: CreateEnrollmentAccountRoleAssignmentOptions = {},
): Promise<BillingRoleAssignmentSummary> {
  validateBillingAccountName(billingAccountName);
  validateBillingAccountName(enrollmentAccountName);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      principalId,
    )
  ) {
    throw new Error("Invalid principalId: must be a UUID.");
  }
  if (!UUID_REGEX.test(principalTenantId)) {
    throw new Error("Invalid principalTenantId: must be a UUID.");
  }
  const assignmentName = crypto.randomUUID();
  const enrollmentScope =
    `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}` +
    `/enrollmentAccounts/${enrollmentAccountName}`;
  // EA enrollment-account billing roles live under the BILLING ACCOUNT's
  // role definitions, not the enrollment account itself.
  const roleDefinitionId =
    `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}` +
    `/billingRoleDefinitions/${roleDefinitionGuid}`;
  const url =
    `${ARM_BASE}${enrollmentScope}/billingRoleAssignments/${assignmentName}` +
    `?api-version=${ARM_BILLING_API}`;
  // Build a body that satisfies BOTH the 2019-10-01-preview and the
  // 2024-04-01 schemas — `scope` was added in 2024-04-01 and is harmless
  // (ignored) on older versions. `userAuthenticationType` /
  // `userEmailAddress` are EA-only hints that some tenants treat as
  // required despite the OpenAPI schema marking them optional.
  const body: Record<string, unknown> = {
    properties: {
      principalId,
      principalTenantId,
      roleDefinitionId,
      scope: enrollmentScope,
      userAuthenticationType: opts.userAuthenticationType ?? "Organization",
      ...(opts.userEmailAddress
        ? { userEmailAddress: opts.userEmailAddress }
        : {}),
    },
  };
  const response = await armFetch(url, {
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
      errBody = (await response.text()).slice(0, 500);
    } catch {
      /* body may already be consumed in some runtimes — ignore */
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[arm-service] Modern EA billingRoleAssignment PUT returned 500 — ` +
        `falling back to classic RBAC at legacy enrollment-account scope. ` +
        `Body excerpt: ${errBody}`,
    );
    return createEnrollmentAccountRoleAssignmentClassic(
      enrollmentAccountName,
      principalId,
      principalTenantId,
      token,
    );
  }
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as {
    id?: string;
    name?: string;
    properties?: Record<string, unknown>;
  };
  return {
    id: data.id ?? "",
    roleDefinitionId: roleDefinitionGuid,
    roleDefinitionName:
      EA_BILLING_ROLE_NAMES[roleDefinitionGuid.toLowerCase()] ??
      roleDefinitionGuid,
    principalId,
    principalTenantId,
    scope: enrollmentScope,
  };
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
async function createEnrollmentAccountRoleAssignmentClassic(
  enrollmentAccountName: string,
  principalId: string,
  principalTenantId: string,
  token: string,
): Promise<BillingRoleAssignmentSummary> {
  const assignmentName = crypto.randomUUID();
  const legacyScope =
    `/providers/Microsoft.Billing/enrollmentAccounts/${enrollmentAccountName}`;
  const roleDefinitionId =
    `/providers/Microsoft.Authorization/roleDefinitions/` +
    RBAC_OWNER_ROLE_DEFINITION_GUID;
  const url =
    `${ARM_BASE}${legacyScope}/providers/Microsoft.Authorization` +
    `/roleAssignments/${assignmentName}` +
    `?api-version=${ARM_AUTHORIZATION_ROLEASSIGNMENT_API}`;
  const response = await armFetch(url, {
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
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as {
    id?: string;
    properties?: Record<string, unknown>;
  };
  return {
    id: data.id ?? "",
    // Surface BOTH the conceptual EA role (so UI display matches the
    // operator's intent) AND the actual RBAC role id assigned, so
    // callers diffing the result against expectations don't get
    // confused. Default to the EA constant — callers comparing role
    // ids in the response loop already key off `ROLE_EA_SUBSCRIPTION_CREATOR`.
    roleDefinitionId: ROLE_EA_SUBSCRIPTION_CREATOR,
    roleDefinitionName:
      "Owner (classic RBAC; equivalent to EA Subscription Creator)",
    principalId,
    principalTenantId,
    scope: legacyScope,
  };
}

/** EA billing-subscription summary. */
export interface EaBillingSubscription {
  id: string;
  name: string;
  displayName: string;
  subscriptionId?: string;
  status?: string;
  billingProfileDisplayName?: string;
  invoiceSectionDisplayName?: string;
  costCenter?: string;
  skuId?: string;
}

interface ArmBillingSubscription {
  id?: string;
  name?: string;
  properties?: {
    displayName?: string;
    subscriptionId?: string;
    subscriptionBillingStatus?: string;
    billingProfileDisplayName?: string;
    invoiceSectionDisplayName?: string;
    costCenter?: string;
    skuId?: string;
  };
}

/** List every subscription billed under the EA billing account. */
export async function listEaBillingSubscriptions(
  billingAccountName: string,
  token: string,
): Promise<EaBillingSubscription[]> {
  validateBillingAccountName(billingAccountName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingSubscriptions?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<ArmBillingSubscription>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      displayName: r.properties?.displayName ?? r.name!,
      subscriptionId: r.properties?.subscriptionId,
      status: r.properties?.subscriptionBillingStatus,
      billingProfileDisplayName: r.properties?.billingProfileDisplayName,
      invoiceSectionDisplayName: r.properties?.invoiceSectionDisplayName,
      costCenter: r.properties?.costCenter,
      skuId: r.properties?.skuId,
    }));
}

/** EA invoice row. */
export interface EaInvoice {
  id: string;
  name: string;
  invoiceDate?: string;
  dueDate?: string;
  status?: string;
  amountDue?: { value: number; currency: string };
  totalAmount?: { value: number; currency: string };
  invoicePeriodStartDate?: string;
  invoicePeriodEndDate?: string;
  documentUrls?: Array<{ kind: string; url: string }>;
}

interface ArmInvoice {
  id?: string;
  name?: string;
  properties?: {
    invoiceDate?: string;
    dueDate?: string;
    status?: string;
    amountDue?: { value?: number; currency?: string };
    totalAmount?: { value?: number; currency?: string };
    invoicePeriodStartDate?: string;
    invoicePeriodEndDate?: string;
    documents?: Array<{ kind?: string; url?: string }>;
  };
}

/**
 * List invoices on an EA billing account. The Billing API requires a
 * `periodStartDate` / `periodEndDate` range — we default to the last
 * 12 months, which is the usual "show my recent invoices" surface.
 */
export async function listEaInvoices(
  billingAccountName: string,
  token: string,
  opts?: { periodStartDate?: string; periodEndDate?: string },
): Promise<EaInvoice[]> {
  validateBillingAccountName(billingAccountName);
  const now = new Date();
  const end = opts?.periodEndDate ?? now.toISOString().slice(0, 10);
  const startDefault = new Date(now);
  startDefault.setMonth(startDefault.getMonth() - 12);
  const start = opts?.periodStartDate ?? startDefault.toISOString().slice(0, 10);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/invoices?api-version=${ARM_BILLING_API}` +
    `&periodStartDate=${encodeURIComponent(start)}` +
    `&periodEndDate=${encodeURIComponent(end)}`;
  const rows = await fetchAllPages<ArmInvoice>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      invoiceDate: r.properties?.invoiceDate,
      dueDate: r.properties?.dueDate,
      status: r.properties?.status,
      amountDue:
        r.properties?.amountDue?.value !== undefined
          ? {
              value: r.properties.amountDue.value!,
              currency: r.properties.amountDue.currency ?? "",
            }
          : undefined,
      totalAmount:
        r.properties?.totalAmount?.value !== undefined
          ? {
              value: r.properties.totalAmount.value!,
              currency: r.properties.totalAmount.currency ?? "",
            }
          : undefined,
      invoicePeriodStartDate: r.properties?.invoicePeriodStartDate,
      invoicePeriodEndDate: r.properties?.invoicePeriodEndDate,
      documentUrls: r.properties?.documents
        ?.filter((d) => d.url)
        .map((d) => ({ kind: d.kind ?? "Invoice", url: d.url! })),
    }));
}

/** Reservation order summary. Surfaces both reservations and their parent order. */
export interface ReservationOrder {
  id: string;
  name: string;
  displayName?: string;
  term?: string;
  billingPlan?: string;
  enrollmentId?: string;
  customerId?: string;
  provisioningState?: string;
  requestDateTime?: string;
  createdDateTime?: string;
  expiryDate?: string;
  benefitStartTime?: string;
  reservations?: number;
}

interface ArmReservationOrder {
  id?: string;
  name?: string;
  properties?: {
    displayName?: string;
    term?: string;
    billingPlan?: string;
    enrollmentId?: string;
    customerId?: string;
    provisioningState?: string;
    requestDateTime?: string;
    createdDateTime?: string;
    expiryDate?: string;
    benefitStartTime?: string;
    reservations?: unknown[];
  };
}

/** List Reservation orders visible to the caller (tenant-wide). */
export async function listReservationOrders(
  token: string,
): Promise<ReservationOrder[]> {
  const url =
    `${ARM_BASE}/providers/Microsoft.Capacity/reservationOrders` +
    `?api-version=2022-11-01`;
  const rows = await fetchAllPages<ArmReservationOrder>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      displayName: r.properties?.displayName,
      term: r.properties?.term,
      billingPlan: r.properties?.billingPlan,
      enrollmentId: r.properties?.enrollmentId,
      customerId: r.properties?.customerId,
      provisioningState: r.properties?.provisioningState,
      requestDateTime: r.properties?.requestDateTime,
      createdDateTime: r.properties?.createdDateTime,
      expiryDate: r.properties?.expiryDate,
      benefitStartTime: r.properties?.benefitStartTime,
      reservations: r.properties?.reservations?.length,
    }));
}

/** EA billing-policy snapshot. */
export interface EaBillingPolicy {
  id: string;
  marketplacePurchases?: string;
  reservationPurchases?: string;
  savingsPlanPurchases?: string;
  enterpriseAgreementDevTestEnabled?: boolean;
}

interface ArmBillingPolicy {
  id?: string;
  properties?: {
    marketplacePurchases?: string;
    reservationPurchases?: string;
    savingsPlanPurchases?: string;
    enterpriseAgreementDevTestEnabled?: boolean;
  };
}

/** Read the billing policies that govern purchase / dev-test eligibility. */
export async function getEaBillingPolicy(
  billingAccountName: string,
  token: string,
): Promise<EaBillingPolicy> {
  validateBillingAccountName(billingAccountName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingPolicies/default?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, { headers: armHeaders(token) });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as ArmBillingPolicy;
  return {
    id: data.id ?? "",
    marketplacePurchases: data.properties?.marketplacePurchases,
    reservationPurchases: data.properties?.reservationPurchases,
    savingsPlanPurchases: data.properties?.savingsPlanPurchases,
    enterpriseAgreementDevTestEnabled:
      data.properties?.enterpriseAgreementDevTestEnabled,
  };
}

/** Update billing policy flags. Empty object = no-op. */
export async function updateEaBillingPolicy(
  billingAccountName: string,
  body: Partial<{
    marketplacePurchases: string;
    reservationPurchases: string;
    savingsPlanPurchases: string;
    enterpriseAgreementDevTestEnabled: boolean;
  }>,
  token: string,
): Promise<EaBillingPolicy> {
  validateBillingAccountName(billingAccountName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingPolicies/default?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "PUT",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ properties: body }),
  });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as ArmBillingPolicy;
  return {
    id: data.id ?? "",
    marketplacePurchases: data.properties?.marketplacePurchases,
    reservationPurchases: data.properties?.reservationPurchases,
    savingsPlanPurchases: data.properties?.savingsPlanPurchases,
    enterpriseAgreementDevTestEnabled:
      data.properties?.enterpriseAgreementDevTestEnabled,
  };
}

/** Billing-role definition (catalog row). */
export interface BillingRoleDefinition {
  id: string;
  name: string;
  roleName: string;
  description?: string;
  permissions?: Array<{ actions: string[]; notActions: string[] }>;
}

/** List role definitions available at a billing-account scope. */
export async function listBillingRoleDefinitions(
  billingAccountName: string,
  token: string,
): Promise<BillingRoleDefinition[]> {
  validateBillingAccountName(billingAccountName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingRoleDefinitions?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<{
    id?: string;
    name?: string;
    properties?: {
      roleName?: string;
      description?: string;
      permissions?: Array<{ actions?: string[]; notActions?: string[] }>;
    };
  }>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      roleName: r.properties?.roleName ?? r.name!,
      description: r.properties?.description,
      permissions: r.properties?.permissions?.map((p) => ({
        actions: p.actions ?? [],
        notActions: p.notActions ?? [],
      })),
    }));
}

/**
 * Create a billing-role assignment at the billing-account scope.
 * `principalId` must be the AAD object id; `principalTenantId` is the
 * tenant the principal lives in (required for cross-tenant grants).
 * `roleDefinitionId` is just the GUID — we expand to the full ARM path.
 */
export async function createBillingRoleAssignment(
  billingAccountName: string,
  principalId: string,
  principalTenantId: string,
  roleDefinitionGuid: string,
  token: string,
): Promise<BillingRoleAssignmentSummary> {
  validateBillingAccountName(billingAccountName);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      principalId,
    )
  ) {
    throw new Error("Invalid principalId: must be a UUID.");
  }
  const assignmentName = crypto.randomUUID();
  const roleDefinitionId =
    `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}` +
    `/billingRoleDefinitions/${roleDefinitionGuid}`;
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingRoleAssignments/${assignmentName}?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
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
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as {
    id?: string;
    name?: string;
    properties?: Record<string, unknown>;
  };
  return {
    id: data.id ?? "",
    roleDefinitionId: roleDefinitionGuid,
    roleDefinitionName:
      EA_BILLING_ROLE_NAMES[roleDefinitionGuid.toLowerCase()] ?? roleDefinitionGuid,
    principalId,
    principalTenantId,
    scope: `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}`,
  };
}

/** Delete a billing-role assignment by its full ARM resource id. */
export async function deleteBillingRoleAssignment(
  roleAssignmentArmId: string,
  token: string,
): Promise<void> {
  if (
    !roleAssignmentArmId.startsWith("/") ||
    !roleAssignmentArmId.includes("/billingRoleAssignments/")
  ) {
    throw new Error("Invalid roleAssignmentArmId: must be a billing-role ARM path.");
  }
  const url =
    `${ARM_BASE}${roleAssignmentArmId}?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "DELETE",
    headers: armHeaders(token),
  });
  if (response.ok || response.status === 204 || response.status === 404) return;
  throw await toAzureError(response);
}

/** Billing-property snapshot — the caller's tenant-wide billing identity. */
export interface BillingProperty {
  billingTenantId?: string;
  billingAccountId?: string;
  billingAccountDisplayName?: string;
  accountAdminNotificationEmailAddress?: string;
  costCenter?: string;
  isAdmin?: boolean;
  billingProfileId?: string;
  billingProfileDisplayName?: string;
  invoiceSectionId?: string;
  invoiceSectionDisplayName?: string;
  enrollmentAccountId?: string;
  enrollmentAccountDisplayName?: string;
}

/**
 * Read the caller's billing-property metadata. Cheap one-shot endpoint
 * that surfaces "which billing account, billing profile, enrollment
 * account am I currently associated with" — useful for the Overview tab.
 */
export async function getBillingProperty(
  token: string,
): Promise<BillingProperty> {
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingProperty/default` +
    `?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, { headers: armHeaders(token) });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as {
    properties?: Record<string, unknown>;
  };
  const p = (data.properties ?? {}) as Record<string, unknown>;
  return {
    billingTenantId: p.billingTenantId as string | undefined,
    billingAccountId: p.billingAccountId as string | undefined,
    billingAccountDisplayName: p.billingAccountDisplayName as string | undefined,
    accountAdminNotificationEmailAddress:
      p.accountAdminNotificationEmailAddress as string | undefined,
    costCenter: p.costCenter as string | undefined,
    isAdmin: p.isAdmin as boolean | undefined,
    billingProfileId: p.billingProfileId as string | undefined,
    billingProfileDisplayName: p.billingProfileDisplayName as string | undefined,
    invoiceSectionId: p.invoiceSectionId as string | undefined,
    invoiceSectionDisplayName: p.invoiceSectionDisplayName as string | undefined,
    enrollmentAccountId: p.enrollmentAccountId as string | undefined,
    enrollmentAccountDisplayName:
      p.enrollmentAccountDisplayName as string | undefined,
  };
}

// ===========================================================================
// EA Billing Manager — round-2: the 9 endpoints listed as "available via
// REST but not yet wired" in the page footer.
// ===========================================================================

/* ---------- 1. Transactions --------------------------------------- */

/** Transaction (charge / refund / purchase) row. */
export interface EaTransaction {
  id: string;
  name: string;
  kind?: string;
  transactionDate?: string;
  invoice?: string;
  invoiceId?: string;
  orderId?: string;
  orderName?: string;
  productDescription?: string;
  transactionType?: string;
  transactionAmount?: { value: number; currency: string };
  quantity?: number;
  billingProfileDisplayName?: string;
  invoiceSectionDisplayName?: string;
  customerDisplayName?: string;
  subscriptionId?: string;
  subscriptionName?: string;
}

interface ArmTransaction {
  id?: string;
  name?: string;
  kind?: string;
  properties?: {
    transactionDate?: string;
    invoice?: string;
    invoiceId?: string;
    orderId?: string;
    orderName?: string;
    productDescription?: string;
    transactionType?: string;
    transactionAmount?: { value?: number; currency?: string };
    quantity?: number;
    billingProfileDisplayName?: string;
    invoiceSectionDisplayName?: string;
    customerDisplayName?: string;
    subscriptionId?: string;
    subscriptionName?: string;
  };
}

/**
 * List transactions on a billing account. The API requires either a
 * `periodStartDate`/`periodEndDate` pair or a specific `invoiceId`
 * filter — we default to the last 60 days when no range is provided.
 */
export async function listEaTransactions(
  billingAccountName: string,
  token: string,
  opts?: { periodStartDate?: string; periodEndDate?: string },
): Promise<EaTransaction[]> {
  validateBillingAccountName(billingAccountName);
  const now = new Date();
  const end = opts?.periodEndDate ?? now.toISOString().slice(0, 10);
  const startDefault = new Date(now);
  startDefault.setDate(startDefault.getDate() - 60);
  const start = opts?.periodStartDate ?? startDefault.toISOString().slice(0, 10);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/transactions?api-version=${ARM_BILLING_API}` +
    `&periodStartDate=${encodeURIComponent(start)}` +
    `&periodEndDate=${encodeURIComponent(end)}`;
  const rows = await fetchAllPages<ArmTransaction>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      kind: r.kind,
      transactionDate: r.properties?.transactionDate,
      invoice: r.properties?.invoice,
      invoiceId: r.properties?.invoiceId,
      orderId: r.properties?.orderId,
      orderName: r.properties?.orderName,
      productDescription: r.properties?.productDescription,
      transactionType: r.properties?.transactionType,
      transactionAmount:
        r.properties?.transactionAmount?.value !== undefined
          ? {
              value: r.properties.transactionAmount.value!,
              currency: r.properties.transactionAmount.currency ?? "",
            }
          : undefined,
      quantity: r.properties?.quantity,
      billingProfileDisplayName: r.properties?.billingProfileDisplayName,
      invoiceSectionDisplayName: r.properties?.invoiceSectionDisplayName,
      customerDisplayName: r.properties?.customerDisplayName,
      subscriptionId: r.properties?.subscriptionId,
      subscriptionName: r.properties?.subscriptionName,
    }));
}

/* ---------- 2. Outbound transfers --------------------------------- */

/** Outbound billing-subscription / product transfer initiated from this scope. */
export interface OutboundTransfer {
  id: string;
  name: string;
  recipientEmailId?: string;
  transferStatus?: string;
  initiatorEmailId?: string;
  expirationTime?: string;
  resellerId?: string;
  resellerName?: string;
}

interface ArmTransfer {
  id?: string;
  name?: string;
  properties?: {
    recipientEmailId?: string;
    transferStatus?: string;
    initiatorEmailId?: string;
    expirationTime?: string;
    resellerId?: string;
    resellerName?: string;
  };
}

/**
 * List outbound transfers initiated from a billing-profile +
 * invoice-section scope. Both segments are required by the API.
 */
export async function listOutboundTransfers(
  billingAccountName: string,
  billingProfileName: string,
  invoiceSectionName: string,
  token: string,
): Promise<OutboundTransfer[]> {
  validateBillingAccountName(billingAccountName);
  validateBillingAccountName(billingProfileName);
  validateBillingAccountName(invoiceSectionName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
    `/invoiceSections/${encodeURIComponent(invoiceSectionName)}` +
    `/transfers?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<ArmTransfer>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      recipientEmailId: r.properties?.recipientEmailId,
      transferStatus: r.properties?.transferStatus,
      initiatorEmailId: r.properties?.initiatorEmailId,
      expirationTime: r.properties?.expirationTime,
      resellerId: r.properties?.resellerId,
      resellerName: r.properties?.resellerName,
    }));
}

/**
 * Initiate a billing-subscription transfer to a recipient email. The
 * recipient must accept via the inbound recipientTransfers endpoint
 * within the expiration window (typically 7 days).
 */
export async function createOutboundTransfer(
  billingAccountName: string,
  billingProfileName: string,
  invoiceSectionName: string,
  recipientEmail: string,
  resellerId: string | undefined,
  token: string,
): Promise<OutboundTransfer> {
  validateBillingAccountName(billingAccountName);
  validateBillingAccountName(billingProfileName);
  validateBillingAccountName(invoiceSectionName);
  const transferName = crypto.randomUUID();
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
    `/invoiceSections/${encodeURIComponent(invoiceSectionName)}` +
    `/transfers/${transferName}?api-version=${ARM_BILLING_API}`;
  const body: Record<string, unknown> = {
    properties: { recipientEmailId: recipientEmail },
  };
  if (resellerId) (body.properties as Record<string, unknown>).resellerId = resellerId;
  const response = await armFetch(url, {
    method: "PUT",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as ArmTransfer;
  return {
    id: data.id ?? "",
    name: data.name ?? transferName,
    recipientEmailId: data.properties?.recipientEmailId,
    transferStatus: data.properties?.transferStatus,
    initiatorEmailId: data.properties?.initiatorEmailId,
    expirationTime: data.properties?.expirationTime,
    resellerId: data.properties?.resellerId,
    resellerName: data.properties?.resellerName,
  };
}

/* ---------- 3. Inbound (recipient) transfers ---------------------- */

/** Inbound transfer pending the caller's acceptance / rejection. */
export interface InboundTransfer {
  id: string;
  name: string;
  transferStatus?: string;
  initiatorEmailId?: string;
  recipientEmailId?: string;
  expirationTime?: string;
  allowedProductType?: string[];
}

/** List inbound (recipient) transfers visible to the caller. */
export async function listInboundTransfers(
  token: string,
): Promise<InboundTransfer[]> {
  // The recipientTransfers list endpoint isn't billing-account-scoped;
  // it's tenant-wide for the caller.
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/transfers` +
    `?api-version=${ARM_BILLING_API}`;
  const rows = await fetchAllPages<ArmTransfer & {
    properties?: { allowedProductType?: Array<{ productType?: string }> };
  }>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      transferStatus: r.properties?.transferStatus,
      initiatorEmailId: r.properties?.initiatorEmailId,
      recipientEmailId: r.properties?.recipientEmailId,
      expirationTime: r.properties?.expirationTime,
      allowedProductType: r.properties?.allowedProductType
        ?.map((p) => p.productType ?? "")
        .filter(Boolean),
    }));
}

/** Accept an inbound transfer by ARM id. */
export async function acceptInboundTransfer(
  transferArmId: string,
  token: string,
): Promise<void> {
  if (!transferArmId.startsWith("/")) {
    throw new Error("Invalid transferArmId: must be a full ARM path.");
  }
  const url =
    `${ARM_BASE}${transferArmId}/accept?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ properties: {} }),
  });
  if (!response.ok && response.status !== 204) throw await toAzureError(response);
}

/** Reject (decline) an inbound transfer by ARM id. */
export async function declineInboundTransfer(
  transferArmId: string,
  token: string,
): Promise<void> {
  if (!transferArmId.startsWith("/")) {
    throw new Error("Invalid transferArmId: must be a full ARM path.");
  }
  const url =
    `${ARM_BASE}${transferArmId}/decline?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token),
  });
  if (!response.ok && response.status !== 204) throw await toAzureError(response);
}

/* ---------- 4. Billing profile PATCH ------------------------------ */

/** Patch metadata on a billing profile (display name, PO number, etc). */
export async function patchBillingProfile(
  billingAccountName: string,
  billingProfileName: string,
  body: Partial<{
    displayName: string;
    poNumber: string;
    invoiceEmailOptIn: boolean;
    /** Billing address — schema follows ARM AddressDetails type. */
    billTo: Record<string, unknown>;
  }>,
  token: string,
): Promise<EaBillingProfile> {
  validateBillingAccountName(billingAccountName);
  validateBillingAccountName(billingProfileName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
    `?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "PATCH",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ properties: body }),
  });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as EaApiBillingProfileRow;
  return {
    id: data.id ?? "",
    name: data.name ?? billingProfileName,
    displayName: data.properties?.displayName ?? data.name ?? "",
    status: data.properties?.status ?? "",
  };
}

/* ---------- 5. Invoice section CREATE ----------------------------- */

/** Create (or PUT-update) an invoice section under a billing profile. */
export async function createInvoiceSection(
  billingAccountName: string,
  billingProfileName: string,
  invoiceSectionName: string,
  body: { displayName: string; labels?: Record<string, string> },
  token: string,
): Promise<EaInvoiceSection> {
  validateBillingAccountName(billingAccountName);
  validateBillingAccountName(billingProfileName);
  validateBillingAccountName(invoiceSectionName);
  if (!body.displayName?.trim()) {
    throw new Error("displayName is required.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingProfiles/${encodeURIComponent(billingProfileName)}` +
    `/invoiceSections/${encodeURIComponent(invoiceSectionName)}` +
    `?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "PUT",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ properties: body }),
  });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as EaApiInvoiceSectionRow;
  return {
    id: data.id ?? "",
    name: data.name ?? invoiceSectionName,
    displayName: data.properties?.displayName ?? data.name ?? "",
    state: data.properties?.state ?? "",
  };
}

/* ---------- 6. Custom billing role definitions -------------------- */

/** Body for creating a custom billing role. */
export interface CustomBillingRoleBody {
  roleName: string;
  description?: string;
  permissions: Array<{ actions: string[]; notActions?: string[] }>;
}

/** Create (PUT) a custom billing-role definition under a billing account. */
export async function createCustomBillingRoleDefinition(
  billingAccountName: string,
  roleDefinitionGuid: string,
  body: CustomBillingRoleBody,
  token: string,
): Promise<BillingRoleDefinition> {
  validateBillingAccountName(billingAccountName);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      roleDefinitionGuid,
    )
  ) {
    throw new Error("roleDefinitionGuid must be a UUID.");
  }
  if (!body.roleName?.trim()) {
    throw new Error("roleName is required.");
  }
  if (!Array.isArray(body.permissions) || body.permissions.length === 0) {
    throw new Error("At least one permissions block is required.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingRoleDefinitions/${roleDefinitionGuid}?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "PUT",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ properties: body }),
  });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as {
    id?: string;
    name?: string;
    properties?: {
      roleName?: string;
      description?: string;
      permissions?: Array<{ actions?: string[]; notActions?: string[] }>;
    };
  };
  return {
    id: data.id ?? "",
    name: data.name ?? roleDefinitionGuid,
    roleName: data.properties?.roleName ?? body.roleName,
    description: data.properties?.description,
    permissions: data.properties?.permissions?.map((p) => ({
      actions: p.actions ?? [],
      notActions: p.notActions ?? [],
    })),
  };
}

/* ---------- 7. Subscription move / cancel ------------------------- */

/**
 * Move a billing subscription to a different invoice section. Both
 * `destinationInvoiceSectionId` and `destinationBillingProfileId` are
 * full ARM ids; the API rejects bare GUIDs.
 */
export async function moveBillingSubscription(
  billingAccountName: string,
  billingSubscriptionName: string,
  destination: {
    destinationInvoiceSectionId: string;
    destinationBillingProfileId?: string;
  },
  token: string,
): Promise<{ status: number; location?: string }> {
  validateBillingAccountName(billingAccountName);
  validateBillingAccountName(billingSubscriptionName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingSubscriptions/${encodeURIComponent(billingSubscriptionName)}` +
    `/move?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify(destination),
  });
  if (!response.ok && response.status !== 202) throw await toAzureError(response);
  return {
    status: response.status,
    location: response.headers.get("Location") ?? undefined,
  };
}

/** Cancel a billing subscription. Returns 202 + Location for async tracking. */
export async function cancelBillingSubscription(
  billingAccountName: string,
  billingSubscriptionName: string,
  reason: string,
  token: string,
): Promise<{ status: number; location?: string }> {
  validateBillingAccountName(billingAccountName);
  validateBillingAccountName(billingSubscriptionName);
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountName)}` +
    `/billingSubscriptions/${encodeURIComponent(billingSubscriptionName)}` +
    `/cancel?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ cancellationReason: reason }),
  });
  if (!response.ok && response.status !== 202) throw await toAzureError(response);
  return {
    status: response.status,
    location: response.headers.get("Location") ?? undefined,
  };
}

/* ---------- 8. Validate address ----------------------------------- */

/** Input for address validation. Schema mirrors ARM's AddressDetails. */
export interface BillingAddress {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  addressLine1: string;
  addressLine2?: string;
  addressLine3?: string;
  city?: string;
  district?: string;
  region?: string;
  country: string;
  postalCode?: string;
  email?: string;
  phoneNumber?: string;
}

export interface AddressValidationResult {
  status: "Valid" | "Invalid" | "Other";
  suggestedAddresses?: BillingAddress[];
  validationMessage?: string;
}

/** Validate a billing address before using it on a billing-profile PATCH. */
export async function validateBillingAddress(
  address: BillingAddress,
  token: string,
): Promise<AddressValidationResult> {
  if (!address.addressLine1) {
    throw new Error("addressLine1 is required.");
  }
  if (!address.country) {
    throw new Error("country is required.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/validateAddress` +
    `?api-version=${ARM_BILLING_API}`;
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify(address),
  });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as {
    status?: string;
    suggestedAddresses?: BillingAddress[];
    validationMessage?: string;
  };
  const status =
    data.status === "Valid"
      ? "Valid"
      : data.status === "Invalid"
        ? "Invalid"
        : "Other";
  return {
    status,
    suggestedAddresses: data.suggestedAddresses,
    validationMessage: data.validationMessage,
  };
}

/* ---------- 9. Cost Management query ------------------------------ */

/** Body for a CostManagement query. Subset of the full schema. */
export interface CostQueryBody {
  type?: "Usage" | "ActualCost" | "AmortizedCost";
  timeframe?:
    | "MonthToDate"
    | "BillingMonthToDate"
    | "TheLastMonth"
    | "TheLastBillingMonth"
    | "WeekToDate"
    | "Custom";
  timePeriod?: { from: string; to: string };
  dataset?: {
    granularity?: "None" | "Daily" | "Monthly";
    aggregation?: Record<string, { name: string; function: "Sum" }>;
    grouping?: Array<{ type: "Dimension" | "Tag"; name: string }>;
    filter?: Record<string, unknown>;
  };
}

/** Tabular result of a CostManagement query. */
export interface CostQueryResult {
  columns: Array<{ name: string; type: string }>;
  rows: Array<Array<string | number>>;
  /** Convenience: numeric column indexes (Currency / amount columns). */
  numericColumnIndexes: number[];
  nextLink?: string;
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
export async function queryCostManagement(
  scope: string,
  body: CostQueryBody,
  token: string,
): Promise<CostQueryResult> {
  if (!scope.startsWith("/")) {
    throw new Error("Scope must start with /, e.g. /subscriptions/...");
  }
  const cleanScope = scope.replace(/^\/+/, "/").replace(/\/+$/, "");
  const url =
    `${ARM_BASE}${cleanScope}/providers/Microsoft.CostManagement/query` +
    `?api-version=2023-11-01`;
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toAzureError(response);
  const data = (await response.json()) as {
    properties?: {
      columns?: Array<{ name?: string; type?: string }>;
      rows?: Array<Array<string | number>>;
      nextLink?: string;
    };
  };
  const columns = (data.properties?.columns ?? []).map((c) => ({
    name: c.name ?? "",
    type: c.type ?? "",
  }));
  const numericColumnIndexes = columns
    .map((c, i) => ({ i, t: c.type.toLowerCase() }))
    .filter(({ t }) => t === "number" || t === "currency")
    .map(({ i }) => i);
  return {
    columns,
    rows: data.properties?.rows ?? [],
    numericColumnIndexes,
    nextLink: data.properties?.nextLink,
  };
}

/**
 * Probe an account for EA billing-account access.
 *
 * Silently downgrades to `{ hasEa: false, billingAccountCount: 0 }` on any
 * error — the caller treats this as "not capable" rather than surfacing
 * permission failures (callers expect a soft probe).
 */
export async function probeEaCapability(token: string): Promise<EaCapability> {
  try {
    const accounts = await listEaBillingAccounts(token);
    return {
      hasEa: accounts.length > 0,
      billingAccountCount: accounts.length,
      primaryBillingAccountName:
        accounts.length > 0 ? accounts[0]!.name : undefined,
    };
  } catch {
    return { hasEa: false, billingAccountCount: 0 };
  }
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
export const EA_BILLING_ROLE_NAMES: Record<string, string> = {
  "9f1983cb-2574-400c-87e9-34cf8e2280db": "Enterprise Administrator",
  "0b5ed2f2-bb18-4c38-b0c4-dd75e9bd4de2":
    "Enterprise Administrator (read only)",
  "c15c22c0-9faf-424c-9b7e-bd91c06a240b": "EA Account Owner",
  "a0bcee42-bf30-4d1b-926a-48d21664ef71": "EA Subscription Creator",
  "db609904-a47f-4794-9be8-9bd86fbffd8a": "Department Administrator",
  "4e3a1b3b-a2df-44b5-bdfa-9d1d4e4a3cba":
    "Department Administrator (read only)",
};

export interface BillingRoleAssignmentSummary {
  /** Full ARM resource id of the role assignment. */
  id: string;
  /** GUID portion of the role definition (the dictionary key for EA roles). */
  roleDefinitionId: string;
  /** Friendly name resolved via EA_BILLING_ROLE_NAMES (or the GUID if unknown). */
  roleDefinitionName: string;
  /** Principal the assignment is for. */
  principalId: string;
  /** Tenant the principal lives in. May differ from the caller's home tenant. */
  principalTenantId?: string;
  /** Scope the assignment was granted at. */
  scope?: string;
  /** ISO timestamp the assignment was created (when surfaced by the API). */
  createdOn?: string;
}

interface BillingRoleAssignmentApiItem {
  id: string;
  name: string;
  type: string;
  properties?: {
    principalId?: string;
    principalTenantId?: string;
    roleDefinitionId?: string;
    scope?: string;
    createdOn?: string;
  };
}

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
export async function listBillingRoleAssignments(
  scope: string,
  token: string,
  principalId?: string,
): Promise<BillingRoleAssignmentSummary[]> {
  // Strip leading slash so we can re-build the URL without doubling it.
  const cleanScope = scope.startsWith("/") ? scope.slice(1) : scope;
  // Bumped 2019-10-01-preview → 2024-04-01 (current stable per Microsoft
  // Learn API change log). Older preview versions risk silent retirement;
  // 2024-04-01 adds `systemData` and `tags` fields and is supported across
  // all four scope variants (billingAccounts, enrollmentAccounts,
  // billingProfiles, billingProfiles/invoiceSections).
  const url =
    `${ARM_BASE}/${cleanScope}/billingRoleAssignments` +
    `?api-version=2024-04-01`;
  const response = await armFetch(url, {
    method: "GET",
    headers: armHeaders(token),
  });
  if (response.status === 403 || response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw await toAzureError(response);
  }
  const body = (await response.json()) as {
    value?: BillingRoleAssignmentApiItem[];
  };
  const items = body.value ?? [];
  const lowerPrincipal = principalId?.toLowerCase();
  const filtered = lowerPrincipal
    ? items.filter(
        (i) =>
          (i.properties?.principalId ?? "").toLowerCase() === lowerPrincipal,
      )
    : items;
  return filtered.map((i) => {
    const fullRoleDefId = i.properties?.roleDefinitionId ?? "";
    const guid = fullRoleDefId.split("/").pop() ?? "";
    return {
      id: i.id,
      roleDefinitionId: guid,
      roleDefinitionName: EA_BILLING_ROLE_NAMES[guid] ?? guid,
      principalId: i.properties?.principalId ?? "",
      principalTenantId: i.properties?.principalTenantId,
      scope: i.properties?.scope,
      createdOn: i.properties?.createdOn,
    };
  });
}

/**
 * Convenience wrapper: returns a self-diagnostic for a billing scope —
 * what role-assignment(s) the *caller* has at that scope, plus a flag
 * indicating whether any of them are sufficient to create subscriptions
 * (EA Subscription Creator or higher).
 */
export interface CallerBillingRoleDiagnostic {
  scope: string;
  /** True if a Subscription Creator (or strict superset) role is present. */
  canCreateSubscriptions: boolean;
  /** All matched role assignments for the principal at the scope. */
  assignments: BillingRoleAssignmentSummary[];
  /** Role names matched on this principal at this scope. */
  roleNames: string[];
}

export async function diagnoseCallerBillingRole(
  scope: string,
  principalId: string,
  token: string,
): Promise<CallerBillingRoleDiagnostic> {
  const assignments = await listBillingRoleAssignments(
    scope,
    token,
    principalId,
  );
  const subscriptionCreator = "a0bcee42-bf30-4d1b-926a-48d21664ef71";
  const enterpriseAdmin = "9f1983cb-2574-400c-87e9-34cf8e2280db";
  const accountOwner = "c15c22c0-9faf-424c-9b7e-bd91c06a240b";
  const sufficient = new Set([
    subscriptionCreator,
    enterpriseAdmin,
    accountOwner,
  ]);
  const canCreateSubscriptions = assignments.some((a) =>
    sufficient.has(a.roleDefinitionId.toLowerCase()),
  );
  return {
    scope,
    canCreateSubscriptions,
    assignments,
    roleNames: assignments.map((a) => a.roleDefinitionName),
  };
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

/** Row returned by the legacy enrollmentAccounts list endpoint. */
export interface LegacyEnrollmentAccount {
  /** Full ARM id, e.g. `/providers/Microsoft.Billing/enrollmentAccounts/{guid}`. */
  id: string;
  /** Enrollment-account object id (GUID) — passed to createSubscription. */
  name: string;
  /** UPN of the Account Owner per AAD. */
  principalName?: string;
}

interface ArmLegacyEnrollmentAccount {
  id?: string;
  name?: string;
  properties?: { principalName?: string };
}

/**
 * `GET /providers/Microsoft.Billing/enrollmentAccounts?api-version=2018-03-01-preview`
 *
 * Different shape AND scope than the modern listEnrollmentAccounts —
 * lists every enrollment account the caller is an Owner on, regardless
 * of which EA billing-account it belongs to. This is the LEGACY entry
 * point referenced in the docs at
 *   https://learn.microsoft.com/azure/cost-management-billing/manage/programmatically-create-subscription
 */
export async function listLegacyEnrollmentAccounts(
  token: string,
): Promise<LegacyEnrollmentAccount[]> {
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/enrollmentAccounts` +
    `?api-version=${ARM_LEGACY_EA_API}`;
  const rows = await fetchAllPages<ArmLegacyEnrollmentAccount>(url, token);
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      principalName: r.properties?.principalName,
    }));
}

/** Body shape for the legacy createSubscription POST. */
export interface LegacyEaSubscriptionRequest {
  /** Optional — defaults to the offer name when omitted (Microsoft Azure Enterprise). */
  displayName?: string;
  /** Required. MS-AZR-0017P = production, MS-AZR-0148P = dev/test. */
  offerType: "MS-AZR-0017P" | "MS-AZR-0148P";
  /** AAD object ids of users / SPNs to grant Owner on the new sub. */
  owners?: string[];
}

/** Final result returned by the legacy createSubscription helper. */
export interface LegacyEaSubscriptionResult {
  /**
   * Subscription ID (GUID) when ARM's Location-polling responded with
   * a subscriptionLink. Undefined if AAD returned the link as a path
   * (the helper still finishes, the UI just shows the raw link).
   */
  subscriptionId?: string;
  /** Raw `subscriptionLink` value from the final poll response. */
  subscriptionLink?: string;
  /** Final HTTP status code on the polled operation. */
  status: number;
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
export async function createLegacyEaSubscription(
  enrollmentAccountObjectId: string,
  req: LegacyEaSubscriptionRequest,
  token: string,
): Promise<LegacyEaSubscriptionResult> {
  if (!UUID_REGEX.test(enrollmentAccountObjectId)) {
    throw new Error("enrollmentAccountObjectId must be a UUID.");
  }
  if (!req.offerType) {
    throw new Error("offerType is required (MS-AZR-0017P or MS-AZR-0148P).");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Billing/enrollmentAccounts/${encodeURIComponent(enrollmentAccountObjectId)}` +
    `/providers/Microsoft.Subscription/createSubscription` +
    `?api-version=${ARM_LEGACY_EA_API}`;
  const body: Record<string, unknown> = {
    offerType: req.offerType,
  };
  if (req.displayName?.trim()) body.displayName = req.displayName.trim();
  if (req.owners && req.owners.length > 0) {
    body.owners = req.owners
      .filter((o) => UUID_REGEX.test(o))
      .map((o) => ({ objectId: o }));
  }
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status !== 202) {
    throw await toAzureError(response);
  }
  // Async path — poll the Location URL until ARM returns a final
  // 200/204 with a subscriptionLink.
  const pollUrl =
    response.headers.get("Location") ??
    response.headers.get("Azure-AsyncOperation");
  if (!pollUrl) {
    // Synchronous success — unwrap the body.
    const data = (await response.json().catch(() => ({}))) as {
      subscriptionLink?: string;
    };
    return {
      subscriptionId: extractSubIdFromLink(data.subscriptionLink),
      subscriptionLink: data.subscriptionLink,
      status: response.status,
    };
  }
  const poll = await pollAsyncOperation(pollUrl, token);
  const data = (poll.body as { subscriptionLink?: string }) ?? {};
  return {
    subscriptionId: extractSubIdFromLink(data.subscriptionLink),
    subscriptionLink: data.subscriptionLink,
    status: poll.status,
  };
}

/** "/subscriptions/{guid}" → "{guid}", anything else → undefined. */
function extractSubIdFromLink(link?: string): string | undefined {
  if (!link) return undefined;
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
export async function createEaSubscription(
  req: CreateSubscriptionRequest,
  token: string,
): Promise<{
  aliasName: string;
  subscriptionId?: string;
  provisioningState: string;
  displayName: string;
}> {
  validateAliasName(req.aliasName);
  validateBillingScope(req.billingScope);
  const trimmedDisplay = (req.displayName ?? "").trim();
  if (trimmedDisplay.length < 3 || trimmedDisplay.length > 64) {
    throw new Error("Invalid displayName: must be 3-64 characters.");
  }
  const workload = req.workload ?? "Production";

  // Cross-tenant assignment requires both subscriptionTenantId AND
  // subscriptionOwnerId per the alias API contract — Azure rejects
  // the call if only one is set.
  const cross = !!req.subscriptionTenantId;
  if (cross && !req.subscriptionOwnerId) {
    throw new Error(
      "subscriptionOwnerId (AAD object ID) is required when subscriptionTenantId is set.",
    );
  }
  if (req.subscriptionTenantId && !UUID_REGEX.test(req.subscriptionTenantId)) {
    throw new Error(
      "Invalid subscriptionTenantId: must be a tenant GUID (UUID).",
    );
  }
  if (req.subscriptionOwnerId && !UUID_REGEX.test(req.subscriptionOwnerId)) {
    throw new Error(
      "Invalid subscriptionOwnerId: must be the Azure AD object ID GUID of the user or service principal.",
    );
  }

  const aliasUrl =
    `${ARM_BASE}/providers/Microsoft.Subscription/aliases/${encodeURIComponent(req.aliasName)}` +
    `?api-version=${ARM_SUBSCRIPTION_ALIAS_API}`;

  const additionalProperties: Record<string, unknown> = {};
  if (req.subscriptionTenantId)
    additionalProperties.subscriptionTenantId = req.subscriptionTenantId;
  if (req.subscriptionOwnerId)
    additionalProperties.subscriptionOwnerId = req.subscriptionOwnerId;
  if (req.managementGroupId)
    additionalProperties.managementGroupId = req.managementGroupId;
  if (req.tags && Object.keys(req.tags).length > 0)
    additionalProperties.tags = req.tags;

  const body: Record<string, unknown> = {
    properties: {
      displayName: trimmedDisplay,
      billingScope: req.billingScope,
      workload,
      ...(Object.keys(additionalProperties).length > 0
        ? { additionalProperties }
        : {}),
    },
  };

  const response = await armFetch(aliasUrl, {
    method: "PUT",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify(body),
  });

  if (response.status === 202) {
    const pollUrl =
      response.headers.get("Location") ??
      response.headers.get("Azure-AsyncOperation") ??
      aliasUrl;
    await pollAsyncOperation(pollUrl, token);
    const finalResp = await armFetch(aliasUrl, {
      headers: armHeaders(token),
    });
    if (!finalResp.ok) {
      throw await toAzureError(finalResp);
    }
    const alias = (await finalResp.json()) as EaApiAlias;
    return {
      aliasName: alias.name ?? req.aliasName,
      subscriptionId: alias.properties?.subscriptionId,
      provisioningState: alias.properties?.provisioningState ?? "Succeeded",
      displayName: alias.properties?.displayName ?? trimmedDisplay,
    };
  }

  if (!response.ok) {
    throw await toAzureError(response);
  }

  const alias = (await response.json()) as EaApiAlias;
  const provState = alias.properties?.provisioningState ?? "";
  const lower = provState.toLowerCase();
  if (lower && lower !== "succeeded" && lower !== "completed") {
    const pollResult = await pollAsyncOperation(aliasUrl, token);
    const polled = pollResult.body as EaApiAlias;
    return {
      aliasName: polled.name ?? req.aliasName,
      subscriptionId: polled.properties?.subscriptionId,
      provisioningState: polled.properties?.provisioningState ?? "Succeeded",
      displayName: polled.properties?.displayName ?? trimmedDisplay,
    };
  }
  return {
    aliasName: alias.name ?? req.aliasName,
    subscriptionId: alias.properties?.subscriptionId,
    provisioningState: provState || "Succeeded",
    displayName: alias.properties?.displayName ?? trimmedDisplay,
  };
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

export type AcceptOwnershipState =
  | "Pending"
  | "Completed"
  | "Expired"
  | string;

export interface AcceptOwnershipStatus {
  subscriptionId: string;
  acceptOwnershipState: AcceptOwnershipState;
  /** UPN / email of the billing-side owner (sender of the invitation). */
  billingOwner?: string;
  /** Tenant the subscription will live in once accepted. */
  subscriptionTenantId?: string;
  displayName?: string;
  provisioningState?: string;
}

export async function getAcceptOwnershipStatus(
  subscriptionId: string,
  token: string,
): Promise<AcceptOwnershipStatus> {
  if (!UUID_REGEX.test(subscriptionId)) {
    throw new Error("Invalid subscriptionId: must be a UUID.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Subscription/subscriptions/` +
    `${encodeURIComponent(subscriptionId)}/acceptOwnershipStatus` +
    `?api-version=${ARM_SUBSCRIPTION_ACCEPT_API}`;
  const response = await armFetch(url, { headers: armHeaders(token) });
  if (!response.ok) {
    throw await toAzureError(response);
  }
  const body = (await response.json()) as {
    properties?: {
      acceptOwnershipState?: string;
      billingOwner?: string;
      subscriptionTenantId?: string;
      displayName?: string;
      provisioningState?: string;
    };
    acceptOwnershipState?: string;
    billingOwner?: string;
    subscriptionTenantId?: string;
    displayName?: string;
    provisioningState?: string;
  };
  // Some api-versions wrap fields under `properties`, others put them at the
  // top level. Read both.
  const props = body.properties ?? {};
  return {
    subscriptionId,
    acceptOwnershipState:
      (props.acceptOwnershipState ?? body.acceptOwnershipState ?? "Unknown") as
        AcceptOwnershipState,
    billingOwner: props.billingOwner ?? body.billingOwner,
    subscriptionTenantId:
      props.subscriptionTenantId ?? body.subscriptionTenantId,
    displayName: props.displayName ?? body.displayName,
    provisioningState: props.provisioningState ?? body.provisioningState,
  };
}

export interface AcceptOwnershipRequestBody {
  /** Optional rename. Defaults to the alias-time displayName. */
  displayName?: string;
  /** Optional management-group placement. */
  managementGroupId?: string;
  /** Optional tags applied at acceptance. */
  tags?: Record<string, string>;
}

/**
 * Accept the pending subscription ownership transfer. The token MUST be
 * obtained from the destination tenant (the tenant where `subscriptionTenantId`
 * pointed during creation). Returns once the API has accepted the request and
 * the lifecycle has settled (202 → poll Location to terminal).
 */
export async function acceptSubscriptionOwnership(
  subscriptionId: string,
  req: AcceptOwnershipRequestBody,
  token: string,
): Promise<{
  subscriptionId: string;
  acceptOwnershipState: AcceptOwnershipState;
}> {
  if (!UUID_REGEX.test(subscriptionId)) {
    throw new Error("Invalid subscriptionId: must be a UUID.");
  }
  const url =
    `${ARM_BASE}/providers/Microsoft.Subscription/subscriptions/` +
    `${encodeURIComponent(subscriptionId)}/acceptOwnership` +
    `?api-version=${ARM_SUBSCRIPTION_ACCEPT_API}`;
  const properties: Record<string, unknown> = {};
  if (req.displayName && req.displayName.trim().length > 0) {
    properties.displayName = req.displayName.trim();
  }
  if (req.managementGroupId) {
    properties.managementGroupId = req.managementGroupId;
  }
  if (req.tags && Object.keys(req.tags).length > 0) {
    properties.tags = req.tags;
  }
  const response = await armFetch(url, {
    method: "POST",
    headers: armHeaders(token, "application/json"),
    body: JSON.stringify({ properties }),
  });
  if (response.status === 202) {
    const pollUrl =
      response.headers.get("Location") ??
      response.headers.get("Azure-AsyncOperation");
    // No async-operation header — poll the resource URL itself rather
    // than blindly returning "Completed" mid-flight. ARM spec allows
    // 202 without Location on idempotent POSTs, and historically we
    // had a false-success bug here.
    const fallbackPollUrl = pollUrl ?? url;
    try {
      await pollAsyncOperation(fallbackPollUrl, token);
    } catch (e) {
      // Even if the poll throws (e.g. transient 5xx), let the caller
      // verify with getAcceptOwnershipStatus rather than swallowing.
      throw e;
    }
    return { subscriptionId, acceptOwnershipState: "Completed" };
  }
  if (!response.ok) {
    throw await toAzureError(response);
  }
  return { subscriptionId, acceptOwnershipState: "Completed" };
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
export function buildAcceptOwnershipPortalUrl(
  destinationTenantId: string,
  subscriptionId?: string,
): string {
  const tenantSegment = destinationTenantId
    ? `#@${encodeURIComponent(destinationTenantId)}`
    : "#";
  const blade = "/blade/Microsoft_Azure_Billing/SubscriptionsBlade";
  const hint = subscriptionId
    ? `?invitedSubscriptionId=${encodeURIComponent(subscriptionId)}`
    : "";
  return `https://portal.azure.com/${tenantSegment}${blade}${hint}`;
}
