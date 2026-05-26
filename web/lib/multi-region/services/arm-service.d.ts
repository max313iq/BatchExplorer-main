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
import { ArmSubscription, ArmBatchAccount, ArmResourceGroup, EaBillingAccount, EaBillingProfile, EaInvoiceSection, EaEnrollmentAccount, EaCapability, CreateSubscriptionRequest } from "./types";
export interface ProviderRegistration {
    namespace: string;
    registrationState: string;
}
/**
 * Get the registration state of a single resource provider on a subscription.
 */
export declare function getProviderRegistration(subscriptionId: string, namespace: string, token: string): Promise<ProviderRegistration>;
/**
 * Trigger registration of a resource provider on a subscription.
 * Idempotent — registering an already-registered provider is a no-op
 * server-side.
 */
export declare function registerProvider(subscriptionId: string, namespace: string, token: string): Promise<void>;
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
export declare function ensureProvidersRegistered(subscriptionId: string, namespaces: string[], token: string, opts?: {
    timeoutMs?: number;
    intervalMs?: number;
}): Promise<{
    alreadyRegistered: string[];
    newlyRegistered: string[];
}>;
/**
 * Test-only: clear the in-memory provider-registration cache.
 */
export declare function _resetProviderRegistrationCacheForTest(): void;
/**
 * List all Azure subscriptions accessible with the provided token.
 *
 * **Security**: The token is sent as a Bearer header only to the hardcoded
 * ARM endpoint. No user input is interpolated into the URL.
 *
 * @param token - Bearer token with `https://management.azure.com/.default` scope.
 * @returns Array of subscriptions with id, displayName, state, and tenantId.
 */
export declare function listSubscriptions(token: string, opts?: {
    signal?: AbortSignal;
}): Promise<ArmSubscription[]>;
/** List resource groups in a subscription (used as move destinations). */
export declare function listResourceGroups(subscriptionId: string, token: string): Promise<ArmResourceGroup[]>;
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
/**
 * Pre-flight move validation — same body as moveResources but the ARM
 * endpoint only runs the dependency/lock checks. Surfaces granular
 * per-resource errors so the UI can show what would fail before the
 * operator commits to the actual move.
 */
export declare function validateMoveResources(sourceSubscriptionId: string, sourceResourceGroupName: string, resourceIds: string[], targetResourceGroupArmId: string, token: string): Promise<ResourceMoveOutcome>;
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
export declare function moveResources(sourceSubscriptionId: string, sourceResourceGroupName: string, resourceIds: string[], targetResourceGroupArmId: string, token: string): Promise<ResourceMoveOutcome>;
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
export declare function changeSubscriptionTenant(subscriptionId: string, destinationTenantId: string, token: string): Promise<{
    status: number;
    location?: string;
}>;
/**
 * Move an EA billing subscription to a different enrollment account
 * inside the same billing account. The destination ARM id is the full
 * `/providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea}`
 * path. Returns 202 + Location; the operation is async (1–5 min).
 */
export declare function moveBillingSubscriptionToEnrollmentAccount(billingAccountName: string, billingSubscriptionName: string, destinationEnrollmentAccountArmId: string, token: string): Promise<{
    status: number;
    location?: string;
}>;
/**
 * Well-known Azure RBAC role definition GUID for "Owner" — full
 * resource-management privilege at the assigned scope plus the right to
 * delegate access to others.
 *
 * Source: https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
 */
export declare const AZURE_ROLE_OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
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
export declare function assignSubscriptionRole(subscriptionId: string, principalObjectId: string, roleDefinitionGuid: string, token: string, opts?: {
    principalType?: "User" | "ServicePrincipal" | "Group";
}): Promise<{
    roleAssignmentId: string;
    alreadyExisted: boolean;
}>;
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
/**
 * List every role assignment visible at a subscription's scope, including
 * those inherited from management group / tenant scopes. The `atScope`
 * field on each row tells the UI whether deletion at the sub scope is
 * meaningful (deleting an inherited assignment at sub scope is a no-op /
 * 404 — Azure only allows deleting at the scope the assignment was
 * created at).
 */
