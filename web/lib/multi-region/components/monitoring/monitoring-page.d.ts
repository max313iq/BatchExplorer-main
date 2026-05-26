/**
 * Monitoring page — agent status, recent activity, and agent logs with URL-
 * bound filters (range / search / level / agent / status / live-tail), summary
 * stats, dual-format export (CSV + JSON) via the shared ExportMenu, and a
 * correlation-ID extractor that surfaces UUIDs embedded in messages so the
 * operator can one-click copy them for cross-referencing audit / agent traces.
 *
 * Design notes:
 *   - All filter state survives reload / sharing via URL params (Contract §4.3).
 *   - Active filters render as removable chips above the tables.
 *   - The two tables (Activity + Logs) read from a single computed view layer
 *     so summary counters, sparklines, and visible rows stay in lockstep.
 *   - `parseTimestamp` returns `NaN` for unparseable inputs (instead of 0,
 *     which silently bucketed bad rows into the Unix epoch and dropped them
 *     from every time window) — rows with invalid timestamps now surface in
 *     a discrete "Unknown time" row at the top so they're never invisible.
 *   - Log message correlation IDs are parsed via a centralized regex; the
 *     extracted ID flows into both the rendered cell and the export accessor
 *     so CSV/JSON downloads preserve the dimension you can actually grep on.
 *   - Live-tail mode flags entries that arrived since the previous refresh
 *     tick so the operator can see at-a-glance what is new without re-reading
 *     the whole list.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
export interface MonitoringPageProps {
    orchestrator: OrchestratorAgent;
}
export declare const MonitoringPage: React.FC<MonitoringPageProps>;
//# sourceMappingURL=monitoring-page.d.ts.map