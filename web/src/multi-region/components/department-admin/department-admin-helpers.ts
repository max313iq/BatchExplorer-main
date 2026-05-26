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

// ---------------------------------------------------------------------------
// 1) Service-principal owner detection
// ---------------------------------------------------------------------------

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
export function looksLikeServicePrincipal(
  accountOwner: string | undefined | null,
): boolean {
  if (!accountOwner) return false;
  const s = accountOwner.trim();
  if (s.length === 0) return false;

  // sp:/app:/mi: prefix
  if (/^(sp|app|mi):/i.test(s)) return true;

  // Pure GUID (no @ at all) — usually an objectId pasted as the owner
  if (
    !s.includes("@") &&
    /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(
      s.replace(/-/g, ""),
    )
  ) {
    return true;
  }

  // UPN-style with GUID local part
  if (s.includes("@")) {
    const [local, domain = ""] = s.split("@");
    if (!local) return false;
    // GUID with or without dashes in the local part
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        local,
      ) ||
      /^[0-9a-f]{32}$/i.test(local)
    ) {
      return true;
    }
    // *.onmicrosoft.com with a long base16-only local part and no
    // dot inside the local part (humans usually have a "." in their
    // alias). Threshold of 16 chars keeps short admin aliases safe.
    if (
      domain.toLowerCase().endsWith(".onmicrosoft.com") &&
      !local.includes(".") &&
      /^[0-9a-f]{16,}$/i.test(local)
    ) {
      return true;
    }
  }

  return false;
}

/** Convenience — pick out SP-shaped owners from a list of EAs. */
export function eaOwnersThatLookLikeSps(
  eas: ReadonlyArray<EaEnrollmentAccount>,
): EaEnrollmentAccount[] {
  return eas.filter((e) => looksLikeServicePrincipal(e.accountOwner));
}

// ---------------------------------------------------------------------------
// 2) Cloud detection (JWT iss → portal hostname)
// ---------------------------------------------------------------------------

export type AzureCloudEnv =
  | "AzureCommercial"
  | "AzureUSGovernment"
  | "AzureChina"
  | "Unknown";

export interface CloudInfo {
  env: AzureCloudEnv;
  /** Hostname to use when building portal deep-links. */
  portalHost: string;
  /** Human-friendly label. */
  label: string;
}

const DEFAULT_CLOUD: CloudInfo = {
  env: "AzureCommercial",
  portalHost: "portal.azure.com",
  label: "Azure Commercial",
};

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
export function inferCloudFromToken(
  token: string | null | undefined,
): CloudInfo {
  if (!token) return DEFAULT_CLOUD;
  const parts = token.split(".");
  if (parts.length < 2) return DEFAULT_CLOUD;
  try {
    const body = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const pad = body.length % 4;
    const padded = pad ? body + "=".repeat(4 - pad) : body;
    const decoded =
      typeof atob === "function"
        ? atob(padded)
        : // Node fallback for tests
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (globalThis as any).Buffer?.from(padded, "base64").toString("utf8") ??
          "";
    const json = JSON.parse(decoded) as { iss?: unknown };
    const iss = typeof json.iss === "string" ? json.iss.toLowerCase() : "";
    if (
      iss.includes("login.microsoftonline.us") ||
      iss.includes("sts.windows.us")
    ) {
      return {
        env: "AzureUSGovernment",
        portalHost: "portal.azure.us",
        label: "Azure US Government",
      };
    }
    if (
      iss.includes("login.partner.microsoftonline.cn") ||
      iss.includes("login.chinacloudapi.cn")
    ) {
      return {
        env: "AzureChina",
        portalHost: "portal.azure.cn",
        label: "Azure China 21Vianet",
      };
    }
    if (
      iss.includes("login.microsoftonline.com") ||
      iss.includes("sts.windows.net")
    ) {
      return DEFAULT_CLOUD;
    }
    return { env: "Unknown", portalHost: "portal.azure.com", label: "Unknown cloud" };
  } catch {
    return DEFAULT_CLOUD;
  }
}

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
export function portalEnrollmentAccountLink(
  cloud: CloudInfo,
  enrollmentAccountArmId: string,
  tenantId?: string | null,
): string {
  const tenant = tenantId ? `@${encodeURIComponent(tenantId)}` : "";
  return (
    `https://${cloud.portalHost}/#${tenant}` +
    `/resource${enrollmentAccountArmId}/overview`
  );
}

