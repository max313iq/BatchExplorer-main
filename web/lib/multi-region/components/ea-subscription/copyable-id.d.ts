/**
 * CopyableId — extracted from ea-subscription-page.tsx so both that page
 * and the AcceptOwnershipPanel sibling can share one implementation.
 *
 * Small inline pill that displays a (possibly long) ID with an inline
 * click-to-copy affordance. Delegates the copy interaction to the shared
 * `<CopyButton>` so the legacy `document.execCommand("copy")` fallback
 * works in sandboxed iframes where `navigator.clipboard` is blocked.
 */
import * as React from "react";
export interface CopyableIdProps {
    value: string;
    label?: string;
}
export declare const CopyableId: React.FC<CopyableIdProps>;
//# sourceMappingURL=copyable-id.d.ts.map