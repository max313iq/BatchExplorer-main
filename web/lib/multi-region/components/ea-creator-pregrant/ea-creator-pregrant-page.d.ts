/**
 * Pre-grant EA Subscription Creator role — standalone page.
 *
 * Single-purpose flow operators run BEFORE opening "Create EA Sub (quick)"
 * to make sure the principal already has the role on the target
 * enrollment account. Avoids the missing-role 401 round-trip that
 * ea-sub-quick otherwise eats on first attempt.
 *
 * Flow:
 *   1. Pick a signed-in Azure account (acts as the GRANTER — must hold
 *      Enrollment Account Owner / Department Admin / EA admin on the BA).
 *   2. Pick the billing account, then the enrollment account.
 *   3. Enter one or more principals (UPN/email — auto-resolved via Graph
 *      — or raw objectId UUIDs). Bulk paste supports newline/comma/semicolon
 *      separators so the operator can grant in one sweep.
 *   4. Enter the principal(s)' tenant id (defaults to the granter's tenant;
 *      override for cross-tenant guests).
 *   5. Review the resolved principals, confirm in the modal, submit.
 *      409 / "already exists" is treated as a no-op success per-principal.
 *
 * Notable improvements over the original:
 *   - Principal preview: as the operator types, we resolve UPN→oid via
 *     Graph (debounced) so the confirm dialog shows the real display name
 *     and object id BEFORE submit. On the "already-granted" path, the
 *     resolved oid is now correct (the original showed the raw input).
 *   - Multi-principal grant runs in parallel with per-row status.
 *   - Caller-role pre-check via diagnoseCallerBillingRole — shows whether
 *     the SELECTED granter actually has admin rights on the chosen scope,
 *     instead of waiting for the grant PUT to fail.
 *   - Existing-grants panel lists every EaSubscriptionCreator already
 *     assigned at the chosen scope, with a revoke action (destructive,
 *     guarded by ConfirmationDialog).
 *   - Session activity panel surfaces every grant/revoke/lookup the
 *     operator has performed in the current session, with copy buttons
 *     on every id and a CSV/JSON export.
 *   - Force-refresh-token toggle. ARM RBAC propagation is eventually
 *     consistent: after a grant, the SAME bearer token still 401s for a
 *     few seconds. Forcing a token refresh on the next "Create EA Sub"
 *     call eliminates the round-trip — we recommend it after every grant.
 *   - All fetches are race-safe: ARM token comes from useArmToken (single
 *     source of truth) so a tenant switch mid-flow doesn't leak a stale
 *     token to the BA/EA fetches. Per-effect cancellation tokens prevent
 *     out-of-order responses from clobbering newer state.
 *   - Token-tracker preserved per page contract; the existing-grants
 *     panel re-fetches after a successful grant so the lists stay in sync.
 *
 * Wave-2 corpus-grounded improvements (this file):
 *   - Suspect-SP detection. Service-principal pregrants are a high-signal
 *     audit hook — they survive employee offboarding and rarely trigger
 *     user-centric SOC alerts. We Graph-resolve each creator's principalId
 *     in their home tenant; a 404 user lookup → "ServicePrincipal
 *     suspected" badge + summary banner. Cite:
 *     `New folder/_bypass_role_grant.md` §"App-Role Escalation Chains".
 *   - Covered-grant preflight. We list assignments at the parent BA scope
 *     and surface a "Covered" badge on EA-scope creator rows whose
 *     principal already holds an equivalent role at the wider scope.
 *     Mirrored at submit-time as a Layers-icon Alert above the Grant
 *     button so the operator sees "this PUT will be redundant" before
 *     firing. Cite: `_bypass_role_grant.md` §"scope hierarchy".
 *   - Audit payload enrichment. The revoke flow records the full
 *     {principalId, principalTenantId, scope, roleDefinitionId, createdOn,
 *     ageDays, principalClassification, granterOid} on the audit entry,
 *     not just `{principalId, roleAssignmentId}`. Cite:
 *     `_analysis_defender_view.md` §"audit trail completeness".
 *   - Configurable stale-pregrant threshold + auto-revoke reminder. Two
 *     persisted day-pickers replace the previous hard-coded 7-day stale
 *     cutoff; auto-revoke is reminder-only (we never delete without a
 *     human confirm).
 *   - Baseline snapshot. Operators can capture "what creators look like
 *     NOW" per-scope; subsequent reloads surface added/removed rows in a
 *     diff banner. Useful for one-shot reconciliations.
 *   - Operator hotkeys: `g` focuses the principal input, `Shift+G`
 *     opens the grant confirm dialog, `d` opens the revoke confirm for
 *     the first row on the Existing tab. The page-local Keyboard icon in
 *     the header explains them; the global `?` keyboard-help dialog
 *     lists them alongside the app-wide shortcuts.
 *
 * This duplicates capability in Sub Manager's "Grant" tab, but the
 * dedicated page is easier to point operators at and decouples the
 * pre-grant decision from the rest of Sub Manager's surface.
 */
import * as React from "react";
export declare const EaCreatorPregrantPage: React.FC;
//# sourceMappingURL=ea-creator-pregrant-page.d.ts.map