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
import { Dialog, DialogType, DialogFooter } from "@fluentui/react/lib/Dialog";
import { Icon } from "@fluentui/react/lib/Icon";
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

const ERROR_STATES: Set<NodeState> = new Set([
    "starttaskfailed",
    "unusable",
    "unknown",
]);

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

const PAGE_SIZE_OPTIONS: IDropdownOption[] = [
    { key: 25, text: "25" },
    { key: 50, text: "50" },
    { key: 100, text: "100" },
    { key: 200, text: "200" },
];

interface SortConfig {
    key: string;
    isSortedDescending: boolean;
}

interface ConfirmDialogState {
    hidden: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
}

const SKELETON_PULSE_KEYFRAMES = `
@keyframes skeleton-pulse {
    0% { opacity: 0.6; }
    50% { opacity: 1; }
    100% { opacity: 0.6; }
}
`;

function compareValues(a: unknown, b: unknown, desc: boolean): number {
    const aVal = a ?? "";
    const bVal = b ?? "";
    let result = 0;
    if (typeof aVal === "number" && typeof bVal === "number") {
        result = aVal - bVal;
    } else if (typeof aVal === "boolean" && typeof bVal === "boolean") {
        result = aVal === bVal ? 0 : aVal ? -1 : 1;
    } else {
        result = String(aVal).localeCompare(String(bVal), undefined, {
            sensitivity: "base",
        });
    }
    return desc ? -result : result;
}

function SkeletonLoader(): React.ReactElement {
    const colWidths = [180, 100, 160, 110, 120, 100];
    return (
        <>
            <style>{SKELETON_PULSE_KEYFRAMES}</style>
            <div role="status" aria-label="Loading nodes">
                {Array.from({ length: 8 }).map((_, rowIdx) => (
                    <div
                        key={rowIdx}
                        style={{
                            display: "flex",
                            gap: 16,
                            padding: "10px 0",
                            borderBottom: "1px solid #292929",
                        }}
                    >
                        {colWidths.map((w, colIdx) => (
                            <div
                                key={colIdx}
                                style={{
                                    width: w,
                                    height: 16,
                                    background: "#333",
                                    borderRadius: 4,
                                    animation:
                                        "skeleton-pulse 1.5s ease-in-out infinite",
                                    animationDelay: `${rowIdx * 0.05 + colIdx * 0.03}s`,
                                }}
                            />
                        ))}
                    </div>
                ))}
            </div>
        </>
    );
}

const DESTRUCTIVE_ACTIONS: Set<NodeActionType | "deleteNodes" | "recreate"> =
    new Set([
        "reboot",
        "reimage",
        "delete",
        "disableScheduling",
        "deleteNodes",
        "recreate",
    ]);

const ACTION_LABELS: Record<string, string> = {
    reboot: "reboot",
    reimage: "reimage",
    delete: "delete",
    disableScheduling: "disable scheduling on",
    enableScheduling: "enable scheduling on",
    deleteNodes: "delete",
    recreate: "recreate",
};

