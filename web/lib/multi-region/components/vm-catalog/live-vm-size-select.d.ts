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
interface BaseProps {
    /** Subscription whose catalog cache we read. Required. */
    subscriptionId: string | undefined;
    /** When true, lifts the GPU-only filter. Defaults to false (GPU-only). */
    includeCpu?: boolean;
    /**
     * Optional: when set, rows are annotated with whether each region in
     * the array supports the SKU via Batch. Doesn't filter — just decorates.
     */
    hintRegions?: string[];
    /** Trigger button label when no value is selected. */
    placeholder?: string;
    /** Visual variant. "compact" hides capability details on each row. */
    density?: "comfortable" | "compact";
    className?: string;
    disabled?: boolean;
}
export interface LiveVmSizeSelectSingleProps extends BaseProps {
    multi?: false;
    value: string | null;
    onChange: (vmSize: string | null) => void;
}
export interface LiveVmSizeSelectMultiProps extends BaseProps {
    multi: true;
    value: string[];
    onChange: (vmSizes: string[]) => void;
}
export type LiveVmSizeSelectProps = LiveVmSizeSelectSingleProps | LiveVmSizeSelectMultiProps;
export declare const LiveVmSizeSelect: React.FC<LiveVmSizeSelectProps>;
export {};
//# sourceMappingURL=live-vm-size-select.d.ts.map