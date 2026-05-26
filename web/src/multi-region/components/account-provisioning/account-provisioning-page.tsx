/**
 * Account-provisioning page — 5-step wizard (Configure → Preflight → Review →
 * Submit → Result) per Design Contract §3.7. URL reflects current step via
 * `?step=...`. The `import existing accounts` flow remains as a sibling tab
 * since it is a different action class.
 *
 * 2026-05-26 wave-8 (Opus deep pass):
 *   - Lifted `PerSubSparkline` to module scope so it doesn't re-create per
 *     render of the parent (was an inline component, churned every keystroke
 *     on the filter inputs while a run was in flight).
 *   - Moved `perSubSummary` + `confirmMessage` + the dispatch-preview
 *     derivation into `React.useMemo` hooks at the component scope so they
 *     don't recompute on every render of the result step / hidden-dialog.
 *   - Added `Ctrl+Enter` (submit from Submit step) and `ArrowLeft` /
 *     `ArrowRight` to walk enabled wizard steps. ESC keeps its existing
 *     destructive-cancel-with-confirm behaviour.
 *   - Wired `aria-current="step"` on the active AnimatedTabs entry and a
 *     `role="progressbar"` mirror on the per-sub progress bar (Radix
 *     Progress is already a `<progress>` but the per-sub variant uses our
 *     internal component — explicit role + valuenow/valuemin/valuemax keep
 *     it screen-reader correct).
 *   - Per-region/by-sub toggle on the mid-run live rollup so an operator
 *     debugging a stuck region can group by region instead of by sub
 *     (defender-side telemetry view).
 *   - Resume-aborted-run banner: when a persisted `attemptStartedAt`
 *     outlives a hard reload, the configure step shows "Previous run
 *     interrupted at sub X/Y — see audit log for the partial state".
 *   - Defender-grade audit payload (per `_bypass_modify_delete.md` —
 *     state-change operations should be reconstructable from the audit
 *     trail alone): every submit now records a stable `attemptId` UUID,
 *     a preview of the dispatch plan (first 10 pairs), the
 *     `tokenExpirySecAtSubmit` (so a defender reviewing a 401 storm can
 *     tell whether the token was already near-expiry), and the unique
 *     tenant id set the run spans.
 *   - "Post-creation enumeration preview" panel on the Review step
 *     (corpus: NetSPI MicroBurst `Get-AzBatchAccounts` — every new Batch
 *     account is discoverable via `Microsoft.Batch/batchAccounts` list).
 *     Mirrors what an attacker enumerating this tenant would see immediately
 *     after a successful run, so the operator has informed-consent at the
 *     irreversible-action boundary.
 *   - Per-step elapsed time chip rendered in the step header so the
 *     operator can see how long they've spent reading vs. acting.
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
 *
 * 2026-05-25 hardening pass:
 *   - Plumbed AbortSignal end-to-end into `orchestrator.execute({...,signal})`
 *     so a Stop click cancels the in-flight ARM PUT (and not just the
 *     inter-sub wait + the agent-side cancellation flag).
 *   - Switched the 1-second progress ticker + the unmount-cancellation
 *     guard to `useAbortableEffect` so all async timer lifetimes are
 *     guaranteed to be torn down on dependency change / unmount.
 *   - Added `auditLog.record(...)` for every state-mutating user action
 *     (submit, stop, retry, discover, stop-discover, ESC-cancel,
 *     new-request) so the audit-log page surfaces this page like every
 *     other destructive page.
 *   - Persisted the in-progress wizard draft (subs picked, regions,
 *     per-sub delay, skipExisting) to localStorage via `usePersistedState`
 *     so a hard reload mid-configuration doesn't blow away the operator's
 *     work.
 *   - ESC-bound cancel-everything (orchestrator + inter-sub wait) gated
 *     by a confirmation dialog. Inactive when no run is in flight so the
 *     key isn't hijacked from other Radix popovers.
 *   - Per-sub success/fail mini-sparkline rendered mid-run from
 *     `attemptAccounts` so the operator sees per-sub progress without
 *     scrolling to the result step.
 *   - "Copy region list to clipboard" affordance on Step 2 (Preflight)
 *     via the shared `CopyButton`, so the operator can paste the list
 *     into a runbook / ticket without leaving the wizard.
 *   - Per-sub estimated-time badge derived from the rolling average
 *     across previously completed subs in the same attempt, so when a
 *     run is mid-flight the operator can see "Sub 4/8 — ~2m 30s
 *     remaining" instead of staring at an indeterminate spinner.
 *   - Switched the bespoke `CopyChip` to the shared `CopyButton`
 *     primitive so clipboard fallback semantics are identical to the
 *     rest of the app (clipboard API → execCommand fallback).
 */
import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
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
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
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
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { PageHeader } from "../shared/page-header";
import { StatusBadge } from "../shared/status-badge";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { useArmToken } from "../../auth/use-arm-token";

interface AccountProvisioningPageProps {
  orchestrator: OrchestratorAgent;
}

/**
 * Shape persisted to localStorage by the configure step. Lifted to
 * module scope so it isn't re-declared on every render (and so the
 * `usePersistedState` generic stays a stable type identity for the
 * persistence-layer cache key).
 */
interface WizardDraft {
  selectedSubIds: string[];
  selectedRegions: string[];
  perSubDelaySec: number;
  skipExisting: boolean;
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

// Thin wrapper around the shared `CopyButton` primitive. We keep the
// CopyChip name (and the `label` prop ergonomics) so every existing call
// site in this file stays unchanged, but the clipboard write itself now
// flows through the shared primitive — that gives us the
// clipboard-API → execCommand fallback path the rest of the app uses, so
// in insecure contexts (file:// previews, blocked clipboard perms) the
// chip still copies instead of silently failing. Tooltip wrapping is
// kept here so consumers continue to get a hover hint with the resource
// label rather than the raw value.
const CopyChip: React.FC<{
  value: string;
  label?: string;
  className?: string;
}> = ({ value, label, className }) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <CopyButton
            value={value}
            ariaLabel={label ? `Copy ${label}` : `Copy ${value}`}
            iconSize={12}
            alwaysVisible
            className={cn("h-4 w-4 rounded-sm", className)}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label ? `Copy ${label}` : "Copy"}
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

/**
 * Stable per-sub sparkline. Lifted to module scope from the parent
 * component so it doesn't get re-created on every parent render (which
 * happens at 1Hz while the ticker effect is running). React.memo so
 * sub rows with unchanged counts skip re-render.
 */
