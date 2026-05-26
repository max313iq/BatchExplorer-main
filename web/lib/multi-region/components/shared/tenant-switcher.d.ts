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
interface TenantSwitcherProps {
    /**
     * Wired up to the "Sign in" / "Add another account" footer item.
     * When unset, the footer item is hidden.
     */
    onAddAccount?: () => void;
    /**
     * Wired up to the "Manage accounts" footer item. Typically pushes
     * `/azure-accounts` via the hash router.
     */
    onOpenManage?: () => void;
}
export declare const TenantSwitcher: React.FC<TenantSwitcherProps>;
export {};
//# sourceMappingURL=tenant-switcher.d.ts.map