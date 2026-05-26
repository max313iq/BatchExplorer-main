/**
 * security-audit-corpus-signals.ts
 *
 * Defender-side detection signals derived from the offensive-tooling
 * research corpus at C:\Users\baimgprodsesa1\Desktop\New folder\. The
 * primary helpers file (security-audit-helpers.ts) covers the
 * storage / Key Vault config rules that mirror NetSPI's MicroBurst
 * surface. This file extends the rule set with four corpus-derived
 * categories that aren't tied to a single resource type:
 *
 *   Signal A — Diagnostic-setting deletion sentinel
 *     citation: New folder\_AZURE_BYPASS_PLAYBOOK.md §"Critical
 *               Defender Audit Surface" item 8 (`Delete diagnostic
 *               setting` Activity Log event)
 *     citation: New folder\_bypass_modify_delete.md §5.14
 *               (DELETE providers/Microsoft.Insights/diagnosticSettings)
 *
 *   Signal B — Subscription-cancellation sentinel
 *     citation: New folder\_AZURE_BYPASS_PLAYBOOK.md §"Critical
 *               Defender Audit Surface" item 10 (`Cancel subscription`
 *               Activity Log event)
 *     citation: New folder\_bypass_modify_delete.md §5.11 (subscription
 *               cancellation is catastrophic, 30-day soft-delete on
 *               some resource types — recovery requires Microsoft
 *               Support)
 *
 *   Signal C — Public-access storage container surface
 *     citation: New folder\NetSPI\MicroBurst\Misc\Invoke-EnumerateAzureBlobs.ps1
 *               (the offensive surface — anonymous blob enumeration
 *               relies on containers with publicAccess != None)
 *     citation: New folder\_analysis_netspi.md §VI ("Storage Account
 *               key extraction → SAS minting → blob exfil")
 *     Note: this requires an ARM listContainers call we may not have
 *     wired today. The evaluator is implemented; the page leaves a
 *     COORDINATOR marker until the data is wired.
 *
 *   Signal D — Idle resource-group / orphan-resource posture
 *     citation: New folder\_analysis_defender_view.md §1
 *               (Azucar / ScoutSuite findings model — abandoned
 *               infrastructure is a recurring posture failure)
 *     citation: New folder\nccgroup\azucar — config-audit tool; the
 *               broader Azucar/ScoutSuite/Prowler family flags idle
 *               resource groups because attackers re-purpose them
 *               (low monitoring, no owner) as staging shelters.
 *
 * Safety constraints honored:
 *   - All evaluators are PURE functions over ARM read payloads.
 *     They never invoke the offensive primitive they detect.
 *   - The page wires READ-ONLY enumeration of the operator's own
 *     tenant resources (`GET` only); never POST/PATCH/DELETE.
 *   - Findings are posture indicators — wording is defender-facing.
 *
 * This file does not import React. The page composes the evaluators
 * with state.
 */
import type { Finding, ResourceType } from "./security-audit-helpers";
/**
 * The four corpus signals introduce four NEW finding-row "resource"
 * categories beyond the storage/keyvault pair the original helpers
 * cover. They surface in the same Finding list — the page renders
 * them with category-specific icons and labels.
 *
 * Kept as a separate union (extends ResourceType) so the original
 * helpers module stays focused on the MicroBurst-style rules; the
 * page widens to the union below.
 */
export type CorpusResourceType = "diagnostic-setting" | "subscription" | "storage-container" | "resource-group";
export type ExtendedResourceType = ResourceType | CorpusResourceType;
/** Narrow ARM shape for a `microsoft.insights/diagnosticSettings` list result. */
export interface DiagnosticSettingResource {
    id?: string;
    name?: string;
    properties?: {
        logs?: Array<{
            category?: string;
            categoryGroup?: string;
            enabled?: boolean;
        }>;
        metrics?: Array<{
            category?: string;
            enabled?: boolean;
        }>;
        workspaceId?: string;
        eventHubAuthorizationRuleId?: string;
        storageAccountId?: string;
    };
}
/**
 * Resource-shaped record we evaluate diagnostic-settings against.
 * Used for storage accounts AND key vaults so a single evaluator
 * can cover both audit surfaces.
 */
