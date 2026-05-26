import { __awaiter } from "tslib";
/**
 * Sub Manager — subscription-scope RBAC management.
 *
 * Lets the operator pick one of their signed-in accounts, pick a
 * subscription that account can see, and then:
 *   - List every role assignment at that subscription's scope (resolving
 *     principal GUIDs to display names via Graph).
 *   - Filter / search by role, principal type, scope, kind, and "stale"
 *     (couldn't-resolve) status.
 *   - Select rows to bulk-delete (Azure only allows deletes at the
 *     scope the assignment was created at — inherited rows are shown
 *     but locked).
 *   - Add a new assignment by UPN/email or raw object id, with a role
 *     picker that lists every built-in + custom role visible at the
 *     subscription scope.
 *   - Group-by-role view, sortable list, exportable CSV/JSON, quick
 *     "Remove me" shortcut for the common "leave a sub" case.
 *
 * Self-protection: removing the signed-in operator OR the only remaining
 * Owner requires an extra confirm. Audit log records every mutation —
 * both success and failure paths.
 *
 * URL sync: ?tab, ?account, ?sub, ?ba are all kept in sync so links
 * deep-link straight into the right view. SessionStorage is the fallback
 * so reopening the page restores the last picker state.
 *
 * Keyboard: `/` focuses the search box, `Esc` clears selection.
 */
import * as React from "react";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, ArrowUpDown, Building2, Check, ChevronDown, ChevronRight, Copy, Crown, Edit3, Eye, EyeOff, Filter, Key, Layers, ListChecks, Loader2, LogOut, Plus, RefreshCw, Search, Shield, ShieldAlert, ShieldOff, Sparkles, Trash2, User, Users, UserPlus, X, } from "lucide-react";
import { useUrlParam } from "../../hooks/use-url-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { getActiveTenant, getArmTokenForAccount, getGraphTokenForAccount, } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { auditLog } from "../../services/audit-log";
import { assignSubscriptionRole, AZURE_ROLE_OWNER, createEaDepartment, createEnrollmentAccountRoleAssignment, deleteEaDepartment, deleteRoleAssignment, findUserByUpnOrMail, getPrincipalsByIds, listEaBillingAccounts, listEaDepartments, listEnrollmentAccounts, listSubscriptions, listSubscriptionRoleAssignments, listSubscriptionRoleDefinitions, ROLE_EA_SUBSCRIPTION_CREATOR, updateEaDepartment, } from "../../services";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
// COORDINATOR: page-router contract exposes `navigateToPage` (path-based) and
// `store` via `useDashboardOutletContext`. We use that here instead of the
// raw `useNavigate` hook so deep-page navigation goes through the
// canonical router wrapper (preserves PageBoundary + path translation).
import { useDashboardOutletContext } from "../page-router";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
/* ----- Storage keys for cross-navigation persistence ---------------- */
const STORAGE_ACCOUNT = "sub-manager:account";
const STORAGE_SUBSCRIPTION = "sub-manager:subscription";
const STORAGE_TAB = "sub-manager:tab";
const STORAGE_BA = "sub-manager:billing-account";
// Remembers the last role used on the "Add user" form so repeat operators
// don't have to re-pick the same role every time. Cleared if the role
// definition is no longer visible at the picked subscription scope.
const STORAGE_LAST_ROLE = "sub-manager:last-role";
// Remembers the visual mode preference (flat list vs grouped-by-role).
const STORAGE_VIEW_MODE = "sub-manager:view-mode";
const PRINCIPAL_TYPE_FILTERS = [
    { value: "all", label: "Any principal type" },
    { value: "User", label: "Users" },
    { value: "Group", label: "Groups" },
    { value: "ServicePrincipal", label: "Service principals" },
    { value: "ForeignGroup", label: "Foreign groups" },
];
function principalIcon(type) {
    if (type === "User")
        return User;
    if (type === "Group")
        return Users;
    if (type === "ServicePrincipal" || type === "Application")
        return Shield;
    return Key;
}
/** Format ISO timestamp → "May 24, 2026" (locale aware), falling back to raw. */
function fmtDate(iso) {
    if (!iso)
        return "";
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime()))
            return iso;
        return d.toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
        });
    }
    catch (_a) {
        return iso;
    }
}
/**
 * Memoized to short-circuit re-renders when an unrelated row mutates
 * state (selection toggle, filter change). With 100+ assignments and an
 * `onToggleSelect` that gets a fresh closure per render, the un-memoized
 * version paid for a full subtree reconcile on every keystroke in the
 * search box. Equality compares the row identity (principalId +
 * roleDefinitionId + assignment.id + principal.displayName since the
 * Graph resolve mutates that lazily) plus the per-row toggle inputs.
 */
const AssignmentRowImpl = ({ row: r, isSelf, isChecked, onToggleSelect, deleting, isCustomRole, hideRoleBadge = false, }) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const Icon = principalIcon(r.assignment.principalType);
    const isOwner = r.assignment.roleDefinitionId === AZURE_ROLE_OWNER;
    const lockedReason = !r.assignment.atScope
        ? "Inherited — delete at the scope it was created on."
        : null;
    const unresolved = !((_a = r.principal) === null || _a === void 0 ? void 0 : _a.displayName);
    return (React.createElement("li", { className: `flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs transition-colors ${isSelf ? "bg-warning/5 border-warning/40" : ""} ${isChecked ? "bg-accent/40" : ""}` },
        React.createElement(Checkbox, { "aria-label": `Select ${(_c = (_b = r.principal) === null || _b === void 0 ? void 0 : _b.displayName) !== null && _c !== void 0 ? _c : r.assignment.principalId}`, checked: isChecked, disabled: !r.assignment.atScope || deleting, onCheckedChange: onToggleSelect }),
        React.createElement(Icon, { className: `h-3.5 w-3.5 shrink-0 ${unresolved ? "text-destructive/70" : "text-muted-foreground"}` }),
        React.createElement("span", { className: "flex min-w-0 flex-1 flex-col" },
            React.createElement("span", { className: "flex flex-wrap items-center gap-1 truncate font-medium" }, (_e = (_d = r.principal) === null || _d === void 0 ? void 0 : _d.displayName) !== null && _e !== void 0 ? _e : (React.createElement("span", { className: "font-mono text-2xs italic text-muted-foreground", title: "Graph couldn't resolve this principal to a display name." }, r.assignment.principalId)),
                isSelf && (React.createElement(Badge, { variant: "warning", className: "ml-1 text-2xs" }, "you")),
                unresolved && ((_f = r.principal) === null || _f === void 0 ? void 0 : _f.displayName) && (React.createElement(Badge, { variant: "destructive", className: "ml-1 text-2xs" }, "unresolved"))),
            React.createElement("span", { className: "flex flex-wrap items-center gap-1 text-2xs text-muted-foreground" },
                ((_g = r.principal) === null || _g === void 0 ? void 0 : _g.signInName) && (React.createElement("span", { className: "font-mono" },
                    r.principal.signInName,
                    " \u00B7")),
                React.createElement(CopyableText, { value: r.assignment.principalId, mono: true, ariaLabel: `Copy principal id ${r.assignment.principalId}` }),
                r.assignment.createdOn && (React.createElement(React.Fragment, null,
                    React.createElement("span", { className: "opacity-60" }, "\u00B7"),
                    React.createElement("span", { title: r.assignment.createdOn }, fmtDate(r.assignment.createdOn)))),
                r.assignment.description && (React.createElement(React.Fragment, null,
                    React.createElement("span", { className: "opacity-60" }, "\u00B7"),
                    React.createElement("span", { className: "truncate italic", title: r.assignment.description },
                        "\u201C",
                        r.assignment.description,
                        "\u201D"))))),
        !hideRoleBadge && (React.createElement(Badge, { variant: isOwner ? "warning" : "outline", className: "text-2xs", title: `Role definition id: ${r.assignment.roleDefinitionId}` }, r.roleName)),
        !hideRoleBadge && isCustomRole && (React.createElement(Badge, { variant: "info", className: "text-2xs" }, "Custom")),
        React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, r.assignment.principalType),
        r.assignment.atScope ? (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "at scope")) : (React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, "inherited")),
        lockedReason && (React.createElement("span", { className: "text-2xs text-muted-foreground", "aria-label": lockedReason, title: lockedReason }, "\uD83D\uDD12")),
        React.createElement(CopyButtonSmall, { value: r.assignment.id, ariaLabel: "Copy role assignment ARM id", title: "Copy role assignment id" })));
};
const AssignmentRow = React.memo(AssignmentRowImpl, (prev, next) => {
    var _a, _b, _c, _d;
    return prev.row.assignment.id === next.row.assignment.id &&
        ((_a = prev.row.principal) === null || _a === void 0 ? void 0 : _a.displayName) === ((_b = next.row.principal) === null || _b === void 0 ? void 0 : _b.displayName) &&
        ((_c = prev.row.principal) === null || _c === void 0 ? void 0 : _c.signInName) === ((_d = next.row.principal) === null || _d === void 0 ? void 0 : _d.signInName) &&
        prev.row.roleName === next.row.roleName &&
        prev.isSelf === next.isSelf &&
        prev.isChecked === next.isChecked &&
        prev.deleting === next.deleting &&
        prev.isCustomRole === next.isCustomRole &&
        prev.hideRoleBadge === next.hideRoleBadge &&
        prev.onToggleSelect === next.onToggleSelect;
});
/**
 * Tiny variant of the copy-button — single icon, no inline text. Used
 * at the end of each row so the operator can grab the role assignment
 * ARM id for `az role assignment delete --ids ...` or audit lookups.
 */
const CopyButtonSmall = ({ value, ariaLabel, title }) => {
    const [copied, setCopied] = React.useState(false);
    const onClick = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        }
        catch (_a) {
            /* clipboard blocked — silently no-op */
        }
    }), [value]);
    return (React.createElement("button", { type: "button", onClick: onClick, className: "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": ariaLabel, title: title !== null && title !== void 0 ? title : ariaLabel }, copied ? (React.createElement(Check, { className: "h-3 w-3 text-success" })) : (React.createElement(Copy, { className: "h-3 w-3" }))));
};
const GroupedAssignmentsList = ({ rows, selfPrincipalId, selected, getToggleSelect, collapsedGroups, onToggleGroup, deleting, roleKindById, }) => {
    const groups = React.useMemo(() => {
        const m = new Map();
        for (const r of rows) {
            const key = r.assignment.roleDefinitionId;
            const entry = m.get(key);
            if (entry) {
                entry.rows.push(r);
            }
            else {
                m.set(key, {
                    roleName: r.roleName,
                    isCustom: roleKindById.get(key) === "CustomRole",
                    rows: [r],
                });
            }
        }
        return Array.from(m.entries()).sort((a, b) => {
            // Owner first, then alphabetical.
            const aOwner = a[0] === AZURE_ROLE_OWNER ? 0 : 1;
            const bOwner = b[0] === AZURE_ROLE_OWNER ? 0 : 1;
            if (aOwner !== bOwner)
                return aOwner - bOwner;
            return a[1].roleName.localeCompare(b[1].roleName);
        });
    }, [rows, roleKindById]);
    return (React.createElement("div", { className: "flex flex-col gap-2" }, groups.map(([roleId, group]) => {
        const isOwner = roleId === AZURE_ROLE_OWNER;
        const collapsed = collapsedGroups.has(roleId);
        return (React.createElement("div", { key: roleId, className: "overflow-hidden rounded-md border border-border" },
            React.createElement("button", { type: "button", onClick: () => onToggleGroup(roleId), className: `flex w-full flex-wrap items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/30 ${isOwner ? "bg-warning/5" : "bg-muted/30"}`, "aria-expanded": !collapsed, "aria-controls": `group-body-${roleId}` },
                collapsed ? (React.createElement(ChevronRight, { className: "h-3.5 w-3.5" })) : (React.createElement(ChevronDown, { className: "h-3.5 w-3.5" })),
                React.createElement(Badge, { variant: isOwner ? "warning" : "outline", className: "text-2xs" }, group.roleName),
                group.isCustom && (React.createElement(Badge, { variant: "info", className: "text-2xs" }, "Custom")),
                React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    group.rows.length,
                    " member",
                    group.rows.length === 1 ? "" : "s"),
                React.createElement(CopyableText, { value: roleId, mono: true, ariaLabel: `Copy role definition id ${roleId}`, className: "ml-auto text-2xs text-muted-foreground" })),
            !collapsed && (React.createElement("ul", { id: `group-body-${roleId}`, className: "flex flex-col gap-1 p-1.5" }, group.rows.map((r) => (React.createElement(AssignmentRow, { key: r.assignment.id, row: r, isSelf: !!selfPrincipalId &&
                    r.assignment.principalId === selfPrincipalId, isChecked: selected.has(r.assignment.id), onToggleSelect: getToggleSelect(r.assignment.id), deleting: deleting, isCustomRole: group.isCustom, hideRoleBadge: true })))))));
    })));
};
/**
 * Preview shown inside the bulk-delete confirmation dialog. Groups
 * selections by role name + shows a per-row count so the operator can
 * eyeball the impact (e.g. "5 Owner / 12 Reader") before confirming.
 */
