/**
 * Centralized route definitions for the dashboard. Replaces the legacy
 * `activePage` switch in `multi-region-dashboard.tsx`. Routes match the
 * canonical set in Design Contract §4.1; deep links (e.g. `/pools/:poolId`,
 * `/account-info/:accountId`) are first-class.
 *
 * Page components remain mounted with the same props as before. The
 * `<DashboardOutletProps>` interface declares the shared deps every page
 * needs (orchestrator, store, programmatic-navigation helper); the
 * `<DashboardOutlet>` HOC injects them via `<Outlet context>` so each route
 * doesn't have to repeat the wiring.
 *
 * Hotkey ordering for Alt+1..9 is preserved by the `PAGE_ORDER` export.
 */
import * as React from "react";
import { Navigate, Outlet, Route, Routes, useNavigate, useOutletContext, useParams, } from "react-router-dom";
import { ErrorBoundary } from "./shared/error-boundary";
import { PageEnhancerShell } from "./shared/page-enhancer-shell";
import { getTrioForPage } from "../agents/page-enhancers/registry";
import { AccountInfoPage } from "./account-info/account-info-page";
import { AccountProvisioningPage } from "./account-provisioning/account-provisioning-page";
import { AuditLogPage } from "./audit-log/audit-log-page";
import { AzureAccountsPage } from "./azure-accounts/azure-accounts-page";
import { EaSubscriptionPage } from "./ea-subscription/ea-subscription-page";
import { GpuCalculatorPage } from "./gpu-calculator/gpu-calculator-page";
import { MonitoringPage } from "./monitoring/monitoring-page";
import { NodesPage } from "./nodes/nodes-page";
import { OverviewPage } from "./overview/overview-page";
import { PoolCreationPage } from "./pool-creation/pool-creation-page";
import { PoolDefaultsPage } from "./pool-defaults/pool-defaults-page";
import { PoolInfoPage } from "./pool-info/pool-info-page";
import { TaskManagerPage } from "./task-manager/task-manager-page";
import { ThrottlePage } from "./throttle/throttle-page";
import { VmCatalogPage } from "./vm-catalog/vm-catalog-page";
import { InviteUserPage } from "./invite-user/invite-user-page";
import { SubManagerPage } from "./sub-manager/sub-manager-page";
import { EaBillingManagerPage } from "./ea-billing-manager/ea-billing-manager-page";
import { ResourceManagerPage } from "./resource-manager/resource-manager-page";
import { SubMoverPage } from "./sub-mover/sub-mover-page";
import { TokenImporterPage } from "./token-importer/token-importer-page";
import { DepartmentAdminPage } from "./department-admin/department-admin-page";
import { LegacyEaSubCreatorPage } from "./legacy-ea-sub-creator/legacy-ea-sub-creator-page";
import { EaSubQuickPage } from "./ea-sub-quick/ea-sub-quick-page";
import { EaCreatorPregrantPage } from "./ea-creator-pregrant/ea-creator-pregrant-page";
import { PartnerCenterPage } from "./partner-center/partner-center-page";
import { TenantUsersPage } from "./tenant-users/tenant-users-page";
import { UnusedQuotaPage } from "./unused-quota/unused-quota-page";
import { UserCreatorPage } from "./user-creator/user-creator-page";
// ROADtools-inspired defensive audit pages (Stormspotter / MicroBurst /
// SkyArk / AADInternals). Each is a read-only enumeration of the operator's
// OWN tenant + subscriptions — no offensive primitives.
import { RoleGraphPage } from "./role-graph/role-graph-page";
import { SecurityAuditPage } from "./security-audit/security-audit-page";
import { PrivilegedAuditPage } from "./privileged-audit/privileged-audit-page";
import { TenantBaselinePage } from "./tenant-baseline/tenant-baseline-page";
import { TrickyLoginPage } from "./tricky-login/tricky-login-page";
import { AudienceMatrixPage } from "./audience-matrix/audience-matrix-page";
/** Convenience hook for pages — typed wrapper over `useOutletContext`. */
export function useDashboardOutletContext() {
    return useOutletContext();
}
const PAGE_KEY_TO_PATH = {
    "azure-accounts": "/azure-accounts",
    overview: "/overview",
    accounts: "/accounts",
    pools: "/pools",
    "pool-defaults": "/pool-defaults",
    "pool-info": "/pool-info",
    "account-info": "/account-info",
    "unused-quota": "/unused-quota",
    monitoring: "/monitoring",
    nodes: "/nodes",
    "gpu-calculator": "/gpu-calculator",
    "audit-log": "/audit-log",
    "tenant-users": "/tenant-users",
    "user-creator": "/user-creator",
    "invite-user": "/invite-user",
    "sub-manager": "/sub-manager",
    "ea-billing-manager": "/ea-billing-manager",
    "resource-manager": "/resource-manager",
    "sub-mover": "/sub-mover",
    "token-importer": "/token-importer",
    "department-admin": "/department-admin",
    "legacy-ea-sub": "/legacy-ea-sub",
    "ea-sub-quick": "/ea-sub-quick",
    "ea-creator-pregrant": "/ea-creator-pregrant",
    "ea-subscription": "/ea-subscription",
    "partner-center": "/partner-center",
    "role-graph": "/role-graph",
    "security-audit": "/security-audit",
    "privileged-audit": "/privileged-audit",
    "tenant-baseline": "/tenant-baseline",
    "tricky-login": "/tricky-login",
    "audience-matrix": "/audience-matrix",
    tasks: "/tasks",
    throttle: "/throttle",
    "vm-catalog": "/vm-catalog",
};
const PATH_TO_PAGE_KEY = Object.fromEntries(Object.entries(PAGE_KEY_TO_PATH).map(([k, v]) => [v, k]));
/** Translate a PageKey to its canonical route path. */
export function pageKeyToPath(key) {
    return PAGE_KEY_TO_PATH[key];
}
/** Best-effort reverse lookup of a path → PageKey. Returns null on miss. */
export function pathToPageKey(path) {
    // Strip trailing slashes / query / hash before lookup.
    const clean = path.replace(/[?#].*$/, "").replace(/\/$/, "");
    if (PATH_TO_PAGE_KEY[clean])
        return PATH_TO_PAGE_KEY[clean];
    // Match deep links — `/pools/abc` → "pool-info" (deep view) or `pools`
    if (clean.startsWith("/pools/"))
        return "pools";
    if (clean.startsWith("/pool-info/"))
        return "pool-info";
    if (clean.startsWith("/account-info/"))
        return "account-info";
    if (clean.startsWith("/accounts/"))
        return "accounts";
    return null;
}
/**
 * Sidebar order — must match the Alt+1..9 mapping in Design Contract §4.2.
 * Only the first 9 are reachable via hotkeys; the rest are
 * sidebar/Cmd-K-only.
 */
export const PAGE_ORDER = [
    "azure-accounts",
    "overview",
    "accounts",
    "pools",
    "pool-defaults",
    "pool-info",
    "account-info",
    "unused-quota",
    "monitoring",
    "nodes",
    "gpu-calculator",
    "audit-log",
    "tenant-users",
    "user-creator",
    "invite-user",
    "sub-manager",
    "ea-billing-manager",
    "resource-manager",
    "sub-mover",
    "token-importer",
    "department-admin",
    "legacy-ea-sub",
    "ea-sub-quick",
    "ea-creator-pregrant",
    "ea-subscription",
    "partner-center",
    "role-graph",
    "security-audit",
    "privileged-audit",
    "tenant-baseline",
    "tricky-login",
    "audience-matrix",
    "tasks",
    "throttle",
    "vm-catalog",
];
const DashboardOutlet = ({ orchestrator, store, }) => {
    const navigate = useNavigate();
    const navigateToPage = React.useCallback((target) => {
        var _a;
        // Accept both PageKey strings and full paths for backward compat.
        const path = (_a = PAGE_KEY_TO_PATH[target]) !== null && _a !== void 0 ? _a : target;
        navigate(path);
    }, [navigate]);
    const context = React.useMemo(() => ({ orchestrator, store, navigateToPage }), [orchestrator, store, navigateToPage]);
    return React.createElement(Outlet, { context: context });
};
// ---------------------------------------------------------------------------
// Per-route adapters — pages still take their existing prop shapes
// ---------------------------------------------------------------------------
//
// Each adapter pulls the orchestrator/store/navigateToPage out of context
// and constructs the legacy props the page component expects. As pages
// migrate to use `useDashboardOutletContext()` directly, these adapters can
// be deleted one-by-one without touching this router.
const PageBoundary = ({ pageKey, children }) => {
    const { orchestrator } = useDashboardOutletContext();
    const trio = getTrioForPage(pageKey);
    // Each page gets its own boundary keyed by the page so a crash in one
    // page doesn't blank the whole shell, and the boundary auto-resets on
    // navigation. The PageEnhancerShell adds the per-page agent trio
    // (UI panel + tools toolbar + workflow registration) without touching the
    // page's internal JSX.
    return (React.createElement(ErrorBoundary, { key: `page-${pageKey}` },
        React.createElement(PageEnhancerShell, { pageKey: pageKey, trio: trio, orchestrator: orchestrator }, children)));
};
const AzureAccountsRoute = () => (React.createElement(PageBoundary, { pageKey: "azure-accounts" },
    React.createElement(AzureAccountsPage, null)));
const OverviewRoute = () => {
    const { orchestrator, store, navigateToPage } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "overview" },
        React.createElement(OverviewPage, { orchestrator: orchestrator, store: store, onNavigate: (k) => navigateToPage(k) })));
};
const AccountsRoute = () => {
    const { orchestrator } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "accounts" },
        React.createElement(AccountProvisioningPage, { orchestrator: orchestrator })));
};
const PoolsRoute = () => {
    const { orchestrator } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "pools" },
        React.createElement(PoolCreationPage, { orchestrator: orchestrator })));
};
const PoolDefaultsRoute = () => (React.createElement(PageBoundary, { pageKey: "pool-defaults" },
    React.createElement(PoolDefaultsPage, null)));
