/**
 * Default no-op logger. Used when AgentContext does not provide an
 * `auditLogger` — keeps agent code free of `if (logger)` ladders.
 */
export const noopAuditLogger = {
    record(_entry) {
        /* intentionally empty */
    },
};
/**
 * Normalize the many quota-type spellings seen across the codebase
 * ("lowPriority", "low-priority", "LowPriority", "low_priority",
 * "spot", "dedicated", ...) into the canonical PascalCase form.
 *
 * Returns `null` for unrecognised input so callers can decide whether
 * to default or surface an error — silently mapping to a wrong type
 * caused the pool-agent.ts:232 vs agent-types.ts:110 mismatch.
 */
export function normalizeQuotaType(raw) {
    if (!raw)
        return null;
    const s = String(raw).toLowerCase().replace(/[\s_-]/g, "");
    if (s === "lowpriority" || s === "lp")
        return "LowPriority";
    if (s === "dedicated" || s === "ded")
        return "Dedicated";
    if (s === "spot")
        return "Spot";
    return null;
}
//# sourceMappingURL=agent-types.js.map