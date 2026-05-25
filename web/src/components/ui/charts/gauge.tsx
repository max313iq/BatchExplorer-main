/**
 * Gauge — used / total bar with semantic tone shifts. Shows a percent fill
 * plus a discrete fraction label. Pure CSS bar; no SVG needed.
 *
 * Tone is computed from the fill ratio by default:
 *   <50%  → success
 *   <80%  → info
 *   <95%  → warning
 *   ≥95%  → destructive
 *
 * Pass `tone="..."` to lock a specific tone.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

export type GaugeTone =
  | "primary"
  | "info"
  | "success"
  | "warning"
  | "destructive";

export interface GaugeProps {
  /** Numerator — typically "used". */
  used: number;
  /** Denominator — typically "total" or "quota". */
  total: number;
  /** Optional explicit tone. When omitted, derived from fill ratio. */
  tone?: GaugeTone;
  /** Optional label rendered above the bar. */
  label?: React.ReactNode;
  /** Optional sub-label rendered above the bar to the right (e.g. units). */
  unit?: string;
  /** Show the fraction text "used / total". Default: true. */
  showFraction?: boolean;
  /** Size variant. Default: "md". */
  size?: "sm" | "md" | "lg";
  /** Optional aria-label override. */
  ariaLabel?: string;
  className?: string;
}

const TONE_FILL: Record<GaugeTone, string> = {
  primary: "bg-primary",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

const TONE_TEXT: Record<GaugeTone, string> = {
  primary: "text-primary",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

const SIZE_BAR: Record<NonNullable<GaugeProps["size"]>, string> = {
  sm: "h-1",
  md: "h-1.5",
  lg: "h-2",
};

function deriveTone(ratio: number): GaugeTone {
  if (!Number.isFinite(ratio) || ratio < 0) return "muted" as GaugeTone;
  if (ratio < 0.5) return "success";
  if (ratio < 0.8) return "info";
  if (ratio < 0.95) return "warning";
  return "destructive";
}

const NUMBER_FORMAT = new Intl.NumberFormat();

export const Gauge: React.FC<GaugeProps> = ({
  used,
  total,
  tone,
  label,
  unit,
  showFraction = true,
  size = "md",
  ariaLabel,
  className,
}) => {
  const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
  const pct = ratio * 100;
  const effectiveTone: GaugeTone = tone ?? deriveTone(ratio);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {(label || showFraction || unit) && (
        <div className="flex items-baseline justify-between gap-3 text-2xs">
          {label && (
            <span className="font-medium text-foreground/90">{label}</span>
          )}
          <span className="ml-auto inline-flex items-baseline gap-1 tabular-nums">
            {showFraction && (
              <>
                <span className={cn("font-semibold", TONE_TEXT[effectiveTone])}>
                  {NUMBER_FORMAT.format(used)}
                </span>
                <span className="text-muted-foreground/70">
                  /{NUMBER_FORMAT.format(total)}
                </span>
              </>
            )}
            {unit && (
              <span className="text-muted-foreground/70">{unit}</span>
            )}
            <span className="ml-1 text-muted-foreground/70">
              ({pct.toFixed(0)}%)
            </span>
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={used}
        aria-label={
          ariaLabel ??
          (typeof label === "string"
            ? `${label}: ${used} of ${total}`
            : `${used} of ${total}`)
        }
        className={cn(
          "relative w-full overflow-hidden rounded-full bg-muted",
          SIZE_BAR[size],
        )}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-base ease-standard motion-reduce:transition-none",
            TONE_FILL[effectiveTone],
          )}
          style={{ width: `${pct.toFixed(2)}%` }}
        />
      </div>
    </div>
  );
};

/**
 * MiniBar — frequency bar chart for low-cardinality categories. Used for
 * "VM sizes in use", "actions per hour", etc. Pure CSS bars (no SVG).
 *
 * Each bar's width is proportional to the category's value, with a numeric
 * label on the right. Categories are rendered in input order; sort
 * upstream if you want a different ordering.
 */
export interface MiniBarItem {
  /** Category label. */
  label: string;
  /** Numeric value (>= 0). */
  value: number;
  /** Optional tone override; defaults to "primary". */
  tone?: GaugeTone;
}

export interface MiniBarProps {
  items: MiniBarItem[];
  /** Maximum bars to render. Excess collapses to a "+N more" footer. */
  maxItems?: number;
  /** Optional total override (defaults to max value). */
  scaleTo?: number;
  /** Optional aria-label for the chart. */
  ariaLabel?: string;
  className?: string;
}

export const MiniBar: React.FC<MiniBarProps> = ({
  items,
  maxItems = 10,
  scaleTo,
  ariaLabel,
  className,
}) => {
  if (items.length === 0) return null;
  const visible = items.slice(0, maxItems);
  const overflow = items.length - visible.length;
  const max = scaleTo ?? Math.max(...visible.map((i) => i.value), 1);

  return (
    <ul
      role="list"
      aria-label={ariaLabel}
      className={cn("flex flex-col gap-1.5", className)}
    >
      {visible.map((item) => {
        const pct = max > 0 ? Math.min(100, (item.value / max) * 100) : 0;
        const effectiveTone: GaugeTone = item.tone ?? "primary";
        return (
          <li
            key={item.label}
            className="flex items-center gap-2 text-2xs"
          >
            <span
              className="w-24 shrink-0 truncate font-mono text-foreground/80"
              title={item.label}
            >
              {item.label}
            </span>
            <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn(
                  "block h-full rounded-full transition-all duration-base ease-standard motion-reduce:transition-none",
                  TONE_FILL[effectiveTone],
                )}
                style={{ width: `${pct.toFixed(2)}%` }}
              />
            </span>
            <span className="w-12 shrink-0 text-right font-medium tabular-nums text-foreground">
              {NUMBER_FORMAT.format(item.value)}
            </span>
          </li>
        );
      })}
      {overflow > 0 && (
        <li className="text-2xs text-muted-foreground">
          + {overflow} more
        </li>
      )}
    </ul>
  );
};
