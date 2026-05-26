import { __rest } from "tslib";
/**
 * Kbd primitive — keyboard-shortcut display. Used in tooltips, command
 * palette items, and the keyboard-shortcut help dialog.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
const Kbd = React.forwardRef((_a, ref) => {
    var { className, size = "xs", children } = _a, props = __rest(_a, ["className", "size", "children"]);
    return (React.createElement("kbd", Object.assign({ ref: ref, className: cn("inline-flex items-center justify-center rounded border border-border bg-muted/60 font-mono text-muted-foreground tabular-nums", size === "xs" && "min-w-[1.25rem] px-1 py-0.5 text-2xs", size === "sm" && "min-w-[1.5rem] px-1.5 py-0.5 text-xs", className) }, props), children));
});
Kbd.displayName = "Kbd";
const KbdChord = (_a) => {
    var { keys, className } = _a, rest = __rest(_a, ["keys", "className"]);
    const parts = keys.split(/\s*\+\s*/).filter(Boolean);
    return (React.createElement("span", { className: cn("inline-flex items-center gap-0.5", className) }, parts.map((k, i) => (React.createElement(React.Fragment, { key: `${k}-${i}` },
        i > 0 && (React.createElement("span", { "aria-hidden": "true", className: "text-muted-foreground/60" }, "+")),
        React.createElement(Kbd, Object.assign({}, rest), k))))));
};
KbdChord.displayName = "KbdChord";
export { Kbd, KbdChord };
//# sourceMappingURL=kbd.js.map