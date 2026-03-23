export interface VmSizeInfo {
    name: string;
    family: string; // ARM API familyName
    vCPUs: number;
    gpuCount: number;
    gpuType: string;
    memoryGB: number;
    isGpu: boolean;
}

// ---------------------------------------------------------------------------
// GPU VM sizes (5 entries only, in priority order)
// ---------------------------------------------------------------------------

const ALL_VM_SIZES: VmSizeInfo[] = [
    {
        name: "Standard_ND40rs_v2",
        family: "NDv2",
        vCPUs: 40,
        gpuCount: 8,
        gpuType: "V100",
        memoryGB: 672,
        isGpu: true,
    },
    {
        name: "Standard_ND96isr_H100_v5",
        family: "NDH100v5",
        vCPUs: 96,
        gpuCount: 8,
        gpuType: "H100",
        memoryGB: 1900,
        isGpu: true,
    },
    {
        name: "Standard_NC24s_v3",
        family: "NCv3",
        vCPUs: 24,
        gpuCount: 4,
        gpuType: "V100",
        memoryGB: 448,
        isGpu: true,
    },
    {
        name: "Standard_NC12s_v3",
        family: "NCv3",
        vCPUs: 12,
        gpuCount: 2,
        gpuType: "V100",
        memoryGB: 224,
        isGpu: true,
    },
    {
        name: "Standard_NC6s_v3",
        family: "NCv3",
        vCPUs: 6,
        gpuCount: 1,
        gpuType: "V100",
        memoryGB: 112,
        isGpu: true,
    },
];

/** Case-insensitive lookup map (lowercased name -> VmSizeInfo). */
const VM_SIZE_MAP: Map<string, VmSizeInfo> = new Map(
    ALL_VM_SIZES.map((vm) => [vm.name.toLowerCase(), vm])
);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Look up full VmSizeInfo by VM size name (case-insensitive).
 * Returns `undefined` when the size is not in the catalogue.
 */
export function getVmSizeInfo(vmSize: string): VmSizeInfo | undefined {
    return VM_SIZE_MAP.get(vmSize.toLowerCase());
}

/**
 * Return the number of vCPUs for a VM size. Defaults to 1 if the size
 * is not found in the catalogue.
 */
export function getVCpus(vmSize: string): number {
    return getVmSizeInfo(vmSize)?.vCPUs ?? 1;
}

/**
 * Calculate the maximum number of nodes that fit within a vCPU quota.
 * Returns 0 when the quota is insufficient for even a single node.
 */
export function getMaxNodes(vmSize: string, quotaCores: number): number {
    const cpusPerNode = getVCpus(vmSize);
    return Math.max(0, Math.floor(quotaCores / cpusPerNode));
}

/**
 * Return only GPU VM sizes from the catalogue.
 */
export function getGpuVmSizes(): VmSizeInfo[] {
    return ALL_VM_SIZES.filter((vm) => vm.isGpu);
}

/**
 * Return the ARM API family name for a VM size (case-insensitive).
 * Returns an empty string when the size is not found.
 */
export function getVmFamilyName(vmSize: string): string {
    return getVmSizeInfo(vmSize)?.family ?? "";
}

/**
 * Return all VM sizes in the catalogue.
 */
export function getAllVmSizes(): VmSizeInfo[] {
    return [...ALL_VM_SIZES];
}
