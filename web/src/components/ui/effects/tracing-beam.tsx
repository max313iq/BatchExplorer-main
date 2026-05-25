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

import { cn } from "@/lib/utils";

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

export const TracingBeam: React.FC<TracingBeamProps> = ({
  progress,
  thickness = 2,
  offsetLeft = 8,
  className,
}) => {
  const clamped = Math.min(1, Math.max(0, progress));
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 z-0",
        className,
      )}
      style={{
        left: offsetLeft,
        width: thickness,
      }}
    >
      {/* Background rail — full-height muted. */}
      <span className="absolute inset-0 rounded-full bg-border" />

      {/* Filled portion — gradient from cyan top to violet bottom of
          the FILLED region. Height transitions when `progress` changes. */}
      <span
        className={cn(
          "absolute inset-x-0 top-0 rounded-full",
          "bg-gradient-to-b from-[hsl(var(--gradient-primary-start))] via-[hsl(var(--gradient-primary-mid))] to-[hsl(var(--gradient-primary-end))]",
          "transition-[height] duration-500 ease-out motion-reduce:transition-none",
          "shadow-[0_0_8px_0_hsl(var(--gradient-primary-mid)/0.6)]",
        )}
        style={{
          height: `${clamped * 100}%`,
        }}
      />

      {/* Pulsing tip — a soft glow at the leading edge of the filled
          segment. Animation pauses when progress hits 1. */}
      {clamped > 0 && clamped < 1 && (
        <span
          className={cn(
            "absolute h-3 w-3 -translate-x-1/2 rounded-full",
            "bg-[hsl(var(--gradient-primary-mid))]",
            "shadow-[0_0_12px_4px_hsl(var(--gradient-primary-mid)/0.6)]",
            "animate-pulse motion-reduce:animate-none",
          )}
          style={{
            top: `calc(${clamped * 100}% - 6px)`,
            left: "50%",
          }}
        />
      )}
    </div>
  );
};
