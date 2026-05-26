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

import type {
  Finding,
  ResourceType,
  Severity,
} from "./security-audit-helpers";
import { parseArmId } from "./security-audit-helpers";

// --------------------------------------------------------------------------
// Extended resource-type vocabulary
// --------------------------------------------------------------------------

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
export type CorpusResourceType =
  | "diagnostic-setting"
  | "subscription"
  | "storage-container"
  | "resource-group";

export type ExtendedResourceType = ResourceType | CorpusResourceType;

// --------------------------------------------------------------------------
// Signal A — Diagnostic-setting deletion sentinel
// --------------------------------------------------------------------------
//
// What we detect: a Tier-0 / scoped resource has NO diagnostic settings
// configured (or has one with `enabled: false` on AuditEvent /
// ServiceLog), so an attacker who deletes the setting (or who arrived
// before any was configured) leaves no SIEM trail of resource-plane
// activity.
//
// citation: New folder\_AZURE_BYPASS_PLAYBOOK.md:150
//   "8. `Delete diagnostic setting` Activity Log event"
// citation: New folder\_bypass_modify_delete.md:597-602 (§5.14)
//   DELETE .../providers/Microsoft.Insights/diagnosticSettings/<name>
//   "Removes log forwarding to Log Analytics / Event Hubs / Storage.
//    Attacker activity in that resource no longer reaches SIEM."

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

const TIER_ZERO_BUMP: Record<"low" | "high", Severity> = {
  low: "medium",
  high: "high",
};

function diagnosticIsAuditing(s: DiagnosticSettingResource): boolean {
  const logs = s.properties?.logs ?? [];
  // Consider audit coverage adequate if at least one log entry is
  // enabled with categoryGroup="audit"/"allLogs" OR a category that
  // explicitly mentions audit/service.
  for (const entry of logs) {
    if (entry.enabled !== true) continue;
    const cg = (entry.categoryGroup ?? "").toLowerCase();
    if (cg === "audit" || cg === "alllogs") return true;
    const c = (entry.category ?? "").toLowerCase();
    if (c.includes("audit") || c.includes("service") || c === "auditevent") {
      return true;
    }
  }
  return false;
}

function diagnosticHasSink(s: DiagnosticSettingResource): boolean {
  const p = s.properties ?? {};
  return Boolean(
    (p.workspaceId && p.workspaceId.length > 0) ||
      (p.eventHubAuthorizationRuleId && p.eventHubAuthorizationRuleId.length > 0) ||
      (p.storageAccountId && p.storageAccountId.length > 0),
  );
}

/**
 * Evaluate one resource's diagnostic-settings list. Emits at most
 * one finding (the most severe of the issues found) to avoid
 * stacking duplicate "no audit shipping" rows per resource.
 */
