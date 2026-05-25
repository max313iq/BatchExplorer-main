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
import {
  Activity as ActivityIcon,
  ChevronDown,
  CloudCog,
  Download,
  Eraser,
  KeyRound,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  ScanLine,
  Search,
  Terminal,
  User as UserIcon,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { KbdChord } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

import {
  getStoredCustomClientId,
  getStoredLoginMode,
  LOGIN_MODE_PRESETS,
} from "../auth/msal-auth";
import * as importedTokens from "../auth/imported-tokens";
import type { TokenResult } from "../auth/device-code-login";
import { auditLog } from "../services/audit-log";
import { MultiRegionStore } from "../store/multi-region-store";
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

export interface AppHeaderProps {
  store: MultiRegionStore;
  signedInUserName: string;
  authMode: "msal" | "cli";
  /** Whether auto-refresh is on. Controlled. */
  autoRefreshEnabled: boolean;
  onToggleAutoRefresh: (next: boolean) => void;
  /** Whether a refresh is currently in flight (any source). */
  refreshInFlight: boolean;
  /** Trigger a full refresh now. */
  onRefreshAll: () => void;
  /** Open the global command palette. */
  onOpenCommandPalette?: () => void;
  /** Open the task manager. */
  onToggleTaskManager: () => void;
  /** Sign out of MSAL. */
  onLogout?: () => void;
  /**
   * Trigger the "add another Azure account" popup. Always-on entry point
   * for multi-account login — even after the first sign-in. When supplied,
   * the user-menu shows an "Add another account" item, and a "Sign in"
   * button appears in the header when no account is signed in yet.
   */
  onAddAccount?: () => void;
  /**
   * Whether a login popup is currently open. Disables the menu item to
   * prevent double-clicks racing the MSAL `_loginInProgress` lock.
   */
  loginInProgress?: boolean;
  /**
   * Recovery action: wipe MSAL localStorage entries and reload. Use when
   * cached refresh tokens are stale and silent flows keep returning 400.
   * Calls `purgeMsalCache()` from msal-auth, then `window.location.reload()`.
   */
  onClearSignInCache?: () => void;
  /**
   * Persist a new login-mode preference, purge MSAL state, reload. The
   * AppHeader calls this with one of the preset modes from the user
   * menu, or with `{ mode: "custom", clientId: "<guid>" }` for a user-
   * supplied client id.
   */
  onSetLoginMode?: (
    mode: "cli" | "powershell" | "vs" | "portal" | "custom",
    customClientId?: string,
  ) => void;
}

const BrandMark: React.FC = () => (
  <span className="flex items-center gap-2.5">
    <span
      className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-primary to-info text-primary-foreground shadow-elev-1"
      aria-hidden="true"
    >
      {/* Stylized Azure cube — purely decorative */}
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4z" />
      </svg>
    </span>
    <span className="flex flex-col leading-tight">
      <span className="text-sm font-semibold tracking-tight text-foreground">
        Batch Manager
      </span>
      <span className="text-3xs uppercase tracking-widest text-muted-foreground/70">
        Multi-Region
      </span>
    </span>
  </span>
);

export const AppHeader: React.FC<AppHeaderProps> = ({
  store,
  signedInUserName,
  authMode,
  autoRefreshEnabled,
  onToggleAutoRefresh,
  refreshInFlight,
  onRefreshAll,
  onOpenCommandPalette,
  onToggleTaskManager,
  onLogout,
  onAddAccount,
  loginInProgress = false,
  onClearSignInCache,
  onSetLoginMode,
}) => {
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
  const handleDeviceCodeComplete = React.useCallback(
    (result: TokenResult) => {
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
            message: `Device-code sign-in complete — added ${preview.upn ?? preview.oid} (${preview.audience}).`,
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
        } else {
          // Couldn't decode oid/tid from the JWT — fall back to
          // sessionStorage so the operator still has a copy to paste.
          // No tokens hit the console / audit log.
          try {
            sessionStorage.setItem(
              "azbm.device-code.last-result.v1",
              JSON.stringify({
                // Truncated fingerprint only — no secret material.
                access_token_prefix: result.access_token.slice(0, 20) + "...",
                has_refresh_token: !!result.refresh_token,
                scope: result.scope,
                expires_in: result.expires_in,
                received_at: new Date().toISOString(),
              }),
            );
            // Stash the actual tokens under a separate key so the operator
            // can paste them into the Token Importer page if needed.
            sessionStorage.setItem(
              "azbm.device-code.access-token.v1",
              result.access_token,
            );
            if (result.refresh_token) {
              sessionStorage.setItem(
                "azbm.device-code.refresh-token.v1",
                result.refresh_token,
              );
            }
          } catch {
            /* sessionStorage may be disabled — best-effort */
          }
          store.addNotification({
            type: "info",
            message:
              "Device-code sign-in returned a token whose JWT we couldn't decode. The raw tokens are stashed in sessionStorage under 'azbm.device-code.*' — paste them into the Token Importer page.",
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
      } catch (err) {
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
    },
    [signedInUserName, store],
  );

  const handleSaveSession = () => {
    const ok = store.saveSession();
    if (ok) {
      store.addNotification({ type: "success", message: "Session saved" });
    } else {
      // saveSession() already tries 4 progressively aggressive eviction
      // phases (20 → 10 → 5 → 1 retained sessions, plus log-tail trim).
      // Reaching here means other site storage owns the bulk of the
      // quota. Export is the safe escape hatch.
      store.addNotification({
        type: "error",
        message:
          "Could not save session — browser storage is full even after auto-evicting old sessions. Use Export Session to download a JSON backup, then clear other site data via DevTools → Application → Storage.",
      });
    }
  };

  const handleNewSession = () => {
    // Plain window.prompt — minimum surface to capture a name without
    // pulling in another Dialog component. Cancelling the prompt aborts
    // the new-session entirely, so the operator can back out.
    const proposed = window.prompt(
      "Name this session (optional — leave blank for an auto-ID):",
      "",
    );
    if (proposed === null) return; // operator hit Cancel
    const name = proposed.trim();
    store.newSession(name.length > 0 ? name : undefined);
    store.addNotification({
      type: "info",
      message:
        name.length > 0
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

  return (
    <header
      role="banner"
      className="flex min-h-12 items-center gap-3 border-b border-border bg-surface-base px-4 py-2"
    >
      <BrandMark />

      {/* Global search trigger — opens Cmd-K palette */}
      <button
        type="button"
        onClick={onOpenCommandPalette}
        className={cn(
          "ml-2 hidden h-8 min-w-[18rem] flex-1 items-center gap-2 rounded-md border border-border bg-card/40 px-3 text-xs text-muted-foreground transition-colors duration-fast",
          "hover:border-primary/40 hover:bg-card/60 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "lg:flex",
        )}
        aria-label="Open command palette"
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">Search pages, accounts, pools…</span>
        <KbdChord keys={`${modKeyLabel()}+K`} className="shrink-0 opacity-70" />
      </button>

      <div className="ml-auto flex items-center gap-2">
        {/*
          Header-pinned tenant + account switcher. Visible on every
          page so the operator can pivot tenants without navigating
          to /azure-accounts. Switching here fires the exact same
          flow as the in-page row dropdown (audit, pre-warm,
          listSubscriptions, TENANT_CHANGED_EVENT) — every consuming
          page picks up the new tenant automatically via useArmToken.
        */}
        <TenantSwitcher
          onAddAccount={onAddAccount}
          onOpenManage={() => navigate("/azure-accounts")}
        />

        {/* Active-task pill — only shown when there are active tasks */}
        {active > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleTaskManager}
                aria-label={`Open task manager — ${active} active task${active === 1 ? "" : "s"}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/15 px-2.5 py-1 text-2xs font-medium text-primary tabular-nums transition-colors duration-fast hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  running > 0 &&
                    "animate-pulse motion-reduce:animate-none",
                )}
              >
                <ActivityIcon className="h-3 w-3" />
                {active} task{active === 1 ? "" : "s"}
              </button>
            </TooltipTrigger>
            <TooltipContent>Open task manager</TooltipContent>
          </Tooltip>
        )}

        {/* Auto-refresh switch */}
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground">
          <Switch
            checked={autoRefreshEnabled}
            onCheckedChange={(checked) => onToggleAutoRefresh(!!checked)}
            aria-label="Toggle auto-refresh"
          />
          <span>Auto-refresh</span>
        </label>

        {/* Refresh now */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRefreshAll}
              loading={refreshInFlight}
              aria-label="Refresh all data"
            >
              {!refreshInFlight && <RefreshCw />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="inline-flex items-center gap-1.5">
              Refresh all
              <KbdChord keys={`${modKeyLabel()}+R`} />
            </span>
          </TooltipContent>
        </Tooltip>

        <span className="mx-1 h-6 w-px bg-border" aria-hidden="true" />

        {/* View controls */}
        <DensityToggle />
        <DarkModeToggle />

        <span className="mx-1 h-6 w-px bg-border" aria-hidden="true" />

        {/* Sign-in button — only when nobody is signed in (top-bar entry
            point separate from the user dropdown's "Add another account") */}
        {onAddAccount && !signedInUserName && (
          <Button
            variant="default"
            size="sm"
            onClick={onAddAccount}
            disabled={loginInProgress}
            loading={loginInProgress}
            className="gap-1.5"
            aria-label="Sign in with Azure"
          >
            {!loginInProgress && <CloudCog className="h-3.5 w-3.5" />}
            Sign in
          </Button>
        )}

        {/* User dropdown — workspace + session actions live here too */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 px-2"
              aria-label="Account and workspace menu"
            >
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-primary"
                aria-hidden="true"
              >
                <UserIcon className="h-3.5 w-3.5" />
              </span>
              <span className="hidden max-w-[10rem] truncate text-xs font-medium text-foreground sm:inline">
                {signedInUserName || "Not signed in"}
              </span>
              <ChevronDown
                className="h-3 w-3 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Signed in as
              </span>
              <span className="truncate text-sm font-medium text-foreground">
                {signedInUserName || "—"}
              </span>
              <span className="flex flex-wrap gap-3 pt-1 text-2xs text-muted-foreground tabular-nums">
                <span>
                  <strong className="text-foreground">
                    {state.azureAccounts.length}
                  </strong>{" "}
                  identit
                  {state.azureAccounts.length === 1 ? "y" : "ies"}
                </span>
                <span>
                  <strong className="text-foreground">
                    {state.accounts.length}
                  </strong>{" "}
                  account
                  {state.accounts.length === 1 ? "" : "s"}
                </span>
                <span>
                  <strong className="text-foreground">
                    {state.pools.length}
                  </strong>{" "}
                  pool
                  {state.pools.length === 1 ? "" : "s"}
                </span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleSaveSession}>
              <Save className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              Save session
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleExportSession}>
              <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              Export session as JSON
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleNewSession}>
              <Plus className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              New session
            </DropdownMenuItem>
            {onAddAccount && (
              <>
                <DropdownMenuSeparator />
                {/*
                  "Add another Azure account" — always-on entry point for
                  multi-account login. Calls msalAuth.loginAccount() with
                  prompt: "select_account" so the picker always opens, even
                  if MSAL has cached the same identity.
                */}
                <DropdownMenuItem
                  onSelect={onAddAccount}
                  disabled={loginInProgress}
                >
                  {signedInUserName ? (
                    <UserPlus
                      className="mr-2 h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                  ) : (
                    <LogIn className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {signedInUserName
                    ? loginInProgress
                      ? "Opening sign-in popup…"
                      : "Add another Azure account"
                    : loginInProgress
                      ? "Opening sign-in popup…"
                      : "Sign in with Azure"}
                </DropdownMenuItem>
              </>
            )}
            {(onSetLoginMode ||
              onClearSignInCache ||
              (authMode === "msal" && onLogout)) && (
              <DropdownMenuSeparator />
            )}
            {onSetLoginMode && (
              <LoginModeMenu
                onSetLoginMode={onSetLoginMode}
                onStartDeviceCode={handleStartDeviceCode}
              />
            )}
            {onClearSignInCache && (
              <DropdownMenuItem onSelect={onClearSignInCache}>
                <Eraser className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Clear sign-in cache &amp; reload
              </DropdownMenuItem>
            )}
            {authMode === "msal" && onLogout && (
              <DropdownMenuItem
                onSelect={onLogout}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Sign out
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/*
        Device-code sign-in dialog. Lives at header level so it survives
        the dropdown closing, and so it's available regardless of which
        page the operator is on. Uses default scopes (ARM + offline_access
        + openid + profile) — the device-code-login service applies those
        when `scopes` is omitted.
      */}
      <DeviceCodeDialog
        open={deviceCodeOpen}
        onOpenChange={setDeviceCodeOpen}
        clientId={AZURE_CLI_CLIENT_ID_FOR_DEVICE_CODE}
        onComplete={handleDeviceCodeComplete}
      />
    </header>
  );
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

const LoginModeMenu: React.FC<{
  onSetLoginMode: (
    mode: "cli" | "powershell" | "vs" | "portal" | "custom",
    customClientId?: string,
  ) => void;
  /**
   * Open the device-code-flow dialog. Surfaced as the last entry in this
   * menu so popup-blocked / headless operators have a deterministic path
   * that doesn't depend on window.open() succeeding.
   */
  onStartDeviceCode?: () => void;
}> = ({ onSetLoginMode, onStartDeviceCode }) => {
  const active = getStoredLoginMode();
  const storedCustom = getStoredCustomClientId();
  const [customInput, setCustomInput] = React.useState(storedCustom);
  const customValid = UUID_LIKE.test(customInput.trim());

  return (
    <>
      <DropdownMenuLabel className="text-2xs uppercase tracking-wider text-muted-foreground">
        Login mode
      </DropdownMenuLabel>
      {LOGIN_MODE_PRESETS.map((p) => {
        const isActive = active === p.mode;
        const Icon =
          p.mode === "cli"
            ? Terminal
            : p.mode === "portal"
              ? KeyRound
              : p.mode === "vs"
                ? CloudCog
                : KeyRound;
        return (
          <DropdownMenuItem
            key={p.mode}
            onSelect={() => onSetLoginMode(p.mode)}
            className={isActive ? "opacity-70" : undefined}
          >
            <Icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            <span className="flex flex-1 flex-col text-xs">
              <span className="truncate font-medium">{p.label}</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {(p.clientId ?? "").slice(0, 8)}…
              </span>
            </span>
            {isActive && (
              <span className="ml-2 text-2xs text-muted-foreground">
                active
              </span>
            )}
          </DropdownMenuItem>
        );
      })}
      {/* Custom GUID row — stop propagation on click so typing in the
          input doesn't dismiss the menu. */}
      <div
        className="flex flex-col gap-1 px-2 py-1.5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <span className="text-2xs font-medium">Custom client id</span>
        <input
          type="text"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          placeholder="11111111-2222-3333-4444-555555555555"
          className="h-7 w-full rounded border border-input bg-background px-2 font-mono text-[10px] outline-none focus:ring-1 focus:ring-ring"
          aria-invalid={
            customInput.length > 0 && !customValid ? true : undefined
          }
        />
        <Button
          type="button"
          size="sm"
          variant={active === "custom" ? "ghost" : "default"}
          className="h-6 text-2xs"
          disabled={!customValid}
          onClick={() => onSetLoginMode("custom", customInput.trim())}
        >
          {active === "custom" ? "Reapply custom" : "Use custom"}
        </Button>
        <span className="text-[10px] text-muted-foreground">
          Paste any public-client GUID (e.g. your own AAD-registered SPA
          configured with{" "}
          <code className="font-mono">
            {typeof window !== "undefined" ? window.location.origin : ""}/
          </code>
          {" "}as a redirect URI).
        </span>
      </div>
      {/*
        Device-code sign-in — alternative to MSAL popup login. Sits at the
        bottom of the login-mode list so popup-blocked / headless operators
        always see it as a fallback.
      */}
      {onStartDeviceCode && (
        <DropdownMenuItem onSelect={onStartDeviceCode}>
          <ScanLine className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          <span className="flex flex-1 flex-col text-xs">
            <span className="truncate font-medium">Device code login</span>
            <span className="truncate text-[10px] text-muted-foreground">
              Use a code on another device (popups blocked / headless?)
            </span>
          </span>
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
    </>
  );
};
