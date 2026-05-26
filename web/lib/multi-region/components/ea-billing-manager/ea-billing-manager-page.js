import { __awaiter } from "tslib";
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
import { useSearchParams } from "react-router-dom";
// COORDINATOR: canonical navigation contract — use `navigateToPage` from
// `useDashboardOutletContext()` (path-based) instead of `useNavigate`
// directly. This keeps every page funneled through the page-router's
// wrapper so a future swap of router implementation is one-edit.
import { AlertTriangle, BadgeCheck, Building2, Check, ChevronRight, Copy, Crown, Database, Eye, ExternalLink, FileText, Gauge, Info, Key, Layers, Loader2, Network, Plus, Receipt, RefreshCw, Search, Server, Shield, ShieldCheck, Sliders, Sparkles, Trash2, UserCheck, UserPlus, Users, Wand2, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { decodeJwtClaimsUnsafe, getActiveTenant, getArmTokenForAccount, getGraphTokenForAccount, } from "../../auth/msal-auth";
import { withPassthroughRecovery } from "../../auth/passthrough-recovery";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { auditLog } from "../../services/audit-log";
import { listEaBillingAccounts, listEaAgreements, listEaBillingPermissions, listEaDepartments, listEaBillingSubscriptions, listEaInvoices, listEnrollmentAccounts, listReservationOrders, getEaBillingPolicy, updateEaBillingPolicy, listBillingRoleAssignments, listBillingRoleDefinitions, createBillingRoleAssignment, deleteBillingRoleAssignment, getBillingProperty, EA_BILLING_ROLE_NAMES, findUserByUpnOrMail, getPrincipalsByIds, listBillingProfiles, listInvoiceSections, 
// Round-2 endpoints:
listEaTransactions, listOutboundTransfers, createOutboundTransfer, listInboundTransfers, acceptInboundTransfer, declineInboundTransfer, patchBillingProfile, createInvoiceSection, createCustomBillingRoleDefinition, moveBillingSubscription, cancelBillingSubscription, validateBillingAddress, queryCostManagement, } from "../../services";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText, CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SignInRequired } from "../shared/sign-in-required";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { useArmToken } from "../../auth/use-arm-token";
import { useBeforeUnload } from "../../hooks/use-before-unload";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useDashboardOutletContext } from "../page-router";
// Local-folder modules (extracted for testability / locality of reasoning):
//   cost-anomaly-detector — pure helpers + corpus citation (`_bypass_role_grant.md`).
//   billing-scope-watcher — fingerprint+diff snapshots for sub-transfer detection
//                           (corpus: `_ea_subscription_cross_tenant.md`).
//   cost-report-templates — persisted named filter presets.
import { detectCostAnomalies, correlateAnomaliesWithRoleGrants, forecastBudget, } from "./cost-anomaly-detector";
import { detectScopeChanges, loadScopeSnapshot, saveScopeSnapshot, decodeFingerprint, } from "./billing-scope-watcher";
import { upsertTemplate, removeTemplate, templateIdFromName, migrateTemplates, EMPTY_TEMPLATES_STATE, } from "./cost-report-templates";
const STORAGE_ACCOUNT = "ea-billing-manager:account";
const STORAGE_BILLING_ACCOUNT = "ea-billing-manager:billing-account";
const STORAGE_TAB = "ea-billing-manager:tab";
const TABS = [
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
// ============================================================================
// Page component
// ============================================================================
export const EaBillingManagerPage = () => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    // Path-based navigation via the dashboard outlet's helper — keeps
    // cross-page links funnelled through one router shim instead of
    // each page calling `useNavigate` directly.
    const { navigateToPage } = useDashboardOutletContext();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    /* ----- Account + billing account pickers ------------------------- */
    const candidates = React.useMemo(() => azureAccounts
        .map((a) => {
        var _a, _b;
        return ({
            homeAccountId: a.homeAccountId,
            tenantId: (_b = (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : resolveActiveTenantId(a)) !== null && _b !== void 0 ? _b : a.tenantId,
            username: a.username,
            name: a.name || a.username,
        });
    })
        .filter((a) => !!a.tenantId), [azureAccounts]);
    const [accountId, setAccountIdState] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_ACCOUNT)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    const setAccountId = React.useCallback((id) => {
        setAccountIdState(id);
        try {
            sessionStorage.setItem(STORAGE_ACCOUNT, id);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    React.useEffect(() => {
        if (candidates.length === 0)
            return;
        if (!candidates.some((c) => c.homeAccountId === accountId)) {
            setAccountId(candidates[0].homeAccountId);
        }
    }, [candidates, accountId, setAccountId]);
    const account = React.useMemo(() => { var _a; return (_a = candidates.find((c) => c.homeAccountId === accountId)) !== null && _a !== void 0 ? _a : null; }, [candidates, accountId]);
    /* ----- ARM token + EA billing accounts --------------------------- */
    const [armToken, setArmToken] = React.useState(null);
    // Centralized ARM-token tracker: handles tenant switches + auto-
    // refresh before expiry + per-second expiry tick for the badge.
    // The legacy `armToken` state is kept for downstream tab props and
    // is kept in sync via the effect below.
    const armTokenTracker = useArmToken(account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId);
    React.useEffect(() => {
        if (armTokenTracker.token && armTokenTracker.token !== armToken) {
            setArmToken(armTokenTracker.token);
        }
    }, [armTokenTracker.token, armToken]);
    const [billingAccounts, setBillingAccounts] = React.useState([]);
    const [baLoading, setBaLoading] = React.useState(false);
    const [baError, setBaError] = React.useState(null);
    const [billingAccountName, setBillingAccountNameState] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_BILLING_ACCOUNT)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    const setBillingAccountName = React.useCallback((name) => {
        setBillingAccountNameState(name);
        try {
            sessionStorage.setItem(STORAGE_BILLING_ACCOUNT, name);
        }
        catch (_a) {
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
        (() => __awaiter(void 0, void 0, void 0, function* () {
            try {
                // Tenant arg omitted so we pick up the operator's current active
                // tenant (was pinning to account.tenantId / the account's HOME
                // tenant — pre-switch).
                const tok = yield getArmTokenForAccount(account.homeAccountId);
                if (cancelled)
                    return;
                setArmToken(tok);
                const list = yield listEaBillingAccounts(tok);
                if (cancelled)
                    return;
                setBillingAccounts(list);
                if (list.length === 1 && billingAccountName !== list[0].name) {
                    setBillingAccountName(list[0].name);
                }
                else if (billingAccountName &&
                    !list.some((b) => b.name === billingAccountName)) {
                    setBillingAccountName("");
                }
            }
            catch (err) {
                if (cancelled)
                    return;
                setBaError(err instanceof Error ? err.message : String(err));
                setBillingAccounts([]);
            }
            finally {
                if (!cancelled)
                    setBaLoading(false);
            }
        }))();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId]);
    /* ----- Tab selection (?tab= URL + sessionStorage) --------------- */
    const [searchParams, setSearchParams] = useSearchParams();
    const urlTab = searchParams.get("tab");
    const isValidTab = (v) => !!v && TABS.some((t) => t.key === v);
    const [tab, setTabState] = React.useState(() => {
        if (isValidTab(urlTab))
            return urlTab;
        try {
            const stored = sessionStorage.getItem(STORAGE_TAB);
            if (isValidTab(stored))
                return stored;
        }
        catch (_a) {
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
    const setTab = React.useCallback((next) => {
        // Optimistic local-state update; URL follows asynchronously. The
        // URL-sync effect above will reconcile if router state races
        // ahead with browser nav.
        setTabState(next);
        try {
            sessionStorage.setItem(STORAGE_TAB, next);
        }
        catch (_a) {
            /* ignore */
        }
        setSearchParams((prev) => {
            const params = new URLSearchParams(prev);
            params.set("tab", next);
            return params;
        }, { replace: true });
    }, [setSearchParams]);
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
        if (!candidates.some((c) => c.homeAccountId === candidate))
            return;
        if (accountId === candidate)
            return;
        setAccountIdState(candidate);
        try {
            sessionStorage.setItem(STORAGE_ACCOUNT, candidate);
        }
        catch (_a) {
            /* ignore */
        }
    });
    /* ----- Empty / loading states ------------------------------------ */
    if (candidates.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "EA Billing Manager", description: "Inspect and mutate every EA billing-account-scope endpoint exposed by Microsoft.Billing." }),
            React.createElement(SignInRequired, { whatYouCantDo: "Manage EA billing", why: "an EA-billing-capable account (enrollment owner / department admin)", onNavigate: (k) => navigateToPage(`/${k}`) })));
    }
    const renderHeader = () => (React.createElement(React.Fragment, null,
        React.createElement(PageHeader, { title: "EA Billing Manager", description: "Inspect and mutate every EA billing-account-scope endpoint exposed by Microsoft.Billing." },
            React.createElement("div", { className: "flex items-center gap-2" },
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-8 text-xs", onClick: refreshAll, disabled: !billingAccountName || !armToken, title: "Reload every tab against the current billing account", "aria-label": "Refresh all tabs" },
                    React.createElement(RefreshCw, { className: "h-3.5 w-3.5" }),
                    "Refresh all"),
                React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                        loginHint: account === null || account === void 0 ? void 0 : account.username,
                    }) }))),
        React.createElement(Card, null,
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Crown, { className: "h-4 w-4 text-primary" }),
                    "Scope"),
                React.createElement(CardDescription, null, "Pick the signed-in account (its ARM token does every call) and the EA billing account you want to manage.")),
            React.createElement(CardContent, { className: "grid grid-cols-1 gap-3 sm:grid-cols-2" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { htmlFor: "ea-mgr-acct", className: "text-xs" }, "Source account"),
                    React.createElement(Select, { value: accountId, onValueChange: setAccountId },
                        React.createElement(SelectTrigger, { id: "ea-mgr-acct" },
                            React.createElement(SelectValue, { placeholder: "Pick an account" })),
                        React.createElement(SelectContent, null, candidates.map((c) => {
                            var _a;
                            return (React.createElement(SelectItem, { key: c.homeAccountId, value: c.homeAccountId },
                                React.createElement("span", { className: "flex flex-col" },
                                    React.createElement("span", { className: "text-sm" }, c.name),
                                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                        c.username,
                                        " \u00B7 tenant",
                                        " ",
                                        ((_a = c.tenantId) !== null && _a !== void 0 ? _a : "unknown").slice(0, 8),
                                        "\u2026"))));
                        })))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { htmlFor: "ea-mgr-ba", className: "text-xs" }, "Billing account"),
                    baLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                        React.createElement(Loader2, { className: "h-3 w-3 animate-spin" }),
                        "Loading EA billing accounts\u2026")) : baError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load billing accounts.", detail: baError, onRetry: () => setAccountId(accountId) })) : billingAccounts.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No EA billing accounts visible to this signed-in account.")) : (React.createElement(Select, { value: billingAccountName, onValueChange: setBillingAccountName },
                        React.createElement(SelectTrigger, { id: "ea-mgr-ba" },
                            React.createElement(SelectValue, { placeholder: "Pick a billing account" })),
                        React.createElement(SelectContent, null, billingAccounts.map((b) => (React.createElement(SelectItem, { key: b.name, value: b.name },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, b.displayName),
                                React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                                    b.name,
                                    " \u00B7 ",
                                    b.agreementType)))))))))))));
    const renderTabs = () => (React.createElement("div", { className: "flex flex-wrap gap-1 border-b border-border pb-1", role: "tablist", "aria-label": "EA Billing Manager sections" }, TABS.map(({ key, label, icon: Icon }) => (React.createElement(Button, { key: key, type: "button", variant: tab === key ? "default" : "ghost", size: "sm", className: "h-8 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1", onClick: () => setTab(key), role: "tab", "aria-selected": tab === key, "aria-current": tab === key ? "page" : undefined, "aria-label": `${label} tab` },
        React.createElement(Icon, { className: "h-3.5 w-3.5" }),
        label)))));
    if (!billingAccountName || !armToken) {
        return (React.createElement("div", { className: "flex flex-col gap-4 py-2" },
            renderHeader(),
            React.createElement(EmptyState, { icon: Crown, title: "Pick a billing account", description: "Every tab below operates on the chosen EA billing account. Select one above to load its data." })));
    }
    // Tab-key suffix used to force every active tab to remount on
    // "Refresh all" or a billing-account switch. Includes the billing
    // account name so per-tab in-flight loaders against the OLD account
    // can never resolve into the NEW account's view.
    const remountKey = `${billingAccountName}::${refreshKey}`;
    return (React.createElement("div", { className: "flex flex-col gap-4 py-2" },
        renderHeader(),
        renderTabs(),
        tab === "overview" && (React.createElement(OverviewTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName, billingAccount: (_b = billingAccounts.find((b) => b.name === billingAccountName)) !== null && _b !== void 0 ? _b : null, homeAccountId: (_c = account === null || account === void 0 ? void 0 : account.homeAccountId) !== null && _c !== void 0 ? _c : "", tenantId: account === null || account === void 0 ? void 0 : account.tenantId, onTokenRecovered: () => {
                var _a;
                // Bubble the fact that a passthrough-401 just got auto-
                // healed up to the operator. We don't refresh other tabs
                // pre-emptively — they'll silently auto-recover the next
                // time they hit one.
                store.addNotification({
                    type: "info",
                    message: "Re-acquired ARM token after passthrough 401 and retried.",
                });
                auditLog.record({
                    actor: (_a = account === null || account === void 0 ? void 0 : account.username) !== null && _a !== void 0 ? _a : "",
                    action: "auto_recover_passthrough_token",
                    target: billingAccountName,
                    status: "success",
                    details: {
                        page: "ea-billing-manager",
                        tab: "overview",
                    },
                });
            } })),
        tab === "permissions" && (React.createElement(PermissionsTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName })),
        tab === "roles" && (React.createElement(RoleAssignmentsTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName, accountUsername: (_d = account === null || account === void 0 ? void 0 : account.username) !== null && _d !== void 0 ? _d : "", tenantId: (_e = account === null || account === void 0 ? void 0 : account.tenantId) !== null && _e !== void 0 ? _e : "", homeAccountId: (_f = account === null || account === void 0 ? void 0 : account.homeAccountId) !== null && _f !== void 0 ? _f : "", store: store })),
        tab === "departments" && (React.createElement(DepartmentsTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName, onDrillDown: (deptName) => {
                var _a;
                // Drill-down: route to the Department Admin workspace so the
                // operator can manage account owners / EAs inside this dept.
                // We log the navigation so the audit trail captures the
                // explicit decision to leave the manager page.
                auditLog.record({
                    actor: (_a = account === null || account === void 0 ? void 0 : account.username) !== null && _a !== void 0 ? _a : "",
                    action: "drill_down_department",
                    target: deptName,
                    status: "success",
                    details: {
                        page: "ea-billing-manager",
                        billingAccountName,
                        navigatedTo: "/department-admin",
                    },
                });
                navigateToPage("/department-admin");
            } })),
        tab === "enrollment" && (React.createElement(EnrollmentAccountsTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName })),
        tab === "subscriptions" && (React.createElement(SubscriptionsTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName, accountUsername: (_g = account === null || account === void 0 ? void 0 : account.username) !== null && _g !== void 0 ? _g : "", store: store })),
        tab === "invoices" && (React.createElement(InvoicesTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName })),
        tab === "transactions" && (React.createElement(TransactionsTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName })),
        tab === "transfers" && (React.createElement(TransfersTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName, accountUsername: (_h = account === null || account === void 0 ? void 0 : account.username) !== null && _h !== void 0 ? _h : "", store: store })),
        tab === "reservations" && (React.createElement(ReservationsTab, { key: remountKey, armToken: armToken })),
        tab === "policies" && (React.createElement(PoliciesTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName, accountUsername: (_j = account === null || account === void 0 ? void 0 : account.username) !== null && _j !== void 0 ? _j : "", store: store })),
        tab === "customization" && (React.createElement(CustomizationTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName, accountUsername: (_k = account === null || account === void 0 ? void 0 : account.username) !== null && _k !== void 0 ? _k : "", store: store })),
        tab === "cost" && (React.createElement(CostTab, { key: remountKey, armToken: armToken, billingAccountName: billingAccountName, accountUsername: (_l = account === null || account === void 0 ? void 0 : account.username) !== null && _l !== void 0 ? _l : "" }))));
};
const ROLE_META = {
    // GUIDs are lower-cased to match the keys used by EA_BILLING_ROLE_NAMES.
    "9f1983cb-2574-400c-87e9-34cf8e2280db": {
        icon: Crown,
        tone: "destructive",
        summary: "Enterprise Administrator — full control of the enrollment. Can grant any other EA role, view all billing data, and manage departments + account owners.",
        precedence: 0,
    },
    "0b5ed2f2-bb18-4c38-b0c4-dd75e9bd4de2": {
        icon: Eye,
        tone: "outline",
        summary: "Enterprise Administrator (read only) — sees everything an Enterprise Admin sees but cannot make changes.",
        precedence: 1,
        readOnly: true,
    },
    "c15c22c0-9faf-424c-9b7e-bd91c06a240b": {
        icon: ShieldCheck,
        tone: "warning",
        summary: "EA Account Owner — owns one or more EA accounts under the enrollment. Can create subscriptions in their accounts and view billing for their portion.",
        precedence: 2,
    },
    "a0bcee42-bf30-4d1b-926a-48d21664ef71": {
        icon: Sparkles,
        tone: "info",
        summary: "EA Subscription Creator — minimum role needed to create new Azure subscriptions on an enrollment account. Cannot manage billing or other principals.",
        precedence: 3,
    },
    "db609904-a47f-4794-9be8-9bd86fbffd8a": {
        icon: Building2,
        tone: "success",
        summary: "Department Administrator — manages account owners within a department, sees department-scoped billing, and can create departments under the enrollment.",
        precedence: 4,
    },
    "4e3a1b3b-a2df-44b5-bdfa-9d1d4e4a3cba": {
        icon: Eye,
        tone: "outline",
        summary: "Department Administrator (read only) — sees department-scoped billing but cannot make changes.",
        precedence: 5,
        readOnly: true,
    },
};
const UNKNOWN_ROLE_META = {
    icon: Key,
    tone: "secondary",
    summary: "Custom or unrecognized billing role. Hover the role GUID below to see Microsoft.Billing's full role definition.",
    precedence: 99,
};
function resolveRoleMeta(roleDefinitionId) {
    var _a, _b;
    const key = (roleDefinitionId !== null && roleDefinitionId !== void 0 ? roleDefinitionId : "").toLowerCase();
    // The roleDefinitionId from ARM is a path; extract the GUID at the end.
    const guidMatch = key.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const guid = (_a = guidMatch === null || guidMatch === void 0 ? void 0 : guidMatch[0]) !== null && _a !== void 0 ? _a : key;
    return (_b = ROLE_META[guid]) !== null && _b !== void 0 ? _b : UNKNOWN_ROLE_META;
}
/**
 * Yes/no capability chip — green check when the signed-in caller holds
 * the privilege, muted X when they don't. Drives the "what can I
 * actually do here" banner at the top of the Roles tab.
 */
const CapabilityBadge = ({ ok, icon: Icon, label, detail }) => (React.createElement("div", { className: cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-2xs", ok
        ? "border-success/40 bg-success/5 text-foreground"
        : "border-border bg-card/40 text-muted-foreground"), title: detail },
    ok ? (React.createElement(Check, { className: "h-3 w-3 text-success", "aria-hidden": true })) : (React.createElement(AlertTriangle, { className: "h-3 w-3 opacity-50", "aria-hidden": true })),
    React.createElement(Icon, { className: "h-3 w-3", "aria-hidden": true }),
    React.createElement("span", { className: "font-semibold" }, label),
    React.createElement("span", { className: "opacity-70" },
        "\u00B7 ",
        detail)));
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
function useAsyncLoad(loader, deps) {
    const [data, setData] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(null);
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
        p.then((result) => {
            if (cancelled || runIdRef.current !== myRunId)
                return;
            setData(result);
            setLoading(false);
        }, (err) => {
            if (cancelled || runIdRef.current !== myRunId)
                return;
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
        });
        return () => {
            cancelled = true;
        };
        // The caller's deps array is the source of truth for invalidation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, tick]);
    return { data, loading, error, reload };
}
const TabCard = ({ title, description, icon: Icon, onReload, reloading, action, children }) => (React.createElement(Card, null,
    React.createElement(CardHeader, { className: "flex flex-row items-start justify-between gap-2 space-y-0 pb-3" },
        React.createElement("div", null,
            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                React.createElement(Icon, { className: "h-4 w-4 text-primary" }),
                title),
            description && React.createElement(CardDescription, null, description)),
        React.createElement("div", { className: "flex items-center gap-1" },
            action,
            onReload && (React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: onReload, disabled: reloading, "aria-label": "Refresh" },
                React.createElement(RefreshCw, { className: reloading ? "animate-spin" : undefined }))))),
    React.createElement(CardContent, { className: "flex flex-col gap-3" }, children)));
