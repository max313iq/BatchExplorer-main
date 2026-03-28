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
import { TextField } from "@fluentui/react/lib/TextField";
import { SpinButton } from "@fluentui/react/lib/SpinButton";
import { Label } from "@fluentui/react/lib/Label";
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { AccountInfo } from "../../store/store-types";
import { getVCpus, getAllVmSizes, VmSizeInfo } from "../shared/vm-sizes";

/* ---- Skeleton ---- */
const SKELETON_KEYFRAMES = `
@keyframes skeletonPulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}`;

const TableSkeletonUQ: React.FC = () => (
    <div
        style={{
            background: "#1e1e1e",
            borderRadius: 6,
            padding: 16,
        }}
        aria-hidden="true"
    >
        {Array.from({ length: 5 }).map((_, row) => (
            <div
                key={row}
                style={{
                    display: "flex",
                    gap: 12,
                    padding: "8px 0",
                    borderBottom: "1px solid #2a2a2a",
                }}
            >
                {[120, 80, 80, 70, 70, 70, 60, 140, 70].map((w, i) => (
                    <div
                        key={i}
                        style={{
                            width: w,
                            height: 10,
                            background: "#333",
                            borderRadius: 4,
                            animation:
                                "skeletonPulse 1.5s ease-in-out infinite",
                            animationDelay: `${row * 0.1}s`,
                        }}
                    />
                ))}
            </div>
        ))}
    </div>
);

/* ---- Pagination ---- */
const PAGE_SIZE_OPTIONS_UQ: IDropdownOption[] = [
    { key: 10, text: "10" },
    { key: 25, text: "25" },
    { key: 50, text: "50" },
    { key: 100, text: "100" },
];

const PaginationUQ: React.FC<{
    page: number;
    pageSize: number;
    totalItems: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
}> = ({ page, pageSize, totalItems, onPageChange, onPageSizeChange }) => {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    return (
        <Stack
            horizontal
            verticalAlign="center"
            tokens={{ childrenGap: 12 }}
            styles={{
                root: { padding: "8px 0", justifyContent: "space-between" },
            }}
        >
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 8 }}
            >
                <DefaultButton
                    text="Prev"
                    onClick={() => onPageChange(page - 1)}
                    disabled={page <= 1}
                    aria-label="Previous page"
                    styles={{ root: { minWidth: 60 } }}
                />
                <Text
                    styles={{ root: { color: "#999", fontSize: 13 } }}
                    role="status"
                    aria-live="polite"
                >
                    Page {page} of {totalPages}
                </Text>
                <DefaultButton
                    text="Next"
                    onClick={() => onPageChange(page + 1)}
                    disabled={page >= totalPages}
                    aria-label="Next page"
                    styles={{ root: { minWidth: 60 } }}
                />
            </Stack>
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 8 }}
            >
                <Text styles={{ root: { color: "#888", fontSize: 12 } }}>
                    Rows:
                </Text>
                <Dropdown
                    options={PAGE_SIZE_OPTIONS_UQ}
                    selectedKey={pageSize}
                    onChange={(_e, o) => {
                        if (o) onPageSizeChange(o.key as number);
                    }}
                    styles={{ dropdown: { width: 70 } }}
                    aria-label="Rows per page"
                />
                <Text styles={{ root: { color: "#666", fontSize: 11 } }}>
                    ({totalItems} total)
                </Text>
            </Stack>
        </Stack>
    );
};

// Priority list for suggesting VM sizes
const VM_PRIORITY_LIST = [
    "Standard_ND40rs_v2",
    "Standard_ND96isr_H100_v5",
    "Standard_NC24s_v3",
    "Standard_NC12s_v3",
    "Standard_NC6s_v3",
];

export interface UnusedQuotaPageProps {
    orchestrator: OrchestratorAgent;
    onNavigate?: (key: string) => void;
}

interface EnvVar {
    name: string;
    value: string;
}

