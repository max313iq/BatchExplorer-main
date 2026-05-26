import { __awaiter } from "tslib";
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
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, Clock, Copy, Cpu, Database, ExternalLink, FolderTree, Ghost, Keyboard, Layers, ListChecks, Loader2, PackageMinus, PackagePlus, RefreshCw, Search, Server, ShieldCheck, Sparkles, Tag, Trash2, Wand2, X, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { getActiveTenant, getArmTokenForAccount, } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { auditLog } from "../../services/audit-log";
import { createResourceGroup, listBatchAccounts, listSubscriptions, moveResources, validateMoveResources, } from "../../services";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SignInRequired } from "../shared/sign-in-required";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { StatusBadge } from "../shared/status-badge";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { PreMoveAttackSurfacePreview, SecuritySignalsBanner, } from "./security-signals";
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
function sanitiseForRg(s) {
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
function renderRgTemplate(template, ctx) {
    const sanitisedName = sanitiseForRg(ctx.name);
    const sanitisedRg = sanitiseForRg(ctx.rg) || "rg";
    return template
        .replace(/\{name\}/gi, sanitisedName)
        .replace(/\{rg\}/gi, sanitisedRg)
        .trim();
}
/** Extract the resource group from a full ARM resource id. Returns "" on miss. */
function rgFromArmId(armId) {
    const m = /\/resourceGroups\/([^/]+)/i.exec(armId);
    return m ? m[1] : "";
}
/**
 * Build the Azure portal deep-link for a Batch account (post-move or
 * source). Lets the operator jump to the portal Blade in one click to
 * verify the move landed correctly — particularly useful while the
 * destination subscription is still settling and the move can take a
 * few minutes to surface in our own list view.
 */
function portalUrlForBatchAccount(armId) {
    return `https://portal.azure.com/#@/resource${armId}/overview`;
}
/**
 * Build the Azure portal deep-link for a resource group. Used as a
 * shortcut next to the destination RG name so the operator can confirm
 * the freshly-created RG is theirs.
 */
function portalUrlForResourceGroup(subscriptionId, rgName) {
    return (`https://portal.azure.com/#@/resource/subscriptions/${subscriptionId}` +
        `/resourceGroups/${rgName}/overview`);
}
/** Human-friendly elapsed-time formatter (e.g. "3m 42s", "12s"). */
function fmtElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0)
        return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
}
/**
 * Heuristic: does this Batch account look stale / abandoned?
 * Signals (any one triggers "stale"):
 *   - provisioningState in {Failed, Canceled, Cancelled}
 *   - dedicatedCoreQuota === 0 AND lowPriorityCoreQuota === 0
 *     (account exists but can't actually allocate any compute)
 * ARM doesn't surface a creation timestamp on Batch accounts, so this is
 * the best we can do without an extra Activity-Log call per account.
 */
