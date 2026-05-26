/**
 * VM Catalog page — browse Azure VMs with live per-region availability,
 * Batch-supported flag, side-by-side comparison, export, and quick filters.
 *
 * Default scope: GPU SKUs only (Standard_ND/NC/NV/NG*). The Compute/skus
 * endpoint can return 600+ rows per subscription, the vast majority of
 * which are CPU-only and irrelevant for Batch GPU pools — pulling all of
 * them slows the load and floods the picker. The "Include CPU SKUs"
 * toggle in the toolbar lifts the filter when needed.
 *
 * Data sources (15-minute TTL-cached):
 *   - Microsoft.Compute/skus               (GPU subset, streamed)
 *   - Microsoft.Batch/.../virtualMachineSkus (per-region Batch support)
 *
 * Filters are designed for "I have a workload, find me the right VM":
 *   - Quick category chips: GPU, HPC, Compute, Memory, Storage, Burstable
 *   - GPU type chips: H100, A100, V100, T4, …
 *   - GPU count chips: 1 / 2 / 4 / 8 (whatever values the data has)
 *   - vCPU & memory range inputs
 *   - Region multi-select (with "Your accounts" shortcut)
 *   - Sort: name, GPU count desc, vCPUs desc, memory desc
 *   - Batch-supported only toggle (default ON)
 *   - Architecture (x64 / ARM64) chip
 *
 * Power-user affordances:
 *   - Per-row copy-SKU-name button
 *   - Per-row pin (favourite) — persists in localStorage; pinned rows float to top
 *   - Side-by-side compare (up to 4 SKUs) with capability diff highlighting
 *   - Export filtered rows to CSV or JSON
 *   - Keyboard: `/` focuses search, `Esc` clears search
 *   - Tooltips on every capability badge (vCPU/Mem/GPU/PremiumIO/InfiniBand/AccelNet/UltraSSD)
 *
 * Loading is progressive: rows render page-by-page, and Batch-availability
 * probes decorate rows asynchronously as each region's probe lands.
 */
import * as React from "react";
export declare const VmCatalogPage: React.FC;
//# sourceMappingURL=vm-catalog-page.d.ts.map