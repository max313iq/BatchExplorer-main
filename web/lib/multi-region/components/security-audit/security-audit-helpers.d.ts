/**
 * Pure helpers for the Storage & Key Vault Security Audit page.
 *
 * Why a helpers module: the page component drives the UI (subscription
 * picker, filters, tables, exports) and dispatches network calls. The
 * actual *interpretation* — "is THIS storage-account config a finding?
 * how severe? what does the operator fix?" — is pure logic that we
 * want to keep typecheckable and unit-test-friendly without dragging
 * React state in.
 *
 * Defensive lineage (MicroBurst inspiration):
 *   - Storage:  Invoke-EnumerateAzureBlobs / public-access analysis
 *               -> here we audit the OWNED storage accounts' public-
 *                  access flag instead of attacking unknown ones.
 *   - KeyVault: Get-AzKeyVaults (config audit) -> we report soft-
 *               delete / purge-protection / RBAC / network defaults.
 *
 * Output: a flat list of `Finding` rows the page renders. Each row
 * carries enough metadata for the table cells (icon + name + RG +
 * region), the severity badge, the two tooltips ("why it matters" +
 * "remediation"), the copy-id action, and the Portal deep-link.
 */
/**
 * Five-bucket severity scale. Sort weight is intentionally `critical=4
 * > high=3 > medium=2 > info=1 > none=0` so descending sort by weight
 * floats the worst rows to the top — operators want to triage the red
 * findings first.
 */
export type Severity = "critical" | "high" | "medium" | "info" | "none";
export declare const SEVERITY_WEIGHT: Record<Severity, number>;
export declare const SEVERITY_LABEL: Record<Severity, string>;
/** Badge variant the UI maps each severity to. Keeps the color
 *  vocabulary in one place so a tone tweak is a single edit. */
export declare const SEVERITY_BADGE_VARIANT: Record<Severity, "destructive" | "warning" | "info" | "outline" | "secondary">;
/**
 * Subset of `Microsoft.Storage/storageAccounts` GET payload.
 * Fields are all optional because ARM omits absent flags rather than
 * sending `null`, and policy bypasses can keep a tenant on older API
 * versions that don't surface the flag at all.
 */
export interface StorageAccountResource {
    id: string;
    name: string;
    location: string;
    type: string;
    properties?: {
        allowBlobPublicAccess?: boolean;
        minimumTlsVersion?: string;
        supportsHttpsTrafficOnly?: boolean;
        defaultToOAuthAuthentication?: boolean;
        allowSharedKeyAccess?: boolean;
        networkAcls?: {
            defaultAction?: "Allow" | "Deny" | string;
            ipRules?: Array<unknown>;
            virtualNetworkRules?: Array<unknown>;
        };
    };
}
/**
 * Subset of `Microsoft.KeyVault/vaults` GET payload.
 */
export interface KeyVaultResource {
    id: string;
    name: string;
    location: string;
    type: string;
    properties?: {
        enableSoftDelete?: boolean;
        softDeleteRetentionInDays?: number;
        enablePurgeProtection?: boolean;
        enableRbacAuthorization?: boolean;
        publicNetworkAccess?: "Enabled" | "Disabled" | string;
        accessPolicies?: Array<{
            tenantId?: string;
            objectId?: string;
            permissions?: {
                keys?: string[];
                secrets?: string[];
                certificates?: string[];
                storage?: string[];
            };
        }>;
        networkAcls?: {
            defaultAction?: "Allow" | "Deny" | string;
            bypass?: string;
            ipRules?: Array<unknown>;
            virtualNetworkRules?: Array<unknown>;
        };
    };
}
export interface ParsedArmId {
    subscriptionId: string;
    resourceGroup: string;
    providerNamespace: string;
    resourceType: string;
    resourceName: string;
}
export declare function parseArmId(armId: string): ParsedArmId;
/**
 * Build the Azure Portal deep-link URL for an ARM resource id. The
 * portal's `#@/resource/...` fragment is stable across tenants — the
 * user lands on the resource blade and the portal handles the tenant
 * switch if they're signed into multiple directories.
 */
export declare function portalUrlFor(armId: string): string;
/**
 * Resource categories that can produce a Finding row. The original
 * MicroBurst-style audit emits "storage" / "keyvault" rows; the
 * corpus-signal extension (security-audit-corpus-signals.ts) adds
 * four more categories so the page can render diagnostic-setting,
 * subscription, public-container, and idle resource-group findings
 * through the same table without a parallel schema.
 *
 * Severity matrix + sort comparators are agnostic to the category —
 * everything downstream operates on `Finding.severity` alone.
 */
export type ResourceType = "storage" | "keyvault" | "diagnostic-setting" | "subscription" | "storage-container" | "resource-group";
export interface Finding {
    /** Stable id for keying/selection — `${armId}::${ruleId}`. */
    id: string;
    /** Which provider produced the finding. */
    resourceType: ResourceType;
    /** ARM id of the affected resource. */
    resourceId: string;
    /** Display name (storage account / vault name). */
    resourceName: string;
    /** Resource group (parsed from ARM id). */
    resourceGroup: string;
    /** Azure region. */
    region: string;
    /** Subscription id the resource lives in. */
    subscriptionId: string;
    /** Friendly subscription name (looked up by the page caller). */
    subscriptionName: string;
    /** Stable rule identifier used for filtering and deep-linking. */
    ruleId: string;
    /** Short title surfaced in the row. */
    title: string;
    /** One-line description shown directly under the title. */
    description: string;
    /** Long-form explanation surfaced via tooltip ("why it matters"). */
    whyItMatters: string;
    /** Concrete fix steps surfaced via tooltip ("remediation"). */
    remediation: string;
    /** Severity bucket. */
    severity: Severity;
}
/**
 * Apply every storage-account rule to a single account. Returns the
 * findings list (possibly empty if the account is well-configured).
 *
 * Rule decisions deliberately mirror the criteria in MicroBurst's
 * blob-enum + public-access modules — but flipped: instead of
 * *finding* publicly-accessible storage to attack, we *flag* the
 * operator's own accounts that an attacker would notice.
 */
export declare function evaluateStorageAccount(sa: StorageAccountResource, subscriptionName: string): Finding[];
/**
 * Apply every Key Vault rule to a single vault. Mirrors the spirit of
 * MicroBurst's Get-AzKeyVaults audit module — soft-delete / purge-
 * protection / RBAC / wildcard policies are the recurring findings
 * that NetSPI's blog calls out as the highest-value misconfigurations
 * for both attackers and defenders.
 */
export declare function evaluateKeyVault(kv: KeyVaultResource, subscriptionName: string): Finding[];
export interface FindingsSummary {
    total: number;
    critical: number;
    high: number;
    medium: number;
    info: number;
    storageScanned: number;
    vaultsScanned: number;
}
export declare function summarizeFindings(findings: readonly Finding[], scanned: {
    storage: number;
    vaults: number;
}): FindingsSummary;
/**
 * Default sort: severity descending then name ascending. Stable
 * comparator so successive sorts keep the within-severity order
 * predictable.
 */
export declare function compareFindings(a: Finding, b: Finding): number;
/** Severity bucket counts including ones with 0 — used by chip UI. */
export declare function countBySeverity(findings: readonly Finding[]): Record<Severity, number>;
export declare function countByResourceType(findings: readonly Finding[]): Record<ResourceType, number>;
//# sourceMappingURL=security-audit-helpers.d.ts.map