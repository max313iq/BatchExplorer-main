/**
 * Meteors — a sparse rain of light streaks falling diagonally across
 * the parent. Each meteor is a small pseudo-element with a short
 * trailing gradient, animated independently with random offsets so the
 * pattern doesn't repeat visibly.
 *
 * Pure CSS, no framer-motion. The number of meteors and the area they
 * cover are configurable; defaults are tuned for a hero card (full-
 * width strip 200-400px tall).
 *
 * Drop as a child of a `position: relative; overflow: hidden` container.
 *
 *   <div className="relative overflow-hidden rounded-xl border bg-card p-8">
 *     <Meteors count={20} />
 *     ...content (ensure z-10 so it sits above the meteors)...
 *   </div>
 *
 * Honors prefers-reduced-motion (animation pauses).
 */
import * as React from "react";
import { cn } from "@/lib/utils";
const TONE_VAR = {
    primary: "var(--primary)",
    accent: "var(--accent)",
    success: "var(--success)",
    warning: "var(--warning)",
};
export const Meteors = ({ count = 20, tone = "primary", className, }) => {
    // Memoize the per-meteor random offsets so they don't reshuffle on
    // every render. Each meteor gets a deterministic-looking but distinct
    // start position, delay, and animation duration.
    const meteors = React.useMemo(() => {
        return Array.from({ length: count }).map((_, idx) => ({
            key: idx,
            // Spread starts across the top edge.
            left: `${(idx / count) * 100 + (Math.random() * 10 - 5)}%`,
            top: `-${5 + Math.random() * 20}%`,
            // Delay so they don't all start at the same instant.
            delay: `${Math.random() * 5}s`,
            // 4-10s for a leisurely fall.
            duration: `${4 + Math.random() * 6}s`,
        }));
    }, [count]);
    return (React.createElement("div", { "aria-hidden": "true", className: cn(
        // -z-10: decorative layer must sit BEHIND the parent's static-flow
        // children. Without an explicit negative z-index, this absolutely-
        // positioned div paints above the parent's static siblings (per
        // CSS painting order), hiding the actual page content. Same fix
        // as BorderBeam. Requires the parent to establish a stacking
        // context via `position: relative` (canonical for hero cards).
        "pointer-events-none absolute inset-0 -z-10 overflow-hidden", className), style: { ["--meteor-tone"]: TONE_VAR[tone] } }, meteors.map((m) => (React.createElement("span", { key: m.key, className: "absolute h-0.5 w-0.5 rotate-[215deg] rounded-full motion-reduce:animate-none", style: {
            top: m.top,
            left: m.left,
            backgroundColor: `hsl(var(--meteor-tone))`,
            boxShadow: `0 0 0 1px hsl(var(--meteor-tone) / 0.1)`,
            animation: `meteor ${m.duration} ${m.delay} linear infinite`,
        } },
        React.createElement("span", { className: "pointer-events-none absolute -z-10 h-px w-[60px] -translate-y-1/2", style: {
                top: "50%",
                transform: "translateY(-50%)",
                background: `linear-gradient(90deg, hsl(var(--meteor-tone)), transparent)`,
            } }))))));
};
// Inject the @keyframes once per client load.
let _meteorKeyframesInjected = false;
function ensureMeteorKeyframes() {
    if (typeof document === "undefined")
        return;
    if (_meteorKeyframesInjected)
        return;
    _meteorKeyframesInjected = true;
    const style = document.createElement("style");
    style.textContent = `
    @keyframes meteor {
      0% {
        transform: rotate(215deg) translateX(0);
        opacity: 1;
      }
      70% {
        opacity: 1;
      }
      100% {
        transform: rotate(215deg) translateX(-700px);
        opacity: 0;
      }
    }
  `;
    document.head.appendChild(style);
}
if (typeof window !== "undefined") {
    ensureMeteorKeyframes();
}
//# sourceMappingURL=meteors.js.map