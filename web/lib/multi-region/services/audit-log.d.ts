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
    timestamp: string;
    actor: string;
    action: string;
    target: string;
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
declare class AuditLog {
    /** Local buffer used until a store is bound. After bind, all reads/writes
     * flow through the store and this stays empty. */
    private entries;
    private maxEntries;
    private listeners;
    private store;
    private storeUnsub;
    /** Bind a store. Existing local entries are flushed into the store. */
    bind(store: AuditLogStoreBinding): void;
    /** Unbind the current store. Safe to call multiple times. */
    unbind(): void;
    record(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry;
    getEntries(limit?: number): AuditEntry[];
    getEntriesByAction(action: string): AuditEntry[];
    getEntriesByActor(actor: string): AuditEntry[];
    clear(): void;
    onChange(listener: () => void): () => void;
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
    subscribe(filter: AuditFilter, listener: () => void): () => void;
    /**
     * Build a JSON-serializable snapshot of the audit log suitable for
     * download / archival. Schema includes a `version` so the consumer can
     * adapt across builds — bump `AUDIT_EXPORT_VERSION` if the entry
     * shape ever changes.
     */
    export(): AuditExport;
    toJSON(): AuditEntry[];
    private notify;
}
/** Stable schema version stamped on every `auditLog.export()` blob. */
export declare const AUDIT_EXPORT_VERSION = 1;
export declare const auditLog: AuditLog;
/**
 * Bind the singleton audit log to a store. Call once during app startup
 * (typically in `MultiRegionDashboard` after the store is constructed).
 */
export declare function bindAuditLogToStore(store: AuditLogStoreBinding): void;
export declare function unbindAuditLogFromStore(): void;
export {};
//# sourceMappingURL=audit-log.d.ts.map