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

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

interface ParsedChord {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** The key in lowercase. Special keys keep their canonical name (escape, enter, tab). */
  key: string;
}

function parseChord(chord: string): ParsedChord {
  const parts = chord.split("+").map((p) => p.trim());
  const result: ParsedChord = {
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
        if (isMac) result.meta = true;
        else result.ctrl = true;
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

function chordMatches(parsed: ParsedChord, event: KeyboardEvent): boolean {
  if (parsed.ctrl !== event.ctrlKey) return false;
  if (parsed.meta !== event.metaKey) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;
  // Match by `event.key` for printable / named keys (case-insensitive).
  return event.key.toLowerCase() === parsed.key;
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
};

/**
 * Subscribe a callback to a keyboard chord. The chord can be a single string
 * or an array of strings — any match fires the handler.
 */
export function useShortcut(
  chord: string | string[],
  handler: ShortcutHandler,
  options: UseShortcutOptions = {},
): void {
  const {
    allowInInputs = false,
    preventDefault = true,
    enabled = true,
    target,
  } = options;

  // Stable handler ref so the listener doesn't re-bind on every render.
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;

  const parsedChords = React.useMemo(
    () => (Array.isArray(chord) ? chord : [chord]).map(parseChord),
    [chord],
  );

  React.useEffect(() => {
    if (!enabled) return;
    // Explicit null = "do not bind" (e.g. caller wants the shortcut disabled
    // contextually without un-mounting the hook). `undefined` falls back to
    // window. The previous chain collapsed null → null via ??, but never
    // distinguished those intents; tests pinned the contract going forward.
    const defaultTarget: EventTarget | null =
      typeof window === "undefined" ? null : window;
    const element: EventTarget | null =
      target === null ? null : (target ?? defaultTarget);
    if (!element) return;

    const onKeyDown = (event: Event) => {
      const e = event as KeyboardEvent;
      if (!allowInInputs && isEditableTarget(e.target)) return;
      for (const parsed of parsedChords) {
        if (chordMatches(parsed, e)) {
          if (preventDefault) e.preventDefault();
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
export function modKeyLabel(): string {
  return isMac ? "⌘" : "Ctrl";
}

/** Returns "true" when running on a macOS or iOS user agent. */
export const IS_MAC = isMac;
