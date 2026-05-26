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
/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */
/** Mirror of monitoring-page's `parseTimestamp` — kept private to avoid
 *  a circular import. Identical semantics: NaN on unparseable input. */
function parseTs(input) {
    if (input == null)
        return NaN;
    if (typeof input === "number")
        return Number.isFinite(input) ? input : NaN;
    const t = Date.parse(input);
    return Number.isNaN(t) ? NaN : t;
}
const DEFAULT_SPIKE_OPTS = {
    windowMs: 5 * 60 * 1000,
    baselineWindows: 6,
    warningRatio: 3,
    criticalRatio: 8,
    now: 0, // 0 means "ask Date.now() at call site"
};
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
export function extractRegion(blob) {
    if (!blob)
        return null;
    const lower = blob.toLowerCase();
    let m = /\bregion[:=]\s*([a-z][a-z0-9-]{2,})\b/.exec(lower);
    if (m && m[1])
        return m[1];
    m = /\s@\s+([a-z][a-z0-9-]{2,})\b/.exec(lower);
    if (m && m[1])
        return m[1];
    // `[xxx]` markers — skip UUID-shaped ones so we don't false-match
    // correlation IDs as a "region".
    const bracket = /\[([a-z][a-z0-9-]{2,})\]/g;
    let bm;
    while ((bm = bracket.exec(lower))) {
        const tok = bm[1];
        // UUIDs are 36 chars including dashes — bail.
        if (tok.length === 36 && tok.split("-").length === 5)
            continue;
        // Don't match generic words like `info`, `warn` ...
        if (tok === "info" ||
            tok === "warn" ||
            tok === "warning" ||
            tok === "error" ||
            tok === "debug" ||
            tok === "trace") {
            continue;
        }
        return tok;
    }
    return null;
}
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
export function detectRegionSpikes(activities, logs, opts = {}) {
    var _a;
    const o = Object.assign(Object.assign({}, DEFAULT_SPIKE_OPTS), opts);
    const now = o.now > 0 ? o.now : Date.now();
    const recentCutoff = now - o.windowMs;
    const baselineCutoff = recentCutoff - o.windowMs * o.baselineWindows;
    // (region -> per-window counts). counts[0] = current window; counts[1..n]
    // = older baseline windows.
    const series = new Map();
    const bucketsLen = 1 + o.baselineWindows;
    const place = (ts, region) => {
        if (!region)
            return;
        if (!Number.isFinite(ts))
            return;
        if (ts < baselineCutoff || ts > now)
            return;
        let arr = series.get(region);
        if (!arr) {
            arr = new Array(bucketsLen).fill(0);
            series.set(region, arr);
        }
        if (ts >= recentCutoff) {
            arr[0] += 1;
        }
        else {
            const age = recentCutoff - ts;
            let idx = 1 + Math.floor(age / o.windowMs);
            if (idx >= bucketsLen)
                idx = bucketsLen - 1;
            arr[idx] += 1;
        }
    };
    for (const a of activities) {
        place(parseTs(a.startedAt), extractRegion(a.target));
    }
    for (const l of logs) {
        const blob = `${l.message} ${JSON.stringify((_a = l.details) !== null && _a !== void 0 ? _a : {})}`;
        place(parseTs(l.timestamp), extractRegion(blob));
    }
    const out = [];
    for (const [region, arr] of series.entries()) {
        const recent = arr[0];
        if (recent === 0)
            continue; // nothing happening; can't be a spike
        let baselineSum = 0;
        let baselineNonEmpty = 0;
        for (let i = 1; i < bucketsLen; i++) {
            baselineSum += arr[i];
            if (arr[i] > 0)
                baselineNonEmpty += 1;
        }
        const baselineMean = baselineSum / o.baselineWindows;
        const ratio = recent / Math.max(baselineMean, 1);
        let severity = "info";
        if (ratio >= o.criticalRatio)
            severity = "critical";
        else if (ratio >= o.warningRatio)
            severity = "warning";
        // Cold-start guard: if the baseline was effectively zero (no activity in
        // the prior windows) we can't reliably call this a "spike" — flag as
        // info regardless of the ratio so the operator gets visibility but the
        // alert pill doesn't fire. NetSPI-style token-mint storms typically
        // ride on top of an existing baseline of provision activity.
        if (baselineNonEmpty === 0 && recent < 3)
            severity = "info";
        const reason = severity === "critical"
            ? `Region '${region}' produced ${recent} events in the last ` +
                `${Math.round(o.windowMs / 60000)}m — ${ratio.toFixed(1)}× the ` +
                `${o.baselineWindows}-window baseline. Inspect for unauthorized ` +
                `provisioning / token-mint activity (see _analysis_netspi.md §I).`
            : severity === "warning"
                ? `Region '${region}' is running ${ratio.toFixed(1)}× hotter than ` +
                    `its recent baseline (${recent} vs ${baselineMean.toFixed(1)}).`
                : baselineNonEmpty === 0
                    ? `Region '${region}' is producing events with no prior baseline ` +
                        `(cold start) — keep an eye on it as the baseline forms.`
                    : `Region '${region}': ${recent} recent events, baseline ${baselineMean.toFixed(1)}.`;
        out.push({
            region,
            recentCount: recent,
            baselineCount: Math.round(baselineMean * o.baselineWindows),
            ratio,
            severity,
            reason,
        });
    }
    out.sort((a, b) => b.ratio - a.ratio);
    return out;
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
export function detectBlindSpots(accounts, logs, opts) {
    var _a, _b, _c, _d, _e, _f;
    const thinFraction = (_a = opts.thinFraction) !== null && _a !== void 0 ? _a : 0.1;
    const byRegionAccounts = new Map();
    for (const a of accounts) {
        const r = ((_b = a.region) !== null && _b !== void 0 ? _b : "").trim().toLowerCase();
        if (!r)
            continue;
        byRegionAccounts.set(r, ((_c = byRegionAccounts.get(r)) !== null && _c !== void 0 ? _c : 0) + 1);
    }
    if (byRegionAccounts.size === 0)
        return [];
    const byRegionLogs = new Map();
    for (const l of logs) {
        const ts = parseTs(l.timestamp);
        if (Number.isFinite(ts) && ts < opts.cutoff)
            continue;
        const blob = `${l.message} ${JSON.stringify((_d = l.details) !== null && _d !== void 0 ? _d : {})}`;
        const r = extractRegion(blob);
        if (!r)
            continue;
        byRegionLogs.set(r, ((_e = byRegionLogs.get(r)) !== null && _e !== void 0 ? _e : 0) + 1);
    }
    // Median across regions that DO emit logs. Used to flag "thin" regions.
    const positiveCounts = [...byRegionLogs.values()].filter((v) => v > 0);
    positiveCounts.sort((a, b) => a - b);
    const median = positiveCounts.length === 0
        ? 0
        : positiveCounts[Math.floor(positiveCounts.length / 2)];
    const thinThreshold = Math.max(1, Math.floor(median * thinFraction));
    const out = [];
    for (const [region, accountCount] of byRegionAccounts.entries()) {
        const logCount = (_f = byRegionLogs.get(region)) !== null && _f !== void 0 ? _f : 0;
        const dark = accountCount > 0 && logCount === 0;
        const thin = !dark && logCount > 0 && logCount < thinThreshold;
        if (!dark && !thin)
            continue;
        const reason = dark
            ? `Region '${region}' has ${accountCount} account(s) but no agent log ` +
                `activity in the window — diagnostic blind spot. See ` +
                `_analysis_defender_view.md.`
            : `Region '${region}' is emitting fewer log lines (${logCount}) than ` +
                `peers (median ${median}) — possibly under-instrumented.`;
        out.push({ region, accountCount, logCount, dark, thin, reason });
    }
    // Dark regions before thin; alphabetical within each.
    out.sort((a, b) => {
        if (a.dark !== b.dark)
            return a.dark ? -1 : 1;
        return a.region.localeCompare(b.region);
    });
    return out;
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
export function updateRegionBaseline(prev, windowCounts, opts = {}) {
    var _a, _b, _c;
    const alpha = clamp01((_a = opts.alpha) !== null && _a !== void 0 ? _a : 0.3);
    const now = (_b = opts.now) !== null && _b !== void 0 ? _b : Date.now();
    const stale = (_c = opts.staleMs) !== null && _c !== void 0 ? _c : 24 * 60 * 60 * 1000;
    const next = {};
    // First carry forward entries that aren't stale.
    for (const [k, v] of Object.entries(prev)) {
        if (now - v.updatedAt > stale)
            continue;
        next[k] = v;
    }
    // Then mix in the new observations.
    for (const [region, count] of windowCounts.entries()) {
        const existing = next[region];
        if (!existing) {
            next[region] = { ema: count, updatedAt: now, samples: 1 };
        }
        else {
            const ema = alpha * count + (1 - alpha) * existing.ema;
            next[region] = {
                ema,
                updatedAt: now,
                samples: Math.min(existing.samples + 1, 9999),
            };
        }
    }
    return next;
}
export function evaluateRegion(region, current, baseline) {
    var _a, _b;
    if (!baseline || baseline.samples < 3) {
        return {
            region,
            current,
            baseline: (_a = baseline === null || baseline === void 0 ? void 0 : baseline.ema) !== null && _a !== void 0 ? _a : 0,
            samples: (_b = baseline === null || baseline === void 0 ? void 0 : baseline.samples) !== null && _b !== void 0 ? _b : 0,
            drift: 0,
            status: "learning",
        };
    }
    const drift = (current - baseline.ema) / Math.max(baseline.ema, 1);
    let status = "ok";
    if (drift >= 2)
        status = "spike";
    else if (drift >= 0.5)
        status = "elevated";
    else if (current === 0 && baseline.ema >= 2)
        status = "quiet";
    return {
        region,
        current,
        baseline: baseline.ema,
        samples: baseline.samples,
        drift,
        status,
    };
}
function clamp01(v) {
    if (!Number.isFinite(v))
        return 0.3;
    if (v <= 0)
        return 0.0001;
    if (v > 1)
        return 1;
    return v;
}
//# sourceMappingURL=detectors.js.map