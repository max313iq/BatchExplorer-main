/**
 * Pure helpers for the Privileged Users & Shadow Admin Auditor page.
 *
 * Inspired by CyberArk's SkyArk: enumerate every principal that holds —
 * directly or transitively — a directory role in the tenant, classify
 * the role into a tier (Microsoft's privileged role tiering), and flag
 * "shadow admin" escalation paths that aren't obvious from the
 * Azure-portal "Roles & administrators" blade alone.
 *
 *   - Direct       — User assigned the role directly.
 *   - Group-       — A Group holds the role; every transitive member of
 *      mediated      the group inherits it. SkyArk catches these because
 *                    operators rarely inspect group memberships.
 *   - Service      — A Service Principal (managed identity / app SPN)
 *      principal     holds the role. High-blast-radius if the app is
 *                    third-party or has wide API permissions.
 *   - Guest        — An external user (`#EXT#` in UPN) holding a
 *                    Tier 0/1 role. Cross-tenant privileged access often
 *                    survives departure from the partner organization.
 *
 * All exports are pure / side-effect-free so the page can unit-test
 * tier classification and shadow-admin detection without spinning up a
 * Graph mock.
 */
export type RoleTier = "tier0" | "tier1" | "tier2" | "tier3" | "other";
export interface TierMeta {
    /** Display label shown on the badge / chip. */
    label: string;
    /** Short description used in tooltips and the legend. */
    description: string;
    /** Sort weight, smaller = more privileged. */
    order: number;
    /** Badge variant (matches shared `<Badge>` variants). */
    badgeVariant: "destructive" | "warning" | "info" | "secondary" | "outline";
    /** Tone for `<SummaryStatItem>` (matches `SummaryStatTone`). */
    statTone: "destructive" | "warning" | "info" | "success" | "muted";
}
export declare const TIER_META: Record<RoleTier, TierMeta>;
/**
 * Classify a directory role into one of the four tiers. Falls back to
 * `"other"` for unknown roles so the UI never crashes when Microsoft
 * adds a new built-in role between releases.
 */
export declare function classifyRole(roleTemplateId: string | undefined, displayName: string | undefined): RoleTier;
/**
 * True when the role's template id matches Privileged Role Administrator —
 * a role that can grant Global Administrator to any principal. SkyArk
 * flags this as a "stealth Global Admin" because the holder doesn't
 * appear in the Global Admin list itself.
 */
export declare const ROLE_PRIVILEGED_ROLE_ADMIN = "e8611ab8-c189-46e8-94e1-60213ab1f814";
export declare function isPrivilegedRoleAdmin(templateId: string | undefined): boolean;
export type PrincipalType = "User" | "Group" | "ServicePrincipal" | "Unknown";
export type AssignmentPath = "direct" | "group" | "sp" | "guest";
export interface AssignmentPathMeta {
    label: string;
    description: string;
    badgeVariant: "secondary" | "warning" | "info" | "destructive";
}
export declare const ASSIGNMENT_PATH_META: Record<AssignmentPath, AssignmentPathMeta>;
/**
 * One slot in a principal's per-role assignment list. A given principal
 * can hold the same role through multiple paths simultaneously — e.g.
 * "User Admin direct AND Helpdesk via group X" — and we list each one
 * separately so the operator can see exactly how the privilege flows.
 */
export interface AssignmentDetail {
    roleId: string;
    roleTemplateId: string;
    roleDisplayName: string;
    tier: RoleTier;
    path: AssignmentPath;
    /** When path = "group", the source group's display name. */
    viaGroupName?: string;
    /** When path = "group", the source group's object id. */
    viaGroupId?: string;
}
export interface PrivilegedPrincipal {
    id: string;
    type: PrincipalType;
    displayName: string;
    /** UPN (users), appId (SPs), mail (groups when populated). */
    signInName?: string;
    /** Optional `accountEnabled` from Graph (users + SPs only). */
    enabled?: boolean;
    /** True when the user's UPN contains the `#EXT#` guest sentinel. */
    isExternal: boolean;
    /** Every role this principal holds, deduped on (roleId, path, viaGroupId). */
    assignments: AssignmentDetail[];
    /** Highest tier across all assignments (lowest numeric `order`). */
    topTier: RoleTier;
    /** True when at least one assignment is non-direct. */
    isShadowAdmin: boolean;
    /** True when any assignment path is "sp". */
    isServicePrincipal: boolean;
    /** Optional `createdDateTime` (SPs). */
    createdDateTime?: string;
}
/**
 * One escalation path the auditor wants to highlight. Format:
 *
 *   <principal>  →  <via group / SP / cross-tenant>  →  <role @ tier>
 *
 * Multiple paths per principal are common (e.g. "Alice via group GA-Owners",
 * "Alice via group EmergencyBreakGlass") — keep them as separate rows so
 * the operator can audit each link independently.
 */
