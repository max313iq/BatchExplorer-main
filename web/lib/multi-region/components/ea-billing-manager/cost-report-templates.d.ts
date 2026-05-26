/**
 * cost-report-templates
 * =====================
 *
 * Pure types + a small reducer for "saved cost-report templates" — named
 * presets of the four Cost Management query knobs an EA admin tunes:
 *
 *   { type, timeframe, granularity, groupBy, minSpend }
 *
 * These get persisted via `usePersistedState` from the CostTab. We split
 * the type definitions + reducer logic out of the page file so a future
 * test harness can exercise the upsert / delete / dedupe rules without a
 * React render, and so the CostTab itself stays focused on rendering.
 *
 * No I/O here. No DOM. No React. Pure data.
 */
import type { CostQueryBody } from "../../services";
export interface CostReportTemplate {
    /** Unique slug, generated from the name; the key used for dedupe + delete. */
    id: string;
    /** Human-displayed label — what the operator typed when saving. */
    name: string;
    /** ISO timestamp the template was last saved. Used for "saved 3 days ago". */
    savedAt: string;
    /** The four cost-query knobs the template captures. */
    type: NonNullable<CostQueryBody["type"]>;
    timeframe: NonNullable<CostQueryBody["timeframe"]>;
    granularity: "None" | "Daily" | "Monthly";
    groupBy: string;
    /** Min-spend threshold filter (currency, not currency code). */
    minSpend: number;
}
/** The full persisted shape — versioned envelope wraps this in storage. */
export interface CostReportTemplatesState {
    templates: CostReportTemplate[];
}
export declare const EMPTY_TEMPLATES_STATE: CostReportTemplatesState;
/**
 * Slug-ify a human label into an id. We don't need to be perfect — just
 * stable across renders for the same input and unique-enough to avoid
 * collisions in a list a single human is realistically going to hand-
 * curate (under 50 entries).
 */
export declare function templateIdFromName(name: string): string;
/**
 * Upsert a template by id. If a template with the same id already
 * exists, the new one replaces it (and bumps savedAt). Otherwise it's
 * appended. Returns a new array; never mutates `prev`.
 *
 * Templates are kept sorted by savedAt DESC so the most-recently-saved
 * appears first in the "load" dropdown — that's what an operator
 * iterating on a query wants.
 */
export declare function upsertTemplate(prev: ReadonlyArray<CostReportTemplate>, next: CostReportTemplate): CostReportTemplate[];
/** Drop a template by id. Returns a new array; never mutates `prev`. */
export declare function removeTemplate(prev: ReadonlyArray<CostReportTemplate>, id: string): CostReportTemplate[];
/**
 * Find a template by id. Returns null when absent.
 */
export declare function findTemplate(list: ReadonlyArray<CostReportTemplate>, id: string): CostReportTemplate | null;
/**
 * Migration callback for usePersistedState. Tolerates two prior shapes:
 *
 *   - v0 (unversioned): bare `CostReportTemplate[]` (we drop into a
 *     `{ templates: [...] }` envelope and accept).
 *   - any other shape: returns undefined so the hook falls back to
 *     the default empty state.
 *
 * Per-field validation is intentionally minimal — if the operator's
 * localStorage has been tampered with, we'd rather show "no templates"
 * than crash the entire CostTab.
 */
export declare function migrateTemplates(raw: unknown, _oldVersion: number | undefined): CostReportTemplatesState | undefined;
//# sourceMappingURL=cost-report-templates.d.ts.map