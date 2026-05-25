/**
 * Pure helpers for the Account Info page: numeric coercion, sorting,
 * CSV serialisation and aggregation. No DOM globals are read directly —
 * the optional download helper accepts a dependency object so callers
 * (and tests) can substitute fakes.
 */

import { AccountInfo } from "../../store/store-types";

/* ------------------------------------------------------------------ */
/* Numeric helpers                                                     */
/* ------------------------------------------------------------------ */

/** Safely read a numeric value, returning 0 for null/undefined/NaN. */
export function safeNum(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
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

/** Keys recognised by `getSortValue`. Anything else returns 0. */
export type AccountInfoSortKey =
  | "accountName"
  | "region"
  | "subscription"
  | "lpQuota"
  | "lpUsed"
  | "lpFree"
  | "dedicatedQuota"
  | "poolCount"
  | "poolQuota"
  | "poolsFree";

export interface SortConfig {
  key: string;
  direction: SortDirection;
}

export function getSortValue(
  item: AccountInfo,
  key: string,
): string | number {
  switch (key as AccountInfoSortKey) {
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

/** Compare two sort values respecting their runtime type. */
function compareSortValues(
  aVal: string | number,
  bVal: string | number,
): number {
  if (typeof aVal === "string" && typeof bVal === "string") {
    return aVal.localeCompare(bVal);
  }
  if (typeof aVal === "number" && typeof bVal === "number") {
    return aVal - bVal;
  }
  // Mixed types: coerce to string for a stable, deterministic order.
  return String(aVal).localeCompare(String(bVal));
}

export function sortAccounts(
  accounts: AccountInfo[],
  sortConfig: SortConfig | null,
): AccountInfo[] {
  if (!sortConfig) return accounts;
  const { key, direction } = sortConfig;
  const sign = direction === "asc" ? 1 : -1;
  return [...accounts].sort((a, b) => {
    const cmp = compareSortValues(getSortValue(a, key), getSortValue(b, key));
    return sign * cmp;
  });
}

export function ariaSort(
  sortConfig: SortConfig | null,
  key: string,
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

/** UTF-8 BOM so Excel opens CSVs with non-ASCII content correctly. */
const UTF8_BOM = "﻿";

function escapeCsvField(value: unknown): string {
  if (value == null) return "";
  const str = typeof value === "string" ? value : String(value);
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
    lines.push(CSV_HEADERS.map((h) => escapeCsvField(row[h.key])).join(","));
  }
  return lines.join("\r\n");
}

/**
 * Side-effectful dependencies needed to trigger a browser download.
 * Injecting them keeps `downloadAccountInfoCsv` testable: pass fakes
 * in unit tests, real `window`/`document` in production.
 */
export interface CsvDownloadDeps {
  doc: Pick<Document, "createElement" | "body">;
  urlFactory: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  /** Optional defer for `revokeObjectURL`; defaults to `setTimeout`. */
  defer?: (fn: () => void, ms: number) => void;
  /** Optional Blob constructor so jsdom-less envs can inject a stub. */
  blobCtor?: typeof Blob;
}

/** Resolve the default browser dependencies, or `null` when no DOM exists. */
function resolveDefaultDeps(): CsvDownloadDeps | null {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof Blob === "undefined"
  ) {
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
export function downloadAccountInfoCsv(
  rows: AccountInfo[],
  filename = "account-info.csv",
  deps?: CsvDownloadDeps,
): boolean {
  const resolved = deps ?? resolveDefaultDeps();
  if (!resolved) return false;
  const { doc, urlFactory, defer, blobCtor } = resolved;
  const BlobImpl = blobCtor ?? Blob;
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
  const deferImpl =
    defer ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms);
    });
  deferImpl(() => urlFactory.revokeObjectURL(url), 1000);
  return true;
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
