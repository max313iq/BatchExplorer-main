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
export function riskScore(
  principal: PrivilegedPrincipal,
  signalLift?: number,
): number {
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
  // Corpus-derived signal uplift — see SIGNAL_RISK_WEIGHTS in this file
  // for the rationale (critical=1500 to dominate any T0 baseline). Caller
  // sums the SIGNAL_RISK_WEIGHTS[severity] across every active finding
  // for the principal and passes the total here. Optional so existing
  // call-sites that don't yet track signals stay correct.
  if (typeof signalLift === "number" && Number.isFinite(signalLift)) {
    score += Math.max(0, signalLift);
  }
  return score;
}

/**
 * Lookup-driven comparator factory. Sorts highest-risk principals first
 * while accounting for the corpus-signal uplift the caller already
 * computed per principal. When no lookup is provided behaves identically
 * to `compareByRiskScore`.
 *
 * Citation rationale: `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender
 * Audit Surface" — active indicators outweigh static role tier.
 */
export function compareByRiskScoreWithSignals(
  signalLiftById: ReadonlyMap<string, number>,
): (a: PrivilegedPrincipal, b: PrivilegedPrincipal) => number {
  return (a, b) => {
    const ra = riskScore(a, signalLiftById.get(a.id) ?? 0);
    const rb = riskScore(b, signalLiftById.get(b.id) ?? 0);
    if (ra !== rb) return rb - ra;
    return a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: "base",
    });
  };
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

// ===========================================================================
// Corpus-derived detection signals (defensive enumeration only)
//
// All four signal types below are READ-ONLY drift-from-baseline indicators.
// They were wired in after re-reading the curated playbooks at:
//   C:\Users\baimgprodsesa1\Desktop\New folder\_AZURE_BYPASS_PLAYBOOK.md
//     §"Critical Defender Audit Surface" items 3, 4, 5, 6, 7.
//
// Per Top-30 across the corpus:
//   A. App-role + addKey chain          — Top-30 #23 / #9
//   B. Federated identity credentials   — Top-30 #17
//   C. PIM noExpiration eligibility     — Top-30 #27
//   D. Temporary Access Pass issuance   — Top-30 #13
//
// These are NEVER invoked — the page consumes them via read-only Graph
// enumeration and surfaces deltas to the operator. No `addKey`,
// `addPassword`, role-grant, TAP-issue, or PIM-create primitives are
// reachable from this page.
// ===========================================================================

/**
 * Microsoft Graph SP app-id (well-known). Holding any "RW" Graph app-role
 * on this principal is the canonical takeover lever — see
 * `_bypass_role_grant.md` §3.1 "Application.ReadWrite.All → app-only GA".
 */
export const MICROSOFT_GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";

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
export const HIGH_PRIV_GRAPH_APP_ROLES: ReadonlyMap<string, string> = new Map([
  // Application.ReadWrite.All
  ["1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9", "Application.ReadWrite.All"],
  // RoleManagement.ReadWrite.Directory
  ["9e3f62cf-ca93-4989-b6ce-bf83c28f9fe8", "RoleManagement.ReadWrite.Directory"],
  // Directory.ReadWrite.All
  ["19dbc75e-c2e2-444c-a770-ec69d8559fc7", "Directory.ReadWrite.All"],
  // AppRoleAssignment.ReadWrite.All
  ["06b708a9-e830-4db3-a914-8e69da51d44f", "AppRoleAssignment.ReadWrite.All"],
  // Domain.ReadWrite.All
  ["7e05723c-0bb0-42da-be95-ae9f08a6e53c", "Domain.ReadWrite.All"],
]);

/**
 * Window for "recent" credential-write detection on a privileged SP.
 * Anything added inside this window is flagged as "addKey/addPassword
 * sentinel" — matches Defender audit item 5 in the master playbook.
 */
export const RECENT_CREDENTIAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Window for "recent" TAP issuance to a privileged user. The master
 * playbook (item 3) treats this as the critical Defender audit signal
 * for "Issue temporary access pass".
 */
export const RECENT_TAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * OIDC issuer hosts that the corpus flags as "public clouds where a
 * federated credential maps to a low-trust principal". Pointing a
 * privileged SP at one of these is the WIF backdoor pattern from
 * `_bypass_tenant_switch.md` / `_bypass_role_grant.md` §6.
 */
export const PUBLIC_FEDERATION_ISSUER_HOSTS: ReadonlyArray<string> = [
  "token.actions.githubusercontent.com",
  "gitlab.com",
  "vstoken.actions.githubusercontent.com",
  "circleci.com",
  "oidc.circleci.com",
];

/**
 * Best-effort parse of an OIDC issuer URL down to its hostname. Tolerates
 * issuers stored without a scheme (some tenants record `github.com` not
 * `https://github.com`).
 */
