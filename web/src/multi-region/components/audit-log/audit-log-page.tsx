/**
 * Audit log page — searchable, filterable, paginated, exportable view over
 * the session audit history.
 *
 * Reads from the `auditLog` singleton (live-subscribed) and renders a static
 * shadcn Table; does NOT depend on the in-progress DataTable upgrade.
 *
 * Features:
 *   - Full-text search across all visible fields (kbd shortcut: `/`).
 *   - Status quick-filter chips (All / Success / Failure).
 *   - Multi-select actor + action dropdown filters.
 *   - Date-range picker spanning the retained log window.
 *   - Sortable columns (Timestamp / Actor / Action / Target / Status).
 *   - Pagination with adjustable page size.
 *   - Expandable rows showing the full `details` JSON + `error` field.
 *   - Inline copy buttons on Actor / Action / Target / details JSON.
 *   - Summary stat row: Total / Success / Failed / Last 24h.
 *   - 24-hour activity timeline + top actors + top actions histograms.
 *   - CSV + JSON export of the currently-filtered view.
 *   - Clear-log action with confirmation.
 *
 * Bug fixes vs. previous revision:
 *   - Subscribe-then-snapshot race: the original code read entries in the
 *     `useState` lazy initializer and re-subscribed in `useEffect`. Any
 *     entries appended between those two points were missed. We now refresh
 *     once inside the effect *and* in the subscribe callback.
 *   - 24h timeline off-by-one: buckets were aligned to a sliding wall clock,
 *     causing entries that crossed an hour boundary mid-render to flicker
 *     between buckets. We now align buckets to the floor of `Date.now()`
 *     truncated to the hour, and use a half-open `[hourStart, hourStart+1h)`
 *     interval per bucket so each entry lands in exactly one bin.
 */
import * as React from "react";
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Clock,
  FileText,
  Filter,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import type { DateRange } from "react-day-picker";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Pagination,
  PaginationContent,
  PaginationFirst,
  PaginationItem,
  PaginationLast,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MiniBar, type MiniBarItem } from "@/components/ui/charts/gauge";
import {
  cn,
  formatDateTime,
  formatRelativeTime,
} from "@/lib/utils";

import { auditLog, type AuditEntry } from "../../services/audit-log";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusFilter = "all" | "success" | "failure";

type SortKey = "timestamp" | "actor" | "action" | "target" | "status";
type SortDir = "asc" | "desc";