export interface ShadowAdminPath {
    /** Stable key for React lists / Set-based dedup. */
    id: string;
    principalId: string;
    principalDisplayName: string;
    principalType: PrincipalType;
    principalSignInName?: string;
    path: AssignmentPath;
    /** Human-readable mid-segment ("via group X", "is a guest", etc.). */
    via: string;
    viaGroupId?: string;
    viaGroupName?: string;
    roleId: string;
    roleTemplateId: string;
    roleDisplayName: string;
    tier: RoleTier;
}
/**
 * True when the UPN looks like a B2B guest. The canonical guest UPN
 * shape is `<displayemail>_<homedomain>#EXT#@<thistenant>.onmicrosoft.com`
 * so the `#EXT#` substring is a reliable signal.
 */
export declare function isExternalUpn(upn: string | undefined | null): boolean;
/**
 * Pick the principal's "highest-privilege" tier across all its
 * assignments. Returns "other" if the principal has no assignments.
 */
export declare function highestTier(assignments: AssignmentDetail[]): RoleTier;
/**
 * True when the assignment list constitutes a "shadow admin" path —
 * i.e. anything that's not a plain Direct user assignment. SP and
 * Group paths both qualify; Guest-Direct also qualifies because the
 * principal is external.
 */
export declare function hasShadowAdminPath(assignments: AssignmentDetail[], isExternal: boolean): boolean;
/**
 * Compose a deep link into the Azure portal that opens the principal's
 * Entra-ID profile blade in the correct tenant. Works for users; for
 * groups + SPs we degrade to the directory-object lookup which the
 * portal will resolve into the appropriate blade.
 */
export declare function portalDeepLink(tenantId: string, principal: Pick<PrivilegedPrincipal, "id" | "type">): string;
export interface PrivilegedGroup {
    id: string;
    displayName: string;
    /** Roles the group directly holds. */
    roles: Array<{
        roleId: string;
        roleTemplateId: string;
        roleDisplayName: string;
        tier: RoleTier;
    }>;
    /** Distinct transitive member count (users only — ignore nested groups). */
    transitiveUserCount: number;
    /** Distinct transitive members of any type (users, sub-groups, SPs). */
    transitiveTotalCount: number;
    /** Highest tier across the roles the group holds. */
    topTier: RoleTier;
    /** Resolved transitive-member principal ids (for the expand-row UI). */
    transitiveMemberIds: string[];
}
/**
 * True when a group is a "high blast radius" target — Tier 0 role
 * AND > `threshold` transitive members. Default threshold matches the
 * spec (10).
 */
export declare function isHighBlastRadiusGroup(group: PrivilegedGroup, threshold?: number): boolean;
/** Tier-then-name sort comparator used by the privileged-identity list. */
export declare function compareByTierThenName(a: PrivilegedPrincipal, b: PrivilegedPrincipal): number;
/**
 * Stale-membership window. A principal whose newest known activity timestamp
 * (we use `createdDateTime` for SPs as the best-available proxy) is older
 * than this is flagged as "stale" by the operator filter chip. Matches the
 * SkyArk / MicroBurst "90-day inactive admin" heuristic.
 *
 * Note: Graph's `signInActivity` endpoint would give us a true last-sign-in
 * stamp, but it requires `AuditLog.Read.All` which we deliberately do NOT
 * demand — the page degrades to "createdDateTime > 90d ago" for SPs and
 * shows "unknown" for everyone else.
 */
