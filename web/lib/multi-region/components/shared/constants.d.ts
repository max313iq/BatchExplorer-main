export declare const AZURE_REGIONS: string[];
/**
 * Azure regions where Nvidia V100 (NCv3) OR Nvidia H100 (NCadsH100_v5,
 * NDH100_v5, NCCadsH100_v5) Tesla SKUs are advertised. Strictly the
 * union of V100 and H100 availability — older Maxwell/Pascal/Volta
 * variants (NV, NC, NCv2) and the A100 / T4 lines are NOT included,
 * because workloads asking for "GPU-capable" in this codebase mean the
 * datacenter Tensor Core families used for AI training and HPC.
 *
 * NCv3 (V100) is mid-retirement (general retirement 30 Sep 2025; a few
 * regions extended into 2026 — Central US, West Europe, East US 2,
 * Canada Central). New deployments should target NCadsH100_v5 or
 * NDH100v5.
 *
 * Sources cross-referenced:
 *   https://learn.microsoft.com/azure/virtual-machines/sizes/gpu-accelerated/ncv3-series
 *   https://learn.microsoft.com/azure/virtual-machines/sizes/gpu-accelerated/ncadsh100v5-series
 *   https://learn.microsoft.com/azure/virtual-machines/sizes/gpu-accelerated/ndh100v5-series
 *   https://azure.microsoft.com/global-infrastructure/services/?products=virtual-machines
 *
 * Regions not in this set may still have A100, T4, K80, or older
 * GPUs — they just don't currently advertise V100 or H100 capacity,
 * which is the bar workloads in this UI are filtering on.
 */
export declare const GPU_CAPABLE_REGIONS: ReadonlySet<string>;
/**
 * Convenience predicate — `true` if the region advertises Nvidia V100
 * (NCv3) or H100 (NCadsH100_v5 / NDH100v5 / NCCadsH100_v5).
 */
export declare function isGpuRegion(region: string): boolean;
export declare const DEFAULT_CONFIG: {
    maxRegionsPerRequest: number;
    defaultQuotaLimit: number;
    defaultQuotaType: "LowPriority";
    defaultRefreshIntervalSec: number;
    maxToastNotifications: number;
    logRetentionCount: number;
    contactDefaults: {
        timezone: string;
        country: string;
        language: string;
    };
};
/** Regex for validating Azure subscription ID format (UUID). */
export declare const SUBSCRIPTION_ID_REGEX: RegExp;
/** Validate that a string looks like a valid Azure subscription ID. */
export declare function isValidSubscriptionId(id: string): boolean;
//# sourceMappingURL=constants.d.ts.map