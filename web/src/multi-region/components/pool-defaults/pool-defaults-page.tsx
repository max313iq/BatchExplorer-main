import * as React from "react";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { TextField } from "@fluentui/react/lib/TextField";
import { SpinButton } from "@fluentui/react/lib/SpinButton";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { Toggle } from "@fluentui/react/lib/Toggle";
import {
    ChoiceGroup,
    IChoiceGroupOption,
} from "@fluentui/react/lib/ChoiceGroup";
import {
    PrimaryButton,
    DefaultButton,
    IconButton,
} from "@fluentui/react/lib/Button";
import { Icon } from "@fluentui/react/lib/Icon";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import type {
    PoolDefaults,
    ScaleType,
    TaskSchedulingPolicy,
    OsCategory,
    EnvSetting,
    ResourceFile,
    MetadataItem,
    UserAccount,
} from "../../store/pool-defaults";
import {
    INITIAL_POOL_DEFAULTS,
    buildPoolConfigFromDefaults,
} from "../../store/pool-defaults";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const GPU_VMS = [
    {
        key: "Standard_ND40rs_v2",
        text: "ND40rs_v2 (40 vCPUs, 8\u00d7V100, 672 GB)",
        vCPUs: 40,
    },
    {
        key: "Standard_ND96isr_H100_v5",
        text: "ND96isr_H100_v5 (96 vCPUs, 8\u00d7H100, 1900 GB)",
        vCPUs: 96,
    },
    {
        key: "Standard_NC24s_v3",
        text: "NC24s_v3 (24 vCPUs, 4\u00d7V100, 448 GB)",
        vCPUs: 24,
    },
    {
        key: "Standard_NC12s_v3",
        text: "NC12s_v3 (12 vCPUs, 2\u00d7V100, 224 GB)",
        vCPUs: 12,
    },
    {
        key: "Standard_NC6s_v3",
        text: "NC6s_v3 (6 vCPUs, 1\u00d7V100, 112 GB)",
        vCPUs: 6,
    },
];

const VM_DROPDOWN_OPTIONS: IDropdownOption[] = GPU_VMS.map((vm) => ({
    key: vm.key,
    text: vm.text,
}));

const OS_PRESETS: Record<
    OsCategory,
    {
        publisher: string;
        offer: string;
        sku: string;
        version: string;
        nodeAgentSKUId: string;
    }
> = {
    linux: {
        publisher: "canonical",
        offer: "0001-com-ubuntu-server-jammy",
        sku: "22_04-lts-gen2",
        version: "latest",
        nodeAgentSKUId: "batch.node.ubuntu 22.04",
    },
    windows: {
        publisher: "microsoftwindowsserver",
        offer: "windowsserver",
        sku: "2022-datacenter",
        version: "latest",
        nodeAgentSKUId: "batch.node.windows amd64",
    },
};

const SCALE_OPTIONS: IChoiceGroupOption[] = [
    { key: "fixed", text: "Fixed size" },
    { key: "autoscale", text: "Autoscale" },
];

const AUTOSCALE_INTERVAL_OPTIONS: IDropdownOption[] = [
    { key: "PT5M", text: "PT5M (5 minutes)" },
    { key: "PT10M", text: "PT10M (10 minutes)" },
    { key: "PT15M", text: "PT15M (15 minutes)" },
    { key: "PT30M", text: "PT30M (30 minutes)" },
];

const SCHEDULING_POLICY_OPTIONS: IDropdownOption[] = [
    { key: "Pack", text: "Pack" },
    { key: "Spread", text: "Spread" },
];

const OS_CATEGORY_OPTIONS: IDropdownOption[] = [
    { key: "linux", text: "Linux" },
    { key: "windows", text: "Windows" },
];

const USER_SCOPE_OPTIONS: IDropdownOption[] = [
    { key: "pool", text: "Pool user" },
    { key: "task", text: "Task user" },
];

const ELEVATION_OPTIONS: IDropdownOption[] = [
    { key: "admin", text: "Admin" },
    { key: "nonadmin", text: "Non-admin" },
];

/* ------------------------------------------------------------------ */
/*  Dark-theme style helpers                                           */
/* ------------------------------------------------------------------ */

const darkFieldStyles = {
    root: { maxWidth: 500 },
    field: { backgroundColor: "#2a2a2a", color: "#eee", border: "none" },
    fieldGroup: {
        borderColor: "#444",
        backgroundColor: "#2a2a2a",
        ":hover": { borderColor: "#0078d4" },
    },
    subComponentStyles: { label: { root: { color: "#ccc" } } },
};

const darkDropdownStyles = {
    root: { maxWidth: 500 },
    dropdown: {
        borderColor: "#444",
        backgroundColor: "#2a2a2a",
        color: "#eee",
        ":hover": { borderColor: "#0078d4" },
    },
    title: { backgroundColor: "#2a2a2a", color: "#eee", borderColor: "#444" },
    caretDownWrapper: { color: "#999" },
    label: { color: "#ccc" },
};

