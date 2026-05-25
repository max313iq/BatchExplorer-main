/**
 * Universal Audience Matrix — pure helpers.
 *
 * What this module owns
 * ---------------------
 * 1. The CANONICAL list of audience columns the matrix renders (`AUDIENCE_COLUMNS`).
 * 2. The `MintRow` shape — a row is either an imported refresh-token entry
 *    (driven by FOCI exchange) or a signed-in MSAL account.
 * 3. Cell-state helpers and a small token-stat decoder so the page file stays
 *    focused on layout / interaction.
 * 4. A worker-pool runner used to cap parallel AAD round-trips at 5
 *    concurrent mints. Keeps AAD throttling friendly + the UI responsive.
 *
 * What this module deliberately does NOT do
 * -----------------------------------------
 * - No token material is logged here. Token strings flow through unchanged
 *   into the page's React state; this file's helpers only ever read claim
 *   fields (`aud`, `tid`, `exp`, etc.) and never persist or print the raw JWT.
 * - No localStorage / sessionStorage writes. The imported-tokens module
 *   already owns persistence; this page only READS to seed its row list,
 *   and INVOKES `importToken` from the page when the operator clicks
 *   "Import to vault" inside a result popover. Persisting RTs/ATs is the
 *   imported-tokens module's job — duplicating it here would be a foot-gun.
 *
 * Hardening notes
 * ---------------
 * - The 5-mint worker pool isolates AbortController errors so a single
 *   cancelled cell never tears down the pool. A cell that re-clicks itself
 *   while in flight gets its old controller aborted (handled in the page),
 *   but the worker stays alive for sibling cells.
 * - `cellKey(rowId, audience)` and `parseCellKey` are stable serialisations
 *   so the page can keep mint state in a single `Record<string, CellState>`
 *   map without nested objects — cheaper to update immutably.
 */

import { decodeJwtClaimsUnsafe } from "../../auth/msal-auth";

/**
 * The set of well-known Azure resource audiences the matrix can mint against.
 * `key` is the column header; `scope` is the v2 `.default` string AAD wants.
 *
 * Ordering matters — the matrix renders these in the order below, and
 * operator muscle memory expects ARM / Graph / Batch at the leftmost cells.
 * Keep "Custom" last; the page renders that column with an inline input.
 */
export interface AudienceColumn {
  /** Header text. */
  readonly key: string;
  /** Short label for compact cell tooltips. */
  readonly short: string;
  /** v2 `.default` scope string. Empty for the "Custom" pseudo-column. */
  readonly scope: string;
  /** Human-readable description for the column-header tooltip. */
  readonly description: string;
}

export const AUDIENCE_COLUMNS: ReadonlyArray<AudienceColumn> = Object.freeze([
  {
    key: "ARM",
    short: "ARM",
    scope: "https://management.azure.com/.default",
    description:
      "Azure Resource Manager — subscriptions, resource groups, RBAC, deployments, billing.",
  },
  {
    key: "Graph",
    short: "Graph",
    scope: "https://graph.microsoft.com/.default",
    description:
      "Microsoft Graph — users, groups, directory roles, sign-in events, M365 metadata.",
  },
  {
    key: "Batch",
    short: "Batch",
    scope: "https://batch.core.windows.net/.default",
    description:
      "Azure Batch data plane — pools, jobs, tasks, nodes inside a Batch account.",
  },
  {
    key: "Vault",
    short: "Vault",
    scope: "https://vault.azure.net/.default",
    description:
      "Azure Key Vault data plane — secrets, keys, certificates. Same scope alias as KeyVault.",
  },
  {
    key: "Storage",
    short: "Storage",
    scope: "https://storage.azure.com/.default",
    description: "Azure Storage data-plane OAuth — blobs / files / queues / tables.",
  },
  {
    key: "Intune",
    short: "Intune",
    scope: "https://manage.microsoft.com/.default",
    description: "Microsoft Intune device management surface.",
  },
  {
    key: "Substrate",
    short: "Subst.",
    scope: "https://substrate.office.com/.default",
    description:
      "Microsoft Substrate — internal M365 graph store underlying Outlook, Teams, OneDrive metadata.",
  },
  {
    key: "Monitor",
    short: "Monitor",
    scope: "https://monitor.azure.com/.default",
    description: "Azure Monitor metrics / logs ingestion data-plane.",
  },
  {
    key: "Power BI",
    short: "PowerBI",
    scope: "https://analysis.windows.net/powerbi/api/.default",
    description: "Power BI REST API.",
  },
  {
    key: "Yammer",
    short: "Yammer",
    scope: "https://api.yammer.com/.default",
    description: "Yammer / Viva Engage REST API.",
  },
  {
    key: "DevOps",
    short: "DevOps",
    scope: "499b84ac-1321-427f-aa17-267ca6975798/.default",
    description: "Azure DevOps Services (well-known app id).",
  },
  {
    key: "Custom",
    short: "Custom",
    scope: "",
    description:
      "Operator-typed scope. Use to probe an audience not in this matrix (e.g. a private API's app id).",
  },
]);

