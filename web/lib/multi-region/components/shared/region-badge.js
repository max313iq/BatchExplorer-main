import * as React from "react";
import { Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
const TONE_VARIANT = {
    success: "success",
    warning: "warning",
    destructive: "destructive",
    info: "info",
    muted: "secondary",
};
export const RegionBadge = ({ region, gpu, healthy, tone, className, }) => {
    const resolvedTone = healthy === false ? "destructive" : tone !== null && tone !== void 0 ? tone : "muted";
    const variant = TONE_VARIANT[resolvedTone];
    const badge = (React.createElement(Badge, { variant: variant, className: cn("gap-1 font-medium", className), "aria-label": `Region ${region}${gpu ? ", GPU enabled" : ""}${healthy === false ? ", unhealthy" : ""}` },
        React.createElement("span", null, region),
        gpu && React.createElement(Cpu, { className: "h-3 w-3", "aria-hidden": "true" })));
    if (gpu || healthy !== undefined) {
        const tip = [
            gpu ? "GPU support" : null,
            healthy === false ? "Unhealthy" : healthy === true ? "Healthy" : null,
        ]
            .filter(Boolean)
            .join(" - ");
        if (tip) {
            return (React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement("span", null, badge)),
                React.createElement(TooltipContent, null, tip)));
        }
    }
    return badge;
};
//# sourceMappingURL=region-badge.js.map