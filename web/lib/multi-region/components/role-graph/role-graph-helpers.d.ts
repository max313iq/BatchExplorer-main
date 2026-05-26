/**
 * Pure helpers for the Role Assignment Visualizer (role-graph) page.
 *
 * Design intent: this file is the DEFENSIVE-USE knowledge base — what
 * constitutes a privileged role, what escalation patterns look like,
 * how scopes are classified. The page consumes these helpers but
 * contains no privilege logic of its own, so unit tests (future) can
 * cover the classification matrix in isolation.
 *
 * Sources:
 *   - Stormspotter (Microsoft Azure Red Team graph tool) — relationships
 *     it models: principal → role → scope, group → member → role.
 *     https://github.com/Azure/Stormspotter
 *   - Azure Built-in Roles reference (Microsoft Learn):
 *     https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
 *   - The well-known guid list for Owner / User Access Administrator /
 *     Contributor / RBAC Admin / Reservations Admin matches `az role
 *     definition list --name "Owner"`-style output and is stable across
 *     all commercial + national clouds.
 *
 * Scope: classification is intentionally CONSERVATIVE — false positives
 * (something flagged Tier 0 that's actually Tier 1) are tolerable, false
 * negatives (a real Owner that we display as a Reader) are not. Custom
 * roles are evaluated by parsing their `permissions[].actions` arrays
 * for the wildcard / authorization patterns that grant role-assignment
 * write capability.
 */
/**
 * The four tiers a role can fall into for defensive auditing.
 *
 * The labels follow the SAW / tier-0 vocabulary used by Microsoft's own
 * "Securing Privileged Access" guidance — `critical` ≈ tier-0 break-glass,
 * `privileged` ≈ tier-1 admin, `write` ≈ tier-2 contributor-class,
 * `readonly` ≈ tier-3 read-only.
 */
export type PrivilegeTier = "critical" | "privileged" | "write" | "readonly";
/** Display-friendly metadata for each tier. UI maps directly to badges. */
export interface PrivilegeTierMeta {
    tier: PrivilegeTier;
    label: string;
    /** Maps to existing Badge variants in `@/components/ui/badge`. */
    badgeVariant: "destructive" | "warning" | "secondary" | "outline";
    /** Short one-liner used in tooltips. */
    description: string;
    /** Sort order — lower = more dangerous. */
    order: number;
}
export declare const PRIVILEGE_TIER_META: Record<PrivilegeTier, PrivilegeTierMeta>;
/**
 * Well-known role-definition GUIDs that grant tier-0 (critical) access.
 *
 * These are stable across all Azure commercial / sovereign clouds and
 * match Microsoft's built-in role catalogue. Lowercase for case-
 * insensitive comparison via `.toLowerCase()` in callers.
 */
export declare const TIER_0_ROLE_GUIDS: Set<string>;
/**
 * One role definition as the helpers need to see it. Mirrors the ARM
 * /roleDefinitions response shape but trimmed to the fields the tier
 * classifier reads.
 */
export interface RoleDefinitionForTier {
    /** Role definition GUID (the `name` field on the ARM resource). */
    id: string;
    /** Friendly role name, e.g. "Owner". */
    name: string;
    /** "BuiltInRole" | "CustomRole" | string. */
    type?: string;
    /** Optional permissions array — when present, custom roles are tiered
     *  by parsing their `actions` patterns. Without this, only built-in
     *  GUIDs can be classified as critical / privileged. */
    permissions?: Array<{
        actions: string[];
        notActions?: string[];
        dataActions?: string[];
        notDataActions?: string[];
    }>;
}
/**
 * Classify a single role into a privilege tier.
 *
 * Decision order (highest tier wins):
 *   1. GUID is a known Tier-0 built-in (Owner, UAA, RBAC Admin, Reservations).
 *   2. GUID is Contributor AND scope is subscription / management group.
 *   3. Permissions array contains a PRIVILEGED_ACTION_PATTERNS hit.
 *   4. Role name contains "owner"/"administrator"/"contributor" (fallback
 *      for cases where the permissions array isn't available).
 *   5. Permissions array contains a WRITE_ACTION_PATTERNS hit.
 *   6. Role name is "Reader"/"Viewer"/"Monitoring Reader" → readonly.
 *   7. Default: write.
 *
 * The `scope` argument is the ARM scope path of the role ASSIGNMENT — we
 * need it to distinguish Contributor-at-sub-scope (critical) from
 * Contributor-at-rg-scope (write).
 */
