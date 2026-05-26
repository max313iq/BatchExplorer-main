/**
 * Universal Audience Matrix page.
 *
 * What the operator sees
 * ----------------------
 * A grid where every imported refresh-token AND every signed-in MSAL account
 * occupies a row, and every well-known Azure resource audience (ARM, Graph,
 * Batch, Vault, Storage, Intune, Substrate, Monitor, Power BI, Yammer,
 * DevOps, Custom) occupies a column. Cells are:
 *
 *   `–`          not tried yet
 *   spinner      mint in flight (re-click to cancel)
 *   `✓ 58m`      mint succeeded; click to view claims / re-mint / vault-it
 *   `✕ AADSTS…`  mint rejected by AAD; hover for full error text
 *
 * Why
 * ---
 * Operators routinely need to confirm WHICH Azure surfaces an identity (or
 * a leaked RT they want to triage) can actually reach. Doing this manually
 * means clicking through Token Importer's FOCI panel once per audience per
 * principal — slow, error-prone, and produces 12 audit-log entries per
 * principal that are hard to correlate. The matrix collapses that workflow
 * into one click per cell (or one "Mint EVERYTHING" click) and keeps the
 * audit trail intact — every cell mint still emits `audience_matrix_mint`.
 *
 * Wiring constraints (per build spec)
 * -----------------------------------
 * - This page must NOT edit services / auth / store / page-router / sidebar
 *   / shared components / other pages. Recommendation for the orchestrator:
 *   register `"audience-matrix"` as PageKey and place a sidebar entry under
 *   Identity using the `LayoutGrid` icon (Wand2 and Grid3x3 are taken).
 * - All file additions live under
 *   `web/src/multi-region/components/audience-matrix/`.
 * - No new npm deps — concurrency, debounce, and date math are inline.
 *
 * Hardening notes
 * ---------------
 * - Token material NEVER touches the audit log. Every audit details object
 *   carries scope / audience / durationMs / row identifiers only — no
 *   `accessToken`, no `refresh_token`.
 * - Per-cell AbortController + generation token mean stale mints can't
 *   overwrite newer state when the operator re-clicks rapidly or unmounts
 *   the page mid-batch.
 * - Concurrency is capped at 5 in flight via `runWithConcurrency` from
 *   the helpers — keeps AAD throttling friendly and the UI responsive.
 * - "Include token material" in the JSON export defaults OFF, gated behind
 *   a checkbox the operator must consciously tick.
 */
import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  Copy,
  Eye,
  KeyRound,
  Layers,
  LayoutGrid,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  exchangeRefreshTokenForClient,
  FociExchangeError,
} from "../../auth/foci-exchange";
import {
  classifyAudience,
  importRefreshToken,
  importToken,
  listImportedAccounts,
  listRefreshTokenEntries,
  type AudienceBucket,
  type ImportedAccountSummary,
  type ImportedRefreshTokenEntry,
} from "../../auth/imported-tokens";
import {
  decodeJwtClaimsUnsafe,
  getArmTokenForAccount,
  getBatchTokenForAccount,
  getGraphTokenForAccount,
} from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";

// COORDINATOR: This page consumes `useDashboardOutletContext().navigateToPage`
// for the empty-state CTA only. We do NOT edit page-router.tsx — the
// `audience-matrix` route is already wired there (see line ~643).
import { useDashboardOutletContext } from "../page-router";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { FilterChipRow } from "../shared/filter-chip-row";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

import {
  AUDIENCE_COLUMNS,
  buildRowComparator,
  cellKey,
  computeTimeSavedMs,
  fmtDurationMs,
  fmtRemaining,
  indexCellsByRow,
  maskRefreshToken,
  MATRIX_DENSITY_KEY,
  nextCoord,
  runWithConcurrency,
  shortTenant,
  summariseFromJwt,
  useSecondsTicker,
  type AudienceColumn,
  type CellCoord,
  type CellState,
  type MatrixDensity,
  type MintRow,
  type MintSuccess,
  type RowCellIndexEntry,
  type RowKind,
  type RowSortKey,
  type SortDirection,
} from "./audience-matrix-helpers";
import {
  clientIdIsFoci,
  DEFENDER_BANNER_COPY,
  FOCI_BANNER_DISMISS_KEY,
  fociClientName,
  getAudienceRisk,
  getFociClientProfile,
  tierShort,
  tierTextClass,
} from "./audience-matrix-corpus";
import { AudienceReachabilityTable } from "./audience-matrix-reachability";

// ---------------------------------------------------------------------------
//  Local types
// ---------------------------------------------------------------------------

type RowSourceFilter = "rt" | "account" | "both";

interface AuditDetail {
  rowKind: RowKind;
  rowId: string;
  audience: string;
  scope: string;
  durationMs: number;
  tokenAudience?: string;
  aadError?: string;
}

// URL-state schema — flat strings so `useUrlState` can round-trip cleanly.
// Render-stable per the hook's contract (snapshotted once on first render).
interface MatrixUrlState {
  /** "rt" | "account" | "both" — defaults to "both". */
  src: string;
  /** Free-text filter on display name / UPN / tenant / client / oid. */
  q: string;
  /** Operator-typed scope for the Custom column. */
  custom: string;
  /** "1" when "only minted in last 24h" chip is active; "" otherwise. */
  recent: string;
  /** Sort key — one of `RowSortKey`. Defaults to "name". */
  sort: string;
  /** Sort direction — "asc" | "desc". Defaults to "asc". */
  dir: string;
}

const INITIAL_URL_STATE: MatrixUrlState = Object.freeze({
  src: "both",
  q: "",
  custom: "",
  recent: "",
  sort: "name",
  dir: "asc",
}) as MatrixUrlState;

/** Allowed sort keys mirroring `RowSortKey`. URL values outside this set fall back to "name". */
const SORT_KEYS: ReadonlySet<RowSortKey> = new Set([
  "name",
  "kind",
  "tenant",
  "client",
  "minted",
]);

/** Recency window for the "issued in last 24h" chip (seconds). */
const RECENT_WINDOW_SEC = 24 * 60 * 60;

// ---------------------------------------------------------------------------
//  Page
// ---------------------------------------------------------------------------

