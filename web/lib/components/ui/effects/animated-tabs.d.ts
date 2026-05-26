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
export interface AnimatedTab {
    id: string;
    label: React.ReactNode;
    /** Optional small numeric badge rendered after the label. */
    badge?: number;
    /** Disable selection of this tab. */
    disabled?: boolean;
}
export interface AnimatedTabsProps {
    tabs: AnimatedTab[];
    value: string;
    onChange: (id: string) => void;
    /** Visual size. "sm" is dense; "md" is the default. */
    size?: "sm" | "md";
    /** Aria-label for the tablist. */
    "aria-label"?: string;
    className?: string;
}
export declare const AnimatedTabs: React.FC<AnimatedTabsProps>;
//# sourceMappingURL=animated-tabs.d.ts.map