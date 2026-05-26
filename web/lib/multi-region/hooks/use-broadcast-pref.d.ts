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
import { type UsePersistedStateOptions } from "./use-persisted-state";
export declare function useBroadcastPref<T>(key: string, initialValue: T | (() => T), options?: UsePersistedStateOptions<T>): [T, React.Dispatch<React.SetStateAction<T>>, () => void];
export declare const BROADCAST_PREF_CHANNEL = "azbm:prefs";
//# sourceMappingURL=use-broadcast-pref.d.ts.map