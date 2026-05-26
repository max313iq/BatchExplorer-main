/**
 * Overview page — multi-region dashboard. Surfaces KPIs (accounts/pools/nodes
 * /cores), per-region health, and the unused-quota auto-create workflow.
 *
 * Trend metrics honour the URL-synced [24h | 7d | 30d] range toggle and are
 * derived from the rolling `state.history` buffer (the prior implementation
 * synthesized "trend %" by multiplying a current-state ratio by 1/3/7, which
 * was deterministic but not actually a trend — fixed in this revision).
 *
 * URL state synced here:
 *   - `?range=24h|7d|30d`   trend window
 *   - `?regionSearch=...`   cluster-health region search query
 *   - `?regionStatus=...`   cluster-health quick filter chip (all | healthy
 *                           | degraded | down)
 *   - `?quotaSearch=...`    unused-quota table search query
 *   - `?activity=on|off`    recent-activity panel collapsed state
 *
 * Keyboard shortcuts:
 *   - `r`  → Refresh all (when no input focused)
 *   - `/`  → Focus the unused-quota search box (when the table is visible)
 *   - `1`  → Navigate to Accounts (Batch account list)
 *   - `2`  → Navigate to Pool Info (per-pool details)
 *   - `3`  → Navigate to Nodes (compute-node grid)
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { PageKey } from "../shared/sidebar-nav";
export interface OverviewPageProps {
    orchestrator: OrchestratorAgent;
    store: MultiRegionStore;
    /**
     * Legacy navigation prop kept for backward-compat with the route adapter
     * in `page-router.tsx`. New call sites should rely on the
     * `navigateToPage(path)` helper pulled from `useDashboardOutletContext()`
     * (used internally below). The adapter still threads this prop through,
     * so existing callers keep working unchanged.
     */
    onNavigate: (key: PageKey) => void;
}
export declare const OverviewPage: React.FC<OverviewPageProps>;
//# sourceMappingURL=overview-page.d.ts.map