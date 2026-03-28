import * as React from "react";
import { Icon } from "@fluentui/react/lib/Icon";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { QuotaSuggestion } from "../../store/store-types";
import {
    useDashboardStats,
    useMultiRegionState,
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

const SkeletonCard: React.FC = () => (
    <div
        style={{
            background: "#252525",
            borderRadius: 8,
            padding: 20,
            flex: "1 1 200px",
            minWidth: 200,
            borderTop: "3px solid #444",
        }}
        aria-busy="true"
        aria-label="Loading stat card"
    >
        <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 10 }}>
            <div
                style={{
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    background: "#333",
                    animation: "pulse 1.5s ease-in-out infinite",
                }}
            />
            <div
                style={{
                    width: 80,
                    height: 16,
                    borderRadius: 4,
                    background: "#333",
                    animation: "pulse 1.5s ease-in-out infinite",
                }}
            />
            <div
                style={{
                    marginLeft: "auto",
                    width: 40,
                    height: 28,
                    borderRadius: 4,
                    background: "#333",
                    animation: "pulse 1.5s ease-in-out infinite",
                }}
            />
        </Stack>
        <Stack
            horizontal
            tokens={{ childrenGap: 16 }}
            styles={{ root: { marginTop: 12 } }}
        >
            {[1, 2, 3].map((n) => (
                <div key={n}>
                    <div
                        style={{
                            width: 50,
                            height: 12,
                            borderRadius: 3,
                            background: "#333",
                            marginBottom: 4,
                            animation: "pulse 1.5s ease-in-out infinite",
                        }}
                    />
                    <div
                        style={{
                            width: 30,
                            height: 18,
                            borderRadius: 3,
                            background: "#333",
                            animation: "pulse 1.5s ease-in-out infinite",
                        }}
                    />
                </div>
            ))}
        </Stack>
    </div>
);

