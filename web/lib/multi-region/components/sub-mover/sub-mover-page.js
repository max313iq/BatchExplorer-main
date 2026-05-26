import { __awaiter } from "tslib";
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
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, ChevronDown, ChevronRight, ClipboardPaste, Copy, Crown, Eye, FolderTree, Hourglass, Layers, Loader2, Octagon, RefreshCw, RotateCcw, Search, Server, ShieldCheck, Trash2, X, } from "lucide-react";
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
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { auditLog } from "../../services/audit-log";
import { useDashboardOutletContext } from "../page-router";
import { changeSubscriptionTenant, listEaBillingAccounts, listEaBillingSubscriptions, listEnrollmentAccounts, moveBillingSubscriptionToEnrollmentAccount, } from "../../services";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SignInRequired } from "../shared/sign-in-required";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
const STORAGE_ACCOUNT = "sub-mover:account";
const STORAGE_BA = "sub-mover:billing-account";
const STORAGE_OPKIND = "sub-mover:op-kind";
const STORAGE_DEST_TENANT = "sub-mover:dest-tenant";
const STORAGE_CONCURRENCY = "sub-mover:concurrency";
/** Concurrency choices for the batch runner. 1 = strictly sequential. */
const CONCURRENCY_CHOICES = [1, 3, 5, 10];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Per-batch maximum polling time, in ms. After this we give up and surface
 *  a "polling timed out — check Azure manually" error instead of spinning
 *  forever. Matches the services-layer default for consistency. */
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
/** Initial poll delay (ms). Doubled on each attempt, capped at MAX. */
const POLL_INITIAL_MS = 3000;
/** Maximum poll delay (ms). */
const POLL_MAX_MS = 30000;
/** Read the Retry-After header (seconds or HTTP-date) as milliseconds. */
function parseRetryAfter(header) {
    if (!header)
        return null;
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds) && asSeconds >= 0)
        return asSeconds * 1000;
    const asDate = Date.parse(header);
    if (Number.isNaN(asDate))
        return null;
    return Math.max(0, asDate - Date.now());
}
/** Sleep that respects an abort signal — rejects with AbortError on abort. */
function abortableDelay(ms, signal) {
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
function isAbortError(err) {
    return (err instanceof DOMException && err.name === "AbortError") || (err instanceof Error && err.name === "AbortError");
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
function pollLro(initialUrl, token, signal) {
    var _a, _b, _c, _d, _e, _f;
    return __awaiter(this, void 0, void 0, function* () {
        let url = initialUrl;
        let waitMs = POLL_INITIAL_MS;
        let attempts = 0;
        const startedAt = Date.now();
        while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
            yield abortableDelay(waitMs, signal);
            attempts += 1;
            const resp = yield fetch(url, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
                signal,
            });
            // Retry-After always wins when present, else exponential backoff capped.
            const retryAfterMs = parseRetryAfter(resp.headers.get("Retry-After"));
            waitMs = retryAfterMs !== null && retryAfterMs !== void 0 ? retryAfterMs : Math.min(waitMs * 2, POLL_MAX_MS);
            if (resp.status === 200 || resp.status === 201) {
                // Terminal success — body may carry status, but 200 alone is enough.
                try {
                    const body = (yield resp.clone().json());
                    const inner = (_c = (_a = body === null || body === void 0 ? void 0 : body.status) !== null && _a !== void 0 ? _a : (_b = body === null || body === void 0 ? void 0 : body.properties) === null || _b === void 0 ? void 0 : _b.provisioningState) !== null && _c !== void 0 ? _c : "Succeeded";
                    const norm = String(inner);
                    if (/^succeed/i.test(norm))
                        return { status: "Succeeded", attempts };
                    if (/^fail/i.test(norm)) {
                        return { status: "Failed", attempts, error: `Async op returned status=${norm}` };
                    }
                    if (/^cancel/i.test(norm))
                        return { status: "Canceled", attempts };
                }
                catch (_g) {
                    // Empty body on 200 is fine — treat as success.
                }
                return { status: "Succeeded", attempts };
            }
            if (resp.status === 202) {
                const next = (_d = resp.headers.get("Azure-AsyncOperation")) !== null && _d !== void 0 ? _d : resp.headers.get("Location");
                if (next)
                    url = next;
                continue;
            }
            // Non-2xx → terminal failure. Try to surface Azure's error code/message.
            const errBody = (yield resp
                .json()
                .catch(() => ({})));
            const msg = (_f = (_e = errBody === null || errBody === void 0 ? void 0 : errBody.error) === null || _e === void 0 ? void 0 : _e.message) !== null && _f !== void 0 ? _f : `Async op poll returned HTTP ${resp.status}`;
            return { status: "Failed", attempts, error: msg };
        }
        return {
            status: "Failed",
            attempts,
            error: `Polling timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s — check the Azure-AsyncOperation URL manually.`,
        };
    });
}
/** Build a cURL one-liner that reproduces the row's POST. */
function buildCurl(row, sourceTenantId) {
    var _a, _b;
    // The accept-call URL is reconstructed from the op+destination so we don't
    // need to store the URL on every row; this also keeps the cURL stable
    // across server-side path changes when the operator copies it later.
    if (row.op === "transfer-billing") {
        const dest = (_a = row.destination) !== null && _a !== void 0 ? _a : "";
        return [
            `curl -X POST 'https://management.azure.com/providers/Microsoft.Billing/billingAccounts/<billingAccount>/billingSubscriptions/${row.billingSubName}/move?api-version=2020-05-01'`,
            `  -H 'Authorization: Bearer <ARM_TOKEN>'`,
            `  -H 'Content-Type: application/json'`,
            `  -d '${JSON.stringify({ destinationEnrollmentAccountId: dest })}'`,
        ].join(" \\\n");
    }
    const tenant = (_b = row.destination) !== null && _b !== void 0 ? _b : "<destTenantId>";
    return [
        `curl -X POST 'https://management.azure.com/providers/Microsoft.Subscription/subscriptions/${row.subscriptionId}/changeTenant?api-version=2021-10-01'`,
        `  -H 'Authorization: Bearer <ARM_TOKEN>${sourceTenantId ? ` for tenant ${sourceTenantId}` : ""}'`,
        `  -H 'Content-Type: application/json'`,
        `  -d '${JSON.stringify({ properties: { tenantId: tenant } })}'`,
    ].join(" \\\n");
}
/** Best-effort clipboard write. Returns true on success. */
function copyToClipboard(value) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        if (typeof navigator !== "undefined" && ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText)) {
            try {
                yield navigator.clipboard.writeText(value);
                return true;
            }
            catch (_b) {
                /* fall through */
            }
        }
        if (typeof document === "undefined")
            return false;
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
        }
        catch (_c) {
            return false;
        }
    });
}
/** Format a millisecond duration as "1m 24s" / "740ms". */
function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0)
        return "—";
    if (ms < 1000)
        return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
}
/**
 * Maximum number of "recently used target tenants" to keep in
 * localStorage. The UI surfaces these as one-click pills above the
 * destination-tenant Input so an operator who pivots between the same
 * 2-3 tenants all day doesn't have to paste a GUID every time.
 */
const RECENT_DEST_TENANTS_MAX = 6;
const STORAGE_RECENT_DEST_TENANTS = "sub-mover:recent-dest-tenants";
/**
 * CORPUS-GROUNDED — bulk cross-tenant gate. Moving more than this many
 * subscriptions to the SAME foreign tenant in one batch is unusual enough
 * to require explicit "I understand" acknowledgement before the operator
 * can Confirm. Justification: `_ea_subscription_cross_tenant.md` documents
 * that cross-tenant subscription moves create a one-way audit trail (the
 * destination tenant sees the migration in its Activity Log; the source
 * tenant only sees the originating POST). Bulk-moving 5+ subs simultaneously
 * to a tenant outside the source is a strong indicator of either an
 * authorized M&A workflow OR an unauthorized exfil — surfacing the gate
 * makes the deliberate / accidental distinction explicit in the audit log.
 */
const BULK_CROSS_TENANT_THRESHOLD = 5;
/**
 * ADVANCED-UI — parse a clipboard-style CSV/multi-line paste into a set of
 * tokens that can be matched against a billing-sub's identifiers. Accepts:
 *   - newline-separated lists
 *   - CSV (comma-separated)
 *   - whitespace-separated (one paste of `id1 id2 id3`)
 *   - mixed (`id1, id2\nid3 id4`)
 * Tokens are lowercased so casing in the source paste doesn't affect match.
 */