export declare const STALE_THRESHOLD_MS: number;
/**
 * Numerical risk score for sorting. Higher = more privileged.
 *
 * Composition:
 *   - 1000 per Tier-0 role (irreducible — one is enough to dominate).
 *   - 100 per Tier-1 role.
 *   - 10 per Tier-2 role.
 *   - 1 per Tier-3 role.
 *   - +500 if the principal is a guest holding any T0/T1 role.
 *   - +200 if any assignment is non-direct (shadow-admin lift).
 *   - +50 if the principal is a service principal.
 *
 * The score is deliberately bucketed (powers of ten between tiers) so it
 * always ranks T0 above any number of T3 holders, no matter how many.
 */
export declare function riskScore(principal: PrivilegedPrincipal, signalLift?: number): number;
/**
 * Lookup-driven comparator factory. Sorts highest-risk principals first
 * while accounting for the corpus-signal uplift the caller already
 * computed per principal. When no lookup is provided behaves identically
 * to `compareByRiskScore`.
 *
 * Citation rationale: `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender
 * Audit Surface" — active indicators outweigh static role tier.
 */
export declare function compareByRiskScoreWithSignals(signalLiftById: ReadonlyMap<string, number>): (a: PrivilegedPrincipal, b: PrivilegedPrincipal) => number;
/**
 * Risk-then-name comparator. Sorts highest-risk principals first.
 */
export declare function compareByRiskScore(a: PrivilegedPrincipal, b: PrivilegedPrincipal): number;
/**
 * Best-effort "stale" heuristic. Returns true when:
 *   - For SPs: `createdDateTime` is older than `STALE_THRESHOLD_MS`.
 *   - For Users: no signInName (orphaned / partially-resolved) AND not a
 *     guest. Guests are intentionally excluded because we already flag
 *     them via the `isExternal` channel.
 *
 * When we can't make a confident determination (no timestamp, no name
 * shape), we conservatively return false to avoid hiding fresh principals.
 */
export declare function isStalePrincipal(principal: PrivilegedPrincipal, now?: number): boolean;
/**
 * Portal deep-link to the "Assignments" blade of a specific directory role.
 * Useful for "open this role in the portal" affordances next to the role
 * chip in the expanded assignment-detail list.
 */
export declare function roleDeepLink(tenantId: string, roleId: string): string;
/**
 * Microsoft Graph SP app-id (well-known). Holding any "RW" Graph app-role
 * on this principal is the canonical takeover lever — see
 * `_bypass_role_grant.md` §3.1 "Application.ReadWrite.All → app-only GA".
 */
export declare const MICROSOFT_GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
/**
 * App-role (Graph permission) ids on the Microsoft Graph SP that, when
 * held by any third-party SP, light up the canonical
 *   `Application.ReadWrite.All` → `addKey` on Graph SP → app-only GA
 * chain. These are the well-known appRoleId GUIDs Microsoft publishes on
 * the Graph manifest.
 *
 * Citation (chain end-to-end):
 *   `_bypass_role_grant.md` §3.1, §3.2, §3.3
 *   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #23
 *
 * Tooling references (curated index):
 *   - `dafthack/GraphRunner/GraphRunner.ps1`  — `Invoke-InjectOAuthApp`
 *   - `Gerenios/AADInternals/MSGraphAPI.ps1`  — `New-AADIntApplication`
 *   - `dirkjanm/ROADtools/roadlib/auth.py`    — FOCI / app-role enumeration
 */
export declare const HIGH_PRIV_GRAPH_APP_ROLES: ReadonlyMap<string, string>;
/**
 * Window for "recent" credential-write detection on a privileged SP.
 * Anything added inside this window is flagged as "addKey/addPassword
 * sentinel" — matches Defender audit item 5 in the master playbook.
 */
export declare const RECENT_CREDENTIAL_WINDOW_MS: number;
/**
 * Window for "recent" TAP issuance to a privileged user. The master
 * playbook (item 3) treats this as the critical Defender audit signal
 * for "Issue temporary access pass".
 */
