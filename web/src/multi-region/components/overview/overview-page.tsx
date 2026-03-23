import * as React from "react";
import { Icon } from "@fluentui/react/lib/Icon";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import {
    useDashboardStats,
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { PageKey } from "../shared/sidebar-nav";
import { StatusBadge } from "../shared/status-badge";

interface StatCardProps {
    icon: string;
    title: string;
    color: string;
    items: Array<{ label: string; value: number; color?: string }>;
    onClick?: () => void;
}

const StatCard: React.FC<StatCardProps> = ({
    icon,
    title,
    color,
    items,
    onClick,
}) => {
    const total = items.reduce((s, i) => s + i.value, 0);
    return (
        <div
            onClick={onClick}
            style={{
                background: "#252525",
                borderRadius: 8,
                padding: 20,
                flex: "1 1 200px",
                minWidth: 200,
                cursor: onClick ? "pointer" : "default",
                borderTop: `3px solid ${color}`,
                transition: "transform 0.15s",
            }}
        >
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 10 }}
            >
                <Icon
                    iconName={icon}
                    styles={{ root: { fontSize: 20, color } }}
                />
                <Text
                    variant="mediumPlus"
                    styles={{ root: { fontWeight: 600, color: "#eee" } }}
                >
                    {title}
                </Text>
                <Text
                    variant="xxLarge"
                    styles={{
                        root: {
                            marginLeft: "auto",
                            fontWeight: 700,
                            color,
                        },
                    }}
                >
                    {total}
                </Text>
            </Stack>
            <Stack
                horizontal
                tokens={{ childrenGap: 16 }}
                styles={{ root: { marginTop: 12 } }}
            >
                {items.map((item) => (
                    <div key={item.label}>
                        <Text
                            variant="small"
                            styles={{ root: { color: "#888" } }}
                        >
                            {item.label}
                        </Text>
                        <div
                            style={{
                                fontSize: 18,
                                fontWeight: 600,
                                color: item.color ?? "#ccc",
                            }}
                        >
                            {item.value}
                        </div>
                    </div>
                ))}
            </Stack>
        </div>
    );
};

// --- Agent Status Strip ---

const AgentStatusStrip: React.FC = () => {
    const state = useMultiRegionState();
    const statusColor: Record<string, string> = {
        idle: "#555",
        running: "#0078d4",
        completed: "#107c10",
        error: "#d13438",
    };

    return (
        <Stack
            horizontal
            tokens={{ childrenGap: 16 }}
            verticalAlign="center"
            styles={{
                root: {
                    padding: "8px 16px",
                    background: "#1e1e1e",
                    borderRadius: 6,
                },
            }}
        >
            <Text variant="small" styles={{ root: { color: "#666" } }}>
                Agents:
            </Text>
            {Object.entries(state.agentStatuses).map(([name, status]) => (
                <Stack
                    key={name}
                    horizontal
                    verticalAlign="center"
                    tokens={{ childrenGap: 6 }}
                >
                    <div
                        style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: statusColor[status] ?? "#555",
                            boxShadow:
                                status === "running"
                                    ? `0 0 6px ${statusColor.running}`
                                    : "none",
                        }}
                    />
                    <Text
                        variant="tiny"
                        styles={{ root: { color: "#999", fontSize: 11 } }}
                    >
                        {name}
                    </Text>
                </Stack>
            ))}
        </Stack>
    );
};

// --- Recent Activity ---

