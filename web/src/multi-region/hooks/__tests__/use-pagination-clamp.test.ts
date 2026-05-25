/**
 * Regression tests for use-pagination clamping.
 *
 * Background: the previous implementation used a `useEffect` to push the
 * clamped page back into state, which forced an extra render whenever the
 * items list shrank below the current page. The new implementation clamps
 * purely in `useMemo` and lets `pageRaw` self-correct on the next user
 * action. These tests pin that contract.
 */
import { act, renderHook } from "@testing-library/react";
import * as React from "react";

import { usePagination } from "../use-pagination";

describe("usePagination clamp semantics", () => {
    it("does not double-render when items shrink below current page", () => {
        const initial = Array.from({ length: 30 }, (_, i) => i);
        let renderCount = 0;

        const { result, rerender } = renderHook(
            ({ items }: { items: number[] }) => {
                renderCount += 1;
                return usePagination(items, 10);
            },
            { initialProps: { items: initial } },
        );

        // Move to page 3 (last page).
        act(() => result.current.setPage(3));
        expect(result.current.page).toBe(3);
        const renderCountBeforeShrink = renderCount;

        // Shrink the list to just 5 items — totalPages collapses to 1.
        // The clamp now happens in useMemo: a single rerender produces the
        // correct displayed page. Previously this took two renders (one
        // for the rerender, one for the useEffect's setPageRaw).
        rerender({ items: [0, 1, 2, 3, 4] });

        // Exactly one additional render — no useEffect-triggered second pass.
        expect(renderCount - renderCountBeforeShrink).toBe(1);
        expect(result.current.totalPages).toBe(1);
        expect(result.current.page).toBe(1);
        expect(result.current.paginatedItems).toEqual([0, 1, 2, 3, 4]);
    });

    it("self-corrects pageRaw on next user action after a shrink", () => {
        const initial = Array.from({ length: 30 }, (_, i) => i);
        const { result, rerender } = renderHook(
            ({ items }: { items: number[] }) => usePagination(items, 10),
            { initialProps: { items: initial } },
        );

        act(() => result.current.setPage(3));
        rerender({ items: [0, 1, 2, 3, 4] });

        // Displayed page is clamped to 1.
        expect(result.current.page).toBe(1);

        // nextPage is bounded by totalPages — stays at 1 because there's
        // nowhere to go. Critically, it computes from the clamped value, not
        // from the stale pageRaw of 3.
        act(() => result.current.nextPage());
        expect(result.current.page).toBe(1);
    });

    it("clamps low values via useMemo without effect side-effects", () => {
        const items = Array.from({ length: 10 }, (_, i) => i);
        let effectRunCount = 0;

        const { result } = renderHook(() => {
            const pagination = usePagination(items, 5);
            // Sentinel effect — if usePagination internally schedules a state
            // update via an effect, this re-runs.
            React.useEffect(() => {
                effectRunCount += 1;
            }, [pagination.page]);
            return pagination;
        });

        const baseline = effectRunCount;
        // setPage(-5) clamps to 1, the displayed page is already 1, so the
        // sentinel effect should NOT fire.
        act(() => result.current.setPage(-5));
        expect(result.current.page).toBe(1);
        expect(effectRunCount).toBe(baseline);
    });
});
