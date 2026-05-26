import { __rest } from "tslib";
/**
 * Sheet primitive — side-anchored panel built on Radix Dialog. Used for
 * detail drawers (e.g. Azure Accounts page per-account drawer, Tenant Users
 * bulk-action progress drawer).
 */
import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;
const SheetOverlay = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(SheetPrimitive.Overlay, Object.assign({ className: cn("fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0", className) }, props, { ref: ref })));
});
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;
const sheetVariants = cva("fixed z-50 gap-4 bg-popover text-popover-foreground shadow-elev-4 transition ease-standard data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500 motion-reduce:transition-none motion-reduce:animate-none", {
    variants: {
        side: {
            top: "inset-x-0 top-0 border-b border-border data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
            bottom: "inset-x-0 bottom-0 border-t border-border data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
            left: "inset-y-0 left-0 h-full w-3/4 border-r border-border data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-md",
            right: "inset-y-0 right-0 h-full w-3/4 border-l border-border data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-md",
        },
        size: {
            default: "",
            lg: "sm:max-w-2xl",
            xl: "sm:max-w-4xl",
        },
    },
    defaultVariants: { side: "right", size: "default" },
});
const SheetContent = React.forwardRef((_a, ref) => {
    var { side = "right", size, className, children } = _a, props = __rest(_a, ["side", "size", "className", "children"]);
    return (React.createElement(SheetPortal, null,
        React.createElement(SheetOverlay, null),
        React.createElement(SheetPrimitive.Content, Object.assign({ ref: ref, className: cn(sheetVariants({ side, size }), className) }, props),
            children,
            React.createElement(SheetPrimitive.Close, { className: "absolute right-4 top-4 rounded-sm text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none", "aria-label": "Close" },
                React.createElement(X, { className: "h-4 w-4" })))));
});
SheetContent.displayName = SheetPrimitive.Content.displayName;
const SheetHeader = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ className: cn("flex flex-col space-y-1.5 border-b border-border px-6 py-4 text-left", className) }, props)));
};
SheetHeader.displayName = "SheetHeader";
const SheetBody = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ className: cn("flex-1 overflow-auto px-6 py-4", className) }, props)));
};
SheetBody.displayName = "SheetBody";
const SheetFooter = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", Object.assign({ className: cn("flex flex-col-reverse gap-2 border-t border-border px-6 py-4 sm:flex-row sm:justify-end", className) }, props)));
};
SheetFooter.displayName = "SheetFooter";
const SheetTitle = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(SheetPrimitive.Title, Object.assign({ ref: ref, className: cn("text-base font-semibold text-foreground", className) }, props)));
});
SheetTitle.displayName = SheetPrimitive.Title.displayName;
const SheetDescription = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(SheetPrimitive.Description, Object.assign({ ref: ref, className: cn("text-sm text-muted-foreground", className) }, props)));
});
SheetDescription.displayName = SheetPrimitive.Description.displayName;
export { Sheet, SheetTrigger, SheetClose, SheetPortal, SheetOverlay, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription, };
//# sourceMappingURL=sheet.js.map