import { __awaiter, __rest } from "tslib";
/**
 * Azure Accounts page — manages signed-in AAD accounts, their subscriptions,
 * and active-tenant selection. Drawer-based detail view with DataTable list.
 *
 * Layered improvements vs. the original:
 *   - URL state (`?status=`, `?q=`, `?account=`, `?tab=`) so deep links
 *     resume the operator exactly where they left off.
 *   - Global search box (name / username / tenant / sub id), debounced,
 *     restored from `?q=` on mount.
 *   - Quick-filter chips for status with live counts.
 *   - Bulk-select with bulk refresh / re-login / remove (single
 *     `ConfirmationDialog` shared with the per-row remove flow).
 *   - Per-row "Refresh subs" action so the operator doesn't need to
 *     refresh the entire account list to recover a single 401.
 *   - Per-row "Copy" affordances for username + home account id; per-row
 *     subscription rows in the drawer get inline copy too.
 *   - Centralized tenant-switch helper — the drawer + the inline row
 *     dropdown both call it; removes ~120 lines of near-duplicate code
 *     that had drifted slightly out of sync.
 *   - AbortController on the long-running per-account subs fetch so a
 *     refresh fired mid-unmount cancels in-flight HTTP calls instead of
 *     racing the cancelled-flag.
 *   - NaN/Invalid-Date guards on `addedAt` so a corrupted persisted blob
 *     doesn't print "Invalid Date" or crash the table.
 *   - Drawer tabs (`Tenants` / `Subscriptions` / `Details`) so the body
 *     stays focused and `?tab=` lets the operator deep-link to a
 *     specific drawer view.
 *   - Re-probe directory roles after a tenant switch (the previous
 *     version reset the ref but the effect never re-ran because its
 *     deps didn't change — the probe was silently stale).
 *   - ExportMenu (CSV / JSON) for the visible/filtered account list.
 *   - SummaryStatItem from `shared/` (not a local re-implementation)
 *     for visual consistency with audit-log and other list pages.
 *   - Audit log on success+failure for refresh-all and per-row refresh.
 *   - Sign-in chord (`mod+shift+l`) to open the sign-in field even when
 *     the list is non-empty.
 */
import * as React from "react";
import { AlertCircle, AlertTriangle, Check, ChevronsUpDown, Clock, Filter, Globe2, KeyRound, Loader2, LogIn, Network, RefreshCw, RotateCw, Search, ShieldAlert, ShieldCheck, Timer, Trash2, User, Users, } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { BorderBeam, DotPattern, Meteors, } from "@/components/ui/effects";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn, compareNumbers, compareStrings } from "@/lib/utils";
import { getAllLoggedInAccounts, getGraphTokenForAccount, listAccessibleTenants, listSubscriptionsForAccount, login, loginAccount, logoutAccount, } from "../../auth/msal-auth";
// Canonical tenant-switch util — the page used to re-implement this
// inline (~165 LOC) which drifted from the header switcher's copy.
// Now everyone calls the SAME implementation.
import { findTenantLabel, performTenantSwitch, resolveActiveTenantId as resolveActiveTenantIdRaw, } from "../../auth/perform-tenant-switch";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useUrlState } from "../../hooks/use-url-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { auditLog } from "../../services/audit-log";
import { canResetPasswords, getMyDirectoryRoles } from "../../services";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { AccountIntelligencePanel } from "./account-intelligence-panel";
import { bucketAccountAge, summarizePosture, } from "./azure-accounts-intel";
import { PreLoginTenantSelector } from "./pre-login-tenant-selector";
import { SubscriptionList } from "./subscription-list";
import { TenantGraphPanel, TokenAgeBars } from "./tenant-graph-panel";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { DataTable, } from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
const VALID_DRAWER_TABS = new Set([
    "tenants",
    "subscriptions",
    "details",
]);
const INITIAL_FILTERS = {
    status: "",
    q: "",
    account: "",
    tab: "",
};
const STATUS_LABELS = {
    active: "Active",
    loading: "Loading",
    error: "Error",
};
/**
 * Threshold for the "stuck account" detector — an account whose
 * `addedAt` is older than this and that is still `status === "active"`
 * is flagged with a "Refresh due" badge to nudge the operator to
 * re-fetch its subscriptions. 24h is conservative enough to avoid
 * flagging recently-loaded accounts while still catching stale state
 * after an overnight session.
 */
const STUCK_ACCOUNT_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/**
 * Total-string-returning wrapper around the canonical
 * `resolveActiveTenantId` (which returns `string | undefined`). The
 * page treats the home tenant as the always-safe fallback so callers
 * (search, columns, dropdowns) get a stable string.
 */
function resolveActiveTenantId(acct) {
    var _a;
    return (_a = resolveActiveTenantIdRaw(acct)) !== null && _a !== void 0 ? _a : acct.tenantId;
}
function truncateMiddle(value, head = 8, tail = 4) {
    if (!value || value.length <= head + tail + 1)
        return value;
    return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
function statusToneClass(status) {
    if (status === "active")
        return "text-success";
    if (status === "error")
        return "text-destructive";
    return "text-warning";
}
/**
 * Safe relative-time formatter — guards against NaN / Invalid Date that
 * sneaks in via corrupted persisted state. Returns "—" when the input
 * does not parse to a finite millisecond value.
 */
function formatRelativeTime(iso) {
    if (!iso)
        return "—";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts))
        return "—";
    const delta = Date.now() - ts;
    if (delta < 0 || delta < 30000)
        return "just now";
    const minutes = Math.floor(delta / 60000);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30)
        return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12)
        return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return `${years}y ago`;
}
/**
 * Browser-side event other pages listen for to refresh state after a
 * tenant switch. Detail carries `{ homeAccountId, tenantId,
 * fromTenantId }` so each listener can decide whether the change
 * affects its current data set.
 *
 * The constant lives in `hooks/tenant-changed-event` so it can be
 * shared by `auth/perform-tenant-switch` (the emitter), the listener
 * hook, and the header tenant switcher without a circular import
 * through this page. Re-exported here so existing imports
 * (`from ".../azure-accounts-page"`) keep resolving without churn.
 */
export { TENANT_CHANGED_EVENT } from "../../hooks/tenant-changed-event";
/**
 * Best-effort wipe of any page-scoped browser cache the Azure Accounts
 * page may have written. The page itself doesn't store anything in
 * localStorage (the store layer handles persistence under
 * `multi-region-sessions`), but other consumers — notably
 * `dashboard-shell`'s "Clear sign-in cache" recovery path — import
 * this symbol to belt-and-braces flush every layer when the operator
 * resets MSAL. Keeping the stub here means the import resolves even
 * if a future revision adds genuine page-scope cache writes; the body
 * stays a no-op until that day.
 *
 * Failures are swallowed; the caller already wraps every invocation
 * in its own try/catch and treats this as a best-effort.
 */
export function purgeAccountsCache() {
    if (typeof window === "undefined")
        return;
    try {
        // Reserved prefix for any future per-account caches the page
        // wants to write (e.g. "azbm.azure-accounts.…"). Iterating the
        // full localStorage means we don't have to keep a key list in
        // sync between the page and the cache-purge call site.
        const keysToDrop = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
            const k = window.localStorage.key(i);
            if (k && k.startsWith("azbm.azure-accounts."))
                keysToDrop.push(k);
        }
        for (const k of keysToDrop)
            window.localStorage.removeItem(k);
    }
    catch (_a) {
        /* localStorage may be disabled — non-fatal. */
    }
}
/**
 * Sort tenants so the picker is predictable across renders:
 * 1. Home tenant first.
 * 2. Then alphabetical by displayName / defaultDomain.
 * 3. Then tenantId as a last-resort tie-break.
 */
function sortTenantsForPicker(tenants, homeTenantId) {
    return [...tenants].sort((a, b) => {
        var _a, _b, _c, _d, _e, _f;
        if (a.tenantId === homeTenantId)
            return -1;
        if (b.tenantId === homeTenantId)
            return 1;
        const aLabel = ((_c = (_b = (_a = a.displayName) !== null && _a !== void 0 ? _a : a.defaultDomain) !== null && _b !== void 0 ? _b : a.tenantId) !== null && _c !== void 0 ? _c : "").toLowerCase();
        const bLabel = ((_f = (_e = (_d = b.displayName) !== null && _d !== void 0 ? _d : b.defaultDomain) !== null && _e !== void 0 ? _e : b.tenantId) !== null && _f !== void 0 ? _f : "").toLowerCase();
        return aLabel.localeCompare(bLabel);
    });
}
/**
 * Whether an account's last-known data is considered "stale" — the
 * `addedAt` timestamp (which is updated whenever the account is
 * re-loaded by `loadAllAccounts` / `refreshSingleAccount`) is older
 * than {@link STUCK_ACCOUNT_THRESHOLD_MS}. Returns false when the
 * timestamp is missing or unparseable so a corrupted persisted blob
 * doesn't paint a "stuck" flag indiscriminately.
 */
