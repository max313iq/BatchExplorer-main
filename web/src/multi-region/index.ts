// Store
export { MultiRegionStore } from "./store/multi-region-store";
export {
  MultiRegionStoreProvider,
  useMultiRegionStore,
  useMultiRegionState,
  useDashboardStats,
  useMultiRegionSelector,
} from "./store/store-context";
export * from "./store/store-types";
export type {
  ToastNotification,
  WorkflowState,
  UserPreferences,
  WorkflowStep,
} from "./store/store-types";

// Pool defaults
export {
  loadPoolDefaults,
  savePoolDefaults,
  resetPoolDefaults,
  buildPoolConfigFromDefaults,
  INITIAL_POOL_DEFAULTS,
} from "./store/pool-defaults";
export type {
  PoolDefaults,
  StartTaskConfig,
  VmConfig,
  ImageReference,
  EnvSetting,
  ResourceFile,
  UserAccount,
  MetadataItem,
  ScaleType,
  TaskSchedulingPolicy,
  OsCategory,
} from "./store/pool-defaults";

// Scheduling
export { RequestScheduler } from "./scheduling/request-scheduler";
export type { RequestSchedulerOptions } from "./scheduling/request-scheduler";

// Agents
export * from "./agents/agent-types";
export { OrchestratorAgent } from "./agents/orchestrator-agent";
export { ProvisionerAgent } from "./agents/provisioner-agent";
export { FilterAgent } from "./agents/filter-agent";
export { PoolAgent } from "./agents/pool-agent";

// Components
export { MultiRegionDashboard } from "./components/multi-region-dashboard";
export type {
  TokenProvider,
  MultiRegionDashboardProps,
  HealthCheckResult,
} from "./components/multi-region-dashboard";
export { ToastContainer } from "./components/shared/toast-container";
export { ErrorBoundary } from "./components/shared/error-boundary";
export { SidebarNav } from "./components/shared/sidebar-nav";
export type { PageKey } from "./components/shared/sidebar-nav";
export { ActivityPanel } from "./components/shared/activity-panel";
export { LoadingSkeleton } from "./components/shared/loading-skeleton";

// Page components
export { OverviewPage } from "./components/overview/overview-page";
export { AccountProvisioningPage } from "./components/account-provisioning/account-provisioning-page";
export { PoolCreationPage } from "./components/pool-creation/pool-creation-page";
export { PoolInfoPage } from "./components/pool-info/pool-info-page";
export { AccountInfoPage } from "./components/account-info/account-info-page";
export { UnusedQuotaPage } from "./components/unused-quota/unused-quota-page";
export { NodesPage } from "./components/nodes/nodes-page";
export { TenantUsersPage } from "./components/tenant-users/tenant-users-page";
export { EaSubscriptionPage } from "./components/ea-subscription/ea-subscription-page";
export { UserCreatorPage } from "./components/user-creator/user-creator-page";
export type { UserCreatorPageProps } from "./components/user-creator/user-creator-page";

// Constants & Helpers
export { AZURE_REGIONS } from "./components/shared/constants";
export {
  classifyError,
  getActionableErrorMessage,
} from "./components/shared/error-helpers";
export type {
  ActionableError,
  BatchApiError,
  ErrorClassification,
} from "./components/shared/error-helpers";

// VM Sizes
export type { VmSizeInfo } from "./components/shared/vm-sizes";
export {
  getVmSizeInfo,
  getVCpus,
  getMaxNodes,
  getGpuVmSizes,
  getVmFamilyName,
  getAllVmSizes,
} from "./components/shared/vm-sizes";

// Audit log
export { auditLog } from "./services/audit-log";
export type { AuditEntry } from "./services/audit-log";

// Theme
export { ThemeProvider, useTheme } from "./components/shared/theme-provider";
export type {
  ThemeMode,
  ThemeContextValue,
} from "./components/shared/theme-provider";

// Skeleton
export { SkeletonLoader } from "./components/shared/skeleton-loader";
export type {
  SkeletonVariant,
  SkeletonLoaderProps,
} from "./components/shared/skeleton-loader";

// Confirmation
export { ConfirmationDialog } from "./components/shared/confirmation-dialog";
export type { ConfirmationDialogProps } from "./components/shared/confirmation-dialog";

// Hooks
export { usePagination } from "./hooks/use-pagination";
export { useSearch } from "./hooks/use-search";
