/**
 * Pool Default Settings page — manages OS, start-task, and network defaults
 * applied to all pool-creation flows.
 *
 * Features:
 *  - Diff-tracks against the last saved snapshot, surfaces per-section
 *    "modified" pills, supports global Revert and per-section Discard.
 *  - Named-preset library (save current state under a label, load any of them).
 *  - JSON import/export of the full defaults shape.
 *  - Copy-to-clipboard for the rendered preview and individual resource ids.
 *  - Info tooltips next to every non-obvious field.
 *  - Inline validation surfacing duplicates, missing values, weak passwords,
 *    malformed subnet ARM ids, and non-HTTPS resource URLs.
 *  - Keyboard shortcuts: Ctrl/Cmd+S save, Ctrl/Cmd+Shift+Z revert, Ctrl/Cmd+E
 *    export, Alt+E expand-all, Alt+C collapse-all.
 *  - Quick OS-preset chips for the most common Linux/Windows images.
 */
import * as React from "react";
/**
 * Public page entry — wraps the inner form in an ErrorBoundary so a render
 * failure in any of the sections does not blank the whole dashboard pane.
 */
export declare const PoolDefaultsPage: React.FC;
//# sourceMappingURL=pool-defaults-page.d.ts.map