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
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { AccountInfo } from "../../store/store-types";

export interface AccountInfoPageProps {
    orchestrator: OrchestratorAgent;
}

/** Safely read a numeric value, returning 0 for null/undefined/NaN */
function safeNum(value: number | null | undefined): number {
    if (value == null || isNaN(value)) return 0;
    return value;
}

/** UsageBar color: green < 50%, orange 50-80%, red > 80% */
function lpUsageColor(used: number, quota: number): string {
    if (quota <= 0) return "#999";
    const pct = (used / quota) * 100;
    if (pct > 80) return "#d13438";
    if (pct >= 50) return "#e3a400";
    return "#107c10";
}

function usagePct(used: number, quota: number): number {
    if (quota <= 0) return 0;
    return Math.min(100, Math.round((used / quota) * 100));
}

const UsageBar: React.FC<{ used: number; quota: number }> = ({
    used,
    quota,
}) => {
    const pct = usagePct(used, quota);
    const color = lpUsageColor(used, quota);
    return (
        <Stack tokens={{ childrenGap: 4 }}>
            <span style={{ color, fontSize: 12, fontWeight: 600 }}>
                {used} / {quota}
            </span>
            <div
                style={{
                    width: 80,
                    height: 4,
                    background: "#333",
                    borderRadius: 2,
                }}
            >
                <div
                    style={{
                        width: `${pct}%`,
                        height: "100%",
                        background: color,
                        borderRadius: 2,
                        transition: "width 0.3s ease",
                    }}
                />
            </div>
        </Stack>
    );
};

type SortDirection = "asc" | "desc";

interface SortConfig {
    key: string;
    direction: SortDirection;
}

function getSortValue(item: AccountInfo, key: string): string | number {
    switch (key) {
        case "accountName":
            return item.accountName ?? "";
        case "region":
            return item.region ?? "";
        case "subscription":
            return item.subscriptionId ?? "";
        case "lpQuota":
            return safeNum(item.lowPriorityCoreQuota);
        case "lpUsed":
            return safeNum(item.lowPriorityCoresUsed);
        case "lpFree":
            return safeNum(item.lowPriorityCoresFree);
        case "dedicatedQuota":
            return safeNum(item.dedicatedCoreQuota);
        case "poolCount":
            return safeNum(item.poolCount);
        case "poolQuota":
            return safeNum(item.poolQuota);
        case "poolsFree":
            return safeNum(item.poolsFree);
        default:
            return 0;
    }
}

function sortAccounts(
    accounts: AccountInfo[],
    sortConfig: SortConfig | null
): AccountInfo[] {
    if (!sortConfig) return accounts;
    const sorted = [...accounts].sort((a, b) => {
        const aVal = getSortValue(a, sortConfig.key);
        const bVal = getSortValue(b, sortConfig.key);
        if (typeof aVal === "string" && typeof bVal === "string") {
            const cmp = aVal.localeCompare(bVal);
            return sortConfig.direction === "asc" ? cmp : -cmp;
        }
        const cmp = (aVal as number) - (bVal as number);
        return sortConfig.direction === "asc" ? cmp : -cmp;
    });
    return sorted;
}

