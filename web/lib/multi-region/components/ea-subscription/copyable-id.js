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
import { cn } from "@/lib/utils";
import { CopyButton } from "../shared/copy-button";
export const CopyableId = ({ value, label }) => (React.createElement("span", { className: cn("group/copy inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-sunken px-2 py-1 font-mono text-2xs text-foreground", "transition-all duration-200 ease-out hover:border-primary/60 hover:bg-accent/5", "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background") },
    React.createElement("span", { className: "truncate" }, value),
    React.createElement(CopyButton, { value: value, ariaLabel: label ? `Copy ${label}` : `Copy ${value}`, iconSize: 12, alwaysVisible: true })));
//# sourceMappingURL=copyable-id.js.map