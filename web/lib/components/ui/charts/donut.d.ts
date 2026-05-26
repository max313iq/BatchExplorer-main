/**
 * Donut chart — pure SVG, no chart library. Used to visualize discrete-state
 * distributions (e.g. node states, account statuses). Renders a thin ring
 * with optional center label.
 */
import * as React from "react";
export type DonutTone = "primary" | "info" | "success" | "warning" | "destructive" | "muted" | "accent";
export interface DonutSegment {
    /** Segment label — used for legend + sr text. */
    label: string;
    /** Numeric value. Must be >= 0. */
    value: number;
    /** Tone — maps to a CSS variable colour. */
    tone: DonutTone;
}
export interface DonutProps {
    segments: DonutSegment[];
    /** Outer diameter in pixels. Default: 96. */
    size?: number;
    /** Ring thickness in pixels. Default: 12. */
    thickness?: number;
    /** Optional center label (typically a total). */
    centerLabel?: React.ReactNode;
    /** Optional center sub-label below the main label. */
    centerSubLabel?: React.ReactNode;
    /** Optional aria-label for the chart as a whole. */
    ariaLabel?: string;
    /** Optional className for the wrapper. */
    className?: string;
}
export declare const Donut: React.FC<DonutProps>;
/**
 * Optional legend companion — renders a per-segment chip list. Keeps colour
 * mapping consistent with the donut.
 */
export declare const DonutLegend: React.FC<{
    segments: DonutSegment[];
    /** Hide segments with value 0. Default: true. */
    hideEmpty?: boolean;
    className?: string;
}>;
//# sourceMappingURL=donut.d.ts.map