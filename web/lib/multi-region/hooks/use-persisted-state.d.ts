/**
 * usePersistedState — single localStorage adapter for state values that
 * survive page reload. Replaces scattered `localStorage.getItem/setItem`
 * calls per Design Contract §10 forbidden patterns.
 *
 * SSR-safe (returns the default value when localStorage is unavailable).
 * Cross-tab sync via the `storage` event when `syncAcrossTabs` is enabled.
 *
 * ## Schema versioning
 *
 * When persisted shapes evolve, pass `version` + an optional `migrate` to
 * transform older payloads:
 *
 *   const [value, setValue] = usePersistedState("prefs", DEFAULT_PREFS, {
 *     version: 2,
 *     migrate: (raw, oldVersion) => {
 *       if (oldVersion === 1) return { ...(raw as object), density: "comfy" };
 *       return raw as Prefs;
 *     },
 *   });
 *
 * On read, the stored envelope is `{ v: number, data: T }`. If `v !== version`
 * (or the stored value is the legacy bare form), `migrate` is called and the
 * returned value is treated as the new shape. If `migrate` throws or returns
 * undefined, the hook falls back to `initialValue`.
 *
 * On write, the envelope is `{ v: version, data }`.
 *
 * ## Stability contract
 *
 * `serialize` and `deserialize` are render-stable — only the first-render
 * value is used. Passing an inline function on every render is safe but the
 * later versions are ignored. This avoids the infinite-write loop that
 * would otherwise occur from a `serialize` dependency in the persist effect.
 */
import * as React from "react";
export interface UsePersistedStateOptions<T> {
    /** Optional serializer for the `data` payload. Default: JSON.stringify. */
    serialize?: (value: T) => string;
    /** Optional deserializer for the `data` payload. Default: JSON.parse with try/catch. */
    deserialize?: (raw: string) => T | undefined;
    /**
     * Sync the state across browser tabs via the `storage` event.
     * Default: false (each tab keeps its own local copy).
     */
    syncAcrossTabs?: boolean;
    /**
     * Schema version. Bumping this number triggers `migrate` for any stored
     * payload written under a different version. If omitted, all reads are
     * treated as version-less (legacy bare-value behavior).
     */
    version?: number;
    /**
     * Migration callback. Called with the raw decoded data and the previous
     * version (which is `undefined` when the stored value pre-dates versioning).
     * Return the migrated value or `undefined` to fall back to `initialValue`.
     * If it throws the hook also falls back.
     */
    migrate?: (raw: unknown, oldVersion: number | undefined) => T | undefined;
}
/**
 * Persisted state with the shape of `useState`. The first render reads from
 * localStorage; subsequent renders mirror in-memory state. Writes to
 * localStorage happen as a side-effect.
 */
export declare function usePersistedState<T>(key: string, initialValue: T | (() => T), options?: UsePersistedStateOptions<T>): [T, React.Dispatch<React.SetStateAction<T>>, () => void];
/**
 * Lower-level helper for modules that need to read/write localStorage
 * outside the React tree (e.g., the store). Use sparingly — prefer
 * `usePersistedState` in components.
 */
export declare const PersistedStorage: {
    get<T>(key: string, fallback: T): T;
    set<T_1>(key: string, value: T_1): void;
    delete(key: string): void;
    /**
     * Static convenience to wipe a key without needing to mount the hook.
     * Equivalent to `delete` but named for symmetry with the React-level
     * `reset` callback so callers reaching for "clear" find it first.
     */
    clear(key: string): void;
};
//# sourceMappingURL=use-persisted-state.d.ts.map