export declare function listSubscriptionRoleAssignments(subscriptionId: string, token: string): Promise<RoleAssignmentRow[]>;
/**
 * Delete a role assignment by its full ARM resource id. The ARM API
 * returns 204 No Content on success and 204 / 404 on "already gone" —
 * both are treated as success here so a retry after a partial failure
 * is safe.
 */
export declare function deleteRoleAssignment(roleAssignmentArmId: string, token: string): Promise<void>;
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
/**
 * List role definitions visible at a subscription scope. Includes both
 * built-in roles (Owner, Contributor, Reader, …) and any custom roles
 * defined at or above the subscription.
 */
export declare function listSubscriptionRoleDefinitions(subscriptionId: string, token: string): Promise<RoleDefinitionRow[]>;
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
export declare function listBatchAccounts(subscriptionId: string, token: string, opts?: {
    signal?: AbortSignal;
}): Promise<ArmBatchAccount[]>;
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
export declare function getBatchAccount(subscriptionId: string, resourceGroup: string, accountName: string, token: string): Promise<ArmBatchAccount>;
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
export declare function createResourceGroup(subscriptionId: string, rgName: string, location: string, token: string): Promise<ArmResourceGroup>;
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
export declare function createBatchAccount(subscriptionId: string, resourceGroup: string, accountName: string, location: string, token: string, opts?: {
    signal?: AbortSignal;
}): Promise<ArmBatchAccount>;
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
export declare function listAllBillingAccountsAnyAgreementType(token: string): Promise<EaBillingAccount[]>;
export declare function listEaBillingAccounts(token: string): Promise<EaBillingAccount[]>;
/**
 * List billing profiles for a specific EA billing account.
 */
export declare function listBillingProfiles(billingAccountName: string, token: string): Promise<EaBillingProfile[]>;
/**
 * List invoice sections for an EA billing profile.
 */
export declare function listInvoiceSections(billingAccountName: string, billingProfileName: string, token: string): Promise<EaInvoiceSection[]>;
/**
 * List enrollment accounts for a legacy EA (Enterprise Agreement)
 * billing account. EA enrollment accounts are the equivalent of
 * MCA invoice sections — they are the leaf scope a new subscription
 * gets created against. Microsoft Customer Agreement accounts use
 * billingProfiles + invoiceSections instead and will reject this
 * endpoint.
 */
export declare function listEnrollmentAccounts(billingAccountName: string, token: string): Promise<EaEnrollmentAccount[]>;
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
/** List EA / MCA agreements attached to a billing account. */
export declare function listEaAgreements(billingAccountName: string, token: string): Promise<EaAgreement[]>;
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
export declare function listEaBillingPermissions(billingAccountName: string, token: string): Promise<EaBillingPermission[]>;
/** Department under an EA enrollment. */
export interface EaDepartment {
    id: string;
    name: string;
    departmentName: string;
    costCenter?: string;
    status?: string;
    enrollmentAccounts?: number;
}
/** List departments under an EA billing account. */
export declare function listEaDepartments(billingAccountName: string, token: string): Promise<EaDepartment[]>;
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
export declare function listDepartmentBillingSubscriptions(billingAccountName: string, departmentName: string, token: string): Promise<EaBillingSubscription[]>;
/**
 * List billing subscriptions scoped to a single EA enrollment account.
 *
 * `GET /billingAccounts/{ba}/enrollmentAccounts/{ea}/billingSubscriptions`
 *
 * Same authz rationale as {@link listDepartmentBillingSubscriptions}:
 * a per-enrollment-account admin can read here but not at the
 * billing-account root.
 */
