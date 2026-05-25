import * as React from "react";

import { Skeleton } from "@/components/ui/skeleton";

export interface LoadingSkeletonProps {
  /** Number of shimmer lines to render. Defaults to 3. */
  lines?: number;
  /** CSS width of the skeleton container. Defaults to "100%". */
  width?: string;
  /** Height of each shimmer line in pixels. Defaults to 14. */
  lineHeight?: number;
}

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({
  lines = 3,
  width = "100%",
  lineHeight = 14,
}) => {
  return (
    <div
      className="flex flex-col gap-2"
      style={{ width }}
      role="progressbar"
      aria-label="Loading content"
    >
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="rounded"
          style={{
            height: lineHeight,
            width: i === lines - 1 ? "60%" : "100%",
          }}
        />
      ))}
    </div>
  );
};