export function evaluateDiagnosticSettings(
  target: DiagnosticEvaluable,
  ctx: DiagnosticContext,
): Finding[] {
  const out: Finding[] = [];
  if (target.settings.length === 0) {
    // No diagnostic setting at all — the loudest defender gap. This
    // is exactly the state an attacker LEAVES behind after running
    // the §5.14 DELETE.
    const severity: Severity = target.tierZero
      ? TIER_ZERO_BUMP.high
      : TIER_ZERO_BUMP.low;
    out.push({
      id: `${target.resourceId}::diag.absent`,
      resourceType: "diagnostic-setting" as ResourceType, // page widens
      resourceId: target.resourceId,
      resourceName: target.resourceName,
      resourceGroup: target.resourceGroup,
      region: target.region,
      subscriptionId: ctx.subscriptionId,
      subscriptionName: ctx.subscriptionName,
      ruleId: "diag.absent",
      title: "No diagnostic setting — audit trail not shipping",
      description:
        "This resource has zero diagnostic settings configured. Resource-plane activity is not forwarded to Log Analytics, Event Hubs, or Storage.",
      whyItMatters:
        "A common attacker tactic (corpus: _bypass_modify_delete.md §5.14) is to DELETE diagnostic settings on the resources they operate in — Activity Log alone has a short default retention and no resource-plane operations beyond ARM control-plane writes. A resource that NEVER had a setting is indistinguishable from one where the setting was deleted: in both cases the defender is blind to data-plane activity. Microsoft's defender audit playbook (corpus: _AZURE_BYPASS_PLAYBOOK.md §Critical Defender Audit Surface item 8) lists Delete-diagnostic-setting as a Tier-0 alert event.",
      remediation:
        "Configure a diagnostic setting forwarding AuditEvent (and/or ServiceLog) to a Log Analytics workspace your SIEM ingests: az monitor diagnostic-settings create --name baseline --resource " +
        target.resourceId +
        " --workspace <law-id> --logs '[{\"categoryGroup\":\"audit\",\"enabled\":true}]'. Then add an alert rule on the Activity Log signal 'Delete diagnostic setting' for the same scope.",
      severity,
    });
    return out;
  }
  // We have at least one setting — is any of them actually shipping
  // audit logs to a real sink?
  const anyAuditing = target.settings.some(diagnosticIsAuditing);
  const anyWithSink = target.settings.some(diagnosticHasSink);

  if (!anyAuditing || !anyWithSink) {
    const severity: Severity = target.tierZero ? "high" : "medium";
    out.push({
      id: `${target.resourceId}::diag.audit-disabled`,
      resourceType: "diagnostic-setting" as ResourceType,
      resourceId: target.resourceId,
      resourceName: target.resourceName,
      resourceGroup: target.resourceGroup,
      region: target.region,
      subscriptionId: ctx.subscriptionId,
      subscriptionName: ctx.subscriptionName,
      ruleId: "diag.audit-disabled",
      title: "Diagnostic setting exists but audit is not enabled",
      description: anyWithSink
        ? "A diagnostic setting is present but no AuditEvent / Audit logs are enabled."
        : "A diagnostic setting exists but has no Log Analytics / Event Hub / Storage destination — telemetry has nowhere to go.",
      whyItMatters:
        "A diagnostic setting in the resource's list is reassuring at a glance but tells you nothing about coverage. Attackers who can't outright DELETE the setting (audited event) sometimes PATCH it to disable AuditEvent or unset the workspaceId — same blind-spot, quieter signal. Defensive baseline: every Tier-0 resource ships AuditEvent to a SIEM-ingested workspace.",
      remediation:
        "Update the diagnostic setting to enable categoryGroup=audit and bind a workspaceId / eventHubAuthorizationRuleId. az monitor diagnostic-settings update -n <name> --resource " +
        target.resourceId +
        " --logs '[{\"categoryGroup\":\"audit\",\"enabled\":true}]'.",
      severity,
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// Signal B — Subscription-cancellation sentinel
// --------------------------------------------------------------------------
//
// What we detect: subscriptions whose state machine indicates an
// in-progress cancellation, a billing escalation, or a recent delete.
// `Warned` is the state Azure puts a subscription in shortly before
// cancellation completes — for Tier-0 subs this is the loudest defender
// signal short of a full outage.
//
// citation: New folder\_AZURE_BYPASS_PLAYBOOK.md:152
//   "10. `Cancel subscription` Activity Log event"
// citation: New folder\_bypass_modify_delete.md:570-576 (§5.11)
//   "DELETE https://management.azure.com/subscriptions/<sub-id>?api-version=2020-01-01
//    Cancels the subscription. All resources are marked for deletion
//    (30-day soft-delete for some resource types). Game-over."

export interface SubscriptionListEntry {
  id?: string;
  subscriptionId: string;
  displayName: string;
  state?:
    | "Enabled"
    | "Warned"
    | "PastDue"
    | "Disabled"
    | "Deleted"
    | "Expired"
    | string;
  tenantId?: string;
  managedByTenants?: Array<{ tenantId?: string }>;
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
export function evaluateSubscriptionStates(
  subs: readonly SubscriptionListEntry[],
): Finding[] {
  const out: Finding[] = [];
  for (const sub of subs) {
    const state = (sub.state ?? "").trim();
    const stateLower = state.toLowerCase();
    if (stateLower === "" || stateLower === "enabled") continue;
    const tierZero = sub.isTierZero === true;

    let severity: Severity;
    let title: string;
    let description: string;
    let ruleId: string;
    let whyItMatters: string;
    let remediation: string;

    if (stateLower === "warned") {
      severity = tierZero ? "critical" : "high";
      ruleId = "sub.state.warned";
      title = "Subscription in Warned state — pre-cancellation";
      description = `Subscription state is "${state}" — Azure has flagged it for upcoming cancellation. Resources are still active but the state machine is moving toward Deleted.`;
      whyItMatters =
        "The Warned → Deleted transition is automatic if the underlying issue (expired payment, account close-out, or an explicit Cancel call) is not resolved. Once Deleted, all resources are queued for deletion with a 30-day soft-delete on SOME types; recovery requires Microsoft Support. Defender baseline (corpus: _AZURE_BYPASS_PLAYBOOK.md item 10 + _bypass_modify_delete.md §5.11) puts Cancel-subscription at the top of the Activity-Log alert list — Warned is your last quiet warning.";
      remediation =
        "Resolve the billing flag in the Azure portal (Cost Management + Billing → Subscriptions → " +
        sub.displayName +
        "). If the Warned state is unexpected, audit ARM Activity Log for the originating user/principal and ensure a resource-group lock is on the critical RGs in the meantime.";
    } else if (stateLower === "pastdue") {
      severity = tierZero ? "high" : "medium";
      ruleId = "sub.state.past-due";
      title = "Subscription has PastDue billing";
      description = `Subscription state is "${state}" — billing is delinquent. Azure will move it to Warned, then Deleted, if unresolved.`;
      whyItMatters =
        "PastDue is the precursor to Warned. The defender signal: if PastDue lingers, an attacker with billing-owner role (a relatively common privilege escalation chain, see _bypass_role_grant.md §billing) can accelerate the cancellation by 'declining' a payment, hastening the catastrophic state from §5.11.";
      remediation =
        "Reconcile the payment method in Cost Management + Billing. Review the EA enrollment / MCA account owner — restrict billing-role assignments to break-glass identities only.";
    } else if (stateLower === "deleted") {
      severity = "critical";
      ruleId = "sub.state.deleted";
      title = "Subscription in Deleted state";
      description = `Subscription state is "${state}" — cancellation has completed. Resources are in soft-delete recovery window if applicable.`;
      whyItMatters =
        "Deleted is the catastrophic terminal state from corpus _bypass_modify_delete.md §5.11. Some resource types (Key Vault, Storage soft-deleted blobs) retain a 30-day recovery window — others are gone immediately. This finding is here so an inadvertent or malicious Cancel doesn't go un-noticed until the recovery window closes.";
      remediation =
        "Contact Microsoft Support IMMEDIATELY to request reactivation. Run `az account list --include-deleted` (or the Subscriptions API with includeDeleted=true) to confirm the deletion timestamp. Document the cancellation actor from ARM Activity Log for incident response.";
    } else if (stateLower === "disabled" || stateLower === "expired") {
      severity = tierZero ? "high" : "medium";
      ruleId = "sub.state.disabled";
      title = `Subscription is ${state}`;
      description = `Subscription state is "${state}" — resources are read-only or unreachable. Often the precursor to Deleted.`;
      whyItMatters =
        "A Disabled / Expired subscription cannot accept new resources or run scheduled tasks (Batch jobs queue indefinitely). It also typically signals an unresolved billing or compliance trigger — left untouched, it auto-transitions through the cancellation pipeline.";
      remediation =
        "Identify the disable reason (billing, policy, or admin action). Re-enable from the Azure portal if intentional; otherwise treat as a billing incident and escalate.";
    } else {
      // Unknown but non-Enabled state — surface as info so the
      // operator at least sees it.
      severity = "info";
      ruleId = "sub.state.unknown";
      title = `Subscription in non-Enabled state (${state})`;
      description = `Subscription state is "${state}" — not Enabled. Investigate.`;
      whyItMatters =
        "ARM exposes the state field as a free-form string; new values appear when Azure adds new lifecycle stages. Any non-Enabled value is worth a defender eyeball.";
      remediation =
        "Check Azure Service Health + Cost Management for the subscription's current status.";
    }
    out.push({
      id: `${sub.subscriptionId}::${ruleId}`,
      resourceType: "subscription" as ResourceType,
      resourceId:
        sub.id ?? `/subscriptions/${sub.subscriptionId}`,
      resourceName: sub.displayName,
      resourceGroup: "",
      region: "",
      subscriptionId: sub.subscriptionId,
      subscriptionName: sub.displayName,
      ruleId,
      title,
      description,
      whyItMatters,
      remediation,
      severity,
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// Signal C — Public-access storage container surface
// --------------------------------------------------------------------------
//
// Defender analog of MicroBurst's Invoke-EnumerateAzureBlobs. The
// offensive tool brute-forces account-name + container-name pairs and
// drops the hits where publicAccess != None. The defender version
// lists the OPERATOR's own storage accounts' containers and flags
// any container with publicAccess != None, with extra severity if
// the container name suggests sensitive content.
//
// citation: New folder\NetSPI\MicroBurst\Misc\Invoke-EnumerateAzureBlobs.ps1
// citation: New folder\_analysis_netspi.md (MicroBurst storage section)

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

/**
 * Container names that suggest sensitive content. We bump severity
 * to critical when one of these is publicly readable. Patterns are
 * lower-cased substring matches (so e.g. "prod-backup" matches
 * "backup"). Derived from the wordlists MicroBurst ships in
 * Invoke-EnumerateAzureBlobs.ps1's "permutations.txt" — the
 * attacker's hot-list is the defender's hot-list.
 */
const SENSITIVE_CONTAINER_PATTERNS: readonly string[] = [
  "backup",
  "keys",
  "secret",
  "secrets",
  "dump",
  "arm",
  "tf",
  "terraform",
  "bicep",
  "creds",
  "credentials",
  "private",
  "sql",
  "db",
  "config",
];

function classifyContainer(name: string): {
  sensitive: boolean;
  matched: string | null;
} {
  const n = name.toLowerCase();
  for (const pat of SENSITIVE_CONTAINER_PATTERNS) {
    if (n.includes(pat)) {
      return { sensitive: true, matched: pat };
    }
  }
  return { sensitive: false, matched: null };
}

interface ContainerContext {
  subscriptionId: string;
  subscriptionName: string;
}

export function evaluatePublicContainers(
  containers: readonly ContainerListEntry[],
  ctx: ContainerContext,
): Finding[] {
  const out: Finding[] = [];
  for (const c of containers) {
    const pa = (c.publicAccess ?? "").toLowerCase();
    if (pa === "" || pa === "none") continue;
    const { sensitive, matched } = classifyContainer(c.name);
    const severity: Severity = sensitive ? "critical" : "high";
    out.push({
      id: `${c.storageAccountId}/blobServices/default/containers/${c.name}::container.public`,
      resourceType: "storage-container" as ResourceType,
      resourceId: `${c.storageAccountId}/blobServices/default/containers/${c.name}`,
      resourceName: `${c.storageAccountName}/${c.name}`,
      resourceGroup: c.resourceGroup,
      region: c.region,
      subscriptionId: ctx.subscriptionId,
      subscriptionName: ctx.subscriptionName,
      ruleId: sensitive ? "container.public.sensitive" : "container.public",
      title: sensitive
        ? `Public container with sensitive name pattern (matches "${matched}")`
        : "Container with public anonymous access",
      description: `publicAccess="${c.publicAccess}" on container "${c.name}". Anyone on the internet can list/download blobs in this container.`,
      whyItMatters: sensitive
        ? `The container name matches a high-risk pattern attackers' wordlists target (corpus: NetSPI\\MicroBurst\\Misc\\Invoke-EnumerateAzureBlobs.ps1). A public container literally named "${c.name}" is one of the highest-signal hits the offensive tool reports — assume it is being enumerated continuously by automated scrapers.`
        : "MicroBurst's Invoke-EnumerateAzureBlobs walks exactly this surface: account-name brute force + container-name permutations + check publicAccess. Every publicly-readable container is a candidate for unauthenticated data exfil. Even non-sensitive container names are noise-makers in defender telemetry — a privacy disclosure can come from any blob the operator forgot was set to public.",
      remediation:
        'Set the container public-access level to None: az storage container set-permission --name "' +
        c.name +
        '" --account-name "' +
        c.storageAccountName +
        '" --public-access off . Combine with the account-level "allowBlobPublicAccess=false" rule (storage.allow-public-access) so future containers default to private.',
      severity,
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// Signal D — Idle resource-group / orphan-resource posture
// --------------------------------------------------------------------------
//
// What we detect: resource groups that haven't been modified in >N
// days AND contain at least one billable resource. These RGs are
// attractive to attackers because they tend to be unowned (the
// operator who created them left the team), un-monitored (no
// dashboards / alerts targeted at them), and un-tagged.
//
// citation: New folder\_analysis_defender_view.md §1 (Azucar /
//   ScoutSuite findings model)
// Both Azucar (nccgroup/azucar) and ScoutSuite
// (nccgroup/ScoutSuite) emit posture findings for idle / orphan
// infrastructure; Prowler (prowler-cloud/prowler) extends the same
// model to multi-cloud.

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

const IDLE_THRESHOLD_DAYS_DEFAULT = 90;

interface IdleContext {
  subscriptionId: string;
  subscriptionName: string;
  /** Override the 90-day default; minimum 7, maximum 365. */
  idleThresholdDays?: number;
  /** Anchor for "now" — defaults to Date.now() at evaluation. */
  nowMs?: number;
}

export function evaluateIdleResourceGroups(
  rgs: readonly ResourceGroupSummary[],
  ctx: IdleContext,
): Finding[] {
  const out: Finding[] = [];
  const thresholdDays = Math.min(
    365,
    Math.max(7, ctx.idleThresholdDays ?? IDLE_THRESHOLD_DAYS_DEFAULT),
  );
  const now = ctx.nowMs ?? Date.now();
  const cutoff = now - thresholdDays * 24 * 60 * 60 * 1000;

  for (const rg of rgs) {
    const parsed = parseArmId(rg.id);
    // Empty RG — separate finding (Azucar flags these specifically:
    // an empty RG with no resources is a Bicep / Terraform leftover
    // that the operator may have meant to delete; it doesn't cost
    // money but it pollutes the resource graph and gives an attacker
    // a place to drop resources unmonitored).
    if (rg.resourceCount === 0) {
      out.push({
        id: `${rg.id}::rg.empty`,
        resourceType: "resource-group" as ResourceType,
        resourceId: rg.id,
        resourceName: rg.name,
        resourceGroup: rg.name,
        region: rg.location,
        subscriptionId: ctx.subscriptionId,
        subscriptionName: ctx.subscriptionName,
        ruleId: "rg.empty",
        title: "Empty resource group",
        description: `Resource group "${rg.name}" contains zero resources.`,
        whyItMatters:
          "Empty RGs are an Azucar/ScoutSuite-classic posture finding. They're free to keep but they (a) pollute the resource graph, (b) inherit blanket Contributor role assignments that nobody re-reviews, and (c) give an attacker a write-able container they can drop resources into without tripping a 'new RG created' alert. Removing them tightens the attack surface.",
        remediation:
          "Confirm the RG is intentional (sometimes empty RGs are placeholders for upcoming deploys). If not: az group delete -n " +
          rg.name +
          " (review role assignments first — an empty RG is often the operator-error result of a half-finished cleanup).",
        severity: "info",
      });
      continue;
    }

    // Idle RG — has resources but nothing has changed in N days.
    if (rg.lastChangedIso != null) {
      const last = Date.parse(rg.lastChangedIso);
      if (Number.isFinite(last) && last < cutoff) {
        const idleDays = Math.floor(
          (now - last) / (24 * 60 * 60 * 1000),
        );
        const severity: Severity = rg.hasTempTag ? "high" : "medium";
        out.push({
          id: `${rg.id}::rg.idle`,
          resourceType: "resource-group" as ResourceType,
          resourceId: rg.id,
          resourceName: rg.name,
          resourceGroup: rg.name,
          region: rg.location,
          subscriptionId: ctx.subscriptionId,
          subscriptionName: ctx.subscriptionName,
          ruleId: "rg.idle",
          title: rg.hasTempTag
            ? `Idle RG tagged temp/dev (no changes in ${idleDays} days)`
            : `Idle resource group (no changes in ${idleDays} days)`,
          description: `Resource group "${rg.name}" holds ${rg.resourceCount} resource${rg.resourceCount === 1 ? "" : "s"} and last changed ${idleDays} days ago${rg.hasTempTag ? ", with at least one resource tagged temp/dev" : ""}.`,
          whyItMatters:
            "Abandoned infrastructure is a recurring posture failure across the defender-tooling family — Azucar (`nccgroup/azucar`), ScoutSuite (`nccgroup/ScoutSuite`), and Prowler (`prowler-cloud/prowler`) all flag idle RGs. Attackers prefer them as staging shelters: low operator attention, dashboards stale, the original creator probably no longer reviews the RG's RBAC. " +
            (rg.hasTempTag
              ? "The temp/dev tag on a 90-day-stale RG is a smell — temp shouldn't outlive a sprint."
              : ""),
          remediation:
            "Audit the RG's RBAC + resources. If still needed, refresh the ownership tag and document the workload. If unused: archive / delete — start with `az resource list -g " +
            rg.name +
            " -o table` to confirm contents, then `az group delete -n " +
            rg.name +
            "`.",
          severity,
        });
      }
    }
    // We intentionally do NOT emit a finding when `lastChangedIso` is
    // null — that's a data-availability issue (the RG enumerator
    // couldn't determine a timestamp), not a posture failure. The
    // page can show a footnote about coverage if it wants.
    void parsed; // parsed is captured for future-id needs; suppress unused
  }
  return out;
}

// --------------------------------------------------------------------------
// Utility — risk-score bump for corpus signals
// --------------------------------------------------------------------------
//
// The original helpers sort findings by severity weight. The corpus
// signals share that weight matrix, but we expose a stable risk-score
// helper so the page can produce a flat "risk score" column (for the
// export menu) that promotes A/B findings above same-severity D
// findings — A and B both indicate an active or imminent destructive
// op, D indicates dormant infrastructure.
//
// Higher = worse. Mirrors `SEVERITY_WEIGHT` but adds a small bonus
// for ruleIds that name explicit destructive surfaces.

const DESTRUCTIVE_RULE_PREFIX = ["sub.state.", "diag."];

export function riskScoreFor(f: Finding): number {
  // Severity weight 0..4 (none..critical) is the baseline; bonus 0.5
  // for sentinel-class findings (Signal A + Signal B) pushes them
  // above same-severity vendor findings without breaking the integer
  // sort. The original page sort still passes Finding through
  // compareFindings — this scorer is purely for the export menu /
  // risk-sorted view.
  const sevWeight =
    f.severity === "critical"
      ? 4
      : f.severity === "high"
        ? 3
        : f.severity === "medium"
          ? 2
          : f.severity === "info"
            ? 1
            : 0;
  let bonus = 0;
  for (const p of DESTRUCTIVE_RULE_PREFIX) {
    if (f.ruleId.startsWith(p)) {
      bonus = 0.5;
      break;
    }
  }
  // Public-container findings carry the same bonus — they map directly
  // to MicroBurst's primary blob-enum surface.
  if (f.ruleId.startsWith("container.public")) bonus = 0.5;
  return sevWeight + bonus;
}

// --------------------------------------------------------------------------
// Stable rule-id catalog (for UI / export grouping)
// --------------------------------------------------------------------------

export const CORPUS_RULE_IDS = [
  // Signal A
  "diag.absent",
  "diag.audit-disabled",
  // Signal B
  "sub.state.warned",
  "sub.state.past-due",
  "sub.state.deleted",
  "sub.state.disabled",
  "sub.state.unknown",
  // Signal C
  "container.public",
  "container.public.sensitive",
  // Signal D
  "rg.empty",
  "rg.idle",
] as const;

export type CorpusRuleId = (typeof CORPUS_RULE_IDS)[number];

/** True if a Finding came from one of the corpus signals. */
export function isCorpusFinding(f: Finding): boolean {
  return (CORPUS_RULE_IDS as readonly string[]).includes(f.ruleId);
}

// --------------------------------------------------------------------------
// Tier-0 protection score (wave 8 — composite defender signal)
// --------------------------------------------------------------------------
//
// What we compute: across all KEY VAULTS scanned (we treat KV as the
// canonical Tier-0 resource — they hold bearer credentials), what
// fraction has BOTH (a) a diagnostic setting present + auditing AND
// (b) no high/critical KV-config finding (no-purge-protection,
// no-soft-delete, publicly-reachable). The output is a 0..100 score —
// the operator sees the integer % in the summary strip, with hover
// detail showing the numerator/denominator and the worst contributing
// rules.
//
// Why a single score: defenders need one quick "are we worse off than
// last week" number for executive reporting. Detailed findings live in
// the table; the score is the elevator-pitch summary.
//
// citation: New folder\_analysis_defender_view.md §1
//   The Azucar/ScoutSuite/Prowler family all surface an aggregate
//   posture score because that's what makes a posture tool legible to
//   a non-operator stakeholder. This is our local equivalent, scoped
//   to the Tier-0 surface the corpus playbook §"Critical Defender
//   Audit Surface" calls out as the audit priority.
// citation: New folder\_AZURE_BYPASS_PLAYBOOK.md §"Critical Defender
//   Audit Surface" items 8 + 10 (diagnostic-setting + subscription
//   cancellation — the two signals weighted into this score).

export interface TierZeroProtectionScore {
  /** Integer 0..100. 100 means every Tier-0 resource is fully protected. */
  score: number;
  /** Resources that pass the full Tier-0 check. */
  protectedCount: number;
  /** Total Tier-0 resources evaluated (denominator). */
  totalCount: number;
  /** Top 3 rule-ids dragging the score down (descending offender count). */
  topOffenders: ReadonlyArray<{ ruleId: string; count: number }>;
}

/**
 * High/critical KV rule-ids that disqualify a vault from "protected"
 * status. Kept narrow — we don't want an info-level large-policy
 * finding to drop the score.
 */
const KV_DISQUALIFYING_RULES: ReadonlySet<string> = new Set([
  "keyvault.no-purge-protection",
  "keyvault.no-soft-delete",
  "keyvault.publicly-reachable",
  // Diagnostic absence on a tier-0 resource is the §5.14 sentinel.
  "diag.absent",
  "diag.audit-disabled",
]);

export interface TierZeroScoreInput {
  /** All findings from the scan (any severity / resource type). */
  findings: readonly Finding[];
  /** Total Key Vaults scanned (denominator for Tier-0 count). */
  vaultsScanned: number;
}

export function computeTierZeroProtectionScore(
  input: TierZeroScoreInput,
): TierZeroProtectionScore {
  const { findings, vaultsScanned } = input;
  if (vaultsScanned <= 0) {
    return { score: 0, protectedCount: 0, totalCount: 0, topOffenders: [] };
  }
  // Group disqualifying findings by their parent KV ARM id. A KV with
  // multiple disqualifying rules still counts as ONE unprotected
  // resource (we don't double-penalize the same vault).
  const unprotectedVaults = new Set<string>();
  const offenderCounts = new Map<string, number>();
  for (const f of findings) {
    if (f.resourceType !== "keyvault" && f.resourceType !== "diagnostic-setting") {
      continue;
    }
    if (!KV_DISQUALIFYING_RULES.has(f.ruleId)) continue;
    // For diag findings the resourceId is the KV's own ARM id only when
    // the target was a vault. Filter to the KV-targeted diag rows by
    // checking the ARM id segments.
    if (f.resourceType === "diagnostic-setting") {
      const lower = f.resourceId.toLowerCase();
      if (!lower.includes("/microsoft.keyvault/vaults/")) continue;
    }
    // Use the KV-portion of the ARM id (strip any trailing diag-name
    // segment) so a KV with a diag finding + a config finding still
    // counts as one unprotected vault.
    const kvIdMatch = f.resourceId.match(
      /^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.KeyVault\/vaults\/[^/]+)/i,
    );
    const kvKey = (kvIdMatch?.[1] ?? f.resourceId).toLowerCase();
    unprotectedVaults.add(kvKey);
    offenderCounts.set(
      f.ruleId,
      (offenderCounts.get(f.ruleId) ?? 0) + 1,
    );
  }
  const protectedCount = Math.max(
    0,
    vaultsScanned - unprotectedVaults.size,
  );
  const score = Math.round((protectedCount / vaultsScanned) * 100);
  const topOffenders = Array.from(offenderCounts.entries())
    .map(([ruleId, count]) => ({ ruleId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  return {
    score,
    protectedCount,
    totalCount: vaultsScanned,
    topOffenders,
  };
}

// --------------------------------------------------------------------------
// Posture-trend snapshot (wave 8 — compliance score over time)
// --------------------------------------------------------------------------
//
// What we persist: a small ring buffer of per-scan snapshots so the
// operator can see the posture trend across runs without us hitting
// any backend. The snapshot is intentionally lean — just the summary
// counters needed to render a sparkline + delta vs. previous.
//
// citation: New folder\_analysis_defender_view.md §1
//   ScoutSuite ships an HTML report keyed off snapshots taken across
//   audit runs — we mirror that pattern in-page so a returning operator
//   sees movement without having to manually diff JSON exports.

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
export const POSTURE_TREND_MAX = 30;

/**
 * Append a new snapshot to a snapshot ring buffer. Newest first.
 * Drops the oldest entry once the cap is reached. PURE — does no IO.
 */
export function appendPostureSnapshot(
  prev: readonly PostureSnapshot[],
  next: PostureSnapshot,
): PostureSnapshot[] {
  const out = [next, ...prev];
  if (out.length > POSTURE_TREND_MAX) out.length = POSTURE_TREND_MAX;
  return out;
}

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

export function computePostureTrendDelta(
  snapshots: readonly PostureSnapshot[],
): PostureTrendDelta | null {
  if (snapshots.length < 2) return null;
  const a = snapshots[0]!;
  const b = snapshots[1]!;
  return {
    totalDelta: a.total - b.total,
    criticalDelta: a.critical - b.critical,
    highDelta: a.high - b.high,
    tierZeroDelta: a.tierZeroScore - b.tierZeroScore,
  };
}

// --------------------------------------------------------------------------
// Dormant SP credential-rotation anomaly (wave 8 — stub helper)
// --------------------------------------------------------------------------
//
// What we detect: a Service Principal that has been DORMANT (no
// sign-ins, no credential additions) for N days suddenly receives a
// new credential (`addKey` / `addPassword`). This is one of the highest
// signal moves in the corpus playbook because it is the first ARM-side
// shadow of a token-theft → persistence chain — the attacker who lifted
// a PRT cookie and minted a Graph token uses addKey to mint a long-life
// secret on a low-noise SP.
//
// citation: New folder\_bypass_role_grant.md §addKey + §servicePrincipal
//   credential rotation (the offensive primitive)
// citation: New folder\dirkjanm\ROADtools (the operator-grade tooling
//   that automates this credential lift)
//
// This evaluator is PURE — it scores a list of "SP dormancy + cred
// addition" tuples that some upstream collector has built (e.g. by
// joining Graph signIns / appRoleAssignedTo with directory audit logs).
// THIS PAGE DOES NOT WIRE THE COLLECTOR — that lives in another page
// (role-graph / privileged-audit). The helper lives here so we have a
// single place for the rule set and the page can opt-in without a
// dependency cycle.

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
export const DORMANT_SP_DEFAULT_DAYS = 90;

export function evaluateDormantSpCredentialRotation(
  events: readonly DormantSpCredentialEvent[],
  ctx: DormantSpContext = {},
): Finding[] {
  const now = ctx.nowMs ?? Date.now();
  const thresholdDays = Math.max(
    7,
    Math.min(365, ctx.dormantThresholdDays ?? DORMANT_SP_DEFAULT_DAYS),
  );
  const out: Finding[] = [];
  for (const ev of events) {
    const credMs = Date.parse(ev.credentialAddedIso);
    if (!Number.isFinite(credMs)) continue;
    // Determine the most recent activity BEFORE the credential event.
    const signInMs = ev.lastSignInBeforeIso
      ? Date.parse(ev.lastSignInBeforeIso)
      : NaN;
    const credPrevMs = ev.lastCredRotationBeforeIso
      ? Date.parse(ev.lastCredRotationBeforeIso)
      : NaN;
    const candidates: number[] = [];
    if (Number.isFinite(signInMs)) candidates.push(signInMs);
    if (Number.isFinite(credPrevMs)) candidates.push(credPrevMs);
    const lastActivityMs = candidates.length > 0 ? Math.max(...candidates) : null;
    const dormantDays =
      lastActivityMs == null
        ? Number.POSITIVE_INFINITY
        : Math.floor((credMs - lastActivityMs) / (24 * 60 * 60 * 1000));
    if (dormantDays < thresholdDays) continue;
    const severity: Severity = ev.tierZero ? "critical" : "high";
    const days = Number.isFinite(dormantDays)
      ? String(dormantDays)
      : "indefinitely";
    const ageDays = Math.floor((now - credMs) / (24 * 60 * 60 * 1000));
    out.push({
      id: `sp::${ev.servicePrincipalObjectId}::${credMs}::dormant-credrotate`,
      resourceType: "subscription" as ResourceType,
      resourceId: `/servicePrincipals/${ev.servicePrincipalObjectId}`,
      resourceName: ev.servicePrincipalDisplayName,
      resourceGroup: "",
      region: "",
      subscriptionId: ev.tenantId,
      subscriptionName: ev.tenantId,
      ruleId: "sp.dormant-credrotate",
      title: ev.tierZero
        ? `Dormant Tier-0 SP rotated credential after ${days} days`
        : `Dormant SP rotated credential after ${days} days`,
      description: `SP "${ev.servicePrincipalDisplayName}" was dormant ${days} days then a new credential was added ${ageDays} day(s) ago.`,
      whyItMatters:
        "Dormant → suddenly-rotated is the classic shadow of an addKey persistence chain (corpus: _bypass_role_grant.md §addKey). An attacker who lifted a PRT cookie + minted a Graph token uses addKey to mint a long-life secret on the lowest-noise SP they can find — usually one nobody has touched for months. The corpus dirkjanm/ROADtools documents the wire-level call. Defender baseline: alert any credential rotation on a SP idle longer than the team's review cadence (corpus default 90 days).",
      remediation:
        "Inspect directory audit logs for the originating principal of the credential add (Microsoft.DirectoryManagement, operationName=Update application/Add service principal credentials). If the rotation isn't expected, revoke the new credential, force a sign-in event, and audit role/group memberships for this SP. Consider applying a Conditional Access app-policy that requires managed identity for this SP going forward.",
      severity,
    });
  }
  return out;
}
