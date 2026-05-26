/**
 * Pool Default Settings — shared across all pool-creating pages.
 * Persisted to localStorage so settings survive page refreshes.
 */
// ---- Default values ----
export const INITIAL_POOL_DEFAULTS = {
    // Section 1
    poolIdPrefix: "pool",
    displayName: "",
    // Section 2
    scaleType: "fixed",
    targetDedicatedNodes: 0,
    targetLowPriorityNodes: 0,
    resizeTimeoutMinutes: 15,
    autoScaleFormula: "$TargetDedicatedNodes = 0;\n$TargetLowPriorityNodes = 0;",
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
export function loadPoolDefaults() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return Object.assign({}, INITIAL_POOL_DEFAULTS);
        const parsed = JSON.parse(raw);
        // Merge with defaults so new fields always have values
        return Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS), parsed);
    }
    catch (_a) {
        return Object.assign({}, INITIAL_POOL_DEFAULTS);
    }
}
export function savePoolDefaults(defaults) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
    }
    catch (_a) {
        // localStorage full — silently ignore
    }
}
export function resetPoolDefaults() {
    localStorage.removeItem(STORAGE_KEY);
    return Object.assign({}, INITIAL_POOL_DEFAULTS);
}
/**
 * Build the pool config body from defaults — ready to submit to the Batch API.
 * Consumers override specific fields (poolId, targetLowPriorityNodes, etc.) as needed.
 */
export function buildPoolConfigFromDefaults(defaults, overrides) {
    var _a, _b, _c, _d;
    const config = {
        id: (_a = overrides === null || overrides === void 0 ? void 0 : overrides.id) !== null && _a !== void 0 ? _a : `${defaults.poolIdPrefix}-${Date.now()}`,
        displayName: defaults.displayName || undefined,
        vmSize: (_b = overrides === null || overrides === void 0 ? void 0 : overrides.vmSize) !== null && _b !== void 0 ? _b : defaults.vmSize,
        virtualMachineConfiguration: defaults.virtualMachineConfiguration,
        resizeTimeout: `PT${defaults.resizeTimeoutMinutes}M`,
        targetDedicatedNodes: (_c = overrides === null || overrides === void 0 ? void 0 : overrides.targetDedicatedNodes) !== null && _c !== void 0 ? _c : defaults.targetDedicatedNodes,
        targetLowPriorityNodes: (_d = overrides === null || overrides === void 0 ? void 0 : overrides.targetLowPriorityNodes) !== null && _d !== void 0 ? _d : defaults.targetLowPriorityNodes,
        taskSlotsPerNode: defaults.taskSlotsPerNode,
        taskSchedulingPolicy: { nodeFillType: defaults.taskSchedulingPolicy },
        enableAutoScale: defaults.scaleType === "autoscale",
        enableInterNodeCommunication: defaults.enableInterNodeCommunication,
    };
    if (defaults.scaleType === "autoscale") {
        config.autoScaleFormula = defaults.autoScaleFormula;
        config.autoScaleEvaluationInterval = defaults.autoScaleEvaluationInterval;
        // When autoscale, don't send target node counts
        delete config.targetDedicatedNodes;
        delete config.targetLowPriorityNodes;
    }
    // Start task
    if (defaults.startTask.commandLine.trim()) {
        const st = {
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
//# sourceMappingURL=pool-defaults.js.map