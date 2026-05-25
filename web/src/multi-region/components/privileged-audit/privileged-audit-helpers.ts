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

import {
  ROLE_AUTHENTICATION_ADMIN,
  ROLE_DIRECTORY_READER,
  ROLE_GLOBAL_ADMIN,
  ROLE_GLOBAL_READER,
  ROLE_HELPDESK_ADMIN,
  ROLE_PRIVILEGED_AUTH_ADMIN,
  ROLE_USER_ADMIN,
} from "../../services/graph-service";

// ===========================================================================
// Tier model
// ===========================================================================

export type RoleTier = "tier0" | "tier1" | "tier2" | "tier3" | "other";

export interface TierMeta {
  /** Display label shown on the badge / chip. */
  label: string;
  /** Short description used in tooltips and the legend. */
  description: string;
  /** Sort weight, smaller = more privileged. */
  order: number;
  /** Badge variant (matches shared `<Badge>` variants). */
  badgeVariant:
    | "destructive"
    | "warning"
    | "info"
    | "secondary"
    | "outline";
  /** Tone for `<SummaryStatItem>` (matches `SummaryStatTone`). */
  statTone: "destructive" | "warning" | "info" | "success" | "muted";
}

export const TIER_META: Record<RoleTier, TierMeta> = {
  tier0: {
    label: "Tier 0 — Global",
    description:
      "Full directory control. Can manage every other role and grant any permission. Includes Global Administrator and Privileged Role Administrator.",
    order: 0,
    badgeVariant: "destructive",
    statTone: "destructive",
  },
  tier1: {
    label: "Tier 1 — Sensitive",
    description:
      "High blast radius. Can manage authentication methods, user passwords, or workload identities. Includes Authentication, User, Application, and Cloud Application Administrators.",
    order: 1,
    badgeVariant: "warning",
    statTone: "warning",
  },
  tier2: {
    label: "Tier 2 — Operational",
    description:
      "Day-to-day admin. Helpdesk, password, groups, license, directory-write operations. Limited blast radius but plentiful escalation primitives.",
    order: 2,
    badgeVariant: "info",
    statTone: "info",
  },
  tier3: {
    label: "Tier 3 — Read",
    description:
      "Read-only operators. Includes Global Reader, Directory Reader, Security Reader, Reports Reader. Cannot mutate state.",
    order: 3,
    badgeVariant: "secondary",
    statTone: "muted",
  },
  other: {
    label: "Other",
    description:
      "Directory role not recognised by this tool's classification table. Treat as 'investigate' until it can be added to the tier map.",
    order: 4,
    badgeVariant: "outline",
    statTone: "muted",
  },
};

/**
 * Tier 0 — full directory control.
 *
 * Privileged Role Administrator earns Tier 0 because it can grant
 * Global Administrator to any principal, which makes it functionally
 * equivalent. SkyArk highlights this exact pivot explicitly.
 *
 * Partner Tier2 Support (`e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8`) sits
 * here because Microsoft support engineers can be elevated to global-
 * admin equivalent inside customer tenants.
 */
const TIER0_TEMPLATE_IDS = new Set<string>([
  ROLE_GLOBAL_ADMIN,
  "e8611ab8-c189-46e8-94e1-60213ab1f814", // Privileged Role Administrator
  "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8", // Partner Tier2 Support
]);

/**
 * Tier 1 — high-impact identity / app management. Anything in this set
 * can either reset another user's credentials, mint workload identities,
 * or own app-permission grants that escalate to Graph admin scopes.
 */
const TIER1_TEMPLATE_IDS = new Set<string>([
  ROLE_PRIVILEGED_AUTH_ADMIN,
  ROLE_AUTHENTICATION_ADMIN,
  ROLE_USER_ADMIN,
  "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3", // Application Administrator
  "158c047a-c907-4556-b7ef-446551a6b5f7", // Cloud Application Administrator
  "29232cdf-9323-42fd-ade2-1d097af3e4de", // Exchange Administrator
  "f28a1f50-f6e7-4571-818b-6a12f2af6b6c", // SharePoint Administrator
  "966707d0-3269-4727-9be2-8c3a10f19b9d", // Password Administrator (Tier 1 because it's coupled with user-admin escalation in many tenants)
]);