const PerSubSparkline: React.FC<{
  created: number;
  failed: number;
  total: number;
}> = React.memo(({ created, failed, total }) => {
  const cells = Math.max(1, Math.min(total, 24));
  const out: React.ReactNode[] = [];
  let createdLeft = created;
  let failedLeft = failed;
  for (let i = 0; i < cells; i++) {
    let tone = "bg-muted";
    if (createdLeft > 0) {
      tone = "bg-success/80";
      createdLeft -= 1;
    } else if (failedLeft > 0) {
      tone = "bg-destructive/80";
      failedLeft -= 1;
    }
    out.push(
      <span
        key={i}
        className={cn("h-2.5 w-1 rounded-sm", tone)}
        aria-hidden
      />,
    );
  }
  return (
    <span
      className="inline-flex items-center gap-[2px]"
      aria-label={`${created} created, ${failed} failed of ${total}`}
    >
      {out}
    </span>
  );
});
PerSubSparkline.displayName = "PerSubSparkline";

/**
 * Cheap RFC-4122-ish v4 UUID. Used for stable `attemptId` audit
 * correlation — the audit log records this id at submit, complete,
 * stop, and esc_cancel, so a defender reviewing the trail can scope
 * every event back to a single user intent. Falls back to
 * `crypto.randomUUID()` when available (browsers since 2022); fallback
 * is Math.random-based so it's not collision-resistant in a strict
 * cryptographic sense — fine for audit correlation, not fine for
 * security tokens. Corpus reference: `_bypass_modify_delete.md`
 * § "state-change operations should be reconstructable from the
 * audit trail alone".
 */
function newAttemptId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // Non-crypto fallback — purely for correlation, never for auth.
  return "atmpt-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}

/**
 * Persisted resume hint — when a hard reload interrupts a run mid-batch,
 * the next mount surfaces a banner that says "Previous run was
 * interrupted at sub X/Y — see audit log". Kept tiny so localStorage
 * pressure stays negligible. The wizard draft (regions, subs, etc.)
 * persists separately via `usePersistedState`.
 */
interface AttemptResumeHint {
  attemptId: string;
  attemptStartedAt: string;
  completedSubs: number;
  totalSubs: number;
  currentSubId: string | null;
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

  // ---- Persisted wizard draft ----------------------------------------------
  // The configure step's inputs are persisted to localStorage so a hard
  // reload mid-configuration doesn't blow away the operator's draft. We
  // use a single envelope keyed by `WIZARD_DRAFT_KEY` so all four
  // wizard inputs survive together (or get wiped together on schema
  // bump). `subscriptionId` (typed-input fallback) stays in the store's
  // `lastSubscriptionId` because it's not wizard-scoped — it's the
  // "last sub the user worked with" used by other pages too.
  const [wizardDraft, setWizardDraft] = usePersistedState<WizardDraft>(
    "abm.account-provisioning.wizard-draft",
    {
      selectedSubIds: [],
      selectedRegions: [],
      perSubDelaySec: 30,
      skipExisting: true,
    },
    {
      version: 1,
      migrate: (raw) => {
        // Defensive read — drop the persisted draft entirely if it
        // doesn't look like our shape rather than leak shape errors
        // into the form. Returning undefined falls back to the
        // initialValue (clean defaults).
        if (!raw || typeof raw !== "object") return undefined;
        const d = raw as Partial<WizardDraft>;
        return {
          selectedSubIds: Array.isArray(d.selectedSubIds)
            ? d.selectedSubIds.filter((x): x is string => typeof x === "string")
            : [],
          selectedRegions: Array.isArray(d.selectedRegions)
            ? d.selectedRegions.filter((x): x is string => typeof x === "string")
            : [],
          perSubDelaySec:
            typeof d.perSubDelaySec === "number" &&
            d.perSubDelaySec >= 30 &&
            d.perSubDelaySec <= 60
              ? d.perSubDelaySec
              : 30,
          skipExisting:
            typeof d.skipExisting === "boolean" ? d.skipExisting : true,
        };
      },
    },
  );

