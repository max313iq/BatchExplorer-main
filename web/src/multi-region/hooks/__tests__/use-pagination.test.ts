/**
 * Unit tests for use-pagination.ts
 *
 * Covers:
 *   - Empty array, single page (totalPages clamped to >= 1).
 *   - Multiple pages with various page sizes.
 *   - Page clamping when totalPages shrinks (item list rerender).
 *   - setPage clamping (below 1, above totalPages).
 *   - setPageSize resets the page back to 1.
 *   - nextPage / prevPage boundary behavior.
 *   - canNext / canPrev flag transitions.
 */

import { act, renderHook } from "@testing-library/react";
import { usePagination } from "../use-pagination";

describe("usePagination", () => {
    // ------------------------------------------------------------------
    // Empty list / single page
    // ------------------------------------------------------------------

    describe("empty and single-page lists", () => {
        it("returns sensible defaults for an empty array", () => {
            const { result } = renderHook(() => usePagination<number>([], 10));

            expect(result.current.page).toBe(1);
            expect(result.current.pageSize).toBe(10);
            expect(result.current.totalItems).toBe(0);
            // totalPages floors to >= 1 even when empty
            expect(result.current.totalPages).toBe(1);
            expect(result.current.paginatedItems).toEqual([]);
            expect(result.current.canNext).toBe(false);
            expect(result.current.canPrev).toBe(false);
        });

        it("uses the default page size of 25 when not provided", () => {
            const items = Array.from({ length: 10 }, (_, i) => i);
            const { result } = renderHook(() => usePagination(items));

            expect(result.current.pageSize).toBe(25);
            expect(result.current.totalPages).toBe(1);
            expect(result.current.paginatedItems).toEqual(items);
        });

        it("treats a single-page list as a single page", () => {
            const items = [1, 2, 3];
            const { result } = renderHook(() => usePagination(items, 10));

            expect(result.current.totalPages).toBe(1);
            expect(result.current.paginatedItems).toEqual([1, 2, 3]);
            expect(result.current.canNext).toBe(false);
            expect(result.current.canPrev).toBe(false);
        });
    });

    // ------------------------------------------------------------------
    // Multiple pages / different page sizes
    // ------------------------------------------------------------------

    describe("multiple pages and page sizes", () => {
        it("paginates a 25-item list into 3 pages of size 10", () => {
            const items = Array.from({ length: 25 }, (_, i) => i);
            const { result } = renderHook(() => usePagination(items, 10));

            expect(result.current.totalPages).toBe(3);
            expect(result.current.paginatedItems).toEqual([
                0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
            ]);
            expect(result.current.canNext).toBe(true);
            expect(result.current.canPrev).toBe(false);

            act(() => result.current.setPage(2));
            expect(result.current.paginatedItems).toEqual([
                10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
            ]);
            expect(result.current.canNext).toBe(true);
            expect(result.current.canPrev).toBe(true);

            act(() => result.current.setPage(3));
            // Last page is partial (5 items)
            expect(result.current.paginatedItems).toEqual([
                20, 21, 22, 23, 24,
            ]);
            expect(result.current.canNext).toBe(false);
            expect(result.current.canPrev).toBe(true);
        });

        it("works with page size 1", () => {
            const items = ["a", "b", "c"];
            const { result } = renderHook(() => usePagination(items, 1));

            expect(result.current.totalPages).toBe(3);
            expect(result.current.paginatedItems).toEqual(["a"]);

            act(() => result.current.nextPage());
            expect(result.current.paginatedItems).toEqual(["b"]);
        });

        it("works when items count is an exact multiple of pageSize", () => {
            const items = Array.from({ length: 20 }, (_, i) => i);
            const { result } = renderHook(() => usePagination(items, 5));

            expect(result.current.totalPages).toBe(4);
            act(() => result.current.setPage(4));
            expect(result.current.paginatedItems).toEqual([15, 16, 17, 18, 19]);
        });
    });

    // ------------------------------------------------------------------
    // setPage clamping
    // ------------------------------------------------------------------

    describe("setPage clamping", () => {
        it("clamps below 1 to 1", () => {
            const items = Array.from({ length: 30 }, (_, i) => i);
            const { result } = renderHook(() => usePagination(items, 10));

            act(() => result.current.setPage(0));
            expect(result.current.page).toBe(1);

            act(() => result.current.setPage(-5));
            expect(result.current.page).toBe(1);
        });

        it("clamps above totalPages to totalPages", () => {
            const items = Array.from({ length: 30 }, (_, i) => i);
            const { result } = renderHook(() => usePagination(items, 10));

            act(() => result.current.setPage(99));
            expect(result.current.page).toBe(3);
        });
    });

    // ------------------------------------------------------------------
    // setPageSize resets to page 1
    // ------------------------------------------------------------------

    describe("setPageSize", () => {
        it("resets page to 1 and updates totalPages", () => {
            const items = Array.from({ length: 30 }, (_, i) => i);
            const { result } = renderHook(() => usePagination(items, 10));

            act(() => result.current.setPage(3));
            expect(result.current.page).toBe(3);

            act(() => result.current.setPageSize(5));
            expect(result.current.pageSize).toBe(5);
            expect(result.current.page).toBe(1);
            expect(result.current.totalPages).toBe(6);
            expect(result.current.paginatedItems).toEqual([0, 1, 2, 3, 4]);
        });
    });

    // ------------------------------------------------------------------
    // nextPage / prevPage boundaries
    // ------------------------------------------------------------------

    describe("nextPage and prevPage", () => {
        it("nextPage advances and stops at the last page", () => {
            const items = Array.from({ length: 12 }, (_, i) => i);
            const { result } = renderHook(() => usePagination(items, 5));

            expect(result.current.totalPages).toBe(3);
            expect(result.current.page).toBe(1);

            act(() => result.current.nextPage());
            expect(result.current.page).toBe(2);

            act(() => result.current.nextPage());
            expect(result.current.page).toBe(3);

            // Calling next at the last page must not exceed totalPages.
            act(() => result.current.nextPage());
            expect(result.current.page).toBe(3);
            expect(result.current.canNext).toBe(false);
        });

        it("prevPage retreats and stops at page 1", () => {
            const items = Array.from({ length: 12 }, (_, i) => i);
            const { result } = renderHook(() => usePagination(items, 5));

            act(() => result.current.setPage(3));
            expect(result.current.page).toBe(3);

            act(() => result.current.prevPage());
            expect(result.current.page).toBe(2);

            act(() => result.current.prevPage());
            expect(result.current.page).toBe(1);

            // Calling prev at page 1 must not go below 1.
            act(() => result.current.prevPage());
            expect(result.current.page).toBe(1);
            expect(result.current.canPrev).toBe(false);
        });
    });

    // ------------------------------------------------------------------
    // Page clamping when underlying items shrink
    // ------------------------------------------------------------------

    describe("clamping when totalPages shrinks", () => {
        it("clamps page down when items list shrinks below current page", () => {
            const initial = Array.from({ length: 30 }, (_, i) => i);
            const { result, rerender } = renderHook(
                ({ items }: { items: number[] }) => usePagination(items, 10),
                { initialProps: { items: initial } },
            );

            act(() => result.current.setPage(3));
            expect(result.current.page).toBe(3);

            // Shrink the list: now only 1 page exists.
            rerender({ items: [1, 2, 3] });
            expect(result.current.totalPages).toBe(1);
            expect(result.current.page).toBe(1);
            expect(result.current.paginatedItems).toEqual([1, 2, 3]);
        });

        it("returns the correct slice on the new last page after shrink", () => {
            const initial = Array.from({ length: 50 }, (_, i) => i);
            const { result, rerender } = renderHook(
                ({ items }: { items: number[] }) => usePagination(items, 10),
                { initialProps: { items: initial } },
            );

            act(() => result.current.setPage(5));
            expect(result.current.paginatedItems).toEqual([
                40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
            ]);

            // Now drop to 25 items: totalPages becomes 3, current page clamps.
            const shrunk = Array.from({ length: 25 }, (_, i) => i);
            rerender({ items: shrunk });
            expect(result.current.totalPages).toBe(3);
            expect(result.current.page).toBe(3);
            expect(result.current.paginatedItems).toEqual([20, 21, 22, 23, 24]);
        });
    });
});
