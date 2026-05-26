/**
 * Pure helpers for the Account Info page: numeric coercion, sorting,
 * CSV serialisation and aggregation. No DOM globals are read directly —
 * the optional download helper accepts a dependency object so callers
 * (and tests) can substitute fakes.
 */
/* ------------------------------------------------------------------ */
/* Numeric helpers                                                     */
/* ------------------------------------------------------------------ */
/** Safely read a numeric value, returning 0 for null/undefined/NaN. */
export function safeNum(value) {
    if (value == null || Number.isNaN(value))
        return 0;
    return value;
}
/** Compute usage percentage (0-100, clamped). */
export function usagePct(used, quota) {
    if (quota <= 0)
        return 0;
    return Math.min(100, Math.round((used / quota) * 100));
}
/**
 * Usage colour: green < 50%, orange 50-80%, red > 80%.
 * Returns CSS variable references so theme switching works.
 */
export function lpUsageColor(used, quota) {
    if (quota <= 0)
        return "var(--text-muted, #999)";
    const pct = (used / quota) * 100;
    if (pct > 80)
        return "var(--danger, #d13438)";
    if (pct >= 50)
        return "var(--warning, #e3a400)";
    return "var(--success, #107c10)";
}
export function getSortValue(item, key) {
    var _a, _b, _c;
    switch (key) {
        case "accountName":
            return (_a = item.accountName) !== null && _a !== void 0 ? _a : "";
        case "region":
            return (_b = item.region) !== null && _b !== void 0 ? _b : "";
        case "subscription":
            return (_c = item.subscriptionId) !== null && _c !== void 0 ? _c : "";
        case "lpQuota":
            return safeNum(item.lowPriorityCoreQuota);
        case "lpUsed":
            return safeNum(item.lowPriorityCoresUsed);
        case "lpFree":
            return safeNum(item.lowPriorityCoresFree);
        case "dedicatedQuota":
            return safeNum(item.dedicatedCoreQuota);
        case "poolCount":
            return safeNum(item.poolCount);
        case "poolQuota":
            return safeNum(item.poolQuota);
        case "poolsFree":
            return safeNum(item.poolsFree);
        default:
            return 0;
    }
}
/** Compare two sort values respecting their runtime type. */
function compareSortValues(aVal, bVal) {
    if (typeof aVal === "string" && typeof bVal === "string") {
        return aVal.localeCompare(bVal);
    }
    if (typeof aVal === "number" && typeof bVal === "number") {
        return aVal - bVal;
    }
    // Mixed types: coerce to string for a stable, deterministic order.
    return String(aVal).localeCompare(String(bVal));
}
export function sortAccounts(accounts, sortConfig) {
    if (!sortConfig)
        return accounts;
    const { key, direction } = sortConfig;
    const sign = direction === "asc" ? 1 : -1;
    return [...accounts].sort((a, b) => {
        const cmp = compareSortValues(getSortValue(a, key), getSortValue(b, key));
        return sign * cmp;
    });
}
export function ariaSort(sortConfig, key) {
    if (!sortConfig || sortConfig.key !== key)
        return "none";
    return sortConfig.direction === "asc" ? "ascending" : "descending";
}
/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */
const CSV_HEADERS = [
    { label: "Account Name", key: "accountName" },
    { label: "Region", key: "region" },
    { label: "Subscription Id", key: "subscriptionId" },
    { label: "Resource Group", key: "resourceGroup" },
    { label: "LP Quota", key: "lowPriorityCoreQuota" },
    { label: "LP Used", key: "lowPriorityCoresUsed" },
    { label: "LP Free", key: "lowPriorityCoresFree" },
    { label: "Dedicated Quota", key: "dedicatedCoreQuota" },
    { label: "Dedicated Used", key: "dedicatedCoresUsed" },
    { label: "Dedicated Free", key: "dedicatedCoresFree" },
    { label: "Pool Count", key: "poolCount" },
    { label: "Pool Quota", key: "poolQuota" },
    { label: "Pools Free", key: "poolsFree" },
];
/** UTF-8 BOM so Excel opens CSVs with non-ASCII content correctly. */
const UTF8_BOM = "﻿";
function escapeCsvField(value) {
    if (value == null)
        return "";
    const str = typeof value === "string" ? value : String(value);
    // Quote if contains comma, quote, newline, or carriage return
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}
export function buildAccountInfoCsv(rows) {
    const lines = [];
    lines.push(CSV_HEADERS.map((h) => escapeCsvField(h.label)).join(","));
    for (const row of rows) {
        lines.push(CSV_HEADERS.map((h) => escapeCsvField(row[h.key])).join(","));
    }
    return lines.join("\r\n");
}
/** Resolve the default browser dependencies, or `null` when no DOM exists. */
function resolveDefaultDeps() {
    if (typeof document === "undefined" ||
        typeof URL === "undefined" ||
        typeof Blob === "undefined") {
        return null;
    }
    return {
        doc: document,
        urlFactory: URL,
        defer: (fn, ms) => {
            setTimeout(fn, ms);
        },
        blobCtor: Blob,
    };
}
/**
 * Trigger a CSV download in the browser.
 * Pure with respect to its inputs: pass `deps` in tests; production callers
 * can omit it and the function will resolve `document`, `URL`, `Blob` from
 * the ambient browser environment, returning `false` when none exist.
 *
 * @returns `true` when the download was triggered, `false` if no DOM was
 *          available (e.g. SSR / jest without jsdom).
 */
export function downloadAccountInfoCsv(rows, filename = "account-info.csv", deps) {
    const resolved = deps !== null && deps !== void 0 ? deps : resolveDefaultDeps();
    if (!resolved)
        return false;
    const { doc, urlFactory, defer, blobCtor } = resolved;
    const BlobImpl = blobCtor !== null && blobCtor !== void 0 ? blobCtor : Blob;
    const csv = buildAccountInfoCsv(rows);
    const blob = new BlobImpl([UTF8_BOM + csv], {
        type: "text/csv;charset=utf-8;",
    });
    const url = urlFactory.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    doc.body.appendChild(link);
    link.click();
    doc.body.removeChild(link);
    // Defer revoke so Safari has time to start the download.
    const deferImpl = defer !== null && defer !== void 0 ? defer : ((fn, ms) => {
        setTimeout(fn, ms);
    });
    deferImpl(() => urlFactory.revokeObjectURL(url), 1000);
    return true;
}
export function summarizeAccountInfos(rows) {
    let totalDedicatedQuota = 0;
    let totalLpQuota = 0;
    let totalLpUsed = 0;
    let totalPools = 0;
    for (const a of rows) {
        totalDedicatedQuota += safeNum(a.dedicatedCoreQuota);
        totalLpQuota += safeNum(a.lowPriorityCoreQuota);
        totalLpUsed += safeNum(a.lowPriorityCoresUsed);
        totalPools += safeNum(a.poolCount);
    }
    return {
        totalAccounts: rows.length,
        totalDedicatedQuota,
        totalLpQuota,
        totalLpUsed,
        totalLpFree: totalLpQuota - totalLpUsed,
        totalPools,
        avgLpUtilization: usagePct(totalLpUsed, totalLpQuota),
    };
}
//# sourceMappingURL=account-info-helpers.js.map