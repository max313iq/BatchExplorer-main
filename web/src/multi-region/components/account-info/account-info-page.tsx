/**
 * Account Info page — multi-region Azure Batch account browser with URL-synced
 * filters + search, DataTable rendering, fleet-wide quota gauges, and a
 * deep-link `<Sheet>` drawer for per-account details (per-VM-family quota
 * breakdown + raw quota numbers + cross-page links).
 *
 * Operator-facing features:
 *   - Free-text search (account name / region / RG / subscription id) with
 *     `/` to focus, debounced via the shared `useSearch` hook.
 *   - Auto-refresh every 30 s with a live countdown chip + last-refreshed
 *     relative timestamp + stale-data warning if data is older than 5 min.
 *   - Critical / warning summary chips that filter the table by utilization.
 *   - Keyboard shortcuts: `r` refresh, `a` toggle auto-refresh, `/` focus
 *     search, `Escape` clears the sheet (handled by Radix).
 *   - Per-row Copy-account-id button + per-cell info tooltips.
 *   - Sheet split into Overview / Per-VM-family / Related tabs so a long
 *     account doesn't require a scrollbar marathon.
 *   - Top-utilization items in QuotaGlance are clickable → open the sheet.
 *   - Export dropdown (CSV + JSON via the shared ExportMenu) alongside the
 *     DataTable's built-in CSV button.
 *
 * Auth surface is preserved: still uses `useArmToken` + `<TokenExpiryBadge>`
 * sourced from the first signed-in Azure account so the operator gets a
 * heads-up before any sheet "Pools / Nodes / Create pool" navigation that
 * would actually need a fresh ARM token.
 */
import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  ExternalLink,
  Filter,
  Gauge as GaugeIcon,
  Loader2,
  RotateCw,
  Search,
  Square,
  Users,
  X,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Gauge } from "@/components/ui/charts/gauge";
import {
  cn,
  compareNumbers,
  compareStrings,
  formatNumber,
  formatRelativeTime,
} from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useSearch } from "../../hooks/use-search";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState } from "../../store/store-context";
import { AccountInfo } from "../../store/store-types";
import { CopyButton, CopyableText } from "../shared/copy-button";
import {
  DataTable,
  type DataTableColumn,
} from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { RegionBadge } from "../shared/region-badge";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import {
  BorderBeam,
  DotPattern,
  Meteors,
} from "@/components/ui/effects";
import {
  safeNum,
  summarizeAccountInfos,
  usagePct,
} from "./account-info-helpers";
import { AccountInfoSummaryBar } from "./account-info-summary";

const AUTO_REFRESH_INTERVAL_MS = 30_000;
const LOW_FREE_THRESHOLDS = ["10", "50", "100"] as const;
const ALL_REGIONS = "__all";
const STALE_DATA_THRESHOLD_MS = 5 * 60 * 1000; // 5 min
const CRITICAL_UTILIZATION_PCT = 80;
const WARNING_UTILIZATION_PCT = 50;
// Persisted threshold-alert (Wave-2 add). When per-account peak utilization
// crosses this configurable percent, the row banner highlights the account
// as "watch". Operators get a deep-link from the banner to the row's sheet.
// Stored under a v1 key so future schema bumps can migrate cleanly.
const THRESHOLD_ALERT_KEY = "azbm.account-info.threshold-alert-pct.v1";
const THRESHOLD_ALERT_DEFAULT_PCT = 75;
const THRESHOLD_ALERT_OPTIONS = [50, 60, 70, 75, 80, 90, 95] as const;
// Hotkey chord sequences. `g a` / `g p` follows the Gmail-style "g + nav"
// convention also used by GitHub. The chord buffer resets after 1.2s so a
// stray `g` doesn't get bound to whatever the next keypress is.
const CHORD_BUFFER_TIMEOUT_MS = 1200;
// Active jobs is a quota-only metric — Azure Batch doesn't expose a "used"
// count for active jobs in the account-quota response, so we display "—"
// for the used value instead of a misleading 0. (Wave-2 correctness fix.)
// Utilization band — URL-synced so a "show me only the critical accounts" view
// is deep-linkable + shareable. "all" is treated as the default (no URL entry).
type UtilizationBand = "all" | "critical" | "warning" | "healthy";
const UTILIZATION_BANDS: ReadonlySet<UtilizationBand> = new Set([
  "all",
  "critical",
  "warning",
  "healthy",
]);

// URL-synced filter shape. Field types are widened to `string | string[]` to
// satisfy `UrlStateRecord = Record<string, string | string[] | undefined>` —
// the `useUrlState` hook's generic constraint. Read sites narrow back to a
// plain `string` via `firstString` below before passing to consumers.
interface AccountInfoFilters {
  region: string | string[];
  lowFree: string | string[];
  q: string | string[];
  /** URL-synced utilization band — empty / missing → "all". */
  band: string | string[];
  // Index signature required to satisfy `useUrlState`'s `UrlStateRecord`
  // constraint (`Record<string, string | string[] | undefined>`).
  [key: string]: string | string[] | undefined;
}

const INITIAL_FILTERS: AccountInfoFilters = {
  region: "",
  lowFree: "",
  q: "",
  band: "",
};

/**
 * Narrow a URL-state value (`string | string[] | undefined`) to a single
 * string. Filters on this page only ever carry scalar values, but the URL
 * state generic allows arrays for forward compatibility — pick the first
 * element when it ever arrives as an array.
 */
function firstString(value: string | string[] | undefined): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value[0] ?? "";
  return value;
}

/** Narrow an arbitrary string from URL state to a known `UtilizationBand`. */
function coerceBand(value: string): UtilizationBand {
  return UTILIZATION_BANDS.has(value as UtilizationBand)
    ? (value as UtilizationBand)
    : "all";
}

export interface AccountInfoPageProps {
  orchestrator: OrchestratorAgent;
}

/* ------------------------------------------------------------------ */
/*  Inline UsageBar (still used in the row + sheet)                   */
/* ------------------------------------------------------------------ */

interface UsageBarProps {
  used: number;
  quota: number;
}