/** Convenience lookup by column key. */
export const AUDIENCE_BY_KEY: ReadonlyMap<string, AudienceColumn> = (() => {
  const m = new Map<string, AudienceColumn>();
  for (const c of AUDIENCE_COLUMNS) m.set(c.key, c);
  return m;
})();

/**
 * Source identifier for a matrix row.
 *
 * `"rt"`  — driven by an imported refresh-token entry. The mint uses
 *           FOCI exchange (`exchangeRefreshTokenForClient`) so we can
 *           target ANY audience the source RT's family covers, without
 *           re-prompting the user.
 * `"account"` — driven by a signed-in MSAL account. The mint uses MSAL's
 *           silent acquire (`acquireTokenSilent` via the existing
 *           getArmTokenForAccount / acquireTokenForAccount surface), so
 *           interactive prompts MIGHT be triggered if scopes haven't
 *           been consented. The page surfaces those as cell-failures so
 *           the operator can act.
 */
export type RowKind = "rt" | "account";

/** Snapshot row shape consumed by the matrix grid. */
export interface MintRow {
  /** Stable id used as the row key + on every audit-log entry. */
  readonly id: string;
  readonly kind: RowKind;
  /** Display name (falls back to UPN, then oid). */
  readonly displayName: string;
  /** UPN / email if known. */
  readonly upn?: string;
  /** Tenant id (short form rendered in the row). */
  readonly tenantId: string;
  /** AAD object id of the principal (for audit entries). */
  readonly oid: string;
  /** For RT rows: the AAD client_id that issued the RT. */
  readonly clientId?: string;
  /** For RT rows: a 6-char prefix for display (RT material is NEVER logged). */
  readonly rtPrefix?: string;
}

/** Result of a successful mint. Token MUST be treated as sensitive. */
export interface MintSuccess {
  readonly accessToken: string;
  /** Unix epoch (seconds). */
  readonly expiresAt: number;
  /** Raw `aud` claim of the minted token. */
  readonly audience: string;
  /** Decoded payload — used by the result popover. Never logged. */
  readonly claims: Record<string, unknown>;
  /** Scope string actually requested (the operator-typed one for Custom). */
  readonly scope: string;
  /** ms taken to mint. Logged for the "time saved" stat. */
  readonly durationMs: number;
}

/**
 * Cell state machine. Each (row, column) starts as `idle`; a click drives it
 * through `pending` → (`success` | `error`). Successes carry the minted
 * token for the result popover; errors carry the AAD error description.
 */
export type CellState =
  | { kind: "idle" }
  | { kind: "pending"; startedAt: number; controller: AbortController }
  | { kind: "success"; result: MintSuccess; mintedAt: number }
  | { kind: "error"; message: string; aadError?: string; failedAt: number };

/** Composite cell key — `${rowId}|${audienceKey}`. */
export function cellKey(rowId: string, audience: string): string {
  return `${rowId}|${audience}`;
}

/** Inverse of `cellKey`. Returns null on malformed input. */
export function parseCellKey(
  key: string,
): { rowId: string; audience: string } | null {
  const idx = key.indexOf("|");
  if (idx < 0) return null;
  return { rowId: key.slice(0, idx), audience: key.slice(idx + 1) };
}

/** True when a token cache row is still inside its expiry window. */
export function isCellFresh(state: CellState, ttlSec = 300): boolean {
  if (state.kind !== "success") return false;
  const age = Math.floor(Date.now() / 1000) - state.mintedAt;
  return age < ttlSec && state.result.expiresAt > Math.floor(Date.now() / 1000);
}

