/**
 * Shared table primitives for tabular data: the canonical `<DataTable>`
 * (Contract §5) plus the legacy `<EnhancedTable>` surface kept for callers
 * that haven't migrated yet — both live here so consumers can import either
 * via the same module path.
 */
import * as React from "react";
export interface DataTableColumn<T> {
    /** Stable id; used as the sort/visibility key. */
    id: string;
    header: React.ReactNode;
    /** Render the cell. */
    cell: (row: T) => React.ReactNode;
    /** Optional sort comparator. If omitted, column is not sortable. */
    sort?: (a: T, b: T) => number;
    /** Optional CSS class on header + cells. */
    className?: string;
    /** Optional fixed-width tailwind class (e.g. "w-32"). */
    width?: string;
    /** Optional CSV-export accessor. If omitted, column is excluded from CSV. */
    csv?: (row: T) => string | number | null | undefined;
    /**
     * Optional JSON-export accessor + key. When provided, the column
     * contributes a `{ [jsonKey]: jsonValue }` pair to each row in the
     * exported JSON. Falls back to a `camelCased(header || id)` key with
     * the `csv` accessor's value if `csv` is set but `json` is omitted.
     * Pass an explicit `json: false` to opt a column out of JSON.
     */
    json?: false | {
        key: string;
        value: (row: T) => unknown;
    };
    /** Hide by default. User can re-enable via the column-visibility menu. */
    defaultHidden?: boolean;
}
export interface DataTableProps<T> {
    /** Stable id for persisted sort/visibility (consumer-managed). */
    tableId: string;
    rows: T[];
    columns: DataTableColumn<T>[];
    rowKey: (row: T) => string;
    /** Optional empty state. Falls back to a small "No data" message. */
    empty?: React.ReactNode;
    /** Optional loading flag — renders skeleton rows. */
    loading?: boolean;
    /** Optional row selection set + change handler. */
    selection?: Set<string>;
    onSelectionChange?: (next: Set<string>) => void;
    /** Optional row-click activation (Enter / click). */
    onRowActivate?: (row: T) => void;
    /** Optional fileName for CSV export — default `"export-{tableId}.csv"`. */
    csvFileName?: string;
    /** Optional fileName for JSON export — default `"export-{tableId}.json"`. */
    jsonFileName?: string;
    /** Optional className on the wrapping container. */
    className?: string;
    /** Optional initial sort. */
    initialSort?: {
        column: string;
        direction: "asc" | "desc";
    };
}
export declare function DataTable<T>(props: DataTableProps<T>): JSX.Element;
export interface EnhancedColumn<T> {
    key: string;
    name: string;
    minWidth: number;
    maxWidth?: number;
    /** Custom cell renderer. */
    onRender?: (item: T) => React.ReactNode;
    /**
     * Value accessor used for sorting and global search.
     * Falls back to `(item as any)[column.key]` when omitted.
     */
    getValue?: (item: T) => string | number;
    /** If true a per-column filter dropdown is shown (use `filters` prop). */
    filterable?: boolean;
    /** Whether the column is sortable. Defaults to `true`. */
    sortable?: boolean;
}
export interface FilterConfig {
    columnKey: string;
    options: {
        key: string;
        text: string;
    }[];
    selectedKeys?: string[];
    onChange: (keys: string[]) => void;
}
export interface EnhancedTableProps<T> {
    items: T[];
    columns: EnhancedColumn<T>[];
    selectedIds?: Set<string>;
    onSelectionChange?: (ids: Set<string>) => void;
    getRowId: (item: T) => string;
    searchPlaceholder?: string;
    filters?: FilterConfig[];
    emptyMessage?: string;
    compact?: boolean;
    /**
     * Number of rows per page. Pass `0` or omit to disable pagination.
     */
    pageSize?: number;
}
/**
 * Generic, reusable table built on shadcn-ui primitives.
 *
 * @deprecated Prefer `DataTable` for new code. This component is kept
 * unchanged so existing pages (`tenant-users-page`, `user-creator-page`)
 * continue to work; migration to `DataTable` is tracked in Plan F/K.
 */
export declare const EnhancedTable: <T>(props: EnhancedTableProps<T> & {
    ref?: React.Ref<unknown> | undefined;
}) => React.ReactElement;
//# sourceMappingURL=enhanced-table.d.ts.map