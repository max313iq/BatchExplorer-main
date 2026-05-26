import { __rest } from "tslib";
import * as React from "react";
import { cn } from "@/lib/utils";
function Skeleton(_a) {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ className: cn("animate-pulse rounded-md bg-muted/60", className) }, props)));
}
export { Skeleton };
//# sourceMappingURL=skeleton.js.map