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
  ChevronDown,
  ChevronRight,
  EyeOff,
  ExternalLink,
  Filter as FilterIcon,
  KeyRound,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
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
import { cn, formatRelativeTime } from "@/lib/utils";

import {
  decodeJwtClaimsUnsafe,
  getActiveTenant,
  getGraphTokenForAccount,
} from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { auditLog } from "../../services/audit-log";
import {
  getMyDirectoryRoles,
  getPrincipalsByIds,
  type ResolvedPrincipal,
} from "../../services/graph-service";
import { useTenantChange } from "../../hooks/use-tenant-change";
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
  TIER_META,
  classifyRole,
  compareByTierThenName,
  hasShadowAdminPath,
  highestTier,
  isExternalUpn,
  isHighBlastRadiusGroup,
  isPrivilegedRoleAdmin,
  portalDeepLink,
  type AssignmentDetail,
  type AssignmentPath,
  type PrincipalType,
  type PrivilegedGroup,
  type PrivilegedPrincipal,
  type RoleTier,
  type ShadowAdminPath,
} from "./privileged-audit-helpers";

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
}

const EMPTY_DATASET: PrivilegedAuditDataset = {
  principals: [],
  shadowPaths: [],
  groups: [],
  servicePrincipals: [],
  warnings: [],
  activatedRoleCount: 0,
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

  return {
    principals: principalsAll,
    shadowPaths,
    groups: groupsOut,
    servicePrincipals,
    warnings,
    activatedRoleCount: roles.length,
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
      setGraphToken(null);
      setGraphTokenExpiresAt(null);
      return null;
    }
    setGraphTokenLoading(true);
    setGraphTokenError(null);
    try {
      const t = await getGraphTokenForAccount(
        primaryAccount.homeAccountId,
        tenantId,
      );
      const claims = decodeJwtClaimsUnsafe(t);
      const exp =
        typeof claims?.exp === "number" ? (claims.exp as number) : null;
      setGraphToken(t);
      setGraphTokenExpiresAt(exp);
      return t;
    } catch (err) {
      setGraphTokenError(
        err instanceof Error ? err.message : String(err),
      );
      setGraphToken(null);
      setGraphTokenExpiresAt(null);
      return null;
    } finally {
      setGraphTokenLoading(false);
    }
  }, [primaryAccount?.homeAccountId, tenantId]);

  React.useEffect(() => {
    void acquireGraphToken();
  }, [acquireGraphToken]);

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
  // Monotonic sequence so a slow stale probe can't overwrite a faster
  // newer one (tenant switch while a probe is in flight).
  const probeSeqRef = React.useRef(0);

  const runProbe = React.useCallback(async () => {
    if (!tenantId) return;
    const token = graphToken ?? (await acquireGraphToken());
    if (!token) {
      setError("Could not acquire a Microsoft Graph token for this tenant.");
      setStatus("error");
      return;
    }
    const mySeq = ++probeSeqRef.current;
    setStatus("loading");
    setError(null);
    const abort = new AbortController();
    try {
      const data = await probeTenant(tenantId, token, abort.signal);
      if (mySeq !== probeSeqRef.current) return;
      setDataset(data);
      setLastProbedAt(new Date().toISOString());
      setStatus("ok");
      // Audit hook — exactly the action+target shape from the spec.
      const tier0Count = data.principals.filter(
        (p) => p.topTier === "tier0",
      ).length;
      auditLog.record({
        actor: primaryAccount?.username ?? "unknown",
        action: "privileged_audit_probe",
        target: tenantId,
        status: "success",
        details: {
          tier0Count,
          shadowAdminCount: data.shadowPaths.length,
          groupCount: data.groups.length,
          spCount: data.servicePrincipals.length,
          warnings: data.warnings.length,
          activatedRoleCount: data.activatedRoleCount,
        },
      });
    } catch (err) {
      if (mySeq !== probeSeqRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
      auditLog.record({
        actor: primaryAccount?.username ?? "unknown",
        action: "privileged_audit_probe",
        target: tenantId,
        status: "failure",
        error: msg,
      });
    }
  }, [tenantId, graphToken, acquireGraphToken, primaryAccount?.username]);

  // Auto-run the probe the first time we have a token + tenant.
  const probeStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (probeStartedRef.current) return;
    if (!tenantId || !graphToken) return;
    probeStartedRef.current = true;
    void runProbe();
  }, [tenantId, graphToken, runProbe]);

  // -------------------------------------------------------------------------
  // Filter UI state
  // -------------------------------------------------------------------------
  const [tierFilters, setTierFilters] = React.useState<Set<RoleTier>>(
    () => new Set<RoleTier>(),
  );
  const [typeFilters, setTypeFilters] = React.useState<Set<PrincipalType>>(
    () => new Set<PrincipalType>(),
  );
  const [pathFilters, setPathFilters] = React.useState<Set<AssignmentPath>>(
    () => new Set<AssignmentPath>(),
  );
  const [shadowOnly, setShadowOnly] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState("");

  const toggleSet = <T extends string>(
    set: Set<T>,
    value: T,
    setter: (s: Set<T>) => void,
  ) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  };

  // -------------------------------------------------------------------------
  // Derived per-section views
  // -------------------------------------------------------------------------
  const filteredPrincipals = React.useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return dataset.principals.filter((p) => {
      if (tierFilters.size > 0 && !tierFilters.has(p.topTier)) return false;
      if (typeFilters.size > 0 && !typeFilters.has(p.type)) return false;
      if (pathFilters.size > 0) {
        const has = p.assignments.some((a) => pathFilters.has(a.path));
        if (!has) return false;
      }
      if (shadowOnly && !p.isShadowAdmin) return false;
      if (q) {
        const hay =
          `${p.displayName} ${p.signInName ?? ""} ${p.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    dataset.principals,
    tierFilters,
    typeFilters,
    pathFilters,
    shadowOnly,
    searchTerm,
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

  // Live tenant-change propagation. This page auto-targets the primary
  // signed-in account's active tenant, so when that account's active tenant
  // changes elsewhere in the app, drop the stale Graph token and re-probe.
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!azureAccounts.some((a) => a.homeAccountId === candidate)) return;
    if (primaryAccount?.homeAccountId !== candidate) return;
    if (detail.tenantId === tenantId) return;
    setGraphToken(null);
    setGraphTokenExpiresAt(null);
    probeStartedRef.current = false;
    void acquireGraphToken();
  });

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

      {/* ─────────────────────────────────────────────────────────── A */}
      <SummaryStatsRow summary={summary} loading={loading} />

      {/* Filters bar (applies to section B). */}
      <FiltersBar
        tierFilters={tierFilters}
        typeFilters={typeFilters}
        pathFilters={pathFilters}
        shadowOnly={shadowOnly}
        searchTerm={searchTerm}
        principals={dataset.principals}
        onToggleTier={(t) => toggleSet(tierFilters, t, setTierFilters)}
        onToggleType={(t) => toggleSet(typeFilters, t, setTypeFilters)}
        onTogglePath={(p) => toggleSet(pathFilters, p, setPathFilters)}
        onShadowOnlyChange={setShadowOnly}
        onSearchTermChange={setSearchTerm}
        onClear={() => {
          setTierFilters(new Set());
          setTypeFilters(new Set());
          setPathFilters(new Set());
          setShadowOnly(false);
          setSearchTerm("");
        }}
      />

      {/* ─────────────────────────────────────────────────────────── B */}
      <PrivilegedIdentityList
        principals={filteredPrincipals}
        tenantId={tenantId}
        loading={loading}
        tenantTotal={dataset.principals.length}
        dataset={dataset}
        summary={summary}
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
  searchTerm: string;
  principals: PrivilegedPrincipal[];
  onToggleTier: (t: RoleTier) => void;
  onToggleType: (t: PrincipalType) => void;
  onTogglePath: (p: AssignmentPath) => void;
  onShadowOnlyChange: (v: boolean) => void;
  onSearchTermChange: (s: string) => void;
  onClear: () => void;
}

const FiltersBar: React.FC<FiltersBarProps> = ({
  tierFilters,
  typeFilters,
  pathFilters,
  shadowOnly,
  searchTerm,
  principals,
  onToggleTier,
  onToggleType,
  onTogglePath,
  onShadowOnlyChange,
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

const PRINCIPAL_EXPORT_COLUMNS: ReadonlyArray<ExportColumn<PrivilegedPrincipal>> = [
  { header: "Display name", accessor: (p) => p.displayName },
  { header: "Type", accessor: (p) => p.type },
  { header: "Sign-in name", accessor: (p) => p.signInName ?? "" },
  { header: "Object id", accessor: (p) => p.id },
  { header: "Top tier", accessor: (p) => TIER_META[p.topTier].label },
  {
    header: "Roles",
    accessor: (p) =>
      Array.from(new Set(p.assignments.map((a) => a.roleDisplayName))).join("; "),
  },
  {
    header: "Assignment paths",
    accessor: (p) =>
      Array.from(new Set(p.assignments.map((a) => a.path))).join("; "),
  },
  { header: "Shadow admin", accessor: (p) => (p.isShadowAdmin ? "yes" : "no") },
  { header: "Guest", accessor: (p) => (p.isExternal ? "yes" : "no") },
];

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
}

const PrivilegedIdentityList: React.FC<PrivilegedIdentityListProps> = ({
  principals,
  tenantId,
  tenantTotal,
  loading,
  dataset,
  summary,
}) => {
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () => new Set(),
  );
  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // For JSON export we want EVERYTHING (paths, summary stats, partial-data
  // warnings) so the file is self-contained per the spec.
  const exportPayload = React.useMemo(
    () => ({
      tenantId,
      probedAt: new Date().toISOString(),
      summary,
      shadowAdminPaths: dataset.shadowPaths,
      groupsHoldingRoles: dataset.groups,
      servicePrincipals: dataset.servicePrincipals,
      warnings: dataset.warnings,
    }),
    [tenantId, summary, dataset],
  );

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
        id: "lastSignIn",
        header: "Last sign-in",
        width: "w-28",
        cell: () => (
          <span className="text-2xs text-muted-foreground">Unknown</span>
        ),
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
    [tenantId, expanded],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-info" /> Privileged identities
            <InfoTooltip content="Every user / group / service-principal that holds at least one activated directory role in the tenant — direct or transitive." />
          </CardTitle>
          <CardDescription>
            Showing {principals.length} of {tenantTotal} privileged identities.
          </CardDescription>
        </div>
        <ExportMenu
          rows={principals}
          columns={PRINCIPAL_EXPORT_COLUMNS}
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
          initialSort={{ column: "tier", direction: "asc" }}
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
        {/* Expanded detail rows — render below the table, keyed by id. */}
        {principals.map((p) =>
          expanded.has(p.id) ? (
            <ExpandedAssignmentDetail
              key={`exp-${p.id}`}
              principal={p}
              tenantId={tenantId}
            />
          ) : null,
        )}
      </CardContent>
    </Card>
  );
};

const ExpandedAssignmentDetail: React.FC<{
  principal: PrivilegedPrincipal;
  tenantId: string;
}> = ({ principal, tenantId }) => (
  <div className="mt-2 rounded-md border border-dashed border-border bg-muted/30 p-3">
    <div className="mb-2 flex items-center justify-between text-2xs">
      <span className="font-semibold uppercase tracking-wider text-muted-foreground">
        Every role this principal holds
      </span>
      <a
        href={portalDeepLink(tenantId, principal)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-info hover:underline"
      >
        Open in portal <ExternalLink className="h-3 w-3" />
      </a>
    </div>
    <ul className="flex flex-col gap-1.5">
      {principal.assignments.map((a) => (
        <li
          key={`${a.roleId}::${a.path}::${a.viaGroupId ?? ""}`}
          className="flex flex-wrap items-center gap-2 text-2xs"
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
        </li>
      ))}
    </ul>
  </div>
);

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

export default PrivilegedAuditPage;
