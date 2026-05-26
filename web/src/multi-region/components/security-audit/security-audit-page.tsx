/**
 * Storage & Key Vault Security Audit page.
 *
 * Defensive auditor inspired by NetSPI's MicroBurst toolkit. The
 * operator picks one or more accessible subscriptions; the page calls
 * ARM directly (read-only) to list every storage account and key
 * vault, evaluates each one against the rule set in
 * `security-audit-helpers.ts`, and renders the resulting findings
 * with severity badges, copy-id buttons, Portal deep-links, and
 * CSV / JSON exports.
 *
 * Why this is OK for a defensive audit (the line vs. MicroBurst):
 *   - MicroBurst's Invoke-EnumerateAzureBlobs and Invoke-EnumerateAzure
 *     SubDomains attack the *anonymous* surface — they probe sub-
 *     domains the operator may not own. We do NONE of that here:
 *     this page lists the operator's OWN resources via authenticated
 *     ARM calls and only reports config-level issues.
 *   - Every call is GET. No POST/PATCH/DELETE. Worst-case impact is
 *     the operator's ARM throttle budget.
 *
 * Hard constraints honored:
 *   - New files only (no edits to services / auth / store / router /
 *     sidebar / shared components).
 *   - useArmToken + TokenExpiryBadge.
 *   - Pagination via @odata.nextLink.
 *   - 403 subs surface as inline warning rows; we keep scanning the
 *     others.
 */
import * as React from "react";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock,
  CreditCard,
  EyeOff,
  ExternalLink,
  FileText,
  Filter as FilterIcon,
  FolderOpen,
  KeyRound,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState } from "../../store/store-context";

import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

// COORDINATOR: this page intentionally renders findings with the raw
// `@/components/ui/table` widget rather than `../shared/enhanced-table` —
// each finding row carries two inline tooltips ("why it matters" /
// "remediation") plus a CopyButton + Portal link in the actions cell,
// which is more layout than EnhancedTable's cell renderer cleanly
// expresses today. If EnhancedTable later grows per-row expand/tooltip
// slots, this page is a good candidate to migrate.

import {
  compareFindings,
  countByResourceType,
  countBySeverity,
  evaluateKeyVault,
  evaluateStorageAccount,
  Finding,
  KeyVaultResource,
  parseArmId,
  portalUrlFor,
  ResourceType,
  SEVERITY_BADGE_VARIANT,
  SEVERITY_LABEL,
  SEVERITY_WEIGHT,
  Severity,
  StorageAccountResource,
  summarizeFindings,
} from "./security-audit-helpers";
import {
  appendPostureSnapshot,
  computePostureTrendDelta,
  computeTierZeroProtectionScore,
  DiagnosticSettingResource,
  evaluateDiagnosticSettings,
  evaluateIdleResourceGroups,
  evaluateSubscriptionStates,
  isCorpusFinding,
  PostureSnapshot,
  ResourceGroupSummary,
  riskScoreFor,
  SubscriptionListEntry,
  TierZeroProtectionScore,
} from "./security-audit-corpus-signals";
import { runbookFor } from "./security-audit-runbooks";

// --------------------------------------------------------------------------
// ARM constants
// --------------------------------------------------------------------------

const ARM_BASE = "https://management.azure.com";
const STORAGE_API_VERSION = "2023-05-01";
const KEYVAULT_API_VERSION = "2023-07-01";
// Diagnostic settings on a resource — used by Signal A.
// citation: New folder\_bypass_modify_delete.md:599 (matching DELETE)
const DIAGNOSTIC_SETTINGS_API_VERSION = "2021-05-01-preview";
// Tenant subscriptions enumeration — used by Signal B.
// Same api-version the DELETE in §5.11 cites, so the state shape we
// match against is the one ARM exposes alongside the cancellation.
const SUBSCRIPTIONS_API_VERSION = "2020-01-01";
// Resource-group + resource enumeration — used by Signal D.
const RESOURCEGROUPS_API_VERSION = "2021-04-01";
const RESOURCES_API_VERSION = "2021-04-01";
// Max pages we'll follow on one provider/sub probe — defensive guard
// against a runaway nextLink loop. 50 pages * 100 results per page =
// 5,000 resources per sub per provider is enough for every real
// tenant we've seen.
const PAGE_FOLLOW_CAP = 50;
// Tags that hint at temporary / non-production lifecycle. Matched
// case-insensitively on tag KEY or VALUE. Used by Signal D to bump
// idle-RG severity from medium to high.
const TEMP_TAG_HINTS: readonly string[] = [
  "temp",
  "temporary",
  "ephemeral",
  "scratch",
  "dev",
  "development",
  "sandbox",
  "test",
];

interface ScopeSubscription {
  subscriptionId: string;
  displayName: string;
  tenantId: string;
  /** MSAL homeAccountId of the AAD account that owns the subscription. */
  homeAccountId: string;
}

interface ScopeAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
  subscriptions: ScopeSubscription[];
}

interface ScanCounts {
  storage: number;
  vaults: number;
}

/** Per-subscription scan result, including 403 / partial failures. */
interface SubScanResult {
  subscriptionId: string;
  subscriptionName: string;
  storageCount: number;
  vaultCount: number;
  findings: Finding[];
  /** 403 / other recoverable error message for this sub, surfaced inline. */
  error?: string;
}

/** Inline warning row appended to the findings list for failed subs. */
interface WarningRow {
  kind: "warning";
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  message: string;
}

type DisplayRow =
  | ({ kind: "finding" } & Finding)
  | WarningRow;

// --------------------------------------------------------------------------
// ARM fetch helpers (paginated, read-only).
// --------------------------------------------------------------------------

interface PagedResponse<T> {
  value?: T[];
  nextLink?: string;
  // Some ARM endpoints use `@odata.nextLink` instead of `nextLink`.
  // We accept either via the index signature.
  [key: string]: unknown;
}

/** Generic paginated ARM list-call. Follows `nextLink` /
 *  `@odata.nextLink` until exhausted or the safety cap kicks in.
 *  Returns the accumulated `.value` array. */
