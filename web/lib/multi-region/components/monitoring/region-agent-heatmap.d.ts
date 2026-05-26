/**
 * RegionAgentHeatmap — region × agent intensity grid for the Monitoring
 * page. Each cell shows the log count for (region, agent) inside the
 * currently-visible window; intensity scales to the global max so the
 * eye lands on the hottest pair.
 *
 * Rationale: the per-region bar chart (`RegionHealthChart`) answers
 * "which regions hold accounts" but says nothing about *which agent* is
 * doing the work. The heatmap surfaces the cross-section so a noisy
 * `provisioner` in a single region pops out without scanning logs.
 *
 * Citation: `New folder\_analysis_netspi.md` §I — region-scoped agent
 * activity bursts are the visible footprint of resource-plane abuse.
 *
 * Pure presentational; the parent passes a fully-derived matrix.
 */
import * as React from "react";
export interface HeatmapCell {
    region: string;
    agent: string;
    count: number;
    errors: number;
}
export interface RegionAgentHeatmapProps {
    cells: ReadonlyArray<HeatmapCell>;
    regions: ReadonlyArray<string>;
    agents: ReadonlyArray<string>;
    onCellClick?: (region: string, agent: string) => void;
    selectedRegion?: string | null;
    className?: string;
}
export declare const RegionAgentHeatmap: React.FC<RegionAgentHeatmapProps>;
//# sourceMappingURL=region-agent-heatmap.d.ts.map