import * as React from "react";
import type { LucideIcon } from "lucide-react";
/**
 * Stable contract per Design Contract §3.3:
 *   - `icon` — Lucide icon component to display above the title.
 *   - `title` — required headline.
 *   - `description` — optional supporting text.
 *   - `action` — optional primary CTA: `{ label, onClick, icon?, loading? }`.
 *   - `size` — optional density ("default" | "compact") for in-card / in-cell
 *     contexts where the standard padding feels too generous.
 *   - `className` — escape hatch for layout overrides.
 *
 * Other agents' pages also depend on this shape; do not remove or rename
 * existing fields without coordinating across the page roster.
 */
export interface EmptyStateProps {
    icon: LucideIcon;
    title: string;
    description?: string;
    action?: {
        label: string;
        onClick: () => void;
        icon?: LucideIcon;
        loading?: boolean;
    };
    /** Density variant; defaults to `"default"`. */
    size?: "default" | "compact";
    className?: string;
}
export declare const EmptyState: React.FC<EmptyStateProps>;
//# sourceMappingURL=empty-state.d.ts.map