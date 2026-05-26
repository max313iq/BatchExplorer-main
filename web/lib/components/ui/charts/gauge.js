/**
 * Gauge — used / total bar with semantic tone shifts. Shows a percent fill
 * plus a discrete fraction label. Pure CSS bar; no SVG needed.
 *
 * Tone is computed from the fill ratio by default:
 *   <50%  → success
 *   <80%  → info
 *   <95%  → warning
 *   ≥95%  → destructive
 *
 * Pass `tone="..."` to lock a specific tone.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
const TONE_FILL = {
    primary: "bg-primary",
    info: "bg-info",
    success: "bg-success",
    warning: "bg-warning",
    destructive: "bg-destructive",
};
const TONE_TEXT = {
    primary: "text-primary",
    info: "text-info",
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
};
const SIZE_BAR = {
    sm: "h-1",
    md: "h-1.5",
    lg: "h-2",
};
function deriveTone(ratio) {
    if (!Number.isFinite(ratio) || ratio < 0)
        return "muted";
    if (ratio < 0.5)
        return "success";
    if (ratio < 0.8)
        return "info";
    if (ratio < 0.95)
        return "warning";
    return "destructive";
}
const NUMBER_FORMAT = new Intl.NumberFormat();
export const Gauge = ({ used, total, tone, label, unit, showFraction = true, size = "md", ariaLabel, className, }) => {
    const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
    const pct = ratio * 100;
    const effectiveTone = tone !== null && tone !== void 0 ? tone : deriveTone(ratio);
    return (React.createElement("div", { className: cn("flex flex-col gap-1", className) },
        (label || showFraction || unit) && (React.createElement("div", { className: "flex items-baseline justify-between gap-3 text-2xs" },
            label && (React.createElement("span", { className: "font-medium text-foreground/90" }, label)),
            React.createElement("span", { className: "ml-auto inline-flex items-baseline gap-1 tabular-nums" },
                showFraction && (React.createElement(React.Fragment, null,
                    React.createElement("span", { className: cn("font-semibold", TONE_TEXT[effectiveTone]) }, NUMBER_FORMAT.format(used)),
                    React.createElement("span", { className: "text-muted-foreground/70" },
                        "/",
                        NUMBER_FORMAT.format(total)))),
                unit && (React.createElement("span", { className: "text-muted-foreground/70" }, unit)),
                React.createElement("span", { className: "ml-1 text-muted-foreground/70" },
                    "(",
                    pct.toFixed(0),
                    "%)")))),
        React.createElement("div", { role: "progressbar", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": used, "aria-label": ariaLabel !== null && ariaLabel !== void 0 ? ariaLabel : (typeof label === "string"
                ? `${label}: ${used} of ${total}`
                : `${used} of ${total}`), className: cn("relative w-full overflow-hidden rounded-full bg-muted", SIZE_BAR[size]) },
            React.createElement("div", { className: cn("h-full rounded-full transition-all duration-base ease-standard motion-reduce:transition-none", TONE_FILL[effectiveTone]), style: { width: `${pct.toFixed(2)}%` } }))));
};
export const MiniBar = ({ items, maxItems = 10, scaleTo, ariaLabel, className, }) => {
    if (items.length === 0)
        return null;
    const visible = items.slice(0, maxItems);
    const overflow = items.length - visible.length;
    const max = scaleTo !== null && scaleTo !== void 0 ? scaleTo : Math.max(...visible.map((i) => i.value), 1);
    return (React.createElement("ul", { role: "list", "aria-label": ariaLabel, className: cn("flex flex-col gap-1.5", className) },
        visible.map((item) => {
            var _a;
            const pct = max > 0 ? Math.min(100, (item.value / max) * 100) : 0;
            const effectiveTone = (_a = item.tone) !== null && _a !== void 0 ? _a : "primary";
            return (React.createElement("li", { key: item.label, className: "flex items-center gap-2 text-2xs" },
                React.createElement("span", { className: "w-24 shrink-0 truncate font-mono text-foreground/80", title: item.label }, item.label),
                React.createElement("span", { className: "relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted" },
                    React.createElement("span", { className: cn("block h-full rounded-full transition-all duration-base ease-standard motion-reduce:transition-none", TONE_FILL[effectiveTone]), style: { width: `${pct.toFixed(2)}%` } })),
                React.createElement("span", { className: "w-12 shrink-0 text-right font-medium tabular-nums text-foreground" }, NUMBER_FORMAT.format(item.value))));
        }),
        overflow > 0 && (React.createElement("li", { className: "text-2xs text-muted-foreground" },
            "+ ",
            overflow,
            " more"))));
};
//# sourceMappingURL=gauge.js.map