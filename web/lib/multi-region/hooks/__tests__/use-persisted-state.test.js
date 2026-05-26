import { act, renderHook } from "@testing-library/react";
import { PersistedStorage, usePersistedState } from "../use-persisted-state";
describe("usePersistedState", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });
    it("falls back to the initial value when localStorage has no entry", () => {
        const { result } = renderHook(() => usePersistedState("k1", "default"));
        expect(result.current[0]).toBe("default");
    });
    it("reads the existing localStorage value on first render", () => {
        window.localStorage.setItem("k2", JSON.stringify("stored"));
        const { result } = renderHook(() => usePersistedState("k2", "default"));
        expect(result.current[0]).toBe("stored");
    });
    it("supports a functional initial value (lazy)", () => {
        const init = jest.fn(() => ({ count: 7 }));
        const { result } = renderHook(() => usePersistedState("k3", init));
        expect(result.current[0]).toEqual({ count: 7 });
        expect(init).toHaveBeenCalledTimes(1);
    });
    it("falls back to initial value when stored JSON is invalid", () => {
        window.localStorage.setItem("k-bad", "not{json");
        const { result } = renderHook(() => usePersistedState("k-bad", "fallback"));
        expect(result.current[0]).toBe("fallback");
    });
    it("writes JSON-serialized state to localStorage on update", () => {
        const { result } = renderHook(() => usePersistedState("k4", 0));
        act(() => {
            result.current[1](42);
        });
        expect(result.current[0]).toBe(42);
        expect(window.localStorage.getItem("k4")).toBe(JSON.stringify(42));
    });
    it("uses custom serialize/deserialize when provided", () => {
        const serialize = jest.fn((n) => `n:${n}`);
        const deserialize = jest.fn((raw) => {
            const m = /^n:(\d+)$/.exec(raw);
            return m ? Number(m[1]) : undefined;
        });
        // Pre-seed using the custom format.
        window.localStorage.setItem("k5", "n:11");
        const { result } = renderHook(() => usePersistedState("k5", 0, { serialize, deserialize }));
        // First read deserialized via custom fn.
        expect(result.current[0]).toBe(11);
        expect(deserialize).toHaveBeenCalledWith("n:11");
        // Update writes via the custom serializer.
        act(() => {
            result.current[1](99);
        });
        expect(window.localStorage.getItem("k5")).toBe("n:99");
        expect(serialize).toHaveBeenCalledWith(99);
    });
    it("reset() clears the localStorage key and reverts to the initial value", () => {
        const { result } = renderHook(() => usePersistedState("k6", "init"));
        act(() => {
            result.current[1]("changed");
        });
        expect(window.localStorage.getItem("k6")).toBe(JSON.stringify("changed"));
        act(() => {
            result.current[2]();
        });
        expect(result.current[0]).toBe("init");
        expect(window.localStorage.getItem("k6")).toBeNull();
    });
    it("syncs across tabs via the storage event when syncAcrossTabs is true", () => {
        const { result } = renderHook(() => usePersistedState("k7", "a", { syncAcrossTabs: true }));
        expect(result.current[0]).toBe("a");
        act(() => {
            window.dispatchEvent(new StorageEvent("storage", {
                key: "k7",
                newValue: JSON.stringify("b"),
            }));
        });
        expect(result.current[0]).toBe("b");
        // Different key — should be ignored.
        act(() => {
            window.dispatchEvent(new StorageEvent("storage", {
                key: "other",
                newValue: JSON.stringify("c"),
            }));
        });
        expect(result.current[0]).toBe("b");
        // newValue == null (key removed in another tab) — ignored.
        act(() => {
            window.dispatchEvent(new StorageEvent("storage", {
                key: "k7",
                newValue: null,
            }));
        });
        expect(result.current[0]).toBe("b");
    });
    it("does not subscribe to storage events when syncAcrossTabs is false", () => {
        const { result } = renderHook(() => usePersistedState("k8", "a"));
        act(() => {
            window.dispatchEvent(new StorageEvent("storage", {
                key: "k8",
                newValue: JSON.stringify("z"),
            }));
        });
        expect(result.current[0]).toBe("a");
    });
});
describe("PersistedStorage", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });
    it("get() returns the fallback when key is missing", () => {
        expect(PersistedStorage.get("missing", { x: 1 })).toEqual({ x: 1 });
    });
    it("get() returns the parsed value when present", () => {
        window.localStorage.setItem("ps1", JSON.stringify({ x: 2 }));
        expect(PersistedStorage.get("ps1", { x: 0 })).toEqual({
            x: 2,
        });
    });
    it("get() returns the fallback when stored value is unparseable", () => {
        window.localStorage.setItem("ps-bad", "{not json");
        expect(PersistedStorage.get("ps-bad", "fb")).toBe("fb");
    });
    it("set() writes JSON-serialized value", () => {
        PersistedStorage.set("ps2", [1, 2, 3]);
        expect(window.localStorage.getItem("ps2")).toBe(JSON.stringify([1, 2, 3]));
    });
    it("delete() removes the key", () => {
        window.localStorage.setItem("ps3", JSON.stringify("v"));
        PersistedStorage.delete("ps3");
        expect(window.localStorage.getItem("ps3")).toBeNull();
    });
});
//# sourceMappingURL=use-persisted-state.test.js.map