interface QuotaRow {
    id: string;
    accountName: string;
    region: string;
    subscriptionId: string;
    lpQuota: number;
    lpUsed: number;
    lpFree: number;
    dedicatedQuota: number;
    dedicatedUsed: number;
    dedicatedFree: number;
    isResizing: boolean;
    suggestedVm: string;
    suggestedVmVCpus: number;
    maxNodes: number;
    accountInfo: AccountInfo;
}

type SortKey =
    | "accountName"
    | "region"
    | "subscriptionId"
    | "lpQuota"
    | "lpUsed"
    | "lpFree"
    | "isResizing"
    | "suggestedVm"
    | "maxNodes";

function getSuggestedVm(freeLpCores: number): VmSizeInfo | null {
    for (const vmName of VM_PRIORITY_LIST) {
        const vcpus = getVCpus(vmName);
        if (freeLpCores >= vcpus) {
            const allVms = getAllVmSizes();
            const found = allVms.find(
                (v) => v.name.toLowerCase() === vmName.toLowerCase()
            );
            if (found) return found;
        }
    }
    // Fallback: pick the smallest GPU VM that fits
    const allVms = getAllVmSizes();
    const gpuVms = allVms
        .filter((v) => v.isGpu && v.vCPUs <= freeLpCores)
        .sort((a, b) => b.vCPUs - a.vCPUs);
    return gpuVms.length > 0 ? gpuVms[0] : null;
}

