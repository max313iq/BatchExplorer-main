/**
 * Pure helpers for the Account Info page: numeric coercion, sorting,
 * CSV serialisation and aggregation. No DOM globals are read directly —
 * the optional download helper accepts a dependency object so callers
 * (and tests) can substitute fakes.
 */
import { AccountInfo } from "../../store/store-types";
/** Safely read a numeric value, returning 0 for null/undefined/NaN. */
export declare function safeNum(value: number | null | undefined): number;
/** Compute usage percentage (0-100, clamped). */
export declare function usagePct(used: number, quota: number): number;
/**
 * Usage colour: green < 50%, orange 50-80%, red > 80%.
 * Returns CSS variable references so theme switching works.
 */
export declare function lpUsageColor(used: number, quota: number): string;
export type SortDirection = "asc" | "desc";
/** Keys recognised by `getSortValue`. Anything else returns 0. */
export type AccountInfoSortKey = "accountName" | "region" | "subscription" | "lpQuota" | "lpUsed" | "lpFree" | "dedicatedQuota" | "poolCount" | "poolQuota" | "poolsFree";
export interface SortConfig {
    key: string;
    direction: SortDirection;
}
export declare function getSortValue(item: AccountInfo, key: string): string | number;
export declare function sortAccounts(accounts: AccountInfo[], sortConfig: SortConfig | null): AccountInfo[];
export declare function ariaSort(sortConfig: SortConfig | null, key: string): "ascending" | "descending" | "none";
export declare function buildAccountInfoCsv(rows: AccountInfo[]): string;
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
/**
 * Trigger a CSV download in the browser.
 * Pure with respect to its inputs: pass `deps` in tests; production callers
 * can omit it and the function will resolve `document`, `URL`, `Blob` from
 * the ambient browser environment, returning `false` when none exist.
 *
 * @returns `true` when the download was triggered, `false` if no DOM was
 *          available (e.g. SSR / jest without jsdom).
 */
export declare function downloadAccountInfoCsv(rows: AccountInfo[], filename?: string, deps?: CsvDownloadDeps): boolean;
export interface AccountInfoSummary {
    totalAccounts: number;
    totalDedicatedQuota: number;
    totalLpQuota: number;
    totalLpUsed: number;
    totalLpFree: number;
    totalPools: number;
    avgLpUtilization: number;
}
export declare function summarizeAccountInfos(rows: AccountInfo[]): AccountInfoSummary;
//# sourceMappingURL=account-info-helpers.d.ts.map