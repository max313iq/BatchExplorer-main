/**
 * Partner Center page — checks whether a signed-in Azure account can
 * operate against Microsoft Partner Center as a Cloud Solution
 * Provider (CSP) partner and/or carries a Microsoft Partner Network
 * (MPN) profile, and manages the Partner Admin Link (PAL) used by
 * Microsoft to attribute Azure consumption back to a partner of
 * record.
 *
 * The page is read-mostly: four lightweight probes that the operator
 * fires on demand. The only mutating actions are linking / unlinking
 * a Partner ID via ARM's `Microsoft.ManagementPartner` resource type,
 * both gated behind an audited confirmation flow.
 *
 * UX choices worth calling out:
 *   - Probe runs are audited even on success — the operator's history
 *     should be reproducible (what did we check, when, against whom).
 *   - All errors are surfaced to the UI; no silent `.catch(() => {})`.
 *     A failed probe shows a banner with the AAD error code +
 *     remediation hint (sign in with a different identity, or pivot
 *     to Token Importer).
 *   - Keyboard shortcuts: `Mod+Enter` runs all probes, `Mod+L` focuses
 *     the Partner-ID input, `Mod+Shift+R` re-runs only the probes that
 *     previously failed (cheap retry after fixing tenant / consent).
 *   - Stale-write guard: switching accounts mid-flight cancels the
 *     write-back of in-flight results to the new account's slot.
 */
import * as React from "react";
import { type PageKey } from "../shared/sidebar-nav";
export interface PartnerCenterPageProps {
    /**
     * Legacy navigation callback retained for backward compat with the
     * `<PartnerCenterPage onNavigate={...}/>` adapter in page-router. New
     * call sites should rely on `useDashboardOutletContext().navigateToPage`
     * directly. When both are present, `navigateToPage` wins.
     */
    onNavigate?: (k: PageKey) => void;
}
export declare const PartnerCenterPage: React.FC<PartnerCenterPageProps>;
//# sourceMappingURL=partner-center-page.d.ts.map