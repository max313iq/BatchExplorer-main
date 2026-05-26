/**
 * Keyboard-shortcut help dialog. Bound to `?` per Design Contract §M.
 *
 * Lists the registered shortcuts grouped by category so users can discover
 * Alt+1..9, Cmd-K, refresh, sign-in, density toggle, etc., without reading
 * source code.
 */
import * as React from "react";
export interface ShortcutDef {
    chord: string;
    label: string;
}
export interface ShortcutGroup {
    heading: string;
    shortcuts: ShortcutDef[];
}
export interface KeyboardHelpDialogProps {
    /** Whether the dialog is open. */
    open: boolean;
    /** Open-state setter. */
    onOpenChange: (open: boolean) => void;
    /** Override the default shortcut groups (e.g. add page-specific ones). */
    groups?: ShortcutGroup[];
}
export declare const KeyboardHelpDialog: React.FC<KeyboardHelpDialogProps>;
/**
 * Convenience wrapper that owns its own open-state and binds the `?` chord.
 * Use this in the dashboard shell so the dialog "just works."
 */
export declare const ConnectedKeyboardHelp: React.FC<{
    groups?: ShortcutGroup[];
}>;
//# sourceMappingURL=keyboard-help-dialog.d.ts.map