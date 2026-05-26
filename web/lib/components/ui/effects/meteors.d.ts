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
export interface MeteorsProps {
    /** Number of meteor streaks. 10-40 is the sweet spot. */
    count?: number;
    /** Tone — controls the streak color. Defaults to primary. */
    tone?: "primary" | "accent" | "success" | "warning";
    className?: string;
}
export declare const Meteors: React.FC<MeteorsProps>;
//# sourceMappingURL=meteors.d.ts.map