export interface PaginationState<T> {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    paginatedItems: T[];
    setPage: (page: number) => void;
    setPageSize: (size: number) => void;
    nextPage: () => void;
    prevPage: () => void;
    canNext: boolean;
    canPrev: boolean;
}
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
export declare function usePagination<T>(items: T[], defaultPageSize?: number): PaginationState<T>;
//# sourceMappingURL=use-pagination.d.ts.map