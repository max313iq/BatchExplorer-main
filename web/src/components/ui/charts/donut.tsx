/**
 * Donut chart — pure SVG, no chart library. Used to visualize discrete-state
 * distributions (e.g. node states, account statuses). Renders a thin ring
 * with optional center label.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

export type DonutTone =
  | "primary"
  | "info"
  | "success"
  | "warning"
  | "destructive"
  | "muted"
  | "accent";

export interface DonutSegment {
  /** Segment label — used for legend + sr text. */
  label: string;
  /** Numeric value. Must be >= 0. */
  value: number;
  /** Tone — maps to a CSS variable colour. */
  tone: DonutTone;
}

export interface DonutProps {
  segments: DonutSegment[];
  /** Outer diameter in pixels. Default: 96. */
  size?: number;
  /** Ring thickness in pixels. Default: 12. */
  thickness?: number;
  /** Optional center label (typically a total). */
  centerLabel?: React.ReactNode;
  /** Optional center sub-label below the main label. */
  centerSubLabel?: React.ReactNode;
  /** Optional aria-label for the chart as a whole. */
  ariaLabel?: string;
  /** Optional className for the wrapper. */
  className?: string;
}

const TONE_TO_VAR: Record<DonutTone, string> = {
  primary: "var(--primary)",
  info: "var(--info)",
  success: "var(--success)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
  muted: "var(--muted-foreground)",
  accent: "var(--accent)",
};

/**
 * Convert (cx, cy, r, angle in radians) to (x, y).
 * Angle 0 = top of circle (12 o'clock), increasing clockwise.
 */
function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const [oxs, oys] = polar(cx, cy, rOuter, startAngle);
  const [oxe, oye] = polar(cx, cy, rOuter, endAngle);
  const [ixe, iye] = polar(cx, cy, rInner, endAngle);
  const [ixs, iys] = polar(cx, cy, rInner, startAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${oxs.toFixed(2)} ${oys.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${oxe.toFixed(2)} ${oye.toFixed(2)}`,
    `L ${ixe.toFixed(2)} ${iye.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${ixs.toFixed(2)} ${iys.toFixed(2)}`,
    "Z",
  ].join(" ");
}

export const Donut: React.FC<DonutProps> = ({
  segments,
  size = 96,
  thickness = 12,
  centerLabel,
  centerSubLabel,
  ariaLabel,
  className,
}) => {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 1; // 1px inset so stroke joins don't clip
  const rInner = Math.max(1, rOuter - thickness);

  // Empty state: render a muted ring so the surface doesn't collapse.
  if (total === 0) {
    return (
      <div
        className={cn(
          "relative inline-flex items-center justify-center",
          className,
        )}
        style={{ width: size, height: size }}
        role="img"
        aria-label={ariaLabel ?? "No data"}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={cx}
            cy={cy}
            r={(rOuter + rInner) / 2}
            fill="none"
            stroke={`hsl(${TONE_TO_VAR.muted} / 0.25)`}
            strokeWidth={thickness}
            strokeDasharray="4 4"
          />
        </svg>
        {(centerLabel || centerSubLabel) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            {centerLabel && (
              <span className="text-base font-semibold tabular-nums leading-none">
                {centerLabel}
              </span>
            )}
            {centerSubLabel && (
              <span className="mt-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
                {centerSubLabel}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  let cursor = 0;
  const paths: React.ReactNode[] = [];
  segments.forEach((seg, i) => {
    const value = Math.max(0, seg.value);
    if (value === 0) return;
    const sweep = (value / total) * Math.PI * 2;
    const start = cursor;
    const end = cursor + sweep;
    cursor = end;
    paths.push(
      <path
        key={`${seg.label}-${i}`}
        d={arcPath(cx, cy, rOuter, rInner, start, end)}
        fill={`hsl(${TONE_TO_VAR[seg.tone]})`}
      >
        <title>{`${seg.label}: ${value} (${((value / total) * 100).toFixed(1)}%)`}</title>
      </path>,
    );
  });

  // sr-only summary so screen readers get a structured readout.
  const summary = segments
    .filter((s) => s.value > 0)
    .map((s) => `${s.label} ${s.value}`)
    .join(", ");

  return (
    <div
      className={cn(
        "relative inline-flex items-center justify-center",
        className,
      )}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel ?? summary}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {paths}
      </svg>
      {(centerLabel || centerSubLabel) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {centerLabel && (
            <span className="text-base font-semibold tabular-nums leading-none">
              {centerLabel}
            </span>
          )}
          {centerSubLabel && (
            <span className="mt-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
              {centerSubLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Optional legend companion — renders a per-segment chip list. Keeps colour
 * mapping consistent with the donut.
 */
export const DonutLegend: React.FC<{
  segments: DonutSegment[];
  /** Hide segments with value 0. Default: true. */
  hideEmpty?: boolean;
  className?: string;
}> = ({ segments, hideEmpty = true, className }) => (
  <ul className={cn("flex flex-wrap gap-x-3 gap-y-1 text-2xs", className)}>
    {segments
      .filter((s) => (hideEmpty ? s.value > 0 : true))
      .map((s) => (
        <li
          key={s.label}
          className="inline-flex items-center gap-1.5 text-muted-foreground"
        >
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ backgroundColor: `hsl(${TONE_TO_VAR[s.tone]})` }}
            aria-hidden="true"
          />
          <span className="text-foreground/80">{s.label}</span>
          <span className="tabular-nums text-muted-foreground/80">
            {s.value}
          </span>
        </li>
      ))}
  </ul>
);
