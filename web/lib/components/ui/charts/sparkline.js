/**
 * Sparkline — tiny inline trend line. Pure SVG, no chart library.
 *
 * Designed to fit inside a stat card next to a counter. Auto-scales the
 * Y axis to the data; X axis is sample-index. Renders nothing for fewer
 * than 2 samples (the surface stays clean during cold-start).
 */
import * as React from "react";
import { cn } from "@/lib/utils";
const TONE_TO_VAR = {
    primary: "var(--primary)",
    info: "var(--info)",
    success: "var(--success)",
    warning: "var(--warning)",
    destructive: "var(--destructive)",
    muted: "var(--muted-foreground)",
};
export const Sparkline = ({ data, width = 80, height = 20, tone = "primary", strokeWidth = 1.5, fill = true, ariaLabel, className, }) => {
    if (data.length < 2) {
        return (React.createElement("span", { className: cn("inline-block", className), style: { width, height }, "aria-hidden": "true" }));
    }
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const stepX = data.length > 1 ? width / (data.length - 1) : 0;
    // Inset by half-strokeWidth so the line never gets clipped.
    const pad = strokeWidth / 2;
    const usableHeight = height - pad * 2;
    const points = data.map((v, i) => {
        const x = i * stepX;
        const y = pad + usableHeight - ((v - min) / range) * usableHeight;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const linePath = `M ${points[0]} ` + points.slice(1).map((p) => `L ${p}`).join(" ");
    const fillPath = `M 0,${height} ` +
        points.map((p) => `L ${p}`).join(" ") +
        ` L ${width},${height} Z`;
    const stroke = `hsl(${TONE_TO_VAR[tone]})`;
    return (React.createElement("svg", { role: ariaLabel ? "img" : undefined, "aria-label": ariaLabel, width: width, height: height, viewBox: `0 0 ${width} ${height}`, className: cn("inline-block align-middle", className) },
        fill && (React.createElement("path", { d: fillPath, fill: stroke, fillOpacity: 0.12, stroke: "none" })),
        React.createElement("path", { d: linePath, fill: "none", stroke: stroke, strokeWidth: strokeWidth, strokeLinecap: "round", strokeLinejoin: "round" }),
        React.createElement("circle", { cx: (data.length - 1) * stepX, cy: pad + usableHeight - ((data[data.length - 1] - min) / range) * usableHeight, r: Math.max(1.5, strokeWidth), fill: stroke })));
};
//# sourceMappingURL=sparkline.js.map