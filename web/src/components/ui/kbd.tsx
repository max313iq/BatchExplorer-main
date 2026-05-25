/**
 * Kbd primitive — keyboard-shortcut display. Used in tooltips, command
 * palette items, and the keyboard-shortcut help dialog.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** Optional size override. Default tracks the surrounding text. */
  size?: "xs" | "sm";
}

const Kbd = React.forwardRef<HTMLElement, KbdProps>(
  ({ className, size = "xs", children, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center rounded border border-border bg-muted/60 font-mono text-muted-foreground tabular-nums",
        size === "xs" && "min-w-[1.25rem] px-1 py-0.5 text-2xs",
        size === "sm" && "min-w-[1.5rem] px-1.5 py-0.5 text-xs",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  ),
);
Kbd.displayName = "Kbd";

/**
 * Render a chord ("Ctrl+K") as a sequence of <Kbd> elements joined by "+".
 */
interface KbdChordProps extends Omit<KbdProps, "children"> {
  /** The chord, e.g. "Ctrl+K" or "Alt+1". */
  keys: string;
}

const KbdChord = ({ keys, className, ...rest }: KbdChordProps) => {
  const parts = keys.split(/\s*\+\s*/).filter(Boolean);
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {parts.map((k, i) => (
        <React.Fragment key={`${k}-${i}`}>
          {i > 0 && (
            <span aria-hidden="true" className="text-muted-foreground/60">
              +
            </span>
          )}
          <Kbd {...rest}>{k}</Kbd>
        </React.Fragment>
      ))}
    </span>
  );
};
KbdChord.displayName = "KbdChord";

export { Kbd, KbdChord };
