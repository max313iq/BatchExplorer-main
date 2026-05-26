/**
 * Bulk-actions bar — surfaces when ≥2 tasks are selected. The current
 * single-select model (one row at a time via `c`/`r` hotkey) is great
 * for surgical work but slow when an operator needs to cancel a dozen
 * tasks at once (e.g. after spotting a misconfig that affected a batch).
 *
 * This component is purely visual: parent owns the selection Set and the
 * action handlers, we just render the floating chip with counts + buttons
 * and emit click events. Confirmation is delegated to the existing
 * ConfirmationDialog in this folder.
 *
 * Source-only constraint: no new deps, no shared-component edits.
 */
import * as React from "react";
import { TaskRecord } from "../../store/task-runtime";
export interface BulkActionsBarProps {
    /** Selected task ids. Empty / single-select hides the bar. */
    selectedIds: Set<string>;
    /** Lookup callback so we can resolve ids → TaskRecord for action gating. */
    getTask: (id: string) => TaskRecord | undefined;
    /** Clear the multi-select state. */
    onClear: () => void;
    /** Per-action callbacks — parent decides confirmation flow. */
    onBulkCancel: (ids: string[]) => void;
    onBulkResume: (ids: string[]) => void;
    onBulkPause: (ids: string[]) => void;
    onBulkRemove: (ids: string[]) => void;
    onBulkExport: (ids: string[]) => void;
}
export declare const BulkActionsBar: React.FC<BulkActionsBarProps>;
//# sourceMappingURL=bulk-actions-bar.d.ts.map