import { AccountInfo } from "../../store/store-types";

/* ------------------------------------------------------------------ */
/* Numeric helpers                                                     */
/* ------------------------------------------------------------------ */

/** Safely read a numeric value, returning 0 for null/undefined/NaN. */
export function safeNum(value: number | null | undefined): number {
    if (value == null || isNaN(value)) return 0;
    return value;
}

/** Compute usage percentage (0-100, clamped). */
export function usagePct(used: number, quota: number): number {
    if (quota <= 0) return 0;
    return Math.min(100, Math.round((used / quota) * 100));
}

/**
 * Usage colour: green < 50%, orange 50-80%, red > 80%.
 * Returns CSS variable references so theme switching works.
 */
export function lpUsageColor(used: number, quota: number): string {
    if (quota <= 0) return "var(--text-muted, #999)";
    const pct = (used / quota) * 100;
    if (pct > 80) return "var(--danger, #d13438)";
    if (pct >= 50) return "var(--warning, #e3a400)";
    return "var(--success, #107c10)";
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

export type SortDirection = "asc" | "desc";

export interface SortConfig {
    key: string;
    direction: SortDirection;
}

export function getSortValue(item: AccountInfo, key: string): string | number {
    switch (key) {
        case "accountName":
            return item.accountName ?? "";
        case "region":
            return item.region ?? "";
        case "subscription":
            return item.subscriptionId ?? "";
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

export function sortAccounts(
    accounts: AccountInfo[],
    sortConfig: SortConfig | null
): AccountInfo[] {
    if (!sortConfig) return accounts;
    const sorted = [...accounts].sort((a, b) => {
        const aVal = getSortValue(a, sortConfig.key);
        const bVal = getSortValue(b, sortConfig.key);
        if (typeof aVal === "string" && typeof bVal === "string") {
            const cmp = aVal.localeCompare(bVal);
            return sortConfig.direction === "asc" ? cmp : -cmp;
        }
        return sortConfig.direction === "asc"
            ? (aVal as number) - (bVal as number)
            : (bVal as number) - (aVal as number);
    });
    return sorted;
}

export function ariaSort(
    sortConfig: SortConfig | null,
    key: string
): "ascending" | "descending" | "none" {
    if (!sortConfig || sortConfig.key !== key) return "none";
    return sortConfig.direction === "asc" ? "ascending" : "descending";
}

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

const CSV_HEADERS: ReadonlyArray<{ label: string; key: keyof AccountInfo }> = [
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

function escapeCsvField(value: unknown): string {
    if (value == null) return "";
    const str = String(value);
    // Quote if contains comma, quote, newline, or carriage return
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

export function buildAccountInfoCsv(rows: AccountInfo[]): string {
    const lines: string[] = [];
    lines.push(CSV_HEADERS.map((h) => escapeCsvField(h.label)).join(","));
    for (const row of rows) {
        lines.push(
            CSV_HEADERS.map((h) => escapeCsvField(row[h.key])).join(",")
        );
    }
    return lines.join("\r\n");
}

/**
 * Trigger a CSV download in the browser.
 * Uses Blob + object URL; safe to call without DOM globals (no-op if document missing).
 */
export function downloadAccountInfoCsv(
    rows: AccountInfo[],
    filename = "account-info.csv"
): void {
    if (typeof document === "undefined") return;
    const csv = buildAccountInfoCsv(rows);
    const blob = new Blob(["﻿" + csv], {
        type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Defer revoke so Safari has time to start the download
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export interface AccountInfoSummary {
    totalAccounts: number;
    totalDedicatedQuota: number;
    totalLpQuota: number;
    totalLpUsed: number;
    totalLpFree: number;
    totalPools: number;
    avgLpUtilization: number;
}

export function summarizeAccountInfos(rows: AccountInfo[]): AccountInfoSummary {
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