// ============================================================================
// Tabs
// ============================================================================
/* ----- Overview ----------------------------------------------------- */
const OverviewTab = ({ armToken, billingAccountName, billingAccount, homeAccountId, tenantId, onTokenRecovered, }) => {
    var _a, _b, _c, _d, _e;
    const prop = useAsyncLoad(() => withPassthroughRecovery((tok) => getBillingProperty(tok), homeAccountId, tenantId, armToken, onTokenRecovered), [armToken, homeAccountId, tenantId]);
    const agreements = useAsyncLoad(() => withPassthroughRecovery((tok) => listEaAgreements(billingAccountName, tok), homeAccountId, tenantId, armToken, onTokenRecovered), [armToken, billingAccountName, homeAccountId, tenantId]);
    return (React.createElement("div", { className: "grid grid-cols-1 gap-4 lg:grid-cols-2" },
        React.createElement(TabCard, { title: "Billing Property (caller identity)", description: "What Microsoft.Billing thinks the signed-in account is currently associated with.", icon: UserCheck, onReload: prop.reload, reloading: prop.loading }, prop.loading ? (React.createElement(SkeletonLoader, { variant: "form", rows: 3 })) : prop.error ? (React.createElement(ErrorState, { message: "Failed to read billingProperty.", detail: prop.error, size: "compact" })) : prop.data ? (React.createElement(DefList, { rows: [
                ["Billing tenant", prop.data.billingTenantId],
                [
                    "Billing account",
                    `${(_a = prop.data.billingAccountDisplayName) !== null && _a !== void 0 ? _a : ""} (${(_b = prop.data.billingAccountId) !== null && _b !== void 0 ? _b : "—"})`,
                ],
                ["Is admin", prop.data.isAdmin === true ? "Yes" : prop.data.isAdmin === false ? "No" : undefined],
                [
                    "Billing profile",
                    (_c = prop.data.billingProfileDisplayName) !== null && _c !== void 0 ? _c : prop.data.billingProfileId,
                ],
                [
                    "Invoice section",
                    (_d = prop.data.invoiceSectionDisplayName) !== null && _d !== void 0 ? _d : prop.data.invoiceSectionId,
                ],
                [
                    "Enrollment account",
                    (_e = prop.data.enrollmentAccountDisplayName) !== null && _e !== void 0 ? _e : prop.data.enrollmentAccountId,
                ],
                ["Cost center", prop.data.costCenter],
                ["Notify email", prop.data.accountAdminNotificationEmailAddress],
            ] })) : null),
        React.createElement(TabCard, { title: "Selected billing account", description: "Raw billingAccount resource from listEaBillingAccounts.", icon: Crown, action: React.createElement(InfoTooltip, { content: React.createElement("div", { className: "space-y-1 text-xs leading-relaxed" },
                    React.createElement("p", null,
                        React.createElement("strong", null, "EA"),
                        " \u2014 legacy Enterprise Agreement with departments and enrollment accounts."),
                    React.createElement("p", null,
                        React.createElement("strong", null, "MCA"),
                        " \u2014 Microsoft Customer Agreement; uses billing profiles + invoice sections."),
                    React.createElement("p", null, "Agreement type drives which sub-resources show up below.")), ariaLabel: "MCA vs EA explanation" }) }, billingAccount ? (React.createElement(DefList, { rows: [
                ["Display name", billingAccount.displayName],
                ["Name", billingAccount.name],
                ["Agreement type", billingAccount.agreementType],
                ["Status", billingAccount.accountStatus],
                ["Type", billingAccount.accountType],
            ] })) : (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No selection."))),
        React.createElement(TabCard, { title: "Agreements", description: "EA / MCA legal documents attached to this billing account.", icon: FileText, onReload: agreements.reload, reloading: agreements.loading, action: agreements.data && agreements.data.length > 0 ? (React.createElement(ExportMenu, { rows: agreements.data, columns: [
                    { header: "Name", accessor: (a) => a.name },
                    { header: "AgreementType", accessor: (a) => { var _a, _b; return (_b = (_a = a.agreementType) !== null && _a !== void 0 ? _a : a.category) !== null && _b !== void 0 ? _b : ""; } },
                    { header: "Status", accessor: (a) => { var _a; return (_a = a.status) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Effective", accessor: (a) => { var _a; return (_a = a.effectiveDate) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Expiration", accessor: (a) => { var _a; return (_a = a.expirationDate) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Id", accessor: (a) => a.id },
                ], filename: `ea-agreements-${billingAccountName}` })) : undefined }, agreements.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 2 })) : agreements.error ? (React.createElement(ErrorState, { message: "Failed to load agreements.", detail: agreements.error, size: "compact" })) : !agreements.data || agreements.data.length === 0 ? (React.createElement(EmptyState, { icon: FileText, title: "No agreements returned", description: "This billing account has no EA / MCA agreements attached, or your account lacks permission to read them.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1.5" }, agreements.data.map((a) => (React.createElement("li", { key: a.id, className: "flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs" },
            React.createElement(FileText, { className: "h-3.5 w-3.5 text-muted-foreground" }),
            React.createElement(CopyableText, { value: a.name, mono: true }),
            React.createElement(Badge, { variant: "outline", className: "text-2xs" }, a.agreementType || a.category || "—"),
            a.status && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, a.status)),
            React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" },
                a.effectiveDate ? `from ${a.effectiveDate.slice(0, 10)}` : "",
                a.expirationDate ? ` · to ${a.expirationDate.slice(0, 10)}` : "")))))))));
};
const DefList = ({ rows }) => (React.createElement("dl", { className: "grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs" }, rows
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => (React.createElement(React.Fragment, { key: k },
    React.createElement("dt", { className: "text-muted-foreground" }, k),
    React.createElement("dd", { className: "break-all font-mono" }, v))))));
