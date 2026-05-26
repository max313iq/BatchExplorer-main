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
import { DirectoryRole, GraphUser } from "./types";
export declare const ROLE_GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
export declare const ROLE_USER_ADMIN = "fe930be7-5e62-47db-91af-98c3a49a38b1";
export declare const ROLE_HELPDESK_ADMIN = "729827e3-9c14-49f7-bb1b-9608f156bbb8";
export declare const ROLE_AUTHENTICATION_ADMIN = "c4e39bd9-1100-46d3-8c65-fb160da0071f";
export declare const ROLE_PRIVILEGED_AUTH_ADMIN = "7be44c8a-adaf-4e2a-84d6-ab2649e08a13";
export declare const ROLE_GLOBAL_READER = "f2ef992c-3afb-46b9-b7cf-a126ee74c451";
export declare const ROLE_DIRECTORY_READER = "88d8e3e3-8f55-4a1e-953a-9b9898b8876b";
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
export declare function listOrgUsers(tenantId: string, accessToken: string, opts?: ListOrgUsersOptions): Promise<GraphUser[]>;
/**
 * Get directory role memberships for the calling user (`/me/memberOf`).
 * Filters to entries whose @odata.type is "#microsoft.graph.directoryRole".
 */
export declare function getMyDirectoryRoles(tenantId: string, accessToken: string): Promise<DirectoryRole[]>;
/**
 * Get directory role memberships for a specific user
 * (`/users/{id}/memberOf`).
 *
 * Note: prefer `getUserDirectoryRolesBatched` when looking up roles for
 * many users — it collapses N separate Graph calls into ceil(N/20) via
 * the JSON `$batch` endpoint. This single-user variant is kept for
 * call sites that only ever need one user.
 */
export declare function getUserDirectoryRoles(tenantId: string, userId: string, accessToken: string): Promise<DirectoryRole[]>;
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
export declare function getUserDirectoryRolesBatched(tenantId: string, userIds: string[], accessToken: string): Promise<Map<string, DirectoryRole[]>>;
/**
 * Reset a user's password via Microsoft Graph (PATCH /users/{id}).
 *
 * The caller must have one of the password-reset directory roles
 * (see canResetPasswords). Sensitive payload is never logged.
 */
export declare function resetUserPassword(tenantId: string, userId: string, newPassword: string, forceChangeNextSignIn: boolean, accessToken: string, opts?: {
    signal?: AbortSignal;
}): Promise<void>;
/**
 * Pure-function helper: returns true if the supplied roles include any
 * directory role that grants the ability to reset another user's
 * password.
 */
export declare function canResetPasswords(roles: DirectoryRole[]): boolean;
/**
 * Pure-function helper: returns true when the supplied directory roles
 * include one that can CREATE new users (NOT just reset passwords).
 * Helpdesk + Authentication Administrators are explicitly excluded —
 * they can only reset passwords, not create users.
 */
export declare function canCreateUsers(roles: DirectoryRole[]): boolean;
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
export declare function createUser(tenantId: string, req: CreateUserRequest, accessToken: string, opts?: {
    signal?: AbortSignal;
}): Promise<CreateUserResult>;
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
export declare function assignDirectoryRole(tenantId: string, userObjectId: string, roleTemplateId: string, accessToken: string, opts?: {
    signal?: AbortSignal;
}): Promise<{
    roleObjectId: string;
    alreadyMember: boolean;
}>;
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
export declare function getPrincipalsByIds(tenantId: string, objectIds: string[], accessToken: string): Promise<ResolvedPrincipal[]>;
/**
 * Resolve a UPN or email to a User object id via Graph. Returns
 * undefined when no exact match. Used by Sub Manager's "add by email"
 * flow so the operator doesn't have to look up GUIDs manually.
 */
export declare function findUserByUpnOrMail(tenantId: string, upnOrMail: string, accessToken: string): Promise<{
    id: string;
    displayName: string;
    upn: string;
} | undefined>;
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
export declare function inviteGuest(tenantId: string, req: InviteGuestRequest, accessToken: string, opts?: {
    signal?: AbortSignal;
}): Promise<InviteGuestResult>;
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
export declare function listVerifiedDomains(tenantId: string, accessToken: string): Promise<VerifiedDomain[]>;
/**
 * Best-effort mapping of org users to subscription count by inspecting
 * ARM role assignments. Computing this is expensive (one ARM call per
 * subscription, with N pages each), and Graph does not surface the data
 * directly. The signature is stable so the UI can render counts when
 * available; this initial implementation returns an empty array as a
 * conservative fallback that the UI can degrade gracefully against.
 *
 * Note: a full implementation would iterate the caller's accessible
 * subscriptions, list `Microsoft.Authorization/roleAssignments` per
 * subscription, group by `principalId`, and join with the user list
 * returned by `listOrgUsers`. That work is intentionally deferred to a
 * follow-up pass — keep callers using this signature so the upgrade is
 * non-breaking.
 */
export declare function listOrgSubscriptions(tenantId: string, _accessToken: string): Promise<Array<{
    userId: string;
    subscriptionIds: string[];
}>>;
//# sourceMappingURL=graph-service.d.ts.map