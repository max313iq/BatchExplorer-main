import * as React from "react";
import { Cpu } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type RegionBadgeTone = "success" | "warning" | "destructive" | "info" | "muted";

const TONE_VARIANT: Record<
  RegionBadgeTone,
  "success" | "warning" | "destructive" | "info" | "secondary"
> = {
  success: "success",
  warning: "warning",
  destructive: "destructive",
  info: "info",
  muted: "secondary",
};

export interface RegionBadgeProps {
  region: string;
  gpu?: boolean;
  healthy?: boolean;
  tone?: RegionBadgeTone;
  className?: string;
}

export const RegionBadge: React.FC<RegionBadgeProps> = ({
  region,
  gpu,
  healthy,
  tone,
  className,
}) => {
  const resolvedTone: RegionBadgeTone =
    healthy === false ? "destructive" : tone ?? "muted";
  const variant = TONE_VARIANT[resolvedTone];

  const badge = (
    <Badge
      variant={variant}
      className={cn("gap-1 font-medium", className)}
      aria-label={`Region ${region}${gpu ? ", GPU enabled" : ""}${healthy === false ? ", unhealthy" : ""}`}
    >
      <span>{region}</span>
      {gpu && <Cpu className="h-3 w-3" aria-hidden="true" />}
    </Badge>
  );

  if (gpu || healthy !== undefined) {
    const tip = [
      gpu ? "GPU support" : null,
      healthy === false ? "Unhealthy" : healthy === true ? "Healthy" : null,
    ]
      .filter(Boolean)
      .join(" - ");
    if (tip) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>{badge}</span>
          </TooltipTrigger>
          <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
      );
    }
  }

  return badge;
};
