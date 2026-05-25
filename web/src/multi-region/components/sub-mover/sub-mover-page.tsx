/**
 * Subscription Mover — bulk move EA-billing subscriptions either:
 *   A. Between enrollment accounts (billing-ownership transfer inside the
 *      same EA billing account), via:
 *        POST /billingAccounts/{ba}/billingSubscriptions/{name}/move
 *        body: { destinationEnrollmentAccountId }
 *   B. To another AAD tenant (Change directory), via:
 *        POST /providers/Microsoft.Subscription/subscriptions/{id}/changeTenant
 *        body: { properties: { tenantId } }
 *
 * Design notes for this iteration:
 *   - Both endpoints respond 202 + Azure-AsyncOperation / Location. Previously
 *     the page just recorded the accept and stopped there; the operator had
 *     to copy the poll URL into Postman to find out whether Azure ever
 *     actually finished. We now poll the long-running op (with backoff +
 *     Retry-After) page-side until it Succeeds, Fails, or the operator
 *     aborts. Polling is wired into the same AbortController as the batch
 *     so abort actually halts everything (not just future rows).
 *   - Rows are processed with a small (operator-configurable) concurrency
 *     pool — sequential is still the default (1) so the audit log is one
 *     row per op, but operators with hundreds of subs can crank it to 3/5/10.
 *   - Row identity is the full ARM `id` (`/providers/.../billingSubscriptions/{name}`).
 *     Earlier code keyed on `subscriptionId ?? name`, which can collide if
 *     a billing-sub row doesn't yet have an AAD subscriptionId (the field
 *     can be empty on partially-provisioned subs) and a second row shares
 *     the same `name` across billingProfiles.
 *   - Pre-flight warnings are expanded: token-expiry, no-op rows (already
 *     on the destination enrollment account), large-batch (>50), and the
 *     existing non-Enabled / missing-subId / same-tenant guards. An auto-
 *     skip toggle lets the operator filter the selection to "viable" rows
 *     before pressing Confirm.
 *   - The result list gains "Rerun failed", "Clear results", per-row
 *     "Copy as cURL" (for off-tab replay), and a live throughput stat. The
 *     export now captures startedAt + durations.
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Crown,
  FolderTree,
  Hourglass,
  Layers,
  Loader2,
  Octagon,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
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
import { useTenantChange } from "../../hooks/use-tenant-change";
import { auditLog } from "../../services/audit-log";
import {
  changeSubscriptionTenant,
  listEaBillingAccounts,
  listEaBillingSubscriptions,
  listEnrollmentAccounts,
  moveBillingSubscriptionToEnrollmentAccount,
} from "../../services";
import type {
  EaBillingAccount,
  EaBillingSubscription,
  EaEnrollmentAccount,
} from "../../services";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SignInRequired } from "../shared/sign-in-required";
import type { PageKey } from "../shared/sidebar-nav";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

const STORAGE_ACCOUNT = "sub-mover:account";
const STORAGE_BA = "sub-mover:billing-account";
const STORAGE_OPKIND = "sub-mover:op-kind";
const STORAGE_DEST_TENANT = "sub-mover:dest-tenant";
const STORAGE_CONCURRENCY = "sub-mover:concurrency";

interface SourceAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

type OpKind = "transfer-billing" | "change-tenant";

type RowState =
  | "pending"
  | "running"
  | "polling"
  | "success"
  | "failure"
  | "cancelled";

interface RowResult {
  /** Unique, stable row id — use this as the React key. Matches the
   *  billing-sub's full ARM `id` so it can't collide with another row. */
  rowKey: string;
  /** Subscription identifier (AAD UUID when available, otherwise billing-sub name). */
  subscriptionId: string;
  /** Display name. */
  displayName: string;
  /** Billing-sub name (short id, the segment after .../billingSubscriptions/). */
  billingSubName: string;
  state: RowState;
  /** Final HTTP status returned by the accept call (typically 200/202). */
  status?: number;
  /** Async-operation tracking URL (Azure-AsyncOperation or Location header). */
  pollUrl?: string;
  /** When polling succeeded/failed, the final terminal status from Azure. */
  pollOutcome?: "Succeeded" | "Failed" | "Canceled" | "Skipped";
  /** When polling failed, the inner error message. */
  pollError?: string;
  /** Number of poll attempts performed (informational). */
  pollAttempts?: number;
  /** Error message for accept-call failures or transport errors. */
  error?: string;
  /** Which operation was attempted (for the export). */
  op?: OpKind;
  /** Destination identifier for audit / export. */
  destination?: string;
  /** Wall-clock when the row started (accept call dispatched). */
  startedAt?: string;
  /** Wall-clock when the row finished (success/failure/cancelled). */
  finishedAt?: string;
  /** Total duration in ms, derived from startedAt+finishedAt for export. */
  durationMs?: number;
}

/**
 * Quick-filter chips for the subscription list. State filters surface rows
 * by their EA-billing state; cross-tenant-ready rows are those that have a
 * usable `subscriptionId` to feed into changeTenant.
 */
type QuickFilter = "all" | "enabled" | "disabled" | "cross-tenant-ready";

/** Concurrency choices for the batch runner. 1 = strictly sequential. */
const CONCURRENCY_CHOICES = [1, 3, 5, 10] as const;
type Concurrency = (typeof CONCURRENCY_CHOICES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-batch maximum polling time, in ms. After this we give up and surface
 *  a "polling timed out — check Azure manually" error instead of spinning
 *  forever. Matches the services-layer default for consistency. */
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
/** Initial poll delay (ms). Doubled on each attempt, capped at MAX. */
const POLL_INITIAL_MS = 3_000;
/** Maximum poll delay (ms). */
const POLL_MAX_MS = 30_000;

/** Read the Retry-After header (seconds or HTTP-date) as milliseconds. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(header);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

/** Sleep that respects an abort signal — rejects with AbortError on abort. */
function abortableDelay(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** True iff the thrown error is an AbortError from our delay/fetch combo. */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === "AbortError"
  ) || (err instanceof Error && err.name === "AbortError");
}

/**
 * Poll an Azure async-operation URL until the LRO reaches a terminal state.
 *
 * We do this at the page level (rather than calling into the services
 * layer's private `pollAsyncOperation`) so the AbortController plumbed
 * through the batch runner can cancel polling mid-flight, not just halt
 * future rows. Backoff: 3s → 6s → 12s → 24s → 30s, honoring Retry-After.
 *
 * Returns the terminal status string and the number of poll attempts made.
 * Throws on AbortError or hard transport failure.
 */
async function pollLro(
  initialUrl: string,
  token: string,
  signal: AbortSignal,
): Promise<{ status: "Succeeded" | "Failed" | "Canceled"; attempts: number; error?: string }> {
  let url = initialUrl;
  let waitMs = POLL_INITIAL_MS;
  let attempts = 0;
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await abortableDelay(waitMs, signal);
    attempts += 1;

    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });

    // Retry-After always wins when present, else exponential backoff capped.
    const retryAfterMs = parseRetryAfter(resp.headers.get("Retry-After"));
    waitMs = retryAfterMs ?? Math.min(waitMs * 2, POLL_MAX_MS);

    if (resp.status === 200 || resp.status === 201) {
      // Terminal success — body may carry status, but 200 alone is enough.
      try {
        const body = (await resp.clone().json()) as {
          status?: string;
          properties?: { provisioningState?: string };
        };
        const inner =
          body?.status ?? body?.properties?.provisioningState ?? "Succeeded";
        const norm = String(inner);
        if (/^succeed/i.test(norm)) return { status: "Succeeded", attempts };
        if (/^fail/i.test(norm)) {
          return { status: "Failed", attempts, error: `Async op returned status=${norm}` };
        }
        if (/^cancel/i.test(norm)) return { status: "Canceled", attempts };
      } catch {
        // Empty body on 200 is fine — treat as success.
      }
      return { status: "Succeeded", attempts };
    }

    if (resp.status === 202) {
      const next =
        resp.headers.get("Azure-AsyncOperation") ??
        resp.headers.get("Location");
      if (next) url = next;
      continue;
    }

    // Non-2xx → terminal failure. Try to surface Azure's error code/message.
    const errBody = (await resp
      .json()
      .catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const msg =
      errBody?.error?.message ?? `Async op poll returned HTTP ${resp.status}`;
    return { status: "Failed", attempts, error: msg };
  }

  return {
    status: "Failed",
    attempts,
    error: `Polling timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s — check the Azure-AsyncOperation URL manually.`,
  };
}

