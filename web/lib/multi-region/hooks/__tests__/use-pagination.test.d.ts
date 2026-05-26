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
export {};
//# sourceMappingURL=use-pagination.test.d.ts.map