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
// GPU VM families
// ---------------------------------------------------------------------------

// NC-series (K80)
const NC_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_NC6",
        family: "standardNCFamily",
        vCPUs: 6,
        gpuCount: 1,
        gpuType: "K80",
        memoryGB: 56,
        isGpu: true,
    },
    {
        name: "Standard_NC12",
        family: "standardNCFamily",
        vCPUs: 12,
        gpuCount: 2,
        gpuType: "K80",
        memoryGB: 112,
        isGpu: true,
    },
    {
        name: "Standard_NC24",
        family: "standardNCFamily",
        vCPUs: 24,
        gpuCount: 4,
        gpuType: "K80",
        memoryGB: 224,
        isGpu: true,
    },
    {
        name: "Standard_NC24r",
        family: "standardNCFamily",
        vCPUs: 24,
        gpuCount: 4,
        gpuType: "K80",
        memoryGB: 224,
        isGpu: true,
    },
];

// NV-series (M60)
const NV_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_NV6",
        family: "standardNVFamily",
        vCPUs: 6,
        gpuCount: 1,
        gpuType: "M60",
        memoryGB: 56,
        isGpu: true,
    },
    {
        name: "Standard_NV12",
        family: "standardNVFamily",
        vCPUs: 12,
        gpuCount: 2,
        gpuType: "M60",
        memoryGB: 112,
        isGpu: true,
    },
    {
        name: "Standard_NV24",
        family: "standardNVFamily",
        vCPUs: 24,
        gpuCount: 4,
        gpuType: "M60",
        memoryGB: 224,
        isGpu: true,
    },
];

// ND-series (P40)
const ND_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_ND6s",
        family: "standardNDFamily",
        vCPUs: 6,
        gpuCount: 1,
        gpuType: "P40",
        memoryGB: 112,
        isGpu: true,
    },
    {
        name: "Standard_ND12s",
        family: "standardNDFamily",
        vCPUs: 12,
        gpuCount: 2,
        gpuType: "P40",
        memoryGB: 224,
        isGpu: true,
    },
    {
        name: "Standard_ND24s",
        family: "standardNDFamily",
        vCPUs: 24,
        gpuCount: 4,
        gpuType: "P40",
        memoryGB: 448,
        isGpu: true,
    },
    {
        name: "Standard_ND24rs",
        family: "standardNDFamily",
        vCPUs: 24,
        gpuCount: 4,
        gpuType: "P40",
        memoryGB: 448,
        isGpu: true,
    },
];

// NCv3-series (V100)
const NCV3_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_NC6s_v3",
        family: "standardNCv3Family",
        vCPUs: 6,
        gpuCount: 1,
        gpuType: "V100",
        memoryGB: 112,
        isGpu: true,
    },
    {
        name: "Standard_NC12s_v3",
        family: "standardNCv3Family",
        vCPUs: 12,
        gpuCount: 2,
        gpuType: "V100",
        memoryGB: 224,
        isGpu: true,
    },
    {
        name: "Standard_NC24s_v3",
        family: "standardNCv3Family",
        vCPUs: 24,
        gpuCount: 4,
        gpuType: "V100",
        memoryGB: 448,
        isGpu: true,
    },
    {
        name: "Standard_NC24rs_v3",
        family: "standardNCv3Family",
        vCPUs: 24,
        gpuCount: 4,
        gpuType: "V100",
        memoryGB: 448,
        isGpu: true,
    },
];

// NCasT4_v3-series (T4)
const NCAST4V3_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_NC4as_T4_v3",
        family: "standardNCASv3_T4Family",
        vCPUs: 4,
        gpuCount: 1,
        gpuType: "T4",
        memoryGB: 28,
        isGpu: true,
    },
    {
        name: "Standard_NC8as_T4_v3",
        family: "standardNCASv3_T4Family",
        vCPUs: 8,
        gpuCount: 1,
        gpuType: "T4",
        memoryGB: 56,
        isGpu: true,
    },
    {
        name: "Standard_NC16as_T4_v3",
        family: "standardNCASv3_T4Family",
        vCPUs: 16,
        gpuCount: 1,
        gpuType: "T4",
        memoryGB: 110,
        isGpu: true,
    },
    {
        name: "Standard_NC64as_T4_v3",
        family: "standardNCASv3_T4Family",
        vCPUs: 64,
        gpuCount: 4,
        gpuType: "T4",
        memoryGB: 440,
        isGpu: true,
    },
];

