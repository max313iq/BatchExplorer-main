export function formatRelative(iso) {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 1000)
        return "just now";
    if (diff < 60000)
        return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000)
        return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000)
        return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
}
/**
 * Compact, human-friendly duration. Targets at-a-glance scanning in tables;
 * we drop precision on purpose past 1m.
 *
 *   formatDuration(1500)       → "2s"
 *   formatDuration(95_000)     → "1m 35s"
 *   formatDuration(7_200_000)  → "2h 0m"
 *   formatDuration(undefined)  → "—"
 */
export function formatDuration(ms) {
    if (ms === undefined || !isFinite(ms) || ms < 0)
        return "—";
    if (ms < 1000)
        return `${Math.max(0, Math.round(ms))}ms`;
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60)
        return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60)
        return `${min}m ${sec}s`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}h ${remMin}m`;
}
/** Total elapsed time since the task started running. */
export function elapsedMs(rec) {
    if (!rec.startedAt)
        return undefined;
    return Math.max(0, Date.now() - new Date(rec.startedAt).getTime());
}
export const STATUS_LABEL = {
    running: "Running",
    paused: "Paused",
    interrupted: "Interrupted",
    cancelled: "Cancelled",
    completed: "Completed",
    failed: "Failed",
    partial: "Partial",
};
/**
 * Tone class for status pills — keys map to Tailwind classes that follow
 * the project's existing design tokens (success/warning/destructive).
 */
export const STATUS_TONE = {
    running: {
        fg: "text-primary",
        bg: "bg-primary/10",
        ring: "ring-primary/30",
    },
    paused: {
        fg: "text-warning",
        bg: "bg-warning/10",
        ring: "ring-warning/30",
    },
    interrupted: {
        fg: "text-warning",
        bg: "bg-warning/10",
        ring: "ring-warning/30",
    },
    cancelled: {
        fg: "text-muted-foreground",
        bg: "bg-muted/40",
        ring: "ring-muted/40",
    },
    completed: {
        fg: "text-success",
        bg: "bg-success/10",
        ring: "ring-success/30",
    },
    partial: {
        fg: "text-warning",
        bg: "bg-warning/10",
        ring: "ring-warning/30",
    },
    failed: {
        fg: "text-destructive",
        bg: "bg-destructive/10",
        ring: "ring-destructive/30",
    },
};
export function isTerminal(s) {
    return s === "completed" || s === "failed" || s === "cancelled" || s === "partial";
}
//# sourceMappingURL=task-formatting.js.map