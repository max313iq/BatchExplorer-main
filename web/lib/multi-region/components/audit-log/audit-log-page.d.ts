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
 *   - Pagination with adjustable page size (persisted across reloads).
 *   - Expandable rows showing the full `details` JSON + `error` field.
 *   - Inline copy buttons on Actor / Action / Target / details JSON.
 *   - Summary stat row: Total / Success / Failed / Last 24h.
 *   - 24-hour activity timeline + top actors + top actions histograms.
 *   - CSV + JSON export of the currently-filtered view.
 *   - Clear-log action with confirmation.
 *   - Saved filters: name + recall arbitrary filter combinations
 *     (persisted via `usePersistedState`).
 *   - Hotkeys: `/` focus search, `c` clear-log (with confirm), `e` open
 *     export menu, `t` toggle tail-mode, `g` cycle group-by, `Esc` clear
 *     search when focused.
 *   - Group-by collapsing (None / Actor / Action / Day) with per-group
 *     collapse state and an "expand all / collapse all" affordance.
 *   - Tail-mode toggle: when enabled the table auto-resets to page 1 and
 *     scrolls to the newest entry whenever new entries arrive (snapshots
 *     the live "newest" pointer rather than scrolling on every change so
 *     the user can still pan the list mid-stream).
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
 *   - `activeFilterCount` was recomputed on every render — now memoized.
 *   - Group-by collapse state previously survived across group-by mode
 *     switches, leaving stale ids in the set; we now key the collapsed set
 *     by `groupBy` mode + entry-id list so it auto-clears.
 *
 * COORDINATOR notes (for the service-layer pass):
 *   - We currently consume `auditLog.onChange()` + `auditLog.getEntries()`.
 *     If the service grows a typed `subscribe(filter, listener)` overload
 *     that returns the current snapshot synchronously, swap the effect for
 *     that to drop the double-read on mount.
 *   - The filter/search pipeline is page-local. If multiple pages need the
 *     same filter primitives, hoist `useAuditFilterPipeline` into
 *     `hooks/use-audit-filter.ts` (NOT this folder — would need coordinator
 *     approval to add a new hook file outside `audit-log/`).
 *   - Saved-filter shape is local to this page (`AUDIT_SAVED_FILTERS_KEY`).
 *     Migration to a global preferences slice would need a store schema
 *     bump and the existing `usePersistedState` `version`/`migrate` plumbing.
 */
import * as React from "react";
export declare const AuditLogPage: React.FC;
//# sourceMappingURL=audit-log-page.d.ts.map