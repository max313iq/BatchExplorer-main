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
export declare function HoverList<T>({ items, getKey, renderItem, tone, onItemClick, role, className, itemClassName, }: HoverListProps<T>): React.ReactElement;
//# sourceMappingURL=hover-list.d.ts.map