import { __rest } from "tslib";
import * as React from "react";
import { cn } from "@/lib/utils";
const Card = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ ref: ref, className: cn("rounded-lg border bg-card text-card-foreground shadow-sm", className) }, props)));
});
Card.displayName = "Card";
const CardHeader = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ ref: ref, className: cn("flex flex-col space-y-1.5 p-4", className) }, props)));
});
CardHeader.displayName = "CardHeader";
const CardTitle = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ ref: ref, className: cn("text-base font-semibold leading-none tracking-tight", className) }, props)));
});
CardTitle.displayName = "CardTitle";
const CardDescription = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ ref: ref, className: cn("text-xs text-muted-foreground", className) }, props)));
});
CardDescription.displayName = "CardDescription";
const CardContent = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ ref: ref, className: cn("p-4 pt-0", className) }, props)));
});
CardContent.displayName = "CardContent";
const CardFooter = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ ref: ref, className: cn("flex items-center p-4 pt-0", className) }, props)));
});
CardFooter.displayName = "CardFooter";
export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, };
//# sourceMappingURL=card.js.map