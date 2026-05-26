import { __rest } from "tslib";
import * as React from "react";
import { cn } from "@/lib/utils";
const Separator = React.forwardRef((_a, ref) => {
    var { className, orientation = "horizontal", decorative = true } = _a, props = __rest(_a, ["className", "orientation", "decorative"]);
    return (React.createElement("div", Object.assign({ ref: ref, role: decorative ? "none" : "separator", "aria-orientation": decorative ? undefined : orientation, className: cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className) }, props)));
});
Separator.displayName = "Separator";
export { Separator };
//# sourceMappingURL=separator.js.map