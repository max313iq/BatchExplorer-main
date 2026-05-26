import { __awaiter } from "tslib";
/**
 * Legacy EA Sub Creator — uses the 2018-03-01-preview Subscription
 * creation API documented at
 *   https://learn.microsoft.com/azure/cost-management-billing/manage/
 *     programmatically-create-subscription
 *
 * Flow:
 *   1. List enrollment accounts the caller is an Owner on:
 *      GET /providers/Microsoft.Billing/enrollmentAccounts?api-version=2018-03-01-preview
 *   2. POST createSubscription with the enrollment-account object id +
 *      offerType (MS-AZR-0017P or MS-AZR-0148P) + optional owners.
 *   3. Poll the Location header until ARM returns the subscriptionLink.
 *
 * Different from the existing EA Subscription page (which uses the
 * modern Subscription Alias API): no alias name, no cross-tenant owner
 * required, fewer optional fields, but capped at 5000 subs per
 * enrollment account.
 *
 * IMPORTANT — this page wraps a **deprecated** API path. Newer EA
 * enrollments routinely return `Commerce Account Is Null` because the
 * legacy billing namespace was never populated for them. The UI keeps
 * this page available for the rare automation that specifically needs
 * the 2018-03-01-preview shape, but it shows persistent deprecation
 * banners and gates the submit behind an acknowledgement so nobody
 * accidentally builds a new workflow on top of the dying endpoint.
 */
