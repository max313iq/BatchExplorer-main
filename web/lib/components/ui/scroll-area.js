import { __rest } from "tslib";
/**
 * ScrollArea primitive — Radix ScrollArea wrapping. Used inside Sheet,
 * Popover, and DataTable bodies for consistent scrollbar styling across
 * platforms.
 */
import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";
const ScrollArea = React.forwardRef((_a, ref) => {
    var { className, children } = _a, props = __rest(_a, ["className", "children"]);
    return (React.createElement(ScrollAreaPrimitive.Root, Object.assign({ ref: ref, className: cn("relative overflow-hidden", className) }, props),
        React.createElement(ScrollAreaPrimitive.Viewport, { className: "h-full w-full rounded-[inherit]" }, children),
        React.createElement(ScrollBar, null),
        React.createElement(ScrollAreaPrimitive.Corner, null)));
});
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;
const ScrollBar = React.forwardRef((_a, ref) => {
    var { className, orientation = "vertical" } = _a, props = __rest(_a, ["className", "orientation"]);
    return (React.createElement(ScrollAreaPrimitive.ScrollAreaScrollbar, Object.assign({ ref: ref, orientation: orientation, className: cn("flex touch-none select-none transition-colors duration-fast", orientation === "vertical" &&
            "h-full w-2.5 border-l border-l-transparent p-px", orientation === "horizontal" &&
            "h-2.5 flex-col border-t border-t-transparent p-px", className) }, props),
        React.createElement(ScrollAreaPrimitive.ScrollAreaThumb, { className: "relative flex-1 rounded-full bg-border hover:bg-muted-foreground/40" })));
});
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;
export { ScrollArea, ScrollBar };
//# sourceMappingURL=scroll-area.js.map