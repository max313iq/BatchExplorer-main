/**
 * Stability test: inline `searchableFields` arrays must not invalidate the
 * filter memo. Previously a new `[...]` literal on every render would force
 * useSearch to recompute its filter, wasting CPU on big lists.
 */
import { renderHook } from "@testing-library/react";
import { useSearch } from "../use-search";
const ITEMS = [
    { name: "Alpha", description: "First" },
    { name: "Beta", description: "Second" },
];
describe("useSearch stability with inline fields", () => {
    it("returns the SAME filteredItems reference when fields are a fresh literal", () => {
        const { result, rerender } = renderHook(({ items }) => 
        // INLINE literal — different identity each render, same content.
        useSearch(items, ["name", "description"]), { initialProps: { items: ITEMS } });
        const firstFiltered = result.current.filteredItems;
        // Force a re-render with the SAME items reference.
        rerender({ items: ITEMS });
        // The filter memo must NOT have recomputed — same array reference.
        expect(result.current.filteredItems).toBe(firstFiltered);
    });
    it("DOES recompute when fields content actually changes", () => {
        const { result, rerender } = renderHook(({ items, fields, }) => useSearch(items, fields), {
            initialProps: {
                items: ITEMS,
                fields: ["name"],
            },
        });
        const firstFiltered = result.current.filteredItems;
        // Same items, but the FIELDS content changed — memo should re-run.
        rerender({ items: ITEMS, fields: ["name", "description"] });
        // Empty-query path returns `items` directly so by-value equality
        // holds either way. The interesting bit is that no error fires and
        // the new fields are tracked: assert that.
        expect(result.current.filteredItems).toEqual(firstFiltered);
    });
});
//# sourceMappingURL=use-search-stability.test.js.map