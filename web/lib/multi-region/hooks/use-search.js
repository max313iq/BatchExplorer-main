import * as React from "react";
/**
 * Debounced client-side search across one or more fields of each item.
 *
 * `searchableFields` may be passed as an inline literal (`["name", "desc"]`)
 * without forcing the memo to re-run every render: the array is fingerprinted
 * by joining its contents into a string, so identical arrays with different
 * identities collapse to the same dependency value.
 */
export function useSearch(items, searchableFields, debounceMs = 200) {
    const [query, setQuery] = React.useState("");
    const [debouncedQuery, setDebouncedQuery] = React.useState("");
    // Debounce the query
    React.useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedQuery(query);
        }, debounceMs);
        return () => clearTimeout(timer);
    }, [query, debounceMs]);
    // Stable signature for `searchableFields` so callers passing inline arrays
    // don't invalidate the filter memo every render. Fields are typed `keyof T`
    // and the only practical types React renders to strings cleanly; join with
    // a delimiter that cannot appear in a JS property name.
    const fieldsKey = searchableFields
        .map((f) => String(f))
        .join("|");
    const stableFields = React.useMemo(() => searchableFields, 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fieldsKey]);
    const filteredItems = React.useMemo(() => {
        const q = debouncedQuery.toLowerCase().trim();
        if (!q)
            return items;
        return items.filter((item) => stableFields.some((field) => {
            const value = item[field];
            if (value == null)
                return false;
            return String(value).toLowerCase().includes(q);
        }));
    }, [items, stableFields, debouncedQuery]);
    return {
        query,
        setQuery,
        filteredItems,
        resultCount: filteredItems.length,
    };
}
//# sourceMappingURL=use-search.js.map