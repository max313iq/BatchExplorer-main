import * as React from "react";
export interface PageHeaderProps {
    title: string;
    description?: string;
    titleId?: string;
    children?: React.ReactNode;
    className?: string;
}
/**
 * Standard page header for the 12 dashboard pages. Establishes the same
 * h1 size, weight, and tracking everywhere so navigating between pages
 * does not feel jumpy.
 */
export declare const PageHeader: React.FC<PageHeaderProps>;
//# sourceMappingURL=page-header.d.ts.map