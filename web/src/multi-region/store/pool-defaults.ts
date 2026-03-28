/**
 * Pool Default Settings — shared across all pool-creating pages.
 * Persisted to localStorage so settings survive page refreshes.
 */

// ---- Types ----

export interface ImageReference {
    publisher: string;
    offer: string;
    sku: string;
    version: string;
}

export interface VmConfig {
    nodeAgentSKUId: string;
    imageReference: ImageReference;
}

export interface EnvSetting {
    name: string;
    value: string;
}

export interface ResourceFile {
    httpUrl?: string;
    filePath?: string;
    blobSource?: string;
    autoStorageContainerName?: string;
}

export interface StartTaskConfig {
    commandLine: string;
    environmentSettings: EnvSetting[];
    maxTaskRetryCount: number;
    resourceFiles: ResourceFile[];
    userIdentity: {
        autoUser: {
            scope: "pool" | "task";
            elevationLevel: "admin" | "nonadmin";
        };
    };
    waitForSuccess: boolean;
}

export interface UserAccount {
    name: string;
    password: string;
    elevationLevel: "admin" | "nonadmin";
}

export interface MetadataItem {
    name: string;
    value: string;
}

export type ScaleType = "fixed" | "autoscale";
export type TaskSchedulingPolicy = "Pack" | "Spread";
export type OsCategory = "linux" | "windows";

export interface PoolDefaults {
    // Section 1: Pool details
    poolIdPrefix: string; // prefix for auto-generated pool IDs
    displayName: string;

    // Section 2: Scale
    scaleType: ScaleType;
    targetDedicatedNodes: number;
    targetLowPriorityNodes: number;
    resizeTimeoutMinutes: number;
    autoScaleFormula: string;
    autoScaleEvaluationInterval: string; // e.g. "PT5M"

    // Section 3: OS Configuration
    osCategory: OsCategory;
    virtualMachineConfiguration: VmConfig;

    // Section 4: VM Size
    vmSize: string; // e.g. "standard_nd40rs_v2"

    // Section 5: Optional settings
    taskSlotsPerNode: number;
    enableInterNodeCommunication: boolean;
    taskSchedulingPolicy: TaskSchedulingPolicy;
    metadata: MetadataItem[];
    userAccounts: UserAccount[];

    // Section 6: Start Task
    startTask: StartTaskConfig;

    // Section 7: Network
    subnetId: string; // empty string = no vnet
}

// ---- Default values ----

export const INITIAL_POOL_DEFAULTS: PoolDefaults = {
    // Section 1
    poolIdPrefix: "pool",
    displayName: "",

    // Section 2
    scaleType: "fixed",
    targetDedicatedNodes: 0,
    targetLowPriorityNodes: 0,
    resizeTimeoutMinutes: 15,
    autoScaleFormula:
        "$TargetDedicatedNodes = 0;\n$TargetLowPriorityNodes = 0;",
    autoScaleEvaluationInterval: "PT5M",

    // Section 3
    osCategory: "linux",
    virtualMachineConfiguration: {
        nodeAgentSKUId: "batch.node.ubuntu 22.04",
        imageReference: {
            publisher: "canonical",
            offer: "0001-com-ubuntu-server-jammy",
            sku: "22_04-lts-gen2",
            version: "latest",
        },
    },

    // Section 4
    vmSize: "standard_nd40rs_v2",

    // Section 5
    taskSlotsPerNode: 1,
    enableInterNodeCommunication: false,
    taskSchedulingPolicy: "Pack",
    metadata: [],
    userAccounts: [],

    // Section 6
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

    // Section 7
    subnetId: "",
};

// ---- Persistence ----

const STORAGE_KEY = "batch-pool-defaults";

export function loadPoolDefaults(): PoolDefaults {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...INITIAL_POOL_DEFAULTS };
        const parsed = JSON.parse(raw) as Partial<PoolDefaults>;
        // Merge with defaults so new fields always have values
        return { ...INITIAL_POOL_DEFAULTS, ...parsed };
    } catch {
        return { ...INITIAL_POOL_DEFAULTS };
    }
}

export function savePoolDefaults(defaults: PoolDefaults): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
    } catch {
        // localStorage full — silently ignore
    }
}

export function resetPoolDefaults(): PoolDefaults {
    localStorage.removeItem(STORAGE_KEY);
    return { ...INITIAL_POOL_DEFAULTS };
}

/**
 * Build the pool config body from defaults — ready to submit to the Batch API.
 * Consumers override specific fields (poolId, targetLowPriorityNodes, etc.) as needed.
 */
export function buildPoolConfigFromDefaults(
    defaults: PoolDefaults,
    overrides?: Partial<{
        id: string;
        targetDedicatedNodes: number;
        targetLowPriorityNodes: number;
        vmSize: string;
    }>
): Record<string, unknown> {
    const config: Record<string, unknown> = {
        id: overrides?.id ?? `${defaults.poolIdPrefix}-${Date.now()}`,
        displayName: defaults.displayName || undefined,
        vmSize: overrides?.vmSize ?? defaults.vmSize,
        virtualMachineConfiguration: defaults.virtualMachineConfiguration,
        resizeTimeout: `PT${defaults.resizeTimeoutMinutes}M`,
        targetDedicatedNodes:
            overrides?.targetDedicatedNodes ?? defaults.targetDedicatedNodes,
        targetLowPriorityNodes:
            overrides?.targetLowPriorityNodes ??
            defaults.targetLowPriorityNodes,
        taskSlotsPerNode: defaults.taskSlotsPerNode,
        taskSchedulingPolicy: { nodeFillType: defaults.taskSchedulingPolicy },
        enableAutoScale: defaults.scaleType === "autoscale",
        enableInterNodeCommunication: defaults.enableInterNodeCommunication,
    };

    if (defaults.scaleType === "autoscale") {
        config.autoScaleFormula = defaults.autoScaleFormula;
        config.autoScaleEvaluationInterval =
            defaults.autoScaleEvaluationInterval;
        // When autoscale, don't send target node counts
        delete config.targetDedicatedNodes;
        delete config.targetLowPriorityNodes;
    }

    // Start task
    if (defaults.startTask.commandLine.trim()) {
        const st: Record<string, unknown> = {
            commandLine: defaults.startTask.commandLine,
            maxTaskRetryCount: defaults.startTask.maxTaskRetryCount,
            waitForSuccess: defaults.startTask.waitForSuccess,
            userIdentity: defaults.startTask.userIdentity,
        };
        if (defaults.startTask.environmentSettings.length > 0) {
            st.environmentSettings = defaults.startTask.environmentSettings;
        }
        if (defaults.startTask.resourceFiles.length > 0) {
            st.resourceFiles = defaults.startTask.resourceFiles;
        }
        config.startTask = st;
    }

    // Metadata
    if (defaults.metadata.length > 0) {
        config.metadata = defaults.metadata;
    }

    // User accounts
    if (defaults.userAccounts.length > 0) {
        config.userAccounts = defaults.userAccounts;
    }

    // Network
    if (defaults.subnetId) {
        config.networkConfiguration = {
            subnetId: defaults.subnetId,
        };
    }

    return config;
}
