import { act, renderHook } from "@testing-library/react";
import { useSearch } from "../use-search";

interface Item {
    name: string;
    description: string | null;
    tag?: string;
}

const ITEMS: Item[] = [
    { name: "Alpha", description: "First item", tag: "primary" },
    { name: "Beta", description: "Second item", tag: "secondary" },
    { name: "Gamma", description: null, tag: undefined },
    { name: "Delta", description: "Fourth ALPHA mention", tag: "tertiary" },
];

const FIELDS: (keyof Item)[] = ["name", "description", "tag"];

describe("useSearch", () => {
    describe("without fake timers", () => {
        it("returns the full list when query is empty", () => {
            const { result } = renderHook(() => useSearch(ITEMS, FIELDS));
            expect(result.current.query).toBe("");
            expect(result.current.filteredItems).toEqual(ITEMS);
            expect(result.current.resultCount).toBe(ITEMS.length);
        });

        it("does not crash on items with null/undefined fields", () => {
            const { result } = renderHook(() => useSearch(ITEMS, FIELDS));
            // Empty query path still includes the item with nulls
            expect(result.current.filteredItems).toContainEqual(ITEMS[2]);
        });
    });

    describe("with fake timers", () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it("debounces query updates - filteredItems unchanged before timer fires", () => {
            const { result } = renderHook(() => useSearch(ITEMS, FIELDS, 200));

            act(() => {
                result.current.setQuery("Alpha");
            });

            // Query updates synchronously, but filteredItems should still be the
            // full list because the debounce timer has not fired yet.
            expect(result.current.query).toBe("Alpha");
            expect(result.current.filteredItems).toEqual(ITEMS);

            // Advance partway - still no update
            act(() => {
                jest.advanceTimersByTime(199);
            });
            expect(result.current.filteredItems).toEqual(ITEMS);

            // Cross the threshold - the debounced query should now apply
            act(() => {
                jest.advanceTimersByTime(1);
            });
            expect(result.current.filteredItems).toEqual([
                ITEMS[0],
                ITEMS[3],
            ]);
            expect(result.current.resultCount).toBe(2);
        });

        it("matches on each searchable field", () => {
            const { result } = renderHook(() => useSearch(ITEMS, FIELDS, 100));

            // name match
            act(() => {
                result.current.setQuery("Beta");
            });
            act(() => {
                jest.advanceTimersByTime(100);
            });
            expect(result.current.filteredItems).toEqual([ITEMS[1]]);

            // description match
            act(() => {
                result.current.setQuery("Second");
            });
            act(() => {
                jest.advanceTimersByTime(100);
            });
            expect(result.current.filteredItems).toEqual([ITEMS[1]]);

            // tag match
            act(() => {
                result.current.setQuery("tertiary");
            });
            act(() => {
                jest.advanceTimersByTime(100);
            });
            expect(result.current.filteredItems).toEqual([ITEMS[3]]);
        });

        it("matches case-insensitively", () => {
            const { result } = renderHook(() => useSearch(ITEMS, FIELDS, 50));

            act(() => {
                result.current.setQuery("ALPHA");
            });
            act(() => {
                jest.advanceTimersByTime(50);
            });
            expect(result.current.filteredItems).toEqual([
                ITEMS[0],
                ITEMS[3],
            ]);

            act(() => {
                result.current.setQuery("alpha");
            });
            act(() => {
                jest.advanceTimersByTime(50);
            });
            expect(result.current.filteredItems).toEqual([
                ITEMS[0],
                ITEMS[3],
            ]);
        });

        it("trims whitespace from the query", () => {
            const { result } = renderHook(() => useSearch(ITEMS, FIELDS, 50));

            act(() => {
                result.current.setQuery("   ");
            });
            act(() => {
                jest.advanceTimersByTime(50);
            });
            // All-whitespace query collapses to empty -> full list
            expect(result.current.filteredItems).toEqual(ITEMS);

            act(() => {
                result.current.setQuery("  Beta  ");
            });
            act(() => {
                jest.advanceTimersByTime(50);
            });
            expect(result.current.filteredItems).toEqual([ITEMS[1]]);
        });

        it("skips items where the field value is null or undefined", () => {
            const { result } = renderHook(() => useSearch(ITEMS, FIELDS, 50));

            // Gamma has description: null and tag: undefined; searching for
            // a substring that does not appear in its name should not match.
            act(() => {
                result.current.setQuery("First");
            });
            act(() => {
                jest.advanceTimersByTime(50);
            });
            expect(result.current.filteredItems).toEqual([ITEMS[0]]);
            expect(result.current.filteredItems).not.toContainEqual(ITEMS[2]);

            // But searching for "Gamma" itself still finds the item via the
            // non-null name field, proving null fields are skipped not fatal.
            act(() => {
                result.current.setQuery("Gamma");
            });
            act(() => {
                jest.advanceTimersByTime(50);
            });
            expect(result.current.filteredItems).toEqual([ITEMS[2]]);
        });
    });
});
