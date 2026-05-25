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
export type GpuType =
  | "H100"
  | "H200"
  | "MI300X"
  | "A100"
  | "A10"
  | "V100"
  | "P100"
  | "P40"
  | "T4"
  | "M60"
  | "K80"
  | "V620"
  | "Other GPU";

export interface GpuClassification {
  hasGpu: boolean;
  /** Numeric GPU count from capabilities, when published; null otherwise. */
  gpuCount: number | null;
  /** Inferred accelerator model. null when the SKU has no GPU. */
  gpuType: GpuType | null;
}

/**
 * Pattern table — first match wins. Order matters: more specific
 * patterns (e.g. `_H100_`) before general families (e.g. `^Standard_ND`).
 */
const GPU_RULES: Array<{ test: (name: string) => boolean; type: GpuType }> = [
  // Newest H100/H200 (NDH100/NCH100/NDv5)
  { test: (n) => /h100|nd[a-z]*h100|nc[a-z]*h100|_v5\b.*h100/i.test(n), type: "H100" },
  { test: (n) => /h200/i.test(n), type: "H200" },
  // AMD MI300X (NDmi300x family — sparse availability)
  { test: (n) => /mi300x|nd[a-z]*mi300/i.test(n), type: "MI300X" },
  // A100 — NDv4 / NCv4 / NDam_A100_v4
  { test: (n) => /a100|ndasr_v4|nd[a-z]*a100|nc[a-z]*a100/i.test(n), type: "A100" },
  // A10 — NVadsA10_v5
  { test: (n) => /\ba10\b|nv[a-z]*a10|_a10_/i.test(n), type: "A10" },
  // V100 — NDv2, NCv3
  { test: (n) => /\bv100\b|nd_?40|nd40rs|_v3\b.*nc/i.test(n), type: "V100" },
  // P100 — NCv2
  { test: (n) => /p100/i.test(n), type: "P100" },
  // P40 — NDv1
  { test: (n) => /\bp40\b|nd6s|nd12s|nd24s/i.test(n), type: "P40" },
  // T4 — NCT4_v3, NVadsA10... no, T4 is a separate family
  { test: (n) => /\bt4\b|nct4|nv[a-z]*_v3|_v3.*nv/i.test(n), type: "T4" },
  // M60 — NV
  { test: (n) => /\bm60\b|^standard_nv\d/i.test(n), type: "M60" },
  // K80 — NC (legacy)
  { test: (n) => /\bk80\b|^standard_nc\d+(?!\w*v[2-9])/i.test(n), type: "K80" },
  // AMD V620 — NGads_V620_v1
  { test: (n) => /v620|ngads/i.test(n), type: "V620" },
];

/**
 * Coarse "is this a GPU SKU?" check. Most reliable signal is the
 * capabilities `GPUs` field (numeric, > 0). Falls back to a name prefix
 * scan so SKUs with unpopulated capabilities still classify correctly.
 */
function detectGpuCount(sku: ComputeVmSku): number | null {
  const v = sku.capabilities["GPUs"];
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  // Fallback: GPU SKUs in Azure use the N* family — NC, ND, NV, NG.
  if (/^Standard_(ND|NC|NV|NG)/i.test(sku.name)) return null;
  return 0;
}

export function classifyGpu(sku: ComputeVmSku): GpuClassification {
  const gpuCount = detectGpuCount(sku);
  const isGpuFamily = /^Standard_(ND|NC|NV|NG)/i.test(sku.name);
  const hasGpu = (gpuCount !== null && gpuCount > 0) || isGpuFamily;
  if (!hasGpu) {
    return { hasGpu: false, gpuCount: 0, gpuType: null };
  }
  for (const rule of GPU_RULES) {
    if (rule.test(sku.name)) {
      return { hasGpu: true, gpuCount, gpuType: rule.type };
    }
  }
  return { hasGpu: true, gpuCount, gpuType: "Other GPU" };
}

/**
 * Distinct GPU types present in a list of SKUs, ordered by the canonical
 * GPU_RULES order so the dropdown is always in newest→oldest order.
 */
export function distinctGpuTypes(skus: ComputeVmSku[]): GpuType[] {
  const present = new Set<GpuType>();
  for (const s of skus) {
    const c = classifyGpu(s);
    if (c.gpuType) present.add(c.gpuType);
  }
  const ordered: GpuType[] = [
    "H100",
    "H200",
    "MI300X",
    "A100",
    "A10",
    "V100",
    "P100",
    "P40",
    "T4",
    "M60",
    "K80",
    "V620",
    "Other GPU",
  ];
  return ordered.filter((t) => present.has(t));
}
