import { __rest } from "tslib";
/**
 * Command palette primitive — wraps `cmdk`. Used for the project-wide
 * Cmd+K palette (see shared/command-menu.tsx) and any in-context fuzzy
 * search (e.g. region/account picker in EA Subscription page).
 */
import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent } from "@/components/ui/dialog";
const Command = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(CommandPrimitive, Object.assign({ ref: ref, className: cn("flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground", className) }, props)));
});
Command.displayName = CommandPrimitive.displayName;
const CommandDialog = (_a) => {
    var { children, label } = _a, props = __rest(_a, ["children", "label"]);
    return (React.createElement(Dialog, Object.assign({}, props),
        React.createElement(DialogContent, { className: "overflow-hidden p-0 shadow-elev-4" },
            React.createElement(Command, { label: label !== null && label !== void 0 ? label : "Command palette", className: "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-1.5 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-11 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4" }, children))));
};
const CommandInput = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", { className: "flex items-center border-b border-border px-3", "cmdk-input-wrapper": "" },
        React.createElement(Search, { className: "mr-2 h-4 w-4 shrink-0 text-muted-foreground" }),
        React.createElement(CommandPrimitive.Input, Object.assign({ ref: ref, className: cn("flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50", className) }, props))));
});
CommandInput.displayName = CommandPrimitive.Input.displayName;
const CommandList = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(CommandPrimitive.List, Object.assign({ ref: ref, className: cn("max-h-[320px] overflow-y-auto overflow-x-hidden", className) }, props)));
});
CommandList.displayName = CommandPrimitive.List.displayName;
const CommandEmpty = React.forwardRef((props, ref) => (React.createElement(CommandPrimitive.Empty, Object.assign({ ref: ref, className: "py-6 text-center text-sm text-muted-foreground" }, props))));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;
const CommandGroup = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(CommandPrimitive.Group, Object.assign({ ref: ref, className: cn("overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground", className) }, props)));
});
CommandGroup.displayName = CommandPrimitive.Group.displayName;
const CommandSeparator = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(CommandPrimitive.Separator, Object.assign({ ref: ref, className: cn("-mx-1 h-px bg-border", className) }, props)));
});
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;
const CommandItem = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement(CommandPrimitive.Item, Object.assign({ ref: ref, className: cn("relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent/15 data-[selected=true]:text-foreground data-[disabled=true]:opacity-50", className) }, props)));
});
CommandItem.displayName = CommandPrimitive.Item.displayName;
const CommandShortcut = (_a) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("span", Object.assign({ className: cn("ml-auto text-2xs tracking-wider text-muted-foreground tabular-nums", className) }, props)));
};
CommandShortcut.displayName = "CommandShortcut";
export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator, };
//# sourceMappingURL=command.js.map