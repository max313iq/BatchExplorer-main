import * as React from "react";
type RegionBadgeTone = "success" | "warning" | "destructive" | "info" | "muted";
export interface RegionBadgeProps {
    region: string;
    gpu?: boolean;
    healthy?: boolean;
    tone?: RegionBadgeTone;
    className?: string;
}
export declare const RegionBadge: React.FC<RegionBadgeProps>;
export {};
//# sourceMappingURL=region-badge.d.ts.map