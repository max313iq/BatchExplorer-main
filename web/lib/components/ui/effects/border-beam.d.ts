/**
 * BorderBeam — a soft beam of light that travels around a card border.
 *
 * Pure CSS implementation (no framer-motion). Three-layer technique:
 *
 *   1. Wrapper      : absolute inset-0, overflow-hidden, rounded-[inherit]
 *   2. Conic layer  : absolute inset-[-50%], spinning conic-gradient
 *   3. Cover layer  : absolute inset-[borderWidth], solid bg matching the
 *                     parent card, "punches a hole" so only a 1-2px ring
 *                     of the conic gradient shows around the edge
 *
 * Previous mask-composite implementation rendered correctly in some
 * browsers but filled the entire card interior in others (the browser
 * dropped the mask layer when Tailwind's arbitrary-value comma syntax
 * confused the parser). The cover-layer approach is bulletproof —
 * works in every browser, no mask CSS at all.
 *
 *   <div className="relative rounded-xl border bg-card p-6 overflow-hidden">
 *     <BorderBeam />
 *     ...content (must have z-10 if it should sit above the cover)...
 *   </div>
 *
 * The cover layer is `bg-card` by default to match shadcn cards. If the
 * parent uses a different surface (`bg-background`, `bg-popover`,
 * `bg-card/50`), pass `coverClassName` to override.
 *
 * Honors `prefers-reduced-motion` — animation pauses, beam still
 * visible as a static gradient hint around the border.
 */
import * as React from "react";
export interface BorderBeamProps {
    /** Beam length around the perimeter, in degrees (1-359). Smaller = tighter dot. */
    size?: number;
    /** Seconds for one full revolution. */
    duration?: number;
    /** Delay before the beam starts, in seconds. */
    delay?: number;
    /** Beam start color. Defaults to project's gradient-primary-start CSS var. */
    colorFrom?: string;
    /** Beam end color. Defaults to project's gradient-primary-end CSS var. */
    colorTo?: string;
    /** Stroke thickness in pixels. */
    borderWidth?: number;
    /** Reverse the rotation direction. */
    reverse?: boolean;
    /**
     * Tailwind classes for the cover layer that masks the gradient to just
     * the border ring. MUST match the parent card's background colour, or
     * the conic gradient will show through. Default: `bg-card`.
     */
    coverClassName?: string;
    className?: string;
}
export declare const BorderBeam: React.FC<BorderBeamProps>;
//# sourceMappingURL=border-beam.d.ts.map