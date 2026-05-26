import { __awaiter } from "tslib";
/**
 * Tricky Login — defensive admin flip of red-team cross-tenant token
 * tricks (ROADtools `roadtx`, AADInternals `Get-AADIntAccessTokenWith*`,
 * Stormspotter silent pivot).
 *
 * Legitimate use case:
 *   Tenant admins who are ALREADY signed in with account X want to mint a
 *   token for tenant Y (where X is a guest, partner, or B2B member)
 *   WITHOUT re-entering credentials, then optionally use the result as a
 *   "duplicate" account context they can switch between.
 *
 * Why this is NOT an offensive primitive: every operation here only
 * succeeds when the operator has already authenticated AND the target
 * tenant has granted them access. We never POP a credential prompt, we
 * never extract credentials from the browser keychain, and we never
 * touch the operator's PRT / device cert. The page is constrained to:
 *
 *   1. MSAL silent multi-tenant — `acquireTokenSilent` with the target
 *      tenant authority. Works for the operator's OWN session.
 *   2. FOCI refresh-token exchange — POST `grant_type=refresh_token` to
 *      `/{targetTenantId}/oauth2/v2.0/token` with a refresh token the
 *      operator already imported via the Token Importer page.
 *   3. Auto — try MSAL first, fall back to FOCI on InteractionRequired.
 *
 * Every mint goes to the audit log (`tricky_login_mint`); token material
 * is NEVER logged or audited.
 *
 * Files in this folder:
 *   - tricky-login-helpers.ts — pure helpers (this page imports them)
 *   - tricky-login-page.tsx   — THIS file
 *
 * The page deliberately consumes EXISTING auth / store / shared-UI APIs
 * and does not modify any service / auth / store / page-router / sidebar-
 * nav file (per the spec's hard constraints).
 */
