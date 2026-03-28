import * as React from "react";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    Selection,
    SelectionMode,
    CheckboxVisibility,
} from "@fluentui/react/lib/DetailsList";
import {
    PrimaryButton,
    DefaultButton,
    IconButton,
} from "@fluentui/react/lib/Button";
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
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { PoolInfo } from "../../store/store-types";
import { StatusBadge } from "../shared/status-badge";
import { getVCpus } from "../shared/vm-sizes";

export interface PoolInfoPageProps {
    orchestrator: OrchestratorAgent;
}

interface EnvVar {
    name: string;
    value: string;
}

type SortKey =
    | "poolId"
    | "accountName"
    | "region"
    | "vmSize"
    | "state"
    | "allocationState"
    | "dedicated"
    | "lowPriority"
    | "taskSlots"
    | "autoScale"
    | "resizeErrors"
    | "created";

export const PoolInfoPage: React.FC<PoolInfoPageProps> = ({ orchestrator }) => {
    const state = useMultiRegionState();
    const [loading, setLoading] = React.useState(false);
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(
        null
    );

    // Selection state (multiple)
    const [selectedPools, setSelectedPools] = React.useState<PoolInfo[]>([]);

    const selection = React.useMemo(
        () =>
            new Selection({
                onSelectionChanged: () => {
                    const selected = selection.getSelection() as PoolInfo[];
                    setSelectedPools(selected);
                },
                getKey: (item: any) => item.id,
            }),
        []
    );

    // Sort state
    const [sortKey, setSortKey] = React.useState<SortKey | null>(null);
    const [sortDescending, setSortDescending] = React.useState(false);

    // Filter state
    const [searchText, setSearchText] = React.useState("");
    const [filterRegions, setFilterRegions] = React.useState<string[]>([]);
    const [filterVmSizes, setFilterVmSizes] = React.useState<string[]>([]);
    const [filterAllocationState, setFilterAllocationState] =
        React.useState<string>("all");
    const [filterState, setFilterState] = React.useState<string>("all");

    // Resize dialog state
    const [showResizeDialog, setShowResizeDialog] = React.useState(false);
    const [resizeDedicated, setResizeDedicated] = React.useState(0);
    const [resizeLowPriority, setResizeLowPriority] = React.useState(0);
    const [resizeSubmitting, setResizeSubmitting] = React.useState(false);

    // Start task dialog state
    const [showStartTaskDialog, setShowStartTaskDialog] = React.useState(false);
    const [startTaskCommandLine, setStartTaskCommandLine] = React.useState("");
    const [startTaskEnvVars, setStartTaskEnvVars] = React.useState<EnvVar[]>(
        []
    );
    const [startTaskMaxRetryCount, setStartTaskMaxRetryCount] =
        React.useState(3);
    const [startTaskWaitForSuccess, setStartTaskWaitForSuccess] =
        React.useState(true);
    const [startTaskError, setStartTaskError] = React.useState<string | null>(
        null
    );
    const [startTaskSubmitting, setStartTaskSubmitting] = React.useState(false);

    // Remove empty pools dialog state
    const [showDeleteEmptyDialog, setShowDeleteEmptyDialog] =
        React.useState(false);
    const [deleteEmptySubmitting, setDeleteEmptySubmitting] =
        React.useState(false);

    // Pagination state
    const [page, setPage] = React.useState(0);
    const [pageSize, setPageSize] = React.useState(25);

    // Error state
    const [error, setError] = React.useState<Error | null>(null);

    const refresh = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "refresh_pool_info",
                payload: {},
            });
        } catch (err) {
            setError(
                err instanceof Error ? err : new Error("Unknown error occurred")
            );
        } finally {
            setLoading(false);
        }
    }, [orchestrator]);

    const stop = React.useCallback(() => {
        setLoading(false);
        setAutoRefresh(false);
    }, []);

    // Auto-refresh (30s)
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

    // Auto-load on mount if poolInfos is empty
    React.useEffect(() => {
        if (state.poolInfos.length === 0 && state.accounts.length > 0) {
            refresh();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const pools = state.poolInfos;

    // Unique values for filter dropdowns
    const uniqueRegions = React.useMemo(
        () => [...new Set(pools.map((p) => p.region))].sort(),
        [pools]
    );
    const uniqueVmSizes = React.useMemo(
        () => [...new Set(pools.map((p) => p.vmSize))].sort(),
        [pools]
    );

    const regionOptions: IDropdownOption[] = React.useMemo(
        () => uniqueRegions.map((r) => ({ key: r, text: r })),
        [uniqueRegions]
    );
    const vmSizeOptions: IDropdownOption[] = React.useMemo(
        () => uniqueVmSizes.map((v) => ({ key: v, text: v })),
        [uniqueVmSizes]
    );
    const allocationStateOptions: IDropdownOption[] = [
        { key: "all", text: "All" },
        { key: "steady", text: "Steady" },
        { key: "resizing", text: "Resizing" },
        { key: "stopping", text: "Stopping" },
    ];
    const stateOptions: IDropdownOption[] = [
        { key: "all", text: "All" },
        { key: "active", text: "Active" },
        { key: "deleting", text: "Deleting" },
    ];

    // Apply filters
    const filteredPools = React.useMemo(() => {
        let result = pools;

        if (searchText.trim()) {
            const lower = searchText.toLowerCase();
            result = result.filter(
                (p) =>
                    p.poolId.toLowerCase().includes(lower) ||
                    p.accountName.toLowerCase().includes(lower) ||
                    p.region.toLowerCase().includes(lower) ||
                    p.vmSize.toLowerCase().includes(lower) ||
                    p.state.toLowerCase().includes(lower) ||
                    p.allocationState.toLowerCase().includes(lower)
            );
        }

        if (filterRegions.length > 0) {
            result = result.filter((p) => filterRegions.includes(p.region));
        }

        if (filterVmSizes.length > 0) {
            result = result.filter((p) => filterVmSizes.includes(p.vmSize));
        }

        if (filterAllocationState !== "all") {
            result = result.filter(
                (p) => p.allocationState === filterAllocationState
            );
        }

        if (filterState !== "all") {
            result = result.filter((p) => p.state === filterState);
        }

        return result;
    }, [
        pools,
        searchText,
        filterRegions,
        filterVmSizes,
        filterAllocationState,
        filterState,
    ]);

    // Apply sorting
    const sortedPools = React.useMemo(() => {
        if (!sortKey) return filteredPools;

        const sorted = [...filteredPools];
        const dir = sortDescending ? -1 : 1;

        sorted.sort((a, b) => {
            let aVal: string | number = "";
            let bVal: string | number = "";

            switch (sortKey) {
                case "poolId":
                    aVal = a.poolId;
                    bVal = b.poolId;
                    break;
                case "accountName":
                    aVal = a.accountName;
                    bVal = b.accountName;
                    break;
                case "region":
                    aVal = a.region;
                    bVal = b.region;
                    break;
                case "vmSize":
                    aVal = a.vmSize;
                    bVal = b.vmSize;
                    break;
                case "state":
                    aVal = a.state;
                    bVal = b.state;
                    break;
                case "allocationState":
                    aVal = a.allocationState;
                    bVal = b.allocationState;
                    break;
                case "dedicated":
                    aVal = a.currentDedicatedNodes;
                    bVal = b.currentDedicatedNodes;
                    break;
                case "lowPriority":
                    aVal = a.currentLowPriorityNodes;
                    bVal = b.currentLowPriorityNodes;
                    break;
                case "taskSlots":
                    aVal = a.taskSlotsPerNode;
                    bVal = b.taskSlotsPerNode;
                    break;
                case "autoScale":
                    aVal = a.enableAutoScale ? 1 : 0;
                    bVal = b.enableAutoScale ? 1 : 0;
                    break;
                case "resizeErrors":
                    aVal = a.resizeErrors?.length ?? 0;
                    bVal = b.resizeErrors?.length ?? 0;
                    break;
                case "created":
                    aVal = a.creationTime ?? "";
                    bVal = b.creationTime ?? "";
                    break;
            }

            if (typeof aVal === "number" && typeof bVal === "number") {
                return (aVal - bVal) * dir;
            }
            return String(aVal).localeCompare(String(bVal)) * dir;
        });

        return sorted;
    }, [filteredPools, sortKey, sortDescending]);

    // Reset page when filters/sort change
    React.useEffect(() => {
        setPage(0);
    }, [
        searchText,
        filterRegions,
        filterVmSizes,
        filterAllocationState,
        filterState,
        sortKey,
        sortDescending,
    ]);

    // Paginated pools
    const totalPages = Math.max(1, Math.ceil(sortedPools.length / pageSize));
    const paginatedPools = React.useMemo(
        () => sortedPools.slice(page * pageSize, (page + 1) * pageSize),
        [sortedPools, page, pageSize]
    );

    // Empty pools for removal
    const emptyPools = React.useMemo(
        () =>
            pools.filter(
                (p) =>
                    p.currentDedicatedNodes === 0 &&
                    p.currentLowPriorityNodes === 0
            ),
        [pools]
    );

    const submitDeleteEmptyPools = async () => {
        setDeleteEmptySubmitting(true);
        try {
            await Promise.allSettled(
                emptyPools.map((pool) =>
                    orchestrator.execute({
                        action: "delete_pool",
                        payload: {
                            accountId: pool.accountId,
                            poolId: pool.poolId,
                        },
                    })
                )
            );
            setShowDeleteEmptyDialog(false);
        } catch {
            /* handled by orchestrator */
        } finally {
            setDeleteEmptySubmitting(false);
        }
    };

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

    // Selected pool (first selected for single-pool actions)
    const selectedPool = selectedPools.length > 0 ? selectedPools[0] : null;

    // Get LP quota info for selected pool
    const getAccountInfoForPool = (pool: PoolInfo | null) => {
        if (!pool) return null;
        return state.accountInfos.find((a) => a.id === pool.accountId) ?? null;
    };

    const selectedAccountInfo = getAccountInfoForPool(selectedPool);

    // Resize dialog handlers
    const openResizeDialog = () => {
        if (!selectedPool) return;
        const acctInfo = getAccountInfoForPool(selectedPool);
        const freeLpCores = acctInfo?.lowPriorityCoresFree ?? 0;
        const vmVCpus = getVCpus(selectedPool.vmSize);
        const maxLpNodes = Math.floor(freeLpCores / vmVCpus);

        setResizeDedicated(0);
        setResizeLowPriority(maxLpNodes);
        setShowResizeDialog(true);
    };

    const getMaxLpNodes = (): number => {
        if (!selectedPool) return 0;
        const acctInfo = getAccountInfoForPool(selectedPool);
        const freeLpCores = acctInfo?.lowPriorityCoresFree ?? 0;
        const vmVCpus = getVCpus(selectedPool.vmSize);
        return Math.floor(freeLpCores / vmVCpus);
    };

    const submitResize = async () => {
        if (selectedPools.length === 0) return;
        setResizeSubmitting(true);
        try {
            // Apply resize to ALL selected pools, not just the first one
            await Promise.allSettled(
                selectedPools.map((pool) =>
                    orchestrator.execute({
                        action: "resize_pool",
                        payload: {
                            accountId: pool.accountId,
                            poolId: pool.poolId,
                            targetDedicatedNodes: resizeDedicated,
                            targetLowPriorityNodes: resizeLowPriority,
                        },
                    })
                )
            );
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
        const existing = selectedPool.startTask || {};
        setStartTaskCommandLine((existing.commandLine as string) ?? "");
        const envSettings =
            (existing.environmentSettings as Array<{
                name: string;
                value: string;
            }>) ?? [];
        setStartTaskEnvVars(
            envSettings.length > 0
                ? envSettings.map((e) => ({ name: e.name, value: e.value }))
                : [{ name: "", value: "" }]
        );
        setStartTaskMaxRetryCount((existing.maxTaskRetryCount as number) ?? 3);
        setStartTaskWaitForSuccess(
            (existing.waitForSuccess as boolean) ?? true
        );
        setStartTaskError(null);
        setShowStartTaskDialog(true);
    };

    const addEnvVar = () => {
        setStartTaskEnvVars((prev) => [...prev, { name: "", value: "" }]);
    };

    const removeEnvVar = (index: number) => {
        setStartTaskEnvVars((prev) => prev.filter((_, i) => i !== index));
    };

    const updateEnvVar = (
        index: number,
        field: "name" | "value",
        val: string
    ) => {
        setStartTaskEnvVars((prev) =>
            prev.map((ev, i) => (i === index ? { ...ev, [field]: val } : ev))
        );
    };

    const submitStartTask = async () => {
        if (!selectedPool) return;
        if (!startTaskCommandLine.trim()) {
            setStartTaskError("Command line is required");
            return;
        }

        const envSettings = startTaskEnvVars
            .filter((ev) => ev.name.trim() !== "")
            .map((ev) => ({ name: ev.name, value: ev.value }));

        const startTaskPayload: Record<string, unknown> = {
            commandLine: startTaskCommandLine,
            maxTaskRetryCount: startTaskMaxRetryCount,
            waitForSuccess: startTaskWaitForSuccess,
        };
        if (envSettings.length > 0) {
            startTaskPayload.environmentSettings = envSettings;
        }

        setStartTaskError(null);
        setStartTaskSubmitting(true);
        try {
            // Apply start task update to ALL selected pools
            await Promise.allSettled(
                selectedPools.map((pool) =>
                    orchestrator.execute({
                        action: "update_start_task",
                        payload: {
                            accountId: pool.accountId,
                            poolId: pool.poolId,
                            startTask: startTaskPayload,
                        },
                    })
                )
            );
            setShowStartTaskDialog(false);
        } catch {
            /* handled by orchestrator */
        } finally {
            setStartTaskSubmitting(false);
        }
    };

    // Column sort handler
    const handleColumnClick = (
        _ev?: React.MouseEvent<HTMLElement>,
        column?: IColumn
    ) => {
        if (!column?.data?.sortKey) return;
        const key = column.data.sortKey as SortKey;
        if (sortKey === key) {
            setSortDescending(!sortDescending);
        } else {
            setSortKey(key);
            setSortDescending(false);
        }
    };

    // Select All handler
    const handleSelectAll = (_ev?: React.FormEvent, checked?: boolean) => {
        if (checked) {
            selection.setAllSelected(true);
        } else {
            selection.setAllSelected(false);
        }
    };

    const columns: IColumn[] = React.useMemo(
        () => [
            {
                key: "poolId",
                name: "Pool ID",
                minWidth: 120,
                maxWidth: 200,
                isResizable: true,
                isSorted: sortKey === "poolId",
                isSortedDescending: sortKey === "poolId" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "poolId" },
                ariaLabel: "Pool ID, sortable column",
                onRender: (item: PoolInfo) => (
                    <span
                        title={item.poolId}
                        style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {item.poolId}
                    </span>
                ),
            },
            {
                key: "accountName",
                name: "Account",
                minWidth: 100,
                maxWidth: 160,
                isResizable: true,
                isSorted: sortKey === "accountName",
                isSortedDescending: sortKey === "accountName" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "accountName" },
                ariaLabel: "Account name, sortable column",
                onRender: (item: PoolInfo) => (
                    <span
                        title={item.accountName}
                        style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {item.accountName}
                    </span>
                ),
            },
            {
                key: "region",
                name: "Region",
                fieldName: "region",
                minWidth: 80,
                maxWidth: 120,
                isResizable: true,
                isSorted: sortKey === "region",
                isSortedDescending: sortKey === "region" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "region" },
                ariaLabel: "Region, sortable column",
            },
            {
                key: "vmSize",
                name: "VM Size",
                minWidth: 100,
                maxWidth: 160,
                isResizable: true,
                isSorted: sortKey === "vmSize",
                isSortedDescending: sortKey === "vmSize" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "vmSize" },
                ariaLabel: "VM Size, sortable column",
                onRender: (item: PoolInfo) => (
                    <span
                        title={item.vmSize}
                        style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {item.vmSize}
                    </span>
                ),
            },
            {
                key: "state",
                name: "State",
                minWidth: 70,
                maxWidth: 100,
                isResizable: true,
                isSorted: sortKey === "state",
                isSortedDescending: sortKey === "state" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "state" },
                ariaLabel: "State, sortable column",
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
                isSorted: sortKey === "allocationState",
                isSortedDescending:
                    sortKey === "allocationState" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "allocationState" },
                ariaLabel: "Allocation state, sortable column",
            },
            {
                key: "dedicated",
                name: "Dedicated",
                minWidth: 80,
                maxWidth: 110,
                isResizable: true,
                isSorted: sortKey === "dedicated",
                isSortedDescending: sortKey === "dedicated" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "dedicated" },
                ariaLabel: "Dedicated nodes, sortable column",
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
                isSorted: sortKey === "lowPriority",
                isSortedDescending: sortKey === "lowPriority" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "lowPriority" },
                ariaLabel: "Low priority nodes, sortable column",
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
                isSorted: sortKey === "taskSlots",
                isSortedDescending: sortKey === "taskSlots" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "taskSlots" },
                ariaLabel: "Task slots per node, sortable column",
            },
            {
                key: "autoScale",
                name: "Auto Scale",
                minWidth: 60,
                maxWidth: 80,
                isResizable: true,
                isSorted: sortKey === "autoScale",
                isSortedDescending: sortKey === "autoScale" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "autoScale" },
                ariaLabel: "Auto scale enabled, sortable column",
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
                isSorted: sortKey === "resizeErrors",
                isSortedDescending:
                    sortKey === "resizeErrors" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "resizeErrors" },
                ariaLabel: "Resize errors count, sortable column",
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
                isSorted: sortKey === "created",
                isSortedDescending: sortKey === "created" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "created" },
                ariaLabel: "Creation time, sortable column",
                onRender: (item: PoolInfo) =>
                    item.creationTime
                        ? new Date(item.creationTime).toLocaleString()
                        : "\u2014",
            },
        ],
        [sortKey, sortDescending]
    );

    return (
        <div style={{ padding: "16px 0" }}>
            {/* Header */}
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
                    aria-label="Refresh pools"
                />
                {loading && (
                    <span role="status" aria-live="polite">
                        <Stack
                            horizontal
                            verticalAlign="center"
                            tokens={{ childrenGap: 8 }}
                        >
                            <Spinner size={SpinnerSize.small} />
                            <DefaultButton
                                text="Stop"
                                iconProps={{ iconName: "Stop" }}
                                onClick={stop}
                                aria-label="Stop refreshing"
                                styles={{
                                    root: {
                                        borderColor: "#d13438",
                                        color: "#d13438",
                                    },
                                }}
                            />
                        </Stack>
                    </span>
                )}
                <PrimaryButton
                    text="Resize Pool"
                    iconProps={{ iconName: "ScaleVolume" }}
                    onClick={openResizeDialog}
                    disabled={!selectedPool}
                    aria-label="Resize selected pools"
                />
                <DefaultButton
                    text="Update Start Task"
                    iconProps={{ iconName: "Play" }}
                    onClick={openStartTaskDialog}
                    disabled={!selectedPool}
                    aria-label="Update start task for selected pools"
                />
                <DefaultButton
                    text="Remove Empty Pools"
                    iconProps={{ iconName: "Delete" }}
                    onClick={() => setShowDeleteEmptyDialog(true)}
                    disabled={emptyPools.length === 0 || loading}
                    aria-label="Remove empty pools"
                    styles={{
                        root: {
                            borderColor: "#d13438",
                            color: "#d13438",
                        },
                    }}
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

            {/* Filter Bar */}
            <Stack
                horizontal
                verticalAlign="end"
                tokens={{ childrenGap: 12 }}
                wrap
                styles={{
                    root: {
                        padding: "12px 16px",
                        background: "#1e1e1e",
                        borderRadius: 6,
                        marginBottom: 12,
                    },
                }}
            >
                <TextField
                    placeholder="Search across all columns..."
                    iconProps={{ iconName: "Search" }}
                    value={searchText}
                    onChange={(_e, val) => setSearchText(val ?? "")}
                    styles={{
                        root: { width: 220 },
                        field: { fontSize: 13 },
                    }}
                />
                <Dropdown
                    placeholder="Region"
                    multiSelect
                    options={regionOptions}
                    selectedKeys={filterRegions}
                    onChange={(_e, option) => {
                        if (!option) return;
                        setFilterRegions((prev) =>
                            option.selected
                                ? [...prev, option.key as string]
                                : prev.filter((r) => r !== option.key)
                        );
                    }}
                    styles={{
                        root: { width: 160 },
                        dropdown: { fontSize: 13 },
                    }}
                />
                <Dropdown
                    placeholder="VM Size"
                    multiSelect
                    options={vmSizeOptions}
                    selectedKeys={filterVmSizes}
                    onChange={(_e, option) => {
                        if (!option) return;
                        setFilterVmSizes((prev) =>
                            option.selected
                                ? [...prev, option.key as string]
                                : prev.filter((v) => v !== option.key)
                        );
                    }}
                    styles={{
                        root: { width: 180 },
                        dropdown: { fontSize: 13 },
                    }}
                />
                <Dropdown
                    placeholder="Allocation State"
                    options={allocationStateOptions}
                    selectedKey={filterAllocationState}
                    onChange={(_e, option) =>
                        setFilterAllocationState(
                            (option?.key as string) ?? "all"
                        )
                    }
                    styles={{
                        root: { width: 150 },
                        dropdown: { fontSize: 13 },
                    }}
                />
                <Dropdown
                    placeholder="State"
                    options={stateOptions}
                    selectedKey={filterState}
                    onChange={(_e, option) =>
                        setFilterState((option?.key as string) ?? "all")
                    }
                    styles={{
                        root: { width: 120 },
                        dropdown: { fontSize: 13 },
                    }}
                />
                {(searchText ||
                    filterRegions.length > 0 ||
                    filterVmSizes.length > 0 ||
                    filterAllocationState !== "all" ||
                    filterState !== "all") && (
                    <DefaultButton
                        text="Clear Filters"
                        iconProps={{ iconName: "ClearFilter" }}
                        aria-label="Clear all filters"
                        onClick={() => {
                            setSearchText("");
                            setFilterRegions([]);
                            setFilterVmSizes([]);
                            setFilterAllocationState("all");
                            setFilterState("all");
                        }}
                        styles={{ root: { fontSize: 12 } }}
                    />
                )}
            </Stack>

            {/* Summary Stats */}
            <Stack
                horizontal
                tokens={{ childrenGap: 24 }}
                role="status"
                aria-live="polite"
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
                {filteredPools.length !== pools.length && (
                    <SummaryStatItem
                        icon="Filter"
                        label="Showing"
                        value={filteredPools.length}
                        color="#999"
                    />
                )}
            </Stack>

            {/* Error state */}
            {error && (
                <MessageBar messageBarType={MessageBarType.error} isMultiline>
                    Failed to load pool information: {error.message}
                    <DefaultButton
                        text="Retry"
                        onClick={refresh}
                        aria-label="Retry loading pools"
                        styles={{ root: { marginLeft: 8 } }}
                    />
                </MessageBar>
            )}

            {/* Skeleton loader */}
            {loading && pools.length === 0 && !error && (
                <div
                    style={{
                        background: "#1e1e1e",
                        borderRadius: 6,
                        padding: 8,
                    }}
                >
                    <style>{`
                        @keyframes pulse {
                            0%, 100% { opacity: 0.4; }
                            50% { opacity: 1; }
                        }
                    `}</style>
                    {[0, 1, 2, 3, 4].map((row) => (
                        <div
                            key={row}
                            style={{
                                display: "flex",
                                gap: 12,
                                padding: "10px 8px",
                                borderBottom: "1px solid #2a2a2a",
                            }}
                        >
                            {[
                                120, 100, 80, 100, 70, 90, 80, 80, 60, 60, 80,
                                120,
                            ].map((width, col) => (
                                <div
                                    key={col}
                                    style={{
                                        width,
                                        height: 16,
                                        borderRadius: 4,
                                        background: "#333",
                                        animation:
                                            "pulse 1.5s ease-in-out infinite",
                                        animationDelay: `${row * 0.1 + col * 0.05}s`,
                                    }}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            )}

            {/* Empty state */}
            {!loading && !error && pools.length === 0 && (
                <Stack
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}
                    styles={{ root: { padding: 40 } }}
                >
                    <Icon
                        iconName="BuildQueue"
                        styles={{ root: { fontSize: 48, color: "#555" } }}
                    />
                    <Text variant="large" styles={{ root: { color: "#888" } }}>
                        No pools found
                    </Text>
                    <Text variant="small" styles={{ root: { color: "#666" } }}>
                        Pools will appear here after discovery
                    </Text>
                </Stack>
            )}

            {/* Select All + DetailsList */}
            {pools.length > 0 && (
                <div
                    style={{
                        background: "#1e1e1e",
                        borderRadius: 6,
                        padding: 8,
                    }}
                >
                    <Stack
                        horizontal
                        verticalAlign="center"
                        tokens={{ childrenGap: 8 }}
                        styles={{ root: { padding: "4px 8px" } }}
                    >
                        <Checkbox
                            label={`Select All (${filteredPools.length})`}
                            onChange={handleSelectAll}
                            checked={
                                filteredPools.length > 0 &&
                                selectedPools.length === filteredPools.length
                            }
                            styles={{
                                label: { color: "#999", fontSize: 12 },
                            }}
                        />
                        {selectedPools.length > 0 && (
                            <Text
                                variant="small"
                                styles={{ root: { color: "#0078d4" } }}
                            >
                                {selectedPools.length} selected
                            </Text>
                        )}
                    </Stack>
                    <DetailsList
                        items={paginatedPools}
                        columns={columns}
                        layoutMode={DetailsListLayoutMode.fixedColumns}
                        selectionMode={SelectionMode.multiple}
                        selection={selection}
                        checkboxVisibility={CheckboxVisibility.always}
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

                    {/* Pagination */}
                    <Stack
                        horizontal
                        verticalAlign="center"
                        horizontalAlign="space-between"
                        tokens={{ childrenGap: 12 }}
                        styles={{
                            root: {
                                padding: "8px 8px 4px",
                                borderTop: "1px solid #2a2a2a",
                                marginTop: 4,
                            },
                        }}
                    >
                        <Stack
                            horizontal
                            verticalAlign="center"
                            tokens={{ childrenGap: 8 }}
                        >
                            <Text
                                variant="small"
                                styles={{ root: { color: "#999" } }}
                            >
                                Page size:
                            </Text>
                            <Dropdown
                                selectedKey={pageSize}
                                options={[
                                    { key: 10, text: "10" },
                                    { key: 25, text: "25" },
                                    { key: 50, text: "50" },
                                    { key: 100, text: "100" },
                                ]}
                                onChange={(_e, option) => {
                                    if (option) {
                                        setPageSize(option.key as number);
                                        setPage(0);
                                    }
                                }}
                                styles={{
                                    root: { width: 70 },
                                    dropdown: { fontSize: 12 },
                                }}
                            />
                        </Stack>
                        <Stack
                            horizontal
                            verticalAlign="center"
                            tokens={{ childrenGap: 8 }}
                        >
                            <DefaultButton
                                text="< Prev"
                                onClick={() =>
                                    setPage((p) => Math.max(0, p - 1))
                                }
                                disabled={page === 0}
                                aria-label="Previous page"
                                styles={{
                                    root: { minWidth: 60, fontSize: 12 },
                                }}
                            />
                            <Text
                                variant="small"
                                styles={{ root: { color: "#ccc" } }}
                                role="status"
                                aria-live="polite"
                            >
                                Page {page + 1} of {totalPages}
                            </Text>
                            <DefaultButton
                                text="Next >"
                                onClick={() =>
                                    setPage((p) =>
                                        Math.min(totalPages - 1, p + 1)
                                    )
                                }
                                disabled={page >= totalPages - 1}
                                aria-label="Next page"
                                styles={{
                                    root: { minWidth: 60, fontSize: 12 },
                                }}
                            />
                        </Stack>
                        <Text
                            variant="tiny"
                            styles={{ root: { color: "#888" } }}
                            role="status"
                            aria-live="polite"
                        >
                            {sortedPools.length} total items
                        </Text>
                    </Stack>
                </div>
            )}

            {/* Remove Empty Pools Dialog */}
            <Dialog
                hidden={!showDeleteEmptyDialog}
                onDismiss={() => setShowDeleteEmptyDialog(false)}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: `Remove ${emptyPools.length} empty pools?`,
                    subText: "This action cannot be undone.",
                }}
                modalProps={{
                    isBlocking: true,
                    styles: { main: { minWidth: 480 } },
                }}
            >
                <Stack
                    tokens={{ childrenGap: 4 }}
                    styles={{ root: { maxHeight: 200, overflowY: "auto" } }}
                >
                    {emptyPools.slice(0, 10).map((pool) => (
                        <Text
                            key={pool.id}
                            variant="small"
                            styles={{ root: { color: "#ccc" } }}
                        >
                            {pool.poolId} ({pool.accountName} / {pool.region})
                        </Text>
                    ))}
                    {emptyPools.length > 10 && (
                        <Text
                            variant="small"
                            styles={{
                                root: { color: "#888", fontStyle: "italic" },
                            }}
                        >
                            and {emptyPools.length - 10} more...
                        </Text>
                    )}
                </Stack>
                <DialogFooter>
                    <PrimaryButton
                        text={deleteEmptySubmitting ? "Deleting..." : "Remove"}
                        onClick={submitDeleteEmptyPools}
                        disabled={deleteEmptySubmitting}
                        aria-label="Confirm remove empty pools"
                        styles={{
                            root: {
                                backgroundColor: "#d13438",
                                borderColor: "#d13438",
                            },
                            rootHovered: {
                                backgroundColor: "#a4262c",
                                borderColor: "#a4262c",
                            },
                        }}
                    />
                    <DefaultButton
                        text="Cancel"
                        onClick={() => setShowDeleteEmptyDialog(false)}
                        disabled={deleteEmptySubmitting}
                    />
                </DialogFooter>
            </Dialog>

            {/* Resize Pool Dialog */}
            <Dialog
                hidden={!showResizeDialog}
                onDismiss={() => setShowResizeDialog(false)}
                dialogContentProps={{
                    type: DialogType.normal,
                    title:
                        selectedPools.length > 1
                            ? `Resize ${selectedPools.length} Pools`
                            : "Resize Pool",
                    subText:
                        selectedPools.length > 1
                            ? `Apply the same resize to all ${selectedPools.length} selected pools.`
                            : "Adjust the target node counts for this pool.",
                }}
                modalProps={{
                    isBlocking: true,
                    styles: {
                        main: { minWidth: 520 },
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

                        {/* Quota info */}
                        <MessageBar messageBarType={MessageBarType.info}>
                            <Stack tokens={{ childrenGap: 4 }}>
                                <span>
                                    <b>LP Quota:</b>{" "}
                                    {selectedAccountInfo?.lowPriorityCoreQuota ??
                                        "N/A"}{" "}
                                    cores | <b>LP Free:</b>{" "}
                                    {selectedAccountInfo?.lowPriorityCoresFree ??
                                        "N/A"}{" "}
                                    cores
                                </span>
                                <span>
                                    <b>VM vCPUs:</b>{" "}
                                    {getVCpus(selectedPool.vmSize)} |{" "}
                                    <b>Max LP Nodes:</b> {getMaxLpNodes()}
                                </span>
                            </Stack>
                        </MessageBar>

                        <SpinButton
                            label="Target Dedicated Nodes"
                            min={0}
                            step={1}
                            value={String(resizeDedicated)}
                            disabled
                            styles={{
                                root: { opacity: 0.6 },
                            }}
                        />
                        <Text
                            variant="tiny"
                            styles={{
                                root: {
                                    color: "#888",
                                    fontStyle: "italic",
                                    marginTop: -8,
                                },
                            }}
                        >
                            Dedicated nodes always set to 0 (read-only)
                        </Text>

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

                        {resizeLowPriority > getMaxLpNodes() && (
                            <MessageBar messageBarType={MessageBarType.warning}>
                                Requested {resizeLowPriority} nodes exceeds the
                                max available ({getMaxLpNodes()}) based on free
                                LP quota. The resize may partially fail.
                            </MessageBar>
                        )}
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
                    title:
                        selectedPools.length > 1
                            ? `Update Start Task (${selectedPools.length} Pools)`
                            : "Update Start Task",
                    subText:
                        selectedPools.length > 1
                            ? `Apply the same start task to all ${selectedPools.length} selected pools.`
                            : selectedPool
                              ? `Pool: ${selectedPool.poolId} (${selectedPool.accountName})`
                              : "",
                }}
                modalProps={{
                    isBlocking: true,
                    styles: {
                        main: { minWidth: 600, maxWidth: 700 },
                    },
                }}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    {/* Command Line */}
                    <TextField
                        label="Command Line"
                        value={startTaskCommandLine}
                        onChange={(_e, val) => {
                            setStartTaskCommandLine(val ?? "");
                            setStartTaskError(null);
                        }}
                        placeholder="/bin/bash -c 'echo hello'"
                        styles={{
                            field: {
                                fontFamily:
                                    "'Consolas', 'Courier New', monospace",
                                fontSize: 13,
                            },
                        }}
                    />

                    {/* Environment Variables */}
                    <Label>Environment Variables</Label>
                    <Stack tokens={{ childrenGap: 6 }}>
                        {startTaskEnvVars.map((ev, idx) => (
                            <Stack
                                key={idx}
                                horizontal
                                verticalAlign="end"
                                tokens={{ childrenGap: 8 }}
                            >
                                <TextField
                                    placeholder="Name"
                                    value={ev.name}
                                    onChange={(_e, val) =>
                                        updateEnvVar(idx, "name", val ?? "")
                                    }
                                    styles={{ root: { width: 180 } }}
                                />
                                <TextField
                                    placeholder="Value"
                                    value={ev.value}
                                    onChange={(_e, val) =>
                                        updateEnvVar(idx, "value", val ?? "")
                                    }
                                    styles={{ root: { flex: 1 } }}
                                />
                                <IconButton
                                    iconProps={{ iconName: "Delete" }}
                                    title="Remove"
                                    onClick={() => removeEnvVar(idx)}
                                    styles={{
                                        root: { height: 32, width: 32 },
                                    }}
                                />
                            </Stack>
                        ))}
                        <DefaultButton
                            text="Add Variable"
                            iconProps={{ iconName: "Add" }}
                            onClick={addEnvVar}
                            styles={{
                                root: { alignSelf: "flex-start", fontSize: 12 },
                            }}
                        />
                    </Stack>

                    {/* Max Retry Count */}
                    <SpinButton
                        label="Max Retry Count"
                        min={0}
                        max={10}
                        step={1}
                        value={String(startTaskMaxRetryCount)}
                        onChange={(_e, val) =>
                            setStartTaskMaxRetryCount(
                                parseInt(val ?? "3", 10) || 3
                            )
                        }
                        onIncrement={(val) => {
                            const n = Math.min(
                                10,
                                (parseInt(val, 10) || 0) + 1
                            );
                            setStartTaskMaxRetryCount(n);
                            return String(n);
                        }}
                        onDecrement={(val) => {
                            const n = Math.max(0, (parseInt(val, 10) || 0) - 1);
                            setStartTaskMaxRetryCount(n);
                            return String(n);
                        }}
                    />

                    {/* Wait for Success */}
                    <Toggle
                        label="Wait for Success"
                        inlineLabel
                        checked={startTaskWaitForSuccess}
                        onChange={(_e, checked) =>
                            setStartTaskWaitForSuccess(checked ?? true)
                        }
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
