import * as React from "react";

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

export function usePagination<T>(
    items: T[],
    defaultPageSize = 25
): PaginationState<T> {
    const [page, setPageRaw] = React.useState(1);
    const [pageSize, setPageSizeRaw] = React.useState(defaultPageSize);

    const totalItems = items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

    // Clamp page to valid range when items or pageSize change
    const clampedPage = React.useMemo(() => {
        if (page > totalPages) return totalPages;
        if (page < 1) return 1;
        return page;
    }, [page, totalPages]);

    // Sync internal state when clamped
    React.useEffect(() => {
        if (clampedPage !== page) {
            setPageRaw(clampedPage);
        }
    }, [clampedPage, page]);

    const paginatedItems = React.useMemo(() => {
        const start = (clampedPage - 1) * pageSize;
        return items.slice(start, start + pageSize);
    }, [items, clampedPage, pageSize]);

    const setPage = React.useCallback(
        (p: number) => {
            const clamped = Math.max(1, Math.min(p, totalPages));
            setPageRaw(clamped);
        },
        [totalPages]
    );

    const setPageSize = React.useCallback((size: number) => {
        setPageSizeRaw(size);
        setPageRaw(1);
    }, []);

    const nextPage = React.useCallback(() => {
        setPageRaw((prev) => Math.min(prev + 1, totalPages));
    }, [totalPages]);

    const prevPage = React.useCallback(() => {
        setPageRaw((prev) => Math.max(prev - 1, 1));
    }, []);

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