const UsageBar: React.FC<UsageBarProps> = ({ used, quota }) => {
  const pct = usagePct(used, quota);
  const toneText =
    quota <= 0
      ? "text-muted-foreground"
      : pct > 80
        ? "text-destructive"
        : pct >= 50
          ? "text-warning"
          : "text-success";
  const toneFill =
    quota <= 0
      ? "bg-muted-foreground"
      : pct > 80
        ? "bg-destructive"
        : pct >= 50
          ? "bg-warning"
          : "bg-success";
  const bar = (
    <div className="group flex flex-col gap-1">
      <span
        className={cn(
          "text-xs font-semibold tabular-nums transition-colors duration-150 ease-out",
          toneText,
        )}
      >
        {formatNumber(used)} / {formatNumber(quota)}
      </span>
      <div
        className="h-1 w-20 overflow-hidden rounded-full bg-surface-sunken transition-[height] duration-200 ease-out group-hover:h-1.5"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Usage: ${used} of ${quota} cores (${pct}%)`}
        aria-valuetext={`${pct}%`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none",
            toneFill,
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
  // Tooltip exposes the exact percentage on hover/focus; useful when the
  // bar is short and the eye can't easily judge fill ratio.
  if (quota <= 0) return bar;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex outline-none">
          {bar}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {pct}% used ({formatNumber(used)} / {formatNumber(quota)})
      </TooltipContent>
    </Tooltip>
  );
};

/* ------------------------------------------------------------------ */
/*  Detail sheet                                                       */
/* ------------------------------------------------------------------ */

interface AccountDetailSheetProps {
  account: AccountInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
  /**
   * True while the orchestrator's initial refresh has not yet returned.
   * When set, the sheet renders a skeleton instead of "Account not found"
   * so a deep-linked `/account-info/<id>` doesn't briefly flash an error
   * state during the first refresh round-trip after mount.
   */
  loading?: boolean;
  /**
   * Absolute URL operators can copy + paste into chat to send a teammate
   * straight to this sheet. Built once in the parent — we compute it there
   * so the sheet stays a pure rendering component.
   */
  deepLinkUrl?: string;
}

const AccountDetailSheet: React.FC<AccountDetailSheetProps> = ({
  account,
  open,
  onOpenChange,
  onNavigate,
  loading = false,
  deepLinkUrl,
}) => {
  const families = account?.dedicatedCoreQuotaPerVMFamily ?? [];
  const familiesEnforced =
    account?.dedicatedCoreQuotaPerVMFamilyEnforced ?? false;

  // Pre-compute the worst-of (dedicated, LP, pool) utilization for the badge
  // shown next to the title, so the operator sees risk at a glance.
  const headlinePct = React.useMemo(() => {
    if (!account) return 0;
    return Math.max(
      usagePct(
        safeNum(account.dedicatedCoresUsed),
        safeNum(account.dedicatedCoreQuota),
      ),
      usagePct(
        safeNum(account.lowPriorityCoresUsed),
        safeNum(account.lowPriorityCoreQuota),
      ),
      usagePct(safeNum(account.poolCount), safeNum(account.poolQuota)),
    );
  }, [account]);

  const headlineTone: "destructive" | "warning" | "success" =
    headlinePct > CRITICAL_UTILIZATION_PCT
      ? "destructive"
      : headlinePct >= WARNING_UTILIZATION_PCT
        ? "warning"
        : "success";

  // Sort families by utilisation descending so the hottest family is at the
  // top — the operator's most common question is "which family is full?".
  const sortedFamilies = React.useMemo(() => {
    return [...families].sort((a, b) => {
      const aPct = usagePct(safeNum(a.coresUsed), safeNum(a.coreQuota));
      const bPct = usagePct(safeNum(b.coresUsed), safeNum(b.coreQuota));
      return bPct - aPct;
    });
  }, [families]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        size="lg"
        className="flex flex-col"
        aria-label="Account details"
      >
        <SheetHeader>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <SheetTitle className="flex items-center gap-2 truncate">
                <span className="truncate">
                  {account?.accountName ?? "Account details"}
                </span>
                {account && (
                  <Badge
                    variant={headlineTone}
                    aria-label={`Headline utilization ${headlinePct} percent`}
                  >
                    {headlinePct}% peak
                  </Badge>
                )}
              </SheetTitle>
              <SheetDescription className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                {account ? (
                  <>
                    <RegionBadge region={account.region || "—"} />
                    <span className="text-muted-foreground">
                      {account.resourceGroup || "—"}
                    </span>
                    {deepLinkUrl && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-2xs text-muted-foreground"
                        title="Shareable URL — paste into chat to deep-link a teammate to this account view"
                      >
                        Deep-link
                        <CopyButton
                          value={deepLinkUrl}
                          ariaLabel={`Copy shareable deep-link URL for ${account.accountName}`}
                        />
                      </span>
                    )}
                  </>
                ) : (
                  "No account selected."
                )}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4">
          {!account ? (
            loading ? (
              // Orchestrator's first refresh hasn't returned yet — skeleton
              // until either the account resolves or the cache is confirmed
              // empty. Prevents the deep-linked sheet from flashing
              // "Account not found" before the data arrives.
              <SkeletonLoader variant="card" cards={3} />
            ) : (
              <p className="m-0 text-sm text-muted-foreground">
                Account not found in the current dataset.
              </p>
            )
          ) : (
            <Tabs defaultValue="overview" className="flex flex-col gap-3">
              <TabsList aria-label="Account detail sections">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="families">
                  VM-families
                  {sortedFamilies.length > 0 && (
                    <span className="ml-1.5 inline-flex h-4 min-w-[1.25rem] items-center justify-center rounded-full bg-muted px-1 text-2xs tabular-nums text-muted-foreground">
                      {sortedFamilies.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="related">Related</TabsTrigger>
              </TabsList>

              {/* Overview: identity + raw quotas */}
              <TabsContent
                value="overview"
                className="flex flex-col gap-5"
              >
                <section
                  className="flex flex-col gap-2"
                  aria-labelledby="account-detail-identity"
                >
                  <h3
                    id="account-detail-identity"
                    className="m-0 text-base font-semibold text-foreground"
                  >
                    Identity
                  </h3>
                  <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 text-xs">
                    <dt className="text-muted-foreground">Subscription</dt>
                    <dd className="group/copy m-0 inline-flex items-center gap-1.5 break-all font-mono text-2xs text-foreground">
                      <span className="break-all">
                        {account.subscriptionId || "—"}
                      </span>
                      {account.subscriptionId && (
                        <CopyButton
                          value={account.subscriptionId}
                          ariaLabel="Copy subscription id"
                        />
                      )}
                    </dd>
                    <dt className="text-muted-foreground">Resource Group</dt>
                    <dd className="m-0 text-foreground">
                      {account.resourceGroup || "—"}
                    </dd>
                    <dt className="text-muted-foreground">Region</dt>
                    <dd className="m-0 text-foreground">
                      {account.region || "—"}
                    </dd>
                    <dt className="text-muted-foreground">Account ID</dt>
                    <dd className="group/copy m-0 inline-flex items-center gap-1.5 break-all font-mono text-2xs text-foreground">
                      <span className="break-all">{account.id}</span>
                      <CopyButton
                        value={account.id}
                        ariaLabel="Copy account ARM id"
                      />
                    </dd>
                  </dl>
                </section>

                <section
                  className="flex flex-col gap-2"
                  aria-labelledby="account-detail-quotas"
                >
                  <div className="flex items-center gap-1.5">
                    <h3
                      id="account-detail-quotas"
                      className="m-0 text-base font-semibold text-foreground"
                    >
                      Raw quotas
                    </h3>
                    <InfoTooltip content="Quota = the operator-configured Azure Batch limit. Used = currently allocated. Free = headroom available for new pools / nodes." />
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
                    <RawQuotaCard
                      label="Dedicated cores"
                      used={safeNum(account.dedicatedCoresUsed)}
                      quota={safeNum(account.dedicatedCoreQuota)}
                      free={safeNum(account.dedicatedCoresFree)}
                      hint="Reserved-capacity cores. Counts against the subscription's per-region dedicated-core ceiling — pool resize fails if the family or account quota is exhausted."
                    />
                    <RawQuotaCard
                      label="Low-priority cores"
                      used={safeNum(account.lowPriorityCoresUsed)}
                      quota={safeNum(account.lowPriorityCoreQuota)}
                      free={safeNum(account.lowPriorityCoresFree)}
                      hint="Spot/preemptible cores. Cheaper but can be evicted by Azure at any time; quota is independent from the dedicated-core ceiling."
                    />
                    <RawQuotaCard
                      label="Pools"
                      used={safeNum(account.poolCount)}
                      quota={safeNum(account.poolQuota)}
                      free={safeNum(account.poolsFree)}
                      hint="Maximum simultaneous pools (compute groups) this account may hold. Hitting this cap blocks Create-Pool even when core quota is still free."
                    />
                    <RawQuotaCard
                      label="Active jobs"
                      used={0}
                      quota={safeNum(account.activeJobAndJobScheduleQuota)}
                      free={safeNum(account.activeJobAndJobScheduleQuota)}
                      usedUnknown
                      hint="Maximum simultaneously-active jobs + job-schedules. Azure Batch does not expose a live used-count via the quota API, so only the cap is shown."
                    />
                  </div>
                </section>
              </TabsContent>

              {/* Per-VM-family breakdown */}
              <TabsContent
                value="families"
                className="flex flex-col gap-3"
              >
                <p
                  className={cn(
                    "m-0 inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-2xs",
                    familiesEnforced
                      ? "border-warning/40 bg-warning/10 text-warning"
                      : "border-border bg-muted/30 text-muted-foreground",
                  )}
                  role="note"
                >
                  {familiesEnforced ? (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      Per-family quotas are <strong>enforced</strong> — each VM
                      family below has its own independent cap.
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                      Per-family quotas are <strong>not enforced</strong>. Only
                      the cumulative core quota applies; the rows below are
                      informational.
                    </>
                  )}
                </p>
                {sortedFamilies.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border bg-card px-4 py-6 text-center text-xs text-muted-foreground">
                    No per-family data available for this account.
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-md border border-border bg-card">
                    <table
                      className="w-full text-xs"
                      aria-label="Per-VM-family quotas, sorted by utilization descending"
                    >
                      <thead className="bg-muted/30">
                        <tr>
                          <th
                            scope="col"
                            className="px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Family
                          </th>
                          <th
                            scope="col"
                            className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Used
                          </th>
                          <th
                            scope="col"
                            className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Quota
                          </th>
                          <th
                            scope="col"
                            className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Free
                          </th>
                          <th
                            scope="col"
                            className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Use %
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedFamilies.map((fam) => {
                          const used = safeNum(fam.coresUsed);
                          const quota = safeNum(fam.coreQuota);
                          const free = safeNum(fam.coresFree);
                          const pct = usagePct(used, quota);
                          const freeTone =
                            free > 0
                              ? "text-success"
                              : "text-muted-foreground";
                          const pctTone =
                            pct > CRITICAL_UTILIZATION_PCT
                              ? "text-destructive"
                              : pct >= WARNING_UTILIZATION_PCT
                                ? "text-warning"
                                : "text-success";
                          return (
                            <tr
                              key={fam.name}
                              className="border-t border-border transition-colors hover:bg-muted/20"
                            >
                              <td className="px-3 py-1.5 font-mono text-2xs text-foreground">
                                {fam.name}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-foreground">
                                {formatNumber(used)}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-foreground">
                                {formatNumber(quota)}
                              </td>
                              <td
                                className={cn(
                                  "px-3 py-1.5 text-right font-semibold tabular-nums",
                                  freeTone,
                                )}
                              >
                                {formatNumber(free)}
                              </td>
                              <td
                                className={cn(
                                  "px-3 py-1.5 text-right font-semibold tabular-nums",
                                  pctTone,
                                )}
                              >
                                {quota > 0 ? `${pct}%` : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>

              {/* Cross-page links */}
              <TabsContent
                value="related"
                className="flex flex-col gap-3"
              >
                <p className="m-0 text-xs text-muted-foreground">
                  Jump to other pages scoped to this account.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onNavigate(`/pool-info?accountId=${account.id}`)
                    }
                    aria-label={`View pools for ${account.accountName}`}
                  >
                    <ExternalLink />
                    Pools
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onNavigate(`/nodes?accountId=${account.id}`)
                    }
                    aria-label={`View nodes for ${account.accountName}`}
                  >
                    <ExternalLink />
                    Nodes
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onNavigate(`/pools?accountId=${account.id}`)
                    }
                    aria-label={`Open pool creation for ${account.accountName}`}
                  >
                    <ExternalLink />
                    Create pool
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </SheetBody>
        <SheetFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            aria-label="Close account details"
          >
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

interface RawQuotaCardProps {
  label: string;
  used: number;
  quota: number;
  free: number;
  /**
   * When true, render the "used" portion as "—" because Azure Batch
   * doesn't expose a used-count for this metric (active jobs is the
   * only case today). The bar still tracks quota vs free.
   */
  usedUnknown?: boolean;
  /**
   * Optional inline tooltip rendered next to the label. Used to
   * disambiguate LP vs Dedicated vs ActiveJob for operators who
   * are new to Azure Batch's quota terminology.
   */
  hint?: string;
}

type QuotaTone = "destructive" | "warning" | "success" | "muted";
const QUOTA_TRACK_TONE: Record<QuotaTone, string> = {
  muted: "bg-muted",
  destructive: "bg-destructive/15",
  warning: "bg-warning/15",
  success: "bg-success/15",
};
const QUOTA_FILL_TONE: Record<QuotaTone, string> = {
  muted: "[&>*]:bg-muted-foreground/60",
  destructive: "[&>*]:bg-destructive",
  warning: "[&>*]:bg-warning",
  success: "[&>*]:bg-success",
};
const QUOTA_LABEL_TONE: Record<QuotaTone, string> = {
  muted: "text-muted-foreground",
  destructive: "text-destructive",
  warning: "text-warning",
  success: "text-success",
};

const RawQuotaCard: React.FC<RawQuotaCardProps> = React.memo(
  ({ label, used, quota, free, usedUnknown = false, hint }) => {
    const pct = usagePct(used, quota);
    // Color-coded threshold band — matches the row-level UsageBar tone scale
    // so the operator's color → severity mapping is consistent across the
    // page. We tint the Progress *track* with a faded tone so the unfilled
    // portion also carries a hint of the band, and pass a tone-specific
    // class to color the indicator fill.
    const tone: QuotaTone =
      quota <= 0
        ? "muted"
        : pct > CRITICAL_UTILIZATION_PCT
          ? "destructive"
          : pct >= WARNING_UTILIZATION_PCT
            ? "warning"
            : "success";
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3 transition-shadow duration-200 ease-out hover:shadow-elev-1">
        <span className="inline-flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground">
          {label}
          {hint && <InfoTooltip content={hint} size={11} />}
        </span>
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "text-xs font-semibold tabular-nums",
              QUOTA_LABEL_TONE[tone],
            )}
          >
            {usedUnknown ? "—" : formatNumber(used)} / {formatNumber(quota)}
          </span>
          <span
            className={cn(
              "text-2xs tabular-nums",
              QUOTA_LABEL_TONE[tone],
            )}
            aria-hidden
          >
            {usedUnknown || quota <= 0 ? "—" : `${pct}%`}
          </span>
        </div>
        <Progress
          value={usedUnknown ? 0 : pct}
          className={cn(
            "h-1.5",
            QUOTA_TRACK_TONE[tone],
            QUOTA_FILL_TONE[tone],
          )}
          aria-label={
            usedUnknown
              ? `${label}: ${quota} quota (used count unavailable)`
              : `${label}: ${used} of ${quota} (${pct} percent used)`
          }
          aria-valuetext={
            usedUnknown
              ? "used count not available from Azure Batch quota API"
              : `${pct}% — ${
                  tone === "destructive"
                    ? "critical"
                    : tone === "warning"
                      ? "warning"
                      : tone === "success"
                        ? "healthy"
                        : "no quota assigned"
                }`
          }
        />
        <span className="text-2xs text-muted-foreground tabular-nums">
          Free: {formatNumber(free)}
        </span>
      </div>
    );
  },
);
RawQuotaCard.displayName = "RawQuotaCard";

/* ------------------------------------------------------------------ */
/*  Quota Glance — fleet-wide gauges + top utilization accounts         */
/* ------------------------------------------------------------------ */

interface QuotaGlanceProps {
  accounts: AccountInfo[];
  /** Called when the user clicks a "most utilized" account → opens sheet. */
  onAccountClick: (id: string) => void;
}

const QuotaGlance: React.FC<QuotaGlanceProps> = ({
  accounts,
  onAccountClick,
}) => {
  // Aggregate totals across the fleet.
  const totals = React.useMemo(() => {
    let dedicatedUsed = 0;
    let dedicatedQuota = 0;
    let lpUsed = 0;
    let lpQuota = 0;
    let poolsUsed = 0;
    let poolsQuota = 0;
    for (const a of accounts) {
      dedicatedUsed += safeNum(a.dedicatedCoresUsed);
      dedicatedQuota += safeNum(a.dedicatedCoreQuota);
      lpUsed += safeNum(a.lowPriorityCoresUsed);
      lpQuota += safeNum(a.lowPriorityCoreQuota);
      poolsUsed += safeNum(a.poolCount);
      poolsQuota += safeNum(a.poolQuota);
    }
    return {
      dedicatedUsed,
      dedicatedQuota,
      lpUsed,
      lpQuota,
      poolsUsed,
      poolsQuota,
    };
  }, [accounts]);

  // Top 5 accounts by combined core utilization (used/quota), filtered to
  // accounts that actually have quota assigned. Surfaces the accounts most
  // at risk of hitting their cap so the operator can resize / migrate.
  const topUtilization = React.useMemo(() => {
    return accounts
      .map((a) => {
        const dq = safeNum(a.dedicatedCoreQuota);
        const lq = safeNum(a.lowPriorityCoreQuota);
        const totalQuota = dq + lq;
        if (totalQuota === 0) return null;
        const totalUsed =
          safeNum(a.dedicatedCoresUsed) + safeNum(a.lowPriorityCoresUsed);
        return {
          id: a.id,
          accountName: a.accountName,
          region: a.region,
          totalUsed,
          totalQuota,
          ratio: totalUsed / totalQuota,
        };
      })
      .filter(
        (
          x,
        ): x is {
          id: string;
          accountName: string;
          region: string;
          totalUsed: number;
          totalQuota: number;
          ratio: number;
        } => x !== null,
      )
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 5);
  }, [accounts]);

  return (
    <section
      role="region"
      aria-labelledby="quota-glance-heading"
      className="grid grid-cols-1 gap-3 lg:grid-cols-3"
    >
      {/* Aggregate fleet gauges */}
      <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 transition-shadow duration-200 ease-out hover:shadow-elev-1 lg:col-span-2">
        <h3
          id="quota-glance-heading"
          className="m-0 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          <GaugeIcon className="h-3.5 w-3.5" aria-hidden />
          Quota at a glance ({accounts.length} accounts)
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Gauge
            label="Dedicated cores"
            unit="cores"
            used={totals.dedicatedUsed}
            total={totals.dedicatedQuota}
            size="md"
          />
          <Gauge
            label="Low-priority cores"
            unit="cores"
            used={totals.lpUsed}
            total={totals.lpQuota}
            size="md"
          />
          <Gauge
            label="Pools"
            unit="pools"
            used={totals.poolsUsed}
            total={totals.poolsQuota}
            size="md"
          />
        </div>
      </div>

      {/* Top 5 accounts by utilization */}
      <div className="rounded-md border border-border bg-card p-4 transition-shadow duration-200 ease-out hover:shadow-elev-1">
        <div className="flex items-center justify-between">
          <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Most utilized accounts
          </h3>
          <InfoTooltip content="Top 5 by combined core utilization (dedicated + LP). Click a row to open the detail sheet." />
        </div>
        {topUtilization.length === 0 ? (
          <p className="mt-2 text-2xs text-muted-foreground">
            No accounts have a configured quota yet.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2.5">
            {topUtilization.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onAccountClick(row.id)}
                  className="block w-full rounded-md p-1 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Open details for ${row.accountName} in ${row.region}`}
                >
                  <Gauge
                    label={
                      <span className="inline-flex items-center gap-1.5">
                        <span className="truncate font-mono text-2xs text-foreground">
                          {row.accountName}
                        </span>
                        <span className="text-2xs text-muted-foreground/70">
                          {row.region}
                        </span>
                      </span>
                    }
                    used={row.totalUsed}
                    total={row.totalQuota}
                    size="sm"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------ */
/*  Auto-refresh countdown chip                                        */
/* ------------------------------------------------------------------ */

// COORDINATOR: extract <AutoRefreshChip> — duplicated with overview, pools,
// nodes, pool-info pages. Same 30s interval + tooltip + countdown pattern.
// Promote to `components/shared/auto-refresh-chip.tsx` once 2+ pages adopt
// a uniform interval contract.
interface AutoRefreshChipProps {
  enabled: boolean;
  loading: boolean;
  lastRefreshedAt: number | null;
}

const AutoRefreshChip: React.FC<AutoRefreshChipProps> = ({
  enabled,
  loading,
  lastRefreshedAt,
}) => {
  // Tick every second so the countdown moves visibly.
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!enabled || lastRefreshedAt == null) return;
    const id = setInterval(force, 1000);
    return () => clearInterval(id);
  }, [enabled, lastRefreshedAt]);

  if (!enabled) return null;
  if (lastRefreshedAt == null) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground"
        aria-live="polite"
      >
        <Activity className="h-3 w-3 animate-pulse motion-reduce:animate-none" />
        Auto-refresh armed
      </span>
    );
  }
  const elapsed = Date.now() - lastRefreshedAt;
  const remaining = Math.max(0, AUTO_REFRESH_INTERVAL_MS - elapsed);
  const seconds = Math.ceil(remaining / 1000);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs tabular-nums",
            loading
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground",
          )}
          aria-live="polite"
        >
          <Activity
            className={cn(
              "h-3 w-3",
              loading
                ? "animate-spin motion-reduce:animate-none"
                : "animate-pulse motion-reduce:animate-none",
            )}
          />
          {loading ? "Refreshing…" : `Next refresh in ${seconds}s`}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Auto-refresh runs every 30 seconds. Press <Kbd>a</Kbd> to toggle.
      </TooltipContent>
    </Tooltip>
  );
};

