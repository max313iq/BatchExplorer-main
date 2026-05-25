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

const STORAGE_KEY = "mr.task-runtime.v1";
const SCHEMA_VERSION = 2;
const BROADCAST_CHANNEL_NAME = "mr.task-runtime";

/**
 * A "running" task whose lastHeartbeatAt is older than this is considered
 * interrupted. The orchestrator should heartbeat at least every ~5s.
 * 30s gives generous slack for slow tab wake-up after sleep/throttle.
 */
const HEARTBEAT_STALE_MS = 30_000;

export type TaskKind =
  | "provision-accounts"
  | "create-pools"
  | "create-pools-smart"
  | "refresh-chain"
  | "monitor"
  | "custom";

export type TaskStatus =
  /** Currently executing in this tab. */
  | "running"
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

  // ---- v2 fields (progress + ETA) -----------------------------------------
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

interface PersistedShape {
  schemaVersion: number;
  tasks: TaskRecord[];
}

type Listener = (tasks: TaskRecord[]) => void;

function safeGetStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    if (window.localStorage) return window.localStorage;
  } catch {
    /* storage disabled */
  }
  return null;
}

function load(): TaskRecord[] {
  const storage = safeGetStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || !Array.isArray(parsed.tasks)) return [];
    // v1 → v2: accept v1 records as-is; the new fields are simply absent
    // and will be zero-filled by `tick()` once the orchestrator updates them.
    if (parsed.schemaVersion !== SCHEMA_VERSION && parsed.schemaVersion !== 1) {
      return [];
    }
    return parsed.tasks
      .filter((t): t is TaskRecord => t && typeof t.id === "string")
      .map((t) => ({ ...t }));
  } catch {
    return [];
  }
}

