import * as React from "react";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    Selection,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import { Icon } from "@fluentui/react/lib/Icon";
import { Dialog, DialogType, DialogFooter } from "@fluentui/react/lib/Dialog";
import { SpinButton } from "@fluentui/react/lib/SpinButton";
import { TextField } from "@fluentui/react/lib/TextField";
import { Label } from "@fluentui/react/lib/Label";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
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

    // Selection state
    const [selectedPool, setSelectedPool] = React.useState<PoolInfo | null>(
        null
    );

    const selection = React.useMemo(
        () =>
            new Selection({
                onSelectionChanged: () => {
                    const selected = selection.getSelection();
                    setSelectedPool(
                        selected.length > 0 ? (selected[0] as PoolInfo) : null
                    );
                },
                getKey: (item: any) => item.id,
            }),
        []
    );

    // Resize dialog state
    const [showResizeDialog, setShowResizeDialog] = React.useState(false);
    const [resizeDedicated, setResizeDedicated] = React.useState(0);
    const [resizeLowPriority, setResizeLowPriority] = React.useState(0);
    const [resizeSubmitting, setResizeSubmitting] = React.useState(false);

    // Start task dialog state
    const [showStartTaskDialog, setShowStartTaskDialog] = React.useState(false);
    const [startTaskJson, setStartTaskJson] = React.useState("");
    const [startTaskError, setStartTaskError] = React.useState<string | null>(
        null
    );
    const [startTaskSubmitting, setStartTaskSubmitting] = React.useState(false);

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

    // Get LP quota hint for selected pool
    const getLpQuotaHint = (): string => {
        if (!selectedPool) return "";
        const accountInfo = state.accountInfos.find(
            (a) => a.id === selectedPool.accountId
        );
        if (!accountInfo) return "Quota info not available";
        return `Available LP quota: ${accountInfo.lowPriorityCoresFree} cores`;
    };

    // Resize dialog handlers
    const openResizeDialog = () => {
        if (!selectedPool) return;
        setResizeDedicated(selectedPool.targetDedicatedNodes);
        setResizeLowPriority(selectedPool.targetLowPriorityNodes);
        setShowResizeDialog(true);
    };

    const submitResize = async () => {
        if (!selectedPool) return;
        setResizeSubmitting(true);
        try {
            await orchestrator.execute({
                action: "resize_pool",
                payload: {
                    accountId: selectedPool.accountId,
                    poolId: selectedPool.poolId,
                    targetDedicatedNodes: resizeDedicated,
                    targetLowPriorityNodes: resizeLowPriority,
                },
            });
            setShowResizeDialog(false);
        } catch {
            /* handled by orchestrator */
        } finally {
            setResizeSubmitting(false);
        }
    };

    // Start task dialog handlers
    const openStartTaskDialog = () => {
        if (!selectedPool) return;
        setStartTaskJson(JSON.stringify(selectedPool.startTask || {}, null, 2));
        setStartTaskError(null);
        setShowStartTaskDialog(true);
    };

    const submitStartTask = async () => {
        if (!selectedPool) return;
        let parsedJson: Record<string, unknown>;
        try {
            parsedJson = JSON.parse(startTaskJson);
        } catch (e: any) {
            setStartTaskError(`Invalid JSON: ${e.message}`);
            return;
        }
        setStartTaskError(null);
        setStartTaskSubmitting(true);
        try {
            await orchestrator.execute({
                action: "update_start_task",
                payload: {
                    accountId: selectedPool.accountId,
                    poolId: selectedPool.poolId,
                    startTask: parsedJson,
                },
            });
            setShowStartTaskDialog(false);
        } catch {
            /* handled by orchestrator */
        } finally {
            setStartTaskSubmitting(false);
        }
    };

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
                        : "\u2014",
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
                <PrimaryButton
                    text="Resize Pool"
                    iconProps={{ iconName: "ScaleVolume" }}
                    onClick={openResizeDialog}
                    disabled={!selectedPool}
                />
                <DefaultButton
                    text="Update Start Task"
                    iconProps={{ iconName: "Play" }}
                    onClick={openStartTaskDialog}
                    disabled={!selectedPool}
                />
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
                    No pool info available. Click &quot;Refresh Pool Info&quot;
                    to load data.
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
                        selectionMode={SelectionMode.single}
                        selection={selection}
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

            {/* Resize Pool Dialog */}
            <Dialog
                hidden={!showResizeDialog}
                onDismiss={() => setShowResizeDialog(false)}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: "Resize Pool",
                    subText: "Adjust the target node counts for this pool.",
                }}
                modalProps={{
                    isBlocking: true,
                    styles: {
                        main: { minWidth: 480 },
                    },
                }}
            >
                {selectedPool && (
                    <Stack tokens={{ childrenGap: 12 }}>
                        <Stack
                            tokens={{ childrenGap: 8 }}
                            styles={{
                                root: {
                                    background: "#252525",
                                    padding: 12,
                                    borderRadius: 4,
                                },
                            }}
                        >
                            <Label styles={{ root: { color: "#999" } }}>
                                Pool ID:{" "}
                                <span style={{ color: "#eee" }}>
                                    {selectedPool.poolId}
                                </span>
                            </Label>
                            <Label styles={{ root: { color: "#999" } }}>
                                Account:{" "}
                                <span style={{ color: "#eee" }}>
                                    {selectedPool.accountName}
                                </span>
                            </Label>
                            <Label styles={{ root: { color: "#999" } }}>
                                Region:{" "}
                                <span style={{ color: "#eee" }}>
                                    {selectedPool.region}
                                </span>
                            </Label>
                            <Label styles={{ root: { color: "#999" } }}>
                                VM Size:{" "}
                                <span style={{ color: "#eee" }}>
                                    {selectedPool.vmSize}
                                </span>
                            </Label>
                        </Stack>
                        <SpinButton
                            label="Target Dedicated Nodes"
                            min={0}
                            step={1}
                            value={String(resizeDedicated)}
                            onChange={(_e, val) =>
                                setResizeDedicated(
                                    parseInt(val ?? "0", 10) || 0
                                )
                            }
                            onIncrement={(val) => {
                                const n = (parseInt(val, 10) || 0) + 1;
                                setResizeDedicated(n);
                                return String(n);
                            }}
                            onDecrement={(val) => {
                                const n = Math.max(
                                    0,
                                    (parseInt(val, 10) || 0) - 1
                                );
                                setResizeDedicated(n);
                                return String(n);
                            }}
                        />
                        <SpinButton
                            label="Target Low-Priority Nodes"
                            min={0}
                            step={1}
                            value={String(resizeLowPriority)}
                            onChange={(_e, val) =>
                                setResizeLowPriority(
                                    parseInt(val ?? "0", 10) || 0
                                )
                            }
                            onIncrement={(val) => {
                                const n = (parseInt(val, 10) || 0) + 1;
                                setResizeLowPriority(n);
                                return String(n);
                            }}
                            onDecrement={(val) => {
                                const n = Math.max(
                                    0,
                                    (parseInt(val, 10) || 0) - 1
                                );
                                setResizeLowPriority(n);
                                return String(n);
                            }}
                        />
                        <Text
                            variant="small"
                            styles={{
                                root: {
                                    color: "#888",
                                    fontStyle: "italic",
                                },
                            }}
                        >
                            {getLpQuotaHint()}
                        </Text>
                    </Stack>
                )}
                <DialogFooter>
                    <PrimaryButton
                        text={resizeSubmitting ? "Submitting..." : "Resize"}
                        onClick={submitResize}
                        disabled={resizeSubmitting}
                    />
                    <DefaultButton
                        text="Cancel"
                        onClick={() => setShowResizeDialog(false)}
                    />
                </DialogFooter>
            </Dialog>

            {/* Update Start Task Dialog */}
            <Dialog
                hidden={!showStartTaskDialog}
                onDismiss={() => setShowStartTaskDialog(false)}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: "Update Start Task",
                    subText: selectedPool
                        ? `Pool: ${selectedPool.poolId} (${selectedPool.accountName})`
                        : "",
                }}
                modalProps={{
                    isBlocking: true,
                    styles: {
                        main: { minWidth: 560 },
                    },
                }}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    <TextField
                        label="Start Task Configuration (JSON)"
                        multiline
                        rows={16}
                        value={startTaskJson}
                        onChange={(_e, val) => {
                            setStartTaskJson(val ?? "");
                            setStartTaskError(null);
                        }}
                        styles={{
                            field: {
                                fontFamily:
                                    "'Consolas', 'Courier New', monospace",
                                fontSize: 13,
                                lineHeight: "1.4",
                            },
                        }}
                    />
                    {startTaskError && (
                        <MessageBar messageBarType={MessageBarType.error}>
                            {startTaskError}
                        </MessageBar>
                    )}
                </Stack>
                <DialogFooter>
                    <PrimaryButton
                        text={startTaskSubmitting ? "Submitting..." : "Update"}
                        onClick={submitStartTask}
                        disabled={startTaskSubmitting}
                    />
                    <DefaultButton
                        text="Cancel"
                        onClick={() => setShowStartTaskDialog(false)}
                    />
                </DialogFooter>
            </Dialog>
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
