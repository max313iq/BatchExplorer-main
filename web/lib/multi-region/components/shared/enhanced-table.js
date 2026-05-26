/**
 * Shared table primitives for tabular data: the canonical `<DataTable>`
 * (Contract §5) plus the legacy `<EnhancedTable>` surface kept for callers
 * that haven't migrated yet — both live here so consumers can import either
 * via the same module path.
 */
import * as React from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileJson, FileSpreadsheet, Filter as FilterIcon, Search, SlidersHorizontal, } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, } from "@/components/ui/table";
import { cn, downloadCsv, downloadJson } from "@/lib/utils";
// Threshold above which row virtualization kicks in (Contract §5/§7).
const VIRTUALIZATION_THRESHOLD = 500;
// Estimated row height fallback for virtualization (matches comfortable
// density in tailwind.css; the actual height is read from `--row-height`).
const VIRTUAL_ROW_ESTIMATE_PX = 36;
// Max scroll-area height in virtualized mode — keeps the table from
// dominating a page even with thousands of rows.
const VIRTUAL_VIEWPORT_HEIGHT_PX = 600;
export function DataTable(props) {
    const { tableId, rows, columns, rowKey, empty, loading = false, selection, onSelectionChange, onRowActivate, csvFileName, jsonFileName, className, initialSort, } = props;
    const [sort, setSort] = React.useState(initialSort !== null && initialSort !== void 0 ? initialSort : null);
    // Column visibility — keyed by column.id; defaults from `defaultHidden`.
    const [hiddenColumns, setHiddenColumns] = React.useState(() => {
        const set = new Set();
        for (const c of columns) {
            if (c.defaultHidden)
                set.add(c.id);
        }
        return set;
    });
    // Track which column ids we've already initialized from `defaultHidden`
    // so re-renders with the same column set don't fight the user's choices.
    const seenIdsRef = React.useRef(new Set(columns.map((c) => c.id)));
    // If `columns` prop changes (different keys arrive), prune stale ids and
    // auto-apply `defaultHidden` for any column ids we haven't seen before —
    // without clobbering the user's toggles for columns that still exist.
    React.useEffect(() => {
        const currentIds = new Set(columns.map((c) => c.id));
        setHiddenColumns((prev) => {
            const next = new Set();
            for (const id of prev) {
                if (currentIds.has(id))
                    next.add(id);
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
    const visibleColumns = React.useMemo(() => columns.filter((c) => !hiddenColumns.has(c.id)), [columns, hiddenColumns]);
    // Sorted view. If no sort or column lacks a comparator, return rows as-is.
    const sortedRows = React.useMemo(() => {
        // Defensive: callers occasionally pass `rows={undefined}` while
        // their data is still loading (e.g. tenant switch in flight) and
        // a synchronous re-render fires before the cancelled-flag drops
        // the stale set. Coerce to [] so the table renders empty instead
        // of crashing the whole page with "Cannot read properties of
        // undefined (reading 'slice')".
        const safeRows = rows !== null && rows !== void 0 ? rows : [];
        if (!sort)
            return safeRows;
        const col = columns.find((c) => c.id === sort.column);
        if (!col || !col.sort)
            return safeRows;
        const cmp = col.sort;
        const dir = sort.direction === "desc" ? -1 : 1;
        const copy = safeRows.slice();
        copy.sort((a, b) => cmp(a, b) * dir);
        return copy;
    }, [rows, sort, columns]);
    const handleHeaderSort = React.useCallback((col) => {
        if (!col.sort)
            return;
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
    }, []);
    const toggleColumnHidden = React.useCallback((id) => {
        setHiddenColumns((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            }
            else {
                next.add(id);
            }
            return next;
        });
    }, []);
    // Selection helpers — only used when `selection` is provided.
    const visibleIds = React.useMemo(() => sortedRows.map((r) => rowKey(r)), [sortedRows, rowKey]);
    const allVisibleSelected = React.useMemo(() => {
        if (!selection || visibleIds.length === 0)
            return false;
        for (const id of visibleIds) {
            if (!selection.has(id))
                return false;
        }
        return true;
    }, [selection, visibleIds]);
    const someVisibleSelected = React.useMemo(() => {
        if (!selection || visibleIds.length === 0)
            return false;
        for (const id of visibleIds) {
            if (selection.has(id))
                return true;
        }
        return false;
    }, [selection, visibleIds]);
    const isIndeterminate = someVisibleSelected && !allVisibleSelected;
    const handleSelectAll = React.useCallback(() => {
        if (!onSelectionChange)
            return;
        const next = new Set(selection);
        if (allVisibleSelected) {
            for (const id of visibleIds)
                next.delete(id);
        }
        else {
            for (const id of visibleIds)
                next.add(id);
        }
        onSelectionChange(next);
    }, [onSelectionChange, selection, allVisibleSelected, visibleIds]);
    const handleRowToggle = React.useCallback((id) => {
        if (!onSelectionChange)
            return;
        const next = new Set(selection);
        if (next.has(id)) {
            next.delete(id);
        }
        else {
            next.add(id);
        }
        onSelectionChange(next);
    }, [onSelectionChange, selection]);
    // CSV export — uses VISIBLE rows in current sort order, only columns with a
    // `csv` accessor.
    const handleExportCsv = React.useCallback(() => {
        const csvCols = visibleColumns.filter((c) => typeof c.csv === "function");
        if (csvCols.length === 0)
            return;
        const headers = csvCols.map((c) => typeof c.header === "string" ? c.header : c.id);
        const dataRows = sortedRows.map((r) => csvCols.map((c) => {
            const v = c.csv ? c.csv(r) : "";
            return v == null ? "" : v;
        }));
        const filename = csvFileName !== null && csvFileName !== void 0 ? csvFileName : `export-${tableId}.csv`;
        downloadCsv(filename, [headers, ...dataRows]);
    }, [visibleColumns, sortedRows, csvFileName, tableId]);
    // JSON export — derives a `{ [key]: value }` object per row from each
    // exportable column. Columns opt in via `column.json` (preferred) or
    // fall back to the `csv` accessor with a derived key. `column.json: false`
    // explicitly excludes the column.
    const handleExportJson = React.useCallback(() => {
        const exportCols = visibleColumns.filter((c) => {
            if (c.json === false)
                return false;
            return typeof c.json === "object" || typeof c.csv === "function";
        });
        if (exportCols.length === 0)
            return;
        // Derive a JSON-safe key for a column when `json` isn't an explicit object.
        const deriveKey = (c) => {
            if (typeof c.json === "object")
                return c.json.key;
            const label = typeof c.header === "string" ? c.header : c.id;
            return label
                .replace(/[^a-zA-Z0-9 ]+/g, "")
                .trim()
                .split(/\s+/)
                .map((w, i) => i === 0
                ? w.charAt(0).toLowerCase() + w.slice(1)
                : w.charAt(0).toUpperCase() + w.slice(1))
                .join("") || c.id;
        };
        const jsonRows = sortedRows.map((r) => {
            const out = {};
            for (const c of exportCols) {
                const key = deriveKey(c);
                if (typeof c.json === "object") {
                    out[key] = c.json.value(r);
                }
                else if (typeof c.csv === "function") {
                    const v = c.csv(r);
                    out[key] = v == null ? null : v;
                }
            }
            return out;
        });
        const filename = jsonFileName !== null && jsonFileName !== void 0 ? jsonFileName : `export-${tableId}.json`;
        downloadJson(filename, jsonRows);
    }, [visibleColumns, sortedRows, jsonFileName, tableId]);
    // Virtualization — only when row count exceeds the threshold.
    const shouldVirtualize = sortedRows.length > VIRTUALIZATION_THRESHOLD;
    const scrollRef = React.useRef(null);
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? sortedRows.length : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => VIRTUAL_ROW_ESTIMATE_PX,
        overscan: 8,
    });
    const csvAvailable = visibleColumns.some((c) => typeof c.csv === "function");
    const jsonAvailable = visibleColumns.some((c) => c.json !== false && (typeof c.json === "object" || typeof c.csv === "function"));
    // ---- Render branches: loading / empty / table ---------------------------
    const showEmpty = !loading && sortedRows.length === 0;
    return (React.createElement("div", { className: cn("flex flex-col gap-2", className) },
        React.createElement("div", { className: "flex items-center justify-end gap-2", role: "toolbar", "aria-label": "Table actions" },
            React.createElement(DropdownMenu, null,
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "gap-2", "aria-label": "Toggle column visibility" },
                        React.createElement(SlidersHorizontal, null),
                        "Columns")),
                React.createElement(DropdownMenuContent, { align: "end", className: "max-h-72 overflow-y-auto" },
                    React.createElement(DropdownMenuLabel, null, "Visible columns"),
                    React.createElement(DropdownMenuSeparator, null),
                    columns.map((c) => {
                        const hidden = hiddenColumns.has(c.id);
                        const label = typeof c.header === "string" ? c.header : c.id;
                        return (React.createElement(DropdownMenuCheckboxItem, { key: c.id, checked: !hidden, onSelect: (e) => e.preventDefault(), onCheckedChange: () => toggleColumnHidden(c.id) }, label));
                    }))),
            csvAvailable && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "gap-2", onClick: handleExportCsv, "aria-label": "Export visible rows to CSV" },
                React.createElement(FileSpreadsheet, null),
                "CSV")),
            jsonAvailable && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "gap-2", onClick: handleExportJson, "aria-label": "Export visible rows to JSON" },
                React.createElement(FileJson, null),
                "JSON"))),
        loading ? (React.createElement("div", { className: "rounded-md border border-border bg-card" },
            React.createElement(Table, null,
                React.createElement(TableHeader, null,
                    React.createElement(TableRow, { className: "hover:bg-transparent" },
                        selection !== undefined && (React.createElement(TableHead, { className: "w-10 table-cell-header" })),
                        visibleColumns.map((c) => (React.createElement(TableHead, { key: c.id, className: cn("table-cell-header", c.width, c.className) }, c.header))))),
                React.createElement(TableBody, null, Array.from({ length: 6 }).map((_, i) => (React.createElement(TableRow, { key: i, className: "hover:bg-transparent" },
                    selection !== undefined && (React.createElement(TableCell, { className: "w-10 table-cell-row" },
                        React.createElement(Skeleton, { className: "h-4 w-4" }))),
                    visibleColumns.map((c) => (React.createElement(TableCell, { key: c.id, className: cn("table-cell-row", c.width, c.className) },
                        React.createElement(Skeleton, { className: "h-4 w-3/4" }))))))))))) : showEmpty ? (React.createElement("div", { className: "rounded-md border border-dashed border-border bg-card" }, empty !== null && empty !== void 0 ? empty : (React.createElement("p", { className: "m-0 p-6 text-center text-sm text-muted-foreground" }, "No data.")))) : (React.createElement("div", { ref: scrollRef, className: "relative overflow-auto rounded-md border border-border bg-card", style: shouldVirtualize
                ? { maxHeight: VIRTUAL_VIEWPORT_HEIGHT_PX }
                : undefined },
            React.createElement(Table, null,
                React.createElement(TableHeader, { className: "sticky top-0 z-10 bg-card" },
                    React.createElement(TableRow, { className: "hover:bg-transparent" },
                        selection !== undefined && (React.createElement(TableHead, { className: "w-10 table-cell-header" },
                            React.createElement(Checkbox, { checked: isIndeterminate ? "indeterminate" : allVisibleSelected, onCheckedChange: handleSelectAll, "aria-label": "Select all visible rows" }))),
                        visibleColumns.map((c) => {
                            const sortable = typeof c.sort === "function";
                            const isSorted = (sort === null || sort === void 0 ? void 0 : sort.column) === c.id;
                            const ariaSort = sortable
                                ? isSorted
                                    ? (sort === null || sort === void 0 ? void 0 : sort.direction) === "desc"
                                        ? "descending"
                                        : "ascending"
                                    : "none"
                                : undefined;
                            return (React.createElement(TableHead, { key: c.id, className: cn("table-cell-header", c.width, c.className), "aria-sort": ariaSort }, sortable ? (React.createElement("button", { type: "button", onClick: () => handleHeaderSort(c), className: "-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background motion-reduce:transition-none", "aria-label": typeof c.header === "string"
                                    ? `Sort by ${c.header}`
                                    : `Sort by ${c.id}` },
                                React.createElement("span", null, c.header),
                                isSorted ? ((sort === null || sort === void 0 ? void 0 : sort.direction) === "desc" ? (React.createElement(ChevronDown, { className: "h-3 w-3", "aria-hidden": true })) : (React.createElement(ChevronUp, { className: "h-3 w-3", "aria-hidden": true }))) : null)) : (React.createElement("span", null, c.header))));
                        }))),
                shouldVirtualize ? (React.createElement(VirtualizedTableBody, { rows: sortedRows, rowKey: rowKey, visibleColumns: visibleColumns, selection: selection, onRowToggle: handleRowToggle, onRowActivate: onRowActivate, virtualizer: rowVirtualizer })) : (React.createElement(TableBody, null, sortedRows.map((row) => (React.createElement(DataTableRow, { key: rowKey(row), row: row, rowId: rowKey(row), visibleColumns: visibleColumns, selection: selection, onRowToggle: handleRowToggle, onRowActivate: onRowActivate }))))))))));
}
function DataTableRow(props) {
    var _a;
    const { row, rowId, visibleColumns, selection, onRowToggle, onRowActivate } = props;
    const checked = (_a = selection === null || selection === void 0 ? void 0 : selection.has(rowId)) !== null && _a !== void 0 ? _a : false;
    const interactive = typeof onRowActivate === "function";
    const handleKeyDown = React.useCallback((e) => {
        if (!interactive)
            return;
        if (e.key === "Enter") {
            e.preventDefault();
            onRowActivate === null || onRowActivate === void 0 ? void 0 : onRowActivate(row);
        }
    }, [interactive, onRowActivate, row]);
    const handleClick = React.useCallback(() => {
        if (interactive)
            onRowActivate === null || onRowActivate === void 0 ? void 0 : onRowActivate(row);
    }, [interactive, onRowActivate, row]);
    return (React.createElement(TableRow, { "data-state": checked ? "selected" : undefined, role: interactive ? "button" : undefined, tabIndex: interactive ? 0 : undefined, onClick: interactive ? handleClick : undefined, onKeyDown: interactive ? handleKeyDown : undefined, className: cn(interactive &&
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background") },
        selection !== undefined && (React.createElement(TableCell, { className: "w-10 table-cell-row", onClick: (e) => e.stopPropagation() },
            React.createElement(Checkbox, { checked: checked, onCheckedChange: () => onRowToggle(rowId), "aria-label": "Select row" }))),
        visibleColumns.map((c) => (React.createElement(TableCell, { key: c.id, className: cn("table-cell-row", c.width, c.className) }, c.cell(row))))));
}
function VirtualizedTableBody(props) {
    const { rows, rowKey, visibleColumns, selection, onRowToggle, onRowActivate, virtualizer, } = props;
    const items = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const paddingTop = items.length > 0 ? items[0].start : 0;
    const paddingBottom = items.length > 0 ? totalSize - items[items.length - 1].end : 0;
    const colSpan = visibleColumns.length + (selection !== undefined ? 1 : 0);
    return (React.createElement(TableBody, null,
        paddingTop > 0 && (React.createElement("tr", { style: { height: paddingTop }, "aria-hidden": true },
            React.createElement("td", { colSpan: colSpan }))),
        items.map((virtualItem) => {
            const row = rows[virtualItem.index];
            return (React.createElement(DataTableRow, { key: rowKey(row), row: row, rowId: rowKey(row), visibleColumns: visibleColumns, selection: selection, onRowToggle: onRowToggle, onRowActivate: onRowActivate }));
        }),
        paddingBottom > 0 && (React.createElement("tr", { style: { height: paddingBottom }, "aria-hidden": true },
            React.createElement("td", { colSpan: colSpan })))));
}
function legacyResolveValue(item, col) {
    if (col.getValue) {
        return col.getValue(item);
    }
    const raw = item[col.key];
    if (raw === null || raw === undefined)
        return "";
    if (typeof raw === "number")
        return raw;
    return String(raw);
}
function legacyCompareValues(a, b, descending) {
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
function EnhancedTableInner(props, _ref) {
    const { items, columns, selectedIds, onSelectionChange, getRowId, searchPlaceholder = "Search...", filters, emptyMessage = "No items to display.", compact = false, pageSize = 0, } = props;
    const [sort, setSort] = React.useState(null);
    const [searchText, setSearchText] = React.useState("");
    const [currentPage, setCurrentPage] = React.useState(0);
    React.useEffect(() => {
        setCurrentPage(0);
    }, [searchText, items, filters]);
    const activeFilterMap = React.useMemo(() => {
        const map = new Map();
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
            result = result.filter((item) => columns.some((col) => {
                const val = legacyResolveValue(item, col);
                return String(val).toLowerCase().includes(lower);
            }));
        }
        if (activeFilterMap.size > 0) {
            result = result.filter((item) => {
                for (const [colKey, allowedKeys] of activeFilterMap) {
                    const col = columns.find((c) => c.key === colKey);
                    if (!col)
                        continue;
                    const val = String(legacyResolveValue(item, col));
                    if (!allowedKeys.has(val))
                        return false;
                }
                return true;
            });
        }
        return result;
    }, [items, searchText, columns, activeFilterMap]);
    const sortedItems = React.useMemo(() => {
        if (!sort)
            return filteredItems;
        const col = columns.find((c) => c.key === sort.columnKey);
        if (!col)
            return filteredItems;
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
        if (!paginationEnabled)
            return sortedItems;
        const start = currentPage * pageSize;
        return sortedItems.slice(start, start + pageSize);
    }, [sortedItems, paginationEnabled, currentPage, pageSize]);
    const visibleIds = React.useMemo(() => new Set(pagedItems.map((item) => getRowId(item))), [pagedItems, getRowId]);
    const allVisibleSelected = React.useMemo(() => {
        if (!selectedIds || visibleIds.size === 0)
            return false;
        for (const id of visibleIds) {
            if (!selectedIds.has(id))
                return false;
        }
        return true;
    }, [selectedIds, visibleIds]);
    const someVisibleSelected = React.useMemo(() => {
        if (!selectedIds || visibleIds.size === 0)
            return false;
        for (const id of visibleIds) {
            if (selectedIds.has(id))
                return true;
        }
        return false;
    }, [selectedIds, visibleIds]);
    const isIndeterminate = someVisibleSelected && !allVisibleSelected;
    const handleSelectAll = React.useCallback(() => {
        if (!onSelectionChange)
            return;
        if (allVisibleSelected) {
            const next = new Set(selectedIds);
            for (const id of visibleIds) {
                next.delete(id);
            }
            onSelectionChange(next);
        }
        else {
            const next = new Set(selectedIds);
            for (const id of visibleIds) {
                next.add(id);
            }
            onSelectionChange(next);
        }
    }, [onSelectionChange, allVisibleSelected, selectedIds, visibleIds]);
    const handleRowToggle = React.useCallback((item) => {
        if (!onSelectionChange)
            return;
        const id = getRowId(item);
        const next = new Set(selectedIds);
        if (next.has(id)) {
            next.delete(id);
        }
        else {
            next.add(id);
        }
        onSelectionChange(next);
    }, [onSelectionChange, getRowId, selectedIds]);
    const handleColumnSort = React.useCallback((col) => {
        if (col.sortable === false)
            return;
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
    const rowStyle = compact
        ? { height: 28 }
        : { height: "var(--row-height, 36px)" };
    return (React.createElement("div", { className: "flex flex-col gap-3" },
        React.createElement("div", { className: "flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end" },
            React.createElement("div", { className: "relative max-w-md flex-1" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { type: "search", placeholder: searchPlaceholder, value: searchText, onChange: (e) => setSearchText(e.target.value), className: "pl-8", "aria-label": searchPlaceholder })), filters === null || filters === void 0 ? void 0 :
            filters.map((f) => {
                var _a;
                const col = columns.find((c) => c.key === f.columnKey);
                const label = col ? col.name : f.columnKey;
                const selected = new Set((_a = f.selectedKeys) !== null && _a !== void 0 ? _a : []);
                return (React.createElement(DropdownMenu, { key: f.columnKey },
                    React.createElement(DropdownMenuTrigger, { asChild: true },
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "gap-2" },
                            React.createElement(FilterIcon, null),
                            label,
                            selected.size > 0 && (React.createElement("span", { className: "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs font-semibold text-primary-foreground" }, selected.size)))),
                    React.createElement(DropdownMenuContent, { align: "start", className: "max-h-72 overflow-y-auto" },
                        React.createElement(DropdownMenuLabel, null,
                            "Filter ",
                            label),
                        React.createElement(DropdownMenuSeparator, null),
                        f.options.map((o) => (React.createElement(DropdownMenuCheckboxItem, { key: o.key, checked: selected.has(o.key), onSelect: (e) => e.preventDefault(), onCheckedChange: (checked) => {
                                const next = f.selectedKeys ? [...f.selectedKeys] : [];
                                if (checked) {
                                    if (!next.includes(o.key))
                                        next.push(o.key);
                                }
                                else {
                                    const idx = next.indexOf(o.key);
                                    if (idx >= 0)
                                        next.splice(idx, 1);
                                }
                                f.onChange(next);
                            } }, o.text))))));
            })),
        selectedIds && selectedIds.size > 0 && (React.createElement("p", { className: "text-xs text-muted-foreground" },
            selectedIds.size,
            " item",
            selectedIds.size !== 1 ? "s" : "",
            " selected")),
        pagedItems.length === 0 ? (React.createElement("div", { role: "status", className: "flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-4 py-10 text-sm text-muted-foreground" }, emptyMessage)) : (React.createElement("div", { className: "rounded-md border border-border bg-card" },
            React.createElement(Table, null,
                React.createElement(TableHeader, null,
                    React.createElement(TableRow, { className: "hover:bg-transparent", style: rowStyle },
                        onSelectionChange && (React.createElement(TableHead, { className: cn("w-10", headPadding) },
                            React.createElement(Checkbox, { checked: isIndeterminate ? "indeterminate" : allVisibleSelected, onCheckedChange: handleSelectAll, "aria-label": "Select all visible rows" }))),
                        columns.map((col) => {
                            const isSorted = (sort === null || sort === void 0 ? void 0 : sort.columnKey) === col.key;
                            const sortable = col.sortable !== false;
                            return (React.createElement(TableHead, { key: col.key, className: cn(headPadding), style: {
                                    minWidth: col.minWidth,
                                    maxWidth: col.maxWidth,
                                }, "aria-sort": isSorted
                                    ? sort.descending
                                        ? "descending"
                                        : "ascending"
                                    : sortable
                                        ? "none"
                                        : undefined }, sortable ? (React.createElement("button", { type: "button", onClick: () => handleColumnSort(col), className: "-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" },
                                col.name,
                                isSorted ? (sort.descending ? (React.createElement(ArrowDown, { className: "h-3 w-3" })) : (React.createElement(ArrowUp, { className: "h-3 w-3" }))) : null)) : (React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, col.name))));
                        }))),
                React.createElement(TableBody, null, pagedItems.map((item) => {
                    var _a;
                    const id = getRowId(item);
                    const checked = (_a = selectedIds === null || selectedIds === void 0 ? void 0 : selectedIds.has(id)) !== null && _a !== void 0 ? _a : false;
                    return (React.createElement(TableRow, { key: id, "data-state": checked ? "selected" : undefined, style: rowStyle },
                        onSelectionChange && (React.createElement(TableCell, { className: cn("w-10", cellPadding) },
                            React.createElement(Checkbox, { checked: checked, onCheckedChange: () => handleRowToggle(item), "aria-label": "Select row" }))),
                        columns.map((col) => (React.createElement(TableCell, { key: col.key, className: cellPadding, style: {
                                minWidth: col.minWidth,
                                maxWidth: col.maxWidth,
                            } }, col.onRender
                            ? col.onRender(item)
                            : String(legacyResolveValue(item, col)))))));
                }))))),
        paginationEnabled && (React.createElement("div", { className: "flex items-center justify-center gap-2 pt-1" },
            React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", title: "Previous page", "aria-label": "Previous page", disabled: currentPage === 0, onClick: () => setCurrentPage((p) => Math.max(0, p - 1)) },
                React.createElement(ChevronLeft, null)),
            React.createElement("span", { className: "text-xs text-muted-foreground" },
                "Page ",
                currentPage + 1,
                " of ",
                totalPages,
                " (",
                sortedItems.length,
                " items)"),
            React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", title: "Next page", "aria-label": "Next page", disabled: currentPage >= totalPages - 1, onClick: () => setCurrentPage((p) => Math.min(totalPages - 1, p + 1)) },
                React.createElement(ChevronRight, null))))));
}
/**
 * Generic, reusable table built on shadcn-ui primitives.
 *
 * @deprecated Prefer `DataTable` for new code. This component is kept
 * unchanged so existing pages (`tenant-users-page`, `user-creator-page`)
 * continue to work; migration to `DataTable` is tracked in Plan F/K.
 */
export const EnhancedTable = React.forwardRef(EnhancedTableInner);
//# sourceMappingURL=enhanced-table.js.map