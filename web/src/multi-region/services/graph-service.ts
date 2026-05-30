/**
 * Microsoft Graph service layer.
 *
 * Pure-fetch wrappers around the Graph v1.0 endpoints used by the
 * multi-region admin features. All wrappers route through the shared
 * RequestGuard via guardedFetch, with `family: "graph"` and the tenantId
 * as the rate-limit key (Graph applies per-tenant limits).
 *
 * The caller is responsible for token acquisition; pass an access token
 * with the Microsoft Graph audience (https://graph.microsoft.com/.default).
 */

import {
  AzureRequestError,
  classifyHttpError,
  DirectoryRole,
  GraphUser,
} from "./types";
import { guardedFetch } from "../scheduling/request-governance";
import { fetchAllPages as sharedFetchAllPages } from "./_shared/paginate";
import { listSubscriptionAccessByPrincipal } from "./arm-service";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const TENANT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_USER_SELECT = [
  "id",
  "displayName",
  "userPrincipalName",
  "mail",
  "accountEnabled",
  "jobTitle",
  "department",
] as const;

// Well-known directory role template IDs that grant the ability to
// reset other users' passwords. Source:
// https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference
export const ROLE_GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
export const ROLE_USER_ADMIN = "fe930be7-5e62-47db-91af-98c3a49a38b1";
export const ROLE_HELPDESK_ADMIN = "729827e3-9c14-49f7-bb1b-9608f156bbb8";
export const ROLE_AUTHENTICATION_ADMIN = "c4e39bd9-1100-46d3-8c65-fb160da0071f";
export const ROLE_PRIVILEGED_AUTH_ADMIN =
  "7be44c8a-adaf-4e2a-84d6-ab2649e08a13";
export const ROLE_GLOBAL_READER = "f2ef992c-3afb-46b9-b7cf-a126ee74c451";
export const ROLE_DIRECTORY_READER = "88d8e3e3-8f55-4a1e-953a-9b9898b8876b";
/**
 * Privileged Role Administrator — together with Global Administrator, the
 * only built-in roles that can *grant other directory roles* (i.e. add a
 * principal to a `/directoryRoles/{id}/members`). A User Administrator can
 * create users but CANNOT elevate them, so role-grant pre-flight gating
 * keys off this + Global Admin.
 */
export const ROLE_PRIVILEGED_ROLE_ADMIN =
  "e8611ab8-c189-46e8-94e1-60213ab1f814";

const PASSWORD_RESET_ROLE_TEMPLATES = new Set<string>([
  ROLE_GLOBAL_ADMIN,
  ROLE_USER_ADMIN,
  ROLE_HELPDESK_ADMIN,
  ROLE_AUTHENTICATION_ADMIN,
  ROLE_PRIVILEGED_AUTH_ADMIN,
]);

/**
 * A single Microsoft Entra ID built-in directory role, identified by its
 * stable `roleTemplateId` GUID (identical across every tenant). Feed the
 * `templateId` straight into {@link assignDirectoryRole}.
 */
export interface DirectoryRoleCatalogEntry {
  /** Stable role-template GUID — same in every tenant. */
  templateId: string;
  /** Human-readable role name as shown in the Entra portal. */
  displayName: string;
  /**
   * `true` for roles Microsoft tags as *privileged* (the ones gated behind
   * Privileged Identity Management and surfaced with the privileged label
   * in the portal). Granting any of these requires the caller to hold
   * Global Administrator or Privileged Role Administrator.
   */
  privileged: boolean;
}

/**
 * Complete catalog of Microsoft Entra ID built-in directory roles with their
 * stable template GUIDs — both the commonly-used roles and the obscure /
 * "do not use" ones (Partner Tier1/Tier2 Support, Directory Synchronization
 * Accounts, etc.). This powers the role picker on the User Creator page so an
 * operator can grant a real directory role at create-time instead of getting
 * a plain member whose job-title merely *says* "Administrator".
 *
 * Source of truth (template IDs + privileged labels):
 * https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference
 * Kept in sync with that reference; ordering matches the portal's
 * alphabetical "All roles" table.
 *
 * NOTE: granting a *privileged* role requires the signed-in account to be a
 * Global Administrator or Privileged Role Administrator. A plain User
 * Administrator can create users but cannot elevate them — Graph returns 403.
 */
