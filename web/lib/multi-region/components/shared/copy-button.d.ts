/**
 * Inline click-to-copy button — small icon-only affordance that pairs with a
 * GUID, ARM resource id, connection string, IP address, or any other
 * "exact-value-the-user-wants-to-paste-elsewhere" cell in the UI.
 *
 * Why a shared component:
 *   - The nodes-page already had a `CopyableIp` local component with the
 *     same clipboard-fallback dance (try `navigator.clipboard`, fall back to
 *     `document.execCommand("copy")` on textarea). Other pages were each
 *     reinventing the same pattern (and some were skipping it entirely).
 *   - The hover/focus reveal + 1.2s "Copied" confirmation needs a single
 *     source of truth so the timeout cleanup is correct (no stray
 *     setState-after-unmount warnings).
 *
 * Two render modes:
 *   - `<CopyButton value="..." />` — bare icon button, no surrounding text.
 *   - `<CopyableText value="..." />` — value rendered as a `<span>` with the
 *     copy button to the right, only visible on hover/focus (uses the same
 *     `group/copy` Tailwind group pattern as nodes-page).
 */
import * as React from "react";
export interface CopyButtonProps {
    /** Value written to the clipboard. */
    value: string;
    /** Optional aria-label override. Defaults to `Copy <value> to clipboard`. */
    ariaLabel?: string;
    /** Optional className applied to the button element. */
    className?: string;
    /** How long to show the "Copied" success state. Defaults to 1200ms. */
    copiedDurationMs?: number;
    /** Optional click hook fired AFTER the value lands on the clipboard. */
    onCopied?: (value: string) => void;
    /** Optional explicit size for the icon (in pixels). Defaults to 12. */
    iconSize?: number;
    /**
     * When true, the button is always visible. Defaults to false, in which
     * case the button only fades in via `group-hover/copy` / `:focus-visible`.
     */
    alwaysVisible?: boolean;
}
/**
 * Standalone icon-only copy button. Pair with the value inside a parent
 * with the Tailwind class `group/copy` if you want the default
 * hover-to-reveal behavior.
 */
export declare const CopyButton: React.FC<CopyButtonProps>;
export interface CopyableTextProps {
    /** Value to render and copy. */
    value: string;
    /** Optional override for the rendered label (defaults to `value`). */
    display?: React.ReactNode;
    /** Optional aria-label override on the inner button. */
    ariaLabel?: string;
    /** Optional className applied to the outer span. */
    className?: string;
    /** Render the value in a monospaced font (resource ids, IPs). */
    mono?: boolean;
    /** Make the button always visible instead of hover-revealed. */
    alwaysVisibleButton?: boolean;
}
/**
 * Value + inline copy button. The button stays hidden until the user hovers
 * the span or focuses the button (matches the nodes-page pattern).
 *
 * Example:
 *   <CopyableText value={node.ipAddress} mono />
 */
export declare const CopyableText: React.FC<CopyableTextProps>;
//# sourceMappingURL=copy-button.d.ts.map