/**
 * Tier 2 — operational helpdesk / license / group admin roles. Each
 * one is bounded but plentiful enough that compromised holders are a
 * cheap pivot to a Tier 1 target.
 */
const TIER2_TEMPLATE_IDS = new Set<string>([
  ROLE_HELPDESK_ADMIN,
  "9360feb5-f418-4baa-8175-e2a00bac4301", // Directory Writers
  "fdd7a751-b60b-444a-984c-02652fe8fa1c", // Groups Administrator
  "4d6ac14f-3453-41d0-bef9-a3e0c569773a", // License Administrator
]);

/**
 * Tier 3 — read-only. Still privileged enough to enumerate every user,
 * group, role and policy in the tenant — exactly the data SkyArk needs
 * to operate — but they cannot mutate state.
 */
const TIER3_TEMPLATE_IDS = new Set<string>([
  ROLE_GLOBAL_READER,
  ROLE_DIRECTORY_READER,
  "5d6b6bb7-de71-4623-b4af-96380a352509", // Security Reader
  "4a5d8f65-41da-4de4-8968-e035b65339cf", // Reports Reader
]);

/**
 * Fallback classification by lower-case displayName for tenants where
 * a role's template-id isn't in our hardcoded set (e.g. preview roles
 * Microsoft hasn't published a stable GUID for, or custom roles whose
 * name follows the standard convention).
 */
const TIER_BY_DISPLAY_NAME: Array<[RegExp, RoleTier]> = [
  // Tier 0 ─────────────────────────────────────────────────────────────
  [/^global admin/i, "tier0"],
  [/^company admin/i, "tier0"],
  [/^privileged role admin/i, "tier0"],
  [/^partner tier ?2 support/i, "tier0"],
  // Tier 1 ─────────────────────────────────────────────────────────────
  [/^privileged authentication admin/i, "tier1"],
  [/^authentication admin/i, "tier1"],
  [/^user admin/i, "tier1"],
  [/^application admin/i, "tier1"],
  [/^cloud application admin/i, "tier1"],
  [/^exchange (admin|recipient admin)/i, "tier1"],
  [/^sharepoint admin/i, "tier1"],
  [/^password admin/i, "tier1"],
  [/^conditional access admin/i, "tier1"],
  [/^security admin/i, "tier1"],
  // Tier 2 ─────────────────────────────────────────────────────────────
  [/^helpdesk admin/i, "tier2"],
  [/^directory writers?/i, "tier2"],
  [/^groups admin/i, "tier2"],
  [/^license admin/i, "tier2"],
  [/^teams admin/i, "tier2"],
  [/^intune admin/i, "tier2"],
  // Tier 3 ─────────────────────────────────────────────────────────────
  [/^global reader/i, "tier3"],
  [/^directory reader/i, "tier3"],
  [/^security reader/i, "tier3"],
  [/^reports reader/i, "tier3"],
  [/^message center reader/i, "tier3"],
  [/^reader$/i, "tier3"],
];

/**
 * Classify a directory role into one of the four tiers. Falls back to
 * `"other"` for unknown roles so the UI never crashes when Microsoft
 * adds a new built-in role between releases.
 */
export function classifyRole(
  roleTemplateId: string | undefined,
  displayName: string | undefined,
): RoleTier {
  if (roleTemplateId) {
    if (TIER0_TEMPLATE_IDS.has(roleTemplateId)) return "tier0";
    if (TIER1_TEMPLATE_IDS.has(roleTemplateId)) return "tier1";
    if (TIER2_TEMPLATE_IDS.has(roleTemplateId)) return "tier2";
    if (TIER3_TEMPLATE_IDS.has(roleTemplateId)) return "tier3";
  }
  if (displayName) {
    for (const [pattern, tier] of TIER_BY_DISPLAY_NAME) {
      if (pattern.test(displayName)) return tier;
    }
  }
  return "other";
}

