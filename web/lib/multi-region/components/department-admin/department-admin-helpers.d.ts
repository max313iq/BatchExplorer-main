/**
 * Department-admin page — local helpers (corpus-grounded).
 *
 * Kept inside the page folder so the cross-component-import boundary
 * stays clean: this file imports only from the page's own types and
 * from `services/` (shared service-layer types). No siblings under
 * `components/<other-page>/` are touched.
 *
 * Three small surfaces:
 *
 *  1. `looksLikeServicePrincipal` — heuristic flag for an EA "account
 *     owner" string that looks like a service principal rather than a
 *     human user. Dept-admin assignments are *usually* humans; an SP
 *     showing up there typically means automation was granted the role
 *     (e.g. a deployment SP used to provision subs cross-tenant). That
 *     is not inherently malicious, but it IS the exact pattern in
 *     `_ea_subscription_cross_tenant.md` §"Granting subscription-
 *     creator across tenants" (a teammate's SP from Tenant B is given
 *     EA Owner / Account Owner on Tenant A's enrollment so it can mint
 *     subs into Tenant B). Surfacing it lets the dept admin spot
 *     automation creep at review time. Cross-ref:
 *     `_bypass_role_grant.md` §"App-role chains" — same primitive,
 *     RBAC plane.
 *
 *  2. `inferCloudFromToken` — minimal JWT-issuer classifier so the
 *     page can emit *cloud-correct* deep-links into the portal
 *     (commercial / Gov / China). The full classifier lives in the
 *     `tenant-baseline` page; we re-implement compactly here to avoid
 *     a cross-component import. Mapping comes from
 *     `_bypass_tenant_switch.md` §8.1 endpoint catalog — the same
 *     hostnames Microsoft documents for cross-cloud routing.
 *
 *  3. `baselineDrift` — local-storage-persisted snapshot of "expected"
 *     enrollment-account membership per `(billingAccount, department)`.
 *     Lets a dept admin pin a known-good roster and then see at a
 *     glance whether any EAs were added or removed since. This is
 *     compliance-grade evidence (the snapshot is keyed by
 *     `lastSnapshotAt`) without needing a real backend. Storage is
 *     versioned so a schema bump can invalidate stale entries.
 *
 * No network calls, no third-party imports — pure local utilities so
 * unit-testability and tree-shaking are trivial.
 */
import type { EaEnrollmentAccount } from "../../services";
/**
 * Heuristic: does this `accountOwner` string look like a service
 * principal / managed identity rather than a human UPN?
 *
 * Signals (any one is sufficient):
 *   - Local part is a bare GUID (32 hex chars or 8-4-4-4-12 form).
 *     Both SP appIds and managed-identity client ids show up this way
 *     when surfaced through the EA `principalName` field.
 *   - Domain is `onmicrosoft.com` AND local part contains no dot
 *     AND local part is >= 16 chars of base16 — a known AAD pattern
 *     for SP-display-name-derived UPNs that lack a human-friendly
 *     alias.
 *   - Owner string starts with `sp:`, `app:`, `mi:` (sometimes EA
 *     billing assignments echo a prefix through `principalName` when
 *     populated by an SDK rather than the portal).
 *   - Owner is literally an objectId (no `@` at all) of GUID form.
 *
 * False-positive policy: we'd rather over-flag than miss — flagging a
 * weird-looking-but-real human costs an operator one read; missing a
 * silently-added SP costs them a compliance finding.
 */
export declare function looksLikeServicePrincipal(accountOwner: string | undefined | null): boolean;
/** Convenience — pick out SP-shaped owners from a list of EAs. */
export declare function eaOwnersThatLookLikeSps(eas: ReadonlyArray<EaEnrollmentAccount>): EaEnrollmentAccount[];
export type AzureCloudEnv = "AzureCommercial" | "AzureUSGovernment" | "AzureChina" | "Unknown";
export interface CloudInfo {
    env: AzureCloudEnv;
    /** Hostname to use when building portal deep-links. */
    portalHost: string;
    /** Human-friendly label. */
    label: string;
}
/**
 * Minimal `iss`-claim classifier. Decode-only — no signature check (we
 * trust the token because we already used it to call ARM successfully).
 *
 * Returns `DEFAULT_CLOUD` for null / malformed tokens, on the principle
 * that commercial is the overwhelmingly common case and producing a
 * commercial deep-link from a Gov tenant is recoverable (the portal
 * just won't find the resource) while suppressing the link entirely
 * would degrade the page for the 99% case.
 */
export declare function inferCloudFromToken(token: string | null | undefined): CloudInfo;
/**
 * Compose a portal deep link into the EA billing-account /
 * enrollment-account blade for the given cloud. The portal route is
 * the same across clouds — only the host changes — so a single
 * builder serves all three.
 *
 * `billingAccountArmId` is the full ARM id of the billing account.
 * `enrollmentAccountArmId` is the full ARM id of the EA. We URL-encode
 * both for safety even though the ids are documented as ascii.
 */
export declare function portalEnrollmentAccountLink(cloud: CloudInfo, enrollmentAccountArmId: string, tenantId?: string | null): string;
export interface BaselineSnapshot {
    /** Schema version — bump to invalidate prior snapshots. */
    version: 1;
    /** ISO-8601 timestamp the snapshot was taken at. */
    takenAt: string;
    /** Operator who took the snapshot (UPN / username when available). */
    takenBy: string;
    /** Billing-account name the scope was pinned to. */
    billingAccountName: string;
    /** Department name the scope was pinned to. */
    departmentName: string;
    /** Frozen list of EAs — id + displayName + owner — at snapshot time. */
    members: Array<{
        id: string;
        name: string;
        displayName: string;
        accountOwner: string;
        status: string;
    }>;
}
export interface BaselineDrift {
    /** EAs present now but missing from the snapshot. */
    added: EaEnrollmentAccount[];
    /** EAs present in the snapshot but no longer in the live list. */
    removed: BaselineSnapshot["members"];
    /** EAs whose owner changed since the snapshot. */
    ownerChanged: Array<{
        id: string;
        displayName: string;
        previous: string;
        current: string;
    }>;
    /** EAs whose status flipped since the snapshot. */
    statusChanged: Array<{
        id: string;
        displayName: string;
        previous: string;
        current: string;
    }>;
}
/**
 * Read the persisted snapshot for `(ba, dept)`, or `null` if none.
 * Tolerates malformed JSON / wrong-version blobs by returning null —
 * never throws.
 */
export declare function readBaselineSnapshot(billingAccountName: string, departmentName: string): BaselineSnapshot | null;
/** Persist a snapshot of the current live EA roster. */
export declare function writeBaselineSnapshot(billingAccountName: string, departmentName: string, takenBy: string, eas: ReadonlyArray<EaEnrollmentAccount>): BaselineSnapshot;
/** Clear the persisted snapshot for `(ba, dept)`. */
export declare function clearBaselineSnapshot(billingAccountName: string, departmentName: string): void;
/**
 * Compute the drift between a saved snapshot and the live EA list.
 * Matching is by ARM id so display-name renames don't show up as
 * add+remove. Returns empty arrays everywhere when `snapshot` is null
 * so the UI can render uniformly.
 */
export declare function computeBaselineDrift(snapshot: BaselineSnapshot | null, live: ReadonlyArray<EaEnrollmentAccount>): BaselineDrift;
/** Total count of differences — convenient for badge / "any drift" gates. */
export declare function driftCount(d: BaselineDrift): number;
//# sourceMappingURL=department-admin-helpers.d.ts.map