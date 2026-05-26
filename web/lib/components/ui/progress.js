import { __rest } from "tslib";
import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";
const Progress = React.forwardRef((_a, ref) => {
    var { className, value, indeterminate } = _a, props = __rest(_a, ["className", "value", "indeterminate"]);
    return (React.createElement(ProgressPrimitive.Root, Object.assign({ ref: ref, className: cn("relative h-1 w-full overflow-hidden rounded-full bg-muted", className) }, props),
        indeterminate ? (React.createElement("div", { className: "absolute inset-y-0 -left-1/3 w-1/3 rounded-full bg-primary", style: {
                animation: "progress-indeterminate 1.4s ease-in-out infinite",
            } })) : (React.createElement(ProgressPrimitive.Indicator, { className: "h-full w-full flex-1 bg-primary transition-transform", style: {
                transform: `translateX(-${100 - (value || 0)}%)`,
            } })),
        React.createElement("style", null, `
            @keyframes progress-indeterminate {
                0% { transform: translateX(0); }
                100% { transform: translateX(400%); }
            }
        `)));
});
Progress.displayName = ProgressPrimitive.Root.displayName;
export { Progress };
//# sourceMappingURL=progress.js.map