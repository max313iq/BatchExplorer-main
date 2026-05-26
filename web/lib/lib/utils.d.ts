/**
 * Shared utilities consumed via the `@/lib/utils` alias (see web/tsconfig
 * common config — `"paths": { "@/*": ["./*"] }` resolves `@/lib/utils` to
 * `web/src/lib/utils`).
 *
 * This file was missing at the start of the verification pass; ~98 source
 * files imported from it, producing TS2307 across the project. The helpers
 * here cover everything the consumers actually pull in (`cn`,
 * `formatNumber`, `formatRelativeTime`, `formatDateTime`, `pluralize`,
 * `downloadCsv`, `downloadJson`, `compareNumbers`, `compareStrings`,
 * `sleep`).
 *
 * `cn` is the canonical shadcn-style class-name combiner — `clsx` for
 * conditional joining, `tailwind-merge` to dedupe conflicting Tailwind
 * classes (so `cn("p-2", "p-4")` → `"p-4"`). Both deps are already
 * declared in web/package.json.
 */
import { type ClassValue } from "clsx";
/** Combine and dedupe Tailwind class names. */
export declare function cn(...inputs: ClassValue[]): string;
/**
 * Locale-formatted number. Returns `"—"` for non-finite inputs so callers
 * can render placeholders without ternaries everywhere.
 */
export declare function formatNumber(value: number | null | undefined, options?: Intl.NumberFormatOptions): string;
/**
 * Format an ISO timestamp or Date as a short relative string like "5m ago",
 * "2h ago", "3d ago", "1mo ago". Returns `"—"` for invalid inputs and
 * `"just now"` for anything within the last 5 seconds.
 *
 * `now` is parameterizable for deterministic rendering inside tests.
 */
export declare function formatRelativeTime(input: string | number | Date | null | undefined, now?: Date | number): string;
/**
 * Locale-formatted date+time like `"2026-05-26 14:32"`. Returns `"—"` for
 * invalid inputs so callers can render placeholders.
 */
export declare function formatDateTime(input: string | number | Date | null | undefined, options?: Intl.DateTimeFormatOptions): string;
/**
 * Returns `singular` when `count === 1`, otherwise `plural` (default:
 * `singular + "s"`). Counts are *not* prepended — callers compose
 * (e.g. `${n} ${pluralize(n, "pool")}`).
 */
export declare function pluralize(count: number, singular: string, plural?: string): string;
/** Numeric ascending; NaN/null sort to the end. */
export declare function compareNumbers(a: number | null | undefined, b: number | null | undefined): number;
/** Locale string ascending (case-insensitive); null/undefined sort to the end. */
export declare function compareStrings(a: string | null | undefined, b: string | null | undefined): number;
/** Promise that resolves after `ms` milliseconds. */
export declare function sleep(ms: number): Promise<void>;
/**
 * Trigger a CSV download. Accepts either a pre-built CSV string or a 2-D
 * array of cells; the array form quotes/escapes per RFC 4180.
 */
export declare function downloadCsv(filename: string, payload: string | ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>): void;
/** Trigger a JSON download. Pretty-printed with 2-space indent. */
export declare function downloadJson(filename: string, payload: unknown): void;
//# sourceMappingURL=utils.d.ts.map