export const ENTRA_DIRECTORY_ROLES: DirectoryRoleCatalogEntry[] = [
  { templateId: "db506228-d27e-4b7d-95e5-295956d6615f", displayName: "Agent ID Administrator", privileged: true },
  { templateId: "adb2368d-a9be-41b5-8667-d96778e081b0", displayName: "Agent ID Developer", privileged: false },
  { templateId: "6b942400-691f-4bf0-9d12-d8a254a2baf5", displayName: "Agent Registry Administrator", privileged: false },
  { templateId: "d2562ede-74db-457e-a7b6-544e236ebb61", displayName: "AI Administrator", privileged: true },
  { templateId: "1fe13547-53f6-408d-ac04-7f8eed167b38", displayName: "AI Reader", privileged: true },
  { templateId: "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3", displayName: "Application Administrator", privileged: true },
  { templateId: "cf1c38e5-3621-4004-a7cb-879624dced7c", displayName: "Application Developer", privileged: true },
  { templateId: "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f", displayName: "Attack Payload Author", privileged: false },
  { templateId: "c430b396-e693-46cc-96f3-db01bf8bb62a", displayName: "Attack Simulation Administrator", privileged: false },
  { templateId: "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d", displayName: "Attribute Assignment Administrator", privileged: false },
  { templateId: "ffd52fa5-98dc-465c-991d-fc073eb59f8f", displayName: "Attribute Assignment Reader", privileged: false },
  { templateId: "8424c6f0-a189-499e-bbd0-26c1753c96d4", displayName: "Attribute Definition Administrator", privileged: false },
  { templateId: "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c", displayName: "Attribute Definition Reader", privileged: false },
  { templateId: "5b784334-f94b-471a-a387-e7219fc49ca2", displayName: "Attribute Log Administrator", privileged: false },
  { templateId: "9c99539d-8186-4804-835f-fd51ef9e2dcd", displayName: "Attribute Log Reader", privileged: false },
  { templateId: "ecb2c6bf-0ab6-418e-bd87-7986f8d63bbe", displayName: "Attribute Provisioning Administrator", privileged: true },
  { templateId: "422218e4-db15-4ef9-bbe0-8afb41546d79", displayName: "Attribute Provisioning Reader", privileged: true },
  { templateId: ROLE_AUTHENTICATION_ADMIN, displayName: "Authentication Administrator", privileged: true },
  { templateId: "25a516ed-2fa0-40ea-a2d0-12923a21473a", displayName: "Authentication Extensibility Administrator", privileged: true },
  { templateId: "0b00bede-4072-4d22-b441-e7df02a1ef63", displayName: "Authentication Extensibility Password Administrator", privileged: true },
  { templateId: "0526716b-113d-4c15-b2c8-68e3c22b9f80", displayName: "Authentication Policy Administrator", privileged: false },
  { templateId: "e3973bdf-4987-49ae-837a-ba8e231c7286", displayName: "Azure DevOps Administrator", privileged: false },
  { templateId: "7495fdc4-34c4-4d15-a289-98788ce399fd", displayName: "Azure Information Protection Administrator", privileged: false },
  { templateId: "aaf43236-0c0d-4d5f-883a-6955382ac081", displayName: "B2C IEF Keyset Administrator", privileged: true },
  { templateId: "3edaf663-341e-4475-9f94-5c398ef6c070", displayName: "B2C IEF Policy Administrator", privileged: false },
  { templateId: "b0f54661-2d74-4c50-afa3-1ec803f12efe", displayName: "Billing Administrator", privileged: false },
  { templateId: "892c5842-a9a6-463a-8041-72aa08ca3cf6", displayName: "Cloud App Security Administrator", privileged: false },
  { templateId: "158c047a-c907-4556-b7ef-446551a6b5f7", displayName: "Cloud Application Administrator", privileged: true },
  { templateId: "7698a772-787b-4ac8-901f-60d6b08affd2", displayName: "Cloud Device Administrator", privileged: true },
  { templateId: "17315797-102d-40b4-93e0-432062caca18", displayName: "Compliance Administrator", privileged: false },
  { templateId: "e6d1a23a-da11-4be4-9570-befc86d067a7", displayName: "Compliance Data Administrator", privileged: false },
  { templateId: "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9", displayName: "Conditional Access Administrator", privileged: true },
  { templateId: "fc8ad4e2-40e4-4724-8317-bcda7503ecbf", displayName: "Customer Delegated Admin Relationship Administrator", privileged: false },
  { templateId: "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91", displayName: "Customer Lockbox Access Approver", privileged: false },
  { templateId: "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4", displayName: "Desktop Analytics Administrator", privileged: false },
  { templateId: ROLE_DIRECTORY_READER, displayName: "Directory Readers", privileged: false },
  { templateId: "d29b2b05-8046-44ba-8758-1e26182fcf32", displayName: "Directory Synchronization Accounts", privileged: false },
  { templateId: "9360feb5-f418-4baa-8175-e2a00bac4301", displayName: "Directory Writers", privileged: true },
  { templateId: "8329153b-31d0-4727-b945-745eb3bc5f31", displayName: "Domain Name Administrator", privileged: true },
  { templateId: "e93e3737-fa85-474a-aee4-7d3fb86510f3", displayName: "Dragon Administrator", privileged: false },
  { templateId: "44367163-eba1-44c3-98af-f5787879f96a", displayName: "Dynamics 365 Administrator", privileged: false },
  { templateId: "963797fb-eb3b-4cde-8ce3-5878b3f32a3f", displayName: "Dynamics 365 Business Central Administrator", privileged: false },
  { templateId: "3f1acade-1e04-4fbc-9b69-f0302cd84aef", displayName: "Edge Administrator", privileged: false },
  { templateId: "b6a27b2b-f905-4b2e-81b5-0d90e0ef1fdb", displayName: "Entra Backup Administrator", privileged: false },
  { templateId: "f42252d9-5400-4d7b-b9ef-cc582dbb8577", displayName: "Entra Backup Reader", privileged: false },
  { templateId: "29232cdf-9323-42fd-ade2-1d097af3e4de", displayName: "Exchange Administrator", privileged: false },
  { templateId: "49eb8f75-97e9-4e37-9b2b-6c3ebfcffa31", displayName: "Exchange Backup Administrator", privileged: false },
  { templateId: "31392ffb-586c-42d1-9346-e59415a2cc4e", displayName: "Exchange Recipient Administrator", privileged: false },
  { templateId: "dd13091a-6207-4fc0-82ba-3641e056ab95", displayName: "Extended Directory User Administrator", privileged: false },
  { templateId: "6e591065-9bad-43ed-90f3-e9424366d2f0", displayName: "External ID User Flow Administrator", privileged: false },
  { templateId: "0f971eea-41eb-4569-a71e-57bb8a3eff1e", displayName: "External ID User Flow Attribute Administrator", privileged: false },
  { templateId: "be2f45a1-457d-42af-a067-6ec1fa63bc45", displayName: "External Identity Provider Administrator", privileged: true },
  { templateId: "a9ea8996-122f-4c74-9520-8edcd192826c", displayName: "Fabric Administrator", privileged: false },
  { templateId: ROLE_GLOBAL_ADMIN, displayName: "Global Administrator", privileged: true },
  { templateId: ROLE_GLOBAL_READER, displayName: "Global Reader", privileged: true },
  { templateId: "ac434307-12b9-4fa1-a708-88bf58caabc1", displayName: "Global Secure Access Administrator", privileged: false },
  { templateId: "843318fb-79a6-4168-9e6f-aa9a07481cc4", displayName: "Global Secure Access Log Reader", privileged: false },
  { templateId: "fdd7a751-b60b-444a-984c-02652fe8fa1c", displayName: "Groups Administrator", privileged: false },
  { templateId: "95e79109-95c0-4d8e-aee3-d01accf2d47b", displayName: "Guest Inviter", privileged: false },
  { templateId: ROLE_HELPDESK_ADMIN, displayName: "Helpdesk Administrator", privileged: true },
  { templateId: "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2", displayName: "Hybrid Identity Administrator", privileged: true },
  { templateId: "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e", displayName: "Identity Governance Administrator", privileged: true },
  { templateId: "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c", displayName: "Insights Administrator", privileged: false },
  { templateId: "25df335f-86eb-4119-b717-0ff02de207e9", displayName: "Insights Analyst", privileged: false },
  { templateId: "31e939ad-9672-4796-9c2e-873181342d2d", displayName: "Insights Business Leader", privileged: false },
  { templateId: "3a2c62db-5318-420d-8d74-23affee5d9d5", displayName: "Intune Administrator", privileged: true },
  { templateId: "2ea5ce4c-b2d8-4668-bd81-3680bd2d227a", displayName: "IoT Device Administrator", privileged: false },
  { templateId: "74ef975b-6605-40af-a5d2-b9539d836353", displayName: "Kaizala Administrator", privileged: false },
  { templateId: "b5a8dcf3-09d5-43a9-a639-8e29ef291470", displayName: "Knowledge Administrator", privileged: false },
  { templateId: "744ec460-397e-42ad-a462-8b3f9747a02c", displayName: "Knowledge Manager", privileged: false },
  { templateId: "4d6ac14f-3453-41d0-bef9-a3e0c569773a", displayName: "License Administrator", privileged: false },
  { templateId: "59d46f88-662b-457b-bceb-5c3809e5908f", displayName: "Lifecycle Workflows Administrator", privileged: true },
  { templateId: "ac16e43d-7b2d-40e0-ac05-243ff356ab5b", displayName: "Message Center Privacy Reader", privileged: false },
  { templateId: "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b", displayName: "Message Center Reader", privileged: false },
  { templateId: "1707125e-0aa2-4d4d-8655-a7c786c76a25", displayName: "Microsoft 365 Backup Administrator", privileged: false },
  { templateId: "8c8b803f-96e1-4129-9349-20738d9f9652", displayName: "Microsoft 365 Migration Administrator", privileged: false },
  { templateId: "9f06204d-73c1-4d4c-880a-6edb90606fd8", displayName: "Microsoft Entra Joined Device Local Administrator", privileged: false },
  { templateId: "ee67aa9c-e510-4759-b906-227085a7fd4d", displayName: "Microsoft Graph Data Connect Administrator", privileged: false },
  { templateId: "1501b917-7653-4ff9-a4b5-203eaf33784f", displayName: "Microsoft Hardware Warranty Administrator", privileged: false },
  { templateId: "281fe777-fb20-4fbb-b7a3-ccebce5b0d96", displayName: "Microsoft Hardware Warranty Specialist", privileged: false },
  { templateId: "d37c8bed-0711-4417-ba38-b4abe66ce4c2", displayName: "Network Administrator", privileged: false },
  { templateId: "2b745bdf-0803-4d80-aa65-822c4493daac", displayName: "Office Apps Administrator", privileged: false },
  { templateId: "92ed04bf-c94a-4b82-9729-b799a7a4c178", displayName: "Organizational Branding Administrator", privileged: false },
  { templateId: "9d70768a-0cbc-4b4c-aea3-2e124b2477f4", displayName: "Organizational Data Source Administrator", privileged: false },
  { templateId: "e48398e2-f4bb-4074-8f31-4586725e205b", displayName: "Organizational Messages Approver", privileged: false },
  { templateId: "507f53e4-4e52-4077-abd3-d2e1558b6ea2", displayName: "Organizational Messages Writer", privileged: false },
  { templateId: "4ba39ca4-527c-499a-b93d-d9b492c50246", displayName: "Partner Tier1 Support (do not use)", privileged: true },
  { templateId: "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8", displayName: "Partner Tier2 Support (do not use)", privileged: true },
  { templateId: "966707d0-3269-4727-9be2-8c3a10f19b9d", displayName: "Password Administrator", privileged: true },
  { templateId: "024906de-61e5-49c8-8572-40335f1e0e10", displayName: "People Administrator", privileged: false },
  { templateId: "af78dc32-cf4d-46f9-ba4e-4428526346b5", displayName: "Permissions Management Administrator", privileged: false },
  { templateId: "78b0ccd1-afc2-4f92-9116-b41aedd09592", displayName: "Places Administrator", privileged: false },
  { templateId: "11648597-926c-4cf3-9c36-bcebb0ba8dcc", displayName: "Power Platform Administrator", privileged: false },
  { templateId: "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f", displayName: "Printer Administrator", privileged: false },
  { templateId: "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477", displayName: "Printer Technician", privileged: false },
  { templateId: ROLE_PRIVILEGED_AUTH_ADMIN, displayName: "Privileged Authentication Administrator", privileged: true },
  { templateId: ROLE_PRIVILEGED_ROLE_ADMIN, displayName: "Privileged Role Administrator", privileged: true },
  { templateId: "4a5d8f65-41da-4de4-8968-e035b65339cf", displayName: "Reports Reader", privileged: false },
  { templateId: "0964bb5e-9bdb-4d7b-ac29-58e794862a40", displayName: "Search Administrator", privileged: false },
  { templateId: "8835291a-918c-4fd7-a9ce-faa49f0cf7d9", displayName: "Search Editor", privileged: false },
  { templateId: "194ae4cb-b126-40b2-bd5b-6091b380977d", displayName: "Security Administrator", privileged: true },
  { templateId: "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f", displayName: "Security Operator", privileged: true },
  { templateId: "5d6b6bb7-de71-4623-b4af-96380a352509", displayName: "Security Reader", privileged: true },
  { templateId: "f023fd81-a637-4b56-95fd-791ac0226033", displayName: "Service Support Administrator", privileged: false },
  { templateId: "f28a1f50-f6e7-4571-818b-6a12f2af6b6c", displayName: "SharePoint Administrator", privileged: false },
  { templateId: "99009c4a-3b3f-4957-82a9-9d35e12db77e", displayName: "SharePoint Advanced Management Administrator", privileged: false },
  { templateId: "9d3e04ba-3ee4-4d1b-a3a7-9aef423a09be", displayName: "SharePoint Backup Administrator", privileged: false },
  { templateId: "1a7d78b6-429f-476b-b8eb-35fb715fffd4", displayName: "SharePoint Embedded Administrator", privileged: false },
  { templateId: "75941009-915a-4869-abe7-691bff18279e", displayName: "Skype for Business Administrator", privileged: false },
  { templateId: "69091246-20e8-4a56-aa4d-066075b2a7a8", displayName: "Teams Administrator", privileged: false },
  { templateId: "baf37b3a-610e-45da-9e62-d9d1e5e8914b", displayName: "Teams Communications Administrator", privileged: false },
  { templateId: "f70938a0-fc10-4177-9e90-2178f8765737", displayName: "Teams Communications Support Engineer", privileged: false },
  { templateId: "fcf91098-03e3-41a9-b5ba-6f0ec8188a12", displayName: "Teams Communications Support Specialist", privileged: false },
  { templateId: "3d762c5a-1b6c-493f-843e-55a3b42923d4", displayName: "Teams Devices Administrator", privileged: false },
  { templateId: "2fe872fb-daa8-4afc-8f6c-53c4565cfef4", displayName: "Teams External Collaboration Administrator", privileged: false },
  { templateId: "1076ac91-f3d9-41a7-a339-dcdf5f480acc", displayName: "Teams Reader", privileged: false },
  { templateId: "aa38014f-0993-46e9-9b45-30501a20909d", displayName: "Teams Telephony Administrator", privileged: false },
  { templateId: "112ca1a2-15ad-4102-995e-45b0bc479a6a", displayName: "Tenant Creator", privileged: false },
  { templateId: "1981f584-96e9-4a6f-95b0-f522373f8fae", displayName: "Tenant Governance Administrator", privileged: false },
  { templateId: "e0a4caa6-fe82-443f-b92f-d87341d17b2e", displayName: "Tenant Governance Reader", privileged: false },
  { templateId: "b8e31d83-1534-480f-9b10-0338ded51b7e", displayName: "Tenant Governance Relationship Administrator", privileged: false },
  { templateId: "124577f8-48ed-456a-839f-13b419002e33", displayName: "Tenant Governance Relationship Reader", privileged: false },
  { templateId: "75934031-6c7e-415a-99d7-48dbd49e875e", displayName: "Usage Summary Reports Reader", privileged: false },
  { templateId: ROLE_USER_ADMIN, displayName: "User Administrator", privileged: true },
  { templateId: "27460883-1df1-4691-b032-3b79643e5e63", displayName: "User Experience Success Manager", privileged: false },
  { templateId: "e300d9e7-4a2b-4295-9eff-f1c78b36cc98", displayName: "Virtual Visits Administrator", privileged: false },
  { templateId: "0ec3f692-38d6-4d14-9e69-0377ca7797ad", displayName: "Viva Glint Tenant Administrator", privileged: false },
  { templateId: "92b086b3-e367-4ef2-b869-1de128fb986e", displayName: "Viva Goals Administrator", privileged: false },
  { templateId: "87761b17-1ed2-4af3-9acd-92a150038160", displayName: "Viva Pulse Administrator", privileged: false },
  { templateId: "11451d60-acb2-45eb-a7d6-43d0f0125c13", displayName: "Windows 365 Administrator", privileged: false },
  { templateId: "32696413-001a-46ae-978c-ce0f6b3620d2", displayName: "Windows Update Deployment Administrator", privileged: false },
  { templateId: "810a2642-a034-447f-a5e8-41beaa378541", displayName: "Yammer Administrator", privileged: false },
];

