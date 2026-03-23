import * as React from "react";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { TextField } from "@fluentui/react/lib/TextField";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { ProgressIndicator } from "@fluentui/react/lib/ProgressIndicator";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import { MonacoEditor } from "@azure/bonito-ui/lib/components";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { IconButton } from "@fluentui/react/lib/Button";

const stackTokens: IStackTokens = { childrenGap: 12 };

const GPU_VMS = [
    {
        key: "Standard_ND40rs_v2",
        text: "ND40rs_v2 (40 vCPUs, 8×V100, 672 GB)",
        vCPUs: 40,
    },
    {
        key: "Standard_ND96isr_H100_v5",
        text: "ND96isr_H100_v5 (96 vCPUs, 8×H100, 1900 GB)",
        vCPUs: 96,
    },
    {
        key: "Standard_NC24s_v3",
        text: "NC24s_v3 (24 vCPUs, 4×V100, 448 GB)",
        vCPUs: 24,
    },
    {
        key: "Standard_NC12s_v3",
        text: "NC12s_v3 (12 vCPUs, 2×V100, 224 GB)",
        vCPUs: 12,
    },
    {
        key: "Standard_NC6s_v3",
        text: "NC6s_v3 (6 vCPUs, 1×V100, 112 GB)",
        vCPUs: 6,
    },
];

const VM_DROPDOWN_OPTIONS: IDropdownOption[] = GPU_VMS.map((vm) => ({
    key: vm.key,
    text: vm.text,
}));

const MAX_VM_SELECTIONS = 5;

const DEFAULT_POOL_CONFIG = {
    id: "pool",
    vmSize: "standard_nd40rs_v2",
    virtualMachineConfiguration: {
        nodeAgentSKUId: "batch.node.ubuntu 22.04",
        imageReference: {
            publisher: "canonical",
            offer: "0001-com-ubuntu-server-jammy",
            sku: "22_04-lts-gen2",
            version: "latest",
        },
    },
    resizeTimeout: "PT15M",
    targetDedicatedNodes: 0,
    targetLowPriorityNodes: 104,
    taskSlotsPerNode: 1,
    taskSchedulingPolicy: { nodeFillType: "Pack" },
    enableAutoScale: false,
    enableInterNodeCommunication: false,
    startTask: {
        commandLine: '/bin/bash -c "echo Hello"',
        environmentSettings: [],
        maxTaskRetryCount: 3,
        resourceFiles: [],
        userIdentity: {
            autoUser: { scope: "pool", elevationLevel: "admin" },
        },
        waitForSuccess: true,
    },
    certificateReferences: [],
    metadata: [],
    userAccounts: [],
};

interface EnvVar {
    name: string;
    value: string;
}

interface PoolCreationPageProps {
    orchestrator: OrchestratorAgent;
}

