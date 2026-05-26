/**
 * DotPattern — a subtle dot grid background, rendered as an inline SVG.
 *
 * Use as the bottom layer of a hero card or page section. Pair with a
 * radial-gradient mask via the `fade` prop so the pattern is densest
 * at the focal point and dissolves to transparent at the edges.
 *
 *   <div className="relative overflow-hidden rounded-xl border bg-card">
 *     <DotPattern />
 *     <div className="relative">...content...</div>
 *   </div>
 *
 * Pure SVG + CSS, no JS animation, no framer-motion.
 */
import * as React from "react";
export interface DotPatternProps {
    /** Distance between dot centers, in pixels. */
    spacing?: number;
    /** Dot radius in pixels. */
    radius?: number;
    /**
     * Where to focus the radial-gradient fade:
     *   - "center"    : densest in the middle, fades to all edges
     *   - "top-left"  : densest at top-left, fades to bottom-right
     *   - "none"      : no fade (full-bleed pattern)
     */
    fade?: "center" | "top-left" | "top" | "none";
    /** Dot color. Defaults to muted-foreground at low opacity. */
    color?: string;
    className?: string;
}
export declare const DotPattern: React.FC<DotPatternProps>;
//# sourceMappingURL=dot-pattern.d.ts.map