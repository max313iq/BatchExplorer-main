/**
 * ErrorState primitive — Contract §3.3 mandates this for in-place error
 * surfaces (failed data fetch, failed mutation, etc.). Pairs with the
 * `<EmptyState>` and `<SkeletonLoader>` triad of region states.
 */
import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
const TONE_TO_CLASSES = {
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
const ErrorState = React.forwardRef(({ message, detail, tone = "destructive", onRetry, retryLabel = "Retry", retryDisabled, icon: IconComp = AlertTriangle, action, size = "default", className, }, ref) => {
    const classes = TONE_TO_CLASSES[tone];
    return (React.createElement("div", { ref: ref, role: "alert", "aria-live": "assertive", className: cn("flex flex-col items-center gap-3 rounded-md border text-center", classes.bg, classes.border, size === "default" ? "px-6 py-8" : "px-4 py-4", className) },
        React.createElement("span", { className: cn("flex items-center justify-center rounded-full bg-background/60", size === "default" ? "h-10 w-10" : "h-7 w-7") },
            React.createElement(IconComp, { className: cn(classes.text, size === "default" ? "h-5 w-5" : "h-3.5 w-3.5"), "aria-hidden": "true" })),
        React.createElement("div", { className: "flex flex-col gap-1" },
            React.createElement("p", { className: cn("m-0 font-medium", classes.text, size === "default" ? "text-sm" : "text-xs") }, message),
            detail && (React.createElement("p", { className: cn("m-0 break-words text-muted-foreground", size === "default" ? "text-xs" : "text-2xs") }, detail))),
        (onRetry || action) && (React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            onRetry && (React.createElement(Button, { variant: "outline", size: size === "default" ? "sm" : "xs", onClick: onRetry, disabled: retryDisabled, className: "gap-1.5" },
                React.createElement(RefreshCw, { className: cn(size === "default" ? "h-3.5 w-3.5" : "h-3 w-3") }),
                retryLabel)),
            action))));
});
ErrorState.displayName = "ErrorState";
export { ErrorState };
//# sourceMappingURL=error-state.js.map