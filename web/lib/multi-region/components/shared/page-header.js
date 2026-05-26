import * as React from "react";
import { cn } from "@/lib/utils";
/**
 * Standard page header for the 12 dashboard pages. Establishes the same
 * h1 size, weight, and tracking everywhere so navigating between pages
 * does not feel jumpy.
 */
export const PageHeader = ({ title, description, titleId, children, className, }) => {
    return (React.createElement("header", { className: cn("flex flex-wrap items-end justify-between gap-3", className) },
        React.createElement("div", { className: "flex min-w-0 flex-col gap-1" },
            React.createElement("h1", { id: titleId, className: cn(
                // Display heading: large, tight, with the cyan→violet gradient
                // text effect. Falls back to solid foreground if the user's
                // browser dropped background-clip support (rare).
                "m-0 text-2xl font-bold tracking-tight gradient-text-primary", 
                // Static fallback color (browsers without background-clip
                // support render this; modern Chromium/WebKit/Firefox use the
                // gradient via the utility class above).
                "text-foreground") }, title),
            description && (React.createElement("p", { className: "m-0 max-w-prose text-xs leading-relaxed text-muted-foreground" }, description))),
        children && (React.createElement("div", { className: "flex flex-wrap items-center gap-2" }, children))));
};
//# sourceMappingURL=page-header.js.map