/**
 * The `initial` parameter to useUrlState is treated as render-stable. This
 * test pins that contract: passing a fresh `{}` literal each render does
 * NOT invalidate the read memo or cause the URL to be rewritten.
 */
import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { useUrlState } from "../use-url-state";

function makeWrapper(initialEntries: string[] = ["/"]) {
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return React.createElement(MemoryRouter, { initialEntries }, children);
    };
}

describe("useUrlState — initial is render-stable", () => {
    it("does not invalidate state when caller passes a fresh literal each render", () => {
        const { result, rerender } = renderHook(
            () => {
                // INLINE literal: a new object every render.
                const [state, setState] = useUrlState({
                    q: "default",
                    page: "1",
                });
                const location = useLocation();
                return { state, setState, search: location.search };
            },
            { wrapper: makeWrapper(["/?q=hello"]) },
        );

        const firstState = result.current.state;
        expect(firstState).toEqual({ q: "hello", page: "1" });

        // Re-render with no other change.
        rerender();

        // Same state object reference — proving the read memo wasn't
        // recomputed despite `initial` being a fresh literal.
        expect(result.current.state).toBe(firstState);
    });

    it("snapshots the initial shape once and ignores later mutations", () => {
        // Mutate the literal between renders — the hook must NOT pick that up.
        const initial: { q: string; n?: string } = { q: "x" };

        const { result, rerender } = renderHook(
            ({ init }: { init: { q: string; n?: string } }) => useUrlState(init),
            { initialProps: { init: initial }, wrapper: makeWrapper(["/"]) },
        );

        expect(result.current[0]).toEqual({ q: "x" });

        // Mutate the original object (which is what the caller might do
        // accidentally) — the hook should still display the snapshot.
        initial.n = "new-key";
        rerender({ init: initial });

        // `n` was NOT in the initial snapshot, so it must NOT appear here.
        expect((result.current[0] as Record<string, unknown>).n).toBeUndefined();
    });

    it("array values containing commas survive round-trip", () => {
        const { result } = renderHook(
            () => useUrlState({ tags: [] as string[] }),
            { wrapper: makeWrapper(["/"]) },
        );

        // A tag literally containing a comma is the regression case.
        act(() => {
            result.current[1]({ tags: ["red,fish", "blue"] });
        });

        expect(result.current[0].tags).toEqual(["red,fish", "blue"]);
    });
});
