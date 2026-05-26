// ---------------------------------------------------------------------------
// GPU VM sizes (5 entries only, in priority order)
// ---------------------------------------------------------------------------
const ALL_VM_SIZES = [
    {
        name: "Standard_ND40rs_v2",
        family: "NDv2",
        vCPUs: 40,
        gpuCount: 8,
        gpuType: "V100",
        gpuMemoryGB: 32,
        memoryGB: 672,
        isGpu: true,
    },
    {
        name: "Standard_ND96isr_H100_v5",
        family: "NDH100v5",
        vCPUs: 96,
        gpuCount: 8,
        gpuType: "H100",
        gpuMemoryGB: 80,
        memoryGB: 1900,
        isGpu: true,
    },
    {
        name: "Standard_NC24s_v3",
        family: "NCv3",
        vCPUs: 24,
        gpuCount: 4,
        gpuType: "V100",
        gpuMemoryGB: 16,
        memoryGB: 448,
        isGpu: true,
    },
    {
        name: "Standard_NC12s_v3",
        family: "NCv3",
        vCPUs: 12,
        gpuCount: 2,
        gpuType: "V100",
        gpuMemoryGB: 16,
        memoryGB: 224,
        isGpu: true,
    },
    {
        name: "Standard_NC6s_v3",
        family: "NCv3",
        vCPUs: 6,
        gpuCount: 1,
        gpuType: "V100",
        gpuMemoryGB: 16,
        memoryGB: 112,
        isGpu: true,
    },
];
/** Case-insensitive lookup map (lowercased name -> VmSizeInfo). */
const VM_SIZE_MAP = new Map(ALL_VM_SIZES.map((vm) => [vm.name.toLowerCase(), vm]));
// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------
/**
 * Look up full VmSizeInfo by VM size name (case-insensitive).
 * Returns `undefined` when the size is not in the catalogue.
 */
export function getVmSizeInfo(vmSize) {
    return VM_SIZE_MAP.get(vmSize.toLowerCase());
}
/**
 * Return the number of vCPUs for a VM size. Defaults to 1 if the size
 * is not found in the catalogue.
 */
export function getVCpus(vmSize) {
    var _a, _b;
    return (_b = (_a = getVmSizeInfo(vmSize)) === null || _a === void 0 ? void 0 : _a.vCPUs) !== null && _b !== void 0 ? _b : 1;
}
/**
 * Calculate the maximum number of nodes that fit within a vCPU quota.
 * Returns 0 when the quota is insufficient for even a single node.
 */
export function getMaxNodes(vmSize, quotaCores) {
    const cpusPerNode = getVCpus(vmSize);
    return Math.max(0, Math.floor(quotaCores / cpusPerNode));
}
/**
 * Return only GPU VM sizes from the catalogue.
 */
export function getGpuVmSizes() {
    return ALL_VM_SIZES.filter((vm) => vm.isGpu);
}
/**
 * Return the ARM API family name for a VM size (case-insensitive).
 * Returns an empty string when the size is not found.
 */
export function getVmFamilyName(vmSize) {
    var _a, _b;
    return (_b = (_a = getVmSizeInfo(vmSize)) === null || _a === void 0 ? void 0 : _a.family) !== null && _b !== void 0 ? _b : "";
}
/**
 * Return all VM sizes in the catalogue.
 */
export function getAllVmSizes() {
    return [...ALL_VM_SIZES];
}
//# sourceMappingURL=vm-sizes.js.map