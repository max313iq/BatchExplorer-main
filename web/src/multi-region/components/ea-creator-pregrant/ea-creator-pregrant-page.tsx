/**
 * Pre-grant EA Subscription Creator role — standalone page.
 *
 * Single-purpose flow operators run BEFORE opening "Create EA Sub (quick)"
 * to make sure the principal already has the role on the target
 * enrollment account. Avoids the missing-role 401 round-trip that
 * ea-sub-quick otherwise eats on first attempt.
 *
 * Flow:
 *   1. Pick a signed-in Azure account (acts as the GRANTER — must hold
 *      Enrollment Account Owner / Department Admin / EA admin on the BA).
 *   2. Pick the billing account, then the enrollment account.
 *   3. Enter one or more principals (UPN/email — auto-resolved via Graph
 *      — or raw objectId UUIDs). Bulk paste supports newline/comma/semicolon
 *      separators so the operator can grant in one sweep.
 *   4. Enter the principal(s)' tenant id (defaults to the granter's tenant;
 *      override for cross-tenant guests).
 *   5. Review the resolved principals, confirm in the modal, submit.
 *      409 / "already exists" is treated as a no-op success per-principal.
 *
 * Notable improvements over the original:
 *   - Principal preview: as the operator types, we resolve UPN→oid via
 *     Graph (debounced) so the confirm dialog shows the real display name
 *     and object id BEFORE submit. On the "already-granted" path, the
 *     resolved oid is now correct (the original showed the raw input).
 *   - Multi-principal grant runs in parallel with per-row status.
 *   - Caller-role pre-check via diagnoseCallerBillingRole — shows whether
 *     the SELECTED granter actually has admin rights on the chosen scope,
 *     instead of waiting for the grant PUT to fail.
 *   - Existing-grants panel lists every EaSubscriptionCreator already
 *     assigned at the chosen scope, with a revoke action (destructive,
 *     guarded by ConfirmationDialog).
 *   - Session activity panel surfaces every grant/revoke/lookup the
 *     operator has performed in the current session, with copy buttons
 *     on every id and a CSV/JSON export.
 *   - Force-refresh-token toggle. ARM RBAC propagation is eventually
 *     consistent: after a grant, the SAME bearer token still 401s for a
 *     few seconds. Forcing a token refresh on the next "Create EA Sub"
 *     call eliminates the round-trip — we recommend it after every grant.
 *   - All fetches are race-safe: ARM token comes from useArmToken (single
 *     source of truth) so a tenant switch mid-flow doesn't leak a stale
 *     token to the BA/EA fetches. Per-effect cancellation tokens prevent
 *     out-of-order responses from clobbering newer state.
 *   - Token-tracker preserved per page contract; the existing-grants
 *     panel re-fetches after a successful grant so the lists stay in sync.
 *
 * This duplicates capability in Sub Manager's "Grant" tab, but the
 * dedicated page is easier to point operators at and decouples the
 * pre-grant decision from the rest of Sub Manager's surface.
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  X,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { auditLog } from "../../services/audit-log";
import { getGraphTokenForAccount } from "../../auth/msal-auth";
import { useArmToken } from "../../auth/use-arm-token";
import {
  createEnrollmentAccountRoleAssignment,
  deleteBillingRoleAssignment,
  findUserByUpnOrMail,
  listBillingRoleAssignments,
  listEaBillingAccounts,
  listEnrollmentAccounts,
  ROLE_EA_SUBSCRIPTION_CREATOR,
  EA_BILLING_ROLE_NAMES,
} from "../../services";
import { diagnoseCallerBillingRole } from "../../services/arm-service";
import type {
  EaBillingAccount,
  EaEnrollmentAccount,
  BillingRoleAssignmentSummary,
} from "../../services";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import type { AuditEntry } from "../../store/store-types";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useUrlState } from "../../hooks/use-url-state";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import type { ExportColumn } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

interface SourceAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GUIDs for billing roles that satisfy "can grant role assignments at the EA scope". */
const ROLE_ENTERPRISE_ADMIN = "9f1983cb-2574-400c-87e9-34cf8e2280db";
const ROLE_EA_ACCOUNT_OWNER = "c15c22c0-9faf-424c-9b7e-bd91c06a240b";
const ROLE_DEPARTMENT_ADMIN = "db609904-a47f-4794-9be8-9bd86fbffd8a";
/** EA roles whose holders are typically able to grant EaSubscriptionCreator. */
const GRANTER_CAPABLE_ROLES = new Set([
  ROLE_ENTERPRISE_ADMIN.toLowerCase(),
  ROLE_EA_ACCOUNT_OWNER.toLowerCase(),
  ROLE_DEPARTMENT_ADMIN.toLowerCase(),
]);

/** Status of a single per-principal grant in the current submission. */
type RowStatus =
  | { kind: "pending" }
  | { kind: "resolving" }
  | { kind: "granting" }
  | { kind: "granted"; oid: string; roleAssignmentId: string }
  | { kind: "already-granted"; oid: string }
  | { kind: "failed"; error: string };

/** A single principal entered by the operator, plus any cached resolution. */
interface PrincipalRow {
  /** Raw text the operator typed (UPN/email/UUID). */
  input: string;
  /** Resolved object id (after Graph lookup) if input is a UPN. */
  resolvedOid: string | null;
  /** Resolved display name (after Graph lookup). */
  resolvedDisplayName: string | null;
  /** Resolved sign-in name (after Graph lookup). */
  resolvedUpn: string | null;
  /** "pending" / "ok" / "missing" / "error" from the lookup. */
  resolveState: "idle" | "resolving" | "ok" | "missing" | "error";
  /** If `resolveState === "error"`, the message. */
  resolveError?: string;
  /** Final per-grant status during submission. */
  status: RowStatus;
}

/**
 * Shape of the URL-shared selection state. Extends the open-ended
 * `Record<string, string | string[] | undefined>` constraint that `useUrlState`
 * requires so TypeScript accepts the type parameter without a cast.
 */
interface PregrantUrlState
  extends Record<string, string | string[] | undefined> {
  /** Selected billing-account name (matches `EaBillingAccount.name`). */
  ba?: string;
  /** Selected enrollment-account name (matches `EaEnrollmentAccount.name`). */
  ea?: string;
  /** Active tab — `undefined` collapses to the default "grant" tab. */
  tab?: string;
}
const INITIAL_URL_STATE: PregrantUrlState = {
  ba: undefined,
  ea: undefined,
  tab: undefined,
};

/** Build an initial blank principal row from raw text input. */
function makeRow(input: string): PrincipalRow {
  const trimmed = input.trim();
  const isUuid = UUID_RE.test(trimmed);
  return {
    input: trimmed,
    resolvedOid: isUuid ? trimmed : null,
    resolvedDisplayName: null,
    resolvedUpn: null,
    // UUIDs are taken as-is; UPNs need resolving on submit.
    resolveState: isUuid ? "ok" : "idle",
    status: { kind: "pending" },
  };
}

/** Split a bulk-paste string by newline/comma/semicolon and dedupe. */
function splitBulkInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\r\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

/** Short hash from a string — used to stable-key principal rows. */
function rowKey(input: string, idx: number): string {
  return `${idx}:${input.toLowerCase()}`;
}

