/**
 * Kbd primitive — keyboard-shortcut display. Used in tooltips, command
 * palette items, and the keyboard-shortcut help dialog.
 */
import * as React from "react";
export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
    /** Optional size override. Default tracks the surrounding text. */
    size?: "xs" | "sm";
}
declare const Kbd: React.ForwardRefExoticComponent<KbdProps & React.RefAttributes<HTMLElement>>;
/**
 * Render a chord ("Ctrl+K") as a sequence of <Kbd> elements joined by "+".
 */
interface KbdChordProps extends Omit<KbdProps, "children"> {
    /** The chord, e.g. "Ctrl+K" or "Alt+1". */
    keys: string;
}
declare const KbdChord: {
    ({ keys, className, ...rest }: KbdChordProps): React.JSX.Element;
    displayName: string;
};
export { Kbd, KbdChord };
//# sourceMappingURL=kbd.d.ts.map