interface SortState {
  key: SortKey;
  dir: SortDir;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AuditLogPage: React.FC = () => {
  // -------- State -----------------------------------------------------------
  const [entries, setEntries] = React.useState<AuditEntry[]>(() =>
    auditLog.getEntries(),
  );

  // Search + filters
  const [searchText, setSearchText] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [actorFilter, setActorFilter] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [actionFilter, setActionFilter] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [dateRange, setDateRange] = React.useState<DateRange | undefined>();

  // Sorting + pagination
  const [sort, setSort] = React.useState<SortState>({
    key: "timestamp",
    dir: "desc",
  });
  const [pageSize, setPageSize] = React.useState<PageSize>(25);
  const [page, setPage] = React.useState(1);

  // Row expansion (one expanded at a time keeps the table compact)
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Display mode: relative vs. absolute timestamps
  const [relativeTime, setRelativeTime] = React.useState(false);

  // Confirmation dialog
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Refs for keyboard shortcut + auto-clear-expanded-on-page-change
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  // -------- Subscribe to the audit log ------------------------------------
  //
  // Race fix: the original code did `useState(() => getEntries())` and then
  // subscribed in a separate `useEffect`. Entries appended in the gap were
  // lost (unsubscribed → snapshot stale until next change). The fix is to
  // re-read entries inside the effect on mount AND in the change callback.
  React.useEffect(() => {
    setEntries(auditLog.getEntries());
    const unsubscribe = auditLog.onChange(() => {
      setEntries(auditLog.getEntries());
    });
    return unsubscribe;
  }, []);

  // -------- Keyboard shortcut: focus search on `/` -----------------------
  //
  // Use the document keydown listener so the shortcut works even when no
  // input is focused. Skip when the user is typing into another text field,
  // to avoid hijacking `/` keystrokes inside dialog inputs.
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditable =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (target?.isContentEditable ?? false);
      // Allow Esc to clear the search even when focused inside the input.
      if (event.key === "Escape" && searchText) {
        if (target === searchInputRef.current) {
          event.preventDefault();
          setSearchText("");
        }
        return;
      }
      if (isEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/" || event.key === "s") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [searchText]);

  // -------- Derived collections ------------------------------------------

  // Unique actors / actions for the filter dropdowns.
  const { allActors, allActions } = React.useMemo(() => {
    const actors = new Map<string, number>();
    const actions = new Map<string, number>();
    for (const e of entries) {
      actors.set(e.actor, (actors.get(e.actor) ?? 0) + 1);
      actions.set(e.action, (actions.get(e.action) ?? 0) + 1);
    }
    const sortByCount = (a: [string, number], b: [string, number]): number =>
      b[1] - a[1] || a[0].localeCompare(b[0]);
    return {
      allActors: Array.from(actors.entries()).sort(sortByCount),
      allActions: Array.from(actions.entries()).sort(sortByCount),
    };
  }, [entries]);

  // Search + filter pipeline.
  const filtered = React.useMemo(() => {
    const query = searchText.trim().toLowerCase();
    const fromTs = dateRange?.from
      ? new Date(
          dateRange.from.getFullYear(),
          dateRange.from.getMonth(),
          dateRange.from.getDate(),
          0,
          0,
          0,
          0,
        ).getTime()
      : null;
    // Inclusive end-of-day for `to` — if a single day is picked, range
    // covers 00:00..23:59:59.999 of that day.
    const toTs = dateRange?.to
      ? new Date(
          dateRange.to.getFullYear(),
          dateRange.to.getMonth(),
          dateRange.to.getDate(),
          23,
          59,
          59,
          999,
        ).getTime()
      : dateRange?.from
        ? new Date(
            dateRange.from.getFullYear(),
            dateRange.from.getMonth(),
            dateRange.from.getDate(),
            23,
            59,
            59,
            999,
          ).getTime()
        : null;

    return entries.filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (actorFilter.size > 0 && !actorFilter.has(e.actor)) return false;
      if (actionFilter.size > 0 && !actionFilter.has(e.action)) return false;
      if (fromTs !== null || toTs !== null) {
        const ts = new Date(e.timestamp).getTime();
        if (Number.isNaN(ts)) return false;
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
      }
      if (!query) return true;
      const errorText = e.error ?? "";
      const detailsText = e.details
        ? // Cheap stringification just for substring search; full pretty
          // version is rendered only when the row is expanded.
          JSON.stringify(e.details).toLowerCase()
        : "";
      return (
        (e.actor ?? "").toLowerCase().includes(query) ||
        (e.action ?? "").toLowerCase().includes(query) ||
        (e.target ?? "").toLowerCase().includes(query) ||
        (e.status ?? "").toLowerCase().includes(query) ||
        errorText.toLowerCase().includes(query) ||
        detailsText.includes(query)
      );
    });
  }, [
    entries,
    searchText,
    statusFilter,
    actorFilter,
    actionFilter,
    dateRange,
  ]);

  // Sort.
  const sorted = React.useMemo(() => {
    const arr = filtered.slice();
    const dir = sort.dir === "asc" ? 1 : -1;
    const key = sort.key;
    arr.sort((a, b) => {
      if (key === "timestamp") {
        return (
          (new Date(a.timestamp).getTime() -
            new Date(b.timestamp).getTime()) *
          dir
        );
      }
      const av = (a[key] ?? "").toString().toLowerCase();
      const bv = (b[key] ?? "").toString().toLowerCase();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tiebreaker on timestamp desc so equal keys stay newest-first.
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
    return arr;
  }, [filtered, sort]);

  // Pagination.
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = React.useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, currentPage, pageSize]);

  // Reset page to 1 whenever a filter or page size changes, so the user
  // doesn't end up on an empty page after narrowing the result set.
  React.useEffect(() => {
    setPage(1);
  }, [searchText, statusFilter, actorFilter, actionFilter, dateRange, pageSize, sort]);

  // Collapse any expanded row that's no longer visible in the page.
  React.useEffect(() => {
    if (!expandedId) return;
    if (!paged.some((e) => e.id === expandedId)) {
      setExpandedId(null);
    }
  }, [paged, expandedId]);

  // -------- Handlers ------------------------------------------------------

  const handleRequestClear = React.useCallback(() => {
    setConfirmOpen(true);
  }, []);
  const handleConfirmClear = React.useCallback(() => {
    auditLog.clear();
    setConfirmOpen(false);
    setExpandedId(null);
  }, []);
  const handleCancelClear = React.useCallback(() => {
    setConfirmOpen(false);
  }, []);