/**
 * True when the role's template id matches Privileged Role Administrator —
 * a role that can grant Global Administrator to any principal. SkyArk
 * flags this as a "stealth Global Admin" because the holder doesn't
 * appear in the Global Admin list itself.
 */
export const ROLE_PRIVILEGED_ROLE_ADMIN =
  "e8611ab8-c189-46e8-94e1-60213ab1f814";

export function isPrivilegedRoleAdmin(templateId: string | undefined): boolean {
  return templateId === ROLE_PRIVILEGED_ROLE_ADMIN;
}

// ===========================================================================
// Principal & assignment model
// ===========================================================================

export type PrincipalType = "User" | "Group" | "ServicePrincipal" | "Unknown";

export type AssignmentPath = "direct" | "group" | "sp" | "guest";

export interface AssignmentPathMeta {
  label: string;
  description: string;
  badgeVariant: "secondary" | "warning" | "info" | "destructive";
}

export const ASSIGNMENT_PATH_META: Record<AssignmentPath, AssignmentPathMeta> = {
  direct: {
    label: "Direct",
    description: "User is a direct member of the directory role.",
    badgeVariant: "secondary",
  },
  group: {
    label: "Via group",
    description:
      "Principal inherits the role transitively through group membership. Frequently overlooked because the principal does not appear in the role's direct member list.",
    badgeVariant: "warning",
  },
  sp: {
    label: "Service principal",
    description:
      "A workload identity (app, managed identity, third-party service principal) holds the role. Compromise can persist beyond any human admin's departure.",
    badgeVariant: "info",
  },
  guest: {
    label: "Guest",
    description:
      "External (cross-tenant) user holds the role. Privileged access often outlives the business relationship that originally granted it.",
    badgeVariant: "destructive",
  },
};

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

// ===========================================================================
// UPN / classification helpers
// ===========================================================================

/**
 * True when the UPN looks like a B2B guest. The canonical guest UPN
 * shape is `<displayemail>_<homedomain>#EXT#@<thistenant>.onmicrosoft.com`
 * so the `#EXT#` substring is a reliable signal.
 */
export function isExternalUpn(upn: string | undefined | null): boolean {
  if (!upn) return false;
  return upn.toUpperCase().includes("#EXT#");
}

/**
 * Pick the principal's "highest-privilege" tier across all its
 * assignments. Returns "other" if the principal has no assignments.
 */
export function highestTier(assignments: AssignmentDetail[]): RoleTier {
  if (assignments.length === 0) return "other";
  let best: RoleTier = "other";
  let bestOrder = TIER_META.other.order;
  for (const a of assignments) {
    const order = TIER_META[a.tier].order;
    if (order < bestOrder) {
      best = a.tier;
      bestOrder = order;
    }
  }
  return best;
}

/**
 * True when the assignment list constitutes a "shadow admin" path —
 * i.e. anything that's not a plain Direct user assignment. SP and
 * Group paths both qualify; Guest-Direct also qualifies because the
 * principal is external.
 */
export function hasShadowAdminPath(
  assignments: AssignmentDetail[],
  isExternal: boolean,
): boolean {
  if (isExternal) return true;
  return assignments.some((a) => a.path !== "direct");
}

// ===========================================================================
// Deep-link builder
// ===========================================================================

/**
 * Compose a deep link into the Azure portal that opens the principal's
 * Entra-ID profile blade in the correct tenant. Works for users; for
 * groups + SPs we degrade to the directory-object lookup which the
 * portal will resolve into the appropriate blade.
 */