const PoolInfoRoute = () => {
    const { orchestrator } = useDashboardOutletContext();
    // The :poolId param is consumed by PoolInfoPage via useParams when
    // present; the same component handles both list and detail views.
    // (Migration leaves PoolInfoPage unchanged for now — it can read params
    // on its own when the deep-link feature is wired in Tier 5.)
    useParams();
    return (React.createElement(PageBoundary, { pageKey: "pool-info" },
        React.createElement(PoolInfoPage, { orchestrator: orchestrator })));
};
const AccountInfoRoute = () => {
    const { orchestrator } = useDashboardOutletContext();
    useParams();
    return (React.createElement(PageBoundary, { pageKey: "account-info" },
        React.createElement(AccountInfoPage, { orchestrator: orchestrator })));
};
const UnusedQuotaRoute = () => {
    const { orchestrator, navigateToPage } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "unused-quota" },
        React.createElement(UnusedQuotaPage, { orchestrator: orchestrator, onNavigate: navigateToPage })));
};
const MonitoringRoute = () => {
    const { orchestrator } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "monitoring" },
        React.createElement(MonitoringPage, { orchestrator: orchestrator })));
};
const NodesRoute = () => {
    const { orchestrator } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "nodes" },
        React.createElement(NodesPage, { orchestrator: orchestrator })));
};
const GpuCalculatorRoute = () => (React.createElement(PageBoundary, { pageKey: "gpu-calculator" },
    React.createElement(GpuCalculatorPage, null)));
