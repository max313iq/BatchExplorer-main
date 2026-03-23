import * as React from "react";
import {
    DetailsList,
    IColumn,
    SelectionMode,
    Selection,
    DetailsListLayoutMode,
    CheckboxVisibility,
} from "@fluentui/react/lib/DetailsList";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { ProgressIndicator } from "@fluentui/react/lib/ProgressIndicator";
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { Text } from "@fluentui/react/lib/Text";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { StatusBadge } from "../shared/status-badge";
import { ManagedNode, NodeState } from "../../store/store-types";

interface NodesPageProps {
    orchestrator: OrchestratorAgent;
}

const stackTokens: IStackTokens = { childrenGap: 12 };

const ALL_NODE_STATES: NodeState[] = [
    "idle",
    "running",
    "creating",
    "leavingpool",
    "rebooting",
    "reimaging",
    "starting",
    "starttaskfailed",
    "unknown",
    "unusable",
    "offline",
    "waitingforstarttask",
    "preempted",
];

const NODE_STATE_OPTIONS: IDropdownOption[] = ALL_NODE_STATES.map((s) => ({
    key: s,
    text: s,
}));

type NodeActionType =
    | "reboot"
    | "delete"
    | "reimage"
    | "disableScheduling"
    | "enableScheduling";

const AUTO_REFRESH_INTERVAL_MS = 30_000;
const AUTO_RECOVERY_INTERVAL_MS = 60_000;