export declare function classifyRoleTier(def: RoleDefinitionForTier | undefined, roleGuid: string, scope: string): PrivilegeTier;
/**
 * The "level" a role-assignment scope sits at. Drives:
 *   - The Contributor-at-sub-scope critical promotion in `classifyRoleTier`.
 *   - The scope chip rendered next to each assignment in the UI.
 *   - The "scope" filter chips on the page (subscription / RG / resource).
 */
export type ScopeLevel = "tenant" | "managementGroup" | "subscription" | "resourceGroup" | "resource" | "unknown";
/**
 * Inspect a scope string and tell me which level it lives at. Defensive
 * against weird casing (`resourcegroups` vs `resourceGroups`) and root
 * `/` (tenant scope used by some cross-tenant grants).
 */
export declare function classifyScopeLevel(scope: string): ScopeLevel;
/** Human-friendly label for a scope (for the chip next to each assignment). */
export declare function describeScope(scope: string): string;
/**
 * Categories of escalation surface this page surfaces. Stormspotter
 * exposes many more in the original tool — this set is the headline 3
 * that matter for a defensive subscription-scope audit:
 *
 *   - `direct` — principal IS Owner / UAA at sub scope → can self-grant
 *     anything to anyone (no further hops needed).
 *   - `groupMediated` — principal inherits Tier-0 via group membership.
 *     One layer of indirection but identical blast radius once the
 *     attacker pivots through the group.
 *   - `crossTenantGuest` — principal is a B2B guest (UPN includes `#EXT#`)
 *     AND holds Tier-0 / Tier-1 access. Worth flagging because guest
 *     accounts often outlive their justification window and the home
 *     tenant of the guest is outside this admin's control.
 */
export type EscalationCategory = "direct" | "groupMediated" | "crossTenantGuest";
/** One escalation finding tied to a single principal. */
export interface EscalationFinding {
    category: EscalationCategory;
    /** One-line headline for the alert row. */
    headline: string;
    /** Expanded explanation rendered inside the expand panel. */
    detail: string;
    /** Optional secondary principal id (the group, for group-mediated). */
    viaPrincipalId?: string;
    /** Optional friendly name for the via-principal. */
    viaDisplayName?: string;
}
/**
 * Detect every UPN-style EXT marker that B2B guests carry. The Azure AD
 * convention is `<original_user>#EXT#@<host_tenant>.onmicrosoft.com`
 * but we also match the rare `_ext_` lowercase variant Graph sometimes
 * emits on PATCHed UPNs.
 */
export declare function isGuestUpn(upn: string | undefined | null): boolean;
/**
 * A single role assignment as the page consumes it, with everything
 * needed to render and classify. Built from the joined output of
 * `listSubscriptionRoleAssignments` + `getPrincipalsByIds` +
 * `listSubscriptionRoleDefinitions`.
 */
export interface PrincipalAssignment {
    /** Full ARM resource id of the role assignment. */
    assignmentId: string;
    /** Role-definition GUID. */
    roleDefinitionId: string;
    /** Friendly role name (resolved via the role-definitions catalogue). */
    roleName: string;
    /** Tier classification (precomputed). */
    tier: PrivilegeTier;
    /** Full scope of the assignment. */
    scope: string;
    /** "tenant" | "managementGroup" | ... */
    scopeLevel: ScopeLevel;
    /** True when scope == the subscription scope the operator queried. */
    atSubScope: boolean;
    /** ISO createdOn timestamp from ARM, if present. */
    createdOn?: string;
    /** Subscription this assignment was discovered under (for multi-sub probes). */
    subscriptionId: string;
    /** Subscription display name (echoed for export friendliness). */
    subscriptionDisplayName?: string;
}
/** Grouped view: every assignment for one principal, plus computed flags. */
export interface PrincipalSummary {
    principalId: string;
    principalType: string;
    displayName: string;
    signInName?: string;
    /** True when the UPN carries the `#EXT#` guest marker. */
    isGuest: boolean;
    /** All role assignments held by this principal across all probed subs. */
    assignments: PrincipalAssignment[];
    /** Highest (= most dangerous) tier across `assignments`. */
    highestTier: PrivilegeTier;
    /** Number of assignments. */
    assignmentCount: number;
    /** Escalation findings computed against the assignment set. */
    escalations: EscalationFinding[];
    /** True when ANY escalation finding fires. */
    hasEscalation: boolean;
    /** When this is a group principal, the resolved transitive members. */
    groupMembers?: ResolvedGroupMember[];
}
/** Member of a group, resolved via `groups/{id}/transitiveMembers`. */
export interface ResolvedGroupMember {
    id: string;
    displayName: string;
    type: string;
    signInName?: string;
}
/**
 * Compute the highest (= most dangerous = lowest numeric order) tier
 * across an array of assignments.
 */
