/**
 * Account-provisioning page — 5-step wizard (Configure → Preflight → Review →
 * Submit → Result) per Design Contract §3.7. URL reflects current step via
 * `?step=...`. The `import existing accounts` flow remains as a sibling tab
 * since it is a different action class.
 *
 * 2026-05-24 redesign: per-page improvement loop. Focus areas:
 *   - Cancellable inter-sub waits (Stop now aborts both the orchestrator
 *     and the configured delay between sub dispatches).
 *   - Region-picker presets (All US / Europe / GPU / Clear) and inline
 *     filter so the dropdown isn't a wall of 40 regions to scroll.
 *   - Subscription-picker filter, copy-to-clipboard for IDs, info tooltip
 *     on the per-sub delay slider, and a "Skip already-existing" toggle
 *     that drops regions where the picked sub already owns a Batch
 *     account from the dispatch list (avoids 409 conflicts at the
 *     orchestrator).
 *   - Result step gains a summary stats panel (success rate, elapsed
 *     wall-clock, avg per region) and a per-account row click that opens
 *     the Azure Portal blade.
 *   - Multiple correctness fixes: timer cleanup on unmount during Stop,
 *     consolidated prefs hydration effect (replaces the two split effects
 *     with the eslint-disabled deps), and tightened attemptAccounts
 *     filter (use createdAt parse rather than lexical compare).
 */
import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Copy,
  ExternalLink,
  Info,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  Square,
  Users,
  XCircle,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnimatedTabs } from "@/components/ui/effects";
import { cn } from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { useUrlState } from "../../hooks/use-url-state";
import {
  PreflightLevel,
  PreflightResult,
  preflightCanSubmit,
  runPreflight,
} from "../../shared/account-provisioning-preflight";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import {
  DataTable,
  DataTableColumn,
} from "../shared/enhanced-table";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import {
  AZURE_REGIONS,
  DEFAULT_CONFIG,
  isGpuRegion,
  isValidSubscriptionId,
} from "../shared/constants";
import { EmptyState } from "../shared/empty-state";
import { PageHeader } from "../shared/page-header";
import { StatusBadge } from "../shared/status-badge";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { useArmToken } from "../../auth/use-arm-token";

interface AccountProvisioningPageProps {
  orchestrator: OrchestratorAgent;
}

type StepId = "configure" | "preflight" | "review" | "submit" | "result";
type FlowTab = "create" | "import";

const STEP_ORDER: StepId[] = [
  "configure",
  "preflight",
  "review",
  "submit",
  "result",
];

const STEP_LABEL: Record<StepId, string> = {
  configure: "Configure",
  preflight: "Preflight",
  review: "Review",
  submit: "Submit",
  result: "Result",
};

const PREFLIGHT_LEVEL_VARIANT: Record<
  PreflightLevel,
  "default" | "destructive" | "success" | "warning" | "info"
> = {
  ok: "success",
  warn: "warning",
  error: "destructive",
  unknown: "info",
};

// ---- Region presets ---------------------------------------------------------
// Pre-baked groupings the operator is likeliest to want one-click access to.
// Each predicate is evaluated against AZURE_REGIONS — never hardcoded — so
// adding/removing regions in `constants.ts` automatically updates the
// presets without code changes here. The "All GPU" preset reuses the
// existing `isGpuRegion` source-of-truth.
interface RegionPreset {
  id: string;
  label: string;
  description: string;
  predicate: (region: string) => boolean;
}

const REGION_PRESETS: RegionPreset[] = [
  {
    id: "us",
    label: "All US",
    description:
      "All United States regions (East/West/Central + variants).",
    predicate: (r) =>
      r === "eastus" ||
      r === "eastus2" ||
      r === "westus" ||
      r === "westus2" ||
      r === "westus3" ||
      r === "centralus" ||
      r === "northcentralus" ||
      r === "southcentralus" ||
      r === "westcentralus",
  },
  {
    id: "europe",
    label: "All Europe",
    description: "EU + UK + Nordics regions.",
    predicate: (r) =>
      r === "northeurope" ||
      r === "westeurope" ||
      r === "uksouth" ||
      r === "ukwest" ||
      r === "francecentral" ||
      r === "germanywestcentral" ||
      r === "norwayeast" ||
      r === "switzerlandnorth" ||
      r === "swedencentral" ||
      r === "polandcentral" ||
      r === "italynorth" ||
      r === "spaincentral",
  },
  {
    id: "apac",
    label: "All APAC",
    description: "Asia-Pacific + India + Australia regions.",
    predicate: (r) =>
      r === "eastasia" ||
      r === "southeastasia" ||
      r === "japaneast" ||
      r === "japanwest" ||
      r === "australiaeast" ||
      r === "australiasoutheast" ||
      r === "centralindia" ||
      r === "southindia" ||
      r === "westindia" ||
      r === "koreacentral" ||
      r === "koreasouth",
  },
  {
    id: "gpu",
    label: "All V100/H100",
    description: "Regions advertising Nvidia V100 (NCv3) or H100.",
    predicate: (r) => isGpuRegion(r),
  },
];

const PreflightIcon: React.FC<{ level: PreflightLevel }> = ({ level }) => {
  const className = "h-4 w-4 shrink-0";
  if (level === "ok") return <CheckCircle2 className={className} aria-hidden />;
  if (level === "warn")
    return <AlertTriangle className={className} aria-hidden />;
  if (level === "error")
    return <AlertCircle className={className} aria-hidden />;
  return <Info className={className} aria-hidden />;
};

const PREFLIGHT_LEVEL_TEXT: Record<PreflightLevel, string> = {
  ok: "OK",
  warn: "Warning",
  error: "Error",
  unknown: "Info",
};

const PreflightChips: React.FC<{ checks: PreflightResult[] }> = ({
  checks,
}) => {
  // Aggregate summary so the operator can see overall posture at a glance
  // before reading individual chips. Pure derivation — no state.
  const summary = React.useMemo(() => {
    let ok = 0;
    let warn = 0;
    let err = 0;
    for (const c of checks) {
      if (c.level === "ok") ok++;
      else if (c.level === "warn") warn++;
      else if (c.level === "error") err++;
    }
    return { ok, warn, err, total: checks.length };
  }, [checks]);

  return (
    <div
      className="flex flex-col gap-2"
      role="status"
      aria-live="polite"
      aria-label="Pre-flight checks"
    >
      {summary.total > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 text-2xs"
          aria-label="Pre-flight summary"
        >
          <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 font-semibold text-success transition-colors duration-200">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            {summary.ok} ok
          </span>
          {summary.warn > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 font-semibold text-warning transition-colors duration-200">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {summary.warn} warn
            </span>
          )}
          {summary.err > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-semibold text-destructive transition-colors duration-200">
              <XCircle className="h-3 w-3" aria-hidden />
              {summary.err} blocking
            </span>
          )}
        </div>
      )}
      {checks.map((c) => (
        <Alert
          key={c.id}
          variant={PREFLIGHT_LEVEL_VARIANT[c.level]}
          className="px-3 py-2 text-xs transition-colors duration-200 ease-out [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6"
          aria-label={`${PREFLIGHT_LEVEL_TEXT[c.level]} — ${c.label}: ${c.detail}`}
        >
          <PreflightIcon level={c.level} />
          <AlertDescription className="text-xs leading-relaxed">
            <span className="font-semibold">{c.label}.</span>{" "}
            <span className="opacity-90">{c.detail}</span>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
};

// Small reusable copy button — writes to clipboard, swaps icon for a check
// for 1.2 s so the user gets feedback without a noisy toast. Safe in
// non-browser test environments (clipboard write becomes a no-op).
const CopyChip: React.FC<{
  value: string;
  label?: string;
  className?: string;
}> = ({ value, label, className }) => {
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const handleCopy = React.useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // Permissions denied or insecure context — silently skip; nothing
      // we can do without elevating UI noise.
    }
  }, [value]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
          aria-label={label ? `Copy ${label}` : "Copy"}
        >
          {copied ? (
            <CheckCircle2 className="h-3 w-3 text-success" aria-hidden />
          ) : (
            <Copy className="h-3 w-3" aria-hidden />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {copied ? "Copied" : label ? `Copy ${label}` : "Copy"}
      </TooltipContent>
    </Tooltip>
  );
};

const ConfigureFieldsetReadOnly: React.FC<{
  subscriptions: Array<{
    subscriptionId: string;
    displayName: string;
    ownerAccountLabel?: string;
  }>;
  selectedRegions: string[];
  perSubDelaySec: number;
  skipExisting: boolean;
  skippedCount: number;
  onEdit: () => void;
}> = ({
  subscriptions,
  selectedRegions,
  perSubDelaySec,
  skipExisting,
  skippedCount,
  onEdit,
}) => (
  <div className="rounded-md border border-border bg-surface-sunken/40 p-3">
    <div className="mb-2 flex items-center justify-between gap-2">
      <h4 className="m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Configuration
      </h4>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onEdit}
        aria-label="Edit configuration"
      >
        <Pencil className="h-3 w-3" aria-hidden />
        Edit
      </Button>
    </div>
    <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
      <div className="flex flex-col gap-0.5">
        <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
          Subscriptions ({subscriptions.length})
        </dt>
        <dd className="m-0 flex flex-col gap-1">
          {subscriptions.map((s) => (
            <span
              key={s.subscriptionId}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground"
            >
              <span className="font-medium">{s.displayName}</span>
              <span className="font-mono text-muted-foreground">
                {(s.subscriptionId ?? "").slice(0, 8)}&hellip;
              </span>
              <CopyChip value={s.subscriptionId} label="subscription id" />
              {s.ownerAccountLabel && (
                <span className="text-muted-foreground">
                  · {s.ownerAccountLabel}
                </span>
              )}
            </span>
          ))}
          {subscriptions.length > 1 && (
            <span className="text-2xs text-muted-foreground">
              Sequential dispatch · {perSubDelaySec}s between subs
            </span>
          )}
        </dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
          Regions ({selectedRegions.length})
        </dt>
        <dd className="m-0 flex flex-wrap gap-1">
          {selectedRegions.map((r) => (
            <span
              key={r}
              className="inline-flex items-center rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground"
            >
              {r}
            </span>
          ))}
        </dd>
      </div>
    </dl>
    {subscriptions.length > 1 && (
      <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-2xs text-foreground">
        Total accounts to create:{" "}
        <span className="font-semibold tabular-nums">
          {subscriptions.length * selectedRegions.length - skippedCount}
        </span>{" "}
        ({subscriptions.length} sub{subscriptions.length === 1 ? "" : "s"} ×{" "}
        {selectedRegions.length} region{selectedRegions.length === 1 ? "" : "s"})
        {skipExisting && skippedCount > 0 && (
          <span className="ml-1 text-muted-foreground">
            · skipping {skippedCount} existing
          </span>
        )}
      </div>
    )}
  </div>
);

interface ProvisionedRow {
  id: string;
  region: string;
  accountName: string;
  resourceGroup: string;
  subscriptionId: string;
  provisioningState: string;
  error?: string;
}

type ProvisioningRowState =
  | "pending"
  | "creating"
  | "created"
  | "failed"
  | string;

