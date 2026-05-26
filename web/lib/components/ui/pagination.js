import { __rest } from "tslib";
/**
 * Pagination primitive — used by DataTable and any paginated list view.
 * Wraps `useState`/external pagination state from `use-pagination` hook.
 */
import * as React from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MoreHorizontal, } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
const Pagination = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("nav", Object.assign({ role: "navigation", "aria-label": "pagination", className: cn("mx-auto flex w-full justify-center", className) }, props)));
};
Pagination.displayName = "Pagination";
const PaginationContent = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("ul", Object.assign({ ref: ref, className: cn("flex flex-row items-center gap-1", className) }, props)));
});
PaginationContent.displayName = "PaginationContent";
const PaginationItem = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("li", Object.assign({ ref: ref, className: cn("", className) }, props)));
});
PaginationItem.displayName = "PaginationItem";
const PaginationLink = (_a) => {
    var { className, isActive, size = "icon-sm" } = _a, props = __rest(_a, ["className", "isActive", "size"]);
    return (React.createElement("button", Object.assign({ type: "button", "aria-current": isActive ? "page" : undefined, className: cn(buttonVariants({
            variant: isActive ? "default" : "ghost",
            size,
        }), "tabular-nums", className) }, props)));
};
PaginationLink.displayName = "PaginationLink";
const PaginationPrevious = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(Button, Object.assign({ type: "button", variant: "ghost", size: "sm", "aria-label": "Previous page", className: cn("gap-1", className) }, props),
        React.createElement(ChevronLeft, { className: "h-3.5 w-3.5" }),
        React.createElement("span", null, "Previous")));
};
PaginationPrevious.displayName = "PaginationPrevious";
const PaginationNext = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(Button, Object.assign({ type: "button", variant: "ghost", size: "sm", "aria-label": "Next page", className: cn("gap-1", className) }, props),
        React.createElement("span", null, "Next"),
        React.createElement(ChevronRight, { className: "h-3.5 w-3.5" })));
};
PaginationNext.displayName = "PaginationNext";
const PaginationFirst = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(Button, Object.assign({ type: "button", variant: "ghost", size: "icon-sm", "aria-label": "First page", className: className }, props),
        React.createElement(ChevronsLeft, { className: "h-3.5 w-3.5" })));
};
PaginationFirst.displayName = "PaginationFirst";
const PaginationLast = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(Button, Object.assign({ type: "button", variant: "ghost", size: "icon-sm", "aria-label": "Last page", className: className }, props),
        React.createElement(ChevronsRight, { className: "h-3.5 w-3.5" })));
};
PaginationLast.displayName = "PaginationLast";
const PaginationEllipsis = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("span", Object.assign({ "aria-hidden": "true", className: cn("flex h-7 w-7 items-center justify-center", className) }, props),
        React.createElement(MoreHorizontal, { className: "h-3.5 w-3.5" }),
        React.createElement("span", { className: "sr-only" }, "More pages")));
};
PaginationEllipsis.displayName = "PaginationEllipsis";
export { Pagination, PaginationContent, PaginationLink, PaginationItem, PaginationPrevious, PaginationNext, PaginationFirst, PaginationLast, PaginationEllipsis, };
//# sourceMappingURL=pagination.js.map