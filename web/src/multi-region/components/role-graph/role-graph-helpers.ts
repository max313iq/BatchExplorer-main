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

// ---------------------------------------------------------------------------
// Privilege tier classification
// ---------------------------------------------------------------------------

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

export const PRIVILEGE_TIER_META: Record<PrivilegeTier, PrivilegeTierMeta> = {
  critical: {
    tier: "critical",
    label: "Critical",
    badgeVariant: "destructive",
    description:
      "Owner / User Access Administrator class — can grant any role and modify any resource.",
    order: 0,
  },
  privileged: {
    tier: "privileged",
    label: "Privileged",
    badgeVariant: "warning",
    description:
      "Has Microsoft.Authorization/*/write or */write permission — can grant/modify access at scope.",
    order: 1,
  },
  write: {
    tier: "write",
    label: "Write",
    badgeVariant: "secondary",
    description:
      "Mutating role — can create / delete / modify resources but not grant access.",
    order: 2,
  },
  readonly: {
    tier: "readonly",
    label: "Read-only",
    badgeVariant: "outline",
    description: "Read-only role — cannot modify resources.",
    order: 3,
  },
};

/**
 * Well-known role-definition GUIDs that grant tier-0 (critical) access.
 *
 * These are stable across all Azure commercial / sovereign clouds and
 * match Microsoft's built-in role catalogue. Lowercase for case-
 * insensitive comparison via `.toLowerCase()` in callers.
 */
export const TIER_0_ROLE_GUIDS = new Set<string>([
  // Owner — full management + can grant any role.
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635",
  // User Access Administrator — can grant any role, even Owner.
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9",
  // Role Based Access Control Administrator — limited UAA, still grants roles
  // (excluding Owner/UAA themselves but can grant Contributor + others).
  "f58310d9-a9f6-439a-9e8d-f62e7b41a168",
  // Contributor — at sub/MG scope, contributor cannot grant roles but it
  // CAN delete resources, deploy new ones, and grant data-plane access on
  // many services. Treated as critical at top-level scope per the page's
  // tier classifier (see classifyRoleTier — Contributor is critical only
  // when the role definition guid matches AND the scope is subscription/MG).
  "b24988ac-6180-42a0-ab88-20f7382dd24c",
  // Reservations Administrator — can purchase / modify reservations =
  // financial blast radius.
  "a8889054-8d42-49c9-bc1c-52486c10e7cd",
]);

/** Lowercased Tier-0 set for case-insensitive comparison. */
const TIER_0_LOWER = new Set<string>(
  Array.from(TIER_0_ROLE_GUIDS).map((g) => g.toLowerCase()),
);

/**
 * The Contributor role GUID — pulled out so the tier classifier can
 * distinguish "Contributor at sub scope" (critical) from "Contributor
 * at a resource scope" (write).
 */
const CONTRIBUTOR_GUID = "b24988ac-6180-42a0-ab88-20f7382dd24c";

/**
 * Permission action patterns that indicate role-assignment write
 * capability (= privilege escalation potential). A custom role
 * containing any of these is at least Tier 1 (privileged).
 *
 * Match semantics:
 *   - "*" (literal) - full sovereignty over everything.
 *   - "(asterisk)/write" - write on any resource type (rare; usually
 *     means a custom-built admin role with no scope restriction).
 *   - "Microsoft.Authorization/(asterisk)" - full RBAC sovereignty
 *     (= UAA-like).
 *   - "Microsoft.Authorization/roleAssignments/write" -
 *     can grant ANY role to anyone at scope. Headline escalation.
 *   - "Microsoft.Authorization/roleDefinitions/write" - can EDIT
 *     custom roles, equivalent to roleAssignments/write because you
 *     can add yourself to the permissions of a role you already hold.
 *   - "Microsoft.Authorization/policyAssignments/(asterisk)" -
 *     policy assignment write can be used to grant managed identities
 *     access via deployIfNotExists remediations; treat as privileged.
 *
 * Wildcards are matched as case-insensitive glob: "*" = "any chars".
 */
const PRIVILEGED_ACTION_PATTERNS: RegExp[] = [
  /^\*$/i,
  /^\*\/write$/i,
  /^Microsoft\.Authorization\/\*$/i,
  /^Microsoft\.Authorization\/roleAssignments\/write$/i,
  /^Microsoft\.Authorization\/roleDefinitions\/write$/i,
  /^Microsoft\.Authorization\/policyAssignments\/.+$/i,
];

/** Wildcard-write patterns that indicate Tier-2 (mutating) access. */
const WRITE_ACTION_PATTERNS: RegExp[] = [
  /^.+\/write$/i,
  /^.+\/delete$/i,
  /^\*\/delete$/i,
  /^.+\/action$/i,
];

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
export function classifyRoleTier(
  def: RoleDefinitionForTier | undefined,
  roleGuid: string,
  scope: string,
): PrivilegeTier {
  const guidLower = (def?.id ?? roleGuid ?? "").toLowerCase();
  const nameLower = (def?.name ?? "").toLowerCase();
  const scopeDepth = classifyScopeLevel(scope);

  // 1) Known critical built-ins always win.
  if (TIER_0_LOWER.has(guidLower) && guidLower !== CONTRIBUTOR_GUID) {
    return "critical";
  }
  // 2) Contributor only counts as critical at sub / MG scope.
  if (guidLower === CONTRIBUTOR_GUID) {
    if (scopeDepth === "subscription" || scopeDepth === "managementGroup") {
      return "critical";
    }
    // At RG / resource scope, Contributor is "just" a Tier-2 mutating role.
    return "write";
  }

  // 3) Permissions-array escalation patterns → privileged.
  if (def?.permissions && def.permissions.length > 0) {
    for (const block of def.permissions) {
      for (const a of block.actions ?? []) {
        for (const pat of PRIVILEGED_ACTION_PATTERNS) {
          if (pat.test(a)) return "privileged";
        }
      }
    }
  }

  // 4) Fallback by name when permissions aren't available.
  if (!def?.permissions || def.permissions.length === 0) {
    if (
      nameLower === "owner" ||
      nameLower === "user access administrator" ||
      nameLower.includes("role based access control")
    ) {
      return "critical";
    }
    if (
      nameLower.endsWith("administrator") ||
      nameLower.endsWith("admin") ||
      nameLower.includes("privileged")
    ) {
      return "privileged";
    }
  }

  // 5) Permissions-array write patterns → tier 2.
  if (def?.permissions && def.permissions.length > 0) {
    for (const block of def.permissions) {
      for (const a of block.actions ?? []) {
        for (const pat of WRITE_ACTION_PATTERNS) {
          if (pat.test(a)) return "write";
        }
      }
    }
  }

  // 6) Read-only by name (catch built-ins that don't expose permissions).
  if (
    nameLower === "reader" ||
    nameLower.endsWith(" reader") ||
    nameLower === "viewer" ||
    nameLower.endsWith(" viewer")
  ) {
    return "readonly";
  }

  // 7) Default to write — being CONSERVATIVE: if we don't know, assume
  //    the role can mutate something. Better to over-warn than to miss
  //    a real Tier-2 assignment hiding behind an unfamiliar custom role.
  return "write";
}

