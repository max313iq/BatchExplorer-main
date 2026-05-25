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

interface Envelope<T> {
  v: number;
  data: T;
}

function isEnvelope<T>(value: unknown): value is Envelope<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "v" in (value as Record<string, unknown>) &&
    "data" in (value as Record<string, unknown>) &&
    typeof (value as Envelope<T>).v === "number"
  );
}

function safeReadRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* quota / permission errors are silently ignored */
  }
}

function safeDelete(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

const defaultDeserialize = <T,>(raw: string): T | undefined => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

const defaultSerialize = <T,>(value: T): string => JSON.stringify(value);

/**
 * Read + (optionally) migrate the stored value. The two-phase decode keeps
 * the inner `deserialize` typed to T while the outer envelope decode is
 * always JSON (because we own the envelope shape).
 */
function readWithMigration<T>(
  key: string,
  fallback: T,
  deserialize: (raw: string) => T | undefined,
  version: number | undefined,
  migrate: ((raw: unknown, old: number | undefined) => T | undefined) | undefined,
): T {
  const raw = safeReadRaw(key);
  if (raw == null) return fallback;

  // First, try to parse the envelope (JSON object with { v, data }). Fall
  // back to treating the raw string as legacy if it's not an object — that
  // gracefully picks up entries written before versioning was introduced.
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    envelope = undefined;
  }

  // No version requested — preserve legacy behavior: parse via the caller's
  // deserialize, no migration.
  if (version === undefined) {
    const parsed = deserialize(raw);
    return parsed === undefined ? fallback : parsed;
  }

  if (isEnvelope<T>(envelope)) {
    if (envelope.v === version) {
      // Same version — deserialize the inner `data`. We re-serialize and
      // pipe through the caller's deserialize for symmetry with writes.
      try {
        const inner = deserialize(JSON.stringify(envelope.data));
        return inner === undefined ? fallback : inner;
      } catch {
        return fallback;
      }
    }
    // Version mismatch — run migrate.
    if (!migrate) return fallback;
    try {
      const migrated = migrate(envelope.data, envelope.v);
      return migrated === undefined ? fallback : migrated;
    } catch {
      return fallback;
    }
  }

  // Stored value isn't an envelope: treat as legacy (pre-versioning) value
  // and pipe it through migrate with `oldVersion = undefined`.
  if (!migrate) {
    const parsed = deserialize(raw);
    return parsed === undefined ? fallback : parsed;
  }
  try {
    // Try to give migrate the parsed value; if that fails, the raw string.
    const decoded = envelope !== undefined ? envelope : deserialize(raw);
    const migrated = migrate(decoded, undefined);
    return migrated === undefined ? fallback : migrated;
  } catch {
    return fallback;
  }
}

/**
 * Persisted state with the shape of `useState`. The first render reads from
 * localStorage; subsequent renders mirror in-memory state. Writes to
 * localStorage happen as a side-effect.
 */
export function usePersistedState<T>(
  key: string,
  initialValue: T | (() => T),
  options: UsePersistedStateOptions<T> = {},
): [T, React.Dispatch<React.SetStateAction<T>>, () => void] {
  const {
    serialize: serializeOption,
    deserialize: deserializeOption,
    syncAcrossTabs = false,
    version,
    migrate,
  } = options;

  // Lock serialize/deserialize to their first-render identity. Callers can
  // pass inline functions without triggering an infinite write loop from
  // the persist effect's dependency array.
  const serializeRef = React.useRef(serializeOption ?? defaultSerialize<T>);
  const deserializeRef = React.useRef(deserializeOption ?? defaultDeserialize<T>);
  const migrateRef = React.useRef(migrate);
  // Allow migrate to refresh between renders — read of a stale closure is
  // worse than reading a stale serializer because migration is one-shot.
  migrateRef.current = migrate;

  const initial = React.useRef<T>(
    typeof initialValue === "function"
      ? (initialValue as () => T)()
      : initialValue,
  );

  const [state, setState] = React.useState<T>(() =>
    readWithMigration<T>(
      key,
      initial.current,
      deserializeRef.current,
      version,
      migrateRef.current,
    ),
  );

  const stateRef = React.useRef(state);
  stateRef.current = state;

  // Skip-next-write latch. `reset()` deletes the storage key, then bumps
  // state to `initial.current`; without this latch the persist effect
  // would immediately re-write the initial value back, defeating the
  // delete. We flip it before each setState that must NOT persist.
  const skipNextWriteRef = React.useRef(false);

  // Persist on change. Versioned writes wrap in the envelope; un-versioned
  // writes preserve the legacy bare-value behavior so existing callers and
  // their custom deserializers keep working without a migration step.
  React.useEffect(() => {
    if (skipNextWriteRef.current) {
      skipNextWriteRef.current = false;
      return;
    }
    const dataJson = serializeRef.current(state);
    if (version === undefined) {
      safeWrite(key, dataJson);
    } else {
      let dataParsed: unknown;
      try {
        dataParsed = JSON.parse(dataJson);
      } catch {
        // Custom serializer returned a non-JSON string — wrap as a string.
        dataParsed = dataJson;
      }
      const envelope: Envelope<unknown> = { v: version, data: dataParsed };
      safeWrite(key, JSON.stringify(envelope));
    }
  }, [key, state, version]);

  // Cross-tab sync.
  React.useEffect(() => {
    if (!syncAcrossTabs || typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key || e.newValue == null) return;
      // For migrations: re-read via the full migrate-aware path so newer
      // schemas hydrate cleanly. For the simple un-versioned path, decode
      // `e.newValue` directly — synthetic StorageEvents in tests may not
      // touch localStorage at all.
      if (version === undefined) {
        const parsed = deserializeRef.current(e.newValue);
        if (parsed !== undefined) {
          // Other-tab write — local already mirrors (storage event fires
          // after the cross-tab localStorage commit). Skip the echo back.
          skipNextWriteRef.current = true;
          setState(parsed);
        }
        return;
      }
      const next = readWithMigration<T>(
        key,
        initial.current,
        deserializeRef.current,
        version,
        migrateRef.current,
      );
      skipNextWriteRef.current = true;
      setState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, syncAcrossTabs, version]);

  // Reset clears the localStorage key and re-applies the initial value.
  // The skip-next-write latch prevents the persist effect from immediately
  // re-writing the initial value back into the just-cleared slot.
  const reset = React.useCallback(() => {
    safeDelete(key);
    skipNextWriteRef.current = true;
    setState(initial.current);
  }, [key]);

  return [state, setState, reset];
}

/**
 * Lower-level helper for modules that need to read/write localStorage
 * outside the React tree (e.g., the store). Use sparingly — prefer
 * `usePersistedState` in components.
 */
export const PersistedStorage = {
  get<T>(key: string, fallback: T): T {
    const raw = safeReadRaw(key);
    if (raw == null) return fallback;
    const parsed = defaultDeserialize<T>(raw);
    return parsed === undefined ? fallback : parsed;
  },
  set<T>(key: string, value: T): void {
    safeWrite(key, defaultSerialize(value));
  },
  delete(key: string): void {
    safeDelete(key);
  },
  /**
   * Static convenience to wipe a key without needing to mount the hook.
   * Equivalent to `delete` but named for symmetry with the React-level
   * `reset` callback so callers reaching for "clear" find it first.
   */
  clear(key: string): void {
    safeDelete(key);
  },
};
