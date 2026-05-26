/**
 * Dependency-injection binding for the auth-subsystem's audit logger.
 *
 * Why this exists: the canonical `auditLog` instance lives in
 * `services/audit-log.ts`, which is OUTSIDE the auth folder's edit
 * boundary. Auth modules call `getAuditLogger().record(...)` so we can
 * surface every sensitive operation (login, logout, token redemption,
 * vault put / remove, etc.) without importing a service-layer module
 * directly.
 *
 * Wiring contract: another pod (the services-layer / app-bootstrap
 * agent) imports `setAuditLogger` from this module and calls it ONCE
 * during app boot with the real implementation, e.g.:
 *
 *     import { setAuditLogger } from "./multi-region/auth/audit-binding";
 *     import { auditLog } from "./multi-region/services/audit-log";
 *     setAuditLogger(auditLog);
 *
 * Until that wiring runs, the no-op default below is used so every
 * `record(...)` call is safe. The no-op is also what the auth-folder
 * tests see — they assert on specific calls via `setAuditLogger(
 * jest.fn() )` rather than peering into a global module.
 */
import type { AuditLogger, AuditRecord } from "./audit-logger-types";
/**
 * Install a real audit logger. Idempotent — subsequent calls replace
 * the previously-bound logger so tests can swap in their own jest mock
 * between cases.
 */
export declare function setAuditLogger(logger: AuditLogger | null | undefined): void;
/**
 * Read the currently-bound logger. Auth modules call this lazily at
 * each record site rather than capturing at import time so a late
 * `setAuditLogger(...)` still takes effect for subsequent records.
 */
export declare function getAuditLogger(): AuditLogger;
/**
 * Convenience wrapper — `recordAuditEvent(entry)` is shorter at call
 * sites than `getAuditLogger().record(entry)` and reads like a
 * top-level function (which is how audit-log usage reads everywhere
 * else in the codebase).
 */
export declare function recordAuditEvent(entry: AuditRecord): void;
//# sourceMappingURL=audit-binding.d.ts.map