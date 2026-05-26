/**
 * useShortcut — subscribe a callback to a keyboard shortcut chord.
 * Per Design Contract §4.2 + §M (keyboard help) + §N (Cmd-K palette).
 *
 * Chord syntax (case-insensitive):
 *   "k"             — bare key
 *   "Escape"        — special key (Esc, Enter, Tab, ?, /)
 *   "Mod+k"         — Mod = Cmd on macOS, Ctrl elsewhere
 *   "Ctrl+Shift+P"  — explicit modifiers (Ctrl, Shift, Alt, Meta)
 *   "Alt+1"         — number-key chord (used for Alt+1..9 nav hotkeys)
 */
import * as React from "react";
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
function parseChord(chord) {
    const parts = chord.split("+").map((p) => p.trim());
    const result = {
        ctrl: false,
        meta: false,
        shift: false,
        alt: false,
        key: "",
    };
    for (const part of parts) {
        const lower = part.toLowerCase();
        switch (lower) {
            case "ctrl":
            case "control":
                result.ctrl = true;
                break;
            case "cmd":
            case "meta":
            case "command":
                result.meta = true;
                break;
            case "mod":
                if (isMac)
                    result.meta = true;
                else
                    result.ctrl = true;
                break;
            case "shift":
                result.shift = true;
                break;
            case "alt":
            case "option":
                result.alt = true;
                break;
            default:
                result.key = lower;
        }
    }
    return result;
}
function chordMatches(parsed, event) {
    if (parsed.ctrl !== event.ctrlKey)
        return false;
    if (parsed.meta !== event.metaKey)
        return false;
    if (parsed.shift !== event.shiftKey)
        return false;
    if (parsed.alt !== event.altKey)
        return false;
    // Match by `event.key` for printable / named keys (case-insensitive).
    return event.key.toLowerCase() === parsed.key;
}
const isEditableTarget = (target) => {
    if (!(target instanceof HTMLElement))
        return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")
        return true;
    if (target.isContentEditable)
        return true;
    return false;
};
/**
 * Subscribe a callback to a keyboard chord. The chord can be a single string
 * or an array of strings — any match fires the handler.
 */
export function useShortcut(chord, handler, options = {}) {
    const { allowInInputs = false, preventDefault = true, enabled = true, target, } = options;
    // Stable handler ref so the listener doesn't re-bind on every render.
    const handlerRef = React.useRef(handler);
    handlerRef.current = handler;
    const parsedChords = React.useMemo(() => (Array.isArray(chord) ? chord : [chord]).map(parseChord), [chord]);
    React.useEffect(() => {
        if (!enabled)
            return;
        // Explicit null = "do not bind" (e.g. caller wants the shortcut disabled
        // contextually without un-mounting the hook). `undefined` falls back to
        // window. The previous chain collapsed null → null via ??, but never
        // distinguished those intents; tests pinned the contract going forward.
        const defaultTarget = typeof window === "undefined" ? null : window;
        const element = target === null ? null : (target !== null && target !== void 0 ? target : defaultTarget);
        if (!element)
            return;
        const onKeyDown = (event) => {
            const e = event;
            if (!allowInInputs && isEditableTarget(e.target))
                return;
            for (const parsed of parsedChords) {
                if (chordMatches(parsed, e)) {
                    if (preventDefault)
                        e.preventDefault();
                    handlerRef.current(e);
                    return;
                }
            }
        };
        element.addEventListener("keydown", onKeyDown);
        return () => element.removeEventListener("keydown", onKeyDown);
    }, [enabled, target, parsedChords, allowInInputs, preventDefault]);
}
/** Returns the platform-appropriate "Mod" key label for tooltip / help text. */
export function modKeyLabel() {
    return isMac ? "⌘" : "Ctrl";
}
/** Returns "true" when running on a macOS or iOS user agent. */
export const IS_MAC = isMac;
//# sourceMappingURL=use-shortcut.js.map