import * as React from "react";
import { cn } from "@/lib/utils";
const BAR_HEIGHT = 12;
export const RegionHealthChart = ({ regions, className, }) => {
    const sorted = React.useMemo(() => [...regions].sort((a, b) => b.total - a.total), [regions]);
    if (sorted.length === 0) {
        return (React.createElement("div", { className: cn("flex h-32 items-center justify-center rounded-md border border-dashed border-border bg-surface-sunken/40 text-xs text-muted-foreground", className), role: "status", "aria-label": "No region data yet" }, "No region data yet"));
    }
    const maxTotal = Math.max(...sorted.map((r) => r.total), 1);
    const totalHealthy = sorted.reduce((s, r) => s + r.healthy, 0);
    const totalAccounts = sorted.reduce((s, r) => s + r.total, 0);
    const summary = `Region health: ${totalHealthy} healthy of ${totalAccounts} across ${sorted.length} regions`;
    return (React.createElement("div", { className: cn("flex w-full flex-col gap-1.5", className), role: "img", "aria-label": summary }, sorted.map((r) => {
        const widthPct = (r.total / maxTotal) * 100;
        const fraction = r.total > 0 ? r.healthy / r.total : 0;
        const healthyPct = widthPct * fraction;
        const rowLabel = `${r.name}: ${r.healthy} healthy of ${r.total}`;
        const fullyHealthy = r.healthy === r.total && r.total > 0;
        const partial = r.healthy > 0 && r.healthy < r.total;
        return (React.createElement("div", { key: r.name, className: "flex items-center gap-2", "aria-label": rowLabel, role: "presentation" },
            React.createElement("span", { className: "live-pulse-dot shrink-0", style: {
                    ["--live-tone"]: fullyHealthy
                        ? "var(--success)"
                        : partial
                            ? "var(--warning)"
                            : "var(--destructive)",
                }, "aria-hidden": "true" }),
            React.createElement("span", { className: "w-24 shrink-0 truncate text-xs font-medium text-foreground", title: r.name }, r.name),
            React.createElement("div", { className: cn("relative flex-1 overflow-hidden rounded-sm bg-transparent", 
                // Healthy bars get a subtle outer glow so the row visibly
                // hums. The .live-glow-bar utility owns the keyframe.
                fullyHealthy && "live-glow-bar"), style: {
                    height: BAR_HEIGHT,
                    ["--live-tone"]: "var(--success)",
                }, "aria-hidden": "true" },
                React.createElement("svg", { className: "h-full w-full", preserveAspectRatio: "none", viewBox: "0 0 100 1", focusable: "false" },
                    React.createElement("rect", { x: 0, y: 0, width: widthPct, height: 1, rx: 0.15, ry: 0.15, className: "fill-muted" }),
                    React.createElement("rect", { x: 0, y: 0, width: healthyPct, height: 1, rx: 0.15, ry: 0.15, className: "fill-success" }))),
            React.createElement("span", { className: "w-14 shrink-0 text-right text-xs tabular-nums" },
                React.createElement("span", { className: cn("font-semibold", fullyHealthy
                        ? "text-success"
                        : r.healthy === 0
                            ? "text-destructive"
                            : "text-foreground") }, r.healthy),
                React.createElement("span", { className: "text-muted-foreground/70" },
                    "/",
                    r.total))));
    })));
};
//# sourceMappingURL=region-health-chart.js.map