/** Build a cURL one-liner that reproduces the row's POST. */
function buildCurl(row: RowResult, sourceTenantId?: string): string {
  // The accept-call URL is reconstructed from the op+destination so we don't
  // need to store the URL on every row; this also keeps the cURL stable
  // across server-side path changes when the operator copies it later.
  if (row.op === "transfer-billing") {
    const dest = row.destination ?? "";
    return [
      `curl -X POST 'https://management.azure.com/providers/Microsoft.Billing/billingAccounts/<billingAccount>/billingSubscriptions/${row.billingSubName}/move?api-version=2020-05-01'`,
      `  -H 'Authorization: Bearer <ARM_TOKEN>'`,
      `  -H 'Content-Type: application/json'`,
      `  -d '${JSON.stringify({ destinationEnrollmentAccountId: dest })}'`,
    ].join(" \\\n");
  }
  const tenant = row.destination ?? "<destTenantId>";
  return [
    `curl -X POST 'https://management.azure.com/providers/Microsoft.Subscription/subscriptions/${row.subscriptionId}/changeTenant?api-version=2021-10-01'`,
    `  -H 'Authorization: Bearer <ARM_TOKEN>${sourceTenantId ? ` for tenant ${sourceTenantId}` : ""}'`,
    `  -H 'Content-Type: application/json'`,
    `  -d '${JSON.stringify({ properties: { tenantId: tenant } })}'`,
  ].join(" \\\n");
}