const RecentActivity: React.FC = () => {
    const state = useMultiRegionState();
    const recentLogs = state.agentLogs.slice(-8);

    return (
        <div
            style={{
                background: "#1e1e1e",
                borderRadius: 6,
                padding: 16,
            }}
        >
            <Text
                variant="mediumPlus"
                styles={{
                    root: { fontWeight: 600, color: "#eee", marginBottom: 8 },
                }}
            >
                Recent Activity
            </Text>
            {recentLogs.length === 0 ? (
                <Text variant="small" styles={{ root: { color: "#666" } }}>
                    No activity yet. Start by discovering accounts.
                </Text>
            ) : (
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                        marginTop: 8,
                    }}
                >
                    {recentLogs.map((log, i) => (
                        <div
                            key={i}
                            style={{
                                display: "flex",
                                gap: 8,
                                alignItems: "baseline",
                                fontSize: 12,
                            }}
                        >
                            <span
                                style={{
                                    color: "#555",
                                    minWidth: 60,
                                    fontSize: 10,
                                }}
                            >
                                {new Date(log.timestamp).toLocaleTimeString()}
                            </span>
                            <StatusBadge status={log.level} />
                            <span style={{ color: "#888" }}>[{log.agent}]</span>
                            <span
                                style={{
                                    color:
                                        log.level === "error"
                                            ? "#e06060"
                                            : "#ccc",
                                    flex: 1,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {log.message}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// --- Quick Actions ---

const QuickActions: React.FC<{
    store: MultiRegionStore;
    orchestrator: OrchestratorAgent;
}> = ({ store, orchestrator }) => {
    const state = useMultiRegionState();
    const failedAccounts = state.accounts.filter(
        (a) => a.provisioningState === "failed"
    ).length;
    const failedQuotas = state.quotaRequests.filter(
        (q) => q.status === "failed"
    ).length;
    const failedPools = state.pools.filter(
        (p) => p.provisioningState === "failed"
    ).length;
    const totalFailed = failedAccounts + failedQuotas + failedPools;

    return (
        <Stack horizontal tokens={{ childrenGap: 8 }} wrap>
            {totalFailed > 0 && (
                <DefaultButton
                    text={`Retry ${totalFailed} Failed`}
                    iconProps={{ iconName: "Refresh" }}
                    onClick={() => {
                        if (failedAccounts > 0) store.retryFailedAccounts();
                        if (failedQuotas > 0) store.retryFailedQuotas();
                        if (failedPools > 0) store.retryFailedPools();
                        store.addNotification({
                            type: "info",
                            message: `Reset ${totalFailed} failed items to pending`,
                        });
                    }}
                    styles={{
                        root: {
                            borderColor: "#d13438",
                            color: "#d13438",
                        },
                    }}
                />
            )}
            <DefaultButton
                text="Export Session"
                iconProps={{ iconName: "Download" }}
                onClick={() => {
                    const json = store.exportSessionAsJson();
                    const blob = new Blob([json], {
                        type: "application/json",
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${store.sessionId}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                }}
            />
        </Stack>
    );
};

// --- Main Overview Page ---

export interface OverviewPageProps {
    orchestrator: OrchestratorAgent;
    store: MultiRegionStore;
    onNavigate: (key: PageKey) => void;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({
    orchestrator,
    store,
    onNavigate,
}) => {
    const stats = useDashboardStats();
    const state = useMultiRegionState();
    const [refreshing, setRefreshing] = React.useState(false);

    // Compute totals from poolInfos / accountInfos when available
    const dedicatedUsed = React.useMemo(
        () => state.accountInfos.reduce((s, a) => s + a.dedicatedCoresUsed, 0),
        [state.accountInfos]
    );
    const dedicatedQuota = React.useMemo(
        () => state.accountInfos.reduce((s, a) => s + a.dedicatedCoreQuota, 0),
        [state.accountInfos]
    );
    const lpUsed = React.useMemo(
        () =>
            state.accountInfos.reduce((s, a) => s + a.lowPriorityCoresUsed, 0),
        [state.accountInfos]
    );
    const lpQuota = React.useMemo(
        () =>
            state.accountInfos.reduce((s, a) => s + a.lowPriorityCoreQuota, 0),
        [state.accountInfos]
    );

    const handleRefreshAll = React.useCallback(async () => {
        setRefreshing(true);
        try {
            await orchestrator.execute({
                action: "refresh_pool_info",
                payload: {},
            });
            await orchestrator.execute({
                action: "refresh_account_info",
                payload: {},
            });
        } catch {
            /* handled by orchestrator */
        } finally {
            setRefreshing(false);
        }
    }, [orchestrator]);

    return (
        <div style={{ padding: "16px 0" }}>
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 12 }}
                styles={{ root: { marginBottom: 16 } }}
            >
                <Text
                    variant="xLarge"
                    styles={{
                        root: {
                            fontWeight: 600,
                            color: "#eee",
                        },
                    }}
                >
                    Multi-Region Manager
                </Text>
                <PrimaryButton
                    text="Refresh All"
                    iconProps={{ iconName: "Refresh" }}
                    onClick={handleRefreshAll}
                    disabled={refreshing}
                />
                {refreshing && <Spinner size={SpinnerSize.small} />}
            </Stack>

            {/* Stats Cards */}
            <div
                style={{
                    display: "flex",
                    gap: 16,
                    flexWrap: "wrap",
                    marginBottom: 16,
                }}
            >
                <StatCard
                    icon="ServerProcesses"
                    title="Accounts"
                    color="#0078d4"
                    onClick={() => onNavigate("accounts")}
                    items={[
                        {
                            label: "Created",
                            value: stats.createdAccounts,
                            color: "#107c10",
                        },
                        {
                            label: "Failed",
                            value: stats.failedAccounts,
                            color: "#d13438",
                        },
                    ]}
                />
                <StatCard
                    icon="AllCurrency"
                    title="Quotas"
                    color="#8764b8"
                    onClick={() => onNavigate("quotas")}
                    items={[
                        {
                            label: "Pending",
                            value: stats.pendingQuotas,
                            color: "#c8a000",
                        },
                        {
                            label: "Approved",
                            value: stats.approvedQuotas,
                            color: "#107c10",
                        },
                        {
                            label: "Denied",
                            value: stats.deniedQuotas,
                            color: "#d13438",
                        },
                    ]}
                />
                <StatCard
                    icon="BuildQueue"
                    title="Pools"
                    color="#00b7c3"
                    onClick={() => onNavigate("pools")}
                    items={[
                        {
                            label: "Created",
                            value: stats.createdPools,
                            color: "#107c10",
                        },
                        {
                            label: "Failed",
                            value: stats.failedPools,
                            color: "#d13438",
                        },
                    ]}
                />
                <StatCard
                    icon="Server"
                    title="Nodes"
                    color="#e3a400"
                    onClick={() => onNavigate("nodes")}
                    items={[
                        { label: "Total", value: stats.totalNodes },
                        {
                            label: "Issues",
                            value: stats.nonWorkingNodes,
                            color: "#d13438",
                        },
                    ]}
                />
                {state.accountInfos.length > 0 && (
                    <>
                        <StatCard
                            icon="Server"
                            title="Dedicated Cores"
                            color="#00b7c3"
                            onClick={() => onNavigate("account-info")}
                            items={[
                                {
                                    label: "Used",
                                    value: dedicatedUsed,
                                    color: "#e3a400",
                                },
                                {
                                    label: "Available",
                                    value: dedicatedQuota,
                                    color: "#107c10",
                                },
                            ]}
                        />
                        <StatCard
                            icon="Server"
                            title="Low Priority Cores"
                            color="#8764b8"
                            onClick={() => onNavigate("account-info")}
                            items={[
                                {
                                    label: "Used",
                                    value: lpUsed,
                                    color: "#e3a400",
                                },
                                {
                                    label: "Available",
                                    value: lpQuota,
                                    color: "#107c10",
                                },
                            ]}
                        />
                    </>
                )}
            </div>

            {/* Agent Status */}
            <AgentStatusStrip />

            {/* Quick Actions */}
            <div style={{ marginTop: 16 }}>
                <Text
                    variant="mediumPlus"
                    styles={{
                        root: {
                            fontWeight: 600,
                            color: "#eee",
                            marginBottom: 8,
                            display: "block",
                        },
                    }}
                >
                    Quick Actions
                </Text>
                <QuickActions store={store} orchestrator={orchestrator} />
            </div>

            {/* Recent Activity */}
            <div style={{ marginTop: 16 }}>
                <RecentActivity />
            </div>
        </div>
    );
};