const TenantUsersRoute = () => {
    const { orchestrator, navigateToPage } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "tenant-users" },
        React.createElement(TenantUsersPage, { orchestrator: orchestrator, onNavigate: (k) => navigateToPage(k) })));
};
const UserCreatorRoute = () => {
    const { orchestrator, navigateToPage } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "user-creator" },
        React.createElement(UserCreatorPage, { orchestrator: orchestrator, onNavigate: navigateToPage })));
};
const InviteUserRoute = () => (React.createElement(PageBoundary, { pageKey: "invite-user" },
    React.createElement(InviteUserPage, null)));
const SubManagerRoute = () => (React.createElement(PageBoundary, { pageKey: "sub-manager" },
    React.createElement(SubManagerPage, null)));
const EaBillingManagerRoute = () => (React.createElement(PageBoundary, { pageKey: "ea-billing-manager" },
    React.createElement(EaBillingManagerPage, null)));
const ResourceManagerRoute = () => (React.createElement(PageBoundary, { pageKey: "resource-manager" },
    React.createElement(ResourceManagerPage, null)));
const SubMoverRoute = () => (React.createElement(PageBoundary, { pageKey: "sub-mover" },
    React.createElement(SubMoverPage, null)));
const TokenImporterRoute = () => (React.createElement(PageBoundary, { pageKey: "token-importer" },
    React.createElement(TokenImporterPage, null)));
