import { __awaiter } from "tslib";
/**
 * EA Subscription page — provisions Azure subscriptions under an
 * Enterprise Agreement (or MCA) billing scope, one per recipient.
 * Uses a Popover + Command picker for fuzzy multi-recipient selection,
 * zod-validated form, EmptyState for the unauthenticated path, and
 * ConfirmationDialog for the irreversible create step.
 *
 * Sibling files (extracted from this page to keep its surface scannable
 * and improve re-render isolation):
 *
 *   - `./accept-ownership-panel.tsx` — destination-tenant companion for
 *     the cross-tenant flow (operator pastes a subscriptionId and accepts
 *     ownership inline).
 *   - `./copyable-id.tsx`            — shared "copy to clipboard" pill.
 *   - `./ea-helpers.ts`              — pure utilities (parseBulkRecipients,
 *     suggestRemediation, categorizeError, azurePortalLinkForSubscription,
 *     formatElapsedSec, UUID/ALIAS regex, randomSuffix, generateBatchId).
 *   - `./pre-flight-panel.tsx`       — corpus-grounded signature panel
 *     (cross-tenant fan-out, mixed-recipient anomaly, self-replication,
 *     manual-paste-heavy) + pre-create audit-event simulation.
 *     Cite: `_ea_subscription_cross_tenant.md` §1, §9.
 *   - `./reconciliation-tile.tsx`    — post-batch steady-state bucket
 *     (steady / alias-only / pending-acceptance / failed / stale).
 *     Cite: `_bypass_modify_delete.md`.
 *   - `./recipient-templates.tsx`    — persisted recipient lists for
 *     repeated batches; localStorage via `usePersistedState`.
 *   - `./corpus-signatures.ts`       — pure detection helpers consumed by
 *     `pre-flight-panel.tsx`.
 *
 * Hotkeys: `Ctrl/Cmd + Enter` opens the create-subscription confirmation
 * when the form is ready; `Escape` cancels the confirm dialog (but never
 * aborts an in-flight batch).
 *
 * Screen readers get an off-screen `aria-live="polite"` announcer near the
 * top of the rendered tree that emits short batch-milestone strings
 * ("Provisioning subscriptions: 3 of 10 complete", "Batch complete.")
 * in addition to the visible Provisioning Summary card.
 */
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, AlertTriangle, BadgeCheck, Building2, Check, CheckCircle2, ChevronRight, ChevronsUpDown, ClipboardPaste, Download, ExternalLink, FileSignature, Filter, Hourglass, IdCard, Info, Link2, Loader2, PartyPopper, PlusCircle, Receipt, RefreshCw, RotateCcw, ShieldAlert, Sparkles, Trash2, Users, Wallet, X, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, } from "@/components/ui/command";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger, } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn, downloadCsv, downloadJson } from "@/lib/utils";
import { decodeJwtClaimsUnsafe, getActiveTenant, getArmTokenForAccount, } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { auditLog } from "../../services/audit-log";
import { buildAcceptOwnershipPortalUrl, createEaSubscription, diagnoseCallerBillingRole, listBillingProfiles, listEaBillingAccounts, listEnrollmentAccounts, listInvoiceSections, probeEaCapability, } from "../../services/arm-service";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { useArmToken } from "../../auth/use-arm-token";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { PageHeader } from "../shared/page-header";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { AcceptOwnershipPanel } from "./accept-ownership-panel";
import { CopyableId } from "./copyable-id";
import { ALIAS_REGEX, azurePortalLinkForSubscription, categorizeError, formatElapsedSec, generateBatchId, isValidAlias, isValidUuid, parseBulkRecipients, randomSuffix, suggestRemediation, truncateMiddle, UUID_REGEX, } from "./ea-helpers";
import { PreFlightPanel } from "./pre-flight-panel";
import { ReconciliationTile } from "./reconciliation-tile";
import { RecipientTemplates } from "./recipient-templates";
const ACTIVE_KEY_STORAGE = "ea-subscription:active-account";
const RECIPIENTS_STORAGE = "ea-subscription:recipients";
const SELF_ASSIGN_STORAGE = "ea-subscription:self-assign";
function recipientKey(source, r) {
    return `${source}:${r.tenantId}:${r.ownerObjectId}`;
}
function dedupeKey(r) {
    var _a, _b;
    // Hardened: malformed/partial recipients (e.g. a row hydrated from
    // sessionStorage with a missing tenantId or ownerObjectId) used to
    // throw "Cannot read properties of undefined (reading 'toLowerCase')"
    // here during render. Fall back to empty strings so the dedupe key
    // is still stable for the missing-field case.
    return `${((_a = r.tenantId) !== null && _a !== void 0 ? _a : "").toLowerCase()}:${((_b = r.ownerObjectId) !== null && _b !== void 0 ? _b : "").toLowerCase()}`;
}
function deriveAlias(recipient) {
    var _a, _b, _c;
    const seedRaw = (_c = (_b = (_a = recipient.upn) === null || _a === void 0 ? void 0 : _a.split("@")[0]) !== null && _b !== void 0 ? _b : recipient.displayLabel) !== null && _c !== void 0 ? _c : recipient.ownerObjectId;
    const seed = seedRaw
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "sub";
    return `sub-${seed}-${randomSuffix(5)}`;
}
function deriveDisplayName(recipient) {
    const base = `Sub for ${recipient.displayLabel || recipient.upn || recipient.ownerObjectId}`;
    return base.length > 64 ? `${base.slice(0, 61)}...` : base;
}
/**
 * Visual replacement for a `<Select>` when the user is choosing one of a
 * small set of billing-hierarchy entities. Cards make the picked node
 * obvious and let us surface secondary metadata (cost center, owner,
 * agreement type) without a dropdown overlay.
 */
const ScopeCard = ({ selected, onSelect, title, subtitle, meta, badge, disabled, }) => (React.createElement("button", { type: "button", onClick: onSelect, disabled: disabled, "aria-pressed": selected, className: cn("group flex w-full items-start gap-3 rounded-lg border bg-card px-3 py-2.5 text-left", "transition-all duration-200 ease-out", "hover:border-primary/60 hover:bg-accent/5 hover:shadow-elev-1", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background", "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:shadow-none", selected
        ? "border-primary bg-primary/5 shadow-elev-1 ring-1 ring-primary/30"
        : "border-border") },
    React.createElement("span", { "aria-hidden": true, className: cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150", selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background group-hover:border-primary/60") }, selected && React.createElement(Check, { className: "h-3 w-3", "aria-hidden": true })),
    React.createElement("span", { className: "flex min-w-0 flex-1 flex-col gap-0.5" },
        React.createElement("span", { className: "flex items-center gap-2" },
            React.createElement("span", { className: "truncate text-sm font-medium text-foreground" }, title),
            badge),
        subtitle && (React.createElement("span", { className: "truncate font-mono text-2xs text-muted-foreground" }, subtitle)),
        meta && (React.createElement("span", { className: "mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground" }, meta)))));
