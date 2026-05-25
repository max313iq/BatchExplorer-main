/**
 * ErrorState primitive — Contract §3.3 mandates this for in-place error
 * surfaces (failed data fetch, failed mutation, etc.). Pairs with the
 * `<EmptyState>` and `<SkeletonLoader>` triad of region states.
 */
import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface ErrorStateProps {
  /** Headline message. Should describe what failed in user-facing terms. */
  message: string;
  /** Optional technical detail. Shown below the message in muted text. */
  detail?: string | null;
  /**
   * Tone — defaults to `destructive`. Use `warning` for partial failures
   * (e.g. degraded health rather than outright failure).
   */
  tone?: "destructive" | "warning";
  /** Optional retry handler. If supplied, a retry button is rendered. */
  onRetry?: () => void;
  /** Optional retry button label. Default: "Retry". */
  retryLabel?: string;
  /** Optional disabled state for the retry button. */
  retryDisabled?: boolean;
  /** Optional override icon. Default: AlertTriangle. */
  icon?: LucideIcon;
  /** Optional secondary action (e.g. "Open docs"). Rendered inline. */
  action?: React.ReactNode;
  /** Optional density for compact contexts (in-card, in-cell). */
  size?: "default" | "compact";
  className?: string;
}

const TONE_TO_CLASSES: Record<
  NonNullable<ErrorStateProps["tone"]>,
  { bg: string; text: string; border: string }
> = {
  destructive: {
    bg: "bg-destructive/10",
    text: "text-destructive",
    border: "border-destructive/40",
  },
  warning: {
    bg: "bg-warning/10",
    text: "text-warning",
    border: "border-warning/40",
  },
};

const ErrorState = React.forwardRef<HTMLDivElement, ErrorStateProps>(
  (
    {
      message,
      detail,
      tone = "destructive",
      onRetry,
      retryLabel = "Retry",
      retryDisabled,
      icon: IconComp = AlertTriangle,
      action,
      size = "default",
      className,
    },
    ref,
  ) => {
    const classes = TONE_TO_CLASSES[tone];
    return (
      <div
        ref={ref}
        role="alert"
        aria-live="assertive"
        className={cn(
          "flex flex-col items-center gap-3 rounded-md border text-center",
          classes.bg,
          classes.border,
          size === "default" ? "px-6 py-8" : "px-4 py-4",
          className,
        )}
      >
        <span
          className={cn(
            "flex items-center justify-center rounded-full bg-background/60",
            size === "default" ? "h-10 w-10" : "h-7 w-7",
          )}
        >
          <IconComp
            className={cn(
              classes.text,
              size === "default" ? "h-5 w-5" : "h-3.5 w-3.5",
            )}
            aria-hidden="true"
          />
        </span>
        <div className="flex flex-col gap-1">
          <p
            className={cn(
              "m-0 font-medium",
              classes.text,
              size === "default" ? "text-sm" : "text-xs",
            )}
          >
            {message}
          </p>
          {detail && (
            <p
              className={cn(
                "m-0 break-words text-muted-foreground",
                size === "default" ? "text-xs" : "text-2xs",
              )}
            >
              {detail}
            </p>
          )}
        </div>
        {(onRetry || action) && (
          <div className="flex flex-wrap items-center gap-2">
            {onRetry && (
              <Button
                variant="outline"
                size={size === "default" ? "sm" : "xs"}
                onClick={onRetry}
                disabled={retryDisabled}
                className="gap-1.5"
              >
                <RefreshCw
                  className={cn(
                    size === "default" ? "h-3.5 w-3.5" : "h-3 w-3",
                  )}
                />
                {retryLabel}
              </Button>
            )}
            {action}
          </div>
        )}
      </div>
    );
  },
);
ErrorState.displayName = "ErrorState";

export { ErrorState };