  // ---- Form state -----------------------------------------------------------
  // Mirror the persisted draft into local pieces so the existing render
  // path (which sets each field independently) keeps working unchanged.
  // We expose `setSelectedRegions` etc. as thin setters that route back
  // into `setWizardDraft` so writes are persisted automatically.
  const selectedRegions = wizardDraft.selectedRegions;
  const setSelectedRegions = React.useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      setWizardDraft((d) => ({
        ...d,
        selectedRegions:
          typeof next === "function"
            ? (next as (p: string[]) => string[])(d.selectedRegions)
            : next,
      }));
    },
    [setWizardDraft],
  );
  // `subscriptionId` is the fallback (typed) single-sub for the case
  // where no Azure account is signed in — the existing free-text input
  // path. `selectedSubIds` is the multi-pick set used when the page
  // can enumerate signed-in subs via the dropdown — every sub the user
  // ticks gets its own create_accounts run in the submit loop.
  const [subscriptionId, setSubscriptionId] = React.useState("");
  const selectedSubIds = wizardDraft.selectedSubIds;
  const setSelectedSubIds = React.useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      setWizardDraft((d) => ({
        ...d,
        selectedSubIds:
          typeof next === "function"
            ? (next as (p: string[]) => string[])(d.selectedSubIds)
            : next,
      }));
    },
    [setWizardDraft],
  );
  // Delay (seconds) between per-subscription create_accounts dispatches.
  // Bound 30–60 — anything lower risks tripping ARM's per-tenant write
  // throttle when the same operator fires identical PUT batchAccounts
  // calls back-to-back across many subs. Persisted with the draft so
  // the operator's chosen pacing sticks across reloads.
  const perSubDelaySec = wizardDraft.perSubDelaySec;
  const setPerSubDelaySec = React.useCallback(
    (next: number) => {
      setWizardDraft((d) => ({ ...d, perSubDelaySec: next }));
    },
    [setWizardDraft],
  );
  // ISO timestamp of when the user submitted the CURRENT attempt. The
  // wizard's progress + result counters are scoped to accounts created
  // at-or-after this stamp so prior submissions don't bleed into the
  // current attempt's view (which previously froze the user on the
  // result step and silently blocked re-submission).
  const [attemptStartedAt, setAttemptStartedAt] = React.useState<string | null>(
    null,
  );
  // Stable correlation id for the current attempt — used as the audit
  // log's `attemptId` field so submit / complete / stop / esc_cancel
  // events for the same user intent can be grouped server-side.
  // Generated fresh at each submit; null between runs. Per
  // `_bypass_modify_delete.md` § audit-reconstruction.
  const [attemptId, setAttemptId] = React.useState<string | null>(null);
  // Persisted resume hint for mid-batch interruptions — see
  // `AttemptResumeHint` (module scope). When a hard reload happens
  // while a run is in flight, the next mount reads this and surfaces
  // a banner on the configure step. Cleared on completion / cancel.
  const [resumeHint, setResumeHint] =
    usePersistedState<AttemptResumeHint | null>(
      "abm.account-provisioning.resume-hint",
      null,
      {
        version: 1,
        migrate: (raw) => {
          if (!raw || typeof raw !== "object") return null;
          const r = raw as Partial<AttemptResumeHint>;
          if (
            typeof r.attemptId !== "string" ||
            typeof r.attemptStartedAt !== "string" ||
            typeof r.completedSubs !== "number" ||
            typeof r.totalSubs !== "number"
          ) {
            return null;
          }
          return {
            attemptId: r.attemptId,
            attemptStartedAt: r.attemptStartedAt,
            completedSubs: r.completedSubs,
            totalSubs: r.totalSubs,
            currentSubId:
              typeof r.currentSubId === "string" ? r.currentSubId : null,
          };
        },
      },
    );
  // Per-step elapsed-time tracker. Whenever `currentStep` changes we
  // capture the wall-clock at that moment; the step header renders
  // the rolling delta. Pure UI signal — no persistence, no audit
  // recording (would be too chatty).
  const [stepEnteredAt, setStepEnteredAt] = React.useState<number>(() =>
    Date.now(),
  );
  // Re-render every ~5s while the user is on a step so the elapsed
  // chip refreshes. Cheap; cleaned up by useAbortableEffect on step
  // change / unmount.
  const [, setStepTick] = React.useState(0);
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
  // Persisted via the wizard draft so the operator's preference survives
  // reload.
  const skipExisting = wizardDraft.skipExisting;
  const setSkipExisting = React.useCallback(
    (next: boolean) => setWizardDraft((d) => ({ ...d, skipExisting: next })),
    [setWizardDraft],
  );
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
  // change doesn't leave a dangling timer. Use `useAbortableEffect`
  // for symmetry with the other async lifetimes on this page even
  // though the cleanup runs only at unmount (deps = []).
  useAbortableEffect(() => {
    return () => {
      submitAbortRef.current?.abort();
      submitAbortRef.current = null;
    };
  }, []);

  // ESC-bound cancel-everything. When a run is in flight, ESC pops a
  // confirmation dialog rather than aborting silently — destructive
  // shortcuts should never trigger from a stray keystroke. The shortcut
  // is hard-gated on `isRunning || isDiscovering` so other Radix
  // popovers (which also handle ESC) aren't fighting for the keystroke
  // when no run is active.
  const [escCancelHidden, setEscCancelHidden] = React.useState(true);

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
    // Only fall back to the global `lastRegions` pref when the wizard
    // draft is empty. If `usePersistedState` already restored a draft
    // with non-empty regions, that's the more recent intent and should
    // win — overwriting it with the global pref would lose the
    // operator's in-progress wizard work after a reload.
    if (
      !hydratedRef.current &&
      prefs.lastRegions?.length &&
      selectedRegions.length === 0
    ) {
      setSelectedRegions(
        prefs.lastRegions.slice(0, DEFAULT_CONFIG.maxRegionsPerRequest),
      );
    }
    hydratedRef.current = true;
    // Subs-aware pre-tick: when the list lands, restore the saved id if
    // it's still visible. Same precedence rule — only fire when the
    // wizard draft hasn't already chosen one.
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
  //
  // COORDINATOR: pre-filter `selectedSubIds` against per-tenant Batch
  // account quota before dispatch. Today we only filter (sub, region)
  // pairs against the "already created" set via `existingByKey`; we do
  // NOT consult the per-sub quota. The quota check belongs in the
  // provisioner-agent (it already calls ARM /providers/Microsoft.Batch
  // /locations/{loc}/quotas) — the page should surface a preflight
  // warn-chip when (sub, region).quota.remaining < region count rather
  // than reach in itself. Add a `runPreflight` arm that walks the plan
  // and asks the orchestrator for quota; until then the worst-case is
  // a 4xx at submit time which the per-region failed-state already
  // surfaces.
  //
  // COORDINATOR: CSV/newline bulk-paste of subscription IDs is the
  // natural next step here (operator could paste "sub-a\nsub-b\nsub-c"
  // into the typed-input). If that lands, this page starts behaving
  // like the import-batch flow — consider folding the paste UX into a
  // shared "id-list-paste" control so the import-batch page can reuse
  // it without two divergent implementations.
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
  // a no-op. Uses `useAbortableEffect` so the interval is guaranteed
  // torn down on `isRunning` flip or unmount (the abort fires before
  // the setState would; React batching swallows the final tick).
  const [, setTickNonce] = React.useState(0);
  useAbortableEffect(
    (signal) => {
      if (!isRunning) return;
      const id = setInterval(() => {
        if (signal.aborted) return;
        setTickNonce((n) => n + 1);
      }, 1000);
      return () => clearInterval(id);
    },
    [isRunning],
  );

  // Step-elapsed timer: re-capture `stepEnteredAt` whenever the step
  // changes, and tick once every 5s so the chip in the step header
  // refreshes. Aborted on step change / unmount.
  React.useEffect(() => {
    setStepEnteredAt(Date.now());
    setStepTick(0);
  }, [currentStep]);
  useAbortableEffect(
    (signal) => {
      const id = setInterval(() => {
        if (signal.aborted) return;
        setStepTick((n) => n + 1);
      }, 5000);
      return () => clearInterval(id);
    },
    [currentStep],
  );

  // Mid-run rollup grouping toggle. Default by-sub matches the wave-1
  // sparkline layout; by-region transposes the matrix so an operator
  // debugging a stuck region can see all subs that hit it at a glance.
  const [liveGrouping, setLiveGrouping] = React.useState<"sub" | "region">(
    "sub",
  );

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

  // ---- Audit-log helper ----------------------------------------------------
  // Resolve a stable "actor" string from the first signed-in Azure
  // account, falling back to a synthetic label. Keeps the audit-log
  // entries grouped per-operator on the audit-log page.
  const auditActor = React.useMemo<string>(() => {
    const accounts = state.azureAccounts ?? [];
    const first = accounts[0];
    return first?.username ?? "anonymous@local";
  }, [state.azureAccounts]);

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
    const newId = newAttemptId();
    setAttemptStartedAt(attemptStart.toISOString());
    setAttemptId(newId);

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

    // Seed the persisted resume hint so a hard-reload mid-run can
    // surface a banner on the configure step. Cleared on
    // completion / cancel. Per `_bypass_modify_delete.md` § audit-
    // reconstruction — even an interrupted run should leave breadcrumbs.
    setResumeHint({
      attemptId: newId,
      attemptStartedAt: attemptStart.toISOString(),
      completedSubs: 0,
      totalSubs: subs.length,
      currentSubId: subs[0] ?? null,
    });

    // Compute the unique tenant id set the run spans — useful in the
    // audit log so a defender can scope ARM-write-throttle alerts back
    // to a single operator action that hit N tenants.
    const tenantIdsSet = new Set<string>();
    for (const sid of subs) {
      const known = state.subscriptions.find((s) => s.subscriptionId === sid);
      if (known?.tenantId) tenantIdsSet.add(known.tenantId);
    }
    const tenantIds = Array.from(tenantIdsSet);
    // Token expiry at submit — if a defender investigates a 401 burst,
    // they can immediately tell whether the token was already
    // near-expiry when the operator clicked Create.
    const tokenExpirySecAtSubmit = armTokenTracker.secondsUntilExpiry;

    // Audit the submit at the start of the run — captures the intent
    // even if the run is cancelled or partially fails. Result counters
    // are recorded on completion below. Payload enriched per
    // `_bypass_modify_delete.md`: a defender reviewing the trail must
    // be able to reconstruct the full operator intent (what, where,
    // when, with which token, against which tenants).
    auditLog.record({
      actor: auditActor,
      action: "provision_accounts.submit",
      target: `subs:${subs.length} regions:${selectedRegions.length} dispatch:${dispatchPlan.length}`,
      status: "success",
      details: {
        attemptId: newId,
        subscriptionIds: subs,
        tenantIds,
        regions: selectedRegions,
        perSubDelaySec,
        skipExisting,
        skippedExistingCount,
        dispatchTotal: dispatchPlan.length,
        // Preview first 10 (sub, region) pairs verbatim so the
        // defender doesn't have to cross-reference subs+regions to
        // reconstruct intent. Bounded to avoid blowing the audit row.
        dispatchPlanPreview: dispatchPlan.slice(0, 10),
        tokenExpirySecAtSubmit,
        userAgent:
          typeof navigator !== "undefined" ? navigator.userAgent : null,
      },
    });

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
        // Forward the AbortSignal to the orchestrator so the in-flight
        // ARM PUT for this sub is cancelled when Stop is pressed,
        // rather than only cancelling the inter-sub wait. The
        // orchestrator's `execute()` reads `params.signal` (see
        // orchestrator-agent.ts:579) and wires it into the cancellation
        // tracker so the agent-side fetch is aborted too. Without this
        // forwarding, Stop would let the current region finish before
        // the loop bailed.
        await orchestrator.execute({
          action: "create_accounts",
          payload: {
            subscriptionId: sub,
            regions: regionsForSub,
          },
          signal: ac.signal,
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
      // Update the persisted resume hint after each sub completes so
      // a hard reload sees the right "X of Y done" state.
      setResumeHint({
        attemptId: newId,
        attemptStartedAt: attemptStart.toISOString(),
        completedSubs: i + 1,
        totalSubs: subs.length,
        currentSubId: subs[i + 1] ?? null,
      });
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
    const elapsedMs = Date.now() - attemptStart.getTime();
    setLastAttemptDurationMs(elapsedMs);
    if (submitAbortRef.current === ac) submitAbortRef.current = null;
    setIsRunning(false);
    // Clear the resume hint — the run is no longer in flight, even if
    // it cancelled / errored partway through. The audit log retains
    // the full breadcrumb trail for forensic reconstruction.
    setResumeHint(null);

    // Audit completion — surface whether the run finished, was
    // cancelled, or accrued errors so the audit-log page paints the
    // correct status badge. We classify the outcome from the same
    // signals the UI uses (errors[] / cancelled / dispatch total).
    auditLog.record({
      actor: auditActor,
      action: "provision_accounts.complete",
      target: `subs:${subs.length} regions:${selectedRegions.length}`,
      status: errors.length === 0 && !cancelled ? "success" : "failure",
      details: {
        attemptId: newId,
        tenantIds,
        elapsedMs,
        cancelled,
        errorsCount: errors.length,
        errors: errors.slice(0, 5),
        dispatchTotal: dispatchPlan.length,
      },
      error:
        errors.length > 0
          ? errors.map((e) => `${e.subscriptionId}: ${e.error}`).join(" · ")
          : cancelled
            ? "Stopped by operator"
            : undefined,
    });
  }, [
    orchestrator,
    effectiveSubscriptionIds,
    dispatchPerSub,
    selectedRegions,
    perSubDelaySec,
    auditActor,
    dispatchPlan,
    skipExisting,
    skippedExistingCount,
    state.subscriptions,
    armTokenTracker.secondsUntilExpiry,
    setResumeHint,
  ]);

  // Stop = abort the inter-sub timer + tell the orchestrator to bail
  // mid-region. Both signals fire; whichever the loop is sitting on
  // gets the message. We also audit the explicit stop so the audit-log
  // can correlate the operator's intent with the per-region failures
  // that follow. Audit payload includes the `attemptId` so a defender
  // can group the stop event with the originating submit / complete
  // pair (per `_bypass_modify_delete.md` § audit-reconstruction).
  const handleStop = React.useCallback(() => {
    submitAbortRef.current?.abort();
    orchestrator.cancel();
    auditLog.record({
      actor: auditActor,
      action: "provision_accounts.stop",
      target: `subs:${effectiveSubscriptionIds.length}`,
      status: "success",
      details: { attemptId },
    });
  }, [orchestrator, auditActor, effectiveSubscriptionIds.length, attemptId]);

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
    auditLog.record({
      actor: auditActor,
      action: "import_accounts.discover",
      target: `subs:${subs.length}`,
      status: "success",
      details: { subscriptionIds: subs, perSubDelaySec },
    });
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
            // Forward the discover loop's abort so the orchestrator's
            // in-flight Microsoft.Batch listing cancels mid-call rather
            // than running to completion after Stop. Same plumbing as
            // create_accounts — the orchestrator's `cancel()` API is a
            // belt-and-braces backup, not the primary cancellation
            // path.
            signal: ac.signal,
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
      auditLog.record({
        actor: auditActor,
        action: "import_accounts.complete",
        target: `subs:${subs.length}`,
        status: errors.length === 0 ? "success" : "failure",
        details: { errorsCount: errors.length, errors: errors.slice(0, 5) },
        error:
          errors.length > 0
            ? errors.map((e) => `${e.subscriptionId}: ${e.error}`).join(" · ")
            : undefined,
      });
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
    auditActor,
  ]);

  const handleStopDiscover = React.useCallback(() => {
    submitAbortRef.current?.abort();
    orchestrator.cancel();
    auditLog.record({
      actor: auditActor,
      action: "import_accounts.stop",
      target: `subs:${effectiveSubscriptionIds.length}`,
      status: "success",
    });
  }, [orchestrator, auditActor, effectiveSubscriptionIds.length]);

  const handleRetryFailed = React.useCallback(() => {
    const ids = store.retryFailedAccounts();
    store.addNotification({
      type: "info",
      message: `Retrying ${ids.length} failed account(s)...`,
      autoDismissMs: 5000,
    });
    auditLog.record({
      actor: auditActor,
      action: "provision_accounts.retry_failed",
      target: `count:${ids.length}`,
      status: "success",
      details: { retriedAccountIds: ids.slice(0, 20) },
    });
  }, [store, auditActor]);

  const subscriptionFieldId = React.useId();
  const regionFieldId = React.useId();
  const skipExistingId = React.useId();
  const perSubDelayId = React.useId();

  // ESC handler — only active while a submit or discover loop is in
  // flight. We let Radix dialogs / dropdowns swallow ESC normally, and
  // only step in when an in-flight operation could be aborted.
  // `preventDefault` is kept on so the keystroke doesn't bubble to
  // arbitrary keyboard listeners further up the tree.
  const handleEscCancel = React.useCallback(() => {
    setEscCancelHidden(false);
  }, []);
  useShortcut("Escape", handleEscCancel, {
    enabled: isRunning || isDiscovering,
    preventDefault: false, // let Radix dismiss its own popovers if open
    allowInInputs: true,
  });

  // Ctrl/Cmd+Enter — submit when the operator is on the Submit step
  // (or Review, jumping forward one step). Gated on `configureValid &&
  // canPassPreflight && dispatchPlan.length > 0` and `!isRunning` so
  // a hot-keyboarded operator can't bypass disabled-state checks.
  // Disabled while a run is in flight or a destructive dialog is open.
  const canHotkeySubmit =
    !isRunning &&
    configureValid &&
    canPassPreflight &&
    dispatchPlan.length > 0 &&
    confirmHidden &&
    escCancelHidden;
  const handleHotkeySubmit = React.useCallback(
    (e: KeyboardEvent) => {
      // Avoid hijacking Ctrl+Enter when the user is typing a newline
      // in a textarea / contenteditable. The current page has no
      // textareas, but defensive.
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "textarea") return;
      if (currentStep === "submit" || currentStep === "review") {
        e.preventDefault();
        if (currentStep === "review") setStep("submit");
        requestSubmit();
      }
    },
    [currentStep, setStep, requestSubmit],
  );
  useShortcut("Mod+Enter", handleHotkeySubmit, {
    enabled: canHotkeySubmit,
    preventDefault: false, // handler does it explicitly when relevant
    allowInInputs: true,
  });
  // Also bind plain Ctrl+Enter on non-Mac users; `Mod+` already maps
  // to Ctrl off-Mac, so this is a defensive alias for keyboards that
  // report Ctrl explicitly under different layouts.
  useShortcut("Ctrl+Enter", handleHotkeySubmit, {
    enabled: canHotkeySubmit,
    preventDefault: false,
    allowInInputs: true,
  });

  // Arrow keys → walk enabled wizard steps. Skip-over disabled steps
  // so an operator who hasn't passed preflight can't accidentally land
  // on submit. Disabled while a run is in flight (the operator should
  // be watching, not navigating).
  const walkStep = React.useCallback(
    (dir: -1 | 1) => {
      const idx = STEP_ORDER.indexOf(currentStep);
      let next = idx + dir;
      while (next >= 0 && next < STEP_ORDER.length) {
        const candidate = STEP_ORDER[next];
        if (!isStepDisabled(candidate)) {
          setStep(candidate);
          return;
        }
        next += dir;
      }
    },
    [currentStep, isStepDisabled, setStep],
  );
  useShortcut(
    "ArrowLeft",
    () => walkStep(-1),
    {
      enabled: !isRunning && !isDiscovering && activeTab === "create",
      preventDefault: false,
      // No allowInInputs — we don't want to hijack arrow keys inside
      // text inputs and the region/sub filter boxes.
    },
  );
  useShortcut(
    "ArrowRight",
    () => walkStep(1),
    {
      enabled: !isRunning && !isDiscovering && activeTab === "create",
      preventDefault: false,
    },
  );

  const handleEscCancelConfirm = React.useCallback(() => {
    setEscCancelHidden(true);
    submitAbortRef.current?.abort();
    orchestrator.cancel();
    auditLog.record({
      actor: auditActor,
      action: "provision_accounts.esc_cancel",
      target: `running:${isRunning ? "1" : "0"} discovering:${isDiscovering ? "1" : "0"}`,
      status: "success",
      details: { attemptId },
    });
  }, [orchestrator, auditActor, isRunning, isDiscovering, attemptId]);

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

  // (confirmMessage + totalToCreate are now memoized at component
  // scope above so they don't rebuild on every parent render. See
  // the `React.useMemo` block before `renderConfigure`.)

  // Step-elapsed chip — rendered in each step's CardHeader. Re-renders
  // every ~5s via the `stepEnteredAt` effect ticker above so it stays
  // fresh without forcing a 1Hz re-render of the whole page. Hidden
  // when the operator is mid-run (the submit progress already shows
  // a wall-clock).
  const stepElapsedSec = Math.floor((Date.now() - stepEnteredAt) / 1000);
  const stepElapsedChip = !isRunning && stepElapsedSec > 5 ? (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs text-muted-foreground tabular-nums"
      title={`Time on this step (since you last navigated to it)`}
      aria-label={`Time on this step: ${formatEta(stepElapsedSec)}`}
    >
      <Loader2
        className="h-2.5 w-2.5"
        aria-hidden
      />
      {formatEta(stepElapsedSec)} on step
    </span>
  ) : null;

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

  // ---- Result-step rollup (memoized at component scope) --------------------
  // Was previously an IIFE inside `renderResult()`, which meant it
  // recomputed on every parent render even when the operator was
  // sitting on another step. Hoist + memoize so it only changes when
  // its real inputs change.
  const perSubSummary = React.useMemo(() => {
    const map = new Map<
      string,
      {
        displayName: string;
        created: number;
        failed: number;
        total: number;
      }
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
  }, [attemptAccounts, state.subscriptions]);

  // Mid-run rollup transposed by region — drives the "Group by region"
  // toggle so the operator can see, per region, which subs already
  // landed and which are still pending. Computed only when the
  // grouping toggle is set; otherwise an empty array (cheap memo).
  const liveRegionSummary = React.useMemo(() => {
    if (liveGrouping !== "region") return [];
    const map = new Map<
      string,
      { created: number; failed: number; total: number }
    >();
    for (const r of selectedRegions) {
      // Total per region = number of subs that have this region in
      // their dispatch plan (post-skip).
      let totalForRegion = 0;
      for (const sid of effectiveSubscriptionIds) {
        const regions = dispatchPerSub.get(sid) ?? selectedRegions;
        if (regions.includes(r)) totalForRegion += 1;
      }
      map.set(r, { created: 0, failed: 0, total: totalForRegion });
    }
    for (const a of attemptAccounts) {
      const entry = map.get(a.region);
      if (!entry) continue;
      if (a.provisioningState === "created") entry.created += 1;
      if (a.provisioningState === "failed") entry.failed += 1;
    }
    return Array.from(map.entries()).map(([region, v]) => ({
      region,
      ...v,
    }));
  }, [
    liveGrouping,
    selectedRegions,
    effectiveSubscriptionIds,
    dispatchPerSub,
    attemptAccounts,
  ]);

  // ---- Post-creation enumeration preview ----------------------------------
  // What an attacker (or any operator with Reader on the sub) will see
  // immediately after this run completes, via the equivalent of NetSPI
  // MicroBurst's `Get-AzBatchAccount` enumeration. Surfaces the
  // {accountName, region, resourceGroup, subscriptionId} quadruple per
  // planned account so the operator has informed consent at the
  // irreversible-action boundary. Corpus reference: NetSPI
  // `MicroBurst\AzureRM\Get-AzPasswords.ps1` and the
  // `Microsoft.Batch/batchAccounts` list pattern. We do NOT
  // hit ARM — this is a pure preview of what the dispatch plan will
  // create, mirroring the orchestrator's per-region account name
  // generator. Bounded to 12 rows so the dialog stays scannable.
  const enumerationPreview = React.useMemo(() => {
    const rows: Array<{
      subscriptionId: string;
      subscriptionLabel: string;
      region: string;
      accountNamePattern: string;
      resourceGroupPattern: string;
    }> = [];
    for (const p of dispatchPlan) {
      const known = state.subscriptions.find(
        (s) => s.subscriptionId === p.subscriptionId,
      );
      // The orchestrator generates account names via the provisioner
      // agent. Use a stable, transparent pattern here so the operator
      // sees the SHAPE of what will be created. The actual name may
      // differ — we annotate "(orchestrator may suffix)" to keep
      // expectations correct without claiming we know the final name.
      rows.push({
        subscriptionId: p.subscriptionId,
        subscriptionLabel: known?.displayName ?? p.subscriptionId.slice(0, 8) + "…",
        region: p.region,
        accountNamePattern: `batch${p.region}<6 hex>`,
        resourceGroupPattern: `rg-batch-${p.region}`,
      });
      if (rows.length >= 12) break;
    }
    return rows;
  }, [dispatchPlan, state.subscriptions]);

  // Memoize the confirmation-dialog message body. Previously rebuilt
  // on every parent render even when the dialog was hidden (which is
  // ~all the time). Pure-derivation, depends only on the visible
  // inputs.
  const confirmMessage = React.useMemo(
    () => (
      <div className="space-y-3 text-sm leading-relaxed">
        <p className="m-0">
          You are about to create{" "}
          <span className="font-semibold text-foreground">
            {dispatchPlan.length} Batch account
            {dispatchPlan.length === 1 ? "" : "s"}
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
    ),
    [
      dispatchPlan.length,
      effectiveSubscriptionIds.length,
      effectiveSubscriptionDetails,
      selectedRegions,
      skippedExistingCount,
      perSubDelaySec,
      dispatchPerSub,
    ],
  );
  // `totalToCreate` is a stable derivation of the same plan and is
  // re-used below in the Submit button label and the dialog confirmText.
  const totalToCreate = dispatchPlan.length;

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
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Configuration
              </CardTitle>
              <CardDescription>
                Choose a subscription and target regions. Each region creates one
                Batch account.
              </CardDescription>
            </div>
            {stepElapsedChip}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Resume-aborted-run banner — surfaced only when a hard
              reload interrupted a previous batch and we still have a
              persisted attemptId in localStorage. The banner is
              actionable (dismiss + jump-to-audit-log) so the operator
              can confirm the partial state before re-submitting. */}
          {resumeHint && resumeHint.attemptId !== attemptId && (
            <Alert variant="warning" className="px-3 py-2 text-xs" role="alert">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              <AlertDescription className="flex flex-wrap items-center gap-2 text-xs leading-relaxed">
                <span>
                  <span className="font-semibold">
                    Previous provisioning run was interrupted.
                  </span>{" "}
                  Completed {resumeHint.completedSubs} of {resumeHint.totalSubs}{" "}
                  subscription{resumeHint.totalSubs === 1 ? "" : "s"} (started{" "}
                  <span className="font-mono">
                    {new Date(resumeHint.attemptStartedAt).toLocaleTimeString()}
                  </span>
                  ). Audit attemptId{" "}
                  <span className="font-mono">
                    {resumeHint.attemptId.slice(0, 8)}…
                  </span>
                  .
                </span>
                <span className="ml-auto inline-flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setResumeHint(null)}
                    aria-label="Dismiss interrupted-run banner"
                  >
                    Dismiss
                  </Button>
                </span>
              </AlertDescription>
            </Alert>
          )}

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
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Pre-flight checks
            </CardTitle>
            <CardDescription>
              Verifies subscription, region capacity, and naming uniqueness before
              submission.
            </CardDescription>
          </div>
          {stepElapsedChip}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <PreflightChips checks={preflight} />

        {/* Copy region list — operator commonly pastes the picked
            regions into a runbook / ticket / Teams thread when handing
            off the batch. Newline-separated rather than comma-separated
            so it pastes cleanly into a checklist. */}
        {selectedRegions.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken/40 px-3 py-2">
            <div className="flex flex-col gap-0.5 text-2xs">
              <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                Picked regions
              </span>
              <span className="text-muted-foreground">
                {selectedRegions.length} region
                {selectedRegions.length === 1 ? "" : "s"} ·{" "}
                <span className="font-mono text-foreground">
                  {selectedRegions.slice(0, 6).join(", ")}
                  {selectedRegions.length > 6 && (
                    <>
                      , <span className="text-muted-foreground">+{selectedRegions.length - 6} more</span>
                    </>
                  )}
                </span>
              </span>
            </div>
            <CopyButton
              value={selectedRegions.join("\n")}
              ariaLabel={`Copy ${selectedRegions.length} region${selectedRegions.length === 1 ? "" : "s"} to clipboard`}
              iconSize={14}
              alwaysVisible
              onCopied={() =>
                auditLog.record({
                  actor: auditActor,
                  action: "provision_accounts.copy_region_list",
                  target: `count:${selectedRegions.length}`,
                  status: "success",
                  details: { regions: selectedRegions },
                })
              }
              className="h-7 w-7 rounded-md border border-border bg-card text-foreground hover:bg-muted"
            />
          </div>
        )}

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
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Review
            </CardTitle>
            <CardDescription>
              Confirm the request below. You can jump back to edit any section.
            </CardDescription>
          </div>
          {stepElapsedChip}
        </div>
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

        {/* Post-creation enumeration preview — defender-side awareness.
            Corpus: NetSPI MicroBurst — `Get-AzBatchAccount` and the
            equivalent `az batch account list` enumerate every Batch
            account in a sub via `Microsoft.Batch/batchAccounts` LIST,
            with Reader-level RBAC. Surfacing this BEFORE the operator
            commits the irreversible PUT means they know exactly what
            an attacker pivoting through the tenant will see post-run. */}
        {enumerationPreview.length > 0 && (
          <details
            className="rounded-md border border-border bg-surface-sunken/40 p-3 text-xs"
            aria-label="Post-creation enumeration preview"
          >
            <summary className="flex cursor-pointer items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
              <Search className="h-3 w-3" aria-hidden />
              Post-creation enumeration preview
              <span className="font-normal normal-case tracking-normal text-muted-foreground/80">
                — what an operator with Reader on these subs will see
              </span>
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
              <p className="m-0 text-2xs text-muted-foreground leading-relaxed">
                After this run completes, every account below is enumerable via{" "}
                <code className="font-mono text-foreground">
                  az batch account list
                </code>{" "}
                or the equivalent{" "}
                <code className="font-mono text-foreground">
                  Microsoft.Batch/batchAccounts
                </code>{" "}
                LIST call with{" "}
                <span className="font-mono text-foreground">Reader</span> RBAC.
                Account-name pattern shown is the orchestrator's template;
                the final name may include a suffix.
              </p>
              <ul className="m-0 flex flex-col gap-0.5 p-0 text-2xs">
                {enumerationPreview.map((row, idx) => (
                  <li
                    key={`${row.subscriptionId}::${row.region}::${idx}`}
                    className="flex flex-wrap items-center gap-2 rounded-sm bg-card/40 px-2 py-1 font-mono"
                  >
                    <span className="text-muted-foreground">sub</span>
                    <span className="text-foreground">
                      {row.subscriptionLabel}
                    </span>
                    <span className="text-muted-foreground">
                      ({row.subscriptionId.slice(0, 8)}…)
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">region</span>
                    <span className="text-foreground">{row.region}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">acct</span>
                    <span className="text-foreground">
                      {row.accountNamePattern}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">rg</span>
                    <span className="text-foreground">
                      {row.resourceGroupPattern}
                    </span>
                  </li>
                ))}
                {dispatchPlan.length > enumerationPreview.length && (
                  <li className="px-2 py-0.5 text-muted-foreground">
                    + {dispatchPlan.length - enumerationPreview.length} more
                  </li>
                )}
              </ul>
            </div>
          </details>
        )}

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

  // ---- Mid-run live per-sub rollup -----------------------------------------
  // Slim derivative of `attemptAccounts` keyed by subscriptionId. Drives the
  // mid-run sparkline so the operator sees per-sub progress while the batch
  // is still moving forward — no need to wait for the result step.
  // Keep this stable on `attemptAccounts` only; selectedRegions / subs
  // are part of `dispatchPerSub` and a re-pick mid-run would already have
  // had a fresh attemptStartedAt.
  const liveSubSummary = React.useMemo(() => {
    const map = new Map<
      string,
      {
        displayName: string;
        created: number;
        failed: number;
        total: number;
        elapsedMs: number;
      }
    >();
    if (!attemptStartedAt) return [];
    const attemptStartMs = Date.parse(attemptStartedAt);
    for (const subId of effectiveSubscriptionIds) {
      const known = state.subscriptions.find(
        (s) => s.subscriptionId === subId,
      );
      // Total for this sub = its dispatch plan size (post-skip),
      // falling back to selectedRegions when the sub isn't in the
      // plan (typed-input fallback path).
      const total =
        dispatchPerSub.get(subId)?.length ?? selectedRegions.length;
      map.set(subId, {
        displayName:
          known?.displayName ??
          (subId ? subId.slice(0, 8) + "…" : "(custom)"),
        created: 0,
        failed: 0,
        total,
        elapsedMs: 0,
      });
    }
    for (const a of attemptAccounts) {
      const entry = map.get(a.subscriptionId);
      if (!entry) continue;
      if (a.provisioningState === "created") entry.created += 1;
      if (a.provisioningState === "failed") entry.failed += 1;
      if (a.createdAt) {
        const ts = Date.parse(a.createdAt);
        if (!Number.isNaN(ts) && ts >= attemptStartMs) {
          entry.elapsedMs = Math.max(entry.elapsedMs, ts - attemptStartMs);
        }
      }
    }
    return Array.from(map.entries()).map(([subscriptionId, v]) => ({
      subscriptionId,
      ...v,
    }));
  }, [
    attemptAccounts,
    attemptStartedAt,
    effectiveSubscriptionIds,
    dispatchPerSub,
    selectedRegions.length,
    state.subscriptions,
  ]);

  // Rolling avg seconds per region across all completed regions in the
  // current attempt — used to render a per-sub ETA badge.
  const rollingAvgPerRegionSec = React.useMemo<number | null>(() => {
    let totalElapsedMs = 0;
    let completedRegions = 0;
    for (const s of liveSubSummary) {
      totalElapsedMs += s.elapsedMs;
      completedRegions += s.created + s.failed;
    }
    if (completedRegions === 0) return null;
    return Math.max(1, Math.round(totalElapsedMs / completedRegions / 1000));
  }, [liveSubSummary]);

  // PerSubSparkline is now declared at module scope (above the
  // component) so it doesn't get re-created on every parent render
  // (parent re-renders at 1Hz while the ticker effect is running —
  // re-declaring the component each tick was thrashing React's
  // reconciliation across the per-sub rollup list).

  const renderSubmit = (): React.ReactNode => (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
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
          </div>
          {stepElapsedChip}
        </div>
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

            {/* Mid-run per-sub sparkline + estimated-time badge. Only
                shown when more than one subscription is in play (single-
                sub runs already get the dispatch-progress card up top).
                The sparkline gives the operator a glance-level read on
                per-sub success/failure without scrolling to the result
                rollup; the ETA badge derives from the rolling avg
                computed above so it converges as more regions complete. */}
            {liveSubSummary.length > 1 && (
              <div
                className="mt-1 flex items-center justify-between gap-2 text-2xs"
                role="group"
                aria-label="Live rollup grouping"
              >
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                  Group by
                </span>
                <div
                  className="inline-flex items-center overflow-hidden rounded-md border border-border bg-card"
                  role="radiogroup"
                  aria-label="Group live rollup by"
                >
                  <button
                    type="button"
                    onClick={() => setLiveGrouping("sub")}
                    aria-pressed={liveGrouping === "sub"}
                    aria-label="Group by subscription"
                    className={cn(
                      "px-2 py-0.5 transition-colors",
                      liveGrouping === "sub"
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-muted/40",
                    )}
                  >
                    Subscription
                  </button>
                  <button
                    type="button"
                    onClick={() => setLiveGrouping("region")}
                    aria-pressed={liveGrouping === "region"}
                    aria-label="Group by region"
                    className={cn(
                      "border-l border-border px-2 py-0.5 transition-colors",
                      liveGrouping === "region"
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-muted/40",
                    )}
                  >
                    Region
                  </button>
                </div>
              </div>
            )}
            {liveSubSummary.length > 1 && liveGrouping === "region" && (
              <ul
                className="mt-1 flex flex-col gap-1"
                aria-label="Per-region live progress"
              >
                {liveRegionSummary.map((r) => {
                  const remaining = Math.max(0, r.total - r.created - r.failed);
                  return (
                    <li
                      key={r.region}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-card/40 px-2 py-1 text-2xs"
                    >
                      <span className="inline-flex items-center gap-2">
                        <span className="font-medium text-foreground">
                          {r.region}
                        </span>
                        {isGpuRegion(r.region) && (
                          <span className="inline-flex items-center rounded-sm bg-primary/15 px-1 font-mono text-2xs text-primary">
                            GPU
                          </span>
                        )}
                        <PerSubSparkline
                          created={r.created}
                          failed={r.failed}
                          total={r.total}
                        />
                      </span>
                      <span className="inline-flex items-center gap-2 tabular-nums text-muted-foreground">
                        <span>
                          <span className="text-success">{r.created}</span>
                          {" / "}
                          <span className="text-foreground">{r.total}</span>
                          {r.failed > 0 && (
                            <>
                              {" · "}
                              <span className="text-destructive">
                                {r.failed} failed
                              </span>
                            </>
                          )}
                        </span>
                        {remaining > 0 && (
                          <span className="text-muted-foreground">
                            {remaining} pending
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {liveSubSummary.length > 1 && liveGrouping === "sub" && (
              <ul
                className="mt-1 flex flex-col gap-1"
                aria-label="Per-subscription live progress"
              >
                {liveSubSummary.map((s) => {
                  const done = s.created + s.failed;
                  const remaining = Math.max(0, s.total - done);
                  const subEtaSec =
                    rollingAvgPerRegionSec !== null && remaining > 0
                      ? rollingAvgPerRegionSec * remaining
                      : null;
                  return (
                    <li
                      key={s.subscriptionId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-card/40 px-2 py-1 text-2xs"
                    >
                      <span className="inline-flex items-center gap-2">
                        <span className="font-medium text-foreground">
                          {s.displayName}
                        </span>
                        <span className="font-mono text-muted-foreground">
                          {s.subscriptionId.slice(0, 8)}…
                        </span>
                        <PerSubSparkline
                          created={s.created}
                          failed={s.failed}
                          total={s.total}
                        />
                      </span>
                      <span className="inline-flex items-center gap-2 tabular-nums text-muted-foreground">
                        <span>
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
                        {subEtaSec !== null && (
                          <span
                            className="inline-flex items-center rounded-full border border-border bg-muted/40 px-1.5 text-2xs text-foreground"
                            title="Estimated remaining time for this subscription, derived from the rolling average across completed regions"
                          >
                            ~{formatEta(subEtaSec)}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
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
    // `perSubSummary` is memoized at component scope above so it
    // doesn't recompute every time the operator triggers a re-render
    // on this step.

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
                  // Also clear the resume hint + attemptId so the next
                  // submit gets a fresh correlation id.
                  setAttemptStartedAt(null);
                  setAttemptId(null);
                  setResumeHint(null);
                  setSubmitError(null);
                  setSubBatchProgress(null);
                  setLastAttemptDurationMs(null);
                  setStep("configure");
                  auditLog.record({
                    actor: auditActor,
                    action: "provision_accounts.new_request",
                    target: "wizard:reset",
                    status: "success",
                    details: { previousAttemptId: attemptId },
                  });
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
                  setAttemptId(null);
                  setResumeHint(null);
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

      {/* ESC-bound cancel-everything confirmation. Only the shortcut
          opens this dialog (the Stop button has its own immediate path),
          so the same destructive action requires either a deliberate
          button click or a confirmed keystroke. */}
      <ConfirmationDialog
        hidden={escCancelHidden}
        title="Cancel in-flight provisioning?"
        message={
          <div className="space-y-2 text-sm leading-relaxed">
            <p className="m-0">
              You pressed{" "}
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-2xs">
                Esc
              </kbd>{" "}
              while a{" "}
              {isRunning && isDiscovering
                ? "provisioning and discovery run"
                : isRunning
                  ? "provisioning run"
                  : "discovery run"}{" "}
              is in flight.
            </p>
            <p className="m-0 text-muted-foreground text-xs">
              Cancelling aborts the inter-subscription wait and signals the
              orchestrator to stop. ARM PUTs already in flight may still
              complete server-side.
            </p>
          </div>
        }
        confirmText="Cancel run"
        cancelText="Keep running"
        danger
        onConfirm={handleEscCancelConfirm}
        onCancel={() => setEscCancelHidden(true)}
      />
    </div>
  );
};

export const AccountProvisioningPage: React.FC<AccountProvisioningPageProps> = (
  props,
) => <AccountProvisioningPageInner {...props} />;
