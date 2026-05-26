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
import {
  Bookmark,
  BookmarkPlus,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Clock,
  FileText,
  Filter,
  Layers,
  Pin,
  PinOff,
  PlayCircle,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  StickyNote,
  Trash2,
  Users,
  X,
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
  DropdownMenuItem,
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

import { usePersistedState } from "../../hooks/use-persisted-state";
import { useUrlState } from "../../hooks/use-url-state";
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

/** Group-by modes. "none" preserves a flat newest-first list. */
type GroupBy = "none" | "actor" | "action" | "day";

const GROUP_BY_OPTIONS: ReadonlyArray<{ key: GroupBy; label: string }> = [
  { key: "none", label: "None" },
  { key: "actor", label: "Actor" },
  { key: "action", label: "Action" },
  { key: "day", label: "Day" },
] as const;

/**
 * Persisted saved-filter shape. `id` is a crypto-random string used as a
 * React key + a stable identifier across renames. `name` is the user-visible
 * label.
 *
 * The filter payload only includes user-pickable filter state — sort + page
 * + pageSize are intentionally NOT persisted in saved filters (they are
 * presentation concerns, not filter concerns).
 */
interface SavedFilter {
  id: string;
  name: string;
  /** ISO timestamp when this filter was last written. */
  savedAt: string;
  searchText: string;
  statusFilter: StatusFilter;
  actorFilter: string[];
  actionFilter: string[];
  /** Serialized as ISO strings to survive JSON round-trip. */
  dateRange?: { from: string; to?: string };
}

const AUDIT_PAGE_SIZE_KEY = "audit-log.pageSize.v1";
const AUDIT_RELATIVE_TIME_KEY = "audit-log.relativeTime.v1";
const AUDIT_GROUP_BY_KEY = "audit-log.groupBy.v1";
const AUDIT_TAIL_KEY = "audit-log.tail.v1";
const AUDIT_SAVED_FILTERS_KEY = "audit-log.savedFilters.v1";
/** Pinned entry IDs — persisted per-browser so operators can carry forward
 * "watch these" rows across reloads. Capped at 50 to bound localStorage. */
const AUDIT_PINNED_KEY = "audit-log.pinned.v1";
/** Per-entry operator annotations (free-text notes), keyed by entry ID. Capped
 * at 200 notes; older notes pruned LRU when over the cap. */
const AUDIT_NOTES_KEY = "audit-log.notes.v1";

// ---------------------------------------------------------------------------
// Critical Defender Audit Surface — corpus-grounded chip templates
// ---------------------------------------------------------------------------
//
// SOURCE: `C:\Users\baimgprodsesa1\Desktop\New folder\_AZURE_BYPASS_PLAYBOOK.md`
// section "Critical Defender Audit Surface" (lines 139-152). The playbook
// enumerates ten high-value detection events that any defensive program
// should wire alerts on, in priority order. These chips give the operator
// a one-click filter for each one against the local audit buffer.
//
// `matchers` is an OR-list of case-insensitive substrings; an entry matches
// the chip if its `action` field (or, fallback, `target`) contains any of
// them. The patterns are intentionally permissive — the audit-log here is
// app-internal (not Graph activity), so we match the *English-language*
// action names that this app's own services emit. For wire-level Graph
// audit names (e.g. `Set domain authentication`), the patterns also match
// since they substring against the same action field.
//
// `severity` is mapped to the chip color tone per the corpus risk framing:
// `critical` (tenant-takeover-class), `high` (privilege/persistence),
// `medium` (state-modification). Used to color-code the chip and the
// detection-coverage tiles.
//
// `cite` is a short reference to the playbook bullet (1–10) so the tooltip
// can show the operator exactly which corpus item the chip maps to.
type CritSeverity = "critical" | "high" | "medium";
interface CriticalEventTemplate {
  /** Stable id used as a React key + as a slug for the URL state. */
  id: string;
  /** Short chip label (single-line). */
  label: string;
  /** Longer hover tooltip explaining what to look for. */
  tooltip: string;
  /** Corpus risk severity used for color coding. */
  severity: CritSeverity;
  /** OR-list of substring matchers (lowercased at match time). */
  matchers: readonly string[];
  /** Short corpus citation rendered inside the tooltip. */
  cite: string;
}

const CRITICAL_AUDIT_TEMPLATES: ReadonlyArray<CriticalEventTemplate> = [
  {
    id: "set-domain-auth",
    label: "Federation change",
    tooltip:
      "Set domain authentication — new federated domain. A federated domain backdoor survives password resets, MFA resets, and role revocation.",
    severity: "critical",
    matchers: [
      "set domain authentication",
      "federation",
      "federated domain",
      "domain.*federate",
    ],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #1",
  },
  {
    id: "ca-policy-change",
    label: "CA policy disable",
    tooltip:
      "Update conditional access policy — state change to 'disabled' or new exclusion entries. Common stealth-disable of MFA enforcement.",
    severity: "critical",
    matchers: [
      "update conditional access",
      "conditional access policy",
      "ca policy",
      "disable conditional access",
    ],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #2",
  },
  {
    id: "tap-issuance",
    label: "TAP issuance",
    tooltip:
      "Issue temporary access pass — MFA-equivalent pass for any user. Auth Admin role can mint these without re-MFA.",
    severity: "critical",
    matchers: ["issue temporary access pass", "temporary access pass", "tap "],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #3",
  },
  {
    id: "approle-assign",
    label: "App-role assign",
    tooltip:
      "Add app role assignment to service principal — especially Directory.ReadWrite.All / RoleManagement.ReadWrite.Directory which lead to GA.",
    severity: "high",
    matchers: [
      "add app role assignment",
      "approleassignment",
      "app role assignment",
    ],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #4",
  },
  {
    id: "addkey",
    label: "addKey/addPassword",
    tooltip:
      "Update application — Certificates and secrets management (addPassword/addKey). Permanent app-only credential injection.",
    severity: "critical",
    matchers: [
      "addkey",
      "addpassword",
      "certificates and secrets",
      "application credentials",
      "credential rolled",
    ],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #5",
  },
  {
    id: "federated-cred",
    label: "Federated cred",
    tooltip:
      "POST /applications/{id}/federatedIdentityCredentials — workload-identity backdoor; no specific audit name, watch the raw URI.",
    severity: "critical",
    matchers: [
      "federatedidentitycredentials",
      "federated identity credential",
      "workload identity federation",
    ],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #6",
  },
  {
    id: "pim-eligibility",
    label: "PIM eligibility",
    tooltip:
      "POST /roleManagement/directory/roleEligibilityScheduleRequests — PIM eligibility creation. Stealth time-bomb persistence.",
    severity: "high",
    matchers: [
      "roleeligibilityschedulerequests",
      "pim eligibility",
      "role eligibility",
      "eligibility schedule",
    ],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #7",
  },
  {
    id: "delete-diag",
    label: "Diagnostic delete",
    tooltip:
      "Delete diagnostic setting (Activity Log). Disables log forwarding to Sentinel/SIEM — frequent first step before noisy ops.",
    severity: "high",
    matchers: [
      "delete diagnostic setting",
      "diagnosticsettings/delete",
      "diagnostic setting",
    ],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #8",
  },
  {
    id: "hard-delete-user",
    label: "Hard delete user",
    tooltip:
      "Hard delete user — bypasses the 30-day soft-delete recovery window. Used to scrub attacker-created accounts.",
    severity: "medium",
    matchers: ["hard delete user", "permanently delete user", "users/delete"],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #9",
  },
  {
    id: "cancel-subscription",
    label: "Cancel subscription",
    tooltip:
      "Cancel subscription Activity Log event. Severs billing/quotas — often follows mass-resource teardown.",
    severity: "medium",
    matchers: [
      "cancel subscription",
      "subscription.*cancel",
      "subscriptions/cancel",
    ],
    cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #10",
  },
] as const;

/** Match a single audit entry against a critical-event template. Substring,
 * case-insensitive, run on `action`+`target` so app-internal action names
 * (e.g. "ca_policy_update") and Graph-style names (e.g. "Update conditional
 * access policy") both fire. We intentionally do NOT regex-compile the
 * matchers since several contain `.` as a literal delimiter (e.g. "ca policy"
 * with embedded spaces) — substring is faster and predictable. */
function matchesCriticalTemplate(
  entry: AuditEntry,
  template: CriticalEventTemplate,
): boolean {
  const hay = `${entry.action ?? ""} ${entry.target ?? ""}`.toLowerCase();
  for (const needle of template.matchers) {
    if (!needle) continue;
    if (hay.includes(needle.toLowerCase())) return true;
  }
  return false;
}

/** Tailwind tone classes per corpus severity. */
const SEVERITY_TONE: Record<
  CritSeverity,
  { active: string; idle: string; ring: string; dot: string }
> = {
  critical: {
    active: "border-destructive bg-destructive/15 text-destructive",
    idle: "border-destructive/40 text-destructive hover:bg-destructive/10",
    ring: "ring-destructive/50",
    dot: "bg-destructive",
  },
  high: {
    active: "border-warning bg-warning/15 text-warning",
    idle: "border-warning/40 text-warning hover:bg-warning/10",
    ring: "ring-warning/50",
    dot: "bg-warning",
  },
  medium: {
    active: "border-info bg-info/15 text-info",
    idle: "border-info/40 text-info hover:bg-info/10",
    ring: "ring-info/50",
    dot: "bg-info",
  },
};

// ---------------------------------------------------------------------------
// Time-range presets (URL-shareable via useUrlState)
// ---------------------------------------------------------------------------
//
// Stored in the URL under `range=<preset>` so a link captures the operator's
// time window for collaborators. `custom` indicates the date-range picker
// drives the window and `range` is unset; the other presets compute a sliding
// `[now - N, now]` window and bypass the calendar.
type RangePreset = "1h" | "1d" | "7d" | "all" | "custom";
const RANGE_PRESETS: ReadonlyArray<{
  key: RangePreset;
  label: string;
  ms: number;
}> = [
  { key: "1h", label: "Last 1h", ms: 60 * 60 * 1000 },
  { key: "1d", label: "Last 1d", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "All", ms: Number.POSITIVE_INFINITY },
] as const;

/** Set guard so PAGE_SIZE_OPTIONS narrowing survives JSON round-trip. */
const PAGE_SIZE_SET: ReadonlySet<number> = new Set(PAGE_SIZE_OPTIONS);
function coercePageSize(raw: unknown, fallback: PageSize = 25): PageSize {
  const n = Number(raw);
  return PAGE_SIZE_SET.has(n) ? (n as PageSize) : fallback;
}

function makeSavedFilterId(): string {
  // Prefer crypto.randomUUID when available; fall back to a high-entropy
  // string. This page already references `crypto.randomUUID()` indirectly
  // via the audit-log service, so the API is known-good in this runtime.
  try {
    return crypto.randomUUID();
  } catch {
    return `sf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

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
  // Page size is persisted so it survives reload; coerce on read since the
  // localStorage value is untrusted JSON.
  const [pageSizeRaw, setPageSizeRaw] = usePersistedState<PageSize>(
    AUDIT_PAGE_SIZE_KEY,
    25,
    {
      deserialize: (raw) => {
        try {
          return coercePageSize(JSON.parse(raw));
        } catch {
          return 25;
        }
      },
    },
  );
  const pageSize = coercePageSize(pageSizeRaw);
  const [page, setPage] = React.useState(1);

  // Row expansion (one expanded at a time keeps the table compact)
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Display mode: relative vs. absolute timestamps. Persisted.
  const [relativeTime, setRelativeTime] = usePersistedState<boolean>(
    AUDIT_RELATIVE_TIME_KEY,
    false,
  );

  // Group-by mode. Persisted.
  const [groupBy, setGroupBy] = usePersistedState<GroupBy>(
    AUDIT_GROUP_BY_KEY,
    "none",
    {
      deserialize: (raw) => {
        try {
          const v = JSON.parse(raw);
          return v === "actor" || v === "action" || v === "day" || v === "none"
            ? v
            : "none";
        } catch {
          return "none";
        }
      },
    },
  );

  // Per-group collapse state. Local (not persisted) because group keys depend
  // on which entries are currently retained.
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(
    () => new Set(),
  );

  // Tail mode: when on, the table is pinned to page 1 (newest first) and
  // smooth-scrolls the body container to the top on every new arrival.
  // Persisted because operators typically want their preferred mode to
  // survive reloads.
  const [tailMode, setTailMode] = usePersistedState<boolean>(
    AUDIT_TAIL_KEY,
    false,
  );

  // Saved filters — named recall of filter combinations. Defaults to empty
  // array; we coerce any malformed payload back to `[]`.
  const [savedFilters, setSavedFilters] = usePersistedState<SavedFilter[]>(
    AUDIT_SAVED_FILTERS_KEY,
    [],
    {
      deserialize: (raw) => {
        try {
          const v = JSON.parse(raw);
          return Array.isArray(v) ? (v as SavedFilter[]) : [];
        } catch {
          return [];
        }
      },
    },
  );
  const [savedFilterName, setSavedFilterName] = React.useState("");
  const [savedFiltersOpen, setSavedFiltersOpen] = React.useState(false);

  // Corpus-grounded critical-event filter: selected template IDs. When at
  // least one is selected, only entries matching ANY of the selected templates
  // pass the filter (OR across selected templates). Local state — these are
  // ephemeral exploratory filters, not "saved" filters.
  const [activeCritIds, setActiveCritIds] = React.useState<Set<string>>(
    () => new Set(),
  );

  // Pinned entry IDs — operator-curated watch-list. Persisted so a pin
  // survives reload (provided the entry survives the 500-entry retention cap).
  const [pinnedIds, setPinnedIds] = usePersistedState<string[]>(
    AUDIT_PINNED_KEY,
    [],
    {
      deserialize: (raw) => {
        try {
          const v = JSON.parse(raw);
          return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        } catch {
          return [];
        }
      },
    },
  );
  // Memo a Set for O(1) lookup; rebuilds only when the persisted array
  // reference changes (i.e. on add/remove).
  const pinnedSet = React.useMemo(() => new Set(pinnedIds), [pinnedIds]);

  // Per-entry operator notes — keyed by entry id. Persisted.
  const [notesMap, setNotesMap] = usePersistedState<Record<string, string>>(
    AUDIT_NOTES_KEY,
    {},
    {
      deserialize: (raw) => {
        try {
          const v = JSON.parse(raw);
          return v && typeof v === "object" && !Array.isArray(v)
            ? (v as Record<string, string>)
            : {};
        } catch {
          return {};
        }
      },
    },
  );
  // Which entry is currently in note-edit mode. Local (UI only).
  const [editingNoteFor, setEditingNoteFor] = React.useState<string | null>(
    null,
  );
  const [draftNote, setDraftNote] = React.useState("");

  // URL-state: time-range preset + selected-template-ids so a deep link
  // shares the operator's lens with collaborators. `range` defaults to "all"
  // (no time clamp) so the page renders the full retained buffer by default.
  // `crit` is a comma-joined template id list — useUrlState handles arrays.
  const [urlState, setUrlState] = useUrlState<{
    range: string;
    crit: string[];
  }>({ range: "all", crit: [] });
  const rangePreset = React.useMemo<RangePreset>(() => {
    const v = urlState.range;
    if (v === "1h" || v === "1d" || v === "7d" || v === "all" || v === "custom")
      return v;
    return "all";
  }, [urlState.range]);

  // Two-way sync URL ↔ activeCritIds set. On mount we hydrate from URL; on
  // local toggle we push back. We diff against the joined-key string to avoid
  // unnecessary URL writes.
  const critUrlKey = React.useMemo(() => urlState.crit.join(","), [urlState.crit]);
  const activeCritKey = React.useMemo(
    () => Array.from(activeCritIds).sort().join(","),
    [activeCritIds],
  );
  // Hydrate on mount (and whenever URL changes externally — e.g. back-button).
  React.useEffect(() => {
    const fromUrl = urlState.crit.filter((id) =>
      CRITICAL_AUDIT_TEMPLATES.some((t) => t.id === id),
    );
    const fromUrlKey = [...fromUrl].sort().join(",");
    if (fromUrlKey !== activeCritKey) {
      setActiveCritIds(new Set(fromUrl));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [critUrlKey]);
  // Push local → URL.
  React.useEffect(() => {
    if (activeCritKey === critUrlKey) return;
    setUrlState({ crit: Array.from(activeCritIds) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCritKey]);

  // Keyboard navigation: index of the currently-focused row (within `paged`
  // for the flat view; for grouped view we still treat it as a row-index in
  // the *visible* row sequence, header rows skipped). j/k move; Enter
  // expands the focused row.
  const [focusedRowIdx, setFocusedRowIdx] = React.useState<number | null>(null);

  // Confirmation dialog
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Refs for keyboard shortcut + auto-clear-expanded-on-page-change
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  // Ref to the scrollable table container so tail-mode can scroll-to-top
  // without coupling to a global window scroll position.
  const tableScrollRef = React.useRef<HTMLDivElement | null>(null);
  // Wrapper element hosting the ExportMenu; the `e` hotkey finds the
  // inner trigger button via DOM query and synthesizes a click.
  const exportTriggerRef = React.useRef<HTMLSpanElement | null>(null);

  // -------- Subscribe to the audit log ------------------------------------
  //
  // Race fix: the original code did `useState(() => getEntries())` and then
  // subscribed in a separate `useEffect`. Entries appended in the gap were
  // lost (unsubscribed → snapshot stale until next change). The fix is to
  // re-read entries inside the effect on mount AND in the change callback.
  //
  // Cleanup MUST unsubscribe to avoid leaking the listener across mounts —
  // `auditLog.onChange` returns the disposer directly so we return it from
  // the effect.
  //
  // COORDINATOR: if the audit-log service grows a typed
  // `subscribeWithSnapshot()` that returns the current entries synchronously,
  // collapse the `setEntries(getEntries())` + `onChange(...)` pair into a
  // single call. See `../../services/audit-log.ts`.
  React.useEffect(() => {
    let active = true;
    const refresh = (): void => {
      if (!active) return;
      setEntries(auditLog.getEntries());
    };
    refresh();
    const unsubscribe = auditLog.onChange(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // -------- Keyboard shortcuts -------------------------------------------
  //
  // Document-level keydown listener so the shortcuts work even when nothing
  // is focused. We skip when the user is typing into another text field, to
  // avoid hijacking keystrokes inside dialog inputs.
  //
  // Shortcut map:
  //   /  or  s    — focus + select the search box
  //   c           — clear log (opens confirm dialog)
  //   e           — open the export menu
  //   t           — toggle tail-mode
  //   g           — cycle the group-by mode (none → actor → action → day → none)
  //   Esc         — when search input is focused: clear search
  //
  // Refs over state so the listener doesn't re-attach on every keystroke;
  // we use refs to read the *latest* value for the various shortcut paths.
  const searchTextRef = React.useRef(searchText);
  searchTextRef.current = searchText;
  const groupByRef = React.useRef(groupBy);
  groupByRef.current = groupBy;
  const hasEntriesRef = React.useRef(false);
  // Live refs for the j/k/Enter navigation handlers — see effect below. They
  // read the most recent paged slice + focused index without retriggering
  // the listener attach effect.
  const pagedRef = React.useRef<AuditEntry[]>([]);
  const focusedIdxRef = React.useRef<number | null>(null);
  focusedIdxRef.current = focusedRowIdx;
  // hasEntriesRef is wired to `entries.length` below after the entries
  // memos run; defining it up here means the keydown handler can see the
  // latest value without re-attaching.

  React.useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditable =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (target?.isContentEditable ?? false);
      // Allow Esc to clear the search even when focused inside the input.
      if (event.key === "Escape" && searchTextRef.current) {
        if (target === searchInputRef.current) {
          event.preventDefault();
          setSearchText("");
        }
        return;
      }
      if (isEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case "/":
        case "s": {
          event.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
          return;
        }
        case "c": {
          if (!hasEntriesRef.current) return;
          event.preventDefault();
          setConfirmOpen(true);
          return;
        }
        case "e": {
          // ExportMenu's trigger is a Radix DropdownMenuTrigger rendering
          // a `<button>` — find it inside the wrapper and synthesize a
          // click. Skip when disabled.
          const trigger = exportTriggerRef.current?.querySelector(
            "button",
          ) as HTMLButtonElement | null;
          if (trigger && !trigger.disabled) {
            event.preventDefault();
            trigger.click();
          }
          return;
        }
        case "t": {
          event.preventDefault();
          setTailMode((v) => !v);
          return;
        }
        case "g": {
          event.preventDefault();
          const current = groupByRef.current;
          const idx = GROUP_BY_OPTIONS.findIndex((o) => o.key === current);
          const next =
            GROUP_BY_OPTIONS[(idx + 1) % GROUP_BY_OPTIONS.length]?.key ?? "none";
          setGroupBy(next);
          return;
        }
        // j / k row navigation. Clamps to the visible paged slice; wraps at
        // edges so j-spam stays useful. Down=j, Up=k (vim convention; common
        // in our other paged grids).
        case "j":
        case "ArrowDown": {
          const rows = pagedRef.current;
          if (rows.length === 0) return;
          event.preventDefault();
          const cur = focusedIdxRef.current;
          const nextIdx =
            cur === null ? 0 : Math.min(rows.length - 1, cur + 1);
          setFocusedRowIdx(nextIdx);
          return;
        }
        case "k":
        case "ArrowUp": {
          const rows = pagedRef.current;
          if (rows.length === 0) return;
          event.preventDefault();
          const cur = focusedIdxRef.current;
          const nextIdx = cur === null ? 0 : Math.max(0, cur - 1);
          setFocusedRowIdx(nextIdx);
          return;
        }
        case "Enter": {
          const rows = pagedRef.current;
          const cur = focusedIdxRef.current;
          if (cur === null || rows.length === 0) return;
          const row = rows[cur];
          if (!row) return;
          event.preventDefault();
          setExpandedId((prev) => (prev === row.id ? null : row.id));
          return;
        }
        case "p": {
          // Pin / unpin the focused row.
          const rows = pagedRef.current;
          const cur = focusedIdxRef.current;
          if (cur === null || rows.length === 0) return;
          const row = rows[cur];
          if (!row) return;
          event.preventDefault();
          togglePin(row.id);
          return;
        }
        default:
          return;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // togglePin intentionally read via ref pattern below; it's declared
    // later in the body but the keydown handler captures it lazily through
    // the ref, so we don't list it as a dep here (would TDZ otherwise).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTailMode, setGroupBy]);

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

  // Resolve the active time-clamp range. When a preset other than "all" or
  // "custom" is selected, it wins over the date-range picker (the toolbar
  // intentionally shows the preset's effective window). "custom" leaves
  // the calendar in charge. We compute once per render against `now`.
  const presetRangeMs = React.useMemo<number | null>(() => {
    if (rangePreset === "custom" || rangePreset === "all") return null;
    const preset = RANGE_PRESETS.find((p) => p.key === rangePreset);
    return preset && Number.isFinite(preset.ms) ? preset.ms : null;
  }, [rangePreset]);

  // Search + filter pipeline.
  const filtered = React.useMemo(() => {
    const query = searchText.trim().toLowerCase();
    const activeTemplates = CRITICAL_AUDIT_TEMPLATES.filter((t) =>
      activeCritIds.has(t.id),
    );
    // Preset time-range clamp — when active, supersedes the calendar.
    const presetFromTs =
      presetRangeMs !== null ? Date.now() - presetRangeMs : null;
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
      // Corpus-grounded critical templates — OR across selected templates.
      // No-op when the set is empty (i.e. no critical filter active).
      if (activeTemplates.length > 0) {
        let any = false;
        for (const t of activeTemplates) {
          if (matchesCriticalTemplate(e, t)) {
            any = true;
            break;
          }
        }
        if (!any) return false;
      }
      // Preset range clamp (sliding window). Calendar range is additional.
      if (presetFromTs !== null) {
        const ts = new Date(e.timestamp).getTime();
        if (Number.isNaN(ts) || ts < presetFromTs) return false;
      }
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
    activeCritIds,
    presetRangeMs,
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
  }, [
    searchText,
    statusFilter,
    actorFilter,
    actionFilter,
    dateRange,
    pageSize,
    sort,
    groupBy,
    activeCritIds,
    presetRangeMs,
  ]);

  // Tail-mode: when enabled, pin to page 1 on every entries change and
  // scroll the table body to the top (which is the newest entry under
  // the default `timestamp desc` sort). We intentionally do NOT scroll on
  // every render — only when `entries` actually changes — so the operator
  // can still pan around the table mid-stream without fighting auto-scroll.
  const prevEntriesLenRef = React.useRef(entries.length);
  React.useEffect(() => {
    if (!tailMode) {
      prevEntriesLenRef.current = entries.length;
      return;
    }
    // Only react to *new* arrivals, not initial mount or clears.
    if (entries.length > prevEntriesLenRef.current) {
      setPage(1);
      const scroller = tableScrollRef.current;
      if (scroller) {
        // Newest-first means top of the body is the newest.
        scroller.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
    prevEntriesLenRef.current = entries.length;
  }, [entries, tailMode]);

  // Collapse any expanded row that's no longer visible in the page.
  React.useEffect(() => {
    if (!expandedId) return;
    if (!paged.some((e) => e.id === expandedId)) {
      setExpandedId(null);
    }
  }, [paged, expandedId]);

  // Keep the keydown navigation ref in sync, and clamp the focused row index
  // whenever the visible page slice shrinks (page nav, filter narrowing).
  pagedRef.current = paged;
  React.useEffect(() => {
    if (focusedRowIdx === null) return;
    if (paged.length === 0) {
      setFocusedRowIdx(null);
      return;
    }
    if (focusedRowIdx >= paged.length) {
      setFocusedRowIdx(paged.length - 1);
    }
  }, [paged, focusedRowIdx]);

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
    setActiveCritIds(new Set());
    setUrlState({ range: "all", crit: [] });
  }, [setUrlState]);

  // Toggle a single critical-event template id. We mutate via Set so the
  // identity changes (triggering the dependent memos) without us having to
  // construct a new array everywhere.
  const toggleCriticalTemplate = React.useCallback((id: string) => {
    setActiveCritIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Pinning — append/remove. Capped at 50 to bound the persisted list.
  const togglePin = React.useCallback(
    (id: string) => {
      setPinnedIds((prev) => {
        if (prev.includes(id)) return prev.filter((x) => x !== id);
        const next = [id, ...prev];
        return next.length > 50 ? next.slice(0, 50) : next;
      });
    },
    [setPinnedIds],
  );

  // Notes — LRU-prune over 200 entries on write.
  const saveNote = React.useCallback(
    (id: string, text: string) => {
      const trimmed = text.trim();
      setNotesMap((prev) => {
        const next: Record<string, string> = { ...prev };
        if (trimmed === "") {
          delete next[id];
          return next;
        }
        next[id] = trimmed;
        const keys = Object.keys(next);
        if (keys.length > 200) {
          // Drop the keys least recently written. We don't have explicit
          // recency metadata; instead approximate by dropping the head of
          // the insertion order (oldest keys first in Object.keys).
          const overflow = keys.length - 200;
          for (let i = 0; i < overflow; i += 1) {
            delete next[keys[i]!];
          }
        }
        return next;
      });
    },
    [setNotesMap],
  );

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

  // Note-edit lifecycle.
  const startEditingNote = React.useCallback(
    (id: string, current: string) => {
      setEditingNoteFor(id);
      setDraftNote(current);
      // Also expand the row so the note editor inside RowDetails is visible.
      setExpandedId(id);
    },
    [],
  );
  const cancelEditingNote = React.useCallback(() => {
    setEditingNoteFor(null);
    setDraftNote("");
  }, []);
  const saveNoteAndClose = React.useCallback(
    (id: string, text: string) => {
      saveNote(id, text);
      setEditingNoteFor(null);
      setDraftNote("");
    },
    [saveNote],
  );

  // Diff-sibling map: for each entry id, the id of a paired create/delete
  // (or related-action) event on the same target inside the current `paged`
  // slice. Heuristic: if two entries in the page share the same `target` and
  // one is a "create-like" action and the other a "delete-like" action (or
  // an update→update pair), link them. Two entries → bidirectional link.
  //
  // We keep the pairing inside `paged` (not the full filtered list) so the
  // jump link is guaranteed to land on a row that's currently rendered.
  // Pages may shift around the sibling — that's a known limitation; for a
  // global pair we'd need to surface the sibling outside the page boundary
  // which is a more invasive UX change.
  const diffSiblingIdMap = React.useMemo<Map<string, string>>(() => {
    const out = new Map<string, string>();
    if (paged.length < 2) return out;
    const createish = /(create|add|grant|assign|provision|enable|issue)/i;
    const deleteish = /(delete|remove|revoke|disable|cancel|hard.delete)/i;
    // Group by trimmed target. Empty targets don't pair.
    const byTarget = new Map<string, AuditEntry[]>();
    for (const e of paged) {
      const t = (e.target ?? "").trim().toLowerCase();
      if (!t) continue;
      const arr = byTarget.get(t) ?? [];
      arr.push(e);
      byTarget.set(t, arr);
    }
    for (const [, list] of byTarget) {
      if (list.length < 2) continue;
      // Find one create-ish and one delete-ish. If multiple, pick the
      // nearest by timestamp.
      const creates = list.filter((e) => createish.test(e.action));
      const deletes = list.filter((e) => deleteish.test(e.action));
      const pairs: Array<[AuditEntry, AuditEntry]> = [];
      if (creates.length > 0 && deletes.length > 0) {
        for (const c of creates) {
          let best: AuditEntry | null = null;
          let bestDelta = Number.POSITIVE_INFINITY;
          const ct = new Date(c.timestamp).getTime();
          for (const d of deletes) {
            const dt = new Date(d.timestamp).getTime();
            const delta = Math.abs(ct - dt);
            if (delta < bestDelta) {
              bestDelta = delta;
              best = d;
            }
          }
          if (best) pairs.push([c, best]);
        }
      } else if (list.length === 2) {
        // No create/delete signal, but a tight pair of two entries on the
        // same target is still worth linking — common for update→update.
        pairs.push([list[0]!, list[1]!]);
      }
      for (const [a, b] of pairs) {
        out.set(a.id, b.id);
        out.set(b.id, a.id);
      }
    }
    return out;
  }, [paged]);

  // O(1) lookup of an entry's index within `paged` for keyboard nav.
  const pagedIndex = React.useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < paged.length; i += 1) {
      m.set(paged[i]!.id, i);
    }
    return m;
  }, [paged]);
  const indexOfPaged = React.useCallback(
    (id: string) => pagedIndex.get(id) ?? -1,
    [pagedIndex],
  );

  // Jump-to-entry: scroll the row into view + briefly flash-highlight it via
  // a `data-jump-flash` attribute the row reads through CSS-like inline
  // styles. We rely on the table-scroller having stable DOM ids per row
  // (`data-entry-id`).
  const jumpToEntry = React.useCallback((id: string) => {
    const scroller = tableScrollRef.current;
    if (!scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    // Brief flash to draw attention. We toggle an outline-style highlight
    // using inline styles so we don't introduce a global CSS animation class.
    // 700ms total: 600ms transition + 100ms latency budget.
    const prevOutline = row.style.outline;
    const prevOutlineOffset = row.style.outlineOffset;
    const prevTransition = row.style.transition;
    row.style.transition = "outline-color 600ms ease-out";
    row.style.outline = "2px solid hsl(var(--warning) / 0.85)";
    row.style.outlineOffset = "-2px";
    window.setTimeout(() => {
      row.style.outline = prevOutline;
      row.style.outlineOffset = prevOutlineOffset;
      row.style.transition = prevTransition;
    }, 700);
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
  // whether to surface the reset affordance at all. Memoized to keep a
  // stable identity across renders that don't actually change filter state.
  const activeFilterCount = React.useMemo(
    () =>
      (searchText.trim() ? 1 : 0) +
      (statusFilter !== "all" ? 1 : 0) +
      (actorFilter.size > 0 ? 1 : 0) +
      (actionFilter.size > 0 ? 1 : 0) +
      (dateRange?.from ? 1 : 0) +
      (activeCritIds.size > 0 ? 1 : 0) +
      (presetRangeMs !== null ? 1 : 0),
    [
      searchText,
      statusFilter,
      actorFilter,
      actionFilter,
      dateRange,
      activeCritIds,
      presetRangeMs,
    ],
  );

  // Keep the keydown handler's `hasEntriesRef` in sync without re-attaching.
  hasEntriesRef.current = hasEntries;

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

  // -------- Detection coverage (corpus-grounded) ------------------------
  //
  // For each of the 10 critical-event templates, count how many filtered
  // entries match it within the visible time window (the `sorted` slice
  // post-filter except for the critical-template filter itself, so the panel
  // remains useful when the operator narrows to a single template).
  //
  // We split the source: critical coverage should be computed over the
  // *time/status/actor/action/date-clamped* set MINUS the critical filter.
  // To avoid re-running the whole pipeline, we approximate by computing
  // coverage over `entries` clamped to the same time window. Cheap O(n*10).
  const coverage = React.useMemo(() => {
    const presetFromTs =
      presetRangeMs !== null ? Date.now() - presetRangeMs : null;
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
    const inWindow = entries.filter((e) => {
      const ts = new Date(e.timestamp).getTime();
      if (Number.isNaN(ts)) return false;
      if (presetFromTs !== null && ts < presetFromTs) return false;
      if (fromTs !== null && ts < fromTs) return false;
      if (toTs !== null && ts > toTs) return false;
      return true;
    });
    const counts: Record<string, number> = {};
    for (const t of CRITICAL_AUDIT_TEMPLATES) {
      counts[t.id] = 0;
    }
    for (const entry of inWindow) {
      for (const t of CRITICAL_AUDIT_TEMPLATES) {
        if (matchesCriticalTemplate(entry, t)) {
          counts[t.id] = (counts[t.id] ?? 0) + 1;
        }
      }
    }
    const observed = CRITICAL_AUDIT_TEMPLATES.filter(
      (t) => (counts[t.id] ?? 0) > 0,
    ).length;
    return { counts, observed, total: CRITICAL_AUDIT_TEMPLATES.length, inWindow };
  }, [entries, dateRange, presetRangeMs]);

  // -------- Events-per-minute stacked-bar (success vs failure) -----------
  //
  // Computed over `sorted` so it reflects the operator's current lens. We
  // bucket by minute over the *visible* time range; if the range exceeds
  // 240 minutes (4h), we drop to hourly buckets to keep the chart legible.
  // Stacked: success on the bottom (info tone), failure on top (destructive).
  const perMinute = React.useMemo(() => {
    if (sorted.length === 0) {
      return { buckets: [] as Array<{ s: number; f: number; tsLabel: string }>, peak: 0, granularity: "minute" as "minute" | "hour" };
    }
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const e of sorted) {
      const ts = new Date(e.timestamp).getTime();
      if (Number.isNaN(ts)) continue;
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    if (!Number.isFinite(minTs)) {
      return { buckets: [], peak: 0, granularity: "minute" as const };
    }
    const spanMs = Math.max(maxTs - minTs, 60_000);
    const granularity: "minute" | "hour" =
      spanMs > 240 * 60_000 ? "hour" : "minute";
    const bucketMs = granularity === "hour" ? 60 * 60_000 : 60_000;
    // Align minTs to the start of its bucket.
    const start = minTs - (minTs % bucketMs);
    const end = maxTs - (maxTs % bucketMs) + bucketMs;
    const bucketCount = Math.min(120, Math.ceil((end - start) / bucketMs));
    // If we hit the 120-bucket cap, widen granularity until we fit.
    let effectiveBucketMs = bucketMs;
    let effectiveCount = bucketCount;
    while (Math.ceil((end - start) / effectiveBucketMs) > 120) {
      effectiveBucketMs *= 2;
      effectiveCount = Math.ceil((end - start) / effectiveBucketMs);
    }
    const buckets: Array<{ s: number; f: number; tsLabel: string }> = [];
    for (let i = 0; i < effectiveCount; i += 1) {
      const bStart = start + i * effectiveBucketMs;
      buckets.push({
        s: 0,
        f: 0,
        tsLabel: new Date(bStart).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: granularity === "minute" ? "numeric" : undefined,
        }),
      });
    }
    let peak = 0;
    for (const e of sorted) {
      const ts = new Date(e.timestamp).getTime();
      if (Number.isNaN(ts)) continue;
      const idx = Math.min(
        buckets.length - 1,
        Math.max(0, Math.floor((ts - start) / effectiveBucketMs)),
      );
      const b = buckets[idx];
      if (!b) continue;
      if (e.status === "success") b.s += 1;
      else b.f += 1;
      if (b.s + b.f > peak) peak = b.s + b.f;
    }
    return { buckets, peak, granularity };
  }, [sorted]);

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

  // -------- Group-by: build ordered groups from `paged` -------------------
  //
  // We group the *paged* slice (not the full filtered list) so each rendered
  // page stays bounded; the group headers therefore reflect the rows that
  // are currently visible. For "day" we bucket by the local-date string
  // (YYYY-MM-DD) so the same calendar day groups together across timezone
  // displays.
  const groups = React.useMemo(() => {
    if (groupBy === "none") return null;
    const out: Array<{ key: string; label: string; rows: AuditEntry[] }> = [];
    const seen = new Map<string, number>(); // key → index in `out`
    const labelFor = (entry: AuditEntry): { key: string; label: string } => {
      if (groupBy === "actor") {
        return { key: entry.actor || "(unknown)", label: entry.actor || "(unknown)" };
      }
      if (groupBy === "action") {
        return { key: entry.action || "(unknown)", label: entry.action || "(unknown)" };
      }
      // groupBy === "day"
      const ts = new Date(entry.timestamp);
      if (Number.isNaN(ts.getTime())) {
        return { key: "(invalid date)", label: "(invalid date)" };
      }
      // Local-date YYYY-MM-DD; the label is the same but humans render it
      // via toLocaleDateString in the header.
      const yyyy = ts.getFullYear();
      const mm = String(ts.getMonth() + 1).padStart(2, "0");
      const dd = String(ts.getDate()).padStart(2, "0");
      const key = `${yyyy}-${mm}-${dd}`;
      return {
        key,
        label: ts.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      };
    };
    for (const entry of paged) {
      const { key, label } = labelFor(entry);
      const idx = seen.get(key);
      if (idx === undefined) {
        seen.set(key, out.length);
        out.push({ key, label, rows: [entry] });
      } else {
        out[idx]!.rows.push(entry);
      }
    }
    return out;
  }, [paged, groupBy]);

  // Auto-clear stale collapsed-group ids. When `groupBy` changes the prior
  // group-keys are meaningless; when entries are cleared collapsed-ids hang
  // around forever. Recomputing the valid-key set each render and pruning
  // collapsed-ids that don't match keeps the Set tidy without an O(n) sweep
  // on every keystroke.
  React.useEffect(() => {
    if (!groups) {
      if (collapsedGroups.size > 0) setCollapsedGroups(new Set());
      return;
    }
    const validKeys = new Set(groups.map((g) => g.key));
    let mutated = false;
    const next = new Set<string>();
    for (const id of collapsedGroups) {
      if (validKeys.has(id)) next.add(id);
      else mutated = true;
    }
    if (mutated) setCollapsedGroups(next);
    // We deliberately depend on `groupBy` rather than `groups` because the
    // `groups` identity changes on every entries update — we only need to
    // re-prune when the *mode* changes or the *set of keys* changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy, groups?.map((g) => g.key).join("|")]);

  const toggleGroupCollapsed = React.useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const collapseAllGroups = React.useCallback(() => {
    if (!groups) return;
    setCollapsedGroups(new Set(groups.map((g) => g.key)));
  }, [groups]);

  const expandAllGroups = React.useCallback(() => {
    setCollapsedGroups(new Set());
  }, []);

  // -------- Saved filters --------------------------------------------------

  /** Apply a saved filter payload to the live filter state. */
  const applySavedFilter = React.useCallback(
    (sf: SavedFilter) => {
      setSearchText(sf.searchText);
      setStatusFilter(sf.statusFilter);
      setActorFilter(new Set(sf.actorFilter));
      setActionFilter(new Set(sf.actionFilter));
      if (sf.dateRange?.from) {
        const from = new Date(sf.dateRange.from);
        const to = sf.dateRange.to ? new Date(sf.dateRange.to) : undefined;
        if (Number.isNaN(from.getTime())) {
          setDateRange(undefined);
        } else {
          setDateRange({
            from,
            to: to && !Number.isNaN(to.getTime()) ? to : undefined,
          });
        }
      } else {
        setDateRange(undefined);
      }
      setSavedFiltersOpen(false);
    },
    [],
  );

  const captureCurrentFilter = React.useCallback((): Omit<SavedFilter, "id" | "name" | "savedAt"> => ({
    searchText,
    statusFilter,
    actorFilter: Array.from(actorFilter),
    actionFilter: Array.from(actionFilter),
    dateRange: dateRange?.from
      ? {
          from: dateRange.from.toISOString(),
          to: (dateRange.to ?? dateRange.from).toISOString(),
        }
      : undefined,
  }), [searchText, statusFilter, actorFilter, actionFilter, dateRange]);

  const handleSaveFilter = React.useCallback(() => {
    const trimmed = savedFilterName.trim();
    if (!trimmed) return;
    if (activeFilterCount === 0) return; // No-op: nothing to save.
    setSavedFilters((prev) => {
      // Replace by name if it already exists, else append.
      const payload: SavedFilter = {
        id: prev.find((f) => f.name === trimmed)?.id ?? makeSavedFilterId(),
        name: trimmed,
        savedAt: new Date().toISOString(),
        ...captureCurrentFilter(),
      };
      const filtered = prev.filter((f) => f.name !== trimmed);
      // Cap at 20 saved filters so localStorage stays bounded.
      return [payload, ...filtered].slice(0, 20);
    });
    setSavedFilterName("");
  }, [savedFilterName, activeFilterCount, captureCurrentFilter, setSavedFilters]);

  const handleDeleteSavedFilter = React.useCallback(
    (id: string) => {
      setSavedFilters((prev) => prev.filter((f) => f.id !== id));
    },
    [setSavedFilters],
  );

  // -------- Render -------------------------------------------------------

  return (
    <div className="flex flex-col gap-4 py-4">
      {/* Live region — announces filtered/total counts to screen readers
          whenever the visible row set changes. Hidden visually; polite to
          avoid speech interruption during fast typing. */}
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {`${sorted.length} of ${entries.length} audit entries match the current filters; showing page ${currentPage} of ${totalPages}.`}
      </span>
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
              <p className="m-0 text-2xs text-muted-foreground">
                Row navigation: <Kbd>j</Kbd> / <Kbd>k</Kbd> (or arrow keys)
                to move, <Kbd>Enter</Kbd> to expand the focused row,{" "}
                <Kbd>p</Kbd> to pin it. <Kbd>t</Kbd> tail · <Kbd>g</Kbd>{" "}
                group · <Kbd>c</Kbd> clear · <Kbd>e</Kbd> export.
              </p>
            </div>
          }
          ariaLabel="Search field help"
        />
        {/* Wrapper hosts the ExportMenu so the `e` hotkey can find the
            trigger button via DOM query. ExportMenu's trigger is a Radix
            DropdownMenuTrigger that renders a `<button>` child — we
            click whichever button shows up inside this wrapper. */}
        <span
          ref={exportTriggerRef}
          data-hotkey-host="audit-log-export"
          className="inline-flex"
        >
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
              groupBy,
            }}
            disabled={!hasMatches}
          />
        </span>
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

      {/*
       * Critical-event template row (corpus-grounded).
       *
       * Each chip is a one-click pre-canned filter for one of the 10
       * high-value detection events from
       * `_AZURE_BYPASS_PLAYBOOK.md` §Critical Defender Audit Surface
       * (lines 139-152). Severity ordering follows the playbook:
       *   • critical  red    — tenant-takeover-class (#1, #2, #3, #5, #6)
       *   • high      amber  — privilege/persistence  (#4, #7, #8)
       *   • medium    blue   — destructive cleanup    (#9, #10)
       *
       * Clicking a chip toggles its template into `activeCritIds`, which
       * the filter pipeline OR-combines with the action/actor/date filters.
       * Multiple chips can be active simultaneously (e.g. "show TAP issuance
       * OR addKey events from the last hour").
       */}
      {hasEntries && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2"
          role="group"
          aria-label="Critical defender audit events (corpus-grounded)"
        >
          <ShieldAlert
            className="ml-1 h-3.5 w-3.5 text-destructive"
            aria-hidden
          />
          <span className="text-2xs font-semibold uppercase tracking-wider text-destructive">
            Critical events
          </span>
          <InfoTooltip
            content={
              <div className="space-y-1.5">
                <p className="m-0 text-xs font-semibold">
                  Critical Defender Audit Surface
                </p>
                <p className="m-0 text-xs leading-relaxed">
                  Pre-canned filters for the 10 highest-value detection
                  events any defensive program should alert on. Click to
                  toggle; multiple chips OR together.
                </p>
                <p className="m-0 text-2xs text-muted-foreground">
                  Source: <code>_AZURE_BYPASS_PLAYBOOK.md</code> §Critical
                  Defender Audit Surface.
                </p>
              </div>
            }
            ariaLabel="Critical events help"
          />
          {CRITICAL_AUDIT_TEMPLATES.map((tpl) => {
            const active = activeCritIds.has(tpl.id);
            const count = coverage.counts[tpl.id] ?? 0;
            const tone = SEVERITY_TONE[tpl.severity];
            return (
              <button
                key={tpl.id}
                type="button"
                onClick={() => toggleCriticalTemplate(tpl.id)}
                aria-pressed={active}
                title={`${tpl.tooltip}\n\n${tpl.cite}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none",
                  active ? tone.active : tone.idle,
                  tone.ring,
                  count === 0 && !active && "opacity-60",
                )}
              >
                <span
                  className={cn("h-1.5 w-1.5 rounded-full", tone.dot)}
                  aria-hidden
                />
                <span>{tpl.label}</span>
                <span
                  className={cn(
                    "rounded-sm bg-background/60 px-1 text-3xs tabular-nums",
                    count === 0 && "opacity-40",
                  )}
                  aria-label={`${count} matching event${count === 1 ? "" : "s"} in window`}
                >
                  {count}
                </span>
              </button>
            );
          })}
          {activeCritIds.size > 0 && (
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-2xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setActiveCritIds(new Set())}
              aria-label="Clear critical-event filter"
            >
              <X className="h-3 w-3" aria-hidden />
              Clear
            </button>
          )}
        </div>
      )}

      {/* Time-range preset row — URL-shareable so a deep link captures the
          operator's time lens. Custom presets fall back to the calendar. */}
      {hasEntries && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 p-2"
          role="group"
          aria-label="Time range"
        >
          <Clock
            className="ml-1 h-3.5 w-3.5 text-muted-foreground"
            aria-hidden
          />
          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            Range
          </span>
          {RANGE_PRESETS.map((preset) => {
            const active = rangePreset === preset.key;
            return (
              <Button
                key={preset.key}
                type="button"
                variant={active ? "default" : "outline"}
                size="xs"
                onClick={() => {
                  setUrlState({ range: preset.key });
                  // Clear the calendar range so the preset is unambiguously
                  // in charge of the time window.
                  setDateRange(undefined);
                }}
                aria-pressed={active}
                className="h-7"
              >
                {preset.label}
              </Button>
            );
          })}
          <Button
            type="button"
            variant={rangePreset === "custom" ? "default" : "outline"}
            size="xs"
            onClick={() => setUrlState({ range: "custom" })}
            aria-pressed={rangePreset === "custom"}
            className="h-7"
            title="Pick a custom range with the calendar below"
          >
            Custom
          </Button>
          <InfoTooltip
            content="Shareable via URL — copy the page link to share your time window with a collaborator."
            ariaLabel="Range help"
          />
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

          {/* Group-by selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 gap-1.5",
                  groupBy !== "none" && "border-primary/60 text-primary",
                )}
                aria-label={`Group by: ${groupBy}. Press G to cycle.`}
              >
                <Layers className="h-3 w-3" aria-hidden />
                <span>
                  Group:{" "}
                  <span className="font-semibold capitalize">{groupBy}</span>
                </span>
                <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Group by
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {GROUP_BY_OPTIONS.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.key}
                  checked={groupBy === opt.key}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => setGroupBy(opt.key)}
                >
                  {opt.label}
                </DropdownMenuCheckboxItem>
              ))}
              {groupBy !== "none" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => collapseAllGroups()}>
                    Collapse all
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => expandAllGroups()}>
                    Expand all
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Tail mode toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setTailMode((v) => !v)}
            className={cn(
              "h-7 gap-1.5",
              tailMode && "border-primary/60 text-primary",
            )}
            aria-pressed={tailMode}
            aria-label={
              tailMode
                ? "Disable tail mode (auto-scroll to newest)"
                : "Enable tail mode (auto-scroll to newest)"
            }
            title="Press T to toggle tail mode"
          >
            <PlayCircle className="h-3 w-3" aria-hidden />
            Tail
          </Button>

          {/* Saved filters dropdown */}
          <DropdownMenu
            open={savedFiltersOpen}
            onOpenChange={setSavedFiltersOpen}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 gap-1.5",
                  savedFilters.length > 0 && "border-primary/40",
                )}
                aria-label={`Saved filters (${savedFilters.length})`}
              >
                <Bookmark className="h-3 w-3" aria-hidden />
                Saved
                {savedFilters.length > 0 && (
                  <Badge
                    variant="outline"
                    className="ml-0.5 h-4 min-w-4 px-1 text-3xs tabular-nums"
                  >
                    {savedFilters.length}
                  </Badge>
                )}
                <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-72"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <DropdownMenuLabel className="flex items-center justify-between">
                <span>Saved filters</span>
                <span className="text-3xs text-muted-foreground tabular-nums">
                  {savedFilters.length}/20
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {savedFilters.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No saved filters yet. Configure filters above, then save
                  them below.
                </p>
              ) : (
                <div
                  className="max-h-48 overflow-y-auto"
                  role="listbox"
                  aria-label="Saved filters"
                >
                  {savedFilters.map((sf) => (
                    <div
                      key={sf.id}
                      className="group flex items-center gap-1 px-1 py-0.5"
                    >
                      <button
                        type="button"
                        className="flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => applySavedFilter(sf)}
                        title={`Saved ${new Date(sf.savedAt).toLocaleString()}`}
                      >
                        <span className="block truncate font-medium">
                          {sf.name}
                        </span>
                        <span className="block truncate text-3xs text-muted-foreground">
                          {[
                            sf.searchText && `"${sf.searchText}"`,
                            sf.statusFilter !== "all" && sf.statusFilter,
                            sf.actorFilter.length > 0 &&
                              `${sf.actorFilter.length} actor${sf.actorFilter.length === 1 ? "" : "s"}`,
                            sf.actionFilter.length > 0 &&
                              `${sf.actionFilter.length} action${sf.actionFilter.length === 1 ? "" : "s"}`,
                            sf.dateRange?.from && "date range",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "no filters"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteSavedFilter(sf.id);
                        }}
                        aria-label={`Delete saved filter ${sf.name}`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <DropdownMenuSeparator />
              <div className="flex items-center gap-1 px-2 py-1.5">
                <Input
                  value={savedFilterName}
                  onChange={(e) => setSavedFilterName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSaveFilter();
                    }
                  }}
                  placeholder="Filter name..."
                  className="h-7 text-xs"
                  aria-label="Saved filter name"
                  disabled={activeFilterCount === 0}
                />
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={handleSaveFilter}
                  disabled={
                    activeFilterCount === 0 || !savedFilterName.trim()
                  }
                  className="h-7 shrink-0 gap-1 px-2 text-xs"
                  aria-label="Save current filter"
                >
                  <BookmarkPlus className="h-3 w-3" aria-hidden />
                  Save
                </Button>
              </div>
              {activeFilterCount === 0 && (
                <p className="px-2 pb-2 text-3xs text-muted-foreground">
                  Configure at least one filter to save.
                </p>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

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

      {/*
       * Detection-coverage panel (corpus-grounded).
       *
       * Shows, for each of the 10 critical-event templates from
       * `_AZURE_BYPASS_PLAYBOOK.md` §Critical Defender Audit Surface,
       * whether ANY matching event has been observed in the current time
       * window (preset + calendar). Helps the operator self-assess audit
       * completeness — green tiles mean we've seen the event class at
       * least once; muted tiles mean a known-critical class has no
       * evidence in the window (which can be normal silence OR a sign
       * that logging coverage is broken).
       *
       * The tiles double as filter chips: clicking jumps the operator's
       * filter set to that template (mirrors the chip row above).
       */}
      {hasEntries && (
        <section
          role="region"
          aria-label="Detection coverage of critical audit events"
          className="rounded-md border border-border bg-card p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="m-0 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              Detection coverage
              <InfoTooltip
                content={
                  <div className="space-y-1.5">
                    <p className="m-0 text-xs">
                      Self-assessment: which of the 10 critical-event classes
                      from the corpus playbook have been observed in the
                      visible time window. Tiles with zero hits may indicate
                      normal silence OR a coverage gap in upstream logging.
                    </p>
                    <p className="m-0 text-2xs text-muted-foreground">
                      Source: <code>_AZURE_BYPASS_PLAYBOOK.md</code> §Critical
                      Defender Audit Surface (10 events).
                    </p>
                  </div>
                }
                ariaLabel="Detection coverage help"
              />
            </h3>
            <span
              className="rounded-md border border-border bg-surface-sunken px-2 py-1 text-2xs tabular-nums text-muted-foreground"
              aria-label={`${coverage.observed} of ${coverage.total} event classes observed in window`}
            >
              <strong className="text-foreground">{coverage.observed}</strong>
              {" / "}
              {coverage.total} classes observed
              <span className="ml-2 text-3xs">
                ({coverage.inWindow.length} event
                {coverage.inWindow.length === 1 ? "" : "s"} in window)
              </span>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {CRITICAL_AUDIT_TEMPLATES.map((tpl) => {
              const count = coverage.counts[tpl.id] ?? 0;
              const observed = count > 0;
              const tone = SEVERITY_TONE[tpl.severity];
              const active = activeCritIds.has(tpl.id);
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => toggleCriticalTemplate(tpl.id)}
                  aria-pressed={active}
                  title={`${tpl.tooltip}\n\n${tpl.cite}\n\n${observed ? `${count} matching event${count === 1 ? "" : "s"} in window` : "No events observed in window"}`}
                  className={cn(
                    "group flex flex-col gap-1.5 rounded-md border p-2.5 text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none",
                    observed
                      ? active
                        ? tone.active
                        : "border-border bg-surface-sunken hover:bg-accent/30"
                      : "border-border/50 bg-surface-sunken/40 hover:bg-accent/20",
                    tone.ring,
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        observed ? tone.dot : "bg-muted-foreground/30",
                      )}
                      aria-hidden
                    />
                    <span
                      className={cn(
                        "truncate text-2xs font-semibold uppercase tracking-wider",
                        observed ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {tpl.label}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span
                      className={cn(
                        "text-lg font-semibold tabular-nums",
                        observed ? "text-foreground" : "text-muted-foreground/60",
                      )}
                    >
                      {count}
                    </span>
                    <span
                      className={cn(
                        "text-3xs uppercase tracking-wider",
                        observed
                          ? "text-muted-foreground"
                          : "text-muted-foreground/50",
                      )}
                    >
                      {observed ? "observed" : "none in window"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/*
       * Events-per-minute stacked-bar over the *visible* (sorted) range.
       * Bars stack failure on top of success so the operator can spot
       * spikes at a glance. Granularity auto-degrades from per-minute to
       * per-hour when the visible range exceeds 4 hours, capped at 120
       * buckets to keep render bounded.
       *
       * Pure SVG — no chart dep introduced.
       */}
      {hasEntries && perMinute.buckets.length > 0 && (
        <section
          className="rounded-md border border-border bg-card p-4"
          role="region"
          aria-label="Events over visible time range, stacked success vs failure"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Events per {perMinute.granularity}{" "}
              <span className="text-3xs font-normal normal-case text-muted-foreground/70">
                ({perMinute.buckets.length} bucket
                {perMinute.buckets.length === 1 ? "" : "s"} · peak{" "}
                {perMinute.peak})
              </span>
            </h3>
            <div className="flex items-center gap-3 text-2xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-sm bg-info"
                  aria-hidden="true"
                />
                success
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-sm bg-destructive"
                  aria-hidden="true"
                />
                failure
              </span>
            </div>
          </div>
          <div
            className="flex h-16 items-end gap-px"
            role="img"
            aria-label={`Stacked bar chart of audit events per ${perMinute.granularity}; peak ${perMinute.peak} events.`}
          >
            {perMinute.buckets.map((bucket, idx) => {
              const total = bucket.s + bucket.f;
              if (total === 0) {
                return (
                  <span
                    key={idx}
                    className="flex-1 rounded-sm bg-muted/20"
                    style={{ height: "6%" }}
                    title={`${bucket.tsLabel}: no events`}
                  />
                );
              }
              const totalPct = (total / perMinute.peak) * 100;
              const sShare = bucket.s / total;
              const fShare = bucket.f / total;
              return (
                <span
                  key={idx}
                  className="flex-1 flex flex-col-reverse"
                  style={{ height: `${Math.max(totalPct, 8)}%` }}
                  title={`${bucket.tsLabel}: ${bucket.s} success, ${bucket.f} failure`}
                >
                  {sShare > 0 && (
                    <span
                      className="block rounded-b-sm bg-info"
                      style={{ height: `${sShare * 100}%` }}
                    />
                  )}
                  {fShare > 0 && (
                    <span
                      className={cn(
                        "block bg-destructive",
                        sShare === 0 && "rounded-b-sm",
                        "rounded-t-sm",
                      )}
                      style={{ height: `${fShare * 100}%` }}
                    />
                  )}
                </span>
              );
            })}
          </div>
          <div className="mt-1.5 flex justify-between text-3xs text-muted-foreground tabular-nums">
            <span>{perMinute.buckets[0]?.tsLabel}</span>
            <span>{perMinute.buckets[perMinute.buckets.length - 1]?.tsLabel}</span>
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
        <div className="rounded-md border border-border bg-card">
          {/* Scrollable container — bound the table height so tail-mode
              has something to scroll. `max-h-[70vh]` keeps the table tall
              on big monitors but still lets the rest of the page (insights,
              pagination footer) breathe. */}
          <div
            ref={tableScrollRef}
            className="max-h-[70vh] overflow-x-auto overflow-y-auto"
            role="region"
            aria-label="Audit log entries"
            tabIndex={0}
          >
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
                {(() => {
                  // Single shared context object so we don't construct it
                  // inside per-row map callbacks (would invalidate React
                  // child reconciliation more often than needed).
                  const rowCtx: RenderEntryRowsContext = {
                    expandedId,
                    relativeTime,
                    handleRowToggle,
                    togglePin,
                    pinnedSet,
                    notesMap,
                    startEditingNote,
                    saveNote: saveNoteAndClose,
                    editingNoteFor,
                    draftNote,
                    setDraftNote,
                    cancelEditingNote,
                    focusedRowIdx,
                    indexOf: indexOfPaged,
                    diffSiblingIdMap,
                    jumpToEntry,
                  };
                  return groups
                  ? groups.map((group) => {
                      const isCollapsed = collapsedGroups.has(group.key);
                      return (
                        <React.Fragment key={`grp:${group.key}`}>
                          <TableRow
                            className="cursor-pointer bg-surface-sunken/40 hover:bg-surface-sunken/60"
                            onClick={() => toggleGroupCollapsed(group.key)}
                            data-group-header
                          >
                            <TableCell
                              colSpan={6}
                              className="py-1.5 align-middle"
                            >
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleGroupCollapsed(group.key);
                                  }}
                                  aria-label={
                                    isCollapsed
                                      ? `Expand group ${group.label}`
                                      : `Collapse group ${group.label}`
                                  }
                                  aria-expanded={!isCollapsed}
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  {isCollapsed ? (
                                    <ChevronRight
                                      className="h-3.5 w-3.5"
                                      aria-hidden
                                    />
                                  ) : (
                                    <ChevronDown
                                      className="h-3.5 w-3.5"
                                      aria-hidden
                                    />
                                  )}
                                </button>
                                <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                                  {groupBy}
                                </span>
                                <span
                                  className="truncate font-mono text-xs text-foreground"
                                  title={group.label}
                                >
                                  {group.label}
                                </span>
                                <Badge
                                  variant="outline"
                                  className="ml-1 h-4 min-w-4 px-1 text-3xs tabular-nums"
                                >
                                  {group.rows.length}
                                </Badge>
                              </div>
                            </TableCell>
                          </TableRow>
                          {!isCollapsed &&
                            group.rows.map((entry) =>
                              renderEntryRows(entry, rowCtx),
                            )}
                        </React.Fragment>
                      );
                    })
                  : paged.map((entry) => renderEntryRows(entry, rowCtx));
                })()}
              </TableBody>
            </Table>
          </div>

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
                  onValueChange={(v) => setPageSizeRaw(coercePageSize(v))}
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
// Row renderer — shared between flat-list and grouped views.
// ---------------------------------------------------------------------------

interface RenderEntryRowsContext {
  expandedId: string | null;
  relativeTime: boolean;
  handleRowToggle: (id: string) => void;
  /** Pin / unpin a row. */
  togglePin: (id: string) => void;
  pinnedSet: Set<string>;
  /** Notes — per-entry free-text annotations. Persisted. */
  notesMap: Record<string, string>;
  /** Open the note-edit UI for a row. */
  startEditingNote: (id: string, current: string) => void;
  /** Save a note (or clear it when trimmed text is empty). */
  saveNote: (id: string, text: string) => void;
  /** Currently-editing entry id (one open at a time). */
  editingNoteFor: string | null;
  draftNote: string;
  setDraftNote: (next: string) => void;
  cancelEditingNote: () => void;
  /** Pre-paged row index for the visual focused row (keyboard nav). */
  focusedRowIdx: number | null;
  /** Lookup of an entry's index within `paged`. Used to drive the focus. */
  indexOf: (id: string) => number;
  /** Lookup: for each entry id, the id of a paired "related event" — e.g.
   *  the matching create/delete on the same target. Empty when the entry has
   *  no obvious pair in the visible set. */
  diffSiblingIdMap: Map<string, string>;
  /** Scroll an entry into view + flash-highlight it. Used by diff-mode
   *  "jump to sibling" links. */
  jumpToEntry: (id: string) => void;
}

/**
 * Render the main row + (optional) expanded-details row for one audit entry.
 * Pulled out of the JSX so the grouped renderer and the flat renderer can
 * share it without duplicating ~70 lines of cell markup.
 */
function renderEntryRows(
  entry: AuditEntry,
  ctx: RenderEntryRowsContext,
): React.ReactElement {
  const {
    expandedId,
    relativeTime,
    handleRowToggle,
    togglePin,
    pinnedSet,
    notesMap,
    startEditingNote,
    saveNote,
    editingNoteFor,
    draftNote,
    setDraftNote,
    cancelEditingNote,
    focusedRowIdx,
    indexOf,
    diffSiblingIdMap,
    jumpToEntry,
  } = ctx;
  const isExpanded = expandedId === entry.id;
  const hasExpandable = Boolean(entry.details) || Boolean(entry.error);
  const isPinned = pinnedSet.has(entry.id);
  const hasNote = Boolean(notesMap[entry.id]);
  const isEditingNote = editingNoteFor === entry.id;
  const entryIdx = indexOf(entry.id);
  const isFocused = focusedRowIdx !== null && entryIdx === focusedRowIdx;
  const siblingId = diffSiblingIdMap.get(entry.id) ?? null;
  // Force an expanded view when we're editing a note for this row, so the
  // user has somewhere to type without juggling two rows.
  const effectiveExpanded = isExpanded || isEditingNote;
  return (
    <React.Fragment key={entry.id}>
      <TableRow
        data-state={effectiveExpanded ? "selected" : undefined}
        data-entry-id={entry.id}
        className={cn(
          "group/row",
          hasExpandable && "cursor-pointer",
          effectiveExpanded && "bg-muted/40",
          isPinned && "border-l-2 border-l-warning",
          isFocused && "ring-2 ring-inset ring-primary/60",
        )}
        onClick={
          hasExpandable ? () => handleRowToggle(entry.id) : undefined
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
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
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
              <span className="font-mono text-xs">{entry.action}</span>
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
        <TableCell onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-1.5">
            <Badge
              variant={
                entry.status === "success" ? "success" : "destructive"
              }
              className="capitalize"
            >
              {entry.status}
            </Badge>
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
              {/* Pin toggle — persisted */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(entry.id);
                }}
                aria-pressed={isPinned}
                aria-label={isPinned ? "Unpin row" : "Pin row"}
                title={isPinned ? "Unpin" : "Pin"}
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isPinned
                    ? "text-warning opacity-100"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {isPinned ? (
                  <Pin className="h-3 w-3 fill-current" aria-hidden />
                ) : (
                  <PinOff className="h-3 w-3" aria-hidden />
                )}
              </button>
              {/* Annotate toggle */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  startEditingNote(entry.id, notesMap[entry.id] ?? "");
                }}
                aria-label={hasNote ? "Edit note" : "Add note"}
                title={
                  hasNote
                    ? `Note: ${notesMap[entry.id]}`
                    : "Add an operator note"
                }
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  hasNote
                    ? "text-info opacity-100"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <StickyNote
                  className={cn(
                    "h-3 w-3",
                    hasNote && "fill-current opacity-90",
                  )}
                  aria-hidden
                />
              </button>
            </div>
          </div>
          {/* Diff-mode link — when this entry has a paired sibling on the
              same target (create→delete or update→delete), surface a tiny
              "jump to pair" affordance under the badge so the operator can
              eyeball both events in sequence. */}
          {siblingId && (
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-3xs font-medium text-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(e) => {
                e.stopPropagation();
                jumpToEntry(siblingId);
              }}
              title="Jump to the paired event on the same target"
              aria-label="Jump to the paired event"
            >
              <ChevronsUpDown className="h-3 w-3" aria-hidden />
              pair
            </button>
          )}
        </TableCell>
      </TableRow>
      {/* Always show a slim note bar when a note exists OR the row is being
          annotated. We hide it when the row is in expanded-details mode to
          avoid double-rendering — the note appears inside RowDetails. */}
      {!isExpanded && (hasNote || isEditingNote) && (
        <TableRow
          className="bg-info/5 hover:bg-info/10"
          aria-label="Row note"
        >
          <TableCell colSpan={6} className="px-3 py-1.5">
            <div className="flex items-start gap-2">
              <StickyNote
                className="mt-0.5 h-3 w-3 shrink-0 text-info"
                aria-hidden
              />
              {isEditingNote ? (
                <div className="flex w-full items-center gap-1.5">
                  <Input
                    autoFocus
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveNote(entry.id, draftNote);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEditingNote();
                      }
                    }}
                    placeholder="Operator note (Enter to save, Esc to cancel)"
                    className="h-7 text-xs"
                    aria-label="Operator note"
                  />
                  <Button
                    type="button"
                    variant="default"
                    size="xs"
                    onClick={() => saveNote(entry.id, draftNote)}
                    className="h-7 shrink-0"
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={cancelEditingNote}
                    className="h-7 shrink-0"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <span className="flex-1 text-xs text-foreground/90">
                  {notesMap[entry.id]}
                </span>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
      {isExpanded && (
        <TableRow
          className="bg-muted/20 hover:bg-muted/20"
          aria-label="Row details"
        >
          <TableCell colSpan={6} className="p-0">
            <RowDetails
              entry={entry}
              note={notesMap[entry.id] ?? ""}
              isEditingNote={isEditingNote}
              draftNote={draftNote}
              setDraftNote={setDraftNote}
              startEditingNote={() =>
                startEditingNote(entry.id, notesMap[entry.id] ?? "")
              }
              saveNote={(text) => saveNote(entry.id, text)}
              cancelEditingNote={cancelEditingNote}
            />
          </TableCell>
        </TableRow>
      )}
    </React.Fragment>
  );
}

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
  note: string;
  isEditingNote: boolean;
  draftNote: string;
  setDraftNote: (next: string) => void;
  startEditingNote: () => void;
  saveNote: (text: string) => void;
  cancelEditingNote: () => void;
}

const RowDetails: React.FC<RowDetailsProps> = ({
  entry,
  note,
  isEditingNote,
  draftNote,
  setDraftNote,
  startEditingNote,
  saveNote,
  cancelEditingNote,
}) => {
  const detailsJson = React.useMemo(
    () => (entry.details ? JSON.stringify(entry.details, null, 2) : ""),
    [entry.details],
  );
  // Per-row toggle: pretty/raw JSON. Pretty (default) shows the standard
  // 2-space-indented JSON; raw shows the compact single-line form which
  // is friendlier for grep / paste.
  const [rawJson, setRawJson] = React.useState(false);
  const detailsCompact = React.useMemo(
    () => (entry.details ? JSON.stringify(entry.details) : ""),
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
      {/* Operator note — full editor inside the expanded panel. */}
      <div className="mt-3 rounded-md border border-info/40 bg-info/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-info">
            <StickyNote className="h-3 w-3" aria-hidden />
            Operator note
          </span>
          {!isEditingNote && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startEditingNote();
              }}
              className="rounded px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={note ? "Edit note" : "Add note"}
            >
              {note ? "Edit" : "Add"}
            </button>
          )}
        </div>
        {isEditingNote ? (
          <div className="mt-1.5 flex items-center gap-1.5">
            <Input
              autoFocus
              value={draftNote}
              onChange={(e) => setDraftNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveNote(draftNote);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEditingNote();
                }
              }}
              placeholder="Why does this entry matter?"
              className="h-7 text-xs"
            />
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                saveNote(draftNote);
              }}
              className="h-7 shrink-0"
            >
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                cancelEditingNote();
              }}
              className="h-7 shrink-0"
            >
              Cancel
            </Button>
          </div>
        ) : (
          <p
            className={cn(
              "m-0 mt-1.5 text-xs",
              note ? "text-foreground/90" : "italic text-muted-foreground",
            )}
          >
            {note || "No note. Click Add to attach an operator annotation."}
          </p>
        )}
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
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setRawJson((v) => !v)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  rawJson
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
                aria-pressed={rawJson}
                aria-label={
                  rawJson
                    ? "Show pretty-printed JSON"
                    : "Show raw single-line JSON"
                }
              >
                {rawJson ? "Raw" : "Pretty"}
              </button>
              <CopyButton
                value={rawJson ? detailsCompact : detailsJson}
                alwaysVisible
                iconSize={12}
              />
            </div>
          </div>
          <pre className="m-0 mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
            {rawJson ? detailsCompact : detailsJson}
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