/**
 * Look up a directory-role catalog entry by its template GUID. Returns
 * `undefined` for an unknown id (e.g. a custom role or a brand-new built-in
 * not yet in the catalog).
 */
export function findDirectoryRole(
  templateId: string,
): DirectoryRoleCatalogEntry | undefined {
  return ENTRA_DIRECTORY_ROLES.find((r) => r.templateId === templateId);
}

function validateTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error("Invalid tenantId: must be a valid GUID.");
  }
}

function validateUserId(userId: string): void {
  if (!USER_ID_RE.test(userId)) {
    throw new Error("Invalid userId: must be a valid GUID.");
  }
}

function graphHeaders(
  token: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...extra,
  };
}

function graphFetch(
  url: string,
  init: RequestInit | undefined,
  tenantId: string,
): Promise<Response> {
  return guardedFetch(url, init, {
    subscriptionId: tenantId,
    family: "graph",
  });
}

async function toGraphError(response: Response): Promise<AzureRequestError> {
  const body = await response.json().catch(() => ({}));
  const inner = (body as Record<string, unknown>)?.error as
    | Record<string, unknown>
    | undefined;
  const rawMessage =
    (inner?.message as string) ?? `Graph request failed: ${response.status}`;
  // Strip any password-like values that Graph might echo back.
  const safeMessage = rawMessage.replace(
    /"password"\s*:\s*"[^"]*"/gi,
    '"password":"***"',
  );

  // Graph nests structured details under `error.details` and inner errors
  // under `error.innerError`. Surface both for audit-log consumers.
  const detailsArr = Array.isArray(inner?.details)
    ? (inner!.details as Array<Record<string, unknown>>).slice(0, 20).map((d) => ({
        code: d.code as string | undefined,
        message: (d.message as string | undefined)?.replace(
          /"password"\s*:\s*"[^"]*"/gi,
          '"password":"***"',
        ),
      }))
    : undefined;

  const urlPath = (() => {
    try {
      return new URL(response.url).pathname;
    } catch {
      return response.url || undefined;
    }
  })();

  // Enrich the message for the canonical Graph 403 patterns so the
  // operator sees what they ACTUALLY need to fix instead of just
  // "Insufficient privileges to complete the operation." Graph's
  // default message is famously unactionable — operators routinely
  // think their app registration is misconfigured when the real
  // problem is a missing directory role on the SIGNED-IN USER for
  // the destination tenant (or vice-versa).
  let enrichedMessage = safeMessage;
  if (response.status === 403) {
    const code = (inner?.code as string) ?? "";
    const isPrivilegeDenied =
      /Authorization_RequestDenied|Insufficient privileges/i.test(
        `${code} ${safeMessage}`,
      );
    if (isPrivilegeDenied) {
      const isUsersEndpoint = /\/users(\/|\?|$)/.test(urlPath ?? "");
      const guidance = isUsersEndpoint
        ? "Two things must both be true for /users operations in the destination tenant:\n" +
          "  1) The signed-in user holds an Entra directory role with the right scope — " +
          "typically User Administrator or Global Administrator (writes), or Directory Readers " +
          "(reads). Verify in the DESTINATION tenant's Entra ID → Users → [you] → Assigned roles. " +
          "Role assignments in your home tenant do NOT carry over.\n" +
          "  2) The MSAL app (this WebUI's client id) has admin-consented Graph permissions " +
          "for User.ReadWrite.All / Directory.ReadWrite.All (or .Read.All for reads). " +
          "Ask a tenant admin to grant admin consent for the app in the destination tenant."
        : "Either the signed-in user lacks a directory role granting this action in the " +
          "destination tenant, OR the MSAL app hasn't been admin-consented for the required " +
          "Graph permissions in that tenant. Check Entra ID → Users → [you] → Assigned roles " +
          "in the DESTINATION tenant (not your home tenant), then ask a tenant admin to grant " +
          "admin consent for the app if the role looks correct.";
      enrichedMessage =
        `${safeMessage}\n\n` +
        `Graph rejected the call as 403 / ${code || "Authorization_RequestDenied"}.\n` +
        guidance +
        `\nIf you just received the role, wait ~5 min for propagation, then click "Sign in ` +
        `again" to mint a fresh token whose claims see the new assignment.`;
    }
  }

  const display = urlPath
    ? `${response.status} ${urlPath}: ${enrichedMessage}`
    : enrichedMessage;
  const DISPLAY_MAX = 1000;
  const truncated =
    display.length > DISPLAY_MAX
      ? `${display.slice(0, DISPLAY_MAX)}…[truncated]`
      : display;

  // Classify into RateLimitError / NotFoundError / etc so Graph 429s
  // (which carry the same Retry-After hint as ARM) surface to typed
  // catch sites without a magic-number check.
  const retryAfterHeader = response.headers.get("Retry-After");
  const err = classifyHttpError(
    truncated,
    response.status,
    (inner?.code as string) ?? "GraphError",
    body,
    retryAfterHeader,
  );
  if (urlPath) err.urlPath = urlPath;
  if (detailsArr && detailsArr.length > 0) err.details = detailsArr;
  return err;
}

