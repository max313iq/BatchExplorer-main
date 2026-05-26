/**
 * Root mount of the multi-region dashboard — wires the store + audit-log
 * binding + error boundary around the `DashboardShell` chrome.
 * Does NOT contain any UI logic; see `dashboard-shell.tsx` for that.
 */
import * as React from "react";
import { MultiRegionStoreProvider } from "../store/store-context";
import { MultiRegionStore } from "../store/multi-region-store";
import { bindAuditLogToStore, unbindAuditLogFromStore, } from "../services/audit-log";
import { DashboardShell, } from "./dashboard-shell";
import { ErrorBoundary } from "./shared/error-boundary";
export const MultiRegionDashboard = ({ tokenProvider, }) => {
    const [store] = React.useState(() => new MultiRegionStore());
    React.useEffect(() => {
        bindAuditLogToStore(store);
        return () => unbindAuditLogFromStore();
    }, [store]);
    return (React.createElement(MultiRegionStoreProvider, { store: store },
        React.createElement(ErrorBoundary, null,
            React.createElement(DashboardShell, { tokenProvider: tokenProvider }))));
};
//# sourceMappingURL=multi-region-dashboard.js.map