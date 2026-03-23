import * as React from "react";
import { Stack, IStackTokens, IStackStyles } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { SearchBox } from "@fluentui/react/lib/SearchBox";
import {
    PrimaryButton,
    DefaultButton,
    IconButton,
} from "@fluentui/react/lib/Button";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { Separator } from "@fluentui/react/lib/Separator";
import { Dialog, DialogType, DialogFooter } from "@fluentui/react/lib/Dialog";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import { useAppTheme } from "@azure/bonito-ui/lib/theme";
import { getEnvironment } from "@azure/bonito-core";
import { BatchDependencyName } from "@batch/ui-service/lib/environment";
import type { PoolService } from "@batch/ui-service/lib/pool/pool-service";
import type { PoolOutput } from "@batch/ui-service/lib/pool/pool-models";

interface PoolListViewProps {
    refreshKey?: number;
}

const FAKE_ACCOUNT_ID =
    "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/supercomputing/providers/Microsoft.Batch/batchAccounts/hobo";

const sectionTokens: IStackTokens = { childrenGap: 12 };

export const PoolListView: React.FC<PoolListViewProps> = ({ refreshKey }) => {
    const theme = useAppTheme();
    const [pools, setPools] = React.useState<PoolOutput[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [searchText, setSearchText] = React.useState("");
    const [selectedPool, setSelectedPool] = React.useState<PoolOutput | null>(
        null
    );
    const [detailOpen, setDetailOpen] = React.useState(false);

    const loadPools = React.useCallback(async () => {
        setLoading(true);
        try {
            const poolService = getEnvironment().getInjectable<PoolService>(
                BatchDependencyName.PoolService
            );
            const result = await poolService.listByAccountId(FAKE_ACCOUNT_ID);
            setPools(result);
        } catch {
            setPools([]);
        }
        setLoading(false);
    }, []);

    React.useEffect(() => {
        loadPools();
    }, [loadPools, refreshKey]);

    const filteredPools = React.useMemo(() => {
        if (!searchText) return pools;
        const lower = searchText.toLowerCase();
        return pools.filter(
            (p) =>
                p.name?.toLowerCase().includes(lower) ||
                p.properties?.vmSize?.toLowerCase().includes(lower) ||
                p.properties?.allocationState?.toLowerCase().includes(lower)
        );
    }, [pools, searchText]);

    const cardStyles: IStackStyles = {
        root: {
            background: theme.palette.white,
            padding: "24px",
            borderRadius: "8px",
            boxShadow: theme.effects.elevation4,
            marginTop: "16px",
        },
    };

    const columns: IColumn[] = [
        {
            key: "name",
            name: "Pool Name",
            fieldName: "name",
            minWidth: 150,
            maxWidth: 250,
            isResizable: true,
            onRender: (item: PoolOutput) => (
                <Text
                    variant="medium"
                    style={{
                        fontWeight: 600,
                        color: theme.palette.themePrimary,
                        cursor: "pointer",
                    }}
                    onClick={() => {
                        setSelectedPool(item);
                        setDetailOpen(true);
                    }}
                >
                    {item.name}
                </Text>
            ),
        },
        {
            key: "vmSize",
            name: "VM Size",
            minWidth: 120,
            maxWidth: 200,
            isResizable: true,
            onRender: (item: PoolOutput) => (
                <Text>{item.properties?.vmSize || "N/A"}</Text>
            ),
        },
        {
            key: "state",
            name: "State",
            minWidth: 80,
            maxWidth: 120,
            isResizable: true,
            onRender: (item: PoolOutput) => {
                const state = item.properties?.allocationState ?? "Unknown";
                const color =
                    state === "Steady"
                        ? theme.palette.green
                        : state === "Resizing"
                          ? theme.palette.yellow
                          : theme.palette.neutralSecondary;
                return (
                    <Text
                        style={{
                            color,
                            fontWeight: 600,
                        }}
                    >
                        {state}
                    </Text>
                );
            },
        },
        {
            key: "dedicated",
            name: "Dedicated",
            minWidth: 80,
            maxWidth: 100,
            isResizable: true,
            onRender: (item: PoolOutput) => (
                <Text>
                    {item.properties?.currentDedicatedNodes ?? 0}/
                    {item.properties?.scaleSettings?.fixedScale
                        ?.targetDedicatedNodes ?? 0}
                </Text>
            ),
        },
        {
            key: "lowPri",
            name: "Low-Priority",
            minWidth: 80,
            maxWidth: 100,
            isResizable: true,
            onRender: (item: PoolOutput) => (
                <Text>
                    {item.properties?.currentLowPriorityNodes ?? 0}/
                    {item.properties?.scaleSettings?.fixedScale
                        ?.targetLowPriorityNodes ?? 0}
                </Text>
            ),
        },
        {
            key: "taskSlots",
            name: "Task Slots",
            minWidth: 80,
            maxWidth: 100,
            isResizable: true,
            onRender: (item: PoolOutput) => (
                <Text>{item.properties?.taskSlotsPerNode ?? 1}</Text>
            ),
        },
        {
            key: "actions",
            name: "",
            minWidth: 40,
            maxWidth: 40,
            onRender: (item: PoolOutput) => (
                <IconButton
                    iconProps={{ iconName: "Info" }}
                    title="View details"
                    onClick={() => {
                        setSelectedPool(item);
                        setDetailOpen(true);
                    }}
                />
            ),
        },
    ];

    const totalDedicated = pools.reduce(
        (sum, p) => sum + (p.properties?.currentDedicatedNodes ?? 0),
        0
    );
    const totalLowPri = pools.reduce(
        (sum, p) => sum + (p.properties?.currentLowPriorityNodes ?? 0),
        0
    );

    return (
        <Stack tokens={sectionTokens}>
            {/* Stats bar */}
            <Stack styles={cardStyles}>
                <Stack
                    horizontal
                    tokens={{ childrenGap: 32 }}
                    verticalAlign="center"
                    wrap
                >
                    <StatBadge
                        label="Total Pools"
                        value={pools.length}
                        color={theme.palette.themePrimary}
                    />
                    <StatBadge
                        label="Dedicated Nodes"
                        value={totalDedicated}
                        color={theme.palette.green}
                    />
                    <StatBadge
                        label="Low-Priority Nodes"
                        value={totalLowPri}
                        color={theme.palette.yellow}
                    />
                    <StatBadge
                        label="Total Nodes"
                        value={totalDedicated + totalLowPri}
                        color={theme.palette.themeDarkAlt}
                    />
                    <Stack.Item grow>
                        <Stack
                            horizontal
                            horizontalAlign="end"
                            tokens={{ childrenGap: 8 }}
                        >
                            <DefaultButton
                                text="Refresh"
                                iconProps={{ iconName: "Refresh" }}
                                onClick={loadPools}
                            />
                        </Stack>
                    </Stack.Item>
                </Stack>
            </Stack>

            {/* Pool list */}
            <Stack styles={cardStyles} tokens={sectionTokens}>
                <Stack
                    horizontal
                    verticalAlign="center"
                    tokens={{ childrenGap: 16 }}
                >
                    <Text variant="xLarge" style={{ fontWeight: 600 }}>
                        Pools ({filteredPools.length})
                    </Text>
                    <Stack.Item grow>
                        <SearchBox
                            placeholder="Search pools by name, VM size, or state..."
                            value={searchText}
                            onChange={(_, val) => setSearchText(val || "")}
                            styles={{ root: { maxWidth: 400 } }}
                        />
                    </Stack.Item>
                </Stack>
                <Separator />

                {loading ? (
                    <Spinner
                        size={SpinnerSize.large}
                        label="Loading pools..."
                    />
                ) : filteredPools.length === 0 ? (
                    <MessageBar messageBarType={MessageBarType.info}>
                        No pools found. Use the &quot;Bulk Create Pools&quot;
                        tab to create pools.
                    </MessageBar>
                ) : (
                    <DetailsList
                        items={filteredPools}
                        columns={columns}
                        layoutMode={DetailsListLayoutMode.justified}
                        selectionMode={SelectionMode.none}
                        isHeaderVisible={true}
                    />
                )}
            </Stack>

            {/* Pool detail dialog */}
            <Dialog
                hidden={!detailOpen}
                onDismiss={() => setDetailOpen(false)}
                dialogContentProps={{
                    type: DialogType.largeHeader,
                    title: selectedPool?.name ?? "Pool Details",
                    subText: selectedPool?.id,
                }}
                minWidth={600}
                maxWidth={800}
            >
                {selectedPool && <PoolDetailPanel pool={selectedPool} />}
                <DialogFooter>
                    <PrimaryButton
                        text="Close"
                        onClick={() => setDetailOpen(false)}
                    />
                </DialogFooter>
            </Dialog>
        </Stack>
    );
};

const StatBadge: React.FC<{
    label: string;
    value: number;
    color: string;
}> = ({ label, value, color }) => (
    <Stack horizontalAlign="center" styles={{ root: { minWidth: 100 } }}>
        <Text variant="xxLarge" style={{ fontWeight: 700, color }}>
            {value.toLocaleString()}
        </Text>
        <Text variant="small" style={{ color: "#888" }}>
            {label}
        </Text>
    </Stack>
);

const PoolDetailPanel: React.FC<{ pool: PoolOutput }> = ({ pool }) => {
    const theme = useAppTheme();
    const props = pool.properties;

    const rows: Array<{ label: string; value: string }> = [
        { label: "Pool Name", value: pool.name ?? "N/A" },
        { label: "VM Size", value: props?.vmSize ?? "N/A" },
        {
            label: "Provisioning State",
            value: props?.provisioningState ?? "N/A",
        },
        { label: "Allocation State", value: props?.allocationState ?? "N/A" },
        {
            label: "Dedicated Nodes (current/target)",
            value: `${props?.currentDedicatedNodes ?? 0} / ${props?.scaleSettings?.fixedScale?.targetDedicatedNodes ?? 0}`,
        },
        {
            label: "Low-Priority Nodes (current/target)",
            value: `${props?.currentLowPriorityNodes ?? 0} / ${props?.scaleSettings?.fixedScale?.targetLowPriorityNodes ?? 0}`,
        },
        {
            label: "Task Slots per Node",
            value: String(props?.taskSlotsPerNode ?? 1),
        },
        {
            label: "Inter-Node Communication",
            value: props?.interNodeCommunication ?? "Disabled",
        },
        {
            label: "OS Image",
            value: props?.deploymentConfiguration?.virtualMachineConfiguration
                ?.imageReference
                ? `${props.deploymentConfiguration.virtualMachineConfiguration.imageReference.publisher} / ${props.deploymentConfiguration.virtualMachineConfiguration.imageReference.offer} / ${props.deploymentConfiguration.virtualMachineConfiguration.imageReference.sku}`
                : "N/A",
        },
        {
            label: "Created",
            value: props?.creationTime
                ? new Date(props.creationTime as string).toLocaleString()
                : "N/A",
        },
    ];

    return (
        <Stack tokens={{ childrenGap: 6 }} style={{ padding: "8px 0" }}>
            {rows.map((r) => (
                <Stack
                    key={r.label}
                    horizontal
                    tokens={{ childrenGap: 8 }}
                    verticalAlign="center"
                    styles={{
                        root: {
                            padding: "4px 0",
                            borderBottom: `1px solid ${theme.palette.neutralLight}`,
                        },
                    }}
                >
                    <Text
                        variant="medium"
                        style={{
                            fontWeight: 600,
                            minWidth: 220,
                            color: theme.palette.neutralPrimary,
                        }}
                    >
                        {r.label}
                    </Text>
                    <Text variant="medium">{r.value}</Text>
                </Stack>
            ))}
        </Stack>
    );
};
