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
import { Bookmark, BookmarkPlus, CalendarDays, ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, Clock, FileText, Filter, Layers, Pin, PinOff, PlayCircle, RotateCcw, Search, ShieldAlert, SlidersHorizontal, StickyNote, Trash2, Users, X, Zap, } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Pagination, PaginationContent, PaginationFirst, PaginationItem, PaginationLast, PaginationLink, PaginationNext, PaginationPrevious, } from "@/components/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger, } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, } from "@/components/ui/table";
import { MiniBar } from "@/components/ui/charts/gauge";
import { cn, formatDateTime, formatRelativeTime, } from "@/lib/utils";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const GROUP_BY_OPTIONS = [
    { key: "none", label: "None" },
    { key: "actor", label: "Actor" },
    { key: "action", label: "Action" },
    { key: "day", label: "Day" },
];
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
const CRITICAL_AUDIT_TEMPLATES = [
    {
        id: "set-domain-auth",
        label: "Federation change",
        tooltip: "Set domain authentication — new federated domain. A federated domain backdoor survives password resets, MFA resets, and role revocation.",
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
        tooltip: "Update conditional access policy — state change to 'disabled' or new exclusion entries. Common stealth-disable of MFA enforcement.",
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
        tooltip: "Issue temporary access pass — MFA-equivalent pass for any user. Auth Admin role can mint these without re-MFA.",
        severity: "critical",
        matchers: ["issue temporary access pass", "temporary access pass", "tap "],
        cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #3",
    },
    {
        id: "approle-assign",
        label: "App-role assign",
        tooltip: "Add app role assignment to service principal — especially Directory.ReadWrite.All / RoleManagement.ReadWrite.Directory which lead to GA.",
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
        tooltip: "Update application — Certificates and secrets management (addPassword/addKey). Permanent app-only credential injection.",
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
        tooltip: "POST /applications/{id}/federatedIdentityCredentials — workload-identity backdoor; no specific audit name, watch the raw URI.",
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
        tooltip: "POST /roleManagement/directory/roleEligibilityScheduleRequests — PIM eligibility creation. Stealth time-bomb persistence.",
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
        tooltip: "Delete diagnostic setting (Activity Log). Disables log forwarding to Sentinel/SIEM — frequent first step before noisy ops.",
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
        tooltip: "Hard delete user — bypasses the 30-day soft-delete recovery window. Used to scrub attacker-created accounts.",
        severity: "medium",
        matchers: ["hard delete user", "permanently delete user", "users/delete"],
        cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #9",
    },
    {
        id: "cancel-subscription",
        label: "Cancel subscription",
        tooltip: "Cancel subscription Activity Log event. Severs billing/quotas — often follows mass-resource teardown.",
        severity: "medium",
        matchers: [
            "cancel subscription",
            "subscription.*cancel",
            "subscriptions/cancel",
        ],
        cite: "_AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface #10",
    },
];
/** Match a single audit entry against a critical-event template. Substring,
 * case-insensitive, run on `action`+`target` so app-internal action names
 * (e.g. "ca_policy_update") and Graph-style names (e.g. "Update conditional
 * access policy") both fire. We intentionally do NOT regex-compile the
 * matchers since several contain `.` as a literal delimiter (e.g. "ca policy"
 * with embedded spaces) — substring is faster and predictable. */
