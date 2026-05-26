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
/** Cost data point — a date-bucketed sum suitable for sparkline / anomaly. */
export interface CostSeriesPoint {
    /** ISO-ish bucket key — Cost Management returns these as strings. */
    readonly date: string;
    /** Aggregate cost for the bucket. Negative values are treated as 0. */
    readonly value: number;
}
/** Tuning knobs for `detectCostAnomalies`. */
export interface AnomalyDetectionOptions {
    /**
     * Multiplier applied to the rolling mean to derive the upper bound. A
     * bucket whose value exceeds `rollingMean * multiplier` is flagged.
     * Default 2.5 — empirically the threshold a human EA admin would call
     * "wait, that's not normal" without crying wolf on a normal end-of-
     * month batch run.
     */
    readonly multiplier?: number;
    /**
     * Absolute floor — buckets below this value are never flagged even
     * if they're 10× the rolling mean (avoids "$1.40 → $14 is suspicious"
     * spam in dev tenants). Default 100 in the response's reporting
     * currency.
     */
    readonly absoluteFloor?: number;
    /**
     * Size of the rolling-mean window (in buckets) preceding the candidate
     * point. Default 7 — one calendar week of daily-grain data; for
     * monthly-grain queries the caller should pass 3.
     */
    readonly windowSize?: number;
}
/** A flagged cost bucket plus the reason it was flagged. */
export interface CostAnomaly extends CostSeriesPoint {
    /** Rolling mean over the preceding window — basis for the score. */
    readonly rollingMean: number;
    /** value / rollingMean — 2.5 means the bucket is 2.5× the rolling mean. */
    readonly score: number;
    /** Plain-English reason — surfaced in the UI banner. */
    readonly reason: string;
}
/**
 * Detect anomalous cost buckets. Walks the series once, computing a
 * rolling-mean over the preceding `windowSize` buckets and flagging
 * any bucket that exceeds `rollingMean * multiplier` AND `absoluteFloor`.
 *
 * The first `windowSize` buckets have no usable preceding window, so
 * they are never flagged (a single high opening bucket is not yet an
 * anomaly — it's the baseline).
 */
export declare function detectCostAnomalies(series: ReadonlyArray<CostSeriesPoint>, opts?: AnomalyDetectionOptions): CostAnomaly[];
/**
 * Minimal structural shape of an audit entry — matches `AuditEntry` from
 * `multi-region/services/audit-log.ts`. Declared structurally so this
 * file has zero internal imports and can be unit-tested cold.
 */
export interface CorrelatableAuditEntry {
    readonly id: string;
    readonly timestamp: string;
    readonly actor: string;
    readonly action: string;
    readonly target: string;
    readonly status: "success" | "failure";
    readonly details?: Record<string, unknown>;
}
/** Tuning knobs for `correlateAnomaliesWithRoleGrants`. */
export interface CorrelationOptions {
    /**
     * Window in hours: an anomaly bucket "correlates" with a role grant if
     * the grant happened within `[bucketStart - windowHours, bucketStart]`.
     * Default 24 — daily-grain queries; for monthly-grain the caller should
     * pass 24*30.
     */
    readonly windowHours?: number;
    /**
     * Actions to consider role-granting. Default matches the action strings
     * the EA Billing Manager + Privileged Audit pages emit:
     *   - `create_billing_role_assignment` (this page)
     *   - `assign_role` (resource-manager / role-assignments page)
     *   - `add_role_assignment` (privileged-audit page)
     *   - `create_subscription` (EA Subscription Creator pivot — see corpus §1.1)
     *   - `accept_inbound_transfer` (sub transfer is a privilege grant — see
     *     `_ea_subscription_cross_tenant.md` §sub-transfer)
     */
    readonly actions?: ReadonlyArray<string>;
}
/** An anomaly that lines up with one or more recent privilege grants. */
export interface CorrelatedAnomaly extends CostAnomaly {
    /** The role-grant audit entries that fall inside the correlation window. */
    readonly grants: ReadonlyArray<CorrelatableAuditEntry>;
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
export declare function correlateAnomaliesWithRoleGrants(anomalies: ReadonlyArray<CostAnomaly>, audit: ReadonlyArray<CorrelatableAuditEntry>, opts?: CorrelationOptions): CorrelatedAnomaly[];
/**
 * Project end-of-period spend from a partial-period series.
 *
 * Strategy: simple linear run-rate.
 *   - Use the most recent `runRateWindow` buckets to compute the average
 *     spend per bucket.
 *   - Extrapolate by `remainingBuckets` buckets.
 *   - Add to the cumulative-to-date.
 *
 * Returns { projected, current, ratePerBucket }. The UI renders this as
 * "On track for $X by end of month — currently $Y, burn rate $Z/day".
 *
 * Why not a fancier model? Cost Management already exposes a forecast
 * API; we're providing a quick visual on the data the operator already
 * loaded. A linear fit is enough to surface "you're going to blow past
 * the budget" without making promises the data can't keep.
 */
export interface BudgetForecast {
    /** Sum of every bucket in `series` (negative values clamped to 0). */
    readonly current: number;
    /** Average per-bucket spend over the trailing window. */
    readonly ratePerBucket: number;
    /** Projected total: current + ratePerBucket * remainingBuckets. */
    readonly projected: number;
    /** Buckets used to compute the rate (clamped to series length). */
    readonly windowUsed: number;
}
export declare function forecastBudget(series: ReadonlyArray<CostSeriesPoint>, remainingBuckets: number, runRateWindow?: number): BudgetForecast;
//# sourceMappingURL=cost-anomaly-detector.d.ts.map