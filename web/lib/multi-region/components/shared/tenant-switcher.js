import { __awaiter, __rest } from "tslib";
/**
 * Global tenant + account switcher pinned to the app header.
 *
 * Why this exists: even though the operator can switch tenants on the
 * `/azure-accounts` page (drawer + inline row dropdown), that flow
 * requires *navigating away* from the page they're working on. After
 * the switch they have to navigate back — meanwhile any page-scoped
 * state is wiped. This pin always-visible switcher means the operator
 * can pivot tenants from anywhere in the app and the current page
 * just re-fetches itself via the `TENANT_CHANGED_EVENT` listeners.
 *
 * Behaviour:
 *   - Pill shows the CURRENT active account + active tenant friendly
 *     label.
 *   - Click opens a Radix Popover with a cmdk Command palette.
 *   - Searchable across every account's username AND every accessible
 *     tenant (displayName / defaultDomain / tenantId).
 *   - Each account is rendered as a CommandGroup; tenants are nested
 *     CommandItems. Current tenant shows a check icon + "active" tag.
 *   - Clicking a tenant runs the canonical `performTenantSwitch`
 *     flow — same audit shape, same notification, same sub-refresh as
 *     the Azure Accounts page.
 *   - In-flight switches show a loading spinner on the row + disable
 *     re-click. Concurrent rapid switches use a monotonic seq so the
 *     latest one wins.
 *   - Footer: "Add another account" + "Open Azure Accounts page".
 *   - Hotkey: Mod+Shift+T opens the popover.
 *   - Empty state: when no account is signed in, the pill becomes a
 *     "Sign in" button (delegated to `onAddAccount`).
 *
 * Token + state propagation: the switch helper writes MSAL's per-
 * account active tenant pointer AND the store's `activeTenantId` AND
 * fires `TENANT_CHANGED_EVENT`. Pages using `useArmToken` re-mint
 * automatically (the hook listens for the event). Pages with extra
 * tenant-scoped local state should add their own `useTenantChange`
 * listener — this component doesn't reach into their state.
 */
