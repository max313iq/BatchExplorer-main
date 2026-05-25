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
import type { PageEnhancerTrio, WorkflowAgent, BaseEnhancer } from "./types";
import type { PageKey } from "../../components/shared/sidebar-nav";

// ---------------------------------------------------------------------------
// Enable / disable flag (persisted)
// ---------------------------------------------------------------------------

const ENABLE_KEY_PREFIX = "azbm:agent-enabled:";

export function isEnhancerEnabled(agentId: string): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const raw = localStorage.getItem(`${ENABLE_KEY_PREFIX}${agentId}`);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

export function setEnhancerEnabled(agentId: string, enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      `${ENABLE_KEY_PREFIX}${agentId}`,
      enabled ? "1" : "0",
    );
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Workflow registry — the active page's WorkflowAgent
// ---------------------------------------------------------------------------

class WorkflowRegistry {
  private agents = new Map<PageKey, WorkflowAgent>();

  set(pageKey: PageKey, agent: WorkflowAgent): void {
    this.agents.set(pageKey, agent);
  }

  unset(pageKey: PageKey, agentId: string): void {
    const cur = this.agents.get(pageKey);
    if (cur && cur.id === agentId) {
      this.agents.delete(pageKey);
    }
  }

  get(pageKey: PageKey): WorkflowAgent | null {
    return this.agents.get(pageKey) ?? null;
  }
}

export const workflowRegistry = new WorkflowRegistry();

// ---------------------------------------------------------------------------
// Trio lookup
// ---------------------------------------------------------------------------

export function getTrioForPage(pageKey: PageKey): PageEnhancerTrio | null {
  return TRIO_BY_PAGE[pageKey] ?? null;
}

export function listAllTrios(): readonly PageEnhancerTrio[] {
  return ALL_TRIOS;
}

export function listAllAgents(): readonly BaseEnhancer[] {
  const out: BaseEnhancer[] = [];
  for (const trio of ALL_TRIOS) {
    out.push(trio.ui, trio.tools, trio.workflow);
  }
  return out;
}
