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
/**
 * Two-way URL <-> state sync. Returns the current state and a setter that
 * accepts either a partial update or an updater function.
 */
export declare function useUrlState<T extends UrlStateRecord>(initial: T, options?: UseUrlStateOptions): [T, (next: Partial<T> | ((prev: T) => Partial<T>)) => void];
/**
 * Convenience: bind a single string-typed URL key. Returns `[value, setValue]`
 * where the setter accepts the new string value directly.
 */
export declare function useUrlParam(key: string, initial?: string, options?: UseUrlStateOptions): [string, (next: string) => void];
//# sourceMappingURL=use-url-state.d.ts.map