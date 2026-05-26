import { __awaiter } from "tslib";
/**
 * Partner Center page — checks whether a signed-in Azure account can
 * operate against Microsoft Partner Center as a Cloud Solution
 * Provider (CSP) partner and/or carries a Microsoft Partner Network
 * (MPN) profile, and manages the Partner Admin Link (PAL) used by
 * Microsoft to attribute Azure consumption back to a partner of
 * record.
 *
 * The page is read-mostly: four lightweight probes that the operator
 * fires on demand. The only mutating actions are linking / unlinking
 * a Partner ID via ARM's `Microsoft.ManagementPartner` resource type,
 * both gated behind an audited confirmation flow.
 *
 * UX choices worth calling out:
 *   - Probe runs are audited even on success — the operator's history
 *     should be reproducible (what did we check, when, against whom).
 *   - All errors are surfaced to the UI; no silent `.catch(() => {})`.
 *     A failed probe shows a banner with the AAD error code +
 *     remediation hint (sign in with a different identity, or pivot
 *     to Token Importer).
 *   - Keyboard shortcuts: `Mod+Enter` runs all probes, `Mod+L` focuses
 *     the Partner-ID input, `Mod+Shift+R` re-runs only the probes that
 *     previously failed (cheap retry after fixing tenant / consent).
 *   - Stale-write guard: switching accounts mid-flight cancels the
 *     write-back of in-flight results to the new account's slot.
 */
import * as React from "react";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, Handshake, Link2, Link2Off, Loader2, Network, Radar, RotateCcw, RotateCw, Search, ShieldAlert, ShieldCheck, Sparkles, StopCircle, Users, XCircle, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getActiveTenant, getArmTokenForAccount, getGraphTokenForAccount, getPartnerCenterTokenForAccount, } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { modKeyLabel, useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { auditLog } from "../../services/audit-log";
import { getPartnerAdminLink, linkPartnerAdmin, probeCspAccess, probeLegalBusinessProfile, probeMpnProfile, unlinkPartnerAdmin, } from "../../services/partner-center-service";
import { useMultiRegionState, useMultiRegionStore } from "../../store/store-context";
import { bulkProbeCustomers, probeGdapDelegations, probePalDrift, } from "./partner-relationships-probe";
import { useDashboardOutletContext } from "../page-router";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyableText, CopyButton } from "../shared/copy-button";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SignInRequired } from "../shared/sign-in-required";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
// COORDINATOR: `EmptyState` was imported but unused in the historical page;
// dropped to keep this file self-contained and lint-clean. Re-add if a
// future enhancement needs the shared empty layout.
const ACTIVE_ACCOUNT_KEY = "partner-center:active-account";
const PARTNER_ID_KEY = "partner-center:last-partner-id";
const PREFERRED_MPN_KEY = "partner-center:preferred-mpn";
const PARTNER_ID_RE = /^\d{6,10}$/;
/**
 * Probes whose `lastRunAt` is older than this are flagged as "stale". The
 * threshold (24h) mirrors CSP partner-of-record reconciliation cadence —
 * a probe answer older than a day is no longer trustworthy for billing
 * attribution decisions.
 */
const STALE_PROBE_MS = 24 * 60 * 60 * 1000;
/**
 * Longer "haven't even bothered to probe" threshold (60d). When the
 * operator's CSP customer matrix carries customers we haven't poked at
 * in two months, those rows are the most likely to harbour a dormant
 * MSP relationship that has drifted (cf. corpus playbook
 * `_bypass_tenant_switch.md` §6.3 — MSP supply-chain abuse is most
 * effective against dormant relationships because they generate no
 * alerts).
 */
const STALE_CUSTOMER_MS = 60 * 24 * 60 * 60 * 1000;
/** Session-storage key for the bulk-customer-probe last-run timestamps. */
const CUSTOMER_PROBE_KEY = "partner-center:customer-last-probe";
function loadCustomerLedger(key) {
    try {
        const raw = sessionStorage.getItem(key);
        if (!raw)
            return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            const out = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === "number" && Number.isFinite(v))
                    out[k] = v;
            }
            return out;
        }
    }
    catch (_a) {
        /* corrupt — ignore */
    }
    return {};
}
function saveCustomerLedger(key, ledger) {
    try {
        sessionStorage.setItem(key, JSON.stringify(ledger));
    }
    catch (_a) {
        /* ignore quota errors */
    }
}
/**
 * Truncate the middle of a long opaque id (tenantId, GUID, etc.) so it
 * stays scannable in a single line. Mirrors the local helper on
 * azure-accounts / user-creator / ea-subscription pages — duplicated
 * intentionally to keep this page self-contained (`@/lib/utils`
 * doesn't currently export this helper).
 */