export declare function listEnrollmentAccountBillingSubscriptions(billingAccountName: string, enrollmentAccountName: string, token: string): Promise<EaBillingSubscription[]>;
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
export declare function listDepartmentEnrollmentAccounts(billingAccountName: string, departmentName: string, token: string): Promise<EaEnrollmentAccount[]>;
/**
 * Create or update an EA department under a billing account.
 * `name` is the URL-segment identifier (Azure-defined alphanumeric +
 * dashes). Returns the resulting department row.
 */
export declare function createEaDepartment(billingAccountName: string, departmentName: string, body: {
    departmentName?: string;
    costCenter?: string;
}, token: string): Promise<EaDepartment>;
/** Patch an existing EA department (e.g. rename, change cost center). */
export declare function updateEaDepartment(billingAccountName: string, departmentName: string, body: {
    departmentName?: string;
    costCenter?: string;
}, token: string): Promise<EaDepartment>;
/** Delete an EA department. */
export declare function deleteEaDepartment(billingAccountName: string, departmentName: string, token: string): Promise<void>;
/** Well-known billing-role-template GUID for "EA Subscription Creator". */
export declare const ROLE_EA_SUBSCRIPTION_CREATOR = "a0bcee42-bf30-4d1b-926a-48d21664ef71";
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
export declare function createEnrollmentAccountRoleAssignment(billingAccountName: string, enrollmentAccountName: string, principalId: string, principalTenantId: string, roleDefinitionGuid: string, token: string, opts?: CreateEnrollmentAccountRoleAssignmentOptions): Promise<BillingRoleAssignmentSummary>;
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
/** List every subscription billed under the EA billing account. */
export declare function listEaBillingSubscriptions(billingAccountName: string, token: string): Promise<EaBillingSubscription[]>;
/** EA invoice row. */
export interface EaInvoice {
    id: string;
    name: string;
    invoiceDate?: string;
    dueDate?: string;
    status?: string;
    amountDue?: {
        value: number;
        currency: string;
    };
    totalAmount?: {
        value: number;
        currency: string;
    };
    invoicePeriodStartDate?: string;
    invoicePeriodEndDate?: string;
    documentUrls?: Array<{
        kind: string;
        url: string;
    }>;
}
/**
 * List invoices on an EA billing account. The Billing API requires a
 * `periodStartDate` / `periodEndDate` range — we default to the last
 * 12 months, which is the usual "show my recent invoices" surface.
 */
export declare function listEaInvoices(billingAccountName: string, token: string, opts?: {
    periodStartDate?: string;
    periodEndDate?: string;
}): Promise<EaInvoice[]>;
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
/** List Reservation orders visible to the caller (tenant-wide). */
export declare function listReservationOrders(token: string): Promise<ReservationOrder[]>;
/** EA billing-policy snapshot. */
export interface EaBillingPolicy {
    id: string;
    marketplacePurchases?: string;
    reservationPurchases?: string;
    savingsPlanPurchases?: string;
    enterpriseAgreementDevTestEnabled?: boolean;
}
/** Read the billing policies that govern purchase / dev-test eligibility. */
export declare function getEaBillingPolicy(billingAccountName: string, token: string): Promise<EaBillingPolicy>;
/** Update billing policy flags. Empty object = no-op. */
export declare function updateEaBillingPolicy(billingAccountName: string, body: Partial<{
    marketplacePurchases: string;
    reservationPurchases: string;
    savingsPlanPurchases: string;
    enterpriseAgreementDevTestEnabled: boolean;
}>, token: string): Promise<EaBillingPolicy>;
/** Billing-role definition (catalog row). */
export interface BillingRoleDefinition {
    id: string;
    name: string;
    roleName: string;
    description?: string;
    permissions?: Array<{
        actions: string[];
        notActions: string[];
    }>;
}
/** List role definitions available at a billing-account scope. */
export declare function listBillingRoleDefinitions(billingAccountName: string, token: string): Promise<BillingRoleDefinition[]>;
/**
 * Create a billing-role assignment at the billing-account scope.
 * `principalId` must be the AAD object id; `principalTenantId` is the
 * tenant the principal lives in (required for cross-tenant grants).
 * `roleDefinitionId` is just the GUID — we expand to the full ARM path.
 */