/* ----- Permissions -------------------------------------------------- */
const PermissionsTab = ({ armToken, billingAccountName }) => {
    const perm = useAsyncLoad(() => listEaBillingPermissions(billingAccountName, armToken), [armToken, billingAccountName]);
    const [search, setSearch] = React.useState("");
    const merged = React.useMemo(() => {
        if (!perm.data)
            return null;
        const actions = new Set();
        const notActions = new Set();
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
        if (!merged)
            return null;
        const q = search.trim().toLowerCase();
        if (!q)
            return merged;
        const tokens = q.split(/\s+/);
        const match = (s) => {
            const lc = s.toLowerCase();
            return tokens.every((t) => lc.includes(t));
        };
        return {
            actions: merged.actions.filter(match),
            notActions: merged.notActions.filter(match),
        };
    }, [merged, search]);
    return (React.createElement(TabCard, { title: "Billing permissions", description: "Data-plane actions the signed-in account can perform on this billing account.", icon: Shield, onReload: perm.reload, reloading: perm.loading, action: merged ? (React.createElement(ExportMenu, { rows: [
                ...merged.actions.map((v) => ({ kind: "action", value: v })),
                ...merged.notActions.map((v) => ({ kind: "notAction", value: v })),
            ], columns: [
                { header: "Kind", accessor: (r) => r.kind },
                { header: "Action", accessor: (r) => r.value },
            ], filename: `ea-billing-permissions-${billingAccountName}` })) : undefined },
        merged && (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Permissions summary" },
                React.createElement(SummaryStatItem, { label: "Actions", value: merged.actions.length, compact: true, tone: merged.actions.length === 0 ? "muted" : "success" }),
                React.createElement(SummaryStatItem, { label: "NotActions", value: merged.notActions.length, compact: true, tone: merged.notActions.length > 0 ? "warning" : "muted" })),
            React.createElement("div", { className: "relative" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: 'Search e.g. "billing read" \u2014 space-separated terms AND together', className: "pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Filter permission actions" })))),
        perm.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 3 })) : perm.error ? (React.createElement(ErrorState, { message: "Failed to load billingPermissions.", detail: perm.error, size: "compact" })) : !merged || !filtered ? null : (React.createElement("div", { className: "grid grid-cols-1 gap-3 lg:grid-cols-2" },
            React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" },
                    "actions (",
                    filtered.actions.length,
                    search && filtered.actions.length !== merged.actions.length
                        ? ` / ${merged.actions.length}`
                        : "",
                    ")"),
                filtered.actions.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, search
                    ? "No actions match this filter."
                    : "None granted.")) : (React.createElement("ul", { className: "font-mono text-2xs" }, filtered.actions.map((a) => (React.createElement("li", { key: a, className: "group/copy flex items-center gap-1 truncate" },
                    React.createElement("span", { className: "truncate", title: a }, a),
                    React.createElement(CopyButton, { value: a, ariaLabel: `Copy action ${a}` }))))))),
            React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" },
                    "notActions (",
                    filtered.notActions.length,
                    search && filtered.notActions.length !== merged.notActions.length
                        ? ` / ${merged.notActions.length}`
                        : "",
                    ")"),
                filtered.notActions.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, search ? "No exclusions match this filter." : "None excluded.")) : (React.createElement("ul", { className: "font-mono text-2xs" }, filtered.notActions.map((a) => (React.createElement("li", { key: a, className: "group/copy flex items-center gap-1 truncate" },
                    React.createElement("span", { className: "truncate", title: a }, a),
                    React.createElement(CopyButton, { value: a, ariaLabel: `Copy notAction ${a}` })))))))))));
};
/* ----- Role Assignments -------------------------------------------- */
const RoleAssignmentsTab = ({ armToken, billingAccountName, accountUsername, tenantId, homeAccountId, store, }) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const scope = `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}`;
    const assignments = useAsyncLoad(() => listBillingRoleAssignments(scope, armToken), [armToken, scope]);
    const definitions = useAsyncLoad(() => listBillingRoleDefinitions(billingAccountName, armToken), [armToken, billingAccountName]);
    const [search, setSearch] = React.useState("");
    const [selected, setSelected] = React.useState(new Set());
    const [deleting, setDeleting] = React.useState(false);
    const [confirmDelete, setConfirmDelete] = React.useState(false);
    const [roleFilter, setRoleFilter] = React.useState("all");
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
    const [resolvedPrincipals, setResolvedPrincipals] = React.useState({});
    const [resolvingPrincipals, setResolvingPrincipals] = React.useState(false);
    const [resolveCount, setResolveCount] = React.useState(0);
    React.useEffect(() => {
        var _a;
        const list = (_a = assignments.data) !== null && _a !== void 0 ? _a : [];
        if (list.length === 0 || !homeAccountId || !tenantId)
            return;
        const ids = Array.from(new Set(list.map((a) => a.principalId).filter((id) => !!id)));
        // Skip ids we've already resolved. Re-resolve on assignments
        // change only when a new principal appears.
        const unresolved = ids.filter((id) => !(id in resolvedPrincipals));
        if (unresolved.length === 0)
            return;
        let cancelled = false;
        setResolvingPrincipals(true);
        (() => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const graphToken = yield getGraphTokenForAccount(homeAccountId, tenantId);
                const resolved = yield getPrincipalsByIds(tenantId, unresolved, graphToken);
                if (cancelled)
                    return;
                setResolvedPrincipals((prev) => {
                    const next = Object.assign({}, prev);
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
            }
            catch (err) {
                // Best-effort: a 403 on Graph (e.g. caller lacks User.Read.All)
                // shouldn't break the page. Mark the ids as Unknown so we
                // don't retry on every render.
                if (cancelled)
                    return;
                setResolvedPrincipals((prev) => {
                    const next = Object.assign({}, prev);
                    for (const id of unresolved) {
                        if (!(id in next))
                            next[id] = { displayName: id, type: "Unknown" };
                    }
                    return next;
                });
                // eslint-disable-next-line no-console
                console.warn("[ea-billing-manager] Graph principal-resolve failed:", err);
            }
            finally {
                if (!cancelled)
                    setResolvingPrincipals(false);
            }
        }))();
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
        var _a, _b, _c, _d, _e;
        const claims = decodeJwtClaimsUnsafe(armToken);
        if (!claims)
            return { oid: "", tid: "", upn: "" };
        return {
            oid: String((_a = claims.oid) !== null && _a !== void 0 ? _a : ""),
            tid: String((_b = claims.tid) !== null && _b !== void 0 ? _b : ""),
            upn: String((_e = (_d = (_c = claims.upn) !== null && _c !== void 0 ? _c : claims.preferred_username) !== null && _d !== void 0 ? _d : claims.unique_name) !== null && _e !== void 0 ? _e : ""),
        };
    }, [armToken]);
    // Add form.
    const [addMode, setAddMode] = React.useState("single");
    const [addPrincipalId, setAddPrincipalId] = React.useState("");
    const [addPrincipalTenant, setAddPrincipalTenant] = React.useState(tenantId);
    const [addRoleId, setAddRoleId] = React.useState("");
    const [adding, setAdding] = React.useState(false);
    const [addError, setAddError] = React.useState(null);
    /** Bulk-paste textarea — accepts UPNs or object ids, one per line. */
    const [bulkInput, setBulkInput] = React.useState("");
    /** Per-row bulk status. Lives at the component level so the
     *  progress survives the "Grant all" callback's life. */
    const [bulkResults, setBulkResults] = React.useState([]);
    /** UPN-to-oid resolver state. Triggered by the inline "Resolve" button. */
    const [resolvingUpn, setResolvingUpn] = React.useState(false);
    const [resolveError, setResolveError] = React.useState(null);
    React.useEffect(() => {
        setAddPrincipalTenant(tenantId);
    }, [tenantId]);
    React.useEffect(() => {
        var _a;
        if (definitions.data &&
            definitions.data.length > 0 &&
            !definitions.data.some((d) => d.name === addRoleId)) {
            // Default to "EA Subscription Creator" if present, otherwise first.
            const creator = definitions.data.find((d) => {
                var _a, _b;
                return ((_a = d.name) !== null && _a !== void 0 ? _a : "").toLowerCase() ===
                    "a0bcee42-bf30-4d1b-926a-48d21664ef71" ||
                    ((_b = d.roleName) !== null && _b !== void 0 ? _b : "").toLowerCase().includes("subscription creator");
            });
            setAddRoleId((_a = creator === null || creator === void 0 ? void 0 : creator.name) !== null && _a !== void 0 ? _a : definitions.data[0].name);
        }
    }, [definitions.data, addRoleId]);
    const filtered = React.useMemo(() => {
        var _a;
        const list = (_a = assignments.data) !== null && _a !== void 0 ? _a : [];
        const q = search.trim().toLowerCase();
        let result = list;
        // Quick-filter chip pre-screen.
        if (roleFilter !== "all") {
            result = result.filter((a) => {
                var _a;
                const meta = resolveRoleMeta((_a = a.roleDefinitionId) !== null && _a !== void 0 ? _a : "");
                if (roleFilter === "elevated") {
                    // Enterprise Admin (destructive) + Account Owner (warning).
                    return meta.tone === "destructive" || meta.tone === "warning";
                }
                if (roleFilter === "creators") {
                    // Subscription Creator (info) — covers both EA Subscription Creator
                    // and any custom "creator"-style role with the same tone.
                    return meta.tone === "info";
                }
                if (roleFilter === "readonly")
                    return !!meta.readOnly;
                return true;
            });
        }
        if (!q)
            return result;
        return result.filter((a) => {
            var _a, _b, _c, _d;
            // Also search against the resolved directory metadata so the
            // operator can find rows by typing an email / display name
            // instead of having to know the object id.
            const resolved = resolvedPrincipals[(_a = a.principalId) !== null && _a !== void 0 ? _a : ""];
            return [
                a.principalId,
                a.roleDefinitionName,
                a.roleDefinitionId,
                a.scope,
                a.principalTenantId,
                (_b = resolved === null || resolved === void 0 ? void 0 : resolved.displayName) !== null && _b !== void 0 ? _b : "",
                (_c = resolved === null || resolved === void 0 ? void 0 : resolved.signInName) !== null && _c !== void 0 ? _c : "",
                (_d = resolved === null || resolved === void 0 ? void 0 : resolved.type) !== null && _d !== void 0 ? _d : "",
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
        var _a, _b, _c, _d, _e, _f;
        const byGuid = new Map();
        for (const a of filtered) {
            const meta = resolveRoleMeta((_a = a.roleDefinitionId) !== null && _a !== void 0 ? _a : "");
            const guidMatch = ((_b = a.roleDefinitionId) !== null && _b !== void 0 ? _b : "")
                .toLowerCase()
                .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
            const guid = (_c = guidMatch === null || guidMatch === void 0 ? void 0 : guidMatch[0]) !== null && _c !== void 0 ? _c : "unknown";
            const friendly = (_e = (_d = EA_BILLING_ROLE_NAMES[guid]) !== null && _d !== void 0 ? _d : a.roleDefinitionName) !== null && _e !== void 0 ? _e : guid;
            const g = (_f = byGuid.get(guid)) !== null && _f !== void 0 ? _f : {
                guid,
                friendly,
                meta,
                rows: [],
            };
            g.rows.push(a);
            byGuid.set(guid, g);
        }
        return Array.from(byGuid.values()).sort((x, y) => x.meta.precedence - y.meta.precedence);
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
        var _a;
        if (!callerClaims.oid)
            return [];
        const list = (_a = assignments.data) !== null && _a !== void 0 ? _a : [];
        const myOid = callerClaims.oid.toLowerCase();
        return list
            .filter((a) => { var _a; return ((_a = a.principalId) !== null && _a !== void 0 ? _a : "").toLowerCase() === myOid; })
            .map((a) => {
            var _a, _b, _c, _d, _e, _f;
            return ({
                assignment: a,
                meta: resolveRoleMeta((_a = a.roleDefinitionId) !== null && _a !== void 0 ? _a : ""),
                friendly: (_f = (_e = EA_BILLING_ROLE_NAMES[((_d = (_c = ((_b = a.roleDefinitionId) !== null && _b !== void 0 ? _b : "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) === null || _c === void 0 ? void 0 : _c[0]) !== null && _d !== void 0 ? _d : "").toLowerCase()]) !== null && _e !== void 0 ? _e : a.roleDefinitionName) !== null && _f !== void 0 ? _f : "Unknown role",
            });
        })
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
        var _a;
        const guidsHeld = new Set();
        for (const r of myRoles) {
            const g = ((_a = r.assignment.roleDefinitionId) !== null && _a !== void 0 ? _a : "")
                .toLowerCase()
                .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
            if (g === null || g === void 0 ? void 0 : g[0])
                guidsHeld.add(g[0]);
        }
        const has = (guid) => guidsHeld.has(guid.toLowerCase());
        return {
            anyRole: myRoles.length > 0,
            isEnterpriseAdmin: has("9f1983cb-2574-400c-87e9-34cf8e2280db") ||
                has("0b5ed2f2-bb18-4c38-b0c4-dd75e9bd4de2"),
            isAccountOwner: has("c15c22c0-9faf-424c-9b7e-bd91c06a240b"),
            canCreateSubscriptions: has("9f1983cb-2574-400c-87e9-34cf8e2280db") ||
                has("c15c22c0-9faf-424c-9b7e-bd91c06a240b") ||
                has("a0bcee42-bf30-4d1b-926a-48d21664ef71"),
            isDepartmentAdmin: has("db609904-a47f-4794-9be8-9bd86fbffd8a") ||
                has("4e3a1b3b-a2df-44b5-bdfa-9d1d4e4a3cba"),
        };
    }, [myRoles]);
    /**
     * Per-role-tone summary counts for the chip strip — derived from
     * the full assignment set (not the filtered set) so chip counts
     * remain stable as the search box changes.
     */
    const roleCounts = React.useMemo(() => {
        var _a, _b;
        const list = (_a = assignments.data) !== null && _a !== void 0 ? _a : [];
        let elevated = 0;
        let creators = 0;
        let readonly = 0;
        for (const a of list) {
            const meta = resolveRoleMeta((_b = a.roleDefinitionId) !== null && _b !== void 0 ? _b : "");
            if (meta.tone === "destructive" || meta.tone === "warning")
                elevated++;
            else if (meta.tone === "info")
                creators++;
            else if (meta.readOnly)
                readonly++;
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
        if (!callerClaims.oid)
            return;
        setAddMode("single");
        setAddPrincipalId(callerClaims.oid);
        setAddPrincipalTenant(callerClaims.tid || tenantId);
        setAddError(null);
        store.addNotification({
            type: "info",
            message: "Pre-filled with your own object id. Click Grant role to apply.",
        });
    }, [callerClaims, store, tenantId]);
    /**
     * If the principal input looks like a UPN/email rather than a UUID,
     * resolve it to an object id via Graph. Tolerant of @ in the input;
     * falls back to plain text on lookup failure (which makes the Grant
     * button surface a useful AAD error rather than a silent failure).
     */
    const resolveUpn = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        const raw = addPrincipalId.trim();
        if (!raw || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw))
            return; // already a UUID
        setResolvingUpn(true);
        setResolveError(null);
        try {
            const graphToken = yield getGraphTokenForAccount(homeAccountId, tenantId);
            const user = yield findUserByUpnOrMail(tenantId, raw, graphToken);
            if (!user || !user.id) {
                setResolveError(`Microsoft Graph couldn't find a user matching "${raw}" in tenant ${tenantId.slice(0, 8)}…. Either they don't exist yet (invite as a guest first) or you lack User.Read.All.`);
                return;
            }
            setAddPrincipalId(user.id);
            store.addNotification({
                type: "success",
                message: `Resolved ${raw} → ${user.id}`,
            });
        }
        catch (err) {
            setResolveError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setResolvingUpn(false);
        }
    }), [addPrincipalId, homeAccountId, tenantId, store]);
    /**
     * Bulk grant — accepts a list of UPNs / object ids (one per line),
     * resolves UPNs via Graph if needed, and grants the selected role
     * to each in sequence. Each row's status is surfaced in
     * `bulkResults` so the operator sees per-principal outcomes.
     *
     * 409/"already exists" is treated as idempotent success so a re-run
     * after a partial failure doesn't accumulate noise.
     */
    const submitBulk = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!addRoleId)
            return;
        const lines = bulkInput
            .split(/[\r\n,;]+/)
            .map((l) => l.trim())
            .filter(Boolean);
        if (lines.length === 0)
            return;
        setAdding(true);
        setAddError(null);
        setBulkResults(lines.map((p) => ({ principal: p, status: "pending" })));
        // Pre-acquire a Graph token once if any line is a UPN.
        const hasUpns = lines.some((l) => l.includes("@"));
        let graphToken = null;
        if (hasUpns) {
            try {
                graphToken = yield getGraphTokenForAccount(homeAccountId, tenantId);
            }
            catch (_h) {
                graphToken = null; // surface per-row "couldn't resolve UPN" failures
            }
        }
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            let principal = raw;
            if (raw.includes("@") && graphToken) {
                try {
                    const u = yield findUserByUpnOrMail(tenantId, raw, graphToken);
                    if (u === null || u === void 0 ? void 0 : u.id)
                        principal = u.id;
                    else
                        throw new Error(`Graph: no user found for ${raw}`);
                }
                catch (err) {
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
                const r = yield createBillingRoleAssignment(billingAccountName, principal, tenantId, addRoleId, armToken);
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
            }
            catch (err) {
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
                }
                else {
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
    }), [
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
    const toggle = React.useCallback((id) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    const performDelete = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (selected.size === 0)
            return;
        setConfirmDelete(false);
        setDeleting(true);
        let ok = 0;
        let fail = 0;
        let alreadyGone = 0;
        for (const id of Array.from(selected)) {
            try {
                yield deleteBillingRoleAssignment(id, armToken);
                ok += 1;
                auditLog.record({
                    actor: accountUsername,
                    action: "delete_billing_role_assignment",
                    target: id,
                    status: "success",
                    details: { scope },
                });
            }
            catch (err) {
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
                }
                else {
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
    }), [selected, armToken, scope, accountUsername, store, assignments]);
    const submitAdd = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _j;
        if (!addPrincipalId.trim() || !addRoleId)
            return;
        setAdding(true);
        setAddError(null);
        const principal = addPrincipalId.trim();
        const tenant = addPrincipalTenant.trim() || tenantId;
        try {
            const r = yield createBillingRoleAssignment(billingAccountName, principal, tenant, addRoleId, armToken);
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Idempotent: 409 means an equivalent grant already exists. If we can
            // confirm via the current list that the same principal+role at this
            // scope is present, silently treat the call as a no-op.
            const isConflict = /(^|\W)(409|conflict|already\s*exists)(\W|$)/i.test(msg);
            const existing = ((_j = assignments.data) !== null && _j !== void 0 ? _j : []).find((a) => {
                var _a, _b;
                return ((_a = a.principalId) !== null && _a !== void 0 ? _a : "").toLowerCase() === principal.toLowerCase() &&
                    ((_b = a.roleDefinitionId) !== null && _b !== void 0 ? _b : "")
                        .toLowerCase()
                        .endsWith(addRoleId.toLowerCase()) &&
                    a.scope === scope;
            });
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
            }
            else {
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
        }
        finally {
            setAdding(false);
        }
    }), [
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
    return (React.createElement("div", { className: "flex flex-col gap-3" },
        React.createElement(TabCard, { title: "My roles at this billing scope", description: "Auto-detected from billingRoleAssignments. Matches the calling principal by oid claim from the current ARM token.", icon: UserCheck, onReload: assignments.reload, reloading: assignments.loading }, !callerClaims.oid ? (React.createElement(Alert, { variant: "warning", className: "text-xs" },
            React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
            React.createElement(AlertDescription, null,
                React.createElement("strong", null,
                    "Your ARM token has no ",
                    React.createElement("code", { className: "font-mono" }, "oid"),
                    " ",
                    "claim"),
                " ",
                "\u2014 we can't auto-detect your roles. This usually means the token was issued against a tenant where you aren't a member. Switch the tenant for this account on",
                " ",
                React.createElement("strong", null, "Azure Accounts"),
                " back to your home tenant, then come back here."))) : assignments.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 2 })) : assignments.error ? (React.createElement(ErrorState, { message: "Couldn't determine your roles.", detail: assignments.error, size: "compact", onRetry: assignments.reload })) : myRoles.length === 0 ? (React.createElement(Alert, { variant: "warning", className: "text-xs" },
            React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
            React.createElement(AlertDescription, { className: "flex flex-col gap-2" },
                React.createElement("span", null,
                    React.createElement("strong", null, "No billing roles found"),
                    " for",
                    " ",
                    React.createElement("code", { className: "font-mono" }, callerClaims.upn || callerClaims.oid.slice(0, 8) + "…"),
                    " ",
                    "at billing account",
                    " ",
                    React.createElement("code", { className: "font-mono" }, billingAccountName),
                    "."),
                React.createElement("span", { className: "text-2xs" },
                    "If you're sure you have a role, the assignment may exist at a different scope (department, enrollment account, billing profile) \u2014 check the Departments / Enrollment tabs. Otherwise use",
                    " ",
                    React.createElement("strong", null, "Grant me Subscription Creator"),
                    " below if you can self-grant."),
                definitions.data &&
                    definitions.data.some((d) => {
                        var _a;
                        return ((_a = d.name) !== null && _a !== void 0 ? _a : "").toLowerCase() ===
                            "a0bcee42-bf30-4d1b-926a-48d21664ef71";
                    }) && (React.createElement("div", null,
                    React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", onClick: () => {
                            setAddMode("single");
                            setAddPrincipalId(callerClaims.oid);
                            setAddPrincipalTenant(callerClaims.tid || tenantId);
                            setAddRoleId("a0bcee42-bf30-4d1b-926a-48d21664ef71");
                            store.addNotification({
                                type: "info",
                                message: "Pre-filled with your oid + Subscription Creator role. Click Grant role below.",
                            });
                        } },
                        React.createElement(Sparkles, { className: "h-3 w-3" }),
                        "Pre-fill Grant me Subscription Creator")))))) : (React.createElement("div", { className: "flex flex-col gap-3" },
            React.createElement("div", { className: "flex flex-wrap gap-2" },
                React.createElement(CapabilityBadge, { ok: myCapabilities.isEnterpriseAdmin, icon: Crown, label: "Enterprise Admin", detail: myCapabilities.isEnterpriseAdmin
                        ? "Full enrollment control"
                        : "Not granted" }),
                React.createElement(CapabilityBadge, { ok: myCapabilities.canCreateSubscriptions, icon: Sparkles, label: "Can create subs", detail: myCapabilities.canCreateSubscriptions
                        ? "via EA / Account Owner / Sub Creator"
                        : "Need EA Subscription Creator" }),
                React.createElement(CapabilityBadge, { ok: myCapabilities.isAccountOwner, icon: ShieldCheck, label: "Account Owner", detail: myCapabilities.isAccountOwner
                        ? "Owns at least one EA account"
                        : "Not granted" }),
                React.createElement(CapabilityBadge, { ok: myCapabilities.isDepartmentAdmin, icon: Building2, label: "Department Admin", detail: myCapabilities.isDepartmentAdmin
                        ? "Manages a department"
                        : "Not granted" })),
            React.createElement("ul", { className: "flex flex-col gap-1" }, myRoles.map((r) => {
                const Icon = r.meta.icon;
                return (React.createElement("li", { key: r.assignment.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs", r.meta.tone === "destructive" &&
                        "border-destructive/40 bg-destructive/5", r.meta.tone === "warning" &&
                        "border-warning/40 bg-warning/5", r.meta.tone === "info" && "border-info/40 bg-info/5", r.meta.tone === "success" &&
                        "border-success/40 bg-success/5", (r.meta.tone === "outline" ||
                        r.meta.tone === "secondary") &&
                        "border-border bg-card/40") },
                    React.createElement(Icon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    React.createElement("span", { className: "font-semibold" }, r.friendly),
                    r.meta.readOnly && (React.createElement(Badge, { variant: "outline", className: "px-1 py-0 text-[9px]" }, "read only")),
                    React.createElement(InfoTooltip, { content: r.meta.summary }),
                    React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" }, r.assignment.createdOn
                        ? `since ${r.assignment.createdOn.slice(0, 10)}`
                        : "")));
            })),
            React.createElement("div", { className: "text-2xs text-muted-foreground" },
                "Signed in as",
                " ",
                React.createElement("code", { className: "font-mono" }, ((_a = resolvedPrincipals[callerClaims.oid]) === null || _a === void 0 ? void 0 : _a.signInName) ||
                    ((_b = resolvedPrincipals[callerClaims.oid]) === null || _b === void 0 ? void 0 : _b.displayName) ||
                    callerClaims.upn ||
                    callerClaims.oid.slice(0, 8) + "…"),
                " ",
                "\u00B7 token tenant",
                " ",
                React.createElement("code", { className: "font-mono" },
                    callerClaims.tid.slice(0, 8),
                    "\u2026"),
                callerClaims.tid.toLowerCase() !== tenantId.toLowerCase() && (React.createElement(Badge, { variant: "warning", className: "ml-1.5 px-1.5 py-0 text-[9px]" }, "cross-tenant")))))),
        React.createElement(TabCard, { title: "Add billing role assignment", description: "Grant a billing role at this billing-account scope. Single or bulk; resolves UPN/email to object id via Microsoft Graph.", icon: UserPlus },
            React.createElement("div", { role: "radiogroup", "aria-label": "Grant mode", className: "inline-flex overflow-hidden rounded-md border border-border text-xs" },
                React.createElement("button", { type: "button", role: "radio", "aria-checked": addMode === "single", onClick: () => setAddMode("single"), className: cn("flex items-center gap-1.5 px-3 py-1.5 transition-colors", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", addMode === "single"
                        ? "bg-primary/15 text-foreground"
                        : "text-muted-foreground hover:bg-muted/40") },
                    React.createElement(UserPlus, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    "Single principal"),
                React.createElement("button", { type: "button", role: "radio", "aria-checked": addMode === "bulk", onClick: () => setAddMode("bulk"), className: cn("flex items-center gap-1.5 border-l border-border px-3 py-1.5 transition-colors", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", addMode === "bulk"
                        ? "bg-primary/15 text-foreground"
                        : "text-muted-foreground hover:bg-muted/40") },
                    React.createElement(Users, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    "Bulk paste")),
            addMode === "single" ? (React.createElement("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5 sm:col-span-2" },
                    React.createElement(Label, { className: "flex items-center gap-1.5 text-xs" },
                        "Principal object id (or UPN / email)",
                        React.createElement(InfoTooltip, { content: "Paste a GUID or a user@domain.com \u2014 Graph resolves UPNs to their object id when you click Resolve." })),
                    React.createElement("div", { className: "flex gap-2" },
                        React.createElement(Input, { value: addPrincipalId, onChange: (e) => {
                                setAddPrincipalId(e.target.value);
                                setAddError(null);
                                setResolveError(null);
                            }, placeholder: "11111111-2222-\u2026 or user@contoso.com", className: "font-mono text-xs" }),
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => void resolveUpn(), loading: resolvingUpn, disabled: resolvingUpn ||
                                !addPrincipalId.includes("@") ||
                                !homeAccountId, "aria-label": "Resolve UPN or email to object id via Microsoft Graph", title: !addPrincipalId.includes("@")
                                ? "Only resolves UPN / email — already looks like a GUID."
                                : "Resolve UPN → object id", className: "h-9 shrink-0" },
                            !resolvingUpn && React.createElement(Wand2, { className: "h-3.5 w-3.5" }),
                            "Resolve"),
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: grantMe, disabled: !callerClaims.oid, "aria-label": callerClaims.oid
                                ? "Pre-fill with my own object id"
                                : "Token has no oid claim — cannot pre-fill", title: callerClaims.oid
                                ? `Pre-fill ${callerClaims.upn || "myself"} (${callerClaims.oid.slice(0, 8)}…)`
                                : "ARM token has no oid claim — fix tenant context first.", className: "h-9 shrink-0" },
                            React.createElement(UserCheck, { className: "h-3.5 w-3.5" }),
                            "Grant me")),
                    resolveError && (React.createElement(Alert, { variant: "warning", className: "text-2xs" },
                        React.createElement(AlertTriangle, { className: "h-3 w-3" }),
                        React.createElement(AlertDescription, null, resolveError)))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Principal tenant id"),
                    React.createElement(Input, { value: addPrincipalTenant, onChange: (e) => setAddPrincipalTenant(e.target.value), placeholder: "tenant guid", className: "font-mono text-xs" }),
                    (addPrincipalTenant !== null && addPrincipalTenant !== void 0 ? addPrincipalTenant : "").toLowerCase() !==
                        tenantId.toLowerCase() &&
                        addPrincipalTenant.trim().length > 0 && (React.createElement("span", { className: "flex items-center gap-1 text-2xs text-warning" },
                        React.createElement(Network, { className: "h-3 w-3" }),
                        "Cross-tenant grant \u2014 confirm this is what you want."))),
                React.createElement("div", { className: "sm:col-span-3" },
                    React.createElement(Label, { className: "flex items-center gap-1.5 text-xs" },
                        "Role",
                        React.createElement(InfoTooltip, { content: "Hover each role in the list below to see what it can do. Enterprise Administrator is the highest privilege \u2014 grant sparingly." })),
                    React.createElement(Select, { value: addRoleId, onValueChange: setAddRoleId },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: "Pick role" })),
                        React.createElement(SelectContent, { className: "max-h-72" }, ((_c = definitions.data) !== null && _c !== void 0 ? _c : []).map((d) => {
                            var _a, _b;
                            const meta = resolveRoleMeta((_a = d.name) !== null && _a !== void 0 ? _a : "");
                            const Icon = meta.icon;
                            return (React.createElement(SelectItem, { key: d.name, value: d.name },
                                React.createElement("span", { className: "flex items-center gap-2" },
                                    React.createElement(Icon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                    React.createElement("span", { className: "flex flex-col" },
                                        React.createElement("span", { className: "text-sm" },
                                            d.roleName,
                                            meta.readOnly && (React.createElement("span", { className: "ml-1 text-2xs text-muted-foreground" }, "(read only)"))),
                                        React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                            ((_b = d.name) !== null && _b !== void 0 ? _b : "").slice(0, 8),
                                            "\u2026")))));
                        })))))) : (React.createElement("div", { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "flex items-center gap-1.5 text-xs" },
                        "Principals (one per line)",
                        React.createElement(InfoTooltip, { content: "Paste any mix of object ids (GUIDs) and UPN/email \u2014 UPNs are resolved via Graph on submit. Lines separated by newline, comma, or semicolon." })),
                    React.createElement("textarea", { value: bulkInput, onChange: (e) => setBulkInput(e.target.value), placeholder: "alice@contoso.com\n11111111-2222-3333-4444-555555555555\nbob@contoso.com", rows: 4, className: cn("rounded-md border border-input bg-background px-3 py-2 font-mono text-xs", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"), "aria-label": "Bulk principals input" }),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        bulkInput
                            .split(/[\r\n,;]+/)
                            .map((l) => l.trim())
                            .filter(Boolean).length,
                        " ",
                        "principal(s) \u00B7",
                        " ",
                        bulkInput.split(/[\r\n,;]+/).filter((l) => l.includes("@"))
                            .length,
                        " ",
                        "UPN(s) need resolution")),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Role"),
                    React.createElement(Select, { value: addRoleId, onValueChange: setAddRoleId },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: "Pick role" })),
                        React.createElement(SelectContent, { className: "max-h-72" }, ((_d = definitions.data) !== null && _d !== void 0 ? _d : []).map((d) => {
                            var _a;
                            const meta = resolveRoleMeta((_a = d.name) !== null && _a !== void 0 ? _a : "");
                            const Icon = meta.icon;
                            return (React.createElement(SelectItem, { key: d.name, value: d.name },
                                React.createElement("span", { className: "flex items-center gap-2" },
                                    React.createElement(Icon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                    React.createElement("span", { className: "text-sm" }, d.roleName))));
                        })))),
                bulkResults.length > 0 && (React.createElement("div", { className: "rounded-md border border-border bg-card/40 p-2" },
                    React.createElement("div", { className: "flex items-center gap-2 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground" },
                        React.createElement(Layers, { className: "h-3 w-3", "aria-hidden": true }),
                        "Bulk results",
                        React.createElement("span", { className: "ml-auto text-2xs font-normal text-muted-foreground" },
                            bulkResults.filter((r) => r.status === "ok").length,
                            " ok \u00B7",
                            " ",
                            bulkResults.filter((r) => r.status === "already").length,
                            " already \u00B7",
                            " ",
                            bulkResults.filter((r) => r.status === "failed").length,
                            " failed")),
                    React.createElement("ul", { className: "flex flex-col gap-0.5 text-2xs" }, bulkResults.map((r, i) => (React.createElement("li", { key: i, className: "flex items-start gap-1.5" },
                        r.status === "ok" && (React.createElement(Check, { className: "mt-0.5 h-3 w-3 text-success", "aria-hidden": true })),
                        r.status === "already" && (React.createElement(Check, { className: "mt-0.5 h-3 w-3 text-info", "aria-hidden": true })),
                        r.status === "failed" && (React.createElement(AlertTriangle, { className: "mt-0.5 h-3 w-3 text-destructive", "aria-hidden": true })),
                        r.status === "pending" && (React.createElement(Loader2, { className: "mt-0.5 h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none", "aria-hidden": true })),
                        React.createElement("code", { className: "font-mono" }, r.principal),
                        r.message && (React.createElement("span", { className: "min-w-0 break-words text-destructive" }, r.message)))))))))),
            addError && (React.createElement(Alert, { variant: "destructive" },
                React.createElement(AlertDescription, null, addError))),
            React.createElement("div", null,
                React.createElement(Button, { type: "button", onClick: () => addMode === "single" ? void submitAdd() : void submitBulk(), disabled: adding ||
                        !addRoleId ||
                        (addMode === "single"
                            ? !addPrincipalId.trim()
                            : bulkInput.trim().length === 0), loading: adding },
                    !adding && React.createElement(Plus, null),
                    addMode === "single"
                        ? "Grant role"
                        : `Grant role to ${bulkInput
                            .split(/[\r\n,;]+/)
                            .map((l) => l.trim())
                            .filter(Boolean).length} principals`))),
        React.createElement(TabCard, { title: "Existing billing role assignments", description: "Every assignment at this billing-account scope. Use the checkboxes for bulk delete.", icon: UserCheck, onReload: assignments.reload, reloading: assignments.loading, action: React.createElement("div", { className: "flex items-center gap-1" },
                React.createElement(ExportMenu, { rows: filtered, columns: [
                        {
                            header: "DisplayName",
                            accessor: (a) => { var _a, _b, _c; return (_c = (_b = resolvedPrincipals[(_a = a.principalId) !== null && _a !== void 0 ? _a : ""]) === null || _b === void 0 ? void 0 : _b.displayName) !== null && _c !== void 0 ? _c : ""; },
                        },
                        {
                            header: "SignInName",
                            accessor: (a) => { var _a, _b, _c; return (_c = (_b = resolvedPrincipals[(_a = a.principalId) !== null && _a !== void 0 ? _a : ""]) === null || _b === void 0 ? void 0 : _b.signInName) !== null && _c !== void 0 ? _c : ""; },
                        },
                        {
                            header: "PrincipalType",
                            accessor: (a) => { var _a, _b, _c; return (_c = (_b = resolvedPrincipals[(_a = a.principalId) !== null && _a !== void 0 ? _a : ""]) === null || _b === void 0 ? void 0 : _b.type) !== null && _c !== void 0 ? _c : ""; },
                        },
                        { header: "PrincipalId", accessor: (a) => a.principalId },
                        { header: "PrincipalTenantId", accessor: (a) => a.principalTenantId },
                        { header: "RoleDefinitionId", accessor: (a) => a.roleDefinitionId },
                        { header: "RoleDefinitionName", accessor: (a) => a.roleDefinitionName },
                        { header: "Scope", accessor: (a) => a.scope },
                        { header: "Id", accessor: (a) => a.id },
                        {
                            header: "CreatedOn",
                            accessor: (a) => { var _a; return (_a = a.createdOn) !== null && _a !== void 0 ? _a : ""; },
                        },
                    ], filename: `billing-role-assignments-${billingAccountName}` }),
                React.createElement(Button, { type: "button", variant: "destructive", size: "sm", className: "h-7 text-xs focus-visible:ring-2 focus-visible:ring-ring", disabled: selected.size === 0 || deleting, onClick: () => setConfirmDelete(true), "aria-label": `Delete ${selected.size} selected role assignments` },
                    React.createElement(Trash2, { className: "h-3 w-3" }),
                    "Delete",
                    selected.size > 0 ? ` (${selected.size})` : "")) },
            React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Role assignment summary" },
                React.createElement(SummaryStatItem, { label: "Total", value: (_f = (_e = assignments.data) === null || _e === void 0 ? void 0 : _e.length) !== null && _f !== void 0 ? _f : 0, compact: true }),
                React.createElement(SummaryStatItem, { label: "Selected", value: selected.size, compact: true, tone: selected.size > 0 ? "info" : undefined }),
                React.createElement(SummaryStatItem, { label: "Cross-tenant", value: ((_g = assignments.data) !== null && _g !== void 0 ? _g : []).filter((a) => {
                        var _a;
                        return ((_a = a.principalTenantId) !== null && _a !== void 0 ? _a : "").toLowerCase() !==
                            tenantId.toLowerCase();
                    }).length, compact: true, tone: "warning" })),
            React.createElement("div", { className: "relative" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search by email, name, principal id, role, tenant\u2026", className: "pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Filter role assignments" }),
                (resolvingPrincipals || resolveCount > 0) && (React.createElement("span", { className: "mt-1 flex items-center gap-1.5 text-2xs text-muted-foreground" }, resolvingPrincipals ? (React.createElement(React.Fragment, null,
                    React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none", "aria-hidden": true }),
                    React.createElement("span", null, "Resolving principal names via Graph\u2026"))) : (React.createElement(React.Fragment, null,
                    React.createElement(Check, { className: "h-3 w-3 text-success", "aria-hidden": true }),
                    React.createElement("span", null,
                        "Resolved ",
                        resolveCount,
                        " principal",
                        resolveCount === 1 ? "" : "s",
                        " to display name / UPN.")))))),
            React.createElement("div", { className: "flex flex-wrap gap-1.5", role: "radiogroup", "aria-label": "Filter by role category" }, [
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
            ].map((chip) => {
                const Icon = chip.icon;
                const active = roleFilter === chip.key;
                return (React.createElement("button", { key: chip.key, type: "button", role: "radio", "aria-checked": active, onClick: () => setRoleFilter(chip.key), className: cn("flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs transition-colors", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active
                        ? "border-primary bg-primary/15 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted/40") },
                    React.createElement(Icon, { className: "h-3 w-3", "aria-hidden": true }),
                    React.createElement("span", null, chip.label),
                    React.createElement(Badge, { variant: active ? "secondary" : "outline", className: "ml-0.5 h-4 text-[9px]" }, chip.count)));
            })),
            assignments.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 4 })) : assignments.error ? (React.createElement(ErrorState, { message: "Failed to load billingRoleAssignments.", detail: assignments.error, size: "compact" })) : filtered.length === 0 ? (React.createElement(EmptyState, { icon: UserCheck, title: search || roleFilter !== "all"
                    ? "No matching assignments"
                    : "No assignments", description: search || roleFilter !== "all"
                    ? "Adjust your filter to see results."
                    : "No principals have been granted any billing role on this account.", size: "compact" })) : (
            // GROUPED list — one section per role, sorted by privilege
            // precedence (Enterprise Admin → ... → Read-only).
            React.createElement("div", { className: "flex flex-col gap-3" }, grouped.map((group) => {
                const Icon = group.meta.icon;
                return (React.createElement("div", { key: group.guid, className: "rounded-md border border-border bg-card/40" },
                    React.createElement("div", { className: cn("flex flex-wrap items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-2xs font-semibold uppercase tracking-wide", group.meta.tone === "destructive" &&
                            "text-destructive", group.meta.tone === "warning" && "text-warning", group.meta.tone === "info" && "text-info", group.meta.tone === "success" && "text-success", (group.meta.tone === "outline" ||
                            group.meta.tone === "secondary") &&
                            "text-muted-foreground") },
                        React.createElement(Icon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        React.createElement("span", null, group.friendly),
                        group.meta.readOnly && (React.createElement("span", { className: "text-2xs font-normal opacity-70" }, "(read only)")),
                        React.createElement(InfoTooltip, { content: group.meta.summary }),
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" }, group.rows.length),
                        React.createElement("span", { className: "ml-auto font-mono text-[10px] font-normal opacity-60" },
                            group.guid.slice(0, 8),
                            "\u2026")),
                    React.createElement("ul", { className: "flex flex-col" }, group.rows.map((a) => {
                        var _a, _b, _c, _d;
                        const isCrossTenant = !!a.principalTenantId &&
                            a.principalTenantId.toLowerCase() !==
                                tenantId.toLowerCase();
                        const isSelf = !!callerClaims.oid &&
                            ((_a = a.principalId) !== null && _a !== void 0 ? _a : "").toLowerCase() ===
                                callerClaims.oid.toLowerCase();
                        const resolved = resolvedPrincipals[(_b = a.principalId) !== null && _b !== void 0 ? _b : ""];
                        const isUnknown = !resolved || resolved.type === "Unknown";
                        // Prefer signInName (UPN/email) as the headline,
                        // displayName as the subtitle. For non-user
                        // principals (Group, SP), show displayName + type.
                        const headline = (resolved === null || resolved === void 0 ? void 0 : resolved.signInName) ||
                            (resolved === null || resolved === void 0 ? void 0 : resolved.displayName) ||
                            (isCrossTenant
                                ? "(external — not in this tenant)"
                                : "(no directory entry)");
                        const subtitle = (resolved === null || resolved === void 0 ? void 0 : resolved.signInName) && resolved.displayName !== resolved.signInName
                            ? resolved.displayName
                            : "";
                        return (React.createElement("li", { key: a.id, className: cn("flex flex-wrap items-center gap-2 border-b border-border/40 px-2.5 py-1.5 text-xs last:border-b-0", isSelf && "bg-info/5") },
                            React.createElement(Checkbox, { "aria-label": `Select ${a.principalId}`, checked: selected.has(a.id), onCheckedChange: () => toggle(a.id), disabled: deleting }),
                            (resolved === null || resolved === void 0 ? void 0 : resolved.type) === "Group" ? (React.createElement(Users, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true })) : (resolved === null || resolved === void 0 ? void 0 : resolved.type) === "ServicePrincipal" ||
                                (resolved === null || resolved === void 0 ? void 0 : resolved.type) === "Application" ? (React.createElement(Sliders, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true })) : (React.createElement(Key, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true })),
                            React.createElement("div", { className: "flex min-w-0 flex-col gap-0.5" },
                                React.createElement("span", { className: cn("flex items-center gap-1.5 truncate text-xs", isUnknown
                                        ? "italic text-muted-foreground"
                                        : "font-medium text-foreground") },
                                    React.createElement("span", { className: "truncate" }, headline),
                                    (resolved === null || resolved === void 0 ? void 0 : resolved.type) &&
                                        resolved.type !== "User" &&
                                        resolved.type !== "Unknown" && (React.createElement(Badge, { variant: "outline", className: "px-1 py-0 text-[9px]" }, resolved.type))),
                                React.createElement("span", { className: "flex items-center gap-1.5 truncate text-2xs text-muted-foreground" },
                                    subtitle && (React.createElement("span", { className: "truncate" }, subtitle)),
                                    React.createElement(CopyableText, { value: (_c = a.principalId) !== null && _c !== void 0 ? _c : "", mono: true }))),
                            isSelf && (React.createElement(Badge, { variant: "info", className: "px-1.5 py-0 text-[9px]" }, "You")),
                            isCrossTenant && (React.createElement(Badge, { variant: "warning", className: "flex items-center gap-1 px-1.5 py-0 text-[9px]" },
                                React.createElement(Network, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                                "cross-tenant")),
                            React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" },
                                "tenant",
                                " ",
                                React.createElement("code", { className: "font-mono" },
                                    ((_d = a.principalTenantId) !== null && _d !== void 0 ? _d : "").slice(0, 8),
                                    "\u2026"),
                                a.createdOn && (React.createElement(React.Fragment, null,
                                    " · since ",
                                    a.createdOn.slice(0, 10)))),
                            deleting && selected.has(a.id) && (React.createElement(Loader2, { className: "h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none", "aria-label": "Deleting" }))));
                    }))));
            })))),
        React.createElement(ConfirmationDialog, { hidden: !confirmDelete, title: "Delete role assignments", message: `Delete ${selected.size} billing role assignment${selected.size === 1 ? "" : "s"}? This cannot be undone. If an assignment is already gone (404), it will be treated as success.`, confirmText: "Delete", cancelText: "Cancel", danger: true, loading: deleting, onConfirm: () => void performDelete(), onCancel: () => setConfirmDelete(false) })));
};
/* ----- Departments -------------------------------------------------- */
const DepartmentsTab = ({ armToken, billingAccountName, onDrillDown }) => {
    var _a, _b, _c, _d, _e, _f;
    const depts = useAsyncLoad(() => listEaDepartments(billingAccountName, armToken), [armToken, billingAccountName]);
    const [search, setSearch] = React.useState("");
    // Persisted "hide departments with fewer than N enrollment accounts"
    // threshold — drives the threshold filter chip below. Persisted across
    // reloads via use-persisted-state so the operator's filter sticks
    // between sessions per Design Contract §10 (no scattered localStorage).
    const [hideUnderEa, setHideUnderEa] = usePersistedState("ea-billing-manager:depts:hide-under-ea", 0, { version: 1 });
    const filtered = React.useMemo(() => {
        var _a;
        const list = (_a = depts.data) !== null && _a !== void 0 ? _a : [];
        const q = search.trim().toLowerCase();
        return list.filter((d) => {
            if (hideUnderEa > 0) {
                const ea = typeof d.enrollmentAccounts === "number" ? d.enrollmentAccounts : 0;
                if (ea < hideUnderEa)
                    return false;
            }
            if (!q)
                return true;
            return [d.departmentName, d.name, d.costCenter, d.status]
                .join(" ")
                .toLowerCase()
                .includes(q);
        });
    }, [depts.data, search, hideUnderEa]);
    return (React.createElement(TabCard, { title: "Departments", description: "EA enrollment departments under this billing account.", icon: Layers, onReload: depts.reload, reloading: depts.loading, action: depts.data && depts.data.length > 0 ? (React.createElement(ExportMenu, { rows: filtered, columns: [
                { header: "Name", accessor: (d) => d.name },
                { header: "DepartmentName", accessor: (d) => d.departmentName },
                { header: "CostCenter", accessor: (d) => { var _a; return (_a = d.costCenter) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Status", accessor: (d) => { var _a; return (_a = d.status) !== null && _a !== void 0 ? _a : ""; } },
                { header: "EnrollmentAccounts", accessor: (d) => { var _a; return (_a = d.enrollmentAccounts) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Id", accessor: (d) => d.id },
            ], filename: `ea-departments-${billingAccountName}` })) : undefined },
        React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Departments summary" },
            React.createElement(SummaryStatItem, { label: "Total", value: (_b = (_a = depts.data) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0, compact: true }),
            React.createElement(SummaryStatItem, { label: "With cost center", value: ((_c = depts.data) !== null && _c !== void 0 ? _c : []).filter((d) => !!d.costCenter).length, compact: true, tone: ((_d = depts.data) !== null && _d !== void 0 ? _d : []).some((d) => !!d.costCenter) ? "info" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Enrollment accts", value: ((_e = depts.data) !== null && _e !== void 0 ? _e : []).reduce((sum, d) => sum +
                    (typeof d.enrollmentAccounts === "number"
                        ? d.enrollmentAccounts
                        : 0), 0), compact: true })),
        React.createElement("div", { className: "relative" },
            React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
            React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search department name, cost center\u2026", className: "pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Filter departments" })),
        React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Department size threshold" },
            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Hide depts with fewer than"),
            [0, 1, 5, 10].map((n) => (React.createElement("button", { key: n, type: "button", role: "radio", "aria-checked": hideUnderEa === n, onClick: () => setHideUnderEa(n), className: cn("rounded-full border px-2.5 py-0.5 text-2xs transition-colors", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", hideUnderEa === n
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/40") }, n === 0 ? "Off" : `${n} EAs`))),
            hideUnderEa > 0 && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                "\u00B7",
                " ",
                ((_f = depts.data) !== null && _f !== void 0 ? _f : []).filter((d) => {
                    const ea = typeof d.enrollmentAccounts === "number"
                        ? d.enrollmentAccounts
                        : 0;
                    return ea < hideUnderEa;
                }).length,
                " ",
                "hidden"))),
        depts.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 3 })) : depts.error ? (React.createElement(ErrorState, { message: "Failed to load departments.", detail: depts.error, size: "compact" })) : filtered.length === 0 ? (React.createElement(EmptyState, { icon: Layers, title: search ? "No matching departments" : "No departments returned", description: search
                ? "Adjust your filter to see results."
                : "This billing account has no departments configured, or your role does not allow listing them.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, filtered.map((d) => (React.createElement("li", { key: d.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs", onDrillDown && "transition-colors hover:bg-muted/30") },
            React.createElement(Layers, { className: "h-3.5 w-3.5 text-muted-foreground" }),
            React.createElement("span", { className: "font-medium" }, d.departmentName),
            React.createElement(CopyableText, { value: d.name, mono: true }),
            d.costCenter && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                "CC: ",
                d.costCenter)),
            d.status && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, d.status)),
            d.enrollmentAccounts !== undefined && (React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" },
                d.enrollmentAccounts,
                " enrollment account",
                d.enrollmentAccounts === 1 ? "" : "s")),
            onDrillDown && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs focus-visible:ring-2 focus-visible:ring-ring", onClick: () => onDrillDown(d.name), "aria-label": `Open Department Admin for ${d.departmentName}`, title: "Open Department Admin workspace for this department" },
                "Manage",
                React.createElement(ChevronRight, { className: "h-3 w-3", "aria-hidden": true }))))))))));
};
/* ----- Enrollment Accounts ----------------------------------------- */
const EnrollmentAccountsTab = ({ armToken, billingAccountName }) => {
    const ea = useAsyncLoad(() => listEnrollmentAccounts(billingAccountName, armToken), [armToken, billingAccountName]);
    const [search, setSearch] = React.useState("");
    const [statusFilter, setStatusFilter] = React.useState("all");
    const counts = React.useMemo(() => {
        var _a, _b;
        const list = (_a = ea.data) !== null && _a !== void 0 ? _a : [];
        let active = 0;
        let inactive = 0;
        for (const e of list) {
            const s = ((_b = e.status) !== null && _b !== void 0 ? _b : "").toLowerCase();
            if (s === "active" || s === "enabled")
                active++;
            else if (s)
                inactive++;
        }
        return { total: list.length, active, inactive };
    }, [ea.data]);
    const filtered = React.useMemo(() => {
        var _a;
        const list = (_a = ea.data) !== null && _a !== void 0 ? _a : [];
        const q = search.trim().toLowerCase();
        return list.filter((e) => {
            var _a;
            const s = ((_a = e.status) !== null && _a !== void 0 ? _a : "").toLowerCase();
            if (statusFilter === "active" && !(s === "active" || s === "enabled"))
                return false;
            if (statusFilter === "inactive" && (s === "active" || s === "enabled" || !s))
                return false;
            if (!q)
                return true;
            return [e.displayName, e.name, e.costCenter, e.status, e.accountOwner]
                .join(" ")
                .toLowerCase()
                .includes(q);
        });
    }, [ea.data, search, statusFilter]);
    return (React.createElement(TabCard, { title: "Enrollment accounts", description: "Cost-tracking buckets that own newly-created subscriptions.", icon: Building2, onReload: ea.reload, reloading: ea.loading, action: ea.data && ea.data.length > 0 ? (React.createElement(ExportMenu, { rows: filtered, columns: [
                { header: "Name", accessor: (e) => e.name },
                { header: "DisplayName", accessor: (e) => e.displayName },
                { header: "Status", accessor: (e) => { var _a; return (_a = e.status) !== null && _a !== void 0 ? _a : ""; } },
                { header: "CostCenter", accessor: (e) => { var _a; return (_a = e.costCenter) !== null && _a !== void 0 ? _a : ""; } },
                { header: "AccountOwner", accessor: (e) => { var _a; return (_a = e.accountOwner) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Id", accessor: (e) => e.id },
            ], filename: `ea-enrollment-accounts-${billingAccountName}` })) : undefined },
        React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Enrollment accounts summary" },
            React.createElement(SummaryStatItem, { label: "Total", value: counts.total, compact: true }),
            React.createElement(SummaryStatItem, { label: "Active", value: counts.active, compact: true, tone: counts.active > 0 ? "success" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Inactive", value: counts.inactive, compact: true, tone: counts.inactive > 0 ? "warning" : "muted" })),
        React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Quick filters" }, ["all", "active", "inactive"].map((f) => (React.createElement(Button, { key: f, type: "button", variant: statusFilter === f ? "default" : "ghost", size: "sm", className: "h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring", onClick: () => setStatusFilter(f), "aria-pressed": statusFilter === f, "aria-label": `Show ${f} enrollment accounts` }, f === "all" ? "All" : f === "active" ? "Active" : "Inactive")))),
        React.createElement("div", { className: "relative" },
            React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
            React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search name, owner, cost center\u2026", className: "pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Filter enrollment accounts" })),
        ea.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 3 })) : ea.error ? (React.createElement(ErrorState, { message: "Failed to load enrollment accounts.", detail: ea.error, size: "compact" })) : filtered.length === 0 ? (React.createElement(EmptyState, { icon: Building2, title: search ? "No matching enrollment accounts" : "No enrollment accounts", description: search
                ? "Adjust your filter to see results."
                : "No cost-tracking buckets exist for this billing account yet.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, filtered.map((e) => (React.createElement("li", { key: e.id, className: "flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs" },
            React.createElement(Building2, { className: "h-3.5 w-3.5 text-muted-foreground" }),
            React.createElement("span", { className: "font-medium" }, e.displayName),
            React.createElement(CopyableText, { value: e.name, mono: true }),
            e.status && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, e.status)),
            e.costCenter && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                "CC: ",
                e.costCenter)),
            e.accountOwner && (React.createElement("span", { className: "ml-auto truncate text-2xs text-muted-foreground" },
                "owner: ",
                e.accountOwner)))))))));
};
/* ----- Subscriptions ------------------------------------------------ */
const SubscriptionsTab = ({ armToken, billingAccountName, accountUsername, store }) => {
    const subs = useAsyncLoad(() => listEaBillingSubscriptions(billingAccountName, armToken), [armToken, billingAccountName]);
    const [search, setSearch] = React.useState("");
    const [statusFilter, setStatusFilter] = React.useState("all");
    const [moveTargetSub, setMoveTargetSub] = React.useState(null);
    const [cancelTargetSub, setCancelTargetSub] = React.useState(null);
    // Billing-scope watcher (corpus: `_ea_subscription_cross_tenant.md`).
    // Whenever the sub list loads, diff every sub's billing scope against
    // the local snapshot from the previous load. Flag changed scopes so
    // the operator can spot a quiet sub-transfer or invoice-section move
    // even when there's no corresponding audit entry in this tenant.
    //
    // The snapshot is per-billing-account so two operators looking at the
    // same enrollment from different machines don't fight over storage.
    // We keep `changes` in component state (NOT persisted) so it clears
    // on remount — once you've seen the diff, refreshing intentionally
    // clears it.
    const [scopeChanges, setScopeChanges] = React.useState({});
    React.useEffect(() => {
        if (!subs.data)
            return;
        const prev = loadScopeSnapshot(billingAccountName);
        const { changes, nextSnapshot } = detectScopeChanges(subs.data, prev);
        setScopeChanges(changes);
        // Persist the new fingerprint set BEFORE the next load — without
        // this, a rapid second load would re-flag every "scope changed" row
        // because we never wrote the new fingerprints back.
        saveScopeSnapshot(billingAccountName, nextSnapshot);
    }, [subs.data, billingAccountName]);
    const scopeChangedCount = React.useMemo(() => Object.values(scopeChanges).filter((c) => c.kind === "scope-changed")
        .length, [scopeChanges]);
    const counts = React.useMemo(() => {
        var _a, _b;
        const list = (_a = subs.data) !== null && _a !== void 0 ? _a : [];
        let active = 0;
        let disabled = 0;
        for (const s of list) {
            const status = ((_b = s.status) !== null && _b !== void 0 ? _b : "").toLowerCase();
            if (status === "active" || status === "enabled")
                active += 1;
            else if (status === "disabled" ||
                status === "deleted" ||
                status === "expired" ||
                status === "warned" ||
                status === "cancelled")
                disabled += 1;
        }
        return { total: list.length, active, disabled };
    }, [subs.data]);
    const filtered = React.useMemo(() => {
        var _a;
        const list = (_a = subs.data) !== null && _a !== void 0 ? _a : [];
        const q = search.trim().toLowerCase();
        return list.filter((s) => {
            var _a, _b;
            if (statusFilter !== "all") {
                const status = ((_a = s.status) !== null && _a !== void 0 ? _a : "").toLowerCase();
                if (statusFilter === "active") {
                    if (status !== "active" && status !== "enabled")
                        return false;
                }
                else if (statusFilter === "disabled") {
                    if (status !== "disabled" &&
                        status !== "deleted" &&
                        status !== "expired" &&
                        status !== "warned" &&
                        status !== "cancelled")
                        return false;
                }
                else if (statusFilter === "scopeChanged") {
                    // Only show subs whose billing scope flipped since the last
                    // load — drives investigation of sub-transfer events (corpus:
                    // `_ea_subscription_cross_tenant.md` §billing-scope mutation).
                    if (((_b = scopeChanges[s.name]) === null || _b === void 0 ? void 0 : _b.kind) !== "scope-changed")
                        return false;
                }
            }
            if (!q)
                return true;
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
    }, [subs.data, search, statusFilter, scopeChanges]);
    return (React.createElement(React.Fragment, null,
        React.createElement(TabCard, { title: "Billing subscriptions", description: "Every subscription billed under this EA billing account. Use the actions on a row to move it between invoice sections or cancel.", icon: Server, onReload: subs.reload, reloading: subs.loading, action: subs.data && subs.data.length > 0 ? (React.createElement(ExportMenu, { rows: filtered, columns: [
                    { header: "DisplayName", accessor: (s) => s.displayName },
                    { header: "SubscriptionId", accessor: (s) => { var _a; return (_a = s.subscriptionId) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Name", accessor: (s) => s.name },
                    { header: "Status", accessor: (s) => { var _a; return (_a = s.status) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "CostCenter", accessor: (s) => { var _a; return (_a = s.costCenter) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "BillingProfile", accessor: (s) => { var _a; return (_a = s.billingProfileDisplayName) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "InvoiceSection", accessor: (s) => { var _a; return (_a = s.invoiceSectionDisplayName) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Id", accessor: (s) => s.id },
                ], filename: `ea-subscriptions-${billingAccountName}` })) : undefined },
            React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Subscription summary" },
                React.createElement(SummaryStatItem, { label: "Total", value: counts.total, compact: true }),
                React.createElement(SummaryStatItem, { label: "Active", value: counts.active, compact: true, tone: "success" }),
                React.createElement(SummaryStatItem, { label: "Disabled", value: counts.disabled, compact: true, tone: counts.disabled > 0 ? "warning" : undefined }),
                scopeChangedCount > 0 && (React.createElement(SummaryStatItem, { label: "Scope changed", value: scopeChangedCount, compact: true, tone: "destructive" }))),
            scopeChangedCount > 0 && (React.createElement(Alert, { variant: "destructive", "aria-live": "polite" },
                React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                React.createElement(AlertDescription, null,
                    React.createElement("strong", null,
                        scopeChangedCount,
                        " subscription",
                        scopeChangedCount === 1 ? "" : "s"),
                    " ",
                    "had their billing scope flipped since you last loaded this tab. A flip can be a normal invoice-section move, but it can also be the local-tenant signature of a cross-tenant sub-transfer (the destination tenant sees the audit entry; the source tenant only sees this fingerprint change). Click the ",
                    React.createElement("em", null, "Scope changed"),
                    " filter to focus on the affected rows."))),
            React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Quick filters" }, [
                { key: "all", label: "All", count: counts.total },
                { key: "active", label: "Active", count: counts.active },
                { key: "disabled", label: "Disabled", count: counts.disabled },
                ...(scopeChangedCount > 0
                    ? [
                        {
                            key: "scopeChanged",
                            label: "Scope changed",
                            count: scopeChangedCount,
                        },
                    ]
                    : []),
            ].map(({ key, label, count }) => (React.createElement(Button, { key: key, type: "button", variant: statusFilter === key ? "default" : "ghost", size: "sm", className: "h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring", onClick: () => setStatusFilter(key), "aria-pressed": statusFilter === key, "aria-label": `Show ${label.toLowerCase()} subscriptions` },
                label,
                React.createElement(Badge, { variant: statusFilter === key ? "secondary" : "outline", className: "ml-1 h-4 px-1 text-[9px]" }, count))))),
            React.createElement("div", { className: "relative" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search display name, sub id, cost center\u2026", className: "pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Filter subscriptions" })),
            subs.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 5 })) : subs.error ? (React.createElement(ErrorState, { message: "Failed to load billing subscriptions.", detail: subs.error, size: "compact" })) : filtered.length === 0 ? (React.createElement(EmptyState, { icon: Server, title: "No matching subscriptions", description: search
                    ? "No subscriptions match your search. Try a different term."
                    : "This billing account has no subscriptions yet.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, filtered.map((s) => {
                var _a;
                const rawChange = scopeChanges[s.name];
                // Narrow once at the top so every downstream reference can
                // dereference without optional chaining gymnastics.
                const change = rawChange && rawChange.kind === "scope-changed"
                    ? rawChange
                    : null;
                const isScopeChanged = change !== null;
                const prevDecoded = change
                    ? decodeFingerprint(change.prevScope)
                    : null;
                return (React.createElement("li", { key: s.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs", isScopeChanged
                        ? "border-destructive/40 bg-destructive/5"
                        : "border-border") },
                    React.createElement(Server, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                    React.createElement("span", { className: "font-medium" }, s.displayName),
                    s.subscriptionId && React.createElement(CopyableText, { value: s.subscriptionId, mono: true }),
                    s.status && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, s.status)),
                    s.costCenter && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                        "CC: ",
                        s.costCenter)),
                    isScopeChanged && (React.createElement(Badge, { variant: "destructive", className: "text-2xs", 
                        // The title carries the prior scope details so an
                        // operator can hover to see the actual delta without
                        // forcing a layout shift. The aria-label duplicates
                        // it for screen readers.
                        title: prevDecoded
                            ? `Was: ${prevDecoded.profileName || "(no profile)"} ▸ ${prevDecoded.sectionName || "(no section)"}${prevDecoded.costCenter
                                ? ` · CC ${prevDecoded.costCenter}`
                                : ""}${change.prevSeenAt
                                ? ` · seen ${change.prevSeenAt.slice(0, 10)}`
                                : ""}`
                            : "Billing scope changed since the previous load", "aria-label": `Billing scope changed since previous load${change.prevSeenAt
                            ? ` on ${change.prevSeenAt.slice(0, 10)}`
                            : ""}` },
                        React.createElement(AlertTriangle, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                        "scope changed")),
                    s.invoiceSectionDisplayName && (React.createElement("span", { className: "truncate text-2xs text-muted-foreground" }, (_a = s.billingProfileDisplayName) !== null && _a !== void 0 ? _a : "",
                        " \u25B8 ",
                        s.invoiceSectionDisplayName)),
                    React.createElement("span", { className: "ml-auto flex items-center gap-1" },
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs", onClick: () => setMoveTargetSub(s), "aria-label": `Move subscription ${s.displayName}`, title: "Move to a different invoice section" }, "Move"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs text-destructive", onClick: () => setCancelTargetSub(s), "aria-label": `Cancel subscription ${s.displayName}`, title: "Cancel this subscription (irreversible)" }, "Cancel"))));
            })))),
        moveTargetSub && (React.createElement(SubscriptionMoveDialog, { armToken: armToken, billingAccountName: billingAccountName, accountUsername: accountUsername, sub: moveTargetSub, store: store, onClose: (refreshed) => {
                setMoveTargetSub(null);
                if (refreshed)
                    subs.reload();
            } })),
        cancelTargetSub && (React.createElement(SubscriptionCancelDialog, { armToken: armToken, billingAccountName: billingAccountName, accountUsername: accountUsername, sub: cancelTargetSub, store: store, onClose: (refreshed) => {
                setCancelTargetSub(null);
                if (refreshed)
                    subs.reload();
            } }))));
};
/* ----- Subscription move dialog (POST /billingSubscriptions/{name}/move) */
const SubscriptionMoveDialog = ({ armToken, billingAccountName, accountUsername, sub, store, onClose }) => {
    var _a;
    const [destInvoiceSectionId, setDestInvoiceSectionId] = React.useState("");
    const [destProfileId, setDestProfileId] = React.useState("");
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    // Helper validators — the EA backend rejects empty or malformed
    // ARM ids with a 400 that's not super readable, so we surface the
    // common mistake (forgot the /providers/ prefix) up-front.
    const invoiceIdValid = /^\/providers\/Microsoft\.Billing\/billingAccounts\//i.test(destInvoiceSectionId.trim());
    const profileIdValid = destProfileId.trim() === "" ||
        /^\/providers\/Microsoft\.Billing\/billingAccounts\//i.test(destProfileId.trim());
    const submit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _b, _c;
        setConfirmOpen(false);
        setSubmitting(true);
        setError(null);
        try {
            const result = yield moveBillingSubscription(billingAccountName, sub.name, {
                destinationInvoiceSectionId: destInvoiceSectionId.trim(),
                destinationBillingProfileId: destProfileId.trim() || undefined,
            }, armToken);
            auditLog.record({
                actor: accountUsername,
                action: "move_billing_subscription",
                target: (_b = sub.subscriptionId) !== null && _b !== void 0 ? _b : sub.name,
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(msg);
            auditLog.record({
                actor: accountUsername,
                action: "move_billing_subscription",
                target: (_c = sub.subscriptionId) !== null && _c !== void 0 ? _c : sub.name,
                status: "failure",
                error: msg,
                details: {
                    billingAccountName,
                    destinationInvoiceSectionId: destInvoiceSectionId.trim(),
                    destinationBillingProfileId: destProfileId.trim(),
                },
            });
        }
        finally {
            setSubmitting(false);
        }
    }), [armToken, billingAccountName, sub, destInvoiceSectionId, destProfileId, accountUsername, store, onClose]);
    return (React.createElement(Card, { className: "border-primary/40" },
        React.createElement(CardHeader, { className: "pb-2" },
            React.createElement(CardTitle, { className: "text-sm" },
                "Move ",
                sub.displayName),
            React.createElement(CardDescription, { className: "text-2xs" },
                "POST /billingSubscriptions/",
                sub.name,
                "/move")),
        React.createElement(CardContent, { className: "flex flex-col gap-3" },
            sub.invoiceSectionDisplayName && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                "Currently billed under",
                " ",
                React.createElement("strong", null, (_a = sub.billingProfileDisplayName) !== null && _a !== void 0 ? _a : "—"),
                " ",
                React.createElement(ChevronRight, { className: "inline h-3 w-3", "aria-hidden": true }),
                " ",
                React.createElement("strong", null, sub.invoiceSectionDisplayName),
                ".")),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Destination invoice section ARM id *"),
                React.createElement(Input, { value: destInvoiceSectionId, onChange: (e) => setDestInvoiceSectionId(e.target.value), placeholder: "/providers/Microsoft.Billing/billingAccounts/.../invoiceSections/...", className: cn("font-mono text-xs", destInvoiceSectionId.trim() &&
                        !invoiceIdValid &&
                        "border-destructive focus-visible:ring-destructive"), "aria-invalid": !!destInvoiceSectionId.trim() && !invoiceIdValid }),
                destInvoiceSectionId.trim() && !invoiceIdValid && (React.createElement("span", { className: "text-2xs text-destructive" }, "Must start with /providers/Microsoft.Billing/billingAccounts/\u2026"))),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Destination billing profile ARM id (optional)"),
                React.createElement(Input, { value: destProfileId, onChange: (e) => setDestProfileId(e.target.value), placeholder: "/providers/Microsoft.Billing/billingAccounts/.../billingProfiles/...", className: cn("font-mono text-xs", !profileIdValid && "border-destructive focus-visible:ring-destructive"), "aria-invalid": !profileIdValid })),
            error && (React.createElement(Alert, { variant: "destructive" },
                React.createElement(AlertDescription, null, error))),
            React.createElement("div", { className: "flex gap-2" },
                React.createElement(Button, { type: "button", onClick: () => setConfirmOpen(true), disabled: submitting || !invoiceIdValid || !profileIdValid, loading: submitting }, "Move"),
                React.createElement(Button, { type: "button", variant: "ghost", onClick: () => onClose(false), disabled: submitting }, "Close"))),
        React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: "Move subscription", message: React.createElement("div", { className: "space-y-2 text-sm" },
                React.createElement("p", null,
                    "Move ",
                    React.createElement("strong", null, sub.displayName),
                    " to a new invoice section?"),
                React.createElement("p", { className: "text-xs text-muted-foreground" }, "This is an async operation \u2014 the move usually completes within 5 minutes. Billing continues without interruption."),
                React.createElement("p", { className: "break-all text-2xs font-mono" }, destInvoiceSectionId.trim())), confirmText: "Move", cancelText: "Cancel", loading: submitting, onConfirm: () => void submit(), onCancel: () => setConfirmOpen(false) })));
};
/* ----- Subscription cancel dialog (POST /billingSubscriptions/{name}/cancel) */
const SubscriptionCancelDialog = ({ armToken, billingAccountName, accountUsername, sub, store, onClose }) => {
    const [reason, setReason] = React.useState("");
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    const runCancel = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b;
        setConfirmOpen(false);
        setSubmitting(true);
        setError(null);
        try {
            const result = yield cancelBillingSubscription(billingAccountName, sub.name, reason.trim() || "Cancelled via EA Billing Manager", armToken);
            auditLog.record({
                actor: accountUsername,
                action: "cancel_billing_subscription",
                target: (_a = sub.subscriptionId) !== null && _a !== void 0 ? _a : sub.name,
                status: "success",
                details: { billingAccountName, reason, status: result.status },
            });
            store.addNotification({
                type: "success",
                message: `Cancel accepted (${result.status}).`,
            });
            onClose(true);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(msg);
            auditLog.record({
                actor: accountUsername,
                action: "cancel_billing_subscription",
                target: (_b = sub.subscriptionId) !== null && _b !== void 0 ? _b : sub.name,
                status: "failure",
                error: msg,
                details: { billingAccountName, reason },
            });
        }
        finally {
            setSubmitting(false);
        }
    }), [armToken, billingAccountName, sub, reason, accountUsername, store, onClose]);
    return (React.createElement(React.Fragment, null,
        React.createElement(Card, { className: "border-destructive/40" },
            React.createElement(CardHeader, { className: "pb-2" },
                React.createElement(CardTitle, { className: "text-sm text-destructive" },
                    "Cancel ",
                    sub.displayName),
                React.createElement(CardDescription, { className: "text-2xs" },
                    "POST /billingSubscriptions/",
                    sub.name,
                    "/cancel \u2014 irreversible.")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Cancellation reason"),
                    React.createElement(Input, { value: reason, onChange: (e) => setReason(e.target.value), placeholder: "e.g. consolidating sandbox subs", className: "text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Cancellation reason" })),
                error && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertDescription, null, error))),
                React.createElement("div", { className: "flex gap-2" },
                    React.createElement(Button, { type: "button", variant: "destructive", onClick: () => setConfirmOpen(true), disabled: submitting, loading: submitting, "aria-label": `Cancel subscription ${sub.displayName}` }, "Cancel subscription"),
                    React.createElement(Button, { type: "button", variant: "ghost", onClick: () => onClose(false), disabled: submitting }, "Close")))),
        React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: "Cancel subscription", message: `Cancel ${sub.displayName}? This is irreversible — once cancelled, the subscription cannot be re-activated by anyone but Microsoft support.`, confirmText: "Cancel subscription", cancelText: "Keep it", danger: true, loading: submitting, onConfirm: () => void runCancel(), onCancel: () => setConfirmOpen(false) })));
};
/* ----- Invoices ----------------------------------------------------- */
const InvoicesTab = ({ armToken, billingAccountName }) => {
    // Custom date range (defaults handled inside the service).
    const [from, setFrom] = React.useState("");
    const [to, setTo] = React.useState("");
    // Guard against inverted ranges that produce empty results silently.
    const rangeInverted = !!(from && to && from > to);
    const [filter, setFilter] = React.useState("all");
    const [search, setSearch] = React.useState("");
    const invoices = useAsyncLoad(() => rangeInverted
        ? null
        : listEaInvoices(billingAccountName, armToken, {
            periodStartDate: from || undefined,
            periodEndDate: to || undefined,
        }), [armToken, billingAccountName, from, to, rangeInverted]);
    const todayIso = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
    // Determine whether an invoice has any outstanding balance. Some
    // tenants report `status: "Paid"` with a non-zero amountDue that
    // hasn't cleared yet — trust status when it's an explicit Paid, but
    // otherwise treat any positive amountDue as unpaid.
    const isUnpaid = React.useCallback((inv) => {
        var _a;
        const status = ((_a = inv.status) !== null && _a !== void 0 ? _a : "").toLowerCase();
        if (status === "paid")
            return false;
        return !!inv.amountDue && inv.amountDue.value > 0;
    }, []);
    // Overdue: unpaid AND dueDate is in the past.
    const isOverdue = React.useCallback((inv) => isUnpaid(inv) && !!inv.dueDate && inv.dueDate.slice(0, 10) < todayIso, [isUnpaid, todayIso]);
    const filtered = React.useMemo(() => {
        var _a;
        const list = (_a = invoices.data) !== null && _a !== void 0 ? _a : [];
        const q = search.trim().toLowerCase();
        const now = new Date();
        const yearStart = `${now.getUTCFullYear()}-01-01`;
        return list.filter((inv) => {
            var _a, _b, _c;
            if (filter === "thisYear") {
                if (!inv.invoiceDate || inv.invoiceDate.slice(0, 10) < yearStart)
                    return false;
            }
            else if (filter === "unpaid") {
                if (!isUnpaid(inv))
                    return false;
            }
            else if (filter === "overdue") {
                if (!isOverdue(inv))
                    return false;
            }
            if (!q)
                return true;
            return [inv.name, inv.status, (_a = inv.totalAmount) === null || _a === void 0 ? void 0 : _a.currency, String((_c = (_b = inv.totalAmount) === null || _b === void 0 ? void 0 : _b.value) !== null && _c !== void 0 ? _c : "")]
                .join(" ")
                .toLowerCase()
                .includes(q);
        });
    }, [invoices.data, filter, search, isUnpaid, isOverdue]);
    const totals = React.useMemo(() => {
        var _a;
        const list = (_a = invoices.data) !== null && _a !== void 0 ? _a : [];
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
            if (inv.amountDue)
                totalDue += inv.amountDue.value;
            if (isUnpaid(inv))
                unpaidCount++;
            if (isOverdue(inv))
                overdueCount++;
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
    return (React.createElement(TabCard, { title: "Invoices", description: "Invoices on this billing account. Defaults to the last 12 months; override the date range below.", icon: Receipt, onReload: invoices.reload, reloading: invoices.loading, action: invoices.data && invoices.data.length > 0 ? (React.createElement(ExportMenu, { rows: filtered, columns: [
                { header: "Name", accessor: (i) => i.name },
                { header: "Status", accessor: (i) => { var _a; return (_a = i.status) !== null && _a !== void 0 ? _a : ""; } },
                { header: "InvoiceDate", accessor: (i) => { var _a; return (_a = i.invoiceDate) !== null && _a !== void 0 ? _a : ""; } },
                { header: "PeriodStart", accessor: (i) => { var _a; return (_a = i.invoicePeriodStartDate) !== null && _a !== void 0 ? _a : ""; } },
                { header: "PeriodEnd", accessor: (i) => { var _a; return (_a = i.invoicePeriodEndDate) !== null && _a !== void 0 ? _a : ""; } },
                { header: "TotalAmount", accessor: (i) => { var _a, _b; return (_b = (_a = i.totalAmount) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : ""; } },
                { header: "AmountDue", accessor: (i) => { var _a, _b; return (_b = (_a = i.amountDue) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : ""; } },
                { header: "Currency", accessor: (i) => { var _a, _b; return (_b = (_a = i.totalAmount) === null || _a === void 0 ? void 0 : _a.currency) !== null && _b !== void 0 ? _b : ""; } },
                { header: "Id", accessor: (i) => i.id },
            ], filename: `ea-invoices-${billingAccountName}` })) : undefined },
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement(Label, { className: "text-xs", htmlFor: "ea-inv-from" }, "From"),
            React.createElement(Input, { id: "ea-inv-from", type: "date", value: from, onChange: (e) => setFrom(e.target.value), className: "w-44 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Period start date" }),
            React.createElement(Label, { className: "text-xs", htmlFor: "ea-inv-to" }, "To"),
            React.createElement(Input, { id: "ea-inv-to", type: "date", value: to, onChange: (e) => setTo(e.target.value), className: "w-44 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Period end date" }),
            (from || to) && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-2xs", onClick: () => {
                    setFrom("");
                    setTo("");
                } }, "Clear range"))),
        rangeInverted && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertDescription, null, "\"From\" date is after \"To\" date \u2014 adjust the range to load invoices."))),
        React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Invoice summary" },
            React.createElement(SummaryStatItem, { label: "Count", value: totals.count, compact: true }),
            React.createElement(SummaryStatItem, { label: "Total", value: `${totals.totalAmount.toLocaleString()} ${totals.currency}`, compact: true }),
            React.createElement(SummaryStatItem, { label: "Due", value: `${totals.totalDue.toLocaleString()} ${totals.currency}`, compact: true, tone: totals.totalDue > 0 ? "warning" : undefined }),
            React.createElement(SummaryStatItem, { label: "Unpaid", value: totals.unpaidCount, compact: true, tone: totals.unpaidCount > 0 ? "warning" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Overdue", value: totals.overdueCount, compact: true, tone: totals.overdueCount > 0 ? "destructive" : "muted" })),
        React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Invoice quick filters" }, [
            { key: "all", label: "All", count: totals.count },
            { key: "thisYear", label: "This year", count: undefined },
            { key: "unpaid", label: "Unpaid", count: totals.unpaidCount },
            { key: "overdue", label: "Overdue", count: totals.overdueCount },
        ].map(({ key, label, count }) => (React.createElement(Button, { key: key, type: "button", variant: filter === key ? "default" : "ghost", size: "sm", className: "h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring", onClick: () => setFilter(key), "aria-pressed": filter === key, "aria-label": `Show ${label.toLowerCase()} invoices` },
            label,
            count !== undefined && (React.createElement(Badge, { variant: filter === key ? "secondary" : "outline", className: "ml-1 h-4 px-1 text-[9px]" }, count)))))),
        React.createElement("div", { className: "relative" },
            React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
            React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search invoice name, status\u2026", className: "pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Filter invoices" })),
        invoices.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 3 })) : invoices.error ? (React.createElement(ErrorState, { message: "Failed to load invoices.", detail: invoices.error, size: "compact" })) : filtered.length === 0 ? (React.createElement(EmptyState, { icon: Receipt, title: "No invoices in this range", description: "Try expanding the date range or check that invoices have been generated for this billing account.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, filtered.map((inv) => {
            var _a, _b;
            const overdue = isOverdue(inv);
            const unpaid = !overdue && isUnpaid(inv);
            return (React.createElement("li", { key: inv.id, className: cn("group/copy flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs", overdue && "border-destructive/30 bg-destructive/5", !overdue && unpaid && "border-warning/30 bg-warning/5", !overdue && !unpaid && "border-border") },
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Receipt, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                    React.createElement(CopyableText, { value: inv.name, mono: true }),
                    inv.status && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, inv.status)),
                    inv.totalAmount && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                        inv.totalAmount.value.toLocaleString(),
                        " ",
                        inv.totalAmount.currency)),
                    inv.amountDue && inv.amountDue.value > 0 && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                        "due ",
                        inv.amountDue.value.toLocaleString(),
                        " ",
                        inv.amountDue.currency)),
                    overdue && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" }, "overdue")),
                    React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" }, (_a = inv.invoiceDate) === null || _a === void 0 ? void 0 : _a.slice(0, 10))),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2 pl-5 text-2xs text-muted-foreground" },
                    inv.invoicePeriodStartDate && (React.createElement("span", null,
                        "period ",
                        inv.invoicePeriodStartDate.slice(0, 10),
                        inv.invoicePeriodEndDate
                            ? ` → ${inv.invoicePeriodEndDate.slice(0, 10)}`
                            : "")),
                    inv.dueDate && (React.createElement("span", null,
                        "due ",
                        inv.dueDate.slice(0, 10))), (_b = inv.documentUrls) === null || _b === void 0 ? void 0 :
                    _b.map((d) => (React.createElement("span", { key: d.url, className: "inline-flex items-center gap-0.5" },
                        React.createElement("a", { href: d.url, target: "_blank", rel: "noopener noreferrer", className: "inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" },
                            React.createElement(ExternalLink, { className: "h-3 w-3" }),
                            d.kind),
                        React.createElement(CopyButton, { value: d.url, ariaLabel: `Copy ${d.kind} URL` })))))));
        })))));
};
/* ----- Reservations ------------------------------------------------- */
const ReservationsTab = ({ armToken }) => {
    const ros = useAsyncLoad(() => listReservationOrders(armToken), [armToken]);
    const [search, setSearch] = React.useState("");
    const [statusFilter, setStatusFilter] = React.useState("all");
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
        var _a, _b, _c, _d;
        const list = (_a = ros.data) !== null && _a !== void 0 ? _a : [];
        let active = 0;
        let expiringSoon = 0;
        let expired = 0;
        let totalReservations = 0;
        for (const r of list) {
            const state = ((_b = r.provisioningState) !== null && _b !== void 0 ? _b : "").toLowerCase();
            const expiry = (_d = (_c = r.expiryDate) === null || _c === void 0 ? void 0 : _c.slice(0, 10)) !== null && _d !== void 0 ? _d : "";
            if (typeof r.reservations === "number")
                totalReservations += r.reservations;
            if (expiry && expiry < todayIso)
                expired++;
            else if (expiry && expiry <= expiringCutoff)
                expiringSoon++;
            else if (state === "succeeded" ||
                state === "active" ||
                state === "creating" ||
                state === "")
                active++;
        }
        return { total: list.length, active, expiringSoon, expired, totalReservations };
    }, [ros.data, expiringCutoff, todayIso]);
    const filtered = React.useMemo(() => {
        var _a;
        const list = (_a = ros.data) !== null && _a !== void 0 ? _a : [];
        const q = search.trim().toLowerCase();
        return list.filter((r) => {
            var _a, _b;
            const expiry = (_b = (_a = r.expiryDate) === null || _a === void 0 ? void 0 : _a.slice(0, 10)) !== null && _b !== void 0 ? _b : "";
            if (statusFilter === "expiringSoon") {
                if (!expiry || expiry < todayIso || expiry > expiringCutoff)
                    return false;
            }
            else if (statusFilter === "expired") {
                if (!expiry || expiry >= todayIso)
                    return false;
            }
            else if (statusFilter === "active") {
                if (expiry && expiry < todayIso)
                    return false;
            }
            if (!q)
                return true;
            return [r.displayName, r.name, r.term, r.billingPlan, r.provisioningState]
                .join(" ")
                .toLowerCase()
                .includes(q);
        });
    }, [ros.data, search, statusFilter, todayIso, expiringCutoff]);
    return (React.createElement(TabCard, { title: "Reservation orders", description: "Tenant-wide list. Microsoft.Capacity isn't strictly scoped to the billing account, so this surfaces every order the caller can see.", icon: Database, onReload: ros.reload, reloading: ros.loading, action: ros.data && ros.data.length > 0 ? (React.createElement(ExportMenu, { rows: filtered, columns: [
                { header: "Name", accessor: (r) => r.name },
                { header: "DisplayName", accessor: (r) => { var _a; return (_a = r.displayName) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Term", accessor: (r) => { var _a; return (_a = r.term) !== null && _a !== void 0 ? _a : ""; } },
                { header: "BillingPlan", accessor: (r) => { var _a; return (_a = r.billingPlan) !== null && _a !== void 0 ? _a : ""; } },
                { header: "ProvisioningState", accessor: (r) => { var _a; return (_a = r.provisioningState) !== null && _a !== void 0 ? _a : ""; } },
                { header: "BenefitStartTime", accessor: (r) => { var _a; return (_a = r.benefitStartTime) !== null && _a !== void 0 ? _a : ""; } },
                { header: "ExpiryDate", accessor: (r) => { var _a; return (_a = r.expiryDate) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Reservations", accessor: (r) => { var _a; return (_a = r.reservations) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Id", accessor: (r) => r.id },
            ], filename: "reservation-orders" })) : undefined },
        React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Reservation orders summary" },
            React.createElement(SummaryStatItem, { label: "Total", value: counts.total, compact: true }),
            React.createElement(SummaryStatItem, { label: "Active", value: counts.active, compact: true, tone: counts.active > 0 ? "success" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Expiring 90d", value: counts.expiringSoon, compact: true, tone: counts.expiringSoon > 0 ? "warning" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Expired", value: counts.expired, compact: true, tone: counts.expired > 0 ? "destructive" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Reservations", value: counts.totalReservations, compact: true, hint: "sum across orders" })),
        React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Quick filters" }, [
            { key: "all", label: "All", count: counts.total },
            { key: "active", label: "Active", count: counts.active },
            { key: "expiringSoon", label: "Expiring 90d", count: counts.expiringSoon },
            { key: "expired", label: "Expired", count: counts.expired },
        ].map(({ key, label, count }) => (React.createElement(Button, { key: key, type: "button", variant: statusFilter === key ? "default" : "ghost", size: "sm", className: "h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring", onClick: () => setStatusFilter(key), "aria-pressed": statusFilter === key, "aria-label": `Show ${label.toLowerCase()} reservations` },
            label,
            React.createElement(Badge, { variant: statusFilter === key ? "secondary" : "outline", className: "ml-1 h-4 px-1 text-[9px]" }, count))))),
        React.createElement("div", { className: "relative" },
            React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
            React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search reservation name, term, plan\u2026", className: "pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Filter reservation orders" })),
        ros.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 3 })) : ros.error ? (React.createElement(ErrorState, { message: "Failed to load reservation orders.", detail: ros.error, size: "compact" })) : filtered.length === 0 ? (React.createElement(EmptyState, { icon: Database, title: search ? "No matching reservations" : "No reservation orders", description: search
                ? "Adjust your filter to see results."
                : "This tenant has no reserved-instance orders, or your account lacks permission to view them.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, filtered.map((r) => {
            var _a, _b, _c, _d;
            const expiry = (_b = (_a = r.expiryDate) === null || _a === void 0 ? void 0 : _a.slice(0, 10)) !== null && _b !== void 0 ? _b : "";
            const isExpired = !!expiry && expiry < todayIso;
            const isExpiringSoon = !!expiry && !isExpired && expiry <= expiringCutoff;
            return (React.createElement("li", { key: r.id, className: cn("flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs", isExpired && "border-destructive/30 bg-destructive/5", !isExpired && isExpiringSoon && "border-warning/30 bg-warning/5", !isExpired && !isExpiringSoon && "border-border") },
                React.createElement(Database, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                React.createElement("span", { className: "font-medium" }, (_c = r.displayName) !== null && _c !== void 0 ? _c : r.name),
                React.createElement(CopyableText, { value: r.name, mono: true }),
                r.term && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, r.term)),
                r.billingPlan && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, r.billingPlan)),
                r.provisioningState && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, r.provisioningState)),
                isExpired && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" }, "expired")),
                !isExpired && isExpiringSoon && (React.createElement(Badge, { variant: "warning", className: "text-2xs" }, "expiring 90d")),
                React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" }, (_d = r.benefitStartTime) === null || _d === void 0 ? void 0 :
                    _d.slice(0, 10),
                    r.expiryDate ? ` → ${r.expiryDate.slice(0, 10)}` : "",
                    r.reservations !== undefined ? ` · ${r.reservations} resv` : "")));
        })))));
};
/* ----- Policies ----------------------------------------------------- */
const PoliciesTab = ({ armToken, billingAccountName, accountUsername, store }) => {
    var _a, _b, _c;
    const pol = useAsyncLoad(() => getEaBillingPolicy(billingAccountName, armToken), [armToken, billingAccountName]);
    const [draft, setDraft] = React.useState(null);
    const [saving, setSaving] = React.useState(false);
    const [saveError, setSaveError] = React.useState(null);
    React.useEffect(() => {
        if (pol.data)
            setDraft(Object.assign({}, pol.data));
    }, [pol.data]);
    const dirty = React.useMemo(() => {
        if (!draft || !pol.data)
            return false;
        return (draft.marketplacePurchases !== pol.data.marketplacePurchases ||
            draft.reservationPurchases !== pol.data.reservationPurchases ||
            draft.savingsPlanPurchases !== pol.data.savingsPlanPurchases ||
            draft.enterpriseAgreementDevTestEnabled !==
                pol.data.enterpriseAgreementDevTestEnabled);
    }, [draft, pol.data]);
    // Browser-tab guard so a Cmd+R / X-tab close doesn't silently discard
    // pending billing-policy edits before the operator clicks Save.
    useBeforeUnload(dirty, "EA billing policy has unsaved changes. Leave anyway?");
    const save = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!draft)
            return;
        setSaving(true);
        setSaveError(null);
        try {
            const updated = yield updateEaBillingPolicy(billingAccountName, {
                marketplacePurchases: draft.marketplacePurchases,
                reservationPurchases: draft.reservationPurchases,
                savingsPlanPurchases: draft.savingsPlanPurchases,
                enterpriseAgreementDevTestEnabled: draft.enterpriseAgreementDevTestEnabled,
            }, armToken);
            auditLog.record({
                actor: accountUsername,
                action: "update_billing_policy",
                target: billingAccountName,
                status: "success",
                details: Object.assign({}, updated),
            });
            setDraft(updated);
            store.addNotification({ type: "success", message: "Billing policy updated." });
            pol.reload();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setSaveError(msg);
            auditLog.record({
                actor: accountUsername,
                action: "update_billing_policy",
                target: billingAccountName,
                status: "failure",
                error: msg,
            });
        }
        finally {
            setSaving(false);
        }
    }), [draft, armToken, billingAccountName, accountUsername, store, pol]);
    const POLICY_VALUES = [
        { value: "Allowed", label: "Allowed" },
        { value: "NotAllowed", label: "Not allowed" },
    ];
    return (React.createElement(TabCard, { title: "Billing policies", description: "Governs marketplace, reservation, and savings-plan purchases plus dev-test pricing eligibility.", icon: Sliders, onReload: pol.reload, reloading: pol.loading, action: React.createElement(Button, { type: "button", size: "sm", className: "h-7 text-xs", disabled: !dirty || saving, onClick: () => void save(), loading: saving },
            !saving && React.createElement(Check, null),
            "Save") },
        pol.loading ? (React.createElement(SkeletonLoader, { variant: "form", rows: 3 })) : pol.error ? (React.createElement(ErrorState, { message: "Failed to load billing policies.", detail: pol.error, size: "compact" })) : !draft ? null : (React.createElement("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-2" },
            React.createElement(PolicySelect, { label: "Marketplace purchases", value: (_a = draft.marketplacePurchases) !== null && _a !== void 0 ? _a : "", onChange: (v) => setDraft(Object.assign(Object.assign({}, draft), { marketplacePurchases: v })), options: POLICY_VALUES }),
            React.createElement(PolicySelect, { label: "Reservation purchases", value: (_b = draft.reservationPurchases) !== null && _b !== void 0 ? _b : "", onChange: (v) => setDraft(Object.assign(Object.assign({}, draft), { reservationPurchases: v })), options: POLICY_VALUES }),
            React.createElement(PolicySelect, { label: "Savings plan purchases", value: (_c = draft.savingsPlanPurchases) !== null && _c !== void 0 ? _c : "", onChange: (v) => setDraft(Object.assign(Object.assign({}, draft), { savingsPlanPurchases: v })), options: POLICY_VALUES }),
            React.createElement("label", { className: "flex items-start gap-2 text-xs" },
                React.createElement(Checkbox, { checked: !!draft.enterpriseAgreementDevTestEnabled, onCheckedChange: (v) => setDraft(Object.assign(Object.assign({}, draft), { enterpriseAgreementDevTestEnabled: v === true })) }),
                React.createElement("span", { className: "flex flex-col gap-0.5" },
                    React.createElement("span", { className: "font-medium" }, "EA Dev/Test pricing"),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Enables Dev/Test rates on subscriptions provisioned under this enrollment."))))),
        saveError && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertDescription, null, saveError)))));
};
const PolicySelect = ({ label, value, onChange, options }) => (React.createElement("div", { className: "flex flex-col gap-1.5" },
    React.createElement(Label, { className: "text-xs" }, label),
    React.createElement(Select, { value: value, onValueChange: onChange },
        React.createElement(SelectTrigger, null,
            React.createElement(SelectValue, { placeholder: "\u2014" })),
        React.createElement(SelectContent, null, options.map((o) => (React.createElement(SelectItem, { key: o.value, value: o.value }, o.label)))))));