export declare function highestTierOf(assignments: ReadonlyArray<PrincipalAssignment>): PrivilegeTier;
/**
 * Group raw role assignments by principal id, compute the summary
 * fields (highest tier, guest flag, escalations).
 *
 * `principalLookup` provides resolved display names. `groupMembersByGroupId`
 * is the (optional) Map<groupId, members[]> from the transitiveMembers
 * Graph probe; it powers the group-mediated escalation detection. When
 * absent (permission failure, or skip-on-error), group-mediated checks
 * are silently skipped — direct + cross-tenant findings still surface.
 */
export interface GroupAssignmentInputs {
    assignments: ReadonlyArray<PrincipalAssignment & {
        principalId: string;
        principalType: string;
    }>;
    principalLookup: Map<string, {
        displayName: string;
        type: string;
        signInName?: string;
    }>;
    groupMembersByGroupId?: Map<string, ResolvedGroupMember[]>;
}
export declare function groupByPrincipal(inputs: GroupAssignmentInputs): PrincipalSummary[];
/** Per-page summary stats — feed the SummaryStatItem cards. */
export interface RoleGraphStats {
    totalAssignments: number;
    uniquePrincipals: number;
    tier0Count: number;
    tier1Count: number;
    escalationCount: number;
    guestPrivilegedCount: number;
}
export declare function computeStats(summaries: ReadonlyArray<PrincipalSummary>): RoleGraphStats;
/** Filter state mirrored 1:1 from the page UI. */
export interface RoleGraphFilters {
    search: string;
    tiers: PrivilegeTier[];
    principalTypes: string[];
    escalation: "all" | "any" | "direct" | "groupMediated" | "crossTenantGuest";
    scope: "all" | "subscription" | "resourceGroup" | "resource";
}
export declare const EMPTY_FILTERS: RoleGraphFilters;
export declare function applyFilters(summaries: ReadonlyArray<PrincipalSummary>, filters: RoleGraphFilters): PrincipalSummary[];
/** Severity bucket for a defender-signal finding. */
export type SignalSeverity = "critical" | "high" | "medium" | "info";
/** Display meta for severity badges. */
export interface SignalSeverityMeta {
    severity: SignalSeverity;
    label: string;
    badgeVariant: "destructive" | "warning" | "secondary" | "outline";
    /** Sort order — lower = more severe. */
    order: number;
}
export declare const SIGNAL_SEVERITY_META: Record<SignalSeverity, SignalSeverityMeta>;
/** One offender returned by Signal A. */
export interface CustomRolePrivescFinding {
    /** Role definition GUID. */
    roleDefinitionId: string;
    /** Friendly role name. */
    roleName: string;
    /** Subscription this role was discovered under. */
    subscriptionId: string;
    /** Subscription display name (for the panel). */
    subscriptionDisplayName: string;
    /** The exact action strings that triggered the finding. */
    matchedActions: string[];
    /** Number of role assignments using this role definition. */
    assignmentCount: number;
    /** Resolved-principal summaries holding this role (capped — see consumer). */
    holders: Array<{
        principalId: string;
        displayName: string;
        principalType: string;
        isGuest: boolean;
        /** True when at least one holder's tier is NOT critical (= escalation
         *  primitive on a non-Tier-0 identity = critical severity). */
        isNonTierZero: boolean;
        scopes: string[];
    }>;
    /** Severity bucket; critical when any holder is a non-Tier-0 principal. */
    severity: SignalSeverity;
}
/**
 * Inputs for `detectCustomRoleWritePrivesc`. Shaped to consume what the page
 * already has after a probe (per-sub role-defs + flattened assignments +
 * resolved principal map) so the detector does no I/O.
 */
