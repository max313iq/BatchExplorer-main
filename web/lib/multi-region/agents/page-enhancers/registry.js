/**
 * Singleton registry of every page-enhancement agent the app ships.
 *
 *   - All trios are imported eagerly from `./trios.ts` so the /agents
 *     dashboard can list them without each page being mounted.
 *   - Workflow agents register themselves on page mount (via
 *     <PageEnhancerShell>) so global callers can look them up.
 *   - Per-agent enable flags are persisted in localStorage so the
 *     /agents dashboard toggles survive reloads.
 *
 * NOTE (audit fix #10): the previous `workflowRegistry.intercept(...)`
 * pipeline + `subscribeEnable` change-listener fan-out had no
 * production caller — only the (now-deleted) `trios.test.ts` used them.
 * Both have been removed. If we add a real interception path later it
 * should plug into the orchestrator dispatch in `orchestrator-agent.ts`
 * rather than reviving the registry-side hook.
 */
import { ALL_TRIOS, TRIO_BY_PAGE } from "./trios";
// ---------------------------------------------------------------------------
// Enable / disable flag (persisted)
// ---------------------------------------------------------------------------
const ENABLE_KEY_PREFIX = "azbm:agent-enabled:";
export function isEnhancerEnabled(agentId) {
    if (typeof localStorage === "undefined")
        return true;
    try {
        const raw = localStorage.getItem(`${ENABLE_KEY_PREFIX}${agentId}`);
        return raw === null ? true : raw === "1";
    }
    catch (_a) {
        return true;
    }
}
export function setEnhancerEnabled(agentId, enabled) {
    if (typeof localStorage === "undefined")
        return;
    try {
        localStorage.setItem(`${ENABLE_KEY_PREFIX}${agentId}`, enabled ? "1" : "0");
    }
    catch (_a) {
        /* ignore */
    }
}
// ---------------------------------------------------------------------------
// Workflow registry — the active page's WorkflowAgent
// ---------------------------------------------------------------------------
class WorkflowRegistry {
    constructor() {
        Object.defineProperty(this, "agents", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
    }
    set(pageKey, agent) {
        this.agents.set(pageKey, agent);
    }
    unset(pageKey, agentId) {
        const cur = this.agents.get(pageKey);
        if (cur && cur.id === agentId) {
            this.agents.delete(pageKey);
        }
    }
    get(pageKey) {
        var _a;
        return (_a = this.agents.get(pageKey)) !== null && _a !== void 0 ? _a : null;
    }
}
export const workflowRegistry = new WorkflowRegistry();
// ---------------------------------------------------------------------------
// Trio lookup
// ---------------------------------------------------------------------------
export function getTrioForPage(pageKey) {
    var _a;
    return (_a = TRIO_BY_PAGE[pageKey]) !== null && _a !== void 0 ? _a : null;
}
export function listAllTrios() {
    return ALL_TRIOS;
}
export function listAllAgents() {
    const out = [];
    for (const trio of ALL_TRIOS) {
        out.push(trio.ui, trio.tools, trio.workflow);
    }
    return out;
}
//# sourceMappingURL=registry.js.map