// NDm_A100_v4-series (A100 80GB)
const NDM_A100V4_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_ND96amsr_A100_v4",
        family: "standardNDmSv4A100Family",
        vCPUs: 96,
        gpuCount: 8,
        gpuType: "A100 80GB",
        memoryGB: 1924,
        isGpu: true,
    },
];

// ND_A100_v4-series (A100 40GB)
const ND_A100V4_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_ND96asr_A100_v4",
        family: "standardNDSv4A100Family",
        vCPUs: 96,
        gpuCount: 8,
        gpuType: "A100 40GB",
        memoryGB: 900,
        isGpu: true,
    },
];

// NVadsA10_v5-series (A10)
const NVADSA10V5_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_NV6ads_A10_v5",
        family: "standardNVADSA10v5Family",
        vCPUs: 6,
        gpuCount: 1,
        gpuType: "A10",
        memoryGB: 55,
        isGpu: true,
    },
    {
        name: "Standard_NV12ads_A10_v5",
        family: "standardNVADSA10v5Family",
        vCPUs: 12,
        gpuCount: 1,
        gpuType: "A10",
        memoryGB: 110,
        isGpu: true,
    },
    {
        name: "Standard_NV18ads_A10_v5",
        family: "standardNVADSA10v5Family",
        vCPUs: 18,
        gpuCount: 1,
        gpuType: "A10",
        memoryGB: 220,
        isGpu: true,
    },
    {
        name: "Standard_NV36ads_A10_v5",
        family: "standardNVADSA10v5Family",
        vCPUs: 36,
        gpuCount: 1,
        gpuType: "A10",
        memoryGB: 440,
        isGpu: true,
    },
    {
        name: "Standard_NV36adms_A10_v5",
        family: "standardNVADSA10v5Family",
        vCPUs: 36,
        gpuCount: 1,
        gpuType: "A10",
        memoryGB: 880,
        isGpu: true,
    },
    {
        name: "Standard_NV72ads_A10_v5",
        family: "standardNVADSA10v5Family",
        vCPUs: 72,
        gpuCount: 2,
        gpuType: "A10",
        memoryGB: 880,
        isGpu: true,
    },
];

// ND_H100_v5-series (H100)
const ND_H100V5_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_ND96isr_H100_v5",
        family: "standardNDSH100v5Family",
        vCPUs: 96,
        gpuCount: 8,
        gpuType: "H100",
        memoryGB: 1900,
        isGpu: true,
    },
];

// NC_A100_v4-series (A100)
const NC_A100V4_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_NC24ads_A100_v4",
        family: "standardNCA100v4Family",
        vCPUs: 24,
        gpuCount: 1,
        gpuType: "A100",
        memoryGB: 220,
        isGpu: true,
    },
    {
        name: "Standard_NC48ads_A100_v4",
        family: "standardNCA100v4Family",
        vCPUs: 48,
        gpuCount: 2,
        gpuType: "A100",
        memoryGB: 440,
        isGpu: true,
    },
    {
        name: "Standard_NC96ads_A100_v4",
        family: "standardNCA100v4Family",
        vCPUs: 96,
        gpuCount: 4,
        gpuType: "A100",
        memoryGB: 880,
        isGpu: true,
    },
];

// ND40rs_v2-series (V100)
const ND40RSV2_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_ND40rs_v2",
        family: "standardNDv2Family",
        vCPUs: 40,
        gpuCount: 8,
        gpuType: "V100",
        memoryGB: 672,
        isGpu: true,
    },
];

// ---------------------------------------------------------------------------
// CPU VM families
// ---------------------------------------------------------------------------