export const PoolCreationPage: React.FC<PoolCreationPageProps> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const [poolConfigJson, setPoolConfigJson] = React.useState(
        JSON.stringify(DEFAULT_POOL_CONFIG, null, 2)
    );
    const [configError, setConfigError] = React.useState<string | null>(null);
    const [selectedAccountIds, setSelectedAccountIds] = React.useState<
        Set<string>
    >(new Set());
    const [selectAll, setSelectAll] = React.useState(false);
    const [isRunning, setIsRunning] = React.useState(false);
    const [smartMode, setSmartMode] = React.useState(true);
    const [selectedVmSizes, setSelectedVmSizes] = React.useState<string[]>([]);
    const [startTaskCmd, setStartTaskCmd] = React.useState(
        '/bin/bash -c "echo Hello"'
    );
    const [envVars, setEnvVars] = React.useState<EnvVar[]>([]);

    // Load last pool config from preferences on mount
    React.useEffect(() => {
        const prefs = store.getUserPreferences();
        if (prefs.lastPoolConfig) {
            setPoolConfigJson(prefs.lastPoolConfig);
        }
    }, [store]);

    // Save pool config to preferences when editor value changes (debounced)
    const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
        null
    );
    const handleEditorChange = React.useCallback(
        (value: string) => {
            setPoolConfigJson(value);
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
            saveTimerRef.current = setTimeout(() => {
                store.saveUserPreferences({ lastPoolConfig: value });
            }, 1000);
        },
        [store]
    );

    // Cleanup debounce timer on unmount
    React.useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
        };
    }, []);

    // Only show accounts with approved quota or created status
    const eligibleAccounts = state.accounts.filter((a) => {
        if (a.provisioningState !== "created") return false;
        const quota = state.quotaRequests.find(
            (q) => q.accountId === a.id && q.status === "approved"
        );
        return quota !== undefined || state.quotaRequests.length === 0;
    });

    React.useEffect(() => {
        if (selectAll) {
            setSelectedAccountIds(new Set(eligibleAccounts.map((a) => a.id)));
        }
    }, [selectAll, eligibleAccounts.length]);

    // Env var helpers
    const addEnvVar = React.useCallback(() => {
        setEnvVars((prev) => [...prev, { name: "", value: "" }]);
    }, []);

    const removeEnvVar = React.useCallback((index: number) => {
        setEnvVars((prev) => prev.filter((_, i) => i !== index));
    }, []);

    const updateEnvVar = React.useCallback(
        (index: number, field: "name" | "value", val: string) => {
            setEnvVars((prev) =>
                prev.map((ev, i) =>
                    i === index ? { ...ev, [field]: val } : ev
                )
            );
        },
        []
    );

    const handleCreate = React.useCallback(async () => {
        try {
            setConfigError(null);
            setIsRunning(true);

            if (smartMode && selectedVmSizes.length > 0) {
                // Build environment settings from the env var UI
                const environmentSettings = envVars
                    .filter((ev) => ev.name.trim() !== "")
                    .map((ev) => ({ name: ev.name, value: ev.value }));

                // Build pool config from simple fields — no JSON editing needed
                const poolConfig = {
                    id: "pool",
                    vmSize: selectedVmSizes[0].toLowerCase(),
                    virtualMachineConfiguration: {
                        nodeAgentSKUId: "batch.node.ubuntu 22.04",
                        imageReference: {
                            publisher: "canonical",
                            offer: "0001-com-ubuntu-server-jammy",
                            sku: "22_04-lts-gen2",
                            version: "latest",
                        },
                    },
                    resizeTimeout: "PT15M",
                    targetDedicatedNodes: 0,
                    targetLowPriorityNodes: 0,
                    taskSlotsPerNode: 1,
                    taskSchedulingPolicy: { nodeFillType: "Pack" },
                    enableAutoScale: false,
                    enableInterNodeCommunication: false,
                    startTask: {
                        commandLine: startTaskCmd,
                        environmentSettings,
                        maxTaskRetryCount: 3,
                        resourceFiles: [],
                        userIdentity: {
                            autoUser: {
                                scope: "pool",
                                elevationLevel: "admin",
                            },
                        },
                        waitForSuccess: true,
                    },
                    certificateReferences: [],
                    metadata: [],
                    userAccounts: [],
                };
                await orchestrator.execute({
                    action: "create_pools_smart",
                    payload: {
                        accountIds: Array.from(selectedAccountIds),
                        vmSizes: selectedVmSizes,
                        poolConfig,
                        quotaType: "lowPriority",
                    },
                });
            } else {
                const poolConfig = JSON.parse(poolConfigJson);
                await orchestrator.execute({
                    action: "create_pools",
                    payload: {
                        accountIds: Array.from(selectedAccountIds),
                        poolConfig,
                    },
                });
            }
        } catch (e: any) {
            if (e instanceof SyntaxError) {
                setConfigError(`Invalid JSON: ${e.message}`);
            }
        } finally {
            setIsRunning(false);
        }
    }, [
        orchestrator,
        selectedAccountIds,
        poolConfigJson,
        smartMode,
        selectedVmSizes,
        startTaskCmd,
        envVars,
    ]);

    const handleRetryFailedPools = React.useCallback(() => {
        const ids = store.retryFailedPools();
        store.addNotification({
            type: "info",
            message: `Retrying ${ids.length} failed pool(s)...`,
            autoDismissMs: 5000,
        });
    }, [store]);

    const failedPoolCount = state.pools.filter(
        (p) => p.provisioningState === "failed"
    ).length;

    const accountColumns: IColumn[] = [
        {
            key: "select",
            name: "",
            minWidth: 30,
            maxWidth: 30,
            onRender: (item) => (
                <Checkbox
                    checked={selectedAccountIds.has(item.id)}
                    onChange={(_e, checked) => {
                        setSelectedAccountIds((prev) => {
                            const next = new Set(prev);
                            if (checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                        });
                    }}
                />
            ),
        },
        {
            key: "accountName",
            name: "Account",
            fieldName: "accountName",
            minWidth: 160,
        },
        { key: "region", name: "Region", fieldName: "region", minWidth: 120 },
        {
            key: "quotaStatus",
            name: "Quota",
            minWidth: 100,
            onRender: (item) => {
                const quota = state.quotaRequests.find(
                    (q) => q.accountId === item.id
                );
                return quota ? (
                    <StatusBadge status={quota.status} />
                ) : (
                    <span style={{ color: "#605e5c" }}>-</span>
                );
            },
        },
    ];

    const poolColumns: IColumn[] = [
        {
            key: "accountName",
            name: "Account",
            minWidth: 140,
            onRender: (item) => {
                const account = state.accounts.find(
                    (a) => a.id === item.accountId
                );
                return account?.accountName ?? "-";
            },
        },
        {
            key: "region",
            name: "Region",
            minWidth: 120,
            onRender: (item) => {
                const account = state.accounts.find(
                    (a) => a.id === item.accountId
                );
                return account?.region ?? "-";
            },
        },
        {
            key: "poolId",
            name: "Pool ID",
            fieldName: "poolId",
            minWidth: 100,
        },
        {
            key: "status",
            name: "Status",
            minWidth: 100,
            onRender: (item) => <StatusBadge status={item.provisioningState} />,
        },
        {
            key: "error",
            name: "Error",
            fieldName: "error",
            minWidth: 200,
            onRender: (item) =>
                item.error ? (
                    <span style={{ color: "#a80000", fontSize: "12px" }}>
                        {item.error}
                    </span>
                ) : null,
        },
    ];

    return (
        <div style={{ padding: "16px" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: "20px" }}>
                Pool Creation
            </h2>

            <Stack tokens={stackTokens}>
                <Checkbox
                    label={`Select all eligible accounts (${eligibleAccounts.length})`}
                    checked={selectAll}
                    onChange={(_e, checked) => setSelectAll(!!checked)}
                />

                {!selectAll && eligibleAccounts.length > 0 && (
                    <DetailsList
                        items={eligibleAccounts}
                        columns={accountColumns}
                        layoutMode={DetailsListLayoutMode.justified}
                        selectionMode={SelectionMode.none}
                        compact
                    />
                )}

                <Toggle
                    label="Smart Mode (recommended)"
                    inlineLabel
                    checked={smartMode}
                    onChange={(_e, checked) => setSmartMode(!!checked)}
                    onText="On"
                    offText="Off"
                />

                {smartMode ? (
                    <>
                        <MessageBar messageBarType={MessageBarType.info}>
                            Smart Mode auto-calculates node counts from
                            available LP quota. Select VM sizes in priority
                            order — if one fails (capacity/quota), it falls back
                            to the next. targetDedicatedNodes is always 0; only
                            low-priority/spot nodes are used.
                        </MessageBar>

                        <Dropdown
                            label="GPU VM Sizes (select up to 5, in priority order)"
                            placeholder="Select VM sizes..."
                            required
                            multiSelect
                            options={VM_DROPDOWN_OPTIONS}
                            selectedKeys={selectedVmSizes}
                            onChange={(_e, option) => {
                                if (!option) return;
                                setSelectedVmSizes((prev) => {
                                    if (option.selected) {
                                        if (prev.length >= MAX_VM_SELECTIONS)
                                            return prev;
                                        return [...prev, option.key as string];
                                    } else {
                                        return prev.filter(
                                            (k) => k !== option.key
                                        );
                                    }
                                });
                            }}
                            styles={{ root: { maxWidth: 500 } }}
                        />

                        {selectedVmSizes.length > 0 && (
                            <div style={{ fontSize: 12, color: "#605e5c" }}>
                                Priority order:{" "}
                                {selectedVmSizes.map((v, i) => (
                                    <span key={v}>
                                        <strong>{i + 1}.</strong>{" "}
                                        {v.replace("Standard_", "")}
                                        {i < selectedVmSizes.length - 1
                                            ? " \u2192 "
                                            : ""}
                                    </span>
                                ))}
                            </div>
                        )}

                        <TextField
                            label="Start Task Command Line"
                            multiline
                            rows={6}
                            value={startTaskCmd}
                            onChange={(_e, v) => setStartTaskCmd(v ?? "")}
                            placeholder='/bin/bash -c "apt-get update && echo setup done"'
                            styles={{
                                root: { maxWidth: 700 },
                                field: {
                                    fontFamily: "Consolas, monospace",
                                    fontSize: 13,
                                    minHeight: 120,
                                },
                            }}
                        />

                        <div>
                            <label
                                style={{
                                    fontWeight: 600,
                                    fontSize: "14px",
                                    display: "block",
                                    marginBottom: "4px",
                                }}
                            >
                                Start Task Environment Variables
                            </label>
                            {envVars.map((ev, idx) => (
                                <Stack
                                    key={idx}
                                    horizontal
                                    tokens={{ childrenGap: 8 }}
                                    verticalAlign="end"
                                    styles={{
                                        root: { marginBottom: 4 },
                                    }}
                                >
                                    <TextField
                                        placeholder="Name"
                                        value={ev.name}
                                        onChange={(_e, v) =>
                                            updateEnvVar(idx, "name", v ?? "")
                                        }
                                        styles={{
                                            root: { width: 200 },
                                            field: {
                                                fontFamily:
                                                    "Consolas, monospace",
                                                fontSize: 13,
                                            },
                                        }}
                                    />
                                    <TextField
                                        placeholder="Value"
                                        value={ev.value}
                                        onChange={(_e, v) =>
                                            updateEnvVar(idx, "value", v ?? "")
                                        }
                                        styles={{
                                            root: { width: 400 },
                                            field: {
                                                fontFamily:
                                                    "Consolas, monospace",
                                                fontSize: 13,
                                            },
                                        }}
                                    />
                                    <IconButton
                                        iconProps={{ iconName: "Delete" }}
                                        title="Remove"
                                        onClick={() => removeEnvVar(idx)}
                                        styles={{
                                            root: { color: "#a80000" },
                                        }}
                                    />
                                </Stack>
                            ))}
                            <DefaultButton
                                text="Add Environment Variable"
                                iconProps={{ iconName: "Add" }}
                                onClick={addEnvVar}
                                styles={{
                                    root: { marginTop: 4 },
                                }}
                            />
                        </div>
                    </>
                ) : (
                    <>
                        <Dropdown
                            label="GPU VM Sizes (optional, select up to 5)"
                            placeholder="Select VM sizes..."
                            multiSelect
                            options={VM_DROPDOWN_OPTIONS}
                            selectedKeys={selectedVmSizes}
                            onChange={(_e, option) => {
                                if (!option) return;
                                setSelectedVmSizes((prev) => {
                                    if (option.selected) {
                                        if (prev.length >= MAX_VM_SELECTIONS)
                                            return prev;
                                        return [...prev, option.key as string];
                                    } else {
                                        return prev.filter(
                                            (k) => k !== option.key
                                        );
                                    }
                                });
                            }}
                            styles={{ root: { maxWidth: 500 } }}
                        />

                        <div>
                            <label
                                style={{
                                    fontWeight: 600,
                                    fontSize: "14px",
                                    display: "block",
                                    marginBottom: "4px",
                                }}
                            >
                                Pool Configuration (JSON)
                            </label>
                            <MonacoEditor
                                language="json"
                                value={poolConfigJson}
                                onChange={(value) =>
                                    handleEditorChange(value ?? "")
                                }
                                containerStyle={{
                                    height: "300px",
                                    border: "1px solid #edebe9",
                                }}
                                editorOptions={{
                                    minimap: { enabled: false },
                                    scrollBeyondLastLine: false,
                                    lineNumbers: "on",
                                    fontSize: 13,
                                }}
                            />
                        </div>
                    </>
                )}

                {configError && (
                    <MessageBar messageBarType={MessageBarType.error}>
                        {configError}
                    </MessageBar>
                )}

                <Stack horizontal tokens={{ childrenGap: 8 }}>
                    <PrimaryButton
                        text={
                            isRunning
                                ? "Creating Pools..."
                                : `Create Pools on ${selectedAccountIds.size} Accounts`
                        }
                        disabled={isRunning || selectedAccountIds.size === 0}
                        onClick={handleCreate}
                        styles={{ root: { maxWidth: 300 } }}
                    />
                    {isRunning && (
                        <DefaultButton
                            text="Stop"
                            onClick={() => orchestrator.cancel()}
                            styles={{
                                root: {
                                    borderColor: "#d13438",
                                    color: "#d13438",
                                },
                            }}
                        />
                    )}
                    {failedPoolCount > 0 && !isRunning && (
                        <DefaultButton
                            text={`Retry Failed Pools (${failedPoolCount})`}
                            onClick={handleRetryFailedPools}
                            iconProps={{ iconName: "Refresh" }}
                        />
                    )}
                </Stack>
            </Stack>

            {isRunning && (
                <ProgressIndicator
                    label="Creating pools..."
                    styles={{ root: { marginTop: 16 } }}
                />
            )}

            {state.pools.length > 0 && (
                <div style={{ marginTop: 16 }}>
                    <h3 style={{ fontSize: "16px", margin: "0 0 8px" }}>
                        Pool Results
                    </h3>
                    <DetailsList
                        items={state.pools}
                        columns={poolColumns}
                        layoutMode={DetailsListLayoutMode.justified}
                        selectionMode={SelectionMode.none}
                        compact
                    />
                </div>
            )}
        </div>
    );
};