/* ------------------------------------------------------------------ */
/*  Chord-sequence hotkeys (g a / g p)                                 */
/* ------------------------------------------------------------------ */

/**
 * useChordSequence — listen for a two-key chord like `g a`. The buffer
 * resets after `CHORD_BUFFER_TIMEOUT_MS` so a stray `g` doesn't capture
 * the next unrelated keypress. Ignores edit-target events so typing in
 * a search box doesn't accidentally fire navigation.
 *
 * Why local: the shared `useShortcut` matches single chords only. We
 * don't want to extend the shared hook for an account-info-only feature.
 */
function useChordSequence(
  prefix: string,
  bindings: Readonly<Record<string, () => void>>,
  enabled: boolean = true,
): void {
  // Stable ref so re-renders don't rebind the listener.
  const bindingsRef = React.useRef(bindings);
  bindingsRef.current = bindings;
  React.useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let armed = false;
    let timer: number | null = null;
    const disarm = () => {
      armed = false;
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // Skip when focus is in an editable target.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        )
          return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (!armed) {
        if (key === prefix) {
          armed = true;
          timer = window.setTimeout(disarm, CHORD_BUFFER_TIMEOUT_MS);
        }
        return;
      }
      // armed → second key
      const handler = bindingsRef.current[key];
      disarm();
      if (handler) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disarm();
      window.removeEventListener("keydown", onKey);
    };
  }, [prefix, enabled]);
}

/* ------------------------------------------------------------------ */
/*  Threshold-alert banner                                             */
/*  Defender-side surface inspired by NetSPI MicroBurst Batch recon:   */
/*  Inspired by: New folder/_analysis_netspi.md — MicroBurst           */
/*  Get-AzBatchAccountInfo / Get-AzBatchPools enumerates the same      */
/*  quota fields offensively; surfacing "you're ≥X%" is the defender   */
/*  view of the same data so an operator notices BEFORE quota runs out.*/
/* ------------------------------------------------------------------ */

interface ThresholdAlert {
  id: string;
  accountName: string;
  region: string;
  peakPct: number;
  reason: string;
}

/**
 * Compute which accounts cross the operator-configured threshold. Peak
 * utilization is the max of (dedicated, LP, pool) — matches the
 * `headlinePct` used in the detail sheet so the operator's mental model
 * is consistent.
 */
