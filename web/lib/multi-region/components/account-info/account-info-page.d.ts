/**
 * Account Info page — multi-region Azure Batch account browser with URL-synced
 * filters + search, DataTable rendering, fleet-wide quota gauges, and a
 * deep-link `<Sheet>` drawer for per-account details (per-VM-family quota
 * breakdown + raw quota numbers + cross-page links).
 *
 * Operator-facing features:
 *   - Free-text search (account name / region / RG / subscription id) with
 *     `/` to focus, debounced via the shared `useSearch` hook.
 *   - Auto-refresh every 30 s with a live countdown chip + last-refreshed
 *     relative timestamp + stale-data warning if data is older than 5 min.
 *   - Critical / warning summary chips that filter the table by utilization.
 *   - Keyboard shortcuts: `r` refresh, `a` toggle auto-refresh, `/` focus
 *     search, `Escape` clears the sheet (handled by Radix).
 *   - Per-row Copy-account-id button + per-cell info tooltips.
 *   - Sheet split into Overview / Per-VM-family / Related tabs so a long
 *     account doesn't require a scrollbar marathon.
 *   - Top-utilization items in QuotaGlance are clickable → open the sheet.
 *   - Export dropdown (CSV + JSON via the shared ExportMenu) alongside the
 *     DataTable's built-in CSV button.
 *
 * Auth surface is preserved: still uses `useArmToken` + `<TokenExpiryBadge>`
 * sourced from the first signed-in Azure account so the operator gets a
 * heads-up before any sheet "Pools / Nodes / Create pool" navigation that
 * would actually need a fresh ARM token.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
export interface AccountInfoPageProps {
    orchestrator: OrchestratorAgent;
}
export declare const AccountInfoPage: React.FC<AccountInfoPageProps>;
//# sourceMappingURL=account-info-page.d.ts.map