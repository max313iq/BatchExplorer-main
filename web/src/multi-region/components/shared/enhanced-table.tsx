import * as React from "react";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
    CheckboxVisibility,
    ConstrainMode,
} from "@fluentui/react/lib/DetailsList";
import { TextField } from "@fluentui/react/lib/TextField";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import { IconButton } from "@fluentui/react/lib/Button";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
    /** Currently selected row ids (controlled). */
    selectedIds?: Set<string>;
    /** Called when the selection changes. */
    onSelectionChange?: (ids: Set<string>) => void;
    /** Return a stable unique id for each row. */
    getRowId: (item: T) => string;
    searchPlaceholder?: string;
    /** Per-column filter configurations. */
    filters?: FilterConfig[];
    emptyMessage?: string;
    compact?: boolean;
    /**
     * Number of rows per page. Pass `0` or omit to disable pagination.
     * Pagination is only rendered when there are more rows than `pageSize`.
     */
    pageSize?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SortState {
    columnKey: string;
    descending: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveValue<T>(item: T, col: EnhancedColumn<T>): string | number {
    if (col.getValue) {
        return col.getValue(item);
    }
    const raw = (item as Record<string, unknown>)[col.key];
    if (raw === null || raw === undefined) return "";
    if (typeof raw === "number") return raw;
    return String(raw);
}

function compareValues(
    a: string | number,
    b: string | number,
    descending: boolean
): number {
    const dir = descending ? -1 : 1;

    // Both numbers
    if (typeof a === "number" && typeof b === "number") {
        return (a - b) * dir;
    }

    const aStr = String(a);
    const bStr = String(b);

    // Try date comparison when both strings look like ISO dates
    const aDate = Date.parse(aStr);
    const bDate = Date.parse(bStr);
    if (!isNaN(aDate) && !isNaN(bDate)) {
        return (aDate - bDate) * dir;
    }

    return aStr.localeCompare(bStr, undefined, { sensitivity: "base" }) * dir;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function EnhancedTableInner<T>(
    props: EnhancedTableProps<T>,
    _ref: React.Ref<unknown>
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

    // ----- internal state --------------------------------------------------
    const [sort, setSort] = React.useState<SortState | null>(null);
    const [searchText, setSearchText] = React.useState("");
    const [currentPage, setCurrentPage] = React.useState(0);

    // Reset to first page whenever search, filters, or items change
    React.useEffect(() => {
        setCurrentPage(0);
    }, [searchText, items, filters]);

    // ----- filtering -------------------------------------------------------
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

        // Global search
        if (searchText.trim()) {
            const lower = searchText.toLowerCase();
            result = result.filter((item) =>
                columns.some((col) => {
                    const val = resolveValue(item, col);
                    return String(val).toLowerCase().includes(lower);
                })
            );
        }

        // Per-column filters
        if (activeFilterMap.size > 0) {
            result = result.filter((item) => {
                for (const [colKey, allowedKeys] of activeFilterMap) {
                    const col = columns.find((c) => c.key === colKey);
                    if (!col) continue;
                    const val = String(resolveValue(item, col));
                    if (!allowedKeys.has(val)) return false;
                }
                return true;
            });
        }

        return result;
    }, [items, searchText, columns, activeFilterMap]);

    // ----- sorting ---------------------------------------------------------
    const sortedItems = React.useMemo(() => {
        if (!sort) return filteredItems;
        const col = columns.find((c) => c.key === sort.columnKey);
        if (!col) return filteredItems;

        return [...filteredItems].sort((a, b) => {
            const aVal = resolveValue(a, col);
            const bVal = resolveValue(b, col);
            return compareValues(aVal, bVal, sort.descending);
        });
    }, [filteredItems, sort, columns]);

    // ----- pagination ------------------------------------------------------
    const paginationEnabled = pageSize > 0 && sortedItems.length > pageSize;
    const totalPages = paginationEnabled
        ? Math.ceil(sortedItems.length / pageSize)
        : 1;

    const pagedItems = React.useMemo(() => {
        if (!paginationEnabled) return sortedItems;
        const start = currentPage * pageSize;
        return sortedItems.slice(start, start + pageSize);
    }, [sortedItems, paginationEnabled, currentPage, pageSize]);

    // ----- select-all logic ------------------------------------------------
    const visibleIds = React.useMemo(
        () => new Set(pagedItems.map((item) => getRowId(item))),
        [pagedItems, getRowId]
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
            // Deselect all visible
            const next = new Set(selectedIds);
            for (const id of visibleIds) {
                next.delete(id);
            }
            onSelectionChange(next);
        } else {
            // Select all visible
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
        [onSelectionChange, getRowId, selectedIds]
    );

    // ----- column click (sort) ---------------------------------------------
    const handleColumnClick = React.useCallback(
        (_ev?: React.MouseEvent<HTMLElement>, column?: IColumn) => {
            if (!column) return;
            const col = columns.find((c) => c.key === column.key);
            if (!col || col.sortable === false) return;
            setSort((prev) => {
                if (prev && prev.columnKey === column.key) {
                    return {
                        columnKey: column.key,
                        descending: !prev.descending,
                    };
                }
                return { columnKey: column.key, descending: false };
            });
        },
        [columns]
    );

    // ----- build IColumn[] for DetailsList ---------------------------------
    const detailsColumns: IColumn[] = React.useMemo(() => {
        const selectionColumn: IColumn | null = onSelectionChange
            ? {
                  key: "__selection",
                  name: "",
                  minWidth: 32,
                  maxWidth: 32,
                  isResizable: false,
                  onRenderHeader: () => (
                      <Checkbox
                          checked={allVisibleSelected}
                          indeterminate={isIndeterminate}
                          onChange={handleSelectAll}
                          styles={{
                              root: { marginTop: 2 },
                          }}
                      />
                  ),
                  onRender: (item: T) => {
                      const id = getRowId(item);
                      const checked = selectedIds ? selectedIds.has(id) : false;
                      return (
                          <Checkbox
                              checked={checked}
                              onChange={() => handleRowToggle(item)}
                          />
                      );
                  },
              }
            : null;

        const dataCols: IColumn[] = columns.map((col) => {
            const isSorted = sort?.columnKey === col.key;
            return {
                key: col.key,
                name: col.name,
                fieldName: col.key,
                minWidth: col.minWidth,
                maxWidth: col.maxWidth,
                isResizable: true,
                isSorted,
                isSortedDescending: isSorted ? sort!.descending : false,
                onColumnClick:
                    col.sortable !== false ? handleColumnClick : undefined,
                onRender: col.onRender
                    ? (item: T) => col.onRender!(item)
                    : undefined,
            };
        });

        return selectionColumn ? [selectionColumn, ...dataCols] : dataCols;
    }, [
        columns,
        sort,
        handleColumnClick,
        onSelectionChange,
        allVisibleSelected,
        isIndeterminate,
        handleSelectAll,
        getRowId,
        selectedIds,
        handleRowToggle,
    ]);

    // ----- filter bar for per-column filters -------------------------------
    const filterBar = React.useMemo(() => {
        if (!filters || filters.length === 0) return null;
        return (
            <Stack horizontal tokens={{ childrenGap: 12 }} wrap>
                {filters.map((f) => {
                    const col = columns.find((c) => c.key === f.columnKey);
                    const label = col ? col.name : f.columnKey;
                    const dropdownOptions: IDropdownOption[] = f.options.map(
                        (o) => ({
                            key: o.key,
                            text: o.text,
                        })
                    );
                    return (
                        <Dropdown
                            key={f.columnKey}
                            placeholder={`Filter ${label}`}
                            label={label}
                            multiSelect
                            options={dropdownOptions}
                            selectedKeys={f.selectedKeys ?? []}
                            onChange={(_ev, option) => {
                                if (!option) return;
                                const current = f.selectedKeys
                                    ? [...f.selectedKeys]
                                    : [];
                                if (option.selected) {
                                    current.push(String(option.key));
                                } else {
                                    const idx = current.indexOf(
                                        String(option.key)
                                    );
                                    if (idx >= 0) current.splice(idx, 1);
                                }
                                f.onChange(current);
                            }}
                            styles={{
                                dropdown: { minWidth: 150 },
                            }}
                        />
                    );
                })}
            </Stack>
        );
    }, [filters, columns]);

    // ----- pagination controls ---------------------------------------------
    const paginationControls = React.useMemo(() => {
        if (!paginationEnabled) return null;
        return (
            <Stack
                horizontal
                verticalAlign="center"
                horizontalAlign="center"
                tokens={{ childrenGap: 8 }}
                styles={{ root: { paddingTop: 8 } }}
            >
                <IconButton
                    iconProps={{ iconName: "ChevronLeft" }}
                    disabled={currentPage === 0}
                    onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                    title="Previous page"
                />
                <Text variant="small">
                    Page {currentPage + 1} of {totalPages} ({sortedItems.length}{" "}
                    items)
                </Text>
                <IconButton
                    iconProps={{ iconName: "ChevronRight" }}
                    disabled={currentPage >= totalPages - 1}
                    onClick={() =>
                        setCurrentPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                    title="Next page"
                />
            </Stack>
        );
    }, [paginationEnabled, currentPage, totalPages, sortedItems.length]);

    // ----- render ----------------------------------------------------------
    return (
        <Stack tokens={{ childrenGap: 8 }}>
            {/* Search bar */}
            <TextField
                placeholder={searchPlaceholder}
                iconProps={{ iconName: "Search" }}
                value={searchText}
                onChange={(_ev, val) => setSearchText(val ?? "")}
                styles={{ root: { maxWidth: 400 } }}
            />

            {/* Per-column filter dropdowns */}
            {filterBar}

            {/* Selection summary */}
            {selectedIds && selectedIds.size > 0 && (
                <Text variant="small">
                    {selectedIds.size} item{selectedIds.size !== 1 ? "s" : ""}{" "}
                    selected
                </Text>
            )}

            {/* Table */}
            {pagedItems.length === 0 ? (
                <Stack
                    horizontalAlign="center"
                    styles={{ root: { padding: 32 } }}
                >
                    <Text variant="medium">{emptyMessage}</Text>
                </Stack>
            ) : (
                <DetailsList
                    items={pagedItems}
                    columns={detailsColumns}
                    layoutMode={DetailsListLayoutMode.justified}
                    constrainMode={ConstrainMode.horizontalConstrained}
                    selectionMode={SelectionMode.none}
                    checkboxVisibility={CheckboxVisibility.hidden}
                    compact={compact}
                    onColumnHeaderClick={handleColumnClick}
                    getKey={(item: T) => getRowId(item)}
                />
            )}

            {/* Pagination */}
            {paginationControls}
        </Stack>
    );
}

/**
 * A generic, reusable table component built on Fluent UI `DetailsList`.
 *
 * Features:
 * - Select-all checkbox with indeterminate state
 * - Click-to-sort column headers (string, number, date)
 * - Global search across all columns
 * - Optional per-column filter dropdowns
 * - Optional pagination
 *
 * Selection is controlled via `selectedIds` / `onSelectionChange` props.
 * Sort and search state are managed internally.
 */
export const EnhancedTable = React.forwardRef(EnhancedTableInner) as <T>(
    props: EnhancedTableProps<T> & { ref?: React.Ref<unknown> }
) => React.ReactElement;
