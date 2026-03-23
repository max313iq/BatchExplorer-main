import * as React from "react";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import { Icon } from "@fluentui/react/lib/Icon";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { PoolInfo } from "../../store/store-types";
import { StatusBadge } from "../shared/status-badge";

export interface PoolInfoPageProps {
    orchestrator: OrchestratorAgent;
}

export const PoolInfoPage: React.FC<PoolInfoPageProps> = ({ orchestrator }) => {
    const state = useMultiRegionState();
    const [loading, setLoading] = React.useState(false);
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(
        null
    );

    const refresh = React.useCallback(async () => {
        setLoading(true);
        try {
            await orchestrator.execute({
                action: "refresh_pool_info",
                payload: {},
            });
        } catch {
            /* handled by orchestrator */
        } finally {
            setLoading(false);
        }
    }, [orchestrator]);

    const stop = React.useCallback(() => {
        setLoading(false);
        setAutoRefresh(false);
    }, []);

    // Auto-refresh
    React.useEffect(() => {
        if (autoRefresh) {
            intervalRef.current = setInterval(() => {
                refresh();
            }, 30000);
            return () => {
                if (intervalRef.current) clearInterval(intervalRef.current);
            };
        } else {
            if (intervalRef.current) clearInterval(intervalRef.current);
        }
    }, [autoRefresh, refresh]);

    const pools = state.poolInfos;

    // Summary stats
    const totalPools = pools.length;
    const activePools = pools.filter((p) => p.state === "active").length;
    const totalDedicated = pools.reduce(
        (s, p) => s + p.currentDedicatedNodes,
        0
    );
    const totalLowPri = pools.reduce(
        (s, p) => s + p.currentLowPriorityNodes,
        0
    );
    const resizingPools = pools.filter(
        (p) => p.allocationState === "resizing"
    ).length;

    const columns: IColumn[] = React.useMemo(
        () => [
            {
                key: "poolId",
                name: "Pool ID",
                fieldName: "poolId",
                minWidth: 120,
                maxWidth: 200,
                isResizable: true,
            },
            {
                key: "accountName",
                name: "Account",
                fieldName: "accountName",
                minWidth: 100,
                maxWidth: 160,
                isResizable: true,
            },
            {
                key: "region",
                name: "Region",
                fieldName: "region",
                minWidth: 80,
                maxWidth: 120,
                isResizable: true,
            },
            {
                key: "vmSize",
                name: "VM Size",
                fieldName: "vmSize",
                minWidth: 100,
                maxWidth: 160,
                isResizable: true,
            },
            {
                key: "state",
                name: "State",
                minWidth: 70,
                maxWidth: 100,
                isResizable: true,
                onRender: (item: PoolInfo) => (
                    <StatusBadge status={item.state} />
                ),
            },
            {
                key: "allocationState",
                name: "Allocation State",
                fieldName: "allocationState",
                minWidth: 90,
                maxWidth: 120,
                isResizable: true,
            },
            {
                key: "dedicated",
                name: "Dedicated",
                minWidth: 80,
                maxWidth: 110,
                isResizable: true,
                onRender: (item: PoolInfo) => (
                    <span>
                        {item.currentDedicatedNodes} /{" "}
                        {item.targetDedicatedNodes}
                    </span>
                ),
            },
            {
                key: "lowPriority",
                name: "Low Priority",
                minWidth: 80,
                maxWidth: 110,
                isResizable: true,
                onRender: (item: PoolInfo) => (
                    <span>
                        {item.currentLowPriorityNodes} /{" "}
                        {item.targetLowPriorityNodes}
                    </span>
                ),
            },
            {
                key: "taskSlots",
                name: "Task Slots",
                fieldName: "taskSlotsPerNode",
                minWidth: 60,
                maxWidth: 80,
                isResizable: true,
            },
            {
                key: "autoScale",
                name: "Auto Scale",
                minWidth: 60,
                maxWidth: 80,
                isResizable: true,
                onRender: (item: PoolInfo) => (
                    <span>{item.enableAutoScale ? "Yes" : "No"}</span>
                ),
            },
            {
                key: "resizeErrors",
                name: "Resize Errors",
                minWidth: 80,
                maxWidth: 100,
                isResizable: true,
                onRender: (item: PoolInfo) => {
                    const count = item.resizeErrors?.length ?? 0;
                    return (
                        <span
                            style={{
                                color: count > 0 ? "#d13438" : "#999",
                                fontWeight: count > 0 ? 600 : 400,
                            }}
                        >
                            {count}
                        </span>
                    );
                },
            },
            {
                key: "created",
                name: "Created",
                minWidth: 120,
                maxWidth: 160,
                isResizable: true,
                onRender: (item: PoolInfo) =>
                    item.creationTime
                        ? new Date(item.creationTime).toLocaleString()
                        : "—",
            },
        ],
        []
    );

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
                        root: { fontWeight: 600, color: "#eee" },
                    }}
                >
                    Pool Info
                </Text>
                <PrimaryButton
                    text="Refresh Pool Info"
                    iconProps={{ iconName: "Refresh" }}
                    onClick={refresh}
                    disabled={loading}
                />
                {loading && (
                    <>
                        <Spinner size={SpinnerSize.small} />
                        <DefaultButton
                            text="Stop"
                            iconProps={{ iconName: "Stop" }}
                            onClick={stop}
                            styles={{
                                root: {
                                    borderColor: "#d13438",
                                    color: "#d13438",
                                },
                            }}
                        />
                    </>
                )}
                <Toggle
                    label="Auto-refresh (30s)"
                    inlineLabel
                    checked={autoRefresh}
                    onChange={(_e, checked) => setAutoRefresh(checked ?? false)}
                    styles={{
                        root: { marginBottom: 0, marginLeft: 16 },
                        label: { color: "#999", fontSize: 12 },
                    }}
                />
            </Stack>

            {/* Summary Stats */}
            <Stack
                horizontal
                tokens={{ childrenGap: 24 }}
                styles={{
                    root: {
                        padding: "12px 16px",
                        background: "#1e1e1e",
                        borderRadius: 6,
                        marginBottom: 16,
                    },
                }}
            >
                <SummaryStatItem
                    icon="BuildQueue"
                    label="Total Pools"
                    value={totalPools}
                    color="#0078d4"
                />
                <SummaryStatItem
                    icon="StatusCircleCheckmark"
                    label="Active"
                    value={activePools}
                    color="#107c10"
                />
                <SummaryStatItem
                    icon="Server"
                    label="Dedicated Nodes"
                    value={totalDedicated}
                    color="#00b7c3"
                />
                <SummaryStatItem
                    icon="Server"
                    label="Low Priority Nodes"
                    value={totalLowPri}
                    color="#8764b8"
                />
                <SummaryStatItem
                    icon="SyncStatus"
                    label="Resizing"
                    value={resizingPools}
                    color="#e3a400"
                />
            </Stack>

            {/* DetailsList */}
            {pools.length === 0 ? (
                <Text variant="medium" styles={{ root: { color: "#666" } }}>
                    No pool info available. Click "Refresh Pool Info" to load
                    data.
                </Text>
            ) : (
                <div
                    style={{
                        background: "#1e1e1e",
                        borderRadius: 6,
                        padding: 8,
                    }}
                >
                    <DetailsList
                        items={pools}
                        columns={columns}
                        layoutMode={DetailsListLayoutMode.fixedColumns}
                        selectionMode={SelectionMode.none}
                        compact
                        styles={{
                            root: { color: "#ccc" },
                            headerWrapper: {
                                "& .ms-DetailsHeader": {
                                    background: "#252525",
                                    borderBottom: "1px solid #333",
                                },
                                "& .ms-DetailsHeader-cell": {
                                    color: "#999",
                                },
                            },
                            contentWrapper: {
                                "& .ms-DetailsRow": {
                                    background: "#1e1e1e",
                                    borderBottom: "1px solid #2a2a2a",
                                    color: "#ccc",
                                },
                                "& .ms-DetailsRow:hover": {
                                    background: "#252525",
                                },
                            },
                        }}
                    />
                </div>
            )}
        </div>
    );
};

const SummaryStatItem: React.FC<{
    icon: string;
    label: string;
    value: number;
    color: string;
}> = ({ icon, label, value, color }) => (
    <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 8 }}>
        <Icon iconName={icon} styles={{ root: { color, fontSize: 16 } }} />
        <div>
            <Text
                variant="tiny"
                styles={{
                    root: { color: "#888", display: "block", fontSize: 11 },
                }}
            >
                {label}
            </Text>
            <Text variant="large" styles={{ root: { fontWeight: 700, color } }}>
                {value}
            </Text>
        </div>
    </Stack>
);
