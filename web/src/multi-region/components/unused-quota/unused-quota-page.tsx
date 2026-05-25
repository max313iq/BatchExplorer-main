/**
 * Unused Quota page — surfaces accounts with free LP cores and offers
 * bulk auto-create of pools or hand-off to Smart Mode pool creation.
 *
 * 2026-05-24 rewrite highlights:
 *   - FIX: bulk auto-create now dispatches `create_pools` (plural, the
 *     real action) grouped by `(vmSize, maxLpNodes)`. The previous code
 *     called `action: "create_pool"` (singular), which is NOT a valid
 *     OrchestratorAction and threw "Unknown action" at runtime, so the
 *     drawer's "Auto-Create Pools" button silently no-op'd.
 *   - Search input over account name + subscription id + region.
 *   - Filter chips: regions (URL-synced), GPU-only, resizing-state,
 *     min-free-LP-cores threshold (slider in the toolbar).
 *   - Expanded summary stats including free dedicated cores, distinct
 *     regions, and the *spawn-able* node total across selected rows.
 *   - Per-row override of VM size + node count in the bulk drawer, with
 *     live total of cores that will be consumed.
 *   - Result panel inside the drawer after submit: per-row created /
 *     failed status with a "Retry failed only" affordance.
 *   - CopyableText for account name + subscription id + suggested VM —
 *     hover any row cell and a small copy icon appears.
 *   - Inline InfoTooltips on every column header (LP quota, dedicated
 *     quota, suggested VM logic, max nodes formula, resizing meaning).
 *   - Page-level ExportMenu (CSV + JSON) for the current filtered view,
 *     in addition to the DataTable's column-scoped CSV button.
 *   - Keyboard: `/` to focus search, `Esc` to clear selection / close
 *     drawer, `r` to refresh.
 *   - Selection persisted in URL (`sel=id1,id2,...`) so a refresh /
 *     deep-link preserves the bulk-action set.
 *   - Per-row quick actions: "Use this row in Smart Mode" and "Copy
 *     account JSON" to support one-off operator workflows.
 *
 * Preserves: useArmToken + TokenExpiryBadge (Pattern A), live-catalog
 * wire toggle + persistence, ErrorBoundary, region-rollup cards.
 */
import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Filter,
  Minus,
  PiggyBank,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Trash2,
  Users,
  X,
  XCircle,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, formatNumber, pluralize } from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useUrlState } from "../../hooks/use-url-state";
import { useDashboardOutletContext } from "../page-router";
import { auditLog } from "../../services/audit-log";
import { buildPoolConfigFromDefaults } from "../../store/pool-defaults";
import type { PoolDefaults } from "../../store/pool-defaults";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import { useLiveCatalogAvailable } from "../vm-catalog/use-live-catalog-available";
import { AccountInfo } from "../../store/store-types";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import {
  DataTable,
  DataTableColumn,
} from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu } from "../shared/export-menu";
import {
  FilterChipRow,
  type FilterChipOption,
} from "../shared/filter-chip-row";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { RegionBadge } from "../shared/region-badge";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import {
  BorderBeam,
  DotPattern,
  Meteors,
  NumberTicker,
} from "@/components/ui/effects";
import {
  getAllVmSizes,
  getGpuVmSizes,
  getVCpus,
  getVmSizeInfo,
  VmSizeInfo,
} from "../shared/vm-sizes";

// Priority list for suggesting VM sizes — biggest first, so we use as much
// of the free LP quota as possible per pool node. The fallback path picks
// the largest GPU SKU that still fits when none of these line up.
const VM_PRIORITY_LIST = [
  "Standard_ND40rs_v2",
  "Standard_ND96isr_H100_v5",
  "Standard_NC24s_v3",
  "Standard_NC12s_v3",
  "Standard_NC6s_v3",
];

export interface UnusedQuotaPageProps {
  orchestrator: OrchestratorAgent;
  /**
   * @deprecated Path-based navigation now comes from
   * `useDashboardOutletContext().navigateToPage`. Kept for backward
   * compatibility with the existing page-router adapter, which still
   * threads it through. New callers should rely on the context wiring
   * and ignore this prop.
   *
   * COORDINATOR: when the migration is complete and no caller still
   * passes `onNavigate`, drop this prop from the interface and from the
   * page-router adapter at `UnusedQuotaRoute` (page-router.tsx ~ line 370).
   */
  onNavigate?: (path: string) => void;
}

/**
 * Capacity-shape filter for the LP-only / Dedicated-only / both chip
 * row. Persisted to localStorage so the operator's preferred capacity
 * lens survives reloads (unlike most other filters, this one rarely
 * changes within a session — keeping it in the URL would clutter the
 * sharable deep-link).
 */
type CapacityShape = "lp" | "dedicated" | "either" | "both";

const CAPACITY_SHAPE_OPTIONS: ReadonlyArray<FilterChipOption> = [
  { key: "either", label: "Any capacity", tone: "default" },
  { key: "lp", label: "LP-only", tone: "info" },
  { key: "dedicated", label: "Dedicated-only", tone: "warning" },
  { key: "both", label: "Both LP & Dedicated", tone: "success" },
];

const CAPACITY_SHAPES: ReadonlySet<CapacityShape> = new Set([
  "either",
  "lp",
  "dedicated",
  "both",
]);

function isCapacityShape(value: unknown): value is CapacityShape {
  return typeof value === "string" && CAPACITY_SHAPES.has(value as CapacityShape);
}

/**
 * Build the Azure portal deep-link for a subscription. Used by the
 * per-row "Open in portal" action. Format matches the convention used
 * across the rest of the app (see ea-subscription-page.tsx etc.).
 */
function portalSubscriptionUrl(subscriptionId: string): string {
  return `https://portal.azure.com/#@/resource/subscriptions/${encodeURIComponent(subscriptionId)}/overview`;
}

interface EnvVar {
  name: string;
  value: string;
}

interface QuotaRow {
  id: string;
  accountName: string;
  region: string;
  subscriptionId: string;
  lpQuota: number;
  lpUsed: number;
  lpFree: number;
  dedicatedQuota: number;
  dedicatedUsed: number;
  dedicatedFree: number;
  isResizing: boolean;
  suggestedVm: string;
  suggestedVmVCpus: number;
  suggestedIsGpu: boolean;
  maxNodes: number;
  utilizationPct: number; // 0–100, lpUsed / lpQuota
  accountInfo: AccountInfo;
}

interface RegionRollup {
  region: string;
  accounts: number;
  freeLpCores: number;
  freeDedicatedCores: number;
  accountIds: string[];
}

/** Per-row override layer used inside the bulk drawer. */
interface BulkOverride {
  vmSize: string;
  nodes: number;
}

/** Result row after a bulk submit — surfaced in the in-drawer result panel. */
interface SubmitResult {
  id: string;
  accountName: string;
  region: string;
  status: "created" | "failed" | "skipped";
  vmSize: string;
  nodes: number;
  error?: string;
}

function getSuggestedVm(freeLpCores: number): VmSizeInfo | null {
  for (const vmName of VM_PRIORITY_LIST) {
    const vcpus = getVCpus(vmName);
    if (freeLpCores >= vcpus) {
      const allVms = getAllVmSizes();
      const found = allVms.find(
        (v) => v.name.toLowerCase() === vmName.toLowerCase(),
      );
      if (found) return found;
    }
  }
  // Fallback: pick the largest GPU VM that fits
  const allVms = getAllVmSizes();
  const gpuVms = allVms
    .filter((v) => v.isGpu && v.vCPUs <= freeLpCores)
    .sort((a, b) => b.vCPUs - a.vCPUs);
  return gpuVms.length > 0 ? gpuVms[0] : null;
}

/**
 * Group a flat list of `(row, override)` pairs by their effective
 * `(vmSize, nodes)` pair so we can dispatch a single `create_pools`
 * action per unique config — instead of one call per row, which would
 * spawn one sticky task per account and flood the activity log.
 */
function groupForDispatch(
  pairs: Array<{ row: QuotaRow; vmSize: string; nodes: number }>,
): Map<string, Array<{ row: QuotaRow; vmSize: string; nodes: number }>> {
  const groups = new Map<
    string,
    Array<{ row: QuotaRow; vmSize: string; nodes: number }>
  >();
  for (const p of pairs) {
    const key = `${p.vmSize}|${p.nodes}`;
    const cur = groups.get(key) ?? [];
    cur.push(p);
    groups.set(key, cur);
  }
  return groups;
}

