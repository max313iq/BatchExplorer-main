/** Main left-rail navigation. Drives URL routing and shows per-account capability badges. */
import * as React from "react";
import {
  Activity as ActivityIcon,
  BadgeCheck,
  Boxes,
  Calculator,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Cpu,
  FileCheck,
  Gauge,
  Grid3x3,
  Handshake,
  History,
  KeyRound,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  Mail,
  Network,
  PiggyBank,
  Server,
  ServerCog,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  User,
  UserPlus,
  Users,
  Wallet,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { cn } from "@/lib/utils";
import { useMultiRegionState } from "../../store/store-context";
import {
  getGraphTokenForAccount,
  getActiveTenant,
} from "../../auth/msal-auth";
import {
  canCreateUsers,
  canResetPasswords,
  getMyDirectoryRoles,
} from "../../services/graph-service";
import { getEaCapabilityCached } from "../../services/ea-capability-cache";
import { taskRuntime } from "../../store/task-runtime";
import { PAGE_ORDER, pageKeyToPath } from "../page-router";

export type PageKey =
  | "azure-accounts"
  | "overview"
  | "accounts"
  | "pools"
  | "pool-defaults"
  | "pool-info"
  | "account-info"
  | "unused-quota"
  | "monitoring"
  | "nodes"
  | "gpu-calculator"
  | "tenant-users"
  | "mfa-manager"
  | "user-creator"
  | "invite-user"
  | "sub-manager"
  | "ea-billing-manager"
  | "resource-manager"
  | "sub-mover"
  | "token-importer"
  | "department-admin"
  | "legacy-ea-sub"
  | "ea-sub-quick"
  | "ea-creator-pregrant"
  | "ea-subscription"
  | "partner-center"
  | "role-graph"
  | "security-audit"
  | "privileged-audit"
  | "tenant-baseline"
  | "tricky-login"
  | "audience-matrix"
  | "audit-log"
  | "tasks"
  | "throttle"
  | "vm-catalog";

interface NavItem {
  key: PageKey;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

type GroupKey = "identity" | "compute" | "billing" | "diag";

interface NavGroup {
  key: GroupKey;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

export interface SidebarNavProps {
  activeKey: PageKey;
  onNavigate: (key: PageKey) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * Per-account capability probe. Resolves three boolean capabilities
 * for every signed-in azureAccount, by querying directory roles via
 * Graph and EA-billing-account access via ARM. Failures degrade
 * silently to `false` so the sidebar never blocks on a permission
 * error. Results are cached for the SidebarNav component lifetime;
 * the effect re-runs only when the account-set membership changes.
 */
interface AccountCapabilities {
  passwordReset: boolean;
  createUser: boolean;
  ea: boolean;
}

const EMPTY_CAP: AccountCapabilities = {
  passwordReset: false,
  createUser: false,
  ea: false,
};

function useAccountCapabilityMap(
  azureAccounts: ReadonlyArray<{ homeAccountId: string; tenantId: string }>,
): Record<string, AccountCapabilities> {
  const [map, setMap] = React.useState<Record<string, AccountCapabilities>>({});

  const accountKey = React.useMemo(
    () =>
      azureAccounts
        .map((a) => `${a.homeAccountId}|${a.tenantId}`)
        .sort()
        .join(","),
    [azureAccounts],
  );

  React.useEffect(() => {
    let cancelled = false;
    // Stream results in per-account-completion so a slow account never
    // holds up the badges for the others.
    for (const a of azureAccounts) {
      if (!a.homeAccountId) continue;
      const tenantId = getActiveTenant(a.homeAccountId) ?? a.tenantId;
      if (!tenantId) {
        setMap((prev) => ({ ...prev, [a.homeAccountId]: EMPTY_CAP }));
        continue;
      }
      void (async () => {
        // Run Graph + ARM probes in parallel. Any failure → false.
        // EA probe goes through a session-wide cache so the EA-subscription
        // page can reuse the same result without re-hitting the billing
        // API on navigation.
        const [graphRoles, eaCap] = await Promise.all([
          (async () => {
            try {
              const token = await getGraphTokenForAccount(
                a.homeAccountId,
                tenantId,
              );
              return await getMyDirectoryRoles(tenantId, token);
            } catch {
              return null;
            }
          })(),
          (async () => {
            try {
              return await getEaCapabilityCached(a.homeAccountId, tenantId);
            } catch {
              return null;
            }
          })(),
        ]);
        if (cancelled) return;
        setMap((prev) => ({
          ...prev,
          [a.homeAccountId]: {
            passwordReset: graphRoles ? canResetPasswords(graphRoles) : false,
            createUser: graphRoles ? canCreateUsers(graphRoles) : false,
            ea: eaCap?.hasEa ?? false,
          },
        }));
      })();
    }
    return () => {
      cancelled = true;
    };
    // azureAccounts identity changes per-render; accountKey captures
    // membership changes that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey]);

  return map;
}

/**
 * Live counter of tasks in `running` + `interrupted` state. Drives the
 * sidebar's "Tasks" badge and lets the user spot stalled runs from any
 * page in one glance.
 */
function useTaskBadgeCount(): number {
  const [count, setCount] = React.useState<number>(() =>
    taskRuntime
      .list()
      .filter((t) => t.status === "running" || t.status === "interrupted")
      .length,
  );
  React.useEffect(
    () =>
      taskRuntime.subscribe((tasks) =>
        setCount(
          tasks.filter(
            (t) => t.status === "running" || t.status === "interrupted",
          ).length,
        ),
      ),
    [],
  );
  return count;
}

/* ─────────────────────────────────────────────────────────────────────
 * Group-collapse persistence. State is per-group, stored as a Set of
 * group keys that are currently collapsed. Default is "everything
 * expanded" (empty set) so first-time users see the full nav.
 * ───────────────────────────────────────────────────────────────────── */

const COLLAPSED_GROUPS_KEY = "azbm.sidebar.collapsed-groups.v1";

function readCollapsedGroups(): Set<GroupKey> {
  try {
    if (typeof window === "undefined") return new Set();
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(
      arr.filter(
        (k): k is GroupKey =>
          k === "identity" || k === "compute" || k === "billing" || k === "diag",
      ),
    );
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(keys: Set<GroupKey>): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      COLLAPSED_GROUPS_KEY,
      JSON.stringify(Array.from(keys)),
    );
  } catch {
    // localStorage may be unavailable (Safari private mode etc.) — ignore.
  }
}

/** Sum badges in a group for the collapsed-header indicator. */
function groupBadgeTotal(group: NavGroup): number {
  let total = 0;
  for (const item of group.items) {
    if (item.badge != null && item.badge > 0) total += item.badge;
  }
  return total;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({
  activeKey,
  onNavigate,
  collapsed,
  onToggleCollapse,
}) => {
  const navigate = useNavigate();
  const state = useMultiRegionState();
  const azureAccounts = state.azureAccounts ?? [];
  const capMap = useAccountCapabilityMap(azureAccounts);
  const taskBadge = useTaskBadgeCount();
  // Count circuits in non-healthy state (open + probing). A live signal
  // operators can see at a glance from any page.
  const throttleBadge = React.useMemo(() => {
    const map = state.throttleStats?.perSubscription ?? {};
    let n = 0;
    for (const k in map) {
      const s = map[k]?.state;
      if (s === "open" || s === "half_open") n++;
    }
    return n;
  }, [state.throttleStats]);
  const capCounts = React.useMemo(() => {
    let pwd = 0;
    let create = 0;
    let ea = 0;
    for (const c of Object.values(capMap)) {
      if (c.passwordReset) pwd++;
      if (c.createUser) create++;
      if (c.ea) ea++;
    }
    return { passwordReset: pwd, createUser: create, ea };
  }, [capMap]);

  /* ───────────────────────────────────────────────────────────────────
   * Group definitions. Each group is a logical task area; items within
   * a group are ordered most-frequently-used first. Conditional items
   * (Tenant Users, gated by passwordReset capability) slot in beside
   * their permanent siblings.
   * ─────────────────────────────────────────────────────────────────── */
  const groups: NavGroup[] = React.useMemo(() => {
    // ── Identity & users ─────────────────────────────────────────────
    const identity: NavItem[] = [
      {
        key: "azure-accounts" as PageKey,
        label: "Azure Accounts",
        icon: User,
        badge: azureAccounts.length,
      },
      {
        key: "token-importer" as PageKey,
        label: "Import Token",
        icon: KeyRound,
      },
    ];
    if (capCounts.passwordReset > 0) {
      identity.push({
        key: "tenant-users" as PageKey,
        label: "Tenant Users",
        icon: Users,
        badge: capCounts.passwordReset,
      });
    }
    // MFA Manager — manage authentication methods for the operator's OWN
    // signed-in accounts as well as a target user. Always available (self
    // reads need no admin role), so it isn't gated on a capability count.
    identity.push({
      key: "mfa-manager" as PageKey,
      label: "MFA Manager",
      icon: ShieldCheck,
    });
    identity.push({
      key: "user-creator" as PageKey,
      label: "Create User",
      icon: UserPlus,
      badge: capCounts.createUser > 0 ? capCounts.createUser : undefined,
    });
    identity.push({
      key: "invite-user" as PageKey,
      label: "Invite User",
      icon: Mail,
      badge: capCounts.createUser > 0 ? capCounts.createUser : undefined,
    });
    // ROADtools-inspired defensive audit pages for the Identity group.
    // Privileged Audit (SkyArk-style) and Tenant Baseline (AADInternals-
    // style) both surface tenant-scoped audit data — natural neighbours of
    // Tenant Users / Create User / Invite User.
    identity.push({
      key: "privileged-audit" as PageKey,
      label: "Privileged Audit",
      icon: ShieldAlert,
    });
    identity.push({
      key: "tenant-baseline" as PageKey,
      label: "Tenant Baseline",
      icon: FileCheck,
    });
    // ROADtools-inspired silent cross-tenant token-mint page. Uses
    // the operator's OWN MSAL cache + imported FOCI refresh tokens
    // to acquire a target-tenant token without a re-login popup.
    identity.push({
      key: "tricky-login" as PageKey,
      label: "Tricky Login",
      icon: Wand2,
    });
    // Sibling of Tricky Login — grid view of every imported RT × every
    // Azure resource audience, click-to-mint per cell. Same "give me
    // tokens" job, different shape.
    identity.push({
      key: "audience-matrix" as PageKey,
      label: "Audience Matrix",
      icon: LayoutGrid,
    });

    // ── Batch & compute ──────────────────────────────────────────────
    const compute: NavItem[] = [
      { key: "overview", label: "Overview", icon: LayoutDashboard },
      {
        key: "accounts",
        label: "Accounts",
        icon: ServerCog,
        badge: state.accounts.length,
      },
      {
        key: "pools",
        label: "Pools",
        icon: Boxes,
        badge: state.pools.length,
      },
      {
        key: "pool-defaults" as PageKey,
        label: "Pool Settings",
        icon: Settings,
      },
      {
        key: "pool-info",
        label: "Pool Info",
        icon: Grid3x3,
        badge: state.poolInfos.length,
      },
      {
        key: "account-info",
        label: "Account Info",
        icon: Users,
        badge: state.accountInfos.length,
      },
      {
        key: "nodes",
        label: "Nodes",
        icon: Server,
        badge: state.nodes.length,
      },
      {
        key: "unused-quota",
        label: "Unused Quota",
        icon: PiggyBank,
        badge: state.accountInfos.filter((a) => a.lowPriorityCoresFree > 0)
          .length,
      },
    ];

    // ── Subscriptions & billing ──────────────────────────────────────
    const billing: NavItem[] = [
      {
        key: "sub-manager" as PageKey,
        label: "Sub Manager",
        icon: ServerCog,
      },
      {
        key: "sub-mover" as PageKey,
        label: "Sub Mover",
        icon: BadgeCheck,
      },
      {
        key: "resource-manager" as PageKey,
        label: "Resource Manager",
        icon: Boxes,
      },
      {
        key: "ea-billing-manager" as PageKey,
        label: "EA Billing Manager",
        icon: Wallet,
      },
      {
        key: "department-admin" as PageKey,
        label: "Department Admin",
        icon: Layers,
      },
      {
        key: "ea-subscription" as PageKey,
        label: "Create EA Sub",
        icon: BadgeCheck,
        badge: capCounts.ea > 0 ? capCounts.ea : undefined,
      },
      {
        key: "ea-creator-pregrant" as PageKey,
        label: "Pre-grant EA Creator",
        icon: ShieldCheck,
      },
      {
        key: "ea-sub-quick" as PageKey,
        label: "Create EA Sub (quick)",
        icon: Sparkles,
      },
      {
        key: "legacy-ea-sub" as PageKey,
        label: "Create EA Sub (legacy)",
        icon: BadgeCheck,
      },
      {
        key: "partner-center" as PageKey,
        label: "Partner Center",
        icon: Handshake,
      },
    ];

    // ── Diagnostics & tools ──────────────────────────────────────────
    const diag: NavItem[] = [
      {
        key: "monitoring" as PageKey,
        label: "Monitoring",
        icon: ActivityIcon,
        badge: state.agentLogs?.filter((l) => l.level === "error").length ?? 0,
      },
      {
        key: "gpu-calculator" as PageKey,
        label: "GPU Calculator",
        icon: Calculator,
      },
      {
        key: "vm-catalog" as PageKey,
        label: "VM Catalog",
        icon: Cpu,
      },
      {
        key: "audit-log",
        label: "Audit Log",
        icon: History,
      },
      // ROADtools-inspired defensive audit pages for the Diagnostics group.
      // Role Graph (Stormspotter-style) and Security Audit (MicroBurst-style)
      // both probe subscription-level ARM data — same scope as Monitoring /
      // Audit Log so they belong in this section.
      {
        key: "role-graph" as PageKey,
        label: "Role Graph",
        icon: Network,
      },
      {
        key: "security-audit" as PageKey,
        label: "Security Audit",
        icon: ShieldCheck,
      },
      {
        key: "tasks" as PageKey,
        label: "Task Manager",
        icon: ListChecks,
        badge: taskBadge > 0 ? taskBadge : undefined,
      },
      {
        key: "throttle" as PageKey,
        label: "Throttle Status",
        icon: Gauge,
        badge: throttleBadge > 0 ? throttleBadge : undefined,
      },
    ];

    return [
      { key: "identity", label: "Identity & Users", icon: Users, items: identity },
      { key: "compute", label: "Batch & Compute", icon: Cpu, items: compute },
      {
        key: "billing",
        label: "Subscriptions & Billing",
        icon: Wallet,
        items: billing,
      },
      {
        key: "diag",
        label: "Diagnostics & Tools",
        icon: ActivityIcon,
        items: diag,
      },
    ];
  }, [state, azureAccounts, capCounts, taskBadge, throttleBadge]);

  /* ───────────────────────────────────────────────────────────────────
   * Group-collapse state. We auto-uncollapse the group containing the
   * active page so the user can always see where they are after a
   * cross-group jump (e.g. Cmd-K), but we don't *write* that back to
   * storage — so the user's last manual choice is preserved when they
   * leave that group again.
   * ─────────────────────────────────────────────────────────────────── */
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<GroupKey>>(
    () => readCollapsedGroups(),
  );

  const toggleGroup = React.useCallback((groupKey: GroupKey) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      writeCollapsedGroups(next);
      return next;
    });
  }, []);

  const activeGroupKey = React.useMemo<GroupKey | null>(() => {
    for (const g of groups) {
      if (g.items.some((i) => i.key === activeKey)) return g.key;
    }
    return null;
  }, [groups, activeKey]);

  /* ───────────────────────────────────────────────────────────────────
   * Shortcut number lookup. Alt+1..9 maps to the first nine entries of
   * PAGE_ORDER (canonical hotkey order from page-router), regardless of
   * how the sidebar visually groups them — so reshuffling groups never
   * silently changes a shortcut.
   * ─────────────────────────────────────────────────────────────────── */
  const shortcutByKey = React.useMemo(() => {
    const m = new Map<PageKey, number>();
    for (let i = 0; i < Math.min(9, PAGE_ORDER.length); i++) {
      m.set(PAGE_ORDER[i] as PageKey, i + 1);
    }
    return m;
  }, []);

  const renderItem = (item: NavItem, indent: boolean) => {
    const isActive = activeKey === item.key;
    const Icon = item.icon;
    const shortcut = shortcutByKey.get(item.key) ?? null;
    return (
      <button
        key={item.key}
        type="button"
        role="menuitem"
        aria-current={isActive ? "page" : undefined}
        onClick={() => {
          navigate(pageKeyToPath(item.key));
          onNavigate(item.key);
        }}
        title={
          collapsed
            ? shortcut
              ? `${item.label} (Alt+${shortcut})`
              : item.label
            : shortcut
              ? `Alt+${shortcut}`
              : undefined
        }
        className={cn(
          "group relative flex w-full items-center gap-3 text-left text-[13px] transition-colors duration-150",
          collapsed
            ? "px-3.5 py-2"
            : indent
              ? "py-1.5 pl-7 pr-4"
              : "px-4 py-2",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "accent-rail bg-gradient-to-r from-primary/12 via-accent/8 to-transparent text-foreground"
            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
        )}
      >
        <Icon
          className={cn(
            "h-4 w-4 shrink-0 transition-colors duration-150",
            isActive
              ? "text-primary drop-shadow-[0_0_8px_hsl(var(--primary)/0.55)]"
              : "text-muted-foreground group-hover:text-foreground",
          )}
          aria-hidden
        />
        {!collapsed && (
          <>
            <span className="flex-1 truncate">{item.label}</span>
            {item.badge != null && item.badge > 0 && (
              <span
                className={cn(
                  "inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-2xs font-semibold tabular-nums transition-colors duration-150",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
                aria-label={`${item.badge} items`}
              >
                {item.badge}
              </span>
            )}
            {shortcut != null &&
              (item.badge == null || item.badge === 0) && (
                <kbd
                  className="hidden font-mono text-[10px] font-medium text-muted-foreground/60 group-hover:inline-flex group-focus-visible:inline-flex"
                  aria-hidden
                >
                  Alt+{shortcut}
                </kbd>
              )}
          </>
        )}
      </button>
    );
  };

  return (
    <nav
      role="navigation"
      aria-label="Main navigation"
      className={cn(
        "flex h-full flex-col overflow-hidden border-r border-border bg-surface-base transition-[width] duration-200 ease-out",
        collapsed ? "w-12 min-w-12" : "w-60 min-w-60",
      )}
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        title={collapsed ? "Expand" : "Collapse"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-pressed={!collapsed}
        className="flex items-center gap-2.5 border-b border-border/60 px-3.5 py-3 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        {collapsed ? (
          <ChevronsRight className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronsLeft className="h-3.5 w-3.5 shrink-0" />
        )}
        {!collapsed && (
          <span className="text-2xs font-semibold uppercase tracking-widest">
            Navigation
          </span>
        )}
      </button>

      <div
        className="flex flex-1 flex-col overflow-y-auto py-1"
        role="menu"
      >
        {groups.map((group, gIndex) => {
          // In icon-only mode, suppress the group header but draw a
          // subtle divider between groups so the user still perceives
          // the section boundary.
          if (collapsed) {
            return (
              <React.Fragment key={group.key}>
                {gIndex > 0 && (
                  <div
                    className="my-1 mx-3 border-t border-border/40"
                    aria-hidden
                  />
                )}
                {group.items.map((item) => renderItem(item, false))}
              </React.Fragment>
            );
          }

          // Expanded sidebar — render a collapsible group header.
          const userCollapsed = collapsedGroups.has(group.key);
          // Force-expand the group that contains the active page so the
          // user always sees their current location, even if they had
          // previously folded that section. Their stored preference is
          // untouched and is restored once they navigate away.
          const containsActive = activeGroupKey === group.key;
          const isOpen = !userCollapsed || containsActive;
          const GroupIcon = group.icon;
          const Chevron = isOpen ? ChevronDown : ChevronRight;
          const total = groupBadgeTotal(group);
          return (
            <div key={group.key} className="flex flex-col">
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                aria-expanded={isOpen}
                aria-controls={`sidebar-group-${group.key}`}
                title={isOpen ? "Collapse group" : "Expand group"}
                className={cn(
                  "group/header relative flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs font-semibold uppercase tracking-wider transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  "text-muted-foreground/70 hover:bg-muted/30 hover:text-foreground",
                  gIndex > 0 && "mt-1 border-t border-border/40 pt-2.5",
                )}
              >
                <Chevron
                  className="h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover/header:text-foreground"
                  aria-hidden
                />
                <GroupIcon
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 group-hover/header:text-foreground"
                  aria-hidden
                />
                <span className="flex-1 truncate">{group.label}</span>
                {!isOpen && total > 0 && (
                  <span
                    className="inline-flex h-4 min-w-[18px] items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold tabular-nums text-muted-foreground"
                    aria-label={`${total} items in collapsed ${group.label}`}
                  >
                    {total}
                  </span>
                )}
                {!isOpen && containsActive && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                    aria-label="current page in this group"
                  />
                )}
              </button>
              {isOpen && (
                <div
                  id={`sidebar-group-${group.key}`}
                  className="flex flex-col gap-0.5"
                >
                  {group.items.map((item) => renderItem(item, true))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
};