export declare const RECENT_TAP_WINDOW_MS: number;
/**
 * OIDC issuer hosts that the corpus flags as "public clouds where a
 * federated credential maps to a low-trust principal". Pointing a
 * privileged SP at one of these is the WIF backdoor pattern from
 * `_bypass_tenant_switch.md` / `_bypass_role_grant.md` §6.
 */
export declare const PUBLIC_FEDERATION_ISSUER_HOSTS: ReadonlyArray<string>;
/**
 * Well-known role template id for "Directory Synchronization Accounts" — the
 * role that AAD Connect Sync's cloud-side service account holds by design.
 * Holders of THIS role are expected to be a Sync_* SP; holders of any OTHER
 * privileged role with a sync-account-shaped name are the drift indicator.
 */
export declare const ROLE_DIRECTORY_SYNC_ACCOUNTS = "d29b2b05-8046-44ba-8758-1e26182fcf32";
/**
 * True when the principal looks like an AAD Connect / Cloud Sync service
 * account based on its display name OR sign-in name (UPN / appId).
 */
export declare function looksLikeSyncAccount(displayName: string | undefined, signInName: string | undefined): boolean;
/**
 * One sync-account drift finding for Signal E. A finding is built when a
 * sync-account-shaped principal holds ANY role other than (or in addition to)
 * the canonical "Directory Synchronization Accounts" role.
 */
export interface SyncAccountFinding {
    id: string;
    /** Sync-account principal id. */
    principalId: string;
    /** Resolved display name (e.g. "Sync_AAD_abc123"). */
    principalDisplayName: string;
    /** Sign-in name / UPN (best-effort). */
    principalSignInName?: string;
    /** Principal type (usually User for AAD Connect, ServicePrincipal for Cloud Sync). */
    principalType: PrincipalType;
    /** Every role the sync account holds. */
    roles: Array<{
        roleTemplateId: string;
        roleDisplayName: string;
        tier: RoleTier;
        /** True when this is the canonical Directory Sync Accounts role. */
        isCanonical: boolean;
    }>;
    /** True when at least one role is NOT the canonical sync role — drift. */
    hasDriftRole: boolean;
    /** Highest non-canonical tier (for severity). */
    topDriftTier: RoleTier;
}
/**
 * Severity for a sync-account finding. A sync account holding the canonical
 * Directory Sync Accounts role only is informational; any additional T0 role
 * is critical; T1/T2 are high/medium.
 *
 * Citation: `_AZURE_BYPASS_PLAYBOOK.md` #19 — the corpus framing is that a
 * compromised sync account is "bidirectional forest control", so we lift
 * severity aggressively when ANY non-canonical privileged role is held.
 */
export declare function gradeSyncAccount(finding: SyncAccountFinding): FindingSeverity;
/**
 * Coincidence window for the mixed-chain detector. Anything tighter than 24h
 * is the corpus "kill-chain firing" signature.
 */
export declare const MIXED_CHAIN_WINDOW_MS: number;
/**
 * One mixed-chain finding. `indicators` lists each contributing signal's
 * grade so the operator can click straight through to the source row.
 */
export interface MixedChainFinding {
    id: string;
    principalId: string;
    principalDisplayName: string;
    principalSignInName?: string;
    principalType: PrincipalType;
    principalTier: RoleTier;
    /** Each contributing signal (chronological). */
    indicators: Array<{
        /** Which signal letter contributed. */
        signal: "A" | "B" | "C" | "D";
        /** When the signal's underlying event occurred (best-effort). */
        at: string;
        /** Short human-readable description (for the chain summary row). */
        label: string;
        /** Per-indicator severity. */
        severity: FindingSeverity;
    }>;
    /** Computed composite severity. */
    severity: FindingSeverity;
    /** Time-span between earliest and latest indicator (ms). */
    spanMs: number;
}
/**
 * Build mixed-chain findings from the four single-signal sets. Each input
 * is the already-graded finding array; we collapse them into per-principal
 * indicator streams and emit a MixedChainFinding when ≥ 2 indicators fall
 * inside MIXED_CHAIN_WINDOW_MS.
 *
 * Pure: returns sorted findings, no I/O.
 */
