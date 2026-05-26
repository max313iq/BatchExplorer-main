/**
 * Pagination primitive — used by DataTable and any paginated list view.
 * Wraps `useState`/external pagination state from `use-pagination` hook.
 */
import * as React from "react";
import { type ButtonProps } from "@/components/ui/button";
declare const Pagination: {
    ({ className, ...props }: React.ComponentProps<"nav">): React.JSX.Element;
    displayName: string;
};
declare const PaginationContent: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLUListElement>, HTMLUListElement>, "ref"> & React.RefAttributes<HTMLUListElement>>;
declare const PaginationItem: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.LiHTMLAttributes<HTMLLIElement>, HTMLLIElement>, "ref"> & React.RefAttributes<HTMLLIElement>>;
interface PaginationLinkProps extends Omit<React.ComponentProps<"button">, "type">, Pick<ButtonProps, "size"> {
    isActive?: boolean;
}
declare const PaginationLink: {
    ({ className, isActive, size, ...props }: PaginationLinkProps): React.JSX.Element;
    displayName: string;
};
declare const PaginationPrevious: {
    ({ className, ...props }: React.ComponentProps<"button">): React.JSX.Element;
    displayName: string;
};
declare const PaginationNext: {
    ({ className, ...props }: React.ComponentProps<"button">): React.JSX.Element;
    displayName: string;
};
declare const PaginationFirst: {
    ({ className, ...props }: React.ComponentProps<"button">): React.JSX.Element;
    displayName: string;
};
declare const PaginationLast: {
    ({ className, ...props }: React.ComponentProps<"button">): React.JSX.Element;
    displayName: string;
};
declare const PaginationEllipsis: {
    ({ className, ...props }: React.ComponentProps<"span">): React.JSX.Element;
    displayName: string;
};
export { Pagination, PaginationContent, PaginationLink, PaginationItem, PaginationPrevious, PaginationNext, PaginationFirst, PaginationLast, PaginationEllipsis, };
//# sourceMappingURL=pagination.d.ts.map