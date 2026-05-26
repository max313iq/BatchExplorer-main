import { __rest } from "tslib";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
const badgeVariants = cva("inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background", {
    variants: {
        variant: {
            default: "border-transparent bg-primary/15 text-primary",
            secondary: "border-transparent bg-secondary text-secondary-foreground",
            destructive: "border-transparent bg-destructive/15 text-destructive",
            success: "border-transparent bg-success/15 text-success",
            warning: "border-transparent bg-warning/15 text-warning",
            info: "border-transparent bg-info/15 text-info",
            outline: "text-foreground",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});
function Badge(_a) {
    var { className, variant } = _a, props = __rest(_a, ["className", "variant"]);
    return (React.createElement("span", Object.assign({ className: cn(badgeVariants({ variant }), className) }, props)));
}
export { Badge, badgeVariants };
//# sourceMappingURL=badge.js.map