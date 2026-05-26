import { __awaiter } from "tslib";
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
// COORDINATOR: this page uses react-router's `useNavigate` directly,
// matching the dominant pattern across the multi-region pages (overview,
// gpu-calculator, pool-info, etc.). The canonical wiring contract prefers
// `useDashboardOutletContext().navigateToPage`, which is a thin wrapper
// over the same hook. If the contract migrates to mandate the wrapper,
// swap this import + every `navigate(...)` call site below in one pass
// across all pages — do not touch only this file.
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, ArrowUpDown, BadgeCheck, Bot, Building2, Camera, Crown, ExternalLink, GitCompareArrows, HelpCircle, Layers, Loader2, PlusCircle, RefreshCw, Server, ShieldAlert, Sparkles, Trash2, UserCheck, Users, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { getArmTokenForAccount } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { listDepartmentBillingSubscriptions, listDepartmentEnrollmentAccounts, listEaBillingAccounts, listEaDepartments, } from "../../services";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { clearBaselineSnapshot, computeBaselineDrift, driftCount, eaOwnersThatLookLikeSps, inferCloudFromToken, looksLikeServicePrincipal, portalEnrollmentAccountLink, readBaselineSnapshot, writeBaselineSnapshot, } from "./department-admin-helpers";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText, CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { FilterChipRow } from "../shared/filter-chip-row";
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
};
const STATUS_NORMALIZED = {
    active: "active",
    enabled: "active",
    warned: "inactive",
    inactive: "inactive",
    disabled: "inactive",
    deleted: "inactive",
    expired: "inactive",
};
function normalizeStatus(s) {
    var _a;
    if (!s)
        return "active";
    return (_a = STATUS_NORMALIZED[s.toLowerCase()]) !== null && _a !== void 0 ? _a : "active";
}
// Window for the "added recently" smart filter — keep this in sync with
// the chip label below. Seven calendar days matches the corresponding
// review cadence in the EA Billing Manager page.
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Returns true when `startDate` (ISO-8601, as returned by the EA billing
 * REST API) is within the last RECENT_WINDOW_MS. Invalid / missing values
 * are conservatively treated as NOT recent — we'd rather under-flag than
 * mislead an operator into thinking an old EA was newly added.
 */
