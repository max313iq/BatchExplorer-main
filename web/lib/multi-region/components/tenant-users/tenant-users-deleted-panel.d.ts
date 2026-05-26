/**
 * Defender-side surface: recently soft-deleted users (the 30-day recovery
 * window). Wired from the offensive-tooling corpus as a READ-ONLY signal
 * for an operator running this tool against THEIR OWN tenant — the page
 * never invokes the hard-delete / restore primitive itself; it surfaces
 * the trail and provides a portal deep-link so any remediation is done
 * by the operator in the audited Azure Portal UI.
 *
 * Corpus citations (see CLAUDE.md "Primary research resource"):
 *
 *   - `_AZURE_BYPASS_PLAYBOOK.md` §"Critical Defender Audit Surface" item 9
 *     ("Hard delete user" Entra audit event) — this is one of the top
 *     ten signals a defensive program should alert on.
 *
 *   - `_bypass_modify_delete.md` §4.7 — soft-delete moves a user to
 *     `/directory/deletedItems/microsoft.graph.user` for 30 days before
 *     permanent removal. The attacker tactic the playbook calls out is
 *     "Defender's investigation may miss the user during this window."
 *
 *   - `_bypass_modify_delete.md` §4.9 — permanent hard-delete (`DELETE
 *     /v1.0/directory/deletedItems/<user-id>`) is unrecoverable; the
 *     playbook flags it as "evidence destruction (last resort, scorched
 *     earth)." This panel is the inverse of that capability: it lets the
 *     defender see WHO is sitting in the soft-delete bucket so they
 *     either restore them (portal) or notice an unexplained delete.
 *
 *   - Canonical corpus tool for user lifecycle is Gerenios/AADInternals
 *     (see CLAUDE.md curated index "Gerenios\ — 4 .md files / 3 repos").
 *     The wire shape (object id + displayName + UPN-at-deletion +
 *     deletedDateTime) matches what AADInternals' Get-AADIntUsers/
 *     -DeletedUsers cmdlets surface; same shape as Graph's
 *     `/directory/deletedItems/microsoft.graph.user`.
 *
 * Severity model (defender perspective — corpus item 9):
 *
 *   - critical = the deleted user held a Tier-0 directory role at the
 *     moment of deletion (Global Admin, Privileged Authentication Admin,
 *     User Administrator, etc.). Attackers commonly delete the user
 *     they were imitating right before a hard-delete to break sign-in
 *     correlation in the audit log. Tier-0 role detection is not
 *     available in the current Graph scope, so this column shows the
 *     last-known role list from the audit log enrichment (see
 *     `rolesAtDeletion` in the row shape) if the operator's corpus
 *     extension has populated it; otherwise the badge stays at "high"
 *     or "medium" based on recency.
 *
 *   - high = deleted in the last 7 days (operator should still be able
 *     to talk to the user / their manager about it).
 *
 *   - medium = deleted in last 30 days but older than 7 days.
 *
 * Permission gate: requires `Directory.AccessAsUser.All` (delegated) or
 * `User.Read.All` (app-only) on the caller. When the caller does not
 * have those grants, the panel surfaces a "Permission required" hint
 * instead of silently failing.
 *
 * IMPORTANT — defensive-only constraint: this component MUST NEVER
 * call `DELETE /v1.0/directory/deletedItems/<id>` (hard-delete) or
 * `POST /directory/deletedItems/<id>/restore`. Restore surfaces as a
 * portal deep-link the operator clicks through; the audit-log entry
 * is for the *click* (operator intent), not for any state change made
 * by this WebUI.
 */
import * as React from "react";
/**
 * Shape of one row in the deleted-users surface. Mirrors the subset of
 * `microsoft.graph.user` returned by the deletedItems endpoint that this
 * panel cares about — see `_bypass_modify_delete.md` §4.7/4.9 and the
 * Graph reference `directory_deleteditems_get` in the dirkjanm corpus.
 */
export interface DeletedUserRow {
    /** Graph object id. Survives the deletion. */
    id: string;
    /** Display name at the moment of deletion. */
    displayName: string | null;
    /** UPN at the moment of deletion — the value the attacker would have used. */
    userPrincipalName: string | null;
    /** Mail address recorded at deletion time. */
    mail: string | null;
    /** ISO timestamp of the soft-delete. Drives recency-severity + countdown. */
    deletedDateTime: string;
    /** True if accountEnabled was false at deletion (hint about likely-stale targets). */
    accountEnabled?: boolean;
    /**
     * Optional list of directory-role template ids the user held at the
     * moment of deletion — populated by an audit-log enrichment pass when
     * available. When at least one Tier-0 role is in this list, the row
     * elevates to "critical". This is best-effort; an empty array means
     * "no information", not "had no roles."
     */
    rolesAtDeletion?: ReadonlyArray<string>;
}
/**
 * Permission flags surfaced by the panel's caller. We don't infer these
 * directly because the service layer does not yet expose a "what scopes
 * does the current token actually hold" probe.
 */
export interface DeletedUsersPanelProps {
    /** Tenant id of the active privileged account — needed for portal links. */
    tenantId: string | null;
    /** Operator identity, used as the audit-log actor for portal-deep-link clicks. */
    actor: string | null;
    /** Resolved list of deleted users. Empty array + `permissionGranted=false` → permission hint. */
    rows: ReadonlyArray<DeletedUserRow>;
    /** Whether the caller's token holds Directory.AccessAsUser.All / User.Read.All. */
    permissionGranted: boolean;
    /** True while the (stubbed) probe is mid-flight. Shows a spinner. */
    loading: boolean;
    /** Probe error string, if any. Surfaced as an inline alert. */
    error: string | null;
    /** Refresh callback — surfaced as a button when loading is false. */
    onRefresh?: () => void;
}
export declare const DeletedUsersPanel: React.FC<DeletedUsersPanelProps>;
//# sourceMappingURL=tenant-users-deleted-panel.d.ts.map