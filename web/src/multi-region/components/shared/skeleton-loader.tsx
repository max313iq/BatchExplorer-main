import * as React from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type SkeletonVariant =
  | "table"
  | "card"
  | "stat-bar"
  | "list"
  | "form"
  | "text";

export interface SkeletonLoaderProps {
  variant: SkeletonVariant;
  rows?: number;
  columns?: number;
  cards?: number;
  animate?: boolean;
}

/**
 * `animate=false` is supported because the legacy callers use it for tests
 * and printing snapshots; `Skeleton` itself always pulses, so when animation
 * is disabled we render a non-pulsing div with the same shape.
 */
function bar(
  className: string,
  style: React.CSSProperties,
  animate: boolean,
): React.ReactElement {
  if (animate) {
    return <Skeleton className={className} style={style} />;
  }
  return (
    <div className={cn("rounded-md bg-muted/50", className)} style={style} />
  );
}

function TableSkeleton({
  rows,
  columns,
  animate,
}: {
  rows: number;
  columns: number;
  animate: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        {Array.from({ length: columns }, (_, c) =>
          bar(`flex-1`, { height: 16 }, animate),
        ).map((el, i) => (
          <React.Fragment key={`h-${i}`}>{el}</React.Fragment>
        ))}
      </div>
      <div className="h-px w-full bg-border" />
      {Array.from({ length: rows }, (_, r) => (
        <div key={`r-${r}`} className="flex gap-3">
          {Array.from({ length: columns }, (_, c) =>
            bar(
              `flex-1`,
              {
                height: 14,
                animationDelay: `${(r * columns + c) * 0.05}s`,
              },
              animate,
            ),
          ).map((el, i) => (
            <React.Fragment key={`r-${r}-c-${i}`}>{el}</React.Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

function CardSkeleton({
  cards,
  animate,
}: {
  cards: number;
  animate: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-4">
      {Array.from({ length: cards }, (_, i) => (
        <div
          key={i}
          className="flex w-60 flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          {bar(``, { width: "60%", height: 16 }, animate)}
          {bar(``, { width: "100%", height: 12 }, animate)}
          {bar(``, { width: "80%", height: 12 }, animate)}
        </div>
      ))}
    </div>
  );
}

function StatBarSkeleton({
  animate,
}: {
  animate: boolean;
}): React.ReactElement {
  return (
    <div className="flex gap-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="flex flex-1 flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          {bar(``, { width: "50%", height: 12 }, animate)}
          {bar(``, { width: "70%", height: 24 }, animate)}
        </div>
      ))}
    </div>
  );
}

function ListSkeleton({
  rows,
  animate,
}: {
  rows: number;
  animate: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          {bar(`shrink-0 rounded-full`, { width: 32, height: 32 }, animate)}
          <div className="flex flex-1 flex-col gap-1.5">
            {bar(``, { width: "40%", height: 14 }, animate)}
            {bar(``, { width: "70%", height: 12 }, animate)}
          </div>
        </div>
      ))}
    </div>
  );
}

function FormSkeleton({
  rows,
  animate,
}: {
  rows: number;
  animate: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          {bar(``, { width: "20%", height: 12 }, animate)}
          {bar(``, { width: "100%", height: 32 }, animate)}
        </div>
      ))}
    </div>
  );
}

function TextSkeleton({
  rows,
  animate,
}: {
  rows: number;
  animate: boolean;
}): React.ReactElement {
  const widths = ["100%", "95%", "85%", "90%", "60%"];
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) =>
        bar(``, { width: widths[i % widths.length], height: 14 }, animate),
      ).map((el, i) => (
        <React.Fragment key={i}>{el}</React.Fragment>
      ))}
    </div>
  );
}

export const SkeletonLoader: React.FC<SkeletonLoaderProps> = ({
  variant,
  rows = 5,
  columns = 4,
  cards = 3,
  animate = true,
}) => {
  const content = React.useMemo(() => {
    switch (variant) {
      case "table":
        return (
          <TableSkeleton rows={rows} columns={columns} animate={animate} />
        );
      case "card":
        return <CardSkeleton cards={cards} animate={animate} />;
      case "stat-bar":
        return <StatBarSkeleton animate={animate} />;
      case "list":
        return <ListSkeleton rows={rows} animate={animate} />;
      case "form":
        return <FormSkeleton rows={rows} animate={animate} />;
      case "text":
        return <TextSkeleton rows={rows} animate={animate} />;
    }
  }, [variant, rows, columns, cards, animate]);

  return (
    <div role="progressbar" aria-label="Loading content">
      {content}
    </div>
  );
};
