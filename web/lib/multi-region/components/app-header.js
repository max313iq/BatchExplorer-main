/**
 * Unified app header. Replaces the legacy SessionBar + auto-refresh strip
 * with a single, premium-looking top bar:
 *  - Brand on the left
 *  - Global search trigger (opens Cmd-K palette)
 *  - Active task pill (opens task manager)
 *  - Refresh-all button + auto-refresh toggle
 *  - Density + dark-mode toggles
 *  - Signed-in user dropdown (sign-out, save / new / export session)
 *
 * No session-id text, no "0A / 0P" counters — workspace metadata moved
 * behind a "Workspace" overflow menu and the user dropdown.
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Activity as ActivityIcon, ChevronDown, CloudCog, Download, Eraser, KeyRound, LogIn, LogOut, Plus, RefreshCw, Save, ScanLine, Search, Terminal, User as UserIcon, UserPlus, } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { KbdChord } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { getStoredCustomClientId, getStoredLoginMode, LOGIN_MODE_PRESETS, } from "../auth/msal-auth";
import * as importedTokens from "../auth/imported-tokens";
import { auditLog } from "../services/audit-log";
import { useMultiRegionState } from "../store/store-context";
import { modKeyLabel, useShortcut } from "../hooks/use-shortcut";
import { useActiveTaskCount } from "./shared/activity-panel";
import { DensityToggle } from "./density-toggle";
import { DarkModeToggle } from "./dark-mode-toggle";
import { DeviceCodeDialog } from "./shared/device-code-dialog";
import { TenantSwitcher } from "./shared/tenant-switcher";
// Azure CLI well-known public client id — FOCI-eligible so a device-code
// sign-in here yields a refresh token the imported-tokens vault can later
// redeem for ARM / Graph / Batch tokens for any other FOCI client. Matches
// the constant in auth/msal-auth.ts (not exported from there yet).
const AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const BrandMark = () => (React.createElement("span", { className: "flex items-center gap-2.5" },
    React.createElement("span", { className: "flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-primary to-info text-primary-foreground shadow-elev-1", "aria-hidden": "true" },
        React.createElement("svg", { viewBox: "0 0 24 24", className: "h-4 w-4", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" },
            React.createElement("path", { d: "M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4z" }))),
    React.createElement("span", { className: "flex flex-col leading-tight" },
        React.createElement("span", { className: "text-sm font-semibold tracking-tight text-foreground" }, "Batch Manager"),
        React.createElement("span", { className: "text-3xs uppercase tracking-widest text-muted-foreground/70" }, "Multi-Region"))));
export const AppHeader = ({ store, signedInUserName, authMode, autoRefreshEnabled, onToggleAutoRefresh, refreshInFlight, onRefreshAll, onOpenCommandPalette, onToggleTaskManager, onLogout, onAddAccount, loginInProgress = false, onClearSignInCache, onSetLoginMode, }) => {
    const state = useMultiRegionState();
    const navigate = useNavigate();
    const { active, running } = useActiveTaskCount();
    const [deviceCodeOpen, setDeviceCodeOpen] = React.useState(false);
    // Keyboard shortcut helpers — Mod+R for refresh, Mod+/ for search.
    useShortcut("Mod+r", (e) => {
        e.preventDefault();
        onRefreshAll();
    });
    // Audit the moment the operator chooses the device-code login (kept
    // separate from _success / _failure so we can see drop-offs between
    // start and completion). Sensitive payload (device_code, user_code,
    // tokens) NEVER ends up in the audit log — only the chosen client id
    // and tenant authority do.
    const handleStartDeviceCode = React.useCallback(() => {
        auditLog.record({
            actor: signedInUserName || "anonymous",
            action: "device_code_login_start",
            target: AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE,
            status: "success",
            details: { clientId: AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE, tenant: "common" },
        });
        setDeviceCodeOpen(true);
    }, [signedInUserName]);
    // Land the device-code tokens somewhere usable. The imported-tokens
    // vault is the right home: it already handles audience classification,
    // expiry-based eviction, and refresh-token redemption for FOCI clients,
    // which is exactly what a CLI-client device-code sign-in yields.
    const handleDeviceCodeComplete = React.useCallback((result) => {
        var _a;
        try {
            // 1. Access token → imported-tokens store (lookup by audience).
            const preview = importedTokens.previewToken(result.access_token);
            if (preview) {
                const entry = importedTokens.importToken(preview);
                // 2. Refresh token → refresh-token store, keyed by the same
                //    homeAccountId. The Azure CLI client id is FOCI-eligible so
                //    this RT can later be exchanged for ARM / Graph / Batch
                //    tokens via importedTokens.ensureImportedToken().
                if (result.refresh_token) {
                    importedTokens.importRefreshToken({
                        homeAccountId: preview.homeAccountId,
                        tenantId: preview.tenantId,
                        oid: preview.oid,
                        upn: preview.upn,
                        name: preview.name,
                        clientId: AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE,
                        refreshToken: result.refresh_token,
                    });
                }
                store.addNotification({
                    type: "success",
                    message: `Device-code sign-in complete — added ${(_a = preview.upn) !== null && _a !== void 0 ? _a : preview.oid} (${preview.audience}).`,
                });
                auditLog.record({
                    actor: preview.upn || preview.oid || "device-code-user",
                    action: "device_code_login_success",
                    target: AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE,
                    status: "success",
                    details: {
                        clientId: AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE,
                        tenant: preview.tenantId,
                        audience: preview.audience,
                        hasRefreshToken: !!result.refresh_token,
                        expiresAt: entry.expiresAt,
                    },
                });
            }
            else {
                // Couldn't decode oid/tid from the JWT — fall back to
                // sessionStorage so the operator still has a copy to paste.
                // No tokens hit the console / audit log.
                try {
                    sessionStorage.setItem("azbm.device-code.last-result.v1", JSON.stringify({
                        // Truncated fingerprint only — no secret material.
                        access_token_prefix: result.access_token.slice(0, 20) + "...",
                        has_refresh_token: !!result.refresh_token,
                        scope: result.scope,
                        expires_in: result.expires_in,
                        received_at: new Date().toISOString(),
                    }));
                    // Stash the actual tokens under a separate key so the operator
                    // can paste them into the Token Importer page if needed.
                    sessionStorage.setItem("azbm.device-code.access-token.v1", result.access_token);
                    if (result.refresh_token) {
                        sessionStorage.setItem("azbm.device-code.refresh-token.v1", result.refresh_token);
                    }
                }
                catch (_b) {
                    /* sessionStorage may be disabled — best-effort */
                }
                store.addNotification({
                    type: "info",
                    message: "Device-code sign-in returned a token whose JWT we couldn't decode. The raw tokens are stashed in sessionStorage under 'azbm.device-code.*' — paste them into the Token Importer page.",
                });
                auditLog.record({
                    actor: signedInUserName || "device-code-user",
                    action: "device_code_login_success",
                    target: AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE,
                    status: "success",
                    details: {
                        clientId: AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE,
                        note: "jwt_decode_failed_stashed_in_sessionStorage",
                        hasRefreshToken: !!result.refresh_token,
                    },
                });
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            store.addNotification({
                type: "error",
                message: `Device-code sign-in completed but token storage failed: ${msg}`,
            });
            auditLog.record({
                actor: signedInUserName || "device-code-user",
                action: "device_code_login_failure",
                target: AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE,
                status: "failure",
                error: msg,
            });
        }
    }, [signedInUserName, store]);
    const handleSaveSession = () => {
        const ok = store.saveSession();
        if (ok) {
            store.addNotification({ type: "success", message: "Session saved" });
        }
        else {
            // saveSession() already tries 4 progressively aggressive eviction
            // phases (20 → 10 → 5 → 1 retained sessions, plus log-tail trim).
            // Reaching here means other site storage owns the bulk of the
            // quota. Export is the safe escape hatch.
            store.addNotification({
                type: "error",
                message: "Could not save session — browser storage is full even after auto-evicting old sessions. Use Export Session to download a JSON backup, then clear other site data via DevTools → Application → Storage.",
            });
        }
    };
    const handleNewSession = () => {
        // Plain window.prompt — minimum surface to capture a name without
        // pulling in another Dialog component. Cancelling the prompt aborts
        // the new-session entirely, so the operator can back out.
        const proposed = window.prompt("Name this session (optional — leave blank for an auto-ID):", "");
        if (proposed === null)
            return; // operator hit Cancel
        const name = proposed.trim();
        store.newSession(name.length > 0 ? name : undefined);
        store.addNotification({
            type: "info",
            message: name.length > 0
                ? `New session "${name}" started`
                : "New session started",
        });
    };
    const handleExportSession = () => {
        const json = store.exportSessionAsJson();
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `batch-manager-session-${new Date()
            .toISOString()
            .slice(0, 19)
            .replace(/[:T]/g, "-")}.json`;
        a.click();
        URL.revokeObjectURL(url);
        store.addNotification({ type: "success", message: "Session exported" });
    };
    return (React.createElement("header", { role: "banner", className: "flex min-h-12 items-center gap-3 border-b border-border bg-surface-base px-4 py-2" },
        React.createElement(BrandMark, null),
        React.createElement("button", { type: "button", onClick: onOpenCommandPalette, className: cn("ml-2 hidden h-8 min-w-[18rem] flex-1 items-center gap-2 rounded-md border border-border bg-card/40 px-3 text-xs text-muted-foreground transition-colors duration-fast", "hover:border-primary/40 hover:bg-card/60 hover:text-foreground", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background", "lg:flex"), "aria-label": "Open command palette" },
            React.createElement(Search, { className: "h-3.5 w-3.5 shrink-0", "aria-hidden": "true" }),
            React.createElement("span", { className: "flex-1 text-left" }, "Search pages, accounts, pools\u2026"),
            React.createElement(KbdChord, { keys: `${modKeyLabel()}+K`, className: "shrink-0 opacity-70" })),
        React.createElement("div", { className: "ml-auto flex items-center gap-2" },
            React.createElement(TenantSwitcher, { onAddAccount: onAddAccount, onOpenManage: () => navigate("/azure-accounts") }),
            active > 0 && (React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement("button", { type: "button", onClick: onToggleTaskManager, "aria-label": `Open task manager — ${active} active task${active === 1 ? "" : "s"}`, className: cn("inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/15 px-2.5 py-1 text-2xs font-medium text-primary tabular-nums transition-colors duration-fast hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background", running > 0 &&
                            "animate-pulse motion-reduce:animate-none") },
                        React.createElement(ActivityIcon, { className: "h-3 w-3" }),
                        active,
                        " task",
                        active === 1 ? "" : "s")),
                React.createElement(TooltipContent, null, "Open task manager"))),
            React.createElement("label", { className: "flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground" },
                React.createElement(Switch, { checked: autoRefreshEnabled, onCheckedChange: (checked) => onToggleAutoRefresh(!!checked), "aria-label": "Toggle auto-refresh" }),
                React.createElement("span", null, "Auto-refresh")),
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { variant: "ghost", size: "icon-sm", onClick: onRefreshAll, loading: refreshInFlight, "aria-label": "Refresh all data" }, !refreshInFlight && React.createElement(RefreshCw, null))),
                React.createElement(TooltipContent, null,
                    React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                        "Refresh all",
                        React.createElement(KbdChord, { keys: `${modKeyLabel()}+R` })))),
            React.createElement("span", { className: "mx-1 h-6 w-px bg-border", "aria-hidden": "true" }),
            React.createElement(DensityToggle, null),
            React.createElement(DarkModeToggle, null),
            React.createElement("span", { className: "mx-1 h-6 w-px bg-border", "aria-hidden": "true" }),
            onAddAccount && !signedInUserName && (React.createElement(Button, { variant: "default", size: "sm", onClick: onAddAccount, disabled: loginInProgress, loading: loginInProgress, className: "gap-1.5", "aria-label": "Sign in with Azure" },
                !loginInProgress && React.createElement(CloudCog, { className: "h-3.5 w-3.5" }),
                "Sign in")),
            React.createElement(DropdownMenu, null,
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { variant: "ghost", size: "sm", className: "gap-2 px-2", "aria-label": "Account and workspace menu" },
                        React.createElement("span", { className: "flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-primary", "aria-hidden": "true" },
                            React.createElement(UserIcon, { className: "h-3.5 w-3.5" })),
                        React.createElement("span", { className: "hidden max-w-[10rem] truncate text-xs font-medium text-foreground sm:inline" }, signedInUserName || "Not signed in"),
                        React.createElement(ChevronDown, { className: "h-3 w-3 text-muted-foreground", "aria-hidden": "true" }))),
                React.createElement(DropdownMenuContent, { align: "end", className: "w-64" },
                    React.createElement(DropdownMenuLabel, { className: "flex flex-col gap-0.5" },
                        React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Signed in as"),
                        React.createElement("span", { className: "truncate text-sm font-medium text-foreground" }, signedInUserName || "—"),
                        React.createElement("span", { className: "flex flex-wrap gap-3 pt-1 text-2xs text-muted-foreground tabular-nums" },
                            React.createElement("span", null,
                                React.createElement("strong", { className: "text-foreground" }, state.azureAccounts.length),
                                " ",
                                "identit",
                                state.azureAccounts.length === 1 ? "y" : "ies"),
                            React.createElement("span", null,
                                React.createElement("strong", { className: "text-foreground" }, state.accounts.length),
                                " ",
                                "account",
                                state.accounts.length === 1 ? "" : "s"),
                            React.createElement("span", null,
                                React.createElement("strong", { className: "text-foreground" }, state.pools.length),
                                " ",
                                "pool",
                                state.pools.length === 1 ? "" : "s"))),
                    React.createElement(DropdownMenuSeparator, null),
                    React.createElement(DropdownMenuItem, { onSelect: handleSaveSession },
                        React.createElement(Save, { className: "mr-2 h-3.5 w-3.5", "aria-hidden": "true" }),
                        "Save session"),
                    React.createElement(DropdownMenuItem, { onSelect: handleExportSession },
                        React.createElement(Download, { className: "mr-2 h-3.5 w-3.5", "aria-hidden": "true" }),
                        "Export session as JSON"),
                    React.createElement(DropdownMenuItem, { onSelect: handleNewSession },
                        React.createElement(Plus, { className: "mr-2 h-3.5 w-3.5", "aria-hidden": "true" }),
                        "New session"),
                    onAddAccount && (React.createElement(React.Fragment, null,
                        React.createElement(DropdownMenuSeparator, null),
                        React.createElement(DropdownMenuItem, { onSelect: onAddAccount, disabled: loginInProgress },
                            signedInUserName ? (React.createElement(UserPlus, { className: "mr-2 h-3.5 w-3.5", "aria-hidden": "true" })) : (React.createElement(LogIn, { className: "mr-2 h-3.5 w-3.5", "aria-hidden": "true" })),
                            signedInUserName
                                ? loginInProgress
                                    ? "Opening sign-in popup…"
                                    : "Add another Azure account"
                                : loginInProgress
                                    ? "Opening sign-in popup…"
                                    : "Sign in with Azure"))),
                    (onSetLoginMode ||
                        onClearSignInCache ||
                        (authMode === "msal" && onLogout)) && (React.createElement(DropdownMenuSeparator, null)),
                    onSetLoginMode && (React.createElement(LoginModeMenu, { onSetLoginMode: onSetLoginMode, onStartDeviceCode: handleStartDeviceCode })),
                    onClearSignInCache && (React.createElement(DropdownMenuItem, { onSelect: onClearSignInCache },
                        React.createElement(Eraser, { className: "mr-2 h-3.5 w-3.5", "aria-hidden": "true" }),
                        "Clear sign-in cache & reload")),
                    authMode === "msal" && onLogout && (React.createElement(DropdownMenuItem, { onSelect: onLogout, className: "text-destructive focus:text-destructive" },
                        React.createElement(LogOut, { className: "mr-2 h-3.5 w-3.5", "aria-hidden": "true" }),
                        "Sign out"))))),
        React.createElement(DeviceCodeDialog, { open: deviceCodeOpen, onOpenChange: setDeviceCodeOpen, clientId: AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE, onComplete: handleDeviceCodeComplete })));
};
/**
 * Login-mode submenu rendered inside the user dropdown. Lists every
 * preset client id and a small "Custom GUID" input so the operator can
 * paste any first-party or self-registered public client id.
 *
 * Switching modes triggers an MSAL cache purge + reload (handled in
 * dashboard-shell), so we don't need to manage MSAL state here.
 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LoginModeMenu = ({ onSetLoginMode, onStartDeviceCode }) => {
    const active = getStoredLoginMode();
    const storedCustom = getStoredCustomClientId();
    const [customInput, setCustomInput] = React.useState(storedCustom);
    const customValid = UUID_LIKE.test(customInput.trim());
    return (React.createElement(React.Fragment, null,
        React.createElement(DropdownMenuLabel, { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Login mode"),
        LOGIN_MODE_PRESETS.map((p) => {
            var _a;
            const isActive = active === p.mode;
            const Icon = p.mode === "cli"
                ? Terminal
                : p.mode === "portal"
                    ? KeyRound
                    : p.mode === "vs"
                        ? CloudCog
                        : KeyRound;
            return (React.createElement(DropdownMenuItem, { key: p.mode, onSelect: () => onSetLoginMode(p.mode), className: isActive ? "opacity-70" : undefined },
                React.createElement(Icon, { className: "mr-2 h-3.5 w-3.5", "aria-hidden": "true" }),
                React.createElement("span", { className: "flex flex-1 flex-col text-xs" },
                    React.createElement("span", { className: "truncate font-medium" }, p.label),
                    React.createElement("span", { className: "truncate font-mono text-[10px] text-muted-foreground" },
                        ((_a = p.clientId) !== null && _a !== void 0 ? _a : "").slice(0, 8),
                        "\u2026")),
                isActive && (React.createElement("span", { className: "ml-2 text-2xs text-muted-foreground" }, "active"))));
        }),
        React.createElement("div", { className: "flex flex-col gap-1 px-2 py-1.5", onClick: (e) => e.stopPropagation(), onKeyDown: (e) => e.stopPropagation() },
            React.createElement("span", { className: "text-2xs font-medium" }, "Custom client id"),
            React.createElement("input", { type: "text", value: customInput, onChange: (e) => setCustomInput(e.target.value), placeholder: "11111111-2222-3333-4444-555555555555", className: "h-7 w-full rounded border border-input bg-background px-2 font-mono text-[10px] outline-none focus:ring-1 focus:ring-ring", "aria-invalid": customInput.length > 0 && !customValid ? true : undefined }),
            React.createElement(Button, { type: "button", size: "sm", variant: active === "custom" ? "ghost" : "default", className: "h-6 text-2xs", disabled: !customValid, onClick: () => onSetLoginMode("custom", customInput.trim()) }, active === "custom" ? "Reapply custom" : "Use custom"),
            React.createElement("span", { className: "text-[10px] text-muted-foreground" },
                "Paste any public-client GUID (e.g. your own AAD-registered SPA configured with",
                " ",
                React.createElement("code", { className: "font-mono" },
                    typeof window !== "undefined" ? window.location.origin : "",
                    "/"),
                " ",
                "as a redirect URI).")),
        onStartDeviceCode && (React.createElement(DropdownMenuItem, { onSelect: onStartDeviceCode },
            React.createElement(ScanLine, { className: "mr-2 h-3.5 w-3.5", "aria-hidden": "true" }),
            React.createElement("span", { className: "flex flex-1 flex-col text-xs" },
                React.createElement("span", { className: "truncate font-medium" }, "Device code login"),
                React.createElement("span", { className: "truncate text-[10px] text-muted-foreground" }, "Use a code on another device (popups blocked / headless?)")))),
        React.createElement(DropdownMenuSeparator, null)));
};
//# sourceMappingURL=app-header.js.map