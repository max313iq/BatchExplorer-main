/**
 * cost-anomaly-detector
 * =====================
 *
 * Pure helpers (no React, no DOM) for two operator-grade signals the EA
 * Billing Manager surfaces but every page-level test framework should be
 * able to exercise in isolation:
 *
 *   1. Cost-anomaly detection — given a date-bucketed series, find the
 *      buckets that breach an absolute or rolling-mean-relative threshold.
 *
 *   2. Role-grant correlation — given a list of audit entries and a list
 *      of anomalous buckets, find which spikes line up (within a tunable
 *      window) with a recent EA role grant.
 *
 * ## Why this matters (corpus citation)
 *
 * The cross-tool playbook `_bypass_role_grant.md` (§1.1 "Direct role
 * grant", §6 "Workload Identity Federation as Role-Grant Bypass") catalogs
 * how an attacker who lands `Microsoft.Authorization/roleAssignments/write`
 * — or an equivalent admin role on the billing scope — can rapidly pivot
 * to RBAC pivot points that show up as a *spike in billable resource
 * activity* on the EA enrollment. The first observable on the defender
 * side is almost always cost: a new subscription gets created (EA
 * Subscription Creator role), or an attacker SP gets Storage Blob Data
 * Contributor on a high-spend storage account and starts exfiltrating /
 * staging.
 *
 * Correlating cost spikes with recent role grants in the same operator
 * audit trail turns "we got a big bill" into "we got a big bill 14
 * minutes after Alice granted Bob Storage Blob Data Contributor" — a
 * concrete pivot point the EA admin can take to the privileged-audit
 * page (cross-page nav) and resolve.
 *
 * ## API
 *
 *   detectCostAnomalies(series, opts) -> { date, value, score, reason }[]
 *   correlateAnomaliesWithRoleGrants(anomalies, auditEntries, opts) -> CorrelatedAnomaly[]
 *
 * Both functions are O(n + m) in the input sizes. They make no I/O calls
 * and depend on nothing but the standard library, so they can be unit
 * tested without a React render.
 *
 * The `AuditEntry` shape is the same shape exported by the audit-log
 * service module — we use a structural type so this file doesn't pull
 * in the service layer (and so the helpers are usable from any test).
 */
import { __rest } from "tslib";
/**
 * Detect anomalous cost buckets. Walks the series once, computing a
 * rolling-mean over the preceding `windowSize` buckets and flagging
 * any bucket that exceeds `rollingMean * multiplier` AND `absoluteFloor`.
 *
 * The first `windowSize` buckets have no usable preceding window, so
 * they are never flagged (a single high opening bucket is not yet an
 * anomaly — it's the baseline).
 */
export function detectCostAnomalies(series, opts = {}) {
    var _a, _b, _c;
    const multiplier = (_a = opts.multiplier) !== null && _a !== void 0 ? _a : 2.5;
    const absoluteFloor = (_b = opts.absoluteFloor) !== null && _b !== void 0 ? _b : 100;
    const windowSize = Math.max(2, (_c = opts.windowSize) !== null && _c !== void 0 ? _c : 7);
    if (!series || series.length < windowSize + 1)
        return [];
    const out = [];
    for (let i = windowSize; i < series.length; i += 1) {
        const candidate = series[i];
        const v = Math.max(0, candidate.value);
        if (v < absoluteFloor)
            continue;
        let sum = 0;
        for (let j = i - windowSize; j < i; j += 1) {
            sum += Math.max(0, series[j].value);
        }
        const rollingMean = sum / windowSize;
        // Avoid divide-by-zero pathology — if every preceding bucket was 0,
        // the candidate is anomalous iff it's above the absoluteFloor (which
        // we already checked).
        const score = rollingMean > 0 ? v / rollingMean : Number.POSITIVE_INFINITY;
        if (score < multiplier)
            continue;
        const xFmt = Number.isFinite(score) ? `${score.toFixed(1)}×` : "∞×";
        out.push({
            date: candidate.date,
            value: v,
            rollingMean,
            score,
            reason: `${xFmt} the trailing ${windowSize}-bucket mean (${rollingMean.toFixed(0)})`,
        });
    }
    return out;
}
const DEFAULT_GRANT_ACTIONS = [
    "create_billing_role_assignment",
    "assign_role",
    "add_role_assignment",
    "create_subscription",
    "accept_inbound_transfer",
];
/**
 * Parse the bucket key into a Date. Cost Management returns date columns
 * as YYYYMMDD numerics (sometimes) or ISO strings (sometimes). We try
 * a few shapes and return null if none match — the caller treats null
 * as "can't correlate this bucket, skip it" rather than crashing.
 */