export interface CustomRoleWritePrivescInputs {
    /** All sub-probe results — uses the roleDefs of each. */
    subResults: ReadonlyArray<{
        subscriptionId: string;
        displayName: string;
        roleDefs: ReadonlyArray<RoleDefinitionForTier>;
        assignments: ReadonlyArray<{
            id: string;
            principalId: string;
            principalType: string;
            roleDefinitionId: string;
            scope: string;
        }>;
    }>;
    /** Resolved principal lookup keyed by id. */
    principalLookup: ReadonlyMap<string, {
        displayName: string;
        type: string;
        signInName?: string;
    }>;
}
/**
 * Detect custom roles whose `permissions.actions` contain the escalation
 * wildcards documented in `_bypass_role_grant.md §8.1`.
 *
 * Filters:
 *   - Only roles where `type === "CustomRole"` (matches the ARM property name
 *     `properties.type` returned by /roleDefinitions). Built-ins are excluded
 *     because they're already classified by the tier system.
 *   - At least one of: `*`, `*\/write`, `Microsoft.Authorization/*`,
 *     `Microsoft.Authorization/roleAssignments/write`,
 *     `Microsoft.Authorization/roleDefinitions/write`,
 *     `Microsoft.Authorization/policyAssignments/<any>`.
 *
 * Severity bucket:
 *   - `critical` — at least one current holder is non-Tier-0
 *     (User / ServicePrincipal that isn't already Owner-equivalent), because
 *     this is the canonical "hidden privesc" finding.
 *   - `high`     — only Tier-0-equivalent holders (e.g. an existing Owner
 *     also happens to hold this role) — still report it, lower severity.
 *   - `info`     — no current holders.
 */
