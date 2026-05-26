/**
 * Shared table primitives for tabular data: the canonical `<DataTable>`
 * (Contract §5) plus the legacy `<EnhancedTable>` surface kept for callers
 * that haven't migrated yet — both live here so consumers can import either
 * via the same module path.
 */
import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileJson,
  FileSpreadsheet,
  Filter as FilterIcon,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn, downloadCsv, downloadJson } from "@/lib/utils";

// ===========================================================================
// DataTable — the canonical table per Design Contract §5.
// ===========================================================================

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
  json?: false | { key: string; value: (row: T) => unknown };
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
  initialSort?: { column: string; direction: "asc" | "desc" };
}

interface DataTableSortState {
  column: string;
  direction: "asc" | "desc";
}

// Threshold above which row virtualization kicks in (Contract §5/§7).
const VIRTUALIZATION_THRESHOLD = 500;
// Estimated row height fallback for virtualization (matches comfortable
// density in tailwind.css; the actual height is read from `--row-height`).
const VIRTUAL_ROW_ESTIMATE_PX = 36;
// Max scroll-area height in virtualized mode — keeps the table from
// dominating a page even with thousands of rows.
const VIRTUAL_VIEWPORT_HEIGHT_PX = 600;

export function DataTable<T>(props: DataTableProps<T>): JSX.Element {
  const {
    tableId,
    rows,
    columns,
    rowKey,
    empty,
    loading = false,
    selection,
    onSelectionChange,
    onRowActivate,
    csvFileName,
    jsonFileName,
    className,
    initialSort,
  } = props;

  const [sort, setSort] = React.useState<DataTableSortState | null>(
    initialSort ?? null,
  );

  // Column visibility — keyed by column.id; defaults from `defaultHidden`.
  const [hiddenColumns, setHiddenColumns] = React.useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const c of columns) {
      if (c.defaultHidden) set.add(c.id);
    }
    return set;
  });

  // Track which column ids we've already initialized from `defaultHidden`
  // so re-renders with the same column set don't fight the user's choices.
  const seenIdsRef = React.useRef<Set<string>>(
    new Set(columns.map((c) => c.id)),
  );

  // If `columns` prop changes (different keys arrive), prune stale ids and
  // auto-apply `defaultHidden` for any column ids we haven't seen before —
  // without clobbering the user's toggles for columns that still exist.
  React.useEffect(() => {
    const currentIds = new Set(columns.map((c) => c.id));
    setHiddenColumns((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (currentIds.has(id)) next.add(id);
      }
      for (const c of columns) {
        if (c.defaultHidden && !seenIdsRef.current.has(c.id)) {
          next.add(c.id);
        }
      }
      return next;
    });
    seenIdsRef.current = currentIds;
  }, [columns]);

  const visibleColumns = React.useMemo(
    () => columns.filter((c) => !hiddenColumns.has(c.id)),
    [columns, hiddenColumns],
  );

  // Sorted view. If no sort or column lacks a comparator, return rows as-is.
  const sortedRows = React.useMemo(() => {
    // Defensive: callers occasionally pass `rows={undefined}` while
    // their data is still loading (e.g. tenant switch in flight) and
    // a synchronous re-render fires before the cancelled-flag drops
    // the stale set. Coerce to [] so the table renders empty instead
    // of crashing the whole page with "Cannot read properties of
    // undefined (reading 'slice')".
    const safeRows = rows ?? [];
    if (!sort) return safeRows;
    const col = columns.find((c) => c.id === sort.column);
    if (!col || !col.sort) return safeRows;
    const cmp = col.sort;
    const dir = sort.direction === "desc" ? -1 : 1;
    const copy = safeRows.slice();
    copy.sort((a, b) => cmp(a, b) * dir);
    return copy;
  }, [rows, sort, columns]);

  const handleHeaderSort = React.useCallback(
    (col: DataTableColumn<T>) => {
      if (!col.sort) return;
      setSort((prev) => {
        if (!prev || prev.column !== col.id) {
          return { column: col.id, direction: "asc" };
        }
        if (prev.direction === "asc") {
          return { column: col.id, direction: "desc" };
        }
        // Third click: clear the sort.
        return null;
      });
    },
    [],
  );

  const toggleColumnHidden = React.useCallback((id: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Selection helpers — only used when `selection` is provided.
  const visibleIds = React.useMemo(
    () => sortedRows.map((r) => rowKey(r)),
    [sortedRows, rowKey],
  );

  const allVisibleSelected = React.useMemo(() => {
    if (!selection || visibleIds.length === 0) return false;
    for (const id of visibleIds) {
      if (!selection.has(id)) return false;
    }
    return true;
  }, [selection, visibleIds]);

  const someVisibleSelected = React.useMemo(() => {
    if (!selection || visibleIds.length === 0) return false;
    for (const id of visibleIds) {
      if (selection.has(id)) return true;
    }
    return false;
  }, [selection, visibleIds]);

  const isIndeterminate = someVisibleSelected && !allVisibleSelected;

  const handleSelectAll = React.useCallback(() => {
    if (!onSelectionChange) return;
    const next = new Set(selection);
    if (allVisibleSelected) {
      for (const id of visibleIds) next.delete(id);
    } else {
      for (const id of visibleIds) next.add(id);
    }
    onSelectionChange(next);
  }, [onSelectionChange, selection, allVisibleSelected, visibleIds]);

  const handleRowToggle = React.useCallback(
    (id: string) => {
      if (!onSelectionChange) return;
      const next = new Set(selection);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      onSelectionChange(next);
    },
    [onSelectionChange, selection],
  );

  // CSV export — uses VISIBLE rows in current sort order, only columns with a
  // `csv` accessor.
  const handleExportCsv = React.useCallback(() => {
    const csvCols = visibleColumns.filter((c) => typeof c.csv === "function");
    if (csvCols.length === 0) return;
    const headers = csvCols.map((c) =>
      typeof c.header === "string" ? c.header : c.id,
    );
    const dataRows = sortedRows.map((r) =>
      csvCols.map((c) => {
        const v = c.csv ? c.csv(r) : "";
        return v == null ? "" : v;
      }),
    );
    const filename = csvFileName ?? `export-${tableId}.csv`;
    downloadCsv(filename, [headers, ...dataRows]);
  }, [visibleColumns, sortedRows, csvFileName, tableId]);

  // JSON export — derives a `{ [key]: value }` object per row from each
  // exportable column. Columns opt in via `column.json` (preferred) or
  // fall back to the `csv` accessor with a derived key. `column.json: false`
  // explicitly excludes the column.
  const handleExportJson = React.useCallback(() => {
    const exportCols = visibleColumns.filter((c) => {
      if (c.json === false) return false;
      return typeof c.json === "object" || typeof c.csv === "function";
    });
    if (exportCols.length === 0) return;
    // Derive a JSON-safe key for a column when `json` isn't an explicit object.
    const deriveKey = (c: DataTableColumn<T>): string => {
      if (typeof c.json === "object") return c.json.key;
      const label = typeof c.header === "string" ? c.header : c.id;
      return label
        .replace(/[^a-zA-Z0-9 ]+/g, "")
        .trim()
        .split(/\s+/)
        .map((w, i) =>
          i === 0
            ? w.charAt(0).toLowerCase() + w.slice(1)
            : w.charAt(0).toUpperCase() + w.slice(1),
        )
        .join("") || c.id;
    };
    const jsonRows = sortedRows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of exportCols) {
        const key = deriveKey(c);
        if (typeof c.json === "object") {
          out[key] = c.json.value(r);
        } else if (typeof c.csv === "function") {
          const v = c.csv(r);
          out[key] = v == null ? null : v;
        }
      }
      return out;
    });
    const filename = jsonFileName ?? `export-${tableId}.json`;
    downloadJson(filename, jsonRows);
  }, [visibleColumns, sortedRows, jsonFileName, tableId]);

  // Virtualization — only when row count exceeds the threshold.
  const shouldVirtualize = sortedRows.length > VIRTUALIZATION_THRESHOLD;
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? sortedRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => VIRTUAL_ROW_ESTIMATE_PX,
    overscan: 8,
  });

  const csvAvailable = visibleColumns.some(
    (c) => typeof c.csv === "function",
  );
  const jsonAvailable = visibleColumns.some(
    (c) => c.json !== false && (typeof c.json === "object" || typeof c.csv === "function"),
  );

  // ---- Render branches: loading / empty / table ---------------------------
  const showEmpty = !loading && sortedRows.length === 0;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Toolbar: column-visibility + CSV-export */}
      <div
        className="flex items-center justify-end gap-2"
        role="toolbar"
        aria-label="Table actions"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              aria-label="Toggle column visibility"
            >
              <SlidersHorizontal />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
            <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {columns.map((c) => {
              const hidden = hiddenColumns.has(c.id);
              const label =
                typeof c.header === "string" ? c.header : c.id;
              return (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={!hidden}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => toggleColumnHidden(c.id)}
                >
                  {label}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        {csvAvailable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={handleExportCsv}
            aria-label="Export visible rows to CSV"
          >
            <FileSpreadsheet />
            CSV
          </Button>
        )}
        {jsonAvailable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={handleExportJson}
            aria-label="Export visible rows to JSON"
          >
            <FileJson />
            JSON
          </Button>
        )}
      </div>

      {/* Loading / empty / table body */}
      {loading ? (
        <div className="rounded-md border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {selection !== undefined && (
                  <TableHead className="w-10 table-cell-header" />
                )}
                {visibleColumns.map((c) => (
                  <TableHead
                    key={c.id}
                    className={cn("table-cell-header", c.width, c.className)}
                  >
                    {c.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  {selection !== undefined && (
                    <TableCell className="w-10 table-cell-row">
                      <Skeleton className="h-4 w-4" />
                    </TableCell>
                  )}
                  {visibleColumns.map((c) => (
                    <TableCell
                      key={c.id}
                      className={cn("table-cell-row", c.width, c.className)}
                    >
                      <Skeleton className="h-4 w-3/4" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : showEmpty ? (
        <div className="rounded-md border border-dashed border-border bg-card">
          {empty ?? (
            <p className="m-0 p-6 text-center text-sm text-muted-foreground">
              No data.
            </p>
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="relative overflow-auto rounded-md border border-border bg-card"
          style={
            shouldVirtualize
              ? { maxHeight: VIRTUAL_VIEWPORT_HEIGHT_PX }
              : undefined
          }
        >
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="hover:bg-transparent">
                {selection !== undefined && (
                  <TableHead className="w-10 table-cell-header">
                    <Checkbox
                      checked={
                        isIndeterminate ? "indeterminate" : allVisibleSelected
                      }
                      onCheckedChange={handleSelectAll}
                      aria-label="Select all visible rows"
                    />
                  </TableHead>
                )}
                {visibleColumns.map((c) => {
                  const sortable = typeof c.sort === "function";
                  const isSorted = sort?.column === c.id;
                  const ariaSort: "ascending" | "descending" | "none" | undefined =
                    sortable
                      ? isSorted
                        ? sort?.direction === "desc"
                          ? "descending"
                          : "ascending"
                        : "none"
                      : undefined;
                  return (
                    <TableHead
                      key={c.id}
                      className={cn(
                        "table-cell-header",
                        c.width,
                        c.className,
                      )}
                      aria-sort={ariaSort}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => handleHeaderSort(c)}
                          className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background motion-reduce:transition-none"
                          aria-label={
                            typeof c.header === "string"
                              ? `Sort by ${c.header}`
                              : `Sort by ${c.id}`
                          }
                        >
                          <span>{c.header}</span>
                          {isSorted ? (
                            sort?.direction === "desc" ? (
                              <ChevronDown className="h-3 w-3" aria-hidden />
                            ) : (
                              <ChevronUp className="h-3 w-3" aria-hidden />
                            )
                          ) : null}
                        </button>
                      ) : (
                        <span>{c.header}</span>
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            {shouldVirtualize ? (
              <VirtualizedTableBody<T>
                rows={sortedRows}
                rowKey={rowKey}
                visibleColumns={visibleColumns}
                selection={selection}
                onRowToggle={handleRowToggle}
                onRowActivate={onRowActivate}
                virtualizer={rowVirtualizer}
              />
            ) : (
              <TableBody>
                {sortedRows.map((row) => (
                  <DataTableRow<T>
                    key={rowKey(row)}
                    row={row}
                    rowId={rowKey(row)}
                    visibleColumns={visibleColumns}
                    selection={selection}
                    onRowToggle={handleRowToggle}
                    onRowActivate={onRowActivate}
                  />
                ))}
              </TableBody>
            )}
          </Table>
        </div>
      )}
    </div>
  );
}

interface DataTableRowProps<T> {
  row: T;
  rowId: string;
  visibleColumns: DataTableColumn<T>[];
  selection: Set<string> | undefined;
  onRowToggle: (id: string) => void;
  onRowActivate?: (row: T) => void;
}

function DataTableRow<T>(props: DataTableRowProps<T>): JSX.Element {
  const { row, rowId, visibleColumns, selection, onRowToggle, onRowActivate } =
    props;
  const checked = selection?.has(rowId) ?? false;
  const interactive = typeof onRowActivate === "function";

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (!interactive) return;
      if (e.key === "Enter") {
        e.preventDefault();
        onRowActivate?.(row);
      }
    },
    [interactive, onRowActivate, row],
  );

  const handleClick = React.useCallback(() => {
    if (interactive) onRowActivate?.(row);
  }, [interactive, onRowActivate, row]);

  return (
    <TableRow
      data-state={checked ? "selected" : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      className={cn(
        interactive &&
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      )}
    >
      {selection !== undefined && (
        <TableCell
          className="w-10 table-cell-row"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={checked}
            onCheckedChange={() => onRowToggle(rowId)}
            aria-label="Select row"
          />
        </TableCell>
      )}
      {visibleColumns.map((c) => (
        <TableCell
          key={c.id}
          className={cn("table-cell-row", c.width, c.className)}
        >
          {c.cell(row)}
        </TableCell>
      ))}
    </TableRow>
  );
}

interface VirtualizedTableBodyProps<T> {
  rows: T[];
  rowKey: (row: T) => string;
  visibleColumns: DataTableColumn<T>[];
  selection: Set<string> | undefined;
  onRowToggle: (id: string) => void;
  onRowActivate?: (row: T) => void;
  // Use the concrete HTMLDivElement parameterization that matches the
  // virtualizer instance we create in this file (whose scroll element is
  // `HTMLDivElement | null`). The previous unparameterized
  // `ReturnType<typeof useVirtualizer>` resolved to `Virtualizer<Element, Element>`
  // and failed to accept the narrower `Virtualizer<HTMLDivElement, Element>`.
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;
}

function VirtualizedTableBody<T>(
  props: VirtualizedTableBodyProps<T>,
): JSX.Element {
  const {
    rows,
    rowKey,
    visibleColumns,
    selection,
    onRowToggle,
    onRowActivate,
    virtualizer,
  } = props;

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = items.length > 0 ? items[0].start : 0;
  const paddingBottom =
    items.length > 0 ? totalSize - items[items.length - 1].end : 0;
  const colSpan = visibleColumns.length + (selection !== undefined ? 1 : 0);

  return (
    <TableBody>
      {paddingTop > 0 && (
        <tr style={{ height: paddingTop }} aria-hidden>
          <td colSpan={colSpan} />
        </tr>
      )}
      {items.map((virtualItem) => {
        const row = rows[virtualItem.index];
        return (
          <DataTableRow<T>
            key={rowKey(row)}
            row={row}
            rowId={rowKey(row)}
            visibleColumns={visibleColumns}
            selection={selection}
            onRowToggle={onRowToggle}
            onRowActivate={onRowActivate}
          />
        );
      })}
      {paddingBottom > 0 && (
        <tr style={{ height: paddingBottom }} aria-hidden>
          <td colSpan={colSpan} />
        </tr>
      )}
    </TableBody>
  );
}

// ===========================================================================
// Legacy EnhancedTable — preserved for callers that haven't migrated to
// `DataTable` yet (tenant-users, user-creator). Do NOT delete; new code
// should prefer `DataTable`.
// ===========================================================================

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
  options: { key: string; text: string }[];
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

interface LegacySortState {
  columnKey: string;
  descending: boolean;
}

function legacyResolveValue<T>(
  item: T,
  col: EnhancedColumn<T>,
): string | number {
  if (col.getValue) {
    return col.getValue(item);
  }
  const raw = (item as Record<string, unknown>)[col.key];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") return raw;
  return String(raw);
}

function legacyCompareValues(
  a: string | number,
  b: string | number,
  descending: boolean,
): number {
  const dir = descending ? -1 : 1;

  if (typeof a === "number" && typeof b === "number") {
    return (a - b) * dir;
  }

  const aStr = String(a);
  const bStr = String(b);

  const aDate = Date.parse(aStr);
  const bDate = Date.parse(bStr);
  if (!isNaN(aDate) && !isNaN(bDate)) {
    return (aDate - bDate) * dir;
  }

  return aStr.localeCompare(bStr, undefined, { sensitivity: "base" }) * dir;
}

function EnhancedTableInner<T>(
  props: EnhancedTableProps<T>,
  _ref: React.Ref<unknown>,
) {
  const {
    items,
    columns,
    selectedIds,
    onSelectionChange,
    getRowId,
    searchPlaceholder = "Search...",
    filters,
    emptyMessage = "No items to display.",
    compact = false,
    pageSize = 0,
  } = props;

  const [sort, setSort] = React.useState<LegacySortState | null>(null);
  const [searchText, setSearchText] = React.useState("");
  const [currentPage, setCurrentPage] = React.useState(0);

  React.useEffect(() => {
    setCurrentPage(0);
  }, [searchText, items, filters]);

  const activeFilterMap = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (filters) {
      for (const f of filters) {
        if (f.selectedKeys && f.selectedKeys.length > 0) {
          map.set(f.columnKey, new Set(f.selectedKeys));
        }
      }
    }
    return map;
  }, [filters]);

  const filteredItems = React.useMemo(() => {
    let result = items;

    if (searchText.trim()) {
      const lower = searchText.toLowerCase();
      result = result.filter((item) =>
        columns.some((col) => {
          const val = legacyResolveValue(item, col);
          return String(val).toLowerCase().includes(lower);
        }),
      );
    }

    if (activeFilterMap.size > 0) {
      result = result.filter((item) => {
        for (const [colKey, allowedKeys] of activeFilterMap) {
          const col = columns.find((c) => c.key === colKey);
          if (!col) continue;
          const val = String(legacyResolveValue(item, col));
          if (!allowedKeys.has(val)) return false;
        }
        return true;
      });
    }

    return result;
  }, [items, searchText, columns, activeFilterMap]);

  const sortedItems = React.useMemo(() => {
    if (!sort) return filteredItems;
    const col = columns.find((c) => c.key === sort.columnKey);
    if (!col) return filteredItems;

    return [...filteredItems].sort((a, b) => {
      const aVal = legacyResolveValue(a, col);
      const bVal = legacyResolveValue(b, col);
      return legacyCompareValues(aVal, bVal, sort.descending);
    });
  }, [filteredItems, sort, columns]);

  const paginationEnabled = pageSize > 0 && sortedItems.length > pageSize;
  const totalPages = paginationEnabled
    ? Math.ceil(sortedItems.length / pageSize)
    : 1;

  const pagedItems = React.useMemo(() => {
    if (!paginationEnabled) return sortedItems;
    const start = currentPage * pageSize;
    return sortedItems.slice(start, start + pageSize);
  }, [sortedItems, paginationEnabled, currentPage, pageSize]);

  const visibleIds = React.useMemo(
    () => new Set(pagedItems.map((item) => getRowId(item))),
    [pagedItems, getRowId],
  );

  const allVisibleSelected = React.useMemo(() => {
    if (!selectedIds || visibleIds.size === 0) return false;
    for (const id of visibleIds) {
      if (!selectedIds.has(id)) return false;
    }
    return true;
  }, [selectedIds, visibleIds]);

  const someVisibleSelected = React.useMemo(() => {
    if (!selectedIds || visibleIds.size === 0) return false;
    for (const id of visibleIds) {
      if (selectedIds.has(id)) return true;
    }
    return false;
  }, [selectedIds, visibleIds]);

  const isIndeterminate = someVisibleSelected && !allVisibleSelected;

  const handleSelectAll = React.useCallback(() => {
    if (!onSelectionChange) return;
    if (allVisibleSelected) {
      const next = new Set(selectedIds);
      for (const id of visibleIds) {
        next.delete(id);
      }
      onSelectionChange(next);
    } else {
      const next = new Set(selectedIds);
      for (const id of visibleIds) {
        next.add(id);
      }
      onSelectionChange(next);
    }
  }, [onSelectionChange, allVisibleSelected, selectedIds, visibleIds]);

  const handleRowToggle = React.useCallback(
    (item: T) => {
      if (!onSelectionChange) return;
      const id = getRowId(item);
      const next = new Set(selectedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      onSelectionChange(next);
    },
    [onSelectionChange, getRowId, selectedIds],
  );

  const handleColumnSort = React.useCallback((col: EnhancedColumn<T>) => {
    if (col.sortable === false) return;
    setSort((prev) => {
      if (prev && prev.columnKey === col.key) {
        return { columnKey: col.key, descending: !prev.descending };
      }
      return { columnKey: col.key, descending: false };
    });
  }, []);

  // Horizontal padding only — vertical sizing comes from --row-height which is
  // toggled by the .density-compact / .density-comfortable classes the
  // SessionBar puts on <html>. The `compact` prop forces a compact row height
  // regardless of the global density.
  const cellPadding = compact ? "px-2 py-0" : "px-3 py-0";
  const headPadding = compact ? "px-2 py-0" : "px-3 py-0";
  const rowStyle: React.CSSProperties = compact
    ? { height: 28 }
    : { height: "var(--row-height, 36px)" };

  return (
    <div className="flex flex-col gap-3">
      {/* Search + per-column filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="relative max-w-md flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder={searchPlaceholder}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="pl-8"
            aria-label={searchPlaceholder}
          />
        </div>
        {filters?.map((f) => {
          const col = columns.find((c) => c.key === f.columnKey);
          const label = col ? col.name : f.columnKey;
          const selected = new Set(f.selectedKeys ?? []);
          return (
            <DropdownMenu key={f.columnKey}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                >
                  <FilterIcon />
                  {label}
                  {selected.size > 0 && (
                    <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs font-semibold text-primary-foreground">
                      {selected.size}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-72 overflow-y-auto"
              >
                <DropdownMenuLabel>Filter {label}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {f.options.map((o) => (
                  <DropdownMenuCheckboxItem
                    key={o.key}
                    checked={selected.has(o.key)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(checked) => {
                      const next = f.selectedKeys ? [...f.selectedKeys] : [];
                      if (checked) {
                        if (!next.includes(o.key)) next.push(o.key);
                      } else {
                        const idx = next.indexOf(o.key);
                        if (idx >= 0) next.splice(idx, 1);
                      }
                      f.onChange(next);
                    }}
                  >
                    {o.text}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}
      </div>

      {/* Selection summary */}
      {selectedIds && selectedIds.size > 0 && (
        <p className="text-xs text-muted-foreground">
          {selectedIds.size} item
          {selectedIds.size !== 1 ? "s" : ""} selected
        </p>
      )}

      {/* Table */}
      {pagedItems.length === 0 ? (
        <div
          role="status"
          className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-4 py-10 text-sm text-muted-foreground"
        >
          {emptyMessage}
        </div>
      ) : (
        <div className="rounded-md border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent" style={rowStyle}>
                {onSelectionChange && (
                  <TableHead className={cn("w-10", headPadding)}>
                    <Checkbox
                      checked={
                        isIndeterminate ? "indeterminate" : allVisibleSelected
                      }
                      onCheckedChange={handleSelectAll}
                      aria-label="Select all visible rows"
                    />
                  </TableHead>
                )}
                {columns.map((col) => {
                  const isSorted = sort?.columnKey === col.key;
                  const sortable = col.sortable !== false;
                  return (
                    <TableHead
                      key={col.key}
                      className={cn(headPadding)}
                      style={{
                        minWidth: col.minWidth,
                        maxWidth: col.maxWidth,
                      }}
                      aria-sort={
                        isSorted
                          ? sort!.descending
                            ? "descending"
                            : "ascending"
                          : sortable
                            ? "none"
                            : undefined
                      }
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => handleColumnSort(col)}
                          className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {col.name}
                          {isSorted ? (
                            sort!.descending ? (
                              <ArrowDown className="h-3 w-3" />
                            ) : (
                              <ArrowUp className="h-3 w-3" />
                            )
                          ) : null}
                        </button>
                      ) : (
                        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {col.name}
                        </span>
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedItems.map((item) => {
                const id = getRowId(item);
                const checked = selectedIds?.has(id) ?? false;
                return (
                  <TableRow
                    key={id}
                    data-state={checked ? "selected" : undefined}
                    style={rowStyle}
                  >
                    {onSelectionChange && (
                      <TableCell className={cn("w-10", cellPadding)}>
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => handleRowToggle(item)}
                          aria-label="Select row"
                        />
                      </TableCell>
                    )}
                    {columns.map((col) => (
                      <TableCell
                        key={col.key}
                        className={cellPadding}
                        style={{
                          minWidth: col.minWidth,
                          maxWidth: col.maxWidth,
                        }}
                      >
                        {col.onRender
                          ? col.onRender(item)
                          : String(legacyResolveValue(item, col))}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
      {paginationEnabled && (
        <div className="flex items-center justify-center gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Previous page"
            aria-label="Previous page"
            disabled={currentPage === 0}
            onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft />
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {currentPage + 1} of {totalPages} ({sortedItems.length} items)
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Next page"
            aria-label="Next page"
            disabled={currentPage >= totalPages - 1}
            onClick={() =>
              setCurrentPage((p) => Math.min(totalPages - 1, p + 1))
            }
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Generic, reusable table built on shadcn-ui primitives.
 *
 * @deprecated Prefer `DataTable` for new code. This component is kept
 * unchanged so existing pages (`tenant-users-page`, `user-creator-page`)
 * continue to work; migration to `DataTable` is tracked in Plan F/K.
 */
export const EnhancedTable = React.forwardRef(EnhancedTableInner) as <T>(
  props: EnhancedTableProps<T> & { ref?: React.Ref<unknown> },
) => React.ReactElement;