async function fetchAllPages<T>(
  initialUrl: string,
  token: string,
  tenantId: string,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T[]> {
  return sharedFetchAllPages<T>({
    initialUrl,
    nextLinkPath: (page: Record<string, unknown>) =>
      page["@odata.nextLink"] as string | undefined,
    signal,
    fetcher: async (url, sig) => {
      const response = await graphFetch(
        url,
        {
          headers: graphHeaders(token, extraHeaders),
          ...(sig ? { signal: sig } : {}),
        },
        tenantId,
      );
      if (!response.ok) {
        throw await toGraphError(response);
      }
      return response.json();
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ListOrgUsersOptions {
  search?: string;
  top?: number;
  select?: string[];
  /** Cancel the multi-page walk (e.g. when the page unmounts). */
  signal?: AbortSignal;
}

/**
 * List users in the calling tenant via Microsoft Graph.
 *
 * Returns the projection requested via `$select` (defaults to id,
 * displayName, userPrincipalName, mail, accountEnabled, jobTitle,
 * department). When `search` is provided the server-side $search filter
 * is used together with the `ConsistencyLevel: eventual` header, which
 * Graph requires for advanced query parameters.
 */
export async function listOrgUsers(
  tenantId: string,
  accessToken: string,
  opts?: ListOrgUsersOptions,
): Promise<GraphUser[]> {
  validateTenantId(tenantId);
  const select = opts?.select?.length
    ? opts.select.join(",")
    : DEFAULT_USER_SELECT.join(",");
  const top = Math.max(1, Math.min(999, opts?.top ?? 999));
  const params = new URLSearchParams();
  params.set("$select", select);
  params.set("$top", String(top));

  const extraHeaders: Record<string, string> = {};
  if (opts?.search && opts.search.trim().length > 0) {
    const escaped = opts.search.replace(/"/g, '\\"');
    params.set("$search", `"displayName:${escaped}" OR "mail:${escaped}"`);
    params.set("$count", "true");
    extraHeaders["ConsistencyLevel"] = "eventual";
  }

  const url = `${GRAPH_BASE}/users?${params.toString()}`;
  const raw = await fetchAllPages<Record<string, unknown>>(
    url,
    accessToken,
    tenantId,
    extraHeaders,
    opts?.signal,
  );
  return raw.map((u) => ({
    id: (u.id as string) ?? "",
    displayName: (u.displayName as string) ?? "",
    userPrincipalName: (u.userPrincipalName as string) ?? "",
    mail: (u.mail as string | null) ?? null,
    accountEnabled: Boolean(u.accountEnabled),
    jobTitle: (u.jobTitle as string | null) ?? null,
    department: (u.department as string | null) ?? null,
  }));
}

function mapDirectoryRoleResponse(
  raw: Array<Record<string, unknown>>,
): DirectoryRole[] {
  return raw
    .filter((r) => r["@odata.type"] === "#microsoft.graph.directoryRole")
    .map((r) => ({
      id: (r.id as string) ?? "",
      displayName: (r.displayName as string) ?? "",
      description: (r.description as string) ?? undefined,
      roleTemplateId: (r.roleTemplateId as string) ?? "",
    }));
}

/**
 * Get directory role memberships for the calling user (`/me/memberOf`).
 * Filters to entries whose @odata.type is "#microsoft.graph.directoryRole".
 */
export async function getMyDirectoryRoles(
  tenantId: string,
  accessToken: string,
): Promise<DirectoryRole[]> {
  validateTenantId(tenantId);
  const url =
    `${GRAPH_BASE}/me/memberOf` +
    `?$select=id,displayName,description,roleTemplateId`;
  const raw = await fetchAllPages<Record<string, unknown>>(
    url,
    accessToken,
    tenantId,
  );
  return mapDirectoryRoleResponse(raw);
}

/**
 * Get directory role memberships for a specific user
 * (`/users/{id}/memberOf`).
 *
 * Note: prefer `getUserDirectoryRolesBatched` when looking up roles for
 * many users — it collapses N separate Graph calls into ceil(N/20) via
 * the JSON `$batch` endpoint. This single-user variant is kept for
 * call sites that only ever need one user.
 */
export async function getUserDirectoryRoles(
  tenantId: string,
  userId: string,
  accessToken: string,
): Promise<DirectoryRole[]> {
  validateTenantId(tenantId);
  validateUserId(userId);
  const url =
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/memberOf` +
    `?$select=id,displayName,description,roleTemplateId`;
  const raw = await fetchAllPages<Record<string, unknown>>(
    url,
    accessToken,
    tenantId,
  );
  return mapDirectoryRoleResponse(raw);
}

/**
 * Bulk variant of `getUserDirectoryRoles` — one Graph `$batch` POST
 * per 20 users instead of one round-trip per user.
 *
 * Returns a Map<userId, DirectoryRole[]>. Users absent from the map
 * either had no role memberships OR their individual sub-request
 * failed (fail-soft: per-user errors are swallowed and logged via
 * console.warn so a single bad userId can't poison the batch).
 *
 * Background: Microsoft Graph `$batch` accepts up to 20 sub-requests
 * per call. Sub-requests are evaluated independently against
 * throttling, so $batch saves round-trips but not throttle budget.
 * For the tenant-users page this still flips the worst case from
 * 500 GETs to 25 POSTs — a 20× reduction in latency and connection
 * pressure (browsers cap per-origin concurrency at 6).
 *
 * Reference: https://learn.microsoft.com/graph/json-batching
 */
export async function getUserDirectoryRolesBatched(
  tenantId: string,
  userIds: string[],
  accessToken: string,
): Promise<Map<string, DirectoryRole[]>> {
  validateTenantId(tenantId);
  const result = new Map<string, DirectoryRole[]>();
  if (userIds.length === 0) return result;

  // Validate ids client-side so a bad caller doesn't waste a batch slot.
  const validIds = userIds.filter((id) => {
    try {
      validateUserId(id);
      return true;
    } catch {
      return false;
    }
  });

  const BATCH_LIMIT = 20;
  for (let i = 0; i < validIds.length; i += BATCH_LIMIT) {
    const chunk = validIds.slice(i, i + BATCH_LIMIT);
    const requests = chunk.map((id, idx) => ({
      id: `${i + idx}`,
      method: "GET",
      url:
        `/users/${encodeURIComponent(id)}/memberOf` +
        `?$select=id,displayName,description,roleTemplateId`,
    }));

    const response = await graphFetch(
      `${GRAPH_BASE}/$batch`,
      {
        method: "POST",
        headers: graphHeaders(accessToken, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ requests }),
      },
      tenantId,
    );

    if (!response.ok) {
      throw await toGraphError(response);
    }

    const body = (await response.json()) as {
      responses?: Array<{
        id: string;
        status: number;
        body?: { value?: unknown[]; error?: { message?: string } };
      }>;
    };
    if (!Array.isArray(body.responses)) continue;

    for (const r of body.responses) {
      const reqIdx = Number(r.id);
      if (!Number.isFinite(reqIdx)) continue;
      const userId = chunk[reqIdx - i];
      if (!userId) continue;
      if (r.status >= 200 && r.status < 300) {
        const value = (r.body?.value ?? []) as Array<Record<string, unknown>>;
        result.set(userId, mapDirectoryRoleResponse(value));
      } else {
        const msg = r.body?.error?.message ?? `status ${r.status}`;
        console.warn(
          `[graph $batch] memberOf for user ${userId.substring(0, 8)} failed: ${msg}`,
        );
      }
    }
  }
  return result;
}

/**
 * Reset a user's password via Microsoft Graph (PATCH /users/{id}).
 *
 * The caller must have one of the password-reset directory roles
 * (see canResetPasswords). Sensitive payload is never logged.
 */
export async function resetUserPassword(
  tenantId: string,
  userId: string,
  newPassword: string,
  forceChangeNextSignIn: boolean,
  accessToken: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  validateTenantId(tenantId);
  validateUserId(userId);
  if (typeof newPassword !== "string" || newPassword.length === 0) {
    throw new Error("Invalid newPassword: must be a non-empty string.");
  }
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(userId)}`;
  const body = JSON.stringify({
    passwordProfile: {
      password: newPassword,
      forceChangePasswordNextSignIn: !!forceChangeNextSignIn,
    },
  });
  const response = await graphFetch(
    url,
    {
      method: "PATCH",
      headers: graphHeaders(accessToken, {
        "Content-Type": "application/json",
      }),
      body,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    },
    tenantId,
  );
  if (!response.ok) {
    throw await toGraphError(response);
  }
}

/**
 * Pure-function helper: returns true if the supplied roles include any
 * directory role that grants the ability to reset another user's
 * password.
 */
export function canResetPasswords(roles: DirectoryRole[]): boolean {
  if (!Array.isArray(roles) || roles.length === 0) return false;
  return roles.some((r) => PASSWORD_RESET_ROLE_TEMPLATES.has(r.roleTemplateId));
}

// ---------------------------------------------------------------------------
// MFA / strong-authentication methods
//
// "Reset MFA" = delete a user's registered strong-auth methods so they are
// forced to re-register at next sign-in (the modern equivalent of the legacy
// MSOnline `Reset-MsolStrongAuthenticationMethodByUpn`), optionally followed
// by a session revoke to force immediate re-auth. Endpoints + role
// requirements verified against Microsoft Graph v1.0 authenticationMethod
// APIs (Authentication Administrator / Privileged Authentication
// Administrator; UserAuthenticationMethod.ReadWrite.All).
// ---------------------------------------------------------------------------

/**
 * One of a user's registered authentication methods, normalized from the
 * polymorphic Graph `/authentication/methods` collection. `removable` is
 * false for the password method (Graph forbids deleting it) and for any
 * method type without a documented per-type DELETE endpoint.
 */
export interface UserAuthMethod {
  id: string;
  /** Graph @odata.type, e.g. "#microsoft.graph.phoneAuthenticationMethod". */
  odataType: string;
  /** Friendly kind label, e.g. "Phone", "Microsoft Authenticator". */
  kind: string;
  /** Human detail (phone number, device name, email, …) when present. */
  detail?: string;
  /** Whether resetUserMfa will attempt to delete this method. */
  removable: boolean;
  /** The /authentication/{segment}/{id} path segment, when deletable. */
  segment?: string;
}

/**
 * @odata.type → /authentication/{segment} mapping for method types that
 * expose a per-type DELETE. Password is intentionally absent — Graph rejects
 * deleting it. Source: Microsoft Graph authenticationMethod delete APIs.
 */
const MFA_METHOD_SEGMENTS: Record<
  string,
  { segment: string; kind: string }
> = {
  "#microsoft.graph.phoneAuthenticationMethod": {
    segment: "phoneMethods",
    kind: "Phone",
  },
  "#microsoft.graph.microsoftAuthenticatorAuthenticationMethod": {
    segment: "microsoftAuthenticatorMethods",
    kind: "Microsoft Authenticator",
  },
  "#microsoft.graph.fido2AuthenticationMethod": {
    segment: "fido2Methods",
    kind: "FIDO2 security key",
  },
  "#microsoft.graph.emailAuthenticationMethod": {
    segment: "emailMethods",
    kind: "Email OTP",
  },
  "#microsoft.graph.softwareOathAuthenticationMethod": {
    segment: "softwareOathMethods",
    kind: "Software OATH (TOTP)",
  },
  "#microsoft.graph.windowsHelloForBusinessAuthenticationMethod": {
    segment: "windowsHelloForBusinessMethods",
    kind: "Windows Hello for Business",
  },
  "#microsoft.graph.temporaryAccessPassAuthenticationMethod": {
    segment: "temporaryAccessPassMethods",
    kind: "Temporary Access Pass",
  },
};

/** Friendly labels for method types we surface but never auto-delete. */
const MFA_KIND_FALLBACK: Record<string, string> = {
  "#microsoft.graph.passwordAuthenticationMethod": "Password",
  "#microsoft.graph.hardwareOathAuthenticationMethod": "Hardware OATH token",
  "#microsoft.graph.platformCredentialAuthenticationMethod":
    "Platform credential",
  "#microsoft.graph.passwordlessMicrosoftAuthenticatorAuthenticationMethod":
    "Passwordless Authenticator (legacy)",
};

/** Each method type surfaces its human detail under a different property. */
function describeAuthMethod(raw: Record<string, unknown>): string | undefined {
  return (
    (raw.phoneNumber as string) ||
    (raw.displayName as string) ||
    (raw.emailAddress as string) ||
    (raw.model as string) ||
    undefined
  );
}

/** List a user's registered authentication methods (Graph, paginated). */
export async function listUserAuthMethods(
  tenantId: string,
  userId: string,
  accessToken: string,
  opts?: { signal?: AbortSignal },
): Promise<UserAuthMethod[]> {
  validateTenantId(tenantId);
  validateUserId(userId);
  const url =
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}` +
    `/authentication/methods`;
  const raw = await fetchAllPages<Record<string, unknown>>(
    url,
    accessToken,
    tenantId,
    undefined,
    opts?.signal,
  );
  return raw.map((m) => {
    const odataType = (m["@odata.type"] as string) ?? "";
    const known = MFA_METHOD_SEGMENTS[odataType];
    const derivedKind =
      odataType
        .replace("#microsoft.graph.", "")
        .replace(/AuthenticationMethod$/, "") || "Unknown method";
    const kind = known?.kind ?? MFA_KIND_FALLBACK[odataType] ?? derivedKind;
    return {
      id: String(m.id ?? ""),
      odataType,
      kind,
      detail: describeAuthMethod(m),
      removable: Boolean(known),
      segment: known?.segment,
    };
  });
}

/**
 * Delete a single authentication method by its type segment + id. A 404 is
 * treated as success (already gone) so the operation stays idempotent.
 */
export async function deleteUserAuthMethod(
  tenantId: string,
  userId: string,
  segment: string,
  methodId: string,
  accessToken: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  validateTenantId(tenantId);
  validateUserId(userId);
  // `segment` comes from our own allow-list map, but guard against any
  // future caller passing arbitrary input into the URL path.
  if (!/^[A-Za-z0-9]+$/.test(segment)) {
    throw new Error("Invalid authentication-method segment.");
  }
  const url =
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/authentication/` +
    `${segment}/${encodeURIComponent(methodId)}`;
  const response = await graphFetch(
    url,
    {
      method: "DELETE",
      headers: graphHeaders(accessToken),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    },
    tenantId,
  );
  if (!response.ok && response.status !== 404) {
    throw await toGraphError(response);
  }
}

/**
 * Force a user to re-authenticate by invalidating their refresh tokens
 * (POST /users/{id}/revokeSignInSessions). Pairs with an MFA reset so the
 * user can't keep using an existing session after their methods are wiped.
 */
export async function revokeUserSignInSessions(
  tenantId: string,
  userId: string,
  accessToken: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  validateTenantId(tenantId);
  validateUserId(userId);
  const url =
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/revokeSignInSessions`;
  const response = await graphFetch(
    url,
    {
      method: "POST",
      headers: graphHeaders(accessToken, {
        "Content-Type": "application/json",
      }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    },
    tenantId,
  );
  if (!response.ok) {
    throw await toGraphError(response);
  }
}

export interface MfaResetResult {
  deleted: UserAuthMethod[];
  failed: Array<{ method: UserAuthMethod; error: string }>;
  skipped: UserAuthMethod[];
  sessionsRevoked: boolean;
}

/**
 * Reset a user's MFA: delete the selected, removable strong-auth methods so
 * they must re-register at next sign-in, then (optionally) revoke active
 * sessions. The caller must hold Authentication Administrator or Privileged
 * Authentication Administrator in the target tenant — Graph enforces this
 * and a 403 surfaces per-method in `failed`.
 *
 * Each delete is attempted independently so one failure (e.g. the user's
 * DEFAULT MFA method, which Graph refuses to delete until the default is
 * changed) doesn't abort the rest. Non-removable methods (password, and any
 * type without a delete endpoint) are returned in `skipped`, untouched.
 */
export async function resetUserMfa(
  tenantId: string,
  userId: string,
  accessToken: string,
  opts: {
    methods: UserAuthMethod[];
    revokeSessions: boolean;
    signal?: AbortSignal;
  },
): Promise<MfaResetResult> {
  const deleted: UserAuthMethod[] = [];
  const failed: Array<{ method: UserAuthMethod; error: string }> = [];
  const skipped: UserAuthMethod[] = [];
  for (const m of opts.methods) {
    if (opts.signal?.aborted) break;
    if (!m.removable || !m.segment) {
      skipped.push(m);
      continue;
    }
    try {
      await deleteUserAuthMethod(tenantId, userId, m.segment, m.id, accessToken, {
        signal: opts.signal,
      });
      deleted.push(m);
    } catch (err) {
      failed.push({
        method: m,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let sessionsRevoked = false;
  if (opts.revokeSessions && !opts.signal?.aborted) {
    await revokeUserSignInSessions(tenantId, userId, accessToken, {
      signal: opts.signal,
    });
    sessionsRevoked = true;
  }
  return { deleted, failed, skipped, sessionsRevoked };
}

// Roles that can manage ANOTHER user's authentication methods. Note this is
// stricter than password reset: Helpdesk / User Administrators can reset
// passwords but cannot delete auth methods.
const MFA_MANAGE_ROLE_TEMPLATES = new Set<string>([
  ROLE_GLOBAL_ADMIN,
  ROLE_AUTHENTICATION_ADMIN,
  ROLE_PRIVILEGED_AUTH_ADMIN,
]);

/**
 * Pure-function helper: true when the supplied directory roles include one
 * that can reset another user's MFA / authentication methods.
 */
export function canManageMfa(roles: DirectoryRole[]): boolean {
  if (!Array.isArray(roles) || roles.length === 0) return false;
  return roles.some((r) => MFA_MANAGE_ROLE_TEMPLATES.has(r.roleTemplateId));
}

const USER_CREATE_ROLE_TEMPLATES = new Set<string>([
  ROLE_GLOBAL_ADMIN,
  ROLE_USER_ADMIN,
]);

/**
 * Pure-function helper: returns true when the supplied directory roles
 * include one that can CREATE new users (NOT just reset passwords).
 * Helpdesk + Authentication Administrators are explicitly excluded —
 * they can only reset passwords, not create users.
 */
export function canCreateUsers(roles: DirectoryRole[]): boolean {
  if (!Array.isArray(roles) || roles.length === 0) return false;
  return roles.some((r) => USER_CREATE_ROLE_TEMPLATES.has(r.roleTemplateId));
}

// Roles that can GRANT other directory roles (add a principal to a
// directory role's members). Strictly: Global Administrator and Privileged
// Role Administrator. A User Administrator can create users but cannot
// elevate them — attempting to do so returns 403.
const ROLE_GRANT_ROLE_TEMPLATES = new Set<string>([
  ROLE_GLOBAL_ADMIN,
  ROLE_PRIVILEGED_ROLE_ADMIN,
]);

/**
 * Pure-function helper: true when the supplied directory roles include one
 * that can assign other directory roles (Global Administrator or Privileged
 * Role Administrator). Used to pre-flight-gate the User Creator role picker
 * so an operator who can create users but not elevate them is warned BEFORE
 * the create instead of hitting a 403 on the grant.
 *
 * NOTE: this is a *necessary* signal, not a fully *sufficient* one — Graph
 * also enforces role-assignable-group / PIM / scope constraints we can't see
 * client-side. It catches the overwhelmingly common "I'm only a User Admin"
 * case; the create path still surfaces any residual 403 from the grant.
 */
export function canManageRoles(roles: DirectoryRole[]): boolean {
  if (!Array.isArray(roles) || roles.length === 0) return false;
  return roles.some((r) => ROLE_GRANT_ROLE_TEMPLATES.has(r.roleTemplateId));
}

export interface CreateUserRequest {
  userPrincipalName: string;
  displayName: string;
  mailNickname: string;
  password: string;
  forceChangePasswordNextSignIn: boolean;
  accountEnabled: boolean;
  usageLocation?: string;
  givenName?: string;
  surname?: string;
  jobTitle?: string;
  department?: string;
}

export interface CreateUserResult {
  id: string;
  userPrincipalName: string;
  displayName: string;
  accountEnabled: boolean;
  mailNickname: string;
  createdDateTime?: string;
}

/**
 * Create a new Microsoft Entra ID user via Microsoft Graph
 * (POST /users). The caller must hold a directory role that allows
 * user creation (User Administrator or Global Administrator).
 *
 * Sensitive payload (password) is never logged. On 4xx, throws an
 * AzureRequestError carrying the Graph error message.
 */
export async function createUser(
  tenantId: string,
  req: CreateUserRequest,
  accessToken: string,
  opts?: { signal?: AbortSignal },
): Promise<CreateUserResult> {
  validateTenantId(tenantId);
  if (!req || typeof req !== "object") {
    throw new Error("Invalid request: must provide a CreateUserRequest.");
  }
  if (!req.userPrincipalName || !req.userPrincipalName.includes("@")) {
    throw new Error(
      "Invalid userPrincipalName: must be of the form <prefix>@<domain>.",
    );
  }
  if (!req.displayName) {
    throw new Error("Invalid displayName: must be a non-empty string.");
  }
  if (!req.mailNickname) {
    throw new Error("Invalid mailNickname: must be a non-empty string.");
  }
  if (typeof req.password !== "string" || req.password.length === 0) {
    throw new Error("Invalid password: must be a non-empty string.");
  }

  const url = `${GRAPH_BASE}/users`;
  const body: Record<string, unknown> = {
    accountEnabled: !!req.accountEnabled,
    displayName: req.displayName,
    mailNickname: req.mailNickname,
    userPrincipalName: req.userPrincipalName,
    passwordProfile: {
      password: req.password,
      forceChangePasswordNextSignIn: !!req.forceChangePasswordNextSignIn,
    },
  };
  if (req.usageLocation) body.usageLocation = req.usageLocation;
  if (req.givenName) body.givenName = req.givenName;
  if (req.surname) body.surname = req.surname;
  if (req.jobTitle) body.jobTitle = req.jobTitle;
  if (req.department) body.department = req.department;

  const response = await graphFetch(
    url,
    {
      method: "POST",
      headers: graphHeaders(accessToken, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(body),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    },
    tenantId,
  );
  if (!response.ok) {
    throw await toGraphError(response);
  }
  const data = (await response.json()) as Record<string, unknown>;
  return {
    id: (data.id as string) ?? "",
    userPrincipalName: (data.userPrincipalName as string) ?? "",
    displayName: (data.displayName as string) ?? "",
    accountEnabled: Boolean(data.accountEnabled),
    mailNickname: (data.mailNickname as string) ?? "",
    createdDateTime: (data.createdDateTime as string | undefined) ?? undefined,
  };
}

/**
 * Add a user (or any directory principal) to a built-in directory role,
 * identified by its template GUID (the {@link ROLE_USER_ADMIN}-style
 * constants in this file).
 *
 * Two-step flow because Graph's classic `/directoryRoles` collection only
 * contains roles that have been *activated* in the tenant:
 *
 *   1. Look up the activated role by `roleTemplateId`. If not present,
 *      activate it by POSTing the template id to `/directoryRoles`.
 *   2. POST the user's directoryObjects ref to the role's
 *      `/members/$ref` collection.
 *
 * Required caller privilege (delegated): Global Administrator OR
 * Privileged Role Administrator, OR a same-or-lower role manager.
 * Specifically, a User Administrator can only add members to roles at or
 * below their own scope — so attempting to grant Global Admin from a
 * User-Admin token fails with 403. Errors propagate as
 * {@link AzureRequestError} so the UI can surface them inline.
 */
export async function assignDirectoryRole(
  tenantId: string,
  userObjectId: string,
  roleTemplateId: string,
  accessToken: string,
  opts?: { signal?: AbortSignal },
): Promise<{ roleObjectId: string; alreadyMember: boolean }> {
  validateTenantId(tenantId);
  validateUserId(userObjectId);
  if (!/^[0-9a-f-]{36}$/i.test(roleTemplateId)) {
    throw new Error("Invalid roleTemplateId: must be a valid GUID.");
  }

  // Step 1a: find the activated role for this template.
  const listUrl =
    `${GRAPH_BASE}/directoryRoles?$filter=` +
    encodeURIComponent(`roleTemplateId eq '${roleTemplateId}'`);
  let roleObjectId: string | null = null;
  {
    const resp = await graphFetch(
      listUrl,
      {
        headers: graphHeaders(accessToken),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      },
      tenantId,
    );
    if (!resp.ok) throw await toGraphError(resp);
    const body = (await resp.json()) as { value?: Array<{ id?: string }> };
    if (body.value && body.value.length > 0 && body.value[0]?.id) {
      roleObjectId = body.value[0]!.id!;
    }
  }

  // Step 1b: activate the template if it wasn't already active in this tenant.
  if (!roleObjectId) {
    const activateResp = await graphFetch(
      `${GRAPH_BASE}/directoryRoles`,
      {
        method: "POST",
        headers: graphHeaders(accessToken, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ roleTemplateId }),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      },
      tenantId,
    );
    if (!activateResp.ok) throw await toGraphError(activateResp);
    const activated = (await activateResp.json()) as { id?: string };
    if (!activated.id) {
      throw new Error(
        "Directory role activation returned an empty object id.",
      );
    }
    roleObjectId = activated.id;
  }

  // Step 2: add the user to the role. Graph returns 204 No Content on
  // success and a `409 Conflict / Request_BadRequest` echoing
  // "One or more added object references already exist" if the user is
  // already a member — that's idempotent success from our perspective.
  const addResp = await graphFetch(
    `${GRAPH_BASE}/directoryRoles/${encodeURIComponent(roleObjectId)}/members/$ref`,
    {
      method: "POST",
      headers: graphHeaders(accessToken, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        "@odata.id": `${GRAPH_BASE}/directoryObjects/${userObjectId}`,
      }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    },
    tenantId,
  );
  if (addResp.ok) {
    return { roleObjectId, alreadyMember: false };
  }
  // Treat "already a member" as success.
  const errBody = await addResp.json().catch(() => ({}));
  const msg = String(
    (errBody as { error?: { message?: string } })?.error?.message ?? "",
  ).toLowerCase();
  if (
    addResp.status === 400 &&
    (msg.includes("already exist") || msg.includes("already a member"))
  ) {
    return { roleObjectId, alreadyMember: true };
  }
  // Route through classifyHttpError so 401 → AuthError / 403 →
  // PermissionError / 429 → RateLimitError reach `instanceof`-aware
  // call sites (auditing, retry policy). Previously a bare
  // AzureRequestError was thrown, which the typed catch sites would
  // miss.
  throw classifyHttpError(
    (errBody as { error?: { message?: string } })?.error?.message ??
      `Graph request failed: ${addResp.status}`,
    addResp.status,
    (errBody as { error?: { code?: string } })?.error?.code ?? "GraphError",
    errBody,
    addResp.headers.get("Retry-After"),
  );
}

/**
 * Friendly resolution of a directory-object id to a display name + UPN.
 * Sub Manager uses this to turn the bare GUIDs that come back from
 * roleAssignments into human-readable rows.
 */
export interface ResolvedPrincipal {
  id: string;
  /** "User" | "Group" | "ServicePrincipal" | "Application" | "Unknown". */
  type: string;
  displayName: string;
  /** UPN for users, appId for service principals, mail for groups (if set). */
  signInName?: string;
}

/**
 * Bulk-resolve directory-object ids via Graph's `directoryObjects/getByIds`.
 * The endpoint accepts up to 1000 ids per call; we chunk in 100s to keep
 * each request fast and to play nice with the per-request payload size
 * limit. Missing ids are returned as `{id, type: "Unknown", displayName: id}`
 * so the UI always has a row to show.
 */
export async function getPrincipalsByIds(
  tenantId: string,
  objectIds: string[],
  accessToken: string,
): Promise<ResolvedPrincipal[]> {
  validateTenantId(tenantId);
  const unique = Array.from(new Set(objectIds.filter((id) => !!id)));
  if (unique.length === 0) return [];
  const out = new Map<string, ResolvedPrincipal>();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const resp = await graphFetch(
      `${GRAPH_BASE}/directoryObjects/getByIds`,
      {
        method: "POST",
        headers: graphHeaders(accessToken, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          ids: chunk,
          types: ["user", "group", "servicePrincipal"],
        }),
      },
      tenantId,
    );
    if (!resp.ok) throw await toGraphError(resp);
    const body = (await resp.json()) as {
      value?: Array<Record<string, unknown>>;
    };
    for (const obj of body.value ?? []) {
      const id = String(obj.id ?? "");
      if (!id) continue;
      const odata = String(obj["@odata.type"] ?? "").toLowerCase();
      const type = odata.includes("user")
        ? "User"
        : odata.includes("group")
          ? "Group"
          : odata.includes("serviceprincipal")
            ? "ServicePrincipal"
            : odata.includes("application")
              ? "Application"
              : "Unknown";
      const displayName =
        (obj.displayName as string | undefined) ??
        (obj.userPrincipalName as string | undefined) ??
        id;
      const signInName =
        (obj.userPrincipalName as string | undefined) ??
        (obj.mail as string | undefined) ??
        (obj.appId as string | undefined);
      out.set(id, { id, type, displayName, signInName });
    }
  }
  // Backfill any ids Graph didn't return (deleted principal, lacking
  // permission to see them, etc.) so the caller can render a row for
  // each request id.
  for (const id of unique) {
    if (!out.has(id)) {
      out.set(id, { id, type: "Unknown", displayName: id });
    }
  }
  return Array.from(out.values());
}

/**
 * Resolve a UPN or email to a User object id via Graph. Returns
 * undefined when no exact match. Used by Sub Manager's "add by email"
 * flow so the operator doesn't have to look up GUIDs manually.
 */
export async function findUserByUpnOrMail(
  tenantId: string,
  upnOrMail: string,
  accessToken: string,
): Promise<{ id: string; displayName: string; upn: string } | undefined> {
  validateTenantId(tenantId);
  const value = upnOrMail.trim();
  if (!value) return undefined;
  // Try direct GET first — works for canonical UPNs.
  const direct = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(value)}?$select=id,displayName,userPrincipalName,mail`,
    { headers: graphHeaders(accessToken) },
    tenantId,
  );
  if (direct.ok) {
    const data = (await direct.json()) as Record<string, unknown>;
    return {
      id: String(data.id ?? ""),
      displayName: String(data.displayName ?? value),
      upn: String(data.userPrincipalName ?? value),
    };
  }
  // Fallback: $filter on userPrincipalName or mail. Catches guests
  // whose UPN is mangled (#EXT#) when the operator pasted the raw mail.
  const escaped = value.replace(/'/g, "''");
  const filterUrl =
    `${GRAPH_BASE}/users` +
    `?$filter=userPrincipalName eq '${encodeURIComponent(escaped)}'` +
    ` or mail eq '${encodeURIComponent(escaped)}'` +
    `&$select=id,displayName,userPrincipalName,mail&$top=1`;
  const filtered = await graphFetch(
    filterUrl,
    { headers: graphHeaders(accessToken) },
    tenantId,
  );
  if (!filtered.ok) throw await toGraphError(filtered);
  const body = (await filtered.json()) as {
    value?: Array<Record<string, unknown>>;
  };
  const first = body.value?.[0];
  if (!first) return undefined;
  return {
    id: String(first.id ?? ""),
    displayName: String(first.displayName ?? value),
    upn: String(first.userPrincipalName ?? value),
  };
}

export interface InviteGuestRequest {
  /** External email address of the user being invited. */
  invitedUserEmailAddress: string;
  /** Optional display name surfaced in the invitation email and on the
   *  redeemer's home tenant once the redemption completes. */
  invitedUserDisplayName?: string;
  /**
   * Where Graph should send the redeemer after they consent. Defaults to
   * https://myapplications.microsoft.com — the standard Microsoft "My
   * Apps" landing page.
   */
  inviteRedirectUrl?: string;
  /**
   * If true, Graph emails the inviting message and redemption URL.
   * Defaults to false because most operators want the URL surfaced in
   * the WebUI directly so they can hand it over via their own channel
   * (Teams DM, ticketing system, etc.).
   */
  sendInvitationMessage?: boolean;
  /** Optional custom body added to the invitation email when
   *  sendInvitationMessage is true. */
  customizedMessageBody?: string;
}

export interface InviteGuestResult {
  id: string;
  /** The redemption URL the invited user opens to accept the invitation
   *  and join the tenant. This is the headline output of the page. */
  inviteRedeemUrl: string;
  /** The User object Graph created to represent the invitee — its `id`
   *  and `userPrincipalName` are useful for downstream role-assignment
   *  flows. */
  invitedUser: {
    id: string;
    userPrincipalName?: string;
    displayName?: string;
  };
  inviteRedirectUrl: string;
  /** Echo of `sendInvitationMessage` so the operator can confirm whether
   *  Graph actually emailed the invitee (false ⇒ they need to copy the
   *  URL themselves). */
  sendInvitationMessage: boolean;
  /** Status reported by Graph: typically "PendingAcceptance" when the
   *  invitation has not been redeemed yet. */
  status?: string;
}

/**
 * Invite an external (B2B) user to the calling tenant via the Graph
 * `/invitations` endpoint. The caller's access token must hold the
 * `User.Invite.All` permission — granted by the Guest Inviter, User
 * Administrator, or Global Administrator directory roles.
 *
 * The returned `inviteRedeemUrl` is what the operator copies and sends
 * to the invited user. If `sendInvitationMessage` is true, Graph also
 * sends an email with the same URL embedded — but the WebUI surfaces
 * the URL regardless so it never gets lost in the operator's inbox.
 */
export async function inviteGuest(
  tenantId: string,
  req: InviteGuestRequest,
  accessToken: string,
  opts?: { signal?: AbortSignal },
): Promise<InviteGuestResult> {
  validateTenantId(tenantId);
  if (
    !req?.invitedUserEmailAddress ||
    !req.invitedUserEmailAddress.includes("@")
  ) {
    throw new Error(
      "Invalid invitedUserEmailAddress: must be of the form <user>@<domain>.",
    );
  }
  const url = `${GRAPH_BASE}/invitations`;
  const body: Record<string, unknown> = {
    invitedUserEmailAddress: req.invitedUserEmailAddress,
    inviteRedirectUrl:
      req.inviteRedirectUrl?.trim() || "https://myapplications.microsoft.com",
    sendInvitationMessage: !!req.sendInvitationMessage,
  };
  if (req.invitedUserDisplayName) {
    body.invitedUserDisplayName = req.invitedUserDisplayName;
  }
  if (req.sendInvitationMessage && req.customizedMessageBody) {
    body.invitedUserMessageInfo = {
      customizedMessageBody: req.customizedMessageBody,
    };
  }
  const response = await graphFetch(
    url,
    {
      method: "POST",
      headers: graphHeaders(accessToken, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(body),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    },
    tenantId,
  );
  if (!response.ok) {
    throw await toGraphError(response);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const invitedUser =
    (data.invitedUser as Record<string, unknown> | undefined) ?? {};
  return {
    id: (data.id as string) ?? "",
    inviteRedeemUrl: (data.inviteRedeemUrl as string) ?? "",
    invitedUser: {
      id: (invitedUser.id as string) ?? "",
      userPrincipalName:
        (invitedUser.userPrincipalName as string | undefined) ?? undefined,
      displayName:
        (invitedUser.displayName as string | undefined) ?? undefined,
    },
    inviteRedirectUrl: (data.inviteRedirectUrl as string) ?? "",
    sendInvitationMessage: Boolean(data.sendInvitationMessage),
    status: (data.status as string | undefined) ?? undefined,
  };
}

export interface VerifiedDomain {
  name: string;
  isDefault: boolean;
  isInitial: boolean;
  type: string;
  capabilities: string;
}

/**
 * List the verified domains for the calling tenant via the
 * /organization endpoint. Filters to domains that can host user
 * accounts: those whose capabilities include "Email" or whose name
 * ends in ".onmicrosoft.com" (the initial tenant domain).
 */
export async function listVerifiedDomains(
  tenantId: string,
  accessToken: string,
): Promise<VerifiedDomain[]> {
  validateTenantId(tenantId);
  const url = `${GRAPH_BASE}/organization`;
  const response = await graphFetch(
    url,
    { headers: graphHeaders(accessToken) },
    tenantId,
  );
  if (!response.ok) {
    throw await toGraphError(response);
  }
  const data = (await response.json()) as {
    value?: Array<Record<string, unknown>>;
  };
  const orgs = Array.isArray(data.value) ? data.value : [];
  const first = orgs[0];
  if (!first) return [];
  const domains = Array.isArray(first.verifiedDomains)
    ? (first.verifiedDomains as Array<Record<string, unknown>>)
    : [];
  return domains
    .map<VerifiedDomain>((d) => ({
      name: (d.name as string) ?? "",
      isDefault: Boolean(d.isDefault),
      isInitial: Boolean(d.isInitial),
      type: (d.type as string) ?? "",
      capabilities: (d.capabilities as string) ?? "",
    }))
    .filter((d) => {
      if (!d.name) return false;
      const caps = d.capabilities.toLowerCase();
      if (caps.includes("email")) return true;
      if (d.name.toLowerCase().endsWith(".onmicrosoft.com")) return true;
      return false;
    });
}

/**
 * Map org principals to the Azure subscriptions they have access to, by
 * inspecting ARM role assignments tenant-wide. Each returned row is
 * `{ userId, subscriptionIds }` where `userId` is the principal's AAD object
 * id (so it joins directly against the `id` field from `listOrgUsers`).
 *
 * **Token audience:** despite living next to the Graph wrappers, this reads
 * Azure Resource Manager, so `armAccessToken` MUST be an ARM-audience token
 * (`https://management.azure.com/.default`) — NOT a Graph token. The thin
 * delegation to `listSubscriptionAccessByPrincipal` does the real work
 * (enumerate subscriptions → read role assignments per sub → group by
 * principal) using the caller's own admin token; no per-user sign-in.
 *
 * Returns `[]` on a total failure (e.g. the token can't list subscriptions)
 * so the UI degrades gracefully to "no subscription data" rather than erroring
 * the whole user list. Partial failures (some subs unreadable) still return
 * the principals that WERE resolvable.
 */
export async function listOrgSubscriptions(
  tenantId: string,
  armAccessToken: string,
  opts?: { signal?: AbortSignal },
): Promise<Array<{ userId: string; subscriptionIds: string[] }>> {
  validateTenantId(tenantId);
  try {
    const result = await listSubscriptionAccessByPrincipal(armAccessToken, {
      signal: opts?.signal,
    });
    return result.principals.map((p) => ({
      userId: p.principalId,
      subscriptionIds: p.subscriptionIds,
    }));
  } catch {
    // Total enumeration failure (can't even list subscriptions) — degrade to
    // empty so the user list still renders without sub counts.
    return [];
  }
}
