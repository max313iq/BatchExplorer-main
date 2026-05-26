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

export interface HoverListProps<T> {
  items: T[];
  getKey: (item: T, idx: number) => string | number;
  renderItem: (item: T, isHovered: boolean, idx: number) => React.ReactNode;
  /** Tone of the hover gradient. Defaults to primary→accent. */
  tone?: "primary" | "success" | "warning" | "destructive";
  /** Wrap each item in a button for keyboard activation. */
  onItemClick?: (item: T, idx: number) => void;
  /** ARIA role for the list element. Default `list`. */
  role?: React.AriaRole;
  className?: string;
  itemClassName?: string;
}

const TONE_GRADIENT: Record<NonNullable<HoverListProps<unknown>["tone"]>, string> = {
  primary:
    "from-primary/12 via-accent/8 to-primary/12",
  success: "from-success/12 via-success/6 to-success/12",
  warning: "from-warning/12 via-warning/6 to-warning/12",
  destructive:
    "from-destructive/12 via-destructive/6 to-destructive/12",
};

export function HoverList<T>({
  items,
  getKey,
  renderItem,
  tone = "primary",
  onItemClick,
  role = "list",
  className,
  itemClassName,
}: HoverListProps<T>): React.ReactElement {
  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);

  return (
    <div role={role} className={cn("flex flex-col gap-1", className)}>
      {items.map((item, idx) => {
        const isHovered = hoveredIdx === idx;
        const commonProps = {
          onMouseEnter: () => setHoveredIdx(idx),
          onMouseLeave: () =>
            setHoveredIdx((cur) => (cur === idx ? null : cur)),
          onFocus: () => setHoveredIdx(idx),
          onBlur: () =>
            setHoveredIdx((cur) => (cur === idx ? null : cur)),
          className: cn(
            "group relative rounded-md p-2 text-left transition-colors duration-200 ease-out motion-reduce:transition-none",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            itemClassName,
          ),
        } as const;

        // Hover overlay — bottom layer with gradient + ring. Visibility
        // animates via opacity/transform so the row reads as "lit up"
        // without nudging neighbors.
        const overlay = (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 rounded-md",
              "bg-gradient-to-r",
              TONE_GRADIENT[tone],
              "opacity-0 transition-opacity duration-200 ease-out motion-reduce:transition-none",
              isHovered && "opacity-100",
            )}
          />
        );

        // Subtle gradient border that fades in alongside the hover.
        const border = (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 rounded-md",
              "ring-1 ring-inset ring-primary/0 transition-shadow duration-200 ease-out motion-reduce:transition-none",
              isHovered && "ring-primary/40",
            )}
          />
        );

        const content = (
          <span className="relative z-10 block">
            {renderItem(item, isHovered, idx)}
          </span>
        );

        if (onItemClick) {
          return (
            <button
              key={getKey(item, idx)}
              type="button"
              onClick={() => onItemClick(item, idx)}
              {...commonProps}
            >
              {overlay}
              {border}
              {content}
            </button>
          );
        }
        return (
          <div key={getKey(item, idx)} role="listitem" {...commonProps}>
            {overlay}
            {border}
            {content}
          </div>
        );
      })}
    </div>
  );
}