function truncateMiddle(value, head = 8, tail = 4) {
    if (!value)
        return "";
    if (value.length <= head + tail + 1)
        return value;
    return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
const ALL_PROBES = ["csp", "mpn", "legalBusiness", "pal"];
const EMPTY_PROBES = {
    csp: null,
    mpn: null,
    legalBusiness: null,
    pal: null,
};
const PROBE_LABEL = {
    csp: "CSP customer access",
    mpn: "MPN / Partner Network profile",
    legalBusiness: "Legal-business profile",
    pal: "Partner Admin Link (PAL)",
};
/** Pretty label + accent class for a probe outcome badge. */
function outcomeBadge(outcome) {
    switch (outcome) {
        case "pass":
            return { label: "Pass", variant: "success" };
        case "unauthorized":
            return { label: "Not authorized", variant: "warning" };
        case "fail":
            return { label: "Fail", variant: "destructive" };
        case "unknown":
            return { label: "Unknown", variant: "outline" };
        default:
            return { label: "Not run", variant: "outline" };
    }
}
/**
 * Format a probe outcome for ARIA / textual export. Mirrors
 * `outcomeBadge` labels so the CSV export and the on-screen badge agree.
 */
function outcomeAsText(outcome) {
    return outcomeBadge(outcome).label;
}
export const PartnerCenterPage = ({ onNavigate, }) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _l, _m, _o, _p, _q, _r, _s, _t, _u;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    /* ───────────────────────────────────────────────────────────────────
     * Navigation. Prefer the path-based `navigateToPage` from the
     * dashboard outlet context (the canonical wiring); fall back to the
     * legacy `onNavigate(pageKey)` prop for storybook / standalone
     * mounts and for the back-compat adapter in page-router. The cast
     * tolerates rendering outside an Outlet (returns `undefined`).
     * ─────────────────────────────────────────────────────────────────── */
    const outletCtx = useDashboardOutletContext();
    const navigateTo = React.useCallback((key) => {
        if (outletCtx === null || outletCtx === void 0 ? void 0 : outletCtx.navigateToPage) {
            outletCtx.navigateToPage(key.startsWith("/") ? key : `/${key}`);
            return;
        }
        onNavigate === null || onNavigate === void 0 ? void 0 : onNavigate(key);
    }, [outletCtx, onNavigate]);
    /* ───────────────────────────────────────────────────────────────────
     * Candidate accounts. Every signed-in Azure account is a candidate
     * — Partner Center membership lives at the *tenant* level so the
     * operator picks "as which signed-in identity should I run this
     * probe?" rather than us pre-filtering on a role we'd just have to
     * call PC to verify anyway.
     * ─────────────────────────────────────────────────────────────────── */
    const candidates = React.useMemo(() => {
        return azureAccounts
            .map((a) => {
            var _a;
            return ({
                homeAccountId: a.homeAccountId,
                tenantId: (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : a.tenantId,
                username: a.username,
                name: a.name || a.username,
            });
        })
            .filter((a) => a.homeAccountId && a.tenantId);
    }, [azureAccounts]);
    const [accountId, setAccountId] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(ACTIVE_ACCOUNT_KEY)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    React.useEffect(() => {
        if (candidates.length === 0)
            return;
        if (!candidates.some((c) => c.homeAccountId === accountId)) {
            const next = candidates[0].homeAccountId;
            setAccountId(next);
            // Mirror the auto-selection to sessionStorage so a reload picks up
            // the same default rather than re-running this effect.
            try {
                sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, next);
            }
            catch (_a) {
                /* ignore */
            }
        }
    }, [candidates, accountId]);
    /* ───────────────────────────────────────────────────────────────────
     * Stale-write guard. Every probe captures the account id it started
     * against; the setProbes call later compares that against the
     * "current" account id and bails if the operator switched mid-run.
     * Without this guard, a slow probe fired against tenant A could land
     * its result in tenant B's slot after the picker change. The
     * generation counter makes the comparison cheap and re-entrant.
     * ─────────────────────────────────────────────────────────────────── */
    const accountGenRef = React.useRef(0);
    const partnerIdInputRef = React.useRef(null);
    const handleSelectAccount = React.useCallback((id) => {
        setAccountId(id);
        accountGenRef.current += 1;
        try {
            sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
        }
        catch (_a) {
            /* ignore */
        }
        // Clear stale probe results when the operator switches accounts
        // — they belong to a different identity.
        setProbes(EMPTY_PROBES);
    }, []);
    const account = React.useMemo(() => { var _a; return (_a = candidates.find((c) => c.homeAccountId === accountId)) !== null && _a !== void 0 ? _a : null; }, [candidates, accountId]);
    /**
     * Resolve the *currently active* tenant id for the selected account.
     * `CandidateAccount.tenantId` is snapshotted at memo-build time —
     * fine for the picker chips, but the runtime call sites below
     * (token acquisition, audit writes, exports) must read the live
     * `activeTenantId` off the underlying `AzureLoginAccount` so a
     * mid-flight tenant switch lands in the right slot.
     */
    const getActiveTenantIdForSelected = React.useCallback(() => {
        if (!account)
            return undefined;
        const full = azureAccounts.find((a) => a.homeAccountId === account.homeAccountId);
        return full ? resolveActiveTenantId(full) : account.tenantId;
    }, [account, azureAccounts]);
    /* ───────────────────────────────────────────────────────────────────
     * Page-level ARM token tracker. Drives the TokenExpiryBadge rendered
     * alongside the account picker. The page makes ARM calls for the
     * PAL probe + link/unlink mutations via getArmTokenForAccount(...)
     * inline in each handler — we don't bridge this tracker into those
     * call sites (they still acquire fresh per-call), the badge is here
     * purely so the operator sees when the ARM half of the session is
     * about to need a refresh. Partner Center tokens are deliberately
     * NOT tracked here — those are minted lazily by acquirePcToken and
     * follow a different consent / failure path (CSP enrollment).
     * ─────────────────────────────────────────────────────────────────── */
    const armTokenTracker = useArmToken(account === null || account === void 0 ? void 0 : account.homeAccountId, (_b = getActiveTenantIdForSelected()) !== null && _b !== void 0 ? _b : account === null || account === void 0 ? void 0 : account.tenantId);
    /* ───────────────────────────────────────────────────────────────────
     * Probe state + per-probe loading flags + per-probe last-run
     * timestamp (rendered as a small "1 min ago" hint).
     * ─────────────────────────────────────────────────────────────────── */
    const [probes, setProbes] = React.useState(EMPTY_PROBES);
    const [busy, setBusy] = React.useState({
        csp: false,
        mpn: false,
        legalBusiness: false,
        pal: false,
    });
    const [lastRunAt, setLastRunAt] = React.useState({
        csp: null,
        mpn: null,
        legalBusiness: null,
        pal: null,
    });
    /** Cached Partner Center token for the current account (best effort). */
    const acquirePcToken = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _v;
        if (!account)
            return { token: null };
        try {
            const tok = yield getPartnerCenterTokenForAccount(account.homeAccountId, (_v = getActiveTenantIdForSelected()) !== null && _v !== void 0 ? _v : account.tenantId);
            return { token: tok };
        }
        catch (err) {
            // Token acquisition failure usually means "this tenant isn't a
            // CSP partner" (consent_required / unauthorized_client). Bake
            // the same failure into all three PC probes so the operator
            // sees a coherent answer without spamming the AAD endpoint.
            const msg = err instanceof Error ? err.message : String(err);
            const isAccessDenied = /consent_required|interaction_required|unauthorized_client|AADSTS65001|AADSTS70011|AADSTS50020|invalid_resource/i.test(msg);
            const fail = {
                outcome: isAccessDenied ? "unauthorized" : "unknown",
                summary: isAccessDenied
                    ? "Tenant cannot mint Partner Center tokens (not a CSP partner)"
                    : "Partner Center token acquisition failed",
                detail: msg,
                data: null,
            };
            return { token: null, error: fail };
        }
    }), [account, getActiveTenantIdForSelected]);
    /**
     * Record a probe outcome in the audit log. Always writes — both pass
     * and fail are useful history. Distinct from the link/unlink
     * mutations which use their own `action` strings.
     */
    const recordProbeAudit = React.useCallback((which, result, actorAccount) => {
        const status = result.outcome === "pass"
            ? "success"
            : "failure";
        const full = azureAccounts.find((a) => a.homeAccountId === actorAccount.homeAccountId);
        const activeTenantId = full
            ? resolveActiveTenantId(full)
            : actorAccount.tenantId;
        auditLog.record({
            actor: actorAccount.username,
            action: `probe_partner_center:${which}`,
            target: which === "pal" ? partnerIdRef.current.trim() || "(no id)" : "tenant",
            status,
            error: status === "failure" ? result.summary : undefined,
            details: {
                tenantId: activeTenantId,
                outcome: result.outcome,
                httpStatus: result.status,
                code: result.code,
            },
        });
    }, [azureAccounts]);
    const runProbe = React.useCallback((which, all = false) => __awaiter(void 0, void 0, void 0, function* () {
        if (!account)
            return;
        const gen = accountGenRef.current;
        const actorAccount = account;
        // Safe-write — if the operator switched accounts while this probe
        // was in flight, drop the result silently.
        const safeSetProbes = (mut) => {
            if (accountGenRef.current !== gen)
                return;
            setProbes(mut);
            setLastRunAt((m) => (Object.assign(Object.assign({}, m), { [which]: Date.now() })));
        };
        setBusy((b) => (Object.assign(Object.assign({}, b), { [which]: true })));
        try {
            if (which === "pal") {
                const pid = partnerIdRef.current.trim();
                // PAL needs a known Partner ID. If we don't have one in
                // state, skip silently when called from "Run all"; surface
                // a non-fatal hint otherwise.
                if (!pid || !PARTNER_ID_RE.test(pid)) {
                    if (!all) {
                        safeSetProbes((p) => (Object.assign(Object.assign({}, p), { pal: {
                                outcome: "unknown",
                                summary: "Enter a Partner ID (6–10 digits) and try again.",
                                data: null,
                            } })));
                    }
                    return;
                }
                try {
                    // Tenant arg omitted so we pick up the operator's current active
                    // tenant (was pinning to actorAccount.tenantId / the account's
                    // HOME tenant — pre-switch).
                    const armToken = yield getArmTokenForAccount(actorAccount.homeAccountId);
                    const r = yield getPartnerAdminLink(pid, armToken);
                    safeSetProbes((p) => (Object.assign(Object.assign({}, p), { pal: r })));
                    recordProbeAudit("pal", r, actorAccount);
                }
                catch (err) {
                    // ARM token acquisition itself blew up (network /
                    // interaction_required) — surface this rather than
                    // silently swallowing.
                    const msg = err instanceof Error ? err.message : String(err);
                    const synthetic = {
                        outcome: /interaction_required|consent_required|AADSTS/i.test(msg)
                            ? "unauthorized"
                            : "unknown",
                        summary: "ARM token acquisition failed",
                        detail: msg,
                        data: null,
                    };
                    safeSetProbes((p) => (Object.assign(Object.assign({}, p), { pal: synthetic })));
                    recordProbeAudit("pal", synthetic, actorAccount);
                }
                return;
            }
            const { token, error } = yield acquirePcToken();
            if (!token) {
                // Mirror the same failure into the requested probe slot so
                // the UI surfaces a real answer rather than the spinner
                // hanging forever.
                const synthetic = error !== null && error !== void 0 ? error : {
                    outcome: "unknown",
                    summary: "Partner Center token unavailable",
                    data: null,
                };
                safeSetProbes((p) => (Object.assign(Object.assign({}, p), { [which]: synthetic })));
                recordProbeAudit(which, synthetic, actorAccount);
                return;
            }
            try {
                // Await BEFORE entering the setState callback — `(p) => ...`
                // is a synchronous arrow function and `await` inside it is a
                // parse error.
                if (which === "csp") {
                    const r = yield probeCspAccess(token);
                    safeSetProbes((p) => (Object.assign(Object.assign({}, p), { csp: r })));
                    recordProbeAudit("csp", r, actorAccount);
                }
                else if (which === "mpn") {
                    const r = yield probeMpnProfile(token);
                    safeSetProbes((p) => (Object.assign(Object.assign({}, p), { mpn: r })));
                    recordProbeAudit("mpn", r, actorAccount);
                }
                else if (which === "legalBusiness") {
                    const r = yield probeLegalBusinessProfile(token);
                    safeSetProbes((p) => (Object.assign(Object.assign({}, p), { legalBusiness: r })));
                    recordProbeAudit("legalBusiness", r, actorAccount);
                }
            }
            catch (err) {
                // The service-layer probes already trap errors into
                // ProbeResult, so a throw here is exceptional (likely a
                // programming error). Still — don't let it leak as an
                // un-handled rejection.
                const msg = err instanceof Error ? err.message : String(err);
                const synthetic = {
                    outcome: "unknown",
                    summary: `${PROBE_LABEL[which]} threw unexpectedly`,
                    detail: msg,
                    data: null,
                };
                safeSetProbes((p) => (Object.assign(Object.assign({}, p), { [which]: synthetic })));
                recordProbeAudit(which, synthetic, actorAccount);
            }
        }
        finally {
            // Always clear busy — even on stale-write — so a flipped
            // account doesn't leave a phantom spinner spinning.
            setBusy((b) => (Object.assign(Object.assign({}, b), { [which]: false })));
        }
    }), [account, acquirePcToken, recordProbeAudit]);
    /* ───────────────────────────────────────────────────────────────────
     * Partner Admin Link form + actions.
     *
     * partnerIdRef is read by callbacks (runProbe / runAllProbes) so they
     * always see the latest value without having to take partnerId as a
     * dep — important because otherwise the `useShortcut` registrations
     * below would re-bind every keystroke.
     * ─────────────────────────────────────────────────────────────────── */
    const [partnerId, setPartnerId] = usePersistedState(PARTNER_ID_KEY, "", {
        // Keep the raw-string legacy shape (no envelope wrapping) so older
        // installs hydrate their last-typed Partner ID without a migration
        // pass — `localStorage.getItem` previously returned the raw value.
        deserialize: (raw) => raw,
        serialize: (v) => v,
    });
    const partnerIdRef = React.useRef(partnerId);
    React.useEffect(() => {
        partnerIdRef.current = partnerId;
    }, [partnerId]);
    const handlePartnerIdChange = React.useCallback((v) => setPartnerId(v), [setPartnerId]);
    const partnerIdValid = PARTNER_ID_RE.test(partnerId.trim());
    /* ───────────────────────────────────────────────────────────────────
     * Enhancement #1 — persisted "preferred MPN" filter.
     *
     * Operators in multi-tenant CSP estates spend most of their day staring
     * at the SAME partner's customers. Persisting the MPN id (independent
     * of the in-flight Partner ID field above) lets us:
     *   - highlight the matching tenant in the CSP customer sample
     *   - pre-populate the Partner ID input on first paint when empty
     *   - flag a "this isn't my partner" mismatch when the MPN probe
     *     comes back with a different mpnId
     *
     * Stored under its own key so toggling it doesn't churn the working
     * Partner ID typed into the link/unlink form.
     * ─────────────────────────────────────────────────────────────────── */
    const [preferredMpn, setPreferredMpn] = usePersistedState(PREFERRED_MPN_KEY, "", {
        deserialize: (raw) => raw,
        serialize: (v) => v,
    });
    const [mpnFilterOn, setMpnFilterOn] = usePersistedState(`${PREFERRED_MPN_KEY}:on`, false);
    const [linking, setLinking] = React.useState(false);
    const [pendingLink, setPendingLink] = React.useState(false);
    const [pendingUnlink, setPendingUnlink] = React.useState(false);
    const [unlinking, setUnlinking] = React.useState(false);
    const runAllProbes = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!account)
            return;
        const gen = accountGenRef.current;
        const actorAccount = account;
        setProbes(EMPTY_PROBES);
        // Acquire PC token once and reuse across the three PC probes —
        // avoids three sequential consent prompts on first run.
        setBusy({ csp: true, mpn: true, legalBusiness: true, pal: false });
        const { token, error } = yield acquirePcToken();
        if (!token) {
            const synthetic = error !== null && error !== void 0 ? error : {
                outcome: "unknown",
                summary: "Partner Center token unavailable",
                data: null,
            };
            // Stale-write guard.
            if (accountGenRef.current === gen) {
                setProbes({
                    csp: synthetic,
                    mpn: synthetic,
                    legalBusiness: synthetic,
                    pal: null,
                });
                const now = Date.now();
                setLastRunAt((m) => (Object.assign(Object.assign({}, m), { csp: now, mpn: now, legalBusiness: now })));
                recordProbeAudit("csp", synthetic, actorAccount);
                recordProbeAudit("mpn", synthetic, actorAccount);
                recordProbeAudit("legalBusiness", synthetic, actorAccount);
            }
            setBusy({ csp: false, mpn: false, legalBusiness: false, pal: false });
            // Still run PAL if the operator entered a Partner ID — that path
            // uses an ARM token, not a PC token.
            const pid = partnerIdRef.current.trim();
            if (pid && PARTNER_ID_RE.test(pid)) {
                yield runProbe("pal", true);
            }
            return;
        }
        const [csp, mpn, legalBusiness] = yield Promise.all([
            probeCspAccess(token).catch((e) => ({
                outcome: "unknown",
                summary: "CSP probe threw",
                detail: e instanceof Error ? e.message : String(e),
                data: null,
            })),
            probeMpnProfile(token).catch((e) => ({
                outcome: "unknown",
                summary: "MPN probe threw",
                detail: e instanceof Error ? e.message : String(e),
                data: null,
            })),
            probeLegalBusinessProfile(token).catch((e) => ({
                outcome: "unknown",
                summary: "Legal-business probe threw",
                detail: e instanceof Error ? e.message : String(e),
                data: null,
            })),
        ]);
        if (accountGenRef.current === gen) {
            setProbes((p) => (Object.assign(Object.assign({}, p), { csp, mpn, legalBusiness })));
            const now = Date.now();
            setLastRunAt((m) => (Object.assign(Object.assign({}, m), { csp: now, mpn: now, legalBusiness: now })));
            recordProbeAudit("csp", csp, actorAccount);
            recordProbeAudit("mpn", mpn, actorAccount);
            recordProbeAudit("legalBusiness", legalBusiness, actorAccount);
        }
        setBusy({ csp: false, mpn: false, legalBusiness: false, pal: false });
        // Run PAL after the others; it uses a separate ARM token and a
        // distinct user-supplied Partner ID.
        const pid = partnerIdRef.current.trim();
        if (pid && PARTNER_ID_RE.test(pid)) {
            yield runProbe("pal", true);
        }
    }), [account, acquirePcToken, runProbe, recordProbeAudit]);
    /**
     * Re-run only probes whose previous outcome wasn't `pass`. Skips PAL
     * if there's no valid Partner ID. Cheap retry after fixing tenant /
     * consent.
     */
    const retryFailedProbes = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!account)
            return;
        const failedKeys = ALL_PROBES.filter((k) => {
            const r = probes[k];
            if (!r)
                return false;
            return r.outcome !== "pass";
        });
        if (failedKeys.length === 0)
            return;
        for (const k of failedKeys) {
            // Sequentially so we don't double-prompt for the PC token; the
            // service layer keeps no shared cache.
            yield runProbe(k, true);
        }
    }), [account, probes, runProbe]);
    /* ───────────────────────────────────────────────────────────────────
     * Corpus-grounded extra probes — GDAP delegation creep + subscription-
     * level PAL drift. Both are off-by-default; the operator clicks "Run"
     * to fire them. See `partner-relationships-probe.ts` for the
     * implementation and `_bypass_tenant_switch.md` §6 for the rationale.
     * ─────────────────────────────────────────────────────────────────── */
    const [gdapProbe, setGdapProbe] = React.useState(null);
    const [gdapBusy, setGdapBusy] = React.useState(false);
    const [palDriftProbe, setPalDriftProbe] = React.useState(null);
    const [palDriftBusy, setPalDriftBusy] = React.useState(false);
    const runGdapProbe = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _w, _x, _y, _z, _0;
        if (!account)
            return;
        const gen = accountGenRef.current;
        const actorAccount = account;
        setGdapBusy(true);
        try {
            const graphToken = yield getGraphTokenForAccount(actorAccount.homeAccountId, (_w = getActiveTenantIdForSelected()) !== null && _w !== void 0 ? _w : actorAccount.tenantId);
            const r = yield probeGdapDelegations(graphToken);
            if (accountGenRef.current !== gen)
                return;
            setGdapProbe(r);
            const status = r.outcome === "pass" ? "success" : "failure";
            auditLog.record({
                actor: actorAccount.username,
                action: "probe_partner_center:gdap",
                target: "tenantRelationships/delegatedAdminRelationships",
                status,
                error: status === "failure" ? r.summary : undefined,
                details: {
                    tenantId: (_x = getActiveTenantIdForSelected()) !== null && _x !== void 0 ? _x : actorAccount.tenantId,
                    outcome: r.outcome,
                    activeCount: (_y = r.data) === null || _y === void 0 ? void 0 : _y.activeCount,
                    highPrivActiveCount: (_z = r.data) === null || _z === void 0 ? void 0 : _z.highPrivActiveCount,
                    creep: (_0 = r.data) === null || _0 === void 0 ? void 0 : _0.creep,
                },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const synthetic = {
                outcome: /interaction_required|consent_required|AADSTS/i.test(msg)
                    ? "unauthorized"
                    : "unknown",
                summary: "Graph token acquisition failed",
                detail: msg,
                data: null,
            };
            if (accountGenRef.current === gen)
                setGdapProbe(synthetic);
        }
        finally {
            setGdapBusy(false);
        }
    }), [account, getActiveTenantIdForSelected]);
    const runPalDriftProbe = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _1, _2, _3, _4;
        if (!account)
            return;
        const gen = accountGenRef.current;
        const actorAccount = account;
        setPalDriftBusy(true);
        try {
            const armToken = yield getArmTokenForAccount(actorAccount.homeAccountId);
            const r = yield probePalDrift(armToken, preferredMpn.trim() || null);
            if (accountGenRef.current !== gen)
                return;
            setPalDriftProbe(r);
            const status = r.outcome === "pass" ? "success" : "failure";
            auditLog.record({
                actor: actorAccount.username,
                action: "probe_partner_center:pal_drift",
                target: preferredMpn.trim() ||
                    "(no preferred mpn — no-PAL gaps only)",
                status,
                error: status === "failure" ? r.summary : undefined,
                details: {
                    tenantId: (_1 = getActiveTenantIdForSelected()) !== null && _1 !== void 0 ? _1 : actorAccount.tenantId,
                    outcome: r.outcome,
                    mismatchCount: (_2 = r.data) === null || _2 === void 0 ? void 0 : _2.mismatchCount,
                    noPalCount: (_3 = r.data) === null || _3 === void 0 ? void 0 : _3.noPalCount,
                    totalSubscriptions: (_4 = r.data) === null || _4 === void 0 ? void 0 : _4.totalSubscriptions,
                },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const synthetic = {
                outcome: /interaction_required|consent_required|AADSTS/i.test(msg)
                    ? "unauthorized"
                    : "unknown",
                summary: "ARM token acquisition failed",
                detail: msg,
                data: null,
            };
            if (accountGenRef.current === gen)
                setPalDriftProbe(synthetic);
        }
        finally {
            setPalDriftBusy(false);
        }
    }), [account, getActiveTenantIdForSelected, preferredMpn]);
    /* ───────────────────────────────────────────────────────────────────
     * Bulk customer probe. Walks the CSP customer sample (or all visible
     * customer IDs in `probes.csp.data.sample`) and probes each one in
     * sequence so we don't trip Partner Center's per-principal throttle.
     * Renders a progress bar; cancellable mid-sweep.
     * ─────────────────────────────────────────────────────────────────── */
    const [bulkBusy, setBulkBusy] = React.useState(false);
    const [bulkDone, setBulkDone] = React.useState(0);
    const [bulkTotal, setBulkTotal] = React.useState(0);
    const [bulkRows, setBulkRows] = React.useState([]);
    const bulkAbortRef = React.useRef(null);
    /** Per-customer last-probe timestamps (per account, sessionStorage). */
    const customerLedgerKey = account
        ? `${CUSTOMER_PROBE_KEY}:${account.homeAccountId}`
        : CUSTOMER_PROBE_KEY;
    const [customerLedger, setCustomerLedger] = React.useState(() => loadCustomerLedger(customerLedgerKey));
    // Rehydrate the ledger when the active account changes.
    React.useEffect(() => {
        setCustomerLedger(loadCustomerLedger(customerLedgerKey));
    }, [customerLedgerKey]);
    const runBulkCustomerProbe = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _5, _6, _7, _8, _9;
        if (!account)
            return;
        const cspData = ((_5 = probes.csp) === null || _5 === void 0 ? void 0 : _5.outcome) === "pass"
            ? (_6 = probes.csp.data) !== null && _6 !== void 0 ? _6 : null
            : null;
        const ids = (_7 = cspData === null || cspData === void 0 ? void 0 : cspData.sample) !== null && _7 !== void 0 ? _7 : [];
        if (ids.length === 0)
            return;
        const gen = accountGenRef.current;
        const actorAccount = account;
        const { token, error } = yield acquirePcToken();
        if (!token) {
            store.addNotification({
                type: "error",
                message: (_8 = error === null || error === void 0 ? void 0 : error.summary) !== null && _8 !== void 0 ? _8 : "Partner Center token unavailable.",
            });
            return;
        }
        setBulkBusy(true);
        setBulkDone(0);
        setBulkTotal(ids.length);
        setBulkRows([]);
        const ctrl = new AbortController();
        bulkAbortRef.current = ctrl;
        try {
            const ledgerUpdate = Object.assign({}, customerLedger);
            const rows = yield bulkProbeCustomers(ids, token, {
                signal: ctrl.signal,
                onProgress: (done, total, row) => {
                    if (accountGenRef.current !== gen)
                        return;
                    setBulkDone(done);
                    setBulkRows((prev) => [...prev, row]);
                    ledgerUpdate[row.customerId] = Date.now();
                },
            });
            if (accountGenRef.current === gen) {
                saveCustomerLedger(customerLedgerKey, ledgerUpdate);
                setCustomerLedger(ledgerUpdate);
                const passCount = rows.filter((r) => r.outcome === "pass").length;
                auditLog.record({
                    actor: actorAccount.username,
                    action: "probe_partner_center:bulk_customers",
                    target: `${rows.length} customers`,
                    status: ctrl.signal.aborted
                        ? "failure"
                        : passCount > 0
                            ? "success"
                            : "failure",
                    error: ctrl.signal.aborted ? "operator cancelled" : undefined,
                    details: {
                        tenantId: (_9 = getActiveTenantIdForSelected()) !== null && _9 !== void 0 ? _9 : actorAccount.tenantId,
                        scanned: rows.length,
                        passed: passCount,
                    },
                });
            }
        }
        finally {
            bulkAbortRef.current = null;
            setBulkBusy(false);
        }
    }), [
        account,
        acquirePcToken,
        customerLedger,
        customerLedgerKey,
        getActiveTenantIdForSelected,
        probes.csp,
        store,
    ]);
    const cancelBulkProbe = React.useCallback(() => {
        var _a;
        (_a = bulkAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
    }, []);
    /* ───────────────────────────────────────────────────────────────────
     * Stale-customer (60d) view. Cross-references the most recent
     * customer ledger against the current CSP probe's sample — any
     * customer that's been seen in the sample but hasn't been probed in
     * 60 days bubbles up. The threshold is corpus-grounded: dormant MSP
     * relationships are the classic supply-chain pivot
     * (`_bypass_tenant_switch.md` §6.3).
     * ─────────────────────────────────────────────────────────────────── */
    const staleCustomers = React.useMemo(() => {
        var _a, _b, _c;
        const cspData = ((_a = probes.csp) === null || _a === void 0 ? void 0 : _a.outcome) === "pass"
            ? (_b = probes.csp.data) !== null && _b !== void 0 ? _b : null
            : null;
        const ids = (_c = cspData === null || cspData === void 0 ? void 0 : cspData.sample) !== null && _c !== void 0 ? _c : [];
        if (ids.length === 0)
            return [];
        const now = Date.now();
        return ids
            .map((id) => {
            var _a;
            return ({
                id,
                lastProbedMs: (_a = customerLedger[id]) !== null && _a !== void 0 ? _a : null,
            });
        })
            .filter((e) => {
            var _a;
            return e.lastProbedMs === null ||
                now - ((_a = e.lastProbedMs) !== null && _a !== void 0 ? _a : 0) > STALE_CUSTOMER_MS;
        });
    }, [customerLedger, probes.csp]);
    /* ───────────────────────────────────────────────────────────────────
     * MPN-mismatch filter (chip). Extends wave-1 warning into an
     * "explicit, only-show-mismatched" filter. When on AND the MPN probe
     * has a `data.mpnId`, the page emphasises the mismatch warning.
     * ─────────────────────────────────────────────────────────────────── */
    const [showMismatchedOnly, setShowMismatchedOnly] = usePersistedState(`${PREFERRED_MPN_KEY}:mismatched-only`, false);
    const handleConfirmLink = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!account || !partnerIdValid)
            return;
        setPendingLink(false);
        setLinking(true);
        const gen = accountGenRef.current;
        const actorAccount = account;
        const fullActor = azureAccounts.find((a) => a.homeAccountId === actorAccount.homeAccountId);
        const activeTenantId = fullActor
            ? resolveActiveTenantId(fullActor)
            : actorAccount.tenantId;
        try {
            // Tenant arg omitted so we pick up the operator's current active
            // tenant (was pinning to actorAccount.tenantId / the account's HOME
            // tenant — pre-switch).
            const armToken = yield getArmTokenForAccount(actorAccount.homeAccountId);
            yield linkPartnerAdmin(partnerId.trim(), armToken);
            auditLog.record({
                actor: actorAccount.username,
                action: "link_partner_admin",
                target: partnerId.trim(),
                status: "success",
                details: { tenantId: activeTenantId },
            });
            store.addNotification({
                type: "success",
                message: `Partner ID ${partnerId.trim()} linked.`,
            });
            // Refresh the PAL probe so the operator sees confirmation —
            // but only if we're still on the same account.
            if (accountGenRef.current === gen) {
                yield runProbe("pal");
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            auditLog.record({
                actor: actorAccount.username,
                action: "link_partner_admin",
                target: partnerId.trim(),
                status: "failure",
                error: msg,
                details: { tenantId: activeTenantId },
            });
            store.addNotification({
                type: "error",
                message: `Link failed: ${msg}`,
            });
        }
        finally {
            setLinking(false);
        }
    }), [account, azureAccounts, partnerId, partnerIdValid, runProbe, store]);
    const handleConfirmUnlink = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!account || !partnerIdValid)
            return;
        setPendingUnlink(false);
        setUnlinking(true);
        const gen = accountGenRef.current;
        const actorAccount = account;
        const fullActor = azureAccounts.find((a) => a.homeAccountId === actorAccount.homeAccountId);
        const activeTenantId = fullActor
            ? resolveActiveTenantId(fullActor)
            : actorAccount.tenantId;
        try {
            // Tenant arg omitted so we pick up the operator's current active
            // tenant (was pinning to actorAccount.tenantId / the account's HOME
            // tenant — pre-switch).
            const armToken = yield getArmTokenForAccount(actorAccount.homeAccountId);
            yield unlinkPartnerAdmin(partnerId.trim(), armToken);
            auditLog.record({
                actor: actorAccount.username,
                action: "unlink_partner_admin",
                target: partnerId.trim(),
                status: "success",
                details: { tenantId: activeTenantId },
            });
            store.addNotification({
                type: "success",
                message: `Partner ID ${partnerId.trim()} unlinked.`,
            });
            if (accountGenRef.current === gen) {
                setProbes((p) => (Object.assign(Object.assign({}, p), { pal: {
                        outcome: "fail",
                        summary: `Partner ID ${partnerId.trim()} is not linked to this account`,
                        status: 404,
                        data: null,
                    } })));
                setLastRunAt((m) => (Object.assign(Object.assign({}, m), { pal: Date.now() })));
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            auditLog.record({
                actor: actorAccount.username,
                action: "unlink_partner_admin",
                target: partnerId.trim(),
                status: "failure",
                error: msg,
                details: { tenantId: activeTenantId },
            });
            store.addNotification({
                type: "error",
                message: `Unlink failed: ${msg}`,
            });
        }
        finally {
            setUnlinking(false);
        }
    }), [account, azureAccounts, partnerId, partnerIdValid, store]);
    /* ───────────────────────────────────────────────────────────────────
     * Probe-results export. Captures the four probe slots + their parsed
     * data, exporting one row per probe so the JSON / CSV files match
     * what the operator just saw on screen.
     *
     * Enhancement #3 — unified ExportMenu (CSV + JSON in one dropdown)
     * replaces the previous pair of inline buttons. The accessor callbacks
     * mirror what the on-screen badges show so a CSV opened in Excel and
     * the UI never disagree.
     * ─────────────────────────────────────────────────────────────────── */
    const exportRows = React.useMemo(() => {
        const now = Date.now();
        return ALL_PROBES.map((k) => {
            var _a, _b, _c, _d, _e;
            const r = probes[k];
            const ranAtMs = lastRunAt[k];
            return {
                probe: k,
                label: PROBE_LABEL[k],
                outcome: r ? outcomeAsText(r.outcome) : "Not run",
                summary: (_a = r === null || r === void 0 ? void 0 : r.summary) !== null && _a !== void 0 ? _a : "",
                httpStatus: (_b = r === null || r === void 0 ? void 0 : r.status) !== null && _b !== void 0 ? _b : null,
                errorCode: (_c = r === null || r === void 0 ? void 0 : r.code) !== null && _c !== void 0 ? _c : null,
                detail: (_d = r === null || r === void 0 ? void 0 : r.detail) !== null && _d !== void 0 ? _d : null,
                data: (_e = r === null || r === void 0 ? void 0 : r.data) !== null && _e !== void 0 ? _e : null,
                ranAt: ranAtMs ? new Date(ranAtMs).toISOString() : null,
                stale: ranAtMs != null && now - ranAtMs > STALE_PROBE_MS,
            };
        });
    }, [probes, lastRunAt]);
    const exportColumns = React.useMemo(() => [
        { header: "Probe", accessor: (r) => r.probe },
        { header: "Label", accessor: (r) => r.label },
        { header: "Outcome", accessor: (r) => r.outcome },
        { header: "Summary", accessor: (r) => r.summary },
        { header: "HTTP status", accessor: (r) => { var _a; return (_a = r.httpStatus) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Error code", accessor: (r) => { var _a; return (_a = r.errorCode) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Ran at", accessor: (r) => { var _a; return (_a = r.ranAt) !== null && _a !== void 0 ? _a : ""; } },
        { header: "Stale (>24h)", accessor: (r) => (r.stale ? "yes" : "") },
        { header: "Detail", accessor: (r) => { var _a; return (_a = r.detail) !== null && _a !== void 0 ? _a : ""; } },
    ], []);
    const exportMetadata = React.useMemo(() => {
        var _a, _b, _c;
        return ({
            tenantId: (_b = (_a = getActiveTenantIdForSelected()) !== null && _a !== void 0 ? _a : account === null || account === void 0 ? void 0 : account.tenantId) !== null && _b !== void 0 ? _b : null,
            account: (_c = account === null || account === void 0 ? void 0 : account.username) !== null && _c !== void 0 ? _c : null,
            partnerId: partnerId.trim() || null,
            preferredMpn: preferredMpn.trim() || null,
        });
    }, [account, getActiveTenantIdForSelected, partnerId, preferredMpn]);
    /* ───────────────────────────────────────────────────────────────────
     * Enhancement #5 — stale-probe detector.
     *
     * A probe that hasn't been re-run in >24h is no longer trustworthy for
     * partner-of-record / billing-attribution decisions. We surface a
     * small "Stale" pill on the row + a banner-level count, and the CSV
     * export carries a dedicated column so the operator can filter on it
     * downstream.
     * ─────────────────────────────────────────────────────────────────── */
    const staleCount = React.useMemo(() => exportRows.filter((r) => r.stale).length, [exportRows]);
    /* ───────────────────────────────────────────────────────────────────
     * Keyboard shortcuts (page-scoped, suppressed while typing in an
     * input). The shortcuts are intentionally light — operators tend to
     * be deep in a probe-then-fix loop, so anything that saves a click
     * pays off.
     * ─────────────────────────────────────────────────────────────────── */
    useShortcut("Mod+Enter", () => {
        if (!account)
            return;
        void runAllProbes();
    });
    useShortcut("Mod+l", () => {
        var _a, _b;
        (_a = partnerIdInputRef.current) === null || _a === void 0 ? void 0 : _a.focus();
        (_b = partnerIdInputRef.current) === null || _b === void 0 ? void 0 : _b.select();
    });
    useShortcut("Mod+Shift+r", () => {
        if (!account)
            return;
        void retryFailedProbes();
    });
    // Bare-key shortcuts. These intentionally do NOT use Mod+ so they
    // mirror the bare-key conventions on similar list / probe pages.
    // Suppressed automatically while focus is inside an input (the
    // useShortcut hook handles that).
    //
    // NOTE: do NOT reference values declared after the early-return for
    // "no candidates" below — the handler closure would TDZ on those
    // when the keypress fires from a render that took the early return.
    // Compute "any failed/unauthorised/unknown" inline from `probes`.
    useShortcut("r", () => {
        if (!account)
            return;
        // `r` re-runs the failed probes if any, otherwise runs all four.
        // The "selected" intent (per spec) collapses to "the probes that
        // need running" — no row-selection UI exists.
        const hasFailures = ALL_PROBES.some((k) => {
            const r = probes[k];
            return r != null && r.outcome !== "pass";
        });
        if (hasFailures) {
            void retryFailedProbes();
        }
        else {
            void runAllProbes();
        }
    });
    useShortcut("/", () => {
        var _a, _b;
        // `/` focuses the Partner ID input as the page's primary "search /
        // narrow" affordance — the input doubles as the PAL probe target
        // and the preferred-MPN seed.
        (_a = partnerIdInputRef.current) === null || _a === void 0 ? void 0 : _a.focus();
        (_b = partnerIdInputRef.current) === null || _b === void 0 ? void 0 : _b.select();
    });
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!candidates.some((c) => c.homeAccountId === candidate))
            return;
        if (accountId === candidate)
            return;
        // Route through handleSelectAccount so the generation counter bumps
        // AND the probe state resets — otherwise an in-flight probe fired
        // against the previous account can land its result in the new
        // account's slot (the bare setAccountId path skipped both
        // accountGenRef++ and setProbes(EMPTY_PROBES)).
        handleSelectAccount(candidate);
    });
    /* ───────────────────────────────────────────────────────────────────
     * Render
     * ─────────────────────────────────────────────────────────────────── */
    if (candidates.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
            React.createElement(PageHeader, { title: "Partner Center", description: "Probe a signed-in account for CSP / MPN / Partner Admin Link capability." }),
            React.createElement(SignInRequired, { whatYouCantDo: "Probe Partner Center capability", why: "an Azure account whose tenant has CSP, MPN, or Partner Admin Link associations", onNavigate: (k) => navigateTo(k) })));
    }
    // Per-outcome counts for the summary strip — granular breakdown the
    // single "fail" column couldn't carry.
    const counts = ALL_PROBES.reduce((acc, k) => {
        const r = probes[k];
        if (!r)
            acc.notRun += 1;
        else if (r.outcome === "pass")
            acc.pass += 1;
        else if (r.outcome === "unauthorized")
            acc.unauthorized += 1;
        else if (r.outcome === "fail")
            acc.fail += 1;
        else
            acc.unknown += 1;
        return acc;
    }, { pass: 0, unauthorized: 0, fail: 0, unknown: 0, notRun: 0 });
    const failOrUnauth = counts.fail + counts.unauthorized + counts.unknown;
    const ranCount = 4 - counts.notRun;
    const hasAnyResult = ranCount > 0;
    const anyBusy = busy.csp || busy.mpn || busy.legalBusiness || busy.pal;
    // True when at least one probe ran AND none of them passed — almost
    // always means "wrong tenant" or "needs Token Importer".
    const allFailed = hasAnyResult && counts.pass === 0;
    // Derived MPN match state — used by the preferred-MPN filter chip and
    // by the MPN probe row to flag "this isn't the partner you usually
    // operate as". Trimmed because operators paste with stray whitespace.
    const trimmedPreferredMpn = preferredMpn.trim();
    const observedMpnId = ((_c = probes.mpn) === null || _c === void 0 ? void 0 : _c.outcome) === "pass"
        ? (_e = (_d = probes.mpn.data) === null || _d === void 0 ? void 0 : _d.mpnId) !== null && _e !== void 0 ? _e : ""
        : "";
    const mpnMismatch = mpnFilterOn &&
        !!trimmedPreferredMpn &&
        !!observedMpnId &&
        observedMpnId !== trimmedPreferredMpn;
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
        React.createElement(PageHeader, { title: "Partner Center", description: "Probe a signed-in account for CSP (Cloud Solution Provider) and MPN (Partner Network) capability, and manage Partner Admin Link." },
            React.createElement("div", { className: "flex items-center gap-2" },
                React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                        loginHint: account === null || account === void 0 ? void 0 : account.username,
                    }) }),
                React.createElement(KeyboardHintBadge, null),
                React.createElement(Select, { value: accountId, onValueChange: handleSelectAccount },
                    React.createElement(SelectTrigger, { className: "h-8 w-72 text-xs", "aria-label": "Select account to probe" },
                        React.createElement(SelectValue, { placeholder: "Select account" })),
                    React.createElement(SelectContent, null, candidates.map((a) => (React.createElement(SelectItem, { key: a.homeAccountId, value: a.homeAccountId },
                        React.createElement("span", { className: "truncate" },
                            a.name || a.username,
                            React.createElement("span", { className: "ml-1 text-muted-foreground" },
                                "(",
                                React.createElement("code", { className: "font-mono" }, truncateMiddle(a.tenantId)),
                                ")"))))))))),
        React.createElement("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7" },
            React.createElement(SummaryStatItem, { label: "Probes run", value: `${ranCount}/4`, compact: true }),
            React.createElement(SummaryStatItem, { label: "Pass", value: counts.pass, tone: "success", compact: true }),
            React.createElement(SummaryStatItem, { label: "Unauthorized", value: counts.unauthorized, tone: counts.unauthorized > 0 ? "warning" : "muted", compact: true }),
            React.createElement(SummaryStatItem, { label: "Fail", value: counts.fail, tone: counts.fail > 0 ? "destructive" : "muted", compact: true }),
            React.createElement(SummaryStatItem, { label: "Not run", value: counts.notRun, tone: "muted", compact: true }),
            React.createElement(SummaryStatItem, { label: "Stale (>24h)", value: staleCount, tone: staleCount > 0 ? "warning" : "muted", hint: staleCount > 0 ? "re-run for fresh data" : undefined, compact: true }),
            React.createElement("div", { className: "group/copy flex flex-col justify-center gap-0.5 rounded-md border border-border/60 bg-card/40 px-3 py-2", "aria-label": "Active tenant id" },
                React.createElement("span", { className: "text-3xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Tenant"),
                React.createElement("div", { className: "flex items-center gap-1" },
                    React.createElement("code", { className: "truncate font-mono text-xs text-foreground" }, truncateMiddle((_f = account === null || account === void 0 ? void 0 : account.tenantId) !== null && _f !== void 0 ? _f : "", 8, 4) || "—"),
                    (account === null || account === void 0 ? void 0 : account.tenantId) ? (React.createElement(CopyButton, { value: account.tenantId, ariaLabel: `Copy tenant id ${account.tenantId}` })) : null))),
        allFailed && (React.createElement(Alert, { variant: "warning", className: "text-xs" },
            React.createElement(AlertTriangle, { className: "h-3.5 w-3.5" }),
            React.createElement(AlertDescription, null,
                "None of the probes passed for this account. The likely cause: ",
                React.createElement("strong", null, (_g = account === null || account === void 0 ? void 0 : account.username) !== null && _g !== void 0 ? _g : "this account"),
                " ",
                "is signed in but the tenant",
                " ",
                React.createElement("code", { className: "font-mono" }, truncateMiddle((_h = account === null || account === void 0 ? void 0 : account.tenantId) !== null && _h !== void 0 ? _h : "")),
                " ",
                "isn't enrolled in CSP or MPN. Sign in with a partner-tenant identity, or use",
                " ",
                React.createElement("strong", null, "Token Importer"),
                " to paste a Partner Center token from a working browser session."))),
        React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2 text-2xs", role: "region", "aria-label": "Preferred MPN filter" },
            React.createElement("span", { className: "font-semibold uppercase tracking-wider text-muted-foreground" }, "Preferred MPN"),
            React.createElement(Input, { value: preferredMpn, onChange: (e) => setPreferredMpn(e.target.value), placeholder: "e.g. 1234567", inputMode: "numeric", autoComplete: "off", "aria-label": "Preferred MPN id (sticky filter)", className: "h-7 w-32 font-mono text-xs" }),
            React.createElement(Button, { type: "button", variant: mpnFilterOn ? "default" : "outline", size: "sm", className: "h-7 px-2", "aria-pressed": mpnFilterOn, onClick: () => setMpnFilterOn((on) => !on), disabled: !trimmedPreferredMpn, title: !trimmedPreferredMpn
                    ? "Enter an MPN id first"
                    : mpnFilterOn
                        ? "Disable preferred-MPN check"
                        : "Highlight the configured MPN in probe results" }, mpnFilterOn ? "Filter on" : "Filter off"),
            trimmedPreferredMpn && partnerId.trim() !== trimmedPreferredMpn && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 px-2 text-3xs", onClick: () => handlePartnerIdChange(trimmedPreferredMpn), "aria-label": "Use the preferred MPN as the working Partner ID" }, "Use as Partner ID")),
            React.createElement(Button, { type: "button", variant: showMismatchedOnly ? "default" : "outline", size: "sm", className: "h-7 px-2 text-3xs", "aria-pressed": showMismatchedOnly, onClick: () => setShowMismatchedOnly((v) => !v), disabled: !mpnFilterOn || !trimmedPreferredMpn, title: !mpnFilterOn
                    ? "Turn the preferred-MPN filter on first"
                    : showMismatchedOnly
                        ? "Stop emphasising mismatched MPNs"
                        : "Emphasise customers / subs whose MPN ≠ preferred" }, "Mismatched only"),
            mpnMismatch && (React.createElement("span", { className: "ml-auto inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-medium text-warning" },
                React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true }),
                "MPN mismatch: observed",
                " ",
                React.createElement("code", { className: "font-mono" }, observedMpnId),
                React.createElement(CopyButton, { value: observedMpnId, alwaysVisible: true, ariaLabel: `Copy observed MPN ${observedMpnId}` })))),
        React.createElement(Card, { className: "border-border bg-card shadow-sm" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
                    React.createElement("div", null,
                        React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold" },
                            React.createElement(Sparkles, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                            "Capability probes"),
                        React.createElement(CardDescription, { className: "mt-1" },
                            "Fires non-mutating GETs against",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "api.partnercenter.microsoft.com"),
                            " ",
                            "and ARM",
                            " ",
                            React.createElement("code", { className: "font-mono" }, "Microsoft.ManagementPartner"),
                            ". Outcomes are recorded to the audit log.")),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
                        React.createElement(ExportMenu, { rows: exportRows, columns: exportColumns, filename: "partner-center-probes", jsonMetadata: exportMetadata, disabled: !hasAnyResult, rowCount: ranCount, label: "Export" })))),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: () => void runAllProbes(), loading: anyBusy, disabled: !account, "aria-label": "Run all Partner Center probes", title: `Run all probes (${modKeyLabel()}+Enter)` },
                        !anyBusy && React.createElement(RotateCw, { className: "h-3.5 w-3.5" }),
                        "Run all probes"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => void retryFailedProbes(), disabled: !account || anyBusy || failOrUnauth === 0, "aria-label": "Re-run only the probes that did not pass", title: `Retry failed probes (${modKeyLabel()}+Shift+R)` },
                        React.createElement(RotateCcw, { className: "h-3.5 w-3.5" }),
                        "Retry failed",
                        failOrUnauth > 0 && (React.createElement(Badge, { variant: "outline", className: "ml-1 text-3xs" }, failOrUnauth))),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" }, account ? (React.createElement(React.Fragment, null,
                        "As",
                        " ",
                        React.createElement("span", { className: "font-semibold" }, account.username),
                        " \u00B7",
                        " ",
                        "tenant",
                        " ",
                        React.createElement("code", { className: "font-mono" }, truncateMiddle(account.tenantId)))) : ("Pick an account first."))),
                React.createElement(ProbeRow, { label: PROBE_LABEL.csp, help: "GET /v1/customers \u2014 confirms the signed-in account belongs to a Cloud Solution Provider partner tenant and has at least read access to the partner's customer list. A 401/403 here usually means the account is signed in but lacks CSP role assignment.", icon: ShieldCheck, result: probes.csp, loading: busy.csp, onRun: () => void runProbe("csp"), disabled: !account, lastRunAt: lastRunAt.csp, stale: lastRunAt.csp != null &&
                        Date.now() - lastRunAt.csp > STALE_PROBE_MS, renderExtra: (r) => {
                        if (r.outcome !== "pass" || !r.data)
                            return null;
                        const data = r.data;
                        if (data.totalCount === 0)
                            return null;
                        return (React.createElement("div", { className: "text-2xs text-muted-foreground" },
                            "Customers visible: ",
                            React.createElement("strong", null, data.totalCount),
                            data.sample.length > 0 && (React.createElement("span", { className: "ml-1.5 opacity-80" },
                                "(sample:",
                                " ",
                                data.sample
                                    .slice(0, 3)
                                    .map((s) => truncateMiddle(s, 6, 4))
                                    .join(", "),
                                data.sample.length > 3 ? "…" : "",
                                ")"))));
                    } }),
                React.createElement(ProbeRow, { label: PROBE_LABEL.mpn, help: "GET /v1/profiles/mpn \u2014 returns the partner's MPN ID (also called Partner ID) and program membership. Required to create offers and earn incentives. The MPN ID returned here is what you'd paste into the Partner ID field below.", icon: Handshake, result: probes.mpn, loading: busy.mpn, onRun: () => void runProbe("mpn"), disabled: !account, lastRunAt: lastRunAt.mpn, stale: lastRunAt.mpn != null &&
                        Date.now() - lastRunAt.mpn > STALE_PROBE_MS, renderExtra: (r) => {
                        if (r.outcome !== "pass" || !r.data)
                            return null;
                        const data = r.data;
                        if (!data.mpnId)
                            return null;
                        const isPreferred = mpnFilterOn &&
                            !!trimmedPreferredMpn &&
                            data.mpnId === trimmedPreferredMpn;
                        const isPreferredMismatch = mpnFilterOn &&
                            !!trimmedPreferredMpn &&
                            data.mpnId !== trimmedPreferredMpn;
                        return (React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-2xs text-muted-foreground" },
                            React.createElement("span", null,
                                "Partner ID:",
                                " ",
                                React.createElement(CopyableText, { value: data.mpnId, mono: true, alwaysVisibleButton: true })),
                            data.profileType && (React.createElement(Badge, { variant: "outline", className: "text-3xs" }, data.profileType)),
                            isPreferred && (React.createElement(Badge, { variant: "success", className: "text-3xs" }, "preferred MPN \u2713")),
                            isPreferredMismatch && (React.createElement(Badge, { variant: "warning", className: "text-3xs" },
                                "\u2260 preferred ",
                                trimmedPreferredMpn)),
                            data.mpnId !== partnerId.trim() && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-5 px-1.5 text-3xs", onClick: () => handlePartnerIdChange(data.mpnId), "aria-label": `Use ${data.mpnId} as the Partner ID below` }, "Use below"))));
                    } }),
                React.createElement(ProbeRow, { label: PROBE_LABEL.legalBusiness, help: "GET /v1/profiles/legalbusiness \u2014 proves the partner has cleared the business-verification gate. Often the first call that fails for partners mid-onboarding or in suspended state. Required for transacting in Partner Center.", icon: ShieldAlert, result: probes.legalBusiness, loading: busy.legalBusiness, onRun: () => void runProbe("legalBusiness"), disabled: !account, lastRunAt: lastRunAt.legalBusiness, stale: lastRunAt.legalBusiness != null &&
                        Date.now() - lastRunAt.legalBusiness > STALE_PROBE_MS, renderExtra: (r) => {
                        if (r.outcome !== "pass" || !r.data)
                            return null;
                        const data = r.data;
                        if (!data.companyName)
                            return null;
                        return (React.createElement("div", { className: "text-2xs text-muted-foreground" },
                            "Company: ",
                            React.createElement("strong", null, data.companyName)));
                    } }),
                React.createElement(ProbeRow, { label: PROBE_LABEL.pal, help: "GET Microsoft.ManagementPartner/partners/{partnerId} \u2014 checks whether the Partner ID below is linked to this account, so Azure usage gets attributed back to the partner of record. Requires a valid 6\u201310 digit Partner ID in the form below.", icon: Link2, result: probes.pal, loading: busy.pal, onRun: () => void runProbe("pal"), disabled: !account || !partnerIdValid, lastRunAt: lastRunAt.pal, stale: lastRunAt.pal != null &&
                        Date.now() - lastRunAt.pal > STALE_PROBE_MS, requiredHint: !partnerIdValid
                        ? "Enter a 6–10 digit Partner ID below to enable this probe."
                        : undefined, renderExtra: (r) => {
                        if (r.outcome !== "pass" || !r.data)
                            return null;
                        const data = r.data;
                        return (React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-2xs text-muted-foreground" },
                            React.createElement("span", null,
                                "Linked:",
                                " ",
                                React.createElement(CopyableText, { value: data.partnerId, mono: true, alwaysVisibleButton: true })),
                            data.createdTime && (React.createElement("span", { className: "opacity-80" },
                                "since ",
                                new Date(data.createdTime).toLocaleString()))));
                    } }))),
        React.createElement(Card, { className: "border-border bg-card shadow-sm" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold" },
                    React.createElement(Radar, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                    "Partner-relationships probes",
                    React.createElement(InfoTooltip, { content: "Defensive probes derived from the MSP-pivot corpus. They reveal how much downstream surface the operator's tenant carries via GDAP delegations, and whether subscriptions in this tenant are stamped with an unexpected (or no) partner-of-record." })),
                React.createElement(CardDescription, null,
                    "Catches the two MSP / GDAP / PAL drift signals that don't show up in the per-capability probes above. Cite:",
                    " ",
                    React.createElement("code", { className: "font-mono" }, "_bypass_tenant_switch.md"),
                    " ",
                    "\u00A76 (Lighthouse-GDAP, MSP supply-chain).")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-surface-base p-2.5" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Network, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
                        React.createElement("span", { className: "text-xs font-semibold text-foreground" }, "GDAP delegations (partner side)"),
                        React.createElement(InfoTooltip, { content: "Lists every customer tenant this tenant has a delegated-admin relationship with (active or terminated), and the directory roles delegated. Corpus: defenders rarely audit GDAP delegations because they're invisible in the customer's role list." }),
                        React.createElement(Badge, { variant: (gdapProbe === null || gdapProbe === void 0 ? void 0 : gdapProbe.outcome) === "pass"
                                ? ((_j = gdapProbe.data) === null || _j === void 0 ? void 0 : _j.creep)
                                    ? "warning"
                                    : "success"
                                : (gdapProbe === null || gdapProbe === void 0 ? void 0 : gdapProbe.outcome) === "unauthorized"
                                    ? "warning"
                                    : (gdapProbe === null || gdapProbe === void 0 ? void 0 : gdapProbe.outcome) === "fail" ||
                                        (gdapProbe === null || gdapProbe === void 0 ? void 0 : gdapProbe.outcome) === "unknown"
                                        ? "destructive"
                                        : "outline", className: "ml-auto text-2xs" }, gdapBusy ? (React.createElement("span", { className: "flex items-center gap-1" },
                            React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                            "Running")) : gdapProbe ? (gdapProbe.outcome === "pass"
                            ? ((_l = gdapProbe.data) === null || _l === void 0 ? void 0 : _l.creep)
                                ? "Creep"
                                : "Pass"
                            : outcomeBadge(gdapProbe.outcome).label) : ("Not run")),
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-6 px-2 text-2xs", onClick: () => void runGdapProbe(), loading: gdapBusy, disabled: !account, "aria-label": gdapProbe ? "Re-run GDAP probe" : "Run GDAP probe" }, gdapProbe ? "Re-run" : "Run")),
                    (gdapProbe === null || gdapProbe === void 0 ? void 0 : gdapProbe.outcome) === "pass" && gdapProbe.data && (React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement("div", { className: "grid grid-cols-2 gap-2 text-2xs sm:grid-cols-4" },
                            React.createElement("span", { className: "rounded border border-border/60 bg-card/40 px-2 py-1" },
                                React.createElement("span", { className: "block text-3xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Active"),
                                React.createElement("span", { className: "font-mono" }, gdapProbe.data.activeCount)),
                            React.createElement("span", { className: cn("rounded border border-border/60 bg-card/40 px-2 py-1", gdapProbe.data.highPrivActiveCount > 0 &&
                                    "border-destructive/40 bg-destructive/10") },
                                React.createElement("span", { className: "block text-3xs font-semibold uppercase tracking-wider text-muted-foreground" }, "High-priv active"),
                                React.createElement("span", { className: "font-mono" }, gdapProbe.data.highPrivActiveCount)),
                            React.createElement("span", { className: cn("rounded border border-border/60 bg-card/40 px-2 py-1", gdapProbe.data.expiringSoonCount > 0 &&
                                    "border-warning/40 bg-warning/10") },
                                React.createElement("span", { className: "block text-3xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Expiring <30d"),
                                React.createElement("span", { className: "font-mono" }, gdapProbe.data.expiringSoonCount)),
                            React.createElement("span", { className: "rounded border border-border/60 bg-card/40 px-2 py-1" },
                                React.createElement("span", { className: "block text-3xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Total"),
                                React.createElement("span", { className: "font-mono" }, gdapProbe.data.totalCount))),
                        gdapProbe.data.creep && (React.createElement(Alert, { variant: "warning", className: "text-2xs" },
                            React.createElement(AlertTriangle, { className: "h-3 w-3" }),
                            React.createElement(AlertDescription, null, "Delegation creep detected. This tenant holds delegated-admin authority over a large or privilege-heavy customer set \u2014 supply-chain risk if any operator account is compromised."))),
                        gdapProbe.data.sample.length > 0 && (React.createElement("details", { className: "text-2xs" },
                            React.createElement("summary", { className: "cursor-pointer select-none text-muted-foreground hover:text-foreground" },
                                "Show first ",
                                gdapProbe.data.sample.length,
                                " delegation",
                                gdapProbe.data.sample.length === 1 ? "" : "s"),
                            React.createElement("div", { className: "mt-1 flex flex-col gap-1" }, gdapProbe.data.sample.map((d) => (React.createElement("div", { key: d.id, className: cn("group/copy flex flex-wrap items-center gap-1.5 rounded border border-border/60 bg-card/40 px-2 py-1", d.highPriv && "border-destructive/40") },
                                React.createElement("span", { className: "font-semibold" }, d.customerDisplayName || d.displayName),
                                d.customerTenantId && (React.createElement(CopyableText, { value: d.customerTenantId, mono: true, display: React.createElement("code", { className: "font-mono" }, truncateMiddle(d.customerTenantId, 6, 4)), ariaLabel: `Copy customer tenant id ${d.customerTenantId}`, alwaysVisibleButton: true })),
                                React.createElement(Badge, { variant: d.status === "active" ? "outline" : "secondary", className: "text-3xs" }, d.status),
                                d.roleNames.length > 0 && (React.createElement("span", { className: "ml-auto text-3xs text-muted-foreground" },
                                    d.roleNames.slice(0, 3).join(", "),
                                    d.roleNames.length > 3 ? "…" : "")),
                                d.highPriv && (React.createElement(Badge, { variant: "destructive", className: "text-3xs" }, "Tier-0")))))))))),
                    gdapProbe &&
                        gdapProbe.outcome !== "pass" &&
                        gdapProbe.summary && (React.createElement("div", { className: "text-2xs text-muted-foreground" },
                        gdapProbe.summary,
                        gdapProbe.detail && (React.createElement("span", { className: "ml-1 opacity-70" },
                            "\u00B7 ",
                            gdapProbe.detail.slice(0, 160)))))),
                React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-surface-base p-2.5" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(Link2, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
                        React.createElement("span", { className: "text-xs font-semibold text-foreground" }, "Subscription PAL drift"),
                        React.createElement(InfoTooltip, { content: "Walks accessible subscriptions and checks the per-subscription Partner Admin Link stamp. Subscriptions whose PAL partnerId \u2260 the configured preferred MPN are surfaced as drift; no-PAL subs are surfaced as revenue-attribution gaps." }),
                        React.createElement(Badge, { variant: (palDriftProbe === null || palDriftProbe === void 0 ? void 0 : palDriftProbe.outcome) === "pass"
                                ? ((_m = palDriftProbe.data) === null || _m === void 0 ? void 0 : _m.mismatchCount) &&
                                    palDriftProbe.data.mismatchCount > 0
                                    ? "warning"
                                    : "success"
                                : (palDriftProbe === null || palDriftProbe === void 0 ? void 0 : palDriftProbe.outcome) === "unauthorized"
                                    ? "warning"
                                    : (palDriftProbe === null || palDriftProbe === void 0 ? void 0 : palDriftProbe.outcome) === "fail" ||
                                        (palDriftProbe === null || palDriftProbe === void 0 ? void 0 : palDriftProbe.outcome) === "unknown"
                                        ? "destructive"
                                        : "outline", className: "ml-auto text-2xs" }, palDriftBusy ? (React.createElement("span", { className: "flex items-center gap-1" },
                            React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                            "Running")) : palDriftProbe ? (outcomeBadge(palDriftProbe.outcome).label) : ("Not run")),
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-6 px-2 text-2xs", onClick: () => void runPalDriftProbe(), loading: palDriftBusy, disabled: !account, "aria-label": palDriftProbe
                                ? "Re-run PAL drift probe"
                                : "Run PAL drift probe" }, palDriftProbe ? "Re-run" : "Run")),
                    (palDriftProbe === null || palDriftProbe === void 0 ? void 0 : palDriftProbe.outcome) === "pass" && palDriftProbe.data && (React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement("div", { className: "grid grid-cols-3 gap-2 text-2xs" },
                            React.createElement("span", { className: "rounded border border-border/60 bg-card/40 px-2 py-1" },
                                React.createElement("span", { className: "block text-3xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Scanned"),
                                React.createElement("span", { className: "font-mono" }, palDriftProbe.data.totalSubscriptions)),
                            React.createElement("span", { className: cn("rounded border border-border/60 bg-card/40 px-2 py-1", palDriftProbe.data.mismatchCount > 0 &&
                                    "border-warning/40 bg-warning/10") },
                                React.createElement("span", { className: "block text-3xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Mismatched"),
                                React.createElement("span", { className: "font-mono" }, palDriftProbe.data.mismatchCount)),
                            React.createElement("span", { className: "rounded border border-border/60 bg-card/40 px-2 py-1" },
                                React.createElement("span", { className: "block text-3xs font-semibold uppercase tracking-wider text-muted-foreground" }, "No-PAL"),
                                React.createElement("span", { className: "font-mono" }, palDriftProbe.data.noPalCount))),
                        !trimmedPreferredMpn && (React.createElement("div", { className: "text-3xs text-muted-foreground" }, "Set a preferred MPN above to enable the mismatch check; without one only no-PAL subs are flagged.")),
                        palDriftProbe.data.rows.length > 0 && (React.createElement("details", { className: "text-2xs" },
                            React.createElement("summary", { className: "cursor-pointer select-none text-muted-foreground hover:text-foreground" },
                                "Show ",
                                palDriftProbe.data.rows.length,
                                " subscription",
                                palDriftProbe.data.rows.length === 1 ? "" : "s"),
                            React.createElement("div", { className: "mt-1 flex flex-col gap-1" }, palDriftProbe.data.rows
                                .filter((r) => showMismatchedOnly
                                ? r.mismatch
                                : true)
                                .map((r) => (React.createElement("div", { key: r.subscriptionId, className: cn("group/copy flex flex-wrap items-center gap-1.5 rounded border border-border/60 bg-card/40 px-2 py-1", r.mismatch && "border-warning/40", r.noPal && "border-destructive/30") },
                                React.createElement("span", { className: "font-semibold" }, r.displayName),
                                React.createElement(CopyableText, { value: r.subscriptionId, mono: true, display: React.createElement("code", { className: "font-mono" }, truncateMiddle(r.subscriptionId, 6, 4)), ariaLabel: `Copy subscription id ${r.subscriptionId}`, alwaysVisibleButton: true }),
                                React.createElement(Badge, { variant: "outline", className: "text-3xs" }, r.state),
                                r.palPartnerId ? (React.createElement("span", { className: "ml-auto inline-flex items-center gap-1 text-3xs text-muted-foreground" },
                                    "PAL:",
                                    " ",
                                    React.createElement(CopyableText, { value: r.palPartnerId, mono: true, alwaysVisibleButton: true }))) : (React.createElement("span", { className: "ml-auto text-3xs text-destructive" }, "no PAL")),
                                r.mismatch && (React.createElement(Badge, { variant: "warning", className: "text-3xs" }, "\u2260 preferred")))))))))),
                    palDriftProbe &&
                        palDriftProbe.outcome !== "pass" &&
                        palDriftProbe.summary && (React.createElement("div", { className: "text-2xs text-muted-foreground" },
                        palDriftProbe.summary,
                        palDriftProbe.detail && (React.createElement("span", { className: "ml-1 opacity-70" },
                            "\u00B7 ",
                            palDriftProbe.detail.slice(0, 160)))))))),
        ((_o = probes.csp) === null || _o === void 0 ? void 0 : _o.outcome) === "pass" &&
            ((_p = probes.csp.data) === null || _p === void 0 ? void 0 : _p.sample) &&
            (probes.csp.data.sample.length > 0) && (React.createElement(Card, { className: "border-border bg-card shadow-sm" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold" },
                    React.createElement(Users, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                    "CSP customer sweep",
                    React.createElement(InfoTooltip, { content: "Iterates the CSP customer sample one-by-one (rate-limited) and stamps each customer's last-probe time. The 60-day staleness panel flags customers in a dormant MSP relationship \u2014 the classic supply-chain pivot per _bypass_tenant_switch.md \u00A76.3." })),
                React.createElement(CardDescription, null, "Walks the CSP customer sample so the operator can audit relationship health without leaving the page. Stale (>60d unprobed) customers are flagged separately.")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: () => void runBulkCustomerProbe(), loading: bulkBusy, disabled: !account || bulkBusy, "aria-label": "Probe each CSP customer in sequence" },
                        React.createElement(Search, { className: "h-3.5 w-3.5" }),
                        "Probe all customers"),
                    bulkBusy && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: cancelBulkProbe, "aria-label": "Stop bulk customer probe" },
                        React.createElement(StopCircle, { className: "h-3.5 w-3.5" }),
                        "Stop")),
                    bulkTotal > 0 && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        bulkDone,
                        " / ",
                        bulkTotal,
                        bulkRows.length > 0 &&
                            ` · ${bulkRows.filter((r) => r.outcome === "pass").length} ok`))),
                bulkBusy && bulkTotal > 0 && (React.createElement(Progress, { value: Math.round((bulkDone / bulkTotal) * 100), "aria-label": "Bulk customer probe progress" })),
                bulkRows.length > 0 && (React.createElement(ExportMenu, { rows: bulkRows, columns: [
                        { header: "Customer ID", accessor: (r) => r.customerId },
                        {
                            header: "Company",
                            accessor: (r) => { var _a; return (_a = r.companyName) !== null && _a !== void 0 ? _a : ""; },
                        },
                        { header: "Domain", accessor: (r) => { var _a; return (_a = r.domain) !== null && _a !== void 0 ? _a : ""; } },
                        { header: "Outcome", accessor: (r) => r.outcome },
                        { header: "Error", accessor: (r) => { var _a; return (_a = r.error) !== null && _a !== void 0 ? _a : ""; } },
                    ], filename: "partner-center-customer-matrix", jsonMetadata: {
                        tenantId: (_r = (_q = getActiveTenantIdForSelected()) !== null && _q !== void 0 ? _q : account === null || account === void 0 ? void 0 : account.tenantId) !== null && _r !== void 0 ? _r : null,
                        preferredMpn: trimmedPreferredMpn || null,
                        scannedAt: new Date().toISOString(),
                    }, rowCount: bulkRows.length, label: "Export matrix" })),
                bulkRows.length > 0 && (React.createElement("details", { className: "text-2xs" },
                    React.createElement("summary", { className: "cursor-pointer select-none text-muted-foreground hover:text-foreground" },
                        "Show ",
                        bulkRows.length,
                        " customer",
                        bulkRows.length === 1 ? "" : "s"),
                    React.createElement("div", { className: "mt-1 flex flex-col gap-1" }, bulkRows.map((r) => (React.createElement("div", { key: r.customerId, className: cn("group/copy flex flex-wrap items-center gap-1.5 rounded border border-border/60 bg-card/40 px-2 py-1", r.outcome === "fail" && "border-destructive/30", r.outcome === "unauthorized" && "border-warning/40") },
                        React.createElement("span", { className: "font-semibold" }, r.companyName || "(unknown)"),
                        React.createElement(CopyableText, { value: r.customerId, mono: true, display: React.createElement("code", { className: "font-mono" }, truncateMiddle(r.customerId, 6, 4)), ariaLabel: `Copy customer id ${r.customerId}`, alwaysVisibleButton: true }),
                        r.domain && (React.createElement("span", { className: "text-3xs text-muted-foreground" }, r.domain)),
                        React.createElement(Badge, { variant: r.outcome === "pass"
                                ? "success"
                                : r.outcome === "unauthorized"
                                    ? "warning"
                                    : r.outcome === "fail"
                                        ? "destructive"
                                        : "outline", className: "ml-auto text-3xs" }, r.outcome),
                        r.error && (React.createElement("span", { className: "text-3xs text-destructive" }, r.error)))))))),
                staleCustomers.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-2xs" },
                    React.createElement("div", { className: "flex items-center gap-1.5 font-semibold text-warning" },
                        React.createElement(Clock, { className: "h-3 w-3", "aria-hidden": true }),
                        staleCustomers.length,
                        " customer",
                        staleCustomers.length === 1 ? " has" : "s have",
                        " not been probed in >60d"),
                    React.createElement("div", { className: "flex flex-wrap gap-1" },
                        staleCustomers.slice(0, 10).map((e) => (React.createElement("span", { key: e.id, className: "group/copy inline-flex items-center gap-1 rounded border border-warning/40 bg-card/40 px-1.5 py-0.5" },
                            React.createElement("code", { className: "font-mono" }, truncateMiddle(e.id, 6, 4)),
                            React.createElement(CopyButton, { value: e.id, ariaLabel: `Copy customer id ${e.id}` }),
                            React.createElement("span", { className: "text-3xs text-muted-foreground" }, e.lastProbedMs
                                ? new Date(e.lastProbedMs).toLocaleDateString()
                                : "never")))),
                        staleCustomers.length > 10 && (React.createElement("span", { className: "text-3xs text-muted-foreground" },
                            "+",
                            staleCustomers.length - 10,
                            " more")))))))),
        React.createElement(Card, { className: "border-border bg-card shadow-sm" },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm font-semibold" },
                    React.createElement(Link2, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                    "Partner Admin Link",
                    React.createElement(InfoTooltip, { content: "PAL associates an Azure account with a Microsoft partner (by Partner ID / MPN ID) so the partner gets credit for the customer's Azure consumption. Linking is per-account and idempotent." })),
                React.createElement(CardDescription, null, "Link / unlink the Partner ID for the selected account. PUT is idempotent \u2014 re-linking the same Partner ID has no effect. Both actions are confirmed and audited.")),
            React.createElement(CardContent, { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-col gap-1.5" },
                    React.createElement(Label, { htmlFor: "partner-id", className: "flex items-center gap-1 text-xs" },
                        "Partner ID (MPN ID, 6\u201310 digits)",
                        React.createElement(InfoTooltip, { content: "The numeric MPN / Partner ID issued to your partner organisation by Microsoft. You can read it from the MPN profile probe above, or look it up in Partner Center under Account settings \u2192 Identifiers." })),
                    React.createElement("div", { className: "group/copy flex items-center gap-1.5" },
                        React.createElement(Input, { id: "partner-id", ref: partnerIdInputRef, value: partnerId, onChange: (e) => handlePartnerIdChange(e.target.value), placeholder: "e.g. 1234567", inputMode: "numeric", autoComplete: "off", "aria-label": "Partner ID", "aria-invalid": partnerId.trim().length > 0 && !partnerIdValid
                                ? true
                                : undefined, className: cn("max-w-xs font-mono text-sm", partnerId.trim().length > 0 &&
                                !partnerIdValid &&
                                "border-destructive/60 focus-visible:ring-destructive") }),
                        partnerId.trim().length > 0 && (React.createElement(CopyButton, { value: partnerId.trim(), alwaysVisible: true, ariaLabel: `Copy Partner ID ${partnerId.trim()}` })),
                        React.createElement("span", { className: "text-3xs text-muted-foreground" },
                            "(",
                            modKeyLabel(),
                            "+L)")),
                    !partnerIdValid && partnerId.trim().length > 0 && (React.createElement("span", { className: "text-2xs text-destructive" }, "Partner ID must be 6\u201310 digits."))),
                React.createElement("div", { className: "flex flex-wrap gap-2" },
                    React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: () => setPendingLink(true), loading: linking, disabled: !account || !partnerIdValid || unlinking, "aria-label": "Link Partner ID to this account" },
                        !linking && React.createElement(Link2, { className: "h-3.5 w-3.5" }),
                        "Link Partner ID"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => setPendingUnlink(true), loading: unlinking, disabled: !account || !partnerIdValid || linking, "aria-label": "Unlink Partner ID from this account" },
                        !unlinking && React.createElement(Link2Off, { className: "h-3.5 w-3.5" }),
                        "Unlink"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", asChild: true },
                        React.createElement("a", { href: "https://partner.microsoft.com/dashboard", target: "_blank", rel: "noopener noreferrer", "aria-label": "Open Microsoft Partner Center dashboard in a new tab" },
                            React.createElement(ExternalLink, { className: "h-3.5 w-3.5" }),
                            "Open Partner Center"))),
                ((_s = probes.pal) === null || _s === void 0 ? void 0 : _s.outcome) === "pass" && probes.pal.data && (React.createElement(Alert, { variant: "success", className: "text-xs" },
                    React.createElement(CheckCircle2, { className: "h-3.5 w-3.5" }),
                    React.createElement(AlertDescription, null,
                        "Linked:",
                        " ",
                        React.createElement(CopyableText, { value: probes.pal.data.partnerId, mono: true, alwaysVisibleButton: true }),
                        probes.pal.data.createdTime && (React.createElement("span", { className: "ml-2 text-2xs text-muted-foreground" },
                            "since",
                            " ",
                            new Date(probes.pal.data.createdTime).toLocaleString()))))))),
        React.createElement(ConfirmationDialog, { hidden: !pendingLink, title: "Link Partner Admin?", message: React.createElement("span", null,
                "Link Partner ID",
                " ",
                React.createElement("strong", { className: "font-mono" }, partnerId.trim()),
                " to",
                " ",
                React.createElement("strong", null, (_t = account === null || account === void 0 ? void 0 : account.username) !== null && _t !== void 0 ? _t : "this account"),
                ". Azure consumption against this signed-in identity will be attributed to the partner of record. This action is idempotent and audited."), confirmText: "Link", loading: linking, onConfirm: () => void handleConfirmLink(), onCancel: () => setPendingLink(false) }),
        React.createElement(ConfirmationDialog, { hidden: !pendingUnlink, title: "Unlink Partner Admin?", message: React.createElement("span", null,
                "Remove the PAL linking Partner ID",
                " ",
                React.createElement("strong", { className: "font-mono" }, partnerId.trim()),
                " from",
                " ",
                React.createElement("strong", null, (_u = account === null || account === void 0 ? void 0 : account.username) !== null && _u !== void 0 ? _u : "this account"),
                ". Azure consumption will no longer be attributed to this partner."), confirmText: "Unlink", danger: true, loading: unlinking, onConfirm: () => void handleConfirmUnlink(), onCancel: () => setPendingUnlink(false) })));
};
const ProbeRow = ({ label, help, icon: Icon, result, loading, onRun, disabled, lastRunAt, requiredHint, stale = false, renderExtra, }) => {
    var _a;
    const badge = outcomeBadge(result === null || result === void 0 ? void 0 : result.outcome);
    const [showDetail, setShowDetail] = React.useState(false);
    const hasDetail = !!((result === null || result === void 0 ? void 0 : result.detail) || (result === null || result === void 0 ? void 0 : result.data) || (result === null || result === void 0 ? void 0 : result.code));
    // Tick once a minute so "Xs/Xm ago" stays fresh without a render
    // storm.
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
        if (!lastRunAt)
            return;
        const id = window.setInterval(() => setTick((n) => n + 1), 60000);
        return () => window.clearInterval(id);
    }, [lastRunAt]);
    return (React.createElement("div", { className: cn("flex flex-col gap-1.5 rounded-md border border-border bg-surface-base p-2.5", (result === null || result === void 0 ? void 0 : result.outcome) === "pass" && "border-success/40", (result === null || result === void 0 ? void 0 : result.outcome) === "unauthorized" && "border-warning/40", ((result === null || result === void 0 ? void 0 : result.outcome) === "fail" || (result === null || result === void 0 ? void 0 : result.outcome) === "unknown") &&
            "border-destructive/30") },
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement(Icon, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
            React.createElement("span", { className: "text-xs font-semibold text-foreground" }, label),
            React.createElement(InfoTooltip, { content: help }),
            lastRunAt && (React.createElement("span", { className: "text-3xs text-muted-foreground/80", title: new Date(lastRunAt).toLocaleString() },
                "ran ",
                formatRelative(lastRunAt))),
            stale && (React.createElement("span", { className: "inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-3xs font-medium text-warning", title: "Probe result is older than 24h \u2014 re-run for fresh data" },
                React.createElement(Clock, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                "Stale")),
            React.createElement(Badge, { variant: badge.variant, className: "ml-auto text-2xs" }, loading ? (React.createElement("span", { className: "flex items-center gap-1" },
                React.createElement(Loader2, { className: "h-3 w-3 animate-spin motion-reduce:animate-none" }),
                "Running")) : (badge.label)),
            React.createElement(Button, { type: "button", variant: "outline", size: "sm", className: "h-6 px-2 text-2xs", onClick: onRun, loading: loading, disabled: disabled, "aria-label": result ? `Re-run ${label} probe` : `Run ${label} probe`, title: result ? "Re-run probe" : "Run probe" }, result ? "Re-run" : "Run")),
        !result && disabled && requiredHint && (React.createElement("div", { className: "text-2xs text-muted-foreground/80" }, requiredHint)),
        result && (React.createElement("div", { className: "flex items-start gap-1.5 text-2xs text-muted-foreground" },
            result.outcome === "pass" ? (React.createElement(CheckCircle2, { className: "mt-0.5 h-3 w-3 shrink-0 text-success", "aria-hidden": true })) : result.outcome === "unauthorized" ? (React.createElement(ShieldAlert, { className: "mt-0.5 h-3 w-3 shrink-0 text-warning", "aria-hidden": true })) : (React.createElement(XCircle, { className: "mt-0.5 h-3 w-3 shrink-0 text-destructive", "aria-hidden": true })),
            React.createElement("span", { className: "min-w-0 break-words" },
                result.summary,
                result.status != null && (React.createElement("span", { className: "ml-1 opacity-70" },
                    "(HTTP ",
                    result.status,
                    ")")),
                result.code && (React.createElement("span", { className: "ml-1 opacity-70" },
                    "\u00B7 ",
                    React.createElement("code", { className: "font-mono" }, result.code)))))),
        result && renderExtra && renderExtra(result),
        result && hasDetail && (React.createElement("details", { open: showDetail, onToggle: (e) => setShowDetail(e.target.open), className: "text-2xs" },
            React.createElement("summary", { className: "cursor-pointer select-none text-muted-foreground hover:text-foreground" }, showDetail ? "Hide raw response" : "Show raw response"),
            React.createElement("pre", { className: "mt-1 max-h-48 overflow-auto rounded border border-border/60 bg-muted/30 p-1.5 font-mono text-[10px] text-foreground" }, safeStringify((_a = result.data) !== null && _a !== void 0 ? _a : { detail: result.detail, code: result.code })))),
        (result === null || result === void 0 ? void 0 : result.outcome) === "unauthorized" && (React.createElement(Alert, { variant: "warning", className: "text-2xs" },
            React.createElement(AlertTriangle, { className: "h-3 w-3" }),
            React.createElement(AlertDescription, null,
                "The signed-in account can't reach this endpoint. For Partner Center probes, the tenant typically isn't enrolled in CSP or MPN \u2014 sign in with a partner-tenant account, or pivot to",
                React.createElement("strong", null, " Token Importer"),
                " to paste a Partner Center token from another browser session.")))));
};
/**
 * Compact keyboard-shortcut hint pill rendered in the page header.
 * Hover for the full key list.
 */
