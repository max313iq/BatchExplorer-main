/**
 * Unit tests for use-url-state.ts
 *
 * Covers:
 *   - Initial values returned when URL has no params.
 *   - Round-trip: setting state -> URL search params -> reading state.
 *   - Empty / null / undefined / [] values stripped from URL.
 *   - Array values serialized via the comma delimiter.
 *   - `keys` option restricts which params are managed.
 *   - Custom serialize / deserialize hooks.
 *   - `useUrlParam` convenience wrapper.
 *   - Updater function form: setState(prev => ...).
 *   - `replace` flag forwarded to setSearchParams (default true).
 */
import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useUrlState, useUrlParam } from "../use-url-state";
function makeWrapper(initialEntries = ["/"]) {
    return function Wrapper({ children }) {
        return React.createElement(MemoryRouter, { initialEntries }, children);
    };
}
function useHarness(initial, options) {
    const [state, setState] = useUrlState(initial, options);
    const location = useLocation();
    return {
        state: state,
        setState,
        search: location.search,
    };
}
describe("useUrlState", () => {
    // ----------------------------------------------------------------------
    // Initial values
    // ----------------------------------------------------------------------
    describe("initial values", () => {
        it("returns initial values when the URL has no params", () => {
            const { result } = renderHook(() => useHarness({ q: "", page: "1", tags: [] }), { wrapper: makeWrapper(["/"]) });
            expect(result.current.state).toEqual({
                q: "",
                page: "1",
                tags: [],
            });
            expect(result.current.search).toBe("");
        });
        it("reads existing params from the URL on mount", () => {
            const { result } = renderHook(() => useHarness({ q: "", page: "1" }), { wrapper: makeWrapper(["/?q=hello&page=3"]) });
            expect(result.current.state).toEqual({ q: "hello", page: "3" });
        });
        it("falls back to initial values for keys missing from the URL", () => {
            const { result } = renderHook(() => useHarness({ q: "default", page: "1" }), { wrapper: makeWrapper(["/?q=hello"]) });
            expect(result.current.state).toEqual({
                q: "hello",
                page: "1",
            });
        });
        it("deserializes array values from comma-delimited strings on mount", () => {
            const { result } = renderHook(() => useHarness({ tags: [] }), { wrapper: makeWrapper(["/?tags=a,b,c"]) });
            expect(result.current.state.tags).toEqual(["a", "b", "c"]);
        });
        it("deserializes empty array URL value as []", () => {
            const { result } = renderHook(() => useHarness({ tags: [] }), { wrapper: makeWrapper(["/?tags="]) });
            expect(result.current.state.tags).toEqual([]);
        });
    });
    // ----------------------------------------------------------------------
    // Round trip: state -> URL -> state
    // ----------------------------------------------------------------------
    describe("round trip", () => {
        it("writes scalar values to the URL and reads them back", () => {
            const { result } = renderHook(() => useHarness({ q: "", page: "1" }), { wrapper: makeWrapper(["/"]) });
            act(() => {
                result.current.setState({ q: "search", page: "2" });
            });
            expect(result.current.search).toContain("q=search");
            expect(result.current.search).toContain("page=2");
            expect(result.current.state).toEqual({
                q: "search",
                page: "2",
            });
        });
        it("preserves URL params not owned by the hook", () => {
            const { result } = renderHook(() => useHarness({ q: "" }), { wrapper: makeWrapper(["/?other=keep"]) });
            act(() => {
                result.current.setState({ q: "hello" });
            });
            const params = new URLSearchParams(result.current.search);
            expect(params.get("other")).toBe("keep");
            expect(params.get("q")).toBe("hello");
        });
    });
    // ----------------------------------------------------------------------
    // Empty stripping
    // ----------------------------------------------------------------------
    describe("empty value stripping", () => {
        it("removes a key when value is empty string", () => {
            const { result } = renderHook(() => useHarness({ q: "" }), { wrapper: makeWrapper(["/?q=hello"]) });
            act(() => {
                result.current.setState({ q: "" });
            });
            expect(result.current.search).toBe("");
        });
        it("removes a key when value is undefined", () => {
            const { result } = renderHook(() => useHarness({ q: "" }), { wrapper: makeWrapper(["/?q=hello"]) });
            act(() => {
                result.current.setState({ q: undefined });
            });
            expect(result.current.search).toBe("");
        });
        it("removes a key when value is an empty array", () => {
            const { result } = renderHook(() => useHarness({ tags: [] }), { wrapper: makeWrapper(["/?tags=a,b"]) });
            act(() => {
                result.current.setState({ tags: [] });
            });
            expect(result.current.search).toBe("");
        });
        it("removes a key when serializer returns empty string", () => {
            const { result } = renderHook(() => useHarness({ q: "" }, { serialize: () => "" }), { wrapper: makeWrapper(["/?q=hi"]) });
            act(() => {
                result.current.setState({ q: "anything" });
            });
            expect(result.current.search).toBe("");
        });
    });
    // ----------------------------------------------------------------------
    // Arrays
    // ----------------------------------------------------------------------
    describe("array values", () => {
        it("serializes arrays as comma-delimited strings", () => {
            const { result } = renderHook(() => useHarness({ tags: [] }), { wrapper: makeWrapper(["/"]) });
            act(() => {
                result.current.setState({ tags: ["a", "b", "c"] });
            });
            const params = new URLSearchParams(result.current.search);
            expect(params.get("tags")).toBe("a,b,c");
            expect(result.current.state.tags).toEqual(["a", "b", "c"]);
        });
        it("round-trips a single-element array", () => {
            const { result } = renderHook(() => useHarness({ tags: [] }), { wrapper: makeWrapper(["/"]) });
            act(() => {
                result.current.setState({ tags: ["only"] });
            });
            expect(result.current.state.tags).toEqual(["only"]);
        });
    });
    // ----------------------------------------------------------------------
    // keys option
    // ----------------------------------------------------------------------
    describe("keys option", () => {
        it("only reads keys listed in the `keys` option", () => {
            const { result } = renderHook(() => useHarness({ q: "default", page: "1" }, { keys: ["q"] }), { wrapper: makeWrapper(["/?q=hello&page=5"]) });
            // page is in URL but NOT in the owned keys, so it falls back
            expect(result.current.state.q).toBe("hello");
            expect(result.current.state.page).toBe("1");
        });
        it("ignores writes for keys not in the `keys` option", () => {
            const { result } = renderHook(() => useHarness({ q: "", page: "1" }, { keys: ["q"] }), { wrapper: makeWrapper(["/"]) });
            act(() => {
                result.current.setState({ q: "yes", page: "9" });
            });
            const params = new URLSearchParams(result.current.search);
            expect(params.get("q")).toBe("yes");
            expect(params.has("page")).toBe(false);
        });
    });
    // ----------------------------------------------------------------------
    // Custom serialize / deserialize
    // ----------------------------------------------------------------------
    describe("custom serialize / deserialize", () => {
        it("uses a custom serializer when writing to the URL", () => {
            const serialize = jest.fn((v) => `S:${String(v)}`);
            const { result } = renderHook(() => useHarness({ q: "" }, { serialize }), { wrapper: makeWrapper(["/"]) });
            act(() => {
                result.current.setState({ q: "raw" });
            });
            expect(serialize).toHaveBeenCalledWith("raw");
            const params = new URLSearchParams(result.current.search);
            expect(params.get("q")).toBe("S:raw");
        });
        it("uses a custom deserializer when reading from the URL", () => {
            const deserialize = jest.fn((raw, key) => `D[${key}]:${raw}`);
            const { result } = renderHook(() => useHarness({ q: "" }, { deserialize }), { wrapper: makeWrapper(["/?q=raw"]) });
            expect(deserialize).toHaveBeenCalledWith("raw", "q");
            expect(result.current.state.q).toBe("D[q]:raw");
        });
    });
    // ----------------------------------------------------------------------
    // Updater function
    // ----------------------------------------------------------------------
    describe("updater function", () => {
        it("supports setState(prev => ...) form", () => {
            const { result } = renderHook(() => useHarness({ count: "1" }), { wrapper: makeWrapper(["/"]) });
            act(() => {
                result.current.setState((prev) => ({
                    count: String(parseInt(prev.count, 10) + 1),
                }));
            });
            expect(result.current.state.count).toBe("2");
            act(() => {
                result.current.setState((prev) => ({
                    count: String(parseInt(prev.count, 10) + 5),
                }));
            });
            expect(result.current.state.count).toBe("7");
        });
    });
    // ----------------------------------------------------------------------
    // Replace vs push (default replace=true). We can only observe behavior
    // indirectly via the search string here, but we exercise both code paths.
    // ----------------------------------------------------------------------
    describe("replace flag", () => {
        it("works with replace=false (push history)", () => {
            const { result } = renderHook(() => useHarness({ q: "" }, { replace: false }), { wrapper: makeWrapper(["/"]) });
            act(() => {
                result.current.setState({ q: "pushed" });
            });
            const params = new URLSearchParams(result.current.search);
            expect(params.get("q")).toBe("pushed");
        });
    });
});
// ===========================================================================
// useUrlParam
// ===========================================================================
describe("useUrlParam", () => {
    function useParamHarness(key, initial = "") {
        const [value, setValue] = useUrlParam(key, initial);
        const location = useLocation();
        return { value, setValue, search: location.search };
    }
    it("returns the initial value when the URL has no param", () => {
        const { result } = renderHook(() => useParamHarness("q", "fallback"), {
            wrapper: makeWrapper(["/"]),
        });
        expect(result.current.value).toBe("fallback");
    });
    it("reads a single key from the URL", () => {
        const { result } = renderHook(() => useParamHarness("q"), {
            wrapper: makeWrapper(["/?q=hello"]),
        });
        expect(result.current.value).toBe("hello");
    });
    it("writes a string value with the simple setter", () => {
        const { result } = renderHook(() => useParamHarness("q"), {
            wrapper: makeWrapper(["/"]),
        });
        act(() => {
            result.current.setValue("typed");
        });
        const params = new URLSearchParams(result.current.search);
        expect(params.get("q")).toBe("typed");
        expect(result.current.value).toBe("typed");
    });
    it("removes the param when set to empty string", () => {
        const { result } = renderHook(() => useParamHarness("q"), {
            wrapper: makeWrapper(["/?q=existing"]),
        });
        act(() => {
            result.current.setValue("");
        });
        const params = new URLSearchParams(result.current.search);
        expect(params.has("q")).toBe(false);
        expect(result.current.value).toBe("");
    });
});
//# sourceMappingURL=use-url-state.test.js.map