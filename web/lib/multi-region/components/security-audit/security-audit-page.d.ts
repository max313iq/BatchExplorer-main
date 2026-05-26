/**
 * Storage & Key Vault Security Audit page.
 *
 * Defensive auditor inspired by NetSPI's MicroBurst toolkit. The
 * operator picks one or more accessible subscriptions; the page calls
 * ARM directly (read-only) to list every storage account and key
 * vault, evaluates each one against the rule set in
 * `security-audit-helpers.ts`, and renders the resulting findings
 * with severity badges, copy-id buttons, Portal deep-links, and
 * CSV / JSON exports.
 *
 * Why this is OK for a defensive audit (the line vs. MicroBurst):
 *   - MicroBurst's Invoke-EnumerateAzureBlobs and Invoke-EnumerateAzure
 *     SubDomains attack the *anonymous* surface — they probe sub-
 *     domains the operator may not own. We do NONE of that here:
 *     this page lists the operator's OWN resources via authenticated
 *     ARM calls and only reports config-level issues.
 *   - Every call is GET. No POST/PATCH/DELETE. Worst-case impact is
 *     the operator's ARM throttle budget.
 *
 * Hard constraints honored:
 *   - New files only (no edits to services / auth / store / router /
 *     sidebar / shared components).
 *   - useArmToken + TokenExpiryBadge.
 *   - Pagination via @odata.nextLink.
 *   - 403 subs surface as inline warning rows; we keep scanning the
 *     others.
 */
import * as React from "react";
export declare const SecurityAuditPage: React.FC;
//# sourceMappingURL=security-audit-page.d.ts.map