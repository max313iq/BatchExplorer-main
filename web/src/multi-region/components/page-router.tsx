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
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";

import { ErrorBoundary } from "./shared/error-boundary";
import { PageEnhancerShell } from "./shared/page-enhancer-shell";
import { OrchestratorAgent } from "../agents/orchestrator-agent";
import { getTrioForPage } from "../agents/page-enhancers/registry";
import { MultiRegionStore } from "../store/multi-region-store";

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

// ---------------------------------------------------------------------------
// Outlet context — every page receives these via useOutletContext()
// ---------------------------------------------------------------------------

export interface DashboardOutletContext {
  orchestrator: OrchestratorAgent;
  store: MultiRegionStore;
  /**
   * Navigation helper that pages can use to programmatically route. Wraps
   * react-router's `useNavigate` for backward-compat with the old
   * `(key: PageKey) => void` signature.
   */
  navigateToPage: (path: string) => void;
}

/** Convenience hook for pages — typed wrapper over `useOutletContext`. */
export function useDashboardOutletContext(): DashboardOutletContext {
  return useOutletContext<DashboardOutletContext>();
}

// ---------------------------------------------------------------------------
// Page-key compatibility shim
// ---------------------------------------------------------------------------

/**
 * Legacy page keys, kept for backward compatibility with pages that still
 * accept `onNavigate: (key: PageKey) => void`. The page-router translates
 * these to canonical paths.
 */
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
  | "audit-log"
  | "tenant-users"
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
  | "tasks"
  | "throttle"
  | "vm-catalog";

