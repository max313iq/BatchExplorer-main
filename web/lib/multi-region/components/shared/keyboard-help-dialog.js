/**
 * Keyboard-shortcut help dialog. Bound to `?` per Design Contract §M.
 *
 * Lists the registered shortcuts grouped by category so users can discover
 * Alt+1..9, Cmd-K, refresh, sign-in, density toggle, etc., without reading
 * source code.
 */
import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { KbdChord } from "@/components/ui/kbd";
import { useShortcut, modKeyLabel } from "../../hooks/use-shortcut";
/**
 * Static labels for the first 9 entries of PAGE_ORDER (the Alt+1..9 mapping
 * in page-router.tsx). Kept here as a literal so the help dialog renders
 * synchronously without importing the router (which would create a cycle
 * through DashboardOutlet → PageRouter → KeyboardHelpDialog).
 *
 * If you reorder the first 9 entries in PAGE_ORDER, update this list too.
 * The order here MUST match the first 9 of PAGE_ORDER in page-router.tsx.
 */
const ALT_SHORTCUTS = [
    { chord: "Alt+1", label: "Azure Accounts" },
    { chord: "Alt+2", label: "Overview" },
    { chord: "Alt+3", label: "Accounts" },
    { chord: "Alt+4", label: "Pools" },
    { chord: "Alt+5", label: "Pool Settings" },
    { chord: "Alt+6", label: "Pool Info" },
    { chord: "Alt+7", label: "Account Info" },
    { chord: "Alt+8", label: "Unused Quota" },
    { chord: "Alt+9", label: "Monitoring" },
];
const DEFAULT_GROUPS = () => [
    {
        heading: "Navigation",
        shortcuts: ALT_SHORTCUTS,
    },
    {
        heading: "Global",
        shortcuts: [
            { chord: `${modKeyLabel()}+K`, label: "Open command palette" },
            { chord: `${modKeyLabel()}+R`, label: "Refresh all data" },
            { chord: "?", label: "Show this help" },
            { chord: "Escape", label: "Close dialog / sheet" },
            { chord: `${modKeyLabel()}+S`, label: "Save session" },
            { chord: `${modKeyLabel()}+E`, label: "Export session as JSON" },
        ],
    },
    {
        heading: "View",
        shortcuts: [
            { chord: `${modKeyLabel()}+D`, label: "Toggle dark / light mode" },
            { chord: `${modKeyLabel()}+Shift+D`, label: "Toggle row density" },
            { chord: `${modKeyLabel()}+B`, label: "Collapse / expand sidebar" },
        ],
    },
    {
        heading: "Tables",
        shortcuts: [
            { chord: "↑ / ↓", label: "Move row selection" },
            { chord: "Space", label: "Toggle row selection" },
            { chord: "Enter", label: "Activate row" },
            { chord: `${modKeyLabel()}+A`, label: "Select all visible rows" },
        ],
    },
];
export const KeyboardHelpDialog = ({ open, onOpenChange, groups, }) => {
    const renderedGroups = React.useMemo(() => groups !== null && groups !== void 0 ? groups : DEFAULT_GROUPS(), [groups]);
    return (React.createElement(Dialog, { open: open, onOpenChange: onOpenChange },
        React.createElement(DialogContent, { className: "max-w-2xl" },
            React.createElement(DialogHeader, null,
                React.createElement(DialogTitle, null, "Keyboard shortcuts"),
                React.createElement(DialogDescription, null, "Press the chord shown next to each action. Most shortcuts are disabled while you're typing in an input field.")),
            React.createElement(ScrollArea, { className: "max-h-[60vh] pr-2" },
                React.createElement("div", { className: "grid gap-6 sm:grid-cols-2" }, renderedGroups.map((group) => (React.createElement("div", { key: group.heading, className: "flex flex-col gap-2" },
                    React.createElement("h3", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, group.heading),
                    React.createElement("ul", { className: "flex flex-col gap-1.5" }, group.shortcuts.map((s) => (React.createElement("li", { key: `${group.heading}-${s.chord}`, className: "flex items-center justify-between gap-3 text-xs text-foreground" },
                        React.createElement("span", { className: "truncate" }, s.label),
                        React.createElement(KbdChord, { keys: s.chord, className: "shrink-0" })))))))))))));
};
/**
 * Convenience wrapper that owns its own open-state and binds the `?` chord.
 * Use this in the dashboard shell so the dialog "just works."
 */
export const ConnectedKeyboardHelp = ({ groups }) => {
    const [open, setOpen] = React.useState(false);
    // `?` requires Shift on most layouts, but `event.key` reports it as "?".
    // Bind both to be safe. Also bind Cmd+/ (Mod+/) as a convenient power-user
    // alias — same chord users from VS Code / GitHub Copilot already have in
    // muscle memory for "show me what shortcuts exist."
    useShortcut(["?", "Shift+?", "Mod+/"], () => setOpen(true), {
        allowInInputs: false,
    });
    return React.createElement(KeyboardHelpDialog, { open: open, onOpenChange: setOpen, groups: groups });
};
//# sourceMappingURL=keyboard-help-dialog.js.map