const REGION_STATE_TONE: Record<
  "pending" | "creating" | "created" | "failed",
  string
> = {
  pending: "border-border bg-muted/40 text-muted-foreground",
  creating: "border-primary/40 bg-primary/10 text-primary",
  created: "border-success/40 bg-success/10 text-success",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
};

const RegionStatusChip: React.FC<{
  region: string;
  state: ProvisioningRowState;
  accountName?: string;
  error?: string;
}> = ({ region, state, accountName, error }) => {
  const normalized: keyof typeof REGION_STATE_TONE =
    state === "created" || state === "failed" || state === "creating"
      ? state
      : "pending";
  const Icon =
    normalized === "created"
      ? CheckCircle2
      : normalized === "failed"
        ? XCircle
        : normalized === "creating"
          ? Loader2
          : null;
  const chip = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors duration-200 ease-out",
        REGION_STATE_TONE[normalized],
      )}
      aria-label={`${region}: ${normalized}`}
    >
      {Icon ? (
        <Icon
          className={cn(
            "h-3 w-3",
            normalized === "creating" && "animate-spin motion-reduce:animate-none",
          )}
          aria-hidden
        />
      ) : null}
      {region}
    </span>
  );
  // Show tooltip with detail when there's something to surface (account
  // name, error message). Skip the tooltip in the trivial case.
  const tip = error
    ? error
    : accountName
      ? `${accountName} — ${normalized}`
      : null;
  if (!tip) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{chip}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
};

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

/**
 * Cancellable delay. Resolves when `ms` elapses OR when `signal.aborted`
 * fires (in which case it resolves with `cancelled = true`). Used by the
 * inter-subscription wait so a Stop click actually halts the loop rather
 * than letting the wait run to completion before the next dispatch is
 * skipped.
 */
