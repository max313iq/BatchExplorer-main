/**
 * useBeforeUnload — register a `beforeunload` prompt while a condition
 * holds. Use to guard against losing in-progress form input.
 *
 * Browsers no longer honor a custom message string (Chrome/Firefox show a
 * generic "Leave site?" prompt) but the parameter is preserved on the
 * event for older Safari builds and for completeness.
 *
 * @example
 * ```ts
 * const [dirty, setDirty] = React.useState(false);
 * useBeforeUnload(dirty);
 * ```
 *
 * `when` can be a boolean (re-evaluated on every render) or a function
 * (evaluated lazily at unload time, so it can read fresh state via a ref
 * without re-binding the listener).
 */
import * as React from "react";

export function useBeforeUnload(
  when: boolean | (() => boolean),
  message = "You have unsaved changes. Leave anyway?",
): void {
  // Latch the predicate in a ref so the listener always reads the current
  // closure without forcing a re-bind on every render.
  const whenRef = React.useRef(when);
  whenRef.current = when;
  const messageRef = React.useRef(message);
  messageRef.current = message;

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const guard = whenRef.current;
      const active = typeof guard === "function" ? guard() : guard;
      if (!active) return undefined;
      const msg = messageRef.current;
      // Required to trigger the prompt in all modern browsers.
      e.preventDefault();
      // Legacy Safari needs `returnValue` set explicitly.
      e.returnValue = msg;
      return msg;
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