function isRecentlyAdded(startDate, nowMs) {
    if (!startDate)
        return false;
    const ts = Date.parse(startDate);
    if (Number.isNaN(ts))
        return false;
    return nowMs - ts <= RECENT_WINDOW_MS && ts <= nowMs;
}
export const DepartmentAdminPage = () => {
    var _a, _b, _c, _d, _e;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const navigate = useNavigate();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    /* ----- Source account picker ------------------------------------ */
    const candidates = React.useMemo(() => azureAccounts
        .map((a) => {
        var _a;
        return ({
            homeAccountId: a.homeAccountId,
            tenantId: (_a = resolveActiveTenantId(a)) !== null && _a !== void 0 ? _a : a.tenantId,
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
        if (candidates.length > 0 &&
            !candidates.some((c) => c.homeAccountId === accountId)) {
            setAccountId(candidates[0].homeAccountId);
        }
    }, [candidates, accountId, setAccountId]);
    const account = React.useMemo(() => { var _a; return (_a = candidates.find((c) => c.homeAccountId === accountId)) !== null && _a !== void 0 ? _a : null; }, [candidates, accountId]);
    /**
     * Central ARM-token tracker. Powers the TokenExpiryBadge and auto
     * re-acquires on tenant switch / 60s pre-expiry. Wired in PARALLEL
     * to the existing `getArmTokenForAccount` fetch so the existing
     * billing-account + department + enrollment-account effects keep
     * working unchanged; a bridge effect below syncs the freshly-minted
     * token down to the local `armToken` state so downstream consumers
     * (billing accounts, departments, EAs, subs) pick it up.
     */
    const armTokenTracker = useArmToken(account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId);
    /* ----- ARM token + EA billing accounts -------------------------- */
    const [armToken, setArmToken] = React.useState(null);
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
        if (armTokenTracker.token === null &&
            !armTokenTracker.loading &&
            armToken !== null) {
            setArmToken(null);
        }
    }, [armTokenTracker.token, armTokenTracker.loading, armToken]);
    const [billingAccounts, setBillingAccounts] = React.useState([]);
    const [baLoading, setBaLoading] = React.useState(false);
    const [baError, setBaError] = React.useState(null);
    const [billingAccountName, setBaNameState] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_BA)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    const setBillingAccountName = React.useCallback((n) => {
        setBaNameState(n);
        try {
            sessionStorage.setItem(STORAGE_BA, n);
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
    /* ----- Departments under billing account ----------------------- */
    const [depts, setDepts] = React.useState([]);
    const [deptsLoading, setDeptsLoading] = React.useState(false);
    const [deptsError, setDeptsError] = React.useState(null);
    const [departmentName, setDepartmentNameState] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_DEPT)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    const setDepartmentName = React.useCallback((n) => {
        setDepartmentNameState(n);
        try {
            sessionStorage.setItem(STORAGE_DEPT, n);
        }
        catch (_a) {
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
            if (cancelled || seq !== deptsReqSeqRef.current)
                return;
            setDepts(d);
            // Auto-pick when only one department is visible (common for
            // department admins scoped to their own dept).
            if (d.length === 1 && departmentName !== d[0].name) {
                setDepartmentName(d[0].name);
            }
            else if (departmentName &&
                !d.some((x) => x.name === departmentName)) {
                setDepartmentName("");
            }
        })
            .catch((err) => {
            if (cancelled || seq !== deptsReqSeqRef.current)
                return;
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
    const selectedDept = React.useMemo(() => { var _a; return (_a = depts.find((d) => d.name === departmentName)) !== null && _a !== void 0 ? _a : null; }, [depts, departmentName]);
    // Audit a department selection (separate from the list calls below so a
    // pivot+return doesn't fire a redundant "switch" event). We only record
    // when the picked dept actually changes within the current BA scope.
    const lastAuditedDeptRef = React.useRef("");
    const actorUsernameForDeptSelect = (_b = account === null || account === void 0 ? void 0 : account.username) !== null && _b !== void 0 ? _b : "anonymous";
    React.useEffect(() => {
        var _a;
        if (!billingAccountName || !departmentName)
            return;
        const key = `${billingAccountName}::${departmentName}`;
        if (lastAuditedDeptRef.current === key)
            return;
        lastAuditedDeptRef.current = key;
        auditLog.record({
            actor: actorUsernameForDeptSelect,
            action: "select_department_scope",
            target: `ba:${billingAccountName} dept:${departmentName}`,
            status: "success",
            details: {
                billingAccountName,
                departmentName,
                departmentDisplayName: (_a = selectedDept === null || selectedDept === void 0 ? void 0 : selectedDept.departmentName) !== null && _a !== void 0 ? _a : null,
            },
        });
    }, [
        billingAccountName,
        departmentName,
        selectedDept === null || selectedDept === void 0 ? void 0 : selectedDept.departmentName,
        actorUsernameForDeptSelect,
    ]);
    /* ----- Enrollment accounts in the chosen department ------------ */
    const [eas, setEas] = React.useState([]);
    const [eaLoading, setEaLoading] = React.useState(false);
    const [eaError, setEaError] = React.useState(null);
    const [reloadTick, setReloadTick] = React.useState(0);
    // Sequence guard: each scope change increments, late responses ignored.
    const eaReqSeqRef = React.useRef(0);
    const actorUsername = (_c = account === null || account === void 0 ? void 0 : account.username) !== null && _c !== void 0 ? _c : "anonymous";
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
        listDepartmentEnrollmentAccounts(billingAccountName, departmentName, armToken)
            .then((list) => {
            if (cancelled || seq !== eaReqSeqRef.current)
                return;
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
            .catch((err) => {
            if (cancelled || seq !== eaReqSeqRef.current)
                return;
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
            if (!cancelled && seq === eaReqSeqRef.current)
                setEaLoading(false);
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
    const [allSubs, setAllSubs] = React.useState([]);
    const [subsLoading, setSubsLoading] = React.useState(false);
    const [subsError, setSubsError] = React.useState(null);
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
        listDepartmentBillingSubscriptions(billingAccountName, departmentName, armToken)
            .then((list) => {
            if (cancelled || seq !== subsReqSeqRef.current)
                return;
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
            .catch((err) => {
            if (cancelled || seq !== subsReqSeqRef.current)
                return;
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
            if (!cancelled && seq === subsReqSeqRef.current)
                setSubsLoading(false);
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
    const { grouped: subsByEaDisplayName, orphaned: orphanedSubs } = React.useMemo(() => {
        var _a;
        const known = new Set(eas.map((e) => e.displayName));
        const m = new Map();
        const orphans = [];
        for (const s of allSubs) {
            const key = (_a = s.invoiceSectionDisplayName) !== null && _a !== void 0 ? _a : "";
            if (!key || !known.has(key)) {
                orphans.push(s);
                continue;
            }
            if (!m.has(key))
                m.set(key, []);
            m.get(key).push(s);
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
    const [pendingPivot, setPendingPivot] = React.useState(null);
    const requestCreateSubscription = React.useCallback((ea) => {
        setPendingPivot({ kind: "create-subscription", ea });
    }, []);
    const requestGrantCreator = React.useCallback(() => {
        setPendingPivot({ kind: "grant-creator" });
    }, []);
    const confirmPivot = React.useCallback(() => {
        var _a;
        if (!pendingPivot)
            return;
        if (pendingPivot.kind === "create-subscription") {
            const ea = pendingPivot.ea;
            let sessionStorageOk = true;
            try {
                sessionStorage.setItem(PIVOT_KEYS.EA_ACTIVE_ACCOUNT, (_a = account === null || account === void 0 ? void 0 : account.homeAccountId) !== null && _a !== void 0 ? _a : "");
                sessionStorage.setItem(PIVOT_KEYS.EA_PRESELECT_BA, billingAccountName);
                sessionStorage.setItem(PIVOT_KEYS.EA_PRESELECT_EA, ea.name);
            }
            catch (err) {
                sessionStorageOk = false;
                // sessionStorage can be disabled (privacy mode / quota) — surface
                // it so the user knows the pre-select hint may not stick.
                // eslint-disable-next-line no-console
                console.warn("[department-admin] sessionStorage write failed; EA Subscription page will not pre-fill", err);
                showToast(store, "Couldn't persist pre-fill — you'll need to pick the billing/enrollment account again on the next page.", "warning");
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
            }
            catch (_b) {
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
        account === null || account === void 0 ? void 0 : account.homeAccountId,
        actorUsername,
        billingAccountName,
        departmentName,
        navigate,
        store,
    ]);
    const cancelPivot = React.useCallback(() => setPendingPivot(null), []);
    /* ----- Filters & sort ------------------------------------------
     * All filter/view state lives in the URL so a department admin can
     * bookmark or share a filtered view (e.g. "all idle EAs sorted by
     * subscription count"). The hook is initialised with the same
     * defaults the page used to hard-code in useState — behaviour is
     * unchanged for any deep link that omits the params.
     */
    const [urlFilters, setUrlFilters] = useUrlState({
        eaSearch: "",
        eaStatus: "all",
        eaSort: "name",
        eaRecency: "any",
        subsSearch: "",
        subsStatus: "all",
        subsView: "grouped",
    });
    const search = (_d = urlFilters.eaSearch) !== null && _d !== void 0 ? _d : "";
    const setSearch = React.useCallback((v) => setUrlFilters({ eaSearch: v }), [setUrlFilters]);
    const eaStatusFilter = urlFilters.eaStatus || "all";
    const setEaStatusFilter = React.useCallback((v) => setUrlFilters({ eaStatus: v }), [setUrlFilters]);
    const eaSortKey = urlFilters.eaSort || "name";
    const setEaSortKey = React.useCallback((v) => setUrlFilters({ eaSort: v }), [setUrlFilters]);
    const eaRecencyFilter = urlFilters.eaRecency || "any";
    const setEaRecencyFilter = React.useCallback((v) => setUrlFilters({ eaRecency: v }), [setUrlFilters]);
    const subsSearch = (_e = urlFilters.subsSearch) !== null && _e !== void 0 ? _e : "";
    const setSubsSearch = React.useCallback((v) => setUrlFilters({ subsSearch: v }), [setUrlFilters]);
    const subsStatusFilter = urlFilters.subsStatus || "all";
    const setSubsStatusFilter = React.useCallback((v) => setUrlFilters({ subsStatus: v }), [setUrlFilters]);
    const subsViewMode = urlFilters.subsView || "grouped";
    const setSubsViewMode = React.useCallback((v) => setUrlFilters({ subsView: v }), [setUrlFilters]);
    // "Now" snapshot used by the recency filter. Frozen per-render so
    // sorting and filtering stay stable inside the same render pass. The
    // 60s tick keeps the chip's counter fresh enough without forcing a
    // re-render on every keystroke.
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    React.useEffect(() => {
        const id = window.setInterval(() => setNowMs(Date.now()), 60000);
        return () => window.clearInterval(id);
    }, []);
    // Distinct status values across the dept's subs — drives the status
    // dropdown so we don't have to hardcode the Azure billing taxonomy.
    const subsStatusValues = React.useMemo(() => {
        const set = new Set();
        for (const s of allSubs) {
            if (s.status)
                set.add(s.status);
        }
        return Array.from(set).sort();
    }, [allSubs]);
    // Pre-compute the recent set once per (eas, nowMs) so the filter memo
    // doesn't have to re-call Date.parse for every EA on every keystroke.
    const recentlyAddedEaIds = React.useMemo(() => {
        const ids = new Set();
        for (const e of eas) {
            if (isRecentlyAdded(e.startDate, nowMs))
                ids.add(e.id);
        }
        return ids;
    }, [eas, nowMs]);
    /* ----- Corpus-grounded detections ------------------------------- *
     * (a) SP-shaped enrollment-account owners. Cite
     *     `_ea_subscription_cross_tenant.md` §"Granting subscription-
     *     creator across tenants" — automation SPs in EA owner positions
     *     are the same primitive used to mint subs cross-tenant. Surface
     *     them so the dept admin can challenge unfamiliar entries at
     *     audit time. Heuristic-only (we can't query the directory from
     *     a billing-plane token), so false-positives are intentional —
     *     better to over-flag.
     *
     * (b) Cloud-environment inference from the current ARM token's
     *     `iss` claim. Drives cloud-correct portal deep-links per row.
     *     Mapping comes from `_bypass_tenant_switch.md` §8.1 endpoint
     *     catalog. Recomputed when the token rolls.
     */
    const spOwnerEas = React.useMemo(() => eaOwnersThatLookLikeSps(eas), [eas]);
    const spOwnerEaIds = React.useMemo(() => new Set(spOwnerEas.map((e) => e.id)), [spOwnerEas]);
    const cloudInfo = React.useMemo(() => inferCloudFromToken(armToken), [armToken]);
    /* ----- Baseline-drift snapshot (compliance evidence) ------------ *
     * Persisted in localStorage, keyed by `(billingAccount, department)`.
     * Auto-load on scope change. The drift compared against the live EA
     * list is recomputed every time `eas` updates.
     */
    const [baseline, setBaseline] = React.useState(null);
    React.useEffect(() => {
        if (!billingAccountName || !departmentName) {
            setBaseline(null);
            return;
        }
        setBaseline(readBaselineSnapshot(billingAccountName, departmentName));
    }, [billingAccountName, departmentName]);
    const drift = React.useMemo(() => computeBaselineDrift(baseline, eas), [baseline, eas]);
    const totalDrift = driftCount(drift);
    const handleSaveBaseline = React.useCallback(() => {
        if (!billingAccountName || !departmentName)
            return;
        const next = writeBaselineSnapshot(billingAccountName, departmentName, actorUsername, eas);
        setBaseline(next);
        auditLog.record({
            actor: actorUsername,
            action: "save_department_baseline",
            target: `ba:${billingAccountName} dept:${departmentName}`,
            status: "success",
            details: {
                billingAccountName,
                departmentName,
                memberCount: next.members.length,
                takenAt: next.takenAt,
            },
        });
        showToast(store, `Saved baseline (${next.members.length} EA${next.members.length === 1 ? "" : "s"}). Drift will be tracked against this snapshot.`, "success");
    }, [actorUsername, billingAccountName, departmentName, eas, store]);
    const handleClearBaseline = React.useCallback(() => {
        if (!billingAccountName || !departmentName)
            return;
        clearBaselineSnapshot(billingAccountName, departmentName);
        setBaseline(null);
        auditLog.record({
            actor: actorUsername,
            action: "clear_department_baseline",
            target: `ba:${billingAccountName} dept:${departmentName}`,
            status: "success",
            details: { billingAccountName, departmentName },
        });
        showToast(store, "Cleared baseline snapshot.", "info");
    }, [actorUsername, billingAccountName, departmentName, store]);
    const filteredEas = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        const filtered = eas.filter((e) => {
            var _a, _b, _c;
            if (eaStatusFilter !== "all") {
                if (normalizeStatus(e.status) !== eaStatusFilter)
                    return false;
            }
            if (eaRecencyFilter === "last7" && !recentlyAddedEaIds.has(e.id)) {
                return false;
            }
            if (!q)
                return true;
            // Smart-search: name + display name + owner + cost center + any
            // subscription id grouped under this EA. The sub-id branch lets an
            // operator paste a subscription GUID and surface its owning EA
            // without leaving the page.
            const subIds = ((_a = subsByEaDisplayName.get(e.displayName)) !== null && _a !== void 0 ? _a : [])
                .map((s) => { var _a; return (_a = s.subscriptionId) !== null && _a !== void 0 ? _a : ""; })
                .join(" ");
            return [
                e.displayName,
                e.name,
                (_b = e.accountOwner) !== null && _b !== void 0 ? _b : "",
                (_c = e.costCenter) !== null && _c !== void 0 ? _c : "",
                subIds,
            ]
                .join(" ")
                .toLowerCase()
                .includes(q);
        });
        // Sort
        const sorted = [...filtered];
        switch (eaSortKey) {
            case "subs":
                sorted.sort((a, b) => {
                    var _a, _b, _c, _d;
                    return ((_b = (_a = subsByEaDisplayName.get(b.displayName)) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) -
                        ((_d = (_c = subsByEaDisplayName.get(a.displayName)) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0);
                });
                break;
            case "status":
                sorted.sort((a, b) => { var _a, _b; return ((_a = a.status) !== null && _a !== void 0 ? _a : "").localeCompare((_b = b.status) !== null && _b !== void 0 ? _b : ""); });
                break;
            case "owner":
                sorted.sort((a, b) => { var _a, _b; return ((_a = a.accountOwner) !== null && _a !== void 0 ? _a : "").localeCompare((_b = b.accountOwner) !== null && _b !== void 0 ? _b : ""); });
                break;
            case "name":
            default:
                sorted.sort((a, b) => a.displayName.localeCompare(b.displayName));
                break;
        }
        return sorted;
    }, [
        eas,
        search,
        eaStatusFilter,
        eaSortKey,
        eaRecencyFilter,
        recentlyAddedEaIds,
        subsByEaDisplayName,
    ]);
    const filteredSubs = React.useMemo(() => {
        const q = subsSearch.trim().toLowerCase();
        return allSubs.filter((s) => {
            var _a, _b, _c, _d, _e;
            if (subsStatusFilter !== "all" && ((_a = s.status) !== null && _a !== void 0 ? _a : "") !== subsStatusFilter) {
                return false;
            }
            if (!q)
                return true;
            return [
                s.displayName,
                (_b = s.subscriptionId) !== null && _b !== void 0 ? _b : "",
                (_c = s.status) !== null && _c !== void 0 ? _c : "",
                (_d = s.invoiceSectionDisplayName) !== null && _d !== void 0 ? _d : "",
                (_e = s.costCenter) !== null && _e !== void 0 ? _e : "",
            ]
                .join(" ")
                .toLowerCase()
                .includes(q);
        });
    }, [allSubs, subsSearch, subsStatusFilter]);
    // Expanded / collapsed state per EA in the per-EA view. Default: all
    // collapsed when there are >5 EAs so the list stays scannable; below
    // that we keep everything expanded for instant overview.
    const [expandedEas, setExpandedEas] = React.useState(() => new Set());
    // Whenever the EA list changes, default expansion: expand all when ≤5,
    // collapse all otherwise. Operator's individual toggles persist within
    // the same EA set.
    React.useEffect(() => {
        setExpandedEas((prev) => {
            if (eas.length <= 5)
                return new Set(eas.map((e) => e.id));
            // Preserve any expansions the operator already made; otherwise
            // start collapsed.
            const next = new Set();
            for (const e of eas)
                if (prev.has(e.id))
                    next.add(e.id);
            return next;
        });
    }, [eas]);
    const toggleEa = React.useCallback((id) => {
        setExpandedEas((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    const setAllExpansion = React.useCallback((expand) => {
        setExpandedEas(expand ? new Set(eas.map((e) => e.id)) : new Set());
    }, [eas]);
    /* ----- Quick stats --------------------------------------------- */
    const activeSubsCount = React.useMemo(() => allSubs.filter((s) => {
        var _a, _b;
        return ((_a = s.status) !== null && _a !== void 0 ? _a : "").toLowerCase() === "active" ||
            ((_b = s.status) !== null && _b !== void 0 ? _b : "").toLowerCase() === "enabled";
    }).length, [allSubs]);
    // EAs that have at least one sub — coverage metric.
    const eaWithSubsCount = React.useMemo(() => eas.filter((e) => { var _a, _b; return ((_b = (_a = subsByEaDisplayName.get(e.displayName)) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) > 0; }).length, [eas, subsByEaDisplayName]);
    const eaWithoutSubsCount = eas.length - eaWithSubsCount;
    /* ----- Copy-all-IDs helpers ------------------------------------ */
    const copyAllEaIds = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (filteredEas.length === 0)
            return;
        const text = filteredEas
            .map((e) => `${e.name}\t${e.displayName}`)
            .join("\n");
        try {
            yield navigator.clipboard.writeText(text);
            showToast(store, `Copied ${filteredEas.length} enrollment account id${filteredEas.length === 1 ? "" : "s"} to clipboard`, "success");
        }
        catch (_f) {
            showToast(store, "Couldn't write to clipboard", "error");
        }
    }), [filteredEas, store]);
    const copyAllSubIds = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        const subs = filteredSubs.filter((s) => !!s.subscriptionId);
        if (subs.length === 0)
            return;
        const text = subs
            .map((s) => `${s.subscriptionId}\t${s.displayName}`)
            .join("\n");
        try {
            yield navigator.clipboard.writeText(text);
            showToast(store, `Copied ${subs.length} subscription id${subs.length === 1 ? "" : "s"} to clipboard`, "success");
        }
        catch (_g) {
            showToast(store, "Couldn't write to clipboard", "error");
        }
    }), [filteredSubs, store]);
    /* ----- Export column descriptors ------------------------------- */
    const eaExportColumns = React.useMemo(() => [
        { header: "Display name", accessor: (e) => e.displayName },
        { header: "Name (id)", accessor: (e) => e.name },
        { header: "Status", accessor: (e) => { var _a; return (_a = e.status) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Account owner", accessor: (e) => { var _a; return (_a = e.accountOwner) !== null && _a !== void 0 ? _a : ""; } },
        {
            // Compliance evidence: surfaces the SP-shaped-owner heuristic in
            // exported CSV/JSON so a reviewer can sort/filter on it without
            // re-running the page.
            header: "Owner is SP-shaped",
            accessor: (e) => looksLikeServicePrincipal(e.accountOwner) ? "yes" : "no",
        },
        { header: "Cost center", accessor: (e) => { var _a; return (_a = e.costCenter) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Start date", accessor: (e) => { var _a; return (_a = e.startDate) !== null && _a !== void 0 ? _a : ""; } },
        { header: "End date", accessor: (e) => { var _a; return (_a = e.endDate) !== null && _a !== void 0 ? _a : ""; } },
        {
            header: "Sub count",
            accessor: (e) => { var _a, _b; return (_b = (_a = subsByEaDisplayName.get(e.displayName)) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0; },
        },
        { header: "ARM id", accessor: (e) => e.id },
    ], [subsByEaDisplayName]);
    const subExportColumns = React.useMemo(() => [
        { header: "Display name", accessor: (s) => s.displayName },
        { header: "Subscription ID", accessor: (s) => { var _a; return (_a = s.subscriptionId) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Status", accessor: (s) => { var _a; return (_a = s.status) !== null && _a !== void 0 ? _a : ""; } },
        {
            header: "Enrollment account",
            accessor: (s) => { var _a; return (_a = s.invoiceSectionDisplayName) !== null && _a !== void 0 ? _a : ""; },
        },
        { header: "Cost center", accessor: (s) => { var _a; return (_a = s.costCenter) !== null && _a !== void 0 ? _a : ""; } },
        { header: "SKU", accessor: (s) => { var _a; return (_a = s.skuId) !== null && _a !== void 0 ? _a : ""; } },
        { header: "ARM id", accessor: (s) => s.id },
    ], []);
    /* ----- Global tenant-switch sync -------------------------------- *
     * Mirrors the canonical pattern from invite-user-page: when another
     * page (or a background event) switches the active tenant for one of
     * our signed-in accounts, snap this page's source-account picker to
     * that account so the cascading BA → dept → EA fetches re-issue
     * against the freshly-active tenant instead of stale tokens.
     */
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!candidates.some((c) => c.homeAccountId === candidate))
            return;
        if (accountId === candidate)
            return;
        setAccountIdState(candidate);
        try {
            sessionStorage.setItem(PIVOT_KEYS.EA_ACTIVE_ACCOUNT, candidate);
        }
        catch (_a) {
            /* ignore */
        }
    });
    /* ----- Render --------------------------------------------------- */
    if (candidates.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "Department Admin", description: "EA Department Admin workspace \u2014 view enrollment accounts and billing subs in your department, then create new subs under any of them." }),
            React.createElement(EmptyState, { icon: Crown, title: "No Azure account signed in", description: "Sign in with an EA-billing-capable account first." })));
    }
    // Friendly summary for the pivot dialog.
    const renderPivotDialogMessage = () => {
        var _a, _b;
        if (!pendingPivot)
            return "";
        if (pendingPivot.kind === "create-subscription") {
            const ea = pendingPivot.ea;
            return (React.createElement("div", { className: "flex flex-col gap-2 text-xs" },
                React.createElement("p", { className: "m-0" },
                    "Pivot to the ",
                    React.createElement("strong", null, "EA Subscription"),
                    " page with the following pre-fill:"),
                React.createElement("ul", { className: "m-0 flex flex-col gap-1 pl-4" },
                    React.createElement("li", null,
                        React.createElement("span", { className: "text-muted-foreground" }, "Account:"),
                        " ", (_a = account === null || account === void 0 ? void 0 : account.name) !== null && _a !== void 0 ? _a : "—"),
                    React.createElement("li", null,
                        React.createElement("span", { className: "text-muted-foreground" }, "Billing account:"),
                        " ",
                        React.createElement("span", { className: "font-mono text-2xs" }, billingAccountName)),
                    React.createElement("li", null,
                        React.createElement("span", { className: "text-muted-foreground" }, "Enrollment account:"),
                        " ",
                        React.createElement("strong", null, ea.displayName),
                        " ",
                        React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                            "(",
                            ea.name,
                            ")"))),
                React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" }, "No subscription is created yet \u2014 the next page collects the display name, SKU, and (optionally) cross-tenant owner before you submit.")));
        }
        if (pendingPivot.kind === "grant-creator") {
            return (React.createElement("div", { className: "flex flex-col gap-2 text-xs" },
                React.createElement("p", { className: "m-0" },
                    "Pivot to ",
                    React.createElement("strong", null, "Sub Manager"),
                    " with the",
                    " ",
                    React.createElement("em", null, "Grant subscription creator"),
                    " tab open and this billing account pre-selected:"),
                React.createElement("ul", { className: "m-0 flex flex-col gap-1 pl-4" },
                    React.createElement("li", null,
                        React.createElement("span", { className: "text-muted-foreground" }, "Billing account:"),
                        " ",
                        React.createElement("span", { className: "font-mono text-2xs" }, billingAccountName)),
                    React.createElement("li", null,
                        React.createElement("span", { className: "text-muted-foreground" }, "Department context:"),
                        " ", (_b = selectedDept === null || selectedDept === void 0 ? void 0 : selectedDept.departmentName) !== null && _b !== void 0 ? _b : "—")),
                React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" }, "The grant itself is created on the Sub Manager page \u2014 you'll pick the principal there. This page only carries the billing-account context forward.")));
        }
        return "";
    };
    return (React.createElement("div", { className: "flex flex-col gap-4 py-2" },
        React.createElement(ConfirmationDialog, { hidden: !pendingPivot, title: (pendingPivot === null || pendingPivot === void 0 ? void 0 : pendingPivot.kind) === "create-subscription"
                ? "Create subscription under this enrollment account?"
                : (pendingPivot === null || pendingPivot === void 0 ? void 0 : pendingPivot.kind) === "grant-creator"
                    ? "Grant subscription-creator on this billing account?"
                    : "", message: renderPivotDialogMessage(), confirmText: (pendingPivot === null || pendingPivot === void 0 ? void 0 : pendingPivot.kind) === "create-subscription"
                ? "Continue to EA Subscription"
                : "Continue to Sub Manager", cancelText: "Stay here", onConfirm: confirmPivot, onCancel: cancelPivot }),
        React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
            React.createElement(PageHeader, { title: "Department Admin", description: "EA Department Admin workspace \u2014 view enrollment accounts and billing subs in your department, then create new subs under any of them." },
                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setReloadTick((n) => n + 1), disabled: !departmentName || eaLoading || subsLoading, "aria-label": "Refresh enrollment accounts and subscriptions", loading: eaLoading || subsLoading },
                    !(eaLoading || subsLoading) && (React.createElement(RefreshCw, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                    "Refresh")),
            cloudInfo.env !== "AzureCommercial" && armToken && (React.createElement(Badge, { variant: "outline", className: "text-2xs border-warning text-warning inline-flex items-center gap-1", title: `Portal deep-links target ${cloudInfo.portalHost} (derived from token issuer)`, "aria-label": `Cloud environment: ${cloudInfo.label}` },
                React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                cloudInfo.label)),
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                    loginHint: account === null || account === void 0 ? void 0 : account.username,
                }) })),
        React.createElement(Card, null,
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Crown, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                    "Scope",
                    React.createElement(InfoTooltip, { variant: "help", content: React.createElement("span", { className: "block max-w-xs text-2xs" },
                            "A ",
                            React.createElement("strong", null, "Department Admin"),
                            " can read enrollment accounts and billing subscriptions inside a single EA department. Department scope is narrower than the EA billing-account scope used by EA Admin / EA Purchase, so this page uses the narrower",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "/departments/.../*"),
                            " ",
                            "endpoints to avoid the 403 your role would get on the wider ones."), ariaLabel: "What is a Department admin?" })),
                React.createElement(CardDescription, null, "Pick the signed-in account, the EA billing account, and the department you administer. Selection is remembered for this session.")),
            React.createElement(CardContent, { className: "grid grid-cols-1 gap-3 sm:grid-cols-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Source account"),
                    React.createElement(Select, { value: accountId, onValueChange: setAccountId },
                        React.createElement(SelectTrigger, { "aria-label": "Source account" },
                            React.createElement(SelectValue, { placeholder: "Pick an account" })),
                        React.createElement(SelectContent, null, candidates.map((c) => (React.createElement(SelectItem, { key: c.homeAccountId, value: c.homeAccountId },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, c.name),
                                React.createElement("span", { className: "text-2xs text-muted-foreground" }, c.username)))))))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Billing account"),
                    baLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                        React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none", "aria-hidden": true }),
                        "loading")) : baError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load billing accounts.", detail: baError })) : billingAccounts.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No EA billing accounts visible.")) : (React.createElement(Select, { value: billingAccountName, onValueChange: setBillingAccountName },
                        React.createElement(SelectTrigger, { "aria-label": "Billing account" },
                            React.createElement(SelectValue, { placeholder: "Pick a billing account" })),
                        React.createElement(SelectContent, null, billingAccounts.map((b) => (React.createElement(SelectItem, { key: b.name, value: b.name },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, b.displayName),
                                React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                                    b.name,
                                    " \u00B7 ",
                                    b.agreementType))))))))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Department"),
                    deptsLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                        React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none", "aria-hidden": true }),
                        "loading")) : deptsError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load departments.", detail: deptsError, onRetry: () => setReloadTick((n) => n + 1) })) : depts.length === 0 ? (React.createElement(EmptyState, { icon: Layers, title: "No departments visible", description: "Your sign-in lacks EA department visibility on this billing account.", size: "compact" })) : (React.createElement(Select, { value: departmentName, onValueChange: setDepartmentName },
                        React.createElement(SelectTrigger, { "aria-label": "Department" },
                            React.createElement(SelectValue, { placeholder: "Pick a department" })),
                        React.createElement(SelectContent, null, depts.map((d) => (React.createElement(SelectItem, { key: d.name, value: d.name },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, d.departmentName),
                                React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                                    d.name,
                                    d.costCenter ? ` · CC ${d.costCenter}` : "",
                                    typeof d.enrollmentAccounts === "number"
                                        ? ` · ${d.enrollmentAccounts} EA${d.enrollmentAccounts === 1 ? "" : "s"}`
                                        : ""))))))))))),
        !departmentName ? (React.createElement(EmptyState, { icon: Layers, title: "Pick a department", description: "Once selected, every enrollment account under that department appears below with its billing subs and a Create-subscription action." })) : (React.createElement(React.Fragment, null,
            selectedDept && (React.createElement(Card, null,
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(Layers, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                        selectedDept.departmentName,
                        React.createElement(InfoTooltip, { variant: "help", content: React.createElement("span", { className: "block max-w-xs text-2xs" },
                                React.createElement("strong", null, "Department scope:"),
                                " all enrollment accounts, billing subscriptions, and cost roll-ups belong to this department. Subscription-creator grants made here apply only inside the department."), ariaLabel: "What is the department scope?" })),
                    React.createElement(CardDescription, null, "Department resource scope (EA).")),
                React.createElement(CardContent, { className: "flex flex-col gap-3 text-xs" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-x-4 gap-y-2" },
                        React.createElement("div", { className: "flex items-center gap-1" },
                            React.createElement("span", { className: "text-muted-foreground" }, "Name:"),
                            React.createElement(CopyableText, { value: selectedDept.name, mono: true, ariaLabel: `Copy department id ${selectedDept.name}` })),
                        selectedDept.costCenter && (React.createElement("div", { className: "flex items-center gap-1" },
                            React.createElement("span", { className: "text-muted-foreground" }, "Cost center:"),
                            React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, selectedDept.costCenter))),
                        selectedDept.status && (React.createElement("div", { className: "flex items-center gap-1" },
                            React.createElement("span", { className: "text-muted-foreground" }, "Status:"),
                            React.createElement(Badge, { variant: "outline", className: "text-2xs" }, selectedDept.status))),
                        React.createElement("div", { className: "flex items-center gap-1" },
                            React.createElement("span", { className: "text-muted-foreground" }, "ARM id:"),
                            React.createElement("span", { className: "group/copy inline-flex items-center gap-1.5 align-middle" },
                                React.createElement("span", { className: "font-mono text-2xs text-muted-foreground max-w-[28ch] truncate" }, selectedDept.id),
                                React.createElement(CopyButton, { value: selectedDept.id, ariaLabel: "Copy department ARM resource id" }))),
                        React.createElement("div", { className: "ml-auto flex items-center gap-2" },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: requestGrantCreator, "aria-label": "Grant subscription-creator role inside this department" },
                                React.createElement(UserCheck, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                " Grant Sub Creator"))),
                    React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Department quick stats" },
                        React.createElement(SummaryStatItem, { label: "Enrollment accts", value: eaLoading ? "…" : eas.length, compact: true }),
                        React.createElement(SummaryStatItem, { label: "EAs w/ subs", value: eaLoading || subsLoading ? "…" : eaWithSubsCount, compact: true, tone: eaWithSubsCount > 0 ? "success" : "muted", hint: eas.length > 0
                                ? `${eaWithoutSubsCount} idle`
                                : undefined }),
                        React.createElement(SummaryStatItem, { label: "Total subs", value: subsLoading ? "…" : allSubs.length, compact: true, tone: "info" }),
                        React.createElement(SummaryStatItem, { label: "Active subs", value: subsLoading ? "…" : activeSubsCount, compact: true, tone: activeSubsCount > 0 ? "success" : "muted" }),
                        recentlyAddedEaIds.size > 0 && (React.createElement(SummaryStatItem, { label: "Recent EAs", value: recentlyAddedEaIds.size, compact: true, tone: "info", hint: "added last 7d" })),
                        spOwnerEas.length > 0 && (React.createElement(SummaryStatItem, { label: "SP-shaped owners", value: spOwnerEas.length, compact: true, tone: "warning", hint: "non-human" })),
                        baseline && (React.createElement(SummaryStatItem, { label: "Drift vs baseline", value: totalDrift, compact: true, tone: totalDrift === 0 ? "success" : "warning", hint: totalDrift === 0
                                ? "matches snapshot"
                                : `${drift.added.length}+ ${drift.removed.length}-` })),
                        orphanedSubs.length > 0 && (React.createElement(SummaryStatItem, { label: "Orphaned", value: orphanedSubs.length, compact: true, tone: "warning", hint: "EA not in list" })),
                        React.createElement(SummaryStatItem, { label: "Created (session)", value: sessionCreateCount, compact: true, tone: sessionCreateCount > 0 ? "info" : "muted", hint: "pivots launched" }))))),
            spOwnerEas.length > 0 && (React.createElement(Alert, { variant: "default", className: "border-warning/50 bg-warning/5" },
                React.createElement(Bot, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true }),
                React.createElement(AlertDescription, { className: "text-2xs" },
                    React.createElement("strong", null, spOwnerEas.length),
                    " enrollment account",
                    spOwnerEas.length === 1 ? "" : "s",
                    " in this department",
                    spOwnerEas.length === 1 ? " has" : " have",
                    " an",
                    " ",
                    React.createElement("strong", null, "SP-shaped owner"),
                    " rather than a human UPN \u2014 usually automation (deployment SPN / managed identity). Cross-tenant subscription-creator chains (see",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "_ea_subscription_cross_tenant.md"),
                    " ",
                    "\u00A7\"Granting subscription-creator across tenants\") are bootstrapped by placing an SP into exactly this slot \u2014 verify each is expected:",
                    React.createElement("ul", { className: "m-0 mt-1 flex flex-col gap-0.5 pl-4" },
                        spOwnerEas.slice(0, 5).map((e) => (React.createElement("li", { key: e.id, className: "flex flex-wrap items-center gap-1" },
                            React.createElement("span", { className: "font-medium" }, e.displayName),
                            React.createElement("span", { className: "text-muted-foreground font-mono text-[10px]" },
                                "(",
                                e.name,
                                ")"),
                            React.createElement("span", { className: "text-muted-foreground" }, "\u2192"),
                            React.createElement("span", { className: "font-mono text-[10px]" }, e.accountOwner)))),
                        spOwnerEas.length > 5 && (React.createElement("li", { className: "text-muted-foreground" },
                            "\u2026 and ",
                            spOwnerEas.length - 5,
                            " more \u2014 see the list below (flagged with the SP icon).")))))),
            React.createElement(Card, { className: "border-dashed" },
                React.createElement(CardHeader, { className: "pb-2" },
                    React.createElement(CardTitle, { className: "flex flex-wrap items-center gap-2 text-sm" },
                        React.createElement(GitCompareArrows, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                        "Baseline & drift",
                        baseline ? (React.createElement(Badge, { variant: "outline", className: totalDrift === 0
                                ? "text-2xs border-success text-success"
                                : "text-2xs border-warning text-warning" }, totalDrift === 0
                            ? "in sync"
                            : `${totalDrift} change${totalDrift === 1 ? "" : "s"}`)) : (React.createElement(Badge, { variant: "secondary", className: "text-2xs" }, "no snapshot")),
                        React.createElement(InfoTooltip, { variant: "help", content: React.createElement("span", { className: "block max-w-xs text-2xs" }, "Pins the current enrollment-account roster (id, owner, status) as a baseline. Drift since the snapshot is recomputed on every refresh \u2014 useful for periodic compliance evidence and for spotting silent additions / owner-swaps. Stored in this browser only."), ariaLabel: "What is the baseline?" }),
                        React.createElement("div", { className: "ml-auto flex items-center gap-2" },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleSaveBaseline, disabled: eaLoading || eas.length === 0, "aria-label": "Save current enrollment account roster as a baseline snapshot" },
                                React.createElement(Camera, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                baseline ? "Re-snapshot" : "Save baseline"),
                            baseline && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: handleClearBaseline, "aria-label": "Clear baseline snapshot" },
                                React.createElement(Trash2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                "Clear")))),
                    React.createElement(CardDescription, null, baseline ? (React.createElement(React.Fragment, null,
                        "Snapshot taken",
                        " ",
                        React.createElement("span", { className: "font-mono text-2xs" }, baseline.takenAt),
                        " ",
                        "by",
                        " ",
                        React.createElement("span", { className: "font-mono text-2xs" }, baseline.takenBy),
                        " ",
                        "(",
                        baseline.members.length,
                        " EA",
                        baseline.members.length === 1 ? "" : "s",
                        ").")) : ("Save a snapshot once you've reviewed today's roster — every subsequent visit will diff against it."))),
                baseline && totalDrift > 0 && (React.createElement(CardContent, { className: "flex flex-col gap-2 text-2xs" },
                    drift.added.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement("div", { className: "font-semibold text-info" },
                            "Added (",
                            drift.added.length,
                            ") \u2014 new since snapshot"),
                        React.createElement("ul", { className: "m-0 flex flex-col gap-0.5 pl-4" }, drift.added.map((e) => (React.createElement("li", { key: e.id },
                            React.createElement("span", { className: "font-medium" }, e.displayName),
                            " ",
                            React.createElement("span", { className: "font-mono text-[10px] text-muted-foreground" },
                                "(",
                                e.name,
                                ")"),
                            e.accountOwner ? (React.createElement(React.Fragment, null,
                                " — owner ",
                                React.createElement("span", { className: "font-mono text-[10px]" }, e.accountOwner))) : null)))))),
                    drift.removed.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement("div", { className: "font-semibold text-warning" },
                            "Removed (",
                            drift.removed.length,
                            ") \u2014 gone since snapshot"),
                        React.createElement("ul", { className: "m-0 flex flex-col gap-0.5 pl-4" }, drift.removed.map((e) => (React.createElement("li", { key: e.id },
                            React.createElement("span", { className: "font-medium" }, e.displayName),
                            " ",
                            React.createElement("span", { className: "font-mono text-[10px] text-muted-foreground" },
                                "(",
                                e.name,
                                ")"))))))),
                    drift.ownerChanged.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement("div", { className: "font-semibold text-warning" },
                            "Owner changed (",
                            drift.ownerChanged.length,
                            ")"),
                        React.createElement("ul", { className: "m-0 flex flex-col gap-0.5 pl-4" }, drift.ownerChanged.map((c) => (React.createElement("li", { key: c.id },
                            React.createElement("span", { className: "font-medium" }, c.displayName),
                            ":",
                            " ",
                            React.createElement("span", { className: "font-mono text-[10px] line-through text-muted-foreground" }, c.previous || "(none)"),
                            " ",
                            "\u2192",
                            " ",
                            React.createElement("span", { className: "font-mono text-[10px]" }, c.current || "(none)"))))))),
                    drift.statusChanged.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement("div", { className: "font-semibold text-info" },
                            "Status changed (",
                            drift.statusChanged.length,
                            ")"),
                        React.createElement("ul", { className: "m-0 flex flex-col gap-0.5 pl-4" }, drift.statusChanged.map((c) => (React.createElement("li", { key: c.id },
                            React.createElement("span", { className: "font-medium" }, c.displayName),
                            ":",
                            " ",
                            React.createElement("span", { className: "font-mono text-[10px] line-through text-muted-foreground" }, c.previous || "(unknown)"),
                            " ",
                            "\u2192",
                            " ",
                            React.createElement("span", { className: "font-mono text-[10px]" }, c.current || "(unknown)")))))))))),
            React.createElement(Card, null,
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex flex-wrap items-center gap-2 text-sm" },
                        React.createElement(Building2, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                        "Enrollment accounts in this department",
                        React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            filteredEas.length,
                            filteredEas.length !== eas.length ? ` / ${eas.length}` : ""),
                        React.createElement(InfoTooltip, { variant: "help", content: React.createElement("span", { className: "block max-w-xs text-2xs" },
                                "An ",
                                React.createElement("strong", null, "enrollment account"),
                                " is the EA's cost-tracking bucket. Every Azure subscription billed under EA is owned by exactly one enrollment account. To provision a subscription you must first pick the EA that will own its costs."), ariaLabel: "What is an enrollment account?" }),
                        React.createElement("div", { className: "ml-auto flex items-center gap-2" },
                            eas.length > 5 && (React.createElement(React.Fragment, null,
                                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setAllExpansion(true), disabled: eaLoading || eas.length === 0, "aria-label": "Expand all enrollment account rows" }, "Expand all"),
                                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setAllExpansion(false), disabled: eaLoading || eas.length === 0, "aria-label": "Collapse all enrollment account rows" }, "Collapse all"))),
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: copyAllEaIds, disabled: eaLoading || filteredEas.length === 0, "aria-label": "Copy all enrollment account ids to the clipboard as a TSV" }, "Copy IDs"),
                            React.createElement(ExportMenu, { rows: filteredEas, columns: eaExportColumns, filename: `department-admin-enrollment-accounts-${departmentName || "scope"}`, jsonMetadata: {
                                    billingAccountName,
                                    departmentName,
                                    filterApplied: search || null,
                                    statusFilter: eaStatusFilter,
                                    recencyFilter: eaRecencyFilter,
                                    sort: eaSortKey,
                                } }))),
                    React.createElement(CardDescription, null,
                        "Each enrollment account is a cost-tracking bucket. New subscriptions are created under one of them; click",
                        " ",
                        React.createElement("strong", null, "Create subscription"),
                        " on a row to pivot to the EA Subscription page with that EA pre-selected. Click an EA row header to expand its sub list when collapsed.")),
                React.createElement(CardContent, { className: "flex flex-col gap-2" },
                    React.createElement("div", { className: "flex flex-wrap items-end gap-2" },
                        React.createElement("div", { className: "flex flex-1 min-w-[220px] flex-col gap-1" },
                            React.createElement(Label, { htmlFor: "ea-search", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Search"),
                            React.createElement(Input, { id: "ea-search", value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Name, owner, cost center, or sub id\u2026", className: "text-xs", "aria-label": "Filter enrollment accounts \u2014 searches across display name, EA id, owner, cost center, and any subscription id grouped under the EA" })),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Status"),
                            React.createElement(Select, { value: eaStatusFilter, onValueChange: (v) => setEaStatusFilter(v) },
                                React.createElement(SelectTrigger, { className: "w-[140px]", "aria-label": "Filter by status" },
                                    React.createElement(SelectValue, null)),
                                React.createElement(SelectContent, null,
                                    React.createElement(SelectItem, { value: "all" }, "All statuses"),
                                    React.createElement(SelectItem, { value: "active" }, "Active"),
                                    React.createElement(SelectItem, { value: "inactive" }, "Inactive")))),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Sort"),
                            React.createElement(Select, { value: eaSortKey, onValueChange: (v) => setEaSortKey(v) },
                                React.createElement(SelectTrigger, { className: "w-[160px]", "aria-label": "Sort enrollment accounts" },
                                    React.createElement(SelectValue, null)),
                                React.createElement(SelectContent, null,
                                    React.createElement(SelectItem, { value: "name" },
                                        React.createElement("span", { className: "flex items-center gap-2" },
                                            React.createElement(ArrowUpDown, { className: "h-3 w-3", "aria-hidden": true }),
                                            "Name (A \u2192 Z)")),
                                    React.createElement(SelectItem, { value: "subs" }, "Sub count (high \u2192 low)"),
                                    React.createElement(SelectItem, { value: "status" }, "Status"),
                                    React.createElement(SelectItem, { value: "owner" }, "Owner"))))),
                    React.createElement(FilterChipRow, { label: "Recency", value: eaRecencyFilter === "last7"
                            ? new Set(["last7"])
                            : new Set(), options: [
                            {
                                key: "last7",
                                label: `Added in last 7 days (${recentlyAddedEaIds.size})`,
                                tone: "info",
                            },
                        ], onChange: (next) => setEaRecencyFilter(next.has("last7") ? "last7" : "any") }),
                    eaLoading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 4 })) : eaError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load enrollment accounts.", detail: eaError, onRetry: () => setReloadTick((n) => n + 1) })) : eas.length === 0 ? (React.createElement(EmptyState, { icon: Building2, title: "No enrollment accounts in this department", description: "A department admin needs at least one enrollment account before billing subs can be created. Ask an EA admin to assign one.", size: "compact" })) : filteredEas.length === 0 ? (React.createElement("p", { className: "py-6 text-center text-xs text-muted-foreground" },
                        "No enrollment accounts match",
                        " ",
                        search ? (React.createElement("code", { className: "font-mono" }, search)) : ("the current filter"),
                        ".")) : (React.createElement("ul", { className: "flex flex-col gap-2" }, filteredEas.map((ea) => {
                        var _a, _b, _c, _d;
                        const subs = (_a = subsByEaDisplayName.get(ea.displayName)) !== null && _a !== void 0 ? _a : [];
                        const isExpanded = expandedEas.has(ea.id) || eas.length <= 5;
                        return (React.createElement("li", { key: ea.id, className: "flex flex-col gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs" },
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement("button", { type: "button", onClick: () => toggleEa(ea.id), className: "flex flex-1 min-w-0 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded", "aria-expanded": isExpanded, "aria-label": `${isExpanded ? "Collapse" : "Expand"} ${ea.displayName} (${subs.length} sub${subs.length === 1 ? "" : "s"})` },
                                    React.createElement(Building2, { className: "h-3.5 w-3.5 text-muted-foreground shrink-0", "aria-hidden": true }),
                                    React.createElement("span", { className: "font-medium truncate" }, ea.displayName)),
                                React.createElement(CopyableText, { value: ea.name, mono: true, ariaLabel: `Copy enrollment account id ${ea.name}` }),
                                ea.status && (React.createElement(Badge, { variant: normalizeStatus(ea.status) === "active"
                                        ? "outline"
                                        : "secondary", className: "text-2xs" }, ea.status)),
                                recentlyAddedEaIds.has(ea.id) && (React.createElement(Badge, { variant: "outline", className: "text-2xs border-info text-info", title: ea.startDate
                                        ? `Onboarded ${ea.startDate}`
                                        : "Onboarded within the last 7 days", "aria-label": "This enrollment account was added in the last 7 days" }, "New")),
                                spOwnerEaIds.has(ea.id) && (React.createElement(Badge, { variant: "outline", className: "text-2xs border-warning text-warning inline-flex items-center gap-1", title: `Account owner "${(_b = ea.accountOwner) !== null && _b !== void 0 ? _b : ""}" looks like a service principal / managed identity rather than a human UPN. Verify this is expected automation — see _ea_subscription_cross_tenant.md.`, "aria-label": "Account owner looks like a service principal \u2014 review for expected automation" },
                                    React.createElement(Bot, { className: "h-3 w-3", "aria-hidden": true }),
                                    "SP")),
                                ea.costCenter && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                                    "CC: ",
                                    ea.costCenter)),
                                ea.accountOwner && (React.createElement(InfoTooltip, { variant: "info", content: React.createElement("span", { className: "block max-w-xs text-2xs" },
                                        React.createElement("strong", null, "Account owner:"),
                                        " ",
                                        ea.accountOwner,
                                        ea.startDate || ea.endDate ? (React.createElement(React.Fragment, null,
                                            React.createElement("br", null),
                                            React.createElement("span", { className: "text-muted-foreground" },
                                                "Term: ", (_c = ea.startDate) !== null && _c !== void 0 ? _c : "?",
                                                " → ", (_d = ea.endDate) !== null && _d !== void 0 ? _d : "ongoing"))) : null), ariaLabel: "Show account owner details" })),
                                ea.accountOwner && (React.createElement("span", { className: "text-2xs text-muted-foreground hidden sm:inline" },
                                    "owner: ",
                                    ea.accountOwner)),
                                React.createElement(Badge, { variant: subs.length > 0 ? "outline" : "secondary", className: "ml-auto text-2xs", "aria-label": `${subs.length} subscription${subs.length === 1 ? "" : "s"}` },
                                    subs.length,
                                    " sub",
                                    subs.length === 1 ? "" : "s"),
                                React.createElement("a", { href: portalEnrollmentAccountLink(cloudInfo, ea.id, account === null || account === void 0 ? void 0 : account.tenantId), target: "_blank", rel: "noopener noreferrer", className: "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-2xs text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", onClick: (e) => e.stopPropagation(), title: `Open this enrollment account in ${cloudInfo.label} portal (${cloudInfo.portalHost})`, "aria-label": `Open ${ea.displayName} in the Azure portal for ${cloudInfo.label}` },
                                    React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true }),
                                    "Portal"),
                                React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", onClick: (e) => {
                                        // Prevent the row-toggle from firing for this nested action.
                                        e.stopPropagation();
                                        requestCreateSubscription(ea);
                                    }, disabled: normalizeStatus(ea.status) !== "active", "aria-label": `Create subscription under enrollment account ${ea.displayName}`, title: normalizeStatus(ea.status) !== "active"
                                        ? "EA is inactive — Azure will reject new subscriptions"
                                        : "Pre-fills the EA Subscription page with this enrollment account" },
                                    React.createElement(PlusCircle, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                    "Create subscription")),
                            isExpanded && (React.createElement(React.Fragment, null, subs.length === 0 ? (React.createElement("p", { className: "pl-5 text-2xs italic text-muted-foreground" },
                                "No subscriptions yet \u2014 use",
                                " ",
                                React.createElement("strong", null, "Create subscription"),
                                " above to provision the first one.")) : (React.createElement("ul", { className: "flex flex-col gap-1 pl-5" }, subs.map((s) => (React.createElement("li", { key: s.id, className: "flex flex-wrap items-center gap-2 text-2xs" },
                                React.createElement(Server, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": true }),
                                React.createElement("span", { className: "font-medium" }, s.displayName),
                                s.subscriptionId && (React.createElement(CopyableText, { value: s.subscriptionId, mono: true, ariaLabel: `Copy subscription id ${s.subscriptionId}` })),
                                s.status && (React.createElement(Badge, { variant: "outline", className: "text-[9px]" }, s.status)),
                                s.skuId && (React.createElement("span", { className: "text-[9px] text-muted-foreground font-mono" }, s.skuId)))))))))));
                    }))),
                    orphanedSubs.length > 0 && (React.createElement(Alert, { variant: "default", className: "mt-2" },
                        React.createElement(HelpCircle, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        React.createElement(AlertDescription, { className: "text-2xs" },
                            React.createElement("strong", null, orphanedSubs.length),
                            " subscription",
                            orphanedSubs.length === 1 ? " is" : "s are",
                            " billed against an enrollment account not in this list (most commonly: the EA was moved out of the department after the sub was created). Switch to the",
                            " ",
                            React.createElement("strong", null, "Flat"),
                            " view below to see them."))),
                    subsError && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        React.createElement(AlertDescription, null,
                            "Could not load subs to populate the per-EA list:",
                            " ",
                            subsError))))),
            React.createElement(Card, null,
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex flex-wrap items-center gap-2 text-sm" },
                        React.createElement(Server, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                        "Billing subscriptions (department scope)",
                        React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            filteredSubs.length,
                            filteredSubs.length !== allSubs.length
                                ? ` / ${allSubs.length}`
                                : ""),
                        React.createElement(InfoTooltip, { variant: "help", content: React.createElement("span", { className: "block max-w-xs text-2xs" },
                                "Uses",
                                " ",
                                React.createElement("code", { className: "font-mono" },
                                    "/departments/",
                                    "{name}",
                                    "/billingSubscriptions"),
                                " ",
                                "\u2014 the billing-account-scope variant",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "/billingAccounts/.../billingSubscriptions"),
                                " ",
                                "returns 403 for Department Admins, so this narrower endpoint is correct and intentional. Do not change it without verifying RBAC."), ariaLabel: "Why is this scope narrower than EA Admin's?" }),
                        React.createElement("div", { className: "ml-auto flex items-center gap-2" },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: copyAllSubIds, disabled: subsLoading || filteredSubs.length === 0, "aria-label": "Copy all subscription ids to the clipboard as a TSV" }, "Copy IDs"),
                            React.createElement(ExportMenu, { rows: filteredSubs, columns: subExportColumns, filename: `department-admin-billing-subs-${departmentName || "scope"}`, jsonMetadata: {
                                    billingAccountName,
                                    departmentName,
                                    scope: "department",
                                    filterApplied: subsSearch || null,
                                    statusFilter: subsStatusFilter,
                                } }))),
                    React.createElement(CardDescription, null,
                        "Department-scoped sub list. Use ",
                        React.createElement("strong", null, "Grouped"),
                        " to see subs nested under their owning EA (mirrors the card above with extra detail), or ",
                        React.createElement("strong", null, "Flat"),
                        " to browse and filter every sub in one table \u2014 useful when the same display name appears across multiple EAs or for quick exports.")),
                React.createElement(CardContent, { className: "flex flex-col gap-2" },
                    React.createElement("div", { className: "flex flex-wrap items-end gap-2" },
                        React.createElement("div", { className: "flex flex-1 min-w-[220px] flex-col gap-1" },
                            React.createElement(Label, { htmlFor: "subs-search", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Search"),
                            React.createElement(Input, { id: "subs-search", value: subsSearch, onChange: (e) => setSubsSearch(e.target.value), placeholder: "Name, sub id, EA, or cost center\u2026", className: "text-xs", "aria-label": "Filter billing subscriptions" })),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Status"),
                            React.createElement(Select, { value: subsStatusFilter, onValueChange: setSubsStatusFilter },
                                React.createElement(SelectTrigger, { className: "w-[160px]", "aria-label": "Filter by status" },
                                    React.createElement(SelectValue, null)),
                                React.createElement(SelectContent, null,
                                    React.createElement(SelectItem, { value: "all" }, "All statuses"),
                                    subsStatusValues.map((v) => (React.createElement(SelectItem, { key: v, value: v }, v)))))),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "View"),
                            React.createElement(Select, { value: subsViewMode, onValueChange: (v) => setSubsViewMode(v) },
                                React.createElement(SelectTrigger, { className: "w-[140px]", "aria-label": "View mode" },
                                    React.createElement(SelectValue, null)),
                                React.createElement(SelectContent, null,
                                    React.createElement(SelectItem, { value: "grouped" }, "Grouped by EA"),
                                    React.createElement(SelectItem, { value: "flat" }, "Flat"))))),
                    subsLoading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 4 })) : subsError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load billing subscriptions.", detail: subsError, onRetry: () => setReloadTick((n) => n + 1) })) : allSubs.length === 0 ? (React.createElement(EmptyState, { icon: Server, title: "No subscriptions yet", description: "No subscriptions reported under any enrollment account in this department. Use Create subscription on an enrollment account row above to provision the first one.", size: "compact" })) : filteredSubs.length === 0 ? (React.createElement("p", { className: "py-6 text-center text-xs text-muted-foreground" },
                        "No subscriptions match the current filter",
                        subsSearch ? (React.createElement(React.Fragment, null,
                            " ",
                            "(",
                            React.createElement("code", { className: "font-mono" }, subsSearch),
                            ")")) : null,
                        ".")) : subsViewMode === "flat" ? (React.createElement("ul", { className: "flex flex-col gap-1" }, filteredSubs.map((s) => (React.createElement("li", { key: s.id, className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-2xs" },
                        React.createElement(Server, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": true }),
                        React.createElement("span", { className: "font-medium" }, s.displayName),
                        s.subscriptionId && (React.createElement(CopyableText, { value: s.subscriptionId, mono: true, ariaLabel: `Copy subscription id ${s.subscriptionId}` })),
                        s.invoiceSectionDisplayName ? (React.createElement("span", { className: "text-muted-foreground" },
                            "via ",
                            s.invoiceSectionDisplayName)) : (React.createElement("span", { className: "text-warning" }, "via (no EA)")),
                        s.costCenter && (React.createElement(Badge, { variant: "secondary", className: "text-[9px]" },
                            "CC: ",
                            s.costCenter)),
                        s.status && (React.createElement(Badge, { variant: "outline", className: "text-[9px]" }, s.status)),
                        s.skuId && (React.createElement("span", { className: "text-[9px] text-muted-foreground font-mono" }, s.skuId))))))) : (
                    // Grouped view: same data as flat, organised under each EA
                    // header — plus an explicit "Orphaned" group at the bottom
                    // for subs whose EA didn't appear in our list.
                    //
                    // Perf: build a Set of filtered ARM ids once so the inner
                    // membership check is O(1) per sub instead of O(n). The
                    // previous `.includes(s)` form was quadratic for very
                    // large departments (visible north of ~1k subs).
                    (() => {
                        const filteredIdSet = new Set(filteredSubs.map((s) => s.id));
                        return (React.createElement("div", { className: "flex flex-col gap-3" },
                            Array.from(subsByEaDisplayName.entries())
                                .map(([eaName, subs]) => ({
                                eaName,
                                subs: subs.filter((s) => filteredIdSet.has(s.id)),
                            }))
                                .filter((g) => g.subs.length > 0)
                                .sort((a, b) => a.eaName.localeCompare(b.eaName))
                                .map((g) => (React.createElement("div", { key: g.eaName, className: "flex flex-col gap-1" },
                                React.createElement("div", { className: "flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                                    React.createElement(Building2, { className: "h-3 w-3", "aria-hidden": true }),
                                    g.eaName,
                                    React.createElement(Badge, { variant: "outline", className: "text-[9px]" }, g.subs.length)),
                                React.createElement("ul", { className: "flex flex-col gap-1 pl-5" }, g.subs.map((s) => (React.createElement("li", { key: s.id, className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-2xs" },
                                    React.createElement(Server, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": true }),
                                    React.createElement("span", { className: "font-medium" }, s.displayName),
                                    s.subscriptionId && (React.createElement(CopyableText, { value: s.subscriptionId, mono: true, ariaLabel: `Copy subscription id ${s.subscriptionId}` })),
                                    s.costCenter && (React.createElement(Badge, { variant: "secondary", className: "text-[9px]" },
                                        "CC: ",
                                        s.costCenter)),
                                    s.status && (React.createElement(Badge, { variant: "outline", className: "text-[9px]" }, s.status)),
                                    s.skuId && (React.createElement("span", { className: "text-[9px] text-muted-foreground font-mono" }, s.skuId))))))))),
                            (() => {
                                const orphanedFiltered = orphanedSubs.filter((s) => filteredIdSet.has(s.id));
                                if (orphanedFiltered.length === 0)
                                    return null;
                                return (React.createElement("div", { className: "flex flex-col gap-1" },
                                    React.createElement("div", { className: "flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-warning" },
                                        React.createElement(HelpCircle, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Orphaned (EA not in this department's list)",
                                        React.createElement(Badge, { variant: "outline", className: "text-[9px] border-warning text-warning" }, orphanedFiltered.length)),
                                    React.createElement("ul", { className: "flex flex-col gap-1 pl-5" }, orphanedFiltered.map((s) => {
                                        var _a;
                                        return (React.createElement("li", { key: s.id, className: "flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-1.5 text-2xs" },
                                            React.createElement(Server, { className: "h-3 w-3 text-warning", "aria-hidden": true }),
                                            React.createElement("span", { className: "font-medium" }, s.displayName),
                                            s.subscriptionId && (React.createElement(CopyableText, { value: s.subscriptionId, mono: true, ariaLabel: `Copy subscription id ${s.subscriptionId}` })),
                                            React.createElement("span", { className: "text-muted-foreground" },
                                                "via",
                                                " ", (_a = s.invoiceSectionDisplayName) !== null && _a !== void 0 ? _a : "(no EA)"),
                                            s.status && (React.createElement(Badge, { variant: "outline", className: "text-[9px]" }, s.status))));
                                    }))));
                            })()));
                    })()))),
            React.createElement(Card, { className: "border-dashed" },
                React.createElement(CardHeader, { className: "pb-2" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(Sparkles, { className: "h-4 w-4 text-primary" }),
                        "Common next steps"),
                    React.createElement(CardDescription, null, "Pivots inherit the picker state above where applicable.")),
                React.createElement(CardContent, { className: "flex flex-wrap gap-2" },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => navigate("/ea-subscription"), "aria-label": "Open EA Subscription creator (no pre-fill)" },
                        React.createElement(BadgeCheck, { className: "h-3.5 w-3.5" }),
                        "Open EA Subscription creator",
                        React.createElement(ArrowRight, { className: "h-3 w-3" })),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => navigate("/ea-billing-manager"), "aria-label": "Open EA Billing Manager" },
                        React.createElement(Users, { className: "h-3.5 w-3.5" }),
                        "EA Billing Manager",
                        React.createElement(ArrowRight, { className: "h-3 w-3" })),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => navigate("/audit-log"), "aria-label": "Open the audit log" },
                        React.createElement(ExternalLink, { className: "h-3.5 w-3.5" }),
                        "Audit log",
                        React.createElement(ArrowRight, { className: "h-3 w-3" }))))))));
};
//# sourceMappingURL=department-admin-page.js.map