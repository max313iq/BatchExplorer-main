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
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
/** Combine and dedupe Tailwind class names. */
export function cn(...inputs) {
    return twMerge(clsx(inputs));
}
// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------
/**
 * Locale-formatted number. Returns `"—"` for non-finite inputs so callers
 * can render placeholders without ternaries everywhere.
 */
export function formatNumber(value, options) {
    if (value == null || !Number.isFinite(value)) {
        return "—";
    }
    return new Intl.NumberFormat(undefined, options).format(value);
}
// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------
/**
 * Format an ISO timestamp or Date as a short relative string like "5m ago",
 * "2h ago", "3d ago", "1mo ago". Returns `"—"` for invalid inputs and
 * `"just now"` for anything within the last 5 seconds.
 *
 * `now` is parameterizable for deterministic rendering inside tests.
 */
export function formatRelativeTime(input, now = Date.now()) {
    if (input == null)
        return "—";
    const then = input instanceof Date ? input.getTime() : new Date(input).getTime();
    if (!Number.isFinite(then))
        return "—";
    const nowMs = typeof now === "number" ? now : now.getTime();
    const deltaMs = nowMs - then;
    const absMs = Math.abs(deltaMs);
    const future = deltaMs < 0;
    const sec = Math.round(absMs / 1000);
    if (sec < 5)
        return "just now";
    if (sec < 60)
        return future ? `in ${sec}s` : `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60)
        return future ? `in ${min}m` : `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24)
        return future ? `in ${hr}h` : `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30)
        return future ? `in ${day}d` : `${day}d ago`;
    const mo = Math.round(day / 30);
    if (mo < 12)
        return future ? `in ${mo}mo` : `${mo}mo ago`;
    const yr = Math.round(mo / 12);
    return future ? `in ${yr}y` : `${yr}y ago`;
}
/**
 * Locale-formatted date+time like `"2026-05-26 14:32"`. Returns `"—"` for
 * invalid inputs so callers can render placeholders.
 */
export function formatDateTime(input, options) {
    if (input == null)
        return "—";
    const d = input instanceof Date ? input : new Date(input);
    if (!Number.isFinite(d.getTime()))
        return "—";
    return new Intl.DateTimeFormat(undefined, Object.assign({ year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }, options)).format(d);
}
// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------
/**
 * Returns `singular` when `count === 1`, otherwise `plural` (default:
 * `singular + "s"`). Counts are *not* prepended — callers compose
 * (e.g. `${n} ${pluralize(n, "pool")}`).
 */
export function pluralize(count, singular, plural) {
    if (count === 1)
        return singular;
    return plural !== null && plural !== void 0 ? plural : `${singular}s`;
}
// ---------------------------------------------------------------------------
// Comparators (for stable Array.sort)
// ---------------------------------------------------------------------------
/** Numeric ascending; NaN/null sort to the end. */
export function compareNumbers(a, b) {
    const aOk = a != null && Number.isFinite(a);
    const bOk = b != null && Number.isFinite(b);
    if (!aOk && !bOk)
        return 0;
    if (!aOk)
        return 1;
    if (!bOk)
        return -1;
    return a - b;
}
/** Locale string ascending (case-insensitive); null/undefined sort to the end. */
export function compareStrings(a, b) {
    if (a == null && b == null)
        return 0;
    if (a == null)
        return 1;
    if (b == null)
        return -1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
}
// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------
/** Promise that resolves after `ms` milliseconds. */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ---------------------------------------------------------------------------
// Browser-side downloads
// ---------------------------------------------------------------------------
function triggerDownload(blob, filename) {
    if (typeof document === "undefined" || typeof URL === "undefined")
        return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
/**
 * Trigger a CSV download. Accepts either a pre-built CSV string or a 2-D
 * array of cells; the array form quotes/escapes per RFC 4180.
 */
export function downloadCsv(filename, payload) {
    const csv = typeof payload === "string"
        ? payload
        : payload
            .map((row) => row
            .map((cell) => {
            if (cell == null)
                return "";
            const s = String(cell);
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
            .join(","))
            .join("\r\n");
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
}
/** Trigger a JSON download. Pretty-printed with 2-space indent. */
export function downloadJson(filename, payload) {
    const json = JSON.stringify(payload, null, 2);
    triggerDownload(new Blob([json], { type: "application/json;charset=utf-8" }), filename);
}
//# sourceMappingURL=utils.js.map