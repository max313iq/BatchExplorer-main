import { __rest } from "tslib";
/**
 * useEventListener — typed `addEventListener` wrapper.
 *
 * Centralizes the (otherwise re-invented) pattern of:
 *   1. storing the handler in a ref so the effect doesn't re-bind on
 *      every render;
 *   2. cleaning up on dependency change / unmount;
 *   3. preserving the typed event signature.
 *
 * Three overloads cover the targets we care about:
 *   - `Window` events (default target, e.g. `"resize"`).
 *   - `Document` events (e.g. `"visibilitychange"`).
 *   - Element events on a specific `HTMLElement` ref or instance.
 *
 * @example
 * ```ts
 * useEventListener("keydown", (e) => {
 *   if (e.key === "Escape") close();
 * });
 *
 * useEventListener("visibilitychange", () => {
 *   if (document.visibilityState === "visible") refresh();
 * }, { target: typeof document !== "undefined" ? document : null });
 * ```
 */
import * as React from "react";
// Implementation
export function useEventListener(type, handler, options = {}) {
    const { target, enabled = true } = options, listenerOptions = __rest(options, ["target", "enabled"]);
    const handlerRef = React.useRef(handler);
    handlerRef.current = handler;
    // Stable identity for the AddEventListenerOptions so the effect deps don't
    // explode. We serialize the listener-specific options into a string key.
    const optionsKey = JSON.stringify(listenerOptions);
    React.useEffect(() => {
        if (!enabled)
            return;
        const element = target === undefined
            ? typeof window === "undefined"
                ? null
                : window
            : target;
        if (!element)
            return;
        const wrappedHandler = (event) => handlerRef.current(event);
        element.addEventListener(type, wrappedHandler, listenerOptions);
        return () => element.removeEventListener(type, wrappedHandler, listenerOptions);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, target, enabled, optionsKey]);
}
//# sourceMappingURL=use-event-listener.js.map