const DepartmentAdminRoute = () => (React.createElement(PageBoundary, { pageKey: "department-admin" },
    React.createElement(DepartmentAdminPage, null)));
const LegacyEaSubRoute = () => (React.createElement(PageBoundary, { pageKey: "legacy-ea-sub" },
    React.createElement(LegacyEaSubCreatorPage, null)));
const EaSubQuickRoute = () => {
    const { navigateToPage } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "ea-sub-quick" },
        React.createElement(EaSubQuickPage, { onNavigate: (k) => navigateToPage(k) })));
};
const EaCreatorPregrantRoute = () => (React.createElement(PageBoundary, { pageKey: "ea-creator-pregrant" },
    React.createElement(EaCreatorPregrantPage, null)));
const PartnerCenterRoute = () => {
    const { navigateToPage } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "partner-center" },
        React.createElement(PartnerCenterPage, { onNavigate: (k) => navigateToPage(k) })));
};
const TasksRoute = () => (React.createElement(PageBoundary, { pageKey: "tasks" },
    React.createElement(TaskManagerPage, null)));
const ThrottleRoute = () => (React.createElement(PageBoundary, { pageKey: "throttle" },
    React.createElement(ThrottlePage, null)));
const VmCatalogRoute = () => (React.createElement(PageBoundary, { pageKey: "vm-catalog" },
    React.createElement(VmCatalogPage, null)));
// ROADtools-inspired defensive audit routes. Each is a self-contained
// read-only enumeration page — no props needed beyond what useArmToken
// and the store already give them.
const RoleGraphRoute = () => (React.createElement(PageBoundary, { pageKey: "role-graph" },
    React.createElement(RoleGraphPage, null)));
const SecurityAuditRoute = () => (React.createElement(PageBoundary, { pageKey: "security-audit" },
    React.createElement(SecurityAuditPage, null)));
const PrivilegedAuditRoute = () => (React.createElement(PageBoundary, { pageKey: "privileged-audit" },
    React.createElement(PrivilegedAuditPage, null)));
const TenantBaselineRoute = () => (React.createElement(PageBoundary, { pageKey: "tenant-baseline" },
    React.createElement(TenantBaselinePage, null)));
const TrickyLoginRoute = () => (React.createElement(PageBoundary, { pageKey: "tricky-login" },
    React.createElement(TrickyLoginPage, null)));
const AudienceMatrixRoute = () => (React.createElement(PageBoundary, { pageKey: "audience-matrix" },
    React.createElement(AudienceMatrixPage, null)));
const EaSubscriptionRoute = () => {
    const { orchestrator, navigateToPage } = useDashboardOutletContext();
    return (React.createElement(PageBoundary, { pageKey: "ea-subscription" },
        React.createElement(EaSubscriptionPage, { orchestrator: orchestrator, onNavigate: navigateToPage })));
};
/**
 * Audit log route. Renders the extracted, standalone AuditLogPage from
 * `audit-log/audit-log-page.tsx` (search, CSV export, clear, live-subscribed
 * to the auditLog singleton).
 */
const AuditLogRoute = () => (React.createElement(PageBoundary, { pageKey: "audit-log" },
    React.createElement(AuditLogPage, null)));
/**
 * Mounts the full route table under a single `DashboardOutlet`. Place this
 * inside `<HashRouter>` (or the equivalent host router) — it does not own
 * the router itself.
 */