export const NodesPage: React.FC<NodesPageProps> = ({ orchestrator }) => {
    const state = useMultiRegionState();
    const [isLoading, setIsLoading] = React.useState(false);
    const [isActing, setIsActing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [selectedNodeIds, setSelectedNodeIds] = React.useState<Set<string>>(
        new Set()
    );
    const [selectAll, setSelectAll] = React.useState(false);
    const [selectAllResults, setSelectAllResults] = React.useState(false);
    const [selectedStates, setSelectedStates] = React.useState<string[]>(
        ALL_NODE_STATES.slice()
    );
    const [filterLowPriority, setFilterLowPriority] = React.useState(false);
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [autoRecovery, setAutoRecovery] = React.useState(false);
    const [sortConfig, setSortConfig] = React.useState<SortConfig | null>(null);

    // Pagination state
    const [page, setPage] = React.useState(0);
    const [pageSize, setPageSize] = React.useState(50);

    // Confirmation dialog state
    const [confirmDialog, setConfirmDialog] =
        React.useState<ConfirmDialogState>({
            hidden: true,
            title: "",
            message: "",
            onConfirm: () => {},
        });

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
                } catch (err: unknown) {
                    const message =
                        err instanceof Error ? err.message : String(err);
                    setError(message);
                } finally {
                    setIsLoading(false);
                }
            })();
        }
    }, [createdAccounts.length, state.nodes.length, orchestrator]);

    // --- Summary stats ---
    const summaryStats = React.useMemo(() => {
        const nodes = state.nodes;
        const runningCount = nodes.filter((n) => n.state === "running").length;
        const idleCount = nodes.filter((n) => n.state === "idle").length;
        const preemptedCount = nodes.filter(
            (n) => n.state === "preempted"
        ).length;
        const creatingCount = nodes.filter(
            (n) => n.state === "creating"
        ).length;
        const errorCount = nodes.filter((n) =>
            ERROR_STATES.has(n.state)
        ).length;
        const runningTasks = nodes.reduce(
            (sum, n) => sum + (n.runningTasksCount ?? 0),
            0
        );
        return {
            total: nodes.length,
            runningCount,
            idleCount,
            preemptedCount,
            creatingCount,
            errorCount,
            runningTasks,
        };
    }, [state.nodes]);

    // --- Filtered display nodes ---
    const filteredNodes = React.useMemo(() => {
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

    // --- Sorted display nodes (before pagination) ---
    const sortedNodes = React.useMemo(() => {
        if (!sortConfig) return filteredNodes;

        const { key, isSortedDescending } = sortConfig;
        const sorted = [...filteredNodes];
        sorted.sort((a, b) => {
            const aVal = (a as unknown as Record<string, unknown>)[key];
            const bVal = (b as unknown as Record<string, unknown>)[key];
            return compareValues(aVal, bVal, isSortedDescending);
        });
        return sorted;
    }, [filteredNodes, sortConfig]);

    // Reset page when filter/sort changes
    React.useEffect(() => {
        setPage(0);
        setSelectAll(false);
        setSelectAllResults(false);
        setSelectedNodeIds(new Set());
    }, [selectedStates, filterLowPriority, sortConfig]);

    // --- Pagination ---
    const totalPages = Math.max(1, Math.ceil(sortedNodes.length / pageSize));
    const clampedPage = Math.min(page, totalPages - 1);
    const displayNodes = React.useMemo(() => {
        const start = clampedPage * pageSize;
        return sortedNodes.slice(start, start + pageSize);
    }, [sortedNodes, clampedPage, pageSize]);

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
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
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

    // --- Helper to get selected IDs — selectAll = ALL sorted nodes (all pages) ---
    const getSelectedIds = React.useCallback((): string[] => {
        if (selectAll || selectAllResults) {
            return sortedNodes.map((n) => n.id);
        }
        return Array.from(selectedNodeIds);
    }, [selectAll, selectAllResults, sortedNodes, selectedNodeIds]);

    // --- Show confirmation dialog ---
    const showConfirmation = React.useCallback(
        (
            actionLabel: string,
            count: number,
            onConfirm: () => void,
            extraMessage?: string
        ) => {
            setConfirmDialog({
                hidden: false,
                title: `Confirm ${actionLabel}`,
                message: `Are you sure you want to ${actionLabel} ${count} node${count === 1 ? "" : "s"}?${extraMessage ? " " + extraMessage : ""}`,
                onConfirm,
            });
        },
        []
    );

    const dismissConfirmDialog = React.useCallback(() => {
        setConfirmDialog((prev) => ({ ...prev, hidden: true }));
    }, []);

    const handleNodeAction = React.useCallback(
        async (action: NodeActionType) => {
            const ids = getSelectedIds();
            if (ids.length === 0) return;

            const label = ACTION_LABELS[action] ?? action;

            const executeAction = async () => {
                setIsActing(true);
                setError(null);
                try {
                    // Use bulk_node_action for large selections (calls Batch API
                    // directly per pool instead of one-by-one through the scheduler)
                    await orchestrator.execute({
                        action: "bulk_node_action",
                        payload: {
                            actionType: action,
                            nodeIds: ids,
                        },
                    });
                } catch (err: unknown) {
                    const message =
                        err instanceof Error ? err.message : String(err);
                    setError(message);
                } finally {
                    setIsActing(false);
                }
            };

            if (DESTRUCTIVE_ACTIONS.has(action)) {
                const extra =
                    action === "delete"
                        ? "This action cannot be undone."
                        : action === "reimage"
                          ? "Running tasks will be requeued."
                          : undefined;
                showConfirmation(label, ids.length, executeAction, extra);
            } else {
                await executeAction();
            }
        },
        [orchestrator, getSelectedIds, showConfirmation]
    );

    // --- Bulk delete (grouped by pool) ---
    const handleDeleteNodes = React.useCallback(async () => {
        const ids = getSelectedIds();
        if (ids.length === 0) return;

        // Count unique pools
        const poolSet = new Set<string>();
        for (const id of ids) {
            const node = state.nodes.find((n) => n.id === id);
            if (node) poolSet.add(`${node.accountName}/${node.poolId}`);
        }

        const executeDelete = async () => {
            setIsActing(true);
            setError(null);
            try {
                await orchestrator.execute({
                    action: "delete_nodes",
                    payload: { nodeIds: ids },
                });
            } catch (err: unknown) {
                const message =
                    err instanceof Error ? err.message : String(err);
                setError(message);
            } finally {
                setIsActing(false);
            }
        };

        showConfirmation(
            "delete",
            ids.length,
            executeDelete,
            `This will affect ${poolSet.size} pool(s). This action cannot be undone.`
        );
    }, [orchestrator, getSelectedIds, state.nodes, showConfirmation]);

    // --- Recreate nodes ---
    const handleRecreateNodes = React.useCallback(async () => {
        const ids = getSelectedIds();
        if (ids.length === 0) return;

        const executeRecreate = async () => {
            setIsActing(true);
            setError(null);
            try {
                await orchestrator.execute({
                    action: "recreate_nodes",
                    payload: { nodeIds: ids },
                });
            } catch (err: unknown) {
                const message =
                    err instanceof Error ? err.message : String(err);
                setError(message);
            } finally {
                setIsActing(false);
            }
        };

        showConfirmation(
            "recreate",
            ids.length,
            executeRecreate,
            "Nodes will be removed and pool targets restored to trigger fresh allocation."
        );
    }, [orchestrator, getSelectedIds, showConfirmation]);

    // --- Recover preempted ---
    const handleRecoverPreempted = React.useCallback(async () => {
        const preemptedCount = state.nodes.filter(
            (n) => n.state === "preempted"
        ).length;
        if (preemptedCount === 0) {
            setError("No preempted nodes to recover.");
            return;
        }

        const executeRecover = async () => {
            setIsActing(true);
            setError(null);
            try {
                await orchestrator.execute({
                    action: "recover_preempted",
                    payload: {},
                });
            } catch (err: unknown) {
                const message =
                    err instanceof Error ? err.message : String(err);
                setError(message);
            } finally {
                setIsActing(false);
            }
        };

        showConfirmation(
            "recover",
            preemptedCount,
            executeRecover,
            "This will re-request low-priority capacity for affected pools."
        );
    }, [orchestrator, state.nodes, showConfirmation]);

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

    // --- Column sort handler ---
    const handleColumnClick = React.useCallback(
        (_ev: React.MouseEvent<HTMLElement>, column: IColumn) => {
            const fieldName = column.fieldName ?? column.key;
            setSortConfig((prev) => {
                if (prev && prev.key === fieldName) {
                    return {
                        key: fieldName,
                        isSortedDescending: !prev.isSortedDescending,
                    };
                }
                return { key: fieldName, isSortedDescending: false };
            });
        },
        []
    );

    // --- Columns with sorting and aria-sort ---
    const columns: IColumn[] = React.useMemo(() => {
        const defs: IColumn[] = [
            {
                key: "nodeId",
                name: "Node ID",
                fieldName: "nodeId",
                minWidth: 140,
                maxWidth: 220,
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
                key: "accountName",
                name: "Account",
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
                key: "ipAddress",
                name: "IP Address",
                fieldName: "ipAddress",
                minWidth: 100,
                maxWidth: 140,
                isResizable: true,
                onRender: (item: ManagedNode) => (
                    <span style={{ fontSize: 12 }}>
                        {item.ipAddress ?? "\u2014"}
                    </span>
                ),
            },
            {
                key: "lastBootTime",
                name: "Last Boot Time",
                fieldName: "lastBootTime",
                minWidth: 140,
                maxWidth: 200,
                isResizable: true,
                onRender: (item: ManagedNode) => (
                    <span style={{ fontSize: 12 }}>
                        {item.lastBootTime
                            ? new Date(item.lastBootTime).toLocaleString()
                            : "\u2014"}
                    </span>
                ),
            },
            {
                key: "error",
                name: "Start Task / Error",
                fieldName: "error",
                minWidth: 150,
                maxWidth: 300,
                isResizable: true,
                onRender: (item: ManagedNode) => {
                    if (item.state === "starttaskfailed") {
                        return (
                            <span
                                style={{
                                    color: "#a80000",
                                    fontSize: 12,
                                    fontWeight: 600,
                                }}
                                title={item.error ?? "Start task failed"}
                            >
                                {item.error ?? "Exit code failure"}
                            </span>
                        );
                    }
                    return item.error ? (
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
                    );
                },
            },
        ];

        // Apply sort indicators to all columns
        return defs.map((col) => {
            const fieldName = col.fieldName ?? col.key;
            const isSorted = sortConfig?.key === fieldName;
            return {
                ...col,
                isSorted,
                isSortedDescending: isSorted
                    ? sortConfig!.isSortedDescending
                    : false,
                onColumnClick: handleColumnClick,
                ariaLabel: isSorted
                    ? `${col.name}, sorted ${sortConfig!.isSortedDescending ? "descending" : "ascending"}`
                    : `${col.name}, click to sort`,
            };
        });
    }, [sortConfig, handleColumnClick]);

    const actionCount = selectAll ? sortedNodes.length : selectedNodeIds.size;

    // --- Handle select-all checkbox — selects ALL sorted nodes across ALL pages ---
    const handleSelectAllChange = React.useCallback(
        (
            _ev?: React.FormEvent<HTMLElement | HTMLInputElement>,
            checked?: boolean
        ) => {
            setSelectAll(!!checked);
            setSelectAllResults(!!checked);
            if (checked) {
                // Select ALL filtered/sorted nodes across ALL pages
                setSelectedNodeIds(new Set(sortedNodes.map((n) => n.id)));
            } else {
                setSelectedNodeIds(new Set());
            }
        },
        [sortedNodes]
    );

    // --- Handle page size change ---
    const handlePageSizeChange = React.useCallback(
        (_event: React.FormEvent<HTMLDivElement>, option?: IDropdownOption) => {
            if (!option) return;
            setPageSize(option.key as number);
            setPage(0);
            setSelectAll(false);
            setSelectAllResults(false);
            setSelectedNodeIds(new Set());
        },
        []
    );

    // --- Keyboard handler for rows ---
    const handleRowKeyDown = React.useCallback(
        (ev: React.KeyboardEvent<HTMLDivElement>) => {
            if (ev.key === "Enter") {
                const target = ev.target as HTMLElement;
                const row = target.closest("[data-selection-index]");
                if (row) {
                    const idx = parseInt(
                        row.getAttribute("data-selection-index") ?? "-1",
                        10
                    );
                    if (idx >= 0) {
                        selection.toggleIndexSelected(idx);
                    }
                }
            }
        },
        [selection]
    );

    // --- Summary stat card style ---
    const statCardStyle: React.CSSProperties = {
        background: "#faf9f8",
        border: "1px solid #edebe9",
        borderRadius: 4,
        padding: "8px 14px",
        minWidth: 100,
        textAlign: "center",
    };

    // --- Determine what to render in the list area ---
    const renderContent = () => {
        // Skeleton loader: loading and no nodes at all yet
        if (isLoading && state.nodes.length === 0) {
            return <SkeletonLoader />;
        }

        // Empty state: not loading and no nodes exist
        if (!isLoading && state.nodes.length === 0) {
            return (
                <Stack
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}
                    styles={{ root: { padding: 40 } }}
                >
                    <Icon
                        iconName="Server"
                        styles={{
                            root: { fontSize: 48, color: "#555" },
                        }}
                    />
                    <Text variant="large" styles={{ root: { color: "#888" } }}>
                        No nodes found
                    </Text>
                    <Text variant="small" styles={{ root: { color: "#666" } }}>
                        Nodes will appear after pool discovery
                    </Text>
                </Stack>
            );
        }

        // Filtered empty state
        if (displayNodes.length === 0) {
            return (
                <MessageBar messageBarType={MessageBarType.info}>
                    No nodes match the current filter.
                </MessageBar>
            );
        }

        // Node list with pagination
        return (
            <>
                <div onKeyDown={handleRowKeyDown} role="presentation">
                    <DetailsList
                        items={displayNodes}
                        columns={columns}
                        selectionMode={SelectionMode.none}
                        checkboxVisibility={CheckboxVisibility.hidden}
                        layoutMode={DetailsListLayoutMode.fixedColumns}
                        getKey={(item: ManagedNode) => item.id}
                        onRenderRow={(props, defaultRender) => {
                            if (!props || !defaultRender) return null;
                            const item = props.item as ManagedNode;
                            const isSelected = selectedNodeIds.has(item.id);
                            return (
                                <div aria-selected={isSelected} role="row">
                                    {defaultRender(props)}
                                </div>
                            );
                        }}
                    />
                </div>

                {/* Pagination controls */}
                <Stack
                    horizontal
                    verticalAlign="center"
                    horizontalAlign="center"
                    tokens={{ childrenGap: 16 }}
                    styles={{ root: { padding: "12px 0" } }}
                >
                    <DefaultButton
                        text="< Prev"
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        disabled={clampedPage === 0}
                        aria-label="Previous page"
                    />
                    <Text
                        variant="medium"
                        styles={{ root: { fontWeight: 600 } }}
                    >
                        Page {clampedPage + 1} of {totalPages} (
                        {sortedNodes.length} items)
                    </Text>
                    <DefaultButton
                        text="Next >"
                        onClick={() =>
                            setPage((p) => Math.min(totalPages - 1, p + 1))
                        }
                        disabled={clampedPage >= totalPages - 1}
                        aria-label="Next page"
                    />
                    <Dropdown
                        label="Page size"
                        selectedKey={pageSize}
                        options={PAGE_SIZE_OPTIONS}
                        onChange={handlePageSizeChange}
                        styles={{
                            root: { minWidth: 80 },
                            dropdown: { minWidth: 80 },
                        }}
                    />
                </Stack>
            </>
        );
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
                        aria-live="polite"
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
                            styles={{ root: { color: "#004578" } }}
                        >
                            Running
                        </Text>
                        <Text
                            variant="xLarge"
                            styles={{
                                root: {
                                    fontWeight: 700,
                                    color: "#004578",
                                },
                            }}
                        >
                            {summaryStats.runningCount}
                        </Text>
                    </div>
                    <div style={statCardStyle}>
                        <Text
                            variant="small"
                            block
                            styles={{ root: { color: "#605e5c" } }}
                        >
                            Idle
                        </Text>
                        <Text
                            variant="xLarge"
                            styles={{ root: { fontWeight: 700 } }}
                        >
                            {summaryStats.idleCount}
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
                            styles={{ root: { color: "#0078d4" } }}
                        >
                            Creating
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
                            {summaryStats.creatingCount}
                        </Text>
                    </div>
                    <div style={statCardStyle}>
                        <Text
                            variant="small"
                            block
                            styles={{ root: { color: "#a80000" } }}
                        >
                            Error States
                        </Text>
                        <Text
                            variant="xLarge"
                            styles={{
                                root: {
                                    fontWeight: 700,
                                    color: "#a80000",
                                },
                            }}
                        >
                            {summaryStats.errorCount}
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
                        label={`Select all (${sortedNodes.length})`}
                        checked={selectAll}
                        onChange={handleSelectAllChange}
                        styles={{ root: { marginTop: 24 } }}
                    />
                </Stack>

                {/* Show selection count across all pages */}
                {selectAll && (
                    <div
                        style={{ fontSize: 13, color: "#0078d4" }}
                        aria-live="polite"
                    >
                        All {sortedNodes.length} nodes across all pages
                        selected.{" "}
                        <button
                            onClick={() => {
                                setSelectAll(false);
                                setSelectAllResults(false);
                                setSelectedNodeIds(new Set());
                            }}
                            style={{
                                background: "none",
                                border: "none",
                                color: "#0078d4",
                                cursor: "pointer",
                                textDecoration: "underline",
                                padding: 0,
                                fontSize: 13,
                            }}
                            aria-label="Clear selection"
                        >
                            Clear selection
                        </button>
                    </div>
                )}

                {/* Node Actions */}
                <Stack horizontal tokens={{ childrenGap: 8 }} wrap>
                    <DefaultButton
                        text={`Reboot (${actionCount})`}
                        onClick={() => handleNodeAction("reboot")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "Refresh" }}
                        aria-label={`Reboot ${actionCount} selected nodes`}
                    />
                    <DefaultButton
                        text={`Reimage (${actionCount})`}
                        onClick={() => handleNodeAction("reimage")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "Rebuild" }}
                        aria-label={`Reimage ${actionCount} selected nodes`}
                    />
                    <DefaultButton
                        text={`Disable Scheduling (${actionCount})`}
                        onClick={() => handleNodeAction("disableScheduling")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "CirclePause" }}
                        aria-label={`Disable scheduling on ${actionCount} selected nodes`}
                    />
                    <DefaultButton
                        text={`Enable Scheduling (${actionCount})`}
                        onClick={() => handleNodeAction("enableScheduling")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "Play" }}
                        aria-label={`Enable scheduling on ${actionCount} selected nodes`}
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
                        aria-label={`Delete ${actionCount} selected nodes`}
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
                        aria-label={`Recreate ${actionCount} selected nodes`}
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
                        aria-label={`Recover ${summaryStats.preemptedCount} preempted nodes`}
                    />
                </Stack>

                {(isLoading || isActing) && (
                    <ProgressIndicator
                        label={
                            isLoading
                                ? "Loading nodes..."
                                : "Performing action..."
                        }
                        aria-live="polite"
                    />
                )}

                <div
                    style={{ fontSize: 13, color: "#605e5c" }}
                    role="status"
                    aria-live="polite"
                >
                    {sortedNodes.length} nodes
                    {selectedStates.length < ALL_NODE_STATES.length
                        ? ` (filtered: ${selectedStates.join(", ")})`
                        : ""}
                    {filterLowPriority ? " (low-priority only)" : ""}
                    {" | "}
                    {actionCount} selected
                    {autoRecovery ? " | Auto-recovery ON" : ""}
                </div>

                {renderContent()}
            </Stack>

            {/* Confirmation Dialog */}
            <Dialog
                hidden={confirmDialog.hidden}
                onDismiss={dismissConfirmDialog}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: confirmDialog.title,
                    subText: confirmDialog.message,
                }}
                modalProps={{ isBlocking: true }}
            >
                <DialogFooter>
                    <PrimaryButton
                        text="Confirm"
                        onClick={() => {
                            dismissConfirmDialog();
                            confirmDialog.onConfirm();
                        }}
                    />
                    <DefaultButton
                        text="Cancel"
                        onClick={dismissConfirmDialog}
                    />
                </DialogFooter>
            </Dialog>
        </div>
    );
};