export function portalDeepLink(
  tenantId: string,
  principal: Pick<PrivilegedPrincipal, "id" | "type">,
): string {
  const base = "https://portal.azure.com";
  if (principal.type === "User") {
    return (
      `${base}/#@${encodeURIComponent(tenantId)}` +
      `/blade/Microsoft_AAD_IAM/UserDetailsMenuBlade/Profile/userId/` +
      encodeURIComponent(principal.id)
    );
  }
  if (principal.type === "Group") {
    return (
      `${base}/#@${encodeURIComponent(tenantId)}` +
      `/blade/Microsoft_AAD_IAM/GroupDetailsMenuBlade/Overview/groupId/` +
      encodeURIComponent(principal.id)
    );
  }
  if (principal.type === "ServicePrincipal") {
    return (
      `${base}/#@${encodeURIComponent(tenantId)}` +
      `/blade/Microsoft_AAD_IAM/ManagedAppMenuBlade/Overview/objectId/` +
      encodeURIComponent(principal.id)
    );
  }
  return (
    `${base}/#@${encodeURIComponent(tenantId)}` +
    `/blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/Overview`
  );
}

// ===========================================================================
// Group blast-radius
// ===========================================================================

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
export function isHighBlastRadiusGroup(
  group: PrivilegedGroup,
  threshold = 10,
): boolean {
  return group.topTier === "tier0" && group.transitiveUserCount > threshold;
}

// ===========================================================================
// Sorting helpers
// ===========================================================================

/** Tier-then-name sort comparator used by the privileged-identity list. */
export function compareByTierThenName(
  a: PrivilegedPrincipal,
  b: PrivilegedPrincipal,
): number {
  const oa = TIER_META[a.topTier].order;
  const ob = TIER_META[b.topTier].order;
  if (oa !== ob) return oa - ob;
  return a.displayName.localeCompare(b.displayName, undefined, {
    sensitivity: "base",
  });
}

// ===========================================================================
// Risk score (highest-privilege-first ordering)
// ===========================================================================

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
export const STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

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
export function riskScore(principal: PrivilegedPrincipal): number {
  const weights: Record<RoleTier, number> = {
    tier0: 1000,
    tier1: 100,
    tier2: 10,
    tier3: 1,
    other: 0,
  };
  // Unique roles by id — a principal holding the same role through three
  // groups should not score 3x for it.
  const uniqueRoleTiers = new Map<string, RoleTier>();
  for (const a of principal.assignments) {
    uniqueRoleTiers.set(a.roleId, a.tier);
  }
  let score = 0;
  for (const tier of uniqueRoleTiers.values()) score += weights[tier];
  if (
    principal.isExternal &&
    (principal.topTier === "tier0" || principal.topTier === "tier1")
  ) {
    score += 500;
  }
  if (principal.isShadowAdmin) score += 200;
  if (principal.isServicePrincipal) score += 50;
  return score;
}

/**
 * Risk-then-name comparator. Sorts highest-risk principals first.
 */
export function compareByRiskScore(
  a: PrivilegedPrincipal,
  b: PrivilegedPrincipal,
): number {
  const ra = riskScore(a);
  const rb = riskScore(b);
  if (ra !== rb) return rb - ra; // desc — highest risk first
  return a.displayName.localeCompare(b.displayName, undefined, {
    sensitivity: "base",
  });
}

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
export function isStalePrincipal(
  principal: PrivilegedPrincipal,
  now: number = Date.now(),
): boolean {
  if (principal.type === "ServicePrincipal" && principal.createdDateTime) {
    const ts = new Date(principal.createdDateTime).getTime();
    if (!Number.isFinite(ts)) return false;
    return now - ts > STALE_THRESHOLD_MS;
  }
  if (principal.type === "User" && !principal.signInName && !principal.isExternal) {
    return true;
  }
  return false;
}

// ===========================================================================
// Role-scoped portal deep-link
// ===========================================================================

/**
 * Portal deep-link to the "Assignments" blade of a specific directory role.
 * Useful for "open this role in the portal" affordances next to the role
 * chip in the expanded assignment-detail list.
 */
export function roleDeepLink(tenantId: string, roleId: string): string {
  const base = "https://portal.azure.com";
  return (
    `${base}/#@${encodeURIComponent(tenantId)}` +
    `/blade/Microsoft_AAD_IAM/RoleMenuBlade/AdminRoles/roleId/` +
    encodeURIComponent(roleId)
  );
}
