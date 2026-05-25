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
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Filter as FilterIcon,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
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

// --------------------------------------------------------------------------
// ARM constants
// --------------------------------------------------------------------------

const ARM_BASE = "https://management.azure.com";
const STORAGE_API_VERSION = "2023-05-01";
const KEYVAULT_API_VERSION = "2023-07-01";
// Max pages we'll follow on one provider/sub probe — defensive guard
// against a runaway nextLink loop. 50 pages * 100 results per page =
// 5,000 resources per sub per provider is enough for every real
// tenant we've seen.
const PAGE_FOLLOW_CAP = 50;

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
 */
async function scanSubscription(
  args: ScanSubscriptionArgs,
  subscriptionName: string,
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
    const [storage, vaults] = await Promise.all([
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
    ]);

    const storageList = Array.isArray(storage) ? storage : [];
    const vaultList = Array.isArray(vaults) ? vaults : [];

    // Track per-provider 403s so the warning row makes sense even
    // when one provider succeeded and the other didn't.
    const partialErrors: string[] = [];
    if (!Array.isArray(storage)) {
      partialErrors.push("storage accounts (403)");
    }
    if (!Array.isArray(vaults)) {
      partialErrors.push("key vaults (403)");
    }

    result.storageCount = storageList.length;
    result.vaultCount = vaultList.length;
    for (const sa of storageList) {
      result.findings.push(...evaluateStorageAccount(sa, subscriptionName));
    }
    for (const kv of vaultList) {
      result.findings.push(...evaluateKeyVault(kv, subscriptionName));
    }
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
// Filters / display state
// --------------------------------------------------------------------------

const ALL_SEVERITIES: Severity[] = ["critical", "high", "medium", "info"];
const ALL_RESOURCE_TYPES: ResourceType[] = ["storage", "keyvault"];
// Findings older than this are considered "stale / unfixed". 30 days
// is the typical SLA window in MicroBurst / Prowler default policies
// (NIST 800-53 SI-2 "Flaw Remediation" timing target).
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

function resourceTypeLabel(t: ResourceType): string {
  return t === "storage" ? "Storage Account" : "Key Vault";
}

function resourceTypeIcon(t: ResourceType): React.FC<{ className?: string }> {
  return t === "storage" ? FileText : KeyRound;
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
      // without us having to log per-finding spam.
      const summary = summarizeFindings(aggFindings, aggCounts);
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
        },
      });
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
  }, [accountsById, allSubscriptions, primaryAccount, selectedSubIds]);

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
    }),
    [],
  );
  const [urlState, setUrlState] = useUrlState(URL_INITIAL);

  const activeSeverities = React.useMemo<Set<Severity>>(() => {
    const raw = urlState.sev;
    const arr = Array.isArray(raw)
      ? (raw as string[])
      : typeof raw === "string" && raw.length > 0
        ? raw.split(",")
        : ALL_SEVERITIES;
    const valid = arr.filter((s): s is Severity =>
      (ALL_SEVERITIES as readonly string[]).includes(s),
    );
    return new Set<Severity>(valid.length > 0 ? valid : ALL_SEVERITIES);
  }, [urlState.sev]);

  const activeResourceTypes = React.useMemo<Set<ResourceType>>(() => {
    const raw = urlState.type;
    const arr = Array.isArray(raw)
      ? (raw as string[])
      : typeof raw === "string" && raw.length > 0
        ? raw.split(",")
        : ALL_RESOURCE_TYPES;
    const valid = arr.filter((t): t is ResourceType =>
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

  // ----------------- Finding "first seen" tracking -----------------
  // Persist when each finding-id was first observed so the "older than
  // 30 days" filter chip has something to compare against. The map is
  // pruned to ids currently present in the findings list whenever a
  // new scan completes (in the scan effect below).
  type FirstSeenMap = Record<string, number /* ms since epoch */>;
  const [firstSeenAt, setFirstSeenAt] = usePersistedState<FirstSeenMap>(
    "security-audit:first-seen-v1",
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
      if (!sevPredicate(f)) return false;
      if (!activeResourceTypes.has(f.resourceType)) return false;
      if (showStaleOnly) {
        const firstSeen = firstSeenAt[f.id];
        if (firstSeen == null || firstSeen > staleThreshold) return false;
      }
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
      //   - flip primary by direction (desc shows critical-first, asc shows
      //     none-first);
      //   - tie-break by name ASC regardless of direction so within-severity
      //     rows stay alphabetically predictable.
      const sevDiff =
        (SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]) *
        (sortDir === "desc" ? 1 : -1);
      if (sevDiff !== 0) return sevDiff;
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
        staleThresholdDays: 30,
      },
      scanned: scanCounts,
      summary,
    }),
    [
      lastScanAt,
      lastScannedScope,
      activeSeverities,
      activeResourceTypes,
      searchText,
      criticalHighOnly,
      showStaleOnly,
      scanCounts,
      summary,
    ],
  );

  // ----------------- Render -----------------
  const titleId = React.useId();
  const searchId = React.useId();
  const critOnlyId = React.useId();
  const staleOnlyId = React.useId();

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

  const clearFilters = React.useCallback(() => {
    setUrlState({
      sev: ALL_SEVERITIES as readonly string[] as string[],
      type: ALL_RESOURCE_TYPES as readonly string[] as string[],
      q: "",
      crit: "",
      stale: "",
    });
    recordFilterChange("clear-filters", null);
  }, [setUrlState, recordFilterChange]);

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

      {/* Summary stats */}
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        role="status"
        aria-live="polite"
      >
        <SummaryStatItem
          label="Total findings"
          value={summary.total}
          tone={summary.total > 0 ? "info" : "muted"}
          hint={
            lastScanAt
              ? `scanned ${new Date(lastScanAt).toLocaleString()}`
              : "not scanned yet"
          }
        />
        <SummaryStatItem
          label="Critical"
          value={summary.critical}
          tone={summary.critical > 0 ? "destructive" : "muted"}
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
      </div>

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
        {(activeSeverities.size < ALL_SEVERITIES.length ||
          activeResourceTypes.size < ALL_RESOURCE_TYPES.length ||
          searchText.trim() ||
          criticalHighOnly ||
          showStaleOnly) && (
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
                return <FindingRow key={row.id} finding={row} />;
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
  <TableHead>
    <button
      type="button"
      onClick={onClick}
      className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted/40 hover:text-foreground"
      aria-label={`Sort by ${label}`}
    >
      <span>{label}</span>
      {active && (
        <span className="text-2xs text-muted-foreground">
          {dir === "desc" ? "▼" : "▲"}
        </span>
      )}
    </button>
  </TableHead>
);

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

const FindingRow: React.FC<{ finding: Finding }> = ({ finding: f }) => {
  const Icon = resourceTypeIcon(f.resourceType);
  const parsed = parseArmId(f.resourceId);
  const portalUrl = portalUrlFor(f.resourceId);
  return (
    <TableRow>
      <TableCell>
        <Badge
          variant={SEVERITY_BADGE_VARIANT[f.severity]}
          className="text-2xs"
        >
          {SEVERITY_LABEL[f.severity]}
        </Badge>
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
