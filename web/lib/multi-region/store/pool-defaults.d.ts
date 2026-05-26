/**
 * Pool Default Settings — shared across all pool-creating pages.
 * Persisted to localStorage so settings survive page refreshes.
 */
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
    poolIdPrefix: string;
    displayName: string;
    scaleType: ScaleType;
    targetDedicatedNodes: number;
    targetLowPriorityNodes: number;
    resizeTimeoutMinutes: number;
    autoScaleFormula: string;
    autoScaleEvaluationInterval: string;
    osCategory: OsCategory;
    virtualMachineConfiguration: VmConfig;
    vmSize: string;
    taskSlotsPerNode: number;
    enableInterNodeCommunication: boolean;
    taskSchedulingPolicy: TaskSchedulingPolicy;
    metadata: MetadataItem[];
    userAccounts: UserAccount[];
    startTask: StartTaskConfig;
    subnetId: string;
}
export declare const INITIAL_POOL_DEFAULTS: PoolDefaults;
export declare function loadPoolDefaults(): PoolDefaults;
export declare function savePoolDefaults(defaults: PoolDefaults): void;
export declare function resetPoolDefaults(): PoolDefaults;
/**
 * Build the pool config body from defaults — ready to submit to the Batch API.
 * Consumers override specific fields (poolId, targetLowPriorityNodes, etc.) as needed.
 */
export declare function buildPoolConfigFromDefaults(defaults: PoolDefaults, overrides?: Partial<{
    id: string;
    targetDedicatedNodes: number;
    targetLowPriorityNodes: number;
    vmSize: string;
}>): Record<string, unknown>;
//# sourceMappingURL=pool-defaults.d.ts.map