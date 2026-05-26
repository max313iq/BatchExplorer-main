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
export {};
//# sourceMappingURL=audit-logger-types.js.map