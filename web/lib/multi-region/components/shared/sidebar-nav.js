import { __awaiter } from "tslib";
/** Main left-rail navigation. Drives URL routing and shows per-account capability badges. */
import * as React from "react";
import { Activity as ActivityIcon, BadgeCheck, Boxes, Calculator, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Cpu, FileCheck, Gauge, Grid3x3, Handshake, History, KeyRound, Layers, LayoutDashboard, LayoutGrid, ListChecks, Mail, Network, PiggyBank, Server, ServerCog, Settings, ShieldAlert, ShieldCheck, Sparkles, User, UserPlus, Users, Wallet, Wand2, } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useMultiRegionState } from "../../store/store-context";
import { getGraphTokenForAccount, getActiveTenant, } from "../../auth/msal-auth";
import { canCreateUsers, canResetPasswords, getMyDirectoryRoles, } from "../../services/graph-service";
import { getEaCapabilityCached } from "../../services/ea-capability-cache";
import { taskRuntime } from "../../store/task-runtime";
import { PAGE_ORDER, pageKeyToPath } from "../page-router";
const EMPTY_CAP = {
    passwordReset: false,
    createUser: false,
    ea: false,
};
function useAccountCapabilityMap(azureAccounts) {
    const [map, setMap] = React.useState({});
    const accountKey = React.useMemo(() => azureAccounts
        .map((a) => `${a.homeAccountId}|${a.tenantId}`)
        .sort()
        .join(","), [azureAccounts]);
    React.useEffect(() => {
        var _a;
        let cancelled = false;
        // Stream results in per-account-completion so a slow account never
        // holds up the badges for the others.
        for (const a of azureAccounts) {
            if (!a.homeAccountId)
                continue;
            const tenantId = (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : a.tenantId;
            if (!tenantId) {
                setMap((prev) => (Object.assign(Object.assign({}, prev), { [a.homeAccountId]: EMPTY_CAP })));
                continue;
            }
            void (() => __awaiter(this, void 0, void 0, function* () {
                // Run Graph + ARM probes in parallel. Any failure → false.
                // EA probe goes through a session-wide cache so the EA-subscription
                // page can reuse the same result without re-hitting the billing
                // API on navigation.
                const [graphRoles, eaCap] = yield Promise.all([
                    (() => __awaiter(this, void 0, void 0, function* () {
                        try {
                            const token = yield getGraphTokenForAccount(a.homeAccountId, tenantId);
                            return yield getMyDirectoryRoles(tenantId, token);
                        }
                        catch (_b) {
                            return null;
                        }
                    }))(),
                    (() => __awaiter(this, void 0, void 0, function* () {
                        try {
                            return yield getEaCapabilityCached(a.homeAccountId, tenantId);
                        }
                        catch (_c) {
                            return null;
                        }
                    }))(),
                ]);
                if (cancelled)
                    return;
                setMap((prev) => {
                    var _a;
                    return (Object.assign(Object.assign({}, prev), { [a.homeAccountId]: {
                            passwordReset: graphRoles ? canResetPasswords(graphRoles) : false,
                            createUser: graphRoles ? canCreateUsers(graphRoles) : false,
                            ea: (_a = eaCap === null || eaCap === void 0 ? void 0 : eaCap.hasEa) !== null && _a !== void 0 ? _a : false,
                        } }));
                });
            }))();
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
function useTaskBadgeCount() {
    const [count, setCount] = React.useState(() => taskRuntime
        .list()
        .filter((t) => t.status === "running" || t.status === "interrupted")
        .length);
    React.useEffect(() => taskRuntime.subscribe((tasks) => setCount(tasks.filter((t) => t.status === "running" || t.status === "interrupted").length)), []);
    return count;
}
/* ─────────────────────────────────────────────────────────────────────
 * Group-collapse persistence. State is per-group, stored as a Set of
 * group keys that are currently collapsed. Default is "everything
 * expanded" (empty set) so first-time users see the full nav.
 * ───────────────────────────────────────────────────────────────────── */
const COLLAPSED_GROUPS_KEY = "azbm.sidebar.collapsed-groups.v1";
function readCollapsedGroups() {
    try {
        if (typeof window === "undefined")
            return new Set();
        const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
        if (!raw)
            return new Set();
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr))
            return new Set();
        return new Set(arr.filter((k) => k === "identity" || k === "compute" || k === "billing" || k === "diag"));
    }
    catch (_a) {
        return new Set();
    }
}
function writeCollapsedGroups(keys) {
    try {
        if (typeof window === "undefined")
            return;
        window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(Array.from(keys)));
    }
    catch (_a) {
        // localStorage may be unavailable (Safari private mode etc.) — ignore.
    }
}
/** Sum badges in a group for the collapsed-header indicator. */
function groupBadgeTotal(group) {
    let total = 0;
    for (const item of group.items) {
        if (item.badge != null && item.badge > 0)
            total += item.badge;
    }
    return total;
}
export const SidebarNav = ({ activeKey, onNavigate, collapsed, onToggleCollapse, }) => {
    var _a;
    const navigate = useNavigate();
    const state = useMultiRegionState();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    const capMap = useAccountCapabilityMap(azureAccounts);
    const taskBadge = useTaskBadgeCount();
    // Count circuits in non-healthy state (open + probing). A live signal
    // operators can see at a glance from any page.
    const throttleBadge = React.useMemo(() => {
        var _a, _b, _c;
        const map = (_b = (_a = state.throttleStats) === null || _a === void 0 ? void 0 : _a.perSubscription) !== null && _b !== void 0 ? _b : {};
        let n = 0;
        for (const k in map) {
            const s = (_c = map[k]) === null || _c === void 0 ? void 0 : _c.state;
            if (s === "open" || s === "half_open")
                n++;
        }
        return n;
    }, [state.throttleStats]);
    const capCounts = React.useMemo(() => {
        let pwd = 0;
        let create = 0;
        let ea = 0;
        for (const c of Object.values(capMap)) {
            if (c.passwordReset)
                pwd++;
            if (c.createUser)
                create++;
            if (c.ea)
                ea++;
        }
        return { passwordReset: pwd, createUser: create, ea };
    }, [capMap]);
    /* ───────────────────────────────────────────────────────────────────
     * Group definitions. Each group is a logical task area; items within
     * a group are ordered most-frequently-used first. Conditional items
     * (Tenant Users, gated by passwordReset capability) slot in beside
     * their permanent siblings.
     * ─────────────────────────────────────────────────────────────────── */
    const groups = React.useMemo(() => {
        var _a, _b;
        // ── Identity & users ─────────────────────────────────────────────
        const identity = [
            {
                key: "azure-accounts",
                label: "Azure Accounts",
                icon: User,
                badge: azureAccounts.length,
            },
            {
                key: "token-importer",
                label: "Import Token",
                icon: KeyRound,
            },
        ];
        if (capCounts.passwordReset > 0) {
            identity.push({
                key: "tenant-users",
                label: "Tenant Users",
                icon: Users,
                badge: capCounts.passwordReset,
            });
        }
        identity.push({
            key: "user-creator",
            label: "Create User",
            icon: UserPlus,
            badge: capCounts.createUser > 0 ? capCounts.createUser : undefined,
        });
        identity.push({
            key: "invite-user",
            label: "Invite User",
            icon: Mail,
            badge: capCounts.createUser > 0 ? capCounts.createUser : undefined,
        });
        // ROADtools-inspired defensive audit pages for the Identity group.
        // Privileged Audit (SkyArk-style) and Tenant Baseline (AADInternals-
        // style) both surface tenant-scoped audit data — natural neighbours of
        // Tenant Users / Create User / Invite User.
        identity.push({
            key: "privileged-audit",
            label: "Privileged Audit",
            icon: ShieldAlert,
        });
        identity.push({
            key: "tenant-baseline",
            label: "Tenant Baseline",
            icon: FileCheck,
        });
        // ROADtools-inspired silent cross-tenant token-mint page. Uses
        // the operator's OWN MSAL cache + imported FOCI refresh tokens
        // to acquire a target-tenant token without a re-login popup.
        identity.push({
            key: "tricky-login",
            label: "Tricky Login",
            icon: Wand2,
        });
        // Sibling of Tricky Login — grid view of every imported RT × every
        // Azure resource audience, click-to-mint per cell. Same "give me
        // tokens" job, different shape.
        identity.push({
            key: "audience-matrix",
            label: "Audience Matrix",
            icon: LayoutGrid,
        });
        // ── Batch & compute ──────────────────────────────────────────────
        const compute = [
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
                key: "pool-defaults",
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
        const billing = [
            {
                key: "sub-manager",
                label: "Sub Manager",
                icon: ServerCog,
            },
            {
                key: "sub-mover",
                label: "Sub Mover",
                icon: BadgeCheck,
            },
            {
                key: "resource-manager",
                label: "Resource Manager",
                icon: Boxes,
            },
            {
                key: "ea-billing-manager",
                label: "EA Billing Manager",
                icon: Wallet,
            },
            {
                key: "department-admin",
                label: "Department Admin",
                icon: Layers,
            },
            {
                key: "ea-subscription",
                label: "Create EA Sub",
                icon: BadgeCheck,
                badge: capCounts.ea > 0 ? capCounts.ea : undefined,
            },
            {
                key: "ea-creator-pregrant",
                label: "Pre-grant EA Creator",
                icon: ShieldCheck,
            },
            {
                key: "ea-sub-quick",
                label: "Create EA Sub (quick)",
                icon: Sparkles,
            },
            {
                key: "legacy-ea-sub",
                label: "Create EA Sub (legacy)",
                icon: BadgeCheck,
            },
            {
                key: "partner-center",
                label: "Partner Center",
                icon: Handshake,
            },
        ];
        // ── Diagnostics & tools ──────────────────────────────────────────
        const diag = [
            {
                key: "monitoring",
                label: "Monitoring",
                icon: ActivityIcon,
                badge: (_b = (_a = state.agentLogs) === null || _a === void 0 ? void 0 : _a.filter((l) => l.level === "error").length) !== null && _b !== void 0 ? _b : 0,
            },
            {
                key: "gpu-calculator",
                label: "GPU Calculator",
                icon: Calculator,
            },
            {
                key: "vm-catalog",
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
                key: "role-graph",
                label: "Role Graph",
                icon: Network,
            },
            {
                key: "security-audit",
                label: "Security Audit",
                icon: ShieldCheck,
            },
            {
                key: "tasks",
                label: "Task Manager",
                icon: ListChecks,
                badge: taskBadge > 0 ? taskBadge : undefined,
            },
            {
                key: "throttle",
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
    const [collapsedGroups, setCollapsedGroups] = React.useState(() => readCollapsedGroups());
    const toggleGroup = React.useCallback((groupKey) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupKey))
                next.delete(groupKey);
            else
                next.add(groupKey);
            writeCollapsedGroups(next);
            return next;
        });
    }, []);
    const activeGroupKey = React.useMemo(() => {
        for (const g of groups) {
            if (g.items.some((i) => i.key === activeKey))
                return g.key;
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
        const m = new Map();
        for (let i = 0; i < Math.min(9, PAGE_ORDER.length); i++) {
            m.set(PAGE_ORDER[i], i + 1);
        }
        return m;
    }, []);
    const renderItem = (item, indent) => {
        var _a;
        const isActive = activeKey === item.key;
        const Icon = item.icon;
        const shortcut = (_a = shortcutByKey.get(item.key)) !== null && _a !== void 0 ? _a : null;
        return (React.createElement("button", { key: item.key, type: "button", role: "menuitem", "aria-current": isActive ? "page" : undefined, onClick: () => {
                navigate(pageKeyToPath(item.key));
                onNavigate(item.key);
            }, title: collapsed
                ? shortcut
                    ? `${item.label} (Alt+${shortcut})`
                    : item.label
                : shortcut
                    ? `Alt+${shortcut}`
                    : undefined, className: cn("group relative flex w-full items-center gap-3 text-left text-[13px] transition-colors duration-150", collapsed
                ? "px-3.5 py-2"
                : indent
                    ? "py-1.5 pl-7 pr-4"
                    : "px-4 py-2", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", isActive
                ? "accent-rail bg-gradient-to-r from-primary/12 via-accent/8 to-transparent text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground") },
            React.createElement(Icon, { className: cn("h-4 w-4 shrink-0 transition-colors duration-150", isActive
                    ? "text-primary drop-shadow-[0_0_8px_hsl(var(--primary)/0.55)]"
                    : "text-muted-foreground group-hover:text-foreground"), "aria-hidden": true }),
            !collapsed && (React.createElement(React.Fragment, null,
                React.createElement("span", { className: "flex-1 truncate" }, item.label),
                item.badge != null && item.badge > 0 && (React.createElement("span", { className: cn("inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-2xs font-semibold tabular-nums transition-colors duration-150", isActive
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"), "aria-label": `${item.badge} items` }, item.badge)),
                shortcut != null &&
                    (item.badge == null || item.badge === 0) && (React.createElement("kbd", { className: "hidden font-mono text-[10px] font-medium text-muted-foreground/60 group-hover:inline-flex group-focus-visible:inline-flex", "aria-hidden": true },
                    "Alt+",
                    shortcut))))));
    };
    return (React.createElement("nav", { role: "navigation", "aria-label": "Main navigation", className: cn("flex h-full flex-col overflow-hidden border-r border-border bg-surface-base transition-[width] duration-200 ease-out", collapsed ? "w-12 min-w-12" : "w-60 min-w-60") },
        React.createElement("button", { type: "button", onClick: onToggleCollapse, title: collapsed ? "Expand" : "Collapse", "aria-label": collapsed ? "Expand sidebar" : "Collapse sidebar", "aria-pressed": !collapsed, className: "flex items-center gap-2.5 border-b border-border/60 px-3.5 py-3 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background" },
            collapsed ? (React.createElement(ChevronsRight, { className: "h-3.5 w-3.5 shrink-0" })) : (React.createElement(ChevronsLeft, { className: "h-3.5 w-3.5 shrink-0" })),
            !collapsed && (React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-widest" }, "Navigation"))),
        React.createElement("div", { className: "flex flex-1 flex-col overflow-y-auto py-1", role: "menu" }, groups.map((group, gIndex) => {
            // In icon-only mode, suppress the group header but draw a
            // subtle divider between groups so the user still perceives
            // the section boundary.
            if (collapsed) {
                return (React.createElement(React.Fragment, { key: group.key },
                    gIndex > 0 && (React.createElement("div", { className: "my-1 mx-3 border-t border-border/40", "aria-hidden": true })),
                    group.items.map((item) => renderItem(item, false))));
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
            return (React.createElement("div", { key: group.key, className: "flex flex-col" },
                React.createElement("button", { type: "button", onClick: () => toggleGroup(group.key), "aria-expanded": isOpen, "aria-controls": `sidebar-group-${group.key}`, title: isOpen ? "Collapse group" : "Expand group", className: cn("group/header relative flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs font-semibold uppercase tracking-wider transition-colors duration-150", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", "text-muted-foreground/70 hover:bg-muted/30 hover:text-foreground", gIndex > 0 && "mt-1 border-t border-border/40 pt-2.5") },
                    React.createElement(Chevron, { className: "h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover/header:text-foreground", "aria-hidden": true }),
                    React.createElement(GroupIcon, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground/70 group-hover/header:text-foreground", "aria-hidden": true }),
                    React.createElement("span", { className: "flex-1 truncate" }, group.label),
                    !isOpen && total > 0 && (React.createElement("span", { className: "inline-flex h-4 min-w-[18px] items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold tabular-nums text-muted-foreground", "aria-label": `${total} items in collapsed ${group.label}` }, total)),
                    !isOpen && containsActive && (React.createElement("span", { className: "h-1.5 w-1.5 shrink-0 rounded-full bg-primary", "aria-label": "current page in this group" }))),
                isOpen && (React.createElement("div", { id: `sidebar-group-${group.key}`, className: "flex flex-col gap-0.5" }, group.items.map((item) => renderItem(item, true))))));
        }))));
};
//# sourceMappingURL=sidebar-nav.js.map