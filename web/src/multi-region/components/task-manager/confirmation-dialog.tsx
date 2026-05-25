/**
 * Reusable confirmation dialog scoped to the Task Manager folder.
 *
 * Why local to this folder (not in /components/ui):
 *   The HARD constraint of the page-improvement task is "no shared
 *   component" edits. Co-locating the confirmation dialog here keeps the
 *   change surface entirely under the task-manager folder while still
 *   letting the page (and its sibling files) reuse it for any
 *   destructive action — Clear finished, Discard all, Remove, etc.
 *
 * Design notes:
 *   - Built on top of the existing Radix Dialog primitive (UI component
 *     already shipped) so it inherits portal/overlay/focus-trap
 *     behavior, ESC-to-cancel, and click-outside dismissal.
 *   - The destructive variant uses the destructive token via Button
 *     variant — no new color tokens introduced.
 *   - `details` is an optional render-prop for showing the things that
 *     would be deleted/affected, surfaced as a soft tinted bullet block.
 */
import * as React from "react";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ConfirmationTone = "default" | "destructive" | "warning";

export interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /**
   * Optional list of items (or any node) describing what will be affected.
   * Rendered in a tinted bullet block so the user can scan before confirming.
   */
  details?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmationTone;
  onConfirm: () => void;
  /** Disables the confirm button while async work is in flight. */
  busy?: boolean;
}

const TONE_ICON: Record<ConfirmationTone, React.ReactElement> = {
  default: <Info className="h-5 w-5 text-info" />,
  destructive: <ShieldAlert className="h-5 w-5 text-destructive" />,
  warning: <AlertTriangle className="h-5 w-5 text-warning" />,
};

const TONE_RING: Record<ConfirmationTone, string> = {
  default: "ring-info/30 bg-info/10",
  destructive: "ring-destructive/30 bg-destructive/10",
  warning: "ring-warning/30 bg-warning/10",
};

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  details,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  busy = false,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1",
                TONE_RING[tone],
              )}
            >
              {TONE_ICON[tone]}
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle>{title}</DialogTitle>
              {description && (
                <DialogDescription className="mt-1">
                  {description}
                </DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>

        {details && (
          <div
            className={cn(
              "max-h-48 overflow-auto rounded-md border px-3 py-2 text-xs",
              tone === "destructive" &&
                "border-destructive/20 bg-destructive/5 text-destructive/90",
              tone === "warning" &&
                "border-warning/20 bg-warning/5 text-warning/90",
              tone === "default" && "border-border bg-surface-base/40 text-foreground/80",
            )}
          >
            {details}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === "destructive" ? "destructive" : "default"}
            onClick={() => {
              onConfirm();
            }}
            disabled={busy}
            className="gap-1.5"
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
