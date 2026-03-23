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
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { AccountInfo } from "../../store/store-types";

export interface AccountInfoPageProps {
    orchestrator: OrchestratorAgent;
}

function usageColor(used: number, quota: number): string {
    if (quota <= 0) return "#999";
    const pct = (used / quota) * 100;
    if (pct > 95) return "#d13438";
    if (pct > 80) return "#e3a400";
    return "#ccc";
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
    const color = usageColor(used, quota);
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

export const AccountInfoPage: React.FC<AccountInfoPageProps> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const [loading, setLoading] = React.useState(false);
    const [autoRefresh, setAutoRefresh] = React.useState(false);
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

    // Auto-refresh
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

    const accounts = state.accountInfos;

    // Summary stats
    const totalAccounts = accounts.length;
    const totalDedicatedQuota = accounts.reduce(
        (s, a) => s + a.dedicatedCoreQuota,
        0
    );
    const totalLpUsed = accounts.reduce(
        (s, a) => s + a.lowPriorityCoresUsed,
        0
    );
    const totalLpQuota = accounts.reduce(
        (s, a) => s + a.lowPriorityCoreQuota,
        0
    );
    const totalLpFree = totalLpQuota - totalLpUsed;
    const totalPools = accounts.reduce((s, a) => s + a.poolCount, 0);

    const columns: IColumn[] = React.useMemo(
        () => [
            {
                key: "accountName",
                name: "Account Name",
                fieldName: "accountName",
                minWidth: 120,
                maxWidth: 200,
                isResizable: true,
            },
            {
                key: "region",
                name: "Region",
                fieldName: "region",
                minWidth: 80,
                maxWidth: 120,
                isResizable: true,
            },
            {
                key: "subscription",
                name: "Subscription",
                minWidth: 100,
                maxWidth: 160,
                isResizable: true,
                onRender: (item: AccountInfo) => (
                    <span
                        style={{ fontSize: 11, color: "#999" }}
                        title={item.subscriptionId}
                    >
                        {item.subscriptionId.substring(0, 13)}...
                    </span>
                ),
            },
            {
                key: "dedicatedCores",
                name: "Dedicated Cores",
                minWidth: 110,
                maxWidth: 140,
                isResizable: true,
                onRender: (item: AccountInfo) => (
                    <UsageBar
                        used={item.dedicatedCoresUsed}
                        quota={item.dedicatedCoreQuota}
                    />
                ),
            },
            {
                key: "lowPriorityCores",
                name: "Low Priority Cores",
                minWidth: 110,
                maxWidth: 140,
                isResizable: true,
                onRender: (item: AccountInfo) => (
                    <UsageBar
                        used={item.lowPriorityCoresUsed}
                        quota={item.lowPriorityCoreQuota}
                    />
                ),
            },
            {
                key: "pools",
                name: "Pools",
                minWidth: 80,
                maxWidth: 100,
                isResizable: true,
                onRender: (item: AccountInfo) => (
                    <span
                        style={{
                            color: usageColor(item.poolCount, item.poolQuota),
                        }}
                    >
                        {item.poolCount} / {item.poolQuota}
                    </span>
                ),
            },
            {
                key: "jobsQuota",
                name: "Jobs Quota",
                fieldName: "activeJobAndJobScheduleQuota",
                minWidth: 70,
                maxWidth: 90,
                isResizable: true,
            },
            {
                key: "freeDedicated",
                name: "Free Dedicated",
                minWidth: 80,
                maxWidth: 100,
                isResizable: true,
                onRender: (item: AccountInfo) => (
                    <span
                        style={{
                            color:
                                item.dedicatedCoresFree > 0
                                    ? "#107c10"
                                    : "#999",
                            fontWeight: item.dedicatedCoresFree > 0 ? 600 : 400,
                        }}
                    >
                        {item.dedicatedCoresFree}
                    </span>
                ),
            },
            {
                key: "freeLowPriority",
                name: "Free Low Priority",
                minWidth: 90,
                maxWidth: 110,
                isResizable: true,
                onRender: (item: AccountInfo) => (
                    <span
                        style={{
                            color:
                                item.lowPriorityCoresFree > 0
                                    ? "#107c10"
                                    : "#999",
                            fontWeight:
                                item.lowPriorityCoresFree > 0 ? 600 : 400,
                        }}
                    >
                        {item.lowPriorityCoresFree}
                    </span>
                ),
            },
            {
                key: "freePoolSlots",
                name: "Free Pool Slots",
                minWidth: 80,
                maxWidth: 100,
                isResizable: true,
                onRender: (item: AccountInfo) => (
                    <span
                        style={{
                            color: item.poolsFree > 0 ? "#107c10" : "#999",
                            fontWeight: item.poolsFree > 0 ? 600 : 400,
                        }}
                    >
                        {item.poolsFree}
                    </span>
                ),
            },
        ],
        []
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
                    text="Refresh Account Info"
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
                    No account info available. Click "Refresh Account Info" to
                    load data.
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
                {value}
                {suffix ?? ""}
            </Text>
        </div>
    </Stack>
);