export const PageRouter = ({ orchestrator, store, }) => {
    return (React.createElement(Routes, null,
        React.createElement(Route, { element: React.createElement(DashboardOutlet, { orchestrator: orchestrator, store: store }) },
            React.createElement(Route, { index: true, element: React.createElement(Navigate, { to: "/azure-accounts", replace: true }) }),
            React.createElement(Route, { path: "/azure-accounts", element: React.createElement(AzureAccountsRoute, null) }),
            React.createElement(Route, { path: "/overview", element: React.createElement(OverviewRoute, null) }),
            React.createElement(Route, { path: "/accounts", element: React.createElement(AccountsRoute, null) }),
            React.createElement(Route, { path: "/accounts/:accountId", element: React.createElement(AccountInfoRoute, null) }),
            React.createElement(Route, { path: "/account-info", element: React.createElement(AccountInfoRoute, null) }),
            React.createElement(Route, { path: "/account-info/:accountId", element: React.createElement(AccountInfoRoute, null) }),
            React.createElement(Route, { path: "/pools", element: React.createElement(PoolsRoute, null) }),
            React.createElement(Route, { path: "/pools/:poolId", element: React.createElement(PoolInfoRoute, null) }),
            React.createElement(Route, { path: "/pool-defaults", element: React.createElement(PoolDefaultsRoute, null) }),
            React.createElement(Route, { path: "/pool-info", element: React.createElement(PoolInfoRoute, null) }),
            React.createElement(Route, { path: "/pool-info/:poolId", element: React.createElement(PoolInfoRoute, null) }),
            React.createElement(Route, { path: "/nodes", element: React.createElement(NodesRoute, null) }),
            React.createElement(Route, { path: "/unused-quota", element: React.createElement(UnusedQuotaRoute, null) }),
            React.createElement(Route, { path: "/monitoring", element: React.createElement(MonitoringRoute, null) }),
            React.createElement(Route, { path: "/gpu-calculator", element: React.createElement(GpuCalculatorRoute, null) }),
            React.createElement(Route, { path: "/audit-log", element: React.createElement(AuditLogRoute, null) }),
            React.createElement(Route, { path: "/tenant-users", element: React.createElement(TenantUsersRoute, null) }),
            React.createElement(Route, { path: "/user-creator", element: React.createElement(UserCreatorRoute, null) }),
            React.createElement(Route, { path: "/invite-user", element: React.createElement(InviteUserRoute, null) }),
            React.createElement(Route, { path: "/sub-manager", element: React.createElement(SubManagerRoute, null) }),
            React.createElement(Route, { path: "/ea-billing-manager", element: React.createElement(EaBillingManagerRoute, null) }),
            React.createElement(Route, { path: "/resource-manager", element: React.createElement(ResourceManagerRoute, null) }),
            React.createElement(Route, { path: "/sub-mover", element: React.createElement(SubMoverRoute, null) }),
            React.createElement(Route, { path: "/token-importer", element: React.createElement(TokenImporterRoute, null) }),
            React.createElement(Route, { path: "/department-admin", element: React.createElement(DepartmentAdminRoute, null) }),
            React.createElement(Route, { path: "/legacy-ea-sub", element: React.createElement(LegacyEaSubRoute, null) }),
            React.createElement(Route, { path: "/ea-sub-quick", element: React.createElement(EaSubQuickRoute, null) }),
            React.createElement(Route, { path: "/ea-creator-pregrant", element: React.createElement(EaCreatorPregrantRoute, null) }),
            React.createElement(Route, { path: "/partner-center", element: React.createElement(PartnerCenterRoute, null) }),
            React.createElement(Route, { path: "/ea-subscription", element: React.createElement(EaSubscriptionRoute, null) }),
            React.createElement(Route, { path: "/role-graph", element: React.createElement(RoleGraphRoute, null) }),
            React.createElement(Route, { path: "/security-audit", element: React.createElement(SecurityAuditRoute, null) }),
            React.createElement(Route, { path: "/privileged-audit", element: React.createElement(PrivilegedAuditRoute, null) }),
            React.createElement(Route, { path: "/tenant-baseline", element: React.createElement(TenantBaselineRoute, null) }),
            React.createElement(Route, { path: "/tricky-login", element: React.createElement(TrickyLoginRoute, null) }),
            React.createElement(Route, { path: "/audience-matrix", element: React.createElement(AudienceMatrixRoute, null) }),
            React.createElement(Route, { path: "/tasks", element: React.createElement(TasksRoute, null) }),
            React.createElement(Route, { path: "/throttle", element: React.createElement(ThrottleRoute, null) }),
            React.createElement(Route, { path: "/vm-catalog", element: React.createElement(VmCatalogRoute, null) }),
            React.createElement(Route, { path: "*", element: React.createElement(Navigate, { to: "/azure-accounts", replace: true }) }))));
};
//# sourceMappingURL=page-router.js.map