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

export interface NumberTickerProps {
  /** Target value. The component animates from its previous render's value to this. */
  value: number;
  /** Animation duration in ms. Default 600 — feels snappy but visible. */
  duration?: number;
  /** Number formatter. Defaults to the locale-aware Intl integer format. */
  format?: (n: number) => string;
  /** Direction. "up" = always count up; "down" = always count down. Default = pick from prev value. */
  direction?: "up" | "down";
  className?: string;
}

const defaultFormat = (n: number): string =>
  Number.isFinite(n) ? Math.round(n).toLocaleString() : String(n);

// Cubic ease-out — fast at first, settles smoothly. Same curve as
// Tailwind's default `ease-out`.
function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export const NumberTicker: React.FC<NumberTickerProps> = ({
  value,
  duration = 600,
  format = defaultFormat,
  className,
}) => {
  const [display, setDisplay] = React.useState<number>(value);
  const fromRef = React.useRef<number>(value);
  const startTsRef = React.useRef<number>(0);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (display === value) return;

    fromRef.current = display;
    startTsRef.current = 0;

    const step = (ts: number): void => {
      if (startTsRef.current === 0) startTsRef.current = ts;
      const elapsed = ts - startTsRef.current;
      const t = Math.min(1, elapsed / duration);
      const eased = easeOutCubic(t);
      const next = fromRef.current + (value - fromRef.current) * eased;
      setDisplay(next);
      if (t < 1) {
        rafRef.current = window.requestAnimationFrame(step);
      } else {
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
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setDisplay(value);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
  }, [value]);

  return (
    <span className={className} aria-live="polite" aria-atomic="true">
      {format(display)}
    </span>
  );
};