/** Best-effort clipboard write. Returns true on success. */
async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* fall through */
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Format a millisecond duration as "1m 24s" / "740ms". */
function fmtDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export const SubMoverPage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const navigate = useNavigate();
  const azureAccounts = state.azureAccounts ?? [];

  /* ----- Account picker ------------------------------------------- */
  const candidates: SourceAccount[] = React.useMemo(
    () =>
      azureAccounts
        .map((a) => ({
          homeAccountId: a.homeAccountId,
          tenantId:
            resolveActiveTenantId(a) ?? getActiveTenant(a.homeAccountId) ?? a.tenantId,
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

  /* ----- ARM token + EA billing accounts -------------------------- */
  // Centralized token tracker: follows the account's active tenant,
  // auto-refreshes 60s before expiry, and powers the inline
  // TokenExpiryBadge so the operator sees freshness without opening
  // the network panel.
  const armTokenTracker = useArmToken(
    account?.homeAccountId,
    account?.tenantId,
  );
  const [armToken, setArmToken] = React.useState<string | null>(null);

  // Bridge: whenever the central useArmToken tracker re-mints (initial
  // acquire, tenant switch, expiry auto-refresh, badge click), sync
  // the new token down to the page's existing `armToken` state so all
  // downstream consumers (billing accounts, enrollment accounts,
  // subscriptions, move/changeTenant calls) immediately use it.
  React.useEffect(() => {
    if (armTokenTracker.token && armTokenTracker.token !== armToken) {
      setArmToken(armTokenTracker.token);
    }
  }, [armTokenTracker.token, armToken]);
  const [tokenError, setTokenError] = React.useState<string | null>(null);
  const [billingAccounts, setBillingAccounts] = React.useState<EaBillingAccount[]>([]);
  const [baLoading, setBaLoading] = React.useState(false);
  const [baError, setBaError] = React.useState<string | null>(null);
  const [billingAccountName, setBillingAccountNameState] =
    React.useState<string>(() => {
      try {
        return sessionStorage.getItem(STORAGE_BA) ?? "";
      } catch {
        return "";
      }
    });
  const setBillingAccountName = React.useCallback((name: string) => {
    setBillingAccountNameState(name);
    try {
      sessionStorage.setItem(STORAGE_BA, name);
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    if (!account) {
      setArmToken(null);
      setBillingAccounts([]);
      return;
    }
    let cancelled = false;
    setBaLoading(true);
    setBaError(null);
    (async () => {
      try {
        // Tenant arg omitted so we pick up the operator's current active
        // tenant (was pinning to account.tenantId / the account's HOME
        // tenant — pre-switch).
        const tok = await getArmTokenForAccount(account.homeAccountId);
        if (cancelled) return;
        setArmToken(tok);
        const list = await listEaBillingAccounts(tok);
        if (cancelled) return;
        setBillingAccounts(list);
        if (list.length === 1 && billingAccountName !== list[0]!.name) {
          setBillingAccountName(list[0]!.name);
        } else if (
          billingAccountName &&
          !list.some((b) => b.name === billingAccountName)
        ) {
          setBillingAccountName("");
        }
      } catch (err) {
        if (cancelled) return;
        setTokenError(err instanceof Error ? err.message : String(err));
        setBaError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.homeAccountId, account?.tenantId]);

  /* ----- Subscriptions + enrollment accounts (under billing acct) -- */
  const [subscriptions, setSubscriptions] = React.useState<EaBillingSubscription[]>([]);
  const [subsLoading, setSubsLoading] = React.useState(false);
  const [subsError, setSubsError] = React.useState<string | null>(null);
  const [enrollmentAccounts, setEnrollmentAccounts] = React.useState<
    EaEnrollmentAccount[]
  >([]);
  const [eaLoading, setEaLoading] = React.useState(false);
  const [eaError, setEaError] = React.useState<string | null>(null);
  const [reloadTick, setReloadTick] = React.useState(0);
  const reload = React.useCallback(() => setReloadTick((n) => n + 1), []);

  React.useEffect(() => {
    if (!armToken || !billingAccountName) {
      setSubscriptions([]);
      setEnrollmentAccounts([]);
      return;
    }
    let cancelled = false;
    setSubsLoading(true);
    setEaLoading(true);
    setSubsError(null);
    setEaError(null);
    listEaBillingSubscriptions(billingAccountName, armToken)
      .then((list) => {
        if (!cancelled) setSubscriptions(list);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setSubsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSubsLoading(false);
      });
    listEnrollmentAccounts(billingAccountName, armToken)
      .then((list) => {
        if (!cancelled) setEnrollmentAccounts(list);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setEaError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setEaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [armToken, billingAccountName, reloadTick]);

  /* ----- Selection ------------------------------------------------ */
  const [search, setSearch] = React.useState("");
  const [quickFilter, setQuickFilter] = React.useState<QuickFilter>("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    setSelected(new Set());
  }, [billingAccountName, reloadTick]);
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return subscriptions.filter((s) => {
      // Quick-filter chip — narrows by state / cross-tenant readiness first
      // so the search box composes on top.
      const status = (s.status ?? "").toLowerCase();
      if (quickFilter === "enabled" && status !== "enabled") return false;
      if (
        quickFilter === "disabled" &&
        status !== "disabled" &&
        status !== "warned" &&
        status !== "expired" &&
        status !== "deleted"
      )
        return false;
      if (quickFilter === "cross-tenant-ready") {
        if (!s.subscriptionId) return false;
        if (status && status !== "enabled") return false;
      }
      if (!q) return true;
      return [s.displayName, s.subscriptionId, s.name, s.status]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [subscriptions, search, quickFilter]);

  /** Counts for the quick-filter chip badges — recomputed once per list change. */
  const subStateCounts = React.useMemo(() => {
    let enabled = 0;
    let disabled = 0;
    let crossTenantReady = 0;
    for (const s of subscriptions) {
      const status = (s.status ?? "").toLowerCase();
      if (status === "enabled") enabled += 1;
      if (
        status === "disabled" ||
        status === "warned" ||
        status === "expired" ||
        status === "deleted"
      )
        disabled += 1;
      if (s.subscriptionId && (!status || status === "enabled"))
        crossTenantReady += 1;
    }
    return { enabled, disabled, crossTenantReady };
  }, [subscriptions]);

  const toggle = React.useCallback((subName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(subName)) next.delete(subName);
      else next.add(subName);
      return next;
    });
  }, []);
  const selectAllVisible = React.useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of filtered) next.add(s.name);
      return next;
    });
  }, [filtered]);
  const clearSelection = React.useCallback(() => setSelected(new Set()), []);
  const selectedSubs = React.useMemo(
    () => subscriptions.filter((s) => selected.has(s.name)),
    [subscriptions, selected],
  );

  /** Copy every selected sub's id (one per line) — useful for ticketing. */
  const copySelectedIds = React.useCallback(async () => {
    const lines = selectedSubs
      .map((s) => s.subscriptionId ?? s.name)
      .filter(Boolean);
    if (lines.length === 0) return;
    const ok = await copyToClipboard(lines.join("\n"));
    if (ok) {
      store.addNotification({
        type: "info",
        message: `Copied ${lines.length} subscription id${lines.length === 1 ? "" : "s"} to clipboard.`,
      });
    }
  }, [selectedSubs, store]);

  /* ----- Action panels ------------------------------------------- */
  const [opKind, setOpKindState] = React.useState<OpKind>(() => {
    try {
      const v = sessionStorage.getItem(STORAGE_OPKIND);
      if (v === "transfer-billing" || v === "change-tenant") return v;
    } catch {
      /* ignore */
    }
    return "transfer-billing";
  });
  const setOpKind = React.useCallback((next: OpKind) => {
    setOpKindState(next);
    try {
      sessionStorage.setItem(STORAGE_OPKIND, next);
    } catch {
      /* ignore */
    }
  }, []);
  const [destEnrollmentArmId, setDestEnrollmentArmId] = React.useState("");
  const [destTenantId, setDestTenantIdState] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_DEST_TENANT) ?? "";
    } catch {
      return "";
    }
  });
  const setDestTenantId = React.useCallback((v: string) => {
    setDestTenantIdState(v);
    try {
      sessionStorage.setItem(STORAGE_DEST_TENANT, v);
    } catch {
      /* ignore */
    }
  }, []);
  /** Operator-tunable parallelism. 1 = legacy sequential behavior. */
  const [concurrency, setConcurrencyState] = React.useState<Concurrency>(() => {
    try {
      const raw = Number(sessionStorage.getItem(STORAGE_CONCURRENCY));
      if (CONCURRENCY_CHOICES.includes(raw as Concurrency))
        return raw as Concurrency;
    } catch {
      /* ignore */
    }
    return 1;
  });
  const setConcurrency = React.useCallback((n: Concurrency) => {
    setConcurrencyState(n);
    try {
      sessionStorage.setItem(STORAGE_CONCURRENCY, String(n));
    } catch {
      /* ignore */
    }
  }, []);

  /** If true, auto-skip rows the pre-flight has flagged as unsafe. */
  const [skipUnsafe, setSkipUnsafe] = React.useState(true);
  /** If true, poll the Azure-AsyncOperation URL until the LRO terminates. */
  const [pollLros, setPollLros] = React.useState(true);

  const [running, setRunning] = React.useState(false);
  const [results, setResults] = React.useState<RowResult[]>([]);
  // Confirmation dialog state (replaces the native window.confirm).
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // Abort controller so the operator can cancel an in-flight batch — when
  // pollLros is enabled it ALSO cancels the in-flight poll fetches so the
  // operator doesn't have to wait minutes for the runner to drain.
  const abortRef = React.useRef<AbortController | null>(null);
  // Cleanup on unmount so a navigation while running doesn't leak the
  // controller (and so the audit-log loop sees the cancel signal).
  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  /** Track the batch start so we can compute total/throughput stats. */
  const batchStartedAtRef = React.useRef<number | null>(null);
  const [batchElapsedMs, setBatchElapsedMs] = React.useState<number>(0);

  // Auto-seed: when EA list arrives, prefer the FIRST one as default.
  React.useEffect(() => {
    if (
      enrollmentAccounts.length > 0 &&
      !destEnrollmentArmId &&
      opKind === "transfer-billing"
    ) {
      setDestEnrollmentArmId(enrollmentAccounts[0]!.id);
    }
  }, [enrollmentAccounts, destEnrollmentArmId, opKind]);

  // Tick the live elapsed counter while the batch runs.
  React.useEffect(() => {
    if (!running || batchStartedAtRef.current == null) return;
    const id = window.setInterval(() => {
      if (batchStartedAtRef.current != null) {
        setBatchElapsedMs(Date.now() - batchStartedAtRef.current);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  /**
   * Rows in the current selection that, if Confirm were pressed, would be
   * a definite no-op or rejection. Surfaced by the auto-skip toggle (which
   * removes them from the actual run) and the pre-flight warnings.
   */
  const previewClassification = React.useMemo(() => {
    const safeRows: EaBillingSubscription[] = [];
    const nonEnabled: EaBillingSubscription[] = [];
    const missingSubId: EaBillingSubscription[] = [];
    const alreadyOnDest: EaBillingSubscription[] = [];
    const sameTenant: EaBillingSubscription[] = [];

    const destEa = destEnrollmentArmId.trim();
    const destTenant = destTenantId.trim().toLowerCase();
    const srcTenant = account?.tenantId?.toLowerCase();

    for (const s of selectedSubs) {
      let safe = true;
      const status = (s.status ?? "").toLowerCase();
      if (status && status !== "enabled") {
        nonEnabled.push(s);
        safe = false;
      }
      if (opKind === "change-tenant") {
        if (!s.subscriptionId) {
          missingSubId.push(s);
          safe = false;
        }
        if (
          srcTenant &&
          destTenant &&
          srcTenant === destTenant
        ) {
          sameTenant.push(s);
          safe = false;
        }
      } else {
        // transfer-billing: detect rows whose `id` already points at the
        // chosen destination enrollment account (lossy heuristic: API
        // doesn't expose the source EA on the billing-sub directly, so we
        // can only detect when the destination is literally a substring of
        // the row's own ARM id, which is true once Azure has reflected an
        // earlier successful move).
        if (destEa && s.id.toLowerCase().includes(destEa.toLowerCase())) {
          alreadyOnDest.push(s);
          safe = false;
        }
      }
      if (safe) safeRows.push(s);
    }
    return { safeRows, nonEnabled, missingSubId, alreadyOnDest, sameTenant };
  }, [selectedSubs, opKind, destEnrollmentArmId, destTenantId, account?.tenantId]);

  /** The rows that will ACTUALLY be submitted (post auto-skip). */
  const rowsToRun = React.useMemo(
    () => (skipUnsafe ? previewClassification.safeRows : selectedSubs),
    [skipUnsafe, previewClassification.safeRows, selectedSubs],
  );

  const planValid = React.useMemo(() => {
    if (rowsToRun.length === 0) return false;
    if (opKind === "transfer-billing")
      return !!destEnrollmentArmId.trim();
    if (!UUID_RE.test(destTenantId.trim())) return false;
    // Don't even let the operator confirm if the destination tenant equals
    // the source — the API will 400 and leaves the batch half-done.
    if (
      account?.tenantId &&
      destTenantId.trim().toLowerCase() === account.tenantId.toLowerCase()
    )
      return false;
    return true;
  }, [rowsToRun.length, opKind, destEnrollmentArmId, destTenantId, account?.tenantId]);

  /**
   * Pre-flight warnings — none of these block submission, but they surface
   * the kinds of soft-failure modes we used to swallow silently:
   *   - subs not in Enabled state will likely 409 on either path
   *   - destination tenant equals the source tenant (no-op + 400)
   *   - cross-tenant request on a row that has no AAD `subscriptionId`
   *   - rows that appear to already live on the destination enrollment account
   *   - extremely large batches without a parallelism bump
   *   - token < 5 minutes from expiry going into a long batch
   */
  const planWarnings = React.useMemo(() => {
    const ws: string[] = [];
    if (selectedSubs.length === 0) return ws;
    const { nonEnabled, missingSubId, alreadyOnDest, sameTenant } =
      previewClassification;
    if (nonEnabled.length > 0) {
      ws.push(
        `${nonEnabled.length} selected subscription${nonEnabled.length === 1 ? " is" : "s are"} not in the Enabled state and may be rejected by Azure.`,
      );
    }
    if (alreadyOnDest.length > 0) {
      ws.push(
        `${alreadyOnDest.length} selected row${alreadyOnDest.length === 1 ? "" : "s"} already appear to belong to the chosen enrollment account — those will be no-ops.`,
      );
    }
    if (opKind === "change-tenant") {
      if (sameTenant.length > 0) {
        ws.push(
          "Destination tenant is the same as the source tenant — Azure will reject the changeTenant call.",
        );
      }
      if (missingSubId.length > 0) {
        ws.push(
          `${missingSubId.length} selected row${missingSubId.length === 1 ? "" : "s"} has no AAD subscriptionId and cannot be moved across tenants.`,
        );
      }
    }
    if (selectedSubs.length >= 50 && concurrency === 1) {
      ws.push(
        `Large batch (${selectedSubs.length}). At concurrency 1 this will take a while — consider bumping the runner to 3 or 5.`,
      );
    }
    if (
      armTokenTracker.secondsUntilExpiry != null &&
      armTokenTracker.secondsUntilExpiry < 300
    ) {
      ws.push(
        `ARM token expires in ${Math.max(0, Math.round(armTokenTracker.secondsUntilExpiry))}s. Click the badge to refresh before kicking off the batch.`,
      );
    }
    return ws;
  }, [
    selectedSubs.length,
    previewClassification,
    opKind,
    concurrency,
    armTokenTracker.secondsUntilExpiry,
  ]);

  const confirmMessage = React.useMemo(() => {
    const skipped = selectedSubs.length - rowsToRun.length;
    const skipNote =
      skipUnsafe && skipped > 0
        ? `\n\n${skipped} unsafe row${skipped === 1 ? "" : "s"} will be skipped (the "Auto-skip" toggle is on).`
        : "";
    const pollNote = pollLros
      ? "\n\nThe page will poll the Azure-AsyncOperation URL until each LRO finishes (or you abort)."
      : "";
    if (opKind === "transfer-billing") {
      const eaName =
        enrollmentAccounts.find((ea) => ea.id === destEnrollmentArmId.trim())
          ?.displayName ?? destEnrollmentArmId.trim();
      return `Transfer billing ownership of ${rowsToRun.length} subscription${rowsToRun.length === 1 ? "" : "s"} to "${eaName}"?${skipNote}${pollNote}`;
    }
    return `Move ${rowsToRun.length} subscription${rowsToRun.length === 1 ? "" : "s"} to tenant ${destTenantId.trim()}? This may require an admin in the destination tenant to accept the offer.${skipNote}${pollNote}`;
  }, [
    opKind,
    rowsToRun.length,
    selectedSubs.length,
    destTenantId,
    enrollmentAccounts,
    destEnrollmentArmId,
    skipUnsafe,
    pollLros,
  ]);

  /**
   * Worker that drives a single row from accept → (optional) poll → result.
   * Pulled out so the runner can fan-out N workers when concurrency > 1.
   *
   * Captures everything from closure scope; the only mutable state it
   * touches is `setResults` (functional updates only) and `auditLog`.
   */
  const runOneRow = React.useCallback(
    async (
      row: EaBillingSubscription,
      auditAction:
        | "move_billing_subscription_to_enrollment_account"
        | "change_subscription_tenant",
      signal: AbortSignal,
      tok: string,
      opKindLocal: OpKind,
      destEa: string,
      destTenant: string,
      pollWhenDone: boolean,
    ): Promise<void> => {
      const rowKey = row.id;
      const startedAtIso = new Date().toISOString();
      const startedAtMs = Date.now();
      setResults((prev) =>
        prev.map((r) =>
          r.rowKey === rowKey
            ? { ...r, state: "running", startedAt: startedAtIso }
            : r,
        ),
      );
      try {
        let outcome: { status: number; location?: string };
        if (opKindLocal === "transfer-billing") {
          outcome = await moveBillingSubscriptionToEnrollmentAccount(
            billingAccountName,
            row.name,
            destEa,
            tok,
          );
        } else {
          if (!row.subscriptionId) {
            throw new Error(
              "No subscriptionId on this billing-subscription row — cannot change tenant.",
            );
          }
          outcome = await changeSubscriptionTenant(
            row.subscriptionId,
            destTenant,
            tok,
          );
        }

        // The accept call landed — record the intent now so we have an
        // audit trail even if the page is closed mid-poll. The optional
        // poll outcome below is logged separately as its own audit entry.
        auditLog.record({
          actor: account?.username ?? accountId,
          action: auditAction,
          target: row.subscriptionId ?? row.name,
          status: "success",
          details: {
            billingAccountName,
            destinationEnrollmentAccountId:
              opKindLocal === "transfer-billing" ? destEa : undefined,
            destinationTenantId:
              opKindLocal === "change-tenant" ? destTenant : undefined,
            httpStatus: outcome.status,
            pollUrl: outcome.location,
            phase: "accepted",
          },
        });

        // Per-row optional polling. We only enter the poll loop if Azure
        // actually returned a tracking URL (synchronous 200 responses skip
        // straight to success). Setting state to "polling" gives the
        // operator a visible signal that the row is waiting on Azure
        // rather than waiting on us.
        if (pollWhenDone && outcome.location) {
          setResults((prev) =>
            prev.map((r) =>
              r.rowKey === rowKey
                ? {
                    ...r,
                    state: "polling",
                    status: outcome.status,
                    pollUrl: outcome.location,
                  }
                : r,
            ),
          );
          try {
            const pollRes = await pollLro(outcome.location, tok, signal);
            const finishedAtIso = new Date().toISOString();
            const durationMs = Date.now() - startedAtMs;
            auditLog.record({
              actor: account?.username ?? accountId,
              action: auditAction,
              target: row.subscriptionId ?? row.name,
              status: pollRes.status === "Succeeded" ? "success" : "failure",
              error: pollRes.error,
              details: {
                billingAccountName,
                destinationEnrollmentAccountId:
                  opKindLocal === "transfer-billing" ? destEa : undefined,
                destinationTenantId:
                  opKindLocal === "change-tenant" ? destTenant : undefined,
                pollUrl: outcome.location,
                pollAttempts: pollRes.attempts,
                phase: "polled",
                terminalStatus: pollRes.status,
              },
            });
            setResults((prev) =>
              prev.map((r) =>
                r.rowKey === rowKey
                  ? {
                      ...r,
                      state:
                        pollRes.status === "Succeeded" ? "success" : "failure",
                      pollOutcome: pollRes.status,
                      pollAttempts: pollRes.attempts,
                      pollError: pollRes.error,
                      error: pollRes.error,
                      finishedAt: finishedAtIso,
                      durationMs,
                    }
                  : r,
              ),
            );
          } catch (pollErr) {
            // Abort mid-poll. Flip the row to cancelled — the accept call
            // is already recorded in the audit log as "accepted" so the
            // operator knows the request landed at Azure.
            if (isAbortError(pollErr)) {
              setResults((prev) =>
                prev.map((r) =>
                  r.rowKey === rowKey
                    ? {
                        ...r,
                        state: "cancelled",
                        error:
                          "Polling cancelled by operator — Azure may still finish the request.",
                        finishedAt: new Date().toISOString(),
                        durationMs: Date.now() - startedAtMs,
                      }
                    : r,
                ),
              );
              return;
            }
            const msg =
              pollErr instanceof Error ? pollErr.message : String(pollErr);
            auditLog.record({
              actor: account?.username ?? accountId,
              action: auditAction,
              target: row.subscriptionId ?? row.name,
              status: "failure",
              error: msg,
              details: { phase: "poll-error", pollUrl: outcome.location },
            });
            setResults((prev) =>
              prev.map((r) =>
                r.rowKey === rowKey
                  ? {
                      ...r,
                      state: "failure",
                      pollError: msg,
                      error: msg,
                      finishedAt: new Date().toISOString(),
                      durationMs: Date.now() - startedAtMs,
                    }
                  : r,
              ),
            );
          }
        } else {
          // No poll — accept call alone is the terminal state.
          const finishedAtIso = new Date().toISOString();
          setResults((prev) =>
            prev.map((r) =>
              r.rowKey === rowKey
                ? {
                    ...r,
                    state: "success",
                    status: outcome.status,
                    pollUrl: outcome.location,
                    finishedAt: finishedAtIso,
                    durationMs: Date.now() - startedAtMs,
                  }
                : r,
            ),
          );
        }
      } catch (err) {
        // Abort while the accept call was in-flight (the service layer's
        // armFetch isn't AbortController-aware today, but the operator may
        // have pressed Abort during the post-accept polling phase for a
        // prior row — that toggles the signal and we surface it here).
        if (isAbortError(err)) {
          setResults((prev) =>
            prev.map((r) =>
              r.rowKey === rowKey
                ? {
                    ...r,
                    state: "cancelled",
                    error: "Cancelled by operator while accept call was in-flight.",
                    finishedAt: new Date().toISOString(),
                    durationMs: Date.now() - startedAtMs,
                  }
                : r,
            ),
          );
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        // Surface every failure both in the per-row card and in the audit
        // log; the old "silent catch" left the operator unable to tell
        // which row blew up after the toast cleared.
        auditLog.record({
          actor: account?.username ?? accountId,
          action: auditAction,
          target: row.subscriptionId ?? row.name,
          status: "failure",
          error: msg,
          details: {
            billingAccountName,
            destinationEnrollmentAccountId:
              opKindLocal === "transfer-billing" ? destEa : undefined,
            destinationTenantId:
              opKindLocal === "change-tenant" ? destTenant : undefined,
            phase: "accept-error",
          },
        });
        setResults((prev) =>
          prev.map((r) =>
            r.rowKey === rowKey
              ? {
                  ...r,
                  state: "failure",
                  error: msg,
                  finishedAt: new Date().toISOString(),
                  durationMs: Date.now() - startedAtMs,
                }
              : r,
          ),
        );
      }
    },
    [billingAccountName, account?.username, accountId],
  );

  /**
   * The actual batch runner. Seeds `results` with one pending row per sub,
   * then either runs them sequentially (concurrency=1) or as a fixed-size
   * worker pool (concurrency=3/5/10).
   *
   * Accepts a `rowsOverride` so the "Rerun failed" button can re-process
   * just the failed subset without rebuilding the entire selection.
   */
  const runRows = React.useCallback(
    async (rowsOverride?: EaBillingSubscription[]) => {
      if (!armToken || running) return;
      const rows = rowsOverride ?? rowsToRun;
      if (rows.length === 0) return;
      setConfirmOpen(false);

      const controller = new AbortController();
      abortRef.current = controller;

      const auditAction:
        | "move_billing_subscription_to_enrollment_account"
        | "change_subscription_tenant" =
        opKind === "transfer-billing"
          ? "move_billing_subscription_to_enrollment_account"
          : "change_subscription_tenant";

      const destEa = destEnrollmentArmId.trim();
      const destTenant = destTenantId.trim();

      setRunning(true);
      batchStartedAtRef.current = Date.now();
      setBatchElapsedMs(0);

      // If this is a rerun, merge new pending rows into existing results;
      // otherwise reset the result list. This keeps the prior success rows
      // visible while the failed ones are retried.
      setResults((prev) => {
        const newRows: RowResult[] = rows.map((s) => ({
          rowKey: s.id,
          subscriptionId: s.subscriptionId ?? s.name,
          displayName: s.displayName,
          billingSubName: s.name,
          state: "pending",
          op: opKind,
          destination:
            opKind === "transfer-billing" ? destEa : destTenant,
        }));
        if (!rowsOverride) return newRows;
        // Rerun mode: replace any existing entry for the same key.
        const keys = new Set(newRows.map((r) => r.rowKey));
        const kept = prev.filter((r) => !keys.has(r.rowKey));
        return [...kept, ...newRows];
      });

      // Build the workers. Each pulls the next index off the shared cursor
      // until either (a) the queue is empty or (b) the abort signal fires.
      const cursor = { i: 0 };
      const queue = rows;
      const workerCount = Math.max(1, Math.min(concurrency, queue.length));
      const worker = async (): Promise<void> => {
        while (!controller.signal.aborted) {
          const idx = cursor.i;
          cursor.i += 1;
          if (idx >= queue.length) return;
          await runOneRow(
            queue[idx]!,
            auditAction,
            controller.signal,
            armToken,
            opKind,
            destEa,
            destTenant,
            pollLros,
          );
        }
      };

      try {
        await Promise.all(Array.from({ length: workerCount }, worker));
      } catch {
        /* per-row errors are already caught inside runOneRow */
      }

      // If abort fired mid-batch, flip any rows that never got to "running"
      // (i.e. they're still "pending") to "cancelled" so the summary stats
      // and audit log have an accurate final picture.
      if (controller.signal.aborted) {
        setResults((prev) =>
          prev.map((r) =>
            r.state === "pending"
              ? {
                  ...r,
                  state: "cancelled",
                  error: "Cancelled by operator before this row started.",
                  finishedAt: new Date().toISOString(),
                }
              : r,
          ),
        );
      }

      setRunning(false);
      abortRef.current = null;
      store.addNotification({
        type: controller.signal.aborted ? "warning" : "info",
        message: controller.signal.aborted
          ? "Batch aborted. Rows accepted by Azure before the cancel will continue server-side; check the destination after a few minutes."
          : opKind === "transfer-billing"
            ? `Billing transfer batch complete (${rows.length} row${rows.length === 1 ? "" : "s"}).`
            : `Change-tenant batch complete (${rows.length} row${rows.length === 1 ? "" : "s"}). Destination tenant may still need to accept the offer.`,
      });
      setReloadTick((n) => n + 1);
      // Only clear the selection on a full success run — preserve on
      // abort/failure so the operator can rerun without re-selecting.
      if (!controller.signal.aborted) setSelected(new Set());
    },
    [
      armToken,
      running,
      rowsToRun,
      concurrency,
      opKind,
      destEnrollmentArmId,
      destTenantId,
      pollLros,
      runOneRow,
      store,
    ],
  );

  const runBatch = React.useCallback(() => {
    void runRows();
  }, [runRows]);

  /** Cancel the in-flight batch. The current ARM accept-call is left to
   *  settle (its underlying fetch isn't AbortController-aware), but any
   *  in-flight LRO polling AND any rows not yet started are aborted. */
  const abortBatch = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** Rerun only the failed rows from the previous batch. */
  const rerunFailed = React.useCallback(() => {
    const failedKeys = new Set(
      results.filter((r) => r.state === "failure").map((r) => r.rowKey),
    );
    if (failedKeys.size === 0) return;
    const rows = subscriptions.filter((s) => failedKeys.has(s.id));
    if (rows.length === 0) {
      store.addNotification({
        type: "warning",
        message:
          "The failed rows are no longer in the subscriptions list — refresh and reselect.",
      });
      return;
    }
    void runRows(rows);
  }, [results, subscriptions, runRows, store]);

  const clearResults = React.useCallback(() => {
    if (running) return;
    setResults([]);
    batchStartedAtRef.current = null;
    setBatchElapsedMs(0);
  }, [running]);

  /* ----- Result summary stats / export columns ------------------- */
  const resultStats = React.useMemo(() => {
    let queued = 0;
    let runningCount = 0;
    let pollingCount = 0;
    let success = 0;
    let failed = 0;
    let cancelled = 0;
    let totalDurationMs = 0;
    let completedDurations = 0;
    for (const r of results) {
      if (r.state === "pending") queued += 1;
      else if (r.state === "running") runningCount += 1;
      else if (r.state === "polling") pollingCount += 1;
      else if (r.state === "success") success += 1;
      else if (r.state === "failure") failed += 1;
      else if (r.state === "cancelled") cancelled += 1;
      if (r.durationMs != null && Number.isFinite(r.durationMs)) {
        totalDurationMs += r.durationMs;
        completedDurations += 1;
      }
    }
    const avgMs =
      completedDurations > 0 ? totalDurationMs / completedDurations : 0;
    return {
      queued,
      runningCount,
      pollingCount,
      success,
      failed,
      cancelled,
      avgMs,
      completedDurations,
    };
  }, [results]);

  /** Export columns for the bulk-results list — CSV + JSON share this. */
  const exportColumns = React.useMemo(
    () =>
      [
        { header: "displayName", accessor: (r: RowResult) => r.displayName },
        { header: "subscriptionId", accessor: (r: RowResult) => r.subscriptionId },
        { header: "billingSubName", accessor: (r: RowResult) => r.billingSubName },
        { header: "operation", accessor: (r: RowResult) => r.op ?? opKind },
        { header: "destination", accessor: (r: RowResult) => r.destination ?? "" },
        { header: "state", accessor: (r: RowResult) => r.state },
        { header: "httpStatus", accessor: (r: RowResult) => r.status ?? "" },
        { header: "pollUrl", accessor: (r: RowResult) => r.pollUrl ?? "" },
        { header: "pollOutcome", accessor: (r: RowResult) => r.pollOutcome ?? "" },
        { header: "pollAttempts", accessor: (r: RowResult) => r.pollAttempts ?? "" },
        { header: "error", accessor: (r: RowResult) => r.error ?? r.pollError ?? "" },
        { header: "startedAt", accessor: (r: RowResult) => r.startedAt ?? "" },
        { header: "finishedAt", accessor: (r: RowResult) => r.finishedAt ?? "" },
        { header: "durationMs", accessor: (r: RowResult) => r.durationMs ?? "" },
      ] as const,
    [opKind],
  );

  /** Per-row collapsed-detail toggle so the result list stays scannable. */
  const [expandedRows, setExpandedRows] = React.useState<Set<string>>(
    new Set(),
  );
  const toggleExpanded = React.useCallback((rowKey: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  /** Top-of-card keyboard shortcuts:
   *   - "/" focuses the search box
   *   - Esc aborts an in-flight batch
   *   - Ctrl+A on the search box selects all visible
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          (target as HTMLElement).isContentEditable);
      // Skip "/" handling when typing in a field so the operator can still
      // search for literal slashes.
      if (e.key === "/" && !isEditable) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === "Escape" && running) {
        e.preventDefault();
        abortBatch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, abortBatch]);

  // Global tenant-switch listener — when the operator flips tenants from
  // anywhere in the app (header switcher, etc.), pivot the SOURCE account
  // picker here to match. We deliberately only sync the source account
  // (the natural pivot for "I just switched tenants, show me that EA");
  // billing-account / destination-EA / destination-tenant state stays put
  // so the operator doesn't lose a half-configured batch plan.
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!candidates.some((a) => a.homeAccountId === candidate)) return;
    if (accountId === candidate) return;
    setAccountId(candidate);
  });

  /* ----- Render --------------------------------------------------- */

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Subscription Mover"
          description="Bulk-transfer EA billing ownership or change the home tenant of subscriptions."
        />
        <SignInRequired
          whatYouCantDo="Move subscriptions"
          why="an EA-billing-capable account with owner access on the source enrollment account"
          onNavigate={(k: PageKey) => navigate(`/${k}`)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader
          title="Subscription Mover"
          description="Bulk-transfer EA billing ownership between enrollment accounts, OR change the home tenant of one or more subscriptions."
        />
        {/* Token freshness badge — quiet by default, surfaces when
            < 10 min from expiry. Click to force-refresh BEFORE
            kicking off a long sequential batch so the token doesn't
            flip mid-loop and the audit log doesn't get a string of
            spurious 401 failure rows. */}
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

      {tokenError && (
        <Alert variant="destructive">
          <AlertDescription>ARM token error: {tokenError}</AlertDescription>
        </Alert>
      )}

      {/* ----- Scope picker ----------------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Crown className="h-4 w-4 text-primary" />
            Scope
          </CardTitle>
          <CardDescription>
            Pick the signed-in EA-billing account and the billing account
            whose subscriptions you want to move.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <Label className="text-xs">Billing account</Label>
            {baLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading…
              </p>
            ) : baError ? (
              <ErrorState
                size="compact"
                message="Failed to load billing accounts."
                detail={baError}
              />
            ) : billingAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No EA billing accounts visible.
              </p>
            ) : (
              <Select
                value={billingAccountName}
                onValueChange={setBillingAccountName}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a billing account" />
                </SelectTrigger>
                <SelectContent>
                  {billingAccounts.map((b) => (
                    <SelectItem key={b.name} value={b.name}>
                      <span className="flex flex-col">
                        <span className="text-sm">{b.displayName}</span>
                        <span className="font-mono text-2xs text-muted-foreground">
                          {b.name} · {b.agreementType}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      {!billingAccountName ? (
        <EmptyState
          icon={Building2}
          title="Pick a billing account"
          description="Once selected, every subscription billed under that account appears below."
        />
      ) : (
        <>
          {/* ----- Subscriptions multi-select ---------------------- */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <Server className="h-4 w-4 text-primary" />
                Subscriptions under this billing account
                <Badge variant="secondary" className="text-2xs">
                  {selected.size}/{subscriptions.length} selected
                </Badge>
                {filtered.length !== subscriptions.length && (
                  <Badge variant="outline" className="text-2xs">
                    {filtered.length} visible
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                Tick the rows to include in the next bulk action. Search
                works on display name, sub id, billing-sub name, and status.
                Press <kbd className="rounded border border-border bg-muted/40 px-1 text-2xs font-mono">/</kbd> to jump to the search box.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[220px]">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    ref={searchInputRef}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search display name / sub id / status…  (press / to focus)"
                    className="pl-8 text-xs"
                    aria-label="Search subscriptions"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={selectAllVisible}
                  disabled={filtered.length === 0}
                  aria-label="Add all visible subscriptions to the selection"
                >
                  Select visible
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={clearSelection}
                  disabled={selected.size === 0}
                  aria-label="Clear selection"
                >
                  Clear
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void copySelectedIds()}
                  disabled={selected.size === 0}
                  aria-label="Copy every selected subscription id to the clipboard"
                >
                  <Copy className="h-3 w-3" aria-hidden />
                  Copy IDs
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={reload}
                  disabled={subsLoading}
                  aria-label="Refresh subscriptions list"
                >
                  <RefreshCw
                    className={
                      "h-3 w-3 motion-reduce:animate-none " + (subsLoading ? "animate-spin" : "")
                    }
                    aria-hidden
                  />
                  Refresh
                </Button>
              </div>
              {/* Quick-filter chips — All / Enabled / Disabled / Cross-tenant ready */}
              <div
                className="flex flex-wrap items-center gap-1"
                role="radiogroup"
                aria-label="Filter subscriptions"
              >
                {(
                  [
                    { id: "all", label: "All", count: subscriptions.length },
                    {
                      id: "enabled",
                      label: "Enabled",
                      count: subStateCounts.enabled,
                    },
                    {
                      id: "disabled",
                      label: "Disabled",
                      count: subStateCounts.disabled,
                    },
                    {
                      id: "cross-tenant-ready",
                      label: "Cross-tenant ready",
                      count: subStateCounts.crossTenantReady,
                    },
                  ] as ReadonlyArray<{
                    id: QuickFilter;
                    label: string;
                    count: number;
                  }>
                ).map((chip) => (
                  <Button
                    key={chip.id}
                    type="button"
                    role="radio"
                    aria-checked={quickFilter === chip.id}
                    size="sm"
                    variant={quickFilter === chip.id ? "default" : "ghost"}
                    className="h-6 gap-1 text-2xs"
                    onClick={() => setQuickFilter(chip.id)}
                  >
                    {chip.label}
                    <Badge variant="outline" className="text-3xs">
                      {chip.count}
                    </Badge>
                  </Button>
                ))}
              </div>
              {subsLoading ? (
                <SkeletonLoader variant="list" rows={5} />
              ) : subsError ? (
                <ErrorState
                  size="compact"
                  message="Failed to load subscriptions."
                  detail={subsError}
                  onRetry={reload}
                />
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Server}
                  title={
                    subscriptions.length === 0
                      ? "No subscriptions billed under this account"
                      : "No subscriptions match the filter"
                  }
                  description={
                    subscriptions.length === 0
                      ? "Check that the EA billing account holds the subscriptions you expected, or refresh."
                      : "Adjust the search box or pick a different quick-filter chip."
                  }
                />
              ) : (
                <ul className="flex flex-col gap-1">
                  {filtered.map((s) => {
                    const status = (s.status ?? "").toLowerCase();
                    const isUnsafe =
                      (status && status !== "enabled") ||
                      (opKind === "change-tenant" && !s.subscriptionId);
                    return (
                      <li
                        key={s.id}
                        className={
                          "flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs " +
                          (selected.has(s.name)
                            ? "border-primary/40 bg-primary/5"
                            : "border-border")
                        }
                      >
                        <Checkbox
                          aria-label={`Select ${s.displayName}`}
                          checked={selected.has(s.name)}
                          onCheckedChange={() => toggle(s.name)}
                          disabled={running}
                        />
                        <Server className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        <span className="font-medium">{s.displayName}</span>
                        {s.subscriptionId && (
                          <CopyableText
                            value={s.subscriptionId}
                            mono
                            className="text-muted-foreground"
                            ariaLabel={`Copy subscription id ${s.subscriptionId}`}
                          />
                        )}
                        {s.status && (
                          <Badge
                            variant={status === "enabled" ? "outline" : "secondary"}
                            className="text-2xs"
                          >
                            {s.status}
                          </Badge>
                        )}
                        {isUnsafe && (
                          <InfoTooltip
                            side="top"
                            variant="info"
                            ariaLabel="Why this row may be skipped"
                            content={
                              opKind === "change-tenant" && !s.subscriptionId
                                ? "Cross-tenant moves require an AAD subscriptionId. This row will be skipped (or rejected by Azure)."
                                : "Subscription is not in the Enabled state. Azure typically rejects move/changeTenant on Disabled/Warned/Expired/Deleted subs."
                            }
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ----- Action panel ----------------------------------- */}
          {selected.size > 0 && (
            <Card className="border-primary/40">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  Bulk action — {selectedSubs.length} subscription
                  {selectedSubs.length === 1 ? "" : "s"} selected
                  {skipUnsafe && selectedSubs.length !== rowsToRun.length && (
                    <Badge variant="secondary" className="text-2xs">
                      {rowsToRun.length} will run
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  Pick one operation to apply to the whole selection. Each
                  row is async on Azure's side (1–5 min); the page can
                  optionally poll the Azure-AsyncOperation URL until each
                  row terminates.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div
                  role="radiogroup"
                  aria-label="Operation"
                  className="inline-flex flex-wrap items-center rounded-md border border-border bg-background p-0.5"
                >
                  <Button
                    type="button"
                    role="radio"
                    aria-checked={opKind === "transfer-billing"}
                    size="sm"
                    variant={opKind === "transfer-billing" ? "default" : "ghost"}
                    className="h-7 text-xs"
                    onClick={() => setOpKind("transfer-billing")}
                  >
                    <FolderTree className="h-3.5 w-3.5" aria-hidden />
                    Transfer billing ownership
                  </Button>
                  <InfoTooltip
                    side="top"
                    ariaLabel="About transferring billing ownership"
                    className="mx-1"
                    content={
                      <span>
                        <strong>Transfer billing ownership</strong> reassigns the
                        subscription to another enrollment account inside the same
                        EA billing account. The home tenant does not change — only
                        who pays for it. Calls the ARM endpoint
                        <code className="ml-1 font-mono">
                          POST /billingSubscriptions/&#123;name&#125;/move
                        </code>
                        and is async on Azure's side (1–5 min).
                      </span>
                    }
                  />
                  <Button
                    type="button"
                    role="radio"
                    aria-checked={opKind === "change-tenant"}
                    size="sm"
                    variant={opKind === "change-tenant" ? "default" : "ghost"}
                    className="h-7 text-xs"
                    onClick={() => setOpKind("change-tenant")}
                  >
                    <Layers className="h-3.5 w-3.5" aria-hidden />
                    Change tenant (directory)
                  </Button>
                  <InfoTooltip
                    side="top"
                    ariaLabel="About changing the home tenant"
                    className="mx-1"
                    content={
                      <span>
                        <strong>Change tenant</strong> moves the subscription's home
                        AAD tenant. Billing ownership is preserved. The source
                        tenant's policy may require an admin in the destination
                        tenant to <em>accept</em> the offer before the subscription
                        appears there. Calls
                        <code className="ml-1 font-mono">
                          POST /subscriptions/&#123;id&#125;/changeTenant
                        </code>
                        (api-version 2021-10-01).
                      </span>
                    }
                  />
                </div>

                {opKind === "transfer-billing" && (
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs">
                      Destination enrollment account
                    </Label>
                    {eaLoading ? (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> loading
                      </p>
                    ) : eaError ? (
                      <ErrorState
                        size="compact"
                        message="Failed to load enrollment accounts."
                        detail={eaError}
                      />
                    ) : enrollmentAccounts.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No enrollment accounts visible.
                      </p>
                    ) : (
                      <Select
                        value={destEnrollmentArmId}
                        onValueChange={setDestEnrollmentArmId}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Pick an enrollment account" />
                        </SelectTrigger>
                        <SelectContent>
                          {enrollmentAccounts.map((ea) => (
                            <SelectItem key={ea.id} value={ea.id}>
                              <span className="flex flex-col">
                                <span className="text-sm">
                                  {ea.displayName}
                                </span>
                                <span className="font-mono text-2xs text-muted-foreground">
                                  {ea.name}
                                  {ea.accountOwner
                                    ? ` · ${ea.accountOwner}`
                                    : ""}
                                </span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {destEnrollmentArmId && (
                      <CopyableText
                        value={destEnrollmentArmId}
                        mono
                        alwaysVisibleButton
                        className="rounded border border-border bg-muted/30 px-2 py-1"
                        ariaLabel={`Copy enrollment ARM id ${destEnrollmentArmId}`}
                      />
                    )}
                    <p className="text-2xs text-muted-foreground">
                      POST /billingSubscriptions/&#123;name&#125;/move with{" "}
                      <code className="font-mono">
                        destinationEnrollmentAccountId
                      </code>
                      .
                    </p>
                  </div>
                )}

                {opKind === "change-tenant" && (
                  <div className="flex flex-col gap-3">
                    {account?.tenantId && (
                      <div className="flex flex-col gap-1">
                        <Label className="flex items-center gap-1 text-xs">
                          Source tenant
                          <InfoTooltip
                            side="top"
                            ariaLabel="About the source tenant"
                            content="The current home tenant of the selected subscriptions. The ARM token used for the changeTenant POST is minted against this tenant."
                          />
                        </Label>
                        <CopyableText
                          value={account.tenantId}
                          mono
                          ariaLabel={`Copy source tenant id ${account.tenantId}`}
                          alwaysVisibleButton
                          className="rounded-md border border-border bg-muted/30 px-2 py-1"
                        />
                      </div>
                    )}
                    <div className="flex flex-col gap-1.5">
                      <Label
                        htmlFor="sub-mover-dest-tenant"
                        className="flex items-center gap-1 text-xs"
                      >
                        Destination tenant ID
                        <InfoTooltip
                          side="top"
                          ariaLabel="About the destination tenant"
                          content="AAD tenant GUID that should become the new home tenant. An admin in this tenant may need to accept the offer before Azure surfaces the subscription."
                        />
                      </Label>
                      <Input
                        id="sub-mover-dest-tenant"
                        value={destTenantId}
                        onChange={(e) => setDestTenantId(e.target.value)}
                        placeholder="11111111-2222-3333-4444-555555555555"
                        className="font-mono text-xs"
                        aria-label="Destination tenant ID"
                        aria-invalid={
                          destTenantId.length > 0 &&
                          !UUID_RE.test(destTenantId.trim())
                            ? true
                            : undefined
                        }
                      />
                      <p className="text-2xs text-muted-foreground">
                        POST{" "}
                        <code className="font-mono">
                          /subscriptions/&#123;id&#125;/changeTenant
                        </code>{" "}
                        (api-version 2021-10-01). Source tenant policy may
                        require an admin in the destination tenant to
                        accept the offer before the sub appears there.
                      </p>
                    </div>
                  </div>
                )}

                {/* Runner options — concurrency + polling + auto-skip. */}
                <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/20 p-2">
                  <div className="flex flex-col gap-1">
                    <Label
                      htmlFor="sub-mover-concurrency"
                      className="flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground"
                    >
                      Parallelism
                      <InfoTooltip
                        side="top"
                        ariaLabel="About parallelism"
                        content="How many rows run at the same time. 1 = strictly sequential (one audit-log row at a time). Higher values finish faster but interleave the audit log."
                      />
                    </Label>
                    <Select
                      value={String(concurrency)}
                      onValueChange={(v) =>
                        setConcurrency(Number(v) as Concurrency)
                      }
                    >
                      <SelectTrigger
                        id="sub-mover-concurrency"
                        className="h-8 w-[110px] text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CONCURRENCY_CHOICES.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n === 1 ? "1 (sequential)" : `${n} parallel`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={pollLros}
                      onCheckedChange={(v) => setPollLros(v === true)}
                      disabled={running}
                      aria-label="Poll Azure async-operation until complete"
                    />
                    <span className="flex items-center gap-1">
                      Poll until done
                      <InfoTooltip
                        side="top"
                        ariaLabel="About async-operation polling"
                        content="After Azure accepts each row (202), poll the Azure-AsyncOperation URL until the LRO reaches Succeeded / Failed / Canceled. With this off, the row is marked accepted as soon as the POST returns."
                      />
                    </span>
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={skipUnsafe}
                      onCheckedChange={(v) => setSkipUnsafe(v === true)}
                      disabled={running}
                      aria-label="Auto-skip rows flagged as unsafe"
                    />
                    <span className="flex items-center gap-1">
                      Auto-skip unsafe rows
                      <InfoTooltip
                        side="top"
                        ariaLabel="About auto-skip"
                        content="Skip rows that are not in the Enabled state, have no subscriptionId (for change-tenant), or already appear to be on the destination enrollment account. Recommended."
                      />
                    </span>
                  </label>
                </div>

                {planWarnings.length > 0 && (
                  <Alert variant="destructive" className="border-warning/40 bg-warning/10">
                    <AlertTriangle className="h-4 w-4" aria-hidden />
                    <AlertDescription>
                      <ul className="list-inside list-disc text-xs">
                        {planWarnings.map((w, idx) => (
                          <li key={idx}>{w}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                {skipUnsafe && rowsToRun.length === 0 && selectedSubs.length > 0 && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" aria-hidden />
                    <AlertDescription>
                      Every selected row was flagged as unsafe and would be
                      skipped. Either fix the destination/source mismatch or
                      uncheck <em>Auto-skip unsafe rows</em> to force the
                      batch anyway.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => setConfirmOpen(true)}
                    disabled={!planValid || running}
                    loading={running}
                    aria-label={
                      opKind === "transfer-billing"
                        ? `Transfer billing ownership of ${rowsToRun.length} subscriptions`
                        : `Change home tenant on ${rowsToRun.length} subscriptions`
                    }
                  >
                    {!running && <ArrowRight aria-hidden />}
                    {running
                      ? "Running…"
                      : opKind === "transfer-billing"
                        ? `Transfer ${rowsToRun.length} sub${rowsToRun.length === 1 ? "" : "s"}`
                        : `Change tenant on ${rowsToRun.length} sub${rowsToRun.length === 1 ? "" : "s"}`}
                  </Button>
                  {running && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={abortBatch}
                      aria-label="Abort remaining rows in this batch (Esc)"
                    >
                      <Octagon className="h-3.5 w-3.5" aria-hidden />
                      Abort (Esc)
                    </Button>
                  )}
                  {running && batchElapsedMs > 0 && (
                    <span className="ml-1 inline-flex items-center gap-1 rounded-md bg-muted/40 px-2 py-1 text-2xs text-muted-foreground">
                      <Hourglass className="h-3 w-3" aria-hidden />
                      Elapsed {fmtDuration(batchElapsedMs)}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ----- Per-row results --------------------------------- */}
          {results.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <CardTitle className="text-sm">Operation results</CardTitle>
                    <CardDescription>
                      Each row is one ARM accept call (and, when polling is
                      on, the matching Azure-AsyncOperation poll). Failed
                      rows can be retried in place; everything is captured
                      in the audit log.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {resultStats.failed > 0 && !running && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={rerunFailed}
                        aria-label={`Rerun ${resultStats.failed} failed rows`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                        Rerun {resultStats.failed} failed
                      </Button>
                    )}
                    {!running && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={clearResults}
                        aria-label="Clear the results list"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        Clear
                      </Button>
                    )}
                    <ExportMenu
                      rows={results}
                      columns={exportColumns}
                      filename="sub-mover-results"
                      jsonMetadata={{
                        billingAccountName,
                        operation: opKind,
                        destination:
                          opKind === "transfer-billing"
                            ? destEnrollmentArmId.trim()
                            : destTenantId.trim(),
                        sourceTenantId: account?.tenantId,
                        actor: account?.username ?? accountId,
                        concurrency,
                        polledLros: pollLros,
                      }}
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Bulk operation summary"
                >
                  <SummaryStatItem
                    label="Total queued"
                    value={results.length}
                    compact
                  />
                  <SummaryStatItem
                    label="In flight"
                    value={
                      resultStats.runningCount +
                      resultStats.queued +
                      resultStats.pollingCount
                    }
                    tone="info"
                    compact
                    hint={
                      resultStats.pollingCount > 0
                        ? `${resultStats.pollingCount} polling`
                        : resultStats.queued > 0
                          ? `${resultStats.queued} pending`
                          : undefined
                    }
                  />
                  <SummaryStatItem
                    label="Success"
                    value={resultStats.success}
                    tone="success"
                    compact
                  />
                  <SummaryStatItem
                    label="Failed"
                    value={resultStats.failed}
                    tone="destructive"
                    compact
                  />
                  {resultStats.cancelled > 0 && (
                    <SummaryStatItem
                      label="Cancelled"
                      value={resultStats.cancelled}
                      tone="warning"
                      compact
                    />
                  )}
                  {resultStats.completedDurations > 0 && (
                    <SummaryStatItem
                      label="Avg time / row"
                      value={fmtDuration(resultStats.avgMs)}
                      compact
                      hint={`${resultStats.completedDurations} completed`}
                    />
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {results.map((r) => {
                    const expanded = expandedRows.has(r.rowKey);
                    return (
                      <div
                        key={r.rowKey}
                        className={
                          "flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs " +
                          (r.state === "failure"
                            ? "border-destructive/40 bg-destructive/5"
                            : r.state === "success"
                              ? "border-success/30"
                              : "border-border")
                        }
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(r.rowKey)}
                            aria-expanded={expanded}
                            aria-label={
                              expanded ? "Collapse row details" : "Expand row details"
                            }
                            className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                          >
                            {expanded ? (
                              <ChevronDown className="h-3 w-3" aria-hidden />
                            ) : (
                              <ChevronRight className="h-3 w-3" aria-hidden />
                            )}
                          </button>
                          <Server
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="font-medium">{r.displayName}</span>
                          <CopyableText
                            value={r.subscriptionId}
                            mono
                            className="text-muted-foreground"
                            ariaLabel={`Copy subscription id ${r.subscriptionId}`}
                          />
                          {r.state === "pending" && (
                            <Badge variant="outline" className="gap-1 text-2xs">
                              pending
                            </Badge>
                          )}
                          {r.state === "running" && (
                            <Badge variant="secondary" className="gap-1 text-2xs">
                              <Loader2
                                className="h-3 w-3 animate-spin motion-reduce:animate-none"
                                aria-hidden
                              />{" "}
                              running
                            </Badge>
                          )}
                          {r.state === "polling" && (
                            <Badge variant="secondary" className="gap-1 text-2xs">
                              <Hourglass className="h-3 w-3 animate-pulse motion-reduce:animate-none" aria-hidden />
                              polling
                              {r.pollAttempts ? ` (#${r.pollAttempts})` : ""}
                            </Badge>
                          )}
                          {r.state === "success" && (
                            <Badge variant="success" className="gap-1 text-2xs">
                              <CheckCircle2 className="h-3 w-3" aria-hidden />
                              {r.pollOutcome === "Succeeded"
                                ? "succeeded"
                                : "accepted"}
                            </Badge>
                          )}
                          {r.state === "failure" && (
                            <Badge variant="destructive" className="gap-1 text-2xs">
                              <X className="h-3 w-3" aria-hidden /> failed
                            </Badge>
                          )}
                          {r.state === "cancelled" && (
                            <Badge variant="outline" className="gap-1 text-2xs">
                              <Octagon className="h-3 w-3" aria-hidden /> cancelled
                            </Badge>
                          )}
                          {r.status ? (
                            <span className="text-2xs text-muted-foreground">
                              HTTP {r.status}
                            </span>
                          ) : null}
                          {r.durationMs != null && (
                            <span className="text-2xs text-muted-foreground">
                              · {fmtDuration(r.durationMs)}
                            </span>
                          )}
                        </div>
                        {r.error && (
                          <p className="break-words pl-7 text-2xs text-destructive">
                            {r.error}
                          </p>
                        )}
                        {expanded && (
                          <div className="flex flex-col gap-1 pl-7 text-2xs">
                            {r.destination && (
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="text-muted-foreground">
                                  destination:
                                </span>
                                <CopyableText
                                  value={r.destination}
                                  mono
                                  alwaysVisibleButton
                                  ariaLabel="Copy destination identifier"
                                />
                              </div>
                            )}
                            {r.pollUrl && (
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="text-muted-foreground">
                                  poll URL:
                                </span>
                                <CopyableText
                                  value={r.pollUrl}
                                  mono
                                  alwaysVisibleButton
                                  ariaLabel="Copy Azure async-operation URL"
                                />
                              </div>
                            )}
                            {r.startedAt && (
                              <div>
                                <span className="text-muted-foreground">
                                  started:
                                </span>{" "}
                                <span className="font-mono">{r.startedAt}</span>
                              </div>
                            )}
                            {r.finishedAt && (
                              <div>
                                <span className="text-muted-foreground">
                                  finished:
                                </span>{" "}
                                <span className="font-mono">{r.finishedAt}</span>
                              </div>
                            )}
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => void copyToClipboard(buildCurl(r, account?.tenantId))}
                                aria-label="Copy cURL command for replay"
                              >
                                <Copy className="h-3 w-3" aria-hidden />
                                Copy as cURL
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
      {/* Replaces native window.confirm for the bulk move action. The
          message is a multi-line string with the skip/poll notes so the
          operator sees the exact contract before hitting Confirm. */}
      <ConfirmationDialog
        hidden={!confirmOpen}
        title={
          opKind === "transfer-billing"
            ? "Transfer billing ownership"
            : "Change subscription tenant"
        }
        message={
          <div className="flex flex-col gap-2 text-xs">
            {confirmMessage.split("\n\n").map((para, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {para}
              </p>
            ))}
            {rowsToRun.length > 0 && rowsToRun.length <= 10 && (
              <details className="rounded border border-border bg-muted/20 p-2 text-2xs">
                <summary className="cursor-pointer font-medium text-muted-foreground">
                  Show {rowsToRun.length} target subscription
                  {rowsToRun.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5 pl-3">
                  {rowsToRun.map((s) => (
                    <li key={s.id} className="font-mono">
                      {s.displayName}
                      {s.subscriptionId ? ` — ${s.subscriptionId}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {rowsToRun.length > 10 && (
              <p className="text-2xs text-muted-foreground">
                ({rowsToRun.length} subscriptions selected — list omitted
                for brevity, see the result panel after confirming.)
              </p>
            )}
          </div>
        }
        confirmText={
          opKind === "transfer-billing" ? "Transfer" : "Change tenant"
        }
        danger
        loading={running}
        onConfirm={() => runBatch()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};
