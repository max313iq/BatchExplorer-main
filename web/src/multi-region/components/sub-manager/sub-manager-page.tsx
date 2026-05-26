/**
 * Sub Manager — subscription-scope RBAC management.
 *
 * Lets the operator pick one of their signed-in accounts, pick a
 * subscription that account can see, and then:
 *   - List every role assignment at that subscription's scope (resolving
 *     principal GUIDs to display names via Graph).
 *   - Filter / search by role, principal type, scope, kind, and "stale"
 *     (couldn't-resolve) status.
 *   - Select rows to bulk-delete (Azure only allows deletes at the
 *     scope the assignment was created at — inherited rows are shown
 *     but locked).
 *   - Add a new assignment by UPN/email or raw object id, with a role
 *     picker that lists every built-in + custom role visible at the
 *     subscription scope.
 *   - Group-by-role view, sortable list, exportable CSV/JSON, quick
 *     "Remove me" shortcut for the common "leave a sub" case.
 *
 * Self-protection: removing the signed-in operator OR the only remaining
 * Owner requires an extra confirm. Audit log records every mutation —
 * both success and failure paths.
 *
 * URL sync: ?tab, ?account, ?sub, ?ba are all kept in sync so links
 * deep-link straight into the right view. SessionStorage is the fallback
 * so reopening the page restores the last picker state.
 *
 * Keyboard: `/` focuses the search box, `Esc` clears selection.
 */
import * as React from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpDown,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Crown,
  Edit3,
  Eye,
  EyeOff,
  Filter,
  Key,
  Layers,
  ListChecks,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldOff,
  Sparkles,
  Trash2,
  User,
  Users,
  UserPlus,
  X,
} from "lucide-react";
import { useUrlParam } from "../../hooks/use-url-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  getActiveTenant,
  getArmTokenForAccount,
  getGraphTokenForAccount,
} from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { auditLog } from "../../services/audit-log";
import {
  assignSubscriptionRole,
  AZURE_ROLE_OWNER,
  createEaDepartment,
  createEnrollmentAccountRoleAssignment,
  deleteEaDepartment,
  deleteRoleAssignment,
  findUserByUpnOrMail,
  getPrincipalsByIds,
  listEaBillingAccounts,
  listEaDepartments,
  listEnrollmentAccounts,
  listSubscriptions,
  listSubscriptionRoleAssignments,
  listSubscriptionRoleDefinitions,
  ROLE_EA_SUBSCRIPTION_CREATOR,
  updateEaDepartment,
} from "../../services";
import type {
  ArmSubscription,
  EaBillingAccount,
  EaDepartment,
  EaEnrollmentAccount,
  ResolvedPrincipal,
  RoleAssignmentRow,
  RoleDefinitionRow,
} from "../../services";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
// COORDINATOR: page-router contract exposes `navigateToPage` (path-based) and
// `store` via `useDashboardOutletContext`. We use that here instead of the
// raw `useNavigate` hook so deep-page navigation goes through the
// canonical router wrapper (preserves PageBoundary + path translation).
import { useDashboardOutletContext } from "../page-router";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

/* ----- Storage keys for cross-navigation persistence ---------------- */
const STORAGE_ACCOUNT = "sub-manager:account";
const STORAGE_SUBSCRIPTION = "sub-manager:subscription";
const STORAGE_TAB = "sub-manager:tab";
const STORAGE_BA = "sub-manager:billing-account";
// Remembers the last role used on the "Add user" form so repeat operators
// don't have to re-pick the same role every time. Cleared if the role
// definition is no longer visible at the picked subscription scope.
const STORAGE_LAST_ROLE = "sub-manager:last-role";
// Remembers the visual mode preference (flat list vs grouped-by-role).
const STORAGE_VIEW_MODE = "sub-manager:view-mode";

/** Top-level tabs on the Sub Manager page. */
type SubManagerTab = "subscription-rbac" | "departments" | "grant-sub-creator";

/** Visual layout for the role-assignments list. */
type ViewMode = "flat" | "grouped";

/** Sort dimension applied to the role-assignments list. */
type SortKey =
  | "name"
  | "name-desc"
  | "role"
  | "role-desc"
  | "type"
  | "scope"
  | "created";

interface SourceAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

/** Joined row: ARM role assignment + resolved principal + resolved role. */
interface JoinedRow {
  assignment: RoleAssignmentRow;
  principal?: ResolvedPrincipal;
  roleName: string;
}

const PRINCIPAL_TYPE_FILTERS = [
  { value: "all", label: "Any principal type" },
  { value: "User", label: "Users" },
  { value: "Group", label: "Groups" },
  { value: "ServicePrincipal", label: "Service principals" },
  { value: "ForeignGroup", label: "Foreign groups" },
] as const;

function principalIcon(type: string): React.FC<{ className?: string }> {
  if (type === "User") return User;
  if (type === "Group") return Users;
  if (type === "ServicePrincipal" || type === "Application") return Shield;
  return Key;
}