export declare function createBillingRoleAssignment(billingAccountName: string, principalId: string, principalTenantId: string, roleDefinitionGuid: string, token: string): Promise<BillingRoleAssignmentSummary>;
/** Delete a billing-role assignment by its full ARM resource id. */
export declare function deleteBillingRoleAssignment(roleAssignmentArmId: string, token: string): Promise<void>;
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
export declare function getBillingProperty(token: string): Promise<BillingProperty>;
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
    transactionAmount?: {
        value: number;
        currency: string;
    };
    quantity?: number;
    billingProfileDisplayName?: string;
    invoiceSectionDisplayName?: string;
    customerDisplayName?: string;
    subscriptionId?: string;
    subscriptionName?: string;
}
/**
 * List transactions on a billing account. The API requires either a
 * `periodStartDate`/`periodEndDate` pair or a specific `invoiceId`
 * filter — we default to the last 60 days when no range is provided.
 */
export declare function listEaTransactions(billingAccountName: string, token: string, opts?: {
    periodStartDate?: string;
    periodEndDate?: string;
}): Promise<EaTransaction[]>;
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
/**
 * List outbound transfers initiated from a billing-profile +
 * invoice-section scope. Both segments are required by the API.
 */
export declare function listOutboundTransfers(billingAccountName: string, billingProfileName: string, invoiceSectionName: string, token: string): Promise<OutboundTransfer[]>;
/**
 * Initiate a billing-subscription transfer to a recipient email. The
 * recipient must accept via the inbound recipientTransfers endpoint
 * within the expiration window (typically 7 days).
 */
export declare function createOutboundTransfer(billingAccountName: string, billingProfileName: string, invoiceSectionName: string, recipientEmail: string, resellerId: string | undefined, token: string): Promise<OutboundTransfer>;
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
export declare function listInboundTransfers(token: string): Promise<InboundTransfer[]>;
/** Accept an inbound transfer by ARM id. */
export declare function acceptInboundTransfer(transferArmId: string, token: string): Promise<void>;
/** Reject (decline) an inbound transfer by ARM id. */
export declare function declineInboundTransfer(transferArmId: string, token: string): Promise<void>;
/** Patch metadata on a billing profile (display name, PO number, etc). */
export declare function patchBillingProfile(billingAccountName: string, billingProfileName: string, body: Partial<{
    displayName: string;
    poNumber: string;
    invoiceEmailOptIn: boolean;
    /** Billing address — schema follows ARM AddressDetails type. */
    billTo: Record<string, unknown>;
}>, token: string): Promise<EaBillingProfile>;
/** Create (or PUT-update) an invoice section under a billing profile. */
export declare function createInvoiceSection(billingAccountName: string, billingProfileName: string, invoiceSectionName: string, body: {
    displayName: string;
    labels?: Record<string, string>;
}, token: string): Promise<EaInvoiceSection>;
/** Body for creating a custom billing role. */
export interface CustomBillingRoleBody {
    roleName: string;
    description?: string;
    permissions: Array<{
        actions: string[];
        notActions?: string[];
    }>;
}
/** Create (PUT) a custom billing-role definition under a billing account. */
export declare function createCustomBillingRoleDefinition(billingAccountName: string, roleDefinitionGuid: string, body: CustomBillingRoleBody, token: string): Promise<BillingRoleDefinition>;
/**
 * Move a billing subscription to a different invoice section. Both
 * `destinationInvoiceSectionId` and `destinationBillingProfileId` are
 * full ARM ids; the API rejects bare GUIDs.
 */
