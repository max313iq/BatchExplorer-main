/**
 * Pure formatting helpers for the Task Manager UI. Kept separate so the
 * page component, sticky panel, and resume-prompt dialog can share them
 * without duplication and so they can be unit-tested without React.
 */
import type { TaskRecord, TaskStatus } from "../../store/task-runtime";
export declare function formatRelative(iso: string): string;
/**
 * Compact, human-friendly duration. Targets at-a-glance scanning in tables;
 * we drop precision on purpose past 1m.
 *
 *   formatDuration(1500)       → "2s"
 *   formatDuration(95_000)     → "1m 35s"
 *   formatDuration(7_200_000)  → "2h 0m"
 *   formatDuration(undefined)  → "—"
 */
export declare function formatDuration(ms: number | undefined): string;
/** Total elapsed time since the task started running. */
export declare function elapsedMs(rec: TaskRecord): number | undefined;
export declare const STATUS_LABEL: Record<TaskStatus, string>;
/**
 * Tone class for status pills — keys map to Tailwind classes that follow
 * the project's existing design tokens (success/warning/destructive).
 */
export declare const STATUS_TONE: Record<TaskStatus, {
    fg: string;
    bg: string;
    ring: string;
}>;
export declare function isTerminal(s: TaskStatus): boolean;
//# sourceMappingURL=task-formatting.d.ts.map