/** Format ISO timestamp → "May 24, 2026" (locale aware), falling back to raw. */
function fmtDate(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Single row in the assignments list. Extracted so both the flat view
 * and the grouped view can render the same affordances (checkbox, icon,
 * name, role badge, copy-id buttons, scope state, created-on).
 */
interface AssignmentRowProps {
  row: JoinedRow;
  isSelf: boolean;
  isChecked: boolean;
  onToggleSelect: () => void;
  deleting: boolean;
  isCustomRole: boolean;
  /** When inside a grouped view, the role badge is redundant — hide it. */
  hideRoleBadge?: boolean;
}

/**
 * Memoized to short-circuit re-renders when an unrelated row mutates
 * state (selection toggle, filter change). With 100+ assignments and an
 * `onToggleSelect` that gets a fresh closure per render, the un-memoized
 * version paid for a full subtree reconcile on every keystroke in the
 * search box. Equality compares the row identity (principalId +
 * roleDefinitionId + assignment.id + principal.displayName since the
 * Graph resolve mutates that lazily) plus the per-row toggle inputs.
 */
const AssignmentRowImpl: React.FC<AssignmentRowProps> = ({
  row: r,
  isSelf,
  isChecked,
  onToggleSelect,
  deleting,
  isCustomRole,
  hideRoleBadge = false,
}) => {
  const Icon = principalIcon(r.assignment.principalType);
  const isOwner = r.assignment.roleDefinitionId === AZURE_ROLE_OWNER;
  const lockedReason = !r.assignment.atScope
    ? "Inherited — delete at the scope it was created on."
    : null;
  const unresolved = !r.principal?.displayName;
  return (
    <li
      className={`flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs transition-colors ${
        isSelf ? "bg-warning/5 border-warning/40" : ""
      } ${isChecked ? "bg-accent/40" : ""}`}
    >
      <Checkbox
        aria-label={`Select ${r.principal?.displayName ?? r.assignment.principalId}`}
        checked={isChecked}
        disabled={!r.assignment.atScope || deleting}
        onCheckedChange={onToggleSelect}
      />
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${
          unresolved ? "text-destructive/70" : "text-muted-foreground"
        }`}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-1 truncate font-medium">
          {r.principal?.displayName ?? (
            <span
              className="font-mono text-2xs italic text-muted-foreground"
              title="Graph couldn't resolve this principal to a display name."
            >
              {r.assignment.principalId}
            </span>
          )}
          {isSelf && (
            <Badge variant="warning" className="ml-1 text-2xs">
              you
            </Badge>
          )}
          {unresolved && r.principal?.displayName && (
            <Badge variant="destructive" className="ml-1 text-2xs">
              unresolved
            </Badge>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
          {r.principal?.signInName && (
            <span className="font-mono">
              {r.principal.signInName} ·
            </span>
          )}
          <CopyableText
            value={r.assignment.principalId}
            mono
            ariaLabel={`Copy principal id ${r.assignment.principalId}`}
          />
          {r.assignment.createdOn && (
            <>
              <span className="opacity-60">·</span>
              <span title={r.assignment.createdOn}>
                {fmtDate(r.assignment.createdOn)}
              </span>
            </>
          )}
          {r.assignment.description && (
            <>
              <span className="opacity-60">·</span>
              <span
                className="truncate italic"
                title={r.assignment.description}
              >
                “{r.assignment.description}”
              </span>
            </>
          )}
        </span>
      </span>
      {!hideRoleBadge && (
        <Badge
          variant={isOwner ? "warning" : "outline"}
          className="text-2xs"
          title={`Role definition id: ${r.assignment.roleDefinitionId}`}
        >
          {r.roleName}
        </Badge>
      )}
      {!hideRoleBadge && isCustomRole && (
        <Badge variant="info" className="text-2xs">
          Custom
        </Badge>
      )}
      <Badge variant="secondary" className="text-2xs">
        {r.assignment.principalType}
      </Badge>
      {r.assignment.atScope ? (
        <Badge variant="outline" className="text-2xs">
          at scope
        </Badge>
      ) : (
        <Badge variant="secondary" className="text-2xs">
          inherited
        </Badge>
      )}
      {lockedReason && (
        <span
          className="text-2xs text-muted-foreground"
          aria-label={lockedReason}
          title={lockedReason}
        >
          🔒
        </span>
      )}
      <CopyButtonSmall
        value={r.assignment.id}
        ariaLabel="Copy role assignment ARM id"
        title="Copy role assignment id"
      />
    </li>
  );
};

const AssignmentRow = React.memo(
  AssignmentRowImpl,
  (prev, next) =>
    prev.row.assignment.id === next.row.assignment.id &&
    prev.row.principal?.displayName === next.row.principal?.displayName &&
    prev.row.principal?.signInName === next.row.principal?.signInName &&
    prev.row.roleName === next.row.roleName &&
    prev.isSelf === next.isSelf &&
    prev.isChecked === next.isChecked &&
    prev.deleting === next.deleting &&
    prev.isCustomRole === next.isCustomRole &&
    prev.hideRoleBadge === next.hideRoleBadge &&
    prev.onToggleSelect === next.onToggleSelect,
);

/**
 * Tiny variant of the copy-button — single icon, no inline text. Used
 * at the end of each row so the operator can grab the role assignment
 * ARM id for `az role assignment delete --ids ...` or audit lookups.
 */
const CopyButtonSmall: React.FC<{
  value: string;
  ariaLabel: string;
  title?: string;
}> = ({ value, ariaLabel, title }) => {
  const [copied, setCopied] = React.useState(false);
  const onClick = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — silently no-op */
    }
  }, [value]);
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
    >
      {copied ? (
        <Check className="h-3 w-3 text-success" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
};

/**
 * Grouped-by-role rendering of the assignments list. Each group has a
 * collapsible header showing the role name + member count + owner-tinted
 * styling. Useful for subs with many assignments where role context
 * makes the most sense.
 */
interface GroupedAssignmentsListProps {
  rows: JoinedRow[];
  selfPrincipalId: string | null;
  selected: Set<string>;
  /**
   * Returns a STABLE callback for the given id (same fn ref across
   * renders, keyed off the assignment id). Required so the memoized
   * AssignmentRow doesn't get a fresh closure each render and re-render.
   */
  getToggleSelect: (id: string) => () => void;
  collapsedGroups: Set<string>;
  onToggleGroup: (roleId: string) => void;
  deleting: boolean;
  roleKindById: Map<string, string>;
}

const GroupedAssignmentsList: React.FC<GroupedAssignmentsListProps> = ({
  rows,
  selfPrincipalId,
  selected,
  getToggleSelect,
  collapsedGroups,
  onToggleGroup,
  deleting,
  roleKindById,
}) => {
  const groups = React.useMemo(() => {
    const m = new Map<
      string,
      { roleName: string; isCustom: boolean; rows: JoinedRow[] }
    >();
    for (const r of rows) {
      const key = r.assignment.roleDefinitionId;
      const entry = m.get(key);
      if (entry) {
        entry.rows.push(r);
      } else {
        m.set(key, {
          roleName: r.roleName,
          isCustom: roleKindById.get(key) === "CustomRole",
          rows: [r],
        });
      }
    }
    return Array.from(m.entries()).sort((a, b) => {
      // Owner first, then alphabetical.
      const aOwner = a[0] === AZURE_ROLE_OWNER ? 0 : 1;
      const bOwner = b[0] === AZURE_ROLE_OWNER ? 0 : 1;
      if (aOwner !== bOwner) return aOwner - bOwner;
      return a[1].roleName.localeCompare(b[1].roleName);
    });
  }, [rows, roleKindById]);

  return (
    <div className="flex flex-col gap-2">
      {groups.map(([roleId, group]) => {
        const isOwner = roleId === AZURE_ROLE_OWNER;
        const collapsed = collapsedGroups.has(roleId);
        return (
          <div
            key={roleId}
            className="overflow-hidden rounded-md border border-border"
          >
            <button
              type="button"
              onClick={() => onToggleGroup(roleId)}
              className={`flex w-full flex-wrap items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/30 ${
                isOwner ? "bg-warning/5" : "bg-muted/30"
              }`}
              aria-expanded={!collapsed}
              aria-controls={`group-body-${roleId}`}
            >
              {collapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              <Badge
                variant={isOwner ? "warning" : "outline"}
                className="text-2xs"
              >
                {group.roleName}
              </Badge>
              {group.isCustom && (
                <Badge variant="info" className="text-2xs">
                  Custom
                </Badge>
              )}
              <span className="text-2xs text-muted-foreground">
                {group.rows.length} member
                {group.rows.length === 1 ? "" : "s"}
              </span>
              <CopyableText
                value={roleId}
                mono
                ariaLabel={`Copy role definition id ${roleId}`}
                className="ml-auto text-2xs text-muted-foreground"
              />
            </button>
            {!collapsed && (
              <ul
                id={`group-body-${roleId}`}
                className="flex flex-col gap-1 p-1.5"
              >
                {group.rows.map((r) => (
                  <AssignmentRow
                    key={r.assignment.id}
                    row={r}
                    isSelf={
                      !!selfPrincipalId &&
                      r.assignment.principalId === selfPrincipalId
                    }
                    isChecked={selected.has(r.assignment.id)}
                    onToggleSelect={getToggleSelect(r.assignment.id)}
                    deleting={deleting}
                    isCustomRole={group.isCustom}
                    hideRoleBadge
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Preview shown inside the bulk-delete confirmation dialog. Groups
 * selections by role name + shows a per-row count so the operator can
 * eyeball the impact (e.g. "5 Owner / 12 Reader") before confirming.
 */
const DeletePreview: React.FC<{ rows: JoinedRow[] }> = ({ rows }) => {
  const byRole = React.useMemo(() => {
    const m = new Map<string, JoinedRow[]>();
    for (const r of rows) {
      const k = r.roleName;
      const cur = m.get(k);
      if (cur) cur.push(r);
      else m.set(k, [r]);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [rows]);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {byRole.map(([role, rs]) => (
          <Badge key={role} variant="outline" className="text-2xs">
            {rs.length} × {role}
          </Badge>
        ))}
      </div>
      <ul className="ml-4 list-disc text-2xs text-muted-foreground">
        {rows.slice(0, 5).map((r) => (
          <li key={r.assignment.id}>
            {r.principal?.displayName ?? r.assignment.principalId} —{" "}
            {r.roleName}
          </li>
        ))}
        {rows.length > 5 && <li>… and {rows.length - 5} more</li>}
      </ul>
    </div>
  );
};

export const SubManagerPage: React.FC = () => {
  const state = useMultiRegionState();
  // Prefer outlet-context store so all pages share the same canonical
  // instance the page-router wired up. Fallback to the hook for direct-
  // mounted unit tests that don't have the outlet. `useOutletContext`
  // returns the context object only when this component is rendered as
  // a child of a `<Outlet />`; tests sometimes mount the page directly,
  // so we treat the return value as nullable at runtime.
  const outlet = useDashboardOutletContext() as
    | ReturnType<typeof useDashboardOutletContext>
    | undefined;
  const storeFromHook = useMultiRegionStore();
  const store = outlet?.store ?? storeFromHook;
  const navigateToPage = outlet?.navigateToPage;
  const azureAccounts = state.azureAccounts ?? [];

  /* ----- Tab selection ------------------------------------------- */
  // Default tab: URL `?tab=` wins, then sessionStorage from prior visits,
  // then fall back to subscription-rbac. URL sync makes deep-links share.
  const initialTab = React.useMemo<SubManagerTab>(() => {
    try {
      const v = sessionStorage.getItem(STORAGE_TAB) as SubManagerTab | null;
      if (
        v === "subscription-rbac" ||
        v === "departments" ||
        v === "grant-sub-creator"
      ) {
        return v;
      }
    } catch {
      /* ignore */
    }
    return "subscription-rbac";
  }, []);
  const [tabParam, setTabParam] = useUrlParam("tab", initialTab, {
    replace: true,
  });
  const tab: SubManagerTab =
    tabParam === "subscription-rbac" ||
    tabParam === "departments" ||
    tabParam === "grant-sub-creator"
      ? (tabParam as SubManagerTab)
      : "subscription-rbac";
  const setTab = React.useCallback(
    (v: SubManagerTab) => {
      setTabParam(v);
      // Supplement existing sessionStorage so reopening the page keeps last tab.
      try {
        sessionStorage.setItem(STORAGE_TAB, v);
      } catch {
        /* ignore */
      }
    },
    [setTabParam],
  );

  /* ----- Source account picker -------------------------------------
   * URL (?account=) is authoritative — that's how deep-links share
   * the right account+sub combo. sessionStorage seeds the URL on
   * first load if no URL param is present. SessionStorage stays in
   * sync so reopening the page resumes the last selection. */
  const candidateAccounts: SourceAccount[] = React.useMemo(() => {
    return azureAccounts
      .map((a) => ({
        homeAccountId: a.homeAccountId,
        tenantId: getActiveTenant(a.homeAccountId) ?? resolveActiveTenantId(a) ?? a.tenantId,
        username: a.username,
        name: a.name || a.username,
      }))
      .filter((a) => !!a.homeAccountId && !!a.tenantId);
  }, [azureAccounts]);

  const initialAccountId = React.useMemo<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_ACCOUNT) ?? "";
    } catch {
      return "";
    }
  }, []);
  const [accountParam, setAccountParam] = useUrlParam(
    "account",
    initialAccountId,
    { replace: true },
  );
  const accountId = accountParam;
  const setAccountId = React.useCallback(
    (id: string) => {
      setAccountParam(id);
      try {
        sessionStorage.setItem(STORAGE_ACCOUNT, id);
      } catch {
        /* ignore */
      }
    },
    [setAccountParam],
  );
  // Auto-pick the first account when no selection / the stored one is gone.
  React.useEffect(() => {
    if (candidateAccounts.length === 0) return;
    if (!candidateAccounts.some((a) => a.homeAccountId === accountId)) {
      setAccountId(candidateAccounts[0]!.homeAccountId);
    }
  }, [candidateAccounts, accountId, setAccountId]);

  const account = React.useMemo(
    () => candidateAccounts.find((a) => a.homeAccountId === accountId) ?? null,
    [candidateAccounts, accountId],
  );

  /* ----- Page-level ARM token tracker -----------------------------
   * Drives the TokenExpiryBadge rendered above the tab strip. The
   * sub-manager page makes a lot of ARM calls (list subs, list role
   * assignments, list role defs, list billing accts, list depts, list
   * enrollment accts, plus all the PUT/DELETE mutations) over a long
   * session, so an expiry warning is genuinely useful here. We don't
   * bridge this token into the per-tab `useBillingAccountPicker`
   * armToken state (each tab keeps fetching its own via the existing
   * one-shot flow); the badge just gives the operator a visible
   * heads-up that the page's signed-in account is about to need a
   * fresh token. */
  const armTokenTracker = useArmToken(
    account?.homeAccountId,
    account?.tenantId,
  );

  /* ----- Subscription loading -------------------------------------- */
  const [subscriptions, setSubscriptions] = React.useState<ArmSubscription[]>(
    [],
  );
  const [subsLoading, setSubsLoading] = React.useState(false);
  const [subsError, setSubsError] = React.useState<string | null>(null);
  const initialSubId = React.useMemo<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_SUBSCRIPTION) ?? "";
    } catch {
      return "";
    }
  }, []);
  const [subParam, setSubParam] = useUrlParam("sub", initialSubId, {
    replace: true,
  });
  const subscriptionId = subParam;
  const setSubscriptionId = React.useCallback(
    (id: string) => {
      setSubParam(id);
      try {
        sessionStorage.setItem(STORAGE_SUBSCRIPTION, id);
      } catch {
        /* ignore */
      }
    },
    [setSubParam],
  );

  // useAbortableEffect: signal is aborted on unmount / dep-change. Service
  // layer doesn't (yet) accept AbortSignal so we still gate state writes on
  // `signal.aborted` to avoid stomping a fresher load. subscriptionId is
  // intentionally excluded so the picker doesn't refetch on its own change.
  useAbortableEffect(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    async (signal) => {
      if (!account) {
        setSubscriptions([]);
        return;
      }
      setSubsLoading(true);
      setSubsError(null);
      try {
        // Tenant arg omitted so we pick up the operator's current active
        // tenant (was pinning to account.tenantId / the account's HOME
        // tenant — pre-switch).
        const token = await getArmTokenForAccount(account.homeAccountId);
        if (signal.aborted) return;
        const subs = await listSubscriptions(token);
        if (signal.aborted) return;
        setSubscriptions(subs);
        // Auto-pick when only one or when the stored selection is gone.
        if (subs.length === 1 && subscriptionId !== subs[0]!.subscriptionId) {
          setSubscriptionId(subs[0]!.subscriptionId);
        } else if (
          subscriptionId &&
          !subs.some((s) => s.subscriptionId === subscriptionId)
        ) {
          setSubscriptionId("");
        }
      } catch (err) {
        if (signal.aborted) return;
        setSubsError(err instanceof Error ? err.message : String(err));
        setSubscriptions([]);
      } finally {
        if (!signal.aborted) setSubsLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account?.homeAccountId, account?.tenantId, setSubscriptionId],
  );

  const selectedSub = React.useMemo(
    () => subscriptions.find((s) => s.subscriptionId === subscriptionId) ?? null,
    [subscriptions, subscriptionId],
  );

  /* ----- Subscription-state KPIs + "show only warned/disabled" chip ---
   * Sub Manager is the unified subscription-management hub, so the
   * picker doubles as a fleet view: counts of Enabled / Disabled /
   * Warned / Deleted across every subscription this account can see.
   * Operators can toggle a persisted "show only Disabled/Warned" chip
   * to focus on subs in transient/bad states. Persisted in localStorage
   * so the preference survives reloads. */
  const [onlyTroubled, setOnlyTroubled] = usePersistedState<boolean>(
    "sub-manager:only-troubled",
    false,
  );
  const subStateStats = React.useMemo(() => {
    let enabled = 0;
    let disabled = 0;
    let warned = 0;
    let deleted = 0;
    let other = 0;
    for (const s of subscriptions) {
      const st = (s.state ?? "").toLowerCase();
      if (st === "enabled") enabled += 1;
      else if (st === "disabled") disabled += 1;
      else if (st === "warned") warned += 1;
      else if (st === "deleted") deleted += 1;
      else other += 1;
    }
    return {
      total: subscriptions.length,
      enabled,
      disabled,
      warned,
      deleted,
      other,
      troubled: disabled + warned,
    };
  }, [subscriptions]);
  /**
   * Subscriptions the picker actually offers — filtered to troubled
   * (Disabled / Warned) when the chip is active. The currently-selected
   * sub is always retained so the picker doesn't go blank when the user
   * flips the chip on while sitting on an Enabled sub.
   */
  const visibleSubscriptions = React.useMemo(() => {
    if (!onlyTroubled) return subscriptions;
    return subscriptions.filter((s) => {
      const st = (s.state ?? "").toLowerCase();
      return st === "disabled" || st === "warned" || s.subscriptionId === subscriptionId;
    });
  }, [subscriptions, onlyTroubled, subscriptionId]);

  /* ----- Role assignments + principal resolution ------------------- */
  const [assignments, setAssignments] = React.useState<RoleAssignmentRow[]>([]);
  const [principals, setPrincipals] = React.useState<
    Record<string, ResolvedPrincipal>
  >({});
  const [roleDefs, setRoleDefs] = React.useState<RoleDefinitionRow[]>([]);
  const [listLoading, setListLoading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);
  // Non-fatal warning shown when Graph can't resolve principal names in
  // the subscription's tenant — the table still works with raw GUIDs.
  const [principalResolveWarning, setPrincipalResolveWarning] = React.useState<
    string | null
  >(null);
  const [reloadTick, setReloadTick] = React.useState(0);

  const reload = React.useCallback(() => setReloadTick((n) => n + 1), []);

  // useAbortableEffect: cancel-on-rerun so a tab-switch / sub-switch
  // mid-fetch doesn't race a slower previous load into the UI. The
  // service layer doesn't (yet) accept AbortSignal so we still gate
  // state writes on `signal.aborted`.
  useAbortableEffect(
    async (signal) => {
      if (!account || !subscriptionId) {
        setAssignments([]);
        setPrincipals({});
        setRoleDefs([]);
        setPrincipalResolveWarning(null);
        return;
      }
      setListLoading(true);
      setListError(null);
      setPrincipalResolveWarning(null);
      try {
        // Tenant arg omitted so we pick up the operator's current active
        // tenant (was pinning to account.tenantId / the account's HOME
        // tenant — pre-switch).
        const armToken = await getArmTokenForAccount(account.homeAccountId);
        if (signal.aborted) return;
        const [rows, defs] = await Promise.all([
          listSubscriptionRoleAssignments(subscriptionId, armToken),
          listSubscriptionRoleDefinitions(subscriptionId, armToken),
        ]);
        if (signal.aborted) return;
        setAssignments(rows);
        setRoleDefs(defs);

        // Resolve principal names via Graph in the SUBSCRIPTION's tenant
        // (cross-tenant: guest users in another tenant won't resolve under
        // the source account's home tenant token). Falls back to raw GUIDs
        // when the account can't see Graph in that tenant; we expose the
        // failure as a non-fatal banner so the operator isn't left guessing.
        const subTenantId = selectedSub?.tenantId || account.tenantId;
        try {
          const graphToken = await getGraphTokenForAccount(
            account.homeAccountId,
            subTenantId,
          );
          if (signal.aborted) return;
          const ids = Array.from(new Set(rows.map((r) => r.principalId)));
          const resolved = await getPrincipalsByIds(
            subTenantId,
            ids,
            graphToken,
          );
          if (signal.aborted) return;
          const map: Record<string, ResolvedPrincipal> = {};
          for (const p of resolved) map[p.id] = p;
          setPrincipals(map);
        } catch (graphErr) {
          // Non-fatal — the table still renders with raw GUIDs, but we tell
          // the user so they know why display names aren't appearing.
          if (signal.aborted) return;
          const msg =
            graphErr instanceof Error ? graphErr.message : String(graphErr);
          console.warn("[sub-manager] principal resolve failed:", graphErr);
          setPrincipals({});
          setPrincipalResolveWarning(
            `Couldn't resolve principal names in tenant ${subTenantId}. Showing raw object ids only. (${msg})`,
          );
        }
      } catch (err) {
        if (signal.aborted) return;
        setListError(err instanceof Error ? err.message : String(err));
        setAssignments([]);
        setRoleDefs([]);
      } finally {
        if (!signal.aborted) setListLoading(false);
      }
    },
    [
      account?.homeAccountId,
      account?.tenantId,
      subscriptionId,
      selectedSub?.tenantId,
      reloadTick,
    ],
  );

  /* ----- Filter / search ------------------------------------------- */
  const [search, setSearch] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const [roleFilter, setRoleFilter] = React.useState<string>("all");
  const [typeFilter, setTypeFilter] = React.useState<string>("all");
  const [scopeFilter, setScopeFilter] = React.useState<
    "all" | "at-scope" | "inherited"
  >("all");
  // Quick-chip: filter rows by built-in vs custom role kind. Determined
  // from the role definition's `type` (BuiltInRole / CustomRole). Roles
  // that didn't resolve through `listSubscriptionRoleDefinitions` fall in
  // the "unknown" bucket which behaves as built-in for filter purposes.
  const [kindFilter, setKindFilter] = React.useState<"all" | "custom" | "builtin">(
    "all",
  );
  // Quick-chip: only show rows whose principal couldn't be resolved by
  // Graph (raw GUID with no display name). Common cause of these is a
  // deleted user or a guest from a tenant we lost access to — they're
  // safe to clean up after a quick sanity check.
  const [stalenessFilter, setStalenessFilter] = React.useState<
    "all" | "unresolved" | "resolved"
  >("all");
  // Sort dimension for the displayed list. Persists across the session.
  const [sortKey, setSortKey] = React.useState<SortKey>("name");
  // List vs grouped layout. Grouped is much friendlier when the sub has
  // 100+ assignments because role names are repeated less.
  const [viewMode, setViewMode] = React.useState<ViewMode>(() => {
    try {
      const v = sessionStorage.getItem(STORAGE_VIEW_MODE);
      return v === "grouped" ? "grouped" : "flat";
    } catch {
      return "flat";
    }
  });
  const changeViewMode = React.useCallback((v: ViewMode) => {
    setViewMode(v);
    try {
      sessionStorage.setItem(STORAGE_VIEW_MODE, v);
    } catch {
      /* ignore */
    }
  }, []);
  // Tracks which role groups are expanded in grouped view (by role GUID).
  // Default-collapsed for roles with > 10 members to keep the page short.
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(
    new Set(),
  );
  const toggleGroup = React.useCallback((roleId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }, []);

  const joined: JoinedRow[] = React.useMemo(() => {
    const roleNameById = new Map<string, string>(
      roleDefs.map((d) => [d.id, d.name]),
    );
    return assignments.map((a) => ({
      assignment: a,
      principal: principals[a.principalId],
      roleName: roleNameById.get(a.roleDefinitionId) ?? a.roleDefinitionId,
    }));
  }, [assignments, principals, roleDefs]);

  // Lookup map from role guid → type (BuiltInRole / CustomRole) used by
  // the kind quick-filter and the per-row "custom" badge.
  const roleKindById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of roleDefs) m.set(r.id, r.type);
    return m;
  }, [roleDefs]);

  const filteredRows = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = joined.filter((r) => {
      if (roleFilter !== "all" && r.assignment.roleDefinitionId !== roleFilter)
        return false;
      if (typeFilter !== "all" && r.assignment.principalType !== typeFilter)
        return false;
      if (scopeFilter === "at-scope" && !r.assignment.atScope) return false;
      if (scopeFilter === "inherited" && r.assignment.atScope) return false;
      if (kindFilter !== "all") {
        const kind = roleKindById.get(r.assignment.roleDefinitionId);
        if (kindFilter === "custom" && kind !== "CustomRole") return false;
        if (kindFilter === "builtin" && kind === "CustomRole") return false;
      }
      if (stalenessFilter !== "all") {
        // "Unresolved" = Graph didn't return a display name for this
        // principal. "Resolved" = it did. Useful for spotting tombstoned
        // users that nobody bothered to remove from the sub.
        const resolved = !!r.principal && !!r.principal.displayName;
        if (stalenessFilter === "unresolved" && resolved) return false;
        if (stalenessFilter === "resolved" && !resolved) return false;
      }
      if (q) {
        const hay = [
          r.principal?.displayName ?? "",
          r.principal?.signInName ?? "",
          r.assignment.principalId,
          r.roleName,
          r.assignment.principalType,
          r.assignment.scope,
          r.assignment.description ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // Sort. We do this *after* filtering so the order is deterministic
    // regardless of the order ARM returned. Owners-first secondary sort
    // when sorting by role so the most-privileged rows surface first.
    const nameOf = (r: JoinedRow) =>
      (r.principal?.displayName ?? r.assignment.principalId).toLowerCase();
    const roleOf = (r: JoinedRow) => r.roleName.toLowerCase();
    const ownerFirst = (r: JoinedRow) =>
      r.assignment.roleDefinitionId === AZURE_ROLE_OWNER ? 0 : 1;
    const sorted = filtered.slice();
    switch (sortKey) {
      case "name":
        sorted.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
        break;
      case "name-desc":
        sorted.sort((a, b) => nameOf(b).localeCompare(nameOf(a)));
        break;
      case "role":
        sorted.sort(
          (a, b) =>
            ownerFirst(a) - ownerFirst(b) ||
            roleOf(a).localeCompare(roleOf(b)) ||
            nameOf(a).localeCompare(nameOf(b)),
        );
        break;
      case "role-desc":
        sorted.sort(
          (a, b) =>
            ownerFirst(b) - ownerFirst(a) ||
            roleOf(b).localeCompare(roleOf(a)) ||
            nameOf(a).localeCompare(nameOf(b)),
        );
        break;
      case "type":
        sorted.sort(
          (a, b) =>
            a.assignment.principalType.localeCompare(
              b.assignment.principalType,
            ) || nameOf(a).localeCompare(nameOf(b)),
        );
        break;
      case "scope":
        // At-scope first, then inherited, then by scope path.
        sorted.sort(
          (a, b) =>
            Number(b.assignment.atScope) - Number(a.assignment.atScope) ||
            a.assignment.scope.localeCompare(b.assignment.scope),
        );
        break;
      case "created":
        // Newest first; rows without createdOn sink to the bottom.
        sorted.sort((a, b) => {
          const av = a.assignment.createdOn ?? "";
          const bv = b.assignment.createdOn ?? "";
          if (!av && !bv) return 0;
          if (!av) return 1;
          if (!bv) return -1;
          return bv.localeCompare(av);
        });
        break;
    }
    return sorted;
  }, [
    joined,
    search,
    roleFilter,
    typeFilter,
    scopeFilter,
    kindFilter,
    stalenessFilter,
    roleKindById,
    sortKey,
  ]);

  /* ----- Filter housekeeping --------------------------------------- */
  const hasActiveFilters =
    !!search.trim() ||
    roleFilter !== "all" ||
    typeFilter !== "all" ||
    scopeFilter !== "all" ||
    kindFilter !== "all" ||
    stalenessFilter !== "all";

  const clearAllFilters = React.useCallback(() => {
    setSearch("");
    setRoleFilter("all");
    setTypeFilter("all");
    setScopeFilter("all");
    setKindFilter("all");
    setStalenessFilter("all");
  }, []);

  /* ----- Summary stats for the header row -------------------------- */
  const roleStats = React.useMemo(() => {
    // Owners / Contributors / Readers are well-known built-in GUIDs; the
    // rest fall in "other" so the operator gets a quick at-a-glance breakdown.
    const OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
    const CONTRIB = "b24988ac-6180-42a0-ab88-20f7382dd24c";
    const READER = "acdd72a7-3385-48ef-bd42-f606fba81ae7";
    let owners = 0;
    let contribs = 0;
    let readers = 0;
    let sps = 0;
    let users = 0;
    let groups = 0;
    let inherited = 0;
    let unresolved = 0;
    let custom = 0;
    for (const a of assignments) {
      if (a.roleDefinitionId === OWNER) owners += 1;
      else if (a.roleDefinitionId === CONTRIB) contribs += 1;
      else if (a.roleDefinitionId === READER) readers += 1;
      if (a.principalType === "ServicePrincipal") sps += 1;
      else if (a.principalType === "User") users += 1;
      else if (a.principalType === "Group" || a.principalType === "ForeignGroup")
        groups += 1;
      if (!a.atScope) inherited += 1;
      if (!principals[a.principalId]?.displayName) unresolved += 1;
      if (roleKindById.get(a.roleDefinitionId) === "CustomRole") custom += 1;
    }
    return {
      total: assignments.length,
      owners,
      contribs,
      readers,
      other: assignments.length - owners - contribs - readers,
      sps,
      users,
      groups,
      inherited,
      unresolved,
      custom,
    };
  }, [assignments, principals, roleKindById]);

  const rolesPresent = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of joined) {
      if (!seen.has(r.assignment.roleDefinitionId)) {
        seen.set(r.assignment.roleDefinitionId, r.roleName);
      }
    }
    return Array.from(seen.entries()).sort((a, b) =>
      a[1].localeCompare(b[1]),
    );
  }, [joined]);

  /* ----- Corpus-grounded risk insights -----------------------------
   * Defender-side pattern matching against techniques documented in the
   * offensive-tooling corpus. Each insight is a small read-only signal
   * — no automated remediation. The categories implemented here:
   *
   *  (A) Cross-tenant scope mismatch. When the sub's tenantId differs
   *      from the source account's home tenant, the operator is acting
   *      cross-tenant — exactly the EA / Subscription-Migrator pivot
   *      surface documented in `_ea_subscription_cross_tenant.md`.
   *      Not inherently malicious, but worth flagging because all
   *      destructive operations (cancel / rename / billing-scope
   *      change) on a foreign-tenant sub leave audit fingerprints in
   *      a tenant the operator may not control.
   *
   *  (B) Recent Owner grants. Role assignments at Owner role with
   *      createdOn within the last 24 hours. Mapped to corpus pattern
   *      "rapid escalation before pivot" — the dafthack TeamFiltration
   *      and AzureHound playbooks both call out same-day Owner adds as
   *      the loudest single signal of a hands-on-keyboard takeover.
   *
   *  (C) Deceptive-name principals. Resolved User principals whose
   *      displayName matches naming patterns the corpus documents
   *      attackers use to blend in (see `_bypass_modify_delete.md`
   *      §4.1 — backdoor user with pre-assigned role). We only flag
   *      Users (not SPNs/Groups) because legitimate SPNs frequently
   *      have these prefixes.
   *
   *  (D) Unresolved high-privilege principals. Owners that Graph
   *      couldn't expand to a display name — common stealth-persistence
   *      remnant when a backdoor user / SPN was deleted but the role
   *      assignment was not. Surface these as the highest-confidence
   *      cleanup candidates.
   *
   * Anchored against the corpus to avoid re-inventing thresholds from
   * memory — every category cites a specific playbook file.
   */
  const riskInsights = React.useMemo(() => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    /** Cross-tenant flag: sub.tenantId differs from account.tenantId. */
    const crossTenant =
      !!selectedSub &&
      !!account &&
      !!selectedSub.tenantId &&
      selectedSub.tenantId.toLowerCase() !== account.tenantId.toLowerCase();
    /** Recent Owner adds (within 24h). */
    const recentOwners: JoinedRow[] = [];
    /** Unresolved Owners (no displayName in `principals`). */
    const unresolvedOwners: JoinedRow[] = [];
    /** Deceptive-name principals (Users with svc-/_sync_/admin-/backup/sync hints). */
    const deceptivePrincipals: JoinedRow[] = [];
    // Patterns drawn from `_bypass_modify_delete.md` §4.1. Case-insensitive
    // substring match; anchored prefixes hit first to keep false positives
    // down. `backup` / `sync` are matched anywhere because the corpus
    // notes attackers also use those as suffixes ("dba-sync", "_backup").
    const DECEPTIVE_PREFIXES = ["svc-", "_sync_", "admin-", "adm-", "svc_"];
    const DECEPTIVE_SUBSTR = ["backup", "sync"];
    for (const r of joined) {
      const isOwner = r.assignment.roleDefinitionId === AZURE_ROLE_OWNER;
      if (isOwner) {
        const createdMs = r.assignment.createdOn
          ? Date.parse(r.assignment.createdOn)
          : NaN;
        if (
          Number.isFinite(createdMs) &&
          now - createdMs >= 0 &&
          now - createdMs <= dayMs
        ) {
          recentOwners.push(r);
        }
        if (!r.principal?.displayName) unresolvedOwners.push(r);
      }
      if (r.assignment.principalType === "User") {
        const dn = (r.principal?.displayName ?? "").toLowerCase();
        const sn = (r.principal?.signInName ?? "").toLowerCase();
        const haystack = `${dn} ${sn}`;
        const hit =
          (!!dn || !!sn) &&
          (DECEPTIVE_PREFIXES.some(
            (p) => dn.startsWith(p) || sn.startsWith(p),
          ) ||
            DECEPTIVE_SUBSTR.some((s) => haystack.includes(s)));
        if (hit) deceptivePrincipals.push(r);
      }
    }
    const count =
      (crossTenant ? 1 : 0) +
      (recentOwners.length > 0 ? 1 : 0) +
      (unresolvedOwners.length > 0 ? 1 : 0) +
      (deceptivePrincipals.length > 0 ? 1 : 0);
    return {
      crossTenant,
      recentOwners,
      unresolvedOwners,
      deceptivePrincipals,
      count,
    };
  }, [joined, selectedSub, account]);

  /* ----- Selection for bulk delete --------------------------------- */
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const toggleSelect = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  /**
   * Stable per-id toggle callback cache. Without this, AssignmentRow's
   * `() => toggleSelect(r.assignment.id)` allocates a fresh closure each
   * render, defeating React.memo on the row component. The cache is held
   * in a ref so reassigning entries doesn't trigger a re-render of the
   * parent; entries are reaped lazily when assignments turn over (sub
   * switch / reload) by the effect a few lines below. */
  const toggleSelectByIdCacheRef = React.useRef<Map<string, () => void>>(
    new Map(),
  );
  const getToggleSelect = React.useCallback(
    (id: string): (() => void) => {
      let fn = toggleSelectByIdCacheRef.current.get(id);
      if (!fn) {
        fn = () => toggleSelect(id);
        toggleSelectByIdCacheRef.current.set(id, fn);
      }
      return fn;
    },
    [toggleSelect],
  );
  // Reap stale entries whenever the assignment set turns over (sub switch
  // or refresh). Keeps the cache bounded; otherwise it grows linearly
  // with the number of unique assignment ids the operator has ever seen.
  React.useEffect(() => {
    const live = new Set(assignments.map((a) => a.id));
    const cache = toggleSelectByIdCacheRef.current;
    for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
  }, [assignments]);
  const selectAllDeletable = React.useCallback(() => {
    setSelected(
      new Set(
        filteredRows
          .filter((r) => r.assignment.atScope)
          .map((r) => r.assignment.id),
      ),
    );
  }, [filteredRows]);
  const clearSelection = React.useCallback(() => setSelected(new Set()), []);
  // Reset selection whenever the sub changes.
  React.useEffect(() => {
    setSelected(new Set());
  }, [subscriptionId, reloadTick]);

  /* ----- ARIA-live announcer (declared first so dependents close over it).
   *  See full doc below. */
  // (announce + liveMessage defined immediately after this comment.)
  /* ----- ARIA-live announcer --------------------------------------
   * Polite live region. We pipe filter changes and bulk-delete results
   * through `announce()` so screen-reader users get the same context
   * sighted operators get from the row-count badge updating. The
   * "polite" politeness setting queues messages instead of preempting
   * the user's current screen-reader speech (assistive-tech best
   * practice for non-emergency updates). */
  const [liveMessage, setLiveMessage] = React.useState("");
  const liveTimeoutRef = React.useRef<number | null>(null);
  const announce = React.useCallback((msg: string) => {
    // Clear-then-set so identical-text messages still trigger SR readouts.
    setLiveMessage("");
    if (liveTimeoutRef.current) window.clearTimeout(liveTimeoutRef.current);
    liveTimeoutRef.current = window.setTimeout(() => {
      setLiveMessage(msg);
    }, 40);
  }, []);
  React.useEffect(() => {
    return () => {
      if (liveTimeoutRef.current) window.clearTimeout(liveTimeoutRef.current);
    };
  }, []);

  /* ----- Keyboard shortcuts ---------------------------------------
   * `/`  → focus the search box (skipped if a form field already has focus).
   * `Esc` → clear current selection / clear search.
   * `g`  → toggle flat / grouped view.
   * `o`  → quick toggle: filter to Owners only (re-press to clear).
   * `u`  → quick toggle: filter to Unresolved principals (re-press to clear).
   * `c`  → clear all active filters.
   * Only active while the RBAC tab is the visible one. */
  React.useEffect(() => {
    if (tab !== "subscription-rbac") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      // Skip when any modifier is held — leaves the browser's native
      // Ctrl/Cmd shortcuts unmolested.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "/" && !isTyping) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && !isTyping) {
        if (selected.size > 0) {
          e.preventDefault();
          clearSelection();
          announce(`Cleared ${selected.size} selection${selected.size === 1 ? "" : "s"}.`);
        } else if (search) {
          e.preventDefault();
          setSearch("");
          announce("Cleared search.");
        }
      } else if (e.key === "g" && !isTyping) {
        e.preventDefault();
        const next = viewMode === "flat" ? "grouped" : "flat";
        changeViewMode(next);
        announce(`Switched to ${next === "grouped" ? "grouped" : "flat"} view.`);
      } else if (e.key === "o" && !isTyping) {
        e.preventDefault();
        if (roleFilter === AZURE_ROLE_OWNER) {
          setRoleFilter("all");
          announce("Cleared Owners filter.");
        } else {
          setRoleFilter(AZURE_ROLE_OWNER);
          announce("Filtered to Owners.");
        }
      } else if (e.key === "u" && !isTyping) {
        e.preventDefault();
        if (stalenessFilter === "unresolved") {
          setStalenessFilter("all");
          announce("Cleared unresolved filter.");
        } else {
          setStalenessFilter("unresolved");
          announce("Filtered to unresolved principals.");
        }
      } else if (e.key === "c" && !isTyping && hasActiveFilters) {
        e.preventDefault();
        clearAllFilters();
        announce("Cleared all filters.");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    tab,
    selected.size,
    clearSelection,
    viewMode,
    changeViewMode,
    roleFilter,
    stalenessFilter,
    hasActiveFilters,
    clearAllFilters,
    search,
    announce,
  ]);

  /* ----- Self-protection diagnostics ------------------------------- */
  // Narrow to `string | null` (previous shape leaked `SourceAccount | string |
  // false | undefined` into downstream comparisons via JS short-circuit).
  const selfPrincipalId = React.useMemo<string | null>(() => {
    if (!candidateAccounts.some((a) => a.homeAccountId === accountId)) {
      return null;
    }
    const match = azureAccounts.find((a) => a.homeAccountId === accountId);
    return match?.localAccountId ?? null;
  }, [candidateAccounts, azureAccounts, accountId]);

  const ownerCount = React.useMemo(
    () =>
      assignments.filter((a) => a.roleDefinitionId === AZURE_ROLE_OWNER)
        .length,
    [assignments],
  );

  const selectedRowsObjects = React.useMemo(() => {
    return joined.filter((r) => selected.has(r.assignment.id));
  }, [joined, selected]);

  const selectedTouchesSelf = React.useMemo(
    () =>
      !!selfPrincipalId &&
      selectedRowsObjects.some(
        (r) => r.assignment.principalId === selfPrincipalId,
      ),
    [selectedRowsObjects, selfPrincipalId],
  );
  const selectedOwnerCount = selectedRowsObjects.filter(
    (r) => r.assignment.roleDefinitionId === AZURE_ROLE_OWNER,
  ).length;
  const wouldRemoveLastOwner =
    ownerCount > 0 && selectedOwnerCount >= ownerCount;

  /* ----- Bulk delete flow ------------------------------------------ */
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const performDelete = React.useCallback(async () => {
    if (!account || selectedRowsObjects.length === 0) return;
    setDeleting(true);
    let succeeded = 0;
    let failed = 0;
    const failures: string[] = [];
    try {
      // Tenant arg omitted so we pick up the operator's current active
      // tenant (was pinning to account.tenantId / the account's HOME
      // tenant — pre-switch).
      const armToken = await getArmTokenForAccount(account.homeAccountId);
      for (const r of selectedRowsObjects) {
        try {
          await deleteRoleAssignment(r.assignment.id, armToken);
          succeeded += 1;
          auditLog.record({
            actor: account.username,
            action: "delete_role_assignment",
            target: r.assignment.principalId,
            status: "success",
            details: {
              subscriptionId,
              roleDefinitionId: r.assignment.roleDefinitionId,
              roleName: r.roleName,
              roleAssignmentId: r.assignment.id,
              principalType: r.assignment.principalType,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failed += 1;
          failures.push(
            `${r.principal?.displayName ?? r.assignment.principalId}: ${msg}`,
          );
          auditLog.record({
            actor: account.username,
            action: "delete_role_assignment",
            target: r.assignment.principalId,
            status: "failure",
            error: msg,
            details: {
              subscriptionId,
              roleDefinitionId: r.assignment.roleDefinitionId,
              roleName: r.roleName,
              roleAssignmentId: r.assignment.id,
            },
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addNotification({
        type: "error",
        message: `Token acquisition failed: ${msg}`,
      });
    }
    setDeleting(false);
    setConfirmOpen(false);
    setSelected(new Set());
    const summaryMessage =
      failed > 0
        ? `Removed ${succeeded}, failed ${failed}. ${failures.slice(0, 2).join(" · ")}${failures.length > 2 ? "…" : ""}`
        : `Removed ${succeeded} role assignment${succeeded === 1 ? "" : "s"}.`;
    store.addNotification({
      type: failed > 0 ? (succeeded > 0 ? "warning" : "error") : "success",
      message: summaryMessage,
    });
    // Mirror to ARIA-live so screen-reader users hear the same outcome
    // sighted operators see in the toast — toasts aren't always picked up.
    announce(summaryMessage);
    reload();
  }, [account, selectedRowsObjects, subscriptionId, store, reload, announce]);

  /* ----- "Remove me" shortcut -------------------------------------- */
  const myRows = React.useMemo(() => {
    if (!selfPrincipalId) return [];
    return joined.filter(
      (r) => r.assignment.principalId === selfPrincipalId && r.assignment.atScope,
    );
  }, [joined, selfPrincipalId]);
  const removeMe = React.useCallback(() => {
    if (myRows.length === 0) return;
    setSelected(new Set(myRows.map((r) => r.assignment.id)));
    setConfirmOpen(true);
  }, [myRows]);

  /* ----- Add-new-assignment panel ---------------------------------- */
  const [addPrincipalInput, setAddPrincipalInput] = React.useState("");
  const [addPrincipalType, setAddPrincipalType] = React.useState<
    "User" | "Group" | "ServicePrincipal"
  >("User");
  const [addRoleId, setAddRoleId] = React.useState<string>("");
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  /**
   * Reveals the sanitized ARM PUT body that `assignSubscriptionRole`
   * will send. Lets the operator (or a reviewer over their shoulder)
   * eyeball the exact wire payload before committing — useful when
   * pasting into az-cli, when running the request through a proxy,
   * or when documenting a change ticket. No token / no headers shown;
   * we only render what's safe to leak to a screenshot. */
  const [showArmPreview, setShowArmPreview] = React.useState(false);
  /**
   * Sanitized ARM PUT body preview. Matches the shape
   * `assignSubscriptionRole` produces — see services/role-assignments.ts.
   * The role-assignment id is a fresh GUID; ARM expects a client-
   * generated id at the PUT URL segment, so the preview generates one
   * deterministically from the principal+role pair for display only
   * (the real service generates its own at submit time). */
  const armPutPreview = React.useMemo(() => {
    const raw = addPrincipalInput.trim();
    if (!subscriptionId || !addRoleId || !raw) return null;
    const guidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const principalObjectId = guidRe.test(raw) ? raw : `<resolved-from "${raw}">`;
    return {
      url: `PUT https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleAssignments/<new-guid>?api-version=2022-04-01`,
      body: {
        properties: {
          roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${addRoleId}`,
          principalId: principalObjectId,
          principalType: addPrincipalType,
        },
      },
    };
  }, [subscriptionId, addRoleId, addPrincipalInput, addPrincipalType]);

  // Seed default role when role defs load. Preference: last role used on
  // this page (per session), then Owner, then nothing. Drops a stored
  // role that's no longer visible at the new subscription scope.
  React.useEffect(() => {
    if (addRoleId || roleDefs.length === 0) return;
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(STORAGE_LAST_ROLE);
    } catch {
      /* ignore */
    }
    if (stored && roleDefs.some((r) => r.id === stored)) {
      setAddRoleId(stored);
    } else if (roleDefs.some((r) => r.id === AZURE_ROLE_OWNER)) {
      setAddRoleId(AZURE_ROLE_OWNER);
    }
  }, [roleDefs, addRoleId]);
  // Persist whatever the operator most recently picked.
  React.useEffect(() => {
    if (!addRoleId) return;
    try {
      sessionStorage.setItem(STORAGE_LAST_ROLE, addRoleId);
    } catch {
      /* ignore */
    }
  }, [addRoleId]);

  // Tally for "principal already has this role" inline warning shown
  // above the Grant button. Lookup is by GUID + role GUID against the
  // current assignments. Helps operators avoid silent no-op grants.
  const existingMatchForAdd = React.useMemo(() => {
    const raw = addPrincipalInput.trim();
    if (!raw || !addRoleId) return null;
    const guidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!guidRe.test(raw)) return null;
    return assignments.find(
      (a) =>
        a.principalId.toLowerCase() === raw.toLowerCase() &&
        a.roleDefinitionId === addRoleId &&
        a.atScope,
    );
  }, [addPrincipalInput, addRoleId, assignments]);

  const submitAdd = React.useCallback(async () => {
    if (!account || !subscriptionId || !addRoleId) return;
    const raw = addPrincipalInput.trim();
    if (!raw) return;
    setAdding(true);
    setAddError(null);
    try {
      // Allow either a raw GUID or a UPN/email. GUID → use directly.
      // Otherwise resolve via Graph (User only — group/SPN lookup by
      // name is messier and operators usually have the GUID for those).
      const guidRe =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let principalObjectId = "";
      if (guidRe.test(raw)) {
        principalObjectId = raw;
      } else if (addPrincipalType === "User") {
        const subTenantId = selectedSub?.tenantId || account.tenantId;
        const graphToken = await getGraphTokenForAccount(
          account.homeAccountId,
          subTenantId,
        );
        const found = await findUserByUpnOrMail(subTenantId, raw, graphToken);
        if (!found) {
          throw new Error(
            `No user found in tenant ${subTenantId} matching "${raw}". Paste the user's object id if Graph can't see them.`,
          );
        }
        principalObjectId = found.id;
      } else {
        throw new Error(
          "Lookup by name is only supported for Users. Paste the Group / Service Principal object id.",
        );
      }

      // Tenant arg omitted so we pick up the operator's current active
      // tenant (was pinning to account.tenantId / the account's HOME
      // tenant — pre-switch).
      const armToken = await getArmTokenForAccount(account.homeAccountId);
      const r = await assignSubscriptionRole(
        subscriptionId,
        principalObjectId,
        addRoleId,
        armToken,
        { principalType: addPrincipalType },
      );
      const role = roleDefs.find((d) => d.id === addRoleId);
      auditLog.record({
        actor: account.username,
        action: "create_role_assignment",
        target: principalObjectId,
        status: "success",
        details: {
          subscriptionId,
          roleDefinitionId: addRoleId,
          roleName: role?.name ?? addRoleId,
          principalType: addPrincipalType,
          alreadyExisted: r.alreadyExisted,
          raw,
        },
      });
      store.addNotification({
        type: "success",
        message: r.alreadyExisted
          ? `Principal already has ${role?.name ?? "the role"}.`
          : `Granted ${role?.name ?? "role"} to ${raw}.`,
      });
      setAddPrincipalInput("");
      reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAddError(msg);
      auditLog.record({
        actor: account.username,
        action: "create_role_assignment",
        target: addPrincipalInput,
        status: "failure",
        error: msg,
        details: {
          subscriptionId,
          roleDefinitionId: addRoleId,
          principalType: addPrincipalType,
        },
      });
    } finally {
      setAdding(false);
    }
  }, [
    account,
    subscriptionId,
    addRoleId,
    addPrincipalInput,
    addPrincipalType,
    selectedSub?.tenantId,
    roleDefs,
    store,
    reload,
  ]);

  /* ----- Export columns -------------------------------------------- */
  const roleAssignmentExportColumns = React.useMemo<
    ExportColumn<JoinedRow>[]
  >(
    () => [
      { header: "Principal name", accessor: (r) => r.principal?.displayName ?? "" },
      { header: "Sign-in name", accessor: (r) => r.principal?.signInName ?? "" },
      { header: "Principal id", accessor: (r) => r.assignment.principalId },
      { header: "Principal type", accessor: (r) => r.assignment.principalType },
      { header: "Role name", accessor: (r) => r.roleName },
      { header: "Role definition id", accessor: (r) => r.assignment.roleDefinitionId },
      {
        header: "Role kind",
        accessor: (r) =>
          roleKindById.get(r.assignment.roleDefinitionId) ?? "BuiltInRole",
      },
      { header: "Scope", accessor: (r) => r.assignment.scope },
      { header: "At scope", accessor: (r) => r.assignment.atScope },
      { header: "Role assignment id", accessor: (r) => r.assignment.id },
      { header: "Created on", accessor: (r) => r.assignment.createdOn ?? "" },
      { header: "Description", accessor: (r) => r.assignment.description ?? "" },
    ],
    [roleKindById],
  );

  /* ----- React to global tenant-switch events ---------------------- */
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!candidateAccounts.some((a) => a.homeAccountId === candidate)) return;
    if (accountId === candidate) return;
    setAccountId(candidate);
  });

  /* ----- Render ---------------------------------------------------- */

  if (candidateAccounts.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Sub Manager"
          description="Inspect, add, and remove role assignments on an Azure subscription."
        />
        <EmptyState
          icon={Shield}
          title="No Azure account signed in"
          description="Add an Azure account first — Sub Manager needs an ARM token to read role assignments."
        />
      </div>
    );
  }

  const deleteDisabled =
    selected.size === 0 ||
    deleting ||
    !selectedRowsObjects.some((r) => r.assignment.atScope);

  return (
    <div className="flex flex-col gap-4 py-2">
      {/* Polite ARIA live region — sr-only visually, but screen readers
        * announce its contents when they change. Used for filter-toggle
        * and delete-result announcements so SR users get the same
        * feedback as sighted operators. The empty leading state lets us
        * clear-then-set without spurious announcements on first mount. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveMessage}
      </div>
      <PageHeader
        title="Sub Manager"
        description="Subscription RBAC, EA departments, and EA Subscription Creator grants in one place."
      >
        <div className="flex items-center gap-2">
          <TokenExpiryBadge
            secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
            loading={armTokenTracker.loading}
            onRefresh={() => void armTokenTracker.refresh()}
            needsReauth={armTokenTracker.needsReauth}
            onReauth={() =>
              void armTokenTracker.reauth({
                loginHint: account?.username,
              })
            }
          />
          {tab === "subscription-rbac" && (
            <>
              <InfoTooltip
                content={
                  <div className="flex flex-col gap-1 text-2xs">
                    <span className="font-semibold">Keyboard shortcuts</span>
                    <span>
                      <kbd className="rounded border px-1">/</kbd> focus
                      search
                    </span>
                    <span>
                      <kbd className="rounded border px-1">Esc</kbd> clear
                      selection / search
                    </span>
                    <span>
                      <kbd className="rounded border px-1">g</kbd> toggle
                      flat / grouped
                    </span>
                    <span>
                      <kbd className="rounded border px-1">o</kbd> filter to
                      Owners
                    </span>
                    <span>
                      <kbd className="rounded border px-1">u</kbd> filter to
                      Unresolved
                    </span>
                    <span>
                      <kbd className="rounded border px-1">c</kbd> clear all
                      filters
                    </span>
                  </div>
                }
                size={14}
                variant="help"
                ariaLabel="Keyboard shortcuts"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={reload}
                disabled={!subscriptionId || listLoading}
                aria-label="Refresh role assignments"
              >
                <RefreshCw
                  className={listLoading ? "animate-spin" : undefined}
                />
                Refresh
              </Button>
            </>
          )}
        </div>
      </PageHeader>

      {/* ----- Tab strip --------------------------------------------- */}
      <div className="flex flex-wrap gap-1 border-b border-border pb-1">
        <Button
          type="button"
          variant={tab === "subscription-rbac" ? "default" : "ghost"}
          size="sm"
          className="h-8 text-xs"
          onClick={() => setTab("subscription-rbac")}
        >
          <Shield className="h-3.5 w-3.5" />
          Subscription RBAC
        </Button>
        <Button
          type="button"
          variant={tab === "departments" ? "default" : "ghost"}
          size="sm"
          className="h-8 text-xs"
          onClick={() => setTab("departments")}
        >
          <Layers className="h-3.5 w-3.5" />
          Departments
        </Button>
        <Button
          type="button"
          variant={tab === "grant-sub-creator" ? "default" : "ghost"}
          size="sm"
          className="h-8 text-xs"
          onClick={() => setTab("grant-sub-creator")}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Grant Subscription Creator
        </Button>
      </div>

      {tab === "departments" && (
        <DepartmentsTab
          azureAccounts={candidateAccounts}
          store={store}
        />
      )}
      {tab === "grant-sub-creator" && (
        <GrantSubCreatorTab
          azureAccounts={candidateAccounts}
          store={store}
          navigateToPage={navigateToPage}
        />
      )}

      {tab === "subscription-rbac" && (
        <>

      {/* ----- Source + subscription pickers ------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-primary" />
            Scope
          </CardTitle>
          <CardDescription>
            Pick which signed-in account does the ARM calls, then the
            subscription you want to manage.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sm-account" className="text-xs">
              Source account
            </Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="sm-account">
                <SelectValue placeholder="Pick an account" />
              </SelectTrigger>
              <SelectContent>
                {candidateAccounts.map((a) => (
                  <SelectItem key={a.homeAccountId} value={a.homeAccountId}>
                    <span className="flex flex-col">
                      <span className="text-sm">{a.name}</span>
                      <span className="text-2xs text-muted-foreground">
                        {a.username} · tenant{" "}
                        {(a.tenantId ?? "unknown").slice(0, 8)}…
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sm-subscription" className="text-xs">
              Subscription
            </Label>
            {subsLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading subscriptions…
              </p>
            ) : subsError ? (
              <ErrorState
                size="compact"
                message="Failed to load subscriptions."
                detail={subsError}
                onRetry={() => setReloadTick((n) => n + 1)}
                retryLabel="Retry"
              />
            ) : subscriptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No subscriptions visible to this account.
              </p>
            ) : (
              <Select
                value={subscriptionId}
                onValueChange={setSubscriptionId}
              >
                <SelectTrigger id="sm-subscription">
                  <SelectValue placeholder="Pick a subscription" />
                </SelectTrigger>
                <SelectContent>
                  {visibleSubscriptions.map((s) => (
                    <SelectItem
                      key={s.subscriptionId}
                      value={s.subscriptionId}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm">{s.displayName}</span>
                        <span className="font-mono text-2xs text-muted-foreground">
                          {s.subscriptionId} · {s.state}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
        {/* Subscription-fleet KPIs + "only Disabled / Warned" toggle ----
          * Renders only when at least one subscription is visible. Tiles
          * use SummaryStatItem so tones (warning / destructive) match
          * the rest of the dashboard. */}
        {subscriptions.length > 0 && (
          <CardContent className="border-t border-border pt-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
              <SummaryStatItem
                label="Total"
                value={subStateStats.total}
                compact
                ariaLabel={`${subStateStats.total} subscriptions visible`}
              />
              <SummaryStatItem
                label="Enabled"
                value={subStateStats.enabled}
                tone={subStateStats.enabled > 0 ? "success" : "muted"}
                compact
                ariaLabel={`${subStateStats.enabled} subscriptions enabled`}
              />
              <SummaryStatItem
                label="Disabled"
                value={subStateStats.disabled}
                tone={subStateStats.disabled > 0 ? "warning" : "muted"}
                compact
                ariaLabel={`${subStateStats.disabled} subscriptions disabled`}
              />
              <SummaryStatItem
                label="Warned"
                value={subStateStats.warned}
                tone={subStateStats.warned > 0 ? "warning" : "muted"}
                compact
                ariaLabel={`${subStateStats.warned} subscriptions warned`}
              />
              <SummaryStatItem
                label="Deleted"
                value={subStateStats.deleted}
                tone={subStateStats.deleted > 0 ? "destructive" : "muted"}
                compact
                ariaLabel={`${subStateStats.deleted} subscriptions deleted`}
              />
              {/* "Stuck" — subscriptions whose state isn't one of the four
                * well-known terminal states (Enabled / Disabled / Warned /
                * Deleted). In practice these are subs in a transient state
                * (PastDue, Expired, Transferred mid-flight) that have sat
                * there long enough to be worth investigating. The tone
                * mirrors Warned because the actual remediation path is the
                * same — open the Portal billing blade. */}
              <SummaryStatItem
                label="Stuck"
                value={subStateStats.other}
                tone={subStateStats.other > 0 ? "warning" : "muted"}
                compact
                hint={subStateStats.other > 0 ? "transient" : undefined}
                ariaLabel={`${subStateStats.other} subscriptions in non-standard state`}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={onlyTroubled ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setOnlyTroubled(!onlyTroubled)}
                aria-pressed={onlyTroubled}
                title="Filter the picker to subscriptions in Disabled or Warned state"
                disabled={subStateStats.troubled === 0 && !onlyTroubled}
              >
                <AlertTriangle className="h-3 w-3" />
                {onlyTroubled
                  ? `Showing only troubled (${subStateStats.troubled})`
                  : `Show only troubled (${subStateStats.troubled})`}
              </Button>
              {onlyTroubled && subStateStats.troubled === 0 && (
                <span className="text-2xs text-muted-foreground">
                  No troubled subs — toggle off to see all.
                </span>
              )}
              {selectedSub && (
                <span className="ml-auto flex items-center gap-1 text-2xs text-muted-foreground">
                  Current:
                  <Badge
                    variant={
                      (selectedSub.state ?? "").toLowerCase() === "enabled"
                        ? "outline"
                        : (selectedSub.state ?? "").toLowerCase() === "warned" ||
                            (selectedSub.state ?? "").toLowerCase() === "disabled"
                          ? "warning"
                          : "destructive"
                    }
                    className="text-2xs"
                  >
                    {selectedSub.state ?? "unknown"}
                  </Badge>
                </span>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {!subscriptionId && !subsLoading && (
        <EmptyState
          icon={Building2}
          title="Pick a subscription"
          description="Once you pick a subscription above, every role assignment at its scope shows up here."
        />
      )}

      {subscriptionId && (
        <>
          {/* ----- Add-new assignment ------------------------------- */}
          <Card className="border-primary/30">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <UserPlus className="h-4 w-4 text-primary" />
                Add user / SPN / group
              </CardTitle>
              <CardDescription>
                Grant a role at this subscription's scope. Paste an object
                id (any principal type) or a UPN / email (User only).
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sm-add-input" className="text-xs">
                    Object id or UPN / email
                  </Label>
                  <Input
                    id="sm-add-input"
                    value={addPrincipalInput}
                    onChange={(e) => {
                      setAddPrincipalInput(e.target.value);
                      setAddError(null);
                    }}
                    placeholder="alice@contoso.com  OR  11111111-2222-…"
                    className="font-mono text-xs"
                    disabled={adding}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1 text-xs">
                    Principal type
                    <InfoTooltip
                      size={12}
                      content="Identity kind the object id belongs to. Required by ARM because object ids alone don't carry the type — getting it wrong causes the PUT to fail with PrincipalTypeNotFound."
                    />
                  </Label>
                  <Select
                    value={addPrincipalType}
                    onValueChange={(v) =>
                      setAddPrincipalType(
                        v as "User" | "Group" | "ServicePrincipal",
                      )
                    }
                    disabled={adding}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select principal type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="User">User</SelectItem>
                      <SelectItem value="Group">Group</SelectItem>
                      <SelectItem value="ServicePrincipal">
                        Service Principal
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1 text-xs">
                    Role
                    <InfoTooltip
                      size={12}
                      content="Includes every built-in role plus any custom role definitions visible at or above the subscription scope. Custom roles are clearly tagged in the dropdown."
                    />
                  </Label>
                  <Select
                    value={addRoleId}
                    onValueChange={setAddRoleId}
                    disabled={adding || roleDefs.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a role" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {roleDefs
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            <span className="flex flex-col">
                              <span className="text-sm">{r.name}</span>
                              <span className="text-2xs text-muted-foreground">
                                {r.type === "CustomRole"
                                  ? "Custom"
                                  : "Built-in"}{" "}
                                · {(r.id ?? "").slice(0, 8)}…
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {/* ARM PUT preview — sanitized wire-payload of the upcoming
                * mutation. Renders only when the form has enough data to
                * produce a useful preview. Hidden by default to keep the
                * card uncluttered; revealed on demand. Useful for change
                * tickets, az-cli paste-ins, and quick sanity checks
                * before clicking Grant. */}
              {armPutPreview && (
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-2xs"
                      onClick={() => setShowArmPreview((v) => !v)}
                      aria-expanded={showArmPreview}
                      aria-controls="sm-arm-put-preview"
                    >
                      {showArmPreview ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      {showArmPreview ? "Hide" : "Show"} ARM PUT preview
                      (sanitized)
                    </Button>
                    {showArmPreview && (
                      <CopyButtonSmall
                        value={JSON.stringify(armPutPreview, null, 2)}
                        ariaLabel="Copy ARM PUT preview JSON"
                        title="Copy preview JSON"
                      />
                    )}
                  </div>
                  {showArmPreview && (
                    <pre
                      id="sm-arm-put-preview"
                      className="overflow-x-auto rounded-md border border-border bg-muted/30 p-2 text-2xs font-mono leading-snug"
                    >
                      {armPutPreview.url}
                      {"\n\n"}
                      {JSON.stringify(armPutPreview.body, null, 2)}
                    </pre>
                  )}
                </div>
              )}
              {existingMatchForAdd && (
                <Alert variant="warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription>
                    This principal already holds{" "}
                    <strong>
                      {roleDefs.find((r) => r.id === addRoleId)?.name ?? "the role"}
                    </strong>{" "}
                    at this scope. The PUT will be a no-op (idempotent).
                  </AlertDescription>
                </Alert>
              )}
              {addError && (
                <Alert variant="destructive">
                  <AlertDescription>{addError}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  onClick={() => void submitAdd()}
                  disabled={
                    adding ||
                    !addPrincipalInput.trim() ||
                    !addRoleId ||
                    !subscriptionId
                  }
                  loading={adding}
                >
                  {!adding && <Plus />}
                  {adding ? "Adding…" : "Grant role"}
                </Button>
                {/* Grant-yourself shortcut — quickly Owner the picked sub
                  * with the signed-in account. Common for new subs where
                  * the operator was bootstrapped via EA / mgmt-group only. */}
                {selfPrincipalId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={adding || !addRoleId}
                    onClick={() => {
                      setAddPrincipalInput(selfPrincipalId);
                      setAddPrincipalType("User");
                    }}
                    title="Pre-fill the input with your own object id"
                  >
                    <User className="h-3.5 w-3.5" />
                    Use my id
                  </Button>
                )}
                <span className="ml-auto flex items-center gap-1 text-2xs text-muted-foreground">
                  Subscription:
                  <CopyableText
                    value={subscriptionId}
                    mono
                    ariaLabel="Copy subscription id"
                  />
                </span>
              </div>
            </CardContent>
          </Card>

          {/* ----- Quick stats ---------------------------------------
            * Each card is a clickable filter shortcut — click "Owners"
            * to filter to Owner rows, click "SPNs" to filter to
            * service principals, etc. Click "Total" or use "Clear
            * filters" below to reset. */}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
            <SummaryStatItem
              label="Total"
              value={roleStats.total}
              compact
              onClick={hasActiveFilters ? clearAllFilters : undefined}
              ariaLabel={
                hasActiveFilters
                  ? `Clear filters, total ${roleStats.total} assignments`
                  : `Total ${roleStats.total} assignments`
              }
            />
            <SummaryStatItem
              label="Owners"
              value={roleStats.owners}
              tone={roleStats.owners > 0 ? "warning" : "muted"}
              compact
              onClick={() => setRoleFilter(AZURE_ROLE_OWNER)}
              ariaLabel={`Filter to ${roleStats.owners} Owner assignments`}
            />
            <SummaryStatItem
              label="Contribs"
              value={roleStats.contribs}
              tone="info"
              compact
              onClick={() =>
                setRoleFilter("b24988ac-6180-42a0-ab88-20f7382dd24c")
              }
              ariaLabel={`Filter to ${roleStats.contribs} Contributor assignments`}
            />
            <SummaryStatItem
              label="Readers"
              value={roleStats.readers}
              tone="muted"
              compact
              onClick={() =>
                setRoleFilter("acdd72a7-3385-48ef-bd42-f606fba81ae7")
              }
              ariaLabel={`Filter to ${roleStats.readers} Reader assignments`}
            />
            <SummaryStatItem
              label="SPNs"
              value={roleStats.sps}
              tone={roleStats.sps > 0 ? "info" : "muted"}
              compact
              onClick={() => setTypeFilter("ServicePrincipal")}
              ariaLabel={`Filter to ${roleStats.sps} service principal assignments`}
            />
            <SummaryStatItem
              label="Groups"
              value={roleStats.groups}
              tone="muted"
              compact
              onClick={() => setTypeFilter("Group")}
              ariaLabel={`Filter to ${roleStats.groups} group assignments`}
            />
            <SummaryStatItem
              label="Inherited"
              value={roleStats.inherited}
              tone="muted"
              compact
              onClick={() => setScopeFilter("inherited")}
              ariaLabel={`Filter to ${roleStats.inherited} inherited assignments`}
            />
            <SummaryStatItem
              label="Unresolved"
              value={roleStats.unresolved}
              tone={roleStats.unresolved > 0 ? "destructive" : "muted"}
              compact
              onClick={() => setStalenessFilter("unresolved")}
              hint={roleStats.unresolved > 0 ? "stale?" : undefined}
              ariaLabel={`Filter to ${roleStats.unresolved} unresolved principals`}
            />
          </div>

          {/* "No Owner remaining" alert — a sub with no Owner at-scope
            * is reachable only through mgmt-group / tenant inheritance.
            * Surface it loudly with a one-click "Grant myself Owner". */}
          {ownerCount === 0 && assignments.length > 0 && selfPrincipalId && (
            <Alert variant="warning">
              <ShieldAlert className="h-4 w-4" />
              <AlertDescription className="flex flex-wrap items-center gap-2 text-xs">
                <span>
                  No <strong>Owner</strong> role assignment exists at this
                  subscription's scope. Access depends entirely on
                  higher-scope (mgmt-group / tenant) roles.
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setAddPrincipalInput(selfPrincipalId);
                    setAddPrincipalType("User");
                    setAddRoleId(AZURE_ROLE_OWNER);
                  }}
                >
                  <Crown className="h-3.5 w-3.5" />
                  Pre-fill: grant myself Owner
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {principalResolveWarning && (
            <Alert variant="warning">
              <AlertDescription>{principalResolveWarning}</AlertDescription>
            </Alert>
          )}

          {/* ----- Corpus-grounded Risk Insights ---------------------
            * Pattern-matches the visible role assignments against
            * techniques documented in the offensive-tooling corpus.
            * Each card cites the playbook it draws from. Read-only;
            * intent is to surface, not auto-remediate. Renders only
            * when at least one insight has hits, so the page stays
            * uncluttered on a healthy sub. */}
          {riskInsights.count > 0 && (
            <Card className="border-warning/30 bg-warning/5">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ShieldAlert className="h-4 w-4 text-warning" />
                  Risk insights
                  <Badge variant="warning" className="text-2xs">
                    {riskInsights.count}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  Defender-side pattern matches drawn from the
                  offensive-tooling corpus. Not necessarily malicious —
                  cross-reference each finding with your change-management
                  log before acting.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-xs">
                {riskInsights.crossTenant && selectedSub && account && (
                  <div className="rounded-md border border-warning/40 bg-background p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="warning" className="text-2xs">
                        Cross-tenant
                      </Badge>
                      <span className="font-medium">
                        Subscription lives in a different tenant than the
                        source account.
                      </span>
                    </div>
                    <div className="mt-1 text-2xs text-muted-foreground">
                      Sub tenant{" "}
                      <code className="font-mono">
                        {selectedSub.tenantId.slice(0, 8)}…
                      </code>{" "}
                      vs source-account tenant{" "}
                      <code className="font-mono">
                        {account.tenantId.slice(0, 8)}…
                      </code>
                      . Every mutation here is logged in the sub's tenant
                      audit, not yours. Reference:{" "}
                      <code className="font-mono">
                        _ea_subscription_cross_tenant.md
                      </code>{" "}
                      §1.2 (Microsoft Billing first-party SPN) +{" "}
                      <code className="font-mono">_bypass_tenant_switch.md</code>.
                    </div>
                  </div>
                )}
                {riskInsights.recentOwners.length > 0 && (
                  <div className="rounded-md border border-warning/40 bg-background p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="warning" className="text-2xs">
                        {riskInsights.recentOwners.length} recent Owner
                        {riskInsights.recentOwners.length === 1 ? "" : "s"}
                      </Badge>
                      <span className="font-medium">
                        Owner role granted in the last 24 hours.
                      </span>
                    </div>
                    <ul className="ml-4 mt-1 list-disc text-2xs text-muted-foreground">
                      {riskInsights.recentOwners.slice(0, 3).map((r) => (
                        <li key={r.assignment.id}>
                          {r.principal?.displayName ?? r.assignment.principalId}{" "}
                          ·{" "}
                          {r.assignment.createdOn
                            ? fmtDate(r.assignment.createdOn)
                            : "no createdOn"}
                        </li>
                      ))}
                      {riskInsights.recentOwners.length > 3 && (
                        <li>
                          … and {riskInsights.recentOwners.length - 3} more
                        </li>
                      )}
                    </ul>
                    <div className="mt-1 text-2xs text-muted-foreground">
                      Reference:{" "}
                      <code className="font-mono">_bypass_role_grant.md</code>{" "}
                      (rapid escalation pattern).
                    </div>
                  </div>
                )}
                {riskInsights.unresolvedOwners.length > 0 && (
                  <div className="rounded-md border border-destructive/40 bg-background p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="destructive" className="text-2xs">
                        {riskInsights.unresolvedOwners.length} unresolved
                        Owner
                        {riskInsights.unresolvedOwners.length === 1 ? "" : "s"}
                      </Badge>
                      <span className="font-medium">
                        High-privilege role tied to a principal Graph can't
                        resolve.
                      </span>
                    </div>
                    <ul className="ml-4 mt-1 list-disc text-2xs text-muted-foreground">
                      {riskInsights.unresolvedOwners.slice(0, 3).map((r) => (
                        <li
                          key={r.assignment.id}
                          className="font-mono break-all"
                        >
                          {r.assignment.principalId} ·{" "}
                          {r.assignment.principalType}
                        </li>
                      ))}
                      {riskInsights.unresolvedOwners.length > 3 && (
                        <li>
                          … and {riskInsights.unresolvedOwners.length - 3} more
                        </li>
                      )}
                    </ul>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-2xs text-muted-foreground">
                        Common cause: deleted user / SPN whose Owner grant
                        was never cleaned up. Often safe to remove after
                        spot-checking.
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 text-2xs"
                        onClick={() => {
                          setRoleFilter(AZURE_ROLE_OWNER);
                          setStalenessFilter("unresolved");
                          announce(
                            `Filtered to ${riskInsights.unresolvedOwners.length} unresolved Owner assignments.`,
                          );
                        }}
                      >
                        <Filter className="h-3 w-3" />
                        Filter list to these
                      </Button>
                    </div>
                  </div>
                )}
                {riskInsights.deceptivePrincipals.length > 0 && (
                  <div className="rounded-md border border-warning/40 bg-background p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="warning" className="text-2xs">
                        {riskInsights.deceptivePrincipals.length} blending
                        name
                        {riskInsights.deceptivePrincipals.length === 1
                          ? ""
                          : "s"}
                      </Badge>
                      <span className="font-medium">
                        User principals with backdoor-blending naming.
                      </span>
                    </div>
                    <ul className="ml-4 mt-1 list-disc text-2xs text-muted-foreground">
                      {riskInsights.deceptivePrincipals.slice(0, 3).map((r) => (
                        <li key={r.assignment.id}>
                          {r.principal?.displayName ??
                            r.principal?.signInName ??
                            r.assignment.principalId}{" "}
                          · {r.roleName}
                        </li>
                      ))}
                      {riskInsights.deceptivePrincipals.length > 3 && (
                        <li>
                          … and{" "}
                          {riskInsights.deceptivePrincipals.length - 3} more
                        </li>
                      )}
                    </ul>
                    <div className="mt-1 text-2xs text-muted-foreground">
                      Patterns:{" "}
                      <code className="font-mono">
                        svc-, _sync_, admin-, *backup*, *sync*
                      </code>{" "}
                      — Reference:{" "}
                      <code className="font-mono">
                        _bypass_modify_delete.md
                      </code>{" "}
                      §4.1 (backdoor user with pre-assigned role).
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ----- Filters + actions row --------------------------- */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <Crown className="h-4 w-4 text-primary" />
                Role assignments
                <Badge variant="secondary" className="text-2xs">
                  {filteredRows.length}/{assignments.length}
                </Badge>
                {ownerCount > 0 && (
                  <Badge variant="warning" className="text-2xs">
                    {ownerCount} Owner{ownerCount === 1 ? "" : "s"}
                  </Badge>
                )}
                {roleStats.custom > 0 && (
                  <Badge variant="info" className="text-2xs">
                    {roleStats.custom} custom
                  </Badge>
                )}
                {roleStats.unresolved > 0 && (
                  <Badge variant="destructive" className="text-2xs">
                    {roleStats.unresolved} unresolved
                  </Badge>
                )}
                <span className="ml-auto flex items-center gap-2">
                  <span
                    className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
                    role="group"
                    aria-label="Layout"
                  >
                    <Button
                      type="button"
                      variant={viewMode === "flat" ? "default" : "ghost"}
                      size="icon-sm"
                      className="h-6 w-6"
                      onClick={() => changeViewMode("flat")}
                      aria-label="Flat list layout"
                      title="Flat list"
                    >
                      <ListChecks className="h-3 w-3" />
                    </Button>
                    <Button
                      type="button"
                      variant={viewMode === "grouped" ? "default" : "ghost"}
                      size="icon-sm"
                      className="h-6 w-6"
                      onClick={() => changeViewMode("grouped")}
                      aria-label="Grouped-by-role layout"
                      title="Group by role"
                    >
                      <Layers className="h-3 w-3" />
                    </Button>
                  </span>
                  <ExportMenu
                    rows={filteredRows}
                    columns={roleAssignmentExportColumns}
                    filename={`role-assignments-${subscriptionId.slice(0, 8)}`}
                    label="Export"
                    jsonMetadata={{
                      subscriptionId,
                      subscriptionName: selectedSub?.displayName,
                      tenantId: selectedSub?.tenantId,
                      generatedAt: new Date().toISOString(),
                      totalAssignments: assignments.length,
                      filteredCount: filteredRows.length,
                      ownerCount,
                      customRoleCount: roleStats.custom,
                      filtersApplied: {
                        search: search || undefined,
                        roleFilter,
                        typeFilter,
                        scopeFilter,
                        kindFilter,
                        stalenessFilter,
                        sortKey,
                      },
                    }}
                  />
                </span>
              </CardTitle>
              <CardDescription>
                Direct assignments at this subscription scope are
                deletable; inherited rows (from management group /
                tenant) are shown but locked. Press{" "}
                <kbd className="rounded border px-1 text-2xs">/</kbd> to
                jump to search.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                <div className="relative sm:col-span-2">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    ref={searchRef}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name, UPN, object id, description…"
                    className="pl-8 pr-8 text-xs"
                    aria-label="Search role assignments"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label="Clear search"
                      title="Clear search"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <Select value={roleFilter} onValueChange={setRoleFilter}>
                  <SelectTrigger className="text-xs">
                    <SelectValue placeholder="Role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any role</SelectItem>
                    {rolesPresent.map(([id, name]) => (
                      <SelectItem key={id} value={id}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="text-xs">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    {PRINCIPAL_TYPE_FILTERS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Scope
                  <InfoTooltip
                    size={12}
                    content="Where the assignment was actually created. ‘At this scope’ assignments are deletable; ‘inherited’ rows come from a management group or tenant scope and must be deleted there."
                  />
                </span>
                <Button
                  type="button"
                  variant={scopeFilter === "all" ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setScopeFilter("all")}
                >
                  All
                </Button>
                <Button
                  type="button"
                  variant={scopeFilter === "at-scope" ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setScopeFilter("at-scope")}
                >
                  <ArrowDownToLine className="h-3 w-3" />
                  At this scope
                </Button>
                <Button
                  type="button"
                  variant={scopeFilter === "inherited" ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setScopeFilter("inherited")}
                >
                  <ArrowUpFromLine className="h-3 w-3" />
                  Inherited
                </Button>
                <span className="mx-1 h-4 w-px bg-border" aria-hidden />
                <span className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Kind
                  <InfoTooltip
                    size={12}
                    content="Filter by the role definition's type. Built-in roles ship with Azure (Owner, Contributor, …). Custom roles are defined in the tenant or subscription itself."
                  />
                </span>
                <Button
                  type="button"
                  variant={kindFilter === "all" ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setKindFilter("all")}
                >
                  Any
                </Button>
                <Button
                  type="button"
                  variant={kindFilter === "builtin" ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setKindFilter("builtin")}
                >
                  Built-in
                </Button>
                <Button
                  type="button"
                  variant={kindFilter === "custom" ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setKindFilter("custom")}
                >
                  Custom
                </Button>
                <span className="mx-1 h-4 w-px bg-border" aria-hidden />
                <span className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Resolve
                  <InfoTooltip
                    size={12}
                    content="‘Unresolved’ rows are principal GUIDs that Graph couldn't expand to a display name. Common causes: deleted users, tenant-deleted SPNs, or guests from a tenant you can't read. Often safe to clean up after spot-checking the GUID."
                  />
                </span>
                <Button
                  type="button"
                  variant={stalenessFilter === "all" ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setStalenessFilter("all")}
                >
                  Any
                </Button>
                <Button
                  type="button"
                  variant={
                    stalenessFilter === "resolved" ? "default" : "ghost"
                  }
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setStalenessFilter("resolved")}
                >
                  <Eye className="h-3 w-3" />
                  Resolved
                </Button>
                <Button
                  type="button"
                  variant={
                    stalenessFilter === "unresolved" ? "default" : "ghost"
                  }
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setStalenessFilter("unresolved")}
                >
                  <EyeOff className="h-3 w-3" />
                  Unresolved
                </Button>

                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {hasActiveFilters && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={clearAllFilters}
                      aria-label="Clear all filters"
                    >
                      <Filter className="h-3 w-3" />
                      Clear filters
                    </Button>
                  )}
                  <span
                    className="flex items-center gap-1"
                    aria-label="Sort"
                  >
                    <ArrowUpDown
                      className="h-3 w-3 text-muted-foreground"
                      aria-hidden
                    />
                    <Select
                      value={sortKey}
                      onValueChange={(v) => setSortKey(v as SortKey)}
                    >
                      <SelectTrigger className="h-7 w-auto text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="name">Name (A → Z)</SelectItem>
                        <SelectItem value="name-desc">Name (Z → A)</SelectItem>
                        <SelectItem value="role">Role (Owners first)</SelectItem>
                        <SelectItem value="role-desc">Role (Z → A)</SelectItem>
                        <SelectItem value="type">Type</SelectItem>
                        <SelectItem value="scope">Scope (direct first)</SelectItem>
                        <SelectItem value="created">Created (newest)</SelectItem>
                      </SelectContent>
                    </Select>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={selectAllDeletable}
                    disabled={filteredRows.length === 0}
                  >
                    Select all deletable
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={clearSelection}
                    disabled={selected.size === 0}
                  >
                    Clear
                  </Button>
                  {myRows.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={removeMe}
                    >
                      <LogOut className="h-3 w-3" />
                      Remove me ({myRows.length})
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setConfirmOpen(true)}
                    disabled={deleteDisabled}
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete {selected.size > 0 ? `(${selected.size})` : ""}
                  </Button>
                </span>
              </div>

              {listLoading ? (
                <SkeletonLoader variant="list" rows={4} />
              ) : listError ? (
                <ErrorState
                  size="compact"
                  message="Failed to load role assignments."
                  detail={listError}
                  onRetry={reload}
                  retryLabel="Retry"
                />
              ) : filteredRows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center text-xs text-muted-foreground">
                  <p>
                    {assignments.length === 0
                      ? "No role assignments at this scope."
                      : "No matching role assignments."}
                  </p>
                  {hasActiveFilters && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={clearAllFilters}
                    >
                      <Filter className="h-3 w-3" />
                      Clear filters
                    </Button>
                  )}
                </div>
              ) : viewMode === "grouped" ? (
                <GroupedAssignmentsList
                  rows={filteredRows}
                  selfPrincipalId={selfPrincipalId}
                  selected={selected}
                  getToggleSelect={getToggleSelect}
                  collapsedGroups={collapsedGroups}
                  onToggleGroup={toggleGroup}
                  deleting={deleting}
                  roleKindById={roleKindById}
                />
              ) : (
                <ul className="flex flex-col gap-1">
                  {filteredRows.map((r) => (
                    <AssignmentRow
                      key={r.assignment.id}
                      row={r}
                      isSelf={
                        !!selfPrincipalId &&
                        r.assignment.principalId === selfPrincipalId
                      }
                      isChecked={selected.has(r.assignment.id)}
                      onToggleSelect={getToggleSelect(r.assignment.id)}
                      deleting={deleting}
                      isCustomRole={
                        roleKindById.get(r.assignment.roleDefinitionId) ===
                        "CustomRole"
                      }
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ----- Bulk-delete confirmation dialog -----------------------
        * Groups the preview list by role name so a 30-row delete reads
        * as "5 Owner, 12 Contributor, 13 Reader" — much easier to spot
        * an accidental selection than a scrolling flat list. */}
      <ConfirmationDialog
        hidden={!confirmOpen}
        title={`Delete ${selectedRowsObjects.length} role assignment${
          selectedRowsObjects.length === 1 ? "" : "s"
        }?`}
        danger
        loading={deleting}
        confirmText={deleting ? "Deleting…" : "Delete"}
        cancelText="Cancel"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void performDelete()}
        message={
          <div className="flex flex-col gap-2 text-xs">
            <p>This removes the selected role assignments at scope:</p>
            <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-2xs">
              /subscriptions/{encodeURIComponent(subscriptionId)}
            </code>
            {selectedTouchesSelf && (
              <Alert variant="destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                <AlertDescription>
                  One or more selected rows belong to you. After delete
                  you may lose access to this subscription.
                </AlertDescription>
              </Alert>
            )}
            {wouldRemoveLastOwner && (
              <Alert variant="destructive">
                <ShieldOff className="h-3.5 w-3.5" />
                <AlertDescription>
                  This removes every remaining Owner at this scope. The
                  subscription will be left with no Owner — only a
                  higher-scope role assignment (mgmt group / tenant) can
                  reach it after.
                </AlertDescription>
              </Alert>
            )}
            <DeletePreview rows={selectedRowsObjects} />
          </div>
        }
      />
        </>
      )}
    </div>
  );
};

// =========================================================================
//  EA Department management tab
// =========================================================================

/**
 * Tiny shared hook — acquires an ARM token for the picked account and
 * loads EA billing accounts. Used by both EA tabs (Departments + Grant).
 *
 * Account + billing-account selection are URL-synced via `?ba_account=`
 * and `?ba=` so deep-links into a specific BA are shareable. The two
 * EA tabs sharing this hook means switching tabs preserves the BA the
 * operator was looking at.
 *
 * Race protection: `listEaBillingAccounts` is wrapped in a
 * cancel-on-rerun guard so flipping the source account mid-fetch
 * doesn't race the older response into the picker.
 */
function useBillingAccountPicker(
  azureAccounts: SourceAccount[],
  store: ReturnType<typeof useMultiRegionStore>,
) {
  // Seed the URL param from sessionStorage so a fresh tab restores the
  // last-used account; the URL is authoritative afterward.
  const initialAccount = React.useMemo<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_ACCOUNT) ?? "";
    } catch {
      return "";
    }
  }, []);
  const [accountParam, setAccountParam] = useUrlParam(
    "ba_account",
    initialAccount,
    { replace: true },
  );
  const accountId = accountParam;
  const setAccountId = React.useCallback(
    (id: string) => {
      setAccountParam(id);
      try {
        sessionStorage.setItem(STORAGE_ACCOUNT, id);
      } catch {
        /* ignore */
      }
    },
    [setAccountParam],
  );
  React.useEffect(() => {
    if (
      azureAccounts.length > 0 &&
      !azureAccounts.some((a) => a.homeAccountId === accountId)
    ) {
      setAccountId(azureAccounts[0]!.homeAccountId);
    }
  }, [azureAccounts, accountId, setAccountId]);
  const account = React.useMemo(
    () => azureAccounts.find((a) => a.homeAccountId === accountId) ?? null,
    [azureAccounts, accountId],
  );

  const [armToken, setArmToken] = React.useState<string | null>(null);
  const [billingAccounts, setBillingAccounts] = React.useState<EaBillingAccount[]>([]);
  const [baLoading, setBaLoading] = React.useState(false);
  const [baError, setBaError] = React.useState<string | null>(null);
  const initialBa = React.useMemo<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_BA) ?? "";
    } catch {
      return "";
    }
  }, []);
  const [baParam, setBaParam] = useUrlParam("ba", initialBa, {
    replace: true,
  });
  const billingAccountName = baParam;
  const setBillingAccountName = React.useCallback(
    (name: string) => {
      setBaParam(name);
      try {
        sessionStorage.setItem(STORAGE_BA, name);
      } catch {
        /* ignore */
      }
    },
    [setBaParam],
  );

  useAbortableEffect(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    async (signal) => {
      if (!account) {
        setArmToken(null);
        setBillingAccounts([]);
        return;
      }
      setBaLoading(true);
      setBaError(null);
      try {
        // Tenant arg omitted so we pick up the operator's current active
        // tenant (was pinning to account.tenantId / the account's HOME
        // tenant — pre-switch).
        const tok = await getArmTokenForAccount(account.homeAccountId);
        if (signal.aborted) return;
        setArmToken(tok);
        const list = await listEaBillingAccounts(tok);
        if (signal.aborted) return;
        setBillingAccounts(list);
        if (list.length === 1 && billingAccountName !== list[0]!.name) {
          setBillingAccountName(list[0]!.name);
        } else if (
          billingAccountName &&
          !list.some((b) => b.name === billingAccountName)
        ) {
          setBillingAccountName("");
        }
      } catch (err) {
        if (signal.aborted) return;
        setArmToken(null);
        setBaError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal.aborted) setBaLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account?.homeAccountId, account?.tenantId],
  );

  return {
    account,
    accountId,
    setAccountId,
    armToken,
    billingAccounts,
    baLoading,
    baError,
    billingAccountName,
    setBillingAccountName,
    store,
  };
}

const ScopePickers: React.FC<{
  azureAccounts: SourceAccount[];
  accountId: string;
  onAccountChange: (id: string) => void;
  baLoading: boolean;
  baError: string | null;
  billingAccounts: EaBillingAccount[];
  billingAccountName: string;
  onBaChange: (name: string) => void;
}> = ({
  azureAccounts,
  accountId,
  onAccountChange,
  baLoading,
  baError,
  billingAccounts,
  billingAccountName,
  onBaChange,
}) => (
  <Card>
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center gap-2 text-sm">
        <Crown className="h-4 w-4 text-primary" />
        Scope
      </CardTitle>
      <CardDescription>
        Pick a signed-in EA-billing account and the billing account to
        manage.
      </CardDescription>
    </CardHeader>
    <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">Source account</Label>
        <Select value={accountId} onValueChange={onAccountChange}>
          <SelectTrigger>
            <SelectValue placeholder="Pick an account" />
          </SelectTrigger>
          <SelectContent>
            {azureAccounts.map((a) => (
              <SelectItem key={a.homeAccountId} value={a.homeAccountId}>
                <span className="flex flex-col">
                  <span className="text-sm">{a.name}</span>
                  <span className="text-2xs text-muted-foreground">
                    {a.username}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">Billing account</Label>
        {baLoading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> loading…
          </p>
        ) : baError ? (
          <Alert variant="destructive">
            <AlertDescription>{baError}</AlertDescription>
          </Alert>
        ) : billingAccounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No EA billing accounts visible.
          </p>
        ) : (
          <Select value={billingAccountName} onValueChange={onBaChange}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a billing account" />
            </SelectTrigger>
            <SelectContent>
              {billingAccounts.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  <span className="flex flex-col">
                    <span className="text-sm">{b.displayName}</span>
                    <span className="font-mono text-2xs text-muted-foreground">
                      {b.name} · {b.agreementType}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </CardContent>
  </Card>
);

const DepartmentsTab: React.FC<{
  azureAccounts: SourceAccount[];
  store: ReturnType<typeof useMultiRegionStore>;
}> = ({ azureAccounts, store }) => {
  const ctx = useBillingAccountPicker(azureAccounts, store);
  const { account, armToken, billingAccountName } = ctx;

  const [depts, setDepts] = React.useState<EaDepartment[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadTick, setReloadTick] = React.useState(0);
  // Local filter for the dept list. Per-account billing data with
  // hundreds of departments under a tenant is common, so a quick
  // substring filter on display name + cost center cuts noise fast.
  const [deptSearch, setDeptSearch] = React.useState("");
  useAbortableEffect(
    async (signal) => {
      if (!armToken || !billingAccountName) {
        setDepts([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const d = await listEaDepartments(billingAccountName, armToken);
        if (signal.aborted) return;
        setDepts(d);
      } catch (err: unknown) {
        if (signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [armToken, billingAccountName, reloadTick],
  );

  // Filtered + alphabetically-sorted view for the list. Sorting is
  // applied after filtering so the order is deterministic regardless of
  // what ARM happened to return.
  const visibleDepts = React.useMemo(() => {
    const q = deptSearch.trim().toLowerCase();
    const out = depts
      .filter((d) => {
        if (!q) return true;
        const hay = [d.departmentName, d.name, d.costCenter ?? "", d.status ?? ""]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .slice()
      .sort((a, b) => a.departmentName.localeCompare(b.departmentName));
    return out;
  }, [depts, deptSearch]);

  /* Create form */
  const [newName, setNewName] = React.useState("");
  const [newDisplay, setNewDisplay] = React.useState("");
  const [newCostCenter, setNewCostCenter] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const submitCreate = React.useCallback(async () => {
    if (!armToken || !billingAccountName) return;
    if (!newName.trim() || !newDisplay.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await createEaDepartment(
        billingAccountName,
        newName.trim(),
        {
          departmentName: newDisplay.trim(),
          costCenter: newCostCenter.trim() || undefined,
        },
        armToken,
      );
      auditLog.record({
        actor: account?.username ?? "",
        action: "create_ea_department",
        target: newName.trim(),
        status: "success",
        details: { billingAccountName, displayName: newDisplay },
      });
      store.addNotification({
        type: "success",
        message: `Department "${newDisplay}" created.`,
      });
      setNewName("");
      setNewDisplay("");
      setNewCostCenter("");
      setReloadTick((n) => n + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(msg);
      // Failure-path audit so create_ea_department gets both paths.
      auditLog.record({
        actor: account?.username ?? "",
        action: "create_ea_department",
        target: newName.trim(),
        status: "failure",
        error: msg,
        details: { billingAccountName, displayName: newDisplay },
      });
    } finally {
      setSubmitting(false);
    }
  }, [armToken, billingAccountName, newName, newDisplay, newCostCenter, account?.username, store]);

  /* Per-row edit / delete */
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editDisplay, setEditDisplay] = React.useState("");
  const [editCostCenter, setEditCostCenter] = React.useState("");
  const [rowBusy, setRowBusy] = React.useState<string | null>(null);

  const startEdit = (d: EaDepartment) => {
    setEditingId(d.name);
    setEditDisplay(d.departmentName);
    setEditCostCenter(d.costCenter ?? "");
  };

  const submitEdit = async () => {
    if (!editingId || !armToken || !billingAccountName) return;
    setRowBusy(editingId);
    try {
      await updateEaDepartment(
        billingAccountName,
        editingId,
        {
          departmentName: editDisplay.trim() || undefined,
          costCenter: editCostCenter.trim() || undefined,
        },
        armToken,
      );
      auditLog.record({
        actor: account?.username ?? "",
        action: "update_ea_department",
        target: editingId,
        status: "success",
        details: { billingAccountName, displayName: editDisplay, costCenter: editCostCenter },
      });
      store.addNotification({
        type: "success",
        message: `Department "${editDisplay}" updated.`,
      });
      setEditingId(null);
      setReloadTick((n) => n + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Failure-path audit so update_ea_department gets both paths.
      auditLog.record({
        actor: account?.username ?? "",
        action: "update_ea_department",
        target: editingId,
        status: "failure",
        error: msg,
        details: { billingAccountName, displayName: editDisplay, costCenter: editCostCenter },
      });
      store.addNotification({
        type: "error",
        message: msg,
      });
    } finally {
      setRowBusy(null);
    }
  };

  // Department to delete, awaiting confirmation. Replaces window.confirm.
  const [pendingDelete, setPendingDelete] = React.useState<EaDepartment | null>(null);

  const submitDelete = async (d: EaDepartment) => {
    if (!armToken || !billingAccountName) return;
    setPendingDelete(null);
    setRowBusy(d.name);
    try {
      await deleteEaDepartment(billingAccountName, d.name, armToken);
      auditLog.record({
        actor: account?.username ?? "",
        action: "delete_ea_department",
        target: d.name,
        status: "success",
        details: { billingAccountName },
      });
      store.addNotification({
        type: "success",
        message: `Department "${d.departmentName}" deleted.`,
      });
      setReloadTick((n) => n + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Failure-path audit so delete_ea_department gets both paths.
      auditLog.record({
        actor: account?.username ?? "",
        action: "delete_ea_department",
        target: d.name,
        status: "failure",
        error: msg,
        details: { billingAccountName, displayName: d.departmentName },
      });
      store.addNotification({
        type: "error",
        message: msg,
      });
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ScopePickers
        azureAccounts={azureAccounts}
        accountId={ctx.accountId}
        onAccountChange={ctx.setAccountId}
        baLoading={ctx.baLoading}
        baError={ctx.baError}
        billingAccounts={ctx.billingAccounts}
        billingAccountName={ctx.billingAccountName}
        onBaChange={ctx.setBillingAccountName}
      />

      {!billingAccountName ? (
        <EmptyState
          icon={Building2}
          title="Pick a billing account"
          description="Departments under the selected EA billing account will appear here."
        />
      ) : (
        <>
          {/* Create new */}
          <Card className="border-primary/30">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Plus className="h-4 w-4 text-primary" /> Create department
              </CardTitle>
              <CardDescription>
                PUT /billingAccounts/&#123;ba&#125;/departments/&#123;name&#125;
                — name is the URL-segment id, display name and cost center
                are properties on the row.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Name (URL segment) *</Label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="my-dept-001"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Display name *</Label>
                  <Input
                    value={newDisplay}
                    onChange={(e) => setNewDisplay(e.target.value)}
                    placeholder="Engineering"
                    className="text-xs"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Cost center</Label>
                  <Input
                    value={newCostCenter}
                    onChange={(e) => setNewCostCenter(e.target.value)}
                    placeholder="CC-0042"
                    className="text-xs"
                  />
                </div>
              </div>
              {submitError && (
                <Alert variant="destructive">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}
              <div>
                <Button
                  type="button"
                  onClick={() => void submitCreate()}
                  disabled={
                    submitting || !newName.trim() || !newDisplay.trim()
                  }
                  loading={submitting}
                >
                  {!submitting && <Plus />}
                  Create
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* List */}
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Layers className="h-4 w-4 text-primary" /> Existing departments
                  {depts.length > 0 && (
                    <Badge variant="secondary" className="text-2xs">
                      {visibleDepts.length}/{depts.length}
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  Rows are editable inline. Delete will fail if any
                  enrollment accounts still reference the department.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <ExportMenu
                  rows={visibleDepts}
                  columns={[
                    { header: "Display name", accessor: (d) => d.departmentName },
                    { header: "Name (URL segment)", accessor: (d) => d.name },
                    { header: "Cost center", accessor: (d) => d.costCenter ?? "" },
                    { header: "Status", accessor: (d) => d.status ?? "" },
                    { header: "ARM id", accessor: (d) => d.id },
                  ]}
                  filename={`ea-departments-${billingAccountName.slice(0, 12)}`}
                  label="Export"
                  jsonMetadata={{
                    billingAccountName,
                    generatedAt: new Date().toISOString(),
                    totalCount: depts.length,
                    visibleCount: visibleDepts.length,
                    searchApplied: deptSearch || undefined,
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setReloadTick((n) => n + 1)}
                  aria-label="Refresh"
                  disabled={loading}
                >
                  <RefreshCw className={loading ? "animate-spin" : undefined} />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {depts.length > 0 && (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    value={deptSearch}
                    onChange={(e) => setDeptSearch(e.target.value)}
                    placeholder="Search by display name, id, or cost center…"
                    className="pl-8 pr-8 text-xs"
                    aria-label="Search departments"
                  />
                  {deptSearch && (
                    <button
                      type="button"
                      onClick={() => setDeptSearch("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label="Clear search"
                      title="Clear search"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
              {loading ? (
                <SkeletonLoader variant="list" rows={3} />
              ) : error ? (
                <ErrorState
                  size="compact"
                  message="Failed to load departments."
                  detail={error}
                  onRetry={() => setReloadTick((n) => n + 1)}
                  retryLabel="Retry"
                />
              ) : depts.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No departments under this billing account.
                </p>
              ) : visibleDepts.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-muted-foreground">
                  <p>No departments match "{deptSearch}".</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setDeptSearch("")}
                  >
                    Clear search
                  </Button>
                </div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {visibleDepts.map((d) => {
                    const editing = editingId === d.name;
                    const busy = rowBusy === d.name;
                    return (
                      <li
                        key={d.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
                      >
                        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                        {editing ? (
                          <>
                            <Input
                              value={editDisplay}
                              onChange={(e) => setEditDisplay(e.target.value)}
                              className="h-7 w-48 text-xs"
                              disabled={busy}
                            />
                            <Input
                              value={editCostCenter}
                              onChange={(e) => setEditCostCenter(e.target.value)}
                              className="h-7 w-32 text-xs"
                              placeholder="cost center"
                              disabled={busy}
                            />
                            <Button
                              type="button"
                              size="sm"
                              className="h-6 text-2xs"
                              onClick={() => void submitEdit()}
                              disabled={busy}
                            >
                              {busy ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Check className="h-3 w-3" />
                              )}
                              Save
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 text-2xs"
                              onClick={() => setEditingId(null)}
                              disabled={busy}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className="font-medium">{d.departmentName}</span>
                            <CopyableText
                              value={d.name}
                              mono
                              ariaLabel={`Copy department id ${d.name}`}
                              className="text-muted-foreground"
                            />
                            {d.costCenter && (
                              <Badge variant="secondary" className="text-2xs">
                                CC: {d.costCenter}
                              </Badge>
                            )}
                            {d.status && (
                              <Badge variant="outline" className="text-2xs">
                                {d.status}
                              </Badge>
                            )}
                            <span className="ml-auto flex items-center gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-6 text-2xs"
                                onClick={() => startEdit(d)}
                                disabled={busy}
                              >
                                <Edit3 className="h-3 w-3" /> Edit
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-6 text-2xs text-destructive"
                                onClick={() => setPendingDelete(d)}
                                disabled={busy}
                                aria-label={`Delete department ${d.departmentName}`}
                              >
                                {busy ? (
                                  <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                                Delete
                              </Button>
                            </span>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {/* Replaces native window.confirm — destructive department delete. */}
      <ConfirmationDialog
        hidden={!pendingDelete}
        title="Delete department"
        message={
          pendingDelete
            ? `Delete department "${pendingDelete.departmentName}"? Enrollment accounts under it must be re-parented first; Azure will reject if any remain.`
            : ""
        }
        confirmText="Delete"
        danger
        loading={!!pendingDelete && rowBusy === pendingDelete.name}
        onConfirm={() => pendingDelete && void submitDelete(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

// =========================================================================
//  Grant Subscription Creator tab
// =========================================================================

const GrantSubCreatorTab: React.FC<{
  azureAccounts: SourceAccount[];
  store: ReturnType<typeof useMultiRegionStore>;
  // Path-based navigator from page-router outlet context. Required for
  // the "Retry creating EA Sub now" pivot card; the previous version
  // referenced an out-of-scope `navigate` symbol from `SubManagerPage`'s
  // closure, which would have ReferenceError'd at runtime on click.
  navigateToPage?: (path: string) => void;
}> = ({ azureAccounts, store, navigateToPage }) => {
  const ctx = useBillingAccountPicker(azureAccounts, store);
  const { account, armToken, billingAccountName } = ctx;

  /* Enrollment accounts list */
  const [eas, setEas] = React.useState<EaEnrollmentAccount[]>([]);
  const [eaLoading, setEaLoading] = React.useState(false);
  const [eaError, setEaError] = React.useState<string | null>(null);
  useAbortableEffect(
    async (signal) => {
      if (!armToken || !billingAccountName) {
        setEas([]);
        return;
      }
      setEaLoading(true);
      setEaError(null);
      try {
        const list = await listEnrollmentAccounts(billingAccountName, armToken);
        if (signal.aborted) return;
        setEas(list);
      } catch (err: unknown) {
        if (signal.aborted) return;
        setEaError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal.aborted) setEaLoading(false);
      }
    },
    [armToken, billingAccountName],
  );

  const [eaName, setEaName] = React.useState("");
  React.useEffect(() => {
    if (eas.length > 0 && !eas.some((e) => e.name === eaName)) {
      setEaName(eas[0]!.name);
    }
  }, [eas, eaName]);

  // Filter the enrollment-accounts picker by display-name substring.
  // Helpful for tenants with hundreds of EAs — also helps the operator
  // confirm the right one is picked before granting.
  const [eaSearch, setEaSearch] = React.useState("");
  const visibleEas = React.useMemo(() => {
    const q = eaSearch.trim().toLowerCase();
    if (!q) return eas;
    return eas.filter((e) => {
      const hay = [e.displayName, e.name, e.accountOwner ?? ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [eas, eaSearch]);

  /* Principal input — UPN/email (Graph lookup) or raw object id */
  const [principalInput, setPrincipalInput] = React.useState("");
  const [principalTenantId, setPrincipalTenantId] = React.useState("");
  // Default principalTenantId to the source account's tenant.
  React.useEffect(() => {
    if (account && !principalTenantId) {
      setPrincipalTenantId(account.tenantId);
    }
  }, [account, principalTenantId]);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  /**
   * Tracks the last successful grant — feeds the "Retry creating EA
   * Sub now" pivot card so the operator goes from "got the role" to
   * "make the subscription" in one click without re-picking the BA/EA
   * pickers. Resets on any subsequent attempt.
   */
  const [lastGrant, setLastGrant] = React.useState<{
    homeAccountId: string;
    billingAccountName: string;
    enrollmentAccountName: string;
    principal: string;
    grantedAt: number;
  } | null>(null);
  /**
   * Session-local trail of recent grants (newest first, capped at 5).
   * Useful in batch onboarding workflows where the operator grants the
   * same role to a handful of people back-to-back and wants a quick
   * "did I actually get to Bob?" sanity check without diving into the
   * audit log page.
   */
  const [recentGrants, setRecentGrants] = React.useState<
    {
      principal: string;
      enrollmentAccountName: string;
      grantedAt: number;
      roleAssignmentId: string;
    }[]
  >([]);

  const submit = React.useCallback(async () => {
    if (!armToken || !billingAccountName || !eaName) return;
    if (!principalInput.trim() || !principalTenantId.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    setLastGrant(null);
    try {
      const guidRe =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let principalObjectId = principalInput.trim();
      if (!guidRe.test(principalObjectId)) {
        // Graph lookup in the principal's own tenant.
        const graphToken = await getGraphTokenForAccount(
          account!.homeAccountId,
          principalTenantId.trim(),
        );
        const found = await findUserByUpnOrMail(
          principalTenantId.trim(),
          principalObjectId,
          graphToken,
        );
        if (!found) {
          throw new Error(
            `No user found in tenant ${principalTenantId.trim()} matching "${principalInput}". Paste the user's object id instead.`,
          );
        }
        principalObjectId = found.id;
      }
      const r = await createEnrollmentAccountRoleAssignment(
        billingAccountName,
        eaName,
        principalObjectId,
        principalTenantId.trim(),
        ROLE_EA_SUBSCRIPTION_CREATOR,
        armToken,
      );
      auditLog.record({
        actor: account?.username ?? "",
        action: "grant_ea_subscription_creator",
        target: principalObjectId,
        status: "success",
        details: {
          billingAccountName,
          enrollmentAccountName: eaName,
          principalTenantId: principalTenantId.trim(),
          roleAssignmentId: r.id,
        },
      });
      store.addNotification({
        type: "success",
        message: `Granted EA Subscription Creator to ${principalInput} on enrollment account ${eaName}.`,
      });
      // Record the successful grant — drives the inline "Retry creating
      // EA Sub now" pivot card right below the form.
      if (account) {
        setLastGrant({
          homeAccountId: account.homeAccountId,
          billingAccountName,
          enrollmentAccountName: eaName,
          principal: principalInput.trim(),
          grantedAt: Date.now(),
        });
      }
      // Push onto the session-local recent-grants trail (newest first,
      // dedup by principal+EA, cap at 5 to keep the panel readable).
      setRecentGrants((prev) => {
        const next = [
          {
            principal: principalInput.trim(),
            enrollmentAccountName: eaName,
            grantedAt: Date.now(),
            roleAssignmentId: r.id,
          },
          ...prev.filter(
            (g) =>
              !(
                g.principal === principalInput.trim() &&
                g.enrollmentAccountName === eaName
              ),
          ),
        ];
        return next.slice(0, 5);
      });
      setPrincipalInput("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(msg);
      // Failure-path audit so grant_ea_subscription_creator gets both paths.
      auditLog.record({
        actor: account?.username ?? "",
        action: "grant_ea_subscription_creator",
        target: principalInput.trim(),
        status: "failure",
        error: msg,
        details: {
          billingAccountName,
          enrollmentAccountName: eaName,
          principalTenantId: principalTenantId.trim(),
        },
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    armToken,
    billingAccountName,
    eaName,
    principalInput,
    principalTenantId,
    account,
    store,
  ]);

  return (
    <div className="flex flex-col gap-3">
      <ScopePickers
        azureAccounts={azureAccounts}
        accountId={ctx.accountId}
        onAccountChange={ctx.setAccountId}
        baLoading={ctx.baLoading}
        baError={ctx.baError}
        billingAccounts={ctx.billingAccounts}
        billingAccountName={ctx.billingAccountName}
        onBaChange={ctx.setBillingAccountName}
      />
      {!billingAccountName ? (
        <EmptyState
          icon={Building2}
          title="Pick a billing account"
          description="Enrollment accounts and the EA Subscription Creator grant form will appear here."
        />
      ) : (
        <Card className="border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-primary" /> Grant EA
              Subscription Creator
            </CardTitle>
            <CardDescription>
              Gives a user the right to create new subscriptions under one
              enrollment account. Calls{" "}
              <code className="font-mono text-2xs">
                PUT /enrollmentAccounts/&#123;ea&#125;/billingRoleAssignments
              </code>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  Enrollment account *{" "}
                  {eas.length > 0 && (
                    <span className="font-normal text-2xs text-muted-foreground">
                      ({visibleEas.length}/{eas.length})
                    </span>
                  )}
                </Label>
                {eas.length > 0 && (
                  <ExportMenu
                    rows={visibleEas}
                    columns={[
                      { header: "Display name", accessor: (e) => e.displayName },
                      { header: "Name", accessor: (e) => e.name },
                      {
                        header: "Account owner",
                        accessor: (e) => e.accountOwner ?? "",
                      },
                      { header: "ARM id", accessor: (e) => e.id },
                    ]}
                    filename={`enrollment-accounts-${billingAccountName.slice(0, 12)}`}
                    label="Export"
                    jsonMetadata={{
                      billingAccountName,
                      generatedAt: new Date().toISOString(),
                      totalCount: eas.length,
                      visibleCount: visibleEas.length,
                      searchApplied: eaSearch || undefined,
                    }}
                  />
                )}
              </div>
              {eas.length > 6 && (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    value={eaSearch}
                    onChange={(e) => setEaSearch(e.target.value)}
                    placeholder="Filter enrollment accounts…"
                    className="pl-8 pr-8 text-xs"
                    aria-label="Search enrollment accounts"
                  />
                  {eaSearch && (
                    <button
                      type="button"
                      onClick={() => setEaSearch("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label="Clear search"
                      title="Clear search"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
              {eaLoading ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" /> loading
                </p>
              ) : eaError ? (
                <ErrorState
                  size="compact"
                  message="Failed to load enrollment accounts."
                  detail={eaError}
                />
              ) : eas.length === 0 ? (
                <EmptyState
                  icon={Sparkles}
                  title="No enrollment accounts"
                  description="No enrollment accounts visible under this billing account. Verify the source account has EA reader rights at the billing scope."
                  className="py-4"
                />
              ) : visibleEas.length === 0 ? (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  No enrollment accounts match "{eaSearch}".
                </p>
              ) : (
                <Select value={eaName} onValueChange={setEaName}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick an enrollment account" />
                  </SelectTrigger>
                  <SelectContent>
                    {visibleEas.map((e) => (
                      <SelectItem key={e.name} value={e.name}>
                        <span className="flex flex-col">
                          <span className="text-sm">{e.displayName}</span>
                          <span className="font-mono text-2xs text-muted-foreground">
                            {e.name}
                            {e.accountOwner ? ` · ${e.accountOwner}` : ""}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">User UPN / email or object id *</Label>
                <Input
                  value={principalInput}
                  onChange={(e) => {
                    setPrincipalInput(e.target.value);
                    setSubmitError(null);
                  }}
                  placeholder="alice@contoso.com  OR  11111111-2222-…"
                  className="font-mono text-xs"
                  disabled={submitting}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1 text-xs">
                  Principal tenant id *
                  <InfoTooltip
                    size={12}
                    content="The tenant the recipient identity actually lives in. EA billing role assignments require this even for cross-tenant guests — otherwise ARM refuses the PUT with PrincipalNotFound."
                  />
                </Label>
                <Input
                  value={principalTenantId}
                  onChange={(e) => setPrincipalTenantId(e.target.value)}
                  placeholder="tenant guid the user belongs to"
                  className="font-mono text-xs"
                  disabled={submitting}
                />
                <p className="text-2xs text-muted-foreground">
                  Defaults to the source account's tenant. Override when the
                  recipient is a guest from a different tenant.
                </p>
              </div>
            </div>
            {submitError && (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}
            <div>
              <Button
                type="button"
                onClick={() => void submit()}
                disabled={
                  submitting ||
                  !eaName ||
                  !principalInput.trim() ||
                  !principalTenantId.trim()
                }
                loading={submitting}
              >
                {!submitting && <UserPlus />}
                Grant EA Subscription Creator
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {/* ─────────────────────────────────────────────────────────────
        * Cross-page pivot: after a successful grant, surface a single
        * "Retry creating EA Sub now" card. Pre-seeds the EA Sub Quick
        * page's sessionStorage with the same BA / EA / account so the
        * operator doesn't have to re-pick everything. Idempotent —
        * the grant remains in place; clicking just navigates.
        * ───────────────────────────────────────────────────────── */}
      {lastGrant && (
        <Card className="border-success/40 bg-success/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-success" />
              Grant succeeded — next step
            </CardTitle>
            <CardDescription className="text-xs">
              <code className="font-mono">{lastGrant.principal}</code> now
              has EA Subscription Creator on enrollment account{" "}
              <code className="font-mono">
                {lastGrant.enrollmentAccountName}
              </code>
              . Note: EA role propagation can take up to 5 minutes after
              a fresh token is issued — if Create still 401s on EA Sub
              Quick, wait briefly and click "Re-acquire token" there.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                // Pre-seed EA Sub Quick's sessionStorage so the BA /
                // EA / account picker is restored on mount. Best-
                // effort — falls through silently if storage is
                // unavailable (private browsing).
                try {
                  sessionStorage.setItem(
                    "ea-sub-quick:account",
                    lastGrant.homeAccountId,
                  );
                  sessionStorage.setItem(
                    "ea-sub-quick:billing-account",
                    lastGrant.billingAccountName,
                  );
                  sessionStorage.setItem(
                    "ea-sub-quick:enrollment-account",
                    lastGrant.enrollmentAccountName,
                  );
                } catch {
                  /* ignore */
                }
                // Path-based navigation (page-router contract). Falls back
                // to a no-op if the outlet didn't provide a navigator —
                // sessionStorage was still seeded so a manual sidebar nav
                // works too.
                navigateToPage?.("/ea-sub-quick");
              }}
              aria-label="Retry creating EA subscription on EA Sub Quick"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Retry creating EA Sub now
            </Button>
          </CardContent>
        </Card>
      )}
      {/* Recent-grants trail — session-only history of who-got-what.
        * Persists across grants but resets on page refresh. */}
      {recentGrants.length > 0 && billingAccountName && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <UserPlus className="h-4 w-4 text-primary" />
              Recent grants this session
              <Badge variant="secondary" className="text-2xs">
                {recentGrants.length}
              </Badge>
            </CardTitle>
            <CardDescription className="text-xs">
              Newest first, kept in memory only (cleared on refresh).
              Full mutation history is in the Audit Log page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1">
              {recentGrants.map((g) => (
                <li
                  key={`${g.principal}-${g.enrollmentAccountName}-${g.grantedAt}`}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
                >
                  <UserPlus className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-mono">{g.principal}</span>
                    <span className="text-2xs text-muted-foreground">
                      EA: {g.enrollmentAccountName} ·{" "}
                      {new Date(g.grantedAt).toLocaleTimeString()}
                    </span>
                  </span>
                  <CopyableText
                    value={g.roleAssignmentId}
                    mono
                    ariaLabel="Copy role assignment id"
                    className="text-2xs text-muted-foreground"
                  />
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setRecentGrants([])}
              >
                <X className="h-3 w-3" />
                Clear history
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

