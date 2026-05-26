/**
 * Tests for useBroadcastPref — covers basic persistence + cross-channel
 * propagation through a mock BroadcastChannel.
 *
 * Real BroadcastChannel isn't available in jsdom, so we install a tiny
 * implementation that routes messages between every open instance on the
 * same channel name. That's enough to exercise the cross-tab path.
 */
import { act, renderHook } from "@testing-library/react";
import { useBroadcastPref } from "../use-broadcast-pref";
class MockBroadcastChannel {
    constructor(name) {
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "listeners", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Set()
        });
        Object.defineProperty(this, "closed", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        this.name = name;
        let set = MockBroadcastChannel.registry.get(name);
        if (!set) {
            set = new Set();
            MockBroadcastChannel.registry.set(name, set);
        }
        set.add(this);
    }
    addEventListener(_type, listener) {
        this.listeners.add(listener);
    }
    removeEventListener(_type, listener) {
        this.listeners.delete(listener);
    }
    postMessage(data) {
        if (this.closed)
            return;
        const peers = MockBroadcastChannel.registry.get(this.name);
        if (!peers)
            return;
        for (const peer of peers) {
            if (peer === this)
                continue; // don't echo to sender
            if (peer.closed)
                continue;
            for (const fn of peer.listeners) {
                fn({ data });
            }
        }
    }
    close() {
        this.closed = true;
        const peers = MockBroadcastChannel.registry.get(this.name);
        peers === null || peers === void 0 ? void 0 : peers.delete(this);
    }
    static reset() {
        MockBroadcastChannel.registry.clear();
    }
}
Object.defineProperty(MockBroadcastChannel, "registry", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: new Map()
});
beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.BroadcastChannel = MockBroadcastChannel;
});
afterEach(() => {
    MockBroadcastChannel.reset();
    window.localStorage.clear();
});
describe("useBroadcastPref", () => {
    it("persists changes to localStorage", () => {
        const { result } = renderHook(() => useBroadcastPref("pref:density", "comfortable"));
        act(() => result.current[1]("compact"));
        expect(result.current[0]).toBe("compact");
        // The persisted-state layer JSON-encodes the bare value when no
        // version is set.
        expect(window.localStorage.getItem("pref:density")).toBe(JSON.stringify("compact"));
    });
    it("propagates a change to a second hook instance via the channel", () => {
        const a = renderHook(() => useBroadcastPref("pref:theme", "light"));
        const b = renderHook(() => useBroadcastPref("pref:theme", "light"));
        act(() => a.result.current[1]("dark"));
        // a sees its own write synchronously; b sees the broadcast.
        expect(a.result.current[0]).toBe("dark");
        expect(b.result.current[0]).toBe("dark");
    });
    it("ignores messages for unrelated keys", () => {
        const a = renderHook(() => useBroadcastPref("pref:density", "comfy"));
        const b = renderHook(() => useBroadcastPref("pref:theme", "light"));
        act(() => a.result.current[1]("compact"));
        expect(b.result.current[0]).toBe("light"); // unchanged
    });
    it("does not echo a self-broadcast back to the same hook", () => {
        let renders = 0;
        const { result } = renderHook(() => {
            renders += 1;
            return useBroadcastPref("pref:density", "comfy");
        });
        const baseline = renders;
        act(() => result.current[1]("compact"));
        // setState causes one render. If the hook were re-applying its own
        // broadcast we'd see at least two more.
        expect(renders - baseline).toBeLessThanOrEqual(2);
        expect(result.current[0]).toBe("compact");
    });
});
//# sourceMappingURL=use-broadcast-pref.test.js.map