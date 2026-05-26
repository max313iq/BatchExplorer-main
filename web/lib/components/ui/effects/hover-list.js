/**
 * HoverList — list with a soft gradient highlight that slides between
 * rows on hover (Aceternity card-hover-effect pattern, ported to pure
 * CSS-Tailwind so the project doesn't need framer-motion).
 *
 * Usage (controlled list):
 *
 *   <HoverList
 *     items={rows}
 *     getKey={(r) => r.id}
 *     renderItem={(r, isHovered) => (
 *       <div className="...">{r.label}</div>
 *     )}
 *   />
 *
 * The highlight layer rides on a per-item span, so each row owns its
 * own hover state — no shared sliding indicator needed (which would
 * require measuring rects and is overkill for a long list). Honors
 * prefers-reduced-motion via Tailwind's `motion-reduce:` modifiers.
 *
 * Reference: https://ui.aceternity.com/components/card-hover-effect
 */
import * as React from "react";
import { cn } from "@/lib/utils";
const TONE_GRADIENT = {
    primary: "from-primary/12 via-accent/8 to-primary/12",
    success: "from-success/12 via-success/6 to-success/12",
    warning: "from-warning/12 via-warning/6 to-warning/12",
    destructive: "from-destructive/12 via-destructive/6 to-destructive/12",
};
export function HoverList({ items, getKey, renderItem, tone = "primary", onItemClick, role = "list", className, itemClassName, }) {
    const [hoveredIdx, setHoveredIdx] = React.useState(null);
    return (React.createElement("div", { role: role, className: cn("flex flex-col gap-1", className) }, items.map((item, idx) => {
        const isHovered = hoveredIdx === idx;
        const commonProps = {
            onMouseEnter: () => setHoveredIdx(idx),
            onMouseLeave: () => setHoveredIdx((cur) => (cur === idx ? null : cur)),
            onFocus: () => setHoveredIdx(idx),
            onBlur: () => setHoveredIdx((cur) => (cur === idx ? null : cur)),
            className: cn("group relative rounded-md p-2 text-left transition-colors duration-200 ease-out motion-reduce:transition-none", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background", itemClassName),
        };
        // Hover overlay — bottom layer with gradient + ring. Visibility
        // animates via opacity/transform so the row reads as "lit up"
        // without nudging neighbors.
        const overlay = (React.createElement("span", { "aria-hidden": "true", className: cn("pointer-events-none absolute inset-0 rounded-md", "bg-gradient-to-r", TONE_GRADIENT[tone], "opacity-0 transition-opacity duration-200 ease-out motion-reduce:transition-none", isHovered && "opacity-100") }));
        // Subtle gradient border that fades in alongside the hover.
        const border = (React.createElement("span", { "aria-hidden": "true", className: cn("pointer-events-none absolute inset-0 rounded-md", "ring-1 ring-inset ring-primary/0 transition-shadow duration-200 ease-out motion-reduce:transition-none", isHovered && "ring-primary/40") }));
        const content = (React.createElement("span", { className: "relative z-10 block" }, renderItem(item, isHovered, idx)));
        if (onItemClick) {
            return (React.createElement("button", Object.assign({ key: getKey(item, idx), type: "button", onClick: () => onItemClick(item, idx) }, commonProps),
                overlay,
                border,
                content));
        }
        return (React.createElement("div", Object.assign({ key: getKey(item, idx), role: "listitem" }, commonProps),
            overlay,
            border,
            content));
    })));
}
//# sourceMappingURL=hover-list.js.map