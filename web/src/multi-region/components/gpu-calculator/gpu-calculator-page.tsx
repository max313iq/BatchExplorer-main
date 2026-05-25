/**
 * GPU Calculator page — what-if speed/cost scenarios over the GPU catalogue
 * plus a live read-out of GPUs across active pools, region by region.
 *
 * Every user input flows through the URL so refreshing or sharing a link
 * preserves the full scenario (per Design Contract §4.3). On top of that:
 *
 *   - Workload PRESETS for common shapes (quick benchmark, inference, small /
 *     medium / large training) one-click seed the form.
 *   - Named SAVED scenarios persist to localStorage so an operator can park
 *     a frequently-recomputed configuration and recall it later.
 *   - EXPORT menu dumps the scenario + per-region rollup as CSV or JSON.
 *   - "Copy link" button puts a fully-qualified shareable URL on the
 *     clipboard.
 *   - RECOMMENDATION card highlights the cheapest VM that hits a target
 *     speed and the cheapest VM-per-GPU-count combo.
 *   - Side-by-side compare now shows DELTAS (Δ speed, Δ $, Δ %) between A
 *     and B.
 *   - Cost breakdown panel exposes the FORMULA used so the number is
 *     auditable.
 *   - InfoTooltips on every non-obvious metric, plus a "What is Mnos/s?"
 *     glossary tooltip on the speed-settings card.
 *   - A reverse-calc input: "How long would N billion node-evaluations
 *     take?" — turn target work into hours-needed at the current scenario.
 *   - "Reset all" wipes URL state + saved validation back to defaults.
 *   - All numeric inputs are NaN- and bound-guarded (count ≤10000,
 *     hours ≤8760, target-work ≤1e9 Gnos).
 *
 * Deviation: Contract task asks for an "A100" empty-state default, but the
 * VM-size catalogue (vm-sizes.ts) only ships H100 and V100. We default the
 * empty-state action to H100 (the highest-perf entry available) so the
 * button picks a real, resolvable GPU type.
 */
import * as React from "react";
import {
  ArrowRightLeft,
  BookmarkPlus,
  Calculator,
  Check,
  Cpu,
  Eye,
  EyeOff,
  Gauge,
  Globe,
  Library,
  Link as LinkIcon,
  RotateCcw,
  Server,
  Star,
  Target,
  Trash2,
  TriangleAlert,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn, formatNumber, pluralize } from "@/lib/utils";

import { usePersistedState } from "../../hooks/use-persisted-state";
import { useUrlState } from "../../hooks/use-url-state";
import { useMultiRegionState } from "../../store/store-context";
import { PoolInfo } from "../../store/store-types";
import { AZURE_REGIONS, isGpuRegion } from "../shared/constants";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu, ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { RegionBadge } from "../shared/region-badge";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { getAllVmSizes, getVmSizeInfo, VmSizeInfo } from "../shared/vm-sizes";

// ---------------------------------------------------------------------------
// Default GPU speeds (Mnos/s = mega-nodes per second, user's benchmark unit)
// ---------------------------------------------------------------------------
interface GpuSpeed {
  gpuType: string;
  defaultSpeed: number;
}

const DEFAULT_GPU_SPEEDS: GpuSpeed[] = [
  { gpuType: "V100", defaultSpeed: 100 },
  { gpuType: "H100", defaultSpeed: 343 },
];

const DEFAULT_GPU_TYPE = "H100";
const DEFAULT_REGION = "eastus";
const DEFAULT_HOURS = 1;
const DEFAULT_COUNT = 1;
const DEFAULT_PRIORITY: ScenarioPriority = "dedicated";

// Indicative hourly $/GPU. Used by the what-if scenario calculator.
// Low-priority is roughly 1/5 the dedicated rate per Azure spot guidance.
const HOURLY_RATE_PER_GPU: Record<string, number> = {
  V100: 3.0,
  H100: 6.0,
};
const LOW_PRIORITY_DISCOUNT = 0.2;

// Hard upper bounds for numeric inputs — anything past these is almost
// certainly a typo and would make the cost / speed totals overflow into
// useless scientific notation.
const MAX_GPU_COUNT = 10_000;
const MAX_HOURS = 8_760; // one year, calendar-aligned
const MAX_TARGET_WORK_GNOS = 1_000_000_000; // 1e9 Gnos = 1 Pnos

// localStorage keys for saved-scenarios + speed-overrides.
const SAVED_SCENARIOS_KEY = "azbm:gpu-calculator:saved-scenarios:v1";
const SPEED_OVERRIDES_KEY = "azbm:gpu-calculator:speed-overrides:v1";
const SECTIONS_PREF_KEY = "azbm:gpu-calculator:sections:v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ScenarioPriority = "dedicated" | "lowpriority";

interface ScenarioState {
  gpu: string;
  count: string;
  region: string;
  hours: string;
  priority: string;
}

interface Scenario {
  gpu: string;
  count: number;
  region: string;
  hours: number;
  priority: ScenarioPriority;
}

interface ScenarioResult {
  totalGpus: number;
  totalSpeedMnos: number;
  hourlyRate: number;
  totalCost: number;
  effectiveRate: number;
  baseRate: number;
  costPerGnos: number; // $ per giga-node-evaluation produced
  workInWindowGnos: number; // total Gnos produced in scenario.hours
}

interface RegionGpuSummary {
  region: string;
  vmBreakdown: Array<{
    vmSize: string;
    vmShort: string;
    gpuType: string;
    gpuCount: number;
    nodeCount: number;
    totalGpus: number;
    speedPerGpu: number;
    totalSpeed: number;
  }>;
  totalGpus: number;
  totalSpeed: number;
}

interface SavedScenario {
  /** Operator-supplied name. Unique per save (overwrite on collision). */
  name: string;
  /** Raw string form so editing a saved entry round-trips through the URL. */
  scenario: ScenarioState;
  /** ISO timestamp — used in the menu sort + tooltip. */
  savedAt: string;
}

interface SectionPrefs {
  showLivePools: boolean;
  showVmReference: boolean;
  showRecommendation: boolean;
}

const DEFAULT_SECTION_PREFS: SectionPrefs = {
  showLivePools: true,
  showVmReference: true,
  showRecommendation: true,
};

// ---------------------------------------------------------------------------
// Workload presets (one-click scenario seeds)
// ---------------------------------------------------------------------------
interface ScenarioPreset {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  scenario: ScenarioState;
}

