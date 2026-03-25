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

export const DEFAULT_CONFIG = {
    maxRegionsPerRequest: 20,
    defaultQuotaLimit: 680,
    defaultQuotaType: "LowPriority" as const,
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
export const SUBSCRIPTION_ID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate that a string looks like a valid Azure subscription ID. */
export function isValidSubscriptionId(id: string): boolean {
    return SUBSCRIPTION_ID_REGEX.test(id.trim());
}