const PAGE_KEY_TO_PATH: Record<PageKey, string> = {
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

const PATH_TO_PAGE_KEY: Record<string, PageKey> = Object.fromEntries(
  Object.entries(PAGE_KEY_TO_PATH).map(([k, v]) => [v, k as PageKey]),
) as Record<string, PageKey>;

/** Translate a PageKey to its canonical route path. */
export function pageKeyToPath(key: PageKey): string {
  return PAGE_KEY_TO_PATH[key];
}

/** Best-effort reverse lookup of a path → PageKey. Returns null on miss. */
export function pathToPageKey(path: string): PageKey | null {
  // Strip trailing slashes / query / hash before lookup.
  const clean = path.replace(/[?#].*$/, "").replace(/\/$/, "");
  if (PATH_TO_PAGE_KEY[clean]) return PATH_TO_PAGE_KEY[clean];
  // Match deep links — `/pools/abc` → "pool-info" (deep view) or `pools`
  if (clean.startsWith("/pools/")) return "pools";
  if (clean.startsWith("/pool-info/")) return "pool-info";
  if (clean.startsWith("/account-info/")) return "account-info";
  if (clean.startsWith("/accounts/")) return "accounts";
  return null;
}

/**
 * Sidebar order — must match the Alt+1..9 mapping in Design Contract §4.2.
 * Only the first 9 are reachable via hotkeys; the rest are
 * sidebar/Cmd-K-only.
 */
export const PAGE_ORDER: PageKey[] = [
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

// ---------------------------------------------------------------------------
// Outlet wrapper — injects context for all pages
// ---------------------------------------------------------------------------

interface DashboardOutletProps {
  orchestrator: OrchestratorAgent;
  store: MultiRegionStore;
}

const DashboardOutlet: React.FC<DashboardOutletProps> = ({
  orchestrator,
  store,
}) => {
  const navigate = useNavigate();
  const navigateToPage = React.useCallback(
    (target: string) => {
      // Accept both PageKey strings and full paths for backward compat.
      const path = (PAGE_KEY_TO_PATH as Record<string, string>)[target] ?? target;
      navigate(path);
    },
    [navigate],
  );

  const context: DashboardOutletContext = React.useMemo(
    () => ({ orchestrator, store, navigateToPage }),
    [orchestrator, store, navigateToPage],
  );

  return <Outlet context={context} />;
};

// ---------------------------------------------------------------------------
// Per-route adapters — pages still take their existing prop shapes
// ---------------------------------------------------------------------------
//
// Each adapter pulls the orchestrator/store/navigateToPage out of context
// and constructs the legacy props the page component expects. As pages
// migrate to use `useDashboardOutletContext()` directly, these adapters can
// be deleted one-by-one without touching this router.

const PageBoundary: React.FC<
  React.PropsWithChildren<{ pageKey: PageKey }>
> = ({ pageKey, children }) => {
  const { orchestrator } = useDashboardOutletContext();
  const trio = getTrioForPage(pageKey);
  // Each page gets its own boundary keyed by the page so a crash in one
  // page doesn't blank the whole shell, and the boundary auto-resets on
  // navigation. The PageEnhancerShell adds the per-page agent trio
  // (UI panel + tools toolbar + workflow registration) without touching the
  // page's internal JSX.
  return (
    <ErrorBoundary key={`page-${pageKey}`}>
      <PageEnhancerShell
        pageKey={pageKey}
        trio={trio}
        orchestrator={orchestrator}
      >
        {children}
      </PageEnhancerShell>
    </ErrorBoundary>
  );
};

const AzureAccountsRoute: React.FC = () => (
  <PageBoundary pageKey="azure-accounts">
    <AzureAccountsPage />
  </PageBoundary>
);

const OverviewRoute: React.FC = () => {
  const { orchestrator, store, navigateToPage } = useDashboardOutletContext();
  return (
    <PageBoundary pageKey="overview">
      <OverviewPage
        orchestrator={orchestrator}
        store={store}
        onNavigate={(k) => navigateToPage(k as PageKey)}
      />
    </PageBoundary>
  );
};

const AccountsRoute: React.FC = () => {
  const { orchestrator } = useDashboardOutletContext();
  return (
    <PageBoundary pageKey="accounts">
      <AccountProvisioningPage orchestrator={orchestrator} />
    </PageBoundary>
  );
};

const PoolsRoute: React.FC = () => {
  const { orchestrator } = useDashboardOutletContext();
  return (
    <PageBoundary pageKey="pools">
      <PoolCreationPage orchestrator={orchestrator} />
    </PageBoundary>
  );
};

const PoolDefaultsRoute: React.FC = () => (
  <PageBoundary pageKey="pool-defaults">
    <PoolDefaultsPage />
  </PageBoundary>
);

const PoolInfoRoute: React.FC = () => {
  const { orchestrator } = useDashboardOutletContext();
  // The :poolId param is consumed by PoolInfoPage via useParams when
  // present; the same component handles both list and detail views.
  // (Migration leaves PoolInfoPage unchanged for now — it can read params
  // on its own when the deep-link feature is wired in Tier 5.)
  useParams<{ poolId?: string }>();
  return (
    <PageBoundary pageKey="pool-info">
      <PoolInfoPage orchestrator={orchestrator} />
    </PageBoundary>
  );
};

const AccountInfoRoute: React.FC = () => {
  const { orchestrator } = useDashboardOutletContext();
  useParams<{ accountId?: string }>();
  return (
    <PageBoundary pageKey="account-info">
      <AccountInfoPage orchestrator={orchestrator} />
    </PageBoundary>
  );
};

const UnusedQuotaRoute: React.FC = () => {
  const { orchestrator, navigateToPage } = useDashboardOutletContext();
  return (
    <PageBoundary pageKey="unused-quota">
      <UnusedQuotaPage
        orchestrator={orchestrator}
        onNavigate={navigateToPage}
      />
    </PageBoundary>
  );
};

const MonitoringRoute: React.FC = () => {
  const { orchestrator } = useDashboardOutletContext();
  return (
    <PageBoundary pageKey="monitoring">
      <MonitoringPage orchestrator={orchestrator} />
    </PageBoundary>
  );
};

const NodesRoute: React.FC = () => {
  const { orchestrator } = useDashboardOutletContext();
  return (
    <PageBoundary pageKey="nodes">
      <NodesPage orchestrator={orchestrator} />
    </PageBoundary>
  );
};

const GpuCalculatorRoute: React.FC = () => (
  <PageBoundary pageKey="gpu-calculator">
    <GpuCalculatorPage />
  </PageBoundary>
);

const TenantUsersRoute: React.FC = () => {
  const { orchestrator, navigateToPage } = useDashboardOutletContext();
  return (
    <PageBoundary pageKey="tenant-users">
      <TenantUsersPage
        orchestrator={orchestrator}
        onNavigate={(k) => navigateToPage(k as PageKey)}
      />
    </PageBoundary>
  );
};

const UserCreatorRoute: React.FC = () => {
  const { orchestrator, navigateToPage } = useDashboardOutletContext();
  return (
    <PageBoundary pageKey="user-creator">
      <UserCreatorPage
        orchestrator={orchestrator}
        onNavigate={navigateToPage}
      />
    </PageBoundary>
  );
};

const InviteUserRoute: React.FC = () => (
  <PageBoundary pageKey="invite-user">
    <InviteUserPage />
  </PageBoundary>
);

const SubManagerRoute: React.FC = () => (
  <PageBoundary pageKey="sub-manager">
    <SubManagerPage />
  </PageBoundary>
);

const EaBillingManagerRoute: React.FC = () => (
  <PageBoundary pageKey="ea-billing-manager">
    <EaBillingManagerPage />
  </PageBoundary>
);

const ResourceManagerRoute: React.FC = () => (
  <PageBoundary pageKey="resource-manager">
    <ResourceManagerPage />
  </PageBoundary>
);

const SubMoverRoute: React.FC = () => (
  <PageBoundary pageKey="sub-mover">
    <SubMoverPage />
  </PageBoundary>
);

const TokenImporterRoute: React.FC = () => (
  <PageBoundary pageKey="token-importer">
    <TokenImporterPage />
  </PageBoundary>
);

const DepartmentAdminRoute: React.FC = () => (
  <PageBoundary pageKey="department-admin">
    <DepartmentAdminPage />
  </PageBoundary>
);

const LegacyEaSubRoute: React.FC = () => (
  <PageBoundary pageKey="legacy-ea-sub">
    <LegacyEaSubCreatorPage />
  </PageBoundary>
);

const EaSubQuickRoute: React.FC = () => {
  const { navigateToPage } = useOutletContext<DashboardOutletProps>();
  return (
    <PageBoundary pageKey="ea-sub-quick">
      <EaSubQuickPage
        onNavigate={(k) => navigateToPage(k as PageKey)}
      />
    </PageBoundary>
  );
};

const EaCreatorPregrantRoute: React.FC = () => (
  <PageBoundary pageKey="ea-creator-pregrant">
    <EaCreatorPregrantPage />
  </PageBoundary>
);

const PartnerCenterRoute: React.FC = () => {
  const { navigateToPage } = useOutletContext<DashboardOutletProps>();
  return (
    <PageBoundary pageKey="partner-center">
      <PartnerCenterPage
        onNavigate={(k) => navigateToPage(k as PageKey)}
      />
    </PageBoundary>
  );
};

const TasksRoute: React.FC = () => (
  <PageBoundary pageKey="tasks">
    <TaskManagerPage />
  </PageBoundary>
);

const ThrottleRoute: React.FC = () => (
  <PageBoundary pageKey="throttle">
    <ThrottlePage />
  </PageBoundary>
);

const VmCatalogRoute: React.FC = () => (
  <PageBoundary pageKey="vm-catalog">
    <VmCatalogPage />
  </PageBoundary>
);

// ROADtools-inspired defensive audit routes. Each is a self-contained
// read-only enumeration page — no props needed beyond what useArmToken
// and the store already give them.
const RoleGraphRoute: React.FC = () => (
  <PageBoundary pageKey="role-graph">
    <RoleGraphPage />
  </PageBoundary>
);

const SecurityAuditRoute: React.FC = () => (
  <PageBoundary pageKey="security-audit">
    <SecurityAuditPage />
  </PageBoundary>
);

const PrivilegedAuditRoute: React.FC = () => (
  <PageBoundary pageKey="privileged-audit">
    <PrivilegedAuditPage />
  </PageBoundary>
);

const TenantBaselineRoute: React.FC = () => (
  <PageBoundary pageKey="tenant-baseline">
    <TenantBaselinePage />
  </PageBoundary>
);

const TrickyLoginRoute: React.FC = () => (
  <PageBoundary pageKey="tricky-login">
    <TrickyLoginPage />
  </PageBoundary>
);

const AudienceMatrixRoute: React.FC = () => (
  <PageBoundary pageKey="audience-matrix">
    <AudienceMatrixPage />
  </PageBoundary>
);

const EaSubscriptionRoute: React.FC = () => {
  const { orchestrator, navigateToPage } = useDashboardOutletContext();
  return (
    <PageBoundary pageKey="ea-subscription">
      <EaSubscriptionPage
        orchestrator={orchestrator}
        onNavigate={navigateToPage}
      />
    </PageBoundary>
  );
};

/**
 * Audit log route. Renders the extracted, standalone AuditLogPage from
 * `audit-log/audit-log-page.tsx` (search, CSV export, clear, live-subscribed
 * to the auditLog singleton).
 */
const AuditLogRoute: React.FC = () => (
  <PageBoundary pageKey="audit-log">
    <AuditLogPage />
  </PageBoundary>
);

// ---------------------------------------------------------------------------
// Router export
// ---------------------------------------------------------------------------

export interface PageRouterProps {
  orchestrator: OrchestratorAgent;
  store: MultiRegionStore;
}

/**
 * Mounts the full route table under a single `DashboardOutlet`. Place this
 * inside `<HashRouter>` (or the equivalent host router) — it does not own
 * the router itself.
 */
export const PageRouter: React.FC<PageRouterProps> = ({
  orchestrator,
  store,
}) => {
  return (
    <Routes>
      <Route element={<DashboardOutlet orchestrator={orchestrator} store={store} />}>
        <Route index element={<Navigate to="/azure-accounts" replace />} />
        <Route path="/azure-accounts" element={<AzureAccountsRoute />} />
        <Route path="/overview" element={<OverviewRoute />} />
        <Route path="/accounts" element={<AccountsRoute />} />
        <Route path="/accounts/:accountId" element={<AccountInfoRoute />} />
        <Route path="/account-info" element={<AccountInfoRoute />} />
        <Route path="/account-info/:accountId" element={<AccountInfoRoute />} />
        <Route path="/pools" element={<PoolsRoute />} />
        <Route path="/pools/:poolId" element={<PoolInfoRoute />} />
        <Route path="/pool-defaults" element={<PoolDefaultsRoute />} />
        <Route path="/pool-info" element={<PoolInfoRoute />} />
        <Route path="/pool-info/:poolId" element={<PoolInfoRoute />} />
        <Route path="/nodes" element={<NodesRoute />} />
        <Route path="/unused-quota" element={<UnusedQuotaRoute />} />
        <Route path="/monitoring" element={<MonitoringRoute />} />
        <Route path="/gpu-calculator" element={<GpuCalculatorRoute />} />
        <Route path="/audit-log" element={<AuditLogRoute />} />
        <Route path="/tenant-users" element={<TenantUsersRoute />} />
        <Route path="/user-creator" element={<UserCreatorRoute />} />
        <Route path="/invite-user" element={<InviteUserRoute />} />
        <Route path="/sub-manager" element={<SubManagerRoute />} />
        <Route path="/ea-billing-manager" element={<EaBillingManagerRoute />} />
        <Route path="/resource-manager" element={<ResourceManagerRoute />} />
        <Route path="/sub-mover" element={<SubMoverRoute />} />
        <Route path="/token-importer" element={<TokenImporterRoute />} />
        <Route path="/department-admin" element={<DepartmentAdminRoute />} />
        <Route path="/legacy-ea-sub" element={<LegacyEaSubRoute />} />
        <Route path="/ea-sub-quick" element={<EaSubQuickRoute />} />
        <Route path="/ea-creator-pregrant" element={<EaCreatorPregrantRoute />} />
        <Route path="/partner-center" element={<PartnerCenterRoute />} />
        <Route path="/ea-subscription" element={<EaSubscriptionRoute />} />
        <Route path="/role-graph" element={<RoleGraphRoute />} />
        <Route path="/security-audit" element={<SecurityAuditRoute />} />
        <Route path="/privileged-audit" element={<PrivilegedAuditRoute />} />
        <Route path="/tenant-baseline" element={<TenantBaselineRoute />} />
        <Route path="/tricky-login" element={<TrickyLoginRoute />} />
        <Route path="/audience-matrix" element={<AudienceMatrixRoute />} />
        <Route path="/tasks" element={<TasksRoute />} />
        <Route path="/throttle" element={<ThrottleRoute />} />
        <Route path="/vm-catalog" element={<VmCatalogRoute />} />
        <Route path="*" element={<Navigate to="/azure-accounts" replace />} />
      </Route>
    </Routes>
  );
};