export declare function detectCustomRoleWritePrivesc(inputs: CustomRoleWritePrivescInputs): CustomRolePrivescFinding[];
/** Inputs for Signal B. The page does the Graph reads, we do the audit. */
export interface RoleAssignableGroupAuditInputs {
    /** Raw Graph response shape — role-assignable groups + owners. */
    groups: ReadonlyArray<{
        id: string;
        displayName: string;
        owners: ReadonlyArray<{
            id: string;
            displayName: string;
            type: string;
            signInName?: string;
        }>;
    }>;
    /** All summaries from the current probe — used to discover what role(s)
     *  each group currently holds in the audited subscriptions. */
    summaries: ReadonlyArray<PrincipalSummary>;
}
/** One row in the role-assignable-group findings panel. */
export interface RoleAssignableGroupFinding {
    groupId: string;
    displayName: string;
    ownerCount: number;
    /** Up to 3 sample owners — full list is in raw data, sample is what we render. */
    sampleOwners: Array<{
        id: string;
        displayName: string;
        type: string;
        isGuest: boolean;
    }>;
    /** True when at least one owner is non-Tier-0 (i.e. not already an admin). */
    hasNonTierZeroOwner: boolean;
    /** Role-tier this group itself currently holds, if any. */
    groupHighestTier?: PrivilegeTier;
    /** Friendly role name(s) the group holds in the audited subs. */
    groupRoles: string[];
    /** Severity for ranking the finding. */
    severity: SignalSeverity;
}
export declare function auditRoleAssignableGroups(inputs: RoleAssignableGroupAuditInputs): RoleAssignableGroupFinding[];
/** The set of Graph app-role values we treat as "GA-equivalent if reached". */
export declare const ADMIN_TIER_GRAPH_APP_ROLES: Set<string>;
/** Inputs for Signal C — page assembles these from supplementary Graph reads. */
export interface AppAdminEscalationInputs {
    /** Principals (User + Group + SP) that currently hold Application
     *  Administrator (`9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3`) or
     *  Cloud Application Administrator (`158c047a-c907-4556-b7ef-446551a6b5f7`)
     *  directory roles. */
    appAdminPrincipals: ReadonlyArray<{
        id: string;
        displayName: string;
        type: string;
        signInName?: string;
        /** Which directory role they hold ("Application Administrator" /
         *  "Cloud Application Administrator"). */
        roleName: string;
    }>;
    /** Service principals (or apps) that currently hold one of the admin-tier
     *  Graph app-only permissions in ADMIN_TIER_GRAPH_APP_ROLES. */
    highPrivSps: ReadonlyArray<{
        id: string;
        displayName: string;
        appRoles: string[];
    }>;
}
/** Per-row finding for the App-Admin panel. */
export interface AppAdminEscalationFinding {
    principalId: string;
    displayName: string;
    principalType: string;
    isGuest: boolean;
    roleName: string;
    /** Number of high-priv SPs they could `addKey` to. */
    reachableSpCount: number;
    /** Up to 3 example SP names to display in the row. */
    sampleSpNames: string[];
    /** Most-permissive Graph scope reachable. */
    topReachableScope?: string;
    severity: SignalSeverity;
}
export declare function detectAppAdminEscalation(inputs: AppAdminEscalationInputs): AppAdminEscalationFinding[];
/** Default lookback window for "recently added credential" — 7 days. */
export declare const DEFAULT_CREDENTIAL_RECENCY_DAYS = 7;
/** Per-SP credential summary as the page receives it from Graph. */
export interface SpCredentialSummary {
    spId: string;
    /** App registration id (object id) — used to deep-link to Portal. */
    appObjectId?: string;
    /** App display name (`servicePrincipal.displayName` or `application.displayName`). */
    displayName: string;
    passwordCredentialCount: number;
    keyCredentialCount: number;
    /** ISO timestamp — most recent password credential `endDateTime`. */
    newestPasswordEnd?: string;
    /** Same for key credentials. */
    newestKeyEnd?: string;
    /** ISO timestamp — earliest credential `startDateTime` we have; powers the
     *  "added in the last 7 days" detection when the snapshot diff isn't
     *  available. */
    newestCredentialStart?: string;
    /** True when the SP holds an admin-tier Graph permission (Signal C target). */
    isHighPriv?: boolean;
}
/** One row in the Signal D panel. */
export interface CredentialSurfaceFinding {
    spId: string;
    displayName: string;
    passwordCredentialCount: number;
    keyCredentialCount: number;
    newestCredentialStart?: string;
    /** Days since the newest credential was minted (if known). */
    daysSinceNewestCredential?: number;
    /** True when newer-than-recency-window. */
    isRecent: boolean;
    /** Whether this SP holds admin-tier Graph permissions. */
    isHighPriv: boolean;
    severity: SignalSeverity;
}
export declare function summarizeCredentialSurface(sps: ReadonlyArray<SpCredentialSummary>, recencyDays?: number, now?: Date): CredentialSurfaceFinding[];
export interface DefenderSignalCounts {
    customRolePrivescCritical: number;
    customRolePrivescHigh: number;
    roleAssignableGroupCritical: number;
    roleAssignableGroupHigh: number;
    appAdminEscalationCritical: number;
    appAdminEscalationHigh: number;
    credentialSurfaceCritical: number;
    credentialSurfaceHigh: number;
}
export declare function computeDefenderSignalScore(c: DefenderSignalCounts): {
    score: number;
    label: string;
};
/** One hop on a discovered path. The first hop is always the start principal. */
export interface PathHop {
    /** Hop kind — drives the rendered icon + verb. */
    kind: "principal" | "group" | "role" | "scope";
    /** Stable id for the hop entity (principal id, group id, role guid, scope). */
    id: string;
    /** Friendly label for the hop. */
    label: string;
    /** Optional secondary detail (e.g. role tier, scope level). */
    detail?: string;
    /** When kind === "principal" this is the principal type. */
    principalType?: string;
    /** When kind === "role" this is the privilege tier of the role. */
    tier?: PrivilegeTier;
    /** When kind === "scope" this is the scope level for the chip. */
    scopeLevel?: ScopeLevel;
}
/** One full path found by `findShortestPath`. */
export interface FoundPath {
    /** Ordered hops, starting at the matched principal, ending at the scope. */
    hops: PathHop[];
    /** Number of edges traversed (= `hops.length - 1`). */
    hopCount: number;
    /** True when this path includes at least one group-mediated edge. */
    viaGroup: boolean;
    /** True when this path includes a nested-group edge (group ⊂ group). */
    viaNestedGroup: boolean;
    /** Highest tier reached on the path (the role hop's tier). */
    highestTier: PrivilegeTier;
}
/** Inputs for the BFS path-finder. */
export interface FindPathInputs {
    /** Free-text principal hint — matched against id / displayName / signInName. */
    principalQuery: string;
    /** Free-text scope hint — substring matched against assignment.scope. */
    scopeQuery: string;
    /** All summaries from the current probe (post-filter or full). */
    summaries: ReadonlyArray<PrincipalSummary>;
    /** Optional Map<groupId, members[]> from the transitive-members probe. */
    groupMembersByGroupId?: ReadonlyMap<string, ReadonlyArray<ResolvedGroupMember>>;
    /** Hard cap on returned paths (UI render budget). */
    maxPaths?: number;
}
/**
 * BFS shortest-path search from every matched start principal to every
 * assignment whose scope contains `scopeQuery`. Returns ALL shortest paths
 * (one per matched start principal / scope tuple), de-duped.
 *
 * Edges modelled:
 *   - principal --member-of--> group  (when this principal appears in the
 *     group's transitiveMembers list)
 *   - group     --member-of--> group  (nested group; transitive-members can
 *     contain group entries)
 *   - principal --holds-role--> role  (direct assignment)
 *   - role      --at-scope--> scope   (the role-assignment scope)
 *
 * Hop budget capped at 5 to keep BFS bounded. Real attack chains stop
 * mattering past 4-5 hops because operators can't reason about them anyway.
 */
