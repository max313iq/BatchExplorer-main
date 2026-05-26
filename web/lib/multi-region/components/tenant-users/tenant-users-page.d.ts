/**
 * Tenant Users page — list users in a privileged tenant, reset passwords
 * (single or bulk), and inspect per-user activity / credentials. Bulk
 * operations stream progress via a sheet drawer with pause / resume /
 * per-row retry; destructive confirmations route through ConfirmationDialog.
 *
 * Design notes (2026-05-24 rewrite):
 *
 *  - The page is account-scoped: changing the account selector cancels
 *    in-flight enrichment + selection (each guarded by a monotonic seq).
 *
 *  - Reset path: identical for single-user and bulk — both call
 *    resetUserPassword, both audit success/failure with full context
 *    (mail, mailNickname guess, accountEnabled-at-time, bulk flag), both
 *    persist the resulting credential into the encrypted vault so the
 *    operator can re-launch a portal sign-in later from User Creator.
 *
 *  - Reset blockers: the dialog warns (does NOT silently allow) when the
 *    target is a guest (#EXT# or external user state), is disabled, or
 *    appears to be on-prem synced. Operator can override after reading.
 *
 *  - Quick filters live in the URL alongside `tenant` + `search`, so deep
 *    links survive reload and back/forward.
 *
 *  - All state derived from the user list (filtered/sorted, summary stats,
 *    selection) recomputes from a single `allRows` memo so the table,
 *    chips, and stats can never disagree.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { type PageKey } from "../shared/sidebar-nav";
export interface TenantUsersPageProps {
    orchestrator: OrchestratorAgent;
    onNavigate?: (key: PageKey) => void;
}
export declare const TenantUsersPage: React.FC<TenantUsersPageProps>;
//# sourceMappingURL=tenant-users-page.d.ts.map