/**
 * Tests for the shared `ErrorBoundary` component.
 *
 * The component is a class-based React error boundary that:
 *   - renders children when nothing has thrown
 *   - catches errors thrown during render of any descendant and displays a
 *     destructive Alert with the error message + a "Reload Dashboard" button
 *   - supports a custom `fallback` prop (rendered instead of the default UI)
 *   - resets state via the "Reload Dashboard" button (incrementing an internal
 *     resetKey on the children Fragment so the children remount fresh)
 *   - logs the captured error via `console.error` from `componentDidCatch`
 *
 * Implementation notes:
 *   - Each test that triggers a throw stubs `console.error` so React's own
 *     error logging (and the boundary's log) don't pollute test output.
 *   - `Bomb` is the canonical "throw on demand" child; toggling its prop lets
 *     us simulate the error then "fix" the underlying issue before reset.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { ErrorBoundary } from "@/multi-region/components/shared/error-boundary";

/** Throws synchronously during render when `shouldThrow` is true. */
function Bomb({
    shouldThrow = true,
    message = "boom",
}: {
    shouldThrow?: boolean;
    message?: string;
}): React.ReactElement {
    if (shouldThrow) {
        throw new Error(message);
    }
    return <div data-testid="bomb-ok">no boom</div>;
}

describe("ErrorBoundary", () => {
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
        // Suppress React's noisy "The above error occurred in" stack traces
        // and the boundary's own componentDidCatch log so test output stays
        // clean. We still observe the spy in the relevant test.
        consoleErrorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {
                /* swallow */
            });
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it("renders children when no error is thrown", () => {
        render(
            <ErrorBoundary>
                <div data-testid="child">hello world</div>
            </ErrorBoundary>,
        );

        expect(screen.getByTestId("child")).toHaveTextContent("hello world");
        // No fallback UI should be present.
        expect(screen.queryByText("Something went wrong.")).toBeNull();
    });

    it("catches a thrown error and renders the default fallback UI with the error message", () => {
        render(
            <ErrorBoundary>
                <Bomb message="kaboom" />
            </ErrorBoundary>,
        );

        // Default fallback is rendered.
        expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
        expect(screen.getByText("kaboom")).toBeInTheDocument();
        // The reset button is the "Reload Dashboard" button.
        expect(
            screen.getByRole("button", { name: /reload dashboard/i }),
        ).toBeInTheDocument();
    });

    it("logs the error via console.error from componentDidCatch", () => {
        render(
            <ErrorBoundary>
                <Bomb message="logged-error" />
            </ErrorBoundary>,
        );

        // Filter to the boundary's own log line — React itself also logs
        // through console.error, so we look specifically for our prefix.
        const boundaryCalls = consoleErrorSpy.mock.calls.filter(
            (args) =>
                typeof args[0] === "string" && args[0].includes("[ErrorBoundary]"),
        );
        expect(boundaryCalls.length).toBeGreaterThanOrEqual(1);
        // The second arg should be the Error instance with the right message.
        const [, error] = boundaryCalls[0];
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("logged-error");
    });

    it("renders a custom `fallback` prop instead of the default UI when an error is caught", () => {
        render(
            <ErrorBoundary
                fallback={<div data-testid="custom-fallback">custom oops</div>}
            >
                <Bomb message="explode" />
            </ErrorBoundary>,
        );

        expect(screen.getByTestId("custom-fallback")).toHaveTextContent(
            "custom oops",
        );
        // Default UI should NOT have rendered.
        expect(screen.queryByText("Something went wrong.")).toBeNull();
        expect(
            screen.queryByRole("button", { name: /reload dashboard/i }),
        ).toBeNull();
    });

    it("resets state and re-renders fresh children when the Reload Dashboard button is clicked", () => {
        // First render: child throws — boundary shows fallback.
        const { rerender } = render(
            <ErrorBoundary>
                <Bomb shouldThrow message="first-error" />
            </ErrorBoundary>,
        );
        expect(screen.getByText("first-error")).toBeInTheDocument();

        // Before clicking reset, "fix" the child so it no longer throws.
        rerender(
            <ErrorBoundary>
                <Bomb shouldThrow={false} />
            </ErrorBoundary>,
        );
        // The boundary still has hasError=true from the first render, so
        // we expect the fallback to remain until the user clicks reset.
        expect(screen.getByText("first-error")).toBeInTheDocument();

        // Click "Reload Dashboard" — boundary clears its error state and
        // re-renders the (now non-throwing) children with a new resetKey.
        fireEvent.click(
            screen.getByRole("button", { name: /reload dashboard/i }),
        );

        expect(screen.queryByText("Something went wrong.")).toBeNull();
        expect(screen.getByTestId("bomb-ok")).toHaveTextContent("no boom");
    });

    it("re-renders children fresh after a successful reset (resetKey forces remount)", () => {
        // We use a ref counter that increments each time a fresh instance
        // mounts, to confirm the children Fragment really does remount on
        // reset (not just rerender in place).
        let mountCount = 0;
        function Counter(): React.ReactElement {
            React.useEffect(() => {
                mountCount += 1;
            }, []);
            return <div data-testid="counter">mounted</div>;
        }

        const { rerender } = render(
            <ErrorBoundary>
                <>
                    <Counter />
                    <Bomb shouldThrow message="will-reset" />
                </>
            </ErrorBoundary>,
        );
        // First mount of Counter happened before Bomb threw — exact count
        // here can vary (React may have already started commit), so we
        // record the baseline rather than asserting a specific value.
        const baseline = mountCount;

        // Switch to a non-throwing tree.
        rerender(
            <ErrorBoundary>
                <>
                    <Counter />
                    <Bomb shouldThrow={false} />
                </>
            </ErrorBoundary>,
        );

        // Click reset — the Fragment's `key={resetKey}` bumps, forcing a
        // fresh mount of Counter.
        fireEvent.click(
            screen.getByRole("button", { name: /reload dashboard/i }),
        );

        expect(screen.getByTestId("counter")).toBeInTheDocument();
        // Counter mounted at least once after reset.
        expect(mountCount).toBeGreaterThan(baseline);
    });

    it("shows 'Unknown error' when the thrown error has no message", () => {
        function ThrowEmpty(): React.ReactElement {
            // Throw an Error with an empty string message; the boundary
            // falls back to "Unknown error" only when `error.message` is
            // falsy. Empty string is falsy, so this exercises the `??`
            // fallback branch.
            throw new Error("");
        }

        render(
            <ErrorBoundary>
                <ThrowEmpty />
            </ErrorBoundary>,
        );

        expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
        expect(screen.getByText("Unknown error")).toBeInTheDocument();
    });
});
