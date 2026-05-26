import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
export const EmptyState = ({ icon: Icon, title, description, action, size = "default", className, }) => {
    const ActionIcon = action === null || action === void 0 ? void 0 : action.icon;
    return (React.createElement("div", { role: "status", className: cn("flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-card text-center transition-colors duration-200 ease-out", size === "default" ? "px-6 py-10" : "px-4 py-5", className) },
        React.createElement(Icon, { className: cn("text-muted-foreground/70", size === "default" ? "h-6 w-6" : "h-4 w-4"), "aria-hidden": true }),
        React.createElement("p", { className: cn("font-semibold text-foreground", size === "default" ? "text-sm" : "text-xs") }, title),
        description && (React.createElement("p", { className: cn("max-w-md text-muted-foreground", size === "default" ? "text-xs" : "text-2xs") }, description)),
        action && (React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: action.onClick, disabled: action.loading, "aria-label": action.label, className: "mt-1" },
            ActionIcon && React.createElement(ActionIcon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
            action.label))));
};
//# sourceMappingURL=empty-state.js.map