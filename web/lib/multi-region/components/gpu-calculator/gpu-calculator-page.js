import { __awaiter } from "tslib";
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
 *   - Side-by-side compare supports up to THREE scenarios (A/B/C) with
 *     DELTAS (Δ speed, Δ $, Δ %) measured against scenario A.
 *   - HOTKEYS: `c` copies the formatted summary, `s` saves scenario A,
 *     `1` enables 1-way (A only), `2` adds B, `3` adds C. The shortcuts
 *     ignore key presses fired from inside an input / select / textarea so
 *     typing a count of "2" never trips the compare hotkey.
 *   - JSON IMPORT: paste a previously-exported scenario list back into the
 *     saved-scenarios dropdown to round-trip via clipboard.
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
import { ArrowRightLeft, BookmarkPlus, Calculator, Check, ClipboardPaste, Cpu, Eye, EyeOff, Gauge, Globe, Keyboard, Library, Link as LinkIcon, Plus, RotateCcw, Server, ShieldAlert, Star, Target, Trash2, TriangleAlert, X, Zap, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, } from "@/components/ui/table";
import { cn, formatNumber, pluralize } from "@/lib/utils";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import { useMultiRegionState } from "../../store/store-context";
import { AZURE_REGIONS, isGpuRegion } from "../shared/constants";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { RegionBadge } from "../shared/region-badge";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { getAllVmSizes, getVmSizeInfo } from "../shared/vm-sizes";
const DEFAULT_GPU_SPEEDS = [
    { gpuType: "V100", defaultSpeed: 100 },
    { gpuType: "H100", defaultSpeed: 343 },
];
const DEFAULT_GPU_TYPE = "H100";
const DEFAULT_REGION = "eastus";
const DEFAULT_HOURS = 1;
const DEFAULT_COUNT = 1;
const DEFAULT_PRIORITY = "dedicated";
// Indicative hourly $/GPU. Used by the what-if scenario calculator.
// Low-priority is roughly 1/5 the dedicated rate per Azure spot guidance.
const HOURLY_RATE_PER_GPU = {
    V100: 3.0,
    H100: 6.0,
};
const LOW_PRIORITY_DISCOUNT = 0.2;
// Hard upper bounds for numeric inputs — anything past these is almost
// certainly a typo and would make the cost / speed totals overflow into
// useless scientific notation.
const MAX_GPU_COUNT = 10000;
const MAX_HOURS = 8760; // one year, calendar-aligned
const MAX_TARGET_WORK_GNOS = 1000000000; // 1e9 Gnos = 1 Pnos
// localStorage keys for saved-scenarios + speed-overrides.
const SAVED_SCENARIOS_KEY = "azbm:gpu-calculator:saved-scenarios:v1";
const SPEED_OVERRIDES_KEY = "azbm:gpu-calculator:speed-overrides:v1";
const SECTIONS_PREF_KEY = "azbm:gpu-calculator:sections:v1";
function parseCompareMode(raw) {
    if (raw === "abc")
        return "abc";
    // Legacy form (compare=1) and the canonical "ab" both mean 2-way compare.
    if (raw === "ab" || raw === "1")
        return "ab";
    return "off";
}
const DEFAULT_SECTION_PREFS = {
    showLivePools: true,
    showVmReference: true,
    showRecommendation: true,
};
const SCENARIO_PRESETS = [
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
function vmShortName(vmSize) {
    return vmSize.replace("Standard_", "").replace(/_/g, " ");
}
// Tone classes by GPU family. Centralised here so the badge styling stays
// consistent across the speed-input chips, region cards, and reference table.
function gpuTypeBadgeClass(gpuType) {
    if (gpuType === "H100") {
        return "bg-warning/15 text-warning";
    }
    return "bg-success/15 text-success";
}
function parseScenarioPriority(raw) {
    return raw === "lowpriority" ? "lowpriority" : "dedicated";
}
// useUrlState's value union is `string | string[] | undefined`; this page's
// keys are all scalars so coerce to string defensively.
function asStr(v) {
    return typeof v === "string" ? v : "";
}
function clampInt(raw, min, max, fallback) {
    const n = parseFloat(raw);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}
function clampFloat(raw, min, max, fallback) {
    const n = parseFloat(raw);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
function resolveScenario(raw) {
    if (!raw.gpu)
        return null;
    return {
        gpu: raw.gpu,
        count: clampInt(raw.count, 1, MAX_GPU_COUNT, DEFAULT_COUNT),
        region: raw.region || DEFAULT_REGION,
        hours: clampFloat(raw.hours, 0, MAX_HOURS, DEFAULT_HOURS),
        priority: parseScenarioPriority(raw.priority),
    };
}
function computeScenarioResult(scenario, speeds) {
    var _a, _b;
    const speedPerGpu = (_a = speeds.get(scenario.gpu)) !== null && _a !== void 0 ? _a : 0;
    const totalSpeedMnos = speedPerGpu * scenario.count;
    const baseRate = (_b = HOURLY_RATE_PER_GPU[scenario.gpu]) !== null && _b !== void 0 ? _b : 0;
    const effectiveRate = scenario.priority === "lowpriority"
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
function groupPoolsByRegion(poolInfos, speeds) {
    var _a, _b, _c, _d;
    const regionMap = new Map();
    for (const pool of poolInfos) {
        if (pool.state === "deleting")
            continue;
        const totalNodes = ((_a = pool.currentDedicatedNodes) !== null && _a !== void 0 ? _a : 0) + ((_b = pool.currentLowPriorityNodes) !== null && _b !== void 0 ? _b : 0);
        if (totalNodes === 0)
            continue;
        const vmInfo = getVmSizeInfo(pool.vmSize);
        if (!vmInfo || !vmInfo.isGpu)
            continue;
        if (!regionMap.has(pool.region)) {
            regionMap.set(pool.region, new Map());
        }
        const vmMap = regionMap.get(pool.region);
        // Pools occasionally land here with `vmSize` undefined (e.g. a stale
        // store entry from before the field was populated). Fall back to ""
        // so the GPU rollup doesn't crash the whole calculator on render.
        const key = ((_c = pool.vmSize) !== null && _c !== void 0 ? _c : "").toLowerCase();
        if (!vmMap.has(key)) {
            vmMap.set(key, { vmInfo, nodes: 0 });
        }
        vmMap.get(key).nodes += totalNodes;
    }
    const summaries = [];
    for (const [region, vmMap] of regionMap) {
        const vmBreakdown = [];
        let totalGpus = 0;
        let totalSpeed = 0;
        for (const [, { vmInfo, nodes }] of vmMap) {
            const gpuType = vmInfo.gpuType;
            const gpuPerNode = vmInfo.gpuCount;
            const gpus = nodes * gpuPerNode;
            const speedPerGpu = (_d = speeds.get(gpuType)) !== null && _d !== void 0 ? _d : 0;
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
function formatSpeed(mnos) {
    if (!Number.isFinite(mnos))
        return "—";
    if (mnos >= 1000) {
        return `${(mnos / 1000).toFixed(1)} Gnos/s`;
    }
    return `${mnos.toLocaleString()} Mnos/s`;
}
function formatCurrency(usd) {
    if (!Number.isFinite(usd))
        return "—";
    return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
/**
 * Compact currency formatter for very small or very large $ values. Used by
 * the per-Gnos efficiency cell since costs can swing from $0.0008 (cheap
 * inference at scale) to $400+ (single dedicated H100 hour).
 */
function formatCurrencyCompact(usd) {
    if (!Number.isFinite(usd))
        return "—";
    if (usd === 0)
        return "$0";
    if (Math.abs(usd) < 0.01) {
        // 4 sig figs so 0.000812 doesn't collapse to "0.00".
        return `$${usd.toPrecision(2)}`;
    }
    return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}
/** Format duration in hours as e.g. "3h 12m", "0.4s", "12.3 days". */
function formatHours(hours) {
    if (!Number.isFinite(hours) || hours < 0)
        return "—";
    if (hours === 0)
        return "0";
    if (hours < 1 / 3600) {
        return `${(hours * 3600000).toFixed(0)} ms`;
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
    if (days < 30)
        return `${days.toFixed(1)} days`;
    return `${(days / 30).toFixed(1)} months`;
}
/** Render Δ value with sign and tone, e.g. "+$12.40" / "-3.2%". */
function formatDelta(value, formatter) {
    if (!Number.isFinite(value) || value === 0)
        return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${formatter(value)}`;
}
function formatPercentDelta(deltaFraction) {
    if (!Number.isFinite(deltaFraction) || deltaFraction === 0)
        return "—";
    const sign = deltaFraction > 0 ? "+" : "";
    return `${sign}${(deltaFraction * 100).toFixed(1)}%`;
}
// Distinct GPU types available in the catalogue, in priority order.
function getGpuTypeOptions() {
    const seen = new Set();
    const out = [];
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
function sanitizeSavedScenarios(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((item) => item != null &&
        typeof item === "object" &&
        typeof item.name === "string" &&
        typeof item.scenario === "object" &&
        item.scenario != null)
        .slice(0, 50);
}
function sanitizeSpeedOverrides(raw) {
    if (raw == null || typeof raw !== "object")
        return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
            out[k] = v;
        }
    }
    return out;
}
function sanitizeSectionPrefs(raw) {
    if (raw == null || typeof raw !== "object")
        return DEFAULT_SECTION_PREFS;
    const p = raw;
    return {
        showLivePools: typeof p.showLivePools === "boolean"
            ? p.showLivePools
            : DEFAULT_SECTION_PREFS.showLivePools,
        showVmReference: typeof p.showVmReference === "boolean"
            ? p.showVmReference
            : DEFAULT_SECTION_PREFS.showVmReference,
        showRecommendation: typeof p.showRecommendation === "boolean"
            ? p.showRecommendation
            : DEFAULT_SECTION_PREFS.showRecommendation,
    };
}
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const MAX_REASONABLE_SPEED = 100000;
const TONE_TEXT = {
    primary: "text-primary",
    info: "text-info",
    warning: "text-warning",
    success: "text-success",
};
const TONE_ICON_BG = {
    primary: "bg-primary/15",
    info: "bg-info/15",
    warning: "bg-warning/15",
    success: "bg-success/15",
};
const StatCard = React.memo(({ icon: Icon, label, value, tone, sub, tooltip }) => (React.createElement(Card, { role: "status", "aria-label": `${label}: ${value}`, className: "min-w-[160px] flex-1 border-border bg-card shadow-sm transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none" },
    React.createElement(CardContent, { className: "flex items-center gap-3 p-4 pt-4" },
        React.createElement("div", { className: cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-md", TONE_ICON_BG[tone]) },
            React.createElement(Icon, { className: cn("h-5 w-5", TONE_TEXT[tone]), "aria-hidden": true })),
        React.createElement("div", { className: "min-w-0" },
            React.createElement("span", { className: "flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" },
                label,
                tooltip && React.createElement(InfoTooltip, { content: tooltip, size: 11 })),
            React.createElement("span", { className: cn("block text-xl font-bold leading-tight tabular-nums", TONE_TEXT[tone]) }, value),
            sub && (React.createElement("span", { className: "block text-2xs text-muted-foreground/80" }, sub)))))));
StatCard.displayName = "StatCard";
// Number-input debounce in ms. Long enough that typing "10000" doesn't
// rebuild the recommendation table on every digit, short enough that the
// result panel feels live.
const NUMBER_INPUT_DEBOUNCE_MS = 220;
/**
 * Number <Input /> that buffers keystrokes locally and pushes the committed
 * value to the parent after `NUMBER_INPUT_DEBOUNCE_MS`. Keeps the input
 * responsive while the (potentially expensive) recommendation table waits
 * for the user to stop typing.
 */
const DebouncedNumberInput = ({ id, value, min, max, step = 1, inputMode = "numeric", ariaLabel, className, placeholder, onCommit, }) => {
    const [local, setLocal] = React.useState(value);
    const timerRef = React.useRef(null);
    // Keep local in sync if the parent value changes from outside (preset,
    // saved-scenario apply, reset, compare seed).
    React.useEffect(() => {
        setLocal(value);
    }, [value]);
    React.useEffect(() => () => {
        if (timerRef.current)
            clearTimeout(timerRef.current);
    }, []);
    const flush = React.useCallback((next) => {
        if (timerRef.current)
            clearTimeout(timerRef.current);
        onCommit(next);
    }, [onCommit]);
    const onChange = React.useCallback((e) => {
        const next = e.target.value;
        setLocal(next);
        if (timerRef.current)
            clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => onCommit(next), NUMBER_INPUT_DEBOUNCE_MS);
    }, [onCommit]);
    return (React.createElement(Input, { id: id, type: "number", inputMode: inputMode, min: min, max: max, step: step, value: local, onChange: onChange, onBlur: () => flush(local), className: className, "aria-label": ariaLabel, placeholder: placeholder }));
};
const SCENARIO_TONE_BORDER = {
    primary: "border-t-4 border-t-primary",
    info: "border-t-4 border-t-info",
    success: "border-t-4 border-t-success",
};
const SCENARIO_TONE_TEXT = {
    primary: "text-primary",
    info: "text-info",
    success: "text-success",
};
const SCENARIO_TONE_FOCUS_RING = {
    primary: "ring-2 ring-primary/40",
    info: "ring-2 ring-info/40",
    success: "ring-2 ring-success/40",
};
const ScenarioForm = ({ label, scenario, result, gpuOptions, onChange, onRemove, tone, compareTo, focused, cardId, }) => {
    const idPrefix = `scenario-${label.toLowerCase()}`;
    const regionWarn = scenario.region && !isGpuRegion(scenario.region)
        ? "This region does not advertise V100 or H100 capacity in Azure’s public docs. Capacity may be unavailable."
        : null;
    return (React.createElement(Card, { id: cardId, "data-scenario-slot": label.toLowerCase(), tabIndex: -1, className: cn("flex-1 scroll-mt-4 border-border bg-card shadow-sm transition-all duration-200 ease-out hover:shadow-md focus-visible:outline-none motion-reduce:transition-none", SCENARIO_TONE_BORDER[tone], focused && SCENARIO_TONE_FOCUS_RING[tone]) },
        React.createElement(CardHeader, { className: "flex flex-row items-center justify-between gap-2 space-y-0 px-4 py-3" },
            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold" },
                React.createElement("span", { className: cn("inline-flex h-6 w-6 items-center justify-center rounded-full bg-card text-2xs font-bold", SCENARIO_TONE_TEXT[tone]), "aria-hidden": true }, label),
                "Scenario ",
                label),
            onRemove && (React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: onRemove, "aria-label": "Remove compare scenario" },
                React.createElement(X, { "aria-hidden": true })))),
        React.createElement(CardContent, { className: "flex flex-col gap-3 pt-0" },
            React.createElement("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5" },
                React.createElement("div", { className: "flex flex-col gap-1" },
                    React.createElement(Label, { htmlFor: `${idPrefix}-gpu`, className: "flex items-center gap-1 text-xs" },
                        "GPU type",
                        React.createElement(InfoTooltip, { ariaLabel: "GPU type \u2014 security note", variant: "help", size: 11, content: React.createElement("span", { className: "block max-w-[260px] text-left" },
                                React.createElement("span", { className: "inline-flex items-center gap-1 font-semibold text-warning" },
                                    React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                                    "High-value compute target"),
                                React.createElement("span", { className: "mt-1 block text-2xs leading-relaxed" }, "H100 / V100 nodes are routinely targeted for crypto mining and unattributed model inference. Lock down egress, deny outbound to public model registries from pool subnets, and watch IMDS (169.254.169.254) for token-theft signatures."),
                                React.createElement("span", { className: "mt-1 block text-2xs italic text-muted-foreground" }, "Ref: New folder/_analysis_netspi.md \u00A7I (IMDS variants)")) })),
                    React.createElement(Select, { value: scenario.gpu, onValueChange: (v) => onChange({ gpu: v }) },
                        React.createElement(SelectTrigger, { id: `${idPrefix}-gpu`, "aria-label": "GPU type", className: "font-semibold" },
                            React.createElement(SelectValue, { placeholder: "Select GPU" })),
                        React.createElement(SelectContent, null, gpuOptions.map((g) => (React.createElement(SelectItem, { key: g, value: g }, g)))))),
                React.createElement("div", { className: "flex flex-col gap-1" },
                    React.createElement(Label, { htmlFor: `${idPrefix}-count`, className: "flex items-center gap-1 text-xs" },
                        "GPU count",
                        React.createElement(InfoTooltip, { content: `Number of GPUs running in parallel. Speed scales linearly. Capped at ${MAX_GPU_COUNT.toLocaleString()}.`, size: 11 })),
                    React.createElement(DebouncedNumberInput, { id: `${idPrefix}-count`, inputMode: "numeric", min: 1, max: MAX_GPU_COUNT, step: 1, value: String(scenario.count), onCommit: (v) => onChange({ count: v }), className: "text-right font-semibold tabular-nums transition-shadow duration-200 ease-out focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none", ariaLabel: "GPU count" })),
                React.createElement("div", { className: "flex flex-col gap-1" },
                    React.createElement(Label, { htmlFor: `${idPrefix}-region`, className: "text-xs" }, "Region"),
                    React.createElement(Select, { value: scenario.region, onValueChange: (v) => onChange({ region: v }) },
                        React.createElement(SelectTrigger, { id: `${idPrefix}-region`, "aria-label": "Region" },
                            React.createElement(SelectValue, { placeholder: "Select region" })),
                        React.createElement(SelectContent, null, AZURE_REGIONS.map((r) => (React.createElement(SelectItem, { key: r, value: r },
                            r,
                            !isGpuRegion(r) && (React.createElement("span", { className: "ml-1 text-2xs text-muted-foreground" }, "(no GPU)")))))))),
                React.createElement("div", { className: "flex flex-col gap-1" },
                    React.createElement(Label, { htmlFor: `${idPrefix}-hours`, className: "flex items-center gap-1 text-xs" },
                        "Hours",
                        React.createElement(InfoTooltip, { content: `Run duration in hours. 0 = instantaneous burst (rate-only view). Capped at ${MAX_HOURS.toLocaleString()} (one year).`, size: 11 })),
                    React.createElement(DebouncedNumberInput, { id: `${idPrefix}-hours`, inputMode: "decimal", min: 0, max: MAX_HOURS, step: 1, value: String(scenario.hours), onCommit: (v) => onChange({ hours: v }), className: "text-right font-semibold tabular-nums transition-shadow duration-200 ease-out focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none", ariaLabel: "Total runtime hours" })),
                React.createElement("div", { className: "flex flex-col gap-1" },
                    React.createElement(Label, { htmlFor: `${idPrefix}-priority`, className: "flex items-center gap-1 text-xs" },
                        "Priority",
                        React.createElement(InfoTooltip, { content: `"Low priority" uses spot capacity at roughly ${(LOW_PRIORITY_DISCOUNT * 100).toFixed(0)}% of the dedicated rate, but jobs can be pre-empted at any time.`, size: 11 })),
                    React.createElement(Select, { value: scenario.priority, onValueChange: (v) => onChange({ priority: v }) },
                        React.createElement(SelectTrigger, { id: `${idPrefix}-priority`, "aria-label": "Pricing priority" },
                            React.createElement(SelectValue, { placeholder: "Priority" })),
                        React.createElement(SelectContent, null,
                            React.createElement(SelectItem, { value: "dedicated" }, "Dedicated"),
                            React.createElement(SelectItem, { value: "lowpriority" }, "Low priority"))))),
            React.createElement("div", { className: "grid grid-cols-2 gap-3 rounded-md border border-border bg-surface-overlay p-4 transition-colors duration-200 ease-out sm:grid-cols-4 motion-reduce:transition-none", "aria-label": "Live scenario results" },
                React.createElement(ScenarioMetric, { label: "GPUs", value: formatNumber(result.totalGpus), tone: "primary", delta: compareTo
                        ? formatDelta(result.totalGpus - compareTo.totalGpus, formatNumber)
                        : undefined }),
                React.createElement(ScenarioMetric, { label: "Speed", value: formatSpeed(result.totalSpeedMnos), tone: "info", delta: compareTo
                        ? formatDelta(result.totalSpeedMnos - compareTo.totalSpeedMnos, formatSpeed)
                        : undefined }),
                React.createElement(ScenarioMetric, { label: "$/hour", value: formatCurrency(result.hourlyRate), tone: "warning", delta: compareTo
                        ? formatDelta(result.hourlyRate - compareTo.hourlyRate, formatCurrency)
                        : undefined }),
                React.createElement(ScenarioMetric, { label: `Cost (${pluralize(scenario.hours, "hour")})`, value: formatCurrency(result.totalCost), tone: "success", delta: compareTo
                        ? formatDelta(result.totalCost - compareTo.totalCost, formatCurrency)
                        : undefined, deltaPercent: compareTo && compareTo.totalCost > 0
                        ? formatPercentDelta((result.totalCost - compareTo.totalCost) /
                            compareTo.totalCost)
                        : undefined })),
            React.createElement("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground" },
                React.createElement("span", null,
                    "Indicative",
                    " ",
                    scenario.priority === "lowpriority"
                        ? "low-priority"
                        : "dedicated",
                    " ",
                    "rate ",
                    formatCurrency(result.effectiveRate),
                    " / GPU\u00B7hour in",
                    " ",
                    React.createElement(RegionBadge, { region: scenario.region, tone: "info" })),
                result.workInWindowGnos > 0 && (React.createElement("span", null,
                    "\u00B7 ",
                    formatCurrencyCompact(result.costPerGnos),
                    " per Gnos produced over ",
                    formatHours(scenario.hours),
                    " (",
                    formatNumber(Math.round(result.workInWindowGnos)),
                    " Gnos total)")),
                regionWarn && (React.createElement("span", { className: "inline-flex items-center gap-1 text-warning" },
                    React.createElement(TriangleAlert, { className: "h-3 w-3", "aria-hidden": true }),
                    " ",
                    regionWarn))))));
};
const SCENARIO_METRIC_TONE = {
    primary: "text-primary",
    info: "text-info",
    warning: "text-warning",
    success: "text-success",
};
const ScenarioMetric = ({ label, value, tone, delta, deltaPercent }) => (React.createElement("div", { className: "flex flex-col gap-0.5" },
    React.createElement("span", { className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, label),
    React.createElement("span", { className: cn("text-2xl font-bold leading-tight tabular-nums", SCENARIO_METRIC_TONE[tone]) }, value),
    delta && delta !== "—" && (React.createElement("span", { className: "text-2xs text-muted-foreground tabular-nums" },
        "\u0394 ",
        delta,
        deltaPercent && deltaPercent !== "—" ? ` (${deltaPercent})` : ""))));
// ---------------------------------------------------------------------------
// Cost-formula panel
// ---------------------------------------------------------------------------
const CostBreakdownCard = ({ scenario, result, speeds }) => {
    var _a;
    const speedPerGpu = (_a = speeds.get(scenario.gpu)) !== null && _a !== void 0 ? _a : 0;
    return (React.createElement(Card, { className: "border-border bg-card shadow-sm" },
        React.createElement(CardHeader, { className: "pb-3" },
            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold text-foreground" },
                React.createElement(Calculator, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                "How is this calculated?")),
        React.createElement(CardContent, { className: "space-y-2 pt-0 text-xs text-muted-foreground" },
            React.createElement("div", { className: "grid grid-cols-1 gap-1 font-mono text-2xs leading-relaxed text-foreground/80 sm:grid-cols-2" },
                React.createElement("div", null,
                    React.createElement("span", { className: "text-muted-foreground" }, "speed"),
                    " =",
                    " ",
                    React.createElement("span", { className: "text-info" },
                        formatNumber(scenario.count),
                        " GPU"),
                    " ",
                    "\u00D7",
                    " ",
                    React.createElement("span", { className: "text-info" },
                        formatNumber(speedPerGpu),
                        " Mnos/s"),
                    " ",
                    "= ",
                    React.createElement("b", null, formatSpeed(result.totalSpeedMnos))),
                React.createElement("div", null,
                    React.createElement("span", { className: "text-muted-foreground" }, "rate"),
                    " =",
                    " ",
                    React.createElement("span", { className: "text-warning" },
                        formatCurrency(result.baseRate),
                        " / GPU\u00B7h"),
                    scenario.priority === "lowpriority" && (React.createElement(React.Fragment, null,
                        " ",
                        "\u00D7 ",
                        React.createElement("span", { className: "text-warning" },
                            LOW_PRIORITY_DISCOUNT.toFixed(2),
                            " (LP)"))),
                    " ",
                    "=",
                    " ",
                    React.createElement("b", null,
                        formatCurrency(result.effectiveRate),
                        " / GPU\u00B7h")),
                React.createElement("div", null,
                    React.createElement("span", { className: "text-muted-foreground" }, "$/hour"),
                    " =",
                    " ",
                    React.createElement("span", { className: "text-warning" }, formatNumber(scenario.count)),
                    " ",
                    "\u00D7",
                    " ",
                    React.createElement("span", { className: "text-warning" }, formatCurrency(result.effectiveRate)),
                    " ",
                    "= ",
                    React.createElement("b", null, formatCurrency(result.hourlyRate))),
                React.createElement("div", null,
                    React.createElement("span", { className: "text-muted-foreground" }, "total cost"),
                    " =",
                    " ",
                    React.createElement("span", { className: "text-success" },
                        formatCurrency(result.hourlyRate),
                        " / h"),
                    " ",
                    "\u00D7 ",
                    React.createElement("span", { className: "text-success" },
                        scenario.hours,
                        " h"),
                    " =",
                    " ",
                    React.createElement("b", null, formatCurrency(result.totalCost))),
                result.workInWindowGnos > 0 && (React.createElement("div", { className: "sm:col-span-2" },
                    React.createElement("span", { className: "text-muted-foreground" }, "work produced"),
                    " =",
                    " ",
                    React.createElement("span", { className: "text-info" }, formatSpeed(result.totalSpeedMnos)),
                    " ",
                    "\u00D7 ",
                    React.createElement("span", { className: "text-info" },
                        scenario.hours,
                        " h"),
                    " =",
                    " ",
                    React.createElement("b", null,
                        formatNumber(Math.round(result.workInWindowGnos)),
                        " Gnos"),
                    " ",
                    "\u00B7",
                    " ",
                    React.createElement("span", { className: "text-muted-foreground" }, "$/Gnos"),
                    " =",
                    " ",
                    React.createElement("b", null, formatCurrencyCompact(result.costPerGnos))))),
            React.createElement("p", { className: "text-2xs leading-relaxed" },
                "Per-GPU benchmark speed comes from the editable \"GPU Speed Settings\" card below. Hourly rates are indicative Azure list prices (V100 \u2248 $3, H100 \u2248 $6 per GPU\u00B7h). Low-priority applies the",
                " ",
                (LOW_PRIORITY_DISCOUNT * 100).toFixed(0),
                "% spot discount but jobs may be pre-empted."))));
};
// ---------------------------------------------------------------------------
// Reverse "target work → hours needed" card
// ---------------------------------------------------------------------------
const TargetWorkCard = ({ result, targetGnos, onChange }) => {
    const targetN = clampFloat(targetGnos, 0, MAX_TARGET_WORK_GNOS, 0);
    const totalSpeedMnos = result.totalSpeedMnos; // Mnos/s
    // hours = Gnos × 1000 (→ Mnos) ÷ (Mnos/s) ÷ 3600 (→ hours)
    const hoursNeeded = React.useMemo(() => targetN > 0 && totalSpeedMnos > 0
        ? (targetN * 1000) / (totalSpeedMnos * 3600)
        : 0, [targetN, totalSpeedMnos]);
    const projectedCost = hoursNeeded * result.hourlyRate;
    return (React.createElement(Card, { className: "border-border bg-card shadow-sm" },
        React.createElement(CardHeader, { className: "pb-3" },
            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold text-foreground" },
                React.createElement(Target, { className: "h-4 w-4 text-info", "aria-hidden": true }),
                "How long for a target workload?",
                React.createElement(InfoTooltip, { content: "Enter the total work (in Gnos, billions of node evaluations) and we'll compute how long the current scenario would take and what it would cost.", size: 12 }))),
        React.createElement(CardContent, { className: "flex flex-wrap items-end gap-4 pt-0" },
            React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement(Label, { htmlFor: "target-gnos", className: "text-xs" }, "Target work (Gnos)"),
                React.createElement(DebouncedNumberInput, { id: "target-gnos", inputMode: "decimal", min: 0, max: MAX_TARGET_WORK_GNOS, step: 1, value: targetGnos, onCommit: onChange, placeholder: "e.g. 1000", className: "w-[160px] text-right font-semibold tabular-nums", ariaLabel: "Target work in Gnos" })),
            React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("span", { className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, "Wall-clock"),
                React.createElement("span", { className: "text-lg font-bold tabular-nums text-info" }, hoursNeeded > 0 ? formatHours(hoursNeeded) : "—")),
            React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("span", { className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, "Projected cost"),
                React.createElement("span", { className: "text-lg font-bold tabular-nums text-success" }, projectedCost > 0 ? formatCurrency(projectedCost) : "—")),
            hoursNeeded > 0 && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => onChange(""), "aria-label": "Clear target work input", className: "ml-auto" },
                React.createElement(X, { "aria-hidden": true }),
                " Clear")),
            targetN > 0 && totalSpeedMnos === 0 && (React.createElement(Alert, { variant: "warning", role: "status", className: "mt-2 w-full" },
                React.createElement(TriangleAlert, { className: "h-4 w-4", "aria-hidden": true }),
                React.createElement(AlertDescription, null, "The current scenario has 0 Mnos/s \u2014 set a per-GPU speed in the \"GPU Speed Settings\" card to compute wall-clock and cost."))))));
};
function buildRecommendations(scenario, speeds, allVms) {
    var _a, _b, _c, _d, _e;
    const targetSpeedMnos = ((_a = speeds.get(scenario.gpu)) !== null && _a !== void 0 ? _a : 0) * scenario.count;
    if (targetSpeedMnos <= 0) {
        return {
            cheapestForSpeed: null,
            fastestPerDollar: null,
            alternatives: [],
        };
    }
    const recs = [];
    for (const vm of allVms) {
        const speedPerGpu = (_b = speeds.get(vm.gpuType)) !== null && _b !== void 0 ? _b : 0;
        const speedPerNode = speedPerGpu * vm.gpuCount;
        if (speedPerNode <= 0)
            continue;
        const nodesNeeded = Math.ceil(targetSpeedMnos / speedPerNode);
        const totalGpus = nodesNeeded * vm.gpuCount;
        const totalSpeedMnos = totalGpus * speedPerGpu;
        const baseRate = (_c = HOURLY_RATE_PER_GPU[vm.gpuType]) !== null && _c !== void 0 ? _c : 0;
        const effectiveRate = scenario.priority === "lowpriority"
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
        cheapestForSpeed: (_d = byCost[0]) !== null && _d !== void 0 ? _d : null,
        fastestPerDollar: (_e = bySpeedPerDollar[0]) !== null && _e !== void 0 ? _e : null,
        alternatives: byCost,
    };
}
const RecommendationCard = ({ scenario, result, speeds, allVms, onApply }) => {
    const { cheapestForSpeed, fastestPerDollar, alternatives } = React.useMemo(() => buildRecommendations(scenario, speeds, allVms), [scenario, speeds, allVms]);
    if (!cheapestForSpeed) {
        return (React.createElement(Card, { className: "border-border bg-card shadow-sm" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold text-foreground" },
                    React.createElement(Star, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                    "Recommendation")),
            React.createElement(CardContent, { className: "pt-0" },
                React.createElement("p", { className: "text-xs text-muted-foreground" }, "Set a non-zero per-GPU speed below to see VM recommendations for this scenario's target speed."))));
    }
    const sameVm = fastestPerDollar && cheapestForSpeed.vm.name === fastestPerDollar.vm.name;
    const currentHourlyCost = result.hourlyRate;
    const savingsPct = currentHourlyCost > 0
        ? ((currentHourlyCost - cheapestForSpeed.hourlyCost) /
            currentHourlyCost) *
            100
        : 0;
    return (React.createElement(Card, { className: "border-border bg-card shadow-sm" },
        React.createElement(CardHeader, { className: "flex flex-row items-center justify-between gap-2 space-y-0 pb-3" },
            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold text-foreground" },
                React.createElement(Star, { className: "h-4 w-4 text-warning", "aria-hidden": true }),
                "Recommendation for ",
                formatSpeed(result.totalSpeedMnos),
                React.createElement(InfoTooltip, { content: "Given your scenario's target speed and priority, this is the VM size that minimises hourly cost. The 'best speed-per-$' card shows the best work-per-dollar ratio.", size: 12 })),
            React.createElement(Badge, { variant: "outline", className: "text-2xs" }, scenario.priority === "lowpriority" ? "Low priority" : "Dedicated")),
        React.createElement(CardContent, { className: "space-y-3 pt-0" },
            React.createElement("div", { className: cn("grid grid-cols-1 gap-3", sameVm ? "" : "md:grid-cols-2") },
                React.createElement(RecommendationTile, { kind: "cheapest", rec: cheapestForSpeed, onApply: () => onApply(cheapestForSpeed.vm), savingsPct: savingsPct }),
                !sameVm && fastestPerDollar && (React.createElement(RecommendationTile, { kind: "value", rec: fastestPerDollar, onApply: () => onApply(fastestPerDollar.vm), savingsPct: 0 }))),
            alternatives.length > 1 && (React.createElement("div", null,
                React.createElement("div", { className: "mb-1 flex items-center justify-between" },
                    React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "All sized options"),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Sorted by $/hour")),
                React.createElement(Table, { "aria-label": "All VM size alternatives to hit target speed" },
                    React.createElement(TableHeader, null,
                        React.createElement(TableRow, null,
                            React.createElement(TableHead, { scope: "col" }, "VM"),
                            React.createElement(TableHead, { scope: "col", className: "text-center" }, "GPU"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "Nodes"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "GPUs"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "Speed"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "$/hour"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" },
                                "Cost (",
                                scenario.hours,
                                "h)"),
                            React.createElement(TableHead, { scope: "col", "aria-label": "Apply", className: "w-[68px]" }))),
                    React.createElement(TableBody, null, alternatives.map((alt) => {
                        const isBest = alt.vm.name === cheapestForSpeed.vm.name;
                        return (React.createElement(TableRow, { key: alt.vm.name, className: cn(isBest && "bg-success/5") },
                            React.createElement(TableCell, { className: "font-semibold text-foreground" },
                                vmShortName(alt.vm.name),
                                isBest && (React.createElement(Badge, { variant: "success", className: "ml-2 px-1.5 py-0 text-2xs" }, "Best"))),
                            React.createElement(TableCell, { className: "text-center" },
                                React.createElement("span", { className: cn("inline-flex items-center rounded px-2 py-0.5 text-2xs font-bold", gpuTypeBadgeClass(alt.vm.gpuType)) }, alt.vm.gpuType)),
                            React.createElement(TableCell, { className: "text-right tabular-nums" }, alt.nodesNeeded),
                            React.createElement(TableCell, { className: "text-right tabular-nums text-primary" }, alt.totalGpus),
                            React.createElement(TableCell, { className: "text-right tabular-nums text-info" }, formatSpeed(alt.totalSpeedMnos)),
                            React.createElement(TableCell, { className: "text-right tabular-nums text-warning" }, formatCurrency(alt.hourlyCost)),
                            React.createElement(TableCell, { className: "text-right font-semibold tabular-nums text-success" }, formatCurrency(alt.totalCost)),
                            React.createElement(TableCell, { className: "text-right" },
                                React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => onApply(alt.vm), "aria-label": `Apply ${alt.vm.name} to scenario` }, "Apply"))));
                    }))))))));
};
const RecommendationTile = ({ kind, rec, onApply, savingsPct }) => {
    const Icon = kind === "cheapest" ? Star : Zap;
    const label = kind === "cheapest" ? "Cheapest for target speed" : "Best speed-per-$";
    const tone = kind === "cheapest" ? "success" : "info";
    return (React.createElement("div", { className: cn("rounded-md border p-3", kind === "cheapest"
            ? "border-success/30 bg-success/5"
            : "border-info/30 bg-info/5") },
        React.createElement("div", { className: "mb-2 flex items-center gap-2" },
            React.createElement(Icon, { className: cn("h-4 w-4", tone === "success" ? "text-success" : "text-info"), "aria-hidden": true }),
            React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, label),
            kind === "cheapest" && savingsPct > 0.5 && (React.createElement(Badge, { variant: "success", className: "ml-auto px-1.5 py-0 text-2xs" },
                "-",
                savingsPct.toFixed(0),
                "% vs current"))),
        React.createElement("div", { className: "mb-2 flex items-baseline gap-2" },
            React.createElement("span", { className: "text-base font-bold text-foreground" }, vmShortName(rec.vm.name)),
            React.createElement("span", { className: cn("inline-flex items-center rounded px-1.5 py-0 text-2xs font-bold", gpuTypeBadgeClass(rec.vm.gpuType)) }, rec.vm.gpuType)),
        React.createElement("div", { className: "mb-2 grid grid-cols-3 gap-2 text-2xs" },
            React.createElement("div", null,
                React.createElement("span", { className: "block text-muted-foreground" }, "Nodes"),
                React.createElement("span", { className: "font-bold tabular-nums" }, rec.nodesNeeded)),
            React.createElement("div", null,
                React.createElement("span", { className: "block text-muted-foreground" }, "GPUs"),
                React.createElement("span", { className: "font-bold tabular-nums text-primary" }, rec.totalGpus)),
            React.createElement("div", null,
                React.createElement("span", { className: "block text-muted-foreground" }, "$/hour"),
                React.createElement("span", { className: "font-bold tabular-nums text-warning" }, formatCurrency(rec.hourlyCost)))),
        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: onApply, "aria-label": `Apply ${rec.vm.name} configuration to scenario A` },
            React.createElement(Check, { "aria-hidden": true }),
            " Use this config")));
};
const RegionCard = ({ summary, grandTotalSpeed, }) => {
    const pct = grandTotalSpeed > 0
        ? ((summary.totalSpeed / grandTotalSpeed) * 100).toFixed(1)
        : "0";
    return (React.createElement(Card, { className: "overflow-hidden border-border bg-card shadow-sm transition-colors duration-200 ease-out hover:border-primary/40 motion-reduce:transition-none" },
        React.createElement(CardHeader, { className: "flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border bg-surface-overlay px-4 py-3" },
            React.createElement("div", { className: "flex items-center gap-2.5" },
                React.createElement(Globe, { className: "h-[18px] w-[18px] text-primary", "aria-hidden": true }),
                React.createElement(CardTitle, { className: "text-sm font-semibold text-foreground" }, summary.region),
                React.createElement(RegionBadge, { region: summary.region, gpu: true, tone: "info" })),
            React.createElement("div", { className: "flex flex-wrap items-center gap-3" },
                React.createElement("span", { className: "inline-flex items-center rounded-full bg-primary/15 px-2.5 py-0.5 text-2xs font-bold text-primary tabular-nums", "aria-label": `${summary.totalGpus} GPUs in ${summary.region}` },
                    summary.totalGpus,
                    " GPUs"),
                React.createElement("span", { className: "inline-flex items-center rounded-full bg-info/15 px-2.5 py-0.5 text-2xs font-bold text-info tabular-nums", "aria-label": `Total speed ${formatSpeed(summary.totalSpeed)}` }, formatSpeed(summary.totalSpeed)),
                React.createElement("span", { className: "text-2xs text-muted-foreground tabular-nums" },
                    pct,
                    "% of total"))),
        React.createElement(CardContent, { className: "p-0" },
            React.createElement(Table, { "aria-label": `VM breakdown for ${summary.region}` },
                React.createElement(TableCaption, { className: "sr-only mt-0" },
                    "VM size breakdown for region ",
                    summary.region),
                React.createElement(TableHeader, null,
                    React.createElement(TableRow, null,
                        React.createElement(TableHead, { scope: "col" }, "VM Size"),
                        React.createElement(TableHead, { scope: "col", className: "text-center" }, "GPU Type"),
                        React.createElement(TableHead, { scope: "col", className: "text-right" }, "Nodes"),
                        React.createElement(TableHead, { scope: "col", className: "text-right" }, "GPUs/Node"),
                        React.createElement(TableHead, { scope: "col", className: "text-right" }, "Total GPUs"),
                        React.createElement(TableHead, { scope: "col", className: "text-right" }, "Speed/GPU"),
                        React.createElement(TableHead, { scope: "col", className: "text-right" }, "Total Speed"))),
                React.createElement(TableBody, null, summary.vmBreakdown.map((vm) => (React.createElement(TableRow, { key: vm.vmSize },
                    React.createElement(TableCell, { className: "font-semibold text-foreground" }, vm.vmShort),
                    React.createElement(TableCell, { className: "text-center" },
                        React.createElement("span", { className: cn("inline-flex items-center rounded px-2 py-0.5 text-2xs font-bold", gpuTypeBadgeClass(vm.gpuType)) }, vm.gpuType)),
                    React.createElement(TableCell, { className: "text-right tabular-nums" }, vm.nodeCount),
                    React.createElement(TableCell, { className: "text-right tabular-nums text-muted-foreground" }, vm.gpuCount),
                    React.createElement(TableCell, { className: "text-right font-bold tabular-nums text-primary" }, vm.totalGpus),
                    React.createElement(TableCell, { className: "text-right tabular-nums text-muted-foreground" }, vm.speedPerGpu),
                    React.createElement(TableCell, { className: "text-right font-bold tabular-nums text-info" }, formatSpeed(vm.totalSpeed))))))))));
};
// ---------------------------------------------------------------------------
// GPU sparkline
// ---------------------------------------------------------------------------
const GpuRegionSparkline = ({ summaries, }) => {
    var _a, _b, _c, _d;
    const sorted = React.useMemo(() => [...summaries].sort((a, b) => b.totalGpus - a.totalGpus), [summaries]);
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
    return (React.createElement(Card, { className: "border-border bg-card shadow-sm" },
        React.createElement(CardHeader, { className: "pb-3" },
            React.createElement(CardTitle, { className: "text-sm font-semibold text-foreground" }, "GPU Count by Region")),
        React.createElement(CardContent, { className: "flex flex-wrap items-center gap-4 pt-0" },
            React.createElement("svg", { width: width, height: height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `GPU count across ${sorted.length} regions, ranging from ${(_b = (_a = sorted[sorted.length - 1]) === null || _a === void 0 ? void 0 : _a.totalGpus) !== null && _b !== void 0 ? _b : 0} to ${(_d = (_c = sorted[0]) === null || _c === void 0 ? void 0 : _c.totalGpus) !== null && _d !== void 0 ? _d : 0}`, className: "overflow-visible" },
                sorted.length > 1 && (React.createElement("polyline", { points: points, fill: "none", strokeWidth: 2, className: "stroke-primary" })),
                sorted.map((s, i) => {
                    const x = sorted.length === 1 ? width / 2 : i * stepX;
                    const y = height - (s.totalGpus / max) * height;
                    return (React.createElement("circle", { key: s.region, cx: x, cy: y, r: 2.5, className: "fill-primary" },
                        React.createElement("title", null, `${s.region}: ${s.totalGpus} GPUs`)));
                })),
            React.createElement("div", { className: "flex flex-wrap gap-1" }, sorted.map((s) => (React.createElement("span", { key: s.region, className: "inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-2xs tabular-nums text-primary", title: `${s.region}: ${s.totalGpus} GPUs` },
                React.createElement("span", { className: "font-semibold" }, s.region),
                React.createElement("span", { className: "ml-1 text-primary/70" }, s.totalGpus))))))));
};
// ---------------------------------------------------------------------------
// Preset chip row
// ---------------------------------------------------------------------------
const PresetChipRow = ({ onPick, activeId }) => (React.createElement(Card, { className: "border-border bg-card shadow-sm" },
    React.createElement(CardHeader, { className: "flex flex-row items-center justify-between gap-2 space-y-0 pb-3" },
        React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold text-foreground" },
            React.createElement(Library, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
            "Workload presets",
            React.createElement(InfoTooltip, { content: "One-click scenarios for common GPU workload shapes. Picking a preset replaces all five form fields in Scenario A.", size: 12 })),
        React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Click a preset to seed Scenario A")),
    React.createElement(CardContent, { className: "flex flex-wrap gap-2 pt-0" }, SCENARIO_PRESETS.map((p) => {
        const Icon = p.icon;
        const isActive = activeId === p.id;
        return (React.createElement("button", { key: p.id, type: "button", onClick: () => onPick(p), "aria-label": `Apply preset: ${p.label}. ${p.description}`, "aria-pressed": isActive, className: cn("group inline-flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", isActive
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card hover:border-primary/40 hover:bg-surface-overlay") },
            React.createElement(Icon, { className: cn("mt-0.5 h-4 w-4 shrink-0", isActive ? "text-primary" : "text-muted-foreground"), "aria-hidden": true }),
            React.createElement("span", { className: "flex flex-col" },
                React.createElement("span", { className: "text-xs font-semibold text-foreground" }, p.label),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, p.description))));
    }))));
// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const GpuCalculatorPageInner = () => {
    var _a;
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
        "c.gpu": "",
        "c.count": String(DEFAULT_COUNT),
        "c.region": DEFAULT_REGION,
        "c.hours": String(DEFAULT_HOURS),
        "c.priority": DEFAULT_PRIORITY,
        compare: "",
        target: "",
        /** Which slot the 1/2/3 hotkey last focused. Purely a UI hint. */
        focus: "a",
    });
    const compareMode = React.useMemo(() => parseCompareMode(asStr(urlState.compare)), [urlState.compare]);
    const compareOn = compareMode !== "off";
    const focusedSlot = React.useMemo(() => {
        const raw = asStr(urlState.focus);
        if (raw === "b" || raw === "c")
            return raw;
        return "a";
    }, [urlState.focus]);
    // Memoize the raw scenario records so downstream useMemo dependencies (e.g.
    // recommendation cards keyed on `scenario`) don't re-fire every render just
    // because we built a new object literal.
    const rawA = React.useMemo(() => ({
        gpu: asStr(urlState["a.gpu"]),
        count: asStr(urlState["a.count"]) || String(DEFAULT_COUNT),
        region: asStr(urlState["a.region"]) || DEFAULT_REGION,
        hours: asStr(urlState["a.hours"]) || String(DEFAULT_HOURS),
        priority: asStr(urlState["a.priority"]) || DEFAULT_PRIORITY,
    }), [
        urlState["a.gpu"],
        urlState["a.count"],
        urlState["a.region"],
        urlState["a.hours"],
        urlState["a.priority"],
    ]);
    const rawB = React.useMemo(() => ({
        gpu: asStr(urlState["b.gpu"]),
        count: asStr(urlState["b.count"]) || String(DEFAULT_COUNT),
        region: asStr(urlState["b.region"]) || DEFAULT_REGION,
        hours: asStr(urlState["b.hours"]) || String(DEFAULT_HOURS),
        priority: asStr(urlState["b.priority"]) || DEFAULT_PRIORITY,
    }), [
        urlState["b.gpu"],
        urlState["b.count"],
        urlState["b.region"],
        urlState["b.hours"],
        urlState["b.priority"],
    ]);
    const rawC = React.useMemo(() => ({
        gpu: asStr(urlState["c.gpu"]),
        count: asStr(urlState["c.count"]) || String(DEFAULT_COUNT),
        region: asStr(urlState["c.region"]) || DEFAULT_REGION,
        hours: asStr(urlState["c.hours"]) || String(DEFAULT_HOURS),
        priority: asStr(urlState["c.priority"]) || DEFAULT_PRIORITY,
    }), [
        urlState["c.gpu"],
        urlState["c.count"],
        urlState["c.region"],
        urlState["c.hours"],
        urlState["c.priority"],
    ]);
    const targetGnos = asStr(urlState["target"]);
    const updateScenario = React.useCallback((group, patch) => {
        const next = {};
        for (const key of Object.keys(patch)) {
            const raw = patch[key];
            if (raw === undefined)
                continue;
            next[`${group}.${key}`] = raw;
        }
        setUrlState(next);
    }, [setUrlState]);
    const updateScenarioA = React.useCallback((patch) => updateScenario("a", patch), [updateScenario]);
    const updateScenarioB = React.useCallback((patch) => updateScenario("b", patch), [updateScenario]);
    const updateScenarioC = React.useCallback((patch) => updateScenario("c", patch), [updateScenario]);
    const setTargetGnos = React.useCallback((v) => {
        setUrlState({ target: v });
    }, [setUrlState]);
    const enableCompare = React.useCallback(() => {
        // When opening compare, seed B from A so the user starts from a sensible
        // delta and can edit one knob at a time.
        setUrlState({
            compare: "ab",
            "b.gpu": rawA.gpu || DEFAULT_GPU_TYPE,
            "b.count": rawA.count,
            "b.region": rawA.region,
            "b.hours": rawA.hours,
            "b.priority": parseScenarioPriority(rawA.priority),
            focus: "b",
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
            "c.gpu": "",
            "c.count": String(DEFAULT_COUNT),
            "c.region": DEFAULT_REGION,
            "c.hours": String(DEFAULT_HOURS),
            "c.priority": DEFAULT_PRIORITY,
            focus: "",
        });
    }, [setUrlState]);
    const addScenarioC = React.useCallback(() => {
        // Seed C from B (or A if B is empty) so the new column starts close to
        // the user's most-recent thinking and they can adjust one parameter.
        const seed = rawB.gpu ? rawB : rawA;
        setUrlState({
            compare: "abc",
            "c.gpu": seed.gpu || DEFAULT_GPU_TYPE,
            "c.count": seed.count,
            "c.region": seed.region,
            "c.hours": seed.hours,
            "c.priority": parseScenarioPriority(seed.priority),
            focus: "c",
        });
    }, [
        setUrlState,
        rawA.gpu,
        rawA.count,
        rawA.region,
        rawA.hours,
        rawA.priority,
        rawB.gpu,
        rawB.count,
        rawB.region,
        rawB.hours,
        rawB.priority,
    ]);
    const removeScenarioB = React.useCallback(() => {
        // Drop B but keep C if it exists — collapse C into B so the URL stays
        // contiguous (compare=ab with the former-C values).
        if (compareMode === "abc") {
            setUrlState({
                compare: "ab",
                "b.gpu": rawC.gpu,
                "b.count": rawC.count,
                "b.region": rawC.region,
                "b.hours": rawC.hours,
                "b.priority": parseScenarioPriority(rawC.priority),
                "c.gpu": "",
                "c.count": String(DEFAULT_COUNT),
                "c.region": DEFAULT_REGION,
                "c.hours": String(DEFAULT_HOURS),
                "c.priority": DEFAULT_PRIORITY,
                focus: "b",
            });
        }
        else {
            disableCompare();
        }
    }, [
        compareMode,
        setUrlState,
        disableCompare,
        rawC.gpu,
        rawC.count,
        rawC.region,
        rawC.hours,
        rawC.priority,
    ]);
    const removeScenarioC = React.useCallback(() => {
        setUrlState({
            compare: "ab",
            "c.gpu": "",
            "c.count": String(DEFAULT_COUNT),
            "c.region": DEFAULT_REGION,
            "c.hours": String(DEFAULT_HOURS),
            "c.priority": DEFAULT_PRIORITY,
            focus: "b",
        });
    }, [setUrlState]);
    const setFocusedSlot = React.useCallback((slot) => {
        // Strip `focus=a` from the URL when collapsing back to A so a freshly
        // shared link does not carry a redundant default. Non-A values stay
        // in the URL so a link that opens with B/C focused round-trips.
        setUrlState({ focus: slot === "a" ? "" : slot });
        if (typeof document === "undefined")
            return;
        // Defer the focus() until React has had a chance to render the new
        // scenario card (some hotkeys also widen the compare mode).
        requestAnimationFrame(() => {
            const el = document.getElementById(`scenario-card-${slot}`);
            if (el) {
                el.focus({ preventScroll: false });
                el.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
        });
    }, [setUrlState]);
    const pickDefaultGpu = React.useCallback(() => {
        setUrlState({ "a.gpu": DEFAULT_GPU_TYPE });
    }, [setUrlState]);
    const applyPreset = React.useCallback((p) => {
        setUrlState({
            "a.gpu": p.scenario.gpu,
            "a.count": p.scenario.count,
            "a.region": p.scenario.region,
            "a.hours": p.scenario.hours,
            "a.priority": parseScenarioPriority(p.scenario.priority),
        });
    }, [setUrlState]);
    // Detect whether the current Scenario A matches any preset exactly so the
    // chip can render its "active" affordance.
    const activePresetId = React.useMemo(() => {
        for (const p of SCENARIO_PRESETS) {
            if (p.scenario.gpu === rawA.gpu &&
                p.scenario.count === rawA.count &&
                p.scenario.region === rawA.region &&
                p.scenario.hours === rawA.hours &&
                p.scenario.priority === rawA.priority) {
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
            "c.gpu": "",
            "c.count": String(DEFAULT_COUNT),
            "c.region": DEFAULT_REGION,
            "c.hours": String(DEFAULT_HOURS),
            "c.priority": DEFAULT_PRIORITY,
            compare: "",
            target: "",
            focus: "",
        });
    }, [setUrlState]);
    // ----- Editable GPU speeds (drives all calculations) ---------------------
    // Speeds are seeded from defaults, then overlaid with anything the operator
    // previously stored in localStorage so a returning visitor doesn't have to
    // re-enter their per-GPU benchmark numbers on every page load. The
    // persisted shape is a plain `{ gpuType: speed }` map so the encoded JSON
    // stays human-readable in DevTools (Map serializes weirdly).
    const [speedOverrides, setSpeedOverrides] = usePersistedState(SPEED_OVERRIDES_KEY, {}, {
        version: 1,
        migrate: (raw) => sanitizeSpeedOverrides(raw),
    });
    // Merge defaults + overrides into a render-stable Map keyed by gpuType.
    const speeds = React.useMemo(() => {
        const m = new Map();
        for (const s of DEFAULT_GPU_SPEEDS)
            m.set(s.gpuType, s.defaultSpeed);
        for (const [k, v] of Object.entries(speedOverrides))
            m.set(k, v);
        return m;
    }, [speedOverrides]);
    const [validation, setValidation] = React.useState({
        invalid: [],
        extreme: [],
        rawInputs: new Map(),
    });
    const updateSpeed = React.useCallback((gpuType, value) => {
        const trimmed = (value !== null && value !== void 0 ? value : "").trim();
        const num = parseFloat(trimmed);
        const isInvalid = trimmed === "" || isNaN(num) || num < 0;
        const isExtreme = !isInvalid && num > MAX_REASONABLE_SPEED;
        setValidation((prev) => {
            const nextInvalid = new Set(prev.invalid);
            const nextExtreme = new Set(prev.extreme);
            const nextRaw = new Map(prev.rawInputs);
            nextRaw.set(gpuType, trimmed);
            if (isInvalid)
                nextInvalid.add(gpuType);
            else
                nextInvalid.delete(gpuType);
            if (isExtreme)
                nextExtreme.add(gpuType);
            else
                nextExtreme.delete(gpuType);
            return {
                invalid: Array.from(nextInvalid),
                extreme: Array.from(nextExtreme),
                rawInputs: nextRaw,
            };
        });
        if (!isInvalid && !isExtreme) {
            setSpeedOverrides((prev) => (Object.assign(Object.assign({}, prev), { [gpuType]: num })));
        }
    }, [setSpeedOverrides]);
    const resetSpeeds = React.useCallback(() => {
        setSpeedOverrides({});
        setValidation({ invalid: [], extreme: [], rawInputs: new Map() });
    }, [setSpeedOverrides]);
    // ----- Saved scenarios (persisted) ---------------------------------------
    const [savedScenarios, setSavedScenarios] = usePersistedState(SAVED_SCENARIOS_KEY, [], {
        version: 1,
        migrate: (raw) => sanitizeSavedScenarios(raw),
    });
    // Inline-name dialog state replaces window.prompt — non-blocking and
    // doesn't get suppressed by every modern browser's anti-modal heuristics.
    const [saveNameDraft, setSaveNameDraft] = React.useState(null);
    const beginSaveScenario = React.useCallback(() => {
        if (!rawA.gpu)
            return;
        const suggested = `${rawA.gpu} ×${clampInt(rawA.count, 1, MAX_GPU_COUNT, 1)} @ ${rawA.region}`;
        setSaveNameDraft(suggested);
    }, [rawA]);
    const commitSaveScenario = React.useCallback(() => {
        if (saveNameDraft == null)
            return;
        const name = saveNameDraft.trim();
        if (!name || !rawA.gpu) {
            setSaveNameDraft(null);
            return;
        }
        const next = {
            name,
            scenario: Object.assign({}, rawA),
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
    const applySavedScenario = React.useCallback((s) => {
        setUrlState({
            "a.gpu": s.scenario.gpu,
            "a.count": s.scenario.count,
            "a.region": s.scenario.region,
            "a.hours": s.scenario.hours,
            "a.priority": parseScenarioPriority(s.scenario.priority),
        });
    }, [setUrlState]);
    const deleteSavedScenario = React.useCallback((name) => {
        setSavedScenarios((prev) => prev.filter((s) => s.name !== name));
    }, [setSavedScenarios]);
    // Memoised newest-first ordering. Pulling this out of the dropdown's JSX
    // avoids re-sorting on every parent render (the unmemoised
    // `[...savedScenarios].sort(...)` was a small but real hotspot when the
    // recommendation table recomputed).
    const sortedSavedScenarios = React.useMemo(() => [...savedScenarios].sort((a, b) => { var _a, _b; return ((_a = b.savedAt) !== null && _a !== void 0 ? _a : "").localeCompare((_b = a.savedAt) !== null && _b !== void 0 ? _b : ""); }), [savedScenarios]);
    // ---- JSON round-trip for saved scenarios --------------------------------
    // Serialises the current saved-scenarios list as JSON so the operator can
    // copy it to another tab / share it / archive it. Import accepts both the
    // list shape and our jsonMetadata export shape (where a single scenario
    // sits under `scenarioA`).
    const savedScenariosJson = React.useMemo(() => JSON.stringify(savedScenarios, null, 2), [savedScenarios]);
    const [importDraft, setImportDraft] = React.useState(null);
    const [importError, setImportError] = React.useState(null);
    const beginImport = React.useCallback(() => {
        setImportDraft("");
        setImportError(null);
    }, []);
    const cancelImport = React.useCallback(() => {
        setImportDraft(null);
        setImportError(null);
    }, []);
    const commitImport = React.useCallback(() => {
        if (importDraft == null)
            return;
        const trimmed = importDraft.trim();
        if (!trimmed) {
            setImportError("Paste a JSON payload to import.");
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch (err) {
            setImportError(`Could not parse JSON: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        // Accept either: a plain array of SavedScenario, OR an object with a
        // `savedScenarios` key, OR our ExportMenu jsonMetadata shape (single
        // scenarioA/scenarioB/scenarioC — wrap them on the fly).
        let candidate = parsed;
        if (parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            "savedScenarios" in parsed) {
            candidate = parsed.savedScenarios;
        }
        else if (parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            ("scenarioA" in parsed ||
                "scenarioB" in parsed ||
                "scenarioC" in parsed)) {
            const obj = parsed;
            const wrapped = [];
            const stamp = new Date().toISOString();
            const wrapOne = (s, suffix) => {
                var _a, _b, _c, _d, _e;
                if (!s || typeof s !== "object")
                    return;
                wrapped.push({
                    name: `Imported ${suffix} ${stamp.slice(0, 16)}`,
                    scenario: {
                        gpu: (_a = s.gpu) !== null && _a !== void 0 ? _a : "",
                        count: String((_b = s.count) !== null && _b !== void 0 ? _b : DEFAULT_COUNT),
                        region: (_c = s.region) !== null && _c !== void 0 ? _c : DEFAULT_REGION,
                        hours: String((_d = s.hours) !== null && _d !== void 0 ? _d : DEFAULT_HOURS),
                        priority: (_e = s.priority) !== null && _e !== void 0 ? _e : DEFAULT_PRIORITY,
                    },
                    savedAt: stamp,
                });
            };
            wrapOne(obj.scenarioA, "A");
            wrapOne(obj.scenarioB, "B");
            wrapOne(obj.scenarioC, "C");
            candidate = wrapped;
        }
        const sanitised = sanitizeSavedScenarios(candidate);
        if (sanitised.length === 0) {
            setImportError("No valid scenarios found in JSON. Expected an array of {name, scenario, savedAt}.");
            return;
        }
        // Merge: imported scenarios win on name collision.
        setSavedScenarios((prev) => {
            const byName = new Map(prev.map((s) => [s.name, s]));
            for (const s of sanitised)
                byName.set(s.name, s);
            return Array.from(byName.values()).slice(0, 50);
        });
        setImportDraft(null);
        setImportError(null);
    }, [importDraft, setSavedScenarios]);
    // ----- Section visibility prefs ------------------------------------------
    const [sectionPrefs, setSectionPrefs] = usePersistedState(SECTIONS_PREF_KEY, DEFAULT_SECTION_PREFS, {
        version: 1,
        migrate: (raw) => sanitizeSectionPrefs(raw),
    });
    const updateSectionPref = React.useCallback((patch) => {
        setSectionPrefs((prev) => (Object.assign(Object.assign({}, prev), patch)));
    }, [setSectionPrefs]);
    // ----- Live pool data view -----------------------------------------------
    const isLoading = state.poolInfos === undefined;
    const poolInfos = (_a = state.poolInfos) !== null && _a !== void 0 ? _a : [];
    const regionSummaries = React.useMemo(() => groupPoolsByRegion(poolInfos, speeds), [poolInfos, speeds]);
    const grandTotalGpus = regionSummaries.reduce((s, r) => s + r.totalGpus, 0);
    const grandTotalSpeed = regionSummaries.reduce((s, r) => s + r.totalSpeed, 0);
    const grandTotalNodes = regionSummaries.reduce((s, r) => s + r.vmBreakdown.reduce((ns, vm) => ns + vm.nodeCount, 0), 0);
    const regionCount = regionSummaries.length;
    const gpuTypeTotals = React.useMemo(() => {
        var _a;
        const totals = new Map();
        for (const r of regionSummaries) {
            for (const vm of r.vmBreakdown) {
                const prev = (_a = totals.get(vm.gpuType)) !== null && _a !== void 0 ? _a : { gpus: 0, speed: 0 };
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
    const scenarioB = React.useMemo(() => compareMode === "ab" || compareMode === "abc"
        ? resolveScenario(rawB)
        : null, [compareMode, rawB]);
    const scenarioC = React.useMemo(() => (compareMode === "abc" ? resolveScenario(rawC) : null), [compareMode, rawC]);
    const resultA = React.useMemo(() => (scenarioA ? computeScenarioResult(scenarioA, speeds) : null), [scenarioA, speeds]);
    const resultB = React.useMemo(() => (scenarioB ? computeScenarioResult(scenarioB, speeds) : null), [scenarioB, speeds]);
    const resultC = React.useMemo(() => (scenarioC ? computeScenarioResult(scenarioC, speeds) : null), [scenarioC, speeds]);
    // ----- Share link + formatted-result clipboard payloads ------------------
    // The <CopyButton /> from shared/copy-button.tsx owns the clipboard dance
    // and the "Copied" success flash — we just feed it strings.
    const shareLinkValue = typeof window !== "undefined" ? window.location.href : "";
    const formattedSummary = React.useMemo(() => {
        if (!scenarioA || !resultA)
            return "";
        const lines = [
            `GPU calculator — Scenario A`,
            `  ${scenarioA.gpu} ×${scenarioA.count} @ ${scenarioA.region} (${scenarioA.priority}, ${scenarioA.hours}h)`,
            `  Speed:        ${formatSpeed(resultA.totalSpeedMnos)}`,
            `  Hourly rate:  ${formatCurrency(resultA.hourlyRate)}`,
            `  Total cost:   ${formatCurrency(resultA.totalCost)}`,
            `  $/Gnos:       ${formatCurrencyCompact(resultA.costPerGnos)}`,
            `  Work window:  ${formatNumber(Math.round(resultA.workInWindowGnos))} Gnos`,
        ];
        if (scenarioB && resultB) {
            lines.push(``, `Scenario B`, `  ${scenarioB.gpu} ×${scenarioB.count} @ ${scenarioB.region} (${scenarioB.priority}, ${scenarioB.hours}h)`, `  Speed:        ${formatSpeed(resultB.totalSpeedMnos)}`, `  Hourly rate:  ${formatCurrency(resultB.hourlyRate)}`, `  Total cost:   ${formatCurrency(resultB.totalCost)}`);
        }
        if (scenarioC && resultC) {
            lines.push(``, `Scenario C`, `  ${scenarioC.gpu} ×${scenarioC.count} @ ${scenarioC.region} (${scenarioC.priority}, ${scenarioC.hours}h)`, `  Speed:        ${formatSpeed(resultC.totalSpeedMnos)}`, `  Hourly rate:  ${formatCurrency(resultC.hourlyRate)}`, `  Total cost:   ${formatCurrency(resultC.totalCost)}`);
        }
        return lines.join("\n");
    }, [scenarioA, resultA, scenarioB, resultB, scenarioC, resultC]);
    const exportRows = React.useMemo(() => {
        const rows = [];
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
        if (scenarioC && resultC) {
            rows.push({
                kind: "scenario",
                name: "Scenario C",
                gpuType: scenarioC.gpu,
                region: scenarioC.region,
                vmSize: "",
                nodes: 0,
                gpus: scenarioC.count,
                speedMnos: resultC.totalSpeedMnos,
                hourlyRateUsd: resultC.hourlyRate,
                totalCostUsd: resultC.totalCost,
                notes: `${scenarioC.priority}, ${scenarioC.hours}h`,
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
    const exportColumns = React.useMemo(() => [
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
    ], []);
    // ----- Apply a VM recommendation back into the scenario form -------------
    const applyVmToScenario = React.useCallback((vm) => {
        var _a, _b;
        if (!scenarioA)
            return;
        const speedPerGpu = (_a = speeds.get(vm.gpuType)) !== null && _a !== void 0 ? _a : 0;
        const targetSpeed = ((_b = speeds.get(scenarioA.gpu)) !== null && _b !== void 0 ? _b : 0) * scenarioA.count;
        if (speedPerGpu <= 0)
            return;
        const nodesNeeded = Math.ceil(targetSpeed / (speedPerGpu * vm.gpuCount));
        const newCount = Math.max(1, nodesNeeded * vm.gpuCount);
        setUrlState({
            "a.gpu": vm.gpuType,
            "a.count": String(newCount),
        });
    }, [scenarioA, speeds, setUrlState]);
    // ----- Hotkeys -----------------------------------------------------------
    // Hotkey-help overlay. Toggled with `?` so a discoverable, keyboard-only
    // user can find every chord without spelunking the source.
    const [showHotkeyHelp, setShowHotkeyHelp] = React.useState(false);
    // The shortcuts must not duplicate each other's logic; pull each into a
    // useCallback so the hook re-binds only when its own deps change.
    const hotkeyCopySummary = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!formattedSummary)
            return;
        try {
            if (typeof navigator !== "undefined" &&
                navigator.clipboard &&
                navigator.clipboard.writeText) {
                yield navigator.clipboard.writeText(formattedSummary);
            }
        }
        catch (_b) {
            // Silent failure — the visible CopyButton has its own fallback.
        }
    }), [formattedSummary]);
    const hotkeySaveScenarioA = React.useCallback(() => {
        if (!rawA.gpu)
            return;
        beginSaveScenario();
    }, [rawA.gpu, beginSaveScenario]);
    // `1` — focus Scenario A (also collapses compare so the single-scenario
    // view is reachable in one keystroke).
    const hotkeyFocusA = React.useCallback(() => {
        if (compareMode !== "off")
            disableCompare();
        setFocusedSlot("a");
    }, [compareMode, disableCompare, setFocusedSlot]);
    // `2` — focus Scenario B; if compare is off, open A+B compare.
    const hotkeyFocusB = React.useCallback(() => {
        if (compareMode === "off") {
            enableCompare();
            return;
        }
        setFocusedSlot("b");
    }, [compareMode, enableCompare, setFocusedSlot]);
    // `3` — focus Scenario C; if A+B exists, widen to A+B+C; if neither, open
    // both at once so a single keypress gets you to a full 3-way comparison.
    const hotkeyFocusC = React.useCallback(() => {
        if (compareMode === "off") {
            enableCompare();
            // The `enableCompare` setState is queued; widen on the next frame so
            // both URL writes coalesce into a single history entry.
            requestAnimationFrame(() => addScenarioC());
            return;
        }
        if (compareMode === "ab") {
            addScenarioC();
            return;
        }
        setFocusedSlot("c");
    }, [compareMode, enableCompare, addScenarioC, setFocusedSlot]);
    // Bind chords. `allowInInputs` stays false so typing a count of "2" inside
    // the GPU-count <Input /> never trips the compare hotkey — only chords
    // outside text fields fire.
    useShortcut("c", hotkeyCopySummary, { enabled: !!scenarioA });
    useShortcut("s", hotkeySaveScenarioA, { enabled: !!scenarioA });
    useShortcut("1", hotkeyFocusA, { enabled: !!scenarioA });
    useShortcut("2", hotkeyFocusB, { enabled: !!scenarioA });
    useShortcut("3", hotkeyFocusC, { enabled: !!scenarioA });
    // Note: Chrome/Firefox fire `event.key === "?"` + `event.shiftKey === true`
    // for the typical US-layout shift+/ press, so the canonical chord is
    // `"shift+?"`. We also register bare `"?"` for layouts (or virtual
    // keyboards) that emit the question mark without an asserted shift.
    useShortcut(["shift+?", "?"], () => setShowHotkeyHelp((prev) => !prev), { enabled: !!scenarioA });
    useShortcut("escape", () => setShowHotkeyHelp(false), { enabled: showHotkeyHelp });
    if (isLoading) {
        return (React.createElement("div", { className: "flex flex-col gap-4 py-4", "aria-busy": "true" },
            React.createElement(PageHeader, { title: "GPU Calculator", description: "What-if speed and cost scenarios over your GPU pools." }),
            React.createElement(SkeletonLoader, { variant: "stat-bar" }),
            React.createElement(SkeletonLoader, { variant: "card", cards: 3 }),
            React.createElement(SkeletonLoader, { variant: "table", rows: 6, columns: 7 })));
    }
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
        React.createElement(PageHeader, { title: "GPU Calculator", description: "Estimate speed and cost for a GPU scenario, and inspect live pool capacity by region." }, scenarioA && (React.createElement(React.Fragment, null,
            React.createElement("span", { className: "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm" },
                React.createElement(LinkIcon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Share link",
                React.createElement(CopyButton, { value: shareLinkValue, ariaLabel: "Copy a shareable link to this scenario", alwaysVisible: true, iconSize: 13 })),
            formattedSummary && (React.createElement("span", { className: "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm" },
                React.createElement(Calculator, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Copy summary",
                React.createElement(CopyButton, { value: formattedSummary, ariaLabel: "Copy the formatted calculation summary", alwaysVisible: true, iconSize: 13 }))),
            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: beginSaveScenario, "aria-label": "Save current scenario A under a name" },
                React.createElement(BookmarkPlus, { "aria-hidden": true }),
                "Save"),
            savedScenarios.length === 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: beginImport, "aria-label": "Import saved scenarios from JSON" },
                React.createElement(ClipboardPaste, { "aria-hidden": true }),
                "Import JSON")),
            savedScenarios.length > 0 && (React.createElement(DropdownMenu, null,
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", "aria-label": `Open saved scenarios (${savedScenarios.length})` },
                        React.createElement(Library, { "aria-hidden": true }),
                        "Saved (",
                        savedScenarios.length,
                        ")")),
                React.createElement(DropdownMenuContent, { align: "end", className: "w-72" },
                    React.createElement(DropdownMenuLabel, { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Saved scenarios"),
                    React.createElement(DropdownMenuSeparator, null),
                    sortedSavedScenarios.map((s) => (React.createElement(DropdownMenuItem, { key: s.name, onSelect: () => applySavedScenario(s), className: "flex items-start gap-2" },
                        React.createElement(Library, { className: "mt-0.5 text-muted-foreground", "aria-hidden": true }),
                        React.createElement("span", { className: "flex min-w-0 flex-1 flex-col" },
                            React.createElement("span", { className: "truncate text-xs font-semibold text-foreground" }, s.name),
                            React.createElement("span", { className: "truncate text-2xs text-muted-foreground" },
                                s.scenario.gpu,
                                " \u00D7",
                                s.scenario.count,
                                " @",
                                " ",
                                s.scenario.region,
                                ", ",
                                s.scenario.hours,
                                "h,",
                                " ",
                                s.scenario.priority)),
                        React.createElement("button", { type: "button", 
                            // Stop both pointerdown (Radix's chosen activation
                            // event) and click so deleting an item doesn't
                            // also fire the surrounding DropdownMenuItem's
                            // onSelect → applySavedScenario.
                            onPointerDown: (e) => e.stopPropagation(), onClick: (e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                deleteSavedScenario(s.name);
                            }, "aria-label": `Delete saved scenario ${s.name}`, className: "rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive" },
                            React.createElement(Trash2, { className: "h-3 w-3", "aria-hidden": true }))))),
                    React.createElement(DropdownMenuSeparator, null),
                    React.createElement("div", { className: "flex items-center justify-between gap-2 px-2 py-1.5" },
                        React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs font-medium text-muted-foreground" },
                            React.createElement(ClipboardPaste, { className: "h-3 w-3", "aria-hidden": true }),
                            "JSON"),
                        React.createElement("span", { className: "inline-flex items-center gap-1" },
                            React.createElement(CopyButton, { value: savedScenariosJson, ariaLabel: "Copy all saved scenarios as JSON", alwaysVisible: true, iconSize: 12 }),
                            React.createElement("button", { type: "button", onClick: beginImport, onPointerDown: (e) => e.stopPropagation(), "aria-label": "Paste JSON to import scenarios", className: "rounded px-2 py-0.5 text-2xs font-medium text-muted-foreground hover:bg-surface-overlay hover:text-foreground" }, "Import\u2026")))))),
            React.createElement(ExportMenu, { rows: exportRows, columns: exportColumns, filename: "gpu-calculator", jsonMetadata: {
                    scenarioA: scenarioA,
                    scenarioB: scenarioB !== null && scenarioB !== void 0 ? scenarioB : null,
                    scenarioC: scenarioC !== null && scenarioC !== void 0 ? scenarioC : null,
                    speeds: Object.fromEntries(speeds),
                    compareMode,
                } }),
            compareOn ? (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: disableCompare, "aria-label": "Stop comparing scenarios" },
                React.createElement(X, { "aria-hidden": true }),
                "Stop comparing")) : (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: enableCompare, "aria-label": "Compare a second scenario side by side" },
                React.createElement(ArrowRightLeft, { "aria-hidden": true }),
                "Compare")),
            React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => setShowHotkeyHelp((p) => !p), "aria-label": "Show keyboard shortcuts", "aria-pressed": showHotkeyHelp, title: "Keyboard shortcuts (?)" },
                React.createElement(Keyboard, { "aria-hidden": true })),
            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: resetAll, "aria-label": "Reset all scenario inputs to defaults" },
                React.createElement(RotateCcw, { "aria-hidden": true }),
                "Reset"),
            React.createElement(DropdownMenu, null,
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Toggle visible sections" },
                        React.createElement(Eye, { "aria-hidden": true }))),
                React.createElement(DropdownMenuContent, { align: "end" },
                    React.createElement(DropdownMenuLabel, { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Show sections"),
                    React.createElement(DropdownMenuSeparator, null),
                    React.createElement(DropdownMenuItem, { onSelect: (e) => {
                            e.preventDefault();
                            updateSectionPref({
                                showRecommendation: !sectionPrefs.showRecommendation,
                            });
                        } },
                        sectionPrefs.showRecommendation ? (React.createElement(Check, { "aria-hidden": true })) : (React.createElement(EyeOff, { "aria-hidden": true })),
                        "Recommendation"),
                    React.createElement(DropdownMenuItem, { onSelect: (e) => {
                            e.preventDefault();
                            updateSectionPref({
                                showLivePools: !sectionPrefs.showLivePools,
                            });
                        } },
                        sectionPrefs.showLivePools ? (React.createElement(Check, { "aria-hidden": true })) : (React.createElement(EyeOff, { "aria-hidden": true })),
                        "Live pool capacity"),
                    React.createElement(DropdownMenuItem, { onSelect: (e) => {
                            e.preventDefault();
                            updateSectionPref({
                                showVmReference: !sectionPrefs.showVmReference,
                            });
                        } },
                        sectionPrefs.showVmReference ? (React.createElement(Check, { "aria-hidden": true })) : (React.createElement(EyeOff, { "aria-hidden": true })),
                        "VM reference")))))),
        saveNameDraft != null && (React.createElement(Card, { role: "dialog", "aria-label": "Save scenario", className: "border-primary/30 bg-card shadow-sm" },
            React.createElement(CardContent, { className: "flex flex-wrap items-end gap-3 p-4" },
                React.createElement("div", { className: "flex flex-1 flex-col gap-1" },
                    React.createElement(Label, { htmlFor: "save-scenario-name", className: "text-xs" }, "Save scenario as"),
                    React.createElement(Input, { id: "save-scenario-name", autoFocus: true, value: saveNameDraft, onChange: (e) => setSaveNameDraft(e.target.value), onKeyDown: (e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                commitSaveScenario();
                            }
                            else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelSaveScenario();
                            }
                        }, "aria-label": "Scenario name", placeholder: "e.g. H100 \u00D78 baseline" })),
                React.createElement(Button, { type: "button", size: "sm", onClick: commitSaveScenario, disabled: !saveNameDraft.trim(), "aria-label": "Save scenario" },
                    React.createElement(Check, { "aria-hidden": true }),
                    " Save"),
                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: cancelSaveScenario, "aria-label": "Cancel saving scenario" },
                    React.createElement(X, { "aria-hidden": true }),
                    " Cancel")))),
        importDraft != null && (React.createElement(Card, { role: "dialog", "aria-label": "Import scenarios from JSON", className: "border-info/30 bg-card shadow-sm" },
            React.createElement(CardContent, { className: "flex flex-col gap-2 p-4" },
                React.createElement("div", { className: "flex items-center gap-2" },
                    React.createElement(ClipboardPaste, { className: "h-4 w-4 text-info", "aria-hidden": true }),
                    React.createElement(Label, { htmlFor: "import-json-textarea", className: "text-xs font-semibold" }, "Paste saved-scenarios JSON"),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        "accepts array, ",
                        `{savedScenarios:[]}`,
                        ", or exported jsonMetadata")),
                React.createElement("textarea", { id: "import-json-textarea", autoFocus: true, spellCheck: false, rows: 6, value: importDraft, onChange: (e) => {
                        setImportDraft(e.target.value);
                        if (importError)
                            setImportError(null);
                    }, onKeyDown: (e) => {
                        if (e.key === "Escape") {
                            e.preventDefault();
                            cancelImport();
                        }
                        else if ((e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
                            e.preventDefault();
                            commitImport();
                        }
                    }, placeholder: '[{"name":"H100 \u00D78","scenario":{"gpu":"H100","count":"8","region":"westus3","hours":"8","priority":"dedicated"},"savedAt":"2026-01-01T00:00:00Z"}]', "aria-label": "JSON payload to import", className: "w-full resize-y rounded-md border border-border bg-surface-overlay px-2 py-1 font-mono text-2xs leading-relaxed text-foreground transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40 motion-reduce:transition-none" }),
                importError && (React.createElement(Alert, { variant: "warning", role: "alert" },
                    React.createElement(TriangleAlert, { className: "h-4 w-4", "aria-hidden": true }),
                    React.createElement(AlertDescription, null, importError))),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", size: "sm", onClick: commitImport, disabled: !importDraft.trim(), "aria-label": "Import scenarios from JSON" },
                        React.createElement(Check, { "aria-hidden": true }),
                        " Import"),
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: cancelImport, "aria-label": "Cancel import" },
                        React.createElement(X, { "aria-hidden": true }),
                        " Cancel"),
                    React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" }, "Press Ctrl/Cmd+Enter to commit, Esc to cancel"))))),
        showHotkeyHelp && (React.createElement(Card, { role: "dialog", "aria-label": "Keyboard shortcuts", className: "border-primary/30 bg-card shadow-sm" },
            React.createElement(CardHeader, { className: "flex flex-row items-center justify-between gap-2 space-y-0 pb-2" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold text-foreground" },
                    React.createElement(Keyboard, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                    "Keyboard shortcuts"),
                React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => setShowHotkeyHelp(false), "aria-label": "Close keyboard-shortcut help" },
                    React.createElement(X, { "aria-hidden": true }))),
            React.createElement(CardContent, { className: "grid grid-cols-1 gap-1.5 pt-0 text-xs sm:grid-cols-2" },
                [
                    { keys: ["1"], label: "Focus Scenario A (collapse compare)" },
                    { keys: ["2"], label: "Focus Scenario B (open compare if off)" },
                    { keys: ["3"], label: "Focus Scenario C (widen to 3-way)" },
                    { keys: ["c"], label: "Copy formatted summary" },
                    { keys: ["s"], label: "Save Scenario A" },
                    { keys: ["?"], label: "Toggle this help overlay" },
                    { keys: ["Esc"], label: "Dismiss this help overlay" },
                ].map((row) => (React.createElement("div", { key: row.label, className: "flex items-center justify-between gap-3 rounded-md bg-surface-overlay px-3 py-1.5" },
                    React.createElement("span", { className: "text-muted-foreground" }, row.label),
                    React.createElement("span", { className: "flex items-center gap-1" }, row.keys.map((k) => (React.createElement("kbd", { key: k, className: "rounded border border-border bg-card px-1.5 py-0.5 font-mono text-2xs font-bold text-foreground" }, k))))))),
                React.createElement("p", { className: "sm:col-span-2 mt-1 text-2xs leading-relaxed text-muted-foreground" }, "Shortcuts ignore key presses inside text fields and dropdowns, so typing \"2\" into the GPU-count input does not flip the compare mode.")))),
        React.createElement(PresetChipRow, { onPick: applyPreset, activeId: activePresetId }),
        !scenarioA ? (React.createElement(EmptyState, { icon: Calculator, title: "Pick a GPU to begin", description: "Choose a GPU type and we will compute speed, $/hour, and total cost. Your selection lives in the URL so links are shareable.", action: {
                label: `Start with ${DEFAULT_GPU_TYPE}`,
                onClick: pickDefaultGpu,
                icon: Cpu,
            } })) : (React.createElement("div", { className: cn("flex flex-col gap-3", compareOn && scenarioB && "lg:flex-row") },
            React.createElement(ScenarioForm, { label: "A", cardId: "scenario-card-a", scenario: scenarioA, result: resultA, gpuOptions: gpuOptions, onChange: updateScenarioA, tone: "primary", focused: focusedSlot === "a" && compareOn, compareTo: compareOn && resultB ? resultB : undefined }),
            compareOn && scenarioB && (React.createElement(ScenarioForm, { label: "B", cardId: "scenario-card-b", scenario: scenarioB, result: resultB, gpuOptions: gpuOptions, onChange: updateScenarioB, onRemove: removeScenarioB, tone: "info", focused: focusedSlot === "b", compareTo: resultA !== null && resultA !== void 0 ? resultA : undefined })),
            compareMode === "abc" && scenarioC && (React.createElement(ScenarioForm, { label: "C", cardId: "scenario-card-c", scenario: scenarioC, result: resultC, gpuOptions: gpuOptions, onChange: updateScenarioC, onRemove: removeScenarioC, tone: "success", focused: focusedSlot === "c", compareTo: resultA !== null && resultA !== void 0 ? resultA : undefined })),
            compareMode === "ab" && scenarioA && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: addScenarioC, "aria-label": "Add scenario C for three-way comparison", className: "self-start lg:self-stretch" },
                React.createElement(Plus, { "aria-hidden": true }),
                " Add C")))),
        scenarioA && resultA && (React.createElement("div", { className: "grid grid-cols-1 gap-3 lg:grid-cols-2" },
            React.createElement(CostBreakdownCard, { scenario: scenarioA, result: resultA, speeds: speeds }),
            React.createElement(TargetWorkCard, { result: resultA, targetGnos: targetGnos, onChange: setTargetGnos }))),
        scenarioA && resultA && sectionPrefs.showRecommendation && (React.createElement(RecommendationCard, { scenario: scenarioA, result: resultA, speeds: speeds, allVms: allVms, onApply: applyVmToScenario })),
        (validation.invalid.length > 0 || validation.extreme.length > 0) && (React.createElement(Alert, { variant: "warning", role: "alert", "aria-live": "polite" },
            React.createElement(TriangleAlert, { className: "h-4 w-4", "aria-hidden": true }),
            React.createElement(AlertDescription, null,
                validation.invalid.length > 0 && (React.createElement("span", null,
                    "Enter a non-negative number for",
                    " ",
                    React.createElement("b", null, validation.invalid.join(", ")),
                    " speed. The previous value is still being used.")),
                validation.extreme.length > 0 && (React.createElement("span", null,
                    " ",
                    "Values above ",
                    MAX_REASONABLE_SPEED.toLocaleString(),
                    " Mnos/s for ",
                    React.createElement("b", null, validation.extreme.join(", ")),
                    " look unrealistic and were not applied."))))),
        React.createElement(Card, { className: "border-border bg-card shadow-sm" },
            React.createElement(CardHeader, { className: "flex flex-row items-center justify-between gap-2 space-y-0 pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold text-foreground" },
                    "GPU Speed Settings",
                    React.createElement("span", { className: "ml-1 text-xs font-normal text-muted-foreground" }, "(Mnos/s per GPU)"),
                    React.createElement(InfoTooltip, { content: "Mnos/s (mega-nodes-per-second) is the user-supplied benchmark unit for how many million node-evaluations a single GPU can run per second. Edits persist in localStorage.", size: 12 })),
                React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: resetSpeeds, "aria-label": "Reset GPU speeds to defaults" },
                    React.createElement(RotateCcw, { "aria-hidden": true }),
                    "Reset speeds")),
            React.createElement(CardContent, { className: "flex flex-wrap items-end gap-6 pt-0" }, DEFAULT_GPU_SPEEDS.map((gs) => {
                var _a;
                const fieldId = `gpu-speed-${gs.gpuType}`;
                const errorId = `${fieldId}-error`;
                const raw = validation.rawInputs.get(gs.gpuType);
                const displayValue = raw !== undefined
                    ? raw
                    : String((_a = speeds.get(gs.gpuType)) !== null && _a !== void 0 ? _a : gs.defaultSpeed);
                const isFieldInvalid = validation.invalid.includes(gs.gpuType);
                const isFieldExtreme = validation.extreme.includes(gs.gpuType);
                const errorMsg = isFieldInvalid
                    ? "Enter a non-negative number"
                    : isFieldExtreme
                        ? `Max ${MAX_REASONABLE_SPEED.toLocaleString()} Mnos/s`
                        : undefined;
                const hasError = isFieldInvalid || isFieldExtreme;
                return (React.createElement("div", { key: gs.gpuType, className: "flex items-center gap-2" },
                    React.createElement(Label, { htmlFor: fieldId, className: cn("min-w-[50px] cursor-pointer rounded px-2.5 py-1 text-center text-sm font-bold", gpuTypeBadgeClass(gs.gpuType)) }, gs.gpuType),
                    React.createElement("div", { className: "flex flex-col" },
                        React.createElement("div", { className: "relative" },
                            React.createElement(Input, { id: fieldId, value: displayValue, onChange: (e) => updateSpeed(gs.gpuType, e.target.value), type: "number", min: 0, max: MAX_REASONABLE_SPEED, step: 1, className: cn("w-[140px] pr-16 text-right font-semibold tabular-nums transition-shadow duration-200 ease-out focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none", hasError && "border-warning ring-1 ring-warning/40"), "aria-label": `${gs.gpuType} benchmark speed in Mnos per second per GPU`, "aria-invalid": hasError, "aria-describedby": errorMsg ? errorId : undefined }),
                            React.createElement("span", { className: "pointer-events-none absolute inset-y-0 right-2 flex items-center text-2xs text-muted-foreground", "aria-hidden": true }, "Mnos/s")),
                        errorMsg && (React.createElement("span", { id: errorId, className: "mt-1 text-2xs font-medium text-warning", role: "alert" }, errorMsg)),
                        React.createElement("span", { className: "mt-0.5 text-2xs text-muted-foreground" },
                            "default ",
                            gs.defaultSpeed))));
            }))),
        sectionPrefs.showLivePools && (React.createElement(React.Fragment, null,
            React.createElement("section", { "aria-label": "GPU calculator totals", "aria-live": "polite", "aria-atomic": "true", className: "flex flex-wrap gap-3" },
                React.createElement(StatCard, { icon: Globe, label: "Regions", value: String(regionCount), tone: "primary", tooltip: "Distinct Azure regions hosting active GPU pools." }),
                React.createElement(StatCard, { icon: Server, label: "Total Nodes", value: formatNumber(grandTotalNodes), tone: "info", tooltip: "Sum of dedicated + low-priority nodes across every active GPU pool." }),
                React.createElement(StatCard, { icon: Cpu, label: "Total GPUs", value: formatNumber(grandTotalGpus), tone: "warning", tooltip: "Nodes \u00D7 GPUs-per-node, across every active GPU pool." }),
                React.createElement(StatCard, { icon: Zap, label: "Total Speed", value: formatSpeed(grandTotalSpeed), tone: "success", sub: `${grandTotalGpus} GPUs × avg ${grandTotalGpus > 0 ? Math.round(grandTotalSpeed / grandTotalGpus) : 0} Mnos/s`, tooltip: "Sum of (per-GPU benchmark \u00D7 total GPUs) across every pool." })),
            regionSummaries.length > 0 && (React.createElement(GpuRegionSparkline, { summaries: regionSummaries })),
            gpuTypeTotals.size > 0 && (React.createElement("div", { className: "flex flex-wrap gap-3" }, Array.from(gpuTypeTotals.entries()).map(([gpuType, totals]) => (React.createElement(Card, { key: gpuType, className: "min-w-[180px] flex-1 border-border bg-card shadow-sm transition-colors duration-200 ease-out hover:border-primary/40 motion-reduce:transition-none" },
                React.createElement(CardContent, { className: "flex items-center gap-3 p-4" },
                    React.createElement("span", { className: cn("inline-flex items-center rounded px-2.5 py-1 text-sm font-bold", gpuTypeBadgeClass(gpuType)) }, gpuType),
                    React.createElement("div", null,
                        React.createElement("span", { className: "block text-lg font-bold leading-tight tabular-nums text-foreground" },
                            formatNumber(totals.gpus),
                            " GPUs"),
                        React.createElement("span", { className: "block text-xs tabular-nums text-info" }, formatSpeed(totals.speed))))))))))),
        sectionPrefs.showVmReference && (React.createElement(Card, { className: "border-border bg-card shadow-sm" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold text-foreground" },
                    "VM Reference",
                    React.createElement(InfoTooltip, { content: "All GPU VM sizes shipped in this catalogue. Speed/Node reflects the editable per-GPU benchmark \u00D7 GPUs/Node.", size: 12 }))),
            React.createElement(CardContent, { className: "p-0" },
                React.createElement(Table, { "aria-label": "GPU VM size reference" },
                    React.createElement(TableCaption, { className: "sr-only mt-0" }, "Reference table of GPU VM sizes and per-node speeds"),
                    React.createElement(TableHeader, null,
                        React.createElement(TableRow, null,
                            React.createElement(TableHead, { scope: "col" }, "VM Size"),
                            React.createElement(TableHead, { scope: "col", className: "text-center" }, "GPU"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "GPUs/Node"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "VRAM/GPU"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "vCPUs"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "RAM (GB)"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "Speed/Node"),
                            React.createElement(TableHead, { scope: "col", className: "text-right" }, "$/h (ded.)"))),
                    React.createElement(TableBody, null, allVms.map((vm) => {
                        var _a, _b;
                        const speedPerGpu = (_a = speeds.get(vm.gpuType)) !== null && _a !== void 0 ? _a : 0;
                        const speedPerNode = speedPerGpu * vm.gpuCount;
                        const hourlyCost = ((_b = HOURLY_RATE_PER_GPU[vm.gpuType]) !== null && _b !== void 0 ? _b : 0) * vm.gpuCount;
                        return (React.createElement(TableRow, { key: vm.name },
                            React.createElement(TableCell, { className: "font-semibold text-foreground" }, vmShortName(vm.name)),
                            React.createElement(TableCell, { className: "text-center" },
                                React.createElement("span", { className: cn("inline-flex items-center rounded px-2 py-0.5 text-2xs font-bold", gpuTypeBadgeClass(vm.gpuType)) }, vm.gpuType)),
                            React.createElement(TableCell, { className: "text-right tabular-nums" }, vm.gpuCount),
                            React.createElement(TableCell, { className: "text-right tabular-nums text-muted-foreground" },
                                vm.gpuMemoryGB,
                                " GB"),
                            React.createElement(TableCell, { className: "text-right tabular-nums text-muted-foreground" }, vm.vCPUs),
                            React.createElement(TableCell, { className: "text-right tabular-nums text-muted-foreground" }, vm.memoryGB),
                            React.createElement(TableCell, { className: "text-right font-bold tabular-nums text-info" }, formatSpeed(speedPerNode)),
                            React.createElement(TableCell, { className: "text-right font-semibold tabular-nums text-warning" }, formatCurrency(hourlyCost))));
                    })))))),
        sectionPrefs.showLivePools && (React.createElement("section", { "aria-label": "Per-region GPU breakdown", "aria-live": "polite" }, regionSummaries.length === 0 ? (React.createElement(EmptyState, { icon: Calculator, title: "No active GPU pools", description: "GPU calculations will appear once pools with nodes are discovered. Go to Pool Info and click Refresh." })) : (React.createElement("div", { className: "flex flex-col gap-3" },
            React.createElement("h2", { className: "m-0 text-base font-semibold text-foreground" },
                "Per-Region Breakdown",
                " ",
                React.createElement("span", { className: "text-xs font-normal text-muted-foreground tabular-nums" },
                    "(",
                    pluralize(regionCount, "region"),
                    ")")),
            regionSummaries.map((summary) => (React.createElement(RegionCard, { key: summary.region, summary: summary, grandTotalSpeed: grandTotalSpeed })))))))));
};
// Public export — wraps the inner page in an ErrorBoundary so a crash in any
// region card or VM table doesn't take down the whole dashboard.
export const GpuCalculatorPage = () => (React.createElement(ErrorBoundary, null,
    React.createElement(GpuCalculatorPageInner, null)));
//# sourceMappingURL=gpu-calculator-page.js.map