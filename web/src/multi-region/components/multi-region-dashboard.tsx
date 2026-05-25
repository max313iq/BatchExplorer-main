/**
 * Root mount of the multi-region dashboard — wires the store + audit-log
 * binding + error boundary around the `DashboardShell` chrome.
 * Does NOT contain any UI logic; see `dashboard-shell.tsx` for that.
 */
import * as React from "react";

import { MultiRegionStoreProvider } from "../store/store-context";
import { MultiRegionStore } from "../store/multi-region-store";
import {
  bindAuditLogToStore,
  unbindAuditLogFromStore,
} from "../services/audit-log";

import {
  DashboardShell,
  type TokenProvider,
  type HealthCheckResult,
} from "./dashboard-shell";
import { ErrorBoundary } from "./shared/error-boundary";

// Re-exports retained for backward compatibility — `multi-region/index.ts`
// (and any third-party consumers of the package barrel) import these names
// from this file, so we forward them from the new shell module.
export type { TokenProvider, HealthCheckResult };

export interface MultiRegionDashboardProps {
  tokenProvider?: TokenProvider;
}

export const MultiRegionDashboard: React.FC<MultiRegionDashboardProps> = ({
  tokenProvider,
}) => {
  const [store] = React.useState(() => new MultiRegionStore());

  React.useEffect(() => {
    bindAuditLogToStore(store);
    return () => unbindAuditLogFromStore();
  }, [store]);

  return (
    <MultiRegionStoreProvider store={store}>
      <ErrorBoundary>
        <DashboardShell tokenProvider={tokenProvider} />
      </ErrorBoundary>
    </MultiRegionStoreProvider>
  );
};
