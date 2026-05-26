/**
 * Reusable VM-size picker driven by the live Microsoft.Compute/skus
 * catalog (the same data that powers the VM Catalog page).
 *
 * Single-select and multi-select variants share one component — the
 * caller picks via the `multi` prop. Used by:
 *   - Pool Creation page  (single-select for "manual" mode, multi for smart mode)
 *   - Nodes page          (single-select scoped to a region filter)
 *
 * Why a shared component instead of two pages each rolling their own:
 *   The cache key + filter contract is non-trivial (GPU-only vs all,
 *   Batch-supported probe per region, free-text search). Centralizing
 *   keeps the three pages in lockstep when we change scope rules.
 *
 * Data flow:
 *   subscriptionId → cachePeek(vmSkusCacheKey) → render rows immediately.
 *   No network call here — the boot prefetch in dashboard-shell already
 *   warms the cache; if the catalog hasn't been loaded yet, we render
 *   "Open VM Catalog to populate" and link out.
 */
import * as React from "react";
import { Check, ChevronDown, Cpu, ExternalLink, Search, } from "lucide-react";
// COORDINATOR: this picker no longer reaches for `useNavigate` directly.
// Navigation now flows through the dashboard outlet context so cross-page
// routing has one canonical entry point. When rendered outside the outlet
// (e.g. unit tests / storybook) the helper degrades to a silent no-op.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger, } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { cachePeek, subscribeQuotaCache, vmSkusCacheKey, } from "../../services/quota-service";
import { useDashboardOutletContext } from "../page-router";
import { classifyGpu, distinctGpuTypes } from "./gpu-classifier";
// ---------------------------------------------------------------------------
// Hook — reactive cache reader
// ---------------------------------------------------------------------------
function useCatalogSnapshot(subscriptionId, gpuOnly) {
    const [version, setVersion] = React.useState(0);
    React.useEffect(() => {
        return subscribeQuotaCache((key) => {
            if (!subscriptionId ||
                key === "*" ||
                key === vmSkusCacheKey(subscriptionId, gpuOnly)) {
                setVersion((n) => n + 1);
            }
        });
    }, [subscriptionId, gpuOnly]);
    return React.useMemo(() => {
        if (!subscriptionId) {
            return { skus: [], fetchedAt: null, cacheHit: false };
        }
        const peek = cachePeek(vmSkusCacheKey(subscriptionId, gpuOnly));
        if (!peek) {
            return { skus: [], fetchedAt: null, cacheHit: false };
        }
        return { skus: peek.value, fetchedAt: peek.fetchedAt, cacheHit: true };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subscriptionId, gpuOnly, version]);
}
// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const LiveVmSizeSelect = (props) => {
    // Pull `navigateToPage` from the dashboard outlet — same canonical
    // wiring contract used by every other page. Falls back to a no-op when
    // the outlet context isn't present (storybook / RTL).
    const outletCtx = useDashboardOutletContext();
    const navigateToPage = React.useCallback((path) => {
        if (outletCtx === null || outletCtx === void 0 ? void 0 : outletCtx.navigateToPage)
            outletCtx.navigateToPage(path);
    }, [outletCtx]);
    const gpuOnly = !props.includeCpu;
    const { skus, cacheHit } = useCatalogSnapshot(props.subscriptionId, gpuOnly);
    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const [gpuTypeFilter, setGpuTypeFilter] = React.useState("");
    const selectedSet = React.useMemo(() => {
        if (props.multi)
            return new Set(props.value);
        return props.value ? new Set([props.value]) : new Set();
    }, [props.multi, props.value]);
    const gpuTypes = React.useMemo(() => distinctGpuTypes(skus), [skus]);
    const rows = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        return skus
            .map((s) => ({ sku: s, gpu: classifyGpu(s) }))
            .filter(({ sku, gpu }) => {
            var _a, _b;
            if (gpuTypeFilter && gpu.gpuType !== gpuTypeFilter)
                return false;
            if (!q)
                return true;
            return (sku.name.toLowerCase().includes(q) ||
                ((_a = sku.family) !== null && _a !== void 0 ? _a : "").toLowerCase().includes(q) ||
                ((_b = gpu.gpuType) !== null && _b !== void 0 ? _b : "").toLowerCase().includes(q));
        })
            .sort((a, b) => {
            var _a, _b;
            // GPU count desc, then name
            const ag = (_a = a.gpu.gpuCount) !== null && _a !== void 0 ? _a : 0;
            const bg = (_b = b.gpu.gpuCount) !== null && _b !== void 0 ? _b : 0;
            if (ag !== bg)
                return bg - ag;
            return a.sku.name.localeCompare(b.sku.name);
        });
    }, [skus, search, gpuTypeFilter]);
    const triggerLabel = React.useMemo(() => {
        var _a, _b, _c;
        if (props.multi) {
            if (props.value.length === 0) {
                return (_a = props.placeholder) !== null && _a !== void 0 ? _a : "Pick VM sizes…";
            }
            if (props.value.length === 1)
                return props.value[0];
            return `${props.value.length} VMs · ${props.value[0]} +${props.value.length - 1}`;
        }
        return (_c = (_b = props.value) !== null && _b !== void 0 ? _b : props.placeholder) !== null && _c !== void 0 ? _c : "Pick a VM size…";
    }, [props.multi, props.value, props.placeholder]);
    const onPick = React.useCallback((vmSize) => {
        if (props.multi) {
            const next = props.value.includes(vmSize)
                ? props.value.filter((v) => v !== vmSize)
                : [...props.value, vmSize];
            props.onChange(next);
        }
        else {
            props.onChange(vmSize);
            setOpen(false);
        }
    }, [props]);
    return (React.createElement(Popover, { open: open, onOpenChange: setOpen },
        React.createElement(PopoverTrigger, { asChild: true },
            React.createElement(Button, { type: "button", variant: "outline", size: "sm", disabled: props.disabled, className: cn("min-w-[14rem] justify-between font-mono text-xs", props.className), "aria-label": "Pick VM size from live catalog" },
                React.createElement("span", { className: "truncate" }, triggerLabel),
                React.createElement(ChevronDown, { className: "ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" }))),
        React.createElement(PopoverContent, { className: "w-[28rem] p-0" },
            React.createElement("div", { className: "border-b border-border p-2" },
                React.createElement("div", { className: "relative" },
                    React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" }),
                    React.createElement(Input, { autoFocus: true, placeholder: "Search by name, family, GPU type\u2026", value: search, onChange: (e) => setSearch(e.target.value), className: "h-8 pl-7 text-xs", "aria-label": "Search VM sizes" })),
                gpuTypes.length > 0 && (React.createElement("div", { className: "mt-2 flex flex-wrap items-center gap-1" },
                    React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "GPU"),
                    React.createElement("button", { type: "button", onClick: () => setGpuTypeFilter(""), className: cn("rounded-full border px-2 py-0.5 text-2xs font-medium transition-all duration-fast", "hover:-translate-y-px hover:shadow-elev-1 active:translate-y-0", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60", gpuTypeFilter === ""
                            ? "border-primary bg-primary/15 text-primary"
                            : "border-border bg-card text-muted-foreground hover:bg-muted/40") }, "Any"),
                    gpuTypes.map((t) => (React.createElement("button", { key: t, type: "button", onClick: () => setGpuTypeFilter((cur) => (cur === t ? "" : t)), className: cn("rounded-full border px-2 py-0.5 text-2xs font-medium transition-all duration-fast", "hover:-translate-y-px hover:shadow-elev-1 active:translate-y-0", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60", gpuTypeFilter === t
                            ? "border-primary bg-primary/15 text-primary"
                            : "border-border bg-card text-muted-foreground hover:bg-muted/40") }, t)))))),
            !cacheHit ? (React.createElement("div", { className: "flex animate-fade-in flex-col items-center gap-2 p-6 text-center text-xs text-muted-foreground" },
                React.createElement("div", { className: "flex h-10 w-10 items-center justify-center rounded-full bg-muted/40 ring-1 ring-border" },
                    React.createElement(Cpu, { className: "h-5 w-5 text-muted-foreground" })),
                React.createElement("p", { className: "font-medium text-foreground" }, "VM catalog not cached yet"),
                React.createElement("p", { className: "max-w-xs" }, "Open the VM Catalog page to populate it. Result is cached for 7 days."),
                React.createElement(Button, { type: "button", size: "xs", variant: "outline", onClick: () => {
                        setOpen(false);
                        navigateToPage("/vm-catalog");
                    }, className: "gap-1 transition-all duration-fast hover:shadow-elev-1" },
                    React.createElement(ExternalLink, { className: "h-3 w-3" }),
                    "Open VM Catalog"))) : (React.createElement(ScrollArea, { className: "max-h-72" },
                React.createElement("ul", { className: "flex flex-col py-1" }, rows.length === 0 ? (React.createElement("li", { className: "px-3 py-4 text-center text-2xs text-muted-foreground" }, "No SKUs match this filter.")) : (rows.slice(0, 100).map(({ sku, gpu }) => {
                    var _a;
                    const selected = selectedSet.has(sku.name);
                    return (React.createElement("li", { key: sku.name },
                        React.createElement("button", { type: "button", onClick: () => onPick(sku.name), className: cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-fast hover:bg-muted/40", "focus-visible:bg-muted/60 focus-visible:outline-none", selected && "bg-primary/5") },
                            React.createElement("span", { className: "flex h-4 w-4 shrink-0 items-center justify-center" }, selected && (React.createElement(Check, { className: "h-3.5 w-3.5 text-primary", "aria-label": "Selected" }))),
                            React.createElement("div", { className: "min-w-0 flex-1" },
                                React.createElement("div", { className: "flex items-center gap-1.5" },
                                    React.createElement("span", { className: "truncate font-mono" }, sku.name),
                                    gpu.gpuType && (React.createElement("span", { className: "rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary" },
                                        gpu.gpuType,
                                        gpu.gpuCount && gpu.gpuCount > 0 && (React.createElement("span", null,
                                            "\u00D7",
                                            gpu.gpuCount))))),
                                props.density !== "compact" && (React.createElement("div", { className: "mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground" },
                                    React.createElement("span", null, (_a = sku.family) !== null && _a !== void 0 ? _a : "—"),
                                    sku.capabilities["vCPUs"] && (React.createElement("span", null,
                                        "\u00B7 ",
                                        sku.capabilities["vCPUs"],
                                        " vCPU")),
                                    sku.capabilities["MemoryGB"] && (React.createElement("span", null,
                                        "\u00B7 ",
                                        sku.capabilities["MemoryGB"],
                                        " GB")),
                                    sku.locations.length > 0 && (React.createElement("span", null,
                                        "\u00B7 ",
                                        sku.locations.length,
                                        " regions"))))))));
                }))),
                rows.length > 100 && (React.createElement("div", { className: "border-t border-border px-3 py-1.5 text-center text-2xs text-muted-foreground" },
                    "Showing first 100 of ",
                    rows.length,
                    " \u2014 narrow your search.")))),
            React.createElement("div", { className: "flex items-center justify-between border-t border-border bg-surface-base/40 px-2 py-1.5 text-2xs text-muted-foreground" },
                React.createElement("span", null, props.multi
                    ? `${props.value.length} selected`
                    : "Click to select"),
                React.createElement("button", { type: "button", onClick: () => {
                        setOpen(false);
                        navigateToPage("/vm-catalog");
                    }, className: "inline-flex items-center gap-1 text-primary hover:underline" },
                    React.createElement(ExternalLink, { className: "h-3 w-3" }),
                    "Full catalog")))));
};
//# sourceMappingURL=live-vm-size-select.js.map