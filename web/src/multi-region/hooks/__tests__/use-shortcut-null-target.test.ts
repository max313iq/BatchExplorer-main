/**
 * Explicit-null `target` disables the binding. Previously the chain
 * `target ?? window ?? null` collapsed null to window, so passing null
 * silently bound to window — surprising callers that meant "off".
 */
import { renderHook } from "@testing-library/react";

import { useShortcut } from "../use-shortcut";

describe("useShortcut — target=null binds nothing", () => {
    it("does NOT fire the handler when target is explicitly null", () => {
        const handler = jest.fn();
        renderHook(() => useShortcut("k", handler, { target: null }));

        // Dispatch a matching keydown on window — handler must not fire.
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));

        expect(handler).not.toHaveBeenCalled();
    });

    it("binds to window when target is undefined (default)", () => {
        const handler = jest.fn();
        renderHook(() => useShortcut("k", handler));

        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("binds to an explicit DOM target when one is provided", () => {
        const target = document.createElement("div");
        const handler = jest.fn();
        renderHook(() => useShortcut("j", handler, { target }));

        target.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
        expect(handler).toHaveBeenCalledTimes(1);

        // Window-level keydown does NOT fire the handler.
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
        expect(handler).toHaveBeenCalledTimes(1);
    });
});
