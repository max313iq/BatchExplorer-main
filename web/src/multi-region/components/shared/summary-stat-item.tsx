/**
 * Compact stat card used in summary rows above list tables.
 *
 * Extracted from the `nodes-page` local `StatCard` so other list pages
 * (audit log, tasks, accounts, EA subs, etc.) can opt into the same
 * "label + big number + tone-driven glow" treatment without copying the
 * Tailwind classes around.
 *
 * Compose multiple items inside a flex row:
 *   <div className="flex flex-wrap gap-2" role="group" aria-label="Summary">
 *     <SummaryStatItem label="Total" value={n} />
 *     <SummaryStatItem label="Errors" value={n} tone="destructive" />
 *   </div>
 *
 * For dense lists where the BorderBeam glow is too much (small modal
 * popovers, side panels), pass `compact` — it drops the animated bar and
 * tightens the padding.
 */
import * as React from "react";

import { cn, formatNumber } from "@/lib/utils";

export type SummaryStatTone =
  | "info"
  | "destructive"
  | "success"
  | "warning"
  | "muted";

export interface SummaryStatItemProps {
  /** Short uppercase label rendered above the value. */
  label: React.ReactNode;
  /**
   * Numeric value rendered with locale grouping. Pass NaN/Infinity to
   * show an em-dash placeholder. Strings are rendered as-is.
   */
  value: number | string;
  /** Optional sub-label shown below the value (e.g. "running", "of 32"). */
  hint?: React.ReactNode;
  /** Color tone for the label + value text. Defaults to neutral. */
  tone?: SummaryStatTone;
  /** Reduce visual weight (no glow bar, tighter padding). */
  compact?: boolean;
  /** Optional click handler — turns the card into a button. */
  onClick?: () => void;
  /** Optional aria-label override (defaults to `${label} ${value}`). */
  ariaLabel?: string;
  /** Optional className applied to the outer card. */
  className?: string;
}

const STAT_TONE_CLASS: Record<
  Exclude<SummaryStatTone, "muted">,
  { value: string; label: string; live: string }
> = {
  info: {
    value: "text-info",
    label: "text-info",
    live: "var(--info, var(--primary))",
  },
  destructive: {
    value: "text-destructive",
    label: "text-destructive",
    live: "var(--destructive)",
  },
  success: {
    value: "text-success",
    label: "text-success",
    live: "var(--success)",
  },
  warning: {
    value: "text-warning",
    label: "text-warning",
    live: "var(--warning)",
  },
};

/**
 * Single stat card. Compose multiple inside a flex container above your
 * list table for at-a-glance counts.
 */
export const SummaryStatItem: React.FC<SummaryStatItemProps> = ({
  label,
  value,
  hint,
  tone,
  compact = false,
  onClick,
  ariaLabel,
  className,
}) => {
  // Resolve the displayed value. Numbers get locale grouping; non-finite
  // numbers fall back to the em-dash placeholder so we don't print "NaN".
  const displayValue =
    typeof value === "number"
      ? Number.isFinite(value)
        ? formatNumber(value)
        : "—"
      : value;

  const isZero = typeof value === "number" && value === 0;
  const isActive = !isZero && tone !== "muted";
  const toneClasses =
    tone && tone !== "muted" ? STAT_TONE_CLASS[tone] : null;
  const liveTone = toneClasses?.live ?? "var(--primary)";

  const Wrapper: React.ElementType = onClick ? "button" : "div";
  const wrapperProps = onClick
    ? { type: "button" as const, onClick }
    : undefined;
  const computedAriaLabel =
    ariaLabel ??
    (typeof label === "string" ? `${label} ${displayValue}` : undefined);

  return (
    <Wrapper
      {...wrapperProps}
      aria-label={computedAriaLabel}
      className={cn(
        "group relative flex flex-col items-center gap-1 rounded-lg border bg-card/70 text-center backdrop-blur-sm transition-all duration-200 ease-out",
        compact ? "min-w-[88px] px-3 py-2" : "min-w-[110px] px-4 py-3",
        onClick &&
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "hover:-translate-y-px hover:border-primary/40 hover:shadow-elev-1",
        isActive && !compact ? "border-primary/30 live-glow-bar" : "border-border",
        className,
      )}
      style={
        isActive && !compact
          ? ({ ["--live-tone" as never]: liveTone } as React.CSSProperties)
          : undefined
      }
    >
      <span
        className={cn(
          "inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground",
          toneClasses?.label,
        )}
      >
        {isActive && (
          <span
            className="live-pulse-dot"
            style={{ ["--live-tone" as never]: liveTone } as React.CSSProperties}
            aria-hidden
          />
        )}
        {label}
      </span>
      <span
        className={cn(
          "text-xl font-bold tabular-nums text-foreground",
          compact && "text-lg",
          toneClasses?.value,
        )}
      >
        {displayValue}
      </span>
      {hint && (
        <span className="text-3xs leading-tight text-muted-foreground">
          {hint}
        </span>
      )}
    </Wrapper>
  );
};
