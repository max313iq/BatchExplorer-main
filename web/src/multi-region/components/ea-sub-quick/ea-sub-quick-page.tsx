/**
 * EA Sub Quick Creator — minimal one-shot mirror of the PowerShell
 * snippet at
 *   https://learn.microsoft.com/azure/cost-management-billing/manage/
 *     programmatically-create-subscription-enterprise-agreement
 *
 * Steps (all via the existing arm-service helpers):
 *   1. Pick source account.
 *   2. List billing accounts            (GET /billingAccounts).
 *   3. List enrollment accounts under   (GET /billingAccounts/{ba}/enrollmentAccounts).
 *   4. Build billingScope =
 *        /providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea}
 *   5. PUT /providers/Microsoft.Subscription/aliases/{aliasName}
 *      with { displayName, billingScope, workload } + optional
 *      cross-tenant owner / tags.
 *   6. Poll the alias URL until provisioningState reaches a terminal
 *      state (Succeeded / Failed) and surface the resulting
 *      subscriptionId.
 *
 * Different from the existing EA Subscription page: NO multi-recipient
 * batching, NO complex recipient picker, NO MCA path — just one
 * subscription, the modern alias API, and the polling loop. Matches the
 * PowerShell script you pasted line-for-line.
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Building2,
  Check,
  CheckCircle2,
  Crown,
  ExternalLink,
  Eye,
  EyeOff,
  History,
  Info,
  Keyboard,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  XCircle,
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
import { Checkbox } from "@/components/ui/checkbox";

import {
  decodeJwtClaimsUnsafe,
  getActiveTenant,
  getArmTokenForAccount,
  loginAccount,
} from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { auditLog } from "../../services/audit-log";
import {
  ROLE_EA_SUBSCRIPTION_CREATOR,
  createEaSubscription,
  createEnrollmentAccountRoleAssignment,
  listAllBillingAccountsAnyAgreementType,
  listEnrollmentAccounts,
} from "../../services";
import type {
  EaBillingAccount,
  EaEnrollmentAccount,
} from "../../services";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut, modKeyLabel } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
// COORDINATOR: prefer `useDashboardOutletContext().navigateToPage` over the
// legacy `onNavigate` prop. The route adapter in page-router still passes the
// legacy prop; we accept it for backward-compat but resolve to the context
// value when mounted inside the router (the normal case).
import { useDashboardOutletContext } from "../page-router";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu, type ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { SummaryStatItem } from "../shared/summary-stat-item";

const STORAGE_ACCOUNT = "ea-sub-quick:account";
const STORAGE_BA = "ea-sub-quick:billing-account";
const STORAGE_EA = "ea-sub-quick:enrollment-account";
const STORAGE_PRESETS = "ea-sub-quick:display-name-presets";
/**
 * Persists the last few SUCCESSFUL submissions (alias name, scope, workload,
 * displayName template) so a returning operator can one-click rehydrate the
 * form to a configuration they've used before. Stored under localStorage so
 * it survives a full browser reload — distinct from the in-memory session
 * history (which is cleared on unmount and capped at HISTORY_MAX_ROWS).
 *
 * Capped at RECENT_PRESETS_MAX rows. We do NOT persist subscription IDs or
 * cross-tenant owner/tenant ids here: those are operator-identifying and the
 * audit log already keeps the canonical record. Only the recipe is stored.
 */
const STORAGE_RECENT_CONFIGS = "ea-sub-quick:recent-configs";
const RECENT_PRESETS_MAX = 5;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Default preset library — used when the operator has no saved presets
 * yet. Picked to cover the three most common naming conventions we see:
 * date-stamped team subs, indexed batch creation, and user-stamped
 * personal sandboxes. They don't get persisted automatically — operator
 * has to click "Save preset" on the one they actually want.
 */
const DEFAULT_PRESET_LIBRARY = [
  "Team Workspace {date}",
  "Sandbox {user} {date}",
  "Batch {date}-{counter}",
];

/**
 * Maximum number of submitted-aliases rows kept in the session history.
 * Older rows fall off the bottom so the page doesn't grow unbounded
 * during long batch sessions. The audit log keeps the canonical record.
 */
const HISTORY_MAX_ROWS = 50;

/**
 * Submit takes more than this many milliseconds to receive its first
 * response → assume Azure returned 202 and is now polling, and surface
 * a "still provisioning" hint so the operator doesn't think the UI is
 * frozen. Documented in MS docs as up to several minutes for an EA sub.
 */
const POLL_PULSE_AFTER_MS = 6_000;

interface SourceAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

/**
 * One row in the in-memory submitted-aliases history. Persisted only for the
 * current page session — we don't write it to storage because the server-side
 * audit log already records the same events, and persistence would mean
 * exporting old-and-stale rows across sessions.
 */
interface SubmittedAlias {
  aliasName: string;
  displayName: string;
  billingScope: string;
  workload: string;
  subscriptionId?: string;
  provisioningState: string;
  submittedAt: string; // ISO timestamp
  durationMs: number;
  /** Best-effort flag: did the API answer asynchronously (slow path)? */
  polled: boolean;
  /** Cross-tenant landing requested? */
  crossTenant: boolean;
}

/**
 * A "recent configuration" persisted across reloads. Holds only the
 * non-PII recipe (displayName template, billing scope identifiers,
 * workload). Recovered on mount and surfaced as one-click chips so a
 * returning operator can rehydrate the form to a configuration they
 * already used. Capped at RECENT_PRESETS_MAX entries.
 */
interface RecentConfig {
  /** Identity. Constructed from scope + workload + displayName so the same
   *  recipe doesn't accumulate duplicate rows.                            */
  key: string;
  displayNameTemplate: string;
  workload: "Production" | "DevTest";
  billingAccountName: string;
  enrollmentAccountName: string;
  /** True when the operator submitted via the custom-scope override.     */
  customScopeMode: boolean;
  /** ISO timestamp; used for sort + "used X ago" display.                */
  lastUsedAt: string;
}

/** Random alias name matching the PowerShell `"ea-sub-" + Get-Random` pattern. */
function generateAliasName(): string {
  // 9-digit suffix similar in cardinality to PowerShell's Get-Random.
  const rand = Math.floor(Math.random() * 1_000_000_000).toString();
  return `ea-sub-${rand}`;
}

/**
 * Token substitution for displayName presets. Supports:
 *   {date}     -> YYYY-MM-DD
 *   {time}     -> HH-MM
 *   {counter}  -> caller-supplied 1-based index (zero-padded to 3)
 *   {user}     -> short username left of @ (best effort)
 */
function applyDisplayNameTokens(
  template: string,
  ctx: { counter: number; username?: string },
): string {
  if (!template) return template;
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time =
    `${now.getHours().toString().padStart(2, "0")}-` +
    `${now.getMinutes().toString().padStart(2, "0")}`;
  const counter = ctx.counter.toString().padStart(3, "0");
  const user = (ctx.username ?? "").split("@")[0] ?? "";
  return template
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .replaceAll("{counter}", counter)
    .replaceAll("{user}", user);
}

/**
 * Migration helper for `usePersistedState`. Accepts the legacy bare-array
 * value (pre-versioning) or the modern envelope; coerces to `string[]`.
 * Anything malformed → empty array (caller falls back to initial value).
 */
function migratePresets(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return [];
  const arr = raw.filter((p): p is string => typeof p === "string");
  return arr;
}

/** Stable identity for a RecentConfig — same scope + workload + template = same row. */
function recentConfigKey(c: Omit<RecentConfig, "key" | "lastUsedAt">): string {
  return [
    c.billingAccountName,
    c.enrollmentAccountName,
    c.workload,
    c.customScopeMode ? "custom" : "picker",
    c.displayNameTemplate,
  ].join("|");
}

/**
 * Builds a curl-formatted reproduction of the alias-create call so an
 * operator can paste it into a terminal for diff-debugging or sharing
 * with another admin. Token is intentionally NOT included; the {TOKEN}
 * placeholder makes that obvious.
 */
function buildCurlSnippet(args: {
  aliasName: string;
  displayName: string;
  billingScope: string;
  workload: string;
  subscriptionTenantId?: string;
  subscriptionOwnerId?: string;
  tags?: Record<string, string>;
}): string {
  const additionalProperties: Record<string, unknown> = {};
  if (args.subscriptionTenantId)
    additionalProperties.subscriptionTenantId = args.subscriptionTenantId;
  if (args.subscriptionOwnerId)
    additionalProperties.subscriptionOwnerId = args.subscriptionOwnerId;
  if (args.tags && Object.keys(args.tags).length > 0)
    additionalProperties.tags = args.tags;
  const body = {
    properties: {
      displayName: args.displayName,
      billingScope: args.billingScope,
      workload: args.workload,
      ...(Object.keys(additionalProperties).length > 0
        ? { additionalProperties }
        : {}),
    },
  };
  const url =
    `https://management.azure.com/providers/Microsoft.Subscription/` +
    `aliases/${args.aliasName}?api-version=2021-10-01`;
  return (
    `curl -X PUT "${url}" \\\n` +
    `  -H "Authorization: Bearer {TOKEN}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '${JSON.stringify(body)}'`
  );
}

export interface EaSubQuickPageProps {
  /**
   * Cross-page navigation. Wired by the page-router so the
   * passthrough-token Alert can pivot to Azure Accounts / Token
   * Importer without the page needing to know the routing layer.
   * Optional so the page still renders if mounted in a sandbox /
   * Storybook / preview without a router.
   */
  onNavigate?: (k: string) => void;
}

