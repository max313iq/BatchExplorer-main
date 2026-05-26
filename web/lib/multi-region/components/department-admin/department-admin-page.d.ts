/**
 * Department Admin — focused workspace for an EA department admin.
 *
 * Picker cascade: source account → EA billing account → department.
 *
 * Once a department is selected we surface:
 *   - Department metadata (name, cost center, status, ARM id, EA count).
 *   - Enrollment accounts that live under THIS department (scoped via
 *     /departments/{name}/enrollmentAccounts).
 *   - The billing subscriptions billed through each enrollment account.
 *   - "Create subscription" pivots to /ea-subscription with the picked
 *     enrollment account pre-seeded (sessionStorage hint that the EA
 *     Sub page consumes on mount). A ConfirmationDialog now stands
 *     between the click and the navigation so the operator sees exactly
 *     which EA is about to be pre-filled.
 *   - "Grant EA Subscription Creator" pivots to /sub-manager with the
 *     billing-account pre-seeded — so the admin can give a teammate
 *     subscription-creation rights without leaving this workspace.
 *
 * Architectural rules preserved through this rewrite:
 *   - The DEPARTMENT-scoped billingSubscriptions endpoint is used (the
 *     billing-account-scope variant 403s for Department Admins). This
 *     is the correct narrower scope — do NOT pivot back to the wider
 *     endpoint.
 *   - useArmToken + TokenExpiryBadge stay wired exactly as before so
 *     mid-survey token rolls don't 401 the operator.
 *   - All mutating actions still route through the existing pages
 *     (sub-manager, ea-subscription) so audit + auth flows stay
 *     consistent.
 *
 * Resilience added in this rewrite:
 *   - Sequence guards on EAs and subs so a quick department-switch
 *     can't let a stale fetch's response overwrite the new scope's
 *     list (was previously partly fixed; now applied uniformly).
 *   - The shared `armToken` state is properly cleared when the central
 *     `useArmToken` tracker loses its token (account swap), so child
 *     effects don't keep firing against a stale credential.
 *   - "Orphaned" subs — a sub whose `invoiceSectionDisplayName`
 *     doesn't match any EA we listed — are surfaced as their own
 *     bucket rather than silently dropped from the per-EA view.
 *   - Pivot confirmation surfaces the destination + exact pre-fill
 *     payload, so the operator can cancel before sessionStorage is
 *     mutated and routing happens.
 */
import * as React from "react";
export declare const DepartmentAdminPage: React.FC;
//# sourceMappingURL=department-admin-page.d.ts.map