/**
 * Per-page agent trio contract — three runtime agents per page (UI / Tools /
 * Workflow). Authored as Opus 4.7 / 1M-context / max-effort agents (see
 * AgentProfile). The trio installs additively on top of the existing page
 * implementation via <PageEnhancerShell>; the original page UI is preserved.
 *
 * UIAgent       — renders a side-panel (graphs / health / usage)
 * ToolsAgent    — contributes context-aware actions to the page header
 * WorkflowAgent — wraps outgoing Azure requests (pick path, fill defaults,
 *                 batch, retry through the shared RequestScheduler)
 */
import * as React from "react";
import type { LucideIcon } from "lucide-react";

import type { MultiRegionStore } from "../../store/multi-region-store";
import type { OrchestratorAgent } from "../orchestrator-agent";
import type { PageKey } from "../../components/shared/sidebar-nav";

/**
 * Profile metadata each enhancement agent declares so the /agents dashboard
 * can show what model is driving it. Per the user spec, every agent in this
 * tree runs as Claude Opus 4.7 with the 1 M-token context window and
 * max-effort thinking budget.
 */
export interface AgentProfile {
  readonly model: "claude-opus-4-7";
  readonly contextWindowTokens: 1_000_000;
  readonly effort: "max";
}

/** Singleton — every page-enhancer references this object. */
export const OPUS_47_MAX_PROFILE: AgentProfile = Object.freeze({
  model: "claude-opus-4-7",
  contextWindowTokens: 1_000_000,
  effort: "max",
});

/** Lifecycle status surfaced on the /agents dashboard. */
export type EnhancerStatus = "idle" | "running" | "ok" | "error" | "disabled";

export interface PageEnhancerContext {
  pageKey: PageKey;
  store: MultiRegionStore;
  orchestrator: OrchestratorAgent;
  /** Stable signal aborted when the page unmounts. */
  signal: AbortSignal;
}

/** Identifier shared by all three agents in a trio. */
export interface BaseEnhancer {
  readonly id: string; // e.g. "user-creator/ui"
  readonly pageKey: PageKey;
  readonly profile: AgentProfile;
  readonly title: string; // human-readable label for /agents
  readonly description: string;
}

// ---------------------------------------------------------------------------
// UI agent
// ---------------------------------------------------------------------------

export interface UIAgent extends BaseEnhancer {
  readonly kind: "ui";
  /** Renders the side-panel content. Must be safe to render on every page tick. */
  render(ctx: PageEnhancerContext): React.ReactNode;
}

// ---------------------------------------------------------------------------
// Tools agent
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** Async action; errors surface as toasts via ctx.store.addNotification. */
  run: (ctx: PageEnhancerContext) => Promise<void> | void;
  variant?: "default" | "outline" | "destructive";
  /** Disabled tools still render — useful for showing a "future" feature. */
  disabled?: boolean;
  hint?: string;
}

export interface ToolsAgent extends BaseEnhancer {
  readonly kind: "tools";
  tools(ctx: PageEnhancerContext): ToolDescriptor[];
}

// ---------------------------------------------------------------------------
// Workflow agent
// ---------------------------------------------------------------------------

export interface WorkflowRequest {
  /** Logical name — e.g. "create-user", "reset-password", "list-pools". */
  name: string;
  /** Free-form payload the agent can introspect and rewrite. */
  payload: Record<string, unknown>;
}

export interface WorkflowAgent extends BaseEnhancer {
  readonly kind: "workflow";
  /**
   * Wrap an outgoing request. The default implementation should `return next()`
   * unchanged. Concrete agents may rewrite payload, batch, dedupe, or stamp
   * defaults before calling next().
   */
  intercept<T>(
    req: WorkflowRequest,
    next: () => Promise<T>,
    ctx: PageEnhancerContext,
  ): Promise<T>;

  /**
   * Suggest auto-fill defaults for a form payload. Pages may render the result
   * as a "Use suggestions" banner. Returning {} means no suggestions.
   */
  suggestDefaults?(
    formKey: string,
    current: Record<string, unknown>,
    ctx: PageEnhancerContext,
  ): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Trio
// ---------------------------------------------------------------------------

export interface PageEnhancerTrio {
  pageKey: PageKey;
  ui: UIAgent;
  tools: ToolsAgent;
  workflow: WorkflowAgent;
}

/**
 * Build helpers — most pages just need a small UI panel + a handful of tools
 * + a workflow that delegates to next(). These factories keep the per-page
 * files tiny and uniform.
 */
export function defineUIAgent(
  pageKey: PageKey,
  spec: Omit<UIAgent, "kind" | "pageKey" | "profile" | "id"> & { id?: string },
): UIAgent {
  return {
    kind: "ui",
    pageKey,
    profile: OPUS_47_MAX_PROFILE,
    id: spec.id ?? `${pageKey}/ui`,
    title: spec.title,
    description: spec.description,
    render: spec.render,
  };
}

export function defineToolsAgent(
  pageKey: PageKey,
  spec: Omit<ToolsAgent, "kind" | "pageKey" | "profile" | "id"> & { id?: string },
): ToolsAgent {
  return {
    kind: "tools",
    pageKey,
    profile: OPUS_47_MAX_PROFILE,
    id: spec.id ?? `${pageKey}/tools`,
    title: spec.title,
    description: spec.description,
    tools: spec.tools,
  };
}

export function defineWorkflowAgent(
  pageKey: PageKey,
  spec: Omit<WorkflowAgent, "kind" | "pageKey" | "profile" | "id"> & {
    id?: string;
  },
): WorkflowAgent {
  return {
    kind: "workflow",
    pageKey,
    profile: OPUS_47_MAX_PROFILE,
    id: spec.id ?? `${pageKey}/workflow`,
    title: spec.title,
    description: spec.description,
    intercept: spec.intercept,
    suggestDefaults: spec.suggestDefaults,
  };
}
