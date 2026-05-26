/**
 * Privileged Users & Shadow Admin Auditor — defensive port of the
 * concepts from CyberArk's SkyArk into the tenant-admin WebUI.
 *
 * Goal: surface every principal in the operator's active tenant that
 * holds a directory role, including the assignments that the Azure-
 * portal "Roles & administrators" blade hides — group-mediated
 * memberships, service-principal-held roles, and cross-tenant guest
 * privileges. The page is read-only by design (defensive auditing,
 * not privilege management).
 *
 * Sections (matches the spec):
 *   A. Top stat row — totals per tier, shadow-admin / SP / guest counts.
 *   B. Privileged identity list — every holder, with tier badge, role
 *      list, assignment-path chips, deep-link to portal, expandable
 *      per-role detail.
 *   C. Shadow admin paths — every non-direct escalation route as a
 *      "Alice → via group GA-Owners → Global Admin (Tier 0)" row.
 *      Privileged Role Administrators destructive Alert at the top.
 *   D. Groups holding privileged roles — direct vs transitive member
 *      counts, "high blast radius" callout for Tier 0 groups > 10
 *      transitive members.
 *   E. Service principals with privileged roles — flag suspicious
 *      newcomers (recent createdDateTime + Tier 0 role).
 *
 * Hard constraints honoured:
 *   - New files only (under components/privileged-audit/).
 *   - No edits to services / auth / store / page-router / sidebar-nav.
 *   - No new npm deps.
 *   - All probes read-only — no POST/PATCH/DELETE.
 *   - Pagination handled via `@odata.nextLink`.
 *   - Graph permission failures degrade per-probe with inline warnings
 *     rather than blanking the whole page.
 */
import * as React from "react";
import {
  AlertTriangle,
  Bomb,
  ChevronDown,
  ChevronRight,
  Clock,
  EyeOff,
  ExternalLink,
  Filter as FilterIcon,
  GitBranch,
  KeyRound,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Ticket,
  Users,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, downloadJson, formatRelativeTime } from "@/lib/utils";

import {
  decodeJwtClaimsUnsafe,
  getActiveTenant,
  getGraphTokenForAccount,
} from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { auditLog } from "../../services/audit-log";
import {
  getPrincipalsByIds,
  type ResolvedPrincipal,
} from "../../services/graph-service";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { useMultiRegionState } from "../../store/store-context";

import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import {
  DataTable,
  type DataTableColumn,
} from "../shared/enhanced-table";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

import {
  ASSIGNMENT_PATH_META,
  EMPTY_WATCHLIST,
  HIGH_PRIV_GRAPH_APP_ROLES,
  MICROSOFT_GRAPH_APP_ID,
  MIXED_CHAIN_WINDOW_MS,
  PRIVILEGED_AUDIT_ACTION_PREFIX,
  RECENT_CREDENTIAL_WINDOW_MS,
  RECENT_TAP_WINDOW_MS,
  ROLE_DIRECTORY_SYNC_ACCOUNTS,
  SEVERITY_META,
  SIGNAL_RISK_WEIGHTS,
  STALE_THRESHOLD_MS,
  TIER0_WATCHLIST_STORAGE_KEY_PREFIX,
  TIER_META,
  buildMixedChainFindings,
  classifyRole,
  compareByRiskScoreWithSignals,
  compareByTierThenName,
  computeWatchlistDrift,
  gradeFederatedCredential,
  gradeHighPrivGraphPermission,
  gradePimEligibility,
  gradePimGroupEligibility,
  gradeSyncAccount,
  gradeTapIssuance,
  hasShadowAdminPath,
  highestTier,
  isExternalUpn,
  isHighBlastRadiusGroup,
  isPrivilegedRoleAdmin,
  isPublicFederationIssuer,
  isStalePrincipal,
  looksLikeSyncAccount,
  portalDeepLink,
  riskScore,
  roleDeepLink,
  type AssignmentDetail,
  type AssignmentPath,
  type FederatedCredentialFinding,
  type FindingSeverity,
  type HighPrivGraphPermissionFinding,
  type MixedChainFinding,
  type PimEligibilityFinding,
  type PimExpirationKind,
  type PimGroupEligibilityFinding,
  type PrincipalType,
  type PrivilegedGroup,
  type PrivilegedPrincipal,
  type RoleTier,
  type ShadowAdminPath,
  type SyncAccountFinding,
  type TapIssuanceFinding,
  type WatchlistDrift,
  type WatchlistEntry,
  type WatchlistState,
} from "./privileged-audit-helpers";
import { useShortcut } from "../../hooks/use-shortcut";
import type { AuditEntry } from "../../services/audit-log";

// ===========================================================================
// Constants
// ===========================================================================

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Blast-radius threshold: Tier 0 groups with more transitive members
 * than this trigger the "high blast radius" highlight in section D.
 * Matches the spec.
 */
const HIGH_BLAST_RADIUS_THRESHOLD = 10;

/**
 * "Recently created" window for service principals. SkyArk highlights
 * SPs that hold high-privilege roles AND were created in the last
 * 30 days as a "fresh implant" indicator.
 */
const RECENT_SP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ===========================================================================
// Types
// ===========================================================================

type LoadStatus = "idle" | "loading" | "ok" | "error";

interface ProbeWarning {
  /** Stable key for React lists. */
  id: string;
  message: string;
}

interface PrivilegedAuditDataset {
  /** All privileged identities (users + SPs that hold roles, including
   *  shadow admins inherited via group). Keyed by principal id. */
  principals: PrivilegedPrincipal[];
  /** Every shadow-admin escalation path discovered, one row per path. */
  shadowPaths: ShadowAdminPath[];
  /** All groups that directly hold one or more privileged roles. */
  groups: PrivilegedGroup[];
  /** Service principals that hold one or more privileged roles. */
  servicePrincipals: PrivilegedPrincipal[];
  /** Soft per-probe warnings (Graph permission deferrals, partial data). */
  warnings: ProbeWarning[];
  /** Activated directory roles found in the tenant, for context. */
  activatedRoleCount: number;
  /** Signal A — SPs holding high-priv Graph permissions. Corpus:
   *  `_bypass_role_grant.md` §3.1 + `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #23. */
  highPrivGraphPermissions: HighPrivGraphPermissionFinding[];
  /** Signal B — Federated identity credentials on privileged SPs. Corpus:
   *  `_bypass_role_grant.md` §6 + `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #17. */
  federatedCredentials: FederatedCredentialFinding[];
  /** Signal C — PIM eligibility with `noExpiration` on privileged roles.
   *  Corpus: `_bypass_staged_pim.md` §5.1 + Top-30 #27. */
  pimEligibilities: PimEligibilityFinding[];
  /** Signal D — TAP issuances to privileged users. Corpus:
   *  `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface" #3 + Top-30 #13. */
  tapIssuances: TapIssuanceFinding[];
  /** Signal E — AAD Connect / Cloud Sync sync-account drift. Corpus:
   *  `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #19 + `_bypass_mixed_chains.md` chain #1
   *  + `_analysis_dirkjanm.md` adconnectdump. */
  syncAccountFindings: SyncAccountFinding[];
  /** Signal G — PIM-for-Groups eligibility on role-assignable groups. Corpus:
   *  `_bypass_staged_pim.md` §6 + Top-30 #28. */
  pimGroupEligibilities: PimGroupEligibilityFinding[];
  /** Signal F — Mixed-chain temporal correlation across A/B/C/D. Corpus:
   *  `_bypass_mixed_chains.md`. Derived in the page, NOT in the probe — it
   *  composes A/B/C/D after they're collected. Carried on the dataset so
   *  callers (exports, drift detection) see the same shape. */
  mixedChainFindings: MixedChainFinding[];
}

const EMPTY_DATASET: PrivilegedAuditDataset = {
  principals: [],
  shadowPaths: [],
  groups: [],
  servicePrincipals: [],
  warnings: [],
  activatedRoleCount: 0,
  highPrivGraphPermissions: [],
  federatedCredentials: [],
  pimEligibilities: [],
  tapIssuances: [],
  syncAccountFindings: [],
  pimGroupEligibilities: [],
  mixedChainFindings: [],
};

interface DirectoryRoleSummary {
  id: string;
  roleTemplateId: string;
  displayName: string;
  tier: RoleTier;
}

interface RoleMemberRef {
  /** Object id of the member principal as returned by Graph. */
  id: string;
  /** Inferred type from the @odata.type discriminator. */
  type: PrincipalType;
}

// ===========================================================================
// Graph wrappers (page-local — keeps the spec's "no services edits" rule).
// ===========================================================================

/**
 * Authorization + content-negotiation headers for every direct Graph
 * call this page makes. We deliberately do NOT route through
 * `services/graph-service` for endpoints it doesn't already cover, so
 * the spec's "services unchanged" rule holds.
 */
function graphHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

/**
 * Drain every page of a Graph collection. `@odata.nextLink` is followed
 * until exhausted, so the auditor never silently truncates after the
 * first 100 / 999 rows.
 */
async function fetchAllPages<T>(
  startUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = startUrl;
  while (url) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const response = await fetch(url, {
      headers: graphHeaders(token),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const inner = (body as Record<string, unknown>)?.error as
        | Record<string, unknown>
        | undefined;
      const msg =
        (inner?.message as string | undefined) ??
        `Graph request failed (${response.status})`;
      const err = new Error(msg);
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }
    const data = (await response.json()) as {
      value?: T[];
      "@odata.nextLink"?: string;
    };
    if (Array.isArray(data.value)) out.push(...data.value);
    url = data["@odata.nextLink"];
  }
  return out;
}

/**
 * Map a Graph member object's `@odata.type` discriminator to one of
 * our internal `PrincipalType` enum values.
 */
function odataTypeToPrincipalType(raw: unknown): PrincipalType {
  const lower = String(raw ?? "").toLowerCase();
  if (lower.endsWith(".user")) return "User";
  if (lower.endsWith(".group")) return "Group";
  if (lower.endsWith(".serviceprincipal")) return "ServicePrincipal";
  return "Unknown";
}

/**
 * Run the full privileged-audit probe against a tenant. The function
 * is fail-soft: individual sub-probes that fail (Graph 403 because
 * `Directory.Read.All` isn't granted, etc.) produce a warning rather
 * than aborting the entire run.
 */
