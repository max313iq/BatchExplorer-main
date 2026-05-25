/**
 * Tests for useAbortableEffect — covers cleanup-on-unmount and
 * cleanup-on-deps-change.
 */
import { renderHook } from "@testing-library/react";

import { useAbortableEffect } from "../use-abortable-effect";

describe("useAbortableEffect", () => {
    it("aborts the signal when the component unmounts", () => {
        const seen: AbortSignal[] = [];

        const { unmount } = renderHook(() => {
            useAbortableEffect((signal) => {
                seen.push(signal);
            }, []);
        });

        expect(seen).toHaveLength(1);
        expect(seen[0].aborted).toBe(false);

        unmount();
        expect(seen[0].aborted).toBe(true);
    });

    it("aborts the previous signal when deps change", () => {
        const seen: AbortSignal[] = [];

        const { rerender } = renderHook(
            ({ id }: { id: number }) => {
                useAbortableEffect(
                    (signal) => {
                        seen.push(signal);
                    },
                    [id],
                );
            },
            { initialProps: { id: 1 } },
        );

        expect(seen).toHaveLength(1);
        expect(seen[0].aborted).toBe(false);

        rerender({ id: 2 });

        // Old signal aborted; new one is live.
        expect(seen[0].aborted).toBe(true);
        expect(seen).toHaveLength(2);
        expect(seen[1].aborted).toBe(false);
    });

    it("invokes the cleanup function on tear-down", () => {
        const cleanup = jest.fn();

        const { unmount } = renderHook(() => {
            useAbortableEffect(() => cleanup, []);
        });

        expect(cleanup).not.toHaveBeenCalled();
        unmount();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("supports async effects and runs their cleanup once it's available", async () => {
        const cleanup = jest.fn();

        const { unmount } = renderHook(() => {
            useAbortableEffect(async () => {
                await Promise.resolve();
                return cleanup;
            }, []);
        });

        // Flush microtasks so the async effect resolves and registers cleanup.
        await Promise.resolve();
        await Promise.resolve();

        unmount();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("runs an async cleanup immediately when unmounted before it resolves", async () => {
        const cleanup = jest.fn();
        let resolveEffect: (() => void) | undefined;
        const effectPromise = new Promise<void>((res) => {
            resolveEffect = res;
        });

        const { unmount } = renderHook(() => {
            useAbortableEffect(async () => {
                await effectPromise;
                return cleanup;
            }, []);
        });

        // Tear down BEFORE the async effect resolves.
        unmount();

        // Now let the effect's async work finish.
        resolveEffect?.();
        await Promise.resolve();
        await Promise.resolve();

        expect(cleanup).toHaveBeenCalledTimes(1);
    });
});