  const handleResetFilters = React.useCallback(() => {
    setSearchText("");
    setStatusFilter("all");
    setActorFilter(new Set());
    setActionFilter(new Set());
    setDateRange(undefined);
    setSort({ key: "timestamp", dir: "desc" });
  }, []);

  const toggleSort = React.useCallback((key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) {
        // First click sorts ascending for text columns; descending for
        // timestamp because newest-first is the natural default.
        return { key, dir: key === "timestamp" ? "desc" : "asc" };
      }
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  }, []);

  const toggleActor = React.useCallback((actor: string) => {
    setActorFilter((prev) => {
      const next = new Set(prev);
      if (next.has(actor)) next.delete(actor);
      else next.add(actor);
      return next;
    });
  }, []);

  const toggleAction = React.useCallback((action: string) => {
    setActionFilter((prev) => {
      const next = new Set(prev);
      if (next.has(action)) next.delete(action);
      else next.add(action);
      return next;
    });
  }, []);

  const handleRowToggle = React.useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  // -------- Export columns ------------------------------------------------

  // Columns descriptor reused by the ExportMenu (CSV + JSON). Includes the
  // optional `details` and `error` fields when present.
  const exportColumns: ExportColumn<AuditEntry>[] = React.useMemo(
    () => [
      {
        header: "Timestamp",
        accessor: (e) => formatDateTime(e.timestamp),
      },
      { header: "Actor", accessor: (e) => e.actor },
      { header: "Action", accessor: (e) => e.action },
      { header: "Target", accessor: (e) => e.target },
      { header: "Status", accessor: (e) => e.status },
      { header: "Error", accessor: (e) => e.error ?? "" },
      {
        header: "Details",
        accessor: (e) => (e.details ? JSON.stringify(e.details) : ""),
      },
    ],
    [],
  );

  // -------- Summary stats & insights -------------------------------------

  const hasEntries = entries.length > 0;
  const hasMatches = sorted.length > 0;

  // Overall success / failure counts across the retained buffer — used by
  // the summary stat row and quick-filter chips.
  const totals = React.useMemo(() => {
    let success = 0;
    let failure = 0;
    for (const e of entries) {
      if (e.status === "success") success += 1;
      else failure += 1;
    }
    return { success, failure };
  }, [entries]);

  // Active filter count — shown on the "Reset" chip and used to decide
  // whether to surface the reset affordance at all.
  const activeFilterCount =
    (searchText.trim() ? 1 : 0) +
    (statusFilter !== "all" ? 1 : 0) +
    (actorFilter.size > 0 ? 1 : 0) +
    (actionFilter.size > 0 ? 1 : 0) +
    (dateRange?.from ? 1 : 0);

  // ---- Insights: entries-per-hour timeline + top actors / top actions ---
  //
  // Off-by-one fix: align buckets to the floor of "now" truncated to the
  // hour. Bucket `0` = `[startHour-23h, startHour-22h)` (oldest), bucket 23
  // = `[startHour, startHour+1h)` (current hour). An entry's `ts` belongs
  // to bucket `floor((ts - startHourMinus23h) / hour)` exactly once.
  const insights = React.useMemo(() => {
    const now = Date.now();
    const currentHourStart = now - (now % (60 * 60 * 1000));
    const windowStart = currentHourStart - 23 * 60 * 60 * 1000;
    const windowEnd = currentHourStart + 60 * 60 * 1000; // exclusive
    const buckets = new Array<number>(24).fill(0);
    let totalIn24h = 0;
    let successCount = 0;
    let failureCount = 0;
    const actorCounts = new Map<string, number>();
    const actionCounts = new Map<string, number>();

    for (const entry of entries) {
      const ts = new Date(entry.timestamp).getTime();
      if (!Number.isNaN(ts) && ts >= windowStart && ts < windowEnd) {
        const idx = Math.floor((ts - windowStart) / (60 * 60 * 1000));
        if (idx >= 0 && idx < 24) {
          buckets[idx] = (buckets[idx] ?? 0) + 1;
          totalIn24h += 1;
          if (entry.status === "success") successCount += 1;
          else failureCount += 1;
        }
      }
      // Top actors / actions are computed across the full retained log
      // (not just 24h) since the buffer is already capped at 500.
      actorCounts.set(entry.actor, (actorCounts.get(entry.actor) ?? 0) + 1);
      actionCounts.set(entry.action, (actionCounts.get(entry.action) ?? 0) + 1);
    }

    const peak = Math.max(...buckets, 1);
    const topActors: MiniBarItem[] = Array.from(actorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, value]) => ({ label, value, tone: "info" as const }));
    const topActions: MiniBarItem[] = Array.from(actionCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, value]) => ({ label, value, tone: "primary" as const }));

    return {
      buckets,
      peak,
      totalIn24h,
      successCount,
      failureCount,
      topActors,
      topActions,
      currentHourStart,
    };
  }, [entries]);

  // Date range available in the log (used to bound the calendar picker).
  const dateBounds = React.useMemo(() => {
    if (entries.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const e of entries) {
      const ts = new Date(e.timestamp).getTime();
      if (Number.isNaN(ts)) continue;
      if (ts < min) min = ts;
      if (ts > max) max = ts;
    }
    if (!Number.isFinite(min)) return null;
    return { min: new Date(min), max: new Date(max) };
  }, [entries]);

  // -------- Render -------------------------------------------------------

  return (
    <div className="flex flex-col gap-4 py-4">
      <PageHeader
        title="Audit Log"
        description="Session history of destructive actions and login events."
      >
        <div className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={searchInputRef}
            type="search"
            placeholder="Search entries..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="h-8 w-64 pl-7 pr-14"
            aria-label="Search audit entries"
          />
          <Kbd
            className="pointer-events-none absolute right-2"
            aria-hidden
          >
            /
          </Kbd>
        </div>
        <InfoTooltip
          content={
            <div className="space-y-1.5">
              <p className="m-0 text-xs leading-relaxed">
                Searches across Actor, Action, Target, Status, Error, and
                Details (JSON-serialized) fields. Case-insensitive substring
                match.
              </p>
              <p className="m-0 text-2xs text-muted-foreground">
                Press <Kbd>/</Kbd> from anywhere on this page to focus the
                search box, and <Kbd>Esc</Kbd> while focused to clear it.
              </p>
            </div>
          }
          ariaLabel="Search field help"
        />
        <ExportMenu<AuditEntry>
          rows={sorted}
          columns={exportColumns}
          filename="audit-log"
          jsonMetadata={{
            source: "AzureBatchManager.AuditLog",
            statusFilter,
            actorFilter: Array.from(actorFilter),
            actionFilter: Array.from(actionFilter),
            dateRange:
              dateRange?.from
                ? {
                    from: dateRange.from.toISOString(),
                    to: (dateRange.to ?? dateRange.from).toISOString(),
                  }
                : undefined,
            searchQuery: searchText || undefined,
            sort,
          }}
          disabled={!hasMatches}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleRequestClear}
          disabled={!hasEntries}
          className={cn(
            "gap-1.5 border-destructive/60 text-destructive hover:bg-destructive/10",
          )}
          aria-label="Clear all audit log entries"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Clear Log
        </Button>
      </PageHeader>

      {/* Summary stats + quick-filter chips */}
      {hasEntries && (
        <div className="flex flex-wrap items-center gap-3">
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Audit log summary statistics"
          >
            <SummaryStatItem label="Total" value={entries.length} compact />
            <SummaryStatItem
              label="Success"
              value={totals.success}
              tone="success"
              compact
            />
            <SummaryStatItem
              label="Failed"
              value={totals.failure}
              tone="destructive"
              compact
            />
            <SummaryStatItem
              label="Last 24h"
              value={insights.totalIn24h}
              tone="info"
              compact
            />
            {activeFilterCount > 0 && (
              <SummaryStatItem
                label="Matching"
                value={sorted.length}
                tone="warning"
                compact
                hint={
                  sorted.length === entries.length
                    ? undefined
                    : `of ${entries.length}`
                }
              />
            )}
          </div>
          {/* Quick filters — clickable chips that drive the statusFilter */}
          <div
            className="ml-auto flex items-center gap-1 rounded-md border border-border bg-card p-0.5"
            role="group"
            aria-label="Filter by status"
          >
            {(
              [
                { key: "all", label: "All", count: entries.length },
                {
                  key: "success",
                  label: "Success only",
                  count: totals.success,
                },
                {
                  key: "failure",
                  label: "Failed only",
                  count: totals.failure,
                },
              ] as const
            ).map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setStatusFilter(chip.key)}
                aria-pressed={statusFilter === chip.key}
                className={cn(
                  "rounded-sm px-2 py-1 text-2xs font-medium uppercase tracking-wider transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  statusFilter === chip.key
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {chip.label}
                <span className="ml-1 tabular-nums opacity-70">
                  {chip.count}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filter toolbar — actor + action dropdowns, date-range picker,
          relative-time toggle, reset, sort indicator. */}
      {hasEntries && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/50 p-2"
          role="group"
          aria-label="Audit log filters"
        >
          <SlidersHorizontal
            className="ml-1 h-3.5 w-3.5 text-muted-foreground"
            aria-hidden
          />
          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            Filters
          </span>

          {/* Actor filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 gap-1.5",
                  actorFilter.size > 0 && "border-primary/60 text-primary",
                )}
                aria-label={
                  actorFilter.size > 0
                    ? `Actor filter (${actorFilter.size} selected)`
                    : "Filter by actor"
                }
              >
                <Users className="h-3 w-3" aria-hidden />
                Actor
                {actorFilter.size > 0 && (
                  <Badge
                    variant="default"
                    className="ml-0.5 h-4 min-w-4 px-1 text-3xs tabular-nums"
                  >
                    {actorFilter.size}
                  </Badge>
                )}
                <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-72 w-64 overflow-y-auto"
            >
              <DropdownMenuLabel className="flex items-center justify-between">
                <span>Filter by actor</span>
                {actorFilter.size > 0 && (
                  <button
                    type="button"
                    className="text-2xs font-medium text-primary hover:underline"
                    onClick={() => setActorFilter(new Set())}
                  >
                    Clear
                  </button>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {allActors.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No actors yet.
                </p>
              ) : (
                allActors.map(([actor, count]) => (
                  <DropdownMenuCheckboxItem
                    key={actor}
                    checked={actorFilter.has(actor)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => toggleActor(actor)}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate" title={actor}>
                        {actor}
                      </span>
                      <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">
                        {count}
                      </span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Action filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 gap-1.5",
                  actionFilter.size > 0 && "border-primary/60 text-primary",
                )}
                aria-label={
                  actionFilter.size > 0
                    ? `Action filter (${actionFilter.size} selected)`
                    : "Filter by action"
                }
              >
                <Zap className="h-3 w-3" aria-hidden />
                Action
                {actionFilter.size > 0 && (
                  <Badge
                    variant="default"
                    className="ml-0.5 h-4 min-w-4 px-1 text-3xs tabular-nums"
                  >
                    {actionFilter.size}
                  </Badge>
                )}
                <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-72 w-64 overflow-y-auto"
            >
              <DropdownMenuLabel className="flex items-center justify-between">
                <span>Filter by action</span>
                {actionFilter.size > 0 && (
                  <button
                    type="button"
                    className="text-2xs font-medium text-primary hover:underline"
                    onClick={() => setActionFilter(new Set())}
                  >
                    Clear
                  </button>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {allActions.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No actions yet.
                </p>
              ) : (
                allActions.map(([action, count]) => (
                  <DropdownMenuCheckboxItem
                    key={action}
                    checked={actionFilter.has(action)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => toggleAction(action)}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs" title={action}>
                        {action}
                      </span>
                      <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">
                        {count}
                      </span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Date range */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 gap-1.5",
                  dateRange?.from && "border-primary/60 text-primary",
                )}
                aria-label="Filter by date range"
              >
                <CalendarDays className="h-3 w-3" aria-hidden />
                {dateRange?.from ? (
                  <span className="tabular-nums">
                    {dateRange.from.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                    {dateRange.to &&
                    dateRange.to.toDateString() !==
                      dateRange.from.toDateString()
                      ? ` – ${dateRange.to.toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}`
                      : ""}
                  </span>
                ) : (
                  <span>Date range</span>
                )}
                <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-0">
              <div className="flex flex-col gap-2 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                    Pick a range
                  </span>
                  {dateRange?.from && (
                    <button
                      type="button"
                      className="text-2xs font-medium text-primary hover:underline"
                      onClick={() => setDateRange(undefined)}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <Calendar
                  mode="range"
                  selected={dateRange}
                  onSelect={setDateRange}
                  numberOfMonths={1}
                  defaultMonth={dateRange?.from ?? dateBounds?.max}
                  disabled={
                    dateBounds
                      ? [
                          { before: dateBounds.min },
                          { after: new Date() },
                        ]
                      : { after: new Date() }
                  }
                />
                {/* Quick-pick presets */}
                <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">
                  {(
                    [
                      { label: "Today", days: 0 },
                      { label: "Last 24h", days: 1 },
                      { label: "Last 7 days", days: 7 },
                      { label: "Last 30 days", days: 30 },
                    ] as const
                  ).map((preset) => (
                    <Button
                      key={preset.label}
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        const now = new Date();
                        const from = new Date(now);
                        from.setDate(from.getDate() - preset.days);
                        setDateRange({ from, to: now });
                      }}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* Relative time toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRelativeTime((v) => !v)}
            className={cn(
              "h-7 gap-1.5",
              relativeTime && "border-primary/60 text-primary",
            )}
            aria-pressed={relativeTime}
            aria-label={
              relativeTime
                ? "Switch to absolute timestamps"
                : "Switch to relative timestamps"
            }
          >
            <Clock className="h-3 w-3" aria-hidden />
            {relativeTime ? "Relative" : "Absolute"}
          </Button>

          {/* Reset all filters */}
          {activeFilterCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetFilters}
              className="ml-auto h-7 gap-1.5 text-muted-foreground hover:text-foreground"
              aria-label="Reset all filters"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              Reset
              <Badge variant="outline" className="ml-0.5 tabular-nums">
                {activeFilterCount}
              </Badge>
            </Button>
          )}
        </div>
      )}

      {hasEntries && (
        <section
          role="region"
          aria-label="Audit log insights"
          className="grid grid-cols-1 gap-3 lg:grid-cols-3"
        >
          {/* Timeline — last 24h activity histogram */}
          <div className="rounded-md border border-border bg-card p-4 lg:col-span-1">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Last 24 hours
              </h3>
              <span className="text-2xs text-muted-foreground tabular-nums">
                <strong className="text-foreground">
                  {insights.totalIn24h}
                </strong>{" "}
                event{insights.totalIn24h === 1 ? "" : "s"}
              </span>
            </div>
            <div
              className="mt-3 flex h-16 items-end gap-px"
              role="img"
              aria-label={`Audit events per hour over the last 24 hours; peak ${insights.peak}`}
            >
              {insights.buckets.map((count, hourIdx) => {
                const heightPct =
                  insights.peak > 0 ? (count / insights.peak) * 100 : 0;
                const tone =
                  count === 0
                    ? "bg-muted/40"
                    : count >= insights.peak * 0.66
                      ? "bg-primary"
                      : count >= insights.peak * 0.33
                        ? "bg-info"
                        : "bg-info/60";
                const hoursAgo = 23 - hourIdx;
                // Hour-aligned bucket label, computed off `currentHourStart`
                // so the tooltip matches the binning logic.
                const bucketStart = new Date(
                  insights.currentHourStart - hoursAgo * 60 * 60 * 1000,
                );
                const bucketLabel = bucketStart.toLocaleString(undefined, {
                  hour: "numeric",
                  hour12: false,
                });
                return (
                  <span
                    key={hourIdx}
                    className={cn("flex-1 rounded-sm", tone)}
                    style={{
                      height: `${Math.max(heightPct, count > 0 ? 8 : 4)}%`,
                    }}
                    title={
                      count === 0
                        ? `${bucketLabel}:00 (${hoursAgo}h ago): no events`
                        : `${bucketLabel}:00 (${hoursAgo}h ago): ${count} event${
                            count === 1 ? "" : "s"
                          }`
                    }
                  />
                );
              })}
            </div>
            <div className="mt-1.5 flex justify-between text-3xs text-muted-foreground">
              <span>24h ago</span>
              <span>now</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-2xs text-muted-foreground tabular-nums">
              <span>
                <span
                  className="mr-1 inline-block h-2 w-2 rounded-sm bg-success"
                  aria-hidden="true"
                />
                <strong className="text-foreground">
                  {insights.successCount}
                </strong>{" "}
                success
              </span>
              <span>
                <span
                  className="mr-1 inline-block h-2 w-2 rounded-sm bg-destructive"
                  aria-hidden="true"
                />
                <strong className="text-foreground">
                  {insights.failureCount}
                </strong>{" "}
                failed
              </span>
            </div>
          </div>

          {/* Top actors */}
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="m-0 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Top actors
              <InfoTooltip
                content="Click an actor to filter the table to entries from that user."
                ariaLabel="Top actors help"
              />
            </h3>
            {insights.topActors.length === 0 ? (
              <p className="mt-2 text-2xs text-muted-foreground">
                No actor activity yet.
              </p>
            ) : (
              <MiniBar
                items={insights.topActors}
                ariaLabel="Top actors by event count"
                className="mt-2"
              />
            )}
          </div>

          {/* Top actions */}
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="m-0 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Top actions
              <InfoTooltip
                content="Click an action to filter the table to entries matching that action."
                ariaLabel="Top actions help"
              />
            </h3>
            {insights.topActions.length === 0 ? (
              <p className="mt-2 text-2xs text-muted-foreground">
                No action activity yet.
              </p>
            ) : (
              <MiniBar
                items={insights.topActions}
                ariaLabel="Top actions by event count"
                className="mt-2"
              />
            )}
          </div>
        </section>
      )}

      {!hasMatches ? (
        hasEntries ? (
          <EmptyState
            icon={Filter}
            title="No entries match the current filters"
            description="Try clearing the search or adjusting filter selections."
            action={{
              label: "Reset filters",
              onClick: handleResetFilters,
              icon: RotateCcw,
            }}
          />
        ) : (
          <EmptyState
            icon={FileText}
            title="No audit entries recorded yet"
            description="Audit entries appear here as actions are performed."
          />
        )
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {/* Expand column */}
                <TableHead className="w-8" aria-label="Expand row" />
                <SortableHead
                  label="Timestamp"
                  sortKey="timestamp"
                  sort={sort}
                  onToggle={toggleSort}
                />
                <SortableHead
                  label="Actor"
                  sortKey="actor"
                  sort={sort}
                  onToggle={toggleSort}
                />
                <SortableHead
                  label="Action"
                  sortKey="action"
                  sort={sort}
                  onToggle={toggleSort}
                />
                <SortableHead
                  label="Target"
                  sortKey="target"
                  sort={sort}
                  onToggle={toggleSort}
                />
                <SortableHead
                  label="Status"
                  sortKey="status"
                  sort={sort}
                  onToggle={toggleSort}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((entry) => {
                const isExpanded = expandedId === entry.id;
                const hasExpandable =
                  Boolean(entry.details) || Boolean(entry.error);
                return (
                  <React.Fragment key={entry.id}>
                    <TableRow
                      data-state={isExpanded ? "selected" : undefined}
                      className={cn(
                        hasExpandable && "cursor-pointer",
                        isExpanded && "bg-muted/40",
                      )}
                      onClick={
                        hasExpandable
                          ? () => handleRowToggle(entry.id)
                          : undefined
                      }
                    >
                      <TableCell className="w-8 p-0 text-center align-middle">
                        {hasExpandable ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRowToggle(entry.id);
                            }}
                            aria-label={
                              isExpanded ? "Collapse details" : "Expand details"
                            }
                            aria-expanded={isExpanded}
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {isExpanded ? (
                              <ChevronDown
                                className="h-3.5 w-3.5"
                                aria-hidden
                              />
                            ) : (
                              <ChevronRight
                                className="h-3.5 w-3.5"
                                aria-hidden
                              />
                            )}
                          </button>
                        ) : (
                          <span
                            className="inline-block h-1 w-1 rounded-full bg-muted-foreground/30"
                            aria-hidden
                          />
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground tabular-nums">
                        <span
                          title={
                            relativeTime
                              ? formatDateTime(entry.timestamp)
                              : entry.timestamp
                          }
                        >
                          {relativeTime
                            ? formatRelativeTime(entry.timestamp)
                            : formatDateTime(entry.timestamp)}
                        </span>
                      </TableCell>
                      <TableCell
                        className="text-sm text-foreground"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <CopyableText value={entry.actor} />
                      </TableCell>
                      <TableCell
                        className="text-sm font-medium text-primary"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <CopyableText
                          value={entry.action}
                          display={
                            <span className="font-mono text-xs">
                              {entry.action}
                            </span>
                          }
                        />
                      </TableCell>
                      <TableCell
                        className="text-sm text-foreground"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {entry.target ? (
                          <CopyableText
                            value={entry.target}
                            mono={entry.target.length > 20}
                          />
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            entry.status === "success"
                              ? "success"
                              : "destructive"
                          }
                          className="capitalize"
                        >
                          {entry.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow
                        className="bg-muted/20 hover:bg-muted/20"
                        aria-label="Row details"
                      >
                        <TableCell colSpan={6} className="p-0">
                          <RowDetails entry={entry} />
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>

          {/* Pagination footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-sunken/30 px-3 py-2">
            <div className="flex items-center gap-3 text-2xs text-muted-foreground">
              <span className="tabular-nums">
                Showing{" "}
                <strong className="text-foreground">
                  {(currentPage - 1) * pageSize + 1}
                </strong>
                {"–"}
                <strong className="text-foreground">
                  {Math.min(currentPage * pageSize, sorted.length)}
                </strong>{" "}
                of{" "}
                <strong className="text-foreground">{sorted.length}</strong>{" "}
                entries
                {sorted.length !== entries.length && (
                  <span className="text-muted-foreground/70">
                    {" "}
                    (filtered from {entries.length})
                  </span>
                )}
              </span>
              <div className="flex items-center gap-1.5">
                <span>Rows per page</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => setPageSize(Number(v) as PageSize)}
                >
                  <SelectTrigger
                    className="h-7 w-16 text-xs"
                    aria-label="Rows per page"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map((opt) => (
                      <SelectItem
                        key={opt}
                        value={String(opt)}
                        className="text-xs"
                      >
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {totalPages > 1 && (
              <Pagination className="mx-0 w-auto">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationFirst
                      onClick={() => setPage(1)}
                      disabled={currentPage <= 1}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationPrevious
                      onClick={() => setPage(currentPage - 1)}
                      disabled={currentPage <= 1}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationLink isActive aria-label={`Page ${currentPage}`}>
                      {currentPage}
                    </PaginationLink>
                  </PaginationItem>
                  <PaginationItem>
                    <span className="text-2xs text-muted-foreground tabular-nums">
                      / {totalPages}
                    </span>
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext
                      onClick={() => setPage(currentPage + 1)}
                      disabled={currentPage >= totalPages}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationLast
                      onClick={() => setPage(totalPages)}
                      disabled={currentPage >= totalPages}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            )}
          </div>
        </div>
      )}

      <ConfirmationDialog
        hidden={!confirmOpen}
        title="Clear all audit log entries?"
        message="This permanently removes the session's audit history. This action cannot be undone."
        confirmText="Clear log"
        cancelText="Cancel"
        danger
        onConfirm={handleConfirmClear}
        onCancel={handleCancelClear}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sortable column header
// ---------------------------------------------------------------------------

interface SortableHeadProps {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onToggle: (key: SortKey) => void;
}

const SortableHead: React.FC<SortableHeadProps> = ({
  label,
  sortKey,
  sort,
  onToggle,
}) => {
  const isActive = sort.key === sortKey;
  const Icon = !isActive
    ? ChevronsUpDown
    : sort.dir === "asc"
      ? ChevronUp
      : ChevronDown;
  return (
    <TableHead className="select-none">
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          "group/sort -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs font-semibold uppercase tracking-wider transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          isActive
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-label={
          isActive
            ? `${label}, sorted ${sort.dir === "asc" ? "ascending" : "descending"}; click to ${sort.dir === "asc" ? "sort descending" : "sort ascending"}`
            : `${label}, click to sort`
        }
        aria-sort={
          isActive ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
        }
      >
        {label}
        <Icon
          className={cn(
            "h-3 w-3 transition-opacity",
            isActive
              ? "opacity-100"
              : "opacity-30 group-hover/sort:opacity-70",
          )}
          aria-hidden
        />
      </button>
    </TableHead>
  );
};

// ---------------------------------------------------------------------------
// Expanded-row details
// ---------------------------------------------------------------------------

interface RowDetailsProps {
  entry: AuditEntry;
}

const RowDetails: React.FC<RowDetailsProps> = ({ entry }) => {
  const detailsJson = React.useMemo(
    () => (entry.details ? JSON.stringify(entry.details, null, 2) : ""),
    [entry.details],
  );
  return (
    <div className="border-l-2 border-primary/40 bg-surface-sunken/40 px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <DetailRow label="Entry ID" value={entry.id} mono copyable />
        <DetailRow
          label="Timestamp (ISO)"
          value={entry.timestamp}
          mono
          copyable
        />
      </div>
      {entry.error && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs font-semibold uppercase tracking-wider text-destructive">
              Error
            </span>
            <CopyButton value={entry.error} alwaysVisible iconSize={12} />
          </div>
          <pre className="m-0 mt-1.5 whitespace-pre-wrap break-words font-mono text-xs text-destructive">
            {entry.error}
          </pre>
        </div>
      )}
      {detailsJson && (
        <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Details (JSON)
            </span>
            <CopyButton value={detailsJson} alwaysVisible iconSize={12} />
          </div>
          <pre className="m-0 mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
            {detailsJson}
          </pre>
        </div>
      )}
      {!entry.error && !detailsJson && (
        <p className="text-xs text-muted-foreground">
          No additional details were recorded for this entry.
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Detail row primitive
// ---------------------------------------------------------------------------

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}

const DetailRow: React.FC<DetailRowProps> = ({
  label,
  value,
  mono = false,
  copyable = false,
}) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
      {label}
    </span>
    <span
      className={cn(
        "group/copy flex items-center gap-1.5",
        mono && "font-mono text-xs",
        !mono && "text-sm",
      )}
    >
      <span className="break-all text-foreground">{value}</span>
      {copyable && <CopyButton value={value} iconSize={11} />}
    </span>
  </div>
);
