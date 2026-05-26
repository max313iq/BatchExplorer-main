/**
 * useReducedMotion — true when the user has set their OS preference to
 * "reduce motion". Pages can opt into honoring this for in-app animations
 * (autoplay videos, parallax, ambient `Meteors`, etc.) so the experience
 * matches the user's accessibility settings.
 *
 * Subscribes to changes — flips live if the user toggles the system pref
 * mid-session. SSR-safe (returns `false` when `window.matchMedia` is
 * unavailable).
 */
import * as React from "react";
const QUERY = "(prefers-reduced-motion: reduce)";
export function useReducedMotion() {
    const subscribe = React.useCallback((onChange) => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
            return () => { };
        }
        const mq = window.matchMedia(QUERY);
        // Safari < 14 only supports addListener/removeListener.
        if (typeof mq.addEventListener === "function") {
            mq.addEventListener("change", onChange);
            return () => mq.removeEventListener("change", onChange);
        }
        mq.addListener(onChange);
        return () => mq.removeListener(onChange);
    }, []);
    const getSnapshot = React.useCallback(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
            return false;
        }
        return window.matchMedia(QUERY).matches;
    }, []);
    const getServerSnapshot = React.useCallback(() => false, []);
    // React 18 `useSyncExternalStore` is the safe primitive for matchMedia —
    // it handles tearing and concurrent rendering without extra effects.
    return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
//# sourceMappingURL=use-reduced-motion.js.map