export interface DiagnosticEvaluable {
    resourceId: string;
    resourceName: string;
    resourceGroup: string;
    region: string;
    /**
     * tierZero=true bumps a "no diagnostic setting" finding to high
     * severity. We default Key Vaults to tier-0 (they hold the bearer
     * credentials) and storage accounts to tier-1 unless the caller
     * passes a hint.
     */
    tierZero: boolean;
    /** Diagnostic settings ARM returned for THIS resource. */
    settings: DiagnosticSettingResource[];
}
interface DiagnosticContext {
    subscriptionId: string;
    subscriptionName: string;
}
/**
 * Evaluate one resource's diagnostic-settings list. Emits at most
 * one finding (the most severe of the issues found) to avoid
 * stacking duplicate "no audit shipping" rows per resource.
 */
export declare function evaluateDiagnosticSettings(target: DiagnosticEvaluable, ctx: DiagnosticContext): Finding[];
export interface SubscriptionListEntry {
    id?: string;
    subscriptionId: string;
    displayName: string;
    state?: "Enabled" | "Warned" | "PastDue" | "Disabled" | "Deleted" | "Expired" | string;
    tenantId?: string;
    managedByTenants?: Array<{
        tenantId?: string;
    }>;
    /** Optional decoration the page may add. */
    isTierZero?: boolean;
}
/**
 * Evaluate a flat list of subscriptions (from
 * `GET /subscriptions?api-version=2020-01-01`) and emit a finding for
 * every sub in a cancellable / cancelled state.
 *
 * We deliberately do NOT call the DELETE endpoint — this is the
 * defensive counterpart. The point is to surface the operator's own
 * subscriptions that are sitting in a state where one ARM call (or
 * one billing-portal click) lands them in irrecoverable Deleted.
 */