async function probeTenant(
  tenantId: string,
  token: string,
  signal?: AbortSignal,
): Promise<PrivilegedAuditDataset> {
  const warnings: ProbeWarning[] = [];

  // ---- 1. Enumerate activated directory roles ----------------------------
  let roles: DirectoryRoleSummary[] = [];
  try {
    const raw = await fetchAllPages<Record<string, unknown>>(
      `${GRAPH_BASE}/directoryRoles?$select=id,displayName,roleTemplateId`,
      token,
      signal,
    );
    roles = raw.map((r) => {
      const templateId = String(r.roleTemplateId ?? "");
      const displayName = String(r.displayName ?? "");
      return {
        id: String(r.id ?? ""),
        roleTemplateId: templateId,
        displayName,
        tier: classifyRole(templateId, displayName),
      };
    });
  } catch (err) {
    warnings.push({
      id: "directoryRoles",
      message:
        `Could not enumerate directory roles. Graph said: ${(err as Error).message}. ` +
        "Make sure the signed-in account has Directory.Read.All (delegated).",
    });
    return { ...EMPTY_DATASET, warnings };
  }

  // ---- 2. Direct membership snapshot per role ----------------------------
  // We fetch each role's direct member list in parallel. A per-role
  // failure (e.g. a transient 503) becomes a warning but does NOT abort
  // the overall probe.
  const directMembersByRole = new Map<string, RoleMemberRef[]>();
  await Promise.allSettled(
    roles.map(async (role) => {
      try {
        const raw = await fetchAllPages<Record<string, unknown>>(
          `${GRAPH_BASE}/directoryRoles/${encodeURIComponent(role.id)}/members?$select=id`,
          token,
          signal,
        );
        directMembersByRole.set(
          role.id,
          raw.map((m) => ({
            id: String(m.id ?? ""),
            type: odataTypeToPrincipalType(m["@odata.type"]),
          })),
        );
      } catch (err) {
        warnings.push({
          id: `members:${role.id}`,
          message: `Members of "${role.displayName}" not loaded (${(err as Error).message}).`,
        });
        directMembersByRole.set(role.id, []);
      }
    }),
  );

  // ---- 3. Resolve every direct member to (type, displayName, signIn) -----
  // Use the existing batched directoryObjects/getByIds helper so we don't
  // re-implement the chunking; it tolerates missing/deleted ids.
  const allDirectMemberIds = new Set<string>();
  for (const list of directMembersByRole.values()) {
    for (const m of list) {
      if (m.id) allDirectMemberIds.add(m.id);
    }
  }
  let resolvedDirect: ResolvedPrincipal[] = [];
  try {
    resolvedDirect = await getPrincipalsByIds(
      tenantId,
      Array.from(allDirectMemberIds),
      token,
    );
  } catch (err) {
    warnings.push({
      id: "resolve-direct",
      message: `Could not resolve some role members to names (${(err as Error).message}).`,
    });
  }
  const resolvedById = new Map<string, ResolvedPrincipal>();
  for (const p of resolvedDirect) resolvedById.set(p.id, p);

  // ---- 4. Expand every directly-assigned Group into transitive members ---
  // We collect a `Group → roles[]` index and a `Group → members[]` index in
  // parallel, then fan-out shadow-admin paths from there.
  const directGroupIds = new Set<string>();
  for (const list of directMembersByRole.values()) {
    for (const m of list) {
      if (m.type === "Group" && m.id) directGroupIds.add(m.id);
    }
  }

  // `Group → role list` index for the section-D table.
  const rolesByGroup = new Map<
    string,
    Array<{ role: DirectoryRoleSummary }>
  >();
  for (const role of roles) {
    const members = directMembersByRole.get(role.id) ?? [];
    for (const m of members) {
      if (m.type !== "Group") continue;
      const list = rolesByGroup.get(m.id) ?? [];
      list.push({ role });
      rolesByGroup.set(m.id, list);
    }
  }

  // `Group → transitive member ids` index for the shadow-admin fan-out.
  const transitiveMembersByGroup = new Map<string, ResolvedPrincipal[]>();
  await Promise.allSettled(
    Array.from(directGroupIds).map(async (gid) => {
      try {
        const raw = await fetchAllPages<Record<string, unknown>>(
          `${GRAPH_BASE}/groups/${encodeURIComponent(gid)}/transitiveMembers?$select=id,displayName,userPrincipalName,mail,accountEnabled`,
          token,
          signal,
        );
        const list: ResolvedPrincipal[] = raw.map((m) => ({
          id: String(m.id ?? ""),
          type: odataTypeToPrincipalType(m["@odata.type"]),
          displayName:
            (m.displayName as string | undefined) ??
            (m.userPrincipalName as string | undefined) ??
            String(m.id ?? ""),
          signInName:
            (m.userPrincipalName as string | undefined) ??
            (m.mail as string | undefined),
        }));
        transitiveMembersByGroup.set(gid, list);
      } catch (err) {
        warnings.push({
          id: `transitive:${gid}`,
          message: `Group ${gid.slice(0, 8)}… transitive members not enumerated (${(err as Error).message}).`,
        });
        transitiveMembersByGroup.set(gid, []);
      }
    }),
  );

  // ---- 5. Build the principal index --------------------------------------
  // The principal index is keyed by object id. Each (principal, role,
  // path) triplet is recorded as its own AssignmentDetail so the operator
  // can audit exactly how each privilege was acquired.
  type Mutable = Omit<
    PrivilegedPrincipal,
    "topTier" | "isShadowAdmin" | "isServicePrincipal"
  >;
  const byId = new Map<string, Mutable>();

  const upsertPrincipal = (
    base: ResolvedPrincipal,
    enabled?: boolean,
  ): Mutable => {
    const existing = byId.get(base.id);
    if (existing) return existing;
    const next: Mutable = {
      id: base.id,
      type: (base.type as PrincipalType) ?? "Unknown",
      displayName: base.displayName,
      signInName: base.signInName,
      enabled,
      isExternal: isExternalUpn(base.signInName),
      assignments: [],
    };
    byId.set(base.id, next);
    return next;
  };

  // Direct user + SP assignments.
  for (const role of roles) {
    const directMembers = directMembersByRole.get(role.id) ?? [];
    for (const m of directMembers) {
      if (m.type !== "User" && m.type !== "ServicePrincipal") continue;
      const resolved =
        resolvedById.get(m.id) ??
        ({
          id: m.id,
          type: m.type,
          displayName: m.id,
          signInName: undefined,
        } as ResolvedPrincipal);
      const principal = upsertPrincipal(resolved);
      const isGuest = principal.isExternal && m.type === "User";
      principal.assignments.push({
        roleId: role.id,
        roleTemplateId: role.roleTemplateId,
        roleDisplayName: role.displayName,
        tier: role.tier,
        path:
          m.type === "ServicePrincipal" ? "sp" : isGuest ? "guest" : "direct",
      });
    }
  }

  // Group-mediated assignments: every transitive USER member of a group
  // that holds a role inherits that role through the group.
  for (const [groupId, transitive] of transitiveMembersByGroup.entries()) {
    const groupRoles = rolesByGroup.get(groupId) ?? [];
    if (groupRoles.length === 0) continue;
    const groupResolved = resolvedById.get(groupId);
    const groupName = groupResolved?.displayName ?? groupId;
    for (const member of transitive) {
      // Only users are surfaced as shadow admins through groups; nested
      // groups are still walked (transitiveMembers handles that) but the
      // group-node itself is shown in section D, not section B.
      if (member.type !== "User" && member.type !== "ServicePrincipal") {
        continue;
      }
      const principal = upsertPrincipal(member);
      for (const { role } of groupRoles) {
        principal.assignments.push({
          roleId: role.id,
          roleTemplateId: role.roleTemplateId,
          roleDisplayName: role.displayName,
          tier: role.tier,
          path: "group",
          viaGroupId: groupId,
          viaGroupName: groupName,
        });
      }
    }
  }

  // ---- 6. Dedup, derive computed fields ----------------------------------
  const principalsAll: PrivilegedPrincipal[] = [];
  for (const draft of byId.values()) {
    // Dedup assignments on (roleId, path, viaGroupId) so a user that's
    // both a direct member AND transitive via 3 groups gets at most one
    // row per (role, source) pair.
    const seen = new Set<string>();
    const deduped: AssignmentDetail[] = [];
    for (const a of draft.assignments) {
      const key = `${a.roleId}::${a.path}::${a.viaGroupId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(a);
    }
    const topTier = highestTier(deduped);
    const principal: PrivilegedPrincipal = {
      ...draft,
      assignments: deduped,
      topTier,
      isShadowAdmin: hasShadowAdminPath(deduped, draft.isExternal),
      isServicePrincipal: draft.type === "ServicePrincipal",
    };
    principalsAll.push(principal);
  }
  principalsAll.sort(compareByTierThenName);

  // ---- 7. Shadow-admin paths (section C) ---------------------------------
  const shadowPaths: ShadowAdminPath[] = [];
  for (const p of principalsAll) {
    for (const a of p.assignments) {
      if (a.path === "direct" && !p.isExternal) continue;
      const id = `${p.id}::${a.roleId}::${a.path}::${a.viaGroupId ?? ""}`;
      let via: string;
      if (a.path === "group") {
        via = `via group "${a.viaGroupName ?? a.viaGroupId ?? "unknown"}"`;
      } else if (a.path === "sp") {
        via = "service-principal assignment";
      } else if (a.path === "guest") {
        via = "guest / cross-tenant assignment";
      } else {
        // Direct + external: principal is a guest user assigned directly.
        via = "direct assignment to guest";
      }
      shadowPaths.push({
        id,
        principalId: p.id,
        principalDisplayName: p.displayName,
        principalType: p.type,
        principalSignInName: p.signInName,
        path: a.path,
        via,
        viaGroupId: a.viaGroupId,
        viaGroupName: a.viaGroupName,
        roleId: a.roleId,
        roleTemplateId: a.roleTemplateId,
        roleDisplayName: a.roleDisplayName,
        tier: a.tier,
      });
    }
  }
  // Sort: lowest tier order first (Tier 0 to the top), then by name.
  shadowPaths.sort((a, b) => {
    const ta = TIER_META[a.tier].order;
    const tb = TIER_META[b.tier].order;
    if (ta !== tb) return ta - tb;
    return a.principalDisplayName.localeCompare(
      b.principalDisplayName,
      undefined,
      { sensitivity: "base" },
    );
  });

  // ---- 8. Groups holding privileged roles (section D) --------------------
  //
  // Per-group `isAssignableToRole` is fetched in parallel so the Signal G
  // (PIM-for-Groups eligibility) detector can join against the group facts
  // and flag eligibilities on role-assignable groups. Citation:
  //   `_bypass_staged_pim.md` §6 "Group-Based PIM" — eligibility on an
  //    isAssignableToRole=true group is the canonical 3-layer indirection.
  const isAssignableByGroup = new Map<string, boolean>();
  await Promise.allSettled(
    Array.from(rolesByGroup.keys()).map(async (gid) => {
      try {
        const r = await fetch(
          `${GRAPH_BASE}/groups/${encodeURIComponent(gid)}?$select=id,isAssignableToRole`,
          { headers: graphHeaders(token), ...(signal ? { signal } : {}) },
        );
        if (!r.ok) return;
        const d = (await r.json()) as { isAssignableToRole?: boolean };
        if (typeof d.isAssignableToRole === "boolean") {
          isAssignableByGroup.set(gid, d.isAssignableToRole);
        }
      } catch {
        /* swallow — isAssignableToRole is decoration; PIM-G detector
           will still emit findings but won't flag the group-shape lift. */
      }
    }),
  );

  const groupsOut: PrivilegedGroup[] = [];
  for (const [groupId, list] of rolesByGroup.entries()) {
    const resolved = resolvedById.get(groupId);
    const transitive = transitiveMembersByGroup.get(groupId) ?? [];
    const userMembers = transitive.filter((m) => m.type === "User");
    const summarisedRoles = list.map(({ role }) => ({
      roleId: role.id,
      roleTemplateId: role.roleTemplateId,
      roleDisplayName: role.displayName,
      tier: role.tier,
    }));
    const topTier = summarisedRoles.length
      ? summarisedRoles.reduce<RoleTier>((acc, r) => {
          return TIER_META[r.tier].order < TIER_META[acc].order ? r.tier : acc;
        }, "other")
      : "other";
    groupsOut.push({
      id: groupId,
      displayName: resolved?.displayName ?? groupId,
      roles: summarisedRoles,
      transitiveUserCount: userMembers.length,
      transitiveTotalCount: transitive.length,
      topTier,
      transitiveMemberIds: transitive.map((m) => m.id),
    });
  }
  groupsOut.sort((a, b) => {
    const ta = TIER_META[a.topTier].order;
    const tb = TIER_META[b.topTier].order;
    if (ta !== tb) return ta - tb;
    return b.transitiveUserCount - a.transitiveUserCount;
  });

  // ---- 9. Service principals holding roles (section E) -------------------
  // We need createdDateTime for the "recent + privileged" callout. Fetch
  // it per-SP on demand because the directoryObjects/getByIds call
  // doesn't return it.
  const spIds = principalsAll
    .filter((p) => p.type === "ServicePrincipal")
    .map((p) => p.id);
  const createdById = new Map<string, string>();
  await Promise.allSettled(
    spIds.map(async (id) => {
      try {
        const url = `${GRAPH_BASE}/servicePrincipals/${encodeURIComponent(id)}?$select=createdDateTime,appId,accountEnabled`;
        const response = await fetch(url, {
          headers: graphHeaders(token),
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) return;
        const data = (await response.json()) as {
          createdDateTime?: string;
          appId?: string;
          accountEnabled?: boolean;
        };
        if (data.createdDateTime) createdById.set(id, data.createdDateTime);
      } catch {
        /* swallow — SP metadata is optional context */
      }
    }),
  );
  const servicePrincipals = principalsAll
    .filter((p) => p.type === "ServicePrincipal")
    .map((p) => ({ ...p, createdDateTime: createdById.get(p.id) }));

  // =========================================================================
  // Corpus-derived detection signals (read-only enumeration).
  //
  // The four signals A/B/C/D are all reads against the operator's OWN tenant.
  // No POST / PATCH / DELETE is issued — the page never invokes addKey /
  // addPassword / federated-cred / role-grant / TAP-issue / PIM-create.
  //
  // Master reference: `_AZURE_BYPASS_PLAYBOOK.md` §"Critical Defender
  //                   Audit Surface" items 3, 4, 5, 6, 7.
  //
  // COORDINATOR: privileged-audit invokes several Graph endpoints not yet
  // exposed by services/graph-service. If/when graph-service grows wrappers
  // for these we should route through them (matches the existing pattern
  // for `directoryRoles/.../members` which we also fetch direct here):
  //   - GET /servicePrincipals/{graphSpObjectId}/appRoleAssignedTo
  //   - GET /servicePrincipals/{id} (passwordCredentials,keyCredentials,...)
  //   - GET /applications?$filter=appId eq '{appId}'
  //   - GET /applications/{id}/federatedIdentityCredentials
  //   - GET /roleManagement/directory/roleEligibilityScheduleRequests
  //   - GET /users/{id}/authentication/temporaryAccessPassMethods
  // =========================================================================

  // ---- Signal A — High-privilege Graph permissions on SPs ----------------
  //
  // Citation:
  //   `_bypass_role_grant.md` §3.1 (Application.ReadWrite.All → addKey on
  //     Microsoft Graph SP → app-only with RoleManagement.ReadWrite.Directory
  //     → self-assign Global Administrator)
  //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #23
  //
  // Detection wire-up:
  //   1. Resolve Microsoft Graph SP object id.
  //   2. GET /servicePrincipals/{graphId}/appRoleAssignedTo — every SP
  //      Microsoft Graph has granted an app-role TO.
  //   3. Filter on the well-known appRoleIds in HIGH_PRIV_GRAPH_APP_ROLES.
  //   4. For each principal: fetch passwordCredentials + keyCredentials to
  //      score the "recent credential" companion signal (audit item #5 in
  //      the master playbook: addKey / addPassword detection).
  let highPrivGraphPermissions: HighPrivGraphPermissionFinding[] = [];
  try {
    // Resolve the Microsoft Graph SP object id by appId.
    const graphLookup = await fetchAllPages<Record<string, unknown>>(
      `${GRAPH_BASE}/servicePrincipals?` +
        `$filter=appId eq '${MICROSOFT_GRAPH_APP_ID}'&$select=id`,
      token,
      signal,
    );
    const graphSpObjectId = graphLookup.length
      ? String(graphLookup[0]?.id ?? "")
      : "";
    if (!graphSpObjectId) {
      warnings.push({
        id: "signal-a:no-graph-sp",
        message:
          "Microsoft Graph service principal not resolvable — Signal A " +
          "(high-privilege Graph permissions) is empty until that completes.",
      });
    } else {
      const assignedTo = await fetchAllPages<Record<string, unknown>>(
        `${GRAPH_BASE}/servicePrincipals/${encodeURIComponent(graphSpObjectId)}` +
          `/appRoleAssignedTo?$select=id,principalId,principalDisplayName,principalType,appRoleId,createdDateTime` +
          `&$top=999`,
        token,
        signal,
      );
      // Group by principalId; we only care about SP principals here.
      const perPrincipal = new Map<
        string,
        Array<{
          assignmentId: string;
          appRoleId: string;
          permissionName: string;
          createdDateTime?: string;
          principalDisplayName: string;
        }>
      >();
      for (const row of assignedTo) {
        const appRoleId = String(row.appRoleId ?? "");
        const permName = HIGH_PRIV_GRAPH_APP_ROLES.get(appRoleId);
        if (!permName) continue;
        const principalType = String(row.principalType ?? "");
        if (principalType !== "ServicePrincipal") continue;
        const principalId = String(row.principalId ?? "");
        if (!principalId) continue;
        const list = perPrincipal.get(principalId) ?? [];
        list.push({
          assignmentId: String(row.id ?? ""),
          appRoleId,
          permissionName: permName,
          createdDateTime:
            (row.createdDateTime as string | undefined) ?? undefined,
          principalDisplayName: String(row.principalDisplayName ?? ""),
        });
        perPrincipal.set(principalId, list);
      }
      // Hydrate each SP with name/appId/credential counts.
      const now = Date.now();
      const findings: HighPrivGraphPermissionFinding[] = [];
      await Promise.allSettled(
        Array.from(perPrincipal.entries()).map(async ([spId, perms]) => {
          let spName = perms[0]?.principalDisplayName ?? spId;
          let appId: string | undefined;
          let signInAudience: string | undefined;
          let createdDateTime: string | undefined;
          let pwdCount = 0;
          let keyCount = 0;
          let mostRecent: number | null = null;
          try {
            const url =
              `${GRAPH_BASE}/servicePrincipals/${encodeURIComponent(spId)}` +
              `?$select=id,displayName,appId,signInAudience,createdDateTime,passwordCredentials,keyCredentials`;
            const r = await fetch(url, {
              headers: graphHeaders(token),
              ...(signal ? { signal } : {}),
            });
            if (r.ok) {
              const d = (await r.json()) as {
                displayName?: string;
                appId?: string;
                signInAudience?: string;
                createdDateTime?: string;
                passwordCredentials?: Array<{ startDateTime?: string }>;
                keyCredentials?: Array<{ startDateTime?: string }>;
              };
              if (d.displayName) spName = d.displayName;
              appId = d.appId;
              signInAudience = d.signInAudience;
              createdDateTime = d.createdDateTime;
              const pwds = d.passwordCredentials ?? [];
              const keys = d.keyCredentials ?? [];
              pwdCount = pwds.length;
              keyCount = keys.length;
              for (const c of [...pwds, ...keys]) {
                if (!c.startDateTime) continue;
                const ts = new Date(c.startDateTime).getTime();
                if (!Number.isFinite(ts)) continue;
                if (mostRecent === null || ts > mostRecent) mostRecent = ts;
              }
            }
          } catch {
            /* swallow — SP detail is optional context for the finding */
          }
          const hasRecent =
            mostRecent !== null && now - mostRecent <= RECENT_CREDENTIAL_WINDOW_MS;
          findings.push({
            id: `sigA:${spId}`,
            servicePrincipalId: spId,
            servicePrincipalDisplayName: spName,
            appId,
            signInAudience,
            servicePrincipalCreatedDateTime: createdDateTime,
            permissions: perms.map((p) => ({
              assignmentId: p.assignmentId,
              appRoleId: p.appRoleId,
              permissionName: p.permissionName,
              createdDateTime: p.createdDateTime,
            })),
            passwordCredentialCount: pwdCount,
            keyCredentialCount: keyCount,
            hasRecentCredential: hasRecent,
            mostRecentCredentialAt:
              mostRecent !== null
                ? new Date(mostRecent).toISOString()
                : undefined,
          });
        }),
      );
      // Sort: criticals first (recent cred + canonical perm), then perm count.
      findings.sort((a, b) => {
        const sa =
          gradeHighPrivGraphPermission(a) === "critical"
            ? 0
            : gradeHighPrivGraphPermission(a) === "high"
              ? 1
              : 2;
        const sb =
          gradeHighPrivGraphPermission(b) === "critical"
            ? 0
            : gradeHighPrivGraphPermission(b) === "high"
              ? 1
              : 2;
        if (sa !== sb) return sa - sb;
        return b.permissions.length - a.permissions.length;
      });
      highPrivGraphPermissions = findings;
    }
  } catch (err) {
    warnings.push({
      id: "signal-a:failed",
      message:
        `Signal A (high-privilege Graph permissions) probe failed: ${
          (err as Error).message
        }. Needs Application.Read.All / Directory.Read.All on Microsoft Graph.`,
    });
  }

  // ---- Signal B — Federated identity credentials on privileged SPs --------
  //
  // Citation:
  //   `_bypass_role_grant.md` §6 (WIF federated credential = role-grant bypass)
  //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #17 + audit item #6
  //
  // Detection wire-up:
  //   - For every SP that surfaced in Signal A (highest-leverage SPs in the
  //     tenant), resolve its parent application object, then enumerate
  //     /applications/{appObjectId}/federatedIdentityCredentials.
  //   - Flag any federated credential whose issuer host matches the
  //     curated PUBLIC_FEDERATION_ISSUER_HOSTS list.
  let federatedCredentials: FederatedCredentialFinding[] = [];
  try {
    const findings: FederatedCredentialFinding[] = [];
    const targets = highPrivGraphPermissions.map((f) => ({
      spId: f.servicePrincipalId,
      spName: f.servicePrincipalDisplayName,
      appId: f.appId,
    }));
    await Promise.allSettled(
      targets.map(async (t) => {
        if (!t.appId) return;
        // Resolve parent application object id (federated creds live on
        // /applications, not /servicePrincipals).
        let appObjectId: string | undefined;
        try {
          const u =
            `${GRAPH_BASE}/applications?` +
            `$filter=appId eq '${encodeURIComponent(t.appId)}'&$select=id`;
          const r = await fetch(u, {
            headers: graphHeaders(token),
            ...(signal ? { signal } : {}),
          });
          if (r.ok) {
            const d = (await r.json()) as {
              value?: Array<{ id?: string }>;
            };
            appObjectId = d.value?.[0]?.id;
          }
        } catch {
          /* swallow — app may live in a partner tenant (no local app obj) */
        }
        if (!appObjectId) return;
        try {
          const fic = await fetchAllPages<Record<string, unknown>>(
            `${GRAPH_BASE}/applications/${encodeURIComponent(appObjectId)}` +
              `/federatedIdentityCredentials`,
            token,
            signal,
          );
          for (const row of fic) {
            const issuer = String(row.issuer ?? "");
            const subject = String(row.subject ?? "");
            const audiences = Array.isArray(row.audiences)
              ? (row.audiences as string[])
              : [];
            findings.push({
              id: `sigB:${t.spId}:${row.id ?? subject}`,
              servicePrincipalId: t.spId,
              servicePrincipalDisplayName: t.spName,
              applicationObjectId: appObjectId,
              name: String(row.name ?? "(unnamed)"),
              issuer,
              subject,
              audiences,
              isPublicIssuer: isPublicFederationIssuer(issuer),
            });
          }
        } catch {
          /* swallow — Application.Read.All required; degrade quietly */
        }
      }),
    );
    if (findings.length === 0 && targets.length > 0) {
      // Couldn't enumerate any — caller probably lacks Application.Read.All
      // on /applications/{id}/federatedIdentityCredentials. Surface a hint
      // so the empty card doesn't read as a clean bill of health.
      warnings.push({
        id: "signal-b:permission",
        message:
          "Signal B (federated identity credentials) did not enumerate any " +
          "credentials. If your high-privilege SPs use WIF, the signed-in " +
          "account likely needs Application.Read.All to read " +
          "/applications/{id}/federatedIdentityCredentials.",
      });
    }
    findings.sort((a, b) => {
      // Public issuer first, then by name.
      if (a.isPublicIssuer !== b.isPublicIssuer) {
        return a.isPublicIssuer ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    federatedCredentials = findings;
  } catch (err) {
    warnings.push({
      id: "signal-b:failed",
      message:
        `Signal B (federated identity credentials) probe failed: ${
          (err as Error).message
        }.`,
    });
  }

  // ---- Signal C — PIM eligibility with `noExpiration` ---------------------
  //
  // Citation:
  //   `_bypass_staged_pim.md` §5.1 "The 'time bomb'" — PRA briefly compromised,
  //     plant `noExpiration` eligibility for attacker user, then let the PRA
  //     compromise be remediated. Eligibility persists.
  //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #27 + audit item #7
  //
  // Detection wire-up:
  //   GET /roleManagement/directory/roleEligibilityScheduleRequests
  //   (we deliberately read the *requests* endpoint not the *schedules*
  //   endpoint, because the requests endpoint preserves createdDateTime
  //   and is the closest read-only equivalent of the POST that creates
  //   the eligibility — audit-event #7 in the master playbook).
  //   If the *requests* endpoint 403s we degrade to *schedules*.
  let pimEligibilities: PimEligibilityFinding[] = [];
  const knownRoleIdByTemplate = new Map<string, DirectoryRoleSummary>();
  for (const role of roles) {
    knownRoleIdByTemplate.set(role.roleTemplateId, role);
  }
  const buildPimFinding = (
    row: Record<string, unknown>,
  ): PimEligibilityFinding | null => {
    const principalId = String(row.principalId ?? "");
    const roleTemplateId = String(row.roleDefinitionId ?? "");
    if (!principalId || !roleTemplateId) return null;
    const schedule = (row.scheduleInfo ?? {}) as Record<string, unknown>;
    const expiration = (schedule.expiration ?? {}) as Record<string, unknown>;
    const typeRaw = String(expiration.type ?? "").toLowerCase();
    const expirationKind: PimExpirationKind =
      typeRaw === "noexpiration"
        ? "noExpiration"
        : typeRaw === "afterdatetime"
          ? "afterDateTime"
          : typeRaw === "afterduration"
            ? "afterDuration"
            : "unknown";
    const role = knownRoleIdByTemplate.get(roleTemplateId);
    const tier = role?.tier ?? classifyRole(roleTemplateId, undefined);
    const principalResolved = resolvedById.get(principalId);
    const principalType = principalResolved
      ? ((principalResolved.type as PrincipalType) ?? "Unknown")
      : "Unknown";
    return {
      id: `sigC:${String(row.id ?? `${principalId}::${roleTemplateId}`)}`,
      principalId,
      principalDisplayName: principalResolved?.displayName,
      principalSignInName: principalResolved?.signInName,
      principalType,
      roleTemplateId,
      roleDisplayName: role?.displayName,
      tier,
      expirationKind,
      endDateTime: expiration.endDateTime as string | undefined,
      duration: expiration.duration as string | undefined,
      createdDateTime: row.createdDateTime as string | undefined,
      isCriticalTimeBomb: expirationKind === "noExpiration" && tier === "tier0",
    };
  };
  try {
    const eligibilityIdsToResolve = new Set<string>();
    let raw: Record<string, unknown>[] = [];
    try {
      raw = await fetchAllPages<Record<string, unknown>>(
        `${GRAPH_BASE}/roleManagement/directory/roleEligibilityScheduleRequests` +
          `?$select=id,principalId,roleDefinitionId,status,action,scheduleInfo,createdDateTime` +
          `&$filter=status eq 'Provisioned'`,
        token,
        signal,
      );
    } catch {
      // Fallback: the *schedules* endpoint (current state, not historical
      // request log). Some tenants don't grant RoleEligibilitySchedule.Read.All
      // on the requests endpoint specifically.
      raw = await fetchAllPages<Record<string, unknown>>(
        `${GRAPH_BASE}/roleManagement/directory/roleEligibilitySchedules` +
          `?$select=id,principalId,roleDefinitionId,scheduleInfo,createdDateTime`,
        token,
        signal,
      );
    }
    const findings: PimEligibilityFinding[] = [];
    for (const row of raw) {
      const f = buildPimFinding(row);
      if (f) findings.push(f);
      const pid = String(row.principalId ?? "");
      if (pid && !resolvedById.has(pid)) eligibilityIdsToResolve.add(pid);
    }
    // Best-effort resolve of any principal we haven't seen before.
    if (eligibilityIdsToResolve.size > 0) {
      try {
        const extra = await getPrincipalsByIds(
          tenantId,
          Array.from(eligibilityIdsToResolve),
          token,
        );
        for (const p of extra) {
          resolvedById.set(p.id, p);
          // Patch already-built findings with the resolved name.
          for (const f of findings) {
            if (f.principalId === p.id) {
              f.principalDisplayName = p.displayName;
              f.principalSignInName = p.signInName;
              f.principalType =
                (p.type as PrincipalType) ?? f.principalType;
            }
          }
        }
      } catch {
        /* swallow — display name is decoration */
      }
    }
    // Sort: criticals first, then noExpiration, then by tier order.
    findings.sort((a, b) => {
      if (a.isCriticalTimeBomb !== b.isCriticalTimeBomb) {
        return a.isCriticalTimeBomb ? -1 : 1;
      }
      const sa = a.expirationKind === "noExpiration" ? 0 : 1;
      const sb = b.expirationKind === "noExpiration" ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return TIER_META[a.tier].order - TIER_META[b.tier].order;
    });
    pimEligibilities = findings;
  } catch (err) {
    warnings.push({
      id: "signal-c:failed",
      message:
        `Signal C (PIM eligibility) probe failed: ${
          (err as Error).message
        }. Needs RoleEligibilitySchedule.Read.Directory or RoleManagement.Read.Directory.`,
    });
  }

  // ---- Signal D — Recent TAP issuances to privileged users ----------------
  //
  // Citation:
  //   `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface" #3
  //                              + Top-30 #13
  //
  // Detection wire-up: for every USER principal that already surfaced in
  // sections B/C, GET /users/{id}/authentication/temporaryAccessPassMethods.
  // The endpoint is read-only and returns whatever TAP method(s) the user
  // currently has on their account. Sees admin-issued TAPs (Auth Admin /
  // Priv Auth Admin) — the canonical MFA-equivalent persistence vector.
  let tapIssuances: TapIssuanceFinding[] = [];
  try {
    const privilegedUsers = principalsAll.filter((p) => p.type === "User");
    const now = Date.now();
    const findings: TapIssuanceFinding[] = [];
    await Promise.allSettled(
      privilegedUsers.map(async (u) => {
        try {
          const r = await fetch(
            `${GRAPH_BASE}/users/${encodeURIComponent(u.id)}` +
              `/authentication/temporaryAccessPassMethods`,
            {
              headers: graphHeaders(token),
              ...(signal ? { signal } : {}),
            },
          );
          if (!r.ok) {
            // 404 means "no TAP" which is the expected default; only
            // promote to a warning on 4xx-not-404 (permission missing).
            if (r.status !== 404 && r.status !== 200) {
              if (r.status === 401 || r.status === 403) {
                warnings.push({
                  id: `signal-d:perm:${u.id}`,
                  message:
                    `Signal D (TAP issuance) needs UserAuthenticationMethod.Read.All ` +
                    `to read /users/${u.id.slice(0, 8)}…/authentication/temporaryAccessPassMethods.`,
                });
              }
            }
            return;
          }
          const data = (await r.json()) as {
            value?: Array<{
              id?: string;
              startDateTime?: string;
              lifetimeInMinutes?: number;
              isUsable?: boolean;
              methodUsabilityReason?: string;
            }>;
          };
          for (const tap of data.value ?? []) {
            const startMs = tap.startDateTime
              ? new Date(tap.startDateTime).getTime()
              : NaN;
            const isRecent =
              Number.isFinite(startMs) &&
              now - startMs <= RECENT_TAP_WINDOW_MS;
            const isTopTier =
              u.topTier === "tier0" || u.topTier === "tier1";
            findings.push({
              id: `sigD:${u.id}:${tap.id ?? "tap"}`,
              userId: u.id,
              userDisplayName: u.displayName,
              userPrincipalName: u.signInName,
              userTier: u.topTier,
              tapId: String(tap.id ?? ""),
              startDateTime: tap.startDateTime,
              lifetimeInMinutes: tap.lifetimeInMinutes,
              isUsable: tap.isUsable,
              methodUsabilityReason: tap.methodUsabilityReason,
              isRecentToTierZero: isRecent && isTopTier,
            });
          }
        } catch {
          /* swallow — per-user TAP query failures are not page-level */
        }
      }),
    );
    findings.sort((a, b) => {
      // Critical-on-T0 first, then any T0, then T1, then by time.
      const sa = gradeTapIssuance(a) === "critical" ? 0 : 1;
      const sb = gradeTapIssuance(b) === "critical" ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ta = TIER_META[a.userTier].order;
      const tb = TIER_META[b.userTier].order;
      if (ta !== tb) return ta - tb;
      const aT = a.startDateTime ? new Date(a.startDateTime).getTime() : 0;
      const bT = b.startDateTime ? new Date(b.startDateTime).getTime() : 0;
      return bT - aT;
    });
    tapIssuances = findings;
  } catch (err) {
    warnings.push({
      id: "signal-d:failed",
      message:
        `Signal D (TAP issuance) probe failed: ${
          (err as Error).message
        }. Needs UserAuthenticationMethod.Read.All.`,
    });
  }

  // ---- Signal E — AAD Connect / Cloud Sync sync-account drift ------------
  //
  // Citation:
  //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #19 (AAD Connect `Sync_*` decrypt →
  //      bidirectional forest control)
  //   `_bypass_mixed_chains.md` chain #1 (the full kill-chain)
  //   `_analysis_dirkjanm.md` adconnectdump
  //
  // Detection: any principal in the privileged-identity index whose
  // display-name / sign-in-name matches the canonical sync-account pattern
  // (`Sync_*`, `MSOL_*`, `ADToAADSyncServiceAccount`, "On-Premises Directory
  //  Synchronization Service Account") is a candidate. We then split its
  // roles into "canonical" (Directory Synchronization Accounts only) vs
  // "drift" (any other privileged role); any drift role triggers the
  // finding. Sync accounts holding T0 are critical — that is exactly the
  // "compromise-bidirectional-forest" shape the playbook calls out.
  const syncAccountFindings: SyncAccountFinding[] = [];
  for (const p of principalsAll) {
    if (!looksLikeSyncAccount(p.displayName, p.signInName)) continue;
    // De-dup roles by template id — we only care about which roles, not
    // through how many paths the sync account ended up holding them.
    const uniqRoles = new Map<
      string,
      { roleTemplateId: string; roleDisplayName: string; tier: RoleTier }
    >();
    for (const a of p.assignments) {
      if (!uniqRoles.has(a.roleTemplateId)) {
        uniqRoles.set(a.roleTemplateId, {
          roleTemplateId: a.roleTemplateId,
          roleDisplayName: a.roleDisplayName,
          tier: a.tier,
        });
      }
    }
    const allRoles = Array.from(uniqRoles.values()).map((r) => ({
      ...r,
      isCanonical: r.roleTemplateId === ROLE_DIRECTORY_SYNC_ACCOUNTS,
    }));
    const driftRoles = allRoles.filter((r) => !r.isCanonical);
    const topDriftTier: RoleTier = driftRoles.length
      ? driftRoles.reduce<RoleTier>(
          (acc, r) =>
            TIER_META[r.tier].order < TIER_META[acc].order ? r.tier : acc,
          "other",
        )
      : "other";
    syncAccountFindings.push({
      id: `sigE:${p.id}`,
      principalId: p.id,
      principalDisplayName: p.displayName,
      principalSignInName: p.signInName,
      principalType: p.type,
      roles: allRoles,
      hasDriftRole: driftRoles.length > 0,
      topDriftTier,
    });
  }
  // Sort: drift findings first, T0 drift to the top, then by name.
  syncAccountFindings.sort((a, b) => {
    if (a.hasDriftRole !== b.hasDriftRole) return a.hasDriftRole ? -1 : 1;
    const oa = TIER_META[a.topDriftTier].order;
    const ob = TIER_META[b.topDriftTier].order;
    if (oa !== ob) return oa - ob;
    return a.principalDisplayName.localeCompare(
      b.principalDisplayName,
      undefined,
      { sensitivity: "base" },
    );
  });

  // ---- Signal G — PIM-for-Groups eligibility on role-assignable groups ---
  //
  // Citation:
  //   `_bypass_staged_pim.md` §6 (Group-Based PIM):
  //     POST /v1.0/identityGovernance/privilegedAccess/group/eligibilityScheduleRequests
  //     with accessId=member; activator inherits any role the group holds.
  //   `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #28.
  //
  // We read the schedules endpoint (current eligible state). Failures
  // degrade gracefully because PIMforGroups isn't enabled in every tenant.
  let pimGroupEligibilities: PimGroupEligibilityFinding[] = [];
  try {
    const raw = await fetchAllPages<Record<string, unknown>>(
      `${GRAPH_BASE}/identityGovernance/privilegedAccess/group/eligibilitySchedules` +
        `?$select=id,principalId,groupId,accessId,scheduleInfo,createdDateTime`,
      token,
      signal,
    );
    const idsToResolve = new Set<string>();
    for (const row of raw) {
      const pid = String(row.principalId ?? "");
      if (pid && !resolvedById.has(pid)) idsToResolve.add(pid);
    }
    if (idsToResolve.size > 0) {
      try {
        const extra = await getPrincipalsByIds(
          tenantId,
          Array.from(idsToResolve),
          token,
        );
        for (const e of extra) resolvedById.set(e.id, e);
      } catch {
        /* swallow */
      }
    }
    const groupById = new Map(groupsOut.map((g) => [g.id, g] as const));
    const findings: PimGroupEligibilityFinding[] = [];
    for (const row of raw) {
      const principalId = String(row.principalId ?? "");
      const groupId = String(row.groupId ?? "");
      if (!principalId || !groupId) continue;
      const group = groupById.get(groupId);
      // We surface every eligibility but score it as "info" when the group
      // doesn't hold a privileged role — that way operators can still see
      // the inventory but they aren't drowned in non-actionable rows.
      const groupRoles = group?.roles.map((r) => ({
        roleTemplateId: r.roleTemplateId,
        roleDisplayName: r.roleDisplayName,
        tier: r.tier,
      })) ?? [];
      const topTier: RoleTier = group?.topTier ?? "other";
      const schedule = (row.scheduleInfo ?? {}) as Record<string, unknown>;
      const expiration = (schedule.expiration ?? {}) as Record<string, unknown>;
      const typeRaw = String(expiration.type ?? "").toLowerCase();
      const expirationKind: PimExpirationKind =
        typeRaw === "noexpiration"
          ? "noExpiration"
          : typeRaw === "afterdatetime"
            ? "afterDateTime"
            : typeRaw === "afterduration"
              ? "afterDuration"
              : "unknown";
      const principalResolved = resolvedById.get(principalId);
      const isAssignable = isAssignableByGroup.get(groupId) ?? false;
      findings.push({
        id: `sigG:${row.id ?? `${principalId}::${groupId}`}`,
        principalId,
        principalDisplayName: principalResolved?.displayName,
        principalSignInName: principalResolved?.signInName,
        principalType:
          (principalResolved?.type as PrincipalType) ?? "Unknown",
        groupId,
        groupDisplayName: group?.displayName ?? groupId,
        isAssignableToRole: isAssignable,
        groupRoles,
        topTier,
        expirationKind,
        endDateTime: expiration.endDateTime as string | undefined,
        duration: expiration.duration as string | undefined,
        createdDateTime: row.createdDateTime as string | undefined,
        isCriticalTimeBomb:
          expirationKind === "noExpiration" && topTier === "tier0",
      });
    }
    // Critical first, then T0, then by name.
    findings.sort((a, b) => {
      if (a.isCriticalTimeBomb !== b.isCriticalTimeBomb) {
        return a.isCriticalTimeBomb ? -1 : 1;
      }
      const oa = TIER_META[a.topTier].order;
      const ob = TIER_META[b.topTier].order;
      if (oa !== ob) return oa - ob;
      return a.groupDisplayName.localeCompare(b.groupDisplayName);
    });
    pimGroupEligibilities = findings;
  } catch (err) {
    // PIM-for-Groups isn't enabled / Graph permission missing — best-effort.
    // 404 is the common case ("identityGovernance not present"); we only
    // emit a warning when the failure looks permission-related.
    const msg = (err as Error).message ?? "";
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      warnings.push({
        id: "signal-g:perm",
        message:
          "Signal G (PIM-for-Groups eligibility) requires " +
          "PrivilegedAccess.Read.AzureADGroup or RoleManagement.Read.All. " +
          "PIM-for-Groups inventory is therefore empty.",
      });
    } else if (status !== 404 && msg) {
      warnings.push({
        id: "signal-g:failed",
        message: `Signal G probe failed: ${msg}.`,
      });
    }
  }

  // ---- Signal F — Mixed-chain correlation -------------------------------
  //
  // Citation: `_bypass_mixed_chains.md` — composing primitives is the
  // attacker's actual workflow; two indicators on the same principal inside
  // MIXED_CHAIN_WINDOW_MS is the kill-chain signature. Pure / deterministic
  // — produced by combining the already-collected A/B/C/D arrays.
  const principalIndex = new Map<string, PrivilegedPrincipal>();
  for (const p of principalsAll) principalIndex.set(p.id, p);
  const mixedChainFindings = buildMixedChainFindings(
    highPrivGraphPermissions,
    federatedCredentials,
    pimEligibilities,
    tapIssuances,
    principalIndex,
    MIXED_CHAIN_WINDOW_MS,
  );

  return {
    principals: principalsAll,
    shadowPaths,
    groups: groupsOut,
    servicePrincipals,
    warnings,
    activatedRoleCount: roles.length,
    highPrivGraphPermissions,
    federatedCredentials,
    pimEligibilities,
    tapIssuances,
    syncAccountFindings,
    pimGroupEligibilities,
    mixedChainFindings,
  };
}

// ===========================================================================
// Sub-components — tier badge, assignment chip, etc.
// ===========================================================================

const TierBadge: React.FC<{ tier: RoleTier; compact?: boolean }> = ({
  tier,
  compact,
}) => {
  const meta = TIER_META[tier];
  return (
    <Badge
      variant={meta.badgeVariant}
      className={cn(compact ? "px-1.5 py-0" : undefined)}
      title={meta.description}
    >
      {compact ? meta.label.split(" — ")[0] : meta.label}
    </Badge>
  );
};

const PathBadge: React.FC<{ path: AssignmentPath }> = ({ path }) => {
  const meta = ASSIGNMENT_PATH_META[path];
  return (
    <Badge variant={meta.badgeVariant} title={meta.description}>
      {meta.label}
    </Badge>
  );
};

// ===========================================================================
// Page component
// ===========================================================================

export const PrivilegedAuditPage: React.FC = () => {
  const state = useMultiRegionState();
  const azureAccounts = state.azureAccounts ?? [];
  // Spec: auto-uses the primary signed-in account's active tenant.
  const primaryAccount = azureAccounts[0];
  const tenantId =
    (primaryAccount?.homeAccountId
      ? getActiveTenant(primaryAccount.homeAccountId)
      : null) ??
    (primaryAccount ? resolveActiveTenantId(primaryAccount) : "") ??
    "";

  // Tracks mount state so async resolutions (token acquisition, probe fetch)
  // never call setState after unmount. Flipped in a cleanup effect at the
  // top of the page so it's defined before any callback closes over it.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Graph token tracking — manual because there's no useGraphToken hook
  // analogous to useArmToken. The badge needs `secondsUntilExpiry`, so we
  // decode the JWT `exp` claim ourselves.
  // -------------------------------------------------------------------------
  const [graphToken, setGraphToken] = React.useState<string | null>(null);
  const [graphTokenExpiresAt, setGraphTokenExpiresAt] = React.useState<
    number | null
  >(null);
  const [graphTokenLoading, setGraphTokenLoading] = React.useState(false);
  const [graphTokenError, setGraphTokenError] = React.useState<string | null>(
    null,
  );
  const [nowTick, setNowTick] = React.useState<number>(() =>
    Math.floor(Date.now() / 1000),
  );

  const acquireGraphToken = React.useCallback(async () => {
    if (!primaryAccount?.homeAccountId || !tenantId) {
      if (mountedRef.current) {
        setGraphToken(null);
        setGraphTokenExpiresAt(null);
      }
      return null;
    }
    if (mountedRef.current) {
      setGraphTokenLoading(true);
      setGraphTokenError(null);
    }
    try {
      const t = await getGraphTokenForAccount(
        primaryAccount.homeAccountId,
        tenantId,
      );
      const claims = decodeJwtClaimsUnsafe(t);
      const exp =
        typeof claims?.exp === "number" ? (claims.exp as number) : null;
      if (mountedRef.current) {
        setGraphToken(t);
        setGraphTokenExpiresAt(exp);
      }
      return t;
    } catch (err) {
      if (mountedRef.current) {
        setGraphTokenError(
          err instanceof Error ? err.message : String(err),
        );
        setGraphToken(null);
        setGraphTokenExpiresAt(null);
      }
      return null;
    } finally {
      if (mountedRef.current) {
        setGraphTokenLoading(false);
      }
    }
  }, [primaryAccount?.homeAccountId, tenantId]);

  React.useEffect(() => {
    void acquireGraphToken();
  }, [acquireGraphToken]);

  // Tick the badge clock once per second only while a token's outstanding.
  // The interval cleans up on unmount AND when either dep falls to null —
  // no stray timer keeps the page mounted in the React profiler.
  React.useEffect(() => {
    if (!graphToken || !graphTokenExpiresAt) return;
    const id = window.setInterval(
      () => setNowTick(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [graphToken, graphTokenExpiresAt]);

  const graphSecondsUntilExpiry =
    graphTokenExpiresAt ? Math.max(0, graphTokenExpiresAt - nowTick) : null;

  // -------------------------------------------------------------------------
  // Dataset state + probe lifecycle
  // -------------------------------------------------------------------------
  const [dataset, setDataset] = React.useState<PrivilegedAuditDataset>(
    EMPTY_DATASET,
  );
  const [status, setStatus] = React.useState<LoadStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [lastProbedAt, setLastProbedAt] = React.useState<string | null>(null);

  // Sequence so a slow stale probe can't overwrite a fresher one (tenant
  // switch while a probe is in flight). Paired with an `AbortController`
  // stored in a ref so unmount AND newer probes cancel in-flight fetches —
  // before this, the controller was a local in the callback, so neither
  // unmount nor "Re-probe" cancelled the previous run's network work.
  const probeSeqRef = React.useRef(0);
  const probeAbortRef = React.useRef<AbortController | null>(null);

  // Abort any in-flight probe on unmount to prevent setState-after-unmount
  // and stop leaking Graph requests when the user navigates away mid-probe.
  React.useEffect(() => {
    return () => {
      probeAbortRef.current?.abort();
      probeAbortRef.current = null;
    };
  }, []);

  const runProbe = React.useCallback(async () => {
    if (!tenantId) return;
    const token = graphToken ?? (await acquireGraphToken());
    if (!token) {
      if (mountedRef.current) {
        setError("Could not acquire a Microsoft Graph token for this tenant.");
        setStatus("error");
      }
      return;
    }
    // Cancel any previous in-flight probe before starting a new one.
    probeAbortRef.current?.abort();
    const abort = new AbortController();
    probeAbortRef.current = abort;
    const mySeq = ++probeSeqRef.current;
    if (mountedRef.current) {
      setStatus("loading");
      setError(null);
    }
    try {
      const data = await probeTenant(tenantId, token, abort.signal);
      // Drop stale results when a newer probe has started OR the page
      // unmounted while we were in flight.
      if (!mountedRef.current || mySeq !== probeSeqRef.current) return;
      setDataset(data);
      setLastProbedAt(new Date().toISOString());
      setStatus("ok");
      // NOTE: Per the page brief the probe itself is read-only enumeration
      // and not a state-changing action for OUR app, so we deliberately do
      // NOT call auditLog.record() here. Audit firing is reserved for
      // filter mutations (see useAuditFilters() below).
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      if (!mountedRef.current || mySeq !== probeSeqRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
    }
  }, [tenantId, graphToken, acquireGraphToken]);

  // Auto-run the probe the first time we have a token + tenant. Using
  // `useAbortableEffect` here means the effect-owned `AbortSignal` cancels
  // any in-flight enumeration if the page unmounts before the manual
  // controller is even installed. The probeStartedRef guard prevents a
  // tenant-change refresh (which manually drives runProbe) from racing
  // with the initial auto-run.
  const probeStartedRef = React.useRef(false);
  useAbortableEffect(
    async (signal) => {
      if (probeStartedRef.current) return;
      if (!tenantId || !graphToken) return;
      probeStartedRef.current = true;
      // runProbe installs its own AbortController in probeAbortRef so it
      // can be cancelled by future re-probes. We also subscribe the
      // effect-owned signal so unmount during the initial probe aborts
      // the in-flight controller proactively.
      const onAbort = () => probeAbortRef.current?.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await runProbe();
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    [tenantId, graphToken, runProbe],
  );

  // -------------------------------------------------------------------------
  // Filter UI state — synced to URL so deep links preserve filter chips,
  // tier / path / sort. The "show only stale" toggle is persisted across
  // sessions per the page brief because operators commonly leave it on.
  // -------------------------------------------------------------------------
  type SortMode = "risk" | "tier";
  const URL_KEYS = React.useMemo<string[]>(
    () => ["tier", "type", "path", "shadow", "sort", "q"],
    [],
  );
  const [urlState, setUrlState] = useUrlState<{
    tier: string[];
    type: string[];
    path: string[];
    shadow: string;
    sort: string;
    q: string;
  }>(
    {
      tier: [],
      type: [],
      path: [],
      shadow: "",
      sort: "risk",
      q: "",
    },
    { keys: URL_KEYS, replace: true },
  );

  const tierFilters = React.useMemo<Set<RoleTier>>(
    () => new Set(urlState.tier.filter((t) => t in TIER_META) as RoleTier[]),
    [urlState.tier],
  );
  const typeFilters = React.useMemo<Set<PrincipalType>>(
    () =>
      new Set(
        urlState.type.filter(
          (t): t is PrincipalType =>
            t === "User" ||
            t === "Group" ||
            t === "ServicePrincipal" ||
            t === "Unknown",
        ),
      ),
    [urlState.type],
  );
  const pathFilters = React.useMemo<Set<AssignmentPath>>(
    () =>
      new Set(
        urlState.path.filter(
          (p): p is AssignmentPath =>
            p === "direct" || p === "group" || p === "sp" || p === "guest",
        ),
      ),
    [urlState.path],
  );
  const shadowOnly = urlState.shadow === "1";
  const sortMode: SortMode = urlState.sort === "tier" ? "tier" : "risk";
  const searchTerm = urlState.q;

  // ENHANCEMENT — persisted "show only stale members (no activity 90d)"
  // filter. Operators leave this on during weekly hygiene sweeps.
  const [staleOnly, setStaleOnly] = usePersistedState<boolean>(
    "privileged-audit:stale-only",
    false,
  );

  // Memoized + stable audit hook for filter-mutation events. Per the brief,
  // the probe itself is read-only enumeration (no audit), but filter
  // mutations ARE worth recording because a stripped-down view can change
  // what an operator overlooks during a review.
  const recordFilterMutation = React.useCallback(
    (kind: string, value: unknown) => {
      auditLog.record({
        actor: primaryAccount?.username ?? "unknown",
        action: `privileged_audit_filter_${kind}`,
        target: tenantId || "no-tenant",
        status: "success",
        details: { value },
      });
    },
    [primaryAccount?.username, tenantId],
  );

  const toggleTierFilter = React.useCallback(
    (t: RoleTier) => {
      setUrlState((prev) => {
        const arr = prev.tier ?? [];
        const next = arr.includes(t)
          ? arr.filter((x) => x !== t)
          : [...arr, t];
        return { tier: next };
      });
      recordFilterMutation("tier", t);
    },
    [setUrlState, recordFilterMutation],
  );

  const toggleTypeFilter = React.useCallback(
    (t: PrincipalType) => {
      setUrlState((prev) => {
        const arr = prev.type ?? [];
        const next = arr.includes(t)
          ? arr.filter((x) => x !== t)
          : [...arr, t];
        return { type: next };
      });
      recordFilterMutation("type", t);
    },
    [setUrlState, recordFilterMutation],
  );

  const togglePathFilter = React.useCallback(
    (p: AssignmentPath) => {
      setUrlState((prev) => {
        const arr = prev.path ?? [];
        const next = arr.includes(p)
          ? arr.filter((x) => x !== p)
          : [...arr, p];
        return { path: next };
      });
      recordFilterMutation("path", p);
    },
    [setUrlState, recordFilterMutation],
  );

  const setShadowOnly = React.useCallback(
    (v: boolean) => {
      setUrlState({ shadow: v ? "1" : "" });
      recordFilterMutation("shadow_only", v);
    },
    [setUrlState, recordFilterMutation],
  );

  const setStaleOnlyAudited = React.useCallback(
    (v: boolean) => {
      setStaleOnly(v);
      recordFilterMutation("stale_only", v);
    },
    [setStaleOnly, recordFilterMutation],
  );

  const setSortMode = React.useCallback(
    (mode: SortMode) => {
      setUrlState({ sort: mode });
      recordFilterMutation("sort", mode);
    },
    [setUrlState, recordFilterMutation],
  );

  const setSearchTerm = React.useCallback(
    (s: string) => {
      setUrlState({ q: s });
    },
    [setUrlState],
  );

  const onClearFilters = React.useCallback(() => {
    setUrlState({
      tier: [],
      type: [],
      path: [],
      shadow: "",
      q: "",
      // intentionally NOT resetting `sort` — operators expect their sort
      // preference to survive a "clear filters" click.
    });
    recordFilterMutation("clear", null);
  }, [setUrlState, recordFilterMutation]);

  // -------------------------------------------------------------------------
  // Per-principal corpus-signal uplift — fold the four signals into the
  // risk score so flagged principals sort up the matrix.
  //
  // Citation: `_AZURE_BYPASS_PLAYBOOK.md` "Critical Defender Audit Surface" —
  // active indicators outweigh static role tier.
  // -------------------------------------------------------------------------
  const signalLiftById = React.useMemo<Map<string, number>>(() => {
    const lift = new Map<string, number>();
    const add = (id: string, sev: FindingSeverity) => {
      const cur = lift.get(id) ?? 0;
      lift.set(id, cur + SIGNAL_RISK_WEIGHTS[sev]);
    };
    // Signal A — every SP holding a high-priv Graph permission earns
    // uplift on its OWN principal row (SPs appear in section E).
    for (const f of dataset.highPrivGraphPermissions) {
      add(f.servicePrincipalId, gradeHighPrivGraphPermission(f));
    }
    // Signal B — federated cred uplifts the SP it lives under. We pass
    // "addKey recent" by joining against Signal A's hasRecentCredential.
    const recentCredSet = new Set(
      dataset.highPrivGraphPermissions
        .filter((f) => f.hasRecentCredential)
        .map((f) => f.servicePrincipalId),
    );
    for (const f of dataset.federatedCredentials) {
      add(
        f.servicePrincipalId,
        gradeFederatedCredential(f, recentCredSet.has(f.servicePrincipalId)),
      );
    }
    // Signal C — PIM eligibility lifts the principal directly.
    for (const f of dataset.pimEligibilities) {
      add(f.principalId, gradePimEligibility(f));
    }
    // Signal D — TAP issuance lifts the user it was issued to.
    for (const f of dataset.tapIssuances) {
      add(f.userId, gradeTapIssuance(f));
    }
    // Signal E — sync-account drift lifts the sync principal so it sorts to
    // the top of the matrix when it holds non-canonical roles.
    for (const f of dataset.syncAccountFindings) {
      if (f.hasDriftRole) add(f.principalId, gradeSyncAccount(f));
    }
    // Signal G — PIM-for-Groups eligibility lifts the eligible principal
    // (NOT the group — the principal is the one with latent privilege).
    for (const f of dataset.pimGroupEligibilities) {
      add(f.principalId, gradePimGroupEligibility(f));
    }
    // Signal F — Mixed-chain temporal correlation. Adds on top of the
    // individual contributors because the corpus framing treats temporal
    // coincidence as a force-multiplier beyond any single indicator.
    for (const f of dataset.mixedChainFindings) {
      add(f.principalId, f.severity);
    }
    return lift;
  }, [
    dataset.highPrivGraphPermissions,
    dataset.federatedCredentials,
    dataset.pimEligibilities,
    dataset.tapIssuances,
    dataset.syncAccountFindings,
    dataset.pimGroupEligibilities,
    dataset.mixedChainFindings,
  ]);

  // -------------------------------------------------------------------------
  // Derived per-section views
  // -------------------------------------------------------------------------
  // Pre-sort principals by the chosen sort mode. The sort is the heaviest
  // operation (full array copy + comparator) so we hoist it out of
  // `filteredPrincipals` and recompute only when the dataset or mode change.
  const sortedPrincipals = React.useMemo(() => {
    const copy = dataset.principals.slice();
    if (sortMode === "risk") {
      copy.sort(compareByRiskScoreWithSignals(signalLiftById));
    } else {
      copy.sort(compareByTierThenName);
    }
    return copy;
  }, [dataset.principals, sortMode, signalLiftById]);

  // Snapshot now() once per render so isStalePrincipal isn't re-evaluating
  // Date.now() inside .filter() on every principal.
  const probeNow = React.useMemo(() => Date.now(), [dataset.principals]);

  const filteredPrincipals = React.useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return sortedPrincipals.filter((p) => {
      if (tierFilters.size > 0 && !tierFilters.has(p.topTier)) return false;
      if (typeFilters.size > 0 && !typeFilters.has(p.type)) return false;
      if (pathFilters.size > 0) {
        const has = p.assignments.some((a) => pathFilters.has(a.path));
        if (!has) return false;
      }
      if (shadowOnly && !p.isShadowAdmin) return false;
      if (staleOnly && !isStalePrincipal(p, probeNow)) return false;
      if (q) {
        const hay =
          `${p.displayName} ${p.signInName ?? ""} ${p.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    sortedPrincipals,
    tierFilters,
    typeFilters,
    pathFilters,
    shadowOnly,
    staleOnly,
    searchTerm,
    probeNow,
  ]);

  const summary = React.useMemo(() => {
    let tier0 = 0;
    let tier1 = 0;
    let groupMediated = 0;
    let guestPrivileged = 0;
    let spPrivileged = 0;
    for (const p of dataset.principals) {
      if (p.topTier === "tier0") tier0++;
      if (p.topTier === "tier1") tier1++;
      if (p.assignments.some((a) => a.path === "group")) groupMediated++;
      if (p.isExternal && (p.topTier === "tier0" || p.topTier === "tier1")) {
        guestPrivileged++;
      }
      if (p.type === "ServicePrincipal") spPrivileged++;
    }
    return {
      total: dataset.principals.length,
      tier0,
      tier1,
      groupMediated,
      guestPrivileged,
      spPrivileged,
    };
  }, [dataset.principals]);

  // Privileged Role Administrators — flagged separately because they can
  // self-elevate to Global Admin without anyone noticing in the standard
  // "Global Administrators" view.
  const privilegedRoleAdmins = React.useMemo(
    () =>
      dataset.principals.filter((p) =>
        p.assignments.some((a) => isPrivilegedRoleAdmin(a.roleTemplateId)),
      ),
    [dataset.principals],
  );

  // -------------------------------------------------------------------------
  // Tier-0 Watchlist — operator-curated set of principals to monitor for
  // drift between probes. Persisted per-tenant in localStorage so that
  // adding "expected break-glass account" once survives reloads.
  //
  // The watchlist is INTENTIONALLY separate from the auto-detected Tier-0
  // set (every T0 holder is already shown in section B). It's an operator
  // override layer: "I want to know if THIS principal's roles change between
  // probes" — useful for break-glass accounts, vetted SPs, post-incident
  // monitoring of a previously-compromised principal, etc.
  // -------------------------------------------------------------------------
  // The watchlist + captured-roles maps are stored under a SINGLE storage
  // key with the tenant id as the inner map key, NOT as part of the storage
  // key itself. Reason: usePersistedState's persist effect fires on key
  // change, which means switching tenants with the live in-memory state
  // would otherwise overwrite the new tenant's persisted slot with the old
  // tenant's data (race between key change and value reset). The
  // tenant-indexed map avoids that race entirely.
  const [watchlistByTenant, setWatchlistByTenant] = usePersistedState<
    Record<string, WatchlistState>
  >(TIER0_WATCHLIST_STORAGE_KEY_PREFIX, {}, { version: 1 });
  const [watchlistRolesByTenant, setWatchlistRolesByTenant] =
    usePersistedState<Record<string, Record<string, string[]>>>(
      `${TIER0_WATCHLIST_STORAGE_KEY_PREFIX}:roles`,
      {},
      { version: 1 },
    );

  const watchlist: WatchlistState = React.useMemo(
    () => watchlistByTenant[tenantId] ?? EMPTY_WATCHLIST,
    [watchlistByTenant, tenantId],
  );
  const setWatchlist = React.useCallback(
    (updater: WatchlistState | ((prev: WatchlistState) => WatchlistState)) => {
      setWatchlistByTenant((prev) => {
        const current = prev[tenantId] ?? EMPTY_WATCHLIST;
        const next =
          typeof updater === "function"
            ? (updater as (p: WatchlistState) => WatchlistState)(current)
            : updater;
        return { ...prev, [tenantId]: next };
      });
    },
    [setWatchlistByTenant, tenantId],
  );
  const watchlistCapturedRoles = React.useMemo(
    () => watchlistRolesByTenant[tenantId] ?? {},
    [watchlistRolesByTenant, tenantId],
  );
  const setWatchlistCapturedRoles = React.useCallback(
    (
      updater:
        | Record<string, string[]>
        | ((prev: Record<string, string[]>) => Record<string, string[]>),
    ) => {
      setWatchlistRolesByTenant((prev) => {
        const current = prev[tenantId] ?? {};
        const next =
          typeof updater === "function"
            ? (updater as (
                p: Record<string, string[]>,
              ) => Record<string, string[]>)(current)
            : updater;
        return { ...prev, [tenantId]: next };
      });
    },
    [setWatchlistRolesByTenant, tenantId],
  );

  const capturedRolesByPrincipalId = React.useMemo(() => {
    const m = new Map<string, ReadonlySet<string>>();
    for (const [k, v] of Object.entries(watchlistCapturedRoles)) {
      m.set(k, new Set(v));
    }
    return m;
  }, [watchlistCapturedRoles]);

  const watchlistDrift = React.useMemo<WatchlistDrift[]>(
    () =>
      computeWatchlistDrift(
        watchlist,
        dataset.principals,
        capturedRolesByPrincipalId,
      ),
    [watchlist, dataset.principals, capturedRolesByPrincipalId],
  );

  const watchlistIds = React.useMemo(
    () => new Set(watchlist.entries.map((e) => e.principalId)),
    [watchlist],
  );

  const addToWatchlist = React.useCallback(
    (principal: PrivilegedPrincipal, note?: string) => {
      setWatchlist((prev) => {
        if (prev.entries.some((e) => e.principalId === principal.id)) {
          return prev;
        }
        const newEntry: WatchlistEntry = {
          principalId: principal.id,
          capturedDisplayName: principal.displayName,
          capturedSignInName: principal.signInName,
          capturedTier: principal.topTier,
          addedAt: new Date().toISOString(),
          note,
        };
        return { entries: [...prev.entries, newEntry] };
      });
      setWatchlistCapturedRoles((prev) => ({
        ...prev,
        [principal.id]: Array.from(
          new Set(principal.assignments.map((a) => a.roleTemplateId)),
        ),
      }));
      auditLog.record({
        actor: primaryAccount?.username ?? "unknown",
        action: `${PRIVILEGED_AUDIT_ACTION_PREFIX}watchlist_add`,
        target: principal.id,
        status: "success",
        details: { displayName: principal.displayName, note },
      });
    },
    [setWatchlist, setWatchlistCapturedRoles, primaryAccount?.username],
  );

  const removeFromWatchlist = React.useCallback(
    (principalId: string) => {
      setWatchlist((prev) => ({
        entries: prev.entries.filter((e) => e.principalId !== principalId),
      }));
      setWatchlistCapturedRoles((prev) => {
        const next = { ...prev };
        delete next[principalId];
        return next;
      });
      auditLog.record({
        actor: primaryAccount?.username ?? "unknown",
        action: `${PRIVILEGED_AUDIT_ACTION_PREFIX}watchlist_remove`,
        target: principalId,
        status: "success",
      });
    },
    [setWatchlist, setWatchlistCapturedRoles, primaryAccount?.username],
  );

  // -------------------------------------------------------------------------
  // Audit-log mirror — feeds the per-principal timeline inside expanded
  // assignment-detail rows. We subscribe to the auditLog singleton and
  // re-render the page when a privileged-audit event lands so the timeline
  // updates live (filter mutations, watchlist add/remove, signal exports).
  // The subscription is read-only — we never write through this view.
  // -------------------------------------------------------------------------
  const [auditMirror, setAuditMirror] = React.useState<AuditEntry[]>(() =>
    auditLog.getEntries(200),
  );
  React.useEffect(() => {
    const refresh = () => {
      if (!mountedRef.current) return;
      setAuditMirror(auditLog.getEntries(200));
    };
    refresh();
    return auditLog.subscribe(
      (e) => e.action.startsWith(PRIVILEGED_AUDIT_ACTION_PREFIX),
      refresh,
    );
  }, []);
  const auditEventsByTarget = React.useMemo(() => {
    const m = new Map<string, AuditEntry[]>();
    for (const e of auditMirror) {
      const list = m.get(e.target) ?? [];
      list.push(e);
      m.set(e.target, list);
    }
    return m;
  }, [auditMirror]);

  // -------------------------------------------------------------------------
  // Critical-finding count for the ARIA-live region. Recomputes from the
  // signal arrays; a change is announced to screen-reader users via the
  // <output> below the page header.
  // -------------------------------------------------------------------------
  const criticalFindingCount = React.useMemo(() => {
    let n = 0;
    for (const f of dataset.highPrivGraphPermissions)
      if (gradeHighPrivGraphPermission(f) === "critical") n++;
    const recentCredSet = new Set(
      dataset.highPrivGraphPermissions
        .filter((f) => f.hasRecentCredential)
        .map((f) => f.servicePrincipalId),
    );
    for (const f of dataset.federatedCredentials)
      if (
        gradeFederatedCredential(
          f,
          recentCredSet.has(f.servicePrincipalId),
        ) === "critical"
      )
        n++;
    for (const f of dataset.pimEligibilities)
      if (gradePimEligibility(f) === "critical") n++;
    for (const f of dataset.tapIssuances)
      if (gradeTapIssuance(f) === "critical") n++;
    for (const f of dataset.syncAccountFindings)
      if (gradeSyncAccount(f) === "critical") n++;
    for (const f of dataset.pimGroupEligibilities)
      if (gradePimGroupEligibility(f) === "critical") n++;
    for (const f of dataset.mixedChainFindings)
      if (f.severity === "critical") n++;
    return n;
  }, [
    dataset.highPrivGraphPermissions,
    dataset.federatedCredentials,
    dataset.pimEligibilities,
    dataset.tapIssuances,
    dataset.syncAccountFindings,
    dataset.pimGroupEligibilities,
    dataset.mixedChainFindings,
  ]);

  // -------------------------------------------------------------------------
  // Hotkey commands. Live in a ref so the Section B list can call them
  // without dragging the entire callback chain through props. Per the
  // brief: `c` collapses all expanded; `e` exports the critical-findings
  // subset only.
  // -------------------------------------------------------------------------
  const collapseAllRef = React.useRef<(() => void) | null>(null);
  const exportCriticalRef = React.useRef<(() => void) | null>(null);
  useShortcut("c", () => collapseAllRef.current?.(), {
    allowInInputs: false,
    preventDefault: false,
  });
  useShortcut("e", () => exportCriticalRef.current?.(), {
    allowInInputs: false,
    preventDefault: false,
  });

  // Live tenant-change propagation. This page auto-targets the primary
  // signed-in account's active tenant, so when that account's active tenant
  // changes elsewhere in the app, drop the stale Graph token, abort any
  // in-flight probe (otherwise we'd write tenant-A results into tenant-B's
  // dataset), and re-acquire fresh credentials.
  const onTenantChange = React.useCallback(
    (detail: { homeAccountId: string; tenantId: string }) => {
      const candidate = detail.homeAccountId;
      if (!azureAccounts.some((a) => a.homeAccountId === candidate)) return;
      if (primaryAccount?.homeAccountId !== candidate) return;
      if (detail.tenantId === tenantId) return;
      probeAbortRef.current?.abort();
      probeAbortRef.current = null;
      setGraphToken(null);
      setGraphTokenExpiresAt(null);
      setDataset(EMPTY_DATASET);
      probeStartedRef.current = false;
      void acquireGraphToken();
    },
    [azureAccounts, primaryAccount?.homeAccountId, tenantId, acquireGraphToken],
  );
  useTenantChange(undefined, onTenantChange);

  // -------------------------------------------------------------------------
  // Render guards (no account / no tenant)
  // -------------------------------------------------------------------------
  if (!primaryAccount) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader
          title="Privileged Audit"
          description="Discover privileged identities, group-mediated escalations, service principals with roles, and guest privileges in your active tenant. Read-only Graph probes only."
        />
        <EmptyState
          icon={ShieldAlert}
          title="Sign in to an Azure account first"
          description="The Privileged Audit page needs a signed-in account with Directory.Read.All against the tenant you want to audit."
        />
      </section>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const tenantLabel =
    primaryAccount?.tenants?.find((t) => t.tenantId === tenantId)?.displayName ??
    tenantId;
  const loading = status === "loading";

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        title="Privileged Audit"
        description="SkyArk-inspired defensive auditor. Enumerates every directory role holder in the active tenant, including indirect (group-mediated), service-principal, and guest paths that the portal's role blade hides."
      >
        <TokenExpiryBadge
          secondsUntilExpiry={graphSecondsUntilExpiry}
          loading={graphTokenLoading}
          onRefresh={() => void acquireGraphToken()}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void runProbe()}
          disabled={loading || !graphToken}
          aria-label="Re-run the privileged audit probe"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            aria-hidden
          />
          {loading ? "Probing…" : "Re-probe"}
        </Button>
      </PageHeader>

      <TenantHeaderCard
        tenantId={tenantId}
        tenantLabel={tenantLabel}
        username={primaryAccount.username}
        activatedRoleCount={dataset.activatedRoleCount}
        lastProbedAt={lastProbedAt}
      />

      {graphTokenError && (
        <Alert variant="destructive">
          <KeyRound className="h-4 w-4" />
          <AlertTitle>Could not acquire a Graph token</AlertTitle>
          <AlertDescription>{graphTokenError}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Probe failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {dataset.warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Partial data ({dataset.warnings.length})</AlertTitle>
          <AlertDescription>
            Some Graph sub-probes degraded. Results below may be incomplete.
            <ul className="mt-1 list-disc pl-5 text-xs">
              {dataset.warnings.slice(0, 5).map((w) => (
                <li key={w.id}>{w.message}</li>
              ))}
              {dataset.warnings.length > 5 && (
                <li>+ {dataset.warnings.length - 5} more…</li>
              )}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/*
        ARIA-live region for screen-reader users: announces the critical-
        finding count whenever it changes (probe finished, signal grading
        updated). `aria-live="polite"` so it never preempts user-typed
        narration; `role="status"` for VoiceOver consistency. Visually
        invisible — sighted users see the same number in the corpus-signals
        card below.
      */}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {loading
          ? "Privileged audit probing…"
          : criticalFindingCount === 0
            ? "Privileged audit complete. No critical findings."
            : `Privileged audit complete. ${criticalFindingCount} critical finding${
                criticalFindingCount === 1 ? "" : "s"
              }.`}
      </p>

      {/* ─────────────────────────────────────────────────────────── A */}
      <SummaryStatsRow summary={summary} loading={loading} />

      {/* ─────────── Tier-0 Watchlist (operator-curated) ─────────────── */}
      <Tier0WatchlistCard
        watchlist={watchlist}
        drift={watchlistDrift}
        onRemove={removeFromWatchlist}
      />

      {/* Filters bar (applies to section B). */}
      <FiltersBar
        tierFilters={tierFilters}
        typeFilters={typeFilters}
        pathFilters={pathFilters}
        shadowOnly={shadowOnly}
        staleOnly={staleOnly}
        sortMode={sortMode}
        searchTerm={searchTerm}
        principals={dataset.principals}
        onToggleTier={toggleTierFilter}
        onToggleType={toggleTypeFilter}
        onTogglePath={togglePathFilter}
        onShadowOnlyChange={setShadowOnly}
        onStaleOnlyChange={setStaleOnlyAudited}
        onSortModeChange={setSortMode}
        onSearchTermChange={setSearchTerm}
        onClear={onClearFilters}
      />

      {/* ─────────────────────────────────────────────────────────── B */}
      <PrivilegedIdentityList
        principals={filteredPrincipals}
        tenantId={tenantId}
        loading={loading}
        tenantTotal={dataset.principals.length}
        dataset={dataset}
        summary={summary}
        signalLiftById={signalLiftById}
        watchlistIds={watchlistIds}
        onAddToWatchlist={addToWatchlist}
        onRemoveFromWatchlist={removeFromWatchlist}
        auditEventsByTarget={auditEventsByTarget}
        collapseAllRef={collapseAllRef}
        exportCriticalRef={exportCriticalRef}
        criticalFindingCount={criticalFindingCount}
      />

      {/* ─────────────────────── Corpus Detection Signals (A/B/C/D) ─── */}
      <CorpusDetectionSignalsCard
        dataset={dataset}
        loading={loading}
      />

      {/* ─────────────────────────────────────────────────────────── C */}
      <ShadowAdminPathsPanel
        paths={dataset.shadowPaths}
        privilegedRoleAdmins={privilegedRoleAdmins}
        loading={loading}
      />

      {/* ─────────────────────────────────────────────────────────── D */}
      <GroupsHoldingRolesCard
        groups={dataset.groups}
        loading={loading}
      />

      {/* ─────────────────────────────────────────────────────────── E */}
      <ServicePrincipalsCard
        sps={dataset.servicePrincipals}
        loading={loading}
      />
    </section>
  );
};

// ===========================================================================
// Section: tenant header card
// ===========================================================================

const TenantHeaderCard: React.FC<{
  tenantId: string;
  tenantLabel: string;
  username: string;
  activatedRoleCount: number;
  lastProbedAt: string | null;
}> = ({ tenantId, tenantLabel, username, activatedRoleCount, lastProbedAt }) => (
  <Card>
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
      <div className="min-w-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-info" />
          {tenantLabel}
        </CardTitle>
        <CardDescription className="group/copy flex items-center gap-1.5 font-mono text-2xs">
          {tenantId || "no tenant"}
          {tenantId && <CopyButton value={tenantId} />}
        </CardDescription>
      </div>
      <div className="flex flex-col items-end gap-0.5 text-2xs text-muted-foreground">
        <span>Signed in as {username}</span>
        <span>
          {activatedRoleCount} activated directory role
          {activatedRoleCount === 1 ? "" : "s"}
        </span>
        {lastProbedAt && (
          <span>Last probe: {formatRelativeTime(lastProbedAt)}</span>
        )}
      </div>
    </CardHeader>
  </Card>
);

// ===========================================================================
// Section A: summary stats row
// ===========================================================================

const SummaryStatsRow: React.FC<{
  summary: {
    total: number;
    tier0: number;
    tier1: number;
    groupMediated: number;
    guestPrivileged: number;
    spPrivileged: number;
  };
  loading: boolean;
}> = ({ summary, loading }) => (
  <div
    className="flex flex-wrap gap-2"
    role="group"
    aria-label="Privileged audit summary"
  >
    <SummaryStatItem
      label="Total privileged"
      value={loading ? "…" : summary.total}
    />
    <SummaryStatItem
      label="Tier 0 — Global"
      value={loading ? "…" : summary.tier0}
      tone="destructive"
      hint="Global / Privileged Role Admin"
    />
    <SummaryStatItem
      label="Tier 1 — Sensitive"
      value={loading ? "…" : summary.tier1}
      tone="warning"
    />
    <SummaryStatItem
      label="Via group"
      value={loading ? "…" : summary.groupMediated}
      tone="info"
      hint="Shadow admins"
    />
    <SummaryStatItem
      label="Guest-privileged"
      value={loading ? "…" : summary.guestPrivileged}
      tone="destructive"
      hint="Cross-tenant T0/T1"
    />
    <SummaryStatItem
      label="SP-privileged"
      value={loading ? "…" : summary.spPrivileged}
      tone="info"
      hint="Workload identities"
    />
  </div>
);

// ===========================================================================
// Filters bar
// ===========================================================================

interface FiltersBarProps {
  tierFilters: Set<RoleTier>;
  typeFilters: Set<PrincipalType>;
  pathFilters: Set<AssignmentPath>;
  shadowOnly: boolean;
  staleOnly: boolean;
  sortMode: "risk" | "tier";
  searchTerm: string;
  principals: PrivilegedPrincipal[];
  onToggleTier: (t: RoleTier) => void;
  onToggleType: (t: PrincipalType) => void;
  onTogglePath: (p: AssignmentPath) => void;
  onShadowOnlyChange: (v: boolean) => void;
  onStaleOnlyChange: (v: boolean) => void;
  onSortModeChange: (mode: "risk" | "tier") => void;
  onSearchTermChange: (s: string) => void;
  onClear: () => void;
}

const FiltersBar: React.FC<FiltersBarProps> = ({
  tierFilters,
  typeFilters,
  pathFilters,
  shadowOnly,
  staleOnly,
  sortMode,
  searchTerm,
  principals,
  onToggleTier,
  onToggleType,
  onTogglePath,
  onShadowOnlyChange,
  onStaleOnlyChange,
  onSortModeChange,
  onSearchTermChange,
  onClear,
}) => {
  // Counts per filter value, for the chip badges.
  const tierCounts = React.useMemo(() => {
    const c: Record<RoleTier, number> = {
      tier0: 0,
      tier1: 0,
      tier2: 0,
      tier3: 0,
      other: 0,
    };
    for (const p of principals) c[p.topTier]++;
    return c;
  }, [principals]);
  const typeCounts = React.useMemo(() => {
    const c: Record<PrincipalType, number> = {
      User: 0,
      Group: 0,
      ServicePrincipal: 0,
      Unknown: 0,
    };
    for (const p of principals) c[p.type]++;
    return c;
  }, [principals]);
  const pathCounts = React.useMemo(() => {
    const c: Record<AssignmentPath, number> = {
      direct: 0,
      group: 0,
      sp: 0,
      guest: 0,
    };
    for (const p of principals) {
      const seen = new Set<AssignmentPath>();
      for (const a of p.assignments) {
        if (seen.has(a.path)) continue;
        seen.add(a.path);
        c[a.path]++;
      }
    }
    return c;
  }, [principals]);

  const activeFilterCount =
    tierFilters.size +
    typeFilters.size +
    pathFilters.size +
    (shadowOnly ? 1 : 0) +
    (staleOnly ? 1 : 0) +
    (searchTerm.trim() ? 1 : 0);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilterIcon
            className="h-3.5 w-3.5 text-muted-foreground"
            aria-hidden
          />
          <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Filters
          </span>
          <div className="ml-auto flex items-center gap-2">
            {/* Sort segmented control — risk (default, highest privilege
                first) vs strict tier order. */}
            <div
              role="radiogroup"
              aria-label="Sort mode"
              className="inline-flex rounded-md border border-border bg-card p-0.5 text-2xs"
            >
              <button
                type="button"
                role="radio"
                aria-checked={sortMode === "risk"}
                onClick={() => onSortModeChange("risk")}
                className={cn(
                  "rounded px-2 py-0.5 transition-colors",
                  sortMode === "risk"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="Sort by composite risk score — highest privilege first"
              >
                Risk
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={sortMode === "tier"}
                onClick={() => onSortModeChange("tier")}
                className={cn(
                  "rounded px-2 py-0.5 transition-colors",
                  sortMode === "tier"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="Sort strictly by tier (T0 → T3), then by display name"
              >
                Tier
              </button>
            </div>
            <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <input
                type="checkbox"
                checked={shadowOnly}
                onChange={(e) => onShadowOnlyChange(e.target.checked)}
                aria-label="Show only shadow admins"
                className="h-3.5 w-3.5 rounded border-border"
              />
              <Sparkles
                className="h-3 w-3 text-warning"
                aria-hidden
              />
              Shadow only
              <InfoTooltip content="Anything other than a Direct user assignment — group-mediated, service-principal, or guest paths." />
            </label>
            <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <input
                type="checkbox"
                checked={staleOnly}
                onChange={(e) => onStaleOnlyChange(e.target.checked)}
                aria-label="Show only stale members (no activity in 90 days)"
                className="h-3.5 w-3.5 rounded border-border"
              />
              <Clock className="h-3 w-3 text-info" aria-hidden />
              Stale only
              <InfoTooltip
                content={`Best-effort: SPs whose createdDateTime is older than ${Math.round(
                  STALE_THRESHOLD_MS / (24 * 60 * 60 * 1000),
                )} days, and users with no resolvable UPN. signInActivity from Graph would give a precise number but requires AuditLog.Read.All which this page deliberately does not demand.`}
              />
            </label>
            {activeFilterCount > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onClear}
                aria-label="Clear all filters"
              >
                <EyeOff className="h-3.5 w-3.5" />
                Clear ({activeFilterCount})
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <ChipGroupLabel>Tier</ChipGroupLabel>
          {(Object.keys(TIER_META) as RoleTier[]).map((t) => (
            <FilterChip
              key={t}
              active={tierFilters.has(t)}
              onClick={() => onToggleTier(t)}
              tooltip={TIER_META[t].description}
            >
              {TIER_META[t].label.split(" — ")[0] ?? TIER_META[t].label}
              <span className="ml-1 text-2xs opacity-70">
                {tierCounts[t]}
              </span>
            </FilterChip>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <ChipGroupLabel>Type</ChipGroupLabel>
          {(["User", "Group", "ServicePrincipal"] as PrincipalType[]).map(
            (t) => (
              <FilterChip
                key={t}
                active={typeFilters.has(t)}
                onClick={() => onToggleType(t)}
              >
                {t === "ServicePrincipal" ? "Service principal" : t}
                <span className="ml-1 text-2xs opacity-70">
                  {typeCounts[t]}
                </span>
              </FilterChip>
            ),
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <ChipGroupLabel>Assignment path</ChipGroupLabel>
          {(Object.keys(ASSIGNMENT_PATH_META) as AssignmentPath[]).map((p) => (
            <FilterChip
              key={p}
              active={pathFilters.has(p)}
              onClick={() => onTogglePath(p)}
              tooltip={ASSIGNMENT_PATH_META[p].description}
            >
              {ASSIGNMENT_PATH_META[p].label}
              <span className="ml-1 text-2xs opacity-70">
                {pathCounts[p]}
              </span>
            </FilterChip>
          ))}
        </div>

        <label className="relative block">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Search by name, UPN, or object id…"
            value={searchTerm}
            onChange={(e) => onSearchTermChange(e.target.value)}
            className="pl-8"
            aria-label="Search privileged identities"
          />
        </label>
      </CardContent>
    </Card>
  );
};

const ChipGroupLabel: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <span className="self-center pr-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
    {children}
  </span>
);

const FilterChip: React.FC<{
  active: boolean;
  onClick: () => void;
  tooltip?: string;
  children: React.ReactNode;
}> = ({ active, onClick, tooltip, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={tooltip}
    aria-pressed={active}
    className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-2xs font-medium transition-colors",
      active
        ? "border-primary bg-primary/15 text-primary"
        : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
    )}
  >
    {children}
  </button>
);

// ===========================================================================
// Section B: privileged identity list
// ===========================================================================

/**
 * Build the principal-export column list. We pass the per-principal corpus
 * signal-lift map in so the exported "Risk score" column matches the value
 * used to sort the on-screen table.
 */
function principalExportColumns(
  signalLiftById: ReadonlyMap<string, number>,
): ReadonlyArray<ExportColumn<PrivilegedPrincipal>> {
  return [
    { header: "Display name", accessor: (p) => p.displayName },
    { header: "Type", accessor: (p) => p.type },
    { header: "Sign-in name", accessor: (p) => p.signInName ?? "" },
    { header: "Object id", accessor: (p) => p.id },
    { header: "Top tier", accessor: (p) => TIER_META[p.topTier].label },
    {
      header: "Risk score",
      accessor: (p) => riskScore(p, signalLiftById.get(p.id) ?? 0),
    },
    {
      header: "Signal lift",
      accessor: (p) => signalLiftById.get(p.id) ?? 0,
    },
    {
      header: "Roles",
      accessor: (p) =>
        Array.from(new Set(p.assignments.map((a) => a.roleDisplayName))).join("; "),
    },
    {
      header: "Role template ids",
      accessor: (p) =>
        Array.from(new Set(p.assignments.map((a) => a.roleTemplateId))).join("; "),
    },
    {
      header: "Assignment paths",
      accessor: (p) =>
        Array.from(new Set(p.assignments.map((a) => a.path))).join("; "),
    },
    { header: "Shadow admin", accessor: (p) => (p.isShadowAdmin ? "yes" : "no") },
    { header: "Guest", accessor: (p) => (p.isExternal ? "yes" : "no") },
    { header: "Stale (heuristic)", accessor: (p) => (isStalePrincipal(p) ? "yes" : "no") },
  ];
}

interface PrivilegedIdentityListProps {
  principals: PrivilegedPrincipal[];
  tenantId: string;
  tenantTotal: number;
  loading: boolean;
  dataset: PrivilegedAuditDataset;
  summary: {
    total: number;
    tier0: number;
    tier1: number;
    groupMediated: number;
    guestPrivileged: number;
    spPrivileged: number;
  };
  /** Per-principal uplift from the corpus-derived detection signals. */
  signalLiftById: ReadonlyMap<string, number>;
  /** Object ids currently on the operator watchlist. */
  watchlistIds: ReadonlySet<string>;
  onAddToWatchlist: (p: PrivilegedPrincipal, note?: string) => void;
  onRemoveFromWatchlist: (principalId: string) => void;
  /** Audit-log events keyed by target id, for the per-principal timeline. */
  auditEventsByTarget: ReadonlyMap<string, AuditEntry[]>;
  /** Slot the parent fills with the "collapse all expanded" handler. */
  collapseAllRef: React.MutableRefObject<(() => void) | null>;
  /** Slot the parent fills with the "export critical findings only" handler. */
  exportCriticalRef: React.MutableRefObject<(() => void) | null>;
  /** Total critical findings across all 7 corpus signals. */
  criticalFindingCount: number;
}

const PrivilegedIdentityList: React.FC<PrivilegedIdentityListProps> = ({
  principals,
  tenantId,
  tenantTotal,
  loading,
  dataset,
  summary,
  signalLiftById,
  watchlistIds,
  onAddToWatchlist,
  onRemoveFromWatchlist,
  auditEventsByTarget,
  collapseAllRef,
  exportCriticalRef,
  criticalFindingCount,
}) => {
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () => new Set(),
  );
  const toggleExpand = React.useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Wire the parent's hotkey refs to a stable "collapse all" handler.
  // The hotkey 'c' is owned by the parent (useShortcut('c')) — we just
  // install the implementation here so the parent doesn't need access to
  // the expanded Set. Cleanup uses pointer-equality so we only NULL the
  // slot if our handler is still the one installed.
  React.useEffect(() => {
    const handler = () => setExpanded(new Set());
    collapseAllRef.current = handler;
    return () => {
      if (collapseAllRef.current === handler) {
        collapseAllRef.current = null;
      }
    };
  }, [collapseAllRef]);

  // For JSON export we want EVERYTHING (paths, summary stats, partial-data
  // warnings, AND the corpus-derived detection signals A/B/C/D) so the file
  // is self-contained per the spec.
  const exportPayload = React.useMemo(
    () => ({
      tenantId,
      probedAt: new Date().toISOString(),
      summary,
      shadowAdminPaths: dataset.shadowPaths,
      groupsHoldingRoles: dataset.groups,
      servicePrincipals: dataset.servicePrincipals,
      warnings: dataset.warnings,
      corpusSignals: {
        // See privileged-audit-helpers.ts header for the corpus citations.
        // The seven-signal set: A (Graph perms), B (FIC), C (PIM elig),
        // D (TAP), E (sync drift), F (mixed chains), G (PIM-for-Groups).
        A_highPrivGraphPermissions: dataset.highPrivGraphPermissions,
        B_federatedCredentials: dataset.federatedCredentials,
        C_pimEligibilities: dataset.pimEligibilities,
        D_tapIssuances: dataset.tapIssuances,
        E_syncAccountFindings: dataset.syncAccountFindings,
        F_mixedChainFindings: dataset.mixedChainFindings,
        G_pimGroupEligibilities: dataset.pimGroupEligibilities,
      },
    }),
    [tenantId, summary, dataset],
  );

  // Build the principal export columns lazily so the "Risk score" column
  // matches the on-screen value (base + corpus signal lift).
  const exportColumns = React.useMemo(
    () => principalExportColumns(signalLiftById),
    [signalLiftById],
  );

  // -------------------------------------------------------------------------
  // Hotkey: 'e' → export critical findings only.
  //
  // Composes a focused subset of the JSON export — only critical-graded
  // findings across all 7 corpus signals, plus the critical-tagged
  // mixed-chain rows. The download is silent (no menu) so an operator on
  // call can grab the incident-handoff blob with one keystroke.
  // -------------------------------------------------------------------------
  React.useEffect(() => {
    const handler = () => {
      const recentCredSet = new Set(
        dataset.highPrivGraphPermissions
          .filter((f) => f.hasRecentCredential)
          .map((f) => f.servicePrincipalId),
      );
      const payload = {
        tenantId,
        exportedAt: new Date().toISOString(),
        kind: "privileged-audit-critical-only",
        criticalCount: criticalFindingCount,
        signals: {
          A_highPrivGraphPermissions: dataset.highPrivGraphPermissions.filter(
            (f) => gradeHighPrivGraphPermission(f) === "critical",
          ),
          B_federatedCredentials: dataset.federatedCredentials.filter(
            (f) =>
              gradeFederatedCredential(
                f,
                recentCredSet.has(f.servicePrincipalId),
              ) === "critical",
          ),
          C_pimEligibilities: dataset.pimEligibilities.filter(
            (f) => gradePimEligibility(f) === "critical",
          ),
          D_tapIssuances: dataset.tapIssuances.filter(
            (f) => gradeTapIssuance(f) === "critical",
          ),
          E_syncAccountFindings: dataset.syncAccountFindings.filter(
            (f) => gradeSyncAccount(f) === "critical",
          ),
          F_mixedChainFindings: dataset.mixedChainFindings.filter(
            (f) => f.severity === "critical",
          ),
          G_pimGroupEligibilities: dataset.pimGroupEligibilities.filter(
            (f) => gradePimGroupEligibility(f) === "critical",
          ),
        },
      };
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`privileged-audit-critical-${stamp}.json`, payload);
      auditLog.record({
        actor: "hotkey",
        action: `${PRIVILEGED_AUDIT_ACTION_PREFIX}export_critical`,
        target: tenantId || "no-tenant",
        status: "success",
        details: { count: criticalFindingCount },
      });
    };
    exportCriticalRef.current = handler;
    return () => {
      if (exportCriticalRef.current === handler) {
        exportCriticalRef.current = null;
      }
    };
  }, [
    exportCriticalRef,
    dataset.highPrivGraphPermissions,
    dataset.federatedCredentials,
    dataset.pimEligibilities,
    dataset.tapIssuances,
    dataset.syncAccountFindings,
    dataset.pimGroupEligibilities,
    dataset.mixedChainFindings,
    tenantId,
    criticalFindingCount,
  ]);

  const columns: DataTableColumn<PrivilegedPrincipal>[] = React.useMemo(
    () => [
      {
        id: "expand",
        header: "",
        width: "w-8",
        cell: (p) => (
          <button
            type="button"
            onClick={() => toggleExpand(p.id)}
            aria-label={
              expanded.has(p.id) ? "Collapse details" : "Expand details"
            }
            className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {expanded.has(p.id) ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ),
      },
      {
        id: "identity",
        header: "Identity",
        sort: (a, b) =>
          a.displayName.localeCompare(b.displayName, undefined, {
            sensitivity: "base",
          }),
        cell: (p) => (
          <div className="group/copy flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">
              {p.displayName}
            </span>
            {p.signInName && (
              <span className="truncate font-mono text-2xs text-muted-foreground">
                {p.signInName}
              </span>
            )}
            <span className="flex items-center gap-1 font-mono text-3xs text-muted-foreground/70">
              {p.id}
              <CopyButton value={p.id} />
            </span>
          </div>
        ),
        csv: (p) => p.displayName,
      },
      {
        id: "type",
        header: "Type",
        width: "w-24",
        sort: (a, b) => a.type.localeCompare(b.type),
        cell: (p) => (
          <Badge variant={p.type === "ServicePrincipal" ? "info" : "outline"}>
            {p.type === "ServicePrincipal" ? "SP" : p.type}
          </Badge>
        ),
      },
      {
        id: "tier",
        header: "Tier",
        width: "w-36",
        sort: (a, b) => TIER_META[a.topTier].order - TIER_META[b.topTier].order,
        cell: (p) => <TierBadge tier={p.topTier} compact />,
      },
      {
        id: "roles",
        header: "Roles",
        cell: (p) => {
          const unique = Array.from(
            new Map(
              p.assignments.map((a) => [a.roleId, a.roleDisplayName]),
            ).entries(),
          );
          return (
            <div className="flex flex-wrap gap-1">
              {unique.slice(0, 3).map(([id, name]) => (
                <Badge key={id} variant="secondary" title={name}>
                  {name}
                </Badge>
              ))}
              {unique.length > 3 && (
                <Badge variant="outline">+{unique.length - 3}</Badge>
              )}
            </div>
          );
        },
      },
      {
        id: "paths",
        header: "Path",
        width: "w-44",
        cell: (p) => {
          const paths = Array.from(new Set(p.assignments.map((a) => a.path)));
          return (
            <div className="flex flex-wrap gap-1">
              {paths.map((path) => (
                <PathBadge key={path} path={path} />
              ))}
            </div>
          );
        },
      },
      {
        id: "risk",
        header: "Risk",
        width: "w-16",
        sort: (a, b) =>
          riskScore(b, signalLiftById.get(b.id) ?? 0) -
          riskScore(a, signalLiftById.get(a.id) ?? 0),
        cell: (p) => {
          const lift = signalLiftById.get(p.id) ?? 0;
          const base = riskScore(p);
          const total = riskScore(p, lift);
          return (
            <span
              className={cn(
                "tabular-nums text-2xs",
                lift > 0
                  ? "font-medium text-warning"
                  : "text-muted-foreground",
              )}
              title={
                lift > 0
                  ? `Risk ${total.toLocaleString()} = base ${base.toLocaleString()} + corpus-signal lift ${lift.toLocaleString()}. ` +
                    "Lift comes from Signals A/B/C/D — see Corpus Detection Signals card."
                  : "Composite risk score — Tier-weighted (T0=1000, T1=100, T2=10, T3=1) plus shadow/guest/SP modifiers. See helpers.riskScore()."
              }
            >
              {total.toLocaleString()}
            </span>
          );
        },
        csv: (p) => riskScore(p, signalLiftById.get(p.id) ?? 0),
      },
      {
        id: "activity",
        header: "Activity",
        width: "w-24",
        cell: (p) => {
          // Graph's signInActivity endpoint would give us a true last-sign-in
          // stamp but requires AuditLog.Read.All which this page deliberately
          // doesn't demand. We surface our best-effort "stale" heuristic
          // instead (see isStalePrincipal()) so the value is at least
          // honestly labelled.
          const stale = isStalePrincipal(p);
          if (stale) {
            return (
              <Badge
                variant="warning"
                title="Stale by heuristic — see filter tooltip"
              >
                Stale
              </Badge>
            );
          }
          if (p.type === "ServicePrincipal" && p.createdDateTime) {
            return (
              <span
                className="text-2xs text-muted-foreground"
                title={`Created ${p.createdDateTime}`}
              >
                {formatRelativeTime(p.createdDateTime)}
              </span>
            );
          }
          return <span className="text-2xs text-muted-foreground">—</span>;
        },
      },
      {
        id: "watch",
        header: "",
        width: "w-8",
        cell: (p) => {
          const watched = watchlistIds.has(p.id);
          return (
            <button
              type="button"
              onClick={() =>
                watched ? onRemoveFromWatchlist(p.id) : onAddToWatchlist(p)
              }
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded",
                watched
                  ? "text-warning hover:bg-warning/15"
                  : "text-muted-foreground/60 hover:bg-muted hover:text-foreground",
              )}
              title={
                watched
                  ? "Remove from Tier-0 Watchlist — stop monitoring drift"
                  : "Add to Tier-0 Watchlist — alert on tier or role changes between probes"
              }
              aria-label={
                watched
                  ? `Remove ${p.displayName} from watchlist`
                  : `Add ${p.displayName} to watchlist`
              }
              aria-pressed={watched}
            >
              {/* Filled bookmark when watched, outline otherwise — Sparkles
                  re-used here as the visual cue without taking another
                  lucide-react slot. */}
              <Sparkles
                className={cn(
                  "h-3 w-3",
                  watched ? "fill-warning/30" : "",
                )}
                aria-hidden
              />
            </button>
          );
        },
      },
      {
        id: "actions",
        header: "",
        width: "w-12",
        cell: (p) => (
          <a
            href={portalDeepLink(tenantId, p)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Open in Azure portal"
            aria-label={`Open ${p.displayName} in the Azure portal`}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        ),
      },
    ],
    [
      tenantId,
      expanded,
      signalLiftById,
      toggleExpand,
      watchlistIds,
      onAddToWatchlist,
      onRemoveFromWatchlist,
    ],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-info" /> Privileged identities
            <InfoTooltip content="Every user / group / service-principal that holds at least one activated directory role in the tenant — direct or transitive. Press `c` to collapse all expanded rows; press `e` to export critical findings only." />
          </CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-2">
            Showing {principals.length} of {tenantTotal} privileged identities.
            <span className="hidden text-3xs text-muted-foreground/80 sm:inline">
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-3xs">
                c
              </kbd>{" "}
              collapse all,{" "}
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-3xs">
                e
              </kbd>{" "}
              export critical ({criticalFindingCount})
            </span>
          </CardDescription>
        </div>
        <ExportMenu
          rows={principals}
          columns={exportColumns}
          filename="privileged-audit"
          jsonMetadata={exportPayload}
        />
      </CardHeader>
      <CardContent>
        <DataTable
          tableId="privileged-audit-identities"
          rows={principals}
          columns={columns}
          rowKey={(p) => p.id}
          loading={loading}
          // Rows arrive pre-sorted by the parent (risk score by default,
          // strict tier order when sortMode === "tier"). Letting DataTable
          // apply an initialSort would fight the parent ordering, so we
          // omit it and only honour explicit per-column clicks by the user.
          empty={
            loading ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <EmptyState
                icon={ShieldCheck}
                title={
                  tenantTotal === 0
                    ? "No privileged identities found"
                    : "No identities match the current filters"
                }
                description={
                  tenantTotal === 0
                    ? "Either the tenant has no activated directory roles, or the signed-in account lacks Directory.Read.All."
                    : "Try clearing some chips or the search term."
                }
                size="compact"
              />
            )
          }
        />
        {/* Expanded detail rows — only iterate the principals the user
            actually expanded (was O(N) on every render before). */}
        {principals
          .filter((p) => expanded.has(p.id))
          .map((p) => (
            <ExpandedAssignmentDetail
              key={`exp-${p.id}`}
              principal={p}
              tenantId={tenantId}
              signalLift={signalLiftById.get(p.id) ?? 0}
              auditEvents={auditEventsByTarget.get(p.id) ?? []}
              isWatched={watchlistIds.has(p.id)}
              onAddToWatchlist={onAddToWatchlist}
              onRemoveFromWatchlist={onRemoveFromWatchlist}
            />
          ))}
      </CardContent>
    </Card>
  );
};

const ExpandedAssignmentDetail: React.FC<{
  principal: PrivilegedPrincipal;
  tenantId: string;
  signalLift?: number;
  /** Audit-log events targeting this principal (most-recent first). Empty
   *  when the operator has never performed an action involving this id. */
  auditEvents?: ReadonlyArray<AuditEntry>;
  isWatched?: boolean;
  onAddToWatchlist?: (p: PrivilegedPrincipal, note?: string) => void;
  onRemoveFromWatchlist?: (principalId: string) => void;
}> = React.memo(
  ({
    principal,
    tenantId,
    signalLift = 0,
    auditEvents = [],
    isWatched = false,
    onAddToWatchlist,
    onRemoveFromWatchlist,
  }) => {
    // Most-recent first, then cap at 8 — the timeline is meant to give
    // immediate context, not a full audit dump (that lives on the
    // audit-log page).
    const recentEvents = React.useMemo(
      () =>
        auditEvents
          .slice()
          .sort(
            (a, b) =>
              new Date(b.timestamp).getTime() -
              new Date(a.timestamp).getTime(),
          )
          .slice(0, 8),
      [auditEvents],
    );
    return (
      <div
        className="mt-2 rounded-md border border-dashed border-border bg-muted/30 p-3"
        role="region"
        aria-label={`Assignment detail for ${principal.displayName}`}
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-2xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wider text-muted-foreground">
              Every role this principal holds
            </span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 tabular-nums text-3xs",
                signalLift > 0
                  ? "bg-warning/15 text-warning"
                  : "bg-muted text-muted-foreground",
              )}
              title={
                signalLift > 0
                  ? `Risk ${riskScore(principal, signalLift).toLocaleString()} = base ${riskScore(principal).toLocaleString()} + corpus-signal lift ${signalLift.toLocaleString()}.`
                  : "Composite risk score (see Risk column tooltip)"
              }
            >
              risk {riskScore(principal, signalLift).toLocaleString()}
            </span>
            {isWatched && (
              <Badge
                variant="warning"
                title="On Tier-0 Watchlist — drift between probes will be flagged."
              >
                Watched
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onAddToWatchlist && onRemoveFromWatchlist && (
              <button
                type="button"
                onClick={() =>
                  isWatched
                    ? onRemoveFromWatchlist(principal.id)
                    : onAddToWatchlist(principal)
                }
                className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-3xs text-muted-foreground hover:border-warning/40 hover:text-warning"
              >
                <Sparkles
                  className={cn(
                    "h-2.5 w-2.5",
                    isWatched && "fill-warning/30 text-warning",
                  )}
                  aria-hidden
                />
                {isWatched ? "Unwatch" : "Watch"}
              </button>
            )}
            <a
              href={portalDeepLink(tenantId, principal)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-info hover:underline"
              aria-label={`Open ${principal.displayName} in the Entra portal`}
            >
              Open in Entra <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </div>
        </div>
        <ul className="flex flex-col gap-1.5">
          {principal.assignments.map((a) => (
            <li
              key={`${a.roleId}::${a.path}::${a.viaGroupId ?? ""}`}
              className="group/copy flex flex-wrap items-center gap-2 text-2xs"
            >
              <TierBadge tier={a.tier} compact />
              <span className="font-medium text-foreground">
                {a.roleDisplayName}
              </span>
              <PathBadge path={a.path} />
              {a.viaGroupName && (
                <span className="text-muted-foreground">
                  via{" "}
                  <span className="font-mono">{a.viaGroupName}</span>
                </span>
              )}
              {/* ENHANCEMENT — click-to-copy role-id + per-role portal link. */}
              <span className="ml-auto inline-flex items-center gap-1 font-mono text-3xs text-muted-foreground/70">
                {a.roleTemplateId.slice(0, 8)}…
                <CopyButton value={a.roleTemplateId} />
                <a
                  href={roleDeepLink(tenantId, a.roleId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Open role assignments in the Entra portal"
                  aria-label={`Open ${a.roleDisplayName} in the Entra portal`}
                >
                  <ExternalLink className="h-2.5 w-2.5" aria-hidden />
                </a>
              </span>
            </li>
          ))}
        </ul>
        {/*
          Per-principal audit timeline — surfaces operator actions targeting
          this principal (watchlist add/remove, filter toggles that mention
          this id, etc.). Pulls from the in-app auditLog singleton. Lives
          inside the expand panel so it never pushes layout for principals
          the operator isn't actively investigating.
        */}
        {recentEvents.length > 0 && (
          <div className="mt-3 border-t border-dashed border-border pt-2">
            <p className="m-0 mb-1 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recent actions on this principal
            </p>
            <ol className="flex flex-col gap-0.5">
              {recentEvents.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center gap-1.5 text-3xs text-muted-foreground"
                >
                  <span className="tabular-nums">
                    {formatRelativeTime(e.timestamp)}
                  </span>
                  <span aria-hidden>·</span>
                  <span className="font-mono">
                    {e.action.replace(PRIVILEGED_AUDIT_ACTION_PREFIX, "")}
                  </span>
                  <span aria-hidden>·</span>
                  <span>{e.actor}</span>
                  <Badge
                    variant={e.status === "success" ? "outline" : "destructive"}
                  >
                    {e.status}
                  </Badge>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    );
  },
);
ExpandedAssignmentDetail.displayName = "ExpandedAssignmentDetail";

// ===========================================================================
// Section C: shadow admin paths panel
// ===========================================================================

const SHADOW_EXPORT_COLUMNS: ReadonlyArray<ExportColumn<ShadowAdminPath>> = [
  { header: "Principal", accessor: (p) => p.principalDisplayName },
  { header: "Type", accessor: (p) => p.principalType },
  { header: "Sign-in name", accessor: (p) => p.principalSignInName ?? "" },
  { header: "Via", accessor: (p) => p.via },
  { header: "Role", accessor: (p) => p.roleDisplayName },
  { header: "Tier", accessor: (p) => TIER_META[p.tier].label },
];

const ShadowAdminPathsPanel: React.FC<{
  paths: ShadowAdminPath[];
  privilegedRoleAdmins: PrivilegedPrincipal[];
  loading: boolean;
}> = ({ paths, privilegedRoleAdmins, loading }) => {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-warning" /> Shadow admin paths
            <InfoTooltip content="Escalation routes that the Azure portal's 'Roles & administrators' blade hides — group-mediated memberships, service-principal assignments, and cross-tenant guest privileges." />
          </CardTitle>
          <CardDescription>
            {paths.length === 0
              ? "No shadow-admin paths detected."
              : `${paths.length} escalation path${paths.length === 1 ? "" : "s"} detected.`}
          </CardDescription>
        </div>
        <ExportMenu
          rows={paths}
          columns={SHADOW_EXPORT_COLUMNS}
          filename="privileged-audit-shadow-paths"
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {privilegedRoleAdmins.length > 0 && (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>
              {privilegedRoleAdmins.length} Privileged Role Administrator
              {privilegedRoleAdmins.length === 1 ? "" : "s"}
            </AlertTitle>
            <AlertDescription>
              <p className="m-0">
                Holders of this role can grant Global Administrator to any
                principal — including themselves. They are functionally
                equivalent to Global Admins even when not listed as such.
              </p>
              <ul className="mt-1 list-disc pl-5">
                {privilegedRoleAdmins.slice(0, 10).map((p) => (
                  <li key={p.id} className="text-xs">
                    {p.displayName}
                    {p.signInName && (
                      <span className="ml-1 font-mono text-2xs opacity-70">
                        ({p.signInName})
                      </span>
                    )}
                  </li>
                ))}
                {privilegedRoleAdmins.length > 10 && (
                  <li>+ {privilegedRoleAdmins.length - 10} more…</li>
                )}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {loading ? (
          <Skeleton className="h-12 w-full" />
        ) : paths.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No shadow admin paths"
            description="Every privileged assignment in this tenant is a direct user assignment, with no group mediation, service principals, or guest holders. This is the strictest possible configuration."
            size="compact"
          />
        ) : (
          <ol className="flex flex-col gap-1.5">
            {paths.slice(0, 50).map((p) => (
              <li
                key={p.id}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs",
                  p.tier === "tier0"
                    ? "border-destructive/40 bg-destructive/5"
                    : p.tier === "tier1"
                      ? "border-warning/40 bg-warning/5"
                      : "border-border bg-card",
                )}
              >
                <span className="font-medium text-foreground">
                  {p.principalDisplayName}
                </span>
                <span className="text-muted-foreground">→</span>
                <span className="text-muted-foreground">{p.via}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-medium text-foreground">
                  {p.roleDisplayName}
                </span>
                <TierBadge tier={p.tier} compact />
              </li>
            ))}
            {paths.length > 50 && (
              <li className="px-3 py-1 text-2xs text-muted-foreground">
                + {paths.length - 50} more path
                {paths.length - 50 === 1 ? "" : "s"} (export for full list)
              </li>
            )}
          </ol>
        )}
      </CardContent>
    </Card>
  );
};

// ===========================================================================
// Section D: groups holding privileged roles
// ===========================================================================

const GROUP_EXPORT_COLUMNS: ReadonlyArray<ExportColumn<PrivilegedGroup>> = [
  { header: "Group", accessor: (g) => g.displayName },
  { header: "Group id", accessor: (g) => g.id },
  { header: "Top tier", accessor: (g) => TIER_META[g.topTier].label },
  {
    header: "Roles",
    accessor: (g) => g.roles.map((r) => r.roleDisplayName).join("; "),
  },
  { header: "Transitive users", accessor: (g) => g.transitiveUserCount },
  { header: "Transitive members", accessor: (g) => g.transitiveTotalCount },
  {
    header: "High blast radius",
    accessor: (g) =>
      isHighBlastRadiusGroup(g, HIGH_BLAST_RADIUS_THRESHOLD) ? "yes" : "no",
  },
];

const GroupsHoldingRolesCard: React.FC<{
  groups: PrivilegedGroup[];
  loading: boolean;
}> = ({ groups, loading }) => {
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () => new Set(),
  );
  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-warning" /> Groups holding privileged roles
            <InfoTooltip content="Groups that directly hold one or more directory roles. Every transitive user member inherits the role — they appear as 'via group X' in section B." />
          </CardTitle>
          <CardDescription>
            {groups.length} group{groups.length === 1 ? "" : "s"} hold a
            directory role.
          </CardDescription>
        </div>
        <ExportMenu
          rows={groups}
          columns={GROUP_EXPORT_COLUMNS}
          filename="privileged-audit-groups"
        />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-12 w-full" />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No groups hold a directory role"
            description="All privileged assignments in this tenant are made directly to users or service principals — there is no group-mediated path to investigate."
            size="compact"
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {groups.map((g) => {
              const high = isHighBlastRadiusGroup(g, HIGH_BLAST_RADIUS_THRESHOLD);
              const isOpen = expanded.has(g.id);
              return (
                <li
                  key={g.id}
                  className={cn(
                    "rounded-md border bg-card",
                    high
                      ? "border-destructive/40 ring-1 ring-destructive/20"
                      : "border-border",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggle(g.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-2xs hover:bg-muted/30"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {g.displayName}
                    </span>
                    <TierBadge tier={g.topTier} compact />
                    <Badge variant="outline">
                      {g.transitiveUserCount} user
                      {g.transitiveUserCount === 1 ? "" : "s"}
                    </Badge>
                    {high && (
                      <Badge variant="destructive">
                        High blast radius
                      </Badge>
                    )}
                  </button>
                  {isOpen && (
                    <div className="border-t border-border bg-muted/20 px-3 py-2 text-2xs">
                      <p className="m-0 mb-1 text-muted-foreground">
                        Roles held:{" "}
                        {g.roles.map((r) => r.roleDisplayName).join(", ")}
                      </p>
                      <p className="m-0 text-muted-foreground">
                        Transitive members: {g.transitiveTotalCount} total
                        ({g.transitiveUserCount} user
                        {g.transitiveUserCount === 1 ? "" : "s"})
                      </p>
                      {g.transitiveMemberIds.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {g.transitiveMemberIds.slice(0, 20).map((id) => (
                            <span
                              key={id}
                              className="rounded bg-card px-1.5 py-0.5 font-mono text-3xs text-muted-foreground"
                            >
                              {id.slice(0, 8)}…
                            </span>
                          ))}
                          {g.transitiveMemberIds.length > 20 && (
                            <span className="text-3xs text-muted-foreground">
                              + {g.transitiveMemberIds.length - 20} more
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};

// ===========================================================================
// Section E: service principals with privileged roles
// ===========================================================================

const SP_EXPORT_COLUMNS: ReadonlyArray<ExportColumn<PrivilegedPrincipal>> = [
  { header: "Display name", accessor: (p) => p.displayName },
  { header: "Object id", accessor: (p) => p.id },
  { header: "App id / sign-in", accessor: (p) => p.signInName ?? "" },
  { header: "Top tier", accessor: (p) => TIER_META[p.topTier].label },
  {
    header: "Roles",
    accessor: (p) =>
      Array.from(new Set(p.assignments.map((a) => a.roleDisplayName))).join("; "),
  },
  { header: "Created", accessor: (p) => p.createdDateTime ?? "" },
];

const ServicePrincipalsCard: React.FC<{
  sps: PrivilegedPrincipal[];
  loading: boolean;
}> = ({ sps, loading }) => {
  const isFresh = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const ms = Date.now() - new Date(iso).getTime();
    return ms < RECENT_SP_WINDOW_MS;
  };
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4 text-info" /> Service principals with privileged roles
            <InfoTooltip content="Workload identities (apps, managed identities, third-party SPNs) that hold a directory role. SkyArk flags recently-created SPs with Tier 0 roles as suspicious 'fresh implants'." />
          </CardTitle>
          <CardDescription>
            {sps.length} service principal{sps.length === 1 ? "" : "s"} hold a
            directory role.
          </CardDescription>
        </div>
        <ExportMenu
          rows={sps}
          columns={SP_EXPORT_COLUMNS}
          filename="privileged-audit-sps"
        />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-12 w-full" />
        ) : sps.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No service principals hold directory roles"
            description="Every directory role in this tenant is assigned to a human identity. This is the recommended configuration for tenants without workload automation."
            size="compact"
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sps.map((p) => {
              const fresh = isFresh(p.createdDateTime);
              const suspicious = fresh && p.topTier === "tier0";
              return (
                <li
                  key={p.id}
                  className={cn(
                    "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs",
                    suspicious
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-border bg-card",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {p.displayName}
                  </span>
                  <TierBadge tier={p.topTier} compact />
                  {p.signInName && (
                    <span className="font-mono text-3xs text-muted-foreground">
                      {p.signInName}
                    </span>
                  )}
                  {p.createdDateTime && (
                    <span
                      className={cn(
                        "text-3xs",
                        fresh ? "text-warning" : "text-muted-foreground",
                      )}
                    >
                      Created {formatRelativeTime(p.createdDateTime)}
                    </span>
                  )}
                  {suspicious && (
                    <Badge variant="destructive">
                      Recent + Tier 0 — investigate
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};

// ===========================================================================
// Corpus Detection Signals (A/B/C/D) — defensive read-only enumeration.
//
// EVERY finding category below is sourced from the corpus playbooks at
//   C:\Users\baimgprodsesa1\Desktop\New folder\_*.md
// and represents a drift-from-baseline indicator on the operator's OWN
// tenant. None of the cards or rows here invoke offensive primitives —
// the wiring is purely "GET → render → grade severity → sort up the matrix".
// ===========================================================================

const SeverityBadge: React.FC<{ severity: FindingSeverity }> = ({
  severity,
}) => {
  const meta = SEVERITY_META[severity];
  return (
    <Badge variant={meta.badgeVariant} title={meta.description}>
      {meta.label}
    </Badge>
  );
};

const SIGNAL_A_EXPORT_COLUMNS: ReadonlyArray<
  ExportColumn<HighPrivGraphPermissionFinding>
> = [
  { header: "SP display name", accessor: (f) => f.servicePrincipalDisplayName },
  { header: "SP object id", accessor: (f) => f.servicePrincipalId },
  { header: "App id", accessor: (f) => f.appId ?? "" },
  { header: "Sign-in audience", accessor: (f) => f.signInAudience ?? "" },
  {
    header: "Permissions",
    accessor: (f) => f.permissions.map((p) => p.permissionName).join("; "),
  },
  { header: "Password credentials", accessor: (f) => f.passwordCredentialCount },
  { header: "Key credentials", accessor: (f) => f.keyCredentialCount },
  {
    header: "Recent credential",
    accessor: (f) => (f.hasRecentCredential ? "yes" : "no"),
  },
  {
    header: "Most recent credential at",
    accessor: (f) => f.mostRecentCredentialAt ?? "",
  },
  {
    header: "Severity",
    accessor: (f) => SEVERITY_META[gradeHighPrivGraphPermission(f)].label,
  },
];

const SIGNAL_B_EXPORT_COLUMNS: ReadonlyArray<
  ExportColumn<FederatedCredentialFinding>
> = [
  { header: "SP display name", accessor: (f) => f.servicePrincipalDisplayName },
  { header: "SP object id", accessor: (f) => f.servicePrincipalId },
  { header: "Federated credential name", accessor: (f) => f.name },
  { header: "Issuer", accessor: (f) => f.issuer },
  { header: "Subject", accessor: (f) => f.subject },
  { header: "Audiences", accessor: (f) => f.audiences.join("; ") },
  {
    header: "Public issuer",
    accessor: (f) => (f.isPublicIssuer ? "yes" : "no"),
  },
];

const SIGNAL_C_EXPORT_COLUMNS: ReadonlyArray<
  ExportColumn<PimEligibilityFinding>
> = [
  { header: "Principal", accessor: (f) => f.principalDisplayName ?? f.principalId },
  { header: "Principal id", accessor: (f) => f.principalId },
  { header: "Principal type", accessor: (f) => f.principalType },
  { header: "Sign-in name", accessor: (f) => f.principalSignInName ?? "" },
  { header: "Role", accessor: (f) => f.roleDisplayName ?? f.roleTemplateId },
  { header: "Role template id", accessor: (f) => f.roleTemplateId },
  { header: "Tier", accessor: (f) => TIER_META[f.tier].label },
  { header: "Expiration kind", accessor: (f) => f.expirationKind },
  { header: "End date", accessor: (f) => f.endDateTime ?? "" },
  { header: "Duration", accessor: (f) => f.duration ?? "" },
  { header: "Created", accessor: (f) => f.createdDateTime ?? "" },
  {
    header: "Critical time bomb",
    accessor: (f) => (f.isCriticalTimeBomb ? "yes" : "no"),
  },
  {
    header: "Severity",
    accessor: (f) => SEVERITY_META[gradePimEligibility(f)].label,
  },
];

const SIGNAL_D_EXPORT_COLUMNS: ReadonlyArray<
  ExportColumn<TapIssuanceFinding>
> = [
  { header: "User", accessor: (f) => f.userDisplayName },
  { header: "User id", accessor: (f) => f.userId },
  { header: "UPN", accessor: (f) => f.userPrincipalName ?? "" },
  { header: "User tier", accessor: (f) => TIER_META[f.userTier].label },
  { header: "TAP id", accessor: (f) => f.tapId },
  { header: "Issued at", accessor: (f) => f.startDateTime ?? "" },
  {
    header: "Lifetime minutes",
    accessor: (f) => f.lifetimeInMinutes ?? "",
  },
  { header: "Usable", accessor: (f) => (f.isUsable ? "yes" : "no") },
  {
    header: "Usability reason",
    accessor: (f) => f.methodUsabilityReason ?? "",
  },
  {
    header: "Recent to Tier 0/1",
    accessor: (f) => (f.isRecentToTierZero ? "yes" : "no"),
  },
  {
    header: "Severity",
    accessor: (f) => SEVERITY_META[gradeTapIssuance(f)].label,
  },
];

const CorpusDetectionSignalsCard: React.FC<{
  dataset: PrivilegedAuditDataset;
  loading: boolean;
}> = ({ dataset, loading }) => {
  const {
    highPrivGraphPermissions,
    federatedCredentials,
    pimEligibilities,
    tapIssuances,
    syncAccountFindings,
    pimGroupEligibilities,
    mixedChainFindings,
  } = dataset;
  const total =
    highPrivGraphPermissions.length +
    federatedCredentials.length +
    pimEligibilities.length +
    tapIssuances.length +
    syncAccountFindings.filter((f) => f.hasDriftRole).length +
    pimGroupEligibilities.length +
    mixedChainFindings.length;
  // Per-signal severity tallies for the top stat row.
  const criticalCount = React.useMemo(() => {
    let n = 0;
    for (const f of highPrivGraphPermissions)
      if (gradeHighPrivGraphPermission(f) === "critical") n++;
    const recentCredSet = new Set(
      highPrivGraphPermissions
        .filter((f) => f.hasRecentCredential)
        .map((f) => f.servicePrincipalId),
    );
    for (const f of federatedCredentials)
      if (
        gradeFederatedCredential(
          f,
          recentCredSet.has(f.servicePrincipalId),
        ) === "critical"
      )
        n++;
    for (const f of pimEligibilities)
      if (gradePimEligibility(f) === "critical") n++;
    for (const f of tapIssuances)
      if (gradeTapIssuance(f) === "critical") n++;
    for (const f of syncAccountFindings)
      if (gradeSyncAccount(f) === "critical") n++;
    for (const f of pimGroupEligibilities)
      if (gradePimGroupEligibility(f) === "critical") n++;
    for (const f of mixedChainFindings)
      if (f.severity === "critical") n++;
    return n;
  }, [
    highPrivGraphPermissions,
    federatedCredentials,
    pimEligibilities,
    tapIssuances,
    syncAccountFindings,
    pimGroupEligibilities,
    mixedChainFindings,
  ]);
  return (
    <Card aria-labelledby="corpus-signals-title">
      <CardHeader className="space-y-1">
        <CardTitle
          id="corpus-signals-title"
          className="flex items-center gap-2 text-sm"
        >
          <ShieldAlert className="h-4 w-4 text-destructive" />
          Corpus detection signals
          <InfoTooltip content="Seven drift-from-baseline indicators sourced from the cross-tool offensive playbooks. Read-only enumeration only — every row is a GET against the operator's own tenant. Severity grading mirrors the corpus' own risk framing." />
        </CardTitle>
        <CardDescription>
          {total} indicator{total === 1 ? "" : "s"} surfaced
          {criticalCount > 0 && (
            <>
              {", "}
              <span className="font-semibold text-destructive">
                {criticalCount} critical
              </span>
            </>
          )}
          . See{" "}
          <code className="text-3xs">_AZURE_BYPASS_PLAYBOOK.md</code>{" "}
          §"Critical Defender Audit Surface".
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Signal F goes FIRST because it is the highest-value composite —
            two indicators on one principal in a tight window beats any
            single-signal finding. */}
        <SignalFPanel
          findings={dataset.mixedChainFindings}
          loading={loading}
        />
        <SignalAPanel
          findings={highPrivGraphPermissions}
          loading={loading}
        />
        <SignalBPanel
          findings={federatedCredentials}
          companionRecentCredSpIds={
            new Set(
              highPrivGraphPermissions
                .filter((f) => f.hasRecentCredential)
                .map((f) => f.servicePrincipalId),
            )
          }
          loading={loading}
        />
        <SignalCPanel
          findings={pimEligibilities}
          loading={loading}
        />
        <SignalGPanel
          findings={dataset.pimGroupEligibilities}
          loading={loading}
        />
        <SignalDPanel
          findings={tapIssuances}
          loading={loading}
        />
        <SignalEPanel
          findings={dataset.syncAccountFindings}
          loading={loading}
        />
      </CardContent>
    </Card>
  );
};

// ---- Signal A panel ------------------------------------------------------

const SignalAPanel: React.FC<{
  findings: HighPrivGraphPermissionFinding[];
  loading: boolean;
}> = ({ findings, loading }) => (
  <section
    className="rounded-md border border-border bg-card/40 p-3"
    aria-labelledby="signal-a-title"
  >
    <header className="mb-2 flex flex-wrap items-center gap-2">
      <Sparkles className="h-3.5 w-3.5 text-warning" aria-hidden />
      <h3 id="signal-a-title" className="text-2xs font-semibold uppercase tracking-wider">
        Signal A — High-privilege Graph permissions on a service principal
      </h3>
      <InfoTooltip content="Citation: _bypass_role_grant.md §3.1 (canonical chain — Application.ReadWrite.All → addKey on Microsoft Graph SP → app-only Global Admin). Any SP holding Application.ReadWrite.All, RoleManagement.ReadWrite.Directory, AppRoleAssignment.ReadWrite.All, Directory.ReadWrite.All, or Domain.ReadWrite.All is a one-step path to GA." />
      <span className="ml-auto">
        <ExportMenu
          rows={findings}
          columns={SIGNAL_A_EXPORT_COLUMNS}
          filename="privileged-audit-signal-a-graph-perms"
        />
      </span>
    </header>
    {loading ? (
      <Skeleton className="h-12 w-full" />
    ) : findings.length === 0 ? (
      <p className="m-0 text-2xs text-muted-foreground">
        No service principals hold the Top-30 Graph escalation permissions.
        This is the safe baseline.
      </p>
    ) : (
      <ul className="flex flex-col gap-1.5">
        {findings.slice(0, 25).map((f) => {
          const sev = gradeHighPrivGraphPermission(f);
          return (
            <li
              key={f.id}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs",
                sev === "critical"
                  ? "border-destructive/50 bg-destructive/5"
                  : sev === "high"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-card",
              )}
            >
              <SeverityBadge severity={sev} />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {f.servicePrincipalDisplayName}
              </span>
              <div className="flex flex-wrap gap-1">
                {f.permissions.map((p) => (
                  <Badge key={p.appRoleId} variant="warning" title={p.permissionName}>
                    {p.permissionName}
                  </Badge>
                ))}
              </div>
              <Badge variant="outline" title="passwordCredentials + keyCredentials">
                {f.passwordCredentialCount + f.keyCredentialCount} cred
                {f.passwordCredentialCount + f.keyCredentialCount === 1 ? "" : "s"}
              </Badge>
              {f.hasRecentCredential && f.mostRecentCredentialAt && (
                <Badge
                  variant="destructive"
                  title={`Most recent credential at ${f.mostRecentCredentialAt}. Audit item #5 — addKey / addPassword detection.`}
                >
                  New cred {formatRelativeTime(f.mostRecentCredentialAt)}
                </Badge>
              )}
              {f.appId && (
                <span className="font-mono text-3xs text-muted-foreground">
                  {f.appId}
                </span>
              )}
            </li>
          );
        })}
        {findings.length > 25 && (
          <li className="px-3 py-1 text-2xs text-muted-foreground">
            + {findings.length - 25} more (export for full list)
          </li>
        )}
      </ul>
    )}
  </section>
);

// ---- Signal B panel ------------------------------------------------------

const SignalBPanel: React.FC<{
  findings: FederatedCredentialFinding[];
  companionRecentCredSpIds: Set<string>;
  loading: boolean;
}> = ({ findings, companionRecentCredSpIds, loading }) => (
  <section
    className="rounded-md border border-border bg-card/40 p-3"
    aria-labelledby="signal-b-title"
  >
    <header className="mb-2 flex flex-wrap items-center gap-2">
      <GitBranch className="h-3.5 w-3.5 text-warning" aria-hidden />
      <h3 id="signal-b-title" className="text-2xs font-semibold uppercase tracking-wider">
        Signal B — Federated identity credentials on privileged service principals
      </h3>
      <InfoTooltip content="Citation: _bypass_role_grant.md §6 (Workload Identity Federation as role-grant bypass) + _AZURE_BYPASS_PLAYBOOK.md Top-30 #17. Any federated credential whose issuer is a public OIDC issuer (GitHub Actions, GitLab, CircleCI) on a high-privilege SP is a backdoor — anyone who controls that pipeline mints SP tokens." />
      <span className="ml-auto">
        <ExportMenu
          rows={findings}
          columns={SIGNAL_B_EXPORT_COLUMNS}
          filename="privileged-audit-signal-b-fed-creds"
        />
      </span>
    </header>
    {loading ? (
      <Skeleton className="h-12 w-full" />
    ) : findings.length === 0 ? (
      <p className="m-0 text-2xs text-muted-foreground">
        No federated credentials on the high-privilege SPs from Signal A. If
        your privileged SPs use WIF, ensure the signed-in account has{" "}
        <code className="text-3xs">Application.Read.All</code> to enumerate{" "}
        <code className="text-3xs">/applications/&#123;id&#125;/federatedIdentityCredentials</code>.
      </p>
    ) : (
      <ul className="flex flex-col gap-1.5">
        {findings.slice(0, 25).map((f) => {
          const sev = gradeFederatedCredential(
            f,
            companionRecentCredSpIds.has(f.servicePrincipalId),
          );
          return (
            <li
              key={f.id}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs",
                sev === "critical"
                  ? "border-destructive/50 bg-destructive/5"
                  : sev === "high"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-card",
              )}
            >
              <SeverityBadge severity={sev} />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {f.servicePrincipalDisplayName}
              </span>
              <span className="font-mono text-3xs text-muted-foreground">
                {f.name}
              </span>
              {f.isPublicIssuer && (
                <Badge
                  variant="destructive"
                  title="Issuer is a public OIDC provider — anyone controlling that pipeline can mint tokens for this SP."
                >
                  Public issuer
                </Badge>
              )}
              <span className="font-mono text-3xs text-muted-foreground" title={`issuer: ${f.issuer}`}>
                {f.issuer}
              </span>
              <span className="font-mono text-3xs text-muted-foreground" title={`subject: ${f.subject}`}>
                {f.subject.length > 64 ? f.subject.slice(0, 61) + "…" : f.subject}
              </span>
            </li>
          );
        })}
        {findings.length > 25 && (
          <li className="px-3 py-1 text-2xs text-muted-foreground">
            + {findings.length - 25} more (export for full list)
          </li>
        )}
      </ul>
    )}
  </section>
);

