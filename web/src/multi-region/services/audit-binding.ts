/**
 * Default wiring for the audit-log singleton.
 *
 * The audit-log facade is bound to a store via `bindAuditLogToStore`,
 * but historically the call site for that bind lives in
 * `dashboard-shell.tsx` (outside this pod's edit boundary). To let the
 * pages pod call ONE function during startup instead of importing two
 * different modules, we expose `installDefaultAuditWiring(store)` here
 * — pages call this, we do the bind and return an unsubscribe hook.
 */

import {
  auditLog,
  bindAuditLogToStore,
  unbindAuditLogFromStore,
  type AuditLogStoreBinding,
} from "./audit-log";

/**
 * Wire the audit-log singleton to the store. Returns an unsubscribe
 * function that fully reverses the bind — useful in tests, and a
 * harmless no-op in production where the store outlives the app.
 *
 * Pages call this once at startup. Calling it twice with the same
 * store is idempotent — the second call replaces the first binding
 * (which is what `auditLog.bind` already does internally).
 */
export function installDefaultAuditWiring(
  store: AuditLogStoreBinding,
): () => void {
  bindAuditLogToStore(store);
  return () => {
    unbindAuditLogFromStore();
  };
}

/** Re-export so callers only need one import. */
export { auditLog };