// D-series v3
const DV3_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_D2_v3",
        family: "standardDv3Family",
        vCPUs: 2,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 8,
        isGpu: false,
    },
    {
        name: "Standard_D4_v3",
        family: "standardDv3Family",
        vCPUs: 4,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 16,
        isGpu: false,
    },
    {
        name: "Standard_D8_v3",
        family: "standardDv3Family",
        vCPUs: 8,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 32,
        isGpu: false,
    },
    {
        name: "Standard_D16_v3",
        family: "standardDv3Family",
        vCPUs: 16,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 64,
        isGpu: false,
    },
    {
        name: "Standard_D32_v3",
        family: "standardDv3Family",
        vCPUs: 32,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 128,
        isGpu: false,
    },
    {
        name: "Standard_D48_v3",
        family: "standardDv3Family",
        vCPUs: 48,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 192,
        isGpu: false,
    },
    {
        name: "Standard_D64_v3",
        family: "standardDv3Family",
        vCPUs: 64,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 256,
        isGpu: false,
    },
];

// F-series v2
const FV2_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_F2s_v2",
        family: "standardFSv2Family",
        vCPUs: 2,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 4,
        isGpu: false,
    },
    {
        name: "Standard_F4s_v2",
        family: "standardFSv2Family",
        vCPUs: 4,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 8,
        isGpu: false,
    },
    {
        name: "Standard_F8s_v2",
        family: "standardFSv2Family",
        vCPUs: 8,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 16,
        isGpu: false,
    },
    {
        name: "Standard_F16s_v2",
        family: "standardFSv2Family",
        vCPUs: 16,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 32,
        isGpu: false,
    },
    {
        name: "Standard_F32s_v2",
        family: "standardFSv2Family",
        vCPUs: 32,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 64,
        isGpu: false,
    },
    {
        name: "Standard_F48s_v2",
        family: "standardFSv2Family",
        vCPUs: 48,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 96,
        isGpu: false,
    },
    {
        name: "Standard_F64s_v2",
        family: "standardFSv2Family",
        vCPUs: 64,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 128,
        isGpu: false,
    },
    {
        name: "Standard_F72s_v2",
        family: "standardFSv2Family",
        vCPUs: 72,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 144,
        isGpu: false,
    },
];

// E-series v3
const EV3_SERIES: VmSizeInfo[] = [
    {
        name: "Standard_E2_v3",
        family: "standardEv3Family",
        vCPUs: 2,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 16,
        isGpu: false,
    },
    {
        name: "Standard_E4_v3",
        family: "standardEv3Family",
        vCPUs: 4,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 32,
        isGpu: false,
    },
    {
        name: "Standard_E8_v3",
        family: "standardEv3Family",
        vCPUs: 8,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 64,
        isGpu: false,
    },
    {
        name: "Standard_E16_v3",
        family: "standardEv3Family",
        vCPUs: 16,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 128,
        isGpu: false,
    },
    {
        name: "Standard_E20_v3",
        family: "standardEv3Family",
        vCPUs: 20,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 160,
        isGpu: false,
    },
    {
        name: "Standard_E32_v3",
        family: "standardEv3Family",
        vCPUs: 32,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 256,
        isGpu: false,
    },
    {
        name: "Standard_E48_v3",
        family: "standardEv3Family",
        vCPUs: 48,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 384,
        isGpu: false,
    },
    {
        name: "Standard_E64_v3",
        family: "standardEv3Family",
        vCPUs: 64,
        gpuCount: 0,
        gpuType: "",
        memoryGB: 432,
        isGpu: false,
    },
];

// ---------------------------------------------------------------------------
// Aggregated list and lookup map
// ---------------------------------------------------------------------------

const ALL_VM_SIZES: VmSizeInfo[] = [
    ...NC_SERIES,
    ...NV_SERIES,
    ...ND_SERIES,
    ...NCV3_SERIES,
    ...NCAST4V3_SERIES,
    ...NDM_A100V4_SERIES,
    ...ND_A100V4_SERIES,
    ...NVADSA10V5_SERIES,
    ...ND_H100V5_SERIES,
    ...NC_A100V4_SERIES,
    ...ND40RSV2_SERIES,
    ...DV3_SERIES,
    ...FV2_SERIES,
    ...EV3_SERIES,
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
