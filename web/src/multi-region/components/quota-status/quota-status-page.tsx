import * as React from "react";
import { DefaultButton } from "@fluentui/react/lib/Button";
import { Pivot, PivotItem } from "@fluentui/react/lib/Pivot";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Icon } from "@fluentui/react/lib/Icon";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { useMultiRegionState } from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { QuotaRequest } from "../../store/store-types";
import { DEFAULT_CONFIG } from "../shared/constants";

const stackTokens: IStackTokens = { childrenGap: 12 };

/* ---- Skeleton ---- */
const SKELETON_KEYFRAMES = `
@keyframes skeletonPulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}`;

const TableSkeleton: React.FC = () => (
    <div aria-hidden="true" style={{ padding: 16 }}>
        {Array.from({ length: 4 }).map((_, row) => (
            <div
                key={row}
                style={{
                    display: "flex",
                    gap: 12,
                    padding: "8px 0",
                    borderBottom: "1px solid #2a2a2a",
                }}
            >
                {[140, 120, 100, 110, 100, 160, 160].map((w, i) => (
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
const PAGE_SIZE_OPTIONS_QS: IDropdownOption[] = [
    { key: 10, text: "10" },
    { key: 25, text: "25" },
    { key: 50, text: "50" },
    { key: 100, text: "100" },
];

const PaginationControls: React.FC<{
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
                    options={PAGE_SIZE_OPTIONS_QS}
                    selectedKey={pageSize}
                    onChange={(_e, o) => {
                        if (o) onPageSizeChange(o.key as number);
                    }}
                    styles={{ dropdown: { width: 70 } }}
                    aria-label="Rows per page"
                />
            </Stack>
        </Stack>
    );
};

const INTERVAL_OPTIONS: IDropdownOption[] = [
    { key: "30", text: "30 seconds" },
    { key: "60", text: "60 seconds" },
    { key: "120", text: "2 minutes" },
    { key: "300", text: "5 minutes" },
];

interface QuotaStatusPageProps {
    orchestrator: OrchestratorAgent;
}

export const QuotaStatusPage: React.FC<QuotaStatusPageProps> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [refreshInterval, setRefreshInterval] = React.useState(
        DEFAULT_CONFIG.defaultRefreshIntervalSec
    );
    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [qsPage, setQsPage] = React.useState(1);
    const [qsPageSize, setQsPageSize] = React.useState(25);
    const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(
        null
    );

    const pendingRequests = state.quotaRequests.filter(
        (r) => r.status === "pending" || r.status === "submitted"
    );
    const approvedRequests = state.quotaRequests.filter(
        (r) => r.status === "approved"
    );
    const deniedRequests = state.quotaRequests.filter(
        (r) => r.status === "denied"
    );

    // Auto-enable refresh on mount if there are pending/submitted quotas
    const autoEnabledRef = React.useRef(false);
    React.useEffect(() => {
        if (autoEnabledRef.current) return;
        if (pendingRequests.length > 0) {
            autoEnabledRef.current = true;
            setAutoRefresh(true);
        }
    }, [pendingRequests.length]);

    const handleRefresh = React.useCallback(async () => {
        setIsRefreshing(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "check_quota_status",
                payload: { mode: "one-shot" },
            });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
        } finally {
            setIsRefreshing(false);
        }
    }, [orchestrator]);

    React.useEffect(() => {
        if (!autoRefresh) {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            return;
        }

        const poll = async () => {
            setIsRefreshing(true);
            try {
                await orchestrator.execute({
                    action: "check_quota_status",
                    payload: { mode: "one-shot" },
                });
            } finally {
                setIsRefreshing(false);
            }
        };

        intervalRef.current = setInterval(poll, refreshInterval * 1000);
        poll();

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [autoRefresh, refreshInterval, orchestrator]);

    const columns: IColumn[] = [
        {
            key: "accountName",
            name: "Account",
            minWidth: 140,
            onRender: (item: QuotaRequest) => {
                const account = state.accounts.find(
                    (a) => a.id === item.accountId
                );
                return account?.accountName ?? "-";
            },
        },
        { key: "region", name: "Region", fieldName: "region", minWidth: 120 },
        {
            key: "quotaType",
            name: "Type",
            fieldName: "quotaType",
            minWidth: 100,
        },
        {
            key: "requestedLimit",
            name: "Requested Limit",
            fieldName: "requestedLimit",
            minWidth: 110,
        },
        {
            key: "status",
            name: "Status",
            minWidth: 100,
            onRender: (item: QuotaRequest) => (
                <StatusBadge status={item.status} />
            ),
        },
        {
            key: "lastChecked",
            name: "Last Checked",
            minWidth: 160,
            onRender: (item: QuotaRequest) =>
                item.lastCheckedAt
                    ? new Date(item.lastCheckedAt).toLocaleString()
                    : "-",
        },
        {
            key: "resolved",
            name: "Resolved At",
            minWidth: 160,
            onRender: (item: QuotaRequest) =>
                item.resolvedAt
                    ? new Date(item.resolvedAt).toLocaleString()
                    : "-",
        },
    ];

    // Reset page when data changes
    React.useEffect(() => {
        setQsPage(1);
    }, [state.quotaRequests.length]);

    const renderPaginatedTable = (items: QuotaRequest[]) => {
        const paged = items.slice(
            (qsPage - 1) * qsPageSize,
            qsPage * qsPageSize
        );
        return (
            <>
                <DetailsList
                    items={paged}
                    columns={columns}
                    layoutMode={DetailsListLayoutMode.justified}
                    selectionMode={SelectionMode.none}
                    compact
                />
                {items.length > 10 && (
                    <PaginationControls
                        page={qsPage}
                        pageSize={qsPageSize}
                        totalItems={items.length}
                        onPageChange={setQsPage}
                        onPageSizeChange={(s) => {
                            setQsPageSize(s);
                            setQsPage(1);
                        }}
                    />
                )}
            </>
        );
    };

    const renderEmpty = (label: string, icon: string) => (
        <Stack
            horizontalAlign="center"
            tokens={{ childrenGap: 8 }}
            styles={{ root: { padding: "32px 16px" } }}
            role="status"
        >
            <Icon
                iconName={icon}
                styles={{ root: { fontSize: 32, color: "#555" } }}
            />
            <Text
                variant="medium"
                styles={{ root: { color: "#888", fontWeight: 600 } }}
            >
                No {label} requests
            </Text>
            <Text styles={{ root: { color: "#666", fontSize: 12 } }}>
                {label === "pending"
                    ? "No requests are currently waiting for approval."
                    : label === "approved"
                      ? "No requests have been approved yet."
                      : "No requests have been denied."}
            </Text>
        </Stack>
    );

    return (
        <div style={{ padding: "16px" }}>
            <style>{SKELETON_KEYFRAMES}</style>
            <h2 style={{ margin: "0 0 16px", fontSize: "20px" }}>
                Quota Status Dashboard
            </h2>

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
                            aria-label="Retry checking quota status"
                        />
                    }
                >
                    {error}
                </MessageBar>
            )}

            <Stack horizontal tokens={stackTokens} verticalAlign="end">
                <DefaultButton
                    text={isRefreshing ? "Refreshing..." : "Refresh Now"}
                    disabled={isRefreshing}
                    onClick={handleRefresh}
                    iconProps={{ iconName: "Refresh" }}
                    aria-label="Refresh quota status"
                />
                <Toggle
                    label="Auto-refresh"
                    checked={autoRefresh}
                    onChange={(_e, checked) => setAutoRefresh(!!checked)}
                    inlineLabel
                    aria-label="Toggle auto-refresh"
                />
                <Dropdown
                    label="Interval"
                    options={INTERVAL_OPTIONS}
                    selectedKey={String(refreshInterval)}
                    onChange={(_e, option) => {
                        if (option) {
                            setRefreshInterval(
                                parseInt(option.key as string, 10)
                            );
                        }
                    }}
                    styles={{ dropdown: { width: 130 } }}
                    disabled={!autoRefresh}
                    aria-label="Refresh interval"
                />
            </Stack>

            {/* Skeleton when loading with no data */}
            {isRefreshing && state.quotaRequests.length === 0 ? (
                <TableSkeleton />
            ) : state.quotaRequests.length === 0 ? (
                <Stack
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}
                    styles={{
                        root: {
                            padding: "48px 16px",
                            background: "#1e1e1e",
                            borderRadius: 6,
                            marginTop: 16,
                        },
                    }}
                    role="status"
                >
                    <Icon
                        iconName="Clock"
                        styles={{ root: { fontSize: 40, color: "#555" } }}
                    />
                    <Text
                        variant="large"
                        styles={{ root: { color: "#888", fontWeight: 600 } }}
                    >
                        No quota requests found
                    </Text>
                    <Text styles={{ root: { color: "#666", fontSize: 13 } }}>
                        Submit quota increase requests first, then monitor their
                        status here.
                    </Text>
                </Stack>
            ) : (
                <div style={{ marginTop: 16 }}>
                    <Pivot aria-label="Quota request status tabs">
                        <PivotItem
                            headerText={`Pending (${pendingRequests.length})`}
                        >
                            {pendingRequests.length > 0
                                ? renderPaginatedTable(pendingRequests)
                                : renderEmpty("pending", "Clock")}
                        </PivotItem>
                        <PivotItem
                            headerText={`Approved (${approvedRequests.length})`}
                        >
                            {approvedRequests.length > 0
                                ? renderPaginatedTable(approvedRequests)
                                : renderEmpty("approved", "Checkmark")}
                        </PivotItem>
                        <PivotItem
                            headerText={`Denied (${deniedRequests.length})`}
                        >
                            {deniedRequests.length > 0
                                ? renderPaginatedTable(deniedRequests)
                                : renderEmpty("denied", "Cancel")}
                        </PivotItem>
                    </Pivot>
                </div>
            )}
        </div>
    );
};