export declare function buildMixedChainFindings(highPrivGraphPermissions: ReadonlyArray<HighPrivGraphPermissionFinding>, federatedCredentials: ReadonlyArray<FederatedCredentialFinding>, pimEligibilities: ReadonlyArray<PimEligibilityFinding>, tapIssuances: ReadonlyArray<TapIssuanceFinding>, principalIndex: ReadonlyMap<string, PrivilegedPrincipal>, windowMs?: number): MixedChainFinding[];
export interface PimGroupEligibilityFinding {
    id: string;
    /** Eligible principal id (user or SP). */
    principalId: string;
    principalDisplayName?: string;
    principalSignInName?: string;
    principalType: PrincipalType;
    /** The role-assignable group the principal is eligible to activate into. */
    groupId: string;
    groupDisplayName: string;
    /** True when the group is marked isAssignableToRole. */
    isAssignableToRole: boolean;
    /** Roles the group itself directly holds (resolved from rolesByGroup). */
    groupRoles: Array<{
        roleTemplateId: string;
        roleDisplayName: string;
        tier: RoleTier;
    }>;
    /** Highest tier across the group's roles. */
    topTier: RoleTier;
    /** Eligibility kind. */
    expirationKind: PimExpirationKind;
    endDateTime?: string;
    duration?: string;
    createdDateTime?: string;
    /** True when noExpiration AND the group holds a T0 role. */
    isCriticalTimeBomb: boolean;
}
/**
 * Severity for a PIM-for-Groups finding. noExpiration + T0 group = critical;
 * any T0 group = high; T1 group = medium; otherwise info.
 */
export declare function gradePimGroupEligibility(finding: PimGroupEligibilityFinding): FindingSeverity;
/**
 * Best-effort parse of an OIDC issuer URL down to its hostname. Tolerates
 * issuers stored without a scheme (some tenants record `github.com` not
 * `https://github.com`).
 */
export declare function issuerHost(issuer: string | undefined | null): string;
/**
 * True when `issuer` resolves to a host in PUBLIC_FEDERATION_ISSUER_HOSTS.
 * Used by Signal B grading.
 */
export declare function isPublicFederationIssuer(issuer: string | undefined | null): boolean;
/**
 * Citation: `_bypass_role_grant.md` §3.1 (canonical chain), §3.2
 *           `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface" #5
 */
export interface HighPrivGraphPermissionFinding {
    /** Stable React-list key. */
    id: string;
    /** SP object id (servicePrincipalId, *not* appId). */
    servicePrincipalId: string;
    /** SP `displayName`. */
    servicePrincipalDisplayName: string;
    /** SP `appId` (multi-tenant app's client id). */
    appId?: string;
    /** Sign-in audience (`AzureADMyOrg`, `AzureADMultipleOrgs`, etc.). */
    signInAudience?: string;
    /** When the SP itself was created. */
    servicePrincipalCreatedDateTime?: string;
    /** Each high-privilege Graph permission this SP holds. */
    permissions: Array<{
        /** appRoleAssignment id, for portal deep-linking. */
        assignmentId: string;
        /** The well-known appRoleId GUID on the Graph SP. */
        appRoleId: string;
        /** Friendly permission name (e.g. `Application.ReadWrite.All`). */
        permissionName: string;
        /** When the role was granted to this SP. */
        createdDateTime?: string;
    }>;
    /** Total `passwordCredentials` count (app or SP shape). */
    passwordCredentialCount: number;
    /** Total `keyCredentials` count (app or SP shape). */
    keyCredentialCount: number;
    /** True when ANY credential was created within RECENT_CREDENTIAL_WINDOW_MS. */
    hasRecentCredential: boolean;
    /** Most-recent credential creation timestamp (across pwd + key). */
    mostRecentCredentialAt?: string;
}
/**
 * Citation: `_bypass_role_grant.md` §6 "Workload Identity Federation as Role-Grant Bypass"
 *           `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #17
 */
