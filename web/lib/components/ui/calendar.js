import { __rest } from "tslib";
/**
 * Calendar primitive — wraps `react-day-picker`. Used by date-range filters
 * (Monitoring page, Audit Log filters).
 */
import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
function Calendar(_a) {
    var { className, classNames, showOutsideDays = true } = _a, props = __rest(_a, ["className", "classNames", "showOutsideDays"]);
    return (React.createElement(DayPicker, Object.assign({ showOutsideDays: showOutsideDays, className: cn("p-3", className), classNames: Object.assign({ months: "flex flex-col sm:flex-row gap-4", month: "flex flex-col gap-3", caption: "flex justify-center pt-1 relative items-center", caption_label: "text-sm font-medium", nav: "flex items-center gap-1", nav_button: cn(buttonVariants({ variant: "outline", size: "icon-sm" }), "absolute h-7 w-7 bg-transparent"), nav_button_previous: "left-1", nav_button_next: "right-1", table: "w-full border-collapse", head_row: "flex", head_cell: "text-muted-foreground rounded-md w-8 font-normal text-2xs uppercase tracking-wide", row: "flex w-full mt-1", cell: cn("relative p-0 text-center text-sm focus-within:relative focus-within:z-20", "[&:has([aria-selected])]:bg-accent/20 [&:has([aria-selected].day-outside)]:bg-accent/10", "[&:has([aria-selected].day-range-end)]:rounded-r-md [&:has([aria-selected].day-range-start)]:rounded-l-md first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md"), day: cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "h-8 w-8 p-0 font-normal aria-selected:opacity-100"), day_range_start: "day-range-start", day_range_end: "day-range-end", day_selected: "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground", day_today: "bg-accent/20 text-foreground font-semibold", day_outside: "day-outside text-muted-foreground", day_disabled: "text-muted-foreground opacity-50", day_range_middle: "aria-selected:bg-accent/15 aria-selected:text-foreground", day_hidden: "invisible" }, classNames), components: {
            Chevron: ({ orientation }) => orientation === "right" ? (React.createElement(ChevronRight, { className: "h-4 w-4" })) : (React.createElement(ChevronLeft, { className: "h-4 w-4" })),
        } }, props)));
}
Calendar.displayName = "Calendar";
export { Calendar };
//# sourceMappingURL=calendar.js.map