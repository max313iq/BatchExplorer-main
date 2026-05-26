import * as React from "react";
export type SkeletonVariant = "table" | "card" | "stat-bar" | "list" | "form" | "text";
export interface SkeletonLoaderProps {
    variant: SkeletonVariant;
    rows?: number;
    columns?: number;
    cards?: number;
    animate?: boolean;
}
export declare const SkeletonLoader: React.FC<SkeletonLoaderProps>;
//# sourceMappingURL=skeleton-loader.d.ts.map