/**
 * billing-scope-watcher
 * =====================
 *
 * Detects subscriptions whose **billing scope changed** between two
 * snapshots of `listEaBillingSubscriptions()`. A change here means the
 * subscription was moved to a different billingProfile / invoiceSection
 * / billingAccount under the EA enrollment — a state-changing operation
 * the EA admin should always be aware of.
 *
 * ## Why this matters (corpus citation)
 *
 * From `_ea_subscription_cross_tenant.md` (the cross-tenant EA / MCA
 * subscription-transfer playbook):
 *
 *   - A subscription transfer rewrites the `billingScope` ARM path on
 *     the affected sub, both on the source enrollment (it disappears or
 *     becomes "Transferred") and on the destination enrollment (it
 *     appears under a new invoice section / billing profile).
 *   - From the source-tenant admin's perspective, the **only**
 *     same-tenant signal is the `billingScope` flip, because the
 *     sub-level RBAC may already have been pre-staged.
 *   - Cross-tenant transfers are even quieter — they only leave a trace
 *     on the *destination* tenant's auditEntries; the source tenant
 *     sees a billingScope mutation with no audit row to anchor it.
 *
 * The watcher snapshots `(subscriptionId → billingScopeFingerprint)`
 * pairs on every load and flags any sub whose fingerprint differs from
 * the previous snapshot, surfacing the prior scope + a flip timestamp.
 *
 * ## Storage
 *
 * Per-billing-account local storage key:
 *   `ea-billing-manager:scope-watcher:<billingAccountName>`
 *
 * Schema (v1):
 *   {
 *     v: 1,
 *     data: {
 *       lastUpdated: ISO string,
 *       fingerprints: {
 *         [subscriptionName]: {
 *           scope: string,         // joined fingerprint
 *           seenAt: ISO string,    // first time we saw this scope
 *         }
 *       }
 *     }
 *   }
 *
 * The watcher does NOT call usePersistedState directly because it needs
 * imperative read/write semantics inside a `React.useEffect`. The hook's
 * setter pattern would cause a re-render loop on every load.
 *
 * ## Public API
 *
 *   computeScopeFingerprint(sub) -> string
 *   detectScopeChanges(currentSubs, prevSnapshot) -> ScopeChangeMap
 *   loadScopeSnapshot(billingAccountName) -> ScopeSnapshot | null
 *   saveScopeSnapshot(billingAccountName, snapshot) -> void
 *   clearScopeSnapshot(billingAccountName) -> void
 */
import type { EaBillingSubscription } from "../../services";
/**
 * Build a stable fingerprint string that captures every billing-scope
 * field the EA API exposes on a subscription. ANY change to any field
 * counts as a scope change.
 *
 * We deliberately do NOT use the full ARM `id` because the `id`
 * incorporates the subscription's own name — that's stable across
 * scope changes. The fingerprint should change iff the scope changes.
 */
export declare function computeScopeFingerprint(sub: EaBillingSubscription): string;
export interface ScopeSnapshotEntry {
    /** Fingerprint string from `computeScopeFingerprint`. */
    scope: string;
    /** ISO timestamp the operator first saw this scope. */
    seenAt: string;
}
export interface ScopeSnapshot {
    /** ISO timestamp this snapshot was last refreshed. */
    lastUpdated: string;
    /** Keyed by `EaBillingSubscription.name` (NOT `subscriptionId`). */
    fingerprints: Record<string, ScopeSnapshotEntry>;
}
export declare function loadScopeSnapshot(billingAccountName: string): ScopeSnapshot | null;
export declare function saveScopeSnapshot(billingAccountName: string, snapshot: ScopeSnapshot): void;
export declare function clearScopeSnapshot(billingAccountName: string): void;
export type ChangeKind = "new" | "scope-changed" | "removed";
export interface ScopeChange {
    /** Per-sub change kind. */
    kind: ChangeKind;
    /** Previous fingerprint, or "" for `new`. */
    prevScope: string;
    /** Current fingerprint, or "" for `removed`. */
    currentScope: string;
    /** When the previous fingerprint was seen, or null for `new`. */
    prevSeenAt: string | null;
}
export type ScopeChangeMap = Record<string, ScopeChange>;
/**
 * Diff the current sub list against the previous snapshot. Produces a
 * map keyed by sub name with one entry per **changed** sub (no entry
 * means "no change"). The caller is expected to render the changed
 * entries as badges / list-level banner.
 *
 * Side effect: returns a *new* snapshot the caller should persist. The
 * new snapshot preserves the `seenAt` timestamps for unchanged subs and
 * stamps `lastUpdated` to now.
 */
export declare function detectScopeChanges(currentSubs: ReadonlyArray<EaBillingSubscription>, prev: ScopeSnapshot | null): {
    changes: ScopeChangeMap;
    nextSnapshot: ScopeSnapshot;
};
/**
 * Decode a fingerprint back to a human-readable summary. Used by the UI
 * to render "moved from {old invoice section} → {new invoice section}".
 *
 * Returns `{ profileId, profileName, sectionId, sectionName, costCenter, status }`
 * — parsing the pipe-delimited fingerprint produced by
 * `computeScopeFingerprint`. If the fingerprint shape ever changes, the
 * old saved snapshot becomes opaque (everything will show as "scope
 * changed" without details) which is the correct safe failure mode.
 */
export interface DecodedFingerprint {
    profileName: string;
    sectionName: string;
    costCenter: string;
    status: string;
}
export declare function decodeFingerprint(fp: string): DecodedFingerprint | null;
//# sourceMappingURL=billing-scope-watcher.d.ts.map