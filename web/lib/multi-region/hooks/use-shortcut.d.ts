export type ShortcutHandler = (event: KeyboardEvent) => void;
export interface UseShortcutOptions {
    /** Whether to ignore the shortcut while focus is in an input field. */
    allowInInputs?: boolean;
    /** Whether to call `event.preventDefault()` when the chord matches. */
    preventDefault?: boolean;
    /** Whether the listener is enabled. Default: true. */
    enabled?: boolean;
    /** Optional target. Default: window. */
    target?: EventTarget | null;
}
/**
 * Subscribe a callback to a keyboard chord. The chord can be a single string
 * or an array of strings — any match fires the handler.
 */
export declare function useShortcut(chord: string | string[], handler: ShortcutHandler, options?: UseShortcutOptions): void;
/** Returns the platform-appropriate "Mod" key label for tooltip / help text. */
export declare function modKeyLabel(): string;
/** Returns "true" when running on a macOS or iOS user agent. */
export declare const IS_MAC: boolean;
//# sourceMappingURL=use-shortcut.d.ts.map