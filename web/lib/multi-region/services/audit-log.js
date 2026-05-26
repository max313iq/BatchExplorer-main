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
class AuditLog {
    constructor() {
        /** Local buffer used until a store is bound. After bind, all reads/writes
         * flow through the store and this stays empty. */
        Object.defineProperty(this, "entries", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "maxEntries", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 500
        });
        Object.defineProperty(this, "listeners", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Set()
        });
        Object.defineProperty(this, "store", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "storeUnsub", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
    }
    /** Bind a store. Existing local entries are flushed into the store. */
    bind(store) {
        if (this.store === store)
            return;
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
    unbind() {
        if (this.storeUnsub) {
            this.storeUnsub();
            this.storeUnsub = null;
        }
        this.store = null;
    }
    record(entry) {
        const full = Object.assign(Object.assign({}, entry), { id: crypto.randomUUID(), timestamp: new Date().toISOString() });
        if (this.store) {
            this.store.addAuditEntry(full);
            // Store binding emits its own change events; nothing else to do.
        }
        else {
            this.entries.push(full);
            if (this.entries.length > this.maxEntries) {
                this.entries = this.entries.slice(-this.maxEntries);
            }
            this.notify();
        }
        return full;
    }
    getEntries(limit) {
        const src = this.store ? this.store.getAuditEntries() : this.entries;
        if (limit === undefined)
            return [...src];
        return src.slice(-limit);
    }
    getEntriesByAction(action) {
        return this.getEntries().filter((e) => e.action === action);
    }
    getEntriesByActor(actor) {
        return this.getEntries().filter((e) => e.actor === actor);
    }
    clear() {
        if (this.store) {
            this.store.clearAuditEntries();
        }
        else {
            this.entries = [];
            this.notify();
        }
    }
    onChange(listener) {
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
    subscribe(filter, listener) {
        let prevIds = this.getEntries().filter(filter).map((e) => e.id).join("|");
        const onChange = () => {
            const matches = this.getEntries().filter(filter);
            const ids = matches.map((e) => e.id).join("|");
            if (ids !== prevIds) {
                prevIds = ids;
                try {
                    listener();
                }
                catch (_a) {
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
    export() {
        return {
            version: AUDIT_EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            entries: this.getEntries(),
        };
    }
    toJSON() {
        return this.getEntries();
    }
    notify() {
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
export function bindAuditLogToStore(store) {
    auditLog.bind(store);
}
export function unbindAuditLogFromStore() {
    auditLog.unbind();
}
//# sourceMappingURL=audit-log.js.map