export declare function findShortestPath(inputs: FindPathInputs): FoundPath[];
/** One transitive-ownership chain finding. */
export interface OwnershipChainFinding {
    /** The originating principal (the owner of G1). */
    ownerId: string;
    ownerDisplayName: string;
    ownerType: string;
    isGuest: boolean;
    /** First group in the chain (the one A directly owns). */
    rootGroupId: string;
    rootGroupDisplayName: string;
    /** All intermediate groups on the chain (G2, G3, ...). */
    intermediateGroupIds: string[];
    /** Final group that holds the role (= last entry in groups path). */
    terminalGroupId: string;
    terminalGroupDisplayName: string;
    /** The role(s) the terminal group currently holds in the audited subs. */
    terminalRoles: string[];
    terminalTier: PrivilegeTier;
    /** Number of group hops (= ownership chain depth, min 1). */
    depth: number;
    severity: SignalSeverity;
}
/** Inputs for `detectOwnershipChains`. */
export interface OwnershipChainInputs {
    /** Output of Signal B fetch: groups + their owners. */
    groups: ReadonlyArray<{
        id: string;
        displayName: string;
        owners: ReadonlyArray<{
            id: string;
            displayName: string;
            type: string;
            signInName?: string;
        }>;
    }>;
    /** Summaries — to look up what role each terminal group holds. */
    summaries: ReadonlyArray<PrincipalSummary>;
    /** Transitive-members map keyed by group id. */
    groupMembersByGroupId?: ReadonlyMap<string, ReadonlyArray<ResolvedGroupMember>>;
}
/**
 * Detect ownership chains where an owner of group G1 transitively reaches a
 * group G2 (via membership) that holds a privileged role.
 *
 * Algorithm: for every group G1 we know about (= every Signal B row), walk
 * the transitive-members graph and find every group reachable from G1. If
 * any such group has a `critical` or `privileged` tier assignment, emit one
 * finding per (owner-of-G1, terminal-group) pair.
 *
 * Depth budget: 4 (same as BFS — `_bypass_role_grant.md` §5.4 calls out 2-3
 * nesting levels as the common case; 4 gives us headroom).
 */
export declare function detectOwnershipChains(inputs: OwnershipChainInputs): OwnershipChainFinding[];
//# sourceMappingURL=role-graph-helpers.d.ts.map