/**
 * Dashboard chrome — composes the sidebar, header bars, page router, and
 * global overlays (activity panel, command menu, keyboard help, toasts).
 * Replaces the legacy `DashboardContent` in `multi-region-dashboard.tsx`.
 */
import * as React from "react";
import { MultiRegionStore } from "../store/multi-region-store";
export interface HealthCheckResult {
    healthy: boolean;
    error: string | null;
}
/**
 * Optional token provider that, when supplied, overrides the proxy-based
 * token fetching. This allows the desktop Electron app to inject its own
 * MSAL-based auth without needing a dev server proxy.
 */
export interface TokenProvider {
    getAccessToken: () => Promise<string>;
    getBatchAccessToken: () => Promise<string>;
    checkHealth: () => Promise<HealthCheckResult>;
    loadSubscriptions: (store: MultiRegionStore) => Promise<void>;
}
export interface DashboardShellProps {
    tokenProvider?: TokenProvider;
}
export declare const DashboardShell: React.FC<DashboardShellProps>;
//# sourceMappingURL=dashboard-shell.d.ts.map