// ---- Signal C panel ------------------------------------------------------

const SignalCPanel: React.FC<{
  findings: PimEligibilityFinding[];
  loading: boolean;
}> = ({ findings, loading }) => (
  <section
    className="rounded-md border border-border bg-card/40 p-3"
    aria-labelledby="signal-c-title"
  >
    <header className="mb-2 flex flex-wrap items-center gap-2">
      <Bomb className="h-3.5 w-3.5 text-destructive" aria-hidden />
      <h3 id="signal-c-title" className="text-2xs font-semibold uppercase tracking-wider">
        Signal C — PIM eligibility with no expiration
      </h3>
      <InfoTooltip content="Citation: _bypass_staged_pim.md §5.1 'The time bomb' + Top-30 #27. Attacker briefly compromises Privileged Role Administrator, plants eligibility for attacker user with scheduleInfo.expiration.type = noExpiration, then PRA compromise is remediated — eligibility persists. Activation comes weeks later when nobody is watching." />
      <span className="ml-auto">
        <ExportMenu
          rows={findings}
          columns={SIGNAL_C_EXPORT_COLUMNS}
          filename="privileged-audit-signal-c-pim-eligibility"
        />
      </span>
    </header>
    {loading ? (
      <Skeleton className="h-12 w-full" />
    ) : findings.length === 0 ? (
      <p className="m-0 text-2xs text-muted-foreground">
        No PIM eligibility schedules detected. If your tenant uses PIM,
        ensure{" "}
        <code className="text-3xs">RoleManagement.Read.Directory</code> is
        granted so this signal can fire.
      </p>
    ) : (
      <ul className="flex flex-col gap-1.5">
        {findings.slice(0, 25).map((f) => {
          const sev = gradePimEligibility(f);
          return (
            <li
              key={f.id}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs",
                f.isCriticalTimeBomb
                  ? "border-destructive/50 bg-destructive/5"
                  : sev === "high"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-card",
              )}
            >
              <SeverityBadge severity={sev} />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {f.principalDisplayName ?? f.principalId}
              </span>
              {f.principalSignInName && (
                <span className="font-mono text-3xs text-muted-foreground">
                  {f.principalSignInName}
                </span>
              )}
              <Badge variant="outline">
                {f.principalType}
              </Badge>
              <TierBadge tier={f.tier} compact />
              <span className="text-2xs text-muted-foreground">
                eligible for
              </span>
              <Badge variant="secondary" title={f.roleTemplateId}>
                {f.roleDisplayName ?? f.roleTemplateId.slice(0, 8) + "…"}
              </Badge>
              <Badge
                variant={
                  f.expirationKind === "noExpiration" ? "destructive" : "outline"
                }
                title={
                  f.expirationKind === "noExpiration"
                    ? "noExpiration matches the corpus 'time bomb' pattern."
                    : f.expirationKind === "afterDateTime"
                      ? `Until ${f.endDateTime ?? "?"}`
                      : f.expirationKind === "afterDuration"
                        ? `Duration ${f.duration ?? "?"}`
                        : "Unknown expiration shape"
                }
              >
                {f.expirationKind === "noExpiration"
                  ? "noExpiration"
                  : f.expirationKind === "afterDateTime"
                    ? `until ${f.endDateTime?.slice(0, 10) ?? "?"}`
                    : f.expirationKind === "afterDuration"
                      ? f.duration ?? "duration"
                      : "?"}
              </Badge>
              {f.createdDateTime && (
                <span
                  className="font-mono text-3xs text-muted-foreground"
                  title={`Eligibility created ${f.createdDateTime}`}
                >
                  +{formatRelativeTime(f.createdDateTime)}
                </span>
              )}
            </li>
          );
        })}
        {findings.length > 25 && (
          <li className="px-3 py-1 text-2xs text-muted-foreground">
            + {findings.length - 25} more (export for full list)
          </li>
        )}
      </ul>
    )}
  </section>
);

