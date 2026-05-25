/**
 * `wireAuditLoggers(authSetter, agentsSetter)` should call both setters
 * with `AuditLogger` instances that delegate to the audit-log singleton.
 */
import {
  wireAuditLoggers,
  getAuditLoggerForAuth,
  getAuditLoggerForAgents,
} from "../audit-wiring";
import { auditLog } from "../audit-log";
import type { AuditLogger } from "../audit-log";

describe("audit-wiring", () => {
  beforeEach(() => {
    auditLog.clear();
  });

  it("wireAuditLoggers invokes both setters", () => {
    const authSetter = jest.fn();
    const agentsSetter = jest.fn();
    wireAuditLoggers(authSetter, agentsSetter);
    expect(authSetter).toHaveBeenCalledTimes(1);
    expect(agentsSetter).toHaveBeenCalledTimes(1);
    // Each call receives an object with .record
    const authArg = authSetter.mock.calls[0][0] as AuditLogger;
    const agentsArg = agentsSetter.mock.calls[0][0] as AuditLogger;
    expect(typeof authArg.record).toBe("function");
    expect(typeof agentsArg.record).toBe("function");
  });

  it("delegated record(...) routes to the singleton", () => {
    const logger = getAuditLoggerForAuth();
    logger.record({
      actor: "alice",
      action: "test",
      target: "x",
      status: "success",
    });
    const entries = auditLog.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe("alice");
    expect(entries[0].action).toBe("test");
  });

  it("auth and agents loggers both append to the same singleton", () => {
    getAuditLoggerForAuth().record({
      actor: "a",
      action: "login",
      target: "x",
      status: "success",
    });
    getAuditLoggerForAgents().record({
      actor: "agent",
      action: "delete_pool",
      target: "p1",
      status: "success",
    });
    expect(auditLog.getEntries()).toHaveLength(2);
  });
});
