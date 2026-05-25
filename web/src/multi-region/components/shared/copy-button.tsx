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
async function writeToClipboard(value: string): Promise<boolean> {
  // Modern async API first.
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard?.writeText !== undefined
  ) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission denied or insecure context — fall through to legacy path.
    }
  }
  // Legacy fallback (synchronous execCommand on a hidden textarea).
  if (typeof document === "undefined") return false;
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
  } catch {
    return false;
  }
}

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
export const CopyButton: React.FC<CopyButtonProps> = ({
  value,
  ariaLabel,
  className,
  copiedDurationMs = 1200,
  onCopied,
  iconSize = 12,
  alwaysVisible = false,
}) => {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const handleCopy = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      // Don't propagate to a parent row's click handler — copying should be
      // a self-contained action.
      event.stopPropagation();
      event.preventDefault();
      const ok = await writeToClipboard(value);
      if (!ok) return;
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(
        () => setCopied(false),
        copiedDurationMs,
      );
      onCopied?.(value);
    },
    [value, copiedDurationMs, onCopied],
  );

  const labelBase = ariaLabel ?? `Copy ${value} to clipboard`;
  const labelCopied = ariaLabel ?? `Copied ${value}`;

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? labelCopied : labelBase}
      title={copied ? "Copied" : "Copy"}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-all duration-150 ease-out hover:bg-accent/30 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100",
        copied && "opacity-100 text-success",
        className,
      )}
    >
      {copied ? (
        <Check style={{ width: iconSize, height: iconSize }} aria-hidden />
      ) : (
        <Copy style={{ width: iconSize, height: iconSize }} aria-hidden />
      )}
    </button>
  );
};

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
export const CopyableText: React.FC<CopyableTextProps> = ({
  value,
  display,
  ariaLabel,
  className,
  mono = false,
  alwaysVisibleButton = false,
}) => {
  return (
    <span
      className={cn(
        "group/copy inline-flex items-center gap-1.5 align-middle",
        className,
      )}
    >
      <span className={cn(mono ? "font-mono text-xs" : "text-xs")}>
        {display ?? value}
      </span>
      <CopyButton
        value={value}
        ariaLabel={ariaLabel}
        alwaysVisible={alwaysVisibleButton}
      />
    </span>
  );
};
