/**
 * `<FilterChipRow>` — shared "toggle a set of categories on/off" widget.
 *
 * Used inline in: overview (region status filter), sub-manager (role-type
 * filter), role-graph (escalation-level filter), security-audit (severity
 * filter), audit-log (level filter), audience-matrix (audience filter).
 * Each page had its own ~30-line inline chip strip with subtly different
 * affordances — chevron, count badge, all-or-none toggle behaviour. This
 * widget consolidates the canonical version.
 *
 * Semantics:
 *   - `value` is a Set<string>. Empty set means "no filter" (i.e. show
 *     all) — the widget renders a single highlighted "All" pill on the
 *     left so the operator can return to that state without un-clicking
 *     N chips.
 *   - Clicking an active chip removes it from the set; clicking an idle
 *     chip adds it. Clicking "All" clears the set.
 *   - Optional `counts` map adds a tabular-nums badge to each chip.
 *
 * Keyboard:
 *   - Each chip is a `<button>` so Enter / Space activate it natively.
 *   - Arrow keys are deliberately NOT bound — `Tab` between chips matches
 *     the rest of the toolbar widgets in the app (and Radix-friendly).
 */
import * as React from "react";
export interface FilterChipOption {
    key: string;
    label: string;
    /** Optional tone — drives the active-state colour. */
    tone?: "default" | "destructive" | "warning" | "success" | "info";
    /** Optional icon shown to the left of the label. */
    icon?: React.ElementType;
}
export interface FilterChipRowProps {
    /** Friendly label rendered before the chip strip (`aria-label`). */
    label: string;
    /** Selected chip keys. Empty = "All". */
    value: Set<string>;
    options: ReadonlyArray<FilterChipOption>;
    onChange: (next: Set<string>) => void;
    /**
     * Optional count per option (e.g. how many rows match each filter). When
     * supplied, renders a tabular-nums badge after each chip's label.
     */
    counts?: Record<string, number>;
    /** Render an "All" pill on the far left that clears the set. Default: true. */
    showAll?: boolean;
    /** Optional className applied to the strip's outer container. */
    className?: string;
}
export declare const FilterChipRow: React.FC<FilterChipRowProps>;
//# sourceMappingURL=filter-chip-row.d.ts.map