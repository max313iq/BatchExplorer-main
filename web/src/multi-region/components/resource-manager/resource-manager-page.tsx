/**
 * Resource Manager — bulk move Azure Batch accounts between
 * resource groups / subscriptions via ARM's moveResources API.
 *
 * Flow:
 *   1. Pick the signed-in account that does the ARM calls.
 *   2. Pick the source subscription → list Batch accounts in it
 *      (already implemented via listBatchAccounts).
 *   3. Multi-select with checkboxes (bulk mode is the default).
 *   4. Pick a destination subscription. Each selected account gets its
 *      own freshly-created destination RG, name-templated per row.
 *   5. Validate (pre-flight via ARM validateMoveResources, no side
 *      effects).
 *   6. Move (long-running; the service layer polls Azure-AsyncOperation
 *      under the hood — including the fall-back of polling the resource
 *      URL itself when ARM returns 202 without a Location header — and
 *      surfaces success/failure inline per row).
 *
 * Notes / Azure caveats surfaced in the UI:
 *   - Source RG is implicit per Batch account (the path's resourceGroups
 *     segment). moveResources requires a single source RG per call, so we
 *     issue one call per account (each gets its own destination RG to
 *     avoid name collisions with sibling accounts).
 *   - ARM limits each call to 800 resources; we never exceed that here.
 *   - Cross-subscription moves require both subs in the same tenant
 *     and the destination subscription must allow Microsoft.Batch.
 *   - Run-id correlation: every validate/move kick-off generates an
 *     incrementing `runId`. Async setState callbacks check the run-id
 *     to avoid clobbering newer runs (race-condition fix for the case
 *     where an operator cancels then immediately re-clicks).
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  FolderTree,
  Ghost,
  Keyboard,
  Layers,
  ListChecks,
  Loader2,
  PackageMinus,
  PackagePlus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Wand2,
  X,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  getActiveTenant,
  getArmTokenForAccount,
} from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { auditLog } from "../../services/audit-log";
import {
  createResourceGroup,
  listBatchAccounts,
  listSubscriptions,
  moveResources,
  validateMoveResources,
} from "../../services";
import type {
  ArmBatchAccount,
  ArmSubscription,
  ResourceMoveOutcome,
} from "../../services";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SignInRequired } from "../shared/sign-in-required";
import type { PageKey } from "../shared/sidebar-nav";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { StatusBadge } from "../shared/status-badge";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

import {
  PreMoveAttackSurfacePreview,
  SecuritySignalsBanner,
} from "./security-signals";

const STORAGE_ACCOUNT = "resource-manager:account";
const STORAGE_SRC_SUB = "resource-manager:src-sub";
const STORAGE_DST_SUB = "resource-manager:dst-sub";
const STORAGE_RG_TEMPLATE = "resource-manager:rg-template";
const STORAGE_SORT = "resource-manager:sort";

/**
 * Default RG-name template applied to every selected account. Supports two
 * placeholders that the operator can mix into a custom pattern:
 *   - `{name}`  → the Batch account name (sanitised)
 *   - `{rg}`   → the source RG name (sanitised)
 * Defaults to `{name}-rg` to preserve the prior auto-naming behaviour.
 */
const DEFAULT_RG_TEMPLATE = "{name}-rg";