export interface FederatedCredentialFinding {
    id: string;
    servicePrincipalId: string;
    servicePrincipalDisplayName: string;
    /** Object id of the parent application object (federated creds live on
     *  `/applications/{id}/federatedIdentityCredentials`, not on SP). */
    applicationObjectId?: string;
    /** Friendly federated-credential name. */
    name: string;
    issuer: string;
    subject: string;
    audiences: string[];
    /** True when the issuer host matches PUBLIC_FEDERATION_ISSUER_HOSTS. */
    isPublicIssuer: boolean;
}
/**
 * Citation: `_bypass_staged_pim.md` §2 + §5.1 "The 'time bomb'"
 *           `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #27
 *
 * Detection rule: any roleEligibility schedule with
 * `scheduleInfo.expiration.type === "noExpiration"` on a Tier-0 role is
 * critical — that is exactly the stealth-persistence shape the playbook
 * teaches.
 */
export type PimExpirationKind = "noExpiration" | "afterDateTime" | "afterDuration" | "unknown";
export interface PimEligibilityFinding {
    id: string;
    /** Principal object id. */
    principalId: string;
    /** Resolved principal display name (when getByIds returned it). */
    principalDisplayName?: string;
    /** Resolved principal sign-in name (UPN / appId). */
    principalSignInName?: string;
    /** Principal type discriminator. */
    principalType: PrincipalType;
    /** Directory role template id (e.g. Global Admin GUID). */
    roleTemplateId: string;
    /** Role display name when joinable. */
    roleDisplayName?: string;
    /** Tier classification, used for risk weighting. */
    tier: RoleTier;
    /** Eligibility expiration shape. */
    expirationKind: PimExpirationKind;
    /** When `afterDateTime`, the explicit endDateTime. */
    endDateTime?: string;
    /** When `afterDuration`, the ISO-8601 duration (e.g. `PT8H`). */
    duration?: string;
    /** When the eligibility schedule was created. */
    createdDateTime?: string;
    /** True for `noExpiration` on Tier-0 — the critical case. */
    isCriticalTimeBomb: boolean;
}
/**
 * Citation: `_bypass_login.md` (TAP issuance) +
 *           `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface" #3
 *           Top-30 #13 "TAP issuance via Auth Admin = MFA-equivalent pass"
 */
export interface TapIssuanceFinding {
    id: string;
    /** Privileged-user object id. */
    userId: string;
    /** User display name (best-effort). */
    userDisplayName: string;
    /** User principal name (best-effort). */
    userPrincipalName?: string;
    /** Top tier across the user's privileged-role holdings. Drives severity. */
    userTier: RoleTier;
    /** TAP method id. */
    tapId: string;
    /** When the TAP was issued (becomes valid). */
    startDateTime?: string;
    /** TAP lifetime in minutes. */
    lifetimeInMinutes?: number;
    /** Whether the TAP can be used right now. */
    isUsable?: boolean;
    /** Why it's usable / not usable (Graph-provided string). */
    methodUsabilityReason?: string;
    /** True when issued within RECENT_TAP_WINDOW_MS to a T0/T1 principal. */
    isRecentToTierZero: boolean;
}
export type FindingSeverity = "critical" | "high" | "medium" | "info";
export interface SeverityMeta {
    label: string;
    description: string;
    badgeVariant: "destructive" | "warning" | "info" | "secondary";
}
export declare const SEVERITY_META: Record<FindingSeverity, SeverityMeta>;
/**
 * Severity for a Signal-A finding (high-privilege Graph permissions on SP).
 *
 * - critical when there's a recent credential ON TOP OF Application.RW.All
 *   or RoleManagement.RW.Directory (the canonical chain about to fire).
 * - high when the SP holds a chainable permission set.
 * - medium otherwise (single permission, no recent cred).
 */
export declare function gradeHighPrivGraphPermission(finding: HighPrivGraphPermissionFinding): FindingSeverity;
/**
 * Severity for a Signal-B finding (federated credentials).
 *
 * Public OIDC issuer on a high-privilege SP is the WIF backdoor shape —
 * `_bypass_role_grant.md` §6. Tagged "high" by default; "critical" when
 * combined with a recent credential add on the same SP (caller passes
 * `companionAddKeyRecent`).
 */