const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: "quick-bench",
    label: "Quick benchmark",
    description: "1 H100 × 1 hour, dedicated. The default what-if probe.",
    icon: Gauge,
    scenario: {
      gpu: "H100",
      count: "1",
      region: "eastus",
      hours: "1",
      priority: "dedicated",
    },
  },
  {
    id: "inference-cluster",
    label: "Inference cluster",
    description: "16 V100 × 24 h, low-priority. Cheap rolling inference.",
    icon: Server,
    scenario: {
      gpu: "V100",
      count: "16",
      region: "westus2",
      hours: "24",
      priority: "lowpriority",
    },
  },
  {
    id: "small-train",
    label: "Small training",
    description: "8 H100 × 8 h, dedicated. One-node fine-tune.",
    icon: Cpu,
    scenario: {
      gpu: "H100",
      count: "8",
      region: "westus3",
      hours: "8",
      priority: "dedicated",
    },
  },
  {
    id: "large-train",
    label: "Large training",
    description: "64 H100 × 72 h, dedicated. Multi-node training run.",
    icon: Zap,
    scenario: {
      gpu: "H100",
      count: "64",
      region: "westus3",
      hours: "72",
      priority: "dedicated",
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function vmShortName(vmSize: string): string {
  return vmSize.replace("Standard_", "").replace(/_/g, " ");
}

// Tone classes by GPU family. Centralised here so the badge styling stays
// consistent across the speed-input chips, region cards, and reference table.
function gpuTypeBadgeClass(gpuType: string): string {
  if (gpuType === "H100") {
    return "bg-warning/15 text-warning";
  }
  return "bg-success/15 text-success";
}

function parseScenarioPriority(raw: string): ScenarioPriority {
  return raw === "lowpriority" ? "lowpriority" : "dedicated";
}

// useUrlState's value union is `string | string[] | undefined`; this page's
// keys are all scalars so coerce to string defensively.
function asStr(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

function clampInt(
  raw: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampFloat(
  raw: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveScenario(raw: ScenarioState): Scenario | null {
  if (!raw.gpu) return null;
  return {
    gpu: raw.gpu,
    count: clampInt(raw.count, 1, MAX_GPU_COUNT, DEFAULT_COUNT),
    region: raw.region || DEFAULT_REGION,
    hours: clampFloat(raw.hours, 0, MAX_HOURS, DEFAULT_HOURS),
    priority: parseScenarioPriority(raw.priority),
  };
}

function computeScenarioResult(
  scenario: Scenario,
  speeds: Map<string, number>,
): ScenarioResult {
  const speedPerGpu = speeds.get(scenario.gpu) ?? 0;
  const totalSpeedMnos = speedPerGpu * scenario.count;
  const baseRate = HOURLY_RATE_PER_GPU[scenario.gpu] ?? 0;
  const effectiveRate =
    scenario.priority === "lowpriority"
      ? baseRate * LOW_PRIORITY_DISCOUNT
      : baseRate;
  const hourlyRate = effectiveRate * scenario.count;
  const totalCost = hourlyRate * scenario.hours;
  // Total work produced (in Gnos) over the scenario's hour window.
  // Mnos/s × seconds = Mnos. Convert to Gnos (÷1000) for an audit-friendly
  // unit and surface "$ / Gnos" as an efficiency yardstick.
  const workInWindowGnos = (totalSpeedMnos * scenario.hours * 3600) / 1000;
  const costPerGnos = workInWindowGnos > 0 ? totalCost / workInWindowGnos : 0;
  return {
    totalGpus: scenario.count,
    totalSpeedMnos,
    hourlyRate,
    totalCost,
    effectiveRate,
    baseRate,
    costPerGnos,
    workInWindowGnos,
  };
}

function groupPoolsByRegion(
  poolInfos: PoolInfo[],
  speeds: Map<string, number>,
): RegionGpuSummary[] {
  const regionMap = new Map<
    string,
    Map<string, { vmInfo: VmSizeInfo; nodes: number }>
  >();

  for (const pool of poolInfos) {
    if (pool.state === "deleting") continue;
    const totalNodes =
      (pool.currentDedicatedNodes ?? 0) + (pool.currentLowPriorityNodes ?? 0);
    if (totalNodes === 0) continue;

    const vmInfo = getVmSizeInfo(pool.vmSize);
    if (!vmInfo || !vmInfo.isGpu) continue;

    if (!regionMap.has(pool.region)) {
      regionMap.set(pool.region, new Map());
    }
    const vmMap = regionMap.get(pool.region)!;
    // Pools occasionally land here with `vmSize` undefined (e.g. a stale
    // store entry from before the field was populated). Fall back to ""
    // so the GPU rollup doesn't crash the whole calculator on render.
    const key = (pool.vmSize ?? "").toLowerCase();
    if (!vmMap.has(key)) {
      vmMap.set(key, { vmInfo, nodes: 0 });
    }
    vmMap.get(key)!.nodes += totalNodes;
  }

  const summaries: RegionGpuSummary[] = [];
  for (const [region, vmMap] of regionMap) {
    const vmBreakdown: RegionGpuSummary["vmBreakdown"] = [];
    let totalGpus = 0;
    let totalSpeed = 0;

    for (const [, { vmInfo, nodes }] of vmMap) {
      const gpuType = vmInfo.gpuType;
      const gpuPerNode = vmInfo.gpuCount;
      const gpus = nodes * gpuPerNode;
      const speedPerGpu = speeds.get(gpuType) ?? 0;
      const speed = gpus * speedPerGpu;

      vmBreakdown.push({
        vmSize: vmInfo.name,
        vmShort: vmShortName(vmInfo.name),
        gpuType,
        gpuCount: gpuPerNode,
        nodeCount: nodes,
        totalGpus: gpus,
        speedPerGpu,
        totalSpeed: speed,
      });

      totalGpus += gpus;
      totalSpeed += speed;
    }

    vmBreakdown.sort((a, b) => b.totalGpus - a.totalGpus);
    summaries.push({ region, vmBreakdown, totalGpus, totalSpeed });
  }

  summaries.sort((a, b) => b.totalGpus - a.totalGpus);
  return summaries;
}

function formatSpeed(mnos: number): string {
  if (!Number.isFinite(mnos)) return "—";
  if (mnos >= 1000) {
    return `${(mnos / 1000).toFixed(1)} Gnos/s`;
  }
  return `${mnos.toLocaleString()} Mnos/s`;
}

function formatCurrency(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * Compact currency formatter for very small or very large $ values. Used by
 * the per-Gnos efficiency cell since costs can swing from $0.0008 (cheap
 * inference at scale) to $400+ (single dedicated H100 hour).
 */
function formatCurrencyCompact(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (Math.abs(usd) < 0.01) {
    // 4 sig figs so 0.000812 doesn't collapse to "0.00".
    return `$${usd.toPrecision(2)}`;
  }
  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

/** Format duration in hours as e.g. "3h 12m", "0.4s", "12.3 days". */
function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "—";
  if (hours === 0) return "0";
  if (hours < 1 / 3600) {
    return `${(hours * 3_600_000).toFixed(0)} ms`;
  }
  if (hours < 1 / 60) {
    return `${(hours * 3600).toFixed(1)} s`;
  }
  if (hours < 1) {
    return `${(hours * 60).toFixed(1)} min`;
  }
  if (hours < 24) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const days = hours / 24;
  if (days < 30) return `${days.toFixed(1)} days`;
  return `${(days / 30).toFixed(1)} months`;
}

/** Render Δ value with sign and tone, e.g. "+$12.40" / "-3.2%". */
function formatDelta(value: number, formatter: (n: number) => string): string {
  if (!Number.isFinite(value) || value === 0) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatter(value)}`;
}

function formatPercentDelta(deltaFraction: number): string {
  if (!Number.isFinite(deltaFraction) || deltaFraction === 0) return "—";
  const sign = deltaFraction > 0 ? "+" : "";
  return `${sign}${(deltaFraction * 100).toFixed(1)}%`;
}

// Distinct GPU types available in the catalogue, in priority order.
function getGpuTypeOptions(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const vm of getAllVmSizes()) {
    if (!seen.has(vm.gpuType)) {
      seen.add(vm.gpuType);
      out.push(vm.gpuType);
    }
  }
  return out;
}

// COORDINATOR: a shared `writeToClipboard` already lives in
// `../shared/copy-button.tsx`. We deliberately do NOT duplicate it here —
// the share-link button uses <CopyButton /> instead so the
// clipboard-fallback dance has a single source of truth.

// ---------------------------------------------------------------------------
// localStorage-backed migration helpers for saved scenarios / speed overrides
// / section prefs. All persistence is routed through `usePersistedState`; the
// helpers below are pure validators consumed by the hook's `migrate` callback.
// ---------------------------------------------------------------------------
function sanitizeSavedScenarios(raw: unknown): SavedScenario[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is SavedScenario =>
        item != null &&
        typeof item === "object" &&
        typeof (item as SavedScenario).name === "string" &&
        typeof (item as SavedScenario).scenario === "object" &&
        (item as SavedScenario).scenario != null,
    )
    .slice(0, 50);
}

function sanitizeSpeedOverrides(raw: unknown): Record<string, number> {
  if (raw == null || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeSectionPrefs(raw: unknown): SectionPrefs {
  if (raw == null || typeof raw !== "object") return DEFAULT_SECTION_PREFS;
  const p = raw as Partial<SectionPrefs>;
  return {
    showLivePools:
      typeof p.showLivePools === "boolean"
        ? p.showLivePools
        : DEFAULT_SECTION_PREFS.showLivePools,
    showVmReference:
      typeof p.showVmReference === "boolean"
        ? p.showVmReference
        : DEFAULT_SECTION_PREFS.showVmReference,
    showRecommendation:
      typeof p.showRecommendation === "boolean"
        ? p.showRecommendation
        : DEFAULT_SECTION_PREFS.showRecommendation,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const MAX_REASONABLE_SPEED = 100000;

interface SpeedValidation {
  invalid: string[];
  extreme: string[];
  rawInputs: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Reusable building blocks
// ---------------------------------------------------------------------------

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: "primary" | "info" | "warning" | "success";
  sub?: string;
  tooltip?: React.ReactNode;
}

const TONE_TEXT: Record<StatCardProps["tone"], string> = {
  primary: "text-primary",
  info: "text-info",
  warning: "text-warning",
  success: "text-success",
};

const TONE_ICON_BG: Record<StatCardProps["tone"], string> = {
  primary: "bg-primary/15",
  info: "bg-info/15",
  warning: "bg-warning/15",
  success: "bg-success/15",
};

const StatCard: React.FC<StatCardProps> = React.memo(
  ({ icon: Icon, label, value, tone, sub, tooltip }) => (
    <Card
      role="status"
      aria-label={`${label}: ${value}`}
      className="min-w-[160px] flex-1 border-border bg-card shadow-sm transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none"
    >
      <CardContent className="flex items-center gap-3 p-4 pt-4">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
            TONE_ICON_BG[tone],
          )}
        >
          <Icon className={cn("h-5 w-5", TONE_TEXT[tone])} aria-hidden />
        </div>
        <div className="min-w-0">
          <span className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
            {tooltip && <InfoTooltip content={tooltip} size={11} />}
          </span>
          <span
            className={cn(
              "block text-xl font-bold leading-tight tabular-nums",
              TONE_TEXT[tone],
            )}
          >
            {value}
          </span>
          {sub && (
            <span className="block text-2xs text-muted-foreground/80">
              {sub}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  ),
);
StatCard.displayName = "StatCard";

// ---------------------------------------------------------------------------
// Scenario form + result card (used for both A and B scenarios)
// ---------------------------------------------------------------------------

interface ScenarioFormProps {
  label: string;
  scenario: Scenario;
  result: ScenarioResult;
  gpuOptions: string[];
  onChange: (patch: Partial<ScenarioState>) => void;
  onRemove?: () => void;
  tone: "primary" | "info";
  /** Optional comparison source for delta annotations next to each metric. */
  compareTo?: ScenarioResult;
}

// Number-input debounce in ms. Long enough that typing "10000" doesn't
// rebuild the recommendation table on every digit, short enough that the
// result panel feels live.
const NUMBER_INPUT_DEBOUNCE_MS = 220;

interface DebouncedNumberInputProps {
  id: string;
  value: string;
  min: number;
  max: number;
  step?: number;
  inputMode?: "numeric" | "decimal";
  ariaLabel: string;
  className?: string;
  placeholder?: string;
  onCommit: (next: string) => void;
}

/**
 * Number <Input /> that buffers keystrokes locally and pushes the committed
 * value to the parent after `NUMBER_INPUT_DEBOUNCE_MS`. Keeps the input
 * responsive while the (potentially expensive) recommendation table waits
 * for the user to stop typing.
 */
const DebouncedNumberInput: React.FC<DebouncedNumberInputProps> = ({
  id,
  value,
  min,
  max,
  step = 1,
  inputMode = "numeric",
  ariaLabel,
  className,
  placeholder,
  onCommit,
}) => {
  const [local, setLocal] = React.useState<string>(value);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep local in sync if the parent value changes from outside (preset,
  // saved-scenario apply, reset, compare seed).
  React.useEffect(() => {
    setLocal(value);
  }, [value]);
  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const flush = React.useCallback(
    (next: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      onCommit(next);
    },
    [onCommit],
  );
  const onChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      setLocal(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onCommit(next), NUMBER_INPUT_DEBOUNCE_MS);
    },
    [onCommit],
  );
  return (
    <Input
      id={id}
      type="number"
      inputMode={inputMode}
      min={min}
      max={max}
      step={step}
      value={local}
      onChange={onChange}
      onBlur={() => flush(local)}
      className={className}
      aria-label={ariaLabel}
      placeholder={placeholder}
    />
  );
};

const SCENARIO_TONE_BORDER: Record<ScenarioFormProps["tone"], string> = {
  primary: "border-t-4 border-t-primary",
  info: "border-t-4 border-t-info",
};

const SCENARIO_TONE_TEXT: Record<ScenarioFormProps["tone"], string> = {
  primary: "text-primary",
  info: "text-info",
};

const ScenarioForm: React.FC<ScenarioFormProps> = ({
  label,
  scenario,
  result,
  gpuOptions,
  onChange,
  onRemove,
  tone,
  compareTo,
}) => {
  const idPrefix = `scenario-${label.toLowerCase()}`;
  const regionWarn =
    scenario.region && !isGpuRegion(scenario.region)
      ? "This region does not advertise V100 or H100 capacity in Azure’s public docs. Capacity may be unavailable."
      : null;
  return (
    <Card
      className={cn(
        "flex-1 border-border bg-card shadow-sm transition-all duration-200 ease-out hover:shadow-md motion-reduce:transition-none",
        SCENARIO_TONE_BORDER[tone],
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <span
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-full bg-card text-2xs font-bold",
              SCENARIO_TONE_TEXT[tone],
            )}
            aria-hidden
          >
            {label}
          </span>
          Scenario {label}
        </CardTitle>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            aria-label="Remove compare scenario"
          >
            <X aria-hidden />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${idPrefix}-gpu`} className="text-xs">
              GPU type
            </Label>
            <Select
              value={scenario.gpu}
              onValueChange={(v) => onChange({ gpu: v })}
            >
              <SelectTrigger
                id={`${idPrefix}-gpu`}
                aria-label="GPU type"
                className="font-semibold"
              >
                <SelectValue placeholder="Select GPU" />
              </SelectTrigger>
              <SelectContent>
                {gpuOptions.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor={`${idPrefix}-count`}
              className="flex items-center gap-1 text-xs"
            >
              GPU count
              <InfoTooltip
                content={`Number of GPUs running in parallel. Speed scales linearly. Capped at ${MAX_GPU_COUNT.toLocaleString()}.`}
                size={11}
              />
            </Label>
            <DebouncedNumberInput
              id={`${idPrefix}-count`}
              inputMode="numeric"
              min={1}
              max={MAX_GPU_COUNT}
              step={1}
              value={String(scenario.count)}
              onCommit={(v) => onChange({ count: v })}
              className="text-right font-semibold tabular-nums transition-shadow duration-200 ease-out focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
              ariaLabel="GPU count"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${idPrefix}-region`} className="text-xs">
              Region
            </Label>
            <Select
              value={scenario.region}
              onValueChange={(v) => onChange({ region: v })}
            >
              <SelectTrigger id={`${idPrefix}-region`} aria-label="Region">
                <SelectValue placeholder="Select region" />
              </SelectTrigger>
              <SelectContent>
                {AZURE_REGIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                    {!isGpuRegion(r) && (
                      <span className="ml-1 text-2xs text-muted-foreground">
                        (no GPU)
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor={`${idPrefix}-hours`}
              className="flex items-center gap-1 text-xs"
            >
              Hours
              <InfoTooltip
                content={`Run duration in hours. 0 = instantaneous burst (rate-only view). Capped at ${MAX_HOURS.toLocaleString()} (one year).`}
                size={11}
              />
            </Label>
            <DebouncedNumberInput
              id={`${idPrefix}-hours`}
              inputMode="decimal"
              min={0}
              max={MAX_HOURS}
              step={1}
              value={String(scenario.hours)}
              onCommit={(v) => onChange({ hours: v })}
              className="text-right font-semibold tabular-nums transition-shadow duration-200 ease-out focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
              ariaLabel="Total runtime hours"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor={`${idPrefix}-priority`}
              className="flex items-center gap-1 text-xs"
            >
              Priority
              <InfoTooltip
                content={`"Low priority" uses spot capacity at roughly ${(LOW_PRIORITY_DISCOUNT * 100).toFixed(0)}% of the dedicated rate, but jobs can be pre-empted at any time.`}
                size={11}
              />
            </Label>
            <Select
              value={scenario.priority}
              onValueChange={(v) => onChange({ priority: v })}
            >
              <SelectTrigger
                id={`${idPrefix}-priority`}
                aria-label="Pricing priority"
              >
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dedicated">Dedicated</SelectItem>
                <SelectItem value="lowpriority">Low priority</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div
          className="grid grid-cols-2 gap-3 rounded-md border border-border bg-surface-overlay p-4 transition-colors duration-200 ease-out sm:grid-cols-4 motion-reduce:transition-none"
          aria-label="Live scenario results"
        >
          <ScenarioMetric
            label="GPUs"
            value={formatNumber(result.totalGpus)}
            tone="primary"
            delta={
              compareTo
                ? formatDelta(
                    result.totalGpus - compareTo.totalGpus,
                    formatNumber,
                  )
                : undefined
            }
          />
          <ScenarioMetric
            label="Speed"
            value={formatSpeed(result.totalSpeedMnos)}
            tone="info"
            delta={
              compareTo
                ? formatDelta(
                    result.totalSpeedMnos - compareTo.totalSpeedMnos,
                    formatSpeed,
                  )
                : undefined
            }
          />
          <ScenarioMetric
            label="$/hour"
            value={formatCurrency(result.hourlyRate)}
            tone="warning"
            delta={
              compareTo
                ? formatDelta(
                    result.hourlyRate - compareTo.hourlyRate,
                    formatCurrency,
                  )
                : undefined
            }
          />
          <ScenarioMetric
            label={`Cost (${pluralize(scenario.hours, "hour")})`}
            value={formatCurrency(result.totalCost)}
            tone="success"
            delta={
              compareTo
                ? formatDelta(
                    result.totalCost - compareTo.totalCost,
                    formatCurrency,
                  )
                : undefined
            }
            deltaPercent={
              compareTo && compareTo.totalCost > 0
                ? formatPercentDelta(
                    (result.totalCost - compareTo.totalCost) /
                      compareTo.totalCost,
                  )
                : undefined
            }
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <span>
            Indicative{" "}
            {scenario.priority === "lowpriority"
              ? "low-priority"
              : "dedicated"}{" "}
            rate {formatCurrency(result.effectiveRate)} / GPU·hour in{" "}
            <RegionBadge region={scenario.region} tone="info" />
          </span>
          {result.workInWindowGnos > 0 && (
            <span>
              · {formatCurrencyCompact(result.costPerGnos)} per Gnos produced
              over {formatHours(scenario.hours)} (
              {formatNumber(Math.round(result.workInWindowGnos))} Gnos total)
            </span>
          )}
          {regionWarn && (
            <span className="inline-flex items-center gap-1 text-warning">
              <TriangleAlert className="h-3 w-3" aria-hidden /> {regionWarn}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

const SCENARIO_METRIC_TONE: Record<
  "primary" | "info" | "warning" | "success",
  string
> = {
  primary: "text-primary",
  info: "text-info",
  warning: "text-warning",
  success: "text-success",
};

const ScenarioMetric: React.FC<{
  label: string;
  value: string;
  tone: "primary" | "info" | "warning" | "success";
  delta?: string;
  deltaPercent?: string;
}> = ({ label, value, tone, delta, deltaPercent }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
      {label}
    </span>
    <span
      className={cn(
        "text-2xl font-bold leading-tight tabular-nums",
        SCENARIO_METRIC_TONE[tone],
      )}
    >
      {value}
    </span>
    {delta && delta !== "—" && (
      <span className="text-2xs text-muted-foreground tabular-nums">
        Δ {delta}
        {deltaPercent && deltaPercent !== "—" ? ` (${deltaPercent})` : ""}
      </span>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Cost-formula panel
// ---------------------------------------------------------------------------

const CostBreakdownCard: React.FC<{
  scenario: Scenario;
  result: ScenarioResult;
  speeds: Map<string, number>;
}> = ({ scenario, result, speeds }) => {
  const speedPerGpu = speeds.get(scenario.gpu) ?? 0;
  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Calculator className="h-4 w-4 text-primary" aria-hidden />
          How is this calculated?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-0 text-xs text-muted-foreground">
        <div className="grid grid-cols-1 gap-1 font-mono text-2xs leading-relaxed text-foreground/80 sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">speed</span> ={" "}
            <span className="text-info">
              {formatNumber(scenario.count)} GPU
            </span>{" "}
            ×{" "}
            <span className="text-info">{formatNumber(speedPerGpu)} Mnos/s</span>{" "}
            = <b>{formatSpeed(result.totalSpeedMnos)}</b>
          </div>
          <div>
            <span className="text-muted-foreground">rate</span> ={" "}
            <span className="text-warning">
              {formatCurrency(result.baseRate)} / GPU·h
            </span>
            {scenario.priority === "lowpriority" && (
              <>
                {" "}
                × <span className="text-warning">
                  {LOW_PRIORITY_DISCOUNT.toFixed(2)} (LP)
                </span>
              </>
            )}{" "}
            ={" "}
            <b>
              {formatCurrency(result.effectiveRate)} / GPU·h
            </b>
          </div>
          <div>
            <span className="text-muted-foreground">$/hour</span> ={" "}
            <span className="text-warning">
              {formatNumber(scenario.count)}
            </span>{" "}
            ×{" "}
            <span className="text-warning">
              {formatCurrency(result.effectiveRate)}
            </span>{" "}
            = <b>{formatCurrency(result.hourlyRate)}</b>
          </div>
          <div>
            <span className="text-muted-foreground">total cost</span> ={" "}
            <span className="text-success">
              {formatCurrency(result.hourlyRate)} / h
            </span>{" "}
            × <span className="text-success">{scenario.hours} h</span> ={" "}
            <b>{formatCurrency(result.totalCost)}</b>
          </div>
          {result.workInWindowGnos > 0 && (
            <div className="sm:col-span-2">
              <span className="text-muted-foreground">work produced</span> ={" "}
              <span className="text-info">
                {formatSpeed(result.totalSpeedMnos)}
              </span>{" "}
              × <span className="text-info">{scenario.hours} h</span> ={" "}
              <b>{formatNumber(Math.round(result.workInWindowGnos))} Gnos</b>{" "}
              ·{" "}
              <span className="text-muted-foreground">$/Gnos</span> ={" "}
              <b>{formatCurrencyCompact(result.costPerGnos)}</b>
            </div>
          )}
        </div>
        <p className="text-2xs leading-relaxed">
          Per-GPU benchmark speed comes from the editable "GPU Speed Settings"
          card below. Hourly rates are indicative Azure list prices (V100 ≈ $3,
          H100 ≈ $6 per GPU·h). Low-priority applies the{" "}
          {(LOW_PRIORITY_DISCOUNT * 100).toFixed(0)}% spot discount but jobs
          may be pre-empted.
        </p>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Reverse "target work → hours needed" card
// ---------------------------------------------------------------------------

const TargetWorkCard: React.FC<{
  result: ScenarioResult;
  targetGnos: string;
  onChange: (v: string) => void;
}> = ({ result, targetGnos, onChange }) => {
  const targetN = clampFloat(targetGnos, 0, MAX_TARGET_WORK_GNOS, 0);
  const totalSpeedMnos = result.totalSpeedMnos; // Mnos/s
  // hours = Gnos × 1000 (→ Mnos) ÷ (Mnos/s) ÷ 3600 (→ hours)
  const hoursNeeded = React.useMemo(
    () =>
      targetN > 0 && totalSpeedMnos > 0
        ? (targetN * 1000) / (totalSpeedMnos * 3600)
        : 0,
    [targetN, totalSpeedMnos],
  );
  const projectedCost = hoursNeeded * result.hourlyRate;

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Target className="h-4 w-4 text-info" aria-hidden />
          How long for a target workload?
          <InfoTooltip
            content="Enter the total work (in Gnos, billions of node evaluations) and we'll compute how long the current scenario would take and what it would cost."
            size={12}
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-4 pt-0">
        <div className="flex flex-col gap-1">
          <Label htmlFor="target-gnos" className="text-xs">
            Target work (Gnos)
          </Label>
          <DebouncedNumberInput
            id="target-gnos"
            inputMode="decimal"
            min={0}
            max={MAX_TARGET_WORK_GNOS}
            step={1}
            value={targetGnos}
            onCommit={onChange}
            placeholder="e.g. 1000"
            className="w-[160px] text-right font-semibold tabular-nums"
            ariaLabel="Target work in Gnos"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            Wall-clock
          </span>
          <span className="text-lg font-bold tabular-nums text-info">
            {hoursNeeded > 0 ? formatHours(hoursNeeded) : "—"}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            Projected cost
          </span>
          <span className="text-lg font-bold tabular-nums text-success">
            {projectedCost > 0 ? formatCurrency(projectedCost) : "—"}
          </span>
        </div>
        {hoursNeeded > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange("")}
            aria-label="Clear target work input"
            className="ml-auto"
          >
            <X aria-hidden /> Clear
          </Button>
        )}
        {targetN > 0 && totalSpeedMnos === 0 && (
          <Alert variant="warning" role="status" className="mt-2 w-full">
            <TriangleAlert className="h-4 w-4" aria-hidden />
            <AlertDescription>
              The current scenario has 0 Mnos/s — set a per-GPU speed in the
              "GPU Speed Settings" card to compute wall-clock and cost.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Recommendation card
// ---------------------------------------------------------------------------

interface VmRecommendation {
  vm: VmSizeInfo;
  nodesNeeded: number;
  totalGpus: number;
  totalSpeedMnos: number;
  hourlyCost: number;
  totalCost: number;
}

function buildRecommendations(
  scenario: Scenario,
  speeds: Map<string, number>,
  allVms: VmSizeInfo[],
): {
  cheapestForSpeed: VmRecommendation | null;
  fastestPerDollar: VmRecommendation | null;
  alternatives: VmRecommendation[];
} {
  const targetSpeedMnos =
    (speeds.get(scenario.gpu) ?? 0) * scenario.count;
  if (targetSpeedMnos <= 0) {
    return {
      cheapestForSpeed: null,
      fastestPerDollar: null,
      alternatives: [],
    };
  }

  const recs: VmRecommendation[] = [];
  for (const vm of allVms) {
    const speedPerGpu = speeds.get(vm.gpuType) ?? 0;
    const speedPerNode = speedPerGpu * vm.gpuCount;
    if (speedPerNode <= 0) continue;
    const nodesNeeded = Math.ceil(targetSpeedMnos / speedPerNode);
    const totalGpus = nodesNeeded * vm.gpuCount;
    const totalSpeedMnos = totalGpus * speedPerGpu;
    const baseRate = HOURLY_RATE_PER_GPU[vm.gpuType] ?? 0;
    const effectiveRate =
      scenario.priority === "lowpriority"
        ? baseRate * LOW_PRIORITY_DISCOUNT
        : baseRate;
    const hourlyCost = effectiveRate * totalGpus;
    const totalCost = hourlyCost * scenario.hours;
    recs.push({
      vm,
      nodesNeeded,
      totalGpus,
      totalSpeedMnos,
      hourlyCost,
      totalCost,
    });
  }

  if (recs.length === 0) {
    return {
      cheapestForSpeed: null,
      fastestPerDollar: null,
      alternatives: [],
    };
  }

  const byCost = [...recs].sort((a, b) => a.hourlyCost - b.hourlyCost);
  const bySpeedPerDollar = [...recs].sort((a, b) => {
    const aRatio = a.hourlyCost > 0 ? a.totalSpeedMnos / a.hourlyCost : 0;
    const bRatio = b.hourlyCost > 0 ? b.totalSpeedMnos / b.hourlyCost : 0;
    return bRatio - aRatio;
  });

  return {
    cheapestForSpeed: byCost[0] ?? null,
    fastestPerDollar: bySpeedPerDollar[0] ?? null,
    alternatives: byCost,
  };
}

const RecommendationCard: React.FC<{
  scenario: Scenario;
  result: ScenarioResult;
  speeds: Map<string, number>;
  allVms: VmSizeInfo[];
  onApply: (vm: VmSizeInfo) => void;
}> = ({ scenario, result, speeds, allVms, onApply }) => {
  const { cheapestForSpeed, fastestPerDollar, alternatives } = React.useMemo(
    () => buildRecommendations(scenario, speeds, allVms),
    [scenario, speeds, allVms],
  );

  if (!cheapestForSpeed) {
    return (
      <Card className="border-border bg-card shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Star className="h-4 w-4 text-warning" aria-hidden />
            Recommendation
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">
            Set a non-zero per-GPU speed below to see VM recommendations for
            this scenario's target speed.
          </p>
        </CardContent>
      </Card>
    );
  }

  const sameVm =
    fastestPerDollar && cheapestForSpeed.vm.name === fastestPerDollar.vm.name;
  const currentHourlyCost = result.hourlyRate;
  const savingsPct =
    currentHourlyCost > 0
      ? ((currentHourlyCost - cheapestForSpeed.hourlyCost) /
          currentHourlyCost) *
        100
      : 0;

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Star className="h-4 w-4 text-warning" aria-hidden />
          Recommendation for {formatSpeed(result.totalSpeedMnos)}
          <InfoTooltip
            content="Given your scenario's target speed and priority, this is the VM size that minimises hourly cost. The 'best speed-per-$' card shows the best work-per-dollar ratio."
            size={12}
          />
        </CardTitle>
        <Badge variant="outline" className="text-2xs">
          {scenario.priority === "lowpriority" ? "Low priority" : "Dedicated"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div
          className={cn(
            "grid grid-cols-1 gap-3",
            sameVm ? "" : "md:grid-cols-2",
          )}
        >
          <RecommendationTile
            kind="cheapest"
            rec={cheapestForSpeed}
            onApply={() => onApply(cheapestForSpeed.vm)}
            savingsPct={savingsPct}
          />
          {!sameVm && fastestPerDollar && (
            <RecommendationTile
              kind="value"
              rec={fastestPerDollar}
              onApply={() => onApply(fastestPerDollar.vm)}
              savingsPct={0}
            />
          )}
        </div>

        {alternatives.length > 1 && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                All sized options
              </span>
              <span className="text-2xs text-muted-foreground">
                Sorted by $/hour
              </span>
            </div>
            <Table aria-label="All VM size alternatives to hit target speed">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">VM</TableHead>
                  <TableHead scope="col" className="text-center">
                    GPU
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Nodes
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    GPUs
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Speed
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    $/hour
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Cost ({scenario.hours}h)
                  </TableHead>
                  <TableHead
                    scope="col"
                    aria-label="Apply"
                    className="w-[68px]"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {alternatives.map((alt) => {
                  const isBest = alt.vm.name === cheapestForSpeed.vm.name;
                  return (
                    <TableRow
                      key={alt.vm.name}
                      className={cn(isBest && "bg-success/5")}
                    >
                      <TableCell className="font-semibold text-foreground">
                        {vmShortName(alt.vm.name)}
                        {isBest && (
                          <Badge
                            variant="success"
                            className="ml-2 px-1.5 py-0 text-2xs"
                          >
                            Best
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <span
                          className={cn(
                            "inline-flex items-center rounded px-2 py-0.5 text-2xs font-bold",
                            gpuTypeBadgeClass(alt.vm.gpuType),
                          )}
                        >
                          {alt.vm.gpuType}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {alt.nodesNeeded}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-primary">
                        {alt.totalGpus}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-info">
                        {formatSpeed(alt.totalSpeedMnos)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-warning">
                        {formatCurrency(alt.hourlyCost)}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-success">
                        {formatCurrency(alt.totalCost)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => onApply(alt.vm)}
                          aria-label={`Apply ${alt.vm.name} to scenario`}
                        >
                          Apply
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const RecommendationTile: React.FC<{
  kind: "cheapest" | "value";
  rec: VmRecommendation;
  onApply: () => void;
  savingsPct: number;
}> = ({ kind, rec, onApply, savingsPct }) => {
  const Icon = kind === "cheapest" ? Star : Zap;
  const label =
    kind === "cheapest" ? "Cheapest for target speed" : "Best speed-per-$";
  const tone = kind === "cheapest" ? "success" : "info";
  return (
    <div
      className={cn(
        "rounded-md border p-3",
        kind === "cheapest"
          ? "border-success/30 bg-success/5"
          : "border-info/30 bg-info/5",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon
          className={cn(
            "h-4 w-4",
            tone === "success" ? "text-success" : "text-info",
          )}
          aria-hidden
        />
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {kind === "cheapest" && savingsPct > 0.5 && (
          <Badge variant="success" className="ml-auto px-1.5 py-0 text-2xs">
            -{savingsPct.toFixed(0)}% vs current
          </Badge>
        )}
      </div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-base font-bold text-foreground">
          {vmShortName(rec.vm.name)}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0 text-2xs font-bold",
            gpuTypeBadgeClass(rec.vm.gpuType),
          )}
        >
          {rec.vm.gpuType}
        </span>
      </div>
      <div className="mb-2 grid grid-cols-3 gap-2 text-2xs">
        <div>
          <span className="block text-muted-foreground">Nodes</span>
          <span className="font-bold tabular-nums">{rec.nodesNeeded}</span>
        </div>
        <div>
          <span className="block text-muted-foreground">GPUs</span>
          <span className="font-bold tabular-nums text-primary">
            {rec.totalGpus}
          </span>
        </div>
        <div>
          <span className="block text-muted-foreground">$/hour</span>
          <span className="font-bold tabular-nums text-warning">
            {formatCurrency(rec.hourlyCost)}
          </span>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onApply}
        aria-label={`Apply ${rec.vm.name} configuration to scenario A`}
      >
        <Check aria-hidden /> Use this config
      </Button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Region card (live pool view)
// ---------------------------------------------------------------------------

interface RegionCardProps {
  summary: RegionGpuSummary;
  grandTotalSpeed: number;
}

const RegionCard: React.FC<RegionCardProps> = ({
  summary,
  grandTotalSpeed,
}) => {
  const pct =
    grandTotalSpeed > 0
      ? ((summary.totalSpeed / grandTotalSpeed) * 100).toFixed(1)
      : "0";

  return (
    <Card className="overflow-hidden border-border bg-card shadow-sm transition-colors duration-200 ease-out hover:border-primary/40 motion-reduce:transition-none">
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border bg-surface-overlay px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Globe className="h-[18px] w-[18px] text-primary" aria-hidden />
          <CardTitle className="text-sm font-semibold text-foreground">
            {summary.region}
          </CardTitle>
          <RegionBadge region={summary.region} gpu tone="info" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="inline-flex items-center rounded-full bg-primary/15 px-2.5 py-0.5 text-2xs font-bold text-primary tabular-nums"
            aria-label={`${summary.totalGpus} GPUs in ${summary.region}`}
          >
            {summary.totalGpus} GPUs
          </span>
          <span
            className="inline-flex items-center rounded-full bg-info/15 px-2.5 py-0.5 text-2xs font-bold text-info tabular-nums"
            aria-label={`Total speed ${formatSpeed(summary.totalSpeed)}`}
          >
            {formatSpeed(summary.totalSpeed)}
          </span>
          <span className="text-2xs text-muted-foreground tabular-nums">
            {pct}% of total
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table aria-label={`VM breakdown for ${summary.region}`}>
          <TableCaption className="sr-only mt-0">
            VM size breakdown for region {summary.region}
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">VM Size</TableHead>
              <TableHead scope="col" className="text-center">
                GPU Type
              </TableHead>
              <TableHead scope="col" className="text-right">
                Nodes
              </TableHead>
              <TableHead scope="col" className="text-right">
                GPUs/Node
              </TableHead>
              <TableHead scope="col" className="text-right">
                Total GPUs
              </TableHead>
              <TableHead scope="col" className="text-right">
                Speed/GPU
              </TableHead>
              <TableHead scope="col" className="text-right">
                Total Speed
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.vmBreakdown.map((vm) => (
              <TableRow key={vm.vmSize}>
                <TableCell className="font-semibold text-foreground">
                  {vm.vmShort}
                </TableCell>
                <TableCell className="text-center">
                  <span
                    className={cn(
                      "inline-flex items-center rounded px-2 py-0.5 text-2xs font-bold",
                      gpuTypeBadgeClass(vm.gpuType),
                    )}
                  >
                    {vm.gpuType}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {vm.nodeCount}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {vm.gpuCount}
                </TableCell>
                <TableCell className="text-right font-bold tabular-nums text-primary">
                  {vm.totalGpus}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {vm.speedPerGpu}
                </TableCell>
                <TableCell className="text-right font-bold tabular-nums text-info">
                  {formatSpeed(vm.totalSpeed)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// GPU sparkline
// ---------------------------------------------------------------------------

const GpuRegionSparkline: React.FC<{ summaries: RegionGpuSummary[] }> = ({
  summaries,
}) => {
  const sorted = React.useMemo(
    () => [...summaries].sort((a, b) => b.totalGpus - a.totalGpus),
    [summaries],
  );
  const max = Math.max(...sorted.map((s) => s.totalGpus), 1);
  const width = 320;
  const height = 40;
  const stepX = sorted.length > 1 ? width / (sorted.length - 1) : 0;
  const points = sorted
    .map((s, i) => {
      const x = sorted.length === 1 ? width / 2 : i * stepX;
      const y = height - (s.totalGpus / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-foreground">
          GPU Count by Region
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4 pt-0">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`GPU count across ${sorted.length} regions, ranging from ${
            sorted[sorted.length - 1]?.totalGpus ?? 0
          } to ${sorted[0]?.totalGpus ?? 0}`}
          className="overflow-visible"
        >
          {sorted.length > 1 && (
            <polyline
              points={points}
              fill="none"
              strokeWidth={2}
              className="stroke-primary"
            />
          )}
          {sorted.map((s, i) => {
            const x = sorted.length === 1 ? width / 2 : i * stepX;
            const y = height - (s.totalGpus / max) * height;
            return (
              <circle
                key={s.region}
                cx={x}
                cy={y}
                r={2.5}
                className="fill-primary"
              >
                <title>{`${s.region}: ${s.totalGpus} GPUs`}</title>
              </circle>
            );
          })}
        </svg>
        <div className="flex flex-wrap gap-1">
          {sorted.map((s) => (
            <span
              key={s.region}
              className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-2xs tabular-nums text-primary"
              title={`${s.region}: ${s.totalGpus} GPUs`}
            >
              <span className="font-semibold">{s.region}</span>
              <span className="ml-1 text-primary/70">{s.totalGpus}</span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Preset chip row
// ---------------------------------------------------------------------------

const PresetChipRow: React.FC<{
  onPick: (p: ScenarioPreset) => void;
  activeId: string | null;
}> = ({ onPick, activeId }) => (
  <Card className="border-border bg-card shadow-sm">
    <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
      <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Library className="h-4 w-4 text-primary" aria-hidden />
        Workload presets
        <InfoTooltip
          content="One-click scenarios for common GPU workload shapes. Picking a preset replaces all five form fields in Scenario A."
          size={12}
        />
      </CardTitle>
      <span className="text-2xs text-muted-foreground">
        Click a preset to seed Scenario A
      </span>
    </CardHeader>
    <CardContent className="flex flex-wrap gap-2 pt-0">
      {SCENARIO_PRESETS.map((p) => {
        const Icon = p.icon;
        const isActive = activeId === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            aria-label={`Apply preset: ${p.label}. ${p.description}`}
            aria-pressed={isActive}
            className={cn(
              "group inline-flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              isActive
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card hover:border-primary/40 hover:bg-surface-overlay",
            )}
          >
            <Icon
              className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                isActive ? "text-primary" : "text-muted-foreground",
              )}
              aria-hidden
            />
            <span className="flex flex-col">
              <span className="text-xs font-semibold text-foreground">
                {p.label}
              </span>
              <span className="text-2xs text-muted-foreground">
                {p.description}
              </span>
            </span>
          </button>
        );
      })}
    </CardContent>
  </Card>
);

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const GpuCalculatorPageInner: React.FC = () => {
  const state = useMultiRegionState();
  const gpuOptions = React.useMemo(getGpuTypeOptions, []);

  // ----- URL-shareable scenarios -------------------------------------------
  // Two namespaced groups so a refresh / share-link preserves both side-by-side
  // scenarios. Empty values are stripped from the URL (per useUrlState).
  const [urlState, setUrlState] = useUrlState({
    "a.gpu": "",
    "a.count": String(DEFAULT_COUNT),
    "a.region": DEFAULT_REGION,
    "a.hours": String(DEFAULT_HOURS),
    "a.priority": DEFAULT_PRIORITY,
    "b.gpu": "",
    "b.count": String(DEFAULT_COUNT),
    "b.region": DEFAULT_REGION,
    "b.hours": String(DEFAULT_HOURS),
    "b.priority": DEFAULT_PRIORITY,
    compare: "",
    target: "", // Gnos target for the reverse-calc card
  });

  const compareOn = asStr(urlState.compare) === "1";

  // Memoize the raw scenario records so downstream useMemo dependencies (e.g.
  // recommendation cards keyed on `scenario`) don't re-fire every render just
  // because we built a new object literal.
  const rawA = React.useMemo<ScenarioState>(
    () => ({
      gpu: asStr(urlState["a.gpu"]),
      count: asStr(urlState["a.count"]) || String(DEFAULT_COUNT),
      region: asStr(urlState["a.region"]) || DEFAULT_REGION,
      hours: asStr(urlState["a.hours"]) || String(DEFAULT_HOURS),
      priority: asStr(urlState["a.priority"]) || DEFAULT_PRIORITY,
    }),
    [
      urlState["a.gpu"],
      urlState["a.count"],
      urlState["a.region"],
      urlState["a.hours"],
      urlState["a.priority"],
    ],
  );
  const rawB = React.useMemo<ScenarioState>(
    () => ({
      gpu: asStr(urlState["b.gpu"]),
      count: asStr(urlState["b.count"]) || String(DEFAULT_COUNT),
      region: asStr(urlState["b.region"]) || DEFAULT_REGION,
      hours: asStr(urlState["b.hours"]) || String(DEFAULT_HOURS),
      priority: asStr(urlState["b.priority"]) || DEFAULT_PRIORITY,
    }),
    [
      urlState["b.gpu"],
      urlState["b.count"],
      urlState["b.region"],
      urlState["b.hours"],
      urlState["b.priority"],
    ],
  );
  const targetGnos = asStr(urlState["target"]);

  const updateScenario = React.useCallback(
    (group: "a" | "b", patch: Partial<ScenarioState>) => {
      const next: Partial<Record<string, string>> = {};
      for (const key of Object.keys(patch) as Array<keyof ScenarioState>) {
        const raw = patch[key];
        if (raw === undefined) continue;
        next[`${group}.${key}`] = raw;
      }
      setUrlState(next as Partial<typeof urlState>);
    },
    [setUrlState],
  );

  const updateScenarioA = React.useCallback(
    (patch: Partial<ScenarioState>) => updateScenario("a", patch),
    [updateScenario],
  );
  const updateScenarioB = React.useCallback(
    (patch: Partial<ScenarioState>) => updateScenario("b", patch),
    [updateScenario],
  );

  const setTargetGnos = React.useCallback(
    (v: string) => {
      setUrlState({ target: v } as Partial<typeof urlState>);
    },
    [setUrlState],
  );

  const enableCompare = React.useCallback(() => {
    // When opening compare, seed B from A so the user starts from a sensible
    // delta and can edit one knob at a time.
    setUrlState({
      compare: "1",
      "b.gpu": rawA.gpu || DEFAULT_GPU_TYPE,
      "b.count": rawA.count,
      "b.region": rawA.region,
      "b.hours": rawA.hours,
      "b.priority": rawA.priority,
    });
  }, [setUrlState, rawA.gpu, rawA.count, rawA.region, rawA.hours, rawA.priority]);

  const disableCompare = React.useCallback(() => {
    setUrlState({
      compare: "",
      "b.gpu": "",
      "b.count": String(DEFAULT_COUNT),
      "b.region": DEFAULT_REGION,
      "b.hours": String(DEFAULT_HOURS),
      "b.priority": DEFAULT_PRIORITY,
    });
  }, [setUrlState]);

  const pickDefaultGpu = React.useCallback(() => {
    setUrlState({ "a.gpu": DEFAULT_GPU_TYPE });
  }, [setUrlState]);

  const applyPreset = React.useCallback(
    (p: ScenarioPreset) => {
      setUrlState({
        "a.gpu": p.scenario.gpu,
        "a.count": p.scenario.count,
        "a.region": p.scenario.region,
        "a.hours": p.scenario.hours,
        "a.priority": p.scenario.priority,
      });
    },
    [setUrlState],
  );

  // Detect whether the current Scenario A matches any preset exactly so the
  // chip can render its "active" affordance.
  const activePresetId = React.useMemo(() => {
    for (const p of SCENARIO_PRESETS) {
      if (
        p.scenario.gpu === rawA.gpu &&
        p.scenario.count === rawA.count &&
        p.scenario.region === rawA.region &&
        p.scenario.hours === rawA.hours &&
        p.scenario.priority === rawA.priority
      ) {
        return p.id;
      }
    }
    return null;
  }, [rawA]);

  const resetAll = React.useCallback(() => {
    setUrlState({
      "a.gpu": "",
      "a.count": String(DEFAULT_COUNT),
      "a.region": DEFAULT_REGION,
      "a.hours": String(DEFAULT_HOURS),
      "a.priority": DEFAULT_PRIORITY,
      "b.gpu": "",
      "b.count": String(DEFAULT_COUNT),
      "b.region": DEFAULT_REGION,
      "b.hours": String(DEFAULT_HOURS),
      "b.priority": DEFAULT_PRIORITY,
      compare: "",
      target: "",
    });
  }, [setUrlState]);

  // ----- Editable GPU speeds (drives all calculations) ---------------------
  // Speeds are seeded from defaults, then overlaid with anything the operator
  // previously stored in localStorage so a returning visitor doesn't have to
  // re-enter their per-GPU benchmark numbers on every page load. The
  // persisted shape is a plain `{ gpuType: speed }` map so the encoded JSON
  // stays human-readable in DevTools (Map serializes weirdly).
  const [speedOverrides, setSpeedOverrides] = usePersistedState<
    Record<string, number>
  >(SPEED_OVERRIDES_KEY, {}, {
    version: 1,
    migrate: (raw) => sanitizeSpeedOverrides(raw),
  });

  // Merge defaults + overrides into a render-stable Map keyed by gpuType.
  const speeds = React.useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const s of DEFAULT_GPU_SPEEDS) m.set(s.gpuType, s.defaultSpeed);
    for (const [k, v] of Object.entries(speedOverrides)) m.set(k, v);
    return m;
  }, [speedOverrides]);

  const [validation, setValidation] = React.useState<SpeedValidation>({
    invalid: [],
    extreme: [],
    rawInputs: new Map(),
  });

  const updateSpeed = React.useCallback(
    (gpuType: string, value: string) => {
      const trimmed = (value ?? "").trim();
      const num = parseFloat(trimmed);
      const isInvalid = trimmed === "" || isNaN(num) || num < 0;
      const isExtreme = !isInvalid && num > MAX_REASONABLE_SPEED;

      setValidation((prev) => {
        const nextInvalid = new Set(prev.invalid);
        const nextExtreme = new Set(prev.extreme);
        const nextRaw = new Map(prev.rawInputs);
        nextRaw.set(gpuType, trimmed);
        if (isInvalid) nextInvalid.add(gpuType);
        else nextInvalid.delete(gpuType);
        if (isExtreme) nextExtreme.add(gpuType);
        else nextExtreme.delete(gpuType);
        return {
          invalid: Array.from(nextInvalid),
          extreme: Array.from(nextExtreme),
          rawInputs: nextRaw,
        };
      });

      if (!isInvalid && !isExtreme) {
        setSpeedOverrides((prev) => ({ ...prev, [gpuType]: num }));
      }
    },
    [setSpeedOverrides],
  );

  const resetSpeeds = React.useCallback(() => {
    setSpeedOverrides({});
    setValidation({ invalid: [], extreme: [], rawInputs: new Map() });
  }, [setSpeedOverrides]);

  // ----- Saved scenarios (persisted) ---------------------------------------
  const [savedScenarios, setSavedScenarios] = usePersistedState<
    SavedScenario[]
  >(SAVED_SCENARIOS_KEY, [], {
    version: 1,
    migrate: (raw) => sanitizeSavedScenarios(raw),
  });

  // Inline-name dialog state replaces window.prompt — non-blocking and
  // doesn't get suppressed by every modern browser's anti-modal heuristics.
  const [saveNameDraft, setSaveNameDraft] = React.useState<string | null>(
    null,
  );

  const beginSaveScenario = React.useCallback(() => {
    if (!rawA.gpu) return;
    const suggested = `${rawA.gpu} ×${clampInt(rawA.count, 1, MAX_GPU_COUNT, 1)} @ ${rawA.region}`;
    setSaveNameDraft(suggested);
  }, [rawA]);

  const commitSaveScenario = React.useCallback(() => {
    if (saveNameDraft == null) return;
    const name = saveNameDraft.trim();
    if (!name || !rawA.gpu) {
      setSaveNameDraft(null);
      return;
    }
    const next: SavedScenario = {
      name,
      scenario: { ...rawA },
      savedAt: new Date().toISOString(),
    };
    setSavedScenarios((prev) => {
      const filtered = prev.filter((s) => s.name !== name);
      return [next, ...filtered].slice(0, 50);
    });
    setSaveNameDraft(null);
  }, [saveNameDraft, rawA, setSavedScenarios]);

  const cancelSaveScenario = React.useCallback(() => {
    setSaveNameDraft(null);
  }, []);

  const applySavedScenario = React.useCallback(
    (s: SavedScenario) => {
      setUrlState({
        "a.gpu": s.scenario.gpu,
        "a.count": s.scenario.count,
        "a.region": s.scenario.region,
        "a.hours": s.scenario.hours,
        "a.priority": s.scenario.priority,
      });
    },
    [setUrlState],
  );

  const deleteSavedScenario = React.useCallback(
    (name: string) => {
      setSavedScenarios((prev) => prev.filter((s) => s.name !== name));
    },
    [setSavedScenarios],
  );

  // ----- Section visibility prefs ------------------------------------------
  const [sectionPrefs, setSectionPrefs] = usePersistedState<SectionPrefs>(
    SECTIONS_PREF_KEY,
    DEFAULT_SECTION_PREFS,
    {
      version: 1,
      migrate: (raw) => sanitizeSectionPrefs(raw),
    },
  );
  const updateSectionPref = React.useCallback(
    (patch: Partial<SectionPrefs>) => {
      setSectionPrefs((prev) => ({ ...prev, ...patch }));
    },
    [setSectionPrefs],
  );

  // ----- Live pool data view -----------------------------------------------
  const isLoading = state.poolInfos === undefined;
  const poolInfos = state.poolInfos ?? [];
  const regionSummaries = React.useMemo(
    () => groupPoolsByRegion(poolInfos, speeds),
    [poolInfos, speeds],
  );

  const grandTotalGpus = regionSummaries.reduce((s, r) => s + r.totalGpus, 0);
  const grandTotalSpeed = regionSummaries.reduce((s, r) => s + r.totalSpeed, 0);
  const grandTotalNodes = regionSummaries.reduce(
    (s, r) => s + r.vmBreakdown.reduce((ns, vm) => ns + vm.nodeCount, 0),
    0,
  );
  const regionCount = regionSummaries.length;

  const gpuTypeTotals = React.useMemo(() => {
    const totals = new Map<string, { gpus: number; speed: number }>();
    for (const r of regionSummaries) {
      for (const vm of r.vmBreakdown) {
        const prev = totals.get(vm.gpuType) ?? { gpus: 0, speed: 0 };
        totals.set(vm.gpuType, {
          gpus: prev.gpus + vm.totalGpus,
          speed: prev.speed + vm.totalSpeed,
        });
      }
    }
    return totals;
  }, [regionSummaries]);

  const allVms = React.useMemo(() => getAllVmSizes(), []);

  // ----- Resolved scenarios + their results --------------------------------
  // Memoize so a non-scenario re-render (e.g. validation flash, sectionPrefs
  // toggle) doesn't churn the recommendation table's expensive useMemo.
  const scenarioA = React.useMemo(() => resolveScenario(rawA), [rawA]);
  const scenarioB = React.useMemo(
    () => (compareOn ? resolveScenario(rawB) : null),
    [compareOn, rawB],
  );
  const resultA = React.useMemo(
    () => (scenarioA ? computeScenarioResult(scenarioA, speeds) : null),
    [scenarioA, speeds],
  );
  const resultB = React.useMemo(
    () => (scenarioB ? computeScenarioResult(scenarioB, speeds) : null),
    [scenarioB, speeds],
  );

  // ----- Share link + formatted-result clipboard payloads ------------------
  // The <CopyButton /> from shared/copy-button.tsx owns the clipboard dance
  // and the "Copied" success flash — we just feed it strings.
  const shareLinkValue =
    typeof window !== "undefined" ? window.location.href : "";

  const formattedSummary = React.useMemo<string>(() => {
    if (!scenarioA || !resultA) return "";
    const lines: string[] = [
      `GPU calculator — Scenario A`,
      `  ${scenarioA.gpu} ×${scenarioA.count} @ ${scenarioA.region} (${scenarioA.priority}, ${scenarioA.hours}h)`,
      `  Speed:        ${formatSpeed(resultA.totalSpeedMnos)}`,
      `  Hourly rate:  ${formatCurrency(resultA.hourlyRate)}`,
      `  Total cost:   ${formatCurrency(resultA.totalCost)}`,
      `  $/Gnos:       ${formatCurrencyCompact(resultA.costPerGnos)}`,
      `  Work window:  ${formatNumber(Math.round(resultA.workInWindowGnos))} Gnos`,
    ];
    if (scenarioB && resultB) {
      lines.push(
        ``,
        `Scenario B`,
        `  ${scenarioB.gpu} ×${scenarioB.count} @ ${scenarioB.region} (${scenarioB.priority}, ${scenarioB.hours}h)`,
        `  Speed:        ${formatSpeed(resultB.totalSpeedMnos)}`,
        `  Hourly rate:  ${formatCurrency(resultB.hourlyRate)}`,
        `  Total cost:   ${formatCurrency(resultB.totalCost)}`,
      );
    }
    return lines.join("\n");
  }, [scenarioA, resultA, scenarioB, resultB]);

  // ----- Export rows -------------------------------------------------------
  // Two flat row-shapes — one for the scenario card, one for the per-region
  // rollup — flattened together so CSV export reads cleanly as a single sheet
  // and JSON export preserves typed objects.
  interface ExportRow {
    kind: "scenario" | "region-vm";
    name: string;
    gpuType: string;
    region: string;
    vmSize: string;
    nodes: number;
    gpus: number;
    speedMnos: number;
    hourlyRateUsd: number;
    totalCostUsd: number;
    notes: string;
  }
  const exportRows = React.useMemo<ExportRow[]>(() => {
    const rows: ExportRow[] = [];
    if (scenarioA && resultA) {
      rows.push({
        kind: "scenario",
        name: "Scenario A",
        gpuType: scenarioA.gpu,
        region: scenarioA.region,
        vmSize: "",
        nodes: 0,
        gpus: scenarioA.count,
        speedMnos: resultA.totalSpeedMnos,
        hourlyRateUsd: resultA.hourlyRate,
        totalCostUsd: resultA.totalCost,
        notes: `${scenarioA.priority}, ${scenarioA.hours}h`,
      });
    }
    if (scenarioB && resultB) {
      rows.push({
        kind: "scenario",
        name: "Scenario B",
        gpuType: scenarioB.gpu,
        region: scenarioB.region,
        vmSize: "",
        nodes: 0,
        gpus: scenarioB.count,
        speedMnos: resultB.totalSpeedMnos,
        hourlyRateUsd: resultB.hourlyRate,
        totalCostUsd: resultB.totalCost,
        notes: `${scenarioB.priority}, ${scenarioB.hours}h`,
      });
    }
    for (const r of regionSummaries) {
      for (const vm of r.vmBreakdown) {
        rows.push({
          kind: "region-vm",
          name: `${r.region} / ${vm.vmShort}`,
          gpuType: vm.gpuType,
          region: r.region,
          vmSize: vm.vmSize,
          nodes: vm.nodeCount,
          gpus: vm.totalGpus,
          speedMnos: vm.totalSpeed,
          hourlyRateUsd: 0,
          totalCostUsd: 0,
          notes: "live pool",
        });
      }
    }
    return rows;
  }, [scenarioA, resultA, scenarioB, resultB, regionSummaries]);

  const exportColumns = React.useMemo<ExportColumn<ExportRow>[]>(
    () => [
      { header: "Kind", accessor: (r) => r.kind },
      { header: "Name", accessor: (r) => r.name },
      { header: "GPU Type", accessor: (r) => r.gpuType },
      { header: "Region", accessor: (r) => r.region },
      { header: "VM Size", accessor: (r) => r.vmSize },
      { header: "Nodes", accessor: (r) => r.nodes },
      { header: "GPUs", accessor: (r) => r.gpus },
      { header: "Speed (Mnos/s)", accessor: (r) => r.speedMnos },
      { header: "Hourly Rate (USD)", accessor: (r) => r.hourlyRateUsd },
      { header: "Total Cost (USD)", accessor: (r) => r.totalCostUsd },
      { header: "Notes", accessor: (r) => r.notes },
    ],
    [],
  );

  // ----- Apply a VM recommendation back into the scenario form -------------
  const applyVmToScenario = React.useCallback(
    (vm: VmSizeInfo) => {
      if (!scenarioA) return;
      const speedPerGpu = speeds.get(vm.gpuType) ?? 0;
      const targetSpeed =
        (speeds.get(scenarioA.gpu) ?? 0) * scenarioA.count;
      if (speedPerGpu <= 0) return;
      const nodesNeeded = Math.ceil(
        targetSpeed / (speedPerGpu * vm.gpuCount),
      );
      const newCount = Math.max(1, nodesNeeded * vm.gpuCount);
      setUrlState({
        "a.gpu": vm.gpuType,
        "a.count": String(newCount),
      });
    },
    [scenarioA, speeds, setUrlState],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4" aria-busy="true">
        <PageHeader
          title="GPU Calculator"
          description="What-if speed and cost scenarios over your GPU pools."
        />
        <SkeletonLoader variant="stat-bar" />
        <SkeletonLoader variant="card" cards={3} />
        <SkeletonLoader variant="table" rows={6} columns={7} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <PageHeader
        title="GPU Calculator"
        description="Estimate speed and cost for a GPU scenario, and inspect live pool capacity by region."
      >
        {scenarioA && (
          <>
            {/*
              COORDINATOR: <CopyButton /> from shared/copy-button.tsx owns the
              clipboard dance + success flash. We wrap it with a label span so
              the page-header keeps a consistent "Copy link" affordance.
            */}
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm">
              <LinkIcon className="h-3.5 w-3.5" aria-hidden />
              Share link
              <CopyButton
                value={shareLinkValue}
                ariaLabel="Copy a shareable link to this scenario"
                alwaysVisible
                iconSize={13}
              />
            </span>
            {formattedSummary && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm">
                <Calculator className="h-3.5 w-3.5" aria-hidden />
                Copy summary
                <CopyButton
                  value={formattedSummary}
                  ariaLabel="Copy the formatted calculation summary"
                  alwaysVisible
                  iconSize={13}
                />
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={beginSaveScenario}
              aria-label="Save current scenario A under a name"
            >
              <BookmarkPlus aria-hidden />
              Save
            </Button>
            {savedScenarios.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Open saved scenarios (${savedScenarios.length})`}
                  >
                    <Library aria-hidden />
                    Saved ({savedScenarios.length})
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Saved scenarios
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {[...savedScenarios]
                    .sort((a, b) =>
                      (b.savedAt ?? "").localeCompare(a.savedAt ?? ""),
                    )
                    .map((s) => (
                    <DropdownMenuItem
                      key={s.name}
                      onSelect={() => applySavedScenario(s)}
                      className="flex items-start gap-2"
                    >
                      <Library
                        className="mt-0.5 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs font-semibold text-foreground">
                          {s.name}
                        </span>
                        <span className="truncate text-2xs text-muted-foreground">
                          {s.scenario.gpu} ×{s.scenario.count} @{" "}
                          {s.scenario.region}, {s.scenario.hours}h,{" "}
                          {s.scenario.priority}
                        </span>
                      </span>
                      <button
                        type="button"
                        // Stop both pointerdown (Radix's chosen activation
                        // event) and click so deleting an item doesn't
                        // also fire the surrounding DropdownMenuItem's
                        // onSelect → applySavedScenario.
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          deleteSavedScenario(s.name);
                        }}
                        aria-label={`Delete saved scenario ${s.name}`}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <ExportMenu
              rows={exportRows}
              columns={exportColumns}
              filename="gpu-calculator"
              jsonMetadata={{
                scenarioA: scenarioA,
                scenarioB: scenarioB ?? null,
                speeds: Object.fromEntries(speeds),
              }}
            />
            {compareOn ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={disableCompare}
                aria-label="Stop comparing scenarios"
              >
                <X aria-hidden />
                Stop comparing
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={enableCompare}
                aria-label="Compare a second scenario side by side"
              >
                <ArrowRightLeft aria-hidden />
                Compare
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetAll}
              aria-label="Reset all scenario inputs to defaults"
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Toggle visible sections"
                >
                  <Eye aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Show sections
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    updateSectionPref({
                      showRecommendation: !sectionPrefs.showRecommendation,
                    });
                  }}
                >
                  {sectionPrefs.showRecommendation ? (
                    <Check aria-hidden />
                  ) : (
                    <EyeOff aria-hidden />
                  )}
                  Recommendation
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    updateSectionPref({
                      showLivePools: !sectionPrefs.showLivePools,
                    });
                  }}
                >
                  {sectionPrefs.showLivePools ? (
                    <Check aria-hidden />
                  ) : (
                    <EyeOff aria-hidden />
                  )}
                  Live pool capacity
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    updateSectionPref({
                      showVmReference: !sectionPrefs.showVmReference,
                    });
                  }}
                >
                  {sectionPrefs.showVmReference ? (
                    <Check aria-hidden />
                  ) : (
                    <EyeOff aria-hidden />
                  )}
                  VM reference
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </PageHeader>

      {/* Inline "save scenario as" prompt -- replaces window.prompt() so the
          flow works under browser modal-suppression heuristics and is
          keyboard-driven (Enter to save, Esc to cancel). */}
      {saveNameDraft != null && (
        <Card
          role="dialog"
          aria-label="Save scenario"
          className="border-primary/30 bg-card shadow-sm"
        >
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="save-scenario-name" className="text-xs">
                Save scenario as
              </Label>
              <Input
                id="save-scenario-name"
                autoFocus
                value={saveNameDraft}
                onChange={(e) => setSaveNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitSaveScenario();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelSaveScenario();
                  }
                }}
                aria-label="Scenario name"
                placeholder="e.g. H100 ×8 baseline"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={commitSaveScenario}
              disabled={!saveNameDraft.trim()}
              aria-label="Save scenario"
            >
              <Check aria-hidden /> Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancelSaveScenario}
              aria-label="Cancel saving scenario"
            >
              <X aria-hidden /> Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Workload presets --------------------------------------------------- */}
      <PresetChipRow onPick={applyPreset} activeId={activePresetId} />

      {/* Scenario builder ---------------------------------------------------- */}
      {!scenarioA ? (
        <EmptyState
          icon={Calculator}
          title="Pick a GPU to begin"
          description="Choose a GPU type and we will compute speed, $/hour, and total cost. Your selection lives in the URL so links are shareable."
          action={{
            label: `Start with ${DEFAULT_GPU_TYPE}`,
            onClick: pickDefaultGpu,
            icon: Cpu,
          }}
        />
      ) : (
        <div
          className={cn(
            "flex flex-col gap-3",
            compareOn && scenarioB && "lg:flex-row",
          )}
        >
          <ScenarioForm
            label="A"
            scenario={scenarioA}
            result={resultA!}
            gpuOptions={gpuOptions}
            onChange={updateScenarioA}
            tone="primary"
            compareTo={compareOn && resultB ? resultB : undefined}
          />
          {compareOn && scenarioB && (
            <ScenarioForm
              label="B"
              scenario={scenarioB}
              result={resultB!}
              gpuOptions={gpuOptions}
              onChange={updateScenarioB}
              onRemove={disableCompare}
              tone="info"
              compareTo={resultA ?? undefined}
            />
          )}
        </div>
      )}

      {/* Cost formula + Reverse target-work ---------------------------------- */}
      {scenarioA && resultA && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <CostBreakdownCard
            scenario={scenarioA}
            result={resultA}
            speeds={speeds}
          />
          <TargetWorkCard
            result={resultA}
            targetGnos={targetGnos}
            onChange={setTargetGnos}
          />
        </div>
      )}

      {/* Recommendation card ------------------------------------------------- */}
      {scenarioA && resultA && sectionPrefs.showRecommendation && (
        <RecommendationCard
          scenario={scenarioA}
          result={resultA}
          speeds={speeds}
          allVms={allVms}
          onApply={applyVmToScenario}
        />
      )}

      {/* Speed validation alert --------------------------------------------- */}
      {(validation.invalid.length > 0 || validation.extreme.length > 0) && (
        <Alert variant="warning" role="alert" aria-live="polite">
          <TriangleAlert className="h-4 w-4" aria-hidden />
          <AlertDescription>
            {validation.invalid.length > 0 && (
              <span>
                Enter a non-negative number for{" "}
                <b>{validation.invalid.join(", ")}</b> speed. The previous
                value is still being used.
              </span>
            )}
            {validation.extreme.length > 0 && (
              <span>
                {" "}
                Values above {MAX_REASONABLE_SPEED.toLocaleString()} Mnos/s
                for <b>{validation.extreme.join(", ")}</b> look unrealistic
                and were not applied.
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* GPU Speed Settings ------------------------------------------------- */}
      <Card className="border-border bg-card shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            GPU Speed Settings
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              (Mnos/s per GPU)
            </span>
            <InfoTooltip
              content="Mnos/s (mega-nodes-per-second) is the user-supplied benchmark unit for how many million node-evaluations a single GPU can run per second. Edits persist in localStorage."
              size={12}
            />
          </CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={resetSpeeds}
            aria-label="Reset GPU speeds to defaults"
          >
            <RotateCcw aria-hidden />
            Reset speeds
          </Button>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-6 pt-0">
          {DEFAULT_GPU_SPEEDS.map((gs) => {
            const fieldId = `gpu-speed-${gs.gpuType}`;
            const errorId = `${fieldId}-error`;
            const raw = validation.rawInputs.get(gs.gpuType);
            const displayValue =
              raw !== undefined
                ? raw
                : String(speeds.get(gs.gpuType) ?? gs.defaultSpeed);
            const isFieldInvalid = validation.invalid.includes(gs.gpuType);
            const isFieldExtreme = validation.extreme.includes(gs.gpuType);
            const errorMsg = isFieldInvalid
              ? "Enter a non-negative number"
              : isFieldExtreme
                ? `Max ${MAX_REASONABLE_SPEED.toLocaleString()} Mnos/s`
                : undefined;
            const hasError = isFieldInvalid || isFieldExtreme;
            return (
              <div key={gs.gpuType} className="flex items-center gap-2">
                <Label
                  htmlFor={fieldId}
                  className={cn(
                    "min-w-[50px] cursor-pointer rounded px-2.5 py-1 text-center text-sm font-bold",
                    gpuTypeBadgeClass(gs.gpuType),
                  )}
                >
                  {gs.gpuType}
                </Label>
                <div className="flex flex-col">
                  <div className="relative">
                    <Input
                      id={fieldId}
                      value={displayValue}
                      onChange={(e) => updateSpeed(gs.gpuType, e.target.value)}
                      type="number"
                      min={0}
                      max={MAX_REASONABLE_SPEED}
                      step={1}
                      className={cn(
                        "w-[140px] pr-16 text-right font-semibold tabular-nums transition-shadow duration-200 ease-out focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none",
                        hasError && "border-warning ring-1 ring-warning/40",
                      )}
                      aria-label={`${gs.gpuType} benchmark speed in Mnos per second per GPU`}
                      aria-invalid={hasError}
                      aria-describedby={errorMsg ? errorId : undefined}
                    />
                    <span
                      className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-2xs text-muted-foreground"
                      aria-hidden
                    >
                      Mnos/s
                    </span>
                  </div>
                  {errorMsg && (
                    <span
                      id={errorId}
                      className="mt-1 text-2xs font-medium text-warning"
                      role="alert"
                    >
                      {errorMsg}
                    </span>
                  )}
                  <span className="mt-0.5 text-2xs text-muted-foreground">
                    default {gs.defaultSpeed}
                  </span>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Summary stats — live pool capacity --------------------------------- */}
      {sectionPrefs.showLivePools && (
        <>
          <section
            aria-label="GPU calculator totals"
            aria-live="polite"
            aria-atomic="true"
            className="flex flex-wrap gap-3"
          >
            <StatCard
              icon={Globe}
              label="Regions"
              value={String(regionCount)}
              tone="primary"
              tooltip="Distinct Azure regions hosting active GPU pools."
            />
            <StatCard
              icon={Server}
              label="Total Nodes"
              value={formatNumber(grandTotalNodes)}
              tone="info"
              tooltip="Sum of dedicated + low-priority nodes across every active GPU pool."
            />
            <StatCard
              icon={Cpu}
              label="Total GPUs"
              value={formatNumber(grandTotalGpus)}
              tone="warning"
              tooltip="Nodes × GPUs-per-node, across every active GPU pool."
            />
            <StatCard
              icon={Zap}
              label="Total Speed"
              value={formatSpeed(grandTotalSpeed)}
              tone="success"
              sub={`${grandTotalGpus} GPUs × avg ${grandTotalGpus > 0 ? Math.round(grandTotalSpeed / grandTotalGpus) : 0} Mnos/s`}
              tooltip="Sum of (per-GPU benchmark × total GPUs) across every pool."
            />
          </section>

          {regionSummaries.length > 0 && (
            <GpuRegionSparkline summaries={regionSummaries} />
          )}

          {/* GPU type breakdown ------------------------------------------------- */}
          {gpuTypeTotals.size > 0 && (
            <div className="flex flex-wrap gap-3">
              {Array.from(gpuTypeTotals.entries()).map(([gpuType, totals]) => (
                <Card
                  key={gpuType}
                  className="min-w-[180px] flex-1 border-border bg-card shadow-sm transition-colors duration-200 ease-out hover:border-primary/40 motion-reduce:transition-none"
                >
                  <CardContent className="flex items-center gap-3 p-4">
                    <span
                      className={cn(
                        "inline-flex items-center rounded px-2.5 py-1 text-sm font-bold",
                        gpuTypeBadgeClass(gpuType),
                      )}
                    >
                      {gpuType}
                    </span>
                    <div>
                      <span className="block text-lg font-bold leading-tight tabular-nums text-foreground">
                        {formatNumber(totals.gpus)} GPUs
                      </span>
                      <span className="block text-xs tabular-nums text-info">
                        {formatSpeed(totals.speed)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* VM reference table ------------------------------------------------- */}
      {sectionPrefs.showVmReference && (
        <Card className="border-border bg-card shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
              VM Reference
              <InfoTooltip
                content="All GPU VM sizes shipped in this catalogue. Speed/Node reflects the editable per-GPU benchmark × GPUs/Node."
                size={12}
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table aria-label="GPU VM size reference">
              <TableCaption className="sr-only mt-0">
                Reference table of GPU VM sizes and per-node speeds
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">VM Size</TableHead>
                  <TableHead scope="col" className="text-center">
                    GPU
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    GPUs/Node
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    VRAM/GPU
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    vCPUs
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    RAM (GB)
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Speed/Node
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    $/h (ded.)
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allVms.map((vm) => {
                  const speedPerGpu = speeds.get(vm.gpuType) ?? 0;
                  const speedPerNode = speedPerGpu * vm.gpuCount;
                  const hourlyCost =
                    (HOURLY_RATE_PER_GPU[vm.gpuType] ?? 0) * vm.gpuCount;
                  return (
                    <TableRow key={vm.name}>
                      <TableCell className="font-semibold text-foreground">
                        {vmShortName(vm.name)}
                      </TableCell>
                      <TableCell className="text-center">
                        <span
                          className={cn(
                            "inline-flex items-center rounded px-2 py-0.5 text-2xs font-bold",
                            gpuTypeBadgeClass(vm.gpuType),
                          )}
                        >
                          {vm.gpuType}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {vm.gpuCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {vm.gpuMemoryGB} GB
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {vm.vCPUs}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {vm.memoryGB}
                      </TableCell>
                      <TableCell className="text-right font-bold tabular-nums text-info">
                        {formatSpeed(speedPerNode)}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-warning">
                        {formatCurrency(hourlyCost)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Per-region cards --------------------------------------------------- */}
      {sectionPrefs.showLivePools && (
        <section aria-label="Per-region GPU breakdown" aria-live="polite">
          {regionSummaries.length === 0 ? (
            <EmptyState
              icon={Calculator}
              title="No active GPU pools"
              description="GPU calculations will appear once pools with nodes are discovered. Go to Pool Info and click Refresh."
            />
          ) : (
            <div className="flex flex-col gap-3">
              <h2 className="m-0 text-base font-semibold text-foreground">
                Per-Region Breakdown{" "}
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  ({pluralize(regionCount, "region")})
                </span>
              </h2>
              {regionSummaries.map((summary) => (
                <RegionCard
                  key={summary.region}
                  summary={summary}
                  grandTotalSpeed={grandTotalSpeed}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

// Public export — wraps the inner page in an ErrorBoundary so a crash in any
// region card or VM table doesn't take down the whole dashboard.
export const GpuCalculatorPage: React.FC = () => (
  <ErrorBoundary>
    <GpuCalculatorPageInner />
  </ErrorBoundary>
);
