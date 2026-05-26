/**
 * Root mount of the multi-region dashboard — wires the store + audit-log
 * binding + error boundary around the `DashboardShell` chrome.
 * Does NOT contain any UI logic; see `dashboard-shell.tsx` for that.
 */
import * as React from "react";
import { type TokenProvider, type HealthCheckResult } from "./dashboard-shell";
export type { TokenProvider, HealthCheckResult };
export interface MultiRegionDashboardProps {
    tokenProvider?: TokenProvider;
}
export declare const MultiRegionDashboard: React.FC<MultiRegionDashboardProps>;
//# sourceMappingURL=multi-region-dashboard.d.ts.map