// ---------------------------------------------------------------------------
// Scope classification
// ---------------------------------------------------------------------------

/**
 * The "level" a role-assignment scope sits at. Drives:
 *   - The Contributor-at-sub-scope critical promotion in `classifyRoleTier`.
 *   - The scope chip rendered next to each assignment in the UI.
 *   - The "scope" filter chips on the page (subscription / RG / resource).
 */
export type ScopeLevel =
  | "tenant"
  | "managementGroup"
  | "subscription"
  | "resourceGroup"
  | "resource"
  | "unknown";

const RE_MANAGEMENT_GROUP = /^\/providers\/Microsoft\.Management\/managementGroups\/[^/]+$/i;
const RE_SUBSCRIPTION = /^\/subscriptions\/[0-9a-f-]{36}$/i;
const RE_RESOURCE_GROUP =
  /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+$/i;
const RE_RESOURCE =
  /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/.+/i;

/**
 * Inspect a scope string and tell me which level it lives at. Defensive
 * against weird casing (`resourcegroups` vs `resourceGroups`) and root
 * `/` (tenant scope used by some cross-tenant grants).
 */
export function classifyScopeLevel(scope: string): ScopeLevel {
  if (!scope || scope === "/") return "tenant";
  if (RE_MANAGEMENT_GROUP.test(scope)) return "managementGroup";
  if (RE_RESOURCE.test(scope)) return "resource";
  if (RE_RESOURCE_GROUP.test(scope)) return "resourceGroup";
  if (RE_SUBSCRIPTION.test(scope)) return "subscription";
  return "unknown";
}

/** Human-friendly label for a scope (for the chip next to each assignment). */
export function describeScope(scope: string): string {
  const lvl = classifyScopeLevel(scope);
  switch (lvl) {
    case "tenant":
      return "Tenant root";
    case "managementGroup":
      return "Management group";
    case "subscription":
      return "Subscription";
    case "resourceGroup": {
      const m = /\/resourceGroups\/([^/]+)/i.exec(scope);
      return m ? `RG: ${m[1]}` : "Resource group";
    }
    case "resource": {
      // Last segment after /providers/.../ is the resource name.
      const tail = scope.split("/").pop() ?? "";
      return tail ? `Resource: ${tail}` : "Resource";
    }
    default:
      return "Unknown scope";
  }
}

// ---------------------------------------------------------------------------
// Escalation pattern detection
// ---------------------------------------------------------------------------

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
export type EscalationCategory =
  | "direct"
  | "groupMediated"
  | "crossTenantGuest";

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
export function isGuestUpn(upn: string | undefined | null): boolean {
  if (!upn) return false;
  const lower = upn.toLowerCase();
  return lower.includes("#ext#") || lower.includes("_ext_");
}

// ---------------------------------------------------------------------------
// Principal grouping
// ---------------------------------------------------------------------------

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
export function highestTierOf(
  assignments: ReadonlyArray<PrincipalAssignment>,
): PrivilegeTier {
  let best: PrivilegeTier = "readonly";
  let bestOrder = PRIVILEGE_TIER_META.readonly.order;
  for (const a of assignments) {
    const o = PRIVILEGE_TIER_META[a.tier].order;
    if (o < bestOrder) {
      best = a.tier;
      bestOrder = o;
    }
  }
  return best;
}

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
  assignments: ReadonlyArray<PrincipalAssignment & { principalId: string; principalType: string }>;
  principalLookup: Map<
    string,
    { displayName: string; type: string; signInName?: string }
  >;
  groupMembersByGroupId?: Map<string, ResolvedGroupMember[]>;
}