function matchesCriticalTemplate(entry, template) {
    var _a, _b;
    const hay = `${(_a = entry.action) !== null && _a !== void 0 ? _a : ""} ${(_b = entry.target) !== null && _b !== void 0 ? _b : ""}`.toLowerCase();
    for (const needle of template.matchers) {
        if (!needle)
            continue;
        if (hay.includes(needle.toLowerCase()))
            return true;
    }
    return false;
}
/** Tailwind tone classes per corpus severity. */
const SEVERITY_TONE = {
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
const RANGE_PRESETS = [
    { key: "1h", label: "Last 1h", ms: 60 * 60 * 1000 },
    { key: "1d", label: "Last 1d", ms: 24 * 60 * 60 * 1000 },
    { key: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
    { key: "all", label: "All", ms: Number.POSITIVE_INFINITY },
];
/** Set guard so PAGE_SIZE_OPTIONS narrowing survives JSON round-trip. */
const PAGE_SIZE_SET = new Set(PAGE_SIZE_OPTIONS);
function coercePageSize(raw, fallback = 25) {
    const n = Number(raw);
    return PAGE_SIZE_SET.has(n) ? n : fallback;
}
function makeSavedFilterId() {
    // Prefer crypto.randomUUID when available; fall back to a high-entropy
    // string. This page already references `crypto.randomUUID()` indirectly
    // via the audit-log service, so the API is known-good in this runtime.
    try {
        return crypto.randomUUID();
    }
    catch (_a) {
        return `sf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
}
// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const AuditLogPage = () => {
    var _a, _b, _c, _d;
    // -------- State -----------------------------------------------------------
    const [entries, setEntries] = React.useState(() => auditLog.getEntries());
    // Search + filters
    const [searchText, setSearchText] = React.useState("");
    const [statusFilter, setStatusFilter] = React.useState("all");
    const [actorFilter, setActorFilter] = React.useState(() => new Set());
    const [actionFilter, setActionFilter] = React.useState(() => new Set());
    const [dateRange, setDateRange] = React.useState();
    // Sorting + pagination
    const [sort, setSort] = React.useState({
        key: "timestamp",
        dir: "desc",
    });
    // Page size is persisted so it survives reload; coerce on read since the
    // localStorage value is untrusted JSON.
    const [pageSizeRaw, setPageSizeRaw] = usePersistedState(AUDIT_PAGE_SIZE_KEY, 25, {
        deserialize: (raw) => {
            try {
                return coercePageSize(JSON.parse(raw));
            }
            catch (_a) {
                return 25;
            }
        },
    });
    const pageSize = coercePageSize(pageSizeRaw);
    const [page, setPage] = React.useState(1);
    // Row expansion (one expanded at a time keeps the table compact)
    const [expandedId, setExpandedId] = React.useState(null);
    // Display mode: relative vs. absolute timestamps. Persisted.
    const [relativeTime, setRelativeTime] = usePersistedState(AUDIT_RELATIVE_TIME_KEY, false);
    // Group-by mode. Persisted.
    const [groupBy, setGroupBy] = usePersistedState(AUDIT_GROUP_BY_KEY, "none", {
        deserialize: (raw) => {
            try {
                const v = JSON.parse(raw);
                return v === "actor" || v === "action" || v === "day" || v === "none"
                    ? v
                    : "none";
            }
            catch (_a) {
                return "none";
            }
        },
    });
    // Per-group collapse state. Local (not persisted) because group keys depend
    // on which entries are currently retained.
    const [collapsedGroups, setCollapsedGroups] = React.useState(() => new Set());
    // Tail mode: when on, the table is pinned to page 1 (newest first) and
    // smooth-scrolls the body container to the top on every new arrival.
    // Persisted because operators typically want their preferred mode to
    // survive reloads.
    const [tailMode, setTailMode] = usePersistedState(AUDIT_TAIL_KEY, false);
    // Saved filters — named recall of filter combinations. Defaults to empty
    // array; we coerce any malformed payload back to `[]`.
    const [savedFilters, setSavedFilters] = usePersistedState(AUDIT_SAVED_FILTERS_KEY, [], {
        deserialize: (raw) => {
            try {
                const v = JSON.parse(raw);
                return Array.isArray(v) ? v : [];
            }
            catch (_a) {
                return [];
            }
        },
    });
    const [savedFilterName, setSavedFilterName] = React.useState("");
    const [savedFiltersOpen, setSavedFiltersOpen] = React.useState(false);
    // Corpus-grounded critical-event filter: selected template IDs. When at
    // least one is selected, only entries matching ANY of the selected templates
    // pass the filter (OR across selected templates). Local state — these are
    // ephemeral exploratory filters, not "saved" filters.
    const [activeCritIds, setActiveCritIds] = React.useState(() => new Set());
    // Pinned entry IDs — operator-curated watch-list. Persisted so a pin
    // survives reload (provided the entry survives the 500-entry retention cap).
    const [pinnedIds, setPinnedIds] = usePersistedState(AUDIT_PINNED_KEY, [], {
        deserialize: (raw) => {
            try {
                const v = JSON.parse(raw);
                return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
            }
            catch (_a) {
                return [];
            }
        },
    });
    // Memo a Set for O(1) lookup; rebuilds only when the persisted array
    // reference changes (i.e. on add/remove).
    const pinnedSet = React.useMemo(() => new Set(pinnedIds), [pinnedIds]);
    // Per-entry operator notes — keyed by entry id. Persisted.
    const [notesMap, setNotesMap] = usePersistedState(AUDIT_NOTES_KEY, {}, {
        deserialize: (raw) => {
            try {
                const v = JSON.parse(raw);
                return v && typeof v === "object" && !Array.isArray(v)
                    ? v
                    : {};
            }
            catch (_a) {
                return {};
            }
        },
    });
    // Which entry is currently in note-edit mode. Local (UI only).
    const [editingNoteFor, setEditingNoteFor] = React.useState(null);
    const [draftNote, setDraftNote] = React.useState("");
    // URL-state: time-range preset + selected-template-ids so a deep link
    // shares the operator's lens with collaborators. `range` defaults to "all"
    // (no time clamp) so the page renders the full retained buffer by default.
    // `crit` is a comma-joined template id list — useUrlState handles arrays.
    const [urlState, setUrlState] = useUrlState({ range: "all", crit: [] });
    const rangePreset = React.useMemo(() => {
        const v = urlState.range;
        if (v === "1h" || v === "1d" || v === "7d" || v === "all" || v === "custom")
            return v;
        return "all";
    }, [urlState.range]);
    // Two-way sync URL ↔ activeCritIds set. On mount we hydrate from URL; on
    // local toggle we push back. We diff against the joined-key string to avoid
    // unnecessary URL writes.
    const critUrlKey = React.useMemo(() => urlState.crit.join(","), [urlState.crit]);
    const activeCritKey = React.useMemo(() => Array.from(activeCritIds).sort().join(","), [activeCritIds]);
    // Hydrate on mount (and whenever URL changes externally — e.g. back-button).
    React.useEffect(() => {
        const fromUrl = urlState.crit.filter((id) => CRITICAL_AUDIT_TEMPLATES.some((t) => t.id === id));
        const fromUrlKey = [...fromUrl].sort().join(",");
        if (fromUrlKey !== activeCritKey) {
            setActiveCritIds(new Set(fromUrl));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [critUrlKey]);
    // Push local → URL.
    React.useEffect(() => {
        if (activeCritKey === critUrlKey)
            return;
        setUrlState({ crit: Array.from(activeCritIds) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCritKey]);
    // Keyboard navigation: index of the currently-focused row (within `paged`
    // for the flat view; for grouped view we still treat it as a row-index in
    // the *visible* row sequence, header rows skipped). j/k move; Enter
    // expands the focused row.
    const [focusedRowIdx, setFocusedRowIdx] = React.useState(null);
    // Confirmation dialog
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    // Refs for keyboard shortcut + auto-clear-expanded-on-page-change
    const searchInputRef = React.useRef(null);
    // Ref to the scrollable table container so tail-mode can scroll-to-top
    // without coupling to a global window scroll position.
    const tableScrollRef = React.useRef(null);
    // Wrapper element hosting the ExportMenu; the `e` hotkey finds the
    // inner trigger button via DOM query and synthesizes a click.
    const exportTriggerRef = React.useRef(null);
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
        const refresh = () => {
            if (!active)
                return;
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
    const pagedRef = React.useRef([]);
    const focusedIdxRef = React.useRef(null);
    focusedIdxRef.current = focusedRowIdx;
    // hasEntriesRef is wired to `entries.length` below after the entries
    // memos run; defining it up here means the keydown handler can see the
    // latest value without re-attaching.
    React.useEffect(() => {
        const handler = (event) => {
            var _a, _b, _c, _d, _e, _f, _g;
            if (event.defaultPrevented)
                return;
            const target = event.target;
            const tag = (_a = target === null || target === void 0 ? void 0 : target.tagName) === null || _a === void 0 ? void 0 : _a.toLowerCase();
            const isEditable = tag === "input" ||
                tag === "textarea" ||
                tag === "select" ||
                ((_b = target === null || target === void 0 ? void 0 : target.isContentEditable) !== null && _b !== void 0 ? _b : false);
            // Allow Esc to clear the search even when focused inside the input.
            if (event.key === "Escape" && searchTextRef.current) {
                if (target === searchInputRef.current) {
                    event.preventDefault();
                    setSearchText("");
                }
                return;
            }
            if (isEditable)
                return;
            if (event.metaKey || event.ctrlKey || event.altKey)
                return;
            switch (event.key) {
                case "/":
                case "s": {
                    event.preventDefault();
                    (_c = searchInputRef.current) === null || _c === void 0 ? void 0 : _c.focus();
                    (_d = searchInputRef.current) === null || _d === void 0 ? void 0 : _d.select();
                    return;
                }
                case "c": {
                    if (!hasEntriesRef.current)
                        return;
                    event.preventDefault();
                    setConfirmOpen(true);
                    return;
                }
                case "e": {
                    // ExportMenu's trigger is a Radix DropdownMenuTrigger rendering
                    // a `<button>` — find it inside the wrapper and synthesize a
                    // click. Skip when disabled.
                    const trigger = (_e = exportTriggerRef.current) === null || _e === void 0 ? void 0 : _e.querySelector("button");
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
                    const next = (_g = (_f = GROUP_BY_OPTIONS[(idx + 1) % GROUP_BY_OPTIONS.length]) === null || _f === void 0 ? void 0 : _f.key) !== null && _g !== void 0 ? _g : "none";
                    setGroupBy(next);
                    return;
                }
                // j / k row navigation. Clamps to the visible paged slice; wraps at
                // edges so j-spam stays useful. Down=j, Up=k (vim convention; common
                // in our other paged grids).
                case "j":
                case "ArrowDown": {
                    const rows = pagedRef.current;
                    if (rows.length === 0)
                        return;
                    event.preventDefault();
                    const cur = focusedIdxRef.current;
                    const nextIdx = cur === null ? 0 : Math.min(rows.length - 1, cur + 1);
                    setFocusedRowIdx(nextIdx);
                    return;
                }
                case "k":
                case "ArrowUp": {
                    const rows = pagedRef.current;
                    if (rows.length === 0)
                        return;
                    event.preventDefault();
                    const cur = focusedIdxRef.current;
                    const nextIdx = cur === null ? 0 : Math.max(0, cur - 1);
                    setFocusedRowIdx(nextIdx);
                    return;
                }
                case "Enter": {
                    const rows = pagedRef.current;
                    const cur = focusedIdxRef.current;
                    if (cur === null || rows.length === 0)
                        return;
                    const row = rows[cur];
                    if (!row)
                        return;
                    event.preventDefault();
                    setExpandedId((prev) => (prev === row.id ? null : row.id));
                    return;
                }
                case "p": {
                    // Pin / unpin the focused row.
                    const rows = pagedRef.current;
                    const cur = focusedIdxRef.current;
                    if (cur === null || rows.length === 0)
                        return;
                    const row = rows[cur];
                    if (!row)
                        return;
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
        var _a, _b;
        const actors = new Map();
        const actions = new Map();
        for (const e of entries) {
            actors.set(e.actor, ((_a = actors.get(e.actor)) !== null && _a !== void 0 ? _a : 0) + 1);
            actions.set(e.action, ((_b = actions.get(e.action)) !== null && _b !== void 0 ? _b : 0) + 1);
        }
        const sortByCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
        return {
            allActors: Array.from(actors.entries()).sort(sortByCount),
            allActions: Array.from(actions.entries()).sort(sortByCount),
        };
    }, [entries]);
    // Resolve the active time-clamp range. When a preset other than "all" or
    // "custom" is selected, it wins over the date-range picker (the toolbar
    // intentionally shows the preset's effective window). "custom" leaves
    // the calendar in charge. We compute once per render against `now`.
    const presetRangeMs = React.useMemo(() => {
        if (rangePreset === "custom" || rangePreset === "all")
            return null;
        const preset = RANGE_PRESETS.find((p) => p.key === rangePreset);
        return preset && Number.isFinite(preset.ms) ? preset.ms : null;
    }, [rangePreset]);
    // Search + filter pipeline.
    const filtered = React.useMemo(() => {
        const query = searchText.trim().toLowerCase();
        const activeTemplates = CRITICAL_AUDIT_TEMPLATES.filter((t) => activeCritIds.has(t.id));
        // Preset time-range clamp — when active, supersedes the calendar.
        const presetFromTs = presetRangeMs !== null ? Date.now() - presetRangeMs : null;
        const fromTs = (dateRange === null || dateRange === void 0 ? void 0 : dateRange.from)
            ? new Date(dateRange.from.getFullYear(), dateRange.from.getMonth(), dateRange.from.getDate(), 0, 0, 0, 0).getTime()
            : null;
        // Inclusive end-of-day for `to` — if a single day is picked, range
        // covers 00:00..23:59:59.999 of that day.
        const toTs = (dateRange === null || dateRange === void 0 ? void 0 : dateRange.to)
            ? new Date(dateRange.to.getFullYear(), dateRange.to.getMonth(), dateRange.to.getDate(), 23, 59, 59, 999).getTime()
            : (dateRange === null || dateRange === void 0 ? void 0 : dateRange.from)
                ? new Date(dateRange.from.getFullYear(), dateRange.from.getMonth(), dateRange.from.getDate(), 23, 59, 59, 999).getTime()
                : null;
        return entries.filter((e) => {
            var _a, _b, _c, _d, _e;
            if (statusFilter !== "all" && e.status !== statusFilter)
                return false;
            if (actorFilter.size > 0 && !actorFilter.has(e.actor))
                return false;
            if (actionFilter.size > 0 && !actionFilter.has(e.action))
                return false;
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
                if (!any)
                    return false;
            }
            // Preset range clamp (sliding window). Calendar range is additional.
            if (presetFromTs !== null) {
                const ts = new Date(e.timestamp).getTime();
                if (Number.isNaN(ts) || ts < presetFromTs)
                    return false;
            }
            if (fromTs !== null || toTs !== null) {
                const ts = new Date(e.timestamp).getTime();
                if (Number.isNaN(ts))
                    return false;
                if (fromTs !== null && ts < fromTs)
                    return false;
                if (toTs !== null && ts > toTs)
                    return false;
            }
            if (!query)
                return true;
            const errorText = (_a = e.error) !== null && _a !== void 0 ? _a : "";
            const detailsText = e.details
                ? // Cheap stringification just for substring search; full pretty
                    // version is rendered only when the row is expanded.
                    JSON.stringify(e.details).toLowerCase()
                : "";
            return (((_b = e.actor) !== null && _b !== void 0 ? _b : "").toLowerCase().includes(query) ||
                ((_c = e.action) !== null && _c !== void 0 ? _c : "").toLowerCase().includes(query) ||
                ((_d = e.target) !== null && _d !== void 0 ? _d : "").toLowerCase().includes(query) ||
                ((_e = e.status) !== null && _e !== void 0 ? _e : "").toLowerCase().includes(query) ||
                errorText.toLowerCase().includes(query) ||
                detailsText.includes(query));
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
            var _a, _b;
            if (key === "timestamp") {
                return ((new Date(a.timestamp).getTime() -
                    new Date(b.timestamp).getTime()) *
                    dir);
            }
            const av = ((_a = a[key]) !== null && _a !== void 0 ? _a : "").toString().toLowerCase();
            const bv = ((_b = b[key]) !== null && _b !== void 0 ? _b : "").toString().toLowerCase();
            if (av < bv)
                return -1 * dir;
            if (av > bv)
                return 1 * dir;
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
        if (!expandedId)
            return;
        if (!paged.some((e) => e.id === expandedId)) {
            setExpandedId(null);
        }
    }, [paged, expandedId]);
    // Keep the keydown navigation ref in sync, and clamp the focused row index
    // whenever the visible page slice shrinks (page nav, filter narrowing).
    pagedRef.current = paged;
    React.useEffect(() => {
        if (focusedRowIdx === null)
            return;
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
    const toggleCriticalTemplate = React.useCallback((id) => {
        setActiveCritIds((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    // Pinning — append/remove. Capped at 50 to bound the persisted list.
    const togglePin = React.useCallback((id) => {
        setPinnedIds((prev) => {
            if (prev.includes(id))
                return prev.filter((x) => x !== id);
            const next = [id, ...prev];
            return next.length > 50 ? next.slice(0, 50) : next;
        });
    }, [setPinnedIds]);
    // Notes — LRU-prune over 200 entries on write.
    const saveNote = React.useCallback((id, text) => {
        const trimmed = text.trim();
        setNotesMap((prev) => {
            const next = Object.assign({}, prev);
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
                    delete next[keys[i]];
                }
            }
            return next;
        });
    }, [setNotesMap]);
    const toggleSort = React.useCallback((key) => {
        setSort((prev) => {
            if (prev.key !== key) {
                // First click sorts ascending for text columns; descending for
                // timestamp because newest-first is the natural default.
                return { key, dir: key === "timestamp" ? "desc" : "asc" };
            }
            return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
        });
    }, []);
    const toggleActor = React.useCallback((actor) => {
        setActorFilter((prev) => {
            const next = new Set(prev);
            if (next.has(actor))
                next.delete(actor);
            else
                next.add(actor);
            return next;
        });
    }, []);
    const toggleAction = React.useCallback((action) => {
        setActionFilter((prev) => {
            const next = new Set(prev);
            if (next.has(action))
                next.delete(action);
            else
                next.add(action);
            return next;
        });
    }, []);
    const handleRowToggle = React.useCallback((id) => {
        setExpandedId((prev) => (prev === id ? null : id));
    }, []);
    // Note-edit lifecycle.
    const startEditingNote = React.useCallback((id, current) => {
        setEditingNoteFor(id);
        setDraftNote(current);
        // Also expand the row so the note editor inside RowDetails is visible.
        setExpandedId(id);
    }, []);
    const cancelEditingNote = React.useCallback(() => {
        setEditingNoteFor(null);
        setDraftNote("");
    }, []);
    const saveNoteAndClose = React.useCallback((id, text) => {
        saveNote(id, text);
        setEditingNoteFor(null);
        setDraftNote("");
    }, [saveNote]);
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
    const diffSiblingIdMap = React.useMemo(() => {
        var _a, _b;
        const out = new Map();
        if (paged.length < 2)
            return out;
        const createish = /(create|add|grant|assign|provision|enable|issue)/i;
        const deleteish = /(delete|remove|revoke|disable|cancel|hard.delete)/i;
        // Group by trimmed target. Empty targets don't pair.
        const byTarget = new Map();
        for (const e of paged) {
            const t = ((_a = e.target) !== null && _a !== void 0 ? _a : "").trim().toLowerCase();
            if (!t)
                continue;
            const arr = (_b = byTarget.get(t)) !== null && _b !== void 0 ? _b : [];
            arr.push(e);
            byTarget.set(t, arr);
        }
        for (const [, list] of byTarget) {
            if (list.length < 2)
                continue;
            // Find one create-ish and one delete-ish. If multiple, pick the
            // nearest by timestamp.
            const creates = list.filter((e) => createish.test(e.action));
            const deletes = list.filter((e) => deleteish.test(e.action));
            const pairs = [];
            if (creates.length > 0 && deletes.length > 0) {
                for (const c of creates) {
                    let best = null;
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
                    if (best)
                        pairs.push([c, best]);
                }
            }
            else if (list.length === 2) {
                // No create/delete signal, but a tight pair of two entries on the
                // same target is still worth linking — common for update→update.
                pairs.push([list[0], list[1]]);
            }
            for (const [a, b] of pairs) {
                out.set(a.id, b.id);
                out.set(b.id, a.id);
            }
        }
        return out;
    }, [paged]);
    // O(1) lookup of an entry's index within `paged` for keyboard nav.
    const pagedIndex = React.useMemo(() => {
        const m = new Map();
        for (let i = 0; i < paged.length; i += 1) {
            m.set(paged[i].id, i);
        }
        return m;
    }, [paged]);
    const indexOfPaged = React.useCallback((id) => { var _a; return (_a = pagedIndex.get(id)) !== null && _a !== void 0 ? _a : -1; }, [pagedIndex]);
    // Jump-to-entry: scroll the row into view + briefly flash-highlight it via
    // a `data-jump-flash` attribute the row reads through CSS-like inline
    // styles. We rely on the table-scroller having stable DOM ids per row
    // (`data-entry-id`).
    const jumpToEntry = React.useCallback((id) => {
        const scroller = tableScrollRef.current;
        if (!scroller)
            return;
        const row = scroller.querySelector(`[data-entry-id="${id}"]`);
        if (!row)
            return;
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
    const exportColumns = React.useMemo(() => [
        {
            header: "Timestamp",
            accessor: (e) => formatDateTime(e.timestamp),
        },
        { header: "Actor", accessor: (e) => e.actor },
        { header: "Action", accessor: (e) => e.action },
        { header: "Target", accessor: (e) => e.target },
        { header: "Status", accessor: (e) => e.status },
        { header: "Error", accessor: (e) => { var _a; return (_a = e.error) !== null && _a !== void 0 ? _a : ""; } },
        {
            header: "Details",
            accessor: (e) => (e.details ? JSON.stringify(e.details) : ""),
        },
    ], []);
    // -------- Summary stats & insights -------------------------------------
    const hasEntries = entries.length > 0;
    const hasMatches = sorted.length > 0;
    // Overall success / failure counts across the retained buffer — used by
    // the summary stat row and quick-filter chips.
    const totals = React.useMemo(() => {
        let success = 0;
        let failure = 0;
        for (const e of entries) {
            if (e.status === "success")
                success += 1;
            else
                failure += 1;
        }
        return { success, failure };
    }, [entries]);
    // Active filter count — shown on the "Reset" chip and used to decide
    // whether to surface the reset affordance at all. Memoized to keep a
    // stable identity across renders that don't actually change filter state.
    const activeFilterCount = React.useMemo(() => (searchText.trim() ? 1 : 0) +
        (statusFilter !== "all" ? 1 : 0) +
        (actorFilter.size > 0 ? 1 : 0) +
        (actionFilter.size > 0 ? 1 : 0) +
        ((dateRange === null || dateRange === void 0 ? void 0 : dateRange.from) ? 1 : 0) +
        (activeCritIds.size > 0 ? 1 : 0) +
        (presetRangeMs !== null ? 1 : 0), [
        searchText,
        statusFilter,
        actorFilter,
        actionFilter,
        dateRange,
        activeCritIds,
        presetRangeMs,
    ]);
    // Keep the keydown handler's `hasEntriesRef` in sync without re-attaching.
    hasEntriesRef.current = hasEntries;
    // ---- Insights: entries-per-hour timeline + top actors / top actions ---
    //
    // Off-by-one fix: align buckets to the floor of "now" truncated to the
    // hour. Bucket `0` = `[startHour-23h, startHour-22h)` (oldest), bucket 23
    // = `[startHour, startHour+1h)` (current hour). An entry's `ts` belongs
    // to bucket `floor((ts - startHourMinus23h) / hour)` exactly once.
    const insights = React.useMemo(() => {
        var _a, _b, _c;
        const now = Date.now();
        const currentHourStart = now - (now % (60 * 60 * 1000));
        const windowStart = currentHourStart - 23 * 60 * 60 * 1000;
        const windowEnd = currentHourStart + 60 * 60 * 1000; // exclusive
        const buckets = new Array(24).fill(0);
        let totalIn24h = 0;
        let successCount = 0;
        let failureCount = 0;
        const actorCounts = new Map();
        const actionCounts = new Map();
        for (const entry of entries) {
            const ts = new Date(entry.timestamp).getTime();
            if (!Number.isNaN(ts) && ts >= windowStart && ts < windowEnd) {
                const idx = Math.floor((ts - windowStart) / (60 * 60 * 1000));
                if (idx >= 0 && idx < 24) {
                    buckets[idx] = ((_a = buckets[idx]) !== null && _a !== void 0 ? _a : 0) + 1;
                    totalIn24h += 1;
                    if (entry.status === "success")
                        successCount += 1;
                    else
                        failureCount += 1;
                }
            }
            // Top actors / actions are computed across the full retained log
            // (not just 24h) since the buffer is already capped at 500.
            actorCounts.set(entry.actor, ((_b = actorCounts.get(entry.actor)) !== null && _b !== void 0 ? _b : 0) + 1);
            actionCounts.set(entry.action, ((_c = actionCounts.get(entry.action)) !== null && _c !== void 0 ? _c : 0) + 1);
        }
        const peak = Math.max(...buckets, 1);
        const topActors = Array.from(actorCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([label, value]) => ({ label, value, tone: "info" }));
        const topActions = Array.from(actionCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([label, value]) => ({ label, value, tone: "primary" }));
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
        var _a;
        const presetFromTs = presetRangeMs !== null ? Date.now() - presetRangeMs : null;
        const fromTs = (dateRange === null || dateRange === void 0 ? void 0 : dateRange.from)
            ? new Date(dateRange.from.getFullYear(), dateRange.from.getMonth(), dateRange.from.getDate(), 0, 0, 0, 0).getTime()
            : null;
        const toTs = (dateRange === null || dateRange === void 0 ? void 0 : dateRange.to)
            ? new Date(dateRange.to.getFullYear(), dateRange.to.getMonth(), dateRange.to.getDate(), 23, 59, 59, 999).getTime()
            : (dateRange === null || dateRange === void 0 ? void 0 : dateRange.from)
                ? new Date(dateRange.from.getFullYear(), dateRange.from.getMonth(), dateRange.from.getDate(), 23, 59, 59, 999).getTime()
                : null;
        const inWindow = entries.filter((e) => {
            const ts = new Date(e.timestamp).getTime();
            if (Number.isNaN(ts))
                return false;
            if (presetFromTs !== null && ts < presetFromTs)
                return false;
            if (fromTs !== null && ts < fromTs)
                return false;
            if (toTs !== null && ts > toTs)
                return false;
            return true;
        });
        const counts = {};
        for (const t of CRITICAL_AUDIT_TEMPLATES) {
            counts[t.id] = 0;
        }
        for (const entry of inWindow) {
            for (const t of CRITICAL_AUDIT_TEMPLATES) {
                if (matchesCriticalTemplate(entry, t)) {
                    counts[t.id] = ((_a = counts[t.id]) !== null && _a !== void 0 ? _a : 0) + 1;
                }
            }
        }
        const observed = CRITICAL_AUDIT_TEMPLATES.filter((t) => { var _a; return ((_a = counts[t.id]) !== null && _a !== void 0 ? _a : 0) > 0; }).length;
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
            return { buckets: [], peak: 0, granularity: "minute" };
        }
        let minTs = Infinity;
        let maxTs = -Infinity;
        for (const e of sorted) {
            const ts = new Date(e.timestamp).getTime();
            if (Number.isNaN(ts))
                continue;
            if (ts < minTs)
                minTs = ts;
            if (ts > maxTs)
                maxTs = ts;
        }
        if (!Number.isFinite(minTs)) {
            return { buckets: [], peak: 0, granularity: "minute" };
        }
        const spanMs = Math.max(maxTs - minTs, 60000);
        const granularity = spanMs > 240 * 60000 ? "hour" : "minute";
        const bucketMs = granularity === "hour" ? 60 * 60000 : 60000;
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
        const buckets = [];
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
            if (Number.isNaN(ts))
                continue;
            const idx = Math.min(buckets.length - 1, Math.max(0, Math.floor((ts - start) / effectiveBucketMs)));
            const b = buckets[idx];
            if (!b)
                continue;
            if (e.status === "success")
                b.s += 1;
            else
                b.f += 1;
            if (b.s + b.f > peak)
                peak = b.s + b.f;
        }
        return { buckets, peak, granularity };
    }, [sorted]);
    // Date range available in the log (used to bound the calendar picker).
    const dateBounds = React.useMemo(() => {
        if (entries.length === 0)
            return null;
        let min = Infinity;
        let max = -Infinity;
        for (const e of entries) {
            const ts = new Date(e.timestamp).getTime();
            if (Number.isNaN(ts))
                continue;
            if (ts < min)
                min = ts;
            if (ts > max)
                max = ts;
        }
        if (!Number.isFinite(min))
            return null;
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
        if (groupBy === "none")
            return null;
        const out = [];
        const seen = new Map(); // key → index in `out`
        const labelFor = (entry) => {
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
            }
            else {
                out[idx].rows.push(entry);
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
            if (collapsedGroups.size > 0)
                setCollapsedGroups(new Set());
            return;
        }
        const validKeys = new Set(groups.map((g) => g.key));
        let mutated = false;
        const next = new Set();
        for (const id of collapsedGroups) {
            if (validKeys.has(id))
                next.add(id);
            else
                mutated = true;
        }
        if (mutated)
            setCollapsedGroups(next);
        // We deliberately depend on `groupBy` rather than `groups` because the
        // `groups` identity changes on every entries update — we only need to
        // re-prune when the *mode* changes or the *set of keys* changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupBy, groups === null || groups === void 0 ? void 0 : groups.map((g) => g.key).join("|")]);
    const toggleGroupCollapsed = React.useCallback((key) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(key))
                next.delete(key);
            else
                next.add(key);
            return next;
        });
    }, []);
    const collapseAllGroups = React.useCallback(() => {
        if (!groups)
            return;
        setCollapsedGroups(new Set(groups.map((g) => g.key)));
    }, [groups]);
    const expandAllGroups = React.useCallback(() => {
        setCollapsedGroups(new Set());
    }, []);
    // -------- Saved filters --------------------------------------------------
    /** Apply a saved filter payload to the live filter state. */
    const applySavedFilter = React.useCallback((sf) => {
        var _a;
        setSearchText(sf.searchText);
        setStatusFilter(sf.statusFilter);
        setActorFilter(new Set(sf.actorFilter));
        setActionFilter(new Set(sf.actionFilter));
        if ((_a = sf.dateRange) === null || _a === void 0 ? void 0 : _a.from) {
            const from = new Date(sf.dateRange.from);
            const to = sf.dateRange.to ? new Date(sf.dateRange.to) : undefined;
            if (Number.isNaN(from.getTime())) {
                setDateRange(undefined);
            }
            else {
                setDateRange({
                    from,
                    to: to && !Number.isNaN(to.getTime()) ? to : undefined,
                });
            }
        }
        else {
            setDateRange(undefined);
        }
        setSavedFiltersOpen(false);
    }, []);
    const captureCurrentFilter = React.useCallback(() => {
        var _a;
        return ({
            searchText,
            statusFilter,
            actorFilter: Array.from(actorFilter),
            actionFilter: Array.from(actionFilter),
            dateRange: (dateRange === null || dateRange === void 0 ? void 0 : dateRange.from)
                ? {
                    from: dateRange.from.toISOString(),
                    to: ((_a = dateRange.to) !== null && _a !== void 0 ? _a : dateRange.from).toISOString(),
                }
                : undefined,
        });
    }, [searchText, statusFilter, actorFilter, actionFilter, dateRange]);
    const handleSaveFilter = React.useCallback(() => {
        const trimmed = savedFilterName.trim();
        if (!trimmed)
            return;
        if (activeFilterCount === 0)
            return; // No-op: nothing to save.
        setSavedFilters((prev) => {
            var _a, _b;
            // Replace by name if it already exists, else append.
            const payload = Object.assign({ id: (_b = (_a = prev.find((f) => f.name === trimmed)) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : makeSavedFilterId(), name: trimmed, savedAt: new Date().toISOString() }, captureCurrentFilter());
            const filtered = prev.filter((f) => f.name !== trimmed);
            // Cap at 20 saved filters so localStorage stays bounded.
            return [payload, ...filtered].slice(0, 20);
        });
        setSavedFilterName("");
    }, [savedFilterName, activeFilterCount, captureCurrentFilter, setSavedFilters]);
    const handleDeleteSavedFilter = React.useCallback((id) => {
        setSavedFilters((prev) => prev.filter((f) => f.id !== id));
    }, [setSavedFilters]);
    // -------- Render -------------------------------------------------------
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
        React.createElement("span", { className: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" }, `${sorted.length} of ${entries.length} audit entries match the current filters; showing page ${currentPage} of ${totalPages}.`),
        React.createElement(PageHeader, { title: "Audit Log", description: "Session history of destructive actions and login events." },
            React.createElement("div", { className: "relative flex items-center" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { ref: searchInputRef, type: "search", placeholder: "Search entries...", value: searchText, onChange: (e) => setSearchText(e.target.value), className: "h-8 w-64 pl-7 pr-14", "aria-label": "Search audit entries" }),
                React.createElement(Kbd, { className: "pointer-events-none absolute right-2", "aria-hidden": true }, "/")),
            React.createElement(InfoTooltip, { content: React.createElement("div", { className: "space-y-1.5" },
                    React.createElement("p", { className: "m-0 text-xs leading-relaxed" }, "Searches across Actor, Action, Target, Status, Error, and Details (JSON-serialized) fields. Case-insensitive substring match."),
                    React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
                        "Press ",
                        React.createElement(Kbd, null, "/"),
                        " from anywhere on this page to focus the search box, and ",
                        React.createElement(Kbd, null, "Esc"),
                        " while focused to clear it."),
                    React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
                        "Row navigation: ",
                        React.createElement(Kbd, null, "j"),
                        " / ",
                        React.createElement(Kbd, null, "k"),
                        " (or arrow keys) to move, ",
                        React.createElement(Kbd, null, "Enter"),
                        " to expand the focused row,",
                        " ",
                        React.createElement(Kbd, null, "p"),
                        " to pin it. ",
                        React.createElement(Kbd, null, "t"),
                        " tail \u00B7 ",
                        React.createElement(Kbd, null, "g"),
                        " ",
                        "group \u00B7 ",
                        React.createElement(Kbd, null, "c"),
                        " clear \u00B7 ",
                        React.createElement(Kbd, null, "e"),
                        " export.")), ariaLabel: "Search field help" }),
            React.createElement("span", { ref: exportTriggerRef, "data-hotkey-host": "audit-log-export", className: "inline-flex" },
                React.createElement(ExportMenu, { rows: sorted, columns: exportColumns, filename: "audit-log", jsonMetadata: {
                        source: "AzureBatchManager.AuditLog",
                        statusFilter,
                        actorFilter: Array.from(actorFilter),
                        actionFilter: Array.from(actionFilter),
                        dateRange: (dateRange === null || dateRange === void 0 ? void 0 : dateRange.from)
                            ? {
                                from: dateRange.from.toISOString(),
                                to: ((_a = dateRange.to) !== null && _a !== void 0 ? _a : dateRange.from).toISOString(),
                            }
                            : undefined,
                        searchQuery: searchText || undefined,
                        sort,
                        groupBy,
                    }, disabled: !hasMatches })),
            React.createElement(Button, { variant: "outline", size: "sm", onClick: handleRequestClear, disabled: !hasEntries, className: cn("gap-1.5 border-destructive/60 text-destructive hover:bg-destructive/10"), "aria-label": "Clear all audit log entries" },
                React.createElement(Trash2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Clear Log")),
        hasEntries && (React.createElement("div", { className: "flex flex-wrap items-center gap-3" },
            React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Audit log summary statistics" },
                React.createElement(SummaryStatItem, { label: "Total", value: entries.length, compact: true }),
                React.createElement(SummaryStatItem, { label: "Success", value: totals.success, tone: "success", compact: true }),
                React.createElement(SummaryStatItem, { label: "Failed", value: totals.failure, tone: "destructive", compact: true }),
                React.createElement(SummaryStatItem, { label: "Last 24h", value: insights.totalIn24h, tone: "info", compact: true }),
                activeFilterCount > 0 && (React.createElement(SummaryStatItem, { label: "Matching", value: sorted.length, tone: "warning", compact: true, hint: sorted.length === entries.length
                        ? undefined
                        : `of ${entries.length}` }))),
            React.createElement("div", { className: "ml-auto flex items-center gap-1 rounded-md border border-border bg-card p-0.5", role: "group", "aria-label": "Filter by status" }, [
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
            ].map((chip) => (React.createElement("button", { key: chip.key, type: "button", onClick: () => setStatusFilter(chip.key), "aria-pressed": statusFilter === chip.key, className: cn("rounded-sm px-2 py-1 text-2xs font-medium uppercase tracking-wider transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", statusFilter === chip.key
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground") },
                chip.label,
                React.createElement("span", { className: "ml-1 tabular-nums opacity-70" }, chip.count))))))),
        hasEntries && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2", role: "group", "aria-label": "Critical defender audit events (corpus-grounded)" },
            React.createElement(ShieldAlert, { className: "ml-1 h-3.5 w-3.5 text-destructive", "aria-hidden": true }),
            React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-destructive" }, "Critical events"),
            React.createElement(InfoTooltip, { content: React.createElement("div", { className: "space-y-1.5" },
                    React.createElement("p", { className: "m-0 text-xs font-semibold" }, "Critical Defender Audit Surface"),
                    React.createElement("p", { className: "m-0 text-xs leading-relaxed" }, "Pre-canned filters for the 10 highest-value detection events any defensive program should alert on. Click to toggle; multiple chips OR together."),
                    React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
                        "Source: ",
                        React.createElement("code", null, "_AZURE_BYPASS_PLAYBOOK.md"),
                        " \u00A7Critical Defender Audit Surface.")), ariaLabel: "Critical events help" }),
            CRITICAL_AUDIT_TEMPLATES.map((tpl) => {
                var _a;
                const active = activeCritIds.has(tpl.id);
                const count = (_a = coverage.counts[tpl.id]) !== null && _a !== void 0 ? _a : 0;
                const tone = SEVERITY_TONE[tpl.severity];
                return (React.createElement("button", { key: tpl.id, type: "button", onClick: () => toggleCriticalTemplate(tpl.id), "aria-pressed": active, title: `${tpl.tooltip}\n\n${tpl.cite}`, className: cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none", active ? tone.active : tone.idle, tone.ring, count === 0 && !active && "opacity-60") },
                    React.createElement("span", { className: cn("h-1.5 w-1.5 rounded-full", tone.dot), "aria-hidden": true }),
                    React.createElement("span", null, tpl.label),
                    React.createElement("span", { className: cn("rounded-sm bg-background/60 px-1 text-3xs tabular-nums", count === 0 && "opacity-40"), "aria-label": `${count} matching event${count === 1 ? "" : "s"} in window` }, count)));
            }),
            activeCritIds.size > 0 && (React.createElement("button", { type: "button", className: "ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-2xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", onClick: () => setActiveCritIds(new Set()), "aria-label": "Clear critical-event filter" },
                React.createElement(X, { className: "h-3 w-3", "aria-hidden": true }),
                "Clear")))),
        hasEntries && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 p-2", role: "group", "aria-label": "Time range" },
            React.createElement(Clock, { className: "ml-1 h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
            React.createElement("span", { className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, "Range"),
            RANGE_PRESETS.map((preset) => {
                const active = rangePreset === preset.key;
                return (React.createElement(Button, { key: preset.key, type: "button", variant: active ? "default" : "outline", size: "xs", onClick: () => {
                        setUrlState({ range: preset.key });
                        // Clear the calendar range so the preset is unambiguously
                        // in charge of the time window.
                        setDateRange(undefined);
                    }, "aria-pressed": active, className: "h-7" }, preset.label));
            }),
            React.createElement(Button, { type: "button", variant: rangePreset === "custom" ? "default" : "outline", size: "xs", onClick: () => setUrlState({ range: "custom" }), "aria-pressed": rangePreset === "custom", className: "h-7", title: "Pick a custom range with the calendar below" }, "Custom"),
            React.createElement(InfoTooltip, { content: "Shareable via URL \u2014 copy the page link to share your time window with a collaborator.", ariaLabel: "Range help" }))),
        hasEntries && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/50 p-2", role: "group", "aria-label": "Audit log filters" },
            React.createElement(SlidersHorizontal, { className: "ml-1 h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
            React.createElement("span", { className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, "Filters"),
            React.createElement(DropdownMenu, null,
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { variant: "outline", size: "sm", className: cn("h-7 gap-1.5", actorFilter.size > 0 && "border-primary/60 text-primary"), "aria-label": actorFilter.size > 0
                            ? `Actor filter (${actorFilter.size} selected)`
                            : "Filter by actor" },
                        React.createElement(Users, { className: "h-3 w-3", "aria-hidden": true }),
                        "Actor",
                        actorFilter.size > 0 && (React.createElement(Badge, { variant: "default", className: "ml-0.5 h-4 min-w-4 px-1 text-3xs tabular-nums" }, actorFilter.size)),
                        React.createElement(ChevronDown, { className: "h-3 w-3 opacity-60", "aria-hidden": true }))),
                React.createElement(DropdownMenuContent, { align: "start", className: "max-h-72 w-64 overflow-y-auto" },
                    React.createElement(DropdownMenuLabel, { className: "flex items-center justify-between" },
                        React.createElement("span", null, "Filter by actor"),
                        actorFilter.size > 0 && (React.createElement("button", { type: "button", className: "text-2xs font-medium text-primary hover:underline", onClick: () => setActorFilter(new Set()) }, "Clear"))),
                    React.createElement(DropdownMenuSeparator, null),
                    allActors.length === 0 ? (React.createElement("p", { className: "px-2 py-3 text-center text-xs text-muted-foreground" }, "No actors yet.")) : (allActors.map(([actor, count]) => (React.createElement(DropdownMenuCheckboxItem, { key: actor, checked: actorFilter.has(actor), onSelect: (e) => e.preventDefault(), onCheckedChange: () => toggleActor(actor) },
                        React.createElement("span", { className: "flex w-full items-center justify-between gap-2" },
                            React.createElement("span", { className: "truncate", title: actor }, actor),
                            React.createElement("span", { className: "shrink-0 tabular-nums text-2xs text-muted-foreground" }, count)))))))),
            React.createElement(DropdownMenu, null,
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { variant: "outline", size: "sm", className: cn("h-7 gap-1.5", actionFilter.size > 0 && "border-primary/60 text-primary"), "aria-label": actionFilter.size > 0
                            ? `Action filter (${actionFilter.size} selected)`
                            : "Filter by action" },
                        React.createElement(Zap, { className: "h-3 w-3", "aria-hidden": true }),
                        "Action",
                        actionFilter.size > 0 && (React.createElement(Badge, { variant: "default", className: "ml-0.5 h-4 min-w-4 px-1 text-3xs tabular-nums" }, actionFilter.size)),
                        React.createElement(ChevronDown, { className: "h-3 w-3 opacity-60", "aria-hidden": true }))),
                React.createElement(DropdownMenuContent, { align: "start", className: "max-h-72 w-64 overflow-y-auto" },
                    React.createElement(DropdownMenuLabel, { className: "flex items-center justify-between" },
                        React.createElement("span", null, "Filter by action"),
                        actionFilter.size > 0 && (React.createElement("button", { type: "button", className: "text-2xs font-medium text-primary hover:underline", onClick: () => setActionFilter(new Set()) }, "Clear"))),
                    React.createElement(DropdownMenuSeparator, null),
                    allActions.length === 0 ? (React.createElement("p", { className: "px-2 py-3 text-center text-xs text-muted-foreground" }, "No actions yet.")) : (allActions.map(([action, count]) => (React.createElement(DropdownMenuCheckboxItem, { key: action, checked: actionFilter.has(action), onSelect: (e) => e.preventDefault(), onCheckedChange: () => toggleAction(action) },
                        React.createElement("span", { className: "flex w-full items-center justify-between gap-2" },
                            React.createElement("span", { className: "truncate font-mono text-xs", title: action }, action),
                            React.createElement("span", { className: "shrink-0 tabular-nums text-2xs text-muted-foreground" }, count)))))))),
            React.createElement(Popover, null,
                React.createElement(PopoverTrigger, { asChild: true },
                    React.createElement(Button, { variant: "outline", size: "sm", className: cn("h-7 gap-1.5", (dateRange === null || dateRange === void 0 ? void 0 : dateRange.from) && "border-primary/60 text-primary"), "aria-label": "Filter by date range" },
                        React.createElement(CalendarDays, { className: "h-3 w-3", "aria-hidden": true }),
                        (dateRange === null || dateRange === void 0 ? void 0 : dateRange.from) ? (React.createElement("span", { className: "tabular-nums" },
                            dateRange.from.toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                            }),
                            dateRange.to &&
                                dateRange.to.toDateString() !==
                                    dateRange.from.toDateString()
                                ? ` – ${dateRange.to.toLocaleDateString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                })}`
                                : "")) : (React.createElement("span", null, "Date range")),
                        React.createElement(ChevronDown, { className: "h-3 w-3 opacity-60", "aria-hidden": true }))),
                React.createElement(PopoverContent, { align: "start", className: "w-auto p-0" },
                    React.createElement("div", { className: "flex flex-col gap-2 p-3" },
                        React.createElement("div", { className: "flex items-center justify-between" },
                            React.createElement("span", { className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, "Pick a range"),
                            (dateRange === null || dateRange === void 0 ? void 0 : dateRange.from) && (React.createElement("button", { type: "button", className: "text-2xs font-medium text-primary hover:underline", onClick: () => setDateRange(undefined) }, "Clear"))),
                        React.createElement(Calendar, { mode: "range", selected: dateRange, onSelect: setDateRange, numberOfMonths: 1, defaultMonth: (_b = dateRange === null || dateRange === void 0 ? void 0 : dateRange.from) !== null && _b !== void 0 ? _b : dateBounds === null || dateBounds === void 0 ? void 0 : dateBounds.max, disabled: dateBounds
                                ? [
                                    { before: dateBounds.min },
                                    { after: new Date() },
                                ]
                                : { after: new Date() } }),
                        React.createElement("div", { className: "flex flex-wrap gap-1.5 border-t border-border pt-2" }, [
                            { label: "Today", days: 0 },
                            { label: "Last 24h", days: 1 },
                            { label: "Last 7 days", days: 7 },
                            { label: "Last 30 days", days: 30 },
                        ].map((preset) => (React.createElement(Button, { key: preset.label, type: "button", variant: "outline", size: "xs", onClick: () => {
                                const now = new Date();
                                const from = new Date(now);
                                from.setDate(from.getDate() - preset.days);
                                setDateRange({ from, to: now });
                            } }, preset.label))))))),
            React.createElement(Button, { variant: "outline", size: "sm", onClick: () => setRelativeTime((v) => !v), className: cn("h-7 gap-1.5", relativeTime && "border-primary/60 text-primary"), "aria-pressed": relativeTime, "aria-label": relativeTime
                    ? "Switch to absolute timestamps"
                    : "Switch to relative timestamps" },
                React.createElement(Clock, { className: "h-3 w-3", "aria-hidden": true }),
                relativeTime ? "Relative" : "Absolute"),
            React.createElement(DropdownMenu, null,
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { variant: "outline", size: "sm", className: cn("h-7 gap-1.5", groupBy !== "none" && "border-primary/60 text-primary"), "aria-label": `Group by: ${groupBy}. Press G to cycle.` },
                        React.createElement(Layers, { className: "h-3 w-3", "aria-hidden": true }),
                        React.createElement("span", null,
                            "Group:",
                            " ",
                            React.createElement("span", { className: "font-semibold capitalize" }, groupBy)),
                        React.createElement(ChevronDown, { className: "h-3 w-3 opacity-60", "aria-hidden": true }))),
                React.createElement(DropdownMenuContent, { align: "start", className: "w-48" },
                    React.createElement(DropdownMenuLabel, { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Group by"),
                    React.createElement(DropdownMenuSeparator, null),
                    GROUP_BY_OPTIONS.map((opt) => (React.createElement(DropdownMenuCheckboxItem, { key: opt.key, checked: groupBy === opt.key, onSelect: (e) => e.preventDefault(), onCheckedChange: () => setGroupBy(opt.key) }, opt.label))),
                    groupBy !== "none" && (React.createElement(React.Fragment, null,
                        React.createElement(DropdownMenuSeparator, null),
                        React.createElement(DropdownMenuItem, { onSelect: () => collapseAllGroups() }, "Collapse all"),
                        React.createElement(DropdownMenuItem, { onSelect: () => expandAllGroups() }, "Expand all"))))),
            React.createElement(Button, { variant: "outline", size: "sm", onClick: () => setTailMode((v) => !v), className: cn("h-7 gap-1.5", tailMode && "border-primary/60 text-primary"), "aria-pressed": tailMode, "aria-label": tailMode
                    ? "Disable tail mode (auto-scroll to newest)"
                    : "Enable tail mode (auto-scroll to newest)", title: "Press T to toggle tail mode" },
                React.createElement(PlayCircle, { className: "h-3 w-3", "aria-hidden": true }),
                "Tail"),
            React.createElement(DropdownMenu, { open: savedFiltersOpen, onOpenChange: setSavedFiltersOpen },
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { variant: "outline", size: "sm", className: cn("h-7 gap-1.5", savedFilters.length > 0 && "border-primary/40"), "aria-label": `Saved filters (${savedFilters.length})` },
                        React.createElement(Bookmark, { className: "h-3 w-3", "aria-hidden": true }),
                        "Saved",
                        savedFilters.length > 0 && (React.createElement(Badge, { variant: "outline", className: "ml-0.5 h-4 min-w-4 px-1 text-3xs tabular-nums" }, savedFilters.length)),
                        React.createElement(ChevronDown, { className: "h-3 w-3 opacity-60", "aria-hidden": true }))),
                React.createElement(DropdownMenuContent, { align: "start", className: "w-72", onCloseAutoFocus: (e) => e.preventDefault() },
                    React.createElement(DropdownMenuLabel, { className: "flex items-center justify-between" },
                        React.createElement("span", null, "Saved filters"),
                        React.createElement("span", { className: "text-3xs text-muted-foreground tabular-nums" },
                            savedFilters.length,
                            "/20")),
                    React.createElement(DropdownMenuSeparator, null),
                    savedFilters.length === 0 ? (React.createElement("p", { className: "px-2 py-3 text-center text-xs text-muted-foreground" }, "No saved filters yet. Configure filters above, then save them below.")) : (React.createElement("div", { className: "max-h-48 overflow-y-auto", role: "listbox", "aria-label": "Saved filters" }, savedFilters.map((sf) => {
                        var _a;
                        return (React.createElement("div", { key: sf.id, className: "group flex items-center gap-1 px-1 py-0.5" },
                            React.createElement("button", { type: "button", className: "flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", onClick: () => applySavedFilter(sf), title: `Saved ${new Date(sf.savedAt).toLocaleString()}` },
                                React.createElement("span", { className: "block truncate font-medium" }, sf.name),
                                React.createElement("span", { className: "block truncate text-3xs text-muted-foreground" }, [
                                    sf.searchText && `"${sf.searchText}"`,
                                    sf.statusFilter !== "all" && sf.statusFilter,
                                    sf.actorFilter.length > 0 &&
                                        `${sf.actorFilter.length} actor${sf.actorFilter.length === 1 ? "" : "s"}`,
                                    sf.actionFilter.length > 0 &&
                                        `${sf.actionFilter.length} action${sf.actionFilter.length === 1 ? "" : "s"}`,
                                    ((_a = sf.dateRange) === null || _a === void 0 ? void 0 : _a.from) && "date range",
                                ]
                                    .filter(Boolean)
                                    .join(" · ") || "no filters")),
                            React.createElement("button", { type: "button", onClick: (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleDeleteSavedFilter(sf.id);
                                }, "aria-label": `Delete saved filter ${sf.name}`, className: "inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100" },
                                React.createElement(X, { className: "h-3 w-3", "aria-hidden": true }))));
                    }))),
                    React.createElement(DropdownMenuSeparator, null),
                    React.createElement("div", { className: "flex items-center gap-1 px-2 py-1.5" },
                        React.createElement(Input, { value: savedFilterName, onChange: (e) => setSavedFilterName(e.target.value), onKeyDown: (e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    handleSaveFilter();
                                }
                            }, placeholder: "Filter name...", className: "h-7 text-xs", "aria-label": "Saved filter name", disabled: activeFilterCount === 0 }),
                        React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: handleSaveFilter, disabled: activeFilterCount === 0 || !savedFilterName.trim(), className: "h-7 shrink-0 gap-1 px-2 text-xs", "aria-label": "Save current filter" },
                            React.createElement(BookmarkPlus, { className: "h-3 w-3", "aria-hidden": true }),
                            "Save")),
                    activeFilterCount === 0 && (React.createElement("p", { className: "px-2 pb-2 text-3xs text-muted-foreground" }, "Configure at least one filter to save.")))),
            activeFilterCount > 0 && (React.createElement(Button, { variant: "ghost", size: "sm", onClick: handleResetFilters, className: "ml-auto h-7 gap-1.5 text-muted-foreground hover:text-foreground", "aria-label": "Reset all filters" },
                React.createElement(RotateCcw, { className: "h-3 w-3", "aria-hidden": true }),
                "Reset",
                React.createElement(Badge, { variant: "outline", className: "ml-0.5 tabular-nums" }, activeFilterCount))))),
        hasEntries && (React.createElement("section", { role: "region", "aria-label": "Audit log insights", className: "grid grid-cols-1 gap-3 lg:grid-cols-3" },
            React.createElement("div", { className: "rounded-md border border-border bg-card p-4 lg:col-span-1" },
                React.createElement("div", { className: "flex items-baseline justify-between gap-2" },
                    React.createElement("h3", { className: "m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Last 24 hours"),
                    React.createElement("span", { className: "text-2xs text-muted-foreground tabular-nums" },
                        React.createElement("strong", { className: "text-foreground" }, insights.totalIn24h),
                        " ",
                        "event",
                        insights.totalIn24h === 1 ? "" : "s")),
                React.createElement("div", { className: "mt-3 flex h-16 items-end gap-px", role: "img", "aria-label": `Audit events per hour over the last 24 hours; peak ${insights.peak}` }, insights.buckets.map((count, hourIdx) => {
                    const heightPct = insights.peak > 0 ? (count / insights.peak) * 100 : 0;
                    const tone = count === 0
                        ? "bg-muted/40"
                        : count >= insights.peak * 0.66
                            ? "bg-primary"
                            : count >= insights.peak * 0.33
                                ? "bg-info"
                                : "bg-info/60";
                    const hoursAgo = 23 - hourIdx;
                    // Hour-aligned bucket label, computed off `currentHourStart`
                    // so the tooltip matches the binning logic.
                    const bucketStart = new Date(insights.currentHourStart - hoursAgo * 60 * 60 * 1000);
                    const bucketLabel = bucketStart.toLocaleString(undefined, {
                        hour: "numeric",
                        hour12: false,
                    });
                    return (React.createElement("span", { key: hourIdx, className: cn("flex-1 rounded-sm", tone), style: {
                            height: `${Math.max(heightPct, count > 0 ? 8 : 4)}%`,
                        }, title: count === 0
                            ? `${bucketLabel}:00 (${hoursAgo}h ago): no events`
                            : `${bucketLabel}:00 (${hoursAgo}h ago): ${count} event${count === 1 ? "" : "s"}` }));
                })),
                React.createElement("div", { className: "mt-1.5 flex justify-between text-3xs text-muted-foreground" },
                    React.createElement("span", null, "24h ago"),
                    React.createElement("span", null, "now")),
                React.createElement("div", { className: "mt-3 flex flex-wrap gap-3 text-2xs text-muted-foreground tabular-nums" },
                    React.createElement("span", null,
                        React.createElement("span", { className: "mr-1 inline-block h-2 w-2 rounded-sm bg-success", "aria-hidden": "true" }),
                        React.createElement("strong", { className: "text-foreground" }, insights.successCount),
                        " ",
                        "success"),
                    React.createElement("span", null,
                        React.createElement("span", { className: "mr-1 inline-block h-2 w-2 rounded-sm bg-destructive", "aria-hidden": "true" }),
                        React.createElement("strong", { className: "text-foreground" }, insights.failureCount),
                        " ",
                        "failed"))),
            React.createElement("div", { className: "rounded-md border border-border bg-card p-4" },
                React.createElement("h3", { className: "m-0 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                    "Top actors",
                    React.createElement(InfoTooltip, { content: "Click an actor to filter the table to entries from that user.", ariaLabel: "Top actors help" })),
                insights.topActors.length === 0 ? (React.createElement("p", { className: "mt-2 text-2xs text-muted-foreground" }, "No actor activity yet.")) : (React.createElement(MiniBar, { items: insights.topActors, ariaLabel: "Top actors by event count", className: "mt-2" }))),
            React.createElement("div", { className: "rounded-md border border-border bg-card p-4" },
                React.createElement("h3", { className: "m-0 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                    "Top actions",
                    React.createElement(InfoTooltip, { content: "Click an action to filter the table to entries matching that action.", ariaLabel: "Top actions help" })),
                insights.topActions.length === 0 ? (React.createElement("p", { className: "mt-2 text-2xs text-muted-foreground" }, "No action activity yet.")) : (React.createElement(MiniBar, { items: insights.topActions, ariaLabel: "Top actions by event count", className: "mt-2" }))))),
        hasEntries && (React.createElement("section", { role: "region", "aria-label": "Detection coverage of critical audit events", className: "rounded-md border border-border bg-card p-4" },
            React.createElement("div", { className: "mb-3 flex items-center justify-between gap-2" },
                React.createElement("h3", { className: "m-0 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                    React.createElement(ShieldAlert, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    "Detection coverage",
                    React.createElement(InfoTooltip, { content: React.createElement("div", { className: "space-y-1.5" },
                            React.createElement("p", { className: "m-0 text-xs" }, "Self-assessment: which of the 10 critical-event classes from the corpus playbook have been observed in the visible time window. Tiles with zero hits may indicate normal silence OR a coverage gap in upstream logging."),
                            React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" },
                                "Source: ",
                                React.createElement("code", null, "_AZURE_BYPASS_PLAYBOOK.md"),
                                " \u00A7Critical Defender Audit Surface (10 events).")), ariaLabel: "Detection coverage help" })),
                React.createElement("span", { className: "rounded-md border border-border bg-surface-sunken px-2 py-1 text-2xs tabular-nums text-muted-foreground", "aria-label": `${coverage.observed} of ${coverage.total} event classes observed in window` },
                    React.createElement("strong", { className: "text-foreground" }, coverage.observed),
                    " / ",
                    coverage.total,
                    " classes observed",
                    React.createElement("span", { className: "ml-2 text-3xs" },
                        "(",
                        coverage.inWindow.length,
                        " event",
                        coverage.inWindow.length === 1 ? "" : "s",
                        " in window)"))),
            React.createElement("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" }, CRITICAL_AUDIT_TEMPLATES.map((tpl) => {
                var _a;
                const count = (_a = coverage.counts[tpl.id]) !== null && _a !== void 0 ? _a : 0;
                const observed = count > 0;
                const tone = SEVERITY_TONE[tpl.severity];
                const active = activeCritIds.has(tpl.id);
                return (React.createElement("button", { key: tpl.id, type: "button", onClick: () => toggleCriticalTemplate(tpl.id), "aria-pressed": active, title: `${tpl.tooltip}\n\n${tpl.cite}\n\n${observed ? `${count} matching event${count === 1 ? "" : "s"} in window` : "No events observed in window"}`, className: cn("group flex flex-col gap-1.5 rounded-md border p-2.5 text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none", observed
                        ? active
                            ? tone.active
                            : "border-border bg-surface-sunken hover:bg-accent/30"
                        : "border-border/50 bg-surface-sunken/40 hover:bg-accent/20", tone.ring) },
                    React.createElement("div", { className: "flex items-center gap-1.5" },
                        React.createElement("span", { className: cn("h-2 w-2 rounded-full", observed ? tone.dot : "bg-muted-foreground/30"), "aria-hidden": true }),
                        React.createElement("span", { className: cn("truncate text-2xs font-semibold uppercase tracking-wider", observed ? "text-foreground" : "text-muted-foreground") }, tpl.label)),
                    React.createElement("div", { className: "flex items-baseline justify-between" },
                        React.createElement("span", { className: cn("text-lg font-semibold tabular-nums", observed ? "text-foreground" : "text-muted-foreground/60") }, count),
                        React.createElement("span", { className: cn("text-3xs uppercase tracking-wider", observed
                                ? "text-muted-foreground"
                                : "text-muted-foreground/50") }, observed ? "observed" : "none in window"))));
            })))),
        hasEntries && perMinute.buckets.length > 0 && (React.createElement("section", { className: "rounded-md border border-border bg-card p-4", role: "region", "aria-label": "Events over visible time range, stacked success vs failure" },
            React.createElement("div", { className: "mb-2 flex items-center justify-between gap-2" },
                React.createElement("h3", { className: "m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                    "Events per ",
                    perMinute.granularity,
                    " ",
                    React.createElement("span", { className: "text-3xs font-normal normal-case text-muted-foreground/70" },
                        "(",
                        perMinute.buckets.length,
                        " bucket",
                        perMinute.buckets.length === 1 ? "" : "s",
                        " \u00B7 peak",
                        " ",
                        perMinute.peak,
                        ")")),
                React.createElement("div", { className: "flex items-center gap-3 text-2xs text-muted-foreground" },
                    React.createElement("span", { className: "inline-flex items-center gap-1" },
                        React.createElement("span", { className: "h-2 w-2 rounded-sm bg-info", "aria-hidden": "true" }),
                        "success"),
                    React.createElement("span", { className: "inline-flex items-center gap-1" },
                        React.createElement("span", { className: "h-2 w-2 rounded-sm bg-destructive", "aria-hidden": "true" }),
                        "failure"))),
            React.createElement("div", { className: "flex h-16 items-end gap-px", role: "img", "aria-label": `Stacked bar chart of audit events per ${perMinute.granularity}; peak ${perMinute.peak} events.` }, perMinute.buckets.map((bucket, idx) => {
                const total = bucket.s + bucket.f;
                if (total === 0) {
                    return (React.createElement("span", { key: idx, className: "flex-1 rounded-sm bg-muted/20", style: { height: "6%" }, title: `${bucket.tsLabel}: no events` }));
                }
                const totalPct = (total / perMinute.peak) * 100;
                const sShare = bucket.s / total;
                const fShare = bucket.f / total;
                return (React.createElement("span", { key: idx, className: "flex-1 flex flex-col-reverse", style: { height: `${Math.max(totalPct, 8)}%` }, title: `${bucket.tsLabel}: ${bucket.s} success, ${bucket.f} failure` },
                    sShare > 0 && (React.createElement("span", { className: "block rounded-b-sm bg-info", style: { height: `${sShare * 100}%` } })),
                    fShare > 0 && (React.createElement("span", { className: cn("block bg-destructive", sShare === 0 && "rounded-b-sm", "rounded-t-sm"), style: { height: `${fShare * 100}%` } }))));
            })),
            React.createElement("div", { className: "mt-1.5 flex justify-between text-3xs text-muted-foreground tabular-nums" },
                React.createElement("span", null, (_c = perMinute.buckets[0]) === null || _c === void 0 ? void 0 : _c.tsLabel),
                React.createElement("span", null, (_d = perMinute.buckets[perMinute.buckets.length - 1]) === null || _d === void 0 ? void 0 : _d.tsLabel)))),
        !hasMatches ? (hasEntries ? (React.createElement(EmptyState, { icon: Filter, title: "No entries match the current filters", description: "Try clearing the search or adjusting filter selections.", action: {
                label: "Reset filters",
                onClick: handleResetFilters,
                icon: RotateCcw,
            } })) : (React.createElement(EmptyState, { icon: FileText, title: "No audit entries recorded yet", description: "Audit entries appear here as actions are performed." }))) : (React.createElement("div", { className: "rounded-md border border-border bg-card" },
            React.createElement("div", { ref: tableScrollRef, className: "max-h-[70vh] overflow-x-auto overflow-y-auto", role: "region", "aria-label": "Audit log entries", tabIndex: 0 },
                React.createElement(Table, null,
                    React.createElement(TableHeader, null,
                        React.createElement(TableRow, { className: "hover:bg-transparent" },
                            React.createElement(TableHead, { className: "w-8", "aria-label": "Expand row" }),
                            React.createElement(SortableHead, { label: "Timestamp", sortKey: "timestamp", sort: sort, onToggle: toggleSort }),
                            React.createElement(SortableHead, { label: "Actor", sortKey: "actor", sort: sort, onToggle: toggleSort }),
                            React.createElement(SortableHead, { label: "Action", sortKey: "action", sort: sort, onToggle: toggleSort }),
                            React.createElement(SortableHead, { label: "Target", sortKey: "target", sort: sort, onToggle: toggleSort }),
                            React.createElement(SortableHead, { label: "Status", sortKey: "status", sort: sort, onToggle: toggleSort }))),
                    React.createElement(TableBody, null, (() => {
                        // Single shared context object so we don't construct it
                        // inside per-row map callbacks (would invalidate React
                        // child reconciliation more often than needed).
                        const rowCtx = {
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
                                return (React.createElement(React.Fragment, { key: `grp:${group.key}` },
                                    React.createElement(TableRow, { className: "cursor-pointer bg-surface-sunken/40 hover:bg-surface-sunken/60", onClick: () => toggleGroupCollapsed(group.key), "data-group-header": true },
                                        React.createElement(TableCell, { colSpan: 6, className: "py-1.5 align-middle" },
                                            React.createElement("div", { className: "flex items-center gap-2" },
                                                React.createElement("button", { type: "button", onClick: (e) => {
                                                        e.stopPropagation();
                                                        toggleGroupCollapsed(group.key);
                                                    }, "aria-label": isCollapsed
                                                        ? `Expand group ${group.label}`
                                                        : `Collapse group ${group.label}`, "aria-expanded": !isCollapsed, className: "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" }, isCollapsed ? (React.createElement(ChevronRight, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(ChevronDown, { className: "h-3.5 w-3.5", "aria-hidden": true }))),
                                                React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, groupBy),
                                                React.createElement("span", { className: "truncate font-mono text-xs text-foreground", title: group.label }, group.label),
                                                React.createElement(Badge, { variant: "outline", className: "ml-1 h-4 min-w-4 px-1 text-3xs tabular-nums" }, group.rows.length)))),
                                    !isCollapsed &&
                                        group.rows.map((entry) => renderEntryRows(entry, rowCtx))));
                            })
                            : paged.map((entry) => renderEntryRows(entry, rowCtx));
                    })()))),
            React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-sunken/30 px-3 py-2" },
                React.createElement("div", { className: "flex items-center gap-3 text-2xs text-muted-foreground" },
                    React.createElement("span", { className: "tabular-nums" },
                        "Showing",
                        " ",
                        React.createElement("strong", { className: "text-foreground" }, (currentPage - 1) * pageSize + 1),
                        "–",
                        React.createElement("strong", { className: "text-foreground" }, Math.min(currentPage * pageSize, sorted.length)),
                        " ",
                        "of",
                        " ",
                        React.createElement("strong", { className: "text-foreground" }, sorted.length),
                        " ",
                        "entries",
                        sorted.length !== entries.length && (React.createElement("span", { className: "text-muted-foreground/70" },
                            " ",
                            "(filtered from ",
                            entries.length,
                            ")"))),
                    React.createElement("div", { className: "flex items-center gap-1.5" },
                        React.createElement("span", null, "Rows per page"),
                        React.createElement(Select, { value: String(pageSize), onValueChange: (v) => setPageSizeRaw(coercePageSize(v)) },
                            React.createElement(SelectTrigger, { className: "h-7 w-16 text-xs", "aria-label": "Rows per page" },
                                React.createElement(SelectValue, null)),
                            React.createElement(SelectContent, null, PAGE_SIZE_OPTIONS.map((opt) => (React.createElement(SelectItem, { key: opt, value: String(opt), className: "text-xs" }, opt))))))),
                totalPages > 1 && (React.createElement(Pagination, { className: "mx-0 w-auto" },
                    React.createElement(PaginationContent, null,
                        React.createElement(PaginationItem, null,
                            React.createElement(PaginationFirst, { onClick: () => setPage(1), disabled: currentPage <= 1 })),
                        React.createElement(PaginationItem, null,
                            React.createElement(PaginationPrevious, { onClick: () => setPage(currentPage - 1), disabled: currentPage <= 1 })),
                        React.createElement(PaginationItem, null,
                            React.createElement(PaginationLink, { isActive: true, "aria-label": `Page ${currentPage}` }, currentPage)),
                        React.createElement(PaginationItem, null,
                            React.createElement("span", { className: "text-2xs text-muted-foreground tabular-nums" },
                                "/ ",
                                totalPages)),
                        React.createElement(PaginationItem, null,
                            React.createElement(PaginationNext, { onClick: () => setPage(currentPage + 1), disabled: currentPage >= totalPages })),
                        React.createElement(PaginationItem, null,
                            React.createElement(PaginationLast, { onClick: () => setPage(totalPages), disabled: currentPage >= totalPages })))))))),
        React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: "Clear all audit log entries?", message: "This permanently removes the session's audit history. This action cannot be undone.", confirmText: "Clear log", cancelText: "Cancel", danger: true, onConfirm: handleConfirmClear, onCancel: handleCancelClear })));
};
/**
 * Render the main row + (optional) expanded-details row for one audit entry.
 * Pulled out of the JSX so the grouped renderer and the flat renderer can
 * share it without duplicating ~70 lines of cell markup.
 */
function renderEntryRows(entry, ctx) {
    var _a, _b;
    const { expandedId, relativeTime, handleRowToggle, togglePin, pinnedSet, notesMap, startEditingNote, saveNote, editingNoteFor, draftNote, setDraftNote, cancelEditingNote, focusedRowIdx, indexOf, diffSiblingIdMap, jumpToEntry, } = ctx;
    const isExpanded = expandedId === entry.id;
    const hasExpandable = Boolean(entry.details) || Boolean(entry.error);
    const isPinned = pinnedSet.has(entry.id);
    const hasNote = Boolean(notesMap[entry.id]);
    const isEditingNote = editingNoteFor === entry.id;
    const entryIdx = indexOf(entry.id);
    const isFocused = focusedRowIdx !== null && entryIdx === focusedRowIdx;
    const siblingId = (_a = diffSiblingIdMap.get(entry.id)) !== null && _a !== void 0 ? _a : null;
    // Force an expanded view when we're editing a note for this row, so the
    // user has somewhere to type without juggling two rows.
    const effectiveExpanded = isExpanded || isEditingNote;
    return (React.createElement(React.Fragment, { key: entry.id },
        React.createElement(TableRow, { "data-state": effectiveExpanded ? "selected" : undefined, "data-entry-id": entry.id, className: cn("group/row", hasExpandable && "cursor-pointer", effectiveExpanded && "bg-muted/40", isPinned && "border-l-2 border-l-warning", isFocused && "ring-2 ring-inset ring-primary/60"), onClick: hasExpandable ? () => handleRowToggle(entry.id) : undefined },
            React.createElement(TableCell, { className: "w-8 p-0 text-center align-middle" }, hasExpandable ? (React.createElement("button", { type: "button", onClick: (e) => {
                    e.stopPropagation();
                    handleRowToggle(entry.id);
                }, "aria-label": isExpanded ? "Collapse details" : "Expand details", "aria-expanded": isExpanded, className: "inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" }, isExpanded ? (React.createElement(ChevronDown, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(ChevronRight, { className: "h-3.5 w-3.5", "aria-hidden": true })))) : (React.createElement("span", { className: "inline-block h-1 w-1 rounded-full bg-muted-foreground/30", "aria-hidden": true }))),
            React.createElement(TableCell, { className: "whitespace-nowrap font-mono text-xs text-muted-foreground tabular-nums" },
                React.createElement("span", { title: relativeTime
                        ? formatDateTime(entry.timestamp)
                        : entry.timestamp }, relativeTime
                    ? formatRelativeTime(entry.timestamp)
                    : formatDateTime(entry.timestamp))),
            React.createElement(TableCell, { className: "text-sm text-foreground", onClick: (e) => e.stopPropagation() },
                React.createElement(CopyableText, { value: entry.actor })),
            React.createElement(TableCell, { className: "text-sm font-medium text-primary", onClick: (e) => e.stopPropagation() },
                React.createElement(CopyableText, { value: entry.action, display: React.createElement("span", { className: "font-mono text-xs" }, entry.action) })),
            React.createElement(TableCell, { className: "text-sm text-foreground", onClick: (e) => e.stopPropagation() }, entry.target ? (React.createElement(CopyableText, { value: entry.target, mono: entry.target.length > 20 })) : (React.createElement("span", { className: "text-muted-foreground/60" }, "\u2014"))),
            React.createElement(TableCell, { onClick: (e) => e.stopPropagation() },
                React.createElement("div", { className: "flex items-center justify-between gap-1.5" },
                    React.createElement(Badge, { variant: entry.status === "success" ? "success" : "destructive", className: "capitalize" }, entry.status),
                    React.createElement("div", { className: "flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100" },
                        React.createElement("button", { type: "button", onClick: (e) => {
                                e.stopPropagation();
                                togglePin(entry.id);
                            }, "aria-pressed": isPinned, "aria-label": isPinned ? "Unpin row" : "Pin row", title: isPinned ? "Unpin" : "Pin", className: cn("inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", isPinned
                                ? "text-warning opacity-100"
                                : "text-muted-foreground hover:text-foreground") }, isPinned ? (React.createElement(Pin, { className: "h-3 w-3 fill-current", "aria-hidden": true })) : (React.createElement(PinOff, { className: "h-3 w-3", "aria-hidden": true }))),
                        React.createElement("button", { type: "button", onClick: (e) => {
                                var _a;
                                e.stopPropagation();
                                startEditingNote(entry.id, (_a = notesMap[entry.id]) !== null && _a !== void 0 ? _a : "");
                            }, "aria-label": hasNote ? "Edit note" : "Add note", title: hasNote
                                ? `Note: ${notesMap[entry.id]}`
                                : "Add an operator note", className: cn("inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", hasNote
                                ? "text-info opacity-100"
                                : "text-muted-foreground hover:text-foreground") },
                            React.createElement(StickyNote, { className: cn("h-3 w-3", hasNote && "fill-current opacity-90"), "aria-hidden": true })))),
                siblingId && (React.createElement("button", { type: "button", className: "mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-3xs font-medium text-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", onClick: (e) => {
                        e.stopPropagation();
                        jumpToEntry(siblingId);
                    }, title: "Jump to the paired event on the same target", "aria-label": "Jump to the paired event" },
                    React.createElement(ChevronsUpDown, { className: "h-3 w-3", "aria-hidden": true }),
                    "pair")))),
        !isExpanded && (hasNote || isEditingNote) && (React.createElement(TableRow, { className: "bg-info/5 hover:bg-info/10", "aria-label": "Row note" },
            React.createElement(TableCell, { colSpan: 6, className: "px-3 py-1.5" },
                React.createElement("div", { className: "flex items-start gap-2" },
                    React.createElement(StickyNote, { className: "mt-0.5 h-3 w-3 shrink-0 text-info", "aria-hidden": true }),
                    isEditingNote ? (React.createElement("div", { className: "flex w-full items-center gap-1.5" },
                        React.createElement(Input, { autoFocus: true, value: draftNote, onChange: (e) => setDraftNote(e.target.value), onKeyDown: (e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    saveNote(entry.id, draftNote);
                                }
                                else if (e.key === "Escape") {
                                    e.preventDefault();
                                    cancelEditingNote();
                                }
                            }, placeholder: "Operator note (Enter to save, Esc to cancel)", className: "h-7 text-xs", "aria-label": "Operator note" }),
                        React.createElement(Button, { type: "button", variant: "default", size: "xs", onClick: () => saveNote(entry.id, draftNote), className: "h-7 shrink-0" }, "Save"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: cancelEditingNote, className: "h-7 shrink-0" }, "Cancel"))) : (React.createElement("span", { className: "flex-1 text-xs text-foreground/90" }, notesMap[entry.id])))))),
        isExpanded && (React.createElement(TableRow, { className: "bg-muted/20 hover:bg-muted/20", "aria-label": "Row details" },
            React.createElement(TableCell, { colSpan: 6, className: "p-0" },
                React.createElement(RowDetails, { entry: entry, note: (_b = notesMap[entry.id]) !== null && _b !== void 0 ? _b : "", isEditingNote: isEditingNote, draftNote: draftNote, setDraftNote: setDraftNote, startEditingNote: () => { var _a; return startEditingNote(entry.id, (_a = notesMap[entry.id]) !== null && _a !== void 0 ? _a : ""); }, saveNote: (text) => saveNote(entry.id, text), cancelEditingNote: cancelEditingNote }))))));
}
const SortableHead = ({ label, sortKey, sort, onToggle, }) => {
    const isActive = sort.key === sortKey;
    const Icon = !isActive
        ? ChevronsUpDown
        : sort.dir === "asc"
            ? ChevronUp
            : ChevronDown;
    return (React.createElement(TableHead, { className: "select-none" },
        React.createElement("button", { type: "button", onClick: () => onToggle(sortKey), className: cn("group/sort -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs font-semibold uppercase tracking-wider transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"), "aria-label": isActive
                ? `${label}, sorted ${sort.dir === "asc" ? "ascending" : "descending"}; click to ${sort.dir === "asc" ? "sort descending" : "sort ascending"}`
                : `${label}, click to sort`, "aria-sort": isActive ? (sort.dir === "asc" ? "ascending" : "descending") : "none" },
            label,
            React.createElement(Icon, { className: cn("h-3 w-3 transition-opacity", isActive
                    ? "opacity-100"
                    : "opacity-30 group-hover/sort:opacity-70"), "aria-hidden": true }))));
};
const RowDetails = ({ entry, note, isEditingNote, draftNote, setDraftNote, startEditingNote, saveNote, cancelEditingNote, }) => {
    const detailsJson = React.useMemo(() => (entry.details ? JSON.stringify(entry.details, null, 2) : ""), [entry.details]);
    // Per-row toggle: pretty/raw JSON. Pretty (default) shows the standard
    // 2-space-indented JSON; raw shows the compact single-line form which
    // is friendlier for grep / paste.
    const [rawJson, setRawJson] = React.useState(false);
    const detailsCompact = React.useMemo(() => (entry.details ? JSON.stringify(entry.details) : ""), [entry.details]);
    return (React.createElement("div", { className: "border-l-2 border-primary/40 bg-surface-sunken/40 px-4 py-3" },
        React.createElement("div", { className: "grid gap-3 sm:grid-cols-2" },
            React.createElement(DetailRow, { label: "Entry ID", value: entry.id, mono: true, copyable: true }),
            React.createElement(DetailRow, { label: "Timestamp (ISO)", value: entry.timestamp, mono: true, copyable: true })),
        React.createElement("div", { className: "mt-3 rounded-md border border-info/40 bg-info/5 p-3" },
            React.createElement("div", { className: "flex items-center justify-between gap-2" },
                React.createElement("span", { className: "inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-info" },
                    React.createElement(StickyNote, { className: "h-3 w-3", "aria-hidden": true }),
                    "Operator note"),
                !isEditingNote && (React.createElement("button", { type: "button", onClick: (e) => {
                        e.stopPropagation();
                        startEditingNote();
                    }, className: "rounded px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": note ? "Edit note" : "Add note" }, note ? "Edit" : "Add"))),
            isEditingNote ? (React.createElement("div", { className: "mt-1.5 flex items-center gap-1.5" },
                React.createElement(Input, { autoFocus: true, value: draftNote, onChange: (e) => setDraftNote(e.target.value), onKeyDown: (e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            saveNote(draftNote);
                        }
                        else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEditingNote();
                        }
                    }, placeholder: "Why does this entry matter?", className: "h-7 text-xs" }),
                React.createElement(Button, { type: "button", variant: "default", size: "xs", onClick: (e) => {
                        e.stopPropagation();
                        saveNote(draftNote);
                    }, className: "h-7 shrink-0" }, "Save"),
                React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: (e) => {
                        e.stopPropagation();
                        cancelEditingNote();
                    }, className: "h-7 shrink-0" }, "Cancel"))) : (React.createElement("p", { className: cn("m-0 mt-1.5 text-xs", note ? "text-foreground/90" : "italic text-muted-foreground") }, note || "No note. Click Add to attach an operator annotation."))),
        entry.error && (React.createElement("div", { className: "mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3" },
            React.createElement("div", { className: "flex items-center justify-between gap-2" },
                React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-destructive" }, "Error"),
                React.createElement(CopyButton, { value: entry.error, alwaysVisible: true, iconSize: 12 })),
            React.createElement("pre", { className: "m-0 mt-1.5 whitespace-pre-wrap break-words font-mono text-xs text-destructive" }, entry.error))),
        detailsJson && (React.createElement("div", { className: "mt-3 rounded-md border border-border bg-surface-sunken p-3" },
            React.createElement("div", { className: "flex items-center justify-between gap-2" },
                React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Details (JSON)"),
                React.createElement("div", { className: "flex items-center gap-1.5" },
                    React.createElement("button", { type: "button", onClick: () => setRawJson((v) => !v), className: cn("rounded px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", rawJson
                            ? "bg-primary/15 text-primary"
                            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"), "aria-pressed": rawJson, "aria-label": rawJson
                            ? "Show pretty-printed JSON"
                            : "Show raw single-line JSON" }, rawJson ? "Raw" : "Pretty"),
                    React.createElement(CopyButton, { value: rawJson ? detailsCompact : detailsJson, alwaysVisible: true, iconSize: 12 }))),
            React.createElement("pre", { className: "m-0 mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90" }, rawJson ? detailsCompact : detailsJson))),
        !entry.error && !detailsJson && (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No additional details were recorded for this entry."))));
};
const DetailRow = ({ label, value, mono = false, copyable = false, }) => (React.createElement("div", { className: "flex flex-col gap-0.5" },
    React.createElement("span", { className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, label),
    React.createElement("span", { className: cn("group/copy flex items-center gap-1.5", mono && "font-mono text-xs", !mono && "text-sm") },
        React.createElement("span", { className: "break-all text-foreground" }, value),
        copyable && React.createElement(CopyButton, { value: value, iconSize: 11 }))));
//# sourceMappingURL=audit-log-page.js.map