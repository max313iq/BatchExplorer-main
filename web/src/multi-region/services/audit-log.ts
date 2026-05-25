/**
 * Audit log — records destructive / mutating actions in a session-local,
 * subscribable, capped buffer.
 *
 * Per Design Contract §8 + Plan G, the canonical audit history lives in the
 * MultiRegionStore (`auditEntries` slice). This module preserves the
 * external `auditLog.{record, getEntries, onChange, clear}` API so existing
 * call sites keep working, but bridges into the store when one is bound via
 * `bindAuditLogToStore(store)`. Until a store is bound, entries accumulate
 * locally and are flushed on bind.
 *
 * Migration path:
 *   1) Existing services keep calling `auditLog.record(...)` — unchanged.
 *   2) `MultiRegionDashboard` calls `bindAuditLogToStore(store)` on mount.
 *   3) The audit-log page reads from `state.auditEntries` (already in
 *      store-types) instead of from the singleton — see Tier-5 page work.
 */

export interface AuditEntry {
  id: string;
  timestamp: string; // ISO
  actor: string; // username/email from MSAL
  action: string; // e.g. "resize_pool", "delete_nodes", "login"
  target: string; // e.g. "pool:mypool1 @ account:batch001"
  details?: Record<string, unknown>;
  status: "success" | "failure";
  error?: string;
}

/**
 * Minimal interface for auth / agent pods to record audit events without
 * coupling to the full `AuditLog` singleton. They receive an `AuditLogger`
 * via DI so unit tests can stub it without spinning up the audit-log
 * pub/sub.
 */
export interface AuditLogger {
  /** Record an audit entry. Returns the persisted entry (with id + timestamp). */
  record(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry;
}

/**
 * Predicate type for `auditLog.subscribe(filter, listener)`. Receives one
 * audit entry; return true to keep, false to drop. Predicates run on
 * every store change — keep them O(1).
 */
export type AuditFilter = (entry: AuditEntry) => boolean;

/**
 * Shape returned by `auditLog.export()`. Stable across versions so the
 * download blob remains parseable by future builds.
 */
export interface AuditExport {
  /** Schema version — bump when the entry shape changes. */
  version: number;
  /** ISO timestamp the export was produced. */
  exportedAt: string;
  /** Audit entries, newest first. */
  entries: AuditEntry[];
}

/**
 * Minimal store binding the audit log uses. Defined as an interface (not
 * imported from MultiRegionStore directly) so we don't introduce a circular
 * dependency between services and the store. `MultiRegionStore` already
 * satisfies this shape via `addAuditEntry` / `getState().auditEntries` /
 * `clearAuditEntries`.
 */
export interface AuditLogStoreBinding {
  addAuditEntry(entry: AuditEntry): void;
  getAuditEntries(): AuditEntry[];
  clearAuditEntries(): void;
  subscribeAuditLog(listener: () => void): () => void;
}

class AuditLog {
  /** Local buffer used until a store is bound. After bind, all reads/writes
   * flow through the store and this stays empty. */
  private entries: AuditEntry[] = [];
  private maxEntries = 500;
  private listeners: Set<() => void> = new Set();
  private store: AuditLogStoreBinding | null = null;
  private storeUnsub: (() => void) | null = null;

  /** Bind a store. Existing local entries are flushed into the store. */
  bind(store: AuditLogStoreBinding): void {
    if (this.store === store) return;
    this.unbind();
    this.store = store;
    // Flush any locally buffered entries into the store
    for (const entry of this.entries) {
      store.addAuditEntry(entry);
    }
    this.entries = [];
    // Mirror store changes to local listeners so existing onChange consumers
    // keep firing without coupling to react-context.
    this.storeUnsub = store.subscribeAuditLog(() => this.notify());
  }

  /** Unbind the current store. Safe to call multiple times. */
  unbind(): void {
    if (this.storeUnsub) {
      this.storeUnsub();
      this.storeUnsub = null;
    }
    this.store = null;
  }

  record(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
    if (this.store) {
      this.store.addAuditEntry(full);
      // Store binding emits its own change events; nothing else to do.
    } else {
      this.entries.push(full);
      if (this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(-this.maxEntries);
      }
      this.notify();
    }
    return full;
  }

  getEntries(limit?: number): AuditEntry[] {
    const src = this.store ? this.store.getAuditEntries() : this.entries;
    if (limit === undefined) return [...src];
    return src.slice(-limit);
  }

  getEntriesByAction(action: string): AuditEntry[] {
    return this.getEntries().filter((e) => e.action === action);
  }

  getEntriesByActor(actor: string): AuditEntry[] {
    return this.getEntries().filter((e) => e.actor === actor);
  }

  clear(): void {
    if (this.store) {
      this.store.clearAuditEntries();
    } else {
      this.entries = [];
      this.notify();
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Filtered subscription — `listener` is called only when an entry
   * matching `filter` arrives or when filter-matching state changes.
   *
   * Implementation: subscribes to every change AND re-evaluates the
   * predicate against the latest entries. If the filtered slice
   * differs from the previously delivered slice (by id list), we fire.
   * That keeps the API "you only get pinged for entries you care
   * about" without exposing the listener to the full audit volume.
   */
  subscribe(filter: AuditFilter, listener: () => void): () => void {
    let prevIds = this.getEntries().filter(filter).map((e) => e.id).join("|");
    const onChange = (): void => {
      const matches = this.getEntries().filter(filter);
      const ids = matches.map((e) => e.id).join("|");
      if (ids !== prevIds) {
        prevIds = ids;
        try {
          listener();
        } catch {
          /* listener errors don't poison the audit pipeline */
        }
      }
    };
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  /**
   * Build a JSON-serializable snapshot of the audit log suitable for
   * download / archival. Schema includes a `version` so the consumer can
   * adapt across builds — bump `AUDIT_EXPORT_VERSION` if the entry
   * shape ever changes.
   */
  export(): AuditExport {
    return {
      version: AUDIT_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      entries: this.getEntries(),
    };
  }

  toJSON(): AuditEntry[] {
    return this.getEntries();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Stable schema version stamped on every `auditLog.export()` blob. */
export const AUDIT_EXPORT_VERSION = 1;

export const auditLog = new AuditLog();

/**
 * Bind the singleton audit log to a store. Call once during app startup
 * (typically in `MultiRegionDashboard` after the store is constructed).
 */
export function bindAuditLogToStore(store: AuditLogStoreBinding): void {
  auditLog.bind(store);
}

export function unbindAuditLogFromStore(): void {
  auditLog.unbind();
}
