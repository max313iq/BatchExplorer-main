/**
 * Department Admin — focused workspace for an EA department admin.
 *
 * Picker cascade: source account → EA billing account → department.
 *
 * Once a department is selected we surface:
 *   - Department metadata (name, cost center, status, ARM id, EA count).
 *   - Enrollment accounts that live under THIS department (scoped via
 *     /departments/{name}/enrollmentAccounts).
 *   - The billing subscriptions billed through each enrollment account.
 *   - "Create subscription" pivots to /ea-subscription with the picked
 *     enrollment account pre-seeded (sessionStorage hint that the EA
 *     Sub page consumes on mount). A ConfirmationDialog now stands
 *     between the click and the navigation so the operator sees exactly
 *     which EA is about to be pre-filled.
 *   - "Grant EA Subscription Creator" pivots to /sub-manager with the
 *     billing-account pre-seeded — so the admin can give a teammate
 *     subscription-creation rights without leaving this workspace.
 *
 * Architectural rules preserved through this rewrite:
 *   - The DEPARTMENT-scoped billingSubscriptions endpoint is used (the
 *     billing-account-scope variant 403s for Department Admins). This
 *     is the correct narrower scope — do NOT pivot back to the wider
 *     endpoint.
 *   - useArmToken + TokenExpiryBadge stay wired exactly as before so
 *     mid-survey token rolls don't 401 the operator.
 *   - All mutating actions still route through the existing pages
 *     (sub-manager, ea-subscription) so audit + auth flows stay
 *     consistent.
 *
 * Resilience added in this rewrite:
 *   - Sequence guards on EAs and subs so a quick department-switch
 *     can't let a stale fetch's response overwrite the new scope's
 *     list (was previously partly fixed; now applied uniformly).
 *   - The shared `armToken` state is properly cleared when the central
 *     `useArmToken` tracker loses its token (account swap), so child
 *     effects don't keep firing against a stale credential.
 *   - "Orphaned" subs — a sub whose `invoiceSectionDisplayName`
 *     doesn't match any EA we listed — are surfaced as their own
 *     bucket rather than silently dropped from the per-EA view.
 *   - Pivot confirmation surfaces the destination + exact pre-fill
 *     payload, so the operator can cancel before sessionStorage is
 *     mutated and routing happens.
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpDown,
  BadgeCheck,
  Building2,
  Crown,
  ExternalLink,
  HelpCircle,
  Layers,
  Loader2,
  PlusCircle,
  RefreshCw,
  Server,
  Sparkles,
  UserCheck,
  Users,
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

import { getArmTokenForAccount } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { useTenantChange } from "../../hooks/use-tenant-change";
import {
  listDepartmentBillingSubscriptions,
  listDepartmentEnrollmentAccounts,
  listEaBillingAccounts,
  listEaDepartments,
} from "../../services";
import type {
  EaBillingAccount,
  EaBillingSubscription,
  EaDepartment,
  EaEnrollmentAccount,
} from "../../services";
import { auditLog } from "../../services/audit-log";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText, CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { showToast } from "../shared/toast-container";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

const STORAGE_ACCOUNT = "department-admin:account";
const STORAGE_BA = "department-admin:billing-account";
const STORAGE_DEPT = "department-admin:department";

// SessionStorage keys consumed by sibling pages we pivot to. Centralizing
// here makes the pivot contract explicit instead of being scattered as
// stringly-typed literals inside callbacks.
const PIVOT_KEYS = {
  EA_ACTIVE_ACCOUNT: "ea-subscription:active-account",
  EA_PRESELECT_BA: "ea-subscription:preselect-billing-account",
  EA_PRESELECT_EA: "ea-subscription:preselect-enrollment-account",
  SUB_MGR_TAB: "sub-manager:tab",
  SUB_MGR_BA: "sub-manager:billing-account",
} as const;

interface SourceAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

type EaStatusFilter = "all" | "active" | "inactive";
type SubsViewMode = "grouped" | "flat";
type EaSortKey = "name" | "subs" | "status" | "owner";

const STATUS_NORMALIZED: Record<string, EaStatusFilter> = {
  active: "active",
  enabled: "active",
  warned: "inactive",
  inactive: "inactive",
  disabled: "inactive",
  deleted: "inactive",
  expired: "inactive",
};

function normalizeStatus(s: string | undefined): EaStatusFilter {
  if (!s) return "active";
  return STATUS_NORMALIZED[s.toLowerCase()] ?? "active";
}

export const DepartmentAdminPage: React.FC = () => {
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
          tenantId: resolveActiveTenantId(a) ?? a.tenantId,
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
   * Central ARM-token tracker. Powers the TokenExpiryBadge and auto
   * re-acquires on tenant switch / 60s pre-expiry. Wired in PARALLEL
   * to the existing `getArmTokenForAccount` fetch so the existing
   * billing-account + department + enrollment-account effects keep
   * working unchanged; a bridge effect below syncs the freshly-minted
   * token down to the local `armToken` state so downstream consumers
   * (billing accounts, departments, EAs, subs) pick it up.
   */
  const armTokenTracker = useArmToken(
    account?.homeAccountId,
    account?.tenantId,
  );

  /* ----- ARM token + EA billing accounts -------------------------- */
  const [armToken, setArmToken] = React.useState<string | null>(null);

  // Bridge: whenever the central tracker re-mints (initial acquire,
  // tenant switch, pre-expiry refresh, badge click), sync the new
  // token to this page's existing armToken state so dependent effects
  // (departments, EAs, subs) re-fire with the fresh credential. The
  // `!==` guard prevents an infinite loop with the existing fetch.
  //
  // FIX: the previous version of this bridge only ran when the tracker
  // had a non-null token, leaving stale tokens around after an account
  // swap (tracker briefly goes null while re-acquiring). Now we also
  // clear `armToken` when the tracker explicitly reports null AND is
  // not mid-load — downstream effects then short-circuit to empty
  // lists instead of issuing requests with the previous account's
  // bearer token.
  React.useEffect(() => {
    if (armTokenTracker.token && armTokenTracker.token !== armToken) {
      setArmToken(armTokenTracker.token);
      return;
    }
    if (
      armTokenTracker.token === null &&
      !armTokenTracker.loading &&
      armToken !== null
    ) {
      setArmToken(null);
    }
  }, [armTokenTracker.token, armTokenTracker.loading, armToken]);

  const [billingAccounts, setBillingAccounts] = React.useState<EaBillingAccount[]>([]);
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
        setBaError(err instanceof Error ? err.message : String(err));
        setBillingAccounts([]);
      } finally {
        if (!cancelled) setBaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.homeAccountId, account?.tenantId]);

  /* ----- Departments under billing account ----------------------- */
  const [depts, setDepts] = React.useState<EaDepartment[]>([]);
  const [deptsLoading, setDeptsLoading] = React.useState(false);
  const [deptsError, setDeptsError] = React.useState<string | null>(null);
  const [departmentName, setDepartmentNameState] = React.useState<string>(
    () => {
      try {
        return sessionStorage.getItem(STORAGE_DEPT) ?? "";
      } catch {
        return "";
      }
    },
  );
  const setDepartmentName = React.useCallback((n: string) => {
    setDepartmentNameState(n);
    try {
      sessionStorage.setItem(STORAGE_DEPT, n);
    } catch {
      /* ignore */
    }
  }, []);
  // Sequence guard for the department fetch — quick BA changes used to
  // let an old BA's late response overwrite a newly-picked BA's list.
  const deptsReqSeqRef = React.useRef(0);
  React.useEffect(() => {
    if (!armToken || !billingAccountName) {
      setDepts([]);
      return;
    }
    const seq = ++deptsReqSeqRef.current;
    let cancelled = false;
    setDeptsLoading(true);
    setDeptsError(null);
    listEaDepartments(billingAccountName, armToken)
      .then((d) => {
        if (cancelled || seq !== deptsReqSeqRef.current) return;
        setDepts(d);
        // Auto-pick when only one department is visible (common for
        // department admins scoped to their own dept).
        if (d.length === 1 && departmentName !== d[0]!.name) {
          setDepartmentName(d[0]!.name);
        } else if (
          departmentName &&
          !d.some((x) => x.name === departmentName)
        ) {
          setDepartmentName("");
        }
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== deptsReqSeqRef.current) return;
        setDeptsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled && seq === deptsReqSeqRef.current) {
          setDeptsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [armToken, billingAccountName, departmentName, setDepartmentName]);

  const selectedDept = React.useMemo(
    () => depts.find((d) => d.name === departmentName) ?? null,
    [depts, departmentName],
  );

  /* ----- Enrollment accounts in the chosen department ------------ */
  const [eas, setEas] = React.useState<EaEnrollmentAccount[]>([]);
  const [eaLoading, setEaLoading] = React.useState(false);
  const [eaError, setEaError] = React.useState<string | null>(null);
  const [reloadTick, setReloadTick] = React.useState(0);
  // Sequence guard: each scope change increments, late responses ignored.
  const eaReqSeqRef = React.useRef(0);
  const actorUsername = account?.username ?? "anonymous";
  React.useEffect(() => {
    if (!armToken || !billingAccountName || !departmentName) {
      setEas([]);
      return;
    }
    const seq = ++eaReqSeqRef.current;
    let cancelled = false;
    setEaLoading(true);
    setEaError(null);
    const scopeTarget = `ba:${billingAccountName} dept:${departmentName}`;
    listDepartmentEnrollmentAccounts(
      billingAccountName,
      departmentName,
      armToken,
    )
      .then((list) => {
        if (cancelled || seq !== eaReqSeqRef.current) return;
        setEas(list);
        auditLog.record({
          actor: actorUsername,
          action: "list_department_enrollment_accounts",
          target: scopeTarget,
          status: "success",
          details: {
            billingAccountName,
            departmentName,
            count: list.length,
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== eaReqSeqRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setEaError(message);
        auditLog.record({
          actor: actorUsername,
          action: "list_department_enrollment_accounts",
          target: scopeTarget,
          status: "failure",
          error: message,
          details: { billingAccountName, departmentName },
        });
      })
      .finally(() => {
        if (!cancelled && seq === eaReqSeqRef.current) setEaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    armToken,
    billingAccountName,
    departmentName,
    reloadTick,
    actorUsername,
  ]);

  /* ----- Billing subscriptions (department-scoped) ----------------
   * Department Admins' billingPermissions only let them read subs at
   * the *department* scope; the billing-account-scope variant 403s.
   * We use the narrower endpoint and group client-side by enrollment
   * account.
   */
  const [allSubs, setAllSubs] = React.useState<EaBillingSubscription[]>([]);
  const [subsLoading, setSubsLoading] = React.useState(false);
  const [subsError, setSubsError] = React.useState<string | null>(null);
  // Sequence guard: scope-switch races (department-A then -B in quick
  // succession) used to allow A's late response to overwrite B's list.
  const subsReqSeqRef = React.useRef(0);
  React.useEffect(() => {
    if (!armToken || !billingAccountName || !departmentName) {
      setAllSubs([]);
      return;
    }
    const seq = ++subsReqSeqRef.current;
    let cancelled = false;
    setSubsLoading(true);
    setSubsError(null);
    const scopeTarget = `ba:${billingAccountName} dept:${departmentName}`;
    listDepartmentBillingSubscriptions(
      billingAccountName,
      departmentName,
      armToken,
    )
      .then((list) => {
        if (cancelled || seq !== subsReqSeqRef.current) return;
        setAllSubs(list);
        auditLog.record({
          actor: actorUsername,
          action: "list_department_billing_subscriptions",
          target: scopeTarget,
          status: "success",
          details: {
            billingAccountName,
            departmentName,
            scope: "department",
            count: list.length,
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== subsReqSeqRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setSubsError(message);
        auditLog.record({
          actor: actorUsername,
          action: "list_department_billing_subscriptions",
          target: scopeTarget,
          status: "failure",
          error: message,
          details: {
            billingAccountName,
            departmentName,
            scope: "department",
          },
        });
      })
      .finally(() => {
        if (!cancelled && seq === subsReqSeqRef.current) setSubsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    armToken,
    billingAccountName,
    departmentName,
    reloadTick,
    actorUsername,
  ]);

  /**
   * Group subscriptions by their enrollment-account display name. The
   * billing-subscriptions list doesn't surface the EA ARM id directly,
   * so we match on display name — EA names are unique within a billing
   * account so this is safe.
   *
   * Returns a tuple {grouped, orphaned}:
   *   - grouped: Map<eaDisplayName, sub[]> — only EAs we listed.
   *   - orphaned: sub[] whose invoiceSectionDisplayName either is
   *     blank or names an EA we didn't list (race between the EA
   *     fetch + the subs fetch, or an EA was moved out of the dept
   *     after a sub was provisioned under it). Surfaced separately
   *     so they aren't silently dropped from the per-EA view.
   */
  const { grouped: subsByEaDisplayName, orphaned: orphanedSubs } =
    React.useMemo(() => {
      const known = new Set(eas.map((e) => e.displayName));
      const m = new Map<string, EaBillingSubscription[]>();
      const orphans: EaBillingSubscription[] = [];
      for (const s of allSubs) {
        const key = s.invoiceSectionDisplayName ?? "";
        if (!key || !known.has(key)) {
          orphans.push(s);
          continue;
        }
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push(s);
      }
      return { grouped: m, orphaned: orphans };
    }, [allSubs, eas]);

  /* ----- Pivot: confirmation dialog before navigating ------------ */
  // Tracks how many subscription-create pivots this user has initiated in
  // the current session (shown as a quick-stat). The actual subscription
  // creation happens on the EA Subscription page; we only count pivots
  // launched from here.
  const [sessionCreateCount, setSessionCreateCount] = React.useState(0);
  // Pending pivot — when set, the ConfirmationDialog opens; once the
  // operator confirms we write the sessionStorage hints, record audit,
  // and navigate. Null = no dialog showing.
  const [pendingPivot, setPendingPivot] = React.useState<
    | {
        kind: "create-subscription";
        ea: EaEnrollmentAccount;
      }
    | {
        kind: "grant-creator";
      }
    | null
  >(null);

  const requestCreateSubscription = React.useCallback(
    (ea: EaEnrollmentAccount) => {
      setPendingPivot({ kind: "create-subscription", ea });
    },
    [],
  );
  const requestGrantCreator = React.useCallback(() => {
    setPendingPivot({ kind: "grant-creator" });
  }, []);

  const confirmPivot = React.useCallback(() => {
    if (!pendingPivot) return;
    if (pendingPivot.kind === "create-subscription") {
      const ea = pendingPivot.ea;
      let sessionStorageOk = true;
      try {
        sessionStorage.setItem(
          PIVOT_KEYS.EA_ACTIVE_ACCOUNT,
          account?.homeAccountId ?? "",
        );
        sessionStorage.setItem(
          PIVOT_KEYS.EA_PRESELECT_BA,
          billingAccountName,
        );
        sessionStorage.setItem(PIVOT_KEYS.EA_PRESELECT_EA, ea.name);
      } catch (err) {
        sessionStorageOk = false;
        // sessionStorage can be disabled (privacy mode / quota) — surface
        // it so the user knows the pre-select hint may not stick.
        // eslint-disable-next-line no-console
        console.warn(
          "[department-admin] sessionStorage write failed; EA Subscription page will not pre-fill",
          err,
        );
        showToast(
          store,
          "Couldn't persist pre-fill — you'll need to pick the billing/enrollment account again on the next page.",
          "warning",
        );
      }
      auditLog.record({
        actor: actorUsername,
        action: "create_ea_subscription_in_department",
        target: `ba:${billingAccountName} dept:${departmentName} ea:${ea.name}`,
        status: "success",
        details: {
          billingAccountName,
          departmentName,
          enrollmentAccountName: ea.name,
          enrollmentAccountDisplayName: ea.displayName,
          pivot: "/ea-subscription",
          stage: "pivot",
          prefillPersisted: sessionStorageOk,
        },
      });
      setSessionCreateCount((n) => n + 1);
      setPendingPivot(null);
      navigate("/ea-subscription");
      return;
    }
    if (pendingPivot.kind === "grant-creator") {
      try {
        sessionStorage.setItem(PIVOT_KEYS.SUB_MGR_TAB, "grant-sub-creator");
        sessionStorage.setItem(PIVOT_KEYS.SUB_MGR_BA, billingAccountName);
      } catch {
        /* ignore */
      }
      auditLog.record({
        actor: actorUsername,
        action: "grant_sub_creator_pivot",
        target: `ba:${billingAccountName} dept:${departmentName}`,
        status: "success",
        details: {
          billingAccountName,
          departmentName,
          pivot: "/sub-manager",
          stage: "pivot",
        },
      });
      setPendingPivot(null);
      navigate("/sub-manager");
      return;
    }
  }, [
    pendingPivot,
    account?.homeAccountId,
    actorUsername,
    billingAccountName,
    departmentName,
    navigate,
    store,
  ]);
  const cancelPivot = React.useCallback(() => setPendingPivot(null), []);

  /* ----- Filters & sort ------------------------------------------ */
  const [search, setSearch] = React.useState("");
  const [eaStatusFilter, setEaStatusFilter] =
    React.useState<EaStatusFilter>("all");
  const [eaSortKey, setEaSortKey] = React.useState<EaSortKey>("name");
  // Independent search box for the subscriptions list.
  const [subsSearch, setSubsSearch] = React.useState("");
  const [subsStatusFilter, setSubsStatusFilter] =
    React.useState<string>("all");
  const [subsViewMode, setSubsViewMode] =
    React.useState<SubsViewMode>("grouped");

  // Distinct status values across the dept's subs — drives the status
  // dropdown so we don't have to hardcode the Azure billing taxonomy.
  const subsStatusValues = React.useMemo(() => {
    const set = new Set<string>();
    for (const s of allSubs) {
      if (s.status) set.add(s.status);
    }
    return Array.from(set).sort();
  }, [allSubs]);

  const filteredEas = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = eas.filter((e) => {
      if (eaStatusFilter !== "all") {
        if (normalizeStatus(e.status) !== eaStatusFilter) return false;
      }
      if (!q) return true;
      return [e.displayName, e.name, e.accountOwner ?? "", e.costCenter ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    // Sort
    const sorted = [...filtered];
    switch (eaSortKey) {
      case "subs":
        sorted.sort(
          (a, b) =>
            (subsByEaDisplayName.get(b.displayName)?.length ?? 0) -
            (subsByEaDisplayName.get(a.displayName)?.length ?? 0),
        );
        break;
      case "status":
        sorted.sort((a, b) =>
          (a.status ?? "").localeCompare(b.status ?? ""),
        );
        break;
      case "owner":
        sorted.sort((a, b) =>
          (a.accountOwner ?? "").localeCompare(b.accountOwner ?? ""),
        );
        break;
      case "name":
      default:
        sorted.sort((a, b) =>
          a.displayName.localeCompare(b.displayName),
        );
        break;
    }
    return sorted;
  }, [eas, search, eaStatusFilter, eaSortKey, subsByEaDisplayName]);

  const filteredSubs = React.useMemo(() => {
    const q = subsSearch.trim().toLowerCase();
    return allSubs.filter((s) => {
      if (subsStatusFilter !== "all" && (s.status ?? "") !== subsStatusFilter) {
        return false;
      }
      if (!q) return true;
      return [
        s.displayName,
        s.subscriptionId ?? "",
        s.status ?? "",
        s.invoiceSectionDisplayName ?? "",
        s.costCenter ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [allSubs, subsSearch, subsStatusFilter]);

  // Expanded / collapsed state per EA in the per-EA view. Default: all
  // collapsed when there are >5 EAs so the list stays scannable; below
  // that we keep everything expanded for instant overview.
  const [expandedEas, setExpandedEas] = React.useState<Set<string>>(
    () => new Set(),
  );
  // Whenever the EA list changes, default expansion: expand all when ≤5,
  // collapse all otherwise. Operator's individual toggles persist within
  // the same EA set.
  React.useEffect(() => {
    setExpandedEas((prev) => {
      if (eas.length <= 5) return new Set(eas.map((e) => e.id));
      // Preserve any expansions the operator already made; otherwise
      // start collapsed.
      const next = new Set<string>();
      for (const e of eas) if (prev.has(e.id)) next.add(e.id);
      return next;
    });
  }, [eas]);
  const toggleEa = React.useCallback((id: string) => {
    setExpandedEas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setAllExpansion = React.useCallback(
    (expand: boolean) => {
      setExpandedEas(expand ? new Set(eas.map((e) => e.id)) : new Set());
    },
    [eas],
  );

  /* ----- Quick stats --------------------------------------------- */
  const activeSubsCount = React.useMemo(
    () =>
      allSubs.filter(
        (s) =>
          (s.status ?? "").toLowerCase() === "active" ||
          (s.status ?? "").toLowerCase() === "enabled",
      ).length,
    [allSubs],
  );
  // EAs that have at least one sub — coverage metric.
  const eaWithSubsCount = React.useMemo(
    () => eas.filter((e) => (subsByEaDisplayName.get(e.displayName)?.length ?? 0) > 0).length,
    [eas, subsByEaDisplayName],
  );
  const eaWithoutSubsCount = eas.length - eaWithSubsCount;

  /* ----- Copy-all-IDs helpers ------------------------------------ */
  const copyAllEaIds = React.useCallback(async () => {
    if (filteredEas.length === 0) return;
    const text = filteredEas
      .map((e) => `${e.name}\t${e.displayName}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      showToast(
        store,
        `Copied ${filteredEas.length} enrollment account id${filteredEas.length === 1 ? "" : "s"} to clipboard`,
        "success",
      );
    } catch {
      showToast(store, "Couldn't write to clipboard", "error");
    }
  }, [filteredEas, store]);

  const copyAllSubIds = React.useCallback(async () => {
    const subs = filteredSubs.filter((s) => !!s.subscriptionId);
    if (subs.length === 0) return;
    const text = subs
      .map((s) => `${s.subscriptionId}\t${s.displayName}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      showToast(
        store,
        `Copied ${subs.length} subscription id${subs.length === 1 ? "" : "s"} to clipboard`,
        "success",
      );
    } catch {
      showToast(store, "Couldn't write to clipboard", "error");
    }
  }, [filteredSubs, store]);

  /* ----- Export column descriptors ------------------------------- */
  const eaExportColumns = React.useMemo(
    () => [
      { header: "Display name", accessor: (e: EaEnrollmentAccount) => e.displayName },
      { header: "Name (id)", accessor: (e: EaEnrollmentAccount) => e.name },
      { header: "Status", accessor: (e: EaEnrollmentAccount) => e.status ?? "" },
      { header: "Account owner", accessor: (e: EaEnrollmentAccount) => e.accountOwner ?? "" },
      { header: "Cost center", accessor: (e: EaEnrollmentAccount) => e.costCenter ?? "" },
      { header: "Start date", accessor: (e: EaEnrollmentAccount) => e.startDate ?? "" },
      { header: "End date", accessor: (e: EaEnrollmentAccount) => e.endDate ?? "" },
      {
        header: "Sub count",
        accessor: (e: EaEnrollmentAccount) =>
          subsByEaDisplayName.get(e.displayName)?.length ?? 0,
      },
      { header: "ARM id", accessor: (e: EaEnrollmentAccount) => e.id },
    ],
    [subsByEaDisplayName],
  );
  const subExportColumns = React.useMemo(
    () => [
      { header: "Display name", accessor: (s: EaBillingSubscription) => s.displayName },
      { header: "Subscription ID", accessor: (s: EaBillingSubscription) => s.subscriptionId ?? "" },
      { header: "Status", accessor: (s: EaBillingSubscription) => s.status ?? "" },
      {
        header: "Enrollment account",
        accessor: (s: EaBillingSubscription) => s.invoiceSectionDisplayName ?? "",
      },
      { header: "Cost center", accessor: (s: EaBillingSubscription) => s.costCenter ?? "" },
      { header: "SKU", accessor: (s: EaBillingSubscription) => s.skuId ?? "" },
      { header: "ARM id", accessor: (s: EaBillingSubscription) => s.id },
    ],
    [],
  );

  /* ----- Global tenant-switch sync -------------------------------- *
   * Mirrors the canonical pattern from invite-user-page: when another
   * page (or a background event) switches the active tenant for one of
   * our signed-in accounts, snap this page's source-account picker to
   * that account so the cascading BA → dept → EA fetches re-issue
   * against the freshly-active tenant instead of stale tokens.
   */
  useTenantChange(undefined, (detail) => {
    const candidate = detail.homeAccountId;
    if (!candidates.some((c) => c.homeAccountId === candidate)) return;
    if (accountId === candidate) return;
    setAccountIdState(candidate);
    try {
      sessionStorage.setItem(PIVOT_KEYS.EA_ACTIVE_ACCOUNT, candidate);
    } catch {
      /* ignore */
    }
  });

  /* ----- Render --------------------------------------------------- */

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Department Admin"
          description="EA Department Admin workspace — view enrollment accounts and billing subs in your department, then create new subs under any of them."
        />
        <EmptyState
          icon={Crown}
          title="No Azure account signed in"
          description="Sign in with an EA-billing-capable account first."
        />
      </div>
    );
  }

  // Friendly summary for the pivot dialog.
  const renderPivotDialogMessage = () => {
    if (!pendingPivot) return "";
    if (pendingPivot.kind === "create-subscription") {
      const ea = pendingPivot.ea;
      return (
        <div className="flex flex-col gap-2 text-xs">
          <p className="m-0">
            Pivot to the <strong>EA Subscription</strong> page with the
            following pre-fill:
          </p>
          <ul className="m-0 flex flex-col gap-1 pl-4">
            <li>
              <span className="text-muted-foreground">Account:</span>{" "}
              {account?.name ?? "—"}
            </li>
            <li>
              <span className="text-muted-foreground">Billing account:</span>{" "}
              <span className="font-mono text-2xs">{billingAccountName}</span>
            </li>
            <li>
              <span className="text-muted-foreground">Enrollment account:</span>{" "}
              <strong>{ea.displayName}</strong>{" "}
              <span className="font-mono text-2xs text-muted-foreground">
                ({ea.name})
              </span>
            </li>
          </ul>
          <p className="m-0 text-2xs text-muted-foreground">
            No subscription is created yet — the next page collects the
            display name, SKU, and (optionally) cross-tenant owner before
            you submit.
          </p>
        </div>
      );
    }
    if (pendingPivot.kind === "grant-creator") {
      return (
        <div className="flex flex-col gap-2 text-xs">
          <p className="m-0">
            Pivot to <strong>Sub Manager</strong> with the{" "}
            <em>Grant subscription creator</em> tab open and this billing
            account pre-selected:
          </p>
          <ul className="m-0 flex flex-col gap-1 pl-4">
            <li>
              <span className="text-muted-foreground">Billing account:</span>{" "}
              <span className="font-mono text-2xs">{billingAccountName}</span>
            </li>
            <li>
              <span className="text-muted-foreground">Department context:</span>{" "}
              {selectedDept?.departmentName ?? "—"}
            </li>
          </ul>
          <p className="m-0 text-2xs text-muted-foreground">
            The grant itself is created on the Sub Manager page — you'll
            pick the principal there. This page only carries the
            billing-account context forward.
          </p>
        </div>
      );
    }
    return "";
  };

  return (
    <div className="flex flex-col gap-4 py-2">
      {/* Pivot confirmation dialog: stands between an action button and
          the cross-page navigation so the operator can verify exactly
          what's about to be pre-filled (and audit-recorded). */}
      <ConfirmationDialog
        hidden={!pendingPivot}
        title={
          pendingPivot?.kind === "create-subscription"
            ? "Create subscription under this enrollment account?"
            : pendingPivot?.kind === "grant-creator"
              ? "Grant subscription-creator on this billing account?"
              : ""
        }
        message={renderPivotDialogMessage()}
        confirmText={
          pendingPivot?.kind === "create-subscription"
            ? "Continue to EA Subscription"
            : "Continue to Sub Manager"
        }
        cancelText="Stay here"
        onConfirm={confirmPivot}
        onCancel={cancelPivot}
      />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader
          title="Department Admin"
          description="EA Department Admin workspace — view enrollment accounts and billing subs in your department, then create new subs under any of them."
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setReloadTick((n) => n + 1)}
            disabled={!departmentName || eaLoading || subsLoading}
            aria-label="Refresh enrollment accounts and subscriptions"
            loading={eaLoading || subsLoading}
          >
            {!(eaLoading || subsLoading) && (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            Refresh
          </Button>
        </PageHeader>
        {/* Token freshness badge — quiet by default, surfaces when
            < 10 min from expiry. Click to force-refresh BEFORE a long
            departmental survey or pivot so the token doesn't flip
            between scope-loading and the action page. */}
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

      {/* ----- Scope picker -------------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Crown className="h-4 w-4 text-primary" aria-hidden />
            Scope
            <InfoTooltip
              variant="help"
              content={
                <span className="block max-w-xs text-2xs">
                  A <strong>Department Admin</strong> can read enrollment
                  accounts and billing subscriptions inside a single EA
                  department. Department scope is narrower than the EA
                  billing-account scope used by EA Admin / EA Purchase, so
                  this page uses the narrower{" "}
                  <code className="font-mono">/departments/.../*</code>{" "}
                  endpoints to avoid the 403 your role would get on the
                  wider ones.
                </span>
              }
              ariaLabel="What is a Department admin?"
            />
          </CardTitle>
          <CardDescription>
            Pick the signed-in account, the EA billing account, and the
            department you administer. Selection is remembered for this
            session.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Source account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger aria-label="Source account">
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
                <Loader2
                  className="h-3 w-3 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                loading
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
                <SelectTrigger aria-label="Billing account">
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
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Department</Label>
            {deptsLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2
                  className="h-3 w-3 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                loading
              </p>
            ) : deptsError ? (
              <ErrorState
                size="compact"
                message="Failed to load departments."
                detail={deptsError}
                onRetry={() => setReloadTick((n) => n + 1)}
              />
            ) : depts.length === 0 ? (
              <EmptyState
                icon={Layers}
                title="No departments visible"
                description="Your sign-in lacks EA department visibility on this billing account."
                size="compact"
              />
            ) : (
              <Select
                value={departmentName}
                onValueChange={setDepartmentName}
              >
                <SelectTrigger aria-label="Department">
                  <SelectValue placeholder="Pick a department" />
                </SelectTrigger>
                <SelectContent>
                  {depts.map((d) => (
                    <SelectItem key={d.name} value={d.name}>
                      <span className="flex flex-col">
                        <span className="text-sm">{d.departmentName}</span>
                        <span className="font-mono text-2xs text-muted-foreground">
                          {d.name}
                          {d.costCenter ? ` · CC ${d.costCenter}` : ""}
                          {typeof d.enrollmentAccounts === "number"
                            ? ` · ${d.enrollmentAccounts} EA${d.enrollmentAccounts === 1 ? "" : "s"}`
                            : ""}
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

      {!departmentName ? (
        <EmptyState
          icon={Layers}
          title="Pick a department"
          description="Once selected, every enrollment account under that department appears below with its billing subs and a Create-subscription action."
        />
      ) : (
        <>
          {/* ----- Department summary + quick stats ------------ */}
          {selectedDept && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Layers className="h-4 w-4 text-primary" aria-hidden />
                  {selectedDept.departmentName}
                  <InfoTooltip
                    variant="help"
                    content={
                      <span className="block max-w-xs text-2xs">
                        <strong>Department scope:</strong> all enrollment
                        accounts, billing subscriptions, and cost roll-ups
                        belong to this department. Subscription-creator
                        grants made here apply only inside the department.
                      </span>
                    }
                    ariaLabel="What is the department scope?"
                  />
                </CardTitle>
                <CardDescription>
                  Department resource scope (EA).
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Name:</span>
                    <CopyableText
                      value={selectedDept.name}
                      mono
                      ariaLabel={`Copy department id ${selectedDept.name}`}
                    />
                  </div>
                  {selectedDept.costCenter && (
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Cost center:</span>
                      <Badge variant="secondary" className="text-2xs">
                        {selectedDept.costCenter}
                      </Badge>
                    </div>
                  )}
                  {selectedDept.status && (
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Status:</span>
                      <Badge variant="outline" className="text-2xs">
                        {selectedDept.status}
                      </Badge>
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">ARM id:</span>
                    <span className="group/copy inline-flex items-center gap-1.5 align-middle">
                      <span className="font-mono text-2xs text-muted-foreground max-w-[28ch] truncate">
                        {selectedDept.id}
                      </span>
                      <CopyButton
                        value={selectedDept.id}
                        ariaLabel="Copy department ARM resource id"
                      />
                    </span>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={requestGrantCreator}
                      aria-label="Grant subscription-creator role inside this department"
                    >
                      <UserCheck className="h-3.5 w-3.5" aria-hidden /> Grant Sub Creator
                    </Button>
                  </div>
                </div>
                {/* Quick-stat row */}
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Department quick stats"
                >
                  <SummaryStatItem
                    label="Enrollment accts"
                    value={eaLoading ? "…" : eas.length}
                    compact
                  />
                  <SummaryStatItem
                    label="EAs w/ subs"
                    value={eaLoading || subsLoading ? "…" : eaWithSubsCount}
                    compact
                    tone={eaWithSubsCount > 0 ? "success" : "muted"}
                    hint={
                      eas.length > 0
                        ? `${eaWithoutSubsCount} idle`
                        : undefined
                    }
                  />
                  <SummaryStatItem
                    label="Total subs"
                    value={subsLoading ? "…" : allSubs.length}
                    compact
                    tone="info"
                  />
                  <SummaryStatItem
                    label="Active subs"
                    value={subsLoading ? "…" : activeSubsCount}
                    compact
                    tone={activeSubsCount > 0 ? "success" : "muted"}
                  />
                  {orphanedSubs.length > 0 && (
                    <SummaryStatItem
                      label="Orphaned"
                      value={orphanedSubs.length}
                      compact
                      tone="warning"
                      hint="EA not in list"
                    />
                  )}
                  <SummaryStatItem
                    label="Created (session)"
                    value={sessionCreateCount}
                    compact
                    tone={sessionCreateCount > 0 ? "info" : "muted"}
                    hint="pivots launched"
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* ----- Enrollment accounts list -------------------- */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <Building2 className="h-4 w-4 text-primary" aria-hidden />
                Enrollment accounts in this department
                <Badge variant="secondary" className="text-2xs">
                  {filteredEas.length}
                  {filteredEas.length !== eas.length ? ` / ${eas.length}` : ""}
                </Badge>
                <InfoTooltip
                  variant="help"
                  content={
                    <span className="block max-w-xs text-2xs">
                      An <strong>enrollment account</strong> is the EA's
                      cost-tracking bucket. Every Azure subscription billed
                      under EA is owned by exactly one enrollment account.
                      To provision a subscription you must first pick the
                      EA that will own its costs.
                    </span>
                  }
                  ariaLabel="What is an enrollment account?"
                />
                <div className="ml-auto flex items-center gap-2">
                  {eas.length > 5 && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setAllExpansion(true)}
                        disabled={eaLoading || eas.length === 0}
                        aria-label="Expand all enrollment account rows"
                      >
                        Expand all
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setAllExpansion(false)}
                        disabled={eaLoading || eas.length === 0}
                        aria-label="Collapse all enrollment account rows"
                      >
                        Collapse all
                      </Button>
                    </>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={copyAllEaIds}
                    disabled={eaLoading || filteredEas.length === 0}
                    aria-label="Copy all enrollment account ids to the clipboard as a TSV"
                  >
                    Copy IDs
                  </Button>
                  <ExportMenu
                    rows={filteredEas}
                    columns={eaExportColumns}
                    filename={`department-admin-enrollment-accounts-${departmentName || "scope"}`}
                    jsonMetadata={{
                      billingAccountName,
                      departmentName,
                      filterApplied: search || null,
                      statusFilter: eaStatusFilter,
                      sort: eaSortKey,
                    }}
                  />
                </div>
              </CardTitle>
              <CardDescription>
                Each enrollment account is a cost-tracking bucket. New
                subscriptions are created under one of them; click{" "}
                <strong>Create subscription</strong> on a row to pivot to
                the EA Subscription page with that EA pre-selected. Click
                an EA row header to expand its sub list when collapsed.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-1 min-w-[220px] flex-col gap-1">
                  <Label htmlFor="ea-search" className="text-2xs uppercase tracking-wider text-muted-foreground">
                    Search
                  </Label>
                  <Input
                    id="ea-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Name, owner, or cost center…"
                    className="text-xs"
                    aria-label="Filter enrollment accounts"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-2xs uppercase tracking-wider text-muted-foreground">
                    Status
                  </Label>
                  <Select
                    value={eaStatusFilter}
                    onValueChange={(v) =>
                      setEaStatusFilter(v as EaStatusFilter)
                    }
                  >
                    <SelectTrigger
                      className="w-[140px]"
                      aria-label="Filter by status"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-2xs uppercase tracking-wider text-muted-foreground">
                    Sort
                  </Label>
                  <Select
                    value={eaSortKey}
                    onValueChange={(v) => setEaSortKey(v as EaSortKey)}
                  >
                    <SelectTrigger
                      className="w-[160px]"
                      aria-label="Sort enrollment accounts"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="name">
                        <span className="flex items-center gap-2">
                          <ArrowUpDown className="h-3 w-3" aria-hidden />
                          Name (A → Z)
                        </span>
                      </SelectItem>
                      <SelectItem value="subs">Sub count (high → low)</SelectItem>
                      <SelectItem value="status">Status</SelectItem>
                      <SelectItem value="owner">Owner</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {eaLoading ? (
                <SkeletonLoader variant="list" rows={4} />
              ) : eaError ? (
                <ErrorState
                  size="compact"
                  message="Failed to load enrollment accounts."
                  detail={eaError}
                  onRetry={() => setReloadTick((n) => n + 1)}
                />
              ) : eas.length === 0 ? (
                <EmptyState
                  icon={Building2}
                  title="No enrollment accounts in this department"
                  description="A department admin needs at least one enrollment account before billing subs can be created. Ask an EA admin to assign one."
                  size="compact"
                />
              ) : filteredEas.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No enrollment accounts match{" "}
                  {search ? (
                    <code className="font-mono">{search}</code>
                  ) : (
                    "the current filter"
                  )}
                  .
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {filteredEas.map((ea) => {
                    const subs = subsByEaDisplayName.get(ea.displayName) ?? [];
                    const isExpanded =
                      expandedEas.has(ea.id) || eas.length <= 5;
                    return (
                      <li
                        key={ea.id}
                        className="flex flex-col gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {/* Click target: name area toggles expansion when the EA list is large.
                              Always-clickable button so the affordance is consistent. */}
                          <button
                            type="button"
                            onClick={() => toggleEa(ea.id)}
                            className="flex flex-1 min-w-0 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${ea.displayName} (${subs.length} sub${subs.length === 1 ? "" : "s"})`}
                          >
                            <Building2
                              className="h-3.5 w-3.5 text-muted-foreground shrink-0"
                              aria-hidden
                            />
                            <span className="font-medium truncate">
                              {ea.displayName}
                            </span>
                          </button>
                          <CopyableText
                            value={ea.name}
                            mono
                            ariaLabel={`Copy enrollment account id ${ea.name}`}
                          />
                          {ea.status && (
                            <Badge
                              variant={
                                normalizeStatus(ea.status) === "active"
                                  ? "outline"
                                  : "secondary"
                              }
                              className="text-2xs"
                            >
                              {ea.status}
                            </Badge>
                          )}
                          {ea.costCenter && (
                            <Badge variant="secondary" className="text-2xs">
                              CC: {ea.costCenter}
                            </Badge>
                          )}
                          {ea.accountOwner && (
                            <InfoTooltip
                              variant="info"
                              content={
                                <span className="block max-w-xs text-2xs">
                                  <strong>Account owner:</strong>{" "}
                                  {ea.accountOwner}
                                  {ea.startDate || ea.endDate ? (
                                    <>
                                      <br />
                                      <span className="text-muted-foreground">
                                        Term: {ea.startDate ?? "?"}
                                        {" → "}
                                        {ea.endDate ?? "ongoing"}
                                      </span>
                                    </>
                                  ) : null}
                                </span>
                              }
                              ariaLabel="Show account owner details"
                            />
                          )}
                          {ea.accountOwner && (
                            <span className="text-2xs text-muted-foreground hidden sm:inline">
                              owner: {ea.accountOwner}
                            </span>
                          )}
                          <Badge
                            variant={subs.length > 0 ? "outline" : "secondary"}
                            className="ml-auto text-2xs"
                            aria-label={`${subs.length} subscription${subs.length === 1 ? "" : "s"}`}
                          >
                            {subs.length} sub
                            {subs.length === 1 ? "" : "s"}
                          </Badge>
                          <Button
                            type="button"
                            size="sm"
                            variant="default"
                            className="h-7 text-2xs"
                            onClick={(e) => {
                              // Prevent the row-toggle from firing for this nested action.
                              e.stopPropagation();
                              requestCreateSubscription(ea);
                            }}
                            disabled={
                              normalizeStatus(ea.status) !== "active"
                            }
                            aria-label={`Create subscription under enrollment account ${ea.displayName}`}
                            title={
                              normalizeStatus(ea.status) !== "active"
                                ? "EA is inactive — Azure will reject new subscriptions"
                                : "Pre-fills the EA Subscription page with this enrollment account"
                            }
                          >
                            <PlusCircle className="h-3.5 w-3.5" aria-hidden />
                            Create subscription
                          </Button>
                        </div>
                        {isExpanded && (
                          <>
                            {subs.length === 0 ? (
                              <p className="pl-5 text-2xs italic text-muted-foreground">
                                No subscriptions yet — use{" "}
                                <strong>Create subscription</strong> above to
                                provision the first one.
                              </p>
                            ) : (
                              <ul className="flex flex-col gap-1 pl-5">
                                {subs.map((s) => (
                                  <li
                                    key={s.id}
                                    className="flex flex-wrap items-center gap-2 text-2xs"
                                  >
                                    <Server
                                      className="h-3 w-3 text-muted-foreground"
                                      aria-hidden
                                    />
                                    <span className="font-medium">
                                      {s.displayName}
                                    </span>
                                    {s.subscriptionId && (
                                      <CopyableText
                                        value={s.subscriptionId}
                                        mono
                                        ariaLabel={`Copy subscription id ${s.subscriptionId}`}
                                      />
                                    )}
                                    {s.status && (
                                      <Badge
                                        variant="outline"
                                        className="text-[9px]"
                                      >
                                        {s.status}
                                      </Badge>
                                    )}
                                    {s.skuId && (
                                      <span className="text-[9px] text-muted-foreground font-mono">
                                        {s.skuId}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {orphanedSubs.length > 0 && (
                <Alert variant="default" className="mt-2">
                  <HelpCircle className="h-3.5 w-3.5" aria-hidden />
                  <AlertDescription className="text-2xs">
                    <strong>{orphanedSubs.length}</strong> subscription
                    {orphanedSubs.length === 1 ? " is" : "s are"} billed
                    against an enrollment account not in this list (most
                    commonly: the EA was moved out of the department after
                    the sub was created). Switch to the{" "}
                    <strong>Flat</strong> view below to see them.
                  </AlertDescription>
                </Alert>
              )}
              {subsError && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  <AlertDescription>
                    Could not load subs to populate the per-EA list:{" "}
                    {subsError}
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* ----- Department-wide billing subscriptions ------- */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <Server className="h-4 w-4 text-primary" aria-hidden />
                Billing subscriptions (department scope)
                <Badge variant="secondary" className="text-2xs">
                  {filteredSubs.length}
                  {filteredSubs.length !== allSubs.length
                    ? ` / ${allSubs.length}`
                    : ""}
                </Badge>
                <InfoTooltip
                  variant="help"
                  content={
                    <span className="block max-w-xs text-2xs">
                      Uses{" "}
                      <code className="font-mono">
                        /departments/{"{name}"}/billingSubscriptions
                      </code>{" "}
                      — the billing-account-scope variant{" "}
                      <code className="font-mono">
                        /billingAccounts/.../billingSubscriptions
                      </code>{" "}
                      returns 403 for Department Admins, so this narrower
                      endpoint is correct and intentional. Do not change
                      it without verifying RBAC.
                    </span>
                  }
                  ariaLabel="Why is this scope narrower than EA Admin's?"
                />
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={copyAllSubIds}
                    disabled={subsLoading || filteredSubs.length === 0}
                    aria-label="Copy all subscription ids to the clipboard as a TSV"
                  >
                    Copy IDs
                  </Button>
                  <ExportMenu
                    rows={filteredSubs}
                    columns={subExportColumns}
                    filename={`department-admin-billing-subs-${departmentName || "scope"}`}
                    jsonMetadata={{
                      billingAccountName,
                      departmentName,
                      scope: "department",
                      filterApplied: subsSearch || null,
                      statusFilter: subsStatusFilter,
                    }}
                  />
                </div>
              </CardTitle>
              <CardDescription>
                Department-scoped sub list. Use <strong>Grouped</strong> to
                see subs nested under their owning EA (mirrors the card
                above with extra detail), or <strong>Flat</strong> to
                browse and filter every sub in one table — useful when
                the same display name appears across multiple EAs or for
                quick exports.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-1 min-w-[220px] flex-col gap-1">
                  <Label htmlFor="subs-search" className="text-2xs uppercase tracking-wider text-muted-foreground">
                    Search
                  </Label>
                  <Input
                    id="subs-search"
                    value={subsSearch}
                    onChange={(e) => setSubsSearch(e.target.value)}
                    placeholder="Name, sub id, EA, or cost center…"
                    className="text-xs"
                    aria-label="Filter billing subscriptions"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-2xs uppercase tracking-wider text-muted-foreground">
                    Status
                  </Label>
                  <Select
                    value={subsStatusFilter}
                    onValueChange={setSubsStatusFilter}
                  >
                    <SelectTrigger
                      className="w-[160px]"
                      aria-label="Filter by status"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      {subsStatusValues.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-2xs uppercase tracking-wider text-muted-foreground">
                    View
                  </Label>
                  <Select
                    value={subsViewMode}
                    onValueChange={(v) => setSubsViewMode(v as SubsViewMode)}
                  >
                    <SelectTrigger
                      className="w-[140px]"
                      aria-label="View mode"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="grouped">Grouped by EA</SelectItem>
                      <SelectItem value="flat">Flat</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {subsLoading ? (
                <SkeletonLoader variant="list" rows={4} />
              ) : subsError ? (
                <ErrorState
                  size="compact"
                  message="Failed to load billing subscriptions."
                  detail={subsError}
                  onRetry={() => setReloadTick((n) => n + 1)}
                />
              ) : allSubs.length === 0 ? (
                <EmptyState
                  icon={Server}
                  title="No subscriptions yet"
                  description="No subscriptions reported under any enrollment account in this department. Use Create subscription on an enrollment account row above to provision the first one."
                  size="compact"
                />
              ) : filteredSubs.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No subscriptions match the current filter
                  {subsSearch ? (
                    <>
                      {" "}
                      (<code className="font-mono">{subsSearch}</code>)
                    </>
                  ) : null}
                  .
                </p>
              ) : subsViewMode === "flat" ? (
                <ul className="flex flex-col gap-1">
                  {filteredSubs.map((s) => (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-2xs"
                    >
                      <Server
                        className="h-3 w-3 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="font-medium">{s.displayName}</span>
                      {s.subscriptionId && (
                        <CopyableText
                          value={s.subscriptionId}
                          mono
                          ariaLabel={`Copy subscription id ${s.subscriptionId}`}
                        />
                      )}
                      {s.invoiceSectionDisplayName ? (
                        <span className="text-muted-foreground">
                          via {s.invoiceSectionDisplayName}
                        </span>
                      ) : (
                        <span className="text-warning">via (no EA)</span>
                      )}
                      {s.costCenter && (
                        <Badge variant="secondary" className="text-[9px]">
                          CC: {s.costCenter}
                        </Badge>
                      )}
                      {s.status && (
                        <Badge variant="outline" className="text-[9px]">
                          {s.status}
                        </Badge>
                      )}
                      {s.skuId && (
                        <span className="text-[9px] text-muted-foreground font-mono">
                          {s.skuId}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                // Grouped view: same data as flat, organised under each EA
                // header — plus an explicit "Orphaned" group at the bottom
                // for subs whose EA didn't appear in our list.
                <div className="flex flex-col gap-3">
                  {Array.from(subsByEaDisplayName.entries())
                    .map(([eaName, subs]) => ({
                      eaName,
                      subs: subs.filter((s) => filteredSubs.includes(s)),
                    }))
                    .filter((g) => g.subs.length > 0)
                    .sort((a, b) => a.eaName.localeCompare(b.eaName))
                    .map((g) => (
                      <div key={g.eaName} className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                          <Building2 className="h-3 w-3" aria-hidden />
                          {g.eaName}
                          <Badge variant="outline" className="text-[9px]">
                            {g.subs.length}
                          </Badge>
                        </div>
                        <ul className="flex flex-col gap-1 pl-5">
                          {g.subs.map((s) => (
                            <li
                              key={s.id}
                              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-2xs"
                            >
                              <Server
                                className="h-3 w-3 text-muted-foreground"
                                aria-hidden
                              />
                              <span className="font-medium">{s.displayName}</span>
                              {s.subscriptionId && (
                                <CopyableText
                                  value={s.subscriptionId}
                                  mono
                                  ariaLabel={`Copy subscription id ${s.subscriptionId}`}
                                />
                              )}
                              {s.costCenter && (
                                <Badge variant="secondary" className="text-[9px]">
                                  CC: {s.costCenter}
                                </Badge>
                              )}
                              {s.status && (
                                <Badge variant="outline" className="text-[9px]">
                                  {s.status}
                                </Badge>
                              )}
                              {s.skuId && (
                                <span className="text-[9px] text-muted-foreground font-mono">
                                  {s.skuId}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  {(() => {
                    const orphanedFiltered = orphanedSubs.filter((s) =>
                      filteredSubs.includes(s),
                    );
                    if (orphanedFiltered.length === 0) return null;
                    return (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-warning">
                          <HelpCircle className="h-3 w-3" aria-hidden />
                          Orphaned (EA not in this department's list)
                          <Badge variant="outline" className="text-[9px] border-warning text-warning">
                            {orphanedFiltered.length}
                          </Badge>
                        </div>
                        <ul className="flex flex-col gap-1 pl-5">
                          {orphanedFiltered.map((s) => (
                            <li
                              key={s.id}
                              className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-1.5 text-2xs"
                            >
                              <Server
                                className="h-3 w-3 text-warning"
                                aria-hidden
                              />
                              <span className="font-medium">
                                {s.displayName}
                              </span>
                              {s.subscriptionId && (
                                <CopyableText
                                  value={s.subscriptionId}
                                  mono
                                  ariaLabel={`Copy subscription id ${s.subscriptionId}`}
                                />
                              )}
                              <span className="text-muted-foreground">
                                via{" "}
                                {s.invoiceSectionDisplayName ?? "(no EA)"}
                              </span>
                              {s.status && (
                                <Badge variant="outline" className="text-[9px]">
                                  {s.status}
                                </Badge>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ----- Cross-page shortcuts ------------------------ */}
          <Card className="border-dashed">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4 text-primary" />
                Common next steps
              </CardTitle>
              <CardDescription>
                Pivots inherit the picker state above where applicable.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigate("/ea-subscription")}
                aria-label="Open EA Subscription creator (no pre-fill)"
              >
                <BadgeCheck className="h-3.5 w-3.5" />
                Open EA Subscription creator
                <ArrowRight className="h-3 w-3" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigate("/ea-billing-manager")}
                aria-label="Open EA Billing Manager"
              >
                <Users className="h-3.5 w-3.5" />
                EA Billing Manager
                <ArrowRight className="h-3 w-3" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigate("/audit-log")}
                aria-label="Open the audit log"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Audit log
                <ArrowRight className="h-3 w-3" />
              </Button>
            </CardContent>
          </Card>
        </>
      )}

    </div>
  );
};
