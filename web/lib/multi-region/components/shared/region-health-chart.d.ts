import * as React from "react";
export interface RegionHealthRow {
    name: string;
    healthy: number;
    total: number;
}
export interface RegionHealthChartProps {
    regions: RegionHealthRow[];
    className?: string;
}
export declare const RegionHealthChart: React.FC<RegionHealthChartProps>;
//# sourceMappingURL=region-health-chart.d.ts.map