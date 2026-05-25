/**
 * EA Billing Manager — operator console for the Microsoft.Billing REST
 * surface at billing-account scope. Wires every EA-relevant endpoint
 * into a tabbed UI so an EA admin can inspect and mutate billing state
 * without dropping to az cli.
 *
 * Tabs:
 *   Overview         — billingProperty + agreements + permissions summary.
 *   Permissions      — actions/notActions array the caller actually holds.
 *   Role Assignments — list + add (any role definition) + delete.
 *   Departments      — list (read-only; legacy EA structure).
 *   Enrollment Accts — list (already used by Create EA Sub).
 *   Subscriptions    — list of subs billed under this account.
 *   Invoices         — last-12-months list with download URLs.
 *   Reservations     — tenant-wide reservation orders.
 *   Policies         — purchase / dev-test policy editor.
 *
 * Future endpoints that aren't yet wired (transactions, transfers,
 * recipient transfers, custom billing roles, billingProfiles edit,
 * billingSubscription move/cancel) are listed at the bottom of the
 * page as "available via API" placeholders so the next iteration has
 * a checklist.
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  BadgeCheck,
  Building2,
  Check,
  ChevronRight,
  Copy,
  Crown,
  Database,
  Eye,
  ExternalLink,
  FileText,
  Gauge,
  Info,
  Key,
  Layers,
  Loader2,
  Network,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Server,
  Shield,
  ShieldCheck,
  Sliders,
  Sparkles,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  Wand2,
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
import { cn } from "@/lib/utils";

import {
  decodeJwtClaimsUnsafe,
  getActiveTenant,
  getArmTokenForAccount,
  getGraphTokenForAccount,
} from "../../auth/msal-auth";
import { withPassthroughRecovery } from "../../auth/passthrough-recovery";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { auditLog } from "../../services/audit-log";
import {
  listEaBillingAccounts,
  listEaAgreements,
  listEaBillingPermissions,
  listEaDepartments,
  listEaBillingSubscriptions,
  listEaInvoices,
  listEnrollmentAccounts,
  listReservationOrders,
  getEaBillingPolicy,
  updateEaBillingPolicy,
  listBillingRoleAssignments,
  listBillingRoleDefinitions,
  createBillingRoleAssignment,
  deleteBillingRoleAssignment,
  getBillingProperty,
  EA_BILLING_ROLE_NAMES,
  findUserByUpnOrMail,
  getPrincipalsByIds,
  listBillingProfiles,
  listInvoiceSections,
  // Round-2 endpoints:
  listEaTransactions,
  listOutboundTransfers,
  createOutboundTransfer,
  listInboundTransfers,
  acceptInboundTransfer,
  declineInboundTransfer,
  patchBillingProfile,
  createInvoiceSection,
  createCustomBillingRoleDefinition,
  moveBillingSubscription,
  cancelBillingSubscription,
  validateBillingAddress,
  queryCostManagement,
} from "../../services";
import type {
  BillingProperty,
  BillingRoleAssignmentSummary,
  BillingRoleDefinition,
  EaAgreement,
  EaBillingAccount,
  EaBillingPermission,
  EaBillingPolicy,
  EaBillingProfile,
  EaBillingSubscription,
  EaDepartment,
  EaEnrollmentAccount,
  EaInvoice,
  EaInvoiceSection,
  EaTransaction,
  InboundTransfer,
  OutboundTransfer,
  ReservationOrder,
  AddressValidationResult,
  BillingAddress,
  CostQueryBody,
  CostQueryResult,
} from "../../services";
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
import { SignInRequired } from "../shared/sign-in-required";
import type { PageKey } from "../shared/sidebar-nav";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

import { useArmToken } from "../../auth/use-arm-token";
import { useBeforeUnload } from "../../hooks/use-before-unload";
import { useTenantChange } from "../../hooks/use-tenant-change";

const STORAGE_ACCOUNT = "ea-billing-manager:account";
const STORAGE_BILLING_ACCOUNT = "ea-billing-manager:billing-account";
const STORAGE_TAB = "ea-billing-manager:tab";

type TabKey =
  | "overview"
  | "permissions"
  | "roles"
  | "departments"
  | "enrollment"
  | "subscriptions"
  | "invoices"
  | "transactions"
  | "transfers"
  | "reservations"
  | "policies"
  | "customization"
  | "cost";

const TABS: { key: TabKey; label: string; icon: React.FC<{ className?: string }> }[] = [
  { key: "overview", label: "Overview", icon: Info },
  { key: "permissions", label: "Permissions", icon: Shield },
  { key: "roles", label: "Role Assignments", icon: UserCheck },
  { key: "departments", label: "Departments", icon: Layers },
  { key: "enrollment", label: "Enrollment Accounts", icon: Building2 },
  { key: "subscriptions", label: "Subscriptions", icon: Server },
  { key: "invoices", label: "Invoices", icon: Receipt },
  { key: "transactions", label: "Transactions", icon: FileText },
  { key: "transfers", label: "Transfers", icon: Copy },
  { key: "reservations", label: "Reservations", icon: Database },
  { key: "policies", label: "Policies", icon: Sliders },
  { key: "customization", label: "Customization", icon: Plus },
  { key: "cost", label: "Cost", icon: Gauge },
];

interface SourceAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  name: string;
}

// ============================================================================
// Page component
// ============================================================================

export const EaBillingManagerPage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const navigate = useNavigate();
  const azureAccounts = state.azureAccounts ?? [];

  /* ----- Account + billing account pickers ------------------------- */
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
    if (candidates.length === 0) return;
    if (!candidates.some((c) => c.homeAccountId === accountId)) {
      setAccountId(candidates[0]!.homeAccountId);
    }
  }, [candidates, accountId, setAccountId]);

  const account = React.useMemo(
    () => candidates.find((c) => c.homeAccountId === accountId) ?? null,
    [candidates, accountId],
  );

  /* ----- ARM token + EA billing accounts --------------------------- */
  const [armToken, setArmToken] = React.useState<string | null>(null);
  // Centralized ARM-token tracker: handles tenant switches + auto-
  // refresh before expiry + per-second expiry tick for the badge.
  // The legacy `armToken` state is kept for downstream tab props and
  // is kept in sync via the effect below.
  const armTokenTracker = useArmToken(
    account?.homeAccountId,
    account?.tenantId,
  );
  React.useEffect(() => {
    if (armTokenTracker.token && armTokenTracker.token !== armToken) {
      setArmToken(armTokenTracker.token);
    }
  }, [armTokenTracker.token, armToken]);
  const [billingAccounts, setBillingAccounts] = React.useState<EaBillingAccount[]>([]);
  const [baLoading, setBaLoading] = React.useState(false);
  const [baError, setBaError] = React.useState<string | null>(null);
  const [billingAccountName, setBillingAccountNameState] =
    React.useState<string>(() => {
      try {
        return sessionStorage.getItem(STORAGE_BILLING_ACCOUNT) ?? "";
      } catch {
        return "";
      }
    });
  const setBillingAccountName = React.useCallback((name: string) => {
    setBillingAccountNameState(name);
    try {
      sessionStorage.setItem(STORAGE_BILLING_ACCOUNT, name);
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

  /* ----- Tab selection (?tab= URL + sessionStorage) --------------- */
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");
  const isValidTab = (v: string | null): v is TabKey =>
    !!v && TABS.some((t) => t.key === v);
  const [tab, setTabState] = React.useState<TabKey>(() => {
    if (isValidTab(urlTab)) return urlTab;
    try {
      const stored = sessionStorage.getItem(STORAGE_TAB);
      if (isValidTab(stored)) return stored;
    } catch {
      /* ignore */
    }
    return "overview";
  });
  // Keep local state in sync if the URL changes (back/forward nav).
  // Tracks the *previous* urlTab so a programmatic `setTab` doesn't
  // re-trigger this effect with a stale value and clobber the new state.
  // Without this guard, a rapid back/forward+click sequence could race
  // the URL ↔ state sync (the local state update happens via setTab,
  // which calls setSearchParams; React batches the searchParams update
  // and this effect re-fires with the previous urlTab — overwriting
  // the new tab the user just clicked).
  React.useEffect(() => {
    if (isValidTab(urlTab) && urlTab !== tab) {
      setTabState(urlTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);
  const setTab = React.useCallback(
    (next: TabKey) => {
      // Optimistic local-state update; URL follows asynchronously. The
      // URL-sync effect above will reconcile if router state races
      // ahead with browser nav.
      setTabState(next);
      try {
        sessionStorage.setItem(STORAGE_TAB, next);
      } catch {
        /* ignore */
      }
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("tab", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /* ----- Global refresh-all token --------------------------------- */
  // Bumped when the operator clicks "Refresh all" or when the billing
  // account changes. Forwarded into each tab via `key={refreshKey}` so
  // a fresh mount tears down every cache, in-flight request, and
  // local UI state. This is a more reliable cache-buster than wiring
  // an explicit reload-all callback into 13 tabs (some of which open
  // dialogs / inline forms with their own draft state).
  const [refreshKey, setRefreshKey] = React.useState(0);
  const refreshAll = React.useCallback(() => {
    setRefreshKey((k) => k + 1);
    store.addNotification({
      type: "info",
      message: "Reloading all EA Billing Manager tabs…",
    });
  }, [store]);

  // When the operator switches billing account, also bump the refresh
  // key so every tab remounts against the new scope. Without this, a
  // tab that had already loaded data for the previous billing account
  // would briefly flash the wrong rows until its loader effect re-ran.
  React.useEffect(() => {
    if (billingAccountName) {
      setRefreshKey((k) => k + 1);
    }
  }, [billingAccountName]);

  /* ----- Global tenant-switch sync --------------------------------- */
  // When the operator switches their active tenant via the global
  // tenant switcher, sync this page's active account if the candidate
  // is in our eligible list and not already selected.
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

  /* ----- Empty / loading states ------------------------------------ */
  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="EA Billing Manager"
          description="Inspect and mutate every EA billing-account-scope endpoint exposed by Microsoft.Billing."
        />
        <SignInRequired
          whatYouCantDo="Manage EA billing"
          why="an EA-billing-capable account (enrollment owner / department admin)"
          onNavigate={(k: PageKey) => navigate(`/${k}`)}
        />
      </div>
    );
  }

  const renderHeader = () => (
    <>
      <PageHeader
        title="EA Billing Manager"
        description="Inspect and mutate every EA billing-account-scope endpoint exposed by Microsoft.Billing."
      >
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={refreshAll}
            disabled={!billingAccountName || !armToken}
            title="Reload every tab against the current billing account"
            aria-label="Refresh all tabs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh all
          </Button>
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
      </PageHeader>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Crown className="h-4 w-4 text-primary" />
            Scope
          </CardTitle>
          <CardDescription>
            Pick the signed-in account (its ARM token does every call) and
            the EA billing account you want to manage.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ea-mgr-acct" className="text-xs">
              Source account
            </Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="ea-mgr-acct">
                <SelectValue placeholder="Pick an account" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.homeAccountId} value={c.homeAccountId}>
                    <span className="flex flex-col">
                      <span className="text-sm">{c.name}</span>
                      <span className="text-2xs text-muted-foreground">
                        {c.username} · tenant{" "}
                        {(c.tenantId ?? "unknown").slice(0, 8)}…
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ea-mgr-ba" className="text-xs">
              Billing account
            </Label>
            {baLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading EA billing accounts…
              </p>
            ) : baError ? (
              <ErrorState
                size="compact"
                message="Failed to load billing accounts."
                detail={baError}
                onRetry={() => setAccountId(accountId)}
              />
            ) : billingAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No EA billing accounts visible to this signed-in account.
              </p>
            ) : (
              <Select
                value={billingAccountName}
                onValueChange={setBillingAccountName}
              >
                <SelectTrigger id="ea-mgr-ba">
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
    </>
  );

  const renderTabs = () => (
    <div
      className="flex flex-wrap gap-1 border-b border-border pb-1"
      role="tablist"
      aria-label="EA Billing Manager sections"
    >
      {TABS.map(({ key, label, icon: Icon }) => (
        <Button
          key={key}
          type="button"
          variant={tab === key ? "default" : "ghost"}
          size="sm"
          className="h-8 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          onClick={() => setTab(key)}
          role="tab"
          aria-selected={tab === key}
          aria-current={tab === key ? "page" : undefined}
          aria-label={`${label} tab`}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );

  if (!billingAccountName || !armToken) {
    return (
      <div className="flex flex-col gap-4 py-2">
        {renderHeader()}
        <EmptyState
          icon={Crown}
          title="Pick a billing account"
          description="Every tab below operates on the chosen EA billing account. Select one above to load its data."
        />
      </div>
    );
  }

  // Tab-key suffix used to force every active tab to remount on
  // "Refresh all" or a billing-account switch. Includes the billing
  // account name so per-tab in-flight loaders against the OLD account
  // can never resolve into the NEW account's view.
  const remountKey = `${billingAccountName}::${refreshKey}`;

  return (
    <div className="flex flex-col gap-4 py-2">
      {renderHeader()}
      {renderTabs()}
      {tab === "overview" && (
        <OverviewTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
          billingAccount={
            billingAccounts.find((b) => b.name === billingAccountName) ?? null
          }
          homeAccountId={account?.homeAccountId ?? ""}
          tenantId={account?.tenantId}
          onTokenRecovered={() => {
            // Bubble the fact that a passthrough-401 just got auto-
            // healed up to the operator. We don't refresh other tabs
            // pre-emptively — they'll silently auto-recover the next
            // time they hit one.
            store.addNotification({
              type: "info",
              message:
                "Re-acquired ARM token after passthrough 401 and retried.",
            });
            auditLog.record({
              actor: account?.username ?? "",
              action: "auto_recover_passthrough_token",
              target: billingAccountName,
              status: "success",
              details: {
                page: "ea-billing-manager",
                tab: "overview",
              },
            });
          }}
        />
      )}
      {tab === "permissions" && (
        <PermissionsTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
        />
      )}
      {tab === "roles" && (
        <RoleAssignmentsTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
          accountUsername={account?.username ?? ""}
          tenantId={account?.tenantId ?? ""}
          homeAccountId={account?.homeAccountId ?? ""}
          store={store}
        />
      )}
      {tab === "departments" && (
        <DepartmentsTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
        />
      )}
      {tab === "enrollment" && (
        <EnrollmentAccountsTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
        />
      )}
      {tab === "subscriptions" && (
        <SubscriptionsTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
          accountUsername={account?.username ?? ""}
          store={store}
        />
      )}
      {tab === "invoices" && (
        <InvoicesTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
        />
      )}
      {tab === "transactions" && (
        <TransactionsTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
        />
      )}
      {tab === "transfers" && (
        <TransfersTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
          accountUsername={account?.username ?? ""}
          store={store}
        />
      )}
      {tab === "reservations" && (
        <ReservationsTab key={remountKey} armToken={armToken} />
      )}
      {tab === "policies" && (
        <PoliciesTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
          accountUsername={account?.username ?? ""}
          store={store}
        />
      )}
      {tab === "customization" && (
        <CustomizationTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
          accountUsername={account?.username ?? ""}
          store={store}
        />
      )}
      {tab === "cost" && (
        <CostTab
          key={remountKey}
          armToken={armToken}
          billingAccountName={billingAccountName}
          accountUsername={account?.username ?? ""}
        />
      )}
    </div>
  );
};

// ============================================================================
// Helper hooks + components
// ============================================================================

/* ─────────────────────────────────────────────────────────────────────
 * EA / MCA billing-role metadata for the role-assignment renderer.
 *
 * Provides a per-role icon, tone, one-line permission summary, and a
 * precedence weight so the assignment list can be GROUPED by role
 * (Enterprise Admin first, read-only last) instead of dumped as a
 * flat alphabetical list. The previous flat list made it almost
 * impossible to spot "who is an Enterprise Admin" at a glance.
 *
 * Source: https://learn.microsoft.com/azure/cost-management-billing/manage/understand-ea-roles
 * ───────────────────────────────────────────────────────────────────── */
interface RoleMeta {
  icon: React.FC<{ className?: string; "aria-hidden"?: boolean }>;
  /** Maps to existing Badge `variant` values + Alert tones. */
  tone: "destructive" | "warning" | "info" | "success" | "secondary" | "outline";
  /** Plain-English summary shown in a tooltip — never trust as a UI gate. */
  summary: string;
  /** Sort weight — lower = higher in the grouped list. */
  precedence: number;
  /** Whether the role is read-only (no writes). Used for the "(read-only)" suffix. */
  readOnly?: boolean;
}

const ROLE_META: Record<string, RoleMeta> = {
  // GUIDs are lower-cased to match the keys used by EA_BILLING_ROLE_NAMES.
  "9f1983cb-2574-400c-87e9-34cf8e2280db": {
    icon: Crown,
    tone: "destructive",
    summary:
      "Enterprise Administrator — full control of the enrollment. Can grant any other EA role, view all billing data, and manage departments + account owners.",
    precedence: 0,
  },
  "0b5ed2f2-bb18-4c38-b0c4-dd75e9bd4de2": {
    icon: Eye,
    tone: "outline",
    summary:
      "Enterprise Administrator (read only) — sees everything an Enterprise Admin sees but cannot make changes.",
    precedence: 1,
    readOnly: true,
  },
  "c15c22c0-9faf-424c-9b7e-bd91c06a240b": {
    icon: ShieldCheck,
    tone: "warning",
    summary:
      "EA Account Owner — owns one or more EA accounts under the enrollment. Can create subscriptions in their accounts and view billing for their portion.",
    precedence: 2,
  },
  "a0bcee42-bf30-4d1b-926a-48d21664ef71": {
    icon: Sparkles,
    tone: "info",
    summary:
      "EA Subscription Creator — minimum role needed to create new Azure subscriptions on an enrollment account. Cannot manage billing or other principals.",
    precedence: 3,
  },
  "db609904-a47f-4794-9be8-9bd86fbffd8a": {
    icon: Building2,
    tone: "success",
    summary:
      "Department Administrator — manages account owners within a department, sees department-scoped billing, and can create departments under the enrollment.",
    precedence: 4,
  },
  "4e3a1b3b-a2df-44b5-bdfa-9d1d4e4a3cba": {
    icon: Eye,
    tone: "outline",
    summary:
      "Department Administrator (read only) — sees department-scoped billing but cannot make changes.",
    precedence: 5,
    readOnly: true,
  },
};

const UNKNOWN_ROLE_META: RoleMeta = {
  icon: Key,
  tone: "secondary",
  summary:
    "Custom or unrecognized billing role. Hover the role GUID below to see Microsoft.Billing's full role definition.",
  precedence: 99,
};

function resolveRoleMeta(roleDefinitionId: string): RoleMeta {
  const key = (roleDefinitionId ?? "").toLowerCase();
  // The roleDefinitionId from ARM is a path; extract the GUID at the end.
  const guidMatch = key.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const guid = guidMatch?.[0] ?? key;
  return ROLE_META[guid] ?? UNKNOWN_ROLE_META;
}

/**
 * Yes/no capability chip — green check when the signed-in caller holds
 * the privilege, muted X when they don't. Drives the "what can I
 * actually do here" banner at the top of the Roles tab.
 */
const CapabilityBadge: React.FC<{
  ok: boolean;
  icon: React.FC<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  detail: string;
}> = ({ ok, icon: Icon, label, detail }) => (
  <div
    className={cn(
      "flex items-center gap-1.5 rounded-md border px-2 py-1 text-2xs",
      ok
        ? "border-success/40 bg-success/5 text-foreground"
        : "border-border bg-card/40 text-muted-foreground",
    )}
    title={detail}
  >
    {ok ? (
      <Check className="h-3 w-3 text-success" aria-hidden />
    ) : (
      <AlertTriangle className="h-3 w-3 opacity-50" aria-hidden />
    )}
    <Icon className="h-3 w-3" aria-hidden />
    <span className="font-semibold">{label}</span>
    <span className="opacity-70">· {detail}</span>
  </div>
);

/**
 * Generic effect-driven async load with refresh + cancellation guard.
 * Returns the same shape used by every tab — `data`, `loading`, `error`,
 * and a `reload` function that bumps a tick to re-run the loader.
 *
 * Edge cases the loader handles for callers:
 * - If `loader()` returns `null` (caller decided not to fetch — e.g. an
 *   inverted date range), we clear stale `data` and `error` so the UI
 *   doesn't keep showing a previous tab's payload. Without this, switching
 *   from a populated tab to a "deps invalid" state leaves the old list
 *   visible, which the operator misreads as "the new filter matched".
 * - Concurrent loads from rapid tab switches are gated by a `runId` token
 *   in addition to the `cancelled` flag — a slow first request that
 *   resolves AFTER a fast second request will not overwrite the newer
 *   payload.
 */
function useAsyncLoad<T>(
  loader: () => Promise<T> | null,
  deps: React.DependencyList,
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const reload = React.useCallback(() => setTick((n) => n + 1), []);
  // Monotonic id for in-flight requests so a slow earlier load can't
  // clobber a fast later one when deps churn.
  const runIdRef = React.useRef(0);
  React.useEffect(() => {
    let cancelled = false;
    const myRunId = ++runIdRef.current;
    const p = loader();
    if (!p) {
      // Loader bowed out — wipe stale data + error so the empty state
      // renders correctly. The previous behaviour left the old data
      // visible, which masked invalid inputs (e.g. flipped date range).
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    p.then(
      (result) => {
        if (cancelled || runIdRef.current !== myRunId) return;
        setData(result);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled || runIdRef.current !== myRunId) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // The caller's deps array is the source of truth for invalidation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, loading, error, reload };
}

const TabCard: React.FC<{
  title: string;
  description?: string;
  icon: React.FC<{ className?: string }>;
  onReload?: () => void;
  reloading?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, icon: Icon, onReload, reloading, action, children }) => (
  <Card>
    <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-3">
      <div>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </div>
      <div className="flex items-center gap-1">
        {action}
        {onReload && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onReload}
            disabled={reloading}
            aria-label="Refresh"
          >
            <RefreshCw className={reloading ? "animate-spin" : undefined} />
          </Button>
        )}
      </div>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">{children}</CardContent>
  </Card>
);

// ============================================================================
// Tabs
// ============================================================================

/* ----- Overview ----------------------------------------------------- */

const OverviewTab: React.FC<{
  armToken: string;
  billingAccountName: string;
  billingAccount: EaBillingAccount | null;
  /**
   * Required for the passthrough-401 auto-recovery — if a Billing RP
   * rejects the token with "passthrough token detected", we force-
   * refresh the ARM token against this account's currently active
   * tenant and retry the call exactly once.
   */
  homeAccountId: string;
  tenantId: string | undefined;
  onTokenRecovered?: () => void;
}> = ({
  armToken,
  billingAccountName,
  billingAccount,
  homeAccountId,
  tenantId,
  onTokenRecovered,
}) => {
  const prop = useAsyncLoad<BillingProperty>(
    () =>
      withPassthroughRecovery(
        (tok) => getBillingProperty(tok),
        homeAccountId,
        tenantId,
        armToken,
        onTokenRecovered,
      ),
    [armToken, homeAccountId, tenantId],
  );
  const agreements = useAsyncLoad<EaAgreement[]>(
    () =>
      withPassthroughRecovery(
        (tok) => listEaAgreements(billingAccountName, tok),
        homeAccountId,
        tenantId,
        armToken,
        onTokenRecovered,
      ),
    [armToken, billingAccountName, homeAccountId, tenantId],
  );
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <TabCard
        title="Billing Property (caller identity)"
        description="What Microsoft.Billing thinks the signed-in account is currently associated with."
        icon={UserCheck}
        onReload={prop.reload}
        reloading={prop.loading}
      >
        {prop.loading ? (
          <SkeletonLoader variant="form" rows={3} />
        ) : prop.error ? (
          <ErrorState message="Failed to read billingProperty." detail={prop.error} size="compact" />
        ) : prop.data ? (
          <DefList
            rows={[
              ["Billing tenant", prop.data.billingTenantId],
              [
                "Billing account",
                `${prop.data.billingAccountDisplayName ?? ""} (${prop.data.billingAccountId ?? "—"})`,
              ],
              ["Is admin", prop.data.isAdmin === true ? "Yes" : prop.data.isAdmin === false ? "No" : undefined],
              [
                "Billing profile",
                prop.data.billingProfileDisplayName ?? prop.data.billingProfileId,
              ],
              [
                "Invoice section",
                prop.data.invoiceSectionDisplayName ?? prop.data.invoiceSectionId,
              ],
              [
                "Enrollment account",
                prop.data.enrollmentAccountDisplayName ?? prop.data.enrollmentAccountId,
              ],
              ["Cost center", prop.data.costCenter],
              ["Notify email", prop.data.accountAdminNotificationEmailAddress],
            ]}
          />
        ) : null}
      </TabCard>

      <TabCard
        title="Selected billing account"
        description="Raw billingAccount resource from listEaBillingAccounts."
        icon={Crown}
        action={
          <InfoTooltip
            content={
              <div className="space-y-1 text-xs leading-relaxed">
                <p><strong>EA</strong> — legacy Enterprise Agreement with departments and enrollment accounts.</p>
                <p><strong>MCA</strong> — Microsoft Customer Agreement; uses billing profiles + invoice sections.</p>
                <p>Agreement type drives which sub-resources show up below.</p>
              </div>
            }
            ariaLabel="MCA vs EA explanation"
          />
        }
      >
        {billingAccount ? (
          <DefList
            rows={[
              ["Display name", billingAccount.displayName],
              ["Name", billingAccount.name],
              ["Agreement type", billingAccount.agreementType],
              ["Status", billingAccount.accountStatus],
              ["Type", billingAccount.accountType],
            ]}
          />
        ) : (
          <p className="text-xs text-muted-foreground">No selection.</p>
        )}
      </TabCard>

      <TabCard
        title="Agreements"
        description="EA / MCA legal documents attached to this billing account."
        icon={FileText}
        onReload={agreements.reload}
        reloading={agreements.loading}
        action={
          agreements.data && agreements.data.length > 0 ? (
            <ExportMenu<EaAgreement>
              rows={agreements.data}
              columns={[
                { header: "Name", accessor: (a) => a.name },
                { header: "AgreementType", accessor: (a) => a.agreementType ?? a.category ?? "" },
                { header: "Status", accessor: (a) => a.status ?? "" },
                { header: "Effective", accessor: (a) => a.effectiveDate ?? "" },
                { header: "Expiration", accessor: (a) => a.expirationDate ?? "" },
                { header: "Id", accessor: (a) => a.id },
              ]}
              filename={`ea-agreements-${billingAccountName}`}
            />
          ) : undefined
        }
      >
        {agreements.loading ? (
          <SkeletonLoader variant="list" rows={2} />
        ) : agreements.error ? (
          <ErrorState message="Failed to load agreements." detail={agreements.error} size="compact" />
        ) : !agreements.data || agreements.data.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No agreements returned"
            description="This billing account has no EA / MCA agreements attached, or your account lacks permission to read them."
            size="compact"
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {agreements.data.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
              >
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <CopyableText value={a.name} mono />
                <Badge variant="outline" className="text-2xs">
                  {a.agreementType || a.category || "—"}
                </Badge>
                {a.status && (
                  <Badge variant="secondary" className="text-2xs">
                    {a.status}
                  </Badge>
                )}
                <span className="ml-auto text-2xs text-muted-foreground">
                  {a.effectiveDate ? `from ${a.effectiveDate.slice(0, 10)}` : ""}
                  {a.expirationDate ? ` · to ${a.expirationDate.slice(0, 10)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </TabCard>
    </div>
  );
};

const DefList: React.FC<{ rows: Array<[string, string | undefined]> }> = ({ rows }) => (
  <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
    {rows
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-all font-mono">{v}</dd>
        </React.Fragment>
      ))}
  </dl>
);

/* ----- Permissions -------------------------------------------------- */

const PermissionsTab: React.FC<{
  armToken: string;
  billingAccountName: string;
}> = ({ armToken, billingAccountName }) => {
  const perm = useAsyncLoad<EaBillingPermission[]>(
    () => listEaBillingPermissions(billingAccountName, armToken),
    [armToken, billingAccountName],
  );
  const [search, setSearch] = React.useState("");
  const merged = React.useMemo(() => {
    if (!perm.data) return null;
    const actions = new Set<string>();
    const notActions = new Set<string>();
    for (const p of perm.data) {
      p.actions.forEach((a) => actions.add(a));
      p.notActions.forEach((a) => notActions.add(a));
    }
    return {
      actions: Array.from(actions).sort(),
      notActions: Array.from(notActions).sort(),
    };
  }, [perm.data]);
  // Apply the search filter to both lists. Tokens split on whitespace
  // act as AND clauses — typing "billing read" matches any action
  // string containing BOTH substrings, in either order.
  const filtered = React.useMemo(() => {
    if (!merged) return null;
    const q = search.trim().toLowerCase();
    if (!q) return merged;
    const tokens = q.split(/\s+/);
    const match = (s: string) => {
      const lc = s.toLowerCase();
      return tokens.every((t) => lc.includes(t));
    };
    return {
      actions: merged.actions.filter(match),
      notActions: merged.notActions.filter(match),
    };
  }, [merged, search]);
  return (
    <TabCard
      title="Billing permissions"
      description="Data-plane actions the signed-in account can perform on this billing account."
      icon={Shield}
      onReload={perm.reload}
      reloading={perm.loading}
      action={
        merged ? (
          <ExportMenu<{ kind: "action" | "notAction"; value: string }>
            rows={[
              ...merged.actions.map((v) => ({ kind: "action" as const, value: v })),
              ...merged.notActions.map((v) => ({ kind: "notAction" as const, value: v })),
            ]}
            columns={[
              { header: "Kind", accessor: (r) => r.kind },
              { header: "Action", accessor: (r) => r.value },
            ]}
            filename={`ea-billing-permissions-${billingAccountName}`}
          />
        ) : undefined
      }
    >
      {merged && (
        <>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Permissions summary"
          >
            <SummaryStatItem
              label="Actions"
              value={merged.actions.length}
              compact
              tone={merged.actions.length === 0 ? "muted" : "success"}
            />
            <SummaryStatItem
              label="NotActions"
              value={merged.notActions.length}
              compact
              tone={merged.notActions.length > 0 ? "warning" : "muted"}
            />
          </div>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Search e.g. "billing read" — space-separated terms AND together'
              className="pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Filter permission actions"
            />
          </div>
        </>
      )}
      {perm.loading ? (
        <SkeletonLoader variant="list" rows={3} />
      ) : perm.error ? (
        <ErrorState message="Failed to load billingPermissions." detail={perm.error} size="compact" />
      ) : !merged || !filtered ? null : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-2xs uppercase tracking-wider text-muted-foreground">
              actions ({filtered.actions.length}
              {search && filtered.actions.length !== merged.actions.length
                ? ` / ${merged.actions.length}`
                : ""}
              )
            </span>
            {filtered.actions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {search
                  ? "No actions match this filter."
                  : "None granted."}
              </p>
            ) : (
              <ul className="font-mono text-2xs">
                {filtered.actions.map((a) => (
                  <li key={a} className="group/copy flex items-center gap-1 truncate">
                    <span className="truncate" title={a}>{a}</span>
                    <CopyButton value={a} ariaLabel={`Copy action ${a}`} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-2xs uppercase tracking-wider text-muted-foreground">
              notActions ({filtered.notActions.length}
              {search && filtered.notActions.length !== merged.notActions.length
                ? ` / ${merged.notActions.length}`
                : ""}
              )
            </span>
            {filtered.notActions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {search ? "No exclusions match this filter." : "None excluded."}
              </p>
            ) : (
              <ul className="font-mono text-2xs">
                {filtered.notActions.map((a) => (
                  <li key={a} className="group/copy flex items-center gap-1 truncate">
                    <span className="truncate" title={a}>{a}</span>
                    <CopyButton value={a} ariaLabel={`Copy notAction ${a}`} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </TabCard>
  );
};

/* ----- Role Assignments -------------------------------------------- */

const RoleAssignmentsTab: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  tenantId: string;
  /** For "Grant me" — used to acquire a Graph token to resolve UPNs. */
  homeAccountId: string;
  store: ReturnType<typeof useMultiRegionStore>;
}> = ({
  armToken,
  billingAccountName,
  accountUsername,
  tenantId,
  homeAccountId,
  store,
}) => {
  const scope = `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}`;

  const assignments = useAsyncLoad<BillingRoleAssignmentSummary[]>(
    () => listBillingRoleAssignments(scope, armToken),
    [armToken, scope],
  );
  const definitions = useAsyncLoad<BillingRoleDefinition[]>(
    () => listBillingRoleDefinitions(billingAccountName, armToken),
    [armToken, billingAccountName],
  );

  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [deleting, setDeleting] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  /**
   * Quick-filter chip: All / Owners-and-Admins / Creators / Read-only.
   * Maps to ROLE_META.tone buckets so it covers custom roles too.
   */
  type RoleFilter = "all" | "elevated" | "creators" | "readonly";
  const [roleFilter, setRoleFilter] = React.useState<RoleFilter>("all");

  /**
   * Resolved principal directory lookup. Microsoft.Billing's
   * billingRoleAssignments endpoint only returns `principalId` /
   * `principalTenantId` GUIDs — operators can't tell which row is
   * which person without translating those ids back to UPNs /
   * display names via Microsoft Graph.
   *
   * Strategy: every time the assignments list changes, batch-resolve
   * all unique principal ids via `getPrincipalsByIds` (Graph's
   * `directoryObjects/getByIds`, chunked into 100s). The resolution
   * is best-effort — failures don't block the page; rows with no
   * Graph match still show the GUID + "(no directory entry)".
   *
   * Cross-tenant grants: Graph lookups run against the *caller's*
   * tenant (`tenantId` prop). A grant whose principal lives in
   * another tenant will return "Unknown" — surfaced as such instead
   * of a hard error.
   */
  const [resolvedPrincipals, setResolvedPrincipals] = React.useState<
    Record<
      string,
      { displayName: string; signInName?: string; type: string }
    >
  >({});
  const [resolvingPrincipals, setResolvingPrincipals] = React.useState(false);
  const [resolveCount, setResolveCount] = React.useState(0);

  React.useEffect(() => {
    const list = assignments.data ?? [];
    if (list.length === 0 || !homeAccountId || !tenantId) return;
    const ids = Array.from(
      new Set(list.map((a) => a.principalId).filter((id): id is string => !!id)),
    );
    // Skip ids we've already resolved. Re-resolve on assignments
    // change only when a new principal appears.
    const unresolved = ids.filter((id) => !(id in resolvedPrincipals));
    if (unresolved.length === 0) return;
    let cancelled = false;
    setResolvingPrincipals(true);
    (async () => {
      try {
        const graphToken = await getGraphTokenForAccount(
          homeAccountId,
          tenantId,
        );
        const resolved = await getPrincipalsByIds(
          tenantId,
          unresolved,
          graphToken,
        );
        if (cancelled) return;
        setResolvedPrincipals((prev) => {
          const next = { ...prev };
          for (const r of resolved) {
            next[r.id] = {
              displayName: r.displayName,
              signInName: r.signInName,
              type: r.type,
            };
          }
          // Mark anything Graph silently dropped as "Unknown" so we
          // don't keep retrying on every effect run.
          for (const id of unresolved) {
            if (!(id in next)) {
              next[id] = { displayName: id, type: "Unknown" };
            }
          }
          return next;
        });
        setResolveCount((n) => n + resolved.length);
      } catch (err) {
        // Best-effort: a 403 on Graph (e.g. caller lacks User.Read.All)
        // shouldn't break the page. Mark the ids as Unknown so we
        // don't retry on every render.
        if (cancelled) return;
        setResolvedPrincipals((prev) => {
          const next = { ...prev };
          for (const id of unresolved) {
            if (!(id in next)) next[id] = { displayName: id, type: "Unknown" };
          }
          return next;
        });
        // eslint-disable-next-line no-console
        console.warn(
          "[ea-billing-manager] Graph principal-resolve failed:",
          err,
        );
      } finally {
        if (!cancelled) setResolvingPrincipals(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // resolvedPrincipals intentionally excluded — we use it inside
    // the effect but updating it via setResolvedPrincipals should
    // NOT re-trigger the effect (we already skip already-resolved
    // ids above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignments.data, homeAccountId, tenantId]);

  // Decode the current ARM token's claims so "Grant me" can pre-fill
  // with the calling principal's oid + tid. Best-effort — if the token
  // has no oid (passthrough / guest-no-membership case), the button is
  // disabled with a helpful tooltip.
  const callerClaims = React.useMemo(() => {
    const claims = decodeJwtClaimsUnsafe(armToken);
    if (!claims) return { oid: "", tid: "", upn: "" };
    return {
      oid: String(claims.oid ?? ""),
      tid: String(claims.tid ?? ""),
      upn: String(
        claims.upn ?? claims.preferred_username ?? claims.unique_name ?? "",
      ),
    };
  }, [armToken]);

  // Add form.
  const [addMode, setAddMode] = React.useState<"single" | "bulk">("single");
  const [addPrincipalId, setAddPrincipalId] = React.useState("");
  const [addPrincipalTenant, setAddPrincipalTenant] = React.useState(tenantId);
  const [addRoleId, setAddRoleId] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  /** Bulk-paste textarea — accepts UPNs or object ids, one per line. */
  const [bulkInput, setBulkInput] = React.useState("");
  /** Per-row bulk status. Lives at the component level so the
   *  progress survives the "Grant all" callback's life. */
  const [bulkResults, setBulkResults] = React.useState<
    Array<{
      principal: string;
      status: "pending" | "ok" | "already" | "failed";
      message?: string;
    }>
  >([]);
  /** UPN-to-oid resolver state. Triggered by the inline "Resolve" button. */
  const [resolvingUpn, setResolvingUpn] = React.useState(false);
  const [resolveError, setResolveError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setAddPrincipalTenant(tenantId);
  }, [tenantId]);
  React.useEffect(() => {
    if (
      definitions.data &&
      definitions.data.length > 0 &&
      !definitions.data.some((d) => d.name === addRoleId)
    ) {
      // Default to "EA Subscription Creator" if present, otherwise first.
      const creator = definitions.data.find(
        (d) =>
          (d.name ?? "").toLowerCase() ===
            "a0bcee42-bf30-4d1b-926a-48d21664ef71" ||
          (d.roleName ?? "").toLowerCase().includes("subscription creator"),
      );
      setAddRoleId(creator?.name ?? definitions.data[0]!.name);
    }
  }, [definitions.data, addRoleId]);

  const filtered = React.useMemo(() => {
    const list = assignments.data ?? [];
    const q = search.trim().toLowerCase();
    let result = list;
    // Quick-filter chip pre-screen.
    if (roleFilter !== "all") {
      result = result.filter((a) => {
        const meta = resolveRoleMeta(a.roleDefinitionId ?? "");
        if (roleFilter === "elevated") {
          // Enterprise Admin (destructive) + Account Owner (warning).
          return meta.tone === "destructive" || meta.tone === "warning";
        }
        if (roleFilter === "creators") {
          // Subscription Creator (info) — covers both EA Subscription Creator
          // and any custom "creator"-style role with the same tone.
          return meta.tone === "info";
        }
        if (roleFilter === "readonly") return !!meta.readOnly;
        return true;
      });
    }
    if (!q) return result;
    return result.filter((a) => {
      // Also search against the resolved directory metadata so the
      // operator can find rows by typing an email / display name
      // instead of having to know the object id.
      const resolved = resolvedPrincipals[a.principalId ?? ""];
      return [
        a.principalId,
        a.roleDefinitionName,
        a.roleDefinitionId,
        a.scope,
        a.principalTenantId,
        resolved?.displayName ?? "",
        resolved?.signInName ?? "",
        resolved?.type ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [assignments.data, search, roleFilter, resolvedPrincipals]);

  /**
   * Group the filtered assignments by role (by GUID, since the
   * roleDefinitionId path varies). Sorted by ROLE_META.precedence so
   * Enterprise Admins appear at the top of the list and read-only
   * roles at the bottom — making the page scannable at a glance.
   */
  const grouped = React.useMemo(() => {
    type Group = {
      guid: string;
      friendly: string;
      meta: RoleMeta;
      rows: BillingRoleAssignmentSummary[];
    };
    const byGuid = new Map<string, Group>();
    for (const a of filtered) {
      const meta = resolveRoleMeta(a.roleDefinitionId ?? "");
      const guidMatch = (a.roleDefinitionId ?? "")
        .toLowerCase()
        .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const guid = guidMatch?.[0] ?? "unknown";
      const friendly =
        EA_BILLING_ROLE_NAMES[guid] ?? a.roleDefinitionName ?? guid;
      const g = byGuid.get(guid) ?? {
        guid,
        friendly,
        meta,
        rows: [],
      };
      g.rows.push(a);
      byGuid.set(guid, g);
    }
    return Array.from(byGuid.values()).sort(
      (x, y) => x.meta.precedence - y.meta.precedence,
    );
  }, [filtered]);

  /**
   * Auto-detect "my roles at this scope" — every assignment whose
   * principalId matches the caller's token-oid. Drives the prominent
   * "You have these roles right now" panel at the top of the tab so
   * the operator never has to scroll/filter to answer "do I actually
   * have the role I think I do?".
   *
   * Resolution rule: lowercased oid equality. Cross-tenant grants
   * (where the caller is a guest in this enrollment's tenant) still
   * match because Azure billing matches on the principal's *object
   * id* in the EA tenant, which is exactly what the token's `oid`
   * carries.
   */
  const myRoles = React.useMemo(() => {
    if (!callerClaims.oid) return [];
    const list = assignments.data ?? [];
    const myOid = callerClaims.oid.toLowerCase();
    return list
      .filter((a) => (a.principalId ?? "").toLowerCase() === myOid)
      .map((a) => ({
        assignment: a,
        meta: resolveRoleMeta(a.roleDefinitionId ?? ""),
        friendly:
          EA_BILLING_ROLE_NAMES[
            (
              (a.roleDefinitionId ?? "").match(
                /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
              )?.[0] ?? ""
            ).toLowerCase()
          ] ??
          a.roleDefinitionName ??
          "Unknown role",
      }))
      .sort((x, y) => x.meta.precedence - y.meta.precedence);
  }, [assignments.data, callerClaims.oid]);

  /**
   * Whether the calling principal can definitely create EA
   * subscriptions on this billing account — derived from the
   * auto-detected myRoles set. Used both for the prominent capability
   * banner AND to gate the "Grant me Subscription Creator" CTA
   * (which would no-op if the role is already there).
   */
  const myCapabilities = React.useMemo(() => {
    const guidsHeld = new Set<string>();
    for (const r of myRoles) {
      const g = (r.assignment.roleDefinitionId ?? "")
        .toLowerCase()
        .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      if (g?.[0]) guidsHeld.add(g[0]);
    }
    const has = (guid: string) => guidsHeld.has(guid.toLowerCase());
    return {
      anyRole: myRoles.length > 0,
      isEnterpriseAdmin:
        has("9f1983cb-2574-400c-87e9-34cf8e2280db") ||
        has("0b5ed2f2-bb18-4c38-b0c4-dd75e9bd4de2"),
      isAccountOwner: has("c15c22c0-9faf-424c-9b7e-bd91c06a240b"),
      canCreateSubscriptions:
        has("9f1983cb-2574-400c-87e9-34cf8e2280db") ||
        has("c15c22c0-9faf-424c-9b7e-bd91c06a240b") ||
        has("a0bcee42-bf30-4d1b-926a-48d21664ef71"),
      isDepartmentAdmin:
        has("db609904-a47f-4794-9be8-9bd86fbffd8a") ||
        has("4e3a1b3b-a2df-44b5-bdfa-9d1d4e4a3cba"),
    };
  }, [myRoles]);

  /**
   * Per-role-tone summary counts for the chip strip — derived from
   * the full assignment set (not the filtered set) so chip counts
   * remain stable as the search box changes.
   */
  const roleCounts = React.useMemo(() => {
    const list = assignments.data ?? [];
    let elevated = 0;
    let creators = 0;
    let readonly = 0;
    for (const a of list) {
      const meta = resolveRoleMeta(a.roleDefinitionId ?? "");
      if (meta.tone === "destructive" || meta.tone === "warning") elevated++;
      else if (meta.tone === "info") creators++;
      else if (meta.readOnly) readonly++;
    }
    return { total: list.length, elevated, creators, readonly };
  }, [assignments.data]);

  /**
   * "Grant me" — pre-fill the Add form with the calling principal's
   * oid + tid and the currently-selected role. The operator still
   * has to hit the Grant button — this just spares them copy-pasting
   * their own object id from the JWT diagnostic.
   */
  const grantMe = React.useCallback(() => {
    if (!callerClaims.oid) return;
    setAddMode("single");
    setAddPrincipalId(callerClaims.oid);
    setAddPrincipalTenant(callerClaims.tid || tenantId);
    setAddError(null);
    store.addNotification({
      type: "info",
      message:
        "Pre-filled with your own object id. Click Grant role to apply.",
    });
  }, [callerClaims, store, tenantId]);

  /**
   * If the principal input looks like a UPN/email rather than a UUID,
   * resolve it to an object id via Graph. Tolerant of @ in the input;
   * falls back to plain text on lookup failure (which makes the Grant
   * button surface a useful AAD error rather than a silent failure).
   */
  const resolveUpn = React.useCallback(async () => {
    const raw = addPrincipalId.trim();
    if (!raw || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw)) return; // already a UUID
    setResolvingUpn(true);
    setResolveError(null);
    try {
      const graphToken = await getGraphTokenForAccount(homeAccountId, tenantId);
      const user = await findUserByUpnOrMail(tenantId, raw, graphToken);
      if (!user || !user.id) {
        setResolveError(
          `Microsoft Graph couldn't find a user matching "${raw}" in tenant ${tenantId.slice(0, 8)}…. Either they don't exist yet (invite as a guest first) or you lack User.Read.All.`,
        );
        return;
      }
      setAddPrincipalId(user.id);
      store.addNotification({
        type: "success",
        message: `Resolved ${raw} → ${user.id}`,
      });
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingUpn(false);
    }
  }, [addPrincipalId, homeAccountId, tenantId, store]);

  /**
   * Bulk grant — accepts a list of UPNs / object ids (one per line),
   * resolves UPNs via Graph if needed, and grants the selected role
   * to each in sequence. Each row's status is surfaced in
   * `bulkResults` so the operator sees per-principal outcomes.
   *
   * 409/"already exists" is treated as idempotent success so a re-run
   * after a partial failure doesn't accumulate noise.
   */
  const submitBulk = React.useCallback(async () => {
    if (!addRoleId) return;
    const lines = bulkInput
      .split(/[\r\n,;]+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    setAdding(true);
    setAddError(null);
    setBulkResults(lines.map((p) => ({ principal: p, status: "pending" })));

    // Pre-acquire a Graph token once if any line is a UPN.
    const hasUpns = lines.some((l) => l.includes("@"));
    let graphToken: string | null = null;
    if (hasUpns) {
      try {
        graphToken = await getGraphTokenForAccount(homeAccountId, tenantId);
      } catch {
        graphToken = null; // surface per-row "couldn't resolve UPN" failures
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      let principal = raw;
      if (raw.includes("@") && graphToken) {
        try {
          const u = await findUserByUpnOrMail(tenantId, raw, graphToken);
          if (u?.id) principal = u.id;
          else throw new Error(`Graph: no user found for ${raw}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setBulkResults((prev) => {
            const next = [...prev];
            next[i] = { principal: raw, status: "failed", message: msg };
            return next;
          });
          continue;
        }
      }
      try {
        const r = await createBillingRoleAssignment(
          billingAccountName,
          principal,
          tenantId,
          addRoleId,
          armToken,
        );
        auditLog.record({
          actor: accountUsername,
          action: "create_billing_role_assignment",
          target: r.principalId,
          status: "success",
          details: {
            scope,
            roleDefinitionId: r.roleDefinitionId,
            roleDefinitionName: r.roleDefinitionName,
            stage: "bulk",
          },
        });
        setBulkResults((prev) => {
          const next = [...prev];
          next[i] = { principal: raw, status: "ok" };
          return next;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/(^|\W)(409|conflict|already\s*exists)(\W|$)/i.test(msg)) {
          setBulkResults((prev) => {
            const next = [...prev];
            next[i] = { principal: raw, status: "already" };
            return next;
          });
          auditLog.record({
            actor: accountUsername,
            action: "create_billing_role_assignment",
            target: principal,
            status: "success",
            details: {
              scope,
              roleDefinitionName: addRoleId,
              stage: "bulk",
              note: "already_exists_409",
            },
          });
        } else {
          setBulkResults((prev) => {
            const next = [...prev];
            next[i] = { principal: raw, status: "failed", message: msg };
            return next;
          });
          auditLog.record({
            actor: accountUsername,
            action: "create_billing_role_assignment",
            target: principal,
            status: "failure",
            error: msg,
            details: {
              scope,
              roleDefinitionName: addRoleId,
              stage: "bulk",
            },
          });
        }
      }
    }
    setAdding(false);
    assignments.reload();
  }, [
    bulkInput,
    addRoleId,
    armToken,
    billingAccountName,
    accountUsername,
    homeAccountId,
    tenantId,
    scope,
    assignments,
  ]);

  const toggle = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const performDelete = React.useCallback(async () => {
    if (selected.size === 0) return;
    setConfirmDelete(false);
    setDeleting(true);
    let ok = 0;
    let fail = 0;
    let alreadyGone = 0;
    for (const id of Array.from(selected)) {
      try {
        await deleteBillingRoleAssignment(id, armToken);
        ok += 1;
        auditLog.record({
          actor: accountUsername,
          action: "delete_billing_role_assignment",
          target: id,
          status: "success",
          details: { scope },
        });
      } catch (err) {
        // Idempotent: 404 means it's already gone — count as success.
        const msg = err instanceof Error ? err.message : String(err);
        if (/(^|\W)(404|not\s*found)(\W|$)/i.test(msg)) {
          alreadyGone += 1;
          auditLog.record({
            actor: accountUsername,
            action: "delete_billing_role_assignment",
            target: id,
            status: "success",
            details: { scope, note: "already_absent_404" },
          });
        } else {
          fail += 1;
          auditLog.record({
            actor: accountUsername,
            action: "delete_billing_role_assignment",
            target: id,
            status: "failure",
            error: msg,
            details: { scope },
          });
        }
      }
    }
    setDeleting(false);
    setSelected(new Set());
    const totalOk = ok + alreadyGone;
    store.addNotification({
      type: fail > 0 ? (totalOk > 0 ? "warning" : "error") : "success",
      message: `Deleted ${totalOk}${alreadyGone > 0 ? ` (${alreadyGone} already absent)` : ""}${fail > 0 ? ` · ${fail} failed` : ""}.`,
    });
    assignments.reload();
  }, [selected, armToken, scope, accountUsername, store, assignments]);

  const submitAdd = React.useCallback(async () => {
    if (!addPrincipalId.trim() || !addRoleId) return;
    setAdding(true);
    setAddError(null);
    const principal = addPrincipalId.trim();
    const tenant = addPrincipalTenant.trim() || tenantId;
    try {
      const r = await createBillingRoleAssignment(
        billingAccountName,
        principal,
        tenant,
        addRoleId,
        armToken,
      );
      auditLog.record({
        actor: accountUsername,
        action: "create_billing_role_assignment",
        target: r.principalId,
        status: "success",
        details: {
          scope,
          roleDefinitionId: r.roleDefinitionId,
          roleDefinitionName: r.roleDefinitionName,
        },
      });
      store.addNotification({
        type: "success",
        message: `Granted ${r.roleDefinitionName} to ${r.principalId}.`,
      });
      setAddPrincipalId("");
      assignments.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Idempotent: 409 means an equivalent grant already exists. If we can
      // confirm via the current list that the same principal+role at this
      // scope is present, silently treat the call as a no-op.
      const isConflict = /(^|\W)(409|conflict|already\s*exists)(\W|$)/i.test(msg);
      const existing = (assignments.data ?? []).find(
        (a) =>
          (a.principalId ?? "").toLowerCase() === principal.toLowerCase() &&
          (a.roleDefinitionId ?? "")
            .toLowerCase()
            .endsWith(addRoleId.toLowerCase()) &&
          a.scope === scope,
      );
      if (isConflict && existing) {
        auditLog.record({
          actor: accountUsername,
          action: "create_billing_role_assignment",
          target: principal,
          status: "success",
          details: {
            scope,
            roleDefinitionId: existing.roleDefinitionId,
            roleDefinitionName: existing.roleDefinitionName,
            note: "already_exists_409",
          },
        });
        store.addNotification({
          type: "info",
          message: `Role already granted to ${principal}. No change.`,
        });
        setAddPrincipalId("");
      } else {
        setAddError(msg);
        auditLog.record({
          actor: accountUsername,
          action: "create_billing_role_assignment",
          target: principal,
          status: "failure",
          error: msg,
          details: { scope, roleDefinitionName: addRoleId },
        });
      }
    } finally {
      setAdding(false);
    }
  }, [
    addPrincipalId,
    addPrincipalTenant,
    addRoleId,
    armToken,
    billingAccountName,
    tenantId,
    accountUsername,
    scope,
    store,
    assignments,
  ]);

  return (
    <div className="flex flex-col gap-3">
      {/* ─────────────────────────────────────────────────────────────
        * Auto-detected "My roles at this billing scope".
        *
        * This card is the answer to "do I have the role I think I
        * have?" — derived from the live `assignments.data` filtered
        * by the calling principal's oid. Always sits at the top of
        * the tab so the operator never has to filter or scroll to
        * confirm their own capability.
        * ───────────────────────────────────────────────────────── */}
      <TabCard
        title="My roles at this billing scope"
        description="Auto-detected from billingRoleAssignments. Matches the calling principal by oid claim from the current ARM token."
        icon={UserCheck}
        onReload={assignments.reload}
        reloading={assignments.loading}
      >
        {!callerClaims.oid ? (
          <Alert variant="warning" className="text-xs">
            <AlertTriangle className="h-3.5 w-3.5" />
            <AlertDescription>
              <strong>
                Your ARM token has no <code className="font-mono">oid</code>{" "}
                claim
              </strong>{" "}
              — we can't auto-detect your roles. This usually means the
              token was issued against a tenant where you aren't a
              member. Switch the tenant for this account on{" "}
              <strong>Azure Accounts</strong> back to your home tenant,
              then come back here.
            </AlertDescription>
          </Alert>
        ) : assignments.loading ? (
          <SkeletonLoader variant="list" rows={2} />
        ) : assignments.error ? (
          <ErrorState
            message="Couldn't determine your roles."
            detail={assignments.error}
            size="compact"
            onRetry={assignments.reload}
          />
        ) : myRoles.length === 0 ? (
          <Alert variant="warning" className="text-xs">
            <AlertTriangle className="h-3.5 w-3.5" />
            <AlertDescription className="flex flex-col gap-2">
              <span>
                <strong>No billing roles found</strong> for{" "}
                <code className="font-mono">
                  {callerClaims.upn || callerClaims.oid.slice(0, 8) + "…"}
                </code>{" "}
                at billing account{" "}
                <code className="font-mono">{billingAccountName}</code>.
              </span>
              <span className="text-2xs">
                If you're sure you have a role, the assignment may
                exist at a different scope (department, enrollment
                account, billing profile) — check the Departments /
                Enrollment tabs. Otherwise use{" "}
                <strong>Grant me Subscription Creator</strong> below
                if you can self-grant.
              </span>
              {/* Inline self-grant shortcut — pre-fills then submits.
                  Only enabled when role definitions have loaded so
                  we know the EA Sub Creator GUID is valid here. */}
              {definitions.data &&
                definitions.data.some(
                  (d) =>
                    (d.name ?? "").toLowerCase() ===
                    "a0bcee42-bf30-4d1b-926a-48d21664ef71",
                ) && (
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      className="h-7 text-2xs"
                      onClick={() => {
                        setAddMode("single");
                        setAddPrincipalId(callerClaims.oid);
                        setAddPrincipalTenant(callerClaims.tid || tenantId);
                        setAddRoleId(
                          "a0bcee42-bf30-4d1b-926a-48d21664ef71",
                        );
                        store.addNotification({
                          type: "info",
                          message:
                            "Pre-filled with your oid + Subscription Creator role. Click Grant role below.",
                        });
                      }}
                    >
                      <Sparkles className="h-3 w-3" />
                      Pre-fill Grant me Subscription Creator
                    </Button>
                  </div>
                )}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Capability summary banner — the high-level "yes you
                CAN do this" / "no you can't" answer per common task. */}
            <div className="flex flex-wrap gap-2">
              <CapabilityBadge
                ok={myCapabilities.isEnterpriseAdmin}
                icon={Crown}
                label="Enterprise Admin"
                detail={
                  myCapabilities.isEnterpriseAdmin
                    ? "Full enrollment control"
                    : "Not granted"
                }
              />
              <CapabilityBadge
                ok={myCapabilities.canCreateSubscriptions}
                icon={Sparkles}
                label="Can create subs"
                detail={
                  myCapabilities.canCreateSubscriptions
                    ? "via EA / Account Owner / Sub Creator"
                    : "Need EA Subscription Creator"
                }
              />
              <CapabilityBadge
                ok={myCapabilities.isAccountOwner}
                icon={ShieldCheck}
                label="Account Owner"
                detail={
                  myCapabilities.isAccountOwner
                    ? "Owns at least one EA account"
                    : "Not granted"
                }
              />
              <CapabilityBadge
                ok={myCapabilities.isDepartmentAdmin}
                icon={Building2}
                label="Department Admin"
                detail={
                  myCapabilities.isDepartmentAdmin
                    ? "Manages a department"
                    : "Not granted"
                }
              />
            </div>
            {/* Per-role detail list — one row per assignment. */}
            <ul className="flex flex-col gap-1">
              {myRoles.map((r) => {
                const Icon = r.meta.icon;
                return (
                  <li
                    key={r.assignment.id}
                    className={cn(
                      "flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
                      r.meta.tone === "destructive" &&
                        "border-destructive/40 bg-destructive/5",
                      r.meta.tone === "warning" &&
                        "border-warning/40 bg-warning/5",
                      r.meta.tone === "info" && "border-info/40 bg-info/5",
                      r.meta.tone === "success" &&
                        "border-success/40 bg-success/5",
                      (r.meta.tone === "outline" ||
                        r.meta.tone === "secondary") &&
                        "border-border bg-card/40",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    <span className="font-semibold">{r.friendly}</span>
                    {r.meta.readOnly && (
                      <Badge
                        variant="outline"
                        className="px-1 py-0 text-[9px]"
                      >
                        read only
                      </Badge>
                    )}
                    <InfoTooltip content={r.meta.summary} />
                    <span className="ml-auto text-2xs text-muted-foreground">
                      {r.assignment.createdOn
                        ? `since ${r.assignment.createdOn.slice(0, 10)}`
                        : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="text-2xs text-muted-foreground">
              Signed in as{" "}
              <code className="font-mono">
                {resolvedPrincipals[callerClaims.oid]?.signInName ||
                  resolvedPrincipals[callerClaims.oid]?.displayName ||
                  callerClaims.upn ||
                  callerClaims.oid.slice(0, 8) + "…"}
              </code>{" "}
              · token tenant{" "}
              <code className="font-mono">
                {callerClaims.tid.slice(0, 8)}…
              </code>
              {callerClaims.tid.toLowerCase() !== tenantId.toLowerCase() && (
                <Badge
                  variant="warning"
                  className="ml-1.5 px-1.5 py-0 text-[9px]"
                >
                  cross-tenant
                </Badge>
              )}
            </div>
          </div>
        )}
      </TabCard>

      <TabCard
        title="Add billing role assignment"
        description="Grant a billing role at this billing-account scope. Single or bulk; resolves UPN/email to object id via Microsoft Graph."
        icon={UserPlus}
      >
        {/* Single / Bulk mode toggle */}
        <div
          role="radiogroup"
          aria-label="Grant mode"
          className="inline-flex overflow-hidden rounded-md border border-border text-xs"
        >
          <button
            type="button"
            role="radio"
            aria-checked={addMode === "single"}
            onClick={() => setAddMode("single")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              addMode === "single"
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-muted/40",
            )}
          >
            <UserPlus className="h-3.5 w-3.5" aria-hidden />
            Single principal
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={addMode === "bulk"}
            onClick={() => setAddMode("bulk")}
            className={cn(
              "flex items-center gap-1.5 border-l border-border px-3 py-1.5 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              addMode === "bulk"
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-muted/40",
            )}
          >
            <Users className="h-3.5 w-3.5" aria-hidden />
            Bulk paste
          </button>
        </div>

        {addMode === "single" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label className="flex items-center gap-1.5 text-xs">
                Principal object id (or UPN / email)
                <InfoTooltip content="Paste a GUID or a user@domain.com — Graph resolves UPNs to their object id when you click Resolve." />
              </Label>
              <div className="flex gap-2">
                <Input
                  value={addPrincipalId}
                  onChange={(e) => {
                    setAddPrincipalId(e.target.value);
                    setAddError(null);
                    setResolveError(null);
                  }}
                  placeholder="11111111-2222-… or user@contoso.com"
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void resolveUpn()}
                  loading={resolvingUpn}
                  disabled={
                    resolvingUpn ||
                    !addPrincipalId.includes("@") ||
                    !homeAccountId
                  }
                  aria-label="Resolve UPN or email to object id via Microsoft Graph"
                  title={
                    !addPrincipalId.includes("@")
                      ? "Only resolves UPN / email — already looks like a GUID."
                      : "Resolve UPN → object id"
                  }
                  className="h-9 shrink-0"
                >
                  {!resolvingUpn && <Wand2 className="h-3.5 w-3.5" />}
                  Resolve
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={grantMe}
                  disabled={!callerClaims.oid}
                  aria-label={
                    callerClaims.oid
                      ? "Pre-fill with my own object id"
                      : "Token has no oid claim — cannot pre-fill"
                  }
                  title={
                    callerClaims.oid
                      ? `Pre-fill ${callerClaims.upn || "myself"} (${callerClaims.oid.slice(0, 8)}…)`
                      : "ARM token has no oid claim — fix tenant context first."
                  }
                  className="h-9 shrink-0"
                >
                  <UserCheck className="h-3.5 w-3.5" />
                  Grant me
                </Button>
              </div>
              {resolveError && (
                <Alert variant="warning" className="text-2xs">
                  <AlertTriangle className="h-3 w-3" />
                  <AlertDescription>{resolveError}</AlertDescription>
                </Alert>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Principal tenant id</Label>
              <Input
                value={addPrincipalTenant}
                onChange={(e) => setAddPrincipalTenant(e.target.value)}
                placeholder="tenant guid"
                className="font-mono text-xs"
              />
              {(addPrincipalTenant ?? "").toLowerCase() !==
                tenantId.toLowerCase() &&
                addPrincipalTenant.trim().length > 0 && (
                  <span className="flex items-center gap-1 text-2xs text-warning">
                    <Network className="h-3 w-3" />
                    Cross-tenant grant — confirm this is what you want.
                  </span>
                )}
            </div>
            <div className="sm:col-span-3">
              <Label className="flex items-center gap-1.5 text-xs">
                Role
                <InfoTooltip content="Hover each role in the list below to see what it can do. Enterprise Administrator is the highest privilege — grant sparingly." />
              </Label>
              <Select value={addRoleId} onValueChange={setAddRoleId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick role" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {(definitions.data ?? []).map((d) => {
                    const meta = resolveRoleMeta(d.name ?? "");
                    const Icon = meta.icon;
                    return (
                      <SelectItem key={d.name} value={d.name}>
                        <span className="flex items-center gap-2">
                          <Icon className="h-3.5 w-3.5" aria-hidden />
                          <span className="flex flex-col">
                            <span className="text-sm">
                              {d.roleName}
                              {meta.readOnly && (
                                <span className="ml-1 text-2xs text-muted-foreground">
                                  (read only)
                                </span>
                              )}
                            </span>
                            <span className="text-2xs text-muted-foreground">
                              {(d.name ?? "").slice(0, 8)}…
                            </span>
                          </span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="flex items-center gap-1.5 text-xs">
                Principals (one per line)
                <InfoTooltip content="Paste any mix of object ids (GUIDs) and UPN/email — UPNs are resolved via Graph on submit. Lines separated by newline, comma, or semicolon." />
              </Label>
              <textarea
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value)}
                placeholder={
                  "alice@contoso.com\n11111111-2222-3333-4444-555555555555\nbob@contoso.com"
                }
                rows={4}
                className={cn(
                  "rounded-md border border-input bg-background px-3 py-2 font-mono text-xs",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                aria-label="Bulk principals input"
              />
              <span className="text-2xs text-muted-foreground">
                {
                  bulkInput
                    .split(/[\r\n,;]+/)
                    .map((l) => l.trim())
                    .filter(Boolean).length
                }{" "}
                principal(s) ·{" "}
                {bulkInput.split(/[\r\n,;]+/).filter((l) => l.includes("@"))
                  .length}{" "}
                UPN(s) need resolution
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Role</Label>
              <Select value={addRoleId} onValueChange={setAddRoleId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick role" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {(definitions.data ?? []).map((d) => {
                    const meta = resolveRoleMeta(d.name ?? "");
                    const Icon = meta.icon;
                    return (
                      <SelectItem key={d.name} value={d.name}>
                        <span className="flex items-center gap-2">
                          <Icon className="h-3.5 w-3.5" aria-hidden />
                          <span className="text-sm">{d.roleName}</span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            {bulkResults.length > 0 && (
              <div className="rounded-md border border-border bg-card/40 p-2">
                <div className="flex items-center gap-2 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Layers className="h-3 w-3" aria-hidden />
                  Bulk results
                  <span className="ml-auto text-2xs font-normal text-muted-foreground">
                    {bulkResults.filter((r) => r.status === "ok").length} ok ·{" "}
                    {bulkResults.filter((r) => r.status === "already").length} already ·{" "}
                    {bulkResults.filter((r) => r.status === "failed").length} failed
                  </span>
                </div>
                <ul className="flex flex-col gap-0.5 text-2xs">
                  {bulkResults.map((r, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      {r.status === "ok" && (
                        <Check className="mt-0.5 h-3 w-3 text-success" aria-hidden />
                      )}
                      {r.status === "already" && (
                        <Check className="mt-0.5 h-3 w-3 text-info" aria-hidden />
                      )}
                      {r.status === "failed" && (
                        <AlertTriangle className="mt-0.5 h-3 w-3 text-destructive" aria-hidden />
                      )}
                      {r.status === "pending" && (
                        <Loader2 className="mt-0.5 h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
                      )}
                      <code className="font-mono">{r.principal}</code>
                      {r.message && (
                        <span className="min-w-0 break-words text-destructive">
                          {r.message}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {addError && (
          <Alert variant="destructive">
            <AlertDescription>{addError}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button
            type="button"
            onClick={() =>
              addMode === "single" ? void submitAdd() : void submitBulk()
            }
            disabled={
              adding ||
              !addRoleId ||
              (addMode === "single"
                ? !addPrincipalId.trim()
                : bulkInput.trim().length === 0)
            }
            loading={adding}
          >
            {!adding && <Plus />}
            {addMode === "single"
              ? "Grant role"
              : `Grant role to ${
                  bulkInput
                    .split(/[\r\n,;]+/)
                    .map((l) => l.trim())
                    .filter(Boolean).length
                } principals`}
          </Button>
        </div>
      </TabCard>

      <TabCard
        title="Existing billing role assignments"
        description="Every assignment at this billing-account scope. Use the checkboxes for bulk delete."
        icon={UserCheck}
        onReload={assignments.reload}
        reloading={assignments.loading}
        action={
          <div className="flex items-center gap-1">
            <ExportMenu<BillingRoleAssignmentSummary>
              rows={filtered}
              columns={[
                {
                  header: "DisplayName",
                  accessor: (a) =>
                    resolvedPrincipals[a.principalId ?? ""]?.displayName ?? "",
                },
                {
                  header: "SignInName",
                  accessor: (a) =>
                    resolvedPrincipals[a.principalId ?? ""]?.signInName ?? "",
                },
                {
                  header: "PrincipalType",
                  accessor: (a) =>
                    resolvedPrincipals[a.principalId ?? ""]?.type ?? "",
                },
                { header: "PrincipalId", accessor: (a) => a.principalId },
                { header: "PrincipalTenantId", accessor: (a) => a.principalTenantId },
                { header: "RoleDefinitionId", accessor: (a) => a.roleDefinitionId },
                { header: "RoleDefinitionName", accessor: (a) => a.roleDefinitionName },
                { header: "Scope", accessor: (a) => a.scope },
                { header: "Id", accessor: (a) => a.id },
                {
                  header: "CreatedOn",
                  accessor: (a) => a.createdOn ?? "",
                },
              ]}
              filename={`billing-role-assignments-${billingAccountName}`}
            />
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-7 text-xs focus-visible:ring-2 focus-visible:ring-ring"
              disabled={selected.size === 0 || deleting}
              onClick={() => setConfirmDelete(true)}
              aria-label={`Delete ${selected.size} selected role assignments`}
            >
              <Trash2 className="h-3 w-3" />
              Delete{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          </div>
        }
      >
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Role assignment summary"
        >
          <SummaryStatItem
            label="Total"
            value={assignments.data?.length ?? 0}
            compact
          />
          <SummaryStatItem
            label="Selected"
            value={selected.size}
            compact
            tone={selected.size > 0 ? "info" : undefined}
          />
          <SummaryStatItem
            label="Cross-tenant"
            value={
              (assignments.data ?? []).filter(
                (a) =>
                  (a.principalTenantId ?? "").toLowerCase() !==
                  tenantId.toLowerCase(),
              ).length
            }
            compact
            tone="warning"
          />
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by email, name, principal id, role, tenant…"
            className="pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Filter role assignments"
          />
          {(resolvingPrincipals || resolveCount > 0) && (
            <span className="mt-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
              {resolvingPrincipals ? (
                <>
                  <Loader2
                    className="h-3 w-3 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                  <span>Resolving principal names via Graph…</span>
                </>
              ) : (
                <>
                  <Check
                    className="h-3 w-3 text-success"
                    aria-hidden
                  />
                  <span>
                    Resolved {resolveCount} principal
                    {resolveCount === 1 ? "" : "s"} to display name / UPN.
                  </span>
                </>
              )}
            </span>
          )}
        </div>
        {/* Role-category quick-filter chips */}
        <div
          className="flex flex-wrap gap-1.5"
          role="radiogroup"
          aria-label="Filter by role category"
        >
          {(
            [
              { key: "all", label: "All", count: roleCounts.total, icon: Layers },
              {
                key: "elevated",
                label: "Owners / Admins",
                count: roleCounts.elevated,
                icon: Crown,
              },
              {
                key: "creators",
                label: "Sub Creators",
                count: roleCounts.creators,
                icon: Sparkles,
              },
              {
                key: "readonly",
                label: "Read-only",
                count: roleCounts.readonly,
                icon: Eye,
              },
            ] as const
          ).map((chip) => {
            const Icon = chip.icon;
            const active = roleFilter === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setRoleFilter(chip.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/40",
                )}
              >
                <Icon className="h-3 w-3" aria-hidden />
                <span>{chip.label}</span>
                <Badge
                  variant={active ? "secondary" : "outline"}
                  className="ml-0.5 h-4 text-[9px]"
                >
                  {chip.count}
                </Badge>
              </button>
            );
          })}
        </div>

        {assignments.loading ? (
          <SkeletonLoader variant="list" rows={4} />
        ) : assignments.error ? (
          <ErrorState
            message="Failed to load billingRoleAssignments."
            detail={assignments.error}
            size="compact"
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={UserCheck}
            title={
              search || roleFilter !== "all"
                ? "No matching assignments"
                : "No assignments"
            }
            description={
              search || roleFilter !== "all"
                ? "Adjust your filter to see results."
                : "No principals have been granted any billing role on this account."
            }
            size="compact"
          />
        ) : (
          // GROUPED list — one section per role, sorted by privilege
          // precedence (Enterprise Admin → ... → Read-only).
          <div className="flex flex-col gap-3">
            {grouped.map((group) => {
              const Icon = group.meta.icon;
              return (
                <div
                  key={group.guid}
                  className="rounded-md border border-border bg-card/40"
                >
                  <div
                    className={cn(
                      "flex flex-wrap items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-2xs font-semibold uppercase tracking-wide",
                      group.meta.tone === "destructive" &&
                        "text-destructive",
                      group.meta.tone === "warning" && "text-warning",
                      group.meta.tone === "info" && "text-info",
                      group.meta.tone === "success" && "text-success",
                      (group.meta.tone === "outline" ||
                        group.meta.tone === "secondary") &&
                        "text-muted-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    <span>{group.friendly}</span>
                    {group.meta.readOnly && (
                      <span className="text-2xs font-normal opacity-70">
                        (read only)
                      </span>
                    )}
                    <InfoTooltip content={group.meta.summary} />
                    <Badge variant="outline" className="text-2xs">
                      {group.rows.length}
                    </Badge>
                    <span className="ml-auto font-mono text-[10px] font-normal opacity-60">
                      {group.guid.slice(0, 8)}…
                    </span>
                  </div>
                  <ul className="flex flex-col">
                    {group.rows.map((a) => {
                      const isCrossTenant =
                        !!a.principalTenantId &&
                        a.principalTenantId.toLowerCase() !==
                          tenantId.toLowerCase();
                      const isSelf =
                        !!callerClaims.oid &&
                        (a.principalId ?? "").toLowerCase() ===
                          callerClaims.oid.toLowerCase();
                      const resolved =
                        resolvedPrincipals[a.principalId ?? ""];
                      const isUnknown =
                        !resolved || resolved.type === "Unknown";
                      // Prefer signInName (UPN/email) as the headline,
                      // displayName as the subtitle. For non-user
                      // principals (Group, SP), show displayName + type.
                      const headline =
                        resolved?.signInName ||
                        resolved?.displayName ||
                        (isCrossTenant
                          ? "(external — not in this tenant)"
                          : "(no directory entry)");
                      const subtitle =
                        resolved?.signInName && resolved.displayName !== resolved.signInName
                          ? resolved.displayName
                          : "";
                      return (
                        <li
                          key={a.id}
                          className={cn(
                            "flex flex-wrap items-center gap-2 border-b border-border/40 px-2.5 py-1.5 text-xs last:border-b-0",
                            isSelf && "bg-info/5",
                          )}
                        >
                          <Checkbox
                            aria-label={`Select ${a.principalId}`}
                            checked={selected.has(a.id)}
                            onCheckedChange={() => toggle(a.id)}
                            disabled={deleting}
                          />
                          {resolved?.type === "Group" ? (
                            <Users
                              className="h-3.5 w-3.5 text-muted-foreground"
                              aria-hidden
                            />
                          ) : resolved?.type === "ServicePrincipal" ||
                            resolved?.type === "Application" ? (
                            <Sliders
                              className="h-3.5 w-3.5 text-muted-foreground"
                              aria-hidden
                            />
                          ) : (
                            <Key
                              className="h-3.5 w-3.5 text-muted-foreground"
                              aria-hidden
                            />
                          )}
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span
                              className={cn(
                                "flex items-center gap-1.5 truncate text-xs",
                                isUnknown
                                  ? "italic text-muted-foreground"
                                  : "font-medium text-foreground",
                              )}
                            >
                              <span className="truncate">{headline}</span>
                              {resolved?.type &&
                                resolved.type !== "User" &&
                                resolved.type !== "Unknown" && (
                                  <Badge
                                    variant="outline"
                                    className="px-1 py-0 text-[9px]"
                                  >
                                    {resolved.type}
                                  </Badge>
                                )}
                            </span>
                            <span className="flex items-center gap-1.5 truncate text-2xs text-muted-foreground">
                              {subtitle && (
                                <span className="truncate">{subtitle}</span>
                              )}
                              <CopyableText value={a.principalId ?? ""} mono />
                            </span>
                          </div>
                          {isSelf && (
                            <Badge
                              variant="info"
                              className="px-1.5 py-0 text-[9px]"
                            >
                              You
                            </Badge>
                          )}
                          {isCrossTenant && (
                            <Badge
                              variant="warning"
                              className="flex items-center gap-1 px-1.5 py-0 text-[9px]"
                            >
                              <Network className="h-2.5 w-2.5" aria-hidden />
                              cross-tenant
                            </Badge>
                          )}
                          <span className="ml-auto text-2xs text-muted-foreground">
                            tenant{" "}
                            <code className="font-mono">
                              {(a.principalTenantId ?? "").slice(0, 8)}…
                            </code>
                            {a.createdOn && (
                              <>
                                {" · since "}
                                {a.createdOn.slice(0, 10)}
                              </>
                            )}
                          </span>
                          {deleting && selected.has(a.id) && (
                            <Loader2
                              className="h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none"
                              aria-label="Deleting"
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </TabCard>
      <ConfirmationDialog
        hidden={!confirmDelete}
        title="Delete role assignments"
        message={`Delete ${selected.size} billing role assignment${
          selected.size === 1 ? "" : "s"
        }? This cannot be undone. If an assignment is already gone (404), it will be treated as success.`}
        confirmText="Delete"
        cancelText="Cancel"
        danger
        loading={deleting}
        onConfirm={() => void performDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
};

/* ----- Departments -------------------------------------------------- */

const DepartmentsTab: React.FC<{
  armToken: string;
  billingAccountName: string;
}> = ({ armToken, billingAccountName }) => {
  const depts = useAsyncLoad<EaDepartment[]>(
    () => listEaDepartments(billingAccountName, armToken),
    [armToken, billingAccountName],
  );
  const [search, setSearch] = React.useState("");
  const filtered = React.useMemo(() => {
    const list = depts.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((d) =>
      [d.departmentName, d.name, d.costCenter, d.status]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [depts.data, search]);
  return (
    <TabCard
      title="Departments"
      description="EA enrollment departments under this billing account."
      icon={Layers}
      onReload={depts.reload}
      reloading={depts.loading}
      action={
        depts.data && depts.data.length > 0 ? (
          <ExportMenu<EaDepartment>
            rows={filtered}
            columns={[
              { header: "Name", accessor: (d) => d.name },
              { header: "DepartmentName", accessor: (d) => d.departmentName },
              { header: "CostCenter", accessor: (d) => d.costCenter ?? "" },
              { header: "Status", accessor: (d) => d.status ?? "" },
              { header: "EnrollmentAccounts", accessor: (d) => d.enrollmentAccounts ?? "" },
              { header: "Id", accessor: (d) => d.id },
            ]}
            filename={`ea-departments-${billingAccountName}`}
          />
        ) : undefined
      }
    >
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Departments summary"
      >
        <SummaryStatItem
          label="Total"
          value={depts.data?.length ?? 0}
          compact
        />
        <SummaryStatItem
          label="With cost center"
          value={(depts.data ?? []).filter((d) => !!d.costCenter).length}
          compact
          tone={
            (depts.data ?? []).some((d) => !!d.costCenter) ? "info" : "muted"
          }
        />
        <SummaryStatItem
          label="Enrollment accts"
          value={(depts.data ?? []).reduce(
            (sum, d) =>
              sum +
              (typeof d.enrollmentAccounts === "number"
                ? d.enrollmentAccounts
                : 0),
            0,
          )}
          compact
        />
      </div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search department name, cost center…"
          className="pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Filter departments"
        />
      </div>
      {depts.loading ? (
        <SkeletonLoader variant="list" rows={3} />
      ) : depts.error ? (
        <ErrorState message="Failed to load departments." detail={depts.error} size="compact" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={search ? "No matching departments" : "No departments returned"}
          description={
            search
              ? "Adjust your filter to see results."
              : "This billing account has no departments configured, or your role does not allow listing them."
          }
          size="compact"
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {filtered.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
            >
              <Layers className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium">{d.departmentName}</span>
              <CopyableText value={d.name} mono />
              {d.costCenter && (
                <Badge variant="secondary" className="text-2xs">
                  CC: {d.costCenter}
                </Badge>
              )}
              {d.status && (
                <Badge variant="outline" className="text-2xs">
                  {d.status}
                </Badge>
              )}
              {d.enrollmentAccounts !== undefined && (
                <span className="ml-auto text-2xs text-muted-foreground">
                  {d.enrollmentAccounts} enrollment account
                  {d.enrollmentAccounts === 1 ? "" : "s"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </TabCard>
  );
};

/* ----- Enrollment Accounts ----------------------------------------- */

const EnrollmentAccountsTab: React.FC<{
  armToken: string;
  billingAccountName: string;
}> = ({ armToken, billingAccountName }) => {
  const ea = useAsyncLoad<EaEnrollmentAccount[]>(
    () => listEnrollmentAccounts(billingAccountName, armToken),
    [armToken, billingAccountName],
  );
  const [search, setSearch] = React.useState("");
  type EaFilter = "all" | "active" | "inactive";
  const [statusFilter, setStatusFilter] = React.useState<EaFilter>("all");
  const counts = React.useMemo(() => {
    const list = ea.data ?? [];
    let active = 0;
    let inactive = 0;
    for (const e of list) {
      const s = (e.status ?? "").toLowerCase();
      if (s === "active" || s === "enabled") active++;
      else if (s) inactive++;
    }
    return { total: list.length, active, inactive };
  }, [ea.data]);
  const filtered = React.useMemo(() => {
    const list = ea.data ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((e) => {
      const s = (e.status ?? "").toLowerCase();
      if (statusFilter === "active" && !(s === "active" || s === "enabled"))
        return false;
      if (statusFilter === "inactive" && (s === "active" || s === "enabled" || !s))
        return false;
      if (!q) return true;
      return [e.displayName, e.name, e.costCenter, e.status, e.accountOwner]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [ea.data, search, statusFilter]);
  return (
    <TabCard
      title="Enrollment accounts"
      description="Cost-tracking buckets that own newly-created subscriptions."
      icon={Building2}
      onReload={ea.reload}
      reloading={ea.loading}
      action={
        ea.data && ea.data.length > 0 ? (
          <ExportMenu<EaEnrollmentAccount>
            rows={filtered}
            columns={[
              { header: "Name", accessor: (e) => e.name },
              { header: "DisplayName", accessor: (e) => e.displayName },
              { header: "Status", accessor: (e) => e.status ?? "" },
              { header: "CostCenter", accessor: (e) => e.costCenter ?? "" },
              { header: "AccountOwner", accessor: (e) => e.accountOwner ?? "" },
              { header: "Id", accessor: (e) => e.id },
            ]}
            filename={`ea-enrollment-accounts-${billingAccountName}`}
          />
        ) : undefined
      }
    >
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Enrollment accounts summary"
      >
        <SummaryStatItem label="Total" value={counts.total} compact />
        <SummaryStatItem
          label="Active"
          value={counts.active}
          compact
          tone={counts.active > 0 ? "success" : "muted"}
        />
        <SummaryStatItem
          label="Inactive"
          value={counts.inactive}
          compact
          tone={counts.inactive > 0 ? "warning" : "muted"}
        />
      </div>
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Quick filters"
      >
        {(["all", "active", "inactive"] as const).map((f) => (
          <Button
            key={f}
            type="button"
            variant={statusFilter === f ? "default" : "ghost"}
            size="sm"
            className="h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setStatusFilter(f)}
            aria-pressed={statusFilter === f}
            aria-label={`Show ${f} enrollment accounts`}
          >
            {f === "all" ? "All" : f === "active" ? "Active" : "Inactive"}
          </Button>
        ))}
      </div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, owner, cost center…"
          className="pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Filter enrollment accounts"
        />
      </div>
      {ea.loading ? (
        <SkeletonLoader variant="list" rows={3} />
      ) : ea.error ? (
        <ErrorState message="Failed to load enrollment accounts." detail={ea.error} size="compact" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={search ? "No matching enrollment accounts" : "No enrollment accounts"}
          description={
            search
              ? "Adjust your filter to see results."
              : "No cost-tracking buckets exist for this billing account yet."
          }
          size="compact"
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {filtered.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
            >
              <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium">{e.displayName}</span>
              <CopyableText value={e.name} mono />
              {e.status && (
                <Badge variant="outline" className="text-2xs">
                  {e.status}
                </Badge>
              )}
              {e.costCenter && (
                <Badge variant="secondary" className="text-2xs">
                  CC: {e.costCenter}
                </Badge>
              )}
              {e.accountOwner && (
                <span className="ml-auto truncate text-2xs text-muted-foreground">
                  owner: {e.accountOwner}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </TabCard>
  );
};

/* ----- Subscriptions ------------------------------------------------ */

const SubscriptionsTab: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  store: ReturnType<typeof useMultiRegionStore>;
}> = ({ armToken, billingAccountName, accountUsername, store }) => {
  const subs = useAsyncLoad<EaBillingSubscription[]>(
    () => listEaBillingSubscriptions(billingAccountName, armToken),
    [armToken, billingAccountName],
  );
  const [search, setSearch] = React.useState("");
  type SubFilter = "all" | "active" | "disabled";
  const [statusFilter, setStatusFilter] = React.useState<SubFilter>("all");
  const [moveTargetSub, setMoveTargetSub] = React.useState<EaBillingSubscription | null>(null);
  const [cancelTargetSub, setCancelTargetSub] = React.useState<EaBillingSubscription | null>(null);
  const counts = React.useMemo(() => {
    const list = subs.data ?? [];
    let active = 0;
    let disabled = 0;
    for (const s of list) {
      const status = (s.status ?? "").toLowerCase();
      if (status === "active" || status === "enabled") active += 1;
      else if (
        status === "disabled" ||
        status === "deleted" ||
        status === "expired" ||
        status === "warned" ||
        status === "cancelled"
      )
        disabled += 1;
    }
    return { total: list.length, active, disabled };
  }, [subs.data]);
  const filtered = React.useMemo(() => {
    const list = subs.data ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((s) => {
      if (statusFilter !== "all") {
        const status = (s.status ?? "").toLowerCase();
        if (statusFilter === "active") {
          if (status !== "active" && status !== "enabled") return false;
        } else if (statusFilter === "disabled") {
          if (
            status !== "disabled" &&
            status !== "deleted" &&
            status !== "expired" &&
            status !== "warned" &&
            status !== "cancelled"
          )
            return false;
        }
      }
      if (!q) return true;
      return [
        s.displayName,
        s.subscriptionId,
        s.costCenter,
        s.billingProfileDisplayName,
        s.invoiceSectionDisplayName,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [subs.data, search, statusFilter]);
  return (
    <>
      <TabCard
        title="Billing subscriptions"
        description="Every subscription billed under this EA billing account. Use the actions on a row to move it between invoice sections or cancel."
        icon={Server}
        onReload={subs.reload}
        reloading={subs.loading}
        action={
          subs.data && subs.data.length > 0 ? (
            <ExportMenu<EaBillingSubscription>
              rows={filtered}
              columns={[
                { header: "DisplayName", accessor: (s) => s.displayName },
                { header: "SubscriptionId", accessor: (s) => s.subscriptionId ?? "" },
                { header: "Name", accessor: (s) => s.name },
                { header: "Status", accessor: (s) => s.status ?? "" },
                { header: "CostCenter", accessor: (s) => s.costCenter ?? "" },
                { header: "BillingProfile", accessor: (s) => s.billingProfileDisplayName ?? "" },
                { header: "InvoiceSection", accessor: (s) => s.invoiceSectionDisplayName ?? "" },
                { header: "Id", accessor: (s) => s.id },
              ]}
              filename={`ea-subscriptions-${billingAccountName}`}
            />
          ) : undefined
        }
      >
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Subscription summary"
        >
          <SummaryStatItem label="Total" value={counts.total} compact />
          <SummaryStatItem label="Active" value={counts.active} compact tone="success" />
          <SummaryStatItem
            label="Disabled"
            value={counts.disabled}
            compact
            tone={counts.disabled > 0 ? "warning" : undefined}
          />
        </div>
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Quick filters"
        >
          {(
            [
              { key: "all", label: "All", count: counts.total },
              { key: "active", label: "Active", count: counts.active },
              { key: "disabled", label: "Disabled", count: counts.disabled },
            ] as const
          ).map(({ key, label, count }) => (
            <Button
              key={key}
              type="button"
              variant={statusFilter === key ? "default" : "ghost"}
              size="sm"
              className="h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setStatusFilter(key)}
              aria-pressed={statusFilter === key}
              aria-label={`Show ${label.toLowerCase()} subscriptions`}
            >
              {label}
              <Badge
                variant={statusFilter === key ? "secondary" : "outline"}
                className="ml-1 h-4 px-1 text-[9px]"
              >
                {count}
              </Badge>
            </Button>
          ))}
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search display name, sub id, cost center…"
            className="pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Filter subscriptions"
          />
        </div>
        {subs.loading ? (
          <SkeletonLoader variant="list" rows={5} />
        ) : subs.error ? (
          <ErrorState message="Failed to load billing subscriptions." detail={subs.error} size="compact" />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Server}
            title="No matching subscriptions"
            description={
              search
                ? "No subscriptions match your search. Try a different term."
                : "This billing account has no subscriptions yet."
            }
            size="compact"
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
              >
                <Server className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{s.displayName}</span>
                {s.subscriptionId && <CopyableText value={s.subscriptionId} mono />}
                {s.status && (
                  <Badge variant="outline" className="text-2xs">
                    {s.status}
                  </Badge>
                )}
                {s.costCenter && (
                  <Badge variant="secondary" className="text-2xs">
                    CC: {s.costCenter}
                  </Badge>
                )}
                {s.invoiceSectionDisplayName && (
                  <span className="truncate text-2xs text-muted-foreground">
                    {s.billingProfileDisplayName ?? ""} ▸ {s.invoiceSectionDisplayName}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-2xs"
                    onClick={() => setMoveTargetSub(s)}
                    aria-label={`Move subscription ${s.displayName}`}
                    title="Move to a different invoice section"
                  >
                    Move
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-2xs text-destructive"
                    onClick={() => setCancelTargetSub(s)}
                    aria-label={`Cancel subscription ${s.displayName}`}
                    title="Cancel this subscription (irreversible)"
                  >
                    Cancel
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </TabCard>

      {moveTargetSub && (
        <SubscriptionMoveDialog
          armToken={armToken}
          billingAccountName={billingAccountName}
          accountUsername={accountUsername}
          sub={moveTargetSub}
          store={store}
          onClose={(refreshed) => {
            setMoveTargetSub(null);
            if (refreshed) subs.reload();
          }}
        />
      )}
      {cancelTargetSub && (
        <SubscriptionCancelDialog
          armToken={armToken}
          billingAccountName={billingAccountName}
          accountUsername={accountUsername}
          sub={cancelTargetSub}
          store={store}
          onClose={(refreshed) => {
            setCancelTargetSub(null);
            if (refreshed) subs.reload();
          }}
        />
      )}
    </>
  );
};

/* ----- Subscription move dialog (POST /billingSubscriptions/{name}/move) */

const SubscriptionMoveDialog: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  sub: EaBillingSubscription;
  store: ReturnType<typeof useMultiRegionStore>;
  onClose: (refreshed: boolean) => void;
}> = ({ armToken, billingAccountName, accountUsername, sub, store, onClose }) => {
  const [destInvoiceSectionId, setDestInvoiceSectionId] = React.useState("");
  const [destProfileId, setDestProfileId] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Helper validators — the EA backend rejects empty or malformed
  // ARM ids with a 400 that's not super readable, so we surface the
  // common mistake (forgot the /providers/ prefix) up-front.
  const invoiceIdValid = /^\/providers\/Microsoft\.Billing\/billingAccounts\//i.test(
    destInvoiceSectionId.trim(),
  );
  const profileIdValid =
    destProfileId.trim() === "" ||
    /^\/providers\/Microsoft\.Billing\/billingAccounts\//i.test(destProfileId.trim());

  const submit = React.useCallback(async () => {
    setConfirmOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      const result = await moveBillingSubscription(
        billingAccountName,
        sub.name,
        {
          destinationInvoiceSectionId: destInvoiceSectionId.trim(),
          destinationBillingProfileId: destProfileId.trim() || undefined,
        },
        armToken,
      );
      auditLog.record({
        actor: accountUsername,
        action: "move_billing_subscription",
        target: sub.subscriptionId ?? sub.name,
        status: "success",
        details: {
          billingAccountName,
          destinationInvoiceSectionId: destInvoiceSectionId.trim(),
          destinationBillingProfileId: destProfileId.trim(),
          status: result.status,
        },
      });
      store.addNotification({
        type: "success",
        message: `Move accepted (${result.status}). Operation is async; check the sub after a few minutes.`,
      });
      onClose(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      auditLog.record({
        actor: accountUsername,
        action: "move_billing_subscription",
        target: sub.subscriptionId ?? sub.name,
        status: "failure",
        error: msg,
        details: {
          billingAccountName,
          destinationInvoiceSectionId: destInvoiceSectionId.trim(),
          destinationBillingProfileId: destProfileId.trim(),
        },
      });
    } finally {
      setSubmitting(false);
    }
  }, [armToken, billingAccountName, sub, destInvoiceSectionId, destProfileId, accountUsername, store, onClose]);

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Move {sub.displayName}</CardTitle>
        <CardDescription className="text-2xs">
          POST /billingSubscriptions/{sub.name}/move
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {sub.invoiceSectionDisplayName && (
          <p className="text-2xs text-muted-foreground">
            Currently billed under{" "}
            <strong>{sub.billingProfileDisplayName ?? "—"}</strong>{" "}
            <ChevronRight className="inline h-3 w-3" aria-hidden />{" "}
            <strong>{sub.invoiceSectionDisplayName}</strong>.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Destination invoice section ARM id *</Label>
          <Input
            value={destInvoiceSectionId}
            onChange={(e) => setDestInvoiceSectionId(e.target.value)}
            placeholder="/providers/Microsoft.Billing/billingAccounts/.../invoiceSections/..."
            className={cn(
              "font-mono text-xs",
              destInvoiceSectionId.trim() &&
                !invoiceIdValid &&
                "border-destructive focus-visible:ring-destructive",
            )}
            aria-invalid={!!destInvoiceSectionId.trim() && !invoiceIdValid}
          />
          {destInvoiceSectionId.trim() && !invoiceIdValid && (
            <span className="text-2xs text-destructive">
              Must start with /providers/Microsoft.Billing/billingAccounts/…
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Destination billing profile ARM id (optional)</Label>
          <Input
            value={destProfileId}
            onChange={(e) => setDestProfileId(e.target.value)}
            placeholder="/providers/Microsoft.Billing/billingAccounts/.../billingProfiles/..."
            className={cn(
              "font-mono text-xs",
              !profileIdValid && "border-destructive focus-visible:ring-destructive",
            )}
            aria-invalid={!profileIdValid}
          />
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={submitting || !invoiceIdValid || !profileIdValid}
            loading={submitting}
          >
            Move
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={submitting}>
            Close
          </Button>
        </div>
      </CardContent>
      <ConfirmationDialog
        hidden={!confirmOpen}
        title="Move subscription"
        message={
          <div className="space-y-2 text-sm">
            <p>
              Move <strong>{sub.displayName}</strong> to a new invoice section?
            </p>
            <p className="text-xs text-muted-foreground">
              This is an async operation — the move usually completes within
              5 minutes. Billing continues without interruption.
            </p>
            <p className="break-all text-2xs font-mono">
              {destInvoiceSectionId.trim()}
            </p>
          </div>
        }
        confirmText="Move"
        cancelText="Cancel"
        loading={submitting}
        onConfirm={() => void submit()}
        onCancel={() => setConfirmOpen(false)}
      />
    </Card>
  );
};

/* ----- Subscription cancel dialog (POST /billingSubscriptions/{name}/cancel) */

const SubscriptionCancelDialog: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  sub: EaBillingSubscription;
  store: ReturnType<typeof useMultiRegionStore>;
  onClose: (refreshed: boolean) => void;
}> = ({ armToken, billingAccountName, accountUsername, sub, store, onClose }) => {
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const runCancel = React.useCallback(async () => {
    setConfirmOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      const result = await cancelBillingSubscription(
        billingAccountName,
        sub.name,
        reason.trim() || "Cancelled via EA Billing Manager",
        armToken,
      );
      auditLog.record({
        actor: accountUsername,
        action: "cancel_billing_subscription",
        target: sub.subscriptionId ?? sub.name,
        status: "success",
        details: { billingAccountName, reason, status: result.status },
      });
      store.addNotification({
        type: "success",
        message: `Cancel accepted (${result.status}).`,
      });
      onClose(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      auditLog.record({
        actor: accountUsername,
        action: "cancel_billing_subscription",
        target: sub.subscriptionId ?? sub.name,
        status: "failure",
        error: msg,
        details: { billingAccountName, reason },
      });
    } finally {
      setSubmitting(false);
    }
  }, [armToken, billingAccountName, sub, reason, accountUsername, store, onClose]);

  return (
    <>
      <Card className="border-destructive/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-destructive">
            Cancel {sub.displayName}
          </CardTitle>
          <CardDescription className="text-2xs">
            POST /billingSubscriptions/{sub.name}/cancel — irreversible.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Cancellation reason</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. consolidating sandbox subs"
              className="text-xs focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Cancellation reason"
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmOpen(true)}
              disabled={submitting}
              loading={submitting}
              aria-label={`Cancel subscription ${sub.displayName}`}
            >
              Cancel subscription
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onClose(false)}
              disabled={submitting}
            >
              Close
            </Button>
          </div>
        </CardContent>
      </Card>
      <ConfirmationDialog
        hidden={!confirmOpen}
        title="Cancel subscription"
        message={`Cancel ${sub.displayName}? This is irreversible — once cancelled, the subscription cannot be re-activated by anyone but Microsoft support.`}
        confirmText="Cancel subscription"
        cancelText="Keep it"
        danger
        loading={submitting}
        onConfirm={() => void runCancel()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
};

/* ----- Invoices ----------------------------------------------------- */

const InvoicesTab: React.FC<{
  armToken: string;
  billingAccountName: string;
}> = ({ armToken, billingAccountName }) => {
  // Custom date range (defaults handled inside the service).
  const [from, setFrom] = React.useState<string>("");
  const [to, setTo] = React.useState<string>("");
  // Guard against inverted ranges that produce empty results silently.
  const rangeInverted = !!(from && to && from > to);

  type InvFilter = "all" | "thisYear" | "unpaid" | "overdue";
  const [filter, setFilter] = React.useState<InvFilter>("all");
  const [search, setSearch] = React.useState("");

  const invoices = useAsyncLoad<EaInvoice[]>(
    () =>
      rangeInverted
        ? null
        : listEaInvoices(billingAccountName, armToken, {
            periodStartDate: from || undefined,
            periodEndDate: to || undefined,
          }),
    [armToken, billingAccountName, from, to, rangeInverted],
  );

  const todayIso = React.useMemo(
    () => new Date().toISOString().slice(0, 10),
    [],
  );

  // Determine whether an invoice has any outstanding balance. Some
  // tenants report `status: "Paid"` with a non-zero amountDue that
  // hasn't cleared yet — trust status when it's an explicit Paid, but
  // otherwise treat any positive amountDue as unpaid.
  const isUnpaid = React.useCallback((inv: EaInvoice) => {
    const status = (inv.status ?? "").toLowerCase();
    if (status === "paid") return false;
    return !!inv.amountDue && inv.amountDue.value > 0;
  }, []);
  // Overdue: unpaid AND dueDate is in the past.
  const isOverdue = React.useCallback(
    (inv: EaInvoice) =>
      isUnpaid(inv) && !!inv.dueDate && inv.dueDate.slice(0, 10) < todayIso,
    [isUnpaid, todayIso],
  );

  const filtered = React.useMemo(() => {
    const list = invoices.data ?? [];
    const q = search.trim().toLowerCase();
    const now = new Date();
    const yearStart = `${now.getUTCFullYear()}-01-01`;
    return list.filter((inv) => {
      if (filter === "thisYear") {
        if (!inv.invoiceDate || inv.invoiceDate.slice(0, 10) < yearStart) return false;
      } else if (filter === "unpaid") {
        if (!isUnpaid(inv)) return false;
      } else if (filter === "overdue") {
        if (!isOverdue(inv)) return false;
      }
      if (!q) return true;
      return [inv.name, inv.status, inv.totalAmount?.currency, String(inv.totalAmount?.value ?? "")]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [invoices.data, filter, search, isUnpaid, isOverdue]);

  const totals = React.useMemo(() => {
    const list = invoices.data ?? [];
    let totalAmount = 0;
    let totalDue = 0;
    let unpaidCount = 0;
    let overdueCount = 0;
    let currency = "";
    for (const inv of list) {
      if (inv.totalAmount) {
        totalAmount += inv.totalAmount.value;
        currency = currency || inv.totalAmount.currency;
      }
      if (inv.amountDue) totalDue += inv.amountDue.value;
      if (isUnpaid(inv)) unpaidCount++;
      if (isOverdue(inv)) overdueCount++;
    }
    return {
      count: list.length,
      totalAmount,
      totalDue,
      currency,
      unpaidCount,
      overdueCount,
    };
  }, [invoices.data, isUnpaid, isOverdue]);

  return (
    <TabCard
      title="Invoices"
      description="Invoices on this billing account. Defaults to the last 12 months; override the date range below."
      icon={Receipt}
      onReload={invoices.reload}
      reloading={invoices.loading}
      action={
        invoices.data && invoices.data.length > 0 ? (
          <ExportMenu<EaInvoice>
            rows={filtered}
            columns={[
              { header: "Name", accessor: (i) => i.name },
              { header: "Status", accessor: (i) => i.status ?? "" },
              { header: "InvoiceDate", accessor: (i) => i.invoiceDate ?? "" },
              { header: "PeriodStart", accessor: (i) => i.invoicePeriodStartDate ?? "" },
              { header: "PeriodEnd", accessor: (i) => i.invoicePeriodEndDate ?? "" },
              { header: "TotalAmount", accessor: (i) => i.totalAmount?.value ?? "" },
              { header: "AmountDue", accessor: (i) => i.amountDue?.value ?? "" },
              { header: "Currency", accessor: (i) => i.totalAmount?.currency ?? "" },
              { header: "Id", accessor: (i) => i.id },
            ]}
            filename={`ea-invoices-${billingAccountName}`}
          />
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs" htmlFor="ea-inv-from">From</Label>
        <Input
          id="ea-inv-from"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-44 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Period start date"
        />
        <Label className="text-xs" htmlFor="ea-inv-to">To</Label>
        <Input
          id="ea-inv-to"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-44 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Period end date"
        />
        {(from || to) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-2xs"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            Clear range
          </Button>
        )}
      </div>
      {rangeInverted && (
        <Alert variant="destructive">
          <AlertDescription>
            "From" date is after "To" date — adjust the range to load invoices.
          </AlertDescription>
        </Alert>
      )}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Invoice summary"
      >
        <SummaryStatItem label="Count" value={totals.count} compact />
        <SummaryStatItem
          label="Total"
          value={`${totals.totalAmount.toLocaleString()} ${totals.currency}`}
          compact
        />
        <SummaryStatItem
          label="Due"
          value={`${totals.totalDue.toLocaleString()} ${totals.currency}`}
          compact
          tone={totals.totalDue > 0 ? "warning" : undefined}
        />
        <SummaryStatItem
          label="Unpaid"
          value={totals.unpaidCount}
          compact
          tone={totals.unpaidCount > 0 ? "warning" : "muted"}
        />
        <SummaryStatItem
          label="Overdue"
          value={totals.overdueCount}
          compact
          tone={totals.overdueCount > 0 ? "destructive" : "muted"}
        />
      </div>
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Invoice quick filters"
      >
        {(
          [
            { key: "all", label: "All", count: totals.count },
            { key: "thisYear", label: "This year", count: undefined as number | undefined },
            { key: "unpaid", label: "Unpaid", count: totals.unpaidCount },
            { key: "overdue", label: "Overdue", count: totals.overdueCount },
          ] as const
        ).map(({ key, label, count }) => (
          <Button
            key={key}
            type="button"
            variant={filter === key ? "default" : "ghost"}
            size="sm"
            className="h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            aria-label={`Show ${label.toLowerCase()} invoices`}
          >
            {label}
            {count !== undefined && (
              <Badge
                variant={filter === key ? "secondary" : "outline"}
                className="ml-1 h-4 px-1 text-[9px]"
              >
                {count}
              </Badge>
            )}
          </Button>
        ))}
      </div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search invoice name, status…"
          className="pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Filter invoices"
        />
      </div>
      {invoices.loading ? (
        <SkeletonLoader variant="list" rows={3} />
      ) : invoices.error ? (
        <ErrorState message="Failed to load invoices." detail={invoices.error} size="compact" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No invoices in this range"
          description="Try expanding the date range or check that invoices have been generated for this billing account."
          size="compact"
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {filtered.map((inv) => {
            const overdue = isOverdue(inv);
            const unpaid = !overdue && isUnpaid(inv);
            return (
              <li
                key={inv.id}
                className={cn(
                  "group/copy flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs",
                  overdue && "border-destructive/30 bg-destructive/5",
                  !overdue && unpaid && "border-warning/30 bg-warning/5",
                  !overdue && !unpaid && "border-border",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
                  <CopyableText value={inv.name} mono />
                  {inv.status && (
                    <Badge variant="outline" className="text-2xs">
                      {inv.status}
                    </Badge>
                  )}
                  {inv.totalAmount && (
                    <Badge variant="secondary" className="text-2xs">
                      {inv.totalAmount.value.toLocaleString()} {inv.totalAmount.currency}
                    </Badge>
                  )}
                  {inv.amountDue && inv.amountDue.value > 0 && (
                    <Badge variant="warning" className="text-2xs">
                      due {inv.amountDue.value.toLocaleString()} {inv.amountDue.currency}
                    </Badge>
                  )}
                  {overdue && (
                    <Badge variant="destructive" className="text-2xs">
                      overdue
                    </Badge>
                  )}
                  <span className="ml-auto text-2xs text-muted-foreground">
                    {inv.invoiceDate?.slice(0, 10)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-5 text-2xs text-muted-foreground">
                  {inv.invoicePeriodStartDate && (
                    <span>
                      period {inv.invoicePeriodStartDate.slice(0, 10)}
                      {inv.invoicePeriodEndDate
                        ? ` → ${inv.invoicePeriodEndDate.slice(0, 10)}`
                        : ""}
                    </span>
                  )}
                  {inv.dueDate && (
                    <span>due {inv.dueDate.slice(0, 10)}</span>
                  )}
                  {inv.documentUrls?.map((d) => (
                    <span key={d.url} className="inline-flex items-center gap-0.5">
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {d.kind}
                      </a>
                      <CopyButton
                        value={d.url}
                        ariaLabel={`Copy ${d.kind} URL`}
                      />
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </TabCard>
  );
};

/* ----- Reservations ------------------------------------------------- */

const ReservationsTab: React.FC<{ armToken: string }> = ({ armToken }) => {
  const ros = useAsyncLoad<ReservationOrder[]>(
    () => listReservationOrders(armToken),
    [armToken],
  );
  const [search, setSearch] = React.useState("");
  type ResFilter = "all" | "active" | "expiringSoon" | "expired";
  const [statusFilter, setStatusFilter] = React.useState<ResFilter>("all");
  // 90 days from "today" — anything expiring within this window is
  // surfaced via the "Expiring soon" chip. Memoized so the cutoff is
  // stable across re-renders (otherwise the filter would jitter as
  // milliseconds tick).
  const expiringCutoff = React.useMemo(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 90);
    return d.toISOString().slice(0, 10);
  }, []);
  const todayIso = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  const counts = React.useMemo(() => {
    const list = ros.data ?? [];
    let active = 0;
    let expiringSoon = 0;
    let expired = 0;
    let totalReservations = 0;
    for (const r of list) {
      const state = (r.provisioningState ?? "").toLowerCase();
      const expiry = r.expiryDate?.slice(0, 10) ?? "";
      if (typeof r.reservations === "number") totalReservations += r.reservations;
      if (expiry && expiry < todayIso) expired++;
      else if (expiry && expiry <= expiringCutoff) expiringSoon++;
      else if (
        state === "succeeded" ||
        state === "active" ||
        state === "creating" ||
        state === ""
      )
        active++;
    }
    return { total: list.length, active, expiringSoon, expired, totalReservations };
  }, [ros.data, expiringCutoff, todayIso]);
  const filtered = React.useMemo(() => {
    const list = ros.data ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((r) => {
      const expiry = r.expiryDate?.slice(0, 10) ?? "";
      if (statusFilter === "expiringSoon") {
        if (!expiry || expiry < todayIso || expiry > expiringCutoff) return false;
      } else if (statusFilter === "expired") {
        if (!expiry || expiry >= todayIso) return false;
      } else if (statusFilter === "active") {
        if (expiry && expiry < todayIso) return false;
      }
      if (!q) return true;
      return [r.displayName, r.name, r.term, r.billingPlan, r.provisioningState]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [ros.data, search, statusFilter, todayIso, expiringCutoff]);
  return (
    <TabCard
      title="Reservation orders"
      description="Tenant-wide list. Microsoft.Capacity isn't strictly scoped to the billing account, so this surfaces every order the caller can see."
      icon={Database}
      onReload={ros.reload}
      reloading={ros.loading}
      action={
        ros.data && ros.data.length > 0 ? (
          <ExportMenu<ReservationOrder>
            rows={filtered}
            columns={[
              { header: "Name", accessor: (r) => r.name },
              { header: "DisplayName", accessor: (r) => r.displayName ?? "" },
              { header: "Term", accessor: (r) => r.term ?? "" },
              { header: "BillingPlan", accessor: (r) => r.billingPlan ?? "" },
              { header: "ProvisioningState", accessor: (r) => r.provisioningState ?? "" },
              { header: "BenefitStartTime", accessor: (r) => r.benefitStartTime ?? "" },
              { header: "ExpiryDate", accessor: (r) => r.expiryDate ?? "" },
              { header: "Reservations", accessor: (r) => r.reservations ?? "" },
              { header: "Id", accessor: (r) => r.id },
            ]}
            filename="reservation-orders"
          />
        ) : undefined
      }
    >
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Reservation orders summary"
      >
        <SummaryStatItem label="Total" value={counts.total} compact />
        <SummaryStatItem
          label="Active"
          value={counts.active}
          compact
          tone={counts.active > 0 ? "success" : "muted"}
        />
        <SummaryStatItem
          label="Expiring 90d"
          value={counts.expiringSoon}
          compact
          tone={counts.expiringSoon > 0 ? "warning" : "muted"}
        />
        <SummaryStatItem
          label="Expired"
          value={counts.expired}
          compact
          tone={counts.expired > 0 ? "destructive" : "muted"}
        />
        <SummaryStatItem
          label="Reservations"
          value={counts.totalReservations}
          compact
          hint="sum across orders"
        />
      </div>
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Quick filters"
      >
        {(
          [
            { key: "all", label: "All", count: counts.total },
            { key: "active", label: "Active", count: counts.active },
            { key: "expiringSoon", label: "Expiring 90d", count: counts.expiringSoon },
            { key: "expired", label: "Expired", count: counts.expired },
          ] as const
        ).map(({ key, label, count }) => (
          <Button
            key={key}
            type="button"
            variant={statusFilter === key ? "default" : "ghost"}
            size="sm"
            className="h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setStatusFilter(key)}
            aria-pressed={statusFilter === key}
            aria-label={`Show ${label.toLowerCase()} reservations`}
          >
            {label}
            <Badge
              variant={statusFilter === key ? "secondary" : "outline"}
              className="ml-1 h-4 px-1 text-[9px]"
            >
              {count}
            </Badge>
          </Button>
        ))}
      </div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search reservation name, term, plan…"
          className="pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Filter reservation orders"
        />
      </div>
      {ros.loading ? (
        <SkeletonLoader variant="list" rows={3} />
      ) : ros.error ? (
        <ErrorState message="Failed to load reservation orders." detail={ros.error} size="compact" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Database}
          title={search ? "No matching reservations" : "No reservation orders"}
          description={
            search
              ? "Adjust your filter to see results."
              : "This tenant has no reserved-instance orders, or your account lacks permission to view them."
          }
          size="compact"
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {filtered.map((r) => {
            const expiry = r.expiryDate?.slice(0, 10) ?? "";
            const isExpired = !!expiry && expiry < todayIso;
            const isExpiringSoon = !!expiry && !isExpired && expiry <= expiringCutoff;
            return (
              <li
                key={r.id}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
                  isExpired && "border-destructive/30 bg-destructive/5",
                  !isExpired && isExpiringSoon && "border-warning/30 bg-warning/5",
                  !isExpired && !isExpiringSoon && "border-border",
                )}
              >
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{r.displayName ?? r.name}</span>
                <CopyableText value={r.name} mono />
                {r.term && (
                  <Badge variant="outline" className="text-2xs">
                    {r.term}
                  </Badge>
                )}
                {r.billingPlan && (
                  <Badge variant="secondary" className="text-2xs">
                    {r.billingPlan}
                  </Badge>
                )}
                {r.provisioningState && (
                  <Badge variant="outline" className="text-2xs">
                    {r.provisioningState}
                  </Badge>
                )}
                {isExpired && (
                  <Badge variant="destructive" className="text-2xs">
                    expired
                  </Badge>
                )}
                {!isExpired && isExpiringSoon && (
                  <Badge variant="warning" className="text-2xs">
                    expiring 90d
                  </Badge>
                )}
                <span className="ml-auto text-2xs text-muted-foreground">
                  {r.benefitStartTime?.slice(0, 10)}
                  {r.expiryDate ? ` → ${r.expiryDate.slice(0, 10)}` : ""}
                  {r.reservations !== undefined ? ` · ${r.reservations} resv` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </TabCard>
  );
};

/* ----- Policies ----------------------------------------------------- */

const PoliciesTab: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  store: ReturnType<typeof useMultiRegionStore>;
}> = ({ armToken, billingAccountName, accountUsername, store }) => {
  const pol = useAsyncLoad<EaBillingPolicy>(
    () => getEaBillingPolicy(billingAccountName, armToken),
    [armToken, billingAccountName],
  );
  const [draft, setDraft] = React.useState<EaBillingPolicy | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (pol.data) setDraft({ ...pol.data });
  }, [pol.data]);

  const dirty = React.useMemo(() => {
    if (!draft || !pol.data) return false;
    return (
      draft.marketplacePurchases !== pol.data.marketplacePurchases ||
      draft.reservationPurchases !== pol.data.reservationPurchases ||
      draft.savingsPlanPurchases !== pol.data.savingsPlanPurchases ||
      draft.enterpriseAgreementDevTestEnabled !==
        pol.data.enterpriseAgreementDevTestEnabled
    );
  }, [draft, pol.data]);

  // Browser-tab guard so a Cmd+R / X-tab close doesn't silently discard
  // pending billing-policy edits before the operator clicks Save.
  useBeforeUnload(dirty, "EA billing policy has unsaved changes. Leave anyway?");

  const save = React.useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateEaBillingPolicy(
        billingAccountName,
        {
          marketplacePurchases: draft.marketplacePurchases,
          reservationPurchases: draft.reservationPurchases,
          savingsPlanPurchases: draft.savingsPlanPurchases,
          enterpriseAgreementDevTestEnabled:
            draft.enterpriseAgreementDevTestEnabled,
        },
        armToken,
      );
      auditLog.record({
        actor: accountUsername,
        action: "update_billing_policy",
        target: billingAccountName,
        status: "success",
        details: { ...updated },
      });
      setDraft(updated);
      store.addNotification({ type: "success", message: "Billing policy updated." });
      pol.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      auditLog.record({
        actor: accountUsername,
        action: "update_billing_policy",
        target: billingAccountName,
        status: "failure",
        error: msg,
      });
    } finally {
      setSaving(false);
    }
  }, [draft, armToken, billingAccountName, accountUsername, store, pol]);

  const POLICY_VALUES = [
    { value: "Allowed", label: "Allowed" },
    { value: "NotAllowed", label: "Not allowed" },
  ];

  return (
    <TabCard
      title="Billing policies"
      description="Governs marketplace, reservation, and savings-plan purchases plus dev-test pricing eligibility."
      icon={Sliders}
      onReload={pol.reload}
      reloading={pol.loading}
      action={
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          disabled={!dirty || saving}
          onClick={() => void save()}
          loading={saving}
        >
          {!saving && <Check />}
          Save
        </Button>
      }
    >
      {pol.loading ? (
        <SkeletonLoader variant="form" rows={3} />
      ) : pol.error ? (
        <ErrorState message="Failed to load billing policies." detail={pol.error} size="compact" />
      ) : !draft ? null : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <PolicySelect
            label="Marketplace purchases"
            value={draft.marketplacePurchases ?? ""}
            onChange={(v) =>
              setDraft({ ...draft, marketplacePurchases: v })
            }
            options={POLICY_VALUES}
          />
          <PolicySelect
            label="Reservation purchases"
            value={draft.reservationPurchases ?? ""}
            onChange={(v) =>
              setDraft({ ...draft, reservationPurchases: v })
            }
            options={POLICY_VALUES}
          />
          <PolicySelect
            label="Savings plan purchases"
            value={draft.savingsPlanPurchases ?? ""}
            onChange={(v) =>
              setDraft({ ...draft, savingsPlanPurchases: v })
            }
            options={POLICY_VALUES}
          />
          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              checked={!!draft.enterpriseAgreementDevTestEnabled}
              onCheckedChange={(v) =>
                setDraft({
                  ...draft,
                  enterpriseAgreementDevTestEnabled: v === true,
                })
              }
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">EA Dev/Test pricing</span>
              <span className="text-2xs text-muted-foreground">
                Enables Dev/Test rates on subscriptions provisioned under
                this enrollment.
              </span>
            </span>
          </label>
        </div>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
    </TabCard>
  );
};

const PolicySelect: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}> = ({ label, value, onChange, options }) => (
  <div className="flex flex-col gap-1.5">
    <Label className="text-xs">{label}</Label>
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
);

/* ----- Transactions (Round-2 #1) ------------------------------------ */

const TransactionsTab: React.FC<{
  armToken: string;
  billingAccountName: string;
}> = ({ armToken, billingAccountName }) => {
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [search, setSearch] = React.useState("");
  type TxFilter = "all" | "purchase" | "refund" | "usage";
  const [kindFilter, setKindFilter] = React.useState<TxFilter>("all");
  const rangeInverted = !!(from && to && from > to);
  const tx = useAsyncLoad<EaTransaction[]>(
    () =>
      rangeInverted
        ? null
        : listEaTransactions(billingAccountName, armToken, {
            periodStartDate: from || undefined,
            periodEndDate: to || undefined,
          }),
    [armToken, billingAccountName, from, to, rangeInverted],
  );
  // Bucket transactions by an inferred kind so the chip filter is
  // useful even when EA returns inconsistent capitalization
  // ("Purchase" vs "purchase") across tenants.
  const inferBucket = React.useCallback((t: EaTransaction): TxFilter => {
    const k = `${t.transactionType ?? ""} ${t.kind ?? ""}`.toLowerCase();
    if (k.includes("refund") || k.includes("credit")) return "refund";
    if (k.includes("purchase") || k.includes("buy") || k.includes("renew"))
      return "purchase";
    if (k.includes("usage") || k.includes("consumption")) return "usage";
    // Falls into the catch-all bucket — visible only under "All".
    return "all";
  }, []);
  const filtered = React.useMemo(() => {
    const list = tx.data ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((t) => {
      if (kindFilter !== "all" && inferBucket(t) !== kindFilter) return false;
      if (!q) return true;
      return [
        t.productDescription,
        t.name,
        t.transactionType,
        t.kind,
        t.subscriptionName,
        t.invoice,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [tx.data, search, kindFilter, inferBucket]);
  const totals = React.useMemo(() => {
    const list = tx.data ?? [];
    let total = 0;
    let purchases = 0;
    let refunds = 0;
    let currency = "";
    for (const t of list) {
      if (t.transactionAmount) {
        total += t.transactionAmount.value;
        currency = currency || t.transactionAmount.currency;
      }
      const bucket = inferBucket(t);
      if (bucket === "purchase") purchases++;
      else if (bucket === "refund") refunds++;
    }
    return { count: list.length, total, currency, purchases, refunds };
  }, [tx.data, inferBucket]);
  return (
    <TabCard
      title="Transactions"
      description="Charge / refund / purchase ledger. Defaults to the last 60 days."
      icon={FileText}
      onReload={tx.reload}
      reloading={tx.loading}
      action={
        tx.data && tx.data.length > 0 ? (
          <ExportMenu<EaTransaction>
            rows={filtered}
            columns={[
              { header: "Name", accessor: (t) => t.name },
              { header: "ProductDescription", accessor: (t) => t.productDescription ?? "" },
              { header: "TransactionType", accessor: (t) => t.transactionType ?? "" },
              { header: "Kind", accessor: (t) => t.kind ?? "" },
              { header: "Amount", accessor: (t) => t.transactionAmount?.value ?? "" },
              { header: "Currency", accessor: (t) => t.transactionAmount?.currency ?? "" },
              { header: "SubscriptionName", accessor: (t) => t.subscriptionName ?? "" },
              { header: "Invoice", accessor: (t) => t.invoice ?? "" },
              { header: "TransactionDate", accessor: (t) => t.transactionDate ?? "" },
              { header: "Id", accessor: (t) => t.id },
            ]}
            filename={`ea-transactions-${billingAccountName}`}
          />
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs" htmlFor="ea-tx-from">From</Label>
        <Input
          id="ea-tx-from"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-44 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Transactions period start date"
        />
        <Label className="text-xs" htmlFor="ea-tx-to">To</Label>
        <Input
          id="ea-tx-to"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-44 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Transactions period end date"
        />
      </div>
      {rangeInverted && (
        <Alert variant="destructive">
          <AlertDescription>
            "From" date is after "To" date — adjust the range to load transactions.
          </AlertDescription>
        </Alert>
      )}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Transactions summary"
      >
        <SummaryStatItem label="Count" value={totals.count} compact />
        <SummaryStatItem
          label="Net"
          value={`${totals.total.toLocaleString()} ${totals.currency}`}
          compact
          tone={totals.total < 0 ? "success" : undefined}
        />
        <SummaryStatItem
          label="Purchases"
          value={totals.purchases}
          compact
          tone={totals.purchases > 0 ? "info" : "muted"}
        />
        <SummaryStatItem
          label="Refunds"
          value={totals.refunds}
          compact
          tone={totals.refunds > 0 ? "success" : "muted"}
        />
      </div>
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Transactions quick filters"
      >
        {(["all", "purchase", "refund", "usage"] as const).map((k) => (
          <Button
            key={k}
            type="button"
            variant={kindFilter === k ? "default" : "ghost"}
            size="sm"
            className="h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setKindFilter(k)}
            aria-pressed={kindFilter === k}
          >
            {k === "all"
              ? "All"
              : k === "purchase"
                ? "Purchases"
                : k === "refund"
                  ? "Refunds"
                  : "Usage"}
          </Button>
        ))}
      </div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product, kind, sub id, invoice…"
          className="pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Filter transactions"
        />
      </div>
      {tx.loading ? (
        <SkeletonLoader variant="list" rows={4} />
      ) : tx.error ? (
        <ErrorState message="Failed to load transactions." detail={tx.error} size="compact" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={search ? "No matching transactions" : "No transactions in this range"}
          description={
            search
              ? "Adjust your filter to see results."
              : "Expand the period to surface more charges / refunds, or check the date filters above."
          }
          size="compact"
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {filtered.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
            >
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium">{t.productDescription ?? t.name}</span>
              {t.transactionType && (
                <Badge variant="outline" className="text-2xs">{t.transactionType}</Badge>
              )}
              {t.kind && (
                <Badge variant="secondary" className="text-2xs">{t.kind}</Badge>
              )}
              {t.transactionAmount && (
                <Badge variant="secondary" className="text-2xs">
                  {t.transactionAmount.value.toLocaleString()} {t.transactionAmount.currency}
                </Badge>
              )}
              {t.subscriptionName && (
                <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
                  sub: <CopyableText value={t.subscriptionName} mono />
                </span>
              )}
              <span className="ml-auto text-2xs text-muted-foreground">
                {t.transactionDate?.slice(0, 10)}
                {t.invoice ? ` · invoice ${t.invoice}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </TabCard>
  );
};

/* ----- Transfers (Round-2 #2 + #3) ---------------------------------- */

const TransfersTab: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  store: ReturnType<typeof useMultiRegionStore>;
}> = ({ armToken, billingAccountName, accountUsername, store }) => {
  const profiles = useAsyncLoad<EaBillingProfile[]>(
    () => listBillingProfiles(billingAccountName, armToken),
    [armToken, billingAccountName],
  );
  const [profileName, setProfileName] = React.useState("");
  const [sectionName, setSectionName] = React.useState("");
  const sections = useAsyncLoad<EaInvoiceSection[]>(
    () =>
      profileName
        ? listInvoiceSections(billingAccountName, profileName, armToken)
        : null,
    [armToken, billingAccountName, profileName],
  );
  const outbound = useAsyncLoad<OutboundTransfer[]>(
    () =>
      profileName && sectionName
        ? listOutboundTransfers(billingAccountName, profileName, sectionName, armToken)
        : null,
    [armToken, billingAccountName, profileName, sectionName],
  );
  const inbound = useAsyncLoad<InboundTransfer[]>(
    () => listInboundTransfers(armToken),
    [armToken],
  );

  // Auto-pick the first profile / section.
  React.useEffect(() => {
    if (profiles.data && profiles.data.length > 0 && !profileName) {
      setProfileName(profiles.data[0]!.name);
    }
  }, [profiles.data, profileName]);
  React.useEffect(() => {
    if (sections.data && sections.data.length > 0 && !sectionName) {
      setSectionName(sections.data[0]!.name);
    }
    if (sections.data && !sections.data.some((s) => s.name === sectionName)) {
      setSectionName(sections.data?.[0]?.name ?? "");
    }
  }, [sections.data, sectionName]);

  const [recipient, setRecipient] = React.useState("");
  const [reseller, setReseller] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [confirmCreate, setConfirmCreate] = React.useState(false);
  const [pendingInbound, setPendingInbound] = React.useState<{
    transfer: InboundTransfer;
    action: "accept" | "decline";
  } | null>(null);
  const [inboundBusyId, setInboundBusyId] = React.useState<string | null>(null);

  // Per-status counts surface "how many pending invites are out there"
  // at a glance so an EA admin doesn't need to scroll the list.
  const outboundCounts = React.useMemo(() => {
    const list = outbound.data ?? [];
    let pending = 0;
    let accepted = 0;
    let declined = 0;
    let expired = 0;
    for (const t of list) {
      const s = (t.transferStatus ?? "").toLowerCase();
      if (s.includes("pending") || s.includes("inprogress")) pending++;
      else if (s.includes("complete") || s.includes("accept")) accepted++;
      else if (s.includes("decline") || s.includes("reject")) declined++;
      else if (s.includes("expire") || s.includes("cancel")) expired++;
    }
    return { total: list.length, pending, accepted, declined, expired };
  }, [outbound.data]);

  const submitCreate = React.useCallback(async () => {
    if (!profileName || !sectionName || !recipient.trim()) return;
    setConfirmCreate(false);
    const recipientEmail = recipient.trim();
    setCreating(true);
    setCreateError(null);
    try {
      const t = await createOutboundTransfer(
        billingAccountName,
        profileName,
        sectionName,
        recipientEmail,
        reseller.trim() || undefined,
        armToken,
      );
      auditLog.record({
        actor: accountUsername,
        action: "create_outbound_transfer",
        target: recipientEmail,
        status: "success",
        details: { billingAccountName, profileName, sectionName, id: t.id },
      });
      store.addNotification({
        type: "success",
        message: `Transfer invitation created. Expires ${t.expirationTime?.slice(0, 10) ?? "soon"}.`,
      });
      setRecipient("");
      setReseller("");
      outbound.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Idempotent: 409 "already invited" is treated as success so a
      // re-run doesn't produce noise. We log to audit either way so
      // the trail captures the (no-op) attempt.
      const isConflict = /(^|\W)(409|conflict|already\s*exists|already\s*invited)(\W|$)/i.test(
        msg,
      );
      if (isConflict) {
        auditLog.record({
          actor: accountUsername,
          action: "create_outbound_transfer",
          target: recipientEmail,
          status: "success",
          details: {
            billingAccountName,
            profileName,
            sectionName,
            note: "already_invited_409",
          },
        });
        store.addNotification({
          type: "info",
          message: `${recipientEmail} already has a pending invite for this section. No change.`,
        });
        setRecipient("");
        setReseller("");
        outbound.reload();
      } else {
        setCreateError(msg);
        auditLog.record({
          actor: accountUsername,
          action: "create_outbound_transfer",
          target: recipientEmail,
          status: "failure",
          error: msg,
          details: { billingAccountName, profileName, sectionName },
        });
      }
    } finally {
      setCreating(false);
    }
  }, [armToken, billingAccountName, profileName, sectionName, recipient, reseller, accountUsername, store, outbound]);

  const runInboundAction = React.useCallback(
    async (transfer: InboundTransfer, action: "accept" | "decline") => {
      setInboundBusyId(transfer.id);
      try {
        if (action === "accept") {
          await acceptInboundTransfer(transfer.id, armToken);
        } else {
          await declineInboundTransfer(transfer.id, armToken);
        }
        auditLog.record({
          actor: accountUsername,
          action: action === "accept" ? "accept_inbound_transfer" : "decline_inbound_transfer",
          target: transfer.name,
          status: "success",
          details: { initiator: transfer.initiatorEmailId },
        });
        store.addNotification({
          type: "success",
          message: `Transfer ${action === "accept" ? "accepted" : "declined"}.`,
        });
        inbound.reload();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditLog.record({
          actor: accountUsername,
          action: action === "accept" ? "accept_inbound_transfer" : "decline_inbound_transfer",
          target: transfer.name,
          status: "failure",
          error: msg,
          details: { initiator: transfer.initiatorEmailId },
        });
        store.addNotification({ type: "error", message: msg });
      } finally {
        setInboundBusyId(null);
        setPendingInbound(null);
      }
    },
    [armToken, accountUsername, store, inbound],
  );

  return (
    <div className="flex flex-col gap-3">
      <TabCard
        title="Outbound transfers"
        description="Initiate ownership transfer of subscriptions / products from this scope to another billing recipient. Per Microsoft.Billing/billingProfiles/{bp}/invoiceSections/{is}/transfers."
        icon={Copy}
        onReload={outbound.reload}
        reloading={outbound.loading}
        action={
          outbound.data && outbound.data.length > 0 ? (
            <ExportMenu<OutboundTransfer>
              rows={outbound.data}
              columns={[
                { header: "Recipient", accessor: (t) => t.recipientEmailId ?? "" },
                { header: "Status", accessor: (t) => t.transferStatus ?? "" },
                { header: "Expiration", accessor: (t) => t.expirationTime ?? "" },
                { header: "Id", accessor: (t) => t.id },
              ]}
              filename={`outbound-transfers-${billingAccountName}`}
            />
          ) : undefined
        }
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Billing profile</Label>
            <Select value={profileName} onValueChange={setProfileName} disabled={!profiles.data?.length}>
              <SelectTrigger>
                <SelectValue placeholder={profiles.loading ? "Loading…" : "Pick a profile"} />
              </SelectTrigger>
              <SelectContent>
                {(profiles.data ?? []).map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Invoice section</Label>
            <Select value={sectionName} onValueChange={setSectionName} disabled={!sections.data?.length}>
              <SelectTrigger>
                <SelectValue placeholder={sections.loading ? "Loading…" : "Pick a section"} />
              </SelectTrigger>
              <SelectContent>
                {(sections.data ?? []).map((s) => (
                  <SelectItem key={s.name} value={s.name}>
                    {s.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label className="text-xs">Recipient email *</Label>
            <Input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="bob@partner.example"
              className="text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Reseller id (optional)</Label>
            <Input
              value={reseller}
              onChange={(e) => setReseller(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
        </div>
        {createError && (
          <Alert variant="destructive">
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button
            type="button"
            onClick={() => setConfirmCreate(true)}
            disabled={creating || !recipient.trim() || !profileName || !sectionName}
            loading={creating}
          >
            {!creating && <Plus />}
            Send transfer invite
          </Button>
        </div>

        {outbound.data && outbound.data.length > 0 && (
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Outbound transfers summary"
          >
            <SummaryStatItem label="Total" value={outboundCounts.total} compact />
            <SummaryStatItem
              label="Pending"
              value={outboundCounts.pending}
              compact
              tone={outboundCounts.pending > 0 ? "warning" : "muted"}
            />
            <SummaryStatItem
              label="Accepted"
              value={outboundCounts.accepted}
              compact
              tone={outboundCounts.accepted > 0 ? "success" : "muted"}
            />
            <SummaryStatItem
              label="Declined"
              value={outboundCounts.declined}
              compact
              tone={outboundCounts.declined > 0 ? "destructive" : "muted"}
            />
            <SummaryStatItem
              label="Expired"
              value={outboundCounts.expired}
              compact
              tone={outboundCounts.expired > 0 ? "warning" : "muted"}
            />
          </div>
        )}

        {outbound.loading ? (
          <SkeletonLoader variant="list" rows={2} />
        ) : outbound.error ? (
          <ErrorState message="Failed to list outbound transfers." detail={outbound.error} size="compact" />
        ) : !outbound.data || outbound.data.length === 0 ? (
          <EmptyState
            icon={Copy}
            title="No outbound transfers"
            description="No transfer invitations have been sent from this billing scope yet."
            size="compact"
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {outbound.data.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
              >
                <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{t.recipientEmailId}</span>
                {t.transferStatus && (
                  <Badge variant="outline" className="text-2xs">{t.transferStatus}</Badge>
                )}
                <span className="ml-auto text-2xs text-muted-foreground">
                  exp {t.expirationTime?.slice(0, 10) ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </TabCard>

      <TabCard
        title="Inbound (recipient) transfers"
        description="Pending transfers visible to the signed-in account. Accept to take ownership; decline to reject."
        icon={UserCheck}
        onReload={inbound.reload}
        reloading={inbound.loading}
        action={
          inbound.data && inbound.data.length > 0 ? (
            <ExportMenu<InboundTransfer>
              rows={inbound.data}
              columns={[
                { header: "Initiator", accessor: (t) => t.initiatorEmailId ?? "" },
                { header: "Status", accessor: (t) => t.transferStatus ?? "" },
                { header: "Expiration", accessor: (t) => t.expirationTime ?? "" },
                { header: "Name", accessor: (t) => t.name },
                { header: "Id", accessor: (t) => t.id },
              ]}
              filename="inbound-transfers"
            />
          ) : undefined
        }
      >
        {inbound.loading ? (
          <SkeletonLoader variant="list" rows={2} />
        ) : inbound.error ? (
          <ErrorState message="Failed to list inbound transfers." detail={inbound.error} size="compact" />
        ) : !inbound.data || inbound.data.length === 0 ? (
          <EmptyState
            icon={UserCheck}
            title="No inbound transfers pending"
            description="You have no transfer invitations awaiting your accept / decline."
            size="compact"
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {inbound.data.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
              >
                <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{t.initiatorEmailId ?? "—"}</span>
                <span className="text-muted-foreground">→ you</span>
                {t.transferStatus && (
                  <Badge variant="outline" className="text-2xs">{t.transferStatus}</Badge>
                )}
                <span className="text-2xs text-muted-foreground">
                  exp {t.expirationTime?.slice(0, 10) ?? "—"}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="h-6 text-2xs focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={inboundBusyId === t.id}
                    loading={inboundBusyId === t.id && pendingInbound?.action === "accept"}
                    onClick={() => setPendingInbound({ transfer: t, action: "accept" })}
                    aria-label={`Accept transfer from ${t.initiatorEmailId ?? "sender"}`}
                  >
                    Accept
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-2xs focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={inboundBusyId === t.id}
                    loading={inboundBusyId === t.id && pendingInbound?.action === "decline"}
                    onClick={() => setPendingInbound({ transfer: t, action: "decline" })}
                    aria-label={`Decline transfer from ${t.initiatorEmailId ?? "sender"}`}
                  >
                    Decline
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </TabCard>
      <ConfirmationDialog
        hidden={!pendingInbound}
        title={
          pendingInbound?.action === "accept"
            ? "Accept inbound transfer"
            : "Decline inbound transfer"
        }
        message={`${pendingInbound?.action === "accept" ? "Accept" : "Decline"} transfer from ${
          pendingInbound?.transfer.initiatorEmailId ?? "sender"
        }?`}
        confirmText={pendingInbound?.action === "accept" ? "Accept" : "Decline"}
        cancelText="Cancel"
        danger={pendingInbound?.action === "decline"}
        loading={inboundBusyId === pendingInbound?.transfer.id}
        onConfirm={() => {
          if (pendingInbound) void runInboundAction(pendingInbound.transfer, pendingInbound.action);
        }}
        onCancel={() => setPendingInbound(null)}
      />
      <ConfirmationDialog
        hidden={!confirmCreate}
        title="Send transfer invitation"
        message={
          <div className="space-y-2 text-sm">
            <p>
              Send a billing-ownership transfer invite to{" "}
              <strong className="font-mono">{recipient.trim() || "—"}</strong>?
            </p>
            <p className="text-xs text-muted-foreground">
              They have 14 days to accept. Once accepted, every subscription
              and product currently billed under{" "}
              <strong>{sectionName || "this section"}</strong> moves to their
              billing account. This is reversible only by another transfer.
            </p>
            {recipient.trim() &&
              !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim()) && (
                <p className="text-xs text-warning">
                  <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden />
                  The recipient doesn't look like a valid email — double-check
                  before sending.
                </p>
              )}
          </div>
        }
        confirmText="Send invite"
        cancelText="Cancel"
        loading={creating}
        onConfirm={() => void submitCreate()}
        onCancel={() => setConfirmCreate(false)}
      />
    </div>
  );
};

/* ----- Customization tab — profile PATCH + IS create + custom roles + address ---- */

const CustomizationTab: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  store: ReturnType<typeof useMultiRegionStore>;
}> = ({ armToken, billingAccountName, accountUsername, store }) => {
  return (
    <div className="flex flex-col gap-3">
      <ProfilePatchCard
        armToken={armToken}
        billingAccountName={billingAccountName}
        accountUsername={accountUsername}
        store={store}
      />
      <InvoiceSectionCreateCard
        armToken={armToken}
        billingAccountName={billingAccountName}
        accountUsername={accountUsername}
        store={store}
      />
      <CustomRoleCreateCard
        armToken={armToken}
        billingAccountName={billingAccountName}
        accountUsername={accountUsername}
        store={store}
      />
      <AddressValidateCard armToken={armToken} />
    </div>
  );
};

const ProfilePatchCard: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  store: ReturnType<typeof useMultiRegionStore>;
}> = ({ armToken, billingAccountName, accountUsername, store }) => {
  const profiles = useAsyncLoad<EaBillingProfile[]>(
    () => listBillingProfiles(billingAccountName, armToken),
    [armToken, billingAccountName],
  );
  const [profileName, setProfileName] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [poNumber, setPoNumber] = React.useState("");
  const [emailOptIn, setEmailOptIn] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Track the original (server-side) values so we can compute a diff
  // for the confirmation dialog AND show a "dirty" indicator on Save.
  const originalRef = React.useRef<{
    displayName: string;
    poNumber: string;
    emailOptIn: boolean;
  } | null>(null);

  React.useEffect(() => {
    if (profiles.data && profiles.data.length > 0 && !profileName) {
      const first = profiles.data[0]!;
      setProfileName(first.name);
      setDisplayName(first.displayName);
      originalRef.current = {
        displayName: first.displayName,
        poNumber: "",
        emailOptIn: false,
      };
    }
  }, [profiles.data, profileName]);

  // Recompute originals when the operator switches profile.
  React.useEffect(() => {
    if (!profileName) return;
    const p = (profiles.data ?? []).find((x) => x.name === profileName);
    if (p) {
      setDisplayName(p.displayName);
      originalRef.current = {
        displayName: p.displayName,
        poNumber: "",
        emailOptIn: false,
      };
    }
  }, [profileName, profiles.data]);

  const dirtyDiff = React.useMemo(() => {
    const orig = originalRef.current;
    if (!orig) return [];
    const changes: Array<{ field: string; before: string; after: string }> = [];
    if (displayName.trim() && displayName.trim() !== orig.displayName)
      changes.push({
        field: "Display name",
        before: orig.displayName || "—",
        after: displayName.trim(),
      });
    if (poNumber.trim() && poNumber.trim() !== orig.poNumber)
      changes.push({
        field: "PO number",
        before: orig.poNumber || "—",
        after: poNumber.trim(),
      });
    if (emailOptIn !== orig.emailOptIn)
      changes.push({
        field: "Email invoices",
        before: orig.emailOptIn ? "on" : "off",
        after: emailOptIn ? "on" : "off",
      });
    return changes;
  }, [displayName, poNumber, emailOptIn]);

  const submit = React.useCallback(async () => {
    if (!profileName) return;
    setConfirmOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      await patchBillingProfile(
        billingAccountName,
        profileName,
        {
          displayName: displayName.trim() || undefined,
          poNumber: poNumber.trim() || undefined,
          invoiceEmailOptIn: emailOptIn,
        },
        armToken,
      );
      auditLog.record({
        actor: accountUsername,
        action: "patch_billing_profile",
        target: profileName,
        status: "success",
        details: { displayName, poNumber, emailOptIn },
      });
      store.addNotification({ type: "success", message: "Billing profile updated." });
      profiles.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      auditLog.record({
        actor: accountUsername,
        action: "patch_billing_profile",
        target: profileName,
        status: "failure",
        error: msg,
        details: { displayName, poNumber, emailOptIn },
      });
    } finally {
      setSubmitting(false);
    }
  }, [armToken, billingAccountName, profileName, displayName, poNumber, emailOptIn, accountUsername, store, profiles]);

  return (
    <TabCard
      title="Patch billing profile"
      description="PATCH /billingProfiles/{bp} — edit display name, PO number, invoice email opt-in."
      icon={Sliders}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Billing profile</Label>
          <Select value={profileName} onValueChange={setProfileName} disabled={!profiles.data?.length}>
            <SelectTrigger>
              <SelectValue placeholder={profiles.loading ? "Loading…" : "Pick a profile"} />
            </SelectTrigger>
            <SelectContent>
              {(profiles.data ?? []).map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Display name</Label>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="text-xs" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">PO number</Label>
          <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} className="text-xs" />
        </div>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={emailOptIn} onCheckedChange={(v) => setEmailOptIn(v === true)} />
          <span>Email invoices to billing contacts</span>
        </label>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={submitting || !profileName || dirtyDiff.length === 0}
          loading={submitting}
        >
          {!submitting && <Check />}
          Save profile
        </Button>
        {dirtyDiff.length > 0 && (
          <span className="text-2xs text-warning">
            {dirtyDiff.length} unsaved change{dirtyDiff.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <ConfirmationDialog
        hidden={!confirmOpen}
        title="Patch billing profile"
        message={
          <div className="space-y-2 text-sm">
            <p>
              Apply the following change{dirtyDiff.length === 1 ? "" : "s"} to{" "}
              <strong className="font-mono">{profileName}</strong>?
            </p>
            <ul className="space-y-1 text-xs">
              {dirtyDiff.map((d) => (
                <li
                  key={d.field}
                  className="rounded border border-border bg-card/40 px-2 py-1"
                >
                  <span className="font-semibold">{d.field}:</span>{" "}
                  <span className="text-muted-foreground line-through">{d.before}</span>
                  {" → "}
                  <span className="text-foreground">{d.after}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              This mutates the live billing profile. The change is audited.
            </p>
          </div>
        }
        confirmText="Save"
        cancelText="Cancel"
        loading={submitting}
        onConfirm={() => void submit()}
        onCancel={() => setConfirmOpen(false)}
      />
    </TabCard>
  );
};

const InvoiceSectionCreateCard: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  store: ReturnType<typeof useMultiRegionStore>;
}> = ({ armToken, billingAccountName, accountUsername, store }) => {
  const profiles = useAsyncLoad<EaBillingProfile[]>(
    () => listBillingProfiles(billingAccountName, armToken),
    [armToken, billingAccountName],
  );
  const [profileName, setProfileName] = React.useState("");
  const [name, setName] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // ARM URL segment validation. Section names live in the resource path
  // (.../invoiceSections/{name}) and the EA backend rejects spaces,
  // unicode, and characters outside the slug set.
  const slugError = React.useMemo(() => {
    const v = name.trim();
    if (!v) return null;
    if (v.length > 50) return "Section name must be 50 characters or fewer.";
    if (!/^[A-Za-z0-9._-]+$/.test(v))
      return "Section name must be alphanumerics, '.', '_' or '-' only.";
    return null;
  }, [name]);

  React.useEffect(() => {
    if (profiles.data && profiles.data.length > 0 && !profileName) {
      setProfileName(profiles.data[0]!.name);
    }
  }, [profiles.data, profileName]);

  const submit = React.useCallback(async () => {
    if (!profileName || !name.trim() || !displayName.trim()) return;
    setConfirmOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      await createInvoiceSection(
        billingAccountName,
        profileName,
        name.trim(),
        { displayName: displayName.trim() },
        armToken,
      );
      auditLog.record({
        actor: accountUsername,
        action: "create_invoice_section",
        target: name.trim(),
        status: "success",
        details: { billingAccountName, profileName, displayName },
      });
      store.addNotification({ type: "success", message: `Invoice section "${displayName}" created.` });
      setName("");
      setDisplayName("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Idempotent: 409 means a section with this name already exists.
      // Tell the operator and keep their inputs around so they can
      // pick a different name without retyping displayName.
      const isConflict =
        /(^|\W)(409|conflict|already\s*exists)(\W|$)/i.test(msg);
      if (isConflict) {
        auditLog.record({
          actor: accountUsername,
          action: "create_invoice_section",
          target: name.trim(),
          status: "success",
          details: {
            billingAccountName,
            profileName,
            displayName,
            note: "already_exists_409",
          },
        });
        store.addNotification({
          type: "info",
          message: `Invoice section "${name.trim()}" already exists on this profile.`,
        });
      } else {
        setError(msg);
        auditLog.record({
          actor: accountUsername,
          action: "create_invoice_section",
          target: name.trim(),
          status: "failure",
          error: msg,
          details: { billingAccountName, profileName, displayName },
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [armToken, billingAccountName, profileName, name, displayName, accountUsername, store]);

  return (
    <TabCard
      title="Create invoice section"
      description="PUT /billingProfiles/{bp}/invoiceSections/{name} — useful for cost-tracking on MCA accounts."
      icon={Plus}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Billing profile</Label>
          <Select value={profileName} onValueChange={setProfileName}>
            <SelectTrigger>
              <SelectValue placeholder={profiles.loading ? "Loading…" : "Pick a profile"} />
            </SelectTrigger>
            <SelectContent>
              {(profiles.data ?? []).map((p) => (
                <SelectItem key={p.name} value={p.name}>{p.displayName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="flex items-center gap-1 text-xs">
            Section name (URL segment)
            <InfoTooltip content="Alphanumerics, '.', '_' or '-' only; up to 50 chars. Cannot be renamed after creation — choose carefully." />
          </Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-section-001"
            className={cn(
              "font-mono text-xs",
              slugError && "border-destructive focus-visible:ring-destructive",
            )}
            aria-invalid={!!slugError}
            aria-describedby={slugError ? "invoice-section-slug-error" : undefined}
          />
          {slugError && (
            <span
              id="invoice-section-slug-error"
              className="text-2xs text-destructive"
            >
              {slugError}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Display name</Label>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="text-xs" />
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={
            submitting ||
            !profileName ||
            !name.trim() ||
            !displayName.trim() ||
            !!slugError
          }
          loading={submitting}
        >
          {!submitting && <Plus />}
          Create
        </Button>
      </div>
      <ConfirmationDialog
        hidden={!confirmOpen}
        title="Create invoice section"
        message={
          <div className="space-y-2 text-sm">
            <p>
              Create invoice section{" "}
              <strong className="font-mono">{name.trim() || "—"}</strong> on
              profile{" "}
              <strong className="font-mono">{profileName || "—"}</strong>?
            </p>
            <p className="text-xs text-muted-foreground">
              Display name: <strong>{displayName.trim() || "—"}</strong>. The
              section name cannot be changed later.
            </p>
          </div>
        }
        confirmText="Create"
        cancelText="Cancel"
        loading={submitting}
        onConfirm={() => void submit()}
        onCancel={() => setConfirmOpen(false)}
      />
    </TabCard>
  );
};

const CustomRoleCreateCard: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
  store: ReturnType<typeof useMultiRegionStore>;
}> = ({ armToken, billingAccountName, accountUsername, store }) => {
  const [roleName, setRoleName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [actionsText, setActionsText] = React.useState(
    "Microsoft.Billing/billingAccounts/read",
  );
  const [notActionsText, setNotActionsText] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // Sticky receipt of the last-created role so the operator can copy
  // the GUID into a downstream RBAC grant without scrolling the audit
  // log. Cleared when they start typing a new role name.
  const [lastCreated, setLastCreated] = React.useState<{
    guid: string;
    roleName: string;
  } | null>(null);

  const parseLines = (s: string) =>
    s.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const actionsParsed = React.useMemo(() => parseLines(actionsText), [actionsText]);
  const notActionsParsed = React.useMemo(
    () => parseLines(notActionsText),
    [notActionsText],
  );

  const submit = React.useCallback(async () => {
    if (!roleName.trim()) return;
    setConfirmOpen(false);
    setSubmitting(true);
    setError(null);
    const guid = crypto.randomUUID();
    try {
      await createCustomBillingRoleDefinition(
        billingAccountName,
        guid,
        {
          roleName: roleName.trim(),
          description: description.trim() || undefined,
          permissions: [
            {
              actions: actionsParsed,
              notActions: notActionsParsed,
            },
          ],
        },
        armToken,
      );
      auditLog.record({
        actor: accountUsername,
        action: "create_custom_billing_role",
        target: guid,
        status: "success",
        details: {
          roleName,
          billingAccountName,
          actions: actionsParsed.length,
          notActions: notActionsParsed.length,
        },
      });
      store.addNotification({
        type: "success",
        message: `Custom role "${roleName}" created (${guid}).`,
      });
      setLastCreated({ guid, roleName: roleName.trim() });
      setRoleName("");
      setDescription("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      auditLog.record({
        actor: accountUsername,
        action: "create_custom_billing_role",
        target: guid,
        status: "failure",
        error: msg,
        details: { roleName, billingAccountName },
      });
    } finally {
      setSubmitting(false);
    }
  }, [armToken, billingAccountName, roleName, description, actionsParsed, notActionsParsed, accountUsername, store]);

  return (
    <TabCard
      title="Create custom billing role"
      description="PUT /billingRoleDefinitions/{guid} — define a custom set of actions / notActions at billing scope. We mint the GUID."
      icon={UserPlus}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Role name *</Label>
          <Input
            value={roleName}
            onChange={(e) => {
              setRoleName(e.target.value);
              if (lastCreated) setLastCreated(null);
            }}
            className="text-xs"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} className="text-xs" />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label className="flex items-center gap-1 text-xs">
            Actions (one per line)
            <InfoTooltip content="Each line is a Microsoft.Billing/* action string. Empty lines are dropped." />
            <span className="ml-auto text-2xs text-muted-foreground">
              {actionsParsed.length} action{actionsParsed.length === 1 ? "" : "s"}
            </span>
          </Label>
          <textarea
            value={actionsText}
            onChange={(e) => setActionsText(e.target.value)}
            rows={4}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-2xs"
            aria-label="Actions, one per line"
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label className="flex items-center gap-1 text-xs">
            NotActions (one per line)
            <span className="ml-auto text-2xs text-muted-foreground">
              {notActionsParsed.length} excluded
            </span>
          </Label>
          <textarea
            value={notActionsText}
            onChange={(e) => setNotActionsText(e.target.value)}
            rows={2}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-2xs"
            aria-label="NotActions, one per line"
          />
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {lastCreated && (
        <Alert variant="default" className="text-xs">
          <Check className="h-3.5 w-3.5 text-success" />
          <AlertDescription>
            <div className="flex flex-wrap items-center gap-2">
              <span>
                Created <strong>{lastCreated.roleName}</strong>:
              </span>
              <CopyableText value={lastCreated.guid} mono />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 text-2xs"
                onClick={() => setLastCreated(null)}
              >
                Dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <div>
        <Button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={submitting || !roleName.trim() || actionsParsed.length === 0}
          loading={submitting}
        >
          {!submitting && <Plus />}
          Create custom role
        </Button>
      </div>
      <ConfirmationDialog
        hidden={!confirmOpen}
        title="Create custom billing role"
        message={
          <div className="space-y-2 text-sm">
            <p>
              Create custom role{" "}
              <strong>&ldquo;{roleName.trim() || "—"}&rdquo;</strong> at billing
              account <strong className="font-mono">{billingAccountName}</strong>?
            </p>
            <p className="text-xs text-muted-foreground">
              {actionsParsed.length} action{actionsParsed.length === 1 ? "" : "s"} ·{" "}
              {notActionsParsed.length} notAction
              {notActionsParsed.length === 1 ? "" : "s"} · auto-generated GUID
              identifier.
            </p>
            <p className="text-xs text-warning">
              <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden />
              Custom billing roles are global to this billing account and
              cannot be edited after creation — only re-PUT with the same
              GUID, or deleted.
            </p>
          </div>
        }
        confirmText="Create"
        cancelText="Cancel"
        loading={submitting}
        onConfirm={() => void submit()}
        onCancel={() => setConfirmOpen(false)}
      />
    </TabCard>
  );
};

const AddressValidateCard: React.FC<{ armToken: string }> = ({ armToken }) => {
  const [draft, setDraft] = React.useState<BillingAddress>({
    addressLine1: "",
    city: "",
    region: "",
    postalCode: "",
    country: "US",
  });
  const [result, setResult] = React.useState<AddressValidationResult | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof BillingAddress>(k: K, v: BillingAddress[K]) =>
    setDraft({ ...draft, [k]: v });

  const submit = React.useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const r = await validateBillingAddress(draft, armToken);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [draft, armToken]);

  return (
    <TabCard
      title="Validate billing address"
      description="POST /providers/Microsoft.Billing/validateAddress — sanity-check an address before profile PATCH."
      icon={Shield}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input value={draft.addressLine1 ?? ""} onChange={(e) => set("addressLine1", e.target.value)} placeholder="Address line 1 *" className="text-xs" />
        <Input value={draft.addressLine2 ?? ""} onChange={(e) => set("addressLine2", e.target.value)} placeholder="Address line 2" className="text-xs" />
        <Input value={draft.city ?? ""} onChange={(e) => set("city", e.target.value)} placeholder="City" className="text-xs" />
        <Input value={draft.region ?? ""} onChange={(e) => set("region", e.target.value)} placeholder="Region / state" className="text-xs" />
        <Input value={draft.postalCode ?? ""} onChange={(e) => set("postalCode", e.target.value)} placeholder="Postal code" className="text-xs" />
        <Input value={draft.country ?? ""} onChange={(e) => set("country", e.target.value)} placeholder="Country (ISO-2) *" className="text-xs" />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {result && (
        <Alert variant={result.status === "Valid" ? "default" : "destructive"}>
          <AlertDescription>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {result.status === "Valid" ? (
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                ) : (
                  <AlertTriangle
                    className="h-3.5 w-3.5 text-destructive"
                    aria-hidden
                  />
                )}
                <strong>{result.status}</strong>
                {result.validationMessage && (
                  <span className="text-2xs">— {result.validationMessage}</span>
                )}
              </div>
              {result.suggestedAddresses &&
                result.suggestedAddresses.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-2xs uppercase tracking-wider text-muted-foreground">
                      Suggested {result.suggestedAddresses.length === 1 ? "address" : "addresses"}
                    </span>
                    <ul className="flex flex-col gap-1">
                      {result.suggestedAddresses.map((addr, i) => (
                        <li
                          key={i}
                          className="flex flex-wrap items-start justify-between gap-2 rounded border border-border bg-card/40 p-2"
                        >
                          <div className="flex flex-col gap-0.5 text-2xs">
                            {addr.addressLine1 && <span>{addr.addressLine1}</span>}
                            {addr.addressLine2 && <span>{addr.addressLine2}</span>}
                            <span>
                              {[addr.city, addr.region, addr.postalCode]
                                .filter(Boolean)
                                .join(", ")}
                            </span>
                            {addr.country && <span>{addr.country}</span>}
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 text-2xs"
                            onClick={() => setDraft({ ...draft, ...addr })}
                            aria-label="Apply suggested address to form"
                            title="Replace the form values with this suggestion"
                          >
                            Apply
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          </AlertDescription>
        </Alert>
      )}
      <div>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !draft.addressLine1?.trim() || !draft.country?.trim()}
          loading={submitting}
        >
          {!submitting && <Check />}
          Validate
        </Button>
      </div>
    </TabCard>
  );
};

/* ----- Cost Management query (Round-2 #9) -------------------------- */

const COST_TIMEFRAMES = [
  { value: "MonthToDate", label: "Month to date" },
  { value: "BillingMonthToDate", label: "Billing month to date" },
  { value: "TheLastMonth", label: "Last month" },
  { value: "TheLastBillingMonth", label: "Last billing month" },
  { value: "WeekToDate", label: "Week to date" },
] as const;

const COST_GRANULARITIES = ["None", "Daily", "Monthly"] as const;
const COST_TYPES = ["ActualCost", "AmortizedCost", "Usage"] as const;

const CostTab: React.FC<{
  armToken: string;
  billingAccountName: string;
  accountUsername: string;
}> = ({ armToken, billingAccountName, accountUsername }) => {
  const scope = `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}`;
  const [timeframe, setTimeframe] = React.useState<CostQueryBody["timeframe"]>(
    "BillingMonthToDate",
  );
  const [groupBy, setGroupBy] = React.useState<string>("ServiceName");
  const [granularity, setGranularity] = React.useState<"None" | "Daily" | "Monthly">("None");
  const [type, setType] = React.useState<CostQueryBody["type"]>("ActualCost");
  const [result, setResult] = React.useState<CostQueryResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Best-effort detection of the "cost" and "currency" columns so we
  // can render a sortable, summable view. Cost Management returns column
  // metadata with `name` like "PreTaxCost" or "Cost" — we pick the
  // first numeric column whose name contains "cost".
  const { costColumnIndex, currencyColumnIndex, totals } = React.useMemo(() => {
    if (!result) {
      return { costColumnIndex: -1, currencyColumnIndex: -1, totals: 0 };
    }
    const ci = result.columns.findIndex(
      (c) =>
        c.type === "Number" &&
        /cost|amount|value|charge/i.test(c.name),
    );
    const cci = result.columns.findIndex(
      (c) => /currency/i.test(c.name) && c.type === "String",
    );
    let sum = 0;
    if (ci >= 0) {
      for (const row of result.rows) {
        const v = row[ci];
        if (typeof v === "number" && Number.isFinite(v)) sum += v;
      }
    }
    return {
      costColumnIndex: ci,
      currencyColumnIndex: cci,
      totals: sum,
    };
  }, [result]);

  const detectedCurrency = React.useMemo(() => {
    if (!result || currencyColumnIndex < 0) return "";
    for (const row of result.rows) {
      const v = row[currencyColumnIndex];
      if (typeof v === "string" && v) return v;
    }
    return "";
  }, [result, currencyColumnIndex]);

  const run = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    // Defensive validation — the selects are typed but a future refactor
    // (URL-restored state, paste-from-clipboard) could push an invalid value.
    if (timeframe && !COST_TIMEFRAMES.some((t) => t.value === timeframe)) {
      setError(`Invalid timeframe "${timeframe}". Pick one of: ${COST_TIMEFRAMES.map((t) => t.value).join(", ")}.`);
      setLoading(false);
      return;
    }
    if (!COST_GRANULARITIES.includes(granularity)) {
      setError(`Invalid granularity "${granularity}". Pick one of: ${COST_GRANULARITIES.join(", ")}.`);
      setLoading(false);
      return;
    }
    if (type && !COST_TYPES.includes(type as (typeof COST_TYPES)[number])) {
      setError(`Invalid cost type "${type}". Pick one of: ${COST_TYPES.join(", ")}.`);
      setLoading(false);
      return;
    }
    if (!groupBy.trim()) {
      setError("Group-by dimension is required.");
      setLoading(false);
      return;
    }
    try {
      const body: CostQueryBody = {
        type,
        timeframe,
        dataset: {
          granularity,
          aggregation: {
            totalCost: { name: "Cost", function: "Sum" },
          },
          grouping: [{ type: "Dimension", name: groupBy }],
        },
      };
      const r = await queryCostManagement(scope, body, armToken);
      setResult(r);
      auditLog.record({
        actor: accountUsername,
        action: "cost_management_query",
        target: scope,
        status: "success",
        details: { type, timeframe, granularity, groupBy, rows: r.rows.length },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      auditLog.record({
        actor: accountUsername,
        action: "cost_management_query",
        target: scope,
        status: "failure",
        error: msg,
        details: { type, timeframe, granularity, groupBy },
      });
    } finally {
      setLoading(false);
    }
  }, [scope, armToken, type, timeframe, groupBy, granularity, accountUsername]);

  return (
    <TabCard
      title="Cost Management query"
      description={`POST /providers/Microsoft.CostManagement/query (scope: ${scope}). Aggregate spend by dimension over a timeframe.`}
      icon={Gauge}
      action={
        <InfoTooltip
          content={
            <div className="space-y-1 text-xs leading-relaxed">
              <p>
                <strong>Billing scope</strong> — the ARM path used to scope the cost
                query. Billing-account scope shows every charge across all
                subscriptions on the EA / MCA enrollment.
              </p>
              <p className="font-mono text-2xs">{scope}</p>
            </div>
          }
          ariaLabel="What is billing scope?"
        />
      }
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Type</Label>
          <Select value={type ?? "ActualCost"} onValueChange={(v) => setType(v as CostQueryBody["type"])}>
            <SelectTrigger><SelectValue placeholder="Select cost type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ActualCost">Actual Cost</SelectItem>
              <SelectItem value="AmortizedCost">Amortized Cost</SelectItem>
              <SelectItem value="Usage">Usage</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Timeframe</Label>
          <Select value={timeframe ?? "BillingMonthToDate"} onValueChange={(v) => setTimeframe(v as CostQueryBody["timeframe"])}>
            <SelectTrigger><SelectValue placeholder="Select timeframe" /></SelectTrigger>
            <SelectContent>
              {COST_TIMEFRAMES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Granularity</Label>
          <Select value={granularity} onValueChange={(v) => setGranularity(v as "None" | "Daily" | "Monthly")}>
            <SelectTrigger><SelectValue placeholder="Select granularity" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="None">None</SelectItem>
              <SelectItem value="Daily">Daily</SelectItem>
              <SelectItem value="Monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Group by dimension</Label>
          <Select value={groupBy} onValueChange={setGroupBy}>
            <SelectTrigger><SelectValue placeholder="Select dimension" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ServiceName">ServiceName</SelectItem>
              <SelectItem value="ResourceGroupName">ResourceGroupName</SelectItem>
              <SelectItem value="SubscriptionId">SubscriptionId</SelectItem>
              <SelectItem value="ResourceLocation">ResourceLocation</SelectItem>
              <SelectItem value="MeterCategory">MeterCategory</SelectItem>
              <SelectItem value="ChargeType">ChargeType</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Button type="button" onClick={() => void run()} disabled={loading} loading={loading}>
          {!loading && <Gauge />}
          Run query
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {result && (
        <div className="flex flex-col gap-2">
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Cost query summary"
          >
            <SummaryStatItem
              label="Rows"
              value={result.rows.length}
              compact
            />
            {costColumnIndex >= 0 && (
              <SummaryStatItem
                label="Total cost"
                value={`${totals.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })} ${detectedCurrency}`}
                compact
                tone="info"
              />
            )}
            <div className="ml-auto">
              <ExportMenu<readonly (string | number)[]>
                rows={result.rows}
                columns={result.columns.map((col, idx) => ({
                  header: col.name,
                  accessor: (row: readonly (string | number)[]) => {
                    const v = row[idx];
                    return typeof v === "number" || typeof v === "string"
                      ? v
                      : "";
                  },
                }))}
                filename={`ea-cost-${billingAccountName}-${timeframe}-${groupBy}`}
                rowCount={result.rows.length}
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-2xs">
              <thead>
                <tr className="border-b border-border">
                  {result.columns.map((c) => (
                    <th key={c.name} className="px-2 py-1 text-left font-medium">
                      {c.name}
                      <span className="ml-1 text-muted-foreground">({c.type})</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(0, 200).map((row, ri) => (
                  <tr key={ri} className="border-b border-border/40 hover:bg-muted/20">
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        className={cn(
                          "px-2 py-1 font-mono",
                          ci === costColumnIndex && "text-right font-semibold",
                        )}
                      >
                        {typeof cell === "number"
                          ? cell.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {costColumnIndex >= 0 && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                    {result.columns.map((_, ci) => (
                      <td key={ci} className="px-2 py-1 font-mono">
                        {ci === 0
                          ? "Total"
                          : ci === costColumnIndex
                            ? totals.toLocaleString(undefined, {
                                maximumFractionDigits: 2,
                              })
                            : ci === currencyColumnIndex
                              ? detectedCurrency
                              : ""}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
            {result.rows.length > 200 && (
              <p className="mt-2 text-2xs text-muted-foreground">
                Truncated to first 200 of {result.rows.length} rows. Total above
                is computed from the full result set.
              </p>
            )}
          </div>
        </div>
      )}
    </TabCard>
  );
};

// Re-export icons we imported but don't reference inline, to silence
// the linter "no-unused-import" rule in case the design later adds them.
export const _EaMgrIcons = { AlertTriangle, ChevronRight, Users, cn };
