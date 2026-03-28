import * as React from "react";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { Icon } from "@fluentui/react/lib/Icon";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { QuotaRequest, QuotaRequestStatus } from "../../store/store-types";

/* ------------------------------------------------------------------ */
/*  Skeleton                                                           */
/* ------------------------------------------------------------------ */

const SKELETON_KEYFRAMES = `
@keyframes skeletonPulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}`;

const TableSkeleton: React.FC = () => (
    <div
        style={{
            background: "#252525",
            borderRadius: 8,
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
                {[100, 100, 90, 80, 70, 90, 130, 130].map((w, i) => (
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

const statusBadgeConfig: Record<
    QuotaRequestStatus,
    { background: string; color: string }
> = {
    pending: { background: "#333", color: "#888" },
    submitted: { background: "#0a2a4a", color: "#0078d4" },
    approved: { background: "#0a3a0a", color: "#107c10" },
    denied: { background: "#3a0a0a", color: "#d13438" },
    failed: { background: "#3a0a0a", color: "#d13438" },
};

function renderStatusBadge(status: QuotaRequestStatus): React.ReactNode {
    const config = statusBadgeConfig[status] ?? statusBadgeConfig.pending;
    return (
        <span
            style={{
                padding: "2px 10px",
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 600,
                background: config.background,
                color: config.color,
                textTransform: "capitalize",
            }}
        >
            {status}
        </span>
    );
}

function formatShortId(id: string): string {
    if (!id) return "";
    return id.length > 12 ? id.substring(0, 12) + "..." : id;
}

function formatTimestamp(ts?: string | null): string {
    if (!ts) return "-";
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return ts;
    }
}

const columns: IColumn[] = [
    {
        key: "accountId",
        name: "Account ID",
        fieldName: "accountId",
        minWidth: 100,
        maxWidth: 140,
        onRender: (item: QuotaRequest) => (
            <span
                style={{ color: "#ccc", fontFamily: "monospace", fontSize: 11 }}
                title={item.accountId}
            >
                {formatShortId(item.accountId)}
            </span>
        ),
    },
    {
        key: "subscriptionId",
        name: "Subscription",
        fieldName: "subscriptionId",
        minWidth: 100,
        maxWidth: 140,
        onRender: (item: QuotaRequest) => (
            <span
                style={{ color: "#999", fontFamily: "monospace", fontSize: 11 }}
                title={item.subscriptionId}
            >
                {formatShortId(item.subscriptionId)}
            </span>
        ),
    },
    {
        key: "region",
        name: "Region",
        fieldName: "region",
        minWidth: 90,
        maxWidth: 130,
        onRender: (item: QuotaRequest) => (
            <span style={{ color: "#ccc" }}>{item.region}</span>
        ),
    },
    {
        key: "quotaType",
        name: "Quota Type",
        fieldName: "quotaType",
        minWidth: 80,
        maxWidth: 110,
        onRender: (item: QuotaRequest) => (
            <span style={{ color: "#8764b8" }}>{item.quotaType}</span>
        ),
    },
    {
        key: "requestedLimit",
        name: "Requested",
        fieldName: "requestedLimit",
        minWidth: 70,
        maxWidth: 90,
        onRender: (item: QuotaRequest) => (
            <span style={{ color: "#e3a400", fontWeight: 600 }}>
                {item.requestedLimit}
            </span>
        ),
    },
    {
        key: "status",
        name: "Status",
        fieldName: "status",
        minWidth: 90,
        maxWidth: 110,
        onRender: (item: QuotaRequest) => renderStatusBadge(item.status),
    },
    {
        key: "submittedAt",
        name: "Submitted",
        fieldName: "submittedAt",
        minWidth: 130,
        maxWidth: 170,
        onRender: (item: QuotaRequest) => (
            <span style={{ color: "#888", fontSize: 11 }}>
                {formatTimestamp(item.submittedAt)}
            </span>
        ),
    },
    {
        key: "lastCheckedAt",
        name: "Last Checked",
        fieldName: "lastCheckedAt",
        minWidth: 130,
        maxWidth: 170,
        onRender: (item: QuotaRequest) => (
            <span style={{ color: "#888", fontSize: 11 }}>
                {formatTimestamp(item.lastCheckedAt)}
            </span>
        ),
    },
];

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export const SupportTicketPage: React.FC<{
    orchestrator: OrchestratorAgent;
}> = ({ orchestrator }) => {
    const state = useMultiRegionState();
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [checking, setChecking] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [page, setPage] = React.useState(1);
    const [pageSize, setPageSize] = React.useState(25);

    const quotaRequests = state.quotaRequests ?? [];

    // Reset page when data changes
    React.useEffect(() => {
        setPage(1);
    }, [quotaRequests.length]);

    // Paginate
    const paginatedRequests = React.useMemo(() => {
        const start = (page - 1) * pageSize;
        return quotaRequests.slice(start, start + pageSize);
    }, [quotaRequests, page, pageSize]);

    // Auto-refresh every 60s
    React.useEffect(() => {
        if (!autoRefresh) return;
        const interval = setInterval(async () => {
            try {
                await orchestrator.execute({
                    action: "check_quota_status",
                    payload: {},
                });
            } catch {
                /* silent */
            }
        }, 60000);
        return () => clearInterval(interval);
    }, [autoRefresh, orchestrator]);

    const handleCheckStatus = React.useCallback(async () => {
        setChecking(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "check_quota_status",
                payload: {},
            });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
        } finally {
            setChecking(false);
        }
    }, [orchestrator]);

    return (
        <div style={{ padding: "16px 0" }}>
            <style>{SKELETON_KEYFRAMES}</style>

            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 12 }}
                styles={{ root: { marginBottom: 16 } }}
            >
                <Icon
                    iconName="Ticket"
                    styles={{ root: { fontSize: 20, color: "#0078d4" } }}
                />
                <Text
                    variant="xLarge"
                    styles={{ root: { fontWeight: 600, color: "#eee" } }}
                >
                    Support Tickets
                </Text>
                <Text
                    variant="small"
                    styles={{ root: { color: "#888" } }}
                    role="status"
                    aria-live="polite"
                >
                    {quotaRequests.length} quota request
                    {quotaRequests.length !== 1 ? "s" : ""}
                </Text>
                <div
                    style={{
                        marginLeft: "auto",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                    }}
                >
                    <Toggle
                        label="Auto-refresh (60s)"
                        inlineLabel
                        checked={autoRefresh}
                        onChange={(_e, checked) =>
                            setAutoRefresh(checked ?? false)
                        }
                        aria-label="Toggle auto-refresh every 60 seconds"
                        styles={{
                            root: { marginBottom: 0 },
                            label: { color: "#999", fontSize: 11 },
                        }}
                    />
                    <PrimaryButton
                        text="Check Status"
                        iconProps={{ iconName: "Refresh" }}
                        onClick={handleCheckStatus}
                        disabled={checking || quotaRequests.length === 0}
                        aria-label="Check quota request status"
                    />
                    {checking && (
                        <Spinner
                            size={SpinnerSize.small}
                            aria-label="Checking status"
                        />
                    )}
                </div>
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
                            onClick={handleCheckStatus}
                            aria-label="Retry checking status"
                        />
                    }
                >
                    {error}
                </MessageBar>
            )}

            {/* Skeleton when checking with empty data */}
            {checking && quotaRequests.length === 0 ? (
                <TableSkeleton />
            ) : quotaRequests.length === 0 ? (
                <Stack
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}
                    styles={{
                        root: {
                            background: "#252525",
                            borderRadius: 8,
                            padding: 32,
                        },
                    }}
                    role="status"
                >
                    <Icon
                        iconName="Ticket"
                        styles={{
                            root: {
                                fontSize: 48,
                                color: "#555",
                                display: "block",
                            },
                        }}
                    />
                    <Text
                        variant="large"
                        styles={{ root: { color: "#888", fontWeight: 600 } }}
                    >
                        No quota requests found
                    </Text>
                    <Text variant="medium" styles={{ root: { color: "#666" } }}>
                        Submit quota increase requests from the Quotas page.
                    </Text>
                </Stack>
            ) : (
                <>
                    <div
                        style={{
                            background: "#252525",
                            borderRadius: 8,
                            padding: 8,
                        }}
                    >
                        <DetailsList
                            items={paginatedRequests}
                            columns={columns}
                            layoutMode={DetailsListLayoutMode.fixedColumns}
                            selectionMode={SelectionMode.none}
                            compact
                            styles={{
                                root: {
                                    ".ms-DetailsHeader": {
                                        background: "#1e1e1e",
                                        borderBottom: "1px solid #333",
                                    },
                                    ".ms-DetailsHeader-cell": {
                                        color: "#888",
                                        fontSize: 11,
                                    },
                                    ".ms-DetailsRow": {
                                        background: "transparent",
                                        borderBottom: "1px solid #2a2a2a",
                                    },
                                    ".ms-DetailsRow:hover": {
                                        background: "#2a2a2a",
                                    },
                                },
                            }}
                        />
                    </div>
                    {quotaRequests.length > 10 && (
                        <Pagination
                            page={page}
                            pageSize={pageSize}
                            totalItems={quotaRequests.length}
                            onPageChange={setPage}
                            onPageSizeChange={(s) => {
                                setPageSize(s);
                                setPage(1);
                            }}
                        />
                    )}
                </>
            )}
        </div>
    );
};