/** Azure resource-group name rule: alphanumerics + `_` `-` `.` `(` `)`, no trailing dot, max 90 chars. */
const RG_NAME_RE = /^[a-zA-Z0-9._()-]{1,89}[a-zA-Z0-9_()-]$/;
/** Sanitise a Batch account name into a valid RG-name root. */
function sanitiseForRg(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9._()-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * Render an RG-name template against a row's source attributes. Unknown
 * placeholders are left literal so the operator sees what they typed and
 * can fix it. Used during planRow defaulting AND during "Apply template"
 * bulk-rename so the two paths can never drift apart.
 */
function renderRgTemplate(
  template: string,
  ctx: { name: string; rg: string },
): string {
  const sanitisedName = sanitiseForRg(ctx.name);
  const sanitisedRg = sanitiseForRg(ctx.rg) || "rg";
  return template
    .replace(/\{name\}/gi, sanitisedName)
    .replace(/\{rg\}/gi, sanitisedRg)
    .trim();
}

interface SourceAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

/** Extract the resource group from a full ARM resource id. Returns "" on miss. */
function rgFromArmId(armId: string): string {
  const m = /\/resourceGroups\/([^/]+)/i.exec(armId);
  return m ? m[1]! : "";
}

/**
 * Build the Azure portal deep-link for a Batch account (post-move or
 * source). Lets the operator jump to the portal Blade in one click to
 * verify the move landed correctly — particularly useful while the
 * destination subscription is still settling and the move can take a
 * few minutes to surface in our own list view.
 */
function portalUrlForBatchAccount(armId: string): string {
  return `https://portal.azure.com/#@/resource${armId}/overview`;
}

/**
 * Build the Azure portal deep-link for a resource group. Used as a
 * shortcut next to the destination RG name so the operator can confirm
 * the freshly-created RG is theirs.
 */
function portalUrlForResourceGroup(
  subscriptionId: string,
  rgName: string,
): string {
  return (
    `https://portal.azure.com/#@/resource/subscriptions/${subscriptionId}` +
    `/resourceGroups/${rgName}/overview`
  );
}

/** Human-friendly elapsed-time formatter (e.g. "3m 42s", "12s"). */
function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

/**
 * One row of the per-account RG plan. Each selected Batch account gets
 * its own freshly-created destination RG; we never put two accounts
 * into the same RG. The UI lets the operator override the auto-picked
 * RG name and location before submit.
 */
interface RgPlanRow {
  /** Source Batch account ARM id (input). */
  resourceId: string;
  /** Source Batch account display name. */
  name: string;
  /** Source resource group (derived from the ARM id). */
  sourceResourceGroup: string;
  /** Destination resource group NAME (editable; created in the destination sub). */
  destRgName: string;
  /** Destination location for the RG (editable; defaults to the account's region). */
  destLocation: string;
  /** Multi-step lifecycle. */
  state:
    | "pending"
    | "validating"
    | "creating-rg"
    | "moving"
    | "success"
    | "failure"
    | "cancelled";
  /** Pre-flight validation outcome (if attempted). */
  validateOutcome?: ResourceMoveOutcome;
  /** RG-create outcome (if attempted). */
  rgCreateError?: string;
  /** moveResources outcome (if attempted). */
  moveOutcome?: ResourceMoveOutcome;
  /** Computed full ARM id of the moved account at destination. */
  newResourceId?: string;
  /** Wall-clock start time (ms) of the current step on this row. */
  startedAt?: number;
  /** Wall-clock end time (ms) — set once the row reaches success/failure. */
  finishedAt?: number;
}

/**
 * Quick-filter chip values for the Batch-accounts picker. Maps to the
 * provisioningState of the ARM resource (case-insensitive). "all" is the
 * default no-op filter. "stale" surfaces accounts that look problematic
 * (failed/canceled provisioning OR zero dedicated core quota) — useful
 * targets for a "cleanup move" pass.
 */
type QuickFilter = "all" | "provisioned" | "failed" | "in-progress" | "stale";

/**
 * Heuristic: does this Batch account look stale / abandoned?
 * Signals (any one triggers "stale"):
 *   - provisioningState in {Failed, Canceled, Cancelled}
 *   - dedicatedCoreQuota === 0 AND lowPriorityCoreQuota === 0
 *     (account exists but can't actually allocate any compute)
 * ARM doesn't surface a creation timestamp on Batch accounts, so this is
 * the best we can do without an extra Activity-Log call per account.
 */
function isStaleBatchAccount(b: ArmBatchAccount): boolean {
  const state = (b.properties?.provisioningState ?? "").toLowerCase();
  if (state === "failed" || state === "canceled" || state === "cancelled") {
    return true;
  }
  const dedicated = b.properties?.dedicatedCoreQuota ?? -1;
  const lowPri = b.properties?.lowPriorityCoreQuota ?? -1;
  return dedicated === 0 && lowPri === 0;
}

/**
 * Sort options for the Batch-accounts picker. "name-asc" is the default
 * because it matches ARM's natural ordering and what the operator usually
 * expects when scanning a long list.
 */
type SortOption =
  | "name-asc"
  | "name-desc"
  | "rg-asc"
  | "location-asc"
  | "state-asc";

/** Generate a short, monotonically increasing run-id. */
let _runIdCounter = 0;
function nextRunId(): number {
  _runIdCounter += 1;
  return _runIdCounter;
}

export const ResourceManagerPage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const navigate = useNavigate();
  const azureAccounts = state.azureAccounts ?? [];

  /* ----- Source account picker ------------------------------------ */
  const candidates: SourceAccount[] = React.useMemo(
    () =>
      azureAccounts
        .map((a) => ({
          homeAccountId: a.homeAccountId,
          tenantId:
            getActiveTenant(a.homeAccountId) ??
            resolveActiveTenantId(a) ??
            a.tenantId,
          username: a.username,
          name: a.name || a.username,
        }))
        .filter((a) => !!a.tenantId),
    [azureAccounts],
  );

  const [accountId, setAccountIdState] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_ACCOUNT) ?? "";
    } catch {
      return "";
    }
  });
  const setAccountId = React.useCallback((id: string) => {
    setAccountIdState(id);
    try {
      sessionStorage.setItem(STORAGE_ACCOUNT, id);
    } catch {
      /* ignore */
    }
  }, []);
  React.useEffect(() => {
    if (
      candidates.length > 0 &&
      !candidates.some((c) => c.homeAccountId === accountId)
    ) {
      setAccountId(candidates[0]!.homeAccountId);
    }
  }, [candidates, accountId, setAccountId]);
  const account = React.useMemo(
    () => candidates.find((c) => c.homeAccountId === accountId) ?? null,
    [candidates, accountId],
  );

  /* ----- ARM token freshness tracker ------------------------------- *
   * Drives the TokenExpiryBadge near the page header so the operator
   * can force-refresh the home-tenant ARM token before kicking off a
   * multi-minute moveResources pipeline. The per-tenant `tokenForTenant`
   * cache below is still the source-of-truth for actual ARM calls
   * (each call uses the right tenant's token), so we don't sync the
   * tracker's token down — we only use its expiry / loading signals. */
  const armTokenTracker = useArmToken(
    account?.homeAccountId,
    account?.tenantId,
  );

  /* ----- ARM tokens (per-tenant, lazy) ----------------------------- */
  // Subscriptions can live in a tenant other than the account's home
  // tenant (CSP, Lighthouse, sub-transfer, multi-tenant identities).
  // ARM rejects a home-tenant token on a cross-tenant subscription with
  // "The access token is from the wrong issuer". Cache per-tenant tokens
  // and acquire them on demand so each ARM call uses the right one.
  const tokenCacheRef = React.useRef<Map<string, string>>(new Map());
  const inflightRef = React.useRef<Map<string, Promise<string>>>(new Map());
  React.useEffect(() => {
    // Drop any cached tokens when the source account changes.
    tokenCacheRef.current.clear();
    inflightRef.current.clear();
  }, [accountId]);
  const tokenForTenant = React.useCallback(
    async (tenantId: string): Promise<string> => {
      if (!account) throw new Error("No source account selected.");
      // Resolve fallback against the live store entry so a post-switch
      // call uses the CURRENT active tenant, not the home tenant.
      const azureAccount = azureAccounts.find(
        (a) => a.homeAccountId === account.homeAccountId,
      );
      const fallbackTenantId = azureAccount
        ? resolveActiveTenantId(azureAccount) ?? account.tenantId
        : account.tenantId;
      const key = tenantId || fallbackTenantId;
      const cached = tokenCacheRef.current.get(key);
      if (cached) return cached;
      const existing = inflightRef.current.get(key);
      if (existing) return existing;
      const p = (async () => {
        const t = await getArmTokenForAccount(account.homeAccountId, key);
        tokenCacheRef.current.set(key, t);
        inflightRef.current.delete(key);
        return t;
      })();
      inflightRef.current.set(key, p);
      return p;
    },
    [account, azureAccounts],
  );

  /* ----- Subscriptions (source + destination) --------------------- */
  // Aggregate subs across every tenant the signed-in account belongs
  // to — using a single home-tenant token only returns home-tenant
  // subs, which then 401 when we try to call per-sub endpoints on
  // other-tenant subs. We query each tenant separately and merge.
  const [subs, setSubs] = React.useState<ArmSubscription[]>([]);
  const [subsLoading, setSubsLoading] = React.useState(false);
  const [subsError, setSubsError] = React.useState<string | null>(null);

  // Build the candidate tenant list from the signed-in azureAccounts
  // entry — `tenants[]` is populated by the Azure Accounts page; falls
  // back to the home tenant alone when that hasn't loaded yet.
  const tenantIds = React.useMemo(() => {
    if (!account) return [] as string[];
    const a = azureAccounts.find((x) => x.homeAccountId === account.homeAccountId);
    const ids = new Set<string>();
    ids.add(account.tenantId);
    a?.tenants?.forEach((t) => {
      if (t.tenantId) ids.add(t.tenantId);
    });
    a?.subscriptions?.forEach((s) => {
      if (s.tenantId) ids.add(s.tenantId);
    });
    return Array.from(ids);
  }, [account, azureAccounts]);

  React.useEffect(() => {
    if (!account || tenantIds.length === 0) {
      setSubs([]);
      return;
    }
    let cancelled = false;
    setSubsLoading(true);
    setSubsError(null);
    (async () => {
      const merged = new Map<string, ArmSubscription>();
      const errors: string[] = [];
      for (const tid of tenantIds) {
        try {
          const tok = await tokenForTenant(tid);
          const list = await listSubscriptions(tok);
          for (const s of list) merged.set(s.subscriptionId, s);
        } catch (err) {
          errors.push(
            `tenant ${tid.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (cancelled) return;
      setSubs(Array.from(merged.values()));
      // Only surface an error if EVERY tenant failed — partial success
      // is normal (the account may have lost access to some tenants).
      if (merged.size === 0 && errors.length > 0) {
        setSubsError(errors.join(" · "));
      }
      setSubsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [account?.homeAccountId, tenantIds, tokenForTenant]);


  const [srcSubId, setSrcSubIdState] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_SRC_SUB) ?? "";
    } catch {
      return "";
    }
  });
  const setSrcSubId = React.useCallback((id: string) => {
    setSrcSubIdState(id);
    try {
      sessionStorage.setItem(STORAGE_SRC_SUB, id);
    } catch {
      /* ignore */
    }
  }, []);
  const [dstSubId, setDstSubIdState] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_DST_SUB) ?? "";
    } catch {
      return "";
    }
  });
  const setDstSubId = React.useCallback((id: string) => {
    setDstSubIdState(id);
    try {
      sessionStorage.setItem(STORAGE_DST_SUB, id);
    } catch {
      /* ignore */
    }
  }, []);

  /* ----- Source Batch accounts ------------------------------------ */
  const [batchAccounts, setBatchAccounts] = React.useState<ArmBatchAccount[]>([]);
  const [batchLoading, setBatchLoading] = React.useState(false);
  const [batchError, setBatchError] = React.useState<string | null>(null);
  const [reloadTick, setReloadTick] = React.useState(0);
  const reload = React.useCallback(() => setReloadTick((n) => n + 1), []);

  const srcSub = React.useMemo(
    () => subs.find((s) => s.subscriptionId === srcSubId) ?? null,
    [subs, srcSubId],
  );
  React.useEffect(() => {
    if (!account || !srcSub) {
      setBatchAccounts([]);
      return;
    }
    let cancelled = false;
    setBatchLoading(true);
    setBatchError(null);
    (async () => {
      try {
        const tok = await tokenForTenant(srcSub.tenantId);
        const list = await listBatchAccounts(srcSub.subscriptionId, tok);
        if (!cancelled) setBatchAccounts(list);
      } catch (err) {
        if (!cancelled) {
          setBatchAccounts([]);
          setBatchError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setBatchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account?.homeAccountId, srcSub?.subscriptionId, srcSub?.tenantId, reloadTick, tokenForTenant]);

  /* ----- Destination sub ------------------------------------------ */
  const dstSub = React.useMemo(
    () => subs.find((s) => s.subscriptionId === dstSubId) ?? null,
    [subs, dstSubId],
  );

  /* ----- Selection + filter --------------------------------------- */
  const [search, setSearch] = React.useState("");
  const [quickFilter, setQuickFilter] = React.useState<QuickFilter>("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sort, setSortState] = React.useState<SortOption>(() => {
    try {
      return (
        (sessionStorage.getItem(STORAGE_SORT) as SortOption | null) ??
        "name-asc"
      );
    } catch {
      return "name-asc";
    }
  });
  const setSort = React.useCallback((s: SortOption) => {
    setSortState(s);
    try {
      sessionStorage.setItem(STORAGE_SORT, s);
    } catch {
      /* ignore */
    }
  }, []);

  /** Bucket the provisioningState string into a quick-filter chip group. */
  const bucketState = React.useCallback((raw: string): QuickFilter => {
    const s = raw.toLowerCase();
    if (s === "succeeded" || s === "provisioned") return "provisioned";
    if (s === "failed" || s === "canceled" || s === "cancelled") return "failed";
    if (
      s === "creating" ||
      s === "updating" ||
      s === "deleting" ||
      s === "moving" ||
      s === "provisioning"
    )
      return "in-progress";
    return "all";
  }, []);

  /** Counts per quick-filter bucket — used to label the chips with badges. */
  const stateBuckets = React.useMemo(() => {
    const counts: Record<Exclude<QuickFilter, "all">, number> = {
      provisioned: 0,
      failed: 0,
      "in-progress": 0,
      stale: 0,
    };
    for (const b of batchAccounts) {
      const bucket = bucketState(b.properties?.provisioningState ?? "");
      if (bucket !== "all" && bucket !== "stale") counts[bucket] += 1;
      if (isStaleBatchAccount(b)) counts.stale += 1;
    }
    return counts;
  }, [batchAccounts, bucketState]);

  /**
   * List of "stale" Batch accounts — surfaced in the summary tile and
   * by the persisted "Stale only" filter chip. Heuristic in
   * `isStaleBatchAccount`. Memoised separately so the SummaryStatItem
   * doesn't re-render every keystroke in the search box.
   */
  const staleAccounts = React.useMemo(
    () => batchAccounts.filter(isStaleBatchAccount),
    [batchAccounts],
  );

  /**
   * Stale-only filter — persisted via `usePersistedState` so the chip
   * remembers its on/off state across reloads. When true, the visible
   * list is restricted to accounts flagged by `isStaleBatchAccount`
   * (Failed/Canceled provisioning OR zero core quota). Independent of
   * the provisioningState quick-filter — both compose with AND.
   */
  const [staleOnly, setStaleOnly] = usePersistedState<boolean>(
    "resource-manager:stale-only",
    false,
    { syncAcrossTabs: true },
  );

  /**
   * Multi-token search: every whitespace-separated token must match SOME
   * searchable field. Operators with long account inventories often type
   * "westus succeeded" to narrow the list — single-substring search misses
   * those (because the literal pair never appears in any single field).
   */
  const filtered = React.useMemo(() => {
    const tokens = search
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const out = batchAccounts.filter((b) => {
      // Quick-filter chip first (cheap path).
      if (quickFilter !== "all") {
        if (quickFilter === "stale") {
          if (!isStaleBatchAccount(b)) return false;
        } else {
          const bucket = bucketState(b.properties?.provisioningState ?? "");
          if (bucket !== quickFilter) return false;
        }
      }
      // Persisted "stale only" toggle composes with AND on top of the
      // chip — lets the operator scope to e.g. "in-progress AND stale".
      if (staleOnly && !isStaleBatchAccount(b)) return false;
      if (tokens.length === 0) return true;
      const haystack = [
        b.name,
        b.id,
        b.location,
        b.properties?.provisioningState ?? "",
        rgFromArmId(b.id),
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
    // Apply sort. We work on a copy so the source array stays stable for
    // selection-id checks elsewhere.
    const sorted = [...out];
    switch (sort) {
      case "name-asc":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-desc":
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "rg-asc":
        sorted.sort((a, b) =>
          rgFromArmId(a.id).localeCompare(rgFromArmId(b.id)),
        );
        break;
      case "location-asc":
        sorted.sort((a, b) => (a.location ?? "").localeCompare(b.location ?? ""));
        break;
      case "state-asc":
        sorted.sort((a, b) =>
          (a.properties?.provisioningState ?? "").localeCompare(
            b.properties?.provisioningState ?? "",
          ),
        );
        break;
    }
    return sorted;
  }, [batchAccounts, search, quickFilter, staleOnly, bucketState, sort]);

  // Clear selection ONLY when the source subscription changes — not on
  // every `reloadTick`. The runMove pipeline calls `setReloadTick` to
  // refresh the post-move list AND `setSelected` with the moved rows
  // surgically removed (so failed rows stay ticked for retry). If we
  // cleared selection on `reloadTick` too, that surgical update would
  // be stomped on the next render.
  React.useEffect(() => {
    setSelected(new Set());
  }, [srcSubId]);

  const toggle = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAllVisible = React.useCallback(() => {
    setSelected((prev) => {
      // Additive: preserve any already-selected accounts that the current
      // filter happens to hide. Operators expect "Select visible" to never
      // *deselect* something — that's what "Clear" is for.
      const next = new Set(prev);
      for (const b of filtered) next.add(b.id);
      return next;
    });
  }, [filtered]);
  /**
   * Invert the visible-selection state. Useful when an operator has already
   * picked 30 of 33 accounts and wants the remaining 3 — clicking
   * "Invert visible" is faster than tediously toggling each one.
   */
  const invertVisible = React.useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const b of filtered) {
        if (next.has(b.id)) next.delete(b.id);
        else next.add(b.id);
      }
      return next;
    });
  }, [filtered]);
  const clearSelection = React.useCallback(() => setSelected(new Set()), []);

  /**
   * Copy every selected account's ARM resource id to the clipboard, one per
   * line. Convenient for piping into the Azure CLI / scripts after the
   * operator has fine-tuned the selection in the UI.
   */
  const copySelectedIds = React.useCallback(async () => {
    if (selected.size === 0) return;
    const ids = batchAccounts
      .filter((b) => selected.has(b.id))
      .map((b) => b.id)
      .join("\n");
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText !== undefined
      ) {
        await navigator.clipboard.writeText(ids);
        store.addNotification({
          type: "success",
          message: `Copied ${selected.size} ARM id${
            selected.size === 1 ? "" : "s"
          } to clipboard.`,
        });
        return;
      }
    } catch {
      /* fall through */
    }
    store.addNotification({
      type: "error",
      message: "Clipboard unavailable — copy from the per-row buttons instead.",
    });
  }, [selected, batchAccounts, store]);

  /* ----- Per-account RG plan -------------------------------------- *
   * One row per selected Batch account. Default RG name is rendered from
   * the operator-configurable template (see `rgTemplate` below); on
   * collision we append a numeric suffix so two rows never share a
   * target RG. Default location = the account's region.
   *
   * Per-row overrides live in `planOverrides` so the operator can rename
   * any RG / change the region without losing other defaults. The
   * canonical `planRows` array is recomputed whenever selection or
   * overrides change.
   */
  const [planOverrides, setPlanOverrides] = React.useState<
    Record<string, { destRgName?: string; destLocation?: string }>
  >({});

  /**
   * Bulk-action toolbar state — input for the suffix/prefix the
   * operator wants to slap onto every row's destination RG name in a
   * single click. Kept in a transient local state (not persisted) so a
   * stale "-prod" from yesterday doesn't accidentally re-apply on next
   * session. Confirmation dialog state for bulk delete-from-selection
   * lives separately so the operator can't accidentally fire it.
   */
  const [bulkSuffix, setBulkSuffix] = React.useState("");
  const [confirmBulkRemoveOpen, setConfirmBulkRemoveOpen] =
    React.useState(false);

  /**
   * Planned tags — operator-supplied key/value pairs to attach to every
   * destination resource group at creation time. Stored separately from
   * `planOverrides` because they apply uniformly across all rows (the
   * common case for migration projects: a single "project=…" /
   * "owner=…" / "migrated-on=…" set).
   *
   * COORDINATOR NOTE: `createResourceGroup` in services/arm-service.ts
   * currently only forwards `location` (not `tags`). To wire these
   * through to ARM the service layer needs a small change. Until then
   * the values are surfaced in the plan-export JSON / CSV and shown in
   * the UI so the operator has a paper trail and can apply them via az
   * cli post-move, OR the next services iteration can pick them up via
   * the same prop shape.
   */
  const [planTags, setPlanTags] = React.useState<{ key: string; value: string }[]>(
    [],
  );
  const [draftTagKey, setDraftTagKey] = React.useState("");
  const [draftTagValue, setDraftTagValue] = React.useState("");

  /**
   * Persisted "recent tag keys" memory — every key the operator
   * commits via the multi-tag toolbar gets remembered (last 12,
   * MRU-ordered). Powers a tiny datalist autocomplete so frequent
   * key names like "project", "owner", "cost-center", "migrated-on"
   * resurface without retyping. Persisted via usePersistedState with a
   * schema version so the shape can evolve cleanly.
   */
  const [recentTagKeys, setRecentTagKeys] = usePersistedState<string[]>(
    "resource-manager:recent-tag-keys",
    [],
    {
      syncAcrossTabs: true,
      version: 1,
      migrate: (raw) => (Array.isArray(raw) ? (raw as string[]) : []),
    },
  );

  /** First-row RG-name input ref — hotkey `r` focuses it. */
  const firstRgNameInputRef = React.useRef<HTMLInputElement | null>(null);
  /** First-row location input ref — hotkey `m` focuses it. */
  const firstRgLocationInputRef = React.useRef<HTMLInputElement | null>(null);

  /**
   * Bulk-rename template applied to every row that doesn't have an
   * explicit `destRgName` override. Persisted across reloads so an
   * operator who prefers `mig-{name}` doesn't have to re-set it every
   * session. Uses `usePersistedState` for cross-tab sync + schema
   * versioning (replaces ad-hoc sessionStorage handling).
   */
  const [rgTemplate, setRgTemplate] = usePersistedState<string>(
    STORAGE_RG_TEMPLATE,
    DEFAULT_RG_TEMPLATE,
    { syncAcrossTabs: true },
  );

  const planRows: RgPlanRow[] = React.useMemo(() => {
    const selectedAccounts = batchAccounts.filter((b) => selected.has(b.id));
    const used = new Set<string>();
    // Fall back to the default template if the operator has wiped the
    // input — renderRgTemplate on an empty string produces an empty
    // string which would fail validation for every row, hiding the real
    // problem behind a cascade of duplicate errors.
    const tmpl = rgTemplate.trim() || DEFAULT_RG_TEMPLATE;
    return selectedAccounts.map((b) => {
      const override = planOverrides[b.id] ?? {};
      // Render the template against this row's source attributes. On
      // collision append -2, -3 … until unique.
      const base =
        renderRgTemplate(tmpl, {
          name: b.name,
          rg: rgFromArmId(b.id),
        }) || `${sanitiseForRg(b.name)}-rg`;
      let defaultRg = base;
      let n = 2;
      while (used.has(defaultRg.toLowerCase())) {
        defaultRg = `${base}-${n}`;
        n += 1;
      }
      const finalRg = override.destRgName?.trim() || defaultRg;
      used.add(finalRg.toLowerCase());
      return {
        resourceId: b.id,
        name: b.name,
        sourceResourceGroup: rgFromArmId(b.id),
        destRgName: finalRg,
        destLocation: override.destLocation?.trim() || b.location,
        state: "pending" as const,
      };
    });
  }, [batchAccounts, selected, planOverrides, rgTemplate]);

  /**
   * Bulk-action: append a suffix to every planned row's destination RG
   * name. Writes per-row overrides so the result survives a subsequent
   * template change. No-op for rows with errors so we don't silently
   * compound an invalid name into "still invalid + suffix". Sanitises
   * the suffix through the same RG-name rules to keep the result valid.
   *
   * Bulk-removed selection items are surfaced via auditLog so the
   * operator has a paper trail of what was un-planned just before
   * kicking off a multi-minute move.
   */
  const applyBulkSuffix = React.useCallback(() => {
    const raw = bulkSuffix.trim();
    if (!raw) return;
    // Sanitise the suffix the same way we sanitise generated names —
    // operators sometimes paste in "  -prod  " or "foo bar" and would
    // otherwise produce invalid RG names.
    const safeSuffix = sanitiseForRg(raw).replace(/^[-.]+/, "");
    if (!safeSuffix) {
      store.addNotification({
        type: "error",
        message: "Suffix produced an empty string after sanitisation.",
      });
      return;
    }
    setPlanOverrides((prev) => {
      const next = { ...prev };
      for (const row of planRows) {
        // Use the rendered (possibly-templated, possibly-overridden)
        // name as the base. Idempotent: re-clicking with the same
        // suffix won't double-append.
        const current = row.destRgName;
        if (current.toLowerCase().endsWith(safeSuffix.toLowerCase())) continue;
        next[row.resourceId] = {
          ...(next[row.resourceId] ?? {}),
          destRgName: `${current}-${safeSuffix}`.replace(/-{2,}/g, "-"),
        };
      }
      return next;
    });
    store.addNotification({
      type: "info",
      message: `Appended "-${safeSuffix}" to ${planRows.length} planned RG name${planRows.length === 1 ? "" : "s"}.`,
    });
  }, [bulkSuffix, planRows, store]);

  /**
   * Bulk-action: set the destination location on every row to a single
   * value. Operators with mixed-region source selections sometimes want
   * to land everything in one disaster-recovery region.
   */
  const applyBulkLocation = React.useCallback(
    (loc: string) => {
      const safe = loc.trim();
      if (!safe) return;
      setPlanOverrides((prev) => {
        const next = { ...prev };
        for (const row of planRows) {
          if (row.destLocation === safe) continue;
          next[row.resourceId] = {
            ...(next[row.resourceId] ?? {}),
            destLocation: safe,
          };
        }
        return next;
      });
      store.addNotification({
        type: "info",
        message: `Set destination location to ${safe} on ${planRows.length} row${planRows.length === 1 ? "" : "s"}.`,
      });
    },
    [planRows, store],
  );

  /**
   * Commit the draft tag key/value into the plan tag set. De-duplicates
   * by key (case-insensitive) — re-entering an existing key updates its
   * value. Also pushes the key into the MRU recent-keys memory so the
   * autocomplete surfaces it next time. No-op when key or value are
   * empty after trim.
   */
  const commitTag = React.useCallback(() => {
    const key = draftTagKey.trim();
    const value = draftTagValue.trim();
    if (!key || !value) return;
    // Azure tag limits: max 50 tag pairs per resource, key <= 512 chars,
    // value <= 256 chars. Enforce so the operator can't silently
    // accumulate an invalid tag bag that ARM would reject downstream.
    if (key.length > 512 || value.length > 256) {
      store.addNotification({
        type: "error",
        message: "Tag key must be ≤512 chars and value ≤256 chars (Azure limits).",
      });
      return;
    }
    setPlanTags((prev) => {
      const idx = prev.findIndex(
        (t) => t.key.toLowerCase() === key.toLowerCase(),
      );
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { key, value };
        return next;
      }
      if (prev.length >= 50) {
        store.addNotification({
          type: "error",
          message: "Max 50 tag pairs per resource (Azure limit).",
        });
        return prev;
      }
      return [...prev, { key, value }];
    });
    setRecentTagKeys((prev) => {
      const next = [key, ...prev.filter((k) => k.toLowerCase() !== key.toLowerCase())];
      return next.slice(0, 12);
    });
    setDraftTagKey("");
    setDraftTagValue("");
  }, [draftTagKey, draftTagValue, store, setRecentTagKeys]);

  const removeTag = React.useCallback((key: string) => {
    setPlanTags((prev) => prev.filter((t) => t.key !== key));
  }, []);

  /**
   * Bulk-action: remove EVERY selected account from the plan. Gated by
   * a confirmation dialog because losing a 30-row plan to a stray
   * click is a multi-minute setback for the operator.
   */
  const bulkRemoveFromSelection = React.useCallback(() => {
    if (planRows.length === 0) return;
    const removedIds = planRows.map((r) => r.resourceId);
    setSelected(new Set());
    // Drop overrides for removed rows so a re-selection starts clean.
    setPlanOverrides((prev) => {
      const next = { ...prev };
      for (const id of removedIds) delete next[id];
      return next;
    });
    // Tags applied uniformly belong to the (now-dropped) plan — clear
    // them too so a fresh selection doesn't inherit yesterday's
    // "owner=…" by accident.
    setPlanTags([]);
    auditLog.record({
      actor: account?.username ?? accountId,
      action: "bulk_remove_plan_rows",
      target: srcSub?.subscriptionId ?? "",
      status: "success",
      details: {
        sourceSubscriptionId: srcSub?.subscriptionId,
        rowCount: removedIds.length,
        rowIds: removedIds,
      },
    });
    setConfirmBulkRemoveOpen(false);
    // setSelected / setPlanOverrides / setConfirmBulkRemoveOpen are
    // React state dispatchers — guaranteed stable, so omitted here.
  }, [planRows, account?.username, accountId, srcSub?.subscriptionId]);

  const planErrors: { resourceId: string; message: string }[] = React.useMemo(() => {
    const errs: { resourceId: string; message: string }[] = [];
    const seenRg = new Map<string, string>(); // lowerName -> first resourceId
    for (const row of planRows) {
      if (!RG_NAME_RE.test(row.destRgName)) {
        errs.push({
          resourceId: row.resourceId,
          message: "Invalid RG name (1–90 chars; letters, digits, _ - . ( ); no trailing dot).",
        });
      }
      const lower = row.destRgName.toLowerCase();
      const dupFor = seenRg.get(lower);
      if (dupFor) {
        errs.push({
          resourceId: row.resourceId,
          message: `Duplicate RG name — already used by another row.`,
        });
      } else {
        seenRg.set(lower, row.resourceId);
      }
      if (!row.destLocation.trim()) {
        errs.push({
          resourceId: row.resourceId,
          message: "Location is required (e.g. eastus, westeurope).",
        });
      }
    }
    return errs;
  }, [planRows]);

  /* ----- Cross-tenant guard --------------------------------------- */
  // ARM's moveResources requires source + destination subscriptions in
  // the SAME tenant. Block the action with a clear error rather than
  // letting the call 400.
  const crossTenant = React.useMemo(
    () =>
      !!(srcSub && dstSub && srcSub.tenantId && dstSub.tenantId &&
        srcSub.tenantId.toLowerCase() !== dstSub.tenantId.toLowerCase()),
    [srcSub, dstSub],
  );

  /* ----- Security signals ----------------------------------------- *
   * Heuristic warnings sourced from the offensive-tooling corpus —
   * see security-signals.tsx for the rubric. These DO NOT block the
   * action; they surface anti-patterns (bulk cross-RG ops, rename+move
   * sequences, cross-sub fan-out) the same way SOC tooling would. */
  const rowsWithRenameOverride = React.useMemo(
    () =>
      planRows.reduce((acc, row) => {
        const ov = planOverrides[row.resourceId]?.destRgName?.trim();
        return ov ? acc + 1 : acc;
      }, 0),
    [planRows, planOverrides],
  );
  const distinctDestLocations = React.useMemo(
    () => new Set(planRows.map((r) => r.destLocation.trim().toLowerCase())).size,
    [planRows],
  );

  /* ----- Move execution ------------------------------------------ */
  const [running, setRunning] = React.useState<"validate" | "move" | null>(
    null,
  );
  const [results, setResults] = React.useState<RgPlanRow[]>([]);
  // Confirmation dialog state (replaces native window.confirm).
  const [confirmMoveOpen, setConfirmMoveOpen] = React.useState(false);
  // AbortController for in-flight bulk operations. Lets the user cancel a
  // long-running pipeline without losing the per-row status table.
  const abortRef = React.useRef<AbortController | null>(null);
  /**
   * Run-id correlation. Every kick-off generates a fresh id; async setState
   * callbacks check `currentRunIdRef.current === myRunId` before mutating
   * `results` to prevent a slow-completing row from a cancelled run from
   * stomping the results of a freshly-started one. (See the file header
   * comment for the original race-condition repro.)
   */
  const currentRunIdRef = React.useRef<number>(0);
  /** Start time of the current run for elapsed-time display. */
  const [runStart, setRunStart] = React.useState<number | null>(null);
  /** Tick state to drive the live-elapsed clock without busy-looping. */
  const [elapsedTick, setElapsedTick] = React.useState(0);
  React.useEffect(() => {
    if (running === null) return;
    const id = setInterval(() => setElapsedTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  /** Cancel any in-flight bulk operation. Safe to call when nothing is running. */
  const cancelRunning = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Guarded setResults that drops the write if the run-id has changed
   * since the call was scheduled. Closes the race-window between a slow
   * service-layer call resolving and a new run starting.
   */
  const setResultsForRun = React.useCallback(
    (
      runId: number,
      updater: (prev: RgPlanRow[]) => RgPlanRow[],
    ) => {
      if (currentRunIdRef.current !== runId) return;
      setResults(updater);
    },
    [],
  );

  /**
   * Pre-flight validate every planned row. Doesn't create RGs or call
   * moveResources — only invokes ARM's validateMoveResources endpoint so
   * the operator sees lock/dependency errors before committing. Validation
   * runs against the source RG with the *intended* destination RG ARM id;
   * ARM doesn't require the destination RG to exist for validation.
   */
  const runValidate = React.useCallback(async () => {
    if (!srcSub || !dstSub) return;
    if (planRows.length === 0) return;
    if (planErrors.length > 0) {
      store.addNotification({
        type: "error",
        message: `Fix ${planErrors.length} plan error${planErrors.length === 1 ? "" : "s"} above before validating.`,
      });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const myRunId = nextRunId();
    currentRunIdRef.current = myRunId;
    setRunning("validate");
    setRunStart(Date.now());
    setResults(
      planRows.map((r) => ({ ...r, state: "validating", startedAt: Date.now() })),
    );

    let srcToken: string;
    try {
      srcToken = await tokenForTenant(srcSub.tenantId);
    } catch (err) {
      setRunning(null);
      setRunStart(null);
      store.addNotification({
        type: "error",
        message: `Could not get ARM token: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < planRows.length; i += 1) {
      if (controller.signal.aborted) {
        // Mark remaining rows as cancelled rather than leaving them
        // stuck in "validating…" forever — easier to read in the
        // results table after an early abort.
        setResultsForRun(myRunId, (prev) =>
          prev.map((r, idx) =>
            idx >= i && r.state === "validating"
              ? { ...r, state: "cancelled" as const, finishedAt: Date.now() }
              : r,
          ),
        );
        break;
      }
      const row = planRows[i]!;
      const rowStart = Date.now();
      const targetRgArmId =
        `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${row.destRgName}`;
      let outcome: ResourceMoveOutcome;
      try {
        outcome = await validateMoveResources(
          srcSub.subscriptionId,
          row.sourceResourceGroup,
          [row.resourceId],
          targetRgArmId,
          srcToken,
        );
      } catch (err) {
        outcome = {
          status: 0,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const rowElapsed = Date.now() - rowStart;
      if (outcome.ok) okCount += 1;
      else failCount += 1;
      auditLog.record({
        actor: account?.username ?? accountId,
        action: "validate_move_resources",
        target: row.resourceId,
        status: outcome.ok ? "success" : "failure",
        error: outcome.error,
        details: {
          sourceSubscriptionId: srcSub.subscriptionId,
          sourceResourceGroup: row.sourceResourceGroup,
          destinationResourceGroup: targetRgArmId,
          httpStatus: outcome.status,
          batchAccountName: row.name,
          elapsedMs: rowElapsed,
          runId: myRunId,
        },
      });
      setResultsForRun(myRunId, (prev) =>
        prev.map((r, idx) =>
          idx === i
            ? {
                ...r,
                state: outcome.ok ? "success" : "failure",
                validateOutcome: outcome,
                finishedAt: Date.now(),
              }
            : r,
        ),
      );
    }
    // Only clear the global running flag if this is still the active run.
    if (currentRunIdRef.current === myRunId) {
      setRunning(null);
      setRunStart(null);
      abortRef.current = null;
    }
    if (controller.signal.aborted) {
      store.addNotification({
        type: "warning",
        message: `Validation cancelled. ${okCount} OK / ${failCount} failed before stop.`,
      });
    } else {
      store.addNotification({
        type: failCount === 0 ? "success" : failCount === planRows.length ? "error" : "warning",
        message:
          failCount === 0
            ? `All ${okCount} row${okCount === 1 ? "" : "s"} passed pre-flight. Safe to run the actual move.`
            : `${okCount} OK, ${failCount} failed pre-flight. Review the per-row errors before moving.`,
      });
    }
  }, [
    srcSub,
    dstSub,
    planRows,
    planErrors,
    account?.username,
    accountId,
    store,
    tokenForTenant,
    setResultsForRun,
  ]);

  const runMove = React.useCallback(async () => {
    if (!srcSub || !dstSub) return;
    if (planRows.length === 0) return;
    if (planErrors.length > 0) {
      store.addNotification({
        type: "error",
        message: `Fix ${planErrors.length} plan error${planErrors.length === 1 ? "" : "s"} above before moving.`,
      });
      return;
    }
    setConfirmMoveOpen(false);

    const controller = new AbortController();
    abortRef.current = controller;
    const myRunId = nextRunId();
    currentRunIdRef.current = myRunId;
    setRunning("move");
    setRunStart(Date.now());
    // Seed the results table with every row in "creating-rg".
    setResults(
      planRows.map((r) => ({ ...r, state: "creating-rg", startedAt: Date.now() })),
    );

    // Source + dest tenants are guaranteed identical by the crossTenant
    // guard. Acquire one token, reuse for create-RG and move.
    let srcToken: string;
    try {
      srcToken = await tokenForTenant(srcSub.tenantId);
    } catch (err) {
      setRunning(null);
      setRunStart(null);
      abortRef.current = null;
      store.addNotification({
        type: "error",
        message: `Could not get ARM token: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let movedCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;
    // Local set of successfully-moved resource ids so we can drop them
    // from the selection at the end. Reading the React `results` state
    // for this would be stale (the latest setState batches aren't
    // visible to us until the next render).
    const movedIds = new Set<string>();
    for (let i = 0; i < planRows.length; i += 1) {
      // Honour any cancel request between rows — stop seeding new work but
      // leave already-finished rows in their final state. Remaining
      // rows get flagged "cancelled" so they don't render as ambiguous
      // greyed-out "creating-rg" badges.
      if (controller.signal.aborted) {
        setResultsForRun(myRunId, (prev) =>
          prev.map((r, idx) =>
            idx >= i &&
            (r.state === "creating-rg" || r.state === "moving" || r.state === "pending")
              ? { ...r, state: "cancelled" as const, finishedAt: Date.now() }
              : r,
          ),
        );
        cancelledCount += planRows.length - i;
        break;
      }
      const row = planRows[i]!;
      const rowStart = Date.now();
      const targetRgArmId =
        `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${row.destRgName}`;

      // --- Step 1: create the destination RG --------------------
      let rgCreateError: string | undefined;
      let rgCollisionRetries = 0;
      let effectiveRgName = row.destRgName;
      let effectiveTargetArm = targetRgArmId;
      // Retry with -2, -3, … suffix on conflicting RG names (existing RG
      // owned by someone else, or the operator picked a name already in
      // use). Up to 5 attempts before giving up — beyond that something
      // else is wrong and we surface the underlying error.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await createResourceGroup(
            dstSub.subscriptionId,
            effectiveRgName,
            row.destLocation,
            srcToken,
          );
          auditLog.record({
            actor: account?.username ?? accountId,
            action: "create_resource_group",
            target: effectiveTargetArm,
            status: "success",
            details: {
              destinationSubscriptionId: dstSub.subscriptionId,
              location: row.destLocation,
              autoSuffixed: rgCollisionRetries > 0,
              originalName: row.destRgName,
              effectiveName: effectiveRgName,
              runId: myRunId,
            },
          });
          rgCreateError = undefined;
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          auditLog.record({
            actor: account?.username ?? accountId,
            action: "create_resource_group",
            target: effectiveTargetArm,
            status: "failure",
            error: msg,
            details: {
              destinationSubscriptionId: dstSub.subscriptionId,
              location: row.destLocation,
              attemptedName: effectiveRgName,
              attempt: rgCollisionRetries + 1,
              runId: myRunId,
            },
          });
          // Detect "already exists" / "conflict" — ARM returns
          // 409 Conflict with code `ResourceGroupAlreadyExists` on the
          // target RG name. We auto-suffix and retry up to 5 times.
          const looksLikeCollision =
            /already exists|alreadyexists|conflict/i.test(msg);
          if (looksLikeCollision && rgCollisionRetries < 5) {
            rgCollisionRetries += 1;
            effectiveRgName = `${row.destRgName}-${rgCollisionRetries + 1}`;
            effectiveTargetArm = `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${effectiveRgName}`;
            continue;
          }
          rgCreateError = msg;
          break;
        }
      }
      if (rgCreateError) {
        failedCount += 1;
        setResultsForRun(myRunId, (prev) =>
          prev.map((r, idx) =>
            idx === i
              ? {
                  ...r,
                  state: "failure",
                  rgCreateError,
                  destRgName: effectiveRgName,
                  finishedAt: Date.now(),
                }
              : r,
          ),
        );
        continue; // Skip move if RG create failed.
      }

      // --- Step 2: move that single Batch account ---------------
      setResultsForRun(myRunId, (prev) =>
        prev.map((r, idx) =>
          idx === i
            ? { ...r, state: "moving", destRgName: effectiveRgName }
            : r,
        ),
      );
      let moveOutcome: ResourceMoveOutcome;
      try {
        moveOutcome = await moveResources(
          srcSub.subscriptionId,
          row.sourceResourceGroup,
          [row.resourceId],
          effectiveTargetArm,
          srcToken,
        );
      } catch (err) {
        moveOutcome = {
          status: 0,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const rowElapsed = Date.now() - rowStart;
      if (moveOutcome.ok) {
        movedCount += 1;
        movedIds.add(row.resourceId);
      } else {
        failedCount += 1;
      }
      auditLog.record({
        actor: account?.username ?? accountId,
        action: "move_resources",
        target: row.resourceId,
        status: moveOutcome.ok ? "success" : "failure",
        error: moveOutcome.error,
        details: {
          sourceSubscriptionId: srcSub.subscriptionId,
          sourceResourceGroup: row.sourceResourceGroup,
          destinationResourceGroup: effectiveTargetArm,
          httpStatus: moveOutcome.status,
          batchAccountName: row.name,
          rgCollisionRetries,
          elapsedMs: rowElapsed,
          runId: myRunId,
        },
      });
      const newResourceId = moveOutcome.ok
        ? `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${effectiveRgName}/providers/Microsoft.Batch/batchAccounts/${row.name}`
        : undefined;
      setResultsForRun(myRunId, (prev) =>
        prev.map((r, idx) =>
          idx === i
            ? {
                ...r,
                state: moveOutcome.ok ? "success" : "failure",
                moveOutcome,
                newResourceId,
                destRgName: effectiveRgName,
                finishedAt: Date.now(),
              }
            : r,
        ),
      );
    }
    // Only clear the global running flag if this is still the active run.
    if (currentRunIdRef.current === myRunId) {
      setRunning(null);
      setRunStart(null);
      abortRef.current = null;
    }
    const wasAborted = controller.signal.aborted;
    if (wasAborted) {
      store.addNotification({
        type: "warning",
        message: `Move pipeline cancelled — ${movedCount} moved, ${failedCount} failed, ${cancelledCount} not started. Already-moved rows are not rolled back.`,
      });
    } else if (failedCount === 0) {
      store.addNotification({
        type: "success",
        message: `Move pipeline finished. ${movedCount} account${
          movedCount === 1 ? "" : "s"
        } relocated. Destination subscription may take a few minutes to surface the new resource ids.`,
      });
    } else if (movedCount === 0) {
      store.addNotification({
        type: "error",
        message: `Move pipeline finished with no successes. ${failedCount} failed — review the per-row errors.`,
      });
    } else {
      store.addNotification({
        type: "warning",
        message: `Move pipeline finished. ${movedCount} OK / ${failedCount} failed. Source list refreshing.`,
      });
    }
    setReloadTick((n) => n + 1);
    // Drop only the rows we actually moved from the selection — failed
    // rows stay selected so the operator can iterate on the plan
    // (fix the RG name, retry, etc.) without re-ticking the boxes.
    // Using the local `movedIds` set is essential here: reading
    // `results` would be stale (still the pre-move snapshot).
    if (movedIds.size > 0) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of movedIds) next.delete(id);
        return next;
      });
    }
  }, [
    srcSub,
    dstSub,
    planRows,
    planErrors,
    account?.username,
    accountId,
    store,
    tokenForTenant,
    setResultsForRun,
  ]);

  /* ----- Quick-stat counts (Selected / Validated / Moved / Failed / Cancelled) ---- */
  const stats = React.useMemo(() => {
    const validated = results.filter(
      (r) => r.validateOutcome && r.validateOutcome.ok,
    ).length;
    const moved = results.filter(
      (r) => r.state === "success" && r.moveOutcome?.ok,
    ).length;
    const failed = results.filter((r) => r.state === "failure").length;
    const cancelled = results.filter((r) => r.state === "cancelled").length;
    const inFlight = results.filter(
      (r) =>
        r.state === "validating" ||
        r.state === "creating-rg" ||
        r.state === "moving",
    ).length;
    return {
      selected: selected.size,
      validated,
      moved,
      failed,
      cancelled,
      inFlight,
    };
  }, [selected, results]);

  /**
   * Elapsed time for the current run + simple ETA. ETA is purely
   * advisory — we extrapolate the average per-finished-row time and
   * multiply by the remaining row count. Good enough for sub-minute
   * granularity; the operator already sees per-row status.
   */
  const runTimer = React.useMemo(() => {
    // elapsedTick included so this re-evaluates every second while
    // a run is active. We don't actually read its value.
    void elapsedTick;
    if (running === null || runStart === null) {
      return { elapsedMs: 0, etaMs: null as number | null };
    }
    const elapsedMs = Date.now() - runStart;
    const finished = results.filter(
      (r) => r.state === "success" || r.state === "failure" || r.state === "cancelled",
    ).length;
    const remaining = results.length - finished;
    if (finished === 0 || remaining === 0) {
      return { elapsedMs, etaMs: null };
    }
    const avgPerRow = elapsedMs / finished;
    return { elapsedMs, etaMs: Math.round(avgPerRow * remaining) };
  }, [running, runStart, elapsedTick, results]);

  /* ----- Export columns (source matrix + planned moves + results)
   * The "source matrix" export covers the full unfiltered batchAccounts
   * list — quotas, provisioning state, RG, region, stale-flag. Operators
   * use it as a stocktake before deciding what to move. Filename
   * includes the source subscription so multi-sub exports don't clobber
   * each other on disk. */
  const matrixExportColumns: ExportColumn<ArmBatchAccount>[] = React.useMemo(
    () => [
      { header: "Batch account", accessor: (b) => b.name },
      { header: "Resource ID", accessor: (b) => b.id },
      { header: "Resource group", accessor: (b) => rgFromArmId(b.id) },
      { header: "Location", accessor: (b) => b.location },
      {
        header: "Provisioning state",
        accessor: (b) => b.properties?.provisioningState ?? "",
      },
      {
        header: "Dedicated core quota",
        accessor: (b) => b.properties?.dedicatedCoreQuota ?? "",
      },
      {
        header: "Low-priority core quota",
        accessor: (b) => b.properties?.lowPriorityCoreQuota ?? "",
      },
      {
        header: "Pool quota",
        accessor: (b) => b.properties?.poolQuota ?? "",
      },
      {
        header: "Pool allocation mode",
        accessor: (b) => b.properties?.poolAllocationMode ?? "",
      },
      {
        header: "Public network access",
        accessor: (b) => b.properties?.publicNetworkAccess ?? "",
      },
      {
        header: "Stale (heuristic)",
        accessor: (b) => (isStaleBatchAccount(b) ? "yes" : "no"),
      },
    ],
    [],
  );

  const planExportColumns: ExportColumn<RgPlanRow>[] = React.useMemo(
    () => [
      { header: "Batch account", accessor: (r) => r.name },
      { header: "Resource ID", accessor: (r) => r.resourceId },
      { header: "Source RG", accessor: (r) => r.sourceResourceGroup },
      {
        header: "Source subscription",
        accessor: () => srcSub?.subscriptionId ?? "",
      },
      { header: "Destination RG", accessor: (r) => r.destRgName },
      { header: "Destination location", accessor: (r) => r.destLocation },
      {
        header: "Destination subscription",
        accessor: () => dstSub?.subscriptionId ?? "",
      },
      {
        header: "Predicted ARM ID",
        accessor: (r) =>
          dstSub
            ? `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${r.destRgName}/providers/Microsoft.Batch/batchAccounts/${r.name}`
            : "",
      },
      // Tags rendered as `key=value;key=value` so they fit into a single
      // CSV cell without needing a separate per-tag-pair column.
      {
        header: "Planned tags (key=value;…)",
        accessor: () =>
          planTags.length === 0
            ? ""
            : planTags.map((t) => `${t.key}=${t.value}`).join(";"),
      },
    ],
    [srcSub?.subscriptionId, dstSub, planTags],
  );
  const resultsExportColumns: ExportColumn<RgPlanRow>[] = React.useMemo(
    () => [
      { header: "Batch account", accessor: (r) => r.name },
      { header: "State", accessor: (r) => r.state },
      { header: "Source resource ID", accessor: (r) => r.resourceId },
      { header: "Source RG", accessor: (r) => r.sourceResourceGroup },
      { header: "Destination RG", accessor: (r) => r.destRgName },
      { header: "Destination location", accessor: (r) => r.destLocation },
      { header: "New resource ID", accessor: (r) => r.newResourceId ?? "" },
      {
        header: "Move HTTP status",
        accessor: (r) => r.moveOutcome?.status ?? "",
      },
      {
        header: "Elapsed (s)",
        accessor: (r) =>
          r.startedAt && r.finishedAt
            ? Math.round((r.finishedAt - r.startedAt) / 1000)
            : "",
      },
      { header: "RG create error", accessor: (r) => r.rgCreateError ?? "" },
      { header: "Move error", accessor: (r) => r.moveOutcome?.error ?? "" },
      {
        header: "Validate error",
        accessor: (r) => r.validateOutcome?.error ?? "",
      },
    ],
    [],
  );

  /**
   * Group selected accounts by source RG. Surfaced in the plan card as a
   * compact summary so the operator can see at a glance how many source
   * RGs they're touching — useful when a "wide" move accidentally pulls
   * accounts from across the whole subscription.
   */
  const sourceRgSummary = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of planRows) {
      counts.set(
        r.sourceResourceGroup,
        (counts.get(r.sourceResourceGroup) ?? 0) + 1,
      );
    }
    return Array.from(counts.entries()).sort(
      ([a], [b]) => a.localeCompare(b),
    );
  }, [planRows]);

  // Abort any pipeline on unmount so we never trigger setState after unmount.
  React.useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // React to global tenant-switch events from the shared header /
  // Azure Accounts page so this page's "active account" stays in sync.
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!candidates.some((a) => a.homeAccountId === candidate)) return;
    if (accountId === candidate) return;
    setAccountId(candidate);
  });

  /* ----- Hotkeys -------------------------------------------------- *
   * `r` — focus the first planned row's destination RG name input
   *       (rename). Most common bulk action after selection.
   * `m` — focus the first planned row's destination location input
   *       (move target region pick).
   * Backspace / Delete (when not in an input) — open the bulk-remove
   *       confirmation dialog so the operator can drop the plan with
   *       one keypress + one confirm. Double-gated by ConfirmationDialog
   *       to avoid destructive-on-keystroke regrets. */
  useShortcut("r", () => {
    const el = firstRgNameInputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, { enabled: planRows.length > 0 && running === null });

  useShortcut("m", () => {
    const el = firstRgLocationInputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, { enabled: planRows.length > 0 && running === null });

  useShortcut(
    ["Delete", "Backspace"],
    () => {
      if (planRows.length === 0 || running !== null) return;
      setConfirmBulkRemoveOpen(true);
    },
    { enabled: planRows.length > 0 && running === null },
  );

  /* ----- Render --------------------------------------------------- */

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Resource Manager"
          description="Bulk-move Batch accounts across resource groups / subscriptions."
        />
        <SignInRequired
          whatYouCantDo="Move Batch resources"
          why="an Azure account with access to both source and destination subscriptions"
          onNavigate={(k: PageKey) => navigate(`/${k}`)}
        />
      </div>
    );
  }

  const moveable =
    planRows.length > 0 && planErrors.length === 0 && !crossTenant;

  // Compute the active workflow step for the stepper widget. Each step
  // lights up green once its preconditions are met; the next-pending step
  // pulses to indicate where the operator should look. Purely advisory —
  // no step blocks any other in the underlying state machine.
  const workflowStep: 1 | 2 | 3 | 4 | 5 = !srcSubId || !dstSubId
    ? 1
    : selected.size === 0
    ? 2
    : planErrors.length > 0 || crossTenant
    ? 3
    : stats.validated === selected.size && selected.size > 0
    ? 5
    : 4;

  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader
          title="Resource Manager"
          description="Bulk-move Batch accounts across resource groups / subscriptions. Built on ARM's moveResources API — same-tenant only; expect 1–10 minutes per group."
        />
        {/* Token freshness badge — quiet by default, surfaces when
            < 10 min from expiry. Click to force-refresh BEFORE
            kicking off a multi-row create-RG + moveResources pipeline
            so the home-tenant token doesn't flip mid-run. */}
        <TokenExpiryBadge
          secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
          loading={armTokenTracker.loading}
          onRefresh={() => void armTokenTracker.refresh()}
          needsReauth={armTokenTracker.needsReauth}
          onReauth={() =>
            void armTokenTracker.reauth({
              loginHint: account?.username,
            })
          }
        />
      </div>

      {/* ----- Workflow stepper — Scope → Select → Plan → Validate → Move
            Five-step progress bar so the operator always knows where they
            are. The labels match the section headings below. Steps light
            up green as their preconditions land; the active step pulses. */}
      <ol
        className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card/40 px-3 py-2 text-2xs"
        aria-label="Resource Manager workflow progress"
      >
        {(
          [
            { n: 1, label: "Scope", icon: Building2 },
            { n: 2, label: "Select", icon: Cpu },
            { n: 3, label: "Plan RGs", icon: FolderTree },
            { n: 4, label: "Validate", icon: ShieldCheck },
            { n: 5, label: "Move", icon: ArrowRight },
          ] as const
        ).map((step, i, arr) => {
          const done = workflowStep > step.n;
          const active = workflowStep === step.n;
          const Icon = step.icon;
          return (
            <React.Fragment key={step.n}>
              <li
                className={
                  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 " +
                  (done
                    ? "bg-success/10 text-success"
                    : active
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground")
                }
                aria-current={active ? "step" : undefined}
              >
                {done ? (
                  <CheckCircle2 className="h-3 w-3" aria-hidden />
                ) : (
                  <Icon className="h-3 w-3" aria-hidden />
                )}
                <span>
                  {step.n}. {step.label}
                </span>
              </li>
              {i < arr.length - 1 && (
                <ArrowRight
                  className="h-2.5 w-2.5 text-muted-foreground/50"
                  aria-hidden
                />
              )}
            </React.Fragment>
          );
        })}
      </ol>

      {/* ----- Quick-stat header (Selected / Validated / Moved / Failed / Cancelled) */}
      <div
        className="flex flex-wrap items-stretch gap-2"
        role="group"
        aria-label="Resource Manager summary"
      >
        <SummaryStatItem
          label="Selected"
          value={stats.selected}
          tone={stats.selected > 0 ? "info" : "muted"}
          compact
          hint={`of ${batchAccounts.length} loaded`}
        />
        <SummaryStatItem
          label={running !== null ? "In flight" : "Validated"}
          value={running !== null ? stats.inFlight : stats.validated}
          tone={
            running !== null
              ? "info"
              : stats.validated > 0
              ? "success"
              : "muted"
          }
          compact
          hint={running !== null ? "running…" : "pre-flight passed"}
        />
        <SummaryStatItem
          label="Moved"
          value={stats.moved}
          tone={stats.moved > 0 ? "success" : "muted"}
          compact
          hint="this session"
        />
        <SummaryStatItem
          label="Failed"
          value={stats.failed}
          tone={stats.failed > 0 ? "destructive" : "muted"}
          compact
          hint="see results"
        />
        {/* Stale-resource detector tile — surfaces problematic accounts
            (Failed/Canceled OR zero core quota). Clickable: toggles the
            persisted "Stale only" filter so the operator can drill in
            without scrolling to the chip row. */}
        {staleAccounts.length > 0 && (
          <button
            type="button"
            onClick={() => setStaleOnly((v) => !v)}
            aria-pressed={staleOnly}
            aria-label={
              staleOnly
                ? `Stale-only filter on — ${staleAccounts.length} accounts flagged. Click to clear.`
                : `${staleAccounts.length} stale-looking accounts. Click to filter to only these.`
            }
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={
              staleOnly
                ? "Click to clear the stale-only filter"
                : "Click to filter the list to only stale-looking accounts"
            }
          >
            <SummaryStatItem
              label="Stale"
              value={staleAccounts.length}
              tone={staleOnly ? "warning" : "muted"}
              compact
              hint={staleOnly ? "filter active" : "click to filter"}
            />
          </button>
        )}
        {stats.cancelled > 0 && (
          <SummaryStatItem
            label="Cancelled"
            value={stats.cancelled}
            tone="warning"
            compact
            hint="not started"
          />
        )}
        {running !== null && runStart !== null && (
          <SummaryStatItem
            label="Elapsed"
            value={fmtElapsed(runTimer.elapsedMs)}
            tone="info"
            compact
            hint={
              runTimer.etaMs !== null
                ? `~${fmtElapsed(runTimer.etaMs)} left`
                : "starting…"
            }
          />
        )}
      </div>

      {/* ----- Scope picker --------------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-primary" />
            Scope
            <InfoTooltip
              content="The signed-in account performs every ARM call. Subscriptions list comes from every tenant the account belongs to (aggregated). Cross-tenant moves are rejected by ARM — the destination subscription must live in the same tenant as the source."
              ariaLabel="About scope selection"
            />
          </CardTitle>
          <CardDescription>
            Pick the signed-in account that will run the ARM calls, then
            the source and destination subscriptions.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Source account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick an account" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.homeAccountId} value={c.homeAccountId}>
                    <span className="flex flex-col">
                      <span className="text-sm">{c.name}</span>
                      <span className="text-2xs text-muted-foreground">
                        {c.username}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="inline-flex items-center gap-1 text-xs">
              Source subscription
              {srcSub && (
                <Badge variant="outline" className="text-2xs">
                  tenant {srcSub.tenantId.slice(0, 8)}…
                </Badge>
              )}
            </Label>
            <Select value={srcSubId} onValueChange={setSrcSubId} disabled={subsLoading}>
              <SelectTrigger>
                <SelectValue placeholder={subsLoading ? "Loading…" : "Pick source"} />
              </SelectTrigger>
              <SelectContent>
                {subs.map((s) => (
                  <SelectItem key={s.subscriptionId} value={s.subscriptionId}>
                    <span className="flex flex-col">
                      <span className="text-sm">{s.displayName}</span>
                      <span className="font-mono text-2xs text-muted-foreground">
                        {s.subscriptionId}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="inline-flex items-center gap-1 text-xs">
              Destination subscription
              {dstSub && (
                <Badge
                  variant={
                    srcSub &&
                    srcSub.tenantId.toLowerCase() !==
                      dstSub.tenantId.toLowerCase()
                      ? "destructive"
                      : "outline"
                  }
                  className="text-2xs"
                >
                  tenant {dstSub.tenantId.slice(0, 8)}…
                </Badge>
              )}
            </Label>
            <Select value={dstSubId} onValueChange={setDstSubId} disabled={subsLoading}>
              <SelectTrigger>
                <SelectValue placeholder={subsLoading ? "Loading…" : "Pick destination"} />
              </SelectTrigger>
              <SelectContent>
                {subs.map((s) => (
                  <SelectItem key={s.subscriptionId} value={s.subscriptionId}>
                    <span className="flex flex-col">
                      <span className="text-sm">{s.displayName}</span>
                      <span className="font-mono text-2xs text-muted-foreground">
                        {s.subscriptionId}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
        {/* Swap source/destination shortcut — common operation when the
            operator is "undoing" a move by relocating accounts back to
            where they came from. Disabled while a pipeline is running so
            we don't mutate the run targets mid-flight. */}
        {srcSubId && dstSubId && srcSubId !== dstSubId && (
          <CardContent className="pt-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={running !== null}
              onClick={() => {
                const a = srcSubId;
                const b = dstSubId;
                setSrcSubId(b);
                setDstSubId(a);
                store.addNotification({
                  type: "info",
                  message: "Swapped source and destination subscriptions.",
                });
              }}
              aria-label="Swap source and destination subscriptions"
            >
              <RefreshCw className="h-3 w-3" />
              Swap source ↔ destination
            </Button>
          </CardContent>
        )}
        {subsError && (
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>{subsError}</AlertDescription>
            </Alert>
          </CardContent>
        )}
      </Card>

      {!srcSubId || !dstSubId ? (
        <EmptyState
          icon={ArrowRight}
          title="Pick source & destination subscriptions"
          description="Once you choose both, the Batch accounts in the source appear below and you can pick the destination resource group."
        />
      ) : (
        <>
          {/* ----- Cross-tenant guard (no destination RG picker anymore;
                each row creates its own RG on demand) ----------------- */}
          {crossTenant && srcSub && dstSub && (
            <Alert variant="destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              <AlertDescription>
                Cross-tenant move not supported by ARM. Source sub lives
                in tenant{" "}
                <code className="font-mono">{srcSub.tenantId}</code>,
                destination in{" "}
                <code className="font-mono">{dstSub.tenantId}</code>.
                Move both subs to the same tenant first, or pick
                different subscriptions.
              </AlertDescription>
            </Alert>
          )}

          {/* ----- Source Batch accounts (multi-select) ----------- */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <Cpu className="h-4 w-4 text-primary" />
                Batch accounts in source
                <Badge variant="secondary" className="text-2xs">
                  {selected.size}/{batchAccounts.length} selected
                </Badge>
              </CardTitle>
              <CardDescription>
                Tick the rows to move. Bulk mode — selection is preserved
                across filter changes.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name, RG, location, status… (space-separated tokens; all must match)"
                    className="pl-8 pr-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Search Batch accounts (multi-token AND)"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      aria-label="Clear search"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
                  <SelectTrigger className="h-7 w-[140px] text-2xs" aria-label="Sort Batch accounts">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="name-asc">Name A → Z</SelectItem>
                    <SelectItem value="name-desc">Name Z → A</SelectItem>
                    <SelectItem value="rg-asc">Source RG</SelectItem>
                    <SelectItem value="location-asc">Location</SelectItem>
                    <SelectItem value="state-asc">State</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={selectAllVisible}
                  disabled={filtered.length === 0}
                  aria-label={`Select all ${filtered.length} visible Batch account${filtered.length === 1 ? "" : "s"}`}
                  title="Add every visible row to the selection (existing selections in hidden rows are preserved)"
                >
                  <PackagePlus className="h-3 w-3" />
                  Select visible
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={invertVisible}
                  disabled={filtered.length === 0}
                  aria-label="Invert selection for visible accounts"
                  title="Flip checked/unchecked for every visible row"
                >
                  Invert
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={clearSelection}
                  disabled={selected.size === 0}
                  aria-label="Clear all selected accounts"
                >
                  <PackageMinus className="h-3 w-3" />
                  Clear
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void copySelectedIds()}
                  disabled={selected.size === 0}
                  aria-label={`Copy ${selected.size} selected ARM resource id${selected.size === 1 ? "" : "s"} to clipboard`}
                  title="Copy every selected account's ARM id (one per line)"
                >
                  <Copy className="h-3 w-3" />
                  Copy IDs
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={reload}
                  disabled={batchLoading}
                  aria-label="Refresh Batch accounts list"
                >
                  <RefreshCw
                    className={
                      "h-3 w-3 motion-reduce:animate-none " +
                      (batchLoading ? "animate-spin" : "")
                    }
                  />
                  Refresh
                </Button>
                {/* Full source-matrix CSV/JSON export — covers the
                    unfiltered batchAccounts list (NOT just the plan).
                    Operators use it as a stocktake before deciding
                    what to move. */}
                {batchAccounts.length > 0 && (
                  <ExportMenu
                    rows={batchAccounts}
                    columns={matrixExportColumns}
                    filename={
                      srcSub
                        ? `resource-manager-matrix-${srcSub.subscriptionId.slice(0, 8)}`
                        : "resource-manager-matrix"
                    }
                    label="Export matrix"
                    jsonMetadata={{
                      sourceSubscriptionId: srcSub?.subscriptionId,
                      sourceTenantId: srcSub?.tenantId,
                      totalAccounts: batchAccounts.length,
                      staleAccounts: staleAccounts.length,
                      stateBuckets,
                      exportedAt: new Date().toISOString(),
                      exportedBy: account?.username ?? accountId,
                    }}
                  />
                )}
              </div>

              {/* Quick-filter chips — by provisioningState bucket. */}
              <div
                className="flex flex-wrap items-center gap-1"
                role="group"
                aria-label="Filter Batch accounts by state"
              >
                {(
                  [
                    { value: "all", label: "All", count: batchAccounts.length },
                    {
                      value: "provisioned",
                      label: "Provisioned",
                      count: stateBuckets.provisioned,
                    },
                    {
                      value: "failed",
                      label: "Failed",
                      count: stateBuckets.failed,
                    },
                    {
                      value: "in-progress",
                      label: "In progress",
                      count: stateBuckets["in-progress"],
                    },
                    {
                      value: "stale",
                      label: "Stale",
                      count: stateBuckets.stale,
                    },
                  ] as const
                ).map((chip) => {
                  const active = quickFilter === chip.value;
                  return (
                    <Button
                      key={chip.value}
                      type="button"
                      variant={active ? "default" : "outline"}
                      size="sm"
                      className="h-6 gap-1 px-2 text-2xs focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setQuickFilter(chip.value)}
                      aria-pressed={active}
                      aria-label={`Filter: ${chip.label} (${chip.count})`}
                    >
                      {chip.label}
                      <Badge
                        variant={active ? "secondary" : "outline"}
                        className="text-2xs"
                      >
                        {chip.count}
                      </Badge>
                    </Button>
                  );
                })}
                {/* Persisted "Stale only" toggle — composes with AND on
                    top of the chip above. Lives separately so the
                    operator can keep e.g. "Failed" selected while
                    additionally narrowing to "AND has zero core
                    quota". usePersistedState persists across reloads
                    and (with syncAcrossTabs) across browser tabs. */}
                <Button
                  type="button"
                  variant={staleOnly ? "default" : "outline"}
                  size="sm"
                  className="h-6 gap-1 px-2 text-2xs focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setStaleOnly((v) => !v)}
                  aria-pressed={staleOnly}
                  aria-label={`${staleOnly ? "Disable" : "Enable"} stale-only filter (persisted across reloads)`}
                  title="Toggle a persistent filter that restricts the list to stale-looking accounts."
                  disabled={staleAccounts.length === 0}
                >
                  <Ghost className="h-3 w-3" aria-hidden />
                  Stale only
                  <Badge
                    variant={staleOnly ? "secondary" : "outline"}
                    className="text-2xs"
                  >
                    {staleAccounts.length}
                  </Badge>
                </Button>
              </div>

              {batchLoading ? (
                <SkeletonLoader variant="list" rows={4} />
              ) : batchError ? (
                <ErrorState
                  size="compact"
                  message="Failed to load Batch accounts."
                  detail={batchError}
                  onRetry={reload}
                />
              ) : batchAccounts.length === 0 ? (
                <EmptyState
                  icon={Server}
                  size="compact"
                  title="No Batch accounts in this subscription"
                  description="Pick a different source subscription, or create a Batch account first via the Account Provisioning page."
                />
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Search}
                  size="compact"
                  title="No accounts match the current filter"
                  description="Clear the search box or switch the quick-filter chip to 'All' to see every account."
                  action={{
                    label: "Clear filters",
                    onClick: () => {
                      setSearch("");
                      setQuickFilter("all");
                    },
                  }}
                />
              ) : (
                <ul
                  className="flex flex-col gap-1"
                  aria-label={`${filtered.length} Batch account${filtered.length === 1 ? "" : "s"} matching the current filter`}
                >
                  {filtered.map((b) => {
                    const rg = rgFromArmId(b.id);
                    const isSelected = selected.has(b.id);
                    return (
                      <li
                        key={b.id}
                        className={
                          "flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs focus-within:ring-2 focus-within:ring-ring transition-colors " +
                          (isSelected
                            ? "border-primary/50 bg-primary/5"
                            : "border-border hover:border-border/80 hover:bg-accent/5")
                        }
                      >
                        <Checkbox
                          aria-label={`${isSelected ? "Deselect" : "Select"} ${b.name}`}
                          checked={isSelected}
                          onCheckedChange={() => toggle(b.id)}
                          disabled={running !== null}
                        />
                        <Server className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">{b.name}</span>
                        <Badge variant="outline" className="text-2xs">
                          {b.location}
                        </Badge>
                        <CopyableText
                          value={b.id}
                          display={<span>rg: {rg || "—"}</span>}
                          mono
                          ariaLabel={`Copy ARM resource id for ${b.name}`}
                        />
                        {b.properties?.provisioningState && (
                          <StatusBadge
                            status={b.properties.provisioningState}
                          />
                        )}
                        <a
                          href={portalUrlForBatchAccount(b.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs text-muted-foreground hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Open ${b.name} in Azure Portal`}
                          title="Open in Azure Portal"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Portal
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ----- Per-Batch RG plan ------------------------------ */}
          {planRows.length > 0 && (
            <Card className="border-primary/40">
              <CardHeader className="pb-3">
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                  <FolderTree className="h-4 w-4 text-primary" />
                  RG plan ({planRows.length} new resource group
                  {planRows.length === 1 ? "" : "s"})
                  <InfoTooltip
                    content={
                      <div className="space-y-1">
                        <p className="m-0">
                          Each row creates a fresh resource group in the
                          destination subscription, then runs ARM
                          moveResources to relocate one Batch account into
                          it. The destination RG is created via PUT
                          (idempotent for the same name+location); on
                          conflict we auto-suffix the name -2, -3, … up to
                          5 retries.
                        </p>
                        <p className="m-0">
                          Names are rendered from the template above the
                          table — supported placeholders: <code>{`{name}`}</code>{" "}
                          and <code>{`{rg}`}</code>. Inline edits in the
                          table override the template per row.
                        </p>
                      </div>
                    }
                    ariaLabel="About the RG plan"
                  />
                  {sourceRgSummary.length > 0 && (
                    <Badge variant="outline" className="text-2xs">
                      <Layers className="mr-0.5 h-2.5 w-2.5" />
                      {sourceRgSummary.length} source RG
                      {sourceRgSummary.length === 1 ? "" : "s"}
                    </Badge>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1">
                    <ExportMenu
                      rows={planRows}
                      columns={planExportColumns}
                      filename="resource-manager-plan"
                      label="Export plan"
                      jsonMetadata={{
                        sourceSubscriptionId: srcSub?.subscriptionId,
                        destinationSubscriptionId: dstSub?.subscriptionId,
                        sourceRgs: sourceRgSummary.map(
                          ([rg, count]) => ({ resourceGroup: rg, accountCount: count }),
                        ),
                        rgTemplate,
                        // Tags are plan-only today (services-layer change
                        // required to forward into RG create). Surface them
                        // in the export so the operator can `az tag update`
                        // post-move from the same JSON they exported.
                        plannedTags: planTags.length === 0
                          ? undefined
                          : Object.fromEntries(
                              planTags.map((t) => [t.key, t.value]),
                            ),
                        // Snapshot of the security-signal heuristic
                        // outcomes at export time — gives reviewers a
                        // paper trail of what the operator was warned
                        // about before kicking off the move.
                        securitySignals: {
                          planRowCount: planRows.length,
                          distinctSourceRgs: sourceRgSummary.length,
                          distinctDestLocations,
                          rowsWithRenameOverride,
                          crossSubscription:
                            srcSub?.subscriptionId !==
                            dstSub?.subscriptionId,
                          crossTenant,
                        },
                      }}
                    />
                  </span>
                </CardTitle>
                <CardDescription>
                  Each selected Batch account gets its OWN destination RG
                  in subscription{" "}
                  <code className="font-mono text-2xs">
                    {dstSub?.subscriptionId}
                  </code>
                  . The RG is created before the move and only one Batch
                  account ever lands in each RG. Default name template
                  below; override per row in the table.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {/* Source-RG summary chips — quick way to spot "I'm
                    touching 4 different source RGs", which usually
                    surfaces an unintended over-broad selection. */}
                {sourceRgSummary.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1 text-2xs">
                    <span className="text-muted-foreground">From:</span>
                    {sourceRgSummary.map(([rg, count]) => (
                      <Badge
                        key={rg}
                        variant="outline"
                        className="font-mono"
                        title={`${count} account${count === 1 ? "" : "s"} live in ${rg}`}
                      >
                        {rg} <span className="ml-1 text-muted-foreground">×{count}</span>
                      </Badge>
                    ))}
                  </div>
                )}

                {/* Bulk RG-name template — operator types a pattern and
                    every row not explicitly overridden re-renders against
                    it. Placeholders shown inline; preview chip shows the
                    rendered first-row name for instant feedback. */}
                <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border bg-muted/20 p-2">
                  <div className="flex flex-1 flex-col gap-1 min-w-[200px]">
                    <Label className="inline-flex items-center gap-1 text-2xs">
                      <Wand2 className="h-3 w-3" />
                      RG-name template
                      <InfoTooltip
                        size={11}
                        content={
                          <div className="space-y-1">
                            <p className="m-0">
                              Pattern for the default destination RG name.
                              Two placeholders are supported (case-insensitive):
                            </p>
                            <ul className="m-0 list-disc pl-4">
                              <li>
                                <code>{`{name}`}</code> — Batch account name
                              </li>
                              <li>
                                <code>{`{rg}`}</code> — source RG name
                              </li>
                            </ul>
                            <p className="m-0">
                              Unknown placeholders are left literal. Per-row
                              edits in the table override the template.
                            </p>
                          </div>
                        }
                        ariaLabel="About the RG-name template"
                      />
                    </Label>
                    <Input
                      value={rgTemplate}
                      onChange={(e) => setRgTemplate(e.target.value)}
                      placeholder={DEFAULT_RG_TEMPLATE}
                      className="h-7 font-mono text-2xs"
                      disabled={running !== null}
                      aria-label="Destination RG name template"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {(
                      [
                        { label: "{name}-rg", value: "{name}-rg" },
                        { label: "mig-{name}", value: "mig-{name}" },
                        { label: "{rg}-moved", value: "{rg}-moved" },
                        {
                          label: "rg-{name}-2026",
                          value: "rg-{name}-2026",
                        },
                      ] as const
                    ).map((preset) => (
                      <Button
                        key={preset.value}
                        type="button"
                        variant={rgTemplate === preset.value ? "default" : "outline"}
                        size="xs"
                        onClick={() => setRgTemplate(preset.value)}
                        disabled={running !== null}
                        aria-label={`Use template ${preset.label}`}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* ---- Bulk-action toolbar ----------------------------
                    Operates on every planned row in a single click —
                    bulk-suffix, bulk-location, bulk-remove. Distinct
                    from the template above because the template
                    rebuilds names from scratch while suffix/location
                    overlay edits on top of the current rendered name.
                    Confirmation dialog gates the destructive remove. */}
                <div
                  className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border bg-muted/10 p-2"
                  role="toolbar"
                  aria-label="Bulk actions for the RG plan"
                >
                  <div className="flex flex-col gap-1">
                    <Label
                      htmlFor="rm-bulk-suffix"
                      className="text-2xs text-muted-foreground"
                    >
                      Bulk suffix
                    </Label>
                    <div className="flex items-center gap-1">
                      <Input
                        id="rm-bulk-suffix"
                        value={bulkSuffix}
                        onChange={(e) => setBulkSuffix(e.target.value)}
                        placeholder="-prod, -dr, …"
                        className="h-7 w-32 font-mono text-2xs"
                        disabled={running !== null}
                        aria-label="Suffix to append to every destination RG name"
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={applyBulkSuffix}
                        disabled={running !== null || !bulkSuffix.trim()}
                        aria-label={`Append "${bulkSuffix.trim() || "(empty)"}" to ${planRows.length} destination RG name${planRows.length === 1 ? "" : "s"}`}
                      >
                        Apply to all
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-2xs text-muted-foreground">
                      Bulk location
                    </Label>
                    <div className="flex flex-wrap items-center gap-1">
                      {(
                        ["eastus", "westeurope", "westus2", "southeastasia"] as const
                      ).map((loc) => (
                        <Button
                          key={loc}
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => applyBulkLocation(loc)}
                          disabled={running !== null}
                          aria-label={`Set destination location to ${loc} on all rows`}
                        >
                          {loc}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="ml-auto flex flex-col gap-1">
                    <Label className="text-2xs text-muted-foreground inline-flex items-center gap-1">
                      <Keyboard className="h-2.5 w-2.5" aria-hidden />
                      Hotkeys
                    </Label>
                    <div
                      className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground"
                      aria-label="Keyboard shortcuts for the plan"
                    >
                      <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
                        r
                      </kbd>
                      <span>rename</span>
                      <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
                        m
                      </kbd>
                      <span>move-region</span>
                      <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
                        Del
                      </kbd>
                      <span>drop</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-2xs text-muted-foreground">
                      Bulk remove
                    </Label>
                    <Button
                      type="button"
                      size="xs"
                      variant="destructive"
                      onClick={() => setConfirmBulkRemoveOpen(true)}
                      disabled={running !== null || planRows.length === 0}
                      aria-label={`Remove all ${planRows.length} rows from the plan`}
                      title="Drop every planned row from the selection (no Azure side-effects). Confirmation required. Hotkey: Del."
                    >
                      <Trash2 className="h-3 w-3" aria-hidden />
                      Drop {planRows.length} row{planRows.length === 1 ? "" : "s"}
                    </Button>
                  </div>
                </div>

                {/* ---- Bulk multi-tag editor ------------------------
                    Plan-time tag bag — every destination RG gets the
                    same key/value pairs. Surfaced in the plan export
                    and (once services-layer adds tag support to
                    createResourceGroup) forwarded into the actual
                    PUT body. Datalist autocomplete sources its
                    options from the persisted recent-tag-keys MRU so
                    common org-wide schemas (project, owner, …)
                    resurface without retyping. */}
                <div
                  className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border bg-muted/10 p-2"
                  role="group"
                  aria-label="Plan-time tags applied to every destination resource group"
                >
                  <div className="flex flex-col gap-1">
                    <Label
                      htmlFor="rm-tag-key"
                      className="text-2xs text-muted-foreground inline-flex items-center gap-1"
                    >
                      <Tag className="h-3 w-3" aria-hidden />
                      Tag key
                    </Label>
                    <Input
                      id="rm-tag-key"
                      list="rm-tag-key-suggestions"
                      value={draftTagKey}
                      onChange={(e) => setDraftTagKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitTag();
                        }
                      }}
                      placeholder="project, owner, cost-center…"
                      className="h-7 w-40 font-mono text-2xs"
                      disabled={running !== null}
                      aria-label="Tag key to apply to every destination RG"
                    />
                    {recentTagKeys.length > 0 && (
                      <datalist id="rm-tag-key-suggestions">
                        {recentTagKeys.map((k) => (
                          <option key={k} value={k} />
                        ))}
                      </datalist>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label
                      htmlFor="rm-tag-value"
                      className="text-2xs text-muted-foreground"
                    >
                      Tag value
                    </Label>
                    <Input
                      id="rm-tag-value"
                      value={draftTagValue}
                      onChange={(e) => setDraftTagValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitTag();
                        }
                      }}
                      placeholder="value"
                      className="h-7 w-40 font-mono text-2xs"
                      disabled={running !== null}
                      aria-label="Tag value to apply to every destination RG"
                    />
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={commitTag}
                    disabled={
                      running !== null ||
                      !draftTagKey.trim() ||
                      !draftTagValue.trim()
                    }
                    aria-label="Add tag to plan"
                  >
                    Add tag
                  </Button>
                  {planTags.length > 0 && (
                    <div
                      className="flex flex-wrap items-center gap-1"
                      aria-label={`${planTags.length} planned tag pair${planTags.length === 1 ? "" : "s"}`}
                    >
                      {planTags.map((t) => (
                        <Badge
                          key={t.key}
                          variant="secondary"
                          className="gap-1 font-mono text-2xs"
                          title={`Will apply ${t.key}=${t.value} to every destination RG`}
                        >
                          {t.key}={t.value}
                          <button
                            type="button"
                            onClick={() => removeTag(t.key)}
                            disabled={running !== null}
                            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label={`Remove tag ${t.key}`}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-2xs">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="px-2 py-1 font-medium">
                          Batch account
                        </th>
                        <th className="px-2 py-1 font-medium">Source RG</th>
                        <th className="px-2 py-1 font-medium">
                          <span className="inline-flex items-center gap-1">
                            <ArrowRight className="h-2.5 w-2.5" /> New RG
                            <InfoTooltip
                              size={11}
                              content="Rendered from the template above. On submit, if the name already exists in the destination, we retry with a numeric suffix (-2, -3, …) up to 5 times. Edit inline to override per row."
                              ariaLabel="About auto-naming the destination resource group"
                            />
                          </span>
                        </th>
                        <th className="px-2 py-1 font-medium">
                          <span className="inline-flex items-center gap-1">
                            Location
                            <InfoTooltip
                              size={11}
                              content="Azure region for the new RG (e.g. eastus, westeurope). Defaults to the source Batch account's region. The destination subscription must have Microsoft.Batch registered as a provider in this region."
                              ariaLabel="About provider registration for the destination region"
                            />
                          </span>
                        </th>
                        <th className="px-2 py-1 font-medium text-right">
                          Predicted new ARM ID
                        </th>
                        <th className="px-2 py-1 font-medium" aria-label="Remove row" />
                      </tr>
                    </thead>
                    <tbody>
                      {planRows.map((row, rowIdx) => {
                        const rowErrors = planErrors.filter(
                          (e) => e.resourceId === row.resourceId,
                        );
                        const predictedArm = dstSub
                          ? `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${row.destRgName}/providers/Microsoft.Batch/batchAccounts/${row.name}`
                          : "";
                        const hasOverride =
                          !!planOverrides[row.resourceId]?.destRgName ||
                          !!planOverrides[row.resourceId]?.destLocation;
                        const isFirstRow = rowIdx === 0;
                        return (
                          <tr
                            key={row.resourceId}
                            className={
                              "border-b border-border/50 " +
                              (rowErrors.length > 0
                                ? "bg-destructive/5"
                                : hasOverride
                                ? "bg-warning/5"
                                : "")
                            }
                          >
                            <td className="px-2 py-1">
                              <div className="flex flex-col">
                                <span
                                  className="inline-flex items-center gap-1 font-medium"
                                  title="Click the icon to copy the full source ARM id"
                                >
                                  {row.name}
                                  <CopyButton
                                    value={row.resourceId}
                                    ariaLabel={`Copy ARM resource id for ${row.name}`}
                                    alwaysVisible
                                  />
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  source location:{" "}
                                  <span className="font-mono">{row.destLocation}</span>
                                </span>
                              </div>
                            </td>
                            <td className="px-2 py-1 font-mono text-muted-foreground">
                              {row.sourceResourceGroup}
                            </td>
                            <td className="px-2 py-1">
                              <div className="flex items-center gap-1">
                                <Input
                                  ref={
                                    isFirstRow
                                      ? firstRgNameInputRef
                                      : undefined
                                  }
                                  value={row.destRgName}
                                  onChange={(e) =>
                                    setPlanOverrides((prev) => ({
                                      ...prev,
                                      [row.resourceId]: {
                                        ...(prev[row.resourceId] ?? {}),
                                        destRgName: e.target.value,
                                      },
                                    }))
                                  }
                                  className={
                                    "h-7 w-56 font-mono text-2xs " +
                                    (rowErrors.length > 0
                                      ? "border-destructive focus-visible:ring-destructive"
                                      : "")
                                  }
                                  disabled={running !== null}
                                  aria-invalid={
                                    rowErrors.length > 0 ? true : undefined
                                  }
                                  aria-label={`Destination RG name for ${row.name}`}
                                />
                                {hasOverride && (
                                  <InfoTooltip
                                    size={11}
                                    variant="info"
                                    content="This row has a manual override — it ignores the bulk template above."
                                    ariaLabel="Manual override"
                                  />
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-1">
                              <Input
                                ref={
                                  isFirstRow
                                    ? firstRgLocationInputRef
                                    : undefined
                                }
                                value={row.destLocation}
                                onChange={(e) =>
                                  setPlanOverrides((prev) => ({
                                    ...prev,
                                    [row.resourceId]: {
                                      ...(prev[row.resourceId] ?? {}),
                                      destLocation: e.target.value,
                                    },
                                  }))
                                }
                                className="h-7 w-32 font-mono text-2xs"
                                disabled={running !== null}
                                aria-label={`Destination location for ${row.name}`}
                              />
                            </td>
                            <td className="px-2 py-1 text-right">
                              {predictedArm && (
                                <div className="flex items-center justify-end gap-1">
                                  <span
                                    className="font-mono text-muted-foreground truncate max-w-[260px] inline-block align-middle"
                                    title={predictedArm}
                                  >
                                    …/{row.destRgName}/…/{row.name}
                                  </span>
                                  <CopyButton
                                    value={predictedArm}
                                    ariaLabel={`Copy predicted ARM id for ${row.name}`}
                                    alwaysVisible
                                  />
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-1 text-right">
                              <button
                                type="button"
                                onClick={() => toggle(row.resourceId)}
                                disabled={running !== null}
                                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed"
                                aria-label={`Remove ${row.name} from selection`}
                                title="Remove from selection"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {planErrors.length > 0 && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <AlertDescription>
                      <ul className="list-disc pl-4 text-2xs">
                        {planErrors.slice(0, 6).map((e, i) => (
                          <li key={i}>
                            <code className="font-mono">
                              {planRows.find((r) => r.resourceId === e.resourceId)
                                ?.name ?? e.resourceId}
                            </code>{" "}
                            — {e.message}
                          </li>
                        ))}
                        {planErrors.length > 6 && (
                          <li>… and {planErrors.length - 6} more</li>
                        )}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                {/* ---- Pre-move attack-surface preview --------------
                    Static reference card listing what ARM
                    `moveResources` does and doesn't carry across so
                    the operator doesn't get caught out by RBAC /
                    policy / diagnostic-setting gaps at the
                    destination. Cited in security-signals.tsx. */}
                <PreMoveAttackSurfacePreview />

                {/* ---- Corpus-grounded security signals ------------
                    Heuristic warnings sourced from the offensive-
                    tooling corpus (bypass_modify_delete §4.10 bulk
                    ops rubric, role_grant scoping, etc.). Renders
                    nothing when no signal is active. Advisory — does
                    NOT block the action. */}
                <SecuritySignalsBanner
                  planRowCount={planRows.length}
                  distinctSourceRgs={sourceRgSummary.length}
                  distinctDestLocations={distinctDestLocations}
                  sourceSubscriptionId={srcSub?.subscriptionId ?? null}
                  destinationSubscriptionId={dstSub?.subscriptionId ?? null}
                  sourceTenantId={srcSub?.tenantId ?? null}
                  destinationTenantId={dstSub?.tenantId ?? null}
                  rowsWithRenameOverride={rowsWithRenameOverride}
                />

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void runValidate()}
                    disabled={!moveable || running !== null}
                    loading={running === "validate"}
                    aria-label={`Validate move for ${planRows.length} account${planRows.length === 1 ? "" : "s"}`}
                  >
                    {running !== "validate" && <ShieldCheck />}
                    {running === "validate"
                      ? "Validating…"
                      : `Validate ${planRows.length}`}
                  </Button>
                  <InfoTooltip
                    content="Pre-flight check that calls ARM's validateMoveResources endpoint. No RGs are created, no resources are moved — surfaces lock/dependency errors before you commit."
                    ariaLabel="About Validate move"
                  />
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => {
                      if (planErrors.length > 0) {
                        store.addNotification({
                          type: "error",
                          message: `Fix ${planErrors.length} plan error${planErrors.length === 1 ? "" : "s"} above before moving.`,
                        });
                        return;
                      }
                      setConfirmMoveOpen(true);
                    }}
                    disabled={!moveable || running !== null}
                    loading={running === "move"}
                    aria-label={`Create ${planRows.length} resource groups and move accounts`}
                  >
                    {running !== "move" && <ArrowRight />}
                    {running === "move"
                      ? "Creating RGs & moving…"
                      : `Create ${planRows.length} RG${planRows.length === 1 ? "" : "s"} & move`}
                  </Button>
                  {running !== null && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={cancelRunning}
                      aria-label={`Cancel in-flight ${running} pipeline`}
                      title="Stop the pipeline at the next row boundary. Already-completed rows are not rolled back."
                    >
                      <X className="h-3 w-3" />
                      Cancel run
                    </Button>
                  )}
                  {stats.validated > 0 && running === null && (
                    <Badge variant="success" className="text-2xs">
                      <CheckCircle2 className="mr-0.5 h-2.5 w-2.5" />
                      {stats.validated}/{planRows.length} pre-flight passed
                    </Badge>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPlanOverrides({})}
                      disabled={running !== null || Object.keys(planOverrides).length === 0}
                      aria-label="Reset all destination RG name and location overrides to the template defaults"
                      title="Wipe per-row overrides and re-apply the bulk template"
                    >
                      <Sparkles className="h-3 w-3" />
                      Reset to template
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearSelection}
                      disabled={running !== null || selected.size === 0}
                      aria-label="Clear all selections and remove plan"
                    >
                      <PackageMinus className="h-3 w-3" />
                      Clear plan
                    </Button>
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ----- Per-row results -------------------------------- */}
          {results.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                  <ListChecks className="h-4 w-4 text-primary" />
                  Operation results
                  <Badge variant="secondary" className="text-2xs">
                    {results.length} row{results.length === 1 ? "" : "s"}
                  </Badge>
                  {stats.moved > 0 && (
                    <Badge variant="success" className="text-2xs">
                      <CheckCircle2 className="mr-0.5 h-2.5 w-2.5" />
                      {stats.moved} moved
                    </Badge>
                  )}
                  {stats.failed > 0 && (
                    <Badge variant="destructive" className="text-2xs">
                      <X className="mr-0.5 h-2.5 w-2.5" />
                      {stats.failed} failed
                    </Badge>
                  )}
                  {stats.cancelled > 0 && (
                    <Badge variant="warning" className="text-2xs">
                      {stats.cancelled} cancelled
                    </Badge>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setResults([])}
                      disabled={running !== null}
                      aria-label="Clear the operation results table"
                      title="Clear results (does not undo any moves)"
                    >
                      <PackageMinus className="h-3 w-3" />
                      Clear
                    </Button>
                    <ExportMenu
                      rows={results}
                      columns={resultsExportColumns}
                      filename="resource-manager-results"
                      label="Export results"
                      jsonMetadata={{
                        sourceSubscriptionId: srcSub?.subscriptionId,
                        destinationSubscriptionId: dstSub?.subscriptionId,
                        runMode: running ?? "complete",
                        runStartedAt: runStart
                          ? new Date(runStart).toISOString()
                          : null,
                        actor: account?.username ?? accountId,
                      }}
                    />
                  </span>
                </CardTitle>
                <CardDescription>
                  Each row is independent — RG create + move run sequentially
                  per Batch account. A failed RG-create skips the move
                  for that row but doesn't stop the others. Already-moved
                  rows are <strong>not rolled back</strong> on cancel — use
                  this page in reverse (swap source ↔ destination) to undo.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                {/* ARIA-live progress summary — screen readers
                    announce moves/failures as they land. `polite` so
                    the announcement queues behind whatever the user
                    is reading; the actual per-row state changes are
                    visually indicated by the badge colours. */}
                <div
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="sr-only"
                >
                  {running !== null
                    ? `${stats.inFlight} in flight, ${stats.moved} moved, ${stats.failed} failed.`
                    : `Pipeline finished: ${stats.moved} moved, ${stats.failed} failed${
                        stats.cancelled > 0
                          ? `, ${stats.cancelled} cancelled`
                          : ""
                      }.`}
                </div>
                {results.map((r) => {
                  const elapsedMs =
                    r.startedAt && r.finishedAt
                      ? r.finishedAt - r.startedAt
                      : null;
                  const stateBgClass =
                    r.state === "success"
                      ? "border-success/40 bg-success/5"
                      : r.state === "failure"
                      ? "border-destructive/40 bg-destructive/5"
                      : r.state === "cancelled"
                      ? "border-warning/40 bg-warning/5"
                      : r.state === "validating" ||
                        r.state === "creating-rg" ||
                        r.state === "moving"
                      ? "border-primary/40 bg-primary/5"
                      : "border-border";
                  return (
                  <div
                    key={r.resourceId}
                    className={
                      "flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs focus-within:ring-2 focus-within:ring-ring transition-colors " +
                      stateBgClass
                    }
                    aria-label={`Result row for ${r.name}: ${r.state}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Server className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">{r.name}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                      <CopyableText
                        value={r.destRgName}
                        mono
                        ariaLabel={`Copy destination RG name ${r.destRgName}`}
                      />
                      <Badge variant="outline" className="text-2xs">
                        {r.destLocation}
                      </Badge>
                      {r.state === "pending" && (
                        <Badge variant="outline" className="text-2xs text-muted-foreground">
                          queued
                        </Badge>
                      )}
                      {r.state === "validating" && (
                        <Badge variant="secondary" className="gap-1 text-2xs">
                          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />{" "}
                          validating…
                        </Badge>
                      )}
                      {r.state === "creating-rg" && (
                        <Badge variant="secondary" className="gap-1 text-2xs">
                          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />{" "}
                          creating RG…
                        </Badge>
                      )}
                      {r.state === "moving" && (
                        <Badge variant="secondary" className="gap-1 text-2xs">
                          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />{" "}
                          moving…
                        </Badge>
                      )}
                      {r.state === "success" && (
                        <Badge variant="success" className="gap-1 text-2xs">
                          <CheckCircle2 className="h-3 w-3" />{" "}
                          {r.validateOutcome && !r.moveOutcome
                            ? "validated"
                            : "moved"}
                        </Badge>
                      )}
                      {r.state === "failure" && (
                        <Badge variant="destructive" className="gap-1 text-2xs">
                          <X className="h-3 w-3" /> failed
                        </Badge>
                      )}
                      {r.state === "cancelled" && (
                        <Badge variant="warning" className="gap-1 text-2xs">
                          <X className="h-3 w-3" /> cancelled
                        </Badge>
                      )}
                      {r.moveOutcome?.status ? (
                        <span className="text-2xs text-muted-foreground" title={`Final HTTP status from the async operation poll: ${r.moveOutcome.status}`}>
                          HTTP {r.moveOutcome.status}
                        </span>
                      ) : null}
                      {elapsedMs !== null && (
                        <span
                          className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground"
                          title="Wall-clock time spent on this row"
                        >
                          <Clock className="h-2.5 w-2.5" />
                          {fmtElapsed(elapsedMs)}
                        </span>
                      )}
                      {r.state === "success" && r.newResourceId && (
                        <a
                          href={portalUrlForBatchAccount(r.newResourceId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs text-muted-foreground hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Open ${r.name} at destination in Azure Portal`}
                          title="Open the moved account in the destination subscription (may take a few minutes to surface)"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Portal
                        </a>
                      )}
                      {r.state === "success" && dstSub && (
                        <a
                          href={portalUrlForResourceGroup(
                            dstSub.subscriptionId,
                            r.destRgName,
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs text-muted-foreground hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Open destination RG ${r.destRgName} in Azure Portal`}
                          title="Open the new resource group in the Azure Portal"
                        >
                          <Database className="h-3 w-3" />
                          RG
                        </a>
                      )}
                    </div>
                    {r.newResourceId && (
                      <div className="pl-5 text-2xs text-muted-foreground">
                        New ARM id:{" "}
                        <CopyableText
                          value={r.newResourceId}
                          mono
                          ariaLabel={`Copy new ARM resource id for ${r.name}`}
                        />
                      </div>
                    )}
                    {r.rgCreateError && (
                      <p className="break-words pl-5 text-2xs text-destructive">
                        RG create: {r.rgCreateError}
                      </p>
                    )}
                    {r.validateOutcome?.error && (
                      <p className="break-words pl-5 text-2xs text-destructive">
                        validate: {r.validateOutcome.error}
                      </p>
                    )}
                    {r.moveOutcome?.error && (
                      <p className="break-words pl-5 text-2xs text-destructive">
                        move: {r.moveOutcome.error}
                      </p>
                    )}
                  </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </>
      )}
      {/* Replaces native window.confirm — destructive bulk move. The
          message lists out what will happen + the irreversibility caveat
          so the operator can't accidentally fire a 50-account migration
          without seeing the scope. */}
      <ConfirmationDialog
        hidden={!confirmMoveOpen}
        title={`Create ${planRows.length} RG${planRows.length === 1 ? "" : "s"} & move ${planRows.length} account${planRows.length === 1 ? "" : "s"}`}
        message={
          dstSub ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="m-0">
                You're about to:
              </p>
              <ul className="m-0 list-disc pl-5 text-xs text-muted-foreground">
                <li>
                  Create{" "}
                  <strong>
                    {planRows.length} new resource group
                    {planRows.length === 1 ? "" : "s"}
                  </strong>{" "}
                  in subscription{" "}
                  <code className="font-mono">{dstSub.subscriptionId}</code>.
                </li>
                <li>
                  Move{" "}
                  <strong>
                    {planRows.length} Batch account
                    {planRows.length === 1 ? "" : "s"}
                  </strong>{" "}
                  from {sourceRgSummary.length} source RG
                  {sourceRgSummary.length === 1 ? "" : "s"} into them
                  (one account per RG).
                </li>
                <li>
                  Expect <strong>1–5 minutes per row</strong>; rows run
                  sequentially.
                </li>
              </ul>
              <Alert variant="destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                <AlertDescription className="text-xs">
                  This is <strong>irreversible from this dialog</strong>.
                  To undo a move, swap source ↔ destination and run again.
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            ""
          )
        }
        confirmText={`Create & move ${planRows.length}`}
        danger
        loading={running === "move"}
        onConfirm={() => void runMove()}
        onCancel={() => setConfirmMoveOpen(false)}
      />

      {/* Bulk-remove confirmation — destructive but local-only (no Azure
          side-effects). Surfaces row count so a hasty click on a
          30-row plan can't accidentally wipe the operator's work. */}
      <ConfirmationDialog
        hidden={!confirmBulkRemoveOpen}
        title={`Drop ${planRows.length} row${planRows.length === 1 ? "" : "s"} from plan?`}
        message={
          <div className="flex flex-col gap-2 text-sm">
            <p className="m-0">
              This clears the entire selection and any per-row RG-name
              / location overrides you've made. Nothing in Azure is
              changed.
            </p>
            <p className="m-0 text-xs text-muted-foreground">
              You'll be able to rebuild the plan by re-ticking
              accounts in the list above.
            </p>
          </div>
        }
        confirmText={`Drop ${planRows.length}`}
        danger
        onConfirm={bulkRemoveFromSelection}
        onCancel={() => setConfirmBulkRemoveOpen(false)}
      />
    </div>
  );
};