export declare function gradeFederatedCredential(finding: FederatedCredentialFinding, companionAddKeyRecent: boolean): FindingSeverity;
/**
 * Severity for a Signal-C finding (PIM eligibility).
 *
 * `noExpiration` on Tier-0 is the time-bomb pattern from
 * `_bypass_staged_pim.md` §5.1 — always critical.
 */
export declare function gradePimEligibility(finding: PimEligibilityFinding): FindingSeverity;
/**
 * Severity for a Signal-D finding (recent TAP).
 *
 * A TAP issued to a Tier-0 principal in the last 30 days is the canonical
 * "MFA-equivalent persistence pass" pattern — `_AZURE_BYPASS_PLAYBOOK.md`
 * item 3.
 */
export declare function gradeTapIssuance(finding: TapIssuanceFinding): FindingSeverity;
/**
 * Per-signal risk uplift folded into the matrix scoring so flagged
 * principals sort up the privileged-identity list. Each weight is
 * deliberately bucketed (powers-of-ten between severities) so a single
 * critical indicator always outranks any pile of mediums.
 *
 * The numbers below intentionally land between the existing T0 (1000)
 * and T1 (100) tiers used by `riskScore` so a critical indicator on a
 * Tier-1 principal still escalates above a Tier-0 with no findings —
 * matching the corpus framing where active indicators of compromise
 * trump static role tier.
 */
export declare const SIGNAL_RISK_WEIGHTS: Record<FindingSeverity, number>;
/**
 * localStorage key prefix for the watchlist. Tenant-id is appended so each
 * tenant maintains its own list. Schema versioned via usePersistedState.
 */
export declare const TIER0_WATCHLIST_STORAGE_KEY_PREFIX = "privileged-audit:watchlist";
/**
 * One entry in the operator watchlist. Includes the human-meaningful
 * display name AND sign-in name at the moment of addition so the operator
 * can identify the principal even if it's later deleted (the only id left
 * would otherwise be an object guid).
 */
export interface WatchlistEntry {
    principalId: string;
    /** Display name at the moment of addition. */
    capturedDisplayName: string;
    /** Sign-in name (UPN / appId) at the moment of addition. */
    capturedSignInName?: string;
    /** Tier at the moment of addition (for drift detection). */
    capturedTier: RoleTier;
    /** ISO timestamp when the operator added the entry. */
    addedAt: string;
    /** Optional operator note (e.g. "break-glass account — expected"). */
    note?: string;
}
/**
 * Persistent shape on disk. Schema-versioned (`v: 1`) via usePersistedState so
 * future shape changes can migrate cleanly.
 */
export interface WatchlistState {
    entries: WatchlistEntry[];
}
export declare const EMPTY_WATCHLIST: WatchlistState;
/**
 * Drift kinds the watchlist drift-detector emits when comparing a previous
 * watchlist snapshot against the current probe.
 */
export type WatchlistDriftKind = "missing" | "tier-up" | "tier-down" | "new-role" | "role-removed" | "unchanged";
export interface WatchlistDrift {
    entry: WatchlistEntry;
    /** Resolved principal from the current dataset (undefined when missing). */
    current?: PrivilegedPrincipal;
    kind: WatchlistDriftKind;
    /** Human-readable explanation, e.g. "Tier T1 → T0". */
    explanation: string;
}
/**
 * Compute the drift kind for each watchlist entry against the current probe.
 * Roles are compared by template id; tier is compared by `TIER_META.order`.
 *
 * Pure: no side effects, no I/O.
 */
export declare function computeWatchlistDrift(watchlist: WatchlistState, currentPrincipals: ReadonlyArray<PrivilegedPrincipal>, capturedRolesByPrincipalId: ReadonlyMap<string, ReadonlySet<string>>): WatchlistDrift[];
/**
 * Audit-log action prefix the watchlist + critical-findings UI use so other
 * pages can correlate. Stable string so any "audit log" page can `startsWith`
 * to filter privileged-audit events.
 */
export declare const PRIVILEGED_AUDIT_ACTION_PREFIX = "privileged_audit_";
//# sourceMappingURL=privileged-audit-helpers.d.ts.map