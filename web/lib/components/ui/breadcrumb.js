import { __rest } from "tslib";
/**
 * Breadcrumb primitive — semantic nav structure for the route trail.
 * Composes with React Router via `<Link>` (or any anchor).
 */
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
const Breadcrumb = React.forwardRef((_a, ref) => {
    var props = __rest(_a, []);
    return React.createElement("nav", Object.assign({ ref: ref, "aria-label": "breadcrumb" }, props));
});
Breadcrumb.displayName = "Breadcrumb";
const BreadcrumbList = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("ol", Object.assign({ ref: ref, className: cn("flex flex-wrap items-center gap-1.5 break-words text-xs text-muted-foreground sm:gap-2", className) }, props)));
});
BreadcrumbList.displayName = "BreadcrumbList";
const BreadcrumbItem = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("li", Object.assign({ ref: ref, className: cn("inline-flex items-center gap-1.5", className) }, props)));
});
BreadcrumbItem.displayName = "BreadcrumbItem";
const BreadcrumbLink = React.forwardRef((_a, ref) => {
    var { asChild, className } = _a, props = __rest(_a, ["asChild", "className"]);
    const Comp = asChild ? Slot : "a";
    return (React.createElement(Comp, Object.assign({ ref: ref, className: cn("transition-colors duration-fast hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none", className) }, props)));
});
BreadcrumbLink.displayName = "BreadcrumbLink";
const BreadcrumbPage = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("span", Object.assign({ ref: ref, role: "link", "aria-disabled": "true", "aria-current": "page", className: cn("font-medium text-foreground", className) }, props)));
});
BreadcrumbPage.displayName = "BreadcrumbPage";
const BreadcrumbSeparator = (_a) => {
    var { children, className } = _a, props = __rest(_a, ["children", "className"]);
    return (React.createElement("li", Object.assign({ role: "presentation", "aria-hidden": "true", className: cn("[&>svg]:h-3 [&>svg]:w-3", className) }, props), children !== null && children !== void 0 ? children : React.createElement(ChevronRight, null)));
};
BreadcrumbSeparator.displayName = "BreadcrumbSeparator";
const BreadcrumbEllipsis = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("span", Object.assign({ role: "presentation", "aria-hidden": "true", className: cn("flex h-5 w-5 items-center justify-center", className) }, props),
        React.createElement(MoreHorizontal, { className: "h-3 w-3" }),
        React.createElement("span", { className: "sr-only" }, "More")));
};
BreadcrumbEllipsis.displayName = "BreadcrumbEllipsis";
export { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator, BreadcrumbEllipsis, };
//# sourceMappingURL=breadcrumb.js.map