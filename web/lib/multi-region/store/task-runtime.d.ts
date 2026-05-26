/**
 * Sticky task runtime — persists active workflow records to localStorage
 * so that page reloads no longer lose them. On boot, any task left in
 * `running` whose heartbeat is stale is reclassified as `interrupted`;
 * the user can hit Resume in the Task Manager to re-run it (idempotent
 * operations like provisioning skip already-created resources).
 *
 * v2 adds:
 *   - per-task progress counters (completed / failed / total)
 *   - elapsed + ETA (linear extrapolation from start-time and ratio done)
 *   - per-step trail (currentStep + ordered history)
 *   - cooperative cancellation flag (cancelRequested) the orchestrator polls
 *   - cross-tab sync via BroadcastChannel — running tasks survive in tab A
 *     even if tab B reloads, because reclassification is gated on heartbeat
 *     staleness rather than the bare presence of a "running" record
 *   - heartbeat-based stall detection (HEARTBEAT_STALE_MS)
 *
 * Schema migration: v1 → v2 preserves all existing fields and zero-fills
 * the new progress fields. Records authored on v2 will not load on v1
 * builds (older code rejects unknown schemaVersion) — that's intentional,
 * the failure mode is empty list rather than corrupted state.
 *
 * This module is deliberately UI-agnostic and decoupled from the agent
 * layer: it only stores task descriptors and emits change events.
 */
export type TaskKind = "provision-accounts" | "create-pools" | "create-pools-smart" | "refresh-chain" | "monitor" | "custom";
export type TaskStatus = 
/** Currently executing in this tab. */
"running"
/** User explicitly stopped the run. */
 | "cancelled"
/** Run finished cleanly. */
 | "completed"
/** Run finished with non-recoverable errors. */
 | "failed"
/** Run finished with mixed results (some succeeded). */
 | "partial"
/**
 * Was running when the page closed/reloaded. Will not auto-resume —
 * shown in Task Manager with a Resume button.
 */
 | "interrupted"
/** User hit Pause; resumeable. */
 | "paused";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export interface TaskStep {
    /** Stable identifier used to update step status across calls. */
    id: string;
    label: string;
    status: StepStatus;
    /** ISO timestamp when this step started running, if it has. */
    startedAt?: string;
    /** ISO timestamp when this step reached a terminal state. */
    endedAt?: string;
    /** Optional one-liner — error message, output snippet, etc. */
    detail?: string;
}
export interface TaskRecord {
    id: string;
    kind: TaskKind;
    /** Human-readable label for the Task Manager UI. */
    label: string;
    status: TaskStatus;
    createdAt: string;
    updatedAt: string;
    /** Last log/progress line, surfaced in the manager. */
    progress?: string;
    /**
     * Original input passed to the agent. Stored verbatim so Resume can
     * re-run with the same parameters. Should be plain JSON-serializable.
     */
    input: Record<string, unknown>;
    /** Subscription scope, when applicable — useful for grouping. */
    subscriptionId?: string;
    /** Final summary from the agent run, if any. */
    summary?: Record<string, unknown>;
    error?: string;
    /** Total number of unit-of-work items, when known. */
    total?: number;
    /** Items processed (succeeded). */
    completed?: number;
    /** Items processed (failed). */
    failed?: number;
    /** Human label of the unit currently being worked. */
    currentStep?: string;
    /** ISO timestamp the task transitioned into `running`. */
    startedAt?: string;
    /**
     * Last time the orchestrator confirmed the task is still alive. Bootstrap
     * uses this to detect stalled "running" rows after a reload.
     */
    lastHeartbeatAt?: string;
    /**
     * Cooperative cancel flag. The orchestrator polls this between iterations
     * and exits with status `cancelled` if it sees true.
     */
    cancelRequested?: boolean;
    /** Optional ordered trail of named sub-steps. */
    steps?: TaskStep[];
}
type Listener = (tasks: TaskRecord[]) => void;
/**
 * Compute ETA in ms from start-time + completed/total ratio. Returns
 * undefined if we don't have enough information yet.
 */
export declare function computeEtaMs(rec: TaskRecord): number | undefined;
/** Convenience: 0..100 progress, accounting for both completed and failed. */
export declare function progressPct(rec: TaskRecord): number | undefined;
declare class TaskRuntime {
    private _tasks;
    private _listeners;
    private _booted;
    private _channel;
    private _heartbeatTimer;
    /**
     * Load persisted tasks and reclassify anything left `running` whose
     * heartbeat is stale as `interrupted`. Tasks with a fresh heartbeat
     * are assumed to be running in another tab and left alone. Idempotent
     * — call once on app boot.
     */
    bootstrap(): void;
    list(): TaskRecord[];
    get(id: string): TaskRecord | undefined;
    /**
     * Create a new task and persist it immediately. Returns the created
     * record so callers can keep the id.
     */
    create(seed: Pick<TaskRecord, "kind" | "label" | "input"> & Partial<Pick<TaskRecord, "subscriptionId" | "total" | "currentStep" | "steps">>): TaskRecord;
    update(id: string, patch: Partial<Omit<TaskRecord, "id" | "createdAt">>): TaskRecord | undefined;
    /**
     * Fast-path progress update used inside hot loops. Patches counters and
     * heartbeat without rewriting the whole record.
     */
    tick(id: string, delta: {
        completed?: number;
        failed?: number;
        total?: number;
        currentStep?: string;
        progress?: string;
    }): TaskRecord | undefined;
    /**
     * Append a step to the trail or update an existing one (matched by `id`).
     * Cheap idempotent helper for the orchestrator.
     */
    upsertStep(taskId: string, step: TaskStep): TaskRecord | undefined;
    /**
     * Cooperative cancellation. The orchestrator must call `isCancelRequested`
     * between iterations and bail out if true.
     */
    requestCancel(id: string): TaskRecord | undefined;
    isCancelRequested(id: string): boolean;
    /**
     * Cooperative pause. The orchestrator polls `isPauseRequested` between
     * iterations, flips status to "paused" via update(), and exits the loop
     * cleanly. Resume is the same code path as resume-after-reload: caller
     * passes `resumeTaskId` to `orchestrator.execute(...)`.
     *
     * Pause is detected via the same heartbeat mechanism cancel uses — there
     * is no separate `pauseRequested` field; instead, the operator flipping
     * status to "paused" via `requestPause` IS the signal. The orchestrator
     * checks `get(id)?.status === "paused"` between iterations.
     */
    requestPause(id: string): TaskRecord | undefined;
    isPauseRequested(id: string): boolean;
    remove(id: string): void;
    clearTerminal(): void;
    /**
     * Bulk-set status on every task whose status is `interrupted`. Used by
     * the resume-prompt's "Discard all" / "Resume all" actions when only a
     * status change is needed (Resume itself is the orchestrator's job; the
     * caller flips the record back to `running` and re-dispatches input).
     */
    setStatusForInterrupted(target: TaskStatus): number;
    subscribe(listener: Listener): () => void;
    /** Test-only — wipe all state without touching storage. */
    _resetForTest(): void;
    private _heartbeat;
    private _save;
    private _emit;
}
export declare const taskRuntime: TaskRuntime;
export {};
//# sourceMappingURL=task-runtime.d.ts.map