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
export declare const InfoTooltip: React.FC<InfoTooltipProps>;
//# sourceMappingURL=info-tooltip.d.ts.map