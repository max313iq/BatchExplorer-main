import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  size = "default",
  className,
}) => {
  const ActionIcon = action?.icon;
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-card text-center transition-colors duration-200 ease-out",
        size === "default" ? "px-6 py-10" : "px-4 py-5",
        className,
      )}
    >
      <Icon
        className={cn(
          "text-muted-foreground/70",
          size === "default" ? "h-6 w-6" : "h-4 w-4",
        )}
        aria-hidden
      />
      <p
        className={cn(
          "font-semibold text-foreground",
          size === "default" ? "text-sm" : "text-xs",
        )}
      >
        {title}
      </p>
      {description && (
        <p
          className={cn(
            "max-w-md text-muted-foreground",
            size === "default" ? "text-xs" : "text-2xs",
          )}
        >
          {description}
        </p>
      )}
      {action && (
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={action.onClick}
          disabled={action.loading}
          aria-label={action.label}
          className="mt-1"
        >
          {ActionIcon && <ActionIcon className="h-3.5 w-3.5" aria-hidden />}
          {action.label}
        </Button>
      )}
    </div>
  );
};
