export const AZURE_REGIONS = [
    "eastus",
    "eastus2",
    "westus",
    "westus2",
    "westus3",
    "centralus",
    "northcentralus",
    "southcentralus",
    "westcentralus",
    "canadacentral",
    "canadaeast",
    "brazilsouth",
    "northeurope",
    "westeurope",
    "uksouth",
    "ukwest",
    "francecentral",
    "germanywestcentral",
    "norwayeast",
    "switzerlandnorth",
    "swedencentral",
    "polandcentral",
    "italynorth",
    "spaincentral",
    "eastasia",
    "southeastasia",
    "japaneast",
    "japanwest",
    "australiaeast",
    "australiasoutheast",
    "centralindia",
    "southindia",
    "westindia",
    "koreacentral",
    "koreasouth",
    "uaenorth",
    "southafricanorth",
    "qatarcentral",
    "israelcentral",
    "mexicocentral",
];
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
export const GPU_CAPABLE_REGIONS = new Set([
    // Americas — V100 (NCv3) and/or H100 advertised
    "eastus",
    "eastus2",
    "westus2",
    "westus3",
    "centralus",
    "northcentralus",
    "southcentralus",
    "canadacentral",
    "brazilsouth",
    // Europe
    "westeurope",
    "northeurope",
    "uksouth",
    "francecentral",
    "germanywestcentral",
    "swedencentral",
    // Asia Pacific
    "southeastasia",
    "japaneast",
    "australiaeast",
    "koreacentral",
    // Middle East
    "uaenorth",
    "israelcentral",
]);
/**
 * Convenience predicate — `true` if the region advertises Nvidia V100
 * (NCv3) or H100 (NCadsH100_v5 / NDH100v5 / NCCadsH100_v5).
 */
export function isGpuRegion(region) {
    return GPU_CAPABLE_REGIONS.has(region);
}
export const DEFAULT_CONFIG = {
    maxRegionsPerRequest: 20,
    defaultQuotaLimit: 680,
    defaultQuotaType: "LowPriority",
    defaultRefreshIntervalSec: 60,
    maxToastNotifications: 5,
    logRetentionCount: 100,
    contactDefaults: {
        timezone: "UTC",
        country: "USA",
        language: "en-us",
    },
};
/** Regex for validating Azure subscription ID format (UUID). */
export const SUBSCRIPTION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Validate that a string looks like a valid Azure subscription ID. */
export function isValidSubscriptionId(id) {
    return SUBSCRIPTION_ID_REGEX.test(id.trim());
}
//# sourceMappingURL=constants.js.map