export const AudienceMatrixPage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const { navigateToPage } = useDashboardOutletContext();

  // Mount lifecycle — every async path checks this before calling setState
  // so we never trigger a setState-after-unmount warning when the operator
  // navigates away mid-batch. Initialised to `true` at construction; the
  // unmount-side handler flips it to `false` exactly once.
  const mountedRef = React.useRef(true);
  React.useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // ----- Source data -----
  const [importedAccounts, setImportedAccounts] = React.useState<
    ImportedAccountSummary[]
  >(() => listImportedAccounts());
  const [refreshTokens, setRefreshTokens] = React.useState<
    ImportedRefreshTokenEntry[]
  >(() => listRefreshTokenEntries());

  const refreshRowSources = React.useCallback(() => {
    if (!mountedRef.current) return;
    setImportedAccounts(listImportedAccounts());
    setRefreshTokens(listRefreshTokenEntries());
  }, []);

  // Primary signed-in account drives the TokenExpiryBadge in the header.
  // Mirrors the convention used by overview-page / account-info-page.
  const primaryAccount = state.azureAccounts?.[0];
  const armTokenTracker = useArmToken(
    primaryAccount?.homeAccountId,
    primaryAccount ? resolveActiveTenantId(primaryAccount) : undefined,
  );

  // ----- Filter + search (URL-persisted so deep links / refreshes preserve
  //       operator's filter context). Keys are short to keep URLs tidy when
  //       the operator shares a link via screenshare. -----
  const [urlState, setUrlState] = useUrlState<MatrixUrlState>(
    INITIAL_URL_STATE,
    { replace: true },
  );
  const sourceFilter: RowSourceFilter =
    urlState.src === "rt" || urlState.src === "account" || urlState.src === "both"
      ? (urlState.src as RowSourceFilter)
      : "both";
  const search = urlState.q;
  const customScope = urlState.custom;
  const recentOnly = urlState.recent === "1";
  // Sort key validated against the SORT_KEYS allow-list so a hand-edited URL
  // (`?sort=evil-eval`) can't crash the comparator factory.
  const sortKey: RowSortKey = SORT_KEYS.has(urlState.sort as RowSortKey)
    ? (urlState.sort as RowSortKey)
    : "name";
  const sortDir: SortDirection = urlState.dir === "desc" ? "desc" : "asc";

  const setSourceFilter = React.useCallback(
    (next: RowSourceFilter) => setUrlState({ src: next }),
    [setUrlState],
  );
  const setSearch = React.useCallback(
    (next: string) => setUrlState({ q: next }),
    [setUrlState],
  );
  const setCustomScope = React.useCallback(
    (next: string) => setUrlState({ custom: next }),
    [setUrlState],
  );
  const setRecentOnly = React.useCallback(
    (next: boolean) => setUrlState({ recent: next ? "1" : "" }),
    [setUrlState],
  );
  const setSortKey = React.useCallback(
    (next: RowSortKey) => setUrlState({ sort: next }),
    [setUrlState],
  );
  const toggleSortDir = React.useCallback(
    () => setUrlState({ dir: sortDir === "asc" ? "desc" : "asc" }),
    [setUrlState, sortDir],
  );

  // ----- Matrix density (compact ↔ comfy) — persisted across reloads -----
  // Comfy is the default because operators new to the page benefit from the
  // verbose identifier rows. Returning operators usually toggle to compact
  // once they know the shape; the persisted preference removes the friction.
  const [density, setDensity] = usePersistedState<MatrixDensity>(
    MATRIX_DENSITY_KEY,
    "comfy",
  );
  const isCompact = density === "compact";

  // ----- Cell state map -----
  // One entry per (rowId, audienceKey). Absent === idle. Single Record
  // (not nested) so we can immutably update one cell at a time without
  // walking the whole row.
  const [cells, setCells] = React.useState<Record<string, CellState>>({});

  // Latest-wins generation guard so stale mints can never clobber newer
  // state — bumped every time the row source changes (deleting an RT
  // mid-batch must invalidate that RT's in-flight mints).
  const generationRef = React.useRef(0);

  // In-flight controllers tracked OUTSIDE the cells map so the unmount
  // cleanup can abort everything without closing over a stale React state
  // snapshot. Adding to / removing from the set runs synchronously with
  // setCells so the two views stay in sync.
  const controllersRef = React.useRef<Set<AbortController>>(new Set());

  // ----- Bulk-mint confirmation -----
  const [pendingBulk, setPendingBulk] = React.useState<
    "all-row" | "all-column" | "all-everything" | null
  >(null);
  // Carry the action context for the dialog confirm — set alongside
  // `pendingBulk`. Kept off the dialog itself so the dialog renderer
  // stays declarative.
  const pendingBulkArgRef = React.useRef<{
    rowId?: string;
    audienceKey?: string;
  } | null>(null);

  // ----- Result popover open-state map (which cell's popover is open) -----
  // We render Popover instances inside the table; Radix needs `open` to be
  // controlled when we want re-mint / vault buttons to close the popover.
  const [openCellKey, setOpenCellKey] = React.useState<string | null>(null);

  // ----- Focused cell coordinate (for keyboard navigation) -----
  // Tracks the (rowIndex, colIndex) of the currently-focused cell. Updated
  // by `onFocus` handlers on each cell button and by the arrow-key handler
  // on the grid wrapper. Rendered as `aria-activedescendant`-style focus on
  // the matching cell.
  const [focusedCoord, setFocusedCoord] = React.useState<CellCoord | null>(
    null,
  );
  // DOM ref to the table — used to imperatively focus a cell after arrow-key
  // navigation. Querying by `data-row-index` / `data-col-index` keeps the
  // page's render path React-idiomatic; we don't lift refs into every cell.
  const gridRef = React.useRef<HTMLTableElement | null>(null);

  // ----- Shared 1Hz ticker. ONE setInterval for the whole page; cells
  //       subscribe to `nowSec` and render `expiresAt - nowSec` locally. -----
  const nowSec = useSecondsTicker();

  // ----- Latest parallel-mint wall-clock for the "time saved" stat -----
  const [lastParallelMs, setLastParallelMs] = React.useState<number>(0);

  // ----- Export panel: include-token-material gate -----
  const [includeTokens, setIncludeTokens] = React.useState(false);

  // ----- Signal C — Defender awareness banner -----
  // Persisted across reloads so operators don't see the FOCI primer every
  // session; the dismiss action emits a single audit entry so we can
  // attribute "did the operator acknowledge the defender context before
  // minting".  See `audience-matrix-corpus.ts` for the citation chain.
  const [bannerDismissed, setBannerDismissed] = usePersistedState<boolean>(
    FOCI_BANNER_DISMISS_KEY,
    false,
  );
  const dismissBanner = React.useCallback(() => {
    setBannerDismissed(true);
    auditLog.record({
      actor: "operator",
      action: "audience_matrix_dismiss_foci_banner",
      target: "audience-matrix",
      status: "success",
      details: {
        bannerKey: FOCI_BANNER_DISMISS_KEY,
        corpus: [
          "_AZURE_LOGIN_METHODS.md",
          "_analysis_defender_view.md",
          "dirkjanm/family-of-client-ids-research/README.md",
        ],
      },
    });
  }, [setBannerDismissed]);

  // ----- Cleanup all in-flight controllers on unmount -----
  // Using `controllersRef` (not the `cells` map) so the cleanup sees every
  // in-flight controller — closing over `cells` here would capture the
  // empty initial map and abort nothing.
  React.useEffect(
    () => () => {
      // Bump generation so any unfinished mints' completion handlers
      // discover they're stale and skip setState.
      generationRef.current++;
      // Abort every still-pending controller so its fetch promise rejects
      // fast. The set is mutated in place during component lifetime; here
      // we just drain it.
      for (const c of controllersRef.current) {
        try {
          c.abort();
        } catch {
          // AbortController.abort() doesn't throw in any spec we care about,
          // but a polyfill or old runtime could. Swallow — unmount must
          // never throw.
        }
      }
      controllersRef.current.clear();
    },
    [],
  );

  // -----------------------------------------------------------------------
  //  Row materialisation
  // -----------------------------------------------------------------------
  // We project two source lists into one `MintRow[]`, then apply the
  // source filter + search filter on top. Memoised so the table doesn't
  // re-render unless one of the dependencies actually changed.
  const allRows = React.useMemo<MintRow[]>(() => {
    const rows: MintRow[] = [];
    // RT rows first — they're the unique-to-this-page entity.
    for (const rt of refreshTokens) {
      rows.push({
        id: `rt:${rt.homeAccountId}`,
        kind: "rt",
        displayName: rt.name ?? rt.upn ?? rt.oid,
        upn: rt.upn,
        tenantId: rt.tenantId,
        oid: rt.oid,
        clientId: rt.clientId,
        rtPrefix: maskRefreshToken(rt.refreshToken),
      });
    }
    // Signed-in MSAL accounts (state.azureAccounts) with a tenant we can
    // hit. Skip rows that are explicitly signed-out.
    for (const acc of state.azureAccounts ?? []) {
      if (acc.signedOut) continue;
      if (!acc.tenantId) continue;
      rows.push({
        id: `account:${acc.homeAccountId}`,
        kind: "account",
        displayName: acc.name ?? acc.username,
        upn: acc.username,
        tenantId: acc.tenantId,
        oid: acc.localAccountId ?? acc.homeAccountId,
      });
    }
    return rows;
  }, [refreshTokens, state.azureAccounts]);

  // Source counts BEFORE the source filter so the toggle chips show truth.
  const rtCount = React.useMemo(
    () => allRows.filter((r) => r.kind === "rt").length,
    [allRows],
  );
  const accountCount = React.useMemo(
    () => allRows.filter((r) => r.kind === "account").length,
    [allRows],
  );

  // Audience-summary count for the header subtitle. ImportedAccountSummary
  // already aggregates audiences per principal — we sum the distinct
  // audiences so the operator sees "12 RTs covering 4 audiences".
  const distinctImportedAudiences = React.useMemo(() => {
    const set = new Set<AudienceBucket>();
    for (const a of importedAccounts) for (const b of a.audiences) set.add(b);
    return set.size;
  }, [importedAccounts]);

  // Build the row→cell-index map ONCE per cells change. Per-row recency
  // and minted-count lookups then drop from O(N_cells) (a prefix scan per
  // call) to O(1) — see helpers' `indexCellsByRow` for the implementation
  // and motivation.
  const rowCellIndex = React.useMemo(() => indexCellsByRow(cells), [cells]);
  // Stable mintedCount accessor for the sort comparator below.
  const mintedCount = React.useCallback(
    (rowId: string): number =>
      rowCellIndex.get(rowId)?.successCount ?? 0,
    [rowCellIndex],
  );

  // Filtered rows = source filter + free-text search + optional recency
  // chip ("only audiences with a token issued in the last 24h"). Then
  // sorted per the operator-chosen sort key / direction.
  const visibleRows = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    // `nowSec` for the recency check is bound to the shared ticker — when
    // it rolls past a 24h cliff, the row falls out of the filter on the
    // NEXT 1Hz tick.
    const filtered = allRows.filter((r) => {
      if (sourceFilter === "rt" && r.kind !== "rt") return false;
      if (sourceFilter === "account" && r.kind !== "account") return false;
      if (recentOnly) {
        const idx = rowCellIndex.get(r.id);
        if (!idx) return false;
        if (nowSec - idx.latestMintedAt > RECENT_WINDOW_SEC) return false;
      }
      if (!needle) return true;
      return (
        r.displayName.toLowerCase().includes(needle) ||
        (r.upn ?? "").toLowerCase().includes(needle) ||
        r.tenantId.toLowerCase().includes(needle) ||
        (r.clientId ?? "").toLowerCase().includes(needle) ||
        r.oid.toLowerCase().includes(needle)
      );
    });
    // `slice()` is a deliberate copy so we don't mutate the upstream
    // `allRows` reference — `filter` already returned a fresh array but a
    // future refactor that drops the filter could regress this.
    const sorted = filtered.slice();
    sorted.sort(buildRowComparator(sortKey, sortDir, mintedCount));
    return sorted;
  }, [
    allRows,
    sourceFilter,
    search,
    recentOnly,
    rowCellIndex,
    nowSec,
    sortKey,
    sortDir,
    mintedCount,
  ]);

  // Count rows that have at least one recent successful mint — drives the
  // count badge on the recent-only chip so the operator knows how many rows
  // the filter would surface BEFORE flipping it on. Now O(N_rows) per render
  // (was O(N_rows × N_cells) before the row-cell index).
  const recentRowCount = React.useMemo(() => {
    let n = 0;
    for (const r of allRows) {
      const idx = rowCellIndex.get(r.id);
      if (!idx) continue;
      if (nowSec - idx.latestMintedAt <= RECENT_WINDOW_SEC) n++;
    }
    return n;
  }, [allRows, rowCellIndex, nowSec]);

  // -----------------------------------------------------------------------
  //  Mint pipeline
  // -----------------------------------------------------------------------

  /**
   * Mint a single (row, audience) cell. Returns the new CellState — the
   * caller is responsible for committing it via `setCells` (we DON'T
   * setState here so this function is reusable inside batch helpers).
   *
   * Performs the mint via:
   *   - RT rows → FOCI exchange against the row's source client_id
   *   - Account rows → MSAL silent acquire via the per-audience helper
   *     (which already short-circuits to imported tokens when present)
   */
  const performMint = React.useCallback(
    async (
      row: MintRow,
      audience: AudienceColumn,
      scopeOverride?: string,
      signal?: AbortSignal,
    ): Promise<CellState> => {
      const startedAt = performance.now();
      const scope = (scopeOverride ?? audience.scope).trim();
      if (!scope) {
        return {
          kind: "error",
          message:
            "No scope provided. Type a scope in the Custom column header before clicking the cell.",
          failedAt: Date.now(),
        };
      }

      try {
        if (row.kind === "rt") {
          // FOCI exchange path — the page already imports the source RT
          // material; we never log it. The exchange function sanitises
          // whitespace and surfaces structured errors via FociExchangeError.
          const rt = refreshTokens.find(
            (r) => `rt:${r.homeAccountId}` === row.id,
          );
          if (!rt) {
            return {
              kind: "error",
              message:
                "Refresh token entry no longer present — was it removed from the vault?",
              failedAt: Date.now(),
            };
          }
          const result = await exchangeRefreshTokenForClient({
            refreshToken: rt.refreshToken,
            targetClientId: rt.clientId,
            tenantId: rt.tenantId,
            scope,
          });
          // AbortSignal honoured AFTER the await — we can't pass it into
          // the auth module's signature (out of scope to widen), so any
          // late-arriving result is discarded by the caller's generation
          // check rather than mid-flight.
          if (signal?.aborted) {
            return {
              kind: "error",
              message: "Cancelled.",
              failedAt: Date.now(),
            };
          }
          const claims = result.claims;
          const exp =
            typeof claims.exp === "number"
              ? (claims.exp as number)
              : Math.floor(Date.now() / 1000) + (result.expires_in ?? 3600);
          // Successful AAD round-trip — but if the operator paid for it
          // with a rotated RT, persist the rotation so subsequent mints
          // from the same row don't fail with "RT already consumed".
          if (
            result.refresh_token &&
            result.refresh_token !== rt.refreshToken
          ) {
            importRefreshToken({
              homeAccountId: rt.homeAccountId,
              tenantId: rt.tenantId,
              oid: rt.oid,
              upn: rt.upn,
              name: rt.name,
              clientId: rt.clientId,
              refreshToken: result.refresh_token,
            });
            // refresh the local list so the prefix display stays current
            refreshRowSources();
          }
          return {
            kind: "success",
            mintedAt: Math.floor(Date.now() / 1000),
            result: {
              accessToken: result.access_token,
              expiresAt: exp,
              audience: result.audience,
              claims,
              scope,
              durationMs: performance.now() - startedAt,
            },
          };
        }

        // Account row — use MSAL helpers. We pick the most specific helper
        // available so MSAL's silent cache hit-rate is optimal; otherwise
        // fall back to ARM for unknown audiences (which still proves the
        // account can authenticate at all).
        const accountId = row.id.replace(/^account:/, "");
        let token: string;
        switch (audience.key) {
          case "ARM":
            token = await getArmTokenForAccount(accountId, row.tenantId);
            break;
          case "Graph":
            token = await getGraphTokenForAccount(accountId, row.tenantId);
            break;
          case "Batch":
            token = await getBatchTokenForAccount(accountId, row.tenantId);
            break;
          default:
            // For non-ARM/Graph/Batch scopes the high-level helpers don't
            // cover, we route through getArmTokenForAccount's underlying
            // acquireTokenForAccount surface indirectly: requesting the
            // scope verbatim via the ARM helper would mint the wrong
            // audience, so we surface a clear cell-level error instead.
            // (Wiring up arbitrary-scope MSAL acquire is out-of-scope
            // for this page per the constraints; the operator has the
            // RT-row path for full audience coverage.)
            return {
              kind: "error",
              message: `MSAL silent acquire for audience "${audience.key}" is not wired on this page for signed-in accounts. Use the corresponding refresh-token row (import via Token Importer) to mint this audience.`,
              failedAt: Date.now(),
            };
        }
        if (signal?.aborted) {
          return {
            kind: "error",
            message: "Cancelled.",
            failedAt: Date.now(),
          };
        }
        const claims = decodeJwtClaimsUnsafe(token) ?? {};
        const exp =
          typeof claims.exp === "number"
            ? (claims.exp as number)
            : Math.floor(Date.now() / 1000) + 3600;
        return {
          kind: "success",
          mintedAt: Math.floor(Date.now() / 1000),
          result: {
            accessToken: token,
            expiresAt: exp,
            audience: typeof claims.aud === "string" ? (claims.aud as string) : "",
            claims,
            scope,
            durationMs: performance.now() - startedAt,
          },
        };
      } catch (err) {
        const isFoci = err instanceof FociExchangeError;
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: "error",
          message: msg,
          aadError: isFoci
            ? err.body.error ??
              (err.body.error_codes
                ? `AADSTS${err.body.error_codes[0]}`
                : undefined)
            : undefined,
          failedAt: Date.now(),
        };
      }
    },
    [refreshTokens, refreshRowSources],
  );

  /**
   * Drive a single cell from idle → pending → success/error. Closes any
   * open popover, sets up the abort controller, and emits the audit log
   * entry on completion.
   */
  const mintCell = React.useCallback(
    async (
      row: MintRow,
      audience: AudienceColumn,
      scopeOverride?: string,
    ): Promise<CellState> => {
      const key = cellKey(row.id, audience.key);
      const controller = new AbortController();
      const myGen = generationRef.current;
      // Local high-resolution timer captured BEFORE the React state update —
      // closing over `cells` for the failure-duration fallback was a stale-
      // snapshot bug that often yielded 0ms or wildly wrong values. Using a
      // locally captured `performance.now()` gives an honest wall-clock for
      // both success AND failure audit entries.
      const startedAt = performance.now();
      controllersRef.current.add(controller);
      setCells((prev) => ({
        ...prev,
        [key]: {
          kind: "pending",
          startedAt: Date.now(),
          controller,
        },
      }));
      let result: CellState;
      try {
        result = await performMint(
          row,
          audience,
          scopeOverride,
          controller.signal,
        );
      } finally {
        controllersRef.current.delete(controller);
      }
      // Stale-mint guard — if the row source changed (RT removed, page
      // unmounted) between request and response, discard the result.
      if (!mountedRef.current || myGen !== generationRef.current) {
        return result;
      }
      setCells((prev) => ({ ...prev, [key]: result }));

      // Audit — once per cell, success OR failure. NEVER includes token
      // material; only scope / durationMs / audience / row identifiers.
      const detail: AuditDetail = {
        rowKind: row.kind,
        rowId: row.id,
        audience: audience.key,
        scope: scopeOverride ?? audience.scope,
        durationMs:
          result.kind === "success"
            ? result.result.durationMs
            : Math.max(0, performance.now() - startedAt),
        tokenAudience:
          result.kind === "success" ? result.result.audience : undefined,
        aadError: result.kind === "error" ? result.aadError : undefined,
      };
      auditLog.record({
        actor: row.upn ?? row.oid ?? "operator",
        action: "audience_matrix_mint",
        target: `${row.id}|${audience.key}`,
        status: result.kind === "success" ? "success" : "failure",
        error: result.kind === "error" ? result.message : undefined,
        details: detail,
      });
      return result;
    },
    [performMint],
  );

  /**
   * Click handler for an individual cell. If the cell is already pending,
   * cancel it (abort controller + flip back to idle). If it's success/error,
   * re-mint (idempotent). If idle, mint.
   */
  const handleCellClick = React.useCallback(
    (row: MintRow, audience: AudienceColumn) => {
      const key = cellKey(row.id, audience.key);
      const state = cells[key];
      if (state?.kind === "pending") {
        // Cancel: abort + flip back to idle. The pending await will
        // resolve to the error "Cancelled." but the generation guard
        // ignores it since we don't bump generation here.
        state.controller.abort();
        setCells((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return;
      }
      // For the Custom column the scope comes from the operator's input
      // and must be non-empty.
      const scopeOverride =
        audience.key === "Custom" ? customScope : undefined;
      void mintCell(row, audience, scopeOverride);
    },
    [cells, mintCell, customScope],
  );

  /**
   * Mint every audience for one row in parallel (capped at 5 concurrent).
   * The header "Mint EVERYTHING" button shares this implementation by
   * looping every row.
   */
  const mintRow = React.useCallback(
    async (row: MintRow) => {
      const start = performance.now();
      const tasks = AUDIENCE_COLUMNS.map((aud) => async () => {
        if (aud.key === "Custom" && !customScope.trim()) {
          // Skip Custom when no scope is set — surfacing 1 error per row
          // for an empty scope would just spam audit-log.
          return null;
        }
        return mintCell(row, aud, aud.key === "Custom" ? customScope : undefined);
      });
      await runWithConcurrency(tasks, 5);
      setLastParallelMs(performance.now() - start);
    },
    [mintCell, customScope],
  );

  /** Mint a single audience across every visible row. */
  const mintColumn = React.useCallback(
    async (audience: AudienceColumn) => {
      const start = performance.now();
      const scopeOverride =
        audience.key === "Custom" ? customScope : undefined;
      const tasks = visibleRows.map((row) => async () =>
        mintCell(row, audience, scopeOverride),
      );
      await runWithConcurrency(tasks, 5);
      setLastParallelMs(performance.now() - start);
    },
    [visibleRows, mintCell, customScope],
  );

  /** Mint every cell in the grid. Confirmed via dialog. */
  const mintEverything = React.useCallback(async () => {
    const start = performance.now();
    const tasks: Array<() => Promise<unknown>> = [];
    for (const row of visibleRows) {
      for (const aud of AUDIENCE_COLUMNS) {
        if (aud.key === "Custom" && !customScope.trim()) continue;
        tasks.push(async () =>
          mintCell(row, aud, aud.key === "Custom" ? customScope : undefined),
        );
      }
    }
    await runWithConcurrency(tasks, 5);
    setLastParallelMs(performance.now() - start);
  }, [visibleRows, mintCell, customScope]);

  // -----------------------------------------------------------------------
  //  Refresh successful cells for a row
  // -----------------------------------------------------------------------
  //
  // Operator affordance: "I have a row with 4 minted audiences sitting at
  // 12m / 8m / 3m / expired. Just refresh THOSE — don't waste audit-log
  // entries on the audiences I didn't intend to mint."
  //
  // Debounced per row via a ref-keyed timestamp map so rapid double-clicks
  // collapse into a single refresh wave. The 1500ms window matches the
  // page-router elsewhere; long enough to catch a stutter, short enough not
  // to surprise the operator.

  const lastRowRefreshAtRef = React.useRef<Map<string, number>>(new Map());

  const refreshRowSuccessfulCells = React.useCallback(
    async (row: MintRow) => {
      const now = performance.now();
      const last = lastRowRefreshAtRef.current.get(row.id) ?? 0;
      if (now - last < 1500) return; // debounce
      lastRowRefreshAtRef.current.set(row.id, now);
      const tasks: Array<() => Promise<unknown>> = [];
      for (const aud of AUDIENCE_COLUMNS) {
        const k = cellKey(row.id, aud.key);
        const s = cells[k];
        if (!s || s.kind !== "success") continue;
        // Re-use the same scope the original mint used so a refresh of a
        // Custom-column success keeps the operator's typed scope rather
        // than falling back to whatever's in the input now.
        const scope = s.result.scope;
        tasks.push(async () =>
          mintCell(row, aud, aud.key === "Custom" ? scope : undefined),
        );
      }
      if (tasks.length === 0) return;
      const start = performance.now();
      await runWithConcurrency(tasks, 5);
      setLastParallelMs(performance.now() - start);
    },
    [cells, mintCell],
  );

  // -----------------------------------------------------------------------
  //  Bulk-confirmation dispatcher
  // -----------------------------------------------------------------------

  const handleConfirmBulk = React.useCallback(async () => {
    const kind = pendingBulk;
    const arg = pendingBulkArgRef.current;
    setPendingBulk(null);
    pendingBulkArgRef.current = null;
    if (!kind) return;
    if (kind === "all-everything") {
      await mintEverything();
    } else if (kind === "all-row" && arg?.rowId) {
      const row = visibleRows.find((r) => r.id === arg.rowId);
      if (row) await mintRow(row);
    } else if (kind === "all-column" && arg?.audienceKey) {
      const aud = AUDIENCE_COLUMNS.find((a) => a.key === arg.audienceKey);
      if (aud) await mintColumn(aud);
    }
  }, [pendingBulk, mintEverything, mintRow, mintColumn, visibleRows]);

  // -----------------------------------------------------------------------
  //  Summary stats — derived from the cells map.
  // -----------------------------------------------------------------------

  const summary = React.useMemo(() => {
    let total = visibleRows.length * AUDIENCE_COLUMNS.length;
    let minted = 0;
    let failed = 0;
    let pending = 0;
    const successRows: { durationMs: number }[] = [];
    for (const row of visibleRows) {
      for (const aud of AUDIENCE_COLUMNS) {
        const s = cells[cellKey(row.id, aud.key)];
        if (!s) continue;
        if (s.kind === "pending") pending++;
        else if (s.kind === "success") {
          minted++;
          successRows.push({ durationMs: s.result.durationMs });
        } else if (s.kind === "error") failed++;
      }
    }
    const timeSavedMs = computeTimeSavedMs(successRows, lastParallelMs);
    return { total, minted, failed, pending, timeSavedMs };
  }, [visibleRows, cells, lastParallelMs]);

  // -----------------------------------------------------------------------
  //  Export rows — flatten successful cells.
  // -----------------------------------------------------------------------

  interface ExportRow {
    rowId: string;
    rowKind: RowKind;
    displayName: string;
    upn?: string;
    tenantId: string;
    audience: string;
    scope: string;
    tokenAudience: string;
    expiresAt: number;
    minutesUntilExpiry: number;
    durationMs: number;
    accessToken?: string;
  }

  const exportRows = React.useMemo<ExportRow[]>(() => {
    const out: ExportRow[] = [];
    for (const row of visibleRows) {
      for (const aud of AUDIENCE_COLUMNS) {
        const s = cells[cellKey(row.id, aud.key)];
        if (!s || s.kind !== "success") continue;
        out.push({
          rowId: row.id,
          rowKind: row.kind,
          displayName: row.displayName,
          upn: row.upn,
          tenantId: row.tenantId,
          audience: aud.key,
          scope: s.result.scope,
          tokenAudience: s.result.audience,
          expiresAt: s.result.expiresAt,
          minutesUntilExpiry: Math.floor(
            Math.max(0, s.result.expiresAt - Math.floor(Date.now() / 1000)) /
              60,
          ),
          durationMs: Math.round(s.result.durationMs),
          // Token material gated by the operator-controlled checkbox.
          // Default OFF — the page only sets the field when the operator
          // ticks the box and is exporting JSON (CSV columns omit it
          // regardless to avoid massive Excel cells).
          ...(includeTokens ? { accessToken: s.result.accessToken } : {}),
        });
      }
    }
    return out;
  }, [visibleRows, cells, includeTokens]);

  const exportColumns = React.useMemo<ExportColumn<ExportRow>[]>(
    () => [
      { header: "Row ID", accessor: (r) => r.rowId },
      { header: "Row kind", accessor: (r) => r.rowKind },
      { header: "Display name", accessor: (r) => r.displayName },
      { header: "UPN", accessor: (r) => r.upn ?? "" },
      { header: "Tenant ID", accessor: (r) => r.tenantId },
      { header: "Audience", accessor: (r) => r.audience },
      { header: "Scope", accessor: (r) => r.scope },
      { header: "Token audience (aud)", accessor: (r) => r.tokenAudience },
      { header: "Expires at (epoch sec)", accessor: (r) => r.expiresAt },
      { header: "Minutes until expiry", accessor: (r) => r.minutesUntilExpiry },
      { header: "Duration (ms)", accessor: (r) => r.durationMs },
    ],
    [],
  );

  // -----------------------------------------------------------------------
  //  Tenant-switch listener
  // -----------------------------------------------------------------------
  // When the operator flips the global tenant for an account in the header
  // (or anywhere else), invalidate any in-flight mints whose row is the
  // affected account and re-pull the row sources so the matrix reflects the
  // new tenant id. We don't track a single "active row" on this page (the
  // matrix shows EVERY identity), so the sync is generation-bump + refresh
  // rather than `setActiveKey` like the single-account pages do.
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    const known = (state.azureAccounts ?? []).some(
      (a) => a.homeAccountId === candidate,
    );
    if (!known) return;
    // Bump generation so any pending mints for the swapped tenant discard
    // their late-arriving results, then re-read row sources so the
    // signed-in account row picks up the new tenantId.
    generationRef.current++;
    refreshRowSources();
  });

  // -----------------------------------------------------------------------
  //  Keyboard navigation
  // -----------------------------------------------------------------------
  //
  // Arrow keys + Home / End / PageUp / PageDown move focus across the matrix
  // grid. We intercept BEFORE the browser scrolls so the operator's arrow-
  // keys don't accidentally scroll a long page; only nav keys are consumed.
  // `nextCoord()` is a pure helper in audience-matrix-helpers.ts — see its
  // doc-comment for wrap behaviour.

  const handleGridKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTableElement>) => {
      const rowCount = visibleRows.length;
      const colCount = AUDIENCE_COLUMNS.length;
      if (rowCount === 0 || colCount === 0) return;
      // Only act on the navigation keys nextCoord knows about — otherwise
      // typing into an inline input must remain unblocked.
      const navKeys = new Set([
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ]);
      if (!navKeys.has(e.key)) return;
      // Don't hijack arrows while typing inside any input/textarea — the
      // Custom-scope and free-text-filter inputs are inside the grid's
      // ancestor card, so a stray focus shouldn't strand the operator.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const cur =
        focusedCoord ?? { rowIndex: 0, colIndex: 0 };
      const next = nextCoord(cur, e.key, rowCount, colCount);
      if (next === cur) return;
      e.preventDefault();
      setFocusedCoord(next);
      // Imperatively focus the new cell button so the visible focus ring
      // tracks our state. The cell button carries `data-row-index` /
      // `data-col-index` for selection — kept attribute-based so we don't
      // need a ref per cell (N × M refs would be wasteful).
      const sel = `[data-row-index="${next.rowIndex}"][data-col-index="${next.colIndex}"]`;
      const el = gridRef.current?.querySelector<HTMLButtonElement>(sel);
      el?.focus();
    },
    [visibleRows.length, focusedCoord],
  );

  // -----------------------------------------------------------------------
  //  Hovered row's client id — drives reachability highlight.
  // -----------------------------------------------------------------------
  // When the operator hovers/focuses a row in the matrix, the reachability
  // table dims unrelated audiences and highlights the audiences this row's
  // FOCI client can reach. Computed from the focused coord (NOT the hover —
  // hover would jitter on every mouse-move; focus stays stable).
  const focusedRowClientId = React.useMemo<string | null>(() => {
    if (!focusedCoord) return null;
    const row = visibleRows[focusedCoord.rowIndex];
    return row?.clientId ?? null;
  }, [focusedCoord, visibleRows]);

  // -----------------------------------------------------------------------
  //  Render
  // -----------------------------------------------------------------------

  const hasRows = visibleRows.length > 0;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-4">
        {/* Section A — Header */}
        <PageHeader
          title="Universal Audience Matrix"
          description={`Mint every well-known Azure audience for every imported refresh-token AND every signed-in account in one grid. ${rtCount} RT${rtCount === 1 ? "" : "s"} (covering ${distinctImportedAudiences} audience${distinctImportedAudiences === 1 ? "" : "s"}) · ${accountCount} signed-in account${accountCount === 1 ? "" : "s"}.`}
        >
          <TokenExpiryBadge
            secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
            loading={armTokenTracker.loading}
            onRefresh={armTokenTracker.refresh}
            alwaysShow={false}
            needsReauth={armTokenTracker.needsReauth}
            onReauth={() =>
              void armTokenTracker.reauth({
                loginHint: primaryAccount?.username,
              })
            }
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              // Bump generation so anything in flight is invalidated, then
              // re-read the row sources. The cells map is left alone so
              // visible success/error history persists across refreshes —
              // a refresh is meant to PICK UP newly-imported RTs without
              // wiping the operator's accumulated audit picture.
              generationRef.current++;
              refreshRowSources();
            }}
            aria-label="Refresh row list"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Refresh rows
          </Button>
        </PageHeader>

        {/*
          Signal C — Defender awareness banner.
          Cites the corpus paths driving the FOCI signal (`_AZURE_LOGIN_METHODS.md`,
          `_analysis_defender_view.md`, `dirkjanm/family-of-client-ids-research`).
          Dismiss state persists via `usePersistedState` under
          `FOCI_BANNER_DISMISS_KEY`. Dismissal emits an audit entry so the page
          stays consistent with the rest of the matrix (every operator-visible
          mutation is audited).
        */}
        {!bannerDismissed && (
          <Alert variant="info" role="region" aria-label="FOCI defender context">
            <Eye className="h-4 w-4" aria-hidden />
            <AlertTitle className="flex items-center justify-between gap-2 text-sm">
              <span>{DEFENDER_BANNER_COPY.title}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={dismissBanner}
                aria-label="Dismiss FOCI defender banner"
              >
                <X className="h-3 w-3" aria-hidden />
                Dismiss
              </Button>
            </AlertTitle>
            <AlertDescription className="space-y-2 text-xs">
              <p className="m-0">{DEFENDER_BANNER_COPY.body}</p>
              <p className="m-0 text-2xs text-muted-foreground">
                Corpus:{" "}
                {DEFENDER_BANNER_COPY.citationLines.map((line, idx) => (
                  <React.Fragment key={line}>
                    <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-3xs">
                      {line}
                    </code>
                    {idx < DEFENDER_BANNER_COPY.citationLines.length - 1
                      ? " · "
                      : ""}
                  </React.Fragment>
                ))}
              </p>
            </AlertDescription>
          </Alert>
        )}

        {/* Section B — Row source selector */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 p-3">
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Rows
            </span>
            {(
              [
                {
                  key: "rt" as const,
                  label: `Imported RTs (${rtCount})`,
                  icon: KeyRound,
                },
                {
                  key: "account" as const,
                  label: `Signed-in accounts (${accountCount})`,
                  icon: Users,
                },
                { key: "both" as const, label: "Both", icon: Layers },
              ]
            ).map(({ key, label, icon: Icon }) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={sourceFilter === key ? "default" : "outline"}
                onClick={() => setSourceFilter(key)}
                aria-pressed={sourceFilter === key}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {label}
              </Button>
            ))}

            {/* Recency filter chip — URL-persisted via `recent=1`. Uses the
                shared FilterChipRow so it matches the visual language of
                overview / sub-manager / role-graph / security-audit /
                audit-log filters. The chip set is single-entry; clicking
                "All" or the chip itself toggles `recentOnly`. */}
            <FilterChipRow
              label="Mint recency filter"
              value={
                recentOnly ? new Set(["recent"]) : new Set<string>()
              }
              onChange={(next) => setRecentOnly(next.has("recent"))}
              options={[
                {
                  key: "recent",
                  label: "Minted last 24h",
                  tone: "success",
                  icon: Clock,
                },
              ]}
              counts={{ recent: recentRowCount }}
              showAll={false}
              className="ml-1"
            />

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by name, UPN, tenant id, client id…"
                  className="h-8 w-72 pl-7 text-xs"
                  aria-label="Filter rows"
                />
              </div>
              <ExportMenu
                rows={exportRows}
                columns={exportColumns}
                filename="audience-matrix"
                jsonMetadata={{
                  source: "audience-matrix-page",
                  rowFilter: sourceFilter,
                  searchApplied: search.trim() || undefined,
                  recentOnly,
                  includeTokens,
                }}
                disabled={exportRows.length === 0}
              />
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={includeTokens}
                  onChange={(e) => setIncludeTokens(e.target.checked)}
                  aria-label="Include token material in JSON export"
                />
                Include token material in JSON
                <InfoTooltip content="OFF by default. When ON, the JSON export embeds the raw access_token for every successful cell. Treat the exported file as a secret — bearer tokens give the same access as the original sign-in." />
              </label>
            </div>
          </CardContent>
        </Card>

        {/* Bulk-mint controls + Custom scope input */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 p-3">
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Bulk
            </span>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => {
                pendingBulkArgRef.current = null;
                setPendingBulk("all-everything");
              }}
              disabled={!hasRows}
            >
              <Zap className="h-3.5 w-3.5" aria-hidden />
              Mint EVERYTHING
            </Button>
            <div className="ml-2 flex items-center gap-1.5">
              <span className="text-2xs uppercase tracking-wider text-muted-foreground">
                Custom scope
              </span>
              <InfoTooltip content="Used for the Custom column. Type a scope like `https://your-api.example/.default` or `<app-id>/.default`. The cell stays inert until a scope is provided." />
              <Input
                type="text"
                value={customScope}
                onChange={(e) => setCustomScope(e.target.value)}
                placeholder="https://your-api.example/.default"
                className="h-8 w-80 text-xs"
                aria-label="Custom column scope"
              />
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3" aria-hidden /> pending
              </span>
              <span className="inline-flex items-center gap-1">
                <Check className="h-3 w-3 text-success" aria-hidden /> minted
              </span>
              <span className="inline-flex items-center gap-1">
                <X className="h-3 w-3 text-destructive" aria-hidden /> rejected
              </span>
              <span>Concurrency cap: 5 mints in flight</span>
            </div>
          </CardContent>
        </Card>

        {/* Section D — Sort + density controls.
            Sort key + direction are URL-state-backed so deep links preserve the
            view. Density is persisted across reloads via usePersistedState.
            Both controls are operator-tuning; they never change the underlying
            data or fire audit-log entries. */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 p-3">
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sort
            </span>
            {(
              [
                { key: "name" as const, label: "Name" },
                { key: "kind" as const, label: "Kind" },
                { key: "tenant" as const, label: "Tenant" },
                { key: "client" as const, label: "Client" },
                { key: "minted" as const, label: "Minted" },
              ]
            ).map(({ key, label }) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={sortKey === key ? "default" : "outline"}
                onClick={() => setSortKey(key)}
                aria-pressed={sortKey === key}
              >
                {label}
              </Button>
            ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={toggleSortDir}
                  aria-label={`Toggle sort direction (current: ${sortDir})`}
                >
                  {sortDir === "asc" ? (
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {sortDir.toUpperCase()}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Click to toggle ascending / descending.
              </TooltipContent>
            </Tooltip>

            <span className="ml-3 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Density
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant={isCompact ? "default" : "outline"}
                  onClick={() =>
                    setDensity(isCompact ? "comfy" : "compact")
                  }
                  aria-pressed={isCompact}
                  aria-label="Toggle compact density"
                >
                  {isCompact ? (
                    <Maximize2 className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Minimize2 className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {isCompact ? "Comfy" : "Compact"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Compact density hides UPN + RT-prefix sub-rows in the identifier
                column and tightens vertical padding.
              </TooltipContent>
            </Tooltip>
            <span className="ml-auto text-2xs text-muted-foreground">
              Showing {visibleRows.length} of {allRows.length} rows.
            </span>
          </CardContent>
        </Card>

        {/* Audience-reachability companion table — defender-facing static
            reachability map from `audience-matrix-corpus.ts`. Collapsed by
            default; persists open-state across reloads. Highlights audiences
            reachable from the currently-focused row's source client_id. */}
        <AudienceReachabilityTable highlightClientId={focusedRowClientId} />

        {/* Section E — Summary stats */}
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Audience matrix summary"
        >
          <SummaryStatItem
            label="Cells"
            value={summary.total}
            hint={`${visibleRows.length} rows · ${AUDIENCE_COLUMNS.length} cols`}
          />
          <SummaryStatItem
            label="Minted"
            value={summary.minted}
            tone="success"
            hint="successful tokens"
          />
          <SummaryStatItem
            label="Failed"
            value={summary.failed}
            tone="destructive"
            hint="AAD rejected"
          />
          <SummaryStatItem
            label="In flight"
            value={summary.pending}
            tone="info"
            hint="currently minting"
          />
          <SummaryStatItem
            label="Time saved"
            value={fmtDurationMs(summary.timeSavedMs)}
            tone={summary.timeSavedMs > 0 ? "success" : "muted"}
            hint="vs serial mints"
          />
        </div>

        {/* Section C — The matrix table */}
        {!hasRows ? (
          <EmptyState
            icon={LayoutGrid}
            title="No rows match the current filters."
            description={
              rtCount + accountCount === 0
                ? "Import a refresh token via Token Importer or sign in via Azure Accounts to populate the matrix."
                : "Try widening the source-toggle chips or clearing the search input."
            }
            action={
              rtCount + accountCount === 0
                ? {
                    label: "Open Token Importer",
                    onClick: () => navigateToPage("/token-importer"),
                    icon: KeyRound,
                  }
                : undefined
            }
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                {/* ARIA-grid semantics. Per WAI-ARIA 1.2, a grid is a
                    composite widget — we explicitly mark the table
                    `role="grid"`, every header cell `role="columnheader"` /
                    `role="rowheader"`, and every data cell `role="gridcell"`.
                    Keyboard navigation is wired via `onKeyDown` at the grid
                    level (one listener, not N×M). */}
                <table
                  ref={gridRef}
                  role="grid"
                  aria-label="Audience matrix grid"
                  aria-rowcount={visibleRows.length + 1}
                  aria-colcount={AUDIENCE_COLUMNS.length + 2}
                  onKeyDown={handleGridKeyDown}
                  className={`w-full border-separate border-spacing-0 text-xs ${isCompact ? "audience-matrix-compact" : ""}`}
                >
                  <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                    <tr role="row" aria-rowindex={1}>
                      <th
                        scope="col"
                        role="columnheader"
                        aria-colindex={1}
                        className="sticky left-0 z-20 min-w-[260px] border-b border-r bg-card px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        Identity ({visibleRows.length})
                      </th>
                      {AUDIENCE_COLUMNS.map((aud, audIdx) => {
                        // Signal B — risk tier per audience column. The
                        // tier + rationale live in audience-matrix-corpus.ts;
                        // see that module's header for the citation chain.
                        const risk = getAudienceRisk(aud.key);
                        return (
                        <th
                          key={aud.key}
                          scope="col"
                          role="columnheader"
                          aria-colindex={audIdx + 2}
                          data-audience-risk={risk.tier}
                          className="border-b px-2 py-2 text-center text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          <div className="flex flex-col items-center gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className={`inline-flex h-4 items-center rounded px-1 font-mono text-3xs leading-none ${tierTextClass(risk.tier)} bg-muted/40`}
                                  aria-label={`Risk tier: ${risk.tier}`}
                                >
                                  {tierShort(risk.tier)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="m-0 max-w-xs text-xs">
                                  <span className="font-semibold">
                                    {risk.tier.toUpperCase()} risk
                                  </span>{" "}
                                  — {risk.rationale}
                                </p>
                                <p className="m-0 mt-1 text-3xs text-muted-foreground">
                                  Calibrated against{" "}
                                  <code className="font-mono">
                                    dafthack/azure-ad-first-party-apps-permissions
                                  </code>{" "}
                                  +{" "}
                                  <code className="font-mono">
                                    _analysis_dirkjanm.md
                                  </code>
                                  .
                                </p>
                              </TooltipContent>
                            </Tooltip>
                            <span className="inline-flex items-center gap-1">
                              {aud.short}
                              <InfoTooltip
                                content={
                                  <>
                                    <p className="m-0 text-xs font-semibold">
                                      {aud.key}
                                    </p>
                                    <p className="m-0 text-xs">
                                      {aud.description}
                                    </p>
                                    {aud.scope && (
                                      <p className="m-0 mt-1 font-mono text-3xs text-muted-foreground">
                                        {aud.scope}
                                      </p>
                                    )}
                                  </>
                                }
                              />
                            </span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => {
                                    pendingBulkArgRef.current = {
                                      audienceKey: aud.key,
                                    };
                                    setPendingBulk("all-column");
                                  }}
                                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-3xs text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  aria-label={`Mint ${aud.key} for every visible row`}
                                >
                                  <Play className="h-2.5 w-2.5" aria-hidden />
                                  all
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                Mint {aud.key} for every visible row
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </th>
                        );
                      })}
                      <th
                        scope="col"
                        role="columnheader"
                        aria-colindex={AUDIENCE_COLUMNS.length + 2}
                        className="border-b px-2 py-2 text-center text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        Mint row
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row, rowIdx) => {
                      const rowIdxEntry: RowCellIndexEntry | undefined =
                        rowCellIndex.get(row.id);
                      const successCount = rowIdxEntry?.successCount ?? 0;
                      return (
                      <tr
                        key={row.id}
                        role="row"
                        aria-rowindex={rowIdx + 2}
                        className="group hover:bg-accent/10"
                      >
                        <th
                          scope="row"
                          role="rowheader"
                          aria-colindex={1}
                          className={`sticky left-0 z-10 border-b border-r bg-card/95 text-left align-top backdrop-blur-sm group-hover:bg-accent/10 ${isCompact ? "px-2 py-1" : "px-3 py-2"}`}
                        >
                          <RowIdentifierCell row={row} compact={isCompact} />
                        </th>
                        {AUDIENCE_COLUMNS.map((aud, colIdx) => {
                          const k = cellKey(row.id, aud.key);
                          const cell = cells[k];
                          return (
                            <td
                              key={aud.key}
                              role="gridcell"
                              aria-colindex={colIdx + 2}
                              className={`border-b text-center align-middle ${isCompact ? "px-0.5 py-0" : "px-1 py-1"}`}
                            >
                              <MatrixCell
                                row={row}
                                audience={aud}
                                state={cell}
                                customScope={customScope}
                                isOpen={openCellKey === k}
                                rowIndex={rowIdx}
                                colIndex={colIdx}
                                nowSec={nowSec}
                                onOpenChange={(open) =>
                                  setOpenCellKey(open ? k : null)
                                }
                                onFocus={() =>
                                  setFocusedCoord({
                                    rowIndex: rowIdx,
                                    colIndex: colIdx,
                                  })
                                }
                                onClick={() => handleCellClick(row, aud)}
                                onReMint={() => {
                                  setOpenCellKey(null);
                                  void mintCell(
                                    row,
                                    aud,
                                    aud.key === "Custom"
                                      ? customScope
                                      : undefined,
                                  );
                                }}
                                onImportToVault={() => {
                                  if (cell?.kind !== "success") return;
                                  importSuccessIntoVault(
                                    row,
                                    aud,
                                    cell.result,
                                    store,
                                  );
                                  // The vault write affects `listImportedAccounts()`
                                  // (new audience bucket on this principal) — re-read
                                  // sources so the header subtitle's audience-count
                                  // and the row list stay accurate without forcing
                                  // the operator to hit "Refresh rows".
                                  refreshRowSources();
                                }}
                              />
                            </td>
                          );
                        })}
                        <td
                          role="gridcell"
                          aria-colindex={AUDIENCE_COLUMNS.length + 2}
                          className={`border-b text-center align-middle ${isCompact ? "px-0.5 py-0" : "px-1 py-1"}`}
                        >
                          <div className="inline-flex items-center gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    pendingBulkArgRef.current = {
                                      rowId: row.id,
                                    };
                                    setPendingBulk("all-row");
                                  }}
                                  aria-label={`Mint every audience for ${row.displayName}`}
                                >
                                  <Play className="h-3 w-3" aria-hidden />
                                  All
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                Mint every audience for this row (capped at 5
                                concurrent).
                              </TooltipContent>
                            </Tooltip>
                            {successCount > 0 && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      void refreshRowSuccessfulCells(row)
                                    }
                                    aria-label={`Refresh ${successCount} successful cell${successCount === 1 ? "" : "s"} for ${row.displayName}`}
                                  >
                                    <RefreshCw
                                      className="h-3 w-3"
                                      aria-hidden
                                    />
                                    <span className="text-3xs tabular-nums">
                                      {successCount}
                                    </span>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Re-mint only the {successCount} audience
                                  {successCount === 1 ? "" : "s"} that already
                                  succeeded for this row. Debounced to 1.5s.
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Section G — About footer */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">About this page</CardTitle>
            <CardDescription>
              What it does and why every cell click is a separate audit-log
              entry.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-foreground">
                  Legitimate use case
                </dt>
                <dd className="text-muted-foreground">
                  Audit which Azure resource APIs an identity (or a leaked /
                  pasted refresh token) can actually reach, in one view. The
                  grid replaces the "click Token Importer, exchange to ARM,
                  re-exchange to Graph, re-exchange to Batch…" loop that
                  operators previously walked manually.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">
                  Audit-log volume
                </dt>
                <dd className="text-muted-foreground">
                  Every cell mint emits one{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-3xs">
                    audience_matrix_mint
                  </code>{" "}
                  audit-log entry. "Mint EVERYTHING" can spike the log by
                  hundreds of entries — the confirmation dialog warns up
                  front so operators can opt out. Token material is NEVER
                  logged; only row identifiers, scope, audience and duration.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">RT rows</dt>
                <dd className="text-muted-foreground">
                  Driven by FOCI exchange against the source client id —
                  mints any audience the family covers without re-prompting.
                  Rotated refresh tokens are persisted back to the vault so
                  subsequent mints on the same row stay valid.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">Account rows</dt>
                <dd className="text-muted-foreground">
                  Driven by MSAL silent acquire via the existing per-audience
                  helpers (ARM, Graph, Batch). Non-standard audiences are
                  surfaced as a clear cell-level error directing the operator
                  to the RT path; arbitrary-scope MSAL acquire is out-of-scope
                  for this page.
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

      {/* Bulk confirmation dialog */}
      <ConfirmationDialog
        hidden={pendingBulk === null}
        title={
          pendingBulk === "all-everything"
            ? "Mint every cell?"
            : pendingBulk === "all-row"
              ? "Mint every audience for this row?"
              : "Mint this audience for every row?"
        }
        message={
          <div className="space-y-2">
            <p>
              {pendingBulk === "all-everything"
                ? `This will spawn ${visibleRows.length * AUDIENCE_COLUMNS.length} mint attempts (capped at 5 concurrent). Each ATTEMPT — success or failure — becomes one audit-log entry.`
                : pendingBulk === "all-row"
                  ? `This will spawn ${AUDIENCE_COLUMNS.length} mint attempts for the selected row.`
                  : `This will spawn ${visibleRows.length} mint attempts (one per visible row).`}
            </p>
            <p className="text-muted-foreground">
              Token material is NEVER logged — only scope / audience /
              duration / row identifiers. Cancel any cell mid-flight by
              clicking its spinner.
            </p>
          </div>
        }
        confirmText="Mint"
        cancelText="Cancel"
        danger={pendingBulk === "all-everything"}
        onConfirm={() => void handleConfirmBulk()}
        onCancel={() => {
          setPendingBulk(null);
          pendingBulkArgRef.current = null;
        }}
      />
    </TooltipProvider>
  );
};

// ---------------------------------------------------------------------------
//  RowIdentifierCell — leftmost sticky column. Distinct widget for RT rows
//  (shows client name + masked RT prefix) vs account rows (name + UPN).
// ---------------------------------------------------------------------------

const RowIdentifierCell: React.FC<{
  row: MintRow;
  /** When true, hide UPN + RT-prefix sub-rows for a tighter view. */
  compact?: boolean;
}> = ({ row, compact = false }) => {
  if (row.kind === "rt") {
    // Signal A — FOCI family detection.
    // Source: `dirkjanm/family-of-client-ids-research/known-foci-clients.csv`
    // — if the source client_id is on the published list, this RT is a
    // family refresh token (FRT) and can be redeemed for any other family
    // member's audience scopes. See `audience-matrix-corpus.ts`.
    const isFoci = clientIdIsFoci(row.clientId);
    const fociName = fociClientName(row.clientId);
    // Signal D — annotated FOCI-client profile (typical pre-consented scopes
    // + audiences). Only populated for clients we've curated; absence is NOT
    // proof of "no risk", only "not annotated".
    const profile = getFociClientProfile(row.clientId);
    return (
      <div className="flex flex-col gap-0.5">
        <span className="inline-flex items-center gap-1.5">
          <KeyRound className="h-3 w-3 text-info" aria-hidden />
          <span className="text-xs font-semibold">{row.displayName}</span>
          <Badge variant="info" className="text-3xs">
            RT
          </Badge>
          {isFoci && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="warning"
                  className="text-3xs"
                  aria-label="FOCI family refresh token"
                >
                  FOCI
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p className="m-0 max-w-xs text-xs">
                  <span className="font-semibold">Family of Client IDs.</span>{" "}
                  This RT was minted by{" "}
                  <code className="font-mono">{fociName ?? "a known FOCI client"}</code>
                  . AAD will redeem it for an access_token as any other family
                  member, with that member's pre-consented scopes — no
                  re-authentication required.
                </p>
                {profile && profile.highValueScopes.length > 0 && (
                  <div className="mt-2 border-t pt-2">
                    <p className="m-0 text-3xs font-semibold text-foreground">
                      Typical high-value scopes
                    </p>
                    <ul className="m-0 mt-0.5 list-disc pl-4 text-3xs text-muted-foreground">
                      {profile.highValueScopes.map((s) => (
                        <li key={s}>
                          <code className="font-mono">{s}</code>
                        </li>
                      ))}
                    </ul>
                    <p className="m-0 mt-1 text-3xs text-muted-foreground">
                      {profile.notes}
                    </p>
                  </div>
                )}
                <p className="m-0 mt-1 text-3xs text-muted-foreground">
                  Reference:{" "}
                  <code className="font-mono">
                    dirkjanm/family-of-client-ids-research
                  </code>
                  ,{" "}
                  <code className="font-mono">_AZURE_LOGIN_METHODS.md §FOCI</code>
                  ,{" "}
                  <code className="font-mono">
                    dafthack/azure-ad-first-party-apps-permissions
                  </code>
                  .
                </p>
              </TooltipContent>
            </Tooltip>
          )}
        </span>
        {!compact && row.upn && (
          <span className="text-3xs text-muted-foreground">{row.upn}</span>
        )}
        {!compact && (
          <span className="font-mono text-3xs text-muted-foreground">
            {shortTenant(row.tenantId)} · {row.rtPrefix}
          </span>
        )}
        {row.clientId && (
          <span className="font-mono text-3xs text-muted-foreground">
            client {row.clientId.slice(0, 8)}…
            {isFoci && fociName && (
              <span className="ml-1 text-3xs text-warning">({fociName})</span>
            )}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5">
        <Users className="h-3 w-3 text-primary" aria-hidden />
        <span className="text-xs font-semibold">{row.displayName}</span>
        <Badge variant="outline" className="text-3xs">
          MSAL
        </Badge>
      </span>
      {!compact && row.upn && (
        <span className="text-3xs text-muted-foreground">{row.upn}</span>
      )}
      {!compact && (
        <span className="font-mono text-3xs text-muted-foreground">
          tenant {shortTenant(row.tenantId)}
        </span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
//  MatrixCell — one cell in the grid. Renders the four state machine
//  variants and owns the result Popover (for success states).
// ---------------------------------------------------------------------------

interface MatrixCellProps {
  row: MintRow;
  audience: AudienceColumn;
  state: CellState | undefined;
  customScope: string;
  isOpen: boolean;
  /** Grid row index (0-based among visible rows). */
  rowIndex: number;
  /** Grid column index (0-based among AUDIENCE_COLUMNS). */
  colIndex: number;
  /** Shared 1Hz seconds-epoch from the page-level ticker. */
  nowSec: number;
  onOpenChange: (open: boolean) => void;
  onClick: () => void;
  onFocus: () => void;
  onReMint: () => void;
  onImportToVault: () => void;
}

/**
 * Single matrix cell — idle / pending / success / error variants.
 *
 * Memoised on its props so re-renders fire only when the cell's state or the
 * shared ticker actually moved. Without `React.memo` here, every cells-map
 * update would force a re-render across ALL cells in the table; with it,
 * only the cells whose row(or shared ticker) changed re-render. For a fully-
 * minted matrix this is the difference between O(N*M) and O(1) re-renders.
 */
const MatrixCellInner: React.FC<MatrixCellProps> = ({
  row,
  audience,
  state,
  customScope,
  isOpen,
  rowIndex,
  colIndex,
  nowSec,
  onOpenChange,
  onClick,
  onFocus,
  onReMint,
  onImportToVault,
}) => {
  // Disable when Custom column has no scope yet
  const customDisabled = audience.key === "Custom" && !customScope.trim();

  const dataAttrs = {
    "data-row-index": rowIndex,
    "data-col-index": colIndex,
  } as const;

  if (!state || state.kind === "idle") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            onFocus={onFocus}
            disabled={customDisabled}
            aria-label={`Mint ${audience.key} for ${row.displayName}`}
            {...dataAttrs}
            className="inline-flex h-7 w-full items-center justify-center rounded text-xs text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            –
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {customDisabled
            ? "Type a scope in the Custom field first."
            : `Click to mint ${audience.key} for ${row.displayName}.`}
        </TooltipContent>
      </Tooltip>
    );
  }

  if (state.kind === "pending") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            onFocus={onFocus}
            aria-label="Cancel mint"
            {...dataAttrs}
            className="inline-flex h-7 w-full items-center justify-center rounded text-info hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Loader2
              className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>Click to cancel mint</TooltipContent>
      </Tooltip>
    );
  }

  if (state.kind === "error") {
    const aadCode = state.aadError ?? "AAD error";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            onFocus={onFocus}
            aria-label={`Retry mint (failed: ${aadCode})`}
            {...dataAttrs}
            className="inline-flex h-7 w-full items-center justify-center gap-1 rounded text-3xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3 w-3" aria-hidden />
            <span className="max-w-[60px] truncate">{aadCode}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="m-0 max-w-xs whitespace-pre-wrap break-words text-xs">
            {state.message}
          </p>
          <p className="m-0 mt-1 text-3xs text-muted-foreground">
            Click to retry.
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // success — derive remaining seconds from the shared ticker so the cell
  // re-renders ONLY when the page's `nowSec` actually changes (1Hz max).
  const sec = Math.max(0, state.result.expiresAt - nowSec);
  const tone =
    sec < 60 ? "destructive" : sec < 5 * 60 ? "warning" : "success";
  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onFocus={onFocus}
          aria-label={`Token minted (${fmtRemaining(sec)} left) — open claims viewer`}
          {...dataAttrs}
          className="inline-flex h-7 w-full items-center justify-center gap-1 rounded hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Check
            className={`h-3 w-3 ${
              tone === "destructive"
                ? "text-destructive"
                : tone === "warning"
                  ? "text-warning"
                  : "text-success"
            }`}
            aria-hidden
          />
          <span
            className={`text-3xs tabular-nums ${
              tone === "destructive"
                ? "text-destructive"
                : tone === "warning"
                  ? "text-warning"
                  : "text-success"
            }`}
          >
            {fmtRemaining(sec)}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96" align="center" sideOffset={6}>
        <SuccessPopoverBody
          row={row}
          audience={audience}
          result={state.result}
          nowSec={nowSec}
          onReMint={onReMint}
          onImportToVault={onImportToVault}
        />
      </PopoverContent>
    </Popover>
  );
};

/**
 * Memo wrapper. Compares each prop shallowly; `onClick` / `onFocus` /
 * `onReMint` / `onImportToVault` / `onOpenChange` are reference-stable
 * across renders of a given (row, audience) pair because the parent uses
 * inline arrow functions per cell. So we can't rely on referential
 * equality there — but the non-callback props (state, isOpen, nowSec,
 * customScope, rowIndex, colIndex) are the ones that materially change
 * cell output. We compare just those; identical callbacks-with-new-refs
 * are intentionally treated as "no re-render needed".
 */
const MatrixCell = React.memo<MatrixCellProps>(
  MatrixCellInner,
  (prev, next) =>
    prev.state === next.state &&
    prev.isOpen === next.isOpen &&
    prev.nowSec === next.nowSec &&
    prev.customScope === next.customScope &&
    prev.rowIndex === next.rowIndex &&
    prev.colIndex === next.colIndex &&
    prev.row === next.row &&
    prev.audience === next.audience,
);

// ---------------------------------------------------------------------------
//  SuccessPopoverBody — decoded claims + actions for a successful cell.
// ---------------------------------------------------------------------------

/**
 * Single claim row inside the success popover. Renders the value in a
 * `group/copy` wrapper so the `<CopyButton>` reveals on hover/focus — same
 * affordance as `<CopyableText>` elsewhere in the app. When the value is
 * `(none)` we omit the copy button so it doesn't look click-bait.
 */
const ClaimRow: React.FC<{
  /** Term label (e.g. "aud", "tid"). */
  term: React.ReactNode;
  /** The claim value to render + copy. */
  value: string | undefined;
  /** Optional `aria-label` override for the copy button. */
  copyLabel?: string;
  /** Render the value in mono (default true for GUID-like claims). */
  mono?: boolean;
  /** Optional override to render a custom display node (e.g. the ISO exp). */
  display?: React.ReactNode;
}> = ({ term, value, copyLabel, mono = true, display }) => {
  const present = value !== undefined && value !== "" && value !== "(none)";
  return (
    <>
      <dt className="font-semibold text-muted-foreground">{term}</dt>
      <dd
        className={`group/copy inline-flex min-w-0 items-center gap-1 ${
          mono ? "font-mono" : ""
        } break-all`}
      >
        <span className="min-w-0 break-all">
          {display ?? (present ? value : "(none)")}
        </span>
        {present && value !== undefined && (
          <CopyButton
            value={value}
            ariaLabel={copyLabel ?? `Copy ${value} to clipboard`}
            iconSize={11}
          />
        )}
      </dd>
    </>
  );
};

const SuccessPopoverBody: React.FC<{
  row: MintRow;
  audience: AudienceColumn;
  result: MintSuccess;
  /** Shared 1Hz ticker. Drives the "Xm left" countdown without per-popover intervals. */
  nowSec: number;
  onReMint: () => void;
  onImportToVault: () => void;
}> = ({ row, audience, result, nowSec, onReMint, onImportToVault }) => {
  // Memoise the claim summary — `summariseFromJwt` walks the JWT payload
  // and the popover re-renders on every 1s tick from the shared clock.
  const claims = React.useMemo(
    () => summariseFromJwt(result.accessToken),
    [result.accessToken],
  );
  const appId = claims.azp ?? claims.appid;
  const expIso = claims.exp
    ? new Date(claims.exp * 1000).toISOString()
    : undefined;
  // Operator can expand all 30+ raw claims when they want them; collapsed
  // by default so the popover stays focused on the high-signal handful.
  const [expanded, setExpanded] = React.useState(false);
  // Full claim entries sorted alphabetically for stable rendering.
  const fullClaimEntries = React.useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const k of Object.keys(result.claims)) {
      const v = result.claims[k];
      if (v == null) continue;
      let s: string;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        s = String(v);
      } else {
        try {
          s = JSON.stringify(v);
        } catch {
          s = "(unserializable)";
        }
      }
      entries.push([k, s]);
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    return entries;
  }, [result.claims]);
  // Live remaining seconds from the shared ticker — same math as the cell.
  const remainingSec = Math.max(0, result.expiresAt - nowSec);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-3.5 w-3.5 text-success" aria-hidden />
          {audience.key} token
        </span>
        <Badge variant="outline" className="text-3xs tabular-nums">
          {fmtRemaining(remainingSec)} left
        </Badge>
      </div>

      <dl className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1 text-2xs">
        <ClaimRow
          term="aud"
          value={claims.aud}
          copyLabel="Copy audience claim"
        />
        <ClaimRow
          term={
            <>
              tid
              <InfoTooltip
                content="Tenant id of the token (the directory whose RBAC applies)."
                withProvider={false}
              />
            </>
          }
          value={claims.tid}
          copyLabel="Copy tenant id"
        />
        <ClaimRow
          term={
            <>
              azp / appid
              <InfoTooltip
                content="The AAD app id that minted the token. For FOCI mints, this is the TARGET client id."
                withProvider={false}
              />
            </>
          }
          value={appId}
          copyLabel="Copy app id"
        />
        <ClaimRow
          term="scp"
          value={claims.scp}
          mono={false}
          copyLabel="Copy scope claim"
        />
        <ClaimRow term="oid" value={claims.oid} copyLabel="Copy object id" />
        <ClaimRow
          term="exp"
          value={expIso}
          display={expIso ?? "(none)"}
          copyLabel="Copy expiry ISO timestamp"
        />
      </dl>

      {/* Row-context row so the operator can re-copy the source row's
          identifiers without leaving the popover. Useful when correlating
          a successful mint back to the imported RT it came from. */}
      {(row.clientId || row.tenantId) && (
        <dl className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1 border-t pt-2 text-2xs">
          {row.clientId && (
            <ClaimRow
              term="src appid"
              value={row.clientId}
              copyLabel="Copy source client id"
            />
          )}
          <ClaimRow
            term="row tid"
            value={row.tenantId}
            copyLabel="Copy row tenant id"
          />
        </dl>
      )}

      {/* Full claims expansion — collapsed by default so the popover stays
          focused on the high-signal handful. Operators who need every claim
          (scope auditing, manual debugging) can click to expand and copy
          values via the per-row copy button. */}
      <div className="border-t pt-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 text-3xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "Hide" : "Show"} all {fullClaimEntries.length} claims
        </button>
        {expanded && (
          <dl className="mt-1 grid max-h-48 grid-cols-[100px_1fr] gap-x-2 gap-y-1 overflow-y-auto text-2xs">
            {fullClaimEntries.map(([k, v]) => (
              <ClaimRow key={k} term={k} value={v} copyLabel={`Copy ${k}`} />
            ))}
          </dl>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onReMint}
          aria-label="Re-mint this token"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Re-mint
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onImportToVault}
          aria-label="Import this token into the vault"
        >
          <Sparkles className="h-3 w-3" aria-hidden />
          Import to vault
        </Button>
        <div className="ml-auto inline-flex items-center gap-1 text-3xs text-muted-foreground">
          <Copy className="h-3 w-3" aria-hidden />
          <span>raw token</span>
          <CopyButton value={result.accessToken} alwaysVisible iconSize={12} />
        </div>
      </div>
      <Alert variant="warning" className="py-2">
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
        <AlertTitle className="text-2xs">Treat as a secret</AlertTitle>
        <AlertDescription className="text-3xs">
          The raw token grants the same access as the original sign-in. Don't
          paste it into chat / tickets / commits. NEVER auto-open external
          decoders (jwt.io etc.) with the token in the URL fragment — the
          decoder host receives the bearer. Copy locally and paste manually
          if you need to inspect outside this popover.
        </AlertDescription>
      </Alert>
    </div>
  );
};

// ---------------------------------------------------------------------------
//  importSuccessIntoVault — write a successful mint into the imported-tokens
//  module so the rest of the WebUI sees it. Kept at module scope so the
//  matrix cell can call it without prop-drilling the store.
// ---------------------------------------------------------------------------

function importSuccessIntoVault(
  row: MintRow,
  audience: AudienceColumn,
  result: MintSuccess,
  store: ReturnType<typeof useMultiRegionStore>,
): void {
  // Map the minted token's actual audience back onto the canonical
  // ARM/Graph/Batch buckets the rest of the WebUI routes on. Falls back
  // to "unknown" — those tokens are still cached by homeAccountId so the
  // operator can re-find them in Token Importer.
  const bucket = classifyAudience(result.audience);
  const claims = result.claims;
  const oid =
    typeof claims.oid === "string"
      ? (claims.oid as string)
      : row.oid;
  const tid =
    typeof claims.tid === "string"
      ? (claims.tid as string)
      : row.tenantId;
  const homeAccountId = `${oid}.${tid}`;
  const upn =
    (claims.preferred_username as string | undefined) ??
    (claims.upn as string | undefined) ??
    row.upn;
  const name = (claims.name as string | undefined) ?? row.displayName;
  importToken({
    jwt: result.accessToken,
    homeAccountId,
    tenantId: tid,
    oid,
    upn,
    name,
    audience: bucket,
    rawAudience: result.audience,
    expiresAt: result.expiresAt,
    claims,
  });
  auditLog.record({
    actor: upn ?? oid ?? "operator",
    action: "import_token",
    target: `${bucket} @ ${tid}`,
    status: "success",
    details: {
      oid,
      tenantId: tid,
      audience: bucket,
      rawAudience: result.audience,
      source: "audience-matrix-import",
      audienceColumn: audience.key,
      rowKind: row.kind,
    },
  });
  store.addNotification({
    type: "success",
    message: `Imported ${audience.key} token for ${name ?? upn ?? oid} into the vault.`,
  });
}
