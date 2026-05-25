/**
 * Minimal AuditLogger interface used by the auth subsystem.
 *
 * The real implementation lives outside the auth boundary (in
 * `services/audit-log`). To keep this folder dependency-free of the
 * services/store layer, auth modules accept the logger via
 * dependency injection — see `audit-binding.ts` for the binding
 * helper. Other agents (the services-layer pod) wire the real
 * `auditLog` instance into `setAuditLogger(...)` at app boot.
 *
 * Until that wiring happens, the no-op default from `audit-binding.ts`
 * is used so calls never throw.
 */

/** Outcome of an audited action. */
export type AuditStatus = "success" | "failure";

/** Structured record passed to `AuditLogger.record`. */
export interface AuditRecord {
  /** Acting principal (UPN, homeAccountId, or "system"). */
  actor: string;
  /** Short verb identifying the action — e.g. "login_account". */
  action: string;
  /** Object of the action — tenant id, vault id, etc. */
  target?: string;
  /** Whether the action succeeded or failed. */
  status: AuditStatus;
  /** Free-text error description on failure. */
  error?: string;
  /** Action-specific structured detail (NEVER passwords or token bodies). */
  details?: Record<string, unknown>;
}

/**
 * The single method every auth-module call site relies on. Real
 * implementations may also expose `list()` / `export()` but those are
 * out of scope here.
 */
export interface AuditLogger {
  record(entry: AuditRecord): void;
}
