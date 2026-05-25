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

interface PillRect {
  left: number;
  width: number;
}

const ZERO_RECT: PillRect = { left: 0, width: 0 };

export const AnimatedTabs: React.FC<AnimatedTabsProps> = ({
  tabs,
  value,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const tabRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  const [pill, setPill] = React.useState<PillRect>(ZERO_RECT);

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
    if (typeof window === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure]);

  const sizeCls =
    size === "sm" ? "h-8 text-xs gap-0.5 p-0.5" : "h-10 text-sm gap-1 p-1";
  const padCls = size === "sm" ? "px-2.5" : "px-3.5";

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex items-center rounded-full border border-border bg-card/60 backdrop-blur-sm",
        sizeCls,
        className,
      )}
    >
      {/*
        Sliding pill behind the active tab. Position + width are state-
        driven so the pill smoothly transitions between tabs of different
        widths. Subtle gradient + glow so it reads as the personality
        accent without overwhelming the labels.
      */}
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-y-1 rounded-full",
          "transition-[left,width] duration-300 ease-out motion-reduce:transition-none",
          "bg-gradient-to-r from-primary/25 via-accent/20 to-primary/25",
          "shadow-[0_0_0_1px_hsl(var(--primary)/0.4),0_4px_12px_-2px_hsl(var(--primary)/0.4)]",
        )}
        style={{
          left: pill.left,
          width: pill.width,
          opacity: pill.width > 0 ? 1 : 0,
        }}
      />
      {tabs.map((t) => {
        const isActive = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) tabRefs.current.set(t.id, el);
              else tabRefs.current.delete(t.id);
            }}
            role="tab"
            aria-selected={isActive}
            aria-controls={`panel-${t.id}`}
            disabled={t.disabled}
            onClick={() => !t.disabled && onChange(t.id)}
            className={cn(
              "relative z-10 inline-flex items-center gap-1.5 rounded-full font-medium transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              padCls,
              isActive
                ? "text-foreground"
                : t.disabled
                  ? "cursor-not-allowed text-muted-foreground/50"
                  : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{t.label}</span>
            {t.badge != null && t.badge > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
                  isActive
                    ? "bg-primary/30 text-foreground"
                    : "bg-muted/50 text-muted-foreground",
                )}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
