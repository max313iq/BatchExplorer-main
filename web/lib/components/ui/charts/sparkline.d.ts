/**
 * Sparkline — tiny inline trend line. Pure SVG, no chart library.
 *
 * Designed to fit inside a stat card next to a counter. Auto-scales the
 * Y axis to the data; X axis is sample-index. Renders nothing for fewer
 * than 2 samples (the surface stays clean during cold-start).
 */
import * as React from "react";
export type SparklineTone = "primary" | "info" | "success" | "warning" | "destructive" | "muted";
export interface SparklineProps {
    /** Time-ordered numeric samples (oldest first). */
    data: number[];
    /** Width in pixels. Default: 80. */
    width?: number;
    /** Height in pixels. Default: 20. */
    height?: number;
    /** Tone (mapped to a CSS variable colour). Default: primary. */
    tone?: SparklineTone;
    /** Line stroke width in CSS pixels. Default: 1.5. */
    strokeWidth?: number;
    /**
     * When true, fills the area below the line at 12% opacity. Default: true.
     * Set to `false` for very small inline contexts where fill adds visual noise.
     */
    fill?: boolean;
    /** Optional aria-label for screen readers. */
    ariaLabel?: string;
    /** Optional className passed through to the <svg> root. */
    className?: string;
}
export declare const Sparkline: React.FC<SparklineProps>;
//# sourceMappingURL=sparkline.d.ts.map