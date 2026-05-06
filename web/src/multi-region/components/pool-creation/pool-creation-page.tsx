import * as React from "react";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { TextField } from "@fluentui/react/lib/TextField";
import { Toggle } from "@fluentui/react/lib/Toggle";
import { SpinButton } from "@fluentui/react/lib/SpinButton";
import { ProgressIndicator } from "@fluentui/react/lib/ProgressIndicator";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { MonacoEditor } from "@azure/bonito-ui/lib/components";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { IconButton } from "@fluentui/react/lib/Button";
import { buildPoolConfigFromDefaults } from "../../store/pool-defaults";
import { getAllVmSizes } from "../shared/vm-sizes";
import { ErrorBoundary } from "../shared/error-boundary";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { ConfirmationDialog } from "../shared/confirmation-dialog";

const stackTokens: IStackTokens = { childrenGap: 12 };

// Azure Batch pool ID: 1-64 chars, alphanumeric, hyphen, underscore.
const POOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const POOL_ID_ERROR_ID = "pool-id-error";
const POOL_JSON_ERROR_ID = "pool-json-error";

function validatePoolId(id: unknown): string | null {
    if (typeof id !== "string" || id.length === 0) {
        return "Pool ID is required.";
    }
    if (!POOL_ID_PATTERN.test(id)) {
        return "Pool ID must be 1-64 chars, alphanumeric/underscore/hyphen only.";
    }
    return null;
}

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

