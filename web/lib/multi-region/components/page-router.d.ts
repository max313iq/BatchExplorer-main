/**
 * Centralized route definitions for the dashboard. Replaces the legacy
 * `activePage` switch in `multi-region-dashboard.tsx`. Routes match the
 * canonical set in Design Contract §4.1; deep links (e.g. `/pools/:poolId`,
 * `/account-info/:accountId`) are first-class.
 *
 * Page components remain mounted with the same props as before. The
 * `<DashboardOutletProps>` interface declares the shared deps every page
 * needs (orchestrator, store, programmatic-navigation helper); the
 * `<DashboardOutlet>` HOC injects them via `<Outlet context>` so each route
 * doesn't have to repeat the wiring.
 *
 * Hotkey ordering for Alt+1..9 is preserved by the `PAGE_ORDER` export.
 */
import * as React from "react";
import { OrchestratorAgent } from "../agents/orchestrator-agent";
import { MultiRegionStore } from "../store/multi-region-store";
export interface DashboardOutletContext {
    orchestrator: OrchestratorAgent;
    store: MultiRegionStore;
    /**
     * Navigation helper that pages can use to programmatically route. Wraps
     * react-router's `useNavigate` for backward-compat with the old
     * `(key: PageKey) => void` signature.
     */
    navigateToPage: (path: string) => void;
}
/** Convenience hook for pages — typed wrapper over `useOutletContext`. */
export declare function useDashboardOutletContext(): DashboardOutletContext;
/**
 * Legacy page keys, kept for backward compatibility with pages that still
 * accept `onNavigate: (key: PageKey) => void`. The page-router translates
 * these to canonical paths.
 */
export type PageKey = "azure-accounts" | "overview" | "accounts" | "pools" | "pool-defaults" | "pool-info" | "account-info" | "unused-quota" | "monitoring" | "nodes" | "gpu-calculator" | "audit-log" | "tenant-users" | "user-creator" | "invite-user" | "sub-manager" | "ea-billing-manager" | "resource-manager" | "sub-mover" | "token-importer" | "department-admin" | "legacy-ea-sub" | "ea-sub-quick" | "ea-creator-pregrant" | "ea-subscription" | "partner-center" | "role-graph" | "security-audit" | "privileged-audit" | "tenant-baseline" | "tricky-login" | "audience-matrix" | "tasks" | "throttle" | "vm-catalog";
/** Translate a PageKey to its canonical route path. */
export declare function pageKeyToPath(key: PageKey): string;
/** Best-effort reverse lookup of a path → PageKey. Returns null on miss. */
export declare function pathToPageKey(path: string): PageKey | null;
/**
 * Sidebar order — must match the Alt+1..9 mapping in Design Contract §4.2.
 * Only the first 9 are reachable via hotkeys; the rest are
 * sidebar/Cmd-K-only.
 */
export declare const PAGE_ORDER: PageKey[];
export interface PageRouterProps {
    orchestrator: OrchestratorAgent;
    store: MultiRegionStore;
}
/**
 * Mounts the full route table under a single `DashboardOutlet`. Place this
 * inside `<HashRouter>` (or the equivalent host router) — it does not own
 * the router itself.
 */
export declare const PageRouter: React.FC<PageRouterProps>;
//# sourceMappingURL=page-router.d.ts.map