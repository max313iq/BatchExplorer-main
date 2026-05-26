/**
 * RegionAgentHeatmap — region × agent intensity grid for the Monitoring
 * page. Each cell shows the log count for (region, agent) inside the
 * currently-visible window; intensity scales to the global max so the
 * eye lands on the hottest pair.
 *
 * Rationale: the per-region bar chart (`RegionHealthChart`) answers
 * "which regions hold accounts" but says nothing about *which agent* is
 * doing the work. The heatmap surfaces the cross-section so a noisy
 * `provisioner` in a single region pops out without scanning logs.
 *
 * Citation: `New folder\_analysis_netspi.md` §I — region-scoped agent
 * activity bursts are the visible footprint of resource-plane abuse.
 *
 * Pure presentational; the parent passes a fully-derived matrix.
 */
import * as React from "react";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface HeatmapCell {
  region: string;
  agent: string;
  count: number;
  errors: number;
}

export interface RegionAgentHeatmapProps {
  cells: ReadonlyArray<HeatmapCell>;
  regions: ReadonlyArray<string>;
  agents: ReadonlyArray<string>;
  onCellClick?: (region: string, agent: string) => void;
  selectedRegion?: string | null;
  className?: string;
}

const CELL_SIZE = 22;

/**
 * Map a normalized intensity in [0,1] to a Tailwind background utility.
 * We avoid arbitrary inline RGB so the cell colours track the active
 * theme; the muted track + primary fill are theme-aware.
 */
function intensityClass(t: number, hasErrors: boolean): string {
  if (t <= 0) return "bg-muted/20";
  if (hasErrors) {
    if (t < 0.15) return "bg-destructive/15";
    if (t < 0.35) return "bg-destructive/30";
    if (t < 0.6) return "bg-destructive/55";
    if (t < 0.85) return "bg-destructive/75";
    return "bg-destructive";
  }
  if (t < 0.15) return "bg-primary/15";
  if (t < 0.35) return "bg-primary/30";
  if (t < 0.6) return "bg-primary/55";
  if (t < 0.85) return "bg-primary/75";
  return "bg-primary";
}

export const RegionAgentHeatmap: React.FC<RegionAgentHeatmapProps> = ({
  cells,
  regions,
  agents,
  onCellClick,
  selectedRegion,
  className,
}) => {
  // Index cells by `region|agent` for O(1) lookup during render.
  const cellMap = React.useMemo(() => {
    const m = new Map<string, HeatmapCell>();
    let max = 0;
    for (const c of cells) {
      m.set(`${c.region}|${c.agent}`, c);
      if (c.count > max) max = c.count;
    }
    return { m, max };
  }, [cells]);

  if (regions.length === 0 || agents.length === 0) {
    return (
      <div
        className={cn(
          "flex h-24 items-center justify-center rounded-md border border-dashed border-border bg-surface-sunken/40 text-xs text-muted-foreground",
          className,
        )}
        role="status"
        aria-label="No region × agent data to plot"
      >
        No region × agent data yet
      </div>
    );
  }

  return (
    <div
      className={cn("overflow-x-auto rounded-md border border-border", className)}
      role="figure"
      aria-label={`Region × agent activity heatmap (${regions.length} regions, ${agents.length} agents)`}
    >
      <table className="w-full border-collapse text-2xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-2 py-1 text-left font-semibold uppercase tracking-wider text-muted-foreground">
              Region \ Agent
            </th>
            {agents.map((a) => (
              <th
                key={a}
                scope="col"
                className="px-1 py-1 text-center font-medium uppercase tracking-wide text-muted-foreground"
              >
                <span className="block max-w-[64px] truncate" title={a}>
                  {a}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {regions.map((r) => (
            <tr
              key={r}
              className={cn(
                selectedRegion === r && "bg-primary/5",
              )}
            >
              <th
                scope="row"
                className={cn(
                  "sticky left-0 z-10 bg-card px-2 py-0.5 text-left font-medium",
                  selectedRegion === r ? "text-primary" : "text-foreground",
                )}
                title={r}
              >
                <span className="block max-w-[120px] truncate">{r}</span>
              </th>
              {agents.map((a) => {
                const cell = cellMap.m.get(`${r}|${a}`);
                const count = cell?.count ?? 0;
                const errors = cell?.errors ?? 0;
                const t = cellMap.max > 0 ? count / cellMap.max : 0;
                const label = `Region ${r}, agent ${a}: ${count} log lines${errors > 0 ? ` (${errors} error${errors === 1 ? "" : "s"})` : ""}`;
                return (
                  <td key={a} className="p-0.5 align-middle">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={
                            onCellClick && count > 0
                              ? () => onCellClick(r, a)
                              : undefined
                          }
                          disabled={!onCellClick || count === 0}
                          aria-label={label}
                          className={cn(
                            "block rounded-sm border border-transparent",
                            "transition-colors duration-150 ease-out motion-reduce:transition-none",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            count > 0 && onCellClick
                              ? "cursor-pointer hover:border-foreground/40"
                              : "cursor-default",
                            intensityClass(t, errors > 0),
                          )}
                          style={{
                            width: CELL_SIZE,
                            height: CELL_SIZE,
                          }}
                        >
                          {count > 0 && (
                            <span
                              className={cn(
                                "block text-center text-[9px] font-semibold leading-none",
                                t > 0.6 ? "text-card" : "text-foreground/80",
                              )}
                            >
                              {count > 99 ? "99+" : count}
                            </span>
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <div className="flex flex-col gap-0.5 text-2xs">
                          <span className="font-semibold">{r} · {a}</span>
                          <span className="text-muted-foreground">
                            {count} log line{count === 1 ? "" : "s"}
                          </span>
                          {errors > 0 && (
                            <span className="text-destructive">
                              {errors} error{errors === 1 ? "" : "s"}
                            </span>
                          )}
                          {onCellClick && count > 0 && (
                            <span className="text-muted-foreground/80">
                              Click to filter logs to this pair
                            </span>
                          )}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
