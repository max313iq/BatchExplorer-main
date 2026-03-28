import * as React from "react";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { TextField } from "@fluentui/react/lib/TextField";
import { Icon } from "@fluentui/react/lib/Icon";
import { useMultiRegionState } from "../../store/store-context";
import { PoolInfo } from "../../store/store-types";
import { getVmSizeInfo, getAllVmSizes, VmSizeInfo } from "../shared/vm-sizes";

// ---------------------------------------------------------------------------
// Default GPU speeds (Mnos/s = mega-nodes per second, user's benchmark unit)
// ---------------------------------------------------------------------------
interface GpuSpeed {
    gpuType: string;
    defaultSpeed: number; // Mnos/s
}

const DEFAULT_GPU_SPEEDS: GpuSpeed[] = [
    { gpuType: "V100", defaultSpeed: 100 },
    { gpuType: "H100", defaultSpeed: 343 },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface RegionGpuSummary {
    region: string;
    vmBreakdown: Array<{
        vmSize: string;
        vmShort: string;
        gpuType: string;
        gpuCount: number; // GPUs per node
        nodeCount: number;
        totalGpus: number;
        speedPerGpu: number;
        totalSpeed: number; // totalGpus * speedPerGpu
    }>;
    totalGpus: number;
    totalSpeed: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function vmShortName(vmSize: string): string {
    return vmSize.replace("Standard_", "").replace(/_/g, " ");
}

function groupPoolsByRegion(
    poolInfos: PoolInfo[],
    speeds: Map<string, number>
): RegionGpuSummary[] {
    // Group pools by region + vmSize
    const regionMap = new Map<
        string,
        Map<string, { vmInfo: VmSizeInfo; nodes: number }>
    >();

    for (const pool of poolInfos) {
        if (pool.state === "deleting") continue;
        const totalNodes =
            (pool.currentDedicatedNodes ?? 0) +
            (pool.currentLowPriorityNodes ?? 0);
        if (totalNodes === 0) continue;

        const vmInfo = getVmSizeInfo(pool.vmSize);
        if (!vmInfo || !vmInfo.isGpu) continue;

        if (!regionMap.has(pool.region)) {
            regionMap.set(pool.region, new Map());
        }
        const vmMap = regionMap.get(pool.region)!;
        const key = pool.vmSize.toLowerCase();
        if (!vmMap.has(key)) {
            vmMap.set(key, { vmInfo, nodes: 0 });
        }
        vmMap.get(key)!.nodes += totalNodes;
    }

    // Build summaries
    const summaries: RegionGpuSummary[] = [];
    for (const [region, vmMap] of regionMap) {
        const vmBreakdown: RegionGpuSummary["vmBreakdown"] = [];
        let totalGpus = 0;
        let totalSpeed = 0;

        for (const [, { vmInfo, nodes }] of vmMap) {
            const gpuType = vmInfo.gpuType;
            const gpuPerNode = vmInfo.gpuCount;
            const gpus = nodes * gpuPerNode;
            const speedPerGpu = speeds.get(gpuType) ?? 0;
            const speed = gpus * speedPerGpu;

            vmBreakdown.push({
                vmSize: vmInfo.name,
                vmShort: vmShortName(vmInfo.name),
                gpuType,
                gpuCount: gpuPerNode,
                nodeCount: nodes,
                totalGpus: gpus,
                speedPerGpu,
                totalSpeed: speed,
            });

            totalGpus += gpus;
            totalSpeed += speed;
        }

        // Sort breakdown by totalGpus descending
        vmBreakdown.sort((a, b) => b.totalGpus - a.totalGpus);

        summaries.push({ region, vmBreakdown, totalGpus, totalSpeed });
    }

    // Sort regions by totalGpus descending
    summaries.sort((a, b) => b.totalGpus - a.totalGpus);
    return summaries;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const StatCard: React.FC<{
    icon: string;
    label: string;
    value: string;
    color: string;
    sub?: string;
}> = ({ icon, label, value, color, sub }) => (
    <div
        style={{
            background: "#1e1e1e",
            borderRadius: 8,
            padding: "16px 20px",
            minWidth: 160,
            flex: 1,
        }}
        role="status"
        aria-label={`${label}: ${value}`}
    >
        <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 10 }}>
            <Icon iconName={icon} styles={{ root: { fontSize: 22, color } }} />
            <div>
                <Text
                    variant="tiny"
                    styles={{
                        root: {
                            color: "#888",
                            display: "block",
                            fontSize: 11,
                            textTransform: "uppercase" as const,
                            letterSpacing: "0.5px",
                        },
                    }}
                >
                    {label}
                </Text>
                <Text
                    variant="xLarge"
                    styles={{
                        root: { fontWeight: 700, color, lineHeight: "1.2" },
                    }}
                >
                    {value}
                </Text>
                {sub && (
                    <Text
                        variant="tiny"
                        styles={{
                            root: {
                                color: "#666",
                                display: "block",
                                fontSize: 10,
                            },
                        }}
                    >
                        {sub}
                    </Text>
                )}
            </div>
        </Stack>
    </div>
);

const RegionCard: React.FC<{
    summary: RegionGpuSummary;
    grandTotalSpeed: number;
}> = ({ summary, grandTotalSpeed }) => {
    const pct =
        grandTotalSpeed > 0
            ? ((summary.totalSpeed / grandTotalSpeed) * 100).toFixed(1)
            : "0";

    return (
        <div
            style={{
                background: "#1e1e1e",
                borderRadius: 8,
                overflow: "hidden",
                marginBottom: 8,
            }}
        >
            {/* Region header */}
            <div
                style={{
                    padding: "12px 16px",
                    background: "#252525",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                }}
            >
                <Stack
                    horizontal
                    verticalAlign="center"
                    tokens={{ childrenGap: 10 }}
                >
                    <Icon
                        iconName="Globe"
                        styles={{ root: { color: "#0078d4", fontSize: 18 } }}
                    />
                    <Text
                        styles={{
                            root: {
                                color: "#eee",
                                fontWeight: 600,
                                fontSize: 14,
                            },
                        }}
                    >
                        {summary.region}
                    </Text>
                </Stack>
                <Stack
                    horizontal
                    tokens={{ childrenGap: 16 }}
                    verticalAlign="center"
                >
                    <span
                        style={{
                            background: "#0a2a4a",
                            color: "#0078d4",
                            borderRadius: 10,
                            padding: "2px 10px",
                            fontSize: 12,
                            fontWeight: 700,
                        }}
                    >
                        {summary.totalGpus} GPUs
                    </span>
                    <span
                        style={{
                            background: "#2a0a4a",
                            color: "#8764b8",
                            borderRadius: 10,
                            padding: "2px 10px",
                            fontSize: 12,
                            fontWeight: 700,
                        }}
                    >
                        {formatSpeed(summary.totalSpeed)}
                    </span>
                    <span
                        style={{
                            color: "#888",
                            fontSize: 11,
                        }}
                    >
                        {pct}% of total
                    </span>
                </Stack>
            </div>

            {/* VM breakdown table */}
            <div style={{ padding: "8px 16px 12px" }}>
                <table
                    style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: 13,
                    }}
                >
                    <thead>
                        <tr
                            style={{
                                color: "#888",
                                borderBottom: "1px solid #333",
                                fontSize: 11,
                                textTransform: "uppercase" as const,
                                letterSpacing: "0.5px",
                            }}
                        >
                            <th
                                style={{
                                    textAlign: "left",
                                    padding: "6px 8px",
                                }}
                            >
                                VM Size
                            </th>
                            <th
                                style={{
                                    textAlign: "center",
                                    padding: "6px 8px",
                                }}
                            >
                                GPU Type
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                Nodes
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                GPUs/Node
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                Total GPUs
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                Speed/GPU
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                Total Speed
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {summary.vmBreakdown.map((vm) => (
                            <tr
                                key={vm.vmSize}
                                style={{
                                    borderBottom: "1px solid #2a2a2a",
                                    color: "#ccc",
                                }}
                            >
                                <td
                                    style={{
                                        padding: "8px",
                                        fontWeight: 600,
                                        color: "#eee",
                                    }}
                                >
                                    {vm.vmShort}
                                </td>
                                <td
                                    style={{
                                        textAlign: "center",
                                        padding: "8px",
                                    }}
                                >
                                    <span
                                        style={{
                                            background:
                                                vm.gpuType === "H100"
                                                    ? "#2a1a0a"
                                                    : "#0a2a1a",
                                            color:
                                                vm.gpuType === "H100"
                                                    ? "#e3a400"
                                                    : "#107c10",
                                            borderRadius: 4,
                                            padding: "2px 8px",
                                            fontSize: 11,
                                            fontWeight: 700,
                                        }}
                                    >
                                        {vm.gpuType}
                                    </span>
                                </td>
                                <td
                                    style={{
                                        textAlign: "right",
                                        padding: "8px",
                                    }}
                                >
                                    {vm.nodeCount}
                                </td>
                                <td
                                    style={{
                                        textAlign: "right",
                                        padding: "8px",
                                        color: "#888",
                                    }}
                                >
                                    {vm.gpuCount}
                                </td>
                                <td
                                    style={{
                                        textAlign: "right",
                                        padding: "8px",
                                        fontWeight: 700,
                                        color: "#0078d4",
                                    }}
                                >
                                    {vm.totalGpus}
                                </td>
                                <td
                                    style={{
                                        textAlign: "right",
                                        padding: "8px",
                                        color: "#888",
                                    }}
                                >
                                    {vm.speedPerGpu}
                                </td>
                                <td
                                    style={{
                                        textAlign: "right",
                                        padding: "8px",
                                        fontWeight: 700,
                                        color: "#8764b8",
                                    }}
                                >
                                    {formatSpeed(vm.totalSpeed)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

function formatSpeed(mnos: number): string {
    if (mnos >= 1000) {
        return `${(mnos / 1000).toFixed(1)} Gnos/s`;
    }
    return `${mnos.toLocaleString()} Mnos/s`;
}

function formatNumber(n: number): string {
    return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export const GpuCalculatorPage: React.FC = () => {
    const state = useMultiRegionState();

    // Editable GPU speeds
    const [speeds, setSpeeds] = React.useState<Map<string, number>>(() => {
        const m = new Map<string, number>();
        for (const s of DEFAULT_GPU_SPEEDS) {
            m.set(s.gpuType, s.defaultSpeed);
        }
        return m;
    });

    const updateSpeed = (gpuType: string, value: string) => {
        const num = parseFloat(value);
        if (!isNaN(num) && num >= 0) {
            setSpeeds((prev) => {
                const next = new Map(prev);
                next.set(gpuType, num);
                return next;
            });
        }
    };

    // Calculate from live pool data
    const poolInfos = state.poolInfos ?? [];
    const regionSummaries = React.useMemo(
        () => groupPoolsByRegion(poolInfos, speeds),
        [poolInfos, speeds]
    );

    // Grand totals
    const grandTotalGpus = regionSummaries.reduce((s, r) => s + r.totalGpus, 0);
    const grandTotalSpeed = regionSummaries.reduce(
        (s, r) => s + r.totalSpeed,
        0
    );
    const grandTotalNodes = regionSummaries.reduce(
        (s, r) => s + r.vmBreakdown.reduce((ns, vm) => ns + vm.nodeCount, 0),
        0
    );
    const regionCount = regionSummaries.length;

    // GPU type totals
    const gpuTypeTotals = React.useMemo(() => {
        const totals = new Map<string, { gpus: number; speed: number }>();
        for (const r of regionSummaries) {
            for (const vm of r.vmBreakdown) {
                const prev = totals.get(vm.gpuType) ?? { gpus: 0, speed: 0 };
                totals.set(vm.gpuType, {
                    gpus: prev.gpus + vm.totalGpus,
                    speed: prev.speed + vm.totalSpeed,
                });
            }
        }
        return totals;
    }, [regionSummaries]);

    // All VM sizes for reference
    const allVms = getAllVmSizes();

    return (
        <div style={{ padding: "16px 0" }}>
            {/* Header */}
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 12 }}
                styles={{ root: { marginBottom: 16 } }}
            >
                <Icon
                    iconName="Calculator"
                    styles={{
                        root: { fontSize: 24, color: "#8764b8" },
                    }}
                />
                <div>
                    <Text
                        variant="xLarge"
                        styles={{
                            root: { fontWeight: 600, color: "#eee" },
                        }}
                    >
                        GPU Calculator
                    </Text>
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
                        Compute total speed from live pool data. Edit GPU speeds
                        below.
                    </Text>
                </div>
            </Stack>

            {/* GPU Speed Settings */}
            <div
                style={{
                    background: "#1e1e1e",
                    borderRadius: 8,
                    padding: 16,
                    marginBottom: 16,
                }}
            >
                <Text
                    variant="medium"
                    styles={{
                        root: {
                            fontWeight: 600,
                            color: "#ccc",
                            marginBottom: 12,
                            display: "block",
                        },
                    }}
                >
                    GPU Speed Settings (Mnos/s per GPU)
                </Text>
                <Stack horizontal tokens={{ childrenGap: 24 }} wrap>
                    {DEFAULT_GPU_SPEEDS.map((gs) => (
                        <Stack
                            key={gs.gpuType}
                            horizontal
                            verticalAlign="center"
                            tokens={{ childrenGap: 8 }}
                        >
                            <span
                                style={{
                                    background:
                                        gs.gpuType === "H100"
                                            ? "#2a1a0a"
                                            : "#0a2a1a",
                                    color:
                                        gs.gpuType === "H100"
                                            ? "#e3a400"
                                            : "#107c10",
                                    borderRadius: 4,
                                    padding: "4px 10px",
                                    fontSize: 13,
                                    fontWeight: 700,
                                    minWidth: 50,
                                    textAlign: "center",
                                }}
                            >
                                {gs.gpuType}
                            </span>
                            <TextField
                                value={String(
                                    speeds.get(gs.gpuType) ?? gs.defaultSpeed
                                )}
                                onChange={(_e, val) =>
                                    updateSpeed(gs.gpuType, val ?? "0")
                                }
                                type="number"
                                styles={{
                                    root: { width: 120 },
                                    field: {
                                        textAlign: "right",
                                        fontWeight: 600,
                                    },
                                }}
                                suffix="Mnos/s"
                                aria-label={`${gs.gpuType} speed in Mnos/s`}
                            />
                        </Stack>
                    ))}
                </Stack>
            </div>

            {/* Summary Stats */}
            <Stack
                horizontal
                tokens={{ childrenGap: 12 }}
                wrap
                styles={{ root: { marginBottom: 16 } }}
            >
                <StatCard
                    icon="Globe"
                    label="Regions"
                    value={String(regionCount)}
                    color="#0078d4"
                />
                <StatCard
                    icon="Server"
                    label="Total Nodes"
                    value={formatNumber(grandTotalNodes)}
                    color="#00b7c3"
                />
                <StatCard
                    icon="ProcessingRun"
                    label="Total GPUs"
                    value={formatNumber(grandTotalGpus)}
                    color="#e3a400"
                />
                <StatCard
                    icon="SpeedHigh"
                    label="Total Speed"
                    value={formatSpeed(grandTotalSpeed)}
                    color="#8764b8"
                    sub={`${grandTotalGpus} GPUs × avg ${grandTotalGpus > 0 ? Math.round(grandTotalSpeed / grandTotalGpus) : 0} Mnos/s`}
                />
            </Stack>

            {/* GPU Type Breakdown */}
            <Stack
                horizontal
                tokens={{ childrenGap: 12 }}
                wrap
                styles={{ root: { marginBottom: 16 } }}
            >
                {Array.from(gpuTypeTotals.entries()).map(
                    ([gpuType, totals]) => (
                        <div
                            key={gpuType}
                            style={{
                                background: "#1e1e1e",
                                borderRadius: 8,
                                padding: "12px 16px",
                                minWidth: 180,
                                flex: 1,
                            }}
                        >
                            <Stack
                                horizontal
                                verticalAlign="center"
                                tokens={{ childrenGap: 8 }}
                            >
                                <span
                                    style={{
                                        background:
                                            gpuType === "H100"
                                                ? "#2a1a0a"
                                                : "#0a2a1a",
                                        color:
                                            gpuType === "H100"
                                                ? "#e3a400"
                                                : "#107c10",
                                        borderRadius: 4,
                                        padding: "4px 10px",
                                        fontSize: 14,
                                        fontWeight: 700,
                                    }}
                                >
                                    {gpuType}
                                </span>
                                <div>
                                    <Text
                                        styles={{
                                            root: {
                                                color: "#eee",
                                                fontWeight: 700,
                                                fontSize: 16,
                                            },
                                        }}
                                    >
                                        {formatNumber(totals.gpus)} GPUs
                                    </Text>
                                    <Text
                                        styles={{
                                            root: {
                                                color: "#8764b8",
                                                fontSize: 12,
                                                display: "block",
                                            },
                                        }}
                                    >
                                        {formatSpeed(totals.speed)}
                                    </Text>
                                </div>
                            </Stack>
                        </div>
                    )
                )}
            </Stack>

            {/* VM Reference Table */}
            <div
                style={{
                    background: "#1e1e1e",
                    borderRadius: 8,
                    padding: 16,
                    marginBottom: 16,
                }}
            >
                <Text
                    variant="medium"
                    styles={{
                        root: {
                            fontWeight: 600,
                            color: "#ccc",
                            marginBottom: 12,
                            display: "block",
                        },
                    }}
                >
                    VM Reference
                </Text>
                <table
                    style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: 13,
                    }}
                >
                    <thead>
                        <tr
                            style={{
                                color: "#888",
                                borderBottom: "1px solid #333",
                                fontSize: 11,
                                textTransform: "uppercase" as const,
                            }}
                        >
                            <th
                                style={{
                                    textAlign: "left",
                                    padding: "6px 8px",
                                }}
                            >
                                VM Size
                            </th>
                            <th
                                style={{
                                    textAlign: "center",
                                    padding: "6px 8px",
                                }}
                            >
                                GPU
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                GPUs/Node
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                VRAM/GPU
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                vCPUs
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                RAM (GB)
                            </th>
                            <th
                                style={{
                                    textAlign: "right",
                                    padding: "6px 8px",
                                }}
                            >
                                Speed/Node
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {allVms.map((vm) => {
                            const speedPerGpu = speeds.get(vm.gpuType) ?? 0;
                            const speedPerNode = speedPerGpu * vm.gpuCount;
                            return (
                                <tr
                                    key={vm.name}
                                    style={{
                                        borderBottom: "1px solid #2a2a2a",
                                        color: "#ccc",
                                    }}
                                >
                                    <td
                                        style={{
                                            padding: "8px",
                                            fontWeight: 600,
                                            color: "#eee",
                                        }}
                                    >
                                        {vmShortName(vm.name)}
                                    </td>
                                    <td
                                        style={{
                                            textAlign: "center",
                                            padding: "8px",
                                        }}
                                    >
                                        <span
                                            style={{
                                                background:
                                                    vm.gpuType === "H100"
                                                        ? "#2a1a0a"
                                                        : "#0a2a1a",
                                                color:
                                                    vm.gpuType === "H100"
                                                        ? "#e3a400"
                                                        : "#107c10",
                                                borderRadius: 4,
                                                padding: "2px 8px",
                                                fontSize: 11,
                                                fontWeight: 700,
                                            }}
                                        >
                                            {vm.gpuType}
                                        </span>
                                    </td>
                                    <td
                                        style={{
                                            textAlign: "right",
                                            padding: "8px",
                                        }}
                                    >
                                        {vm.gpuCount}
                                    </td>
                                    <td
                                        style={{
                                            textAlign: "right",
                                            padding: "8px",
                                            color: "#888",
                                        }}
                                    >
                                        {vm.gpuMemoryGB} GB
                                    </td>
                                    <td
                                        style={{
                                            textAlign: "right",
                                            padding: "8px",
                                            color: "#888",
                                        }}
                                    >
                                        {vm.vCPUs}
                                    </td>
                                    <td
                                        style={{
                                            textAlign: "right",
                                            padding: "8px",
                                            color: "#888",
                                        }}
                                    >
                                        {vm.memoryGB}
                                    </td>
                                    <td
                                        style={{
                                            textAlign: "right",
                                            padding: "8px",
                                            fontWeight: 700,
                                            color: "#8764b8",
                                        }}
                                    >
                                        {formatSpeed(speedPerNode)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Per-Region Cards */}
            {regionSummaries.length === 0 ? (
                <Stack
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}
                    styles={{ root: { padding: 40 } }}
                >
                    <Icon
                        iconName="Calculator"
                        styles={{
                            root: { fontSize: 48, color: "#555" },
                        }}
                    />
                    <Text variant="large" styles={{ root: { color: "#888" } }}>
                        No active GPU pools
                    </Text>
                    <Text variant="small" styles={{ root: { color: "#666" } }}>
                        GPU calculations will appear once pools with nodes are
                        discovered. Go to Pool Info and click Refresh.
                    </Text>
                </Stack>
            ) : (
                <>
                    <Text
                        variant="medium"
                        styles={{
                            root: {
                                fontWeight: 600,
                                color: "#ccc",
                                marginBottom: 8,
                                display: "block",
                            },
                        }}
                    >
                        Per-Region Breakdown ({regionCount} region
                        {regionCount !== 1 ? "s" : ""})
                    </Text>
                    {regionSummaries.map((summary) => (
                        <RegionCard
                            key={summary.region}
                            summary={summary}
                            grandTotalSpeed={grandTotalSpeed}
                        />
                    ))}
                </>
            )}
        </div>
    );
};
