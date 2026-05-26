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
import { MultiRegionStore } from "../store/multi-region-store";
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
    onSetLoginMode?: (mode: "cli" | "powershell" | "vs" | "portal" | "custom", customClientId?: string) => void;
}
export declare const AppHeader: React.FC<AppHeaderProps>;
//# sourceMappingURL=app-header.d.ts.map