export const UnusedQuotaPage: React.FC<UnusedQuotaPageProps> = ({
    orchestrator,
    onNavigate,
}) => {
    const state = useMultiRegionState();
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [uqPage, setUqPage] = React.useState(1);
    const [uqPageSize, setUqPageSize] = React.useState(25);
    const [showOnlyFree, setShowOnlyFree] = React.useState(false);
    const [sortKey, setSortKey] = React.useState<SortKey | null>(null);
    const [sortDescending, setSortDescending] = React.useState(false);
    const [selectedRows, setSelectedRows] = React.useState<QuotaRow[]>([]);

    // Auto-create dialog state
    const [showAutoCreateDialog, setShowAutoCreateDialog] =
        React.useState(false);
    const [autoCreateSubmitting, setAutoCreateSubmitting] =
        React.useState(false);

    // Start task config for auto-create
    const [commandLine, setCommandLine] = React.useState("");
    const [envVars, setEnvVars] = React.useState<EnvVar[]>([
        { name: "", value: "" },
    ]);
    const [maxRetryCount, setMaxRetryCount] = React.useState(3);
    const [waitForSuccess, setWaitForSuccess] = React.useState(true);

    const selection = React.useMemo(
        () =>
            new Selection({
                onSelectionChanged: () => {
                    const selected = selection.getSelection() as QuotaRow[];
                    setSelectedRows(selected);
                },
                getKey: (item: any) => item.id,
            }),
        []
    );

    // Build rows from accountInfos
    const allRows: QuotaRow[] = React.useMemo(() => {
        return state.accountInfos.map((acct) => {
            const isResizing = state.poolInfos.some(
                (p) =>
                    p.accountId === acct.id && p.allocationState === "resizing"
            );
            const suggested = getSuggestedVm(acct.lowPriorityCoresFree);
            const suggestedVmVCpus = suggested?.vCPUs ?? 1;
            const maxNodes = suggested
                ? Math.floor(acct.lowPriorityCoresFree / suggestedVmVCpus)
                : 0;

            return {
                id: acct.id,
                accountName: acct.accountName,
                region: acct.region,
                subscriptionId: acct.subscriptionId,
                lpQuota: acct.lowPriorityCoreQuota,
                lpUsed: acct.lowPriorityCoresUsed,
                lpFree: acct.lowPriorityCoresFree,
                dedicatedQuota: acct.dedicatedCoreQuota,
                dedicatedUsed: acct.dedicatedCoresUsed,
                dedicatedFree: acct.dedicatedCoresFree,
                isResizing,
                suggestedVm: suggested?.name ?? "N/A",
                suggestedVmVCpus,
                maxNodes,
                accountInfo: acct,
            };
        });
    }, [state.accountInfos, state.poolInfos]);

    // Apply filter
    const filteredRows = React.useMemo(() => {
        if (showOnlyFree) {
            return allRows.filter((r) => r.lpFree > 0);
        }
        return allRows;
    }, [allRows, showOnlyFree]);

    // Apply sorting
    const sortedRows = React.useMemo(() => {
        if (!sortKey) return filteredRows;
        const sorted = [...filteredRows];
        const dir = sortDescending ? -1 : 1;

        sorted.sort((a, b) => {
            let aVal: string | number | boolean = "";
            let bVal: string | number | boolean = "";

            switch (sortKey) {
                case "accountName":
                    aVal = a.accountName;
                    bVal = b.accountName;
                    break;
                case "region":
                    aVal = a.region;
                    bVal = b.region;
                    break;
                case "subscriptionId":
                    aVal = a.subscriptionId;
                    bVal = b.subscriptionId;
                    break;
                case "lpQuota":
                    aVal = a.lpQuota;
                    bVal = b.lpQuota;
                    break;
                case "lpUsed":
                    aVal = a.lpUsed;
                    bVal = b.lpUsed;
                    break;
                case "lpFree":
                    aVal = a.lpFree;
                    bVal = b.lpFree;
                    break;
                case "isResizing":
                    aVal = a.isResizing ? 1 : 0;
                    bVal = b.isResizing ? 1 : 0;
                    break;
                case "suggestedVm":
                    aVal = a.suggestedVm;
                    bVal = b.suggestedVm;
                    break;
                case "maxNodes":
                    aVal = a.maxNodes;
                    bVal = b.maxNodes;
                    break;
            }

            if (typeof aVal === "number" && typeof bVal === "number") {
                return (aVal - bVal) * dir;
            }
            return String(aVal).localeCompare(String(bVal)) * dir;
        });

        return sorted;
    }, [filteredRows, sortKey, sortDescending]);

    // Summary stats
    const totalAccounts = allRows.length;
    const totalFreeLpCores = allRows.reduce((s, r) => s + r.lpFree, 0);
    const totalFreeDedicatedCores = allRows.reduce(
        (s, r) => s + r.dedicatedFree,
        0
    );
    const accountsWithFreeQuota = allRows.filter((r) => r.lpFree > 0).length;

    // Refresh data on mount
    React.useEffect(() => {
        const doRefresh = async () => {
            setLoading(true);
            try {
                await orchestrator.execute({
                    action: "refresh_account_info",
                    payload: {},
                });
                await orchestrator.execute({
                    action: "refresh_pool_info",
                    payload: {},
                });
            } catch {
                /* handled by orchestrator */
            } finally {
                setLoading(false);
            }
        };
        if (state.accountInfos.length === 0 && state.accounts.length > 0) {
            doRefresh();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reset page when data changes
    React.useEffect(() => {
        setUqPage(1);
    }, [sortedRows.length]);

    // Paginate
    const paginatedRows = React.useMemo(() => {
        const start = (uqPage - 1) * uqPageSize;
        return sortedRows.slice(start, start + uqPageSize);
    }, [sortedRows, uqPage, uqPageSize]);

    const handleRefresh = async () => {
        setLoading(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "refresh_account_info",
                payload: {},
            });
            await orchestrator.execute({
                action: "refresh_pool_info",
                payload: {},
            });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
        } finally {
            setLoading(false);
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

    // Env var helpers
    const addEnvVar = () => {
        setEnvVars((prev) => [...prev, { name: "", value: "" }]);
    };

    const removeEnvVar = (index: number) => {
        setEnvVars((prev) => prev.filter((_, i) => i !== index));
    };

    const updateEnvVar = (
        index: number,
        field: "name" | "value",
        val: string
    ) => {
        setEnvVars((prev) =>
            prev.map((ev, i) => (i === index ? { ...ev, [field]: val } : ev))
        );
    };

    // Build start task config
    const buildStartTaskConfig = (): Record<string, unknown> | null => {
        if (!commandLine.trim()) return null;
        const envSettings = envVars
            .filter((ev) => ev.name.trim() !== "")
            .map((ev) => ({ name: ev.name, value: ev.value }));

        const config: Record<string, unknown> = {
            commandLine,
            maxTaskRetryCount: maxRetryCount,
            waitForSuccess,
        };
        if (envSettings.length > 0) {
            config.environmentSettings = envSettings;
        }
        return config;
    };

    // Use in Smart Mode
    const handleUseInSmartMode = () => {
        if (onNavigate) {
            // Navigate to pool creation page
            onNavigate("pools");
        }
    };

    // Auto-Create Pools
    const openAutoCreateDialog = () => {
        if (selectedRows.length === 0) return;
        setShowAutoCreateDialog(true);
    };

    const submitAutoCreate = async () => {
        setAutoCreateSubmitting(true);
        try {
            const startTask = buildStartTaskConfig();
            for (const row of selectedRows) {
                if (row.maxNodes <= 0 || row.suggestedVm === "N/A") continue;

                const poolConfig: Record<string, unknown> = {
                    vmSize: row.suggestedVm,
                    targetDedicatedNodes: 0,
                    targetLowPriorityNodes: row.maxNodes,
                    taskSlotsPerNode: 1,
                };
                if (startTask) {
                    poolConfig.startTask = startTask;
                }

                await orchestrator.execute({
                    action: "create_pool",
                    payload: {
                        accountId: row.id,
                        poolConfig,
                    },
                });
            }
            setShowAutoCreateDialog(false);
        } catch {
            /* handled by orchestrator */
        } finally {
            setAutoCreateSubmitting(false);
        }
    };

    const columns: IColumn[] = React.useMemo(
        () => [
            {
                key: "accountName",
                name: "Account Name",
                fieldName: "accountName",
                minWidth: 120,
                maxWidth: 200,
                isResizable: true,
                isSorted: sortKey === "accountName",
                isSortedDescending: sortKey === "accountName" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "accountName" },
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
            },
            {
                key: "subscriptionId",
                name: "Subscription",
                minWidth: 80,
                maxWidth: 100,
                isResizable: true,
                isSorted: sortKey === "subscriptionId",
                isSortedDescending:
                    sortKey === "subscriptionId" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "subscriptionId" },
                onRender: (item: QuotaRow) =>
                    item.subscriptionId.substring(0, 8),
            },
            {
                key: "lpQuota",
                name: "LP Quota",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortKey === "lpQuota",
                isSortedDescending: sortKey === "lpQuota" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "lpQuota" },
                onRender: (item: QuotaRow) => <span>{item.lpQuota}</span>,
            },
            {
                key: "lpUsed",
                name: "LP Used",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortKey === "lpUsed",
                isSortedDescending: sortKey === "lpUsed" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "lpUsed" },
                onRender: (item: QuotaRow) => <span>{item.lpUsed}</span>,
            },
            {
                key: "lpFree",
                name: "LP Free",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortKey === "lpFree",
                isSortedDescending: sortKey === "lpFree" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "lpFree" },
                onRender: (item: QuotaRow) => (
                    <span
                        style={{
                            color: item.lpFree > 0 ? "#107c10" : "#d13438",
                            fontWeight: 600,
                        }}
                    >
                        {item.lpFree}
                    </span>
                ),
            },
            {
                key: "isResizing",
                name: "Resizing?",
                minWidth: 60,
                maxWidth: 80,
                isResizable: true,
                isSorted: sortKey === "isResizing",
                isSortedDescending: sortKey === "isResizing" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "isResizing" },
                onRender: (item: QuotaRow) => (
                    <span
                        style={{
                            color: item.isResizing ? "#e3a400" : "#666",
                        }}
                    >
                        {item.isResizing ? "Yes" : "No"}
                    </span>
                ),
            },
            {
                key: "suggestedVm",
                name: "Suggested VM",
                minWidth: 140,
                maxWidth: 200,
                isResizable: true,
                isSorted: sortKey === "suggestedVm",
                isSortedDescending: sortKey === "suggestedVm" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "suggestedVm" },
                onRender: (item: QuotaRow) => (
                    <span
                        style={{
                            color: item.suggestedVm !== "N/A" ? "#ccc" : "#666",
                        }}
                    >
                        {item.suggestedVm}
                    </span>
                ),
            },
            {
                key: "maxNodes",
                name: "Max Nodes",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortKey === "maxNodes",
                isSortedDescending: sortKey === "maxNodes" && sortDescending,
                onColumnClick: handleColumnClick,
                data: { sortKey: "maxNodes" },
                onRender: (item: QuotaRow) => (
                    <span
                        style={{
                            color: item.maxNodes > 0 ? "#0078d4" : "#666",
                            fontWeight: item.maxNodes > 0 ? 600 : 400,
                        }}
                    >
                        {item.maxNodes}
                    </span>
                ),
            },
        ],
        [sortKey, sortDescending]
    );

    return (
        <div style={{ padding: "16px 0" }}>
            <style>{SKELETON_KEYFRAMES}</style>

            {/* Error state */}
            {error && (
                <MessageBar
                    messageBarType={MessageBarType.error}
                    onDismiss={() => setError(null)}
                    styles={{ root: { marginBottom: 12 } }}
                    actions={
                        <DefaultButton
                            text="Retry"
                            onClick={handleRefresh}
                            aria-label="Retry loading unused quota data"
                        />
                    }
                >
                    {error}
                </MessageBar>
            )}

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
                    Unused Quota
                </Text>
                <PrimaryButton
                    text="Refresh"
                    iconProps={{ iconName: "Refresh" }}
                    onClick={handleRefresh}
                    disabled={loading}
                    aria-label="Refresh unused quota data"
                />
                {loading && (
                    <Spinner size={SpinnerSize.small} aria-label="Loading" />
                )}
                <PrimaryButton
                    text="Use in Smart Mode"
                    iconProps={{ iconName: "Rocket" }}
                    onClick={handleUseInSmartMode}
                    disabled={selectedRows.length === 0}
                    aria-label="Use selected accounts in smart pool creation mode"
                />
                <PrimaryButton
                    text="Auto-Create Pools"
                    iconProps={{ iconName: "Add" }}
                    onClick={openAutoCreateDialog}
                    disabled={
                        selectedRows.length === 0 ||
                        selectedRows.every((r) => r.maxNodes <= 0)
                    }
                    aria-label="Auto-create pools for selected accounts"
                />
                <Toggle
                    label="Only accounts with free LP quota"
                    inlineLabel
                    checked={showOnlyFree}
                    onChange={(_e, checked) =>
                        setShowOnlyFree(checked ?? false)
                    }
                    aria-label="Toggle to show only accounts with free LP quota"
                    styles={{
                        root: { marginBottom: 0, marginLeft: 16 },
                        label: { color: "#999", fontSize: 12 },
                    }}
                />
            </Stack>

            {/* Summary Bar */}
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
                    icon="AccountManagement"
                    label="Total Accounts"
                    value={totalAccounts}
                    color="#0078d4"
                />
                <SummaryStatItem
                    icon="Savings"
                    label="Accounts with Free LP"
                    value={accountsWithFreeQuota}
                    color="#107c10"
                />
                <SummaryStatItem
                    icon="Server"
                    label="Total Free LP Cores"
                    value={totalFreeLpCores}
                    color="#8764b8"
                />
                <SummaryStatItem
                    icon="Server"
                    label="Total Free Dedicated Cores"
                    value={totalFreeDedicatedCores}
                    color="#00b7c3"
                />
            </Stack>

            {/* Start Task Configuration */}
            <Stack
                tokens={{ childrenGap: 12 }}
                styles={{
                    root: {
                        padding: "12px 16px",
                        background: "#1e1e1e",
                        borderRadius: 6,
                        marginBottom: 16,
                    },
                }}
            >
                <Text
                    variant="mediumPlus"
                    styles={{ root: { fontWeight: 600, color: "#ccc" } }}
                >
                    Start Task Configuration (for pool creation)
                </Text>
                <TextField
                    label="Command Line"
                    value={commandLine}
                    onChange={(_e, val) => setCommandLine(val ?? "")}
                    placeholder="/bin/bash -c 'echo hello'"
                    styles={{
                        field: {
                            fontFamily: "'Consolas', 'Courier New', monospace",
                            fontSize: 13,
                        },
                    }}
                />
                <Label>Environment Variables</Label>
                <Stack tokens={{ childrenGap: 6 }}>
                    {envVars.map((ev, idx) => (
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
                            root: {
                                alignSelf: "flex-start",
                                fontSize: 12,
                            },
                        }}
                    />
                </Stack>
                <Stack horizontal tokens={{ childrenGap: 16 }}>
                    <SpinButton
                        label="Max Retry Count"
                        min={0}
                        max={10}
                        step={1}
                        value={String(maxRetryCount)}
                        onChange={(_e, val) =>
                            setMaxRetryCount(parseInt(val ?? "3", 10) || 3)
                        }
                        onIncrement={(val) => {
                            const n = Math.min(
                                10,
                                (parseInt(val, 10) || 0) + 1
                            );
                            setMaxRetryCount(n);
                            return String(n);
                        }}
                        onDecrement={(val) => {
                            const n = Math.max(0, (parseInt(val, 10) || 0) - 1);
                            setMaxRetryCount(n);
                            return String(n);
                        }}
                        styles={{ root: { width: 160 } }}
                    />
                    <Toggle
                        label="Wait for Success"
                        inlineLabel
                        checked={waitForSuccess}
                        onChange={(_e, checked) =>
                            setWaitForSuccess(checked ?? true)
                        }
                        styles={{ root: { marginBottom: 0 } }}
                    />
                </Stack>
            </Stack>

            {/* Table */}
            {loading && allRows.length === 0 ? (
                <TableSkeletonUQ />
            ) : allRows.length === 0 ? (
                <Stack
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}
                    styles={{
                        root: {
                            padding: "48px 16px",
                            background: "#1e1e1e",
                            borderRadius: 6,
                        },
                    }}
                    role="status"
                >
                    <Icon
                        iconName="Savings"
                        styles={{ root: { fontSize: 40, color: "#555" } }}
                    />
                    <Text
                        variant="large"
                        styles={{ root: { color: "#888", fontWeight: 600 } }}
                    >
                        No account info found
                    </Text>
                    <Text styles={{ root: { color: "#666", fontSize: 13 } }}>
                        Click &quot;Refresh&quot; to load account data and see
                        unused quota.
                    </Text>
                </Stack>
            ) : (
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
                            label={`Select All (${filteredRows.length})`}
                            onChange={handleSelectAll}
                            checked={
                                filteredRows.length > 0 &&
                                selectedRows.length === filteredRows.length
                            }
                            aria-label={`Select all ${filteredRows.length} rows`}
                            styles={{
                                label: {
                                    color: "#999",
                                    fontSize: 12,
                                },
                            }}
                        />
                        {selectedRows.length > 0 && (
                            <Text
                                variant="small"
                                styles={{
                                    root: { color: "#0078d4" },
                                }}
                                role="status"
                                aria-live="polite"
                            >
                                {selectedRows.length} selected
                            </Text>
                        )}
                    </Stack>
                    <DetailsList
                        items={paginatedRows}
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
                    {sortedRows.length > 10 && (
                        <PaginationUQ
                            page={uqPage}
                            pageSize={uqPageSize}
                            totalItems={sortedRows.length}
                            onPageChange={setUqPage}
                            onPageSizeChange={(s) => {
                                setUqPageSize(s);
                                setUqPage(1);
                            }}
                        />
                    )}
                </div>
            )}

            {/* Auto-Create Pools Confirmation Dialog */}
            <Dialog
                hidden={!showAutoCreateDialog}
                onDismiss={() => setShowAutoCreateDialog(false)}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: "Auto-Create Pools",
                    subText:
                        "Review the pools that will be created and confirm.",
                }}
                modalProps={{
                    isBlocking: true,
                    styles: {
                        main: { minWidth: 600, maxWidth: 720 },
                    },
                }}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    <MessageBar messageBarType={MessageBarType.info}>
                        {selectedRows.filter((r) => r.maxNodes > 0).length}{" "}
                        pool(s) will be created across{" "}
                        {
                            new Set(
                                selectedRows
                                    .filter((r) => r.maxNodes > 0)
                                    .map((r) => r.region)
                            ).size
                        }{" "}
                        region(s).
                    </MessageBar>

                    <div
                        style={{
                            maxHeight: 300,
                            overflow: "auto",
                            background: "#1a1a1a",
                            borderRadius: 4,
                            padding: 8,
                        }}
                    >
                        <table
                            style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                fontSize: 13,
                                color: "#ccc",
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
                                            textAlign: "left",
                                            padding: "4px 8px",
                                            color: "#999",
                                        }}
                                    >
                                        Account
                                    </th>
                                    <th
                                        style={{
                                            textAlign: "left",
                                            padding: "4px 8px",
                                            color: "#999",
                                        }}
                                    >
                                        Region
                                    </th>
                                    <th
                                        style={{
                                            textAlign: "left",
                                            padding: "4px 8px",
                                            color: "#999",
                                        }}
                                    >
                                        VM Size
                                    </th>
                                    <th
                                        style={{
                                            textAlign: "right",
                                            padding: "4px 8px",
                                            color: "#999",
                                        }}
                                    >
                                        LP Nodes
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {selectedRows
                                    .filter((r) => r.maxNodes > 0)
                                    .map((r) => (
                                        <tr
                                            key={r.id}
                                            style={{
                                                borderBottom:
                                                    "1px solid #2a2a2a",
                                            }}
                                        >
                                            <td
                                                style={{
                                                    padding: "4px 8px",
                                                }}
                                            >
                                                {r.accountName}
                                            </td>
                                            <td
                                                style={{
                                                    padding: "4px 8px",
                                                }}
                                            >
                                                {r.region}
                                            </td>
                                            <td
                                                style={{
                                                    padding: "4px 8px",
                                                }}
                                            >
                                                {r.suggestedVm}
                                            </td>
                                            <td
                                                style={{
                                                    padding: "4px 8px",
                                                    textAlign: "right",
                                                    fontWeight: 600,
                                                    color: "#0078d4",
                                                }}
                                            >
                                                {r.maxNodes}
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    </div>

                    {commandLine.trim() && (
                        <MessageBar messageBarType={MessageBarType.info}>
                            Start task will be configured with command:{" "}
                            <code>{commandLine}</code>
                        </MessageBar>
                    )}
                </Stack>
                <DialogFooter>
                    <PrimaryButton
                        text={
                            autoCreateSubmitting
                                ? "Creating..."
                                : "Create Pools"
                        }
                        onClick={submitAutoCreate}
                        disabled={autoCreateSubmitting}
                    />
                    <DefaultButton
                        text="Cancel"
                        onClick={() => setShowAutoCreateDialog(false)}
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
                    root: {
                        color: "#888",
                        display: "block",
                        fontSize: 11,
                    },
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
