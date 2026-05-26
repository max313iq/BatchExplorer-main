/**
 * Defender-side surface: tenant-user anomaly hunt. Operator-triggered (never
 * runs automatically on render) because the most expensive detector here
 * issues a Graph `$batch` round-trip for every visible guest's role
 * memberships — useful, but not free.
 *
 * Three detectors, every one wired to the offensive-tooling corpus:
 *
 *   1. **External (guest) users holding admin-tier directory roles.**
 *      The corpus ranks "Stale guest with role" as the #3 stealth foothold
 *      across all cross-tenant tricks (`_bypass_tenant_switch.md` §11 table
 *      and §12 item 2 — "find dormant guest accounts with active roles;
 *      revive via password reset"). Defender-side this is the highest-
 *      value signal on a tenant user list: a guest UPN (#EXT# or
 *      mismatched-mail-domain) plus Tier-0 / Tier-1 role membership.
 *      Tier-0 ids come from `_bypass_role_grant.md` and are the same set
 *      we score in `tenant-users-deleted-panel.tsx`.
 *
 *   2. **Disabled accounts with subscription-role footholds.**
 *      `accountEnabled === false` users normally have no operational
 *      value to a defender; a disabled user that still owns subscription
 *      role assignments is a configuration leak ("ghost owner") that the
 *      corpus calls out under `_bypass_modify_delete.md` §4 lifecycle ops
 *      — the move there is "soft-disable rather than delete, then leave
 *      role assignments behind for later reactivation." We surface them
 *      so the defender can clean them up.
 *
 *   3. **Rapid create-then-delete on the same UPN.**
 *      Cross-references this WebUI's local audit log (`create_user`
 *      entries from User Creator) against the soft-delete bucket
 *      (`deletedRows` — Graph `/directory/deletedItems/microsoft.graph.user`).
 *      When a `create_user` audit entry and a soft-delete share a UPN
 *      and the delete happened within `RAPID_WINDOW_HOURS` of the
 *      create, that's a textbook cleanup of attacker scaffolding —
 *      `_bypass_modify_delete.md` §4.7 calls out "Defender's investigation
 *      may miss the user during this window" as the explicit attacker
 *      tactic. The signal only fires when both halves are observable, so
 *      this is deliberately conservative (will miss out-of-band creates
 *      whose audit entry never reached this WebUI).
 *
 * Defensive-only constraints (same as `tenant-users-deleted-panel.tsx`):
 *
 *   - This panel NEVER calls a state-changing primitive. No PATCH, no
 *     DELETE, no POST. The only Graph traffic is the batched memberOf GET
 *     in detector #1, and we already have that bulk API in the service
 *     layer (`getUserDirectoryRolesBatched`).
 *
 *   - Remediation is portal deep-links — the operator clicks through and
 *     the audit-log entry records their *intent*, not any change made by
 *     this WebUI.
 */
import * as React from "react";
import { type AuditEntry } from "../../services/audit-log";
import type { DeletedUserRow } from "./tenant-users-deleted-panel";
/**
 * Minimal subset of `UserRow` from the host page that the panel needs.
 * Declared inline (not imported) so this file stays a leaf in the
 * tenant-users folder dependency graph.
 */
export interface AnomalyUserRow {
    id: string;
    displayName: string;
    userPrincipalName: string;
    mail: string | null;
    accountEnabled: boolean;
    isGuest: boolean;
    subscriptionCount: number;
    createdDateTime?: string;
}
export interface TenantUsersAnomaliesPanelProps {
    tenantId: string | null;
    homeAccountId: string | null;
    actor: string | null;
    /** Source-of-truth: every visible (post-search-and-filter) user. */
    rows: ReadonlyArray<AnomalyUserRow>;
    /** Deleted-users surface — feeds the rapid create→delete detector. */
    deletedRows: ReadonlyArray<DeletedUserRow>;
    /** Local audit-log entries — feeds the rapid create→delete detector. */
    auditEntries: ReadonlyArray<AuditEntry>;
}
export declare const TenantUsersAnomaliesPanel: React.FC<TenantUsersAnomaliesPanelProps>;
//# sourceMappingURL=tenant-users-anomalies-panel.d.ts.map