const StatCard: React.FC<StatCardProps> = ({
    icon,
    title,
    color,
    items,
    onClick,
}) => {
    const total =
        items.length > 0 && items[0].label === "Total"
            ? items[0].value
            : items.reduce((s, i) => s + i.value, 0);
    return (
        <div
            onClick={onClick}
            aria-label={`${title}: ${total}`}
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

// --- Unused Quota Section ---

const UnusedQuotaSection: React.FC<{
    orchestrator: OrchestratorAgent;
}> = ({ orchestrator }) => {
    const state = useMultiRegionState();
    const [detecting, setDetecting] = React.useState(false);
    const [creating, setCreating] = React.useState(false);
    const [suggestions, setSuggestions] = React.useState<QuotaSuggestion[]>([]);
    const [selectedIndices, setSelectedIndices] = React.useState<Set<number>>(
        new Set()
    );

    const accountsWithFreeQuota = React.useMemo(
        () =>
            state.accountInfos.filter(
                (a) => a.lowPriorityCoresFree > 0 || a.dedicatedCoresFree > 0
            ),
        [state.accountInfos]
    );

    const totalFreeLpCores = React.useMemo(
        () =>
            accountsWithFreeQuota.reduce(
                (s, a) => s + a.lowPriorityCoresFree,
                0
            ),
        [accountsWithFreeQuota]
    );

    const handleDetect = React.useCallback(async () => {
        setDetecting(true);
        setSuggestions([]);
        setSelectedIndices(new Set());
        try {
            const result = await orchestrator.execute({
                action: "detect_unused_quota",
                payload: {},
            });
            const items = (result.summary as Record<string, unknown>)
                ?.suggestions as QuotaSuggestion[];
            setSuggestions(items ?? []);
        } catch {
            /* handled by orchestrator */
        } finally {
            setDetecting(false);
        }
    }, [orchestrator]);

    const handleAutoCreate = React.useCallback(async () => {
        const selected = suggestions.filter((_, i) => selectedIndices.has(i));
        if (selected.length === 0) return;
        setCreating(true);
        try {
            await orchestrator.execute({
                action: "auto_create_pools_from_quota",
                payload: { suggestions: selected },
            });
        } catch {
            /* handled by orchestrator */
        } finally {
            setCreating(false);
        }
    }, [orchestrator, suggestions, selectedIndices]);

    const toggleSelect = React.useCallback((index: number) => {
        setSelectedIndices((prev) => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    }, []);

    const toggleSelectAll = React.useCallback(() => {
        setSelectedIndices((prev) => {
            if (prev.size === suggestions.length) {
                return new Set();
            }
            return new Set(suggestions.map((_, i) => i));
        });
    }, [suggestions]);

    return (
        <div
            style={{
                background: "#1e1e1e",
                borderRadius: 6,
                padding: 16,
                marginTop: 16,
            }}
        >
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 12 }}
                styles={{ root: { marginBottom: 12 } }}
            >
                <Icon
                    iconName="Savings"
                    styles={{ root: { fontSize: 18, color: "#e3a400" } }}
                />
                <Text
                    variant="mediumPlus"
                    styles={{
                        root: { fontWeight: 600, color: "#eee" },
                    }}
                >
                    Unused Quota
                </Text>
                {state.accountInfos.length > 0 && (
                    <Text variant="small" styles={{ root: { color: "#888" } }}>
                        {accountsWithFreeQuota.length} accounts with{" "}
                        {totalFreeLpCores} free LP cores
                    </Text>
                )}
                <DefaultButton
                    text="Detect Unused Quota"
                    iconProps={{ iconName: "Search" }}
                    onClick={handleDetect}
                    disabled={detecting || state.accountInfos.length === 0}
                    styles={{
                        root: { marginLeft: "auto" },
                    }}
                />
                {detecting && <Spinner size={SpinnerSize.small} />}
            </Stack>

            {suggestions.length > 0 && (
                <>
                    <div
                        style={{
                            overflowX: "auto",
                            marginBottom: 12,
                        }}
                    >
                        <table
                            style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                fontSize: 12,
                            }}
                        >
                            <thead>
                                <tr
                                    style={{
                                        borderBottom: "1px solid #333",
                                    }}
                                >
                                    <th
                                        style={{
                                            padding: "6px 8px",
                                            textAlign: "left",
                                            color: "#888",
                                        }}
                                    >
                                        <Checkbox
                                            checked={
                                                selectedIndices.size ===
                                                    suggestions.length &&
                                                suggestions.length > 0
                                            }
                                            onChange={toggleSelectAll}
                                        />
                                    </th>
                                    <th
                                        style={{
                                            padding: "6px 8px",
                                            textAlign: "left",
                                            color: "#888",
                                        }}
                                    >
                                        Account
                                    </th>
                                    <th
                                        style={{
                                            padding: "6px 8px",
                                            textAlign: "left",
                                            color: "#888",
                                        }}
                                    >
                                        Region
                                    </th>
                                    <th
                                        style={{
                                            padding: "6px 8px",
                                            textAlign: "right",
                                            color: "#888",
                                        }}
                                    >
                                        Free LP
                                    </th>
                                    <th
                                        style={{
                                            padding: "6px 8px",
                                            textAlign: "right",
                                            color: "#888",
                                        }}
                                    >
                                        Free Dedicated
                                    </th>
                                    <th
                                        style={{
                                            padding: "6px 8px",
                                            textAlign: "left",
                                            color: "#888",
                                        }}
                                    >
                                        VM Size
                                    </th>
                                    <th
                                        style={{
                                            padding: "6px 8px",
                                            textAlign: "right",
                                            color: "#888",
                                        }}
                                    >
                                        Max LP Nodes
                                    </th>
                                    <th
                                        style={{
                                            padding: "6px 8px",
                                            textAlign: "right",
                                            color: "#888",
                                        }}
                                    >
                                        Max Dedicated Nodes
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {suggestions.map((s, i) => (
                                    <tr
                                        key={`${s.accountId}-${s.vmSize}-${i}`}
                                        style={{
                                            borderBottom: "1px solid #2a2a2a",
                                            background: selectedIndices.has(i)
                                                ? "#2a3040"
                                                : "transparent",
                                        }}
                                    >
                                        <td
                                            style={{
                                                padding: "6px 8px",
                                            }}
                                        >
                                            <Checkbox
                                                checked={selectedIndices.has(i)}
                                                onChange={() => toggleSelect(i)}
                                            />
                                        </td>
                                        <td
                                            style={{
                                                padding: "6px 8px",
                                                color: "#ccc",
                                            }}
                                        >
                                            {s.accountName}
                                        </td>
                                        <td
                                            style={{
                                                padding: "6px 8px",
                                                color: "#999",
                                            }}
                                        >
                                            {s.region}
                                        </td>
                                        <td
                                            style={{
                                                padding: "6px 8px",
                                                textAlign: "right",
                                                color: "#8764b8",
                                            }}
                                        >
                                            {s.freeLpCores}
                                        </td>
                                        <td
                                            style={{
                                                padding: "6px 8px",
                                                textAlign: "right",
                                                color: "#00b7c3",
                                            }}
                                        >
                                            {s.freeDedicatedCores}
                                        </td>
                                        <td
                                            style={{
                                                padding: "6px 8px",
                                                color: "#ccc",
                                            }}
                                        >
                                            {s.vmSize}
                                        </td>
                                        <td
                                            style={{
                                                padding: "6px 8px",
                                                textAlign: "right",
                                                color:
                                                    s.maxLpNodes > 0
                                                        ? "#107c10"
                                                        : "#555",
                                            }}
                                        >
                                            {s.maxLpNodes}
                                        </td>
                                        <td
                                            style={{
                                                padding: "6px 8px",
                                                textAlign: "right",
                                                color:
                                                    s.maxDedicatedNodes > 0
                                                        ? "#107c10"
                                                        : "#555",
                                            }}
                                        >
                                            {s.maxDedicatedNodes}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <Stack
                        horizontal
                        tokens={{ childrenGap: 8 }}
                        verticalAlign="center"
                    >
                        <PrimaryButton
                            text={`Auto-Create Pools (${selectedIndices.size})`}
                            iconProps={{ iconName: "Add" }}
                            onClick={handleAutoCreate}
                            disabled={selectedIndices.size === 0 || creating}
                        />
                        {creating && <Spinner size={SpinnerSize.small} />}
                        <Text
                            variant="small"
                            styles={{ root: { color: "#888" } }}
                        >
                            {selectedIndices.size} of {suggestions.length}{" "}
                            selected
                        </Text>
                    </Stack>
                </>
            )}

            {suggestions.length === 0 &&
                !detecting &&
                state.accountInfos.length > 0 && (
                    <Text variant="small" styles={{ root: { color: "#666" } }}>
                        Click "Detect Unused Quota" to find accounts with
                        available cores for new GPU pools.
                    </Text>
                )}

            {state.accountInfos.length === 0 && (
                <Text variant="small" styles={{ root: { color: "#666" } }}>
                    Refresh account info first to detect unused quota.
                </Text>
            )}
        </div>
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

    const isLoading = refreshing || state.accounts.length === 0;
    const isEmptyState =
        !refreshing &&
        state.accounts.length === 0 &&
        stats.totalAccounts === 0 &&
        stats.totalPools === 0 &&
        stats.totalNodes === 0;

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

            {isEmptyState && (
                <div
                    role="status"
                    style={{
                        background: "#1e1e1e",
                        borderRadius: 6,
                        padding: 32,
                        textAlign: "center",
                        marginBottom: 16,
                    }}
                >
                    <Icon
                        iconName="AuthenticatorApp"
                        styles={{
                            root: {
                                fontSize: 40,
                                color: "#555",
                                marginBottom: 12,
                            },
                        }}
                    />
                    <Text
                        variant="large"
                        styles={{
                            root: {
                                display: "block",
                                color: "#999",
                                marginBottom: 8,
                            },
                        }}
                    >
                        No data available. Sign in to load accounts.
                    </Text>
                </div>
            )}

            {/* Stats Cards */}
            <div
                role="region"
                aria-label="Dashboard statistics"
                style={{
                    display: "flex",
                    gap: 16,
                    flexWrap: "wrap",
                    marginBottom: 16,
                }}
            >
                {isLoading &&
                    stats.totalAccounts === 0 &&
                    stats.totalPools === 0 &&
                    [1, 2, 3, 4].map((n) => <SkeletonCard key={n} />)}
                <StatCard
                    icon="ServerProcesses"
                    title="Accounts"
                    color="#0078d4"
                    onClick={() => onNavigate("accounts")}
                    items={[
                        {
                            label: "Total",
                            value: stats.totalAccounts,
                            color: "#0078d4",
                        },
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
                            label: "Total",
                            value: stats.totalPools,
                            color: "#00b7c3",
                        },
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
                        {
                            label: "Total",
                            value: stats.totalNodes,
                            color: "#e3a400",
                        },
                        {
                            label: "Running",
                            value: stats.runningNodes,
                            color: "#107c10",
                        },
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

            {/* Unused Quota */}
            <div role="region" aria-label="Unused quota">
                <UnusedQuotaSection orchestrator={orchestrator} />
            </div>

            {/* Agent Status */}
            <div role="region" aria-label="Agent status">
                <AgentStatusStrip />
            </div>

            {/* Quick Actions */}
            <div
                role="region"
                aria-label="Quick actions"
                style={{ marginTop: 16 }}
            >
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
            <div
                role="region"
                aria-label="Recent activity"
                style={{ marginTop: 16 }}
            >
                <RecentActivity />
            </div>
        </div>
    );
};
