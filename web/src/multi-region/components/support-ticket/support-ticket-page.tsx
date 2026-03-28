import * as React from "react";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { Icon } from "@fluentui/react/lib/Icon";
import { PrimaryButton } from "@fluentui/react/lib/Button";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { QuotaRequest, QuotaRequestStatus } from "../../store/store-types";

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

export const SupportTicketPage: React.FC<{
    orchestrator: OrchestratorAgent;
}> = ({ orchestrator }) => {
    const state = useMultiRegionState();
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [checking, setChecking] = React.useState(false);

    const quotaRequests = state.quotaRequests ?? [];

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
        try {
            await orchestrator.execute({
                action: "check_quota_status",
                payload: {},
            });
        } catch {
            /* handled by orchestrator */
        } finally {
            setChecking(false);
        }
    }, [orchestrator]);

    return (
        <div style={{ padding: "16px 0" }}>
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
                <Text variant="small" styles={{ root: { color: "#888" } }}>
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
                    />
                    {checking && <Spinner size={SpinnerSize.small} />}
                </div>
            </Stack>

            {quotaRequests.length === 0 ? (
                <div
                    style={{
                        background: "#252525",
                        borderRadius: 8,
                        padding: 32,
                        textAlign: "center",
                    }}
                >
                    <Icon
                        iconName="Ticket"
                        styles={{
                            root: {
                                fontSize: 48,
                                color: "#333",
                                marginBottom: 12,
                                display: "block",
                            },
                        }}
                    />
                    <Text variant="medium" styles={{ root: { color: "#888" } }}>
                        No quota requests yet. Submit quota increase requests
                        from the Quotas page.
                    </Text>
                </div>
            ) : (
                <div
                    style={{
                        background: "#252525",
                        borderRadius: 8,
                        padding: 8,
                    }}
                >
                    <DetailsList
                        items={quotaRequests}
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
            )}
        </div>
    );
};
