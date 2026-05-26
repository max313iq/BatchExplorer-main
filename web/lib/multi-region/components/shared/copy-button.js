import { __awaiter } from "tslib";
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
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
/** Best-effort write to the system clipboard. Returns true on success. */
function writeToClipboard(value) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        // Modern async API first.
        if (typeof navigator !== "undefined" &&
            ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText) !== undefined) {
            try {
                yield navigator.clipboard.writeText(value);
                return true;
            }
            catch (_b) {
                // Permission denied or insecure context — fall through to legacy path.
            }
        }
        // Legacy fallback (synchronous execCommand on a hidden textarea).
        if (typeof document === "undefined")
            return false;
        try {
            const ta = document.createElement("textarea");
            ta.value = value;
            ta.setAttribute("readonly", "");
            ta.style.position = "absolute";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            return ok;
        }
        catch (_c) {
            return false;
        }
    });
}
/**
 * Standalone icon-only copy button. Pair with the value inside a parent
 * with the Tailwind class `group/copy` if you want the default
 * hover-to-reveal behavior.
 */
export const CopyButton = ({ value, ariaLabel, className, copiedDurationMs = 1200, onCopied, iconSize = 12, alwaysVisible = false, }) => {
    const [copied, setCopied] = React.useState(false);
    const timeoutRef = React.useRef(null);
    React.useEffect(() => () => {
        if (timeoutRef.current)
            clearTimeout(timeoutRef.current);
    }, []);
    const handleCopy = React.useCallback((event) => __awaiter(void 0, void 0, void 0, function* () {
        // Don't propagate to a parent row's click handler — copying should be
        // a self-contained action.
        event.stopPropagation();
        event.preventDefault();
        const ok = yield writeToClipboard(value);
        if (!ok)
            return;
        setCopied(true);
        if (timeoutRef.current)
            clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), copiedDurationMs);
        onCopied === null || onCopied === void 0 ? void 0 : onCopied(value);
    }), [value, copiedDurationMs, onCopied]);
    const labelBase = ariaLabel !== null && ariaLabel !== void 0 ? ariaLabel : `Copy ${value} to clipboard`;
    const labelCopied = ariaLabel !== null && ariaLabel !== void 0 ? ariaLabel : `Copied ${value}`;
    return (React.createElement("button", { type: "button", onClick: handleCopy, "aria-label": copied ? labelCopied : labelBase, title: copied ? "Copied" : "Copy", className: cn("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-all duration-150 ease-out hover:bg-accent/30 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", alwaysVisible
            ? "opacity-100"
            : "opacity-0 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100", copied && "opacity-100 text-success", className) }, copied ? (React.createElement(Check, { style: { width: iconSize, height: iconSize }, "aria-hidden": true })) : (React.createElement(Copy, { style: { width: iconSize, height: iconSize }, "aria-hidden": true }))));
};
/**
 * Value + inline copy button. The button stays hidden until the user hovers
 * the span or focuses the button (matches the nodes-page pattern).
 *
 * Example:
 *   <CopyableText value={node.ipAddress} mono />
 */
export const CopyableText = ({ value, display, ariaLabel, className, mono = false, alwaysVisibleButton = false, }) => {
    return (React.createElement("span", { className: cn("group/copy inline-flex items-center gap-1.5 align-middle", className) },
        React.createElement("span", { className: cn(mono ? "font-mono text-xs" : "text-xs") }, display !== null && display !== void 0 ? display : value),
        React.createElement(CopyButton, { value: value, ariaLabel: ariaLabel, alwaysVisible: alwaysVisibleButton })));
};
//# sourceMappingURL=copy-button.js.map