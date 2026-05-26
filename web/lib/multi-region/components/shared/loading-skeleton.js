import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
export const LoadingSkeleton = ({ lines = 3, width = "100%", lineHeight = 14, }) => {
    return (React.createElement("div", { className: "flex flex-col gap-2", style: { width }, role: "progressbar", "aria-label": "Loading content" }, Array.from({ length: lines }, (_, i) => (React.createElement(Skeleton, { key: i, className: "rounded", style: {
            height: lineHeight,
            width: i === lines - 1 ? "60%" : "100%",
        } })))));
};
//# sourceMappingURL=loading-skeleton.js.map