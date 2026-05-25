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

import { cn } from "@/lib/utils";

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

const FADE_MASK: Record<NonNullable<DotPatternProps["fade"]>, string> = {
  center:
    "radial-gradient(ellipse at center, white 0%, transparent 70%)",
  "top-left":
    "radial-gradient(ellipse at top left, white 0%, transparent 60%)",
  top: "linear-gradient(to bottom, white 0%, transparent 80%)",
  none: "",
};

export const DotPattern: React.FC<DotPatternProps> = ({
  spacing = 16,
  radius = 1,
  fade = "center",
  color = "hsl(var(--muted-foreground) / 0.25)",
  className,
}) => {
  const id = React.useId();
  const maskStyle =
    fade !== "none"
      ? {
          maskImage: FADE_MASK[fade],
          WebkitMaskImage: FADE_MASK[fade],
        }
      : undefined;
  return (
    <svg
      aria-hidden="true"
      className={cn(
        // -z-10: same rationale as Meteors and BorderBeam — this is a
        // decorative background layer and must paint behind the parent's
        // static-flow content. Otherwise the dot grid renders above
        // headings/buttons and clicks blocked (mitigated by
        // pointer-events-none, but visual ordering still wrong).
        "pointer-events-none absolute inset-0 -z-10 h-full w-full",
        className,
      )}
      style={maskStyle}
    >
      <defs>
        <pattern
          id={id}
          x="0"
          y="0"
          width={spacing}
          height={spacing}
          patternUnits="userSpaceOnUse"
        >
          <circle cx={spacing / 2} cy={spacing / 2} r={radius} fill={color} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
};
