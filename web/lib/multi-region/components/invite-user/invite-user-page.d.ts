/**
 * Invite User page — bulk B2B guest invitations via Microsoft Graph's
 * `/invitations` endpoint, with an optional follow-up Owner role grant on an
 * Azure subscription.
 *
 * What this page does (in order):
 *   1. Resolves a privileged inviter account (auto-detect via directory
 *      role probe, or manual pick — for tenants whose authorizationPolicy
 *      lets all members invite).
 *   2. Accepts a free-form email list (newline / comma / semicolon
 *      separated), parses it into a deduplicated, validated chip list, and
 *      lets the operator remove individual chips before submit.
 *   3. Submits invites with bounded concurrency (no fan-out storms even
 *      for 50+ recipients) and live per-row progress.
 *   4. Surfaces the redemption URL for every successful invite + one-click
 *      copy / open / TSV-of-all.
 *   5. Optionally assigns the Owner role at the chosen subscription
 *      scope to each newly-invited principal. Failed grants can be
 *      retried individually or in bulk afterwards.
 *
 * Things the page protects against (the inheriting requirements):
 *   - Race conditions: per-row updates are keyed by stable index (not by
 *     `email`, which used to mis-merge when the same address appeared
 *     more than once after a paste-reuse).
 *   - Stale ARM tokens during a long batch: `useArmToken` auto-refreshes
 *     ~60s before expiry. The badge in the header surfaces remaining time.
 *   - Mid-flight cancellation: the operator can stop a running batch
 *     without unmounting the page. Pending rows are marked "cancelled".
 *   - Idempotent re-runs: `assignSubscriptionRole` already handles
 *     `RoleAssignmentExists` — surfaced as "already had it".
 *   - Tenant pollution: invitation goes to the *inviter's* tenant, not
 *     the operator's active tenant. The selector caption spells out the
 *     destination tenantId so it's never ambiguous.
 *
 * Things explicitly NOT changed:
 *   - `useArmToken` + `TokenExpiryBadge` (preserved per spec).
 *   - Existing audit-log shape (`invite_guest`, `assign_subscription_role`).
 *   - No edits to services / store / shared components / page-router.
 */
import * as React from "react";
export declare const InviteUserPage: React.FC;
//# sourceMappingURL=invite-user-page.d.ts.map