// ---- Signal D panel ------------------------------------------------------

const SignalDPanel: React.FC<{
  findings: TapIssuanceFinding[];
  loading: boolean;
}> = ({ findings, loading }) => (
  <section
    className="rounded-md border border-border bg-card/40 p-3"
    aria-labelledby="signal-d-title"
  >
    <header className="mb-2 flex flex-wrap items-center gap-2">
      <Ticket className="h-3.5 w-3.5 text-warning" aria-hidden />
      <h3 id="signal-d-title" className="text-2xs font-semibold uppercase tracking-wider">
        Signal D — Temporary Access Pass on a privileged user
      </h3>
      <InfoTooltip content="Citation: _AZURE_BYPASS_PLAYBOOK.md 'Critical Defender Audit Surface' #3 + Top-30 #13. Authentication Administrator can issue a TAP which is MFA-equivalent for the holder. A TAP on a Tier-0 user issued within the last 30 days is a critical persistence indicator." />
      <span className="ml-auto">
        <ExportMenu
          rows={findings}
          columns={SIGNAL_D_EXPORT_COLUMNS}
          filename="privileged-audit-signal-d-tap"
        />
      </span>
    </header>
    {loading ? (
      <Skeleton className="h-12 w-full" />
    ) : findings.length === 0 ? (
      <p className="m-0 text-2xs text-muted-foreground">
        No active Temporary Access Pass found on any privileged user. If
        TAPs are in use in this tenant, ensure the signed-in account has{" "}
        <code className="text-3xs">UserAuthenticationMethod.Read.All</code>{" "}
        to enumerate them.
      </p>
    ) : (
      <ul className="flex flex-col gap-1.5">
        {findings.slice(0, 25).map((f) => {
          const sev = gradeTapIssuance(f);
          return (
            <li
              key={f.id}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs",
                sev === "critical"
                  ? "border-destructive/50 bg-destructive/5"
                  : sev === "high"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-card",
              )}
            >
              <SeverityBadge severity={sev} />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {f.userDisplayName}
              </span>
              {f.userPrincipalName && (
                <span className="font-mono text-3xs text-muted-foreground">
                  {f.userPrincipalName}
                </span>
              )}
              <TierBadge tier={f.userTier} compact />
              {f.startDateTime && (
                <span
                  className="font-mono text-3xs text-muted-foreground"
                  title={`Issued at ${f.startDateTime}`}
                >
                  issued {formatRelativeTime(f.startDateTime)}
                </span>
              )}
              {typeof f.lifetimeInMinutes === "number" && (
                <Badge variant="outline">
                  {f.lifetimeInMinutes} min lifetime
                </Badge>
              )}
              {f.isUsable && (
                <Badge variant="warning" title="The TAP can be redeemed right now.">
                  Usable now
                </Badge>
              )}
              {f.isRecentToTierZero && (
                <Badge variant="destructive" title="TAP within RECENT_TAP_WINDOW_MS on a Tier-0/Tier-1 principal — investigate.">
                  Tier-0 + recent
                </Badge>
              )}
              {f.methodUsabilityReason && (
                <span className="text-3xs text-muted-foreground">
                  {f.methodUsabilityReason}
                </span>
              )}
            </li>
          );
        })}
        {findings.length > 25 && (
          <li className="px-3 py-1 text-2xs text-muted-foreground">
            + {findings.length - 25} more (export for full list)
          </li>
        )}
      </ul>
    )}
  </section>
);

