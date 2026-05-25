/**
 * Small info-icon affordance that exposes help text via a Radix Tooltip.
 *
 * Use next to form labels or column headers where the meaning isn't
 * obvious from the visible text — e.g. ARM resource IDs, scope strings,
 * AAD GUIDs, quota families. The icon is rendered with the same sizing
 * conventions as the rest of the shared components (12-16px, muted-foreground
 * tone), and the tooltip respects the global tooltip-provider already
 * mounted in `dashboard-shell.tsx`.
 *
 * The button is `type="button"` so it never accidentally submits a form
 * when placed inside one. It carries `tabIndex={-1}` so the surrounding
 * label/field stays the canonical focusable element; users still get the
 * tooltip on hover and via keyboard focus when explicitly tab-targeting it.
 */
import * as React from "react";
import { HelpCircle, Info } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface InfoTooltipProps {
  /** Tooltip content. May be a string or rich React node. */
  content: React.ReactNode;
  /** Optional aria-label for the trigger (falls back to "More information"). */
  ariaLabel?: string;
  /** Render `?` (help) instead of `i` (info). Defaults to info. */
  variant?: "info" | "help";
  /** Optional className on the button element. */
  className?: string;
  /** Size of the icon in pixels. Defaults to 14. */
  size?: number;
  /** Where the tooltip prefers to render relative to the trigger. */
  side?: "top" | "right" | "bottom" | "left";
  /**
   * Tooltip alignment to its trigger axis (Radix `align`). Defaults to
   * `"center"`. Use `"start"` to keep long copy from wrapping awkwardly when
   * the trigger sits at the right edge of a row.
   */
  align?: "start" | "center" | "end";
  /** Optional inline style on the button. */
  style?: React.CSSProperties;
  /** Wrap the trigger in its own TooltipProvider. Defaults to true. */
  withProvider?: boolean;
}

/**
 * `<InfoTooltip content="..." />` — a single icon button that opens a
 * small tooltip with help text. Designed to be inline-friendly so it can
 * sit right next to a label or column header without disrupting baseline
 * alignment.
 */
export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  content,
  ariaLabel = "More information",
  variant = "info",
  className,
  size = 14,
  side = "top",
  align = "center",
  style,
  withProvider = true,
}) => {
  const Icon = variant === "help" ? HelpCircle : Info;
  const trigger = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={ariaLabel}
          className={cn(
            "inline-flex shrink-0 items-center justify-center align-middle text-muted-foreground/70 transition-colors duration-150 ease-out hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded motion-reduce:transition-none",
            className,
          )}
          style={style}
        >
          <Icon
            style={{ width: size, height: size }}
            aria-hidden
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} align={align} className="max-w-xs">
        {typeof content === "string" ? (
          <p className="m-0 text-xs leading-relaxed">{content}</p>
        ) : (
          content
        )}
      </TooltipContent>
    </Tooltip>
  );
  if (!withProvider) return trigger;
  return <TooltipProvider delayDuration={150}>{trigger}</TooltipProvider>;
};
