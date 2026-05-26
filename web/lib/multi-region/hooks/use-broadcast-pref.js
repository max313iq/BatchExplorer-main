/**
 * useBroadcastPref — cross-tab user preference sync.
 *
 * Wraps `usePersistedState` and adds a `BroadcastChannel("azbm:prefs")` so
 * a pref change in one tab is reflected in every other open tab without
 * the user having to reload. This is what you want for things like the
 * density toggle and the dark/light toggle — turn it on in tab A, see it
 * apply in tab B immediately.
 *
 * Falls back gracefully:
 *   - SSR: returns the initial value, never touches `window`.
 *   - No BroadcastChannel (old Safari, restricted contexts): the hook
 *     still persists locally; cross-tab sync degrades to the `storage`
 *     event when `syncAcrossTabs` is true on `usePersistedState`.
 *
 * The channel name is shared across every consumer (`"azbm:prefs"`) and
 * each message carries `{ key, value }` so listeners can ignore changes
 * to other keys. Self-broadcasts are filtered using a per-hook origin id
 * — otherwise a setState in tab A would echo back to tab A and re-render.
 */
import * as React from "react";
import { usePersistedState, } from "./use-persisted-state";
const CHANNEL_NAME = "azbm:prefs";
let originSeed = 0;
function nextOriginId() {
    originSeed += 1;
    // Random-ish — collision is harmless (worst case: ignore one own broadcast).
    return `${Date.now().toString(36)}-${originSeed.toString(36)}`;
}
export function useBroadcastPref(key, initialValue, options = {}) {
    // Persisted-state handles the localStorage hop. We layer the channel on
    // top — writes go through both, reads come from whichever fires first.
    const [state, setState, reset] = usePersistedState(key, initialValue, options);
    const originRef = React.useRef(null);
    if (originRef.current === null)
        originRef.current = nextOriginId();
    const channelRef = React.useRef(null);
    // Establish the channel exactly once. We can't put it in state because
    // BroadcastChannel is not React-safe (no shallow-equality discipline).
    React.useEffect(() => {
        if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
            return;
        }
        const channel = new BroadcastChannel(CHANNEL_NAME);
        channelRef.current = channel;
        const onMessage = (e) => {
            const msg = e.data;
            if (!msg)
                return;
            if (msg.origin === originRef.current)
                return; // self-echo
            if (msg.key !== key)
                return;
            setState(msg.value);
        };
        channel.addEventListener("message", onMessage);
        return () => {
            channel.removeEventListener("message", onMessage);
            channel.close();
            channelRef.current = null;
        };
    }, [key, setState]);
    // Public setter that mirrors the React update onto the channel.
    const setStateAndBroadcast = React.useCallback((next) => {
        setState((prev) => {
            const value = typeof next === "function" ? next(prev) : next;
            const ch = channelRef.current;
            if (ch && originRef.current) {
                try {
                    ch.postMessage({
                        origin: originRef.current,
                        key,
                        value,
                    });
                }
                catch (_a) {
                    // Channel closed mid-flight, or value is non-cloneable — ignore.
                }
            }
            return value;
        });
    }, [key, setState]);
    return [state, setStateAndBroadcast, reset];
}
export const BROADCAST_PREF_CHANNEL = CHANNEL_NAME;
//# sourceMappingURL=use-broadcast-pref.js.map