export interface SearchState<T> {
    query: string;
    setQuery: (q: string) => void;
    filteredItems: T[];
    resultCount: number;
}
/**
 * Debounced client-side search across one or more fields of each item.
 *
 * `searchableFields` may be passed as an inline literal (`["name", "desc"]`)
 * without forcing the memo to re-run every render: the array is fingerprinted
 * by joining its contents into a string, so identical arrays with different
 * identities collapse to the same dependency value.
 */
export declare function useSearch<T>(items: T[], searchableFields: (keyof T)[], debounceMs?: number): SearchState<T>;
//# sourceMappingURL=use-search.d.ts.map