function parseSubIdPaste(raw) {
    if (!raw)
        return [];
    const out = [];
    const seen = new Set();
    for (const tok of raw.split(/[\s,;]+/g)) {
        const trimmed = tok.trim();
        if (!trimmed)
            continue;
        // Strip leading/trailing quotes that copy-paste from spreadsheets adds.
        const stripped = trimmed.replace(/^["'`]+|["'`]+$/g, "");
        if (!stripped)
            continue;
        const lower = stripped.toLowerCase();
        if (seen.has(lower))
            continue;
        seen.add(lower);
        out.push(stripped);
    }
    return out;
}
/**
 * CORPUS-GROUNDED — given a row + planned op, render a sanitized version of
 * the ARM request body that will be POSTed. We surface this in the confirm
 * dialog so the operator can eyeball what's actually leaving the browser
 * before approving. No tokens, no headers, no `subscriptionOwnerId` leakage
 * — just the request body and the canonical endpoint.
 *
 * The body shapes are:
 *   - transfer-billing → `{ destinationEnrollmentAccountId: "<armId>" }`
 *   - change-tenant   → `{ properties: { tenantId: "<guid>" } }`
 */
function buildArmRequestPreview(op, destination, billingAccountName, sampleSubscriptionId, sampleBillingSubName) {
    if (op === "transfer-billing") {
        return {
            method: "POST",
            url: `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}/billingSubscriptions/${sampleBillingSubName}/move?api-version=2020-05-01`,
            body: { destinationEnrollmentAccountId: destination },
        };
    }
    return {
        method: "POST",
        url: `/providers/Microsoft.Subscription/subscriptions/${sampleSubscriptionId}/changeTenant?api-version=2021-10-01`,
        body: { properties: { tenantId: destination } },
    };
}
export const SubMoverPage = () => {
    var _a, _b;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    // COORDINATOR: canonical wiring contract — path-based navigation via
    // the dashboard outlet context. Direct `useNavigate` was previously
    // used inside this page; switching to the outlet helper keeps a single
    // source of truth for page paths (and lets the shell intercept nav).
    const { navigateToPage } = useDashboardOutletContext();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    /* ----- Account picker ------------------------------------------- */
    const candidates = React.useMemo(() => azureAccounts
        .map((a) => {
        var _a, _b;
        return ({
            homeAccountId: a.homeAccountId,
            tenantId: (_b = (_a = resolveActiveTenantId(a)) !== null && _a !== void 0 ? _a : getActiveTenant(a.homeAccountId)) !== null && _b !== void 0 ? _b : a.tenantId,
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
    /* ----- ARM token + EA billing accounts -------------------------- */
    // Centralized token tracker: follows the account's active tenant,
    // auto-refreshes 60s before expiry, and powers the inline
    // TokenExpiryBadge so the operator sees freshness without opening
    // the network panel.
    const armTokenTracker = useArmToken(account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId);
    const [armToken, setArmToken] = React.useState(null);
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
    const [tokenError, setTokenError] = React.useState(null);
    const [billingAccounts, setBillingAccounts] = React.useState([]);
    const [baLoading, setBaLoading] = React.useState(false);
    const [baError, setBaError] = React.useState(null);
    const [billingAccountName, setBillingAccountNameState] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_BA)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    const setBillingAccountName = React.useCallback((name) => {
        setBillingAccountNameState(name);
        try {
            sessionStorage.setItem(STORAGE_BA, name);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
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
            if (signal.aborted || isAbortError(err))
                return;
            const msg = err instanceof Error ? err.message : String(err);
            setTokenError(msg);
            setBaError(msg);
        }
        finally {
            if (!signal.aborted)
                setBaLoading(false);
        }
    }), 
    // billingAccountName is intentionally NOT a dep — the auto-seed logic
    // here only runs on account / tenant change, not on every operator
    // pick of a billing account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId]);
    /* ----- Subscriptions + enrollment accounts (under billing acct) -- */
    const [subscriptions, setSubscriptions] = React.useState([]);
    const [subsLoading, setSubsLoading] = React.useState(false);
    const [subsError, setSubsError] = React.useState(null);
    const [enrollmentAccounts, setEnrollmentAccounts] = React.useState([]);
    const [eaLoading, setEaLoading] = React.useState(false);
    const [eaError, setEaError] = React.useState(null);
    const [reloadTick, setReloadTick] = React.useState(0);
    const reload = React.useCallback(() => setReloadTick((n) => n + 1), []);
    useAbortableEffect((signal) => {
        if (!armToken || !billingAccountName) {
            setSubscriptions([]);
            setEnrollmentAccounts([]);
            return;
        }
        setSubsLoading(true);
        setEaLoading(true);
        setSubsError(null);
        setEaError(null);
        listEaBillingSubscriptions(billingAccountName, armToken)
            .then((list) => {
            if (!signal.aborted)
                setSubscriptions(list);
        })
            .catch((err) => {
            if (signal.aborted || isAbortError(err))
                return;
            setSubsError(err instanceof Error ? err.message : String(err));
        })
            .finally(() => {
            if (!signal.aborted)
                setSubsLoading(false);
        });
        listEnrollmentAccounts(billingAccountName, armToken)
            .then((list) => {
            if (!signal.aborted)
                setEnrollmentAccounts(list);
        })
            .catch((err) => {
            if (signal.aborted || isAbortError(err))
                return;
            setEaError(err instanceof Error ? err.message : String(err));
        })
            .finally(() => {
            if (!signal.aborted)
                setEaLoading(false);
        });
    }, [armToken, billingAccountName, reloadTick]);
    /* ----- Selection ------------------------------------------------ */
    const [search, setSearch] = React.useState("");
    const [quickFilter, setQuickFilter] = React.useState("all");
    const [selected, setSelected] = React.useState(new Set());
    const searchInputRef = React.useRef(null);
    React.useEffect(() => {
        setSelected(new Set());
    }, [billingAccountName, reloadTick]);
    const filtered = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        return subscriptions.filter((s) => {
            var _a;
            // Quick-filter chip — narrows by state / cross-tenant readiness first
            // so the search box composes on top.
            const status = ((_a = s.status) !== null && _a !== void 0 ? _a : "").toLowerCase();
            if (quickFilter === "enabled" && status !== "enabled")
                return false;
            if (quickFilter === "disabled" &&
                status !== "disabled" &&
                status !== "warned" &&
                status !== "expired" &&
                status !== "deleted")
                return false;
            if (quickFilter === "cross-tenant-ready") {
                if (!s.subscriptionId)
                    return false;
                if (status && status !== "enabled")
                    return false;
            }
            if (!q)
                return true;
            return [s.displayName, s.subscriptionId, s.name, s.status]
                .join(" ")
                .toLowerCase()
                .includes(q);
        });
    }, [subscriptions, search, quickFilter]);
    /** Counts for the quick-filter chip badges — recomputed once per list change. */
    const subStateCounts = React.useMemo(() => {
        var _a;
        let enabled = 0;
        let disabled = 0;
        let crossTenantReady = 0;
        for (const s of subscriptions) {
            const status = ((_a = s.status) !== null && _a !== void 0 ? _a : "").toLowerCase();
            if (status === "enabled")
                enabled += 1;
            if (status === "disabled" ||
                status === "warned" ||
                status === "expired" ||
                status === "deleted")
                disabled += 1;
            if (s.subscriptionId && (!status || status === "enabled"))
                crossTenantReady += 1;
        }
        return { enabled, disabled, crossTenantReady };
    }, [subscriptions]);
    const toggle = React.useCallback((subName) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(subName))
                next.delete(subName);
            else
                next.add(subName);
            return next;
        });
    }, []);
    const selectAllVisible = React.useCallback(() => {
        setSelected((prev) => {
            const next = new Set(prev);
            for (const s of filtered)
                next.add(s.name);
            return next;
        });
    }, [filtered]);
    const clearSelection = React.useCallback(() => setSelected(new Set()), []);
    const selectedSubs = React.useMemo(() => subscriptions.filter((s) => selected.has(s.name)), [subscriptions, selected]);
    /** Copy every selected sub's id (one per line) — useful for ticketing. */
    const copySelectedIds = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        const lines = selectedSubs
            .map((s) => { var _a; return (_a = s.subscriptionId) !== null && _a !== void 0 ? _a : s.name; })
            .filter(Boolean);
        if (lines.length === 0)
            return;
        const ok = yield copyToClipboard(lines.join("\n"));
        if (ok) {
            store.addNotification({
                type: "info",
                message: `Copied ${lines.length} subscription id${lines.length === 1 ? "" : "s"} to clipboard.`,
            });
        }
    }), [selectedSubs, store]);
    /* ----- Action panels ------------------------------------------- */
    const [opKind, setOpKindState] = React.useState(() => {
        try {
            const v = sessionStorage.getItem(STORAGE_OPKIND);
            if (v === "transfer-billing" || v === "change-tenant")
                return v;
        }
        catch (_a) {
            /* ignore */
        }
        return "transfer-billing";
    });
    const setOpKind = React.useCallback((next) => {
        setOpKindState(next);
        try {
            sessionStorage.setItem(STORAGE_OPKIND, next);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    const [destEnrollmentArmId, setDestEnrollmentArmId] = React.useState("");
    const [destTenantId, setDestTenantIdState] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_DEST_TENANT)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    const setDestTenantId = React.useCallback((v) => {
        setDestTenantIdState(v);
        try {
            sessionStorage.setItem(STORAGE_DEST_TENANT, v);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    // ENHANCEMENT — Recently used target tenants. Persisted across browser
    // sessions (this is cross-tab safe via `usePersistedState`), MRU-ordered,
    // and capped at RECENT_DEST_TENANTS_MAX. Each entry remembers the last
    // human label (typically the destination tenant's primary domain) so the
    // pill row reads as something other than a raw GUID.
    const [recentDestTenants, setRecentDestTenants] = usePersistedState(STORAGE_RECENT_DEST_TENANTS, [], {
        syncAcrossTabs: true,
        version: 1,
        // Guard against shape drift (older versions stored bare strings).
        migrate: (data, _v) => {
            if (Array.isArray(data)) {
                const seen = new Set();
                const out = [];
                for (const entry of data) {
                    if (typeof entry === "string" && UUID_RE.test(entry)) {
                        if (seen.has(entry))
                            continue;
                        seen.add(entry);
                        out.push({ tenantId: entry, lastUsedAt: new Date(0).toISOString() });
                    }
                    else if (entry &&
                        typeof entry === "object" &&
                        typeof entry.tenantId === "string" &&
                        UUID_RE.test(entry.tenantId)) {
                        const e = entry;
                        if (seen.has(e.tenantId))
                            continue;
                        seen.add(e.tenantId);
                        out.push({
                            tenantId: e.tenantId,
                            label: typeof e.label === "string" ? e.label : undefined,
                            lastUsedAt: typeof e.lastUsedAt === "string"
                                ? e.lastUsedAt
                                : new Date(0).toISOString(),
                        });
                    }
                }
                return out.slice(0, RECENT_DEST_TENANTS_MAX);
            }
            return [];
        },
    });
    /**
     * Record a tenantId as "just used" — pushes it to the head of the MRU
     * list, dedupes against prior entries, and truncates to the configured
     * cap. Called on a successful changeTenant batch (not on accept-only
     * runs, since accept doesn't prove the destination is real).
     */
    const noteRecentDestTenant = React.useCallback((tenantId, label) => {
        const trimmed = tenantId.trim();
        if (!UUID_RE.test(trimmed))
            return;
        const lower = trimmed.toLowerCase();
        setRecentDestTenants((prev) => {
            const filtered = prev.filter((e) => e.tenantId.toLowerCase() !== lower);
            const next = [
                {
                    tenantId: trimmed,
                    label,
                    lastUsedAt: new Date().toISOString(),
                },
                ...filtered,
            ];
            return next.slice(0, RECENT_DEST_TENANTS_MAX);
        });
    }, [setRecentDestTenants]);
    /** Remove a single tenant from the MRU list (per-pill "x" button). */
    const forgetRecentDestTenant = React.useCallback((tenantId) => {
        const lower = tenantId.toLowerCase();
        setRecentDestTenants((prev) => prev.filter((e) => e.tenantId.toLowerCase() !== lower));
    }, [setRecentDestTenants]);
    /** Operator-tunable parallelism. 1 = legacy sequential behavior. */
    const [concurrency, setConcurrencyState] = React.useState(() => {
        try {
            const raw = Number(sessionStorage.getItem(STORAGE_CONCURRENCY));
            if (CONCURRENCY_CHOICES.includes(raw))
                return raw;
        }
        catch (_a) {
            /* ignore */
        }
        return 1;
    });
    const setConcurrency = React.useCallback((n) => {
        setConcurrencyState(n);
        try {
            sessionStorage.setItem(STORAGE_CONCURRENCY, String(n));
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    /** If true, auto-skip rows the pre-flight has flagged as unsafe. */
    const [skipUnsafe, setSkipUnsafe] = React.useState(true);
    /** If true, poll the Azure-AsyncOperation URL until the LRO terminates. */
    const [pollLros, setPollLros] = React.useState(true);
    /**
     * CORPUS-GROUNDED — bulk cross-tenant gate state. When the planned batch
     * is >= BULK_CROSS_TENANT_THRESHOLD subs to a single foreign tenant, the
     * operator must explicitly tick this checkbox before Confirm goes hot.
     * Resets whenever the destination / op-kind / selection changes so a
     * prior "I understand" doesn't bleed into a fresh, unrelated batch.
     * Citation: `_ea_subscription_cross_tenant.md` — cross-tenant moves
     * create one-way audit visibility; bulk moves to one tenant warrant
     * explicit operator acknowledgement.
     */
    const [bulkCrossTenantAck, setBulkCrossTenantAck] = React.useState(false);
    /** ADVANCED-UI — CSV-paste dialog open/closed state and textarea buffer. */
    const [csvPasteOpen, setCsvPasteOpen] = React.useState(false);
    const [csvPasteBuffer, setCsvPasteBuffer] = React.useState("");
    /** Last paste-import outcome — surfaced as a small toast-style banner
     *  inside the dialog so the operator sees "matched 12 / 14, 2 unknown"
     *  before closing. */
    const [csvPasteResult, setCsvPasteResult] = React.useState(null);
    const [running, setRunning] = React.useState(false);
    const [results, setResults] = React.useState([]);
    // Confirmation dialog state (replaces the native window.confirm).
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    // Cancel-with-confirm: abort during an in-flight batch is destructive
    // (already-accepted rows continue on Azure's side; pending rows are
    // dropped), so we gate it behind a small modal instead of acting on the
    // first click.
    const [abortConfirmOpen, setAbortConfirmOpen] = React.useState(false);
    // Abort controller so the operator can cancel an in-flight batch — when
    // pollLros is enabled it ALSO cancels the in-flight poll fetches so the
    // operator doesn't have to wait minutes for the runner to drain.
    const abortRef = React.useRef(null);
    // Cleanup on unmount so a navigation while running doesn't leak the
    // controller (and so the audit-log loop sees the cancel signal).
    React.useEffect(() => () => {
        var _a;
        (_a = abortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        abortRef.current = null;
    }, []);
    /** Track the batch start so we can compute total/throughput stats. */
    const batchStartedAtRef = React.useRef(null);
    const [batchElapsedMs, setBatchElapsedMs] = React.useState(0);
    // Auto-seed: when EA list arrives, prefer the FIRST one as default.
    React.useEffect(() => {
        if (enrollmentAccounts.length > 0 &&
            !destEnrollmentArmId &&
            opKind === "transfer-billing") {
            setDestEnrollmentArmId(enrollmentAccounts[0].id);
        }
    }, [enrollmentAccounts, destEnrollmentArmId, opKind]);
    // Tick the live elapsed counter while the batch runs.
    React.useEffect(() => {
        if (!running || batchStartedAtRef.current == null)
            return;
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
        var _a, _b;
        const safeRows = [];
        const nonEnabled = [];
        const missingSubId = [];
        const alreadyOnDest = [];
        const sameTenant = [];
        const destEa = destEnrollmentArmId.trim();
        const destTenant = destTenantId.trim().toLowerCase();
        const srcTenant = (_a = account === null || account === void 0 ? void 0 : account.tenantId) === null || _a === void 0 ? void 0 : _a.toLowerCase();
        for (const s of selectedSubs) {
            let safe = true;
            const status = ((_b = s.status) !== null && _b !== void 0 ? _b : "").toLowerCase();
            if (status && status !== "enabled") {
                nonEnabled.push(s);
                safe = false;
            }
            if (opKind === "change-tenant") {
                if (!s.subscriptionId) {
                    missingSubId.push(s);
                    safe = false;
                }
                if (srcTenant &&
                    destTenant &&
                    srcTenant === destTenant) {
                    sameTenant.push(s);
                    safe = false;
                }
            }
            else {
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
            if (safe)
                safeRows.push(s);
        }
        return { safeRows, nonEnabled, missingSubId, alreadyOnDest, sameTenant };
    }, [selectedSubs, opKind, destEnrollmentArmId, destTenantId, account === null || account === void 0 ? void 0 : account.tenantId]);
    /** The rows that will ACTUALLY be submitted (post auto-skip). */
    const rowsToRun = React.useMemo(() => (skipUnsafe ? previewClassification.safeRows : selectedSubs), [skipUnsafe, previewClassification.safeRows, selectedSubs]);
    /**
     * CORPUS-GROUNDED — derived flag: is this a bulk cross-tenant move that
     * requires explicit operator acknowledgement? Defined as: change-tenant
     * op + >= BULK_CROSS_TENANT_THRESHOLD rows + destination != source.
     * Surfaced both as a warning banner and as a hard gate on the Confirm
     * button (planValid AND-gates on this when applicable).
     */
    const requiresBulkCrossTenantAck = React.useMemo(() => {
        var _a;
        if (opKind !== "change-tenant")
            return false;
        if (rowsToRun.length < BULK_CROSS_TENANT_THRESHOLD)
            return false;
        const dest = destTenantId.trim().toLowerCase();
        const src = (_a = account === null || account === void 0 ? void 0 : account.tenantId) === null || _a === void 0 ? void 0 : _a.toLowerCase();
        if (!dest || !UUID_RE.test(dest))
            return false;
        if (src && src === dest)
            return false;
        return true;
    }, [opKind, rowsToRun.length, destTenantId, account === null || account === void 0 ? void 0 : account.tenantId]);
    const planValid = React.useMemo(() => {
        if (rowsToRun.length === 0)
            return false;
        if (opKind === "transfer-billing")
            return !!destEnrollmentArmId.trim();
        if (!UUID_RE.test(destTenantId.trim()))
            return false;
        // Don't even let the operator confirm if the destination tenant equals
        // the source — the API will 400 and leaves the batch half-done.
        if ((account === null || account === void 0 ? void 0 : account.tenantId) &&
            destTenantId.trim().toLowerCase() === account.tenantId.toLowerCase())
            return false;
        // CORPUS-GROUNDED gate — bulk cross-tenant moves require explicit
        // "I understand" tick (see BULK_CROSS_TENANT_THRESHOLD).
        if (requiresBulkCrossTenantAck && !bulkCrossTenantAck)
            return false;
        return true;
    }, [
        rowsToRun.length,
        opKind,
        destEnrollmentArmId,
        destTenantId,
        account === null || account === void 0 ? void 0 : account.tenantId,
        requiresBulkCrossTenantAck,
        bulkCrossTenantAck,
    ]);
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
        const ws = [];
        if (selectedSubs.length === 0)
            return ws;
        const { nonEnabled, missingSubId, alreadyOnDest, sameTenant } = previewClassification;
        if (nonEnabled.length > 0) {
            ws.push(`${nonEnabled.length} selected subscription${nonEnabled.length === 1 ? " is" : "s are"} not in the Enabled state and may be rejected by Azure.`);
        }
        if (alreadyOnDest.length > 0) {
            ws.push(`${alreadyOnDest.length} selected row${alreadyOnDest.length === 1 ? "" : "s"} already appear to belong to the chosen enrollment account — those will be no-ops.`);
        }
        if (opKind === "change-tenant") {
            if (sameTenant.length > 0) {
                ws.push("Destination tenant is the same as the source tenant — Azure will reject the changeTenant call.");
            }
            if (missingSubId.length > 0) {
                ws.push(`${missingSubId.length} selected row${missingSubId.length === 1 ? "" : "s"} has no AAD subscriptionId and cannot be moved across tenants.`);
            }
        }
        if (selectedSubs.length >= 50 && concurrency === 1) {
            ws.push(`Large batch (${selectedSubs.length}). At concurrency 1 this will take a while — consider bumping the runner to 3 or 5.`);
        }
        if (armTokenTracker.secondsUntilExpiry != null &&
            armTokenTracker.secondsUntilExpiry < 300) {
            ws.push(`ARM token expires in ${Math.max(0, Math.round(armTokenTracker.secondsUntilExpiry))}s. Click the badge to refresh before kicking off the batch.`);
        }
        return ws;
    }, [
        selectedSubs.length,
        previewClassification,
        opKind,
        concurrency,
        armTokenTracker.secondsUntilExpiry,
    ]);
    // Reset the bulk-cross-tenant ack whenever the destination / op / row
    // count changes — a prior "I understand" tick must not carry over into a
    // different batch composition (defense against accidental re-confirm).
    React.useEffect(() => {
        setBulkCrossTenantAck(false);
    }, [
        opKind,
        destTenantId,
        destEnrollmentArmId,
        rowsToRun.length,
        account === null || account === void 0 ? void 0 : account.tenantId,
    ]);
    /**
     * Race-condition guard — if the operator switches the SOURCE account
     * (and thus the ARM token's home tenant) WHILE a batch is in-flight,
     * the in-flight rows would be processed against a stale token / wrong
     * tenant context. Abort the controller so the worker pool unwinds
     * cleanly; the pending rows flip to "cancelled" via the existing abort
     * path. The accept calls already-dispatched on the prior tenant are
     * unaffected (Azure side state is unchanged), and the operator gets a
     * clear notification rather than a mysterious string of 401s.
     */
    const lastAccountIdRef = React.useRef(account === null || account === void 0 ? void 0 : account.homeAccountId);
    React.useEffect(() => {
        const prev = lastAccountIdRef.current;
        const next = account === null || account === void 0 ? void 0 : account.homeAccountId;
        if (prev != null && next != null && prev !== next && running && abortRef.current) {
            abortRef.current.abort();
            store.addNotification({
                type: "warning",
                message: "Source account changed mid-batch — the in-flight runner was aborted to avoid using a stale tenant token.",
            });
        }
        lastAccountIdRef.current = next;
    }, [account === null || account === void 0 ? void 0 : account.homeAccountId, running, store]);
    /**
     * ADVANCED-UI — apply a CSV / multi-line paste of subscription IDs into
     * the existing selection. Tokens that match a billing-sub's
     * `subscriptionId`, ARM `id`, or `name` are added to `selected`; unknown
     * tokens are surfaced back as `csvPasteResult.unknown` so the operator
     * can fix typos rather than silently dropping rows.
     *
     * Match precedence:
     *   1. exact `subscriptionId` (AAD UUID, case-insensitive)
     *   2. ARM `id` suffix (last path segment OR the full ARM id)
     *   3. billing-sub `name`
     */
    const applyCsvPaste = React.useCallback(() => {
        var _a, _b;
        const tokens = parseSubIdPaste(csvPasteBuffer);
        if (tokens.length === 0) {
            setCsvPasteResult({ matched: 0, unknown: [] });
            return;
        }
        // Build O(1) lookup tables keyed by lowercase identifier.
        const bySubId = new Map(); // subId -> billing-sub name
        const byName = new Map(); // billing-sub name -> billing-sub name (identity)
        const byArmId = new Map(); // full ARM id -> billing-sub name
        for (const s of subscriptions) {
            if (s.subscriptionId)
                bySubId.set(s.subscriptionId.toLowerCase(), s.name);
            byName.set(s.name.toLowerCase(), s.name);
            byArmId.set(s.id.toLowerCase(), s.name);
        }
        const matchedNames = [];
        const unknown = [];
        for (const tok of tokens) {
            const lower = tok.toLowerCase();
            // Try ARM id, subId, billing-sub name — in that order. Also try the
            // last path segment of an ARM id-shaped token (operators often paste
            // the full /providers/... path).
            const armMatch = byArmId.get(lower);
            const subMatch = bySubId.get(lower);
            const nameMatch = byName.get(lower);
            const trailMatch = lower.includes("/")
                ? byName.get(lower.split("/").pop().toLowerCase())
                : undefined;
            const matched = (_b = (_a = armMatch !== null && armMatch !== void 0 ? armMatch : subMatch) !== null && _a !== void 0 ? _a : nameMatch) !== null && _b !== void 0 ? _b : trailMatch;
            if (matched) {
                matchedNames.push(matched);
            }
            else {
                unknown.push(tok);
            }
        }
        if (matchedNames.length > 0) {
            setSelected((prev) => {
                const next = new Set(prev);
                for (const n of matchedNames)
                    next.add(n);
                return next;
            });
        }
        setCsvPasteResult({ matched: matchedNames.length, unknown });
    }, [csvPasteBuffer, subscriptions]);
    const openCsvPasteDialog = React.useCallback(() => {
        setCsvPasteBuffer("");
        setCsvPasteResult(null);
        setCsvPasteOpen(true);
    }, []);
    const confirmMessage = React.useMemo(() => {
        var _a, _b;
        const skipped = selectedSubs.length - rowsToRun.length;
        const skipNote = skipUnsafe && skipped > 0
            ? `\n\n${skipped} unsafe row${skipped === 1 ? "" : "s"} will be skipped (the "Auto-skip" toggle is on).`
            : "";
        const pollNote = pollLros
            ? "\n\nThe page will poll the Azure-AsyncOperation URL until each LRO finishes (or you abort)."
            : "";
        if (opKind === "transfer-billing") {
            const eaName = (_b = (_a = enrollmentAccounts.find((ea) => ea.id === destEnrollmentArmId.trim())) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : destEnrollmentArmId.trim();
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
    const runOneRow = React.useCallback((row, auditAction, signal, tok, opKindLocal, destEa, destTenant, pollWhenDone) => __awaiter(void 0, void 0, void 0, function* () {
        var _c, _d, _e, _f, _g, _h, _j, _k;
        const rowKey = row.id;
        const startedAtIso = new Date().toISOString();
        const startedAtMs = Date.now();
        setResults((prev) => prev.map((r) => r.rowKey === rowKey
            ? Object.assign(Object.assign({}, r), { state: "running", startedAt: startedAtIso }) : r));
        try {
            let outcome;
            if (opKindLocal === "transfer-billing") {
                outcome = yield moveBillingSubscriptionToEnrollmentAccount(billingAccountName, row.name, destEa, tok);
            }
            else {
                if (!row.subscriptionId) {
                    throw new Error("No subscriptionId on this billing-subscription row — cannot change tenant.");
                }
                outcome = yield changeSubscriptionTenant(row.subscriptionId, destTenant, tok);
            }
            // The accept call landed — record the intent now so we have an
            // audit trail even if the page is closed mid-poll. The optional
            // poll outcome below is logged separately as its own audit entry.
            auditLog.record({
                actor: (_c = account === null || account === void 0 ? void 0 : account.username) !== null && _c !== void 0 ? _c : accountId,
                action: auditAction,
                target: (_d = row.subscriptionId) !== null && _d !== void 0 ? _d : row.name,
                status: "success",
                details: {
                    billingAccountName,
                    destinationEnrollmentAccountId: opKindLocal === "transfer-billing" ? destEa : undefined,
                    destinationTenantId: opKindLocal === "change-tenant" ? destTenant : undefined,
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
                setResults((prev) => prev.map((r) => r.rowKey === rowKey
                    ? Object.assign(Object.assign({}, r), { state: "polling", status: outcome.status, pollUrl: outcome.location }) : r));
                try {
                    const pollRes = yield pollLro(outcome.location, tok, signal);
                    const finishedAtIso = new Date().toISOString();
                    const durationMs = Date.now() - startedAtMs;
                    auditLog.record({
                        actor: (_e = account === null || account === void 0 ? void 0 : account.username) !== null && _e !== void 0 ? _e : accountId,
                        action: auditAction,
                        target: (_f = row.subscriptionId) !== null && _f !== void 0 ? _f : row.name,
                        status: pollRes.status === "Succeeded" ? "success" : "failure",
                        error: pollRes.error,
                        details: {
                            billingAccountName,
                            destinationEnrollmentAccountId: opKindLocal === "transfer-billing" ? destEa : undefined,
                            destinationTenantId: opKindLocal === "change-tenant" ? destTenant : undefined,
                            pollUrl: outcome.location,
                            pollAttempts: pollRes.attempts,
                            phase: "polled",
                            terminalStatus: pollRes.status,
                        },
                    });
                    setResults((prev) => prev.map((r) => r.rowKey === rowKey
                        ? Object.assign(Object.assign({}, r), { state: pollRes.status === "Succeeded" ? "success" : "failure", pollOutcome: pollRes.status, pollAttempts: pollRes.attempts, pollError: pollRes.error, error: pollRes.error, finishedAt: finishedAtIso, durationMs }) : r));
                }
                catch (pollErr) {
                    // Abort mid-poll. Flip the row to cancelled — the accept call
                    // is already recorded in the audit log as "accepted" so the
                    // operator knows the request landed at Azure.
                    if (isAbortError(pollErr)) {
                        setResults((prev) => prev.map((r) => r.rowKey === rowKey
                            ? Object.assign(Object.assign({}, r), { state: "cancelled", error: "Polling cancelled by operator — Azure may still finish the request.", finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs }) : r));
                        return;
                    }
                    const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
                    auditLog.record({
                        actor: (_g = account === null || account === void 0 ? void 0 : account.username) !== null && _g !== void 0 ? _g : accountId,
                        action: auditAction,
                        target: (_h = row.subscriptionId) !== null && _h !== void 0 ? _h : row.name,
                        status: "failure",
                        error: msg,
                        details: { phase: "poll-error", pollUrl: outcome.location },
                    });
                    setResults((prev) => prev.map((r) => r.rowKey === rowKey
                        ? Object.assign(Object.assign({}, r), { state: "failure", pollError: msg, error: msg, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs }) : r));
                }
            }
            else {
                // No poll — accept call alone is the terminal state.
                const finishedAtIso = new Date().toISOString();
                setResults((prev) => prev.map((r) => r.rowKey === rowKey
                    ? Object.assign(Object.assign({}, r), { state: "success", status: outcome.status, pollUrl: outcome.location, finishedAt: finishedAtIso, durationMs: Date.now() - startedAtMs }) : r));
            }
        }
        catch (err) {
            // Abort while the accept call was in-flight (the service layer's
            // armFetch isn't AbortController-aware today, but the operator may
            // have pressed Abort during the post-accept polling phase for a
            // prior row — that toggles the signal and we surface it here).
            if (isAbortError(err)) {
                setResults((prev) => prev.map((r) => r.rowKey === rowKey
                    ? Object.assign(Object.assign({}, r), { state: "cancelled", error: "Cancelled by operator while accept call was in-flight.", finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs }) : r));
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            // Surface every failure both in the per-row card and in the audit
            // log; the old "silent catch" left the operator unable to tell
            // which row blew up after the toast cleared.
            auditLog.record({
                actor: (_j = account === null || account === void 0 ? void 0 : account.username) !== null && _j !== void 0 ? _j : accountId,
                action: auditAction,
                target: (_k = row.subscriptionId) !== null && _k !== void 0 ? _k : row.name,
                status: "failure",
                error: msg,
                details: {
                    billingAccountName,
                    destinationEnrollmentAccountId: opKindLocal === "transfer-billing" ? destEa : undefined,
                    destinationTenantId: opKindLocal === "change-tenant" ? destTenant : undefined,
                    phase: "accept-error",
                },
            });
            setResults((prev) => prev.map((r) => r.rowKey === rowKey
                ? Object.assign(Object.assign({}, r), { state: "failure", error: msg, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs }) : r));
        }
    }), [billingAccountName, account === null || account === void 0 ? void 0 : account.username, accountId]);
    /**
     * The actual batch runner. Seeds `results` with one pending row per sub,
     * then either runs them sequentially (concurrency=1) or as a fixed-size
     * worker pool (concurrency=3/5/10).
     *
     * Accepts a `rowsOverride` so the "Rerun failed" button can re-process
     * just the failed subset without rebuilding the entire selection.
     */
    const runRows = React.useCallback((rowsOverride) => __awaiter(void 0, void 0, void 0, function* () {
        if (!armToken || running)
            return;
        const rows = rowsOverride !== null && rowsOverride !== void 0 ? rowsOverride : rowsToRun;
        if (rows.length === 0)
            return;
        setConfirmOpen(false);
        const controller = new AbortController();
        abortRef.current = controller;
        const auditAction = opKind === "transfer-billing"
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
            const newRows = rows.map((s) => {
                var _a;
                return ({
                    rowKey: s.id,
                    subscriptionId: (_a = s.subscriptionId) !== null && _a !== void 0 ? _a : s.name,
                    displayName: s.displayName,
                    billingSubName: s.name,
                    state: "pending",
                    op: opKind,
                    destination: opKind === "transfer-billing" ? destEa : destTenant,
                });
            });
            if (!rowsOverride)
                return newRows;
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
        const worker = () => __awaiter(void 0, void 0, void 0, function* () {
            while (!controller.signal.aborted) {
                const idx = cursor.i;
                cursor.i += 1;
                if (idx >= queue.length)
                    return;
                yield runOneRow(queue[idx], auditAction, controller.signal, armToken, opKind, destEa, destTenant, pollLros);
            }
        });
        try {
            yield Promise.all(Array.from({ length: workerCount }, worker));
        }
        catch (_l) {
            /* per-row errors are already caught inside runOneRow */
        }
        // If abort fired mid-batch, flip any rows that never got to "running"
        // (i.e. they're still "pending") to "cancelled" so the summary stats
        // and audit log have an accurate final picture.
        if (controller.signal.aborted) {
            setResults((prev) => prev.map((r) => r.state === "pending"
                ? Object.assign(Object.assign({}, r), { state: "cancelled", error: "Cancelled by operator before this row started.", finishedAt: new Date().toISOString() }) : r));
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
        // ENHANCEMENT — promote the destination tenant to the MRU list
        // when a change-tenant batch at least reaches "accepted" without
        // aborting. We don't gate on the LRO outcome because change-tenant
        // commonly stays Pending on Azure's side until the destination
        // tenant admin accepts the offer — we still want it remembered.
        if (!controller.signal.aborted &&
            opKind === "change-tenant" &&
            destTenant) {
            noteRecentDestTenant(destTenant);
        }
        setReloadTick((n) => n + 1);
        // Only clear the selection on a full success run — preserve on
        // abort/failure so the operator can rerun without re-selecting.
        if (!controller.signal.aborted)
            setSelected(new Set());
    }), [
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
        noteRecentDestTenant,
    ]);
    const runBatch = React.useCallback(() => {
        void runRows();
    }, [runRows]);
    /**
     * Request cancel — opens a confirmation modal instead of aborting
     * immediately. Cross-tenant moves are destructive (and rows already
     * accepted by Azure cannot be un-accepted page-side) so the operator
     * confirms once. Esc-during-batch still routes through here so a
     * mis-press doesn't kill a batch the operator forgot they kicked off.
     */
    const requestAbortBatch = React.useCallback(() => {
        if (!running)
            return;
        setAbortConfirmOpen(true);
    }, [running]);
    /** Actually fire the abort once confirmed. The accept-call fetch isn't
     *  AbortController-aware today, but any in-flight LRO polling AND any
     *  rows not yet started ARE cancelled. */
    const confirmAbortBatch = React.useCallback(() => {
        var _a;
        (_a = abortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        setAbortConfirmOpen(false);
    }, []);
    /** Rerun only the failed rows from the previous batch. */
    const rerunFailed = React.useCallback(() => {
        const failedKeys = new Set(results.filter((r) => r.state === "failure").map((r) => r.rowKey));
        if (failedKeys.size === 0)
            return;
        const rows = subscriptions.filter((s) => failedKeys.has(s.id));
        if (rows.length === 0) {
            store.addNotification({
                type: "warning",
                message: "The failed rows are no longer in the subscriptions list — refresh and reselect.",
            });
            return;
        }
        void runRows(rows);
    }, [results, subscriptions, runRows, store]);
    const clearResults = React.useCallback(() => {
        if (running)
            return;
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
            if (r.state === "pending")
                queued += 1;
            else if (r.state === "running")
                runningCount += 1;
            else if (r.state === "polling")
                pollingCount += 1;
            else if (r.state === "success")
                success += 1;
            else if (r.state === "failure")
                failed += 1;
            else if (r.state === "cancelled")
                cancelled += 1;
            if (r.durationMs != null && Number.isFinite(r.durationMs)) {
                totalDurationMs += r.durationMs;
                completedDurations += 1;
            }
        }
        const avgMs = completedDurations > 0 ? totalDurationMs / completedDurations : 0;
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
    /**
     * ADVANCED-UI — ETA estimate for the in-flight batch. Uses the running
     * average duration of completed rows divided by the active concurrency
     * to project remaining time. Returns null when there's no data yet
     * (or no rows still in-flight).
     */
    const batchEta = React.useMemo(() => {
        if (!running)
            return null;
        if (resultStats.completedDurations === 0)
            return null;
        const remaining = resultStats.queued + resultStats.runningCount + resultStats.pollingCount;
        if (remaining <= 0)
            return null;
        const workers = Math.max(1, Math.min(concurrency, results.length));
        const etaMs = (resultStats.avgMs * remaining) / workers;
        if (!Number.isFinite(etaMs) || etaMs < 0)
            return null;
        return etaMs;
    }, [
        running,
        resultStats.completedDurations,
        resultStats.queued,
        resultStats.runningCount,
        resultStats.pollingCount,
        resultStats.avgMs,
        concurrency,
        results.length,
    ]);
    /** Export columns for the bulk-results list — CSV + JSON share this. */
    const exportColumns = React.useMemo(() => [
        { header: "displayName", accessor: (r) => r.displayName },
        { header: "subscriptionId", accessor: (r) => r.subscriptionId },
        { header: "billingSubName", accessor: (r) => r.billingSubName },
        { header: "operation", accessor: (r) => { var _a; return (_a = r.op) !== null && _a !== void 0 ? _a : opKind; } },
        { header: "destination", accessor: (r) => { var _a; return (_a = r.destination) !== null && _a !== void 0 ? _a : ""; } },
        { header: "state", accessor: (r) => r.state },
        { header: "httpStatus", accessor: (r) => { var _a; return (_a = r.status) !== null && _a !== void 0 ? _a : ""; } },
        { header: "pollUrl", accessor: (r) => { var _a; return (_a = r.pollUrl) !== null && _a !== void 0 ? _a : ""; } },
        { header: "pollOutcome", accessor: (r) => { var _a; return (_a = r.pollOutcome) !== null && _a !== void 0 ? _a : ""; } },
        { header: "pollAttempts", accessor: (r) => { var _a; return (_a = r.pollAttempts) !== null && _a !== void 0 ? _a : ""; } },
        { header: "error", accessor: (r) => { var _a, _b; return (_b = (_a = r.error) !== null && _a !== void 0 ? _a : r.pollError) !== null && _b !== void 0 ? _b : ""; } },
        { header: "startedAt", accessor: (r) => { var _a; return (_a = r.startedAt) !== null && _a !== void 0 ? _a : ""; } },
        { header: "finishedAt", accessor: (r) => { var _a; return (_a = r.finishedAt) !== null && _a !== void 0 ? _a : ""; } },
        { header: "durationMs", accessor: (r) => { var _a; return (_a = r.durationMs) !== null && _a !== void 0 ? _a : ""; } },
    ], [opKind]);
    /** Per-row collapsed-detail toggle so the result list stays scannable. */
    const [expandedRows, setExpandedRows] = React.useState(new Set());
    const toggleExpanded = React.useCallback((rowKey) => {
        setExpandedRows((prev) => {
            const next = new Set(prev);
            if (next.has(rowKey))
                next.delete(rowKey);
            else
                next.add(rowKey);
            return next;
        });
    }, []);
    /** Top-of-card keyboard shortcuts:
     *   - "/" focuses the search box
     *   - Esc aborts an in-flight batch (routes through the confirm modal)
     *   - Ctrl+Enter commits the open confirm dialog when planValid
     *     (saves a click on every batch — the most common destination after
     *     setting up the plan is "press Confirm")
     *   - Ctrl+V is intentionally NOT intercepted here — the CSV-paste
     *     button opens a deliberate textarea so paste-into-page doesn't
     *     ambush an in-flight selection
     */
    React.useEffect(() => {
        const onKey = (e) => {
            var _a;
            const target = e.target;
            const isEditable = target &&
                (target.tagName === "INPUT" ||
                    target.tagName === "TEXTAREA" ||
                    target.isContentEditable);
            // Skip "/" handling when typing in a field so the operator can still
            // search for literal slashes.
            if (e.key === "/" && !isEditable) {
                e.preventDefault();
                (_a = searchInputRef.current) === null || _a === void 0 ? void 0 : _a.focus();
                return;
            }
            // Ctrl+Enter — commit the confirm dialog when it's open and the plan
            // is valid. We don't fire from inside the CSV-paste textarea (where
            // the operator may want Ctrl+Enter to mean "newline").
            if ((e.ctrlKey || e.metaKey) &&
                e.key === "Enter" &&
                confirmOpen &&
                planValid &&
                !running &&
                !csvPasteOpen) {
                e.preventDefault();
                void runRows();
                return;
            }
            if (e.key === "Escape" && running) {
                e.preventDefault();
                requestAbortBatch();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [
        running,
        requestAbortBatch,
        confirmOpen,
        planValid,
        csvPasteOpen,
        runRows,
    ]);
    // Global tenant-switch listener — when the operator flips tenants from
    // anywhere in the app (header switcher, etc.), pivot the SOURCE account
    // picker here to match. We deliberately only sync the source account
    // (the natural pivot for "I just switched tenants, show me that EA");
    // billing-account / destination-EA / destination-tenant state stays put
    // so the operator doesn't lose a half-configured batch plan.
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!candidates.some((a) => a.homeAccountId === candidate))
            return;
        if (accountId === candidate)
            return;
        setAccountId(candidate);
    });
    /* ----- Render --------------------------------------------------- */
    if (candidates.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "Subscription Mover", description: "Bulk-transfer EA billing ownership or change the home tenant of subscriptions." }),
            React.createElement(SignInRequired, { whatYouCantDo: "Move subscriptions", why: "an EA-billing-capable account with owner access on the source enrollment account", onNavigate: (k) => navigateToPage(`/${k}`) })));
    }
    return (React.createElement("div", { className: "flex flex-col gap-4 py-2" },
        React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
            React.createElement(PageHeader, { title: "Subscription Mover", description: "Bulk-transfer EA billing ownership between enrollment accounts, OR change the home tenant of one or more subscriptions." }),
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                    loginHint: account === null || account === void 0 ? void 0 : account.username,
                }) })),
        tokenError && (React.createElement(Alert, { variant: "destructive" },
            React.createElement(AlertDescription, null,
                "ARM token error: ",
                tokenError))),
        React.createElement(Card, null,
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Crown, { className: "h-4 w-4 text-primary" }),
                    "Scope"),
                React.createElement(CardDescription, null, "Pick the signed-in EA-billing account and the billing account whose subscriptions you want to move.")),
            React.createElement(CardContent, { className: "grid grid-cols-1 gap-3 sm:grid-cols-2" },
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
                    React.createElement(Label, { className: "text-xs" }, "Billing account"),
                    baLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                        React.createElement(Loader2, { className: "h-3 w-3 animate-spin" }),
                        "Loading\u2026")) : baError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load billing accounts.", detail: baError })) : billingAccounts.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No EA billing accounts visible.")) : (React.createElement(Select, { value: billingAccountName, onValueChange: setBillingAccountName },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: "Pick a billing account" })),
                        React.createElement(SelectContent, null, billingAccounts.map((b) => (React.createElement(SelectItem, { key: b.name, value: b.name },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, b.displayName),
                                React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                                    b.name,
                                    " \u00B7 ",
                                    b.agreementType))))))))))),
        !billingAccountName ? (React.createElement(EmptyState, { icon: Building2, title: "Pick a billing account", description: "Once selected, every subscription billed under that account appears below." })) : (React.createElement(React.Fragment, null,
            React.createElement(Card, null,
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex flex-wrap items-center gap-2 text-sm" },
                        React.createElement(Server, { className: "h-4 w-4 text-primary" }),
                        "Subscriptions under this billing account",
                        React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            selected.size,
                            "/",
                            subscriptions.length,
                            " selected"),
                        filtered.length !== subscriptions.length && (React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                            filtered.length,
                            " visible"))),
                    React.createElement(CardDescription, null,
                        "Tick the rows to include in the next bulk action. Search works on display name, sub id, billing-sub name, and status. Press ",
                        React.createElement("kbd", { className: "rounded border border-border bg-muted/40 px-1 text-2xs font-mono" }, "/"),
                        " to jump to the search box.")),
                React.createElement(CardContent, { className: "flex flex-col gap-2" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement("div", { className: "relative flex-1 min-w-[220px]" },
                            React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                            React.createElement(Input, { ref: searchInputRef, value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search display name / sub id / status\u2026  (press / to focus)", className: "pl-8 text-xs", "aria-label": "Search subscriptions" }),
                            search && (React.createElement("button", { type: "button", onClick: () => setSearch(""), "aria-label": "Clear search", className: "absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent/30 hover:text-foreground" },
                                React.createElement(X, { className: "h-3 w-3", "aria-hidden": true })))),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: selectAllVisible, disabled: filtered.length === 0, "aria-label": "Add all visible subscriptions to the selection" }, "Select visible"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: clearSelection, disabled: selected.size === 0, "aria-label": "Clear selection" }, "Clear"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: () => void copySelectedIds(), disabled: selected.size === 0, "aria-label": "Copy every selected subscription id to the clipboard" },
                            React.createElement(Copy, { className: "h-3 w-3", "aria-hidden": true }),
                            "Copy IDs"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: openCsvPasteDialog, disabled: running || subscriptions.length === 0, "aria-label": "Paste a CSV or multi-line list of subscription IDs to bulk-select" },
                            React.createElement(ClipboardPaste, { className: "h-3 w-3", "aria-hidden": true }),
                            "Paste IDs"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: reload, disabled: subsLoading, "aria-label": "Refresh subscriptions list" },
                            React.createElement(RefreshCw, { className: "h-3 w-3 motion-reduce:animate-none " + (subsLoading ? "animate-spin" : ""), "aria-hidden": true }),
                            "Refresh")),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "radiogroup", "aria-label": "Filter subscriptions" }, [
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
                    ].map((chip) => (React.createElement(Button, { key: chip.id, type: "button", role: "radio", "aria-checked": quickFilter === chip.id, size: "sm", variant: quickFilter === chip.id ? "default" : "ghost", className: "h-6 gap-1 text-2xs", onClick: () => setQuickFilter(chip.id) },
                        chip.label,
                        React.createElement(Badge, { variant: "outline", className: "text-3xs" }, chip.count))))),
                    subsLoading ? (React.createElement(SkeletonLoader, { variant: "list", rows: 5 })) : subsError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load subscriptions.", detail: subsError, onRetry: reload })) : filtered.length === 0 ? (React.createElement(EmptyState, { icon: Server, title: subscriptions.length === 0
                            ? "No subscriptions billed under this account"
                            : "No subscriptions match the filter", description: subscriptions.length === 0
                            ? "Check that the EA billing account holds the subscriptions you expected, or refresh."
                            : "Adjust the search box or pick a different quick-filter chip." })) : (React.createElement("ul", { className: "flex flex-col gap-1" }, filtered.map((s) => {
                        var _a;
                        const status = ((_a = s.status) !== null && _a !== void 0 ? _a : "").toLowerCase();
                        const isUnsafe = (status && status !== "enabled") ||
                            (opKind === "change-tenant" && !s.subscriptionId);
                        return (React.createElement("li", { key: s.id, className: "flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs " +
                                (selected.has(s.name)
                                    ? "border-primary/40 bg-primary/5"
                                    : "border-border") },
                            React.createElement(Checkbox, { "aria-label": `Select ${s.displayName}`, checked: selected.has(s.name), onCheckedChange: () => toggle(s.name), disabled: running }),
                            React.createElement(Server, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
                            React.createElement("span", { className: "font-medium" }, s.displayName),
                            s.subscriptionId && (React.createElement(CopyableText, { value: s.subscriptionId, mono: true, className: "text-muted-foreground", ariaLabel: `Copy subscription id ${s.subscriptionId}` })),
                            s.status && (React.createElement(Badge, { variant: status === "enabled" ? "outline" : "secondary", className: "text-2xs" }, s.status)),
                            isUnsafe && (React.createElement(InfoTooltip, { side: "top", variant: "info", ariaLabel: "Why this row may be skipped", content: opKind === "change-tenant" && !s.subscriptionId
                                    ? "Cross-tenant moves require an AAD subscriptionId. This row will be skipped (or rejected by Azure)."
                                    : "Subscription is not in the Enabled state. Azure typically rejects move/changeTenant on Disabled/Warned/Expired/Deleted subs." }))));
                    }))))),
            selected.size > 0 && (React.createElement(Card, { className: "border-primary/40" },
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(ShieldCheck, { className: "h-4 w-4 text-primary" }),
                        "Bulk action \u2014 ",
                        selectedSubs.length,
                        " subscription",
                        selectedSubs.length === 1 ? "" : "s",
                        " selected",
                        skipUnsafe && selectedSubs.length !== rowsToRun.length && (React.createElement(Badge, { variant: "secondary", className: "text-2xs" },
                            rowsToRun.length,
                            " will run"))),
                    React.createElement(CardDescription, null, "Pick one operation to apply to the whole selection. Each row is async on Azure's side (1\u20135 min); the page can optionally poll the Azure-AsyncOperation URL until each row terminates.")),
                React.createElement(CardContent, { className: "flex flex-col gap-3" },
                    React.createElement("div", { role: "radiogroup", "aria-label": "Operation", className: "inline-flex flex-wrap items-center rounded-md border border-border bg-background p-0.5" },
                        React.createElement(Button, { type: "button", role: "radio", "aria-checked": opKind === "transfer-billing", size: "sm", variant: opKind === "transfer-billing" ? "default" : "ghost", className: "h-7 text-xs", onClick: () => setOpKind("transfer-billing") },
                            React.createElement(FolderTree, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                            "Transfer billing ownership"),
                        React.createElement(InfoTooltip, { side: "top", ariaLabel: "About transferring billing ownership", className: "mx-1", content: React.createElement("span", null,
                                React.createElement("strong", null, "Transfer billing ownership"),
                                " reassigns the subscription to another enrollment account inside the same EA billing account. The home tenant does not change \u2014 only who pays for it. Calls the ARM endpoint",
                                React.createElement("code", { className: "ml-1 font-mono" }, "POST /billingSubscriptions/{name}/move"),
                                "and is async on Azure's side (1\u20135 min).") }),
                        React.createElement(Button, { type: "button", role: "radio", "aria-checked": opKind === "change-tenant", size: "sm", variant: opKind === "change-tenant" ? "default" : "ghost", className: "h-7 text-xs", onClick: () => setOpKind("change-tenant") },
                            React.createElement(Layers, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                            "Change tenant (directory)"),
                        React.createElement(InfoTooltip, { side: "top", ariaLabel: "About changing the home tenant", className: "mx-1", content: React.createElement("span", null,
                                React.createElement("strong", null, "Change tenant"),
                                " moves the subscription's home AAD tenant. Billing ownership is preserved. The source tenant's policy may require an admin in the destination tenant to ",
                                React.createElement("em", null, "accept"),
                                " the offer before the subscription appears there. Calls",
                                React.createElement("code", { className: "ml-1 font-mono" }, "POST /subscriptions/{id}/changeTenant"),
                                "(api-version 2021-10-01).") })),
                    opKind === "transfer-billing" && (React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { className: "text-xs" }, "Destination enrollment account"),
                        eaLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
                            React.createElement(Loader2, { className: "h-3 w-3 animate-spin" }),
                            " loading")) : eaError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load enrollment accounts.", detail: eaError })) : enrollmentAccounts.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No enrollment accounts visible.")) : (React.createElement(Select, { value: destEnrollmentArmId, onValueChange: setDestEnrollmentArmId },
                            React.createElement(SelectTrigger, null,
                                React.createElement(SelectValue, { placeholder: "Pick an enrollment account" })),
                            React.createElement(SelectContent, null, enrollmentAccounts.map((ea) => (React.createElement(SelectItem, { key: ea.id, value: ea.id },
                                React.createElement("span", { className: "flex flex-col" },
                                    React.createElement("span", { className: "text-sm" }, ea.displayName),
                                    React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                                        ea.name,
                                        ea.accountOwner
                                            ? ` · ${ea.accountOwner}`
                                            : "")))))))),
                        destEnrollmentArmId && (React.createElement(CopyableText, { value: destEnrollmentArmId, mono: true, alwaysVisibleButton: true, className: "rounded border border-border bg-muted/30 px-2 py-1", ariaLabel: `Copy enrollment ARM id ${destEnrollmentArmId}` })),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            "POST /billingSubscriptions/{name}/move with",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "destinationEnrollmentAccountId"),
                            "."))),
                    opKind === "change-tenant" && (React.createElement("div", { className: "flex flex-col gap-3" },
                        (account === null || account === void 0 ? void 0 : account.tenantId) && (React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                                "Source tenant",
                                React.createElement(InfoTooltip, { side: "top", ariaLabel: "About the source tenant", content: "The current home tenant of the selected subscriptions. The ARM token used for the changeTenant POST is minted against this tenant." })),
                            React.createElement(CopyableText, { value: account.tenantId, mono: true, ariaLabel: `Copy source tenant id ${account.tenantId}`, alwaysVisibleButton: true, className: "rounded-md border border-border bg-muted/30 px-2 py-1" }))),
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { htmlFor: "sub-mover-dest-tenant", className: "flex items-center gap-1 text-xs" },
                                "Destination tenant ID",
                                React.createElement(InfoTooltip, { side: "top", ariaLabel: "About the destination tenant", content: "AAD tenant GUID that should become the new home tenant. An admin in this tenant may need to accept the offer before Azure surfaces the subscription." })),
                            React.createElement(Input, { id: "sub-mover-dest-tenant", value: destTenantId, onChange: (e) => setDestTenantId(e.target.value), placeholder: "11111111-2222-3333-4444-555555555555", className: "font-mono text-xs", "aria-label": "Destination tenant ID", "aria-invalid": destTenantId.length > 0 &&
                                    !UUID_RE.test(destTenantId.trim())
                                    ? true
                                    : undefined }),
                            React.createElement("p", { className: "text-2xs text-muted-foreground" },
                                "POST",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "/subscriptions/{id}/changeTenant"),
                                " ",
                                "(api-version 2021-10-01). Source tenant policy may require an admin in the destination tenant to accept the offer before the sub appears there.")),
                        recentDestTenants.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { className: "flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground" },
                                "Recently used",
                                React.createElement(InfoTooltip, { side: "top", ariaLabel: "About recently used destination tenants", content: "Tenants you've successfully moved subscriptions to before \u2014 click to refill the destination box. Stored locally; the X removes one entry." })),
                            React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "list", "aria-label": "Recently used destination tenants" }, recentDestTenants.map((entry) => {
                                var _a, _b, _c;
                                const active = destTenantId.trim().toLowerCase() ===
                                    entry.tenantId.toLowerCase();
                                return (React.createElement("span", { key: entry.tenantId, role: "listitem", className: "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-mono " +
                                        (active
                                            ? "border-primary/40 bg-primary/10"
                                            : "border-border bg-muted/30") },
                                    React.createElement("button", { type: "button", className: "text-left hover:text-primary focus:outline-none focus:underline", onClick: () => setDestTenantId(entry.tenantId), "aria-label": `Use recent destination tenant ${(_a = entry.label) !== null && _a !== void 0 ? _a : entry.tenantId}`, "aria-pressed": active, disabled: running }, (_b = entry.label) !== null && _b !== void 0 ? _b : entry.tenantId),
                                    React.createElement("button", { type: "button", className: "rounded p-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground focus:outline-none focus:ring-1", onClick: () => forgetRecentDestTenant(entry.tenantId), "aria-label": `Remove ${(_c = entry.label) !== null && _c !== void 0 ? _c : entry.tenantId} from recent tenants`, disabled: running },
                                        React.createElement(X, { className: "h-3 w-3", "aria-hidden": true }))));
                            })))))),
                    React.createElement("div", { className: "flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/20 p-2" },
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(Label, { htmlFor: "sub-mover-concurrency", className: "flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground" },
                                "Parallelism",
                                React.createElement(InfoTooltip, { side: "top", ariaLabel: "About parallelism", content: "How many rows run at the same time. 1 = strictly sequential (one audit-log row at a time). Higher values finish faster but interleave the audit log." })),
                            React.createElement(Select, { value: String(concurrency), onValueChange: (v) => setConcurrency(Number(v)) },
                                React.createElement(SelectTrigger, { id: "sub-mover-concurrency", className: "h-8 w-[110px] text-xs" },
                                    React.createElement(SelectValue, null)),
                                React.createElement(SelectContent, null, CONCURRENCY_CHOICES.map((n) => (React.createElement(SelectItem, { key: n, value: String(n) }, n === 1 ? "1 (sequential)" : `${n} parallel`)))))),
                        React.createElement("label", { className: "flex items-center gap-2 text-xs" },
                            React.createElement(Checkbox, { checked: pollLros, onCheckedChange: (v) => setPollLros(v === true), disabled: running, "aria-label": "Poll Azure async-operation until complete" }),
                            React.createElement("span", { className: "flex items-center gap-1" },
                                "Poll until done",
                                React.createElement(InfoTooltip, { side: "top", ariaLabel: "About async-operation polling", content: "After Azure accepts each row (202), poll the Azure-AsyncOperation URL until the LRO reaches Succeeded / Failed / Canceled. With this off, the row is marked accepted as soon as the POST returns." }))),
                        React.createElement("label", { className: "flex items-center gap-2 text-xs" },
                            React.createElement(Checkbox, { checked: skipUnsafe, onCheckedChange: (v) => setSkipUnsafe(v === true), disabled: running, "aria-label": "Auto-skip rows flagged as unsafe" }),
                            React.createElement("span", { className: "flex items-center gap-1" },
                                "Auto-skip unsafe rows",
                                React.createElement(InfoTooltip, { side: "top", ariaLabel: "About auto-skip", content: "Skip rows that are not in the Enabled state, have no subscriptionId (for change-tenant), or already appear to be on the destination enrollment account. Recommended." })))),
                    (() => {
                        const ok = [];
                        const warn = [];
                        // Plan feasibility — these are the bare minimum.
                        if (opKind === "transfer-billing") {
                            if (destEnrollmentArmId.trim()) {
                                ok.push("Destination enrollment account selected.");
                            }
                            else {
                                warn.push("Pick a destination enrollment account before confirming.");
                            }
                        }
                        else {
                            const dest = destTenantId.trim();
                            if (UUID_RE.test(dest)) {
                                ok.push("Destination tenant ID is a valid GUID.");
                            }
                            else if (dest) {
                                warn.push("Destination tenant ID is not a well-formed GUID — Azure will 400 the request.");
                            }
                            else {
                                warn.push("Enter the destination tenant ID.");
                            }
                        }
                        if (billingAccountName) {
                            ok.push("EA billing account in scope.");
                        }
                        else {
                            warn.push("Billing-account scope is unset.");
                        }
                        if (previewClassification.safeRows.length === selectedSubs.length &&
                            selectedSubs.length > 0) {
                            ok.push(`All ${selectedSubs.length} selected subscription${selectedSubs.length === 1 ? " looks" : "s look"} eligible.`);
                        }
                        const exp = armTokenTracker.secondsUntilExpiry;
                        if (exp == null) {
                            // No data yet — neutral.
                        }
                        else if (exp >= 600) {
                            ok.push(`ARM token fresh (${Math.round(exp / 60)} min left).`);
                        }
                        else if (exp >= 300) {
                            ok.push(`ARM token has ${Math.round(exp / 60)} min before expiry — fine for short batches.`);
                        }
                        if (ok.length + warn.length === 0)
                            return null;
                        return (React.createElement("div", { className: "flex flex-col gap-1 rounded-md border border-border bg-muted/15 p-2 text-2xs", role: "status", "aria-live": "polite" },
                            React.createElement("p", { className: "font-medium uppercase tracking-wider text-muted-foreground" }, "Pre-flight"),
                            React.createElement("ul", { className: "flex flex-col gap-0.5" },
                                ok.map((line, i) => (React.createElement("li", { key: `ok-${i}`, className: "flex items-start gap-1.5" },
                                    React.createElement(CheckCircle2, { className: "mt-0.5 h-3 w-3 shrink-0 text-success", "aria-hidden": true }),
                                    React.createElement("span", null, line)))),
                                warn.map((line, i) => (React.createElement("li", { key: `warn-${i}`, className: "flex items-start gap-1.5" },
                                    React.createElement(AlertTriangle, { className: "mt-0.5 h-3 w-3 shrink-0 text-warning", "aria-hidden": true }),
                                    React.createElement("span", null, line)))))));
                    })(),
                    planWarnings.length > 0 && (React.createElement(Alert, { variant: "destructive", className: "border-warning/40 bg-warning/10" },
                        React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement(AlertDescription, null,
                            React.createElement("ul", { className: "list-inside list-disc text-xs" }, planWarnings.map((w, idx) => (React.createElement("li", { key: idx }, w))))))),
                    opKind === "change-tenant" && rowsToRun.length > 0 && (React.createElement(Alert, { variant: "info" },
                        React.createElement(Eye, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement(AlertDescription, null,
                            React.createElement("p", { className: "text-xs" },
                                React.createElement("strong", null, "Audit-trail note:"),
                                " the full migration event for a cross-tenant sub move is recorded in the",
                                " ",
                                React.createElement("em", null, "destination"),
                                " tenant's Activity Log (Microsoft.Subscription/aliases). The source tenant only retains the outbound",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "changeTenant"),
                                " POST. Pivot to the destination tenant when reconciling after this batch.")))),
                    requiresBulkCrossTenantAck && (React.createElement(Alert, { variant: "destructive", className: "border-destructive/50 bg-destructive/5" },
                        React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement(AlertDescription, null,
                            React.createElement("div", { className: "flex flex-col gap-2 text-xs" },
                                React.createElement("p", null,
                                    React.createElement("strong", null,
                                        "Bulk cross-tenant move (",
                                        rowsToRun.length,
                                        " subs to",
                                        " ",
                                        React.createElement("code", { className: "font-mono" }, destTenantId.trim()),
                                        ")."),
                                    " ",
                                    "Moving ",
                                    BULK_CROSS_TENANT_THRESHOLD,
                                    "+ subscriptions to a single foreign tenant in one batch is unusual enough to warrant explicit acknowledgement. This is a one-way change-of-billing-relationship \u2014 the destination tenant gains full directory control, and the migration is logged in the destination tenant's audit log."),
                                React.createElement("label", { className: "flex items-center gap-2" },
                                    React.createElement(Checkbox, { checked: bulkCrossTenantAck, onCheckedChange: (v) => setBulkCrossTenantAck(v === true), disabled: running, "aria-label": "Acknowledge bulk cross-tenant move risk" }),
                                    React.createElement("span", { className: "font-medium" },
                                        "I understand this moves ",
                                        rowsToRun.length,
                                        " ",
                                        "subscriptions out of my tenant and acknowledge the destination-tenant audit trail.")))))),
                    skipUnsafe && rowsToRun.length === 0 && selectedSubs.length > 0 && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement(AlertDescription, null,
                            "Every selected row was flagged as unsafe and would be skipped. Either fix the destination/source mismatch or uncheck ",
                            React.createElement("em", null, "Auto-skip unsafe rows"),
                            " to force the batch anyway."))),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Button, { type: "button", variant: "default", onClick: () => setConfirmOpen(true), disabled: !planValid || running, loading: running, "aria-label": opKind === "transfer-billing"
                                ? `Transfer billing ownership of ${rowsToRun.length} subscriptions`
                                : `Change home tenant on ${rowsToRun.length} subscriptions` },
                            !running && React.createElement(ArrowRight, { "aria-hidden": true }),
                            running
                                ? "Running…"
                                : opKind === "transfer-billing"
                                    ? `Transfer ${rowsToRun.length} sub${rowsToRun.length === 1 ? "" : "s"}`
                                    : `Change tenant on ${rowsToRun.length} sub${rowsToRun.length === 1 ? "" : "s"}`),
                        running && (React.createElement(Button, { type: "button", variant: "outline", onClick: requestAbortBatch, "aria-label": "Abort remaining rows in this batch (opens a confirmation, Esc)", "aria-haspopup": "dialog" },
                            React.createElement(Octagon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                            "Abort (Esc)")),
                        running && batchElapsedMs > 0 && (React.createElement("span", { className: "ml-1 inline-flex items-center gap-1 rounded-md bg-muted/40 px-2 py-1 text-2xs text-muted-foreground" },
                            React.createElement(Hourglass, { className: "h-3 w-3", "aria-hidden": true }),
                            "Elapsed ",
                            fmtDuration(batchElapsedMs)))),
                    running && results.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1", role: "status", "aria-live": "polite", "aria-atomic": "false" }, (() => {
                        const total = results.length;
                        const finished = resultStats.success +
                            resultStats.failed +
                            resultStats.cancelled;
                        const pct = total > 0 ? Math.round((finished / total) * 100) : 0;
                        return (React.createElement(React.Fragment, null,
                            React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground" },
                                React.createElement("span", null,
                                    "Progress: ",
                                    finished,
                                    "/",
                                    total,
                                    " (",
                                    pct,
                                    "%)",
                                    resultStats.runningCount > 0
                                        ? ` — ${resultStats.runningCount} running`
                                        : "",
                                    resultStats.pollingCount > 0
                                        ? ` — ${resultStats.pollingCount} polling`
                                        : ""),
                                batchEta != null && (React.createElement("span", { className: "inline-flex items-center gap-1" },
                                    React.createElement(Hourglass, { className: "h-3 w-3", "aria-hidden": true }),
                                    "ETA ~",
                                    fmtDuration(batchEta),
                                    React.createElement("span", { className: "text-3xs opacity-70" },
                                        "(avg ",
                                        fmtDuration(resultStats.avgMs),
                                        "/row)")))),
                            React.createElement("div", { className: "h-1.5 w-full overflow-hidden rounded-full bg-muted", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "Batch progress" },
                                React.createElement("div", { className: "h-full bg-primary transition-[width] motion-reduce:transition-none", style: { width: `${pct}%` } }))));
                    })()))))),
            results.length > 0 && (React.createElement(Card, null,
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement(CardTitle, { className: "text-sm" }, "Operation results"),
                            React.createElement(CardDescription, null, "Each row is one ARM accept call (and, when polling is on, the matching Azure-AsyncOperation poll). Failed rows can be retried in place; everything is captured in the audit log.")),
                        React.createElement("div", { className: "flex items-center gap-2" },
                            resultStats.failed > 0 && !running && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: rerunFailed, "aria-label": `Rerun ${resultStats.failed} failed rows` },
                                React.createElement(RotateCcw, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                "Rerun ",
                                resultStats.failed,
                                " failed")),
                            !running && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearResults, "aria-label": "Clear the results list" },
                                React.createElement(Trash2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                "Clear")),
                            React.createElement(ExportMenu, { rows: results, columns: exportColumns, filename: "sub-mover-results", jsonMetadata: {
                                    billingAccountName,
                                    operation: opKind,
                                    destination: opKind === "transfer-billing"
                                        ? destEnrollmentArmId.trim()
                                        : destTenantId.trim(),
                                    sourceTenantId: account === null || account === void 0 ? void 0 : account.tenantId,
                                    actor: (_b = account === null || account === void 0 ? void 0 : account.username) !== null && _b !== void 0 ? _b : accountId,
                                    concurrency,
                                    polledLros: pollLros,
                                } })))),
                React.createElement(CardContent, { className: "flex flex-col gap-2" },
                    React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Bulk operation summary" },
                        React.createElement(SummaryStatItem, { label: "Total queued", value: results.length, compact: true }),
                        React.createElement(SummaryStatItem, { label: "In flight", value: resultStats.runningCount +
                                resultStats.queued +
                                resultStats.pollingCount, tone: "info", compact: true, hint: resultStats.pollingCount > 0
                                ? `${resultStats.pollingCount} polling`
                                : resultStats.queued > 0
                                    ? `${resultStats.queued} pending`
                                    : undefined }),
                        React.createElement(SummaryStatItem, { label: "Success", value: resultStats.success, tone: "success", compact: true }),
                        React.createElement(SummaryStatItem, { label: "Failed", value: resultStats.failed, tone: "destructive", compact: true }),
                        resultStats.cancelled > 0 && (React.createElement(SummaryStatItem, { label: "Cancelled", value: resultStats.cancelled, tone: "warning", compact: true })),
                        resultStats.completedDurations > 0 && (React.createElement(SummaryStatItem, { label: "Avg time / row", value: fmtDuration(resultStats.avgMs), compact: true, hint: `${resultStats.completedDurations} completed` }))),
                    !running &&
                        results.length > 0 &&
                        results.some((r) => r.op === "change-tenant" && r.state === "success") && (React.createElement(Alert, { variant: "info", className: "mt-1" },
                        React.createElement(Eye, { className: "h-4 w-4", "aria-hidden": true }),
                        React.createElement(AlertDescription, null,
                            React.createElement("div", { className: "flex flex-col gap-1 text-xs" },
                                React.createElement("p", { className: "font-medium" }, "Audit-trail reconciliation"),
                                React.createElement("p", { className: "text-muted-foreground" }, "Cross-tenant moves are recorded asymmetrically. Verify the batch landed by checking BOTH tenants:"),
                                React.createElement("ul", { className: "list-inside list-disc text-2xs" },
                                    React.createElement("li", null,
                                        React.createElement("strong", null, "Source tenant"),
                                        " ",
                                        (account === null || account === void 0 ? void 0 : account.tenantId) ? (React.createElement("code", { className: "font-mono" },
                                            "(",
                                            account.tenantId,
                                            ")")) : null,
                                        " ",
                                        "\u2014 Activity Log should show",
                                        " ",
                                        React.createElement("code", { className: "font-mono" }, "Microsoft.Subscription/changeTenantStatus"),
                                        " ",
                                        "entries."),
                                    React.createElement("li", null,
                                        React.createElement("strong", null, "Destination tenant"),
                                        " ",
                                        (() => {
                                            var _a;
                                            const dest = (_a = results.find((r) => r.op === "change-tenant" &&
                                                r.state === "success" &&
                                                r.destination)) === null || _a === void 0 ? void 0 : _a.destination;
                                            return dest ? (React.createElement("code", { className: "font-mono" },
                                                "(",
                                                dest,
                                                ")")) : null;
                                        })(),
                                        " ",
                                        "\u2014 Activity Log should show new",
                                        " ",
                                        React.createElement("code", { className: "font-mono" }, "Microsoft.Subscription/aliases"),
                                        " ",
                                        "+ the sub appears under Cost Management/Subscriptions. May need destination- tenant admin to ",
                                        React.createElement("em", null, "accept the offer"),
                                        "."),
                                    React.createElement("li", null, "Any subs still missing after ~15 min \u2192 destination tenant likely needs to redeem the transfer offer (or the destination tenant's policy blocks inbound subs).")))))),
                    React.createElement("div", { className: "flex flex-col gap-1", role: "log", "aria-live": "polite", "aria-relevant": "text", "aria-label": "Per-subscription operation progress" }, results.map((r) => {
                        const expanded = expandedRows.has(r.rowKey);
                        return (React.createElement("div", { key: r.rowKey, className: "flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs " +
                                (r.state === "failure"
                                    ? "border-destructive/40 bg-destructive/5"
                                    : r.state === "success"
                                        ? "border-success/30"
                                        : "border-border") },
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement("button", { type: "button", onClick: () => toggleExpanded(r.rowKey), "aria-expanded": expanded, "aria-label": expanded ? "Collapse row details" : "Expand row details", className: "inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground" }, expanded ? (React.createElement(ChevronDown, { className: "h-3 w-3", "aria-hidden": true })) : (React.createElement(ChevronRight, { className: "h-3 w-3", "aria-hidden": true }))),
                                React.createElement(Server, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
                                React.createElement("span", { className: "font-medium" }, r.displayName),
                                React.createElement(CopyableText, { value: r.subscriptionId, mono: true, className: "text-muted-foreground", ariaLabel: `Copy subscription id ${r.subscriptionId}` }),
                                r.state === "pending" && (React.createElement(Badge, { variant: "outline", className: "gap-1 text-2xs" }, "pending")),
                                r.state === "running" && (React.createElement(Badge, { variant: "secondary", className: "gap-1 text-2xs" },
                                    React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none", "aria-hidden": true }),
                                    " ",
                                    "running")),
                                r.state === "polling" && (React.createElement(Badge, { variant: "secondary", className: "gap-1 text-2xs" },
                                    React.createElement(Hourglass, { className: "h-3 w-3 animate-pulse motion-reduce:animate-none", "aria-hidden": true }),
                                    "polling",
                                    r.pollAttempts ? ` (#${r.pollAttempts})` : "")),
                                r.state === "success" && (React.createElement(Badge, { variant: "success", className: "gap-1 text-2xs" },
                                    React.createElement(CheckCircle2, { className: "h-3 w-3", "aria-hidden": true }),
                                    r.pollOutcome === "Succeeded"
                                        ? "succeeded"
                                        : "accepted")),
                                r.state === "failure" && (React.createElement(Badge, { variant: "destructive", className: "gap-1 text-2xs" },
                                    React.createElement(X, { className: "h-3 w-3", "aria-hidden": true }),
                                    " failed")),
                                r.state === "cancelled" && (React.createElement(Badge, { variant: "outline", className: "gap-1 text-2xs" },
                                    React.createElement(Octagon, { className: "h-3 w-3", "aria-hidden": true }),
                                    " cancelled")),
                                r.status ? (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                    "HTTP ",
                                    r.status)) : null,
                                r.durationMs != null && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                    "\u00B7 ",
                                    fmtDuration(r.durationMs)))),
                            r.error && (React.createElement("p", { className: "break-words pl-7 text-2xs text-destructive" }, r.error)),
                            expanded && (React.createElement("div", { className: "flex flex-col gap-1 pl-7 text-2xs" },
                                r.destination && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
                                    React.createElement("span", { className: "text-muted-foreground" }, "destination:"),
                                    React.createElement(CopyableText, { value: r.destination, mono: true, alwaysVisibleButton: true, ariaLabel: "Copy destination identifier" }))),
                                r.pollUrl && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
                                    React.createElement("span", { className: "text-muted-foreground" }, "poll URL:"),
                                    React.createElement(CopyableText, { value: r.pollUrl, mono: true, alwaysVisibleButton: true, ariaLabel: "Copy Azure async-operation URL" }))),
                                r.startedAt && (React.createElement("div", null,
                                    React.createElement("span", { className: "text-muted-foreground" }, "started:"),
                                    " ",
                                    React.createElement("span", { className: "font-mono" }, r.startedAt))),
                                r.finishedAt && (React.createElement("div", null,
                                    React.createElement("span", { className: "text-muted-foreground" }, "finished:"),
                                    " ",
                                    React.createElement("span", { className: "font-mono" }, r.finishedAt))),
                                React.createElement("div", { className: "flex flex-wrap items-center gap-2 pt-1" },
                                    React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => void copyToClipboard(buildCurl(r, account === null || account === void 0 ? void 0 : account.tenantId)), "aria-label": "Copy cURL command for replay" },
                                        React.createElement(Copy, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Copy as cURL"),
                                    (r.state === "success" ||
                                        r.pollOutcome === "Succeeded") && (React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => __awaiter(void 0, void 0, void 0, function* () {
                                            const ok = yield copyToClipboard(r.subscriptionId);
                                            if (ok) {
                                                store.addNotification({
                                                    type: "info",
                                                    message: `Copied subscription id ${r.subscriptionId} to clipboard.`,
                                                });
                                            }
                                        }), "aria-label": `Copy resulting subscription id ${r.subscriptionId}` },
                                        React.createElement(Copy, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Copy result id")))))));
                    }))))))),
        React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: opKind === "transfer-billing"
                ? "Transfer billing ownership"
                : "Change subscription tenant", message: React.createElement("div", { className: "flex flex-col gap-2 text-xs" },
                confirmMessage.split("\n\n").map((para, i) => (React.createElement("p", { key: i, className: "whitespace-pre-wrap" }, para))),
                rowsToRun.length > 0 && rowsToRun.length <= 10 && (React.createElement("details", { className: "rounded border border-border bg-muted/20 p-2 text-2xs" },
                    React.createElement("summary", { className: "cursor-pointer font-medium text-muted-foreground" },
                        "Show ",
                        rowsToRun.length,
                        " target subscription",
                        rowsToRun.length === 1 ? "" : "s"),
                    React.createElement("ul", { className: "mt-1 flex flex-col gap-0.5 pl-3" }, rowsToRun.map((s) => (React.createElement("li", { key: s.id, className: "font-mono" },
                        s.displayName,
                        s.subscriptionId ? ` — ${s.subscriptionId}` : "")))))),
                rowsToRun.length > 10 && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                    "(",
                    rowsToRun.length,
                    " subscriptions selected \u2014 list omitted for brevity, see the result panel after confirming.)")),
                rowsToRun.length > 0 && (React.createElement("details", { className: "rounded border border-border bg-muted/20 p-2 text-2xs" },
                    React.createElement("summary", { className: "cursor-pointer font-medium text-muted-foreground" }, "Show ARM request preview (sanitized, no tokens)"),
                    React.createElement("pre", { className: "mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-3xs" }, (() => {
                        var _a;
                        const sample = rowsToRun[0];
                        const dest = opKind === "transfer-billing"
                            ? destEnrollmentArmId.trim()
                            : destTenantId.trim();
                        const preview = buildArmRequestPreview(opKind, dest, billingAccountName, (_a = sample.subscriptionId) !== null && _a !== void 0 ? _a : sample.name, sample.name);
                        return [
                            `${preview.method} https://management.azure.com${preview.url}`,
                            `Authorization: Bearer <redacted>`,
                            `Content-Type: application/json`,
                            ``,
                            JSON.stringify(preview.body, null, 2),
                            ``,
                            rowsToRun.length > 1
                                ? `(${rowsToRun.length - 1} additional row${rowsToRun.length === 2 ? "" : "s"} dispatched with the same body shape, swapping the subscription identifier.)`
                                : ``,
                        ]
                            .filter(Boolean)
                            .join("\n");
                    })()))),
                React.createElement("p", { className: "text-2xs text-muted-foreground" },
                    "Tip:",
                    " ",
                    React.createElement("kbd", { className: "rounded border border-border bg-muted/40 px-1 text-3xs font-mono" }, "Ctrl+Enter"),
                    " ",
                    "commits this dialog.")), confirmText: opKind === "transfer-billing" ? "Transfer" : "Change tenant", danger: true, loading: running, onConfirm: () => runBatch(), onCancel: () => setConfirmOpen(false) }),
        React.createElement(ConfirmationDialog, { hidden: !abortConfirmOpen, title: "Abort running batch?", message: React.createElement("div", { className: "flex flex-col gap-2 text-xs" },
                React.createElement("p", null, "Stop the in-flight batch now? Rows that Azure has already accepted will continue to run server-side and may complete regardless. Rows still pending in the queue will be marked cancelled."),
                React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Polling (where enabled) is aborted immediately, so the page stops watching the async-operation URL. Re-check the destination tenant / enrollment account after a few minutes to see what actually landed.")), confirmText: "Abort batch", cancelText: "Keep running", danger: true, onConfirm: confirmAbortBatch, onCancel: () => setAbortConfirmOpen(false) }),
        React.createElement(ConfirmationDialog, { hidden: !csvPasteOpen, title: "Bulk-select by paste", message: React.createElement("div", { className: "flex flex-col gap-2 text-xs" },
                React.createElement("p", null,
                    "Paste a list of subscription IDs (UUIDs), billing-sub names, or full ARM IDs \u2014 newline, comma, semicolon, or whitespace separated. Matched rows are ",
                    React.createElement("strong", null, "added"),
                    " to the current selection; nothing is removed."),
                React.createElement("label", { htmlFor: "sub-mover-csv-paste", className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Paste here"),
                React.createElement("textarea", { id: "sub-mover-csv-paste", value: csvPasteBuffer, onChange: (e) => {
                        setCsvPasteBuffer(e.target.value);
                        // Clear the prior outcome banner whenever the buffer
                        // changes so the result line always reflects the most
                        // recent Apply press.
                        if (csvPasteResult)
                            setCsvPasteResult(null);
                    }, rows: 8, autoFocus: true, placeholder: "00000000-0000-0000-0000-000000000000\n" +
                        "11111111-1111-1111-1111-111111111111, ea-billing-sub-name\n" +
                        "/providers/Microsoft.Billing/billingAccounts/.../billingSubscriptions/xyz", spellCheck: false, autoComplete: "off", autoCorrect: "off", className: "min-h-[140px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-2xs outline-none focus:ring-1 focus:ring-ring", "aria-label": "Subscription IDs to bulk-select" }),
                csvPasteResult && (React.createElement("div", { className: "rounded-md border p-2 text-2xs " +
                        (csvPasteResult.matched > 0
                            ? "border-success/40 bg-success/5"
                            : "border-warning/40 bg-warning/10"), role: "status", "aria-live": "polite" },
                    React.createElement("p", null,
                        React.createElement("strong", null, csvPasteResult.matched),
                        " token",
                        csvPasteResult.matched === 1 ? "" : "s",
                        " matched and added to the selection."),
                    csvPasteResult.unknown.length > 0 && (React.createElement("details", { className: "mt-1" },
                        React.createElement("summary", { className: "cursor-pointer font-medium text-warning" },
                            csvPasteResult.unknown.length,
                            " unresolved token",
                            csvPasteResult.unknown.length === 1 ? "" : "s"),
                        React.createElement("ul", { className: "mt-1 max-h-32 overflow-auto pl-3 font-mono" },
                            csvPasteResult.unknown.slice(0, 50).map((tok, i) => (React.createElement("li", { key: i, className: "break-all" }, tok))),
                            csvPasteResult.unknown.length > 50 && (React.createElement("li", { className: "text-muted-foreground" },
                                "(\u2026+",
                                csvPasteResult.unknown.length - 50,
                                " more)"))))))),
                React.createElement("p", { className: "text-3xs text-muted-foreground" }, "Resolution order per token: ARM id \u2192 AAD subscriptionId \u2192 billing-sub name \u2192 last path segment.")), confirmText: "Apply", cancelText: "Close", onConfirm: () => {
                applyCsvPaste();
            }, onCancel: () => setCsvPasteOpen(false) })));
};
//# sourceMappingURL=sub-mover-page.js.map