function isAccountStuck(account, now) {
    if (account.status !== "active")
        return false;
    const ts = account.addedAt ? Date.parse(account.addedAt) : NaN;
    if (!Number.isFinite(ts))
        return false;
    return now - ts > STUCK_ACCOUNT_THRESHOLD_MS;
}
const AccountDrawer = ({ account, open, onOpenChange, onRequestRemove, onRequestRefresh, isAccountRefreshing, isRowSwitching, registerRowSwitch, drawerTab, onDrawerTabChange, }) => {
    var _a;
    const store = useMultiRegionStore();
    const [tenantsLoading, setTenantsLoading] = React.useState(false);
    const [tenantsError, setTenantsError] = React.useState(null);
    const [isPasswordAdmin, setIsPasswordAdmin] = React.useState(null);
    /**
     * Trigger that bumps every time we want to re-probe directory
     * roles (initial open, after tenant switch). Drives the
     * directory-role effect's dependency list so the probe re-runs
     * even when the account / open state hasn't changed.
     */
    const [roleProbeNonce, setRoleProbeNonce] = React.useState(0);
    const tenantsLoadedRef = React.useRef(null);
    /**
     * Monotonic counter bumped on every tenant-switch attempt. The async
     * `listSubscriptionsForAccount` call captures the seq it was started
     * with and bails before writing to the store / firing toasts if a
     * newer switch has started — protects against rapid back-and-forth
     * clicks where a slow first response would otherwise clobber the
     * second response's UI state.
     */
    const switchSeqRef = React.useRef(0);
    /** AbortController for the in-flight switch — cancels on unmount. */
    const switchAbortRef = React.useRef(null);
    // Reset transient drawer state when the account changes.
    React.useEffect(() => {
        if (!account)
            return;
        if (tenantsLoadedRef.current !== account.homeAccountId) {
            setTenantsError(null);
            setIsPasswordAdmin(null);
            setRoleProbeNonce((n) => n + 1);
        }
    }, [account]);
    React.useEffect(() => {
        return () => {
            var _a;
            (_a = switchAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        };
    }, []);
    // In-flight ref MUST be used for the bail-guard (not `tenantsLoading`
    // state). Reading state from the closure caused this loop:
    //   1. effect calls fetchTenants → setTenantsLoading(true) → re-render
    //   2. re-render rebuilds fetchTenants (it had `tenantsLoading` in
    //      its deps), effect deps change → cleanup aborts the in-flight
    //      controller → effect re-fires with the NEW fetchTenants
    //   3. NEW fetchTenants closure sees tenantsLoading=true → bails
    //   4. ORIGINAL aborted promise resolves, hits `signal.aborted`
    //      branch, returns WITHOUT updating tenantsLoadedRef or clearing
    //      tenantsLoading → state stuck at loading=true forever, tenants
    //      never appear in the drawer, the row-dropdown is empty (it
    //      reads `account.tenants`), tenant switching is impossible.
    // The ref guard avoids reading reactive state from the callback's
    // closure, and dropping `tenantsLoading` from the deps stabilises
    // the callback identity so the parent effect doesn't churn.
    const tenantsFetchInFlightRef = React.useRef(false);
    const fetchTenants = React.useCallback((homeAccountId, force, signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (tenantsFetchInFlightRef.current)
            return;
        if (!force && tenantsLoadedRef.current === homeAccountId)
            return;
        tenantsFetchInFlightRef.current = true;
        setTenantsLoading(true);
        setTenantsError(null);
        try {
            const list = yield listAccessibleTenants(homeAccountId);
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                return;
            store.updateAzureAccount(homeAccountId, { tenants: list });
            tenantsLoadedRef.current = homeAccountId;
        }
        catch (e) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setTenantsError(msg);
        }
        finally {
            tenantsFetchInFlightRef.current = false;
            if (!(signal === null || signal === void 0 ? void 0 : signal.aborted))
                setTenantsLoading(false);
        }
    }), [store]);
    // Auto-load tenants when drawer opens for a new account.
    React.useEffect(() => {
        if (!open || !account)
            return;
        if (tenantsLoadedRef.current === account.homeAccountId)
            return;
        if (account.tenants && account.tenants.length > 0) {
            tenantsLoadedRef.current = account.homeAccountId;
            return;
        }
        const controller = new AbortController();
        void fetchTenants(account.homeAccountId, false, controller.signal);
        return () => controller.abort();
    }, [open, account, fetchTenants]);
    // Probe directory roles for the active tenant. Re-runs when
    // `roleProbeNonce` bumps (initial open, after tenant switch).
    // Uses `useAbortableEffect` so the per-effect AbortSignal is
    // available to future fetch upgrades and so the cleanup story is
    // a single source of truth (vs. the old `let cancelled = false`
    // pattern). The Graph SDK calls don't currently accept a signal,
    // but the `signal.aborted` guard still short-circuits the
    // state-write race when the drawer closes mid-probe.
    const activeTenantForProbe = account
        ? resolveActiveTenantId(account)
        : undefined;
    const accountHomeIdForProbe = account === null || account === void 0 ? void 0 : account.homeAccountId;
    const accountStatusForProbe = account === null || account === void 0 ? void 0 : account.status;
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (!open || !accountHomeIdForProbe)
            return;
        if (accountStatusForProbe !== "active")
            return;
        if (!activeTenantForProbe)
            return;
        try {
            const token = yield getGraphTokenForAccount(accountHomeIdForProbe, activeTenantForProbe);
            if (signal.aborted)
                return;
            const roles = yield getMyDirectoryRoles(activeTenantForProbe, token);
            if (signal.aborted)
                return;
            setIsPasswordAdmin(canResetPasswords(roles));
        }
        catch (_b) {
            if (signal.aborted)
                return;
            setIsPasswordAdmin(false);
        }
    }), [
        open,
        accountHomeIdForProbe,
        accountStatusForProbe,
        activeTenantForProbe,
        roleProbeNonce,
    ]);
    const handleRefreshTenants = React.useCallback(() => {
        if (!account)
            return;
        tenantsLoadedRef.current = null;
        void fetchTenants(account.homeAccountId, true);
    }, [account, fetchTenants]);
    const handleSwitchTenant = React.useCallback((tenantId) => __awaiter(void 0, void 0, void 0, function* () {
        if (!account)
            return;
        if (switchAbortRef.current)
            return; // already switching
        const currentActive = resolveActiveTenantId(account);
        if (currentActive === tenantId)
            return;
        // Bump and capture the seq. Also register the row-level "busy"
        // state so the inline dropdown reflects the in-flight switch
        // even if the drawer is closed mid-switch.
        switchSeqRef.current += 1;
        const mySeq = switchSeqRef.current;
        const controller = new AbortController();
        switchAbortRef.current = controller;
        registerRowSwitch(account.homeAccountId, tenantId);
        try {
            const { stale } = yield performTenantSwitch(account, tenantId, store, {
                source: "drawer",
                signal: controller.signal,
                isStale: () => mySeq !== switchSeqRef.current,
                onSuccess: () => setRoleProbeNonce((n) => n + 1),
            });
            if (stale)
                return;
        }
        finally {
            if (mySeq === switchSeqRef.current) {
                registerRowSwitch(account.homeAccountId, null);
                switchAbortRef.current = null;
            }
        }
    }), [account, store, registerRowSwitch]);
    // Don't render the Sheet at all when no account is selected — Radix
    // requires SheetTitle/Description for a11y, and there's no point in
    // mounting an empty drawer.
    if (!account)
        return null;
    const tenants = (_a = account.tenants) !== null && _a !== void 0 ? _a : [];
    const activeTenantId = resolveActiveTenantId(account);
    const externalSwitchingTo = isRowSwitching(account.homeAccountId);
    const switchingTenantId = switchAbortRef.current
        ? activeTenantId
        : externalSwitchingTo !== null && externalSwitchingTo !== void 0 ? externalSwitchingTo : null;
    const enabledCount = account.subscriptions.filter((s) => { var _a; return ((_a = s.state) !== null && _a !== void 0 ? _a : "Enabled") === "Enabled"; }).length;
    const disabledCount = account.subscriptions.length - enabledCount;
    return (React.createElement(Sheet, { open: open, onOpenChange: onOpenChange },
        React.createElement(SheetContent, { side: "right", size: "lg", className: "flex flex-col p-0" },
            React.createElement(SheetHeader, null,
                React.createElement("div", { className: "flex items-start gap-3" },
                    React.createElement("div", { className: "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15" },
                        React.createElement(User, { className: "h-5 w-5 text-primary" })),
                    React.createElement("div", { className: "min-w-0 flex-1" },
                        React.createElement(SheetTitle, { className: "truncate" }, account.name || account.username),
                        React.createElement("div", { className: "group/copy flex items-center gap-1.5" },
                            React.createElement("p", { className: "truncate text-xs text-muted-foreground" }, account.username),
                            React.createElement(CopyButton, { value: account.username, ariaLabel: `Copy username ${account.username}` })),
                        React.createElement("div", { className: "mt-1 flex flex-wrap items-center gap-1.5" },
                            React.createElement(Badge, { variant: account.status === "active"
                                    ? "success"
                                    : account.status === "error"
                                        ? "destructive"
                                        : "warning", "aria-label": `Status: ${STATUS_LABELS[account.status]}` }, STATUS_LABELS[account.status]),
                            isPasswordAdmin === true && (React.createElement(Tooltip, null,
                                React.createElement(TooltipTrigger, { asChild: true },
                                    React.createElement("span", { "aria-label": "Password Admin" },
                                        React.createElement(Badge, { variant: "warning", className: "gap-1" },
                                            React.createElement(KeyRound, { className: "h-3 w-3", "aria-hidden": true }),
                                            "Password Admin"))),
                                React.createElement(TooltipContent, { side: "top" }, "This account has permission to reset passwords for users in this tenant."))))),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", null,
                                React.createElement(Button, { variant: "outline", size: "icon-sm", onClick: () => onRequestRefresh(account.homeAccountId), disabled: isAccountRefreshing || account.status === "loading", "aria-label": "Refresh this account" },
                                    React.createElement(RefreshCw, { className: cn("h-3.5 w-3.5", (isAccountRefreshing ||
                                            account.status === "loading") &&
                                            "animate-spin motion-reduce:animate-none") })))),
                        React.createElement(TooltipContent, { side: "left" }, "Re-fetch subscriptions for this account.")))),
            React.createElement("div", { role: "tablist", "aria-label": "Account detail tabs", className: "flex gap-1 border-b border-border px-4" }, [
                { key: "tenants", label: "Tenants", count: tenants.length },
                {
                    key: "subscriptions",
                    label: "Subscriptions",
                    count: account.subscriptions.length,
                },
                { key: "details", label: "Details", count: undefined },
            ].map((tab) => {
                const selected = drawerTab === tab.key;
                return (React.createElement("button", { key: tab.key, type: "button", role: "tab", "aria-selected": selected, "aria-controls": `drawer-panel-${tab.key}`, tabIndex: selected ? 0 : -1, onClick: () => onDrawerTabChange(tab.key), className: cn("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background motion-reduce:transition-none", selected
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground") },
                    React.createElement("span", null, tab.label),
                    tab.count !== undefined && (React.createElement("span", { className: cn("rounded-full px-1.5 py-0.5 text-2xs tabular-nums", selected
                            ? "bg-primary/10 text-primary"
                            : "bg-muted/50 text-muted-foreground") }, tab.count))));
            })),
            React.createElement(SheetBody, { className: "flex flex-col gap-4" },
                drawerTab === "tenants" && (React.createElement("div", { role: "tabpanel", id: "drawer-panel-tenants", "aria-labelledby": "drawer-tab-tenants", className: "flex flex-col gap-4" },
                    React.createElement("section", { "aria-label": "Active tenant", className: "flex flex-col gap-2 rounded-md border border-border bg-card p-4" },
                        React.createElement("div", { className: "flex items-center justify-between gap-2" },
                            React.createElement("h3", { className: "m-0 text-base font-semibold" }, "Active tenant"),
                            React.createElement(Button, { variant: "ghost", size: "icon-sm", onClick: handleRefreshTenants, disabled: tenantsLoading, "aria-label": "Refresh tenants", title: "Refresh tenants" },
                                React.createElement(RotateCw, { className: cn("h-3.5 w-3.5", tenantsLoading &&
                                        "animate-spin motion-reduce:animate-none") }))),
                        tenantsError && (React.createElement(ErrorState, { message: "Failed to load tenants.", detail: tenantsError, tone: "warning", size: "compact", onRetry: handleRefreshTenants })),
                        tenantsLoading && tenants.length === 0 ? (React.createElement("div", { className: "flex flex-col gap-1.5 py-1", role: "progressbar", "aria-label": "Loading tenants" },
                            React.createElement(Skeleton, { className: "h-9 w-full" }),
                            React.createElement(Skeleton, { className: "h-3 w-24" }))) : tenants.length === 0 ? (React.createElement("div", { className: "flex flex-col items-start gap-2 py-1" },
                            React.createElement("p", { className: "text-xs text-muted-foreground" }, "No tenants discovered yet."),
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleRefreshTenants, "aria-label": "Discover tenants" },
                                React.createElement(RotateCw, { className: "h-3.5 w-3.5" }),
                                "Discover tenants"))) : tenants.length === 1 ? (React.createElement("div", { className: "flex items-center gap-2 rounded border border-border/60 bg-muted/30 px-3 py-2" },
                            React.createElement(ShieldCheck, { className: "h-3.5 w-3.5 shrink-0 text-success", "aria-hidden": true }),
                            React.createElement("div", { className: "min-w-0 flex-1" },
                                React.createElement("p", { className: "truncate text-xs font-medium text-foreground" }, tenants[0].displayName ||
                                    tenants[0].defaultDomain ||
                                    "(unknown)"),
                                React.createElement("div", { className: "group/copy flex items-center gap-1.5", title: tenants[0].tenantId },
                                    React.createElement("p", { className: "truncate font-mono text-2xs text-muted-foreground" },
                                        truncateMiddle(tenants[0].tenantId, 8, 4),
                                        tenants[0].defaultDomain
                                            ? ` · ${tenants[0].defaultDomain}`
                                            : ""),
                                    React.createElement(CopyButton, { value: tenants[0].tenantId, ariaLabel: "Copy tenant id" }))),
                            React.createElement(Badge, { variant: "success" }, "Active"))) : (React.createElement("div", { className: "flex flex-col gap-2", role: "group", "aria-label": `Switch tenant (${tenants.length} available)` },
                            React.createElement(Select, { value: activeTenantId, onValueChange: handleSwitchTenant, disabled: switchingTenantId !== null },
                                React.createElement(SelectTrigger, { className: "h-9", "aria-label": `Switch active tenant — currently ${findTenantLabel(tenants, activeTenantId, activeTenantId)}`, "aria-busy": switchingTenantId !== null },
                                    React.createElement(SelectValue, { placeholder: "Select a tenant" })),
                                React.createElement(SelectContent, null, sortTenantsForPicker(tenants, account.tenantId).map((tenant) => {
                                    const isHome = tenant.tenantId === account.tenantId;
                                    const isActive = tenant.tenantId === activeTenantId;
                                    const label = tenant.displayName ||
                                        tenant.defaultDomain ||
                                        tenant.tenantId;
                                    return (React.createElement(SelectItem, { key: tenant.tenantId, value: tenant.tenantId, "aria-label": `${label}${isHome ? " (home tenant)" : ""}${isActive ? " (currently active)" : ""}` },
                                        React.createElement("span", { className: "flex items-center gap-2" },
                                            React.createElement("span", { className: "truncate" }, label),
                                            isHome && (React.createElement(Badge, { variant: "info", className: "px-1.5 py-0" }, "Home")))));
                                }))),
                            switchingTenantId !== null && (React.createElement("div", { className: "flex items-center gap-2 text-2xs text-muted-foreground", role: "status", "aria-live": "polite" },
                                React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                                React.createElement("span", null,
                                    "Switching tenant to",
                                    " ",
                                    findTenantLabel(tenants, switchingTenantId, "tenant"),
                                    "\u2026")))))),
                    React.createElement("section", { "aria-label": "Subscription quotas", className: "flex flex-wrap gap-2 rounded-md border border-border bg-card p-4" },
                        React.createElement(SummaryStatItem, { label: "Active subs", value: enabledCount, tone: "success", compact: true }),
                        React.createElement(SummaryStatItem, { label: "Disabled subs", value: disabledCount, tone: "warning", compact: true }),
                        React.createElement(SummaryStatItem, { label: "Tenants", value: tenants.length, tone: "info", compact: true })))),
                drawerTab === "subscriptions" && (React.createElement("div", { role: "tabpanel", id: "drawer-panel-subscriptions", "aria-labelledby": "drawer-tab-subscriptions" },
                    React.createElement("section", { "aria-label": "Subscriptions", className: "flex flex-col gap-2 rounded-md border border-border bg-card p-4" },
                        React.createElement("h3", { className: "m-0 text-base font-semibold" }, "Subscriptions"),
                        React.createElement(SubscriptionList, { account: account })))),
                drawerTab === "details" && (React.createElement("div", { role: "tabpanel", id: "drawer-panel-details", "aria-labelledby": "drawer-tab-details", className: "flex flex-col gap-4" },
                    React.createElement("section", { "aria-label": "Account identifiers", className: "rounded-md border border-border bg-card p-4" },
                        React.createElement("h3", { className: "mb-3 mt-0 text-base font-semibold" }, "Account identifiers"),
                        React.createElement("dl", { className: "grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-xs" },
                            React.createElement("dt", { className: "text-muted-foreground" }, "Display name"),
                            React.createElement("dd", { className: "font-medium text-foreground" }, account.name || React.createElement("em", null, "(not set)")),
                            React.createElement("dt", { className: "text-muted-foreground" }, "Username"),
                            React.createElement("dd", null,
                                React.createElement(CopyableText, { value: account.username, ariaLabel: "Copy username" })),
                            React.createElement("dt", { className: "text-muted-foreground" }, "Home tenant id"),
                            React.createElement("dd", null,
                                React.createElement(CopyableText, { value: account.tenantId, mono: true, ariaLabel: "Copy home tenant id" })),
                            React.createElement("dt", { className: "text-muted-foreground" }, "Active tenant id"),
                            React.createElement("dd", null,
                                React.createElement(CopyableText, { value: activeTenantId, mono: true, ariaLabel: "Copy active tenant id" })),
                            React.createElement("dt", { className: "text-muted-foreground" }, "Home account id"),
                            React.createElement("dd", null,
                                React.createElement(CopyableText, { value: account.homeAccountId, mono: true, ariaLabel: "Copy home account id" })),
                            account.localAccountId && (React.createElement(React.Fragment, null,
                                React.createElement("dt", { className: "text-muted-foreground" },
                                    "Local account id",
                                    React.createElement(InfoTooltip, { content: "AAD object id of this user/SPN in their home tenant. Required when this account is used as a subscription owner in a cross-tenant Subscription Alias request.", ariaLabel: "Local account id help", size: 12, className: "ml-1" })),
                                React.createElement("dd", null,
                                    React.createElement(CopyableText, { value: account.localAccountId, mono: true, ariaLabel: "Copy local account id" })))),
                            React.createElement("dt", { className: "text-muted-foreground" }, "Environment"),
                            React.createElement("dd", { className: "text-foreground" }, account.environment),
                            React.createElement("dt", { className: "text-muted-foreground" }, "Added"),
                            React.createElement("dd", { className: "text-foreground" },
                                React.createElement(Tooltip, null,
                                    React.createElement(TooltipTrigger, { asChild: true },
                                        React.createElement("span", { className: "cursor-help" }, formatRelativeTime(account.addedAt))),
                                    React.createElement(TooltipContent, { side: "top" }, account.addedAt && Number.isFinite(Date.parse(account.addedAt))
                                        ? new Date(account.addedAt).toISOString()
                                        : "Unknown"))),
                            account.signedOut && (React.createElement(React.Fragment, null,
                                React.createElement("dt", { className: "text-muted-foreground" }, "Session"),
                                React.createElement("dd", null,
                                    React.createElement(Badge, { variant: "warning", className: "gap-1" },
                                        React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Signed out \u2014 re-login required")))))),
                    React.createElement(AccountIntelligencePanel, { account: account, onClose: () => onOpenChange(false) }))),
                React.createElement("section", { className: "flex justify-end gap-2 pt-2" },
                    React.createElement(Button, { type: "button", variant: "outline", onClick: () => onRequestRemove(account.homeAccountId), "aria-label": `Remove account ${account.name || account.username}` },
                        React.createElement(Trash2, { className: "h-3.5 w-3.5" }),
                        "Remove account"))))));
};
/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */
const AzureAccountsPageInner = () => {
    var _a, _b;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const [adding, setAdding] = React.useState(false);
    const [initialLoading, setInitialLoading] = React.useState(true);
    const [error, setError] = React.useState(null);
    const [pendingRemoveId, setPendingRemoveId] = React.useState(null);
    /** Set when the operator chooses "Remove selected" — bulk variant. */
    const [pendingBulkRemove, setPendingBulkRemove] = React.useState(null);
    const [removing, setRemoving] = React.useState(false);
    const [tenantInput, setTenantInput] = React.useState("");
    /**
     * Per-row in-flight refresh set. Used by the per-row "Refresh subs"
     * action AND the bulk-refresh path so the operator sees per-account
     * spinners.
     */
    const [refreshingIds, setRefreshingIds] = React.useState(() => new Set());
    const [refreshingAll, setRefreshingAll] = React.useState(false);
    /** Row-selection set (controlled DataTable selection). */
    const [selection, setSelection] = React.useState(() => new Set());
    const [tenantInputId] = React.useState(() => `azure-accounts-tenant-input-${Math.random().toString(36).slice(2, 8)}`);
    const searchInputRef = React.useRef(null);
    /**
     * Page-level tenant-switch state. Tracks which accounts have a
     * tenant-switch in flight, keyed by homeAccountId. Used by the
     * inline row-level tenant dropdown so the operator can switch
     * tenants without opening the drawer first.
     */
    const [rowSwitchingByAccountId, setRowSwitchingByAccountId] = React.useState({});
    /** Per-account monotonic sequence for race-safety on rapid clicks. */
    const rowSwitchSeqRef = React.useRef({});
    /** Per-account AbortController so unmount / new switch cancel HTTP. */
    const rowSwitchAbortRef = React.useRef({});
    /** AbortController for the page-level initial / refresh-all load. */
    const loadAbortRef = React.useRef(null);
    React.useEffect(() => {
        return () => {
            var _a;
            (_a = loadAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
            for (const c of Object.values(rowSwitchAbortRef.current))
                c.abort();
        };
    }, []);
    /** Mutator passed to the drawer so it can sync row-busy state. */
    const registerRowSwitch = React.useCallback((homeAccountId, tenantId) => {
        setRowSwitchingByAccountId((prev) => {
            if (tenantId == null) {
                if (!(homeAccountId in prev))
                    return prev;
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const _a = prev, _b = homeAccountId, _drop = _a[_b], rest = __rest(_a, [typeof _b === "symbol" ? _b : _b + ""]);
                return rest;
            }
            if (prev[homeAccountId] === tenantId)
                return prev;
            return Object.assign(Object.assign({}, prev), { [homeAccountId]: tenantId });
        });
    }, []);
    const isRowSwitching = React.useCallback((homeAccountId) => rowSwitchingByAccountId[homeAccountId], [rowSwitchingByAccountId]);
    /**
     * Inline row-level tenant switch — delegates to the shared
     * `performTenantSwitch` helper. Owns the per-row seq + abort
     * controller so concurrent switches on different accounts don't
     * step on each other.
     */
    const handleRowSwitchTenant = React.useCallback((acct, tenantId) => __awaiter(void 0, void 0, void 0, function* () {
        var _c, _d;
        const homeAccountId = acct.homeAccountId;
        if (rowSwitchingByAccountId[homeAccountId])
            return; // already switching
        const currentActive = resolveActiveTenantId(acct);
        if (currentActive === tenantId)
            return; // no-op
        const seq = ((_c = rowSwitchSeqRef.current[homeAccountId]) !== null && _c !== void 0 ? _c : 0) + 1;
        rowSwitchSeqRef.current[homeAccountId] = seq;
        const controller = new AbortController();
        // Cancel any previous controller for the same account before we
        // swap it out — older switches are now stale.
        (_d = rowSwitchAbortRef.current[homeAccountId]) === null || _d === void 0 ? void 0 : _d.abort();
        rowSwitchAbortRef.current[homeAccountId] = controller;
        const isStale = () => { var _a; return ((_a = rowSwitchSeqRef.current[homeAccountId]) !== null && _a !== void 0 ? _a : 0) !== seq; };
        registerRowSwitch(homeAccountId, tenantId);
        try {
            yield performTenantSwitch(acct, tenantId, store, {
                source: "row",
                signal: controller.signal,
                isStale,
            });
        }
        finally {
            if (!isStale()) {
                registerRowSwitch(homeAccountId, null);
                if (rowSwitchAbortRef.current[homeAccountId] === controller) {
                    delete rowSwitchAbortRef.current[homeAccountId];
                }
            }
        }
    }), [rowSwitchingByAccountId, registerRowSwitch, store]);
    const [filters, setFilters] = useUrlState(INITIAL_FILTERS);
    // Debounced search — keeps the URL writes throttled so typing
    // doesn't spam the history stack.
    const [searchInput, setSearchInput] = React.useState(filters.q);
    // Sync the URL → input when the URL itself changes (e.g. back button).
    React.useEffect(() => {
        setSearchInput(filters.q);
    }, [filters.q]);
    React.useEffect(() => {
        if (searchInput === filters.q)
            return;
        const t = setTimeout(() => setFilters({ q: searchInput }), 200);
        return () => clearTimeout(t);
    }, [searchInput, filters.q, setFilters]);
    const accounts = React.useMemo(() => { var _a; return (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : []; }, [state.azureAccounts]);
    /** Prune the selection set when accounts are removed. */
    React.useEffect(() => {
        setSelection((prev) => {
            const live = new Set(accounts.map((a) => a.homeAccountId));
            let mutated = false;
            const next = new Set();
            for (const id of prev) {
                if (live.has(id))
                    next.add(id);
                else
                    mutated = true;
            }
            return mutated ? next : prev;
        });
    }, [accounts]);
    const statusCounts = React.useMemo(() => {
        let active = 0;
        let loading = 0;
        let errored = 0;
        let stuck = 0;
        const now = Date.now();
        for (const a of accounts) {
            if (a.status === "active")
                active += 1;
            else if (a.status === "loading")
                loading += 1;
            else if (a.status === "error")
                errored += 1;
            if (isAccountStuck(a, now))
                stuck += 1;
        }
        return { active, loading, error: errored, stuck };
    }, [accounts]);
    const totalSubCount = React.useMemo(() => accounts.reduce((sum, a) => sum + a.subscriptionCount, 0), [accounts]);
    const errorAccounts = React.useMemo(() => accounts.filter((a) => a.status === "error"), [accounts]);
    /**
     * Cross-tenant / sovereign-cloud / stale-tenant posture summary.
     * Runs once per `accounts` change so the row cells and the tenant
     * graph panel below share the same map (and the row cells don't each
     * re-classify their own account on every render).
     *
     * Corpus refs:
     *   New folder/_bypass_tenant_switch.md §2 (guest invitation),
     *   §2.4 (stale guests), §8 (sovereign endpoint catalog).
     */
    const posture = React.useMemo(() => summarizePosture(accounts), [accounts]);
    const filteredAccounts = React.useMemo(() => {
        var _a;
        const status = filters.status;
        const term = ((_a = filters.q) !== null && _a !== void 0 ? _a : "").toLowerCase().trim();
        return accounts.filter((a) => {
            var _a;
            if (status && a.status !== status)
                return false;
            if (term) {
                const activeTenant = resolveActiveTenantId(a);
                const haystacks = [
                    a.name,
                    a.username,
                    a.tenantId,
                    activeTenant,
                    a.homeAccountId,
                    ...((_a = a.tenants) !== null && _a !== void 0 ? _a : []).map((t) => [t.displayName, t.defaultDomain, t.tenantId]
                        .filter(Boolean)
                        .join(" ")),
                    ...a.subscriptions.map((s) => `${s.displayName} ${s.subscriptionId}`),
                ]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();
                if (!haystacks.includes(term))
                    return false;
            }
            return true;
        });
    }, [accounts, filters.status, filters.q]);
    const drawerAccountId = filters.account || null;
    const drawerAccount = React.useMemo(() => {
        var _a;
        return drawerAccountId
            ? ((_a = accounts.find((a) => a.homeAccountId === drawerAccountId)) !== null && _a !== void 0 ? _a : null)
            : null;
    }, [drawerAccountId, accounts]);
    // If the URL pointed to a missing account (e.g. removed in another
    // tab), clean it out so the drawer doesn't stay "open with nothing".
    React.useEffect(() => {
        if (!drawerAccountId)
            return;
        if (initialLoading)
            return;
        if (drawerAccount)
            return;
        setFilters({ account: "", tab: "" });
    }, [drawerAccountId, drawerAccount, initialLoading, setFilters]);
    const drawerTab = React.useMemo(() => {
        var _a;
        const raw = ((_a = filters.tab) !== null && _a !== void 0 ? _a : "").toLowerCase();
        return VALID_DRAWER_TABS.has(raw)
            ? raw
            : "tenants";
    }, [filters.tab]);
    const pendingRemoveAccount = React.useMemo(() => pendingRemoveId
        ? accounts.find((a) => a.homeAccountId === pendingRemoveId)
        : undefined, [pendingRemoveId, accounts]);
    const handleTenantInputChange = React.useCallback((value) => {
        setTenantInput(value);
    }, []);
    /* ---- Single-account refresh ---- */
    const refreshSingleAccount = React.useCallback((homeAccountId, signal) => __awaiter(void 0, void 0, void 0, function* () {
        var _e;
        const acct = accounts.find((a) => a.homeAccountId === homeAccountId);
        if (!acct)
            return;
        setRefreshingIds((prev) => {
            if (prev.has(homeAccountId))
                return prev;
            const next = new Set(prev);
            next.add(homeAccountId);
            return next;
        });
        store.updateAzureAccount(homeAccountId, { status: "loading" });
        try {
            // Parallel-load subs and tenants. Tenants are best-effort:
            // a tenants failure must not flip the account to error if
            // subs loaded fine. Re-pulling tenants on manual refresh
            // matters when an operator was newly granted access to a
            // tenant since the last load — the row dropdown then picks
            // it up without needing a hard reload.
            const [subs, tenants] = yield Promise.all([
                listSubscriptionsForAccount(homeAccountId),
                listAccessibleTenants(homeAccountId).catch(() => undefined),
            ]);
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                return;
            const enabledCount = subs.filter((s) => { var _a; return ((_a = s.state) !== null && _a !== void 0 ? _a : "Enabled") === "Enabled"; }).length;
            store.updateAzureAccount(homeAccountId, Object.assign({ subscriptions: subs, subscriptionCount: enabledCount, status: "active", error: null }, (tenants ? { tenants } : {})));
            auditLog.record({
                actor: acct.username || homeAccountId,
                action: "refresh_azure_account",
                target: acct.username || homeAccountId,
                status: "success",
                details: {
                    homeAccountId,
                    subscriptionsLoaded: subs.length,
                    tenantsLoaded: (_e = tenants === null || tenants === void 0 ? void 0 : tenants.length) !== null && _e !== void 0 ? _e : null,
                },
            });
        }
        catch (e) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            store.updateAzureAccount(homeAccountId, {
                status: "error",
                error: msg,
            });
            auditLog.record({
                actor: acct.username || homeAccountId,
                action: "refresh_azure_account",
                target: acct.username || homeAccountId,
                status: "failure",
                error: msg,
                details: { homeAccountId },
            });
        }
        finally {
            if (!(signal === null || signal === void 0 ? void 0 : signal.aborted)) {
                setRefreshingIds((prev) => {
                    if (!prev.has(homeAccountId))
                        return prev;
                    const next = new Set(prev);
                    next.delete(homeAccountId);
                    return next;
                });
            }
        }
    }), [accounts, store]);
    const handleRefreshOne = React.useCallback((homeAccountId) => {
        void refreshSingleAccount(homeAccountId);
    }, [refreshSingleAccount]);
    /* ---- Load accounts on mount ---- */
    const loadAllAccounts = React.useCallback((signal) => __awaiter(void 0, void 0, void 0, function* () {
        const isCancelled = () => (signal === null || signal === void 0 ? void 0 : signal.aborted) === true;
        if (!isCancelled())
            setError(null);
        try {
            const msalAccounts = yield getAllLoggedInAccounts();
            if (isCancelled())
                return;
            if (!msalAccounts || msalAccounts.length === 0) {
                store.setAzureAccounts([]);
                return;
            }
            const initial = msalAccounts.map((acct) => {
                var _a;
                return ({
                    homeAccountId: acct.homeAccountId,
                    localAccountId: acct.localAccountId,
                    username: acct.username,
                    name: (_a = acct.name) !== null && _a !== void 0 ? _a : "",
                    tenantId: acct.tenantId,
                    environment: acct.environment,
                    subscriptions: [],
                    subscriptionCount: 0,
                    status: "loading",
                    error: null,
                    addedAt: new Date().toISOString(),
                });
            });
            store.setAzureAccounts(initial);
            yield Promise.allSettled(initial.map((acct) => __awaiter(void 0, void 0, void 0, function* () {
                try {
                    // Fetch subs and tenants in parallel. Tenants are a
                    // best-effort side-load — failing to list tenants must
                    // NOT mark the account errored (subs are the canonical
                    // health signal). Pre-loading tenants here means the
                    // inline row dropdown can render a switchable list
                    // without the operator having to open the drawer first.
                    const [subs, tenants] = yield Promise.all([
                        listSubscriptionsForAccount(acct.homeAccountId),
                        listAccessibleTenants(acct.homeAccountId).catch(() => undefined),
                    ]);
                    if (isCancelled())
                        return;
                    const enabledCount = subs.filter((s) => { var _a; return ((_a = s.state) !== null && _a !== void 0 ? _a : "Enabled") === "Enabled"; }).length;
                    store.updateAzureAccount(acct.homeAccountId, Object.assign({ subscriptions: subs, subscriptionCount: enabledCount, status: "active", error: null }, (tenants ? { tenants } : {})));
                }
                catch (e) {
                    if (isCancelled())
                        return;
                    const msg = e instanceof Error ? e.message : String(e);
                    store.updateAzureAccount(acct.homeAccountId, {
                        status: "error",
                        error: msg,
                    });
                }
            })));
        }
        catch (e) {
            if (isCancelled())
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            store.setAzureAccounts([]);
        }
        finally {
            if (!isCancelled())
                setInitialLoading(false);
        }
    }), [store]);
    React.useEffect(() => {
        const controller = new AbortController();
        loadAbortRef.current = controller;
        void loadAllAccounts(controller.signal);
        return () => {
            controller.abort();
            if (loadAbortRef.current === controller)
                loadAbortRef.current = null;
        };
    }, [loadAllAccounts]);
    /* ---- Add account ---- */
    const handleAddAccount = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _f;
        setAdding(true);
        setError(null);
        const trimmed = tenantInput.trim();
        try {
            const result = trimmed ? yield login(trimmed) : yield loginAccount();
            if (!result) {
                return;
            }
            const newAccount = {
                homeAccountId: result.homeAccountId,
                localAccountId: result.localAccountId,
                username: result.username,
                name: (_f = result.name) !== null && _f !== void 0 ? _f : "",
                tenantId: result.tenantId,
                environment: result.environment,
                subscriptions: [],
                subscriptionCount: 0,
                status: "loading",
                error: null,
                addedAt: new Date().toISOString(),
                activeTenantId: trimmed || undefined,
            };
            store.upsertAzureAccount(newAccount);
            auditLog.record({
                actor: result.username || result.homeAccountId,
                action: "add_azure_account",
                target: result.username || result.homeAccountId,
                status: "success",
                details: {
                    tenantId: result.tenantId,
                    homeAccountId: result.homeAccountId,
                    requestedTenant: trimmed || null,
                },
            });
            try {
                const subs = yield listSubscriptionsForAccount(result.homeAccountId);
                const enabledCount = subs.filter((s) => { var _a; return ((_a = s.state) !== null && _a !== void 0 ? _a : "Enabled") === "Enabled"; }).length;
                store.updateAzureAccount(result.homeAccountId, {
                    subscriptions: subs,
                    subscriptionCount: enabledCount,
                    status: "active",
                    error: null,
                });
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                store.updateAzureAccount(result.homeAccountId, {
                    status: "error",
                    error: msg,
                });
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(`Failed to add account: ${msg}`);
            auditLog.record({
                actor: "operator",
                action: "add_azure_account",
                target: trimmed || "(home tenant)",
                status: "failure",
                error: msg,
            });
        }
        finally {
            setAdding(false);
        }
    }), [store, tenantInput]);
    /* ---- Remove flow ---- */
    const handleRequestRemove = React.useCallback((homeAccountId) => {
        setPendingRemoveId(homeAccountId);
    }, []);
    const removeOneAccount = React.useCallback((homeAccountId) => __awaiter(void 0, void 0, void 0, function* () {
        const removedAccount = accounts.find((a) => a.homeAccountId === homeAccountId);
        const actor = (removedAccount === null || removedAccount === void 0 ? void 0 : removedAccount.username) || homeAccountId;
        let logoutOk = true;
        let logoutErr = null;
        try {
            yield logoutAccount(homeAccountId);
        }
        catch (e) {
            // Best-effort logout — we still remove from store
            logoutOk = false;
            logoutErr = e instanceof Error ? e.message : String(e);
        }
        store.removeAzureAccount(homeAccountId);
        auditLog.record({
            actor,
            action: "remove_azure_account",
            target: actor,
            status: logoutOk ? "success" : "failure",
            error: logoutErr !== null && logoutErr !== void 0 ? logoutErr : undefined,
            details: {
                homeAccountId,
                tenantId: removedAccount === null || removedAccount === void 0 ? void 0 : removedAccount.tenantId,
                msalLogoutSucceeded: logoutOk,
            },
        });
        return logoutOk;
    }), [accounts, store]);
    const handleConfirmRemove = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!pendingRemoveId)
            return;
        setRemoving(true);
        try {
            yield removeOneAccount(pendingRemoveId);
            if (drawerAccountId === pendingRemoveId) {
                setFilters({ account: "", tab: "" });
            }
            setSelection((prev) => {
                if (!prev.has(pendingRemoveId))
                    return prev;
                const next = new Set(prev);
                next.delete(pendingRemoveId);
                return next;
            });
        }
        finally {
            setRemoving(false);
            setPendingRemoveId(null);
        }
    }), [
        pendingRemoveId,
        removeOneAccount,
        drawerAccountId,
        setFilters,
    ]);
    const handleCancelRemove = React.useCallback(() => {
        if (removing)
            return;
        setPendingRemoveId(null);
    }, [removing]);
    /* ---- Bulk operations ---- */
    const handleRequestBulkRemove = React.useCallback(() => {
        if (selection.size === 0)
            return;
        setPendingBulkRemove(Array.from(selection));
    }, [selection]);
    const handleConfirmBulkRemove = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!pendingBulkRemove || pendingBulkRemove.length === 0)
            return;
        setRemoving(true);
        try {
            let failed = 0;
            for (const id of pendingBulkRemove) {
                const ok = yield removeOneAccount(id);
                if (!ok)
                    failed += 1;
            }
            if (drawerAccountId && pendingBulkRemove.includes(drawerAccountId)) {
                setFilters({ account: "", tab: "" });
            }
            setSelection(new Set());
            if (failed === 0) {
                store.addNotification({
                    type: "success",
                    message: `Removed ${pendingBulkRemove.length} account${pendingBulkRemove.length === 1 ? "" : "s"}.`,
                });
            }
            else {
                store.addNotification({
                    type: "warning",
                    message: `Removed ${pendingBulkRemove.length} account${pendingBulkRemove.length === 1 ? "" : "s"} — ${failed} MSAL logout${failed === 1 ? "" : "s"} failed.`,
                });
            }
        }
        finally {
            setRemoving(false);
            setPendingBulkRemove(null);
        }
    }), [
        pendingBulkRemove,
        removeOneAccount,
        drawerAccountId,
        setFilters,
        store,
    ]);
    const handleCancelBulkRemove = React.useCallback(() => {
        if (removing)
            return;
        setPendingBulkRemove(null);
    }, [removing]);
    // COORDINATOR: extract bulk-subs-refresh — duplicated with regions /
    // subscriptions pages (they each iterate per-account `Promise.allSettled`
    // around `listSubscriptionsForAccount`). Worth a shared util in
    // `services/` once at least three pages need it.
    const handleBulkRefresh = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (selection.size === 0)
            return;
        const ids = Array.from(selection);
        const results = yield Promise.allSettled(ids.map((id) => refreshSingleAccount(id)));
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed === 0) {
            store.addNotification({
                type: "success",
                message: `Refreshed ${ids.length} account${ids.length === 1 ? "" : "s"}.`,
            });
        }
        else {
            store.addNotification({
                type: "warning",
                message: `Refreshed ${ids.length - failed} of ${ids.length} accounts — ${failed} failed.`,
            });
        }
        auditLog.record({
            actor: "operator",
            action: "bulk_refresh_azure_accounts",
            target: `${ids.length} account${ids.length === 1 ? "" : "s"}`,
            status: failed === 0 ? "success" : "failure",
            error: failed > 0 ? `${failed} account refresh(es) failed` : undefined,
            details: { count: ids.length, failed, ids },
        });
    }), [selection, refreshSingleAccount, store]);
    /* ---- Refresh / re-login ---- */
    const handleRefreshAll = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _g;
        setRefreshingAll(true);
        (_g = loadAbortRef.current) === null || _g === void 0 ? void 0 : _g.abort();
        const controller = new AbortController();
        loadAbortRef.current = controller;
        try {
            yield loadAllAccounts(controller.signal);
            if (!controller.signal.aborted) {
                auditLog.record({
                    actor: "operator",
                    action: "refresh_all_azure_accounts",
                    target: `${accounts.length} account${accounts.length === 1 ? "" : "s"}`,
                    status: "success",
                    details: { count: accounts.length },
                });
            }
        }
        catch (e) {
            if (!controller.signal.aborted) {
                const msg = e instanceof Error ? e.message : String(e);
                auditLog.record({
                    actor: "operator",
                    action: "refresh_all_azure_accounts",
                    target: "all",
                    status: "failure",
                    error: msg,
                });
            }
        }
        finally {
            if (loadAbortRef.current === controller)
                loadAbortRef.current = null;
            setRefreshingAll(false);
        }
    }), [loadAllAccounts, accounts.length]);
    const handleReLogin = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        const trimmed = tenantInput.trim();
        try {
            if (trimmed)
                yield login(trimmed);
            else
                yield loginAccount();
            auditLog.record({
                actor: "operator",
                action: "relogin_azure_account",
                target: trimmed || "(home tenant)",
                status: "success",
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            auditLog.record({
                actor: "operator",
                action: "relogin_azure_account",
                target: trimmed || "(home tenant)",
                status: "failure",
                error: msg,
            });
            // Don't surface here — the subsequent refreshAll attempt will
            // either succeed (transient popup-close) or set its own error.
        }
        void handleRefreshAll();
    }), [handleRefreshAll, tenantInput]);
    /* ---- Drawer open ---- */
    const handleRowActivate = React.useCallback((account) => {
        setFilters({ account: account.homeAccountId, tab: "tenants" });
    }, [setFilters]);
    const handleDrawerOpenChange = React.useCallback((open) => {
        if (!open)
            setFilters({ account: "", tab: "" });
    }, [setFilters]);
    const handleDrawerTabChange = React.useCallback((tab) => {
        setFilters({ tab });
    }, [setFilters]);
    /* ---- Filter handlers ---- */
    const handleStatusFilterChange = React.useCallback((next) => {
        const value = next === "active" || next === "loading" || next === "error"
            ? next
            : "";
        setFilters({ status: value });
    }, [setFilters]);
    const handleClearFilters = React.useCallback(() => {
        setSearchInput("");
        setFilters({ status: "", q: "" });
    }, [setFilters]);
    /* ---- Tenant-graph panel persisted visibility ---- */
    // Operators usually want to see the graph when triaging cross-tenant
    // flows and hide it when they're back to single-tenant work. Persist
    // the choice so the page picks up where they left it across reloads.
    const [showTenantGraph, setShowTenantGraph] = usePersistedState("azbm.azure-accounts.show-tenant-graph", false);
    /* ---- Keyboard shortcuts ---- */
    useShortcut("mod+shift+l", () => {
        const el = document.getElementById(tenantInputId);
        if (el instanceof HTMLInputElement)
            el.focus();
    });
    useShortcut("/", () => {
        var _a;
        (_a = searchInputRef.current) === null || _a === void 0 ? void 0 : _a.focus();
    });
    // Two-step "g <key>" chord state. `useShortcut` doesn't natively
    // support multi-key chords (it's a single-event chord matcher), so we
    // arm a leader after `g` is pressed and consume the next key within
    // 800ms. Press `Escape` (or just wait it out) to cancel. The leader
    // is intentionally short-lived so it doesn't swallow plain typing.
    const chordLeaderRef = React.useRef({ armed: false, timer: null });
    const armChordLeader = React.useCallback(() => {
        if (chordLeaderRef.current.timer) {
            clearTimeout(chordLeaderRef.current.timer);
        }
        chordLeaderRef.current.armed = true;
        chordLeaderRef.current.timer = setTimeout(() => {
            chordLeaderRef.current.armed = false;
            chordLeaderRef.current.timer = null;
        }, 800);
    }, []);
    const disarmChordLeader = React.useCallback(() => {
        if (chordLeaderRef.current.timer) {
            clearTimeout(chordLeaderRef.current.timer);
            chordLeaderRef.current.timer = null;
        }
        chordLeaderRef.current.armed = false;
    }, []);
    React.useEffect(() => {
        // Cleanup on unmount so a lingering timer doesn't fire post-unmount.
        return () => {
            if (chordLeaderRef.current.timer) {
                clearTimeout(chordLeaderRef.current.timer);
            }
        };
    }, []);
    // `g` arms the leader. Doesn't trigger any side-effect on its own —
    // the next key (`t` or `s`) determines the action.
    useShortcut("g", () => {
        armChordLeader();
    });
    // `t` — re-trigger tenant switch (single-key) OR jump to the tenant
    // graph (when preceded by `g`). The drawer-open + first-filtered-row
    // fallback below is the original single-key behaviour preserved.
    useShortcut("t", () => {
        var _a;
        if (chordLeaderRef.current.armed) {
            // `g t` — focus the global tenant graph: ensure it's visible and
            // scroll it into view.
            disarmChordLeader();
            setShowTenantGraph(true);
            // Defer so the panel actually mounted before we scroll.
            requestAnimationFrame(() => {
                const el = document.getElementById("azure-accounts-tenant-graph");
                el === null || el === void 0 ? void 0 : el.scrollIntoView({ behavior: "smooth", block: "start" });
            });
            return;
        }
        const targetId = drawerAccountId ||
            ((_a = filteredAccounts[0]) === null || _a === void 0 ? void 0 : _a.homeAccountId) ||
            null;
        if (!targetId)
            return;
        setFilters({ account: targetId, tab: "tenants" });
    });
    // `g s` — jump to the subscriptions tab on the currently-open
    // (or first-filtered) account.
    useShortcut("s", () => {
        var _a;
        if (!chordLeaderRef.current.armed)
            return;
        disarmChordLeader();
        const targetId = drawerAccountId ||
            ((_a = filteredAccounts[0]) === null || _a === void 0 ? void 0 : _a.homeAccountId) ||
            null;
        if (!targetId)
            return;
        setFilters({ account: targetId, tab: "subscriptions" });
    });
    // `Escape` cancels any armed leader (defensive — also closes Radix
    // dialogs/menus on its own).
    useShortcut("escape", () => {
        if (chordLeaderRef.current.armed)
            disarmChordLeader();
    });
    // `r` — refresh selected accounts (or every account when nothing is
    // selected). Power-user shortcut for "I just made changes externally,
    // pull fresh state" without reaching for the toolbar.
    useShortcut("r", () => {
        if (chordLeaderRef.current.armed)
            return; // `g r` reserved for future use
        if (selection.size > 0) {
            void handleBulkRefresh();
        }
        else {
            void handleRefreshAll();
        }
    });
    /* ---- Export columns ---- */
    const exportColumns = React.useMemo(() => [
        { header: "Name", accessor: (a) => a.name || "" },
        { header: "Username", accessor: (a) => a.username },
        { header: "Home Tenant", accessor: (a) => a.tenantId },
        { header: "Active Tenant", accessor: (a) => resolveActiveTenantId(a) },
        {
            header: "Active Tenant Name",
            accessor: (a) => findTenantLabel(a.tenants, resolveActiveTenantId(a), ""),
        },
        { header: "Home Account Id", accessor: (a) => a.homeAccountId },
        { header: "Subscriptions (enabled)", accessor: (a) => a.subscriptionCount },
        {
            header: "Subscriptions (total)",
            accessor: (a) => a.subscriptions.length,
        },
        { header: "Status", accessor: (a) => STATUS_LABELS[a.status] },
        { header: "Environment", accessor: (a) => a.environment },
        { header: "Added", accessor: (a) => { var _a; return (_a = a.addedAt) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Error", accessor: (a) => { var _a; return (_a = a.error) !== null && _a !== void 0 ? _a : ""; } },
    ], []);
    /* ---- Columns ---- */
    const columns = React.useMemo(() => [
        {
            id: "name",
            header: "Account",
            sort: (a, b) => compareStrings(a.name || a.username, b.name || b.username),
            csv: (a) => a.name || a.username,
            cell: (a) => (React.createElement("div", { className: "group/copy flex items-center gap-2.5" },
                React.createElement("div", { className: "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15" },
                    React.createElement(User, { className: "h-4 w-4 text-primary" })),
                React.createElement("div", { className: "min-w-0 flex-1" },
                    React.createElement("p", { className: "truncate text-xs font-semibold text-foreground" }, a.name || a.username),
                    React.createElement("div", { className: "flex items-center gap-1.5" },
                        React.createElement("p", { className: "truncate text-2xs text-muted-foreground" }, a.username),
                        React.createElement(CopyButton, { value: a.username, ariaLabel: `Copy username ${a.username}` }))))),
        },
        {
            id: "tenant",
            header: "Tenant",
            sort: (a, b) => compareStrings(a.tenantId, b.tenantId),
            csv: (a) => resolveActiveTenantId(a),
            cell: (a) => {
                var _a, _b, _c;
                const activeTenantId = resolveActiveTenantId(a);
                const activeTenant = (_a = a.tenants) === null || _a === void 0 ? void 0 : _a.find((t) => t.tenantId === activeTenantId);
                const friendly = (_b = activeTenant === null || activeTenant === void 0 ? void 0 : activeTenant.displayName) !== null && _b !== void 0 ? _b : activeTenant === null || activeTenant === void 0 ? void 0 : activeTenant.defaultDomain;
                const tenants = (_c = a.tenants) !== null && _c !== void 0 ? _c : [];
                const isSwitching = !!rowSwitchingByAccountId[a.homeAccountId];
                const switchingTo = rowSwitchingByAccountId[a.homeAccountId];
                // Corpus-grounded annotations:
                //   - crossTenantState: account holds a token for a tenant
                //     OTHER than its home — B2B guest token in active use.
                //     See _bypass_tenant_switch.md §2 "Guest Invitation Abuse".
                //   - cloud: which cloud minted the token (Commercial / Gov /
                //     China / Germany). See _bypass_tenant_switch.md §8.1
                //     "Endpoint catalog".
                const crossTenantState = posture.crossTenantByAccount[a.homeAccountId];
                const cloud = posture.cloudByAccount[a.homeAccountId];
                const showCloudBadge = cloud && cloud.kind !== "commercial" && cloud.kind !== "unknown";
                const annotations = (React.createElement(React.Fragment, null,
                    crossTenantState && (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", null,
                                React.createElement(Badge, { variant: crossTenantState.staleAssociation
                                        ? "destructive"
                                        : "warning", className: "gap-1 px-1 py-0 text-[9px]" },
                                    crossTenantState.staleAssociation ? (React.createElement(AlertTriangle, { className: "h-2.5 w-2.5", "aria-hidden": true })) : (React.createElement(Users, { className: "h-2.5 w-2.5", "aria-hidden": true })),
                                    crossTenantState.staleAssociation
                                        ? "Stale guest"
                                        : "Cross-tenant"))),
                        React.createElement(TooltipContent, { side: "top" },
                            React.createElement("div", { className: "flex max-w-[260px] flex-col gap-1 text-[11px]" },
                                React.createElement("span", null,
                                    "Active tenant",
                                    " ",
                                    React.createElement("strong", null, crossTenantState.activeTenantLabel),
                                    " ",
                                    "is NOT this account's home (",
                                    React.createElement("strong", null, crossTenantState.homeTenantLabel),
                                    ")."),
                                crossTenantState.staleAssociation && (React.createElement("span", { className: "text-warning" },
                                    "Active tenant id is not in this account's discovered tenants list \u2014 likely a stale B2B / Lighthouse association. See",
                                    " ",
                                    React.createElement("code", null, "_bypass_tenant_switch.md \u00A72.4"),
                                    ".")))))),
                    showCloudBadge && cloud && (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", null,
                                React.createElement(Badge, { variant: "info", className: "gap-1 px-1 py-0 text-[9px]" },
                                    React.createElement(Globe2, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                                    cloud.label))),
                        React.createElement(TooltipContent, { side: "top" },
                            React.createElement("div", { className: "flex max-w-[260px] flex-col gap-1 text-[11px]" },
                                React.createElement("span", null, cloud.description),
                                React.createElement("span", { className: "text-muted-foreground" },
                                    "Classified from MSAL ",
                                    React.createElement("code", null, "environment"),
                                    " ",
                                    "field. Defenders watching only commercial sign-in logs miss the sovereign side \u2014 see",
                                    " ",
                                    React.createElement("code", null, "_bypass_tenant_switch.md \u00A78.2"),
                                    ".")))))));
                if (tenants.length <= 1) {
                    return (React.createElement("div", { className: "flex flex-col gap-0.5" },
                        React.createElement("span", { className: "truncate text-xs text-foreground", title: activeTenantId }, friendly !== null && friendly !== void 0 ? friendly : (React.createElement("code", { className: "font-mono" }, truncateMiddle(activeTenantId, 8, 4)))),
                        (crossTenantState || showCloudBadge) && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" }, annotations))));
                }
                return (React.createElement("div", { className: "flex flex-col gap-1" },
                    React.createElement(DropdownMenu, null,
                        React.createElement(DropdownMenuTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "-mx-2 h-auto justify-start gap-1.5 px-2 py-1 text-xs font-normal", 
                                // Don't bubble the click to the row — clicking the
                                // tenant cell should open the dropdown, not the
                                // account drawer.
                                onClick: (e) => e.stopPropagation(), disabled: isSwitching, "aria-label": `Switch active tenant for ${a.username || a.name || a.homeAccountId}. ${tenants.length} tenants available.`, "aria-haspopup": "menu" },
                                React.createElement("div", { className: "flex flex-col items-start gap-0.5 min-w-0" },
                                    React.createElement("span", { className: "flex items-center gap-1.5 truncate text-xs text-foreground", title: activeTenantId },
                                        isSwitching ? (React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none text-primary" })) : null,
                                        React.createElement("span", { className: "truncate" }, friendly !== null && friendly !== void 0 ? friendly : (React.createElement("code", { className: "font-mono" }, truncateMiddle(activeTenantId, 8, 4))))),
                                    React.createElement("span", { className: "text-2xs text-muted-foreground" }, isSwitching && switchingTo
                                        ? `Switching to ${findTenantLabel(tenants, switchingTo, "tenant")}…`
                                        : `${tenants.length} tenants · click to switch`)),
                                React.createElement(ChevronsUpDown, { className: "ml-auto h-3 w-3 shrink-0 opacity-60", "aria-hidden": true }))),
                        React.createElement(DropdownMenuContent, { align: "start", onClick: (e) => e.stopPropagation() },
                            React.createElement(DropdownMenuLabel, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Active tenant"),
                            React.createElement(DropdownMenuSeparator, null),
                            sortTenantsForPicker(tenants, a.tenantId).map((t) => {
                                const label = t.displayName || t.defaultDomain || t.tenantId;
                                const isActive = t.tenantId === activeTenantId;
                                const isHome = t.tenantId === a.tenantId;
                                return (React.createElement(DropdownMenuItem, { key: t.tenantId, onClick: (e) => {
                                        e.stopPropagation();
                                        if (!isActive) {
                                            void handleRowSwitchTenant(a, t.tenantId);
                                        }
                                    }, disabled: isSwitching, className: "flex items-start gap-2" },
                                    React.createElement(Check, { className: cn("mt-0.5 h-3.5 w-3.5 shrink-0", isActive ? "text-primary" : "opacity-0"), "aria-hidden": true }),
                                    React.createElement("div", { className: "flex min-w-0 flex-col gap-0.5" },
                                        React.createElement("span", { className: "flex items-center gap-1.5 truncate text-xs" },
                                            React.createElement("span", { className: "truncate" }, label),
                                            isHome && (React.createElement(Badge, { variant: "info", className: "px-1 py-0 text-[9px]" }, "Home")),
                                            isActive && (React.createElement(Badge, { variant: "success", className: "px-1 py-0 text-[9px]" }, "Active"))),
                                        React.createElement("span", { className: "truncate font-mono text-[10px] text-muted-foreground" }, t.tenantId))));
                            }))),
                    (crossTenantState || showCloudBadge) && (React.createElement("div", { className: "flex flex-wrap items-center gap-1", onClick: (e) => e.stopPropagation() }, annotations))));
            },
        },
        {
            id: "subscriptionCount",
            header: "Subs",
            className: "text-right",
            width: "w-24",
            sort: (a, b) => compareNumbers(a.subscriptionCount, b.subscriptionCount),
            csv: (a) => a.subscriptionCount,
            cell: (a) => (React.createElement("span", { className: "tabular-nums text-xs font-medium text-info" }, a.subscriptionCount)),
        },
        {
            id: "status",
            header: "Status",
            width: "w-36",
            sort: (a, b) => compareStrings(a.status, b.status),
            csv: (a) => STATUS_LABELS[a.status],
            cell: (a) => {
                const Icon = a.status === "active"
                    ? ShieldCheck
                    : a.status === "loading"
                        ? Loader2
                        : AlertCircle;
                const animate = a.status === "loading";
                // Stuck-account detector: status is active but the last
                // successful load is >24h old. Reads `Date.now()` on each
                // cell render — cheap and avoids a separate ticker effect.
                // The same age threshold drives the filter chip and the
                // drawer header badge for visual consistency.
                const stuck = isAccountStuck(a, Date.now());
                return (React.createElement("span", { className: "inline-flex flex-wrap items-center gap-1.5" },
                    React.createElement("span", { className: cn("inline-flex items-center gap-1.5 text-xs font-medium", statusToneClass(a.status)) },
                        React.createElement(Icon, { className: cn("h-3.5 w-3.5", animate && "animate-spin motion-reduce:animate-none"), "aria-hidden": true }),
                        STATUS_LABELS[a.status]),
                    stuck && (React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", { "aria-label": "Refresh due \u2014 last load >24h ago" },
                                React.createElement(Badge, { variant: "warning", className: "gap-1 px-1 py-0 text-[9px]" },
                                    React.createElement(Timer, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                                    "Stale"))),
                        React.createElement(TooltipContent, { side: "top" }, "Last refreshed more than 24h ago. Click the refresh icon to re-fetch this account.")))));
            },
        },
        {
            id: "added",
            header: "Age",
            width: "w-28",
            sort: (a, b) => {
                const aTs = a.addedAt ? Date.parse(a.addedAt) : NaN;
                const bTs = b.addedAt ? Date.parse(b.addedAt) : NaN;
                if (!Number.isFinite(aTs) && !Number.isFinite(bTs))
                    return 0;
                if (!Number.isFinite(aTs))
                    return 1;
                if (!Number.isFinite(bTs))
                    return -1;
                return aTs - bTs;
            },
            csv: (a) => { var _a; return (_a = a.addedAt) !== null && _a !== void 0 ? _a : ""; },
            cell: (a) => {
                // Mini "trend" sparkline encoding bucket(age) — operators
                // scanning a long list can spot the accounts that haven't been
                // refreshed in a while without reading the relative time
                // string. The full ISO + relative-time still live in the
                // drawer's Details tab.
                const bucket = bucketAccountAge(a, Date.now());
                return (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                            React.createElement(TokenAgeBars, { bucket: bucket.bucket, ageLabel: bucket.ageLabel }))),
                    React.createElement(TooltipContent, { side: "top" },
                        "Last refreshed ",
                        formatRelativeTime(a.addedAt),
                        " \u00B7",
                        " ",
                        "bucket: ",
                        bucket.bucket)));
            },
        },
        {
            id: "actions",
            header: "",
            width: "w-24",
            cell: (a) => {
                const refreshing = refreshingIds.has(a.homeAccountId);
                return (React.createElement("div", { className: "flex items-center justify-end gap-1", onClick: (e) => e.stopPropagation() },
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", null,
                                React.createElement(Button, { variant: "ghost", size: "icon-sm", onClick: () => handleRefreshOne(a.homeAccountId), disabled: refreshing || a.status === "loading", "aria-label": `Refresh subscriptions for ${a.name || a.username}` },
                                    React.createElement(RefreshCw, { className: cn("h-3.5 w-3.5", (refreshing || a.status === "loading") &&
                                            "animate-spin motion-reduce:animate-none") })))),
                        React.createElement(TooltipContent, { side: "left" }, "Re-fetch this account's subscriptions.")),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("span", null,
                                React.createElement(Button, { variant: "ghost", size: "icon-sm", onClick: () => handleRequestRemove(a.homeAccountId), "aria-label": `Remove account ${a.name || a.username}`, className: "text-destructive hover:bg-destructive/10" },
                                    React.createElement(Trash2, { className: "h-3.5 w-3.5" })))),
                        React.createElement(TooltipContent, { side: "left" }, "Remove (sign out of) this account."))));
            },
        },
    ], 
    // The cell renderers close over page-level callbacks/state — keep
    // these in the dep list so they always see the latest refs.
    [
        rowSwitchingByAccountId,
        handleRowSwitchTenant,
        refreshingIds,
        handleRefreshOne,
        handleRequestRemove,
        posture,
    ]);
    const hasFilters = !!filters.status || ((_a = filters.q) !== null && _a !== void 0 ? _a : "").trim().length > 0;
    const filterMatchCount = filteredAccounts.length;
    const drawerAccountIsRefreshing = drawerAccount
        ? refreshingIds.has(drawerAccount.homeAccountId)
        : false;
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
        React.createElement("div", { className: "relative overflow-hidden rounded-xl border bg-card/50 p-6" },
            React.createElement(DotPattern, { fade: "top-left", className: "absolute inset-0" }),
            React.createElement(Meteors, { count: 12, tone: "primary", className: "absolute inset-0" }),
            React.createElement("div", { className: "relative z-10" },
                React.createElement(PageHeader, { title: "Azure Accounts", description: "Sign in with one or more AAD accounts and pick the active tenant for each." },
                    React.createElement(PreLoginTenantSelector, { tenantInput: tenantInput, onTenantInputChange: handleTenantInputChange, onSignIn: handleAddAccount, signingIn: adding, layout: "compact", signInLabel: "Add Account" }),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { variant: "outline", onClick: handleRefreshAll, disabled: initialLoading || refreshingAll, loading: refreshingAll, "aria-label": "Refresh all accounts" },
                                !refreshingAll && (React.createElement(RotateCw, { className: cn("h-3.5 w-3.5 transition-transform duration-200", initialLoading &&
                                        "animate-spin motion-reduce:animate-none") })),
                                "Refresh All")),
                        React.createElement(TooltipContent, { side: "bottom" }, initialLoading
                            ? "Initial load in progress."
                            : "Re-fetch subscriptions for every signed-in account."))))),
        error && (React.createElement(ErrorState, { message: "Failed to load accounts.", detail: error, onRetry: handleRefreshAll, action: React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setError(null), "aria-label": "Dismiss error" }, "Dismiss") })),
        errorAccounts.length > 0 && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertCircle, { className: "h-4 w-4" }),
            React.createElement(AlertTitle, null,
                errorAccounts.length,
                " account",
                errorAccounts.length === 1 ? "" : "s",
                " failed to load subscriptions"),
            React.createElement(AlertDescription, null,
                React.createElement("p", { className: "mb-2 text-2xs" }, "Re-login or refresh to recover. Individual accounts can be refreshed from the row action menu."),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleRefreshAll, disabled: refreshingAll, loading: refreshingAll, "aria-label": "Refresh all accounts" },
                        !refreshingAll && React.createElement(RefreshCw, { className: "h-3.5 w-3.5" }),
                        "Refresh all"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleReLogin, "aria-label": "Re-login the failed account" },
                        React.createElement(LogIn, { className: "h-3.5 w-3.5" }),
                        "Re-login"))))),
        React.createElement(Card, { className: "flex flex-wrap gap-2 px-4 py-3", role: "status", "aria-live": "polite" },
            React.createElement(SummaryStatItem, { label: "Accounts", value: accounts.length, tone: "info", compact: true }),
            React.createElement(SummaryStatItem, { label: "Active", value: statusCounts.active, tone: "success", compact: true }),
            React.createElement(SummaryStatItem, { label: "Loading", value: statusCounts.loading, tone: "warning", compact: true }),
            React.createElement(SummaryStatItem, { label: "Errors", value: statusCounts.error, tone: "destructive", compact: true }),
            statusCounts.stuck > 0 && (React.createElement(SummaryStatItem, { label: "Stale (>24h)", value: statusCounts.stuck, tone: "warning", compact: true })),
            React.createElement(SummaryStatItem, { label: "Subscriptions", value: totalSubCount, tone: "info", compact: true })),
        accounts.length > 0 && (React.createElement("div", { className: "flex flex-col gap-3" },
            React.createElement("div", { className: "flex flex-wrap items-end gap-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { htmlFor: "azure-accounts-search", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Search"),
                    React.createElement("div", { className: "relative" },
                        React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" }),
                        React.createElement(Input, { id: "azure-accounts-search", ref: searchInputRef, type: "search", placeholder: "Search by name, username, tenant, sub...", value: searchInput, onChange: (e) => setSearchInput(e.target.value), className: "h-8 w-72 pl-8 text-xs", "aria-label": "Search accounts" }))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { htmlFor: "azure-accounts-status-filter", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Status"),
                    React.createElement(Select, { value: filters.status || "all", onValueChange: (v) => handleStatusFilterChange(v === "all" ? "" : v) },
                        React.createElement(SelectTrigger, { id: "azure-accounts-status-filter", className: "h-8 w-40 text-xs", "aria-label": "Filter accounts by status" },
                            React.createElement(SelectValue, { placeholder: "All statuses" })),
                        React.createElement(SelectContent, null,
                            React.createElement(SelectItem, { value: "all" }, "All statuses"),
                            React.createElement(SelectItem, { value: "active" }, "Active"),
                            React.createElement(SelectItem, { value: "loading" }, "Loading"),
                            React.createElement(SelectItem, { value: "error" }, "Error")))),
                hasFilters && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: handleClearFilters, "aria-label": "Clear filters" },
                    React.createElement(Filter, { className: "h-3.5 w-3.5" }),
                    "Clear filters")),
                React.createElement("div", { className: "ml-auto flex items-center gap-2" },
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: showTenantGraph ? "default" : "outline", size: "sm", onClick: () => setShowTenantGraph((v) => !v), "aria-pressed": showTenantGraph, "aria-label": showTenantGraph
                                    ? "Hide tenant graph panel"
                                    : "Show tenant graph panel" },
                                React.createElement(Network, { className: "h-3.5 w-3.5" }),
                                "Tenant graph")),
                        React.createElement(TooltipContent, { side: "bottom" },
                            React.createElement("div", { className: "flex max-w-[260px] flex-col gap-1 text-[11px]" },
                                React.createElement("span", null,
                                    "Toggle the cross-tenant / sovereign-cloud trust topology view. Press ",
                                    React.createElement(Kbd, null, "g"),
                                    " then ",
                                    React.createElement(Kbd, null, "t"),
                                    " ",
                                    "to jump to it."),
                                React.createElement("span", { className: "text-muted-foreground" }, "Inspired by SpecterOps/AzureHound & ROADtools/roadrecon \u2014 see corpus.")))),
                    React.createElement(ExportMenu, { rows: filteredAccounts, columns: exportColumns, filename: "azure-accounts", jsonMetadata: {
                            source: "AzureBatchManager.AzureAccounts",
                            statusFilter: filters.status || undefined,
                            searchQuery: filters.q || undefined,
                            crossTenantCount: posture.crossTenantCount,
                            staleTenantCount: posture.staleTenantCount,
                            sovereignAccountCount: posture.sovereignAccountCount,
                        }, disabled: filteredAccounts.length === 0 }))),
            React.createElement("div", { className: "flex items-center gap-1 self-start rounded-md border border-border bg-card p-0.5", role: "group", "aria-label": "Filter accounts by status" }, [
                { key: "", label: "All", count: accounts.length },
                {
                    key: "active",
                    label: "Active",
                    count: statusCounts.active,
                },
                {
                    key: "loading",
                    label: "Loading",
                    count: statusCounts.loading,
                },
                {
                    key: "error",
                    label: "Errored",
                    count: statusCounts.error,
                },
            ].map((chip) => (React.createElement("button", { key: chip.key || "all", type: "button", onClick: () => handleStatusFilterChange(chip.key), "aria-pressed": filters.status === chip.key, className: cn("rounded-sm px-2 py-1 text-2xs font-medium uppercase tracking-wider transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", filters.status === chip.key
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground") },
                chip.label,
                React.createElement("span", { className: "ml-1 tabular-nums opacity-70" }, chip.count))))),
            selection.size > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2", role: "region", "aria-label": "Bulk actions" },
                React.createElement("span", { className: "text-xs font-medium text-foreground" },
                    selection.size,
                    " selected"),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => setSelection(new Set()), "aria-label": "Clear selection" }, "Clear"),
                React.createElement("span", { className: "mx-1 h-4 w-px bg-border", "aria-hidden": true }),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleBulkRefresh, disabled: refreshingIds.size > 0, "aria-label": `Refresh ${selection.size} selected account${selection.size === 1 ? "" : "s"}` },
                    React.createElement(RefreshCw, { className: "h-3.5 w-3.5" }),
                    "Refresh selected"),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleRequestBulkRemove, className: "border-destructive/60 text-destructive hover:bg-destructive/10", "aria-label": `Remove ${selection.size} selected account${selection.size === 1 ? "" : "s"}` },
                    React.createElement(Trash2, { className: "h-3.5 w-3.5" }),
                    "Remove selected"))),
            hasFilters && (React.createElement("p", { className: "text-2xs text-muted-foreground", role: "status", "aria-live": "polite" },
                "Showing ",
                filterMatchCount,
                " of ",
                accounts.length,
                " account",
                accounts.length === 1 ? "" : "s",
                filters.q && (React.createElement(React.Fragment, null,
                    " ",
                    "matching \"",
                    React.createElement("strong", null, filters.q),
                    "\"")),
                filters.status && (React.createElement(React.Fragment, null,
                    " ",
                    "with status \"",
                    React.createElement("strong", null, STATUS_LABELS[filters.status]),
                    "\"")),
                ".")))),
        accounts.length > 0 &&
            (posture.crossTenantCount > 0 ||
                posture.sovereignAccountCount > 0 ||
                posture.staleTenantCount > 0) && (React.createElement(Card, { className: "flex flex-wrap items-center gap-3 px-3 py-2", role: "status", "aria-live": "polite" },
            posture.crossTenantCount > 0 && (React.createElement("span", { className: "inline-flex items-center gap-1.5 text-xs" },
                React.createElement(Users, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true }),
                React.createElement("strong", null, posture.crossTenantCount),
                " account",
                posture.crossTenantCount === 1 ? "" : "s",
                " on a non-home tenant",
                React.createElement(InfoTooltip, { content: "Account.activeTenantId differs from homeTenantId \u2014 B2B guest token in active use. See New folder/_bypass_tenant_switch.md \u00A72.", ariaLabel: "Cross-tenant info", size: 12 }))),
            posture.staleTenantCount > 0 && (React.createElement("span", { className: "inline-flex items-center gap-1.5 text-xs" },
                React.createElement(AlertTriangle, { className: "h-3.5 w-3.5 text-destructive", "aria-hidden": true }),
                React.createElement("strong", null, posture.staleTenantCount),
                " stale tenant association",
                posture.staleTenantCount === 1 ? "" : "s",
                React.createElement(InfoTooltip, { content: "Active tenant id is not present in this account's discovered tenants list \u2014 likely a deleted B2B relationship or revoked guest invitation. See New folder/_bypass_tenant_switch.md \u00A72.4.", ariaLabel: "Stale guest info", size: 12 }))),
            posture.sovereignAccountCount > 0 && (React.createElement("span", { className: "inline-flex items-center gap-1.5 text-xs" },
                React.createElement(Globe2, { className: "h-3.5 w-3.5 text-info", "aria-hidden": true }),
                React.createElement("strong", null, posture.sovereignAccountCount),
                " ",
                "sovereign-cloud sign-in",
                posture.sovereignAccountCount === 1 ? "" : "s",
                React.createElement(InfoTooltip, { content: "Account signed in via a sovereign cloud (Gov / China / Germany) endpoint rather than Commercial. See New folder/_bypass_tenant_switch.md \u00A78.", ariaLabel: "Sovereign cloud info", size: 12 }))),
            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setShowTenantGraph((v) => !v), className: "ml-auto", "aria-label": showTenantGraph
                    ? "Hide tenant graph"
                    : "Show tenant graph" }, showTenantGraph ? "Hide graph" : "Open graph"))),
        accounts.length > 0 && showTenantGraph && (React.createElement("div", { id: "azure-accounts-tenant-graph" },
            React.createElement(TenantGraphPanel, { accounts: accounts, cloudByAccount: posture.cloudByAccount, crossTenantByAccount: posture.crossTenantByAccount, onOpenAccount: (homeAccountId) => setFilters({ account: homeAccountId, tab: "tenants" }) }))),
        initialLoading && accounts.length === 0 ? (React.createElement(SkeletonLoader, { variant: "table", rows: 4, columns: 4 })) : accounts.length === 0 ? (React.createElement("div", { className: "flex flex-col items-center gap-4" },
            React.createElement(EmptyState, { icon: User, title: "No Azure accounts signed in", description: "Sign in to load subscriptions and continue to the multi-region dashboard.", action: {
                    label: "Sign in",
                    icon: LogIn,
                    onClick: handleAddAccount,
                    loading: adding,
                } }),
            React.createElement(Card, { className: "relative w-full max-w-md overflow-hidden px-4 py-4" },
                React.createElement(BorderBeam, { size: 200, duration: 8 }),
                React.createElement("div", { id: tenantInputId },
                    React.createElement(PreLoginTenantSelector, { tenantInput: tenantInput, onTenantInputChange: handleTenantInputChange, onSignIn: handleAddAccount, signingIn: adding, layout: "stacked" }))),
            React.createElement("p", { className: "text-2xs text-muted-foreground" },
                "Tip: ",
                React.createElement(Kbd, null, "⌘"),
                "+",
                React.createElement(Kbd, null, "Shift"),
                "+",
                React.createElement(Kbd, null, "L"),
                " focuses the sign-in field, ",
                React.createElement(Kbd, null, "/"),
                " focuses search."))) : (React.createElement(DataTable, { tableId: "azure-accounts", rows: filteredAccounts, columns: columns, rowKey: (a) => a.homeAccountId, onRowActivate: handleRowActivate, selection: selection, onSelectionChange: setSelection, initialSort: { column: "name", direction: "asc" }, empty: React.createElement("div", { className: "flex flex-col items-center gap-3 py-6" },
                React.createElement(EmptyState, { icon: User, title: "No accounts match the current filter", description: "Adjust the status filter or clear the search to see more accounts.", action: hasFilters
                        ? {
                            label: "Clear filters",
                            icon: Filter,
                            onClick: handleClearFilters,
                        }
                        : undefined })), csvFileName: "azure-accounts.csv", jsonFileName: "azure-accounts.json" })),
        accounts.length > 0 && (React.createElement("p", { className: "self-center text-2xs text-muted-foreground" },
            React.createElement(Clock, { className: "mr-1 inline h-3 w-3", "aria-hidden": true }),
            " Tip: press",
            " ",
            React.createElement(Kbd, null, "/"),
            " to focus search, ",
            React.createElement(Kbd, null, "t"),
            " to open the tenant picker, ",
            React.createElement(Kbd, null, "r"),
            " to refresh",
            " ",
            selection.size > 0 ? "selected" : "all",
            ", ",
            React.createElement(Kbd, null, "g"),
            " then",
            " ",
            React.createElement(Kbd, null, "t"),
            " to jump to the tenant graph, ",
            React.createElement(Kbd, null, "g"),
            " then",
            " ",
            React.createElement(Kbd, null, "s"),
            " to jump to subscriptions, ",
            React.createElement(Kbd, null, "Enter"),
            " on a row to open its detail drawer.")),
        React.createElement(AccountDrawer, { account: drawerAccount, open: drawerAccount !== null, onOpenChange: handleDrawerOpenChange, onRequestRemove: handleRequestRemove, onRequestRefresh: handleRefreshOne, isAccountRefreshing: drawerAccountIsRefreshing, isRowSwitching: isRowSwitching, registerRowSwitch: registerRowSwitch, drawerTab: drawerTab, onDrawerTabChange: handleDrawerTabChange }),
        React.createElement(ConfirmationDialog, { hidden: pendingRemoveId === null, title: "Remove Azure account?", message: pendingRemoveAccount
                ? `Sign out and remove "${pendingRemoveAccount.name || pendingRemoveAccount.username}"? You'll need to sign in again to access its ${pendingRemoveAccount.subscriptionCount} subscription${pendingRemoveAccount.subscriptionCount === 1 ? "" : "s"}.`
                : "Sign out and remove this account?", confirmText: "Remove", cancelText: "Cancel", danger: true, loading: removing, onConfirm: handleConfirmRemove, onCancel: handleCancelRemove }),
        React.createElement(ConfirmationDialog, { hidden: pendingBulkRemove === null, title: `Remove ${(_b = pendingBulkRemove === null || pendingBulkRemove === void 0 ? void 0 : pendingBulkRemove.length) !== null && _b !== void 0 ? _b : 0} account${(pendingBulkRemove === null || pendingBulkRemove === void 0 ? void 0 : pendingBulkRemove.length) === 1 ? "" : "s"}?`, message: pendingBulkRemove && pendingBulkRemove.length > 0 ? (React.createElement("div", { className: "flex flex-col gap-2" },
                React.createElement("p", null,
                    "Sign out and remove the selected account",
                    pendingBulkRemove.length === 1 ? "" : "s",
                    ". This affects:"),
                React.createElement("ul", { className: "max-h-40 list-disc overflow-y-auto pl-5 text-xs" }, pendingBulkRemove.map((id) => {
                    const acct = accounts.find((a) => a.homeAccountId === id);
                    if (!acct)
                        return null;
                    return (React.createElement("li", { key: id },
                        React.createElement("strong", null, acct.name || acct.username),
                        acct.subscriptionCount > 0 && (React.createElement(React.Fragment, null,
                            " ",
                            "\u2014 ",
                            acct.subscriptionCount,
                            " subscription",
                            acct.subscriptionCount === 1 ? "" : "s"))));
                })),
                React.createElement("p", { className: "text-2xs text-muted-foreground" }, "You'll need to sign in again to access these subscriptions."))) : ("Sign out and remove the selected accounts?"), confirmText: "Remove all", cancelText: "Cancel", danger: true, loading: removing, onConfirm: handleConfirmBulkRemove, onCancel: handleCancelBulkRemove })));
};
export const AzureAccountsPage = () => (React.createElement(ErrorBoundary, null,
    React.createElement(AzureAccountsPageInner, null)));
//# sourceMappingURL=azure-accounts-page.js.map