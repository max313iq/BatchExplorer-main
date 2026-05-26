/**
 * ErrorState primitive — Contract §3.3 mandates this for in-place error
 * surfaces (failed data fetch, failed mutation, etc.). Pairs with the
 * `<EmptyState>` and `<SkeletonLoader>` triad of region states.
 */
import * as React from "react";
import type { LucideIcon } from "lucide-react";
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
declare const ErrorState: React.ForwardRefExoticComponent<ErrorStateProps & React.RefAttributes<HTMLDivElement>>;
export { ErrorState };
//# sourceMappingURL=error-state.d.ts.map