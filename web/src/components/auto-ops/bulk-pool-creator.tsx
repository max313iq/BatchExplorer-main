import * as React from "react";
import { Stack, IStackTokens, IStackStyles } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import {
    PrimaryButton,
    DefaultButton,
    IconButton,
} from "@fluentui/react/lib/Button";
import { TextField } from "@fluentui/react/lib/TextField";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { SpinButton } from "@fluentui/react/lib/SpinButton";
import { ProgressIndicator } from "@fluentui/react/lib/ProgressIndicator";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { Separator } from "@fluentui/react/lib/Separator";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { useAppTheme } from "@azure/bonito-ui/lib/theme";
import { getEnvironment } from "@azure/bonito-core";
import { BatchDependencyName } from "@batch/ui-service/lib/environment";
import type { PoolService } from "@batch/ui-service/lib/pool/pool-service";
import type { Pool } from "@batch/ui-service/lib/pool/pool-models";

interface BulkPoolCreatorProps {
    onCreated?: () => void;
}

interface PoolTemplate {
    namePrefix: string;
    vmSize: string;
    dedicatedNodes: number;
    lowPriorityNodes: number;
    taskSlotsPerNode: number;
    osPublisher: string;
    osOffer: string;
    osSku: string;
    interNodeComm: boolean;
}

interface CreationProgress {
    total: number;
    completed: number;
    failed: number;
    inProgress: boolean;
    errors: string[];
}

const VM_SIZE_OPTIONS: IDropdownOption[] = [
    { key: "STANDARD_D2S_V3", text: "Standard_D2s_v3 (2 vCPUs, 8 GB)" },
    { key: "STANDARD_D4S_V3", text: "Standard_D4s_v3 (4 vCPUs, 16 GB)" },
    { key: "STANDARD_D8S_V3", text: "Standard_D8s_v3 (8 vCPUs, 32 GB)" },
    { key: "STANDARD_D16S_V3", text: "Standard_D16s_v3 (16 vCPUs, 64 GB)" },
    { key: "STANDARD_DS3_V2", text: "Standard_DS3_v2 (4 vCPUs, 14 GB)" },
    { key: "STANDARD_F2S_V2", text: "Standard_F2s_v2 (2 vCPUs, 4 GB)" },
    { key: "STANDARD_F4S_V2", text: "Standard_F4s_v2 (4 vCPUs, 8 GB)" },
    { key: "STANDARD_F8S_V2", text: "Standard_F8s_v2 (8 vCPUs, 16 GB)" },
    { key: "STANDARD_F16S_V2", text: "Standard_F16s_v2 (16 vCPUs, 32 GB)" },
    { key: "STANDARD_NC6", text: "Standard_NC6 (6 vCPUs, 56 GB, 1 GPU)" },
    { key: "STANDARD_NC24", text: "Standard_NC24 (24 vCPUs, 224 GB, 4 GPUs)" },
    {
        key: "STANDARD_HB120RS_V3",
        text: "Standard_HB120rs_v3 (120 vCPUs, 448 GB, HPC)",
    },
];

const OS_PRESETS: IDropdownOption[] = [
    {
        key: "ubuntu2204",
        text: "Ubuntu Server 22.04 LTS",
        data: {
            publisher: "canonical",
            offer: "0001-com-ubuntu-server-jammy",
            sku: "22_04-lts",
        },
    },
    {
        key: "ubuntu2004",
        text: "Ubuntu Server 20.04 LTS",
        data: {
            publisher: "Canonical",
            offer: "0001-com-ubuntu-server-focal",
            sku: "20_04-lts",
        },
    },
    {
        key: "windows2022",
        text: "Windows Server 2022 Datacenter",
        data: {
            publisher: "microsoftwindowsserver",
            offer: "windowsserver",
            sku: "2022-datacenter",
        },
    },
    {
        key: "windows2019",
        text: "Windows Server 2019 Datacenter",
        data: {
            publisher: "microsoftwindowsserver",
            offer: "windowsserver",
            sku: "2019-datacenter",
        },
    },
    {
        key: "centos79",
        text: "CentOS 7.9",
        data: {
            publisher: "openlogic",
            offer: "centos",
            sku: "7_9",
        },
    },
];