const UnusedQuotaPageInner: React.FC<UnusedQuotaPageProps> = ({
  orchestrator,
  onNavigate,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const poolDefaults: PoolDefaults | undefined = state.poolDefaults;

  // Path-based navigation comes from the dashboard outlet context.
  // Fall back to the legacy `onNavigate` prop so adapters that haven't
  // been migrated yet continue to work — see the deprecation note on
  // `UnusedQuotaPageProps.onNavigate`.
  //
  // COORDINATOR: once every adapter pulls from
  // `useDashboardOutletContext`, the `onNavigate` prop + this fallback
  // chain can be removed.
  const outletNavigate = useDashboardOutletContext().navigateToPage;
  const navigateToPath = React.useCallback(
    (path: string) => {
      if (outletNavigate) {
        outletNavigate(path);
      } else if (onNavigate) {
        onNavigate(path);
      }
    },
    [outletNavigate, onNavigate],
  );

  // Pattern A: ARM-token expiry awareness using the first signed-in
  // account. Unused Quota is a multi-account view (no single picker), so
  // the badge is a heads-up that the primary signed-in account's token
  // is about to need a refresh before the operator clicks through to a
  // token-heavy action (e.g. bulk auto-create pools).
  const primaryAccount = (state.azureAccounts ?? [])[0];
  const armTokenTracker = useArmToken(
    primaryAccount?.homeAccountId,
    primaryAccount?.tenantId,
  );

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showOnlyFree, setShowOnlyFree] = React.useState(false);
  // GPU-only restricts both the suggested-VM filter and the row eligibility.
  const [gpuOnly, setGpuOnly] = React.useState(true);
  // Resizing filter: "all" = no filter, "exclude" hide actively-resizing,
  // "only" show only currently-resizing rows.
  const [resizingFilter, setResizingFilter] = React.useState<
    "all" | "exclude" | "only"
  >("all");
  // Minimum free LP cores cutoff — operator-tunable threshold for "interesting".
  const [minFreeCores, setMinFreeCores] = React.useState(0);
  // Free-text search across accountName + subscriptionId + region.
  const [searchText, setSearchText] = React.useState("");
  // Compact density toggle on the table.
  const [compactDensity, setCompactDensity] = React.useState(false);

  // Capacity-shape filter (LP-only / Dedicated-only / both). Persisted to
  // localStorage because it represents an operator preference rather than
  // a per-link filter (so it's not in the URL). See `usePersistedState`
  // versioning contract — bump `version` if `CapacityShape` ever grows
  // values not present in `CAPACITY_SHAPES`.
  const [capacityShape, setCapacityShape] = usePersistedState<CapacityShape>(
    "unused-quota.capacity-shape",
    "either",
    {
      version: 1,
      deserialize: (raw) => {
        try {
          const parsed = JSON.parse(raw) as unknown;
          return isCapacityShape(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      },
    },
  );
  const capacityShapeSet = React.useMemo(
    () => new Set([capacityShape]),
    [capacityShape],
  );
  const onCapacityShapeChange = React.useCallback(
    (next: Set<string>) => {
      // FilterChipRow is multi-select by default — every click toggles
      // membership in the Set. We coerce it to single-select semantics
      // here by:
      //   - picking the newly-added key (set difference vs current) if any,
      //   - else falling back to "either" when the user clicked the
      //     currently-active chip (set went empty after the toggle).
      let chosen: CapacityShape | null = null;
      for (const k of next) {
        if (!capacityShapeSet.has(k) && isCapacityShape(k)) {
          chosen = k;
          break;
        }
      }
      if (chosen) {
        setCapacityShape(chosen);
      } else {
        // User clicked the active chip — un-toggle to "either" (the
        // baseline no-filter state).
        setCapacityShape("either");
      }
    },
    [capacityShapeSet, setCapacityShape],
  );

  // Master live-catalog wire toggle — hydrated from / persisted to user
  // preferences. Shared with Pool Creation; the toggle here is a
  // convenient place to flip the wire before clicking "Use in Smart
  // Mode" so the destination Pool Creation page lands in the desired
  // mode.
  const [liveCatalogEnabled, setLiveCatalogEnabled] = React.useState<boolean>(
    () => store.getUserPreferences().liveVmCatalogEnabled,
  );

  // URL-synced filters + selection. Selection lives in the URL too so
  // F5/deep-link preserves it (`sel=id1,id2,...`).
  const [urlFilters, setUrlFilters] = useUrlState({
    regions: [] as string[],
    sel: [] as string[],
  });
  const selectedRegions = urlFilters.regions;

  // The DataTable's selection prop wants a Set<string> — derive from URL.
  const selectedIds = React.useMemo(
    () => new Set(urlFilters.sel),
    [urlFilters.sel],
  );
  const setSelectedIds = React.useCallback(
    (next: Set<string>) => {
      setUrlFilters({ sel: Array.from(next) });
    },
    [setUrlFilters],
  );

  // Catalog availability — pick a representative sub for the cache lookup.
  // Unused Quota is a multi-sub view but the cache is keyed per-sub; we
  // use the first sub of the selected rows (or the first sub in state)
  // as the probe. If THAT sub has no cache entry, the toggle is disabled.
  const probeSubId = React.useMemo<string | undefined>(() => {
    const fromSelected = selectedIds.size > 0
      ? Array.from(selectedIds)[0]
      : undefined;
    if (fromSelected) {
      const acct = state.accounts.find((a) => a.id === fromSelected);
      if (acct?.subscriptionId) return acct.subscriptionId;
    }
    return state.subscriptions[0]?.subscriptionId;
  }, [selectedIds, state.accounts, state.subscriptions]);
  const catalogAvailability = useLiveCatalogAvailable(probeSubId);
  const liveCatalogEffective =
    liveCatalogEnabled && catalogAvailability.available;
  const toggleLiveCatalog = React.useCallback(
    (next: boolean) => {
      setLiveCatalogEnabled(next);
      store.saveUserPreferences({ liveVmCatalogEnabled: next });
    },
    [store],
  );

  // Bulk-action drawer state
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [autoCreateSubmitting, setAutoCreateSubmitting] = React.useState(false);
  const [showAutoCreateConfirm, setShowAutoCreateConfirm] =
    React.useState(false);
  // Per-row overrides keyed by row id. Reset whenever the drawer is
  // re-opened so stale data from a previous selection doesn't leak.
  const [overrides, setOverrides] = React.useState<Map<string, BulkOverride>>(
    new Map(),
  );
  // After-submit result panel state. `null` while we're still in
  // configure mode; populated once submitAutoCreate runs.
  const [submitResults, setSubmitResults] = React.useState<
    SubmitResult[] | null
  >(null);

  // Start task config for auto-create
  const [commandLine, setCommandLine] = React.useState("");
  const [envVars, setEnvVars] = React.useState<EnvVar[]>([
    { name: "", value: "" },
  ]);
  const [maxRetryCount, setMaxRetryCount] = React.useState(3);
  const [waitForSuccess, setWaitForSuccess] = React.useState(true);

  // Build rows from accountInfos
  const allRows: QuotaRow[] = React.useMemo(() => {
    return state.accountInfos.map((acct) => {
      const isResizing = state.poolInfos.some(
        (p) => p.accountId === acct.id && p.allocationState === "resizing",
      );
      const suggested = getSuggestedVm(acct.lowPriorityCoresFree);
      const suggestedVmVCpus = suggested?.vCPUs ?? 1;
      const maxNodes = suggested
        ? Math.floor(acct.lowPriorityCoresFree / suggestedVmVCpus)
        : 0;
      const utilizationPct =
        acct.lowPriorityCoreQuota > 0
          ? Math.round(
              (acct.lowPriorityCoresUsed / acct.lowPriorityCoreQuota) * 100,
            )
          : 0;

      return {
        id: acct.id,
        accountName: acct.accountName,
        region: acct.region,
        subscriptionId: acct.subscriptionId,
        lpQuota: acct.lowPriorityCoreQuota,
        lpUsed: acct.lowPriorityCoresUsed,
        lpFree: acct.lowPriorityCoresFree,
        dedicatedQuota: acct.dedicatedCoreQuota,
        dedicatedUsed: acct.dedicatedCoresUsed,
        dedicatedFree: acct.dedicatedCoresFree,
        isResizing,
        suggestedVm: suggested?.name ?? "N/A",
        suggestedVmVCpus,
        suggestedIsGpu: suggested?.isGpu === true,
        maxNodes,
        utilizationPct,
        accountInfo: acct,
      };
    });
  }, [state.accountInfos, state.poolInfos]);

  // All distinct regions (from rows, not state — keeps dropdown in sync)
  const allRegions = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) set.add(r.region);
    return Array.from(set).sort();
  }, [allRows]);

  // Per-region rollups
  const regionRollups: RegionRollup[] = React.useMemo(() => {
    const map = new Map<string, RegionRollup>();
    for (const r of allRows) {
      const cur = map.get(r.region) ?? {
        region: r.region,
        accounts: 0,
        freeLpCores: 0,
        freeDedicatedCores: 0,
        accountIds: [],
      };
      cur.accounts += 1;
      cur.freeLpCores += r.lpFree;
      cur.freeDedicatedCores += r.dedicatedFree;
      cur.accountIds.push(r.id);
      map.set(r.region, cur);
    }
    return Array.from(map.values()).sort(
      (a, b) => b.freeLpCores - a.freeLpCores,
    );
  }, [allRows]);

  // Apply filters
  const filteredRows = React.useMemo(() => {
    let result = allRows;
    if (showOnlyFree) {
      result = result.filter((r) => r.lpFree > 0);
    }
    if (gpuOnly) {
      result = result.filter((r) => r.suggestedIsGpu || r.lpFree === 0);
    }
    if (resizingFilter === "exclude") {
      result = result.filter((r) => !r.isResizing);
    } else if (resizingFilter === "only") {
      result = result.filter((r) => r.isResizing);
    }
    if (minFreeCores > 0) {
      result = result.filter((r) => r.lpFree >= minFreeCores);
    }
    if (selectedRegions.length > 0) {
      const allowed = new Set(selectedRegions);
      result = result.filter((r) => allowed.has(r.region));
    }
    // Capacity-shape lens — collapse a row down to its capacity profile.
    //   - lp        : has free LP cores, no free dedicated.
    //   - dedicated : has free dedicated cores, no free LP.
    //   - both      : has both LP and dedicated.
    //   - either    : no filter (default).
    if (capacityShape !== "either") {
      result = result.filter((r) => {
        const hasLp = r.lpFree > 0;
        const hasDed = r.dedicatedFree > 0;
        if (capacityShape === "lp") return hasLp && !hasDed;
        if (capacityShape === "dedicated") return hasDed && !hasLp;
        if (capacityShape === "both") return hasLp && hasDed;
        return true;
      });
    }
    const q = searchText.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (r) =>
          r.accountName.toLowerCase().includes(q) ||
          r.subscriptionId.toLowerCase().includes(q) ||
          r.region.toLowerCase().includes(q),
      );
    }
    return result;
  }, [
    allRows,
    showOnlyFree,
    gpuOnly,
    resizingFilter,
    minFreeCores,
    selectedRegions,
    searchText,
    capacityShape,
  ]);

  // Selected rows derived from selectedIds
  const selectedRows = React.useMemo(
    () => allRows.filter((r) => selectedIds.has(r.id)),
    [allRows, selectedIds],
  );

  // Summary stats (whole dataset, not filtered). Derived sums are
  // wrapped in `useMemo` so they don't recompute on unrelated state
  // changes (drawer open/close, search keystrokes, etc.). `allRows` is
  // itself memoised, so this is effectively a one-shot compute per
  // accountInfos/poolInfos change.
  const summary = React.useMemo(() => {
    let totalFreeLpCores = 0;
    let totalFreeDedicatedCores = 0;
    let totalLpQuota = 0;
    let accountsWithFreeQuota = 0;
    let accountsWithFreeDedicated = 0;
    let spawnableNodes = 0;
    const distinctSubs = new Set<string>();
    const subsWithCapacity = new Set<string>();
    for (const r of allRows) {
      totalFreeLpCores += r.lpFree;
      totalFreeDedicatedCores += r.dedicatedFree;
      totalLpQuota += r.lpQuota;
      if (r.lpFree > 0) accountsWithFreeQuota += 1;
      if (r.dedicatedFree > 0) accountsWithFreeDedicated += 1;
      spawnableNodes += r.maxNodes;
      if (r.subscriptionId) {
        distinctSubs.add(r.subscriptionId);
        if (r.lpFree > 0 || r.dedicatedFree > 0) {
          subsWithCapacity.add(r.subscriptionId);
        }
      }
    }
    return {
      totalAccounts: allRows.length,
      totalFreeLpCores,
      totalFreeDedicatedCores,
      totalLpQuota,
      accountsWithFreeQuota,
      accountsWithFreeDedicated,
      spawnableNodes,
      distinctRegionsCount: allRegions.length,
      distinctSubsCount: distinctSubs.size,
      subsWithCapacityCount: subsWithCapacity.size,
    } as const;
  }, [allRows, allRegions.length]);
  const {
    totalAccounts,
    totalFreeLpCores,
    totalFreeDedicatedCores,
    totalLpQuota,
    accountsWithFreeQuota,
    spawnableNodes,
    distinctRegionsCount,
    distinctSubsCount,
    subsWithCapacityCount,
  } = summary;
  // Active filter count drives the "X filters active" badge in the toolbar.
  const activeFilterCount = React.useMemo(() => {
    let n = 0;
    if (showOnlyFree) n += 1;
    if (gpuOnly) n += 1;
    if (resizingFilter !== "all") n += 1;
    if (minFreeCores > 0) n += 1;
    if (selectedRegions.length > 0) n += 1;
    if (searchText.trim()) n += 1;
    if (capacityShape !== "either") n += 1;
    return n;
  }, [
    showOnlyFree,
    gpuOnly,
    resizingFilter,
    minFreeCores,
    selectedRegions,
    searchText,
    capacityShape,
  ]);

  // Free-vs-quota ratio drives the tone of the summary cards. The thresholds
  // are intentionally generous: lots of unused quota should read "warning"
  // (capacity is sitting idle) rather than "success".
  //   - >= 50% of LP cores free  -> warning (significant idle capacity)
  //   - >= 20% free              -> info    (some headroom)
  //   - >  0% free               -> success (most quota in use, healthy)
  //   - == 0% free               -> muted   (fully consumed / nothing to use)
  const { freeLpRatio, freeAccountsRatio, freeLpTone, freeAccountsTone } =
    React.useMemo(() => {
      const lpRatio = totalLpQuota > 0 ? totalFreeLpCores / totalLpQuota : 0;
      const acctRatio =
        totalAccounts > 0 ? accountsWithFreeQuota / totalAccounts : 0;
      type CardTone = "info" | "success" | "warning" | "muted";
      const pickTone = (ratio: number, hasAny: boolean): CardTone => {
        if (!hasAny) return "muted";
        if (ratio >= 0.5) return "warning";
        if (ratio >= 0.2) return "info";
        return "success";
      };
      return {
        freeLpRatio: lpRatio,
        freeAccountsRatio: acctRatio,
        freeLpTone: pickTone(lpRatio, totalFreeLpCores > 0),
        freeAccountsTone: pickTone(acctRatio, accountsWithFreeQuota > 0),
      } as const;
    }, [totalLpQuota, totalFreeLpCores, totalAccounts, accountsWithFreeQuota]);

  // Live refs into the latest values used by event-driven callbacks so
  // we don't have to chase stale closures across rebinds. The keyboard
  // shortcut handler installs `keydown` once and reads `selectedIds`
  // through the ref instead of re-registering on every change.
  const accountInfosLenRef = React.useRef(state.accountInfos.length);
  accountInfosLenRef.current = state.accountInfos.length;
  const accountsLenRef = React.useRef(state.accounts.length);
  accountsLenRef.current = state.accounts.length;

  // Auto-refresh on mount when the store is empty but we have accounts
  // configured. `useAbortableEffect` aborts the in-flight quota probes
  // on unmount, so a fast page-flip doesn't leak a `setLoading(false)`
  // into an unmounted tree (which would log a React warning in dev).
  useAbortableEffect(
    async (signal) => {
      if (
        accountInfosLenRef.current !== 0 ||
        accountsLenRef.current === 0
      ) {
        return;
      }
      setLoading(true);
      try {
        await orchestrator.execute({
          action: "refresh_account_info",
          payload: {},
          signal,
        });
        if (signal.aborted) return;
        await orchestrator.execute({
          action: "refresh_pool_info",
          payload: {},
          signal,
        });
      } catch {
        /* handled by orchestrator + activity log */
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    // Intentionally narrow: this fires once per page mount. The refs
    // pick up any post-mount changes to accountInfos / accounts.
    [orchestrator],
  );

  // Mutable controller for the imperative `handleRefresh` callback —
  // distinct from the mount-effect controller because the operator may
  // hit "Refresh" repeatedly and we want the previous probe to abort.
  const refreshAbortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    return () => {
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
    };
  }, []);

  const handleRefresh = React.useCallback(async () => {
    // Abort any in-flight probe from a previous click before starting
    // a new one — otherwise back-to-back refreshes race on setLoading.
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      await orchestrator.execute({
        action: "refresh_account_info",
        payload: {},
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      await orchestrator.execute({
        action: "refresh_pool_info",
        payload: {},
        signal: controller.signal,
      });
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      if (refreshAbortRef.current === controller) {
        refreshAbortRef.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, [orchestrator]);

  // Toggle a region in the URL-synced multi-select
  const toggleRegion = React.useCallback(
    (region: string) => {
      setUrlFilters((prev) => {
        const current = prev.regions ?? [];
        const next = current.includes(region)
          ? current.filter((r) => r !== region)
          : [...current, region];
        return { regions: next };
      });
    },
    [setUrlFilters],
  );

  const clearRegionFilter = React.useCallback(() => {
    setUrlFilters({ regions: [] });
  }, [setUrlFilters]);

  const clearAllFilters = React.useCallback(() => {
    setShowOnlyFree(false);
    setGpuOnly(false);
    setResizingFilter("all");
    setMinFreeCores(0);
    setSearchText("");
    setCapacityShape("either");
    setUrlFilters({ regions: [] });
  }, [setUrlFilters, setCapacityShape]);

  /** Add every row in the given region to the current selection. */
  const selectAllInRegion = React.useCallback(
    (regionAccountIds: string[]) => {
      const next = new Set(selectedIds);
      for (const id of regionAccountIds) next.add(id);
      setSelectedIds(next);
    },
    [selectedIds, setSelectedIds],
  );

  /** Select every visible (filtered) row that has spawnable nodes. */
  const selectAllEligible = React.useCallback(() => {
    const next = new Set(selectedIds);
    for (const r of filteredRows) {
      if (r.maxNodes > 0) next.add(r.id);
    }
    setSelectedIds(next);
  }, [filteredRows, selectedIds, setSelectedIds]);

  // Env var helpers
  const addEnvVar = React.useCallback(() => {
    setEnvVars((prev) => [...prev, { name: "", value: "" }]);
  }, []);
  const removeEnvVar = React.useCallback((index: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const updateEnvVar = React.useCallback(
    (index: number, field: "name" | "value", val: string) => {
      setEnvVars((prev) =>
        prev.map((ev, i) => (i === index ? { ...ev, [field]: val } : ev)),
      );
    },
    [],
  );

  // Build start task config
  const buildStartTaskConfig = (): Record<string, unknown> | null => {
    if (!commandLine.trim()) return null;
    const envSettings = envVars
      .filter((ev) => ev.name.trim() !== "")
      .map((ev) => ({ name: ev.name, value: ev.value }));

    const config: Record<string, unknown> = {
      commandLine,
      maxTaskRetryCount: maxRetryCount,
      waitForSuccess,
    };
    if (envSettings.length > 0) {
      config.environmentSettings = envSettings;
    }
    return config;
  };

  // Use in Smart Mode — passes the selected accountIds + the suggested
  // VM sizes via URL params so Pool Creation can pre-fill the Target
  // step and Smart Mode picker on mount.
  //
  // Routes through `navigateToPath` so we transparently prefer the
  // context-driven path nav and fall back to the legacy `onNavigate`
  // prop when present. The destination path contract
  // (`/pools?accountIds=...&vmSizes=...&smartMode=on&step=target`) is
  // unchanged — the receiving Pool Creation page parses these params
  // on mount.
  const handleUseInSmartMode = React.useCallback(
    (rowsOverride?: QuotaRow[]) => {
      const targetRows = rowsOverride ?? selectedRows;
      if (targetRows.length === 0) {
        navigateToPath("/pools");
        return;
      }
      const accountIds = targetRows
        .map((r) => r.id)
        .filter(Boolean)
        .join(",");
      const vmSizes = Array.from(
        new Set(
          targetRows
            .map((r) => r.suggestedVm)
            .filter((vm): vm is string => Boolean(vm) && vm !== "N/A"),
        ),
      ).join(",");
      const params = new URLSearchParams();
      params.set("step", "target");
      params.set("smartMode", "on");
      if (accountIds) params.set("accountIds", accountIds);
      if (vmSizes) params.set("vmSizes", vmSizes);
      navigateToPath(`/pools?${params.toString()}`);
    },
    [navigateToPath, selectedRows],
  );

  // ------------------------------------------------------------------
  // Bulk-drawer overrides
  // ------------------------------------------------------------------
  //
  // When the drawer opens, seed the override map from the row's
  // suggested defaults so the operator sees the same numbers they saw
  // in the table. Edits flow through `setOverrideFor`. Resetting the
  // drawer (cancel / close) clears overrides too.
  const openDrawer = React.useCallback(() => {
    const seed = new Map<string, BulkOverride>();
    for (const r of selectedRows) {
      seed.set(r.id, { vmSize: r.suggestedVm, nodes: r.maxNodes });
    }
    setOverrides(seed);
    setSubmitResults(null);
    setDrawerOpen(true);
  }, [selectedRows]);

  const closeDrawer = React.useCallback(() => {
    if (autoCreateSubmitting) return;
    setOverrides(new Map());
    setSubmitResults(null);
    setDrawerOpen(false);
  }, [autoCreateSubmitting]);

  const setOverrideFor = React.useCallback(
    (rowId: string, patch: Partial<BulkOverride>) => {
      setOverrides((prev) => {
        const next = new Map(prev);
        const cur = next.get(rowId) ?? { vmSize: "N/A", nodes: 0 };
        next.set(rowId, { ...cur, ...patch });
        return next;
      });
    },
    [],
  );

  // The effective "plan" — selected rows + their possibly-overridden
  // vmSize/nodes. Eligible means the operator wants ≥1 node of a valid
  // VM size; resizing accounts are also excluded since pool creation
  // races a concurrent resize and tends to 409.
  const bulkPlan = React.useMemo(
    () =>
      selectedRows.map((row) => {
        const ov =
          overrides.get(row.id) ?? {
            vmSize: row.suggestedVm,
            nodes: row.maxNodes,
          };
        const vCpus = getVCpus(ov.vmSize);
        const maxAllowed = vCpus > 0 ? Math.floor(row.lpFree / vCpus) : 0;
        const cappedNodes = Math.max(0, Math.min(ov.nodes, maxAllowed));
        const eligible =
          cappedNodes > 0 && ov.vmSize !== "N/A" && !row.isResizing;
        return {
          row,
          vmSize: ov.vmSize,
          nodes: cappedNodes,
          maxAllowed,
          eligible,
        };
      }),
    [selectedRows, overrides],
  );

  const eligibleBulkPlan = bulkPlan.filter((p) => p.eligible);
  const totalCoresToConsume = eligibleBulkPlan.reduce(
    (s, p) => s + p.nodes * getVCpus(p.vmSize),
    0,
  );
  const totalNodesToCreate = eligibleBulkPlan.reduce(
    (s, p) => s + p.nodes,
    0,
  );
  const distinctConfigs = new Set(
    eligibleBulkPlan.map((p) => `${p.vmSize}|${p.nodes}`),
  ).size;

  // ------------------------------------------------------------------
  // Bulk-action submit — FIXES THE OLD BUG.
  // ------------------------------------------------------------------
  //
  // The previous implementation dispatched `action: "create_pool"`
  // (singular), which is NOT in OrchestratorAction and threw
  // "Unknown action" at runtime. Now we group by (vmSize, nodes) and
  // dispatch `create_pools` once per group, which:
  //   1. Goes through the real orchestrator code path (sticky task,
  //      child activities, cancellation honoring).
  //   2. Reduces N orchestrator calls to typically 1-3.
  //   3. Surfaces per-group success/failure summaries that we splat
  //      into the result panel.
  const requestAutoCreateConfirm = () => {
    setShowAutoCreateConfirm(true);
  };

  // The submit path runs through this controller so the operator can
  // close the drawer (which calls closeDrawer guarded by submitting)
  // or unmount the page mid-flight without leaking promise resolution
  // into a dead tree. Aborted on unmount via the cleanup effect below.
  //
  // COORDINATOR: this overlaps with the "auto-create from quota"
  // workflow in `overview-page.tsx` (search for
  // `auto_create_pools_from_quota`). Both paths currently audit under
  // the same action name with distinct `actor` values so the audit-log
  // page can attribute origins. Keep the two in sync if you ever
  // factor the bulk-create plumbing into a shared service.
  const submitAbortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    return () => {
      submitAbortRef.current?.abort();
      submitAbortRef.current = null;
    };
  }, []);

  const submitAutoCreate = async () => {
    setShowAutoCreateConfirm(false);
    // Snapshot the plan up front — `bulkPlan` is recomputed on every
    // selection / override change and the async submit must operate
    // on the plan the operator confirmed, not whatever the table
    // looks like by the time the orchestrator returns.
    const planSnapshot = bulkPlan.map((p) => ({ ...p }));
    const eligibleSnapshot = planSnapshot.filter((p) => p.eligible);
    const startedAt = new Date().toISOString();
    const submitController = new AbortController();
    submitAbortRef.current?.abort();
    submitAbortRef.current = submitController;
    setAutoCreateSubmitting(true);
    const results: SubmitResult[] = [];
    try {
      const startTask = buildStartTaskConfig();

      // Add a "skipped" entry for ineligible rows up front so the result
      // panel surfaces them.
      for (const p of planSnapshot) {
        if (!p.eligible) {
          results.push({
            id: p.row.id,
            accountName: p.row.accountName,
            region: p.row.region,
            status: "skipped",
            vmSize: p.vmSize,
            nodes: p.nodes,
            error: p.row.isResizing
              ? "Pool is resizing"
              : p.nodes === 0
                ? "0 nodes (no fit)"
                : "Invalid VM size",
          });
        }
      }

      // Group eligible plan entries by their (vmSize, nodes) signature
      // and dispatch one create_pools per group.
      const groups = groupForDispatch(eligibleSnapshot);
      for (const [, group] of groups) {
        if (submitController.signal.aborted) break;
        const first = group[0];
        const vmSize = first.vmSize;
        const nodes = first.nodes;
        const accountIds = group.map((g) => g.row.id);

        // Build one base poolConfig from the active defaults — every
        // row in this group will use the same shape (the orchestrator
        // already iterates per-account internally).
        let poolConfig: Record<string, unknown>;
        if (poolDefaults) {
          poolConfig = buildPoolConfigFromDefaults(poolDefaults, {
            // Suffix with vmSize so concurrent groups don't collide on
            // the pool id when the user has identical maxNodes counts.
            id: `quota-${vmSize.replace(/[^a-z0-9]/gi, "")}-${Date.now()}`,
            targetLowPriorityNodes: nodes,
            vmSize,
          });
          poolConfig.targetDedicatedNodes = 0;
        } else {
          poolConfig = {
            id: `quota-${vmSize.replace(/[^a-z0-9]/gi, "")}-${Date.now()}`,
            vmSize,
            targetDedicatedNodes: 0,
            targetLowPriorityNodes: nodes,
            taskSlotsPerNode: 1,
          };
        }
        if (startTask) {
          poolConfig.startTask = startTask;
        }

        try {
          const res = await orchestrator.execute({
            action: "create_pools",
            payload: { accountIds, poolConfig },
            signal: submitController.signal,
          });
          if (submitController.signal.aborted) break;
          const groupSummary =
            (res.summary as Record<string, unknown> | undefined) ?? {};
          const failures =
            (groupSummary.failures as Array<{
              accountName: string;
              region: string;
              error: string;
            }>) ?? [];
          // Match group accounts to failures by name+region (the
          // orchestrator already canonicalizes these fields).
          for (const p of group) {
            const fail = failures.find(
              (f) =>
                f.accountName === p.row.accountName &&
                f.region === p.row.region,
            );
            if (fail) {
              results.push({
                id: p.row.id,
                accountName: p.row.accountName,
                region: p.row.region,
                status: "failed",
                vmSize: p.vmSize,
                nodes: p.nodes,
                error: fail.error,
              });
            } else {
              results.push({
                id: p.row.id,
                accountName: p.row.accountName,
                region: p.row.region,
                status: "created",
                vmSize: p.vmSize,
                nodes: p.nodes,
              });
            }
          }
        } catch (groupErr: unknown) {
          if (submitController.signal.aborted) break;
          const msg =
            groupErr instanceof Error ? groupErr.message : String(groupErr);
          for (const p of group) {
            results.push({
              id: p.row.id,
              accountName: p.row.accountName,
              region: p.row.region,
              status: "failed",
              vmSize: p.vmSize,
              nodes: p.nodes,
              error: msg,
            });
          }
        }
      }

      // Notify operator and refresh accountInfos so the "free LP" column
      // moves immediately for the rows that succeeded.
      const created = results.filter((r) => r.status === "created").length;
      const failedN = results.filter((r) => r.status === "failed").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const distinctRegions = Array.from(
        new Set(eligibleSnapshot.map((p) => p.row.region)),
      );
      if (!submitController.signal.aborted) {
        store.addNotification({
          type:
            failedN === 0 && created > 0
              ? "success"
              : created > 0
                ? "warning"
                : "error",
          message:
            created > 0
              ? `Auto-create complete: ${created} created, ${failedN} failed, ${skipped} skipped.`
              : `Auto-create finished: 0 created, ${failedN} failed, ${skipped} skipped.`,
        });
      }

      // Record the bulk auto-create in the canonical audit log. The
      // overview page's "auto-create from quota" workflow writes
      // entries under the same `action` name; we tag `actor` so the
      // audit-log page can attribute origins. Best-effort — wrap in a
      // try/catch so a logging failure doesn't break the result panel.
      try {
        auditLog.record({
          actor: "unused-quota-page",
          action: "auto_create_pools_from_quota",
          target:
            created > 0
              ? `${created}/${eligibleSnapshot.length} pools across ${distinctRegions.length} regions`
              : `0 pools (${failedN} failed, ${skipped} skipped)`,
          status:
            failedN === 0 && created > 0
              ? "success"
              : created > 0
                ? "success"
                : "failure",
          details: {
            created,
            failed: failedN,
            skipped,
            total: eligibleSnapshot.length,
            distinctConfigs: new Set(
              eligibleSnapshot.map((p) => `${p.vmSize}|${p.nodes}`),
            ).size,
            distinctRegions,
            startedAt,
            withStartTask: startTask !== null,
          },
        });
      } catch {
        /* swallow — audit-log shouldn't ever break the operator path */
      }

      // Fire-and-forget refresh — the result panel does not block on it.
      // Honour the submit controller so unmount also aborts the trailing
      // refresh probe.
      if (!submitController.signal.aborted) {
        void orchestrator.execute({
          action: "refresh_account_info",
          payload: {},
          signal: submitController.signal,
        });
      }
    } finally {
      if (!submitController.signal.aborted) {
        setSubmitResults(results);
      }
      if (submitAbortRef.current === submitController) {
        submitAbortRef.current = null;
      }
      setAutoCreateSubmitting(false);
    }
  };

  /**
   * Retry only the rows that failed in the last submission. Replaces
   * the current selection with the failed-row ids, restores the
   * configure step, then leaves it to the operator to click submit.
   */
  const retryFailedOnly = React.useCallback(() => {
    if (!submitResults) return;
    const failedIds = submitResults
      .filter((r) => r.status === "failed")
      .map((r) => r.id);
    if (failedIds.length === 0) return;
    setSelectedIds(new Set(failedIds));
    // Re-seed overrides from the previous attempt so the operator can
    // simply hit submit again.
    setOverrides((prev) => {
      const next = new Map<string, BulkOverride>();
      for (const r of submitResults) {
        if (r.status !== "failed") continue;
        const old = prev.get(r.id);
        next.set(r.id, {
          vmSize: old?.vmSize ?? r.vmSize,
          nodes: old?.nodes ?? r.nodes,
        });
      }
      return next;
    });
    setSubmitResults(null);
  }, [submitResults, setSelectedIds]);

  // ------------------------------------------------------------------
  // Copy account info as JSON — quick per-row action.
  // ------------------------------------------------------------------
  const copyAccountAsJson = React.useCallback((row: QuotaRow) => {
    const payload = {
      id: row.id,
      accountName: row.accountName,
      region: row.region,
      subscriptionId: row.subscriptionId,
      lpQuota: row.lpQuota,
      lpUsed: row.lpUsed,
      lpFree: row.lpFree,
      dedicatedQuota: row.dedicatedQuota,
      dedicatedUsed: row.dedicatedUsed,
      dedicatedFree: row.dedicatedFree,
      suggestedVm: row.suggestedVm,
      maxNodes: row.maxNodes,
      utilizationPct: row.utilizationPct,
    };
    void navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .then(() =>
        store.addNotification({
          type: "success",
          message: `Copied account JSON for ${row.accountName}`,
        }),
      )
      .catch(() =>
        store.addNotification({
          type: "error",
          message: "Failed to copy to clipboard",
        }),
      );
  }, [store]);

  // ------------------------------------------------------------------
  // Keyboard shortcuts: `/` focus search, `Esc` clear/close, `r` refresh.
  // ------------------------------------------------------------------
  //
  // The listener is installed once on mount and reads live state via
  // refs. Re-binding the global keydown handler on every selection
  // change (the previous pattern) was wasteful and also created a
  // brief window where the handler was missing between the
  // `removeEventListener` and the next `addEventListener`. Using refs
  // sidesteps both.
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const drawerOpenRef = React.useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  const selectedIdsRef = React.useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const setSelectedIdsRef = React.useRef(setSelectedIds);
  setSelectedIdsRef.current = setSelectedIds;
  const handleRefreshRef = React.useRef(handleRefresh);
  handleRefreshRef.current = handleRefresh;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when typing in form inputs (textarea / input / select / contenteditable).
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (target?.isContentEditable ?? false);
      if (e.key === "/" && !isEditable) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (
        (e.key === "r" || e.key === "R") &&
        !isEditable &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        void handleRefreshRef.current();
        return;
      }
      if (e.key === "Escape" && !isEditable) {
        // Drawer escape is handled by Radix; only act when drawer closed.
        if (!drawerOpenRef.current && selectedIdsRef.current.size > 0) {
          setSelectedIdsRef.current(new Set());
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ------------------------------------------------------------------
  // DataTable columns
  // ------------------------------------------------------------------
  const columns = React.useMemo<DataTableColumn<QuotaRow>[]>(
    () => [
      {
        id: "accountName",
        header: (
          <span className="inline-flex items-center gap-1">
            Account Name
            <InfoTooltip
              content="Azure Batch account display name. Hover any value to reveal a copy button."
              size={11}
            />
          </span>
        ),
        cell: (r) => (
          <span
            title={r.accountName}
            className="group/copy inline-flex max-w-full items-center gap-1.5 overflow-hidden align-middle"
          >
            <span className="block max-w-[18ch] overflow-hidden text-ellipsis whitespace-nowrap">
              {r.accountName}
            </span>
            <CopyButton value={r.accountName} ariaLabel={`Copy account name ${r.accountName}`} />
          </span>
        ),
        sort: (a, b) => a.accountName.localeCompare(b.accountName),
        csv: (r) => r.accountName,
      },
      {
        id: "region",
        header: (
          <span className="inline-flex items-center gap-1">
            Region
            <InfoTooltip
              content="Azure region. Click a region rollup card or chip to filter by region."
              size={11}
            />
          </span>
        ),
        cell: (r) => (
          <RegionBadge region={r.region} tone="muted" />
        ),
        sort: (a, b) => a.region.localeCompare(b.region),
        csv: (r) => r.region,
      },
      {
        id: "subscriptionId",
        header: (
          <span className="inline-flex items-center gap-1">
            Subscription
            <InfoTooltip
              content="Azure subscription that owns the Batch account. The first 8 hex chars are shown — copy the full GUID with the inline button."
              size={11}
            />
          </span>
        ),
        cell: (r) => (
          <CopyableText
            value={r.subscriptionId}
            display={
              <span
                title={r.subscriptionId}
                className="font-mono text-xs text-muted-foreground"
              >
                {r.subscriptionId.substring(0, 8)}
              </span>
            }
            mono
            ariaLabel={`Copy subscription id ${r.subscriptionId}`}
          />
        ),
        sort: (a, b) => a.subscriptionId.localeCompare(b.subscriptionId),
        csv: (r) => r.subscriptionId,
      },
      {
        id: "lpUtilization",
        header: (
          <span className="inline-flex items-center gap-1">
            LP Utilization
            <InfoTooltip
              content="Percentage of the Low-Priority core quota that is currently consumed by pools. Higher = less idle capacity."
              size={11}
            />
          </span>
        ),
        className: "text-right",
        cell: (r) => (
          <div className="flex flex-col items-end gap-0.5">
            <span
              className={cn(
                "text-xs font-semibold tabular-nums",
                r.utilizationPct >= 90
                  ? "text-success"
                  : r.utilizationPct >= 50
                    ? "text-info"
                    : r.utilizationPct >= 1
                      ? "text-warning"
                      : "text-destructive",
              )}
            >
              {r.utilizationPct}%
            </span>
            <div className="h-1 w-16 overflow-hidden rounded-full bg-muted/40">
              <div
                className={cn(
                  "h-full transition-all duration-300 ease-out motion-reduce:transition-none",
                  r.utilizationPct >= 90
                    ? "bg-success"
                    : r.utilizationPct >= 50
                      ? "bg-info"
                      : r.utilizationPct >= 1
                        ? "bg-warning"
                        : "bg-destructive/60",
                )}
                style={{ width: `${Math.min(100, r.utilizationPct)}%` }}
              />
            </div>
          </div>
        ),
        sort: (a, b) => a.utilizationPct - b.utilizationPct,
        csv: (r) => r.utilizationPct,
      },
      {
        id: "lpQuota",
        header: (
          <span className="inline-flex items-center gap-1">
            LP Quota
            <InfoTooltip
              content="Total Low-Priority vCPU quota assigned to the account by the subscription."
              size={11}
            />
          </span>
        ),
        className: "text-right",
        cell: (r) => (
          <span className="tabular-nums">{formatNumber(r.lpQuota)}</span>
        ),
        sort: (a, b) => a.lpQuota - b.lpQuota,
        csv: (r) => r.lpQuota,
        defaultHidden: true,
      },
      {
        id: "lpUsed",
        header: (
          <span className="inline-flex items-center gap-1">
            LP Used
            <InfoTooltip
              content="LP vCPUs currently consumed across all pools in this account."
              size={11}
            />
          </span>
        ),
        className: "text-right",
        cell: (r) => (
          <span className="tabular-nums">{formatNumber(r.lpUsed)}</span>
        ),
        sort: (a, b) => a.lpUsed - b.lpUsed,
        csv: (r) => r.lpUsed,
        defaultHidden: true,
      },
      {
        id: "lpFree",
        header: (
          <span className="inline-flex items-center gap-1">
            LP Free
            <InfoTooltip
              content="LP vCPUs available right now. The auto-suggest VM and max-nodes columns are computed from this value."
              size={11}
            />
          </span>
        ),
        className: "text-right",
        cell: (r) => (
          <span
            className={cn(
              "font-semibold tabular-nums",
              r.lpFree > 0 ? "text-success" : "text-destructive",
            )}
          >
            {formatNumber(r.lpFree)}
          </span>
        ),
        sort: (a, b) => a.lpFree - b.lpFree,
        csv: (r) => r.lpFree,
      },
      {
        id: "dedicatedFree",
        header: (
          <span className="inline-flex items-center gap-1">
            Dedicated Free
            <InfoTooltip
              content="Free dedicated (on-demand) cores. Auto-create only consumes LP cores; dedicated is shown for reference."
              size={11}
            />
          </span>
        ),
        className: "text-right",
        cell: (r) => (
          <span
            className={cn(
              "tabular-nums",
              r.dedicatedFree > 0 ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {formatNumber(r.dedicatedFree)}
          </span>
        ),
        sort: (a, b) => a.dedicatedFree - b.dedicatedFree,
        csv: (r) => r.dedicatedFree,
        defaultHidden: true,
      },
      {
        id: "isResizing",
        header: (
          <span className="inline-flex items-center gap-1">
            Resizing?
            <InfoTooltip
              content="True when at least one pool in the account is in allocationState=resizing. Auto-create skips these rows because pool creation races a concurrent resize."
              size={11}
            />
          </span>
        ),
        cell: (r) => (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs",
              r.isResizing
                ? "font-medium text-warning"
                : "text-muted-foreground",
            )}
          >
            {r.isResizing && <AlertTriangle className="h-3 w-3" aria-hidden />}
            {r.isResizing ? "Yes" : "No"}
          </span>
        ),
        sort: (a, b) =>
          (a.isResizing ? 1 : 0) - (b.isResizing ? 1 : 0),
        csv: (r) => (r.isResizing ? "Yes" : "No"),
      },
      {
        id: "suggestedVm",
        header: (
          <span className="inline-flex items-center gap-1">
            Suggested VM
            <InfoTooltip
              content="The largest GPU VM from the priority list that fits in the free LP cores. Falls back to the largest GPU SKU that fits when none match."
              size={11}
            />
          </span>
        ),
        cell: (r) => {
          const info = getVmSizeInfo(r.suggestedVm);
          const isGpu = info?.isGpu === true;
          return (
            <div className="group/copy flex items-center gap-2">
              <span
                title={
                  info
                    ? `${r.suggestedVm} - ${info.vCPUs} vCPUs, ${info.gpuCount}x ${info.gpuType}`
                    : r.suggestedVm
                }
                className={cn(
                  "block max-w-[20ch] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs",
                  r.suggestedVm !== "N/A"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {r.suggestedVm}
              </span>
              {isGpu && <RegionBadge region="GPU" gpu tone="info" />}
              {r.suggestedVm !== "N/A" && (
                <CopyButton
                  value={r.suggestedVm}
                  ariaLabel={`Copy VM size ${r.suggestedVm}`}
                />
              )}
            </div>
          );
        },
        sort: (a, b) => a.suggestedVm.localeCompare(b.suggestedVm),
        csv: (r) => r.suggestedVm,
      },
      {
        id: "maxNodes",
        header: (
          <span className="inline-flex items-center gap-1">
            Max Nodes
            <InfoTooltip
              content="floor(lpFree / vCPUs(suggestedVm)) — the largest number of nodes that fit using LP quota only."
              size={11}
            />
          </span>
        ),
        className: "text-right",
        cell: (r) => (
          <span
            className={cn(
              "tabular-nums",
              r.maxNodes > 0
                ? "font-semibold text-info"
                : "text-muted-foreground",
            )}
          >
            {formatNumber(r.maxNodes)}
          </span>
        ),
        sort: (a, b) => a.maxNodes - b.maxNodes,
        csv: (r) => r.maxNodes,
      },
      {
        id: "actions",
        header: (
          <span className="inline-flex items-center gap-1">
            Actions
            <InfoTooltip
              content="Per-row quick actions. Use bulk actions or Smart Mode in the toolbar for multi-row workflows."
              size={11}
            />
          </span>
        ),
        cell: (r) => (
          <div className="flex items-center justify-end gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUseInSmartMode([r]);
                  }}
                  aria-label={`Open ${r.accountName} in Smart Mode`}
                  disabled={r.maxNodes === 0 || r.suggestedVm === "N/A"}
                  className="text-muted-foreground hover:text-primary"
                >
                  <Rocket className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in Smart Mode</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyAccountAsJson(r);
                  }}
                  aria-label={`Copy ${r.accountName} as JSON`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy account JSON</TooltipContent>
            </Tooltip>
            {/*
              Per-row deep-link to the subscription blade in the Azure
              portal. Opens in a new tab (noopener for security — we
              don't want portal.azure.com to be able to back-reference
              our window). Disabled when subscriptionId is missing.
            */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={!r.subscriptionId}
                  aria-label={
                    r.subscriptionId
                      ? `Open subscription ${r.subscriptionId} in Azure portal (new tab)`
                      : "Subscription unavailable"
                  }
                  className="text-muted-foreground hover:text-info"
                >
                  <a
                    href={
                      r.subscriptionId
                        ? portalSubscriptionUrl(r.subscriptionId)
                        : "#"
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open subscription in Azure portal</TooltipContent>
            </Tooltip>
          </div>
        ),
        className: "text-right",
      },
    ],
    [handleUseInSmartMode, copyAccountAsJson],
  );

  // ------------------------------------------------------------------
  // Export columns for the page-level menu — broader than DataTable's
  // CSV (includes all fields, not just visible columns).
  // ------------------------------------------------------------------
  const exportColumns = React.useMemo(
    () => [
      { header: "Account Name", accessor: (r: QuotaRow) => r.accountName },
      { header: "Region", accessor: (r: QuotaRow) => r.region },
      { header: "Subscription Id", accessor: (r: QuotaRow) => r.subscriptionId },
      { header: "LP Quota", accessor: (r: QuotaRow) => r.lpQuota },
      { header: "LP Used", accessor: (r: QuotaRow) => r.lpUsed },
      { header: "LP Free", accessor: (r: QuotaRow) => r.lpFree },
      { header: "LP Utilization %", accessor: (r: QuotaRow) => r.utilizationPct },
      {
        header: "Dedicated Quota",
        accessor: (r: QuotaRow) => r.dedicatedQuota,
      },
      { header: "Dedicated Used", accessor: (r: QuotaRow) => r.dedicatedUsed },
      { header: "Dedicated Free", accessor: (r: QuotaRow) => r.dedicatedFree },
      { header: "Resizing", accessor: (r: QuotaRow) => r.isResizing },
      { header: "Suggested VM", accessor: (r: QuotaRow) => r.suggestedVm },
      { header: "Max Nodes", accessor: (r: QuotaRow) => r.maxNodes },
    ],
    [],
  );

  const showOnlyFreeId = React.useId();
  const gpuOnlyId = React.useId();
  const liveCatalogId = React.useId();
  const waitForSuccessId = React.useId();
  const retryFieldId = React.useId();
  const commandLineId = React.useId();
  const searchInputId = React.useId();
  const minCoresId = React.useId();
  const compactDensityId = React.useId();

  return (
    <div
      className="flex flex-col gap-4 py-4"
      role="region"
      aria-labelledby="unused-quota-heading"
    >
      {/* Error state */}
      {error && (
        <ErrorState
          message="Failed to refresh unused quota."
          detail={error}
          onRetry={handleRefresh}
        />
      )}

      {/* Header */}
      <div className="relative overflow-hidden rounded-xl border bg-card/50 p-6">
        <DotPattern fade="top-left" />
        <Meteors count={10} tone="primary" />
        <div className="relative z-10">
      <PageHeader
        title="Unused Quota"
        description="Surface accounts with free Low-Priority cores and bulk-create pools to consume them."
        titleId="unused-quota-heading"
      >
        <TokenExpiryBadge
          secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
          loading={armTokenTracker.loading}
          onRefresh={() => void armTokenTracker.refresh()}
          needsReauth={armTokenTracker.needsReauth}
          onReauth={() =>
            void armTokenTracker.reauth({
              loginHint: primaryAccount?.username,
            })
          }
        />
        <Button
          variant="default"
          onClick={handleRefresh}
          loading={loading}
          aria-label="Refresh unused quota data (keyboard: r)"
          title="Refresh (r)"
        >
          <RefreshCw className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
        <DisabledReasonWrapper
          disabled={selectedRows.length === 0}
          reason="Select 1+ rows first"
        >
          <Button
            variant="default"
            onClick={() => handleUseInSmartMode()}
            disabled={selectedRows.length === 0}
            aria-label="Use selected accounts in smart pool creation mode"
          >
            <Rocket />
            Use in Smart Mode
          </Button>
        </DisabledReasonWrapper>
        <DisabledReasonWrapper
          disabled={selectedRows.length === 0}
          reason="Select 1+ rows first"
        >
          <Button
            variant="default"
            onClick={openDrawer}
            disabled={selectedRows.length === 0}
            aria-label="Open bulk actions drawer for selected accounts"
          >
            <Plus />
            Bulk Actions ({selectedRows.length})
          </Button>
        </DisabledReasonWrapper>
        <ExportMenu<QuotaRow>
          rows={filteredRows}
          columns={exportColumns}
          filename="unused-quota"
          label="Export"
          jsonMetadata={{
            filtersApplied: {
              showOnlyFree,
              gpuOnly,
              resizingFilter,
              minFreeCores,
              regions: selectedRegions,
              searchText: searchText.trim(),
            },
          }}
        />
        {/*
          Master live-catalog wire toggle. Mirrors the one on Pool
          Creation. When OFF, "Use in Smart Mode" forwards to a Pool
          Creation page that uses the hardcoded 5-VM list. When ON,
          Pool Creation reads the cached Microsoft.Compute/skus catalog.
        */}
        <div className="ml-2 flex items-center gap-2">
          <Switch
            id={liveCatalogId}
            checked={liveCatalogEffective}
            onCheckedChange={toggleLiveCatalog}
            disabled={!catalogAvailability.available}
            aria-label="Toggle live VM catalog wire"
          />
          <Label
            htmlFor={liveCatalogId}
            className={cn(
              "text-xs",
              catalogAvailability.available
                ? "cursor-pointer text-muted-foreground"
                : "cursor-not-allowed text-muted-foreground/50",
            )}
            title={
              !catalogAvailability.available
                ? "Live catalog cache is empty for this subscription. Open the VM Catalog page to populate it (cached 7 days), then this toggle activates."
                : liveCatalogEffective
                  ? `Live catalog wired in (${catalogAvailability.count} SKUs cached). Pool Creation reads from Microsoft.Compute/skus.`
                  : "Live catalog disabled. Pool Creation uses the hardcoded VM list."
            }
          >
            Live catalog
            {catalogAvailability.available ? (
              <span className="ml-1 text-2xs opacity-70 tabular-nums">
                {catalogAvailability.count}
              </span>
            ) : (
              <span className="ml-1 text-2xs italic opacity-70">
                not loaded
              </span>
            )}
          </Label>
        </div>
      </PageHeader>
        </div>
      </div>

      {/* Summary Bar (totals). Tones reflect the free-vs-used ratio so the
          dashboard reads "you have lots of idle capacity" (warning) vs
          "fleet is fully utilized" (muted) at a glance. */}
      <div
        className="relative grid grid-cols-2 gap-3 overflow-hidden rounded-xl sm:grid-cols-3 lg:grid-cols-5"
        role="status"
        aria-live="polite"
      >
        <BorderBeam size={200} duration={8} />
        <SummaryStatCard
          icon={Users}
          label="Total Accounts"
          value={totalAccounts}
          tone="info"
          hint={
            totalAccounts > 0
              ? `${pluralize(distinctRegionsCount, "region")} covered`
              : "No accounts loaded"
          }
        />
        <SummaryStatCard
          icon={PiggyBank}
          label="Accounts with Free LP"
          value={accountsWithFreeQuota}
          tone={freeAccountsTone}
          hint={
            totalAccounts > 0
              ? `${Math.round(freeAccountsRatio * 100)}% of accounts`
              : undefined
          }
        />
        <SummaryStatCard
          icon={Server}
          label="Total Free LP Cores"
          value={totalFreeLpCores}
          tone={freeLpTone}
          hint={
            totalLpQuota > 0
              ? `${Math.round(freeLpRatio * 100)}% of ${formatNumber(totalLpQuota)} quota`
              : undefined
          }
        />
        <SummaryStatCard
          icon={Server}
          label="Free Dedicated"
          value={totalFreeDedicatedCores}
          tone="muted"
          hint="cores (reference only)"
        />
        <SummaryStatCard
          icon={Zap}
          label="Spawnable Nodes"
          value={spawnableNodes}
          tone={spawnableNodes > 0 ? "warning" : "muted"}
          hint={
            spawnableNodes > 0
              ? `with auto-suggested VM size`
              : "no fit anywhere"
          }
        />
      </div>

      {/*
        Subscription-level KPI strip using the shared `SummaryStatItem`.
        The five tiles above are account-level; these roll up by
        subscriptionId so the operator can see "X of Y subs are sitting
        on idle capacity". Compact so it doesn't overpower the per-account
        summary row.
      */}
      {totalAccounts > 0 && distinctSubsCount > 0 && (
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-3"
          role="group"
          aria-label="Subscription-level capacity summary"
        >
          <SummaryStatItem
            label="Subs with capacity"
            value={subsWithCapacityCount}
            tone={subsWithCapacityCount > 0 ? "warning" : "muted"}
            hint={
              distinctSubsCount > 0
                ? `of ${formatNumber(distinctSubsCount)} ${distinctSubsCount === 1 ? "sub" : "subs"}`
                : undefined
            }
            compact
          />
          <SummaryStatItem
            label="Total LP free"
            value={totalFreeLpCores}
            tone={totalFreeLpCores > 0 ? "info" : "muted"}
            hint={
              totalLpQuota > 0
                ? `${Math.round((totalFreeLpCores / totalLpQuota) * 100)}% of LP quota`
                : undefined
            }
            compact
          />
          <SummaryStatItem
            label="Total Dedicated free"
            value={totalFreeDedicatedCores}
            tone={totalFreeDedicatedCores > 0 ? "info" : "muted"}
            hint="cores"
            compact
          />
        </div>
      )}

      {/* Per-region rollups */}
      {regionRollups.length > 0 && (
        <section
          aria-label="Per-region free LP cores rollups"
          className="flex flex-col gap-2"
        >
          <div className="flex items-baseline justify-between">
            <h2 className="m-0 text-base font-semibold text-foreground">
              By Region
            </h2>
            <span className="text-2xs text-muted-foreground">
              Click a card to filter · Cmd-click the bolt to add all accounts in
              that region to your selection
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {regionRollups.map((roll) => {
              const isSelected = selectedRegions.includes(roll.region);
              return (
                <div
                  key={roll.region}
                  className={cn(
                    "relative flex flex-col items-start gap-1 rounded-lg border bg-card p-4 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none",
                    isSelected
                      ? "border-t-4 border-primary border-t-primary bg-primary/15"
                      : "border-border border-t-4 border-t-info hover:ring-info/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleRegion(roll.region)}
                    aria-pressed={isSelected}
                    aria-label={`Filter by region ${roll.region}, ${pluralize(roll.freeLpCores, "free LP core")}`}
                    className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  />
                  <div className="relative flex w-full items-center justify-between gap-2">
                    <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                      {roll.region}
                    </span>
                    <RegionBadge region={roll.region} tone="info" />
                  </div>
                  <span className="relative text-2xl font-bold leading-tight tabular-nums text-primary">
                    {formatNumber(roll.freeLpCores)}
                  </span>
                  <span className="relative text-xs text-muted-foreground">
                    {pluralize(roll.freeLpCores, "free LP core")}
                    {" · "}
                    {pluralize(roll.accounts, "account")}
                  </span>
                  <span className="relative text-2xs text-muted-foreground/70 tabular-nums">
                    {formatNumber(roll.freeDedicatedCores)} free dedicated
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          selectAllInRegion(roll.accountIds);
                        }}
                        aria-label={`Select all ${roll.accounts} accounts in ${roll.region}`}
                        className="absolute bottom-2 right-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Add {pluralize(roll.accounts, "account")} to selection
                    </TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Search + filter toolbar */}
      <div
        className="flex flex-col gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 shadow-sm sm:flex-row sm:flex-wrap sm:items-center"
        role="region"
        aria-label="Filters"
      >
        <div className="relative max-w-md flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id={searchInputId}
            ref={searchInputRef}
            type="search"
            placeholder="Search account / subscription / region… (press /)"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            aria-label="Search accounts, subscriptions, and regions"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Switch
              id={showOnlyFreeId}
              checked={showOnlyFree}
              onCheckedChange={(checked) => setShowOnlyFree(checked === true)}
              aria-label="Toggle to show only accounts with free LP quota"
            />
            <Label
              htmlFor={showOnlyFreeId}
              className="cursor-pointer text-xs text-muted-foreground"
            >
              Only free LP
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch
              id={gpuOnlyId}
              checked={gpuOnly}
              onCheckedChange={(checked) => setGpuOnly(checked === true)}
              aria-label="Toggle to restrict suggestions to GPU VM sizes"
            />
            <Label
              htmlFor={gpuOnlyId}
              className="cursor-pointer text-xs text-muted-foreground"
            >
              GPU only
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">Resizing</Label>
            <Select
              value={resizingFilter}
              onValueChange={(v) =>
                setResizingFilter(v as "all" | "exclude" | "only")
              }
            >
              <SelectTrigger
                className="h-8 w-[112px] text-xs"
                aria-label="Filter by resizing state"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="exclude">Exclude resizing</SelectItem>
                <SelectItem value="only">Only resizing</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <Label
              htmlFor={minCoresId}
              className="text-xs text-muted-foreground"
            >
              Min cores
            </Label>
            <Input
              id={minCoresId}
              type="number"
              min={0}
              step={1}
              value={String(minFreeCores)}
              onChange={(e) => {
                const n = parseInt(e.target.value || "0", 10);
                setMinFreeCores(isNaN(n) ? 0 : Math.max(0, n));
              }}
              className="h-8 w-20 text-xs tabular-nums"
              aria-label="Minimum free LP cores"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Switch
              id={compactDensityId}
              checked={compactDensity}
              onCheckedChange={(checked) =>
                setCompactDensity(checked === true)
              }
              aria-label="Toggle compact table density"
            />
            <Label
              htmlFor={compactDensityId}
              className="cursor-pointer text-xs text-muted-foreground"
            >
              Compact
            </Label>
          </div>
          {activeFilterCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={clearAllFilters}
              aria-label="Clear all filters"
              className="gap-1"
            >
              <X />
              Clear ({activeFilterCount})
            </Button>
          )}
        </div>
      </div>

      {/*
        Capacity-shape chip row — lets the operator narrow the view to
        rows that have only LP free, only Dedicated free, or both. The
        chosen shape persists across reloads (see `usePersistedState`
        wiring above).
      */}
      <div
        className="flex flex-wrap items-center gap-2"
        role="region"
        aria-label="Capacity shape filter"
      >
        <Filter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="text-xs text-muted-foreground">Capacity:</span>
        <FilterChipRow
          label="Capacity shape"
          value={capacityShapeSet}
          options={CAPACITY_SHAPE_OPTIONS}
          onChange={onCapacityShapeChange}
          showAll={false}
        />
      </div>

      {/* Region filter chips */}
      {allRegions.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          role="region"
          aria-label="Region filters"
        >
          <Filter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-xs text-muted-foreground">Regions:</span>
          {allRegions.map((region) => {
            const active = selectedRegions.includes(region);
            return (
              <button
                key={region}
                type="button"
                onClick={() => toggleRegion(region)}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none",
                  active
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted/40",
                )}
              >
                {region}
              </button>
            );
          })}
          {selectedRegions.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={clearRegionFilter}
              aria-label="Clear region filter"
              className="gap-1"
            >
              <X />
              Clear
            </Button>
          )}
          <span className="ml-auto text-2xs text-muted-foreground">
            Showing {pluralize(filteredRows.length, "account")} of{" "}
            {formatNumber(allRows.length)}
          </span>
        </div>
      )}

      {/* Table */}
      {loading && allRows.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          aria-label="Loading unused quota data"
          className="rounded-lg border border-border bg-card p-4"
        >
          <SkeletonLoader variant="table" rows={5} columns={9} />
        </div>
      ) : allRows.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title="No account info found"
          description="Refresh to load account data and surface unused quota across your regions."
          action={{
            label: "Refresh",
            onClick: handleRefresh,
            icon: RefreshCw,
            loading,
          }}
        />
      ) : filteredRows.length === 0 ? (
        // The "showOnlyFree" toggle being on with zero free-LP rows is a
        // common, distinct case ("good news, fleet is fully utilized")
        // and deserves its own message rather than the generic one.
        showOnlyFree && accountsWithFreeQuota === 0 ? (
          <EmptyState
            icon={PiggyBank}
            title="No accounts with free quota"
            description="Every account is fully utilizing its Low-Priority core quota. Disable the filter to see all accounts."
            action={{
              label: "Show all accounts",
              onClick: () => setShowOnlyFree(false),
            }}
          />
        ) : (
          <EmptyState
            icon={PiggyBank}
            title="No accounts match the current filters"
            description={
              activeFilterCount > 0
                ? `${activeFilterCount} ${activeFilterCount === 1 ? "filter is" : "filters are"} active. Clear them to see all rows.`
                : "Try clearing the region filter or the only-free-LP toggle."
            }
            action={
              activeFilterCount > 0
                ? {
                    label: "Clear all filters",
                    onClick: clearAllFilters,
                    icon: X,
                  }
                : undefined
            }
          />
        )
      ) : (
        <div
          className={cn(
            "transition-opacity duration-200 ease-out motion-reduce:transition-none",
            loading && allRows.length > 0 ? "opacity-70" : "opacity-100",
            // Reserve space at the bottom so the sticky toolbar doesn't
            // cover the last data row when selection is active.
            selectedRows.length > 0 && "pb-20",
            compactDensity && "density-compact",
          )}
        >
          <DataTable<QuotaRow>
            tableId="unused-quota"
            rows={filteredRows}
            columns={columns}
            rowKey={(r) => r.id}
            selection={selectedIds}
            onSelectionChange={setSelectedIds}
            initialSort={{ column: "lpFree", direction: "desc" }}
            csvFileName="unused-quota.csv"
          />
        </div>
      )}

      {/* Sticky bulk-action toolbar — appears when 1+ rows are selected.
          Primary action (Use in Smart Mode) is emphasized; the existing
          URL contract (/pools?accountIds=...&vmSizes=...&smartMode=on
          &step=target) is delegated to handleUseInSmartMode unchanged. */}
      {selectedRows.length > 0 && (
        <div
          role="region"
          aria-label="Bulk actions for selected accounts"
          className="sticky bottom-0 z-20 -mx-1 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-card/95 px-3 py-2 shadow-elev-2 backdrop-blur supports-[backdrop-filter]:bg-card/80 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"
        >
          <span className="inline-flex items-center gap-2 rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-semibold text-primary">
            <span className="tabular-nums">
              {formatNumber(selectedRows.length)}
            </span>
            selected
          </span>
          {(() => {
            const eligibleRows = selectedRows.filter((r) => r.maxNodes > 0);
            const eligibleNodes = eligibleRows.reduce(
              (s, r) => s + r.maxNodes,
              0,
            );
            const eligibleCores = eligibleRows.reduce(
              (s, r) => s + r.maxNodes * r.suggestedVmVCpus,
              0,
            );
            return (
              <>
                {eligibleRows.length !== selectedRows.length && (
                  <span className="text-2xs text-muted-foreground">
                    ({pluralize(eligibleRows.length, "eligible")} for pool
                    creation)
                  </span>
                )}
                {eligibleRows.length > 0 && (
                  <span className="text-2xs text-muted-foreground">
                    ~{formatNumber(eligibleNodes)} nodes ·{" "}
                    {formatNumber(eligibleCores)} cores
                  </span>
                )}
              </>
            );
          })()}
          <span className="hidden h-5 w-px bg-border sm:inline-block" />
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => handleUseInSmartMode()}
            aria-label="Use selected accounts in smart pool creation mode"
            className="transition-colors duration-150 ease-out motion-reduce:transition-none"
          >
            <Rocket className="h-3.5 w-3.5" />
            Use in Smart Mode
          </Button>
          {(() => {
            const eligibleRows = selectedRows.filter((r) => r.maxNodes > 0);
            return (
              <DisabledReasonWrapper
                disabled={eligibleRows.length === 0}
                reason="No selected accounts have enough free cores to create a pool"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={openDrawer}
                  disabled={eligibleRows.length === 0}
                  aria-label="Open bulk actions drawer for selected accounts"
                  className="transition-colors duration-150 ease-out motion-reduce:transition-none"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Bulk Actions
                </Button>
              </DisabledReasonWrapper>
            );
          })()}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={selectAllEligible}
            aria-label="Select all eligible rows in the current filter"
            className="text-muted-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Select all eligible
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
            aria-label="Clear selection (keyboard: Esc)"
            title="Clear selection (Esc)"
            className="ml-auto text-muted-foreground"
          >
            <X />
            Clear
          </Button>
        </div>
      )}

      {/* Bulk-action drawer */}
      <Sheet
        open={drawerOpen}
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
      >
        <SheetContent
          side="right"
          size="lg"
          className="flex flex-col"
          onEscapeKeyDown={(e) => autoCreateSubmitting && e.preventDefault()}
          onInteractOutside={(e) => autoCreateSubmitting && e.preventDefault()}
        >
          <SheetHeader>
            <SheetTitle>Bulk Actions</SheetTitle>
            <SheetDescription>
              {submitResults ? (
                <>
                  Results for the previous run · {pluralize(submitResults.length, "row")}{" "}
                  processed.
                </>
              ) : (
                <>
                  {pluralize(selectedRows.length, "account")} selected ·{" "}
                  {pluralize(eligibleBulkPlan.length, "eligible pool")} across{" "}
                  {pluralize(
                    new Set(eligibleBulkPlan.map((p) => p.row.region)).size,
                    "region",
                  )}
                  {distinctConfigs > 0 && (
                    <>
                      {" · "}
                      {pluralize(distinctConfigs, "distinct config")}
                    </>
                  )}
                </>
              )}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-4">
            {submitResults ? (
              /* ----------------- Result panel ----------------- */
              <BulkResultPanel
                results={submitResults}
                onRetryFailed={retryFailedOnly}
                onDone={closeDrawer}
              />
            ) : (
              <>
                {/* Start task config */}
                <section className="flex flex-col gap-3">
                  <h3 className="m-0 inline-flex items-center gap-1 text-base font-semibold text-foreground">
                    Start Task Configuration{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      (optional)
                    </span>
                    <InfoTooltip
                      content="A start task runs on every new node before any user task. Leave the command line empty to skip — most workloads only need this when nodes require setup (e.g. apt-get installs, env scaffolding)."
                      size={12}
                    />
                  </h3>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={commandLineId}>Command Line</Label>
                    <Input
                      id={commandLineId}
                      value={commandLine}
                      onChange={(e) => setCommandLine(e.target.value)}
                      placeholder="/bin/bash -c 'echo hello'"
                      className="font-mono text-xs"
                      aria-label="Command line"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Environment Variables</Label>
                    <div className="flex flex-col gap-1.5">
                      {envVars.map((ev, idx) => (
                        <div key={idx} className="flex items-end gap-2">
                          <Input
                            placeholder="Name"
                            value={ev.name}
                            onChange={(e) =>
                              updateEnvVar(idx, "name", e.target.value)
                            }
                            aria-label={`Environment variable ${idx + 1} name`}
                            className="w-[140px]"
                          />
                          <Input
                            placeholder="Value"
                            value={ev.value}
                            onChange={(e) =>
                              updateEnvVar(idx, "value", e.target.value)
                            }
                            aria-label={`Environment variable ${idx + 1} value`}
                            className="flex-1"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => removeEnvVar(idx)}
                            aria-label={`Remove environment variable ${ev.name || idx + 1}`}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addEnvVar}
                        aria-label="Add environment variable"
                        className="self-start text-xs"
                      >
                        <Plus />
                        Add Variable
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-end gap-6">
                    <div className="flex w-[180px] flex-col gap-1.5">
                      <Label htmlFor={retryFieldId}>Max Retry Count</Label>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          onClick={() =>
                            setMaxRetryCount((n) => Math.max(0, n - 1))
                          }
                          disabled={maxRetryCount <= 0}
                          aria-label="Decrement retry count"
                        >
                          <Minus />
                        </Button>
                        <Input
                          id={retryFieldId}
                          type="number"
                          min={0}
                          max={10}
                          step={1}
                          value={String(maxRetryCount)}
                          onChange={(e) => {
                            const n = parseInt(e.target.value || "3", 10);
                            setMaxRetryCount(
                              Math.max(0, Math.min(10, isNaN(n) ? 3 : n)),
                            );
                          }}
                          className="text-center tabular-nums"
                          aria-label="Max retry count"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          onClick={() =>
                            setMaxRetryCount((n) => Math.min(10, n + 1))
                          }
                          disabled={maxRetryCount >= 10}
                          aria-label="Increment retry count"
                        >
                          <Plus />
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        id={waitForSuccessId}
                        checked={waitForSuccess}
                        onCheckedChange={(checked) =>
                          setWaitForSuccess(checked === true)
                        }
                        aria-label="Wait for start task success"
                      />
                      <Label
                        htmlFor={waitForSuccessId}
                        className="cursor-pointer text-sm font-medium text-foreground"
                      >
                        Wait for Success{" "}
                        <span className="text-xs text-muted-foreground">
                          {waitForSuccess ? "Yes" : "No"}
                        </span>
                      </Label>
                    </div>
                  </div>
                </section>

                {/* Per-row plan with overrides */}
                <section className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between">
                    <h3 className="m-0 inline-flex items-center gap-1 text-base font-semibold text-foreground">
                      Pools to be created
                      <InfoTooltip
                        content="One pool will be created per row. You can override the VM size or node count per row before submitting. Rows shown in red are ineligible (no fit or actively resizing)."
                        size={12}
                      />
                    </h3>
                    {totalNodesToCreate > 0 && (
                      <span className="text-2xs text-muted-foreground">
                        Total: {formatNumber(totalNodesToCreate)} nodes ·{" "}
                        {formatNumber(totalCoresToConsume)} cores
                      </span>
                    )}
                  </div>
                  {bulkPlan.length === 0 ? (
                    <p className="m-0 text-xs text-muted-foreground">
                      No rows selected.
                    </p>
                  ) : (
                    <div className="max-h-[360px] overflow-auto rounded-md border border-border bg-card">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="text-2xs uppercase tracking-wider text-muted-foreground">
                              Account
                            </TableHead>
                            <TableHead className="text-2xs uppercase tracking-wider text-muted-foreground">
                              Region
                            </TableHead>
                            <TableHead className="text-2xs uppercase tracking-wider text-muted-foreground">
                              VM Size
                            </TableHead>
                            <TableHead className="w-[100px] text-right text-2xs uppercase tracking-wider text-muted-foreground">
                              Nodes
                            </TableHead>
                            <TableHead className="text-right text-2xs uppercase tracking-wider text-muted-foreground">
                              Status
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {bulkPlan.map((p) => {
                            const vmInfo = getVmSizeInfo(p.vmSize);
                            return (
                              <TableRow
                                key={p.row.id}
                                className={cn(
                                  "hover:bg-muted/30",
                                  !p.eligible && "opacity-60",
                                )}
                              >
                                <TableCell className="text-xs text-foreground">
                                  <div className="flex flex-col">
                                    <span className="font-medium">
                                      {p.row.accountName}
                                    </span>
                                    <span className="text-2xs text-muted-foreground">
                                      {formatNumber(p.row.lpFree)} free cores
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-xs text-foreground">
                                  {p.row.region}
                                </TableCell>
                                <TableCell className="text-xs text-foreground">
                                  <Select
                                    value={p.vmSize}
                                    onValueChange={(v) =>
                                      setOverrideFor(p.row.id, {
                                        vmSize: v,
                                        // Reset nodes to the max for the new size.
                                        nodes:
                                          v && getVCpus(v) > 0
                                            ? Math.floor(p.row.lpFree / getVCpus(v))
                                            : 0,
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      className="h-8 w-[200px] text-xs"
                                      aria-label={`VM size for ${p.row.accountName}`}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {getGpuVmSizes().map((vm) => {
                                        const fits =
                                          p.row.lpFree >= vm.vCPUs;
                                        return (
                                          <SelectItem
                                            key={vm.name}
                                            value={vm.name}
                                            disabled={!fits}
                                          >
                                            <span className="font-mono text-xs">
                                              {vm.name}
                                            </span>
                                            <span className="ml-2 text-2xs text-muted-foreground">
                                              {vm.vCPUs} vCPUs
                                              {!fits && " (no fit)"}
                                            </span>
                                          </SelectItem>
                                        );
                                      })}
                                    </SelectContent>
                                  </Select>
                                  {vmInfo && (
                                    <div className="mt-0.5 text-2xs text-muted-foreground">
                                      {vmInfo.gpuCount}x {vmInfo.gpuType} ·{" "}
                                      {vmInfo.vCPUs} vCPUs/node
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell className="text-right text-xs">
                                  <Input
                                    type="number"
                                    min={0}
                                    max={p.maxAllowed}
                                    step={1}
                                    value={String(p.nodes)}
                                    onChange={(e) => {
                                      const n = parseInt(
                                        e.target.value || "0",
                                        10,
                                      );
                                      setOverrideFor(p.row.id, {
                                        nodes: isNaN(n)
                                          ? 0
                                          : Math.max(
                                              0,
                                              Math.min(p.maxAllowed, n),
                                            ),
                                      });
                                    }}
                                    aria-label={`Node count for ${p.row.accountName}`}
                                    className="h-8 w-20 text-right text-xs tabular-nums"
                                  />
                                  <div className="mt-0.5 text-2xs text-muted-foreground">
                                    max {formatNumber(p.maxAllowed)}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right text-xs">
                                  {p.eligible ? (
                                    <span className="inline-flex items-center gap-1 text-success">
                                      <CheckCircle2
                                        className="h-3 w-3"
                                        aria-hidden
                                      />
                                      Ready
                                    </span>
                                  ) : p.row.isResizing ? (
                                    <span className="inline-flex items-center gap-1 text-warning">
                                      <AlertTriangle
                                        className="h-3 w-3"
                                        aria-hidden
                                      />
                                      Resizing
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-destructive">
                                      <XCircle
                                        className="h-3 w-3"
                                        aria-hidden
                                      />
                                      No fit
                                    </span>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </section>
              </>
            )}
          </SheetBody>
          {!submitResults && (
            <SheetFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDrawer}
                disabled={autoCreateSubmitting}
                aria-label="Close bulk actions drawer"
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={requestAutoCreateConfirm}
                loading={autoCreateSubmitting}
                disabled={eligibleBulkPlan.length === 0}
                aria-label="Auto-create pools for selected accounts"
              >
                {!autoCreateSubmitting && <Plus />}
                Auto-Create{" "}
                {eligibleBulkPlan.length > 0 &&
                  `${eligibleBulkPlan.length} ${eligibleBulkPlan.length === 1 ? "Pool" : "Pools"}`}
              </Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmationDialog
        hidden={!showAutoCreateConfirm}
        title="Create pools across selected accounts?"
        message={
          <div className="flex flex-col gap-2 text-sm">
            <p className="m-0">
              This will create {pluralize(eligibleBulkPlan.length, "pool")}{" "}
              across {pluralize(
                new Set(eligibleBulkPlan.map((p) => p.row.region)).size,
                "region",
              )}{" "}
              and consume approximately{" "}
              <strong className="text-foreground">
                {formatNumber(totalCoresToConsume)}
              </strong>{" "}
              LP cores ({formatNumber(totalNodesToCreate)} total nodes).
            </p>
            <p className="m-0 text-xs text-muted-foreground">
              The orchestrator will dispatch{" "}
              {pluralize(distinctConfigs, "request")} (one per unique
              vmSize+nodes combination). Pool creation can be cancelled
              from the Task Manager but already-running per-account work
              runs to completion before exit.
            </p>
          </div>
        }
        confirmText="Create pools"
        cancelText="Cancel"
        danger
        loading={autoCreateSubmitting}
        onConfirm={submitAutoCreate}
        onCancel={() => setShowAutoCreateConfirm(false)}
      />
    </div>
  );
};

export const UnusedQuotaPage: React.FC<UnusedQuotaPageProps> = (props) => (
  <ErrorBoundary>
    <UnusedQuotaPageInner {...props} />
  </ErrorBoundary>
);

// ---------------------------------------------------------------------------
// SummaryStatCard — internal stat tile used in the top row.
// ---------------------------------------------------------------------------

type SummaryCardTone = "info" | "success" | "warning" | "muted";

interface SummaryStatCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone: SummaryCardTone;
  hint?: string;
}

const SUMMARY_TONE: Record<
  SummaryCardTone,
  { value: string; icon: string; border: string; ring: string; bg: string }
> = {
  info: {
    value: "text-info",
    icon: "text-info",
    border: "border-info/30",
    ring: "ring-info/15",
    bg: "bg-info/5",
  },
  success: {
    value: "text-success",
    icon: "text-success",
    border: "border-success/30",
    ring: "ring-success/15",
    bg: "bg-success/5",
  },
  warning: {
    value: "text-warning",
    icon: "text-warning",
    border: "border-warning/30",
    ring: "ring-warning/15",
    bg: "bg-warning/5",
  },
  muted: {
    value: "text-foreground",
    icon: "text-muted-foreground",
    border: "border-border",
    ring: "",
    bg: "bg-card",
  },
};

const SummaryStatCard: React.FC<SummaryStatCardProps> = ({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}) => {
  const toneClasses = SUMMARY_TONE[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm transition-colors duration-200 ease-out motion-reduce:transition-none",
        toneClasses.border,
        toneClasses.bg,
      )}
    >
      <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", toneClasses.icon)} />
      <div className="flex min-w-0 flex-col">
        <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            "text-xl font-bold leading-tight tabular-nums",
            toneClasses.value,
          )}
        >
          <NumberTicker value={value} />
        </span>
        {hint && (
          <span className="text-2xs text-muted-foreground">{hint}</span>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// DisabledReasonWrapper — wraps a possibly-disabled trigger with a Radix
// Tooltip that explains *why* it's disabled. The intermediate <span> is
// required because pointer-events are stripped from a disabled button so
// the bare element can't fire mouseenter on its own.
// ---------------------------------------------------------------------------

interface DisabledReasonWrapperProps {
  disabled: boolean;
  reason: string;
  children: React.ReactElement;
}

const DisabledReasonWrapper: React.FC<DisabledReasonWrapperProps> = ({
  disabled,
  reason,
  children,
}) => {
  if (!disabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
};

// ---------------------------------------------------------------------------
// BulkResultPanel — renders the per-row outcome of the most recent bulk
// submit + a "Retry failed only" affordance. Lives inside the bulk
// drawer so the operator sees the result without having to navigate
// away to the Activity panel.
// ---------------------------------------------------------------------------

interface BulkResultPanelProps {
  results: SubmitResult[];
  onRetryFailed: () => void;
  onDone: () => void;
}

const BulkResultPanel: React.FC<BulkResultPanelProps> = ({
  results,
  onRetryFailed,
  onDone,
}) => {
  const created = results.filter((r) => r.status === "created");
  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.filter((r) => r.status === "skipped");
  const total = results.length;

  return (
    <section className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <ResultStat
          label="Created"
          value={created.length}
          total={total}
          tone="success"
          icon={CheckCircle2}
        />
        <ResultStat
          label="Failed"
          value={failed.length}
          total={total}
          tone="destructive"
          icon={XCircle}
        />
        <ResultStat
          label="Skipped"
          value={skipped.length}
          total={total}
          tone="muted"
          icon={AlertTriangle}
        />
      </div>
      <div className="max-h-[420px] overflow-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-2xs uppercase tracking-wider text-muted-foreground">
                Status
              </TableHead>
              <TableHead className="text-2xs uppercase tracking-wider text-muted-foreground">
                Account
              </TableHead>
              <TableHead className="text-2xs uppercase tracking-wider text-muted-foreground">
                VM Size
              </TableHead>
              <TableHead className="text-right text-2xs uppercase tracking-wider text-muted-foreground">
                Nodes
              </TableHead>
              <TableHead className="text-2xs uppercase tracking-wider text-muted-foreground">
                Detail
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((r) => (
              <TableRow key={r.id} className="hover:bg-muted/30">
                <TableCell className="text-xs">
                  {r.status === "created" && (
                    <span className="inline-flex items-center gap-1 text-success">
                      <CheckCircle2 className="h-3 w-3" aria-hidden />
                      Created
                    </span>
                  )}
                  {r.status === "failed" && (
                    <span className="inline-flex items-center gap-1 text-destructive">
                      <XCircle className="h-3 w-3" aria-hidden />
                      Failed
                    </span>
                  )}
                  {r.status === "skipped" && (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <AlertTriangle className="h-3 w-3" aria-hidden />
                      Skipped
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-foreground">
                  <div className="flex flex-col">
                    <span className="font-medium">{r.accountName}</span>
                    <span className="text-2xs text-muted-foreground">
                      {r.region}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-foreground">
                  {r.vmSize}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {formatNumber(r.nodes)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.error ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {failed.length > 0 && (
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onRetryFailed}
            aria-label={`Retry ${failed.length} failed ${failed.length === 1 ? "row" : "rows"}`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry {failed.length} failed
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDone}
          aria-label="Close bulk actions drawer"
          className="ml-auto"
        >
          Done
        </Button>
      </div>
    </section>
  );
};

interface ResultStatProps {
  label: string;
  value: number;
  total: number;
  tone: "success" | "destructive" | "muted";
  icon: React.ComponentType<{ className?: string }>;
}

const ResultStat: React.FC<ResultStatProps> = ({
  label,
  value,
  total,
  tone,
  icon: Icon,
}) => {
  const valueClass =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : "text-foreground";
  const iconClass =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : "text-muted-foreground";
  const borderClass =
    tone === "success"
      ? "border-success/30 bg-success/5"
      : tone === "destructive"
        ? "border-destructive/30 bg-destructive/5"
        : "border-border bg-card";
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2",
        borderClass,
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconClass)} />
      <div className="flex flex-col">
        <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className={cn("text-lg font-bold tabular-nums", valueClass)}>
          {formatNumber(value)}
        </span>
        <span className="text-2xs text-muted-foreground">{pct}%</span>
      </div>
    </div>
  );
};
