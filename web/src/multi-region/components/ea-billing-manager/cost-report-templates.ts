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

/* ====================================================================== */
/* Persisted shape                                                        */
/* ====================================================================== */

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

export const EMPTY_TEMPLATES_STATE: CostReportTemplatesState = {
  templates: [],
};

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

/**
 * Slug-ify a human label into an id. We don't need to be perfect — just
 * stable across renders for the same input and unique-enough to avoid
 * collisions in a list a single human is realistically going to hand-
 * curate (under 50 entries).
 */
export function templateIdFromName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "untitled";
}

/* ====================================================================== */
/* Reducer-ish operations                                                 */
/* ====================================================================== */

/**
 * Upsert a template by id. If a template with the same id already
 * exists, the new one replaces it (and bumps savedAt). Otherwise it's
 * appended. Returns a new array; never mutates `prev`.
 *
 * Templates are kept sorted by savedAt DESC so the most-recently-saved
 * appears first in the "load" dropdown — that's what an operator
 * iterating on a query wants.
 */
export function upsertTemplate(
  prev: ReadonlyArray<CostReportTemplate>,
  next: CostReportTemplate,
): CostReportTemplate[] {
  const without = prev.filter((t) => t.id !== next.id);
  return [next, ...without].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Drop a template by id. Returns a new array; never mutates `prev`. */
export function removeTemplate(
  prev: ReadonlyArray<CostReportTemplate>,
  id: string,
): CostReportTemplate[] {
  return prev.filter((t) => t.id !== id);
}

/**
 * Find a template by id. Returns null when absent.
 */
export function findTemplate(
  list: ReadonlyArray<CostReportTemplate>,
  id: string,
): CostReportTemplate | null {
  return list.find((t) => t.id === id) ?? null;
}

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
export function migrateTemplates(
  raw: unknown,
  _oldVersion: number | undefined,
): CostReportTemplatesState | undefined {
  if (Array.isArray(raw)) {
    // Legacy bare-array shape.
    return { templates: raw.filter(isTemplateShape) };
  }
  if (
    raw &&
    typeof raw === "object" &&
    "templates" in (raw as Record<string, unknown>) &&
    Array.isArray((raw as { templates: unknown }).templates)
  ) {
    return {
      templates: (raw as { templates: unknown[] }).templates.filter(
        isTemplateShape,
      ),
    };
  }
  return undefined;
}

function isTemplateShape(v: unknown): v is CostReportTemplate {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.savedAt === "string" &&
    typeof o.type === "string" &&
    typeof o.timeframe === "string" &&
    typeof o.granularity === "string" &&
    typeof o.groupBy === "string" &&
    typeof o.minSpend === "number"
  );
}
