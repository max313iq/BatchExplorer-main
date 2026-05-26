/**
 * Generic "Export" dropdown for any list page.
 *
 * Drop one of these next to your filter toolbar and it'll let the operator
 * dump the currently-filtered view to either CSV (Excel-friendly) or JSON
 * (machine-friendly, preserves field shape).
 *
 * The component is intentionally small and stateless — pass it the rows
 * you want exported and a `columns` descriptor that knows how to extract
 * CSV-friendly scalars. JSON export simply serializes the raw row objects
 * (the operator usually wants full fidelity for JSON anyway).
 *
 * Why this exists alongside DataTable's built-in CSV button:
 *   - DataTable's button is column-scoped (only the visible CSV-capable
 *     columns get exported). Many pages don't use DataTable yet (audit-log,
 *     monitoring) and need an export action in their toolbar.
 *   - JSON export wasn't supported anywhere previously — adding the option
 *     here gives every page the same two-format affordance.
 */
import * as React from "react";
import { Download, FileJson, FileSpreadsheet } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadCsv, downloadJson } from "@/lib/utils";

/**
 * Column descriptor that knows how to map a row to a CSV scalar. This is a
 * deliberately lighter contract than `DataTableColumn`: it does not carry
 * a React renderer because exports are headless.
 */
export interface ExportColumn<T> {
  /** CSV header text. */
  header: string;
  /** Scalar accessor — string or number is ideal, null/undefined → empty. */
  accessor: (row: T) => string | number | boolean | null | undefined;
}

export interface ExportMenuProps<T> {
  /** Rows in the order to be exported (caller pre-filters / sorts). */
  rows: readonly T[];
  /** Column definitions for CSV. JSON ignores these and writes raw rows. */
  columns: readonly ExportColumn<T>[];
  /**
   * Base filename (no extension). The component appends `.csv` / `.json`
   * and the current date (YYYY-MM-DD) to keep multiple exports separable.
   */
  filename: string;
  /** Optional map of additional metadata embedded as a top-level field in
   *  the JSON output (e.g. `{ filtersApplied: {...} }`). Not used for CSV. */
  jsonMetadata?: Record<string, unknown>;
  /** Disable the menu (e.g. no rows). Defaults to false. */
  disabled?: boolean;
  /** Label override (defaults to "Export"). */
  label?: string;
  /** Optional className on the trigger button. */
  className?: string;
  /** Optional override for the visible row count badge. Defaults to rows.length. */
  rowCount?: number;
}

/**
 * Add today's date suffix to a base filename: "audit-log" → "audit-log-2026-05-20".
 * Using ISO date keeps file lists naturally sorted in the file picker.
 */
function withDateStamp(base: string): string {
  const d = new Date();
  const iso = d.toISOString().slice(0, 10);
  return `${base}-${iso}`;
}

/** Coerce arbitrary values to CSV-safe scalars (strings / numbers). */
function csvValue(v: string | number | boolean | null | undefined): string | number {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
}

export function ExportMenu<T>(props: ExportMenuProps<T>): JSX.Element {
  const {
    rows,
    columns,
    filename,
    jsonMetadata,
    disabled = false,
    label = "Export",
    className,
    rowCount,
  } = props;

  const stampedName = React.useMemo(() => withDateStamp(filename), [filename]);
  const displayCount = rowCount ?? rows.length;

  const handleExportCsv = React.useCallback(() => {
    if (rows.length === 0 || columns.length === 0) return;
    const headers = columns.map((c) => c.header);
    const csvRows = rows.map((row) =>
      columns.map((c) => csvValue(c.accessor(row))),
    );
    downloadCsv(`${stampedName}.csv`, [headers, ...csvRows]);
  }, [rows, columns, stampedName]);

  const handleExportJson = React.useCallback(() => {
    if (rows.length === 0) return;
    const payload =
      jsonMetadata == null
        ? rows
        : {
            ...jsonMetadata,
            exportedAt: new Date().toISOString(),
            rowCount: rows.length,
            rows,
          };
    downloadJson(`${stampedName}.json`, payload);
  }, [rows, jsonMetadata, stampedName]);

  const empty = displayCount === 0;
  const isDisabled = disabled || empty;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isDisabled}
          className={className}
          aria-label={
            empty
              ? `${label} (no rows to export)`
              : `${label} ${displayCount} row${displayCount === 1 ? "" : "s"}`
          }
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Export {displayCount} row{displayCount === 1 ? "" : "s"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={handleExportCsv}
          disabled={empty || columns.length === 0}
        >
          <FileSpreadsheet aria-hidden />
          <span>CSV (.csv)</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleExportJson} disabled={empty}>
          <FileJson aria-hidden />
          <span>JSON (.json)</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
