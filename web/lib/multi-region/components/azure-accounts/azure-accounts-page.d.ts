/**
 * Azure Accounts page — manages signed-in AAD accounts, their subscriptions,
 * and active-tenant selection. Drawer-based detail view with DataTable list.
 *
 * Layered improvements vs. the original:
 *   - URL state (`?status=`, `?q=`, `?account=`, `?tab=`) so deep links
 *     resume the operator exactly where they left off.
 *   - Global search box (name / username / tenant / sub id), debounced,
 *     restored from `?q=` on mount.
 *   - Quick-filter chips for status with live counts.
 *   - Bulk-select with bulk refresh / re-login / remove (single
 *     `ConfirmationDialog` shared with the per-row remove flow).
 *   - Per-row "Refresh subs" action so the operator doesn't need to
 *     refresh the entire account list to recover a single 401.
 *   - Per-row "Copy" affordances for username + home account id; per-row
 *     subscription rows in the drawer get inline copy too.
 *   - Centralized tenant-switch helper — the drawer + the inline row
 *     dropdown both call it; removes ~120 lines of near-duplicate code
 *     that had drifted slightly out of sync.
 *   - AbortController on the long-running per-account subs fetch so a
 *     refresh fired mid-unmount cancels in-flight HTTP calls instead of
 *     racing the cancelled-flag.
 *   - NaN/Invalid-Date guards on `addedAt` so a corrupted persisted blob
 *     doesn't print "Invalid Date" or crash the table.
 *   - Drawer tabs (`Tenants` / `Subscriptions` / `Details`) so the body
 *     stays focused and `?tab=` lets the operator deep-link to a
 *     specific drawer view.
 *   - Re-probe directory roles after a tenant switch (the previous
 *     version reset the ref but the effect never re-ran because its
 *     deps didn't change — the probe was silently stale).
 *   - ExportMenu (CSV / JSON) for the visible/filtered account list.
 *   - SummaryStatItem from `shared/` (not a local re-implementation)
 *     for visual consistency with audit-log and other list pages.
 *   - Audit log on success+failure for refresh-all and per-row refresh.
 *   - Sign-in chord (`mod+shift+l`) to open the sign-in field even when
 *     the list is non-empty.
 */
import * as React from "react";
/**
 * Browser-side event other pages listen for to refresh state after a
 * tenant switch. Detail carries `{ homeAccountId, tenantId,
 * fromTenantId }` so each listener can decide whether the change
 * affects its current data set.
 *
 * The constant lives in `hooks/tenant-changed-event` so it can be
 * shared by `auth/perform-tenant-switch` (the emitter), the listener
 * hook, and the header tenant switcher without a circular import
 * through this page. Re-exported here so existing imports
 * (`from ".../azure-accounts-page"`) keep resolving without churn.
 */
export { TENANT_CHANGED_EVENT } from "../../hooks/tenant-changed-event";
/**
 * Best-effort wipe of any page-scoped browser cache the Azure Accounts
 * page may have written. The page itself doesn't store anything in
 * localStorage (the store layer handles persistence under
 * `multi-region-sessions`), but other consumers — notably
 * `dashboard-shell`'s "Clear sign-in cache" recovery path — import
 * this symbol to belt-and-braces flush every layer when the operator
 * resets MSAL. Keeping the stub here means the import resolves even
 * if a future revision adds genuine page-scope cache writes; the body
 * stays a no-op until that day.
 *
 * Failures are swallowed; the caller already wraps every invocation
 * in its own try/catch and treats this as a best-effort.
 */
export declare function purgeAccountsCache(): void;
export declare const AzureAccountsPage: React.FC;
//# sourceMappingURL=azure-accounts-page.d.ts.map