function computeThresholdAlerts(
  accounts: ReadonlyArray<AccountInfo>,
  thresholdPct: number,
): ThresholdAlert[] {
  const out: ThresholdAlert[] = [];
  for (const a of accounts) {
    const dPct = usagePct(
      safeNum(a.dedicatedCoresUsed),
      safeNum(a.dedicatedCoreQuota),
    );
    const lPct = usagePct(
      safeNum(a.lowPriorityCoresUsed),
      safeNum(a.lowPriorityCoreQuota),
    );
    const pPct = usagePct(safeNum(a.poolCount), safeNum(a.poolQuota));
    const peak = Math.max(dPct, lPct, pPct);
    if (peak < thresholdPct) continue;
    // Identify which axis is hottest so the banner is actionable.
    let reason = "core capacity";
    if (pPct === peak) reason = "pool count";
    else if (lPct === peak) reason = "low-priority cores";
    else if (dPct === peak) reason = "dedicated cores";
    out.push({
      id: a.id,
      accountName: a.accountName,
      region: a.region ?? "",
      peakPct: peak,
      reason,
    });
  }
  // Hottest first — operator's eye lands on highest-risk account.
  out.sort((a, b) => b.peakPct - a.peakPct);
  return out;
}

interface ThresholdAlertsCardProps {
  alerts: ReadonlyArray<ThresholdAlert>;
  thresholdPct: number;
  onChangeThreshold: (next: number) => void;
  onOpenAccount: (id: string) => void;
}

const ThresholdAlertsCard: React.FC<ThresholdAlertsCardProps> = React.memo(
  ({ alerts, thresholdPct, onChangeThreshold, onOpenAccount }) => {
    return (
      <section
        className="rounded-md border border-warning/40 bg-warning/5 p-3"
        role="region"
        aria-labelledby="threshold-alerts-heading"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3
            id="threshold-alerts-heading"
            className="m-0 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-warning"
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            Threshold alerts ({alerts.length})
          </h3>
          <InfoTooltip
            size={12}
            content="Surfaces accounts whose peak utilization (worst of dedicated, LP, pool) crosses the configured threshold. Setting is persisted across reloads."
          />
          <div className="ml-auto flex items-center gap-1.5">
            <Label
              htmlFor="account-info-threshold"
              className="text-2xs uppercase tracking-wider text-muted-foreground"
            >
              Warn at
            </Label>
            <Select
              value={String(thresholdPct)}
              onValueChange={(v) => {
                const n = Number(v);
                if (Number.isFinite(n)) onChangeThreshold(n);
              }}
            >
              <SelectTrigger
                id="account-info-threshold"
                className="h-7 w-20"
                aria-label="Threshold-alert percent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THRESHOLD_ALERT_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <ul className="mt-2 flex flex-col gap-1">
          {alerts.slice(0, 6).map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onOpenAccount(a.id)}
                className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-2xs transition-colors hover:bg-warning/10 focus-visible:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open ${a.accountName} — ${a.peakPct}% on ${a.reason}`}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-foreground">
                    {a.accountName}
                  </span>
                  {a.region && (
                    <span className="text-muted-foreground/70">
                      {a.region}
                    </span>
                  )}
                  <span className="text-muted-foreground">— {a.reason}</span>
                </span>
                <span className="tabular-nums font-semibold text-warning">
                  {a.peakPct}%
                </span>
              </button>
            </li>
          ))}
          {alerts.length > 6 && (
            <li className="px-1.5 text-2xs text-muted-foreground">
              … {alerts.length - 6} more not shown — narrow the table or use the
              critical chip above to see them all.
            </li>
          )}
        </ul>
      </section>
    );
  },
);
ThresholdAlertsCard.displayName = "ThresholdAlertsCard";

/* ------------------------------------------------------------------ */
/*  Lateral-surface scorer + unenforced-family flag                     */
/*  Inspired by: New folder/_analysis_netspi.md — NetSPI MicroBurst    */
/*  resource-plane enum maps Batch accounts → families → pools as the  */
/*  attacker's pivot graph; surfacing the cardinality lets a defender  */
/*  see at-a-glance which account has the widest pivot surface.        */
/*  Inspired by: New folder/_analysis_defender_view.md — Azucar /      */
/*  ScoutSuite policy checks: an unenforced per-family quota with a    */
/*  hot family is a starvation-blast-radius risk.                      */
/* ------------------------------------------------------------------ */

interface SurfaceRiskRow {
  id: string;
  accountName: string;
  region: string;
  familiesWithQuota: number;
  unenforcedAndHot: boolean;
  hottestFamilyName: string | null;
  hottestFamilyPct: number;
}

function computeSurfaceRiskRows(
  accounts: ReadonlyArray<AccountInfo>,
): SurfaceRiskRow[] {
  const rows: SurfaceRiskRow[] = [];
  for (const a of accounts) {
    const families = a.dedicatedCoreQuotaPerVMFamily ?? [];
    let familiesWithQuota = 0;
    let hottestPct = 0;
    let hottestName: string | null = null;
    for (const fam of families) {
      const q = safeNum(fam.coreQuota);
      if (q <= 0) continue;
      familiesWithQuota++;
      const pct = usagePct(safeNum(fam.coresUsed), q);
      if (pct > hottestPct) {
        hottestPct = pct;
        hottestName = fam.name ?? null;
      }
    }
    const enforced = a.dedicatedCoreQuotaPerVMFamilyEnforced ?? false;
    const unenforcedAndHot =
      !enforced && hottestPct > CRITICAL_UTILIZATION_PCT;
    // Skip accounts with no families and no risk flag — nothing to report.
    if (familiesWithQuota === 0 && !unenforcedAndHot) continue;
    rows.push({
      id: a.id,
      accountName: a.accountName,
      region: a.region ?? "",
      familiesWithQuota,
      unenforcedAndHot,
      hottestFamilyName: hottestName,
      hottestFamilyPct: hottestPct,
    });
  }
  // Sort by (unenforcedAndHot desc, familiesWithQuota desc) so the
  // riskiest pivot-surface accounts float to the top.
  rows.sort((a, b) => {
    if (a.unenforcedAndHot !== b.unenforcedAndHot)
      return a.unenforcedAndHot ? -1 : 1;
    return b.familiesWithQuota - a.familiesWithQuota;
  });
  return rows;
}

interface SurfaceRiskCardProps {
  rows: ReadonlyArray<SurfaceRiskRow>;
  onOpenAccount: (id: string) => void;
}

const SurfaceRiskCard: React.FC<SurfaceRiskCardProps> = React.memo(
  ({ rows, onOpenAccount }) => {
    const flagged = rows.filter((r) => r.unenforcedAndHot);
    if (rows.length === 0) return null;
    return (
      <section
        className="rounded-md border border-border bg-card p-3"
        role="region"
        aria-labelledby="surface-risk-heading"
      >
        <div className="flex flex-wrap items-center gap-x-2">
          <h3
            id="surface-risk-heading"
            className="m-0 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            <Cpu className="h-3.5 w-3.5" aria-hidden />
            Lateral surface
          </h3>
          <InfoTooltip
            size={12}
            content="Count of distinct VM-families with assigned quota per account. More families = more places an attacker who lands a pool can pivot. Flagged when per-family quotas are NOT enforced AND a single family is already critical — risk of one family starving all others. Inspired by NetSPI MicroBurst Batch enumeration + Azucar/ScoutSuite policy lens."
          />
        </div>
        {flagged.length > 0 && (
          <div
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-2xs text-destructive"
            role="note"
          >
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {flagged.length} account{flagged.length === 1 ? "" : "s"} with{" "}
            <strong>unenforced</strong> per-family quotas AND a hot family.
          </div>
        )}
        <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {rows.slice(0, 6).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpenAccount(r.id)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  r.unenforcedAndHot
                    ? "border-destructive/40 bg-destructive/5 hover:bg-destructive/10"
                    : "border-border bg-muted/20 hover:bg-muted/40",
                )}
                aria-label={`Open ${r.accountName} — ${r.familiesWithQuota} VM-families with quota`}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-foreground">
                    {r.accountName}
                  </span>
                  {r.region && (
                    <span className="text-muted-foreground/70">
                      {r.region}
                    </span>
                  )}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  <span className="text-muted-foreground">families</span>
                  <span className="tabular-nums font-semibold text-foreground">
                    {r.familiesWithQuota}
                  </span>
                  {r.hottestFamilyName && r.hottestFamilyPct > 0 && (
                    <span
                      className={cn(
                        "rounded bg-muted px-1 tabular-nums",
                        r.hottestFamilyPct > CRITICAL_UTILIZATION_PCT
                          ? "text-destructive"
                          : r.hottestFamilyPct >= WARNING_UTILIZATION_PCT
                            ? "text-warning"
                            : "text-success",
                      )}
                      title={`Hottest family: ${r.hottestFamilyName}`}
                    >
                      {r.hottestFamilyPct}%
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  },
);
SurfaceRiskCard.displayName = "SurfaceRiskCard";

/* ------------------------------------------------------------------ */
/*  Subscription-collision detector                                    */
/*  Inspired by: New folder/_analysis_netspi.md — MicroBurst surfaces  */
/*  subscription-scoped core ceilings; multiple Batch accounts under   */
/*  the same subscription share that ceiling so an account-level "free"*/
/*  number can be misleading.                                          */
/* ------------------------------------------------------------------ */

interface SubscriptionCollision {
  subscriptionId: string;
  accountCount: number;
  combinedUsed: number;
  combinedQuota: number;
  combinedPct: number;
  accountIds: string[];
}

function computeSubscriptionCollisions(
  accounts: ReadonlyArray<AccountInfo>,
): SubscriptionCollision[] {
  const bySub = new Map<
    string,
    {
      accountCount: number;
      combinedUsed: number;
      combinedQuota: number;
      accountIds: string[];
    }
  >();
  for (const a of accounts) {
    const sub = a.subscriptionId ?? "";
    if (!sub) continue;
    const used =
      safeNum(a.dedicatedCoresUsed) + safeNum(a.lowPriorityCoresUsed);
    const quota =
      safeNum(a.dedicatedCoreQuota) + safeNum(a.lowPriorityCoreQuota);
    const existing = bySub.get(sub);
    if (existing) {
      existing.accountCount++;
      existing.combinedUsed += used;
      existing.combinedQuota += quota;
      existing.accountIds.push(a.id);
    } else {
      bySub.set(sub, {
        accountCount: 1,
        combinedUsed: used,
        combinedQuota: quota,
        accountIds: [a.id],
      });
    }
  }
  const out: SubscriptionCollision[] = [];
  for (const [sub, v] of bySub) {
    if (v.accountCount < 2) continue;
    const pct = usagePct(v.combinedUsed, v.combinedQuota);
    if (pct < WARNING_UTILIZATION_PCT) continue;
    out.push({
      subscriptionId: sub,
      accountCount: v.accountCount,
      combinedUsed: v.combinedUsed,
      combinedQuota: v.combinedQuota,
      combinedPct: pct,
      accountIds: v.accountIds,
    });
  }
  out.sort((a, b) => b.combinedPct - a.combinedPct);
  return out;
}

interface SubscriptionCollisionsCardProps {
  collisions: ReadonlyArray<SubscriptionCollision>;
  onOpenAccount: (id: string) => void;
}

const SubscriptionCollisionsCard: React.FC<SubscriptionCollisionsCardProps> =
  React.memo(({ collisions, onOpenAccount }) => {
    if (collisions.length === 0) return null;
    return (
      <section
        className="rounded-md border border-border bg-card p-3"
        role="region"
        aria-labelledby="sub-collisions-heading"
      >
        <div className="flex flex-wrap items-center gap-x-2">
          <h3
            id="sub-collisions-heading"
            className="m-0 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            <Users className="h-3.5 w-3.5" aria-hidden />
            Subscription collisions
          </h3>
          <InfoTooltip
            size={12}
            content="Subscriptions that host 2+ Batch accounts whose combined core utilization is already ≥50%. The subscription-level core ceiling will hit before any single account does. Inspired by NetSPI MicroBurst subscription-plane recon."
          />
        </div>
        <ul className="mt-2 flex flex-col gap-1">
          {collisions.slice(0, 4).map((c) => {
            const subShort =
              c.subscriptionId.length > 8
                ? `${c.subscriptionId.slice(0, 8)}…`
                : c.subscriptionId;
            return (
              <li key={c.subscriptionId}>
                <div
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5 text-2xs",
                    c.combinedPct > CRITICAL_UTILIZATION_PCT
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-warning/40 bg-warning/5",
                  )}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="font-mono text-foreground"
                      title={c.subscriptionId}
                    >
                      {subShort}
                    </span>
                    <span className="text-muted-foreground">
                      {c.accountCount} accounts
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={cn(
                        "tabular-nums font-semibold",
                        c.combinedPct > CRITICAL_UTILIZATION_PCT
                          ? "text-destructive"
                          : "text-warning",
                      )}
                    >
                      {c.combinedPct}%
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      ({formatNumber(c.combinedUsed)}/
                      {formatNumber(c.combinedQuota)})
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenAccount(c.accountIds[0]!)}
                      className="rounded bg-muted px-1.5 py-0.5 text-foreground transition-colors hover:bg-muted-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Open first account in subscription ${subShort}`}
                    >
                      Open
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );
  });