const recipientSchema = z.object({
    key: z.string(),
    source: z.union([
        z.literal("web-account"),
        z.literal("tenant-user"),
        z.literal("manual"),
    ]),
    tenantId: z.string().regex(UUID_REGEX, "Tenant ID must be a GUID."),
    ownerObjectId: z.string().regex(UUID_REGEX, "Owner ID must be a GUID."),
    displayLabel: z.string().min(1),
    upn: z.string().optional(),
    tenantLabel: z.string().optional(),
    enabled: z.boolean().optional(),
});
const formSchema = z
    .object({
    aliasName: z
        .string()
        .min(3, "Alias must be at least 3 characters.")
        .max(63, "Alias must be at most 63 characters.")
        .regex(ALIAS_REGEX, "Alias must use lowercase letters, digits, or hyphens."),
    displayName: z
        .string()
        .min(1, "Display name is required.")
        .max(64, "Display name must be at most 64 characters."),
    billingScope: z.string().min(1, "Billing scope is required."),
    selfAssign: z.boolean(),
    recipients: z.array(recipientSchema),
})
    .refine((v) => v.selfAssign || v.recipients.length > 0, {
    message: "Pick at least one recipient.",
    path: ["recipients"],
});
const EaSubscriptionPageInner = ({ onNavigate, }) => {
    var _a, _b;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    const [eaCapabilityMap, setEaCapabilityMap] = React.useState({});
    const [discoveringEa, setDiscoveringEa] = React.useState(true);
    const accountKey = React.useMemo(() => azureAccounts
        .map((a) => { var _a; return `${a.homeAccountId}|${(_a = resolveActiveTenantId(a)) !== null && _a !== void 0 ? _a : ""}`; })
        .sort()
        .join(","), [azureAccounts]);
    // EA-capability probe — runs every signed-in account through the billing
    // API so we can render only the EA-capable ones. Uses `useAbortableEffect`
    // so an in-flight probe is dropped if `accountKey` changes mid-flight
    // (e.g. a parallel sign-in completes) — the signal short-circuits the
    // setState calls below. `probeEaCapability` itself does not accept a
    // signal yet, so we still let any pending HTTPs finish but discard the
    // result if the effect was torn down.
    useAbortableEffect((signal) => __awaiter(void 0, void 0, void 0, function* () {
        setDiscoveringEa(true);
        const next = {};
        yield Promise.allSettled(azureAccounts.map((a) => __awaiter(void 0, void 0, void 0, function* () {
            var _c;
            if (signal.aborted || !a.homeAccountId)
                return;
            const tenantId = (_c = getActiveTenant(a.homeAccountId)) !== null && _c !== void 0 ? _c : a.tenantId;
            if (!tenantId) {
                next[a.homeAccountId] = { hasEa: false, billingAccountCount: 0 };
                return;
            }
            try {
                const token = yield getArmTokenForAccount(a.homeAccountId, tenantId);
                if (signal.aborted)
                    return;
                const cap = yield probeEaCapability(token);
                if (signal.aborted)
                    return;
                next[a.homeAccountId] = {
                    hasEa: cap.hasEa,
                    billingAccountCount: cap.billingAccountCount,
                };
            }
            catch (_d) {
                if (signal.aborted)
                    return;
                next[a.homeAccountId] = { hasEa: false, billingAccountCount: 0 };
            }
        })));
        if (signal.aborted)
            return;
        setEaCapabilityMap(next);
        setDiscoveringEa(false);
    }), [accountKey, azureAccounts]);
    const eaAccounts = React.useMemo(() => {
        return azureAccounts
            .filter((a) => { var _a; return (_a = eaCapabilityMap[a.homeAccountId]) === null || _a === void 0 ? void 0 : _a.hasEa; })
            .map((a) => {
            var _a, _b, _c;
            return ({
                homeAccountId: a.homeAccountId,
                tenantId: (_a = getActiveTenant(a.homeAccountId)) !== null && _a !== void 0 ? _a : a.tenantId,
                username: a.username,
                name: a.name || a.username,
                localAccountId: a.localAccountId,
                billingAccountCount: (_c = (_b = eaCapabilityMap[a.homeAccountId]) === null || _b === void 0 ? void 0 : _b.billingAccountCount) !== null && _c !== void 0 ? _c : 0,
            });
        })
            .filter((a) => a.tenantId);
    }, [azureAccounts, eaCapabilityMap]);
    const [activeKey, setActiveKey] = React.useState(() => {
        var _a;
        try {
            return (_a = sessionStorage.getItem(ACTIVE_KEY_STORAGE)) !== null && _a !== void 0 ? _a : "";
        }
        catch (_b) {
            return "";
        }
    });
    React.useEffect(() => {
        if (eaAccounts.length === 0)
            return;
        const exists = eaAccounts.some((a) => a.homeAccountId === activeKey);
        if (!exists) {
            const next = eaAccounts[0].homeAccountId;
            setActiveKey(next);
            try {
                sessionStorage.setItem(ACTIVE_KEY_STORAGE, next);
            }
            catch (_a) {
                /* sessionStorage may be unavailable in some sandboxed contexts */
            }
        }
    }, [eaAccounts, activeKey]);
    const handleSelectAccount = React.useCallback((key) => {
        setActiveKey(key);
        try {
            sessionStorage.setItem(ACTIVE_KEY_STORAGE, key);
        }
        catch (_a) {
            /* sessionStorage may be unavailable in some sandboxed contexts */
        }
        // Audit the active-account switch so the timeline shows which EA
        // identity was in scope when subsequent billing / submission events
        // landed. Previously this was silent — making post-mortem of a wrong-
        // account submission much harder.
        auditLog.record({
            actor: key,
            action: "ea_subscription_select_account",
            target: key,
            status: "success",
            details: { homeAccountId: key },
        });
    }, []);
    const activeAccount = React.useMemo(() => { var _a; return (_a = eaAccounts.find((a) => a.homeAccountId === activeKey)) !== null && _a !== void 0 ? _a : null; }, [eaAccounts, activeKey]);
    // Centralized ARM-token tracker for the active EA-capable account.
    // Runs in parallel with the existing per-call `getArmTokenForAccount`
    // logic (which we intentionally leave intact — the recipient batcher
    // re-mints tokens per-tenant and against caller-billing-role
    // diagnostics, both of which need bespoke control flow). This hook
    // exists purely so the operator can see a live expiry badge on a page
    // that often sits open while they curate a recipient list and review
    // diagnostics, and force a refresh before submitting a multi-recipient
    // batch that may run past the auto-refresh window.
    const armTokenTracker = useArmToken(activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.homeAccountId, activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.tenantId);
    const [billingAccounts, setBillingAccounts] = React.useState([]);
    const [billingProfiles, setBillingProfiles] = React.useState([]);
    const [invoiceSections, setInvoiceSections] = React.useState([]);
    const [enrollmentAccounts, setEnrollmentAccounts] = React.useState([]);
    const [selectedBillingAccount, setSelectedBillingAccount] = React.useState("");
    const [selectedBillingProfile, setSelectedBillingProfile] = React.useState("");
    const [selectedInvoiceSection, setSelectedInvoiceSection] = React.useState("");
    const [selectedEnrollmentAccount, setSelectedEnrollmentAccount] = React.useState("");
    const [loadingBa, setLoadingBa] = React.useState(false);
    const [loadingBp, setLoadingBp] = React.useState(false);
    const [loadingIs, setLoadingIs] = React.useState(false);
    const [loadingEnrollmentAccounts, setLoadingEnrollmentAccounts] = React.useState(false);
    const [errBa, setErrBa] = React.useState(null);
    const [errBp, setErrBp] = React.useState(null);
    const [errIs, setErrIs] = React.useState(null);
    const [enrollmentAccountsError, setEnrollmentAccountsError] = React.useState(null);
    const selectedBillingAccountObj = React.useMemo(() => billingAccounts.find((b) => b.name === selectedBillingAccount), [billingAccounts, selectedBillingAccount]);
    const isEa = (selectedBillingAccountObj === null || selectedBillingAccountObj === void 0 ? void 0 : selectedBillingAccountObj.agreementType) === "EnterpriseAgreement";
    // Tracks the latest in-flight load so a slow earlier request (e.g. the
    // user switched accounts before the previous fetch resolved) can't clobber
    // a newer response — classic last-fetch-wins race fix.
    const billingLoadSeqRef = React.useRef(0);
    const loadBillingAccounts = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!activeAccount)
            return;
        const seq = ++billingLoadSeqRef.current;
        setLoadingBa(true);
        setErrBa(null);
        try {
            const token = yield getArmTokenForAccount(activeAccount.homeAccountId, activeAccount.tenantId);
            const list = yield listEaBillingAccounts(token);
            if (seq !== billingLoadSeqRef.current)
                return;
            setBillingAccounts(list);
            if (list.length === 1) {
                setSelectedBillingAccount(list[0].name);
            }
            else {
                setSelectedBillingAccount("");
            }
        }
        catch (e) {
            if (seq !== billingLoadSeqRef.current)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setErrBa(msg);
            setBillingAccounts([]);
        }
        finally {
            if (seq === billingLoadSeqRef.current) {
                setLoadingBa(false);
            }
        }
    }), [activeAccount]);
    React.useEffect(() => {
        if (activeAccount) {
            // Invalidate any in-flight load from the previous account so its
            // response is silently dropped instead of overwriting our reset state.
            billingLoadSeqRef.current += 1;
            setBillingAccounts([]);
            setBillingProfiles([]);
            setInvoiceSections([]);
            setEnrollmentAccounts([]);
            setSelectedBillingAccount("");
            setSelectedBillingProfile("");
            setSelectedInvoiceSection("");
            setSelectedEnrollmentAccount("");
            loadBillingAccounts();
        }
    }, [activeAccount, loadBillingAccounts]);
    // Independent seq counters for each downstream loader — switching the
    // selected billing account mid-fetch must not let an older response set
    // billing profiles / enrollment accounts that belong to the previous BA.
    const profileLoadSeqRef = React.useRef(0);
    const enrollmentLoadSeqRef = React.useRef(0);
    const invoiceLoadSeqRef = React.useRef(0);
    const loadBillingProfiles = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!activeAccount || !selectedBillingAccount)
            return;
        const seq = ++profileLoadSeqRef.current;
        setLoadingBp(true);
        setErrBp(null);
        try {
            const token = yield getArmTokenForAccount(activeAccount.homeAccountId, activeAccount.tenantId);
            const list = yield listBillingProfiles(selectedBillingAccount, token);
            if (seq !== profileLoadSeqRef.current)
                return;
            setBillingProfiles(list);
            if (list.length === 1) {
                setSelectedBillingProfile(list[0].name);
            }
            else {
                setSelectedBillingProfile("");
            }
        }
        catch (e) {
            if (seq !== profileLoadSeqRef.current)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setErrBp(msg);
            setBillingProfiles([]);
        }
        finally {
            if (seq === profileLoadSeqRef.current) {
                setLoadingBp(false);
            }
        }
    }), [activeAccount, selectedBillingAccount]);
    const loadEnrollmentAccounts = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!activeAccount || !selectedBillingAccount)
            return;
        const seq = ++enrollmentLoadSeqRef.current;
        setLoadingEnrollmentAccounts(true);
        setEnrollmentAccountsError(null);
        try {
            const token = yield getArmTokenForAccount(activeAccount.homeAccountId, activeAccount.tenantId);
            const list = yield listEnrollmentAccounts(selectedBillingAccount, token);
            if (seq !== enrollmentLoadSeqRef.current)
                return;
            setEnrollmentAccounts(list);
            if (list.length === 1) {
                setSelectedEnrollmentAccount(list[0].name);
            }
            else {
                setSelectedEnrollmentAccount("");
            }
        }
        catch (e) {
            if (seq !== enrollmentLoadSeqRef.current)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setEnrollmentAccountsError(msg);
            setEnrollmentAccounts([]);
        }
        finally {
            if (seq === enrollmentLoadSeqRef.current) {
                setLoadingEnrollmentAccounts(false);
            }
        }
    }), [activeAccount, selectedBillingAccount]);
    React.useEffect(() => {
        // Invalidate any in-flight profile / enrollment fetches before resetting.
        profileLoadSeqRef.current += 1;
        enrollmentLoadSeqRef.current += 1;
        invoiceLoadSeqRef.current += 1;
        setBillingProfiles([]);
        setInvoiceSections([]);
        setEnrollmentAccounts([]);
        setSelectedBillingProfile("");
        setSelectedInvoiceSection("");
        setSelectedEnrollmentAccount("");
        if (!selectedBillingAccount)
            return;
        if (isEa) {
            loadEnrollmentAccounts();
        }
        else {
            loadBillingProfiles();
        }
    }, [
        selectedBillingAccount,
        isEa,
        loadBillingProfiles,
        loadEnrollmentAccounts,
    ]);
    const loadInvoiceSections = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!activeAccount || !selectedBillingAccount || !selectedBillingProfile)
            return;
        const seq = ++invoiceLoadSeqRef.current;
        setLoadingIs(true);
        setErrIs(null);
        try {
            const token = yield getArmTokenForAccount(activeAccount.homeAccountId, activeAccount.tenantId);
            const list = yield listInvoiceSections(selectedBillingAccount, selectedBillingProfile, token);
            if (seq !== invoiceLoadSeqRef.current)
                return;
            setInvoiceSections(list);
            if (list.length === 1) {
                setSelectedInvoiceSection(list[0].name);
            }
            else {
                setSelectedInvoiceSection("");
            }
        }
        catch (e) {
            if (seq !== invoiceLoadSeqRef.current)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setErrIs(msg);
            setInvoiceSections([]);
        }
        finally {
            if (seq === invoiceLoadSeqRef.current) {
                setLoadingIs(false);
            }
        }
    }), [activeAccount, selectedBillingAccount, selectedBillingProfile]);
    React.useEffect(() => {
        invoiceLoadSeqRef.current += 1;
        setInvoiceSections([]);
        setSelectedInvoiceSection("");
        if (!isEa && selectedBillingAccount && selectedBillingProfile) {
            loadInvoiceSections();
        }
    }, [
        isEa,
        selectedBillingAccount,
        selectedBillingProfile,
        loadInvoiceSections,
    ]);
    const knownTenants = React.useMemo(() => {
        var _a;
        const map = new Map();
        for (const a of azureAccounts) {
            for (const t of (_a = a.tenants) !== null && _a !== void 0 ? _a : []) {
                if (!map.has(t.tenantId))
                    map.set(t.tenantId, t);
            }
        }
        return Array.from(map.values());
    }, [azureAccounts]);
    const tenantLabelFor = React.useCallback((tenantId) => {
        var _a, _b;
        const t = knownTenants.find((x) => x.tenantId === tenantId);
        return ((_b = (_a = t === null || t === void 0 ? void 0 : t.displayName) !== null && _a !== void 0 ? _a : t === null || t === void 0 ? void 0 : t.defaultDomain) !== null && _b !== void 0 ? _b : truncateMiddle(tenantId, 8, 4));
    }, [knownTenants]);
    const webAccountRecipients = React.useMemo(() => {
        const out = [];
        for (const a of azureAccounts) {
            const ownerObjectId = a.localAccountId;
            if (!ownerObjectId)
                continue;
            const tenantId = resolveActiveTenantId(a);
            if (!tenantId || !isValidUuid(tenantId) || !isValidUuid(ownerObjectId))
                continue;
            out.push({
                key: recipientKey("web-account", { tenantId, ownerObjectId }),
                source: "web-account",
                tenantId,
                ownerObjectId,
                displayLabel: a.name || a.username,
                upn: a.username,
                tenantLabel: tenantLabelFor(tenantId),
                enabled: true,
            });
        }
        return out;
    }, [azureAccounts, tenantLabelFor]);
    const tenantUserGroups = React.useMemo(() => {
        var _a;
        const buckets = (_a = state.tenantUsers) !== null && _a !== void 0 ? _a : {};
        return Object.keys(buckets)
            .filter((tid) => isValidUuid(tid))
            .map((tenantId) => {
            var _a;
            return ({
                tenantId,
                tenantLabel: tenantLabelFor(tenantId),
                users: (_a = buckets[tenantId]) !== null && _a !== void 0 ? _a : [],
            });
        })
            .filter((g) => g.users.length > 0);
    }, [state.tenantUsers, tenantLabelFor]);
    const tenantUserRecipients = React.useMemo(() => {
        const out = [];
        for (const g of tenantUserGroups) {
            for (const u of g.users) {
                if (!isValidUuid(u.id))
                    continue;
                out.push({
                    key: recipientKey("tenant-user", {
                        tenantId: g.tenantId,
                        ownerObjectId: u.id,
                    }),
                    source: "tenant-user",
                    tenantId: g.tenantId,
                    ownerObjectId: u.id,
                    displayLabel: u.displayName || u.userPrincipalName || u.id,
                    upn: u.userPrincipalName,
                    tenantLabel: g.tenantLabel,
                    enabled: u.accountEnabled !== false,
                });
            }
        }
        return out;
    }, [tenantUserGroups]);
    const recipientCatalog = React.useMemo(() => {
        const map = new Map();
        for (const r of webAccountRecipients)
            map.set(r.key, r);
        for (const r of tenantUserRecipients) {
            if (!map.has(r.key))
                map.set(r.key, r);
        }
        return map;
    }, [webAccountRecipients, tenantUserRecipients]);
    const initialSelfAssign = React.useMemo(() => {
        try {
            return sessionStorage.getItem(SELF_ASSIGN_STORAGE) === "1";
        }
        catch (_a) {
            return false;
        }
    }, []);
    const form = useForm({
        resolver: zodResolver(formSchema),
        mode: "onChange",
        defaultValues: {
            aliasName: "",
            displayName: "",
            billingScope: "",
            selfAssign: initialSelfAssign,
            recipients: [],
        },
    });
    const selfAssign = form.watch("selfAssign");
    const selectedRecipients = form.watch("recipients");
    const aliasNameField = form.watch("aliasName");
    const displayNameField = form.watch("displayName");
    React.useEffect(() => {
        try {
            sessionStorage.setItem(SELF_ASSIGN_STORAGE, selfAssign ? "1" : "0");
        }
        catch (_a) {
            /* sessionStorage may be unavailable in some sandboxed contexts */
        }
    }, [selfAssign]);
    const [recipientsHydrated, setRecipientsHydrated] = React.useState(false);
    React.useEffect(() => {
        if (recipientsHydrated)
            return;
        if (azureAccounts.length === 0 && tenantUserRecipients.length === 0)
            return;
        let raw = null;
        try {
            raw = sessionStorage.getItem(RECIPIENTS_STORAGE);
        }
        catch (_a) {
            raw = null;
        }
        if (!raw) {
            setRecipientsHydrated(true);
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            const next = [];
            const seen = new Set();
            for (const p of parsed) {
                if (!p || !p.tenantId || !p.ownerObjectId)
                    continue;
                const dk = dedupeKey(p);
                if (seen.has(dk))
                    continue;
                if (p.source === "manual") {
                    if (!isValidUuid(p.tenantId) || !isValidUuid(p.ownerObjectId))
                        continue;
                    next.push({
                        key: `manual:${p.tenantId}:${p.ownerObjectId}`,
                        source: "manual",
                        tenantId: p.tenantId,
                        ownerObjectId: p.ownerObjectId,
                        displayLabel: `Manual (${truncateMiddle(p.ownerObjectId, 8, 4)})`,
                        tenantLabel: tenantLabelFor(p.tenantId),
                    });
                    seen.add(dk);
                }
                else {
                    const found = recipientCatalog.get(p.key);
                    if (found) {
                        next.push(found);
                        seen.add(dk);
                    }
                }
            }
            form.setValue("recipients", next, { shouldValidate: true });
        }
        catch (_b) {
            /* malformed cache - ignore and start fresh */
        }
        setRecipientsHydrated(true);
    }, [
        recipientsHydrated,
        azureAccounts.length,
        tenantUserRecipients.length,
        recipientCatalog,
        tenantLabelFor,
        form,
    ]);
    React.useEffect(() => {
        if (!recipientsHydrated)
            return;
        try {
            const persistable = selectedRecipients.map((r) => ({
                key: r.key,
                source: r.source,
                tenantId: r.tenantId,
                ownerObjectId: r.ownerObjectId,
            }));
            sessionStorage.setItem(RECIPIENTS_STORAGE, JSON.stringify(persistable));
        }
        catch (_a) {
            /* sessionStorage may be unavailable in some sandboxed contexts */
        }
    }, [selectedRecipients, recipientsHydrated]);
    const selectedDedupeKeys = React.useMemo(() => {
        const set = new Set();
        for (const r of selectedRecipients)
            set.add(dedupeKey(r));
        return set;
    }, [selectedRecipients]);
    const isSelected = React.useCallback((r) => selectedDedupeKeys.has(dedupeKey(r)), [selectedDedupeKeys]);
    const toggleRecipient = React.useCallback((r, on) => {
        const prev = form.getValues("recipients");
        const dk = dedupeKey(r);
        let next;
        if (on) {
            if (prev.some((x) => dedupeKey(x) === dk))
                return;
            next = [...prev, r];
        }
        else {
            next = prev.filter((x) => dedupeKey(x) !== dk);
        }
        form.setValue("recipients", next, { shouldValidate: true });
    }, [form]);
    const removeRecipient = React.useCallback((key) => {
        var _a;
        const prev = form.getValues("recipients");
        const removed = prev.find((r) => r.key === key);
        form.setValue("recipients", prev.filter((r) => r.key !== key), { shouldValidate: true });
        if (removed) {
            auditLog.record({
                actor: (_a = activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username) !== null && _a !== void 0 ? _a : "anonymous",
                action: "ea_subscription_remove_recipient",
                target: removed.ownerObjectId,
                status: "success",
                details: {
                    tenantId: removed.tenantId,
                    source: removed.source,
                    displayLabel: removed.displayLabel,
                },
            });
        }
    }, [form, activeAccount]);
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const [showManualPaste, setShowManualPaste] = React.useState(false);
    const [manualTenantId, setManualTenantId] = React.useState("");
    const [manualOwnerId, setManualOwnerId] = React.useState("");
    const manualTenantValid = isValidUuid(manualTenantId);
    const manualOwnerValid = isValidUuid(manualOwnerId);
    const handleAddManual = React.useCallback(() => {
        var _a;
        if (!manualTenantValid || !manualOwnerValid)
            return;
        const tenantId = manualTenantId.trim();
        const ownerObjectId = manualOwnerId.trim();
        const r = {
            key: `manual:${tenantId}:${ownerObjectId}`,
            source: "manual",
            tenantId,
            ownerObjectId,
            displayLabel: `Manual (${truncateMiddle(ownerObjectId, 8, 4)})`,
            tenantLabel: tenantLabelFor(tenantId),
        };
        toggleRecipient(r, true);
        setManualTenantId("");
        setManualOwnerId("");
        auditLog.record({
            actor: (_a = activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username) !== null && _a !== void 0 ? _a : "anonymous",
            action: "ea_subscription_add_manual_recipient",
            target: ownerObjectId,
            status: "success",
            details: { tenantId, source: "manual" },
        });
    }, [
        manualTenantValid,
        manualOwnerValid,
        manualTenantId,
        manualOwnerId,
        tenantLabelFor,
        toggleRecipient,
        activeAccount,
    ]);
    // Bulk paste — accepts CSV / whitespace-separated `(tenantId, ownerObjectId)`
    // pairs (one per line) and adds them all to the recipient list in one shot.
    // Indispensable for batches of 20+ recipients where adding one at a time
    // through the manual paste form is unbearable.
    const [bulkPasteOpen, setBulkPasteOpen] = React.useState(false);
    const [bulkPasteText, setBulkPasteText] = React.useState("");
    const bulkParseResult = React.useMemo(() => parseBulkRecipients(bulkPasteText, 500), [bulkPasteText]);
    const handleBulkAdd = React.useCallback(() => {
        var _a, _b;
        if (bulkParseResult.pairs.length === 0)
            return;
        const prev = form.getValues("recipients");
        const seen = new Set(prev.map((p) => dedupeKey(p)));
        const added = [];
        for (const pair of bulkParseResult.pairs) {
            const dk = dedupeKey(pair);
            if (seen.has(dk))
                continue;
            seen.add(dk);
            // Prefer an existing catalog entry (web account / tenant user) so the
            // operator sees the friendly display name they typed in. Otherwise
            // fall back to a manual recipient.
            const wkey = recipientKey("web-account", pair);
            const tkey = recipientKey("tenant-user", pair);
            const fromCatalog = (_a = recipientCatalog.get(wkey)) !== null && _a !== void 0 ? _a : recipientCatalog.get(tkey);
            if (fromCatalog) {
                added.push(fromCatalog);
            }
            else {
                added.push({
                    key: `manual:${pair.tenantId}:${pair.ownerObjectId}`,
                    source: "manual",
                    tenantId: pair.tenantId,
                    ownerObjectId: pair.ownerObjectId,
                    displayLabel: `Manual (${truncateMiddle(pair.ownerObjectId, 8, 4)})`,
                    tenantLabel: tenantLabelFor(pair.tenantId),
                });
            }
        }
        if (added.length > 0) {
            form.setValue("recipients", [...prev, ...added], {
                shouldValidate: true,
            });
        }
        setBulkPasteText("");
        store.addNotification({
            type: added.length > 0 ? "success" : "info",
            message: added.length === 0
                ? "Bulk paste added no new recipients — all were duplicates or invalid."
                : `Bulk paste added ${added.length} recipient${added.length === 1 ? "" : "s"}` +
                    (bulkParseResult.errors.length > 0
                        ? ` (${bulkParseResult.errors.length} invalid row${bulkParseResult.errors.length === 1 ? "" : "s"} skipped).`
                        : "."),
        });
        auditLog.record({
            actor: (_b = activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username) !== null && _b !== void 0 ? _b : "anonymous",
            action: "ea_subscription_bulk_paste_recipients",
            target: `${added.length} added`,
            status: "success",
            details: {
                validRows: bulkParseResult.pairs.length,
                addedCount: added.length,
                duplicateCount: bulkParseResult.pairs.length - added.length,
                invalidCount: bulkParseResult.errors.length,
                truncated: bulkParseResult.truncated,
            },
        });
    }, [
        bulkParseResult,
        form,
        recipientCatalog,
        tenantLabelFor,
        store,
        activeAccount,
    ]);
    // "Select all in tenant" — power-user shortcut on the Command picker.
    // For tenants with hundreds of users this saves the operator from
    // shift-clicking every row.
    const handleSelectAllInTenant = React.useCallback((tenantId, users) => {
        var _a;
        const prev = form.getValues("recipients");
        const seen = new Set(prev.map((p) => dedupeKey(p)));
        const added = [];
        for (const r of users) {
            if (r.enabled === false)
                continue;
            const dk = dedupeKey(r);
            if (seen.has(dk))
                continue;
            seen.add(dk);
            added.push(r);
        }
        if (added.length > 0) {
            form.setValue("recipients", [...prev, ...added], {
                shouldValidate: true,
            });
            store.addNotification({
                type: "success",
                message: `Added ${added.length} recipient${added.length === 1 ? "" : "s"} from this tenant.`,
            });
        }
        auditLog.record({
            actor: (_a = activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username) !== null && _a !== void 0 ? _a : "anonymous",
            action: "ea_subscription_select_all_in_tenant",
            target: tenantId,
            status: "success",
            details: { addedCount: added.length, tenantId },
        });
    }, [form, store, activeAccount]);
    const handleClearRecipients = React.useCallback(() => {
        var _a;
        const prevCount = form.getValues("recipients").length;
        if (prevCount === 0)
            return;
        form.setValue("recipients", [], { shouldValidate: true });
        store.addNotification({
            type: "info",
            message: `Cleared ${prevCount} recipient${prevCount === 1 ? "" : "s"}.`,
        });
        auditLog.record({
            actor: (_a = activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username) !== null && _a !== void 0 ? _a : "anonymous",
            action: "ea_subscription_clear_recipients",
            target: `${prevCount} cleared`,
            status: "success",
            details: { previousCount: prevCount },
        });
    }, [form, store, activeAccount]);
    const selectedBillingProfileObj = React.useMemo(() => billingProfiles.find((p) => p.name === selectedBillingProfile), [billingProfiles, selectedBillingProfile]);
    const selectedInvoiceSectionObj = React.useMemo(() => invoiceSections.find((s) => s.name === selectedInvoiceSection), [invoiceSections, selectedInvoiceSection]);
    const selectedEnrollmentAccountObj = React.useMemo(() => enrollmentAccounts.find((e) => e.name === selectedEnrollmentAccount), [enrollmentAccounts, selectedEnrollmentAccount]);
    const billingScope = React.useMemo(() => {
        var _a, _b;
        if (!selectedBillingAccount)
            return "";
        if (isEa) {
            return (_a = selectedEnrollmentAccountObj === null || selectedEnrollmentAccountObj === void 0 ? void 0 : selectedEnrollmentAccountObj.id) !== null && _a !== void 0 ? _a : "";
        }
        return (_b = selectedInvoiceSectionObj === null || selectedInvoiceSectionObj === void 0 ? void 0 : selectedInvoiceSectionObj.id) !== null && _b !== void 0 ? _b : "";
    }, [
        isEa,
        selectedBillingAccount,
        selectedEnrollmentAccountObj,
        selectedInvoiceSectionObj,
    ]);
    // Hoisted up from the JSX so it can be referenced by performSubmit (audit
    // events log the human-readable scope leaf, not just the ARM id).
    const confirmLeafName = isEa
        ? selectedEnrollmentAccountObj === null || selectedEnrollmentAccountObj === void 0 ? void 0 : selectedEnrollmentAccountObj.displayName
        : selectedInvoiceSectionObj === null || selectedInvoiceSectionObj === void 0 ? void 0 : selectedInvoiceSectionObj.displayName;
    // Keep zod-validated `billingScope` in sync with the cascade selection.
    React.useEffect(() => {
        form.setValue("billingScope", billingScope, { shouldValidate: true });
    }, [billingScope, form]);
    const leafSelectionReady = isEa
        ? Boolean(selectedEnrollmentAccount)
        : Boolean(selectedBillingProfile && selectedInvoiceSection);
    const selfAssignRecipient = React.useMemo(() => {
        if (!selfAssign || !activeAccount)
            return null;
        if (!activeAccount.localAccountId ||
            !isValidUuid(activeAccount.localAccountId) ||
            !isValidUuid(activeAccount.tenantId)) {
            return null;
        }
        return {
            key: recipientKey("web-account", {
                tenantId: activeAccount.tenantId,
                ownerObjectId: activeAccount.localAccountId,
            }),
            source: "web-account",
            tenantId: activeAccount.tenantId,
            ownerObjectId: activeAccount.localAccountId,
            displayLabel: activeAccount.name || activeAccount.username,
            upn: activeAccount.username,
            tenantLabel: tenantLabelFor(activeAccount.tenantId),
            enabled: true,
        };
    }, [selfAssign, activeAccount, tenantLabelFor]);
    const effectiveRecipients = React.useMemo(() => {
        if (selfAssign)
            return selfAssignRecipient ? [selfAssignRecipient] : [];
        return selectedRecipients;
    }, [selfAssign, selfAssignRecipient, selectedRecipients]);
    // Pre-computed per-batch stats for the KPI tile row above the
    // Provisioning Summary. Memoized off `effectiveRecipients` so the four
    // tiles don't re-derive on every keystroke in the alias / display-name
    // inputs.
    const recipientStats = React.useMemo(() => {
        var _a;
        const callerTid = (_a = activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.tenantId.toLowerCase()) !== null && _a !== void 0 ? _a : "";
        let crossTenant = 0;
        let disabled = 0;
        const tenantSet = new Set();
        for (const r of effectiveRecipients) {
            tenantSet.add(r.tenantId);
            if (callerTid && r.tenantId.toLowerCase() !== callerTid)
                crossTenant += 1;
            if (r.enabled === false)
                disabled += 1;
        }
        return {
            total: effectiveRecipients.length,
            crossTenant,
            disabled,
            tenantSpan: tenantSet.size,
        };
    }, [effectiveRecipients, activeAccount]);
    // Auto-derive a default alias + display name from the first recipient
    // so the zod-required fields populate even when the user does not type
    // anything. Users may still override.
    const aliasTouched = form.formState.dirtyFields.aliasName;
    const displayTouched = form.formState.dirtyFields.displayName;
    React.useEffect(() => {
        const first = effectiveRecipients[0];
        if (!first)
            return;
        if (!aliasTouched) {
            let alias = deriveAlias(first);
            if (!isValidAlias(alias)) {
                alias = `sub-${randomSuffix(5)}-${Date.now().toString(36).slice(-4)}`;
            }
            form.setValue("aliasName", alias, { shouldValidate: true });
        }
        if (!displayTouched) {
            form.setValue("displayName", deriveDisplayName(first), {
                shouldValidate: true,
            });
        }
    }, [effectiveRecipients, aliasTouched, displayTouched, form]);
    const validRecipientsForSubmit = selfAssign && selfAssignRecipient
        ? true
        : !selfAssign && selectedRecipients.length > 0;
    const formReady = Boolean(activeAccount) &&
        leafSelectionReady &&
        Boolean(billingScope) &&
        validRecipientsForSubmit &&
        form.formState.isValid;
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    // Wall-clock elapsed time during a submit, in seconds. Set to a monotonic
    // start timestamp on submit, ticks every 1s while submitting, and freezes
    // at the final value when the batch completes — surfaced to the user
    // because the alias polling loop can take 30-90 seconds and we want them
    // to see *something* moving instead of a static spinner.
    const [submitStartedAt, setSubmitStartedAt] = React.useState(null);
    const [submitElapsedSec, setSubmitElapsedSec] = React.useState(0);
    React.useEffect(() => {
        if (!submitting || submitStartedAt === null)
            return;
        const id = window.setInterval(() => {
            setSubmitElapsedSec(Math.max(0, Math.round((Date.now() - submitStartedAt) / 1000)));
        }, 1000);
        return () => {
            window.clearInterval(id);
        };
    }, [submitting, submitStartedAt]);
    const [statusMap, setStatusMap] = React.useState({});
    const [batchErrors, setBatchErrors] = React.useState([]);
    // Decoded JWT claims of the ARM token used for the most recent submit.
    // Populated when the token is acquired; rendered in the failure card so
    // the user can verify tenant/oid/aud match what their EA role expects.
    const [tokenDiagnostic, setTokenDiagnostic] = React.useState(null);
    // Result of probing the billingRoleAssignments API at the active scope
    // for the caller's principalId. Auto-populated when a 401 is detected in
    // batchErrors so the user can see exactly which roles (if any) they
    // actually hold at the enrollment account scope.
    const [roleDiagnostic, setRoleDiagnostic] = React.useState(null);
    const [roleDiagnosticLoading, setRoleDiagnosticLoading] = React.useState(false);
    const [roleDiagnosticError, setRoleDiagnosticError] = React.useState(null);
    // The most recent successful ARM token + billingScope, kept so the role
    // diagnostic can re-run without prompting another sign-in.
    const lastSubmitContextRef = React.useRef(null);
    // Detect whether any failure in the current batch is a 401 / authorization
    // error — used as the trigger to auto-run the billing-role diagnostic.
    const hasAuthFailure = React.useMemo(() => batchErrors.some((b) => /401|not authorized|authoriz|billingpermission/i.test(b.error)), [batchErrors]);
    // Detect MSAL session-death failures — the user's cached refresh
    // token is dead (expired, revoked, MFA stale, password changed) and
    // ONLY an interactive popup can recover. Silent retry / Retry failed
    // is useless against these; we surface a dedicated "Sign in again"
    // button that calls armTokenTracker.reauth() to pop the MSAL prompt.
    const hasStaleSession = React.useMemo(() => batchErrors.some((b) => /interaction_required|invalid_grant|Cached session is no longer valid|AADSTS50173|AADSTS50058|AADSTS50076|AADSTS50079|AADSTS65001/i.test(b.error)), [batchErrors]);
    // Auto-fire the role diagnostic the first time a 401 appears. We have
    // the token + billingScope + caller oid stashed in lastSubmitContextRef;
    // calling listBillingRoleAssignments at the enrollmentAccount scope tells
    // us the ground truth about whether the principal is granted the
    // sufficient EA roles, vs. the 401 telling us only "no" without saying
    // why.
    React.useEffect(() => {
        if (!hasAuthFailure)
            return;
        if (roleDiagnostic !== null)
            return;
        if (roleDiagnosticLoading)
            return;
        const ctx = lastSubmitContextRef.current;
        if (!ctx)
            return;
        let cancelled = false;
        setRoleDiagnosticLoading(true);
        setRoleDiagnosticError(null);
        (() => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const result = yield diagnoseCallerBillingRole(ctx.billingScope, ctx.principalId, ctx.token);
                if (!cancelled)
                    setRoleDiagnostic(result);
            }
            catch (e) {
                if (!cancelled) {
                    setRoleDiagnosticError(e instanceof Error ? e.message : String(e));
                }
            }
            finally {
                if (!cancelled)
                    setRoleDiagnosticLoading(false);
            }
        }))();
        return () => {
            cancelled = true;
        };
    }, [hasAuthFailure, roleDiagnostic, roleDiagnosticLoading]);
    const completedCount = React.useMemo(() => Object.values(statusMap).filter((s) => s.state === "success" || s.state === "failure").length, [statusMap]);
    const totalInFlight = React.useMemo(() => Object.keys(statusMap).length, [statusMap]);
    // Live wall-clock tick at 1 Hz used by every `running` row in the per-
    // recipient strip to recompute its "Xs elapsed" label. Without this
    // single shared tick the rows freeze at the time of the last
    // setStatusMap call.
    const [, tickNow] = React.useState(0);
    React.useEffect(() => {
        if (!submitting)
            return;
        const id = window.setInterval(() => tickNow((t) => t + 1), 1000);
        return () => {
            window.clearInterval(id);
        };
    }, [submitting]);
    // Race-safety: every submit gets a monotonic batchId. Stale per-
    // recipient setStatusMap callbacks fired after the user kicked off a
    // newer batch must not clobber the new statusMap. Same idea as the
    // billingLoadSeqRef pattern earlier in the file.
    const batchIdRef = React.useRef(0);
    // Adjustable concurrency. 1 = strictly serial (lowest pressure on EA
    // billing API), 5 = parallel up to 5 (faster but more likely to trip
    // throttles on large enrollments).
    //
    // Persisted via `usePersistedState` (localStorage) so a power-user who
    // always runs 5 doesn't have to re-select after every reload. The
    // versioned envelope makes future migrations (e.g. add a "10" option)
    // safe — older payloads fall back to the default.
    const [concurrencyChoice, setConcurrencyChoice] = usePersistedState("ea-subscription:concurrency", "3", {
        version: 1,
        migrate: (raw) => raw === "1" || raw === "3" || raw === "5" ? raw : undefined,
    });
    // Track which recipient keys should be re-run on the next submit. When
    // empty, performSubmit runs against every effective recipient. When
    // populated (Retry failed flow), only those keys are scheduled — and
    // their previous failure status is preserved as "pending" so the
    // success rows from the prior batch remain visible above.
    const [retryOnlyKeys, setRetryOnlyKeys] = React.useState(null);
    const performSubmit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _e, _f, _g, _h, _j, _k;
        if (!activeAccount || !formReady)
            return;
        const myBatchId = ++batchIdRef.current;
        const batchKey = generateBatchId();
        setSubmitting(true);
        setSubmitStartedAt(Date.now());
        setSubmitElapsedSec(0);
        setBatchErrors([]);
        setTokenDiagnostic(null);
        setRoleDiagnostic(null);
        setRoleDiagnosticError(null);
        lastSubmitContextRef.current = null;
        // Either run every selected recipient, or only the ones the operator
        // queued via "Retry failed". In retry mode we preserve the prior
        // statusMap and just reset the targeted rows to `pending`.
        const isRetry = retryOnlyKeys !== null && retryOnlyKeys.size > 0;
        const recipients = isRetry
            ? effectiveRecipients.filter((r) => retryOnlyKeys.has(r.key))
            : effectiveRecipients;
        // Defensive: if the operator removed every failed recipient between
        // clicking Retry failed and confirming the dialog, just bail out
        // cleanly instead of submitting an empty batch.
        if (recipients.length === 0) {
            setSubmitting(false);
            setConfirmOpen(false);
            setRetryOnlyKeys(null);
            store.addNotification({
                type: "info",
                message: "Retry skipped — no failed recipients remain in the current selection.",
            });
            return;
        }
        if (isRetry) {
            setStatusMap((prev) => {
                const next = Object.assign({}, prev);
                for (const r of recipients)
                    next[r.key] = { state: "pending" };
                return next;
            });
        }
        else {
            const initial = {};
            for (const r of recipients)
                initial[r.key] = { state: "pending" };
            setStatusMap(initial);
        }
        const actor = activeAccount.username ||
            activeAccount.name ||
            activeAccount.homeAccountId;
        // Batch-level audit — surfaces "this operator started a batch of N
        // recipients against this enrollment account at this time" even
        // if every per-recipient call subsequently fails. Makes the audit
        // log a complete activity timeline without needing to reconstruct
        // batch context from individual per-recipient records.
        auditLog.record({
            actor,
            action: "create_ea_subscription_batch_start",
            target: confirmLeafName !== null && confirmLeafName !== void 0 ? confirmLeafName : billingScope,
            status: "success",
            details: {
                batchKey,
                recipientCount: recipients.length,
                billingAccount: selectedBillingAccount,
                billingProfile: isEa ? undefined : selectedBillingProfile,
                invoiceSection: isEa ? undefined : selectedInvoiceSection,
                enrollmentAccount: isEa ? selectedEnrollmentAccount : undefined,
                billingScope,
                concurrency: parseInt(concurrencyChoice, 10),
                retryOnly: isRetry,
            },
        });
        // Force a fresh ARM token. The Subscription Alias / EA Subscription
        // Creator role check fails on a token minted BEFORE the role was
        // granted — even with the role correctly assigned now — until a
        // round-trip to Entra ID produces a token whose claims see the new
        // assignment. forceRefresh: true bypasses MSAL's silent cache.
        let token;
        try {
            token = yield getArmTokenForAccount(activeAccount.homeAccountId, activeAccount.tenantId, { forceRefresh: true });
        }
        catch (e) {
            // Stale acquire — a newer batch superseded us. Drop silently.
            if (myBatchId !== batchIdRef.current)
                return;
            const msg = e instanceof Error ? e.message : String(e);
            const now = Date.now();
            setStatusMap((prev) => {
                const next = Object.assign({}, prev);
                const errs = [];
                for (const r of recipients) {
                    next[r.key] = {
                        state: "failure",
                        error: msg,
                        startedAt: now,
                        completedAt: now,
                    };
                    errs.push({ key: r.key, label: r.displayLabel, error: msg });
                }
                setBatchErrors(errs);
                return next;
            });
            auditLog.record({
                actor,
                action: "create_ea_subscription_batch_end",
                target: confirmLeafName !== null && confirmLeafName !== void 0 ? confirmLeafName : billingScope,
                status: "failure",
                error: `Token acquisition failed: ${msg}`,
                details: {
                    batchKey,
                    recipientCount: recipients.length,
                    successCount: 0,
                    failureCount: recipients.length,
                },
            });
            setSubmitting(false);
            setConfirmOpen(false);
            setRetryOnlyKeys(null);
            return;
        }
        // Decode the token's claims (no signature verification — diagnostic
        // display only). The tid / oid / aud surface in the failure card so
        // the user can confirm the token is from the expected tenant + identity
        // and was issued for ARM. Set once per submit attempt; consumed by the
        // batchErrors UI when a 401 is observed.
        const tokenClaims = decodeJwtClaimsUnsafe(token);
        const callerOid = tokenClaims ? String((_e = tokenClaims.oid) !== null && _e !== void 0 ? _e : "") : "";
        setTokenDiagnostic(tokenClaims
            ? {
                tid: String((_f = tokenClaims.tid) !== null && _f !== void 0 ? _f : ""),
                oid: callerOid,
                upn: String((_j = (_h = (_g = tokenClaims.upn) !== null && _g !== void 0 ? _g : tokenClaims.preferred_username) !== null && _h !== void 0 ? _h : tokenClaims.unique_name) !== null && _j !== void 0 ? _j : ""),
                aud: String((_k = tokenClaims.aud) !== null && _k !== void 0 ? _k : ""),
                issuedAt: typeof tokenClaims.iat === "number"
                    ? new Date(tokenClaims.iat * 1000).toISOString()
                    : "",
            }
            : null);
        // Stash the (token, billingScope, principalId) tuple so the role
        // diagnostic can run when a 401 lands without re-prompting the user
        // for a fresh token.
        if (callerOid && billingScope) {
            lastSubmitContextRef.current = {
                token,
                billingScope,
                principalId: callerOid,
            };
        }
        const concurrency = parseInt(concurrencyChoice, 10) || 3;
        const queue = [...recipients];
        const localErrors = [];
        const successfulKeys = [];
        // Race-aware setStatusMap: silently no-op if a newer batch has
        // superseded this one. The recipient `key` may have been recycled
        // by the new batch with a different intended state.
        const safeSet = (key, mut) => {
            if (myBatchId !== batchIdRef.current)
                return;
            setStatusMap((prev) => (Object.assign(Object.assign({}, prev), { [key]: mut(prev[key]) })));
        };
        const runOne = (r) => __awaiter(void 0, void 0, void 0, function* () {
            const startedAt = Date.now();
            safeSet(r.key, () => ({ state: "running", startedAt }));
            // For multi-recipient batches we always re-derive a unique alias per
            // recipient to keep aliases stable+predictable. For a single
            // recipient we honour the user-edited alias from the form.
            let alias = recipients.length === 1 && form.getValues("aliasName")
                ? form.getValues("aliasName")
                : deriveAlias(r);
            if (!isValidAlias(alias)) {
                alias = `sub-${randomSuffix(5)}-${Date.now().toString(36).slice(-4)}`;
            }
            const displayName = recipients.length === 1 && form.getValues("displayName")
                ? form.getValues("displayName")
                : deriveDisplayName(r);
            const req = {
                aliasName: alias,
                displayName,
                billingScope,
                workload: "Production",
                subscriptionTenantId: r.tenantId,
                subscriptionOwnerId: r.ownerObjectId,
                // Idempotency: the alias name itself is the natural idempotency
                // key for the Subscription Alias API (a second PUT with the
                // same alias against the same scope is a no-op when the first
                // succeeded). We additionally tag the new subscription with
                // the batch key + recipient key so this provisioning event is
                // discoverable via Azure Activity Log and our local audit log.
                // Tags persist on the subscription resource indefinitely.
                tags: {
                    "ea-batch-key": batchKey,
                    "ea-recipient-key": r.key.slice(0, 64),
                    "provisioned-by": "azurebatchmanager",
                },
            };
            try {
                const result = yield createEaSubscription(req, token);
                const completedAt = Date.now();
                if (myBatchId !== batchIdRef.current) {
                    // Stale — the operator kicked a newer batch; don't record.
                    return;
                }
                safeSet(r.key, () => ({
                    state: "success",
                    subscriptionId: result.subscriptionId,
                    aliasName: result.aliasName,
                    startedAt,
                    completedAt,
                }));
                successfulKeys.push(r.key);
                auditLog.record({
                    actor,
                    action: "create_ea_subscription",
                    target: r.displayLabel,
                    status: "success",
                    details: {
                        batchKey,
                        aliasName: result.aliasName,
                        subscriptionId: result.subscriptionId,
                        billingScope,
                        workload: "Production",
                        billingAccount: selectedBillingAccount,
                        billingProfile: isEa ? undefined : selectedBillingProfile,
                        invoiceSection: isEa ? undefined : selectedInvoiceSection,
                        enrollmentAccount: isEa ? selectedEnrollmentAccount : undefined,
                        subscriptionTenantId: r.tenantId,
                        subscriptionOwnerId: r.ownerObjectId,
                        recipientLabel: r.displayLabel,
                        recipientSource: r.source,
                        elapsedMs: completedAt - startedAt,
                    },
                });
                store.addNotification({
                    type: "success",
                    message: result.subscriptionId
                        ? `Subscription provisioned for ${r.displayLabel} (id: ${result.subscriptionId})`
                        : `Subscription alias '${result.aliasName}' provisioned for ${r.displayLabel}.`,
                });
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                const completedAt = Date.now();
                if (myBatchId !== batchIdRef.current)
                    return;
                safeSet(r.key, () => ({
                    state: "failure",
                    error: msg,
                    startedAt,
                    completedAt,
                }));
                localErrors.push({ key: r.key, label: r.displayLabel, error: msg });
                auditLog.record({
                    actor,
                    action: "create_ea_subscription",
                    target: r.displayLabel,
                    status: "failure",
                    error: msg,
                    details: {
                        batchKey,
                        aliasName: alias,
                        billingScope,
                        workload: "Production",
                        billingAccount: selectedBillingAccount,
                        billingProfile: isEa ? undefined : selectedBillingProfile,
                        invoiceSection: isEa ? undefined : selectedInvoiceSection,
                        enrollmentAccount: isEa ? selectedEnrollmentAccount : undefined,
                        subscriptionTenantId: r.tenantId,
                        subscriptionOwnerId: r.ownerObjectId,
                        recipientLabel: r.displayLabel,
                        recipientSource: r.source,
                        elapsedMs: completedAt - startedAt,
                        errorCategory: categorizeError(msg).label,
                    },
                });
            }
        });
        const workers = [];
        const next = () => __awaiter(void 0, void 0, void 0, function* () {
            while (queue.length > 0) {
                // Cooperative cancellation — if a newer batch is in flight, drain
                // the queue without making any more API calls. Already-running
                // calls finish (Azure's contract is irreversible once PUT lands).
                if (myBatchId !== batchIdRef.current) {
                    queue.length = 0;
                    break;
                }
                const r = queue.shift();
                if (!r)
                    break;
                yield runOne(r);
            }
        });
        for (let i = 0; i < Math.min(concurrency, recipients.length); i += 1) {
            workers.push(next());
        }
        yield Promise.allSettled(workers);
        // Stale — the operator kicked a newer batch; abort any cleanup.
        if (myBatchId !== batchIdRef.current)
            return;
        if (localErrors.length > 0) {
            setBatchErrors(localErrors);
            store.addNotification({
                type: "error",
                message: `Failed to provision ${localErrors.length} of ${recipients.length} subscription(s). See details on page.`,
            });
        }
        if (successfulKeys.length > 0 && !selfAssign) {
            const remaining = form
                .getValues("recipients")
                .filter((r) => !successfulKeys.includes(r.key));
            form.setValue("recipients", remaining, { shouldValidate: true });
        }
        auditLog.record({
            actor,
            action: "create_ea_subscription_batch_end",
            target: confirmLeafName !== null && confirmLeafName !== void 0 ? confirmLeafName : billingScope,
            status: localErrors.length === 0 ? "success" : "failure",
            details: {
                batchKey,
                recipientCount: recipients.length,
                successCount: successfulKeys.length,
                failureCount: localErrors.length,
                elapsedMs: Date.now() - (submitStartedAt !== null && submitStartedAt !== void 0 ? submitStartedAt : Date.now()),
            },
        });
        setSubmitting(false);
        setConfirmOpen(false);
        setRetryOnlyKeys(null);
    }), [
        activeAccount,
        formReady,
        effectiveRecipients,
        billingScope,
        confirmLeafName,
        isEa,
        selectedBillingAccount,
        selectedBillingProfile,
        selectedInvoiceSection,
        selectedEnrollmentAccount,
        selfAssign,
        store,
        form,
        concurrencyChoice,
        retryOnlyKeys,
        submitStartedAt,
    ]);
    // Failure summary stats for the post-batch summary chip strip. Computed
    // off the live statusMap (not batchErrors) so the numbers stay accurate
    // mid-batch as rows transition pending → running → success/failure.
    const failureCount = React.useMemo(() => Object.values(statusMap).filter((s) => s.state === "failure").length, [statusMap]);
    const runningCount = React.useMemo(() => Object.values(statusMap).filter((s) => s.state === "running").length, [statusMap]);
    const pendingCount = React.useMemo(() => Object.values(statusMap).filter((s) => s.state === "pending").length, [statusMap]);
    // Median / max per-recipient elapsed time across the most recent batch.
    // Surfaced in the summary so the operator gets a feel for whether the
    // batch was throttle-bound, capacity-bound, or smooth.
    const elapsedStats = React.useMemo(() => {
        const samples = [];
        for (const s of Object.values(statusMap)) {
            if (s.state === "success" || s.state === "failure") {
                samples.push((s.completedAt - s.startedAt) / 1000);
            }
        }
        if (samples.length === 0)
            return { median: 0, max: 0, count: 0, avg: 0 };
        samples.sort((a, b) => a - b);
        const median = samples.length % 2 === 0
            ? (samples[samples.length / 2 - 1] + samples[samples.length / 2]) /
                2
            : samples[Math.floor(samples.length / 2)];
        const max = samples[samples.length - 1];
        const avg = samples.reduce((acc, v) => acc + v, 0) / samples.length;
        return { median, max, count: samples.length, avg };
    }, [statusMap]);
    // Failure rows the user is allowed to retry (subset of effectiveRecipients
    // with state === "failure" in the live statusMap). Keys are sourced from
    // effectiveRecipients so we never offer to retry a recipient the user
    // already removed.
    const failedKeys = React.useMemo(() => {
        const out = [];
        for (const r of effectiveRecipients) {
            const s = statusMap[r.key];
            if ((s === null || s === void 0 ? void 0 : s.state) === "failure")
                out.push(r.key);
        }
        return out;
    }, [effectiveRecipients, statusMap]);
    const handleRetryFailed = React.useCallback(() => {
        if (failedKeys.length === 0 || submitting)
            return;
        setRetryOnlyKeys(new Set(failedKeys));
        setConfirmOpen(true);
    }, [failedKeys, submitting]);
    // Export the current batch (success + failure rows) to CSV / JSON. The
    // CSV is intentionally Excel-friendly: every row is flat, all GUIDs are
    // strings (so they don't lose precision), and error text is single-cell.
    const handleExportResults = React.useCallback((format) => {
        var _a, _b, _c;
        const rows = effectiveRecipients
            .map((r) => {
            var _a, _b, _c;
            const s = statusMap[r.key];
            if (!s)
                return null;
            if (s.state === "pending" || s.state === "running")
                return null;
            const elapsedSec = s.state === "success" || s.state === "failure"
                ? (s.completedAt - s.startedAt) / 1000
                : 0;
            return {
                recipient: r.displayLabel,
                upn: (_a = r.upn) !== null && _a !== void 0 ? _a : "",
                tenantId: r.tenantId,
                tenantLabel: (_b = r.tenantLabel) !== null && _b !== void 0 ? _b : "",
                ownerObjectId: r.ownerObjectId,
                source: r.source,
                state: s.state,
                subscriptionId: s.state === "success" ? ((_c = s.subscriptionId) !== null && _c !== void 0 ? _c : "") : "",
                aliasName: s.state === "success" ? s.aliasName : "",
                error: s.state === "failure" ? s.error : "",
                errorCategory: s.state === "failure" ? categorizeError(s.error).label : "",
                elapsedSeconds: Math.round(elapsedSec * 10) / 10,
                startedAtIso: new Date(s.startedAt).toISOString(),
                completedAtIso: new Date(s.completedAt).toISOString(),
            };
        })
            .filter((r) => r !== null);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const baseFilename = `ea-subscription-batch-${stamp}`;
        if (format === "csv") {
            const headers = [
                "recipient",
                "upn",
                "tenantId",
                "tenantLabel",
                "ownerObjectId",
                "source",
                "state",
                "subscriptionId",
                "aliasName",
                "error",
                "errorCategory",
                "elapsedSeconds",
                "startedAtIso",
                "completedAtIso",
            ];
            const csvRows = rows.map((r) => [
                r.recipient,
                r.upn,
                r.tenantId,
                r.tenantLabel,
                r.ownerObjectId,
                r.source,
                r.state,
                r.subscriptionId,
                r.aliasName,
                r.error,
                r.errorCategory,
                r.elapsedSeconds,
                r.startedAtIso,
                r.completedAtIso,
            ]);
            downloadCsv(`${baseFilename}.csv`, [headers, ...csvRows]);
        }
        else {
            downloadJson(`${baseFilename}.json`, {
                exportedAt: new Date().toISOString(),
                billingScope,
                billingAccount: selectedBillingAccount,
                billingAccountDisplay: (_a = selectedBillingAccountObj === null || selectedBillingAccountObj === void 0 ? void 0 : selectedBillingAccountObj.displayName) !== null && _a !== void 0 ? _a : null,
                enrollmentAccount: isEa ? selectedEnrollmentAccount : null,
                enrollmentAccountDisplay: isEa
                    ? ((_b = selectedEnrollmentAccountObj === null || selectedEnrollmentAccountObj === void 0 ? void 0 : selectedEnrollmentAccountObj.displayName) !== null && _b !== void 0 ? _b : null)
                    : null,
                billingProfile: isEa ? null : selectedBillingProfile,
                invoiceSection: isEa ? null : selectedInvoiceSection,
                agreementType: isEa ? "EnterpriseAgreement" : "MicrosoftCustomerAgreement",
                totalRecipients: rows.length,
                successCount: rows.filter((r) => r.state === "success").length,
                failureCount: rows.filter((r) => r.state === "failure").length,
                results: rows,
            });
        }
        store.addNotification({
            type: "success",
            message: `Exported ${rows.length} result row${rows.length === 1 ? "" : "s"} as ${format.toUpperCase()}.`,
        });
        auditLog.record({
            actor: (_c = activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username) !== null && _c !== void 0 ? _c : "anonymous",
            action: "ea_subscription_export_results",
            target: `${rows.length} rows`,
            status: "success",
            details: { format, rowCount: rows.length, billingScope },
        });
    }, [
        effectiveRecipients,
        statusMap,
        billingScope,
        selectedBillingAccount,
        selectedBillingAccountObj,
        selectedEnrollmentAccount,
        selectedEnrollmentAccountObj,
        selectedBillingProfile,
        selectedInvoiceSection,
        isEa,
        store,
        activeAccount,
    ]);
    // Recipient picker filters — operator-facing facet controls so a 500-
    // user tenant list is navigable. The Command primitive already handles
    // fuzzy match on the search box; these chips narrow the candidate set
    // BEFORE the fuzzy search runs.
    const [pickerSourceFilter, setPickerSourceFilter] = React.useState("all");
    const [pickerTenantFilter, setPickerTenantFilter] = React.useState("__all__");
    const [pickerEnabledOnly, setPickerEnabledOnly] = React.useState(true);
    // Distinct tenant facets across both web-account + tenant-user recipient
    // sources, sorted alphabetically by displayed label.
    const pickerTenantFacets = React.useMemo(() => {
        const counts = new Map();
        const visit = (r) => {
            var _a;
            if (pickerSourceFilter !== "all" && r.source !== pickerSourceFilter)
                return;
            const cur = counts.get(r.tenantId);
            if (cur) {
                cur.count += 1;
            }
            else {
                counts.set(r.tenantId, {
                    label: (_a = r.tenantLabel) !== null && _a !== void 0 ? _a : truncateMiddle(r.tenantId, 8, 4),
                    count: 1,
                });
            }
        };
        for (const r of webAccountRecipients)
            visit(r);
        for (const r of tenantUserRecipients)
            visit(r);
        const out = [];
        for (const [id, v] of counts) {
            out.push({ id, label: v.label, count: v.count });
        }
        out.sort((a, b) => a.label.localeCompare(b.label));
        return out;
    }, [
        webAccountRecipients,
        tenantUserRecipients,
        pickerSourceFilter,
    ]);
    // Apply the chip filters; returns the recipient subset the picker should
    // render. Falsy filter values pass everything through.
    const applyPickerFilters = React.useCallback((rs) => rs.filter((r) => {
        if (pickerSourceFilter !== "all" && r.source !== pickerSourceFilter)
            return false;
        if (pickerTenantFilter !== "__all__" &&
            r.tenantId !== pickerTenantFilter)
            return false;
        if (pickerEnabledOnly && r.enabled === false)
            return false;
        return true;
    }), [pickerSourceFilter, pickerTenantFilter, pickerEnabledOnly]);
    // React to global tenant switches fired from azure-accounts-page or the
    // shared header TenantSwitcher: if the operator switched to an account
    // that's EA-capable on this page, mirror the selection here so the form
    // and recipient picker stay aligned with the rest of the app.
    useTenantChange(undefined, (detail) => {
        const candidate = detail.homeAccountId;
        if (!eaAccounts.some((a) => a.homeAccountId === candidate))
            return;
        if (activeKey === candidate)
            return;
        handleSelectAccount(candidate);
    });
    // Hotkey: Ctrl+Enter (Cmd+Enter on macOS) opens the create-subscription
    // confirmation when the form is ready. Skips when the confirm dialog
    // is already open or a batch is running so it can't double-fire.
    useShortcut("Mod+Enter", () => {
        if (submitting || confirmOpen)
            return;
        if (!formReady)
            return;
        setConfirmOpen(true);
    }, { enabled: true, allowInInputs: true, preventDefault: true });
    // Hotkey: Escape cancels the confirm dialog (but never aborts an in-
    // flight batch — Azure has already committed the in-flight PUTs). When
    // a retry is queued, also clears the retry-only key set.
    useShortcut("Escape", () => {
        if (submitting)
            return;
        if (confirmOpen) {
            setConfirmOpen(false);
            setRetryOnlyKeys(null);
        }
    }, { enabled: confirmOpen, allowInInputs: true, preventDefault: false });
    if (discoveringEa && eaAccounts.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
            React.createElement(PageHeader, { title: "Create EA Subscription", description: "Provision a new Azure subscription under your Enterprise Agreement enrollment." }),
            React.createElement(Card, null,
                React.createElement(CardHeader, null,
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(Loader2, { className: "h-4 w-4 animate-spin text-primary motion-reduce:animate-none", "aria-hidden": true }),
                        "Probing EA billing capability"),
                    React.createElement(CardDescription, null, "Checking each signed-in account for Enterprise Agreement access via the billing API. This usually takes a few seconds.")),
                React.createElement(CardContent, null,
                    React.createElement(SkeletonLoader, { variant: "form", rows: 3 })))));
    }
    if (eaAccounts.length === 0) {
        return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
            React.createElement(PageHeader, { title: "Create EA Subscription", description: "Provision a new Azure subscription under your Enterprise Agreement enrollment." }),
            React.createElement(Card, { className: "border-warning/40 bg-warning/5 transition-colors duration-200 ease-out" },
                React.createElement(CardHeader, { className: "flex flex-row items-start gap-3 space-y-0" },
                    React.createElement("span", { "aria-hidden": true, className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning" },
                        React.createElement(ShieldAlert, { className: "h-4 w-4", "aria-hidden": true })),
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement(CardTitle, { className: "text-sm" }, "No EA-capable account detected"),
                        React.createElement(CardDescription, null, "None of your signed-in accounts have an Enterprise Agreement or MCA billing role we can use to provision subscriptions."))),
                React.createElement(CardContent, { className: "flex flex-col gap-3" },
                    React.createElement("p", { className: "text-xs text-muted-foreground" }, "Sign in with an account that holds one of these roles:"),
                    React.createElement("ul", { className: "ml-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground" },
                        React.createElement("li", null,
                            React.createElement("span", { className: "font-medium text-foreground" }, "Enterprise Administrator"),
                            " ",
                            "\u2014 full EA portal control"),
                        React.createElement("li", null,
                            React.createElement("span", { className: "font-medium text-foreground" }, "Department Administrator"),
                            " ",
                            "\u2014 provisions inside one department"),
                        React.createElement("li", null,
                            React.createElement("span", { className: "font-medium text-foreground" }, "EA Account Owner"),
                            " ",
                            "\u2014 provisions inside one enrollment account"),
                        React.createElement("li", null,
                            React.createElement("span", { className: "font-medium text-foreground" }, "EA Subscription Creator"),
                            " ",
                            "\u2014 RBAC role on the enrollment account")),
                    onNavigate && (React.createElement("div", { className: "flex flex-wrap gap-2 pt-1" },
                        React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: () => onNavigate("azure-accounts"), "aria-label": "Sign in with an EA-billing-owner account" },
                            React.createElement(BadgeCheck, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                            "Sign in with EA-billing-owner account")))))));
    }
    const totalRecipients = effectiveRecipients.length;
    // Build the full recipient catalog for the Command picker. Each entry
    // gets an opaque `value` string (used by cmdk for fuzzy matching) that
    // mixes display text + UPN + tenant + GUIDs so users can search by any.
    const renderRecipientItem = (r) => {
        var _a, _b;
        const disabled = r.enabled === false;
        const checked = isSelected(r);
        const cmdValue = [
            r.displayLabel,
            (_a = r.upn) !== null && _a !== void 0 ? _a : "",
            (_b = r.tenantLabel) !== null && _b !== void 0 ? _b : "",
            r.tenantId,
            r.ownerObjectId,
        ].join(" ");
        return (React.createElement(CommandItem, { key: r.key, value: cmdValue, disabled: disabled, onSelect: () => toggleRecipient(r, !checked), className: cn(disabled && "opacity-70") },
            React.createElement("span", { "aria-hidden": true, className: cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background") }, checked && React.createElement(Check, { className: "h-3 w-3", "aria-hidden": true })),
            React.createElement("span", { className: "flex min-w-0 flex-col" },
                React.createElement("span", { className: "truncate text-sm" }, r.displayLabel),
                React.createElement("span", { className: "truncate text-2xs text-muted-foreground" },
                    r.upn ? (r.upn) : (React.createElement("code", { className: "font-mono" }, truncateMiddle(r.ownerObjectId, 8, 4))),
                    r.tenantLabel ? ` -- ${r.tenantLabel}` : "")),
            disabled && (React.createElement(Badge, { variant: "secondary", className: "ml-auto" }, "disabled"))));
    };
    // Successful results that should be celebrated in the result panel —
    // computed up here so the JSX below can spotlight them above the
    // failure list.
    const successResults = effectiveRecipients
        .map((r) => {
        const s = statusMap[r.key];
        if (s && s.state === "success") {
            return { recipient: r, status: s };
        }
        return null;
    })
        .filter((x) => Boolean(x));
    // Screen-reader-only live announcement of batch progress. Distinct from
    // the visible polite-live region inside the Provisioning Summary so
    // milestones (start / each-completed / done) reach assistive tech
    // without re-announcing the entire summary card on every re-render.
    const srStatusMessage = React.useMemo(() => {
        if (submitting) {
            if (totalInFlight === 0)
                return "Batch starting.";
            return `Provisioning subscriptions: ${completedCount} of ${totalInFlight} complete.`;
        }
        if (totalInFlight > 0 && completedCount === totalInFlight) {
            const failCount = totalInFlight - successResults.length;
            if (failCount === 0) {
                return `Batch complete. All ${totalInFlight} subscriptions provisioned successfully.`;
            }
            return `Batch complete with ${failCount} failure${failCount === 1 ? "" : "s"} of ${totalInFlight}.`;
        }
        return "";
    }, [submitting, totalInFlight, completedCount, successResults.length]);
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
        React.createElement("div", { "aria-live": "polite", "aria-atomic": "true", role: "status", className: "sr-only" }, srStatusMessage),
        React.createElement(PageHeader, { title: "Create EA Subscription", description: "Provision a new Azure subscription under your Enterprise Agreement enrollment." },
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                    loginHint: activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username,
                }) }),
            React.createElement(Select, { value: activeKey, onValueChange: handleSelectAccount },
                React.createElement(SelectTrigger, { className: "h-8 w-72 text-xs", "aria-label": "Select EA-capable account" },
                    React.createElement(SelectValue, { placeholder: "Select EA-capable account" })),
                React.createElement(SelectContent, null, eaAccounts.map((a) => (React.createElement(SelectItem, { key: a.homeAccountId, value: a.homeAccountId },
                    React.createElement("span", { className: "flex items-center gap-2 truncate" },
                        React.createElement(BadgeCheck, { className: "h-3.5 w-3.5 shrink-0 text-success", "aria-hidden": true }),
                        React.createElement("span", { className: "truncate" }, a.name || a.username),
                        React.createElement("span", { className: "text-muted-foreground" },
                            "(",
                            a.billingAccountCount,
                            " EA)")))))))),
        React.createElement("div", { className: "flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-foreground transition-colors duration-200 ease-out" },
            React.createElement("span", { "aria-hidden": true, className: "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary" },
                React.createElement(Info, { className: "h-3 w-3", "aria-hidden": true })),
            React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("p", null,
                    React.createElement("span", { className: "font-medium" }, "EA Sub Creation"),
                    " provisions a brand-new Azure subscription under your Enterprise Agreement (or MCA) billing scope, one per recipient. You pick the billing path, choose who owns each new subscription, and confirm. We call the Subscription Alias API and poll until the new GUID is live."),
                React.createElement("p", { className: "text-muted-foreground" },
                    React.createElement("span", { className: "font-medium text-warning-foreground" }, "Submission is irreversible"),
                    " ",
                    "\u2014 once a subscription is provisioned, only an EA admin can cancel or transfer it from the EA portal."))),
        activeAccount && (React.createElement(AcceptOwnershipPanel, { account: activeAccount, store: store })),
        activeAccount ? (React.createElement("div", { className: "flex flex-col gap-4" },
            (selectedBillingAccountObj ||
                selectedBillingProfileObj ||
                selectedInvoiceSectionObj ||
                selectedEnrollmentAccountObj) && (React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-sunken px-3 py-1.5 text-2xs text-muted-foreground transition-colors duration-200 ease-out" },
                React.createElement("span", { className: "font-medium uppercase tracking-wider" }, "Scope:"),
                selectedBillingAccountObj && (React.createElement("span", { className: "flex items-center gap-1" },
                    React.createElement(Building2, { className: "h-3 w-3", "aria-hidden": true }),
                    React.createElement("span", { className: "text-foreground" }, selectedBillingAccountObj.displayName))),
                isEa && selectedEnrollmentAccountObj && (React.createElement(React.Fragment, null,
                    React.createElement(ChevronRight, { className: "h-3 w-3", "aria-hidden": true }),
                    React.createElement("span", { className: "flex items-center gap-1" },
                        React.createElement(IdCard, { className: "h-3 w-3", "aria-hidden": true }),
                        React.createElement("span", { className: "text-foreground" }, selectedEnrollmentAccountObj.displayName)))),
                !isEa && selectedBillingProfileObj && (React.createElement(React.Fragment, null,
                    React.createElement(ChevronRight, { className: "h-3 w-3", "aria-hidden": true }),
                    React.createElement("span", { className: "flex items-center gap-1" },
                        React.createElement(Wallet, { className: "h-3 w-3", "aria-hidden": true }),
                        React.createElement("span", { className: "text-foreground" }, selectedBillingProfileObj.displayName)))),
                !isEa && selectedInvoiceSectionObj && (React.createElement(React.Fragment, null,
                    React.createElement(ChevronRight, { className: "h-3 w-3", "aria-hidden": true }),
                    React.createElement("span", { className: "flex items-center gap-1" },
                        React.createElement(Receipt, { className: "h-3 w-3", "aria-hidden": true }),
                        React.createElement("span", { className: "text-foreground" }, selectedInvoiceSectionObj.displayName)))))),
            React.createElement(Card, null,
                React.createElement(CardHeader, null,
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(Building2, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                        "Billing Account"),
                    React.createElement(CardDescription, null, "The top-level Enterprise Agreement (or MCA) enrollment. Subscriptions live under one of these.")),
                React.createElement(CardContent, { className: "flex flex-col gap-2" }, loadingBa ? (React.createElement(SkeletonLoader, { variant: "list", rows: 2 })) : errBa ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load billing accounts.", detail: errBa, onRetry: loadBillingAccounts })) : billingAccounts.length === 0 ? (React.createElement(EmptyState, { icon: Building2, title: "No EA billing accounts visible", description: "The signed-in account has no Enterprise Agreement or MCA enrollment we can read. Make sure you're using an EA admin / Account Owner identity." })) : (React.createElement("div", { role: "radiogroup", "aria-label": "Billing account", className: "flex flex-col gap-1.5" }, billingAccounts.map((ba) => (React.createElement(ScopeCard, { key: ba.name, selected: selectedBillingAccount === ba.name, onSelect: () => setSelectedBillingAccount(ba.name), title: ba.displayName, subtitle: ba.name, badge: ba.agreementType ? (React.createElement(Badge, { variant: "secondary", className: "text-2xs font-normal" }, ba.agreementType === "EnterpriseAgreement"
                        ? "EA"
                        : ba.agreementType === "MicrosoftCustomerAgreement"
                            ? "MCA"
                            : ba.agreementType)) : undefined }))))))),
            selectedBillingAccount &&
                (isEa ? (React.createElement(Card, null,
                    React.createElement(CardHeader, null,
                        React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                            React.createElement(IdCard, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                            "Enrollment Account"),
                        React.createElement(CardDescription, null, "The enrollment account that owns the new subscription. Costs are charged here.")),
                    React.createElement(CardContent, { className: "flex flex-col gap-2" }, loadingEnrollmentAccounts ? (React.createElement(SkeletonLoader, { variant: "list", rows: 2 })) : enrollmentAccountsError ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load enrollment accounts.", detail: enrollmentAccountsError, onRetry: loadEnrollmentAccounts })) : enrollmentAccounts.length === 0 ? (React.createElement(EmptyState, { icon: IdCard, title: "No enrollment accounts here", description: "This EA enrollment does not expose any enrollment accounts to your principal. Pick a different billing account." })) : (React.createElement("div", { role: "radiogroup", "aria-label": "Enrollment account", className: "flex flex-col gap-1.5" }, enrollmentAccounts.map((ea) => (React.createElement(ScopeCard, { key: ea.name, selected: selectedEnrollmentAccount === ea.name, onSelect: () => setSelectedEnrollmentAccount(ea.name), title: ea.displayName, subtitle: ea.name, meta: ea.accountOwner || ea.costCenter ? (React.createElement(React.Fragment, null,
                            ea.accountOwner && (React.createElement("span", null,
                                React.createElement("span", { className: "font-medium" }, "Owner:"),
                                " ",
                                React.createElement("span", { className: "text-foreground" }, ea.accountOwner))),
                            ea.costCenter && (React.createElement("span", null,
                                React.createElement("span", { className: "font-medium" }, "Cost Center:"),
                                " ",
                                React.createElement("span", { className: "text-foreground" }, ea.costCenter))))) : undefined })))))))) : (React.createElement(React.Fragment, null,
                    React.createElement(Card, null,
                        React.createElement(CardHeader, null,
                            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                                React.createElement(Wallet, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                                "Billing Profile"),
                            React.createElement(CardDescription, null, "Cost-tracking profile within the MCA enrollment.")),
                        React.createElement(CardContent, { className: "flex flex-col gap-2" }, loadingBp ? (React.createElement(SkeletonLoader, { variant: "list", rows: 2 })) : errBp ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load billing profiles.", detail: errBp, onRetry: loadBillingProfiles })) : billingProfiles.length === 0 ? (React.createElement(EmptyState, { icon: Wallet, title: "No billing profiles here", description: "This billing account has no profiles your principal can see. Pick a different billing account." })) : (React.createElement("div", { role: "radiogroup", "aria-label": "Billing profile", className: "flex flex-col gap-1.5" }, billingProfiles.map((bp) => (React.createElement(ScopeCard, { key: bp.name, selected: selectedBillingProfile === bp.name, onSelect: () => setSelectedBillingProfile(bp.name), title: bp.displayName, subtitle: bp.name }))))))),
                    selectedBillingProfile && (React.createElement(Card, null,
                        React.createElement(CardHeader, null,
                            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                                React.createElement(Receipt, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                                "Invoice Section"),
                            React.createElement(CardDescription, null, "Where charges for this subscription will be invoiced.")),
                        React.createElement(CardContent, { className: "flex flex-col gap-2" }, loadingIs ? (React.createElement(SkeletonLoader, { variant: "list", rows: 2 })) : errIs ? (React.createElement(ErrorState, { size: "compact", message: "Failed to load invoice sections.", detail: errIs, onRetry: loadInvoiceSections })) : invoiceSections.length === 0 ? (React.createElement(EmptyState, { icon: Receipt, title: "No invoice sections here", description: "This billing profile has no invoice sections to provision under." })) : (React.createElement("div", { role: "radiogroup", "aria-label": "Invoice section", className: "flex flex-col gap-1.5" }, invoiceSections.map((is) => (React.createElement(ScopeCard, { key: is.name, selected: selectedInvoiceSection === is.name, onSelect: () => setSelectedInvoiceSection(is.name), title: is.displayName, subtitle: is.name }))))))))))),
            leafSelectionReady && (React.createElement(Card, null,
                React.createElement(CardHeader, null,
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(Users, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                        "Recipients"),
                    React.createElement(CardDescription, null, "Pick one or more identities. Each selected recipient becomes its own subscription, provisioned in parallel.")),
                React.createElement(CardContent, { className: "flex flex-col gap-3" },
                    React.createElement(Controller, { control: form.control, name: "selfAssign", render: ({ field }) => (React.createElement("div", { className: "flex items-start gap-3" },
                            React.createElement(Switch, { id: "ea-self-assign", checked: field.value, onCheckedChange: (v) => field.onChange(Boolean(v)), "aria-label": "Assign to me (the EA billing account)" }),
                            React.createElement("div", { className: "flex flex-col gap-0.5" },
                                React.createElement(Label, { htmlFor: "ea-self-assign", className: "cursor-pointer text-sm" }, "Assign to me (the EA billing account)"),
                                React.createElement("p", { className: "text-2xs text-muted-foreground" }, "When ON, hides the picker and provisions exactly one subscription owned by the signed-in EA principal in their home tenant. Default is OFF (multi-recipient).")))) }),
                    !selfAssign && (React.createElement(Controller, { control: form.control, name: "recipients", render: ({ fieldState }) => (React.createElement("div", { className: "flex flex-col gap-3" },
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement("div", { className: "flex items-center justify-between gap-2" },
                                    React.createElement(Label, { htmlFor: "ea-recipient-picker" }, "Subscription Owners"),
                                    selectedRecipients.length > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: handleClearRecipients, "aria-label": "Clear all recipients", className: "gap-1 text-2xs text-muted-foreground" },
                                        React.createElement(Trash2, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Clear all"))),
                                React.createElement(Popover, { open: pickerOpen, onOpenChange: setPickerOpen },
                                    React.createElement(PopoverTrigger, { asChild: true },
                                        React.createElement(Button, { id: "ea-recipient-picker", type: "button", variant: "outline", role: "combobox", className: "justify-between transition-colors duration-200 ease-out hover:border-primary/60", "aria-haspopup": "listbox", "aria-expanded": pickerOpen, "aria-label": "Open recipient picker" },
                                            React.createElement("span", { className: "flex items-center gap-2" },
                                                React.createElement(Users, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                                selectedRecipients.length === 0
                                                    ? "Choose recipients"
                                                    : `${selectedRecipients.length} selected`),
                                            React.createElement(ChevronsUpDown, { className: "h-3.5 w-3.5 opacity-60", "aria-hidden": true }))),
                                    React.createElement(PopoverContent, { align: "start", sideOffset: 4, className: "w-[32rem] p-0" },
                                        React.createElement("div", { className: "flex flex-col gap-2 border-b border-border px-3 py-2" },
                                            React.createElement("div", { className: "flex items-center justify-between gap-2" },
                                                React.createElement("span", { className: "flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" },
                                                    React.createElement(Filter, { className: "h-3 w-3", "aria-hidden": true }),
                                                    "Filters"),
                                                React.createElement(Label, { htmlFor: "ea-picker-enabled-only", className: "flex cursor-pointer items-center gap-1.5 text-2xs" },
                                                    React.createElement(Switch, { id: "ea-picker-enabled-only", checked: pickerEnabledOnly, onCheckedChange: (v) => setPickerEnabledOnly(Boolean(v)), "aria-label": "Show only enabled accounts" }),
                                                    "Enabled only")),
                                            React.createElement("div", { className: "flex flex-wrap items-center gap-1" }, [
                                                { v: "all", l: "All sources" },
                                                { v: "web-account", l: "Signed-in" },
                                                { v: "tenant-user", l: "Tenant users" },
                                            ].map((opt) => (React.createElement("button", { key: opt.v, type: "button", onClick: () => setPickerSourceFilter(opt.v), className: cn("rounded-full px-2 py-0.5 text-2xs transition-colors duration-150", pickerSourceFilter === opt.v
                                                    ? "bg-primary text-primary-foreground"
                                                    : "bg-muted text-muted-foreground hover:bg-muted/80"), "aria-pressed": pickerSourceFilter === opt.v }, opt.l)))),
                                            pickerTenantFacets.length > 1 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1" },
                                                React.createElement("button", { type: "button", onClick: () => setPickerTenantFilter("__all__"), className: cn("rounded-full px-2 py-0.5 text-2xs transition-colors duration-150", pickerTenantFilter === "__all__"
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-muted text-muted-foreground hover:bg-muted/80"), "aria-pressed": pickerTenantFilter === "__all__" }, "All tenants"),
                                                pickerTenantFacets.map((t) => (React.createElement("button", { key: t.id, type: "button", onClick: () => setPickerTenantFilter(t.id), className: cn("rounded-full px-2 py-0.5 text-2xs transition-colors duration-150", pickerTenantFilter === t.id
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-muted text-muted-foreground hover:bg-muted/80"), "aria-pressed": pickerTenantFilter === t.id, title: `${t.label} (${t.count})` },
                                                    t.label,
                                                    " ",
                                                    React.createElement("span", { className: "opacity-70" },
                                                        "(",
                                                        t.count,
                                                        ")"))))))),
                                        React.createElement(Command, { label: "Select subscription owners" },
                                            React.createElement(CommandInput, { placeholder: "Search by name, UPN, tenant, or GUID..." }),
                                            React.createElement(CommandList, { className: "max-h-80" },
                                                React.createElement(CommandEmpty, null, "No recipients match your filters / search. Loosen the chips above, or use the Paste / Bulk paste panels below to add (tenant, object) pairs manually."),
                                                applyPickerFilters(webAccountRecipients)
                                                    .length > 0 && (React.createElement(CommandGroup, { heading: "Signed-in accounts" }, applyPickerFilters(webAccountRecipients).map((r) => renderRecipientItem(r)))),
                                                tenantUserGroups.map((g, idx) => {
                                                    const groupRecipients = applyPickerFilters(g.users
                                                        .map((u) => tenantUserRecipients.find((r) => r.tenantId === g.tenantId &&
                                                        r.ownerObjectId === u.id))
                                                        .filter((r) => Boolean(r)));
                                                    if (groupRecipients.length === 0)
                                                        return null;
                                                    return (React.createElement(React.Fragment, { key: g.tenantId },
                                                        (idx > 0 ||
                                                            applyPickerFilters(webAccountRecipients).length > 0) && (React.createElement(CommandSeparator, null)),
                                                        React.createElement(CommandGroup, { heading: React.createElement("div", { className: "flex items-center justify-between gap-2" },
                                                                React.createElement("span", null,
                                                                    "Tenant -- ",
                                                                    g.tenantLabel),
                                                                React.createElement("button", { type: "button", onClick: (e) => {
                                                                        e.stopPropagation();
                                                                        handleSelectAllInTenant(g.tenantId, groupRecipients);
                                                                    }, className: "rounded px-1.5 py-0.5 text-2xs font-normal text-primary hover:bg-primary/10", "aria-label": `Select all ${groupRecipients.length} from ${g.tenantLabel}` },
                                                                    "+ Add all (",
                                                                    groupRecipients.length,
                                                                    ")")) }, groupRecipients.map((r) => renderRecipientItem(r)))));
                                                }))))),
                                fieldState.error && (React.createElement("p", { className: "text-2xs text-destructive", role: "alert" }, fieldState.error.message))),
                            React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-dashed border-border bg-surface-sunken px-3 py-2" },
                                React.createElement("div", { className: "flex items-center justify-between gap-2" },
                                    React.createElement(Label, { htmlFor: "ea-paste-toggle", className: "cursor-pointer text-xs" }, "Paste recipient (tenant + object IDs)"),
                                    React.createElement(Switch, { id: "ea-paste-toggle", checked: showManualPaste, onCheckedChange: (v) => setShowManualPaste(Boolean(v)), "aria-label": "Show paste-recipient inputs" })),
                                showManualPaste && (React.createElement("div", { className: "flex flex-col gap-2" },
                                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                                        React.createElement(Label, { htmlFor: "ea-manual-tenant", className: "text-2xs" }, "Tenant ID (GUID)"),
                                        React.createElement(Input, { id: "ea-manual-tenant", type: "text", value: manualTenantId, onChange: (e) => setManualTenantId(e.target.value), placeholder: "00000000-0000-0000-0000-000000000000", "aria-label": "Manual tenant ID", "aria-invalid": manualTenantId && !manualTenantValid
                                                ? true
                                                : undefined, autoComplete: "off", spellCheck: false, className: "font-mono text-xs" })),
                                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                                        React.createElement(Label, { htmlFor: "ea-manual-owner", className: "text-2xs" },
                                            React.createElement(Tooltip, null,
                                                React.createElement(TooltipTrigger, { asChild: true },
                                                    React.createElement("span", { className: "cursor-help underline decoration-dotted underline-offset-2" }, "Subscription Owner Object ID (GUID)")),
                                                React.createElement(TooltipContent, null, "AAD object ID of the user/SPN in the destination tenant who becomes the owner."))),
                                        React.createElement(Input, { id: "ea-manual-owner", type: "text", value: manualOwnerId, onChange: (e) => setManualOwnerId(e.target.value), placeholder: "00000000-0000-0000-0000-000000000000", "aria-label": "Manual subscription owner object ID", "aria-invalid": manualOwnerId && !manualOwnerValid
                                                ? true
                                                : undefined, autoComplete: "off", spellCheck: false, className: "font-mono text-xs" })),
                                    React.createElement("div", { className: "flex justify-end" },
                                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleAddManual, disabled: !manualTenantValid || !manualOwnerValid, "aria-label": "Add manual recipient" }, "Add"))))),
                            React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-dashed border-border bg-surface-sunken px-3 py-2" },
                                React.createElement("div", { className: "flex items-center justify-between gap-2" },
                                    React.createElement(Label, { htmlFor: "ea-bulk-paste-toggle", className: "cursor-pointer text-xs" },
                                        React.createElement("span", { className: "flex items-center gap-1.5" },
                                            React.createElement(ClipboardPaste, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                            "Bulk paste recipients (CSV)")),
                                    React.createElement(Switch, { id: "ea-bulk-paste-toggle", checked: bulkPasteOpen, onCheckedChange: (v) => setBulkPasteOpen(Boolean(v)), "aria-label": "Show bulk-paste textarea" })),
                                bulkPasteOpen && (React.createElement("div", { className: "flex flex-col gap-2" },
                                    React.createElement("p", { className: "text-2xs text-muted-foreground" },
                                        "Paste one",
                                        " ",
                                        React.createElement("code", { className: "font-mono" }, "tenantId, ownerObjectId"),
                                        " ",
                                        "pair per line. Commas, tabs, or whitespace separators are accepted. Lines beginning with",
                                        " ",
                                        React.createElement("code", { className: "font-mono" }, "#"),
                                        " or",
                                        " ",
                                        React.createElement("code", { className: "font-mono" }, "//"),
                                        " are treated as comments. Duplicates are silently skipped on add."),
                                    React.createElement("textarea", { id: "ea-bulk-paste", value: bulkPasteText, onChange: (e) => setBulkPasteText(e.target.value), rows: 6, spellCheck: false, autoComplete: "off", placeholder: "# tenantId, ownerObjectId — one per line\n" +
                                            "11111111-1111-1111-1111-111111111111, 22222222-2222-2222-2222-222222222222\n" +
                                            "33333333-3333-3333-3333-333333333333\t44444444-4444-4444-4444-444444444444", "aria-label": "Bulk paste recipient pairs", className: cn("w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-2xs leading-relaxed text-foreground placeholder:text-muted-foreground/60", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background") }),
                                    React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2 text-2xs" },
                                        React.createElement("span", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground" },
                                            React.createElement("span", null,
                                                React.createElement("span", { className: cn("font-semibold", bulkParseResult.pairs.length > 0
                                                        ? "text-success"
                                                        : "text-foreground") }, bulkParseResult.pairs.length),
                                                " ",
                                                "valid"),
                                            bulkParseResult.errors.length > 0 && (React.createElement("span", null,
                                                React.createElement("span", { className: "font-semibold text-destructive" }, bulkParseResult.errors.length),
                                                " ",
                                                "invalid")),
                                            bulkParseResult.truncated && (React.createElement("span", { className: "text-warning" }, "\u26A0 Truncated at 500 rows"))),
                                        React.createElement("div", { className: "flex items-center gap-1.5" },
                                            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => setBulkPasteText(""), disabled: !bulkPasteText, "aria-label": "Clear bulk paste textarea" }, "Clear"),
                                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleBulkAdd, disabled: bulkParseResult.pairs.length === 0, "aria-label": "Add all parsed recipients", className: "gap-1" },
                                                React.createElement(PlusCircle, { className: "h-3 w-3", "aria-hidden": true }),
                                                "Add",
                                                " ",
                                                bulkParseResult.pairs.length || "",
                                                " ",
                                                "valid"))),
                                    bulkParseResult.errors.length > 0 && (React.createElement("div", { className: "rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs" },
                                        React.createElement("p", { className: "mb-1 font-semibold text-destructive/90" },
                                            bulkParseResult.errors.length,
                                            " row",
                                            bulkParseResult.errors.length === 1
                                                ? ""
                                                : "s",
                                            " ",
                                            "will be skipped"),
                                        React.createElement("ul", { className: "ml-4 max-h-32 list-disc space-y-0.5 overflow-y-auto pr-2 font-mono text-2xs text-muted-foreground" },
                                            bulkParseResult.errors
                                                .slice(0, 10)
                                                .map((e) => (React.createElement("li", { key: e.line },
                                                React.createElement("span", { className: "text-foreground" },
                                                    "L",
                                                    e.line,
                                                    ":"),
                                                " ",
                                                e.reason))),
                                            bulkParseResult.errors.length > 10 && (React.createElement("li", { className: "text-muted-foreground" },
                                                "...and",
                                                " ",
                                                bulkParseResult.errors.length - 10,
                                                " ",
                                                "more")))))))),
                            React.createElement(RecipientTemplates, { currentPairs: selectedRecipients.map((r) => ({
                                    tenantId: r.tenantId,
                                    ownerObjectId: r.ownerObjectId,
                                })), onLoad: (pairs, templateName) => {
                                    var _a, _b;
                                    const prev = form.getValues("recipients");
                                    const seen = new Set(prev.map((p) => dedupeKey(p)));
                                    const added = [];
                                    for (const pair of pairs) {
                                        const dk = dedupeKey(pair);
                                        if (seen.has(dk))
                                            continue;
                                        seen.add(dk);
                                        const wkey = recipientKey("web-account", pair);
                                        const tkey = recipientKey("tenant-user", pair);
                                        const fromCatalog = (_a = recipientCatalog.get(wkey)) !== null && _a !== void 0 ? _a : recipientCatalog.get(tkey);
                                        if (fromCatalog) {
                                            added.push(fromCatalog);
                                        }
                                        else {
                                            added.push({
                                                key: `manual:${pair.tenantId}:${pair.ownerObjectId}`,
                                                source: "manual",
                                                tenantId: pair.tenantId,
                                                ownerObjectId: pair.ownerObjectId,
                                                displayLabel: `Manual (${truncateMiddle(pair.ownerObjectId, 8, 4)})`,
                                                tenantLabel: tenantLabelFor(pair.tenantId),
                                            });
                                        }
                                    }
                                    if (added.length > 0) {
                                        form.setValue("recipients", [...prev, ...added], { shouldValidate: true });
                                    }
                                    store.addNotification({
                                        type: added.length > 0 ? "success" : "info",
                                        message: added.length === 0
                                            ? `Template '${templateName}' added no new recipients (all duplicates).`
                                            : `Loaded '${templateName}' — added ${added.length} recipient${added.length === 1 ? "" : "s"}.`,
                                    });
                                    auditLog.record({
                                        actor: (_b = activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username) !== null && _b !== void 0 ? _b : "anonymous",
                                        action: "ea_subscription_load_template",
                                        target: templateName,
                                        status: "success",
                                        details: {
                                            templateName,
                                            templatePairCount: pairs.length,
                                            addedCount: added.length,
                                            duplicateCount: pairs.length - added.length,
                                        },
                                    });
                                }, disabled: submitting }),
                            React.createElement("div", { className: "flex flex-col gap-1.5" },
                                React.createElement("div", { className: "flex items-center justify-between gap-2" },
                                    React.createElement("p", { className: "text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, "Selected Recipients"),
                                    selectedRecipients.length > 0 && (React.createElement(Badge, { variant: "secondary", className: "text-2xs font-normal" }, selectedRecipients.length))),
                                selectedRecipients.length === 0 ? (React.createElement("p", { className: "text-xs text-muted-foreground" }, "Pick one or more recipients above. Each becomes its own subscription.")) : (React.createElement("div", { className: "flex flex-wrap gap-1.5", role: "list", "aria-label": "Selected recipients" }, selectedRecipients.map((r) => {
                                    var _a;
                                    const isCrossTenant = activeAccount &&
                                        r.tenantId.toLowerCase() !==
                                            activeAccount.tenantId.toLowerCase();
                                    return (React.createElement(Badge, { key: r.key, variant: "secondary", className: "flex items-center gap-1.5 pr-1", role: "listitem", title: `${r.displayLabel}\nTenant: ${(_a = r.tenantLabel) !== null && _a !== void 0 ? _a : r.tenantId}\nObject ID: ${r.ownerObjectId}` },
                                        isCrossTenant && (React.createElement(Tooltip, null,
                                            React.createElement(TooltipTrigger, { asChild: true },
                                                React.createElement("span", { className: "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-warning/20 text-warning", "aria-label": "Cross-tenant \u2014 needs acceptance" },
                                                    React.createElement(Hourglass, { className: "h-2.5 w-2.5", "aria-hidden": true }))),
                                            React.createElement(TooltipContent, null, "Cross-tenant subscription \u2014 recipient must accept ownership in their tenant within 7 days."))),
                                        React.createElement("span", { className: "flex flex-col leading-tight" },
                                            React.createElement("span", { className: "text-xs" }, r.displayLabel),
                                            React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                                r.tenantLabel,
                                                r.source === "manual" && (React.createElement("span", { className: "ml-1 italic" }, "(manual)")),
                                                r.enabled === false && (React.createElement("span", { className: "ml-1 text-destructive" }, "(disabled)")))),
                                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", className: "h-4 w-4", onClick: () => removeRecipient(r.key), "aria-label": `Remove ${r.displayLabel}` },
                                            React.createElement(X, { className: "h-3 w-3", "aria-hidden": true }))));
                                }))),
                                selectedRecipients.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground" },
                                    React.createElement("p", null,
                                        selectedRecipients.length,
                                        " recipient",
                                        selectedRecipients.length === 1 ? "" : "s",
                                        " ",
                                        "selected \u00B7 ",
                                        selectedRecipients.length,
                                        " ",
                                        "subscription",
                                        selectedRecipients.length === 1
                                            ? ""
                                            : "s",
                                        " ",
                                        "will be created",
                                        selectedRecipients.length > 1
                                            ? `, ${concurrencyChoice} at a time`
                                            : "",
                                        "."),
                                    (() => {
                                        var _a;
                                        // Tenant-distribution chip — surfaces
                                        // when a batch contains a mix of tenants.
                                        const tenantMap = new Map();
                                        for (const r of selectedRecipients) {
                                            const cur = tenantMap.get(r.tenantId);
                                            if (cur)
                                                cur.count += 1;
                                            else
                                                tenantMap.set(r.tenantId, {
                                                    label: (_a = r.tenantLabel) !== null && _a !== void 0 ? _a : truncateMiddle(r.tenantId, 8, 4),
                                                    count: 1,
                                                });
                                        }
                                        if (tenantMap.size <= 1)
                                            return null;
                                        return (React.createElement("span", { className: "text-2xs" },
                                            "Spans ",
                                            tenantMap.size,
                                            " tenants"));
                                    })()))))) })),
                    selfAssign && (React.createElement("div", { className: "rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs" }, selfAssignRecipient ? (React.createElement("p", null,
                        "Will assign to",
                        " ",
                        React.createElement("span", { className: "font-medium text-foreground" }, selfAssignRecipient.displayLabel),
                        " ",
                        "in",
                        " ",
                        React.createElement("span", { className: "font-medium text-foreground" }, selfAssignRecipient.tenantLabel),
                        ".")) : (React.createElement("p", { className: "text-destructive" }, "The active EA account has no resolvable AAD object ID for self-assignment. Sign in again or pick recipients manually."))))))),
            leafSelectionReady && totalRecipients === 1 && (React.createElement(Card, null,
                React.createElement(CardHeader, null,
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(FileSignature, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                        "Subscription Identity"),
                    React.createElement(CardDescription, null, "Auto-derived from the recipient. Override if needed.")),
                React.createElement(CardContent, { className: "flex flex-col gap-3" },
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement("div", { className: "flex items-center justify-between gap-2" },
                            React.createElement(Label, { htmlFor: "ea-alias" },
                                React.createElement(Tooltip, null,
                                    React.createElement(TooltipTrigger, { asChild: true },
                                        React.createElement("span", { className: "cursor-help underline decoration-dotted underline-offset-2" }, "Alias name")),
                                    React.createElement(TooltipContent, { className: "max-w-xs" }, "Azure resource name for the subscription alias. 3\u201363 chars, lowercase + digits + hyphens. Acts as the natural idempotency key on the Subscription Alias API \u2014 a duplicate PUT with the same alias is a no-op. We auto-derive a unique alias per recipient when the batch has > 1 recipient."))),
                            effectiveRecipients[0] && (React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => {
                                    const first = effectiveRecipients[0];
                                    if (!first)
                                        return;
                                    let alias = deriveAlias(first);
                                    if (!isValidAlias(alias)) {
                                        alias = `sub-${randomSuffix(5)}-${Date.now()
                                            .toString(36)
                                            .slice(-4)}`;
                                    }
                                    form.setValue("aliasName", alias, {
                                        shouldValidate: true,
                                        shouldDirty: false,
                                    });
                                }, "aria-label": "Regenerate alias from recipient", className: "gap-1 text-2xs text-muted-foreground" },
                                React.createElement(RefreshCw, { className: "h-3 w-3", "aria-hidden": true }),
                                "Regenerate"))),
                        React.createElement(Controller, { control: form.control, name: "aliasName", render: ({ field, fieldState }) => (React.createElement(React.Fragment, null,
                                React.createElement(Input, Object.assign({ id: "ea-alias" }, field, { "aria-invalid": fieldState.error ? true : undefined, "aria-describedby": "ea-alias-error", autoComplete: "off", spellCheck: false, className: "font-mono text-xs" })),
                                fieldState.error && (React.createElement("p", { id: "ea-alias-error", className: "text-2xs text-destructive", role: "alert" }, fieldState.error.message)))) })),
                    React.createElement("div", { className: "flex flex-col gap-1.5" },
                        React.createElement(Label, { htmlFor: "ea-display-name" },
                            React.createElement(Tooltip, null,
                                React.createElement(TooltipTrigger, { asChild: true },
                                    React.createElement("span", { className: "cursor-help underline decoration-dotted underline-offset-2" }, "Display name")),
                                React.createElement(TooltipContent, { className: "max-w-xs" }, "Human-friendly name shown in portal and the Subscriptions blade. 1\u201364 chars, free text. The recipient can rename when accepting ownership."))),
                        React.createElement(Controller, { control: form.control, name: "displayName", render: ({ field, fieldState }) => (React.createElement(React.Fragment, null,
                                React.createElement(Input, Object.assign({ id: "ea-display-name" }, field, { "aria-invalid": fieldState.error ? true : undefined, "aria-describedby": "ea-display-name-error", autoComplete: "off" })),
                                fieldState.error && (React.createElement("p", { id: "ea-display-name-error", className: "text-2xs text-destructive", role: "alert" }, fieldState.error.message)))) }))))),
            leafSelectionReady && activeAccount && (React.createElement(PreFlightPanel, { callerTenantId: activeAccount.tenantId, callerTenantLabel: tenantLabelFor(activeAccount.tenantId), callerUpn: activeAccount.username, recipients: effectiveRecipients })),
            leafSelectionReady && recipientStats.total > 0 && (React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Recipient batch summary" },
                React.createElement(SummaryStatItem, { label: "Total", value: recipientStats.total, hint: recipientStats.total === 1
                        ? "subscription"
                        : "subscriptions", tone: "info", compact: true }),
                React.createElement(SummaryStatItem, { label: "Cross-tenant", value: recipientStats.crossTenant, hint: recipientStats.crossTenant > 0
                        ? "needs accept"
                        : "same tenant", tone: recipientStats.crossTenant > 0 ? "warning" : "muted", compact: true }),
                React.createElement(SummaryStatItem, { label: "Disabled", value: recipientStats.disabled, hint: recipientStats.disabled > 0 ? "may 400" : "all enabled", tone: recipientStats.disabled > 0 ? "destructive" : "muted", compact: true }),
                React.createElement(SummaryStatItem, { label: "Tenants", value: recipientStats.tenantSpan, hint: recipientStats.tenantSpan > 1
                        ? "multi-tenant"
                        : "single", tone: recipientStats.tenantSpan > 1 ? "warning" : "muted", compact: true }),
                totalInFlight > 0 && (React.createElement(React.Fragment, null,
                    React.createElement(SummaryStatItem, { label: "Succeeded", value: successResults.length, hint: submitting
                            ? "in batch"
                            : completedCount === totalInFlight
                                ? "complete"
                                : "running", tone: "success", compact: true }),
                    React.createElement(SummaryStatItem, { label: "Failed", value: failureCount, hint: failureCount > 0 ? "see below" : "none", tone: failureCount > 0 ? "destructive" : "muted", compact: true }))))),
            leafSelectionReady && (React.createElement(Card, null,
                React.createElement(CardHeader, null,
                    React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                        React.createElement(FileSignature, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                        "Provisioning Summary"),
                    React.createElement(CardDescription, null, totalRecipients <= 1
                        ? "Review the destination scope before submitting."
                        : "Names and aliases are auto-generated per recipient. Workload is fixed to Production.")),
                React.createElement(CardContent, { className: "flex flex-col gap-3" },
                    React.createElement("div", { className: "rounded-md border border-border bg-surface-sunken px-3 py-2" },
                        React.createElement("p", { className: "mb-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground" }, "Billing scope"),
                        React.createElement("div", { className: "flex items-start gap-1.5" },
                            React.createElement("p", { className: "flex-1 break-all font-mono text-2xs text-foreground" }, billingScope ||
                                (isEa
                                    ? "(select an enrollment account)"
                                    : "(select an invoice section)")),
                            billingScope && (React.createElement(CopyableId, { value: billingScope, label: "billing scope" }))),
                        isEa && selectedEnrollmentAccountObj && (React.createElement("p", { className: "mt-1 flex items-center gap-1 text-2xs text-muted-foreground" },
                            React.createElement(ChevronRight, { className: "h-3 w-3", "aria-hidden": true }),
                            "Charges land in",
                            React.createElement("span", { className: "font-medium text-foreground" }, selectedEnrollmentAccountObj.displayName))),
                        !isEa && selectedInvoiceSectionObj && (React.createElement("p", { className: "mt-1 flex items-center gap-1 text-2xs text-muted-foreground" },
                            React.createElement(ChevronRight, { className: "h-3 w-3", "aria-hidden": true }),
                            "Charges land in",
                            React.createElement("span", { className: "font-medium text-foreground" }, selectedInvoiceSectionObj.displayName),
                            selectedBillingProfileObj && (React.createElement("span", { className: "text-foreground/70" },
                                "(",
                                selectedBillingProfileObj.displayName,
                                ")"))))),
                    totalRecipients > 1 && (React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs" },
                        React.createElement("div", { className: "flex items-center gap-2" },
                            React.createElement(Label, { htmlFor: "ea-concurrency", className: "text-2xs uppercase tracking-wider text-muted-foreground" },
                                React.createElement(Tooltip, null,
                                    React.createElement(TooltipTrigger, { asChild: true },
                                        React.createElement("span", { className: "cursor-help underline decoration-dotted underline-offset-2" }, "Parallel calls")),
                                    React.createElement(TooltipContent, { className: "max-w-xs" }, "How many subscription-creation requests run simultaneously. 1 = strictly serial (gentlest on the EA billing API). 5 = fastest, but more likely to trip 429 throttles on large enrollments. Default 3 balances speed and reliability."))),
                            React.createElement(Select, { value: concurrencyChoice, onValueChange: (v) => setConcurrencyChoice(v), disabled: submitting },
                                React.createElement(SelectTrigger, { id: "ea-concurrency", className: "h-7 w-20 text-xs", "aria-label": "Concurrency for batch submit" },
                                    React.createElement(SelectValue, null)),
                                React.createElement(SelectContent, null,
                                    React.createElement(SelectItem, { value: "1" }, "1 (serial)"),
                                    React.createElement(SelectItem, { value: "3" }, "3 (default)"),
                                    React.createElement(SelectItem, { value: "5" }, "5 (fastest)")))),
                        React.createElement("div", { className: "flex items-center gap-3 text-2xs text-muted-foreground" },
                            React.createElement("span", null,
                                "Est. wall-clock:",
                                " ",
                                React.createElement("span", { className: "font-medium text-foreground" },
                                    formatElapsedSec(Math.ceil((totalRecipients /
                                        parseInt(concurrencyChoice, 10)) *
                                        60)),
                                    " ",
                                    "\u2013 ",
                                    " ",
                                    formatElapsedSec(Math.ceil((totalRecipients /
                                        parseInt(concurrencyChoice, 10)) *
                                        90))))))),
                    totalInFlight > 0 && !submitting && (React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5" },
                        React.createElement("div", { className: "flex flex-wrap items-center gap-4 text-xs" },
                            React.createElement("div", { className: "flex items-center gap-1.5" },
                                React.createElement(CheckCircle2, { className: "h-3.5 w-3.5 text-success", "aria-hidden": true }),
                                React.createElement("span", { className: "font-semibold tabular-nums text-success" }, successResults.length),
                                React.createElement("span", { className: "text-muted-foreground" }, "succeeded")),
                            React.createElement("div", { className: "flex items-center gap-1.5" },
                                React.createElement(AlertCircle, { className: "h-3.5 w-3.5 text-destructive", "aria-hidden": true }),
                                React.createElement("span", { className: "font-semibold tabular-nums text-destructive" }, failureCount),
                                React.createElement("span", { className: "text-muted-foreground" }, "failed")),
                            pendingCount + runningCount > 0 && (React.createElement("div", { className: "flex items-center gap-1.5" },
                                React.createElement(Loader2, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true }),
                                React.createElement("span", { className: "font-semibold tabular-nums" }, pendingCount + runningCount),
                                React.createElement("span", { className: "text-muted-foreground" }, "pending"))),
                            elapsedStats.count > 0 && (React.createElement("div", { className: "text-2xs text-muted-foreground" },
                                "median",
                                " ",
                                React.createElement("span", { className: "font-medium tabular-nums text-foreground" }, formatElapsedSec(elapsedStats.median)),
                                " ",
                                "\u00B7 max",
                                " ",
                                React.createElement("span", { className: "font-medium tabular-nums text-foreground" }, formatElapsedSec(elapsedStats.max)),
                                submitElapsedSec > 0 && (React.createElement(React.Fragment, null,
                                    " ",
                                    "\u00B7 total",
                                    " ",
                                    React.createElement("span", { className: "font-medium tabular-nums text-foreground" }, formatElapsedSec(submitElapsedSec))))))),
                        React.createElement("div", { className: "flex items-center gap-1.5" },
                            failedKeys.length > 0 && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleRetryFailed, disabled: submitting, "aria-label": `Retry ${failedKeys.length} failed`, className: "gap-1" },
                                React.createElement(RotateCcw, { className: "h-3 w-3", "aria-hidden": true }),
                                "Retry failed (",
                                failedKeys.length,
                                ")")),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => handleExportResults("csv"), "aria-label": "Export batch results as CSV", className: "gap-1" },
                                React.createElement(Download, { className: "h-3 w-3", "aria-hidden": true }),
                                "CSV"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => handleExportResults("json"), "aria-label": "Export batch results as JSON", className: "gap-1" },
                                React.createElement(Download, { className: "h-3 w-3", "aria-hidden": true }),
                                "JSON")))),
                    activeAccount && totalInFlight > 0 && (React.createElement(ReconciliationTile, { callerTenantId: activeAccount.tenantId, recipients: effectiveRecipients, statusMap: statusMap, submitting: submitting })),
                    batchErrors.length > 0 && (React.createElement(Alert, { variant: "destructive", role: "alert", "aria-live": "assertive", "aria-atomic": "false" },
                        React.createElement(AlertCircle, { className: "h-4 w-4" }),
                        React.createElement(AlertDescription, null,
                            React.createElement("p", { className: "mb-1 font-medium" },
                                batchErrors.length,
                                " of ",
                                totalInFlight,
                                " subscription",
                                totalInFlight === 1 ? "" : "s",
                                " failed."),
                            hasStaleSession && (React.createElement("div", { className: "mb-2 flex flex-wrap items-center gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-2xs" },
                                React.createElement(ShieldAlert, { className: "h-4 w-4 shrink-0 text-warning", "aria-hidden": true }),
                                React.createElement("span", { className: "flex-1 text-warning-foreground" },
                                    "Your sign-in session for",
                                    " ",
                                    React.createElement("strong", null, activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username),
                                    " is no longer valid (MSAL refresh token expired, revoked, or wiped). Click the button to re-auth interactively, then Retry failed."),
                                React.createElement(Button, { type: "button", size: "sm", variant: "default", disabled: armTokenTracker.loading, onClick: () => void armTokenTracker.reauth({
                                        loginHint: activeAccount === null || activeAccount === void 0 ? void 0 : activeAccount.username,
                                    }) },
                                    armTokenTracker.loading ? (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin motion-reduce:animate-none", "aria-hidden": true })) : (React.createElement(BadgeCheck, { className: "h-3.5 w-3.5", "aria-hidden": true })),
                                    "Sign in again"))),
                            React.createElement("ul", { className: "list-none space-y-2 text-2xs" }, batchErrors.map((b) => {
                                const tip = suggestRemediation(b.error);
                                const cat = categorizeError(b.error);
                                return (React.createElement("li", { key: b.key },
                                    React.createElement("p", { className: "flex items-start gap-2" },
                                        React.createElement(Badge, { variant: "secondary", className: cn("shrink-0 text-2xs font-normal uppercase tracking-wider", cat.tone === "auth" &&
                                                "border-warning/40 bg-warning/10 text-warning", cat.tone === "data" &&
                                                "border-destructive/40 bg-destructive/10 text-destructive", cat.tone === "quota" &&
                                                "border-warning/40 bg-warning/10 text-warning", cat.tone === "transient" &&
                                                "border-primary/40 bg-primary/10 text-primary", cat.tone === "input" &&
                                                "border-info/40 bg-info/10 text-info") }, cat.label),
                                        React.createElement("span", { className: "flex-1" },
                                            React.createElement("span", { className: "font-medium" },
                                                b.label,
                                                ":"),
                                            " ",
                                            b.error)),
                                    tip && (React.createElement("p", { className: "mt-0.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-2xs text-destructive/90" },
                                        React.createElement("span", { className: "font-semibold" },
                                            "How to fix:",
                                            " "),
                                        tip))));
                            })),
                            tokenDiagnostic &&
                                batchErrors.some((b) => /401|not authorized|authoriz|billingpermission/i.test(b.error)) && (React.createElement("div", { className: "mt-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs" },
                                React.createElement("p", { className: "mb-1 font-semibold text-destructive/90" }, "Token diagnostic (verify the token actually carries the role)"),
                                React.createElement("dl", { className: "grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono" },
                                    tokenDiagnostic.upn && (React.createElement(React.Fragment, null,
                                        React.createElement("dt", { className: "text-muted-foreground" }, "upn"),
                                        React.createElement("dd", { className: "break-all" }, tokenDiagnostic.upn))),
                                    React.createElement("dt", { className: "text-muted-foreground" }, "tid"),
                                    React.createElement("dd", { className: "break-all" }, tokenDiagnostic.tid || "—"),
                                    React.createElement("dt", { className: "text-muted-foreground" }, "oid"),
                                    React.createElement("dd", { className: "break-all" }, tokenDiagnostic.oid || "—"),
                                    React.createElement("dt", { className: "text-muted-foreground" }, "aud"),
                                    React.createElement("dd", { className: "break-all" }, tokenDiagnostic.aud || "—"),
                                    tokenDiagnostic.issuedAt && (React.createElement(React.Fragment, null,
                                        React.createElement("dt", { className: "text-muted-foreground" }, "iat"),
                                        React.createElement("dd", { className: "break-all" }, tokenDiagnostic.issuedAt)))),
                                React.createElement("p", { className: "mt-1.5 text-muted-foreground" },
                                    "Verify in the EA Portal that the principal with this ",
                                    React.createElement("code", null, "oid"),
                                    " in tenant",
                                    " ",
                                    React.createElement("code", null, tokenDiagnostic.tid),
                                    " is granted",
                                    React.createElement("em", null, " EA Subscription Creator"),
                                    " on the selected enrollment account. If the role was added in the last few minutes, retry \u2014 propagation can take up to 5 minutes after a fresh token is issued. If",
                                    React.createElement("code", null, " aud"),
                                    " is not",
                                    " ",
                                    React.createElement("code", null, "https://management.azure.com"),
                                    ", sign out and sign in again."))),
                            hasAuthFailure && (React.createElement("div", { className: "mt-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs" },
                                React.createElement("p", { className: "mb-1 font-semibold text-destructive/90" }, "EA role assignments at this scope (live)"),
                                roleDiagnosticLoading && (React.createElement("p", { className: "text-muted-foreground" }, "Querying billingRoleAssignments\u2026")),
                                roleDiagnosticError && (React.createElement("p", { className: "text-muted-foreground" },
                                    "Could not read role assignments at this scope (billingRoleAssignments returned:",
                                    " ",
                                    roleDiagnosticError,
                                    "). This usually means your principal has zero billing-scope roles here, or the EA Portal hasn't propagated your role yet.")),
                                roleDiagnostic && (React.createElement(React.Fragment, null, roleDiagnostic.assignments.length === 0 ? (React.createElement("p", { className: "text-muted-foreground" },
                                    "Your principal has",
                                    " ",
                                    React.createElement("strong", null, "no role assignments"),
                                    " on this enrollment-account scope. The \"EA Account Owner\" flag in EA Portal does ",
                                    React.createElement("strong", null, "not"),
                                    " by itself create the Azure RBAC role assignment that the Subscription Alias API checks. An Enterprise Administrator must explicitly add you as an Account Owner of THIS enrollment account (not just the enrollment), OR grant you the",
                                    " ",
                                    React.createElement("em", null, "EA Subscription Creator"),
                                    " role at this scope.")) : (React.createElement(React.Fragment, null,
                                    React.createElement("p", { className: "text-muted-foreground" },
                                        "Roles found for principal",
                                        " ",
                                        React.createElement("code", null, (_b = roleDiagnostic.assignments[0]) === null || _b === void 0 ? void 0 : _b.principalId),
                                        " ",
                                        "at this scope:"),
                                    React.createElement("ul", { className: "mt-1 list-disc pl-4" }, roleDiagnostic.assignments.map((a) => (React.createElement("li", { key: a.id },
                                        React.createElement("strong", null, a.roleDefinitionName),
                                        a.createdOn && (React.createElement("span", { className: "ml-1 text-muted-foreground" },
                                            "(granted",
                                            " ",
                                            new Date(a.createdOn).toLocaleString(),
                                            ")")))))),
                                    React.createElement("p", { className: "mt-1 text-muted-foreground" }, roleDiagnostic.canCreateSubscriptions
                                        ? "These roles SHOULD allow subscription creation. The 401 then is most likely propagation lag — wait 1–5 min and retry."
                                        : "None of these roles allow subscription creation. Ask an Enterprise Administrator to grant you EA Subscription Creator at this scope.")))))))))),
                    (submitting || totalInFlight > 0) &&
                        effectiveRecipients.length > 0 && (React.createElement("div", { className: cn("flex flex-col gap-2.5 rounded-lg border bg-card px-3.5 py-3", "transition-colors duration-200 ease-out", submitting
                            ? "border-primary/40 bg-primary/5"
                            : "border-border"), "aria-live": "polite", "aria-atomic": "false" },
                        React.createElement("div", { className: "flex items-center justify-between gap-2 text-xs" },
                            React.createElement("span", { className: "flex items-center gap-2 font-medium" },
                                submitting ? (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none", "aria-hidden": true })) : completedCount === totalInFlight &&
                                    batchErrors.length === 0 ? (React.createElement(CheckCircle2, { className: "h-3.5 w-3.5 text-success", "aria-hidden": true })) : (React.createElement(AlertCircle, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true })),
                                submitting
                                    ? "Calling Subscription Alias API"
                                    : "Provisioning complete"),
                            React.createElement("span", { className: "flex items-center gap-3 text-2xs text-muted-foreground" },
                                React.createElement("span", null,
                                    completedCount,
                                    "/",
                                    totalInFlight,
                                    " done"),
                                submitElapsedSec > 0 && (React.createElement("span", { className: "tabular-nums" },
                                    submitElapsedSec,
                                    "s elapsed")))),
                        React.createElement(Progress, { value: totalInFlight === 0
                                ? 0
                                : Math.round((completedCount / totalInFlight) * 100), "aria-label": "Subscription provisioning progress" }),
                        submitting && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            "Each subscription is an async ARM operation:",
                            " ",
                            React.createElement("span", { className: "font-medium text-foreground" }, "PUT alias"),
                            " → ",
                            React.createElement("span", { className: "font-medium text-foreground" }, "poll every 5s"),
                            " → ",
                            React.createElement("span", { className: "font-medium text-foreground" }, "subscription GUID returned"),
                            ". Typical wait: 30\u201390 seconds per recipient. Don't close the tab.")),
                        React.createElement("ul", { className: "flex flex-col gap-1 text-2xs" }, effectiveRecipients.map((r) => {
                            const s = statusMap[r.key];
                            const elapsedSec = (s === null || s === void 0 ? void 0 : s.state) === "running"
                                ? (Date.now() - s.startedAt) / 1000
                                : (s === null || s === void 0 ? void 0 : s.state) === "success" ||
                                    (s === null || s === void 0 ? void 0 : s.state) === "failure"
                                    ? (s.completedAt - s.startedAt) / 1000
                                    : 0;
                            return (React.createElement("li", { key: r.key, className: cn("flex items-center gap-2 rounded px-1.5 py-1 transition-colors duration-150", (s === null || s === void 0 ? void 0 : s.state) === "running" && "bg-primary/10", (s === null || s === void 0 ? void 0 : s.state) === "success" && "bg-success/10", (s === null || s === void 0 ? void 0 : s.state) === "failure" && "bg-destructive/10") },
                                !s || s.state === "pending" ? (React.createElement(Loader2, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": true })) : s.state === "running" ? (React.createElement(Loader2, { className: "h-3 w-3 animate-spin text-primary motion-reduce:animate-none", "aria-hidden": true })) : s.state === "success" ? (React.createElement(CheckCircle2, { className: "h-3 w-3 text-success", "aria-hidden": true })) : (React.createElement(AlertCircle, { className: "h-3 w-3 text-destructive", "aria-hidden": true })),
                                React.createElement("span", { className: "truncate font-medium" }, r.displayLabel),
                                React.createElement("span", { className: "text-muted-foreground" }, "\u00B7"),
                                React.createElement("span", { className: "min-w-0 flex-1 truncate text-muted-foreground" }, (s === null || s === void 0 ? void 0 : s.state) === "success" && s.subscriptionId ? (React.createElement(React.Fragment, null,
                                    "id",
                                    " ",
                                    React.createElement("code", { className: "font-mono" }, truncateMiddle(s.subscriptionId, 8, 4)))) : (s === null || s === void 0 ? void 0 : s.state) === "success" ? (React.createElement(React.Fragment, null,
                                    "alias",
                                    " ",
                                    React.createElement("code", { className: "font-mono" }, s.aliasName),
                                    " ",
                                    "(id pending)")) : (s === null || s === void 0 ? void 0 : s.state) === "failure" ? (s.error) : (s === null || s === void 0 ? void 0 : s.state) === "running" ? ("creating subscription alias...") : ("queued")),
                                elapsedSec > 0 && (React.createElement("span", { className: "shrink-0 tabular-nums text-muted-foreground" }, formatElapsedSec(elapsedSec)))));
                        })))),
                    successResults.length > 0 && (React.createElement("div", { className: cn("flex flex-col gap-2 rounded-lg border border-success/40 bg-success/5 px-3.5 py-3", "transition-colors duration-200 ease-out"), role: "region", "aria-label": "Successfully provisioned subscriptions" },
                        React.createElement("div", { className: "flex items-center gap-2 text-sm font-medium text-success-foreground" },
                            React.createElement(PartyPopper, { className: "h-4 w-4 text-success", "aria-hidden": true }),
                            React.createElement("span", null, successResults.length === 1
                                ? "Subscription provisioned"
                                : `${successResults.length} subscriptions provisioned`),
                            React.createElement(Sparkles, { className: "h-3.5 w-3.5 text-success/70", "aria-hidden": true })),
                        React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            "The new subscription",
                            successResults.length === 1 ? " is" : "s are",
                            " live in Azure. Click an ID to copy, or open it in the portal."),
                        React.createElement("ul", { className: "flex flex-col gap-1.5" }, successResults.map(({ recipient, status }) => {
                            // Cross-tenant: the recipient's tenantId differs from
                            // the API caller's home tenant. The new owner has 7
                            // days to accept ownership in the destination tenant.
                            // Surface a "Copy approver URL" button so the
                            // operator can paste the link into chat / email
                            // independent of the auto-email Microsoft sends.
                            const approverUrl = status.subscriptionId
                                ? buildAcceptOwnershipPortalUrl(recipient.tenantId, status.subscriptionId)
                                : null;
                            return (React.createElement("li", { key: recipient.key, className: "flex flex-col gap-1.5 rounded-md border border-success/30 bg-card px-2.5 py-1.5" },
                                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                                    React.createElement(CheckCircle2, { className: "h-3.5 w-3.5 shrink-0 text-success", "aria-hidden": true }),
                                    React.createElement("span", { className: "flex min-w-0 flex-1 flex-col leading-tight" },
                                        React.createElement("span", { className: "truncate text-xs font-medium text-foreground" }, recipient.displayLabel),
                                        recipient.tenantLabel && (React.createElement("span", { className: "truncate text-2xs text-muted-foreground" },
                                            recipient.tenantLabel,
                                            recipient.upn ? ` · ${recipient.upn}` : ""))),
                                    status.subscriptionId ? (React.createElement(React.Fragment, null,
                                        React.createElement(CopyableId, { value: status.subscriptionId, label: "subscription id" }),
                                        React.createElement("a", { href: azurePortalLinkForSubscription(status.subscriptionId), target: "_blank", rel: "noopener noreferrer", className: cn("inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-2xs font-medium text-foreground", "transition-all duration-200 ease-out hover:border-primary hover:bg-accent/5 hover:text-primary", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"), "aria-label": `Open ${status.subscriptionId} in Azure Portal` },
                                            React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true }),
                                            "Open in Azure Portal"))) : (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                        "alias",
                                        " ",
                                        React.createElement("span", { className: "font-mono text-foreground" }, status.aliasName),
                                        " ",
                                        "created \u2014 subscription id pending"))),
                                approverUrl && (React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5", role: "note", "aria-label": "Pending owner acceptance" },
                                    React.createElement(Hourglass, { className: "h-3.5 w-3.5 shrink-0 text-warning", "aria-hidden": true }),
                                    React.createElement("span", { className: "flex min-w-0 flex-1 flex-col leading-tight" },
                                        React.createElement("span", { className: "text-2xs font-medium text-foreground" }, "Awaiting owner acceptance \u00B7 expires in 7 days"),
                                        React.createElement("span", { className: "truncate text-2xs text-muted-foreground" }, "Paste this URL to the new owner so they can accept ownership in their tenant:")),
                                    React.createElement("code", { className: "max-w-full truncate rounded bg-background px-2 py-1 font-mono text-2xs text-foreground", title: approverUrl }, approverUrl),
                                    React.createElement(Button, { type: "button", variant: "outline", size: "xs", onClick: () => __awaiter(void 0, void 0, void 0, function* () {
                                            try {
                                                yield navigator.clipboard.writeText(approverUrl);
                                                store.addNotification({
                                                    type: "success",
                                                    message: `Approver URL copied for ${recipient.displayLabel}.`,
                                                });
                                            }
                                            catch (_a) {
                                                store.addNotification({
                                                    type: "error",
                                                    message: "Clipboard blocked — select the URL manually.",
                                                });
                                            }
                                        }), "aria-label": `Copy approver URL for ${recipient.displayLabel}`, className: "gap-1" },
                                        React.createElement(Link2, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Copy URL"),
                                    React.createElement("a", { href: approverUrl, target: "_blank", rel: "noopener noreferrer", className: cn("inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-2xs font-medium text-foreground", "transition-all duration-200 ease-out hover:border-warning hover:bg-warning/5 hover:text-warning"), "aria-label": "Open the approver URL in a new tab", title: "Opens the destination-tenant Subscriptions blade" },
                                        React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true }),
                                        "Open")))));
                        })))),
                    React.createElement("div", { className: "flex flex-wrap items-center justify-end gap-2" },
                        !formReady && !submitting && (React.createElement("p", { className: "text-2xs text-muted-foreground" }, "Pick a billing scope and at least one recipient to enable submit.")),
                        formReady && !submitting && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                            "Hotkey:",
                            " ",
                            React.createElement("kbd", { className: "rounded border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-foreground" }, "Ctrl"),
                            " ",
                            React.createElement("span", { "aria-hidden": true }, "+"),
                            " ",
                            React.createElement("kbd", { className: "rounded border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-foreground" }, "Enter"),
                            " ",
                            "to open confirm")),
                        React.createElement(Button, { type: "button", variant: "default", size: "lg", onClick: () => setConfirmOpen(true), disabled: !formReady || submitting, "aria-label": "Create EA subscriptions (Ctrl+Enter)", title: "Create EA subscriptions \u2014 Ctrl+Enter", className: "transition-all duration-200 ease-out hover:shadow-elev-2" },
                            React.createElement(PlusCircle, { className: "h-4 w-4", "aria-hidden": true }),
                            totalRecipients <= 1
                                ? "Create Subscription"
                                : `Create ${totalRecipients} Subscriptions`))))))) : null,
        (() => {
            // Recompute confirm panel content based on retry mode. In retry
            // mode, the dialog targets only the previously-failed recipients;
            // in normal mode it targets the full effective recipient list.
            const isRetryMode = retryOnlyKeys !== null && retryOnlyKeys.size > 0;
            const confirmRecipients = isRetryMode
                ? effectiveRecipients.filter((r) => retryOnlyKeys.has(r.key))
                : effectiveRecipients;
            const confirmCount = confirmRecipients.length;
            const previewList = confirmRecipients.slice(0, 10);
            const previewExtra = Math.max(0, confirmCount - previewList.length);
            const crossTenantCount = activeAccount
                ? confirmRecipients.filter((r) => r.tenantId.toLowerCase() !==
                    activeAccount.tenantId.toLowerCase()).length
                : 0;
            const tenantSet = new Set(confirmRecipients.map((r) => r.tenantId));
            return (React.createElement(ConfirmationDialog, { hidden: !confirmOpen, danger: true, title: isRetryMode
                    ? `Retry ${confirmCount} failed subscription${confirmCount === 1 ? "" : "s"}`
                    : confirmCount <= 1
                        ? "Create EA subscription"
                        : `Create ${confirmCount} EA subscriptions`, message: React.createElement("div", { className: "flex flex-col gap-3" },
                    React.createElement("div", { className: "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground" },
                        React.createElement(AlertTriangle, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive", "aria-hidden": true }),
                        React.createElement("p", null,
                            React.createElement("strong", { className: "font-semibold text-destructive" }, "This action is irreversible."),
                            " ",
                            "Subscriptions are created in Azure under your",
                            " ",
                            React.createElement("strong", { className: "font-semibold text-foreground" }, "Enterprise Agreement billing scope"),
                            " ",
                            "and",
                            " ",
                            React.createElement("strong", { className: "font-semibold text-foreground" }, "cannot be cancelled from this UI"),
                            ". Only an EA admin can transfer or cancel them later.")),
                    isRetryMode && (React.createElement("div", { className: "flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning-foreground" },
                        React.createElement(RotateCcw, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-warning", "aria-hidden": true }),
                        React.createElement("p", null,
                            React.createElement("strong", { className: "font-semibold" }, "Retry mode."),
                            " ",
                            "Only the ",
                            confirmCount,
                            " recipient",
                            confirmCount === 1 ? "" : "s",
                            " that failed in the previous batch will be re-submitted. Successful results from the previous batch remain visible below."))),
                    crossTenantCount > 0 && (React.createElement("div", { className: "flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs" },
                        React.createElement(Hourglass, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-warning", "aria-hidden": true }),
                        React.createElement("p", null,
                            React.createElement("strong", { className: "font-semibold" },
                                crossTenantCount,
                                " cross-tenant subscription",
                                crossTenantCount === 1 ? "" : "s"),
                            " ",
                            "will be created. Each owner has",
                            " ",
                            React.createElement("strong", null, "7 days"),
                            " to accept ownership in their destination tenant \u2014 paste the approver URL we generate below to chat / email them, or they can use the \"Accept incoming subscription\" panel at the top of this page."))),
                    React.createElement("p", null, confirmLeafName
                        ? confirmCount <= 1
                            ? `Create one subscription under '${confirmLeafName}' for the recipient below?`
                            : `Create ${confirmCount} subscriptions under '${confirmLeafName}', one per recipient below?`
                        : "Create subscriptions?"),
                    activeAccount && (React.createElement("p", { className: "text-xs" },
                        "EA billing account:",
                        " ",
                        React.createElement("span", { className: "font-medium text-foreground" }, activeAccount.name || activeAccount.username))),
                    React.createElement("p", { className: "break-all rounded border border-border bg-surface-sunken px-2 py-1 font-mono text-2xs" }, billingScope),
                    confirmCount > 1 && (React.createElement("p", { className: "text-2xs text-muted-foreground" },
                        "Parallelism:",
                        " ",
                        React.createElement("span", { className: "font-medium text-foreground" },
                            concurrencyChoice,
                            " at a time"),
                        tenantSet.size > 1 ? (React.createElement(React.Fragment, null,
                            " · ",
                            "spans",
                            " ",
                            React.createElement("span", { className: "font-medium text-foreground" },
                                tenantSet.size,
                                " tenants"))) : null)),
                    confirmCount === 1 && (React.createElement("p", { className: "text-xs" },
                        "Alias:",
                        " ",
                        React.createElement("span", { className: "font-mono text-2xs text-foreground" }, aliasNameField),
                        " — ",
                        React.createElement("span", { className: "text-foreground" }, displayNameField))),
                    previewList.length > 0 && (React.createElement("ul", { className: "list-disc space-y-0.5 pl-4 text-xs" },
                        previewList.map((r) => (React.createElement("li", { key: r.key },
                            React.createElement("span", { className: "font-medium text-foreground" }, r.displayLabel),
                            r.upn ? React.createElement("span", null,
                                " \u00B7 ",
                                r.upn) : null,
                            " \u00B7",
                            " ",
                            React.createElement("span", null, r.tenantLabel),
                            r.enabled === false && (React.createElement("span", { className: "text-muted-foreground" },
                                " ",
                                "(disabled)"))))),
                        previewExtra > 0 && (React.createElement("li", { className: "text-muted-foreground" },
                            "...and ",
                            previewExtra,
                            " more"))))), confirmText: isRetryMode
                    ? `Yes, retry ${confirmCount}`
                    : confirmCount <= 1
                        ? "Yes, create subscription"
                        : `Yes, create ${confirmCount} subscriptions`, cancelText: "Cancel", loading: submitting, onConfirm: performSubmit, onCancel: () => {
                    if (!submitting) {
                        setConfirmOpen(false);
                        setRetryOnlyKeys(null);
                    }
                } }));
        })()));
};
export const EaSubscriptionPage = (props) => (React.createElement(ErrorBoundary, null,
    React.createElement(EaSubscriptionPageInner, Object.assign({}, props))));
//# sourceMappingURL=ea-subscription-page.js.map