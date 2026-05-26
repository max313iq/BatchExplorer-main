/** No-op default — silently drops every record. */
const NOOP_LOGGER = {
    record(_entry) {
        /* intentionally empty */
    },
};
let currentLogger = NOOP_LOGGER;
/**
 * Install a real audit logger. Idempotent — subsequent calls replace
 * the previously-bound logger so tests can swap in their own jest mock
 * between cases.
 */
export function setAuditLogger(logger) {
    currentLogger = logger !== null && logger !== void 0 ? logger : NOOP_LOGGER;
}
/**
 * Read the currently-bound logger. Auth modules call this lazily at
 * each record site rather than capturing at import time so a late
 * `setAuditLogger(...)` still takes effect for subsequent records.
 */
export function getAuditLogger() {
    return currentLogger;
}
/**
 * Convenience wrapper — `recordAuditEvent(entry)` is shorter at call
 * sites than `getAuditLogger().record(entry)` and reads like a
 * top-level function (which is how audit-log usage reads everywhere
 * else in the codebase).
 */
export function recordAuditEvent(entry) {
    try {
        currentLogger.record(entry);
    }
    catch (_a) {
        /* never let an audit-logger bug break a real operation */
    }
}
//# sourceMappingURL=audit-binding.js.map