function isStaleBatchAccount(b) {
    var _a, _b, _c, _d, _e, _f;
    const state = ((_b = (_a = b.properties) === null || _a === void 0 ? void 0 : _a.provisioningState) !== null && _b !== void 0 ? _b : "").toLowerCase();
    if (state === "failed" || state === "canceled" || state === "cancelled") {
        return true;
    }
    const dedicated = (_d = (_c = b.properties) === null || _c === void 0 ? void 0 : _c.dedicatedCoreQuota) !== null && _d !== void 0 ? _d : -1;
    const lowPri = (_f = (_e = b.properties) === null || _e === void 0 ? void 0 : _e.lowPriorityCoreQuota) !== null && _f !== void 0 ? _f : -1;
    return dedicated === 0 && lowPri === 0;
}
/** Generate a short, monotonically increasing run-id. */
let _runIdCounter = 0;
function nextRunId() {
    _runIdCounter += 1;
    return _runIdCounter;
}
export const ResourceManagerPage = () => {
    var _a, _b, _c, _d, _e, _f, _g;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const navigate = useNavigate();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    /* ----- Source account picker ------------------------------------ */
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
        if (candidates.length > 0 &&
            !candidates.some((c) => c.homeAccountId === accountId)) {
            setAccountId(candidates[0].homeAccountId);
        }
    }, [candidates, accountId, setAccountId]);
    const account = React.useMemo(() => { var _a; return (_a = candidates.find((c) => c.homeAccountId === accountId)) !== null && _a !== void 0 ? _a : null; }, [candidates, accountId]);
    /* ----- ARM token freshness tracker ------------------------------- *
     * Drives the TokenExpiryBadge near the page header so the operator
     * can force-refresh the home-tenant ARM token before kicking off a
     * multi-minute moveResources pipeline. The per-tenant `tokenForTenant`
     * cache below is still the source-of-truth for actual ARM calls
     * (each call uses the right tenant's token), so we don't sync the
     * tracker's token down — we only use its expiry / loading signals. */
    const armTokenTracker = useArmToken(account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId);
    /* ----- ARM tokens (per-tenant, lazy) ----------------------------- */
    // Subscriptions can live in a tenant other than the account's home
    // tenant (CSP, Lighthouse, sub-transfer, multi-tenant identities).
    // ARM rejects a home-tenant token on a cross-tenant subscription with
    // "The access token is from the wrong issuer". Cache per-tenant tokens
    // and acquire them on demand so each ARM call uses the right one.
    const tokenCacheRef = React.useRef(new Map());
    const inflightRef = React.useRef(new Map());
    React.useEffect(() => {
        // Drop any cached tokens when the source account changes.
        tokenCacheRef.current.clear();
        inflightRef.current.clear();
    }, [accountId]);
    const tokenForTenant = React.useCallback((tenantId) => __awaiter(void 0, void 0, void 0, function* () {
        var _h;
        if (!account)
            throw new Error("No source account selected.");
        // Resolve fallback against the live store entry so a post-switch
        // call uses the CURRENT active tenant, not the home tenant.
        const azureAccount = azureAccounts.find((a) => a.homeAccountId === account.homeAccountId);
        const fallbackTenantId = azureAccount
            ? (_h = resolveActiveTenantId(azureAccount)) !== null && _h !== void 0 ? _h : account.tenantId
            : account.tenantId;
        const key = tenantId || fallbackTenantId;
        const cached = tokenCacheRef.current.get(key);
        if (cached)
            return cached;
        const existing = inflightRef.current.get(key);
        if (existing)
            return existing;
        const p = (() => __awaiter(void 0, void 0, void 0, function* () {
            const t = yield getArmTokenForAccount(account.homeAccountId, key);
            tokenCacheRef.current.set(key, t);
            inflightRef.current.delete(key);
            return t;
        }))();
        inflightRef.current.set(key, p);
        return p;
    }), [account, azureAccounts]);
    /* ----- Subscriptions (source + destination) --------------------- */
    // Aggregate subs across every tenant the signed-in account belongs
    // to — using a single home-tenant token only returns home-tenant
    // subs, which then 401 when we try to call per-sub endpoints on
    // other-tenant subs. We query each tenant separately and merge.
    const [subs, setSubs] = React.useState([]);
    const [subsLoading, setSubsLoading] = React.useState(false);
    const [subsError, setSubsError] = React.useState(null);
    // Build the candidate tenant list from the signed-in azureAccounts
    // entry — `tenants[]` is populated by the Azure Accounts page; falls
    // back to the home tenant alone when that hasn't loaded yet.
    const tenantIds = React.useMemo(() => {
        var _a, _b;
        if (!account)
            return [];
        const a = azureAccounts.find((x) => x.homeAccountId === account.homeAccountId);
        const ids = new Set();
        ids.add(account.tenantId);
        (_a = a === null || a === void 0 ? void 0 : a.tenants) === null || _a === void 0 ? void 0 : _a.forEach((t) => {
            if (t.tenantId)
                ids.add(t.tenantId);
        });
        (_b = a === null || a === void 0 ? void 0 : a.subscriptions) === null || _b === void 0 ? void 0 : _b.forEach((s) => {
            if (s.tenantId)
                ids.add(s.tenantId);
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
        (() => __awaiter(void 0, void 0, void 0, function* () {
            const merged = new Map();
            const errors = [];
            for (const tid of tenantIds) {
                try {
                    const tok = yield tokenForTenant(tid);
                    const list = yield listSubscriptions(tok);
                    for (const s of list)
                        merged.set(s.subscriptionId, s);
                }
                catch (err) {
                    errors.push(`tenant ${tid.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (cancelled)
                return;
            setSubs(Array.from(merged.values()));
            // Only surface an error if EVERY tenant failed — partial success
            // is normal (the account may have lost access to some tenants).
            if (merged.size === 0 && errors.length > 0) {
                setSubsError(errors.join(" · "));
            }
            setSubsLoading(false);
        }))();
        return () => {
            cancelled = true;
        };
    }, [account === null || account === void 0 ? void 0 : account.homeAccountId, tenantIds, tokenForTenant]);
    const [srcSubId, setSrcSubIdState] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_SRC_SUB)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    const setSrcSubId = React.useCallback((id) => {
        setSrcSubIdState(id);
        try {
            sessionStorage.setItem(STORAGE_SRC_SUB, id);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    const [dstSubId, setDstSubIdState] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_DST_SUB)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    const setDstSubId = React.useCallback((id) => {
        setDstSubIdState(id);
        try {
            sessionStorage.setItem(STORAGE_DST_SUB, id);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    /* ----- Source Batch accounts ------------------------------------ */
    const [batchAccounts, setBatchAccounts] = React.useState([]);
    const [batchLoading, setBatchLoading] = React.useState(false);
    const [batchError, setBatchError] = React.useState(null);
    const [reloadTick, setReloadTick] = React.useState(0);
    const reload = React.useCallback(() => setReloadTick((n) => n + 1), []);
    const srcSub = React.useMemo(() => { var _a; return (_a = subs.find((s) => s.subscriptionId === srcSubId)) !== null && _a !== void 0 ? _a : null; }, [subs, srcSubId]);
    React.useEffect(() => {
        if (!account || !srcSub) {
            setBatchAccounts([]);
            return;
        }
        let cancelled = false;
        setBatchLoading(true);
        setBatchError(null);
        (() => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const tok = yield tokenForTenant(srcSub.tenantId);
                const list = yield listBatchAccounts(srcSub.subscriptionId, tok);
                if (!cancelled)
                    setBatchAccounts(list);
            }
            catch (err) {
                if (!cancelled) {
                    setBatchAccounts([]);
                    setBatchError(err instanceof Error ? err.message : String(err));
                }
            }
            finally {
                if (!cancelled)
                    setBatchLoading(false);
            }
        }))();
        return () => {
            cancelled = true;
        };
    }, [account === null || account === void 0 ? void 0 : account.homeAccountId, srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId, srcSub === null || srcSub === void 0 ? void 0 : srcSub.tenantId, reloadTick, tokenForTenant]);
    /* ----- Destination sub ------------------------------------------ */
    const dstSub = React.useMemo(() => { var _a; return (_a = subs.find((s) => s.subscriptionId === dstSubId)) !== null && _a !== void 0 ? _a : null; }, [subs, dstSubId]);
    /* ----- Selection + filter --------------------------------------- */
    const [search, setSearch] = React.useState("");
    const [quickFilter, setQuickFilter] = React.useState("all");
    const [selected, setSelected] = React.useState(new Set());
    const [sort, setSortState] = React.useState(() => {
        var _a;
        try {
            return ((_a = sessionStorage.getItem(STORAGE_SORT)) !== null && _a !== void 0 ? _a : "name-asc");
        }
        catch (_b) {
            return "name-asc";
        }
    });
    const setSort = React.useCallback((s) => {
        setSortState(s);
        try {
            sessionStorage.setItem(STORAGE_SORT, s);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    /** Bucket the provisioningState string into a quick-filter chip group. */
    const bucketState = React.useCallback((raw) => {
        const s = raw.toLowerCase();
        if (s === "succeeded" || s === "provisioned")
            return "provisioned";
        if (s === "failed" || s === "canceled" || s === "cancelled")
            return "failed";
        if (s === "creating" ||
            s === "updating" ||
            s === "deleting" ||
            s === "moving" ||
            s === "provisioning")
            return "in-progress";
        return "all";
    }, []);
    /** Counts per quick-filter bucket — used to label the chips with badges. */
    const stateBuckets = React.useMemo(() => {
        var _a, _b;
        const counts = {
            provisioned: 0,
            failed: 0,
            "in-progress": 0,
            stale: 0,
        };
        for (const b of batchAccounts) {
            const bucket = bucketState((_b = (_a = b.properties) === null || _a === void 0 ? void 0 : _a.provisioningState) !== null && _b !== void 0 ? _b : "");
            if (bucket !== "all" && bucket !== "stale")
                counts[bucket] += 1;
            if (isStaleBatchAccount(b))
                counts.stale += 1;
        }
        return counts;
    }, [batchAccounts, bucketState]);
    /**
     * List of "stale" Batch accounts — surfaced in the summary tile and
     * by the persisted "Stale only" filter chip. Heuristic in
     * `isStaleBatchAccount`. Memoised separately so the SummaryStatItem
     * doesn't re-render every keystroke in the search box.
     */
    const staleAccounts = React.useMemo(() => batchAccounts.filter(isStaleBatchAccount), [batchAccounts]);
    /**
     * Stale-only filter — persisted via `usePersistedState` so the chip
     * remembers its on/off state across reloads. When true, the visible
     * list is restricted to accounts flagged by `isStaleBatchAccount`
     * (Failed/Canceled provisioning OR zero core quota). Independent of
     * the provisioningState quick-filter — both compose with AND.
     */
    const [staleOnly, setStaleOnly] = usePersistedState("resource-manager:stale-only", false, { syncAcrossTabs: true });
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
            var _a, _b, _c, _d;
            // Quick-filter chip first (cheap path).
            if (quickFilter !== "all") {
                if (quickFilter === "stale") {
                    if (!isStaleBatchAccount(b))
                        return false;
                }
                else {
                    const bucket = bucketState((_b = (_a = b.properties) === null || _a === void 0 ? void 0 : _a.provisioningState) !== null && _b !== void 0 ? _b : "");
                    if (bucket !== quickFilter)
                        return false;
                }
            }
            // Persisted "stale only" toggle composes with AND on top of the
            // chip — lets the operator scope to e.g. "in-progress AND stale".
            if (staleOnly && !isStaleBatchAccount(b))
                return false;
            if (tokens.length === 0)
                return true;
            const haystack = [
                b.name,
                b.id,
                b.location,
                (_d = (_c = b.properties) === null || _c === void 0 ? void 0 : _c.provisioningState) !== null && _d !== void 0 ? _d : "",
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
                sorted.sort((a, b) => rgFromArmId(a.id).localeCompare(rgFromArmId(b.id)));
                break;
            case "location-asc":
                sorted.sort((a, b) => { var _a, _b; return ((_a = a.location) !== null && _a !== void 0 ? _a : "").localeCompare((_b = b.location) !== null && _b !== void 0 ? _b : ""); });
                break;
            case "state-asc":
                sorted.sort((a, b) => {
                    var _a, _b, _c, _d;
                    return ((_b = (_a = a.properties) === null || _a === void 0 ? void 0 : _a.provisioningState) !== null && _b !== void 0 ? _b : "").localeCompare((_d = (_c = b.properties) === null || _c === void 0 ? void 0 : _c.provisioningState) !== null && _d !== void 0 ? _d : "");
                });
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
    const selectAllVisible = React.useCallback(() => {
        setSelected((prev) => {
            // Additive: preserve any already-selected accounts that the current
            // filter happens to hide. Operators expect "Select visible" to never
            // *deselect* something — that's what "Clear" is for.
            const next = new Set(prev);
            for (const b of filtered)
                next.add(b.id);
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
                if (next.has(b.id))
                    next.delete(b.id);
                else
                    next.add(b.id);
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
    const copySelectedIds = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _j;
        if (selected.size === 0)
            return;
        const ids = batchAccounts
            .filter((b) => selected.has(b.id))
            .map((b) => b.id)
            .join("\n");
        try {
            if (typeof navigator !== "undefined" &&
                ((_j = navigator.clipboard) === null || _j === void 0 ? void 0 : _j.writeText) !== undefined) {
                yield navigator.clipboard.writeText(ids);
                store.addNotification({
                    type: "success",
                    message: `Copied ${selected.size} ARM id${selected.size === 1 ? "" : "s"} to clipboard.`,
                });
                return;
            }
        }
        catch (_k) {
            /* fall through */
        }
        store.addNotification({
            type: "error",
            message: "Clipboard unavailable — copy from the per-row buttons instead.",
        });
    }), [selected, batchAccounts, store]);
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
    const [planOverrides, setPlanOverrides] = React.useState({});
    /**
     * Bulk-action toolbar state — input for the suffix/prefix the
     * operator wants to slap onto every row's destination RG name in a
     * single click. Kept in a transient local state (not persisted) so a
     * stale "-prod" from yesterday doesn't accidentally re-apply on next
     * session. Confirmation dialog state for bulk delete-from-selection
     * lives separately so the operator can't accidentally fire it.
     */
    const [bulkSuffix, setBulkSuffix] = React.useState("");
    const [confirmBulkRemoveOpen, setConfirmBulkRemoveOpen] = React.useState(false);
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
    const [planTags, setPlanTags] = React.useState([]);
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
    const [recentTagKeys, setRecentTagKeys] = usePersistedState("resource-manager:recent-tag-keys", [], {
        syncAcrossTabs: true,
        version: 1,
        migrate: (raw) => (Array.isArray(raw) ? raw : []),
    });
    /** First-row RG-name input ref — hotkey `r` focuses it. */
    const firstRgNameInputRef = React.useRef(null);
    /** First-row location input ref — hotkey `m` focuses it. */
    const firstRgLocationInputRef = React.useRef(null);
    /**
     * Bulk-rename template applied to every row that doesn't have an
     * explicit `destRgName` override. Persisted across reloads so an
     * operator who prefers `mig-{name}` doesn't have to re-set it every
     * session. Uses `usePersistedState` for cross-tab sync + schema
     * versioning (replaces ad-hoc sessionStorage handling).
     */
    const [rgTemplate, setRgTemplate] = usePersistedState(STORAGE_RG_TEMPLATE, DEFAULT_RG_TEMPLATE, { syncAcrossTabs: true });
    const planRows = React.useMemo(() => {
        const selectedAccounts = batchAccounts.filter((b) => selected.has(b.id));
        const used = new Set();
        // Fall back to the default template if the operator has wiped the
        // input — renderRgTemplate on an empty string produces an empty
        // string which would fail validation for every row, hiding the real
        // problem behind a cascade of duplicate errors.
        const tmpl = rgTemplate.trim() || DEFAULT_RG_TEMPLATE;
        return selectedAccounts.map((b) => {
            var _a, _b, _c;
            const override = (_a = planOverrides[b.id]) !== null && _a !== void 0 ? _a : {};
            // Render the template against this row's source attributes. On
            // collision append -2, -3 … until unique.
            const base = renderRgTemplate(tmpl, {
                name: b.name,
                rg: rgFromArmId(b.id),
            }) || `${sanitiseForRg(b.name)}-rg`;
            let defaultRg = base;
            let n = 2;
            while (used.has(defaultRg.toLowerCase())) {
                defaultRg = `${base}-${n}`;
                n += 1;
            }
            const finalRg = ((_b = override.destRgName) === null || _b === void 0 ? void 0 : _b.trim()) || defaultRg;
            used.add(finalRg.toLowerCase());
            return {
                resourceId: b.id,
                name: b.name,
                sourceResourceGroup: rgFromArmId(b.id),
                destRgName: finalRg,
                destLocation: ((_c = override.destLocation) === null || _c === void 0 ? void 0 : _c.trim()) || b.location,
                state: "pending",
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
        if (!raw)
            return;
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
            var _a;
            const next = Object.assign({}, prev);
            for (const row of planRows) {
                // Use the rendered (possibly-templated, possibly-overridden)
                // name as the base. Idempotent: re-clicking with the same
                // suffix won't double-append.
                const current = row.destRgName;
                if (current.toLowerCase().endsWith(safeSuffix.toLowerCase()))
                    continue;
                next[row.resourceId] = Object.assign(Object.assign({}, ((_a = next[row.resourceId]) !== null && _a !== void 0 ? _a : {})), { destRgName: `${current}-${safeSuffix}`.replace(/-{2,}/g, "-") });
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
    const applyBulkLocation = React.useCallback((loc) => {
        const safe = loc.trim();
        if (!safe)
            return;
        setPlanOverrides((prev) => {
            var _a;
            const next = Object.assign({}, prev);
            for (const row of planRows) {
                if (row.destLocation === safe)
                    continue;
                next[row.resourceId] = Object.assign(Object.assign({}, ((_a = next[row.resourceId]) !== null && _a !== void 0 ? _a : {})), { destLocation: safe });
            }
            return next;
        });
        store.addNotification({
            type: "info",
            message: `Set destination location to ${safe} on ${planRows.length} row${planRows.length === 1 ? "" : "s"}.`,
        });
    }, [planRows, store]);
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
        if (!key || !value)
            return;
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
            const idx = prev.findIndex((t) => t.key.toLowerCase() === key.toLowerCase());
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
    const removeTag = React.useCallback((key) => {
        setPlanTags((prev) => prev.filter((t) => t.key !== key));
    }, []);
    /**
     * Bulk-action: remove EVERY selected account from the plan. Gated by
     * a confirmation dialog because losing a 30-row plan to a stray
     * click is a multi-minute setback for the operator.
     */
    const bulkRemoveFromSelection = React.useCallback(() => {
        var _a, _b;
        if (planRows.length === 0)
            return;
        const removedIds = planRows.map((r) => r.resourceId);
        setSelected(new Set());
        // Drop overrides for removed rows so a re-selection starts clean.
        setPlanOverrides((prev) => {
            const next = Object.assign({}, prev);
            for (const id of removedIds)
                delete next[id];
            return next;
        });
        // Tags applied uniformly belong to the (now-dropped) plan — clear
        // them too so a fresh selection doesn't inherit yesterday's
        // "owner=…" by accident.
        setPlanTags([]);
        auditLog.record({
            actor: (_a = account === null || account === void 0 ? void 0 : account.username) !== null && _a !== void 0 ? _a : accountId,
            action: "bulk_remove_plan_rows",
            target: (_b = srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId) !== null && _b !== void 0 ? _b : "",
            status: "success",
            details: {
                sourceSubscriptionId: srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId,
                rowCount: removedIds.length,
                rowIds: removedIds,
            },
        });
        setConfirmBulkRemoveOpen(false);
        // setSelected / setPlanOverrides / setConfirmBulkRemoveOpen are
        // React state dispatchers — guaranteed stable, so omitted here.
    }, [planRows, account === null || account === void 0 ? void 0 : account.username, accountId, srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId]);
    const planErrors = React.useMemo(() => {
        const errs = [];
        const seenRg = new Map(); // lowerName -> first resourceId
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
            }
            else {
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
    const crossTenant = React.useMemo(() => !!(srcSub && dstSub && srcSub.tenantId && dstSub.tenantId &&
        srcSub.tenantId.toLowerCase() !== dstSub.tenantId.toLowerCase()), [srcSub, dstSub]);
    /* ----- Security signals ----------------------------------------- *
     * Heuristic warnings sourced from the offensive-tooling corpus —
     * see security-signals.tsx for the rubric. These DO NOT block the
     * action; they surface anti-patterns (bulk cross-RG ops, rename+move
     * sequences, cross-sub fan-out) the same way SOC tooling would. */
    const rowsWithRenameOverride = React.useMemo(() => planRows.reduce((acc, row) => {
        var _a, _b;
        const ov = (_b = (_a = planOverrides[row.resourceId]) === null || _a === void 0 ? void 0 : _a.destRgName) === null || _b === void 0 ? void 0 : _b.trim();
        return ov ? acc + 1 : acc;
    }, 0), [planRows, planOverrides]);
    const distinctDestLocations = React.useMemo(() => new Set(planRows.map((r) => r.destLocation.trim().toLowerCase())).size, [planRows]);
    /* ----- Move execution ------------------------------------------ */
    const [running, setRunning] = React.useState(null);
    const [results, setResults] = React.useState([]);
    // Confirmation dialog state (replaces native window.confirm).
    const [confirmMoveOpen, setConfirmMoveOpen] = React.useState(false);
    // AbortController for in-flight bulk operations. Lets the user cancel a
    // long-running pipeline without losing the per-row status table.
    const abortRef = React.useRef(null);
    /**
     * Run-id correlation. Every kick-off generates a fresh id; async setState
     * callbacks check `currentRunIdRef.current === myRunId` before mutating
     * `results` to prevent a slow-completing row from a cancelled run from
     * stomping the results of a freshly-started one. (See the file header
     * comment for the original race-condition repro.)
     */
    const currentRunIdRef = React.useRef(0);
    /** Start time of the current run for elapsed-time display. */
    const [runStart, setRunStart] = React.useState(null);
    /** Tick state to drive the live-elapsed clock without busy-looping. */
    const [elapsedTick, setElapsedTick] = React.useState(0);
    React.useEffect(() => {
        if (running === null)
            return;
        const id = setInterval(() => setElapsedTick((n) => n + 1), 1000);
        return () => clearInterval(id);
    }, [running]);
    /** Cancel any in-flight bulk operation. Safe to call when nothing is running. */
    const cancelRunning = React.useCallback(() => {
        var _a;
        (_a = abortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
    }, []);
    /**
     * Guarded setResults that drops the write if the run-id has changed
     * since the call was scheduled. Closes the race-window between a slow
     * service-layer call resolving and a new run starting.
     */
    const setResultsForRun = React.useCallback((runId, updater) => {
        if (currentRunIdRef.current !== runId)
            return;
        setResults(updater);
    }, []);
    /**
     * Pre-flight validate every planned row. Doesn't create RGs or call
     * moveResources — only invokes ARM's validateMoveResources endpoint so
     * the operator sees lock/dependency errors before committing. Validation
     * runs against the source RG with the *intended* destination RG ARM id;
     * ARM doesn't require the destination RG to exist for validation.
     */
    const runValidate = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _l;
        if (!srcSub || !dstSub)
            return;
        if (planRows.length === 0)
            return;
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
        setResults(planRows.map((r) => (Object.assign(Object.assign({}, r), { state: "validating", startedAt: Date.now() }))));
        let srcToken;
        try {
            srcToken = yield tokenForTenant(srcSub.tenantId);
        }
        catch (err) {
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
                setResultsForRun(myRunId, (prev) => prev.map((r, idx) => idx >= i && r.state === "validating"
                    ? Object.assign(Object.assign({}, r), { state: "cancelled", finishedAt: Date.now() }) : r));
                break;
            }
            const row = planRows[i];
            const rowStart = Date.now();
            const targetRgArmId = `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${row.destRgName}`;
            let outcome;
            try {
                outcome = yield validateMoveResources(srcSub.subscriptionId, row.sourceResourceGroup, [row.resourceId], targetRgArmId, srcToken);
            }
            catch (err) {
                outcome = {
                    status: 0,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
            const rowElapsed = Date.now() - rowStart;
            if (outcome.ok)
                okCount += 1;
            else
                failCount += 1;
            auditLog.record({
                actor: (_l = account === null || account === void 0 ? void 0 : account.username) !== null && _l !== void 0 ? _l : accountId,
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
            setResultsForRun(myRunId, (prev) => prev.map((r, idx) => idx === i
                ? Object.assign(Object.assign({}, r), { state: outcome.ok ? "success" : "failure", validateOutcome: outcome, finishedAt: Date.now() }) : r));
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
        }
        else {
            store.addNotification({
                type: failCount === 0 ? "success" : failCount === planRows.length ? "error" : "warning",
                message: failCount === 0
                    ? `All ${okCount} row${okCount === 1 ? "" : "s"} passed pre-flight. Safe to run the actual move.`
                    : `${okCount} OK, ${failCount} failed pre-flight. Review the per-row errors before moving.`,
            });
        }
    }), [
        srcSub,
        dstSub,
        planRows,
        planErrors,
        account === null || account === void 0 ? void 0 : account.username,
        accountId,
        store,
        tokenForTenant,
        setResultsForRun,
    ]);
    const runMove = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _m, _o, _p;
        if (!srcSub || !dstSub)
            return;
        if (planRows.length === 0)
            return;
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
        setResults(planRows.map((r) => (Object.assign(Object.assign({}, r), { state: "creating-rg", startedAt: Date.now() }))));
        // Source + dest tenants are guaranteed identical by the crossTenant
        // guard. Acquire one token, reuse for create-RG and move.
        let srcToken;
        try {
            srcToken = yield tokenForTenant(srcSub.tenantId);
        }
        catch (err) {
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
        const movedIds = new Set();
        for (let i = 0; i < planRows.length; i += 1) {
            // Honour any cancel request between rows — stop seeding new work but
            // leave already-finished rows in their final state. Remaining
            // rows get flagged "cancelled" so they don't render as ambiguous
            // greyed-out "creating-rg" badges.
            if (controller.signal.aborted) {
                setResultsForRun(myRunId, (prev) => prev.map((r, idx) => idx >= i &&
                    (r.state === "creating-rg" || r.state === "moving" || r.state === "pending")
                    ? Object.assign(Object.assign({}, r), { state: "cancelled", finishedAt: Date.now() }) : r));
                cancelledCount += planRows.length - i;
                break;
            }
            const row = planRows[i];
            const rowStart = Date.now();
            const targetRgArmId = `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${row.destRgName}`;
            // --- Step 1: create the destination RG --------------------
            let rgCreateError;
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
                    yield createResourceGroup(dstSub.subscriptionId, effectiveRgName, row.destLocation, srcToken);
                    auditLog.record({
                        actor: (_m = account === null || account === void 0 ? void 0 : account.username) !== null && _m !== void 0 ? _m : accountId,
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
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    auditLog.record({
                        actor: (_o = account === null || account === void 0 ? void 0 : account.username) !== null && _o !== void 0 ? _o : accountId,
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
                    const looksLikeCollision = /already exists|alreadyexists|conflict/i.test(msg);
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
                setResultsForRun(myRunId, (prev) => prev.map((r, idx) => idx === i
                    ? Object.assign(Object.assign({}, r), { state: "failure", rgCreateError, destRgName: effectiveRgName, finishedAt: Date.now() }) : r));
                continue; // Skip move if RG create failed.
            }
            // --- Step 2: move that single Batch account ---------------
            setResultsForRun(myRunId, (prev) => prev.map((r, idx) => idx === i
                ? Object.assign(Object.assign({}, r), { state: "moving", destRgName: effectiveRgName }) : r));
            let moveOutcome;
            try {
                moveOutcome = yield moveResources(srcSub.subscriptionId, row.sourceResourceGroup, [row.resourceId], effectiveTargetArm, srcToken);
            }
            catch (err) {
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
            }
            else {
                failedCount += 1;
            }
            auditLog.record({
                actor: (_p = account === null || account === void 0 ? void 0 : account.username) !== null && _p !== void 0 ? _p : accountId,
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
            setResultsForRun(myRunId, (prev) => prev.map((r, idx) => idx === i
                ? Object.assign(Object.assign({}, r), { state: moveOutcome.ok ? "success" : "failure", moveOutcome,
                    newResourceId, destRgName: effectiveRgName, finishedAt: Date.now() }) : r));
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
        }
        else if (failedCount === 0) {
            store.addNotification({
                type: "success",
                message: `Move pipeline finished. ${movedCount} account${movedCount === 1 ? "" : "s"} relocated. Destination subscription may take a few minutes to surface the new resource ids.`,
            });
        }
        else if (movedCount === 0) {
            store.addNotification({
                type: "error",
                message: `Move pipeline finished with no successes. ${failedCount} failed — review the per-row errors.`,
            });
        }
        else {
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
                for (const id of movedIds)
                    next.delete(id);
                return next;
            });
        }
    }), [
        srcSub,
        dstSub,
        planRows,
        planErrors,
        account === null || account === void 0 ? void 0 : account.username,
        accountId,
        store,
        tokenForTenant,
        setResultsForRun,
    ]);
    /* ----- Quick-stat counts (Selected / Validated / Moved / Failed / Cancelled) ---- */
    const stats = React.useMemo(() => {
        const validated = results.filter((r) => r.validateOutcome && r.validateOutcome.ok).length;
        const moved = results.filter((r) => { var _a; return r.state === "success" && ((_a = r.moveOutcome) === null || _a === void 0 ? void 0 : _a.ok); }).length;
        const failed = results.filter((r) => r.state === "failure").length;
        const cancelled = results.filter((r) => r.state === "cancelled").length;
        const inFlight = results.filter((r) => r.state === "validating" ||
            r.state === "creating-rg" ||
            r.state === "moving").length;
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
            return { elapsedMs: 0, etaMs: null };
        }
        const elapsedMs = Date.now() - runStart;
        const finished = results.filter((r) => r.state === "success" || r.state === "failure" || r.state === "cancelled").length;
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
    const matrixExportColumns = React.useMemo(() => [
        { header: "Batch account", accessor: (b) => b.name },
        { header: "Resource ID", accessor: (b) => b.id },
        { header: "Resource group", accessor: (b) => rgFromArmId(b.id) },
        { header: "Location", accessor: (b) => b.location },
        {
            header: "Provisioning state",
            accessor: (b) => { var _a, _b; return (_b = (_a = b.properties) === null || _a === void 0 ? void 0 : _a.provisioningState) !== null && _b !== void 0 ? _b : ""; },
        },
        {
            header: "Dedicated core quota",
            accessor: (b) => { var _a, _b; return (_b = (_a = b.properties) === null || _a === void 0 ? void 0 : _a.dedicatedCoreQuota) !== null && _b !== void 0 ? _b : ""; },
        },
        {
            header: "Low-priority core quota",
            accessor: (b) => { var _a, _b; return (_b = (_a = b.properties) === null || _a === void 0 ? void 0 : _a.lowPriorityCoreQuota) !== null && _b !== void 0 ? _b : ""; },
        },
        {
            header: "Pool quota",
            accessor: (b) => { var _a, _b; return (_b = (_a = b.properties) === null || _a === void 0 ? void 0 : _a.poolQuota) !== null && _b !== void 0 ? _b : ""; },
        },
        {
            header: "Pool allocation mode",
            accessor: (b) => { var _a, _b; return (_b = (_a = b.properties) === null || _a === void 0 ? void 0 : _a.poolAllocationMode) !== null && _b !== void 0 ? _b : ""; },
        },
        {
            header: "Public network access",
            accessor: (b) => { var _a, _b; return (_b = (_a = b.properties) === null || _a === void 0 ? void 0 : _a.publicNetworkAccess) !== null && _b !== void 0 ? _b : ""; },
        },
        {
            header: "Stale (heuristic)",
            accessor: (b) => (isStaleBatchAccount(b) ? "yes" : "no"),
        },
    ], []);
    const planExportColumns = React.useMemo(() => [
        { header: "Batch account", accessor: (r) => r.name },
        { header: "Resource ID", accessor: (r) => r.resourceId },
        { header: "Source RG", accessor: (r) => r.sourceResourceGroup },
        {
            header: "Source subscription",
            accessor: () => { var _a; return (_a = srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId) !== null && _a !== void 0 ? _a : ""; },
        },
        { header: "Destination RG", accessor: (r) => r.destRgName },
        { header: "Destination location", accessor: (r) => r.destLocation },
        {
            header: "Destination subscription",
            accessor: () => { var _a; return (_a = dstSub === null || dstSub === void 0 ? void 0 : dstSub.subscriptionId) !== null && _a !== void 0 ? _a : ""; },
        },
        {
            header: "Predicted ARM ID",
            accessor: (r) => dstSub
                ? `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${r.destRgName}/providers/Microsoft.Batch/batchAccounts/${r.name}`
                : "",
        },
        // Tags rendered as `key=value;key=value` so they fit into a single
        // CSV cell without needing a separate per-tag-pair column.
        {
            header: "Planned tags (key=value;…)",
            accessor: () => planTags.length === 0
                ? ""
                : planTags.map((t) => `${t.key}=${t.value}`).join(";"),
        },
    ], [srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId, dstSub, planTags]);
    const resultsExportColumns = React.useMemo(() => [
        { header: "Batch account", accessor: (r) => r.name },
        { header: "State", accessor: (r) => r.state },
        { header: "Source resource ID", accessor: (r) => r.resourceId },
        { header: "Source RG", accessor: (r) => r.sourceResourceGroup },
        { header: "Destination RG", accessor: (r) => r.destRgName },
        { header: "Destination location", accessor: (r) => r.destLocation },
        { header: "New resource ID", accessor: (r) => { var _a; return (_a = r.newResourceId) !== null && _a !== void 0 ? _a : ""; } },
        {
            header: "Move HTTP status",
            accessor: (r) => { var _a, _b; return (_b = (_a = r.moveOutcome) === null || _a === void 0 ? void 0 : _a.status) !== null && _b !== void 0 ? _b : ""; },
        },
        {
            header: "Elapsed (s)",
            accessor: (r) => r.startedAt && r.finishedAt
                ? Math.round((r.finishedAt - r.startedAt) / 1000)
                : "",
        },
        { header: "RG create error", accessor: (r) => { var _a; return (_a = r.rgCreateError) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Move error", accessor: (r) => { var _a, _b; return (_b = (_a = r.moveOutcome) === null || _a === void 0 ? void 0 : _a.error) !== null && _b !== void 0 ? _b : ""; } },
        {
            header: "Validate error",
            accessor: (r) => { var _a, _b; return (_b = (_a = r.validateOutcome) === null || _a === void 0 ? void 0 : _a.error) !== null && _b !== void 0 ? _b : ""; },
        },
    ], []);
    /**
     * Group selected accounts by source RG. Surfaced in the plan card as a
     * compact summary so the operator can see at a glance how many source
     * RGs they're touching — useful when a "wide" move accidentally pulls
     * accounts from across the whole subscription.
     */
    const sourceRgSummary = React.useMemo(() => {
        var _a;
        const counts = new Map();
        for (const r of planRows) {
            counts.set(r.sourceResourceGroup, ((_a = counts.get(r.sourceResourceGroup)) !== null && _a !== void 0 ? _a : 0) + 1);
        }
        return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [planRows]);
    // Abort any pipeline on unmount so we never trigger setState after unmount.
    React.useEffect(() => () => {
        var _a;
        (_a = abortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
    }, []);
    // React to global tenant-switch events from the shared header /
    // Azure Accounts page so this page's "active account" stays in sync.
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!candidates.some((a) => a.homeAccountId === candidate))
            return;
        if (accountId === candidate)
            return;
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
    useShortcut(["Delete", "Backspace"], () => {
        if (planRows.length === 0 || running !== null)
            return;
        setConfirmBulkRemoveOpen(true);
    }, { enabled: planRows.length > 0 && running === null });
    /* ----- Render --------------------------------------------------- */
    if (candidates.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "Resource Manager", description: "Bulk-move Batch accounts across resource groups / subscriptions." }),
            React.createElement(SignInRequired, { whatYouCantDo: "Move Batch resources", why: "an Azure account with access to both source and destination subscriptions", onNavigate: (k) => navigate(`/${k}`) })));
    }
    const moveable = planRows.length > 0 && planErrors.length === 0 && !crossTenant;
    // Compute the active workflow step for the stepper widget. Each step
    // lights up green once its preconditions are met; the next-pending step
    // pulses to indicate where the operator should look. Purely advisory —
    // no step blocks any other in the underlying state machine.
    const workflowStep = !srcSubId || !dstSubId
        ? 1
        : selected.size === 0
            ? 2
            : planErrors.length > 0 || crossTenant
                ? 3
                : stats.validated === selected.size && selected.size > 0
                    ? 5
                    : 4;
    return (React.createElement("div", { className: "flex flex-col gap-4 py-2" },
        React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
            React.createElement(PageHeader, { title: "Resource Manager", description: "Bulk-move Batch accounts across resource groups / subscriptions. Built on ARM's moveResources API \u2014 same-tenant only; expect 1\u201310 minutes per group." }),
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                    loginHint: account === null || account === void 0 ? void 0 : account.username,
                }) })),
        React.createElement("ol", { className: "flex flex-wrap items-center gap-1 rounded-md border border-border bg-card/40 px-3 py-2 text-2xs", "aria-label": "Resource Manager workflow progress" }, [
            { n: 1, label: "Scope", icon: Building2 },
            { n: 2, label: "Select", icon: Cpu },
            { n: 3, label: "Plan RGs", icon: FolderTree },
            { n: 4, label: "Validate", icon: ShieldCheck },
            { n: 5, label: "Move", icon: ArrowRight },
        ].map((step, i, arr) => {
            const done = workflowStep > step.n;
            const active = workflowStep === step.n;
            const Icon = step.icon;
            return (React.createElement(React.Fragment, { key: step.n },
                React.createElement("li", { className: "inline-flex items-center gap-1 rounded px-1.5 py-0.5 " +
                        (done
                            ? "bg-success/10 text-success"
                            : active
                                ? "bg-primary/15 text-primary font-medium"
                                : "text-muted-foreground"), "aria-current": active ? "step" : undefined },
                    done ? (React.createElement(CheckCircle2, { className: "h-3 w-3", "aria-hidden": true })) : (React.createElement(Icon, { className: "h-3 w-3", "aria-hidden": true })),
                    React.createElement("span", null,
                        step.n,
                        ". ",
                        step.label)),
                i < arr.length - 1 && (React.createElement(ArrowRight, { className: "h-2.5 w-2.5 text-muted-foreground/50", "aria-hidden": true }))));
        })),
        React.createElement("div", { className: "flex flex-wrap items-stretch gap-2", role: "group", "aria-label": "Resource Manager summary" },
            React.createElement(SummaryStatItem, { label: "Selected", value: stats.selected, tone: stats.selected > 0 ? "info" : "muted", compact: true, hint: `of ${batchAccounts.length} loaded` }),
            React.createElement(SummaryStatItem, { label: running !== null ? "In flight" : "Validated", value: running !== null ? stats.inFlight : stats.validated, tone: running !== null
                    ? "info"
                    : stats.validated > 0
                        ? "success"
                        : "muted", compact: true, hint: running !== null ? "running…" : "pre-flight passed" }),
            React.createElement(SummaryStatItem, { label: "Moved", value: stats.moved, tone: stats.moved > 0 ? "success" : "muted", compact: true, hint: "this session" }),
            React.createElement(SummaryStatItem, { label: "Failed", value: stats.failed, tone: stats.failed > 0 ? "destructive" : "muted", compact: true, hint: "see results" }),
            staleAccounts.length > 0 && (React.createElement("button", { type: "button", onClick: () => setStaleOnly((v) => !v), "aria-pressed": staleOnly, "aria-label": staleOnly
                    ? `Stale-only filter on — ${staleAccounts.length} accounts flagged. Click to clear.`
                    : `${staleAccounts.length} stale-looking accounts. Click to filter to only these.`, className: "rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", title: staleOnly
                    ? "Click to clear the stale-only filter"
                    : "Click to filter the list to only stale-looking accounts" },
                React.createElement(SummaryStatItem, { label: "Stale", value: staleAccounts.length, tone: staleOnly ? "warning" : "muted", compact: true, hint: staleOnly ? "filter active" : "click to filter" }))),
            stats.cancelled > 0 && (React.createElement(SummaryStatItem, { label: "Cancelled", value: stats.cancelled, tone: "warning", compact: true, hint: "not started" })),
            running !== null && runStart !== null && (React.createElement(SummaryStatItem, { label: "Elapsed", value: fmtElapsed(runTimer.elapsedMs), tone: "info", compact: true, hint: runTimer.etaMs !== null
                    ? `~${fmtElapsed(runTimer.etaMs)} left`
                    : "starting…" }))),
        React.createElement(Card, null,
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Building2, { className: "h-4 w-4 text-primary" }),
                    "Scope",
                    React.createElement(InfoTooltip, { content: "The signed-in account performs every ARM call. Subscriptions list comes from every tenant the account belongs to (aggregated). Cross-tenant moves are rejected by ARM \u2014 the destination subscription must live in the same tenant as the source.", ariaLabel: "About scope selection" })),
                React.createElement(CardDescription, null, "Pick the signed-in account that will run the ARM calls, then the source and destination subscriptions.")),
            React.createElement(CardContent, { className: "grid grid-cols-1 gap-3 sm:grid-cols-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Source account"),
                    React.createElement(Select, { value: accountId, onValueChange: setAccountId },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: "Pick an account" })),
                        React.createElement(SelectContent, null, candidates.map((c) => (React.createElement(SelectItem, { key: c.homeAccountId, value: c.homeAccountId },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, c.name),
                                React.createElement("span", { className: "text-2xs text-muted-foreground" }, c.username)))))))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "inline-flex items-center gap-1 text-xs" },
                        "Source subscription",
                        srcSub && (React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                            "tenant ",
                            srcSub.tenantId.slice(0, 8),
                            "\u2026"))),
                    React.createElement(Select, { value: srcSubId, onValueChange: setSrcSubId, disabled: subsLoading },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: subsLoading ? "Loading…" : "Pick source" })),
                        React.createElement(SelectContent, null, subs.map((s) => (React.createElement(SelectItem, { key: s.subscriptionId, value: s.subscriptionId },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, s.displayName),
                                React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" }, s.subscriptionId)))))))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "inline-flex items-center gap-1 text-xs" },
                        "Destination subscription",
                        dstSub && (React.createElement(Badge, { variant: srcSub &&
                                srcSub.tenantId.toLowerCase() !==
                                    dstSub.tenantId.toLowerCase()
                                ? "destructive"
                                : "outline", className: "text-2xs" },
                            "tenant ",
                            dstSub.tenantId.slice(0, 8),
                            "\u2026"))),
                    React.createElement(Select, { value: dstSubId, onValueChange: setDstSubId, disabled: subsLoading },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: subsLoading ? "Loading…" : "Pick destination" })),
                        React.createElement(SelectContent, null, subs.map((s) => (React.createElement(SelectItem, { key: s.subscriptionId, value: s.subscriptionId },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, s.displayName),
                                React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" }, s.subscriptionId))))))))),
            srcSubId && dstSubId && srcSubId !== dstSubId && (React.createElement(CardContent, { className: "pt-0" },
                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", disabled: running !== null, onClick: () => {
                        const a = srcSubId;
                        const b = dstSubId;
                        setSrcSubId(b);
                        setDstSubId(a);
                        store.addNotification({
                            type: "info",
                            message: "Swapped source and destination subscriptions.",
                        });
                    }, "aria-label": "Swap source and destination subscriptions" },
                    React.createElement(RefreshCw, { className: "h-3 w-3" }),
                    "Swap source \u2194 destination"))),
            subsError && (React.createElement(CardContent, null,
                React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertDescription, null, subsError))))),
        !srcSubId || !dstSubId ? (React.createElement(EmptyState, { icon: ArrowRight, title: "Pick source & destination subscriptions", description: "Once you choose both, the Batch accounts in the source appear below and you can pick the destination resource group." })) : (React.createElement(React.Fragment, null,
            crossTenant && srcSub && dstSub && (React.createElement(Alert, { variant: "destructive" },
                React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                React.createElement(AlertDescription, null,
                    "Cross-tenant move not supported by ARM. Source sub lives in tenant",
                    " ",
                    React.createElement("code", { className: "font-mono" }, srcSub.tenantId),
                    ", destination in",
                    " ",
                    React.createElement("code", { className: "font-mono" }, dstSub.tenantId),
                    ". Move both subs to the same tenant first, or pick different subscriptions."))),
            React.createElement(Card, null,
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex flex-wrap items-center gap-2 text-sm" },
                        React.createElement(Cpu, { className: "h-4 w-4 text-primary" }),
                        "Batch accounts in source",
                        React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            selected.size,
                            "/",
                            batchAccounts.length,
                            " selected")),
                    React.createElement(CardDescription, null, "Tick the rows to move. Bulk mode \u2014 selection is preserved across filter changes.")),
                React.createElement(CardContent, { className: "flex flex-col gap-2" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement("div", { className: "relative flex-1 min-w-[200px]" },
                            React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                            React.createElement(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search by name, RG, location, status\u2026 (space-separated tokens; all must match)", className: "pl-8 pr-8 text-xs focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Search Batch accounts (multi-token AND)" }),
                            search && (React.createElement("button", { type: "button", onClick: () => setSearch(""), className: "absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded", "aria-label": "Clear search" },
                                React.createElement(X, { className: "h-3 w-3" })))),
                        React.createElement(Select, { value: sort, onValueChange: (v) => setSort(v) },
                            React.createElement(SelectTrigger, { className: "h-7 w-[140px] text-2xs", "aria-label": "Sort Batch accounts" },
                                React.createElement(SelectValue, null)),
                            React.createElement(SelectContent, null,
                                React.createElement(SelectItem, { value: "name-asc" }, "Name A \u2192 Z"),
                                React.createElement(SelectItem, { value: "name-desc" }, "Name Z \u2192 A"),
                                React.createElement(SelectItem, { value: "rg-asc" }, "Source RG"),
                                React.createElement(SelectItem, { value: "location-asc" }, "Location"),
                                React.createElement(SelectItem, { value: "state-asc" }, "State"))),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: selectAllVisible, disabled: filtered.length === 0, "aria-label": `Select all ${filtered.length} visible Batch account${filtered.length === 1 ? "" : "s"}`, title: "Add every visible row to the selection (existing selections in hidden rows are preserved)" },
                            React.createElement(PackagePlus, { className: "h-3 w-3" }),
                            "Select visible"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: invertVisible, disabled: filtered.length === 0, "aria-label": "Invert selection for visible accounts", title: "Flip checked/unchecked for every visible row" }, "Invert"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: clearSelection, disabled: selected.size === 0, "aria-label": "Clear all selected accounts" },
                            React.createElement(PackageMinus, { className: "h-3 w-3" }),
                            "Clear"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: () => void copySelectedIds(), disabled: selected.size === 0, "aria-label": `Copy ${selected.size} selected ARM resource id${selected.size === 1 ? "" : "s"} to clipboard`, title: "Copy every selected account's ARM id (one per line)" },
                            React.createElement(Copy, { className: "h-3 w-3" }),
                            "Copy IDs"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: reload, disabled: batchLoading, "aria-label": "Refresh Batch accounts list" },
                            React.createElement(RefreshCw, { className: "h-3 w-3 motion-reduce:animate-none " +
                                    (batchLoading ? "animate-spin" : "") }),
                            "Refresh"),
                        batchAccounts.length > 0 && (React.createElement(ExportMenu, { rows: batchAccounts, columns: matrixExportColumns, filename: srcSub
                                ? `resource-manager-matrix-${srcSub.subscriptionId.slice(0, 8)}`
                                : "resource-manager-matrix", label: "Export matrix", jsonMetadata: {
                                sourceSubscriptionId: srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId,
                                sourceTenantId: srcSub === null || srcSub === void 0 ? void 0 : srcSub.tenantId,
                                totalAccounts: batchAccounts.length,
                                staleAccounts: staleAccounts.length,
                                stateBuckets,
                                exportedAt: new Date().toISOString(),
                                exportedBy: (_b = account === null || account === void 0 ? void 0 : account.username) !== null && _b !== void 0 ? _b : accountId,
                            } }))),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Filter Batch accounts by state" },
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
                        ].map((chip) => {
                            const active = quickFilter === chip.value;
                            return (React.createElement(Button, { key: chip.value, type: "button", variant: active ? "default" : "outline", size: "sm", className: "h-6 gap-1 px-2 text-2xs focus-visible:ring-2 focus-visible:ring-ring", onClick: () => setQuickFilter(chip.value), "aria-pressed": active, "aria-label": `Filter: ${chip.label} (${chip.count})` },
                                chip.label,
                                React.createElement(Badge, { variant: active ? "secondary" : "outline", className: "text-2xs" }, chip.count)));
                        }),
                        React.createElement(Button, { type: "button", variant: staleOnly ? "default" : "outline", size: "sm", className: "h-6 gap-1 px-2 text-2xs focus-visible:ring-2 focus-visible:ring-ring", onClick: () => setStaleOnly((v) => !v), "aria-pressed": staleOnly, "aria-label": `${staleOnly ? "Disable" : "Enable"} stale-only filter (persisted across reloads)`, title: "Toggle a persistent filter that restricts the list to stale-looking accounts.", disabled: staleAccounts.length === 0 },
                            React.createElement(Ghost, { className: "h-3 w-3", "aria-hidden": true }),
                            "Stale only",
                            React.createElement(Badge, { variant: staleOnly ? "secondary" : "outline", className: "text-2xs" }, staleAccounts.length))),
                    batchLoading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 4 })) : batchError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load Batch accounts.", detail: batchError, onRetry: reload })) : batchAccounts.length === 0 ? (React.createElement(EmptyState, { icon: Server, size: "compact", title: "No Batch accounts in this subscription", description: "Pick a different source subscription, or create a Batch account first via the Account Provisioning page." })) : filtered.length === 0 ? (React.createElement(EmptyState, { icon: Search, size: "compact", title: "No accounts match the current filter", description: "Clear the search box or switch the quick-filter chip to 'All' to see every account.", action: {
                            label: "Clear filters",
                            onClick: () => {
                                setSearch("");
                                setQuickFilter("all");
                            },
                        } })) : (React.createElement("ul", { className: "flex flex-col gap-1", "aria-label": `${filtered.length} Batch account${filtered.length === 1 ? "" : "s"} matching the current filter` }, filtered.map((b) => {
                        var _a;
                        const rg = rgFromArmId(b.id);
                        const isSelected = selected.has(b.id);
                        return (React.createElement("li", { key: b.id, className: "flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs focus-within:ring-2 focus-within:ring-ring transition-colors " +
                                (isSelected
                                    ? "border-primary/50 bg-primary/5"
                                    : "border-border hover:border-border/80 hover:bg-accent/5") },
                            React.createElement(Checkbox, { "aria-label": `${isSelected ? "Deselect" : "Select"} ${b.name}`, checked: isSelected, onCheckedChange: () => toggle(b.id), disabled: running !== null }),
                            React.createElement(Server, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                            React.createElement("span", { className: "font-medium" }, b.name),
                            React.createElement(Badge, { variant: "outline", className: "text-2xs" }, b.location),
                            React.createElement(CopyableText, { value: b.id, display: React.createElement("span", null,
                                    "rg: ",
                                    rg || "—"), mono: true, ariaLabel: `Copy ARM resource id for ${b.name}` }),
                            ((_a = b.properties) === null || _a === void 0 ? void 0 : _a.provisioningState) && (React.createElement(StatusBadge, { status: b.properties.provisioningState })),
                            React.createElement("a", { href: portalUrlForBatchAccount(b.id), target: "_blank", rel: "noopener noreferrer", className: "ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs text-muted-foreground hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Open ${b.name} in Azure Portal`, title: "Open in Azure Portal" },
                                React.createElement(ExternalLink, { className: "h-3 w-3" }),
                                "Portal")));
                    }))))),
            planRows.length > 0 && (React.createElement(Card, { className: "border-primary/40" },
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex flex-wrap items-center gap-2 text-sm" },
                        React.createElement(FolderTree, { className: "h-4 w-4 text-primary" }),
                        "RG plan (",
                        planRows.length,
                        " new resource group",
                        planRows.length === 1 ? "" : "s",
                        ")",
                        React.createElement(InfoTooltip, { content: React.createElement("div", { className: "space-y-1" },
                                React.createElement("p", { className: "m-0" }, "Each row creates a fresh resource group in the destination subscription, then runs ARM moveResources to relocate one Batch account into it. The destination RG is created via PUT (idempotent for the same name+location); on conflict we auto-suffix the name -2, -3, \u2026 up to 5 retries."),
                                React.createElement("p", { className: "m-0" },
                                    "Names are rendered from the template above the table \u2014 supported placeholders: ",
                                    React.createElement("code", null, `{name}`),
                                    " ",
                                    "and ",
                                    React.createElement("code", null, `{rg}`),
                                    ". Inline edits in the table override the template per row.")), ariaLabel: "About the RG plan" }),
                        sourceRgSummary.length > 0 && (React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                            React.createElement(Layers, { className: "mr-0.5 h-2.5 w-2.5" }),
                            sourceRgSummary.length,
                            " source RG",
                            sourceRgSummary.length === 1 ? "" : "s")),
                        React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                            React.createElement(ExportMenu, { rows: planRows, columns: planExportColumns, filename: "resource-manager-plan", label: "Export plan", jsonMetadata: {
                                    sourceSubscriptionId: srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId,
                                    destinationSubscriptionId: dstSub === null || dstSub === void 0 ? void 0 : dstSub.subscriptionId,
                                    sourceRgs: sourceRgSummary.map(([rg, count]) => ({ resourceGroup: rg, accountCount: count })),
                                    rgTemplate,
                                    // Tags are plan-only today (services-layer change
                                    // required to forward into RG create). Surface them
                                    // in the export so the operator can `az tag update`
                                    // post-move from the same JSON they exported.
                                    plannedTags: planTags.length === 0
                                        ? undefined
                                        : Object.fromEntries(planTags.map((t) => [t.key, t.value])),
                                    // Snapshot of the security-signal heuristic
                                    // outcomes at export time — gives reviewers a
                                    // paper trail of what the operator was warned
                                    // about before kicking off the move.
                                    securitySignals: {
                                        planRowCount: planRows.length,
                                        distinctSourceRgs: sourceRgSummary.length,
                                        distinctDestLocations,
                                        rowsWithRenameOverride,
                                        crossSubscription: (srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId) !==
                                            (dstSub === null || dstSub === void 0 ? void 0 : dstSub.subscriptionId),
                                        crossTenant,
                                    },
                                } }))),
                    React.createElement(CardDescription, null,
                        "Each selected Batch account gets its OWN destination RG in subscription",
                        " ",
                        React.createElement("code", { className: "font-mono text-2xs" }, dstSub === null || dstSub === void 0 ? void 0 : dstSub.subscriptionId),
                        ". The RG is created before the move and only one Batch account ever lands in each RG. Default name template below; override per row in the table.")),
                React.createElement(CardContent, { className: "flex flex-col gap-2" },
                    sourceRgSummary.length > 1 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1 text-2xs" },
                        React.createElement("span", { className: "text-muted-foreground" }, "From:"),
                        sourceRgSummary.map(([rg, count]) => (React.createElement(Badge, { key: rg, variant: "outline", className: "font-mono", title: `${count} account${count === 1 ? "" : "s"} live in ${rg}` },
                            rg,
                            " ",
                            React.createElement("span", { className: "ml-1 text-muted-foreground" },
                                "\u00D7",
                                count)))))),
                    React.createElement("div", { className: "flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border bg-muted/20 p-2" },
                        React.createElement("div", { className: "flex flex-1 flex-col gap-1 min-w-[200px]" },
                            React.createElement(Label, { className: "inline-flex items-center gap-1 text-2xs" },
                                React.createElement(Wand2, { className: "h-3 w-3" }),
                                "RG-name template",
                                React.createElement(InfoTooltip, { size: 11, content: React.createElement("div", { className: "space-y-1" },
                                        React.createElement("p", { className: "m-0" }, "Pattern for the default destination RG name. Two placeholders are supported (case-insensitive):"),
                                        React.createElement("ul", { className: "m-0 list-disc pl-4" },
                                            React.createElement("li", null,
                                                React.createElement("code", null, `{name}`),
                                                " \u2014 Batch account name"),
                                            React.createElement("li", null,
                                                React.createElement("code", null, `{rg}`),
                                                " \u2014 source RG name")),
                                        React.createElement("p", { className: "m-0" }, "Unknown placeholders are left literal. Per-row edits in the table override the template.")), ariaLabel: "About the RG-name template" })),
                            React.createElement(Input, { value: rgTemplate, onChange: (e) => setRgTemplate(e.target.value), placeholder: DEFAULT_RG_TEMPLATE, className: "h-7 font-mono text-2xs", disabled: running !== null, "aria-label": "Destination RG name template" })),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-1" }, [
                            { label: "{name}-rg", value: "{name}-rg" },
                            { label: "mig-{name}", value: "mig-{name}" },
                            { label: "{rg}-moved", value: "{rg}-moved" },
                            {
                                label: "rg-{name}-2026",
                                value: "rg-{name}-2026",
                            },
                        ].map((preset) => (React.createElement(Button, { key: preset.value, type: "button", variant: rgTemplate === preset.value ? "default" : "outline", size: "xs", onClick: () => setRgTemplate(preset.value), disabled: running !== null, "aria-label": `Use template ${preset.label}` }, preset.label))))),
                    React.createElement("div", { className: "flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border bg-muted/10 p-2", role: "toolbar", "aria-label": "Bulk actions for the RG plan" },
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { htmlFor: "rm-bulk-suffix", className: "text-2xs text-muted-foreground" }, "Bulk suffix"),
                            React.createElement("div", { className: "flex items-center gap-1" },
                                React.createElement(Input, { id: "rm-bulk-suffix", value: bulkSuffix, onChange: (e) => setBulkSuffix(e.target.value), placeholder: "-prod, -dr, \u2026", className: "h-7 w-32 font-mono text-2xs", disabled: running !== null, "aria-label": "Suffix to append to every destination RG name" }),
                                React.createElement(Button, { type: "button", size: "xs", variant: "outline", onClick: applyBulkSuffix, disabled: running !== null || !bulkSuffix.trim(), "aria-label": `Append "${bulkSuffix.trim() || "(empty)"}" to ${planRows.length} destination RG name${planRows.length === 1 ? "" : "s"}` }, "Apply to all"))),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { className: "text-2xs text-muted-foreground" }, "Bulk location"),
                            React.createElement("div", { className: "flex flex-wrap items-center gap-1" }, ["eastus", "westeurope", "westus2", "southeastasia"].map((loc) => (React.createElement(Button, { key: loc, type: "button", size: "xs", variant: "outline", onClick: () => applyBulkLocation(loc), disabled: running !== null, "aria-label": `Set destination location to ${loc} on all rows` }, loc))))),
                        React.createElement("div", { className: "ml-auto flex flex-col gap-1" },
                            React.createElement(Label, { className: "text-2xs text-muted-foreground inline-flex items-center gap-1" },
                                React.createElement(Keyboard, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                                "Hotkeys"),
                            React.createElement("div", { className: "flex flex-wrap items-center gap-1 text-2xs text-muted-foreground", "aria-label": "Keyboard shortcuts for the plan" },
                                React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 font-mono text-[10px]" }, "r"),
                                React.createElement("span", null, "rename"),
                                React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 font-mono text-[10px]" }, "m"),
                                React.createElement("span", null, "move-region"),
                                React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 font-mono text-[10px]" }, "Del"),
                                React.createElement("span", null, "drop"))),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { className: "text-2xs text-muted-foreground" }, "Bulk remove"),
                            React.createElement(Button, { type: "button", size: "xs", variant: "destructive", onClick: () => setConfirmBulkRemoveOpen(true), disabled: running !== null || planRows.length === 0, "aria-label": `Remove all ${planRows.length} rows from the plan`, title: "Drop every planned row from the selection (no Azure side-effects). Confirmation required. Hotkey: Del." },
                                React.createElement(Trash2, { className: "h-3 w-3", "aria-hidden": true }),
                                "Drop ",
                                planRows.length,
                                " row",
                                planRows.length === 1 ? "" : "s"))),
                    React.createElement("div", { className: "flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border bg-muted/10 p-2", role: "group", "aria-label": "Plan-time tags applied to every destination resource group" },
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { htmlFor: "rm-tag-key", className: "text-2xs text-muted-foreground inline-flex items-center gap-1" },
                                React.createElement(Tag, { className: "h-3 w-3", "aria-hidden": true }),
                                "Tag key"),
                            React.createElement(Input, { id: "rm-tag-key", list: "rm-tag-key-suggestions", value: draftTagKey, onChange: (e) => setDraftTagKey(e.target.value), onKeyDown: (e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        commitTag();
                                    }
                                }, placeholder: "project, owner, cost-center\u2026", className: "h-7 w-40 font-mono text-2xs", disabled: running !== null, "aria-label": "Tag key to apply to every destination RG" }),
                            recentTagKeys.length > 0 && (React.createElement("datalist", { id: "rm-tag-key-suggestions" }, recentTagKeys.map((k) => (React.createElement("option", { key: k, value: k })))))),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { htmlFor: "rm-tag-value", className: "text-2xs text-muted-foreground" }, "Tag value"),
                            React.createElement(Input, { id: "rm-tag-value", value: draftTagValue, onChange: (e) => setDraftTagValue(e.target.value), onKeyDown: (e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        commitTag();
                                    }
                                }, placeholder: "value", className: "h-7 w-40 font-mono text-2xs", disabled: running !== null, "aria-label": "Tag value to apply to every destination RG" })),
                        React.createElement(Button, { type: "button", size: "xs", variant: "outline", onClick: commitTag, disabled: running !== null ||
                                !draftTagKey.trim() ||
                                !draftTagValue.trim(), "aria-label": "Add tag to plan" }, "Add tag"),
                        planTags.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1", "aria-label": `${planTags.length} planned tag pair${planTags.length === 1 ? "" : "s"}` }, planTags.map((t) => (React.createElement(Badge, { key: t.key, variant: "secondary", className: "gap-1 font-mono text-2xs", title: `Will apply ${t.key}=${t.value} to every destination RG` },
                            t.key,
                            "=",
                            t.value,
                            React.createElement("button", { type: "button", onClick: () => removeTag(t.key), disabled: running !== null, className: "inline-flex h-3.5 w-3.5 items-center justify-center rounded hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40", "aria-label": `Remove tag ${t.key}` },
                                React.createElement(X, { className: "h-2.5 w-2.5" })))))))),
                    React.createElement("div", { className: "overflow-x-auto" },
                        React.createElement("table", { className: "w-full text-2xs" },
                            React.createElement("thead", null,
                                React.createElement("tr", { className: "border-b border-border text-left text-muted-foreground" },
                                    React.createElement("th", { className: "px-2 py-1 font-medium" }, "Batch account"),
                                    React.createElement("th", { className: "px-2 py-1 font-medium" }, "Source RG"),
                                    React.createElement("th", { className: "px-2 py-1 font-medium" },
                                        React.createElement("span", { className: "inline-flex items-center gap-1" },
                                            React.createElement(ArrowRight, { className: "h-2.5 w-2.5" }),
                                            " New RG",
                                            React.createElement(InfoTooltip, { size: 11, content: "Rendered from the template above. On submit, if the name already exists in the destination, we retry with a numeric suffix (-2, -3, \u2026) up to 5 times. Edit inline to override per row.", ariaLabel: "About auto-naming the destination resource group" }))),
                                    React.createElement("th", { className: "px-2 py-1 font-medium" },
                                        React.createElement("span", { className: "inline-flex items-center gap-1" },
                                            "Location",
                                            React.createElement(InfoTooltip, { size: 11, content: "Azure region for the new RG (e.g. eastus, westeurope). Defaults to the source Batch account's region. The destination subscription must have Microsoft.Batch registered as a provider in this region.", ariaLabel: "About provider registration for the destination region" }))),
                                    React.createElement("th", { className: "px-2 py-1 font-medium text-right" }, "Predicted new ARM ID"),
                                    React.createElement("th", { className: "px-2 py-1 font-medium", "aria-label": "Remove row" }))),
                            React.createElement("tbody", null, planRows.map((row, rowIdx) => {
                                var _a, _b;
                                const rowErrors = planErrors.filter((e) => e.resourceId === row.resourceId);
                                const predictedArm = dstSub
                                    ? `/subscriptions/${dstSub.subscriptionId}/resourceGroups/${row.destRgName}/providers/Microsoft.Batch/batchAccounts/${row.name}`
                                    : "";
                                const hasOverride = !!((_a = planOverrides[row.resourceId]) === null || _a === void 0 ? void 0 : _a.destRgName) ||
                                    !!((_b = planOverrides[row.resourceId]) === null || _b === void 0 ? void 0 : _b.destLocation);
                                const isFirstRow = rowIdx === 0;
                                return (React.createElement("tr", { key: row.resourceId, className: "border-b border-border/50 " +
                                        (rowErrors.length > 0
                                            ? "bg-destructive/5"
                                            : hasOverride
                                                ? "bg-warning/5"
                                                : "") },
                                    React.createElement("td", { className: "px-2 py-1" },
                                        React.createElement("div", { className: "flex flex-col" },
                                            React.createElement("span", { className: "inline-flex items-center gap-1 font-medium", title: "Click the icon to copy the full source ARM id" },
                                                row.name,
                                                React.createElement(CopyButton, { value: row.resourceId, ariaLabel: `Copy ARM resource id for ${row.name}`, alwaysVisible: true })),
                                            React.createElement("span", { className: "text-[10px] text-muted-foreground" },
                                                "source location:",
                                                " ",
                                                React.createElement("span", { className: "font-mono" }, row.destLocation)))),
                                    React.createElement("td", { className: "px-2 py-1 font-mono text-muted-foreground" }, row.sourceResourceGroup),
                                    React.createElement("td", { className: "px-2 py-1" },
                                        React.createElement("div", { className: "flex items-center gap-1" },
                                            React.createElement(Input, { ref: isFirstRow
                                                    ? firstRgNameInputRef
                                                    : undefined, value: row.destRgName, onChange: (e) => setPlanOverrides((prev) => {
                                                    var _a;
                                                    return (Object.assign(Object.assign({}, prev), { [row.resourceId]: Object.assign(Object.assign({}, ((_a = prev[row.resourceId]) !== null && _a !== void 0 ? _a : {})), { destRgName: e.target.value }) }));
                                                }), className: "h-7 w-56 font-mono text-2xs " +
                                                    (rowErrors.length > 0
                                                        ? "border-destructive focus-visible:ring-destructive"
                                                        : ""), disabled: running !== null, "aria-invalid": rowErrors.length > 0 ? true : undefined, "aria-label": `Destination RG name for ${row.name}` }),
                                            hasOverride && (React.createElement(InfoTooltip, { size: 11, variant: "info", content: "This row has a manual override \u2014 it ignores the bulk template above.", ariaLabel: "Manual override" })))),
                                    React.createElement("td", { className: "px-2 py-1" },
                                        React.createElement(Input, { ref: isFirstRow
                                                ? firstRgLocationInputRef
                                                : undefined, value: row.destLocation, onChange: (e) => setPlanOverrides((prev) => {
                                                var _a;
                                                return (Object.assign(Object.assign({}, prev), { [row.resourceId]: Object.assign(Object.assign({}, ((_a = prev[row.resourceId]) !== null && _a !== void 0 ? _a : {})), { destLocation: e.target.value }) }));
                                            }), className: "h-7 w-32 font-mono text-2xs", disabled: running !== null, "aria-label": `Destination location for ${row.name}` })),
                                    React.createElement("td", { className: "px-2 py-1 text-right" }, predictedArm && (React.createElement("div", { className: "flex items-center justify-end gap-1" },
                                        React.createElement("span", { className: "font-mono text-muted-foreground truncate max-w-[260px] inline-block align-middle", title: predictedArm },
                                            "\u2026/",
                                            row.destRgName,
                                            "/\u2026/",
                                            row.name),
                                        React.createElement(CopyButton, { value: predictedArm, ariaLabel: `Copy predicted ARM id for ${row.name}`, alwaysVisible: true })))),
                                    React.createElement("td", { className: "px-2 py-1 text-right" },
                                        React.createElement("button", { type: "button", onClick: () => toggle(row.resourceId), disabled: running !== null, className: "inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed", "aria-label": `Remove ${row.name} from selection`, title: "Remove from selection" },
                                            React.createElement(Trash2, { className: "h-3 w-3" })))));
                            })))),
                    planErrors.length > 0 && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, null,
                            React.createElement("ul", { className: "list-disc pl-4 text-2xs" },
                                planErrors.slice(0, 6).map((e, i) => {
                                    var _a, _b;
                                    return (React.createElement("li", { key: i },
                                        React.createElement("code", { className: "font-mono" }, (_b = (_a = planRows.find((r) => r.resourceId === e.resourceId)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : e.resourceId),
                                        " ",
                                        "\u2014 ",
                                        e.message));
                                }),
                                planErrors.length > 6 && (React.createElement("li", null,
                                    "\u2026 and ",
                                    planErrors.length - 6,
                                    " more")))))),
                    React.createElement(PreMoveAttackSurfacePreview, null),
                    React.createElement(SecuritySignalsBanner, { planRowCount: planRows.length, distinctSourceRgs: sourceRgSummary.length, distinctDestLocations: distinctDestLocations, sourceSubscriptionId: (_c = srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId) !== null && _c !== void 0 ? _c : null, destinationSubscriptionId: (_d = dstSub === null || dstSub === void 0 ? void 0 : dstSub.subscriptionId) !== null && _d !== void 0 ? _d : null, sourceTenantId: (_e = srcSub === null || srcSub === void 0 ? void 0 : srcSub.tenantId) !== null && _e !== void 0 ? _e : null, destinationTenantId: (_f = dstSub === null || dstSub === void 0 ? void 0 : dstSub.tenantId) !== null && _f !== void 0 ? _f : null, rowsWithRenameOverride: rowsWithRenameOverride }),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Button, { type: "button", variant: "outline", onClick: () => void runValidate(), disabled: !moveable || running !== null, loading: running === "validate", "aria-label": `Validate move for ${planRows.length} account${planRows.length === 1 ? "" : "s"}` },
                            running !== "validate" && React.createElement(ShieldCheck, null),
                            running === "validate"
                                ? "Validating…"
                                : `Validate ${planRows.length}`),
                        React.createElement(InfoTooltip, { content: "Pre-flight check that calls ARM's validateMoveResources endpoint. No RGs are created, no resources are moved \u2014 surfaces lock/dependency errors before you commit.", ariaLabel: "About Validate move" }),
                        React.createElement(Button, { type: "button", variant: "default", onClick: () => {
                                if (planErrors.length > 0) {
                                    store.addNotification({
                                        type: "error",
                                        message: `Fix ${planErrors.length} plan error${planErrors.length === 1 ? "" : "s"} above before moving.`,
                                    });
                                    return;
                                }
                                setConfirmMoveOpen(true);
                            }, disabled: !moveable || running !== null, loading: running === "move", "aria-label": `Create ${planRows.length} resource groups and move accounts` },
                            running !== "move" && React.createElement(ArrowRight, null),
                            running === "move"
                                ? "Creating RGs & moving…"
                                : `Create ${planRows.length} RG${planRows.length === 1 ? "" : "s"} & move`),
                        running !== null && (React.createElement(Button, { type: "button", variant: "destructive", size: "sm", onClick: cancelRunning, "aria-label": `Cancel in-flight ${running} pipeline`, title: "Stop the pipeline at the next row boundary. Already-completed rows are not rolled back." },
                            React.createElement(X, { className: "h-3 w-3" }),
                            "Cancel run")),
                        stats.validated > 0 && running === null && (React.createElement(Badge, { variant: "success", className: "text-2xs" },
                            React.createElement(CheckCircle2, { className: "mr-0.5 h-2.5 w-2.5" }),
                            stats.validated,
                            "/",
                            planRows.length,
                            " pre-flight passed")),
                        React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setPlanOverrides({}), disabled: running !== null || Object.keys(planOverrides).length === 0, "aria-label": "Reset all destination RG name and location overrides to the template defaults", title: "Wipe per-row overrides and re-apply the bulk template" },
                                React.createElement(Sparkles, { className: "h-3 w-3" }),
                                "Reset to template"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearSelection, disabled: running !== null || selected.size === 0, "aria-label": "Clear all selections and remove plan" },
                                React.createElement(PackageMinus, { className: "h-3 w-3" }),
                                "Clear plan")))))),
            results.length > 0 && (React.createElement(Card, null,
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex flex-wrap items-center gap-2 text-sm" },
                        React.createElement(ListChecks, { className: "h-4 w-4 text-primary" }),
                        "Operation results",
                        React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            results.length,
                            " row",
                            results.length === 1 ? "" : "s"),
                        stats.moved > 0 && (React.createElement(Badge, { variant: "success", className: "text-2xs" },
                            React.createElement(CheckCircle2, { className: "mr-0.5 h-2.5 w-2.5" }),
                            stats.moved,
                            " moved")),
                        stats.failed > 0 && (React.createElement(Badge, { variant: "destructive", className: "text-2xs" },
                            React.createElement(X, { className: "mr-0.5 h-2.5 w-2.5" }),
                            stats.failed,
                            " failed")),
                        stats.cancelled > 0 && (React.createElement(Badge, { variant: "warning", className: "text-2xs" },
                            stats.cancelled,
                            " cancelled")),
                        React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setResults([]), disabled: running !== null, "aria-label": "Clear the operation results table", title: "Clear results (does not undo any moves)" },
                                React.createElement(PackageMinus, { className: "h-3 w-3" }),
                                "Clear"),
                            React.createElement(ExportMenu, { rows: results, columns: resultsExportColumns, filename: "resource-manager-results", label: "Export results", jsonMetadata: {
                                    sourceSubscriptionId: srcSub === null || srcSub === void 0 ? void 0 : srcSub.subscriptionId,
                                    destinationSubscriptionId: dstSub === null || dstSub === void 0 ? void 0 : dstSub.subscriptionId,
                                    runMode: running !== null && running !== void 0 ? running : "complete",
                                    runStartedAt: runStart
                                        ? new Date(runStart).toISOString()
                                        : null,
                                    actor: (_g = account === null || account === void 0 ? void 0 : account.username) !== null && _g !== void 0 ? _g : accountId,
                                } }))),
                    React.createElement(CardDescription, null,
                        "Each row is independent \u2014 RG create + move run sequentially per Batch account. A failed RG-create skips the move for that row but doesn't stop the others. Already-moved rows are ",
                        React.createElement("strong", null, "not rolled back"),
                        " on cancel \u2014 use this page in reverse (swap source \u2194 destination) to undo.")),
                React.createElement(CardContent, { className: "flex flex-col gap-1" },
                    React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only" }, running !== null
                        ? `${stats.inFlight} in flight, ${stats.moved} moved, ${stats.failed} failed.`
                        : `Pipeline finished: ${stats.moved} moved, ${stats.failed} failed${stats.cancelled > 0
                            ? `, ${stats.cancelled} cancelled`
                            : ""}.`),
                    results.map((r) => {
                        var _a, _b, _c;
                        const elapsedMs = r.startedAt && r.finishedAt
                            ? r.finishedAt - r.startedAt
                            : null;
                        const stateBgClass = r.state === "success"
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
                        return (React.createElement("div", { key: r.resourceId, className: "flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs focus-within:ring-2 focus-within:ring-ring transition-colors " +
                                stateBgClass, "aria-label": `Result row for ${r.name}: ${r.state}` },
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement(Server, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                                React.createElement("span", { className: "font-medium" }, r.name),
                                React.createElement(ArrowRight, { className: "h-3.5 w-3.5 text-muted-foreground" }),
                                React.createElement(CopyableText, { value: r.destRgName, mono: true, ariaLabel: `Copy destination RG name ${r.destRgName}` }),
                                React.createElement(Badge, { variant: "outline", className: "text-2xs" }, r.destLocation),
                                r.state === "pending" && (React.createElement(Badge, { variant: "outline", className: "text-2xs text-muted-foreground" }, "queued")),
                                r.state === "validating" && (React.createElement(Badge, { variant: "secondary", className: "gap-1 text-2xs" },
                                    React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                                    " ",
                                    "validating\u2026")),
                                r.state === "creating-rg" && (React.createElement(Badge, { variant: "secondary", className: "gap-1 text-2xs" },
                                    React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                                    " ",
                                    "creating RG\u2026")),
                                r.state === "moving" && (React.createElement(Badge, { variant: "secondary", className: "gap-1 text-2xs" },
                                    React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                                    " ",
                                    "moving\u2026")),
                                r.state === "success" && (React.createElement(Badge, { variant: "success", className: "gap-1 text-2xs" },
                                    React.createElement(CheckCircle2, { className: "h-3 w-3" }),
                                    " ",
                                    r.validateOutcome && !r.moveOutcome
                                        ? "validated"
                                        : "moved")),
                                r.state === "failure" && (React.createElement(Badge, { variant: "destructive", className: "gap-1 text-2xs" },
                                    React.createElement(X, { className: "h-3 w-3" }),
                                    " failed")),
                                r.state === "cancelled" && (React.createElement(Badge, { variant: "warning", className: "gap-1 text-2xs" },
                                    React.createElement(X, { className: "h-3 w-3" }),
                                    " cancelled")),
                                ((_a = r.moveOutcome) === null || _a === void 0 ? void 0 : _a.status) ? (React.createElement("span", { className: "text-2xs text-muted-foreground", title: `Final HTTP status from the async operation poll: ${r.moveOutcome.status}` },
                                    "HTTP ",
                                    r.moveOutcome.status)) : null,
                                elapsedMs !== null && (React.createElement("span", { className: "inline-flex items-center gap-0.5 text-2xs text-muted-foreground", title: "Wall-clock time spent on this row" },
                                    React.createElement(Clock, { className: "h-2.5 w-2.5" }),
                                    fmtElapsed(elapsedMs))),
                                r.state === "success" && r.newResourceId && (React.createElement("a", { href: portalUrlForBatchAccount(r.newResourceId), target: "_blank", rel: "noopener noreferrer", className: "ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs text-muted-foreground hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Open ${r.name} at destination in Azure Portal`, title: "Open the moved account in the destination subscription (may take a few minutes to surface)" },
                                    React.createElement(ExternalLink, { className: "h-3 w-3" }),
                                    "Portal")),
                                r.state === "success" && dstSub && (React.createElement("a", { href: portalUrlForResourceGroup(dstSub.subscriptionId, r.destRgName), target: "_blank", rel: "noopener noreferrer", className: "inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs text-muted-foreground hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Open destination RG ${r.destRgName} in Azure Portal`, title: "Open the new resource group in the Azure Portal" },
                                    React.createElement(Database, { className: "h-3 w-3" }),
                                    "RG"))),
                            r.newResourceId && (React.createElement("div", { className: "pl-5 text-2xs text-muted-foreground" },
                                "New ARM id:",
                                " ",
                                React.createElement(CopyableText, { value: r.newResourceId, mono: true, ariaLabel: `Copy new ARM resource id for ${r.name}` }))),
                            r.rgCreateError && (React.createElement("p", { className: "break-words pl-5 text-2xs text-destructive" },
                                "RG create: ",
                                r.rgCreateError)),
                            ((_b = r.validateOutcome) === null || _b === void 0 ? void 0 : _b.error) && (React.createElement("p", { className: "break-words pl-5 text-2xs text-destructive" },
                                "validate: ",
                                r.validateOutcome.error)),
                            ((_c = r.moveOutcome) === null || _c === void 0 ? void 0 : _c.error) && (React.createElement("p", { className: "break-words pl-5 text-2xs text-destructive" },
                                "move: ",
                                r.moveOutcome.error))));
                    })))))),
        React.createElement(ConfirmationDialog, { hidden: !confirmMoveOpen, title: `Create ${planRows.length} RG${planRows.length === 1 ? "" : "s"} & move ${planRows.length} account${planRows.length === 1 ? "" : "s"}`, message: dstSub ? (React.createElement("div", { className: "flex flex-col gap-2 text-sm" },
                React.createElement("p", { className: "m-0" }, "You're about to:"),
                React.createElement("ul", { className: "m-0 list-disc pl-5 text-xs text-muted-foreground" },
                    React.createElement("li", null,
                        "Create",
                        " ",
                        React.createElement("strong", null,
                            planRows.length,
                            " new resource group",
                            planRows.length === 1 ? "" : "s"),
                        " ",
                        "in subscription",
                        " ",
                        React.createElement("code", { className: "font-mono" }, dstSub.subscriptionId),
                        "."),
                    React.createElement("li", null,
                        "Move",
                        " ",
                        React.createElement("strong", null,
                            planRows.length,
                            " Batch account",
                            planRows.length === 1 ? "" : "s"),
                        " ",
                        "from ",
                        sourceRgSummary.length,
                        " source RG",
                        sourceRgSummary.length === 1 ? "" : "s",
                        " into them (one account per RG)."),
                    React.createElement("li", null,
                        "Expect ",
                        React.createElement("strong", null, "1\u20135 minutes per row"),
                        "; rows run sequentially.")),
                React.createElement(Alert, { variant: "destructive" },
                    React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, { className: "text-xs" },
                        "This is ",
                        React.createElement("strong", null, "irreversible from this dialog"),
                        ". To undo a move, swap source \u2194 destination and run again.")))) : (""), confirmText: `Create & move ${planRows.length}`, danger: true, loading: running === "move", onConfirm: () => void runMove(), onCancel: () => setConfirmMoveOpen(false) }),
        React.createElement(ConfirmationDialog, { hidden: !confirmBulkRemoveOpen, title: `Drop ${planRows.length} row${planRows.length === 1 ? "" : "s"} from plan?`, message: React.createElement("div", { className: "flex flex-col gap-2 text-sm" },
                React.createElement("p", { className: "m-0" }, "This clears the entire selection and any per-row RG-name / location overrides you've made. Nothing in Azure is changed."),
                React.createElement("p", { className: "m-0 text-xs text-muted-foreground" }, "You'll be able to rebuild the plan by re-ticking accounts in the list above.")), confirmText: `Drop ${planRows.length}`, danger: true, onConfirm: bulkRemoveFromSelection, onCancel: () => setConfirmBulkRemoveOpen(false) })));
};
//# sourceMappingURL=resource-manager-page.js.map