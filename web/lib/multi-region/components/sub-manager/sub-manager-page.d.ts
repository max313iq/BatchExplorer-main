/**
 * Sub Manager — subscription-scope RBAC management.
 *
 * Lets the operator pick one of their signed-in accounts, pick a
 * subscription that account can see, and then:
 *   - List every role assignment at that subscription's scope (resolving
 *     principal GUIDs to display names via Graph).
 *   - Filter / search by role, principal type, scope, kind, and "stale"
 *     (couldn't-resolve) status.
 *   - Select rows to bulk-delete (Azure only allows deletes at the
 *     scope the assignment was created at — inherited rows are shown
 *     but locked).
 *   - Add a new assignment by UPN/email or raw object id, with a role
 *     picker that lists every built-in + custom role visible at the
 *     subscription scope.
 *   - Group-by-role view, sortable list, exportable CSV/JSON, quick
 *     "Remove me" shortcut for the common "leave a sub" case.
 *
 * Self-protection: removing the signed-in operator OR the only remaining
 * Owner requires an extra confirm. Audit log records every mutation —
 * both success and failure paths.
 *
 * URL sync: ?tab, ?account, ?sub, ?ba are all kept in sync so links
 * deep-link straight into the right view. SessionStorage is the fallback
 * so reopening the page restores the last picker state.
 *
 * Keyboard: `/` focuses the search box, `Esc` clears selection.
 */
import * as React from "react";
export declare const SubManagerPage: React.FC;
//# sourceMappingURL=sub-manager-page.d.ts.map