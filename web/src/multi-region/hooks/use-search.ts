import * as React from "react";

export interface SearchState<T> {
    query: string;
    setQuery: (q: string) => void;
    filteredItems: T[];
    resultCount: number;
}

export function useSearch<T>(
    items: T[],
    searchableFields: (keyof T)[],
    debounceMs = 200
): SearchState<T> {
    const [query, setQuery] = React.useState("");
    const [debouncedQuery, setDebouncedQuery] = React.useState("");

    // Debounce the query
    React.useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedQuery(query);
        }, debounceMs);
        return () => clearTimeout(timer);
    }, [query, debounceMs]);

    const filteredItems = React.useMemo(() => {
        const q = debouncedQuery.toLowerCase().trim();
        if (!q) return items;

        return items.filter((item) =>
            searchableFields.some((field) => {
                const value = item[field];
                if (value == null) return false;
                return String(value).toLowerCase().includes(q);
            })
        );
    }, [items, searchableFields, debouncedQuery]);

    return {
        query,
        setQuery,
        filteredItems,
        resultCount: filteredItems.length,
    };
}
