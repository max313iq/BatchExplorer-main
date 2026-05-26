/**
 * Multi-region SDK service layer.
 *
 * Re-exports all service functions and types so consumers can import from
 * a single entry point:
 *
 *   import { listSubscriptions, listPools, AzureRequestError } from "../services";
 */
export type { AzureError, ArmSubscription, ArmBatchAccount, ArmResourceGroup, VmFamilyCoreQuota, BatchPool, BatchNode, NodeAction, GraphUser, TenantInfo, DirectoryRole, EaBillingAccount, EaBillingProfile, EaInvoiceSection, EaEnrollmentAccount, EaCapability, CreateSubscriptionRequest, } from "./types";
export { AzureRequestError, AuthError, RateLimitError, NotFoundError, TransientError, PermissionError, ValidationError, classifyHttpError, } from "./types";
export { parseCaeChallenge, withCaeRecovery, buildCaeChallengeError, } from "./cae-interceptor";
export type { CaeChallengeError, WithCaeRecoveryOptions, } from "./cae-interceptor";
export { invalidateAllCachesForTenantChange } from "./cache-invalidation";
export { abortError, throwIfAborted, isAbortError } from "./abort-helpers";
export { listSubscriptions, listBatchAccounts, getBatchAccount, createResourceGroup, createBatchAccount, listEaBillingAccounts, listAllBillingAccountsAnyAgreementType, listBillingProfiles, listInvoiceSections, listEnrollmentAccounts, probeEaCapability, createEaSubscription, assignSubscriptionRole, AZURE_ROLE_OWNER, listSubscriptionRoleAssignments, deleteRoleAssignment, listSubscriptionRoleDefinitions, listEaAgreements, listEaBillingPermissions, listEaDepartments, listEaBillingSubscriptions, listEaInvoices, listReservationOrders, getEaBillingPolicy, updateEaBillingPolicy, listBillingRoleDefinitions, listBillingRoleAssignments, createBillingRoleAssignment, deleteBillingRoleAssignment, getBillingProperty, EA_BILLING_ROLE_NAMES, listEaTransactions, listOutboundTransfers, createOutboundTransfer, listInboundTransfers, acceptInboundTransfer, declineInboundTransfer, patchBillingProfile, createInvoiceSection, createCustomBillingRoleDefinition, moveBillingSubscription, cancelBillingSubscription, validateBillingAddress, queryCostManagement, listResourceGroups, validateMoveResources, moveResources, changeSubscriptionTenant, moveBillingSubscriptionToEnrollmentAccount, createEaDepartment, updateEaDepartment, deleteEaDepartment, createEnrollmentAccountRoleAssignment, ROLE_EA_SUBSCRIPTION_CREATOR, listDepartmentEnrollmentAccounts, listDepartmentBillingSubscriptions, listEnrollmentAccountBillingSubscriptions, listLegacyEnrollmentAccounts, createLegacyEaSubscription, } from "./arm-service";
export type { LegacyEnrollmentAccount, LegacyEaSubscriptionRequest, LegacyEaSubscriptionResult, } from "./arm-service";
export type { RoleAssignmentRow, RoleDefinitionRow, EaAgreement, EaBillingPermission, EaDepartment, EaBillingSubscription, EaInvoice, ReservationOrder, EaBillingPolicy, BillingRoleDefinition, BillingRoleAssignmentSummary, BillingProperty, EaTransaction, OutboundTransfer, InboundTransfer, CustomBillingRoleBody, BillingAddress, AddressValidationResult, CostQueryBody, CostQueryResult, ResourceMoveOutcome, } from "./arm-service";
export { listPools, createPool, patchPool, deletePool, listNodes, performNodeAction, removeNodes, getNodeRemoteLoginSettings, createNodeUser, } from "./batch-service";
export type { BatchNodeRemoteLoginSettings, BatchNodeUserCreateOptions, } from "./batch-service";
export { listOrgUsers, getMyDirectoryRoles, getUserDirectoryRoles, getUserDirectoryRolesBatched, resetUserPassword, canResetPasswords, canCreateUsers, createUser, assignDirectoryRole, inviteGuest, getPrincipalsByIds, findUserByUpnOrMail, listVerifiedDomains, listOrgSubscriptions, ROLE_GLOBAL_ADMIN, ROLE_USER_ADMIN, ROLE_HELPDESK_ADMIN, ROLE_AUTHENTICATION_ADMIN, ROLE_PRIVILEGED_AUTH_ADMIN, ROLE_GLOBAL_READER, ROLE_DIRECTORY_READER, } from "./graph-service";
export type { ResolvedPrincipal } from "./graph-service";
export type { ListOrgUsersOptions, CreateUserRequest, CreateUserResult, InviteGuestRequest, InviteGuestResult, VerifiedDomain, } from "./graph-service";
export { probeCspAccess, probeMpnProfile, probeLegalBusinessProfile, getPartnerAdminLink, linkPartnerAdmin, unlinkPartnerAdmin, } from "./partner-center-service";
export type { ProbeOutcome, ProbeResult, CspCustomerSummary, MpnProfileSummary, LegalBusinessProfileSummary, PartnerAdminLinkSummary, } from "./partner-center-service";
//# sourceMappingURL=index.d.ts.map