const darkSpinStyles = {
    root: { maxWidth: 220 },
    labelWrapper: { "& label": { color: "#ccc" } },
    spinButtonWrapper: {
        backgroundColor: "#2a2a2a",
        borderColor: "#444",
        ":hover": { borderColor: "#0078d4" },
    },
    input: { backgroundColor: "#2a2a2a", color: "#eee" },
};

const darkToggleStyles = {
    root: { marginBottom: 0 },
    label: { color: "#ccc" },
};

const darkChoiceStyles = {
    label: { color: "#ccc" },
    flexContainer: { display: "flex", gap: 24 },
};

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

const SectionCard: React.FC<{
    number: number;
    title: string;
    subtitle?: string;
    expanded: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}> = ({ number, title, subtitle, expanded, onToggle, children }) => (
    <div
        style={{
            border: "1px solid #333",
            borderRadius: 8,
            overflow: "hidden",
            marginBottom: 12,
        }}
    >
        <button
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} section ${number}: ${title}`}
            style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                background: "#252525",
                border: "none",
                padding: "12px 16px",
                cursor: "pointer",
                textAlign: "left",
            }}
        >
            <span
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    backgroundColor: "#0078d4",
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 700,
                    flexShrink: 0,
                }}
            >
                {number}
            </span>
            <div style={{ flex: 1 }}>
                <Text
                    variant="mediumPlus"
                    styles={{ root: { color: "#eee", fontWeight: 600 } }}
                >
                    {title}
                </Text>
                {subtitle && (
                    <Text
                        variant="small"
                        styles={{
                            root: {
                                color: "#888",
                                display: "block",
                                marginTop: 2,
                            },
                        }}
                    >
                        {subtitle}
                    </Text>
                )}
            </div>
            <Icon
                iconName={expanded ? "ChevronUp" : "ChevronDown"}
                styles={{ root: { color: "#888", fontSize: 14 } }}
            />
        </button>
        {expanded && (
            <div style={{ padding: "16px 20px", background: "#1e1e1e" }}>
                {children}
            </div>
        )}
    </div>
);

/* ------------------------------------------------------------------ */
/*  SpinButton helpers                                                 */
/* ------------------------------------------------------------------ */

function makeSpinHandlers(
    setter: (n: number) => void,
    min: number,
    max: number,
    step = 1
) {
    return {
        onIncrement: (value: string) => {
            const n = Math.min(max, (parseInt(value, 10) || 0) + step);
            setter(n);
            return String(n);
        },
        onDecrement: (value: string) => {
            const n = Math.max(min, (parseInt(value, 10) || 0) - step);
            setter(n);
            return String(n);
        },
        onValidate: (value: string) => {
            const n = parseInt(value, 10);
            if (isNaN(n) || n < min) {
                setter(min);
                return String(min);
            }
            if (n > max) {
                setter(max);
                return String(max);
            }
            setter(n);
            return String(n);
        },
    };
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export const PoolDefaultsPage: React.FC = () => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const defaults: PoolDefaults = state.poolDefaults ?? INITIAL_POOL_DEFAULTS;

    // Track which sections are expanded
    const [expandedSections, setExpandedSections] = React.useState<Set<number>>(
        new Set([1, 2, 3, 4, 5, 6, 7, 8])
    );

    // "Saved!" toast
    const [savedMsg, setSavedMsg] = React.useState(false);

    const toggleSection = (n: number) => {
        setExpandedSections((prev) => {
            const next = new Set(prev);
            if (next.has(n)) {
                next.delete(n);
            } else {
                next.add(n);
            }
            return next;
        });
    };

    // Update helpers
    const update = React.useCallback(
        (patch: Partial<PoolDefaults>) => {
            (
                store as unknown as {
                    updatePoolDefaults: (p: Partial<PoolDefaults>) => void;
                }
            ).updatePoolDefaults(patch);
        },
        [store]
    );

    const updateStartTask = React.useCallback(
        (patch: Partial<PoolDefaults["startTask"]>) => {
            update({ startTask: { ...defaults.startTask, ...patch } });
        },
        [update, defaults.startTask]
    );

    // Save handler
    const handleSave = React.useCallback(() => {
        (
            store as unknown as { setPoolDefaults: (d: PoolDefaults) => void }
        ).setPoolDefaults(defaults);
        setSavedMsg(true);
        setTimeout(() => setSavedMsg(false), 3000);
    }, [store, defaults]);

    // Reset handler
    const handleReset = React.useCallback(() => {
        if (window.confirm("Reset all pool defaults to factory values?")) {
            (
                store as unknown as { resetPoolDefaults: () => void }
            ).resetPoolDefaults();
        }
    }, [store]);

    // OS category change handler
    const handleOsCategoryChange = React.useCallback(
        (cat: OsCategory) => {
            const preset = OS_PRESETS[cat];
            update({
                osCategory: cat,
                virtualMachineConfiguration: {
                    nodeAgentSKUId: preset.nodeAgentSKUId,
                    imageReference: {
                        publisher: preset.publisher,
                        offer: preset.offer,
                        sku: preset.sku,
                        version: preset.version,
                    },
                },
            });
        },
        [update]
    );

    // Dynamic list helpers
    const addMetadata = React.useCallback(() => {
        update({ metadata: [...defaults.metadata, { name: "", value: "" }] });
    }, [update, defaults.metadata]);

    const removeMetadata = React.useCallback(
        (idx: number) => {
            update({ metadata: defaults.metadata.filter((_, i) => i !== idx) });
        },
        [update, defaults.metadata]
    );

    const updateMetadata = React.useCallback(
        (idx: number, field: keyof MetadataItem, val: string) => {
            update({
                metadata: defaults.metadata.map((m, i) =>
                    i === idx ? { ...m, [field]: val } : m
                ),
            });
        },
        [update, defaults.metadata]
    );

    const addUserAccount = React.useCallback(() => {
        update({
            userAccounts: [
                ...defaults.userAccounts,
                { name: "", password: "", elevationLevel: "admin" },
            ],
        });
    }, [update, defaults.userAccounts]);

    const removeUserAccount = React.useCallback(
        (idx: number) => {
            update({
                userAccounts: defaults.userAccounts.filter((_, i) => i !== idx),
            });
        },
        [update, defaults.userAccounts]
    );

    const updateUserAccount = React.useCallback(
        (idx: number, patch: Partial<UserAccount>) => {
            update({
                userAccounts: defaults.userAccounts.map((u, i) =>
                    i === idx ? { ...u, ...patch } : u
                ),
            });
        },
        [update, defaults.userAccounts]
    );

    const addEnvVar = React.useCallback(() => {
        updateStartTask({
            environmentSettings: [
                ...defaults.startTask.environmentSettings,
                { name: "", value: "" },
            ],
        });
    }, [updateStartTask, defaults.startTask.environmentSettings]);

    const removeEnvVar = React.useCallback(
        (idx: number) => {
            updateStartTask({
                environmentSettings:
                    defaults.startTask.environmentSettings.filter(
                        (_, i) => i !== idx
                    ),
            });
        },
        [updateStartTask, defaults.startTask.environmentSettings]
    );

    const updateEnvVar = React.useCallback(
        (idx: number, field: keyof EnvSetting, val: string) => {
            updateStartTask({
                environmentSettings: defaults.startTask.environmentSettings.map(
                    (ev, i) => (i === idx ? { ...ev, [field]: val } : ev)
                ),
            });
        },
        [updateStartTask, defaults.startTask.environmentSettings]
    );

    const addResourceFile = React.useCallback(() => {
        updateStartTask({
            resourceFiles: [
                ...defaults.startTask.resourceFiles,
                { httpUrl: "", filePath: "" },
            ],
        });
    }, [updateStartTask, defaults.startTask.resourceFiles]);

    const removeResourceFile = React.useCallback(
        (idx: number) => {
            updateStartTask({
                resourceFiles: defaults.startTask.resourceFiles.filter(
                    (_, i) => i !== idx
                ),
            });
        },
        [updateStartTask, defaults.startTask.resourceFiles]
    );

    const updateResourceFile = React.useCallback(
        (idx: number, patch: Partial<ResourceFile>) => {
            updateStartTask({
                resourceFiles: defaults.startTask.resourceFiles.map((rf, i) =>
                    i === idx ? { ...rf, ...patch } : rf
                ),
            });
        },
        [updateStartTask, defaults.startTask.resourceFiles]
    );

    // Preview JSON
    const previewJson = React.useMemo(
        () => JSON.stringify(buildPoolConfigFromDefaults(defaults), null, 2),
        [defaults]
    );

    return (
        <div style={{ padding: "16px 0" }}>
            {/* Header */}
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 12 }}
                styles={{ root: { marginBottom: 16 } }}
            >
                <Text
                    variant="xLarge"
                    styles={{ root: { fontWeight: 600, color: "#eee" } }}
                >
                    Pool Default Settings
                </Text>
                <Text variant="small" styles={{ root: { color: "#888" } }}>
                    These defaults are used by Smart Create, Unused Quota, and
                    manual pool creation
                </Text>
            </Stack>

            {/* ============ SECTION 1: Pool Details ============ */}
            <SectionCard
                number={1}
                title="Pool Details"
                subtitle="Basic information about the pool"
                expanded={expandedSections.has(1)}
                onToggle={() => toggleSection(1)}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    <TextField
                        label="ID Prefix"
                        value={defaults.poolIdPrefix}
                        maxLength={64}
                        onChange={(_e, v) => update({ poolIdPrefix: v ?? "" })}
                        description={`${defaults.poolIdPrefix.length}/64`}
                        aria-label="Pool ID prefix"
                        styles={darkFieldStyles}
                    />
                    <TextField
                        label="Display Name"
                        value={defaults.displayName}
                        onChange={(_e, v) => update({ displayName: v ?? "" })}
                        aria-label="Pool display name"
                        styles={darkFieldStyles}
                    />
                </Stack>
            </SectionCard>

            {/* ============ SECTION 2: Scale ============ */}
            <SectionCard
                number={2}
                title="Scale"
                subtitle="Number of nodes using fixed or autoscale"
                expanded={expandedSections.has(2)}
                onToggle={() => toggleSection(2)}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    <ChoiceGroup
                        selectedKey={defaults.scaleType}
                        options={SCALE_OPTIONS}
                        onChange={(_e, option) => {
                            if (option) {
                                update({
                                    scaleType: option.key as ScaleType,
                                });
                            }
                        }}
                        aria-label="Scale type"
                        styles={darkChoiceStyles}
                    />
                    {defaults.scaleType === "fixed" ? (
                        <>
                            <SpinButton
                                label="Dedicated nodes"
                                min={0}
                                max={10000}
                                step={1}
                                value={String(defaults.targetDedicatedNodes)}
                                {...makeSpinHandlers(
                                    (n) => update({ targetDedicatedNodes: n }),
                                    0,
                                    10000
                                )}
                                aria-label="Target dedicated nodes"
                                styles={darkSpinStyles}
                            />
                            <SpinButton
                                label="Spot/low-priority nodes"
                                min={0}
                                max={10000}
                                step={1}
                                value={String(defaults.targetLowPriorityNodes)}
                                {...makeSpinHandlers(
                                    (n) =>
                                        update({
                                            targetLowPriorityNodes: n,
                                        }),
                                    0,
                                    10000
                                )}
                                aria-label="Target low-priority nodes"
                                styles={darkSpinStyles}
                            />
                            <SpinButton
                                label="Resize timeout (minutes)"
                                min={1}
                                max={180}
                                step={1}
                                value={String(defaults.resizeTimeoutMinutes)}
                                {...makeSpinHandlers(
                                    (n) =>
                                        update({
                                            resizeTimeoutMinutes: n,
                                        }),
                                    1,
                                    180
                                )}
                                aria-label="Resize timeout in minutes"
                                styles={darkSpinStyles}
                            />
                        </>
                    ) : (
                        <>
                            <TextField
                                label="Autoscale Formula"
                                multiline
                                rows={6}
                                value={defaults.autoScaleFormula}
                                onChange={(_e, v) =>
                                    update({ autoScaleFormula: v ?? "" })
                                }
                                aria-label="Autoscale formula"
                                styles={{
                                    ...darkFieldStyles,
                                    field: {
                                        ...darkFieldStyles.field,
                                        fontFamily: "Consolas, monospace",
                                        fontSize: 13,
                                        minHeight: 120,
                                    },
                                }}
                            />
                            <Dropdown
                                label="Evaluation Interval"
                                selectedKey={
                                    defaults.autoScaleEvaluationInterval
                                }
                                options={AUTOSCALE_INTERVAL_OPTIONS}
                                onChange={(_e, option) => {
                                    if (option) {
                                        update({
                                            autoScaleEvaluationInterval:
                                                option.key as string,
                                        });
                                    }
                                }}
                                aria-label="Autoscale evaluation interval"
                                styles={darkDropdownStyles}
                            />
                        </>
                    )}
                </Stack>
            </SectionCard>

            {/* ============ SECTION 3: OS Configuration ============ */}
            <SectionCard
                number={3}
                title="Select an Operating System"
                expanded={expandedSections.has(3)}
                onToggle={() => toggleSection(3)}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    <Dropdown
                        label="Category"
                        selectedKey={defaults.osCategory}
                        options={OS_CATEGORY_OPTIONS}
                        onChange={(_e, option) => {
                            if (option) {
                                handleOsCategoryChange(
                                    option.key as OsCategory
                                );
                            }
                        }}
                        aria-label="Operating system category"
                        styles={darkDropdownStyles}
                    />
                    <TextField
                        label="Publisher"
                        value={
                            defaults.virtualMachineConfiguration.imageReference
                                .publisher
                        }
                        onChange={(_e, v) =>
                            update({
                                virtualMachineConfiguration: {
                                    ...defaults.virtualMachineConfiguration,
                                    imageReference: {
                                        ...defaults.virtualMachineConfiguration
                                            .imageReference,
                                        publisher: v ?? "",
                                    },
                                },
                            })
                        }
                        aria-label="Image publisher"
                        styles={darkFieldStyles}
                    />
                    <TextField
                        label="Offer"
                        value={
                            defaults.virtualMachineConfiguration.imageReference
                                .offer
                        }
                        onChange={(_e, v) =>
                            update({
                                virtualMachineConfiguration: {
                                    ...defaults.virtualMachineConfiguration,
                                    imageReference: {
                                        ...defaults.virtualMachineConfiguration
                                            .imageReference,
                                        offer: v ?? "",
                                    },
                                },
                            })
                        }
                        aria-label="Image offer"
                        styles={darkFieldStyles}
                    />
                    <TextField
                        label="SKU"
                        value={
                            defaults.virtualMachineConfiguration.imageReference
                                .sku
                        }
                        onChange={(_e, v) =>
                            update({
                                virtualMachineConfiguration: {
                                    ...defaults.virtualMachineConfiguration,
                                    imageReference: {
                                        ...defaults.virtualMachineConfiguration
                                            .imageReference,
                                        sku: v ?? "",
                                    },
                                },
                            })
                        }
                        aria-label="Image SKU"
                        styles={darkFieldStyles}
                    />
                    <TextField
                        label="Version"
                        value={
                            defaults.virtualMachineConfiguration.imageReference
                                .version
                        }
                        onChange={(_e, v) =>
                            update({
                                virtualMachineConfiguration: {
                                    ...defaults.virtualMachineConfiguration,
                                    imageReference: {
                                        ...defaults.virtualMachineConfiguration
                                            .imageReference,
                                        version: v ?? "",
                                    },
                                },
                            })
                        }
                        aria-label="Image version"
                        styles={darkFieldStyles}
                    />
                    <TextField
                        label="Node Agent SKU ID"
                        value={
                            defaults.virtualMachineConfiguration.nodeAgentSKUId
                        }
                        onChange={(_e, v) =>
                            update({
                                virtualMachineConfiguration: {
                                    ...defaults.virtualMachineConfiguration,
                                    nodeAgentSKUId: v ?? "",
                                },
                            })
                        }
                        aria-label="Node agent SKU ID"
                        styles={darkFieldStyles}
                    />
                </Stack>
            </SectionCard>

            {/* ============ SECTION 4: VM Size ============ */}
            <SectionCard
                number={4}
                title="Virtual Machine Size"
                expanded={expandedSections.has(4)}
                onToggle={() => toggleSection(4)}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    <Dropdown
                        label="VM Size"
                        selectedKey={
                            GPU_VMS.find(
                                (vm) =>
                                    vm.key.toLowerCase() ===
                                    defaults.vmSize.toLowerCase()
                            )?.key
                        }
                        options={VM_DROPDOWN_OPTIONS}
                        onChange={(_e, option) => {
                            if (option) {
                                update({
                                    vmSize: (
                                        option.key as string
                                    ).toLowerCase(),
                                });
                            }
                        }}
                        aria-label="Select VM size"
                        styles={darkDropdownStyles}
                    />

                    <Text
                        variant="small"
                        styles={{
                            root: {
                                color: "#888",
                                fontWeight: 600,
                                marginTop: 8,
                            },
                        }}
                    >
                        Quick picks:
                    </Text>
                    <div
                        style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 8,
                        }}
                    >
                        {GPU_VMS.map((vm) => (
                            <button
                                key={vm.key}
                                onClick={() =>
                                    update({
                                        vmSize: vm.key.toLowerCase(),
                                    })
                                }
                                aria-label={`Select ${vm.text}`}
                                style={{
                                    padding: "8px 14px",
                                    borderRadius: 6,
                                    border:
                                        defaults.vmSize.toLowerCase() ===
                                        vm.key.toLowerCase()
                                            ? "2px solid #0078d4"
                                            : "1px solid #444",
                                    background:
                                        defaults.vmSize.toLowerCase() ===
                                        vm.key.toLowerCase()
                                            ? "#0a3d6e"
                                            : "#2a2a2a",
                                    color: "#eee",
                                    cursor: "pointer",
                                    fontSize: 12,
                                    textAlign: "left",
                                }}
                            >
                                <strong>
                                    {vm.key.replace("Standard_", "")}
                                </strong>
                                <br />
                                <span style={{ color: "#999" }}>
                                    {vm.vCPUs} vCPUs
                                </span>
                            </button>
                        ))}
                    </div>

                    <TextField
                        label="Or type custom VM size"
                        value={defaults.vmSize}
                        onChange={(_e, v) => update({ vmSize: v ?? "" })}
                        placeholder="e.g. standard_d16s_v3"
                        aria-label="Custom VM size"
                        styles={darkFieldStyles}
                    />
                </Stack>
            </SectionCard>

            {/* ============ SECTION 5: Optional Settings ============ */}
            <SectionCard
                number={5}
                title="Optional Settings"
                expanded={expandedSections.has(5)}
                onToggle={() => toggleSection(5)}
            >
                <Stack tokens={{ childrenGap: 16 }}>
                    <SpinButton
                        label="Task slots per node"
                        min={1}
                        max={256}
                        step={1}
                        value={String(defaults.taskSlotsPerNode)}
                        {...makeSpinHandlers(
                            (n) => update({ taskSlotsPerNode: n }),
                            1,
                            256
                        )}
                        aria-label="Task slots per node"
                        styles={darkSpinStyles}
                    />
                    <Toggle
                        label="Inter-node communication"
                        inlineLabel
                        checked={defaults.enableInterNodeCommunication}
                        onChange={(_e, checked) =>
                            update({
                                enableInterNodeCommunication: !!checked,
                            })
                        }
                        onText="ON"
                        offText="OFF"
                        aria-label="Enable inter-node communication"
                        styles={darkToggleStyles}
                    />
                    <Dropdown
                        label="Task scheduling policy"
                        selectedKey={defaults.taskSchedulingPolicy}
                        options={SCHEDULING_POLICY_OPTIONS}
                        onChange={(_e, option) => {
                            if (option) {
                                update({
                                    taskSchedulingPolicy:
                                        option.key as TaskSchedulingPolicy,
                                });
                            }
                        }}
                        aria-label="Task scheduling policy"
                        styles={darkDropdownStyles}
                    />

                    {/* Metadata */}
                    <div>
                        <Text
                            variant="mediumPlus"
                            styles={{
                                root: {
                                    color: "#ccc",
                                    fontWeight: 600,
                                    display: "block",
                                    marginBottom: 8,
                                },
                            }}
                        >
                            Metadata
                        </Text>
                        {defaults.metadata.map((m, idx) => (
                            <Stack
                                key={idx}
                                horizontal
                                tokens={{ childrenGap: 8 }}
                                verticalAlign="end"
                                styles={{ root: { marginBottom: 4 } }}
                            >
                                <TextField
                                    placeholder="Name"
                                    value={m.name}
                                    onChange={(_e, v) =>
                                        updateMetadata(idx, "name", v ?? "")
                                    }
                                    aria-label={`Metadata name ${idx + 1}`}
                                    styles={{
                                        ...darkFieldStyles,
                                        root: { width: 200 },
                                    }}
                                />
                                <TextField
                                    placeholder="Value"
                                    value={m.value}
                                    onChange={(_e, v) =>
                                        updateMetadata(idx, "value", v ?? "")
                                    }
                                    aria-label={`Metadata value ${idx + 1}`}
                                    styles={{
                                        ...darkFieldStyles,
                                        root: { width: 300 },
                                    }}
                                />
                                <IconButton
                                    iconProps={{ iconName: "Delete" }}
                                    title="Remove metadata"
                                    onClick={() => removeMetadata(idx)}
                                    aria-label={`Remove metadata item ${idx + 1}`}
                                    styles={{
                                        root: { color: "#a80000" },
                                    }}
                                />
                            </Stack>
                        ))}
                        <DefaultButton
                            text="Add metadata"
                            iconProps={{ iconName: "Add" }}
                            onClick={addMetadata}
                            aria-label="Add metadata item"
                            styles={{
                                root: {
                                    marginTop: 4,
                                    borderColor: "#444",
                                    color: "#ccc",
                                    background: "#2a2a2a",
                                },
                            }}
                        />
                    </div>

                    {/* User Accounts */}
                    <div>
                        <Text
                            variant="mediumPlus"
                            styles={{
                                root: {
                                    color: "#ccc",
                                    fontWeight: 600,
                                    display: "block",
                                    marginBottom: 8,
                                },
                            }}
                        >
                            User Accounts
                        </Text>
                        {defaults.userAccounts.map((u, idx) => (
                            <Stack
                                key={idx}
                                tokens={{ childrenGap: 8 }}
                                styles={{
                                    root: {
                                        marginBottom: 8,
                                        padding: 8,
                                        border: "1px solid #333",
                                        borderRadius: 4,
                                        background: "#252525",
                                    },
                                }}
                            >
                                <Stack
                                    horizontal
                                    tokens={{ childrenGap: 8 }}
                                    verticalAlign="end"
                                >
                                    <TextField
                                        placeholder="Name"
                                        value={u.name}
                                        onChange={(_e, v) =>
                                            updateUserAccount(idx, {
                                                name: v ?? "",
                                            })
                                        }
                                        aria-label={`User account name ${idx + 1}`}
                                        styles={{
                                            ...darkFieldStyles,
                                            root: { width: 180 },
                                        }}
                                    />
                                    <TextField
                                        placeholder="Password"
                                        type="password"
                                        canRevealPassword
                                        value={u.password}
                                        onChange={(_e, v) =>
                                            updateUserAccount(idx, {
                                                password: v ?? "",
                                            })
                                        }
                                        aria-label={`User account password ${idx + 1}`}
                                        styles={{
                                            ...darkFieldStyles,
                                            root: { width: 200 },
                                        }}
                                    />
                                    <IconButton
                                        iconProps={{ iconName: "Delete" }}
                                        title="Remove user account"
                                        onClick={() => removeUserAccount(idx)}
                                        aria-label={`Remove user account ${idx + 1}`}
                                        styles={{
                                            root: { color: "#a80000" },
                                        }}
                                    />
                                </Stack>
                                <Dropdown
                                    label="Elevation"
                                    selectedKey={u.elevationLevel}
                                    options={ELEVATION_OPTIONS}
                                    onChange={(_e, option) => {
                                        if (option) {
                                            updateUserAccount(idx, {
                                                elevationLevel: option.key as
                                                    | "admin"
                                                    | "nonadmin",
                                            });
                                        }
                                    }}
                                    aria-label={`User account elevation ${idx + 1}`}
                                    styles={{
                                        ...darkDropdownStyles,
                                        root: { maxWidth: 200 },
                                    }}
                                />
                            </Stack>
                        ))}
                        <DefaultButton
                            text="Add user account"
                            iconProps={{ iconName: "Add" }}
                            onClick={addUserAccount}
                            aria-label="Add user account"
                            styles={{
                                root: {
                                    marginTop: 4,
                                    borderColor: "#444",
                                    color: "#ccc",
                                    background: "#2a2a2a",
                                },
                            }}
                        />
                    </div>
                </Stack>
            </SectionCard>

            {/* ============ SECTION 6: Start Task ============ */}
            <SectionCard
                number={6}
                title="Start Task"
                subtitle="Startup configuration on each node"
                expanded={expandedSections.has(6)}
                onToggle={() => toggleSection(6)}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    <TextField
                        label="Command line"
                        multiline
                        rows={3}
                        value={defaults.startTask.commandLine}
                        onChange={(_e, v) =>
                            updateStartTask({ commandLine: v ?? "" })
                        }
                        aria-label="Start task command line"
                        styles={{
                            ...darkFieldStyles,
                            field: {
                                ...darkFieldStyles.field,
                                fontFamily: "Consolas, monospace",
                                fontSize: 13,
                            },
                        }}
                    />
                    <Stack
                        horizontal
                        tokens={{ childrenGap: 24 }}
                        verticalAlign="end"
                    >
                        <SpinButton
                            label="Max retry count"
                            min={0}
                            max={100}
                            step={1}
                            value={String(defaults.startTask.maxTaskRetryCount)}
                            {...makeSpinHandlers(
                                (n) =>
                                    updateStartTask({
                                        maxTaskRetryCount: n,
                                    }),
                                0,
                                100
                            )}
                            aria-label="Start task max retry count"
                            styles={darkSpinStyles}
                        />
                        <Toggle
                            label="Wait for success"
                            inlineLabel
                            checked={defaults.startTask.waitForSuccess}
                            onChange={(_e, checked) =>
                                updateStartTask({
                                    waitForSuccess: !!checked,
                                })
                            }
                            onText="Yes"
                            offText="No"
                            aria-label="Wait for start task success"
                            styles={darkToggleStyles}
                        />
                    </Stack>
                    <Stack
                        horizontal
                        tokens={{ childrenGap: 24 }}
                        verticalAlign="end"
                    >
                        <Dropdown
                            label="User identity scope"
                            selectedKey={
                                defaults.startTask.userIdentity.autoUser.scope
                            }
                            options={USER_SCOPE_OPTIONS}
                            onChange={(_e, option) => {
                                if (option) {
                                    updateStartTask({
                                        userIdentity: {
                                            autoUser: {
                                                ...defaults.startTask
                                                    .userIdentity.autoUser,
                                                scope: option.key as
                                                    | "pool"
                                                    | "task",
                                            },
                                        },
                                    });
                                }
                            }}
                            aria-label="User identity scope"
                            styles={{
                                ...darkDropdownStyles,
                                root: { maxWidth: 220 },
                            }}
                        />
                        <Dropdown
                            label="Elevation level"
                            selectedKey={
                                defaults.startTask.userIdentity.autoUser
                                    .elevationLevel
                            }
                            options={ELEVATION_OPTIONS}
                            onChange={(_e, option) => {
                                if (option) {
                                    updateStartTask({
                                        userIdentity: {
                                            autoUser: {
                                                ...defaults.startTask
                                                    .userIdentity.autoUser,
                                                elevationLevel: option.key as
                                                    | "admin"
                                                    | "nonadmin",
                                            },
                                        },
                                    });
                                }
                            }}
                            aria-label="Elevation level"
                            styles={{
                                ...darkDropdownStyles,
                                root: { maxWidth: 220 },
                            }}
                        />
                    </Stack>

                    {/* Resource Files */}
                    <div>
                        <Text
                            variant="mediumPlus"
                            styles={{
                                root: {
                                    color: "#ccc",
                                    fontWeight: 600,
                                    display: "block",
                                    marginBottom: 8,
                                },
                            }}
                        >
                            Resource files
                        </Text>
                        {defaults.startTask.resourceFiles.map((rf, idx) => (
                            <Stack
                                key={idx}
                                horizontal
                                tokens={{ childrenGap: 8 }}
                                verticalAlign="end"
                                styles={{ root: { marginBottom: 4 } }}
                            >
                                <TextField
                                    placeholder="HTTP URL"
                                    value={rf.httpUrl ?? ""}
                                    onChange={(_e, v) =>
                                        updateResourceFile(idx, {
                                            httpUrl: v ?? "",
                                        })
                                    }
                                    aria-label={`Resource file URL ${idx + 1}`}
                                    styles={{
                                        ...darkFieldStyles,
                                        root: { width: 300 },
                                    }}
                                />
                                <TextField
                                    placeholder="File path"
                                    value={rf.filePath ?? ""}
                                    onChange={(_e, v) =>
                                        updateResourceFile(idx, {
                                            filePath: v ?? "",
                                        })
                                    }
                                    aria-label={`Resource file path ${idx + 1}`}
                                    styles={{
                                        ...darkFieldStyles,
                                        root: { width: 200 },
                                    }}
                                />
                                <IconButton
                                    iconProps={{ iconName: "Delete" }}
                                    title="Remove resource file"
                                    onClick={() => removeResourceFile(idx)}
                                    aria-label={`Remove resource file ${idx + 1}`}
                                    styles={{
                                        root: { color: "#a80000" },
                                    }}
                                />
                            </Stack>
                        ))}
                        <DefaultButton
                            text="Add from URL"
                            iconProps={{ iconName: "Add" }}
                            onClick={addResourceFile}
                            aria-label="Add resource file"
                            styles={{
                                root: {
                                    marginTop: 4,
                                    borderColor: "#444",
                                    color: "#ccc",
                                    background: "#2a2a2a",
                                },
                            }}
                        />
                    </div>

                    {/* Environment Variables */}
                    <div>
                        <Text
                            variant="mediumPlus"
                            styles={{
                                root: {
                                    color: "#ccc",
                                    fontWeight: 600,
                                    display: "block",
                                    marginBottom: 8,
                                },
                            }}
                        >
                            Environment variables
                        </Text>
                        {defaults.startTask.environmentSettings.map(
                            (ev, idx) => (
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
                                        aria-label={`Environment variable name ${idx + 1}`}
                                        styles={{
                                            ...darkFieldStyles,
                                            root: { width: 200 },
                                            field: {
                                                ...darkFieldStyles.field,
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
                                        aria-label={`Environment variable value ${idx + 1}`}
                                        styles={{
                                            ...darkFieldStyles,
                                            root: { width: 300 },
                                            field: {
                                                ...darkFieldStyles.field,
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
                                        aria-label={`Remove environment variable ${idx + 1}`}
                                        styles={{
                                            root: { color: "#a80000" },
                                        }}
                                    />
                                </Stack>
                            )
                        )}
                        <DefaultButton
                            text="Add environment variable"
                            iconProps={{ iconName: "Add" }}
                            onClick={addEnvVar}
                            aria-label="Add environment variable"
                            styles={{
                                root: {
                                    marginTop: 4,
                                    borderColor: "#444",
                                    color: "#ccc",
                                    background: "#2a2a2a",
                                },
                            }}
                        />
                    </div>
                </Stack>
            </SectionCard>

            {/* ============ SECTION 7: Network Configuration ============ */}
            <SectionCard
                number={7}
                title="Network Configuration"
                expanded={expandedSections.has(7)}
                onToggle={() => toggleSection(7)}
            >
                <Stack tokens={{ childrenGap: 8 }}>
                    <TextField
                        label="Subnet ID"
                        value={defaults.subnetId}
                        onChange={(_e, v) => update({ subnetId: v ?? "" })}
                        placeholder="Paste full ARM resource ID of subnet"
                        aria-label="Subnet resource ID"
                        styles={darkFieldStyles}
                    />
                    <Text variant="small" styles={{ root: { color: "#666" } }}>
                        Leave empty for no VNet
                    </Text>
                </Stack>
            </SectionCard>

            {/* ============ SECTION 8: Preview & Save ============ */}
            <SectionCard
                number={8}
                title="Preview & Save"
                expanded={expandedSections.has(8)}
                onToggle={() => toggleSection(8)}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    <pre
                        style={{
                            background: "#111",
                            color: "#9cdcfe",
                            padding: 16,
                            borderRadius: 6,
                            border: "1px solid #333",
                            maxHeight: 400,
                            overflow: "auto",
                            fontSize: 12,
                            fontFamily: "Consolas, monospace",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            margin: 0,
                        }}
                        aria-label="Pool configuration JSON preview"
                    >
                        {previewJson}
                    </pre>

                    <Stack horizontal tokens={{ childrenGap: 12 }}>
                        <PrimaryButton
                            text="Save Defaults"
                            onClick={handleSave}
                            aria-label="Save pool defaults"
                        />
                        <DefaultButton
                            text="Reset to Factory"
                            onClick={handleReset}
                            aria-label="Reset pool defaults to factory values"
                            styles={{
                                root: {
                                    borderColor: "#d13438",
                                    color: "#d13438",
                                },
                            }}
                        />
                    </Stack>

                    {savedMsg && (
                        <MessageBar
                            messageBarType={MessageBarType.success}
                            aria-label="Defaults saved successfully"
                        >
                            Saved to localStorage
                        </MessageBar>
                    )}
                </Stack>
            </SectionCard>
        </div>
    );
};