export declare function moveBillingSubscription(billingAccountName: string, billingSubscriptionName: string, destination: {
    destinationInvoiceSectionId: string;
    destinationBillingProfileId?: string;
}, token: string): Promise<{
    status: number;
    location?: string;
}>;
/** Cancel a billing subscription. Returns 202 + Location for async tracking. */
export declare function cancelBillingSubscription(billingAccountName: string, billingSubscriptionName: string, reason: string, token: string): Promise<{
    status: number;
    location?: string;
}>;
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
export declare function validateBillingAddress(address: BillingAddress, token: string): Promise<AddressValidationResult>;
/** Body for a CostManagement query. Subset of the full schema. */
export interface CostQueryBody {
    type?: "Usage" | "ActualCost" | "AmortizedCost";
    timeframe?: "MonthToDate" | "BillingMonthToDate" | "TheLastMonth" | "TheLastBillingMonth" | "WeekToDate" | "Custom";
    timePeriod?: {
        from: string;
        to: string;
    };
    dataset?: {
        granularity?: "None" | "Daily" | "Monthly";
        aggregation?: Record<string, {
            name: string;
            function: "Sum";
        }>;
        grouping?: Array<{
            type: "Dimension" | "Tag";
            name: string;
        }>;
        filter?: Record<string, unknown>;
    };
}
/** Tabular result of a CostManagement query. */
export interface CostQueryResult {
    columns: Array<{
        name: string;
        type: string;
    }>;
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
export declare function queryCostManagement(scope: string, body: CostQueryBody, token: string): Promise<CostQueryResult>;
/**
 * Probe an account for EA billing-account access.
 *
 * Silently downgrades to `{ hasEa: false, billingAccountCount: 0 }` on any
 * error — the caller treats this as "not capable" rather than surfacing
 * permission failures (callers expect a soft probe).
 */
export declare function probeEaCapability(token: string): Promise<EaCapability>;
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
export declare const EA_BILLING_ROLE_NAMES: Record<string, string>;
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
export declare function listBillingRoleAssignments(scope: string, token: string, principalId?: string): Promise<BillingRoleAssignmentSummary[]>;
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
export declare function diagnoseCallerBillingRole(scope: string, principalId: string, token: string): Promise<CallerBillingRoleDiagnostic>;
/** Row returned by the legacy enrollmentAccounts list endpoint. */
export interface LegacyEnrollmentAccount {
    /** Full ARM id, e.g. `/providers/Microsoft.Billing/enrollmentAccounts/{guid}`. */
    id: string;
    /** Enrollment-account object id (GUID) — passed to createSubscription. */
    name: string;
    /** UPN of the Account Owner per AAD. */
    principalName?: string;
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
export declare function listLegacyEnrollmentAccounts(token: string): Promise<LegacyEnrollmentAccount[]>;
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
export declare function createLegacyEaSubscription(enrollmentAccountObjectId: string, req: LegacyEaSubscriptionRequest, token: string): Promise<LegacyEaSubscriptionResult>;
/**
 * Create a new Azure subscription under an EA billing scope via the
 * modern (2021-10-01) subscription-alias API.
 *
 * The alias API returns either 200 (synchronous success) or 202
 * (async). For 202 we poll the alias resource URL until the alias
 * lifecycle reaches a terminal `provisioningState`. Errors during the
 * poll surface as `AzureRequestError` with the alias body.
 */
export declare function createEaSubscription(req: CreateSubscriptionRequest, token: string): Promise<{
    aliasName: string;
    subscriptionId?: string;
    provisioningState: string;
    displayName: string;
}>;
export type AcceptOwnershipState = "Pending" | "Completed" | "Expired" | string;
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
export declare function getAcceptOwnershipStatus(subscriptionId: string, token: string): Promise<AcceptOwnershipStatus>;
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
export declare function acceptSubscriptionOwnership(subscriptionId: string, req: AcceptOwnershipRequestBody, token: string): Promise<{
    subscriptionId: string;
    acceptOwnershipState: AcceptOwnershipState;
}>;
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
export declare function buildAcceptOwnershipPortalUrl(destinationTenantId: string, subscriptionId?: string): string;
//# sourceMappingURL=arm-service.d.ts.map