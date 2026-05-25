import * as React from "react";

import { cn } from "@/lib/utils";

export interface RegionHealthRow {
  name: string;
  healthy: number;
  total: number;
}

export interface RegionHealthChartProps {
  regions: RegionHealthRow[];
  className?: string;
}

const BAR_HEIGHT = 12;

export const RegionHealthChart: React.FC<RegionHealthChartProps> = ({
  regions,
  className,
}) => {
  const sorted = React.useMemo(
    () => [...regions].sort((a, b) => b.total - a.total),
    [regions],
  );

  if (sorted.length === 0) {
    return (
      <div
        className={cn(
          "flex h-32 items-center justify-center rounded-md border border-dashed border-border bg-surface-sunken/40 text-xs text-muted-foreground",
          className,
        )}
        role="status"
        aria-label="No region data yet"
      >
        No region data yet
      </div>
    );
  }

  const maxTotal = Math.max(...sorted.map((r) => r.total), 1);
  const totalHealthy = sorted.reduce((s, r) => s + r.healthy, 0);
  const totalAccounts = sorted.reduce((s, r) => s + r.total, 0);
  const summary = `Region health: ${totalHealthy} healthy of ${totalAccounts} across ${sorted.length} regions`;

  return (
    <div
      className={cn("flex w-full flex-col gap-1.5", className)}
      role="img"
      aria-label={summary}
    >
      {sorted.map((r) => {
        const widthPct = (r.total / maxTotal) * 100;
        const fraction = r.total > 0 ? r.healthy / r.total : 0;
        const healthyPct = widthPct * fraction;
        const rowLabel = `${r.name}: ${r.healthy} healthy of ${r.total}`;
        const fullyHealthy = r.healthy === r.total && r.total > 0;
        const partial = r.healthy > 0 && r.healthy < r.total;
        return (
          <div
            key={r.name}
            className="flex items-center gap-2"
            aria-label={rowLabel}
            role="presentation"
          >
            {/*
              Live status dot — pulses for fully-healthy regions (green ping
              ring), warning tone for partial, destructive for zero. Driven
              by the global .live-pulse-dot utility which respects
              prefers-reduced-motion.
            */}
            <span
              className="live-pulse-dot shrink-0"
              style={{
                ["--live-tone" as never]: fullyHealthy
                  ? "var(--success)"
                  : partial
                    ? "var(--warning)"
                    : "var(--destructive)",
              }}
              aria-hidden="true"
            />
            <span
              className="w-24 shrink-0 truncate text-xs font-medium text-foreground"
              title={r.name}
            >
              {r.name}
            </span>
            <div
              className={cn(
                "relative flex-1 overflow-hidden rounded-sm bg-transparent",
                // Healthy bars get a subtle outer glow so the row visibly
                // hums. The .live-glow-bar utility owns the keyframe.
                fullyHealthy && "live-glow-bar",
              )}
              style={
                {
                  height: BAR_HEIGHT,
                  ["--live-tone" as never]: "var(--success)",
                } as React.CSSProperties
              }
              aria-hidden="true"
            >
              <svg
                className="h-full w-full"
                preserveAspectRatio="none"
                viewBox="0 0 100 1"
                focusable="false"
              >
                <rect
                  x={0}
                  y={0}
                  width={widthPct}
                  height={1}
                  rx={0.15}
                  ry={0.15}
                  className="fill-muted"
                />
                <rect
                  x={0}
                  y={0}
                  width={healthyPct}
                  height={1}
                  rx={0.15}
                  ry={0.15}
                  className="fill-success"
                />
              </svg>
            </div>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums">
              <span
                className={cn(
                  "font-semibold",
                  fullyHealthy
                    ? "text-success"
                    : r.healthy === 0
                      ? "text-destructive"
                      : "text-foreground",
                )}
              >
                {r.healthy}
              </span>
              <span className="text-muted-foreground/70">/{r.total}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
};
