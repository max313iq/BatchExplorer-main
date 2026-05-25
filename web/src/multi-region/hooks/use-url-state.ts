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

export type UrlStateValue = string | string[] | undefined;
export type UrlStateRecord = Record<string, UrlStateValue>;

export interface UseUrlStateOptions {
  /**
   * Whether to push (default) or replace history entries when state changes.
   * Replace is appropriate for filter inputs where typing should not pollute
   * browser history.
   */
  replace?: boolean;
  /**
   * Optional list of keys this hook is responsible for. Other URL params are
   * left untouched. Default: only the keys present in the initial state.
   */
  keys?: string[];
  /**
   * Optional serializer for non-string values. Default uses per-element
   * `encodeURIComponent` + comma join for arrays and `String()` for scalars.
   */
  serialize?: (value: unknown) => string;
  /**
   * Optional deserializer mirroring `serialize`. Default treats commas as
   * array delimiters when the initial state value is an array, then runs
   * `decodeURIComponent` on each element.
   */
  deserialize?: (raw: string, key: string) => UrlStateValue;
}

const ARRAY_DELIM = ",";

function defaultSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    // Per-element encode so a value containing "," round-trips without
    // collapsing into adjacent elements.
    return value.map((v) => encodeURIComponent(String(v))).join(ARRAY_DELIM);
  }
  if (value == null) return "";
  return String(value);
}

function defaultDeserialize(
  raw: string,
  isArrayKey: boolean,
): UrlStateValue {
  if (isArrayKey) {
    if (raw === "") return [];
    return raw.split(ARRAY_DELIM).map((v) => {
      try {
        return decodeURIComponent(v);
      } catch {
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
export function useUrlState<T extends UrlStateRecord>(
  initial: T,
  options: UseUrlStateOptions = {},
): [T, (next: Partial<T> | ((prev: T) => Partial<T>)) => void] {
  const { replace = true, keys, serialize, deserialize } = options;
  const [searchParams, setSearchParams] = useSearchParams();

  // Snapshot `initial` once. Per the contract above, callers must treat it
  // as render-stable; we deliberately do NOT track changes to it so that an
  // inline object literal in the caller doesn't invalidate memos every render.
  const initialRef = React.useRef<T>(initial);

  // Same treatment for `keys` — fingerprint by content so an inline literal
  // doesn't trigger a re-compute every render.
  const keysKey = keys ? keys.join("|") : "<from-initial>";
  const ownedKeys = React.useMemo(
    () => keys ?? Object.keys(initialRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keysKey],
  );

  const arrayKeys = React.useMemo(() => {
    const set = new Set<string>();
    for (const k of Object.keys(initialRef.current)) {
      if (Array.isArray(initialRef.current[k])) set.add(k);
    }
    return set;
  }, []);

  // Read current state from URL, falling back to initial values.
  const state = React.useMemo<T>(() => {
    const next: UrlStateRecord = { ...initialRef.current };
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
    return next as T;
  }, [searchParams, ownedKeys, arrayKeys, deserialize]);

  const stateRef = React.useRef(state);
  stateRef.current = state;

  // Setter — applies partial update + reconciles with URL.
  const setState = React.useCallback(
    (next: Partial<T> | ((prev: T) => Partial<T>)) => {
      setSearchParams(
        (prev) => {
          const candidate =
            typeof next === "function" ? next(stateRef.current) : next;
          const nextParams = new URLSearchParams(prev);

          for (const [key, value] of Object.entries(candidate)) {
            if (!ownedKeys.includes(key)) continue;

            const empty =
              value == null ||
              value === "" ||
              (Array.isArray(value) && value.length === 0);

            if (empty) {
              nextParams.delete(key);
            } else {
              const encoded = serialize ? serialize(value) : defaultSerialize(value);
              if (encoded === "") {
                nextParams.delete(key);
              } else {
                nextParams.set(key, encoded);
              }
            }
          }
          return nextParams;
        },
        { replace },
      );
    },
    [setSearchParams, ownedKeys, replace, serialize],
  );

  return [state, setState];
}

/**
 * Convenience: bind a single string-typed URL key. Returns `[value, setValue]`
 * where the setter accepts the new string value directly.
 */
export function useUrlParam(
  key: string,
  initial = "",
  options: UseUrlStateOptions = {},
): [string, (next: string) => void] {
  const [state, setState] = useUrlState({ [key]: initial }, options);
  const setValue = React.useCallback(
    (next: string) => setState({ [key]: next } as Partial<Record<string, string>>),
    [setState, key],
  );
  return [(state[key] as string) ?? "", setValue];
}
