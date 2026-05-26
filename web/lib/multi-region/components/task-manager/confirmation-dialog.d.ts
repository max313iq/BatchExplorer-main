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
export declare const ConfirmationDialog: React.FC<ConfirmationDialogProps>;
//# sourceMappingURL=confirmation-dialog.d.ts.map