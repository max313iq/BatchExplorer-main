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
export declare const NumberTicker: React.FC<NumberTickerProps>;
//# sourceMappingURL=number-ticker.d.ts.map