import * as React from "react";
import { AlertTriangle, Building2, Check, ChevronsUpDown, Loader2, LogIn, Plus, Settings, Star, UserCog, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { KbdChord } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { findTenantLabel, performTenantSwitch, resolveActiveTenantId, } from "../../auth/perform-tenant-switch";
import { listAccessibleTenants } from "../../auth/msal-auth";
import { modKeyLabel, useShortcut } from "../../hooks/use-shortcut";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
/**
 * Truncate a GUID to the first 8 chars for compact display.
 * Avoids importing the page-local helpers; intentionally inlined.
 */
function shortGuid(id) {
    if (!id)
        return "";
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
export const TenantSwitcher = ({ onAddAccount, onOpenManage, }) => {
    var _a, _b, _c;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const accounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
    const [open, setOpen] = React.useState(false);
    // Map<accountId, tenantId-in-flight>. Used to disable rows + show
    // per-row spinner. Cleared by the switch helper's finally.
    const [switchingMap, setSwitchingMap] = React.useState({});
    // Per-account abort + seq so rapid clicks on different rows don't
    // race each other. The seq is the canonical "is this still the
    // latest" check; AbortController kills the in-flight sub list.
    const seqByAccountRef = React.useRef({});
    const abortByAccountRef = React.useRef({});
    // Tenant-list fetch-on-open. The Azure Accounts page pre-loads
    // tenants per account at first load (after the recent fix), so this
    // is normally a no-op. But if the operator opened the app fresh
    // OR an account was added after that load OR a refresh failed, we
    // back-fill here so the switcher always has tenants to show.
    const [tenantsFetching, setTenantsFetching] = React.useState(new Set());
    const fetchedRef = React.useRef(new Set());
    React.useEffect(() => {
        if (!open || accounts.length === 0)
            return;
        const needsTenants = accounts.filter((a) => (!a.tenants || a.tenants.length === 0) &&
            !fetchedRef.current.has(a.homeAccountId));
        if (needsTenants.length === 0)
            return;
        setTenantsFetching((prev) => {
            const next = new Set(prev);
            for (const a of needsTenants)
                next.add(a.homeAccountId);
            return next;
        });
        void Promise.allSettled(needsTenants.map((a) => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const list = yield listAccessibleTenants(a.homeAccountId);
                store.updateAzureAccount(a.homeAccountId, { tenants: list });
                fetchedRef.current.add(a.homeAccountId);
            }
            catch (_a) {
                /* swallow — operator can retry by closing & reopening. */
            }
            finally {
                setTenantsFetching((prev) => {
                    const next = new Set(prev);
                    next.delete(a.homeAccountId);
                    return next;
                });
            }
        })));
    }, [open, accounts, store]);
    // Mod+Shift+T opens the popover from anywhere in the app.
    useShortcut("Mod+Shift+t", (e) => {
        e.preventDefault();
        setOpen((prev) => !prev);
    });
    // Primary account drives the pill label. We pick the most-recently-
    // added account as a heuristic — same convention as the rest of the
    // app, where the "primary" account is the one whose token most
    // pages use by default.
    const primaryAccount = (_b = accounts[0]) !== null && _b !== void 0 ? _b : null;
    const primaryActiveTenantId = primaryAccount
        ? resolveActiveTenantId(primaryAccount)
        : undefined;
    const primaryTenantLabel = primaryAccount
        ? findTenantLabel(primaryAccount.tenants, primaryActiveTenantId, primaryActiveTenantId !== null && primaryActiveTenantId !== void 0 ? primaryActiveTenantId : "(no tenant)")
        : "";
    /**
     * Run the canonical switch flow. Wraps `performTenantSwitch` with
     * per-account seq + AbortController bookkeeping so concurrent
     * rapid clicks across different rows don't step on each other,
     * AND a slow stale switch can't overwrite a faster newer one.
     */
    const onPickTenant = React.useCallback((account, tenantId) => __awaiter(void 0, void 0, void 0, function* () {
        var _d, _e, _f;
        const homeAccountId = account.homeAccountId;
        if (switchingMap[homeAccountId])
            return; // already switching this row
        const currentActive = resolveActiveTenantId(account);
        if (currentActive === tenantId) {
            setOpen(false); // no-op switch — just close
            return;
        }
        const seq = ((_d = seqByAccountRef.current[homeAccountId]) !== null && _d !== void 0 ? _d : 0) + 1;
        seqByAccountRef.current[homeAccountId] = seq;
        // Abort any previous switch for this same account.
        (_e = abortByAccountRef.current[homeAccountId]) === null || _e === void 0 ? void 0 : _e.abort();
        const controller = new AbortController();
        abortByAccountRef.current[homeAccountId] = controller;
        setSwitchingMap((prev) => (Object.assign(Object.assign({}, prev), { [homeAccountId]: tenantId })));
        try {
            yield performTenantSwitch(account, tenantId, store, {
                source: "header-switcher",
                signal: controller.signal,
                isStale: () => { var _a; return ((_a = seqByAccountRef.current[homeAccountId]) !== null && _a !== void 0 ? _a : 0) !== seq; },
                onSuccess: () => {
                    // Close the popover once the new tenant's subs have
                    // loaded — gives the operator immediate visual feedback
                    // that the switch landed.
                    setOpen(false);
                },
            });
        }
        finally {
            // Only clear the spinner if we're still the latest switch.
            // Otherwise the newer switch is in flight and owns the row.
            if (((_f = seqByAccountRef.current[homeAccountId]) !== null && _f !== void 0 ? _f : 0) === seq) {
                setSwitchingMap((prev) => {
                    const _a = prev, _b = homeAccountId, _drop = _a[_b], rest = __rest(_a, [typeof _b === "symbol" ? _b : _b + ""]);
                    return rest;
                });
                if (abortByAccountRef.current[homeAccountId] === controller) {
                    delete abortByAccountRef.current[homeAccountId];
                }
            }
        }
    }), [store, switchingMap]);
    // ─── Render: not-signed-in state ──────────────────────────────────
    if (accounts.length === 0) {
        if (!onAddAccount)
            return null;
        return (React.createElement(Button, { variant: "default", size: "sm", onClick: onAddAccount, className: "gap-1.5", "aria-label": "Sign in with Azure" },
            React.createElement(LogIn, { className: "h-3.5 w-3.5" }),
            "Sign in"));
    }
    // ─── Render: signed-in state — pill + popover ─────────────────────
    return (React.createElement(Popover, { open: open, onOpenChange: setOpen },
        React.createElement(Tooltip, null,
            React.createElement(TooltipTrigger, { asChild: true },
                React.createElement(PopoverTrigger, { asChild: true },
                    React.createElement(Button, { variant: "outline", size: "sm", className: cn("h-8 max-w-[18rem] gap-1.5 border-border bg-card/60 px-2.5 text-xs", "hover:border-primary/40 hover:bg-card", open && "border-primary/60 bg-card"), "aria-label": "Switch active tenant", "aria-haspopup": "listbox", "aria-expanded": open },
                        React.createElement("span", { className: "flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-primary/15 text-primary", "aria-hidden": "true" },
                            React.createElement(Building2, { className: "h-3 w-3" })),
                        React.createElement("span", { className: "flex min-w-0 flex-col items-start leading-tight" },
                            React.createElement("span", { className: "truncate text-2xs uppercase tracking-wider text-muted-foreground" }, (_c = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _c !== void 0 ? _c : "—"),
                            React.createElement("span", { className: "truncate text-xs font-medium text-foreground" }, primaryTenantLabel || "(pick tenant)")),
                        React.createElement(ChevronsUpDown, { className: "ml-1 h-3 w-3 shrink-0 text-muted-foreground", "aria-hidden": "true" })))),
            React.createElement(TooltipContent, { side: "bottom" },
                React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                    "Switch active tenant",
                    React.createElement(KbdChord, { keys: `${modKeyLabel()}+Shift+T` })))),
        React.createElement(PopoverContent, { align: "end", sideOffset: 6, className: "w-[26rem] p-0" },
            React.createElement(Command
            // cmdk uses substring match across every CommandItem's
            // `value` prop. We build `value` to include both the
            // account username AND the tenant identifiers so a single
            // search hits either.
            , { 
                // cmdk uses substring match across every CommandItem's
                // `value` prop. We build `value` to include both the
                // account username AND the tenant identifiers so a single
                // search hits either.
                label: "Switch tenant" },
                React.createElement(CommandInput, { placeholder: "Search by tenant name, domain, or account\u2026", autoFocus: true }),
                React.createElement(CommandList, { className: "max-h-[60vh]" },
                    React.createElement(CommandEmpty, null, "No matching tenants."),
                    accounts.map((acct) => {
                        var _a;
                        const accountTenants = (_a = acct.tenants) !== null && _a !== void 0 ? _a : [];
                        const activeTenantId = resolveActiveTenantId(acct);
                        const isLoading = tenantsFetching.has(acct.homeAccountId);
                        const inFlightTenantId = switchingMap[acct.homeAccountId];
                        return (React.createElement(CommandGroup, { key: acct.homeAccountId, heading: acct.username || acct.name || acct.homeAccountId },
                            accountTenants.length === 0 && !isLoading && (React.createElement(CommandItem, { value: `${acct.homeAccountId}-no-tenants`, disabled: true, className: "text-2xs italic text-muted-foreground" },
                                React.createElement(AlertTriangle, { className: "h-3.5 w-3.5 text-warning" }),
                                "No tenants loaded for this account \u2014 visit Azure Accounts to refresh.")),
                            isLoading && (React.createElement(CommandItem, { value: `${acct.homeAccountId}-loading`, disabled: true, className: "text-2xs italic text-muted-foreground" },
                                React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin motion-reduce:animate-none" }),
                                "Loading tenants\u2026")),
                            accountTenants.map((t) => {
                                var _a, _b, _c, _d, _e, _f, _g, _h;
                                const isActive = t.tenantId === activeTenantId;
                                const isInFlight = inFlightTenantId === t.tenantId;
                                const isHome = t.tenantId === acct.tenantId;
                                const friendly = (_b = (_a = t.displayName) !== null && _a !== void 0 ? _a : t.defaultDomain) !== null && _b !== void 0 ? _b : shortGuid(t.tenantId);
                                // Include searchable tokens in `value` so cmdk
                                // can match. The visible label comes from JSX.
                                const searchValue = [
                                    (_c = acct.username) !== null && _c !== void 0 ? _c : "",
                                    (_d = acct.name) !== null && _d !== void 0 ? _d : "",
                                    (_e = t.displayName) !== null && _e !== void 0 ? _e : "",
                                    (_f = t.defaultDomain) !== null && _f !== void 0 ? _f : "",
                                    (_g = t.tenantId) !== null && _g !== void 0 ? _g : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")
                                    .toLowerCase();
                                return (React.createElement(CommandItem, { key: `${acct.homeAccountId}-${t.tenantId}`, value: `${acct.homeAccountId}:${t.tenantId}:${searchValue}`, disabled: !!inFlightTenantId, onSelect: () => {
                                        void onPickTenant(acct, t.tenantId);
                                    }, className: cn("group/row gap-2", isActive && "bg-primary/5") },
                                    React.createElement("span", { className: "flex h-5 w-5 shrink-0 items-center justify-center", "aria-hidden": "true" }, isInFlight ? (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" })) : isActive ? (React.createElement(Check, { className: "h-3.5 w-3.5 text-primary" })) : (React.createElement("span", { className: "h-1.5 w-1.5 rounded-full bg-muted-foreground/30 group-hover/row:bg-muted-foreground/70" }))),
                                    React.createElement("span", { className: "flex min-w-0 flex-1 flex-col" },
                                        React.createElement("span", { className: "flex items-center gap-1.5" },
                                            React.createElement("span", { className: "truncate text-sm font-medium text-foreground" }, friendly),
                                            isHome && (React.createElement(Tooltip, null,
                                                React.createElement(TooltipTrigger, { asChild: true },
                                                    React.createElement("span", { "aria-label": "Home tenant", className: "flex h-3.5 w-3.5 items-center justify-center text-muted-foreground" },
                                                        React.createElement(Star, { className: "h-3 w-3" }))),
                                                React.createElement(TooltipContent, { side: "right" }, "Home tenant of this account"))),
                                            isActive && (React.createElement("span", { className: "rounded-full bg-primary/15 px-1.5 text-2xs font-medium text-primary" }, "active")),
                                            isInFlight && (React.createElement("span", { className: "rounded-full bg-warning/15 px-1.5 text-2xs font-medium text-warning-foreground" }, "switching\u2026"))),
                                        React.createElement("span", { className: "truncate font-mono text-2xs text-muted-foreground" }, (_h = t.defaultDomain) !== null && _h !== void 0 ? _h : shortGuid(t.tenantId)))));
                            })));
                    }),
                    React.createElement(CommandSeparator, null),
                    React.createElement(CommandGroup, { heading: "Actions" },
                        onAddAccount && (React.createElement(CommandItem, { value: "action-add-account", onSelect: () => {
                                setOpen(false);
                                onAddAccount();
                            } },
                            React.createElement(Plus, { className: "h-3.5 w-3.5 text-primary" }),
                            React.createElement("span", { className: "text-sm" }, "Add another Azure account"))),
                        onOpenManage && (React.createElement(CommandItem, { value: "action-open-manage", onSelect: () => {
                                setOpen(false);
                                onOpenManage();
                            } },
                            React.createElement(UserCog, { className: "h-3.5 w-3.5 text-primary" }),
                            React.createElement("span", { className: "text-sm" }, "Open Azure Accounts page"))),
                        React.createElement(CommandItem, { value: "action-keyboard-hint", disabled: true, className: "text-2xs italic text-muted-foreground" },
                            React.createElement(Settings, { className: "h-3.5 w-3.5" }),
                            React.createElement("span", { className: "flex-1" }, "Open this anywhere with"),
                            React.createElement(KbdChord, { keys: `${modKeyLabel()}+Shift+T` }))))))));
};
//# sourceMappingURL=tenant-switcher.js.map