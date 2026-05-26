/// <reference types="react" />
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
export declare function ExportMenu<T>(props: ExportMenuProps<T>): JSX.Element;
//# sourceMappingURL=export-menu.d.ts.map