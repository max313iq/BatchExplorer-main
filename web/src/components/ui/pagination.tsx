/**
 * Pagination primitive — used by DataTable and any paginated list view.
 * Wraps `useState`/external pagination state from `use-pagination` hook.
 */
import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  MoreHorizontal,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button, buttonVariants, type ButtonProps } from "@/components/ui/button";

const Pagination = ({ className, ...props }: React.ComponentProps<"nav">) => (
  <nav
    role="navigation"
    aria-label="pagination"
    className={cn("mx-auto flex w-full justify-center", className)}
    {...props}
  />
);
Pagination.displayName = "Pagination";

const PaginationContent = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    className={cn("flex flex-row items-center gap-1", className)}
    {...props}
  />
));
PaginationContent.displayName = "PaginationContent";

const PaginationItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<"li">
>(({ className, ...props }, ref) => (
  <li ref={ref} className={cn("", className)} {...props} />
));
PaginationItem.displayName = "PaginationItem";

interface PaginationLinkProps
  extends Omit<React.ComponentProps<"button">, "type">,
    Pick<ButtonProps, "size"> {
  isActive?: boolean;
}

const PaginationLink = ({
  className,
  isActive,
  size = "icon-sm",
  ...props
}: PaginationLinkProps) => (
  <button
    type="button"
    aria-current={isActive ? "page" : undefined}
    className={cn(
      buttonVariants({
        variant: isActive ? "default" : "ghost",
        size,
      }),
      "tabular-nums",
      className,
    )}
    {...props}
  />
);
PaginationLink.displayName = "PaginationLink";

const PaginationPrevious = ({
  className,
  ...props
}: React.ComponentProps<"button">) => (
  <Button
    type="button"
    variant="ghost"
    size="sm"
    aria-label="Previous page"
    className={cn("gap-1", className)}
    {...props}
  >
    <ChevronLeft className="h-3.5 w-3.5" />
    <span>Previous</span>
  </Button>
);
PaginationPrevious.displayName = "PaginationPrevious";

const PaginationNext = ({
  className,
  ...props
}: React.ComponentProps<"button">) => (
  <Button
    type="button"
    variant="ghost"
    size="sm"
    aria-label="Next page"
    className={cn("gap-1", className)}
    {...props}
  >
    <span>Next</span>
    <ChevronRight className="h-3.5 w-3.5" />
  </Button>
);
PaginationNext.displayName = "PaginationNext";

const PaginationFirst = ({
  className,
  ...props
}: React.ComponentProps<"button">) => (
  <Button
    type="button"
    variant="ghost"
    size="icon-sm"
    aria-label="First page"
    className={className}
    {...props}
  >
    <ChevronsLeft className="h-3.5 w-3.5" />
  </Button>
);
PaginationFirst.displayName = "PaginationFirst";

const PaginationLast = ({
  className,
  ...props
}: React.ComponentProps<"button">) => (
  <Button
    type="button"
    variant="ghost"
    size="icon-sm"
    aria-label="Last page"
    className={className}
    {...props}
  >
    <ChevronsRight className="h-3.5 w-3.5" />
  </Button>
);
PaginationLast.displayName = "PaginationLast";

const PaginationEllipsis = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    aria-hidden="true"
    className={cn("flex h-7 w-7 items-center justify-center", className)}
    {...props}
  >
    <MoreHorizontal className="h-3.5 w-3.5" />
    <span className="sr-only">More pages</span>
  </span>
);
PaginationEllipsis.displayName = "PaginationEllipsis";

export {
  Pagination,
  PaginationContent,
  PaginationLink,
  PaginationItem,
  PaginationPrevious,
  PaginationNext,
  PaginationFirst,
  PaginationLast,
  PaginationEllipsis,
};
