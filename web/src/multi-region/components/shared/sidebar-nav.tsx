import * as React from "react";
import { Icon } from "@fluentui/react/lib/Icon";
import { useMultiRegionState } from "../../store/store-context";

export type PageKey =
    | "azure-accounts"
    | "overview"
    | "accounts"
    | "quotas"
    | "quota-status"
    | "support-tickets"
    | "pools"
    | "pool-info"
    | "account-info"
    | "unused-quota"
    | "monitoring"
    | "nodes";

interface NavItem {
    key: PageKey;
    label: string;
    icon: string;
    badge?: number;
}

export interface SidebarNavProps {
    activeKey: PageKey;
    onNavigate: (key: PageKey) => void;
    collapsed: boolean;
    onToggleCollapse: () => void;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({
    activeKey,
    onNavigate,
    collapsed,
    onToggleCollapse,
}) => {
    const state = useMultiRegionState();

    const items: NavItem[] = React.useMemo(
        () => [
            {
                key: "azure-accounts" as PageKey,
                label: "Azure Accounts",
                icon: "Contact",
                badge: (state as unknown as Record<string, unknown>)
                    .azureAccounts
                    ? (
                          (state as unknown as Record<string, unknown>)
                              .azureAccounts as unknown[]
                      ).length
                    : 0,
            },
            { key: "overview", label: "Overview", icon: "ViewDashboard" },
            {
                key: "accounts",
                label: "Accounts",
                icon: "ServerProcesses",
                badge: state.accounts.length,
            },
            {
                key: "quotas",
                label: "Quotas",
                icon: "AllCurrency",
                badge: state.quotaRequests.filter(
                    (q) => q.status === "pending" || q.status === "submitted"
                ).length,
            },
            {
                key: "quota-status",
                label: "Status",
                icon: "Diagnostic",
                badge: state.quotaRequests.filter(
                    (q) => q.status === "approved"
                ).length,
            },
            {
                key: "support-tickets" as PageKey,
                label: "Support Tickets",
                icon: "Ticket",
                badge: state.quotaRequests?.length ?? 0,
            },
            {
                key: "pools",
                label: "Pools",
                icon: "BuildQueue",
                badge: state.pools.length,
            },
            {
                key: "pool-info",
                label: "Pool Info",
                icon: "GridViewMedium",
                badge: state.poolInfos.length,
            },
            {
                key: "account-info",
                label: "Account Info",
                icon: "AccountManagement",
                badge: state.accountInfos.length,
            },
            {
                key: "unused-quota",
                label: "Unused Quota",
                icon: "Savings",
                badge: state.accountInfos.filter(
                    (a) => a.lowPriorityCoresFree > 0
                ).length,
            },
            {
                key: "monitoring" as PageKey,
                label: "Monitoring",
                icon: "Health",
                badge:
                    state.agentLogs?.filter((l) => l.level === "error")
                        .length ?? 0,
            },
            {
                key: "nodes",
                label: "Nodes",
                icon: "Server",
                badge: state.nodes.length,
            },
        ],
        [state]
    );

    const width = collapsed ? 48 : 220;

    return (
        <nav
            style={{
                width,
                minWidth: width,
                height: "100%",
                background: "#1b1b1b",
                borderRight: "1px solid #333",
                display: "flex",
                flexDirection: "column",
                transition: "width 0.2s ease",
                overflow: "hidden",
            }}
        >
            {/* Collapse toggle */}
            <button
                onClick={onToggleCollapse}
                title={collapsed ? "Expand" : "Collapse"}
                style={{
                    background: "transparent",
                    border: "none",
                    color: "#888",
                    padding: "12px 14px",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                }}
            >
                <Icon
                    iconName={
                        collapsed ? "DoubleChevronRight" : "DoubleChevronLeft"
                    }
                    styles={{ root: { fontSize: 14 } }}
                />
                {!collapsed && (
                    <span
                        style={{
                            fontSize: 11,
                            textTransform: "uppercase",
                            letterSpacing: 1,
                        }}
                    >
                        Navigation
                    </span>
                )}
            </button>

            {/* Nav items */}
            <div
                style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    padding: "4px 0",
                }}
            >
                {items.map((item) => {
                    const isActive = activeKey === item.key;
                    return (
                        <button
                            key={item.key}
                            onClick={() => onNavigate(item.key)}
                            title={collapsed ? item.label : undefined}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                padding: collapsed ? "10px 14px" : "10px 16px",
                                background: isActive
                                    ? "#252525"
                                    : "transparent",
                                border: "none",
                                borderLeft: isActive
                                    ? "3px solid #0078d4"
                                    : "3px solid transparent",
                                color: isActive ? "#fff" : "#999",
                                cursor: "pointer",
                                fontSize: 13,
                                textAlign: "left",
                                width: "100%",
                                transition: "all 0.15s ease",
                            }}
                        >
                            <Icon
                                iconName={item.icon}
                                styles={{
                                    root: {
                                        fontSize: 16,
                                        color: isActive ? "#0078d4" : "#777",
                                        minWidth: 16,
                                    },
                                }}
                            />
                            {!collapsed && (
                                <>
                                    <span style={{ flex: 1 }}>
                                        {item.label}
                                    </span>
                                    {item.badge != null && item.badge > 0 && (
                                        <span
                                            style={{
                                                background: isActive
                                                    ? "#0078d4"
                                                    : "#444",
                                                color: "#fff",
                                                borderRadius: 10,
                                                padding: "1px 7px",
                                                fontSize: 11,
                                                fontWeight: 600,
                                                minWidth: 20,
                                                textAlign: "center",
                                            }}
                                        >
                                            {item.badge}
                                        </span>
                                    )}
                                </>
                            )}
                        </button>
                    );
                })}
            </div>
        </nav>
    );
};
