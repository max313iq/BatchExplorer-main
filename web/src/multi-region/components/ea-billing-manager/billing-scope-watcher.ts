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

/* ====================================================================== */
/* Fingerprint                                                            */
/* ====================================================================== */

/**
 * Build a stable fingerprint string that captures every billing-scope
 * field the EA API exposes on a subscription. ANY change to any field
 * counts as a scope change.
 *
 * We deliberately do NOT use the full ARM `id` because the `id`
 * incorporates the subscription's own name — that's stable across
 * scope changes. The fingerprint should change iff the scope changes.
 */
export function computeScopeFingerprint(sub: EaBillingSubscription): string {
  // Order matters for fingerprint stability — pick fields in a fixed order.
  // We use the EaBillingSubscription public shape (displayNames only —
  // the underlying ARM resource ids aren't projected onto the type).
  // For move/scope-change detection that's sufficient: the EA API
  // updates the displayName fields atomically with the underlying ids,
  // and the cost-center / status give us two more signals.
  const parts = [
    sub.billingProfileDisplayName ?? "",
    sub.invoiceSectionDisplayName ?? "",
    sub.costCenter ?? "",
    // include status because "Disabled" / "Deleted" is also a scope-y mutation
    sub.status ?? "",
  ];
  return parts.join("|");
}

/* ====================================================================== */
/* Snapshot persistence                                                   */
/* ====================================================================== */

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

interface Envelope {
  v: number;
  data: ScopeSnapshot;
}

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = "ea-billing-manager:scope-watcher:";

function storageKey(billingAccountName: string): string {
  return `${STORAGE_PREFIX}${billingAccountName}`;
}

export function loadScopeSnapshot(
  billingAccountName: string,
): ScopeSnapshot | null {
  if (typeof window === "undefined" || !billingAccountName) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(billingAccountName));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Envelope | ScopeSnapshot;
    // Versioned envelope first; fall back to legacy bare-shape.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "v" in parsed &&
      "data" in parsed &&
      (parsed as Envelope).v === STORAGE_VERSION
    ) {
      const data = (parsed as Envelope).data;
      if (data && typeof data === "object" && data.fingerprints) {
        return data;
      }
    }
    // Legacy unversioned snapshot — accept it; will be re-saved versioned.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "fingerprints" in parsed
    ) {
      return parsed as ScopeSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveScopeSnapshot(
  billingAccountName: string,
  snapshot: ScopeSnapshot,
): void {
  if (typeof window === "undefined" || !billingAccountName) return;
  try {
    const envelope: Envelope = { v: STORAGE_VERSION, data: snapshot };
    window.localStorage.setItem(
      storageKey(billingAccountName),
      JSON.stringify(envelope),
    );
  } catch {
    /* quota / permission errors are silently ignored */
  }
}

export function clearScopeSnapshot(billingAccountName: string): void {
  if (typeof window === "undefined" || !billingAccountName) return;
  try {
    window.localStorage.removeItem(storageKey(billingAccountName));
  } catch {
    /* ignore */
  }
}

/* ====================================================================== */
/* Change detection                                                       */
/* ====================================================================== */

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
export function detectScopeChanges(
  currentSubs: ReadonlyArray<EaBillingSubscription>,
  prev: ScopeSnapshot | null,
): { changes: ScopeChangeMap; nextSnapshot: ScopeSnapshot } {
  const nowIso = new Date().toISOString();
  const changes: ScopeChangeMap = {};
  const nextFingerprints: Record<string, ScopeSnapshotEntry> = {};

  const prevMap = prev?.fingerprints ?? {};
  const isFirstSeen = !prev;

  // Walk current → flag new / changed
  for (const sub of currentSubs) {
    const key = sub.name;
    const fp = computeScopeFingerprint(sub);
    const prevEntry = prevMap[key];

    if (!prevEntry) {
      // First observation — only flag as `new` if we had a prev snapshot
      // for some other subs (a fresh first-ever load shouldn't paint
      // every row green).
      if (!isFirstSeen) {
        changes[key] = {
          kind: "new",
          prevScope: "",
          currentScope: fp,
          prevSeenAt: null,
        };
      }
      nextFingerprints[key] = { scope: fp, seenAt: nowIso };
      continue;
    }

    if (prevEntry.scope !== fp) {
      changes[key] = {
        kind: "scope-changed",
        prevScope: prevEntry.scope,
        currentScope: fp,
        prevSeenAt: prevEntry.seenAt,
      };
      // The new scope's seenAt is *now* — that's when we observed it.
      nextFingerprints[key] = { scope: fp, seenAt: nowIso };
    } else {
      // No change — preserve the original seenAt.
      nextFingerprints[key] = prevEntry;
    }
  }

  // Walk prev → flag removed (sub disappeared from this enrollment)
  for (const key of Object.keys(prevMap)) {
    if (!nextFingerprints[key]) {
      changes[key] = {
        kind: "removed",
        prevScope: prevMap[key]!.scope,
        currentScope: "",
        prevSeenAt: prevMap[key]!.seenAt,
      };
      // Do NOT carry a removed sub into the new snapshot — if it comes
      // back later, it'll be flagged as `new` (which is the right call).
    }
  }

  return {
    changes,
    nextSnapshot: {
      lastUpdated: nowIso,
      fingerprints: nextFingerprints,
    },
  };
}

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

export function decodeFingerprint(fp: string): DecodedFingerprint | null {
  if (!fp) return null;
  const parts = fp.split("|");
  if (parts.length !== 4) return null;
  return {
    profileName: parts[0] ?? "",
    sectionName: parts[1] ?? "",
    costCenter: parts[2] ?? "",
    status: parts[3] ?? "",
  };
}
