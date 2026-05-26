import * as React from "react";
/**
 * Stateful client-side pagination.
 *
 * Semantics:
 *   - `page` returned from this hook is ALWAYS clamped to [1, totalPages]
 *     via `useMemo`. Callers read it as the "currently displayed page".
 *   - The internal `pageRaw` may be stale (e.g. user was on page 5 then the
 *     items list shrank to one page) but that's intentional — the clamped
 *     value is what consumers see, and `pageRaw` self-corrects on the next
 *     user action (`setPage`, `nextPage`, `prevPage`, or `setPageSize`).
 *   - This avoids the double-render that would result from a clamp-on-effect.
 *     Display is always correct on the first render after items shrink.
 */
export function usePagination(items, defaultPageSize = 25) {
    const [pageRaw, setPageRaw] = React.useState(1);
    const [pageSize, setPageSizeRaw] = React.useState(defaultPageSize);
    const totalItems = items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    // Clamp the displayed page. The internal `pageRaw` is intentionally NOT
    // synced — it'll self-correct on the next user action. See JSDoc above.
    const clampedPage = React.useMemo(() => {
        if (pageRaw > totalPages)
            return totalPages;
        if (pageRaw < 1)
            return 1;
        return pageRaw;
    }, [pageRaw, totalPages]);
    const paginatedItems = React.useMemo(() => {
        const start = (clampedPage - 1) * pageSize;
        return items.slice(start, start + pageSize);
    }, [items, clampedPage, pageSize]);
    const setPage = React.useCallback((p) => {
        const clamped = Math.max(1, Math.min(p, totalPages));
        setPageRaw(clamped);
    }, [totalPages]);
    const setPageSize = React.useCallback((size) => {
        setPageSizeRaw(size);
        setPageRaw(1);
    }, []);
    const nextPage = React.useCallback(() => {
        setPageRaw((prev) => {
            // Use the clamped value as the basis so a stale `prev` after a shrink
            // doesn't jump past totalPages-1 → totalPages instead of 1 → 2.
            const base = Math.max(1, Math.min(prev, totalPages));
            return Math.min(base + 1, totalPages);
        });
    }, [totalPages]);
    const prevPage = React.useCallback(() => {
        setPageRaw((prev) => {
            const base = Math.max(1, Math.min(prev, totalPages));
            return Math.max(base - 1, 1);
        });
    }, [totalPages]);
    return {
        page: clampedPage,
        pageSize,
        totalItems,
        totalPages,
        paginatedItems,
        setPage,
        setPageSize,
        nextPage,
        prevPage,
        canNext: clampedPage < totalPages,
        canPrev: clampedPage > 1,
    };
}
//# sourceMappingURL=use-pagination.js.map