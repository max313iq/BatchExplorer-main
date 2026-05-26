import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
/**
 * `animate=false` is supported because the legacy callers use it for tests
 * and printing snapshots; `Skeleton` itself always pulses, so when animation
 * is disabled we render a non-pulsing div with the same shape.
 */
function bar(className, style, animate) {
    if (animate) {
        return React.createElement(Skeleton, { className: className, style: style });
    }
    return (React.createElement("div", { className: cn("rounded-md bg-muted/50", className), style: style }));
}
function TableSkeleton({ rows, columns, animate, }) {
    return (React.createElement("div", { className: "flex flex-col gap-2" },
        React.createElement("div", { className: "flex gap-3" }, Array.from({ length: columns }, (_, c) => bar(`flex-1`, { height: 16 }, animate)).map((el, i) => (React.createElement(React.Fragment, { key: `h-${i}` }, el)))),
        React.createElement("div", { className: "h-px w-full bg-border" }),
        Array.from({ length: rows }, (_, r) => (React.createElement("div", { key: `r-${r}`, className: "flex gap-3" }, Array.from({ length: columns }, (_, c) => bar(`flex-1`, {
            height: 14,
            animationDelay: `${(r * columns + c) * 0.05}s`,
        }, animate)).map((el, i) => (React.createElement(React.Fragment, { key: `r-${r}-c-${i}` }, el))))))));
}
function CardSkeleton({ cards, animate, }) {
    return (React.createElement("div", { className: "flex flex-wrap gap-4" }, Array.from({ length: cards }, (_, i) => (React.createElement("div", { key: i, className: "flex w-60 flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm" },
        bar(``, { width: "60%", height: 16 }, animate),
        bar(``, { width: "100%", height: 12 }, animate),
        bar(``, { width: "80%", height: 12 }, animate))))));
}
function StatBarSkeleton({ animate, }) {
    return (React.createElement("div", { className: "flex gap-4" }, Array.from({ length: 4 }, (_, i) => (React.createElement("div", { key: i, className: "flex flex-1 flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm" },
        bar(``, { width: "50%", height: 12 }, animate),
        bar(``, { width: "70%", height: 24 }, animate))))));
}
function ListSkeleton({ rows, animate, }) {
    return (React.createElement("div", { className: "flex flex-col gap-3" }, Array.from({ length: rows }, (_, i) => (React.createElement("div", { key: i, className: "flex items-center gap-3" },
        bar(`shrink-0 rounded-full`, { width: 32, height: 32 }, animate),
        React.createElement("div", { className: "flex flex-1 flex-col gap-1.5" },
            bar(``, { width: "40%", height: 14 }, animate),
            bar(``, { width: "70%", height: 12 }, animate)))))));
}
function FormSkeleton({ rows, animate, }) {
    return (React.createElement("div", { className: "flex flex-col gap-4" }, Array.from({ length: rows }, (_, i) => (React.createElement("div", { key: i, className: "flex flex-col gap-1.5" },
        bar(``, { width: "20%", height: 12 }, animate),
        bar(``, { width: "100%", height: 32 }, animate))))));
}
function TextSkeleton({ rows, animate, }) {
    const widths = ["100%", "95%", "85%", "90%", "60%"];
    return (React.createElement("div", { className: "flex flex-col gap-2" }, Array.from({ length: rows }, (_, i) => bar(``, { width: widths[i % widths.length], height: 14 }, animate)).map((el, i) => (React.createElement(React.Fragment, { key: i }, el)))));
}
export const SkeletonLoader = ({ variant, rows = 5, columns = 4, cards = 3, animate = true, }) => {
    const content = React.useMemo(() => {
        switch (variant) {
            case "table":
                return (React.createElement(TableSkeleton, { rows: rows, columns: columns, animate: animate }));
            case "card":
                return React.createElement(CardSkeleton, { cards: cards, animate: animate });
            case "stat-bar":
                return React.createElement(StatBarSkeleton, { animate: animate });
            case "list":
                return React.createElement(ListSkeleton, { rows: rows, animate: animate });
            case "form":
                return React.createElement(FormSkeleton, { rows: rows, animate: animate });
            case "text":
                return React.createElement(TextSkeleton, { rows: rows, animate: animate });
        }
    }, [variant, rows, columns, cards, animate]);
    return (React.createElement("div", { role: "progressbar", "aria-label": "Loading content" }, content));
};
//# sourceMappingURL=skeleton-loader.js.map