export declare function evaluateSubscriptionStates(subs: readonly SubscriptionListEntry[]): Finding[];
export interface ContainerListEntry {
    /** ARM id of the parent storage account. */
    storageAccountId: string;
    /** Storage account name (for portal links). */
    storageAccountName: string;
    resourceGroup: string;
    region: string;
    /** Container name. */
    name: string;
    /** 'None' | 'Blob' | 'Container' | string (per ARM enum). */
    publicAccess: string;
}
interface ContainerContext {
    subscriptionId: string;
    subscriptionName: string;
}
export declare function evaluatePublicContainers(containers: readonly ContainerListEntry[], ctx: ContainerContext): Finding[];
export interface ResourceGroupSummary {
    /** ARM id: /subscriptions/{sub}/resourceGroups/{name} */
    id: string;
    /** RG name. */
    name: string;
    /** Region. */
    location: string;
    /** Tags map (or empty object). */
    tags: Record<string, string>;
    /**
     * Resource count discovered in the RG. RGs with 0 resources are
     * surfaced separately (the empty-RG finding).
     */
    resourceCount: number;
    /**
     * ISO timestamp of the MOST RECENT resource modification across the
     * RG, OR null if no resource carries `properties.changedTime` /
     * `properties.createdTime`. The page passes the most recent of
     * `tags.lastModified`, `properties.changedTime`, or
     * `properties.provisioningState`-implied timestamps.
     */
    lastChangedIso: string | null;
    /**
     * True if any resource in the RG carries a tag like `env=temp`,
     * `lifecycle=temporary`, `environment=dev`, `temp=true`, etc. The
     * page populates this from the resource enumeration.
     */
    hasTempTag: boolean;
}
interface IdleContext {
    subscriptionId: string;
    subscriptionName: string;
    /** Override the 90-day default; minimum 7, maximum 365. */
    idleThresholdDays?: number;
    /** Anchor for "now" — defaults to Date.now() at evaluation. */
    nowMs?: number;
}
export declare function evaluateIdleResourceGroups(rgs: readonly ResourceGroupSummary[], ctx: IdleContext): Finding[];
export declare function riskScoreFor(f: Finding): number;
export declare const CORPUS_RULE_IDS: readonly ["diag.absent", "diag.audit-disabled", "sub.state.warned", "sub.state.past-due", "sub.state.deleted", "sub.state.disabled", "sub.state.unknown", "container.public", "container.public.sensitive", "rg.empty", "rg.idle"];
export type CorpusRuleId = (typeof CORPUS_RULE_IDS)[number];
/** True if a Finding came from one of the corpus signals. */
export declare function isCorpusFinding(f: Finding): boolean;
export interface TierZeroProtectionScore {
    /** Integer 0..100. 100 means every Tier-0 resource is fully protected. */
    score: number;
    /** Resources that pass the full Tier-0 check. */
    protectedCount: number;
    /** Total Tier-0 resources evaluated (denominator). */
    totalCount: number;
    /** Top 3 rule-ids dragging the score down (descending offender count). */
    topOffenders: ReadonlyArray<{
        ruleId: string;
        count: number;
    }>;
}
export interface TierZeroScoreInput {
    /** All findings from the scan (any severity / resource type). */
    findings: readonly Finding[];
    /** Total Key Vaults scanned (denominator for Tier-0 count). */
    vaultsScanned: number;
}
export declare function computeTierZeroProtectionScore(input: TierZeroScoreInput): TierZeroProtectionScore;
export interface PostureSnapshot {
    /** ISO timestamp of the scan that produced this snapshot. */
    iso: string;
    /** Total finding count. */
    total: number;
    critical: number;
    high: number;
    medium: number;
    info: number;
    /** Composite Tier-0 score 0..100 (see above). */
    tierZeroScore: number;
    /** Subscriptions in scope at the time. */
    subscriptionsInScope: number;
}
/** Cap on persisted snapshots — older entries fall off the end. */
export declare const POSTURE_TREND_MAX = 30;
/**
 * Append a new snapshot to a snapshot ring buffer. Newest first.
 * Drops the oldest entry once the cap is reached. PURE — does no IO.
 */
export declare function appendPostureSnapshot(prev: readonly PostureSnapshot[], next: PostureSnapshot): PostureSnapshot[];
/**
 * Compute the delta between the most recent snapshot and the prior one.
 * Returns null when there are fewer than two snapshots to compare.
 * Negative deltas mean fewer findings (improvement).
 */
export interface PostureTrendDelta {
    totalDelta: number;
    criticalDelta: number;
    highDelta: number;
    tierZeroDelta: number;
}
export declare function computePostureTrendDelta(snapshots: readonly PostureSnapshot[]): PostureTrendDelta | null;
export interface DormantSpCredentialEvent {
    servicePrincipalObjectId: string;
    servicePrincipalDisplayName: string;
    appId: string;
    /** ISO timestamp of the credential addition we're scoring. */
    credentialAddedIso: string;
    /** ISO timestamp of the LAST observed sign-in BEFORE the cred event. */
    lastSignInBeforeIso: string | null;
    /** ISO timestamp of the LAST observed credential rotation BEFORE the event. */
    lastCredRotationBeforeIso: string | null;
    /** Tenant id (for portal links / context). */
    tenantId: string;
    /**
     * tierZero=true means the SP holds a directory role assignment that
     * elevates the addKey from "anomalous" to "active persistence".
     */
    tierZero: boolean;
}
interface DormantSpContext {
    /** Dormancy threshold; below this is "active", at/above is "dormant". */
    dormantThresholdDays?: number;
    nowMs?: number;
}
/** Default dormancy threshold (90 days mirrors the corpus playbook's
 *  Tier-0 review cadence). */
export declare const DORMANT_SP_DEFAULT_DAYS = 90;
export declare function evaluateDormantSpCredentialRotation(events: readonly DormantSpCredentialEvent[], ctx?: DormantSpContext): Finding[];
export {};
//# sourceMappingURL=security-audit-corpus-signals.d.ts.map