export const EaCreatorPregrantPage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const navigate = useNavigate();

  // -------------------------------------------------------------------------
  // Granter account selection
  // -------------------------------------------------------------------------
  //
  // We don't pre-filter to "accounts with EA admin rights" — the BA-list
  // call will simply be empty for accounts without access, and the operator
  // should always see the accounts they expect to be present.
  const candidates: SourceAccount[] = React.useMemo(
    () =>
      (state.azureAccounts ?? []).map((a) => ({
        homeAccountId: a.homeAccountId,
        tenantId: a.tenantId,
        username: a.username,
        name: a.name,
      })),
    [state.azureAccounts],
  );

  const [accountId, setAccountId] = React.useState<string>("");
  React.useEffect(() => {
    if (
      candidates.length > 0 &&
      !candidates.some((c) => c.homeAccountId === accountId)
    ) {
      setAccountId(candidates[0]!.homeAccountId);
    }
  }, [candidates, accountId]);

  // -------------------------------------------------------------------------
  // URL state — keep BA / EA / tab selection in the query string so operators
  // can deep-link straight to a pregrant scope from chat or a runbook.
  // -------------------------------------------------------------------------
  const [urlState, setUrlState] = useUrlState<PregrantUrlState>(
    INITIAL_URL_STATE,
  );
  const setBaParam = React.useCallback(
    (name: string) => setUrlState({ ba: name || undefined }),
    [setUrlState],
  );
  const setEaParam = React.useCallback(
    (name: string) => setUrlState({ ea: name || undefined }),
    [setUrlState],
  );
  const setTabParam = React.useCallback(
    (value: string) =>
      setUrlState({ tab: value === "grant" ? undefined : value }),
    [setUrlState],
  );
  const activeTab =
    urlState.tab === "existing" || urlState.tab === "activity"
      ? urlState.tab
      : "grant";

  // -------------------------------------------------------------------------
  // Persisted UI prefs — "show pending pregrants only" filter on the
  // existing-assignments tab + the stale-pregrant threshold (days). Survives
  // reload so the operator's saved view is sticky between sessions.
  // -------------------------------------------------------------------------
  const [creatorsOnlyFilter, setCreatorsOnlyFilter] = usePersistedState<boolean>(
    "ea-creator-pregrant.creatorsOnly",
    true,
  );
  const STALE_DAYS = 7;
  const account = React.useMemo(
    () => candidates.find((c) => c.homeAccountId === accountId) ?? null,
    [candidates, accountId],
  );

  // -------------------------------------------------------------------------
  // ARM token tracker (single source of truth)
  // -------------------------------------------------------------------------
  //
  // Previously the page mirrored armTokenTracker.token into a local
  // `armToken` state — a redundancy that created a one-render lag during
  // tenant switches and risked the BA fetch firing with a stale token.
  // We now use `armTokenTracker.token` directly throughout.
  const armTokenTracker = useArmToken(
    account?.homeAccountId,
    account?.tenantId,
  );
  const armToken = armTokenTracker.token;

  // -------------------------------------------------------------------------
  // Billing accounts under the granter
  // -------------------------------------------------------------------------
  const [billingAccounts, setBillingAccounts] = React.useState<
    EaBillingAccount[]
  >([]);
  const [baLoading, setBaLoading] = React.useState(false);
  const [baError, setBaError] = React.useState<string | null>(null);
  /** Bumped to force a refetch (e.g. user clicks "Refresh"). */
  const [baReloadTick, setBaReloadTick] = React.useState(0);
  React.useEffect(() => {
    if (!armToken) {
      setBillingAccounts([]);
      setBaError(null);
      return;
    }
    let cancelled = false;
    setBaLoading(true);
    setBaError(null);
    listEaBillingAccounts(armToken)
      .then((list) => {
        if (!cancelled) setBillingAccounts(list);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setBaError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [armToken, baReloadTick]);

  const [billingAccountName, setBillingAccountName] = React.useState<string>(
    () => urlState.ba ?? "",
  );
  React.useEffect(() => {
    if (
      billingAccounts.length > 0 &&
      !billingAccounts.some((b) => b.name === billingAccountName)
    ) {
      // Prefer the URL-provided BA if it's now in the list (the list
      // arrived after the URL was parsed); otherwise fall back to the
      // first available BA.
      const fromUrl = urlState.ba
        ? billingAccounts.find((b) => b.name === urlState.ba)
        : undefined;
      setBillingAccountName(fromUrl ? fromUrl.name : billingAccounts[0]!.name);
    } else if (billingAccounts.length === 0 && billingAccountName) {
      // Clear stale selection if the BA list became empty (e.g. after
      // switching to an account without EA access).
      setBillingAccountName("");
    }
  }, [billingAccounts, billingAccountName, urlState.ba]);
  // Keep the URL in sync whenever the operator picks a different BA.
  React.useEffect(() => {
    if (billingAccountName !== (urlState.ba ?? "")) {
      setBaParam(billingAccountName);
    }
  }, [billingAccountName, urlState.ba, setBaParam]);

  // -------------------------------------------------------------------------
  // Enrollment accounts under the selected BA
  // -------------------------------------------------------------------------
  const [eas, setEas] = React.useState<EaEnrollmentAccount[]>([]);
  const [eaLoading, setEaLoading] = React.useState(false);
  const [eaError, setEaError] = React.useState<string | null>(null);
  const [eaReloadTick, setEaReloadTick] = React.useState(0);
  React.useEffect(() => {
    if (!armToken || !billingAccountName) {
      setEas([]);
      setEaError(null);
      return;
    }
    let cancelled = false;
    setEaLoading(true);
    setEaError(null);
    listEnrollmentAccounts(billingAccountName, armToken)
      .then((list) => {
        if (!cancelled) setEas(list);
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
  }, [armToken, billingAccountName, eaReloadTick]);

  const [eaName, setEaName] = React.useState<string>(() => urlState.ea ?? "");
  React.useEffect(() => {
    if (eas.length > 0 && !eas.some((e) => e.name === eaName)) {
      const fromUrl = urlState.ea
        ? eas.find((e) => e.name === urlState.ea)
        : undefined;
      setEaName(fromUrl ? fromUrl.name : eas[0]!.name);
    } else if (eas.length === 0 && eaName) {
      setEaName("");
    }
  }, [eas, eaName, urlState.ea]);
  React.useEffect(() => {
    if (eaName !== (urlState.ea ?? "")) {
      setEaParam(eaName);
    }
  }, [eaName, urlState.ea, setEaParam]);

  /** The enrollment-account ARM scope we'll write the grant against. */
  const enrollmentScope = React.useMemo(() => {
    if (!billingAccountName || !eaName) return "";
    return `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}/enrollmentAccounts/${eaName}`;
  }, [billingAccountName, eaName]);

  /** The currently-selected enrollment-account object for richer display. */
  const selectedEa = React.useMemo(
    () => eas.find((e) => e.name === eaName) ?? null,
    [eas, eaName],
  );

  // -------------------------------------------------------------------------
  // Caller-role diagnostic — can the SELECTED granter actually grant here?
  // -------------------------------------------------------------------------
  //
  // We resolve the granter's own oid from a fresh ARM token claim (sub or
  // oid) and then ask listBillingRoleAssignments which roles they hold at
  // the chosen enrollmentAccount scope. If none of those roles is in
  // GRANTER_CAPABLE_ROLES, we surface an inline warning BEFORE the grant
  // PUT fires — saving the operator from a confusing PUT 403.
  interface GranterDiag {
    /** Resolved oid for the granter's signed-in identity. */
    callerOid: string;
    /** Roles the caller already holds at the chosen scope. */
    roles: BillingRoleAssignmentSummary[];
    /** True if at least one role is in GRANTER_CAPABLE_ROLES. */
    canGrant: boolean;
  }
  const [granterDiag, setGranterDiag] = React.useState<GranterDiag | null>(
    null,
  );
  const [granterDiagLoading, setGranterDiagLoading] = React.useState(false);
  const [granterDiagError, setGranterDiagError] = React.useState<
    string | null
  >(null);
  const [diagReloadTick, setDiagReloadTick] = React.useState(0);
  React.useEffect(() => {
    if (!armToken || !enrollmentScope) {
      setGranterDiag(null);
      setGranterDiagError(null);
      return;
    }
    let cancelled = false;
    setGranterDiagLoading(true);
    setGranterDiagError(null);
    (async () => {
      try {
        // Extract caller oid from the token's `oid` (preferred) or `sub` claim.
        const callerOid = decodeOidFromArmToken(armToken);
        if (!callerOid) {
          throw new Error(
            "Could not extract caller object id from ARM token claims.",
          );
        }
        const d = await diagnoseCallerBillingRole(
          enrollmentScope,
          callerOid,
          armToken,
        );
        if (cancelled) return;
        const canGrant = d.assignments.some((a) =>
          GRANTER_CAPABLE_ROLES.has(a.roleDefinitionId.toLowerCase()),
        );
        setGranterDiag({ callerOid, roles: d.assignments, canGrant });
      } catch (err) {
        if (!cancelled)
          setGranterDiagError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setGranterDiagLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [armToken, enrollmentScope, diagReloadTick]);

  // -------------------------------------------------------------------------
  // Existing EaSubscriptionCreator assignments at the chosen scope
  // -------------------------------------------------------------------------
  const [existing, setExisting] = React.useState<
    BillingRoleAssignmentSummary[]
  >([]);
  const [existingLoading, setExistingLoading] = React.useState(false);
  const [existingError, setExistingError] = React.useState<string | null>(null);
  const [existingReloadTick, setExistingReloadTick] = React.useState(0);
  React.useEffect(() => {
    if (!armToken || !enrollmentScope) {
      setExisting([]);
      setExistingError(null);
      return;
    }
    let cancelled = false;
    setExistingLoading(true);
    setExistingError(null);
    listBillingRoleAssignments(enrollmentScope, armToken)
      .then((rows) => {
        if (!cancelled) setExisting(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setExistingError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setExistingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [armToken, enrollmentScope, existingReloadTick]);

  /** EaSubscriptionCreator-only subset, for the "current creators" stat. */
  const existingCreators = React.useMemo(
    () =>
      existing.filter(
        (a) =>
          a.roleDefinitionId.toLowerCase() ===
          ROLE_EA_SUBSCRIPTION_CREATOR.toLowerCase(),
      ),
    [existing],
  );

  /**
   * "Stale" EaSubscriptionCreator assignments — older than STALE_DAYS, and
   * the operator hasn't touched them in this session. We flag these so the
   * operator can audit/garden long-lived grants. A missing `createdOn`
   * (some EA APIs don't return it) is treated as "unknown" and excluded —
   * we don't want false positives from missing-metadata rows.
   */
  const staleCreators = React.useMemo(() => {
    const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
    return existingCreators.filter((a) => {
      if (!a.createdOn) return false;
      const t = Date.parse(a.createdOn);
      return Number.isFinite(t) && t < cutoff;
    });
  }, [existingCreators]);

  /**
   * Filtered view of `existing` that the table will actually render — gated
   * by the persisted "creators only" toggle. We keep `existing` (the raw
   * list) as the source-of-truth so the stat counts above stay accurate.
   */
  const existingFiltered = React.useMemo(() => {
    if (!creatorsOnlyFilter) return existing;
    return existingCreators;
  }, [creatorsOnlyFilter, existing, existingCreators]);

  /**
   * Memoized `Set` of stale-creator role-assignment ids so the row table
   * doesn't reallocate a new Set on every render — keeps the render-cost
   * proportional to the number of stale rows, not the table size.
   */
  const staleIdSet = React.useMemo(
    () => new Set(staleCreators.map((s) => s.id)),
    [staleCreators],
  );

  // -------------------------------------------------------------------------
  // Principal input — single-line or bulk
  // -------------------------------------------------------------------------
  const [bulkMode, setBulkMode] = React.useState(false);
  const [singleInput, setSingleInput] = React.useState("");
  const [bulkInput, setBulkInput] = React.useState("");
  const [principalTenantId, setPrincipalTenantId] = React.useState("");
  // Default principal tenant id to the granter's tenant.
  React.useEffect(() => {
    if (account && !principalTenantId) {
      setPrincipalTenantId(account.tenantId);
    }
  }, [account, principalTenantId]);

  /** Parsed inputs as PrincipalRow objects (no resolution yet). */
  const inputRows: PrincipalRow[] = React.useMemo(() => {
    if (bulkMode) {
      return splitBulkInput(bulkInput).map((s) => makeRow(s));
    }
    const t = singleInput.trim();
    return t ? [makeRow(t)] : [];
  }, [bulkMode, bulkInput, singleInput]);

  /**
   * Cache of resolved-principal results, keyed by `${tenantId}:${input}`.
   * Lookups are debounced so typing doesn't fire Graph on every keystroke.
   */
  const resolveCacheRef = React.useRef<
    Map<
      string,
      | { ok: true; id: string; displayName: string; upn: string }
      | { ok: false; missing?: boolean; error?: string }
    >
  >(new Map());

  /** Resolved-state overlay applied on top of inputRows for display. */
  const [resolved, setResolved] = React.useState<
    Map<string, PrincipalRow["resolveState"]>
  >(new Map());

  // Debounced auto-resolve. We pre-resolve UPNs so the confirm dialog shows
  // the real display name / oid; this also fixes the "already-granted shows
  // the raw input as oid" bug from the original page.
  React.useEffect(() => {
    if (!account) return;
    const tenant = principalTenantId.trim();
    if (!UUID_RE.test(tenant)) return;
    // Identify rows that need resolution (UPNs we haven't looked up).
    const pendingInputs = inputRows
      .filter((r) => !UUID_RE.test(r.input))
      .map((r) => r.input)
      .filter((input) => {
        const cacheKey = `${tenant}:${input.toLowerCase()}`;
        return !resolveCacheRef.current.has(cacheKey);
      });
    if (pendingInputs.length === 0) return;
    let cancelled = false;
    // Mark each pending row as "resolving" so the UI hints at progress.
    setResolved((prev) => {
      const next = new Map(prev);
      for (const input of pendingInputs) {
        next.set(input.toLowerCase(), "resolving");
      }
      return next;
    });
    const timer = window.setTimeout(async () => {
      let graphToken: string;
      try {
        graphToken = await getGraphTokenForAccount(
          account.homeAccountId,
          tenant,
        );
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        for (const input of pendingInputs) {
          const cacheKey = `${tenant}:${input.toLowerCase()}`;
          resolveCacheRef.current.set(cacheKey, { ok: false, error: msg });
        }
        setResolved((prev) => {
          const next = new Map(prev);
          for (const input of pendingInputs)
            next.set(input.toLowerCase(), "error");
          return next;
        });
        return;
      }
      // Resolve each in parallel — Graph is per-lookup, but the latency
      // dominates the round-trip count so parallelism wins.
      await Promise.all(
        pendingInputs.map(async (input) => {
          const cacheKey = `${tenant}:${input.toLowerCase()}`;
          try {
            const found = await findUserByUpnOrMail(
              tenant,
              input,
              graphToken,
            );
            if (cancelled) return;
            if (!found) {
              resolveCacheRef.current.set(cacheKey, {
                ok: false,
                missing: true,
              });
              setResolved((prev) => {
                const next = new Map(prev);
                next.set(input.toLowerCase(), "missing");
                return next;
              });
              return;
            }
            resolveCacheRef.current.set(cacheKey, {
              ok: true,
              id: found.id,
              displayName: found.displayName,
              upn: found.upn,
            });
            setResolved((prev) => {
              const next = new Map(prev);
              next.set(input.toLowerCase(), "ok");
              return next;
            });
          } catch (err) {
            if (cancelled) return;
            const msg = err instanceof Error ? err.message : String(err);
            resolveCacheRef.current.set(cacheKey, { ok: false, error: msg });
            setResolved((prev) => {
              const next = new Map(prev);
              next.set(input.toLowerCase(), "error");
              return next;
            });
          }
        }),
      );
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inputRows, principalTenantId, account]);

  /** Compose the live PrincipalRow[] for display + submit, filling from cache. */
  const liveRows: PrincipalRow[] = React.useMemo(() => {
    const tenant = principalTenantId.trim();
    return inputRows.map((r) => {
      if (UUID_RE.test(r.input)) {
        return { ...r, resolveState: "ok" as const, resolvedOid: r.input };
      }
      const cacheKey = `${tenant}:${r.input.toLowerCase()}`;
      const cached = resolveCacheRef.current.get(cacheKey);
      const state =
        resolved.get(r.input.toLowerCase()) ??
        (cached ? (cached.ok ? "ok" : cached.missing ? "missing" : "error") : "idle");
      if (cached && cached.ok) {
        return {
          ...r,
          resolveState: state,
          resolvedOid: cached.id,
          resolvedDisplayName: cached.displayName,
          resolvedUpn: cached.upn,
        };
      }
      if (cached && !cached.ok) {
        return {
          ...r,
          resolveState: state,
          resolveError: cached.error,
        };
      }
      return { ...r, resolveState: state };
    });
  }, [inputRows, principalTenantId, resolved]);

  /** Total/resolved counts feed the inline stat row. */
  const resolveStats = React.useMemo(() => {
    let ok = 0;
    let missing = 0;
    let resolving = 0;
    let error = 0;
    for (const r of liveRows) {
      if (r.resolveState === "ok") ok++;
      else if (r.resolveState === "missing") missing++;
      else if (r.resolveState === "resolving") resolving++;
      else if (r.resolveState === "error") error++;
    }
    return { total: liveRows.length, ok, missing, resolving, error };
  }, [liveRows]);

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------
  //
  // Submission state is decoupled from input state so the confirmation
  // dialog can show a frozen snapshot while the work runs and the user can
  // still safely edit/clear the form once it's done. `rowStatuses` is the
  // live per-principal status map keyed by rowKey().
  const [rowStatuses, setRowStatuses] = React.useState<
    Record<string, RowStatus>
  >({});
  const [submitting, setSubmitting] = React.useState(false);
  const [submitConfirmOpen, setSubmitConfirmOpen] = React.useState(false);
  /**
   * AbortController fired when the user clicks "Cancel batch" mid-grant.
   * Individual `createEnrollmentAccountRoleAssignment` calls do not yet
   * accept an AbortSignal (they don't expose one through the service
   * layer), but we use this flag to stop scheduling more rows AND to skip
   * post-completion side-effects (notifications + audit records).
   *
   * // COORDINATOR: createEnrollmentAccountRoleAssignment,
   * // deleteBillingRoleAssignment, listBillingRoleAssignments,
   * // listEaBillingAccounts, listEnrollmentAccounts,
   * // diagnoseCallerBillingRole and findUserByUpnOrMail in
   * // services/arm-service.ts and services/graph-service.ts do not yet
   * // accept an AbortSignal. The page protects itself with a per-effect
   * // `cancelled` flag + `cancelFlagRef` for batch ops, but in-flight
   * // network calls cannot actually be torn down on unmount or tenant
   * // switch — the response just gets dropped on arrival. Threading
   * // AbortSignal through each of these service entry points (and the
   * // shared fetch helper they call) would let useAbortableEffect short-
   * // circuit the network round-trip and would let "Cancel batch" abort
   * // an outstanding role-assignment PUT instead of only the next one.
   */
  const cancelFlagRef = React.useRef<{ cancelled: boolean }>({
    cancelled: false,
  });
  /** Frozen snapshot of which rows are in this submission. */
  const [submitBatchKeys, setSubmitBatchKeys] = React.useState<string[]>([]);

  /** Top-level batch summary for the activity panel. */
  const batchSummary = React.useMemo(() => {
    let granted = 0;
    let already = 0;
    let failed = 0;
    let inflight = 0;
    for (const key of submitBatchKeys) {
      const s = rowStatuses[key];
      if (!s) continue;
      if (s.kind === "granted") granted++;
      else if (s.kind === "already-granted") already++;
      else if (s.kind === "failed") failed++;
      else if (
        s.kind === "pending" ||
        s.kind === "resolving" ||
        s.kind === "granting"
      )
        inflight++;
    }
    return {
      granted,
      already,
      failed,
      inflight,
      total: submitBatchKeys.length,
    };
  }, [rowStatuses, submitBatchKeys]);

  const tenantIsValid = UUID_RE.test(principalTenantId.trim());
  const formReady =
    !!account &&
    !!armToken &&
    !!billingAccountName &&
    !!eaName &&
    tenantIsValid &&
    liveRows.length > 0 &&
    liveRows.some((r) => r.resolveState !== "error");
  const canOpenConfirm =
    formReady && !submitting && resolveStats.resolving === 0;

  /** Open the confirmation dialog; the actual API calls happen on confirm. */
  const handleSubmitClick = React.useCallback(() => {
    if (!canOpenConfirm) return;
    setSubmitConfirmOpen(true);
  }, [canOpenConfirm]);

  const doSubmit = React.useCallback(async () => {
    if (!account || !armToken || !billingAccountName || !eaName) return;
    const tenant = principalTenantId.trim();
    if (!UUID_RE.test(tenant)) return;
    cancelFlagRef.current = { cancelled: false };
    setSubmitting(true);
    setSubmitConfirmOpen(false);

    // Initialise per-row status.
    const keys = liveRows.map((r, i) => rowKey(r.input, i));
    const initial: Record<string, RowStatus> = {};
    for (const k of keys) initial[k] = { kind: "pending" };
    setRowStatuses((prev) => ({ ...prev, ...initial }));
    setSubmitBatchKeys(keys);

    // Resolve any not-yet-resolved UPNs sequentially per-row (re-use cache)
    // and then fire the grants in parallel. We can't parallelize the
    // resolve step over a shared token because the Graph token may need
    // re-acquiring once; we batch the acquire once up-front.
    const upnRows = liveRows
      .map((r, i) => ({ r, i, key: keys[i]! }))
      .filter((x) => !UUID_RE.test(x.r.input));
    let graphToken: string | null = null;
    if (upnRows.length > 0) {
      try {
        graphToken = await getGraphTokenForAccount(
          account.homeAccountId,
          tenant,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const next: Record<string, RowStatus> = {};
        for (const x of upnRows) {
          next[x.key] = { kind: "failed", error: `Graph token: ${msg}` };
        }
        setRowStatuses((prev) => ({ ...prev, ...next }));
      }
    }
    if (graphToken !== null) {
      await Promise.all(
        upnRows.map(async (x) => {
          if (cancelFlagRef.current.cancelled) return;
          // Try cache first.
          const cacheKey = `${tenant}:${x.r.input.toLowerCase()}`;
          let cached = resolveCacheRef.current.get(cacheKey);
          if (!cached) {
            setRowStatuses((prev) => ({
              ...prev,
              [x.key]: { kind: "resolving" },
            }));
            try {
              const found = await findUserByUpnOrMail(
                tenant,
                x.r.input,
                graphToken!,
              );
              if (cancelFlagRef.current.cancelled) return;
              if (!found) {
                cached = { ok: false, missing: true };
              } else {
                cached = {
                  ok: true,
                  id: found.id,
                  displayName: found.displayName,
                  upn: found.upn,
                };
              }
              resolveCacheRef.current.set(cacheKey, cached);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              cached = { ok: false, error: msg };
              resolveCacheRef.current.set(cacheKey, cached);
            }
          }
          if (!cached.ok) {
            const msg = cached.missing
              ? `No user found in tenant ${tenant} matching "${x.r.input}". Paste the user's object id instead.`
              : (cached.error ?? "Graph lookup failed.");
            setRowStatuses((prev) => ({
              ...prev,
              [x.key]: { kind: "failed", error: msg },
            }));
          }
        }),
      );
    }

    // Fire grants in parallel for every row that now has a resolved oid.
    const grantTargets: Array<{ key: string; oid: string; label: string }> =
      [];
    for (const x of liveRows.map((r, i) => ({ r, i, key: keys[i]! }))) {
      if (cancelFlagRef.current.cancelled) break;
      const cacheKey = `${tenant}:${x.r.input.toLowerCase()}`;
      const oid = UUID_RE.test(x.r.input)
        ? x.r.input
        : resolveCacheRef.current.get(cacheKey)?.ok
          ? (resolveCacheRef.current.get(cacheKey) as { id: string }).id
          : null;
      if (!oid) continue;
      const label = !UUID_RE.test(x.r.input) ? x.r.input : oid;
      grantTargets.push({ key: x.key, oid, label });
    }
    // Local outcome accumulator — avoids the stale-closure trap of reading
    // `rowStatuses` after the awaits resolve (React batches state updates).
    type Outcome = "granted" | "already" | "failed";
    const outcomes = new Map<string, Outcome>();
    await Promise.all(
      grantTargets.map(async (g) => {
        if (cancelFlagRef.current.cancelled) {
          setRowStatuses((prev) => ({
            ...prev,
            [g.key]: { kind: "failed", error: "Cancelled" },
          }));
          outcomes.set(g.key, "failed");
          return;
        }
        setRowStatuses((prev) => ({
          ...prev,
          [g.key]: { kind: "granting" },
        }));
        try {
          // Surface `userEmailAddress` to the EA backend whenever we
          // have one — EA-agreement tenants frequently require it on
          // the modern billing-role-assignment endpoint and the
          // alternative is an opaque 500. UPN resolution above already
          // populated `resolveCacheRef` with the canonical UPN; reuse
          // it. Falls through to undefined for direct-UUID inputs.
          const cacheEntry = resolveCacheRef.current.get(
            `${tenant}:${g.label.toLowerCase()}`,
          );
          const userEmailAddress =
            cacheEntry?.ok === true ? cacheEntry.upn : undefined;
          const r = await createEnrollmentAccountRoleAssignment(
            billingAccountName,
            eaName,
            g.oid,
            tenant,
            ROLE_EA_SUBSCRIPTION_CREATOR,
            armToken,
            { userEmailAddress },
          );
          if (cancelFlagRef.current.cancelled) return;
          setRowStatuses((prev) => ({
            ...prev,
            [g.key]: {
              kind: "granted",
              oid: g.oid,
              roleAssignmentId: r.id,
            },
          }));
          outcomes.set(g.key, "granted");
          auditLog.record({
            actor: account.username,
            action: "grant_ea_subscription_creator",
            target: g.oid,
            status: "success",
            details: {
              page: "ea-creator-pregrant",
              billingAccountName,
              enrollmentAccountName: eaName,
              principalTenantId: tenant,
              principalInput: g.label,
              roleAssignmentId: r.id,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Idempotent: an existing assignment is silently OK. Some EA
          // tenants surface this as 409 conflict, others as 400 with
          // "already exists" — be liberal in what we accept.
          if (/409|already\s*exists|conflict|RoleAssignmentExists/i.test(msg)) {
            setRowStatuses((prev) => ({
              ...prev,
              [g.key]: { kind: "already-granted", oid: g.oid },
            }));
            outcomes.set(g.key, "already");
            // We DO record this in the audit log so the operator can see
            // the no-op event later; mark as success but flag in details.
            auditLog.record({
              actor: account.username,
              action: "grant_ea_subscription_creator",
              target: g.oid,
              status: "success",
              details: {
                page: "ea-creator-pregrant",
                billingAccountName,
                enrollmentAccountName: eaName,
                principalTenantId: tenant,
                principalInput: g.label,
                noOp: true,
                reason: "Principal already had EaSubscriptionCreator",
              },
            });
            return;
          }
          if (cancelFlagRef.current.cancelled) return;
          setRowStatuses((prev) => ({
            ...prev,
            [g.key]: { kind: "failed", error: msg },
          }));
          outcomes.set(g.key, "failed");
          auditLog.record({
            actor: account.username,
            action: "grant_ea_subscription_creator",
            target: g.label,
            status: "failure",
            details: {
              page: "ea-creator-pregrant",
              billingAccountName,
              enrollmentAccountName: eaName,
              principalTenantId: tenant,
              error: msg,
            },
            error: msg,
          });
        }
      }),
    );

    setSubmitting(false);
    // Refresh the existing-assignments panel + diagnostic — the new grant
    // should appear within the response of the next read.
    setExistingReloadTick((t) => t + 1);
    setDiagReloadTick((t) => t + 1);

    // Single summary notification rather than per-row, so the operator
    // isn't toast-spammed on a bulk grant. Counts come from the locally-
    // accumulated `outcomes` map, NOT from `rowStatuses` (which is a
    // closure capture and would read pre-submit state here).
    if (!cancelFlagRef.current.cancelled) {
      let granted = 0;
      let already = 0;
      let failed = 0;
      for (const o of outcomes.values()) {
        if (o === "granted") granted++;
        else if (o === "already") already++;
        else failed++;
      }
      // Rows that never made it to grantTargets (unresolved Graph lookup)
      // count as failures for the summary line.
      const skipped = liveRows.length - grantTargets.length;
      failed += skipped;
      const total = granted + already;
      if (failed === 0) {
        store.addNotification({
          type: "success",
          message: `Granted EA Subscription Creator to ${total} principal${total === 1 ? "" : "s"} on ${eaName}.`,
        });
      } else if (total === 0) {
        store.addNotification({
          type: "error",
          message: `Grant failed for all ${liveRows.length} principal${liveRows.length === 1 ? "" : "s"}.`,
        });
      } else {
        store.addNotification({
          type: "warning",
          message: `Grant partial: ${total} succeeded (${already} already had), ${failed} failed.`,
        });
      }
    }
  }, [
    account,
    armToken,
    billingAccountName,
    eaName,
    liveRows,
    principalTenantId,
    store,
  ]);

  /** Cancel an in-flight batch — clears the flag so in-progress fetches drop. */
  const cancelBatch = React.useCallback(() => {
    cancelFlagRef.current.cancelled = true;
  }, []);

  const resetForm = React.useCallback(() => {
    setSingleInput("");
    setBulkInput("");
    setRowStatuses({});
    setSubmitBatchKeys([]);
    cancelFlagRef.current = { cancelled: false };
  }, []);

  // -------------------------------------------------------------------------
  // Revoke flow (destructive)
  // -------------------------------------------------------------------------
  const [revokeTarget, setRevokeTarget] =
    React.useState<BillingRoleAssignmentSummary | null>(null);
  const [revokeBusy, setRevokeBusy] = React.useState(false);
  const doRevoke = React.useCallback(async () => {
    if (!revokeTarget || !armToken || !account) return;
    setRevokeBusy(true);
    try {
      await deleteBillingRoleAssignment(revokeTarget.id, armToken);
      auditLog.record({
        actor: account.username,
        action: "revoke_ea_subscription_creator",
        target: revokeTarget.principalId,
        status: "success",
        details: {
          page: "ea-creator-pregrant",
          billingAccountName,
          enrollmentAccountName: eaName,
          principalTenantId: revokeTarget.principalTenantId,
          roleAssignmentId: revokeTarget.id,
          roleDefinitionName: revokeTarget.roleDefinitionName,
        },
      });
      store.addNotification({
        type: "success",
        message: `Revoked ${revokeTarget.roleDefinitionName} from ${revokeTarget.principalId}.`,
      });
      setRevokeTarget(null);
      setExistingReloadTick((t) => t + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.record({
        actor: account.username,
        action: "revoke_ea_subscription_creator",
        target: revokeTarget.principalId,
        status: "failure",
        details: {
          page: "ea-creator-pregrant",
          roleAssignmentId: revokeTarget.id,
          error: msg,
        },
        error: msg,
      });
      store.addNotification({
        type: "error",
        message: `Revoke failed: ${msg}`,
      });
    } finally {
      setRevokeBusy(false);
    }
  }, [account, armToken, billingAccountName, eaName, revokeTarget, store]);

  // -------------------------------------------------------------------------
  // Recent activity from this session (audit log filter)
  // -------------------------------------------------------------------------
  //
  // We pull from the in-memory store via state.auditEntries so the panel
  // updates reactively. Filter to grants/revokes performed FROM this page,
  // capped at most-recent 50.
  const recentActivity = React.useMemo(() => {
    const entries = state.auditEntries ?? [];
    return entries
      .filter((e) => {
        if (
          e.action !== "grant_ea_subscription_creator" &&
          e.action !== "revoke_ea_subscription_creator"
        )
          return false;
        const page = (e.details as { page?: string } | undefined)?.page;
        return page === "ea-creator-pregrant";
      })
      .slice(-50)
      .reverse();
  }, [state.auditEntries]);

  // -------------------------------------------------------------------------
  // Empty-state guard
  // -------------------------------------------------------------------------
  if (candidates.length === 0) {
    return (
      <div className="space-y-4 p-6">
        <PageHeader
          title="Pre-grant EA Subscription Creator"
          description="Grant the EA Subscription Creator role on an enrollment account before opening Create EA Sub (quick)."
        />
        <EmptyState
          icon={ShieldCheck}
          title="No signed-in Azure accounts"
          description="Add an Azure account on the Azure Accounts page first — the granter must hold EA admin rights on the billing account."
        />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader
          title="Pre-grant EA Subscription Creator"
          description="Assign the EA Subscription Creator role on an enrollment account to one or more principals so they can create subscriptions there without hitting the missing-role 401."
        />
        <div className="flex flex-wrap items-center gap-2">
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
          {batchSummary.granted + batchSummary.already > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate("/ea-sub-quick")}
              aria-label="Go to Create EA Sub (quick)"
            >
              Create EA Sub (quick)
              <ArrowRight className="ml-1 h-3 w-3" aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {/* Summary stats — only render once we have at least one signal. */}
      {(submitBatchKeys.length > 0 || existingCreators.length > 0) && (
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Summary"
        >
          <SummaryStatItem
            label="Granted"
            value={batchSummary.granted}
            tone="success"
            hint="this submission"
            compact
          />
          <SummaryStatItem
            label="Already had"
            value={batchSummary.already}
            tone="info"
            hint="409 / idempotent"
            compact
          />
          <SummaryStatItem
            label="Failed"
            value={batchSummary.failed}
            tone="destructive"
            hint="this submission"
            compact
          />
          <SummaryStatItem
            label="Creators at scope"
            value={existingCreators.length}
            tone={existingCreators.length > 0 ? "success" : "muted"}
            hint={eaName ? "right now" : ""}
            compact
          />
          {staleCreators.length > 0 && (
            <SummaryStatItem
              label={`Stale > ${STALE_DAYS}d`}
              value={staleCreators.length}
              tone="warning"
              hint="review for cleanup"
              compact
              ariaLabel={`Stale creators older than ${STALE_DAYS} days: ${staleCreators.length}`}
              onClick={() => setTabParam("existing")}
            />
          )}
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={setTabParam}
        className="space-y-3"
      >
        <TabsList>
          <TabsTrigger value="grant">Grant</TabsTrigger>
          <TabsTrigger value="existing">
            Existing assignments
            {existing.length > 0 && (
              <span className="ml-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-muted px-1 text-2xs tabular-nums">
                {existing.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="activity">
            Session activity
            {recentActivity.length > 0 && (
              <span className="ml-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-muted px-1 text-2xs tabular-nums">
                {recentActivity.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ----------------------------------------------------------------- */}
        {/* GRANT TAB                                                          */}
        {/* ----------------------------------------------------------------- */}
        <TabsContent value="grant" className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Grant role</CardTitle>
              <CardDescription>
                Pick the granter account, the billing/enrollment account
                scope, and the principal(s). 409 / "already exists" is
                treated as success per row.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Granter account */}
              <div className="space-y-1.5">
                <Label
                  htmlFor="granter"
                  className="flex items-center gap-1.5"
                >
                  Granter (signed-in Azure account)
                  <InfoTooltip content="The signed-in identity used to write the role assignment. Must hold Enterprise Administrator, EA Account Owner, or Department Administrator on the chosen scope." />
                </Label>
                <Select value={accountId} onValueChange={setAccountId}>
                  <SelectTrigger id="granter">
                    <SelectValue placeholder="Pick an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((c) => (
                      <SelectItem
                        key={c.homeAccountId}
                        value={c.homeAccountId}
                      >
                        {c.username}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({c.name})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Billing account */}
              <div className="space-y-1.5">
                <Label htmlFor="ba" className="flex items-center gap-1.5">
                  Billing account
                  <InfoTooltip content="EA billing accounts visible to the granter (agreementType=EnterpriseAgreement). Empty means the granter has no EA admin role anywhere." />
                  {!baLoading && billingAccounts.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setBaReloadTick((t) => t + 1)}
                      aria-label="Refresh billing accounts"
                      title="Refresh billing accounts"
                    >
                      <RefreshCw className="h-3 w-3" aria-hidden />
                    </Button>
                  )}
                </Label>
                <Select
                  value={billingAccountName}
                  onValueChange={setBillingAccountName}
                  disabled={baLoading || billingAccounts.length === 0}
                >
                  <SelectTrigger id="ba">
                    <SelectValue
                      placeholder={
                        baLoading
                          ? "Loading…"
                          : billingAccounts.length === 0
                            ? "No EA billing accounts visible to this granter"
                            : "Pick a billing account"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {billingAccounts.map((b) => (
                      <SelectItem key={b.name} value={b.name}>
                        {b.displayName}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({b.name})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {baError && (
                  <p className="text-xs text-destructive break-words">
                    {baError}
                  </p>
                )}
                {billingAccountName && (
                  <p className="text-2xs text-muted-foreground">
                    <CopyableText value={billingAccountName} mono />
                  </p>
                )}
              </div>

              {/* Enrollment account */}
              <div className="space-y-1.5">
                <Label htmlFor="ea" className="flex items-center gap-1.5">
                  Enrollment account
                  <InfoTooltip content="A specific enrollment account under the billing account. The role grant is scoped here; creators can only mint subscriptions under this exact enrollment." />
                  {!eaLoading && eas.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setEaReloadTick((t) => t + 1)}
                      aria-label="Refresh enrollment accounts"
                      title="Refresh enrollment accounts"
                    >
                      <RefreshCw className="h-3 w-3" aria-hidden />
                    </Button>
                  )}
                </Label>
                <Select
                  value={eaName}
                  onValueChange={setEaName}
                  disabled={eaLoading || eas.length === 0}
                >
                  <SelectTrigger id="ea">
                    <SelectValue
                      placeholder={
                        eaLoading
                          ? "Loading…"
                          : eas.length === 0
                            ? "No enrollment accounts under this BA"
                            : "Pick an enrollment account"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {eas.map((e) => (
                      <SelectItem key={e.name} value={e.name}>
                        {e.displayName}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({e.name})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {eaError && (
                  <p className="text-xs text-destructive break-words">
                    {eaError}
                  </p>
                )}
                {selectedEa && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                    <CopyableText value={selectedEa.name} mono />
                    {selectedEa.status && (
                      <Badge variant="outline" className="text-2xs">
                        {selectedEa.status}
                      </Badge>
                    )}
                    {selectedEa.accountOwner && (
                      <span>
                        Owner:{" "}
                        <span className="text-foreground/80">
                          {selectedEa.accountOwner}
                        </span>
                      </span>
                    )}
                    {selectedEa.costCenter && (
                      <span>Cost center: {selectedEa.costCenter}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Granter-capability diagnostic */}
              {enrollmentScope && (
                <GranterDiagnosticBanner
                  loading={granterDiagLoading}
                  error={granterDiagError}
                  diag={granterDiag}
                  onRefresh={() => setDiagReloadTick((t) => t + 1)}
                />
              )}

              {/* Single vs bulk toggle */}
              <div className="flex items-center justify-between gap-2">
                <Label className="flex items-center gap-1.5">
                  Principals
                  <InfoTooltip content="Single mode: one UPN/UUID. Bulk mode: paste a list separated by newline, comma, or semicolon. UPNs are resolved via Microsoft Graph in the principal tenant; UUIDs are used as-is." />
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setBulkMode((v) => !v)}
                  aria-label={
                    bulkMode ? "Switch to single principal" : "Switch to bulk paste"
                  }
                >
                  {bulkMode ? (
                    <>
                      <UserCheck className="h-3 w-3" aria-hidden /> Single
                    </>
                  ) : (
                    <>
                      <Users className="h-3 w-3" aria-hidden /> Bulk paste
                    </>
                  )}
                </Button>
              </div>

              {/* Principal input — single mode */}
              {!bulkMode && (
                <div className="space-y-1.5">
                  <Input
                    id="principal"
                    value={singleInput}
                    onChange={(e) => setSingleInput(e.target.value)}
                    placeholder="alice@contoso.com  or  00000000-0000-0000-0000-000000000000"
                    autoComplete="off"
                    spellCheck={false}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canOpenConfirm) {
                        e.preventDefault();
                        handleSubmitClick();
                      }
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    UUIDs are used as-is. Anything else is resolved via
                    Microsoft Graph in the principal&apos;s tenant below.
                  </p>
                </div>
              )}

              {/* Principal input — bulk mode */}
              {bulkMode && (
                <div className="space-y-1.5">
                  <textarea
                    value={bulkInput}
                    onChange={(e) => setBulkInput(e.target.value)}
                    placeholder={
                      "alice@contoso.com\n11111111-2222-3333-4444-555555555555\nbob@contoso.com"
                    }
                    rows={5}
                    className={cn(
                      "w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                    aria-label="Bulk principals (one per line, comma, or semicolon)"
                  />
                  <p className="text-2xs text-muted-foreground">
                    Lines separated by newline, comma, or semicolon. Empty
                    lines and duplicates are dropped.
                  </p>
                </div>
              )}

              {/* Principal tenant id */}
              <div className="space-y-1.5">
                <Label htmlFor="ptid" className="flex items-center gap-1.5">
                  Principal tenant id
                  <InfoTooltip content="Tenant where the principal lives. For internal users this is your home tenant. For guests, it's the GUEST'S home tenant (not yours) — even though they're listed in your directory as a guest." />
                </Label>
                <Input
                  id="ptid"
                  value={principalTenantId}
                  onChange={(e) => setPrincipalTenantId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(
                    !tenantIsValid &&
                      principalTenantId.length > 0 &&
                      "border-destructive",
                  )}
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Defaults to the granter&apos;s tenant. Override for
                    cross-tenant guests.
                  </span>
                  {account && principalTenantId !== account.tenantId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setPrincipalTenantId(account.tenantId)}
                      aria-label="Reset to granter's tenant"
                    >
                      Reset to granter&apos;s tenant
                    </Button>
                  )}
                </div>
              </div>

              {/* Resolved-principals preview */}
              {liveRows.length > 0 && (
                <ResolvedPreview
                  rows={liveRows}
                  statuses={rowStatuses}
                  batchKeys={submitBatchKeys}
                />
              )}

              {/* Submit row */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Button
                  onClick={handleSubmitClick}
                  disabled={!canOpenConfirm}
                  loading={submitting}
                >
                  Grant EA Subscription Creator
                  {liveRows.length > 1 && (
                    <span className="ml-1 rounded-full bg-primary-foreground/15 px-1.5 py-0.5 text-2xs tabular-nums">
                      {liveRows.length}
                    </span>
                  )}
                </Button>
                {submitting && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={cancelBatch}
                    aria-label="Cancel batch"
                  >
                    <X className="h-3 w-3" aria-hidden />
                    Cancel batch
                  </Button>
                )}
                {(submitBatchKeys.length > 0 ||
                  singleInput ||
                  bulkInput) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={resetForm}
                    disabled={submitting}
                    aria-label="Reset form"
                  >
                    Reset
                  </Button>
                )}
              </div>

              {/* Post-submit hint about token refresh */}
              {batchSummary.granted > 0 && !submitting && (
                <Alert>
                  <RotateCw className="h-3.5 w-3.5" aria-hidden />
                  <AlertDescription className="text-xs">
                    Newly-granted roles take a few seconds to land in the
                    role-evaluation cache. Click the token-expiry badge above
                    (or open Create EA Sub (quick) — it force-refreshes on
                    submit) so the first attempt uses a token whose claims
                    see the new assignment.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ----------------------------------------------------------------- */}
        {/* EXISTING ASSIGNMENTS TAB                                           */}
        {/* ----------------------------------------------------------------- */}
        <TabsContent value="existing">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Existing role assignments at scope</CardTitle>
                  <CardDescription>
                    All billing-role assignments visible at the chosen
                    enrollment-account scope. Revokes are immediate and
                    undo-able only by re-granting.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ExportMenu
                    rows={existingFiltered}
                    filename={
                      eaName
                        ? `ea-pregrant-matrix-${eaName}`
                        : "ea-pregrant-matrix"
                    }
                    columns={MATRIX_EXPORT_COLUMNS}
                    jsonMetadata={{
                      page: "ea-creator-pregrant",
                      billingAccountName,
                      enrollmentAccountName: eaName,
                      enrollmentScope,
                      creatorsOnly: creatorsOnlyFilter,
                      exportedFromTab: "existing",
                    }}
                    disabled={existingFiltered.length === 0}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setExistingReloadTick((t) => t + 1)}
                    disabled={existingLoading || !armToken || !enrollmentScope}
                    aria-label="Refresh existing assignments"
                  >
                    {existingLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" aria-hidden />
                    )}
                    Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Filter toolbar — persisted "creators only" toggle + stale hint. */}
              {existing.length > 0 && (
                <div
                  className="flex flex-wrap items-center justify-between gap-2"
                  role="toolbar"
                  aria-label="Existing assignments filters"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Button
                      type="button"
                      variant={creatorsOnlyFilter ? "secondary" : "outline"}
                      size="xs"
                      onClick={() => setCreatorsOnlyFilter((v) => !v)}
                      aria-pressed={creatorsOnlyFilter}
                      aria-label="Toggle: show EA Subscription Creator pregrants only"
                    >
                      <ShieldCheck
                        className="h-3 w-3"
                        aria-hidden
                      />
                      Pregrants only
                      <span className="ml-1 rounded-full bg-background/70 px-1 text-2xs tabular-nums">
                        {existingCreators.length}
                      </span>
                    </Button>
                    <span className="text-2xs text-muted-foreground">
                      {creatorsOnlyFilter
                        ? `Hiding ${existing.length - existingCreators.length} non-creator role${existing.length - existingCreators.length === 1 ? "" : "s"}.`
                        : `Showing all ${existing.length} role assignment${existing.length === 1 ? "" : "s"}.`}
                    </span>
                  </div>
                  {staleCreators.length > 0 && (
                    <Alert className="m-0 py-1.5 pr-3">
                      <Clock className="h-3.5 w-3.5" aria-hidden />
                      <AlertDescription className="text-2xs">
                        {staleCreators.length} EA Subscription Creator
                        {staleCreators.length === 1 ? " is" : "s are"} older
                        than {STALE_DAYS} days — review whether they&apos;re
                        still needed.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
              {!enrollmentScope && (
                <p className="text-xs text-muted-foreground">
                  Pick a billing account + enrollment account on the Grant
                  tab first.
                </p>
              )}
              {enrollmentScope && existingError && (
                <Alert variant="destructive">
                  <AlertDescription className="text-xs break-words">
                    {existingError}
                  </AlertDescription>
                </Alert>
              )}
              {enrollmentScope &&
                !existingError &&
                !existingLoading &&
                existing.length === 0 && (
                  <EmptyState
                    icon={Users}
                    size="compact"
                    title="No readable assignments"
                    description="Either nobody has been granted a billing role here yet, or the granter lacks read access on billingRoleAssignments at this scope."
                  />
                )}
              {enrollmentScope &&
                !existingError &&
                !existingLoading &&
                existing.length > 0 &&
                existingFiltered.length === 0 && (
                  <EmptyState
                    icon={ShieldCheck}
                    size="compact"
                    title="No EA Subscription Creator assignments"
                    description="Nobody currently holds EaSubscriptionCreator at this scope. Toggle 'Pregrants only' off to see other billing roles."
                  />
                )}
              {existingFiltered.length > 0 && (
                <ExistingAssignmentsList
                  rows={existingFiltered}
                  staleSet={staleIdSet}
                  onRevoke={setRevokeTarget}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ----------------------------------------------------------------- */}
        {/* SESSION ACTIVITY TAB                                               */}
        {/* ----------------------------------------------------------------- */}
        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Session activity</CardTitle>
                  <CardDescription>
                    Grants and revokes performed from this page during the
                    current session. Cleared when the dashboard is reloaded.
                  </CardDescription>
                </div>
                <ExportMenu
                  rows={recentActivity}
                  filename="ea-pregrant-activity"
                  columns={EXPORT_COLUMNS}
                  jsonMetadata={{
                    page: "ea-creator-pregrant",
                    enrollmentScope,
                  }}
                />
              </div>
            </CardHeader>
            <CardContent>
              {recentActivity.length === 0 ? (
                <EmptyState
                  icon={ShieldCheck}
                  size="compact"
                  title="Nothing here yet"
                  description="Successful and failed grants/revokes from this page will appear here."
                />
              ) : (
                <RecentActivityList entries={recentActivity} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Confirmation dialog — frozen snapshot of what we're about to do. */}
      <ConfirmationDialog
        hidden={!submitConfirmOpen}
        title={
          liveRows.length === 1
            ? "Grant EA Subscription Creator?"
            : `Grant EA Subscription Creator to ${liveRows.length} principals?`
        }
        message={
          <ConfirmDialogBody
            account={account}
            billingAccountName={billingAccountName}
            eaName={eaName}
            principalTenantId={principalTenantId.trim()}
            rows={liveRows}
            granterDiag={granterDiag}
          />
        }
        confirmText="Grant"
        cancelText="Cancel"
        onConfirm={() => void doSubmit()}
        onCancel={() => setSubmitConfirmOpen(false)}
        loading={submitting}
      />

      {/* Revoke confirmation dialog (destructive) */}
      <ConfirmationDialog
        hidden={!revokeTarget}
        title="Revoke billing-role assignment?"
        message={
          revokeTarget ? (
            <div className="space-y-2 text-xs">
              <p>
                This deletes the role assignment immediately. The principal
                will need a new grant before they can create subscriptions
                under this enrollment again.
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
                <dt className="text-muted-foreground">Role:</dt>
                <dd className="font-medium">
                  {revokeTarget.roleDefinitionName}
                </dd>
                <dt className="text-muted-foreground">Principal:</dt>
                <dd className="font-mono break-all">
                  {revokeTarget.principalId}
                </dd>
                <dt className="text-muted-foreground">Tenant:</dt>
                <dd className="font-mono break-all">
                  {revokeTarget.principalTenantId ?? "—"}
                </dd>
                <dt className="text-muted-foreground">Scope:</dt>
                <dd className="font-mono break-all">
                  {revokeTarget.scope ?? "—"}
                </dd>
              </dl>
            </div>
          ) : (
            ""
          )
        }
        confirmText="Revoke"
        cancelText="Cancel"
        danger
        onConfirm={() => void doRevoke()}
        onCancel={() => !revokeBusy && setRevokeTarget(null)}
        loading={revokeBusy}
      />
    </div>
  );
};

// =========================================================================
// Helpers
// =========================================================================

/** Cheap, validation-free decode of an ARM token's `oid` claim. */
function decodeOidFromArmToken(token: string): string | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const json = JSON.parse(decoded) as Record<string, unknown>;
    const oid = json.oid ?? json.sub;
    return typeof oid === "string" ? oid : null;
  } catch {
    return null;
  }
}

/** Inline diagnostic banner above the principal inputs. */
interface GranterDiagnosticBannerProps {
  loading: boolean;
  error: string | null;
  diag:
    | {
        callerOid: string;
        roles: BillingRoleAssignmentSummary[];
        canGrant: boolean;
      }
    | null;
  onRefresh: () => void;
}
const GranterDiagnosticBanner: React.FC<GranterDiagnosticBannerProps> = ({
  loading,
  error,
  diag,
  onRefresh,
}) => {
  if (loading) {
    return (
      <Alert>
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        <AlertDescription className="text-xs">
          Checking granter&apos;s role at this scope…
        </AlertDescription>
      </Alert>
    );
  }
  if (error) {
    return (
      <Alert>
        <AlertCircle className="h-3.5 w-3.5" aria-hidden />
        <AlertDescription className="text-xs break-words">
          Could not verify granter role: {error}{" "}
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={onRefresh}
            aria-label="Retry diagnostic"
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!diag) return null;
  if (diag.canGrant) {
    return (
      <Alert>
        <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden />
        <AlertDescription className="text-xs">
          Granter has{" "}
          <span className="font-medium">
            {diag.roles
              .map((r) => r.roleDefinitionName)
              .filter(Boolean)
              .join(", ")}
          </span>{" "}
          at this scope — grant should succeed.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
      <AlertDescription className="text-xs">
        {diag.roles.length === 0
          ? "Granter has no readable billing-role at this scope — the grant PUT will likely 403. Pick a different granter or have an EA administrator add a role here first."
          : `Granter holds ${diag.roles.map((r) => r.roleDefinitionName).join(", ")} — none of these can grant EaSubscriptionCreator. Use Enterprise Administrator, EA Account Owner, or Department Administrator.`}
      </AlertDescription>
    </Alert>
  );
};

/** Confirm-dialog body listing every principal we're about to grant. */
interface ConfirmDialogBodyProps {
  account: SourceAccount | null;
  billingAccountName: string;
  eaName: string;
  principalTenantId: string;
  rows: PrincipalRow[];
  granterDiag:
    | {
        callerOid: string;
        roles: BillingRoleAssignmentSummary[];
        canGrant: boolean;
      }
    | null;
}
const ConfirmDialogBody: React.FC<ConfirmDialogBodyProps> = ({
  account,
  billingAccountName,
  eaName,
  principalTenantId,
  rows,
  granterDiag,
}) => {
  const failingRows = rows.filter(
    (r) => r.resolveState === "missing" || r.resolveState === "error",
  );
  return (
    <div className="space-y-3 text-xs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Granter:</dt>
        <dd>{account?.username ?? "—"}</dd>
        <dt className="text-muted-foreground">BA:</dt>
        <dd className="font-mono break-all">{billingAccountName}</dd>
        <dt className="text-muted-foreground">Enrollment:</dt>
        <dd className="font-mono break-all">{eaName}</dd>
        <dt className="text-muted-foreground">Principal tenant:</dt>
        <dd className="font-mono break-all">{principalTenantId}</dd>
        <dt className="text-muted-foreground">Role:</dt>
        <dd>EA Subscription Creator</dd>
      </dl>
      {granterDiag && !granterDiag.canGrant && (
        <Alert variant="destructive" className="py-2">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
          <AlertDescription className="text-2xs">
            Granter may not have permission to write role assignments at this
            scope. Grant will fail with 403 if so.
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-1">
        <p className="text-2xs uppercase tracking-wider text-muted-foreground">
          Principals ({rows.length})
        </p>
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded border bg-muted/30 p-2">
          {rows.map((r, i) => (
            <li
              key={rowKey(r.input, i)}
              className="flex items-center justify-between gap-2 text-2xs"
            >
              <span className="truncate">
                <span className="font-mono">{r.input}</span>
                {r.resolvedDisplayName && r.resolvedDisplayName !== r.input && (
                  <span className="ml-1 text-muted-foreground">
                    → {r.resolvedDisplayName}
                  </span>
                )}
                {r.resolvedOid && r.resolvedOid !== r.input && (
                  <span className="ml-1 font-mono text-muted-foreground">
                    ({r.resolvedOid.slice(0, 8)}…)
                  </span>
                )}
              </span>
              <ResolveStateBadge state={r.resolveState} />
            </li>
          ))}
        </ul>
      </div>
      {failingRows.length > 0 && (
        <p className="text-2xs text-warning">
          {failingRows.length} row{failingRows.length === 1 ? "" : "s"} will
          be skipped due to unresolved principal lookup.
        </p>
      )}
    </div>
  );
};

/** Small badge showing the principal-resolve state inline. */
const ResolveStateBadge: React.FC<{ state: PrincipalRow["resolveState"] }> = ({
  state,
}) => {
  if (state === "resolving") {
    return (
      <Badge variant="outline" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Resolving
      </Badge>
    );
  }
  if (state === "ok") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        Ready
      </Badge>
    );
  }
  if (state === "missing") {
    return (
      <Badge variant="warning" className="gap-1">
        <AlertCircle className="h-3 w-3" aria-hidden />
        Not found
      </Badge>
    );
  }
  if (state === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" aria-hidden />
        Error
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      Idle
    </Badge>
  );
};

/** Per-row preview table shown above the submit button. */
interface ResolvedPreviewProps {
  rows: PrincipalRow[];
  statuses: Record<string, RowStatus>;
  batchKeys: string[];
}
const ResolvedPreview: React.FC<ResolvedPreviewProps> = ({
  rows,
  statuses,
  batchKeys,
}) => {
  const [expanded, setExpanded] = React.useState(true);
  if (rows.length === 0) return null;
  const inBatch = (i: number) =>
    batchKeys.includes(rowKey(rows[i]!.input, i));
  return (
    <div className="rounded-md border bg-card/50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs font-medium hover:bg-accent/10"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse principals preview" : "Expand principals preview"}
      >
        <span className="flex items-center gap-2">
          Principals preview
          <Badge variant="outline" className="text-2xs">
            {rows.length}
          </Badge>
        </span>
        {expanded ? (
          <ChevronUp className="h-3 w-3" aria-hidden />
        ) : (
          <ChevronDown className="h-3 w-3" aria-hidden />
        )}
      </button>
      {expanded && (
        <ul className="max-h-72 divide-y divide-border/50 overflow-y-auto">
          {rows.map((r, i) => {
            const k = rowKey(r.input, i);
            const status = inBatch(i) ? statuses[k] : undefined;
            return (
              <li
                key={k}
                className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2 text-xs"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 truncate">
                    <span className="font-mono">{r.input}</span>
                    {r.resolvedDisplayName &&
                      r.resolvedDisplayName !== r.input && (
                        <span className="text-muted-foreground">
                          {r.resolvedDisplayName}
                        </span>
                      )}
                  </div>
                  {r.resolvedOid && (
                    <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                      <CopyableText
                        value={r.resolvedOid}
                        mono
                        alwaysVisibleButton={false}
                      />
                      {r.resolvedUpn && r.resolvedUpn !== r.input && (
                        <span className="truncate">{r.resolvedUpn}</span>
                      )}
                    </div>
                  )}
                  {r.resolveError && (
                    <p className="text-2xs text-destructive break-words">
                      {r.resolveError}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <ResolveStateBadge state={r.resolveState} />
                  {status && <RowStatusBadge status={status} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

/** Badge showing the per-row grant status during/after submission. */
const RowStatusBadge: React.FC<{ status: RowStatus }> = ({ status }) => {
  switch (status.kind) {
    case "pending":
      return (
        <Badge variant="outline" className="text-2xs">
          Queued
        </Badge>
      );
    case "resolving":
      return (
        <Badge variant="outline" className="gap-1 text-2xs">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Resolving
        </Badge>
      );
    case "granting":
      return (
        <Badge variant="outline" className="gap-1 text-2xs">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Granting
        </Badge>
      );
    case "granted":
      return (
        <Badge variant="success" className="gap-1 text-2xs">
          <CheckCircle2 className="h-3 w-3" aria-hidden />
          Granted
        </Badge>
      );
    case "already-granted":
      return (
        <Badge variant="info" className="gap-1 text-2xs">
          <CheckCircle2 className="h-3 w-3" aria-hidden />
          Already had
        </Badge>
      );
    case "failed":
      return (
        <Badge
          variant="destructive"
          className="gap-1 text-2xs"
          title={status.error}
        >
          <XCircle className="h-3 w-3" aria-hidden />
          Failed
        </Badge>
      );
  }
};

/** Existing-assignments list rendered as a lightweight table. */
interface ExistingAssignmentsListProps {
  rows: readonly BillingRoleAssignmentSummary[];
  /**
   * Set of role-assignment ids considered "stale" (older than the page's
   * stale threshold). Empty when no rows qualify or `createdOn` is missing.
   */
  staleSet?: ReadonlySet<string>;
  onRevoke: (row: BillingRoleAssignmentSummary) => void;
}
const ExistingAssignmentsList: React.FC<ExistingAssignmentsListProps> = ({
  rows,
  staleSet,
  onRevoke,
}) => {
  return (
    <div className="overflow-x-auto rounded border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/50 text-left text-2xs uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Principal</th>
            <th className="px-3 py-2 font-medium">Tenant</th>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isCreator =
              r.roleDefinitionId.toLowerCase() ===
              ROLE_EA_SUBSCRIPTION_CREATOR.toLowerCase();
            const friendly =
              EA_BILLING_ROLE_NAMES[r.roleDefinitionId.toLowerCase()] ??
              r.roleDefinitionName ??
              r.roleDefinitionId;
            const isStale = !!staleSet?.has(r.id);
            return (
              <tr
                key={r.id}
                className="border-b last:border-0 align-top hover:bg-accent/5"
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <Badge
                      variant={isCreator ? "success" : "outline"}
                      className="text-2xs"
                    >
                      {friendly}
                    </Badge>
                    {isStale && (
                      <Badge
                        variant="warning"
                        className="gap-1 text-2xs"
                        title="Older than the stale threshold — consider reviewing"
                      >
                        <Clock className="h-3 w-3" aria-hidden />
                        Stale
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <CopyableText value={r.principalId} mono />
                </td>
                <td className="px-3 py-2">
                  {r.principalTenantId ? (
                    <CopyableText value={r.principalTenantId} mono />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-2xs text-muted-foreground">
                  {r.createdOn ? formatTime(r.createdOn) : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onRevoke(r)}
                    aria-label={`Revoke ${friendly} from ${r.principalId}`}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                    Revoke
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

/**
 * Column descriptors for the pregrant-matrix export menu (existing-
 * assignments tab). Headless — same accessor contract as ExportMenu's
 * ExportColumn. We surface the full role-assignment ARM id so an operator
 * who downloads the CSV can re-import / cross-reference downstream.
 */
const MATRIX_EXPORT_COLUMNS: readonly ExportColumn<BillingRoleAssignmentSummary>[] = [
  {
    header: "Role definition name",
    accessor: (r) =>
      EA_BILLING_ROLE_NAMES[r.roleDefinitionId.toLowerCase()] ??
      r.roleDefinitionName ??
      r.roleDefinitionId,
  },
  {
    header: "Role definition id",
    accessor: (r) => r.roleDefinitionId,
  },
  {
    header: "Principal id",
    accessor: (r) => r.principalId,
  },
  {
    header: "Principal tenant id",
    accessor: (r) => r.principalTenantId ?? "",
  },
  {
    header: "Scope",
    accessor: (r) => r.scope ?? "",
  },
  {
    header: "Created (ISO)",
    accessor: (r) => r.createdOn ?? "",
  },
  {
    header: "Role assignment id",
    accessor: (r) => r.id,
  },
];

/** Recent-activity table rendered from the audit-log slice. */
const RecentActivityList: React.FC<{ entries: readonly AuditEntry[] }> = ({
  entries,
}) => {
  return (
    <div className="overflow-x-auto rounded border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/50 text-left text-2xs uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Target / EA</th>
            <th className="px-3 py-2 font-medium">Role assignment id</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const details = (e.details ?? {}) as {
              roleAssignmentId?: string;
              enrollmentAccountName?: string;
              noOp?: boolean;
            };
            const isRevoke = e.action === "revoke_ea_subscription_creator";
            const statusVariant: "success" | "info" | "destructive" =
              e.status === "failure"
                ? "destructive"
                : details.noOp
                  ? "info"
                  : "success";
            const statusLabel =
              e.status === "failure"
                ? "Failed"
                : details.noOp
                  ? "Already had"
                  : isRevoke
                    ? "Revoked"
                    : "Granted";
            return (
              <tr
                key={e.id}
                className="border-b last:border-0 align-top hover:bg-accent/5"
              >
                <td className="px-3 py-2 text-2xs text-muted-foreground">
                  {formatTime(e.timestamp)}
                </td>
                <td className="px-3 py-2">
                  {isRevoke ? "Revoke" : "Grant"}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={statusVariant} className="text-2xs">
                    {statusLabel}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="space-y-0.5">
                    <CopyableText value={e.target} mono />
                    {details.enrollmentAccountName && (
                      <div className="text-2xs text-muted-foreground">
                        EA: {details.enrollmentAccountName}
                      </div>
                    )}
                    {e.error && (
                      <div className="text-2xs text-destructive break-words">
                        {e.error}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {details.roleAssignmentId ? (
                    <div className="flex items-center gap-1">
                      <code className="truncate font-mono text-2xs max-w-[18ch]">
                        {details.roleAssignmentId.split("/").pop()}
                      </code>
                      <CopyButton
                        value={details.roleAssignmentId}
                        alwaysVisible
                        ariaLabel="Copy role assignment id"
                      />
                    </div>
                  ) : (
                    <span className="text-2xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

/** Compact ISO → short local time string. */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Column descriptors for the session-activity export menu. */
const EXPORT_COLUMNS = [
  {
    header: "Timestamp",
    accessor: (e: AuditEntry) => e.timestamp,
  },
  {
    header: "Actor",
    accessor: (e: AuditEntry) => e.actor,
  },
  {
    header: "Action",
    accessor: (e: AuditEntry) => e.action,
  },
  {
    header: "Status",
    accessor: (e: AuditEntry) => e.status,
  },
  {
    header: "Target",
    accessor: (e: AuditEntry) => e.target,
  },
  {
    header: "Enrollment account",
    accessor: (e: AuditEntry) =>
      (e.details as { enrollmentAccountName?: string } | undefined)
        ?.enrollmentAccountName ?? "",
  },
  {
    header: "Billing account",
    accessor: (e: AuditEntry) =>
      (e.details as { billingAccountName?: string } | undefined)
        ?.billingAccountName ?? "",
  },
  {
    header: "Principal tenant",
    accessor: (e: AuditEntry) =>
      (e.details as { principalTenantId?: string } | undefined)
        ?.principalTenantId ?? "",
  },
  {
    header: "Role assignment id",
    accessor: (e: AuditEntry) =>
      (e.details as { roleAssignmentId?: string } | undefined)
        ?.roleAssignmentId ?? "",
  },
  {
    header: "Error",
    accessor: (e: AuditEntry) => e.error ?? "",
  },
];
