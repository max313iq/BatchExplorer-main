export interface VmSizeInfo {
    name: string;
    family: string;
    vCPUs: number;
    gpuCount: number;
    gpuType: string;
    gpuMemoryGB: number;
    memoryGB: number;
    isGpu: boolean;
}
/**
 * Look up full VmSizeInfo by VM size name (case-insensitive).
 * Returns `undefined` when the size is not in the catalogue.
 */
export declare function getVmSizeInfo(vmSize: string): VmSizeInfo | undefined;
/**
 * Return the number of vCPUs for a VM size. Defaults to 1 if the size
 * is not found in the catalogue.
 */
export declare function getVCpus(vmSize: string): number;
/**
 * Calculate the maximum number of nodes that fit within a vCPU quota.
 * Returns 0 when the quota is insufficient for even a single node.
 */
export declare function getMaxNodes(vmSize: string, quotaCores: number): number;
/**
 * Return only GPU VM sizes from the catalogue.
 */
export declare function getGpuVmSizes(): VmSizeInfo[];
/**
 * Return the ARM API family name for a VM size (case-insensitive).
 * Returns an empty string when the size is not found.
 */
export declare function getVmFamilyName(vmSize: string): string;
/**
 * Return all VM sizes in the catalogue.
 */
export declare function getAllVmSizes(): VmSizeInfo[];
//# sourceMappingURL=vm-sizes.d.ts.map