const DeletePreview = ({ rows }) => {
    const byRole = React.useMemo(() => {
        const m = new Map();
        for (const r of rows) {
            const k = r.roleName;
            const cur = m.get(k);
            if (cur)
                cur.push(r);
            else
                m.set(k, [r]);
        }
        return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
    }, [rows]);
    return (React.createElement("div", { className: "flex flex-col gap-1" },
        React.createElement("div", { className: "flex flex-wrap gap-1" }, byRole.map(([role, rs]) => (React.createElement(Badge, { key: role, variant: "outline", className: "text-2xs" },
            rs.length,
            " \u00D7 ",
            role)))),
        React.createElement("ul", { className: "ml-4 list-disc text-2xs text-muted-foreground" },
            rows.slice(0, 5).map((r) => {
                var _a, _b;
                return (React.createElement("li", { key: r.assignment.id }, (_b = (_a = r.principal) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : r.assignment.principalId,
                    " \u2014",
                    " ",
                    r.roleName));
            }),
            rows.length > 5 && React.createElement("li", null,
                "\u2026 and ",
                rows.length - 5,
                " more"))));
};
export const SubManagerPage = () => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const state = useMultiRegionState();
    // Prefer outlet-context store so all pages share the same canonical
    // instance the page-router wired up. Fallback to the hook for direct-
    // mounted unit tests that don't have the outlet. `useOutletContext`
    // returns the context object only when this component is rendered as
    // a child of a `<Outlet />`; tests sometimes mount the page directly,
    // so we treat the return value as nullable at runtime.
    const outlet = useDashboardOutletContext();
    const storeFromHook = useMultiRegionStore();
    const store = (_a = outlet === null || outlet === void 0 ? void 0 : outlet.store) !== null && _a !== void 0 ? _a : storeFromHook;
    const navigateToPage = outlet === null || outlet === void 0 ? void 0 : outlet.navigateToPage;
    const azureAccounts = (_b = state.azureAccounts) !== null && _b !== void 0 ? _b : [];
    /* ----- Tab selection ------------------------------------------- */
    // Default tab: URL `?tab=` wins, then sessionStorage from prior visits,
    // then fall back to subscription-rbac. URL sync makes deep-links share.
    const initialTab = React.useMemo(() => {
        try {
            const v = sessionStorage.getItem(STORAGE_TAB);
            if (v === "subscription-rbac" ||
                v === "departments" ||
                v === "grant-sub-creator") {
                return v;
            }
        }
        catch (_a) {
            /* ignore */
        }
        return "subscription-rbac";
    }, []);
    const [tabParam, setTabParam] = useUrlParam("tab", initialTab, {
        replace: true,
    });
    const tab = tabParam === "subscription-rbac" ||
        tabParam === "departments" ||
        tabParam === "grant-sub-creator"
        ? tabParam
        : "subscription-rbac";
    const setTab = React.useCallback((v) => {
        setTabParam(v);
        // Supplement existing sessionStorage so reopening the page keeps last tab.
        try {
            sessionStorage.setItem(STORAGE_TAB, v);
        }
        catch (_a) {
            /* ignore */
        }
    }, [setTabParam]);
    /* ----- Source account picker -------------------------------------
     * URL (?account=) is authoritative — that's how deep-links share
     * the right account+sub combo. sessionStorage seeds the URL on
     * first load if no URL param is present. SessionStorage stays in
     * sync so reopening the page resumes the last selection. */
    const candidateAccounts = React.useMemo(() => {
        return azureAccounts
            .map((a) => {
            var _a, _b;
            return ({
                homeAccountId: a.homeAccountId,
                tenantId: (_b = (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : resolveActiveTenantId(a)) !== null && _b !== void 0 ? _b : a.tenantId,
                username: a.username,
                name: a.name || a.username,
            });
        })
            .filter((a) => !!a.homeAccountId && !!a.tenantId);
    }, [azureAccounts]);
    const initialAccountId = React.useMemo(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_ACCOUNT)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    }, []);
    const [accountParam, setAccountParam] = useUrlParam("account", initialAccountId, { replace: true });
    const accountId = accountParam;
    const setAccountId = React.useCallback((id) => {
        setAccountParam(id);
        try {
            sessionStorage.setItem(STORAGE_ACCOUNT, id);
        }
        catch (_a) {
            /* ignore */
        }
    }, [setAccountParam]);
    // Auto-pick the first account when no selection / the stored one is gone.
    React.useEffect(() => {
        if (candidateAccounts.length === 0)
            return;
        if (!candidateAccounts.some((a) => a.homeAccountId === accountId)) {
            setAccountId(candidateAccounts[0].homeAccountId);
        }
    }, [candidateAccounts, accountId, setAccountId]);
    const account = React.useMemo(() => { var _a; return (_a = candidateAccounts.find((a) => a.homeAccountId === accountId)) !== null && _a !== void 0 ? _a : null; }, [candidateAccounts, accountId]);
    /* ----- Page-level ARM token tracker -----------------------------
     * Drives the TokenExpiryBadge rendered above the tab strip. The
     * sub-manager page makes a lot of ARM calls (list subs, list role
     * assignments, list role defs, list billing accts, list depts, list
     * enrollment accts, plus all the PUT/DELETE mutations) over a long
     * session, so an expiry warning is genuinely useful here. We don't
     * bridge this token into the per-tab `useBillingAccountPicker`
     * armToken state (each tab keeps fetching its own via the existing
     * one-shot flow); the badge just gives the operator a visible
     * heads-up that the page's signed-in account is about to need a
     * fresh token. */
    const armTokenTracker = useArmToken(account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId);
    /* ----- Subscription loading -------------------------------------- */
    const [subscriptions, setSubscriptions] = React.useState([]);
    const [subsLoading, setSubsLoading] = React.useState(false);
    const [subsError, setSubsError] = React.useState(null);
    const initialSubId = React.useMemo(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_SUBSCRIPTION)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    }, []);
    const [subParam, setSubParam] = useUrlParam("sub", initialSubId, {
        replace: true,
    });
    const subscriptionId = subParam;
    const setSubscriptionId = React.useCallback((id) => {
        setSubParam(id);
        try {
            sessionStorage.setItem(STORAGE_SUBSCRIPTION, id);
        }
        catch (_a) {
            /* ignore */
        }
    }, [setSubParam]);
    // useAbortableEffect: signal is aborted on unmount / dep-change. Service
    // layer doesn't (yet) accept AbortSignal so we still gate state writes on
    // `signal.aborted` to avoid stomping a fresher load. subscriptionId is
    // intentionally excluded so the picker doesn't refetch on its own change.
    useAbortableEffect(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    (signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (!account) {
            setSubscriptions([]);
            return;
        }
        setSubsLoading(true);
        setSubsError(null);
        try {
            // Tenant arg omitted so we pick up the operator's current active
            // tenant (was pinning to account.tenantId / the account's HOME
            // tenant — pre-switch).
            const token = yield getArmTokenForAccount(account.homeAccountId);
            if (signal.aborted)
                return;
            const subs = yield listSubscriptions(token);
            if (signal.aborted)
                return;
            setSubscriptions(subs);
            // Auto-pick when only one or when the stored selection is gone.
            if (subs.length === 1 && subscriptionId !== subs[0].subscriptionId) {
                setSubscriptionId(subs[0].subscriptionId);
            }
            else if (subscriptionId &&
                !subs.some((s) => s.subscriptionId === subscriptionId)) {
                setSubscriptionId("");
            }
        }
        catch (err) {
            if (signal.aborted)
                return;
            setSubsError(err instanceof Error ? err.message : String(err));
            setSubscriptions([]);
        }
        finally {
            if (!signal.aborted)
                setSubsLoading(false);
        }
    }), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId, setSubscriptionId]);
    const selectedSub = React.useMemo(() => { var _a; return (_a = subscriptions.find((s) => s.subscriptionId === subscriptionId)) !== null && _a !== void 0 ? _a : null; }, [subscriptions, subscriptionId]);
    /* ----- Subscription-state KPIs + "show only warned/disabled" chip ---
     * Sub Manager is the unified subscription-management hub, so the
     * picker doubles as a fleet view: counts of Enabled / Disabled /
     * Warned / Deleted across every subscription this account can see.
     * Operators can toggle a persisted "show only Disabled/Warned" chip
     * to focus on subs in transient/bad states. Persisted in localStorage
     * so the preference survives reloads. */
    const [onlyTroubled, setOnlyTroubled] = usePersistedState("sub-manager:only-troubled", false);
    const subStateStats = React.useMemo(() => {
        var _a;
        let enabled = 0;
        let disabled = 0;
        let warned = 0;
        let deleted = 0;
        let other = 0;
        for (const s of subscriptions) {
            const st = ((_a = s.state) !== null && _a !== void 0 ? _a : "").toLowerCase();
            if (st === "enabled")
                enabled += 1;
            else if (st === "disabled")
                disabled += 1;
            else if (st === "warned")
                warned += 1;
            else if (st === "deleted")
                deleted += 1;
            else
                other += 1;
        }
        return {
            total: subscriptions.length,
            enabled,
            disabled,
            warned,
            deleted,
            other,
            troubled: disabled + warned,
        };
    }, [subscriptions]);
    /**
     * Subscriptions the picker actually offers — filtered to troubled
     * (Disabled / Warned) when the chip is active. The currently-selected
     * sub is always retained so the picker doesn't go blank when the user
     * flips the chip on while sitting on an Enabled sub.
     */
    const visibleSubscriptions = React.useMemo(() => {
        if (!onlyTroubled)
            return subscriptions;
        return subscriptions.filter((s) => {
            var _a;
            const st = ((_a = s.state) !== null && _a !== void 0 ? _a : "").toLowerCase();
            return st === "disabled" || st === "warned" || s.subscriptionId === subscriptionId;
        });
    }, [subscriptions, onlyTroubled, subscriptionId]);
    /* ----- Role assignments + principal resolution ------------------- */
    const [assignments, setAssignments] = React.useState([]);
    const [principals, setPrincipals] = React.useState({});
    const [roleDefs, setRoleDefs] = React.useState([]);
    const [listLoading, setListLoading] = React.useState(false);
    const [listError, setListError] = React.useState(null);
    // Non-fatal warning shown when Graph can't resolve principal names in
    // the subscription's tenant — the table still works with raw GUIDs.
    const [principalResolveWarning, setPrincipalResolveWarning] = React.useState(null);
    const [reloadTick, setReloadTick] = React.useState(0);
    const reload = React.useCallback(() => setReloadTick((n) => n + 1), []);
    // useAbortableEffect: cancel-on-rerun so a tab-switch / sub-switch
    // mid-fetch doesn't race a slower previous load into the UI. The
    // service layer doesn't (yet) accept AbortSignal so we still gate
    // state writes on `signal.aborted`.
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (!account || !subscriptionId) {
            setAssignments([]);
            setPrincipals({});
            setRoleDefs([]);
            setPrincipalResolveWarning(null);
            return;
        }
        setListLoading(true);
        setListError(null);
        setPrincipalResolveWarning(null);
        try {
            // Tenant arg omitted so we pick up the operator's current active
            // tenant (was pinning to account.tenantId / the account's HOME
            // tenant — pre-switch).
            const armToken = yield getArmTokenForAccount(account.homeAccountId);
            if (signal.aborted)
                return;
            const [rows, defs] = yield Promise.all([
                listSubscriptionRoleAssignments(subscriptionId, armToken),
                listSubscriptionRoleDefinitions(subscriptionId, armToken),
            ]);
            if (signal.aborted)
                return;
            setAssignments(rows);
            setRoleDefs(defs);
            // Resolve principal names via Graph in the SUBSCRIPTION's tenant
            // (cross-tenant: guest users in another tenant won't resolve under
            // the source account's home tenant token). Falls back to raw GUIDs
            // when the account can't see Graph in that tenant; we expose the
            // failure as a non-fatal banner so the operator isn't left guessing.
            const subTenantId = (selectedSub === null || selectedSub === void 0 ? void 0 : selectedSub.tenantId) || account.tenantId;
            try {
                const graphToken = yield getGraphTokenForAccount(account.homeAccountId, subTenantId);
                if (signal.aborted)
                    return;
                const ids = Array.from(new Set(rows.map((r) => r.principalId)));
                const resolved = yield getPrincipalsByIds(subTenantId, ids, graphToken);
                if (signal.aborted)
                    return;
                const map = {};
                for (const p of resolved)
                    map[p.id] = p;
                setPrincipals(map);
            }
            catch (graphErr) {
                // Non-fatal — the table still renders with raw GUIDs, but we tell
                // the user so they know why display names aren't appearing.
                if (signal.aborted)
                    return;
                const msg = graphErr instanceof Error ? graphErr.message : String(graphErr);
                console.warn("[sub-manager] principal resolve failed:", graphErr);
                setPrincipals({});
                setPrincipalResolveWarning(`Couldn't resolve principal names in tenant ${subTenantId}. Showing raw object ids only. (${msg})`);
            }
        }
        catch (err) {
            if (signal.aborted)
                return;
            setListError(err instanceof Error ? err.message : String(err));
            setAssignments([]);
            setRoleDefs([]);
        }
        finally {
            if (!signal.aborted)
                setListLoading(false);
        }
    }), [
        account === null || account === void 0 ? void 0 : account.homeAccountId,
        account === null || account === void 0 ? void 0 : account.tenantId,
        subscriptionId,
        selectedSub === null || selectedSub === void 0 ? void 0 : selectedSub.tenantId,
        reloadTick,
    ]);
    /* ----- Filter / search ------------------------------------------- */
    const [search, setSearch] = React.useState("");
    const searchRef = React.useRef(null);
    const [roleFilter, setRoleFilter] = React.useState("all");
    const [typeFilter, setTypeFilter] = React.useState("all");
    const [scopeFilter, setScopeFilter] = React.useState("all");
    // Quick-chip: filter rows by built-in vs custom role kind. Determined
    // from the role definition's `type` (BuiltInRole / CustomRole). Roles
    // that didn't resolve through `listSubscriptionRoleDefinitions` fall in
    // the "unknown" bucket which behaves as built-in for filter purposes.
    const [kindFilter, setKindFilter] = React.useState("all");
    // Quick-chip: only show rows whose principal couldn't be resolved by
    // Graph (raw GUID with no display name). Common cause of these is a
    // deleted user or a guest from a tenant we lost access to — they're
    // safe to clean up after a quick sanity check.
    const [stalenessFilter, setStalenessFilter] = React.useState("all");
    // Sort dimension for the displayed list. Persists across the session.
    const [sortKey, setSortKey] = React.useState("name");
    // List vs grouped layout. Grouped is much friendlier when the sub has
    // 100+ assignments because role names are repeated less.
    const [viewMode, setViewMode] = React.useState(() => {
        try {
            const v = sessionStorage.getItem(STORAGE_VIEW_MODE);
            return v === "grouped" ? "grouped" : "flat";
        }
        catch (_a) {
            return "flat";
        }
    });
    const changeViewMode = React.useCallback((v) => {
        setViewMode(v);
        try {
            sessionStorage.setItem(STORAGE_VIEW_MODE, v);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    // Tracks which role groups are expanded in grouped view (by role GUID).
    // Default-collapsed for roles with > 10 members to keep the page short.
    const [collapsedGroups, setCollapsedGroups] = React.useState(new Set());
    const toggleGroup = React.useCallback((roleId) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(roleId))
                next.delete(roleId);
            else
                next.add(roleId);
            return next;
        });
    }, []);
    const joined = React.useMemo(() => {
        const roleNameById = new Map(roleDefs.map((d) => [d.id, d.name]));
        return assignments.map((a) => {
            var _a;
            return ({
                assignment: a,
                principal: principals[a.principalId],
                roleName: (_a = roleNameById.get(a.roleDefinitionId)) !== null && _a !== void 0 ? _a : a.roleDefinitionId,
            });
        });
    }, [assignments, principals, roleDefs]);
    // Lookup map from role guid → type (BuiltInRole / CustomRole) used by
    // the kind quick-filter and the per-row "custom" badge.
    const roleKindById = React.useMemo(() => {
        const m = new Map();
        for (const r of roleDefs)
            m.set(r.id, r.type);
        return m;
    }, [roleDefs]);
    const filteredRows = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        const filtered = joined.filter((r) => {
            var _a, _b, _c, _d, _e;
            if (roleFilter !== "all" && r.assignment.roleDefinitionId !== roleFilter)
                return false;
            if (typeFilter !== "all" && r.assignment.principalType !== typeFilter)
                return false;
            if (scopeFilter === "at-scope" && !r.assignment.atScope)
                return false;
            if (scopeFilter === "inherited" && r.assignment.atScope)
                return false;
            if (kindFilter !== "all") {
                const kind = roleKindById.get(r.assignment.roleDefinitionId);
                if (kindFilter === "custom" && kind !== "CustomRole")
                    return false;
                if (kindFilter === "builtin" && kind === "CustomRole")
                    return false;
            }
            if (stalenessFilter !== "all") {
                // "Unresolved" = Graph didn't return a display name for this
                // principal. "Resolved" = it did. Useful for spotting tombstoned
                // users that nobody bothered to remove from the sub.
                const resolved = !!r.principal && !!r.principal.displayName;
                if (stalenessFilter === "unresolved" && resolved)
                    return false;
                if (stalenessFilter === "resolved" && !resolved)
                    return false;
            }
            if (q) {
                const hay = [
                    (_b = (_a = r.principal) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : "",
                    (_d = (_c = r.principal) === null || _c === void 0 ? void 0 : _c.signInName) !== null && _d !== void 0 ? _d : "",
                    r.assignment.principalId,
                    r.roleName,
                    r.assignment.principalType,
                    r.assignment.scope,
                    (_e = r.assignment.description) !== null && _e !== void 0 ? _e : "",
                ]
                    .join(" ")
                    .toLowerCase();
                if (!hay.includes(q))
                    return false;
            }
            return true;
        });
        // Sort. We do this *after* filtering so the order is deterministic
        // regardless of the order ARM returned. Owners-first secondary sort
        // when sorting by role so the most-privileged rows surface first.
        const nameOf = (r) => { var _a, _b; return ((_b = (_a = r.principal) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : r.assignment.principalId).toLowerCase(); };
        const roleOf = (r) => r.roleName.toLowerCase();
        const ownerFirst = (r) => r.assignment.roleDefinitionId === AZURE_ROLE_OWNER ? 0 : 1;
        const sorted = filtered.slice();
        switch (sortKey) {
            case "name":
                sorted.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
                break;
            case "name-desc":
                sorted.sort((a, b) => nameOf(b).localeCompare(nameOf(a)));
                break;
            case "role":
                sorted.sort((a, b) => ownerFirst(a) - ownerFirst(b) ||
                    roleOf(a).localeCompare(roleOf(b)) ||
                    nameOf(a).localeCompare(nameOf(b)));
                break;
            case "role-desc":
                sorted.sort((a, b) => ownerFirst(b) - ownerFirst(a) ||
                    roleOf(b).localeCompare(roleOf(a)) ||
                    nameOf(a).localeCompare(nameOf(b)));
                break;
            case "type":
                sorted.sort((a, b) => a.assignment.principalType.localeCompare(b.assignment.principalType) || nameOf(a).localeCompare(nameOf(b)));
                break;
            case "scope":
                // At-scope first, then inherited, then by scope path.
                sorted.sort((a, b) => Number(b.assignment.atScope) - Number(a.assignment.atScope) ||
                    a.assignment.scope.localeCompare(b.assignment.scope));
                break;
            case "created":
                // Newest first; rows without createdOn sink to the bottom.
                sorted.sort((a, b) => {
                    var _a, _b;
                    const av = (_a = a.assignment.createdOn) !== null && _a !== void 0 ? _a : "";
                    const bv = (_b = b.assignment.createdOn) !== null && _b !== void 0 ? _b : "";
                    if (!av && !bv)
                        return 0;
                    if (!av)
                        return 1;
                    if (!bv)
                        return -1;
                    return bv.localeCompare(av);
                });
                break;
        }
        return sorted;
    }, [
        joined,
        search,
        roleFilter,
        typeFilter,
        scopeFilter,
        kindFilter,
        stalenessFilter,
        roleKindById,
        sortKey,
    ]);
    /* ----- Filter housekeeping --------------------------------------- */
    const hasActiveFilters = !!search.trim() ||
        roleFilter !== "all" ||
        typeFilter !== "all" ||
        scopeFilter !== "all" ||
        kindFilter !== "all" ||
        stalenessFilter !== "all";
    const clearAllFilters = React.useCallback(() => {
        setSearch("");
        setRoleFilter("all");
        setTypeFilter("all");
        setScopeFilter("all");
        setKindFilter("all");
        setStalenessFilter("all");
    }, []);
    /* ----- Summary stats for the header row -------------------------- */
    const roleStats = React.useMemo(() => {
        var _a;
        // Owners / Contributors / Readers are well-known built-in GUIDs; the
        // rest fall in "other" so the operator gets a quick at-a-glance breakdown.
        const OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
        const CONTRIB = "b24988ac-6180-42a0-ab88-20f7382dd24c";
        const READER = "acdd72a7-3385-48ef-bd42-f606fba81ae7";
        let owners = 0;
        let contribs = 0;
        let readers = 0;
        let sps = 0;
        let users = 0;
        let groups = 0;
        let inherited = 0;
        let unresolved = 0;
        let custom = 0;
        for (const a of assignments) {
            if (a.roleDefinitionId === OWNER)
                owners += 1;
            else if (a.roleDefinitionId === CONTRIB)
                contribs += 1;
            else if (a.roleDefinitionId === READER)
                readers += 1;
            if (a.principalType === "ServicePrincipal")
                sps += 1;
            else if (a.principalType === "User")
                users += 1;
            else if (a.principalType === "Group" || a.principalType === "ForeignGroup")
                groups += 1;
            if (!a.atScope)
                inherited += 1;
            if (!((_a = principals[a.principalId]) === null || _a === void 0 ? void 0 : _a.displayName))
                unresolved += 1;
            if (roleKindById.get(a.roleDefinitionId) === "CustomRole")
                custom += 1;
        }
        return {
            total: assignments.length,
            owners,
            contribs,
            readers,
            other: assignments.length - owners - contribs - readers,
            sps,
            users,
            groups,
            inherited,
            unresolved,
            custom,
        };
    }, [assignments, principals, roleKindById]);
    const rolesPresent = React.useMemo(() => {
        const seen = new Map();
        for (const r of joined) {
            if (!seen.has(r.assignment.roleDefinitionId)) {
                seen.set(r.assignment.roleDefinitionId, r.roleName);
            }
        }
        return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
    }, [joined]);
    /* ----- Corpus-grounded risk insights -----------------------------
     * Defender-side pattern matching against techniques documented in the
     * offensive-tooling corpus. Each insight is a small read-only signal
     * — no automated remediation. The categories implemented here:
     *
     *  (A) Cross-tenant scope mismatch. When the sub's tenantId differs
     *      from the source account's home tenant, the operator is acting
     *      cross-tenant — exactly the EA / Subscription-Migrator pivot
     *      surface documented in `_ea_subscription_cross_tenant.md`.
     *      Not inherently malicious, but worth flagging because all
     *      destructive operations (cancel / rename / billing-scope
     *      change) on a foreign-tenant sub leave audit fingerprints in
     *      a tenant the operator may not control.
     *
     *  (B) Recent Owner grants. Role assignments at Owner role with
     *      createdOn within the last 24 hours. Mapped to corpus pattern
     *      "rapid escalation before pivot" — the dafthack TeamFiltration
     *      and AzureHound playbooks both call out same-day Owner adds as
     *      the loudest single signal of a hands-on-keyboard takeover.
     *
     *  (C) Deceptive-name principals. Resolved User principals whose
     *      displayName matches naming patterns the corpus documents
     *      attackers use to blend in (see `_bypass_modify_delete.md`
     *      §4.1 — backdoor user with pre-assigned role). We only flag
     *      Users (not SPNs/Groups) because legitimate SPNs frequently
     *      have these prefixes.
     *
     *  (D) Unresolved high-privilege principals. Owners that Graph
     *      couldn't expand to a display name — common stealth-persistence
     *      remnant when a backdoor user / SPN was deleted but the role
     *      assignment was not. Surface these as the highest-confidence
     *      cleanup candidates.
     *
     * Anchored against the corpus to avoid re-inventing thresholds from
     * memory — every category cites a specific playbook file.
     */
    const riskInsights = React.useMemo(() => {
        var _a, _b, _c, _d, _e;
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        /** Cross-tenant flag: sub.tenantId differs from account.tenantId. */
        const crossTenant = !!selectedSub &&
            !!account &&
            !!selectedSub.tenantId &&
            selectedSub.tenantId.toLowerCase() !== account.tenantId.toLowerCase();
        /** Recent Owner adds (within 24h). */
        const recentOwners = [];
        /** Unresolved Owners (no displayName in `principals`). */
        const unresolvedOwners = [];
        /** Deceptive-name principals (Users with svc-/_sync_/admin-/backup/sync hints). */
        const deceptivePrincipals = [];
        // Patterns drawn from `_bypass_modify_delete.md` §4.1. Case-insensitive
        // substring match; anchored prefixes hit first to keep false positives
        // down. `backup` / `sync` are matched anywhere because the corpus
        // notes attackers also use those as suffixes ("dba-sync", "_backup").
        const DECEPTIVE_PREFIXES = ["svc-", "_sync_", "admin-", "adm-", "svc_"];
        const DECEPTIVE_SUBSTR = ["backup", "sync"];
        for (const r of joined) {
            const isOwner = r.assignment.roleDefinitionId === AZURE_ROLE_OWNER;
            if (isOwner) {
                const createdMs = r.assignment.createdOn
                    ? Date.parse(r.assignment.createdOn)
                    : NaN;
                if (Number.isFinite(createdMs) &&
                    now - createdMs >= 0 &&
                    now - createdMs <= dayMs) {
                    recentOwners.push(r);
                }
                if (!((_a = r.principal) === null || _a === void 0 ? void 0 : _a.displayName))
                    unresolvedOwners.push(r);
            }
            if (r.assignment.principalType === "User") {
                const dn = ((_c = (_b = r.principal) === null || _b === void 0 ? void 0 : _b.displayName) !== null && _c !== void 0 ? _c : "").toLowerCase();
                const sn = ((_e = (_d = r.principal) === null || _d === void 0 ? void 0 : _d.signInName) !== null && _e !== void 0 ? _e : "").toLowerCase();
                const haystack = `${dn} ${sn}`;
                const hit = (!!dn || !!sn) &&
                    (DECEPTIVE_PREFIXES.some((p) => dn.startsWith(p) || sn.startsWith(p)) ||
                        DECEPTIVE_SUBSTR.some((s) => haystack.includes(s)));
                if (hit)
                    deceptivePrincipals.push(r);
            }
        }
        const count = (crossTenant ? 1 : 0) +
            (recentOwners.length > 0 ? 1 : 0) +
            (unresolvedOwners.length > 0 ? 1 : 0) +
            (deceptivePrincipals.length > 0 ? 1 : 0);
        return {
            crossTenant,
            recentOwners,
            unresolvedOwners,
            deceptivePrincipals,
            count,
        };
    }, [joined, selectedSub, account]);
    /* ----- Selection for bulk delete --------------------------------- */
    const [selected, setSelected] = React.useState(new Set());
    const toggleSelect = React.useCallback((id) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    /**
     * Stable per-id toggle callback cache. Without this, AssignmentRow's
     * `() => toggleSelect(r.assignment.id)` allocates a fresh closure each
     * render, defeating React.memo on the row component. The cache is held
     * in a ref so reassigning entries doesn't trigger a re-render of the
     * parent; entries are reaped lazily when assignments turn over (sub
     * switch / reload) by the effect a few lines below. */
    const toggleSelectByIdCacheRef = React.useRef(new Map());
    const getToggleSelect = React.useCallback((id) => {
        let fn = toggleSelectByIdCacheRef.current.get(id);
        if (!fn) {
            fn = () => toggleSelect(id);
            toggleSelectByIdCacheRef.current.set(id, fn);
        }
        return fn;
    }, [toggleSelect]);
    // Reap stale entries whenever the assignment set turns over (sub switch
    // or refresh). Keeps the cache bounded; otherwise it grows linearly
    // with the number of unique assignment ids the operator has ever seen.
    React.useEffect(() => {
        const live = new Set(assignments.map((a) => a.id));
        const cache = toggleSelectByIdCacheRef.current;
        for (const k of cache.keys())
            if (!live.has(k))
                cache.delete(k);
    }, [assignments]);
    const selectAllDeletable = React.useCallback(() => {
        setSelected(new Set(filteredRows
            .filter((r) => r.assignment.atScope)
            .map((r) => r.assignment.id)));
    }, [filteredRows]);
    const clearSelection = React.useCallback(() => setSelected(new Set()), []);
    // Reset selection whenever the sub changes.
    React.useEffect(() => {
        setSelected(new Set());
    }, [subscriptionId, reloadTick]);
    /* ----- ARIA-live announcer (declared first so dependents close over it).
     *  See full doc below. */
    // (announce + liveMessage defined immediately after this comment.)
    /* ----- ARIA-live announcer --------------------------------------
     * Polite live region. We pipe filter changes and bulk-delete results
     * through `announce()` so screen-reader users get the same context
     * sighted operators get from the row-count badge updating. The
     * "polite" politeness setting queues messages instead of preempting
     * the user's current screen-reader speech (assistive-tech best
     * practice for non-emergency updates). */
    const [liveMessage, setLiveMessage] = React.useState("");
    const liveTimeoutRef = React.useRef(null);
    const announce = React.useCallback((msg) => {
        // Clear-then-set so identical-text messages still trigger SR readouts.
        setLiveMessage("");
        if (liveTimeoutRef.current)
            window.clearTimeout(liveTimeoutRef.current);
        liveTimeoutRef.current = window.setTimeout(() => {
            setLiveMessage(msg);
        }, 40);
    }, []);
    React.useEffect(() => {
        return () => {
            if (liveTimeoutRef.current)
                window.clearTimeout(liveTimeoutRef.current);
        };
    }, []);
    /* ----- Keyboard shortcuts ---------------------------------------
     * `/`  → focus the search box (skipped if a form field already has focus).
     * `Esc` → clear current selection / clear search.
     * `g`  → toggle flat / grouped view.
     * `o`  → quick toggle: filter to Owners only (re-press to clear).
     * `u`  → quick toggle: filter to Unresolved principals (re-press to clear).
     * `c`  → clear all active filters.
     * Only active while the RBAC tab is the visible one. */
    React.useEffect(() => {
        if (tab !== "subscription-rbac")
            return;
        const onKey = (e) => {
            var _a, _b;
            const target = e.target;
            const isTyping = !!target &&
                (target.tagName === "INPUT" ||
                    target.tagName === "TEXTAREA" ||
                    target.isContentEditable);
            // Skip when any modifier is held — leaves the browser's native
            // Ctrl/Cmd shortcuts unmolested.
            if (e.ctrlKey || e.metaKey || e.altKey)
                return;
            if (e.key === "/" && !isTyping) {
                e.preventDefault();
                (_a = searchRef.current) === null || _a === void 0 ? void 0 : _a.focus();
                (_b = searchRef.current) === null || _b === void 0 ? void 0 : _b.select();
            }
            else if (e.key === "Escape" && !isTyping) {
                if (selected.size > 0) {
                    e.preventDefault();
                    clearSelection();
                    announce(`Cleared ${selected.size} selection${selected.size === 1 ? "" : "s"}.`);
                }
                else if (search) {
                    e.preventDefault();
                    setSearch("");
                    announce("Cleared search.");
                }
            }
            else if (e.key === "g" && !isTyping) {
                e.preventDefault();
                const next = viewMode === "flat" ? "grouped" : "flat";
                changeViewMode(next);
                announce(`Switched to ${next === "grouped" ? "grouped" : "flat"} view.`);
            }
            else if (e.key === "o" && !isTyping) {
                e.preventDefault();
                if (roleFilter === AZURE_ROLE_OWNER) {
                    setRoleFilter("all");
                    announce("Cleared Owners filter.");
                }
                else {
                    setRoleFilter(AZURE_ROLE_OWNER);
                    announce("Filtered to Owners.");
                }
            }
            else if (e.key === "u" && !isTyping) {
                e.preventDefault();
                if (stalenessFilter === "unresolved") {
                    setStalenessFilter("all");
                    announce("Cleared unresolved filter.");
                }
                else {
                    setStalenessFilter("unresolved");
                    announce("Filtered to unresolved principals.");
                }
            }
            else if (e.key === "c" && !isTyping && hasActiveFilters) {
                e.preventDefault();
                clearAllFilters();
                announce("Cleared all filters.");
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [
        tab,
        selected.size,
        clearSelection,
        viewMode,
        changeViewMode,
        roleFilter,
        stalenessFilter,
        hasActiveFilters,
        clearAllFilters,
        search,
        announce,
    ]);
    /* ----- Self-protection diagnostics ------------------------------- */
    // Narrow to `string | null` (previous shape leaked `SourceAccount | string |
    // false | undefined` into downstream comparisons via JS short-circuit).
    const selfPrincipalId = React.useMemo(() => {
        var _a;
        if (!candidateAccounts.some((a) => a.homeAccountId === accountId)) {
            return null;
        }
        const match = azureAccounts.find((a) => a.homeAccountId === accountId);
        return (_a = match === null || match === void 0 ? void 0 : match.localAccountId) !== null && _a !== void 0 ? _a : null;
    }, [candidateAccounts, azureAccounts, accountId]);
    const ownerCount = React.useMemo(() => assignments.filter((a) => a.roleDefinitionId === AZURE_ROLE_OWNER)
        .length, [assignments]);
    const selectedRowsObjects = React.useMemo(() => {
        return joined.filter((r) => selected.has(r.assignment.id));
    }, [joined, selected]);
    const selectedTouchesSelf = React.useMemo(() => !!selfPrincipalId &&
        selectedRowsObjects.some((r) => r.assignment.principalId === selfPrincipalId), [selectedRowsObjects, selfPrincipalId]);
    const selectedOwnerCount = selectedRowsObjects.filter((r) => r.assignment.roleDefinitionId === AZURE_ROLE_OWNER).length;
    const wouldRemoveLastOwner = ownerCount > 0 && selectedOwnerCount >= ownerCount;
    /* ----- Bulk delete flow ------------------------------------------ */
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    const [deleting, setDeleting] = React.useState(false);
    const performDelete = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _j, _k;
        if (!account || selectedRowsObjects.length === 0)
            return;
        setDeleting(true);
        let succeeded = 0;
        let failed = 0;
        const failures = [];
        try {
            // Tenant arg omitted so we pick up the operator's current active
            // tenant (was pinning to account.tenantId / the account's HOME
            // tenant — pre-switch).
            const armToken = yield getArmTokenForAccount(account.homeAccountId);
            for (const r of selectedRowsObjects) {
                try {
                    yield deleteRoleAssignment(r.assignment.id, armToken);
                    succeeded += 1;
                    auditLog.record({
                        actor: account.username,
                        action: "delete_role_assignment",
                        target: r.assignment.principalId,
                        status: "success",
                        details: {
                            subscriptionId,
                            roleDefinitionId: r.assignment.roleDefinitionId,
                            roleName: r.roleName,
                            roleAssignmentId: r.assignment.id,
                            principalType: r.assignment.principalType,
                        },
                    });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    failed += 1;
                    failures.push(`${(_k = (_j = r.principal) === null || _j === void 0 ? void 0 : _j.displayName) !== null && _k !== void 0 ? _k : r.assignment.principalId}: ${msg}`);
                    auditLog.record({
                        actor: account.username,
                        action: "delete_role_assignment",
                        target: r.assignment.principalId,
                        status: "failure",
                        error: msg,
                        details: {
                            subscriptionId,
                            roleDefinitionId: r.assignment.roleDefinitionId,
                            roleName: r.roleName,
                            roleAssignmentId: r.assignment.id,
                        },
                    });
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            store.addNotification({
                type: "error",
                message: `Token acquisition failed: ${msg}`,
            });
        }
        setDeleting(false);
        setConfirmOpen(false);
        setSelected(new Set());
        const summaryMessage = failed > 0
            ? `Removed ${succeeded}, failed ${failed}. ${failures.slice(0, 2).join(" · ")}${failures.length > 2 ? "…" : ""}`
            : `Removed ${succeeded} role assignment${succeeded === 1 ? "" : "s"}.`;
        store.addNotification({
            type: failed > 0 ? (succeeded > 0 ? "warning" : "error") : "success",
            message: summaryMessage,
        });
        // Mirror to ARIA-live so screen-reader users hear the same outcome
        // sighted operators see in the toast — toasts aren't always picked up.
        announce(summaryMessage);
        reload();
    }), [account, selectedRowsObjects, subscriptionId, store, reload, announce]);
    /* ----- "Remove me" shortcut -------------------------------------- */
    const myRows = React.useMemo(() => {
        if (!selfPrincipalId)
            return [];
        return joined.filter((r) => r.assignment.principalId === selfPrincipalId && r.assignment.atScope);
    }, [joined, selfPrincipalId]);
    const removeMe = React.useCallback(() => {
        if (myRows.length === 0)
            return;
        setSelected(new Set(myRows.map((r) => r.assignment.id)));
        setConfirmOpen(true);
    }, [myRows]);
    /* ----- Add-new-assignment panel ---------------------------------- */
    const [addPrincipalInput, setAddPrincipalInput] = React.useState("");
    const [addPrincipalType, setAddPrincipalType] = React.useState("User");
    const [addRoleId, setAddRoleId] = React.useState("");
    const [adding, setAdding] = React.useState(false);
    const [addError, setAddError] = React.useState(null);
    /**
     * Reveals the sanitized ARM PUT body that `assignSubscriptionRole`
     * will send. Lets the operator (or a reviewer over their shoulder)
     * eyeball the exact wire payload before committing — useful when
     * pasting into az-cli, when running the request through a proxy,
     * or when documenting a change ticket. No token / no headers shown;
     * we only render what's safe to leak to a screenshot. */
    const [showArmPreview, setShowArmPreview] = React.useState(false);
    /**
     * Sanitized ARM PUT body preview. Matches the shape
     * `assignSubscriptionRole` produces — see services/role-assignments.ts.
     * The role-assignment id is a fresh GUID; ARM expects a client-
     * generated id at the PUT URL segment, so the preview generates one
     * deterministically from the principal+role pair for display only
     * (the real service generates its own at submit time). */
    const armPutPreview = React.useMemo(() => {
        const raw = addPrincipalInput.trim();
        if (!subscriptionId || !addRoleId || !raw)
            return null;
        const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const principalObjectId = guidRe.test(raw) ? raw : `<resolved-from "${raw}">`;
        return {
            url: `PUT https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleAssignments/<new-guid>?api-version=2022-04-01`,
            body: {
                properties: {
                    roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${addRoleId}`,
                    principalId: principalObjectId,
                    principalType: addPrincipalType,
                },
            },
        };
    }, [subscriptionId, addRoleId, addPrincipalInput, addPrincipalType]);
    // Seed default role when role defs load. Preference: last role used on
    // this page (per session), then Owner, then nothing. Drops a stored
    // role that's no longer visible at the new subscription scope.
    React.useEffect(() => {
        if (addRoleId || roleDefs.length === 0)
            return;
        let stored = null;
        try {
            stored = sessionStorage.getItem(STORAGE_LAST_ROLE);
        }
        catch (_a) {
            /* ignore */
        }
        if (stored && roleDefs.some((r) => r.id === stored)) {
            setAddRoleId(stored);
        }
        else if (roleDefs.some((r) => r.id === AZURE_ROLE_OWNER)) {
            setAddRoleId(AZURE_ROLE_OWNER);
        }
    }, [roleDefs, addRoleId]);
    // Persist whatever the operator most recently picked.
    React.useEffect(() => {
        if (!addRoleId)
            return;
        try {
            sessionStorage.setItem(STORAGE_LAST_ROLE, addRoleId);
        }
        catch (_a) {
            /* ignore */
        }
    }, [addRoleId]);
    // Tally for "principal already has this role" inline warning shown
    // above the Grant button. Lookup is by GUID + role GUID against the
    // current assignments. Helps operators avoid silent no-op grants.
    const existingMatchForAdd = React.useMemo(() => {
        const raw = addPrincipalInput.trim();
        if (!raw || !addRoleId)
            return null;
        const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guidRe.test(raw))
            return null;
        return assignments.find((a) => a.principalId.toLowerCase() === raw.toLowerCase() &&
            a.roleDefinitionId === addRoleId &&
            a.atScope);
    }, [addPrincipalInput, addRoleId, assignments]);
    const submitAdd = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _l, _m, _o;
        if (!account || !subscriptionId || !addRoleId)
            return;
        const raw = addPrincipalInput.trim();
        if (!raw)
            return;
        setAdding(true);
        setAddError(null);
        try {
            // Allow either a raw GUID or a UPN/email. GUID → use directly.
            // Otherwise resolve via Graph (User only — group/SPN lookup by
            // name is messier and operators usually have the GUID for those).
            const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            let principalObjectId = "";
            if (guidRe.test(raw)) {
                principalObjectId = raw;
            }
            else if (addPrincipalType === "User") {
                const subTenantId = (selectedSub === null || selectedSub === void 0 ? void 0 : selectedSub.tenantId) || account.tenantId;
                const graphToken = yield getGraphTokenForAccount(account.homeAccountId, subTenantId);
                const found = yield findUserByUpnOrMail(subTenantId, raw, graphToken);
                if (!found) {
                    throw new Error(`No user found in tenant ${subTenantId} matching "${raw}". Paste the user's object id if Graph can't see them.`);
                }
                principalObjectId = found.id;
            }
            else {
                throw new Error("Lookup by name is only supported for Users. Paste the Group / Service Principal object id.");
            }
            // Tenant arg omitted so we pick up the operator's current active
            // tenant (was pinning to account.tenantId / the account's HOME
            // tenant — pre-switch).
            const armToken = yield getArmTokenForAccount(account.homeAccountId);
            const r = yield assignSubscriptionRole(subscriptionId, principalObjectId, addRoleId, armToken, { principalType: addPrincipalType });
            const role = roleDefs.find((d) => d.id === addRoleId);
            auditLog.record({
                actor: account.username,
                action: "create_role_assignment",
                target: principalObjectId,
                status: "success",
                details: {
                    subscriptionId,
                    roleDefinitionId: addRoleId,
                    roleName: (_l = role === null || role === void 0 ? void 0 : role.name) !== null && _l !== void 0 ? _l : addRoleId,
                    principalType: addPrincipalType,
                    alreadyExisted: r.alreadyExisted,
                    raw,
                },
            });
            store.addNotification({
                type: "success",
                message: r.alreadyExisted
                    ? `Principal already has ${(_m = role === null || role === void 0 ? void 0 : role.name) !== null && _m !== void 0 ? _m : "the role"}.`
                    : `Granted ${(_o = role === null || role === void 0 ? void 0 : role.name) !== null && _o !== void 0 ? _o : "role"} to ${raw}.`,
            });
            setAddPrincipalInput("");
            reload();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setAddError(msg);
            auditLog.record({
                actor: account.username,
                action: "create_role_assignment",
                target: addPrincipalInput,
                status: "failure",
                error: msg,
                details: {
                    subscriptionId,
                    roleDefinitionId: addRoleId,
                    principalType: addPrincipalType,
                },
            });
        }
        finally {
            setAdding(false);
        }
    }), [
        account,
        subscriptionId,
        addRoleId,
        addPrincipalInput,
        addPrincipalType,
        selectedSub === null || selectedSub === void 0 ? void 0 : selectedSub.tenantId,
        roleDefs,
        store,
        reload,
    ]);
    /* ----- Export columns -------------------------------------------- */
    const roleAssignmentExportColumns = React.useMemo(() => [
        { header: "Principal name", accessor: (r) => { var _a, _b; return (_b = (_a = r.principal) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : ""; } },
        { header: "Sign-in name", accessor: (r) => { var _a, _b; return (_b = (_a = r.principal) === null || _a === void 0 ? void 0 : _a.signInName) !== null && _b !== void 0 ? _b : ""; } },
        { header: "Principal id", accessor: (r) => r.assignment.principalId },
        { header: "Principal type", accessor: (r) => r.assignment.principalType },
        { header: "Role name", accessor: (r) => r.roleName },
        { header: "Role definition id", accessor: (r) => r.assignment.roleDefinitionId },
        {
            header: "Role kind",
            accessor: (r) => { var _a; return (_a = roleKindById.get(r.assignment.roleDefinitionId)) !== null && _a !== void 0 ? _a : "BuiltInRole"; },
        },
        { header: "Scope", accessor: (r) => r.assignment.scope },
        { header: "At scope", accessor: (r) => r.assignment.atScope },
        { header: "Role assignment id", accessor: (r) => r.assignment.id },
        { header: "Created on", accessor: (r) => { var _a; return (_a = r.assignment.createdOn) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Description", accessor: (r) => { var _a; return (_a = r.assignment.description) !== null && _a !== void 0 ? _a : ""; } },
    ], [roleKindById]);
    /* ----- React to global tenant-switch events ---------------------- */
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!candidateAccounts.some((a) => a.homeAccountId === candidate))
            return;
        if (accountId === candidate)
            return;
        setAccountId(candidate);
    });
    /* ----- Render ---------------------------------------------------- */
    if (candidateAccounts.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "Sub Manager", description: "Inspect, add, and remove role assignments on an Azure subscription." }),
            React.createElement(EmptyState, { icon: Shield, title: "No Azure account signed in", description: "Add an Azure account first \u2014 Sub Manager needs an ARM token to read role assignments." })));
    }
    const deleteDisabled = selected.size === 0 ||
        deleting ||
        !selectedRowsObjects.some((r) => r.assignment.atScope);
    return (React.createElement("div", { className: "flex flex-col gap-4 py-2" },
        React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only" }, liveMessage),
        React.createElement(PageHeader, { title: "Sub Manager", description: "Subscription RBAC, EA departments, and EA Subscription Creator grants in one place." },
            React.createElement("div", { className: "flex items-center gap-2" },
                React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                        loginHint: account === null || account === void 0 ? void 0 : account.username,
                    }) }),
                tab === "subscription-rbac" && (React.createElement(React.Fragment, null,
                    React.createElement(InfoTooltip, { content: React.createElement("div", { className: "flex flex-col gap-1 text-2xs" },
                            React.createElement("span", { className: "font-semibold" }, "Keyboard shortcuts"),
                            React.createElement("span", null,
                                React.createElement("kbd", { className: "rounded border px-1" }, "/"),
                                " focus search"),
                            React.createElement("span", null,
                                React.createElement("kbd", { className: "rounded border px-1" }, "Esc"),
                                " clear selection / search"),
                            React.createElement("span", null,
                                React.createElement("kbd", { className: "rounded border px-1" }, "g"),
                                " toggle flat / grouped"),
                            React.createElement("span", null,
                                React.createElement("kbd", { className: "rounded border px-1" }, "o"),
                                " filter to Owners"),
                            React.createElement("span", null,
                                React.createElement("kbd", { className: "rounded border px-1" }, "u"),
                                " filter to Unresolved"),
                            React.createElement("span", null,
                                React.createElement("kbd", { className: "rounded border px-1" }, "c"),
                                " clear all filters")), size: 14, variant: "help", ariaLabel: "Keyboard shortcuts" }),
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: reload, disabled: !subscriptionId || listLoading, "aria-label": "Refresh role assignments" },
                        React.createElement(RefreshCw, { className: listLoading ? "animate-spin" : undefined }),
                        "Refresh"))))),
        React.createElement("div", { className: "flex flex-wrap gap-1 border-b border-border pb-1" },
            React.createElement(Button, { type: "button", variant: tab === "subscription-rbac" ? "default" : "ghost", size: "sm", className: "h-8 text-xs", onClick: () => setTab("subscription-rbac") },
                React.createElement(Shield, { className: "h-3.5 w-3.5" }),
                "Subscription RBAC"),
            React.createElement(Button, { type: "button", variant: tab === "departments" ? "default" : "ghost", size: "sm", className: "h-8 text-xs", onClick: () => setTab("departments") },
                React.createElement(Layers, { className: "h-3.5 w-3.5" }),
                "Departments"),
            React.createElement(Button, { type: "button", variant: tab === "grant-sub-creator" ? "default" : "ghost", size: "sm", className: "h-8 text-xs", onClick: () => setTab("grant-sub-creator") },
                React.createElement(Sparkles, { className: "h-3.5 w-3.5" }),
                "Grant Subscription Creator")),
        tab === "departments" && (React.createElement(DepartmentsTab, { azureAccounts: candidateAccounts, store: store })),
        tab === "grant-sub-creator" && (React.createElement(GrantSubCreatorTab, { azureAccounts: candidateAccounts, store: store, navigateToPage: navigateToPage })),
        tab === "subscription-rbac" && (React.createElement(React.Fragment, null,
            React.createElement(Card, null,
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(Building2, { className: "h-4 w-4 text-primary" }),
                        "Scope"),
                    React.createElement(CardDescription, null, "Pick which signed-in account does the ARM calls, then the subscription you want to manage.")),
                React.createElement(CardContent, { className: "grid grid-cols-1 gap-3 sm:grid-cols-2" },
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { htmlFor: "sm-account", className: "text-xs" }, "Source account"),
                        React.createElement(Select, { value: accountId, onValueChange: setAccountId },
                            React.createElement(SelectTrigger, { id: "sm-account" },
                                React.createElement(SelectValue, { placeholder: "Pick an account" })),
                            React.createElement(SelectContent, null, candidateAccounts.map((a) => {
                                var _a;
                                return (React.createElement(SelectItem, { key: a.homeAccountId, value: a.homeAccountId },
                                    React.createElement("span", { className: "flex flex-col" },
                                        React.createElement("span", { className: "text-sm" }, a.name),
                                        React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                            a.username,
                                            " \u00B7 tenant",
                                            " ",
                                            ((_a = a.tenantId) !== null && _a !== void 0 ? _a : "unknown").slice(0, 8),
                                            "\u2026"))));
                            })))),
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { htmlFor: "sm-subscription", className: "text-xs" }, "Subscription"),
                        subsLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                            React.createElement(Loader2, { className: "h-3 w-3 animate-spin" }),
                            "Loading subscriptions\u2026")) : subsError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load subscriptions.", detail: subsError, onRetry: () => setReloadTick((n) => n + 1), retryLabel: "Retry" })) : subscriptions.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No subscriptions visible to this account.")) : (React.createElement(Select, { value: subscriptionId, onValueChange: setSubscriptionId },
                            React.createElement(SelectTrigger, { id: "sm-subscription" },
                                React.createElement(SelectValue, { placeholder: "Pick a subscription" })),
                            React.createElement(SelectContent, null, visibleSubscriptions.map((s) => (React.createElement(SelectItem, { key: s.subscriptionId, value: s.subscriptionId },
                                React.createElement("span", { className: "flex flex-col" },
                                    React.createElement("span", { className: "text-sm" }, s.displayName),
                                    React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                                        s.subscriptionId,
                                        " \u00B7 ",
                                        s.state)))))))))),
                subscriptions.length > 0 && (React.createElement(CardContent, { className: "border-t border-border pt-3" },
                    React.createElement("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-6" },
                        React.createElement(SummaryStatItem, { label: "Total", value: subStateStats.total, compact: true, ariaLabel: `${subStateStats.total} subscriptions visible` }),
                        React.createElement(SummaryStatItem, { label: "Enabled", value: subStateStats.enabled, tone: subStateStats.enabled > 0 ? "success" : "muted", compact: true, ariaLabel: `${subStateStats.enabled} subscriptions enabled` }),
                        React.createElement(SummaryStatItem, { label: "Disabled", value: subStateStats.disabled, tone: subStateStats.disabled > 0 ? "warning" : "muted", compact: true, ariaLabel: `${subStateStats.disabled} subscriptions disabled` }),
                        React.createElement(SummaryStatItem, { label: "Warned", value: subStateStats.warned, tone: subStateStats.warned > 0 ? "warning" : "muted", compact: true, ariaLabel: `${subStateStats.warned} subscriptions warned` }),
                        React.createElement(SummaryStatItem, { label: "Deleted", value: subStateStats.deleted, tone: subStateStats.deleted > 0 ? "destructive" : "muted", compact: true, ariaLabel: `${subStateStats.deleted} subscriptions deleted` }),
                        React.createElement(SummaryStatItem, { label: "Stuck", value: subStateStats.other, tone: subStateStats.other > 0 ? "warning" : "muted", compact: true, hint: subStateStats.other > 0 ? "transient" : undefined, ariaLabel: `${subStateStats.other} subscriptions in non-standard state` })),
                    React.createElement("div", { className: "mt-2 flex flex-wrap items-center gap-2" },
                        React.createElement(Button, { type: "button", variant: onlyTroubled ? "default" : "outline", size: "sm", className: "h-7 text-xs", onClick: () => setOnlyTroubled(!onlyTroubled), "aria-pressed": onlyTroubled, title: "Filter the picker to subscriptions in Disabled or Warned state", disabled: subStateStats.troubled === 0 && !onlyTroubled },
                            React.createElement(AlertTriangle, { className: "h-3 w-3" }),
                            onlyTroubled
                                ? `Showing only troubled (${subStateStats.troubled})`
                                : `Show only troubled (${subStateStats.troubled})`),
                        onlyTroubled && subStateStats.troubled === 0 && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, "No troubled subs \u2014 toggle off to see all.")),
                        selectedSub && (React.createElement("span", { className: "ml-auto flex items-center gap-1 text-2xs text-muted-foreground" },
                            "Current:",
                            React.createElement(Badge, { variant: ((_c = selectedSub.state) !== null && _c !== void 0 ? _c : "").toLowerCase() === "enabled"
                                    ? "outline"
                                    : ((_d = selectedSub.state) !== null && _d !== void 0 ? _d : "").toLowerCase() === "warned" ||
                                        ((_e = selectedSub.state) !== null && _e !== void 0 ? _e : "").toLowerCase() === "disabled"
                                        ? "warning"
                                        : "destructive", className: "text-2xs" }, (_f = selectedSub.state) !== null && _f !== void 0 ? _f : "unknown"))))))),
            !subscriptionId && !subsLoading && (React.createElement(EmptyState, { icon: Building2, title: "Pick a subscription", description: "Once you pick a subscription above, every role assignment at its scope shows up here." })),
            subscriptionId && (React.createElement(React.Fragment, null,
                React.createElement(Card, { className: "border-primary/30" },
                    React.createElement(CardHeader, { className: "pb-3" },
                        React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                            React.createElement(UserPlus, { className: "h-4 w-4 text-primary" }),
                            "Add user / SPN / group"),
                        React.createElement(CardDescription, null, "Grant a role at this subscription's scope. Paste an object id (any principal type) or a UPN / email (User only).")),
                    React.createElement(CardContent, { className: "flex flex-col gap-3" },
                        React.createElement("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-3" },
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement(Label, { htmlFor: "sm-add-input", className: "text-xs" }, "Object id or UPN / email"),
                                React.createElement(Input, { id: "sm-add-input", value: addPrincipalInput, onChange: (e) => {
                                        setAddPrincipalInput(e.target.value);
                                        setAddError(null);
                                    }, placeholder: "alice@contoso.com  OR  11111111-2222-\u2026", className: "font-mono text-xs", disabled: adding })),
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                                    "Principal type",
                                    React.createElement(InfoTooltip, { size: 12, content: "Identity kind the object id belongs to. Required by ARM because object ids alone don't carry the type \u2014 getting it wrong causes the PUT to fail with PrincipalTypeNotFound." })),
                                React.createElement(Select, { value: addPrincipalType, onValueChange: (v) => setAddPrincipalType(v), disabled: adding },
                                    React.createElement(SelectTrigger, null,
                                        React.createElement(SelectValue, { placeholder: "Select principal type" })),
                                    React.createElement(SelectContent, null,
                                        React.createElement(SelectItem, { value: "User" }, "User"),
                                        React.createElement(SelectItem, { value: "Group" }, "Group"),
                                        React.createElement(SelectItem, { value: "ServicePrincipal" }, "Service Principal")))),
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                                    "Role",
                                    React.createElement(InfoTooltip, { size: 12, content: "Includes every built-in role plus any custom role definitions visible at or above the subscription scope. Custom roles are clearly tagged in the dropdown." })),
                                React.createElement(Select, { value: addRoleId, onValueChange: setAddRoleId, disabled: adding || roleDefs.length === 0 },
                                    React.createElement(SelectTrigger, null,
                                        React.createElement(SelectValue, { placeholder: "Pick a role" })),
                                    React.createElement(SelectContent, { className: "max-h-72" }, roleDefs
                                        .slice()
                                        .sort((a, b) => a.name.localeCompare(b.name))
                                        .map((r) => {
                                        var _a;
                                        return (React.createElement(SelectItem, { key: r.id, value: r.id },
                                            React.createElement("span", { className: "flex flex-col" },
                                                React.createElement("span", { className: "text-sm" }, r.name),
                                                React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                                    r.type === "CustomRole"
                                                        ? "Custom"
                                                        : "Built-in",
                                                    " ",
                                                    "\u00B7 ",
                                                    ((_a = r.id) !== null && _a !== void 0 ? _a : "").slice(0, 8),
                                                    "\u2026"))));
                                    }))))),
                        armPutPreview && (React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-2xs", onClick: () => setShowArmPreview((v) => !v), "aria-expanded": showArmPreview, "aria-controls": "sm-arm-put-preview" },
                                    showArmPreview ? (React.createElement(ChevronDown, { className: "h-3 w-3" })) : (React.createElement(ChevronRight, { className: "h-3 w-3" })),
                                    showArmPreview ? "Hide" : "Show",
                                    " ARM PUT preview (sanitized)"),
                                showArmPreview && (React.createElement(CopyButtonSmall, { value: JSON.stringify(armPutPreview, null, 2), ariaLabel: "Copy ARM PUT preview JSON", title: "Copy preview JSON" }))),
                            showArmPreview && (React.createElement("pre", { id: "sm-arm-put-preview", className: "overflow-x-auto rounded-md border border-border bg-muted/30 p-2 text-2xs font-mono leading-snug" },
                                armPutPreview.url,
                                "\n\n",
                                JSON.stringify(armPutPreview.body, null, 2))))),
                        existingMatchForAdd && (React.createElement(Alert, { variant: "warning" },
                            React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                            React.createElement(AlertDescription, null,
                                "This principal already holds",
                                " ",
                                React.createElement("strong", null, (_h = (_g = roleDefs.find((r) => r.id === addRoleId)) === null || _g === void 0 ? void 0 : _g.name) !== null && _h !== void 0 ? _h : "the role"),
                                " ",
                                "at this scope. The PUT will be a no-op (idempotent)."))),
                        addError && (React.createElement(Alert, { variant: "destructive" },
                            React.createElement(AlertDescription, null, addError))),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                            React.createElement(Button, { type: "button", onClick: () => void submitAdd(), disabled: adding ||
                                    !addPrincipalInput.trim() ||
                                    !addRoleId ||
                                    !subscriptionId, loading: adding },
                                !adding && React.createElement(Plus, null),
                                adding ? "Adding…" : "Grant role"),
                            selfPrincipalId && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-8 text-xs", disabled: adding || !addRoleId, onClick: () => {
                                    setAddPrincipalInput(selfPrincipalId);
                                    setAddPrincipalType("User");
                                }, title: "Pre-fill the input with your own object id" },
                                React.createElement(User, { className: "h-3.5 w-3.5" }),
                                "Use my id")),
                            React.createElement("span", { className: "ml-auto flex items-center gap-1 text-2xs text-muted-foreground" },
                                "Subscription:",
                                React.createElement(CopyableText, { value: subscriptionId, mono: true, ariaLabel: "Copy subscription id" }))))),
                React.createElement("div", { className: "grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8" },
                    React.createElement(SummaryStatItem, { label: "Total", value: roleStats.total, compact: true, onClick: hasActiveFilters ? clearAllFilters : undefined, ariaLabel: hasActiveFilters
                            ? `Clear filters, total ${roleStats.total} assignments`
                            : `Total ${roleStats.total} assignments` }),
                    React.createElement(SummaryStatItem, { label: "Owners", value: roleStats.owners, tone: roleStats.owners > 0 ? "warning" : "muted", compact: true, onClick: () => setRoleFilter(AZURE_ROLE_OWNER), ariaLabel: `Filter to ${roleStats.owners} Owner assignments` }),
                    React.createElement(SummaryStatItem, { label: "Contribs", value: roleStats.contribs, tone: "info", compact: true, onClick: () => setRoleFilter("b24988ac-6180-42a0-ab88-20f7382dd24c"), ariaLabel: `Filter to ${roleStats.contribs} Contributor assignments` }),
                    React.createElement(SummaryStatItem, { label: "Readers", value: roleStats.readers, tone: "muted", compact: true, onClick: () => setRoleFilter("acdd72a7-3385-48ef-bd42-f606fba81ae7"), ariaLabel: `Filter to ${roleStats.readers} Reader assignments` }),
                    React.createElement(SummaryStatItem, { label: "SPNs", value: roleStats.sps, tone: roleStats.sps > 0 ? "info" : "muted", compact: true, onClick: () => setTypeFilter("ServicePrincipal"), ariaLabel: `Filter to ${roleStats.sps} service principal assignments` }),
                    React.createElement(SummaryStatItem, { label: "Groups", value: roleStats.groups, tone: "muted", compact: true, onClick: () => setTypeFilter("Group"), ariaLabel: `Filter to ${roleStats.groups} group assignments` }),
                    React.createElement(SummaryStatItem, { label: "Inherited", value: roleStats.inherited, tone: "muted", compact: true, onClick: () => setScopeFilter("inherited"), ariaLabel: `Filter to ${roleStats.inherited} inherited assignments` }),
                    React.createElement(SummaryStatItem, { label: "Unresolved", value: roleStats.unresolved, tone: roleStats.unresolved > 0 ? "destructive" : "muted", compact: true, onClick: () => setStalenessFilter("unresolved"), hint: roleStats.unresolved > 0 ? "stale?" : undefined, ariaLabel: `Filter to ${roleStats.unresolved} unresolved principals` })),
                ownerCount === 0 && assignments.length > 0 && selfPrincipalId && (React.createElement(Alert, { variant: "warning" },
                    React.createElement(ShieldAlert, { className: "h-4 w-4" }),
                    React.createElement(AlertDescription, { className: "flex flex-wrap items-center gap-2 text-xs" },
                        React.createElement("span", null,
                            "No ",
                            React.createElement("strong", null, "Owner"),
                            " role assignment exists at this subscription's scope. Access depends entirely on higher-scope (mgmt-group / tenant) roles."),
                        React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-xs", onClick: () => {
                                setAddPrincipalInput(selfPrincipalId);
                                setAddPrincipalType("User");
                                setAddRoleId(AZURE_ROLE_OWNER);
                            } },
                            React.createElement(Crown, { className: "h-3.5 w-3.5" }),
                            "Pre-fill: grant myself Owner")))),
                principalResolveWarning && (React.createElement(Alert, { variant: "warning" },
                    React.createElement(AlertDescription, null, principalResolveWarning))),
                riskInsights.count > 0 && (React.createElement(Card, { className: "border-warning/30 bg-warning/5" },
                    React.createElement(CardHeader, { className: "pb-2" },
                        React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                            React.createElement(ShieldAlert, { className: "h-4 w-4 text-warning" }),
                            "Risk insights",
                            React.createElement(Badge, { variant: "warning", className: "text-2xs" }, riskInsights.count)),
                        React.createElement(CardDescription, { className: "text-xs" }, "Defender-side pattern matches drawn from the offensive-tooling corpus. Not necessarily malicious \u2014 cross-reference each finding with your change-management log before acting.")),
                    React.createElement(CardContent, { className: "flex flex-col gap-2 text-xs" },
                        riskInsights.crossTenant && selectedSub && account && (React.createElement("div", { className: "rounded-md border border-warning/40 bg-background p-2" },
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement(Badge, { variant: "warning", className: "text-2xs" }, "Cross-tenant"),
                                React.createElement("span", { className: "font-medium" }, "Subscription lives in a different tenant than the source account.")),
                            React.createElement("div", { className: "mt-1 text-2xs text-muted-foreground" },
                                "Sub tenant",
                                " ",
                                React.createElement("code", { className: "font-mono" },
                                    selectedSub.tenantId.slice(0, 8),
                                    "\u2026"),
                                " ",
                                "vs source-account tenant",
                                " ",
                                React.createElement("code", { className: "font-mono" },
                                    account.tenantId.slice(0, 8),
                                    "\u2026"),
                                ". Every mutation here is logged in the sub's tenant audit, not yours. Reference:",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "_ea_subscription_cross_tenant.md"),
                                " ",
                                "\u00A71.2 (Microsoft Billing first-party SPN) +",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "_bypass_tenant_switch.md"),
                                "."))),
                        riskInsights.recentOwners.length > 0 && (React.createElement("div", { className: "rounded-md border border-warning/40 bg-background p-2" },
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                                    riskInsights.recentOwners.length,
                                    " recent Owner",
                                    riskInsights.recentOwners.length === 1 ? "" : "s"),
                                React.createElement("span", { className: "font-medium" }, "Owner role granted in the last 24 hours.")),
                            React.createElement("ul", { className: "ml-4 mt-1 list-disc text-2xs text-muted-foreground" },
                                riskInsights.recentOwners.slice(0, 3).map((r) => {
                                    var _a, _b;
                                    return (React.createElement("li", { key: r.assignment.id }, (_b = (_a = r.principal) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : r.assignment.principalId,
                                        " ",
                                        "\u00B7",
                                        " ",
                                        r.assignment.createdOn
                                            ? fmtDate(r.assignment.createdOn)
                                            : "no createdOn"));
                                }),
                                riskInsights.recentOwners.length > 3 && (React.createElement("li", null,
                                    "\u2026 and ",
                                    riskInsights.recentOwners.length - 3,
                                    " more"))),
                            React.createElement("div", { className: "mt-1 text-2xs text-muted-foreground" },
                                "Reference:",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "_bypass_role_grant.md"),
                                " ",
                                "(rapid escalation pattern)."))),
                        riskInsights.unresolvedOwners.length > 0 && (React.createElement("div", { className: "rounded-md border border-destructive/40 bg-background p-2" },
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                                    riskInsights.unresolvedOwners.length,
                                    " unresolved Owner",
                                    riskInsights.unresolvedOwners.length === 1 ? "" : "s"),
                                React.createElement("span", { className: "font-medium" }, "High-privilege role tied to a principal Graph can't resolve.")),
                            React.createElement("ul", { className: "ml-4 mt-1 list-disc text-2xs text-muted-foreground" },
                                riskInsights.unresolvedOwners.slice(0, 3).map((r) => (React.createElement("li", { key: r.assignment.id, className: "font-mono break-all" },
                                    r.assignment.principalId,
                                    " \u00B7",
                                    " ",
                                    r.assignment.principalType))),
                                riskInsights.unresolvedOwners.length > 3 && (React.createElement("li", null,
                                    "\u2026 and ",
                                    riskInsights.unresolvedOwners.length - 3,
                                    " more"))),
                            React.createElement("div", { className: "mt-1 flex flex-wrap items-center gap-2" },
                                React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Common cause: deleted user / SPN whose Owner grant was never cleaned up. Often safe to remove after spot-checking."),
                                React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-6 text-2xs", onClick: () => {
                                        setRoleFilter(AZURE_ROLE_OWNER);
                                        setStalenessFilter("unresolved");
                                        announce(`Filtered to ${riskInsights.unresolvedOwners.length} unresolved Owner assignments.`);
                                    } },
                                    React.createElement(Filter, { className: "h-3 w-3" }),
                                    "Filter list to these")))),
                        riskInsights.deceptivePrincipals.length > 0 && (React.createElement("div", { className: "rounded-md border border-warning/40 bg-background p-2" },
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                                    riskInsights.deceptivePrincipals.length,
                                    " blending name",
                                    riskInsights.deceptivePrincipals.length === 1
                                        ? ""
                                        : "s"),
                                React.createElement("span", { className: "font-medium" }, "User principals with backdoor-blending naming.")),
                            React.createElement("ul", { className: "ml-4 mt-1 list-disc text-2xs text-muted-foreground" },
                                riskInsights.deceptivePrincipals.slice(0, 3).map((r) => {
                                    var _a, _b, _c, _d;
                                    return (React.createElement("li", { key: r.assignment.id }, (_d = (_b = (_a = r.principal) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : (_c = r.principal) === null || _c === void 0 ? void 0 : _c.signInName) !== null && _d !== void 0 ? _d : r.assignment.principalId,
                                        " ",
                                        "\u00B7 ",
                                        r.roleName));
                                }),
                                riskInsights.deceptivePrincipals.length > 3 && (React.createElement("li", null,
                                    "\u2026 and",
                                    " ",
                                    riskInsights.deceptivePrincipals.length - 3,
                                    " more"))),
                            React.createElement("div", { className: "mt-1 text-2xs text-muted-foreground" },
                                "Patterns:",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "svc-, _sync_, admin-, *backup*, *sync*"),
                                " ",
                                "\u2014 Reference:",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "_bypass_modify_delete.md"),
                                " ",
                                "\u00A74.1 (backdoor user with pre-assigned role).")))))),
                React.createElement(Card, null,
                    React.createElement(CardHeader, { className: "pb-3" },
                        React.createElement(CardTitle, { className: "flex flex-wrap items-center gap-2 text-sm" },
                            React.createElement(Crown, { className: "h-4 w-4 text-primary" }),
                            "Role assignments",
                            React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                                filteredRows.length,
                                "/",
                                assignments.length),
                            ownerCount > 0 && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                                ownerCount,
                                " Owner",
                                ownerCount === 1 ? "" : "s")),
                            roleStats.custom > 0 && (React.createElement(Badge, { variant: "info", className: "text-2xs" },
                                roleStats.custom,
                                " custom")),
                            roleStats.unresolved > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                                roleStats.unresolved,
                                " unresolved")),
                            React.createElement("span", { className: "ml-auto flex items-center gap-2" },
                                React.createElement("span", { className: "flex items-center gap-0.5 rounded-md border border-border p-0.5", role: "group", "aria-label": "Layout" },
                                    React.createElement(Button, { type: "button", variant: viewMode === "flat" ? "default" : "ghost", size: "icon-sm", className: "h-6 w-6", onClick: () => changeViewMode("flat"), "aria-label": "Flat list layout", title: "Flat list" },
                                        React.createElement(ListChecks, { className: "h-3 w-3" })),
                                    React.createElement(Button, { type: "button", variant: viewMode === "grouped" ? "default" : "ghost", size: "icon-sm", className: "h-6 w-6", onClick: () => changeViewMode("grouped"), "aria-label": "Grouped-by-role layout", title: "Group by role" },
                                        React.createElement(Layers, { className: "h-3 w-3" }))),
                                React.createElement(ExportMenu, { rows: filteredRows, columns: roleAssignmentExportColumns, filename: `role-assignments-${subscriptionId.slice(0, 8)}`, label: "Export", jsonMetadata: {
                                        subscriptionId,
                                        subscriptionName: selectedSub === null || selectedSub === void 0 ? void 0 : selectedSub.displayName,
                                        tenantId: selectedSub === null || selectedSub === void 0 ? void 0 : selectedSub.tenantId,
                                        generatedAt: new Date().toISOString(),
                                        totalAssignments: assignments.length,
                                        filteredCount: filteredRows.length,
                                        ownerCount,
                                        customRoleCount: roleStats.custom,
                                        filtersApplied: {
                                            search: search || undefined,
                                            roleFilter,
                                            typeFilter,
                                            scopeFilter,
                                            kindFilter,
                                            stalenessFilter,
                                            sortKey,
                                        },
                                    } }))),
                        React.createElement(CardDescription, null,
                            "Direct assignments at this subscription scope are deletable; inherited rows (from management group / tenant) are shown but locked. Press",
                            " ",
                            React.createElement("kbd", { className: "rounded border px-1 text-2xs" }, "/"),
                            " to jump to search.")),
                    React.createElement(CardContent, { className: "flex flex-col gap-3" },
                        React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-4" },
                            React.createElement("div", { className: "relative sm:col-span-2" },
                                React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                                React.createElement(Input, { ref: searchRef, value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search name, UPN, object id, description\u2026", className: "pl-8 pr-8 text-xs", "aria-label": "Search role assignments" }),
                                search && (React.createElement("button", { type: "button", onClick: () => setSearch(""), className: "absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground", "aria-label": "Clear search", title: "Clear search" },
                                    React.createElement(X, { className: "h-3 w-3" })))),
                            React.createElement(Select, { value: roleFilter, onValueChange: setRoleFilter },
                                React.createElement(SelectTrigger, { className: "text-xs" },
                                    React.createElement(SelectValue, { placeholder: "Role" })),
                                React.createElement(SelectContent, null,
                                    React.createElement(SelectItem, { value: "all" }, "Any role"),
                                    rolesPresent.map(([id, name]) => (React.createElement(SelectItem, { key: id, value: id }, name))))),
                            React.createElement(Select, { value: typeFilter, onValueChange: setTypeFilter },
                                React.createElement(SelectTrigger, { className: "text-xs" },
                                    React.createElement(SelectValue, { placeholder: "Type" })),
                                React.createElement(SelectContent, null, PRINCIPAL_TYPE_FILTERS.map((f) => (React.createElement(SelectItem, { key: f.value, value: f.value }, f.label)))))),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                            React.createElement("span", { className: "flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                                "Scope",
                                React.createElement(InfoTooltip, { size: 12, content: "Where the assignment was actually created. \u2018At this scope\u2019 assignments are deletable; \u2018inherited\u2019 rows come from a management group or tenant scope and must be deleted there." })),
                            React.createElement(Button, { type: "button", variant: scopeFilter === "all" ? "default" : "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setScopeFilter("all") }, "All"),
                            React.createElement(Button, { type: "button", variant: scopeFilter === "at-scope" ? "default" : "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setScopeFilter("at-scope") },
                                React.createElement(ArrowDownToLine, { className: "h-3 w-3" }),
                                "At this scope"),
                            React.createElement(Button, { type: "button", variant: scopeFilter === "inherited" ? "default" : "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setScopeFilter("inherited") },
                                React.createElement(ArrowUpFromLine, { className: "h-3 w-3" }),
                                "Inherited"),
                            React.createElement("span", { className: "mx-1 h-4 w-px bg-border", "aria-hidden": true }),
                            React.createElement("span", { className: "flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                                "Kind",
                                React.createElement(InfoTooltip, { size: 12, content: "Filter by the role definition's type. Built-in roles ship with Azure (Owner, Contributor, \u2026). Custom roles are defined in the tenant or subscription itself." })),
                            React.createElement(Button, { type: "button", variant: kindFilter === "all" ? "default" : "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setKindFilter("all") }, "Any"),
                            React.createElement(Button, { type: "button", variant: kindFilter === "builtin" ? "default" : "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setKindFilter("builtin") }, "Built-in"),
                            React.createElement(Button, { type: "button", variant: kindFilter === "custom" ? "default" : "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setKindFilter("custom") }, "Custom"),
                            React.createElement("span", { className: "mx-1 h-4 w-px bg-border", "aria-hidden": true }),
                            React.createElement("span", { className: "flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                                "Resolve",
                                React.createElement(InfoTooltip, { size: 12, content: "\u2018Unresolved\u2019 rows are principal GUIDs that Graph couldn't expand to a display name. Common causes: deleted users, tenant-deleted SPNs, or guests from a tenant you can't read. Often safe to clean up after spot-checking the GUID." })),
                            React.createElement(Button, { type: "button", variant: stalenessFilter === "all" ? "default" : "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setStalenessFilter("all") }, "Any"),
                            React.createElement(Button, { type: "button", variant: stalenessFilter === "resolved" ? "default" : "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setStalenessFilter("resolved") },
                                React.createElement(Eye, { className: "h-3 w-3" }),
                                "Resolved"),
                            React.createElement(Button, { type: "button", variant: stalenessFilter === "unresolved" ? "default" : "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setStalenessFilter("unresolved") },
                                React.createElement(EyeOff, { className: "h-3 w-3" }),
                                "Unresolved"),
                            React.createElement("span", { className: "ml-auto flex flex-wrap items-center gap-2" },
                                hasActiveFilters && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: clearAllFilters, "aria-label": "Clear all filters" },
                                    React.createElement(Filter, { className: "h-3 w-3" }),
                                    "Clear filters")),
                                React.createElement("span", { className: "flex items-center gap-1", "aria-label": "Sort" },
                                    React.createElement(ArrowUpDown, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": true }),
                                    React.createElement(Select, { value: sortKey, onValueChange: (v) => setSortKey(v) },
                                        React.createElement(SelectTrigger, { className: "h-7 w-auto text-xs" },
                                            React.createElement(SelectValue, null)),
                                        React.createElement(SelectContent, null,
                                            React.createElement(SelectItem, { value: "name" }, "Name (A \u2192 Z)"),
                                            React.createElement(SelectItem, { value: "name-desc" }, "Name (Z \u2192 A)"),
                                            React.createElement(SelectItem, { value: "role" }, "Role (Owners first)"),
                                            React.createElement(SelectItem, { value: "role-desc" }, "Role (Z \u2192 A)"),
                                            React.createElement(SelectItem, { value: "type" }, "Type"),
                                            React.createElement(SelectItem, { value: "scope" }, "Scope (direct first)"),
                                            React.createElement(SelectItem, { value: "created" }, "Created (newest)")))),
                                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: selectAllDeletable, disabled: filteredRows.length === 0 }, "Select all deletable"),
                                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: clearSelection, disabled: selected.size === 0 }, "Clear"),
                                myRows.length > 0 && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-7 text-xs", onClick: removeMe },
                                    React.createElement(LogOut, { className: "h-3 w-3" }),
                                    "Remove me (",
                                    myRows.length,
                                    ")")),
                                React.createElement(Button, { type: "button", variant: "destructive", size: "sm", className: "h-7 text-xs", onClick: () => setConfirmOpen(true), disabled: deleteDisabled },
                                    React.createElement(Trash2, { className: "h-3 w-3" }),
                                    "Delete ",
                                    selected.size > 0 ? `(${selected.size})` : ""))),
                        listLoading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 4 })) : listError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load role assignments.", detail: listError, onRetry: reload, retryLabel: "Retry" })) : filteredRows.length === 0 ? (React.createElement("div", { className: "flex flex-col items-center gap-2 py-8 text-center text-xs text-muted-foreground" },
                            React.createElement("p", null, assignments.length === 0
                                ? "No role assignments at this scope."
                                : "No matching role assignments."),
                            hasActiveFilters && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-7 text-xs", onClick: clearAllFilters },
                                React.createElement(Filter, { className: "h-3 w-3" }),
                                "Clear filters")))) : viewMode === "grouped" ? (React.createElement(GroupedAssignmentsList, { rows: filteredRows, selfPrincipalId: selfPrincipalId, selected: selected, getToggleSelect: getToggleSelect, collapsedGroups: collapsedGroups, onToggleGroup: toggleGroup, deleting: deleting, roleKindById: roleKindById })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, filteredRows.map((r) => (React.createElement(AssignmentRow, { key: r.assignment.id, row: r, isSelf: !!selfPrincipalId &&
                                r.assignment.principalId === selfPrincipalId, isChecked: selected.has(r.assignment.id), onToggleSelect: getToggleSelect(r.assignment.id), deleting: deleting, isCustomRole: roleKindById.get(r.assignment.roleDefinitionId) ===
                                "CustomRole" }))))))))),
            React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: `Delete ${selectedRowsObjects.length} role assignment${selectedRowsObjects.length === 1 ? "" : "s"}?`, danger: true, loading: deleting, confirmText: deleting ? "Deleting…" : "Delete", cancelText: "Cancel", onCancel: () => setConfirmOpen(false), onConfirm: () => void performDelete(), message: React.createElement("div", { className: "flex flex-col gap-2 text-xs" },
                    React.createElement("p", null, "This removes the selected role assignments at scope:"),
                    React.createElement("code", { className: "block break-all rounded bg-muted px-2 py-1 font-mono text-2xs" },
                        "/subscriptions/",
                        encodeURIComponent(subscriptionId)),
                    selectedTouchesSelf && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, null, "One or more selected rows belong to you. After delete you may lose access to this subscription."))),
                    wouldRemoveLastOwner && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(ShieldOff, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, null, "This removes every remaining Owner at this scope. The subscription will be left with no Owner \u2014 only a higher-scope role assignment (mgmt group / tenant) can reach it after."))),
                    React.createElement(DeletePreview, { rows: selectedRowsObjects })) })))));
};
// =========================================================================
//  EA Department management tab
// =========================================================================
/**
 * Tiny shared hook — acquires an ARM token for the picked account and
 * loads EA billing accounts. Used by both EA tabs (Departments + Grant).
 *
 * Account + billing-account selection are URL-synced via `?ba_account=`
 * and `?ba=` so deep-links into a specific BA are shareable. The two
 * EA tabs sharing this hook means switching tabs preserves the BA the
 * operator was looking at.
 *
 * Race protection: `listEaBillingAccounts` is wrapped in a
 * cancel-on-rerun guard so flipping the source account mid-fetch
 * doesn't race the older response into the picker.
 */
function useBillingAccountPicker(azureAccounts, store) {
    // Seed the URL param from sessionStorage so a fresh tab restores the
    // last-used account; the URL is authoritative afterward.
    const initialAccount = React.useMemo(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_ACCOUNT)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    }, []);
    const [accountParam, setAccountParam] = useUrlParam("ba_account", initialAccount, { replace: true });
    const accountId = accountParam;
    const setAccountId = React.useCallback((id) => {
        setAccountParam(id);
        try {
            sessionStorage.setItem(STORAGE_ACCOUNT, id);
        }
        catch (_a) {
            /* ignore */
        }
    }, [setAccountParam]);
    React.useEffect(() => {
        if (azureAccounts.length > 0 &&
            !azureAccounts.some((a) => a.homeAccountId === accountId)) {
            setAccountId(azureAccounts[0].homeAccountId);
        }
    }, [azureAccounts, accountId, setAccountId]);
    const account = React.useMemo(() => { var _a; return (_a = azureAccounts.find((a) => a.homeAccountId === accountId)) !== null && _a !== void 0 ? _a : null; }, [azureAccounts, accountId]);
    const [armToken, setArmToken] = React.useState(null);
    const [billingAccounts, setBillingAccounts] = React.useState([]);
    const [baLoading, setBaLoading] = React.useState(false);
    const [baError, setBaError] = React.useState(null);
    const initialBa = React.useMemo(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_BA)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    }, []);
    const [baParam, setBaParam] = useUrlParam("ba", initialBa, {
        replace: true,
    });
    const billingAccountName = baParam;
    const setBillingAccountName = React.useCallback((name) => {
        setBaParam(name);
        try {
            sessionStorage.setItem(STORAGE_BA, name);
        }
        catch (_a) {
            /* ignore */
        }
    }, [setBaParam]);
    useAbortableEffect(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    (signal) => __awaiter(this, void 0, void 0, function* () {
        if (!account) {
            setArmToken(null);
            setBillingAccounts([]);
            return;
        }
        setBaLoading(true);
        setBaError(null);
        try {
            // Tenant arg omitted so we pick up the operator's current active
            // tenant (was pinning to account.tenantId / the account's HOME
            // tenant — pre-switch).
            const tok = yield getArmTokenForAccount(account.homeAccountId);
            if (signal.aborted)
                return;
            setArmToken(tok);
            const list = yield listEaBillingAccounts(tok);
            if (signal.aborted)
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
            if (signal.aborted)
                return;
            setArmToken(null);
            setBaError(err instanceof Error ? err.message : String(err));
        }
        finally {
            if (!signal.aborted)
                setBaLoading(false);
        }
    }), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId]);
    return {
        account,
        accountId,
        setAccountId,
        armToken,
        billingAccounts,
        baLoading,
        baError,
        billingAccountName,
        setBillingAccountName,
        store,
    };
}
const ScopePickers = ({ azureAccounts, accountId, onAccountChange, baLoading, baError, billingAccounts, billingAccountName, onBaChange, }) => (React.createElement(Card, null,
    React.createElement(CardHeader, { className: "pb-3" },
        React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
            React.createElement(Crown, { className: "h-4 w-4 text-primary" }),
            "Scope"),
        React.createElement(CardDescription, null, "Pick a signed-in EA-billing account and the billing account to manage.")),
    React.createElement(CardContent, { className: "grid grid-cols-1 gap-3 sm:grid-cols-2" },
        React.createElement("div", { className: "flex flex-col gap-1.5" },
            React.createElement(Label, { className: "text-xs" }, "Source account"),
            React.createElement(Select, { value: accountId, onValueChange: onAccountChange },
                React.createElement(SelectTrigger, null,
                    React.createElement(SelectValue, { placeholder: "Pick an account" })),
                React.createElement(SelectContent, null, azureAccounts.map((a) => (React.createElement(SelectItem, { key: a.homeAccountId, value: a.homeAccountId },
                    React.createElement("span", { className: "flex flex-col" },
                        React.createElement("span", { className: "text-sm" }, a.name),
                        React.createElement("span", { className: "text-2xs text-muted-foreground" }, a.username)))))))),
        React.createElement("div", { className: "flex flex-col gap-1.5" },
            React.createElement(Label, { className: "text-xs" }, "Billing account"),
            baLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                React.createElement(Loader2, { className: "h-3 w-3 animate-spin" }),
                " loading\u2026")) : baError ? (React.createElement(Alert, { variant: "destructive" },
                React.createElement(AlertDescription, null, baError))) : billingAccounts.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No EA billing accounts visible.")) : (React.createElement(Select, { value: billingAccountName, onValueChange: onBaChange },
                React.createElement(SelectTrigger, null,
                    React.createElement(SelectValue, { placeholder: "Pick a billing account" })),
                React.createElement(SelectContent, null, billingAccounts.map((b) => (React.createElement(SelectItem, { key: b.name, value: b.name },
                    React.createElement("span", { className: "flex flex-col" },
                        React.createElement("span", { className: "text-sm" }, b.displayName),
                        React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                            b.name,
                            " \u00B7 ",
                            b.agreementType))))))))))));
const DepartmentsTab = ({ azureAccounts, store }) => {
    const ctx = useBillingAccountPicker(azureAccounts, store);
    const { account, armToken, billingAccountName } = ctx;
    const [depts, setDepts] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [reloadTick, setReloadTick] = React.useState(0);
    // Local filter for the dept list. Per-account billing data with
    // hundreds of departments under a tenant is common, so a quick
    // substring filter on display name + cost center cuts noise fast.
    const [deptSearch, setDeptSearch] = React.useState("");
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (!armToken || !billingAccountName) {
            setDepts([]);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const d = yield listEaDepartments(billingAccountName, armToken);
            if (signal.aborted)
                return;
            setDepts(d);
        }
        catch (err) {
            if (signal.aborted)
                return;
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            if (!signal.aborted)
                setLoading(false);
        }
    }), [armToken, billingAccountName, reloadTick]);
    // Filtered + alphabetically-sorted view for the list. Sorting is
    // applied after filtering so the order is deterministic regardless of
    // what ARM happened to return.
    const visibleDepts = React.useMemo(() => {
        const q = deptSearch.trim().toLowerCase();
        const out = depts
            .filter((d) => {
            var _a, _b;
            if (!q)
                return true;
            const hay = [d.departmentName, d.name, (_a = d.costCenter) !== null && _a !== void 0 ? _a : "", (_b = d.status) !== null && _b !== void 0 ? _b : ""]
                .join(" ")
                .toLowerCase();
            return hay.includes(q);
        })
            .slice()
            .sort((a, b) => a.departmentName.localeCompare(b.departmentName));
        return out;
    }, [depts, deptSearch]);
    /* Create form */
    const [newName, setNewName] = React.useState("");
    const [newDisplay, setNewDisplay] = React.useState("");
    const [newCostCenter, setNewCostCenter] = React.useState("");
    const [submitting, setSubmitting] = React.useState(false);
    const [submitError, setSubmitError] = React.useState(null);
    const submitCreate = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b;
        if (!armToken || !billingAccountName)
            return;
        if (!newName.trim() || !newDisplay.trim())
            return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            yield createEaDepartment(billingAccountName, newName.trim(), {
                departmentName: newDisplay.trim(),
                costCenter: newCostCenter.trim() || undefined,
            }, armToken);
            auditLog.record({
                actor: (_a = account === null || account === void 0 ? void 0 : account.username) !== null && _a !== void 0 ? _a : "",
                action: "create_ea_department",
                target: newName.trim(),
                status: "success",
                details: { billingAccountName, displayName: newDisplay },
            });
            store.addNotification({
                type: "success",
                message: `Department "${newDisplay}" created.`,
            });
            setNewName("");
            setNewDisplay("");
            setNewCostCenter("");
            setReloadTick((n) => n + 1);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setSubmitError(msg);
            // Failure-path audit so create_ea_department gets both paths.
            auditLog.record({
                actor: (_b = account === null || account === void 0 ? void 0 : account.username) !== null && _b !== void 0 ? _b : "",
                action: "create_ea_department",
                target: newName.trim(),
                status: "failure",
                error: msg,
                details: { billingAccountName, displayName: newDisplay },
            });
        }
        finally {
            setSubmitting(false);
        }
    }), [armToken, billingAccountName, newName, newDisplay, newCostCenter, account === null || account === void 0 ? void 0 : account.username, store]);
    /* Per-row edit / delete */
    const [editingId, setEditingId] = React.useState(null);
    const [editDisplay, setEditDisplay] = React.useState("");
    const [editCostCenter, setEditCostCenter] = React.useState("");
    const [rowBusy, setRowBusy] = React.useState(null);
    const startEdit = (d) => {
        var _a;
        setEditingId(d.name);
        setEditDisplay(d.departmentName);
        setEditCostCenter((_a = d.costCenter) !== null && _a !== void 0 ? _a : "");
    };
    const submitEdit = () => __awaiter(void 0, void 0, void 0, function* () {
        var _c, _d;
        if (!editingId || !armToken || !billingAccountName)
            return;
        setRowBusy(editingId);
        try {
            yield updateEaDepartment(billingAccountName, editingId, {
                departmentName: editDisplay.trim() || undefined,
                costCenter: editCostCenter.trim() || undefined,
            }, armToken);
            auditLog.record({
                actor: (_c = account === null || account === void 0 ? void 0 : account.username) !== null && _c !== void 0 ? _c : "",
                action: "update_ea_department",
                target: editingId,
                status: "success",
                details: { billingAccountName, displayName: editDisplay, costCenter: editCostCenter },
            });
            store.addNotification({
                type: "success",
                message: `Department "${editDisplay}" updated.`,
            });
            setEditingId(null);
            setReloadTick((n) => n + 1);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Failure-path audit so update_ea_department gets both paths.
            auditLog.record({
                actor: (_d = account === null || account === void 0 ? void 0 : account.username) !== null && _d !== void 0 ? _d : "",
                action: "update_ea_department",
                target: editingId,
                status: "failure",
                error: msg,
                details: { billingAccountName, displayName: editDisplay, costCenter: editCostCenter },
            });
            store.addNotification({
                type: "error",
                message: msg,
            });
        }
        finally {
            setRowBusy(null);
        }
    });
    // Department to delete, awaiting confirmation. Replaces window.confirm.
    const [pendingDelete, setPendingDelete] = React.useState(null);
    const submitDelete = (d) => __awaiter(void 0, void 0, void 0, function* () {
        var _e, _f;
        if (!armToken || !billingAccountName)
            return;
        setPendingDelete(null);
        setRowBusy(d.name);
        try {
            yield deleteEaDepartment(billingAccountName, d.name, armToken);
            auditLog.record({
                actor: (_e = account === null || account === void 0 ? void 0 : account.username) !== null && _e !== void 0 ? _e : "",
                action: "delete_ea_department",
                target: d.name,
                status: "success",
                details: { billingAccountName },
            });
            store.addNotification({
                type: "success",
                message: `Department "${d.departmentName}" deleted.`,
            });
            setReloadTick((n) => n + 1);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Failure-path audit so delete_ea_department gets both paths.
            auditLog.record({
                actor: (_f = account === null || account === void 0 ? void 0 : account.username) !== null && _f !== void 0 ? _f : "",
                action: "delete_ea_department",
                target: d.name,
                status: "failure",
                error: msg,
                details: { billingAccountName, displayName: d.departmentName },
            });
            store.addNotification({
                type: "error",
                message: msg,
            });
        }
        finally {
            setRowBusy(null);
        }
    });
    return (React.createElement("div", { className: "flex flex-col gap-3" },
        React.createElement(ScopePickers, { azureAccounts: azureAccounts, accountId: ctx.accountId, onAccountChange: ctx.setAccountId, baLoading: ctx.baLoading, baError: ctx.baError, billingAccounts: ctx.billingAccounts, billingAccountName: ctx.billingAccountName, onBaChange: ctx.setBillingAccountName }),
        !billingAccountName ? (React.createElement(EmptyState, { icon: Building2, title: "Pick a billing account", description: "Departments under the selected EA billing account will appear here." })) : (React.createElement(React.Fragment, null,
            React.createElement(Card, { className: "border-primary/30" },
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(Plus, { className: "h-4 w-4 text-primary" }),
                        " Create department"),
                    React.createElement(CardDescription, null, "PUT /billingAccounts/{ba}/departments/{name} \u2014 name is the URL-segment id, display name and cost center are properties on the row.")),
                React.createElement(CardContent, { className: "flex flex-col gap-3" },
                    React.createElement("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-3" },
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { className: "text-xs" }, "Name (URL segment) *"),
                            React.createElement(Input, { value: newName, onChange: (e) => setNewName(e.target.value), placeholder: "my-dept-001", className: "font-mono text-xs" })),
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { className: "text-xs" }, "Display name *"),
                            React.createElement(Input, { value: newDisplay, onChange: (e) => setNewDisplay(e.target.value), placeholder: "Engineering", className: "text-xs" })),
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { className: "text-xs" }, "Cost center"),
                            React.createElement(Input, { value: newCostCenter, onChange: (e) => setNewCostCenter(e.target.value), placeholder: "CC-0042", className: "text-xs" }))),
                    submitError && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertDescription, null, submitError))),
                    React.createElement("div", null,
                        React.createElement(Button, { type: "button", onClick: () => void submitCreate(), disabled: submitting || !newName.trim() || !newDisplay.trim(), loading: submitting },
                            !submitting && React.createElement(Plus, null),
                            "Create")))),
            React.createElement(Card, null,
                React.createElement(CardHeader, { className: "flex flex-row items-start justify-between gap-2 pb-3" },
                    React.createElement("div", null,
                        React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                            React.createElement(Layers, { className: "h-4 w-4 text-primary" }),
                            " Existing departments",
                            depts.length > 0 && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                                visibleDepts.length,
                                "/",
                                depts.length))),
                        React.createElement(CardDescription, null, "Rows are editable inline. Delete will fail if any enrollment accounts still reference the department.")),
                    React.createElement("div", { className: "flex items-center gap-2" },
                        React.createElement(ExportMenu, { rows: visibleDepts, columns: [
                                { header: "Display name", accessor: (d) => d.departmentName },
                                { header: "Name (URL segment)", accessor: (d) => d.name },
                                { header: "Cost center", accessor: (d) => { var _a; return (_a = d.costCenter) !== null && _a !== void 0 ? _a : ""; } },
                                { header: "Status", accessor: (d) => { var _a; return (_a = d.status) !== null && _a !== void 0 ? _a : ""; } },
                                { header: "ARM id", accessor: (d) => d.id },
                            ], filename: `ea-departments-${billingAccountName.slice(0, 12)}`, label: "Export", jsonMetadata: {
                                billingAccountName,
                                generatedAt: new Date().toISOString(),
                                totalCount: depts.length,
                                visibleCount: visibleDepts.length,
                                searchApplied: deptSearch || undefined,
                            } }),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => setReloadTick((n) => n + 1), "aria-label": "Refresh", disabled: loading },
                            React.createElement(RefreshCw, { className: loading ? "animate-spin" : undefined })))),
                React.createElement(CardContent, { className: "flex flex-col gap-2" },
                    depts.length > 0 && (React.createElement("div", { className: "relative" },
                        React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                        React.createElement(Input, { value: deptSearch, onChange: (e) => setDeptSearch(e.target.value), placeholder: "Search by display name, id, or cost center\u2026", className: "pl-8 pr-8 text-xs", "aria-label": "Search departments" }),
                        deptSearch && (React.createElement("button", { type: "button", onClick: () => setDeptSearch(""), className: "absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground", "aria-label": "Clear search", title: "Clear search" },
                            React.createElement(X, { className: "h-3 w-3" }))))),
                    loading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 3 })) : error ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load departments.", detail: error, onRetry: () => setReloadTick((n) => n + 1), retryLabel: "Retry" })) : depts.length === 0 ? (React.createElement("p", { className: "py-6 text-center text-xs text-muted-foreground" }, "No departments under this billing account.")) : visibleDepts.length === 0 ? (React.createElement("div", { className: "flex flex-col items-center gap-2 py-6 text-center text-xs text-muted-foreground" },
                        React.createElement("p", null,
                            "No departments match \"",
                            deptSearch,
                            "\"."),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setDeptSearch("") }, "Clear search"))) : (React.createElement("ul", { className: "flex flex-col gap-1" }, visibleDepts.map((d) => {
                        const editing = editingId === d.name;
                        const busy = rowBusy === d.name;
                        return (React.createElement("li", { key: d.id, className: "flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs" },
                            React.createElement(Layers, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                            editing ? (React.createElement(React.Fragment, null,
                                React.createElement(Input, { value: editDisplay, onChange: (e) => setEditDisplay(e.target.value), className: "h-7 w-48 text-xs", disabled: busy }),
                                React.createElement(Input, { value: editCostCenter, onChange: (e) => setEditCostCenter(e.target.value), className: "h-7 w-32 text-xs", placeholder: "cost center", disabled: busy }),
                                React.createElement(Button, { type: "button", size: "sm", className: "h-6 text-2xs", onClick: () => void submitEdit(), disabled: busy },
                                    busy ? (React.createElement(Loader2, { className: "h-3 w-3 animate-spin" })) : (React.createElement(Check, { className: "h-3 w-3" })),
                                    "Save"),
                                React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-6 text-2xs", onClick: () => setEditingId(null), disabled: busy }, "Cancel"))) : (React.createElement(React.Fragment, null,
                                React.createElement("span", { className: "font-medium" }, d.departmentName),
                                React.createElement(CopyableText, { value: d.name, mono: true, ariaLabel: `Copy department id ${d.name}`, className: "text-muted-foreground" }),
                                d.costCenter && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                                    "CC: ",
                                    d.costCenter)),
                                d.status && (React.createElement(Badge, { variant: "outline", className: "text-2xs" }, d.status)),
                                React.createElement("span", { className: "ml-auto flex items-center gap-1" },
                                    React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-6 text-2xs", onClick: () => startEdit(d), disabled: busy },
                                        React.createElement(Edit3, { className: "h-3 w-3" }),
                                        " Edit"),
                                    React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-6 text-2xs text-destructive", onClick: () => setPendingDelete(d), disabled: busy, "aria-label": `Delete department ${d.departmentName}` },
                                        busy ? (React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" })) : (React.createElement(Trash2, { className: "h-3 w-3" })),
                                        "Delete"))))));
                    }))))))),
        React.createElement(ConfirmationDialog, { hidden: !pendingDelete, title: "Delete department", message: pendingDelete
                ? `Delete department "${pendingDelete.departmentName}"? Enrollment accounts under it must be re-parented first; Azure will reject if any remain.`
                : "", confirmText: "Delete", danger: true, loading: !!pendingDelete && rowBusy === pendingDelete.name, onConfirm: () => {
                if (pendingDelete)
                    void submitDelete(pendingDelete);
            }, onCancel: () => setPendingDelete(null) })));
};
// =========================================================================
//  Grant Subscription Creator tab
// =========================================================================
const GrantSubCreatorTab = ({ azureAccounts, store, navigateToPage }) => {
    const ctx = useBillingAccountPicker(azureAccounts, store);
    const { account, armToken, billingAccountName } = ctx;
    /* Enrollment accounts list */
    const [eas, setEas] = React.useState([]);
    const [eaLoading, setEaLoading] = React.useState(false);
    const [eaError, setEaError] = React.useState(null);
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (!armToken || !billingAccountName) {
            setEas([]);
            return;
        }
        setEaLoading(true);
        setEaError(null);
        try {
            const list = yield listEnrollmentAccounts(billingAccountName, armToken);
            if (signal.aborted)
                return;
            setEas(list);
        }
        catch (err) {
            if (signal.aborted)
                return;
            setEaError(err instanceof Error ? err.message : String(err));
        }
        finally {
            if (!signal.aborted)
                setEaLoading(false);
        }
    }), [armToken, billingAccountName]);
    const [eaName, setEaName] = React.useState("");
    React.useEffect(() => {
        if (eas.length > 0 && !eas.some((e) => e.name === eaName)) {
            setEaName(eas[0].name);
        }
    }, [eas, eaName]);
    // Filter the enrollment-accounts picker by display-name substring.
    // Helpful for tenants with hundreds of EAs — also helps the operator
    // confirm the right one is picked before granting.
    const [eaSearch, setEaSearch] = React.useState("");
    const visibleEas = React.useMemo(() => {
        const q = eaSearch.trim().toLowerCase();
        if (!q)
            return eas;
        return eas.filter((e) => {
            var _a;
            const hay = [e.displayName, e.name, (_a = e.accountOwner) !== null && _a !== void 0 ? _a : ""]
                .join(" ")
                .toLowerCase();
            return hay.includes(q);
        });
    }, [eas, eaSearch]);
    /* Principal input — UPN/email (Graph lookup) or raw object id */
    const [principalInput, setPrincipalInput] = React.useState("");
    const [principalTenantId, setPrincipalTenantId] = React.useState("");
    // Default principalTenantId to the source account's tenant.
    React.useEffect(() => {
        if (account && !principalTenantId) {
            setPrincipalTenantId(account.tenantId);
        }
    }, [account, principalTenantId]);
    const [submitting, setSubmitting] = React.useState(false);
    const [submitError, setSubmitError] = React.useState(null);
    /**
     * Tracks the last successful grant — feeds the "Retry creating EA
     * Sub now" pivot card so the operator goes from "got the role" to
     * "make the subscription" in one click without re-picking the BA/EA
     * pickers. Resets on any subsequent attempt.
     */
    const [lastGrant, setLastGrant] = React.useState(null);
    /**
     * Session-local trail of recent grants (newest first, capped at 5).
     * Useful in batch onboarding workflows where the operator grants the
     * same role to a handful of people back-to-back and wants a quick
     * "did I actually get to Bob?" sanity check without diving into the
     * audit log page.
     */
    const [recentGrants, setRecentGrants] = React.useState([]);
    const submit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b;
        if (!armToken || !billingAccountName || !eaName)
            return;
        if (!principalInput.trim() || !principalTenantId.trim())
            return;
        setSubmitting(true);
        setSubmitError(null);
        setLastGrant(null);
        try {
            const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            let principalObjectId = principalInput.trim();
            if (!guidRe.test(principalObjectId)) {
                // Graph lookup in the principal's own tenant.
                const graphToken = yield getGraphTokenForAccount(account.homeAccountId, principalTenantId.trim());
                const found = yield findUserByUpnOrMail(principalTenantId.trim(), principalObjectId, graphToken);
                if (!found) {
                    throw new Error(`No user found in tenant ${principalTenantId.trim()} matching "${principalInput}". Paste the user's object id instead.`);
                }
                principalObjectId = found.id;
            }
            const r = yield createEnrollmentAccountRoleAssignment(billingAccountName, eaName, principalObjectId, principalTenantId.trim(), ROLE_EA_SUBSCRIPTION_CREATOR, armToken);
            auditLog.record({
                actor: (_a = account === null || account === void 0 ? void 0 : account.username) !== null && _a !== void 0 ? _a : "",
                action: "grant_ea_subscription_creator",
                target: principalObjectId,
                status: "success",
                details: {
                    billingAccountName,
                    enrollmentAccountName: eaName,
                    principalTenantId: principalTenantId.trim(),
                    roleAssignmentId: r.id,
                },
            });
            store.addNotification({
                type: "success",
                message: `Granted EA Subscription Creator to ${principalInput} on enrollment account ${eaName}.`,
            });
            // Record the successful grant — drives the inline "Retry creating
            // EA Sub now" pivot card right below the form.
            if (account) {
                setLastGrant({
                    homeAccountId: account.homeAccountId,
                    billingAccountName,
                    enrollmentAccountName: eaName,
                    principal: principalInput.trim(),
                    grantedAt: Date.now(),
                });
            }
            // Push onto the session-local recent-grants trail (newest first,
            // dedup by principal+EA, cap at 5 to keep the panel readable).
            setRecentGrants((prev) => {
                const next = [
                    {
                        principal: principalInput.trim(),
                        enrollmentAccountName: eaName,
                        grantedAt: Date.now(),
                        roleAssignmentId: r.id,
                    },
                    ...prev.filter((g) => !(g.principal === principalInput.trim() &&
                        g.enrollmentAccountName === eaName)),
                ];
                return next.slice(0, 5);
            });
            setPrincipalInput("");
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setSubmitError(msg);
            // Failure-path audit so grant_ea_subscription_creator gets both paths.
            auditLog.record({
                actor: (_b = account === null || account === void 0 ? void 0 : account.username) !== null && _b !== void 0 ? _b : "",
                action: "grant_ea_subscription_creator",
                target: principalInput.trim(),
                status: "failure",
                error: msg,
                details: {
                    billingAccountName,
                    enrollmentAccountName: eaName,
                    principalTenantId: principalTenantId.trim(),
                },
            });
        }
        finally {
            setSubmitting(false);
        }
    }), [
        armToken,
        billingAccountName,
        eaName,
        principalInput,
        principalTenantId,
        account,
        store,
    ]);
    return (React.createElement("div", { className: "flex flex-col gap-3" },
        React.createElement(ScopePickers, { azureAccounts: azureAccounts, accountId: ctx.accountId, onAccountChange: ctx.setAccountId, baLoading: ctx.baLoading, baError: ctx.baError, billingAccounts: ctx.billingAccounts, billingAccountName: ctx.billingAccountName, onBaChange: ctx.setBillingAccountName }),
        !billingAccountName ? (React.createElement(EmptyState, { icon: Building2, title: "Pick a billing account", description: "Enrollment accounts and the EA Subscription Creator grant form will appear here." })) : (React.createElement(Card, { className: "border-primary/30" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Sparkles, { className: "h-4 w-4 text-primary" }),
                    " Grant EA Subscription Creator"),
                React.createElement(CardDescription, null,
                    "Gives a user the right to create new subscriptions under one enrollment account. Calls",
                    " ",
                    React.createElement("code", { className: "font-mono text-2xs" }, "PUT /enrollmentAccounts/{ea}/billingRoleAssignments"),
                    ".")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement("div", { className: "flex items-center justify-between" },
                        React.createElement(Label, { className: "text-xs" },
                            "Enrollment account *",
                            " ",
                            eas.length > 0 && (React.createElement("span", { className: "font-normal text-2xs text-muted-foreground" },
                                "(",
                                visibleEas.length,
                                "/",
                                eas.length,
                                ")"))),
                        eas.length > 0 && (React.createElement(ExportMenu, { rows: visibleEas, columns: [
                                { header: "Display name", accessor: (e) => e.displayName },
                                { header: "Name", accessor: (e) => e.name },
                                {
                                    header: "Account owner",
                                    accessor: (e) => { var _a; return (_a = e.accountOwner) !== null && _a !== void 0 ? _a : ""; },
                                },
                                { header: "ARM id", accessor: (e) => e.id },
                            ], filename: `enrollment-accounts-${billingAccountName.slice(0, 12)}`, label: "Export", jsonMetadata: {
                                billingAccountName,
                                generatedAt: new Date().toISOString(),
                                totalCount: eas.length,
                                visibleCount: visibleEas.length,
                                searchApplied: eaSearch || undefined,
                            } }))),
                    eas.length > 6 && (React.createElement("div", { className: "relative" },
                        React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                        React.createElement(Input, { value: eaSearch, onChange: (e) => setEaSearch(e.target.value), placeholder: "Filter enrollment accounts\u2026", className: "pl-8 pr-8 text-xs", "aria-label": "Search enrollment accounts" }),
                        eaSearch && (React.createElement("button", { type: "button", onClick: () => setEaSearch(""), className: "absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground", "aria-label": "Clear search", title: "Clear search" },
                            React.createElement(X, { className: "h-3 w-3" }))))),
                    eaLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                        React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                        " loading")) : eaError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load enrollment accounts.", detail: eaError })) : eas.length === 0 ? (React.createElement(EmptyState, { icon: Sparkles, title: "No enrollment accounts", description: "No enrollment accounts visible under this billing account. Verify the source account has EA reader rights at the billing scope.", className: "py-4" })) : visibleEas.length === 0 ? (React.createElement("p", { className: "py-2 text-center text-xs text-muted-foreground" },
                        "No enrollment accounts match \"",
                        eaSearch,
                        "\".")) : (React.createElement(Select, { value: eaName, onValueChange: setEaName },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: "Pick an enrollment account" })),
                        React.createElement(SelectContent, null, visibleEas.map((e) => (React.createElement(SelectItem, { key: e.name, value: e.name },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, e.displayName),
                                React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                                    e.name,
                                    e.accountOwner ? ` · ${e.accountOwner}` : ""))))))))),
                React.createElement("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-2" },
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { className: "text-xs" }, "User UPN / email or object id *"),
                        React.createElement(Input, { value: principalInput, onChange: (e) => {
                                setPrincipalInput(e.target.value);
                                setSubmitError(null);
                            }, placeholder: "alice@contoso.com  OR  11111111-2222-\u2026", className: "font-mono text-xs", disabled: submitting })),
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                            "Principal tenant id *",
                            React.createElement(InfoTooltip, { size: 12, content: "The tenant the recipient identity actually lives in. EA billing role assignments require this even for cross-tenant guests \u2014 otherwise ARM refuses the PUT with PrincipalNotFound." })),
                        React.createElement(Input, { value: principalTenantId, onChange: (e) => setPrincipalTenantId(e.target.value), placeholder: "tenant guid the user belongs to", className: "font-mono text-xs", disabled: submitting }),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Defaults to the source account's tenant. Override when the recipient is a guest from a different tenant."))),
                submitError && (React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertDescription, null, submitError))),
                React.createElement("div", null,
                    React.createElement(Button, { type: "button", onClick: () => void submit(), disabled: submitting ||
                            !eaName ||
                            !principalInput.trim() ||
                            !principalTenantId.trim(), loading: submitting },
                        !submitting && React.createElement(UserPlus, null),
                        "Grant EA Subscription Creator"))))),
        lastGrant && (React.createElement(Card, { className: "border-success/40 bg-success/5" },
            React.createElement(CardHeader, { className: "pb-2" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Sparkles, { className: "h-4 w-4 text-success" }),
                    "Grant succeeded \u2014 next step"),
                React.createElement(CardDescription, { className: "text-xs" },
                    React.createElement("code", { className: "font-mono" }, lastGrant.principal),
                    " now has EA Subscription Creator on enrollment account",
                    " ",
                    React.createElement("code", { className: "font-mono" }, lastGrant.enrollmentAccountName),
                    ". Note: EA role propagation can take up to 5 minutes after a fresh token is issued \u2014 if Create still 401s on EA Sub Quick, wait briefly and click \"Re-acquire token\" there.")),
            React.createElement(CardContent, null,
                React.createElement(Button, { type: "button", variant: "default", size: "sm", className: "h-8 text-xs", onClick: () => {
                        // Pre-seed EA Sub Quick's sessionStorage so the BA /
                        // EA / account picker is restored on mount. Best-
                        // effort — falls through silently if storage is
                        // unavailable (private browsing).
                        try {
                            sessionStorage.setItem("ea-sub-quick:account", lastGrant.homeAccountId);
                            sessionStorage.setItem("ea-sub-quick:billing-account", lastGrant.billingAccountName);
                            sessionStorage.setItem("ea-sub-quick:enrollment-account", lastGrant.enrollmentAccountName);
                        }
                        catch (_a) {
                            /* ignore */
                        }
                        // Path-based navigation (page-router contract). Falls back
                        // to a no-op if the outlet didn't provide a navigator —
                        // sessionStorage was still seeded so a manual sidebar nav
                        // works too.
                        navigateToPage === null || navigateToPage === void 0 ? void 0 : navigateToPage("/ea-sub-quick");
                    }, "aria-label": "Retry creating EA subscription on EA Sub Quick" },
                    React.createElement(Sparkles, { className: "h-3.5 w-3.5" }),
                    "Retry creating EA Sub now")))),
        recentGrants.length > 0 && billingAccountName && (React.createElement(Card, null,
            React.createElement(CardHeader, { className: "pb-2" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(UserPlus, { className: "h-4 w-4 text-primary" }),
                    "Recent grants this session",
                    React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, recentGrants.length)),
                React.createElement(CardDescription, { className: "text-xs" }, "Newest first, kept in memory only (cleared on refresh). Full mutation history is in the Audit Log page.")),
            React.createElement(CardContent, null,
                React.createElement("ul", { className: "flex flex-col gap-1" }, recentGrants.map((g) => (React.createElement("li", { key: `${g.principal}-${g.enrollmentAccountName}-${g.grantedAt}`, className: "flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs" },
                    React.createElement(UserPlus, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                    React.createElement("span", { className: "flex min-w-0 flex-1 flex-col" },
                        React.createElement("span", { className: "font-mono" }, g.principal),
                        React.createElement("span", { className: "text-2xs text-muted-foreground" },
                            "EA: ",
                            g.enrollmentAccountName,
                            " \u00B7",
                            " ",
                            new Date(g.grantedAt).toLocaleTimeString())),
                    React.createElement(CopyableText, { value: g.roleAssignmentId, mono: true, ariaLabel: "Copy role assignment id", className: "text-2xs text-muted-foreground" }))))),
                React.createElement("div", { className: "mt-2 flex justify-end" },
                    React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: () => setRecentGrants([]) },
                        React.createElement(X, { className: "h-3 w-3" }),
                        "Clear history")))))));
};
//# sourceMappingURL=sub-manager-page.js.map