import * as React from "react";
import { AlertTriangle, Award, BookOpen, Braces, CheckCircle2, ChevronDown, ClipboardCopy, Clock, Eye, EyeOff, ExternalLink, FileText, Globe, Info, KeyRound, Loader2, Lock, Maximize2, Minimize2, RefreshCcw, Repeat2, Shield, ShieldAlert, ShieldCheck, Sparkles, Star, Trash2, Users, Wand2, XCircle, Zap, } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger, } from "@/components/ui/tabs";
import { cn, formatDateTime, formatRelativeTime } from "@/lib/utils";
import { decodeJwtClaimsUnsafe, getArmTokenForAccount, getBatchTokenForAccount, getGraphTokenForAccount, listAccessibleTenants, loginAccount, } from "../../auth/msal-auth";
import { useArmToken } from "../../auth/use-arm-token";
import { exchangeRefreshTokenForClient, getFociClientByAppId, } from "../../auth/foci-exchange";
import { classifyAudience, getRefreshTokenEntry, importRefreshToken, importToken, previewToken, } from "../../auth/imported-tokens";
import { performTenantSwitch } from "../../auth/perform-tenant-switch";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { useDashboardOutletContext } from "../page-router";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { AUDIENCE_CHOICES, audienceForScope, BATCH_MINT_AUDIENCES, CLAIM_EXPLAIN, detectMethodAvailability, extendedAudienceForScope, extractAadErrorCode, findTenantLabel, fmtDuration, formatExpiresIn, getAudienceChoice, HISTORY_MAX_ENTRIES, loadHistory, maskToken, methodLabel, methodShortLabel, saveHistory, toHistoryRow, TOKEN_IMPORTER_SESSION_KEY, } from "./tricky-login-helpers";
import { SpLoginTab } from "./sp-login-tab";
import { computeOperatorAdvisories, } from "./corpus-advisories";
import { FlowEducationWizard } from "./flow-education-wizard";
/* ---------------------------------------------------------------------- */
/* Small render helpers — kept inline (no JSX dependency to surface).      */
/* ---------------------------------------------------------------------- */
/** Map an audience choice to a badge variant for the radio chip. */
function audienceChipAccent(id) {
    switch (id) {
        case "arm":
            return { badge: "info" };
        case "graph":
            return { badge: "default" };
        case "batch":
            return { badge: "warning" };
        case "vault":
        case "keyvault":
            return { badge: "warning" };
        case "storage":
            return { badge: "info" };
        case "intune":
        case "monitor":
            return { badge: "secondary" };
        case "substrate":
        case "powerbi":
        case "yammer":
            return { badge: "default" };
        case "devops":
            return { badge: "info" };
        case "custom":
            return { badge: "outline" };
        default:
            return { badge: "secondary" };
    }
}
/** Format a JWT claim value for the per-claim row in the result panel. */
function formatClaimValue(name, value) {
    if (value == null)
        return "(null)";
    if (typeof value === "string")
        return value;
    if (typeof value === "number") {
        if (name === "iat" || name === "nbf" || name === "exp") {
            try {
                const iso = new Date(value * 1000).toISOString();
                return `${value} (${iso})`;
            }
            catch (_a) {
                return String(value);
            }
        }
        return String(value);
    }
    if (typeof value === "boolean")
        return value ? "true" : "false";
    try {
        return JSON.stringify(value);
    }
    catch (_b) {
        return String(value);
    }
}
/* ---------------------------------------------------------------------- */
/* Page component                                                         */
/* ---------------------------------------------------------------------- */
export const TrickyLoginPage = () => {
    var _a, _b, _c, _d, _e, _f, _g;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    // Canonical wiring contract: path-based navigation via the outlet context's
    // navigateToPage. Avoids importing react-router-dom directly from a page.
    const { navigateToPage } = useDashboardOutletContext();
    /* --- Mount lifecycle: every async path checks this so we don't
     * setState-after-unmount when an operator navigates away mid-mint. */
    const mountedRef = React.useRef(true);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    /* ----------------------------------------------------------------
     * A. Source account + target tenant pickers
     * ---------------------------------------------------------------- */
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    // Default source account = first signed-in account (most operators have one).
    const [sourceAccountId, setSourceAccountId] = React.useState(() => { var _a, _b; return (_b = (_a = azureAccounts[0]) === null || _a === void 0 ? void 0 : _a.homeAccountId) !== null && _b !== void 0 ? _b : ""; });
    // Keep selection synced if the account list shrinks (e.g. operator signs
    // out the selected account on Azure Accounts).
    React.useEffect(() => {
        var _a, _b;
        if (sourceAccountId &&
            !azureAccounts.some((a) => a.homeAccountId === sourceAccountId)) {
            setSourceAccountId((_b = (_a = azureAccounts[0]) === null || _a === void 0 ? void 0 : _a.homeAccountId) !== null && _b !== void 0 ? _b : "");
        }
    }, [azureAccounts, sourceAccountId]);
    const sourceAccount = React.useMemo(() => azureAccounts.find((a) => a.homeAccountId === sourceAccountId), [azureAccounts, sourceAccountId]);
    // Lazy tenant fetch — the spec wants us to read account.tenants if
    // already populated, else fetch on demand. We mirror the same in-flight
    // ref pattern the Azure Accounts page uses so a re-render doesn't fire
    // duplicate fetches.
    const [lazyTenants, setLazyTenants] = React.useState(null);
    const [tenantsLoading, setTenantsLoading] = React.useState(false);
    const [tenantsError, setTenantsError] = React.useState(null);
    const tenantsInFlightRef = React.useRef(null);
    React.useEffect(() => {
        // Reset lazy state when the source account changes — what was lazy-
        // loaded for account A doesn't apply to account B.
        setLazyTenants(null);
        setTenantsError(null);
    }, [sourceAccountId]);
    const fetchTenants = React.useCallback((homeAccountId) => __awaiter(void 0, void 0, void 0, function* () {
        if (!homeAccountId)
            return;
        if (tenantsInFlightRef.current === homeAccountId)
            return;
        tenantsInFlightRef.current = homeAccountId;
        setTenantsLoading(true);
        setTenantsError(null);
        try {
            const list = yield listAccessibleTenants(homeAccountId);
            if (!mountedRef.current)
                return;
            if (tenantsInFlightRef.current !== homeAccountId)
                return;
            setLazyTenants(list);
        }
        catch (err) {
            if (!mountedRef.current)
                return;
            const msg = err instanceof Error ? err.message : String(err);
            setTenantsError(msg);
        }
        finally {
            if (tenantsInFlightRef.current === homeAccountId) {
                tenantsInFlightRef.current = null;
            }
            if (mountedRef.current)
                setTenantsLoading(false);
        }
    }), []);
    // Tenant choices come from account.tenants if already populated,
    // otherwise the lazy fetch state. We never modify account.tenants from
    // here — that's owned by Azure Accounts.
    const tenantChoices = React.useMemo(() => {
        var _a;
        const fromAccount = (_a = sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.tenants) !== null && _a !== void 0 ? _a : [];
        if (fromAccount.length > 0)
            return fromAccount;
        return lazyTenants !== null && lazyTenants !== void 0 ? lazyTenants : [];
    }, [sourceAccount, lazyTenants]);
    // Default target tenant: first tenant that ISN'T the active one.
    const activeTenantId = (_c = (_b = sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.activeTenantId) !== null && _b !== void 0 ? _b : sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.tenantId) !== null && _c !== void 0 ? _c : undefined;
    const [targetTenantId, setTargetTenantId] = React.useState("");
    // When the tenant choices change, reset to the first non-active option.
    React.useEffect(() => {
        if (!tenantChoices.length) {
            setTargetTenantId("");
            return;
        }
        setTargetTenantId((prev) => {
            var _a, _b, _c;
            const stillValid = tenantChoices.some((t) => { var _a; return ((_a = t.tenantId) !== null && _a !== void 0 ? _a : "").toLowerCase() === prev.toLowerCase(); });
            if (stillValid)
                return prev;
            const firstNonActive = tenantChoices.find((t) => {
                var _a;
                return !activeTenantId ||
                    ((_a = t.tenantId) !== null && _a !== void 0 ? _a : "").toLowerCase() !== activeTenantId.toLowerCase();
            });
            return (_c = (_a = firstNonActive === null || firstNonActive === void 0 ? void 0 : firstNonActive.tenantId) !== null && _a !== void 0 ? _a : (_b = tenantChoices[0]) === null || _b === void 0 ? void 0 : _b.tenantId) !== null && _c !== void 0 ? _c : "";
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantChoices, activeTenantId]);
    /* ----------------------------------------------------------------
     * B. Method selector + tricks discovery
     * ---------------------------------------------------------------- */
    const [method, setMethod] = React.useState("auto");
    const RECENT_METHODS_CAP = 8;
    const SAVED_TENANTS_CAP = 16;
    // Compile-time guard against accidental token capture. The shape uses
    // string keys defined above; this regex screens for JWT-like 3-segment
    // base64url strings >120 chars (a real AAD token is always >>120).
    const looksLikeJwt = React.useCallback((v) => typeof v === "string" &&
        v.length > 120 &&
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v), []);
    const [recentMethods, setRecentMethods] = usePersistedState("tricky-login:recent-methods:v1", [], {
        version: 1,
        deserialize: (raw) => {
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed))
                    return [];
                // Defensive filter — drop any row that smuggled in token-like data.
                return parsed.filter((r) => !!r &&
                    typeof r === "object" &&
                    typeof r.method === "string" &&
                    typeof r.accountHint === "string" &&
                    !looksLikeJwt(r.accountHint) &&
                    typeof r.audience === "string" &&
                    !looksLikeJwt(r.audience) &&
                    typeof r.lastUsedAt === "string" &&
                    typeof r.useCount === "number");
            }
            catch (_a) {
                return [];
            }
        },
    });
    const [savedTenants, setSavedTenants] = usePersistedState("tricky-login:saved-tenants:v1", [], {
        version: 1,
        deserialize: (raw) => {
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed))
                    return [];
                return parsed.filter((r) => !!r &&
                    typeof r === "object" &&
                    typeof r.tenantId === "string" &&
                    !looksLikeJwt(r.tenantId) &&
                    typeof r.label === "string" &&
                    !looksLikeJwt(r.label) &&
                    typeof r.addedAt === "string");
            }
            catch (_a) {
                return [];
            }
        },
    });
    /** Note a (method, audience, accountHint) tuple so it shows up in recents. */
    const rememberMethod = React.useCallback((methodUsed, audience, accountHint) => {
        // Defense-in-depth: refuse to remember anything that looks like a JWT.
        if (looksLikeJwt(accountHint) || looksLikeJwt(audience))
            return;
        setRecentMethods((prev) => {
            const key = `${methodUsed}|${audience}|${accountHint}`;
            const existing = prev.find((r) => `${r.method}|${r.audience}|${r.accountHint}` === key);
            const next = existing
                ? Object.assign(Object.assign({}, existing), { lastUsedAt: new Date().toISOString(), useCount: existing.useCount + 1 }) : {
                method: methodUsed,
                audience,
                accountHint,
                lastUsedAt: new Date().toISOString(),
                useCount: 1,
            };
            const remaining = prev.filter((r) => `${r.method}|${r.audience}|${r.accountHint}` !== key);
            return [next, ...remaining].slice(0, RECENT_METHODS_CAP);
        });
    }, [looksLikeJwt, setRecentMethods]);
    /** Save the current target tenant to the shortcuts list. */
    const handleSaveTenantShortcut = React.useCallback(() => {
        if (!targetTenantId)
            return;
        const label = findTenantLabel(tenantChoices, targetTenantId);
        if (looksLikeJwt(targetTenantId) || looksLikeJwt(label))
            return;
        setSavedTenants((prev) => {
            const exists = prev.some((s) => s.tenantId.toLowerCase() === targetTenantId.toLowerCase());
            if (exists)
                return prev;
            const next = {
                tenantId: targetTenantId.toLowerCase(),
                label,
                addedAt: new Date().toISOString(),
            };
            return [next, ...prev].slice(0, SAVED_TENANTS_CAP);
        });
        store.addNotification({
            type: "success",
            message: `Saved tenant ${label} to shortcuts.`,
        });
    }, [
        targetTenantId,
        tenantChoices,
        setSavedTenants,
        store,
        looksLikeJwt,
    ]);
    /** Remove a saved tenant shortcut. */
    const handleRemoveTenantShortcut = React.useCallback((tid) => {
        setSavedTenants((prev) => prev.filter((s) => s.tenantId.toLowerCase() !== tid.toLowerCase()));
    }, [setSavedTenants]);
    /** Activate a saved tenant shortcut — sets it as the target picker value. */
    const handleApplyTenantShortcut = React.useCallback((tid) => {
        setTargetTenantId(tid);
    }, []);
    /** Clear all recent methods (NOT the history table — that's separate). */
    const handleClearRecentMethods = React.useCallback(() => {
        setRecentMethods([]);
    }, [setRecentMethods]);
    // Imported RT lookup for the FOCI path. We expose its originating client
    // label in the discovery row so the operator knows which RT we'd spend.
    const importedRt = React.useMemo(() => {
        if (!sourceAccountId)
            return null;
        return getRefreshTokenEntry(sourceAccountId);
    }, [sourceAccountId]);
    const importedRtClient = React.useMemo(() => {
        var _a;
        if (!importedRt)
            return undefined;
        const c = getFociClientByAppId(importedRt.clientId);
        return (_a = c === null || c === void 0 ? void 0 : c.name) !== null && _a !== void 0 ? _a : importedRt.clientId;
    }, [importedRt]);
    const availability = React.useMemo(() => detectMethodAvailability({
        accountTenants: tenantChoices,
        activeTenantId,
        targetTenantId,
        hasImportedRefreshToken: !!importedRt,
        importedRefreshTokenClientLabel: importedRtClient,
    }), [
        tenantChoices,
        activeTenantId,
        targetTenantId,
        importedRt,
        importedRtClient,
    ]);
    /* ----------------------------------------------------------------
     * C. Audience picker
     * ---------------------------------------------------------------- */
    const [audienceId, setAudienceId] = React.useState("arm");
    const [customScope, setCustomScope] = React.useState("https://management.azure.com/.default");
    /* ----------------------------------------------------------------
     * D. Mint action state
     * ---------------------------------------------------------------- */
    const [minting, setMinting] = React.useState(false);
    const [mintSubStep, setMintSubStep] = React.useState(null);
    const [result, setResult] = React.useState(null);
    // For Auto mode we also surface BOTH attempts so the operator can see
    // why MSAL silent rejected if FOCI ended up serving the request.
    const [autoAttempts, setAutoAttempts] = React.useState([]);
    // Reveal/copy state for the token panel.
    const [tokenRevealed, setTokenRevealed] = React.useState(false);
    const [rtRevealed, setRtRevealed] = React.useState(false);
    /**
     * Auto-activate toggle. When ON (default), every successful mint
     * fires `handleImportToVault` + `handleSetActive` automatically so
     * the new context becomes the operator's live ARM/Graph/Batch
     * identity across every page in the app:
     *
     *   1. Import to vault → next `getArmTokenForAccount(synthetic-id,
     *      tenantId)` call short-circuits to the cached token.
     *   2. Set as active → `performTenantSwitch` writes MSAL + store +
     *      fires TENANT_CHANGED_EVENT → every page using `useArmToken`
     *      re-mints, every page with `useTenantChange` re-fetches.
     *
     * Operator turns this OFF when batch-minting (e.g. ARM + Graph +
     * Batch for the same target) — they want all three tokens in the
     * vault but only ONE active-tenant switch at the end. Persisted in
     * sessionStorage so the choice carries across page reloads.
     */
    // usePersistedState pins this preference across reloads. The value is a
    // boolean flag — NEVER token material — so localStorage persistence is
    // safe (verified: no code path here writes a token to this key).
    const [autoActivateOnSuccess, setAutoActivateOnSuccess] = usePersistedState("tricky-login:auto-activate", true, { version: 1 });
    /* ----------------------------------------------------------------
     * D.2. Compact view toggle (persisted)
     *
     * Operators on smaller laptops (or those triaging multiple Tricky
     * Login mints back-to-back) asked for a denser layout that hides
     * the "About this page" footer, collapses the long claims table to
     * a single-line summary, and tightens the result-panel padding.
     *
     * Boolean only — safe to persist to localStorage. Verified: no
     * code path reads or writes token material to this key.
     * ---------------------------------------------------------------- */
    const [compactView, setCompactView] = usePersistedState("tricky-login:compact-view:v1", false, { version: 1 });
    /* ----------------------------------------------------------------
     * D.3. JSON-preview reveal toggle (NOT persisted)
     *
     * When ON, the claims block in the result panel renders a
     * pretty-printed JSON preview alongside the human-readable table.
     * The JSON value is built from `result.claims` after a defensive
     * JWT-shape screen — any claim value that LOOKS like a JWT is
     * replaced with `<jwt-redacted>` so a malformed claims map can't
     * accidentally render a token. NOT persisted — operators choose
     * per-mint whether they want the raw JSON.
     * ---------------------------------------------------------------- */
    const [showClaimsJson, setShowClaimsJson] = React.useState(false);
    /* ----------------------------------------------------------------
     * D.4. Flow-education wizard open state (NOT persisted)
     * ---------------------------------------------------------------- */
    const [wizardOpen, setWizardOpen] = React.useState(false);
    /* ----------------------------------------------------------------
     * D.5. ARIA-live announcement region (NOT persisted)
     *
     * A small string that screen readers announce on auth-state
     * transitions: minting start, success, failure, advisory surfaced,
     * realm probe complete. Plain-text only — NEVER token material.
     * Stored as state so updates trigger an aria-live re-announce.
     * ---------------------------------------------------------------- */
    const [ariaAnnouncement, setAriaAnnouncement] = React.useState("");
    // Setter helper that also clears after a short delay so repeated
    // identical announcements still re-fire (some screen readers
    // de-dupe back-to-back identical aria-live updates).
    const announcePolite = React.useCallback((msg) => {
        setAriaAnnouncement(msg);
        // Clear after 4s so repeated identical events still announce.
        window.setTimeout(() => {
            setAriaAnnouncement((prev) => (prev === msg ? "" : prev));
        }, 4000);
    }, []);
    /* ----------------------------------------------------------------
     * E. History (session-scoped, capped at 20)
     * ---------------------------------------------------------------- */
    const [history, setHistory] = React.useState(() => loadHistory());
    // Persist whenever it changes.
    React.useEffect(() => {
        saveHistory(history);
    }, [history]);
    const pushHistory = React.useCallback((row) => {
        setHistory((prev) => [row, ...prev].slice(0, HISTORY_MAX_ENTRIES));
    }, []);
    const realmCacheRef = React.useRef(new Map());
    const [realmProbe, setRealmProbe] = React.useState(null);
    const [realmLoading, setRealmLoading] = React.useState(false);
    const [realmError, setRealmError] = React.useState(null);
    // Operator-side cancel controller — bound to the currently-in-flight
    // probe so Esc can abort it. Distinct from the useAbortableEffect's
    // internal signal (which aborts on unmount / dep-change only). The
    // ref holds the controller so the Esc hotkey handler below can call
    // .abort() without re-rendering.
    const realmProbeAbortRef = React.useRef(null);
    // useAbortableEffect: the realm-discovery fetch gets a signal tied to
    // the effect's lifetime. Unmount or dep-change aborts the in-flight
    // request so the response never updates a stale component.
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
        var _h, _j;
        setRealmProbe(null);
        setRealmError(null);
        setRealmLoading(false);
        if (!sourceAccount || !targetTenantId)
            return;
        const upn = sourceAccount.username;
        if (!upn || !upn.includes("@"))
            return;
        const cacheKey = upn.toLowerCase();
        const cached = realmCacheRef.current.get(cacheKey);
        if (cached) {
            setRealmProbe(cached);
            return;
        }
        setRealmLoading(true);
        // Combine the effect's auto-signal with an operator-controlled
        // controller so Esc can abort an in-flight probe. We pass the
        // local controller's signal to fetch and listen on the parent
        // signal to forward unmount/dep-change cancellations.
        const localCtrl = new AbortController();
        realmProbeAbortRef.current = localCtrl;
        const onParentAbort = () => {
            try {
                localCtrl.abort();
            }
            catch (_a) {
                /* no-op */
            }
        };
        signal.addEventListener("abort", onParentAbort, { once: true });
        const url = `https://login.microsoftonline.com/getuserrealm.srf?login=${encodeURIComponent(upn)}&xml=1`;
        try {
            // Cheap CORS-permissive endpoint. Passing the abort signal means
            // unmount / dep change cancels the fetch (no more orphan promise
            // landing in setRealmProbe after the page is gone). Esc-cancel
            // is forwarded via localCtrl above.
            const resp = yield fetch(url, {
                method: "GET",
                credentials: "omit",
                signal: localCtrl.signal,
            });
            if (signal.aborted || localCtrl.signal.aborted)
                return;
            if (!resp.ok)
                throw new Error(`HTTP ${resp.status}`);
            const xml = yield resp.text();
            if (signal.aborted || localCtrl.signal.aborted)
                return;
            // Tag-extraction via regex — DOMParser would be cleaner but the
            // realm-discovery XML is tiny, well-formed, and we only need a
            // handful of leaf elements. Keeping it regex-based avoids
            // shipping a DOMParser dependency into the page module.
            const tag = (name) => {
                const m = new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(xml);
                return m ? m[1].trim() : undefined;
            };
            const nsType = ((_h = tag("NameSpaceType")) !== null && _h !== void 0 ? _h : "").toLowerCase();
            const result = {
                status: nsType === "managed"
                    ? "managed"
                    : nsType === "federated"
                        ? "federated"
                        : "unknown",
                stsUrl: (_j = tag("STSAuthURL")) !== null && _j !== void 0 ? _j : tag("AuthURL"),
                federationProtocol: tag("FederationProtocol"),
                authUrl: tag("AuthURL"),
                domainName: tag("DomainName"),
            };
            realmCacheRef.current.set(cacheKey, result);
            if (signal.aborted ||
                localCtrl.signal.aborted ||
                !mountedRef.current) {
                return;
            }
            setRealmProbe(result);
            setRealmLoading(false);
            // ARIA-live announce realm completion. Plain status text only.
            announcePolite(`Federation realm probe complete: ${result.status}${result.domainName ? ` for domain ${result.domainName}` : ""}.`);
        }
        catch (err) {
            // AbortError is the planned outcome of an unmount/dep-change
            // OR an operator-triggered Esc cancel. Swallow silently in
            // both cases; the Esc handler announces the cancellation
            // separately.
            if ((err === null || err === void 0 ? void 0 : err.name) === "AbortError" ||
                signal.aborted ||
                localCtrl.signal.aborted) {
                return;
            }
            if (!mountedRef.current)
                return;
            setRealmError(err instanceof Error ? err.message : String(err));
            setRealmLoading(false);
        }
        finally {
            // Clear the operator-controlled ref if it still points at THIS
            // controller — a newer effect run may have replaced it already.
            if (realmProbeAbortRef.current === localCtrl) {
                realmProbeAbortRef.current = null;
            }
            signal.removeEventListener("abort", onParentAbort);
        }
    }), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.username, targetTenantId]);
    /* ----------------------------------------------------------------
     * Token tracker for the page header — driven by the source account.
     * Matches the pattern used by every other tenant-aware page.
     * ---------------------------------------------------------------- */
    const tokenState = useArmToken(sourceAccountId || undefined, activeTenantId);
    /* ----------------------------------------------------------------
     * Mint actions
     * ---------------------------------------------------------------- */
    /**
     * MSAL silent multi-tenant: the bread-and-butter `acquireTokenSilent`
     * with `authority=https://login.microsoftonline.com/{targetTenantId}`.
     * Routes through audience-aware getters so imported access tokens for
     * the same (account, audience) pair short-circuit naturally — same as
     * every other ARM/Graph/Batch read in the app.
     */
    function mintViaMsalSilent(homeAccountId, targetTid, audience, scope, 
    /**
     * Extended audience id (12 + custom) — only used to construct a more
     * specific error message when the audience is one of the new ones
     * (vault, storage, intune, substrate, monitor, powerbi, yammer,
     * devops) and the MSAL helpers can't service it.
     */
    extended) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            setMintSubStep(`Calling MSAL acquireTokenSilent for ${targetTid.slice(0, 8)}… (forceRefresh)`);
            let token;
            // forceRefresh: true is REQUIRED for cross-tenant Tricky Login
            // mints. Without it, MSAL's silent cache may return a cached
            // home-tenant token whose scopes match, ignoring the authority
            // we just specified — producing a token with the WRONG tid.
            // This is the most common cause of "I asked for tenant X but
            // got a token for tenant Y" reports.
            const opts = { forceRefresh: true };
            if (audience === "graph") {
                token = yield getGraphTokenForAccount(homeAccountId, targetTid, opts);
            }
            else if (audience === "batch") {
                token = yield getBatchTokenForAccount(homeAccountId, targetTid, opts);
            }
            else if (audience === "arm") {
                token = yield getArmTokenForAccount(homeAccountId, targetTid, opts);
            }
            else {
                // For the extended audiences (vault / storage / intune / substrate
                // / monitor / powerbi / yammer / devops) and any custom scope, the
                // MSAL silent helpers don't expose a generic acquire — adding one
                // would cross the "no service-layer edits" line of this task. We
                // surface a specific hint pointing the operator at the FOCI
                // exchange method, which IS audience-agnostic.
                const hint = extended && extended !== "custom"
                    ? `MSAL silent doesn't support the ${extended.toUpperCase()} audience here — only ARM / Graph / Batch are wired through the silent helpers. ` +
                        `Switch the method to "FOCI exchange" (this audience is natively serviceable that way) or pick ARM / Graph / Batch instead.`
                    : `Custom scope "${scope}" is not supported via MSAL silent — pick ARM / Graph / Batch or use the FOCI exchange path.`;
                throw new Error(hint);
            }
            // Post-mint tid validation. Defense in depth — even with
            // forceRefresh, MSAL has been observed returning a home-tenant
            // token in edge cases (login-mode mismatch, broker quirks, etc.).
            // If the returned tid doesn't match what we requested, throw —
            // the Auto-mode fallback will then try FOCI exchange which uses a
            // raw HTTP POST and is guaranteed to mint for the right tenant.
            const claims = (_a = decodeJwtClaimsUnsafe(token)) !== null && _a !== void 0 ? _a : {};
            const actualTid = typeof claims.tid === "string" ? claims.tid : null;
            if (actualTid && actualTid.toLowerCase() !== targetTid.toLowerCase()) {
                throw new Error(`MSAL returned a token for the WRONG tenant — got tid=${actualTid} but requested ${targetTid}. ` +
                    `This typically happens when MSAL's silent cache returns a cached token whose authority differs ` +
                    `from the requested one. Use the FOCI Exchange method instead — it's a raw /oauth2/v2.0/token POST ` +
                    `against the target tenant's authority and is guaranteed to mint for the requested tid.`);
            }
            return { accessToken: token };
        });
    }
    /**
     * FOCI refresh-token exchange: POST `grant_type=refresh_token` to the
     * target tenant's /oauth2/v2.0/token with the operator's imported RT
     * and the target FOCI client id. AAD honours the swap because both
     * source + target are family-of-client-ids members.
     *
     * Pre-flight checks:
     *   1. An imported RT exists for the source account.
     *   2. The RT's originating client id is FOCI-eligible.
     */
    function mintViaFociExchange(homeAccountId, targetTid, audience, scope) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            const rt = getRefreshTokenEntry(homeAccountId);
            if (!rt) {
                throw new Error("FOCI exchange unavailable: no imported refresh token for this account. Paste one on the Import Token page first.");
            }
            // Detect the FOCI client behind the imported RT. detectFociEligibility
            // expects decoded claims — for an RT we don't have those, so we look
            // the client id up directly.
            const sourceClient = getFociClientByAppId(rt.clientId);
            if (!sourceClient) {
                throw new Error(`FOCI exchange unavailable: imported RT was issued to client ${rt.clientId}, which is not in our curated FOCI list.`);
            }
            setMintSubStep(`POST /${targetTid}/oauth2/v2.0/token (FOCI: ${sourceClient.name} → ${audience.toUpperCase()})…`);
            // Default to the source-client id as the TARGET — operators usually
            // want to keep the same client persona on the new tenant. They can
            // pick a different target via the Token Importer FOCI panel.
            const targetClientId = rt.clientId;
            const exchange = yield exchangeRefreshTokenForClient({
                refreshToken: rt.refreshToken,
                targetClientId,
                tenantId: targetTid,
                scope,
            });
            // If AAD rotated the RT, persist the new one — keeps subsequent
            // tricky-login mints from invalidating each other.
            if (exchange.refresh_token && exchange.refresh_token !== rt.refreshToken) {
                importRefreshToken({
                    homeAccountId: rt.homeAccountId,
                    tenantId: rt.tenantId,
                    oid: rt.oid,
                    upn: rt.upn,
                    name: rt.name,
                    clientId: rt.clientId,
                    refreshToken: exchange.refresh_token,
                });
            }
            // Defense-in-depth tid check. The FOCI exchange URL contains
            // targetTid so AAD MUST mint for it, but operators have reported
            // edge cases with B2B guest principals where AAD returns a home-
            // tenant token anyway. Throwing here lets Auto mode surface the
            // condition + log it for diagnostics.
            const claims = (_a = decodeJwtClaimsUnsafe(exchange.access_token)) !== null && _a !== void 0 ? _a : {};
            const actualTid = typeof claims.tid === "string" ? claims.tid : null;
            if (actualTid && actualTid.toLowerCase() !== targetTid.toLowerCase()) {
                throw new Error(`FOCI exchange returned a token for the WRONG tenant — got tid=${actualTid} but requested ${targetTid}. ` +
                    `This typically means the source RT was minted for a B2B guest principal whose home directory ` +
                    `is being preferred by AAD's tenant resolver. Try minting directly from an account that's a NATIVE ` +
                    `member of the target tenant.`);
            }
            return {
                accessToken: exchange.access_token,
                refreshToken: exchange.refresh_token,
                raw: exchange,
            };
        });
    }
    /**
     * Top-level mint orchestrator. Picks the right concrete mint based on
     * `method` (or Auto's MSAL → FOCI sequence) and assembles a
     * `TrickyLoginMintResult` either way. Writes the audit log AFTER the
     * mint has resolved so audit shape lines up with success/failure.
     */
    const doMint = React.useCallback((overrideMethod, fromReplay = false, 
    // Audience override for batch-mint loops. When omitted, uses
    // the current `audienceId` state. Pass `{ audience }` to mint a
    // specific audience without forcing the operator to re-select.
    overrideAudience) => __awaiter(void 0, void 0, void 0, function* () {
        var _k;
        if (!sourceAccount || !targetTenantId)
            return;
        const startedAt = performance.now();
        setMinting(true);
        setMintSubStep("Preparing mint…");
        setResult(null);
        setTokenRevealed(false);
        setRtRevealed(false);
        setAutoAttempts([]);
        // ARIA-live announce mint start — plain text, no token material.
        announcePolite(`Minting token via ${overrideMethod !== null && overrideMethod !== void 0 ? overrideMethod : method} for ${findTenantLabel(tenantChoices, targetTenantId)}…`);
        // Recompute audience + scope locally — when overrideAudience is
        // supplied we ignore the `audienceId` state value entirely
        // (this is the batch-mint path; ignoring state lets us run the
        // loop sequentially without waiting for re-renders).
        const localAudienceId = overrideAudience !== null && overrideAudience !== void 0 ? overrideAudience : audienceId;
        const localActiveScope = localAudienceId === "custom"
            ? customScope
            : getAudienceChoice(localAudienceId).scope;
        const localEffectiveAudience = audienceForScope(localActiveScope);
        const localChoice = getAudienceChoice(localAudienceId);
        const useMethod = overrideMethod !== null && overrideMethod !== void 0 ? overrideMethod : method;
        const tenantLabel = findTenantLabel(tenantChoices, targetTenantId);
        const baseResult = {
            sourceAccountId: sourceAccount.homeAccountId,
            sourceAccountLabel: sourceAccount.username || sourceAccount.homeAccountId,
            targetTenantId,
            targetTenantLabel: tenantLabel,
            audience: localEffectiveAudience,
            extendedAudience: localAudienceId,
            scope: localActiveScope,
        };
        try {
            let attemptToken;
            let attemptRt;
            let attemptMethod = useMethod;
            if (useMethod === "msal-silent") {
                const r = yield mintViaMsalSilent(sourceAccount.homeAccountId, targetTenantId, localEffectiveAudience, localActiveScope, localAudienceId);
                attemptToken = r.accessToken;
            }
            else if (useMethod === "foci-exchange") {
                const r = yield mintViaFociExchange(sourceAccount.homeAccountId, targetTenantId, localEffectiveAudience, localActiveScope);
                attemptToken = r.accessToken;
                attemptRt = r.refreshToken;
            }
            else {
                // Auto: try MSAL silent first IF the audience can be serviced
                // by it. For the 9 extended audiences (vault / storage /
                // intune / etc.) the MSAL helpers throw immediately — skip
                // straight to FOCI to avoid the wasted round trip + the
                // confusing "MSAL doesn't support X" entry in the auto-
                // attempts panel.
                if (!localChoice.msalSilentSupported) {
                    const rt = getRefreshTokenEntry(sourceAccount.homeAccountId);
                    if (!rt) {
                        throw new Error(`Audience "${localAudienceId.toUpperCase()}" requires the FOCI exchange method (MSAL silent doesn't cover it), but no imported refresh token is available for this account. Paste one on the Import Token page first.`);
                    }
                    const r = yield mintViaFociExchange(sourceAccount.homeAccountId, targetTenantId, localEffectiveAudience, localActiveScope);
                    attemptToken = r.accessToken;
                    attemptRt = r.refreshToken;
                    attemptMethod = "foci-exchange";
                    if (mountedRef.current) {
                        setAutoAttempts((prev) => [
                            ...prev,
                            {
                                method: "foci-exchange",
                                status: "success",
                                detail: `FOCI exchange succeeded (audience "${localAudienceId.toUpperCase()}" not serviceable via MSAL silent).`,
                            },
                        ]);
                    }
                }
                else {
                    try {
                        const r = yield mintViaMsalSilent(sourceAccount.homeAccountId, targetTenantId, localEffectiveAudience, localActiveScope, localAudienceId);
                        attemptToken = r.accessToken;
                        attemptMethod = "msal-silent";
                        if (mountedRef.current) {
                            setAutoAttempts((prev) => [
                                ...prev,
                                {
                                    method: "msal-silent",
                                    status: "success",
                                    detail: "MSAL silent succeeded.",
                                },
                            ]);
                        }
                    }
                    catch (msalErr) {
                        const msg = msalErr instanceof Error ? msalErr.message : String(msalErr);
                        if (mountedRef.current) {
                            setAutoAttempts((prev) => [
                                ...prev,
                                {
                                    method: "msal-silent",
                                    status: "failure",
                                    detail: msg,
                                },
                            ]);
                        }
                        // Fall back to FOCI if available.
                        const rt = getRefreshTokenEntry(sourceAccount.homeAccountId);
                        if (!rt) {
                            throw new Error(`MSAL silent failed (${msg}) and no imported refresh token is available for FOCI fallback.`);
                        }
                        const r = yield mintViaFociExchange(sourceAccount.homeAccountId, targetTenantId, localEffectiveAudience, localActiveScope);
                        attemptToken = r.accessToken;
                        attemptRt = r.refreshToken;
                        attemptMethod = "foci-exchange";
                        if (mountedRef.current) {
                            setAutoAttempts((prev) => [
                                ...prev,
                                {
                                    method: "foci-exchange",
                                    status: "success",
                                    detail: "FOCI exchange succeeded after MSAL fallback.",
                                },
                            ]);
                        }
                    }
                }
            }
            if (!attemptToken) {
                throw new Error("Mint returned no access token (unexpected).");
            }
            const claims = (_k = decodeJwtClaimsUnsafe(attemptToken)) !== null && _k !== void 0 ? _k : {};
            const exp = typeof claims.exp === "number" ? claims.exp : undefined;
            const durationMs = Math.round(performance.now() - startedAt);
            const finalResult = Object.assign(Object.assign({}, baseResult), { status: "success", methodUsed: attemptMethod, durationMs, accessToken: attemptToken, refreshToken: attemptRt, claims, expiresAt: exp, finishedAt: new Date().toISOString() });
            if (mountedRef.current) {
                setResult(finalResult);
                setMintSubStep(null);
                pushHistory(toHistoryRow(finalResult));
            }
            // Record the method + audience pair as a recent (NO tokens — only
            // metadata strings the persisted-state deserializer also screens).
            rememberMethod(attemptMethod, localAudienceId, sourceAccount.username || sourceAccount.homeAccountId);
            // Audit: never log token material — only metadata.
            auditLog.record({
                actor: sourceAccount.username || sourceAccount.homeAccountId,
                action: "tricky_login_mint",
                target: `${tenantLabel} (${targetTenantId})`,
                status: "success",
                details: {
                    sourceAccountId: sourceAccount.homeAccountId,
                    targetTenantId,
                    method: attemptMethod,
                    audience: localEffectiveAudience,
                    scope: localActiveScope,
                    durationMs,
                    tokenAudience: typeof claims.aud === "string" ? claims.aud : null,
                    replay: fromReplay,
                },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const code = extractAadErrorCode(msg);
            const durationMs = Math.round(performance.now() - startedAt);
            const finalResult = Object.assign(Object.assign({}, baseResult), { status: "failure", methodUsed: useMethod, durationMs, errorCode: code, errorMessage: msg, finishedAt: new Date().toISOString() });
            if (mountedRef.current) {
                setResult(finalResult);
                setMintSubStep(null);
                pushHistory(toHistoryRow(finalResult));
            }
            auditLog.record({
                actor: sourceAccount.username || sourceAccount.homeAccountId,
                action: "tricky_login_mint",
                target: `${tenantLabel} (${targetTenantId})`,
                status: "failure",
                error: msg,
                details: {
                    sourceAccountId: sourceAccount.homeAccountId,
                    targetTenantId,
                    method: useMethod,
                    audience: localEffectiveAudience,
                    scope: localActiveScope,
                    durationMs,
                    errorCode: code !== null && code !== void 0 ? code : null,
                    replay: fromReplay,
                },
            });
        }
        finally {
            if (mountedRef.current) {
                setMinting(false);
                setMintSubStep(null);
            }
        }
    }), 
    // We deliberately only depend on the things that change the mint call
    // surface. Including `result` would cause an unnecessary re-bind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
        sourceAccount,
        targetTenantId,
        method,
        audienceId,
        customScope,
        tenantChoices,
        rememberMethod,
        pushHistory,
        announcePolite,
    ]);
    const [batchMinting, setBatchMinting] = React.useState(false);
    const [batchMintResults, setBatchMintResults] = React.useState([]);
    const doBatchMint = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _l;
        if (!sourceAccount || !targetTenantId)
            return;
        setBatchMinting(true);
        setBatchMintResults([]);
        const rows = [];
        // Expanded set: ARM + Graph + Batch + 9 additional audiences. The
        // additional ones can ONLY be serviced by the FOCI exchange path —
        // MSAL silent helpers in msal-auth.ts only cover ARM/Graph/Batch,
        // and adding new ones would cross the "no service-layer edits" line.
        const audiences = BATCH_MINT_AUDIENCES;
        for (const aud of audiences) {
            const startedAt = performance.now();
            const audienceChoice = getAudienceChoice(aud);
            const bucket = audienceForScope(audienceChoice.scope);
            try {
                // Method selection: ARM/Graph/Batch can try Auto (MSAL → FOCI).
                // Everything else MUST go straight to FOCI (skipping MSAL entirely
                // avoids the wasted call + the confusing "MSAL doesn't support X"
                // error before fallback). If the operator pinned the picker to
                // "foci-exchange" we respect that for the supported audiences too.
                const useM = !audienceChoice.msalSilentSupported
                    ? "foci-exchange"
                    : method === "foci-exchange"
                        ? "foci-exchange"
                        : "auto";
                let attemptToken;
                let attemptRt;
                let attemptMethod = useM;
                if (useM === "foci-exchange") {
                    const r = yield mintViaFociExchange(sourceAccount.homeAccountId, targetTenantId, bucket, audienceChoice.scope);
                    attemptToken = r.accessToken;
                    attemptRt = r.refreshToken;
                }
                else {
                    try {
                        const r = yield mintViaMsalSilent(sourceAccount.homeAccountId, targetTenantId, bucket, audienceChoice.scope, aud);
                        attemptToken = r.accessToken;
                        attemptMethod = "msal-silent";
                    }
                    catch (_m) {
                        const rt = getRefreshTokenEntry(sourceAccount.homeAccountId);
                        if (!rt)
                            throw new Error(`MSAL silent failed for ${aud.toUpperCase()} and no FOCI RT available.`);
                        const r = yield mintViaFociExchange(sourceAccount.homeAccountId, targetTenantId, bucket, audienceChoice.scope);
                        attemptToken = r.accessToken;
                        attemptRt = r.refreshToken;
                        attemptMethod = "foci-exchange";
                    }
                }
                if (!attemptToken)
                    throw new Error("Mint returned no access token.");
                const claims = (_l = decodeJwtClaimsUnsafe(attemptToken)) !== null && _l !== void 0 ? _l : {};
                const durationMs = Math.round(performance.now() - startedAt);
                rows.push({
                    audience: aud,
                    bucket,
                    status: "success",
                    methodUsed: attemptMethod,
                    durationMs,
                    accessToken: attemptToken,
                    refreshToken: attemptRt,
                    actualTid: typeof claims.tid === "string" ? claims.tid : undefined,
                    tokenAudience: typeof claims.aud === "string" ? claims.aud : undefined,
                });
                // Auto-import each into the vault so they are usable. NOTE:
                // for non-arm/graph/batch audiences the vault stores the entry
                // with `audience: "unknown"` — that's fine, it just means the
                // silent-cache short-circuits for ARM/Graph/Batch keep working
                // and the extras are accessible via the listImportedTokens view.
                const preview = previewToken(attemptToken);
                if (preview) {
                    const entry = importToken(preview);
                    if (attemptRt) {
                        importRefreshToken({
                            homeAccountId: entry.homeAccountId,
                            tenantId: entry.tenantId,
                            oid: entry.oid,
                            upn: entry.upn,
                            name: entry.name,
                            clientId: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
                            refreshToken: attemptRt,
                        });
                    }
                }
                auditLog.record({
                    actor: sourceAccount.username || sourceAccount.homeAccountId,
                    action: "tricky_login_mint",
                    target: `${findTenantLabel(tenantChoices, targetTenantId)} (${targetTenantId})`,
                    status: "success",
                    details: {
                        sourceAccountId: sourceAccount.homeAccountId,
                        targetTenantId,
                        method: attemptMethod,
                        audience: aud,
                        audienceBucket: bucket,
                        durationMs,
                        batchMint: true,
                    },
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                rows.push({
                    audience: aud,
                    bucket,
                    status: "failure",
                    durationMs: Math.round(performance.now() - startedAt),
                    error: msg,
                });
                auditLog.record({
                    actor: sourceAccount.username || sourceAccount.homeAccountId,
                    action: "tricky_login_mint",
                    target: `${findTenantLabel(tenantChoices, targetTenantId)} (${targetTenantId})`,
                    status: "failure",
                    error: msg,
                    details: {
                        sourceAccountId: sourceAccount.homeAccountId,
                        targetTenantId,
                        audience: aud,
                        audienceBucket: bucket,
                        batchMint: true,
                    },
                });
            }
            // Update results incrementally so the UI shows progress.
            if (mountedRef.current) {
                setBatchMintResults([...rows]);
            }
        }
        setBatchMinting(false);
        // Auto-activate the new tenant context at the END of the batch
        // (only ONE tenant-switch event for the entire batch).
        if (autoActivateOnSuccess && rows.some((r) => r.status === "success")) {
            try {
                yield performTenantSwitch(sourceAccount, targetTenantId, store, { source: "external" });
            }
            catch (_o) {
                /* surfaced as notification by the helper */
            }
        }
        const okCount = rows.filter((r) => r.status === "success").length;
        store.addNotification({
            type: okCount > 0 ? "success" : "error",
            message: `Batch mint: ${okCount}/${rows.length} audiences succeeded against ${findTenantLabel(tenantChoices, targetTenantId)}.`,
        });
    }), [
        sourceAccount,
        targetTenantId,
        method,
        autoActivateOnSuccess,
        store,
        tenantChoices,
    ]);
    /* ----------------------------------------------------------------
     * Per-result actions
     * ---------------------------------------------------------------- */
    /** Import the newly-minted token into the local vault. */
    const handleImportToVault = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _p;
        if (!result || result.status !== "success" || !result.accessToken)
            return;
        try {
            const preview = previewToken(result.accessToken);
            if (!preview) {
                store.addNotification({
                    type: "error",
                    message: "Could not decode the new token — refusing to import.",
                });
                return;
            }
            const entry = importToken(preview);
            // If we also have a refresh token, persist it under the same
            // synthetic homeAccountId so the next silent acquire for this
            // audience pair self-refreshes.
            if (result.refreshToken) {
                importRefreshToken({
                    homeAccountId: entry.homeAccountId,
                    tenantId: entry.tenantId,
                    oid: entry.oid,
                    upn: entry.upn,
                    name: entry.name,
                    // Use ARM CLI's client id as the "issuer" — operators can
                    // refine on the Token Importer page if they care.
                    clientId: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
                    refreshToken: result.refreshToken,
                });
            }
            store.addNotification({
                type: "success",
                message: `Imported ${classifyAudience(preview.rawAudience)} token for ${(_p = preview.upn) !== null && _p !== void 0 ? _p : preview.oid} → ${preview.tenantId}.`,
            });
            auditLog.record({
                actor: result.sourceAccountLabel,
                action: "tricky_login_import_to_vault",
                target: `${result.targetTenantLabel} (${result.targetTenantId})`,
                status: "success",
                details: {
                    sourceAccountId: result.sourceAccountId,
                    targetTenantId: result.targetTenantId,
                    audience: result.audience,
                    importedHomeAccountId: entry.homeAccountId,
                    withRefreshToken: !!result.refreshToken,
                },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            store.addNotification({
                type: "error",
                message: `Import failed: ${msg}`,
            });
        }
    }), [result, store]);
    /** Set the source account's active tenant to the just-minted target. */
    const handleSetActive = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!result || result.status !== "success")
            return;
        if (!sourceAccount) {
            store.addNotification({
                type: "error",
                message: "Source account no longer signed in — cannot switch.",
            });
            return;
        }
        try {
            yield performTenantSwitch(sourceAccount, result.targetTenantId, store, 
            // performTenantSwitch's source union doesn't include "tricky-login",
            // so we use the catch-all "external" — the audit still records the
            // detail via `from: "external"` and our own audit entry below tags
            // the action as `tricky_login_set_as_active` for unambiguous lookup.
            { source: "external" });
            auditLog.record({
                actor: result.sourceAccountLabel,
                action: "tricky_login_set_as_active",
                target: `${result.targetTenantLabel} (${result.targetTenantId})`,
                status: "success",
                details: {
                    sourceAccountId: result.sourceAccountId,
                    targetTenantId: result.targetTenantId,
                    previousActiveTenantId: activeTenantId !== null && activeTenantId !== void 0 ? activeTenantId : null,
                    methodUsed: result.methodUsed,
                },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            store.addNotification({
                type: "error",
                message: `Set-active failed: ${msg}`,
            });
        }
    }), [result, sourceAccount, store, activeTenantId]);
    /**
     * Auto-activate side-effect for fresh successful mints.
     *
     * Without this, the operator hits Mint, sees a green result, then
     * has to click TWO more buttons (Import to vault + Set as active)
     * to make the new context visible across the rest of the app.
     * The whole point of "Tricky Login" is silent acquisition + global
     * propagation — making the operator chase three buttons per mint
     * defeats it.
     *
     * Keyed on `result.finishedAt` via a ref so re-renders don't
     * re-fire. Only fires once per successful mint, only when the
     * autoActivate toggle is ON. Errors in either step surface as
     * notifications but never block the other (e.g. if Import succeeds
     * but Set-active fails because performTenantSwitch races a
     * concurrent switch, the import still landed).
     */
    const autoActivatedForRef = React.useRef(null);
    React.useEffect(() => {
        var _a;
        if (!autoActivateOnSuccess)
            return;
        if (!result || result.status !== "success")
            return;
        const fingerprint = (_a = result.finishedAt) !== null && _a !== void 0 ? _a : null;
        if (!fingerprint || autoActivatedForRef.current === fingerprint)
            return;
        autoActivatedForRef.current = fingerprint;
        // Fire both in sequence — import first (synchronous local state)
        // so the vault is hot BEFORE performTenantSwitch pre-warms the
        // ARM token (which short-circuits to the vault entry).
        void (() => __awaiter(void 0, void 0, void 0, function* () {
            try {
                yield handleImportToVault();
            }
            catch (_b) {
                /* import errors already surfaced as notifications */
            }
            try {
                yield handleSetActive();
            }
            catch (_c) {
                /* set-active errors already surfaced as notifications */
            }
        }))();
    }, [
        result,
        autoActivateOnSuccess,
        handleImportToVault,
        handleSetActive,
    ]);
    /**
     * Re-authenticate via popup, then retry the mint.
     *
     * Triggered when MSAL silent failed with `interaction_required` or
     * `invalid_grant` — the account's MSAL refresh token in the cache
     * is gone (expired, revoked, or wiped by a "Clear sign-in cache"
     * action elsewhere). A popup with `loginHint: source.username`
     * makes AAD pick the right account automatically, and routing the
     * popup AT the target tenant's authority means the same gesture
     * also adds the operator as a (guest) member of that tenant if
     * they aren't one already — exactly what the operator wants
     * post-failure.
     *
     * Tied to the FAILURE result so re-auth only re-targets the
     * specific (account, target tenant, audience) combo that just
     * failed.
     */
    const [reAuthing, setReAuthing] = React.useState(false);
    const handleReAuthenticateAndRetry = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!result || result.status !== "failure")
            return;
        if (!sourceAccount) {
            store.addNotification({
                type: "error",
                message: "Source account no longer signed in — cannot re-authenticate.",
            });
            return;
        }
        setReAuthing(true);
        try {
            // Popup against the TARGET tenant's authority — refreshes the
            // account's MSAL session AND seeds a token for the target
            // tenant in one user gesture. loginHint pre-selects the right
            // account in the AAD picker.
            yield loginAccount({
                tenantId: result.targetTenantId,
                loginHint: sourceAccount.username,
                prompt: "select_account",
            });
            store.addNotification({
                type: "success",
                message: `Re-authenticated ${sourceAccount.username} against ${result.targetTenantLabel}. Retrying mint…`,
            });
            auditLog.record({
                actor: sourceAccount.username || sourceAccount.homeAccountId,
                action: "tricky_login_reauth",
                target: `${result.targetTenantLabel} (${result.targetTenantId})`,
                status: "success",
                details: {
                    sourceAccountId: sourceAccount.homeAccountId,
                    targetTenantId: result.targetTenantId,
                },
            });
            // Re-run the mint with the same audience + method that failed.
            // The fresh MSAL session should now allow silent acquire.
            yield doMint(undefined, true);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            store.addNotification({
                type: "error",
                message: `Re-authentication failed: ${msg}`,
            });
            auditLog.record({
                actor: sourceAccount.username || sourceAccount.homeAccountId,
                action: "tricky_login_reauth",
                target: `${result.targetTenantLabel} (${result.targetTenantId})`,
                status: "failure",
                error: msg,
                details: {
                    sourceAccountId: sourceAccount.homeAccountId,
                    targetTenantId: result.targetTenantId,
                },
            });
        }
        finally {
            setReAuthing(false);
        }
    }), [result, sourceAccount, store, doMint]);
    /**
     * MFA re-elevation. Triggered from the success-result panel when the
     * minted access token does NOT carry an `amr` claim value of "mfa" /
     * "ngcmfa" / "wia" (i.e. the operator's session is single-factor and
     * the resource server might still want a step-up).
     *
     * The spec asks us to pass `extraQueryParameters: { acr_values:
     * "urn:mace:incommon:iap:silver" }` so AAD re-evaluates MFA, but the
     * project's `loginAccount` wrapper (msal-auth.ts:604) does NOT accept
     * `extraQueryParameters` — only `{ tenantId, loginHint, prompt }`. We
     * adapt by passing `prompt: "login"`, which forces a fresh credential
     * entry AND triggers Conditional Access policy re-evaluation. For
     * accounts subject to a CA policy that requires MFA, AAD will prompt
     * for the second factor automatically. For accounts NOT subject to
     * such a policy, "login" still produces a fresher token with an updated
     * `iat` and a clean `amr` array — which is the best we can do
     * client-side without editing msal-auth.ts.
     *
     * On success, auto-retries the mint so the new (hopefully MFA-bound)
     * session is captured by the silent acquire.
     */
    const [mfaUpgrading, setMfaUpgrading] = React.useState(false);
    const handleMfaUpgrade = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _q, _r;
        if (!result || result.status !== "success")
            return;
        if (!sourceAccount) {
            store.addNotification({
                type: "error",
                message: "Source account no longer signed in — cannot upgrade MFA.",
            });
            return;
        }
        setMfaUpgrading(true);
        try {
            yield loginAccount({
                tenantId: result.targetTenantId,
                loginHint: sourceAccount.username,
                // prompt: "login" forces re-auth (no SSO short-circuit) — AAD
                // re-evaluates CA / MFA policies AGAINST THE TARGET TENANT.
                // We intentionally do NOT use extraQueryParameters since
                // loginAccount() in this codebase doesn't accept it (would
                // require a msal-auth.ts edit, out of scope here).
                prompt: "login",
            });
            store.addNotification({
                type: "success",
                message: `Re-authenticated ${sourceAccount.username} with prompt=login against ${result.targetTenantLabel}. If a CA policy requires MFA, the new token's amr should now include "mfa". Retrying mint…`,
            });
            auditLog.record({
                actor: sourceAccount.username || sourceAccount.homeAccountId,
                action: "tricky_login_mfa_upgrade",
                target: `${result.targetTenantLabel} (${result.targetTenantId})`,
                status: "success",
                details: {
                    sourceAccountId: sourceAccount.homeAccountId,
                    targetTenantId: result.targetTenantId,
                    previousAmr: (_r = (_q = result.claims) === null || _q === void 0 ? void 0 : _q.amr) !== null && _r !== void 0 ? _r : null,
                },
            });
            // Re-mint the same audience so the new session is captured.
            yield doMint(undefined, true);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            store.addNotification({
                type: "error",
                message: `MFA upgrade failed: ${msg}`,
            });
            auditLog.record({
                actor: sourceAccount.username || sourceAccount.homeAccountId,
                action: "tricky_login_mfa_upgrade",
                target: `${result.targetTenantLabel} (${result.targetTenantId})`,
                status: "failure",
                error: msg,
                details: {
                    sourceAccountId: sourceAccount.homeAccountId,
                    targetTenantId: result.targetTenantId,
                },
            });
        }
        finally {
            setMfaUpgrading(false);
        }
    }), [result, sourceAccount, store, doMint]);
    /** Pre-seed sessionStorage and hop to the Token Importer. */
    const handleOpenInImporter = React.useCallback(() => {
        if (!result || result.status !== "success" || !result.accessToken)
            return;
        try {
            // sessionStorage handoff is the contract the Token Importer page reads
            // from. Token material exits THIS page only at the moment the operator
            // explicitly clicks "Open Token Importer" — it never lands in the
            // audit log or in any persisted state (history rows / preferences).
            if (typeof window !== "undefined") {
                window.sessionStorage.setItem(TOKEN_IMPORTER_SESSION_KEY, result.accessToken);
            }
            navigateToPage("/token-importer");
        }
        catch (err) {
            store.addNotification({
                type: "error",
                message: `Could not navigate: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }, [result, store, navigateToPage]);
    /** Copy the raw token to clipboard, toast on success. */
    const handleCopyToken = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!(result === null || result === void 0 ? void 0 : result.accessToken))
            return;
        try {
            yield navigator.clipboard.writeText(result.accessToken);
            store.addNotification({
                type: "success",
                message: "Access token copied to clipboard.",
            });
        }
        catch (_s) {
            store.addNotification({
                type: "warning",
                message: "Could not access clipboard — reveal the token below and copy manually.",
            });
        }
    }), [result, store]);
    /**
     * Build a sanitized auth-diagnostics blob the operator can paste into
     * support tickets / Slack threads. HARD constraint enforced here: no
     * access_token, refresh_token, id_token, device_code, or claim values
     * that could uniquely identify a session. Only structural metadata.
     *
     * What IS included:
     *   - The page version stamp.
     *   - Source-account presence, count of signed-in accounts.
     *   - Whether an imported RT exists (presence only).
     *   - The target tenant id + tenant-label.
     *   - The chosen method + audience.
     *   - Last mint outcome (status / method-used / error-code only).
     *   - Federation realm probe result (status/protocol/STS host).
     *   - Discovery flags for each method.
     *   - Recent-methods count + saved-tenant count.
     *
     * What is NEVER included:
     *   - accessToken, refreshToken, claims content.
     *   - Imported RT raw value.
     *   - Auto-attempt detail strings (those may contain AAD error_descriptions
     *     that sometimes carry account hints — we redact to bucket counts).
     */
    const handleCopyDiagnostics = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _t, _u, _v, _w, _x, _y, _z, _0, _1, _2;
        // Compute a freshly-redacted diagnostics blob each click — no cached
        // value that could leak after a re-mint.
        const stsHost = (() => {
            var _a;
            const u = (_a = realmProbe === null || realmProbe === void 0 ? void 0 : realmProbe.stsUrl) !== null && _a !== void 0 ? _a : realmProbe === null || realmProbe === void 0 ? void 0 : realmProbe.authUrl;
            if (!u)
                return null;
            try {
                return new URL(u).host;
            }
            catch (_b) {
                return null;
            }
        })();
        const diag = {
            app: "tricky-login",
            capturedAt: new Date().toISOString(),
            sourceAccount: {
                signedIn: !!sourceAccount,
                accountsCount: azureAccounts.length,
                // upn-domain only — strip local-part to avoid PII leakage.
                usernameDomain: (_u = (_t = sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.username) === null || _t === void 0 ? void 0 : _t.split("@")[1]) !== null && _u !== void 0 ? _u : null,
                tenantId: (_v = sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.tenantId) !== null && _v !== void 0 ? _v : null,
                activeTenantId: activeTenantId !== null && activeTenantId !== void 0 ? activeTenantId : null,
            },
            target: {
                tenantId: targetTenantId || null,
                tenantLabelKnown: !!targetTenantId &&
                    tenantChoices.some((t) => {
                        var _a;
                        return ((_a = t.tenantId) !== null && _a !== void 0 ? _a : "").toLowerCase() ===
                            targetTenantId.toLowerCase();
                    }),
                tenantsListLoaded: tenantChoices.length > 0,
                tenantsListSize: tenantChoices.length,
            },
            method: {
                chosen: method,
                importedRtPresent: !!importedRt,
            },
            audience: {
                chosen: audienceId,
                msalSilentSupported: getAudienceChoice(audienceId).msalSilentSupported,
            },
            discovery: {
                msalSilent: availability.msalSilent.available,
                fociExchange: availability.fociExchange.available,
                directTenantRt: availability.directTenantRt.available,
            },
            lastResult: result
                ? {
                    status: result.status,
                    methodUsed: result.methodUsed,
                    extendedAudience: (_w = result.extendedAudience) !== null && _w !== void 0 ? _w : null,
                    durationMs: result.durationMs,
                    errorCode: (_x = result.errorCode) !== null && _x !== void 0 ? _x : null,
                    // Boolean only — never the value.
                    hadRefreshToken: !!result.refreshToken,
                    tidMatch: !!((_y = result.claims) === null || _y === void 0 ? void 0 : _y.tid) &&
                        typeof result.claims.tid === "string" &&
                        result.claims.tid.toLowerCase() ===
                            result.targetTenantId.toLowerCase(),
                }
                : null,
            autoAttempts: {
                total: autoAttempts.length,
                successes: autoAttempts.filter((a) => a.status === "success").length,
                failures: autoAttempts.filter((a) => a.status === "failure").length,
            },
            federation: {
                probed: !!realmProbe,
                status: (_z = realmProbe === null || realmProbe === void 0 ? void 0 : realmProbe.status) !== null && _z !== void 0 ? _z : null,
                protocol: (_0 = realmProbe === null || realmProbe === void 0 ? void 0 : realmProbe.federationProtocol) !== null && _0 !== void 0 ? _0 : null,
                stsHost,
                probeError: !!realmError,
            },
            session: {
                historyRows: history.length,
                successes: history.filter((h) => h.status === "success").length,
                failures: history.filter((h) => h.status === "failure").length,
                recentMethodsTracked: recentMethods.length,
                savedTenantShortcuts: savedTenants.length,
                batchRowsLastRun: batchMintResults.length,
            },
        };
        const blob = JSON.stringify(diag, null, 2);
        try {
            yield navigator.clipboard.writeText(blob);
            store.addNotification({
                type: "success",
                message: "Sanitized auth diagnostics copied (no token material).",
            });
            auditLog.record({
                actor: (_2 = (_1 = sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.username) !== null && _1 !== void 0 ? _1 : sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.homeAccountId) !== null && _2 !== void 0 ? _2 : "(no source account)",
                action: "tricky_login_copy_diagnostics",
                target: "tricky-login page",
                status: "success",
                details: {
                    targetTenantId: targetTenantId || null,
                    method,
                    audience: audienceId,
                    historyRows: history.length,
                },
            });
        }
        catch (_3) {
            store.addNotification({
                type: "warning",
                message: "Clipboard unavailable — see browser devtools for a fallback log.",
            });
            // Last-resort fallback so the support flow doesn't dead-end.
            try {
                // eslint-disable-next-line no-console
                console.info("[tricky-login diagnostics]", diag);
            }
            catch (_4) {
                /* no-op */
            }
        }
    }), [
        realmProbe,
        realmError,
        sourceAccount,
        azureAccounts.length,
        activeTenantId,
        targetTenantId,
        tenantChoices,
        method,
        importedRt,
        audienceId,
        availability,
        result,
        autoAttempts,
        history,
        recentMethods.length,
        savedTenants.length,
        batchMintResults.length,
        store,
    ]);
    // Tracker for the deferred replay timer so unmount tears it down. The
    // setState calls above schedule a re-render and we need to defer the
    // mint until those state writes have committed; raw setTimeout without
    // cleanup would fire after the page unmounted and trigger a stale mint.
    const replayTimerRef = React.useRef(null);
    React.useEffect(() => () => {
        if (replayTimerRef.current !== null) {
            window.clearTimeout(replayTimerRef.current);
            replayTimerRef.current = null;
        }
    }, []);
    /** Replay a history row (re-runs the same source/target/method/audience). */
    const handleReplay = React.useCallback((row) => {
        var _a, _b;
        // Find the source account again (could have been signed out).
        const acct = azureAccounts.find((a) => a.homeAccountId === row.sourceAccountId);
        if (!acct) {
            store.addNotification({
                type: "error",
                message: `Cannot replay — source account ${row.sourceAccountLabel} is no longer signed in.`,
            });
            // Record the abandoned replay so the audit log shows the operator
            // tried (failed-precondition variant — no token material involved).
            auditLog.record({
                actor: row.sourceAccountLabel,
                action: "tricky_login_replay",
                target: `${row.targetTenantLabel} (${row.targetTenantId})`,
                status: "failure",
                error: "source account no longer signed in",
                details: {
                    sourceAccountId: row.sourceAccountId,
                    targetTenantId: row.targetTenantId,
                    method: row.methodUsed,
                    audience: row.audience,
                    extendedAudience: (_a = row.extendedAudience) !== null && _a !== void 0 ? _a : null,
                },
            });
            return;
        }
        // Set the picker state to match the row, then fire mint with the
        // row's method as an explicit override (so the operator doesn't
        // have to manually re-pick).
        setSourceAccountId(row.sourceAccountId);
        setTargetTenantId(row.targetTenantId);
        // Map scope back to an audience choice. Prefer the row's
        // extendedAudience (richer) — fall back to scope-based detection
        // for legacy rows persisted before the 12-audience expansion.
        const extAud = (_b = row.extendedAudience) !== null && _b !== void 0 ? _b : extendedAudienceForScope(row.scope);
        if (extAud === "custom") {
            setAudienceId("custom");
            setCustomScope(row.scope);
        }
        else {
            setAudienceId(extAud);
        }
        setMethod(row.methodUsed);
        // Cancel any in-flight deferred replay before scheduling a new one.
        if (replayTimerRef.current !== null) {
            window.clearTimeout(replayTimerRef.current);
        }
        // Defer the mint by a tick so the state writes commit first. The
        // timer id is stored so an unmount cancels the pending call (no
        // stale doMint on an unmounted page).
        replayTimerRef.current = window.setTimeout(() => {
            replayTimerRef.current = null;
            void doMint(row.methodUsed, true);
        }, 50);
    }, [azureAccounts, doMint, store]);
    /* ----------------------------------------------------------------
     * G. Summary stats
     * ---------------------------------------------------------------- */
    const summary = React.useMemo(() => {
        const total = history.length;
        const successes = history.filter((h) => h.status === "success").length;
        const fociHits = history.filter((h) => h.methodUsed === "foci-exchange" && h.status === "success").length;
        // Cross-tenant guests: distinct target tenant ids in successful rows
        // that differ from any of the operator's home tenant ids.
        const homeTids = new Set(azureAccounts.map((a) => { var _a; return ((_a = a.tenantId) !== null && _a !== void 0 ? _a : "").toLowerCase(); }));
        const guestTargets = new Set(history
            .filter((h) => h.status === "success")
            .map((h) => { var _a; return ((_a = h.targetTenantId) !== null && _a !== void 0 ? _a : "").toLowerCase(); })
            .filter((tid) => tid && !homeTids.has(tid)));
        return {
            total,
            successes,
            fociHits,
            crossTenantGuests: guestTargets.size,
        };
    }, [history, azureAccounts]);
    /* ----------------------------------------------------------------
     * Render guards
     * ---------------------------------------------------------------- */
    /* ----------------------------------------------------------------
     * H. Corpus-grounded operator advisories
     *
     * Computed off the LAST SUCCESSFUL result + the realm probe. Pure
     * function lives in corpus-advisories.ts; this memo only adapts
     * the page-local types to the advisory engine's metadata-only
     * shape. HARD: only the claim payload (already in memory) and
     * realm metadata are passed — never the access token.
     * ---------------------------------------------------------------- */
    const operatorAdvisories = React.useMemo(() => {
        if (!result || result.status !== "success" || !result.claims)
            return [];
        const meta = {
            methodUsed: result.methodUsed,
            extendedAudience: result.extendedAudience,
            targetTenantId: result.targetTenantId,
            sourceHomeTenantId: sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.tenantId,
            claims: result.claims,
        };
        const realmSummary = realmProbe
            ? {
                status: realmProbe.status,
                stsUrl: realmProbe.stsUrl,
                federationProtocol: realmProbe.federationProtocol,
                authUrl: realmProbe.authUrl,
                domainName: realmProbe.domainName,
            }
            : null;
        return computeOperatorAdvisories(meta, realmSummary, sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.username);
    }, [result, realmProbe, sourceAccount]);
    /* ----------------------------------------------------------------
     * H.2. ARIA-live announcements on result transitions
     * ---------------------------------------------------------------- */
    // We track the last announced result fingerprint so we don't repeat
    // announcements on re-renders that don't change the result.
    const lastAnnouncedResultRef = React.useRef(null);
    React.useEffect(() => {
        var _a;
        if (!result)
            return;
        const fp = (_a = result.finishedAt) !== null && _a !== void 0 ? _a : null;
        if (!fp || lastAnnouncedResultRef.current === fp)
            return;
        lastAnnouncedResultRef.current = fp;
        if (result.status === "success") {
            announcePolite(`Mint succeeded via ${result.methodUsed} for tenant ${result.targetTenantLabel}. ${operatorAdvisories.length > 0
                ? `${operatorAdvisories.length} operator advisory${operatorAdvisories.length === 1 ? "" : "s"} surfaced — review below.`
                : "No operator advisories surfaced."}`);
        }
        else {
            announcePolite(`Mint failed${result.errorCode ? ` — ${result.errorCode}` : ""}. See result panel for details.`);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [result, operatorAdvisories.length]);
    /* ----------------------------------------------------------------
     * H.3. Sanitized JSON-claims preview
     *
     * Builds a stringified JSON view of the result's claims with two
     * layers of defense against accidental token leakage:
     *   1. Any claim VALUE that is a string matching the JWT-shape
     *      regex (>120 chars, 3 base64url segments) is replaced with
     *      "<jwt-redacted>".
     *   2. The whole blob is JSON.stringify'd with a fixed indent, so
     *      no embedded HTML and no React-tree rendering.
     *
     * The string is never persisted, never audited — it's a render-
     * only convenience. Compute lazily so opening the toggle is cheap.
     * ---------------------------------------------------------------- */
    const sanitizedClaimsJson = React.useMemo(() => {
        if (!(result === null || result === void 0 ? void 0 : result.claims))
            return "";
        const safe = {};
        for (const [k, v] of Object.entries(result.claims)) {
            if (typeof v === "string" && looksLikeJwt(v)) {
                safe[k] = "<jwt-redacted>";
            }
            else if (Array.isArray(v)) {
                safe[k] = v.map((item) => typeof item === "string" && looksLikeJwt(item)
                    ? "<jwt-redacted>"
                    : item);
            }
            else {
                safe[k] = v;
            }
        }
        try {
            return JSON.stringify(safe, null, 2);
        }
        catch (_a) {
            return "(could not serialise claims)";
        }
    }, [result, looksLikeJwt]);
    /* ----------------------------------------------------------------
     * H.4. Copy sanitized JSON claims (no raw token material)
     * ---------------------------------------------------------------- */
    const handleCopyClaimsJson = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!sanitizedClaimsJson)
            return;
        try {
            yield navigator.clipboard.writeText(sanitizedClaimsJson);
            store.addNotification({
                type: "success",
                message: "Sanitized claims JSON copied (JWT-shaped values redacted).",
            });
        }
        catch (_5) {
            store.addNotification({
                type: "warning",
                message: "Clipboard unavailable — reveal the JSON below and copy manually.",
            });
        }
    }), [sanitizedClaimsJson, store]);
    /* ----------------------------------------------------------------
     * H.5. Hotkeys
     *
     * - Esc: cancel any in-flight realm probe (operator-controlled
     *   abort signal). We deliberately do NOT cancel an in-flight
     *   mint via Esc — the mint is wrapped around external calls
     *   (msal-auth.ts, foci-exchange) we don't own AbortController
     *   plumbing for, and partial cancellation could leave imported
     *   RTs in a half-rotated state. The probe is a single GET we
     *   own end-to-end, so it's safe.
     * - Enter: commit the focused flow when (a) focus is inside this
     *   page's container, (b) target tenant is set, (c) we're not
     *   already minting / batch minting. Skipped when focus is on a
     *   textarea / contenteditable / open dialog so typing isn't
     *   hijacked.
     *
     * Bound at document level so they work from anywhere on the page.
     * Cleaned up on unmount.
     * ---------------------------------------------------------------- */
    // Ref to the doMint function so the hotkey handler doesn't need to
    // be re-bound every time doMint's deps change.
    const doMintRef = React.useRef(null);
    React.useEffect(() => {
        doMintRef.current = doMint;
    }, [doMint]);
    React.useEffect(() => {
        const handler = (e) => {
            var _a, _b;
            // Ignore key events from inside dialogs (Radix portals into body).
            const targetEl = e.target;
            const insideDialog = !!((_a = targetEl === null || targetEl === void 0 ? void 0 : targetEl.closest) === null || _a === void 0 ? void 0 : _a.call(targetEl, '[role="dialog"]'));
            if (insideDialog)
                return;
            if (e.key === "Escape") {
                // Cancel an in-flight realm probe if any.
                const ctrl = realmProbeAbortRef.current;
                if (ctrl) {
                    try {
                        ctrl.abort();
                        realmProbeAbortRef.current = null;
                        setRealmLoading(false);
                        announcePolite("Federation realm probe cancelled by operator.");
                    }
                    catch (_c) {
                        /* no-op */
                    }
                }
            }
            else if (e.key === "Enter") {
                // Avoid hijacking typing inside form controls.
                const tag = ((_b = targetEl === null || targetEl === void 0 ? void 0 : targetEl.tagName) !== null && _b !== void 0 ? _b : "").toLowerCase();
                const isFormControl = tag === "input" ||
                    tag === "textarea" ||
                    tag === "select" ||
                    !!(targetEl === null || targetEl === void 0 ? void 0 : targetEl.isContentEditable);
                if (isFormControl)
                    return;
                // Only commit if a tenant is selected and we're idle.
                if (!sourceAccount || !targetTenantId)
                    return;
                if (minting || batchMinting)
                    return;
                if (targetIsActiveRef.current)
                    return;
                e.preventDefault();
                const fn = doMintRef.current;
                if (fn) {
                    announcePolite("Submitting mint via Enter hotkey.");
                    void fn();
                }
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
        // We deliberately omit `doMint` from deps — we use the ref above
        // so deps changes don't re-attach the listener every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourceAccount, targetTenantId, minting, batchMinting, announcePolite]);
    const noAccounts = azureAccounts.length === 0;
    const noTargetTenant = !targetTenantId;
    // Target tenant matches active tenant — surface it as a no-op so the
    // operator doesn't waste a click. Computed here so the hotkey effect
    // above (Enter to commit) can read it from the same closure.
    const targetIsActiveValue = !!activeTenantId &&
        !!targetTenantId &&
        activeTenantId.toLowerCase() === targetTenantId.toLowerCase();
    // Track in a ref so the document keydown handler reads the freshest
    // value without re-binding every render.
    const targetIsActiveRef = React.useRef(false);
    React.useEffect(() => {
        targetIsActiveRef.current = targetIsActiveValue;
    }, [targetIsActiveValue]);
    const targetIsActive = targetIsActiveValue;
    const canMint = !!sourceAccount && !noTargetTenant && !targetIsActive && !minting;
    /* ----------------------------------------------------------------
     * Render
     * ---------------------------------------------------------------- */
    return (React.createElement("div", { className: cn("flex flex-col", compactView ? "gap-3" : "gap-6") },
        React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only" }, ariaAnnouncement),
        React.createElement(FlowEducationWizard, { open: wizardOpen, onOpenChange: setWizardOpen, initialMethod: method }),
        React.createElement(PageHeader, { title: "Tricky Login", description: "Silent cross-tenant token mints from your existing sign-in. Re-frames cross-tenant token tricks (ROADtools roadtx, AADInternals, Stormspotter) as defensive admin operations." },
            React.createElement(Badge, { variant: "outline", className: "gap-1" },
                React.createElement(ShieldCheck, { className: "h-3 w-3", "aria-hidden": true }),
                "Defensive admin"),
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: tokenState.secondsUntilExpiry, loading: tokenState.loading, onRefresh: () => {
                    void tokenState.refresh();
                }, needsReauth: tokenState.needsReauth, onReauth: () => void tokenState.reauth({
                    tenantId: activeTenantId,
                    loginHint: sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.username,
                }) }),
            React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setCompactView((v) => !v), "aria-pressed": compactView, title: compactView
                    ? "Switch to comfortable view"
                    : "Switch to compact view (denser layout)", className: "gap-1" },
                compactView ? (React.createElement(Maximize2, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(Minimize2, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                compactView ? "Comfortable" : "Compact"),
            React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setWizardOpen(true), title: "Open the per-flow education wizard (what each method does + corpus references)", "aria-label": "Open flow-education wizard", className: "gap-1" },
                React.createElement(BookOpen, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Why this flow?")),
        noAccounts && (React.createElement(EmptyState, { icon: KeyRound, title: "Sign in to use Tricky Login", description: "You need at least one signed-in Azure account so this page can mint silent cross-tenant tokens from its MSAL cache." })),
        !noAccounts && (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Tricky Login session summary" },
                React.createElement(SummaryStatItem, { label: "Total attempts", value: summary.total, hint: "this session" }),
                React.createElement(SummaryStatItem, { label: "Successes", value: summary.successes, tone: summary.successes > 0 ? "success" : undefined }),
                React.createElement(SummaryStatItem, { label: "FOCI exchanges", value: summary.fociHits, tone: summary.fociHits > 0 ? "info" : undefined, hint: "successful" }),
                React.createElement(SummaryStatItem, { label: "Cross-tenant guests", value: summary.crossTenantGuests, tone: summary.crossTenantGuests > 0 ? "warning" : undefined, hint: "distinct target tids" }),
                React.createElement("div", { className: "flex min-w-[18rem] flex-col gap-1 rounded-md border bg-card/40 px-3 py-2", role: "group", "aria-label": "Current auth context" },
                    React.createElement("div", { className: "flex items-center gap-1.5 text-2xs uppercase tracking-wider text-muted-foreground" },
                        React.createElement(Shield, { className: "h-3 w-3", "aria-hidden": true }),
                        "Current auth context"),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 text-xs" },
                        sourceAccount ? (React.createElement(Badge, { variant: "outline", className: "gap-1 font-mono text-2xs" },
                            React.createElement(Users, { className: "h-3 w-3", "aria-hidden": true }),
                            sourceAccount.username || sourceAccount.homeAccountId)) : (React.createElement(Badge, { variant: "outline" }, "no source")),
                        React.createElement(Badge, { variant: "outline", className: "gap-1 text-2xs" },
                            React.createElement(Globe, { className: "h-3 w-3", "aria-hidden": true }),
                            findTenantLabel(tenantChoices, activeTenantId)),
                        React.createElement(Badge, { variant: importedRt ? "info" : "outline", className: "gap-1 text-2xs", title: importedRt
                                ? "An imported refresh token is available for FOCI exchange."
                                : "No imported RT — FOCI exchange method unavailable." },
                            React.createElement(KeyRound, { className: "h-3 w-3", "aria-hidden": true }),
                            "RT ",
                            importedRt ? "ready" : "none"),
                        React.createElement(Badge, { variant: "outline", className: "text-2xs" },
                            "Method: ",
                            methodShortLabel(method))))),
            React.createElement(Tabs, { defaultValue: "user", className: "w-full" },
                React.createElement(TabsList, null,
                    React.createElement(TabsTrigger, { value: "user", className: "gap-1" },
                        React.createElement(Users, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "User account"),
                    React.createElement(TabsTrigger, { value: "sp", className: "gap-1" },
                        React.createElement(Lock, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Service Principal")),
                React.createElement(TabsContent, { value: "user", className: "flex flex-col gap-6" },
                    React.createElement(Card, null,
                        React.createElement(CardHeader, null,
                            React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                                React.createElement(Users, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                                "Source account & target tenant"),
                            React.createElement(CardDescription, null, "Pick a signed-in account, then pick the tenant you want to mint a token for. Silent acquisition only succeeds for tenants the source account is already entitled to access.")),
                        React.createElement(CardContent, { className: "grid gap-4 lg:grid-cols-2" },
                            React.createElement("div", { className: "flex flex-col gap-2" },
                                React.createElement(Label, { className: "flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground" },
                                    "Source account",
                                    React.createElement(InfoTooltip, { content: "The signed-in MSAL account whose silent acquisition we'll use. Tokens are minted against its own MSAL cache \u2014 no credential prompt." })),
                                React.createElement(Select, { value: sourceAccountId, onValueChange: (v) => setSourceAccountId(v) },
                                    React.createElement(SelectTrigger, { "aria-label": "Source account" },
                                        React.createElement(SelectValue, { placeholder: "Select an account" })),
                                    React.createElement(SelectContent, null, azureAccounts.map((a) => (React.createElement(SelectItem, { key: a.homeAccountId, value: a.homeAccountId }, a.username || a.name || a.homeAccountId))))),
                                sourceAccount && (React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground" },
                                    React.createElement(Badge, { variant: "outline", className: "gap-1" },
                                        React.createElement(Globe, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Currently active:",
                                        " ",
                                        findTenantLabel(tenantChoices, activeTenantId)),
                                    React.createElement(Badge, { variant: "outline" },
                                        "Home tenant: ",
                                        sourceAccount.tenantId),
                                    importedRt && (React.createElement(Badge, { variant: "info", className: "gap-1" },
                                        React.createElement(KeyRound, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Imported RT available"))))),
                            React.createElement("div", { className: "flex flex-col gap-2" },
                                React.createElement(Label, { className: "flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground" },
                                    "Target tenant",
                                    React.createElement(InfoTooltip, { content: "The tenant you want a new token for. Greyed-out entries are either the source's currently-active tenant (would be a no-op) or not yet hydrated." })),
                                React.createElement("div", { className: "flex items-center gap-2" },
                                    React.createElement(Select, { value: targetTenantId, onValueChange: (v) => setTargetTenantId(v), disabled: tenantChoices.length === 0 },
                                        React.createElement(SelectTrigger, { className: "flex-1", "aria-label": "Target tenant" },
                                            React.createElement(SelectValue, { placeholder: tenantChoices.length === 0
                                                    ? tenantsLoading
                                                        ? "Loading tenants…"
                                                        : "No tenants loaded — click Discover"
                                                    : "Select target tenant" })),
                                        React.createElement(SelectContent, null, tenantChoices.map((t) => {
                                            var _a, _b, _c;
                                            const isActive = !!activeTenantId &&
                                                ((_a = t.tenantId) !== null && _a !== void 0 ? _a : "").toLowerCase() ===
                                                    activeTenantId.toLowerCase();
                                            return (React.createElement(SelectItem, { key: t.tenantId, value: t.tenantId, disabled: isActive }, ((_c = (_b = t.displayName) !== null && _b !== void 0 ? _b : t.defaultDomain) !== null && _c !== void 0 ? _c : t.tenantId) +
                                                (isActive ? "  (active — no-op)" : "")));
                                        }))),
                                    React.createElement(Button, { variant: "outline", size: "sm", onClick: () => sourceAccountId && void fetchTenants(sourceAccountId), disabled: !sourceAccountId || tenantsLoading, title: "Re-list accessible tenants for the source account (ARM /tenants)", className: "gap-1" },
                                        tenantsLoading ? (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin", "aria-hidden": true })) : (React.createElement(RefreshCcw, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                                        tenantChoices.length === 0 ? "Discover" : "Refresh")),
                                tenantsError && (React.createElement("p", { className: "text-2xs text-destructive" }, tenantsError)),
                                targetIsActive && (React.createElement("p", { className: "flex items-center gap-1 text-2xs text-warning" },
                                    React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true }),
                                    "This is the source account's active tenant \u2014 no mint would be performed.")),
                                React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 pt-1", role: "group", "aria-label": "Saved tenant shortcuts" },
                                    React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Shortcuts"),
                                    savedTenants.length === 0 ? (React.createElement("span", { className: "text-2xs italic text-muted-foreground" }, "none yet")) : (savedTenants.map((s) => {
                                        const isCurrent = targetTenantId &&
                                            targetTenantId.toLowerCase() ===
                                                s.tenantId.toLowerCase();
                                        return (React.createElement("span", { key: s.tenantId, className: cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs", isCurrent
                                                ? "border-primary/60 bg-primary/10"
                                                : "border-border bg-card/30") },
                                            React.createElement("button", { type: "button", onClick: () => handleApplyTenantShortcut(s.tenantId), className: "inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", title: `Apply tenant shortcut: ${s.label} (${s.tenantId})`, "aria-label": `Apply tenant shortcut ${s.label}` },
                                                React.createElement(Star, { className: "h-3 w-3 text-warning", "aria-hidden": true }),
                                                s.label),
                                            React.createElement("button", { type: "button", onClick: () => handleRemoveTenantShortcut(s.tenantId), className: "-mr-1 inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": `Remove tenant shortcut ${s.label}`, title: "Remove shortcut" },
                                                React.createElement(XCircle, { className: "h-3 w-3", "aria-hidden": true }))));
                                    })),
                                    React.createElement(Button, { variant: "ghost", size: "sm", onClick: handleSaveTenantShortcut, disabled: !targetTenantId ||
                                            savedTenants.some((s) => s.tenantId.toLowerCase() ===
                                                targetTenantId.toLowerCase()), className: "h-6 gap-1 px-2 text-2xs", title: "Pin the current target tenant to the shortcuts list (metadata only \u2014 no token material persists).", "aria-label": "Pin current tenant to shortcuts" },
                                        React.createElement(Star, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Pin current"))))),
                    React.createElement(Card, null,
                        React.createElement(CardHeader, null,
                            React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                                React.createElement(Wand2, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                                "Tricks discovery"),
                            React.createElement(CardDescription, null, "Per-method availability for the selected (account, tenant) pair. The page never makes interactive prompts; if a method's row is \u2717, it would fail at submit time.")),
                        React.createElement(CardContent, { className: "flex flex-col gap-3" },
                            React.createElement("ul", { className: "flex flex-col gap-1 text-xs" },
                                React.createElement("li", { className: cn("flex items-start gap-2", availability.msalSilent.available
                                        ? "text-success"
                                        : "text-muted-foreground") },
                                    availability.msalSilent.available ? (React.createElement(CheckCircle2, { className: "mt-0.5 h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(XCircle, { className: "mt-0.5 h-3.5 w-3.5", "aria-hidden": true })),
                                    React.createElement("span", null, availability.msalSilent.reason)),
                                React.createElement("li", { className: cn("flex items-start gap-2", availability.fociExchange.available
                                        ? "text-success"
                                        : "text-muted-foreground") },
                                    availability.fociExchange.available ? (React.createElement(CheckCircle2, { className: "mt-0.5 h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(XCircle, { className: "mt-0.5 h-3.5 w-3.5", "aria-hidden": true })),
                                    React.createElement("span", null, availability.fociExchange.reason)),
                                React.createElement("li", { className: "flex items-start gap-2 text-muted-foreground" },
                                    React.createElement(XCircle, { className: "mt-0.5 h-3.5 w-3.5", "aria-hidden": true }),
                                    React.createElement("span", null, availability.directTenantRt.reason))),
                            React.createElement("div", { className: "flex flex-col gap-2" },
                                React.createElement("div", { className: "flex items-center gap-2" },
                                    React.createElement(Label, { className: "text-xs uppercase tracking-wider text-muted-foreground" }, "Method"),
                                    React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setWizardOpen(true), className: "h-6 gap-1 px-2 text-2xs", title: "Open the per-flow education wizard \u2014 what each method does, when to use it, and the corpus playbook reference.", "aria-label": "Open flow-education wizard" },
                                        React.createElement(BookOpen, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Why this flow?")),
                                React.createElement("div", { className: "flex flex-wrap gap-2", role: "radiogroup", "aria-label": "Mint method" }, [
                                    {
                                        id: "auto",
                                        label: "Auto",
                                        hint: "Try MSAL silent, fall back to FOCI on failure.",
                                        icon: Sparkles,
                                    },
                                    {
                                        id: "msal-silent",
                                        label: "MSAL Silent",
                                        hint: "acquireTokenSilent against the target tenant authority.",
                                        icon: Repeat2,
                                    },
                                    {
                                        id: "foci-exchange",
                                        label: "FOCI exchange",
                                        hint: "POST grant_type=refresh_token to the target tenant's token endpoint.",
                                        icon: Zap,
                                    },
                                ].map((m) => {
                                    const Icon = m.icon;
                                    const selected = method === m.id;
                                    return (React.createElement("button", { key: m.id, type: "button", onClick: () => setMethod(m.id), className: cn("flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected
                                            ? "border-primary/60 bg-primary/10 text-foreground"
                                            : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground"), role: "radio", "aria-checked": selected, "aria-label": `${m.label}: ${m.hint}` },
                                        React.createElement(Icon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                        React.createElement("span", null, m.label),
                                        React.createElement(InfoTooltip, { content: m.hint, ariaLabel: `${m.label} method info` })));
                                }))),
                            React.createElement("div", { className: "flex flex-col gap-1 pt-1", role: "group", "aria-label": "Recently used login methods" },
                                React.createElement("div", { className: "flex items-center gap-2" },
                                    React.createElement(Label, { className: "text-xs uppercase tracking-wider text-muted-foreground" }, "Recently used"),
                                    React.createElement(InfoTooltip, { content: "Method + audience pairs you used recently. Stored as metadata only (no tokens, no claims). Click to re-apply; the X clears the entire list." }),
                                    recentMethods.length > 0 && (React.createElement(Button, { variant: "ghost", size: "sm", onClick: handleClearRecentMethods, className: "ml-auto h-6 gap-1 px-2 text-2xs", title: "Clear the recent-methods list (does not affect history).", "aria-label": "Clear recent methods" },
                                        React.createElement(Trash2, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Clear"))),
                                React.createElement("div", { className: "flex flex-wrap gap-1.5" }, recentMethods.length === 0 ? (React.createElement("span", { className: "text-2xs italic text-muted-foreground" }, "none yet \u2014 successful mints appear here")) : (recentMethods.map((r) => {
                                    const isCurrentPair = method === r.method && audienceId === r.audience;
                                    return (React.createElement("button", { key: `${r.method}|${r.audience}|${r.accountHint}`, type: "button", onClick: () => {
                                            setMethod(r.method);
                                            setAudienceId(r.audience);
                                            if (r.audience !== "custom") {
                                                setCustomScope(getAudienceChoice(r.audience).scope);
                                            }
                                        }, className: cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", isCurrentPair
                                            ? "border-primary/60 bg-primary/10"
                                            : "border-border bg-card/30 hover:bg-muted/40"), "aria-label": `Apply method ${methodShortLabel(r.method)} with audience ${r.audience.toUpperCase()} (used ${r.useCount}× by ${r.accountHint})`, title: `Last used ${r.lastUsedAt} by ${r.accountHint}; click to re-apply method + audience` },
                                        React.createElement(Clock, { className: "h-3 w-3", "aria-hidden": true }),
                                        React.createElement("span", { className: "font-mono" }, methodShortLabel(r.method)),
                                        React.createElement("span", { className: "text-muted-foreground" }, "\u00B7"),
                                        React.createElement("span", { className: "font-mono uppercase" }, r.audience),
                                        React.createElement("span", { className: "text-3xs text-muted-foreground" },
                                            "\u00D7",
                                            r.useCount)));
                                })))))),
                    React.createElement(Card, null,
                        React.createElement(CardHeader, null,
                            React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                                React.createElement(Award, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                                "Audience & mint"),
                            React.createElement(CardDescription, null,
                                "Pick the resource the new token should be valid for. Custom scope lets you target other Azure resource servers (must end in ",
                                React.createElement("code", null, "/.default"),
                                " for app-permission flows).")),
                        React.createElement(CardContent, { className: "flex flex-col gap-4" },
                            React.createElement("div", { className: "flex flex-wrap gap-2" }, AUDIENCE_CHOICES.map((c) => {
                                const selected = audienceId === c.id;
                                const accent = audienceChipAccent(c.id);
                                return (React.createElement("button", { key: c.id, type: "button", onClick: () => {
                                        setAudienceId(c.id);
                                        if (c.id !== "custom")
                                            setCustomScope(c.scope);
                                    }, className: cn("flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected
                                        ? "border-primary/60 bg-primary/10 text-foreground"
                                        : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground"), "aria-pressed": selected },
                                    React.createElement(Badge, { variant: accent.badge, className: "px-1.5 py-0" }, c.label),
                                    React.createElement(InfoTooltip, { content: c.description, ariaLabel: `${c.label} info` })));
                            })),
                            audienceId === "custom" && (React.createElement("div", { className: "flex flex-col gap-1" },
                                React.createElement(Label, { htmlFor: "tricky-custom-scope", className: "text-xs" }, "Custom scope"),
                                React.createElement(Input, { id: "tricky-custom-scope", value: customScope, onChange: (e) => setCustomScope(e.target.value), placeholder: "https://management.azure.com/.default", className: "font-mono text-xs", spellCheck: false }))),
                            realmProbe && realmProbe.status === "federated" && (React.createElement(Alert, { variant: "warning" },
                                React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                                React.createElement(AlertTitle, { className: "text-sm" }, "Federated account"),
                                React.createElement(AlertDescription, { className: "text-xs" },
                                    "Account",
                                    " ",
                                    React.createElement("code", { className: "font-mono" }, sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.username),
                                    " ",
                                    "is federated",
                                    realmProbe.domainName ? ` (domain ${realmProbe.domainName})` : "",
                                    ". Credentials are sent to",
                                    " ",
                                    React.createElement("code", { className: "font-mono" }, (_e = (_d = realmProbe.stsUrl) !== null && _d !== void 0 ? _d : realmProbe.authUrl) !== null && _e !== void 0 ? _e : "(STS URL absent)"),
                                    " ",
                                    "\u2014 not directly to Microsoft. Any MFA / password prompt during re-authentication goes to that STS.",
                                    realmProbe.federationProtocol && (React.createElement(React.Fragment, null,
                                        " ",
                                        "Protocol:",
                                        " ",
                                        React.createElement("code", { className: "font-mono" }, realmProbe.federationProtocol),
                                        "."))))),
                            realmProbe && realmProbe.status === "unknown" && (React.createElement("div", { className: "flex items-center gap-2 text-2xs text-muted-foreground" },
                                React.createElement(Info, { className: "h-3 w-3", "aria-hidden": true }),
                                "Realm discovery returned NameSpaceType=Unknown for",
                                " ",
                                React.createElement("code", { className: "font-mono" }, sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.username),
                                " ",
                                "\u2014 domain may be unregistered or non-AAD.")),
                            realmError && !realmProbe && (React.createElement("div", { className: "flex items-center gap-2 text-2xs text-muted-foreground" },
                                React.createElement(Info, { className: "h-3 w-3", "aria-hidden": true }),
                                "Could not probe federation realm (",
                                realmError,
                                "). Mint is still allowed; the alert is informational only.")),
                            realmLoading && (React.createElement("div", { className: "flex items-center gap-2 text-2xs text-muted-foreground" },
                                React.createElement(Loader2, { className: "h-3 w-3 animate-spin", "aria-hidden": true }),
                                "Probing federation realm for",
                                " ",
                                React.createElement("code", { className: "font-mono" }, sourceAccount === null || sourceAccount === void 0 ? void 0 : sourceAccount.username),
                                "\u2026")),
                            React.createElement("div", { className: "flex flex-wrap items-center gap-3" },
                                React.createElement(Button, { onClick: () => void doMint(), disabled: !canMint || batchMinting, loading: minting, className: "gap-2" },
                                    React.createElement(Sparkles, { className: "h-4 w-4", "aria-hidden": true }),
                                    "Mint silent token for",
                                    " ",
                                    targetTenantId
                                        ? findTenantLabel(tenantChoices, targetTenantId)
                                        : "(pick a tenant)"),
                                React.createElement(Button, { onClick: () => void doBatchMint(), disabled: !canMint || minting, loading: batchMinting, variant: "outline", className: "gap-2", title: "Mint 12 audience tokens for the same target tenant in one click" },
                                    React.createElement(Sparkles, { className: "h-4 w-4", "aria-hidden": true }),
                                    "Batch mint 12 audiences"),
                                React.createElement(Button, { variant: "ghost", onClick: () => void handleCopyDiagnostics(), className: "gap-2", title: "Copy a sanitized auth-diagnostics blob (no token material, no claims) to the clipboard.", "aria-label": "Copy sanitized auth diagnostics" },
                                    React.createElement(FileText, { className: "h-4 w-4", "aria-hidden": true }),
                                    "Copy auth diagnostics"),
                                mintSubStep && (React.createElement("span", { className: "flex items-center gap-1.5 text-2xs text-muted-foreground" },
                                    React.createElement(Loader2, { className: "h-3 w-3 animate-spin", "aria-hidden": true }),
                                    mintSubStep))),
                            batchMintResults.length > 0 && (React.createElement("div", { className: "flex flex-col gap-1 rounded-md border bg-card/30 p-3" },
                                React.createElement("div", { className: "flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                                    React.createElement(Sparkles, { className: "h-3 w-3", "aria-hidden": true }),
                                    "Batch mint results (",
                                    batchMintResults.filter((r) => r.status === "success").length,
                                    "/",
                                    batchMintResults.length,
                                    ")"),
                                React.createElement("table", { className: "w-full text-2xs" },
                                    React.createElement("thead", { className: "text-2xs uppercase text-muted-foreground" },
                                        React.createElement("tr", null,
                                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Audience"),
                                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Status"),
                                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Method"),
                                            React.createElement("th", { className: "px-2 py-1 text-left" }, "Tid match"),
                                            React.createElement("th", { className: "px-2 py-1 text-left" }, "ms"))),
                                    React.createElement("tbody", null, batchMintResults.map((r) => {
                                        var _a;
                                        const tidOk = r.actualTid &&
                                            targetTenantId &&
                                            r.actualTid.toLowerCase() === targetTenantId.toLowerCase();
                                        return (React.createElement("tr", { key: r.audience, className: "border-t" },
                                            React.createElement("td", { className: "px-2 py-1 font-mono uppercase" }, r.audience),
                                            React.createElement("td", { className: "px-2 py-1" }, r.status === "success" ? (React.createElement(Badge, { variant: "outline", className: "text-3xs" }, "ok")) : (React.createElement("span", { className: "text-destructive", title: r.error }, "failed"))),
                                            React.createElement("td", { className: "px-2 py-1 font-mono text-3xs" }, (_a = r.methodUsed) !== null && _a !== void 0 ? _a : "—"),
                                            React.createElement("td", { className: "px-2 py-1" }, r.status === "success" ? (tidOk ? (React.createElement(CheckCircle2, { className: "h-3 w-3 text-success", "aria-label": "tid match" })) : (React.createElement(AlertTriangle, { className: "h-3 w-3 text-destructive", "aria-label": "tid mismatch" }))) : ("—")),
                                            React.createElement("td", { className: "px-2 py-1 tabular-nums" }, r.durationMs)));
                                    }))),
                                React.createElement("span", { className: "text-3xs text-muted-foreground" }, "All successful tokens auto-imported into the vault. Switch to the target tenant via the header pill or open Token Importer to use them per-audience."))),
                            React.createElement("label", { className: "flex cursor-pointer select-none items-center gap-2 text-2xs text-muted-foreground" },
                                React.createElement("input", { type: "checkbox", checked: autoActivateOnSuccess, onChange: (e) => setAutoActivateOnSuccess(e.target.checked), className: "h-3.5 w-3.5", "aria-label": "Auto-activate the minted context on success" }),
                                React.createElement("span", null,
                                    React.createElement("strong", { className: "text-foreground" }, "Auto-activate on success"),
                                    " ",
                                    "\u2014 after a successful mint, automatically import the token to the vault AND switch the active tenant so every page in the app uses this context. (Off \u2192 manual: click Import / Set-active in the result panel.)")))),
                    autoAttempts.length > 0 && (React.createElement(Card, null,
                        React.createElement(CardHeader, { className: "pb-2" },
                            React.createElement(CardTitle, { className: "text-sm" }, "Auto-mode attempts"),
                            React.createElement(CardDescription, { className: "text-xs" }, "Each sub-attempt the Auto orchestrator made, in order.")),
                        React.createElement(CardContent, null,
                            React.createElement("ul", { className: "flex flex-col gap-1 text-xs" }, autoAttempts.map((a, i) => (React.createElement("li", { key: i, className: cn("flex items-start gap-2", a.status === "success"
                                    ? "text-success"
                                    : "text-destructive") },
                                a.status === "success" ? (React.createElement(CheckCircle2, { className: "mt-0.5 h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(XCircle, { className: "mt-0.5 h-3.5 w-3.5", "aria-hidden": true })),
                                React.createElement("span", null,
                                    React.createElement("span", { className: "font-medium" }, methodShortLabel(a.method)),
                                    " ",
                                    "\u2014 ",
                                    a.detail)))))))),
                    result && (React.createElement(Card, null,
                        React.createElement(CardHeader, { className: "pb-2" },
                            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                React.createElement(CardTitle, { className: "text-base" }, "Mint result"),
                                result.status === "success" ? (React.createElement(Badge, { variant: "success", className: "gap-1" },
                                    React.createElement(CheckCircle2, { className: "h-3 w-3", "aria-hidden": true }),
                                    "Success")) : (React.createElement(Badge, { variant: "destructive", className: "gap-1" },
                                    React.createElement(XCircle, { className: "h-3 w-3", "aria-hidden": true }),
                                    "Failure")),
                                React.createElement(Badge, { variant: "outline" },
                                    "Method: ",
                                    methodLabel(result.methodUsed)),
                                React.createElement(Badge, { variant: "outline" },
                                    "Audience:",
                                    " ",
                                    getAudienceChoice((_f = result.extendedAudience) !== null && _f !== void 0 ? _f : (result.audience === "unknown"
                                        ? "custom"
                                        : result.audience)).label),
                                React.createElement(Badge, { variant: "outline" },
                                    fmtDuration(result.durationMs / 1000),
                                    " elapsed"),
                                result.status === "success" && result.expiresAt && (React.createElement(Badge, { variant: "outline" }, formatExpiresIn(result.expiresAt))),
                                result.status === "failure" && result.errorCode && (React.createElement(Badge, { variant: "destructive" }, result.errorCode))),
                            React.createElement(CardDescription, { className: "text-xs" },
                                "Target tenant",
                                " ",
                                React.createElement("span", { className: "font-mono" }, result.targetTenantLabel),
                                " (",
                                result.targetTenantId,
                                "), source account",
                                " ",
                                React.createElement("span", { className: "font-mono" }, result.sourceAccountLabel),
                                ".")),
                        React.createElement(CardContent, { className: "flex flex-col gap-4" },
                            result.status === "failure" && (React.createElement(Alert, { variant: "destructive" },
                                React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                                React.createElement(AlertTitle, { className: "text-sm" },
                                    "Mint failed",
                                    result.errorCode ? ` — ${result.errorCode}` : ""),
                                React.createElement(AlertDescription, { className: "text-xs" },
                                    React.createElement("p", { className: "m-0 whitespace-pre-wrap break-all font-mono" }, result.errorMessage),
                                    (() => {
                                        var _a;
                                        const msg = (_a = result.errorMessage) !== null && _a !== void 0 ? _a : "";
                                        const needsReAuth = /interaction_required|invalid_grant|Cached session is no longer valid|AADSTS50173|AADSTS50058|AADSTS50076|AADSTS50079|AADSTS65001/i.test(msg);
                                        return (React.createElement("div", { className: "mt-3 flex flex-wrap gap-2" },
                                            needsReAuth && (React.createElement(Button, { variant: "default", size: "sm", onClick: () => void handleReAuthenticateAndRetry(), loading: reAuthing, disabled: reAuthing, className: "gap-1.5" },
                                                React.createElement(KeyRound, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                                "Re-authenticate ", sourceAccount === null || sourceAccount === void 0 ? void 0 :
                                                sourceAccount.username,
                                                " against",
                                                " ",
                                                result.targetTenantLabel,
                                                " (popup) & retry")),
                                            result.methodUsed !== "auto" && (React.createElement(Button, { variant: "outline", size: "sm", onClick: () => void doMint(result.methodUsed === "msal-silent"
                                                    ? "foci-exchange"
                                                    : "msal-silent") },
                                                "Try",
                                                " ",
                                                result.methodUsed === "msal-silent"
                                                    ? "FOCI exchange"
                                                    : "MSAL silent")),
                                            needsReAuth && (React.createElement("span", { className: "self-center text-2xs italic opacity-80" }, "MSAL's cached session for this account is gone \u2014 only an interactive popup can replace it. Routing the popup at the target tenant also makes you a member of it if you aren't already."))));
                                    })()))),
                            result.status === "success" && (React.createElement(React.Fragment, null,
                                (() => {
                                    var _a, _b, _c, _d, _e, _f;
                                    const actualTid = typeof ((_a = result.claims) === null || _a === void 0 ? void 0 : _a.tid) === "string"
                                        ? result.claims.tid
                                        : null;
                                    const ok = !!actualTid &&
                                        actualTid.toLowerCase() ===
                                            result.targetTenantId.toLowerCase();
                                    return (React.createElement("div", { className: cn("flex flex-col gap-1 rounded-md border p-3", ok
                                            ? "border-success/40 bg-success/5"
                                            : "border-destructive/40 bg-destructive/5") },
                                        React.createElement("div", { className: "flex items-center gap-2 text-xs font-semibold" },
                                            ok ? (React.createElement(CheckCircle2, { className: "h-4 w-4 text-success", "aria-hidden": true })) : (React.createElement(AlertTriangle, { className: "h-4 w-4 text-destructive", "aria-hidden": true })),
                                            React.createElement("span", null, ok
                                                ? "Tenant verification PASS — token tid matches requested target"
                                                : "Tenant verification FAIL — token tid does not match")),
                                        React.createElement("dl", { className: "grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 pt-1 text-2xs" },
                                            React.createElement("dt", { className: "text-muted-foreground" }, "Requested:"),
                                            React.createElement("dd", { className: "font-mono" }, result.targetTenantId),
                                            React.createElement("dt", { className: "text-muted-foreground" }, "Actual (token tid):"),
                                            React.createElement("dd", { className: "font-mono" }, actualTid !== null && actualTid !== void 0 ? actualTid : "(absent)"),
                                            React.createElement("dt", { className: "text-muted-foreground" }, "Audience (aud):"),
                                            React.createElement("dd", { className: "font-mono" }, typeof ((_b = result.claims) === null || _b === void 0 ? void 0 : _b.aud) === "string"
                                                ? result.claims.aud
                                                : "(absent)"),
                                            React.createElement("dt", { className: "text-muted-foreground" }, "App (azp/appid):"),
                                            React.createElement("dd", { className: "font-mono" }, (_f = (_d = (typeof ((_c = result.claims) === null || _c === void 0 ? void 0 : _c.azp) === "string"
                                                ? result.claims.azp
                                                : null)) !== null && _d !== void 0 ? _d : (typeof ((_e = result.claims) === null || _e === void 0 ? void 0 : _e.appid) === "string"
                                                ? result.claims.appid
                                                : null)) !== null && _f !== void 0 ? _f : "(absent)"))));
                                })(),
                                operatorAdvisories.length > 0 && (React.createElement("div", { className: "flex flex-col gap-2", role: "region", "aria-label": "Operator advisories" },
                                    React.createElement("div", { className: "flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                                        React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Operator advisories (",
                                        operatorAdvisories.length,
                                        ")",
                                        React.createElement(InfoTooltip, { content: "Corpus-grounded defensive advisories computed from the minted token's claims + the realm probe. Each entry cites the source playbook in the master research corpus." })),
                                    operatorAdvisories.map((adv) => (React.createElement(Alert, { key: adv.id, variant: adv.severity === "danger"
                                            ? "destructive"
                                            : adv.severity === "warning"
                                                ? "warning"
                                                : "info" },
                                        adv.severity === "danger" ? (React.createElement(ShieldAlert, { className: "h-4 w-4", "aria-hidden": true })) : adv.severity === "warning" ? (React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true })) : (React.createElement(Info, { className: "h-4 w-4", "aria-hidden": true })),
                                        React.createElement(AlertTitle, { className: "text-sm" }, adv.title),
                                        React.createElement(AlertDescription, { className: "text-xs" },
                                            React.createElement("p", { className: "m-0 whitespace-pre-wrap" }, adv.body),
                                            React.createElement("p", { className: "m-0 mt-2 text-2xs" },
                                                React.createElement("strong", null, "Action: "),
                                                adv.action),
                                            React.createElement("p", { className: "m-0 mt-1 text-3xs italic opacity-80" },
                                                "Corpus: ",
                                                React.createElement("code", { className: "font-mono" }, adv.corpusRef)))))))),
                                React.createElement("div", { className: "flex flex-col gap-1 rounded-md border bg-card/30 p-3" },
                                    React.createElement("div", { className: "flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                                        React.createElement(Sparkles, { className: "h-3 w-3", "aria-hidden": true }),
                                        "AAD endpoint hit (informational)",
                                        React.createElement(InfoTooltip, { content: "The actual /oauth2/v2.0/token URL the FOCI exchange path would POST to. MSAL silent acquire hits the same authority under the hood, but routes via the configured customNetworkClient (dev-server proxy). Copy this URL into curl / Postman with grant_type=refresh_token + client_id + refresh_token + scope to replay the exchange outside the app." })),
                                    React.createElement("code", { className: "break-all font-mono text-2xs" },
                                        "https://login.microsoftonline.com/",
                                        result.targetTenantId,
                                        "/oauth2/v2.0/token"),
                                    React.createElement("div", { className: "flex items-center gap-2 pt-1" },
                                        React.createElement(CopyableText, { value: `https://login.microsoftonline.com/${result.targetTenantId}/oauth2/v2.0/token`, mono: true, alwaysVisibleButton: true, ariaLabel: "Copy authority URL" }))),
                                React.createElement("div", { className: "flex flex-col gap-2" },
                                    React.createElement("div", { className: "flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                                        React.createElement(ChevronDown, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                        "Decoded access-token claims",
                                        React.createElement(InfoTooltip, { content: "Signature NOT verified \u2014 these are read straight off the JWT body. The remote resource server is the one that will accept or reject the token." }),
                                        React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setShowClaimsJson((v) => !v), "aria-pressed": showClaimsJson, className: "ml-auto h-6 gap-1 px-2 text-2xs", title: "Toggle a sanitized JSON view of the claim payload (JWT-shaped values redacted).", "aria-label": "Toggle JSON view of claims" },
                                            React.createElement(Braces, { className: "h-3 w-3", "aria-hidden": true }),
                                            showClaimsJson ? "Hide JSON" : "JSON")),
                                    showClaimsJson && (React.createElement("div", { className: "flex flex-col gap-1 rounded-md border bg-muted/20 p-2" },
                                        React.createElement("div", { className: "flex items-center justify-between gap-2 text-2xs uppercase tracking-wider text-muted-foreground" },
                                            React.createElement("span", null,
                                                "Sanitized claims JSON",
                                                React.createElement("span", { className: "ml-1 text-3xs italic opacity-70" }, "(JWT-shaped values \u2192 <jwt-redacted>)")),
                                            React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => void handleCopyClaimsJson(), className: "h-6 gap-1 px-2 text-2xs", "aria-label": "Copy sanitized claims JSON" },
                                                React.createElement(ClipboardCopy, { className: "h-3 w-3", "aria-hidden": true }),
                                                "Copy")),
                                        React.createElement("pre", { className: "m-0 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border bg-card/40 p-2 font-mono text-2xs leading-snug text-muted-foreground" }, sanitizedClaimsJson))),
                                    !compactView && (React.createElement("div", { className: "rounded-md border bg-card/50" },
                                        React.createElement("table", { className: "w-full text-xs" },
                                            React.createElement("thead", { className: "border-b text-2xs uppercase text-muted-foreground" },
                                                React.createElement("tr", null,
                                                    React.createElement("th", { className: "w-44 px-3 py-1.5 text-left font-medium" }, "Claim"),
                                                    React.createElement("th", { className: "px-3 py-1.5 text-left font-medium" }, "Value"))),
                                            React.createElement("tbody", null, Object.entries((_g = result.claims) !== null && _g !== void 0 ? _g : {})
                                                .sort(([a], [b]) => a.localeCompare(b))
                                                .map(([k, v]) => (React.createElement("tr", { key: k, className: "border-b last:border-b-0 hover:bg-muted/30" },
                                                React.createElement("td", { className: "px-3 py-1.5 align-top font-mono text-2xs" },
                                                    React.createElement("span", { className: "inline-flex items-center gap-1" },
                                                        k,
                                                        CLAIM_EXPLAIN[k] && (React.createElement(InfoTooltip, { content: CLAIM_EXPLAIN[k], ariaLabel: `${k} explained`, size: 12 })))),
                                                React.createElement("td", { className: "px-3 py-1.5 align-top break-all font-mono text-2xs text-muted-foreground" }, formatClaimValue(k, v))))))))),
                                    compactView && !showClaimsJson && (React.createElement("p", { className: "m-0 text-2xs italic text-muted-foreground" }, "Claims table hidden in compact view. Click \"JSON\" above to inspect the sanitized payload."))),
                                React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-xs" }, result.refreshToken ? (React.createElement(React.Fragment, null,
                                    React.createElement(Badge, { variant: "info", className: "gap-1" },
                                        React.createElement(KeyRound, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Refresh token returned"),
                                    React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setRtRevealed((v) => !v), className: "gap-1" },
                                        rtRevealed ? (React.createElement(EyeOff, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(Eye, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                                        rtRevealed ? "Hide" : "Reveal"),
                                    rtRevealed && (React.createElement("div", { className: "flex w-full items-center gap-2" },
                                        React.createElement("code", { className: "flex-1 break-all rounded border bg-muted/30 p-2 font-mono text-2xs text-muted-foreground" }, result.refreshToken),
                                        React.createElement(CopyButton, { value: result.refreshToken, alwaysVisible: true, ariaLabel: "Copy refresh token" }))))) : (React.createElement(Badge, { variant: "outline" }, "No refresh token returned"))),
                                result.accessToken && (React.createElement("div", { className: "flex flex-col gap-2" },
                                    React.createElement("div", { className: "flex flex-wrap items-center gap-2 text-xs" },
                                        React.createElement(Badge, { variant: "success", className: "gap-1" },
                                            React.createElement(KeyRound, { className: "h-3 w-3", "aria-hidden": true }),
                                            "Access token minted"),
                                        React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setTokenRevealed((v) => !v), className: "gap-1" },
                                            tokenRevealed ? (React.createElement(EyeOff, { className: "h-3.5 w-3.5", "aria-hidden": true })) : (React.createElement(Eye, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                                            tokenRevealed ? "Hide" : "Reveal"),
                                        React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" }, maskToken(result.accessToken))),
                                    tokenRevealed && (React.createElement("div", { className: "flex items-center gap-2" },
                                        React.createElement("code", { className: "flex-1 break-all rounded border bg-muted/30 p-2 font-mono text-2xs text-muted-foreground" }, result.accessToken),
                                        React.createElement(CopyButton, { value: result.accessToken, alwaysVisible: true, ariaLabel: "Copy access token" }))))),
                                (() => {
                                    var _a;
                                    const amrClaim = (_a = result.claims) === null || _a === void 0 ? void 0 : _a.amr;
                                    const amrList = Array.isArray(amrClaim)
                                        ? amrClaim.map((v) => String(v).toLowerCase())
                                        : typeof amrClaim === "string"
                                            ? [amrClaim.toLowerCase()]
                                            : [];
                                    const hasStrongAuth = amrList.some((m) => ["mfa", "ngcmfa", "wia"].includes(m));
                                    const showUpgrade = !hasStrongAuth;
                                    if (!showUpgrade)
                                        return null;
                                    return (React.createElement(Alert, { variant: "info", className: "mt-1" },
                                        React.createElement(Shield, { className: "h-4 w-4", "aria-hidden": true }),
                                        React.createElement(AlertTitle, { className: "text-sm" }, "Single-factor session detected"),
                                        React.createElement(AlertDescription, { className: "text-xs" },
                                            React.createElement("p", { className: "m-0" },
                                                "The minted access token's",
                                                " ",
                                                React.createElement("code", { className: "font-mono" }, "amr"),
                                                " claim is",
                                                " ",
                                                amrList.length === 0
                                                    ? "absent"
                                                    : `[${amrList.join(", ")}]`,
                                                " ",
                                                "\u2014 no MFA / ngcmfa / WIA marker. Resource servers that require a step-up (PIM activation, privileged Graph writes) will reject this token with",
                                                " ",
                                                React.createElement("code", { className: "font-mono" }, "interaction_required"),
                                                ". Re-authenticate with",
                                                " ",
                                                React.createElement("code", { className: "font-mono" }, "prompt=login"),
                                                " ",
                                                "so AAD re-evaluates the CA policy, then the mint will be retried automatically."),
                                            React.createElement("div", { className: "mt-2" },
                                                React.createElement(Button, { variant: "default", size: "sm", onClick: () => void handleMfaUpgrade(), loading: mfaUpgrading, disabled: mfaUpgrading, className: "gap-1.5" },
                                                    React.createElement(Lock, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                                    "Upgrade to MFA-bound token")))));
                                })(),
                                React.createElement("div", { className: "flex flex-wrap gap-2 pt-2" },
                                    React.createElement(Button, { variant: "outline", size: "sm", onClick: () => void handleImportToVault(), className: "gap-1" },
                                        React.createElement(KeyRound, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                        "Import to vault"),
                                    React.createElement(Button, { variant: "outline", size: "sm", onClick: () => void handleSetActive(), className: "gap-1" },
                                        React.createElement(Repeat2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                        "Set as active context"),
                                    React.createElement(Button, { variant: "outline", size: "sm", onClick: handleOpenInImporter, className: "gap-1" },
                                        React.createElement(ExternalLink, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                        "Open Token Importer"),
                                    React.createElement(Button, { variant: "outline", size: "sm", onClick: () => void handleCopyToken(), className: "gap-1" },
                                        React.createElement(ClipboardCopy, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                        "Copy raw token"))))))),
                    React.createElement(Card, null,
                        React.createElement(CardHeader, { className: "pb-2" },
                            React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                                React.createElement(RefreshCcw, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                                "History",
                                React.createElement(InfoTooltip, { content: "Session-scoped: persists to sessionStorage so navigating away + back keeps the log, but a tab close wipes it. Capped at 20 entries." })),
                            React.createElement(CardDescription, null, "Past mint attempts (most recent first). Replay re-runs the same source / target / method / audience combination.")),
                        React.createElement(CardContent, null, history.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, "No attempts yet.")) : (React.createElement("div", { className: "overflow-x-auto rounded-md border" },
                            React.createElement("table", { className: "w-full text-xs" },
                                React.createElement("thead", { className: "border-b bg-muted/30 text-2xs uppercase text-muted-foreground" },
                                    React.createElement("tr", null,
                                        React.createElement("th", { className: "px-3 py-2 text-left font-medium" }, "When"),
                                        React.createElement("th", { className: "px-3 py-2 text-left font-medium" }, "Source account"),
                                        React.createElement("th", { className: "px-3 py-2 text-left font-medium" }, "Target tenant"),
                                        React.createElement("th", { className: "px-3 py-2 text-left font-medium" }, "Method"),
                                        React.createElement("th", { className: "px-3 py-2 text-left font-medium" }, "Audience"),
                                        React.createElement("th", { className: "px-3 py-2 text-left font-medium" }, "Status"),
                                        React.createElement("th", { className: "px-3 py-2 text-left font-medium" }, "Took"),
                                        React.createElement("th", { className: "px-3 py-2 text-right font-medium" }))),
                                React.createElement("tbody", null, history.map((row) => {
                                    var _a, _b, _c;
                                    return (React.createElement("tr", { key: row.id, className: "border-b last:border-b-0 hover:bg-muted/30" },
                                        React.createElement("td", { className: "px-3 py-1.5 text-2xs text-muted-foreground" },
                                            React.createElement("span", { title: formatDateTime(row.finishedAt) }, formatRelativeTime(row.finishedAt))),
                                        React.createElement("td", { className: "px-3 py-1.5 font-mono text-2xs" }, row.sourceAccountLabel),
                                        React.createElement("td", { className: "px-3 py-1.5" },
                                            React.createElement("div", { className: "flex flex-col" },
                                                React.createElement("span", null, row.targetTenantLabel),
                                                React.createElement("span", { className: "font-mono text-3xs text-muted-foreground" }, row.targetTenantId))),
                                        React.createElement("td", { className: "px-3 py-1.5" },
                                            React.createElement(Badge, { variant: "outline", className: "px-1.5 py-0" }, methodShortLabel(row.methodUsed))),
                                        React.createElement("td", { className: "px-3 py-1.5" },
                                            React.createElement(Badge, { variant: "outline", className: "px-1.5 py-0" }, ((_a = row.extendedAudience) !== null && _a !== void 0 ? _a : row.audience).toUpperCase())),
                                        React.createElement("td", { className: "px-3 py-1.5" }, row.status === "success" ? (React.createElement(Badge, { variant: "success", className: "px-1.5 py-0" }, "ok")) : (React.createElement(Badge, { variant: "destructive", className: "px-1.5 py-0", title: (_b = row.errorCode) !== null && _b !== void 0 ? _b : "failure" }, (_c = row.errorCode) !== null && _c !== void 0 ? _c : "fail"))),
                                        React.createElement("td", { className: "px-3 py-1.5 text-2xs text-muted-foreground" }, fmtDuration(row.durationMs / 1000)),
                                        React.createElement("td", { className: "px-3 py-1.5 text-right" },
                                            React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => handleReplay(row), disabled: minting, className: "gap-1", title: "Re-run this attempt with the same parameters" },
                                                React.createElement(RefreshCcw, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                                "Replay"))));
                                }))))))),
                    !compactView && (React.createElement(Card, null,
                        React.createElement(CardHeader, { className: "pb-2" },
                            React.createElement(CardTitle, { className: "flex items-center gap-2 text-base" },
                                React.createElement(Info, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                                "About this page")),
                        React.createElement(CardContent, null,
                            React.createElement("dl", { className: "grid gap-3 text-xs sm:grid-cols-2" },
                                React.createElement("div", null,
                                    React.createElement("dt", { className: "font-semibold text-foreground" }, "What it does"),
                                    React.createElement("dd", { className: "m-0 mt-0.5 text-muted-foreground" }, "Silently mints access tokens for tenants the signed-in operator can already reach (member, guest, partner) \u2014 without re-entering credentials. Useful when an admin has been B2B-invited into a customer tenant and wants an ARM / Graph / Batch token for it from their existing session.")),
                                React.createElement("div", null,
                                    React.createElement("dt", { className: "font-semibold text-foreground" }, "Why it is not an offensive primitive"),
                                    React.createElement("dd", { className: "m-0 mt-0.5 text-muted-foreground" }, "No credentials are stolen. Silent acquisition only succeeds when the operator has already authenticated and the target tenant has granted them access. We never prompt for a password, never touch the operator's PRT / device cert, and never reach into another principal's MSAL cache.")),
                                React.createElement("div", null,
                                    React.createElement("dt", { className: "font-semibold text-foreground" }, "Three methods, all defensive"),
                                    React.createElement("dd", { className: "m-0 mt-0.5 text-muted-foreground" },
                                        React.createElement("span", { className: "block" },
                                            "\u2460 ",
                                            React.createElement("em", null, "MSAL silent multi-tenant"),
                                            " \u2014",
                                            React.createElement("code", { className: "ml-1" }, "acquireTokenSilent"),
                                            " with the target tenant authority."),
                                        React.createElement("span", { className: "block" },
                                            "\u2461 ",
                                            React.createElement("em", null, "FOCI refresh-token exchange"),
                                            " \u2014 spends an already-imported refresh token at the target tenant's token endpoint."),
                                        React.createElement("span", { className: "block" },
                                            "\u2462 ",
                                            React.createElement("em", null, "Auto"),
                                            " \u2014 tries MSAL first, falls back to FOCI if MSAL surfaces interaction_required."))),
                                React.createElement("div", null,
                                    React.createElement("dt", { className: "font-semibold text-foreground" }, "Audit + credit"),
                                    React.createElement("dd", { className: "m-0 mt-0.5 text-muted-foreground" },
                                        "Every mint records to the audit log under",
                                        " ",
                                        React.createElement("code", null, "tricky_login_mint"),
                                        ", with method, audience, duration, and the resulting ",
                                        React.createElement("code", null, "aud"),
                                        " claim only \u2014 NEVER the token material. The page concept is a defensive flip of tricks documented in",
                                        " ",
                                        React.createElement("a", { href: "https://github.com/dirkjanm/ROADtools", target: "_blank", rel: "noreferrer", className: "text-primary underline-offset-2 hover:underline" }, "ROADtools (roadtx)"),
                                        " ",
                                        "and",
                                        " ",
                                        React.createElement("a", { href: "https://github.com/Gerenios/AADInternals", target: "_blank", rel: "noreferrer", className: "text-primary underline-offset-2 hover:underline" }, "AADInternals"),
                                        "."))))))),
                React.createElement(TabsContent, { value: "sp", className: "flex flex-col gap-6" },
                    React.createElement(SpLoginTab, null)))))));
};
//# sourceMappingURL=tricky-login-page.js.map