export const EaSubQuickPage: React.FC<EaSubQuickPageProps> = ({
  onNavigate,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const navigate = useNavigate();
  // Prefer the outlet context's path-based navigateToPage over the legacy
  // `onNavigate(pageKey)` prop. The route adapter still passes onNavigate
  // for backward compat — accept it but resolve to context.navigateToPage
  // when mounted in the dashboard. `useOutletContext` returns undefined
  // outside an Outlet, so we tolerate it for sandbox / storybook mounts.
  const outletCtx = useDashboardOutletContext() as unknown as
    | { navigateToPage?: (path: string) => void }
    | undefined;
  const goTo = React.useCallback(
    (path: string) => {
      const normalized = path.startsWith("/") ? path : `/${path}`;
      if (outletCtx?.navigateToPage) {
        outletCtx.navigateToPage(normalized);
        return;
      }
      navigate(normalized);
    },
    [outletCtx, navigate],
  );
  const azureAccounts = state.azureAccounts ?? [];

  /* ----- Account picker ------------------------------------------ */
  const candidates: SourceAccount[] = React.useMemo(
    () =>
      azureAccounts
        .map((a) => ({
          homeAccountId: a.homeAccountId,
          tenantId: getActiveTenant(a.homeAccountId) ?? resolveActiveTenantId(a) ?? a.tenantId,
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

  /**
   * Central ARM-token tracker. Returns expiry + a force-refresh
   * handler. The actual `armToken` value still flows through the
   * existing `setArmToken` path below for backward compatibility —
   * this hook is wired in PARALLEL to give the page expiry-badge
   * info and tenant-switch auto-reacquire behavior without
   * refactoring the existing billing-account fetch logic.
   */
  const armTokenTracker = useArmToken(
    account?.homeAccountId,
    account?.tenantId,
  );

  /* ----- ARM token + diagnostics --------------------------------- */
  const [armToken, setArmToken] = React.useState<string | null>(null);
  /**
   * Decoded JWT claims of the current ARM token (diagnostic only,
   * never used for authorization). Kept in state so the UI can react
   * to a missing `oid` BEFORE the user clicks Create — i.e. show the
   * "no oid" remediation card the moment we acquire the token, not
   * after the alias-create call already burned a request and returned
   * a passthrough 401.
   */
  const [armTokenClaims, setArmTokenClaims] = React.useState<{
    oid: string;
    tid: string;
    upn: string;
    aud: string;
  } | null>(null);
  /**
   * True when the page already detected — via decoded JWT claims —
   * that the current ARM token has no `oid`. Drives a tailored Alert
   * that explains the missing-oid case and lists the actual fix
   * (sign in via the principal's HOME tenant) instead of the generic
   * "passthrough token" copy.
   *
   * Declared up-front (before the JWT-decode effect that flips it)
   * so the setter binding is fully realised at module-eval time —
   * defeats the TDZ trap that would otherwise bite anyone reading
   * the page out of order. (React effects run after all hooks have
   * been declared anyway, but the strict-mode lint and human-read
   * order both prefer this.)
   */
  const [noOidDetected, setNoOidDetected] = React.useState(false);
  /** Optional: temporarily reveal the raw ARM token for debugging. */
  const [showTokenDiagnostics, setShowTokenDiagnostics] =
    React.useState(false);

  // Bridge: whenever the central useArmToken tracker re-mints (initial
  // acquire, tenant switch, expiry auto-refresh, badge click), sync
  // the new token down to the page's existing `armToken` state so all
  // downstream consumers (billing accounts, enrollment accounts,
  // submit) immediately use it. The `!==` guard keeps this from
  // racing the existing fetch effect into an infinite loop.
  React.useEffect(() => {
    if (
      armTokenTracker.token &&
      armTokenTracker.token !== armToken
    ) {
      setArmToken(armTokenTracker.token);
    }
  }, [armTokenTracker.token, armToken]);

  const [billingAccounts, setBillingAccounts] = React.useState<
    EaBillingAccount[]
  >([]);
  const [baLoading, setBaLoading] = React.useState(false);
  const [baError, setBaError] = React.useState<string | null>(null);
  const [billingAccountName, setBaNameState] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_BA) ?? "";
    } catch {
      return "";
    }
  });
  const setBillingAccountName = React.useCallback((n: string) => {
    setBaNameState(n);
    try {
      sessionStorage.setItem(STORAGE_BA, n);
    } catch {
      /* ignore */
    }
  }, []);

  // Decode the ARM token claims as soon as we have one so the page
  // can warn about a missing `oid` BEFORE the operator submits.
  // Without this, the first sign the user has that the token is bad
  // is a 401 from the Subscription RP after the alias-create call.
  React.useEffect(() => {
    if (!armToken) {
      setArmTokenClaims(null);
      setNoOidDetected(false);
      return;
    }
    const claims = decodeJwtClaimsUnsafe(armToken);
    if (!claims) {
      setArmTokenClaims(null);
      setNoOidDetected(false);
      return;
    }
    const oid = String(claims.oid ?? "");
    setArmTokenClaims({
      oid,
      tid: String(claims.tid ?? ""),
      upn: String(
        claims.upn ??
          claims.preferred_username ??
          claims.unique_name ??
          "",
      ),
      aud: String(claims.aud ?? ""),
    });
    setNoOidDetected(!oid);
  }, [armToken]);

  // Billing-account fetch — migrated to useAbortableEffect so the per-render
  // AbortSignal supersedes the manual `cancelled` boolean. The underlying
  // arm-service helpers don't take a signal today, so we still gate state
  // writes on `signal.aborted` after each await; switching to a signal-aware
  // service surface would automatically thread cancellation downstream.
  // COORDINATOR: arm-service.listAllBillingAccountsAnyAgreementType doesn't
  // accept an AbortSignal — adding one would let this effect cancel the
  // outbound fetch (not just discard the result) and is worth a follow-up.
  useAbortableEffect(
    async (signal) => {
      if (!account) {
        setArmToken(null);
        setBillingAccounts([]);
        return;
      }
      setBaLoading(true);
      setBaError(null);
      const actor = account.username;
      try {
        // Tenant arg omitted so we pick up the operator's current active
        // tenant (was pinning to account.tenantId / the account's HOME
        // tenant — pre-switch).
        const tok = await getArmTokenForAccount(account.homeAccountId);
        if (signal.aborted) return;
        setArmToken(tok);
        const list = await listAllBillingAccountsAnyAgreementType(tok);
        if (signal.aborted) return;
        setBillingAccounts(list);
        // Audit: surface the list-call to the audit log so operators can
        // trace which accounts the page actually queried (mirrors the
        // create-alias audit row that lands further down).
        auditLog.record({
          actor,
          action: "list_billing_accounts",
          target: account.tenantId,
          status: "success",
          details: { count: list.length, page: "ea-sub-quick" },
        });
        if (list.length === 1 && billingAccountName !== list[0]!.name) {
          setBillingAccountName(list[0]!.name);
        } else if (
          billingAccountName &&
          !list.some((b) => b.name === billingAccountName)
        ) {
          setBillingAccountName("");
        }
      } catch (err) {
        if (signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setBaError(msg);
        setBillingAccounts([]);
        auditLog.record({
          actor,
          action: "list_billing_accounts",
          target: account.tenantId,
          status: "failure",
          error: msg,
          details: { page: "ea-sub-quick" },
        });
      } finally {
        if (!signal.aborted) setBaLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account?.homeAccountId, account?.tenantId],
  );

  /* ----- Enrollment accounts under chosen billing ---------------- */
  const [eas, setEas] = React.useState<EaEnrollmentAccount[]>([]);
  const [eaLoading, setEaLoading] = React.useState(false);
  const [eaError, setEaError] = React.useState<string | null>(null);
  const [enrollmentAccountName, setEaNameState] = React.useState<string>(
    () => {
      try {
        return sessionStorage.getItem(STORAGE_EA) ?? "";
      } catch {
        return "";
      }
    },
  );
  const setEnrollmentAccountName = React.useCallback((n: string) => {
    setEaNameState(n);
    try {
      sessionStorage.setItem(STORAGE_EA, n);
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * Selected billing-account row — exposes its agreementType so the
   * enrollment-accounts effect (and the billingScope computation
   * below) can branch on EA vs non-EA. Declared up-front to avoid the
   * temporal-dead-zone error the effect would otherwise hit.
   */
  const selectedBa = React.useMemo(
    () => billingAccounts.find((b) => b.name === billingAccountName) ?? null,
    [billingAccounts, billingAccountName],
  );
  const accountIsEnterpriseAgreement =
    (selectedBa?.agreementType ?? "").toLowerCase() === "enterpriseagreement";

  /**
   * Latest-cascade guard. Each cascade increments this ref; any in-flight
   * fetch checks the captured value against the live value before
   * setting state. This is stronger than the closed-over `cancelled`
   * boolean because rapid BA-flipping can spawn multiple parallel
   * fetches inside a single effect commit window — a sequence number
   * unambiguously picks the latest one.
   */
  const eaCascadeRef = React.useRef(0);

  // Enrollment-account fetch. useAbortableEffect provides the abort signal;
  // the eaCascadeRef sequence number still guards against rapid BA-flips
  // landing parallel fetches whose results out-order each other (signal
  // alone can't tell us "I'm the latest cascade", only "I'm not torn down").
  // COORDINATOR: arm-service.listEnrollmentAccounts also doesn't accept an
  // AbortSignal — pairs with the billing-account TODO above.
  useAbortableEffect(
    async (signal) => {
      if (!armToken || !billingAccountName) {
        setEas([]);
        return;
      }
      // Non-EA accounts don't have an enrollmentAccounts collection —
      // skip the listing call to avoid a 4xx and the noisy error banner.
      if (selectedBa && !accountIsEnterpriseAgreement) {
        setEas([]);
        setEaError(null);
        setEaLoading(false);
        return;
      }
      const mySeq = ++eaCascadeRef.current;
      setEaLoading(true);
      setEaError(null);
      const baForThisCall = billingAccountName;
      const actor = account?.username ?? "";
      const stillLatest = () =>
        !signal.aborted &&
        mySeq === eaCascadeRef.current &&
        baForThisCall === billingAccountName;
      try {
        const list = await listEnrollmentAccounts(baForThisCall, armToken);
        if (!stillLatest()) return;
        setEas(list);
        auditLog.record({
          actor,
          action: "list_enrollment_accounts",
          target: baForThisCall,
          status: "success",
          details: { count: list.length, page: "ea-sub-quick" },
        });
        if (list.length === 1 && enrollmentAccountName !== list[0]!.name) {
          setEnrollmentAccountName(list[0]!.name);
        } else if (
          enrollmentAccountName &&
          !list.some((e) => e.name === enrollmentAccountName)
        ) {
          setEnrollmentAccountName("");
        }
      } catch (err) {
        if (!stillLatest()) return;
        const msg = err instanceof Error ? err.message : String(err);
        setEaError(msg);
        auditLog.record({
          actor,
          action: "list_enrollment_accounts",
          target: baForThisCall,
          status: "failure",
          error: msg,
          details: { page: "ea-sub-quick" },
        });
      } finally {
        if (stillLatest()) setEaLoading(false);
      }
    },
    // We intentionally depend on `accountIsEnterpriseAgreement` (a
    // derived scalar) rather than `selectedBa` (a memo whose identity
    // changes whenever billingAccounts is replaced) so the effect
    // doesn't re-fire on stable cascade state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      armToken,
      billingAccountName,
      accountIsEnterpriseAgreement,
      account?.username,
    ],
  );

  const selectedEa = React.useMemo(
    () => eas.find((e) => e.name === enrollmentAccountName) ?? null,
    [eas, enrollmentAccountName],
  );

  /**
   * Custom billingScope mode. When the operator can't reach the right
   * billing account / enrollment account through the picker
   * (`hasReadAccess: false`, an EA account that lives parallel to the
   * MOSP row that IS visible, etc.) they paste either:
   *   - the EA billing-account NAME + enrollment-account NAME (and
   *     the page builds the canonical billingScope), or
   *   - a full pre-built billingScope ARM path.
   * Either works; the alias API only needs the resulting string.
   */
  const [customScopeMode, setCustomScopeMode] = React.useState(false);
  const [customBillingAccountName, setCustomBillingAccountName] =
    React.useState("");
  const [customEnrollmentAccountName, setCustomEnrollmentAccountName] =
    React.useState("");
  const [customFullScope, setCustomFullScope] = React.useState("");

  /**
   * Computed billingScope. Either the EA-style path with the
   * enrollment-account segment, or the billing-account-scope variant
   * for non-EA agreements (MOSP / MCA / MPA — those use billing
   * profiles / customers instead, but the alias API still accepts
   * the bare billing-account scope for legacy MOSP rows). Custom mode
   * overrides everything.
   */
  const billingScope = React.useMemo(() => {
    if (customScopeMode) {
      // Full pasted path wins; otherwise compose from the two segments
      // the operator typed.
      const full = customFullScope.trim();
      if (full.startsWith("/providers/Microsoft.Billing/billingAccounts/")) {
        return full;
      }
      const ba = customBillingAccountName.trim();
      const ea = customEnrollmentAccountName.trim();
      if (!ba) return "";
      if (!ea) {
        return `/providers/Microsoft.Billing/billingAccounts/${ba}`;
      }
      return `/providers/Microsoft.Billing/billingAccounts/${ba}/enrollmentAccounts/${ea}`;
    }
    if (!billingAccountName) return "";
    if (accountIsEnterpriseAgreement) {
      if (!enrollmentAccountName) return "";
      return `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}/enrollmentAccounts/${enrollmentAccountName}`;
    }
    return `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}`;
  }, [
    customScopeMode,
    customFullScope,
    customBillingAccountName,
    customEnrollmentAccountName,
    billingAccountName,
    enrollmentAccountName,
    accountIsEnterpriseAgreement,
  ]);

  /* ----- Subscription form --------------------------------------- */
  // URL-persisted form state. Keys: name (displayName template), wl
  // (workload), st (subscriptionTenantId), so (subscriptionOwnerId).
  // Replace mode (default) keeps history clean while typing. Short keys
  // chosen so a shared link doesn't bloat the URL bar.
  const [formUrl, setFormUrl] = useUrlState<{
    name: string;
    wl: string;
    st: string;
    so: string;
  }>({ name: "My EA Subscription", wl: "Production", st: "", so: "" });
  const displayName = formUrl.name;
  const setDisplayName = React.useCallback(
    (v: string) => setFormUrl({ name: v }),
    [setFormUrl],
  );
  const workload: "Production" | "DevTest" =
    formUrl.wl === "DevTest" ? "DevTest" : "Production";
  const setWorkload = React.useCallback(
    (v: "Production" | "DevTest") => setFormUrl({ wl: v }),
    [setFormUrl],
  );
  const subscriptionTenantId = formUrl.st;
  const setSubscriptionTenantId = React.useCallback(
    (v: string) => setFormUrl({ st: v }),
    [setFormUrl],
  );
  const subscriptionOwnerId = formUrl.so;
  const setSubscriptionOwnerId = React.useCallback(
    (v: string) => setFormUrl({ so: v }),
    [setFormUrl],
  );
  const [aliasName, setAliasName] = React.useState(() => generateAliasName());
  // Optional tag editor — each row is one key/value pair.
  const [tagPairs, setTagPairs] = React.useState<
    Array<{ key: string; value: string }>
  >([]);
  const addTagRow = () =>
    setTagPairs((prev) => [...prev, { key: "", value: "" }]);
  const setTagAt = (i: number, k: "key" | "value", v: string) =>
    setTagPairs((prev) =>
      prev.map((row, idx) => (idx === i ? { ...row, [k]: v } : row)),
    );
  const removeTagAt = (i: number) =>
    setTagPairs((prev) => prev.filter((_, idx) => idx !== i));

  const tagsForBody = React.useMemo<Record<string, string> | undefined>(() => {
    const out: Record<string, string> = {};
    for (const p of tagPairs) {
      if (p.key.trim()) out[p.key.trim()] = p.value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, [tagPairs]);

  // Cross-tenant rule: if subscriptionTenantId is set, subscriptionOwnerId
  // must also be set (and vice-versa is recommended).
  const crossTenantRequested =
    subscriptionTenantId.trim().length > 0 ||
    subscriptionOwnerId.trim().length > 0;
  const crossTenantValid =
    !subscriptionTenantId.trim() ||
    (UUID_RE.test(subscriptionTenantId.trim()) &&
      UUID_RE.test(subscriptionOwnerId.trim()));

  const [submitting, setSubmitting] = React.useState(false);
  /**
   * Wall-clock timestamp captured at submit start (ms since epoch).
   * Powers the elapsed-ms readout next to the spinner so the operator
   * has a visible "this is taking longer than usual" signal during the
   * 202 → poll path. Reset to null on completion / error.
   */
  const [submitStartedAtMs, setSubmitStartedAtMs] = React.useState<
    number | null
  >(null);
  const [submitElapsedMs, setSubmitElapsedMs] = React.useState(0);
  // Tick a counter every 500ms while a submit is in flight so the
  // elapsed-ms readout updates in real time without polling React.
  React.useEffect(() => {
    if (!submitting || submitStartedAtMs == null) {
      setSubmitElapsedMs(0);
      return;
    }
    const handle = window.setInterval(() => {
      setSubmitElapsedMs(Date.now() - submitStartedAtMs);
    }, 500);
    return () => {
      window.clearInterval(handle);
    };
  }, [submitting, submitStartedAtMs]);
  const showPollingPulse =
    submitting && submitElapsedMs > POLL_PULSE_AFTER_MS;

  const [submitError, setSubmitError] = React.useState<string | null>(null);
  /**
   * Tracks the AAD "not authorized to create subscriptions on this
   * enrollment account" failure so the UI can render an actionable
   * remediation card instead of the raw blob.
   */
  const [missingRole, setMissingRole] = React.useState(false);
  /**
   * Tracks the "passthrough token / Token validation failed" 401 — a
   * distinct failure mode where the ARM token reaches the
   * Microsoft.Subscription RP but lacks the right tenant context
   * (typically because we sent a token minted against a tenant that
   * doesn't host the EA enrollment, or an imported/portal token that
   * the RP rejects). The remediation is "re-acquire a fresh token
   * scoped to the correct tenant", not "grant the role".
   */
  const [passthroughToken, setPassthroughToken] = React.useState(false);
  /** True while a forced ARM-token re-acquire is in flight. */
  const [reacquiring, setReacquiring] = React.useState(false);

  /**
   * Opt-in pre-grant: when on, the submit flow first PUTs an EA
   * Subscription Creator role assignment at the selected enrollment-
   * account scope for the signed-in principal (decoded from the ARM
   * token's `oid` / `tid` claims), and only then calls the alias
   * create. This eliminates the "missing role" 401 round-trip that
   * otherwise forces the operator to bounce through Sub Manager.
   *
   * The pre-grant is tolerated as idempotent — a 409/"already exists"
   * is treated as a no-op so re-runs don't accumulate duplicate role
   * rows. It does NOT help with the passthrough-token 401: that one
   * requires a fresh token with a populated `oid` claim, which a
   * role grant can't fabricate.
   */
  const [preGrantRole, setPreGrantRole] = React.useState(false);
  /** Tracks the pre-grant stage of the current submit for the UI. */
  const [preGrantStatus, setPreGrantStatus] = React.useState<
    "idle" | "granting" | "granted" | "already-granted" | "failed"
  >("idle");
  /** Reason a pre-grant failed (when status === "failed"). */
  const [preGrantError, setPreGrantError] = React.useState<string | null>(
    null,
  );

  /**
   * Confirmation dialog state. Two flavours:
   *   - "create"  — fired before the submit() call so cross-tenant
   *                 grants and pre-grant role PUTs are explicitly
   *                 acknowledged by the operator.
   *   - "navigate-sub-manager" — fired before window.location.hash
   *                 leaves the page on a missing-role recovery, so
   *                 the operator doesn't lose context unintentionally.
   */
  type ConfirmKind =
    | { kind: "create" }
    | { kind: "navigate-sub-manager" }
    | { kind: "clear-history" }
    | null;
  const [confirmDialog, setConfirmDialog] =
    React.useState<ConfirmKind>(null);

  /**
   * Force a fresh ARM token for the current account (bypasses MSAL's
   * silent cache and any imported-token short-circuit). Used by the
   * passthrough-token remediation to retry with a token that carries
   * the right tenant claim for the Microsoft.Subscription RP.
   */
  const handleReacquireToken = React.useCallback(async () => {
    setReacquiring(true);
    try {
      // We can't directly reach `account` here without a forward ref —
      // re-derive from the currently selected accountId.
      const targetAccount = candidates.find(
        (c) => c.homeAccountId === accountId,
      );
      if (!targetAccount) return;
      // Tenant arg omitted so we pick up the operator's current active
      // tenant (was pinning to targetAccount.tenantId / the account's
      // HOME tenant — pre-switch).
      const acquireSilently = () =>
        getArmTokenForAccount(targetAccount.homeAccountId, undefined, {
          forceRefresh: true,
        });
      let tok: string;
      try {
        tok = await acquireSilently();
      } catch (err) {
        // Silent forceRefresh can't recover when the refresh token /
        // broker session is gone — MSAL throws InteractionRequiredAuthError
        // (rethrown by msal-auth as "Cached session is no longer valid").
        // The Re-acquire button click IS a user gesture, so a popup here
        // is allowed and is the documented MSAL recovery path. Fall back
        // to interactive sign-in scoped to the EA enrollment tenant,
        // then retry the silent forceRefresh once.
        const msg = err instanceof Error ? err.message : String(err);
        const needsInteractive =
          /interaction_required/i.test(msg) ||
          /Cached session is no longer valid/i.test(msg) ||
          (err as { errorCode?: string })?.errorCode === "interaction_required";
        if (!needsInteractive) throw err;
        await loginAccount({
          tenantId: targetAccount.tenantId,
          loginHint: targetAccount.username,
          prompt: "select_account",
        });
        tok = await acquireSilently();
      }
      setArmToken(tok);
      setPassthroughToken(false);
      setSubmitError(null);
      store.addNotification({
        type: "success",
        message: "ARM token re-acquired. Try Create again.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addNotification({
        type: "error",
        message: `Token re-acquire failed: ${msg}`,
      });
    } finally {
      setReacquiring(false);
    }
  }, [accountId, candidates, store]);
  const [result, setResult] = React.useState<{
    aliasName: string;
    subscriptionId?: string;
    provisioningState: string;
    displayName: string;
    durationMs: number;
    polled: boolean;
  } | null>(null);

  /**
   * In-memory submitted-aliases history for the current session. Powers
   * the CSV/JSON export and the "Subs created this session" stat. Cleared
   * on page unmount; the audit log preserves the canonical record.
   */
  const [submittedAliases, setSubmittedAliases] = React.useState<
    SubmittedAlias[]
  >([]);
  const [counter, setCounter] = React.useState(1);

  /* ----- DisplayName presets ------------------------------------ */
  // Migrated to usePersistedState so we share the single localStorage
  // adapter the rest of the codebase already uses; the legacy callers
  // (and pre-versioned blobs) are still accepted via `migrate`.
  const [presets, setPresets] = usePersistedState<string[]>(
    STORAGE_PRESETS,
    [],
    {
      version: 1,
      migrate: (raw) => migratePresets(raw),
    },
  );
  const handleSavePreset = React.useCallback(() => {
    const tpl = displayName.trim();
    if (!tpl) return;
    setPresets((prev) => {
      if (prev.includes(tpl)) return prev;
      // Cap at 8 to keep the dropdown tidy.
      return [tpl, ...prev].slice(0, 8);
    });
  }, [displayName, setPresets]);
  const handleDeletePreset = React.useCallback(
    (tpl: string) => {
      setPresets((prev) => prev.filter((p) => p !== tpl));
    },
    [setPresets],
  );
  const handleApplyPreset = React.useCallback(
    (tpl: string) => {
      const resolved = applyDisplayNameTokens(tpl, {
        counter,
        username: account?.username,
      });
      setDisplayName(resolved);
    },
    [counter, account?.username, setDisplayName],
  );

  /* ----- Recently-used full configurations ----------------------- */
  // Persisted across reloads (last 5 successful submissions). Distinct
  // from `presets` (just displayName templates) and from `submittedAliases`
  // (the in-memory session history). One click = whole-form rehydrate.
  const [recentConfigs, setRecentConfigs] = usePersistedState<RecentConfig[]>(
    STORAGE_RECENT_CONFIGS,
    [],
    {
      version: 1,
      migrate: (raw) => {
        if (!Array.isArray(raw)) return [];
        // Best-effort: keep only well-shaped rows.
        return (raw as unknown[])
          .filter(
            (r): r is RecentConfig =>
              !!r &&
              typeof r === "object" &&
              typeof (r as RecentConfig).key === "string" &&
              typeof (r as RecentConfig).displayNameTemplate === "string",
          )
          .slice(0, RECENT_PRESETS_MAX);
      },
    },
  );
  const recordRecentConfig = React.useCallback(
    (cfg: Omit<RecentConfig, "key" | "lastUsedAt">) => {
      const key = recentConfigKey(cfg);
      setRecentConfigs((prev) => {
        const filtered = prev.filter((r) => r.key !== key);
        const next: RecentConfig = {
          ...cfg,
          key,
          lastUsedAt: new Date().toISOString(),
        };
        return [next, ...filtered].slice(0, RECENT_PRESETS_MAX);
      });
    },
    [setRecentConfigs],
  );

  /**
   * Submission is allowed when:
   *   - For EA: billing + enrollment + valid scope
   *   - For non-EA / custom: a valid billingScope string was assembled
   * Fixes the prior bug where the custom-billingScope path was still
   * gated on `enrollmentAccountName` even though the assembled scope
   * may target the billing-account directly (MOSP/MCA case).
   */
  const canSubmit =
    !submitting &&
    !!armToken &&
    !!billingScope &&
    displayName.trim().length >= 3 &&
    displayName.trim().length <= 64 &&
    !!aliasName &&
    crossTenantValid;

  /**
   * Preflight checklist — five fast-path checks the page can evaluate WITHOUT
   * burning an API request. Surfaces the same gating conditions that the
   * submit button consults so the operator sees WHY the button is disabled
   * (or what will go wrong with the alias-create call even when it's not).
   *
   * `tone` drives the indicator color (success / warning / destructive).
   * `blocking` rows must be green before submit is meaningful.
   *
   * This is not an Azure-side quota check — the EA enrollment account quota
   * lives on the EA portal side, not behind ARM's listing surface — but it
   * IS a precise reproduction of every gate the page itself enforces.
   */
  const preflight = React.useMemo(() => {
    type Tone = "success" | "warning" | "destructive" | "muted";
    type Row = {
      label: string;
      ok: boolean;
      tone: Tone;
      blocking: boolean;
      hint?: string;
    };
    const rows: Row[] = [];
    rows.push({
      label: "Account",
      ok: !!account,
      tone: account ? "success" : "destructive",
      blocking: true,
      hint: account?.username,
    });
    rows.push({
      label: "ARM token",
      ok: !!armToken,
      tone: armToken
        ? noOidDetected
          ? "warning"
          : "success"
        : "destructive",
      blocking: true,
      hint: armToken
        ? noOidDetected
          ? "no oid claim"
          : armTokenClaims?.oid
            ? `oid ${armTokenClaims.oid.slice(0, 8)}…`
            : undefined
        : undefined,
    });
    rows.push({
      label: "Billing scope",
      ok: !!billingScope,
      tone: billingScope ? "success" : "destructive",
      blocking: true,
      hint: billingScope
        ? customScopeMode
          ? "custom"
          : accountIsEnterpriseAgreement
            ? "EA + EA"
            : "BA only"
        : undefined,
    });
    const dnLen = displayName.trim().length;
    rows.push({
      label: "Display name",
      ok: dnLen >= 3 && dnLen <= 64,
      tone: dnLen >= 3 && dnLen <= 64 ? "success" : "destructive",
      blocking: true,
      hint: `${dnLen}/64`,
    });
    rows.push({
      label: "Cross-tenant",
      ok: crossTenantValid,
      tone: crossTenantRequested
        ? crossTenantValid
          ? "warning"
          : "destructive"
        : "muted",
      blocking: true,
      hint: crossTenantRequested
        ? crossTenantValid
          ? "ready"
          : "needs both ids"
        : "off",
    });
    return rows;
  }, [
    account,
    armToken,
    noOidDetected,
    armTokenClaims,
    billingScope,
    customScopeMode,
    accountIsEnterpriseAgreement,
    displayName,
    crossTenantValid,
    crossTenantRequested,
  ]);
  const preflightBlocking = preflight.filter((r) => r.blocking && !r.ok).length;

  const submit = React.useCallback(async () => {
    if (!canSubmit || !armToken) return;
    setSubmitting(true);
    const startedAt = Date.now();
    setSubmitStartedAtMs(startedAt);
    setSubmitError(null);
    setMissingRole(false);
    setPassthroughToken(false);
    setPreGrantStatus("idle");
    setPreGrantError(null);
    setResult(null);
    // Resolve {date}/{time}/{counter}/{user} tokens in the display name
    // BEFORE sending — so the operator sees the final form land in audit.
    const resolvedDisplay = applyDisplayNameTokens(displayName.trim(), {
      counter,
      username: account?.username,
    });

    /* ─────────────────────────────────────────────────────────────
     * Optional pre-grant pass.
     *
     * When enabled, we PUT an EA Subscription Creator role assignment
     * at the selected enrollment-account scope for the signed-in
     * principal before issuing the alias create. This eliminates the
     * "User is not authorized to create subscriptions" 401 that
     * otherwise forces a trip through Sub Manager → Grant tab.
     *
     * Pre-conditions enforced here:
     *   1. The token must carry an `oid` claim — without it we have
     *      no principalId to grant the role TO. This is the case
     *      that surfaced as the 'passthrough token / oid: —' 401 in
     *      the wild; aborting up front with a tailored message is
     *      strictly better than burning a request and getting the
     *      generic passthrough alert.
     *   2. The selection must be an EA flow with a known billing
     *      account + enrollment account. Custom billingScope (from
     *      the manual override) lacks the BA/EA needed to PUT a
     *      role assignment — the user is on their own.
     * ───────────────────────────────────────────────────────────── */
    if (preGrantRole) {
      const claims = armTokenClaims ?? null;
      const oid = claims?.oid ?? "";
      const tid = claims?.tid ?? "";
      if (!oid) {
        setPreGrantStatus("failed");
        setNoOidDetected(true);
        setPreGrantError(
          "Token has no `oid` claim — there's no principal to grant the role to. Sign in against the principal's HOME tenant on Azure Accounts (where they're a member, not a guest) and try again.",
        );
        setSubmitError(
          "Pre-grant skipped: ARM token has no `oid` claim. See the Alert above for how to fix.",
        );
        setSubmitting(false);
        setSubmitStartedAtMs(null);
        return;
      }
      if (!billingAccountName || !enrollmentAccountName) {
        setPreGrantStatus("failed");
        setPreGrantError(
          "Pre-grant requires a billing account + enrollment account. The custom-scope override skips this — pick BA/EA from the pickers, or grant the role manually via Sub Manager → Grant tab.",
        );
        setSubmitError(
          "Pre-grant skipped: no BA/EA selected (custom scope). See Alert above.",
        );
        setSubmitting(false);
        setSubmitStartedAtMs(null);
        return;
      }
      setPreGrantStatus("granting");
      try {
        // The pre-grant grants the role to the *signed-in* user, so
        // their UPN is the right `userEmailAddress` to surface to the
        // EA backend — many EA-agreement tenants need it on the
        // modern billing-role-assignment endpoint and return an opaque
        // 500 without it. The arm-service fallback covers the case
        // where the modern endpoint is just broken for this EA.
        await createEnrollmentAccountRoleAssignment(
          billingAccountName,
          enrollmentAccountName,
          oid,
          tid,
          ROLE_EA_SUBSCRIPTION_CREATOR,
          armToken,
          { userEmailAddress: account?.username || undefined },
        );
        setPreGrantStatus("granted");
        auditLog.record({
          actor: account?.username ?? "",
          action: "create_billing_role_assignment",
          target: `${billingAccountName}/${enrollmentAccountName}/${oid}`,
          status: "success",
          details: {
            page: "ea-sub-quick",
            role: "EA Subscription Creator",
            stage: "pre-grant",
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Idempotent: an existing assignment is silently OK. Some EA
        // tenants surface this as 409 conflict, others as a 400 with
        // "already exists" in the body — be liberal in what we accept.
        if (/409|already\s*exists|conflict/i.test(msg)) {
          setPreGrantStatus("already-granted");
        } else {
          setPreGrantStatus("failed");
          setPreGrantError(msg);
          setSubmitError(`Pre-grant failed: ${msg}`);
          auditLog.record({
            actor: account?.username ?? "",
            action: "create_billing_role_assignment",
            target: `${billingAccountName}/${enrollmentAccountName}/${oid}`,
            status: "failure",
            error: msg,
            details: {
              page: "ea-sub-quick",
              role: "EA Subscription Creator",
              stage: "pre-grant",
            },
          });
          setSubmitting(false);
          setSubmitStartedAtMs(null);
          return;
        }
      }
    }

    try {
      const r = await createEaSubscription(
        {
          aliasName,
          displayName: resolvedDisplay,
          billingScope,
          workload,
          subscriptionTenantId: subscriptionTenantId.trim() || undefined,
          subscriptionOwnerId: subscriptionOwnerId.trim() || undefined,
          tags: tagsForBody,
        },
        armToken,
      );
      const durationMs = Date.now() - startedAt;
      // Heuristic: any create that took longer than the polling pulse
      // threshold AND came back without subscriptionId on the immediate
      // body almost certainly went down the 202 → poll path. The
      // service flattens both paths into a single shape so we infer.
      const polled =
        durationMs > POLL_PULSE_AFTER_MS ||
        (!r.subscriptionId &&
          r.provisioningState.toLowerCase() !== "succeeded");
      setResult({ ...r, durationMs, polled });
      setSubmittedAliases((prev) => {
        const next: SubmittedAlias[] = [
          {
            aliasName: r.aliasName,
            displayName: r.displayName,
            billingScope,
            workload,
            subscriptionId: r.subscriptionId,
            provisioningState: r.provisioningState,
            submittedAt: new Date().toISOString(),
            durationMs,
            polled,
            crossTenant: !!subscriptionTenantId.trim(),
          },
          ...prev,
        ];
        return next.slice(0, HISTORY_MAX_ROWS);
      });
      setCounter((c) => c + 1);
      // Persist this configuration as a "recently used" preset so the
      // operator can one-click rehydrate it on a future page load. The
      // raw template is kept (not the resolved tokens) so {date}/{counter}
      // still expand fresh next time. We skip cross-tenant/owner ids on
      // purpose — those are operator-specific and would leak into shared
      // browsers; the recipe is what's reusable.
      recordRecentConfig({
        displayNameTemplate: displayName.trim(),
        workload,
        billingAccountName,
        enrollmentAccountName,
        customScopeMode,
      });
      // Re-roll alias on success so the next submit doesn't 409 on
      // the same name — operators almost always want a fresh one and
      // we already keep the previous in history.
      setAliasName(generateAliasName());
      auditLog.record({
        actor: account?.username ?? "",
        action: "create_alias_subscription",
        target: r.subscriptionId ?? aliasName,
        status: "success",
        details: {
          page: "ea-sub-quick",
          billingAccountName,
          enrollmentAccountName,
          billingScope,
          workload,
          subscriptionTenantId: subscriptionTenantId.trim() || undefined,
          subscriptionOwnerId: subscriptionOwnerId.trim() || undefined,
          provisioningState: r.provisioningState,
          // Both paths are recorded — synchronous (immediate body) or
          // asynchronous (202 + poll). Easier to spot pathological
          // latency in the audit log.
          path: polled ? "async-202-poll" : "sync-200",
          durationMs,
          tagsCount: tagsForBody ? Object.keys(tagsForBody).length : 0,
        },
      });
      store.addNotification({
        type: r.provisioningState === "Succeeded" ? "success" : "info",
        message:
          r.provisioningState === "Succeeded"
            ? `Subscription ${r.subscriptionId} provisioned.`
            : `Subscription accepted (${r.provisioningState}). Poll the alias to watch it finish.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt;
      setSubmitError(msg);
      // Disambiguate the two flavours of 401 that show up here, in
      // priority order — passthrough-token has to be checked FIRST
      // because the ARM Subscription RP wraps it in a 401 status and
      // the message includes the string "401", which would otherwise
      // get bucketed as a missing-role failure.
      //
      // (1) Passthrough-token / invalid-tenant: the token reached the
      //     RP but its `tid` claim doesn't carry the right resource-
      //     provider context. Caused by imported/portal tokens, or a
      //     token minted against the user's home tenant when the EA
      //     enrollment lives in a different tenant. Remediation is to
      //     re-acquire a fresh ARM token (or sign out + back in), NOT
      //     to grant a role.
      const isPassthroughToken =
        /passthrough token was detected/i.test(msg) ||
        /Token validation failed/i.test(msg) ||
        /without proper resource provider context/i.test(msg);
      // (2) Missing-role: AAD explicitly says the principal isn't
      //     allowed to create subscriptions on this enrollment
      //     account. Needs EA Subscription Creator grant.
      const isMissingRole =
        !isPassthroughToken &&
        (/not authorized to create subscriptions/i.test(msg) ||
          /AADSTS65001/i.test(msg) ||
          /AuthorizationFailed/i.test(msg) ||
          msg.includes("401"));
      if (isPassthroughToken) setPassthroughToken(true);
      else if (isMissingRole) setMissingRole(true);
      auditLog.record({
        actor: account?.username ?? "",
        action: "create_alias_subscription",
        target: aliasName,
        status: "failure",
        error: msg,
        details: {
          page: "ea-sub-quick",
          billingAccountName,
          enrollmentAccountName,
          billingScope,
          workload,
          path:
            durationMs > POLL_PULSE_AFTER_MS ? "async-202-poll" : "sync-200",
          durationMs,
          classification: isPassthroughToken
            ? "passthrough-token"
            : isMissingRole
              ? "missing-role"
              : "other",
        },
      });
    } finally {
      setSubmitting(false);
      setSubmitStartedAtMs(null);
    }
  }, [
    canSubmit,
    armToken,
    aliasName,
    displayName,
    billingScope,
    workload,
    subscriptionTenantId,
    subscriptionOwnerId,
    tagsForBody,
    billingAccountName,
    enrollmentAccountName,
    customScopeMode,
    account?.username,
    armTokenClaims,
    preGrantRole,
    store,
    counter,
    recordRecentConfig,
  ]);

  const regenAlias = React.useCallback(() => {
    setAliasName(generateAliasName());
  }, []);

  /**
   * Confirmation flow. Wraps direct `submit()` so that cross-tenant
   * landings, pre-grant role PUTs, and custom-scope submits all force
   * an explicit acknowledgement step. Falls through to `submit()`
   * directly for simple "create in my own tenant, no pre-grant" cases
   * so we don't add friction to the common path.
   */
  const handleCreateClick = React.useCallback(() => {
    if (!canSubmit) return;
    const needsConfirm =
      crossTenantRequested || preGrantRole || customScopeMode;
    if (needsConfirm) {
      setConfirmDialog({ kind: "create" });
    } else {
      void submit();
    }
  }, [
    canSubmit,
    crossTenantRequested,
    preGrantRole,
    customScopeMode,
    submit,
  ]);

  // Ctrl/Cmd+Enter from anywhere on the page submits — fast path for
  // operators batching many subs. `allowInInputs: true` because the
  // operator is virtually always typing in the displayName or alias
  // inputs when they press it. We still bail if `canSubmit` is false
  // (mirrors the click handler exactly).
  useShortcut("Mod+Enter", () => handleCreateClick(), {
    allowInInputs: true,
    preventDefault: true,
  });

  // Recently-used preset → whole-form rehydrate. The displayName template
  // is kept verbatim (tokens not yet expanded — they'll re-expand at
  // submit time). Scope rehydrate works for both picker and custom modes.
  const handleApplyRecentConfig = React.useCallback(
    (cfg: RecentConfig) => {
      setDisplayName(cfg.displayNameTemplate);
      setWorkload(cfg.workload);
      if (cfg.customScopeMode) {
        setCustomScopeMode(true);
        setCustomBillingAccountName(cfg.billingAccountName);
        setCustomEnrollmentAccountName(cfg.enrollmentAccountName);
      } else {
        setCustomScopeMode(false);
        if (cfg.billingAccountName) {
          setBillingAccountName(cfg.billingAccountName);
        }
        if (cfg.enrollmentAccountName) {
          setEnrollmentAccountName(cfg.enrollmentAccountName);
        }
      }
      auditLog.record({
        actor: account?.username ?? "",
        action: "apply_recent_config",
        target: cfg.key,
        status: "success",
        details: {
          page: "ea-sub-quick",
          billingAccountName: cfg.billingAccountName,
          enrollmentAccountName: cfg.enrollmentAccountName,
          workload: cfg.workload,
          customScopeMode: cfg.customScopeMode,
        },
      });
    },
    [
      account?.username,
      setBillingAccountName,
      setEnrollmentAccountName,
      setDisplayName,
      setWorkload,
    ],
  );
  const handleDeleteRecentConfig = React.useCallback(
    (key: string) => {
      setRecentConfigs((prev) => prev.filter((r) => r.key !== key));
    },
    [setRecentConfigs],
  );

  const handleNavigateSubManager = React.useCallback(() => {
    // Pre-seed Sub Manager → Grant Subscription Creator tab with this
    // scope. The picker there reads these sessionStorage keys on mount.
    try {
      sessionStorage.setItem("sub-manager:tab", "grant-sub-creator");
      const m = /billingAccounts\/([^/]+)/.exec(billingScope);
      if (m && m[1]) {
        sessionStorage.setItem("sub-manager:billing-account", m[1]);
      }
    } catch {
      /* ignore */
    }
    // Path-based navigation through the outlet context (preferred) — falls
    // back to the legacy onNavigate(pageKey) prop for backward-compat, then
    // to react-router's `navigate` for sandbox mounts.
    if (outletCtx?.navigateToPage) {
      outletCtx.navigateToPage("/sub-manager");
    } else if (onNavigate) {
      onNavigate("sub-manager");
    } else {
      navigate("/sub-manager");
    }
  }, [billingScope, outletCtx, onNavigate, navigate]);

  /* ----- Export columns for the submitted-aliases history --------- */
  const exportColumns = React.useMemo<ExportColumn<SubmittedAlias>[]>(
    () => [
      { header: "submittedAt", accessor: (r) => r.submittedAt },
      { header: "aliasName", accessor: (r) => r.aliasName },
      { header: "displayName", accessor: (r) => r.displayName },
      { header: "subscriptionId", accessor: (r) => r.subscriptionId ?? "" },
      { header: "provisioningState", accessor: (r) => r.provisioningState },
      { header: "workload", accessor: (r) => r.workload },
      { header: "billingScope", accessor: (r) => r.billingScope },
      { header: "durationMs", accessor: (r) => r.durationMs },
      { header: "polled", accessor: (r) => (r.polled ? "true" : "false") },
      {
        header: "crossTenant",
        accessor: (r) => (r.crossTenant ? "true" : "false"),
      },
    ],
    [],
  );

  /* ----- Quick-stat values --------------------------------------- */
  const easUnderSelectedBaCount = accountIsEnterpriseAgreement ? eas.length : 0;
  const successCount = submittedAliases.filter(
    (a) => a.provisioningState === "Succeeded",
  ).length;

  /* ----- Curl-snippet preview ------------------------------------ */
  const [showCurl, setShowCurl] = React.useState(false);
  const curlSnippet = React.useMemo(
    () =>
      billingScope
        ? buildCurlSnippet({
            aliasName,
            displayName: applyDisplayNameTokens(displayName.trim(), {
              counter,
              username: account?.username,
            }),
            billingScope,
            workload,
            subscriptionTenantId: subscriptionTenantId.trim() || undefined,
            subscriptionOwnerId: subscriptionOwnerId.trim() || undefined,
            tags: tagsForBody,
          })
        : "",
    [
      aliasName,
      displayName,
      counter,
      account?.username,
      billingScope,
      workload,
      subscriptionTenantId,
      subscriptionOwnerId,
      tagsForBody,
    ],
  );

  /* ----- Tenant-switch sync -------------------------------------- */
  // React to global tenant-switch events: when the new active account
  // is one of our eligible candidates, mirror the switch into local
  // state + sessionStorage so the picker stays aligned with the rest
  // of the app.
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!candidates.some((c) => c.homeAccountId === candidate)) return;
    if (accountId === candidate) return;
    setAccountIdState(candidate);
    try {
      sessionStorage.setItem(STORAGE_ACCOUNT, candidate);
    } catch {
      /* ignore */
    }
  });

  /* ----- Render --------------------------------------------------- */

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Create EA Sub (alias API)"
          description="Minimal flow that mirrors Microsoft's PowerShell example exactly."
        />
        <EmptyState
          icon={Crown}
          title="No Azure account signed in"
          description="Sign in with an account that holds EA Subscription Creator on the target enrollment account."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader
          title="Create EA Sub (alias API)"
          description="Mirrors Microsoft's PowerShell snippet: list billing accounts → list enrollment accounts → PUT /providers/Microsoft.Subscription/aliases/{name} → poll until Succeeded."
        />
        {/* Token freshness badge — quiet by default, surfaces when
            < 10 min from expiry. Click to force-refresh BEFORE
            starting a multi-minute provisioning run so the token
            doesn't flip mid-poll. */}
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

      <Alert>
        <Info className="h-3.5 w-3.5" />
        <AlertDescription className="text-2xs">
          Uses the modern{" "}
          <code className="font-mono">2021-10-01</code> Subscription
          Alias API. No commerce-account dependency, works on every
          active EA. The existing{" "}
          <a
            href="#/ea-subscription"
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Create EA Sub (multi-recipient)
          </a>{" "}
          page wraps the same API with a richer recipient batcher; pick
          that one when you want to provision a sub per
          user/SPN in one go.
        </AlertDescription>
      </Alert>

      {/* ----- Recently-used configurations (one-click rehydrate) ----- */}
      {recentConfigs.length > 0 && (
        <Card className="border-dashed border-primary/40 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4 text-primary" />
              Recently used
              <Badge variant="outline" className="text-[9px]">
                {recentConfigs.length}/{RECENT_PRESETS_MAX}
              </Badge>
            </CardTitle>
            <CardDescription className="text-2xs">
              One-click rehydrate from your last few successful submissions.
              Cleared on browser data wipe — recipes only, no tokens or owner
              ids.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul
              className="flex flex-wrap gap-1.5"
              aria-label="Recently used configurations"
            >
              {recentConfigs.map((cfg) => (
                <li
                  key={cfg.key}
                  className="inline-flex items-center gap-0.5 rounded-full border border-border bg-background/60 pl-2 pr-0.5"
                >
                  <button
                    type="button"
                    onClick={() => handleApplyRecentConfig(cfg)}
                    className="flex items-center gap-1 py-0.5 text-2xs hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Rehydrate form to ${cfg.displayNameTemplate} (${cfg.workload})`}
                    title={`Last used ${new Date(cfg.lastUsedAt).toLocaleString()}`}
                  >
                    <span className="font-medium">
                      {cfg.displayNameTemplate}
                    </span>
                    <Badge
                      variant="outline"
                      className="ml-1 text-[9px] font-mono"
                    >
                      {cfg.workload}
                    </Badge>
                    {cfg.customScopeMode && (
                      <Badge variant="outline" className="text-[9px]">
                        custom
                      </Badge>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteRecentConfig(cfg.key)}
                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Remove ${cfg.displayNameTemplate} from recent`}
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* ----- Quick-stat header -------------------------------- */}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="EA Sub Quick summary"
      >
        <SummaryStatItem
          label="BAs visible"
          value={billingAccounts.length}
          tone={billingAccounts.length > 0 ? "info" : "muted"}
          hint={baLoading ? "loading" : undefined}
          compact
        />
        <SummaryStatItem
          label="EAs under BA"
          value={easUnderSelectedBaCount}
          tone={easUnderSelectedBaCount > 0 ? "info" : "muted"}
          hint={
            accountIsEnterpriseAgreement
              ? eaLoading
                ? "loading"
                : undefined
              : "non-EA: N/A"
          }
          compact
        />
        <SummaryStatItem
          label="Subs this session"
          value={submittedAliases.length}
          tone={submittedAliases.length > 0 ? "success" : "muted"}
          hint={
            submittedAliases.length > 0
              ? `${successCount} succeeded`
              : undefined
          }
          compact
        />
        <SummaryStatItem
          label="Failed this session"
          value={submittedAliases.length - successCount}
          tone={
            submittedAliases.length - successCount > 0
              ? "destructive"
              : "muted"
          }
          compact
        />
      </div>

      {/* ----- Scope picker -------------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-primary" />
            Billing scope
            <InfoTooltip
              variant="help"
              ariaLabel="What is a billingScope"
              content="The ARM resource id the alias API charges against. For Enterprise Agreement: /providers/Microsoft.Billing/billingAccounts/{ba}/enrollmentAccounts/{ea}. For MOSP / MCA / MPA: /providers/Microsoft.Billing/billingAccounts/{ba}. Paste a known scope below if the picker can't see your billing account (hasReadAccess: false)."
            />
          </CardTitle>
          <CardDescription>
            Account → billing account → enrollment account. The resolved{" "}
            <code className="font-mono">billingScope</code> ARM path is
            shown at the bottom.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
                  <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> loading
                </p>
              ) : baError ? (
                <ErrorState
                  size="compact"
                  message="Failed to load billing accounts."
                  detail={baError}
                />
              ) : billingAccounts.length === 0 ? (
                <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                  <p>No EA billing accounts visible.</p>
                  <button
                    type="button"
                    onClick={() => setCustomScopeMode(true)}
                    className="self-start text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Use custom billingScope instead →
                  </button>
                </div>
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
                          <span className="flex items-center gap-2 text-sm">
                            <span className="truncate">{b.displayName}</span>
                            <Badge
                              variant={
                                b.agreementType?.toLowerCase() ===
                                "enterpriseagreement"
                                  ? "default"
                                  : "outline"
                              }
                              className="text-[9px]"
                            >
                              {b.agreementType || "Unknown"}
                            </Badge>
                          </span>
                          <span className="font-mono text-2xs text-muted-foreground">
                            {b.name}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {/*
             * Enrollment-account picker is meaningful ONLY for EA
             * agreements; non-EA accounts (MOSP/MCA/MPA) don't have an
             * enrollment-accounts collection — we just use the billing
             * account ARM id as the billingScope directly.
             */}
            {accountIsEnterpriseAgreement ? (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Enrollment account</Label>
                {eaLoading ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> loading
                  </p>
                ) : eaError ? (
                  <ErrorState
                    size="compact"
                    message="Failed to load enrollment accounts."
                    detail={eaError}
                  />
                ) : eas.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No enrollment accounts visible — pick a different
                    billing account or contact your EA admin.
                  </p>
                ) : (
                  <Select
                    value={enrollmentAccountName}
                    onValueChange={setEnrollmentAccountName}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick an enrollment account" />
                    </SelectTrigger>
                    <SelectContent>
                      {eas.map((e) => (
                        <SelectItem key={e.name} value={e.name}>
                          <span className="flex flex-col">
                            <span className="text-sm">{e.displayName}</span>
                            <span className="font-mono text-2xs text-muted-foreground">
                              {e.name}
                              {e.accountOwner ? ` · ${e.accountOwner}` : ""}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ) : selectedBa ? (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Enrollment account</Label>
                <Alert>
                  <Info className="h-3.5 w-3.5" />
                  <AlertDescription className="text-2xs">
                    The selected billing account is{" "}
                    <code className="font-mono">
                      {selectedBa.agreementType || "Unknown"}
                    </code>{" "}
                    — no enrollment-accounts collection. We'll target
                    the billing account scope directly (
                    <code className="font-mono">
                      /providers/Microsoft.Billing/billingAccounts/&#123;name&#125;
                    </code>
                    ). The alias API accepts this for MOSP / MCA / MPA
                    accounts; if your tenant requires a billing
                    profile + invoice section (full MCA flow) instead,
                    use the multi-recipient EA Sub page which exposes
                    that picker.
                  </AlertDescription>
                </Alert>
              </div>
            ) : (
              <div />
            )}
          </div>

          {/* Custom billingScope override — for situations where the
              right billing / enrollment account isn't reachable via
              the picker (e.g. hasReadAccess: false on an EA billing
              account whose subs you can still see via a MOSP-style
              parallel row). */}
          <div
            className={
              "flex flex-col gap-2 rounded-md border border-dashed p-3 " +
              (customScopeMode
                ? "border-primary/50 bg-primary/5"
                : "border-border/60 bg-muted/30")
            }
          >
            <label
              className="flex cursor-pointer items-start gap-2 text-xs"
              htmlFor="ea-sub-quick-custom-scope-toggle"
            >
              <input
                id="ea-sub-quick-custom-scope-toggle"
                type="checkbox"
                checked={customScopeMode}
                onChange={(e) => setCustomScopeMode(e.target.checked)}
                aria-label="Toggle custom billingScope (advanced)"
                className="mt-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 font-medium">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  Use custom billingScope (advanced)
                  <InfoTooltip
                    variant="help"
                    ariaLabel="When to use custom billingScope"
                    content="Bypass the picker. Paste the BA + EA names you know, or a full pre-built billingScope ARM path. Useful when the parent billing account has hasReadAccess: false and doesn't surface in the dropdown above."
                  />
                </span>
                <span className="text-2xs text-muted-foreground">
                  Paste the EA billing account name + enrollment account
                  name you know, OR a full pre-built billingScope ARM
                  path. The alias API only needs the resulting string.
                </span>
              </span>
            </label>
            {customScopeMode && (
              <div className="flex flex-col gap-2 pl-6">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-2xs">EA billing account name</Label>
                    <Input
                      value={customBillingAccountName}
                      onChange={(e) =>
                        setCustomBillingAccountName(e.target.value)
                      }
                      placeholder="e.g. 79562631"
                      className="font-mono text-2xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-2xs">
                      Enrollment account name
                    </Label>
                    <Input
                      value={customEnrollmentAccountName}
                      onChange={(e) =>
                        setCustomEnrollmentAccountName(e.target.value)
                      }
                      placeholder="e.g. 405336"
                      className="font-mono text-2xs"
                    />
                  </div>
                </div>
                <details>
                  <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Or paste the full billingScope ARM path
                  </summary>
                  <Input
                    value={customFullScope}
                    onChange={(e) => setCustomFullScope(e.target.value)}
                    placeholder="/providers/Microsoft.Billing/billingAccounts/.../enrollmentAccounts/..."
                    className="mt-2 font-mono text-[10px]"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    A full path here overrides the two fields above.
                  </p>
                </details>
              </div>
            )}
          </div>

          {billingScope && (
            <div className="group/copy flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-2xs">
              <span className="text-muted-foreground">billingScope</span>
              <code className="break-all font-mono">{billingScope}</code>
              <CopyButton
                value={billingScope}
                ariaLabel="Copy billingScope ARM path"
                alwaysVisible
                className="ml-auto"
              />
            </div>
          )}

          {/* Diagnostics: principal claims + raw-token reveal. Tiny,
              collapsed by default — shows the operator who they ARE on
              the wire, including the same `oid` we'd use for pre-grant
              and the same `tid` ARM will check. */}
          {armToken && armTokenClaims && (
            <details className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-2xs">
              <summary className="cursor-pointer font-medium text-muted-foreground">
                Diagnostics — principal we'll send as
              </summary>
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">upn</span>
                  <code className="font-mono">
                    {armTokenClaims.upn || "(none)"}
                  </code>
                  <CopyButton
                    value={armTokenClaims.upn}
                    ariaLabel="Copy UPN"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">oid</span>
                  <code className="font-mono">
                    {armTokenClaims.oid || "—"}
                  </code>
                  {armTokenClaims.oid && (
                    <CopyButton
                      value={armTokenClaims.oid}
                      ariaLabel="Copy object id"
                    />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">tid</span>
                  <code className="font-mono">{armTokenClaims.tid}</code>
                  <CopyButton
                    value={armTokenClaims.tid}
                    ariaLabel="Copy tenant id"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">aud</span>
                  <code className="font-mono">{armTokenClaims.aud}</code>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-2xs"
                    onClick={() => setShowTokenDiagnostics((s) => !s)}
                  >
                    {showTokenDiagnostics ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                    {showTokenDiagnostics ? "Hide raw" : "Show raw token"}
                  </Button>
                  {showTokenDiagnostics && (
                    <CopyButton
                      value={armToken}
                      ariaLabel="Copy raw ARM token"
                      alwaysVisible
                    />
                  )}
                </div>
                {showTokenDiagnostics && (
                  <code className="block break-all rounded bg-background/60 p-1.5 font-mono text-[10px] text-muted-foreground">
                    {armToken}
                  </code>
                )}
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      {!billingScope ? (
        <EmptyState
          icon={BadgeCheck}
          title={
            accountIsEnterpriseAgreement
              ? "Pick billing + enrollment"
              : "Pick a billing account"
          }
          description={
            accountIsEnterpriseAgreement
              ? "Once both are selected the form below activates."
              : "Once the billing account is selected the form below activates. Non-EA accounts skip the enrollment-account step."
          }
        />
      ) : (
        <>
          {/* ----- Subscription form ------------------------------ */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Plus className="h-4 w-4 text-primary" />
                New subscription
              </CardTitle>
              <CardDescription>
                Body sent to{" "}
                <code className="font-mono">
                  PUT /providers/Microsoft.Subscription/aliases/&#123;name&#125;?api-version=2021-10-01
                </code>
                .
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label className="flex items-center gap-1.5 text-xs">
                    Display name <span className="text-destructive">*</span>
                    <InfoTooltip
                      variant="help"
                      ariaLabel="Display name tokens"
                      content="Supports tokens: {date}=YYYY-MM-DD, {time}=HH-MM, {counter}=001 (auto-increments after each submission this session), {user}=local part of your username. Tokens are resolved at submit time. 3–64 characters."
                    />
                  </Label>
                  <div className="flex items-stretch gap-2">
                    <Input
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="text-xs"
                      placeholder='e.g. "Team X {date} {counter}"'
                      aria-label="Subscription display name"
                      aria-invalid={
                        displayName.trim().length > 0 &&
                        (displayName.trim().length < 3 ||
                          displayName.trim().length > 64)
                          ? true
                          : undefined
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleSavePreset}
                      disabled={
                        !displayName.trim() ||
                        presets.includes(displayName.trim())
                      }
                      aria-label="Save display name template as preset"
                    >
                      <Save className="h-3.5 w-3.5" /> Save preset
                    </Button>
                  </div>
                  {/* Char-count + token-preview row */}
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-2xs">
                    <span className="text-muted-foreground">
                      {displayName.trim().length}/64 chars
                      {displayName.trim().length > 0 &&
                        displayName.trim().length < 3 && (
                          <span className="ml-1 text-destructive">
                            (need ≥ 3)
                          </span>
                        )}
                      {displayName.trim().length > 64 && (
                        <span className="ml-1 text-destructive">
                          (too long)
                        </span>
                      )}
                    </span>
                    {(/\{date\}|\{time\}|\{counter\}|\{user\}/.test(
                      displayName,
                    ) ||
                      counter > 1) && (
                      <span className="text-muted-foreground">
                        Will be sent as:{" "}
                        <code className="font-mono">
                          {applyDisplayNameTokens(displayName.trim(), {
                            counter,
                            username: account?.username,
                          }) || "—"}
                        </code>
                      </span>
                    )}
                  </div>
                  {presets.length > 0 ? (
                    <div
                      className="flex flex-wrap items-center gap-1.5"
                      role="group"
                      aria-label="Saved display-name presets"
                    >
                      <span className="text-2xs text-muted-foreground">
                        Presets:
                      </span>
                      {presets.map((p) => (
                        <span
                          key={p}
                          className="group/preset inline-flex items-center gap-0.5 rounded-full border border-border bg-muted/30 pl-2 pr-0.5 text-2xs"
                        >
                          <button
                            type="button"
                            onClick={() => handleApplyPreset(p)}
                            className="rounded-l-full py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-primary"
                            aria-label={`Apply preset ${p}`}
                            title={`Apply: ${p}`}
                          >
                            {p}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeletePreset(p)}
                            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Delete preset ${p}`}
                          >
                            <Trash2 className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div
                      className="flex flex-wrap items-center gap-1.5"
                      role="group"
                      aria-label="Starter display-name templates"
                    >
                      <span className="text-2xs text-muted-foreground">
                        Try a template:
                      </span>
                      {DEFAULT_PRESET_LIBRARY.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setDisplayName(p)}
                          className="rounded-full border border-dashed border-border/60 px-2 py-0.5 text-2xs text-muted-foreground hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Use template ${p}`}
                          title={`Use template: ${p}`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1.5 text-xs">
                    Workload <span className="text-destructive">*</span>
                    <InfoTooltip
                      variant="help"
                      ariaLabel="Workload meaning"
                      content="Tags the subscription's commercial commitment. 'Production' = standard EA rate. 'DevTest' = Dev/Test pricing (only valid on EA Dev/Test enrollments — picking it on a Production enrollment is silently coerced)."
                    />
                  </Label>
                  <Select
                    value={workload}
                    onValueChange={(v) =>
                      setWorkload(v as "Production" | "DevTest")
                    }
                  >
                    <SelectTrigger aria-label="Select subscription workload">
                      <SelectValue placeholder="Select workload" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Production">Production</SelectItem>
                      <SelectItem value="DevTest">DevTest</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1.5 text-xs">
                  Alias name (URL segment) — must be unique
                  <InfoTooltip
                    variant="help"
                    ariaLabel="What is the alias name"
                    content="The URL segment for the alias resource itself (NOT the subscription's displayName). Must be unique within the tenant. Each successful create auto-rolls a new one so the next submit can't 409 on the same name."
                  />
                </Label>
                <div className="flex items-stretch gap-2">
                  <Input
                    value={aliasName}
                    onChange={(e) => setAliasName(e.target.value)}
                    className="font-mono text-xs"
                    aria-label="Alias name URL segment"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={regenAlias}
                    aria-label="Re-roll a random alias name"
                  >
                    <Sparkles className="h-3.5 w-3.5" /> Re-roll
                  </Button>
                </div>
                <p className="text-2xs text-muted-foreground">
                  Equivalent to PowerShell's{" "}
                  <code className="font-mono">"ea-sub-" + Get-Random</code>.
                  Re-rolls automatically after each successful create.
                </p>
              </div>

              <details className="rounded-md border border-border/60 bg-muted/30 p-3">
                <summary className="cursor-pointer text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Cross-tenant owner & tags (additionalProperties)
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label className="flex items-center gap-1.5 text-xs">
                        subscriptionTenantId
                        <InfoTooltip
                          variant="help"
                          ariaLabel="subscriptionTenantId meaning"
                          content="Destination tenant ID. When set, the new sub lands in that tenant and the named owner has 7 days to accept. Must be a tenant GUID — pair with subscriptionOwnerId."
                        />
                      </Label>
                      <Input
                        value={subscriptionTenantId}
                        onChange={(e) =>
                          setSubscriptionTenantId(e.target.value)
                        }
                        placeholder="11111111-2222-3333-4444-555555555555"
                        className="font-mono text-xs"
                        aria-invalid={
                          subscriptionTenantId.length > 0 &&
                          !UUID_RE.test(subscriptionTenantId.trim())
                            ? true
                            : undefined
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label className="flex items-center gap-1.5 text-xs">
                        subscriptionOwnerId
                        <InfoTooltip
                          variant="help"
                          ariaLabel="subscriptionOwnerId meaning"
                          content="AAD object ID (GUID) of the user / SPN that will receive Owner rights in the destination tenant. Required whenever subscriptionTenantId is set."
                        />
                      </Label>
                      <Input
                        value={subscriptionOwnerId}
                        onChange={(e) =>
                          setSubscriptionOwnerId(e.target.value)
                        }
                        placeholder="Object ID of user / SPN"
                        className="font-mono text-xs"
                        aria-invalid={
                          subscriptionTenantId.length > 0 &&
                          !UUID_RE.test(subscriptionOwnerId.trim())
                            ? true
                            : undefined
                        }
                      />
                    </div>
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    Provide both fields to land the new sub in a
                    different tenant. Empty → the sub lands in the
                    calling principal's home tenant.
                  </p>
                  {!crossTenantValid && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <AlertDescription className="text-2xs">
                        Cross-tenant landing needs BOTH a valid
                        destination tenant id AND a valid owner object
                        id.
                      </AlertDescription>
                    </Alert>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs">Tags</Label>
                    <ul className="flex flex-col gap-1">
                      {tagPairs.map((p, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <Input
                            value={p.key}
                            onChange={(e) =>
                              setTagAt(i, "key", e.target.value)
                            }
                            placeholder="key"
                            className="font-mono text-2xs"
                          />
                          <Input
                            value={p.value}
                            onChange={(e) =>
                              setTagAt(i, "value", e.target.value)
                            }
                            placeholder="value"
                            className="font-mono text-2xs"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => removeTagAt(i)}
                            aria-label={`Remove tag ${p.key}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-2xs"
                        onClick={addTagRow}
                      >
                        <Plus className="h-3 w-3" /> Add tag
                      </Button>
                    </div>
                  </div>
                </div>
              </details>

              {/* Curl-reproduction snippet. Operators routinely want to
                  diff what we're sending against what the docs sample
                  shows, share with another admin, or paste into a
                  terminal for one-off testing. Token is intentionally
                  placeholdered — never expose it via snippet copy. */}
              <details
                className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5"
                onToggle={(e) =>
                  setShowCurl((e.target as HTMLDetailsElement).open)
                }
              >
                <summary className="flex cursor-pointer items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Terminal className="h-3 w-3" /> Show curl snippet
                  <InfoTooltip
                    variant="help"
                    ariaLabel="What is the curl snippet for"
                    content="Reproduction of the alias-create REST call. Paste into a shell with a real bearer token in place of {TOKEN} to test independently of the UI."
                  />
                </summary>
                {showCurl && curlSnippet && (
                  <div className="group/copy mt-2 flex flex-col gap-1.5">
                    <pre className="overflow-x-auto rounded bg-background/80 p-2 font-mono text-[10px] leading-relaxed">
                      {curlSnippet}
                    </pre>
                    <div className="flex justify-end">
                      <CopyButton
                        value={curlSnippet}
                        ariaLabel="Copy curl reproduction snippet"
                        alwaysVisible
                      />
                    </div>
                  </div>
                )}
              </details>

              {submitError && passthroughToken && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription className="flex flex-col gap-2">
                    <span>
                      <strong>
                        ARM rejected the token with "passthrough token
                        detected without proper resource provider
                        context".
                      </strong>{" "}
                      Translation: the token reached the
                      Microsoft.Subscription resource provider but its{" "}
                      <code className="font-mono">tid</code> claim
                      doesn't match a tenant the RP accepts for this
                      enrollment. This is{" "}
                      <strong>not a missing-role error</strong> — the
                      role might be granted, but the token can't be
                      validated.
                    </span>
                    <span className="text-2xs">
                      Typical causes: (1) an{" "}
                      <strong>imported / portal-paste token</strong>{" "}
                      whose audience is fine but tenant context isn't
                      what the RP expects; (2) the account is signed in
                      against its <em>home</em> tenant while the EA
                      enrollment lives in a <em>different</em> tenant;
                      (3) a stale token issued before a recent role
                      grant (propagation can take up to 5 min).
                    </span>
                    <span className="text-2xs">
                      Fixes, in order: (a) click{" "}
                      <strong>Re-acquire token</strong> below to force
                      a fresh ARM token (bypasses MSAL silent cache and
                      any imported-token short-circuit); (b) if you
                      pasted a portal token, re-paste a fresh one from
                      the EA tenant; (c) sign out + sign in on Azure
                      Accounts using the tenant that hosts the
                      enrollment (use the inline tenant switcher).
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="h-7 text-2xs"
                        onClick={() => void handleReacquireToken()}
                        loading={reacquiring}
                        aria-label="Re-acquire ARM token (force refresh)"
                      >
                        {!reacquiring && (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Re-acquire token
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-2xs"
                        onClick={() => goTo("/azure-accounts")}
                        aria-label="Open Azure Accounts to switch tenant"
                      >
                        Open Azure Accounts
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-2xs"
                        onClick={() => goTo("/token-importer")}
                        aria-label="Open Token Importer to paste a fresh token"
                      >
                        Open Token Importer
                      </Button>
                    </div>
                    <span className="break-all text-[10px] opacity-80">
                      Raw error: {submitError}
                    </span>
                  </AlertDescription>
                </Alert>
              )}
              {submitError && missingRole && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription className="flex flex-col gap-2">
                    <span>
                      <strong>
                        AAD: the signed-in principal isn't allowed to
                        create subscriptions on this enrollment
                        account.
                      </strong>{" "}
                      The modern alias API checks a specific
                      billing-role assignment — being an "Account Owner"
                      in the EA portal is{" "}
                      <strong>not</strong> the same thing.
                    </span>
                    <span className="text-2xs">
                      What's needed: the role{" "}
                      <strong>EA Subscription Creator</strong>{" "}
                      (definition GUID{" "}
                      <code className="font-mono">
                        a0bcee42-bf30-4d1b-926a-48d21664ef71
                      </code>
                      ) assigned to your AAD principal at scope{" "}
                      <code className="break-all font-mono">
                        {billingScope}
                      </code>
                      . An Enterprise Administrator (or another EA
                      Subscription Creator) on the parent billing
                      account can grant it.
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="h-7 text-2xs"
                        onClick={() =>
                          setConfirmDialog({ kind: "navigate-sub-manager" })
                        }
                      >
                        Open Sub Manager → Grant Subscription Creator
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-2xs"
                        asChild
                      >
                        <a
                          href="https://ea.azure.com"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open ea.azure.com
                        </a>
                      </Button>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      CLI equivalent (an admin runs it):{" "}
                      <code className="break-all font-mono">
                        {`az rest -m PUT --url "https://management.azure.com${billingScope}/billingRoleAssignments/$(uuidgen)?api-version=2024-04-01" --body '{"properties":{"principalId":"<YOUR_OBJECT_ID>","principalTenantId":"<YOUR_TENANT_ID>","roleDefinitionId":"/providers/Microsoft.Billing/billingAccounts/<BA_NAME>/billingRoleDefinitions/a0bcee42-bf30-4d1b-926a-48d21664ef71"}}'`}
                      </code>
                    </span>
                    <span className="break-all text-[10px] opacity-80">
                      Raw error: {submitError}
                    </span>
                  </AlertDescription>
                </Alert>
              )}
              {submitError && !missingRole && !passthroughToken && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              {/* Proactive "no oid" warning — surfaced as soon as we
                  decode the ARM token, BEFORE the operator submits, so
                  they can fix the underlying tenant-membership issue
                  instead of finding out via a 401 from ARM. */}
              {armToken && noOidDetected && (
                <Alert variant="warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <AlertDescription className="flex flex-col gap-1.5 text-xs">
                    <span>
                      <strong>
                        The ARM token has no <code className="font-mono">oid</code> claim.
                      </strong>{" "}
                      That means the signed-in principal{" "}
                      <code className="font-mono">
                        {armTokenClaims?.upn || account?.username || ""}
                      </code>{" "}
                      is not a member of tenant{" "}
                      <code className="font-mono">{armTokenClaims?.tid}</code>
                      — they have no object id IN that tenant, so the
                      Subscription RP rejects the call (and nothing can
                      grant a role to a missing principal).
                    </span>
                    <span className="text-2xs">
                      <strong>Fix:</strong> on Azure Accounts, switch the
                      tenant for this account back to the principal's
                      HOME tenant (the one where they're a member, not
                      a guest). If the EA enrollment lives in a
                      different tenant and you still need this
                      principal to create subs there, an Entra admin in
                      the EA tenant needs to invite{" "}
                      <code className="font-mono">
                        {armTokenClaims?.upn || ""}
                      </code>{" "}
                      as a guest first — once accepted, AAD provisions
                      an oid for the guest and a fresh token will carry
                      it.
                    </span>
                  </AlertDescription>
                </Alert>
              )}

              {/* Pre-grant role checkbox + live status. */}
              <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card/40 p-2.5">
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    checked={preGrantRole}
                    onCheckedChange={(v) => setPreGrantRole(v === true)}
                    aria-label="Pre-grant EA Subscription Creator role before creating the subscription"
                    className="mt-0.5"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-semibold text-foreground">
                      Pre-grant EA Subscription Creator role first
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      PUTs the role assignment at the enrollment-account
                      scope for this principal BEFORE the alias-create
                      call, so the create can't fail with "not authorized".
                      Idempotent — re-running is safe; 409 / "already
                      exists" is treated as success.
                    </span>
                  </span>
                </label>
                {preGrantRole && armTokenClaims && (
                  <div className="ml-6 flex flex-wrap items-center gap-1.5 text-2xs">
                    <span className="text-muted-foreground">
                      Will grant to:
                    </span>
                    <code className="font-mono">
                      {armTokenClaims.oid || "(none — see warning above)"}
                    </code>
                    <span className="text-muted-foreground">in tenant</span>
                    <code className="font-mono">{armTokenClaims.tid}</code>
                  </div>
                )}
                {preGrantStatus === "granting" && (
                  <div className="ml-6 flex items-center gap-1.5 text-2xs text-info">
                    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                    Granting EA Subscription Creator…
                  </div>
                )}
                {preGrantStatus === "granted" && (
                  <div className="ml-6 flex items-center gap-1.5 text-2xs text-success">
                    <CheckCircle2 className="h-3 w-3" />
                    Role granted. Proceeding with alias create…
                  </div>
                )}
                {preGrantStatus === "already-granted" && (
                  <div className="ml-6 flex items-center gap-1.5 text-2xs text-success">
                    <CheckCircle2 className="h-3 w-3" />
                    Role was already assigned (no-op). Proceeding with
                    alias create…
                  </div>
                )}
                {preGrantStatus === "failed" && preGrantError && (
                  <div className="ml-6 flex items-start gap-1.5 text-2xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="min-w-0 break-words">{preGrantError}</span>
                  </div>
                )}
              </div>

              {/* ----- Preflight checklist (live) --------------- */}
              <div
                className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/20 p-2.5"
                role="region"
                aria-label="Preflight checklist"
                aria-live="polite"
              >
                <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  <ShieldCheck className="h-3 w-3" />
                  Preflight
                  {preflightBlocking === 0 ? (
                    <Badge variant="success" className="text-[9px]">
                      ready
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="text-[9px]">
                      {preflightBlocking} blocking
                    </Badge>
                  )}
                </div>
                <ul className="flex flex-wrap gap-1.5">
                  {preflight.map((row) => (
                    <li
                      key={row.label}
                      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-2xs"
                      aria-label={`${row.label}: ${row.ok ? "ok" : "blocked"}${row.hint ? ` (${row.hint})` : ""}`}
                    >
                      {row.ok ? (
                        <Check
                          className={
                            row.tone === "success"
                              ? "h-3 w-3 text-success"
                              : "h-3 w-3 text-warning"
                          }
                          aria-hidden
                        />
                      ) : row.tone === "muted" ? (
                        <Info
                          className="h-3 w-3 text-muted-foreground"
                          aria-hidden
                        />
                      ) : (
                        <XCircle className="h-3 w-3 text-destructive" aria-hidden />
                      )}
                      <span className="font-medium">{row.label}</span>
                      {row.hint && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {row.hint}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-[10px] text-muted-foreground">
                  Local checks only — Azure-side quota & role enforcement run
                  on submit.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="default"
                  onClick={handleCreateClick}
                  disabled={!canSubmit}
                  loading={submitting}
                  aria-label={
                    submitting
                      ? "Creating EA subscription, polling alias"
                      : "Create EA subscription"
                  }
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  title={`Create subscription (${modKeyLabel()}+Enter)`}
                >
                  {!submitting && <CheckCircle2 />}
                  {submitting ? "Creating & polling…" : "Create subscription"}
                </Button>
                <span
                  className="inline-flex items-center gap-1 text-2xs text-muted-foreground"
                  aria-hidden
                >
                  <Keyboard className="h-3 w-3" />
                  <kbd className="rounded border border-border/60 bg-muted/40 px-1 font-mono text-[10px]">
                    {modKeyLabel()}+Enter
                  </kbd>
                </span>
                {submitting && (
                  <div
                    className="flex items-center gap-2 text-2xs text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    <span>
                      Elapsed: {(submitElapsedMs / 1000).toFixed(1)}s
                    </span>
                    {showPollingPulse && (
                      <span className="flex items-center gap-1 text-info">
                        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                        Azure accepted (202) — polling alias until
                        terminal state. EA provisioning can take 1–3
                        minutes; the page is doing the work, don't
                        navigate away.
                      </span>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ----- Result -------------------------------------- */}
          {result && (
            <Card
              className={
                result.provisioningState.toLowerCase() === "succeeded"
                  ? "border-success/30 bg-success/5"
                  : "border-warning/30 bg-warning/5"
              }
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  {result.provisioningState.toLowerCase() === "succeeded" ? (
                    <Check className="h-4 w-4 text-success" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-warning motion-reduce:animate-none" />
                  )}
                  Alias result —{" "}
                  <code className="font-mono">{result.provisioningState}</code>
                </CardTitle>
                <CardDescription className="text-2xs">
                  Took{" "}
                  <code className="font-mono">
                    {(result.durationMs / 1000).toFixed(1)}s
                  </code>{" "}
                  via{" "}
                  <code className="font-mono">
                    {result.polled ? "202 → poll" : "200 (sync)"}
                  </code>
                  . <strong>Succeeded</strong> = the subscription is
                  live; anything else = Azure is still working on it,
                  re-poll the alias URL or refresh{" "}
                  <a
                    href="https://portal.azure.com/#@/blade/Microsoft_Azure_Billing/EnrollmentBlade"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline-offset-2 hover:underline"
                  >
                    portal.azure.com
                  </a>{" "}
                  in a minute.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-2xs">
                    alias
                  </Badge>
                  <CopyableText
                    value={result.aliasName}
                    mono
                    ariaLabel="Copy alias name"
                    alwaysVisibleButton
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-2xs">
                    displayName
                  </Badge>
                  <span className="font-medium">{result.displayName}</span>
                </div>
                {result.subscriptionId && (
                  <div className="group/copy flex flex-wrap items-center gap-2">
                    <Badge variant="success" className="text-2xs">
                      subscription
                    </Badge>
                    <code className="break-all font-mono">
                      {result.subscriptionId}
                    </code>
                    <CopyButton
                      value={result.subscriptionId}
                      ariaLabel="Copy subscription id"
                      alwaysVisible
                    />
                    <a
                      href={`https://portal.azure.com/#@/resource/subscriptions/${result.subscriptionId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="Open subscription in Azure portal"
                    >
                      <ExternalLink className="h-3 w-3" /> Open in portal
                    </a>
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    setResult(null);
                    setAliasName(generateAliasName());
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> Create another
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ----- Submitted-aliases history (session-scoped) ------- */}
      {submittedAliases.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <History className="h-4 w-4 text-primary" />
                Submitted this session ({submittedAliases.length})
                {submittedAliases.length === HISTORY_MAX_ROWS && (
                  <Badge variant="outline" className="text-[9px]">
                    cap reached
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-2xs">
                In-memory log of aliases PUT during this page session.
                Cleared on reload — the audit log keeps the canonical
                record. Capped at {HISTORY_MAX_ROWS} rows.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1.5">
              <ExportMenu<SubmittedAlias>
                rows={submittedAliases}
                columns={exportColumns}
                filename="ea-sub-quick-submitted"
                jsonMetadata={{
                  page: "ea-sub-quick",
                  actor: account?.username ?? "",
                }}
                label="Export"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-2xs"
                onClick={() => setConfirmDialog({ kind: "clear-history" })}
                aria-label="Clear submitted history"
              >
                <Trash2 className="h-3 w-3" /> Clear
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            {submittedAliases.map((row) => (
              <div
                key={`${row.aliasName}-${row.submittedAt}`}
                className="group/copy flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-2xs"
              >
                <Badge
                  variant={
                    row.provisioningState === "Succeeded"
                      ? "success"
                      : row.provisioningState.toLowerCase() === "failed"
                        ? "destructive"
                        : "outline"
                  }
                  className="text-[9px]"
                >
                  {row.provisioningState === "Succeeded" ? (
                    <Check className="mr-0.5 h-2.5 w-2.5" />
                  ) : row.provisioningState.toLowerCase() === "failed" ? (
                    <XCircle className="mr-0.5 h-2.5 w-2.5" />
                  ) : (
                    <Loader2 className="mr-0.5 h-2.5 w-2.5 animate-spin motion-reduce:animate-none" />
                  )}
                  {row.provisioningState}
                </Badge>
                {row.crossTenant && (
                  <Badge variant="outline" className="text-[9px]">
                    cross-tenant
                  </Badge>
                )}
                <span className="font-medium">{row.displayName}</span>
                <CopyableText
                  value={row.aliasName}
                  mono
                  ariaLabel="Copy alias name"
                />
                {row.subscriptionId && (
                  <CopyableText
                    value={row.subscriptionId}
                    mono
                    ariaLabel="Copy subscription id"
                  />
                )}
                <span className="text-muted-foreground">
                  {(row.durationMs / 1000).toFixed(1)}s
                  {row.polled ? " (polled)" : ""}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {new Date(row.submittedAt).toLocaleTimeString()}
                </span>
                {row.subscriptionId && (
                  <a
                    href={`https://portal.azure.com/#@/resource/subscriptions/${row.subscriptionId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                    aria-label="Open subscription in Azure portal"
                    title="Open in Azure portal"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ArrowRight className="h-4 w-4 text-primary" />
            Related
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => goTo("/ea-subscription")}
            aria-label="Open Multi-recipient EA Sub creator"
          >
            <Server className="h-3.5 w-3.5" /> Multi-recipient EA Sub creator
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => goTo("/department-admin")}
            aria-label="Open Department Admin workspace"
          >
            <Building2 className="h-3.5 w-3.5" /> Department Admin workspace
          </Button>
        </CardContent>
      </Card>

      {/* ----- Confirmation dialog --------------------------------- */}
      <ConfirmationDialog
        hidden={confirmDialog == null}
        loading={submitting}
        title={
          confirmDialog?.kind === "create"
            ? "Create EA subscription"
            : confirmDialog?.kind === "navigate-sub-manager"
              ? "Open Sub Manager?"
              : confirmDialog?.kind === "clear-history"
                ? "Clear session history?"
                : ""
        }
        confirmText={
          confirmDialog?.kind === "create"
            ? "Create subscription"
            : confirmDialog?.kind === "navigate-sub-manager"
              ? "Open Sub Manager"
              : confirmDialog?.kind === "clear-history"
                ? "Clear"
                : "Confirm"
        }
        danger={confirmDialog?.kind === "clear-history"}
        message={
          confirmDialog?.kind === "create" ? (
            <div className="flex flex-col gap-2 text-xs">
              <p>
                About to PUT one new EA subscription against{" "}
                <code className="break-all font-mono">{billingScope}</code>.
              </p>
              <ul className="ml-4 flex list-disc flex-col gap-0.5">
                <li>
                  Alias name: <code className="font-mono">{aliasName}</code>
                </li>
                <li>
                  Display name:{" "}
                  <code className="font-mono">
                    {applyDisplayNameTokens(displayName.trim(), {
                      counter,
                      username: account?.username,
                    })}
                  </code>
                </li>
                <li>
                  Workload: <code className="font-mono">{workload}</code>
                </li>
                {preGrantRole && (
                  <li className="text-warning">
                    Will first <strong>PUT a billing-role assignment</strong>{" "}
                    granting EA Subscription Creator to{" "}
                    <code className="font-mono">
                      {armTokenClaims?.oid || "(no oid)"}
                    </code>
                    .
                  </li>
                )}
                {crossTenantRequested && (
                  <li className="text-warning">
                    <strong>Cross-tenant landing.</strong> Sub will land
                    in tenant{" "}
                    <code className="font-mono">
                      {subscriptionTenantId.trim()}
                    </code>{" "}
                    with owner{" "}
                    <code className="font-mono">
                      {subscriptionOwnerId.trim()}
                    </code>{" "}
                    — owner has 7 days to accept.
                  </li>
                )}
                {customScopeMode && (
                  <li className="text-info">
                    Using a custom billingScope (BA/EA pickers bypassed).
                  </li>
                )}
                {tagsForBody && Object.keys(tagsForBody).length > 0 && (
                  <li>
                    Tags:{" "}
                    <code className="font-mono">
                      {Object.entries(tagsForBody)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ")}
                    </code>
                  </li>
                )}
              </ul>
            </div>
          ) : confirmDialog?.kind === "navigate-sub-manager" ? (
            <p className="text-xs">
              This will open Sub Manager and pre-select the Grant
              Subscription Creator tab with this billing account already
              filled in. Your form state on this page is preserved (it's
              session-scoped); use the browser back button to return.
            </p>
          ) : confirmDialog?.kind === "clear-history" ? (
            <p className="text-xs">
              Removes all {submittedAliases.length} session-history rows.
              The audit log keeps the canonical record — only the in-page
              list and export buffer are wiped.
            </p>
          ) : (
            ""
          )
        }
        onCancel={() => setConfirmDialog(null)}
        onConfirm={async () => {
          const kind = confirmDialog?.kind;
          if (kind === "create") {
            setConfirmDialog(null);
            await submit();
          } else if (kind === "navigate-sub-manager") {
            setConfirmDialog(null);
            handleNavigateSubManager();
          } else if (kind === "clear-history") {
            setSubmittedAliases([]);
            setConfirmDialog(null);
          } else {
            setConfirmDialog(null);
          }
        }}
      />

      {/* Silence "unused" warning for selectedEa — exposed for future
          use (deep-link to enrollment account, debug, etc.). */}
      {false && selectedEa && <span aria-hidden>{selectedEa.name}</span>}
    </div>
  );
};