/* ----- Transactions (Round-2 #1) ------------------------------------ */
const TransactionsTab = ({ armToken, billingAccountName }) => {
    const [from, setFrom] = React.useState("");
    const [to, setTo] = React.useState("");
    const [search, setSearch] = React.useState("");
    const [kindFilter, setKindFilter] = React.useState("all");
    const rangeInverted = !!(from && to && from > to);
    const tx = useAsyncLoad(() => rangeInverted
        ? null
        : listEaTransactions(billingAccountName, armToken, {
            periodStartDate: from || undefined,
            periodEndDate: to || undefined,
        }), [armToken, billingAccountName, from, to, rangeInverted]);
    // Bucket transactions by an inferred kind so the chip filter is
    // useful even when EA returns inconsistent capitalization
    // ("Purchase" vs "purchase") across tenants.
    const inferBucket = React.useCallback((t) => {
        var _a, _b;
        const k = `${(_a = t.transactionType) !== null && _a !== void 0 ? _a : ""} ${(_b = t.kind) !== null && _b !== void 0 ? _b : ""}`.toLowerCase();
        if (k.includes("refund") || k.includes("credit"))
            return "refund";
        if (k.includes("purchase") || k.includes("buy") || k.includes("renew"))
            return "purchase";
        if (k.includes("usage") || k.includes("consumption"))
            return "usage";
        // Falls into the catch-all bucket — visible only under "All".
        return "all";
    }, []);
    const filtered = React.useMemo(() => {
        var _a;
        const list = (_a = tx.data) !== null && _a !== void 0 ? _a : [];
        const q = search.trim().toLowerCase();
        return list.filter((t) => {
            if (kindFilter !== "all" && inferBucket(t) !== kindFilter)
                return false;
            if (!q)
                return true;
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
        var _a;
        const list = (_a = tx.data) !== null && _a !== void 0 ? _a : [];
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
            if (bucket === "purchase")
                purchases++;
            else if (bucket === "refund")
                refunds++;
        }
        return { count: list.length, total, currency, purchases, refunds };
    }, [tx.data, inferBucket]);
    return (React.createElement(TabCard, { title: "Transactions", description: "Charge / refund / purchase ledger. Defaults to the last 60 days.", icon: FileText, onReload: tx.reload, reloading: tx.loading, action: tx.data && tx.data.length > 0 ? (React.createElement(ExportMenu, { rows: filtered, columns: [
                { header: "Name", accessor: (t) => t.name },
                { header: "ProductDescription", accessor: (t) => { var _a; return (_a = t.productDescription) !== null && _a !== void 0 ? _a : ""; } },
                { header: "TransactionType", accessor: (t) => { var _a; return (_a = t.transactionType) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Kind", accessor: (t) => { var _a; return (_a = t.kind) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Amount", accessor: (t) => { var _a, _b; return (_b = (_a = t.transactionAmount) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : ""; } },
                { header: "Currency", accessor: (t) => { var _a, _b; return (_b = (_a = t.transactionAmount) === null || _a === void 0 ? void 0 : _a.currency) !== null && _b !== void 0 ? _b : ""; } },
                { header: "SubscriptionName", accessor: (t) => { var _a; return (_a = t.subscriptionName) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Invoice", accessor: (t) => { var _a; return (_a = t.invoice) !== null && _a !== void 0 ? _a : ""; } },
                { header: "TransactionDate", accessor: (t) => { var _a; return (_a = t.transactionDate) !== null && _a !== void 0 ? _a : ""; } },
                { header: "Id", accessor: (t) => t.id },
            ], filename: `ea-transactions-${billingAccountName}` })) : undefined },
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement(Label, { className: "text-xs", htmlFor: "ea-tx-from" }, "From"),
            React.createElement(Input, { id: "ea-tx-from", type: "date", value: from, onChange: (e) => setFrom(e.target.value), className: "w-44 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Transactions period start date" }),
            React.createElement(Label, { className: "text-xs", htmlFor: "ea-tx-to" }, "To"),
            React.createElement(Input, { id: "ea-tx-to", type: "date", value: to, onChange: (e) => setTo(e.target.value), className: "w-44 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Transactions period end date" })),
        rangeInverted && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertDescription, null, "\"From\" date is after \"To\" date \u2014 adjust the range to load transactions."))),
        React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Transactions summary" },
            React.createElement(SummaryStatItem, { label: "Count", value: totals.count, compact: true }),
            React.createElement(SummaryStatItem, { label: "Net", value: `${totals.total.toLocaleString()} ${totals.currency}`, compact: true, tone: totals.total < 0 ? "success" : undefined }),
            React.createElement(SummaryStatItem, { label: "Purchases", value: totals.purchases, compact: true, tone: totals.purchases > 0 ? "info" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Refunds", value: totals.refunds, compact: true, tone: totals.refunds > 0 ? "success" : "muted" })),
        React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Transactions quick filters" }, ["all", "purchase", "refund", "usage"].map((k) => (React.createElement(Button, { key: k, type: "button", variant: kindFilter === k ? "default" : "ghost", size: "sm", className: "h-7 text-2xs focus-visible:ring-2 focus-visible:ring-ring", onClick: () => setKindFilter(k), "aria-pressed": kindFilter === k }, k === "all"
            ? "All"
            : k === "purchase"
                ? "Purchases"
                : k === "refund"
                    ? "Refunds"
                    : "Usage")))),
        React.createElement("div", { className: "relative" },
            React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
            React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search product, kind, sub id, invoice\u2026", className: "pl-8 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Filter transactions" })),
        tx.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 4 })) : tx.error ? (React.createElement(ErrorState, { message: "Failed to load transactions.", detail: tx.error, size: "compact" })) : filtered.length === 0 ? (React.createElement(EmptyState, { icon: FileText, title: search ? "No matching transactions" : "No transactions in this range", description: search
                ? "Adjust your filter to see results."
                : "Expand the period to surface more charges / refunds, or check the date filters above.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, filtered.map((t) => {
            var _a, _b;
            return (React.createElement("li", { key: t.id, className: "flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs" },
                React.createElement(FileText, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                React.createElement("span", { className: "font-medium" }, (_a = t.productDescription) !== null && _a !== void 0 ? _a : t.name),
                t.transactionType && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, t.transactionType)),
                t.kind && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, t.kind)),
                t.transactionAmount && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                    t.transactionAmount.value.toLocaleString(),
                    " ",
                    t.transactionAmount.currency)),
                t.subscriptionName && (React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs text-muted-foreground" },
                    "sub: ",
                    React.createElement(CopyableText, { value: t.subscriptionName, mono: true }))),
                React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" }, (_b = t.transactionDate) === null || _b === void 0 ? void 0 :
                    _b.slice(0, 10),
                    t.invoice ? ` · invoice ${t.invoice}` : "")));
        })))));
};
/* ----- Transfers (Round-2 #2 + #3) ---------------------------------- */
const TransfersTab = ({ armToken, billingAccountName, accountUsername, store }) => {
    var _a, _b, _c, _d, _e;
    const profiles = useAsyncLoad(() => listBillingProfiles(billingAccountName, armToken), [armToken, billingAccountName]);
    const [profileName, setProfileName] = React.useState("");
    const [sectionName, setSectionName] = React.useState("");
    const sections = useAsyncLoad(() => profileName
        ? listInvoiceSections(billingAccountName, profileName, armToken)
        : null, [armToken, billingAccountName, profileName]);
    const outbound = useAsyncLoad(() => profileName && sectionName
        ? listOutboundTransfers(billingAccountName, profileName, sectionName, armToken)
        : null, [armToken, billingAccountName, profileName, sectionName]);
    const inbound = useAsyncLoad(() => listInboundTransfers(armToken), [armToken]);
    // Auto-pick the first profile / section.
    React.useEffect(() => {
        if (profiles.data && profiles.data.length > 0 && !profileName) {
            setProfileName(profiles.data[0].name);
        }
    }, [profiles.data, profileName]);
    React.useEffect(() => {
        var _a, _b, _c;
        if (sections.data && sections.data.length > 0 && !sectionName) {
            setSectionName(sections.data[0].name);
        }
        if (sections.data && !sections.data.some((s) => s.name === sectionName)) {
            setSectionName((_c = (_b = (_a = sections.data) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : "");
        }
    }, [sections.data, sectionName]);
    const [recipient, setRecipient] = React.useState("");
    const [reseller, setReseller] = React.useState("");
    const [creating, setCreating] = React.useState(false);
    const [createError, setCreateError] = React.useState(null);
    const [confirmCreate, setConfirmCreate] = React.useState(false);
    const [pendingInbound, setPendingInbound] = React.useState(null);
    const [inboundBusyId, setInboundBusyId] = React.useState(null);
    // Per-status counts surface "how many pending invites are out there"
    // at a glance so an EA admin doesn't need to scroll the list.
    const outboundCounts = React.useMemo(() => {
        var _a, _b;
        const list = (_a = outbound.data) !== null && _a !== void 0 ? _a : [];
        let pending = 0;
        let accepted = 0;
        let declined = 0;
        let expired = 0;
        for (const t of list) {
            const s = ((_b = t.transferStatus) !== null && _b !== void 0 ? _b : "").toLowerCase();
            if (s.includes("pending") || s.includes("inprogress"))
                pending++;
            else if (s.includes("complete") || s.includes("accept"))
                accepted++;
            else if (s.includes("decline") || s.includes("reject"))
                declined++;
            else if (s.includes("expire") || s.includes("cancel"))
                expired++;
        }
        return { total: list.length, pending, accepted, declined, expired };
    }, [outbound.data]);
    const submitCreate = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _f, _g;
        if (!profileName || !sectionName || !recipient.trim())
            return;
        setConfirmCreate(false);
        const recipientEmail = recipient.trim();
        setCreating(true);
        setCreateError(null);
        try {
            const t = yield createOutboundTransfer(billingAccountName, profileName, sectionName, recipientEmail, reseller.trim() || undefined, armToken);
            auditLog.record({
                actor: accountUsername,
                action: "create_outbound_transfer",
                target: recipientEmail,
                status: "success",
                details: { billingAccountName, profileName, sectionName, id: t.id },
            });
            store.addNotification({
                type: "success",
                message: `Transfer invitation created. Expires ${(_g = (_f = t.expirationTime) === null || _f === void 0 ? void 0 : _f.slice(0, 10)) !== null && _g !== void 0 ? _g : "soon"}.`,
            });
            setRecipient("");
            setReseller("");
            outbound.reload();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Idempotent: 409 "already invited" is treated as success so a
            // re-run doesn't produce noise. We log to audit either way so
            // the trail captures the (no-op) attempt.
            const isConflict = /(^|\W)(409|conflict|already\s*exists|already\s*invited)(\W|$)/i.test(msg);
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
            }
            else {
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
        }
        finally {
            setCreating(false);
        }
    }), [armToken, billingAccountName, profileName, sectionName, recipient, reseller, accountUsername, store, outbound]);
    const runInboundAction = React.useCallback((transfer, action) => __awaiter(void 0, void 0, void 0, function* () {
        setInboundBusyId(transfer.id);
        try {
            if (action === "accept") {
                yield acceptInboundTransfer(transfer.id, armToken);
            }
            else {
                yield declineInboundTransfer(transfer.id, armToken);
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
        }
        catch (err) {
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
        }
        finally {
            setInboundBusyId(null);
            setPendingInbound(null);
        }
    }), [armToken, accountUsername, store, inbound]);
    return (React.createElement("div", { className: "flex flex-col gap-3" },
        React.createElement(TabCard, { title: "Outbound transfers", description: "Initiate ownership transfer of subscriptions / products from this scope to another billing recipient. Per Microsoft.Billing/billingProfiles/{bp}/invoiceSections/{is}/transfers.", icon: Copy, onReload: outbound.reload, reloading: outbound.loading, action: outbound.data && outbound.data.length > 0 ? (React.createElement(ExportMenu, { rows: outbound.data, columns: [
                    { header: "Recipient", accessor: (t) => { var _a; return (_a = t.recipientEmailId) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Status", accessor: (t) => { var _a; return (_a = t.transferStatus) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Expiration", accessor: (t) => { var _a; return (_a = t.expirationTime) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Id", accessor: (t) => t.id },
                ], filename: `outbound-transfers-${billingAccountName}` })) : undefined },
            React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Billing profile"),
                    React.createElement(Select, { value: profileName, onValueChange: setProfileName, disabled: !((_a = profiles.data) === null || _a === void 0 ? void 0 : _a.length) },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: profiles.loading ? "Loading…" : "Pick a profile" })),
                        React.createElement(SelectContent, null, ((_b = profiles.data) !== null && _b !== void 0 ? _b : []).map((p) => (React.createElement(SelectItem, { key: p.name, value: p.name }, p.displayName)))))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Invoice section"),
                    React.createElement(Select, { value: sectionName, onValueChange: setSectionName, disabled: !((_c = sections.data) === null || _c === void 0 ? void 0 : _c.length) },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: sections.loading ? "Loading…" : "Pick a section" })),
                        React.createElement(SelectContent, null, ((_d = sections.data) !== null && _d !== void 0 ? _d : []).map((s) => (React.createElement(SelectItem, { key: s.name, value: s.name }, s.displayName))))))),
            React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5 sm:col-span-2" },
                    React.createElement(Label, { className: "text-xs" }, "Recipient email *"),
                    React.createElement(Input, { value: recipient, onChange: (e) => setRecipient(e.target.value), placeholder: "bob@partner.example", className: "text-xs" })),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Reseller id (optional)"),
                    React.createElement(Input, { value: reseller, onChange: (e) => setReseller(e.target.value), className: "font-mono text-xs" }))),
            createError && (React.createElement(Alert, { variant: "destructive" },
                React.createElement(AlertDescription, null, createError))),
            React.createElement("div", null,
                React.createElement(Button, { type: "button", onClick: () => setConfirmCreate(true), disabled: creating || !recipient.trim() || !profileName || !sectionName, loading: creating },
                    !creating && React.createElement(Plus, null),
                    "Send transfer invite")),
            outbound.data && outbound.data.length > 0 && (React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Outbound transfers summary" },
                React.createElement(SummaryStatItem, { label: "Total", value: outboundCounts.total, compact: true }),
                React.createElement(SummaryStatItem, { label: "Pending", value: outboundCounts.pending, compact: true, tone: outboundCounts.pending > 0 ? "warning" : "muted" }),
                React.createElement(SummaryStatItem, { label: "Accepted", value: outboundCounts.accepted, compact: true, tone: outboundCounts.accepted > 0 ? "success" : "muted" }),
                React.createElement(SummaryStatItem, { label: "Declined", value: outboundCounts.declined, compact: true, tone: outboundCounts.declined > 0 ? "destructive" : "muted" }),
                React.createElement(SummaryStatItem, { label: "Expired", value: outboundCounts.expired, compact: true, tone: outboundCounts.expired > 0 ? "warning" : "muted" }))),
            outbound.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 2 })) : outbound.error ? (React.createElement(ErrorState, { message: "Failed to list outbound transfers.", detail: outbound.error, size: "compact" })) : !outbound.data || outbound.data.length === 0 ? (React.createElement(EmptyState, { icon: Copy, title: "No outbound transfers", description: "No transfer invitations have been sent from this billing scope yet.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, outbound.data.map((t) => {
                var _a, _b;
                return (React.createElement("li", { key: t.id, className: "flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs" },
                    React.createElement(Copy, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                    React.createElement("span", null, t.recipientEmailId),
                    t.transferStatus && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, t.transferStatus)),
                    React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" },
                        "exp ", (_b = (_a = t.expirationTime) === null || _a === void 0 ? void 0 : _a.slice(0, 10)) !== null && _b !== void 0 ? _b : "—")));
            })))),
        React.createElement(TabCard, { title: "Inbound (recipient) transfers", description: "Pending transfers visible to the signed-in account. Accept to take ownership; decline to reject.", icon: UserCheck, onReload: inbound.reload, reloading: inbound.loading, action: inbound.data && inbound.data.length > 0 ? (React.createElement(ExportMenu, { rows: inbound.data, columns: [
                    { header: "Initiator", accessor: (t) => { var _a; return (_a = t.initiatorEmailId) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Status", accessor: (t) => { var _a; return (_a = t.transferStatus) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Expiration", accessor: (t) => { var _a; return (_a = t.expirationTime) !== null && _a !== void 0 ? _a : ""; } },
                    { header: "Name", accessor: (t) => t.name },
                    { header: "Id", accessor: (t) => t.id },
                ], filename: "inbound-transfers" })) : undefined }, inbound.loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 2 })) : inbound.error ? (React.createElement(ErrorState, { message: "Failed to list inbound transfers.", detail: inbound.error, size: "compact" })) : !inbound.data || inbound.data.length === 0 ? (React.createElement(EmptyState, { icon: UserCheck, title: "No inbound transfers pending", description: "You have no transfer invitations awaiting your accept / decline.", size: "compact" })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, inbound.data.map((t) => {
            var _a, _b, _c, _d, _e;
            return (React.createElement("li", { key: t.id, className: "flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs" },
                React.createElement(UserCheck, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                React.createElement("span", null, (_a = t.initiatorEmailId) !== null && _a !== void 0 ? _a : "—"),
                React.createElement("span", { className: "text-muted-foreground" }, "\u2192 you"),
                t.transferStatus && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, t.transferStatus)),
                React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    "exp ", (_c = (_b = t.expirationTime) === null || _b === void 0 ? void 0 : _b.slice(0, 10)) !== null && _c !== void 0 ? _c : "—"),
                React.createElement("span", { className: "ml-auto flex items-center gap-1" },
                    React.createElement(Button, { type: "button", variant: "default", size: "sm", className: "h-6 text-2xs focus-visible:ring-2 focus-visible:ring-ring", disabled: inboundBusyId === t.id, loading: inboundBusyId === t.id && (pendingInbound === null || pendingInbound === void 0 ? void 0 : pendingInbound.action) === "accept", onClick: () => setPendingInbound({ transfer: t, action: "accept" }), "aria-label": `Accept transfer from ${(_d = t.initiatorEmailId) !== null && _d !== void 0 ? _d : "sender"}` }, "Accept"),
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs focus-visible:ring-2 focus-visible:ring-ring", disabled: inboundBusyId === t.id, loading: inboundBusyId === t.id && (pendingInbound === null || pendingInbound === void 0 ? void 0 : pendingInbound.action) === "decline", onClick: () => setPendingInbound({ transfer: t, action: "decline" }), "aria-label": `Decline transfer from ${(_e = t.initiatorEmailId) !== null && _e !== void 0 ? _e : "sender"}` }, "Decline"))));
        })))),
        React.createElement(ConfirmationDialog, { hidden: !pendingInbound, title: (pendingInbound === null || pendingInbound === void 0 ? void 0 : pendingInbound.action) === "accept"
                ? "Accept inbound transfer"
                : "Decline inbound transfer", message: `${(pendingInbound === null || pendingInbound === void 0 ? void 0 : pendingInbound.action) === "accept" ? "Accept" : "Decline"} transfer from ${(_e = pendingInbound === null || pendingInbound === void 0 ? void 0 : pendingInbound.transfer.initiatorEmailId) !== null && _e !== void 0 ? _e : "sender"}?`, confirmText: (pendingInbound === null || pendingInbound === void 0 ? void 0 : pendingInbound.action) === "accept" ? "Accept" : "Decline", cancelText: "Cancel", danger: (pendingInbound === null || pendingInbound === void 0 ? void 0 : pendingInbound.action) === "decline", loading: inboundBusyId === (pendingInbound === null || pendingInbound === void 0 ? void 0 : pendingInbound.transfer.id), onConfirm: () => {
                if (pendingInbound)
                    void runInboundAction(pendingInbound.transfer, pendingInbound.action);
            }, onCancel: () => setPendingInbound(null) }),
        React.createElement(ConfirmationDialog, { hidden: !confirmCreate, title: "Send transfer invitation", message: React.createElement("div", { className: "space-y-2 text-sm" },
                React.createElement("p", null,
                    "Send a billing-ownership transfer invite to",
                    " ",
                    React.createElement("strong", { className: "font-mono" }, recipient.trim() || "—"),
                    "?"),
                React.createElement("p", { className: "text-xs text-muted-foreground" },
                    "They have 14 days to accept. Once accepted, every subscription and product currently billed under",
                    " ",
                    React.createElement("strong", null, sectionName || "this section"),
                    " moves to their billing account. This is reversible only by another transfer."),
                recipient.trim() &&
                    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim()) && (React.createElement("p", { className: "text-xs text-warning" },
                    React.createElement(AlertTriangle, { className: "mr-1 inline h-3 w-3", "aria-hidden": true }),
                    "The recipient doesn't look like a valid email \u2014 double-check before sending."))), confirmText: "Send invite", cancelText: "Cancel", loading: creating, onConfirm: () => void submitCreate(), onCancel: () => setConfirmCreate(false) })));
};
/* ----- Customization tab — profile PATCH + IS create + custom roles + address ---- */
const CustomizationTab = ({ armToken, billingAccountName, accountUsername, store }) => {
    return (React.createElement("div", { className: "flex flex-col gap-3" },
        React.createElement(ProfilePatchCard, { armToken: armToken, billingAccountName: billingAccountName, accountUsername: accountUsername, store: store }),
        React.createElement(InvoiceSectionCreateCard, { armToken: armToken, billingAccountName: billingAccountName, accountUsername: accountUsername, store: store }),
        React.createElement(CustomRoleCreateCard, { armToken: armToken, billingAccountName: billingAccountName, accountUsername: accountUsername, store: store }),
        React.createElement(AddressValidateCard, { armToken: armToken })));
};
const ProfilePatchCard = ({ armToken, billingAccountName, accountUsername, store }) => {
    var _a, _b;
    const profiles = useAsyncLoad(() => listBillingProfiles(billingAccountName, armToken), [armToken, billingAccountName]);
    const [profileName, setProfileName] = React.useState("");
    const [displayName, setDisplayName] = React.useState("");
    const [poNumber, setPoNumber] = React.useState("");
    const [emailOptIn, setEmailOptIn] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    // Track the original (server-side) values so we can compute a diff
    // for the confirmation dialog AND show a "dirty" indicator on Save.
    const originalRef = React.useRef(null);
    React.useEffect(() => {
        if (profiles.data && profiles.data.length > 0 && !profileName) {
            const first = profiles.data[0];
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
        var _a;
        if (!profileName)
            return;
        const p = ((_a = profiles.data) !== null && _a !== void 0 ? _a : []).find((x) => x.name === profileName);
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
        if (!orig)
            return [];
        const changes = [];
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
    const submit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!profileName)
            return;
        setConfirmOpen(false);
        setSubmitting(true);
        setError(null);
        try {
            yield patchBillingProfile(billingAccountName, profileName, {
                displayName: displayName.trim() || undefined,
                poNumber: poNumber.trim() || undefined,
                invoiceEmailOptIn: emailOptIn,
            }, armToken);
            auditLog.record({
                actor: accountUsername,
                action: "patch_billing_profile",
                target: profileName,
                status: "success",
                details: { displayName, poNumber, emailOptIn },
            });
            store.addNotification({ type: "success", message: "Billing profile updated." });
            profiles.reload();
        }
        catch (err) {
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
        }
        finally {
            setSubmitting(false);
        }
    }), [armToken, billingAccountName, profileName, displayName, poNumber, emailOptIn, accountUsername, store, profiles]);
    return (React.createElement(TabCard, { title: "Patch billing profile", description: "PATCH /billingProfiles/{bp} \u2014 edit display name, PO number, invoice email opt-in.", icon: Sliders },
        React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Billing profile"),
                React.createElement(Select, { value: profileName, onValueChange: setProfileName, disabled: !((_a = profiles.data) === null || _a === void 0 ? void 0 : _a.length) },
                    React.createElement(SelectTrigger, null,
                        React.createElement(SelectValue, { placeholder: profiles.loading ? "Loading…" : "Pick a profile" })),
                    React.createElement(SelectContent, null, ((_b = profiles.data) !== null && _b !== void 0 ? _b : []).map((p) => (React.createElement(SelectItem, { key: p.name, value: p.name }, p.displayName)))))),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Display name"),
                React.createElement(Input, { value: displayName, onChange: (e) => setDisplayName(e.target.value), className: "text-xs" })),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "PO number"),
                React.createElement(Input, { value: poNumber, onChange: (e) => setPoNumber(e.target.value), className: "text-xs" })),
            React.createElement("label", { className: "flex items-center gap-2 text-xs" },
                React.createElement(Checkbox, { checked: emailOptIn, onCheckedChange: (v) => setEmailOptIn(v === true) }),
                React.createElement("span", null, "Email invoices to billing contacts"))),
        error && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertDescription, null, error))),
        React.createElement("div", { className: "flex items-center gap-2" },
            React.createElement(Button, { type: "button", onClick: () => setConfirmOpen(true), disabled: submitting || !profileName || dirtyDiff.length === 0, loading: submitting },
                !submitting && React.createElement(Check, null),
                "Save profile"),
            dirtyDiff.length > 0 && (React.createElement("span", { className: "text-2xs text-warning" },
                dirtyDiff.length,
                " unsaved change",
                dirtyDiff.length === 1 ? "" : "s"))),
        React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: "Patch billing profile", message: React.createElement("div", { className: "space-y-2 text-sm" },
                React.createElement("p", null,
                    "Apply the following change",
                    dirtyDiff.length === 1 ? "" : "s",
                    " to",
                    " ",
                    React.createElement("strong", { className: "font-mono" }, profileName),
                    "?"),
                React.createElement("ul", { className: "space-y-1 text-xs" }, dirtyDiff.map((d) => (React.createElement("li", { key: d.field, className: "rounded border border-border bg-card/40 px-2 py-1" },
                    React.createElement("span", { className: "font-semibold" },
                        d.field,
                        ":"),
                    " ",
                    React.createElement("span", { className: "text-muted-foreground line-through" }, d.before),
                    " → ",
                    React.createElement("span", { className: "text-foreground" }, d.after))))),
                React.createElement("p", { className: "text-xs text-muted-foreground" }, "This mutates the live billing profile. The change is audited.")), confirmText: "Save", cancelText: "Cancel", loading: submitting, onConfirm: () => void submit(), onCancel: () => setConfirmOpen(false) })));
};
const InvoiceSectionCreateCard = ({ armToken, billingAccountName, accountUsername, store }) => {
    var _a;
    const profiles = useAsyncLoad(() => listBillingProfiles(billingAccountName, armToken), [armToken, billingAccountName]);
    const [profileName, setProfileName] = React.useState("");
    const [name, setName] = React.useState("");
    const [displayName, setDisplayName] = React.useState("");
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    // ARM URL segment validation. Section names live in the resource path
    // (.../invoiceSections/{name}) and the EA backend rejects spaces,
    // unicode, and characters outside the slug set.
    const slugError = React.useMemo(() => {
        const v = name.trim();
        if (!v)
            return null;
        if (v.length > 50)
            return "Section name must be 50 characters or fewer.";
        if (!/^[A-Za-z0-9._-]+$/.test(v))
            return "Section name must be alphanumerics, '.', '_' or '-' only.";
        return null;
    }, [name]);
    React.useEffect(() => {
        if (profiles.data && profiles.data.length > 0 && !profileName) {
            setProfileName(profiles.data[0].name);
        }
    }, [profiles.data, profileName]);
    const submit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!profileName || !name.trim() || !displayName.trim())
            return;
        setConfirmOpen(false);
        setSubmitting(true);
        setError(null);
        try {
            yield createInvoiceSection(billingAccountName, profileName, name.trim(), { displayName: displayName.trim() }, armToken);
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Idempotent: 409 means a section with this name already exists.
            // Tell the operator and keep their inputs around so they can
            // pick a different name without retyping displayName.
            const isConflict = /(^|\W)(409|conflict|already\s*exists)(\W|$)/i.test(msg);
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
            }
            else {
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
        }
        finally {
            setSubmitting(false);
        }
    }), [armToken, billingAccountName, profileName, name, displayName, accountUsername, store]);
    return (React.createElement(TabCard, { title: "Create invoice section", description: "PUT /billingProfiles/{bp}/invoiceSections/{name} \u2014 useful for cost-tracking on MCA accounts.", icon: Plus },
        React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-3" },
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Billing profile"),
                React.createElement(Select, { value: profileName, onValueChange: setProfileName },
                    React.createElement(SelectTrigger, null,
                        React.createElement(SelectValue, { placeholder: profiles.loading ? "Loading…" : "Pick a profile" })),
                    React.createElement(SelectContent, null, ((_a = profiles.data) !== null && _a !== void 0 ? _a : []).map((p) => (React.createElement(SelectItem, { key: p.name, value: p.name }, p.displayName)))))),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                    "Section name (URL segment)",
                    React.createElement(InfoTooltip, { content: "Alphanumerics, '.', '_' or '-' only; up to 50 chars. Cannot be renamed after creation \u2014 choose carefully." })),
                React.createElement(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: "my-section-001", className: cn("font-mono text-xs", slugError && "border-destructive focus-visible:ring-destructive"), "aria-invalid": !!slugError, "aria-describedby": slugError ? "invoice-section-slug-error" : undefined }),
                slugError && (React.createElement("span", { id: "invoice-section-slug-error", className: "text-2xs text-destructive" }, slugError))),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Display name"),
                React.createElement(Input, { value: displayName, onChange: (e) => setDisplayName(e.target.value), className: "text-xs" }))),
        error && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertDescription, null, error))),
        React.createElement("div", null,
            React.createElement(Button, { type: "button", onClick: () => setConfirmOpen(true), disabled: submitting ||
                    !profileName ||
                    !name.trim() ||
                    !displayName.trim() ||
                    !!slugError, loading: submitting },
                !submitting && React.createElement(Plus, null),
                "Create")),
        React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: "Create invoice section", message: React.createElement("div", { className: "space-y-2 text-sm" },
                React.createElement("p", null,
                    "Create invoice section",
                    " ",
                    React.createElement("strong", { className: "font-mono" }, name.trim() || "—"),
                    " on profile",
                    " ",
                    React.createElement("strong", { className: "font-mono" }, profileName || "—"),
                    "?"),
                React.createElement("p", { className: "text-xs text-muted-foreground" },
                    "Display name: ",
                    React.createElement("strong", null, displayName.trim() || "—"),
                    ". The section name cannot be changed later.")), confirmText: "Create", cancelText: "Cancel", loading: submitting, onConfirm: () => void submit(), onCancel: () => setConfirmOpen(false) })));
};
const CustomRoleCreateCard = ({ armToken, billingAccountName, accountUsername, store }) => {
    const [roleName, setRoleName] = React.useState("");
    const [description, setDescription] = React.useState("");
    const [actionsText, setActionsText] = React.useState("Microsoft.Billing/billingAccounts/read");
    const [notActionsText, setNotActionsText] = React.useState("");
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    // Sticky receipt of the last-created role so the operator can copy
    // the GUID into a downstream RBAC grant without scrolling the audit
    // log. Cleared when they start typing a new role name.
    const [lastCreated, setLastCreated] = React.useState(null);
    const parseLines = (s) => s.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const actionsParsed = React.useMemo(() => parseLines(actionsText), [actionsText]);
    const notActionsParsed = React.useMemo(() => parseLines(notActionsText), [notActionsText]);
    const submit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!roleName.trim())
            return;
        setConfirmOpen(false);
        setSubmitting(true);
        setError(null);
        const guid = crypto.randomUUID();
        try {
            yield createCustomBillingRoleDefinition(billingAccountName, guid, {
                roleName: roleName.trim(),
                description: description.trim() || undefined,
                permissions: [
                    {
                        actions: actionsParsed,
                        notActions: notActionsParsed,
                    },
                ],
            }, armToken);
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
        }
        catch (err) {
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
        }
        finally {
            setSubmitting(false);
        }
    }), [armToken, billingAccountName, roleName, description, actionsParsed, notActionsParsed, accountUsername, store]);
    return (React.createElement(TabCard, { title: "Create custom billing role", description: "PUT /billingRoleDefinitions/{guid} \u2014 define a custom set of actions / notActions at billing scope. We mint the GUID.", icon: UserPlus },
        React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Role name *"),
                React.createElement(Input, { value: roleName, onChange: (e) => {
                        setRoleName(e.target.value);
                        if (lastCreated)
                            setLastCreated(null);
                    }, className: "text-xs" })),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Description"),
                React.createElement(Input, { value: description, onChange: (e) => setDescription(e.target.value), className: "text-xs" })),
            React.createElement("div", { className: "flex flex-col gap-1.5 sm:col-span-2" },
                React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                    "Actions (one per line)",
                    React.createElement(InfoTooltip, { content: "Each line is a Microsoft.Billing/* action string. Empty lines are dropped." }),
                    React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" },
                        actionsParsed.length,
                        " action",
                        actionsParsed.length === 1 ? "" : "s")),
                React.createElement("textarea", { value: actionsText, onChange: (e) => setActionsText(e.target.value), rows: 4, className: "flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-2xs", "aria-label": "Actions, one per line" })),
            React.createElement("div", { className: "flex flex-col gap-1.5 sm:col-span-2" },
                React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                    "NotActions (one per line)",
                    React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" },
                        notActionsParsed.length,
                        " excluded")),
                React.createElement("textarea", { value: notActionsText, onChange: (e) => setNotActionsText(e.target.value), rows: 2, className: "flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-2xs", "aria-label": "NotActions, one per line" }))),
        error && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertDescription, null, error))),
        lastCreated && (React.createElement(Alert, { variant: "default", className: "text-xs" },
            React.createElement(Check, { className: "h-3.5 w-3.5 text-success" }),
            React.createElement(AlertDescription, null,
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement("span", null,
                        "Created ",
                        React.createElement("strong", null, lastCreated.roleName),
                        ":"),
                    React.createElement(CopyableText, { value: lastCreated.guid, mono: true }),
                    React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-6 text-2xs", onClick: () => setLastCreated(null) }, "Dismiss"))))),
        React.createElement("div", null,
            React.createElement(Button, { type: "button", onClick: () => setConfirmOpen(true), disabled: submitting || !roleName.trim() || actionsParsed.length === 0, loading: submitting },
                !submitting && React.createElement(Plus, null),
                "Create custom role")),
        React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: "Create custom billing role", message: React.createElement("div", { className: "space-y-2 text-sm" },
                React.createElement("p", null,
                    "Create custom role",
                    " ",
                    React.createElement("strong", null,
                        "\u201C",
                        roleName.trim() || "—",
                        "\u201D"),
                    " at billing account ",
                    React.createElement("strong", { className: "font-mono" }, billingAccountName),
                    "?"),
                React.createElement("p", { className: "text-xs text-muted-foreground" },
                    actionsParsed.length,
                    " action",
                    actionsParsed.length === 1 ? "" : "s",
                    " \u00B7",
                    " ",
                    notActionsParsed.length,
                    " notAction",
                    notActionsParsed.length === 1 ? "" : "s",
                    " \u00B7 auto-generated GUID identifier."),
                React.createElement("p", { className: "text-xs text-warning" },
                    React.createElement(AlertTriangle, { className: "mr-1 inline h-3 w-3", "aria-hidden": true }),
                    "Custom billing roles are global to this billing account and cannot be edited after creation \u2014 only re-PUT with the same GUID, or deleted.")), confirmText: "Create", cancelText: "Cancel", loading: submitting, onConfirm: () => void submit(), onCancel: () => setConfirmOpen(false) })));
};
const AddressValidateCard = ({ armToken }) => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const [draft, setDraft] = React.useState({
        addressLine1: "",
        city: "",
        region: "",
        postalCode: "",
        country: "US",
    });
    const [result, setResult] = React.useState(null);
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState(null);
    const set = (k, v) => setDraft(Object.assign(Object.assign({}, draft), { [k]: v }));
    const submit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        setSubmitting(true);
        setError(null);
        setResult(null);
        try {
            const r = yield validateBillingAddress(draft, armToken);
            setResult(r);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setSubmitting(false);
        }
    }), [draft, armToken]);
    return (React.createElement(TabCard, { title: "Validate billing address", description: "POST /providers/Microsoft.Billing/validateAddress \u2014 sanity-check an address before profile PATCH.", icon: Shield },
        React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
            React.createElement(Input, { value: (_a = draft.addressLine1) !== null && _a !== void 0 ? _a : "", onChange: (e) => set("addressLine1", e.target.value), placeholder: "Address line 1 *", className: "text-xs" }),
            React.createElement(Input, { value: (_b = draft.addressLine2) !== null && _b !== void 0 ? _b : "", onChange: (e) => set("addressLine2", e.target.value), placeholder: "Address line 2", className: "text-xs" }),
            React.createElement(Input, { value: (_c = draft.city) !== null && _c !== void 0 ? _c : "", onChange: (e) => set("city", e.target.value), placeholder: "City", className: "text-xs" }),
            React.createElement(Input, { value: (_d = draft.region) !== null && _d !== void 0 ? _d : "", onChange: (e) => set("region", e.target.value), placeholder: "Region / state", className: "text-xs" }),
            React.createElement(Input, { value: (_e = draft.postalCode) !== null && _e !== void 0 ? _e : "", onChange: (e) => set("postalCode", e.target.value), placeholder: "Postal code", className: "text-xs" }),
            React.createElement(Input, { value: (_f = draft.country) !== null && _f !== void 0 ? _f : "", onChange: (e) => set("country", e.target.value), placeholder: "Country (ISO-2) *", className: "text-xs" })),
        error && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertDescription, null, error))),
        result && (React.createElement(Alert, { variant: result.status === "Valid" ? "default" : "destructive" },
            React.createElement(AlertDescription, null,
                React.createElement("div", { className: "flex flex-col gap-2" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        result.status === "Valid" ? (React.createElement(Check, { className: "h-3.5 w-3.5 text-success", "aria-hidden": true })) : (React.createElement(AlertTriangle, { className: "h-3.5 w-3.5 text-destructive", "aria-hidden": true })),
                        React.createElement("strong", null, result.status),
                        result.validationMessage && (React.createElement("span", { className: "text-2xs" },
                            "\u2014 ",
                            result.validationMessage))),
                    result.suggestedAddresses &&
                        result.suggestedAddresses.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" },
                            "Suggested ",
                            result.suggestedAddresses.length === 1 ? "address" : "addresses"),
                        React.createElement("ul", { className: "flex flex-col gap-1" }, result.suggestedAddresses.map((addr, i) => (React.createElement("li", { key: i, className: "flex flex-wrap items-start justify-between gap-2 rounded border border-border bg-card/40 p-2" },
                            React.createElement("div", { className: "flex flex-col gap-0.5 text-2xs" },
                                addr.addressLine1 && React.createElement("span", null, addr.addressLine1),
                                addr.addressLine2 && React.createElement("span", null, addr.addressLine2),
                                React.createElement("span", null, [addr.city, addr.region, addr.postalCode]
                                    .filter(Boolean)
                                    .join(", ")),
                                addr.country && React.createElement("span", null, addr.country)),
                            React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-6 text-2xs", onClick: () => setDraft(Object.assign(Object.assign({}, draft), addr)), "aria-label": "Apply suggested address to form", title: "Replace the form values with this suggestion" }, "Apply"))))))))))),
        React.createElement("div", null,
            React.createElement(Button, { type: "button", onClick: () => void submit(), disabled: submitting || !((_g = draft.addressLine1) === null || _g === void 0 ? void 0 : _g.trim()) || !((_h = draft.country) === null || _h === void 0 ? void 0 : _h.trim()), loading: submitting },
                !submitting && React.createElement(Check, null),
                "Validate"))));
};
/* ----- Cost Management query (Round-2 #9) -------------------------- */
const COST_TIMEFRAMES = [
    { value: "MonthToDate", label: "Month to date" },
    { value: "BillingMonthToDate", label: "Billing month to date" },
    { value: "TheLastMonth", label: "Last month" },
    { value: "TheLastBillingMonth", label: "Last billing month" },
    { value: "WeekToDate", label: "Week to date" },
];
const COST_GRANULARITIES = ["None", "Daily", "Monthly"];
const COST_TYPES = ["ActualCost", "AmortizedCost", "Usage"];
/**
 * Compact, dependency-free SVG sparkline for date-bucketed cost series.
 *
 * Why inline:
 * - No chart library in the bundle — the rest of the page is hand-rolled
 *   SVG / CSS too, so adding one for ~50 lines is overkill.
 * - The shape is stable across re-renders because we memoize the
 *   normalized point string in the parent and only pass primitives in.
 *
 * Accessibility: rendered with `role="img"` and an `aria-label`
 * carrying the min / max / latest value so screen readers get the gist
 * without needing to walk the SVG path.
 */
const Sparkline = React.memo(({ series, currency, width = 240, height = 40 }) => {
    var _a;
    // Guard rails — if the parent passed something degenerate we render
    // an empty placeholder rather than crash on divide-by-zero.
    if (!series || series.length < 2) {
        return (React.createElement("span", { className: "text-2xs text-muted-foreground" }, "sparkline unavailable"));
    }
    const values = series.map((s) => s.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const last = (_a = values[values.length - 1]) !== null && _a !== void 0 ? _a : 0;
    const stepX = width / (series.length - 1);
    const points = series
        .map((s, i) => {
        const x = i * stepX;
        // Invert Y so higher value renders higher on screen.
        const y = height - ((s.value - min) / range) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
        .join(" ");
    const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return (React.createElement("svg", { width: width, height: height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `Spend sparkline — min ${fmt(min)} ${currency}, max ${fmt(max)} ${currency}, latest ${fmt(last)} ${currency}, ${series.length} buckets`, className: "text-primary" },
        React.createElement("polyline", { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinejoin: "round", strokeLinecap: "round", points: points }),
        React.createElement("circle", { cx: (series.length - 1) * stepX, cy: height - ((last - min) / range) * height, r: 2, fill: "currentColor" })));
});
Sparkline.displayName = "EaBillingManagerSparkline";
const CostTab = ({ armToken, billingAccountName, accountUsername }) => {
    // Used by the correlated-anomaly banner to deep-link into the
    // privileged-audit page. Wrapped in a try/catch via the hook's
    // boundary: if the page is mounted outside an outlet (tests), the
    // hook still returns a no-op navigator.
    const { navigateToPage } = useDashboardOutletContext();
    const scope = `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}`;
    const [timeframe, setTimeframe] = React.useState("BillingMonthToDate");
    const [groupBy, setGroupBy] = React.useState("ServiceName");
    const [granularity, setGranularity] = React.useState("None");
    const [type, setType] = React.useState("ActualCost");
    const [result, setResult] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(null);
    // Persisted "hide low-spend rows below $X" filter — drives a chip
    // strip beneath the result table so an EA admin can focus on the
    // big-ticket buckets. Persisted across reloads. Per Design Contract
    // §10: use the use-persisted-state shim instead of touching
    // localStorage directly.
    const [minSpend, setMinSpend] = usePersistedState("ea-billing-manager:cost:min-spend", 0, { version: 1 });
    // Persisted saved-report templates. Each template captures the four
    // filter knobs and the min-spend threshold so the operator can name a
    // common drill-down ("Daily by ServiceName for this month") and reload
    // it in one click instead of re-tuning four selects.
    const [templatesState, setTemplatesState] = usePersistedState("ea-billing-manager:cost:templates", EMPTY_TEMPLATES_STATE, { version: 1, migrate: migrateTemplates });
    const templates = templatesState.templates;
    const [newTemplateName, setNewTemplateName] = React.useState("");
    const [selectedTemplateId, setSelectedTemplateId] = React.useState("");
    // ARIA-live announcement string — fires on threshold-breach detection
    // so a screen reader catches "3 anomalies detected" without the user
    // having to scan the page for the banner. Cleared on every successful
    // query so old announcements don't replay.
    const [liveAnnouncement, setLiveAnnouncement] = React.useState("");
    // Best-effort detection of the "cost" and "currency" columns so we
    // can render a sortable, summable view. Cost Management returns column
    // metadata with `name` like "PreTaxCost" or "Cost" — we pick the
    // first numeric column whose name contains "cost".
    const { costColumnIndex, currencyColumnIndex, totals } = React.useMemo(() => {
        if (!result) {
            return { costColumnIndex: -1, currencyColumnIndex: -1, totals: 0 };
        }
        const ci = result.columns.findIndex((c) => c.type === "Number" &&
            /cost|amount|value|charge/i.test(c.name));
        const cci = result.columns.findIndex((c) => /currency/i.test(c.name) && c.type === "String");
        let sum = 0;
        if (ci >= 0) {
            for (const row of result.rows) {
                const v = row[ci];
                if (typeof v === "number" && Number.isFinite(v))
                    sum += v;
            }
        }
        return {
            costColumnIndex: ci,
            currencyColumnIndex: cci,
            totals: sum,
        };
    }, [result]);
    const detectedCurrency = React.useMemo(() => {
        if (!result || currencyColumnIndex < 0)
            return "";
        for (const row of result.rows) {
            const v = row[currencyColumnIndex];
            if (typeof v === "string" && v)
                return v;
        }
        return "";
    }, [result, currencyColumnIndex]);
    /**
     * Threshold-filtered rows. When `minSpend > 0`, drop any row whose
     * detected cost column is below the threshold. Memoized so a re-render
     * triggered by an unrelated state change doesn't re-walk the row set.
     * When the cost column can't be detected, the filter is a no-op (we
     * fall back to the full set so the operator still sees every row).
     */
    const filteredRows = React.useMemo(() => {
        if (!result)
            return [];
        if (minSpend <= 0 || costColumnIndex < 0)
            return result.rows;
        return result.rows.filter((row) => {
            const v = row[costColumnIndex];
            return typeof v === "number" && Number.isFinite(v) && v >= minSpend;
        });
    }, [result, minSpend, costColumnIndex]);
    /**
     * Sparkline data — assembled when granularity is Daily or Monthly and
     * the response carries a date-like column. Aggregates total cost per
     * date bucket across all groups; produces an ordered series the
     * `Sparkline` component renders inline.
     */
    const sparklineSeries = React.useMemo(() => {
        var _a;
        if (!result || granularity === "None" || costColumnIndex < 0)
            return null;
        const dateColIdx = result.columns.findIndex((c) => /date|month|day/i.test(c.name));
        if (dateColIdx < 0)
            return null;
        const buckets = new Map();
        for (const row of result.rows) {
            const date = row[dateColIdx];
            const cost = row[costColumnIndex];
            if (typeof date !== "string" && typeof date !== "number")
                continue;
            if (typeof cost !== "number" || !Number.isFinite(cost))
                continue;
            const key = String(date);
            buckets.set(key, ((_a = buckets.get(key)) !== null && _a !== void 0 ? _a : 0) + cost);
        }
        if (buckets.size < 2)
            return null; // sparkline needs at least 2 points
        return Array.from(buckets.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, value]) => ({ date, value }));
    }, [result, granularity, costColumnIndex]);
    /**
     * Anomaly detection — only meaningful when we have a date-bucketed
     * series. Uses the trailing-window-mean rule from
     * `cost-anomaly-detector` (corpus: `_bypass_role_grant.md` §1.1). The
     * window size is chosen from the granularity — 7 buckets for daily
     * (one week of trailing context), 3 buckets for monthly (a quarter).
     */
    const anomalies = React.useMemo(() => {
        if (!sparklineSeries)
            return [];
        const windowSize = granularity === "Monthly" ? 3 : 7;
        return detectCostAnomalies(sparklineSeries, { windowSize });
    }, [sparklineSeries, granularity]);
    /**
     * Role-grant correlation — pulls the in-session audit log and finds
     * grant entries that line up with each anomaly bucket within a
     * granularity-appropriate window. Corpus references inline in the
     * cost-anomaly-detector module. The correlator runs on every audit-
     * log change so a grant that lands AFTER the cost query updates the
     * banner without the operator needing to re-run the query.
     */
    const [auditTick, setAuditTick] = React.useState(0);
    React.useEffect(() => {
        // Subscribe to the audit log so a new grant entry (e.g. operator
        // creates a role assignment in the Roles tab) re-fires the
        // correlation pass without a query re-run.
        const unsub = auditLog.onChange(() => setAuditTick((n) => n + 1));
        return unsub;
    }, []);
    const correlatedAnomalies = React.useMemo(() => {
        if (anomalies.length === 0)
            return [];
        // Window: 24h for daily, 30d for monthly. Caps at the per-bucket
        // granularity so we don't over-correlate (a grant 25 days ago is
        // not meaningfully linked to today's daily anomaly).
        const windowHours = granularity === "Monthly" ? 24 * 30 : 24;
        return correlateAnomaliesWithRoleGrants(anomalies, auditLog.getEntries(), {
            windowHours,
        });
        // auditTick triggers re-evaluation when the audit log changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anomalies, granularity, auditTick]);
    /**
     * Budget forecast — if we have a date-bucketed series and the
     * timeframe is a "to date" window, project end-of-month spend from
     * the trailing 7-bucket run rate. For "TheLastMonth"-style timeframes
     * the forecast is suppressed because the period is already closed.
     */
    const forecast = React.useMemo(() => {
        var _a;
        if (!sparklineSeries || sparklineSeries.length < 2)
            return null;
        // Only project for "to date" timeframes — past-period queries are
        // already a complete answer; projecting would be misleading.
        const projectableFrames = new Set([
            "MonthToDate",
            "BillingMonthToDate",
            "WeekToDate",
        ]);
        if (!timeframe || !projectableFrames.has(timeframe))
            return null;
        // Remaining buckets: estimate from the last date in the series.
        // For Daily/Weekly, we estimate days remaining in the current month
        // / week. This is approximate by design — Cost Management's own
        // forecast API is the source of truth; this is a quick visual.
        const lastDateStr = (_a = sparklineSeries[sparklineSeries.length - 1]) === null || _a === void 0 ? void 0 : _a.date;
        let remaining = 0;
        if (lastDateStr) {
            // Try to parse YYYYMMDD or ISO date.
            let lastDate = null;
            if (/^\d{8}$/.test(lastDateStr)) {
                const y = Number(lastDateStr.slice(0, 4));
                const m = Number(lastDateStr.slice(4, 6)) - 1;
                const d = Number(lastDateStr.slice(6, 8));
                lastDate = new Date(Date.UTC(y, m, d));
            }
            else {
                const parsed = new Date(lastDateStr);
                if (!Number.isNaN(parsed.getTime()))
                    lastDate = parsed;
            }
            if (lastDate) {
                if (timeframe === "WeekToDate") {
                    const dow = lastDate.getUTCDay();
                    remaining = Math.max(0, 6 - dow);
                }
                else {
                    // Days remaining in the calendar month (good-enough proxy for
                    // billing month — billing months differ at most by a few days).
                    const monthEnd = new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth() + 1, 0));
                    const ms = monthEnd.getTime() - lastDate.getTime();
                    remaining = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
                }
            }
        }
        if (remaining === 0)
            return null;
        return forecastBudget(sparklineSeries, remaining, granularity === "Monthly" ? 3 : 7);
    }, [sparklineSeries, timeframe, granularity]);
    // ARIA-live announcement: whenever the anomaly count changes (a new
    // query produced different results), build a brief sentence the screen
    // reader can voice. We deliberately only emit when count > 0 to avoid
    // chatter on every benign reload.
    React.useEffect(() => {
        if (correlatedAnomalies.length > 0) {
            setLiveAnnouncement(`Warning: ${correlatedAnomalies.length} cost anomalies correlate with recent privileged role grants. Review the banner above the result table.`);
        }
        else if (anomalies.length > 0) {
            setLiveAnnouncement(`${anomalies.length} cost anomalies detected. No correlated role grants found.`);
        }
        else {
            setLiveAnnouncement("");
        }
    }, [anomalies.length, correlatedAnomalies.length]);
    /* ----- Template apply / save helpers ----------------------------- */
    const applyTemplate = React.useCallback((tpl) => {
        setType(tpl.type);
        setTimeframe(tpl.timeframe);
        setGranularity(tpl.granularity);
        setGroupBy(tpl.groupBy);
        setMinSpend(tpl.minSpend);
        setSelectedTemplateId(tpl.id);
    }, [setMinSpend]);
    const saveCurrentAsTemplate = React.useCallback(() => {
        const name = newTemplateName.trim();
        if (!name)
            return;
        const id = templateIdFromName(name);
        const next = {
            id,
            name,
            savedAt: new Date().toISOString(),
            type: type !== null && type !== void 0 ? type : "ActualCost",
            timeframe: timeframe !== null && timeframe !== void 0 ? timeframe : "BillingMonthToDate",
            granularity,
            groupBy,
            minSpend,
        };
        setTemplatesState({
            templates: upsertTemplate(templates, next),
        });
        setNewTemplateName("");
        setSelectedTemplateId(id);
    }, [
        newTemplateName,
        type,
        timeframe,
        granularity,
        groupBy,
        minSpend,
        templates,
        setTemplatesState,
    ]);
    const deleteTemplateById = React.useCallback((id) => {
        setTemplatesState({
            templates: removeTemplate(templates, id),
        });
        if (selectedTemplateId === id)
            setSelectedTemplateId("");
    }, [templates, setTemplatesState, selectedTemplateId]);
    const run = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
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
        if (type && !COST_TYPES.includes(type)) {
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
            const body = {
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
            const r = yield queryCostManagement(scope, body, armToken);
            setResult(r);
            auditLog.record({
                actor: accountUsername,
                action: "cost_management_query",
                target: scope,
                status: "success",
                details: { type, timeframe, granularity, groupBy, rows: r.rows.length },
            });
        }
        catch (err) {
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
        }
        finally {
            setLoading(false);
        }
    }), [scope, armToken, type, timeframe, groupBy, granularity, accountUsername]);
    return (React.createElement(TabCard, { title: "Cost Management query", description: `POST /providers/Microsoft.CostManagement/query (scope: ${scope}). Aggregate spend by dimension over a timeframe.`, icon: Gauge, action: React.createElement(InfoTooltip, { content: React.createElement("div", { className: "space-y-1 text-xs leading-relaxed" },
                React.createElement("p", null,
                    React.createElement("strong", null, "Billing scope"),
                    " \u2014 the ARM path used to scope the cost query. Billing-account scope shows every charge across all subscriptions on the EA / MCA enrollment."),
                React.createElement("p", { className: "font-mono text-2xs" }, scope)), ariaLabel: "What is billing scope?" }) },
        React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-4" },
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Type"),
                React.createElement(Select, { value: type !== null && type !== void 0 ? type : "ActualCost", onValueChange: (v) => setType(v) },
                    React.createElement(SelectTrigger, null,
                        React.createElement(SelectValue, { placeholder: "Select cost type" })),
                    React.createElement(SelectContent, null,
                        React.createElement(SelectItem, { value: "ActualCost" }, "Actual Cost"),
                        React.createElement(SelectItem, { value: "AmortizedCost" }, "Amortized Cost"),
                        React.createElement(SelectItem, { value: "Usage" }, "Usage")))),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Timeframe"),
                React.createElement(Select, { value: timeframe !== null && timeframe !== void 0 ? timeframe : "BillingMonthToDate", onValueChange: (v) => setTimeframe(v) },
                    React.createElement(SelectTrigger, null,
                        React.createElement(SelectValue, { placeholder: "Select timeframe" })),
                    React.createElement(SelectContent, null, COST_TIMEFRAMES.map((t) => (React.createElement(SelectItem, { key: t.value, value: t.value }, t.label)))))),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Granularity"),
                React.createElement(Select, { value: granularity, onValueChange: (v) => setGranularity(v) },
                    React.createElement(SelectTrigger, null,
                        React.createElement(SelectValue, { placeholder: "Select granularity" })),
                    React.createElement(SelectContent, null,
                        React.createElement(SelectItem, { value: "None" }, "None"),
                        React.createElement(SelectItem, { value: "Daily" }, "Daily"),
                        React.createElement(SelectItem, { value: "Monthly" }, "Monthly")))),
            React.createElement("div", { className: "flex flex-col gap-1.5" },
                React.createElement(Label, { className: "text-xs" }, "Group by dimension"),
                React.createElement(Select, { value: groupBy, onValueChange: setGroupBy },
                    React.createElement(SelectTrigger, null,
                        React.createElement(SelectValue, { placeholder: "Select dimension" })),
                    React.createElement(SelectContent, null,
                        React.createElement(SelectItem, { value: "ServiceName" }, "ServiceName"),
                        React.createElement(SelectItem, { value: "ResourceGroupName" }, "ResourceGroupName"),
                        React.createElement(SelectItem, { value: "SubscriptionId" }, "SubscriptionId"),
                        React.createElement(SelectItem, { value: "ResourceLocation" }, "ResourceLocation"),
                        React.createElement(SelectItem, { value: "MeterCategory" }, "MeterCategory"),
                        React.createElement(SelectItem, { value: "ChargeType" }, "ChargeType"))))),
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement(Button, { type: "button", onClick: () => void run(), disabled: loading, loading: loading },
                !loading && React.createElement(Gauge, null),
                "Run query"),
            templates.length > 0 && (React.createElement(React.Fragment, null,
                React.createElement(Label, { className: "ml-2 text-2xs uppercase tracking-wider text-muted-foreground", htmlFor: "ea-cost-tpl" }, "Saved template"),
                React.createElement(Select, { value: selectedTemplateId, onValueChange: (v) => {
                        const t = templates.find((t) => t.id === v);
                        if (t)
                            applyTemplate(t);
                    } },
                    React.createElement(SelectTrigger, { id: "ea-cost-tpl", className: "w-56 text-xs" },
                        React.createElement(SelectValue, { placeholder: "Load a saved report\u2026" })),
                    React.createElement(SelectContent, null, templates.map((t) => (React.createElement(SelectItem, { key: t.id, value: t.id },
                        React.createElement("span", { className: "flex flex-col" },
                            React.createElement("span", { className: "text-sm" }, t.name),
                            React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                t.type,
                                " \u00B7 ",
                                t.timeframe,
                                " \u00B7 ",
                                t.granularity,
                                " \u00B7 by",
                                " ",
                                t.groupBy,
                                t.minSpend > 0
                                    ? ` · floor ${t.minSpend.toLocaleString()}`
                                    : ""))))))),
                selectedTemplateId && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-2xs text-destructive", onClick: () => deleteTemplateById(selectedTemplateId), title: "Delete the currently selected template", "aria-label": "Delete the currently selected template" },
                    React.createElement(Trash2, { className: "h-3 w-3", "aria-hidden": true }),
                    "Delete")))),
            React.createElement("div", { className: "ml-auto flex items-center gap-1.5" },
                React.createElement(Input, { value: newTemplateName, onChange: (e) => setNewTemplateName(e.target.value), placeholder: "Name this report\u2026", className: "h-7 w-44 text-xs", "aria-label": "Name to save the current cost-query knobs as a template" }),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-7 text-2xs", onClick: saveCurrentAsTemplate, disabled: !newTemplateName.trim(), title: "Save the current filter combination as a named template", "aria-label": "Save current cost query as named template" },
                    React.createElement(BadgeCheck, { className: "h-3 w-3", "aria-hidden": true }),
                    "Save template"))),
        error && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertDescription, null, error))),
        React.createElement("p", { className: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" }, liveAnnouncement),
        result && (React.createElement("div", { className: "flex flex-col gap-2" },
            React.createElement("div", { className: "flex flex-wrap items-center gap-2", role: "group", "aria-label": "Cost query summary" },
                React.createElement(SummaryStatItem, { label: "Rows", value: `${filteredRows.length}${filteredRows.length !== result.rows.length
                        ? ` / ${result.rows.length}`
                        : ""}`, compact: true }),
                costColumnIndex >= 0 && (React.createElement(SummaryStatItem, { label: "Total cost", value: `${totals.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                    })} ${detectedCurrency}`, compact: true, tone: "info" })),
                costColumnIndex >= 0 && filteredRows.length > 0 && (React.createElement(SummaryStatItem, { label: "Top row", value: `${(filteredRows.reduce((max, row) => {
                        const v = row[costColumnIndex];
                        return typeof v === "number" && v > max ? v : max;
                    }, 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${detectedCurrency}`, compact: true, tone: "warning" })),
                sparklineSeries && (React.createElement("div", { className: "flex flex-col items-start gap-0.5", "aria-label": "Spend trend sparkline" },
                    React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" },
                        "Trend (",
                        sparklineSeries.length,
                        " pts)"),
                    React.createElement(Sparkline, { series: sparklineSeries, currency: detectedCurrency }))),
                forecast && (React.createElement(SummaryStatItem, { label: "Projected end of period", value: `${forecast.projected.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                    })} ${detectedCurrency}`, compact: true, tone: forecast.projected > forecast.current * 1.2 ? "warning" : "info" })),
                React.createElement("div", { className: "ml-auto" },
                    React.createElement(ExportMenu, { 
                        // Export the FILTERED view so CSV matches what the
                        // operator is looking at, not the unfiltered raw set.
                        rows: filteredRows, columns: result.columns.map((col, idx) => ({
                            header: col.name,
                            accessor: (row) => {
                                const v = row[idx];
                                return typeof v === "number" || typeof v === "string"
                                    ? v
                                    : "";
                            },
                        })), filename: `ea-cost-${billingAccountName}-${timeframe}-${groupBy}`, rowCount: filteredRows.length }))),
            forecast && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                "Run rate: ",
                React.createElement("strong", null,
                    forecast.ratePerBucket.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                    }),
                    " ",
                    detectedCurrency),
                " per bucket over the trailing",
                " ",
                React.createElement("strong", null, forecast.windowUsed),
                " buckets. Projection is a linear extrapolation \u2014 Cost Management's own forecast API is the source of truth.")),
            correlatedAnomalies.length > 0 && (React.createElement(Alert, { variant: "destructive" },
                React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                React.createElement(AlertDescription, null,
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement("strong", null,
                            correlatedAnomalies.length,
                            " cost anomal",
                            correlatedAnomalies.length === 1 ? "y" : "ies",
                            " correlate with recent privileged role grants"),
                        React.createElement("ul", { className: "ml-1 flex flex-col gap-0.5 text-2xs" }, correlatedAnomalies.slice(0, 5).map((a) => (React.createElement("li", { key: a.date },
                            React.createElement("span", { className: "font-mono" }, a.date),
                            ":",
                            " ",
                            React.createElement("strong", null,
                                a.value.toLocaleString(undefined, {
                                    maximumFractionDigits: 0,
                                }),
                                " ",
                                detectedCurrency),
                            " ",
                            "\u2014 ",
                            a.reason,
                            " \u00B7 ",
                            React.createElement("em", null, a.grants.length),
                            " ",
                            "role-grant audit",
                            " ",
                            a.grants.length === 1 ? "entry" : "entries",
                            " in window:",
                            " ",
                            a.grants
                                .slice(0, 2)
                                .map((g) => `${g.action} by ${g.actor || "unknown"} on ${g.target.length > 40
                                ? `${g.target.slice(0, 37)}…`
                                : g.target}`)
                                .join("; "),
                            a.grants.length > 2
                                ? ` (+${a.grants.length - 2} more)`
                                : "")))),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-2 pt-1" },
                            React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: () => {
                                    auditLog.record({
                                        actor: accountUsername,
                                        action: "drill_down_cost_anomaly_to_audit",
                                        target: scope,
                                        status: "success",
                                        details: {
                                            page: "ea-billing-manager",
                                            tab: "cost",
                                            anomaliesCorrelated: correlatedAnomalies.length,
                                            navigatedTo: "/privileged-audit",
                                        },
                                    });
                                    navigateToPage("/privileged-audit");
                                }, title: "Open the Privileged Audit page to inspect the correlated grants", "aria-label": "Open Privileged Audit" },
                                React.createElement(ChevronRight, { className: "h-3 w-3", "aria-hidden": true }),
                                "Open Privileged Audit"),
                            React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-7 text-2xs", onClick: () => navigateToPage("/role-graph"), title: "Open the Role Graph to inspect who got what", "aria-label": "Open Role Graph page" },
                                React.createElement(UserCheck, { className: "h-3 w-3", "aria-hidden": true }),
                                "Open Role Graph")))))),
            anomalies.length > 0 && correlatedAnomalies.length === 0 && (React.createElement(Alert, { variant: "warning" },
                React.createElement(Info, { className: "h-4 w-4", "aria-hidden": true }),
                React.createElement(AlertDescription, null,
                    React.createElement("strong", null,
                        anomalies.length,
                        " cost anomal",
                        anomalies.length === 1 ? "y" : "ies",
                        " detected"),
                    " ",
                    "\u2014 no role-grant audit entries fall in the correlation window. Likely a legitimate spike (end-of-month batch, new workload onboarding) but worth a glance:",
                    " ",
                    anomalies
                        .slice(0, 3)
                        .map((a) => `${a.date} (${a.value.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                    })} ${detectedCurrency}, ${a.reason})`)
                        .join("; "),
                    anomalies.length > 3 ? ` …+${anomalies.length - 3} more` : "",
                    "."))),
            costColumnIndex >= 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Minimum-spend threshold filter" },
                React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Hide rows under"),
                [0, 10, 100, 1000, 10000].map((n) => (React.createElement("button", { key: n, type: "button", role: "radio", "aria-checked": minSpend === n, onClick: () => setMinSpend(n), className: cn("rounded-full border px-2.5 py-0.5 text-2xs transition-colors", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", minSpend === n
                        ? "border-primary bg-primary/15 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted/40") }, n === 0
                    ? "Off"
                    : `${n.toLocaleString()} ${detectedCurrency}`))))),
            React.createElement("div", { className: "overflow-x-auto" },
                React.createElement("table", { className: "w-full text-2xs" },
                    React.createElement("thead", null,
                        React.createElement("tr", { className: "border-b border-border" }, result.columns.map((c) => (React.createElement("th", { key: c.name, className: "px-2 py-1 text-left font-medium" },
                            c.name,
                            React.createElement("span", { className: "ml-1 text-muted-foreground" },
                                "(",
                                c.type,
                                ")")))))),
                    React.createElement("tbody", null, filteredRows.slice(0, 200).map((row, ri) => (React.createElement("tr", { key: ri, className: "border-b border-border/40 hover:bg-muted/20" }, row.map((cell, ci) => (React.createElement("td", { key: ci, className: cn("px-2 py-1 font-mono", ci === costColumnIndex && "text-right font-semibold") }, typeof cell === "number"
                        ? cell.toLocaleString(undefined, { maximumFractionDigits: 2 })
                        : String(cell)))))))),
                    costColumnIndex >= 0 && (React.createElement("tfoot", null,
                        React.createElement("tr", { className: "border-t-2 border-border bg-muted/30 font-semibold" }, result.columns.map((_, ci) => (React.createElement("td", { key: ci, className: "px-2 py-1 font-mono" }, ci === 0
                            ? "Total"
                            : ci === costColumnIndex
                                ? totals.toLocaleString(undefined, {
                                    maximumFractionDigits: 2,
                                })
                                : ci === currencyColumnIndex
                                    ? detectedCurrency
                                    : ""))))))),
                filteredRows.length > 200 && (React.createElement("p", { className: "mt-2 text-2xs text-muted-foreground" },
                    "Truncated to first 200 of ",
                    filteredRows.length,
                    " rows",
                    minSpend > 0 ? " (after threshold filter)" : "",
                    ". Total above is computed from the full unfiltered set.")),
                minSpend > 0 && filteredRows.length === 0 && (React.createElement("p", { className: "mt-2 text-2xs text-warning" },
                    "No rows pass the ",
                    minSpend.toLocaleString(),
                    " ",
                    detectedCurrency,
                    " threshold \u2014 lower the floor to see results.")))))));
};
// Re-export icons we imported but don't reference inline, to silence
// the linter "no-unused-import" rule in case the design later adds them.
export const _EaMgrIcons = { AlertTriangle, ChevronRight, Users, cn };
//# sourceMappingURL=ea-billing-manager-page.js.map