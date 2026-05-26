/**
 * TracingBeam — a vertical gradient beam alongside a multi-step list,
 * its filled portion driven by a `progress` prop (0-1) so the beam
 * "traces" along as the user advances through a wizard or scrolls a
 * timeline.
 *
 *   <div className="relative">
 *     <TracingBeam progress={currentStep / totalSteps} />
 *     <ol className="ml-6 space-y-4">...steps...</ol>
 *   </div>
 *
 * Pure CSS animation — the filled segment uses height transition with
 * cubic ease, the tip uses a pulsing glow. Honors prefers-reduced-motion.
 *
 * Inspired by Aceternity UI's Tracing Beam pattern, simplified for
 * controlled (progress-driven) usage rather than scroll-driven so it
 * works inside small stepper widgets.
 *   https://ui.aceternity.com/components/tracing-beam
 */
import * as React from "react";
export interface TracingBeamProps {
    /** 0..1 — fraction of the beam that should be filled. */
    progress: number;
    /** Beam thickness in pixels. */
    thickness?: number;
    /** Position relative to the parent's left edge, in pixels. */
    offsetLeft?: number;
    /** Optional explicit height (otherwise spans parent). */
    className?: string;
}
export declare const TracingBeam: React.FC<TracingBeamProps>;
//# sourceMappingURL=tracing-beam.d.ts.map