/**
 * useUrlState — sync component state with URL search params so deep links
 * preserve filter state. Per Design Contract §4.3.
 *
 * The state shape is a flat record of strings (or string arrays). Empty
 * values are stripped from the URL. The hook reads from `useSearchParams`
 * on mount and updates it whenever the local state changes.
 *
 * ## Contract
 *
 * - `initial` is treated as **render-stable**. It's snapshotted on the
 *   first render via `useRef` and changes to the literal you pass on later
 *   renders are ignored. If you need to change the schema, unmount and
 *   remount the hook. This avoids invalidating memos every render when a
 *   caller passes an inline literal.
 * - `keys` is fingerprinted by its joined contents so an inline array is
 *   safe to pass.
 * - Array values are encoded as comma-separated per-element
 *   `encodeURIComponent` so values containing `,` round-trip correctly.
 */
import * as React from "react";
import { useSearchParams } from "react-router-dom";
const ARRAY_DELIM = ",";
function defaultSerialize(value) {
    if (Array.isArray(value)) {
        // Per-element encode so a value containing "," round-trips without
        // collapsing into adjacent elements.
        return value.map((v) => encodeURIComponent(String(v))).join(ARRAY_DELIM);
    }
    if (value == null)
        return "";
    return String(value);
}
function defaultDeserialize(raw, isArrayKey) {
    if (isArrayKey) {
        if (raw === "")
            return [];
        return raw.split(ARRAY_DELIM).map((v) => {
            try {
                return decodeURIComponent(v);
            }
            catch (_a) {
                // Malformed escape (e.g. lone `%` from a hand-edited URL) — keep raw.
                return v;
            }
        });
    }
    return raw;
}
/**
 * Two-way URL <-> state sync. Returns the current state and a setter that
 * accepts either a partial update or an updater function.
 */
export function useUrlState(initial, options = {}) {
    const { replace = true, keys, serialize, deserialize } = options;
    const [searchParams, setSearchParams] = useSearchParams();
    // Snapshot `initial` once. Per the contract above, callers must treat it
    // as render-stable; we deliberately do NOT track changes to it so that an
    // inline object literal in the caller doesn't invalidate memos every render.
    const initialRef = React.useRef(initial);
    // Same treatment for `keys` — fingerprint by content so an inline literal
    // doesn't trigger a re-compute every render.
    const keysKey = keys ? keys.join("|") : "<from-initial>";
    const ownedKeys = React.useMemo(() => keys !== null && keys !== void 0 ? keys : Object.keys(initialRef.current), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keysKey]);
    const arrayKeys = React.useMemo(() => {
        const set = new Set();
        for (const k of Object.keys(initialRef.current)) {
            if (Array.isArray(initialRef.current[k]))
                set.add(k);
        }
        return set;
    }, []);
    // Read current state from URL, falling back to initial values.
    const state = React.useMemo(() => {
        const next = Object.assign({}, initialRef.current);
        for (const key of ownedKeys) {
            const raw = searchParams.get(key);
            if (raw == null) {
                // Keep initial value
                continue;
            }
            const isArrayKey = arrayKeys.has(key);
            next[key] = deserialize
                ? deserialize(raw, key)
                : defaultDeserialize(raw, isArrayKey);
        }
        return next;
    }, [searchParams, ownedKeys, arrayKeys, deserialize]);
    const stateRef = React.useRef(state);
    stateRef.current = state;
    // Setter — applies partial update + reconciles with URL.
    const setState = React.useCallback((next) => {
        setSearchParams((prev) => {
            const candidate = typeof next === "function" ? next(stateRef.current) : next;
            const nextParams = new URLSearchParams(prev);
            for (const [key, value] of Object.entries(candidate)) {
                if (!ownedKeys.includes(key))
                    continue;
                const empty = value == null ||
                    value === "" ||
                    (Array.isArray(value) && value.length === 0);
                if (empty) {
                    nextParams.delete(key);
                }
                else {
                    const encoded = serialize ? serialize(value) : defaultSerialize(value);
                    if (encoded === "") {
                        nextParams.delete(key);
                    }
                    else {
                        nextParams.set(key, encoded);
                    }
                }
            }
            return nextParams;
        }, { replace });
    }, [setSearchParams, ownedKeys, replace, serialize]);
    return [state, setState];
}
/**
 * Convenience: bind a single string-typed URL key. Returns `[value, setValue]`
 * where the setter accepts the new string value directly.
 */
export function useUrlParam(key, initial = "", options = {}) {
    var _a;
    const [state, setState] = useUrlState({ [key]: initial }, options);
    const setValue = React.useCallback((next) => setState({ [key]: next }), [setState, key]);
    return [(_a = state[key]) !== null && _a !== void 0 ? _a : "", setValue];
}
//# sourceMappingURL=use-url-state.js.map