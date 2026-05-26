/**
 * ScrollArea primitive — Radix ScrollArea wrapping. Used inside Sheet,
 * Popover, and DataTable bodies for consistent scrollbar styling across
 * platforms.
 */
import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
declare const ScrollArea: React.ForwardRefExoticComponent<Omit<ScrollAreaPrimitive.ScrollAreaProps & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
declare const ScrollBar: React.ForwardRefExoticComponent<Omit<ScrollAreaPrimitive.ScrollAreaScrollbarProps & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
export { ScrollArea, ScrollBar };
//# sourceMappingURL=scroll-area.d.ts.map