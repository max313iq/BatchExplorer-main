/**
 * NumberTicker — animated counter that smoothly transitions to a target
 * value when it changes. No framer-motion; uses requestAnimationFrame
 * with a custom easing so the bundle stays small.
 *
 *   <NumberTicker value={123} />
 *
 * Drop-in replacement for any place that renders a static number; the
 * caller still owns the value (this just animates the visual transition
 * between successive values).
 */
import * as React from "react";
const defaultFormat = (n) => Number.isFinite(n) ? Math.round(n).toLocaleString() : String(n);
// Cubic ease-out — fast at first, settles smoothly. Same curve as
// Tailwind's default `ease-out`.
function easeOutCubic(t) {
    const u = 1 - t;
    return 1 - u * u * u;
}
export const NumberTicker = ({ value, duration = 600, format = defaultFormat, className, }) => {
    const [display, setDisplay] = React.useState(value);
    const fromRef = React.useRef(value);
    const startTsRef = React.useRef(0);
    const rafRef = React.useRef(null);
    React.useEffect(() => {
        if (typeof window === "undefined")
            return;
        if (display === value)
            return;
        fromRef.current = display;
        startTsRef.current = 0;
        const step = (ts) => {
            if (startTsRef.current === 0)
                startTsRef.current = ts;
            const elapsed = ts - startTsRef.current;
            const t = Math.min(1, elapsed / duration);
            const eased = easeOutCubic(t);
            const next = fromRef.current + (value - fromRef.current) * eased;
            setDisplay(next);
            if (t < 1) {
                rafRef.current = window.requestAnimationFrame(step);
            }
            else {
                setDisplay(value);
                rafRef.current = null;
            }
        };
        rafRef.current = window.requestAnimationFrame(step);
        return () => {
            if (rafRef.current !== null) {
                window.cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
        // We deliberately depend ONLY on `value` here. Re-running on
        // `display` change would loop; on `duration`/`format` change is
        // unnecessary because they don't trigger a transition.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    // Honor prefers-reduced-motion: skip the animation, snap to value.
    React.useEffect(() => {
        if (typeof window === "undefined")
            return;
        const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
        if (mq.matches) {
            setDisplay(value);
            if (rafRef.current !== null) {
                window.cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        }
    }, [value]);
    return (React.createElement("span", { className: className, "aria-live": "polite", "aria-atomic": "true" }, format(display)));
};
//# sourceMappingURL=number-ticker.js.map