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
const FADE_MASK = {
    center: "radial-gradient(ellipse at center, white 0%, transparent 70%)",
    "top-left": "radial-gradient(ellipse at top left, white 0%, transparent 60%)",
    top: "linear-gradient(to bottom, white 0%, transparent 80%)",
    none: "",
};
export const DotPattern = ({ spacing = 16, radius = 1, fade = "center", color = "hsl(var(--muted-foreground) / 0.25)", className, }) => {
    const id = React.useId();
    const maskStyle = fade !== "none"
        ? {
            maskImage: FADE_MASK[fade],
            WebkitMaskImage: FADE_MASK[fade],
        }
        : undefined;
    return (React.createElement("svg", { "aria-hidden": "true", className: cn(
        // -z-10: same rationale as Meteors and BorderBeam — this is a
        // decorative background layer and must paint behind the parent's
        // static-flow content. Otherwise the dot grid renders above
        // headings/buttons and clicks blocked (mitigated by
        // pointer-events-none, but visual ordering still wrong).
        "pointer-events-none absolute inset-0 -z-10 h-full w-full", className), style: maskStyle },
        React.createElement("defs", null,
            React.createElement("pattern", { id: id, x: "0", y: "0", width: spacing, height: spacing, patternUnits: "userSpaceOnUse" },
                React.createElement("circle", { cx: spacing / 2, cy: spacing / 2, r: radius, fill: color }))),
        React.createElement("rect", { width: "100%", height: "100%", fill: `url(#${id})` })));
};
//# sourceMappingURL=dot-pattern.js.map