SubscriptionCollisionsCard.displayName = "SubscriptionCollisionsCard";

/* ------------------------------------------------------------------ */
/*  Inner page                                                         */
/* ------------------------------------------------------------------ */

const AccountInfoPageInner: React.FC<AccountInfoPageProps> = ({
  orchestrator,
}) => {
  const state = useMultiRegionState();
  const navigate = useNavigate();
  const { accountId: routeAccountId } = useParams<{ accountId?: string }>();

  const [loading, setLoading] = React.useState(false);
  // Persisted across reload — flipping the toggle off here once keeps it
  // off on subsequent loads. Default off because a 30 s polling cycle
  // costs one ARM round-trip per account/region grid cell.
  const [autoRefresh, setAutoRefresh] = usePersistedState<boolean>(
    "azbm.account-info.auto-refresh.v1",
    false,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  // Tracks when the most recent successful refresh finished — drives both the
  // "Last refreshed XX ago" pill and the auto-refresh countdown chip.
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<number | null>(
    null,
  );
  // Tracks the most recent refresh trigger reason (manual / auto / mount /
  // initial) so a screen-reader user knows what happened when the page
  // re-paints. Surfaced only to the polite live region.
  const [refreshReason, setRefreshReason] = React.useState<string | null>(null);
  // URL-synced filters per Contract §4.3. The utilization band now rides on
  // the URL too so a deep link captures the operator's full view (region +
  // low-free threshold + free-text query + risk band).
  const [filters, setFilters] = useUrlState(INITIAL_FILTERS, { replace: true });
  // URL state values are `string | string[] | undefined` per the hook's
  // generic constraint. Narrow to plain `string` here so downstream consumers
  // (Select value props, search.setQuery, ExportMenu metadata) keep their
  // scalar-string types.
  const regionFilter = firstString(filters.region);
  const lowFreeFilter = firstString(filters.lowFree);
  const urlQuery = firstString(filters.q);
  const utilizationBand: UtilizationBand = React.useMemo(
    () => coerceBand(firstString(filters.band)),
    [filters.band],
  );
  const setUtilizationBand = React.useCallback(
    (band: UtilizationBand) =>
      setFilters({ band: band === "all" ? "" : band }),
    [setFilters],
  );

  // Memoize: `state.accountInfos ?? []` allocates a fresh empty array on every
  // render when the slice is nullish, which would invalidate every downstream
  // memo (regionOptions, accountById, utilizationCounts, alerts). Guard with
  // useMemo so the empty-array identity is stable until the store updates.
  const accountInfos = React.useMemo<ReadonlyArray<AccountInfo>>(
    () => state.accountInfos ?? [],
    [state.accountInfos],
  );

  // Operator-configurable threshold for the alert banner. Persisted across
  // reloads — once an operator picks "warn at 90%" for a noisy fleet, that
  // sticks. v1 schema; if the shape evolves bump the key.
  const [thresholdAlertPct, setThresholdAlertPct] = usePersistedState<number>(
    THRESHOLD_ALERT_KEY,
    THRESHOLD_ALERT_DEFAULT_PCT,
  );

  // ---- Page-level ARM token tracker ---------------------------------------
  // This page reads pre-fetched account info from the global store + the
  // orchestrator; it does NOT acquire/hold its own ARM token. But the
  // operator may sit on this view for a long time (auto-refresh on, glancing
  // at quota usage), and any of the deep-link sheet navigations (Pools,
  // Nodes, Create Pool) require a valid ARM token on the destination page.
  // Surface expiry awareness using the first signed-in account so the
  // operator gets a heads-up before they click through to an ARM-heavy view.
  const primaryAccount = (state.azureAccounts ?? [])[0];
  const armTokenTracker = useArmToken(
    primaryAccount?.homeAccountId,
    primaryAccount?.tenantId,
  );

  // ---- Refresh handler -----------------------------------------------------
  // `inFlightRef` short-circuits overlapping refreshes when the auto-refresh
  // tick fires while a manual refresh is still pending — important because
  // the orchestrator action issues one ARM round-trip per account.
  // `manualAbortRef` lets the Stop button actually cancel the in-flight
  // orchestrator round-trip (the action accepts `signal`).
  // COORDINATOR: extract <RefreshWithAbort> hook — duplicated with overview,
  // pools, nodes, pool-info pages (auto-refresh + inFlightRef + AbortController
  // + lastRefreshedAt + stale-banner is the same recipe everywhere).
  const inFlightRef = React.useRef(false);
  const manualAbortRef = React.useRef<AbortController | null>(null);
  const refresh = React.useCallback(
    async (reason: string = "manual", signal?: AbortSignal) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      // For manual / mount / retry triggers we own the controller so Stop can
      // cancel. For auto-refresh ticks the caller may pass its own signal.
      let ownedController: AbortController | null = null;
      let effectiveSignal: AbortSignal | undefined = signal;
      if (!signal) {
        ownedController = new AbortController();
        manualAbortRef.current = ownedController;
        effectiveSignal = ownedController.signal;
      }
      setLoading(true);
      setError(null);
      setRefreshReason(reason);
      try {
        await orchestrator.execute({
          action: "refresh_account_info",
          payload: {},
          signal: effectiveSignal,
        });
        if (!effectiveSignal?.aborted) setLastRefreshedAt(Date.now());
      } catch (e: unknown) {
        if (effectiveSignal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        // Record refresh failures so the audit-log page reflects what the
        // operator saw. Successful refreshes are intentionally NOT audited:
        // they are pure read-side ARM calls and would drown the log.
        auditLog.record({
          actor: "ui:account-info",
          action: "refresh_account_info",
          target: "fleet",
          status: "failure",
          error: msg,
          details: { reason },
        });
      } finally {
        if (!effectiveSignal?.aborted) setLoading(false);
        inFlightRef.current = false;
        if (ownedController && manualAbortRef.current === ownedController) {
          manualAbortRef.current = null;
        }
      }
    },
    [orchestrator],
  );

  // Stop button: cancel the in-flight ARM round-trip (if any), drop the
  // spinner, and disable auto-refresh so the next tick doesn't fire. Records
  // an audit entry — operator-initiated cancellation of fleet activity is
  // worth keeping a trail of even though it isn't strictly "destructive".
  const stop = React.useCallback(() => {
    if (manualAbortRef.current) {
      manualAbortRef.current.abort();
      manualAbortRef.current = null;
    }
    setLoading(false);
    setAutoRefresh(false);
    auditLog.record({
      actor: "ui:account-info",
      action: "refresh_account_info.stop",
      target: "fleet",
      status: "success",
    });
  }, [setAutoRefresh]);

  // Auto-load on mount when accountInfos is empty. Uses a ref so React 18
  // double-invoked StrictMode mounts don't fire two parallel refreshes.
  // The `useAbortableEffect` signal propagates into the orchestrator so an
  // immediate unmount cancels in-flight ARM round-trips.
  const autoLoadedRef = React.useRef(false);
  useAbortableEffect(
    (signal) => {
      if (autoLoadedRef.current) return;
      if (accountInfos.length > 0) {
        // Data already in the store from a prior visit — record a synthetic
        // "last refreshed" so the chip + stale warning have a reference.
        if (lastRefreshedAt == null) setLastRefreshedAt(Date.now());
        return;
      }
      autoLoadedRef.current = true;
      void refresh("mount", signal);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountInfos.length, refresh],
  );

  // Auto-refresh interval. Skips ticks while a refresh is in flight.
  React.useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (inFlightRef.current) return;
      void refresh("auto");
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, refresh]);

  // ---- Region facet options ------------------------------------------------
  const regionOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const a of accountInfos) {
      if (a.region) set.add(a.region);
    }
    return Array.from(set).sort(compareStrings);
  }, [accountInfos]);

  // ---- Search (free-text) --------------------------------------------------
  // Local input state (instant typing UX); we mirror the *debounced* query
  // into the URL so a deep link still reflects the search.
  const [searchInput, setSearchInput] = React.useState(urlQuery);
  // `accountInfos` is typed `ReadonlyArray<AccountInfo>` (the memo above
  // freezes the empty-array identity), but `useSearch` expects a mutable
  // `AccountInfo[]`. The hook treats its input as read-only, so a structural
  // cast is safe; spread would re-allocate every render and defeat the memo.
  const search = useSearch<AccountInfo>(
    accountInfos as AccountInfo[],
    ["accountName", "region", "resourceGroup", "subscriptionId"],
    200,
  );
  // Mirror URL → input on back/forward navigation. Only fires when the URL
  // value differs from what we typed.
  React.useEffect(() => {
    setSearchInput(urlQuery);
    search.setQuery(urlQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery]);
  // Mirror input → URL (debounced inside useUrlState already so this is fine).
  React.useEffect(() => {
    if (searchInput === urlQuery) return;
    setFilters({ q: searchInput });
    search.setQuery(searchInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Apply search *before* facets so the count badges reflect post-search
  // numbers (matches how Nodes / EA pages compose their pipelines).
  const searchedAccounts = search.filteredItems;

  // ---- Filter pipeline -----------------------------------------------------
  const filteredAccounts = React.useMemo(() => {
    let rows = searchedAccounts;
    if (regionFilter) rows = rows.filter((a) => a.region === regionFilter);
    if (lowFreeFilter) {
      const threshold = Number(lowFreeFilter);
      if (Number.isFinite(threshold)) {
        rows = rows.filter(
          (a) => safeNum(a.lowPriorityCoresFree) < threshold,
        );
      }
    }
    if (utilizationBand !== "all") {
      rows = rows.filter((a) => {
        const dq = safeNum(a.dedicatedCoreQuota);
        const lq = safeNum(a.lowPriorityCoreQuota);
        const totalQuota = dq + lq;
        if (totalQuota === 0) return utilizationBand === "healthy";
        const totalUsed =
          safeNum(a.dedicatedCoresUsed) + safeNum(a.lowPriorityCoresUsed);
        const pct = Math.round((totalUsed / totalQuota) * 100);
        if (utilizationBand === "critical") return pct > CRITICAL_UTILIZATION_PCT;
        if (utilizationBand === "warning")
          return (
            pct >= WARNING_UTILIZATION_PCT && pct <= CRITICAL_UTILIZATION_PCT
          );
        return pct < WARNING_UTILIZATION_PCT;
      });
    }
    return rows;
  }, [
    searchedAccounts,
    regionFilter,
    lowFreeFilter,
    utilizationBand,
  ]);

  // Utilization counts across the *un-filtered* pool — chips always show the
  // full-fleet picture so the operator can see "5 critical" even after
  // narrowing the table.
  const utilizationCounts = React.useMemo(() => {
    let critical = 0;
    let warning = 0;
    let healthy = 0;
    for (const a of accountInfos) {
      const dq = safeNum(a.dedicatedCoreQuota);
      const lq = safeNum(a.lowPriorityCoreQuota);
      const totalQuota = dq + lq;
      const totalUsed =
        safeNum(a.dedicatedCoresUsed) + safeNum(a.lowPriorityCoresUsed);
      if (totalQuota === 0) {
        healthy++;
        continue;
      }
      const pct = Math.round((totalUsed / totalQuota) * 100);
      if (pct > CRITICAL_UTILIZATION_PCT) critical++;
      else if (pct >= WARNING_UTILIZATION_PCT) warning++;
      else healthy++;
    }
    return { critical, warning, healthy };
  }, [accountInfos]);

  // Reset selection when underlying set shrinks.
  React.useEffect(() => {
    if (selection.size === 0) return;
    const visibleIds = new Set(filteredAccounts.map((a) => a.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of selection) {
      if (visibleIds.has(id)) {
        next.add(id);
      } else {
        changed = true;
      }
    }
    if (changed) setSelection(next);
  }, [filteredAccounts, selection]);

  // Aggregated summary via shared helper.
  const summary = React.useMemo(
    () => summarizeAccountInfos(filteredAccounts),
    [filteredAccounts],
  );

  // ---- Filter setters ------------------------------------------------------
  const handleRegionChange = React.useCallback(
    (value: string) =>
      setFilters({ region: value === ALL_REGIONS ? "" : value }),
    [setFilters],
  );
  const handleLowFreeChange = React.useCallback(
    (value: string) =>
      setFilters({ lowFree: value === ALL_REGIONS ? "" : value }),
    [setFilters],
  );
  const clearFilters = React.useCallback(() => {
    setFilters({ region: "", lowFree: "", q: "", band: "" });
    setSearchInput("");
  }, [setFilters]);
  const filtersActive = Boolean(
    regionFilter || lowFreeFilter || urlQuery || utilizationBand !== "all",
  );

  // ---- Deep-link sheet -----------------------------------------------------
  // Build an id → account index once per account-set change so the deep-link
  // lookup is O(1) instead of O(N) per render. With ~hundreds of accounts the
  // difference is small but the index also feeds the deep-link clipboard
  // affordance below without re-scanning the list.
  const accountById = React.useMemo<ReadonlyMap<string, AccountInfo>>(() => {
    const map = new Map<string, AccountInfo>();
    for (const a of accountInfos) map.set(a.id, a);
    return map;
  }, [accountInfos]);

  const focusedAccount = React.useMemo<AccountInfo | null>(() => {
    if (!routeAccountId) return null;
    return accountById.get(routeAccountId) ?? null;
  }, [routeAccountId, accountById]);

  const sheetOpen = Boolean(routeAccountId);

  const handleSheetOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) navigate("/account-info");
    },
    [navigate],
  );

  const handleRowActivate = React.useCallback(
    (row: AccountInfo) => {
      navigate(`/account-info/${encodeURIComponent(row.id)}`);
    },
    [navigate],
  );

  const handleAccountIdActivate = React.useCallback(
    (id: string) => {
      navigate(`/account-info/${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  const handleSheetNavigate = React.useCallback(
    (path: string) => navigate(path),
    [navigate],
  );

  // Absolute deep-link URL for the currently focused account — null when no
  // sheet is open, or when no DOM `location` is available (SSR/jest). The
  // anchor is the canonical `/account-info/<id>` route so the recipient lands
  // back on this exact sheet view. Guarded against ssr by `typeof window`.
  const deepLinkUrl = React.useMemo<string | undefined>(() => {
    if (!focusedAccount) return undefined;
    if (typeof window === "undefined" || !window.location) return undefined;
    const origin = window.location.origin;
    const pathname = window.location.pathname.replace(
      /\/account-info(?:\/[^/]*)?$/,
      "",
    );
    return `${origin}${pathname}/account-info/${encodeURIComponent(focusedAccount.id)}`;
  }, [focusedAccount]);

  // ---- Keyboard shortcuts --------------------------------------------------
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  // Debounce the `r` hotkey so key-repeat (holding the key) coalesces into a
  // single refresh — `inFlightRef` would short-circuit duplicates but we'd
  // still allocate AbortControllers + emit `setRefreshReason` churn on every
  // re-trigger. 250 ms covers the OS autorepeat interval comfortably.
  const refreshHotkeyDebounceRef = React.useRef<number | null>(null);
  const debouncedManualRefresh = React.useCallback(() => {
    if (refreshHotkeyDebounceRef.current != null) return;
    refreshHotkeyDebounceRef.current = window.setTimeout(() => {
      refreshHotkeyDebounceRef.current = null;
    }, 250);
    void refresh("manual-hotkey");
  }, [refresh]);
  // Clean up the debounce timer on unmount so we don't leak a setTimeout
  // handle into a re-mounted page (StrictMode double-mount safe).
  React.useEffect(() => {
    return () => {
      if (refreshHotkeyDebounceRef.current != null) {
        window.clearTimeout(refreshHotkeyDebounceRef.current);
        refreshHotkeyDebounceRef.current = null;
      }
    };
  }, []);
  const focusSearch = React.useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);
  const toggleAutoRefresh = React.useCallback(() => {
    setAutoRefresh(!autoRefresh);
  }, [autoRefresh, setAutoRefresh]);
  useShortcut("/", focusSearch);
  useShortcut("r", debouncedManualRefresh);
  useShortcut("a", toggleAutoRefresh);

  // `g a` → go to accounts list root, `g p` → go to pools page scoped to the
  // currently-focused account (or unscoped if no sheet is open). The chord
  // approach mirrors GitHub/Gmail-style navigation and avoids stealing bare
  // letter keys.
  const chordBindings = React.useMemo<Record<string, () => void>>(
    () => ({
      a: () => navigate("/account-info"),
      p: () => {
        const id = focusedAccount?.id;
        navigate(id ? `/pool-info?accountId=${encodeURIComponent(id)}` : "/pool-info");
      },
    }),
    [navigate, focusedAccount],
  );
  useChordSequence("g", chordBindings);

  // Memoized advanced-detection slices. Recomputed only when accountInfos or
  // the persisted threshold change — cheap O(N) scans, but worth caching so
  // typing in the search box doesn't re-walk the dataset.
  const thresholdAlerts = React.useMemo(
    () => computeThresholdAlerts(accountInfos, thresholdAlertPct),
    [accountInfos, thresholdAlertPct],
  );
  const surfaceRiskRows = React.useMemo(
    () => computeSurfaceRiskRows(accountInfos),
    [accountInfos],
  );
  const subscriptionCollisions = React.useMemo(
    () => computeSubscriptionCollisions(accountInfos),
    [accountInfos],
  );

  // ---- DataTable columns ---------------------------------------------------
  const columns = React.useMemo<DataTableColumn<AccountInfo>[]>(
    () => [
      {
        id: "accountName",
        header: "Account Name",
        cell: (row) => (
          <span className="group/copy inline-flex items-center gap-1.5 font-medium text-foreground">
            <span className="truncate">{row.accountName ?? ""}</span>
            <CopyButton
              value={row.accountName ?? ""}
              ariaLabel={`Copy account name ${row.accountName}`}
            />
          </span>
        ),
        sort: (a, b) =>
          compareStrings(a.accountName ?? "", b.accountName ?? ""),
        csv: (row) => row.accountName ?? "",
      },
      {
        id: "region",
        header: "Region",
        cell: (row) =>
          row.region ? (
            <RegionBadge region={row.region} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        sort: (a, b) => compareStrings(a.region ?? "", b.region ?? ""),
        csv: (row) => row.region ?? "",
      },
      {
        id: "subscription",
        header: "Subscription",
        cell: (row) => {
          const subId = row.subscriptionId ?? "";
          if (!subId) return <span className="text-muted-foreground">—</span>;
          return (
            <CopyableText
              value={subId}
              display={
                <span title={subId}>
                  {subId.length > 8 ? `${subId.substring(0, 8)}…` : subId}
                </span>
              }
              mono
              ariaLabel="Copy subscription id"
            />
          );
        },
        csv: (row) => row.subscriptionId ?? "",
        defaultHidden: true,
      },
      {
        id: "lpQuota",
        header: "LP Quota",
        cell: (row) => (
          <span className="tabular-nums text-foreground">
            {formatNumber(safeNum(row.lowPriorityCoreQuota))}
          </span>
        ),
        sort: (a, b) =>
          compareNumbers(
            safeNum(a.lowPriorityCoreQuota),
            safeNum(b.lowPriorityCoreQuota),
          ),
        csv: (row) => safeNum(row.lowPriorityCoreQuota),
      },
      {
        id: "lpUsed",
        header: "LP Used",
        cell: (row) => (
          <UsageBar
            used={safeNum(row.lowPriorityCoresUsed)}
            quota={safeNum(row.lowPriorityCoreQuota)}
          />
        ),
        sort: (a, b) =>
          compareNumbers(
            safeNum(a.lowPriorityCoresUsed),
            safeNum(b.lowPriorityCoresUsed),
          ),
        csv: (row) => safeNum(row.lowPriorityCoresUsed),
      },
      {
        id: "lpFree",
        header: "LP Free",
        cell: (row) => {
          const free = safeNum(row.lowPriorityCoresFree);
          return (
            <span
              className={cn(
                "tabular-nums",
                free > 0
                  ? "font-semibold text-success"
                  : "text-muted-foreground",
              )}
            >
              {formatNumber(free)}
            </span>
          );
        },
        sort: (a, b) =>
          compareNumbers(
            safeNum(a.lowPriorityCoresFree),
            safeNum(b.lowPriorityCoresFree),
          ),
        csv: (row) => safeNum(row.lowPriorityCoresFree),
      },
      {
        id: "dedicatedFree",
        header: "Dedicated Free",
        cell: (row) => {
          const free = safeNum(row.dedicatedCoresFree);
          return (
            <span
              className={cn(
                "tabular-nums",
                free > 0 ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {formatNumber(free)}
            </span>
          );
        },
        sort: (a, b) =>
          compareNumbers(
            safeNum(a.dedicatedCoresFree),
            safeNum(b.dedicatedCoresFree),
          ),
        csv: (row) => safeNum(row.dedicatedCoresFree),
      },
      {
        id: "dedicatedQuota",
        header: "Dedicated Quota",
        cell: (row) => (
          <span className="tabular-nums text-muted-foreground">
            {formatNumber(safeNum(row.dedicatedCoreQuota))}
          </span>
        ),
        sort: (a, b) =>
          compareNumbers(
            safeNum(a.dedicatedCoreQuota),
            safeNum(b.dedicatedCoreQuota),
          ),
        csv: (row) => safeNum(row.dedicatedCoreQuota),
      },
      {
        id: "poolCount",
        header: "Pool Count",
        cell: (row) => (
          <span className="tabular-nums text-foreground">
            {formatNumber(safeNum(row.poolCount))}
          </span>
        ),
        sort: (a, b) =>
          compareNumbers(safeNum(a.poolCount), safeNum(b.poolCount)),
        csv: (row) => safeNum(row.poolCount),
      },
      {
        id: "poolQuota",
        header: "Pool Quota",
        cell: (row) => (
          <span className="tabular-nums text-foreground">
            {formatNumber(safeNum(row.poolQuota))}
          </span>
        ),
        sort: (a, b) =>
          compareNumbers(safeNum(a.poolQuota), safeNum(b.poolQuota)),
        csv: (row) => safeNum(row.poolQuota),
      },
      {
        id: "poolsFree",
        header: "Pools Free",
        cell: (row) => {
          const free = safeNum(row.poolsFree);
          return (
            <span
              className={cn(
                "tabular-nums",
                free > 0
                  ? "font-semibold text-success"
                  : "text-muted-foreground",
              )}
            >
              {formatNumber(free)}
            </span>
          );
        },
        sort: (a, b) =>
          compareNumbers(safeNum(a.poolsFree), safeNum(b.poolsFree)),
        csv: (row) => safeNum(row.poolsFree),
      },
    ],
    [],
  );

  // ---- Export columns (mirror the DataTable schema) ------------------------
  const exportColumns = React.useMemo<ExportColumn<AccountInfo>[]>(
    () => [
      { header: "Account Name", accessor: (r) => r.accountName ?? "" },
      { header: "Region", accessor: (r) => r.region ?? "" },
      { header: "Subscription Id", accessor: (r) => r.subscriptionId ?? "" },
      { header: "Resource Group", accessor: (r) => r.resourceGroup ?? "" },
      { header: "LP Quota", accessor: (r) => safeNum(r.lowPriorityCoreQuota) },
      { header: "LP Used", accessor: (r) => safeNum(r.lowPriorityCoresUsed) },
      { header: "LP Free", accessor: (r) => safeNum(r.lowPriorityCoresFree) },
      {
        header: "Dedicated Quota",
        accessor: (r) => safeNum(r.dedicatedCoreQuota),
      },
      {
        header: "Dedicated Used",
        accessor: (r) => safeNum(r.dedicatedCoresUsed),
      },
      {
        header: "Dedicated Free",
        accessor: (r) => safeNum(r.dedicatedCoresFree),
      },
      { header: "Pool Count", accessor: (r) => safeNum(r.poolCount) },
      { header: "Pool Quota", accessor: (r) => safeNum(r.poolQuota) },
      { header: "Pools Free", accessor: (r) => safeNum(r.poolsFree) },
      {
        header: "Per-Family Enforced",
        accessor: (r) =>
          r.dedicatedCoreQuotaPerVMFamilyEnforced ? "true" : "false",
      },
    ],
    [],
  );

  // ---- Render branches -----------------------------------------------------
  const initialLoading = loading && accountInfos.length === 0;
  const fetchFailed =
    !loading && error !== null && accountInfos.length === 0;
  const emptyOverall =
    accountInfos.length === 0 && !loading && !fetchFailed;

  const tableEmpty = (
    <EmptyState
      icon={filtersActive ? Filter : Users}
      title={
        filtersActive
          ? "No accounts match the current filter"
          : "No accounts in this view"
      }
      description={
        filtersActive
          ? "Try clearing or relaxing the filters above to see more accounts."
          : "Refresh account info from Azure to populate this view."
      }
      action={
        filtersActive
          ? { label: "Clear filters", onClick: clearFilters, icon: Filter }
          : {
              label: "Refresh",
              onClick: () => void refresh("empty-state"),
              icon: RotateCw,
              loading,
            }
      }
    />
  );

  // Stale-data check — used to surface a soft warning when data is older
  // than 5 minutes and auto-refresh is off.
  const isStale =
    !autoRefresh &&
    lastRefreshedAt != null &&
    Date.now() - lastRefreshedAt > STALE_DATA_THRESHOLD_MS;

  return (
    <div
      className="flex flex-col gap-4 py-4"
      aria-labelledby="account-info-heading"
    >
      <div className="relative overflow-hidden rounded-xl border bg-card/50 p-6">
        <DotPattern fade="top-left" />
        <Meteors count={10} tone="primary" />
        <div className="relative z-10">
          <PageHeader
            title="Account Info"
            description="Quota, usage, and pool capacity across every Azure Batch account."
            titleId="account-info-heading"
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => void refresh("manual")}
                  loading={loading}
                  aria-label="Refresh account info (press R)"
                >
                  <RotateCw />
                  Refresh
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Refresh now — keyboard <Kbd>r</Kbd>
              </TooltipContent>
            </Tooltip>
            {loading && (
              <>
                <div
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                    aria-label="Loading"
                  />
                  <span>
                    {refreshReason === "auto"
                      ? "Auto-refreshing…"
                      : "Loading…"}
                  </span>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={stop}
                      aria-label="Stop refresh"
                      className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Square />
                      Stop
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Stops auto-refresh and dismisses the spinner. In-flight ARM
                    calls will still resolve.
                  </TooltipContent>
                </Tooltip>
              </>
            )}
            <div className="ml-2 flex items-center gap-2">
              <Switch
                id="account-info-auto-refresh"
                checked={autoRefresh}
                onCheckedChange={(checked) => setAutoRefresh(checked === true)}
                aria-label="Toggle auto-refresh every 30 seconds (press A)"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Label
                    htmlFor="account-info-auto-refresh"
                    className="cursor-pointer text-xs text-muted-foreground"
                  >
                    Auto-refresh (30s)
                  </Label>
                </TooltipTrigger>
                <TooltipContent>
                  Toggle every 30 seconds — keyboard <Kbd>a</Kbd>
                </TooltipContent>
              </Tooltip>
              <AutoRefreshChip
                enabled={autoRefresh}
                loading={loading}
                lastRefreshedAt={lastRefreshedAt}
              />
            </div>
            {/* Last-refresh pill / stale warning */}
            {lastRefreshedAt != null && (
              <span
                className={cn(
                  "ml-1 inline-flex items-center gap-1 text-2xs tabular-nums",
                  isStale ? "text-warning" : "text-muted-foreground",
                )}
                aria-live="polite"
                title={`Last refreshed ${new Date(lastRefreshedAt).toLocaleString()}`}
              >
                {isStale && (
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                )}
                Updated {formatRelativeTime(new Date(lastRefreshedAt))}
              </span>
            )}
          </PageHeader>
        </div>
      </div>

      {/* Error banner — shown when refresh fails but we already have data. */}
      {error && accountInfos.length > 0 && (
        <Alert
          variant="destructive"
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-3"
        >
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex-1">{error}</AlertDescription>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh("retry")}
              aria-label="Retry loading account info"
            >
              Retry
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              Dismiss
            </Button>
          </div>
        </Alert>
      )}

      {/* Soft stale-data warning — only when auto-refresh is OFF and data
          is older than the 5 min threshold. */}
      {isStale && !error && (
        <Alert
          variant="default"
          role="status"
          className="flex items-start gap-3 border-warning/40 bg-warning/10"
        >
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertDescription className="flex-1 text-warning">
            Showing data refreshed {formatRelativeTime(new Date(lastRefreshedAt!))}.
            Quota numbers may be out of date.
          </AlertDescription>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh("stale-banner")}
            aria-label="Refresh stale data"
          >
            <RotateCw />
            Refresh now
          </Button>
        </Alert>
      )}

      {/* Summary stats */}
      <div className="relative overflow-hidden rounded-xl">
        <BorderBeam size={200} duration={8} />
        <AccountInfoSummaryBar summary={summary} />
      </div>

      {/* Utilization chips — quick filters for risk bands */}
      {accountInfos.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Filter accounts by utilization band"
        >
          <span className="text-2xs uppercase tracking-wider text-muted-foreground">
            Utilization
          </span>
          <UtilizationChip
            label="All"
            count={accountInfos.length}
            active={utilizationBand === "all"}
            tone="neutral"
            onClick={() => setUtilizationBand("all")}
          />
          <UtilizationChip
            label={`Critical (>${CRITICAL_UTILIZATION_PCT}%)`}
            count={utilizationCounts.critical}
            active={utilizationBand === "critical"}
            tone="destructive"
            onClick={() => setUtilizationBand("critical")}
          />
          <UtilizationChip
            label={`Warning (${WARNING_UTILIZATION_PCT}–${CRITICAL_UTILIZATION_PCT}%)`}
            count={utilizationCounts.warning}
            active={utilizationBand === "warning"}
            tone="warning"
            onClick={() => setUtilizationBand("warning")}
          />
          <UtilizationChip
            label={`Healthy (<${WARNING_UTILIZATION_PCT}%)`}
            count={utilizationCounts.healthy}
            active={utilizationBand === "healthy"}
            tone="success"
            onClick={() => setUtilizationBand("healthy")}
          />
        </div>
      )}

      {/* Quota at a glance — fleet-wide gauges + top utilization accounts */}
      {/* COORDINATOR: extract <PoolCountSparkline> — needs a time-series
          slice on MultiRegionStore (e.g. `state.accountInfoHistory: Map<id,
          {ts, poolCount}[]>`) populated by the orchestrator on each
          refresh_account_info round-trip. No store source exists today, so a
          sparkline would either render flat (single sample) or fabricate
          history — both misleading. Leaving the gauge view in place until
          the store gains a history slice. */}
      {accountInfos.length > 0 && (
        <QuotaGlance
          // `accountInfos` is `ReadonlyArray<AccountInfo>` from the memo
          // above; the consumer's prop type wants a mutable array but does
          // not mutate. Structural cast keeps the memoized identity stable.
          accounts={accountInfos as AccountInfo[]}
          onAccountClick={handleAccountIdActivate}
        />
      )}

      {/* Advanced detections — defender-side surfacing of attack/risk axes
          inspired by NetSPI MicroBurst & Azucar/ScoutSuite Batch enumeration.
          All three are pure reads from `accountInfos`; no extra ARM calls.
          See: New folder/_analysis_netspi.md and
          New folder/_analysis_defender_view.md */}
      {accountInfos.length > 0 && thresholdAlerts.length > 0 && (
        <ThresholdAlertsCard
          alerts={thresholdAlerts}
          thresholdPct={thresholdAlertPct}
          onChangeThreshold={setThresholdAlertPct}
          onOpenAccount={handleAccountIdActivate}
        />
      )}
      {accountInfos.length > 0 &&
        (surfaceRiskRows.length > 0 || subscriptionCollisions.length > 0) && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {surfaceRiskRows.length > 0 && (
              <SurfaceRiskCard
                rows={surfaceRiskRows}
                onOpenAccount={handleAccountIdActivate}
              />
            )}
            {subscriptionCollisions.length > 0 && (
              <SubscriptionCollisionsCard
                collisions={subscriptionCollisions}
                onOpenAccount={handleAccountIdActivate}
              />
            )}
          </div>
        )}

      {/* Filters row */}
      <div
        className="flex flex-wrap items-end gap-3"
        role="region"
        aria-label="Filters"
      >
        {/* Search */}
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="account-info-search"
            className="text-2xs uppercase tracking-wider text-muted-foreground"
          >
            Search
          </Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchInputRef}
              id="account-info-search"
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Name, region, RG, subscription…"
              aria-label="Search accounts by name, region, resource group, or subscription"
              className="h-8 w-64 pl-7 pr-8"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
            <Kbd
              className="pointer-events-none absolute right-9 top-1/2 hidden -translate-y-1/2 sm:inline-flex"
              size="xs"
            >
              /
            </Kbd>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="account-info-region"
            className="text-2xs uppercase tracking-wider text-muted-foreground"
          >
            Region
          </Label>
          <Select
            value={regionFilter || ALL_REGIONS}
            onValueChange={handleRegionChange}
          >
            <SelectTrigger
              id="account-info-region"
              className="h-8 w-44"
              aria-label="Filter by region"
            >
              <SelectValue placeholder="All regions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_REGIONS}>All regions</SelectItem>
              {regionOptions.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="account-info-low-free"
            className="inline-flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground"
          >
            Free LP cores below
            <InfoTooltip
              content="Surface only accounts whose remaining low-priority core headroom is below the chosen threshold — useful when you need to find where to land a new pool."
              size={12}
            />
          </Label>
          <Select
            value={lowFreeFilter || ALL_REGIONS}
            onValueChange={handleLowFreeChange}
          >
            <SelectTrigger
              id="account-info-low-free"
              className="h-8 w-44"
              aria-label="Filter to accounts with low free LP cores"
            >
              <SelectValue placeholder="No threshold" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_REGIONS}>No threshold</SelectItem>
              {LOW_FREE_THRESHOLDS.map((n) => (
                <SelectItem key={n} value={n}>
                  &lt; {n} cores
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {filtersActive && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            aria-label="Clear all filters"
          >
            <X />
            Clear filters
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <ExportMenu<AccountInfo>
            rows={filteredAccounts}
            columns={exportColumns}
            filename="account-info"
            jsonMetadata={{
              filters: {
                region: regionFilter || null,
                lowFree: lowFreeFilter || null,
                query: urlQuery || null,
                utilizationBand,
              },
            }}
          />
          <div
            className="text-xs text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            Showing {formatNumber(filteredAccounts.length)} of{" "}
            {formatNumber(accountInfos.length)} accounts
            {selection.size > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-primary">
                <Cpu className="h-3 w-3" aria-hidden />
                {selection.size} selected
              </span>
            )}
          </div>
        </div>
      </div>

      {/* State branches: skeleton / fetch-failed / empty / table */}
      {initialLoading ? (
        <div className="rounded-md border border-border bg-card p-4">
          <SkeletonLoader variant="table" rows={6} columns={10} />
        </div>
      ) : fetchFailed ? (
        <ErrorState
          message="Failed to load account info."
          detail={error}
          onRetry={() => void refresh("retry")}
        />
      ) : emptyOverall ? (
        <EmptyState
          icon={Search}
          title="No account info loaded yet"
          description="Pull the latest quota and capacity numbers from Azure to populate this page."
          action={{
            label: "Load account info",
            onClick: () => void refresh("manual"),
            icon: RotateCw,
            loading,
          }}
        />
      ) : (
        <DataTable<AccountInfo>
          tableId="account-info"
          rows={filteredAccounts}
          columns={columns}
          rowKey={(r) => r.id}
          empty={tableEmpty}
          loading={loading && accountInfos.length === 0}
          selection={selection}
          onSelectionChange={setSelection}
          onRowActivate={handleRowActivate}
          csvFileName="account-info.csv"
          initialSort={{ column: "lpFree", direction: "desc" }}
        />
      )}

      {/* Keyboard hint footer — visible affordance for `/`, `r`, `a`, chords. */}
      <div className="flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Kbd>/</Kbd> search
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>r</Kbd> refresh
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>a</Kbd> auto-refresh
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>g</Kbd>
          <Kbd>a</Kbd> accounts list
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>g</Kbd>
          <Kbd>p</Kbd> pools{focusedAccount ? " (this account)" : ""}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd> close detail sheet
        </span>
      </div>

      <AccountDetailSheet
        account={focusedAccount}
        open={sheetOpen}
        onOpenChange={handleSheetOpenChange}
        onNavigate={handleSheetNavigate}
        loading={loading && accountInfos.length === 0}
        deepLinkUrl={deepLinkUrl}
      />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Utilization chip                                                   */
/* ------------------------------------------------------------------ */

interface UtilizationChipProps {
  label: string;
  count: number;
  active: boolean;
  tone: "neutral" | "destructive" | "warning" | "success";
  onClick: () => void;
}

const UtilizationChip: React.FC<UtilizationChipProps> = ({
  label,
  count,
  active,
  tone,
  onClick,
}) => {
  const activeClasses: Record<UtilizationChipProps["tone"], string> = {
    neutral: "bg-primary text-primary-foreground",
    destructive: "bg-destructive text-destructive-foreground",
    warning: "bg-warning text-warning-foreground",
    success: "bg-success text-success-foreground",
  };
  const idleClasses: Record<UtilizationChipProps["tone"], string> = {
    neutral: "bg-muted text-muted-foreground hover:bg-muted/80",
    destructive:
      "bg-destructive/10 text-destructive hover:bg-destructive/20",
    warning: "bg-warning/10 text-warning hover:bg-warning/20",
    success: "bg-success/10 text-success hover:bg-success/20",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        active ? activeClasses[tone] : idleClasses[tone],
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "inline-flex h-4 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-2xs tabular-nums",
          active ? "bg-black/15 text-current" : "bg-background/60 text-current",
        )}
        aria-label={`${count} accounts`}
      >
        {formatNumber(count)}
      </span>
    </button>
  );
};

/* ------------------------------------------------------------------ */
/*  Exported wrapper                                                   */
/* ------------------------------------------------------------------ */

export const AccountInfoPage: React.FC<AccountInfoPageProps> = (props) => (
  <ErrorBoundary>
    <AccountInfoPageInner {...props} />
  </ErrorBoundary>
);
