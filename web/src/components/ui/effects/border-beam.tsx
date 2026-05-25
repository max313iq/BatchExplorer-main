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

import { cn } from "@/lib/utils";

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

export const BorderBeam: React.FC<BorderBeamProps> = ({
  size = 60,
  duration = 8,
  delay = 0,
  colorFrom = "hsl(var(--gradient-primary-start))",
  colorTo = "hsl(var(--gradient-primary-end))",
  borderWidth = 1.5,
  reverse = false,
  coverClassName = "bg-card",
  className,
}) => {
  return (
    <div
      aria-hidden="true"
      className={cn(
        // Wrapper: absolute over the parent's interior, clipped to the
        // parent's rounded corners. The conic layer's inset-[-50%] would
        // otherwise leak past the parent.
        //
        // -z-10 is critical: an absolutely-positioned div without negative
        // z-index paints ABOVE the parent's static-flow children, so the
        // cover layer hides the Card content. With -z-10, the BorderBeam
        // sits behind the content; only the gradient ring shows around
        // the edges. Requires the parent to establish a stacking context
        // (it does — `position: relative` is canonical for cards).
        "pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]",
        className,
      )}
    >
      {/* Spinning conic gradient — covers full wrapper at -50% on each
          side so the bright arc has room to sweep around all four
          corners without the trailing edge popping out. */}
      <div
        className="absolute inset-[-50%] motion-reduce:animate-none"
        style={{
          background: `conic-gradient(from 0deg, transparent 0deg, transparent ${360 - size}deg, ${colorFrom} ${360 - size + 1}deg, ${colorTo} 359deg, transparent 360deg)`,
          animation: `border-beam-spin ${duration}s linear ${delay}s infinite ${reverse ? "reverse" : "normal"}`,
        }}
      />
      {/* Cover layer — solid card background inset by borderWidth so
          only the rim of the conic gradient is visible. */}
      <div
        className={cn(
          "absolute rounded-[inherit]",
          coverClassName,
        )}
        style={{
          inset: `${borderWidth}px`,
        }}
      />
    </div>
  );
};

// Shared keyframe injected once per client load.
let _keyframesInjected = false;
function ensureKeyframes(): void {
  if (typeof document === "undefined") return;
  if (_keyframesInjected) return;
  _keyframesInjected = true;
  const style = document.createElement("style");
  style.textContent = `@keyframes border-beam-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}

if (typeof window !== "undefined") {
  ensureKeyframes();
}
