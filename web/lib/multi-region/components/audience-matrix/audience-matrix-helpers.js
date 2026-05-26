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
import { __awaiter } from "tslib";
import * as React from "react";
import { decodeJwtClaimsUnsafe } from "../../auth/msal-auth";
export const AUDIENCE_COLUMNS = Object.freeze([
    {
        key: "ARM",
        short: "ARM",
        scope: "https://management.azure.com/.default",
        description: "Azure Resource Manager — subscriptions, resource groups, RBAC, deployments, billing.",
    },
    {
        key: "Graph",
        short: "Graph",
        scope: "https://graph.microsoft.com/.default",
        description: "Microsoft Graph — users, groups, directory roles, sign-in events, M365 metadata.",
    },
    {
        key: "Batch",
        short: "Batch",
        scope: "https://batch.core.windows.net/.default",
        description: "Azure Batch data plane — pools, jobs, tasks, nodes inside a Batch account.",
    },
    {
        key: "Vault",
        short: "Vault",
        scope: "https://vault.azure.net/.default",
        description: "Azure Key Vault data plane — secrets, keys, certificates. Same scope alias as KeyVault.",
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
        description: "Microsoft Substrate — internal M365 graph store underlying Outlook, Teams, OneDrive metadata.",
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
        description: "Operator-typed scope. Use to probe an audience not in this matrix (e.g. a private API's app id).",
    },
]);
/** Convenience lookup by column key. */
export const AUDIENCE_BY_KEY = (() => {
    const m = new Map();
    for (const c of AUDIENCE_COLUMNS)
        m.set(c.key, c);
    return m;
})();
/** Composite cell key — `${rowId}|${audienceKey}`. */
export function cellKey(rowId, audience) {
    return `${rowId}|${audience}`;
}
/** Inverse of `cellKey`. Returns null on malformed input. */
export function parseCellKey(key) {
    const idx = key.indexOf("|");
    if (idx < 0)
        return null;
    return { rowId: key.slice(0, idx), audience: key.slice(idx + 1) };
}
/** True when a token cache row is still inside its expiry window. */
export function isCellFresh(state, ttlSec = 300) {
    if (state.kind !== "success")
        return false;
    const age = Math.floor(Date.now() / 1000) - state.mintedAt;
    return age < ttlSec && state.result.expiresAt > Math.floor(Date.now() / 1000);
}
/** Seconds until a successful cell's token expires (0 floor). */
export function secondsUntilExpiry(result) {
    return Math.max(0, result.expiresAt - Math.floor(Date.now() / 1000));
}
/** Compact "Xm" / "Xh" formatter for expiry badges inside cells. */
export function fmtRemaining(sec) {
    if (sec <= 0)
        return "0s";
    if (sec < 60)
        return `${sec}s`;
    if (sec < 3600)
        return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}
/**
 * Short tenant id rendered next to each row (first 8 chars). AAD tenant
 * GUIDs are non-secret + commonly truncated this way in screen-shareable
 * UIs.
 */
export function shortTenant(tenantId) {
    if (!tenantId)
        return "(no tenant)";
    return tenantId.length > 12 ? `${tenantId.slice(0, 8)}…` : tenantId;
}
/** Mask a refresh-token to a short prefix for display. NEVER log full RTs. */
export function maskRefreshToken(rt, prefixLen = 6) {
    if (!rt)
        return "";
    if (rt.length <= prefixLen + 4)
        return "•".repeat(rt.length);
    return `${rt.slice(0, prefixLen)}…(${rt.length} chars)`;
}
export function summariseClaims(claims) {
    var _a, _b, _c;
    const pick = (k) => {
        const v = claims[k];
        return typeof v === "string" ? v : undefined;
    };
    const pickNum = (k) => {
        const v = claims[k];
        return typeof v === "number" ? v : undefined;
    };
    return {
        tid: pick("tid"),
        aud: pick("aud"),
        azp: pick("azp"),
        appid: pick("appid"),
        scp: (_a = pick("scp")) !== null && _a !== void 0 ? _a : pick("scope"),
        oid: pick("oid"),
        upn: (_c = (_b = pick("preferred_username")) !== null && _b !== void 0 ? _b : pick("upn")) !== null && _c !== void 0 ? _c : pick("unique_name"),
        exp: pickNum("exp"),
    };
}
/**
 * Decode a JWT and return a fresh claim summary without forcing the page
 * file to import msal-auth directly for every cell click.
 */
