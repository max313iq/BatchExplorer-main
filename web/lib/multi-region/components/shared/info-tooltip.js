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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
/**
 * `<InfoTooltip content="..." />` — a single icon button that opens a
 * small tooltip with help text. Designed to be inline-friendly so it can
 * sit right next to a label or column header without disrupting baseline
 * alignment.
 */
export const InfoTooltip = ({ content, ariaLabel = "More information", variant = "info", className, size = 14, side = "top", align = "center", style, withProvider = true, }) => {
    const Icon = variant === "help" ? HelpCircle : Info;
    const trigger = (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true },
            React.createElement("button", { type: "button", tabIndex: -1, "aria-label": ariaLabel, className: cn("inline-flex shrink-0 items-center justify-center align-middle text-muted-foreground/70 transition-colors duration-150 ease-out hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded motion-reduce:transition-none", className), style: style },
                React.createElement(Icon, { style: { width: size, height: size }, "aria-hidden": true }))),
        React.createElement(TooltipContent, { side: side, align: align, className: "max-w-xs" }, typeof content === "string" ? (React.createElement("p", { className: "m-0 text-xs leading-relaxed" }, content)) : (content))));
    if (!withProvider)
        return trigger;
    return React.createElement(TooltipProvider, { delayDuration: 150 }, trigger);
};
//# sourceMappingURL=info-tooltip.js.map