/** Seconds until a successful cell's token expires (0 floor). */
export function secondsUntilExpiry(result: MintSuccess): number {
  return Math.max(0, result.expiresAt - Math.floor(Date.now() / 1000));
}

/** Compact "Xm" / "Xh" formatter for expiry badges inside cells. */
export function fmtRemaining(sec: number): string {
  if (sec <= 0) return "0s";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

/**
 * Short tenant id rendered next to each row (first 8 chars). AAD tenant
 * GUIDs are non-secret + commonly truncated this way in screen-shareable
 * UIs.
 */
export function shortTenant(tenantId: string): string {
  if (!tenantId) return "(no tenant)";
  return tenantId.length > 12 ? `${tenantId.slice(0, 8)}…` : tenantId;
}

/** Mask a refresh-token to a short prefix for display. NEVER log full RTs. */
export function maskRefreshToken(rt: string, prefixLen = 6): string {
  if (!rt) return "";
  if (rt.length <= prefixLen + 4) return "•".repeat(rt.length);
  return `${rt.slice(0, prefixLen)}…(${rt.length} chars)`;
}

/**
 * Decode a minted access token into a compact claim summary suitable for
 * the result popover. NEVER logs the token; only reads claim fields.
 */
export interface ClaimSummary {
  tid?: string;
  aud?: string;
  azp?: string;
  appid?: string;
  scp?: string;
  oid?: string;
  upn?: string;
  exp?: number;
}

export function summariseClaims(claims: Record<string, unknown>): ClaimSummary {
  const pick = (k: string): string | undefined => {
    const v = claims[k];
    return typeof v === "string" ? v : undefined;
  };
  const pickNum = (k: string): number | undefined => {
    const v = claims[k];
    return typeof v === "number" ? v : undefined;
  };
  return {
    tid: pick("tid"),
    aud: pick("aud"),
    azp: pick("azp"),
    appid: pick("appid"),
    scp: pick("scp") ?? pick("scope"),
    oid: pick("oid"),
    upn:
      pick("preferred_username") ??
      pick("upn") ??
      pick("unique_name"),
    exp: pickNum("exp"),
  };
}

/**
 * Decode a JWT and return a fresh claim summary without forcing the page
 * file to import msal-auth directly for every cell click.
 */
export function summariseFromJwt(jwt: string): ClaimSummary {
  const claims = decodeJwtClaimsUnsafe(jwt) ?? {};
  return summariseClaims(claims);
}

/**
 * Tiny p-limit-style worker pool. Runs `tasks` with at most `concurrency`
 * in-flight at any moment. Returns an array of settled results in the
 * SAME order as the input — so the caller can re-associate results with
 * the row/column they came from.
 *
 * We can't import `p-limit` (no new npm deps). The implementation is
 * intentionally tiny — there's no priority queue, no cancellation, no
 * backpressure shaping. Each task gets its own AbortController already
 * managed by the page; the pool just gates how many `await` happen at once.
 *
 * Tasks that throw are returned as PromiseRejectedResult — the caller
 * decides per-cell what to display.
 */
export async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const cap = Math.max(1, Math.floor(concurrency));
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const idx = cursor++;
      try {
        const v = await tasks[idx]!();
        results[idx] = { status: "fulfilled", value: v };
      } catch (err) {
        results[idx] = {
          status: "rejected",
          reason: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(cap, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Compute the elapsed-time saving claim shown in the summary stat row:
 *   `(serialDurationMs - parallelDurationMs)` where the serial baseline
 *   sums every successful mint's `durationMs`. This is honest — it
 *   reports wall-clock the operator WOULD have spent if they had to
 *   click each cell sequentially and wait for each round-trip.
 *
 * Returns 0 when there are no successful mints (no save to claim).
 */
export function computeTimeSavedMs(
  successCells: ReadonlyArray<{ durationMs: number }>,
  /** Wall-clock of the latest parallel batch (max single mint). */
  parallelDurationMs: number,
): number {
  if (successCells.length <= 1) return 0;
  const serial = successCells.reduce((s, c) => s + c.durationMs, 0);
  return Math.max(0, serial - parallelDurationMs);
}

/** Pretty-print a duration in ms — used for the "time saved" stat hint. */
export function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.floor(sec % 60);
  return `${min}m${rem}s`;
}