export const AccountInfoPage: React.FC<AccountInfoPageProps> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const [loading, setLoading] = React.useState(false);
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [sortConfig, setSortConfig] = React.useState<SortConfig | null>(null);
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
        new Set()
    );
    const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(
        null
    );

    const refresh = React.useCallback(async () => {
        setLoading(true);
        try {
            await orchestrator.execute({
                action: "refresh_account_info",
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

    // Auto-load on mount when accountInfos is empty
    React.useEffect(() => {
        if (!state.accountInfos || state.accountInfos.length === 0) {
            orchestrator
                .execute({ action: "refresh_account_info", payload: {} })
                .catch(() => {
                    /* handled by orchestrator */
                });
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-refresh interval (30s)
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

    const accountInfos = state.accountInfos ?? [];

    const accounts = React.useMemo(
        () => sortAccounts(accountInfos, sortConfig),
        [accountInfos, sortConfig]
    );

    const allSelected =
        accounts.length > 0 && selectedIds.size === accounts.length;
    const someSelected = selectedIds.size > 0 && !allSelected;

    const toggleSelectAll = React.useCallback(() => {
        if (allSelected) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(accounts.map((a) => a.id)));
        }
    }, [allSelected, accounts]);

    const toggleSelect = React.useCallback((id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    // Summary stats with null-safe access
    const totalAccounts = accounts.length;
    const totalDedicatedQuota = accounts.reduce(
        (s, a) => s + safeNum(a.dedicatedCoreQuota),
        0
    );
    const totalLpUsed = accounts.reduce(
        (s, a) => s + safeNum(a.lowPriorityCoresUsed),
        0
    );
    const totalLpQuota = accounts.reduce(
        (s, a) => s + safeNum(a.lowPriorityCoreQuota),
        0
    );
    const totalLpFree = totalLpQuota - totalLpUsed;
    const totalPools = accounts.reduce((s, a) => s + safeNum(a.poolCount), 0);

    const handleColumnClick = React.useCallback(
        (_ev?: React.MouseEvent<HTMLElement>, column?: IColumn) => {
            if (!column) return;
            setSortConfig((prev) => {
                if (prev && prev.key === column.key) {
                    return {
                        key: column.key,
                        direction: prev.direction === "asc" ? "desc" : "asc",
                    };
                }
                return { key: column.key, direction: "asc" };
            });
        },
        []
    );

    const columns: IColumn[] = React.useMemo(
        () => [
            {
                key: "select",
                name: "",
                minWidth: 32,
                maxWidth: 32,
                onRender: (item: AccountInfo) => (
                    <Checkbox
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleSelect(item.id)}
                        styles={{ root: { marginTop: 2 } }}
                    />
                ),
                onRenderHeader: () => (
                    <Checkbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        onChange={toggleSelectAll}
                        styles={{ root: { marginTop: 2 } }}
                    />
                ),
            },
            {
                key: "accountName",
                name: "Account Name",
                fieldName: "accountName",
                minWidth: 120,
                maxWidth: 200,
                isResizable: true,
                isSorted: sortConfig?.key === "accountName",
                isSortedDescending:
                    sortConfig?.key === "accountName" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => (
                    <span style={{ color: "#ccc" }}>
                        {item.accountName ?? ""}
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
                isSorted: sortConfig?.key === "region",
                isSortedDescending:
                    sortConfig?.key === "region" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => (
                    <span style={{ color: "#ccc" }}>{item.region ?? ""}</span>
                ),
            },
            {
                key: "subscription",
                name: "Subscription ID",
                minWidth: 90,
                maxWidth: 110,
                isResizable: true,
                isSorted: sortConfig?.key === "subscription",
                isSortedDescending:
                    sortConfig?.key === "subscription" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => {
                    const subId = item.subscriptionId ?? "";
                    return (
                        <span
                            style={{ fontSize: 11, color: "#999" }}
                            title={subId}
                        >
                            {subId.length > 8
                                ? `${subId.substring(0, 8)}...`
                                : subId}
                        </span>
                    );
                },
            },
            {
                key: "lpQuota",
                name: "LP Quota",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortConfig?.key === "lpQuota",
                isSortedDescending:
                    sortConfig?.key === "lpQuota" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => (
                    <span style={{ color: "#ccc" }}>
                        {safeNum(item.lowPriorityCoreQuota)}
                    </span>
                ),
            },
            {
                key: "lpUsed",
                name: "LP Used",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortConfig?.key === "lpUsed",
                isSortedDescending:
                    sortConfig?.key === "lpUsed" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => (
                    <UsageBar
                        used={safeNum(item.lowPriorityCoresUsed)}
                        quota={safeNum(item.lowPriorityCoreQuota)}
                    />
                ),
            },
            {
                key: "lpFree",
                name: "LP Free",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortConfig?.key === "lpFree",
                isSortedDescending:
                    sortConfig?.key === "lpFree" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => {
                    const free = safeNum(item.lowPriorityCoresFree);
                    return (
                        <span
                            style={{
                                color: free > 0 ? "#107c10" : "#999",
                                fontWeight: free > 0 ? 600 : 400,
                            }}
                        >
                            {free}
                        </span>
                    );
                },
            },
            {
                key: "dedicatedQuota",
                name: "Dedicated (unused)",
                minWidth: 100,
                maxWidth: 130,
                isResizable: true,
                isSorted: sortConfig?.key === "dedicatedQuota",
                isSortedDescending:
                    sortConfig?.key === "dedicatedQuota" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => (
                    <span style={{ color: "#888" }}>
                        {safeNum(item.dedicatedCoreQuota)}
                    </span>
                ),
            },
            {
                key: "poolCount",
                name: "Pool Count",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortConfig?.key === "poolCount",
                isSortedDescending:
                    sortConfig?.key === "poolCount" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => (
                    <span style={{ color: "#ccc" }}>
                        {safeNum(item.poolCount)}
                    </span>
                ),
            },
            {
                key: "poolQuota",
                name: "Pool Quota",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortConfig?.key === "poolQuota",
                isSortedDescending:
                    sortConfig?.key === "poolQuota" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => (
                    <span style={{ color: "#ccc" }}>
                        {safeNum(item.poolQuota)}
                    </span>
                ),
            },
            {
                key: "poolsFree",
                name: "Pools Free",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
                isSorted: sortConfig?.key === "poolsFree",
                isSortedDescending:
                    sortConfig?.key === "poolsFree" &&
                    sortConfig?.direction === "desc",
                onColumnClick: handleColumnClick,
                onRender: (item: AccountInfo) => {
                    const free = safeNum(item.poolsFree);
                    return (
                        <span
                            style={{
                                color: free > 0 ? "#107c10" : "#999",
                                fontWeight: free > 0 ? 600 : 400,
                            }}
                        >
                            {free}
                        </span>
                    );
                },
            },
        ],
        [
            sortConfig,
            selectedIds,
            allSelected,
            someSelected,
            handleColumnClick,
            toggleSelect,
            toggleSelectAll,
        ]
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
                    Account Info
                </Text>
                <PrimaryButton
                    text="Refresh"
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
                    icon="AccountManagement"
                    label="Total Accounts"
                    value={totalAccounts}
                    color="#0078d4"
                />
                <SummaryStatItem
                    icon="Server"
                    label="Total Dedicated Quota"
                    value={totalDedicatedQuota}
                    color="#00b7c3"
                />
                <SummaryStatItem
                    icon="Server"
                    label="LP Used / Total"
                    value={totalLpUsed}
                    suffix={` / ${totalLpQuota}`}
                    color="#8764b8"
                />
                <SummaryStatItem
                    icon="StatusCircleCheckmark"
                    label="LP Free"
                    value={totalLpFree}
                    color="#107c10"
                />
                <SummaryStatItem
                    icon="BuildQueue"
                    label="Total Pools"
                    value={totalPools}
                    color="#e3a400"
                />
            </Stack>

            {/* DetailsList */}
            {accounts.length === 0 ? (
                <Text variant="medium" styles={{ root: { color: "#666" } }}>
                    No account info available. Click &quot;Refresh&quot; to load
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
                        items={accounts}
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
    suffix?: string;
}> = ({ icon, label, value, color, suffix }) => (
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
                {value ?? 0}
                {suffix ?? ""}
            </Text>
        </div>
    </Stack>
);
