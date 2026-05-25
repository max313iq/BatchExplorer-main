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

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FilterChipOption {
  key: string;
  label: string;
  /** Optional tone — drives the active-state colour. */
  tone?: "default" | "destructive" | "warning" | "success" | "info";
  /** Optional icon shown to the left of the label. */
  icon?: React.ComponentType<{ className?: string }>;
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

const TONE_ACTIVE_CLASS: Record<
  NonNullable<FilterChipOption["tone"]>,
  string
> = {
  default: "bg-primary text-primary-foreground",
  destructive: "bg-destructive text-destructive-foreground",
  warning: "bg-warning text-warning-foreground",
  success: "bg-success text-success-foreground",
  info: "bg-info text-info-foreground",
};

const TONE_IDLE_CLASS: Record<
  NonNullable<FilterChipOption["tone"]>,
  string
> = {
  default: "text-foreground hover:bg-muted",
  destructive: "text-destructive hover:bg-destructive/10",
  warning: "text-warning hover:bg-warning/10",
  success: "text-success hover:bg-success/10",
  info: "text-info hover:bg-info/10",
};

export const FilterChipRow: React.FC<FilterChipRowProps> = ({
  label,
  value,
  options,
  onChange,
  counts,
  showAll = true,
  className,
}) => {
  const handleToggle = React.useCallback(
    (key: string) => {
      const next = new Set(value);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onChange(next);
    },
    [value, onChange],
  );

  const handleClear = React.useCallback(() => {
    onChange(new Set());
  }, [onChange]);

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {showAll && (
        <Button
          type="button"
          variant={value.size === 0 ? "default" : "outline"}
          size="sm"
          onClick={handleClear}
          aria-pressed={value.size === 0}
          className="h-6 px-2 text-2xs"
        >
          All
        </Button>
      )}
      {options.map((opt) => {
        const active = value.has(opt.key);
        const tone = opt.tone ?? "default";
        const Icon = opt.icon;
        const count = counts?.[opt.key];
        return (
          <Button
            key={opt.key}
            type="button"
            variant={active ? "default" : "outline"}
            size="sm"
            onClick={() => handleToggle(opt.key)}
            aria-pressed={active}
            className={cn(
              "h-6 gap-1 px-2 text-2xs",
              active ? TONE_ACTIVE_CLASS[tone] : TONE_IDLE_CLASS[tone],
            )}
          >
            {Icon && <Icon className="h-3 w-3" aria-hidden />}
            <span>{opt.label}</span>
            {count !== undefined && (
              <span
                className={cn(
                  "ml-0.5 rounded-full px-1 text-2xs tabular-nums",
                  active ? "bg-background/20" : "bg-muted",
                )}
                aria-label={`${count} match${count === 1 ? "" : "es"}`}
              >
                {count}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
};