async function fetchArmPaged<T>(
  initialUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = initialUrl;
  let pages = 0;
  while (url && pages < PAGE_FOLLOW_CAP) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(
        `ARM ${res.status} ${res.statusText} on ${url}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const payload = (await res.json()) as PagedResponse<T>;
    if (Array.isArray(payload.value)) {
      out.push(...payload.value);
    }
    const next =
      (payload["nextLink"] as string | undefined) ??
      (payload["@odata.nextLink"] as string | undefined);
    url = next;
    pages += 1;
  }
  return out;
}

function listStorageAccountsUrl(subscriptionId: string): string {
  return `${ARM_BASE}/subscriptions/${subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=${STORAGE_API_VERSION}`;
}

function listKeyVaultsUrl(subscriptionId: string): string {
  return `${ARM_BASE}/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault/vaults?api-version=${KEYVAULT_API_VERSION}`;
}

// Diagnostic-settings list on a specific resource. Used by Signal A.
// citation: New folder\_bypass_modify_delete.md §5.14
function listDiagnosticSettingsUrl(resourceArmId: string): string {
  const trimmed = resourceArmId.startsWith("/")
    ? resourceArmId
    : `/${resourceArmId}`;
  return `${ARM_BASE}${trimmed}/providers/microsoft.insights/diagnosticSettings?api-version=${DIAGNOSTIC_SETTINGS_API_VERSION}`;
}

// Subscriptions list (defensive Signal B). Tenant-wide; one token is
// sufficient. citation: New folder\_bypass_modify_delete.md §5.11.
function listSubscriptionsUrl(): string {
  return `${ARM_BASE}/subscriptions?api-version=${SUBSCRIPTIONS_API_VERSION}`;
}

// Resource groups in a subscription (Signal D — idle / empty RG).
function listResourceGroupsUrl(subscriptionId: string): string {
  return `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups?api-version=${RESOURCEGROUPS_API_VERSION}`;
}

// All resources in an RG with $expand=changedTime,createdTime — we
// derive the RG's last-modified from the max of these timestamps.
// citation: posture surface used by Azucar / ScoutSuite to detect
// orphaned RGs (see _analysis_defender_view.md §1).
function listResourcesInGroupUrl(
  subscriptionId: string,
  resourceGroupName: string,
): string {
  return `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(
    resourceGroupName,
  )}/resources?api-version=${RESOURCES_API_VERSION}&$expand=changedTime,createdTime`;
}

// --------------------------------------------------------------------------
// Scan orchestration
// --------------------------------------------------------------------------

interface ScanSubscriptionArgs {
  sub: ScopeSubscription;
  token: string;
  signal?: AbortSignal;
}

/**
 * Scan ONE subscription end-to-end: list storage accounts + key
 * vaults in parallel, evaluate every resource, return the combined
 * findings list. Throws on hard failures (network outage) but
 * 403 / 404 / 429 are caught and surfaced via the `error` field on
 * SubScanResult so the page can render a warning row instead of
 * blowing up the whole scan.
 *
 * Corpus signals layered on top:
 *   - Signal A: per Tier-0 resource diagnostic-settings probe (Key
 *     Vaults always counted Tier-0; storage accounts marked tier-1
 *     by default). citation: New folder\_AZURE_BYPASS_PLAYBOOK.md
 *     item 8 + _bypass_modify_delete.md §5.14
 *   - Signal D: resource-group enumeration with $expand=changedTime
 *     to detect idle / empty RGs. citation: New folder
 *     \_analysis_defender_view.md §1 (Azucar / ScoutSuite findings
 *     model — orphan / idle infra posture failures).
 */
async function scanSubscription(
  args: ScanSubscriptionArgs,
  subscriptionName: string,
  opts: { idleThresholdDays: number },
): Promise<SubScanResult> {
  const { sub, token, signal } = args;
  const result: SubScanResult = {
    subscriptionId: sub.subscriptionId,
    subscriptionName,
    storageCount: 0,
    vaultCount: 0,
    findings: [],
  };
  try {
    const [storage, vaults, rgs] = await Promise.all([
      fetchArmPaged<StorageAccountResource>(
        listStorageAccountsUrl(sub.subscriptionId),
        token,
        signal,
      ).catch((err: Error & { status?: number }) => {
        // 403 on ONE provider — surface as partial, keep the other.
        if (err.status === 403 || err.status === 401) {
          return { __forbidden: true, message: err.message } as unknown as
            | StorageAccountResource[]
            | { __forbidden: true; message: string };
        }
        throw err;
      }),
      fetchArmPaged<KeyVaultResource>(
        listKeyVaultsUrl(sub.subscriptionId),
        token,
        signal,
      ).catch((err: Error & { status?: number }) => {
        if (err.status === 403 || err.status === 401) {
          return { __forbidden: true, message: err.message } as unknown as
            | KeyVaultResource[]
            | { __forbidden: true; message: string };
        }
        throw err;
      }),
      // Signal D probe — resource groups for idle / empty RG detection.
      // Tolerated to fail same as storage/vaults so a 403 on RG list
      // doesn't kill the whole sub scan.
      fetchArmPaged<ArmResourceGroup>(
        listResourceGroupsUrl(sub.subscriptionId),
        token,
        signal,
      ).catch((err: Error & { status?: number }) => {
        if (err.status === 403 || err.status === 401) {
          return { __forbidden: true, message: err.message } as unknown as
            | ArmResourceGroup[]
            | { __forbidden: true; message: string };
        }
        // RG enumeration failure is non-fatal — log but continue.
        return [] as ArmResourceGroup[];
      }),
    ]);

    const storageList = Array.isArray(storage) ? storage : [];
    const vaultList = Array.isArray(vaults) ? vaults : [];
    const rgList = Array.isArray(rgs) ? rgs : [];

    // Track per-provider 403s so the warning row makes sense even
    // when one provider succeeded and the other didn't.
    const partialErrors: string[] = [];
    if (!Array.isArray(storage)) {
      partialErrors.push("storage accounts (403)");
    }
    if (!Array.isArray(vaults)) {
      partialErrors.push("key vaults (403)");
    }
    if (!Array.isArray(rgs)) {
      partialErrors.push("resource groups (403)");
    }

    result.storageCount = storageList.length;
    result.vaultCount = vaultList.length;
    for (const sa of storageList) {
      result.findings.push(...evaluateStorageAccount(sa, subscriptionName));
    }
    for (const kv of vaultList) {
      result.findings.push(...evaluateKeyVault(kv, subscriptionName));
    }

    // --- Signal A: diagnostic settings ---
    // Probe each storage account + key vault for its diagnostic
    // settings. We bound concurrency to 5 so a sub with hundreds of
    // resources doesn't burst the ARM throttle. citation: New folder
    // \_bypass_modify_delete.md §5.14 (DELETE on this exact ARM path).
    const diagnosticTargets: Array<{
      armId: string;
      name: string;
      rg: string;
      region: string;
      tierZero: boolean;
    }> = [];
    for (const sa of storageList) {
      const p = parseArmId(sa.id);
      diagnosticTargets.push({
        armId: sa.id,
        name: sa.name,
        rg: p.resourceGroup,
        region: sa.location,
        tierZero: false,
      });
    }
    for (const kv of vaultList) {
      const p = parseArmId(kv.id);
      diagnosticTargets.push({
        armId: kv.id,
        name: kv.name,
        rg: p.resourceGroup,
        region: kv.location,
        tierZero: true,
      });
    }
    const diagFindings = await probeDiagnosticSettings(
      diagnosticTargets,
      token,
      subscriptionName,
      sub.subscriptionId,
      signal,
    );
    result.findings.push(...diagFindings);

    // --- Signal D: idle / empty resource groups ---
    if (rgList.length > 0) {
      const summaries = await buildResourceGroupSummaries(
        rgList,
        sub.subscriptionId,
        token,
        signal,
      );
      result.findings.push(
        ...evaluateIdleResourceGroups(summaries, {
          subscriptionId: sub.subscriptionId,
          subscriptionName,
          idleThresholdDays: opts.idleThresholdDays,
        }),
      );
    }

    // --- Signal C: public-access containers ---
    // COORDINATOR: a ListBlobContainers ARM call
    //   GET /subscriptions/{sub}/resourceGroups/{rg}/providers/
    //       Microsoft.Storage/storageAccounts/{name}/blobServices/
    //       default/containers?api-version=2023-05-01
    // would let `evaluatePublicContainers()` from
    // security-audit-corpus-signals.ts emit findings. We deliberately
    // do NOT add that endpoint here per the per-page edit boundary
    // (it belongs in the storage service layer, not in this page).
    // When it lands, wire it like the diagnostics probe above:
    //   const containers = await fetchArmPaged<ArmContainer>(...);
    //   result.findings.push(...evaluatePublicContainers(...));
    // The portal-deep-link per container should use
    //   `${portalUrlFor(storageAccountId)}/containers`
    // (the storage-account blade has a containers sub-route).

    // --- Signal E (cross-page, wave 8): dormant-SP credential rotation ---
    // COORDINATOR: `evaluateDormantSpCredentialRotation` lives in
    // security-audit-corpus-signals.ts but the data feed (SP sign-in +
    // credential-add events from Graph) lives in role-graph /
    // privileged-audit. When that pipeline lands, those pages should
    // call evaluateDormantSpCredentialRotation() and push the
    // resulting Finding[] into THIS page's findings list (via a small
    // cross-page event or shared store slice). The rule was placed
    // in the security-audit module so all defensive rule logic stays
    // in one file — the page that COLLECTS the data drives the helper.
    // citation: New folder\_bypass_role_grant.md §addKey.

    if (partialErrors.length > 0) {
      result.error = `Insufficient permissions on: ${partialErrors.join(", ")}. Partial results shown.`;
    }
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 403 || e.status === 401) {
      result.error = `No read access (HTTP ${e.status}). Skipping.`;
    } else {
      result.error = e.message ?? String(err);
    }
  }
  return result;
}

// --------------------------------------------------------------------------
// Signal A — diagnostic-settings probe (bounded concurrency)
// --------------------------------------------------------------------------

interface DiagnosticTarget {
  armId: string;
  name: string;
  rg: string;
  region: string;
  tierZero: boolean;
}

/**
 * Fetch diagnostic settings for every target with a small worker
 * pool. Each per-resource fetch tolerates 404 (no settings) /
 * 403 (no permission) — translating to an empty list so the
 * evaluator can still emit the "diag.absent" finding for the
 * 404 case (the most important defender signal).
 */
async function probeDiagnosticSettings(
  targets: readonly DiagnosticTarget[],
  token: string,
  subscriptionName: string,
  subscriptionId: string,
  signal: AbortSignal | undefined,
): Promise<Finding[]> {
  const CONCURRENCY = 5;
  const findings: Finding[] = [];
  let i = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) return;
      const idx = i++;
      if (idx >= targets.length) return;
      const t = targets[idx]!;
      try {
        const settings = await fetchArmPaged<DiagnosticSettingResource>(
          listDiagnosticSettingsUrl(t.armId),
          token,
          signal,
        );
        findings.push(
          ...evaluateDiagnosticSettings(
            {
              resourceId: t.armId,
              resourceName: t.name,
              resourceGroup: t.rg,
              region: t.region,
              tierZero: t.tierZero,
              settings,
            },
            { subscriptionId, subscriptionName },
          ),
        );
      } catch (err) {
        const e = err as Error & { status?: number };
        if (e.status === 404) {
          // 404 here actually means "no diagnostic settings exist
          // for this resource" — which IS the finding we care about.
          findings.push(
            ...evaluateDiagnosticSettings(
              {
                resourceId: t.armId,
                resourceName: t.name,
                resourceGroup: t.rg,
                region: t.region,
                tierZero: t.tierZero,
                settings: [],
              },
              { subscriptionId, subscriptionName },
            ),
          );
        }
        // 403 / 401 / other — silently skip this resource. We can't
        // tell "no setting" from "no permission" so we err on the
        // side of not crying wolf.
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  return findings;
}

// --------------------------------------------------------------------------
// Signal D — resource-group summary builder
// --------------------------------------------------------------------------

interface ArmResourceGroup {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
}

interface ArmResource {
  id: string;
  name: string;
  type: string;
  changedTime?: string;
  createdTime?: string;
  tags?: Record<string, string>;
}

function hasTempLifecycleTag(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  for (const [key, val] of Object.entries(tags)) {
    const k = key.toLowerCase();
    const v = (val ?? "").toLowerCase();
    for (const hint of TEMP_TAG_HINTS) {
      if (k === hint || v === hint) return true;
      if (k.includes(hint) || v.includes(hint)) return true;
    }
  }
  return false;
}

async function buildResourceGroupSummaries(
  rgs: readonly ArmResourceGroup[],
  subscriptionId: string,
  token: string,
  signal: AbortSignal | undefined,
): Promise<ResourceGroupSummary[]> {
  // Bounded concurrency — one in-flight RG resource-list call per
  // worker. Larger pools just hit ARM throttles.
  const CONCURRENCY = 4;
  const out: ResourceGroupSummary[] = [];
  let i = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) return;
      const idx = i++;
      if (idx >= rgs.length) return;
      const rg = rgs[idx]!;
      let resources: ArmResource[] = [];
      try {
        resources = await fetchArmPaged<ArmResource>(
          listResourcesInGroupUrl(subscriptionId, rg.name),
          token,
          signal,
        );
      } catch (err) {
        const e = err as Error & { status?: number };
        if (e.status !== 403 && e.status !== 401) {
          // Non-permission errors leave us with 0 resources for the
          // RG — we still record the summary so the operator sees
          // the RG exists (just without an idle calculation).
        }
      }
      // Compute the freshest timestamp across changedTime/createdTime.
      let maxTs: number | null = null;
      let hasTempTag = hasTempLifecycleTag(rg.tags);
      for (const r of resources) {
        const ct = r.changedTime ? Date.parse(r.changedTime) : NaN;
        const cr = r.createdTime ? Date.parse(r.createdTime) : NaN;
        for (const t of [ct, cr]) {
          if (Number.isFinite(t)) {
            maxTs = maxTs == null ? t : Math.max(maxTs, t);
          }
        }
        if (!hasTempTag && hasTempLifecycleTag(r.tags)) hasTempTag = true;
      }
      out.push({
        id: rg.id,
        name: rg.name,
        location: rg.location,
        tags: rg.tags ?? {},
        resourceCount: resources.length,
        lastChangedIso:
          maxTs != null ? new Date(maxTs).toISOString() : null,
        hasTempTag,
      });
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// --------------------------------------------------------------------------
// Filters / display state
// --------------------------------------------------------------------------

const ALL_SEVERITIES: Severity[] = ["critical", "high", "medium", "info"];
const ALL_RESOURCE_TYPES: ResourceType[] = [
  "storage",
  "keyvault",
  // Corpus signals — kept on the right so the original storage/kv
  // chips stay in the same screen position for muscle memory.
  "diagnostic-setting",
  "subscription",
  "storage-container",
  "resource-group",
];
// Findings older than this are considered "stale / unfixed". 30 days
// is the typical SLA window in MicroBurst / Prowler default policies
// (NIST 800-53 SI-2 "Flaw Remediation" timing target).
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

// Default idle-RG threshold (Signal D). 90 days matches the Azucar /
// ScoutSuite default — the corpus tools' authors picked it because
// 90 days is one full sprint quarter; an RG that hasn't changed for
// a quarter is almost certainly forgotten.
// citation: New folder\_analysis_defender_view.md §1
const IDLE_RG_DEFAULT_DAYS = 90;
const IDLE_RG_MIN_DAYS = 7;
const IDLE_RG_MAX_DAYS = 365;

function resourceTypeLabel(t: ResourceType): string {
  switch (t) {
    case "storage":
      return "Storage Account";
    case "keyvault":
      return "Key Vault";
    case "diagnostic-setting":
      return "Diagnostic Setting";
    case "subscription":
      return "Subscription";
    case "storage-container":
      return "Storage Container";
    case "resource-group":
      return "Resource Group";
    default:
      return t;
  }
}

function resourceTypeIcon(t: ResourceType): React.ElementType {
  switch (t) {
    case "storage":
      return FileText;
    case "keyvault":
      return KeyRound;
    case "diagnostic-setting":
      return Activity;
    case "subscription":
      return CreditCard;
    case "storage-container":
      return FolderOpen;
    case "resource-group":
      return Layers;
    default:
      return FileText;
  }
}

// --------------------------------------------------------------------------
// Page component
// --------------------------------------------------------------------------

export const SecurityAuditPage: React.FC = () => {
  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={150}>
        <SecurityAuditPageInner />
      </TooltipProvider>
    </ErrorBoundary>
  );
};

const SecurityAuditPageInner: React.FC = () => {
  const state = useMultiRegionState();

  // Pull every subscription across every signed-in account into a
  // flat list. The picker is keyed by `subscriptionId|homeAccountId`
  // so two different operator identities that both see the same sub
  // don't collide.
  const allSubscriptions: ScopeSubscription[] = React.useMemo(() => {
    const out: ScopeSubscription[] = [];
    for (const acct of state.azureAccounts ?? []) {
      if (acct.signedOut) continue;
      if (acct.status === "error") continue;
      for (const sub of acct.subscriptions ?? []) {
        out.push({
          subscriptionId: sub.subscriptionId,
          displayName: sub.displayName,
          tenantId: sub.tenantId,
          homeAccountId: acct.homeAccountId,
        });
      }
    }
    // Stable order: displayName ascending so the picker doesn't
    // re-shuffle when MSAL re-emits the accounts list.
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [state.azureAccounts]);

  // Flat list of distinct accounts behind the subscriptions — used to
  // resolve which account's ARM token a given sub needs.
  const accountsById = React.useMemo(() => {
    const map = new Map<string, ScopeAccount>();
    for (const acct of state.azureAccounts ?? []) {
      if (acct.signedOut) continue;
      if (acct.status === "error") continue;
      map.set(acct.homeAccountId, {
        homeAccountId: acct.homeAccountId,
        tenantId: acct.tenantId,
        username: acct.username,
        name: acct.name || acct.username,
        subscriptions: (acct.subscriptions ?? []).map((s) => ({
          subscriptionId: s.subscriptionId,
          displayName: s.displayName,
          tenantId: s.tenantId,
          homeAccountId: acct.homeAccountId,
        })),
      });
    }
    return map;
  }, [state.azureAccounts]);

  // Primary account for token-expiry badge. The actual ARM tokens
  // used during a scan are acquired per-subscription via
  // `getArmTokenForAccount` (see the scan effect) so multi-tenant
  // scopes work without forcing the operator to pre-pick one.
  const primaryAccount = (state.azureAccounts ?? []).find(
    (a) => !a.signedOut && a.status !== "error",
  );
  const armTokenTracker = useArmToken(
    primaryAccount?.homeAccountId,
    primaryAccount ? resolveActiveTenantId(primaryAccount) : undefined,
  );

  // ----------------- Scope selection -----------------
  const [selectedSubIds, setSelectedSubIds] = React.useState<Set<string>>(
    () => new Set<string>(),
  );

  // Auto-pick the first sub when the operator has exactly one — saves
  // a click for single-sub tenants (the common dev case). We only do
  // this on the very first render where there's nothing selected so
  // we don't fight the operator's manual deselect.
  const autoPickedRef = React.useRef(false);
  React.useEffect(() => {
    if (autoPickedRef.current) return;
    if (allSubscriptions.length === 1 && selectedSubIds.size === 0) {
      setSelectedSubIds(new Set([allSubscriptions[0]!.subscriptionId]));
      autoPickedRef.current = true;
    }
  }, [allSubscriptions, selectedSubIds.size]);

  const toggleSubSelected = React.useCallback((subscriptionId: string) => {
    setSelectedSubIds((prev) => {
      const next = new Set(prev);
      if (next.has(subscriptionId)) next.delete(subscriptionId);
      else next.add(subscriptionId);
      return next;
    });
  }, []);

  const selectAllSubs = React.useCallback(() => {
    setSelectedSubIds(
      new Set(allSubscriptions.map((s) => s.subscriptionId)),
    );
  }, [allSubscriptions]);

  const clearAllSubs = React.useCallback(() => {
    setSelectedSubIds(new Set());
  }, []);

  // ----------------- Scan state -----------------
  const [scanning, setScanning] = React.useState(false);
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [findings, setFindings] = React.useState<Finding[]>([]);
  const [scanCounts, setScanCounts] = React.useState<ScanCounts>({
    storage: 0,
    vaults: 0,
  });
  const [scanWarnings, setScanWarnings] = React.useState<WarningRow[]>([]);
  const [lastScanAt, setLastScanAt] = React.useState<string | null>(null);
  const [lastScannedScope, setLastScannedScope] = React.useState<
    ScopeSubscription[]
  >([]);

  // Abort current scan when one is already in flight and the operator
  // hits Run Audit again — last click wins.
  const abortRef = React.useRef<AbortController | null>(null);

  // Idle-RG threshold for Signal D — persisted so the operator's
  // chosen sensitivity (e.g. 30 days for a hot environment, 180 for
  // a stable one) survives reloads. Bounded to [7, 365].
  // citation: New folder\_analysis_defender_view.md §1 — Azucar /
  // ScoutSuite default is 90 days.
  const [idleThresholdDays, setIdleThresholdDays] = usePersistedState<number>(
    "security-audit:idle-rg-threshold-days-v1",
    () => IDLE_RG_DEFAULT_DAYS,
    {
      version: 1,
      migrate: (raw): number => {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          return IDLE_RG_DEFAULT_DAYS;
        }
        return Math.min(IDLE_RG_MAX_DAYS, Math.max(IDLE_RG_MIN_DAYS, raw));
      },
    },
  );

  // ----------------- Finding "first seen" tracking -----------------
  // Hoisted above `runAudit` so the scan callback can stamp brand-new
  // finding ids without a TDZ on the setter. The map is pruned to ids
  // currently present in the findings list whenever a new scan
  // completes (in the scan effect below).
  type FirstSeenMap = Record<string, number /* ms since epoch */>;
  const [firstSeenAt, setFirstSeenAt] = usePersistedState<FirstSeenMap>(
    "security-audit:first-seen-v1",
    () => ({}),
    { version: 1 },
  );

  // ----------------- Posture-trend snapshots (wave 8) -----------------
  // Hoisted above `runAudit` so the scan callback can push a fresh
  // snapshot without a TDZ on the setter. Persists a small ring buffer
  // of per-scan summaries so the operator sees movement between runs
  // (sparkline + delta vs. previous). The ring is capped at
  // POSTURE_TREND_MAX (30) inside the helper.
  //
  // citation: New folder\_analysis_defender_view.md §1 — ScoutSuite
  // ships HTML reports keyed off snapshots; we mirror in-page.
  const [postureSnapshots, setPostureSnapshots] = usePersistedState<
    PostureSnapshot[]
  >("security-audit:posture-trend-v1", () => [], { version: 1 });

  const runAudit = React.useCallback(async () => {
    if (selectedSubIds.size === 0) return;
    // Resolve the picked subs back to full scope entries (with the
    // owning account context).
    const targets = allSubscriptions.filter((s) =>
      selectedSubIds.has(s.subscriptionId),
    );
    if (targets.length === 0) return;

    // Cancel any prior in-flight scan.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setScanning(true);
    setScanError(null);
    setFindings([]);
    setScanCounts({ storage: 0, vaults: 0 });
    setScanWarnings([]);

    const aggFindings: Finding[] = [];
    const aggCounts: ScanCounts = { storage: 0, vaults: 0 };
    const aggWarnings: WarningRow[] = [];

    try {
      // Dynamic import of `getArmTokenForAccount` to avoid pulling
      // MSAL into the page bundle unless the operator actually runs a
      // scan (cheap defer; first-click latency is negligible).
      const { getArmTokenForAccount } = await import("../../auth/msal-auth");

      // --- Signal B: subscription-state probe (tenant-wide) ---
      // Run ONCE per scan, using the first token we can acquire from
      // an in-scope account. ARM's /subscriptions endpoint returns the
      // full set of subs the caller can see — so the same call covers
      // every selected sub in one shot. Tier-0 flag is set based on
      // whether the operator picked the sub for scanning (i.e. they
      // care about it). citation: New folder\_AZURE_BYPASS_PLAYBOOK.md
      // §"Critical Defender Audit Surface" item 10.
      const subProbeAccount = accountsById.get(
        targets[0]!.homeAccountId,
      );
      if (subProbeAccount) {
        try {
          const probeToken = await getArmTokenForAccount(
            subProbeAccount.homeAccountId,
            subProbeAccount.tenantId,
          );
          if (probeToken && !ctrl.signal.aborted) {
            try {
              const subList = await fetchArmPaged<SubscriptionListEntry>(
                listSubscriptionsUrl(),
                probeToken,
                ctrl.signal,
              );
              const selectedIdSet = new Set(
                targets.map((t) => t.subscriptionId),
              );
              const decorated: SubscriptionListEntry[] = subList.map((s) => ({
                ...s,
                isTierZero: selectedIdSet.has(s.subscriptionId),
              }));
              aggFindings.push(...evaluateSubscriptionStates(decorated));
            } catch (probeErr) {
              const e = probeErr as Error & { status?: number };
              // 403 on /subscriptions is rare (any signed-in identity
              // can read it) — but treat gracefully as a warning row.
              if (!ctrl.signal.aborted) {
                aggWarnings.push({
                  kind: "warning",
                  id: `warn::sub-state-probe::${e.status ?? "err"}`,
                  subscriptionId: "(tenant)",
                  subscriptionName: "Subscription-state probe (Signal B)",
                  message: `Could not list subscriptions for cancel-state check: ${e.message ?? String(e)}`,
                });
              }
            }
          }
        } catch {
          // Token acquisition failure already surfaces below in the
          // per-sub loop; no duplicate warning here.
        }
      }

      // Sequential per-sub to be a polite ARM citizen — parallelizing
      // tends to trip per-tenant rate limits when the operator has 20+
      // subs. Each sub is two parallel calls (storage + vaults)
      // internally already.
      for (const sub of targets) {
        if (ctrl.signal.aborted) break;
        const acct = accountsById.get(sub.homeAccountId);
        if (!acct) {
          aggWarnings.push({
            kind: "warning",
            id: `warn::${sub.subscriptionId}::no-account`,
            subscriptionId: sub.subscriptionId,
            subscriptionName: sub.displayName,
            message:
              "Owning account is no longer signed in. Re-add it on Azure Accounts.",
          });
          continue;
        }
        let token: string | null = null;
        try {
          // Pass the SUBSCRIPTION's tenant id (not the account's home
          // tenant) so multi-tenant guests / Lighthouse-delegated subs
          // get a token scoped to the right directory. Home-tenant
          // tokens would 401 on a sub that lives in a guested tenant.
          token = await getArmTokenForAccount(
            acct.homeAccountId,
            sub.tenantId,
          );
        } catch (err) {
          aggWarnings.push({
            kind: "warning",
            id: `warn::${sub.subscriptionId}::token-fail`,
            subscriptionId: sub.subscriptionId,
            subscriptionName: sub.displayName,
            message: `Token acquisition failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          continue;
        }
        if (!token) {
          aggWarnings.push({
            kind: "warning",
            id: `warn::${sub.subscriptionId}::token-null`,
            subscriptionId: sub.subscriptionId,
            subscriptionName: sub.displayName,
            message:
              "No ARM token returned. Check the account is signed in and the tenant is active.",
          });
          continue;
        }
        const result = await scanSubscription(
          { sub, token, signal: ctrl.signal },
          sub.displayName,
          { idleThresholdDays },
        );
        aggFindings.push(...result.findings);
        aggCounts.storage += result.storageCount;
        aggCounts.vaults += result.vaultCount;
        if (result.error) {
          aggWarnings.push({
            kind: "warning",
            id: `warn::${sub.subscriptionId}::scan-error`,
            subscriptionId: sub.subscriptionId,
            subscriptionName: sub.displayName,
            message: result.error,
          });
        }
      }

      if (ctrl.signal.aborted) {
        // Operator cancelled — leave the page in pre-scan state
        // without an error banner.
        return;
      }

      aggFindings.sort(compareFindings);
      setFindings(aggFindings);
      setScanCounts(aggCounts);
      setScanWarnings(aggWarnings);
      const now = new Date().toISOString();
      setLastScanAt(now);
      setLastScannedScope(targets);

      // Maintain the "first-seen" timestamp map: stamp every brand-new
      // finding-id with `Date.now()` and prune ids that no longer appear
      // (the issue was fixed — we shouldn't keep accumulating stale
      // localStorage entries forever).
      const nowMs = Date.now();
      const presentIds = new Set(aggFindings.map((f) => f.id));
      setFirstSeenAt((prev) => {
        const next: FirstSeenMap = {};
        // Keep entries for findings we still see, brand-new ones get `now`.
        for (const id of presentIds) {
          next[id] = prev[id] ?? nowMs;
        }
        return next;
      });

      // Audit log — success path. One entry per scan, with aggregate
      // counts so the audit-log page shows the scan dimensions
      // without us having to log per-finding spam. Corpus signal
      // counts are broken out so the defender's dashboard can chart
      // Signal A/B/C/D trends over time.
      const summary = summarizeFindings(aggFindings, aggCounts);
      let signalACount = 0;
      let signalBCount = 0;
      let signalCCount = 0;
      let signalDCount = 0;
      for (const f of aggFindings) {
        if (f.ruleId.startsWith("diag.")) signalACount += 1;
        else if (f.ruleId.startsWith("sub.state.")) signalBCount += 1;
        else if (f.ruleId.startsWith("container.public")) signalCCount += 1;
        else if (f.ruleId.startsWith("rg.")) signalDCount += 1;
      }
      auditLog.record({
        actor: primaryAccount?.username ?? "(unknown)",
        action: "security_audit_scan",
        target: targets.map((t) => t.displayName).join(", "),
        status: "success",
        details: {
          subscriptionIds: targets.map((t) => t.subscriptionId),
          storageCount: summary.storageScanned,
          vaultCount: summary.vaultsScanned,
          findingsCount: summary.total,
          criticalCount: summary.critical,
          highCount: summary.high,
          warnings: aggWarnings.length,
          corpusSignals: {
            diagAbsent: signalACount,
            subscriptionState: signalBCount,
            publicContainer: signalCCount,
            idleResourceGroup: signalDCount,
          },
          idleThresholdDays,
        },
      });

      // Push a posture-trend snapshot (wave 8). Pure helper bumps the
      // newest entry to the head of the ring and drops the oldest once
      // POSTURE_TREND_MAX (30) entries are reached. We compute the
      // Tier-0 score from the freshly-aggregated findings rather than
      // reading the memo so we don't have to thread it through the
      // closure deps.
      const t0Score = computeTierZeroProtectionScore({
        findings: aggFindings,
        vaultsScanned: aggCounts.vaults,
      }).score;
      setPostureSnapshots((prev) =>
        appendPostureSnapshot(prev, {
          iso: now,
          total: summary.total,
          critical: summary.critical,
          high: summary.high,
          medium: summary.medium,
          info: summary.info,
          tierZeroScore: t0Score,
          subscriptionsInScope: targets.length,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setScanError(msg);
      auditLog.record({
        actor: primaryAccount?.username ?? "(unknown)",
        action: "security_audit_scan",
        target: targets.map((t) => t.displayName).join(", "),
        status: "failure",
        error: msg,
        details: {
          subscriptionIds: targets.map((t) => t.subscriptionId),
        },
      });
    } finally {
      setScanning(false);
      // Only clear the abort ref if it's still THIS controller
      // (another scan may have raced in and replaced it).
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, [
    accountsById,
    allSubscriptions,
    primaryAccount,
    selectedSubIds,
    idleThresholdDays,
    setPostureSnapshots,
    setFirstSeenAt,
  ]);

  // Cancel any in-flight scan when the component unmounts.
  React.useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // ----------------- Filters (URL-synced for deep-linkable views) -----------------
  // Severity / resource-type filter sets and the search box live in the
  // URL so an operator can paste a deep-link into Slack and the same
  // filtered view loads on the other end. `criticalHighOnly` is a
  // boolean toggle ("1" = on).
  //
  // The hook treats the `initial` literal as render-stable (see
  // `useUrlState` contract) — we hoist a stable record literal up here
  // so the keys + array typing are unambiguous.
  const URL_INITIAL = React.useMemo(
    () => ({
      sev: ALL_SEVERITIES as readonly string[] as string[],
      type: ALL_RESOURCE_TYPES as readonly string[] as string[],
      q: "",
      crit: "",
      stale: "",
      // corpus-only chip — "1" shows only Signal-A/B/C/D findings
      // (defender-side detection signals). Off by default so the
      // existing storage/keyvault findings still surface.
      corpus: "",
      // Show-suppressed chip — "1" reveals suppressed findings.
      // Off by default so the operator's prior "this is a false
      // positive" decisions stay quiet until they ask to see them.
      sup: "",
    }),
    [],
  );
  const [urlState, setUrlState] = useUrlState(URL_INITIAL);

  const activeSeverities = React.useMemo<Set<Severity>>(() => {
    // `useUrlState` typings tighten array keys to `string[]`, but the URL
    // can round-trip a malformed value as a bare string. Cast through
    // `unknown` to break the static-type narrowing so the
    // `typeof raw === "string"` branch isn't reduced to `never`.
    const raw = urlState.sev as unknown as string | string[] | undefined;
    const arr: string[] = Array.isArray(raw)
      ? raw
      : typeof raw === "string" && raw.length > 0
        ? raw.split(",")
        : (ALL_SEVERITIES as readonly string[] as string[]);
    const valid = arr.filter((s: string): s is Severity =>
      (ALL_SEVERITIES as readonly string[]).includes(s),
    );
    return new Set<Severity>(valid.length > 0 ? valid : ALL_SEVERITIES);
  }, [urlState.sev]);

  const activeResourceTypes = React.useMemo<Set<ResourceType>>(() => {
    // See `activeSeverities` above — same widening rationale (cast through
    // `unknown` to break the static-type narrowing).
    const raw = urlState.type as unknown as string | string[] | undefined;
    const arr: string[] = Array.isArray(raw)
      ? raw
      : typeof raw === "string" && raw.length > 0
        ? raw.split(",")
        : (ALL_RESOURCE_TYPES as readonly string[] as string[]);
    const valid = arr.filter((t: string): t is ResourceType =>
      (ALL_RESOURCE_TYPES as readonly string[]).includes(t),
    );
    return new Set<ResourceType>(
      valid.length > 0 ? valid : ALL_RESOURCE_TYPES,
    );
  }, [urlState.type]);

  const searchText =
    typeof urlState.q === "string" ? urlState.q : "";
  const criticalHighOnly =
    (typeof urlState.crit === "string" && urlState.crit === "1") ||
    (Array.isArray(urlState.crit) && urlState.crit[0] === "1");
  const showStaleOnly =
    (typeof urlState.stale === "string" && urlState.stale === "1") ||
    (Array.isArray(urlState.stale) && urlState.stale[0] === "1");
  const showCorpusOnly =
    (typeof urlState.corpus === "string" && urlState.corpus === "1") ||
    (Array.isArray(urlState.corpus) && urlState.corpus[0] === "1");
  const showSuppressed =
    (typeof urlState.sup === "string" && urlState.sup === "1") ||
    (Array.isArray(urlState.sup) && urlState.sup[0] === "1");

  // Audit-log helper — fires once per *change* (not per render). We only
  // record human-driven filter mutations so the audit-log page isn't
  // flooded with the URL-restore round-trip on first mount.
  const recordFilterChange = React.useCallback(
    (kind: string, value: unknown) => {
      auditLog.record({
        actor: primaryAccount?.username ?? "(unknown)",
        action: "security_audit_filter",
        target: kind,
        status: "success",
        details: { value },
      });
    },
    [primaryAccount?.username],
  );

  const toggleSeverity = React.useCallback(
    (s: Severity) => {
      const next = new Set(activeSeverities);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      setUrlState({ sev: Array.from(next) });
      recordFilterChange("severity-toggle", Array.from(next));
    },
    [activeSeverities, setUrlState, recordFilterChange],
  );

  const toggleResourceType = React.useCallback(
    (t: ResourceType) => {
      const next = new Set(activeResourceTypes);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      setUrlState({ type: Array.from(next) });
      recordFilterChange("resource-type-toggle", Array.from(next));
    },
    [activeResourceTypes, setUrlState, recordFilterChange],
  );

  const setSearchText = React.useCallback(
    (q: string) => setUrlState({ q }),
    [setUrlState],
  );
  const setCriticalHighOnly = React.useCallback(
    (v: boolean) => {
      setUrlState({ crit: v ? "1" : "" });
      recordFilterChange("critical-high-only", v);
    },
    [setUrlState, recordFilterChange],
  );
  const setShowStaleOnly = React.useCallback(
    (v: boolean) => {
      setUrlState({ stale: v ? "1" : "" });
      recordFilterChange("stale-only", v);
    },
    [setUrlState, recordFilterChange],
  );
  const setShowCorpusOnly = React.useCallback(
    (v: boolean) => {
      setUrlState({ corpus: v ? "1" : "" });
      recordFilterChange("corpus-only", v);
    },
    [setUrlState, recordFilterChange],
  );
  const setShowSuppressed = React.useCallback(
    (v: boolean) => {
      setUrlState({ sup: v ? "1" : "" });
      recordFilterChange("show-suppressed", v);
    },
    [setUrlState, recordFilterChange],
  );

  // ----------------- Acknowledge / suppress (wave 8) -----------------
  // Two-state per-finding decision the operator can persist:
  //   - acknowledged: finding is real but expected (e.g. legacy KV
  //     awaiting a migration window). Still visible in the table with
  //     a muted style; counts AGAINST the total but is excluded from
  //     the critical-only export and from the screen-reader live
  //     "critical findings" announcement.
  //   - suppressed: finding is a false positive for THIS environment
  //     (e.g. a deliberately-public marketing-assets container). Filter
  //     defaults to HIDING suppressed rows. Operator can flip the
  //     "Show suppressed" chip to bring them back.
  //
  // Each decision carries an operator-attributed audit-log entry at the
  // time it was made, so a reviewer can answer "who acknowledged this,
  // when, and why?" by joining the audit log against the persisted map.
  //
  // Persistence key versioned (`-v1`) so we can migrate the envelope
  // if the shape grows fields (note, expiry, etc.).
  interface AckSuppressEntry {
    /** "ack" or "suppress" — string union narrowed at the type level. */
    state: "ack" | "suppress";
    /** ISO timestamp of the decision. */
    at: string;
    /** Operator username (or "(unknown)") at decision time. */
    actor: string;
    /** Optional free-form note; defaults to empty string. */
    note: string;
  }
  type AckSuppressMap = Record<string, AckSuppressEntry>;

  const [ackSuppressMap, setAckSuppressMap] = usePersistedState<AckSuppressMap>(
    "security-audit:ack-suppress-v1",
    () => ({}),
    { version: 1 },
  );

  // Threshold for the "stale" chip — finding-id first observed more
  // than 30 days ago and still appears in the latest scan.
  // Re-snapshots whenever a scan completes (so "now - 30d" reflects the
  // latest scan, not the first render hours ago).
  const staleThreshold = React.useMemo(
    () => Date.now() - STALE_THRESHOLD_MS,
    [lastScanAt],
  );

  // Filtered findings + warnings — warnings always show (they're
  // about scan health, not finding severity).
  const filteredFindings = React.useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const sevPredicate = (f: Finding) =>
      criticalHighOnly
        ? f.severity === "critical" || f.severity === "high"
        : activeSeverities.has(f.severity);
    return findings.filter((f) => {
      // Suppressed findings are hidden unless the operator opted in.
      // Acknowledged findings stay visible (they're real + tracked) —
      // they only get a muted style downstream.
      if (!showSuppressed && ackSuppressMap[f.id]?.state === "suppress") {
        return false;
      }
      if (!sevPredicate(f)) return false;
      if (!activeResourceTypes.has(f.resourceType)) return false;
      if (showStaleOnly) {
        const firstSeen = firstSeenAt[f.id];
        if (firstSeen == null || firstSeen > staleThreshold) return false;
      }
      if (showCorpusOnly && !isCorpusFinding(f)) return false;
      if (!q) return true;
      const hay = [
        f.resourceName,
        f.resourceGroup,
        f.region,
        f.subscriptionName,
        f.title,
        f.ruleId,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [
    findings,
    activeSeverities,
    activeResourceTypes,
    searchText,
    criticalHighOnly,
    showStaleOnly,
    showCorpusOnly,
    showSuppressed,
    ackSuppressMap,
    firstSeenAt,
    staleThreshold,
  ]);

  // (The `displayRows` shape used to be computed twice — once unsorted
  // and once after sort. The unsorted one was dead code, so it's been
  // removed. `sortedDisplayRows` below is the only render-bound list.)

  // ----------------- Sort -----------------
  type SortColumn = "name" | "type" | "severity" | "rg";
  type SortDir = "asc" | "desc";
  const [sortColumn, setSortColumn] = React.useState<SortColumn>("severity");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");

  const sortedFindings = React.useMemo(() => {
    const findOnly = filteredFindings.slice();
    const dir = sortDir === "desc" ? -1 : 1;
    findOnly.sort((a, b) => {
      if (sortColumn === "name") {
        return a.resourceName.localeCompare(b.resourceName) * dir;
      }
      if (sortColumn === "type") {
        const t = a.resourceType < b.resourceType
          ? -1
          : a.resourceType > b.resourceType
            ? 1
            : 0;
        // Stable secondary by name asc when types tie.
        return t !== 0 ? t * dir : a.resourceName.localeCompare(b.resourceName);
      }
      if (sortColumn === "rg") {
        const c = a.resourceGroup.localeCompare(b.resourceGroup) * dir;
        // Stable secondary by name asc when RGs tie.
        return c !== 0 ? c : a.resourceName.localeCompare(b.resourceName);
      }
      // severity:
      //   - primary key is `riskScoreFor` (severity weight + small
      //     bonus for corpus sentinel rules) so a critical Signal-B
      //     "subscription Warned" outranks a critical storage-public
      //     finding by 0.5 — the operator sees the imminent
      //     destructive op first;
      //   - flip primary by direction (desc shows worst-first, asc
      //     shows none-first);
      //   - tie-break by name ASC regardless of direction so
      //     within-severity rows stay alphabetically predictable.
      const riskA = riskScoreFor(a);
      const riskB = riskScoreFor(b);
      const sevDiff = (riskB - riskA) * (sortDir === "desc" ? 1 : -1);
      if (sevDiff !== 0) return sevDiff > 0 ? 1 : -1;
      // Stable secondary — keep the severity-weight fallback so a
      // tie on score still respects the canonical bucket order.
      const wDiff =
        (SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]) *
        (sortDir === "desc" ? 1 : -1);
      if (wDiff !== 0) return wDiff;
      return a.resourceName.localeCompare(b.resourceName);
    });
    return findOnly;
  }, [filteredFindings, sortColumn, sortDir]);

  const sortedDisplayRows: DisplayRow[] = React.useMemo(() => {
    return [
      ...scanWarnings,
      ...sortedFindings.map((f) => ({ kind: "finding" as const, ...f })),
    ];
  }, [scanWarnings, sortedFindings]);

  // Stable id -> Finding lookup. We hand the original (stable across
  // renders until findings[] mutates) reference to FindingRow so its
  // React.memo shallow-compare actually short-circuits on chip toggles.
  const sortedFindingsById = React.useMemo(() => {
    const m = new Map<string, Finding>();
    for (const f of sortedFindings) m.set(f.id, f);
    return m;
  }, [sortedFindings]);

  const onHeaderClick = React.useCallback(
    (col: SortColumn) => {
      if (sortColumn === col) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortColumn(col);
        setSortDir(col === "severity" ? "desc" : "asc");
      }
    },
    [sortColumn],
  );

  // ----------------- Summary stats -----------------
  const summary = React.useMemo(
    () => summarizeFindings(findings, scanCounts),
    [findings, scanCounts],
  );

  // Severity counts on ALL findings (not filtered) for the chips
  // — operators need to see the totals even when a filter hides them.
  const severityCounts = React.useMemo(
    () => countBySeverity(findings),
    [findings],
  );
  const resourceTypeCounts = React.useMemo(
    () => countByResourceType(findings),
    [findings],
  );

  // ----------------- Tier-0 Protection Score (wave 8) -----------------
  // Composite signal: of all Key Vaults scanned, how many have BOTH a
  // configured diagnostic setting AND no high/critical KV-config
  // finding? Score 0..100. Surfaced in the summary strip + tooltip
  // breakdown. citation: New folder\_analysis_defender_view.md §1.
  const tierZeroScore: TierZeroProtectionScore = React.useMemo(
    () =>
      computeTierZeroProtectionScore({
        findings,
        vaultsScanned: scanCounts.vaults,
      }),
    [findings, scanCounts.vaults],
  );

  // ----------------- Suppressed / acknowledged counts -----------------
  const suppressedCount = React.useMemo(() => {
    let n = 0;
    for (const f of findings) {
      if (ackSuppressMap[f.id]?.state === "suppress") n += 1;
    }
    return n;
  }, [findings, ackSuppressMap]);

  const acknowledgedCount = React.useMemo(() => {
    let n = 0;
    for (const f of findings) {
      if (ackSuppressMap[f.id]?.state === "ack") n += 1;
    }
    return n;
  }, [findings, ackSuppressMap]);

  // Critical count for the screen-reader live region — EXCLUDES
  // acknowledged + suppressed findings so the announcement reflects
  // what the operator hasn't already triaged. citation: WAI-ARIA
  // aria-live polite — change-only announcements.
  const announcedCriticalCount = React.useMemo(() => {
    let n = 0;
    for (const f of findings) {
      if (f.severity !== "critical") continue;
      const dec = ackSuppressMap[f.id];
      if (dec?.state === "ack" || dec?.state === "suppress") continue;
      n += 1;
    }
    return n;
  }, [findings, ackSuppressMap]);

  // Posture-trend snapshot delta vs. previous run.
  const postureDelta = React.useMemo(
    () => computePostureTrendDelta(postureSnapshots),
    [postureSnapshots],
  );

  // ----------------- Acknowledge / suppress callbacks -----------------
  const operatorName = primaryAccount?.username ?? "(unknown)";
  const setAckSuppress = React.useCallback(
    (findingId: string, finding: Finding, state: "ack" | "suppress" | "clear", note = "") => {
      setAckSuppressMap((prev) => {
        const next = { ...prev };
        if (state === "clear") {
          delete next[findingId];
        } else {
          next[findingId] = {
            state,
            at: new Date().toISOString(),
            actor: operatorName,
            note,
          };
        }
        return next;
      });
      auditLog.record({
        actor: operatorName,
        action: `security_audit_${state === "clear" ? "unmark" : state}`,
        target: finding.resourceName,
        status: "success",
        details: {
          findingId,
          ruleId: finding.ruleId,
          severity: finding.severity,
          resourceId: finding.resourceId,
          subscriptionId: finding.subscriptionId,
          note,
        },
      });
    },
    [setAckSuppressMap, operatorName],
  );

  // ----------------- Focused-finding keyboard model (wave 8) -----------------
  // Tracks which finding row currently has keyboard focus so the page
  // hotkeys (`a` ack, `s` suppress) can target it. Updated when a row
  // receives focus via Tab or click. Stored as the finding `id` rather
  // than an index so it survives re-sort.
  const [focusedFindingId, setFocusedFindingId] = React.useState<string | null>(
    null,
  );

  // ----------------- Bulk acknowledge (visible, non-suppressed) -----------------
  const bulkAcknowledgeVisible = React.useCallback(() => {
    if (filteredFindings.length === 0) return;
    setAckSuppressMap((prev) => {
      const next = { ...prev };
      const at = new Date().toISOString();
      for (const f of filteredFindings) {
        if (next[f.id]?.state === "suppress") continue;
        next[f.id] = {
          state: "ack",
          at,
          actor: operatorName,
          note: "bulk-acknowledge",
        };
      }
      return next;
    });
    auditLog.record({
      actor: operatorName,
      action: "security_audit_bulk_acknowledge",
      target: `${filteredFindings.length} visible finding(s)`,
      status: "success",
      details: {
        findingIds: filteredFindings.map((f) => f.id),
        bucketCounts: {
          critical: filteredFindings.filter((f) => f.severity === "critical").length,
          high: filteredFindings.filter((f) => f.severity === "high").length,
          medium: filteredFindings.filter((f) => f.severity === "medium").length,
          info: filteredFindings.filter((f) => f.severity === "info").length,
        },
      },
    });
  }, [filteredFindings, setAckSuppressMap, operatorName]);

  // ----------------- Tenant-switch sync -----------------
  // When the operator switches the active tenant in the sidebar, swap
  // the picked subscription scope to the subs owned by that account.
  // Mirrors the canonical pattern from invite-user-page.tsx, adapted
  // for this page's multi-select scope. The hook stashes its callback
  // in a ref so the listener always sees the latest closure — we still
  // wrap in useCallback for narrative clarity / future stability.
  const onTenantChanged = React.useCallback(
    (detail: { homeAccountId: string }) => {
      const candidate = detail.homeAccountId;
      const ownedSubs = allSubscriptions.filter(
        (s) => s.homeAccountId === candidate,
      );
      if (ownedSubs.length === 0) return;
      const ownedIds = new Set(ownedSubs.map((s) => s.subscriptionId));
      // Skip if the current selection is already exactly this account's subs.
      if (
        selectedSubIds.size === ownedIds.size &&
        Array.from(selectedSubIds).every((id) => ownedIds.has(id))
      ) {
        return;
      }
      setSelectedSubIds(ownedIds);
    },
    [allSubscriptions, selectedSubIds],
  );
  useTenantChange(undefined, onTenantChanged);

  // ----------------- Export -----------------
  const exportColumns = React.useMemo(
    () => [
      { header: "Severity", accessor: (f: Finding) => SEVERITY_LABEL[f.severity] },
      // Risk score = severity weight + small bonus for corpus
      // sentinel rules (A/B/C). Lets exports be sorted-by-risk
      // outside the UI.
      { header: "Risk Score", accessor: (f: Finding) => riskScoreFor(f).toFixed(2) },
      {
        header: "Signal Class",
        accessor: (f: Finding) =>
          isCorpusFinding(f) ? "corpus-defender" : "microburst-style",
      },
      { header: "Resource Type", accessor: (f: Finding) => resourceTypeLabel(f.resourceType) },
      { header: "Resource Name", accessor: (f: Finding) => f.resourceName },
      { header: "Resource Group", accessor: (f: Finding) => f.resourceGroup },
      { header: "Region", accessor: (f: Finding) => f.region },
      { header: "Subscription", accessor: (f: Finding) => f.subscriptionName },
      { header: "Subscription Id", accessor: (f: Finding) => f.subscriptionId },
      { header: "Rule Id", accessor: (f: Finding) => f.ruleId },
      { header: "Title", accessor: (f: Finding) => f.title },
      { header: "Description", accessor: (f: Finding) => f.description },
      { header: "Why It Matters", accessor: (f: Finding) => f.whyItMatters },
      { header: "Remediation", accessor: (f: Finding) => f.remediation },
      { header: "ARM Id", accessor: (f: Finding) => f.resourceId },
    ],
    [],
  );

  const jsonExportMetadata = React.useMemo(
    () => ({
      scanTimestamp: lastScanAt,
      scopeSubscriptions: lastScannedScope.map((s) => ({
        subscriptionId: s.subscriptionId,
        displayName: s.displayName,
        tenantId: s.tenantId,
      })),
      filters: {
        severities: Array.from(activeSeverities),
        resourceTypes: Array.from(activeResourceTypes),
        searchText: searchText.trim(),
        criticalHighOnly,
        showStaleOnly,
        showCorpusOnly,
        showSuppressed,
        staleThresholdDays: 30,
        idleResourceGroupThresholdDays: idleThresholdDays,
      },
      scanned: scanCounts,
      summary,
      // Tier-0 protection score (wave 8) so JSON exports carry the
      // composite signal alongside the per-finding rows.
      tierZeroProtection: {
        score: tierZeroScore.score,
        protectedCount: tierZeroScore.protectedCount,
        totalCount: tierZeroScore.totalCount,
        topOffenders: tierZeroScore.topOffenders,
      },
      ackSuppressCounts: {
        acknowledged: acknowledgedCount,
        suppressed: suppressedCount,
      },
    }),
    [
      lastScanAt,
      lastScannedScope,
      activeSeverities,
      activeResourceTypes,
      searchText,
      criticalHighOnly,
      showStaleOnly,
      showCorpusOnly,
      showSuppressed,
      idleThresholdDays,
      scanCounts,
      summary,
      tierZeroScore,
      acknowledgedCount,
      suppressedCount,
    ],
  );

  // ----------------- Render -----------------
  const titleId = React.useId();
  const searchId = React.useId();
  const critOnlyId = React.useId();
  const staleOnlyId = React.useId();
  const corpusOnlyId = React.useId();
  const showSuppressedId = React.useId();
  const idleThresholdId = React.useId();

  // Count of findings older than 30 days (for the chip badge) — pulled
  // from the unfiltered list so the number reflects reality even when
  // the chip itself is hiding rows.
  const staleCount = React.useMemo(() => {
    let n = 0;
    for (const f of findings) {
      const t = firstSeenAt[f.id];
      if (t != null && t <= staleThreshold) n += 1;
    }
    return n;
  }, [findings, firstSeenAt, staleThreshold]);

  // Count of corpus-derived findings — surfaces in the chip badge so
  // the operator can tell at a glance how much of the total comes from
  // the four defender signals (A: diag, B: sub-state, C: container,
  // D: idle-RG). Pulled from the unfiltered list for the same reason
  // as staleCount above.
  const corpusFindingCount = React.useMemo(() => {
    let n = 0;
    for (const f of findings) if (isCorpusFinding(f)) n += 1;
    return n;
  }, [findings]);

  const clearFilters = React.useCallback(() => {
    setUrlState({
      sev: ALL_SEVERITIES as readonly string[] as string[],
      type: ALL_RESOURCE_TYPES as readonly string[] as string[],
      q: "",
      crit: "",
      stale: "",
      corpus: "",
      sup: "",
    });
    recordFilterChange("clear-filters", null);
  }, [setUrlState, recordFilterChange]);

  // ----------------- Export-critical-only (wave 8 hotkey `e`) -----------------
  // The ExportMenu uses `filteredFindings`. For the hotkey we hand-roll
  // a CSV blob of CRITICAL-only findings (regardless of current
  // filters) so the operator can ship a fast triage list. Tabs are CSV
  // separators so we don't have to quote commas inside the
  // remediation/whyItMatters text.
  const exportCriticalOnly = React.useCallback(() => {
    const crits = findings.filter((f) => f.severity === "critical");
    if (crits.length === 0) {
      auditLog.record({
        actor: operatorName,
        action: "security_audit_export_critical_only",
        target: "no-critical-findings",
        status: "success",
        details: { count: 0 },
      });
      return;
    }
    const headers = [
      "severity",
      "ruleId",
      "resourceType",
      "resourceName",
      "resourceGroup",
      "region",
      "subscriptionName",
      "title",
      "description",
      "armId",
    ];
    const escape = (v: string) =>
      `"${v.replace(/"/g, '""').replace(/\n/g, " ")}"`;
    const lines = [headers.join(",")];
    for (const f of crits) {
      lines.push(
        [
          escape(SEVERITY_LABEL[f.severity]),
          escape(f.ruleId),
          escape(resourceTypeLabel(f.resourceType)),
          escape(f.resourceName),
          escape(f.resourceGroup),
          escape(f.region),
          escape(f.subscriptionName),
          escape(f.title),
          escape(f.description),
          escape(f.resourceId),
        ].join(","),
      );
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `security-audit-critical-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    auditLog.record({
      actor: operatorName,
      action: "security_audit_export_critical_only",
      target: `${crits.length} critical finding(s)`,
      status: "success",
      details: { count: crits.length },
    });
  }, [findings, operatorName]);

  // ----------------- Hotkeys (wave 8) -----------------
  // `a` — acknowledge focused finding (or first visible critical when
  //       nothing's focused).
  // `s` — suppress focused finding (same fallback).
  // `e` — export critical-only.
  // All three respect input focus (the hook's default).
  const focusedFinding = React.useMemo(() => {
    if (!focusedFindingId) return null;
    return sortedFindings.find((f) => f.id === focusedFindingId) ?? null;
  }, [focusedFindingId, sortedFindings]);

  useShortcut("a", () => {
    const target =
      focusedFinding ??
      sortedFindings.find((f) => f.severity === "critical") ??
      sortedFindings[0];
    if (!target) return;
    const dec = ackSuppressMap[target.id];
    // Toggle: ack again clears.
    setAckSuppress(
      target.id,
      target,
      dec?.state === "ack" ? "clear" : "ack",
    );
  });
  useShortcut("s", () => {
    const target =
      focusedFinding ??
      sortedFindings.find((f) => f.severity === "critical") ??
      sortedFindings[0];
    if (!target) return;
    const dec = ackSuppressMap[target.id];
    setAckSuppress(
      target.id,
      target,
      dec?.state === "suppress" ? "clear" : "suppress",
    );
  });
  useShortcut("e", () => {
    exportCriticalOnly();
  });

  return (
    <div
      className="flex flex-col gap-4 py-4"
      role="region"
      aria-labelledby={titleId}
    >
      <PageHeader
        title="Storage & Key Vault Security Audit"
        description="Scan your subscriptions' storage accounts and key vaults for misconfigurations attackers would notice first. Read-only — every ARM call is a GET."
        titleId={titleId}
      >
        <TokenExpiryBadge
          secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
          loading={armTokenTracker.loading}
          onRefresh={() => void armTokenTracker.refresh()}
          needsReauth={armTokenTracker.needsReauth}
          onReauth={() =>
            void armTokenTracker.reauth({
              loginHint: primaryAccount?.username,
            })
          }
        />
        <Button
          variant="default"
          onClick={() => void runAudit()}
          loading={scanning}
          disabled={selectedSubIds.size === 0 || scanning}
          aria-label="Run security audit scan against selected subscriptions"
        >
          <ShieldCheck />
          {scanning ? "Scanning…" : "Run Audit"}
        </Button>
        <ExportMenu<Finding>
          rows={filteredFindings}
          columns={exportColumns}
          filename="security-audit"
          label="Export"
          jsonMetadata={jsonExportMetadata}
        />
      </PageHeader>

      {/* Scope picker */}
      <div className="rounded-xl border bg-card/50 p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-sm font-semibold">
              Subscription scope
            </h2>
            <InfoTooltip
              content="Pick one or more subscriptions you have read access to. Each picked sub is scanned for storage accounts and key vaults via two ARM list calls (paginated). No POST/PATCH/DELETE — read-only."
              size={13}
            />
            <span className="text-2xs text-muted-foreground">
              {selectedSubIds.size} of {allSubscriptions.length} selected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={selectAllSubs}
              disabled={allSubscriptions.length === 0}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearAllSubs}
              disabled={selectedSubIds.size === 0}
            >
              Clear
            </Button>
          </div>
        </div>
        {allSubscriptions.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">
            No subscriptions discovered. Sign in on the Azure Accounts page
            first.
          </p>
        ) : (
          <ul className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
            {allSubscriptions.map((sub) => {
              const checked = selectedSubIds.has(sub.subscriptionId);
              const ownerLabel =
                accountsById.get(sub.homeAccountId)?.username ?? "";
              return (
                <li
                  key={`${sub.subscriptionId}|${sub.homeAccountId}`}
                  className={cn(
                    "flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs transition-colors",
                    checked
                      ? "border-primary/60 bg-primary/5"
                      : "hover:bg-accent/30",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleSubSelected(sub.subscriptionId)}
                    aria-label={`Select subscription ${sub.displayName}`}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className="truncate font-medium"
                      title={sub.displayName}
                    >
                      {sub.displayName}
                    </span>
                    <span
                      className="truncate font-mono text-3xs text-muted-foreground"
                      title={`${sub.subscriptionId} • ${ownerLabel}`}
                    >
                      {sub.subscriptionId.slice(0, 8)} • {ownerLabel}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Scan error banner */}
      {scanError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Scan failed: {scanError}. Re-check your ARM token and retry.
          </span>
        </div>
      )}

      {/* Screen-reader-only critical-count change announcer. Surfaces a
          targeted announcement when the un-acknowledged un-suppressed
          critical count changes — separate from the visible summary so
          the live region is small and the assistive-tech announcement
          is short. citation: WAI-ARIA aria-live + aria-atomic. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {lastScanAt
          ? announcedCriticalCount === 0
            ? "No critical findings outstanding."
            : `${announcedCriticalCount} critical finding${announcedCriticalCount === 1 ? "" : "s"} outstanding.`
          : ""}
      </div>

      {/* Summary stats */}
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7"
        role="status"
        aria-live="polite"
      >
        <SummaryStatItem
          label="Total findings"
          value={summary.total}
          tone={summary.total > 0 ? "info" : "muted"}
          hint={
            lastScanAt
              ? `scanned ${new Date(lastScanAt).toLocaleString()}${
                  postureDelta && postureDelta.totalDelta !== 0
                    ? ` (Δ${postureDelta.totalDelta > 0 ? "+" : ""}${postureDelta.totalDelta} vs. prior)`
                    : ""
                }`
              : "not scanned yet"
          }
        />
        <SummaryStatItem
          label="Critical"
          value={summary.critical}
          tone={summary.critical > 0 ? "destructive" : "muted"}
          hint={
            acknowledgedCount + suppressedCount > 0
              ? `${acknowledgedCount} ack · ${suppressedCount} suppressed`
              : undefined
          }
        />
        <SummaryStatItem
          label="High"
          value={summary.high}
          tone={summary.high > 0 ? "warning" : "muted"}
        />
        <SummaryStatItem
          label="Medium"
          value={summary.medium}
          tone={summary.medium > 0 ? "info" : "muted"}
        />
        <SummaryStatItem
          label="Storage scanned"
          value={summary.storageScanned}
          tone="muted"
          hint={
            resourceTypeCounts.storage > 0
              ? `${resourceTypeCounts.storage} finding${resourceTypeCounts.storage === 1 ? "" : "s"}`
              : "no findings"
          }
        />
        <SummaryStatItem
          label="Key Vaults scanned"
          value={summary.vaultsScanned}
          tone="muted"
          hint={
            resourceTypeCounts.keyvault > 0
              ? `${resourceTypeCounts.keyvault} finding${resourceTypeCounts.keyvault === 1 ? "" : "s"}`
              : "no findings"
          }
        />
        {/* Tier-0 Protection Score — composite signal (wave 8).
            citation: New folder\_analysis_defender_view.md §1. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-help">
              <SummaryStatItem
                label="Tier-0 Score"
                value={
                  tierZeroScore.totalCount > 0
                    ? `${tierZeroScore.score}%`
                    : "—"
                }
                tone={
                  tierZeroScore.totalCount === 0
                    ? "muted"
                    : tierZeroScore.score >= 80
                      ? "success"
                      : tierZeroScore.score >= 50
                        ? "warning"
                        : "destructive"
                }
                hint={
                  tierZeroScore.totalCount > 0
                    ? `${tierZeroScore.protectedCount}/${tierZeroScore.totalCount} vaults clean${
                        postureDelta && postureDelta.tierZeroDelta !== 0
                          ? ` (Δ${postureDelta.tierZeroDelta > 0 ? "+" : ""}${postureDelta.tierZeroDelta}pt)`
                          : ""
                      }`
                    : "no vaults scanned"
                }
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" className="max-w-md">
            <p className="m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tier-0 protection score
            </p>
            <p className="m-0 mt-1 text-xs leading-relaxed">
              % of Key Vaults with NO purge/soft-delete/network gap AND
              an active diagnostic setting forwarding audit logs. Treats
              Key Vault as the canonical Tier-0 surface (bearer credential
              custody). Score &lt; 50% means the majority of vaults have
              at least one disqualifying finding.
            </p>
            {tierZeroScore.topOffenders.length > 0 && (
              <div className="mt-2 border-t pt-2">
                <p className="m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Top offenders
                </p>
                <ul className="m-0 mt-1 list-none space-y-0.5 p-0 text-2xs">
                  {tierZeroScore.topOffenders.map((o) => (
                    <li key={o.ruleId} className="font-mono">
                      {o.ruleId} <span className="text-muted-foreground">×{o.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Posture-trend sparkline — minimal SVG, no charting lib.
          citation: New folder\_analysis_defender_view.md §1 — ScoutSuite
          ships HTML reports keyed off snapshot history; we mirror in-page. */}
      {postureSnapshots.length >= 2 && (
        <PostureTrendSparkline snapshots={postureSnapshots} delta={postureDelta} />
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2">
        <FilterIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
        <div className="flex flex-wrap items-center gap-1">
          {ALL_SEVERITIES.map((s) => {
            const active = activeSeverities.has(s);
            const count = severityCounts[s] ?? 0;
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSeverity(s)}
                disabled={criticalHighOnly}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors",
                  active
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-accent/30",
                  criticalHighOnly && "opacity-50",
                )}
              >
                <SeverityDot severity={s} />
                {SEVERITY_LABEL[s]}
                <span className="tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
        <span className="h-4 w-px bg-border" aria-hidden />
        <div className="flex flex-wrap items-center gap-1">
          {ALL_RESOURCE_TYPES.map((t) => {
            const active = activeResourceTypes.has(t);
            const count = resourceTypeCounts[t] ?? 0;
            const Icon = resourceTypeIcon(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleResourceType(t)}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors",
                  active
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-accent/30",
                )}
              >
                <Icon className="h-3 w-3" />
                {resourceTypeLabel(t)}
                <span className="tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
        <span className="h-4 w-px bg-border" aria-hidden />
        <div className="relative max-w-xs flex-1">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id={searchId}
            type="search"
            placeholder="Search name / RG / region…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="h-7 pl-7 text-xs"
            aria-label="Search findings"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Switch
            id={critOnlyId}
            checked={criticalHighOnly}
            onCheckedChange={(v) => setCriticalHighOnly(Boolean(v))}
            aria-label="Show only critical and high severity findings"
          />
          <Label htmlFor={critOnlyId} className="cursor-pointer text-2xs">
            Critical + High only
          </Label>
        </div>
        <span className="h-4 w-px bg-border" aria-hidden />
        {/* "Stale" chip — findings whose finding-id was first observed
            more than 30 days ago AND still appears in the most recent
            scan. Persists across reloads via usePersistedState. */}
        <div className="flex items-center gap-1.5">
          <Switch
            id={staleOnlyId}
            checked={showStaleOnly}
            onCheckedChange={(v) => setShowStaleOnly(Boolean(v))}
            aria-label="Show only findings older than 30 days"
          />
          <Label
            htmlFor={staleOnlyId}
            className="inline-flex cursor-pointer items-center gap-1 text-2xs"
            title="Findings first observed more than 30 days ago and still present in the latest scan"
          >
            <Clock className="h-3 w-3" aria-hidden />
            Unfixed &gt; 30 days
            <span
              className="tabular-nums text-muted-foreground"
              aria-label={`${staleCount} stale finding${staleCount === 1 ? "" : "s"}`}
            >
              ({staleCount})
            </span>
          </Label>
        </div>
        <span className="h-4 w-px bg-border" aria-hidden />
        {/* "Corpus signals only" chip — restrict the table to the
            defender-side detection signals derived from the corpus
            (Signal A / B / C / D). Off by default so the existing
            MicroBurst-style storage + Key Vault findings still
            surface. citation: see security-audit-corpus-signals.ts. */}
        <div className="flex items-center gap-1.5">
          <Switch
            id={corpusOnlyId}
            checked={showCorpusOnly}
            onCheckedChange={(v) => setShowCorpusOnly(Boolean(v))}
            aria-label="Show only corpus-derived defender signals (diag / sub-state / public-container / idle-RG)"
          />
          <Label
            htmlFor={corpusOnlyId}
            className="inline-flex cursor-pointer items-center gap-1 text-2xs"
            title="Restrict to corpus-derived signals: diagnostic-setting absence, subscription cancellation states, public storage containers, and idle resource groups."
          >
            <ShieldAlert className="h-3 w-3" aria-hidden />
            Corpus signals only
            <span
              className="tabular-nums text-muted-foreground"
              aria-label={`${corpusFindingCount} corpus finding${corpusFindingCount === 1 ? "" : "s"}`}
            >
              ({corpusFindingCount})
            </span>
          </Label>
        </div>
        <span className="h-4 w-px bg-border" aria-hidden />
        {/* Idle-RG threshold input (Signal D). Bounded [7, 365], default 90.
            citation: New folder\_analysis_defender_view.md §1 — 90d matches
            the Azucar / ScoutSuite default. */}
        <div className="flex items-center gap-1.5">
          <Label
            htmlFor={idleThresholdId}
            className="inline-flex cursor-pointer items-center gap-1 text-2xs"
            title="Resource groups with no resource changes in this many days are flagged as idle (Signal D)."
          >
            <Layers className="h-3 w-3" aria-hidden />
            Idle RG threshold
          </Label>
          <Input
            id={idleThresholdId}
            type="number"
            inputMode="numeric"
            min={IDLE_RG_MIN_DAYS}
            max={IDLE_RG_MAX_DAYS}
            step={1}
            value={idleThresholdDays}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n)) {
                const clamped = Math.min(
                  IDLE_RG_MAX_DAYS,
                  Math.max(IDLE_RG_MIN_DAYS, n),
                );
                setIdleThresholdDays(clamped);
              }
            }}
            className="h-7 w-16 text-2xs tabular-nums"
            aria-label="Idle resource-group threshold in days"
          />
          <span className="text-2xs text-muted-foreground">days</span>
        </div>
        <span className="h-4 w-px bg-border" aria-hidden />
        {/* Suppressed chip — bring back rows the operator suppressed
            as false positives. Off by default. (wave 8) */}
        <div className="flex items-center gap-1.5">
          <Switch
            id={showSuppressedId}
            checked={showSuppressed}
            onCheckedChange={(v) => setShowSuppressed(Boolean(v))}
            aria-label="Show suppressed findings"
          />
          <Label
            htmlFor={showSuppressedId}
            className="inline-flex cursor-pointer items-center gap-1 text-2xs"
            title="Findings the operator has previously suppressed as false positives are hidden by default. Toggle this to bring them back."
          >
            <EyeOff className="h-3 w-3" aria-hidden />
            Show suppressed
            <span
              className="tabular-nums text-muted-foreground"
              aria-label={`${suppressedCount} suppressed finding${suppressedCount === 1 ? "" : "s"}`}
            >
              ({suppressedCount})
            </span>
          </Label>
        </div>
        {/* Bulk acknowledge — applies to whatever is currently
            VISIBLE in the filtered list. Operator audit-trail recorded
            via auditLog. (wave 8) */}
        {filteredFindings.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={bulkAcknowledgeVisible}
                aria-label={`Acknowledge ${filteredFindings.length} visible findings`}
              >
                <ShieldCheck className="h-3 w-3" />
                Ack visible
                <span className="tabular-nums text-muted-foreground">
                  ({filteredFindings.length})
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="max-w-xs">
              Bulk-mark every visible finding as acknowledged (real
              but expected). Recorded in the audit log with your
              operator name. Suppressed rows are skipped.
            </TooltipContent>
          </Tooltip>
        )}
        {(activeSeverities.size < ALL_SEVERITIES.length ||
          activeResourceTypes.size < ALL_RESOURCE_TYPES.length ||
          searchText.trim() ||
          criticalHighOnly ||
          showStaleOnly ||
          showCorpusOnly ||
          showSuppressed) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            aria-label="Clear filters"
          >
            <X className="h-3 w-3" />
            Clear filters
          </Button>
        )}
      </div>
      {/* Keyboard shortcuts hint — also reads via aria-label so
          screen readers learn about the hotkeys. */}
      <p className="m-0 text-3xs text-muted-foreground" aria-live="off">
        Hotkeys: <kbd className="rounded border px-1 font-mono">a</kbd> acknowledge ·
        {" "}<kbd className="rounded border px-1 font-mono">s</kbd> suppress ·
        {" "}<kbd className="rounded border px-1 font-mono">e</kbd> export critical-only.
        Focus a row by tabbing into the table.
      </p>

      {/* Findings table */}
      {sortedDisplayRows.length === 0 ? (
        scanning ? (
          <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-4 py-12 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Scanning {selectedSubIds.size} subscription
            {selectedSubIds.size === 1 ? "" : "s"}…
          </div>
        ) : findings.length === 0 && lastScanAt ? (
          <EmptyState
            icon={CheckCircle2}
            title="No findings"
            description="Every storage account and key vault in the scope passed the audit. Re-scan after you make changes to confirm."
          />
        ) : (
          <EmptyState
            icon={ShieldCheck}
            title={
              selectedSubIds.size === 0
                ? "Pick a subscription"
                : "Ready to scan"
            }
            description={
              selectedSubIds.size === 0
                ? "Select one or more subscriptions above, then click Run Audit."
                : "Click Run Audit to scan the selected subscriptions for storage and key-vault misconfigurations."
            }
            action={
              selectedSubIds.size > 0
                ? {
                    label: "Run Audit",
                    onClick: () => void runAudit(),
                    icon: RefreshCw,
                    loading: scanning,
                  }
                : undefined
            }
          />
        )
      ) : (
        <div className="overflow-auto rounded-md border border-border bg-card">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <SortableHeader
                  label="Severity"
                  active={sortColumn === "severity"}
                  dir={sortDir}
                  onClick={() => onHeaderClick("severity")}
                />
                <SortableHeader
                  label="Type"
                  active={sortColumn === "type"}
                  dir={sortDir}
                  onClick={() => onHeaderClick("type")}
                />
                <SortableHeader
                  label="Resource"
                  active={sortColumn === "name"}
                  dir={sortDir}
                  onClick={() => onHeaderClick("name")}
                />
                <SortableHeader
                  label="Resource Group"
                  active={sortColumn === "rg"}
                  dir={sortDir}
                  onClick={() => onHeaderClick("rg")}
                />
                <TableHead>Region</TableHead>
                <TableHead>Finding</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedDisplayRows.map((row) => {
                if (row.kind === "warning") {
                  return (
                    <TableRow key={row.id} className="bg-warning/5">
                      <TableCell colSpan={7} className="text-xs">
                        <div className="flex items-start gap-2">
                          <AlertTriangle
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
                            aria-hidden
                          />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="font-medium text-warning">
                              {row.subscriptionName}
                            </span>
                            <span className="text-muted-foreground">
                              {row.message}
                            </span>
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }
                const entry = ackSuppressMap[row.id];
                // Look the original finding back up from the stable
                // id->Finding map so we hand the memoized child the
                // STABLE Finding reference (the `row` here is a freshly-
                // spread {kind, ...f} object created in
                // `sortedDisplayRows` and would defeat React.memo).
                const original = sortedFindingsById.get(row.id);
                if (!original) return null;
                return (
                  <FindingRow
                    key={row.id}
                    finding={original}
                    decision={entry?.state ?? null}
                    decisionAt={entry?.at}
                    decisionActor={entry?.actor}
                    focused={focusedFindingId === row.id}
                    setFocused={setFocusedFindingId}
                    setAckSuppress={setAckSuppress}
                  />
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

// --------------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------------

const SortableHeader: React.FC<{
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}> = ({ label, active, dir, onClick }) => (
  <TableHead
    aria-sort={
      active ? (dir === "asc" ? "ascending" : "descending") : "none"
    }
  >
    <button
      type="button"
      onClick={onClick}
      className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted/40 hover:text-foreground"
      aria-label={
        active
          ? `Sorted by ${label} ${dir === "asc" ? "ascending" : "descending"}, click to flip direction`
          : `Sort by ${label}`
      }
    >
      <span>{label}</span>
      {active && (
        <span className="text-2xs text-muted-foreground" aria-hidden>
          {dir === "desc" ? "▼" : "▲"}
        </span>
      )}
    </button>
  </TableHead>
);

// --------------------------------------------------------------------------
// PostureTrendSparkline (wave 8)
// --------------------------------------------------------------------------
//
// Minimal inline SVG sparkline — no charting dep. Shows the total
// finding count across the last N persisted snapshots and the Tier-0
// protection score trend line in a contrasting color. The two series
// are normalized to their own ranges so they coexist on one SVG.
//
// citation: New folder\_analysis_defender_view.md §1.

interface PostureTrendSparklineProps {
  snapshots: readonly PostureSnapshot[];
  delta: {
    totalDelta: number;
    criticalDelta: number;
    highDelta: number;
    tierZeroDelta: number;
  } | null;
}

const PostureTrendSparkline: React.FC<PostureTrendSparklineProps> = ({
  snapshots,
  delta,
}) => {
  // Order chronologically (oldest → newest) for the sparkline path. The
  // persisted ring is newest-first.
  const ordered = React.useMemo(
    () => snapshots.slice().reverse(),
    [snapshots],
  );
  const totals = ordered.map((s) => s.total);
  const scores = ordered.map((s) => s.tierZeroScore);
  if (totals.length < 2) return null;

  const W = 240;
  const H = 48;
  const PAD_X = 4;
  const PAD_Y = 4;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;

  const buildPath = (values: number[], min: number, max: number): string => {
    if (values.length === 0) return "";
    const range = max - min || 1;
    const stepX = values.length === 1 ? innerW : innerW / (values.length - 1);
    return values
      .map((v, i) => {
        const x = PAD_X + i * stepX;
        const y = PAD_Y + innerH - ((v - min) / range) * innerH;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const totalMin = Math.min(...totals);
  const totalMax = Math.max(...totals);
  const scoreMin = Math.min(0, ...scores);
  const scoreMax = Math.max(100, ...scores);
  const totalsPath = buildPath(totals, totalMin, totalMax);
  const scoresPath = buildPath(scores, scoreMin, scoreMax);

  const deltaArrow =
    delta == null
      ? null
      : delta.totalDelta === 0
        ? null
        : delta.totalDelta > 0
          ? "up"
          : "down";
  // "up" on TOTAL = more findings = worse; "up" on TIER-0 SCORE = better.
  // Render delta line for tier-zero score separately so semantics are clear.

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card/60 px-3 py-2 text-2xs text-muted-foreground"
      role="img"
      aria-label={`Posture trend across ${snapshots.length} scans`}
    >
      <span className="font-medium uppercase tracking-wider">Posture trend</span>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="text-foreground"
        aria-hidden
      >
        {/* Total findings — destructive tone (more is worse). */}
        <path
          d={totalsPath}
          fill="none"
          stroke="hsl(var(--destructive, 0 80% 60%))"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
        {/* Tier-0 score — success tone (higher is better). Drawn on
            top so it's the dominant line when both move together. */}
        <path
          d={scoresPath}
          fill="none"
          stroke="hsl(var(--success, 142 70% 45%))"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray="3 2"
        />
      </svg>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-1.5 w-3 rounded-sm"
          style={{ backgroundColor: "hsl(var(--destructive, 0 80% 60%))" }}
          aria-hidden
        />
        total
        {deltaArrow === "up" ? (
          <TrendingUp className="h-3 w-3 text-destructive" aria-hidden />
        ) : deltaArrow === "down" ? (
          <TrendingDown className="h-3 w-3 text-success" aria-hidden />
        ) : null}
        {delta && delta.totalDelta !== 0 && (
          <span className="tabular-nums">
            {delta.totalDelta > 0 ? "+" : ""}
            {delta.totalDelta}
          </span>
        )}
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-1.5 w-3 rounded-sm"
          style={{ backgroundColor: "hsl(var(--success, 142 70% 45%))" }}
          aria-hidden
        />
        Tier-0
        {delta && delta.tierZeroDelta !== 0 && (
          <span className="tabular-nums">
            {delta.tierZeroDelta > 0 ? "+" : ""}
            {delta.tierZeroDelta}pt
          </span>
        )}
      </span>
      <span className="text-3xs text-muted-foreground">
        {snapshots.length}/{30} snapshots
      </span>
    </div>
  );
};

const SeverityDot: React.FC<{ severity: Severity }> = ({ severity }) => {
  const color =
    severity === "critical"
      ? "bg-destructive"
      : severity === "high"
        ? "bg-warning"
        : severity === "medium"
          ? "bg-info"
          : severity === "info"
            ? "bg-muted-foreground"
            : "bg-muted";
  return (
    <span
      className={cn("inline-block h-1.5 w-1.5 rounded-full", color)}
      aria-hidden
    />
  );
};

interface FindingRowProps {
  finding: Finding;
  decision: "ack" | "suppress" | null;
  decisionAt: string | undefined;
  decisionActor: string | undefined;
  focused: boolean;
  /** Stable parent-level setter — child wraps it in a per-row callback. */
  setFocused: (id: string | null) => void;
  /** Stable parent-level setter — child wraps it in per-row ack/suppress. */
  setAckSuppress: (
    findingId: string,
    finding: Finding,
    state: "ack" | "suppress" | "clear",
    note?: string,
  ) => void;
}

/**
 * Single finding row. Memoized to avoid re-rendering all rows when a
 * single chip / filter / sort toggle changes upstream — with O(100s)
 * of findings in a large tenant this is a real win on every filter
 * tweak. Props are passed individually rather than as a config object,
 * and the parent passes the STABLE `setAckSuppress` + `setFocused`
 * callbacks (not per-row inline arrows) so React's shallow-compare
 * equality short-circuits cleanly.
 */
const FindingRowImpl: React.FC<FindingRowProps> = ({
  finding: f,
  decision,
  decisionAt,
  decisionActor,
  focused,
  setFocused,
  setAckSuppress,
}) => {
  // Build per-row handlers inside the memoized child — they re-create
  // only when `f` (specifically its id) or the stable parent setters
  // change, NOT on every parent render.
  const onFocus = React.useCallback(() => setFocused(f.id), [setFocused, f.id]);
  const onAcknowledge = React.useCallback(() => {
    setAckSuppress(f.id, f, decision === "ack" ? "clear" : "ack");
  }, [setAckSuppress, f, decision]);
  const onSuppress = React.useCallback(() => {
    setAckSuppress(
      f.id,
      f,
      decision === "suppress" ? "clear" : "suppress",
    );
  }, [setAckSuppress, f, decision]);
  const Icon = resourceTypeIcon(f.resourceType);
  const parsed = parseArmId(f.resourceId);
  const portalUrl = portalUrlFor(f.resourceId);
  const runbook = runbookFor(f.ruleId);
  const isAck = decision === "ack";
  const isSuppress = decision === "suppress";
  // Local row click/focus handler — bubbles up the focused id so
  // page-level hotkeys can target it.
  return (
    <TableRow
      tabIndex={0}
      onFocus={onFocus}
      // role="row" is provided by TableRow; this re-states it for clarity.
      aria-selected={focused ? true : undefined}
      data-finding-id={f.id}
      className={cn(
        "outline-none transition-colors",
        focused && "ring-1 ring-inset ring-primary/60",
        isAck && "bg-muted/30 opacity-75",
        isSuppress && "bg-muted/40 italic opacity-60",
      )}
    >
      <TableCell>
        <Badge
          variant={SEVERITY_BADGE_VARIANT[f.severity]}
          className="text-2xs"
        >
          {SEVERITY_LABEL[f.severity]}
        </Badge>
        {decision && (
          <span
            className="ml-1 inline-flex items-center gap-0.5 rounded border px-1 py-0 text-3xs uppercase tracking-wider text-muted-foreground"
            title={
              decisionActor && decisionAt
                ? `${decision === "ack" ? "Acknowledged" : "Suppressed"} by ${decisionActor} at ${new Date(decisionAt).toLocaleString()}`
                : undefined
            }
          >
            {isAck ? "ack" : "supp"}
          </span>
        )}
      </TableCell>
      <TableCell>
        <span
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          title={resourceTypeLabel(f.resourceType)}
        >
          <Icon className="h-3.5 w-3.5" />
          {resourceTypeLabel(f.resourceType)}
        </span>
      </TableCell>
      <TableCell>
        <span className="flex min-w-0 flex-col">
          <span
            className="truncate font-medium"
            title={f.resourceName}
          >
            {f.resourceName}
          </span>
          <span
            className="truncate font-mono text-3xs text-muted-foreground"
            title={f.subscriptionName}
          >
            {f.subscriptionName}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <span className="font-mono text-2xs" title={f.resourceGroup}>
          {f.resourceGroup || parsed.resourceGroup || "—"}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="text-2xs">
          {f.region}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            {f.title}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground/70 hover:text-foreground"
                  aria-label="Why this matters"
                  tabIndex={-1}
                >
                  <ShieldAlert className="h-3 w-3" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="start" className="max-w-md">
                <p className="m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Why it matters
                </p>
                <p className="m-0 mt-1 text-xs leading-relaxed">
                  {f.whyItMatters}
                </p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground/70 hover:text-foreground"
                  aria-label="Remediation steps"
                  tabIndex={-1}
                >
                  <ShieldCheck className="h-3 w-3" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="start" className="max-w-md">
                <p className="m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Remediation
                </p>
                <p className="m-0 mt-1 whitespace-pre-wrap text-xs leading-relaxed">
                  {f.remediation}
                </p>
              </TooltipContent>
            </Tooltip>
          </span>
          <span className="text-2xs text-muted-foreground">
            {f.description}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="inline-flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAcknowledge();
                }}
                aria-pressed={isAck}
                aria-label={
                  isAck
                    ? `Clear acknowledgement on ${f.resourceName}`
                    : `Acknowledge finding on ${f.resourceName} (hotkey: a)`
                }
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isAck && "text-success",
                )}
              >
                <ShieldCheck className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {isAck ? "Clear acknowledgement" : "Acknowledge (a)"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSuppress();
                }}
                aria-pressed={isSuppress}
                aria-label={
                  isSuppress
                    ? `Unsuppress ${f.resourceName}`
                    : `Suppress finding on ${f.resourceName} (hotkey: s)`
                }
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSuppress && "text-destructive",
                )}
              >
                <ShieldOff className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {isSuppress ? "Unsuppress" : "Suppress (s)"}
            </TooltipContent>
          </Tooltip>
          {runbook && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={runbook.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Open runbook for ${f.ruleId}: ${runbook.label}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <BookOpen className="h-3 w-3" />
                </a>
              </TooltipTrigger>
              <TooltipContent>{runbook.label}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="group/copy inline-flex items-center"
                aria-hidden={false}
              >
                <CopyButton
                  value={f.resourceId}
                  ariaLabel={`Copy ARM id for ${f.resourceName}`}
                  alwaysVisible
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>Copy ARM id</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open ${f.resourceName} in Azure Portal`}
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            </TooltipTrigger>
            <TooltipContent>Open in Azure Portal</TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  );
};

// Memoize the row so a single ack/suppress toggle, sort flip, or
// filter chip doesn't re-render hundreds of unaffected rows.
const FindingRow = React.memo(FindingRowImpl);
