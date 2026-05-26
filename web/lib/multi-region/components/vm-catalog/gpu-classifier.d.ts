/**
 * Pure helpers that classify a Compute VM SKU as GPU vs. CPU and (when
 * GPU) identify the accelerator hardware. The Azure ARM `capabilities`
 * map publishes `GPUs` (numeric count) but NOT the GPU model — that has
 * to be inferred from the SKU name + family. Keeping the rules in one
 * place so the picker, filters, and any future diagnostics stay in sync.
 *
 * Rules verified against the official table:
 *   https://learn.microsoft.com/azure/virtual-machines/sizes-gpu
 *
 * If Azure ships a new GPU family the table needs an entry; the
 * fallback returns the SKU's `family` field so the picker still groups
 * the VM somewhere, just not under a known accelerator.
 */
import type { ComputeVmSku } from "../../services/quota-service";
/** Canonical GPU model names — these populate the dropdown options. */
export type GpuType = "H100" | "H200" | "MI300X" | "A100" | "A10" | "V100" | "P100" | "P40" | "T4" | "M60" | "K80" | "V620" | "Other GPU";
export interface GpuClassification {
    hasGpu: boolean;
    /** Numeric GPU count from capabilities, when published; null otherwise. */
    gpuCount: number | null;
    /** Inferred accelerator model. null when the SKU has no GPU. */
    gpuType: GpuType | null;
}
export declare function classifyGpu(sku: ComputeVmSku): GpuClassification;
/**
 * Distinct GPU types present in a list of SKUs, ordered by the canonical
 * GPU_RULES order so the dropdown is always in newest→oldest order.
 */
export declare function distinctGpuTypes(skus: ComputeVmSku[]): GpuType[];
//# sourceMappingURL=gpu-classifier.d.ts.map