export function summariseFromJwt(jwt) {
    var _a;
    const claims = (_a = decodeJwtClaimsUnsafe(jwt)) !== null && _a !== void 0 ? _a : {};
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
export function runWithConcurrency(tasks, concurrency) {
    return __awaiter(this, void 0, void 0, function* () {
        const cap = Math.max(1, Math.floor(concurrency));
        const results = new Array(tasks.length);
        let cursor = 0;
        function worker() {
            return __awaiter(this, void 0, void 0, function* () {
                while (cursor < tasks.length) {
                    const idx = cursor++;
                    try {
                        const v = yield tasks[idx]();
                        results[idx] = { status: "fulfilled", value: v };
                    }
                    catch (err) {
                        results[idx] = {
                            status: "rejected",
                            reason: err instanceof Error ? err : new Error(String(err)),
                        };
                    }
                }
            });
        }
        const workers = [];
        for (let i = 0; i < Math.min(cap, tasks.length); i++) {
            workers.push(worker());
        }
        yield Promise.all(workers);
        return results;
    });
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
export function computeTimeSavedMs(successCells, 
/** Wall-clock of the latest parallel batch (max single mint). */
parallelDurationMs) {
    if (successCells.length <= 1)
        return 0;
    const serial = successCells.reduce((s, c) => s + c.durationMs, 0);
    return Math.max(0, serial - parallelDurationMs);
}
/** Pretty-print a duration in ms — used for the "time saved" stat hint. */
export function fmtDurationMs(ms) {
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    const sec = ms / 1000;
    if (sec < 60)
        return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    const rem = Math.floor(sec % 60);
    return `${min}m${rem}s`;
}
/**
 * Build a row comparator. `mintedCount` is a closure over the cells map and
 * is read only when the sort key is "minted" — for other keys it can be a
 * no-op (`() => 0`).
 */
export function buildRowComparator(key, direction, mintedCount) {
    const sign = direction === "asc" ? 1 : -1;
    return (a, b) => {
        var _a, _b;
        let cmp = 0;
        switch (key) {
            case "name":
                cmp = a.displayName.localeCompare(b.displayName, undefined, {
                    sensitivity: "base",
                });
                break;
            case "kind":
                // RT vs account; deterministic tiebreak on name.
                cmp = a.kind.localeCompare(b.kind);
                if (cmp === 0) {
                    cmp = a.displayName.localeCompare(b.displayName, undefined, {
                        sensitivity: "base",
                    });
                }
                break;
            case "tenant":
                cmp = a.tenantId.localeCompare(b.tenantId);
                if (cmp === 0) {
                    cmp = a.displayName.localeCompare(b.displayName, undefined, {
                        sensitivity: "base",
                    });
                }
                break;
            case "client":
                cmp = ((_a = a.clientId) !== null && _a !== void 0 ? _a : "").localeCompare((_b = b.clientId) !== null && _b !== void 0 ? _b : "");
                if (cmp === 0) {
                    cmp = a.displayName.localeCompare(b.displayName, undefined, {
                        sensitivity: "base",
                    });
                }
                break;
            case "minted":
                cmp = mintedCount(a.id) - mintedCount(b.id);
                if (cmp === 0) {
                    cmp = a.displayName.localeCompare(b.displayName, undefined, {
                        sensitivity: "base",
                    });
                }
                break;
        }
        return cmp === 0 ? 0 : cmp * sign;
    };
}
export function indexCellsByRow(cells) {
    const out = new Map();
    for (const k in cells) {
        const sep = k.indexOf("|");
        if (sep < 0)
            continue;
        const rowId = k.slice(0, sep);
        const s = cells[k];
        if (!s || s.kind !== "success")
            continue;
        const prev = out.get(rowId);
        if (prev) {
            // Replace immutably — Map only holds one record per row.
            out.set(rowId, {
                successCount: prev.successCount + 1,
                latestMintedAt: Math.max(prev.latestMintedAt, s.mintedAt),
            });
        }
        else {
            out.set(rowId, { successCount: 1, latestMintedAt: s.mintedAt });
        }
    }
    return out;
}
/** localStorage key for the density preference (page-scoped). */
export const MATRIX_DENSITY_KEY = "audience-matrix.density";
/**
 * Compute the next focus coordinate given a keyboard arrow event. Returns
 * the unchanged coord when the key isn't a navigation key, so the page can
 * skip the setState. Wraps at the edges — wrap is a deliberate choice: with
 * 12+ audience columns + N rows, "edge bump" frustrates the operator more
 * than wrap surprises them.
 */
export function nextCoord(current, key, rowCount, colCount) {
    if (rowCount <= 0 || colCount <= 0)
        return current;
    let r = current.rowIndex;
    let c = current.colIndex;
    switch (key) {
        case "ArrowUp":
            r = (r - 1 + rowCount) % rowCount;
            break;
        case "ArrowDown":
            r = (r + 1) % rowCount;
            break;
        case "ArrowLeft":
            c = (c - 1 + colCount) % colCount;
            break;
        case "ArrowRight":
            c = (c + 1) % colCount;
            break;
        case "Home":
            c = 0;
            break;
        case "End":
            c = colCount - 1;
            break;
        case "PageUp":
            r = 0;
            break;
        case "PageDown":
            r = rowCount - 1;
            break;
        default:
            return current;
    }
    return { rowIndex: r, colIndex: c };
}
// ---------------------------------------------------------------------------
//  Shared 1Hz clock
// ---------------------------------------------------------------------------
//
// Pre-wave-8 every successful cell mounted its own `setInterval(1000)` to
// drive the "Xm left" badge re-render. For a fully-minted matrix (visibleRows
// × AUDIENCE_COLUMNS successful cells) that produced one wakeup per cell per
// second — wasteful and racy across cells that started ticking at slightly
// different times.
//
// The page now hosts ONE 1Hz ticker via this helper hook and broadcasts the
// integer seconds-epoch to every consumer via the returned value. Cells
// memoise based on `(expiresAt, nowSec)` so they only render the seconds
// they care about. Net effect: ~1 wakeup per second, regardless of cell
// count.
//
// Stop the interval when the document is hidden — the page is invisible so
// the time-remaining badge doesn't need to update. `visibilitychange`
// re-arms on return.
/**
 * Returns the current Unix-seconds epoch updated once per second while the
 * tab is visible. Components consuming this value re-render with the new
 * `nowSec` only — cell text uses `expiresAt - nowSec` so the math is local
 * and pure.
 */
export function useSecondsTicker() {
    const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000));
    React.useEffect(() => {
        let id = null;
        const start = () => {
            if (id !== null)
                return;
            id = setInterval(() => {
                setNow(Math.floor(Date.now() / 1000));
            }, 1000);
        };
        const stop = () => {
            if (id !== null) {
                clearInterval(id);
                id = null;
            }
        };
        const onVis = () => {
            if (document.visibilityState === "visible") {
                // Catch up on hidden time before re-arming.
                setNow(Math.floor(Date.now() / 1000));
                start();
            }
            else {
                stop();
            }
        };
        if (document.visibilityState === "visible")
            start();
        document.addEventListener("visibilitychange", onVis);
        return () => {
            document.removeEventListener("visibilitychange", onVis);
            stop();
        };
    }, []);
    return now;
}
//# sourceMappingURL=audience-matrix-helpers.js.map