// ---------------------------------------------------------------------------
// 3) Baseline drift snapshot
// ---------------------------------------------------------------------------

const BASELINE_STORAGE_PREFIX = "department-admin:baseline:v1:";

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

function snapshotKey(
  billingAccountName: string,
  departmentName: string,
): string {
  return (
    BASELINE_STORAGE_PREFIX +
    `${billingAccountName}::${departmentName}`
  );
}

/**
 * Read the persisted snapshot for `(ba, dept)`, or `null` if none.
 * Tolerates malformed JSON / wrong-version blobs by returning null —
 * never throws.
 */
export function readBaselineSnapshot(
  billingAccountName: string,
  departmentName: string,
): BaselineSnapshot | null {
  if (!billingAccountName || !departmentName) return null;
  try {
    const raw = localStorage.getItem(
      snapshotKey(billingAccountName, departmentName),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BaselineSnapshot;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.members) ||
      typeof parsed.takenAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a snapshot of the current live EA roster. */
export function writeBaselineSnapshot(
  billingAccountName: string,
  departmentName: string,
  takenBy: string,
  eas: ReadonlyArray<EaEnrollmentAccount>,
): BaselineSnapshot {
  const snapshot: BaselineSnapshot = {
    version: 1,
    takenAt: new Date().toISOString(),
    takenBy,
    billingAccountName,
    departmentName,
    members: eas.map((e) => ({
      id: e.id,
      name: e.name,
      displayName: e.displayName,
      accountOwner: e.accountOwner ?? "",
      status: e.status ?? "",
    })),
  };
  try {
    localStorage.setItem(
      snapshotKey(billingAccountName, departmentName),
      JSON.stringify(snapshot),
    );
  } catch {
    /* quota / disabled — caller decides whether to surface */
  }
  return snapshot;
}

/** Clear the persisted snapshot for `(ba, dept)`. */
export function clearBaselineSnapshot(
  billingAccountName: string,
  departmentName: string,
): void {
  try {
    localStorage.removeItem(snapshotKey(billingAccountName, departmentName));
  } catch {
    /* ignore */
  }
}

/**
 * Compute the drift between a saved snapshot and the live EA list.
 * Matching is by ARM id so display-name renames don't show up as
 * add+remove. Returns empty arrays everywhere when `snapshot` is null
 * so the UI can render uniformly.
 */
export function computeBaselineDrift(
  snapshot: BaselineSnapshot | null,
  live: ReadonlyArray<EaEnrollmentAccount>,
): BaselineDrift {
  if (!snapshot) {
    return { added: [], removed: [], ownerChanged: [], statusChanged: [] };
  }
  const liveById = new Map<string, EaEnrollmentAccount>();
  for (const e of live) liveById.set(e.id, e);
  const snapById = new Map<string, BaselineSnapshot["members"][number]>();
  for (const m of snapshot.members) snapById.set(m.id, m);

  const added: EaEnrollmentAccount[] = [];
  for (const e of live) if (!snapById.has(e.id)) added.push(e);

  const removed: BaselineSnapshot["members"] = [];
  for (const m of snapshot.members) if (!liveById.has(m.id)) removed.push(m);

  const ownerChanged: BaselineDrift["ownerChanged"] = [];
  const statusChanged: BaselineDrift["statusChanged"] = [];
  for (const e of live) {
    const prev = snapById.get(e.id);
    if (!prev) continue;
    const curOwner = e.accountOwner ?? "";
    if (prev.accountOwner !== curOwner) {
      ownerChanged.push({
        id: e.id,
        displayName: e.displayName,
        previous: prev.accountOwner,
        current: curOwner,
      });
    }
    const curStatus = e.status ?? "";
    if (prev.status !== curStatus) {
      statusChanged.push({
        id: e.id,
        displayName: e.displayName,
        previous: prev.status,
        current: curStatus,
      });
    }
  }

  return { added, removed, ownerChanged, statusChanged };
}

/** Total count of differences — convenient for badge / "any drift" gates. */
export function driftCount(d: BaselineDrift): number {
  return (
    d.added.length +
    d.removed.length +
    d.ownerChanged.length +
    d.statusChanged.length
  );
}
