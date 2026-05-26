/**
 * Tenant Security Baseline + Service Principal Credentials — defensive
 * tenant auditor inspired by AADInternals' read-only cmdlets.
 *
 * What this page is for:
 *
 *   - Tenant admins audit common Entra ID misconfigs in THEIR OWN tenant
 *     (Tab 1 = Baseline configuration)
 *   - Operations teams track SP password / certificate expiries before
 *     they cause an outage (Tab 2 = Service Principal credentials)
 *
 * What this page is NOT:
 *
 *   - This page never POSTs / PATCHes / DELETEs. It cannot change tenant
 *     configuration or rotate any credential. Every action is a Graph GET.
 *   - It does not access the undocumented MS-DRS / provisioning APIs that
 *     AADInternals reaches for in its offensive code paths. Anything we
 *     surface comes from the public Graph v1.0 surface area.
 *
 * Authentication / scope:
 *
 *   - The page auto-uses the primary signed-in account's *active* tenant
 *     (the same one the operator picked in the global tenant switcher).
 *     Switching account is handled at the global level — no per-page
 *     selector to keep the surface simple.
 *
 * Permissions:
 *
 *   - Required: `Directory.Read.All` (default for any admin role)
 *   - Recommended: `Policy.Read.All` so we can read the security defaults
 *     + authorization policies. Without it, those checks degrade to
 *     "Unknown" with an inline banner.
 *   - Recommended: `RoleManagement.Read.Directory` so the SP admin-role
 *     cross-check works. Without it, all SPs render with hasAdminRole=false.
 *
 * Audit log:
 *
 *   - `action: "tenant_baseline_audit"` once Tab 1 finishes loading.
 *   - `action: "sp_credentials_audit"` once Tab 2 finishes loading.
 *   - `action: "tenant_baseline_snapshot_save"` when the operator saves a
 *     compliance baseline snapshot (Enhancement #1).
 *   - `action: "tenant_baseline_snapshot_clear"` when the snapshot is cleared.
 *   - `action: "tenant_baseline_filter_change"` on Tab 2 filter mutations
 *     (severity / type). Filter changes are inexpensive but recorded so a
 *     reviewer can reconstruct the operator's viewport at the time of audit.
 *
 * Enhancements added (per page-improvement spec):
 *
 *   - Persisted "compliance baseline" snapshot per tenant via usePersistedState
 *     (save + diff current vs saved + clear).
 *   - Drift badges (regressed / improved / changed) per finding card +
 *     aggregated counters in the tab summary row.
 *   - CSV / JSON export via shared ExportMenu (replaces ad-hoc CSV button).
 *   - URL-persisted filter (search / severity / type) on the SP tab via
 *     useUrlState — deep links preserve the operator's view.
 *   - Click-to-copy on tenant id, finding check id, SP appId + display name
 *     via shared CopyButton (replaces inline clipboard helpers).
 *   - "Open in Entra portal" deep link per finding + per SP row.
 *
 * Wiring tightening:
 *
 *   - Initial baseline probe uses useAbortableEffect (abort-on-unmount).
 *   - All ad-hoc clipboard / download utilities replaced with shared
 *     components.
 *   - No edits outside this folder (helpers extension is in
 *     tenant-baseline-helpers.ts).
 */
import * as React from "react";
/**
 * Top-level page export. Combines tenant-scope discovery, both tabs, and
 * a refresh control. Auto-loads both tabs when an active tenant is
 * available.
 */
export declare const TenantBaselinePage: React.FC;
//# sourceMappingURL=tenant-baseline-page.d.ts.map