// ===========================================================================
// Tier-0 Watchlist card
//
// Persisted, manually-curated set of object ids the operator wants to
// monitor for drift between probes. Surface drift in the same card so the
// alert is impossible to miss — adding an entry without ever seeing drift
// is just a noisier inventory.
// ===========================================================================

const WATCHLIST_DRIFT_TONE: Record<
  WatchlistDrift["kind"],
  "destructive" | "warning" | "info" | "secondary" | "outline"
> = {
  missing: "destructive",
  "tier-up": "destructive",
  "role-removed": "warning",
  "new-role": "warning",
  "tier-down": "info",
  unchanged: "outline",
};

const Tier0WatchlistCard: React.FC<{
  watchlist: WatchlistState;
  drift: WatchlistDrift[];
  onRemove: (principalId: string) => void;
}> = ({ watchlist, drift, onRemove }) => {
  // Hide the card entirely when the watchlist is empty — the affordance to
  // ADD lives next to each row in section B so the empty card would just be
  // visual noise on first load.
  if (watchlist.entries.length === 0) return null;
  const alertCount = drift.filter((d) => d.kind !== "unchanged").length;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-warning" aria-hidden />
            Tier-0 Watchlist
            <InfoTooltip content="Operator-curated principals monitored for drift between probes. Use the bookmark icon next to any row in 'Privileged identities' to add/remove. Drift kinds: principal disappeared, tier escalated, new role gained, role removed." />
          </CardTitle>
          <CardDescription>
            {watchlist.entries.length} watched principal
            {watchlist.entries.length === 1 ? "" : "s"}
            {alertCount > 0 && (
              <>
                {", "}
                <span className="font-semibold text-destructive">
                  {alertCount} drift alert{alertCount === 1 ? "" : "s"}
                </span>
              </>
            )}
            .
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1.5">
          {drift.map((d) => (
            <li
              key={d.entry.principalId}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs",
                d.kind === "missing" || d.kind === "tier-up"
                  ? "border-destructive/40 bg-destructive/5"
                  : d.kind === "new-role" || d.kind === "role-removed"
                    ? "border-warning/40 bg-warning/5"
                    : d.kind === "tier-down"
                      ? "border-info/40 bg-info/5"
                      : "border-border bg-card",
              )}
            >
              <Badge variant={WATCHLIST_DRIFT_TONE[d.kind]}>
                {d.kind === "unchanged" ? "ok" : d.kind}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {d.entry.capturedDisplayName}
              </span>
              {d.entry.capturedSignInName && (
                <span className="font-mono text-3xs text-muted-foreground">
                  {d.entry.capturedSignInName}
                </span>
              )}
              <TierBadge tier={d.current?.topTier ?? d.entry.capturedTier} compact />
              <span className="text-muted-foreground">{d.explanation}</span>
              {d.entry.note && (
                <span
                  className="text-3xs italic text-muted-foreground"
                  title={`Note: ${d.entry.note}`}
                >
                  "{d.entry.note}"
                </span>
              )}
              <span className="font-mono text-3xs text-muted-foreground">
                added {formatRelativeTime(d.entry.addedAt)}
              </span>
              <button
                type="button"
                onClick={() => onRemove(d.entry.principalId)}
                className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                title="Remove from watchlist"
                aria-label={`Remove ${d.entry.capturedDisplayName} from watchlist`}
              >
                <EyeOff className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
};

// ===========================================================================
// Signal E panel — AAD Connect / Cloud Sync sync-account drift
// ===========================================================================

const SIGNAL_E_EXPORT_COLUMNS: ReadonlyArray<ExportColumn<SyncAccountFinding>> = [
  { header: "Principal", accessor: (f) => f.principalDisplayName },
  { header: "Principal id", accessor: (f) => f.principalId },
  { header: "Type", accessor: (f) => f.principalType },
  { header: "Sign-in name", accessor: (f) => f.principalSignInName ?? "" },
  {
    header: "Roles held",
    accessor: (f) =>
      f.roles.map((r) => `${r.roleDisplayName}${r.isCanonical ? "(canonical)" : ""}`).join("; "),
  },
  { header: "Drift?", accessor: (f) => (f.hasDriftRole ? "yes" : "no") },
  { header: "Top drift tier", accessor: (f) => TIER_META[f.topDriftTier].label },
  { header: "Severity", accessor: (f) => SEVERITY_META[gradeSyncAccount(f)].label },
];

const SignalEPanel: React.FC<{
  findings: SyncAccountFinding[];
  loading: boolean;
}> = ({ findings, loading }) => {
  const driftFindings = findings.filter((f) => f.hasDriftRole);
  return (
    <section
      className="rounded-md border border-border bg-card/40 p-3"
      aria-labelledby="signal-e-title"
    >
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-3.5 w-3.5 text-destructive" aria-hidden />
        <h3
          id="signal-e-title"
          className="text-2xs font-semibold uppercase tracking-wider"
        >
          Signal E — AAD Connect / Cloud Sync sync-account drift
        </h3>
        <InfoTooltip content="Citation: _AZURE_BYPASS_PLAYBOOK.md Top-30 #19 + _bypass_mixed_chains.md chain #1 + _analysis_dirkjanm.md (adconnectdump). Any principal whose display name matches Sync_*, MSOL_*, ADToAADSyncServiceAccount, or 'On-Premises Directory Synchronization Service Account' is a sync identity. They are expected to hold ONLY the canonical 'Directory Synchronization Accounts' role (template d29b2b05-…). Any other privileged role is drift — and a compromised sync account is bidirectional forest control per the corpus." />
        <span className="ml-auto">
          <ExportMenu
            rows={findings}
            columns={SIGNAL_E_EXPORT_COLUMNS}
            filename="privileged-audit-signal-e-sync-accounts"
          />
        </span>
      </header>
      {loading ? (
        <Skeleton className="h-12 w-full" />
      ) : findings.length === 0 ? (
        <p className="m-0 text-2xs text-muted-foreground">
          No AAD Connect / Cloud Sync identities detected in this tenant's
          privileged-role holders. (If you DO use AAD Connect, ensure the sync
          account's privileged-role membership is enumerable via{" "}
          <code className="text-3xs">Directory.Read.All</code>.)
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {findings.map((f) => {
            const sev = gradeSyncAccount(f);
            return (
              <li
                key={f.id}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs",
                  sev === "critical"
                    ? "border-destructive/50 bg-destructive/5"
                    : sev === "high"
                      ? "border-warning/40 bg-warning/5"
                      : sev === "medium"
                        ? "border-info/40 bg-info/5"
                        : "border-border bg-card",
                )}
              >
                <SeverityBadge severity={sev} />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {f.principalDisplayName}
                </span>
                {f.principalSignInName && (
                  <span className="font-mono text-3xs text-muted-foreground">
                    {f.principalSignInName}
                  </span>
                )}
                <Badge variant="outline">{f.principalType}</Badge>
                <div className="flex flex-wrap gap-1">
                  {f.roles.map((r) => (
                    <Badge
                      key={r.roleTemplateId}
                      variant={r.isCanonical ? "secondary" : "warning"}
                      title={
                        r.isCanonical
                          ? `Canonical sync role — expected on a sync account.`
                          : `Drift role ${TIER_META[r.tier].label} — investigate; sync accounts should hold ONLY the canonical Directory Synchronization Accounts role.`
                      }
                    >
                      {r.roleDisplayName}
                    </Badge>
                  ))}
                </div>
                {f.hasDriftRole && (
                  <Badge variant="destructive" title="Drift detected">
                    Drift → {TIER_META[f.topDriftTier].label}
                  </Badge>
                )}
              </li>
            );
          })}
          {driftFindings.length === 0 && findings.length > 0 && (
            <li className="px-3 py-1 text-2xs text-muted-foreground">
              All sync-shaped principals hold only the canonical sync role —
              no drift detected. This is the safe baseline.
            </li>
          )}
        </ul>
      )}
    </section>
  );
};

