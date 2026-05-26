import { __rest } from "tslib";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
const alertVariants = cva("relative w-full rounded-lg border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground [&>svg~*]:pl-7", {
    variants: {
        variant: {
            default: "bg-card text-card-foreground border-border",
            destructive: "border-destructive/40 bg-destructive/10 text-destructive [&>svg]:text-destructive",
            success: "border-success/40 bg-success/10 text-success [&>svg]:text-success",
            warning: "border-warning/40 bg-warning/10 text-warning [&>svg]:text-warning",
            info: "border-info/40 bg-info/10 text-info [&>svg]:text-info",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});
const Alert = React.forwardRef((_a, ref) => {
    var { className, variant } = _a, props = __rest(_a, ["className", "variant"]);
    return (React.createElement("div", Object.assign({ ref: ref, role: "alert", className: cn(alertVariants({ variant }), className) }, props)));
});
Alert.displayName = "Alert";
const AlertTitle = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("h5", Object.assign({ ref: ref, className: cn("mb-1 font-semibold leading-none tracking-tight", className) }, props)));
});
AlertTitle.displayName = "AlertTitle";
const AlertDescription = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ ref: ref, className: cn("text-sm [&_p]:leading-relaxed", className) }, props)));
});
AlertDescription.displayName = "AlertDescription";
export { Alert, AlertTitle, AlertDescription, alertVariants };
//# sourceMappingURL=alert.js.map