/**
 * Gauge — used / total bar with semantic tone shifts. Shows a percent fill
 * plus a discrete fraction label. Pure CSS bar; no SVG needed.
 *
 * Tone is computed from the fill ratio by default:
 *   <50%  → success
 *   <80%  → info
 *   <95%  → warning
 *   ≥95%  → destructive
 *
 * Pass `tone="..."` to lock a specific tone.
 */
import * as React from "react";
export type GaugeTone = "primary" | "info" | "success" | "warning" | "destructive";
export interface GaugeProps {
    /** Numerator — typically "used". */
    used: number;
    /** Denominator — typically "total" or "quota". */
    total: number;
    /** Optional explicit tone. When omitted, derived from fill ratio. */
    tone?: GaugeTone;
    /** Optional label rendered above the bar. */
    label?: React.ReactNode;
    /** Optional sub-label rendered above the bar to the right (e.g. units). */
    unit?: string;
    /** Show the fraction text "used / total". Default: true. */
    showFraction?: boolean;
    /** Size variant. Default: "md". */
    size?: "sm" | "md" | "lg";
    /** Optional aria-label override. */
    ariaLabel?: string;
    className?: string;
}
export declare const Gauge: React.FC<GaugeProps>;
/**
 * MiniBar — frequency bar chart for low-cardinality categories. Used for
 * "VM sizes in use", "actions per hour", etc. Pure CSS bars (no SVG).
 *
 * Each bar's width is proportional to the category's value, with a numeric
 * label on the right. Categories are rendered in input order; sort
 * upstream if you want a different ordering.
 */
export interface MiniBarItem {
    /** Category label. */
    label: string;
    /** Numeric value (>= 0). */
    value: number;
    /** Optional tone override; defaults to "primary". */
    tone?: GaugeTone;
}
export interface MiniBarProps {
    items: MiniBarItem[];
    /** Maximum bars to render. Excess collapses to a "+N more" footer. */
    maxItems?: number;
    /** Optional total override (defaults to max value). */
    scaleTo?: number;
    /** Optional aria-label for the chart. */
    ariaLabel?: string;
    className?: string;
}
export declare const MiniBar: React.FC<MiniBarProps>;
//# sourceMappingURL=gauge.d.ts.map