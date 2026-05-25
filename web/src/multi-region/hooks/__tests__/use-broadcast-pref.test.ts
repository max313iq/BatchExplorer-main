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

// ---------------------------------------------------------------------------
// Minimal BroadcastChannel polyfill: per-name listener registry.
// ---------------------------------------------------------------------------

type BCListener = (event: MessageEvent) => void;

class MockBroadcastChannel {
    static registry = new Map<string, Set<MockBroadcastChannel>>();
    name: string;
    listeners = new Set<BCListener>();
    closed = false;

    constructor(name: string) {
        this.name = name;
        let set = MockBroadcastChannel.registry.get(name);
        if (!set) {
            set = new Set();
            MockBroadcastChannel.registry.set(name, set);
        }
        set.add(this);
    }
    addEventListener(_type: "message", listener: BCListener) {
        this.listeners.add(listener);
    }
    removeEventListener(_type: "message", listener: BCListener) {
        this.listeners.delete(listener);
    }
    postMessage(data: unknown) {
        if (this.closed) return;
        const peers = MockBroadcastChannel.registry.get(this.name);
        if (!peers) return;
        for (const peer of peers) {
            if (peer === this) continue; // don't echo to sender
            if (peer.closed) continue;
            for (const fn of peer.listeners) {
                fn({ data } as MessageEvent);
            }
        }
    }
    close() {
        this.closed = true;
        const peers = MockBroadcastChannel.registry.get(this.name);
        peers?.delete(this);
    }
    static reset() {
        MockBroadcastChannel.registry.clear();
    }
}

beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).BroadcastChannel = MockBroadcastChannel;
});

afterEach(() => {
    MockBroadcastChannel.reset();
    window.localStorage.clear();
});

describe("useBroadcastPref", () => {
    it("persists changes to localStorage", () => {
        const { result } = renderHook(() =>
            useBroadcastPref<string>("pref:density", "comfortable"),
        );

        act(() => result.current[1]("compact"));

        expect(result.current[0]).toBe("compact");
        // The persisted-state layer JSON-encodes the bare value when no
        // version is set.
        expect(window.localStorage.getItem("pref:density")).toBe(
            JSON.stringify("compact"),
        );
    });

    it("propagates a change to a second hook instance via the channel", () => {
        const a = renderHook(() =>
            useBroadcastPref<string>("pref:theme", "light"),
        );
        const b = renderHook(() =>
            useBroadcastPref<string>("pref:theme", "light"),
        );

        act(() => a.result.current[1]("dark"));

        // a sees its own write synchronously; b sees the broadcast.
        expect(a.result.current[0]).toBe("dark");
        expect(b.result.current[0]).toBe("dark");
    });

    it("ignores messages for unrelated keys", () => {
        const a = renderHook(() =>
            useBroadcastPref<string>("pref:density", "comfy"),
        );
        const b = renderHook(() =>
            useBroadcastPref<string>("pref:theme", "light"),
        );

        act(() => a.result.current[1]("compact"));

        expect(b.result.current[0]).toBe("light"); // unchanged
    });

    it("does not echo a self-broadcast back to the same hook", () => {
        let renders = 0;
        const { result } = renderHook(() => {
            renders += 1;
            return useBroadcastPref<string>("pref:density", "comfy");
        });

        const baseline = renders;
        act(() => result.current[1]("compact"));

        // setState causes one render. If the hook were re-applying its own
        // broadcast we'd see at least two more.
        expect(renders - baseline).toBeLessThanOrEqual(2);
        expect(result.current[0]).toBe("compact");
    });
});
