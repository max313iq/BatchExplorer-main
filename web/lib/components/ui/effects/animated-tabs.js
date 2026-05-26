/**
 * AnimatedTabs — tab strip with a soft gradient pill that slides between
 * active tabs. Pure CSS animation; tab widths are measured at mount and
 * on resize so labels of unequal length still align.
 *
 *   <AnimatedTabs
 *     tabs={[
 *       { id: "overview", label: "Overview" },
 *       { id: "details",  label: "Details" },
 *       { id: "logs",     label: "Logs", badge: 12 },
 *     ]}
 *     value={activeId}
 *     onChange={setActiveId}
 *   />
 *
 * The pill uses the project's `--gradient-primary-*` token stops so it
 * recolors when the theme changes. Honors `prefers-reduced-motion`
 * (the slide is replaced with an instant snap).
 *
 * Inspired by the Aceternity UI Animated Tabs pattern, ported to
 * pure-CSS so the project doesn't need framer-motion.
 *   https://ui.aceternity.com/components/tabs
 */
import * as React from "react";
import { cn } from "@/lib/utils";
const ZERO_RECT = { left: 0, width: 0 };
export const AnimatedTabs = ({ tabs, value, onChange, size = "md", className, "aria-label": ariaLabel, }) => {
    const containerRef = React.useRef(null);
    const tabRefs = React.useRef(new Map());
    const [pill, setPill] = React.useState(ZERO_RECT);
    // Measure the active tab's geometry relative to the container so the
    // pill's left/width tracks it. Re-measures on resize and on tab list
    // changes via a ResizeObserver.
    const measure = React.useCallback(() => {
        const container = containerRef.current;
        const target = tabRefs.current.get(value);
        if (!container || !target) {
            setPill(ZERO_RECT);
            return;
        }
        const cRect = container.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();
        setPill({
            left: tRect.left - cRect.left,
            width: tRect.width,
        });
    }, [value]);
    React.useLayoutEffect(() => {
        measure();
    }, [measure, tabs.length]);
    React.useEffect(() => {
        if (typeof window === "undefined")
            return;
        const ro = new ResizeObserver(() => measure());
        if (containerRef.current)
            ro.observe(containerRef.current);
        return () => ro.disconnect();
    }, [measure]);
    const sizeCls = size === "sm" ? "h-8 text-xs gap-0.5 p-0.5" : "h-10 text-sm gap-1 p-1";
    const padCls = size === "sm" ? "px-2.5" : "px-3.5";
    return (React.createElement("div", { ref: containerRef, role: "tablist", "aria-label": ariaLabel, className: cn("relative inline-flex items-center rounded-full border border-border bg-card/60 backdrop-blur-sm", sizeCls, className) },
        React.createElement("div", { "aria-hidden": "true", className: cn("absolute inset-y-1 rounded-full", "transition-[left,width] duration-300 ease-out motion-reduce:transition-none", "bg-gradient-to-r from-primary/25 via-accent/20 to-primary/25", "shadow-[0_0_0_1px_hsl(var(--primary)/0.4),0_4px_12px_-2px_hsl(var(--primary)/0.4)]"), style: {
                left: pill.left,
                width: pill.width,
                opacity: pill.width > 0 ? 1 : 0,
            } }),
        tabs.map((t) => {
            const isActive = t.id === value;
            return (React.createElement("button", { key: t.id, ref: (el) => {
                    if (el)
                        tabRefs.current.set(t.id, el);
                    else
                        tabRefs.current.delete(t.id);
                }, role: "tab", "aria-selected": isActive, "aria-controls": `panel-${t.id}`, disabled: t.disabled, onClick: () => !t.disabled && onChange(t.id), className: cn("relative z-10 inline-flex items-center gap-1.5 rounded-full font-medium transition-colors duration-200", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", padCls, isActive
                    ? "text-foreground"
                    : t.disabled
                        ? "cursor-not-allowed text-muted-foreground/50"
                        : "text-muted-foreground hover:text-foreground") },
                React.createElement("span", null, t.label),
                t.badge != null && t.badge > 0 && (React.createElement("span", { className: cn("rounded-full px-1.5 text-[10px] font-semibold tabular-nums", isActive
                        ? "bg-primary/30 text-foreground"
                        : "bg-muted/50 text-muted-foreground") }, t.badge))));
        })));
};
//# sourceMappingURL=animated-tabs.js.map