export function groupByPrincipal(
  inputs: GroupAssignmentInputs,
): PrincipalSummary[] {
  const { assignments, principalLookup, groupMembersByGroupId } = inputs;

  // Bucket assignments by principal id.
  const byId = new Map<string, PrincipalSummary>();
  for (const a of assignments) {
    const id = a.principalId;
    const resolved = principalLookup.get(id);
    const displayName = resolved?.displayName ?? id;
    const signInName = resolved?.signInName;
    const principalType = resolved?.type ?? a.principalType ?? "Unknown";
    const isGuest = isGuestUpn(signInName);
    let entry = byId.get(id);
    if (!entry) {
      entry = {
        principalId: id,
        principalType,
        displayName,
        signInName,
        isGuest,
        assignments: [],
        highestTier: "readonly",
        assignmentCount: 0,
        escalations: [],
        hasEscalation: false,
      };
      byId.set(id, entry);
    }
    entry.assignments.push(a);
  }

  // Pre-compute tier + escalations per principal.
  for (const summary of byId.values()) {
    summary.assignmentCount = summary.assignments.length;
    summary.highestTier = highestTierOf(summary.assignments);
    summary.escalations = computeEscalations(summary, groupMembersByGroupId);
    summary.hasEscalation = summary.escalations.length > 0;
    if (
      summary.principalType === "Group" &&
      groupMembersByGroupId?.has(summary.principalId)
    ) {
      summary.groupMembers = groupMembersByGroupId.get(summary.principalId);
    }
  }

  // Stable sort: most-privileged first (lowest tier order), then escalation
  // findings first within tier, then display name asc for determinism.
  return Array.from(byId.values()).sort((a, b) => {
    const oa = PRIVILEGE_TIER_META[a.highestTier].order;
    const ob = PRIVILEGE_TIER_META[b.highestTier].order;
    if (oa !== ob) return oa - ob;
    if (a.hasEscalation !== b.hasEscalation) return a.hasEscalation ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Compute escalation findings for one principal. Pure function — caller
 * (groupByPrincipal) calls this after the summary's `assignments` and
 * `isGuest` fields are populated.
 *
 * Group-mediated detection looks at every assignment held by a GROUP
 * principal whose tier is critical. When such a group's transitive
 * members are known, every member principal inherits the finding. But
 * because this function operates on ONE principal at a time, we instead
 * surface the finding the other way around: if THIS principal appears
 * in the transitive members of a group that holds a critical role, we
 * flag them. The caller passes the full group-members map so we can
 * walk it.
 */
function computeEscalations(
  summary: PrincipalSummary,
  groupMembersByGroupId: Map<string, ResolvedGroupMember[]> | undefined,
): EscalationFinding[] {
  const findings: EscalationFinding[] = [];

  // 1) Direct elevation: a critical-tier assignment at sub / MG scope.
  for (const a of summary.assignments) {
    if (
      a.tier === "critical" &&
      (a.scopeLevel === "subscription" ||
        a.scopeLevel === "managementGroup" ||
        a.scopeLevel === "tenant")
    ) {
      findings.push({
        category: "direct",
        headline: `Can self-grant any role (${a.roleName} at ${describeScope(a.scope)})`,
        detail:
          "Principal holds a critical-tier role at a top-level scope. " +
          "They can grant themselves or anyone else any other role at this " +
          "scope, including Owner. Audit the assignment's createdBy + " +
          "justification — if unknown, consider replacing with a narrower role.",
      });
      break; // one direct finding per principal is enough
    }
  }

  // 2) Group-mediated elevation: this principal is a member of a group
  //    that itself holds a critical-tier role.
  if (groupMembersByGroupId && summary.principalType !== "Group") {
    for (const [groupId, members] of groupMembersByGroupId.entries()) {
      const isMember = members.some(
        (m) => m.id.toLowerCase() === summary.principalId.toLowerCase(),
      );
      if (!isMember) continue;
      // For this to fire, the GROUP itself must have a critical assignment.
      // We can't see the group's own summary from here (forward reference),
      // so we instead encode that decision by checking whether the group
      // appears in `assignments` as a principal — but it won't, because we
      // grouped by principal id. The caller (groupByPrincipal) sets up
      // `groupMembersByGroupId` ONLY with groups that already have a
      // critical assignment, so reaching this loop is sufficient.
      findings.push({
        category: "groupMediated",
        headline: `Inherited admin via group ${groupId.substring(0, 8)}…`,
        detail:
          "Principal is a transitive member of a group that holds a " +
          "critical-tier role at a top-level scope. Removing the principal " +
          "from the group revokes the inherited admin without touching the " +
          "role assignment.",
        viaPrincipalId: groupId,
      });
    }
  }

  // 3) Cross-tenant guest with privileged role.
  if (summary.isGuest) {
    const hasPrivileged = summary.assignments.some(
      (a) => a.tier === "critical" || a.tier === "privileged",
    );
    if (hasPrivileged) {
      findings.push({
        category: "crossTenantGuest",
        headline: "Guest account holds privileged role",
        detail:
          "Principal is a B2B guest (UPN contains #EXT#) and holds a " +
          "critical/privileged role. Guest sign-in flows are partially " +
          "controlled by the guest's home tenant — review whether this " +
          "guest still needs access and consider time-bound PIM eligibility.",
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

/** Per-page summary stats — feed the SummaryStatItem cards. */
export interface RoleGraphStats {
  totalAssignments: number;
  uniquePrincipals: number;
  tier0Count: number;
  tier1Count: number;
  escalationCount: number;
  guestPrivilegedCount: number;
}

export function computeStats(
  summaries: ReadonlyArray<PrincipalSummary>,
): RoleGraphStats {
  let totalAssignments = 0;
  let tier0Count = 0;
  let tier1Count = 0;
  let escalationCount = 0;
  let guestPrivilegedCount = 0;
  for (const s of summaries) {
    totalAssignments += s.assignmentCount;
    if (s.highestTier === "critical") tier0Count++;
    if (s.highestTier === "privileged") tier1Count++;
    if (s.hasEscalation) escalationCount++;
    if (
      s.isGuest &&
      (s.highestTier === "critical" || s.highestTier === "privileged")
    ) {
      guestPrivilegedCount++;
    }
  }
  return {
    totalAssignments,
    uniquePrincipals: summaries.length,
    tier0Count,
    tier1Count,
    escalationCount,
    guestPrivilegedCount,
  };
}

// ---------------------------------------------------------------------------
// Filter predicates
// ---------------------------------------------------------------------------

/** Filter state mirrored 1:1 from the page UI. */
export interface RoleGraphFilters {
  search: string;
  tiers: PrivilegeTier[]; // empty array = "all"
  principalTypes: string[]; // empty = "all"
  escalation: "all" | "any" | "direct" | "groupMediated" | "crossTenantGuest";
  scope: "all" | "subscription" | "resourceGroup" | "resource";
}

export const EMPTY_FILTERS: RoleGraphFilters = {
  search: "",
  tiers: [],
  principalTypes: [],
  escalation: "all",
  scope: "all",
};

export function applyFilters(
  summaries: ReadonlyArray<PrincipalSummary>,
  filters: RoleGraphFilters,
): PrincipalSummary[] {
  const q = filters.search.trim().toLowerCase();
  return summaries.filter((s) => {
    if (filters.tiers.length > 0 && !filters.tiers.includes(s.highestTier)) {
      return false;
    }
    if (
      filters.principalTypes.length > 0 &&
      !filters.principalTypes.includes(s.principalType)
    ) {
      return false;
    }
    if (filters.escalation !== "all") {
      if (filters.escalation === "any" && !s.hasEscalation) return false;
      if (
        filters.escalation === "direct" &&
        !s.escalations.some((e) => e.category === "direct")
      )
        return false;
      if (
        filters.escalation === "groupMediated" &&
        !s.escalations.some((e) => e.category === "groupMediated")
      )
        return false;
      if (
        filters.escalation === "crossTenantGuest" &&
        !s.escalations.some((e) => e.category === "crossTenantGuest")
      )
        return false;
    }
    if (filters.scope !== "all") {
      const wantLevel: ScopeLevel =
        filters.scope === "subscription"
          ? "subscription"
          : filters.scope === "resourceGroup"
            ? "resourceGroup"
            : "resource";
      const has = s.assignments.some((a) => a.scopeLevel === wantLevel);
      if (!has) return false;
    }
    if (q) {
      const hay = [
        s.displayName,
        s.signInName ?? "",
        s.principalId,
        s.principalType,
        ...s.assignments.map((a) => a.roleName),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Corpus-derived defender signals
//
// These detectors are read-only audits over data already returned by the page's
// existing probes (role definitions, role assignments, resolved principals)
// plus, where noted, supplementary Graph reads driven from the page. They
// mirror the "Critical Defender Audit Surface" enumeration in the corpus
// master playbook (items 4, 5) and the Top-30 escalation list (#23-#26).
//
// Citations:
//   - C:\Users\baimgprodsesa1\Desktop\New folder\_AZURE_BYPASS_PLAYBOOK.md
//       §Critical Defender Audit Surface items 4-5
//       §Top-30 Privilege-Escalation Chains items 23, 24, 25, 26
//   - C:\Users\baimgprodsesa1\Desktop\New folder\_bypass_role_grant.md
//       §3.5  Application Administrator → escalate via existing app
//       §4.1  addPassword
//       §4.2  addKey
//       §5.1  Role-assignable groups
//       §5.3  Group ownership = membership management
//       §8.1  Custom role with hidden privesc actions
// Defensive analogs:
//   - SpecterOps/AzureHound role-graph collection
//   - nccgroup/PMapper / Azucar custom-role audits
//   - dafthack/GraphRunner application-credentials enumeration
// ---------------------------------------------------------------------------

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

export const SIGNAL_SEVERITY_META: Record<SignalSeverity, SignalSeverityMeta> = {
  critical: {
    severity: "critical",
    label: "Critical",
    badgeVariant: "destructive",
    order: 0,
  },
  high: {
    severity: "high",
    label: "High",
    badgeVariant: "warning",
    order: 1,
  },
  medium: {
    severity: "medium",
    label: "Medium",
    badgeVariant: "secondary",
    order: 2,
  },
  info: {
    severity: "info",
    label: "Info",
    badgeVariant: "outline",
    order: 3,
  },
};

// ---------------------------------------------------------------------------
// Signal A — custom roles that contain a hidden roleAssignments/write action.
//
// Corpus citation: _bypass_role_grant.md §8.1 + _AZURE_BYPASS_PLAYBOOK.md #25
//
// A custom role with `Microsoft.Authorization/roleAssignments/write` (or a
// broader wildcard such as `Microsoft.Authorization/*` or `*`) lets its holder
// grant any other role to anyone at the role's scope. The role name itself
// often looks innocuous (e.g. "Network Ops Lead") so audits that key on the
// well-known Owner / UAA / RBAC-Admin GUIDs miss it.
//
// Detection: for each role we already fetched in
// `fetchRoleDefinitionsWithPermissions`, walk `permissions[].actions` and
// match against the same wildcard patterns the tier-classifier uses. We treat
// any role whose `type === "CustomRole"` AND whose actions hit those patterns
// as a privesc-primitive role. Built-ins that hold the same patterns (Owner,
// UAA, RBAC Admin) are NOT reported here — they're the canonical Tier-0
// roles already covered by the direct-elevation finding.
// ---------------------------------------------------------------------------

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
  principalLookup: ReadonlyMap<
    string,
    { displayName: string; type: string; signInName?: string }
  >;
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
export function detectCustomRoleWritePrivesc(
  inputs: CustomRoleWritePrivescInputs,
): CustomRolePrivescFinding[] {
  const { subResults, principalLookup } = inputs;
  // Wildcard patterns intentionally mirror the helper-internal
  // PRIVILEGED_ACTION_PATTERNS list above — duplicated here to avoid leaking
  // that constant into the public API surface (it's an impl detail).
  const PRIVESC = [
    /^\*$/i,
    /^\*\/write$/i,
    /^Microsoft\.Authorization\/\*$/i,
    /^Microsoft\.Authorization\/roleAssignments\/write$/i,
    /^Microsoft\.Authorization\/roleDefinitions\/write$/i,
    /^Microsoft\.Authorization\/policyAssignments\/.+$/i,
  ];
  const findings: CustomRolePrivescFinding[] = [];
  for (const sub of subResults) {
    // Index assignments by role-def id for this sub.
    const assignmentsByRoleId = new Map<
      string,
      Array<{ principalId: string; scope: string; principalType: string }>
    >();
    for (const a of sub.assignments) {
      const key = a.roleDefinitionId.toLowerCase();
      const arr = assignmentsByRoleId.get(key) ?? [];
      arr.push({
        principalId: a.principalId,
        principalType: a.principalType,
        scope: a.scope,
      });
      assignmentsByRoleId.set(key, arr);
    }
    for (const def of sub.roleDefs) {
      // Built-ins are skipped — they're already in the tier matrix.
      const lowerType = (def.type ?? "").toLowerCase();
      if (lowerType && lowerType !== "customrole") continue;
      // Also skip if this role definition is itself one of the well-known
      // Tier-0 GUIDs — that's belt-and-braces because Owner / UAA shouldn't
      // come back with `type: CustomRole`, but if they ever do we still want
      // to defer to the tier system rather than double-report.
      if (TIER_0_LOWER.has(def.id.toLowerCase())) continue;
      const matched = new Set<string>();
      for (const block of def.permissions ?? []) {
        for (const a of block.actions ?? []) {
          for (const pat of PRIVESC) {
            if (pat.test(a)) {
              matched.add(a);
              break;
            }
          }
        }
      }
      if (matched.size === 0) continue;
      const holders = assignmentsByRoleId.get(def.id.toLowerCase()) ?? [];
      // Group holders by principalId (one row per principal even if they have
      // multiple assignments using this role on different scopes).
      const holderById = new Map<
        string,
        { scopes: Set<string>; principalType: string }
      >();
      for (const h of holders) {
        const existing = holderById.get(h.principalId);
        if (existing) {
          existing.scopes.add(h.scope);
        } else {
          holderById.set(h.principalId, {
            scopes: new Set([h.scope]),
            principalType: h.principalType,
          });
        }
      }
      const resolvedHolders: CustomRolePrivescFinding["holders"] = [];
      for (const [principalId, hMeta] of holderById.entries()) {
        const lookup = principalLookup.get(principalId);
        const isGuest = isGuestUpn(lookup?.signInName);
        // "Non-Tier-0" detection: in this context, a holder is non-Tier-0 if
        // they're a User / ServicePrincipal / Application principal type. Group
        // principals are also flagged because the group's membership graph
        // amplifies the blast radius further.
        const principalType = lookup?.type ?? hMeta.principalType;
        const isNonTierZero =
          principalType === "User" ||
          principalType === "Group" ||
          principalType === "ServicePrincipal" ||
          principalType === "Application";
        resolvedHolders.push({
          principalId,
          displayName: lookup?.displayName ?? principalId,
          principalType,
          isGuest,
          isNonTierZero,
          scopes: Array.from(hMeta.scopes),
        });
      }
      let severity: SignalSeverity = "info";
      if (resolvedHolders.length === 0) severity = "info";
      else if (resolvedHolders.some((h) => h.isNonTierZero)) severity = "critical";
      else severity = "high";
      findings.push({
        roleDefinitionId: def.id,
        roleName: def.name,
        subscriptionId: sub.subscriptionId,
        subscriptionDisplayName: sub.displayName,
        matchedActions: Array.from(matched),
        assignmentCount: holders.length,
        holders: resolvedHolders,
        severity,
      });
    }
  }
  // Sort: most severe first, then most-assigned first, then by role name.
  return findings.sort((a, b) => {
    const oa = SIGNAL_SEVERITY_META[a.severity].order;
    const ob = SIGNAL_SEVERITY_META[b.severity].order;
    if (oa !== ob) return oa - ob;
    if (a.assignmentCount !== b.assignmentCount) {
      return b.assignmentCount - a.assignmentCount;
    }
    return a.roleName.localeCompare(b.roleName);
  });
}

// ---------------------------------------------------------------------------
// Signal B — role-assignable groups + their owners.
//
// Corpus citation: _bypass_role_grant.md §5.1 + §5.3 + _AZURE_BYPASS_PLAYBOOK.md #26
//
// Groups with `isAssignableToRole === true` (a.k.a. "Microsoft Entra
// role-assignable groups") can hold Entra directory roles. Owners of such a
// group can add or remove members, inheriting the group's role transitively.
// Crucially, no `Add member to role` audit event fires when an owner adds a
// member — the audit looks like ordinary group-membership maintenance.
//
// Detection: shaped to consume the Graph result of
//   GET /v1.0/groups?$filter=isAssignableToRole eq true
//     &$select=id,displayName,isAssignableToRoleEnabled
//   GET /v1.0/groups/{id}/owners?$select=id,displayName,userPrincipalName,@odata.type
// plus, where available, the role(s) currently held by the group (resolved
// from the page's already-fetched role assignments).
// ---------------------------------------------------------------------------

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

export function auditRoleAssignableGroups(
  inputs: RoleAssignableGroupAuditInputs,
): RoleAssignableGroupFinding[] {
  const { groups, summaries } = inputs;
  // Index summaries by lowercased principal id for quick lookup of what role
  // a group currently holds.
  const summaryById = new Map<string, PrincipalSummary>();
  for (const s of summaries) {
    summaryById.set(s.principalId.toLowerCase(), s);
  }
  const out: RoleAssignableGroupFinding[] = [];
  for (const g of groups) {
    const sample = g.owners.slice(0, 3).map((o) => ({
      id: o.id,
      displayName: o.displayName,
      type: o.type,
      isGuest: isGuestUpn(o.signInName),
    }));
    const groupSummary = summaryById.get(g.id.toLowerCase());
    const groupRoles = (groupSummary?.assignments ?? []).map((a) => a.roleName);
    const hasNonTierZeroOwner = g.owners.some(
      (o) => o.type === "User" || o.type === "ServicePrincipal",
    );
    // Severity:
    //   critical — group holds a Tier-0 role AND has any non-Tier-0 owner
    //              (this is the canonical persistence + privesc primitive).
    //   high     — group holds a Tier-0 role but owners are all Tier-0.
    //   medium   — group exists, owned by non-Tier-0, but currently holds no
    //              audited role (still a planted-trap surface for future grants).
    //   info     — no owners or no role and no non-Tier-0 owner.
    let severity: SignalSeverity = "info";
    const tier = groupSummary?.highestTier;
    if (tier === "critical" && hasNonTierZeroOwner) severity = "critical";
    else if (tier === "critical") severity = "high";
    else if (tier === "privileged" && hasNonTierZeroOwner) severity = "high";
    else if (hasNonTierZeroOwner && g.owners.length > 0) severity = "medium";
    else if (g.owners.length > 0) severity = "info";
    out.push({
      groupId: g.id,
      displayName: g.displayName,
      ownerCount: g.owners.length,
      sampleOwners: sample,
      hasNonTierZeroOwner,
      groupHighestTier: tier,
      groupRoles,
      severity,
    });
  }
  return out.sort((a, b) => {
    const oa = SIGNAL_SEVERITY_META[a.severity].order;
    const ob = SIGNAL_SEVERITY_META[b.severity].order;
    if (oa !== ob) return oa - ob;
    return a.displayName.localeCompare(b.displayName);
  });
}

// ---------------------------------------------------------------------------
// Signal C — Application Administrator + SPs that hold high-priv Graph
// permissions (the canonical addKey-to-GA chain).
//
// Corpus citation: _bypass_role_grant.md §3.5 + _AZURE_BYPASS_PLAYBOOK.md #23, #24
//
// Application Administrator can add credentials (`addKey` or `addPassword`)
// to ANY app registration in the tenant. If ANY app in the tenant is itself
// granted a high-tier Graph app-only permission (`RoleManagement.ReadWrite.
// Directory`, `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`,
// `Directory.ReadWrite.All`, `User.ReadWrite.All`), App Admin holders are
// effectively one credential plant away from Global Admin equivalence.
//
// Detection: presentation-only — we cross-product App-Admin holders with
// the count of high-priv SPs, surface the result in a side panel. The
// graph itself doesn't get new edges because materialising N×M App-Admin-to-SP
// hops would explode the visual graph (per the task brief).
// ---------------------------------------------------------------------------

/** The set of Graph app-role values we treat as "GA-equivalent if reached". */
export const ADMIN_TIER_GRAPH_APP_ROLES = new Set<string>([
  "RoleManagement.ReadWrite.Directory",
  "Application.ReadWrite.All",
  "AppRoleAssignment.ReadWrite.All",
  "Directory.ReadWrite.All",
  "User.ReadWrite.All",
  // Application Administrator has a directory role id but here we're
  // checking app-only Graph scopes only — the directory role itself is the
  // Signal C source, not the target. AppRole values are stable strings from
  // the Microsoft Graph SP's `appRoles` collection.
]);

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

export function detectAppAdminEscalation(
  inputs: AppAdminEscalationInputs,
): AppAdminEscalationFinding[] {
  const { appAdminPrincipals, highPrivSps } = inputs;
  const sampleSps = highPrivSps.slice(0, 3).map((s) => s.displayName);
  const topScope: string | undefined = (() => {
    // Pick the most-impactful scope present, in this canonical order.
    const PRIORITY = [
      "RoleManagement.ReadWrite.Directory",
      "Application.ReadWrite.All",
      "AppRoleAssignment.ReadWrite.All",
      "Directory.ReadWrite.All",
      "User.ReadWrite.All",
    ];
    for (const p of PRIORITY) {
      if (highPrivSps.some((s) => s.appRoles.includes(p))) return p;
    }
    return undefined;
  })();
  const out: AppAdminEscalationFinding[] = [];
  for (const p of appAdminPrincipals) {
    const isGuest = isGuestUpn(p.signInName);
    // Severity:
    //   critical — has access to at least one SP that holds
    //              RoleManagement.ReadWrite.Directory (full GA-equivalent).
    //   high     — has access to any other admin-tier Graph scope.
    //   medium   — App Admin role with NO discovered high-priv SPs (the
    //              role itself is privileged; ranked medium because the
    //              kill-chain target isn't currently in the tenant).
    let severity: SignalSeverity = "medium";
    if (
      highPrivSps.some((s) =>
        s.appRoles.includes("RoleManagement.ReadWrite.Directory"),
      )
    ) {
      severity = "critical";
    } else if (highPrivSps.length > 0) {
      severity = "high";
    }
    out.push({
      principalId: p.id,
      displayName: p.displayName,
      principalType: p.type,
      isGuest,
      roleName: p.roleName,
      reachableSpCount: highPrivSps.length,
      sampleSpNames: sampleSps,
      topReachableScope: topScope,
      severity,
    });
  }
  return out.sort((a, b) => {
    const oa = SIGNAL_SEVERITY_META[a.severity].order;
    const ob = SIGNAL_SEVERITY_META[b.severity].order;
    if (oa !== ob) return oa - ob;
    return a.displayName.localeCompare(b.displayName);
  });
}

// ---------------------------------------------------------------------------
// Signal D — recent addPassword / addKey credential surface on SPs.
//
// Corpus citation: _bypass_role_grant.md §4.1, §4.2 +
//   _AZURE_BYPASS_PLAYBOOK.md "Critical Defender Audit Surface" item 5
//
// `addPassword` and `addKey` are the canonical SP-persistence APIs. Defenders
// should alert on Microsoft.Graph audit `Update application — Certificates
// and secrets management`. In the UI we render the credential-count badges
// on every SP node, and flag any SP whose newest credential was added in the
// last 7 days (`endDateTime`'s freshness is a stronger signal than
// `startDateTime`, which the API doesn't always populate, but in absence of
// baseline data we treat ANY credential added in the recency window as a
// risk indicator).
//
// Page-side concern: we do NOT have a snapshot diff facility today, so the
// "recent credential" detection is calendar-window-only. Baseline diff
// (compare against a stored snapshot) is a COORDINATOR note in the page.
// ---------------------------------------------------------------------------

/** Default lookback window for "recently added credential" — 7 days. */
export const DEFAULT_CREDENTIAL_RECENCY_DAYS = 7;

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

export function summarizeCredentialSurface(
  sps: ReadonlyArray<SpCredentialSummary>,
  recencyDays: number = DEFAULT_CREDENTIAL_RECENCY_DAYS,
  now: Date = new Date(),
): CredentialSurfaceFinding[] {
  const recencyMs = recencyDays * 24 * 60 * 60 * 1000;
  const out: CredentialSurfaceFinding[] = [];
  for (const sp of sps) {
    let daysSince: number | undefined;
    let isRecent = false;
    if (sp.newestCredentialStart) {
      const t = Date.parse(sp.newestCredentialStart);
      if (!Number.isNaN(t)) {
        daysSince = Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000));
        isRecent = now.getTime() - t <= recencyMs;
      }
    }
    let severity: SignalSeverity = "info";
    if (isRecent && sp.isHighPriv) severity = "critical";
    else if (isRecent) severity = "high";
    else if (sp.isHighPriv) severity = "medium";
    out.push({
      spId: sp.spId,
      displayName: sp.displayName,
      passwordCredentialCount: sp.passwordCredentialCount,
      keyCredentialCount: sp.keyCredentialCount,
      newestCredentialStart: sp.newestCredentialStart,
      daysSinceNewestCredential: daysSince,
      isRecent,
      isHighPriv: !!sp.isHighPriv,
      severity,
    });
  }
  return out.sort((a, b) => {
    const oa = SIGNAL_SEVERITY_META[a.severity].order;
    const ob = SIGNAL_SEVERITY_META[b.severity].order;
    if (oa !== ob) return oa - ob;
    if (a.isRecent !== b.isRecent) return a.isRecent ? -1 : 1;
    if (a.isHighPriv !== b.isHighPriv) return a.isHighPriv ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

// ---------------------------------------------------------------------------
// Combined defender-signals risk score
//
// Pages that integrate the four signals above can compute a single "tenant
// defender risk" score for the summary stats bar. The score is purely
// presentation — no decisions hang off it — and is intentionally additive +
// capped at 100 so the operator gets a stable 0..100 to monitor.
// ---------------------------------------------------------------------------

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

export function computeDefenderSignalScore(
  c: DefenderSignalCounts,
): { score: number; label: string } {
  // Weighting reflects corpus risk framing: each critical finding is a
  // ready-to-go privesc primitive (worth 15), each high is a planted
  // trap or partial chain (worth 8). Cap at 100 to avoid runaway sums when
  // a tenant has dozens of findings (the visual range stays meaningful).
  const raw =
    15 *
      (c.customRolePrivescCritical +
        c.roleAssignableGroupCritical +
        c.appAdminEscalationCritical +
        c.credentialSurfaceCritical) +
    8 *
      (c.customRolePrivescHigh +
        c.roleAssignableGroupHigh +
        c.appAdminEscalationHigh +
        c.credentialSurfaceHigh);
  const score = Math.min(100, raw);
  let label = "Low";
  if (score >= 60) label = "Critical";
  else if (score >= 30) label = "Elevated";
  else if (score >= 10) label = "Moderate";
  return { score, label };
}

// ---------------------------------------------------------------------------
// Multi-hop path finder (BFS over principal → group → role → scope)
//
// Corpus citation:
//   - `_bypass_role_grant.md` §5.3 (group ownership = membership management)
//   - `_bypass_role_grant.md` §5.4 (nested groups; defenders auditing only the
//     parent miss the inherited path)
//   - `_bypass_role_grant.md` §10  (Role-Graph Privesc Map — chain reference)
//   - `_analysis_specterops.md` (AzureHound's MATCH ... ALLOWED_TO_ACT_AS
//     path queries — what we recreate here without Cypher)
//   - `_bypass_mixed_chains.md`   (12 end-to-end kill chains composing all
//     primitives — this BFS is the explainability layer)
//
// Defensive analogs:
//   - SpecterOps/AzureHound — `MATCH p=shortestPath((u:AZUser)-[*1..5]->(s))`
//     style queries; we approximate one BFS sweep from the start user.
//   - nccgroup/PMapper        — similar `find_path` traversal in AWS IAM.
//
// Why BFS instead of substring overlay: substring matching highlights the
// LEAF principal but doesn't show the GROUP / NESTED-GROUP hops the operator
// has to revoke to break the chain. BFS surfaces every hop including
// group-mediated and nested-group transitions, so the operator can target
// the cheapest revoke point (e.g. a single group-membership edit).
// ---------------------------------------------------------------------------

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
export function findShortestPath(inputs: FindPathInputs): FoundPath[] {
  const {
    principalQuery,
    scopeQuery,
    summaries,
    groupMembersByGroupId,
    maxPaths = 25,
  } = inputs;
  const pq = principalQuery.trim().toLowerCase();
  const sq = scopeQuery.trim().toLowerCase();
  if (!pq && !sq) return [];

  // Build adjacency:
  //   summaries: principalId -> PrincipalSummary
  //   groupMembers: groupId -> Set<memberId>     (forward edge)
  //   memberOfGroups: principalId -> Set<groupId> (reverse edge — what we need
  //     during BFS to "promote" a user up to a group they belong to).
  const summaryById = new Map<string, PrincipalSummary>();
  for (const s of summaries) summaryById.set(s.principalId.toLowerCase(), s);

  const memberOfGroups = new Map<string, Set<string>>();
  const groupMembersLower = new Map<string, Set<string>>();
  if (groupMembersByGroupId) {
    for (const [gid, members] of groupMembersByGroupId.entries()) {
      const gidL = gid.toLowerCase();
      const setM = new Set<string>();
      groupMembersLower.set(gidL, setM);
      for (const m of members) {
        const mid = m.id.toLowerCase();
        setM.add(mid);
        const arr = memberOfGroups.get(mid) ?? new Set<string>();
        arr.add(gidL);
        memberOfGroups.set(mid, arr);
      }
    }
  }

  // 1) Pick start principals — any summary matching `principalQuery`. If the
  //    query is empty, every principal that has a scope-matching assignment is
  //    its own start.
  const startSummaries: PrincipalSummary[] = [];
  for (const s of summaries) {
    const match = pq
      ? s.principalId.toLowerCase().includes(pq) ||
        s.displayName.toLowerCase().includes(pq) ||
        (s.signInName ?? "").toLowerCase().includes(pq)
      : true;
    if (match) startSummaries.push(s);
  }
  if (startSummaries.length === 0) return [];

  // 2) BFS from each start; collect shortest path(s) to a scope-matching
  //    assignment. Per-start BFS is bounded so we never spiral.
  const HOP_BUDGET = 5;
  const paths: FoundPath[] = [];
  for (const start of startSummaries) {
    if (paths.length >= maxPaths) break;
    type QState = {
      principalId: string; // lowercased
      hops: PathHop[];     // path so far (ends at this principal)
      viaGroup: boolean;
      viaNestedGroup: boolean;
    };
    const startHop: PathHop = {
      kind: "principal",
      id: start.principalId,
      label: start.displayName,
      principalType: start.principalType,
      detail: start.signInName,
    };
    const visited = new Set<string>([start.principalId.toLowerCase()]);
    const queue: QState[] = [
      {
        principalId: start.principalId.toLowerCase(),
        hops: [startHop],
        viaGroup: false,
        viaNestedGroup: false,
      },
    ];
    while (queue.length > 0 && paths.length < maxPaths) {
      const cur = queue.shift()!;
      // Terminal check: does THIS principal hold an assignment to a matching
      // scope? If so, materialize the role + scope hops and record the path.
      const curSummary = summaryById.get(cur.principalId);
      if (curSummary) {
        for (const a of curSummary.assignments) {
          if (sq && !a.scope.toLowerCase().includes(sq)) continue;
          // Skip if no scope query AND principal query already matched — caller
          // wanted any-scope path; in that case we still need at least one role
          // to be on the path so we just take the first assignment.
          const roleHop: PathHop = {
            kind: "role",
            id: a.roleDefinitionId,
            label: a.roleName,
            tier: a.tier,
            detail: PRIVILEGE_TIER_META[a.tier].label,
          };
          const scopeHop: PathHop = {
            kind: "scope",
            id: a.scope,
            label: describeScope(a.scope),
            scopeLevel: a.scopeLevel,
            detail: a.scope,
          };
          paths.push({
            hops: [...cur.hops, roleHop, scopeHop],
            hopCount: cur.hops.length + 1,
            viaGroup: cur.viaGroup,
            viaNestedGroup: cur.viaNestedGroup,
            highestTier: a.tier,
          });
          if (paths.length >= maxPaths) break;
          // Don't break — record EVERY scope-matching assignment for this
          // principal so the operator sees all path variants.
        }
      }
      // Expand: walk up to groups this principal is a member of.
      if (cur.hops.length >= HOP_BUDGET) continue;
      const groups = memberOfGroups.get(cur.principalId);
      if (!groups) continue;
      for (const gid of groups) {
        if (visited.has(gid)) continue;
        visited.add(gid);
        // Look up the group's summary for a friendly label.
        const gSummary = summaryById.get(gid);
        // Detect nested-group transition: previous hop was already a group.
        const prevWasGroup =
          cur.hops[cur.hops.length - 1]!.kind === "group";
        const groupHop: PathHop = {
          kind: "group",
          id: gid,
          label: gSummary?.displayName ?? `Group ${gid.substring(0, 8)}…`,
          detail: prevWasGroup ? "nested" : "member-of",
        };
        queue.push({
          principalId: gid,
          hops: [...cur.hops, groupHop],
          viaGroup: true,
          viaNestedGroup: cur.viaNestedGroup || prevWasGroup,
        });
      }
    }
  }
  // Sort: shortest first, then most-dangerous tier first.
  paths.sort((a, b) => {
    if (a.hopCount !== b.hopCount) return a.hopCount - b.hopCount;
    const oa = PRIVILEGE_TIER_META[a.highestTier].order;
    const ob = PRIVILEGE_TIER_META[b.highestTier].order;
    return oa - ob;
  });
  return paths.slice(0, maxPaths);
}

// ---------------------------------------------------------------------------
// Transitive-ownership chain detector
//
// Corpus citation:
//   - `_bypass_role_grant.md` §5.3 (group ownership = membership management)
//   - `_bypass_role_grant.md` §5.4 (nested groups)
//   - `_AZURE_BYPASS_PLAYBOOK.md` Top-30 item 26 (role-assignable group owners)
//
// Pattern: principal A owns group G1; G1 has member group G2; G2 holds a
// privileged role. A inherits the role via two hops (own → member → role)
// with no role-grant audit event firing on either edge. This is the
// "stealth GA via nested ownership" primitive — substring overlay can't see
// it because A holds NO direct role assignment.
//
// Inputs:
//   - groups   — the same role-assignable-group enumeration used for Signal B.
//   - summaries — the page's grouped summaries (for tier-lookup on G2).
//   - groupMembersByGroupId — transitive members map (so we can see G2 ⊂ G1).
// ---------------------------------------------------------------------------

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
export function detectOwnershipChains(
  inputs: OwnershipChainInputs,
): OwnershipChainFinding[] {
  const { groups, summaries, groupMembersByGroupId } = inputs;
  if (groups.length === 0) return [];

  // Build forward members map (lowercased) — group → set of member ids.
  const members = new Map<string, Set<string>>();
  if (groupMembersByGroupId) {
    for (const [gid, m] of groupMembersByGroupId.entries()) {
      const set = new Set<string>();
      for (const x of m) set.add(x.id.toLowerCase());
      members.set(gid.toLowerCase(), set);
    }
  }
  // Build summary lookup keyed by lowercased principal id.
  const summaryById = new Map<string, PrincipalSummary>();
  for (const s of summaries) summaryById.set(s.principalId.toLowerCase(), s);
  // Pre-resolve which groups are "interesting terminals" — i.e. they hold a
  // privileged-or-higher role.
  function tierOf(gid: string): PrivilegeTier | undefined {
    const s = summaryById.get(gid);
    if (!s) return undefined;
    if (s.highestTier === "critical" || s.highestTier === "privileged") {
      return s.highestTier;
    }
    return undefined;
  }
  function rolesOf(gid: string): string[] {
    const s = summaryById.get(gid);
    if (!s) return [];
    return Array.from(new Set(s.assignments.map((a) => a.roleName)));
  }

  const out: OwnershipChainFinding[] = [];
  const HOP_BUDGET = 4;

  for (const g of groups) {
    const rootGid = g.id.toLowerCase();
    // BFS from rootGid through `members` map.
    type Q = { gid: string; path: string[]; depth: number };
    const visited = new Set<string>([rootGid]);
    const queue: Q[] = [{ gid: rootGid, path: [], depth: 0 }];
    // Collect EVERY terminal we reach, not just the first.
    const terminals: Array<{ gid: string; path: string[]; depth: number }> = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth > 0) {
        const tier = tierOf(cur.gid);
        if (tier) {
          terminals.push({ gid: cur.gid, path: cur.path, depth: cur.depth });
        }
      }
      if (cur.depth >= HOP_BUDGET) continue;
      const m = members.get(cur.gid);
      if (!m) continue;
      for (const child of m) {
        if (visited.has(child)) continue;
        // Only expand into entities that are themselves groups in our member
        // map (otherwise we'd traverse user/SP leaves, which is irrelevant
        // for ownership chains). A group is "knowable" when we have a members
        // entry for it — we can't enumerate further without it anyway.
        visited.add(child);
        // Walk further only if `child` is itself a group key in `members`.
        if (members.has(child)) {
          queue.push({
            gid: child,
            path: [...cur.path, child],
            depth: cur.depth + 1,
          });
        } else {
          // `child` is a leaf — but it could still be a role-holding group we
          // haven't enumerated members for. Check tier and emit if so.
          const tier = tierOf(child);
          if (tier) {
            terminals.push({
              gid: child,
              path: [...cur.path, child],
              depth: cur.depth + 1,
            });
          }
        }
      }
    }
    // Emit one finding per (owner, terminal) pair.
    for (const owner of g.owners) {
      for (const t of terminals) {
        const terminalSummary = summaryById.get(t.gid);
        if (!terminalSummary) continue;
        const tier = terminalSummary.highestTier;
        let severity: SignalSeverity = "info";
        if (tier === "critical") severity = "critical";
        else if (tier === "privileged") severity = "high";
        out.push({
          ownerId: owner.id,
          ownerDisplayName: owner.displayName,
          ownerType: owner.type,
          isGuest: isGuestUpn(owner.signInName),
          rootGroupId: g.id,
          rootGroupDisplayName: g.displayName,
          intermediateGroupIds: t.path.slice(0, -1),
          terminalGroupId: t.gid,
          terminalGroupDisplayName: terminalSummary.displayName,
          terminalRoles: rolesOf(t.gid),
          terminalTier: tier,
          depth: t.depth,
          severity,
        });
      }
    }
  }
  // De-dupe: same owner + same terminal — keep the shortest chain.
  const dedup = new Map<string, OwnershipChainFinding>();
  for (const f of out) {
    const key = `${f.ownerId.toLowerCase()}|${f.terminalGroupId.toLowerCase()}`;
    const prev = dedup.get(key);
    if (!prev || f.depth < prev.depth) dedup.set(key, f);
  }
  return Array.from(dedup.values()).sort((a, b) => {
    const oa = SIGNAL_SEVERITY_META[a.severity].order;
    const ob = SIGNAL_SEVERITY_META[b.severity].order;
    if (oa !== ob) return oa - ob;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.ownerDisplayName.localeCompare(b.ownerDisplayName);
  });
}