const PoolCreationPageInner: React.FC<PoolCreationPageProps> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const poolDefaults = (state as unknown as Record<string, unknown>)
        .poolDefaults as
        | import("../../store/pool-defaults").PoolDefaults
        | undefined;
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
    const [startTaskCmd, setStartTaskCmd] = React.useState(
        poolDefaults?.startTask?.commandLine ??
            DEFAULT_POOL_CONFIG.startTask.commandLine
    );
    const [envVars, setEnvVars] = React.useState<EnvVar[]>([]);
    const [maxRetryCount, setMaxRetryCount] = React.useState(3);
    const [waitForSuccess, setWaitForSuccess] = React.useState(true);
    const [poolIdInput, setPoolIdInput] = React.useState("pool");
    const [poolIdError, setPoolIdError] = React.useState<string | null>(null);
    const [confirmHidden, setConfirmHidden] = React.useState(true);
    const poolIdFieldRef = React.useRef<{ focus(): void } | null>(null);
    const jsonEditorContainerRef = React.useRef<HTMLDivElement | null>(null);

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

    // Check if any pool is currently resizing
    const resizingPools = (state.poolInfos ?? []).filter(
        (p) =>
            p.allocationState === "resizing" || p.allocationState === "stopping"
    );

    // Validate inline before submit; focus first error on failure.
    const validateBeforeSubmit = React.useCallback((): boolean => {
        setConfigError(null);
        setPoolIdError(null);

        if (smartMode && resizingPools.length > 0) {
            setConfigError(
                `Cannot create pools while ${resizingPools.length} pool(s) are still resizing. Wait for them to finish or stop them first.`
            );
            return false;
        }

        if (smartMode) {
            const idErr = validatePoolId(poolIdInput);
            if (idErr) {
                setPoolIdError(idErr);
                // Move focus to the offending input.
                requestAnimationFrame(() => {
                    poolIdFieldRef.current?.focus();
                });
                return false;
            }
        } else {
            // JSON mode: parse + validate the embedded pool id pattern up front.
            let parsed: unknown;
            try {
                parsed = JSON.parse(poolConfigJson);
            } catch (e) {
                setConfigError(
                    `Invalid JSON: ${(e as Error).message ?? "parse error"}`
                );
                requestAnimationFrame(() => {
                    jsonEditorContainerRef.current?.focus();
                });
                return false;
            }
            const id = (parsed as { id?: unknown })?.id;
            const idErr = validatePoolId(id);
            if (idErr) {
                setConfigError(`Pool config: ${idErr}`);
                requestAnimationFrame(() => {
                    jsonEditorContainerRef.current?.focus();
                });
                return false;
            }
        }
        return true;
    }, [smartMode, resizingPools.length, poolIdInput, poolConfigJson]);

    const handleSubmit = React.useCallback(() => {
        if (!validateBeforeSubmit()) return;
        setConfirmHidden(false);
    }, [validateBeforeSubmit]);

    const handleCreate = React.useCallback(async () => {
        setConfirmHidden(true);
        try {
            setConfigError(null);

            setIsRunning(true);

            if (smartMode) {
                // Always use all VM sizes in priority order
                const allVmNames = getAllVmSizes().map((v) => v.name);

                // Build environment settings from the env var UI
                const environmentSettings = envVars
                    .filter((ev) => ev.name.trim() !== "")
                    .map((ev) => ({ name: ev.name, value: ev.value }));

                // Build pool config: start from pool defaults if available, else use hardcoded values
                let poolConfig: Record<string, unknown>;
                if (poolDefaults) {
                    poolConfig = buildPoolConfigFromDefaults(poolDefaults, {
                        id: poolIdInput,
                        targetLowPriorityNodes: 0,
                        vmSize: allVmNames[0].toLowerCase(),
                    });
                    // Force dedicated=0 for LP-only mode
                    poolConfig.targetDedicatedNodes = 0;
                    // Always disable autoscale in smart mode
                    poolConfig.enableAutoScale = false;
                } else {
                    poolConfig = {
                        id: poolIdInput,
                        vmSize: allVmNames[0].toLowerCase(),
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
                        certificateReferences: [],
                        metadata: [],
                        userAccounts: [],
                    };
                }
                // Overlay user customizations from the UI
                poolConfig.startTask = {
                    commandLine: startTaskCmd,
                    environmentSettings,
                    maxTaskRetryCount: maxRetryCount,
                    resourceFiles: [],
                    userIdentity: {
                        autoUser: {
                            scope: "pool",
                            elevationLevel: "admin",
                        },
                    },
                    waitForSuccess,
                };
                await orchestrator.execute({
                    action: "create_pools_smart",
                    payload: {
                        accountIds: Array.from(selectedAccountIds),
                        vmSizes: allVmNames,
                        poolConfig,
                        quotaType: "lowPriority",
                    },
                });
            } else {
                // Manual JSON mode -- force targetDedicatedNodes=0
                const poolConfig = JSON.parse(poolConfigJson);
                poolConfig.targetDedicatedNodes = 0;
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
        startTaskCmd,
        envVars,
        maxRetryCount,
        waitForSuccess,
        resizingPools.length,
        poolDefaults,
        poolIdInput,
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

    // Loading state: store hasn't been hydrated with any accounts yet.
    const accountsLoading =
        state.accounts.length === 0 && state.quotaRequests.length === 0;

    // Pre-submit summary numbers for confirmation dialog.
    const targetVmCount = smartMode ? getAllVmSizes().length : 1;
    const totalPoolsPlanned = selectedAccountIds.size * targetVmCount;
    const targetNodesPerPool = smartMode
        ? "fill remaining LP quota"
        : (() => {
              try {
                  const cfg = JSON.parse(poolConfigJson);
                  return String(cfg.targetLowPriorityNodes ?? 0);
              } catch {
                  return "?";
              }
          })();

    const confirmMessage = (
        <div>
            <p style={{ margin: "0 0 8px" }}>
                Create <strong>{totalPoolsPlanned}</strong> pool(s) across{" "}
                <strong>{selectedAccountIds.size}</strong> account(s)
                {smartMode && (
                    <>
                        , trying up to <strong>{targetVmCount}</strong> VM
                        size(s) per account in priority order
                    </>
                )}
                .
            </p>
            <p style={{ margin: "0 0 8px" }}>
                Target nodes per pool: <strong>{targetNodesPerPool}</strong>{" "}
                (low-priority).
            </p>
            <p style={{ margin: 0, color: "var(--text-secondary, #888)" }}>
                This action will create live Azure resources. Continue?
            </p>
        </div>
    );

    return (
        <div style={{ padding: "16px" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: "20px" }} id="pool-creation-heading">
                Pool Creation
            </h2>

            <Stack tokens={stackTokens} role="region" aria-labelledby="pool-creation-heading">
                <Checkbox
                    label={`Select all eligible accounts (${eligibleAccounts.length})`}
                    checked={selectAll}
                    onChange={(_e, checked) => setSelectAll(!!checked)}
                    aria-label={`Select all ${eligibleAccounts.length} eligible accounts`}
                />

                {accountsLoading && (
                    <div aria-busy="true">
                        <SkeletonLoader variant="table" rows={4} columns={4} />
                    </div>
                )}

                {!accountsLoading &&
                    !selectAll &&
                    eligibleAccounts.length > 0 && (
                        <DetailsList
                            items={eligibleAccounts}
                            columns={accountColumns}
                            layoutMode={DetailsListLayoutMode.justified}
                            selectionMode={SelectionMode.none}
                            compact
                        />
                    )}

                {/* Summary: selected account count */}
                {selectedAccountIds.size > 0 && (
                    <MessageBar messageBarType={MessageBarType.info}>
                        <strong>{selectedAccountIds.size}</strong> account(s)
                        selected
                    </MessageBar>
                )}

                {eligibleAccounts.length === 0 && !isRunning && (
                    <MessageBar messageBarType={MessageBarType.info}>
                        No eligible accounts available. Provision accounts and
                        get quota approved before creating pools.
                    </MessageBar>
                )}

                <Toggle
                    label="Smart Mode (recommended)"
                    inlineLabel
                    checked={smartMode}
                    onChange={(_e, checked) => setSmartMode(!!checked)}
                    onText="On"
                    offText="Off"
                    aria-label="Toggle smart mode for pool creation"
                />

                {smartMode ? (
                    <>
                        <MessageBar
                            messageBarType={MessageBarType.info}
                            styles={{ root: { marginBottom: 12 } }}
                        >
                            <strong>Smart Mode:</strong> Automatically fills all
                            free LP quota across selected accounts. Creates
                            pools starting with ND40rs_v2, then NC24s_v3,
                            NC12s_v3, NC6s_v3. Waits for each pool to finish
                            resizing, counts actual nodes, then fills remaining
                            quota with the next VM size.
                        </MessageBar>

                        {resizingPools.length > 0 && (
                            <MessageBar messageBarType={MessageBarType.warning}>
                                {resizingPools.length} pool(s) are currently
                                resizing. Pool creation is blocked until they
                                finish.
                            </MessageBar>
                        )}

                        <TextField
                            label="Pool ID"
                            value={poolIdInput}
                            onChange={(_e, v) => {
                                setPoolIdInput(v ?? "");
                                if (poolIdError) {
                                    const next = validatePoolId(v ?? "");
                                    setPoolIdError(next);
                                }
                            }}
                            componentRef={(c) => {
                                // Fluent ITextField has .focus(); cast loosely.
                                poolIdFieldRef.current = (c as unknown as {
                                    focus?: () => void;
                                } | null)?.focus
                                    ? (c as unknown as { focus(): void })
                                    : null;
                            }}
                            errorMessage={poolIdError ?? undefined}
                            aria-describedby={
                                poolIdError ? POOL_ID_ERROR_ID : undefined
                            }
                            aria-invalid={poolIdError ? true : undefined}
                            description="1-64 chars, alphanumeric, underscore, hyphen."
                            styles={{ root: { maxWidth: 320 } }}
                        />
                        {poolIdError && (
                            <span id={POOL_ID_ERROR_ID} style={{ display: "none" }}>
                                {poolIdError}
                            </span>
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

                        <Stack
                            horizontal
                            tokens={{ childrenGap: 24 }}
                            verticalAlign="end"
                        >
                            <SpinButton
                                label="Max Task Retry Count"
                                min={0}
                                max={100}
                                step={1}
                                value={String(maxRetryCount)}
                                onIncrement={(value) => {
                                    const n = Math.min(
                                        100,
                                        (parseInt(value, 10) || 0) + 1
                                    );
                                    setMaxRetryCount(n);
                                    return String(n);
                                }}
                                onDecrement={(value) => {
                                    const n = Math.max(
                                        0,
                                        (parseInt(value, 10) || 0) - 1
                                    );
                                    setMaxRetryCount(n);
                                    return String(n);
                                }}
                                onValidate={(value) => {
                                    const n = parseInt(value, 10);
                                    if (isNaN(n) || n < 0) {
                                        setMaxRetryCount(0);
                                        return "0";
                                    }
                                    if (n > 100) {
                                        setMaxRetryCount(100);
                                        return "100";
                                    }
                                    setMaxRetryCount(n);
                                    return String(n);
                                }}
                                styles={{ root: { width: 180 } }}
                            />

                            <Toggle
                                label="Wait for Success"
                                inlineLabel
                                checked={waitForSuccess}
                                onChange={(_e, checked) =>
                                    setWaitForSuccess(!!checked)
                                }
                                onText="Yes"
                                offText="No"
                            />
                        </Stack>
                    </>
                ) : (
                    <>
                        <MessageBar messageBarType={MessageBarType.warning}>
                            Manual JSON mode. Note: targetDedicatedNodes will be
                            forced to 0 on submission. Only low-priority/spot
                            nodes are used.
                        </MessageBar>

                        <div
                            ref={jsonEditorContainerRef}
                            tabIndex={-1}
                            aria-describedby={
                                configError ? POOL_JSON_ERROR_ID : undefined
                            }
                            aria-invalid={configError ? true : undefined}
                        >
                            <label
                                htmlFor="pool-json-editor"
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
                    <MessageBar
                        id={POOL_JSON_ERROR_ID}
                        messageBarType={MessageBarType.error}
                        role="alert"
                    >
                        {configError}
                    </MessageBar>
                )}

                <Stack horizontal tokens={{ childrenGap: 8 }}>
                    <PrimaryButton
                        text={
                            isRunning
                                ? smartMode
                                    ? "Creating pools (waiting for resize)..."
                                    : "Creating Pools..."
                                : smartMode
                                  ? "Create Pools (Smart Fill)"
                                  : `Create Pools on ${selectedAccountIds.size} Accounts`
                        }
                        disabled={
                            isRunning ||
                            selectedAccountIds.size === 0 ||
                            (smartMode && resizingPools.length > 0)
                        }
                        onClick={handleSubmit}
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

            {isRunning && (
                <div
                    role="status"
                    aria-live="polite"
                    aria-atomic="false"
                    aria-label="Smart pool creation progress"
                    style={{
                        background: "#1a1a1a",
                        border: "1px solid #333",
                        borderRadius: 6,
                        padding: 12,
                        marginTop: 16,
                        maxHeight: 300,
                        overflowY: "auto",
                        fontFamily: "monospace",
                        fontSize: 12,
                    }}
                >
                    <Text
                        variant="small"
                        styles={{
                            root: {
                                color: "#888",
                                marginBottom: 8,
                                display: "block",
                            },
                        }}
                    >
                        Smart Creation Progress
                    </Text>
                    {state.agentLogs
                        .filter((log) => log.agent === "pool")
                        .slice(-20)
                        .map((log, i) => (
                            <div
                                key={i}
                                style={{
                                    color:
                                        log.level === "error"
                                            ? "#d13438"
                                            : log.level === "warn"
                                              ? "#e3a400"
                                              : "#8b8",
                                    marginBottom: 2,
                                }}
                            >
                                {log.message}
                            </div>
                        ))}
                </div>
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

            <ConfirmationDialog
                hidden={confirmHidden}
                title="Confirm Pool Creation"
                message={confirmMessage}
                confirmText={`Create ${totalPoolsPlanned} pool(s)`}
                cancelText="Cancel"
                onConfirm={handleCreate}
                onCancel={() => setConfirmHidden(true)}
                loading={isRunning}
            />
        </div>
    );
};

export const PoolCreationPage: React.FC<PoolCreationPageProps> = (props) => (
    <ErrorBoundary>
        <PoolCreationPageInner {...props} />
    </ErrorBoundary>
);
