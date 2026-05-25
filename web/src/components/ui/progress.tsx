import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "@/lib/utils";

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
    indeterminate?: boolean;
  }
>(({ className, value, indeterminate, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-1 w-full overflow-hidden rounded-full bg-muted",
      className,
    )}
    {...props}
  >
    {indeterminate ? (
      <div
        className="absolute inset-y-0 -left-1/3 w-1/3 rounded-full bg-primary"
        style={{
          animation: "progress-indeterminate 1.4s ease-in-out infinite",
        }}
      />
    ) : (
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 bg-primary transition-transform"
        style={{
          transform: `translateX(-${100 - (value || 0)}%)`,
        }}
      />
    )}
    <style>{`
            @keyframes progress-indeterminate {
                0% { transform: translateX(0); }
                100% { transform: translateX(400%); }
            }
        `}</style>
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
