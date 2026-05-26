/**
 * detectors.ts — corpus-grounded anomaly / blind-spot detectors for the
 * Monitoring page. Pure functions, no React. All thresholds are explicit
 * constants so the operator can read them off the source.
 *
 * Why these live here (not in `services/`):
 *   - The Monitoring page is the only consumer (per the wiring contract,
 *     services/store edits are out-of-scope for per-page agents).
 *   - They derive purely from the already-loaded `state.activities` /
 *     `state.agentLogs` / `state.accounts` slices — no new network calls,
 *     no new store fields.
 *
 * Corpus grounding (citations point inside
 * `C:\Users\baimgprodsesa1\Desktop\New folder\`):
 *
 *   1. Regional spike detector — `_analysis_netspi.md` §I "IMDS Variants".
 *      A burst of `provision` / `token` / `node` activity concentrated on a
 *      single region inside a five-minute window is the visible footprint
 *      of automated IMDS-token harvesting against that region's compute
 *      plane (NetSPI `Get-AzPasswords`-style chains). The detector flags
 *      regions whose activity count exceeds a z-score threshold relative
 *      to its own short-horizon baseline.
 *
 *   2. Monitoring blind-spot detector — `_analysis_defender_view.md`
 *      §VI "Detection Gaps in Defender View" (synthesized) and the broader
 *      Azucar/ScoutSuite/Prowler observation that diagnostic-settings
 *      coverage is the #1 visibility gap in real Azure tenants. We flag
 *      regions that hold provisioned accounts (`provisioningState !==
 *      "failed"`) but have produced zero agent log lines in the configured
 *      time window — i.e. regions where the host monitoring view is dark.
 *
 *   3. Per-region baseline (EMA) — corpus methodology. ScoutSuite / Prowler
 *      compute drift from a learned baseline; we apply the same trick on
 *      the operator's own activity/log streams using an exponentially-
 *      weighted moving average so a sudden spike is visible without a
 *      hand-tuned absolute threshold.
 */
import type { Activity, AgentLogEntry, ManagedAccount } from "../../store/store-types";
export interface RegionSpike {
    /** Region name as embedded in `activity.target` (lower-cased for match). */
    region: string;
    /** Activity / log count within the last `windowMs`. */
    recentCount: number;
    /** Baseline count over the comparison horizon (same length, one window earlier). */
    baselineCount: number;
    /** z-like ratio (recent / max(baseline, 1)). */
    ratio: number;
    /** Severity bucket. */
    severity: "info" | "warning" | "critical";
    /** Plain-English explanation surfaced into the UI. */
    reason: string;
}
export interface RegionSpikeOptions {
    /** Sliding-window length for "recent" (default 5 min). */
    windowMs?: number;
    /** Comparison horizon — how many windows back the baseline averages over. */
    baselineWindows?: number;
    /** Ratio that flips the row to `warning`. */
    warningRatio?: number;
    /** Ratio that flips the row to `critical`. */
    criticalRatio?: number;
    /** Now in epoch ms (defaults to Date.now). Pass `lastRefreshedAt` for stable
     *  results that line up with the rest of the page state. */
    now?: number;
}
/**
 * Pull a region marker out of an activity target / log message. Targets are
 * not strictly structured; we look for the substrings most commonly emitted
 * by the agents:
 *
 *   - `region:<r>`     — orchestrator-agent's `_resolveActivityTarget`
 *   - `@ <r>`          — pretty form
 *   - `[<r>]`          — agent log markers (excluding UUID-shaped tokens)
 *
 * Returns the lower-cased region or `null`.
 */
export declare function extractRegion(blob: string): string | null;
/**
 * Detect per-region activity spikes inside a sliding window.
 *
 * Method: for each region observed across `activities` + `logs`, count rows
 * whose timestamp falls inside the recent window. The baseline is the mean
 * count across the previous `baselineWindows` windows (each of `windowMs`
 * length, contiguous, ending at the recent window's start). Ratio =
 * recent / max(baseline, 1). Severity escalates as ratio crosses the
 * configured thresholds.
 *
 * Returns sorted high-to-low by `ratio`. Empty array means "all quiet".
 *
 * Citation: `New folder\_analysis_netspi.md` §I — IMDS variants and the
 * resource-plane abuse cluster that produces these regional bursts.
 */
export declare function detectRegionSpikes(activities: ReadonlyArray<Activity>, logs: ReadonlyArray<AgentLogEntry>, opts?: RegionSpikeOptions): RegionSpike[];
export interface RegionBlindSpot {
    region: string;
    accountCount: number;
    logCount: number;
    /** True when there are accounts but zero logs across the visible window. */
    dark: boolean;
    /** True when the log volume is suspiciously thin relative to peers (<10% of median). */
    thin: boolean;
    reason: string;
}
export interface BlindSpotOptions {
    /** Time-window lower bound (epoch ms). Match the page's cutoff for parity. */
    cutoff: number;
    /** Treat a region as "thin" if its log count is below this fraction of the
     *  median across all known regions. */
    thinFraction?: number;
}
/**
 * Detect regions that hold provisioned accounts but produce no (or
 * suspiciously few) log lines in the visible window. These are the regions
 * where you can't see what's happening — the equivalent of a tenant whose
 * subscription-level diagnostic settings were never wired up.
 *
 * Citation: `New folder\_analysis_defender_view.md` — Azucar/ScoutSuite/
 * Prowler all probe `Microsoft.Insights/diagnosticSettings` because
 * missing coverage is the #1 visibility gap in real tenants.
 */
export declare function detectBlindSpots(accounts: ReadonlyArray<ManagedAccount>, logs: ReadonlyArray<AgentLogEntry>, opts: BlindSpotOptions): RegionBlindSpot[];
export interface RegionBaselineEntry {
    /** EMA of per-window event counts. */
    ema: number;
    /** Last update timestamp (epoch ms). Used to age out stale entries. */
    updatedAt: number;
    /** Number of samples that have shaped this EMA — useful for cold-start UI. */
    samples: number;
}
export type RegionBaselineMap = Record<string, RegionBaselineEntry>;
export interface BaselineUpdateOptions {
    /** Smoothing constant in (0,1]. Lower = slower to react. Default 0.3. */
    alpha?: number;
    /** Max age before an entry is considered stale and dropped. Default 24h. */
    staleMs?: number;
    /** Now in epoch ms. */
    now?: number;
}
/**
 * Update a persisted region EMA baseline given the events observed inside
 * the most recent window. Returns the new map — callers persist via
 * `usePersistedState`. Pure / referentially-honest: no in-place mutation
 * of the input map.
 *
 * Cold-start handling: when a region has never been seen before its EMA is
 * seeded to the observed count (the EMA equals the value when n=1), and
 * `samples` is 1 so the UI can show "learning..." until enough cycles
 * accumulate.
 */
export declare function updateRegionBaseline(prev: RegionBaselineMap, windowCounts: ReadonlyMap<string, number>, opts?: BaselineUpdateOptions): RegionBaselineMap;
/**
 * Compare a region's current count against its baseline EMA. Returns a
 * compact verdict the UI can use to colour rows / fire ARIA-live alerts.
 */
export interface BaselineVerdict {
    region: string;
    current: number;
    baseline: number;
    samples: number;
    /** Relative deviation (current - baseline) / max(baseline, 1). */
    drift: number;
    status: "learning" | "ok" | "elevated" | "spike" | "quiet";
}
export declare function evaluateRegion(region: string, current: number, baseline: RegionBaselineEntry | undefined): BaselineVerdict;
//# sourceMappingURL=detectors.d.ts.map