import * as React from "react";
import { AlertTriangle, ArrowRight, BadgeCheck, Building2, Check, CheckCircle2, Crown, Eraser, ExternalLink, Eye, History, Info, Keyboard, Loader2, Plus, RefreshCw, RotateCcw, Save, Shield, Sparkles, Terminal, Trash2, User, XCircle, Zap, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { getActiveTenant, getArmTokenForAccount, } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { createLegacyEaSubscription, listLegacyEnrollmentAccounts, } from "../../services";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
// COORDINATOR: page consumes the dashboard outlet context (orchestrator,
// store, navigateToPage) instead of calling `useNavigate` directly — the
// shared `navigateToPage` already resolves PageKey strings to canonical
// paths and is what page-router promises every page.
import { useDashboardOutletContext } from "../page-router";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { StatusBadge } from "../shared/status-badge";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
/* --------------------------------------------------------------------- */
/* Constants                                                             */
/* --------------------------------------------------------------------- */
const STORAGE_ACCOUNT = "legacy-ea-sub:account";
const STORAGE_EA = "legacy-ea-sub:enrollment-account";
const STORAGE_MANUAL_GUID = "legacy-ea-sub:manual-guid";
const STORAGE_HISTORY = "legacy-ea-sub:session-history";
const STORAGE_ACK = "legacy-ea-sub:deprecation-acknowledged";
// localStorage-backed (NOT sessionStorage) — survives full reload, so an
// operator who refreshes mid-fill keeps their draft.
const STORAGE_DRAFT = "legacy-ea-sub:draft";
const STORAGE_DRAFT_VERSION = 1;
// Per-EA subscription cap that ARM enforces on the 2018-03-01-preview
// path. Canceled / transferred / deleted subs still count toward it.
const EA_SUBSCRIPTION_CAP = 5000;
const DISPLAY_NAME_MAX = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Match `/providers/Microsoft.Billing/enrollmentAccounts/<guid>` so the
// manual-mode input accepts a full ARM path that an operator might paste
// from a runbook or `az billing` command.
const ARM_EA_PATH_RE = /\/providers\/Microsoft\.Billing\/enrollmentAccounts\/([0-9a-f-]{36})/i;
const DRAFT_EMPTY = {
    displayName: "",
    offerType: "MS-AZR-0017P",
    owners: [],
    updatedAt: "",
};
function isDraftMeaningful(d) {
    return d.displayName.trim().length > 0 || d.owners.length > 0;
}
const ERROR_CLASS_EMPTY = {
    deprecated: false,
    invalidOffer: false,
    expired: false,
    forbidden: false,
    unauthorized: false,
    throttled: false,
};
/* --------------------------------------------------------------------- */
/* Helpers                                                               */
/* --------------------------------------------------------------------- */
/**
 * Best-effort load of the in-session history from sessionStorage. Keeps
 * the timeline / export intact across navigations to other pages within
 * the same tab — a full reload still wipes it (sessionStorage by design).
 */
function loadSessionHistory() {
    try {
        const raw = sessionStorage.getItem(STORAGE_HISTORY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        // Filter to entries that at least have the required scalar shape;
        // protects against schema drift if we ever change SessionEntry.
        return parsed.filter((e) => typeof e === "object" &&
            e !== null &&
            typeof e.timestamp === "string" &&
            typeof e.displayName === "string" &&
            typeof e.offerType === "string" &&
            typeof e.enrollmentAccountId === "string");
    }
    catch (_a) {
        return [];
    }
}
function saveSessionHistory(entries) {
    try {
        sessionStorage.setItem(STORAGE_HISTORY, JSON.stringify(entries));
    }
    catch (_a) {
        /* sessionStorage full / unavailable — non-fatal */
    }
}
/**
 * Pull a GUID out of arbitrary input — handles bare GUIDs, full ARM
 * resource paths, and surrounding whitespace / quotation marks an
 * operator might paste from a doc or runbook.
 */
function extractEnrollmentGuid(raw) {
    const trimmed = raw.trim().replace(/^["']|["']$/g, "");
    if (UUID_RE.test(trimmed))
        return trimmed.toLowerCase();
    const m = ARM_EA_PATH_RE.exec(trimmed);
    return m ? m[1].toLowerCase() : trimmed;
}
/**
 * Classify a submit error string into one of the targeted help buckets
 * below. Order of detection matters: "commerce account is null" wins
 * over a generic "offer not enabled" because the dedicated deprecation
 * panel is more actionable.
 */
function classifyError(msg) {
    const out = Object.assign({}, ERROR_CLASS_EMPTY);
    if (/commerce account is null/i.test(msg) ||
        /commerce.+account.+null/i.test(msg)) {
        out.deprecated = true;
    }
    if (/offer .* is not enabled/i.test(msg) ||
        /offer type .* invalid/i.test(msg) ||
        /devtest .* not enabled/i.test(msg)) {
        out.invalidOffer = true;
    }
    if (/enrollment .* (expired|inactive|not active|terminated)/i.test(msg) ||
        /enrollment account .* (expired|inactive)/i.test(msg)) {
        out.expired = true;
    }
    if (/\b(401|unauthor[iz]ed|invalid.token|token.expired)\b/i.test(msg) ||
        /authentication failed/i.test(msg)) {
        out.unauthorized = true;
    }
    if (/\b(403|forbidden)\b/i.test(msg) ||
        /authorization.failed/i.test(msg) ||
        /does not have authorization/i.test(msg)) {
        out.forbidden = true;
    }
    if (/\b(429|throttl|too many requests|rate.?limit)\b/i.test(msg) ||
        /retry.?after/i.test(msg)) {
        out.throttled = true;
    }
    return out;
}
/**
 * Build an `az rest` command that exactly mirrors the create call this
 * page would POST. Handy for the audit trail or for handing off to a
 * shell when the browser can't reach ARM directly.
 */
function buildAzRestCommand(enrollmentAccountId, body) {
    var _a;
    const url = `https://management.azure.com/providers/Microsoft.Billing/enrollmentAccounts/` +
        `${enrollmentAccountId}/providers/Microsoft.Subscription/createSubscription` +
        `?api-version=2018-03-01-preview`;
    const payload = { offerType: body.offerType };
    if ((_a = body.displayName) === null || _a === void 0 ? void 0 : _a.trim())
        payload.displayName = body.displayName.trim();
    if (body.owners && body.owners.length > 0) {
        payload.owners = body.owners.map((o) => ({ objectId: o }));
    }
    // Single-line `--body` argument so the command pastes cleanly into
    // PowerShell / bash without escaping headaches.
    const json = JSON.stringify(payload);
    return `az rest --method POST --uri "${url}" --headers "Content-Type=application/json" --body '${json}'`;
}
/**
 * Build a raw `curl` command mirroring the create call. Useful for ops
 * environments that don't have the az CLI installed (or for capturing
 * the legitimate flow for replay, as the cross-tenant playbook §5.1
 * recommends — see `_ea_subscription_cross_tenant.md`). The token is
 * intentionally rendered as `$ARM_TOKEN` so we never leak a live bearer
 * into a clipboard / screenshot; operators substitute it at run time.
 */
function buildCurlCommand(enrollmentAccountId, body) {
    var _a;
    const url = `https://management.azure.com/providers/Microsoft.Billing/enrollmentAccounts/` +
        `${enrollmentAccountId}/providers/Microsoft.Subscription/createSubscription` +
        `?api-version=2018-03-01-preview`;
    const payload = { offerType: body.offerType };
    if ((_a = body.displayName) === null || _a === void 0 ? void 0 : _a.trim())
        payload.displayName = body.displayName.trim();
    if (body.owners && body.owners.length > 0) {
        payload.owners = body.owners.map((o) => ({ objectId: o }));
    }
    const json = JSON.stringify(payload);
    return (`curl -sS -X POST "${url}" ` +
        `-H "Authorization: Bearer $ARM_TOKEN" ` +
        `-H "Content-Type: application/json" ` +
        `-d '${json}'`);
}
/**
 * Map a legacy EA offer type onto the modern alias-API `workload` field.
 * The 2018-03-01-preview endpoint encodes Production/DevTest implicitly
 * in the offer code; the 2021-10-01 alias API exposes it as an explicit
 * `workload` enum. Cf. `_ea_subscription_cross_tenant.md` §4 — the
 * "Field-by-field origin" table treats workload as a Tenant-A-side
 * billing-scope decision, which is preserved here.
 */
function offerTypeToWorkload(offer) {
    return offer === "MS-AZR-0148P" ? "DevTest" : "Production";
}
/**
 * Operator-anomaly classifier. The corpus playbook
 * `_ea_subscription_cross_tenant.md` (legacy-vs-modern, §§ summary +
 * `BillingAccountReadFailed` row of §8) explains that every EA
 * enrollment registered after ~2022 lacks a commerce-account record under
 * the legacy namespace. Repeated successful or even attempted submissions
 * against this page therefore fall into one of two patterns:
 *
 *  (a) A pinned legacy automation that has a specific reason to target
 *      the 2018-03-01-preview shape (rare, but legitimate).
 *  (b) Reconnaissance / stealth-persistence: an operator deliberately
 *      using a deprecated path either because it logs less verbosely
 *      than the modern one, or because their tooling pre-dates the
 *      alias API and they haven't migrated.
 *
 * We don't claim certainty either way; we surface a banner so a human can
 * review. The thresholds are intentionally permissive (>=3 legacy
 * submissions in-session, OR the operator hit "Commerce Account Is Null"
 * once and continued submitting anyway) so noise stays low.
 *
 * @param entries  the in-memory session history for this page
 * @returns        anomaly flags + reasoning to render
 */
function classifyOperatorPattern(entries) {
    const legacyCount = entries.length;
    let cainAfterCount = 0;
    let sawCain = false;
    for (const e of entries) {
        if (sawCain)
            cainAfterCount++;
        if (e.outcome === "failure" &&
            e.error &&
            /commerce account is null/i.test(e.error)) {
            sawCain = true;
        }
    }
    const reasons = [];
    if (legacyCount >= 3) {
        reasons.push(`${legacyCount} legacy submissions this session — the modern alias ` +
            `API supports the same EA scope plus cross-tenant landing and ` +
            `dev/test workload. Repeated legacy use without a pinned-runbook ` +
            `reason is unusual.`);
    }
    if (cainAfterCount > 0) {
        reasons.push(`Continued submitting after a "Commerce Account Is Null" response ` +
            `(the deprecation signal for newer EA enrollments). ` +
            `${cainAfterCount} subsequent attempt${cainAfterCount === 1 ? "" : "s"} recorded.`);
    }
    return {
        anomalous: reasons.length > 0,
        reasons,
        legacyCount,
        cainAfterCount,
    };
}
/** Suggest a timestamp-suffixed display name when the field is empty. */
function suggestDisplayName() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `Legacy-EA-Sub-${yyyy}${mm}${dd}-${hh}${mi}`;
}
/** Human-friendly relative time for the session history strip. */
function timeAgo(iso) {
    const then = Date.parse(iso);
    if (Number.isNaN(then))
        return iso;
    const s = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (s < 60)
        return `${s}s ago`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}
/* --------------------------------------------------------------------- */
/* Page                                                                  */
/* --------------------------------------------------------------------- */
export const LegacyEaSubCreatorPage = () => {
    var _a, _b, _c;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    // COORDINATOR: use the path-based navigator from the dashboard outlet
    // context rather than calling `useNavigate()` directly. `navigateToPage`
    // accepts either a PageKey or a literal path and is what page-router
    // promises every page consumes.
    const { navigateToPage } = useDashboardOutletContext();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    /* ----- Account picker ------------------------------------------ */
    const candidates = React.useMemo(() => azureAccounts
        .map((a) => {
        var _a;
        const tenantId = (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : resolveActiveTenantId(a);
        if (!tenantId)
            return null;
        return {
            homeAccountId: a.homeAccountId,
            tenantId,
            username: a.username,
            name: a.name || a.username,
        };
    })
        .filter((a) => a !== null), [azureAccounts]);
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
    /* ----- ARM token + enrollment accounts ------------------------- */
    const [armToken, setArmToken] = React.useState(null);
    // Central ARM-token tracker — handles tenant-switch re-mint,
    // pre-expiry refresh, and feeds the TokenExpiryBadge below. The
    // existing `armToken` state is kept for downstream call sites; the
    // sync bridge below mirrors fresh tokens from the tracker into it.
    const armTokenTracker = useArmToken(account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId);
    React.useEffect(() => {
        if (armTokenTracker.token && armTokenTracker.token !== armToken) {
            setArmToken(armTokenTracker.token);
        }
    }, [armTokenTracker.token, armToken]);
    const [eas, setEas] = React.useState([]);
    const [eaLoading, setEaLoading] = React.useState(false);
    const [eaError, setEaError] = React.useState(null);
    const [enrollmentAccountId, setEnrollmentAccountIdState] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_EA)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    const setEnrollmentAccountId = React.useCallback((id) => {
        setEnrollmentAccountIdState(id);
        try {
            sessionStorage.setItem(STORAGE_EA, id);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    // "Enter EA object id manually" escape hatch — the listing call hits
    // a preview ARM endpoint that some networks / browsers block with a
    // generic "Failed to fetch". Letting the operator paste the GUID
    // directly bypasses the listing entirely. The pasted GUID survives a
    // page nav within the tab via sessionStorage.
    const [manualMode, setManualMode] = React.useState(false);
    const [manualInput, setManualInput] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(STORAGE_MANUAL_GUID)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    // Mirror manualInput → sessionStorage so a tab-internal navigation
    // doesn't make the operator paste the GUID again.
    React.useEffect(() => {
        try {
            if (manualInput.trim()) {
                sessionStorage.setItem(STORAGE_MANUAL_GUID, manualInput.trim());
            }
            else {
                sessionStorage.removeItem(STORAGE_MANUAL_GUID);
            }
        }
        catch (_a) {
            /* ignore */
        }
    }, [manualInput]);
    // Bumping `listSeq` triggers a refetch of the enrollment-account
    // listing without reloading the page. Used by the "Refresh" button
    // and after the operator flips out of manual mode.
    const [listSeq, setListSeq] = React.useState(0);
    // Track the most recent listing run so a slower previous one can't
    // overwrite newer state if the operator quickly flips the account or
    // hits Refresh while a request is still in flight. The boolean
    // `cancelled` guard from the old code is preserved but `runIdRef`
    // gives strict last-writer-wins ordering across overlapping runs.
    const runIdRef = React.useRef(0);
    // Migrated to `useAbortableEffect` so on unmount / dep-change the signal
    // is aborted automatically. The two service helpers don't accept a
    // signal arg directly, but the post-resolution `signal.aborted` guards
    // still prevent stale-write races (runIdRef preserves last-writer-wins
    // ordering across overlapping refreshes; the signal handles teardown).
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
        if (!account) {
            setArmToken(null);
            setEas([]);
            return;
        }
        const myRunId = ++runIdRef.current;
        const actor = account.username;
        const tenantId = account.tenantId;
        setEaLoading(true);
        setEaError(null);
        try {
            // Tenant arg omitted so we pick up the operator's current active
            // tenant (was pinning to account.tenantId / the account's HOME
            // tenant — pre-switch).
            const tok = yield getArmTokenForAccount(account.homeAccountId);
            if (signal.aborted || myRunId !== runIdRef.current)
                return;
            setArmToken(tok);
            const list = yield listLegacyEnrollmentAccounts(tok);
            if (signal.aborted || myRunId !== runIdRef.current)
                return;
            setEas(list);
            if (list.length === 1 && enrollmentAccountId !== list[0].name) {
                setEnrollmentAccountId(list[0].name);
            }
            else if (enrollmentAccountId &&
                !list.some((e) => e.name === enrollmentAccountId)) {
                setEnrollmentAccountId("");
            }
            // Success audit: which actor saw which enrollment accounts.
            auditLog.record({
                actor,
                action: "list_legacy_enrollment_accounts",
                target: tenantId,
                status: "success",
                details: { count: list.length },
            });
        }
        catch (err) {
            if (signal.aborted || myRunId !== runIdRef.current)
                return;
            const msg = err instanceof Error ? err.message : String(err);
            setEaError(msg);
            setEas([]);
            // "Failed to fetch" is a browser-level rejection (CORS, ad-
            // blocker, network policy, …) that lookups can't recover from.
            // Flip to manual mode so the operator can paste the GUID and
            // proceed — the create call hits a different path that may
            // succeed even when listing doesn't.
            if (/failed to fetch|networkerror|load failed/i.test(msg)) {
                setManualMode(true);
            }
            // Failure audit so silent listing problems are still observable
            // from the audit-log page.
            auditLog.record({
                actor,
                action: "list_legacy_enrollment_accounts",
                target: tenantId,
                status: "failure",
                error: msg,
            });
        }
        finally {
            if (!signal.aborted && myRunId === runIdRef.current) {
                setEaLoading(false);
            }
        }
    }), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account === null || account === void 0 ? void 0 : account.homeAccountId, account === null || account === void 0 ? void 0 : account.tenantId, listSeq]);
    const selectedEa = React.useMemo(() => {
        var _a;
        // In manual mode the synthetic row stands in for a listed one —
        // the GUID is all the createSubscription endpoint actually needs.
        const cleaned = extractEnrollmentGuid(manualInput);
        if (manualMode && UUID_RE.test(cleaned)) {
            return {
                id: `/providers/Microsoft.Billing/enrollmentAccounts/${cleaned}`,
                name: cleaned,
                principalName: undefined,
            };
        }
        return (_a = eas.find((e) => e.name === enrollmentAccountId)) !== null && _a !== void 0 ? _a : null;
    }, [manualMode, manualInput, eas, enrollmentAccountId]);
    /* ----- Form state (draft survives full reload) ----------------- */
    // Persisted draft so a mid-fill reload doesn't lose the displayName /
    // offer / owners. Versioned envelope via `usePersistedState` so a future
    // shape change can migrate cleanly. The EA selection itself is in
    // sessionStorage (intentionally per-tab) — only the form *content*
    // survives a hard reload.
    const [draft, setDraft, resetDraft] = usePersistedState(STORAGE_DRAFT, DRAFT_EMPTY, {
        version: STORAGE_DRAFT_VERSION,
        migrate: (raw) => {
            if (typeof raw !== "object" || raw === null)
                return undefined;
            const r = raw;
            return {
                displayName: typeof r.displayName === "string" ? r.displayName : "",
                offerType: r.offerType === "MS-AZR-0148P" ? "MS-AZR-0148P" : "MS-AZR-0017P",
                owners: Array.isArray(r.owners)
                    ? r.owners.filter((o) => typeof o === "string" && UUID_RE.test(o))
                    : [],
                updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
            };
        },
    });
    // Snapshot of the draft as it was on first mount — used by the "draft
    // restored" banner so we only nag the operator once per page-visit, not
    // on every keystroke (which would also rewrite `updatedAt`).
    const draftOnMountRef = React.useRef(draft);
    const [draftBannerDismissed, setDraftBannerDismissed] = React.useState(false);
    const displayName = draft.displayName;
    const offerType = draft.offerType;
    const owners = draft.owners;
    const setDisplayName = React.useCallback((next) => {
        setDraft((prev) => (Object.assign(Object.assign({}, prev), { displayName: next, updatedAt: new Date().toISOString() })));
    }, [setDraft]);
    const setOfferType = React.useCallback((next) => {
        setDraft((prev) => (Object.assign(Object.assign({}, prev), { offerType: next, updatedAt: new Date().toISOString() })));
    }, [setDraft]);
    const setOwners = React.useCallback((updater) => {
        setDraft((prev) => (Object.assign(Object.assign({}, prev), { owners: typeof updater === "function"
                ? updater(prev.owners)
                : updater, updatedAt: new Date().toISOString() })));
    }, [setDraft]);
    const [ownerInput, setOwnerInput] = React.useState("");
    // URL-state for the offer type so a deep link / shared URL can pre-set
    // it. Wins over the persisted draft only on first mount (subsequent
    // changes flow draft -> URL via a side-effect below).
    const [urlFilter, setUrlFilter] = useUrlState({ offer: "" }, { replace: true, keys: ["offer"] });
    React.useEffect(() => {
        var _a;
        // Hydrate offer type from the URL exactly once on mount when it's
        // present and valid.
        const u = String((_a = urlFilter.offer) !== null && _a !== void 0 ? _a : "");
        if (u === "MS-AZR-0017P" || u === "MS-AZR-0148P") {
            if (u !== draft.offerType)
                setOfferType(u);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    React.useEffect(() => {
        // Mirror draft.offerType -> URL so a refresh / share preserves it,
        // but only once the URL is already participating (URL contains the
        // key or the operator has changed offer type away from the default).
        // This keeps the URL clean for first-time visitors who never touch
        // the offer-type select.
        const offerInUrl = typeof urlFilter.offer === "string" && urlFilter.offer.length > 0;
        if (!offerInUrl && draft.offerType === "MS-AZR-0017P")
            return;
        if (urlFilter.offer !== draft.offerType) {
            setUrlFilter({ offer: draft.offerType });
        }
    }, [draft.offerType, urlFilter.offer, setUrlFilter]);
    const addOwner = React.useCallback(() => {
        const v = ownerInput.trim().toLowerCase();
        if (!UUID_RE.test(v))
            return;
        if (owners.includes(v)) {
            setOwnerInput("");
            return;
        }
        setOwners((prev) => [...prev, v]);
        setOwnerInput("");
    }, [ownerInput, owners, setOwners]);
    const removeOwner = React.useCallback((oid) => {
        setOwners((prev) => prev.filter((o) => o !== oid));
    }, [setOwners]);
    const clearOwners = React.useCallback(() => {
        setOwners([]);
    }, [setOwners]);
    const displayNameTrimmed = displayName.trim();
    const displayNameTooLong = displayNameTrimmed.length > DISPLAY_NAME_MAX;
    const displayNameEmpty = displayNameTrimmed.length === 0;
    const [submitting, setSubmitting] = React.useState(false);
    const [submitError, setSubmitError] = React.useState(null);
    const [errorClass, setErrorClass] = React.useState(ERROR_CLASS_EMPTY);
    const [result, setResult] = React.useState(null);
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    // Track submit invocations so a slower earlier submit can't overwrite
    // the result of a newer one (rare but the symptom is a "succeeded"
    // toast referencing a stale subscription id).
    const submitIdRef = React.useRef(0);
    // Persistent (session-scoped) deprecation acknowledgement. The
    // confirmation dialog still re-prompts with a checkbox, but once the
    // operator has acknowledged it stays acknowledged for the whole tab
    // session — they don't have to re-check it for every submit.
    const [deprecationAck, setDeprecationAckState] = React.useState(() => {
        try {
            return sessionStorage.getItem(STORAGE_ACK) === "1";
        }
        catch (_a) {
            return false;
        }
    });
    const setDeprecationAck = React.useCallback((v) => {
        setDeprecationAckState(v);
        try {
            if (v)
                sessionStorage.setItem(STORAGE_ACK, "1");
            else
                sessionStorage.removeItem(STORAGE_ACK);
        }
        catch (_a) {
            /* ignore */
        }
    }, []);
    /* ----- Session history ----------------------------------------- */
    const [sessionHistory, setSessionHistory] = React.useState(() => loadSessionHistory());
    // Mirror history to sessionStorage on every change so a navigation
    // inside the tab preserves the timeline / export.
    React.useEffect(() => {
        saveSessionHistory(sessionHistory);
    }, [sessionHistory]);
    const successCount = React.useMemo(() => sessionHistory.filter((s) => s.outcome === "success").length, [sessionHistory]);
    const failureCount = sessionHistory.length - successCount;
    const clearHistory = React.useCallback(() => {
        setSessionHistory([]);
    }, []);
    /* ----- Submit gate --------------------------------------------- */
    const canSubmit = !submitting &&
        !!armToken &&
        !!selectedEa &&
        !!offerType &&
        !displayNameEmpty &&
        !displayNameTooLong &&
        deprecationAck;
    /** Aggregate list of reasons a draft would fail to submit right now.
     *  Used by the always-visible validation banner so the operator sees a
     *  full checklist of remaining work without having to click Submit and
     *  read a one-line tooltip. Empty array = the draft would post. */
    const validationIssues = React.useMemo(() => {
        const issues = [];
        if (!account) {
            issues.push({
                id: "account",
                severity: "error",
                text: "Pick a signed-in Azure account.",
            });
        }
        if (!armToken) {
            issues.push({
                id: "token",
                severity: "warn",
                text: "Waiting for ARM token to acquire — usually a second or two.",
            });
        }
        if (!selectedEa) {
            issues.push({
                id: "ea",
                severity: "error",
                text: manualMode
                    ? "Paste a valid enrollment-account GUID above."
                    : "Pick an enrollment account from the list above.",
            });
        }
        if (displayNameEmpty) {
            issues.push({
                id: "name",
                severity: "error",
                text: "Display name is required.",
            });
        }
        else if (displayNameTooLong) {
            issues.push({
                id: "name-long",
                severity: "error",
                text: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer (currently ${displayNameTrimmed.length}).`,
            });
        }
        if (!deprecationAck) {
            issues.push({
                id: "ack",
                severity: "warn",
                text: "Acknowledge the deprecation banner at the top.",
            });
        }
        if (ownerInput.trim().length > 0 && !UUID_RE.test(ownerInput.trim())) {
            issues.push({
                id: "owner-pending",
                severity: "warn",
                text: "Pending owner input isn't a valid AAD object id — fix or clear it before submitting.",
            });
        }
        return issues;
    }, [
        account,
        armToken,
        selectedEa,
        manualMode,
        displayNameEmpty,
        displayNameTooLong,
        displayNameTrimmed.length,
        deprecationAck,
        ownerInput,
    ]);
    /** Why submit is disabled — surfaces inline so the disabled state
     *  doesn't feel mysterious. Empty when the button is usable. */
    const submitBlockedReason = (() => {
        if (submitting)
            return "Submitting…";
        if (!armToken)
            return "Waiting for ARM token to acquire.";
        if (!selectedEa)
            return "Pick an enrollment account first.";
        if (displayNameEmpty)
            return "Display name is required.";
        if (displayNameTooLong)
            return `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.`;
        if (!deprecationAck)
            return "Acknowledge the deprecation banner above first.";
        return "";
    })();
    const submit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _d, _e, _f, _g;
        if (!canSubmit || !armToken || !selectedEa)
            return;
        const mySubmitId = ++submitIdRef.current;
        setSubmitting(true);
        setSubmitError(null);
        setErrorClass(ERROR_CLASS_EMPTY);
        setResult(null);
        // Snapshot inputs at the moment of submission so a state change
        // mid-flight (operator types into displayName, swaps offer type)
        // doesn't make the audit log lie about what we actually sent.
        const snapshot = {
            enrollmentAccountId: selectedEa.name,
            enrollmentAccountOwner: selectedEa.principalName,
            displayName: displayNameTrimmed,
            offerType,
            owners: owners.slice(),
        };
        // Audit enrichment — these stay on every submission (success or fail)
        // so an incident reviewer can reconstruct the exact context the call
        // was made in. Per CLAUDE.md "audit payload enhancement" and the
        // corpus reasoning that legacy use itself is a defender-visible
        // signal worth recording (`_ea_subscription_cross_tenant.md`).
        const submissionStartedAt = Date.now();
        const auditContext = {
            apiVersion: "2018-03-01-preview",
            manualMode,
            draftRestored: isDraftMeaningful(draftOnMountRef.current),
            deprecationAcknowledged: deprecationAck,
            submitInvocation: mySubmitId,
            // Window origin so cross-tab session-correlation is possible when
            // the audit log is exported and merged with other operator-touch
            // events from other tabs.
            windowOriginHost: typeof window !== "undefined" ? (_e = (_d = window.location) === null || _d === void 0 ? void 0 : _d.host) !== null && _e !== void 0 ? _e : "" : "",
        };
        try {
            const r = yield createLegacyEaSubscription(snapshot.enrollmentAccountId, {
                displayName: snapshot.displayName,
                offerType: snapshot.offerType,
                owners: snapshot.owners,
            }, armToken);
            if (mySubmitId !== submitIdRef.current)
                return; // stale
            setResult(r);
            auditLog.record({
                actor: (_f = account === null || account === void 0 ? void 0 : account.username) !== null && _f !== void 0 ? _f : "",
                action: "create_legacy_ea_subscription",
                target: snapshot.displayName,
                status: "success",
                details: Object.assign(Object.assign({}, auditContext), { enrollmentAccountObjectId: snapshot.enrollmentAccountId, enrollmentAccountOwner: snapshot.enrollmentAccountOwner, offerType: snapshot.offerType, workloadEquivalent: offerTypeToWorkload(snapshot.offerType), ownerCount: snapshot.owners.length, subscriptionId: r.subscriptionId, httpStatus: r.status, submissionLatencyMs: Date.now() - submissionStartedAt }),
            });
            setSessionHistory((prev) => [
                ...prev,
                {
                    timestamp: new Date().toISOString(),
                    displayName: snapshot.displayName,
                    offerType: snapshot.offerType,
                    enrollmentAccountId: snapshot.enrollmentAccountId,
                    enrollmentAccountOwner: snapshot.enrollmentAccountOwner,
                    subscriptionId: r.subscriptionId,
                    subscriptionLink: r.subscriptionLink,
                    httpStatus: r.status,
                    ownerCount: snapshot.owners.length,
                    outcome: "success",
                },
            ]);
            store.addNotification({
                type: "success",
                message: r.subscriptionId
                    ? `Created subscription ${r.subscriptionId}.`
                    : "Create accepted by ARM — subscription link is below.",
            });
        }
        catch (err) {
            if (mySubmitId !== submitIdRef.current)
                return;
            const msg = err instanceof Error ? err.message : String(err);
            setSubmitError(msg);
            setErrorClass(classifyError(msg));
            auditLog.record({
                actor: (_g = account === null || account === void 0 ? void 0 : account.username) !== null && _g !== void 0 ? _g : "",
                action: "create_legacy_ea_subscription",
                target: snapshot.displayName,
                status: "failure",
                error: msg,
                details: Object.assign(Object.assign({}, auditContext), { enrollmentAccountObjectId: snapshot.enrollmentAccountId, enrollmentAccountOwner: snapshot.enrollmentAccountOwner, offerType: snapshot.offerType, workloadEquivalent: offerTypeToWorkload(snapshot.offerType), ownerCount: snapshot.owners.length, submissionLatencyMs: Date.now() - submissionStartedAt, 
                    // Pre-classify the error so log-analytics queries can group
                    // CAIN / 403 / 429 patterns without re-parsing the raw msg.
                    errorClassification: classifyError(msg) }),
            });
            setSessionHistory((prev) => [
                ...prev,
                {
                    timestamp: new Date().toISOString(),
                    displayName: snapshot.displayName,
                    offerType: snapshot.offerType,
                    enrollmentAccountId: snapshot.enrollmentAccountId,
                    enrollmentAccountOwner: snapshot.enrollmentAccountOwner,
                    httpStatus: 0,
                    ownerCount: snapshot.owners.length,
                    outcome: "failure",
                    error: msg,
                },
            ]);
            store.addNotification({
                type: "error",
                message: `Legacy create failed: ${msg.slice(0, 120)}`,
            });
        }
        finally {
            if (mySubmitId === submitIdRef.current)
                setSubmitting(false);
        }
    }), [
        canSubmit,
        armToken,
        selectedEa,
        displayNameTrimmed,
        offerType,
        owners,
        account === null || account === void 0 ? void 0 : account.username,
        store,
    ]);
    /** Reset the form to its initial empty state — preserves the picked
     *  source account, enrollment-account selection, and history. Wires
     *  the "Reset" button under the result card. Also clears the
     *  localStorage-persisted draft so a subsequent reload starts clean. */
    const resetForm = React.useCallback(() => {
        resetDraft();
        setOwnerInput("");
        setSubmitError(null);
        setErrorClass(ERROR_CLASS_EMPTY);
        setResult(null);
        draftOnMountRef.current = DRAFT_EMPTY;
        setDraftBannerDismissed(true);
    }, [resetDraft]);
    /** Drop the persisted draft without disturbing anything else — wires
     *  the "Discard draft" button in the restored-draft banner. */
    const discardDraft = React.useCallback(() => {
        resetDraft();
        draftOnMountRef.current = DRAFT_EMPTY;
        setDraftBannerDismissed(true);
    }, [resetDraft]);
    /** Jump-to-modern helper — used by the deprecation banner and the
     *  CAIN ("Commerce Account Is Null") recovery panel. Sends the
     *  operator to **ea-sub-quick** (NOT the full ea-subscription page).
     *  The button labels promise "EA Sub Quick" so the navigation has
     *  to match — previously this navigated to /ea-subscription and
     *  seeded the wrong sessionStorage keys, leaving the user on the
     *  wrong page with no pre-fill.
     *
     *  Seeds the sessionStorage keys ea-sub-quick reads on mount so the
     *  account picker is pre-selected. The legacy flat enrollment-
     *  account namespace doesn't carry a parent billing-account, so we
     *  CAN'T pre-seed `ea-sub-quick:billing-account`; the operator
     *  picks it on the modern page and ea-sub-quick's BA→EA cascade
     *  takes over from there. We still seed the enrollment-account
     *  name as a hint that ea-sub-quick will apply once the matching
     *  BA is picked. */
    const jumpToModernPage = React.useCallback(() => {
        var _a, _b;
        try {
            if (account === null || account === void 0 ? void 0 : account.homeAccountId) {
                sessionStorage.setItem("ea-sub-quick:account", account.homeAccountId);
            }
            if (selectedEa) {
                sessionStorage.setItem("ea-sub-quick:enrollment-account", selectedEa.name);
            }
        }
        catch (_c) {
            /* sessionStorage unavailable — non-fatal */
        }
        // Context-preserving redirect: forward the in-progress draft into the
        // modern page's URL-state keys (name / wl / so) so the operator
        // doesn't re-type the displayName + workload + first owner. The
        // modern page hydrates from `useUrlState({ name, wl, st, so })` —
        // see ea-sub-quick-page.tsx:940.
        //
        // We deliberately do NOT pass `st` (subscriptionTenantId) — the legacy
        // page has no notion of a target tenant; in the cross-tenant playbook
        // this is exactly the Tenant-B GUID the operator must pick on the
        // modern page anyway (`_ea_subscription_cross_tenant.md` §4 "Field-by-
        // field origin"). Passing a blind value would be misleading.
        const params = new URLSearchParams();
        const trimmedName = draft.displayName.trim();
        if (trimmedName)
            params.set("name", trimmedName);
        params.set("wl", offerTypeToWorkload(draft.offerType));
        if (draft.owners.length > 0 && draft.owners[0]) {
            params.set("so", draft.owners[0]);
        }
        const qs = params.toString();
        // Audit the navigation so an incident reviewer can replay the chain
        // (legacy → modern after CAIN, or operator-initiated migration).
        try {
            auditLog.record({
                actor: (_a = account === null || account === void 0 ? void 0 : account.username) !== null && _a !== void 0 ? _a : "",
                action: "legacy_to_modern_redirect",
                target: (_b = selectedEa === null || selectedEa === void 0 ? void 0 : selectedEa.name) !== null && _b !== void 0 ? _b : "(none)",
                status: "success",
                details: {
                    fromPage: "legacy-ea-sub-creator",
                    toPage: "ea-sub-quick",
                    carriedDisplayName: !!trimmedName,
                    workload: offerTypeToWorkload(draft.offerType),
                    ownerCount: draft.owners.length,
                    // If we have a known CAIN-after pattern in this session,
                    // tag the redirect so SOC dashboards can correlate
                    // recovery flows. Cheap to compute since session history
                    // is in-state.
                    cainTriggered: errorClass.deprecated,
                },
            });
        }
        catch (_d) {
            /* audit logger is best-effort */
        }
        // COORDINATOR: path-based nav via outlet context (NOT useNavigate).
        navigateToPage(qs ? `/ea-sub-quick?${qs}` : "/ea-sub-quick");
    }, [
        account === null || account === void 0 ? void 0 : account.homeAccountId,
        account === null || account === void 0 ? void 0 : account.username,
        selectedEa,
        draft.displayName,
        draft.offerType,
        draft.owners,
        errorClass.deprecated,
        navigateToPage,
    ]);
    // Ctrl+M / Cmd+M — jump to the modern flow with current state. Mirrors
    // the deprecation banner button; saves a click for ops who live on the
    // keyboard. We only register the listener when the page is mounted, and
    // we skip while focus is inside an editable element so the shortcut
    // doesn't fire mid-typing in case a textarea ever lands here.
    React.useEffect(() => {
        const onKey = (e) => {
            if (!(e.ctrlKey || e.metaKey))
                return;
            if (e.key !== "m" && e.key !== "M")
                return;
            // Skip when focus is in a contentEditable region (we tolerate
            // typing in <input> / <select> because legacy-page operators
            // routinely want the shortcut mid-fill).
            const t = e.target;
            if (t && t.isContentEditable)
                return;
            e.preventDefault();
            jumpToModernPage();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [jumpToModernPage]);
    /**
     * CAIN auto-pivot countdown. When the legacy endpoint returns
     * "Commerce Account Is Null", we know with high certainty this
     * enrollment will never succeed against the deprecated API. Rather
     * than leaving the operator staring at red text, count down 8s and
     * auto-fire `jumpToModernPage`. The countdown shows a Cancel
     * button so they can stay on the legacy page if they need to copy
     * the raw error for a support ticket. Cleared whenever the error
     * class changes or the operator cancels.
     */
    const [autoPivotSec, setAutoPivotSec] = React.useState(null);
    React.useEffect(() => {
        if (!submitError || !errorClass.deprecated) {
            setAutoPivotSec(null);
            return;
        }
        setAutoPivotSec(8);
        const id = window.setInterval(() => {
            setAutoPivotSec((s) => {
                if (s === null)
                    return null;
                if (s <= 1) {
                    window.clearInterval(id);
                    // Defer to next tick so React finishes this render cycle
                    // before we navigate (avoids the navigation racing the
                    // state update that cleared autoPivotSec).
                    window.setTimeout(() => jumpToModernPage(), 0);
                    return null;
                }
                return s - 1;
            });
        }, 1000);
        return () => window.clearInterval(id);
    }, [submitError, errorClass.deprecated, jumpToModernPage]);
    const cancelAutoPivot = React.useCallback(() => setAutoPivotSec(null), []);
    /* ----- Derived ------------------------------------------------- */
    const manualGuidExtracted = extractEnrollmentGuid(manualInput);
    const manualGuidValid = manualInput.length > 0 && UUID_RE.test(manualGuidExtracted);
    const ownersValid = ownerInput.length === 0 || UUID_RE.test(ownerInput.trim());
    // Build the curl-equivalent command up-front so the "Copy as az
    // command" button is instant.
    const azCommandPreview = React.useMemo(() => {
        if (!selectedEa)
            return "";
        return buildAzRestCommand(selectedEa.name, {
            displayName: displayNameTrimmed,
            offerType,
            owners,
        });
    }, [selectedEa, displayNameTrimmed, offerType, owners]);
    // Raw cURL — for environments without the az CLI, and for replay-
    // capture flows (`_ea_subscription_cross_tenant.md` §5.1) where the
    // operator wants to paste an exact reproducible call into a runbook.
    // The bearer is rendered as `$ARM_TOKEN`; we never embed the live
    // token in clipboard contents.
    const curlCommandPreview = React.useMemo(() => {
        if (!selectedEa)
            return "";
        return buildCurlCommand(selectedEa.name, {
            displayName: displayNameTrimmed,
            offerType,
            owners,
        });
    }, [selectedEa, displayNameTrimmed, offerType, owners]);
    // Operator-anomaly classification — see `classifyOperatorPattern` for
    // the corpus-grounded rationale. Cheap to recompute on every history
    // change; memoize anyway so downstream effects don't re-fire on
    // unrelated re-renders.
    const operatorAnomaly = React.useMemo(() => classifyOperatorPattern(sessionHistory), [sessionHistory]);
    // JSON payload preview (kept identical to what the service layer
    // POSTs). Renders inside the confirmation dialog and a collapsible
    // "API details" panel below the form.
    const requestBodyPreview = React.useMemo(() => {
        const body = { offerType };
        if (displayNameTrimmed)
            body.displayName = displayNameTrimmed;
        if (owners.length > 0) {
            body.owners = owners.map((o) => ({ objectId: o }));
        }
        return JSON.stringify(body, null, 2);
    }, [offerType, displayNameTrimmed, owners]);
    // Last few session entries for the timeline strip — keep it tight so
    // it doesn't take over the page; the full list is in the ExportMenu.
    const recentEntries = sessionHistory.slice(-5).reverse();
    // React to global tenant-switch events from the app header. When the
    // operator switches tenants for an account that's in our eligible
    // candidates list, mirror the selection into the source-account
    // picker (and STORAGE_ACCOUNT) so subsequent ARM calls re-mint with
    // the right home identity.
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!candidates.some((c) => c.homeAccountId === candidate))
            return;
        if (accountId === candidate)
            return;
        setAccountId(candidate);
    });
    /* ----- Render --------------------------------------------------- */
    if (candidates.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4" },
            React.createElement(PageHeader, { title: "Create EA Sub (legacy API)", description: "Provision a new EA subscription using the 2018-03-01-preview createSubscription endpoint." }),
            React.createElement(EmptyState, { icon: Crown, title: "No Azure account signed in", description: "Sign in with an account that holds Owner on at least one EA enrollment account." })));
    }
    return (React.createElement("div", { className: "flex flex-col gap-4 py-2" },
        React.createElement(PageHeader, { title: "Create EA Sub (legacy API)", description: "Uses the legacy 2018-03-01-preview Subscription endpoint \u2014 POST /providers/Microsoft.Billing/enrollmentAccounts/{id}/providers/Microsoft.Subscription/createSubscription. Requires Owner on the enrollment account." },
            React.createElement("div", { className: "flex flex-wrap items-center gap-2", role: "group", "aria-label": "Session summary" },
                React.createElement(Badge, { variant: "warning", className: "gap-1 text-2xs" },
                    React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true }),
                    " Deprecated API"),
                React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                        loginHint: account === null || account === void 0 ? void 0 : account.username,
                    }) }),
                React.createElement(SummaryStatItem, { label: "Created", value: successCount, tone: successCount > 0 ? "success" : "muted", compact: true, ariaLabel: `Created this session: ${successCount}` }),
                failureCount > 0 && (React.createElement(SummaryStatItem, { label: "Failed", value: failureCount, tone: "destructive", compact: true, ariaLabel: `Failed this session: ${failureCount}` })),
                React.createElement(ExportMenu, { rows: sessionHistory, columns: [
                        { header: "Timestamp", accessor: (r) => r.timestamp },
                        { header: "Display name", accessor: (r) => r.displayName },
                        { header: "Offer type", accessor: (r) => r.offerType },
                        {
                            header: "Enrollment account",
                            accessor: (r) => r.enrollmentAccountId,
                        },
                        {
                            header: "Subscription id",
                            accessor: (r) => { var _a; return (_a = r.subscriptionId) !== null && _a !== void 0 ? _a : ""; },
                        },
                        { header: "HTTP status", accessor: (r) => r.httpStatus },
                        { header: "Owner count", accessor: (r) => r.ownerCount },
                        { header: "Outcome", accessor: (r) => r.outcome },
                        { header: "Error", accessor: (r) => { var _a; return (_a = r.error) !== null && _a !== void 0 ? _a : ""; } },
                    ], filename: "legacy-ea-subs-session", disabled: sessionHistory.length === 0, jsonMetadata: { source: "legacy-ea-sub-creator-page" } }),
                sessionHistory.length > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearHistory, "aria-label": "Clear session history", className: "text-2xs" },
                    React.createElement(Trash2, { className: "h-3.5 w-3.5" }),
                    " Clear history")))),
        React.createElement(Alert, { variant: "warning", role: "region", "aria-label": "API deprecation notice" },
            React.createElement(AlertTriangle, { className: "h-3.5 w-3.5", "aria-hidden": true }),
            React.createElement(AlertDescription, { className: "flex flex-col gap-2 text-2xs" },
                React.createElement("span", null,
                    React.createElement("strong", null, "Deprecated path."),
                    " The 2018-03-01-preview createSubscription endpoint is frozen and returns",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "Commerce Account Is Null"),
                    " ",
                    "on most EA enrollments registered after 2022. Prefer the modern",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "/providers/Microsoft.Subscription/aliases"),
                    " ",
                    "API \u2014 it supports the same enrollment-account billing scope plus cross-tenant ownership, dev/test, workload flags, and an alias name you can reference programmatically."),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", onClick: jumpToModernPage, "aria-label": "Open the modern EA Sub Quick page (alias API) and carry over the current draft", title: "Carries your current display name, workload (Production/DevTest), and first owner. Hotkey: Ctrl+M / Cmd+M." },
                        React.createElement(BadgeCheck, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        " Open EA Sub Quick (modern)",
                        React.createElement("span", { className: "ml-1 rounded border border-current/30 bg-background/40 px-1 text-[10px] opacity-80", "aria-hidden": true }, "Ctrl+M")),
                    React.createElement(InfoTooltip, { ariaLabel: "Difference between legacy and modern alias API", content: React.createElement("span", { className: "text-xs" },
                            React.createElement("strong", null, "Legacy"),
                            " (this page) \u2014 POST to",
                            " ",
                            React.createElement("code", null, "/enrollmentAccounts/.../createSubscription"),
                            ", Owner-on-enrollment, no cross-tenant landing, 5,000-sub cap.",
                            React.createElement("br", null),
                            React.createElement("strong", null, "Modern"),
                            " \u2014 PUT to",
                            " ",
                            React.createElement("code", null, "/aliases/{name}"),
                            ", supports cross-tenant ownership, dev/test, workload flags, and is the recommended path going forward.") }),
                    React.createElement("label", { className: "ml-auto flex cursor-pointer items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-2xs" },
                        React.createElement(Checkbox, { checked: deprecationAck, onCheckedChange: (v) => setDeprecationAck(v === true), "aria-label": "Acknowledge deprecation" }),
                        React.createElement("span", { className: "select-none" },
                            "I understand this API is deprecated and may return",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "Commerce Account Is Null"),
                            "."))))),
        React.createElement(Alert, null,
            React.createElement(Info, { className: "h-3.5 w-3.5" }),
            React.createElement(AlertDescription, { className: "text-2xs" },
                React.createElement("strong", null, "This is the LEGACY preview API."),
                " Use this page only when an automation specifically targets the 2018-03-01-preview endpoint shape. Limit:",
                " ",
                React.createElement("strong", null, EA_SUBSCRIPTION_CAP.toLocaleString()),
                " ",
                "subscriptions per enrollment account \u2014 canceled, deleted and transferred subs all count toward the cap, and ARM will not increase it on this path.")),
        React.createElement(Alert, { variant: "warning", role: "region", "aria-label": "Recommended pages" },
            React.createElement(ArrowRight, { className: "h-3.5 w-3.5" }),
            React.createElement(AlertDescription, { className: "flex flex-wrap items-center gap-2 text-2xs" },
                React.createElement("span", null,
                    React.createElement("strong", null, "Use a modern flow instead?"),
                    " For new work the",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "/ea-sub-quick"),
                    " page wraps the alias API and is what should be used for new automations.",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "/ea-subscription"),
                    " gives the full alias-API form (cross-tenant owners, workload flag, etc.). This page exists only for runbooks pinned to the legacy 2018-03-01-preview shape."),
                React.createElement("span", { className: "ml-auto flex flex-wrap gap-1" },
                    React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: () => navigateToPage("/ea-sub-quick"), "aria-label": "Open EA Sub Quick" },
                        React.createElement(Sparkles, { className: "h-3 w-3" }),
                        " EA Sub Quick"),
                    React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: () => navigateToPage("/ea-subscription"), "aria-label": "Open EA Subscription (full alias form)" },
                        React.createElement(BadgeCheck, { className: "h-3 w-3" }),
                        " EA Subscription")))),
        operatorAnomaly.anomalous && (React.createElement(Alert, { variant: "warning", role: "alert", "aria-live": "assertive", "aria-label": "Operator pattern anomaly" },
            React.createElement(Shield, { className: "h-3.5 w-3.5", "aria-hidden": true }),
            React.createElement(AlertDescription, { className: "flex flex-col gap-1.5 text-2xs" },
                React.createElement("span", null,
                    React.createElement("strong", null, "Operator pattern anomaly."),
                    " This page wraps a deprecated API; in-session usage pattern is worth reviewing before continuing."),
                React.createElement("ul", { className: "ml-4 list-disc" }, operatorAnomaly.reasons.map((r, i) => (React.createElement("li", { key: i }, r)))),
                React.createElement("span", { className: "opacity-80" },
                    "Reference:",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "_ea_subscription_cross_tenant.md"),
                    " ",
                    "\u2014 newer EA enrollments lack a commerce-account record under the legacy 2018-03-01-preview namespace, so repeated legacy use is either pinned-runbook automation or a defender-visible signal worth a second look."),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2 pt-1" },
                    React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", onClick: jumpToModernPage, "aria-label": "Switch to the modern EA Sub Quick flow" },
                        React.createElement(Zap, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        " Switch to modern flow now"),
                    React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs text-muted-foreground", "aria-hidden": true },
                        React.createElement(Keyboard, { className: "h-3 w-3" }),
                        " Ctrl+M"),
                    React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" }, "Logged to audit trail."))))),
        isDraftMeaningful(draftOnMountRef.current) && !draftBannerDismissed && (React.createElement(Alert, null,
            React.createElement(Save, { className: "h-3.5 w-3.5" }),
            React.createElement(AlertDescription, { className: "flex flex-wrap items-center gap-2 text-2xs" },
                React.createElement("span", null,
                    React.createElement("strong", null, "Draft restored."),
                    " Display name / offer / owners were carried over from your last session",
                    draftOnMountRef.current.updatedAt
                        ? ` (saved ${timeAgo(draftOnMountRef.current.updatedAt)})`
                        : "",
                    "."),
                React.createElement("div", { className: "ml-auto flex gap-1" },
                    React.createElement(Button, { type: "button", size: "sm", variant: "ghost", className: "h-7 text-2xs", onClick: () => setDraftBannerDismissed(true), "aria-label": "Keep restored draft and dismiss banner" }, "Keep"),
                    React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: discardDraft, "aria-label": "Discard restored draft" },
                        React.createElement(Eraser, { className: "h-3 w-3" }),
                        " Discard draft"))))),
        React.createElement(Card, null,
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Building2, { className: "h-4 w-4 text-primary" }),
                    "Enrollment account"),
                React.createElement(CardDescription, null,
                    "Pick the signed-in account and the enrollment account that will own the new subscription. The list comes from",
                    " ",
                    React.createElement("code", { className: "font-mono text-2xs" }, "GET /providers/Microsoft.Billing/enrollmentAccounts"),
                    " ",
                    "(api-version 2018-03-01-preview) \u2014 only accounts you hold Owner on appear.")),
            React.createElement(CardContent, { className: "grid grid-cols-1 gap-3 sm:grid-cols-2" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { className: "text-xs" }, "Source account"),
                    React.createElement(Select, { value: accountId, onValueChange: setAccountId },
                        React.createElement(SelectTrigger, null,
                            React.createElement(SelectValue, { placeholder: "Pick an account" })),
                        React.createElement(SelectContent, null, candidates.map((c) => (React.createElement(SelectItem, { key: c.homeAccountId, value: c.homeAccountId },
                            React.createElement("span", { className: "flex flex-col" },
                                React.createElement("span", { className: "text-sm" }, c.name),
                                React.createElement("span", { className: "text-2xs text-muted-foreground" }, c.username))))))),
                    account && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                        "Active tenant:",
                        " ",
                        React.createElement("code", { className: "font-mono" }, account.tenantId)))),
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement("div", { className: "flex items-center justify-between gap-2" },
                        React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                            "Enrollment account",
                            React.createElement(InfoTooltip, { ariaLabel: "What is a commerce account / enrollment account", content: React.createElement("span", { className: "text-xs" },
                                    "The ",
                                    React.createElement("strong", null, "enrollment account"),
                                    " is the EA billing scope that owns the new subscription's charges. Internally ARM keys this off a",
                                    " ",
                                    React.createElement("strong", null, "commerce account"),
                                    " record \u2014 new EA enrollments registered after 2022 may not have one under the legacy namespace, which is why the modern alias API is preferred.") })),
                        React.createElement("div", { className: "flex items-center gap-1" },
                            !manualMode && !eaLoading && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs", onClick: () => setListSeq((n) => n + 1), "aria-label": "Refresh enrollment-account listing", title: "Refresh listing" },
                                React.createElement(RefreshCw, { className: "h-3 w-3" }),
                                " Refresh")),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 text-2xs", onClick: () => {
                                    setManualMode((v) => !v);
                                    setEaError(null);
                                }, "aria-label": manualMode
                                    ? "Switch back to listing enrollment accounts"
                                    : "Enter enrollment-account GUID manually" }, manualMode ? "Use the listing instead" : "Enter ID manually"))),
                    manualMode ? (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "relative" },
                            React.createElement(Input, { value: manualInput, onChange: (e) => setManualInput(e.target.value), placeholder: "Enrollment-account object id (UUID) or ARM path", className: "font-mono text-xs pr-9", "aria-invalid": manualInput.length > 0 && !manualGuidValid
                                    ? true
                                    : undefined, "aria-describedby": "manual-guid-hint" }),
                            manualInput.length > 0 && (React.createElement("span", { className: "pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" }, manualGuidValid ? (React.createElement(CheckCircle2, { className: "h-4 w-4 text-success", "aria-label": "Valid GUID" })) : (React.createElement(XCircle, { className: "h-4 w-4 text-destructive", "aria-label": "Not a valid GUID" }))))),
                        manualInput.length > 0 &&
                            manualGuidValid &&
                            manualGuidExtracted !== manualInput.trim() && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            "Will use",
                            " ",
                            React.createElement("code", { className: "font-mono" }, manualGuidExtracted),
                            " ",
                            "(extracted from the pasted path).")),
                        React.createElement("p", { id: "manual-guid-hint", className: "text-2xs text-muted-foreground" },
                            "Find this GUID in",
                            " ",
                            React.createElement("a", { href: "https://ea.azure.com", target: "_blank", rel: "noopener noreferrer", className: "text-primary underline-offset-2 hover:underline" }, "ea.azure.com"),
                            " ",
                            "\u2192 Account \u2192 Manage. It's also the value the listing endpoint returns as",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "name"),
                            ". You can paste a full ARM path like",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "/providers/Microsoft.Billing/enrollmentAccounts/<guid>"),
                            " ",
                            "and we'll extract the GUID for you."))) : eaLoading ? (React.createElement("p", { className: "flex items-center gap-2 text-xs text-muted-foreground", "aria-live": "polite" },
                        React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                        "Loading enrollment accounts\u2026")) : eaError ? (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-1 text-2xs" },
                            React.createElement("span", null,
                                React.createElement("strong", null, "Couldn't list enrollment accounts."),
                                " ",
                                /Failed to fetch|networkerror|load failed/i.test(eaError) ? (React.createElement(React.Fragment, null,
                                    "The browser refused the request \u2014 usually a CORS block on the preview ARM path, a corporate proxy, or an ad-blocker / extension. Switch to",
                                    " ",
                                    React.createElement("strong", null, "Enter ID manually"),
                                    " above and paste the enrollment-account GUID. The actual create call may still succeed.")) : (React.createElement(React.Fragment, null,
                                    "ARM rejected the listing call. You can still proceed by pasting the GUID manually if you know it (",
                                    React.createElement("strong", null, "Enter ID manually"),
                                    " above), or click Refresh to retry."))),
                            React.createElement("span", { className: "break-all opacity-80" },
                                "Raw error: ",
                                eaError),
                            React.createElement("div", { className: "mt-1 flex gap-2" },
                                React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: () => setListSeq((n) => n + 1) },
                                    React.createElement(RefreshCw, { className: "h-3 w-3" }),
                                    " Retry"),
                                React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: () => {
                                        setManualMode(true);
                                        setEaError(null);
                                    } }, "Enter ID manually"))))) : eas.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" },
                        "No enrollment accounts visible to this account. The signed-in user must be an Owner on an enrollment account (Account Owner from the EA portal). Or click",
                        " ",
                        React.createElement("strong", null, "Enter ID manually"),
                        " above to paste a GUID.")) : (React.createElement(React.Fragment, null,
                        React.createElement(Select, { value: enrollmentAccountId, onValueChange: setEnrollmentAccountId },
                            React.createElement(SelectTrigger, null,
                                React.createElement(SelectValue, { placeholder: "Pick an enrollment account" })),
                            React.createElement(SelectContent, null, eas.map((e) => (React.createElement(SelectItem, { key: e.name, value: e.name },
                                React.createElement("span", { className: "flex flex-col" },
                                    React.createElement("span", { className: "font-mono text-2xs" }, e.name),
                                    e.principalName && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                        "owner: ",
                                        e.principalName)))))))),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            eas.length === 1
                                ? "1 enrollment account visible"
                                : `${eas.length} enrollment accounts visible`,
                            " — ",
                            "each capped at",
                            " ",
                            React.createElement("strong", null, EA_SUBSCRIPTION_CAP.toLocaleString()),
                            " ",
                            "subs on this API.")))))),
        !selectedEa ? (React.createElement(EmptyState, { icon: BadgeCheck, title: "Pick an enrollment account", description: "The new subscription's billing is attached to whichever enrollment account you pick." })) : (React.createElement(React.Fragment, null,
            React.createElement(Card, null,
                React.createElement(CardHeader, { className: "pb-3" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(Plus, { className: "h-4 w-4 text-primary" }),
                        "New subscription"),
                    React.createElement(CardDescription, null,
                        "The new subscription lands in the home tenant of the enrollment account's Account Owner (",
                        React.createElement("code", { className: "font-mono" }, (_b = selectedEa.principalName) !== null && _b !== void 0 ? _b : "unknown"),
                        "). Cross-tenant landing isn't supported by this API \u2014 use the modern Create EA Sub page if you need that.")),
                React.createElement(CardContent, { className: "flex flex-col gap-3" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-2 py-1.5 text-2xs" },
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Target EA"),
                        React.createElement(CopyableText, { value: selectedEa.name, mono: true, alwaysVisibleButton: true, ariaLabel: "Copy enrollment-account GUID" }),
                        selectedEa.principalName && (React.createElement(React.Fragment, null,
                            React.createElement("span", { className: "text-muted-foreground" }, "\u00B7"),
                            React.createElement("span", { className: "text-muted-foreground" },
                                "owner:",
                                " ",
                                React.createElement("code", { className: "font-mono" }, selectedEa.principalName))))),
                    React.createElement("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-2" },
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { className: "flex items-center justify-between gap-1 text-xs" },
                                React.createElement("span", null,
                                    "Display name",
                                    " ",
                                    React.createElement("span", { className: "text-destructive" }, "*"),
                                    React.createElement(InfoTooltip, { ariaLabel: "What ARM does with the display name", className: "ml-1", content: React.createElement("span", { className: "text-xs" },
                                            "Free-form label shown in the portal's Subscriptions blade. Can be renamed later. Max",
                                            " ",
                                            DISPLAY_NAME_MAX,
                                            " characters. ARM does NOT enforce uniqueness across an enrollment.") })),
                                React.createElement(Button, { type: "button", variant: "ghost", size: "xs", className: "text-2xs", onClick: () => setDisplayName(suggestDisplayName()), "aria-label": "Auto-fill a timestamp-suffixed display name" },
                                    React.createElement(Sparkles, { className: "h-3 w-3" }),
                                    " Auto")),
                            React.createElement(Input, { value: displayName, onChange: (e) => setDisplayName(e.target.value), placeholder: "Dev Team Subscription", className: "text-xs", maxLength: DISPLAY_NAME_MAX + 16 /* let user see overflow then truncate via validation */, "aria-invalid": displayNameTooLong ||
                                    (displayName.length > 0 && displayNameEmpty)
                                    ? true
                                    : undefined, "aria-describedby": "display-name-help" }),
                            React.createElement("p", { id: "display-name-help", className: displayNameTooLong
                                    ? "text-2xs text-destructive"
                                    : "text-2xs text-muted-foreground" }, displayNameTooLong
                                ? `Too long — ${displayNameTrimmed.length} of ${DISPLAY_NAME_MAX} max characters.`
                                : `${displayNameTrimmed.length} / ${DISPLAY_NAME_MAX} characters`)),
                        React.createElement("div", { className: "flex flex-col gap-1.5" },
                            React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                                "Offer type",
                                " ",
                                React.createElement("span", { className: "text-destructive" }, "*"),
                                React.createElement(InfoTooltip, { ariaLabel: "Difference between EA offer types", content: React.createElement("span", { className: "text-xs" },
                                        React.createElement("strong", null, "MS-AZR-0017P"),
                                        " \u2014 standard EA production pricing.",
                                        React.createElement("br", null),
                                        React.createElement("strong", null, "MS-AZR-0148P"),
                                        " \u2014 EA dev/test pricing (must be enabled in the EA portal first; if not, ARM returns \"offer is not enabled\" on submit).") })),
                            React.createElement(Select, { value: offerType, onValueChange: (v) => setOfferType(v) },
                                React.createElement(SelectTrigger, { "aria-label": "Offer type" },
                                    React.createElement(SelectValue, { placeholder: "Select offer type" })),
                                React.createElement(SelectContent, null,
                                    React.createElement(SelectItem, { value: "MS-AZR-0017P" },
                                        React.createElement("span", { className: "flex flex-col" },
                                            React.createElement("span", { className: "text-sm" }, "MS-AZR-0017P \u2014 Production"),
                                            React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Regular Microsoft Enterprise Agreement."))),
                                    React.createElement(SelectItem, { value: "MS-AZR-0148P" },
                                        React.createElement("span", { className: "flex flex-col" },
                                            React.createElement("span", { className: "text-sm" }, "MS-AZR-0148P \u2014 Dev/Test"),
                                            React.createElement("span", { className: "text-2xs text-muted-foreground" }, "EA dev/test pricing; must be enabled in the EA portal first."))))))),
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { className: "flex items-center gap-1 text-xs" },
                            "Owners (optional \u2014 AAD object ids)",
                            React.createElement(InfoTooltip, { ariaLabel: "What ARM does with owners", content: React.createElement("span", { className: "text-xs" },
                                    "Each entry is granted Azure RBAC",
                                    " ",
                                    React.createElement("strong", null, "Owner"),
                                    " on the new subscription as part of the create call. Without any entries, only the EA Account Owner is granted access; you can add more via the Subscription's IAM blade later.") })),
                        React.createElement("div", { className: "flex items-stretch gap-2" },
                            React.createElement(Input, { value: ownerInput, onChange: (e) => setOwnerInput(e.target.value), onKeyDown: (e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        addOwner();
                                    }
                                }, placeholder: "11111111-2222-3333-4444-555555555555", className: "font-mono text-xs", "aria-invalid": !ownersValid ? true : undefined }),
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: addOwner, disabled: !UUID_RE.test(ownerInput.trim()) },
                                React.createElement(Plus, { className: "h-3.5 w-3.5" }),
                                " Add")),
                        owners.length > 0 && (React.createElement(React.Fragment, null,
                            React.createElement("ul", { className: "mt-1 flex flex-wrap gap-1" }, owners.map((o) => (React.createElement("li", { key: o, className: "group/copy inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono text-2xs" },
                                React.createElement(User, { className: "h-3 w-3 text-muted-foreground" }),
                                React.createElement("span", { title: o },
                                    o.slice(0, 8),
                                    "\u2026"),
                                React.createElement(CopyButton, { value: o, ariaLabel: `Copy owner ${o}` }),
                                React.createElement(Button, { type: "button", variant: "ghost", size: "icon-xs", className: "ml-1 h-4 w-4", onClick: () => removeOwner(o), "aria-label": `Remove owner ${o}` },
                                    React.createElement(Trash2, { className: "h-3 w-3" })))))),
                            React.createElement("div", null,
                                React.createElement(Button, { type: "button", variant: "ghost", size: "xs", className: "text-2xs", onClick: clearOwners, "aria-label": "Clear all owners" },
                                    React.createElement(Trash2, { className: "h-3 w-3" }),
                                    " Clear all")))),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            "Object ids come from",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "az ad user show"),
                            " ",
                            "or AAD's Users blade.")),
                    submitError && errorClass.deprecated && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-2" },
                            React.createElement("span", null,
                                React.createElement("strong", null, "\"Commerce Account Is Null\" \u2014 the legacy 2018-03-01-preview API is deprecated for your enrollment."),
                                " ",
                                "Newer EA enrollments don't register a commerce account under the legacy namespace, so this endpoint can't service them. Microsoft moved every EA subscription creation onto the modern",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "/providers/Microsoft.Subscription/aliases"),
                                " ",
                                "API."),
                            React.createElement("span", { className: "text-2xs" },
                                "The ",
                                React.createElement("strong", null, "Create EA Sub Quick"),
                                " page in this WebUI already wraps that modern API and supports the same enrollment-account billing scope (plus cross-tenant ownership, dev/test flags, etc.)."),
                            autoPivotSec !== null && (React.createElement("span", { className: "rounded-md border border-warning/40 bg-warning/15 px-2 py-1 text-2xs text-warning-foreground", role: "status", "aria-live": "polite", "aria-atomic": "true" },
                                "Auto-pivoting to EA Sub Quick in",
                                " ",
                                React.createElement("strong", null,
                                    autoPivotSec,
                                    "s"),
                                "\u2026 Press",
                                React.createElement("em", null, " Stay here"),
                                " to keep this page open (e.g. to copy the raw error for a support ticket).")),
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement(Button, { type: "button", size: "sm", variant: "default", className: "h-7 text-2xs", onClick: () => {
                                        cancelAutoPivot();
                                        jumpToModernPage();
                                    } },
                                    React.createElement(BadgeCheck, { className: "h-3.5 w-3.5" }),
                                    " Go to EA Sub Quick now"),
                                autoPivotSec !== null && (React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: cancelAutoPivot }, "Stay here"))),
                            React.createElement("span", { className: "break-all text-[10px] opacity-80" },
                                "Raw error: ",
                                submitError)))),
                    submitError &&
                        errorClass.invalidOffer &&
                        !errorClass.deprecated && (React.createElement(Alert, { variant: "warning" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-1 text-2xs" },
                            React.createElement("span", null,
                                React.createElement("strong", null,
                                    "Offer \"",
                                    offerType,
                                    "\" isn't enabled on this enrollment."),
                                " ",
                                "For",
                                " ",
                                React.createElement("code", { className: "font-mono" }, "MS-AZR-0148P"),
                                " ",
                                "this usually means the EA admin hasn't accepted the Dev/Test addendum at",
                                " ",
                                React.createElement("a", { href: "https://ea.azure.com", target: "_blank", rel: "noopener noreferrer", className: "font-medium text-primary underline-offset-2 hover:underline" }, "ea.azure.com"),
                                "."),
                            React.createElement("span", { className: "break-all opacity-80" },
                                "Raw error: ",
                                submitError)))),
                    submitError &&
                        errorClass.expired &&
                        !errorClass.deprecated && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-1 text-2xs" },
                            React.createElement("span", null,
                                React.createElement("strong", null, "Enrollment is expired or inactive."),
                                " ",
                                "ARM won't accept new subscriptions on a terminated EA enrollment. Renew the enrollment in the EA portal, or pick a different enrollment account."),
                            React.createElement("span", { className: "break-all opacity-80" },
                                "Raw error: ",
                                submitError)))),
                    submitError &&
                        errorClass.forbidden &&
                        !errorClass.deprecated &&
                        !errorClass.invalidOffer &&
                        !errorClass.expired && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-1 text-2xs" },
                            React.createElement("span", null,
                                React.createElement("strong", null, "403 Forbidden \u2014 caller isn't Owner on this enrollment."),
                                " ",
                                "The legacy API requires Owner-on-enrollment, NOT the modern \"EA Subscription Creator\" billing role. Promote the signed-in user to Owner in the EA portal, or sign in with an Account-Owner identity."),
                            React.createElement("span", { className: "break-all opacity-80" },
                                "Raw error: ",
                                submitError)))),
                    submitError &&
                        errorClass.unauthorized &&
                        !errorClass.deprecated && (React.createElement(Alert, { variant: "warning" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-1 text-2xs" },
                            React.createElement("span", null,
                                React.createElement("strong", null, "401 Unauthorized \u2014 ARM token rejected."),
                                " ",
                                "The token may have expired between page load and submit. Click ",
                                React.createElement("strong", null, "Refresh token"),
                                " in the header badge and try again."),
                            React.createElement("div", null,
                                React.createElement(Button, { type: "button", size: "sm", variant: "outline", className: "h-7 text-2xs", onClick: () => void armTokenTracker.refresh() },
                                    React.createElement(RefreshCw, { className: "h-3 w-3" }),
                                    " Refresh token now")),
                            React.createElement("span", { className: "break-all opacity-80" },
                                "Raw error: ",
                                submitError)))),
                    submitError && errorClass.throttled && (React.createElement(Alert, { variant: "warning" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-1 text-2xs" },
                            React.createElement("span", null,
                                React.createElement("strong", null, "429 Throttled."),
                                " ARM is rate-limiting this enrollment. Wait 30-60 seconds and retry; if you're scripting bulk creates, space them at least a few seconds apart."),
                            React.createElement("span", { className: "break-all opacity-80" },
                                "Raw error: ",
                                submitError)))),
                    submitError &&
                        !errorClass.deprecated &&
                        !errorClass.invalidOffer &&
                        !errorClass.expired &&
                        !errorClass.forbidden &&
                        !errorClass.unauthorized &&
                        !errorClass.throttled && (React.createElement(Alert, { variant: "destructive" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, null, submitError))),
                    validationIssues.length > 0 && (React.createElement(Alert, { variant: validationIssues.some((i) => i.severity === "error")
                            ? "warning"
                            : "default", role: "status", "aria-live": "polite", "aria-label": "Pre-submit validation" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "flex flex-col gap-1 text-2xs" },
                            React.createElement("span", null,
                                React.createElement("strong", null, "Almost ready."),
                                " ",
                                validationIssues.length === 1
                                    ? "One thing left:"
                                    : `${validationIssues.length} things left:`),
                            React.createElement("ul", { className: "ml-4 list-disc", "aria-label": "Outstanding validation issues" }, validationIssues.map((i) => (React.createElement("li", { key: i.id, className: i.severity === "error"
                                    ? "text-destructive"
                                    : "text-muted-foreground" }, i.text))))))),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Button, { type: "button", variant: "default", onClick: () => setConfirmOpen(true), disabled: !canSubmit, loading: submitting, "aria-label": "Create EA subscription", "aria-disabled": !canSubmit, title: submitBlockedReason || undefined },
                            !submitting && React.createElement(CheckCircle2, null),
                            submitting ? "Creating…" : "Create subscription"),
                        !canSubmit && !submitting && submitBlockedReason && (React.createElement("span", { className: "text-2xs text-muted-foreground", "aria-live": "polite" }, submitBlockedReason)),
                        (displayNameTrimmed.length > 0 || owners.length > 0) && (React.createElement("span", { className: "ml-auto inline-flex items-center gap-1 text-2xs text-muted-foreground", "aria-label": "Draft is saved locally", title: "Form contents are saved in this browser and will be restored after a reload." },
                            React.createElement(Save, { className: "h-3 w-3", "aria-hidden": true }),
                            " draft saved"))))),
            React.createElement("details", { className: "group rounded-lg border border-dashed border-border bg-card/50" },
                React.createElement("summary", { className: "flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground" },
                    React.createElement(Terminal, { className: "h-3.5 w-3.5" }),
                    React.createElement("span", { className: "font-medium" }, "API request preview"),
                    React.createElement("span", { className: "text-2xs opacity-70" },
                        "\u2014 JSON body + equivalent ",
                        React.createElement("code", null, "az rest"),
                        " command")),
                React.createElement("div", { className: "flex flex-col gap-3 border-t border-border/60 p-3" },
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "POST URL"),
                        React.createElement("div", { className: "group/copy flex items-start gap-2 rounded-md bg-muted/40 p-2" },
                            React.createElement("code", { className: "flex-1 break-all font-mono text-2xs" },
                                "https://management.azure.com/providers/Microsoft.Billing/enrollmentAccounts/",
                                selectedEa.name,
                                "/providers/Microsoft.Subscription/createSubscription?api-version=2018-03-01-preview"),
                            React.createElement(CopyButton, { value: `https://management.azure.com/providers/Microsoft.Billing/enrollmentAccounts/${selectedEa.name}/providers/Microsoft.Subscription/createSubscription?api-version=2018-03-01-preview`, alwaysVisible: true, ariaLabel: "Copy POST URL" }))),
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Request body"),
                        React.createElement("div", { className: "group/copy relative" },
                            React.createElement("pre", { className: "max-h-48 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs" }, requestBodyPreview),
                            React.createElement("span", { className: "absolute right-1 top-1" },
                                React.createElement(CopyButton, { value: requestBodyPreview, alwaysVisible: true, ariaLabel: "Copy request body JSON" })))),
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Equivalent shell command"),
                        React.createElement("div", { className: "group/copy relative" },
                            React.createElement("pre", { className: "max-h-32 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs" }, azCommandPreview),
                            React.createElement("span", { className: "absolute right-1 top-1" },
                                React.createElement(CopyButton, { value: azCommandPreview, alwaysVisible: true, ariaLabel: "Copy az rest command" }))),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            "Single line so it pastes cleanly into PowerShell or bash. Requires",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "az login"),
                            " with an identity that has Owner on the enrollment account.")),
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(Label, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Raw cURL (no az CLI required)"),
                        React.createElement("div", { className: "group/copy relative" },
                            React.createElement("pre", { className: "max-h-32 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs" }, curlCommandPreview),
                            React.createElement("span", { className: "absolute right-1 top-1" },
                                React.createElement(CopyButton, { value: curlCommandPreview, alwaysVisible: true, ariaLabel: "Copy raw cURL command" }))),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            "Token placeholder rendered as",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "$ARM_TOKEN"),
                            " \u2014 substitute a live bearer at runtime (e.g.",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "ARM_TOKEN=$(az account get-access-token --query accessToken -o tsv)"),
                            "). Matches the replay-capture pattern described in the cross-tenant playbook.")))),
            React.createElement(ConfirmationDialog, { hidden: !confirmOpen, title: "Create legacy EA subscription?", danger: true, confirmText: "Create subscription", cancelText: "Cancel", loading: submitting, onCancel: () => {
                    if (!submitting)
                        setConfirmOpen(false);
                }, onConfirm: () => __awaiter(void 0, void 0, void 0, function* () {
                    yield submit();
                    setConfirmOpen(false);
                }), message: React.createElement("div", { className: "flex flex-col gap-2 text-sm" },
                    React.createElement(Alert, { variant: "warning", className: "border-warning/40" },
                        React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
                        React.createElement(AlertDescription, { className: "text-2xs" },
                            "This will POST to the ",
                            React.createElement("strong", null, "deprecated"),
                            " ",
                            "2018-03-01-preview createSubscription endpoint and charge the enrollment-account billing scope going forward. If you don't have an automation requirement pinned to this exact API shape, prefer the modern alias API instead.")),
                    React.createElement("ul", { className: "ml-4 list-disc text-xs text-muted-foreground" },
                        React.createElement("li", null,
                            "Display name:",
                            " ",
                            React.createElement("strong", null, displayNameTrimmed || "—")),
                        React.createElement("li", null,
                            "Offer type:",
                            " ",
                            React.createElement("code", { className: "font-mono" }, offerType)),
                        React.createElement("li", null,
                            "Enrollment account:",
                            " ",
                            React.createElement("code", { className: "font-mono" }, selectedEa.name)),
                        React.createElement("li", null,
                            "Owners: ",
                            owners.length)),
                    React.createElement("details", { className: "rounded-md border border-border/60 bg-muted/30" },
                        React.createElement("summary", { className: "cursor-pointer px-2 py-1 text-2xs text-muted-foreground hover:text-foreground" }, "Show JSON request body"),
                        React.createElement("pre", { className: "max-h-40 overflow-auto px-2 py-1 font-mono text-2xs" }, requestBodyPreview)),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        "Subscriptions count toward the",
                        " ",
                        EA_SUBSCRIPTION_CAP.toLocaleString(),
                        "-per-enrollment cap even after they are canceled or transferred.")) }),
            result && (React.createElement(Card, { className: "border-success/30 bg-success/5" },
                React.createElement(CardHeader, { className: "pb-2" },
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(Check, { className: "h-4 w-4 text-success" }),
                        " Done"),
                    React.createElement(CardDescription, { className: "text-2xs" },
                        "ARM returned HTTP ",
                        result.status,
                        ". Use the link below in any portal / CLI to start using the subscription.")),
                React.createElement(CardContent, { className: "flex flex-col gap-2 text-xs" },
                    result.subscriptionId && (React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Badge, { variant: "success", className: "text-2xs" }, "Subscription"),
                        React.createElement(CopyableText, { value: result.subscriptionId, mono: true, alwaysVisibleButton: true, ariaLabel: "Copy subscription id" }))),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Enrollment account"),
                        React.createElement(CopyableText, { value: selectedEa.name, mono: true, alwaysVisibleButton: true, ariaLabel: "Copy enrollment-account object id" })),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Display name"),
                        React.createElement(CopyableText, { value: displayNameTrimmed, alwaysVisibleButton: true, ariaLabel: "Copy display name" })),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "Offer type"),
                        React.createElement(CopyableText, { value: offerType, mono: true, alwaysVisibleButton: true, ariaLabel: "Copy offer type" })),
                    result.subscriptionLink && (React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" }, "ARM link"),
                        React.createElement(CopyableText, { value: result.subscriptionLink, mono: true, alwaysVisibleButton: true, ariaLabel: "Copy ARM subscription link" }),
                        result.subscriptionId && (React.createElement("a", { href: `https://portal.azure.com/#@/resource/subscriptions/${result.subscriptionId}`, target: "_blank", rel: "noopener noreferrer", className: "inline-flex items-center gap-1 rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Open subscription in Azure portal" },
                            React.createElement(ExternalLink, { className: "h-3 w-3" }),
                            " Open in portal")))),
                    React.createElement("div", { className: "mt-2 flex flex-wrap gap-2 border-t border-success/20 pt-2" },
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: resetForm, "aria-label": "Reset form to create another subscription" },
                            React.createElement(RotateCcw, { className: "h-3.5 w-3.5" }),
                            " Create another"),
                        result.subscriptionId && (
                        // Use the shared CopyButton (handles async-API +
                        // execCommand fallback + "Copied" pulse + cleanup
                        // timeout) so this page doesn't reinvent clipboard
                        // handling. The onCopied hook surfaces a toast for
                        // parity with the previous bespoke button.
                        React.createElement("span", { className: "inline-flex items-center gap-1 text-2xs", "aria-label": "Copy subscription id action" },
                            React.createElement(CopyButton, { value: result.subscriptionId, ariaLabel: "Copy subscription id to clipboard", alwaysVisible: true, iconSize: 14, onCopied: (v) => store.addNotification({
                                    type: "success",
                                    message: `Copied subscription id ${v}.`,
                                }) }),
                            "Copy ID")))))))),
        recentEntries.length > 0 && (React.createElement(Card, null,
            React.createElement(CardHeader, { className: "pb-2" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(History, { className: "h-4 w-4 text-primary" }),
                    "Recent submissions (",
                    sessionHistory.length,
                    ")",
                    operatorAnomaly.anomalous && (React.createElement(Badge, { variant: "warning", className: "ml-2 gap-1 text-2xs", title: "Operator-pattern anomaly detected \u2014 see banner above" },
                        React.createElement(Eye, { className: "h-3 w-3", "aria-hidden": true }),
                        " review"))),
                React.createElement(CardDescription, { className: "flex flex-col gap-1 text-2xs" },
                    React.createElement("span", null, "Session-scoped \u2014 full list survives navigation within this tab but is wiped by a full reload. Export above for a permanent record."),
                    React.createElement("span", { className: "text-muted-foreground" },
                        "Operator:",
                        " ",
                        React.createElement("code", { className: "font-mono" }, (_c = account === null || account === void 0 ? void 0 : account.username) !== null && _c !== void 0 ? _c : "(unknown)"),
                        " ",
                        "\u00B7 ",
                        successCount,
                        " succeeded, ",
                        failureCount,
                        " failed",
                        operatorAnomaly.cainAfterCount > 0 && (React.createElement(React.Fragment, null,
                            " · ",
                            React.createElement("span", { className: "text-warning" },
                                operatorAnomaly.cainAfterCount,
                                " after CAIN")))))),
            React.createElement(CardContent, { className: "flex flex-col gap-1.5" },
                recentEntries.map((e) => {
                    var _a;
                    return (
                    // Stable key: timestamp + display name + sub id (when
                    // present) — unique within a session even if two entries
                    // share the same timestamp at second resolution.
                    React.createElement("div", { key: `${e.timestamp}|${e.displayName}|${(_a = e.subscriptionId) !== null && _a !== void 0 ? _a : "x"}`, className: "flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2 py-1 text-2xs" },
                        React.createElement(StatusBadge, { status: e.outcome === "success" ? "success" : "error", label: e.outcome }),
                        React.createElement("span", { className: "font-medium", title: e.displayName }, e.displayName),
                        React.createElement("code", { className: "font-mono opacity-70" }, e.offerType),
                        React.createElement("span", { className: "text-muted-foreground" }, timeAgo(e.timestamp)),
                        e.subscriptionId && (React.createElement(CopyableText, { value: e.subscriptionId, mono: true, ariaLabel: `Copy subscription id ${e.subscriptionId}` })),
                        e.subscriptionId && (React.createElement("a", { href: `https://portal.azure.com/#@/resource/subscriptions/${e.subscriptionId}`, target: "_blank", rel: "noopener noreferrer", className: "inline-flex items-center gap-1 rounded text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": "Open in portal" },
                            React.createElement(ExternalLink, { className: "h-3 w-3" }))),
                        e.error && (React.createElement("span", { className: "break-all text-destructive opacity-90", title: e.error },
                            "error: ",
                            e.error.slice(0, 60),
                            e.error.length > 60 ? "…" : ""))));
                }),
                sessionHistory.length > recentEntries.length && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                    "Showing the last ",
                    recentEntries.length,
                    " of",
                    " ",
                    sessionHistory.length,
                    ". Use",
                    " ",
                    React.createElement("strong", null, "Export"),
                    " in the page header for the full list."))))),
        React.createElement(Card, { className: "border-dashed" },
            React.createElement(CardHeader, { className: "pb-2" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(Info, { className: "h-4 w-4 text-primary" }),
                    "Legacy vs modern API at a glance"),
                React.createElement(CardDescription, { className: "text-2xs" }, "Quick cheat-sheet for picking the right page next time.")),
            React.createElement(CardContent, { className: "overflow-auto" },
                React.createElement("table", { className: "w-full min-w-[480px] text-2xs" },
                    React.createElement("thead", null,
                        React.createElement("tr", { className: "border-b border-border/60 text-left text-muted-foreground" },
                            React.createElement("th", { className: "px-2 py-1 font-medium" }, "\u00A0"),
                            React.createElement("th", { className: "px-2 py-1 font-medium" }, "Legacy (this page)"),
                            React.createElement("th", { className: "px-2 py-1 font-medium" }, "Modern (EA Sub Quick)"))),
                    React.createElement("tbody", { className: "divide-y divide-border/60" },
                        React.createElement("tr", null,
                            React.createElement("td", { className: "px-2 py-1 font-medium" }, "API version"),
                            React.createElement("td", { className: "px-2 py-1 font-mono" }, "2018-03-01-preview"),
                            React.createElement("td", { className: "px-2 py-1 font-mono" }, "2021-10-01")),
                        React.createElement("tr", null,
                            React.createElement("td", { className: "px-2 py-1 font-medium" }, "HTTP shape"),
                            React.createElement("td", { className: "px-2 py-1 font-mono" }, "POST /enrollmentAccounts/{id}/createSubscription"),
                            React.createElement("td", { className: "px-2 py-1 font-mono" }, "PUT /aliases/{name}")),
                        React.createElement("tr", null,
                            React.createElement("td", { className: "px-2 py-1 font-medium" }, "Required role"),
                            React.createElement("td", { className: "px-2 py-1" }, "Owner on enrollment account"),
                            React.createElement("td", { className: "px-2 py-1" }, "EA Subscription Creator on billing scope")),
                        React.createElement("tr", null,
                            React.createElement("td", { className: "px-2 py-1 font-medium" }, "Cross-tenant landing"),
                            React.createElement("td", { className: "px-2 py-1" }, "Not supported"),
                            React.createElement("td", { className: "px-2 py-1" }, "Supported")),
                        React.createElement("tr", null,
                            React.createElement("td", { className: "px-2 py-1 font-medium" }, "Alias name"),
                            React.createElement("td", { className: "px-2 py-1" }, "N/A"),
                            React.createElement("td", { className: "px-2 py-1" }, "Required (user-chosen)")),
                        React.createElement("tr", null,
                            React.createElement("td", { className: "px-2 py-1 font-medium" }, "Workload flag (Production / DevTest)"),
                            React.createElement("td", { className: "px-2 py-1" }, "Implicit via offer type"),
                            React.createElement("td", { className: "px-2 py-1" }, "Explicit field")),
                        React.createElement("tr", null,
                            React.createElement("td", { className: "px-2 py-1 font-medium" }, "Per-EA cap"),
                            React.createElement("td", { className: "px-2 py-1" },
                                EA_SUBSCRIPTION_CAP.toLocaleString(),
                                " ",
                                "(counts canceled subs)"),
                            React.createElement("td", { className: "px-2 py-1" },
                                EA_SUBSCRIPTION_CAP.toLocaleString(),
                                " (same cap, alias reuse possible)")),
                        React.createElement("tr", null,
                            React.createElement("td", { className: "px-2 py-1 font-medium" }, "Status"),
                            React.createElement("td", { className: "px-2 py-1 text-warning" }, "Deprecated \u2014 frozen"),
                            React.createElement("td", { className: "px-2 py-1 text-success" }, "GA \u2014 recommended")))))),
        React.createElement(Card, { className: "border-dashed" },
            React.createElement(CardHeader, { className: "pb-2" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                    React.createElement(ArrowRight, { className: "h-4 w-4 text-primary" }),
                    "Related pages")),
            React.createElement(CardContent, { className: "flex flex-wrap gap-2" },
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => navigateToPage("/ea-subscription"), "aria-label": "Open Modern Create EA Sub (alias API)" },
                    React.createElement(BadgeCheck, { className: "h-3.5 w-3.5" }),
                    " Modern Create EA Sub (alias API)"),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => navigateToPage("/ea-sub-quick"), "aria-label": "Open EA Sub Quick" },
                    React.createElement(Sparkles, { className: "h-3.5 w-3.5" }),
                    " EA Sub Quick"),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => navigateToPage("/department-admin"), "aria-label": "Open Department Admin" },
                    React.createElement(Building2, { className: "h-3.5 w-3.5" }),
                    " Department Admin"),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => navigateToPage("/ea-billing-manager"), "aria-label": "Open EA Billing Manager" },
                    React.createElement(Crown, { className: "h-3.5 w-3.5" }),
                    " EA Billing Manager")))));
};
//# sourceMappingURL=legacy-ea-sub-creator-page.js.map