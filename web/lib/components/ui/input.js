import { __rest } from "tslib";
import * as React from "react";
import { cn } from "@/lib/utils";
const Input = React.forwardRef((_a, ref) => {
    var { className, type } = _a, props = __rest(_a, ["className", "type"]);
    return (React.createElement("input", Object.assign({ type: type, className: cn("flex h-9 w-full rounded-md border border-input bg-surface-sunken px-3 py-1 text-sm text-foreground shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50", className), ref: ref }, props)));
});
Input.displayName = "Input";
export { Input };
//# sourceMappingURL=input.js.map