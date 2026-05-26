/**
 * Bridge: hand the audit-log singleton to subsystems that accept an
 * `AuditLogger` via DI.
 *
 * Why this exists:
 *   - The auth pod (`auth/msal-auth.ts`) and the agents pod
 *     (`agents/...`) each accept an `AuditLogger` interface so unit
 *     tests can stub auditing without spinning up the full audit-log
 *     pub/sub.
 *   - At production startup, the pages pod (which owns dashboard-shell)
 *     needs ONE call that hands the singleton `auditLog` to both
 *     setters. Bridging that here keeps the singleton import out of
 *     both pods' source.
 *
 * Usage (from the pages pod, once at startup):
 *
 *   import { wireAuditLoggers } from "../services/audit-wiring";
 *   import { setAuthAuditLogger } from "../auth/msal-auth";
 *   import { setAgentsAuditLogger } from "../agents/orchestrator-agent";
 *
 *   wireAuditLoggers(setAuthAuditLogger, setAgentsAuditLogger);
 */
import { type AuditLogger } from "./audit-log";
/** Return the singleton wrapped as an `AuditLogger` for the auth pod. */
export declare function getAuditLoggerForAuth(): AuditLogger;
/** Return the singleton wrapped as an `AuditLogger` for the agents pod. */
export declare function getAuditLoggerForAgents(): AuditLogger;
/**
 * Call BOTH setters with the singleton-backed `AuditLogger` instances.
 * The setters are passed by reference so this bridging module doesn't
 * have to import from the auth / agents pods (which would create a
 * cycle through the audit module). The pages pod imports both setters
 * and forwards them here.
 */
export declare function wireAuditLoggers(authSetter: (logger: AuditLogger) => void, agentsSetter: (logger: AuditLogger) => void): void;
//# sourceMappingURL=audit-wiring.d.ts.map