// ===========================================================================
// Signal F panel — Mixed-chain temporal correlation
// ===========================================================================

const SIGNAL_F_EXPORT_COLUMNS: ReadonlyArray<ExportColumn<MixedChainFinding>> = [
  { header: "Principal", accessor: (f) => f.principalDisplayName },
  { header: "Principal id", accessor: (f) => f.principalId },
  { header: "Type", accessor: (f) => f.principalType },
  { header: "Tier", accessor: (f) => TIER_META[f.principalTier].label },
  { header: "Signals", accessor: (f) => f.indicators.map((i) => i.signal).join(",") },
  {
    header: "Span (hours)",
    accessor: (f) => (f.spanMs / (60 * 60 * 1000)).toFixed(2),
  },
  { header: "Severity", accessor: (f) => SEVERITY_META[f.severity].label },
  {
    header: "Indicators",
    accessor: (f) =>
      f.indicators.map((i) => `${i.signal}@${i.at}:${i.label}`).join(" | "),
  },
];

const SignalFPanel: React.FC<{
  findings: MixedChainFinding[];
  loading: boolean;
}> = ({ findings, loading }) => (
  <section
    className="rounded-md border border-border bg-card/40 p-3"
    aria-labelledby="signal-f-title"
  >
    <header className="mb-2 flex flex-wrap items-center gap-2">
      <Bomb className="h-3.5 w-3.5 text-destructive" aria-hidden />
      <h3
        id="signal-f-title"
        className="text-2xs font-semibold uppercase tracking-wider"
      >
        Signal F — Mixed-chain temporal correlation
      </h3>
      <InfoTooltip content="Citation: _bypass_mixed_chains.md (chain composition is the actual attacker workflow). Fires when ≥ 2 indicators across A/B/C/D/G land on the same principal inside MIXED_CHAIN_WINDOW_MS (24h). One indicator alone is suspicious; two within hours is the kill-chain signature. Critical when ≥ 3 distinct signals or any contributor is critical-graded." />
      <span className="ml-auto">
        <ExportMenu
          rows={findings}
          columns={SIGNAL_F_EXPORT_COLUMNS}
          filename="privileged-audit-signal-f-mixed-chains"
        />
      </span>
    </header>
    {loading ? (
      <Skeleton className="h-12 w-full" />
    ) : findings.length === 0 ? (
      <p className="m-0 text-2xs text-muted-foreground">
        No mixed-chain coincidences detected. Single-signal indicators may
        still exist below; this card fires only when ≥ 2 of them land on
        the same principal within {MIXED_CHAIN_WINDOW_MS / (60 * 60 * 1000)}h.
      </p>
    ) : (
      <ul className="flex flex-col gap-1.5">
        {findings.slice(0, 25).map((f) => (
          <li
            key={f.id}
            className={cn(
              "flex flex-col gap-1 rounded-md border px-3 py-2 text-2xs",
              f.severity === "critical"
                ? "border-destructive/50 bg-destructive/5"
                : f.severity === "high"
                  ? "border-warning/40 bg-warning/5"
                  : "border-border bg-card",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={f.severity} />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {f.principalDisplayName}
              </span>
              {f.principalSignInName && (
                <span className="font-mono text-3xs text-muted-foreground">
                  {f.principalSignInName}
                </span>
              )}
              <TierBadge tier={f.principalTier} compact />
              <Badge
                variant="warning"
                title={`Signals ${f.indicators
                  .map((i) => i.signal)
                  .join(" + ")} fired within ${(f.spanMs / (60 * 60 * 1000)).toFixed(1)}h`}
              >
                {f.indicators.map((i) => i.signal).join(" + ")} ·{" "}
                {(f.spanMs / (60 * 60 * 1000)).toFixed(1)}h
              </Badge>
            </div>
            <ol className="flex flex-wrap gap-x-3 gap-y-0.5 text-3xs text-muted-foreground">
              {f.indicators.map((ind, idx) => (
                <li key={`${f.id}:ind:${idx}`} className="flex items-center gap-1">
                  <span className="font-mono">[{ind.signal}]</span>
                  <span>{ind.label}</span>
                  <span aria-hidden>·</span>
                  <span>{formatRelativeTime(ind.at)}</span>
                </li>
              ))}
            </ol>
          </li>
        ))}
        {findings.length > 25 && (
          <li className="px-3 py-1 text-2xs text-muted-foreground">
            + {findings.length - 25} more chains (export for full list)
          </li>
        )}
      </ul>
    )}
  </section>
);

// ===========================================================================
// Signal G panel — PIM-for-Groups eligibility on role-assignable groups
// ===========================================================================

const SIGNAL_G_EXPORT_COLUMNS: ReadonlyArray<
  ExportColumn<PimGroupEligibilityFinding>
> = [
  {
    header: "Principal",
    accessor: (f) => f.principalDisplayName ?? f.principalId,
  },
  { header: "Principal id", accessor: (f) => f.principalId },
  { header: "Principal type", accessor: (f) => f.principalType },
  { header: "Group", accessor: (f) => f.groupDisplayName },
  { header: "Group id", accessor: (f) => f.groupId },
  {
    header: "isAssignableToRole",
    accessor: (f) => (f.isAssignableToRole ? "yes" : "no"),
  },
  {
    header: "Group roles",
    accessor: (f) => f.groupRoles.map((r) => r.roleDisplayName).join("; "),
  },
  { header: "Top tier", accessor: (f) => TIER_META[f.topTier].label },
  { header: "Expiration kind", accessor: (f) => f.expirationKind },
  { header: "End date", accessor: (f) => f.endDateTime ?? "" },
  { header: "Duration", accessor: (f) => f.duration ?? "" },
  { header: "Created", accessor: (f) => f.createdDateTime ?? "" },
  {
    header: "Critical time bomb",
    accessor: (f) => (f.isCriticalTimeBomb ? "yes" : "no"),
  },
  {
    header: "Severity",
    accessor: (f) => SEVERITY_META[gradePimGroupEligibility(f)].label,
  },
];

const SignalGPanel: React.FC<{
  findings: PimGroupEligibilityFinding[];
  loading: boolean;
}> = ({ findings, loading }) => (
  <section
    className="rounded-md border border-border bg-card/40 p-3"
    aria-labelledby="signal-g-title"
  >
    <header className="mb-2 flex flex-wrap items-center gap-2">
      <GitBranch className="h-3.5 w-3.5 text-warning" aria-hidden />
      <h3
        id="signal-g-title"
        className="text-2xs font-semibold uppercase tracking-wider"
      >
        Signal G — PIM-for-Groups eligibility on role-assignable groups
      </h3>
      <InfoTooltip content="Citation: _bypass_staged_pim.md §6 (PIM for Groups) + _AZURE_BYPASS_PLAYBOOK.md Top-30 #28. Activating PIM-for-Groups eligibility transfers the activator into the group, transitively inheriting any role the group directly holds. The corpus calls this 'three-layer indirection — breaks most detection logic'. Critical when noExpiration eligibility is held against a group that directly holds a Tier-0 role." />
      <span className="ml-auto">
        <ExportMenu
          rows={findings}
          columns={SIGNAL_G_EXPORT_COLUMNS}
          filename="privileged-audit-signal-g-pim-groups"
        />
      </span>
    </header>
    {loading ? (
      <Skeleton className="h-12 w-full" />
    ) : findings.length === 0 ? (
      <p className="m-0 text-2xs text-muted-foreground">
        No PIM-for-Groups eligibilities detected. (If PIM-for-Groups IS
        configured, ensure the signed-in account has{" "}
        <code className="text-3xs">PrivilegedAccess.Read.AzureADGroup</code>{" "}
        or <code className="text-3xs">RoleManagement.Read.All</code>.)
      </p>
    ) : (
      <ul className="flex flex-col gap-1.5">
        {findings.slice(0, 25).map((f) => {
          const sev = gradePimGroupEligibility(f);
          return (
            <li
              key={f.id}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-2xs",
                f.isCriticalTimeBomb
                  ? "border-destructive/50 bg-destructive/5"
                  : sev === "high"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-card",
              )}
            >
              <SeverityBadge severity={sev} />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {f.principalDisplayName ?? f.principalId}
              </span>
              {f.principalSignInName && (
                <span className="font-mono text-3xs text-muted-foreground">
                  {f.principalSignInName}
                </span>
              )}
              <Badge variant="outline">{f.principalType}</Badge>
              <span className="text-2xs text-muted-foreground">
                eligible for member of
              </span>
              <Badge variant="secondary" title={f.groupId}>
                {f.groupDisplayName}
              </Badge>
              {f.isAssignableToRole && (
                <Badge
                  variant="warning"
                  title="Group has isAssignableToRole=true — eligibility on it grants role-assignment-capable membership"
                >
                  role-assignable
                </Badge>
              )}
              {f.groupRoles.length > 0 && (
                <TierBadge tier={f.topTier} compact />
              )}
              <Badge
                variant={
                  f.expirationKind === "noExpiration" ? "destructive" : "outline"
                }
              >
                {f.expirationKind === "noExpiration"
                  ? "noExpiration"
                  : f.expirationKind === "afterDateTime"
                    ? `until ${f.endDateTime?.slice(0, 10) ?? "?"}`
                    : f.expirationKind === "afterDuration"
                      ? f.duration ?? "duration"
                      : "?"}
              </Badge>
              {f.createdDateTime && (
                <span
                  className="font-mono text-3xs text-muted-foreground"
                  title={`Eligibility created ${f.createdDateTime}`}
                >
                  +{formatRelativeTime(f.createdDateTime)}
                </span>
              )}
            </li>
          );
        })}
        {findings.length > 25 && (
          <li className="px-3 py-1 text-2xs text-muted-foreground">
            + {findings.length - 25} more (export for full list)
          </li>
        )}
      </ul>
    )}
  </section>
);

export default PrivilegedAuditPage;