export const NodesPage: React.FC<NodesPageProps> = ({ orchestrator }) => {
    const state = useMultiRegionState();
    const [isLoading, setIsLoading] = React.useState(false);
    const [isActing, setIsActing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [selectedNodeIds, setSelectedNodeIds] = React.useState<Set<string>>(
        new Set()
    );
    const [selectAll, setSelectAll] = React.useState(false);
    const [selectedStates, setSelectedStates] = React.useState<string[]>(
        ALL_NODE_STATES.slice()
    );
    const [filterLowPriority, setFilterLowPriority] = React.useState(false);
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [autoRecovery, setAutoRecovery] = React.useState(false);

    const createdAccounts = state.accounts.filter(
        (a) => a.provisioningState === "created"
    );

    // Auto-load nodes on mount if there are created accounts and no nodes loaded yet
    const autoLoadedRef = React.useRef(false);
    React.useEffect(() => {
        if (autoLoadedRef.current) return;
        if (createdAccounts.length > 0 && state.nodes.length === 0) {
            autoLoadedRef.current = true;
            (async () => {
                setIsLoading(true);
                setError(null);
                try {
                    await orchestrator.execute({
                        action: "list_nodes",
                        payload: {
                            accountIds: createdAccounts.map((a) => a.id),
                        },
                    });
                } catch (err: any) {
                    setError(err?.message ?? String(err));
                } finally {
                    setIsLoading(false);
                }
            })();
        }
    }, [createdAccounts.length, state.nodes.length, orchestrator]);

    // --- Summary stats ---
    const summaryStats = React.useMemo(() => {
        const nodes = state.nodes;
        const dedicatedCount = nodes.filter((n) => n.isDedicated).length;
        const lowPriorityCount = nodes.filter((n) => !n.isDedicated).length;
        const preemptedCount = nodes.filter(
            (n) => n.state === "preempted"
        ).length;
        const runningTasks = nodes.reduce(
            (sum, n) => sum + (n.runningTasksCount ?? 0),
            0
        );
        const idleCount = nodes.filter((n) => n.state === "idle").length;
        return {
            total: nodes.length,
            dedicatedCount,
            lowPriorityCount,
            preemptedCount,
            runningTasks,
            idleCount,
        };
    }, [state.nodes]);

    // --- Filtered display nodes ---
    const displayNodes = React.useMemo(() => {
        let nodes = state.nodes;
        const stateSet = new Set(selectedStates);
        if (stateSet.size < ALL_NODE_STATES.length) {
            nodes = nodes.filter((n) => stateSet.has(n.state));
        }
        if (filterLowPriority) {
            nodes = nodes.filter((n) => !n.isDedicated);
        }
        return nodes;
    }, [state.nodes, selectedStates, filterLowPriority]);

    const selection = React.useMemo(() => {
        const sel = new Selection({
            onSelectionChanged: () => {
                const items = sel.getSelection() as ManagedNode[];
                setSelectedNodeIds(new Set(items.map((n) => n.id)));
            },
        });
        return sel;
    }, []);

    const handleRefreshNodes = React.useCallback(async () => {
        if (createdAccounts.length === 0) return;
        setIsLoading(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "list_nodes",
                payload: {
                    accountIds: createdAccounts.map((a) => a.id),
                },
            });
        } catch (err: any) {
            setError(err?.message ?? String(err));
        } finally {
            setIsLoading(false);
        }
    }, [orchestrator, createdAccounts]);

    // --- Auto-refresh timer ---
    React.useEffect(() => {
        if (!autoRefresh) return;
        const interval = setInterval(() => {
            handleRefreshNodes();
        }, AUTO_REFRESH_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [autoRefresh, handleRefreshNodes]);

    // --- Auto-recovery timer ---
    React.useEffect(() => {
        if (!autoRecovery) return;
        const interval = setInterval(async () => {
            const preemptedNodes = state.nodes.filter(
                (n) => n.state === "preempted"
            );
            if (preemptedNodes.length === 0) return;
            try {
                await orchestrator.execute({
                    action: "recover_preempted",
                    payload: {},
                });
            } catch {
                // Silently fail for auto-recovery; logs are written by the orchestrator
            }
        }, AUTO_RECOVERY_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [autoRecovery, orchestrator, state.nodes]);

    const handleNodeAction = React.useCallback(
        async (action: NodeActionType) => {
            const ids = selectAll
                ? displayNodes.map((n) => n.id)
                : Array.from(selectedNodeIds);
            if (ids.length === 0) return;

            if (action === "delete") {
                const confirmed = window.confirm(
                    `Are you sure you want to delete ${ids.length} node(s)? This action cannot be undone.`
                );
                if (!confirmed) return;
            }

            if (action === "reimage") {
                const confirmed = window.confirm(
                    `Are you sure you want to reimage ${ids.length} node(s)? Running tasks will be requeued.`
                );
                if (!confirmed) return;
            }

            setIsActing(true);
            setError(null);
            try {
                await orchestrator.execute({
                    action: "node_action",
                    payload: {
                        actionType: action,
                        nodeIds: ids,
                    },
                });
            } catch (err: any) {
                setError(err?.message ?? String(err));
            } finally {
                setIsActing(false);
            }
        },
        [orchestrator, selectedNodeIds, selectAll, displayNodes]
    );

    // --- Bulk delete (grouped by pool) ---
    const handleDeleteNodes = React.useCallback(async () => {
        const ids = selectAll
            ? displayNodes.map((n) => n.id)
            : Array.from(selectedNodeIds);
        if (ids.length === 0) return;

        // Count unique pools
        const poolSet = new Set<string>();
        for (const id of ids) {
            const node = state.nodes.find((n) => n.id === id);
            if (node) poolSet.add(`${node.accountName}/${node.poolId}`);
        }

        const confirmed = window.confirm(
            `Delete ${ids.length} nodes from ${poolSet.size} pool(s)?`
        );
        if (!confirmed) return;

        setIsActing(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "delete_nodes",
                payload: { nodeIds: ids },
            });
        } catch (err: any) {
            setError(err?.message ?? String(err));
        } finally {
            setIsActing(false);
        }
    }, [orchestrator, selectedNodeIds, selectAll, displayNodes, state.nodes]);

    // --- Recreate nodes ---
    const handleRecreateNodes = React.useCallback(async () => {
        const ids = selectAll
            ? displayNodes.map((n) => n.id)
            : Array.from(selectedNodeIds);
        if (ids.length === 0) return;

        const confirmed = window.confirm(
            `Recreate ${ids.length} node(s)? Nodes will be removed and pool targets restored to trigger fresh allocation.`
        );
        if (!confirmed) return;

        setIsActing(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "recreate_nodes",
                payload: { nodeIds: ids },
            });
        } catch (err: any) {
            setError(err?.message ?? String(err));
        } finally {
            setIsActing(false);
        }
    }, [orchestrator, selectedNodeIds, selectAll, displayNodes]);

    // --- Recover preempted ---
    const handleRecoverPreempted = React.useCallback(async () => {
        const preemptedCount = state.nodes.filter(
            (n) => n.state === "preempted"
        ).length;
        if (preemptedCount === 0) {
            setError("No preempted nodes to recover.");
            return;
        }

        const confirmed = window.confirm(
            `Recover ${preemptedCount} preempted node(s)? This will re-request low-priority capacity for affected pools.`
        );
        if (!confirmed) return;

        setIsActing(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "recover_preempted",
                payload: {},
            });
        } catch (err: any) {
            setError(err?.message ?? String(err));
        } finally {
            setIsActing(false);
        }
    }, [orchestrator, state.nodes]);

    // --- Handle state filter dropdown ---
    const handleStateFilterChange = React.useCallback(
        (_event: React.FormEvent<HTMLDivElement>, option?: IDropdownOption) => {
            if (!option) return;
            setSelectedStates((prev) => {
                if (option.selected) {
                    return [...prev, option.key as string];
                } else {
                    return prev.filter((s) => s !== option.key);
                }
            });
        },
        []
    );

    // --- Columns ---
    const columns: IColumn[] = [
        {
            key: "nodeId",
            name: "Node ID",
            fieldName: "nodeId",
            minWidth: 140,
            maxWidth: 220,
            isResizable: true,
        },
        {
            key: "state",
            name: "State",
            fieldName: "state",
            minWidth: 100,
            maxWidth: 140,
            onRender: (item: ManagedNode) => (
                <StatusBadge status={item.state} />
            ),
        },
        {
            key: "isDedicated",
            name: "Priority",
            fieldName: "isDedicated",
            minWidth: 90,
            maxWidth: 120,
            onRender: (item: ManagedNode) => (
                <span
                    style={{
                        color: item.isDedicated ? "#0078d4" : "#ca5010",
                        fontWeight: 600,
                        fontSize: 12,
                    }}
                >
                    {item.isDedicated ? "Dedicated" : "Low Priority"}
                </span>
            ),
        },
        {
            key: "runningTasksCount",
            name: "Running Tasks",
            fieldName: "runningTasksCount",
            minWidth: 90,
            maxWidth: 120,
            onRender: (item: ManagedNode) => (
                <span style={{ fontSize: 12 }}>
                    {item.runningTasksCount ?? 0}
                </span>
            ),
        },
        {
            key: "schedulingState",
            name: "Scheduling",
            fieldName: "schedulingState",
            minWidth: 80,
            maxWidth: 110,
            onRender: (item: ManagedNode) => {
                const enabled =
                    (item.schedulingState ?? "enabled").toLowerCase() ===
                    "enabled";
                return (
                    <span
                        style={{
                            color: enabled ? "#107c10" : "#a80000",
                            fontWeight: 600,
                            fontSize: 12,
                        }}
                    >
                        {enabled ? "Enabled" : "Disabled"}
                    </span>
                );
            },
        },
        {
            key: "totalTasksRun",
            name: "Total Tasks Run",
            fieldName: "totalTasksRun",
            minWidth: 100,
            maxWidth: 130,
            onRender: (item: ManagedNode) => (
                <span style={{ fontSize: 12 }}>{item.totalTasksRun ?? 0}</span>
            ),
        },
        {
            key: "accountName",
            name: "Batch Account",
            fieldName: "accountName",
            minWidth: 130,
            maxWidth: 200,
            isResizable: true,
        },
        {
            key: "region",
            name: "Region",
            fieldName: "region",
            minWidth: 90,
            maxWidth: 140,
            isResizable: true,
        },
        {
            key: "poolId",
            name: "Pool",
            fieldName: "poolId",
            minWidth: 80,
            maxWidth: 140,
            isResizable: true,
        },
        {
            key: "vmSize",
            name: "VM Size",
            fieldName: "vmSize",
            minWidth: 120,
            maxWidth: 180,
            isResizable: true,
        },
        {
            key: "ipAddress",
            name: "IP Address",
            fieldName: "ipAddress",
            minWidth: 100,
            maxWidth: 140,
            isResizable: true,
        },
        {
            key: "error",
            name: "Error",
            fieldName: "error",
            minWidth: 150,
            maxWidth: 300,
            isResizable: true,
            onRender: (item: ManagedNode) =>
                item.error ? (
                    <span
                        style={{
                            color: "#a80000",
                            fontSize: 12,
                            fontWeight: 600,
                        }}
                        title={item.error}
                    >
                        {item.error}
                    </span>
                ) : (
                    <span style={{ color: "#605e5c", fontSize: 12 }}>
                        {"\u2014"}
                    </span>
                ),
        },
    ];

    const actionCount = selectAll ? displayNodes.length : selectedNodeIds.size;

    // --- Summary stat card style ---
    const statCardStyle: React.CSSProperties = {
        background: "#faf9f8",
        border: "1px solid #edebe9",
        borderRadius: 4,
        padding: "8px 14px",
        minWidth: 100,
        textAlign: "center",
    };

    return (
        <div style={{ padding: "16px" }}>
            <Stack tokens={stackTokens}>
                <Stack
                    horizontal
                    verticalAlign="center"
                    tokens={{ childrenGap: 16 }}
                >
                    <h2 style={{ margin: 0 }}>Nodes</h2>
                    <Toggle
                        label="Auto-refresh (30s)"
                        inlineLabel
                        checked={autoRefresh}
                        onChange={(_, checked) => setAutoRefresh(!!checked)}
                        styles={{ root: { marginBottom: 0 } }}
                    />
                    <Toggle
                        label="Auto-Recovery (60s)"
                        inlineLabel
                        checked={autoRecovery}
                        onChange={(_, checked) => setAutoRecovery(!!checked)}
                        styles={{ root: { marginBottom: 0 } }}
                    />
                </Stack>

                {error && (
                    <MessageBar
                        messageBarType={MessageBarType.error}
                        onDismiss={() => setError(null)}
                    >
                        {error}
                    </MessageBar>
                )}

                {/* Summary Stats */}
                <Stack horizontal tokens={{ childrenGap: 10 }} wrap>
                    <div style={statCardStyle}>
                        <Text
                            variant="small"
                            block
                            styles={{ root: { color: "#605e5c" } }}
                        >
                            Total Nodes
                        </Text>
                        <Text
                            variant="xLarge"
                            styles={{ root: { fontWeight: 700 } }}
                        >
                            {summaryStats.total}
                        </Text>
                    </div>
                    <div style={statCardStyle}>
                        <Text
                            variant="small"
                            block
                            styles={{ root: { color: "#0078d4" } }}
                        >
                            Dedicated
                        </Text>
                        <Text
                            variant="xLarge"
                            styles={{
                                root: {
                                    fontWeight: 700,
                                    color: "#0078d4",
                                },
                            }}
                        >
                            {summaryStats.dedicatedCount}
                        </Text>
                    </div>
                    <div style={statCardStyle}>
                        <Text
                            variant="small"
                            block
                            styles={{ root: { color: "#ca5010" } }}
                        >
                            Low Priority
                        </Text>
                        <Text
                            variant="xLarge"
                            styles={{
                                root: {
                                    fontWeight: 700,
                                    color: "#ca5010",
                                },
                            }}
                        >
                            {summaryStats.lowPriorityCount}
                        </Text>
                    </div>
                    <div style={statCardStyle}>
                        <Text
                            variant="small"
                            block
                            styles={{ root: { color: "#d13438" } }}
                        >
                            Preempted
                        </Text>
                        <Text
                            variant="xLarge"
                            styles={{
                                root: {
                                    fontWeight: 700,
                                    color: "#d13438",
                                },
                            }}
                        >
                            {summaryStats.preemptedCount}
                        </Text>
                    </div>
                    <div style={statCardStyle}>
                        <Text
                            variant="small"
                            block
                            styles={{ root: { color: "#107c10" } }}
                        >
                            Running Tasks
                        </Text>
                        <Text
                            variant="xLarge"
                            styles={{
                                root: {
                                    fontWeight: 700,
                                    color: "#107c10",
                                },
                            }}
                        >
                            {summaryStats.runningTasks}
                        </Text>
                    </div>
                    <div style={statCardStyle}>
                        <Text
                            variant="small"
                            block
                            styles={{ root: { color: "#605e5c" } }}
                        >
                            Idle Nodes
                        </Text>
                        <Text
                            variant="xLarge"
                            styles={{ root: { fontWeight: 700 } }}
                        >
                            {summaryStats.idleCount}
                        </Text>
                    </div>
                </Stack>

                {/* Toolbar: Refresh, Stop, Filters */}
                <Stack
                    horizontal
                    tokens={{ childrenGap: 12 }}
                    verticalAlign="end"
                    wrap
                >
                    <PrimaryButton
                        text={
                            isLoading
                                ? "Loading..."
                                : `Refresh Nodes (${createdAccounts.length} accounts)`
                        }
                        onClick={handleRefreshNodes}
                        disabled={isLoading || createdAccounts.length === 0}
                        iconProps={{ iconName: "Refresh" }}
                    />
                    {isLoading && (
                        <DefaultButton
                            text="Stop"
                            onClick={() => orchestrator.cancel()}
                            styles={{
                                root: {
                                    borderColor: "#d13438",
                                    color: "#d13438",
                                },
                            }}
                        />
                    )}
                    <Dropdown
                        placeholder="Filter by state"
                        label="Node States"
                        selectedKeys={selectedStates}
                        onChange={handleStateFilterChange}
                        multiSelect
                        options={NODE_STATE_OPTIONS}
                        styles={{
                            dropdown: { minWidth: 200, maxWidth: 300 },
                            root: { minWidth: 200 },
                        }}
                    />
                    <Checkbox
                        label="Show low-priority only"
                        checked={filterLowPriority}
                        onChange={(_, checked) =>
                            setFilterLowPriority(!!checked)
                        }
                        styles={{ root: { marginTop: 24 } }}
                    />
                    <Checkbox
                        label={`Select all (${displayNodes.length})`}
                        checked={selectAll}
                        onChange={(_, checked) => {
                            setSelectAll(!!checked);
                            if (checked) {
                                setSelectedNodeIds(
                                    new Set(displayNodes.map((n) => n.id))
                                );
                            } else {
                                setSelectedNodeIds(new Set());
                            }
                        }}
                        styles={{ root: { marginTop: 24 } }}
                    />
                </Stack>

                {/* Node Actions */}
                <Stack horizontal tokens={{ childrenGap: 8 }} wrap>
                    <DefaultButton
                        text={`Reboot (${actionCount})`}
                        onClick={() => handleNodeAction("reboot")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "Refresh" }}
                    />
                    <DefaultButton
                        text={`Reimage (${actionCount})`}
                        onClick={() => handleNodeAction("reimage")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "Rebuild" }}
                    />
                    <DefaultButton
                        text={`Disable Scheduling (${actionCount})`}
                        onClick={() => handleNodeAction("disableScheduling")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "CirclePause" }}
                    />
                    <DefaultButton
                        text={`Enable Scheduling (${actionCount})`}
                        onClick={() => handleNodeAction("enableScheduling")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "Play" }}
                    />
                    <DefaultButton
                        text={`Delete Nodes (${actionCount})`}
                        onClick={handleDeleteNodes}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "Delete" }}
                        styles={{
                            root: {
                                borderColor: "#a80000",
                                color: "#a80000",
                            },
                        }}
                    />
                    <DefaultButton
                        text={`Recreate Nodes (${actionCount})`}
                        onClick={handleRecreateNodes}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "SyncOccurence" }}
                        styles={{
                            root: {
                                borderColor: "#8764b8",
                                color: "#8764b8",
                            },
                        }}
                    />
                    <DefaultButton
                        text={`Recover Preempted (${summaryStats.preemptedCount})`}
                        onClick={handleRecoverPreempted}
                        disabled={isActing || summaryStats.preemptedCount === 0}
                        iconProps={{ iconName: "Heart" }}
                        styles={{
                            root: {
                                borderColor: "#d13438",
                                color: "#d13438",
                            },
                        }}
                    />
                </Stack>

                {(isLoading || isActing) && (
                    <ProgressIndicator
                        label={
                            isLoading
                                ? "Loading nodes..."
                                : "Performing action..."
                        }
                    />
                )}

                <div style={{ fontSize: 13, color: "#605e5c" }}>
                    {displayNodes.length} nodes
                    {selectedStates.length < ALL_NODE_STATES.length
                        ? ` (filtered: ${selectedStates.join(", ")})`
                        : ""}
                    {filterLowPriority ? " (low-priority only)" : ""}
                    {" | "}
                    {actionCount} selected
                    {autoRecovery ? " | Auto-recovery ON" : ""}
                </div>

                {displayNodes.length > 0 ? (
                    <DetailsList
                        items={displayNodes}
                        columns={columns}
                        selectionMode={SelectionMode.multiple}
                        selection={selection}
                        checkboxVisibility={CheckboxVisibility.always}
                        layoutMode={DetailsListLayoutMode.fixedColumns}
                        getKey={(item: any) => item.id}
                    />
                ) : (
                    <MessageBar messageBarType={MessageBarType.info}>
                        {state.nodes.length === 0
                            ? 'No nodes loaded. Click "Refresh Nodes" to fetch nodes from all accounts with pools.'
                            : "No nodes match the current filter."}
                    </MessageBar>
                )}
            </Stack>
        </div>
    );
};