export function issuerHost(issuer: string | undefined | null): string {
  if (!issuer) return "";
  const trimmed = issuer.trim();
  if (!trimmed) return "";
  try {
    return new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`,
    ).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * True when `issuer` resolves to a host in PUBLIC_FEDERATION_ISSUER_HOSTS.
 * Used by Signal B grading.
 */
export function isPublicFederationIssuer(
  issuer: string | undefined | null,
): boolean {
  const host = issuerHost(issuer);
  if (!host) return false;
  return PUBLIC_FEDERATION_ISSUER_HOSTS.some(
    (h) => host === h || host.endsWith("." + h),
  );
}

// ----- Signal A — High-privilege Graph permissions held by an SP ---------

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

// ----- Signal B — Federated identity credentials on a privileged SP -------

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

// ----- Signal C — PIM eligibility with `noExpiration` --------------------

/**
 * Citation: `_bypass_staged_pim.md` §2 + §5.1 "The 'time bomb'"
 *           `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #27
 *
 * Detection rule: any roleEligibility schedule with
 * `scheduleInfo.expiration.type === "noExpiration"` on a Tier-0 role is
 * critical — that is exactly the stealth-persistence shape the playbook
 * teaches.
 */
export type PimExpirationKind =
  | "noExpiration"
  | "afterDateTime"
  | "afterDuration"
  | "unknown";

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

// ----- Signal D — Recent Temporary Access Pass issuance ------------------

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

// ----- Severity helper used by all four signal categories ----------------

export type FindingSeverity = "critical" | "high" | "medium" | "info";

export interface SeverityMeta {
  label: string;
  description: string;
  badgeVariant: "destructive" | "warning" | "info" | "secondary";
}

export const SEVERITY_META: Record<FindingSeverity, SeverityMeta> = {
  critical: {
    label: "Critical",
    description:
      "Matches a high-confidence corpus indicator on a Tier-0 principal. Investigate today.",
    badgeVariant: "destructive",
  },
  high: {
    label: "High",
    description:
      "Matches a corpus indicator on a Tier-0/Tier-1 principal, or a Tier-0 indicator with recency.",
    badgeVariant: "warning",
  },
  medium: {
    label: "Medium",
    description:
      "Drift-from-baseline indicator that warrants periodic review.",
    badgeVariant: "info",
  },
  info: {
    label: "Info",
    description:
      "Worth keeping in inventory; no immediate action implied.",
    badgeVariant: "secondary",
  },
};

/**
 * Severity for a Signal-A finding (high-privilege Graph permissions on SP).
 *
 * - critical when there's a recent credential ON TOP OF Application.RW.All
 *   or RoleManagement.RW.Directory (the canonical chain about to fire).
 * - high when the SP holds a chainable permission set.
 * - medium otherwise (single permission, no recent cred).
 */
export function gradeHighPrivGraphPermission(
  finding: HighPrivGraphPermissionFinding,
): FindingSeverity {
  const names = new Set(finding.permissions.map((p) => p.permissionName));
  const isCanonicalChain =
    names.has("Application.ReadWrite.All") ||
    names.has("RoleManagement.ReadWrite.Directory") ||
    names.has("AppRoleAssignment.ReadWrite.All");
  if (isCanonicalChain && finding.hasRecentCredential) return "critical";
  if (isCanonicalChain) return "high";
  if (names.size >= 2) return "high";
  return "medium";
}

/**
 * Severity for a Signal-B finding (federated credentials).
 *
 * Public OIDC issuer on a high-privilege SP is the WIF backdoor shape —
 * `_bypass_role_grant.md` §6. Tagged "high" by default; "critical" when
 * combined with a recent credential add on the same SP (caller passes
 * `companionAddKeyRecent`).
 */
export function gradeFederatedCredential(
  finding: FederatedCredentialFinding,
  companionAddKeyRecent: boolean,
): FindingSeverity {
  if (finding.isPublicIssuer && companionAddKeyRecent) return "critical";
  if (finding.isPublicIssuer) return "high";
  return "medium";
}

/**
 * Severity for a Signal-C finding (PIM eligibility).
 *
 * `noExpiration` on Tier-0 is the time-bomb pattern from
 * `_bypass_staged_pim.md` §5.1 — always critical.
 */
export function gradePimEligibility(
  finding: PimEligibilityFinding,
): FindingSeverity {
  if (finding.expirationKind === "noExpiration") {
    if (finding.tier === "tier0") return "critical";
    if (finding.tier === "tier1") return "high";
    return "medium";
  }
  if (finding.tier === "tier0") return "medium";
  return "info";
}

/**
 * Severity for a Signal-D finding (recent TAP).
 *
 * A TAP issued to a Tier-0 principal in the last 30 days is the canonical
 * "MFA-equivalent persistence pass" pattern — `_AZURE_BYPASS_PLAYBOOK.md`
 * item 3.
 */
export function gradeTapIssuance(
  finding: TapIssuanceFinding,
): FindingSeverity {
  if (finding.isRecentToTierZero && finding.userTier === "tier0") {
    return "critical";
  }
  if (finding.userTier === "tier0" || finding.userTier === "tier1") {
    return "high";
  }
  return "medium";
}

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
export const SIGNAL_RISK_WEIGHTS: Record<FindingSeverity, number> = {
  critical: 1500,
  high: 400,
  medium: 60,
  info: 5,
};