const KeyboardHintBadge = () => {
    const mod = modKeyLabel();
    return (React.createElement(InfoTooltip, { ariaLabel: "Keyboard shortcuts", variant: "help", side: "bottom", align: "end", content: React.createElement("div", { className: "flex flex-col gap-1 text-xs" },
            React.createElement("p", { className: "m-0 font-semibold" }, "Keyboard shortcuts"),
            React.createElement("ul", { className: "m-0 list-none space-y-0.5 p-0" },
                React.createElement("li", null,
                    React.createElement("kbd", { className: "rounded border px-1 py-0.5 text-3xs" },
                        mod,
                        "+Enter"),
                    " ",
                    "Run all probes"),
                React.createElement("li", null,
                    React.createElement("kbd", { className: "rounded border px-1 py-0.5 text-3xs" },
                        mod,
                        "+Shift+R"),
                    " ",
                    "Retry failed probes"),
                React.createElement("li", null,
                    React.createElement("kbd", { className: "rounded border px-1 py-0.5 text-3xs" },
                        mod,
                        "+L"),
                    " ",
                    "Focus Partner ID input"),
                React.createElement("li", null,
                    React.createElement("kbd", { className: "rounded border px-1 py-0.5 text-3xs" }, "r"),
                    " ",
                    "Run / re-run probes (retry-failed first)"),
                React.createElement("li", null,
                    React.createElement("kbd", { className: "rounded border px-1 py-0.5 text-3xs" }, "/"),
                    " ",
                    "Focus Partner ID (search)"))), className: "h-7 w-7 rounded-md border border-border/60 bg-card/60 hover:bg-accent/30" }));
};
/* ─────────────────────────────────────────────────────────────────────
 * Local helpers
 * ───────────────────────────────────────────────────────────────────── */
/** Best-effort JSON.stringify that survives BigInt / circular refs. */
function safeStringify(value) {
    try {
        return JSON.stringify(value, null, 2);
    }
    catch (_a) {
        const seen = new WeakSet();
        return JSON.stringify(value, (_k, v) => {
            if (typeof v === "bigint")
                return v.toString();
            if (typeof v === "object" && v !== null) {
                if (seen.has(v))
                    return "[Circular]";
                seen.add(v);
            }
            return v;
        }, 2);
    }
}
/** "5s ago" / "3m ago" / "2h ago" — gives the probe row a freshness cue. */
function formatRelative(ms) {
    const delta = Date.now() - ms;
    if (delta < 0)
        return "just now";
    const s = Math.floor(delta / 1000);
    if (s < 5)
        return "just now";
    if (s < 60)
        return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}
//# sourceMappingURL=partner-center-page.js.map