function save(tasks: TaskRecord[]): void {
  const storage = safeGetStorage();
  if (!storage) return;
  try {
    const payload: PersistedShape = {
      schemaVersion: SCHEMA_VERSION,
      tasks,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota — degrade silently */
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Compute ETA in ms from start-time + completed/total ratio. Returns
 * undefined if we don't have enough information yet.
 */
export function computeEtaMs(rec: TaskRecord): number | undefined {
  if (rec.status !== "running") return undefined;
  if (!rec.startedAt) return undefined;
  const total = rec.total ?? 0;
  const done = (rec.completed ?? 0) + (rec.failed ?? 0);
  if (total <= 0 || done <= 0) return undefined;
  const elapsedMs = Date.now() - new Date(rec.startedAt).getTime();
  if (elapsedMs <= 0) return undefined;
  const ratio = done / total;
  if (ratio >= 1) return 0;
  // Linear extrapolation: total time ≈ elapsed / ratio. Remaining = total − elapsed.
  const projectedTotal = elapsedMs / ratio;
  return Math.max(0, Math.round(projectedTotal - elapsedMs));
}

/** Convenience: 0..100 progress, accounting for both completed and failed. */
export function progressPct(rec: TaskRecord): number | undefined {
  const total = rec.total ?? 0;
  if (total <= 0) return undefined;
  const done = (rec.completed ?? 0) + (rec.failed ?? 0);
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

class TaskRuntime {
  private _tasks: TaskRecord[] = [];
  private _listeners = new Set<Listener>();
  private _booted = false;
  private _channel: BroadcastChannel | null = null;
  private _heartbeatTimer: number | null = null;

  /**
   * Load persisted tasks and reclassify anything left `running` whose
   * heartbeat is stale as `interrupted`. Tasks with a fresh heartbeat
   * are assumed to be running in another tab and left alone. Idempotent
   * — call once on app boot.
   */
  bootstrap(): void {
    if (this._booted) return;
    const loaded = load();
    const now = Date.now();
    this._tasks = loaded.map((t) => {
      if (t.status !== "running") return t;
      const hb = t.lastHeartbeatAt
        ? new Date(t.lastHeartbeatAt).getTime()
        : t.updatedAt
          ? new Date(t.updatedAt).getTime()
          : 0;
      const stale = now - hb > HEARTBEAT_STALE_MS;
      if (!stale) return t;
      // Keep the task in "interrupted" only for kinds that we can't
      // auto-resume. For the resumeable kinds (create-accounts,
      // create-pools, create-pools-smart) we keep status as `running`
      // and override the visible progress to "Resuming after reload…"
      // so the operator never sees the "Interrupted by reload" flash.
      // `TaskAutoResumer` mounts on the same tick and re-dispatches the
      // task via `resumeTaskId` — the orchestrator adopts this record
      // instead of creating a duplicate.
      const resumeableKinds = new Set([
        "create-accounts",
        "create-pools",
        "create-pools-smart",
        "provision-accounts",
      ]);
      if (resumeableKinds.has(t.kind)) {
        return {
          ...t,
          status: "running",
          updatedAt: nowIso(),
          lastHeartbeatAt: nowIso(),
          currentStep: "Resuming after reload…",
        } as TaskRecord;
      }
      return {
        ...t,
        status: "interrupted",
        updatedAt: nowIso(),
        progress:
          t.progress ??
          "Interrupted by page reload. Click Resume to re-run from the start.",
      } as TaskRecord;
    });
    this._booted = true;

    // Cross-tab sync: any save in this tab broadcasts; messages from other
    // tabs are applied locally without re-broadcast (loop guard via origin).
    if (typeof BroadcastChannel !== "undefined") {
      try {
        this._channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
        this._channel.addEventListener("message", (e) => {
          if (!e.data || e.data.kind !== "tasks-changed") return;
          // Re-load from storage rather than trusting the payload — storage
          // is the source of truth and another tab may have superseded.
          this._tasks = load();
          this._emit();
        });
      } catch {
        this._channel = null;
      }
    }

    // Heartbeat: keep `lastHeartbeatAt` fresh on running tasks even if the
    // orchestrator forgets to tick(). Cheap and prevents false interrupts.
    if (typeof window !== "undefined") {
      this._heartbeatTimer = window.setInterval(() => this._heartbeat(), 5000);
    }

    this._save({ broadcast: false });
    this._emit();
  }

  list(): TaskRecord[] {
    return this._tasks
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): TaskRecord | undefined {
    return this._tasks.find((t) => t.id === id);
  }

  /**
   * Create a new task and persist it immediately. Returns the created
   * record so callers can keep the id.
   */
  create(
    seed: Pick<TaskRecord, "kind" | "label" | "input"> &
      Partial<
        Pick<TaskRecord, "subscriptionId" | "total" | "currentStep" | "steps">
      >,
  ): TaskRecord {
    const now = nowIso();
    const rec: TaskRecord = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "running",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
      completed: 0,
      failed: 0,
      ...seed,
    };
    this._tasks = [rec, ...this._tasks];
    this._save();
    this._emit();
    return rec;
  }

  update(
    id: string,
    patch: Partial<Omit<TaskRecord, "id" | "createdAt">>,
  ): TaskRecord | undefined {
    let updated: TaskRecord | undefined;
    this._tasks = this._tasks.map((t) => {
      if (t.id !== id) return t;
      updated = {
        ...t,
        ...patch,
        updatedAt: nowIso(),
      };
      // If transitioning into `running` for the first time, stamp startedAt.
      if (patch.status === "running" && !updated.startedAt) {
        updated.startedAt = updated.updatedAt;
      }
      // Keep heartbeat fresh on any running update.
      if (updated.status === "running") {
        updated.lastHeartbeatAt = updated.updatedAt;
      }
      return updated;
    });
    if (updated) {
      this._save();
      this._emit();
    }
    return updated;
  }

  /**
   * Fast-path progress update used inside hot loops. Patches counters and
   * heartbeat without rewriting the whole record.
   */
  tick(
    id: string,
    delta: {
      completed?: number;
      failed?: number;
      total?: number;
      currentStep?: string;
      progress?: string;
    },
  ): TaskRecord | undefined {
    return this.update(id, delta);
  }

  /**
   * Append a step to the trail or update an existing one (matched by `id`).
   * Cheap idempotent helper for the orchestrator.
   */
  upsertStep(taskId: string, step: TaskStep): TaskRecord | undefined {
    const existing = this.get(taskId);
    if (!existing) return undefined;
    const steps = (existing.steps ?? []).slice();
    const idx = steps.findIndex((s) => s.id === step.id);
    if (idx >= 0) {
      steps[idx] = { ...steps[idx], ...step };
    } else {
      steps.push(step);
    }
    return this.update(taskId, { steps });
  }

  /**
   * Cooperative cancellation. The orchestrator must call `isCancelRequested`
   * between iterations and bail out if true.
   */
  requestCancel(id: string): TaskRecord | undefined {
    return this.update(id, { cancelRequested: true });
  }

  isCancelRequested(id: string): boolean {
    return this.get(id)?.cancelRequested === true;
  }

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
  requestPause(id: string): TaskRecord | undefined {
    return this.update(id, {
      status: "paused",
      currentStep: "Paused — click Start to resume.",
    });
  }

  isPauseRequested(id: string): boolean {
    return this.get(id)?.status === "paused";
  }

  remove(id: string): void {
    const before = this._tasks.length;
    this._tasks = this._tasks.filter((t) => t.id !== id);
    if (this._tasks.length !== before) {
      this._save();
      this._emit();
    }
  }

  clearTerminal(): void {
    this._tasks = this._tasks.filter(
      (t) =>
        t.status === "running" ||
        t.status === "paused" ||
        t.status === "interrupted",
    );
    this._save();
    this._emit();
  }

  /**
   * Bulk-set status on every task whose status is `interrupted`. Used by
   * the resume-prompt's "Discard all" / "Resume all" actions when only a
   * status change is needed (Resume itself is the orchestrator's job; the
   * caller flips the record back to `running` and re-dispatches input).
   */
  setStatusForInterrupted(target: TaskStatus): number {
    let changed = 0;
    const now = nowIso();
    this._tasks = this._tasks.map((t) => {
      if (t.status !== "interrupted") return t;
      changed++;
      return { ...t, status: target, updatedAt: now };
    });
    if (changed > 0) {
      this._save();
      this._emit();
    }
    return changed;
  }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    listener(this.list());
    return () => {
      this._listeners.delete(listener);
    };
  }

  /** Test-only — wipe all state without touching storage. */
  _resetForTest(): void {
    this._tasks = [];
    this._booted = false;
    this._listeners.clear();
    if (this._channel) {
      try {
        this._channel.close();
      } catch {
        /**/
      }
      this._channel = null;
    }
    if (this._heartbeatTimer !== null && typeof window !== "undefined") {
      window.clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private _heartbeat(): void {
    let touched = false;
    const now = nowIso();
    this._tasks = this._tasks.map((t) => {
      if (t.status !== "running") return t;
      touched = true;
      return { ...t, lastHeartbeatAt: now };
    });
    if (touched) {
      // Heartbeat is a silent write — don't notify listeners, don't broadcast
      // (other tabs are tracking their own running tasks).
      save(this._tasks);
    }
  }

  private _save(opts: { broadcast?: boolean } = {}): void {
    save(this._tasks);
    if (opts.broadcast === false) return;
    if (this._channel) {
      try {
        this._channel.postMessage({ kind: "tasks-changed" });
      } catch {
        /**/
      }
    }
  }

  private _emit(): void {
    const snapshot = this.list();
    for (const l of Array.from(this._listeners)) {
      try {
        l(snapshot);
      } catch {
        /* listener failures are isolated */
      }
    }
  }
}

export const taskRuntime = new TaskRuntime();