const FAKE_ACCOUNT_BASE =
    "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/supercomputing/providers/Microsoft.Batch/batchAccounts/hobo";

const sectionTokens: IStackTokens = { childrenGap: 12 };
const formRowTokens: IStackTokens = { childrenGap: 16 };

export const BulkPoolCreator: React.FC<BulkPoolCreatorProps> = ({
    onCreated,
}) => {
    const theme = useAppTheme();

    const [poolCount, setPoolCount] = React.useState(5);
    const [template, setTemplate] = React.useState<PoolTemplate>({
        namePrefix: "auto-pool",
        vmSize: "STANDARD_D2S_V3",
        dedicatedNodes: 2,
        lowPriorityNodes: 0,
        taskSlotsPerNode: 1,
        osPublisher: "canonical",
        osOffer: "0001-com-ubuntu-server-jammy",
        osSku: "22_04-lts",
        interNodeComm: false,
    });

    const [progress, setProgress] = React.useState<CreationProgress>({
        total: 0,
        completed: 0,
        failed: 0,
        inProgress: false,
        errors: [],
    });

    const [showAdvanced, setShowAdvanced] = React.useState(false);

    const cardStyles: IStackStyles = {
        root: {
            background: theme.palette.white,
            padding: "24px",
            borderRadius: "8px",
            boxShadow: theme.effects.elevation4,
            marginTop: "16px",
        },
    };

    const handleCreate = React.useCallback(async () => {
        const poolService = getEnvironment().getInjectable<PoolService>(
            BatchDependencyName.PoolService
        );

        setProgress({
            total: poolCount,
            completed: 0,
            failed: 0,
            inProgress: true,
            errors: [],
        });

        const batchSize = 50;
        let completed = 0;
        let failed = 0;
        const errors: string[] = [];

        for (let i = 0; i < poolCount; i += batchSize) {
            const batchEnd = Math.min(i + batchSize, poolCount);
            const promises: Promise<void>[] = [];

            for (let j = i; j < batchEnd; j++) {
                const poolName = `${template.namePrefix}-${String(j + 1).padStart(4, "0")}`;
                const poolId = `${FAKE_ACCOUNT_BASE}/pools/${poolName}`;

                const pool: Pool = {
                    id: poolId,
                    name: poolName,
                    type: "Microsoft.Batch/batchAccounts/pools",
                    properties: {
                        displayName: poolName,
                        vmSize: template.vmSize,
                        provisioningState: "Succeeded",
                        allocationState: "Steady",
                        creationTime: new Date().toISOString(),
                        lastModified: new Date().toISOString(),
                        interNodeCommunication: template.interNodeComm
                            ? "Enabled"
                            : "Disabled",
                        taskSlotsPerNode: template.taskSlotsPerNode,
                        taskSchedulingPolicy: { nodeFillType: "Pack" },
                        deploymentConfiguration: {
                            virtualMachineConfiguration: {
                                imageReference: {
                                    publisher: template.osPublisher,
                                    offer: template.osOffer,
                                    sku: template.osSku,
                                },
                                nodeAgentSkuId:
                                    template.osPublisher === "canonical"
                                        ? `batch.node.ubuntu ${template.osSku.replace("_", ".")}`
                                        : "batch.node.windows amd64",
                            },
                        },
                        scaleSettings: {
                            fixedScale: {
                                targetDedicatedNodes: template.dedicatedNodes,
                                targetLowPriorityNodes:
                                    template.lowPriorityNodes,
                                resizeTimeout: "PT15M",
                            },
                        },
                        currentDedicatedNodes: template.dedicatedNodes,
                        currentLowPriorityNodes: template.lowPriorityNodes,
                    },
                };

                promises.push(
                    poolService
                        .createOrUpdate(poolId, pool)
                        .then(() => {
                            completed++;
                        })
                        .catch((err: Error) => {
                            failed++;
                            errors.push(`${poolName}: ${err.message}`);
                        })
                );
            }

            await Promise.all(promises);
            setProgress({
                total: poolCount,
                completed,
                failed,
                inProgress: i + batchSize < poolCount,
                errors: [...errors],
            });
        }

        setProgress((prev) => ({ ...prev, inProgress: false }));
        onCreated?.();
    }, [poolCount, template, onCreated]);

    const totalNodes =
        poolCount * (template.dedicatedNodes + template.lowPriorityNodes);
    const progressPercent =
        progress.total > 0
            ? (progress.completed + progress.failed) / progress.total
            : 0;

    return (
        <Stack tokens={sectionTokens}>
            <Stack styles={cardStyles} tokens={sectionTokens}>
                <Text variant="xLarge" style={{ fontWeight: 600 }}>
                    Pool Configuration
                </Text>
                <Separator />

                <Stack horizontal tokens={formRowTokens} wrap>
                    <Stack.Item grow styles={{ root: { minWidth: 200 } }}>
                        <TextField
                            label="Pool name prefix"
                            value={template.namePrefix}
                            onChange={(_, v) =>
                                setTemplate((t) => ({
                                    ...t,
                                    namePrefix: v || "",
                                }))
                            }
                            description="Pools named: prefix-0001, prefix-0002, ..."
                        />
                    </Stack.Item>
                    <Stack.Item styles={{ root: { minWidth: 180 } }}>
                        <SpinButton
                            label="Number of pools"
                            min={1}
                            max={5000}
                            step={1}
                            value={String(poolCount)}
                            onIncrement={(v) =>
                                setPoolCount(Math.min(Number(v) + 1, 5000))
                            }
                            onDecrement={(v) =>
                                setPoolCount(Math.max(Number(v) - 1, 1))
                            }
                            onValidate={(v) => {
                                const n = parseInt(v);
                                if (!isNaN(n) && n >= 1 && n <= 5000) {
                                    setPoolCount(n);
                                }
                                return String(poolCount);
                            }}
                        />
                    </Stack.Item>
                </Stack>

                <Stack horizontal tokens={formRowTokens} wrap>
                    <Stack.Item grow styles={{ root: { minWidth: 300 } }}>
                        <Dropdown
                            label="VM Size"
                            selectedKey={template.vmSize}
                            options={VM_SIZE_OPTIONS}
                            onChange={(_, opt) =>
                                opt &&
                                setTemplate((t) => ({
                                    ...t,
                                    vmSize: opt.key as string,
                                }))
                            }
                        />
                    </Stack.Item>
                    <Stack.Item grow styles={{ root: { minWidth: 300 } }}>
                        <Dropdown
                            label="OS Image"
                            selectedKey={
                                OS_PRESETS.find(
                                    (o) =>
                                        o.data?.publisher ===
                                            template.osPublisher &&
                                        o.data?.offer === template.osOffer
                                )?.key as string
                            }
                            options={OS_PRESETS}
                            onChange={(_, opt) => {
                                if (opt?.data) {
                                    setTemplate((t) => ({
                                        ...t,
                                        osPublisher: opt.data.publisher,
                                        osOffer: opt.data.offer,
                                        osSku: opt.data.sku,
                                    }));
                                }
                            }}
                        />
                    </Stack.Item>
                </Stack>

                <Stack horizontal tokens={formRowTokens} wrap>
                    <Stack.Item styles={{ root: { minWidth: 180 } }}>
                        <SpinButton
                            label="Dedicated nodes per pool"
                            min={0}
                            max={1000}
                            step={1}
                            value={String(template.dedicatedNodes)}
                            onIncrement={(v) =>
                                setTemplate((t) => ({
                                    ...t,
                                    dedicatedNodes: Math.min(
                                        Number(v) + 1,
                                        1000
                                    ),
                                }))
                            }
                            onDecrement={(v) =>
                                setTemplate((t) => ({
                                    ...t,
                                    dedicatedNodes: Math.max(Number(v) - 1, 0),
                                }))
                            }
                            onValidate={(v) => {
                                const n = parseInt(v);
                                if (!isNaN(n) && n >= 0 && n <= 1000) {
                                    setTemplate((t) => ({
                                        ...t,
                                        dedicatedNodes: n,
                                    }));
                                }
                                return String(template.dedicatedNodes);
                            }}
                        />
                    </Stack.Item>
                    <Stack.Item styles={{ root: { minWidth: 180 } }}>
                        <SpinButton
                            label="Low-priority nodes per pool"
                            min={0}
                            max={1000}
                            step={1}
                            value={String(template.lowPriorityNodes)}
                            onIncrement={(v) =>
                                setTemplate((t) => ({
                                    ...t,
                                    lowPriorityNodes: Math.min(
                                        Number(v) + 1,
                                        1000
                                    ),
                                }))
                            }
                            onDecrement={(v) =>
                                setTemplate((t) => ({
                                    ...t,
                                    lowPriorityNodes: Math.max(
                                        Number(v) - 1,
                                        0
                                    ),
                                }))
                            }
                            onValidate={(v) => {
                                const n = parseInt(v);
                                if (!isNaN(n) && n >= 0 && n <= 1000) {
                                    setTemplate((t) => ({
                                        ...t,
                                        lowPriorityNodes: n,
                                    }));
                                }
                                return String(template.lowPriorityNodes);
                            }}
                        />
                    </Stack.Item>
                    <Stack.Item styles={{ root: { minWidth: 180 } }}>
                        <SpinButton
                            label="Task slots per node"
                            min={1}
                            max={256}
                            step={1}
                            value={String(template.taskSlotsPerNode)}
                            onIncrement={(v) =>
                                setTemplate((t) => ({
                                    ...t,
                                    taskSlotsPerNode: Math.min(
                                        Number(v) + 1,
                                        256
                                    ),
                                }))
                            }
                            onDecrement={(v) =>
                                setTemplate((t) => ({
                                    ...t,
                                    taskSlotsPerNode: Math.max(
                                        Number(v) - 1,
                                        1
                                    ),
                                }))
                            }
                            onValidate={(v) => {
                                const n = parseInt(v);
                                if (!isNaN(n) && n >= 1 && n <= 256) {
                                    setTemplate((t) => ({
                                        ...t,
                                        taskSlotsPerNode: n,
                                    }));
                                }
                                return String(template.taskSlotsPerNode);
                            }}
                        />
                    </Stack.Item>
                </Stack>

                <Stack horizontal verticalAlign="center">
                    <IconButton
                        iconProps={{
                            iconName: showAdvanced
                                ? "ChevronDown"
                                : "ChevronRight",
                        }}
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        title="Advanced options"
                    />
                    <Text
                        variant="mediumPlus"
                        style={{ cursor: "pointer" }}
                        onClick={() => setShowAdvanced(!showAdvanced)}
                    >
                        Advanced Options
                    </Text>
                </Stack>

                {showAdvanced && (
                    <Stack tokens={sectionTokens} style={{ paddingLeft: 16 }}>
                        <Toggle
                            label="Inter-node communication"
                            checked={template.interNodeComm}
                            onChange={(_, checked) =>
                                setTemplate((t) => ({
                                    ...t,
                                    interNodeComm: !!checked,
                                }))
                            }
                            onText="Enabled"
                            offText="Disabled"
                        />
                    </Stack>
                )}
            </Stack>

            {/* Summary card */}
            <Stack styles={cardStyles} tokens={sectionTokens}>
                <Text variant="xLarge" style={{ fontWeight: 600 }}>
                    Deployment Summary
                </Text>
                <Separator />
                <Stack horizontal tokens={{ childrenGap: 32 }} wrap>
                    <SummaryItem
                        label="Pools"
                        value={poolCount.toLocaleString()}
                        color={theme.palette.themePrimary}
                    />
                    <SummaryItem
                        label="Dedicated nodes (total)"
                        value={(
                            poolCount * template.dedicatedNodes
                        ).toLocaleString()}
                        color={theme.palette.green}
                    />
                    <SummaryItem
                        label="Low-priority nodes (total)"
                        value={(
                            poolCount * template.lowPriorityNodes
                        ).toLocaleString()}
                        color={theme.palette.yellow}
                    />
                    <SummaryItem
                        label="Total nodes"
                        value={totalNodes.toLocaleString()}
                        color={theme.palette.themeDarkAlt}
                    />
                    <SummaryItem
                        label="Total task slots"
                        value={(
                            totalNodes * template.taskSlotsPerNode
                        ).toLocaleString()}
                        color={theme.palette.purpleLight}
                    />
                </Stack>
            </Stack>

            {/* Action bar */}
            <Stack
                horizontal
                tokens={{ childrenGap: 12 }}
                verticalAlign="center"
                style={{ marginTop: 8 }}
            >
                <PrimaryButton
                    text={
                        progress.inProgress
                            ? `Creating... (${progress.completed}/${progress.total})`
                            : `Create ${poolCount.toLocaleString()} Pool${poolCount !== 1 ? "s" : ""}`
                    }
                    disabled={progress.inProgress || !template.namePrefix}
                    onClick={handleCreate}
                    iconProps={{ iconName: "Rocket" }}
                    styles={{
                        root: {
                            minWidth: 200,
                            height: 40,
                        },
                    }}
                />
                <DefaultButton
                    text="Reset"
                    disabled={progress.inProgress}
                    onClick={() => {
                        setTemplate({
                            namePrefix: "auto-pool",
                            vmSize: "STANDARD_D2S_V3",
                            dedicatedNodes: 2,
                            lowPriorityNodes: 0,
                            taskSlotsPerNode: 1,
                            osPublisher: "canonical",
                            osOffer: "0001-com-ubuntu-server-jammy",
                            osSku: "22_04-lts",
                            interNodeComm: false,
                        });
                        setPoolCount(5);
                    }}
                    iconProps={{ iconName: "Refresh" }}
                />
            </Stack>

            {/* Progress */}
            {progress.total > 0 && (
                <Stack styles={cardStyles} tokens={sectionTokens}>
                    <Text variant="large" style={{ fontWeight: 600 }}>
                        Creation Progress
                    </Text>
                    <ProgressIndicator
                        percentComplete={progressPercent}
                        description={
                            progress.inProgress
                                ? `Creating pools... ${progress.completed} of ${progress.total} completed`
                                : `Done: ${progress.completed} created, ${progress.failed} failed`
                        }
                        barHeight={8}
                    />
                    {!progress.inProgress && progress.failed === 0 && (
                        <MessageBar messageBarType={MessageBarType.success}>
                            All {progress.completed} pools created successfully.
                        </MessageBar>
                    )}
                    {progress.failed > 0 && (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            {progress.failed} pool(s) failed to create.
                            {progress.errors.slice(0, 5).map((e, i) => (
                                <div key={i}>{e}</div>
                            ))}
                        </MessageBar>
                    )}
                </Stack>
            )}
        </Stack>
    );
};

const SummaryItem: React.FC<{
    label: string;
    value: string;
    color: string;
}> = ({ label, value, color }) => (
    <Stack
        horizontalAlign="center"
        styles={{
            root: {
                minWidth: 120,
                padding: "12px 16px",
                borderLeft: `4px solid ${color}`,
                borderRadius: 4,
            },
        }}
    >
        <Text
            variant="xxLarge"
            style={{ fontWeight: 700, color, lineHeight: "1.2" }}
        >
            {value}
        </Text>
        <Text variant="small" style={{ color: "#666", marginTop: 4 }}>
            {label}
        </Text>
    </Stack>
);
