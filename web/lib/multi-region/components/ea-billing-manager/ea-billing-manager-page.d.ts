/**
 * EA Billing Manager — operator console for the Microsoft.Billing REST
 * surface at billing-account scope. Wires every EA-relevant endpoint
 * into a tabbed UI so an EA admin can inspect and mutate billing state
 * without dropping to az cli.
 *
 * Tabs:
 *   Overview         — billingProperty + agreements + permissions summary.
 *   Permissions      — actions/notActions array the caller actually holds.
 *   Role Assignments — list + add (any role definition) + delete.
 *   Departments      — list (read-only; legacy EA structure).
 *   Enrollment Accts — list (already used by Create EA Sub).
 *   Subscriptions    — list of subs billed under this account.
 *   Invoices         — last-12-months list with download URLs.
 *   Reservations     — tenant-wide reservation orders.
 *   Policies         — purchase / dev-test policy editor.
 *
 * Future endpoints that aren't yet wired (transactions, transfers,
 * recipient transfers, custom billing roles, billingProfiles edit,
 * billingSubscription move/cancel) are listed at the bottom of the
 * page as "available via API" placeholders so the next iteration has
 * a checklist.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
export declare const EaBillingManagerPage: React.FC;
export declare const _EaMgrIcons: {
    AlertTriangle: React.ForwardRefExoticComponent<Omit<import("lucide-react").LucideProps, "ref"> & React.RefAttributes<SVGSVGElement>>;
    ChevronRight: React.ForwardRefExoticComponent<Omit<import("lucide-react").LucideProps, "ref"> & React.RefAttributes<SVGSVGElement>>;
    Users: React.ForwardRefExoticComponent<Omit<import("lucide-react").LucideProps, "ref"> & React.RefAttributes<SVGSVGElement>>;
    cn: typeof cn;
};
//# sourceMappingURL=ea-billing-manager-page.d.ts.map