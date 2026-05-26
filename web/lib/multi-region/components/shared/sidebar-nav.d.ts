/** Main left-rail navigation. Drives URL routing and shows per-account capability badges. */
import * as React from "react";
export type PageKey = "azure-accounts" | "overview" | "accounts" | "pools" | "pool-defaults" | "pool-info" | "account-info" | "unused-quota" | "monitoring" | "nodes" | "gpu-calculator" | "tenant-users" | "user-creator" | "invite-user" | "sub-manager" | "ea-billing-manager" | "resource-manager" | "sub-mover" | "token-importer" | "department-admin" | "legacy-ea-sub" | "ea-sub-quick" | "ea-creator-pregrant" | "ea-subscription" | "partner-center" | "role-graph" | "security-audit" | "privileged-audit" | "tenant-baseline" | "tricky-login" | "audience-matrix" | "audit-log" | "tasks" | "throttle" | "vm-catalog";
export interface SidebarNavProps {
    activeKey: PageKey;
    onNavigate: (key: PageKey) => void;
    collapsed: boolean;
    onToggleCollapse: () => void;
}
export declare const SidebarNav: React.FC<SidebarNavProps>;
//# sourceMappingURL=sidebar-nav.d.ts.map