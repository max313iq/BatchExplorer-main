/**
 * Tests for the `version` + `migrate` API on usePersistedState.
 */
import { act, renderHook } from "@testing-library/react";
import { usePersistedState, PersistedStorage } from "../use-persisted-state";
describe("usePersistedState — version + migrate", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });
    it("writes the envelope {v, data} when version is provided", () => {
        const { result } = renderHook(() => usePersistedState("prefs", { theme: "dark", density: "comfortable" }, { version: 2 }));
        // Initial write happens in a useEffect — wait one tick.
        const stored = window.localStorage.getItem("prefs");
        expect(stored).not.toBeNull();
        const parsed = JSON.parse(stored);
        expect(parsed).toEqual({
            v: 2,
            data: { theme: "dark", density: "comfortable" },
        });
        act(() => {
            result.current[1]({ theme: "light", density: "compact" });
        });
        const updated = JSON.parse(window.localStorage.getItem("prefs"));
        expect(updated).toEqual({
            v: 2,
            data: { theme: "light", density: "compact" },
        });
    });
    it("calls migrate when stored envelope has an older version", () => {
        // Seed with a v1 envelope.
        window.localStorage.setItem("prefs", JSON.stringify({ v: 1, data: { theme: "dark" } }));
        const migrate = jest.fn((raw, oldVersion) => {
            expect(oldVersion).toBe(1);
            const v1 = raw;
            return Object.assign(Object.assign({}, v1), { density: "comfortable" });
        });
        const { result } = renderHook(() => usePersistedState("prefs", { theme: "light", density: "comfortable" }, { version: 2, migrate }));
        expect(migrate).toHaveBeenCalledTimes(1);
        expect(result.current[0]).toEqual({
            theme: "dark",
            density: "comfortable",
        });
    });
    it("falls back to initial when migrate returns undefined", () => {
        window.localStorage.setItem("prefs", JSON.stringify({ v: 1, data: { theme: "dark" } }));
        const migrate = jest.fn(() => undefined);
        const { result } = renderHook(() => usePersistedState("prefs", { theme: "light", density: "comfortable" }, { version: 2, migrate }));
        expect(migrate).toHaveBeenCalled();
        expect(result.current[0]).toEqual({
            theme: "light",
            density: "comfortable",
        });
    });
    it("falls back to initial when migrate throws", () => {
        window.localStorage.setItem("prefs", JSON.stringify({ v: 1, data: { theme: "dark" } }));
        const migrate = jest.fn(() => {
            throw new Error("bad migration");
        });
        const { result } = renderHook(() => usePersistedState("prefs", { theme: "light", density: "comfortable" }, { version: 2, migrate }));
        expect(migrate).toHaveBeenCalled();
        expect(result.current[0]).toEqual({
            theme: "light",
            density: "comfortable",
        });
    });
    it("treats a bare (un-enveloped) stored value as version=undefined", () => {
        // Legacy: pre-versioning code wrote raw JSON.
        window.localStorage.setItem("prefs", JSON.stringify({ theme: "dark" }));
        const migrate = jest.fn((raw, oldVersion) => {
            expect(oldVersion).toBeUndefined();
            const legacy = raw;
            return { theme: legacy.theme, density: "comfortable" };
        });
        const { result } = renderHook(() => usePersistedState("prefs", { theme: "light", density: "comfortable" }, { version: 2, migrate }));
        expect(migrate).toHaveBeenCalledTimes(1);
        expect(result.current[0]).toEqual({
            theme: "dark",
            density: "comfortable",
        });
    });
    it("PersistedStorage.clear(key) wipes the entry", () => {
        window.localStorage.setItem("p", "anything");
        PersistedStorage.clear("p");
        expect(window.localStorage.getItem("p")).toBeNull();
    });
    it("does not infinite-loop when caller passes a fresh inline serialize", () => {
        // Regression: previously `serialize` was in the persist-effect's
        // dependency array, so an inline function re-fired the effect every
        // render — which was itself triggered by a state update from the
        // previous effect run. Tests run with a low timeout so a loop
        // would jam the suite.
        let renders = 0;
        const { result, rerender } = renderHook(() => {
            renders += 1;
            return usePersistedState("x", 0, {
                serialize: (v) => `n:${v}`,
            });
        });
        // Trigger a setState to ensure the write effect fires and
        // serialize is read.
        act(() => {
            result.current[1](42);
        });
        rerender();
        rerender();
        // Render count should be bounded — 5 or fewer for a hook test.
        expect(renders).toBeLessThan(10);
    });
});
//# sourceMappingURL=use-persisted-state-migrate.test.js.map