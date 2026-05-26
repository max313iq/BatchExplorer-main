/**
 * Subscription Mover — bulk move EA-billing subscriptions either:
 *   A. Between enrollment accounts (billing-ownership transfer inside the
 *      same EA billing account), via:
 *        POST /billingAccounts/{ba}/billingSubscriptions/{name}/move
 *        body: { destinationEnrollmentAccountId }
 *   B. To another AAD tenant (Change directory), via:
 *        POST /providers/Microsoft.Subscription/subscriptions/{id}/changeTenant
 *        body: { properties: { tenantId } }
 *
 * Design notes for this iteration:
 *   - Both endpoints respond 202 + Azure-AsyncOperation / Location. Previously
 *     the page just recorded the accept and stopped there; the operator had
 *     to copy the poll URL into Postman to find out whether Azure ever
 *     actually finished. We now poll the long-running op (with backoff +
 *     Retry-After) page-side until it Succeeds, Fails, or the operator
 *     aborts. Polling is wired into the same AbortController as the batch
 *     so abort actually halts everything (not just future rows).
 *   - Rows are processed with a small (operator-configurable) concurrency
 *     pool — sequential is still the default (1) so the audit log is one
 *     row per op, but operators with hundreds of subs can crank it to 3/5/10.
 *   - Row identity is the full ARM `id` (`/providers/.../billingSubscriptions/{name}`).
 *     Earlier code keyed on `subscriptionId ?? name`, which can collide if
 *     a billing-sub row doesn't yet have an AAD subscriptionId (the field
 *     can be empty on partially-provisioned subs) and a second row shares
 *     the same `name` across billingProfiles.
 *   - Pre-flight warnings are expanded: token-expiry, no-op rows (already
 *     on the destination enrollment account), large-batch (>50), and the
 *     existing non-Enabled / missing-subId / same-tenant guards. An auto-
 *     skip toggle lets the operator filter the selection to "viable" rows
 *     before pressing Confirm.
 *   - The result list gains "Rerun failed", "Clear results", per-row
 *     "Copy as cURL" (for off-tab replay), and a live throughput stat. The
 *     export now captures startedAt + durations.
 */
import * as React from "react";
export declare const SubMoverPage: React.FC;
//# sourceMappingURL=sub-mover-page.d.ts.map