/**
 * Compact stat card used in summary rows above list tables.
 *
 * Extracted from the `nodes-page` local `StatCard` so other list pages
 * (audit log, tasks, accounts, EA subs, etc.) can opt into the same
 * "label + big number + tone-driven glow" treatment without copying the
 * Tailwind classes around.
 *
 * Compose multiple items inside a flex row:
 *   <div className="flex flex-wrap gap-2" role="group" aria-label="Summary">
 *     <SummaryStatItem label="Total" value={n} />
 *     <SummaryStatItem label="Errors" value={n} tone="destructive" />
 *   </div>
 *
 * For dense lists where the BorderBeam glow is too much (small modal
 * popovers, side panels), pass `compact` — it drops the animated bar and
 * tightens the padding.
 */
import * as React from "react";
export type SummaryStatTone = "info" | "destructive" | "success" | "warning" | "muted";
export interface SummaryStatItemProps {
    /** Short uppercase label rendered above the value. */
    label: React.ReactNode;
    /**
     * Numeric value rendered with locale grouping. Pass NaN/Infinity to
     * show an em-dash placeholder. Strings are rendered as-is.
     */
    value: number | string;
    /** Optional sub-label shown below the value (e.g. "running", "of 32"). */
    hint?: React.ReactNode;
    /** Color tone for the label + value text. Defaults to neutral. */
    tone?: SummaryStatTone;
    /** Reduce visual weight (no glow bar, tighter padding). */
    compact?: boolean;
    /** Optional click handler — turns the card into a button. */
    onClick?: () => void;
    /** Optional aria-label override (defaults to `${label} ${value}`). */
    ariaLabel?: string;
    /** Optional className applied to the outer card. */
    className?: string;
}
/**
 * Single stat card. Compose multiple inside a flex container above your
 * list table for at-a-glance counts.
 */
export declare const SummaryStatItem: React.FC<SummaryStatItemProps>;
//# sourceMappingURL=summary-stat-item.d.ts.map