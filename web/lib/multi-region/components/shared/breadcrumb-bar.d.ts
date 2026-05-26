/**
 * Route-aware breadcrumb bar. Used in the dashboard shell header. Reads
 * the current URL via `useLocation` and renders a trail derived from the
 * canonical route map (Design Contract §4.1). Deep-link params (account id,
 * pool id) become trailing crumbs.
 */
import * as React from "react";
export interface BreadcrumbBarProps {
    className?: string;
    /**
     * Optional mapping from URL param values to friendly labels. Pages that
     * navigate to a deep link can call this once they've resolved the
     * underlying entity name (e.g. account display name).
     */
    paramLabels?: Record<string, string>;
}
export declare const BreadcrumbBar: React.FC<BreadcrumbBarProps>;
//# sourceMappingURL=breadcrumb-bar.d.ts.map