function abortableDelay(
  ms: number,
  signal: AbortSignal,
): Promise<{ cancelled: boolean }> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ cancelled: true });
      return;
    }
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve({ cancelled: false });
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      signal.removeEventListener("abort", onAbort);
      resolve({ cancelled: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Build the Azure portal blade URL for a Batch account. */
function azurePortalUrl(args: {
  subscriptionId: string;
  resourceGroup: string;
  accountName: string;
}): string {
  const resourceId =
    `/subscriptions/${args.subscriptionId}` +
    `/resourceGroups/${args.resourceGroup}` +
    `/providers/Microsoft.Batch/batchAccounts/${args.accountName}`;
  return `https://portal.azure.com/#@/resource${resourceId}/overview`;
}

const AccountProvisioningPageInner: React.FC<AccountProvisioningPageProps> = ({
  orchestrator,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();

  // ---- URL-backed step state -----------------------------------------------
  const [urlState, setUrlState] = useUrlState<{ step: string; tab: string }>({
    step: "configure",
    tab: "create",
  });
  const activeTab: FlowTab = urlState.tab === "import" ? "import" : "create";
  const rawStep = (urlState.step ?? "configure") as StepId;
  const currentStep: StepId = STEP_ORDER.includes(rawStep)
    ? rawStep
    : "configure";

  const setStep = React.useCallback(
    (next: StepId) => setUrlState({ step: next }),
    [setUrlState],
  );

  const setActiveTab = React.useCallback(
    (next: FlowTab) =>
      setUrlState({
        tab: next,
        step: next === "create" ? currentStep : "configure",
      }),
    [setUrlState, currentStep],
  );

  // ---- Form state -----------------------------------------------------------
  const [selectedRegions, setSelectedRegions] = React.useState<string[]>([]);
  // `subscriptionId` is the fallback (typed) single-sub for the case
  // where no Azure account is signed in — the existing free-text input
  // path. `selectedSubIds` is the multi-pick set used when the page
  // can enumerate signed-in subs via the dropdown — every sub the user
  // ticks gets its own create_accounts run in the submit loop.
  const [subscriptionId, setSubscriptionId] = React.useState("");
  const [selectedSubIds, setSelectedSubIds] = React.useState<string[]>([]);
  // Delay (seconds) between per-subscription create_accounts dispatches.
  // Bound 30–60 — anything lower risks tripping ARM's per-tenant write
  // throttle when the same operator fires identical PUT batchAccounts
  // calls back-to-back across many subs. Persisted to user prefs so
  // the operator's chosen pacing sticks across reloads.
  const [perSubDelaySec, setPerSubDelaySec] = React.useState<number>(30);
  // ISO timestamp of when the user submitted the CURRENT attempt. The
  // wizard's progress + result counters are scoped to accounts created
  // at-or-after this stamp so prior submissions don't bleed into the
  // current attempt's view (which previously froze the user on the
  // result step and silently blocked re-submission).
  const [attemptStartedAt, setAttemptStartedAt] = React.useState<string | null>(
    null,
  );
  // Wall-clock duration of the last completed attempt, in ms. Captured
  // when isRunning flips false so the result step can show a stable
  // "elapsed N min" stat without ticking after completion.
  const [lastAttemptDurationMs, setLastAttemptDurationMs] = React.useState<
    number | null
  >(null);
  const [autoSelectedSubscription, setAutoSelectedSubscription] =
    React.useState(false);
  const [isRunning, setIsRunning] = React.useState(false);
  const [isDiscovering, setIsDiscovering] = React.useState(false);
  const [discoverError, setDiscoverError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(
    null,
  );
  const [confirmHidden, setConfirmHidden] = React.useState(true);
  // When true, regions that already have a "created" Batch account in the
  // picked sub are dropped from the dispatch list so the orchestrator
  // doesn't issue a 409 PUT against an existing account. Default on so
  // re-running a partially-completed batch is idempotent by default.
  const [skipExisting, setSkipExisting] = React.useState(true);
  // Region picker inline filter — typed into the search box at the top
  // of the dropdown so the operator can jump straight to a region by
  // typing part of its name. Empty string means "show all".
  const [regionFilter, setRegionFilter] = React.useState("");
  // Subscription picker inline filter — same idea as the region filter,
  // but applied to the subscription dropdown. Multi-account environments
  // can show >20 subs and the operator wants to type "prod" or "westus"
  // (matches displayName + id) to find the right one fast.
  const [subFilter, setSubFilter] = React.useState("");

  // Cancellation handle for the active submit run. Used by the Stop
  // button to abort BOTH the orchestrator AND the inter-sub wait — the
  // previous version only cancelled the orchestrator, leaving the
  // setTimeout running so the next sub's create_accounts would still
  // fire after the operator hit Stop.
  const submitAbortRef = React.useRef<AbortController | null>(null);
  // Cleanup any in-flight controller on unmount so a Stop -> route
  // change doesn't leave a dangling timer.
  React.useEffect(
    () => () => {
      submitAbortRef.current?.abort();
      submitAbortRef.current = null;
    },
    [],
  );

  // ---- Page-level ARM token tracker ----------------------------------------
  // Account-provisioning fires PUT batchAccounts across N subs × M regions
  // and can sit open for many minutes (especially with the per-sub delay).
  // Without an expiry hint the operator can submit at minute 58 of a 60-min
  // token and watch every region 401. We pick the account that owns the
  // FIRST selected sub when available; otherwise fall back to the first
  // signed-in azureAccount so the badge still surfaces an expiry warning
  // when the operator hasn't picked a sub yet.
  const armTokenAccount = React.useMemo(() => {
    const firstSubId =
      selectedSubIds.length > 0 ? selectedSubIds[0] : undefined;
    const sub = firstSubId
      ? state.subscriptions.find((s) => s.subscriptionId === firstSubId)
      : undefined;
    const azureAccounts = state.azureAccounts ?? [];
    if (sub?.homeAccountId) {
      const match = azureAccounts.find(
        (a) => a.homeAccountId === sub.homeAccountId,
      );
      if (match) {
        return {
          homeAccountId: match.homeAccountId,
          tenantId: sub.tenantId ?? match.tenantId,
        };
      }
      return {
        homeAccountId: sub.homeAccountId,
        tenantId: sub.tenantId,
      };
    }
    const fallback = azureAccounts[0];
    if (!fallback)
      return {
        homeAccountId: undefined as string | undefined,
        tenantId: undefined as string | undefined,
      };
    return {
      homeAccountId: fallback.homeAccountId,
      tenantId: fallback.tenantId,
    };
  }, [selectedSubIds, state.subscriptions, state.azureAccounts]);

  const armTokenTracker = useArmToken(
    armTokenAccount.homeAccountId,
    armTokenAccount.tenantId,
  );

  // ---- Prefs hydration -----------------------------------------------------
  // Consolidated mount-time prefs read: do BOTH the typed-input default
  // and the multi-sub auto-tick in one effect so a saved
  // `lastSubscriptionId` doesn't race with a fresh subs list and end up
  // hydrating twice. Runs once on mount; re-runs when the subs list
  // first becomes non-empty so the saved id can pre-tick a row.
  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    const prefs = store.getUserPreferences();
    // Always seed the typed-input fallback once — independent of
    // whether subs are loaded yet (operator may want to paste a sub id
    // without signing in).
    if (!hydratedRef.current && prefs.lastSubscriptionId) {
      setSubscriptionId(prefs.lastSubscriptionId);
    }
    if (!hydratedRef.current && prefs.lastRegions?.length) {
      setSelectedRegions(
        prefs.lastRegions.slice(0, DEFAULT_CONFIG.maxRegionsPerRequest),
      );
    }
    hydratedRef.current = true;
    // Subs-aware pre-tick: when the list lands, restore the saved id if
    // it's still visible.
    if (state.subscriptions.length > 0 && selectedSubIds.length === 0) {
      if (
        prefs.lastSubscriptionId &&
        state.subscriptions.some(
          (s) => s.subscriptionId === prefs.lastSubscriptionId,
        )
      ) {
        setSelectedSubIds([prefs.lastSubscriptionId]);
      } else if (state.subscriptions.length === 1) {
        const onlyId = state.subscriptions[0]?.subscriptionId;
        if (onlyId) {
          setSelectedSubIds([onlyId]);
          setAutoSelectedSubscription(true);
        }
      }
    }
    // Drop stale ids the moment subs change (sign-out etc.)
    const visible = new Set(state.subscriptions.map((s) => s.subscriptionId));
    setSelectedSubIds((prev) => {
      const filtered = prev.filter((id) => visible.has(id));
      return filtered.length === prev.length ? prev : filtered;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.subscriptions]);

  const handleSubscriptionChange = React.useCallback(
    (newValue: string) => {
      setSubscriptionId(newValue);
      setAutoSelectedSubscription(false);
      setValidationError(null);
      store.saveUserPreferences({ lastSubscriptionId: newValue });
    },
    [store],
  );

  const toggleSubSelection = React.useCallback(
    (subId: string) => {
      setSelectedSubIds((prev) => {
        const next = prev.includes(subId)
          ? prev.filter((x) => x !== subId)
          : [...prev, subId];
        setAutoSelectedSubscription(false);
        setValidationError(null);
        // Persist the FIRST selected as "last sub" so a fresh load
        // pre-ticks something sensible. Multi-select state itself
        // isn't persisted — operators usually want a fresh pick per
        // batch run.
        if (next.length > 0) {
          store.saveUserPreferences({ lastSubscriptionId: next[0] });
        }
        return next;
      });
    },
    [store],
  );

  const handleRegionsChange = React.useCallback(
    (newRegions: string[]) => {
      if (newRegions.length > DEFAULT_CONFIG.maxRegionsPerRequest) {
        // Trim rather than refuse — operator clearly wants "all of
        // these" and trimming to the cap is friendlier than a no-op.
        newRegions = newRegions.slice(0, DEFAULT_CONFIG.maxRegionsPerRequest);
      }
      setSelectedRegions(newRegions);
      store.saveUserPreferences({ lastRegions: newRegions });
    },
    [store],
  );

  // Apply a region preset: union with existing selection (so the user
  // can compose multiple presets), clamped to the per-request cap.
  const applyRegionPreset = React.useCallback(
    (preset: RegionPreset) => {
      const set = new Set(selectedRegions);
      for (const r of AZURE_REGIONS) {
        if (preset.predicate(r)) set.add(r);
      }
      handleRegionsChange(Array.from(set));
    },
    [selectedRegions, handleRegionsChange],
  );

  const clearRegions = React.useCallback(() => {
    handleRegionsChange([]);
  }, [handleRegionsChange]);

  // ---- Pre-flight (also used by "preflight" step) --------------------------
  // Preflight is single-sub today — it validates GUID shape, sub
  // presence, and name uniqueness against the *primary* picked sub.
  // For multi-sub runs we pass the FIRST effective sub so the checks
  // still execute against a real id; the name-uniqueness check is
  // safe because account names are scoped per-sub and we generate them
  // fresh per dispatch.
  const preflightSubId =
    selectedSubIds.length > 0 ? selectedSubIds[0] : subscriptionId;
  const preflight = React.useMemo<PreflightResult[]>(
    () =>
      runPreflight({
        subscriptionId: preflightSubId,
        selectedRegions,
        accounts: state.accounts,
        subscriptions: state.subscriptions,
        azureAccounts: state.azureAccounts ?? [],
        maxRegions: DEFAULT_CONFIG.maxRegionsPerRequest,
      }),
    [
      preflightSubId,
      selectedRegions,
      state.accounts,
      state.subscriptions,
      state.azureAccounts,
    ],
  );
  const canPassPreflight = React.useMemo(
    () => preflightCanSubmit(preflight),
    [preflight],
  );

  // ---- Step gate ------------------------------------------------------------
  // Two valid input modes:
  //   1. Multi-select from the signed-in subscription list →
  //      selectedSubIds is non-empty. This is the common path when the
  //      Azure Accounts page has signed-in identities.
  //   2. Typed single subscription id → subscriptionId trimmed, valid
  //      GUID. Used as the fallback when no AAD accounts are signed in
  //      and the operator wants to provision via az-cli credentials.
  const effectiveSubscriptionIds: string[] = React.useMemo(() => {
    if (selectedSubIds.length > 0) return selectedSubIds;
    const trimmed = subscriptionId.trim();
    return trimmed ? [trimmed] : [];
  }, [selectedSubIds, subscriptionId]);

  const configureValid = React.useMemo(() => {
    if (effectiveSubscriptionIds.length === 0) return false;
    // For the typed-input fallback, validate the GUID shape. Multi-
    // select already constrains to ids that came from MSAL — no need
    // to re-validate.
    if (
      state.subscriptions.length === 0 &&
      selectedSubIds.length === 0 &&
      !isValidSubscriptionId(subscriptionId)
    ) {
      return false;
    }
    if (selectedRegions.length === 0) return false;
    return true;
  }, [
    effectiveSubscriptionIds.length,
    selectedSubIds.length,
    subscriptionId,
    selectedRegions,
    state.subscriptions.length,
  ]);

  const isStepDisabled = React.useCallback(
    (step: StepId): boolean => {
      if (step === "configure") return false;
      if (step === "preflight") return !configureValid;
      if (step === "review") return !configureValid || !canPassPreflight;
      if (step === "submit") return !configureValid || !canPassPreflight;
      if (step === "result") {
        // Result is reachable only after a submit attempt has occurred
        // IN THIS SESSION — `attemptStartedAt` is the canonical signal.
        // Using `state.accounts.length` would let a prior session's
        // accounts unlock the result tab without a fresh submission.
        return !attemptStartedAt && !isRunning;
      }
      return false;
    },
    [configureValid, canPassPreflight, attemptStartedAt, isRunning],
  );

  // ---- Skip-existing planning ----------------------------------------------
  // Map of (subId, region) -> "created" account so we can both:
  //   - show a warning chip on regions the operator already owns in
  //     the picked sub(s), AND
  //   - drop them from the dispatch list when `skipExisting` is on.
  const existingByKey = React.useMemo(() => {
    const m = new Map<string, true>();
    for (const a of state.accounts) {
      if (a.provisioningState === "created" && a.subscriptionId && a.region) {
        m.set(`${a.subscriptionId}::${a.region}`, true);
      }
    }
    return m;
  }, [state.accounts]);

  // Per (sub, region) plan = the (sub, region) pairs the orchestrator
  // will actually be asked to create. Honors `skipExisting`.
  const dispatchPlan = React.useMemo(() => {
    const out: Array<{ subscriptionId: string; region: string }> = [];
    for (const sub of effectiveSubscriptionIds) {
      for (const region of selectedRegions) {
        if (skipExisting && existingByKey.has(`${sub}::${region}`)) continue;
        out.push({ subscriptionId: sub, region });
      }
    }
    return out;
  }, [effectiveSubscriptionIds, selectedRegions, skipExisting, existingByKey]);

  // Per-sub list of regions the orchestrator will dispatch. Used to
  // skip the dispatch when ALL regions for a sub are already created.
  const dispatchPerSub = React.useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of dispatchPlan) {
      const list = m.get(p.subscriptionId) ?? [];
      list.push(p.region);
      m.set(p.subscriptionId, list);
    }
    return m;
  }, [dispatchPlan]);

  const skippedExistingCount =
    effectiveSubscriptionIds.length * selectedRegions.length -
    dispatchPlan.length;

  // ---- Counters / progress --------------------------------------------------
  // Scope to the current attempt: only count accounts whose `addedAt`
  // is at-or-after `attemptStartedAt`. When `attemptStartedAt` is null
  // (no submission yet, or user cleared via "New request") all counts
  // collapse to 0 — the auto-advance below will not fire and the
  // submit button stays enabled for a fresh request.
  const attemptAccounts = React.useMemo(() => {
    if (!attemptStartedAt) return [];
    const startMs = Date.parse(attemptStartedAt);
    if (Number.isNaN(startMs)) return [];
    return state.accounts.filter((a) => {
      if (!a.createdAt) return false;
      const ts = Date.parse(a.createdAt);
      return !Number.isNaN(ts) && ts >= startMs;
    });
  }, [state.accounts, attemptStartedAt]);

  const createdCount = attemptAccounts.filter(
    (a) => a.provisioningState === "created",
  ).length;
  const failedCount = attemptAccounts.filter(
    (a) => a.provisioningState === "failed",
  ).length;
  const totalCount = attemptAccounts.length;
  // Progress total now reflects the dispatch plan (post-skip), not the
  // raw region count, so the % accurately reports "of what we're
  // actually asking the orchestrator to do".
  const dispatchTotal = dispatchPlan.length;
  const progressTotal = totalCount > 0 ? totalCount : dispatchTotal;
  const progressDone = createdCount + failedCount;
  const progressPercent =
    progressTotal > 0
      ? Math.min(100, Math.round((progressDone / progressTotal) * 100))
      : 0;

  // Per-region status keyed by region — drives the per-region status list
  // shown during submit. Falls back to "pending" for any region the
  // orchestrator hasn't reported on yet.
  const regionStatus = React.useMemo(() => {
    const byRegion = new Map<string, ProvisionedRow>();
    for (const a of attemptAccounts) {
      byRegion.set(a.region, {
        id: (a as { id?: string }).id ?? `${a.region}-${a.accountName}`,
        region: a.region,
        accountName: a.accountName,
        resourceGroup: a.resourceGroup,
        subscriptionId: a.subscriptionId,
        provisioningState: a.provisioningState,
        error: a.error ?? undefined,
      });
    }
    return selectedRegions.map((r) => {
      const row = byRegion.get(r);
      return {
        region: r,
        state:
          row?.provisioningState ??
          (attemptStartedAt && isRunning ? "creating" : "pending"),
        accountName: row?.accountName,
        error: row?.error,
      };
    });
  }, [attemptAccounts, selectedRegions, attemptStartedAt, isRunning]);

  // Region currently being provisioned — first non-terminal in the list.
  // Used as the "Working on..." label below the progress bar so the user
  // sees forward motion even when the bar is mid-transition.
  const currentRegion = React.useMemo(() => {
    if (!isRunning) return null;
    const next = regionStatus.find(
      (r) => r.state !== "created" && r.state !== "failed",
    );
    return next?.region ?? null;
  }, [regionStatus, isRunning]);

  // Lightweight ETA: average elapsed-per-completed-region times remaining.
  // We track elapsed via `attemptStartedAt`; when zero have completed we
  // can't estimate yet, so we render an em-dash.
  const etaSeconds = React.useMemo(() => {
    if (!isRunning || !attemptStartedAt) return null;
    if (progressDone === 0 || progressDone >= progressTotal) return null;
    const elapsedMs = Date.now() - new Date(attemptStartedAt).getTime();
    if (elapsedMs <= 0) return null;
    const perItemMs = elapsedMs / progressDone;
    const remaining = progressTotal - progressDone;
    return Math.max(1, Math.round((perItemMs * remaining) / 1000));
  }, [isRunning, attemptStartedAt, progressDone, progressTotal]);

  // Re-render every second while running so the ETA display + the
  // inter-sub waitingUntil countdown both update without forcing the
  // orchestrator to push tick events. When not running this effect is
  // a no-op.
  const [, setTickNonce] = React.useState(0);
  React.useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTickNonce((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // Auto-advance to "result" when submit completes — but ONLY for an
  // attempt that has actually started in this session. Previously the
  // effect fired the moment the user reached the submit step because
  // a stale `progressTotal > 0` from a prior session bounced them off.
  React.useEffect(() => {
    if (!attemptStartedAt) return;
    if (
      currentStep === "submit" &&
      !isRunning &&
      progressTotal > 0 &&
      progressDone >= progressTotal
    ) {
      setStep("result");
    }
  }, [
    attemptStartedAt,
    currentStep,
    isRunning,
    progressTotal,
    progressDone,
    setStep,
  ]);

  // ---- Submit + retry handlers ---------------------------------------------
  const requestSubmit = React.useCallback(() => {
    if (!configureValid) {
      setValidationError("Resolve configuration errors before submitting.");
      return;
    }
    if (dispatchPlan.length === 0) {
      setValidationError(
        skipExisting
          ? "All selected (subscription × region) pairs already exist. Untick \"Skip already-existing\" or pick different regions."
          : "No (subscription × region) pairs to dispatch.",
      );
      return;
    }
    setConfirmHidden(false);
  }, [configureValid, dispatchPlan.length, skipExisting]);

  // Per-sub progress so the UI can show "Sub 2/5 in progress — waiting
  // 30 s before next dispatch" instead of a single opaque spinner that
  // runs for minutes when many subs are selected.
  const [subBatchProgress, setSubBatchProgress] = React.useState<{
    completed: number;
    total: number;
    currentSubId: string | null;
    waiting: boolean;
    waitingUntil: number | null;
  } | null>(null);

  const handleConfirmCreate = React.useCallback(async () => {
    setConfirmHidden(true);
    setIsRunning(true);
    setSubmitError(null);
    setLastAttemptDurationMs(null);
    const attemptStart = new Date();
    setAttemptStartedAt(attemptStart.toISOString());

    // Fresh AbortController for this submit run. Stop button can call
    // .abort() on it to bail the inter-sub wait early; the orchestrator
    // cancel still happens via orchestrator.cancel().
    submitAbortRef.current?.abort();
    const ac = new AbortController();
    submitAbortRef.current = ac;

    // Build per-sub dispatch list from the plan so we honour
    // `skipExisting`. Subs whose every region is already created end up
    // with an empty array and are silently skipped (no orchestrator
    // call, no audit-noise).
    const subs = effectiveSubscriptionIds.filter(
      (s) => (dispatchPerSub.get(s)?.length ?? 0) > 0,
    );
    const delayMs = Math.max(30, Math.min(60, perSubDelaySec)) * 1000;
    const errors: Array<{ subscriptionId: string; error: string }> = [];
    let cancelled = false;

    for (let i = 0; i < subs.length; i++) {
      if (ac.signal.aborted) {
        cancelled = true;
        break;
      }
      const sub = subs[i];
      const regionsForSub = dispatchPerSub.get(sub) ?? selectedRegions;
      setSubBatchProgress({
        completed: i,
        total: subs.length,
        currentSubId: sub,
        waiting: false,
        waitingUntil: null,
      });
      try {
        await orchestrator.execute({
          action: "create_accounts",
          payload: {
            subscriptionId: sub,
            regions: regionsForSub,
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Don't record AbortError-style cancellations as errors; the
        // user explicitly asked to stop.
        if (!ac.signal.aborted) {
          errors.push({ subscriptionId: sub, error: message });
        }
      }
      if (ac.signal.aborted) {
        cancelled = true;
        break;
      }
      // Inter-sub delay. Skip for the last sub — no one's waiting.
      // Cancellable via AbortController so a Stop click halts the wait
      // immediately rather than letting it run to completion.
      if (i < subs.length - 1) {
        const until = Date.now() + delayMs;
        setSubBatchProgress({
          completed: i + 1,
          total: subs.length,
          currentSubId: sub,
          waiting: true,
          waitingUntil: until,
        });
        const wait = await abortableDelay(delayMs, ac.signal);
        if (wait.cancelled) {
          cancelled = true;
          break;
        }
      }
    }

    setSubBatchProgress({
      completed: subs.length,
      total: subs.length,
      currentSubId: null,
      waiting: false,
      waitingUntil: null,
    });

    if (errors.length > 0) {
      setSubmitError(
        errors
          .map((e) => `${(e.subscriptionId ?? "").slice(0, 8)}…: ${e.error}`)
          .join(" · "),
      );
    }
    if (cancelled && errors.length === 0) {
      setSubmitError(
        "Stopped before all subscriptions finished. Already-running orchestrator dispatches will continue server-side.",
      );
    }
    setLastAttemptDurationMs(Date.now() - attemptStart.getTime());
    if (submitAbortRef.current === ac) submitAbortRef.current = null;
    setIsRunning(false);
  }, [
    orchestrator,
    effectiveSubscriptionIds,
    dispatchPerSub,
    selectedRegions,
    perSubDelaySec,
  ]);

  // Stop = abort the inter-sub timer + tell the orchestrator to bail
  // mid-region. Both signals fire; whichever the loop is sitting on
  // gets the message.
  const handleStop = React.useCallback(() => {
    submitAbortRef.current?.abort();
    orchestrator.cancel();
  }, [orchestrator]);

  const handleDiscover = React.useCallback(async () => {
    // Discover walks one subscription at a time. When the operator has
    // picked several from the dropdown we run them sequentially with the
    // same inter-sub delay used by create — keeps the import experience
    // symmetric with create and avoids hammering ARM's per-tenant read
    // throttle when listing Batch accounts across many tenants.
    const subs = effectiveSubscriptionIds;
    if (subs.length === 0) {
      setValidationError("Subscription ID is required.");
      return;
    }
    if (
      state.subscriptions.length === 0 &&
      selectedSubIds.length === 0 &&
      !isValidSubscriptionId(subscriptionId)
    ) {
      setValidationError("Subscription ID must be a valid UUID.");
      return;
    }
    setValidationError(null);
    setIsDiscovering(true);
    setDiscoverError(null);
    const delayMs = Math.max(30, Math.min(60, perSubDelaySec)) * 1000;
    const errors: Array<{ subscriptionId: string; error: string }> = [];
    // Discover gets the same abort plumbing as create — same Stop
    // behaviour applies if the operator picks dozens of subs and
    // changes their mind mid-run.
    const ac = new AbortController();
    submitAbortRef.current?.abort();
    submitAbortRef.current = ac;
    try {
      for (let i = 0; i < subs.length; i++) {
        if (ac.signal.aborted) break;
        const sub = subs[i];
        try {
          await orchestrator.execute({
            action: "discover_accounts",
            payload: { subscriptionId: sub.trim() },
          });
        } catch (err: unknown) {
          if (!ac.signal.aborted) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ subscriptionId: sub, error: message });
          }
        }
        if (i < subs.length - 1) {
          const wait = await abortableDelay(delayMs, ac.signal);
          if (wait.cancelled) break;
        }
      }
      if (errors.length > 0) {
        setDiscoverError(
          errors
            .map((e) => `${(e.subscriptionId ?? "").slice(0, 8)}…: ${e.error}`)
            .join(" · "),
        );
      }
    } finally {
      if (submitAbortRef.current === ac) submitAbortRef.current = null;
      setIsDiscovering(false);
    }
  }, [
    orchestrator,
    effectiveSubscriptionIds,
    selectedSubIds.length,
    subscriptionId,
    state.subscriptions.length,
    perSubDelaySec,
  ]);

  const handleStopDiscover = React.useCallback(() => {
    submitAbortRef.current?.abort();
    orchestrator.cancel();
  }, [orchestrator]);

  const handleRetryFailed = React.useCallback(() => {
    const ids = store.retryFailedAccounts();
    store.addNotification({
      type: "info",
      message: `Retrying ${ids.length} failed account(s)...`,
      autoDismissMs: 5000,
    });
  }, [store]);

  const subscriptionFieldId = React.useId();
  const regionFieldId = React.useId();
  const skipExistingId = React.useId();
  const perSubDelayId = React.useId();

  // ---- Subscription selector (shared) --------------------------------------
  // Group the picker by owning Azure account when multiple operators are
  // signed in. Each option shows: sub display name, prefix of subId, and
  // (when the same browser has more than one signed-in account) the
  // owner account name as a secondary label. This is the multi-account
  // unblock — without it the dropdown only ever showed the primary
  // account's subs, so an operator with two signed-in accounts couldn't
  // pick a sub that belonged to the non-primary one.
  const filteredSubscriptions = React.useMemo(() => {
    const q = subFilter.trim().toLowerCase();
    if (!q) return state.subscriptions;
    return state.subscriptions.filter((s) => {
      return (
        s.displayName.toLowerCase().includes(q) ||
        s.subscriptionId.toLowerCase().includes(q) ||
        (s.ownerAccountLabel ?? "").toLowerCase().includes(q)
      );
    });
  }, [state.subscriptions, subFilter]);

  const subscriptionGroups = React.useMemo(() => {
    const groups = new Map<string, typeof state.subscriptions>();
    for (const s of filteredSubscriptions) {
      const key = s.ownerAccountLabel || s.homeAccountId || "Active account";
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    return Array.from(groups.entries());
  }, [filteredSubscriptions]);
  const showOwnerGroups = subscriptionGroups.length > 1;

  // Detect subs that share both `displayName` and `ownerAccountLabel` —
  // happens when the same provisioning script ran under two different
  // signed-in AAD identities that ALSO share a display name (e.g.
  // "Sub for Provisioned User 5" / "Provisioned User 5"). They are
  // functionally distinct (different subscriptionId + homeAccountId,
  // tokens route correctly), but the picker rendered them as visually
  // identical chips. We tag the duplicates here and append a
  // homeAccountId suffix at render time so the operator can tell them
  // apart. Computed once over the FULL list so the dedupe doesn't
  // depend on the search filter narrowing things.
  const ambiguousSubIds = React.useMemo(() => {
    const counts = new Map<string, number>();
    const ids = new Set<string>();
    for (const s of state.subscriptions) {
      const key = `${s.displayName} ${s.ownerAccountLabel ?? ""}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const s of state.subscriptions) {
      const key = `${s.displayName} ${s.ownerAccountLabel ?? ""}`;
      if ((counts.get(key) ?? 0) > 1) ids.add(s.subscriptionId);
    }
    return ids;
  }, [state.subscriptions]);

  // Quick-pick "select all visible" / "clear" for the subs dropdown so
  // an operator with 12 visible subs doesn't have to click 12 times.
  const visibleSubIds = React.useMemo(
    () => filteredSubscriptions.map((s) => s.subscriptionId),
    [filteredSubscriptions],
  );
  const allVisibleSelected =
    visibleSubIds.length > 0 &&
    visibleSubIds.every((id) => selectedSubIds.includes(id));

  const selectAllVisibleSubs = React.useCallback(() => {
    setSelectedSubIds((prev) =>
      Array.from(new Set([...prev, ...visibleSubIds])),
    );
    setAutoSelectedSubscription(false);
    setValidationError(null);
  }, [visibleSubIds]);

  const clearAllSubs = React.useCallback(() => {
    setSelectedSubIds([]);
    setAutoSelectedSubscription(false);
  }, []);

  const subscriptionSelector = (
    <div className="flex flex-col gap-1.5 max-w-[28rem]">
      <Label htmlFor={subscriptionFieldId}>
        {state.subscriptions.length > 0
          ? `Subscriptions${selectedSubIds.length > 0 ? ` (${selectedSubIds.length} selected)` : ""}`
          : "Subscription ID"}
      </Label>
      {state.subscriptions.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              id={subscriptionFieldId}
              aria-label="Azure subscriptions"
              className="justify-between"
            >
              <span className="truncate">
                {selectedSubIds.length === 0
                  ? "Pick one or more subscriptions"
                  : selectedSubIds.length === 1
                    ? state.subscriptions.find(
                        (s) => s.subscriptionId === selectedSubIds[0],
                      )?.displayName ?? selectedSubIds[0]
                    : `${selectedSubIds.length} subscription${selectedSubIds.length === 1 ? "" : "s"} selected`}
              </span>
              <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-2xs font-semibold text-primary">
                {selectedSubIds.length}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-80 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto"
            // Keep typing focused in the search box without the
            // dropdown stealing keystrokes for its own type-ahead.
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <div className="sticky top-0 z-10 -mx-1 mb-1 bg-popover px-2 py-1.5">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={subFilter}
                  onChange={(e) => setSubFilter(e.target.value)}
                  placeholder={`Filter ${state.subscriptions.length} subs…`}
                  aria-label="Filter subscriptions"
                  className="h-7 pl-7 text-xs"
                  // Stop dropdown type-ahead from intercepting characters.
                  onKeyDown={(e) => e.stopPropagation()}
                  autoFocus
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={selectAllVisibleSubs}
                    disabled={
                      visibleSubIds.length === 0 || allVisibleSelected
                    }
                    className="rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-2xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="Select all visible subscriptions"
                  >
                    Select visible ({visibleSubIds.length})
                  </button>
                  <button
                    type="button"
                    onClick={clearAllSubs}
                    disabled={selectedSubIds.length === 0}
                    className="rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-2xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="Clear all selected subscriptions"
                  >
                    Clear
                  </button>
                </div>
                <span className="text-2xs text-muted-foreground tabular-nums">
                  {selectedSubIds.length} / {state.subscriptions.length}
                </span>
              </div>
            </div>
            {filteredSubscriptions.length === 0 ? (
              <div className="px-2 py-3 text-center text-2xs text-muted-foreground">
                No subscriptions match &ldquo;{subFilter}&rdquo;.
              </div>
            ) : (
              subscriptionGroups.flatMap(([owner, subs]) => {
                const items: React.ReactNode[] = [];
                if (showOwnerGroups) {
                  items.push(
                    <DropdownMenuLabel
                      key={`hdr-${owner}`}
                      className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {owner}
                    </DropdownMenuLabel>,
                  );
                }
                for (const s of subs) {
                  const checked = selectedSubIds.includes(s.subscriptionId);
                  const isAmbiguous = ambiguousSubIds.has(s.subscriptionId);
                  items.push(
                    <DropdownMenuCheckboxItem
                      key={s.subscriptionId}
                      checked={checked}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() =>
                        toggleSubSelection(s.subscriptionId)
                      }
                    >
                      <span className="font-medium">{s.displayName}</span>
                      <span className="ml-2 font-mono text-2xs text-muted-foreground">
                        {s.subscriptionId.substring(0, 8)}
                        &hellip;
                      </span>
                      {isAmbiguous && s.homeAccountId && (
                        <span
                          className="ml-2 inline-flex items-center rounded-sm bg-warning/15 px-1 font-mono text-2xs text-warning"
                          title={`Disambiguator: homeAccountId ${s.homeAccountId}`}
                        >
                          acct {(s.homeAccountId ?? "").slice(0, 6)}…
                        </span>
                      )}
                    </DropdownMenuCheckboxItem>,
                  );
                }
                return items;
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Input
          id={subscriptionFieldId}
          value={subscriptionId}
          onChange={(e) => handleSubscriptionChange(e.target.value)}
          placeholder="Enter Azure subscription ID (run 'az login' to auto-load)"
          aria-label="Azure subscription ID"
          autoComplete="off"
          spellCheck={false}
        />
      )}
      {autoSelectedSubscription && selectedSubIds.length === 1 && (
        <span className="text-2xs text-muted-foreground">
          Auto-selected your only subscription
        </span>
      )}
      {selectedSubIds.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1" aria-label="Selected subscriptions">
          {selectedSubIds.map((id) => {
            const sub = state.subscriptions.find((s) => s.subscriptionId === id);
            const isAmbiguous = ambiguousSubIds.has(id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground"
                title={`subscriptionId ${id}${sub?.homeAccountId ? ` · homeAccountId ${sub.homeAccountId}` : ""}`}
              >
                <span className="font-medium">
                  {sub?.displayName ?? id.slice(0, 8) + "…"}
                </span>
                <span className="font-mono text-muted-foreground">
                  {id.slice(0, 8)}…
                </span>
                <CopyChip value={id} label="subscription id" />
                {showOwnerGroups && sub?.ownerAccountLabel && (
                  <span className="text-muted-foreground">
                    · {sub.ownerAccountLabel}
                  </span>
                )}
                {isAmbiguous && sub?.homeAccountId && (
                  <span className="font-mono text-warning">
                    (acct {(sub.homeAccountId ?? "").slice(0, 6)}…)
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => toggleSubSelection(id)}
                  className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={`Remove ${sub?.displayName ?? id}`}
                >
                  <span aria-hidden>x</span>
                </button>
              </span>
            );
          })}
        </div>
      )}
      {selectedSubIds.length > 1 && (
        <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2.5">
          <Label
            htmlFor={perSubDelayId}
            className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Delay between subscriptions
            <Tooltip>
              <TooltipTrigger asChild>
                <Info
                  className="h-3 w-3 text-muted-foreground/80 hover:text-foreground"
                  aria-label="About the per-subscription delay"
                />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                ARM enforces per-tenant write throttles. Spacing dispatches
                30–60 s apart keeps batch creation under the 1200-writes/h
                budget on the tenants that host the picked subs.
              </TooltipContent>
            </Tooltip>
            <span className="ml-auto font-mono text-2xs text-foreground">
              {perSubDelaySec}s
            </span>
          </Label>
          <Input
            id={perSubDelayId}
            type="range"
            min={30}
            max={60}
            step={5}
            value={perSubDelaySec}
            onChange={(ev) => {
              const v = Number(ev.target.value);
              if (Number.isFinite(v)) {
                setPerSubDelaySec(Math.max(30, Math.min(60, Math.floor(v))));
              }
            }}
            aria-label="Per-subscription delay seconds"
            className="h-2 cursor-pointer accent-primary"
          />
          <span className="text-2xs text-muted-foreground leading-relaxed">
            After each subscription finishes its create_accounts run, the
            page waits this long before starting the next — keeps ARM&apos;s
            per-tenant write throttle happy when fanning out across many
            subs. Range 30–60 s.
          </span>
        </div>
      )}
    </div>
  );

  // Resolve every effective sub id into a display object so the review
  // step and confirmation dialog can show meaningful names instead of
  // raw GUIDs. For the typed-input fallback we synthesize a minimal
  // entry so the same render path works regardless of input mode.
  const effectiveSubscriptionDetails = React.useMemo(() => {
    return effectiveSubscriptionIds.map((id) => {
      const known = state.subscriptions.find((s) => s.subscriptionId === id);
      return {
        subscriptionId: id,
        displayName: known?.displayName ?? "(custom)",
        ownerAccountLabel: known?.ownerAccountLabel,
      };
    });
  }, [effectiveSubscriptionIds, state.subscriptions]);

  const atMaxRegions =
    selectedRegions.length >= DEFAULT_CONFIG.maxRegionsPerRequest;

  // ---- Confirmation dialog body --------------------------------------------
  // Total = dispatch plan size (post-skip), not raw N×M. Surfaces the
  // skipped count so the operator can audit what's being dropped.
  const totalToCreate = dispatchPlan.length;
  const confirmMessage = (
    <div className="space-y-3 text-sm leading-relaxed">
      <p className="m-0">
        You are about to create{" "}
        <span className="font-semibold text-foreground">
          {totalToCreate} Batch account
          {totalToCreate === 1 ? "" : "s"}
        </span>
        {effectiveSubscriptionIds.length > 1 && (
          <>
            {" "}
            across {effectiveSubscriptionIds.length} subscriptions ×{" "}
            {selectedRegions.length} region
            {selectedRegions.length === 1 ? "" : "s"}
          </>
        )}
        {skippedExistingCount > 0 && (
          <>
            {" "}
            <span className="text-muted-foreground">
              (skipping {skippedExistingCount} existing)
            </span>
          </>
        )}
        :
      </p>
      {effectiveSubscriptionIds.length > 1 && (
        <div className="rounded-md border border-border bg-surface-sunken/60 px-3 py-2 text-xs">
          <div className="font-semibold text-foreground">Subscriptions</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {effectiveSubscriptionDetails.map((s) => {
              const regionsForSub =
                dispatchPerSub.get(s.subscriptionId) ?? [];
              return (
                <li key={s.subscriptionId}>
                  <span className="text-foreground">{s.displayName}</span>{" "}
                  <span className="font-mono">
                    {(s.subscriptionId ?? "").slice(0, 8)}&hellip;
                  </span>
                  {s.ownerAccountLabel && (
                    <span> · {s.ownerAccountLabel}</span>
                  )}
                  <span className="ml-1 text-2xs">
                    ({regionsForSub.length} region
                    {regionsForSub.length === 1 ? "" : "s"})
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="max-h-20 overflow-y-auto rounded-md border border-border bg-surface-sunken/60 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Regions:</span>{" "}
        {selectedRegions.join(", ")}
      </div>
      {effectiveSubscriptionIds.length > 1 && (
        <Alert variant="info" className="px-3 py-2 text-xs">
          <Info className="h-4 w-4" aria-hidden />
          <AlertDescription className="text-xs leading-relaxed">
            Subscriptions are processed sequentially with a{" "}
            <span className="font-semibold">{perSubDelaySec}s delay</span>{" "}
            between each. Estimated wall-clock minimum:{" "}
            <span className="font-mono">
              {formatEta(
                (effectiveSubscriptionIds.length - 1) * perSubDelaySec,
              )}
            </span>{" "}
            of inter-sub wait plus per-region creation time.
          </AlertDescription>
        </Alert>
      )}
      <Alert variant="warning" className="px-3 py-2 text-xs">
        <AlertTriangle className="h-4 w-4" aria-hidden />
        <AlertDescription className="text-xs leading-relaxed">
          Each account incurs Azure storage and management overhead. Costs scale
          with the number of pools and nodes you later attach.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive" className="px-3 py-2 text-xs">
        <AlertCircle className="h-4 w-4" aria-hidden />
        <AlertDescription className="text-xs leading-relaxed">
          <span className="font-semibold">
            This action is irreversible from this UI.
          </span>{" "}
          Account and resource group cleanup must be performed manually in the
          Azure portal or via CLI.
        </AlertDescription>
      </Alert>
    </div>
  );

  // ---- DataTable for provisioned accounts ----------------------------------
  // Scope to the current attempt so the result table doesn't bleed in
  // accounts from prior submissions or imports — only the rows relevant
  // to *this* request show up here.
  const provisionedRows: ProvisionedRow[] = React.useMemo(
    () =>
      attemptAccounts.map((a, idx) => ({
        id:
          (a as { id?: string }).id ??
          `${a.region}-${a.accountName}-${idx}`,
        region: a.region,
        accountName: a.accountName,
        resourceGroup: a.resourceGroup,
        subscriptionId: a.subscriptionId,
        provisioningState: a.provisioningState,
        error: a.error ?? undefined,
      })),
    [attemptAccounts],
  );

  // For the import-tab table we still want ALL accounts (not scoped to
  // an attempt), since import has no notion of an attempt start.
  const importedRows: ProvisionedRow[] = React.useMemo(
    () =>
      state.accounts.map((a, idx) => ({
        id:
          (a as { id?: string }).id ??
          `${a.region}-${a.accountName}-${idx}`,
        region: a.region,
        accountName: a.accountName,
        resourceGroup: a.resourceGroup,
        subscriptionId: a.subscriptionId,
        provisioningState: a.provisioningState,
        error: a.error ?? undefined,
      })),
    [state.accounts],
  );

  const provisionedColumns: DataTableColumn<ProvisionedRow>[] = React.useMemo(
    () => [
      {
        id: "region",
        header: "Region",
        cell: (r) => <span className="text-sm">{r.region}</span>,
        sort: (a, b) => a.region.localeCompare(b.region),
        csv: (r) => r.region,
        json: { key: "region", value: (r) => r.region },
      },
      {
        id: "accountName",
        header: "Account Name",
        cell: (r) => (
          <span className="inline-flex items-center gap-1">
            <span className="text-sm">{r.accountName}</span>
            <CopyChip value={r.accountName} label="account name" />
          </span>
        ),
        sort: (a, b) => a.accountName.localeCompare(b.accountName),
        csv: (r) => r.accountName,
        json: { key: "accountName", value: (r) => r.accountName },
      },
      {
        id: "resourceGroup",
        header: "Resource Group",
        cell: (r) => (
          <span className="inline-flex items-center gap-1">
            <span className="text-xs text-muted-foreground">
              {r.resourceGroup}
            </span>
            <CopyChip value={r.resourceGroup} label="resource group" />
          </span>
        ),
        sort: (a, b) => a.resourceGroup.localeCompare(b.resourceGroup),
        csv: (r) => r.resourceGroup,
        json: { key: "resourceGroup", value: (r) => r.resourceGroup },
      },
      {
        id: "subscriptionId",
        header: "Subscription",
        cell: (r) => (
          <span className="inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground">
            {r.subscriptionId.slice(0, 8)}…
            <CopyChip value={r.subscriptionId} label="subscription id" />
          </span>
        ),
        sort: (a, b) => a.subscriptionId.localeCompare(b.subscriptionId),
        csv: (r) => r.subscriptionId,
        json: { key: "subscriptionId", value: (r) => r.subscriptionId },
        defaultHidden: true,
      },
      {
        id: "status",
        header: "Status",
        cell: (r) => <StatusBadge status={r.provisioningState} />,
        sort: (a, b) =>
          a.provisioningState.localeCompare(b.provisioningState),
        csv: (r) => r.provisioningState,
        json: { key: "status", value: (r) => r.provisioningState },
      },
      {
        id: "error",
        header: "Error",
        cell: (r) =>
          r.error ? (
            <span className="text-xs text-destructive">{r.error}</span>
          ) : null,
        csv: (r) => r.error ?? "",
        json: { key: "error", value: (r) => r.error ?? null },
      },
      {
        id: "portal",
        header: "",
        cell: (r) => (
          <a
            href={azurePortalUrl({
              subscriptionId: r.subscriptionId,
              resourceGroup: r.resourceGroup,
              accountName: r.accountName,
            })}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-sm px-1 text-2xs text-primary transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={`Open ${r.accountName} in Azure Portal`}
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            Portal
          </a>
        ),
        width: "w-20",
        // Skip CSV/JSON — derived field, can be reconstructed from
        // the columns the operator already gets.
        json: false,
      },
    ],
    [],
  );

  // ---- Step body renderers --------------------------------------------------
  const renderConfigure = (): React.ReactNode => {
    const filterQuery = regionFilter.trim().toLowerCase();
    // Group regions by GPU availability so the operator can jump straight
    // to the bucket they need. Preserves the original within-group
    // ordering of AZURE_REGIONS, so long-standing muscle memory (US first,
    // then Europe, then APAC) still works. Filter is applied here so the
    // empty-state message shows the right count.
    const matchFilter = (r: string) =>
      !filterQuery ||
      r.toLowerCase().includes(filterQuery) ||
      (isGpuRegion(r) && "v100h100gpu".includes(filterQuery));
    const gpu: string[] = [];
    const noGpu: string[] = [];
    for (const r of AZURE_REGIONS) {
      if (!matchFilter(r)) continue;
      (isGpuRegion(r) ? gpu : noGpu).push(r);
    }
    const totalMatching = gpu.length + noGpu.length;
    const renderRegion = (r: string) => {
      const checked = selectedRegions.includes(r);
      return (
        <DropdownMenuCheckboxItem
          key={r}
          checked={checked}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(c) => {
            const next = c
              ? [...selectedRegions, r]
              : selectedRegions.filter((x) => x !== r);
            handleRegionsChange(next);
          }}
        >
          {r}
          {isGpuRegion(r) && (
            <span className="ml-2 inline-flex items-center rounded-sm bg-primary/15 px-1 text-[0.625rem] font-semibold text-primary">
              GPU
            </span>
          )}
        </DropdownMenuCheckboxItem>
      );
    };

    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Configuration
          </CardTitle>
          <CardDescription>
            Choose a subscription and target regions. Each region creates one
            Batch account.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {subscriptionSelector}

          <div className="flex flex-col gap-1.5 max-w-[28rem]">
            <Label htmlFor={regionFieldId}>
              Regions{" "}
              <span className="font-normal text-muted-foreground">
                (select up to {DEFAULT_CONFIG.maxRegionsPerRequest})
              </span>
            </Label>
            {/* Region presets — one-click select for the common bundles */}
            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-label="Region presets"
            >
              {REGION_PRESETS.map((preset) => (
                <Tooltip key={preset.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => applyRegionPreset(preset)}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-2xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label={`Add preset ${preset.label}`}
                    >
                      <Plus className="h-2.5 w-2.5" aria-hidden />
                      {preset.label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {preset.description}
                  </TooltipContent>
                </Tooltip>
              ))}
              {selectedRegions.length > 0 && (
                <button
                  type="button"
                  onClick={clearRegions}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label="Clear all selected regions"
                >
                  <XCircle className="h-2.5 w-2.5" aria-hidden />
                  Clear all
                </button>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  id={regionFieldId}
                  type="button"
                  variant="outline"
                  className="h-9 w-full justify-between bg-surface-sunken px-3 text-sm font-normal"
                  aria-label="Azure regions"
                  aria-haspopup="menu"
                >
                  <span
                    className={cn(
                      "truncate",
                      selectedRegions.length === 0
                        ? "text-muted-foreground"
                        : "text-foreground",
                    )}
                  >
                    {selectedRegions.length === 0
                      ? "Select regions"
                      : `${selectedRegions.length} region${selectedRegions.length === 1 ? "" : "s"} selected`}
                  </span>
                  <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-2xs font-semibold text-primary">
                    {selectedRegions.length}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-80 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto"
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                <div className="sticky top-0 z-10 -mx-1 mb-1 bg-popover px-2 py-1.5">
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      value={regionFilter}
                      onChange={(e) => setRegionFilter(e.target.value)}
                      placeholder="Filter regions (e.g. 'us', 'gpu')…"
                      aria-label="Filter regions"
                      className="h-7 pl-7 text-xs"
                      onKeyDown={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  </div>
                </div>
                {totalMatching === 0 ? (
                  <div className="px-2 py-3 text-center text-2xs text-muted-foreground">
                    No regions match &ldquo;{regionFilter}&rdquo;.
                  </div>
                ) : (
                  <>
                    {gpu.length > 0 && (
                      <>
                        <DropdownMenuLabel>
                          V100 / H100 regions
                          <span className="ml-2 text-2xs font-normal text-muted-foreground">
                            ({gpu.length})
                          </span>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {gpu.map(renderRegion)}
                      </>
                    )}
                    {noGpu.length > 0 && (
                      <>
                        {gpu.length > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel>
                          No V100 / H100 advertised
                          <span className="ml-2 text-2xs font-normal text-muted-foreground">
                            ({noGpu.length})
                          </span>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {noGpu.map(renderRegion)}
                      </>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {selectedRegions.length > 0 && (
              <div
                className="mt-1 flex flex-wrap gap-1"
                aria-label="Selected regions"
              >
                {selectedRegions.map((r) => (
                  <span
                    key={r}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground"
                  >
                    {isGpuRegion(r) && (
                      <span
                        title="V100 (NCv3) or H100 (NCadsH100_v5 / NDH100v5) advertised"
                        className="inline-flex h-3.5 items-center justify-center rounded-sm bg-primary/15 px-1 text-[0.625rem] font-semibold text-primary"
                        aria-label="V100/H100 region"
                      >
                        V100/H100
                      </span>
                    )}
                    {r}
                    <button
                      type="button"
                      onClick={() =>
                        handleRegionsChange(
                          selectedRegions.filter((x) => x !== r),
                        )
                      }
                      className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label={`Remove ${r}`}
                    >
                      <span aria-hidden>x</span>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {atMaxRegions && (
            <Alert variant="warning" className="px-3 py-2">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              <AlertDescription className="text-xs">
                Maximum {DEFAULT_CONFIG.maxRegionsPerRequest} regions reached.
              </AlertDescription>
            </Alert>
          )}

          {/* Skip-existing toggle — re-running a partial batch should
              be idempotent by default. Hidden when there's nothing to
              skip so it doesn't add noise. */}
          {effectiveSubscriptionIds.length > 0 &&
            selectedRegions.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken/40 p-2.5">
                <input
                  id={skipExistingId}
                  type="checkbox"
                  checked={skipExisting}
                  onChange={(e) => setSkipExisting(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
                  aria-describedby={`${skipExistingId}-desc`}
                />
                <div className="flex flex-col gap-0.5 text-xs">
                  <Label
                    htmlFor={skipExistingId}
                    className="cursor-pointer text-xs font-medium text-foreground"
                  >
                    Skip already-existing accounts
                    {skippedExistingCount > 0 && (
                      <span className="ml-2 inline-flex items-center rounded-full border border-info/30 bg-info/10 px-1.5 py-0.5 text-2xs font-medium text-info">
                        {skippedExistingCount} would be skipped
                      </span>
                    )}
                  </Label>
                  <span
                    id={`${skipExistingId}-desc`}
                    className="text-2xs text-muted-foreground leading-relaxed"
                  >
                    When on, (subscription × region) pairs that already have
                    a created Batch account are dropped from the dispatch
                    list so the orchestrator never issues a 409. Untick to
                    force re-creation (typically fails with an existing-account
                    error).
                  </span>
                </div>
              </div>
            )}

          <Separator className="my-1" />

          <div className="flex justify-end">
            {!configureValid ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      type="button"
                      variant="default"
                      disabled
                      aria-label="Continue to preflight (disabled)"
                    >
                      Continue
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {effectiveSubscriptionIds.length === 0
                    ? "Pick a subscription first."
                    : selectedRegions.length === 0
                      ? "Select at least one region."
                      : "Resolve configuration errors."}
                </TooltipContent>
              </Tooltip>
            ) : (
              <Button
                type="button"
                variant="default"
                onClick={() => setStep("preflight")}
                aria-label="Continue to preflight"
              >
                Continue
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderPreflight = (): React.ReactNode => (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Pre-flight checks
        </CardTitle>
        <CardDescription>
          Verifies subscription, region capacity, and naming uniqueness before
          submission.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <PreflightChips checks={preflight} />

        <Separator className="my-1" />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setStep("configure")}
            aria-label="Back to configure"
          >
            Back
          </Button>
          {canPassPreflight ? (
            <Button
              type="button"
              variant="default"
              onClick={() => setStep("review")}
              aria-label="Continue to review"
            >
              Continue
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="default"
                    disabled
                    aria-label="Continue to review (disabled)"
                  >
                    Continue
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Resolve all blocking errors before continuing.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </CardContent>
    </Card>
  );

  const renderReview = (): React.ReactNode => (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Review
        </CardTitle>
        <CardDescription>
          Confirm the request below. You can jump back to edit any section.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ConfigureFieldsetReadOnly
          subscriptions={effectiveSubscriptionDetails}
          selectedRegions={selectedRegions}
          perSubDelaySec={perSubDelaySec}
          skipExisting={skipExisting}
          skippedCount={skippedExistingCount}
          onEdit={() => setStep("configure")}
        />

        {skippedExistingCount > 0 && (
          <Alert variant="info" className="px-3 py-2 text-xs">
            <Info className="h-4 w-4" aria-hidden />
            <AlertDescription className="text-xs leading-relaxed">
              <span className="font-semibold">
                {skippedExistingCount} (subscription × region) pair
                {skippedExistingCount === 1 ? "" : "s"} already have a Batch
                account
              </span>{" "}
              and will be skipped. Untick &ldquo;Skip already-existing&rdquo; on
              the Configure step to force re-creation.
            </AlertDescription>
          </Alert>
        )}

        <div className="rounded-md border border-border bg-surface-sunken/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Pre-flight summary
            </h4>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setStep("preflight")}
              aria-label="Edit pre-flight"
            >
              <Pencil className="h-3 w-3" aria-hidden />
              Edit
            </Button>
          </div>
          <PreflightChips checks={preflight} />
        </div>

        <Alert variant="warning" className="px-3 py-2 text-xs">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertDescription className="text-xs leading-relaxed">
            Submission is irreversible from this UI. Cleanup of accounts and
            resource groups is manual.
          </AlertDescription>
        </Alert>

        <Separator className="my-1" />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setStep("preflight")}
            aria-label="Back to preflight"
          >
            Back
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => setStep("submit")}
            aria-label="Continue to submit"
          >
            Continue
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  const renderSubmit = (): React.ReactNode => (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Submit
        </CardTitle>
        <CardDescription>
          Provision {totalToCreate} Batch account
          {totalToCreate === 1 ? "" : "s"}
          {effectiveSubscriptionIds.length > 1 ? (
            <>
              {" "}across {effectiveSubscriptionIds.length} subscriptions ·{" "}
              {perSubDelaySec}s gap between subs
            </>
          ) : (
            <>.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {submitError && (
          <ErrorState
            message="Provisioning request failed."
            detail={submitError}
            onRetry={() => {
              setSubmitError(null);
              requestSubmit();
            }}
            size="compact"
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="default"
            onClick={requestSubmit}
            disabled={isRunning || !configureValid || dispatchPlan.length === 0}
            loading={isRunning}
            aria-label={`Provision ${totalToCreate} Batch accounts`}
            className="min-w-[14rem]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Provision {totalToCreate} account
            {totalToCreate === 1 ? "" : "s"}
          </Button>

          {isRunning && (
            <Button
              type="button"
              variant="outline"
              onClick={handleStop}
              aria-label="Stop account creation"
              className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Square className="h-3.5 w-3.5" aria-hidden />
              Stop
            </Button>
          )}
        </div>

        {subBatchProgress && subBatchProgress.total > 1 && (
          <div
            className="flex flex-col gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5"
            role="status"
            aria-live="polite"
            aria-label="Multi-subscription dispatch progress"
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                {subBatchProgress.waiting ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
                )}
                Subscription{" "}
                <span className="tabular-nums">
                  {Math.min(
                    subBatchProgress.completed +
                      (subBatchProgress.waiting ? 0 : 1),
                    subBatchProgress.total,
                  )}
                </span>{" "}
                of <span className="tabular-nums">{subBatchProgress.total}</span>
              </span>
              {subBatchProgress.waiting && subBatchProgress.waitingUntil && (
                <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                  next dispatch in ~
                  {Math.max(
                    0,
                    Math.ceil(
                      (subBatchProgress.waitingUntil - Date.now()) / 1000,
                    ),
                  )}
                  s
                </span>
              )}
            </div>
            <Progress
              value={Math.round(
                (subBatchProgress.completed / subBatchProgress.total) * 100,
              )}
              aria-label={`${subBatchProgress.completed} of ${subBatchProgress.total} subscriptions dispatched`}
            />
            {subBatchProgress.currentSubId && !subBatchProgress.waiting && (
              <span className="text-2xs text-muted-foreground">
                Working on{" "}
                <span className="font-mono text-foreground">
                  {effectiveSubscriptionDetails.find(
                    (s) =>
                      s.subscriptionId === subBatchProgress.currentSubId,
                  )?.displayName ??
                    (subBatchProgress.currentSubId ?? "").slice(0, 8) + "…"}
                </span>
              </span>
            )}
            {subBatchProgress.waiting && (
              <span className="text-2xs text-muted-foreground leading-relaxed">
                Waiting before the next subscription so ARM&apos;s per-tenant
                write throttle has room to breathe. Click Stop above to abort.
              </span>
            )}
          </div>
        )}

        {(isRunning || progressTotal > 0) && (
          <div
            className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken/60 px-3 py-2.5"
            role="group"
            aria-labelledby="creation-progress-label"
          >
            <div className="flex items-center justify-between gap-2 text-xs text-foreground">
              <span
                id="creation-progress-label"
                className="inline-flex items-center gap-1.5 font-medium"
              >
                {isRunning ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : failedCount === 0 ? (
                  <CheckCircle2
                    className="h-3.5 w-3.5 text-success"
                    aria-hidden
                  />
                ) : (
                  <AlertTriangle
                    className="h-3.5 w-3.5 text-warning"
                    aria-hidden
                  />
                )}
                {isRunning ? "Creating accounts..." : "Completed"}
              </span>
              <span
                className="tabular-nums text-muted-foreground"
                aria-live="polite"
              >
                {progressDone}/{progressTotal} ({progressPercent}%)
              </span>
            </div>
            <Progress
              value={progressPercent}
              aria-label={`${progressDone} of ${progressTotal} accounts processed`}
              aria-valuetext={`${progressDone} of ${progressTotal} accounts processed (${progressPercent} percent)`}
            />
            {(isRunning || currentRegion) && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground">
                {currentRegion ? (
                  <span aria-live="polite">
                    Working on{" "}
                    <span className="font-mono text-foreground">
                      {currentRegion}
                    </span>
                  </span>
                ) : (
                  <span />
                )}
                {etaSeconds !== null && (
                  <span className="tabular-nums" aria-live="polite">
                    ~{formatEta(etaSeconds)} remaining
                  </span>
                )}
              </div>
            )}
            {/* Per-region pill list — color-coded so the user can see
                which regions completed, which failed, and which are still
                pending without scrolling to the result table. */}
            {regionStatus.length > 0 && (
              <ul
                className="mt-1 flex flex-wrap gap-1"
                aria-label="Per-region provisioning status"
              >
                {regionStatus.map((r) => (
                  <li key={r.region}>
                    <RegionStatusChip
                      region={r.region}
                      state={r.state as ProvisioningRowState}
                      accountName={r.accountName}
                      error={r.error}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Separator className="my-1" />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setStep("review")}
            disabled={isRunning}
            aria-label="Back to review"
          >
            Back
          </Button>
          {!isRunning && progressTotal > 0 && (
            <Button
              type="button"
              variant="default"
              onClick={() => setStep("result")}
              aria-label="View result"
            >
              View result
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );

  const renderResult = (): React.ReactNode => {
    // Three result postures, each with its own banner. Empty = no rows
    // (user landed here without a submission); success = all created,
    // none failed; partial = mix of created + failed; failure = all
    // failed. Visual emphasis is the only behaviour change — handlers
    // remain identical.
    const allSuccess =
      totalCount > 0 && failedCount === 0 && createdCount === totalCount;
    const allFailed = totalCount > 0 && createdCount === 0 && failedCount > 0;
    const partial = totalCount > 0 && createdCount > 0 && failedCount > 0;
    const successRate =
      totalCount > 0 ? Math.round((createdCount / totalCount) * 100) : 0;
    const avgPerAccountMs =
      lastAttemptDurationMs !== null && totalCount > 0
        ? Math.round(lastAttemptDurationMs / totalCount)
        : null;
    // Per-subscription rollup so the user can see "sub A: 5/5, sub B:
    // 2/3, sub C: 0/2 — all failed" without scanning the row table.
    const perSubSummary = (() => {
      const map = new Map<
        string,
        { displayName: string; created: number; failed: number; total: number }
      >();
      for (const a of attemptAccounts) {
        const known = state.subscriptions.find(
          (s) => s.subscriptionId === a.subscriptionId,
        );
        const entry = map.get(a.subscriptionId) ?? {
          displayName:
            known?.displayName ??
            (a.subscriptionId ? a.subscriptionId.slice(0, 8) + "…" : "—"),
          created: 0,
          failed: 0,
          total: 0,
        };
        entry.total += 1;
        if (a.provisioningState === "created") entry.created += 1;
        if (a.provisioningState === "failed") entry.failed += 1;
        map.set(a.subscriptionId, entry);
      }
      return Array.from(map.entries()).map(([subscriptionId, v]) => ({
        subscriptionId,
        ...v,
      }));
    })();

    return (
      <Card
        className={cn(
          "transition-shadow duration-200 ease-out",
          allSuccess && "ring-1 ring-success/30",
          allFailed && "ring-1 ring-destructive/30",
          partial && "ring-1 ring-warning/30",
        )}
      >
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Result
              </CardTitle>
              <CardDescription>
                <span className="text-foreground font-medium tabular-nums">
                  {totalCount}
                </span>{" "}
                account{totalCount === 1 ? "" : "s"} (
                <span className="text-success font-medium tabular-nums">
                  {createdCount} ready
                </span>
                ,{" "}
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    failedCount > 0
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {failedCount} failed
                </span>
                )
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {failedCount > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleRetryFailed}
                  aria-label={`Retry ${failedCount} failed accounts`}
                  className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <RotateCw className="h-3.5 w-3.5" aria-hidden />
                  Retry failed ({failedCount})
                </Button>
              )}
              <Button
                type="button"
                variant={allSuccess ? "default" : "ghost"}
                onClick={() => {
                  // Wipe the attempt scope before going back to configure
                  // so progress/result counters reset to zero. Without this
                  // reset, the auto-advance effect would immediately bounce
                  // the user back to the result step with the OLD numbers.
                  setAttemptStartedAt(null);
                  setSubmitError(null);
                  setSubBatchProgress(null);
                  setLastAttemptDurationMs(null);
                  setStep("configure");
                }}
                aria-label="Start a new provisioning request"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                New request
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          {/* Summary stats — surfaces the metrics the operator
              previously had to compute mentally (success rate, elapsed,
              avg per account, per-sub breakdown). */}
          {totalCount > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="flex flex-col rounded-md border border-border bg-surface-sunken/40 p-2.5">
                <span className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Success rate
                </span>
                <span
                  className={cn(
                    "tabular-nums text-lg font-semibold leading-none",
                    allSuccess
                      ? "text-success"
                      : partial
                        ? "text-warning"
                        : allFailed
                          ? "text-destructive"
                          : "text-foreground",
                  )}
                >
                  {successRate}%
                </span>
                <span className="text-2xs text-muted-foreground">
                  {createdCount} of {totalCount}
                </span>
              </div>
              <div className="flex flex-col rounded-md border border-border bg-surface-sunken/40 p-2.5">
                <span className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Elapsed
                </span>
                <span className="tabular-nums text-lg font-semibold leading-none text-foreground">
                  {lastAttemptDurationMs !== null
                    ? formatEta(Math.round(lastAttemptDurationMs / 1000))
                    : "—"}
                </span>
                <span className="text-2xs text-muted-foreground">
                  wall-clock
                </span>
              </div>
              <div className="flex flex-col rounded-md border border-border bg-surface-sunken/40 p-2.5">
                <span className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Avg / account
                </span>
                <span className="tabular-nums text-lg font-semibold leading-none text-foreground">
                  {avgPerAccountMs !== null
                    ? formatEta(Math.round(avgPerAccountMs / 1000))
                    : "—"}
                </span>
                <span className="text-2xs text-muted-foreground">
                  end-to-end
                </span>
              </div>
              <div className="flex flex-col rounded-md border border-border bg-surface-sunken/40 p-2.5">
                <span className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Subscriptions
                </span>
                <span className="tabular-nums text-lg font-semibold leading-none text-foreground">
                  {perSubSummary.length}
                </span>
                <span className="text-2xs text-muted-foreground">
                  touched
                </span>
              </div>
            </div>
          )}

          {/* Per-subscription breakdown — only when more than one sub
              is in play; for single-sub runs this is just a duplicate
              of the headline counts. */}
          {perSubSummary.length > 1 && (
            <div className="rounded-md border border-border bg-surface-sunken/40 p-3">
              <h4 className="m-0 mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Per-subscription
              </h4>
              <ul className="flex flex-col gap-1 text-xs">
                {perSubSummary.map((s) => {
                  const allOk = s.failed === 0 && s.created === s.total;
                  const someFailed = s.failed > 0;
                  return (
                    <li
                      key={s.subscriptionId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-card/40 px-2 py-1"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {allOk ? (
                          <CheckCircle2
                            className="h-3 w-3 text-success"
                            aria-hidden
                          />
                        ) : someFailed && s.created === 0 ? (
                          <XCircle
                            className="h-3 w-3 text-destructive"
                            aria-hidden
                          />
                        ) : (
                          <AlertTriangle
                            className="h-3 w-3 text-warning"
                            aria-hidden
                          />
                        )}
                        <span className="font-medium text-foreground">
                          {s.displayName}
                        </span>
                        <span className="font-mono text-2xs text-muted-foreground">
                          {s.subscriptionId.slice(0, 8)}…
                        </span>
                      </span>
                      <span className="tabular-nums text-2xs text-muted-foreground">
                        <span className="text-success">{s.created}</span>
                        {" / "}
                        <span className="text-foreground">{s.total}</span>
                        {s.failed > 0 && (
                          <>
                            {" · "}
                            <span className="text-destructive">
                              {s.failed} failed
                            </span>
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {allSuccess && (
            <Alert
              variant="success"
              className="px-3 py-2 transition-colors duration-200 ease-out"
              role="status"
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              <AlertDescription className="text-xs leading-relaxed">
                <span className="font-semibold">
                  All {createdCount} account
                  {createdCount === 1 ? "" : "s"} provisioned successfully.
                </span>{" "}
                You can attach pools and nodes from the related views.
              </AlertDescription>
            </Alert>
          )}
          {partial && (
            <Alert
              variant="warning"
              className="px-3 py-2 transition-colors duration-200 ease-out"
              role="status"
            >
              <AlertTriangle className="h-4 w-4" aria-hidden />
              <AlertDescription className="text-xs leading-relaxed">
                <span className="font-semibold">
                  {createdCount} of {totalCount} accounts succeeded;{" "}
                  {failedCount} failed.
                </span>{" "}
                Use Retry failed to re-run only the failed regions.
              </AlertDescription>
            </Alert>
          )}
          {allFailed && (
            <Alert
              variant="destructive"
              className="px-3 py-2 transition-colors duration-200 ease-out"
              role="alert"
            >
              <AlertCircle className="h-4 w-4" aria-hidden />
              <AlertDescription className="text-xs leading-relaxed">
                <span className="font-semibold">
                  All {failedCount} account
                  {failedCount === 1 ? "" : "s"} failed to provision.
                </span>{" "}
                Inspect each row&apos;s error, fix the root cause, and retry.
              </AlertDescription>
            </Alert>
          )}
          {provisionedRows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No accounts provisioned"
              description="Submit a request from the Submit step to populate the result rollup."
              action={{
                label: "Start a new request",
                onClick: () => {
                  setAttemptStartedAt(null);
                  setSubmitError(null);
                  setStep("configure");
                },
                icon: Plus,
              }}
            />
          ) : (
            <DataTable<ProvisionedRow>
              tableId="account-provisioning-result"
              rows={provisionedRows}
              columns={provisionedColumns}
              rowKey={(r) => r.id}
              csvFileName="provisioned-accounts.csv"
              jsonFileName="provisioned-accounts.json"
              empty={
                <EmptyState
                  icon={Users}
                  title="No accounts provisioned"
                  description="Submit a request to populate the result rollup."
                />
              }
            />
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div
      className="flex flex-col gap-4 py-4"
      role="region"
      aria-label="Account provisioning page"
    >
      <PageHeader
        title="Account Provisioning"
        description="Create new Azure Batch accounts across regions, or import existing accounts from a subscription."
      >
        <div className="flex items-center gap-2">
          <TokenExpiryBadge
            secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
            loading={armTokenTracker.loading}
            onRefresh={() => void armTokenTracker.refresh()}
            needsReauth={armTokenTracker.needsReauth}
            onReauth={() => void armTokenTracker.reauth()}
          />
        </div>
      </PageHeader>

      {validationError && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{validationError}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setValidationError(null)}
              aria-label="Dismiss validation error"
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v === "import" ? "import" : "create")}
        aria-label="Account provisioning flow"
      >
        <TabsList className="h-auto bg-muted/60 p-1">
          <TabsTrigger value="create" className="gap-1.5 px-3 py-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Create New
          </TabsTrigger>
          <TabsTrigger value="import" className="gap-1.5 px-3 py-1.5 text-xs">
            <CloudDownload className="h-3.5 w-3.5" aria-hidden />
            Import Existing
          </TabsTrigger>
        </TabsList>

        <TabsContent value="create" className="mt-4 flex flex-col gap-4">
          {/* Stepper UI per Contract §3.7 — uses AnimatedTabs for the step
              strip; the outer Tabs root + TabsContent panels are kept so
              Radix continues to drive panel visibility from `currentStep`. */}
          <Tabs
            value={currentStep}
            onValueChange={(v) => setStep(v as StepId)}
            aria-label="Provisioning workflow steps"
            orientation="horizontal"
          >
            <AnimatedTabs
              size="sm"
              aria-label="Provisioning steps"
              value={currentStep}
              onChange={(id) => setStep(id as StepId)}
              tabs={STEP_ORDER.map((s) => ({
                id: s,
                label: STEP_LABEL[s],
                disabled: isStepDisabled(s),
                badge:
                  s === "result" && failedCount > 0 ? failedCount : undefined,
              }))}
            />

            <TabsContent value="configure" className="mt-4">
              {renderConfigure()}
            </TabsContent>
            <TabsContent value="preflight" className="mt-4">
              {renderPreflight()}
            </TabsContent>
            <TabsContent value="review" className="mt-4">
              {renderReview()}
            </TabsContent>
            <TabsContent value="submit" className="mt-4">
              {renderSubmit()}
            </TabsContent>
            <TabsContent value="result" className="mt-4">
              {renderResult()}
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="import" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Import existing accounts
              </CardTitle>
              <CardDescription>
                Discover all existing Batch accounts in a subscription and
                import them.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {subscriptionSelector}

              <div className="flex flex-wrap items-end gap-2">
                <Button
                  type="button"
                  variant="default"
                  onClick={handleDiscover}
                  disabled={
                    isDiscovering || effectiveSubscriptionIds.length === 0
                  }
                  loading={isDiscovering}
                  aria-label="Discover existing Batch accounts"
                >
                  {isDiscovering ? (
                    "Discovering..."
                  ) : (
                    <>
                      <Search className="h-3.5 w-3.5" aria-hidden />
                      Discover Batch Accounts
                      {effectiveSubscriptionIds.length > 1 ? (
                        <span className="ml-1 text-2xs opacity-80">
                          ({effectiveSubscriptionIds.length} subs)
                        </span>
                      ) : null}
                    </>
                  )}
                </Button>
                {isDiscovering && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleStopDiscover}
                    aria-label="Stop discovery"
                    className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Square className="h-3.5 w-3.5" aria-hidden />
                    Stop
                  </Button>
                )}
              </div>

              {discoverError && (
                <ErrorState
                  message="Failed to discover Batch accounts."
                  detail={discoverError}
                  onRetry={() => {
                    setDiscoverError(null);
                    handleDiscover();
                  }}
                  size="compact"
                />
              )}

              {isDiscovering && (
                <div
                  className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken/60 px-3 py-2.5"
                  role="status"
                  aria-live="polite"
                >
                  <span className="text-xs font-medium text-foreground">
                    Discovering Batch accounts from Azure...
                  </span>
                  <Progress indeterminate />
                </div>
              )}

              <Alert variant="info" className="px-3 py-2">
                <Info className="h-4 w-4" aria-hidden />
                <AlertDescription className="text-xs leading-relaxed">
                  Discovers all existing Batch accounts in the selected
                  subscription and imports them so you can manage quota, pools,
                  and nodes on them.
                </AlertDescription>
              </Alert>

              {state.accounts.length > 0 && (
                <DataTable<ProvisionedRow>
                  tableId="account-provisioning-imported"
                  rows={importedRows}
                  columns={provisionedColumns}
                  rowKey={(r) => r.id}
                  csvFileName="imported-accounts.csv"
                  jsonFileName="imported-accounts.json"
                />
              )}

              {!isDiscovering && state.accounts.length === 0 && (
                <EmptyState
                  icon={CloudDownload}
                  title="No accounts imported"
                  description="Run discovery to import existing Batch accounts from the selected subscription."
                  action={
                    effectiveSubscriptionIds.length > 0
                      ? {
                          label: "Discover Batch Accounts",
                          onClick: handleDiscover,
                          icon: Search,
                          loading: isDiscovering,
                        }
                      : undefined
                  }
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmationDialog
        hidden={confirmHidden}
        title="Create Batch accounts?"
        message={confirmMessage}
        confirmText={`Create ${totalToCreate} account${totalToCreate === 1 ? "" : "s"}`}
        cancelText="Cancel"
        danger
        onConfirm={handleConfirmCreate}
        onCancel={() => setConfirmHidden(true)}
        loading={isRunning}
      />
    </div>
  );
};

export const AccountProvisioningPage: React.FC<AccountProvisioningPageProps> = (
  props,
) => <AccountProvisioningPageInner {...props} />;
