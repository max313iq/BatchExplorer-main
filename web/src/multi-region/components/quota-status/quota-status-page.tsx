import * as React from "react";
import { DefaultButton } from "@fluentui/react/lib/Button";
import { Pivot, PivotItem } from "@fluentui/react/lib/Pivot";
import { Toggle } from "@fluentui/react/lib/Toggle";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import { useMultiRegionState } from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { QuotaRequest } from "../../store/store-types";

const stackTokens: IStackTokens = { childrenGap: 12 };

interface QuotaStatusPageProps {
    orchestrator: OrchestratorAgent;
}

export const QuotaStatusPage: React.FC<QuotaStatusPageProps> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const [autoRefresh, setAutoRefresh] = React.useState(false);
    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const monitorRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const pendingRequests = state.quotaRequests.filter(
        (r) => r.status === "pending" || r.status === "submitted"
    );
    const approvedRequests = state.quotaRequests.filter(
        (r) => r.status === "approved"
    );
    const deniedRequests = state.quotaRequests.filter(
        (r) => r.status === "denied"
    );

    const handleRefresh = React.useCallback(async () => {
        setIsRefreshing(true);
        try {
            await orchestrator.execute({
                action: "check_quota_status",
                payload: { mode: "one-shot" },
            });
        } finally {
            setIsRefreshing(false);
        }
    }, [orchestrator]);

    React.useEffect(() => {
        if (!autoRefresh) {
            if (monitorRef.current) clearInterval(monitorRef.current);
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

        monitorRef.current = setInterval(poll, 60000);
        poll();

        return () => {
            if (monitorRef.current) clearInterval(monitorRef.current);
        };
    }, [autoRefresh, orchestrator]);

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

    const renderTable = (items: QuotaRequest[]) => (
        <DetailsList
            items={items}
            columns={columns}
            layoutMode={DetailsListLayoutMode.justified}
            selectionMode={SelectionMode.none}
            compact
        />
    );

    return (
        <div style={{ padding: "16px" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: "20px" }}>
                Quota Status Dashboard
            </h2>

            <Stack horizontal tokens={stackTokens} verticalAlign="end">
                <DefaultButton
                    text={isRefreshing ? "Refreshing..." : "Refresh Now"}
                    disabled={isRefreshing}
                    onClick={handleRefresh}
                    iconProps={{ iconName: "Refresh" }}
                />
                <Toggle
                    label="Auto-refresh (60s)"
                    checked={autoRefresh}
                    onChange={(_e, checked) => setAutoRefresh(!!checked)}
                    inlineLabel
                />
            </Stack>

            <div style={{ marginTop: 16 }}>
                <Pivot>
                    <PivotItem
                        headerText={`Pending (${pendingRequests.length})`}
                    >
                        {pendingRequests.length > 0 ? (
                            renderTable(pendingRequests)
                        ) : (
                            <div
                                style={{
                                    padding: "24px",
                                    color: "#605e5c",
                                    textAlign: "center",
                                }}
                            >
                                No pending requests
                            </div>
                        )}
                    </PivotItem>
                    <PivotItem
                        headerText={`Approved (${approvedRequests.length})`}
                    >
                        {approvedRequests.length > 0 ? (
                            renderTable(approvedRequests)
                        ) : (
                            <div
                                style={{
                                    padding: "24px",
                                    color: "#605e5c",
                                    textAlign: "center",
                                }}
                            >
                                No approved requests
                            </div>
                        )}
                    </PivotItem>
                    <PivotItem headerText={`Denied (${deniedRequests.length})`}>
                        {deniedRequests.length > 0 ? (
                            renderTable(deniedRequests)
                        ) : (
                            <div
                                style={{
                                    padding: "24px",
                                    color: "#605e5c",
                                    textAlign: "center",
                                }}
                            >
                                No denied requests
                            </div>
                        )}
                    </PivotItem>
                </Pivot>
            </div>
        </div>
    );
};
