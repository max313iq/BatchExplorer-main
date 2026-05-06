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
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { AccountInfo } from "../../store/store-types";
import { ErrorBoundary } from "../shared/error-boundary";
import { SkeletonLoader } from "../shared/skeleton-loader";
import {
    safeNum,
    usagePct,
    lpUsageColor,
    sortAccounts,
    ariaSort,
    summarizeAccountInfos,
    SortConfig,
} from "./account-info-helpers";
import { AccountInfoSummaryBar } from "./account-info-summary";

/* ------------------------------------------------------------------ */
/*  Pagination                                                         */
/* ------------------------------------------------------------------ */

const PAGE_SIZE_OPTIONS: IDropdownOption[] = [
    { key: 10, text: "10" },
    { key: 25, text: "25" },
    { key: 50, text: "50" },
    { key: 100, text: "100" },
];

const Pagination: React.FC<{
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
                root: {
                    padding: "8px 0",
                    justifyContent: "space-between",
                },
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
                    options={PAGE_SIZE_OPTIONS}
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export interface AccountInfoPageProps {
    orchestrator: OrchestratorAgent;
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
                    background: "var(--bg-tertiary, #333)",
                    borderRadius: 2,
                }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Usage: ${used} of ${quota} cores (${pct}%)`}
                aria-valuetext={`${pct}%`}
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

/* ------------------------------------------------------------------ */
/*  Empty state                                                        */
/* ------------------------------------------------------------------ */

const EmptyState: React.FC<{ onRefresh: () => void; loading: boolean }> = ({
    onRefresh,
    loading,
}) => (
    <Stack
        horizontalAlign="center"
        tokens={{ childrenGap: 12 }}
        styles={{
            root: {
                padding: "48px 16px",
                background: "var(--bg-secondary, #1e1e1e)",
                borderRadius: 6,
                border: "1px solid var(--border-subtle, #2b2b2b)",
            },
        }}
        role="status"
    >
        <Icon
            iconName="AccountManagement"
            aria-hidden="true"
            styles={{ root: { fontSize: 40, color: "#555" } }}
        />
        <Text
            as="h2"
            variant="large"
            styles={{
                root: {
                    color: "var(--text-muted, #888)",
                    fontWeight: 600,
                    margin: 0,
                },
            }}
        >
            No account info found
        </Text>
        <Text
            styles={{
                root: { color: "var(--text-muted, #666)", fontSize: 13 },
            }}
        >
            Click &quot;Refresh&quot; to load account data from Azure.
        </Text>
        <PrimaryButton
            text="Refresh"
            iconProps={{ iconName: "Refresh" }}
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh account info"
        />
    </Stack>
);

/* ------------------------------------------------------------------ */
/*  Inner component                                                    */
/* ------------------------------------------------------------------ */

const AccountInfoPageInner: React.FC<AccountInfoPageProps> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const [loading, setLoading] = React.useState(false);
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [sortConfig, setSortConfig] = React.useState<SortConfig | null>(null);
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
        new Set()
    );
    const [error, setError] = React.useState<string | null>(null);
    const [page, setPage] = React.useState(1);
    const [pageSize, setPageSize] = React.useState(25);
    const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(
        null
    );

    const refresh = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "refresh_account_info",
                payload: {},
            });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
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

    const sortedAccounts = React.useMemo(
        () => sortAccounts(accountInfos, sortConfig),
        [accountInfos, sortConfig]
    );

    // Reset page when data or sort changes
    React.useEffect(() => {
        setPage(1);
    }, [accountInfos.length, sortConfig]);

    // Paginate
    const totalItems = sortedAccounts.length;
    const paginatedAccounts = React.useMemo(() => {
        const start = (page - 1) * pageSize;
        return sortedAccounts.slice(start, start + pageSize);
    }, [sortedAccounts, page, pageSize]);

    const allSelected =
        sortedAccounts.length > 0 && selectedIds.size === sortedAccounts.length;
    const someSelected = selectedIds.size > 0 && !allSelected;

    const toggleSelectAll = React.useCallback(() => {
        if (allSelected) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(sortedAccounts.map((a) => a.id)));
        }
    }, [allSelected, sortedAccounts]);

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

    // Aggregated summary via shared helper
    const summary = React.useMemo(
        () => summarizeAccountInfos(sortedAccounts),
        [sortedAccounts]
    );

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
                        aria-label={`Select ${item.accountName}`}
                    />
                ),
                onRenderHeader: () => (
                    <Checkbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        onChange={toggleSelectAll}
                        styles={{ root: { marginTop: 2 } }}
                        aria-label="Select all accounts"
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
                ariaLabel: `Account Name, ${ariaSort(sortConfig, "accountName")}`,
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
                ariaLabel: `Region, ${ariaSort(sortConfig, "region")}`,
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
                ariaLabel: `Subscription ID, ${ariaSort(sortConfig, "subscription")}`,
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
                ariaLabel: `LP Quota, ${ariaSort(sortConfig, "lpQuota")}`,
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
                ariaLabel: `LP Used, ${ariaSort(sortConfig, "lpUsed")}`,
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
                ariaLabel: `LP Free, ${ariaSort(sortConfig, "lpFree")}`,
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
                ariaLabel: `Dedicated quota, ${ariaSort(sortConfig, "dedicatedQuota")}`,
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
                ariaLabel: `Pool Count, ${ariaSort(sortConfig, "poolCount")}`,
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
                ariaLabel: `Pool Quota, ${ariaSort(sortConfig, "poolQuota")}`,
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
                ariaLabel: `Pools Free, ${ariaSort(sortConfig, "poolsFree")}`,
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
                    as="h1"
                    variant="xLarge"
                    styles={{
                        root: { fontWeight: 600, color: "#eee", margin: 0 },
                    }}
                >
                    Account Info
                </Text>
                <PrimaryButton
                    text="Refresh"
                    iconProps={{ iconName: "Refresh" }}
                    onClick={refresh}
                    disabled={loading}
                    aria-label="Refresh account info"
                />
                {loading && (
                    <>
                        <Spinner
                            size={SpinnerSize.small}
                            aria-label="Loading"
                        />
                        <DefaultButton
                            text="Stop"
                            iconProps={{ iconName: "Stop" }}
                            onClick={stop}
                            aria-label="Stop refresh"
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
                    aria-label="Toggle auto-refresh every 30 seconds"
                    styles={{
                        root: { marginBottom: 0, marginLeft: 16 },
                        label: { color: "#999", fontSize: 12 },
                    }}
                />
            </Stack>

            {/* Error state */}
            {error && (
                <MessageBar
                    messageBarType={MessageBarType.error}
                    onDismiss={() => setError(null)}
                    styles={{ root: { marginBottom: 12 } }}
                    actions={
                        <DefaultButton
                            text="Retry"
                            onClick={refresh}
                            aria-label="Retry loading account info"
                        />
                    }
                >
                    {error}
                </MessageBar>
            )}

            {/* Summary Stats — shared bar driven by helper */}
            <AccountInfoSummaryBar summary={summary} />

            {/* DetailsList or skeleton or empty */}
            {loading && accountInfos.length === 0 ? (
                <div
                    style={{
                        background: "var(--bg-secondary, #1e1e1e)",
                        borderRadius: 6,
                        padding: 16,
                    }}
                >
                    <SkeletonLoader variant="table" rows={6} columns={10} />
                </div>
            ) : accountInfos.length === 0 ? (
                <EmptyState onRefresh={refresh} loading={loading} />
            ) : (
                <>
                    <div
                        style={{
                            background: "#1e1e1e",
                            borderRadius: 6,
                            padding: 8,
                        }}
                    >
                        <DetailsList
                            items={paginatedAccounts}
                            columns={columns}
                            layoutMode={DetailsListLayoutMode.fixedColumns}
                            selectionMode={SelectionMode.none}
                            compact
                            ariaLabelForGrid="Account info table"
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
                    {totalItems > 10 && (
                        <Pagination
                            page={page}
                            pageSize={pageSize}
                            totalItems={totalItems}
                            onPageChange={setPage}
                            onPageSizeChange={(size) => {
                                setPageSize(size);
                                setPage(1);
                            }}
                        />
                    )}
                </>
            )}
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Exported wrapper with ErrorBoundary                                */
/* ------------------------------------------------------------------ */

export const AccountInfoPage: React.FC<AccountInfoPageProps> = (props) => (
    <ErrorBoundary>
        <AccountInfoPageInner {...props} />
    </ErrorBoundary>
);
