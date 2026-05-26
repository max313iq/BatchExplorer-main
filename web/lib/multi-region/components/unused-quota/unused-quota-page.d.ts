/**
 * Unused Quota page — surfaces accounts with free LP cores and offers
 * bulk auto-create of pools or hand-off to Smart Mode pool creation.
 *
 * 2026-05-26 wave-2 highlights (corpus-grounded + advanced-UI):
 *   - Anomaly detection: subscriptions with disproportionate (>=80%)
 *     unused-quota share trigger a callout banner. Cites the defender
 *     POV that idle capacity can indicate either over-allocation or an
 *     attacker pre-reserving capacity for a pivot. See
 *     `New folder\_analysis_defender_view.md` § "Hunting / Detection
 *     Indicators".
 *   - Auto-create attack-surface warning: mass-created pools inherit
 *     `poolDefaults`. If those defaults carry a privileged start-task
 *     or a permissive identity, mass-creation amplifies attack surface
 *     (NetSPI MicroBurst: each new pool node is a fresh IMDS endpoint,
 *     each fresh-node start-task runs as the pool managed identity).
 *     See `New folder\_analysis_netspi.md` § I "IMDS Variants" and
 *     § II "RunAs Certificate Abuse".
 *   - Bulk auto-create progress bar + ARIA-live per-group announcer.
 *   - Hotkey `Ctrl+Enter` to commit bulk auto-create from the drawer.
 *   - Persisted "excluded subscriptions" allowlist that strips matching
 *     rows from the bulk plan before submit and is surfaced as a chip.
 *   - In-session sparkline of `totalFreeLpCores` across refresh ticks.
 *   - Race-guard on submit: only the latest submit controller writes
 *     `submitResults` / `autoCreateSubmitting`. Previously a re-enter
 *     could flip the submitting flag mid-flight.
 *
 * 2026-05-24 rewrite highlights:
 *   - FIX: bulk auto-create now dispatches `create_pools` (plural, the
 *     real action) grouped by `(vmSize, maxLpNodes)`. The previous code
 *     called `action: "create_pool"` (singular), which is NOT a valid
 *     OrchestratorAction and threw "Unknown action" at runtime, so the
 *     drawer's "Auto-Create Pools" button silently no-op'd.
 *   - Search input over account name + subscription id + region.
 *   - Filter chips: regions (URL-synced), GPU-only, resizing-state,
 *     min-free-LP-cores threshold (slider in the toolbar).
 *   - Expanded summary stats including free dedicated cores, distinct
 *     regions, and the *spawn-able* node total across selected rows.
 *   - Per-row override of VM size + node count in the bulk drawer, with
 *     live total of cores that will be consumed.
 *   - Result panel inside the drawer after submit: per-row created /
 *     failed status with a "Retry failed only" affordance.
 *   - CopyableText for account name + subscription id + suggested VM —
 *     hover any row cell and a small copy icon appears.
 *   - Inline InfoTooltips on every column header (LP quota, dedicated
 *     quota, suggested VM logic, max nodes formula, resizing meaning).
 *   - Page-level ExportMenu (CSV + JSON) for the current filtered view,
 *     in addition to the DataTable's column-scoped CSV button.
 *   - Keyboard: `/` to focus search, `Esc` to clear selection / close
 *     drawer, `r` to refresh.
 *   - Selection persisted in URL (`sel=id1,id2,...`) so a refresh /
 *     deep-link preserves the bulk-action set.
 *   - Per-row quick actions: "Use this row in Smart Mode" and "Copy
 *     account JSON" to support one-off operator workflows.
 *
 * Preserves: useArmToken + TokenExpiryBadge (Pattern A), live-catalog
 * wire toggle + persistence, ErrorBoundary, region-rollup cards.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
export interface UnusedQuotaPageProps {
    orchestrator: OrchestratorAgent;
    /**
     * @deprecated Path-based navigation now comes from
     * `useDashboardOutletContext().navigateToPage`. Kept for backward
     * compatibility with the existing page-router adapter, which still
     * threads it through. New callers should rely on the context wiring
     * and ignore this prop.
     *
     * COORDINATOR: when the migration is complete and no caller still
     * passes `onNavigate`, drop this prop from the interface and from the
     * page-router adapter at `UnusedQuotaRoute` (page-router.tsx ~ line 370).
     */
    onNavigate?: (path: string) => void;
}
export declare const UnusedQuotaPage: React.FC<UnusedQuotaPageProps>;
//# sourceMappingURL=unused-quota-page.d.ts.map