function parseBucketDate(key) {
    if (!key)
        return null;
    // YYYYMMDD
    if (/^\d{8}$/.test(key)) {
        const y = Number(key.slice(0, 4));
        const m = Number(key.slice(4, 6)) - 1;
        const d = Number(key.slice(6, 8));
        const dt = new Date(Date.UTC(y, m, d));
        return Number.isNaN(dt.getTime()) ? null : dt;
    }
    // YYYY-MM-DD or full ISO
    const dt = new Date(key);
    return Number.isNaN(dt.getTime()) ? null : dt;
}
/**
 * Correlate cost anomalies with privileged role-grant audit entries.
 *
 * For each anomaly, find audit entries whose `timestamp` falls in
 * `[bucketTime - windowHours, bucketTime + windowHours]` and whose
 * `action` is in the configured action set. The bidirectional window
 * captures both "grant caused the spike" (grant precedes anomaly) and
 * "spike triggered the grant" (anomaly precedes grant — e.g. the operator
 * noticed the cost and granted someone investigative privileges).
 *
 * Result is sorted descending by anomaly score so the worst spike is
 * first — matches what the UI banner wants.
 */
export function correlateAnomaliesWithRoleGrants(anomalies, audit, opts = {}) {
    var _a, _b, _c;
    const windowHours = (_a = opts.windowHours) !== null && _a !== void 0 ? _a : 24;
    const actions = new Set((_b = opts.actions) !== null && _b !== void 0 ? _b : DEFAULT_GRANT_ACTIONS);
    const windowMs = windowHours * 60 * 60 * 1000;
    // Pre-filter audit by action set (cheap O(m)) so the inner loop only
    // walks role-grant entries.
    const grants = [];
    for (const e of audit) {
        if (!actions.has(e.action))
            continue;
        const t = Date.parse(e.timestamp);
        if (Number.isNaN(t))
            continue;
        grants.push(Object.assign(Object.assign({}, e), { _time: t }));
    }
    if (grants.length === 0)
        return [];
    const correlated = [];
    for (const a of anomalies) {
        const bucketTime = (_c = parseBucketDate(a.date)) === null || _c === void 0 ? void 0 : _c.getTime();
        if (bucketTime === undefined)
            continue;
        const matched = grants.filter((g) => Math.abs(g._time - bucketTime) <= windowMs);
        if (matched.length === 0)
            continue;
        // Strip the internal `_time` field before returning.
        const stripped = matched.map((_a) => {
            var { _time: _t } = _a, rest = __rest(_a, ["_time"]);
            return rest;
        });
        correlated.push(Object.assign(Object.assign({}, a), { grants: stripped }));
    }
    // Highest-score first — most extreme spike at the top of the banner.
    correlated.sort((a, b) => b.score - a.score);
    return correlated;
}
export function forecastBudget(series, remainingBuckets, runRateWindow = 7) {
    if (!series || series.length === 0) {
        return { current: 0, ratePerBucket: 0, projected: 0, windowUsed: 0 };
    }
    const current = series.reduce((s, p) => s + Math.max(0, p.value), 0);
    const windowUsed = Math.min(series.length, Math.max(1, runRateWindow));
    let recentSum = 0;
    for (let i = series.length - windowUsed; i < series.length; i += 1) {
        recentSum += Math.max(0, series[i].value);
    }
    const ratePerBucket = recentSum / windowUsed;
    const projected = current + ratePerBucket * Math.max(0, remainingBuckets);
    return { current, ratePerBucket, projected, windowUsed };
}
//# sourceMappingURL=cost-anomaly-detector.js.map